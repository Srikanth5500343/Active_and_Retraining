package com.racktrack.app;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.ImageFormat;
import android.graphics.Rect;
import android.graphics.YuvImage;
import android.graphics.drawable.GradientDrawable;
import android.hardware.display.DisplayManager;
import android.media.Image;
import android.opengl.GLES20;
import android.opengl.GLSurfaceView;
import android.os.Bundle;
import android.util.Base64;
import android.util.Log;
import android.view.Display;
import android.view.Gravity;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;

import com.google.ar.core.ArCoreApk;
import com.google.ar.core.CameraConfig;
import com.google.ar.core.CameraConfigFilter;
import com.google.ar.core.Config;
import com.google.ar.core.Coordinates2d;
import com.google.ar.core.Frame;
import com.google.ar.core.Session;
import com.google.ar.core.TrackingState;
import com.google.ar.core.exceptions.CameraNotAvailableException;
import com.google.ar.core.exceptions.UnavailableApkTooOldException;
import com.google.ar.core.exceptions.UnavailableArcoreNotInstalledException;
import com.google.ar.core.exceptions.UnavailableDeviceNotCompatibleException;
import com.google.ar.core.exceptions.UnavailableSdkTooOldException;
import com.google.ar.core.exceptions.UnavailableUserDeclinedInstallationException;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.FloatBuffer;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;

import javax.microedition.khronos.egl.EGLConfig;
import javax.microedition.khronos.opengles.GL10;

/**
 * Fullscreen ARCore activity. Renders the live camera as a GL backdrop,
 * captures throttled JPEG frames back to JS via {@link RackARPlugin}, and
 * floats 2D label TextViews over each device returned by setOverlay.
 *
 * Label semantics: when JS calls setOverlay(devices), each device's bbox is
 * in the captured frame's image-pixel space. We re-project those pixels
 * through the LATEST Frame's transformCoordinates2d → view space on every
 * GL frame, so labels track image content even as the device rotates or
 * the AR display geometry changes. They are NOT world-anchored — if the
 * user pans the camera away, the labels move out with the rack until the
 * next /api/analyze response refreshes positions.
 */
public class RackARActivity extends Activity implements GLSurfaceView.Renderer {
    private static final String TAG = "RackAR";

    static RackARActivity current;

    private GLSurfaceView surfaceView;
    private FrameLayout labelOverlay;
    private TextView statusLabel;

    private Session session;
    private final BackgroundRenderer backgroundRenderer = new BackgroundRenderer();
    private boolean installRequested = false;

    private double frameRateHz = 1.0;
    private long lastEmitNs = 0;
    private final AtomicBoolean encoding = new AtomicBoolean(false);

    private final List<DeviceLabel> devices = new ArrayList<>();
    // Per-device overlay = a FrameLayout bbox rectangle (colored border) with
    // a TextView chip on top — matches the look of the static "detect" results.
    private final Map<String, FrameLayout> labelViews = new HashMap<>();

    private int viewWidth = 0;
    private int viewHeight = 0;
    private int displayRotation = 0;
    private DisplayManager.DisplayListener displayListener;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setFlags(
            WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON,
            WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        frameRateHz = Math.max(0.1, getIntent().getDoubleExtra("frameRateHz", 1.0));
        current = this;

        FrameLayout root = new FrameLayout(this);

        surfaceView = new GLSurfaceView(this);
        surfaceView.setPreserveEGLContextOnPause(true);
        surfaceView.setEGLContextClientVersion(2);
        surfaceView.setEGLConfigChooser(8, 8, 8, 8, 16, 0);
        surfaceView.setRenderer(this);
        surfaceView.setRenderMode(GLSurfaceView.RENDERMODE_CONTINUOUSLY);
        root.addView(surfaceView, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        labelOverlay = new FrameLayout(this);
        // Per-device boxes negative-margin their label chips above the box's top
        // edge. FrameLayout clips children by default — disable that here AND on
        // the per-device container so the chips are actually visible.
        labelOverlay.setClipChildren(false);
        labelOverlay.setClipToPadding(false);
        root.addView(labelOverlay, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        statusLabel = new TextView(this);
        statusLabel.setText("Starting AR…");
        statusLabel.setTextColor(0xFFFFFFFF);
        statusLabel.setBackgroundColor(0xAA000000);
        statusLabel.setPadding(24, 16, 24, 16);
        FrameLayout.LayoutParams sLp = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        sLp.gravity = Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL;
        sLp.bottomMargin = 80;
        root.addView(statusLabel, sLp);

        setContentView(root);

        Display d = ((WindowManager) getSystemService(WINDOW_SERVICE)).getDefaultDisplay();
        displayRotation = d.getRotation();
        displayListener = new DisplayManager.DisplayListener() {
            @Override public void onDisplayAdded(int displayId) { }
            @Override public void onDisplayRemoved(int displayId) { }
            @Override public void onDisplayChanged(int displayId) {
                Display d2 = ((WindowManager) getSystemService(WINDOW_SERVICE)).getDefaultDisplay();
                displayRotation = d2.getRotation();
                if (session != null && viewWidth > 0 && viewHeight > 0) {
                    session.setDisplayGeometry(displayRotation, viewWidth, viewHeight);
                }
            }
        };
        ((DisplayManager) getSystemService(DISPLAY_SERVICE))
            .registerDisplayListener(displayListener, null);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (session == null) {
            try {
                switch (ArCoreApk.getInstance().requestInstall(this, !installRequested)) {
                    case INSTALL_REQUESTED:
                        installRequested = true;
                        return;
                    case INSTALLED:
                        break;
                }
                session = new Session(this);
                // Some OEM camera2 drivers reject ARCore's default high-res YUV
                // config and surface as INTERNAL at android_data_source.cc:1073.
                // Pick the smallest supported CPU image size + 30fps + no depth
                // for maximum compatibility on Samsung A-series and similar.
                try {
                    CameraConfigFilter filter = new CameraConfigFilter(session)
                        .setTargetFps(EnumSet.of(CameraConfig.TargetFps.TARGET_FPS_30))
                        .setDepthSensorUsage(EnumSet.of(CameraConfig.DepthSensorUsage.DO_NOT_USE));
                    List<CameraConfig> configs = session.getSupportedCameraConfigs(filter);
                    Log.i(TAG, "supportedCameraConfigs n=" + configs.size());
                    // Prefer 1920x1080 CPU frames for the best detector accuracy
                    // (smaller images give the model fewer pixels per device, so
                    // it produces looser bboxes). At 1Hz the bandwidth over USB
                    // is fine. Fall back to closest available size.
                    CameraConfig chosen = null;
                    int bestScore = Integer.MAX_VALUE;
                    for (CameraConfig c : configs) {
                        int w = c.getImageSize().getWidth();
                        int h = c.getImageSize().getHeight();
                        Log.i(TAG, "  cfg cpu=" + w + "x" + h + " gpu=" +
                            c.getTextureSize().getWidth() + "x" + c.getTextureSize().getHeight() +
                            " fps=" + c.getFpsRange() +
                            " depth=" + c.getDepthSensorUsage() +
                            " facing=" + c.getFacingDirection());
                        if (c.getFacingDirection() != CameraConfig.FacingDirection.BACK) continue;
                        int score = Math.abs(w - 1920) + Math.abs(h - 1080);
                        if (score < bestScore) { bestScore = score; chosen = c; }
                    }
                    if (chosen != null) {
                        Log.i(TAG, "selecting cameraConfig cpu=" +
                            chosen.getImageSize().getWidth() + "x" + chosen.getImageSize().getHeight());
                        session.setCameraConfig(chosen);
                    }
                } catch (Throwable t) {
                    Log.w(TAG, "camera config selection failed (continuing with default)", t);
                }
                Config config = new Config(session);
                config.setFocusMode(Config.FocusMode.AUTO);
                session.configure(config);
            } catch (UnavailableArcoreNotInstalledException
                     | UnavailableUserDeclinedInstallationException e) {
                fail("Please install Google Play Services for AR");
                return;
            } catch (UnavailableApkTooOldException e) {
                fail("Please update Google Play Services for AR");
                return;
            } catch (UnavailableSdkTooOldException e) {
                fail("AR not supported (SDK too old)");
                return;
            } catch (UnavailableDeviceNotCompatibleException e) {
                fail("This device is not AR-capable");
                return;
            } catch (Exception e) {
                Log.e(TAG, "Session init failed", e);
                fail("AR session failed to start");
                return;
            }
        }
        try {
            session.resume();
        } catch (CameraNotAvailableException e) {
            fail("Camera not available — close other apps and try again");
            session = null;
            return;
        } catch (Throwable t) {
            Log.e(TAG, "session.resume failed", t);
            try { session.close(); } catch (Throwable ignored) { }
            session = null;
            fail("AR is not supported on this device's camera");
            return;
        }
        surfaceView.onResume();
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (session != null) {
            surfaceView.onPause();
            session.pause();
        }
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (displayListener != null) {
            ((DisplayManager) getSystemService(DISPLAY_SERVICE))
                .unregisterDisplayListener(displayListener);
        }
        if (session != null) {
            session.close();
            session = null;
        }
        if (current == this) current = null;
        if (RackARPlugin.instance != null) {
            RackARPlugin.instance.emitEnded("dismissed");
        }
    }

    private void fail(String msg) {
        Log.w(TAG, msg);
        // Show toast first; finish() on the next main-loop tick so the toast
        // actually surfaces. Calling finish() inline races the runOnUiThread
        // dispatch and the toast never shows.
        runOnUiThread(() -> {
            Toast.makeText(getApplicationContext(), msg, Toast.LENGTH_LONG).show();
            finish();
        });
    }

    @Override
    public void onSurfaceCreated(GL10 gl, EGLConfig config) {
        GLES20.glClearColor(0f, 0f, 0f, 1f);
        backgroundRenderer.createOnGlThread();
    }

    @Override
    public void onSurfaceChanged(GL10 gl, int width, int height) {
        GLES20.glViewport(0, 0, width, height);
        viewWidth = width;
        viewHeight = height;
        if (session != null) {
            session.setDisplayGeometry(displayRotation, width, height);
        }
    }

    @Override
    public void onDrawFrame(GL10 gl) {
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT | GLES20.GL_DEPTH_BUFFER_BIT);
        if (session == null) return;
        session.setCameraTextureName(backgroundRenderer.getTextureId());
        Frame frame;
        try {
            frame = session.update();
        } catch (Throwable t) {
            Log.w(TAG, "session.update failed: " + t);
            return;
        }
        backgroundRenderer.draw(frame);

        long nowNs = System.nanoTime();
        long minIntervalNs = (long) (1_000_000_000.0 / frameRateHz);
        if (nowNs - lastEmitNs >= minIntervalNs && !encoding.get()) {
            lastEmitNs = nowNs;
            captureAndEmit(frame);
        }

        if (frame.getCamera().getTrackingState() == TrackingState.TRACKING && !devices.isEmpty()) {
            reprojectLabels(frame);
        }
    }

    private void captureAndEmit(Frame frame) {
        if (!encoding.compareAndSet(false, true)) return;
        Image img;
        try {
            img = frame.acquireCameraImage();
        } catch (Throwable t) {
            encoding.set(false);
            return;
        }
        final int w = img.getWidth();
        final int h = img.getHeight();
        final byte[] nv21;
        try {
            nv21 = yuv420ToNv21(img);
        } catch (Throwable t) {
            Log.w(TAG, "yuv->nv21 failed: " + t);
            img.close();
            encoding.set(false);
            return;
        }
        img.close();

        new Thread(() -> {
            try {
                YuvImage yuv = new YuvImage(nv21, ImageFormat.NV21, w, h, null);
                ByteArrayOutputStream baos = new ByteArrayOutputStream(w * h / 4);
                yuv.compressToJpeg(new Rect(0, 0, w, h), 90, baos);
                String b64 = Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP);
                if (RackARPlugin.instance != null) {
                    RackARPlugin.instance.emitFrame(b64, w, h, System.currentTimeMillis());
                }
            } catch (Throwable t) {
                Log.w(TAG, "frame encode failed: " + t);
            } finally {
                encoding.set(false);
            }
        }, "rackar-encode").start();
    }

    private static byte[] yuv420ToNv21(Image image) {
        int width = image.getWidth();
        int height = image.getHeight();
        int ySize = width * height;
        byte[] nv21 = new byte[ySize + ySize / 2];

        Image.Plane yPlane = image.getPlanes()[0];
        Image.Plane uPlane = image.getPlanes()[1];
        Image.Plane vPlane = image.getPlanes()[2];

        ByteBuffer yBuf = yPlane.getBuffer();
        ByteBuffer uBuf = uPlane.getBuffer();
        ByteBuffer vBuf = vPlane.getBuffer();

        int yRowStride = yPlane.getRowStride();
        int yPixelStride = yPlane.getPixelStride();
        int outIdx = 0;
        byte[] rowBuf = new byte[Math.max(yRowStride, Math.max(uPlane.getRowStride(), vPlane.getRowStride()))];

        for (int row = 0; row < height; row++) {
            yBuf.position(row * yRowStride);
            int n = Math.min(yRowStride, yBuf.remaining());
            yBuf.get(rowBuf, 0, n);
            if (yPixelStride == 1) {
                System.arraycopy(rowBuf, 0, nv21, outIdx, width);
                outIdx += width;
            } else {
                for (int col = 0; col < width; col++) nv21[outIdx++] = rowBuf[col * yPixelStride];
            }
        }

        int uvHeight = height / 2;
        int uvWidth = width / 2;
        int uRowStride = uPlane.getRowStride();
        int uPixelStride = uPlane.getPixelStride();
        int vRowStride = vPlane.getRowStride();
        int vPixelStride = vPlane.getPixelStride();
        byte[] rowU = new byte[uRowStride];
        byte[] rowV = new byte[vRowStride];

        for (int row = 0; row < uvHeight; row++) {
            uBuf.position(row * uRowStride);
            int nu = Math.min(uRowStride, uBuf.remaining());
            uBuf.get(rowU, 0, nu);
            vBuf.position(row * vRowStride);
            int nv = Math.min(vRowStride, vBuf.remaining());
            vBuf.get(rowV, 0, nv);
            for (int col = 0; col < uvWidth; col++) {
                nv21[outIdx++] = rowV[col * vPixelStride];
                nv21[outIdx++] = rowU[col * uPixelStride];
            }
        }
        return nv21;
    }

    /** Called from RackARPlugin (JS thread). */
    public void setOverlay(String devicesJsonString) {
        final List<DeviceLabel> next = new ArrayList<>();
        try {
            JSONArray arr = new JSONArray(devicesJsonString);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.getJSONObject(i);
                JSONArray bb = o.optJSONArray("bbox");
                if (bb == null || bb.length() < 4) continue;
                DeviceLabel d = new DeviceLabel();
                d.id = o.optString("id", "dev-" + i);
                d.label = o.optString("label", "Device");
                d.sublabel = o.isNull("sublabel") ? null : o.optString("sublabel", null);
                d.color = o.optString("color", "#22d3ee");
                d.x = (float) bb.getDouble(0);
                d.y = (float) bb.getDouble(1);
                d.w = (float) bb.getDouble(2);
                d.h = (float) bb.getDouble(3);
                next.add(d);
            }
        } catch (Exception e) {
            Log.e(TAG, "setOverlay parse failed", e);
            return;
        }

        runOnUiThread(() -> {
            devices.clear();
            devices.addAll(next);
            Set<String> keep = new HashSet<>();
            for (DeviceLabel d : next) keep.add(d.id);
            List<String> toRemove = new ArrayList<>();
            for (String id : labelViews.keySet()) if (!keep.contains(id)) toRemove.add(id);
            for (String id : toRemove) {
                FrameLayout view = labelViews.remove(id);
                if (view != null) labelOverlay.removeView(view);
            }
            statusLabel.setText(next.isEmpty()
                ? "No devices detected — point at rack"
                : next.size() + " device" + (next.size() == 1 ? "" : "s") + " detected");
        });
    }

    private void reprojectLabels(Frame frame) {
        if (viewWidth == 0 || viewHeight == 0) return;
        final List<LabelPos> positions = new ArrayList<>(devices.size());
        for (DeviceLabel d : devices) {
            try {
                FloatBuffer src = FloatBuffer.wrap(new float[]{
                    d.x, d.y, d.x + d.w, d.y + d.h
                });
                FloatBuffer dst = FloatBuffer.wrap(new float[4]);
                frame.transformCoordinates2d(
                    Coordinates2d.IMAGE_PIXELS, src,
                    Coordinates2d.VIEW, dst);
                float[] o = dst.array();
                float vx = Math.min(o[0], o[2]);
                float vy = Math.min(o[1], o[3]);
                float vw = Math.abs(o[2] - o[0]);
                float vh = Math.abs(o[3] - o[1]);
                positions.add(new LabelPos(d, vx, vy, vw, vh));
            } catch (Throwable ignored) { }
        }
        runOnUiThread(() -> {
            for (LabelPos p : positions) updateLabelView(p);
        });
    }

    private void updateLabelView(LabelPos p) {
        FrameLayout container = labelViews.get(p.d.id);
        boolean isNew = container == null;
        TextView chip;
        if (isNew) {
            container = new FrameLayout(this);
            // Allow the chip to render above the container's top edge.
            container.setClipChildren(false);
            container.setClipToPadding(false);
            final String tappedId = p.d.id;
            container.setOnClickListener(v -> {
                if (RackARPlugin.instance != null) RackARPlugin.instance.emitTap(tappedId);
            });

            chip = new TextView(this);
            chip.setPadding(16, 8, 16, 8);
            chip.setTextColor(0xFFFFFFFF);
            chip.setTextSize(13);
            chip.setTypeface(null, android.graphics.Typeface.BOLD);
            chip.setIncludeFontPadding(false);
            FrameLayout.LayoutParams chipLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            chipLp.gravity = Gravity.TOP | Gravity.START;
            // Pull the chip up so its bottom edge sits on the top edge of the box.
            chipLp.topMargin = -64;
            chipLp.leftMargin = -2;
            container.addView(chip, chipLp);
            container.setTag(chip);

            labelOverlay.addView(container);
            labelViews.put(p.d.id, container);
        } else {
            chip = (TextView) container.getTag();
        }

        int color;
        try {
            color = Color.parseColor(p.d.color);
        } catch (Throwable e) {
            color = 0xFF22d3ee;
        }

        // Bounding-box rectangle: transparent fill + colored stroke.
        GradientDrawable boxBg = new GradientDrawable();
        boxBg.setShape(GradientDrawable.RECTANGLE);
        boxBg.setColor(0x00000000);
        boxBg.setStroke(4, color);
        boxBg.setCornerRadius(6f);
        container.setBackground(boxBg);

        // Label chip: solid color pill at the top-left corner.
        GradientDrawable chipBg = new GradientDrawable();
        chipBg.setShape(GradientDrawable.RECTANGLE);
        chipBg.setColor((color & 0x00FFFFFF) | 0xE6000000);
        chipBg.setCornerRadii(new float[]{ 6f, 6f, 6f, 6f, 0f, 0f, 0f, 0f });
        chip.setBackground(chipBg);

        String text = p.d.label;
        if (p.d.sublabel != null && !p.d.sublabel.isEmpty()) text = text + " · " + p.d.sublabel;
        chip.setText(text);

        // Size and position the bounding-box container to match the projected bbox.
        FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) container.getLayoutParams();
        if (lp == null) {
            lp = new FrameLayout.LayoutParams(0, 0);
        }
        lp.width  = (int) Math.max(2, p.w);
        lp.height = (int) Math.max(2, p.h);
        lp.gravity = Gravity.TOP | Gravity.START;
        lp.leftMargin = (int) Math.max(0, p.x);
        lp.topMargin  = (int) Math.max(0, p.y);
        container.setLayoutParams(lp);
    }

    private static class DeviceLabel {
        String id, label, sublabel, color;
        float x, y, w, h;
    }

    private static class LabelPos {
        final DeviceLabel d;
        final float x, y, w, h;
        LabelPos(DeviceLabel d, float x, float y, float w, float h) {
            this.d = d; this.x = x; this.y = y; this.w = w; this.h = h;
        }
    }
}

package com.racktrack.app;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import com.google.ar.core.ArCoreApk;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * Capacitor plugin glue for the RackAR Android implementation.
 *
 * Mirrors the iOS plugin: isSupported / requestPermissions / start /
 * setOverlay / stop. The fullscreen AR view runs in {@link RackARActivity}
 * (separate Activity rather than embedded view, so the AR session has a
 * clean lifecycle and the WebView can keep running underneath).
 *
 * Inter-process events (frame / tap / ended) come back to this plugin via
 * a static singleton hook because Activities can't directly reach plugins.
 */
@CapacitorPlugin(
    name = "RackAR",
    permissions = {
        @Permission(strings = {Manifest.permission.CAMERA}, alias = "camera"),
    }
)
public class RackARPlugin extends Plugin {

    /** Set when start() is called so the Activity can find us. */
    static RackARPlugin instance;

    @Override
    public void load() {
        instance = this;
    }

    @PluginMethod
    public void isSupported(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("ar", isArCoreAvailable());
        ret.put("camera", cameraStateString());
        ret.put("platform", "android");
        call.resolve(ret);
    }

    @PluginMethod
    public void requestPermissions(PluginCall call) {
        if (cameraStateString().equals("granted")) {
            isSupported(call);
            return;
        }
        // Capacitor's permission flow
        requestPermissionForAlias("camera", call, "cameraPermsCallback");
    }

    @PermissionCallback
    private void cameraPermsCallback(PluginCall call) {
        isSupported(call);
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (!isArCoreAvailable()) {
            call.reject("AR not supported on this device (ARCore unavailable)");
            return;
        }
        if (!cameraStateString().equals("granted")) {
            call.reject("Camera permission required — call requestPermissions() first");
            return;
        }

        double frameRateHz = call.getDouble("frameRateHz", 1.0);
        // Launch from the hosting Activity so RackARActivity stays in the same
        // task as MainActivity. With FLAG_ACTIVITY_NEW_TASK + an app context,
        // finishing RackARActivity (e.g. when ARCore isn't installed) drops
        // the user to the home screen instead of back to the WebView.
        Intent i = new Intent(getActivity(), RackARActivity.class);
        i.putExtra("frameRateHz", frameRateHz);
        getActivity().startActivity(i);
        call.resolve();
    }

    @PluginMethod
    public void setOverlay(PluginCall call) {
        RackARActivity activity = RackARActivity.current;
        if (activity == null) {
            call.reject("AR not active — call start() first");
            return;
        }
        try {
            JSArray devicesArr = call.getArray("devices");
            activity.setOverlay(devicesArr != null ? devicesArr.toString() : "[]");
            call.resolve();
        } catch (Exception e) {
            call.reject("setOverlay failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        RackARActivity activity = RackARActivity.current;
        if (activity != null) {
            activity.finish();
        }
        call.resolve();
    }

    // ── Hooks called from RackARActivity ─────────────────────────────
    void emitFrame(String jpegBase64, int width, int height, double tsMs) {
        JSObject e = new JSObject();
        e.put("jpegBase64", jpegBase64);
        e.put("width", width);
        e.put("height", height);
        e.put("ts", tsMs);
        notifyListeners("frame", e);
    }

    void emitTap(String id) {
        JSObject e = new JSObject();
        e.put("id", id);
        notifyListeners("tap", e);
    }

    void emitEnded(String reason) {
        JSObject e = new JSObject();
        e.put("reason", reason);
        notifyListeners("ended", e);
    }

    // ── Helpers ──────────────────────────────────────────────────────
    private boolean isArCoreAvailable() {
        try {
            ArCoreApk.Availability avail =
                ArCoreApk.getInstance().checkAvailability(getContext());
            return avail.isSupported();
        } catch (Throwable t) {
            return false;
        }
    }

    private String cameraStateString() {
        int state = ContextCompat.checkSelfPermission(getContext(), Manifest.permission.CAMERA);
        return state == PackageManager.PERMISSION_GRANTED ? "granted" : "prompt";
    }
}

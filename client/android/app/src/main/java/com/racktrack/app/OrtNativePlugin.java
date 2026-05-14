package com.racktrack.app;

import android.content.res.AssetManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.Base64;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONException;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.FloatBuffer;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtSession;
import ai.onnxruntime.OrtSession.SessionOptions;

/**
 * Capacitor plugin that runs ONNX models through native onnxruntime-android,
 * with NNAPI acceleration when the device supports it.
 *
 * Wire-compatible (at the conceptual level) with the WASM ort.InferenceSession
 * the BenchmarkPage uses today: load a model from app assets, run inference
 * on an image, get the output tensor back.
 *
 * Methods:
 *   loadSession({ modelPath, useNnapi? }) -> { sessionId, inputName, outputName }
 *   runFromDataUrl({ sessionId, dataUrl, inputSize }) -> { output, dims, inferMs }
 *   releaseSession({ sessionId }) -> { released: true }
 */
@CapacitorPlugin(name = "OrtNative")
public class OrtNativePlugin extends Plugin {

    private static final String TAG = "OrtNative";

    private OrtEnvironment env;
    private final Map<String, OrtSession> sessions = new HashMap<>();

    @Override
    public void load() {
        env = OrtEnvironment.getEnvironment();
    }

    @PluginMethod
    public void loadSession(PluginCall call) {
        String modelPath = call.getString("modelPath");
        boolean useNnapi = call.getBoolean("useNnapi", true);
        if (modelPath == null) { call.reject("modelPath required"); return; }

        try {
            // Asset path inside the APK. Capacitor copies client/public/* into
            // android/app/src/main/assets/public/* on `npx cap sync`, so a
            // BenchmarkPage path like "/models/unit_int8.onnx" maps to the
            // asset "public/models/unit_int8.onnx".
            String assetPath = "public" + (modelPath.startsWith("/") ? modelPath : "/" + modelPath);
            AssetManager am = getContext().getAssets();
            byte[] modelBytes;
            try (InputStream in = am.open(assetPath)) {
                ByteArrayOutputStream buf = new ByteArrayOutputStream();
                byte[] chunk = new byte[8192];
                int n;
                while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
                modelBytes = buf.toByteArray();
            }

            SessionOptions opts = new SessionOptions();
            // NO_OPT — both ALL_OPT and BASIC_OPT hung for minutes on the
            // quantized YOLO graphs on Snapdragon 778G. Last-ditch attempt:
            // skip optimization entirely and let ORT just run the graph
            // as exported. Inference may be slower but should at least load.
            opts.setOptimizationLevel(SessionOptions.OptLevel.NO_OPT);
            if (useNnapi) {
                try {
                    opts.addNnapi();
                } catch (Throwable t) {
                    // NNAPI add can fail on emulators or weird OEM ROMs.
                    // Falls back to CPU silently — the run still succeeds.
                }
            }

            Log.i(TAG, "loadSession start: " + modelPath + " (" + modelBytes.length + " bytes, nnapi=" + useNnapi + ")");
            long t0 = System.nanoTime();
            OrtSession session = env.createSession(modelBytes, opts);
            long loadMs = (System.nanoTime() - t0) / 1_000_000L;
            Log.i(TAG, "loadSession done: " + modelPath + " in " + loadMs + " ms");

            String sessionId = UUID.randomUUID().toString();
            sessions.put(sessionId, session);

            String inputName = session.getInputNames().iterator().next();
            String outputName = session.getOutputNames().iterator().next();

            JSObject ret = new JSObject();
            ret.put("sessionId", sessionId);
            ret.put("inputName", inputName);
            ret.put("outputName", outputName);
            ret.put("loadMs", loadMs);
            ret.put("backend", useNnapi ? "nnapi" : "cpu");
            call.resolve(ret);
        } catch (Throwable t) {
            call.reject("loadSession failed: " + t.getMessage());
        }
    }

    @PluginMethod
    public void runFromDataUrl(PluginCall call) {
        String sessionId = call.getString("sessionId");
        String dataUrl = call.getString("dataUrl");
        Integer inputSize = call.getInt("inputSize");
        if (sessionId == null || dataUrl == null || inputSize == null) {
            call.reject("sessionId, dataUrl, inputSize required");
            return;
        }
        OrtSession session = sessions.get(sessionId);
        if (session == null) { call.reject("unknown sessionId"); return; }

        try {
            // 1) Decode data URL -> Bitmap.
            int comma = dataUrl.indexOf(',');
            String b64 = comma >= 0 ? dataUrl.substring(comma + 1) : dataUrl;
            byte[] imgBytes = Base64.decode(b64, Base64.DEFAULT);
            Bitmap raw = BitmapFactory.decodeByteArray(imgBytes, 0, imgBytes.length);
            if (raw == null) { call.reject("failed to decode dataUrl"); return; }

            // 2) Resize to model input.
            int size = inputSize;
            Bitmap resized = Bitmap.createScaledBitmap(raw, size, size, true);
            if (resized != raw) raw.recycle();

            // 3) Bitmap -> CHW float32 [1, 3, H, W], normalized 0-1.
            int n = size * size;
            int[] pixels = new int[n];
            resized.getPixels(pixels, 0, size, 0, 0, size, size);
            resized.recycle();
            FloatBuffer fb = FloatBuffer.allocate(3 * n);
            float[] arr = fb.array();
            for (int i = 0; i < n; i++) {
                int p = pixels[i];
                arr[i]         = ((p >> 16) & 0xFF) / 255f;   // R
                arr[i + n]     = ((p >> 8)  & 0xFF) / 255f;   // G
                arr[i + 2 * n] = (p         & 0xFF) / 255f;   // B
            }

            String inputName = session.getInputNames().iterator().next();
            String outputName = session.getOutputNames().iterator().next();

            // 4) Run.
            Log.i(TAG, "run start: session " + sessionId.substring(0, 8) + " input " + size + "x" + size);
            long t0 = System.nanoTime();
            try (OnnxTensor inputTensor =
                     OnnxTensor.createTensor(env, fb, new long[]{1, 3, size, size});
                 OrtSession.Result result =
                     session.run(java.util.Collections.singletonMap(inputName, inputTensor))) {

                long inferMs = (System.nanoTime() - t0) / 1_000_000L;
                Log.i(TAG, "run done: " + inferMs + " ms");

                ai.onnxruntime.OnnxValue val = result.get(0);
                float[][][] out3;
                long[] dimsArr;
                if (val instanceof OnnxTensor) {
                    OnnxTensor outT = (OnnxTensor) val;
                    dimsArr = outT.getInfo().getShape();
                    Object javaObj = outT.getValue();
                    // For our YOLO heads this is float[1][C][N]; for the
                    // EfficientNet classifier it's float[1][K]. Flatten either
                    // shape to a 1-D array for the JS bridge.
                    JSObject ret = new JSObject();
                    JSArray flat = new JSArray();
                    flattenInto(javaObj, flat);
                    JSArray dimsJs = new JSArray();
                    for (long d : dimsArr) dimsJs.put(d);
                    ret.put("output", flat);
                    ret.put("dims", dimsJs);
                    ret.put("inferMs", inferMs);
                    ret.put("outputName", outputName);
                    call.resolve(ret);
                } else {
                    call.reject("unexpected output type");
                }
            }
        } catch (Throwable t) {
            call.reject("runFromDataUrl failed: " + t.getMessage());
        }
    }

    @PluginMethod
    public void releaseSession(PluginCall call) {
        String sessionId = call.getString("sessionId");
        if (sessionId == null) { call.reject("sessionId required"); return; }
        OrtSession s = sessions.remove(sessionId);
        if (s != null) {
            try { s.close(); } catch (Throwable ignore) {}
        }
        JSObject ret = new JSObject();
        ret.put("released", true);
        call.resolve(ret);
    }

    // Recursively flatten nested float[] arrays into a JSArray. Handles the
    // 2-D classifier output and 3-D YOLO output without special-casing each.
    private static void flattenInto(Object o, JSArray out) throws JSONException {
        if (o instanceof float[]) {
            for (float f : (float[]) o) out.put((double) f);
        } else if (o instanceof Object[]) {
            for (Object child : (Object[]) o) flattenInto(child, out);
        } else {
            throw new IllegalArgumentException("unexpected tensor element: " + o);
        }
    }
}

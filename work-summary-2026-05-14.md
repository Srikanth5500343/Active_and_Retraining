# Work Summary — 2026-05-14

Today's goal: take yesterday's WASM on-device proof-of-concept (working, but 6.4 s/inference — too slow to ship) and get the native runtime path working with real detections.

**Status:** Native ORT runtime confirmed 40–60× faster than WASM. But every ORT INT8 quantization config we've tried either hangs the loader or produces all-zero outputs. FP16 is the next attempt before pivoting to TFLite.

## 1. Native ORT plugin — built, integrated, working at runtime level

Added `OrtNativePlugin.java` (Capacitor plugin), `OrtNative.ts` (TS bridge), `onnxruntime-android` Gradle dep, plugin registration in `MainActivity.java`, and a WASM/Native CPU toggle in `BenchmarkPage.jsx`. All of this is in `7e0f9ac` and the working tree.

The plugin loads ONNX from APK assets, decodes the photo data URL to a `Bitmap`, resizes, converts to CHW float, runs inference, and returns the flat output tensor across the JS bridge.

## 2. ORT quantization attempts and outcomes

| # | Quantization config | Loads on phone? | Outputs |
|---|---|---|---|
| 1 | Dynamic INT8 (committed yesterday) | ❌ hangs > 1.5 min in `createSession` at every `OptLevel` | n/a |
| 2 | Static INT8, `QOperator`, `QInt8`/`QInt8`, per-tensor, MinMax | ✅ 137 ms load, 135 ms infer | **all zero** |
| 3 | Static INT8, `QOperator`, `QUInt8`/`QInt8`, per-channel, Entropy | ✅ same fast load + inference | **all zero** |
| 4 | + `quant_pre_process` before quantizing | ✅ loads | **all zero** |
| 5 | `QDQ` format, per-channel | n/a — produces invalid ONNX (`DequantizeLinear` `axis` attribute not supported at this opset) | n/a |

**Diagnostic that nailed it down** (`scripts/diag_static_int8.py`): on the same input image, FP32 ONNX produces a normal confidence distribution (max 0.77, 225 boxes > 0.12). The static INT8 versions return literally a tensor of zeros — `min=0.0 max=0.0 mean=0.0`. This is not "lossy quantization", it's a fundamental failure where some op in the quantized graph silently drops the activations to zero.

Most likely cause: a YOLO op (probably the final sigmoid in the detection head, or the concat across feature-pyramid levels) doesn't have a working `QOperator`-format INT8 kernel for this combination of opset and types, and silently produces zero output.

## 3. What this proved

- ✅ The native runtime *itself* is fast — 40–60× faster than WASM on the Galaxy A35 (`unit` 137 ms load + 135 ms infer vs WASM's 953 ms + 6397 ms).
- ✅ The Capacitor plugin, asset loading, bitmap preprocessing, and tensor bridge are all correct.
- ❌ ORT's static INT8 quantization tooling does not produce valid output for these specific YOLOv8 graphs — even with the standard recipe (per-channel + Entropy + `quant_pre_process`).

## 4. Files added

- `scripts/quantize_static.py` — runnable static INT8 quantizer with calibration-pool selection and a `--only NAME[,NAME...]` filter
- `scripts/diag_static_int8.py` — FP32 vs INT8 output comparison, prints confidence distribution and boxes-above-threshold counts
- `scripts/test_preprocessed_quant.py` — one-off that confirmed `quant_pre_process` didn't fix the all-zeros problem
- `client/src/pages/BenchmarkPage.jsx` — WASM/Native CPU toggle + `openSession` / `runOne` / `closeSession` helpers that abstract over the backend choice

## 5. Next: FP16

FP16 conversion is the natural next attempt:

- No Q/DQ ops in the graph → no `createSession` hang
- No calibration data, no per-channel scales, no quantization noise — much simpler conversion
- ~3 decimal digits of precision retained; should preserve confidences cleanly
- ~233 MB total (vs 206 MB INT8) — bigger but still phone-deployable
- ORT's `onnxconverter-common.convert_float_to_float16` is one function call per model

If FP16 also fails on the phone, we pivot to TensorFlow Lite — different runtime, different quantization tooling, and known-good Android support.

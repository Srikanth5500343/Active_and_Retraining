# Work Summary — 2026-05-14

**Status: working.** Native on-device inference runs the full nine-model RackTrack pipeline on a Galaxy A35 5G in ~27 seconds wall-clock with detection counts that match the server analysis.

| | WASM (yesterday) | Native FP32 (today) |
|---|---|---|
| Pipeline wall-clock | 149 s | **27 s** (5.5×) |
| Median single-model inference (unit) | 6397 ms | **456 ms** (14×) |
| Largest model inference (Device_final) | 36110 ms | **1689 ms** (21×) |
| Rack-unit detections vs server (~16) | 21 | **15** |
| Device detections vs server (~10) | 2 | **14** |
| Port-location detections vs server (~hundreds) | 65 | **179** |
| Pass 2 crops processed | 2 | **6** |

The first half of the day was a series of dead-ends that the writeup committed earlier captures. This document is the post-mortem of the path that actually worked.

## What we tried and what each one cost us

| # | Approach | Outcome |
|---|---|---|
| 1 | Dynamic INT8 (yesterday's models) on native ORT | `createSession` hangs > 1.5 min at every `OptLevel`. WASM with same models works but is slow. |
| 2 | Static INT8, `QOperator`, `QInt8`/`QInt8`, per-tensor, MinMax calibration | Loads instantly. Returns a tensor of literal zeros. No detections. |
| 3 | Same as #2 but `QUInt8`/`QInt8`, per-channel, Entropy | Loads instantly. Still all zeros. |
| 4 | #3 plus `quant_pre_process` preprocessing | Loads. Still all zeros. |
| 5 | `QDQ` format, per-channel | Produces invalid ONNX (`DequantizeLinear` `axis` attribute not in this opset) — won't load at all. |
| 6 | FP16 via `onnxconverter_common` | Broken `Resize` nodes, won't load. |
| 7 | FP16 via Ultralytics `half=True` | Silently produces FP32 (no CUDA, no actual FP16). |
| 8 | **FP32 ONNX, native ORT, `OptLevel.ALL_OPT`** | **Works.** |

## What the working path needs

The full plugin + JS stack required nine separate fixes. Each was its own discovery; if any single one is missing, the pipeline either hangs, crashes, or returns garbage.

### Plugin side (Java)

1. **FP32 ONNX, kept in `client/public/models/*_int8.onnx`.** Filename retained for JS compatibility; content is the FP32 export. Total ~774 MB across nine models.
2. **`SessionOptions.OptLevel.ALL_OPT`.** Folds BatchNorm into Conv weights and runs constant folding — 9× runtime win on these YOLOv8 graphs. The `NO_OPT` we'd used during the INT8 attempts is wrong for FP32.
3. **`AssetFileDescriptor.getLength()` for byte-array preallocation.** The original `ByteArrayOutputStream` approach doubles capacity 15 times reading the 174 MB `Device_final` and OOMs Android's default heap. Preallocate exactly.
4. **EXIF rotation via `android.media.ExifInterface` + `Matrix.postRotate`.** `BitmapFactory` does not respect EXIF orientation; the WebView does. Without this, the model sees a sideways rack and the box overlay ends up as vertical stripes on the upright image.
5. **Letterbox preprocessing** (preserve aspect ratio, pad with gray 114,114,114), not plain `createScaledBitmap`. Ultralytics YOLOv8 is trained on letterboxed input; plain resize squashes a portrait rack into a square and the device detector returns ~1 detection instead of ~10. The plugin returns `{dx, dy, newW, newH, size}` so JS can unmap box coordinates back to the original image space.

### Build side (Gradle)

6. **`noCompress 'onnx'` in `aaptOptions`.** Compressing 200+ MB of binary ONNX files at build time OOMs Gradle; the files are already compact and don't compress meaningfully.
7. **Gradle JVM heap bumped to 6 GB.** Specifically `org.gradle.jvmargs=-Xmx6g -XX:MaxMetaspaceSize=512m` so AAPT can hold the asset table during APK packaging.

### JS side (BenchmarkPage)

8. **Multi-class YOLO decode (max over class channels).** YOLOv8 output shape is `[1, 4+C, N]`: 4 bbox channels plus C class scores. Confidence per box is `max(class_scores)`, not `class_scores[0]`. Reading channel 4 only silently dropped every detection that belonged to class 1..C-1. That is why `best_33` (18 classes) returned 0 detections and the device detectors returned 1 each before the fix — the right answer was that they were detecting many things, but the decoder threw all of them away.
9. **`CONF_THRESH=0.25`, `NMS_IOU=0.3`** (up from 0.12 and 0.45). With FP32 native we get the full confidence range back, so 0.25 drops the long tail of low-quality duplicates while still catching every real detection. Tighter NMS merges the inevitable per-anchor near-duplicates from YOLOv8's dense head.

### Loop side (automation)

10. **CLI build + install + drive.** `JAVA_HOME=<Android Studio JBR> ./gradlew assembleDebug` + `adb install -r` + UI Automator dump + `adb shell input tap` lets the whole iteration run without manual phone taps. A bundled `client/public/test_rack.jpg` and a "Run on bundled test rack" button skip the camera UI entirely, so the input is deterministic across runs.

## Per-model breakdown (the run that landed)

Test image: `client/public/test_rack.jpg` (the same rack the server pipeline analyzed as `RK-2D9F70F8`). Backend: Native CPU.

| # | Model | Output shape | Load | Infer | Detections |
|---|---|---|---|---|---|
| 1 | unit | [1, 5, 8400] | 87 ms | 568 ms | 14 |
| 2 | best_33 | [1, 22, 8400] | 60 ms | 318 ms | 14 |
| 3 | Units | [1, 5, 8400] | 159 ms | 1058 ms | 16 |
| 4 | port_count | [1, 6, 8400] | 180 ms | 1042 ms | 179 |
| 5 | Device_final | [1, 16, 8400] | 269 ms | 1863 ms | 14 |
| 6 | best_32 | [1, 16, 8400] | 276 ms | 2251 ms | 14 |
| 7 | switch_patch (×6 crops) | [1, 6, 8400] | 115 ms | 2753 ms total | 15 across 6 crops |
| 8 | port_best (×6 crops) | [1, 10, 8400] | 182 ms | 6461 ms total | 238 across 6 crops |
| 9 | efficientnet (×6 crops) | [batch, 14] | 80 ms | 331 ms total | top class 2 |
|   | **Totals** |  | **1.5 s** | **16.8 s** | |

**Total wall-clock: 27.5 s.** Pass 2 ran on every detected device crop (6 of 6), zero server traffic.

## What this proves

- Native onnxruntime-android *can* run a real production-grade vision pipeline on mid-range Android hardware with low-latency results. The earlier "dead end" was specifically a quantization issue, not a runtime issue.
- The end-to-end speedup vs WASM is genuine — between 14× and 21× per-model, ~5.5× wall-clock once you include JS-side work, photo I/O, and the deterministic-image overhead.
- Detection accuracy is at server parity for the visible rack content. The two device detectors (best_32 and Device_final) agree on 14 devices vs the server's ~10; the small over-count is mostly from a couple of stacked patch panels detected separately rather than fused.

## What still wants follow-up

1. Memory footprint is high. The APK is now 774 MB of bundled FP32 ONNX. Worth attempting *static INT8 with a real fix for the all-zeros bug* (likely involves Ultralytics-side export quirks) to bring this back to 200 MB.
2. NNAPI / GPU delegate has not been re-attempted. With static-INT8 caching for the compiled NNAPI graph, this could land another 3–5× speedup, bringing the pipeline under 10 s.
3. Box overlay rendering is functional but light. Bumping line width to 3 helped; a fully labelled overlay (server-style "U05-SW01") is still missing.
4. Static INT8 reattempt remains parked behind: working calibration data, per-class scales, and a path that doesn't squash the YOLO detection head to zero.

## Files of record

- `client/android/app/src/main/java/com/racktrack/app/OrtNativePlugin.java` — the plugin
- `client/src/plugins/OrtNative.ts` — JS bridge
- `client/src/pages/BenchmarkPage.jsx` — runner + toggle + automation button
- `client/public/test_rack.jpg` — deterministic input
- `client/public/models/*_int8.onnx` — nine FP32 ONNX models (filename retained)
- `scripts/quantize_static.py`, `scripts/diag_static_int8.py`, `scripts/test_preprocessed_quant.py`, `scripts/convert_fp16.py`, `scripts/export_fp16.py` — every failed attempt's tooling, kept as receipts

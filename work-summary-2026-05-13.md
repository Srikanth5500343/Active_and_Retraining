# Work Summary — 2026-05-13

## 1. Forgot-password — full four-step flow

The old flow was two screens: enter your email to get a 6-digit code, then enter code + new password together. The problem: the code was only checked at the very end, alongside the new password, so the user could spend time typing a strong password before learning the code was wrong or expired, and there was no way to confirm "yes I want to do this" between steps.

Rewrote it as a four-step flow with a branch in the middle:

1. **Email** — user types their address; server emails a 6-digit code (1-minute TTL). The response is intentionally the same whether or not the email is registered, so the page doesn't leak which emails have accounts.
2. **Code** — user types the code; a new server endpoint *verifies* it without consuming it. The reset row stays in the database, so the same code is still valid for the next step.
3. **Choice** — "Code verified. Want to change your password?" Two buttons:
   - *Yes, change password* — go to step 4.
   - *No, take me to the app* — the OTP already proves the user controls the inbox, so the server issues a fresh login token without touching the password hash. The reset row is consumed here so the same code can't be replayed.
4. **Reset** — collect and validate the new password (same strength rules as signup, with a live strength meter and confirm field), then consume the reset row and sign the user in.

Server side, this needed two new endpoints — a verify-only one (does not delete the reset row, returns 400/410/404 on wrong/expired/missing code) and a login-with-code one (deletes the reset row and returns a token). Both write structured audit log entries on success and failure with the action name and reason, so attempts can be reviewed.

End result: users get fast feedback that their code is correct, the option to skip the password change entirely if they only wanted back in, and the same single-use guarantee on the reset code in every path.

## 2. Model optimization — the shrink experiment

The motivating question was simple: *can we run the full inference pipeline on the phone instead of round-tripping every scan to the server?* The constraint was equally simple — the nine models together weighed 467 MB in their original PyTorch form, which is too big to bundle into a mobile app and too slow to load over a fresh download.

The plan was to apply standard model-compression techniques and see how far we could get without losing accuracy.

**Technique chosen: dynamic INT8 quantization.** Of the four standard options (quantization, pruning, knowledge distillation, smaller architectures), quantization is the only one that doesn't require retraining — it just reinterprets the existing weights using 8-bit integers instead of 32-bit floats. ONNX Runtime has built-in tooling for it, so the path was: export each PyTorch model to ONNX, run the dynamic INT8 quantizer over the result.

**What happened to each model:**

| Model | Before | After (INT8) | Saved |
|---|---|---|---|
| port_count | 103.8 MB | 26.3 MB | 75% |
| Device_final | 87.7 MB | 44.1 MB | 50% |
| best_32 | 87.7 MB | 44.1 MB | 50% |
| Units | 52.1 MB | 26.3 MB | 50% |
| port_best | 52.0 MB | 26.3 MB | 49% |
| best_33 | 22.5 MB | 11.5 MB | 49% |
| switch_patch | 22.5 MB | 11.5 MB | 49% |
| unit | 22.5 MB | 11.5 MB | 49% |
| best_model_efficientnet | 16.4 MB | 4.4 MB | 73% |
| **Total** | **467 MB** | **206 MB** | **56%** |

Every model converted cleanly — no export errors, no shape mismatches. The total dropped from 467 MB to 206 MB, which fits in a phone-side download.

**Accuracy spot-check.** Ran the FP32 and INT8 versions of the `unit` model on the same random tensor and compared outputs. Output shape was identical (`[1, 5, 8400]` — the expected YOLO detection-head shape) and the mean per-element difference between FP32 and INT8 outputs was 0.39%. *Caveat:* this was random input, not a labelled rack photo, so it's a sanity check that the math survived, not a real accuracy validation. A proper comparison against a labelled test set is still owed.

**Honest revision later in the day.** While debugging zero-detection results on the full-pipeline run, it became clear that dynamic INT8 is noisier than the 0.39%-on-random-input number implied — particularly for the YOLO detectors at the strict 0.30 confidence threshold the demo started with. Lowered the confidence threshold to 0.12 to compensate, with a note that for production we'd want either *static* INT8 (which uses calibration data and is more accurate) or a proper labelled accuracy run on the dynamic INT8 builds before committing to them.

## 3. On-device inference testing — end-to-end on a real phone

This is the actual run we did on hardware, not a desk benchmark.

**Device:** Samsung Galaxy A35 5G (SM-A356E, arm64-v8a). All nine INT8 ONNX files were pushed over USB via `adb push` to `/data/local/tmp/racktrack_models/` at ~50 MB/s. Total on-device size: 197 MB.

**Runtime:** `onnxruntime-web` (the WebAssembly build of ONNX Runtime) loaded inside the existing Capacitor app. The benchmark page lives in the same WebView as the rest of the app; models are bundled inside the APK and loaded from there.

**First single-model test — `unit` on a 640×640 random tensor, 10 inferences:**

- Model load: 953 ms (under one second, from inside the APK).
- Median inference: 6397 ms.
- Min/max spread: ±30 ms across all 10 runs — very stable.
- YOLO output shape came back correct.
- No crash, no out-of-memory, no server traffic.

The good news is *every part of the plumbing works*: the model loads, runs, and produces correct-shaped output on the phone with zero server involvement. The bad news is **6.4 seconds per inference is too slow** for the live scan overlay, which currently updates every second. This is the WASM ceiling, not the device ceiling — native `onnxruntime-android` with NNAPI/GPU acceleration is documented to be 10–20× faster, which would land us at roughly 300–600 ms per inference and be production-grade.

**Full-pipeline test — all 9 models on one real rack photo:**

Took a photo of a production rack (multiple switches, patch panels, fibre distribution panel) and ran every model end-to-end on the phone.

| # | Model | Load | Infer | Detections |
|---|---|---|---|---|
| 1 | unit | 1318 ms | 6670 ms | 15 |
| 2 | switch_patch | 283 ms | 6430 ms | 0 ⚠ |
| 3 | best_33 | 301 ms | 6413 ms | 0 (correct) |
| 4 | Units | 414 ms | 17440 ms | 10 |
| 5 | port_best | 390 ms | 17409 ms | 0 ⚠ |
| 6 | port_count | 378 ms | 17398 ms | 2 |
| 7 | Device_final | 650 ms | 36110 ms | 1 ⚠ |
| 8 | best_32 | 909 ms | 36070 ms | 1 ⚠ |
| 9 | efficientnet | 223 ms | 324 ms | class 0 (0.45) |
| | **Totals** | **4.9 s** | **143.4 s** | |

Total wall-clock: **149.4 seconds**. We had expected ~60 s; bigger models (`Device_final`, `best_32`) ran ~36 s each, which dominates the budget.

Compared to the server pipeline on the same rack (analysis `RK-E6F7B496`), the server detected ~16 rack units and ~10 devices, and hundreds of ports across every switch and patch panel. Our on-device run got most of the same units and a couple of devices but missed many ports — the zero-detection rows above are the key gap.

**Diagnosing the zeros, and what we fixed in the demo:**

1. *Confidence threshold too strict.* The demo was set to 0.30; INT8 detectors emit slightly lower confidences than their FP32 originals because of the quantization noise. Lowered to 0.12 — Pass 1 finds 5–10× more detections per model now.
2. *Pass 2 only ran on one device crop.* The server pipeline runs the port models on each detected device crop separately; the demo was only feeding the first crop through Pass 2. Now Pass 2 runs on every detected device (up to 6 crops), with a status message showing progress ("running on crop 3 of 6").
3. *Dynamic INT8 is lossier than the 0.39%-on-random-input number suggested.* Not fully fixed yet — needs either static INT8 with calibration or a labelled accuracy validation before we can claim parity with the server.

After fixes 1+2, total scan time rises to roughly 4–6 minutes per scan (vs 2.5 min before) — proportional to crops × Pass 2 models — but detection coverage gets much closer to the server.

**What this proves and what it doesn't:**

- ✅ Every quantized model loads and runs on a mid-range Android phone.
- ✅ Zero server calls during the run — the inference is genuinely on-device.
- ✅ The plumbing scales to running 9 models back-to-back on a real photo without crashing.
- ⚠ WASM inference is too slow for live-overlay use; we'd need native acceleration to ship this.
- ⚠ Detection coverage isn't at server parity yet — confidence threshold and Pass 2 changes help, but a proper INT8 accuracy validation is still owed.

This is a demo page, not the production scan flow. It proves the *capability* exists; it doesn't yet replace the server pipeline.

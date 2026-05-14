# 03. Quality Check — the photo gate before CV

## What it does (junior view)

When the user uploads a photo, the app does a fast sanity check
**before** the heavy computer-vision pipeline runs. The check looks
at the image and decides: is this even a usable rack photo?

Three outcomes:

1. **OK** — the photo is straight, sharp enough, well-lit, and shows
   visible rack rails. Move on to CV.
2. **Retake** — something is wrong but the user can fix it by
   re-shooting (blurry, tilted, glare, image too small). The user
   sees a toast like *"Photo's tilted — retake straight-on"* with a
   **Retake** button and a **Proceed anyway** button.
3. **Reject** — the upload is rejected outright (this happens after
   CV runs and finds zero devices, or fewer than 3 rack-units —
   strong signal that this isn't a rack photo at all).

This matters because every later stage depends on a usable photo.
If we let a blurry, tilted shot through, the user gets back garbage
device detections and unreadable OCR — but they don't know whether
that's because the photo was bad or the system is broken. The
quality gate gives the user a clear "your photo is the problem"
signal early, before they wait 30 seconds for a worthless result.

The user can always **Proceed anyway** — sometimes a tilted photo
of a partially obstructed rack is the best they can take that day,
and a lossy result beats no result. The override is recorded so
later it's clear why the data is suspect.

## What it doesn't do

- It doesn't reject a photo for showing the back of the rack vs the
  front. The CV stage handles that (no devices found → reject as
  "front of rack needed").
- It doesn't tell the user what specifically is wrong with too much
  precision. The metrics it reports are coarse ("blurry" vs "sharp",
  not a numeric Laplacian variance score in the UI).

---

## Technical detail (lead view)

### Where it runs

`pipeline/quality_check.py`, invoked from `server/app.js` via
`runQualityCheck(imagePath)` (helper around the worker pool at
`server/app.js:193`).

The call sits inline in `/api/analyze` at `server/app.js:1271`,
**before** `runPipelineAnalyze`. The quality check finishes in
under 1.5 seconds typically; the full pipeline takes 15-30s, so
the gate's purpose is to fail fast before the user waits.

### Skip path

If the request body has `skipQualityCheck: '1'`, the quality stage
is bypassed and the result object substitutes a sentinel:

```python
quality = { ok: True, metrics: { note: 'user-override' } }
```

The override is recorded into `outputs/<rackId>/scan_meta.json`
under `qualityWarning: true` for downstream debugging.

### Response shape on failure

```json
{
  "error": "Please take the photo from the front of the rack — we need to see the devices and ports face-on.",
  "metrics": {
    "blur_score": 18.4,
    "tilt_deg": 12.5,
    "brightness_mean": 220.1,
    "edges_found": 4,
    ...
  },
  "kind": "quality" | "framing" | "blur" | null,
  "retryable": true
}
```

The client checks `retryable === true`; if so, it shows the toast
with **Retake** and **Proceed anyway** buttons rather than a hard
error.

### Heuristics

| Check | Method | Trigger |
|---|---|---|
| Blur | `cv2.Laplacian(gray, CV_64F).var()` | below threshold → "Photo is too blurry — hold the phone still" |
| Tilt | Hough lines on edge map; measure dominant line angle | >15° from vertical → "Photo's tilted — retake straight-on" |
| Brightness | `gray.mean()` | < 30 (too dark) or > 240 (overexposed) → "Lighting issue — try a different angle" |
| Glare | local variance map; count saturated patches | many saturated patches → "Glare detected — move the camera" |
| Framing | edge count + aspect ratio | too few edges → "Make sure the full rack fits in the frame" |
| Resolution | image dimensions | min(W, H) < 480 → "Photo is too small to read" |

The exact thresholds are at the top of `pipeline/quality_check.py`
and tuned against representative scans rather than synthetic test
images. Tightening any of them increases false-rejects; loosening
increases garbage results downstream.

### Post-pipeline framing gate

After CV runs, `app.js:1320-1336` does a second-stage check that's
in the same spirit but uses the CV output rather than the raw
image:

- `deviceCount === 0` — pipeline found no devices. Likely a back-of-rack
  photo or "this isn't a rack". Reject with `retryable: true`.
- `unitCount < 3` — fewer than 3 U-rail markers detected. Camera
  was probably too close or the rack was partially out of frame.
  Reject with `retryable: true`.

Both of those are bypassed when `skipQualityCheck` was set —
"Proceed anyway" means the user has explicitly told us to accept
whatever the pipeline produces.

### Worker pool integration

`runQualityCheck` doesn't spawn a fresh Python every time. It
delegates to `pool.request('quality_check', { image_path })` where
`pool` is a long-lived worker pool defined in
`server/worker-pool.js` and constructed at app startup. That keeps
the average latency down to ~1-1.5s instead of paying Python's
~700ms startup cost per request.

If the worker pool has no available workers, the helper falls back
to spawning a one-shot Python process (slower but works). See
`server/worker-pool.js` for the implementation.

### Files in this feature

| File | Role |
|---|---|
| `pipeline/quality_check.py` | The actual checks, runs in worker pool |
| `server/app.js:193, 1271-1283, 1320-1336` | The call sites + post-pipeline gate |
| `server/worker-pool.js` | Reusable Python worker pool |
| `client/src/utils/validateMedia.js` | Client-side pre-flight (catches obviously-bad files before upload) |
| `client/src/pages/ScanPage.jsx:440` | The retake / proceed UI |

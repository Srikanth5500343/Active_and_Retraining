"""
Multi-rack video splitter.

Given a video where the user pans across N racks side-by-side, split it into
N best-frame images — one per rack — so the rest of the existing single-rack
analysis pipeline can run on each independently.

Algorithm (fully automated, no user input):

  1. Sample frames at evenly-spaced timestamps (~30 frames over the whole
     clip — fast enough for a 30s phone video, dense enough to catch
     short pauses on each rack).

  2. Run the existing device detector on each sampled frame to get the
     device bounding boxes.

  3. Compute each frame's "rack signature" — a horizontal cluster of
     detected device boxes (mean X position weighted by box area). The
     same rack across consecutive frames has a stable signature; a pan
     to the next rack shows up as a sudden X-shift.

  4. Detect rack-transition points: split the frame sequence wherever
     the signature shift between adjacent samples exceeds ~30% of the
     frame width (a deliberate horizontal pan, not camera shake).

  5. For each segment (= one rack), score the constituent frames by
       0.45 * device_count_normalized
     + 0.35 * mean_detection_confidence
     + 0.20 * sharpness (Laplacian variance)
     and pick the highest-scoring frame as that rack's "best frame".

  6. Save best frames to disk under outputs/multi/<video_hash>/rack_N.jpg
     and return a list of records the caller can hand to the existing
     /api/analyze pipeline (it accepts a single image at a time).

Design notes:
  - We do NOT modify the existing single-rack pipeline. Each rack's best
    frame goes through the same analyze() the regular flow uses, so per-
    rack reports / topology / SFP advice / firmware checks all work the
    same way they always did. Multi-rack only adds the "group" parent.
  - The detector is loaded lazily and reused across frames so the worker
    process amortises the model-load cost across all sampled frames.
"""

import os
import sys
import hashlib
from pathlib import Path

import cv2
import numpy as np


# Tunable knobs ------------------------------------------------------------
MAX_SAMPLED_FRAMES        = 30     # cap on how many frames we score
MIN_DEVICES_FOR_RACK      = 1      # frames with 0 devices are pan-transitions
TRANSITION_X_SHIFT_RATIO  = 0.25   # adjacent samples whose mean-X differs
                                   # by > 25% of frame width = new rack
VISUAL_CHANGE_THRESHOLD   = 0.35   # 1 - HSV-histogram correlation between
                                   # adjacent samples. > 0.35 = scene changed
                                   # (different rack), even if X stayed put.
MIN_FRAMES_PER_RACK       = 1      # a "rack" must hold the camera for ≥ N samples
DETECTOR_CONF_THRESHOLD   = 0.20   # mirrors config.json's devices_conf


def _video_hash(video_path: str) -> str:
    """Stable per-video id (used for the multi-rack output directory)."""
    h = hashlib.sha256()
    with open(video_path, "rb") as f:
        # Hash up to first 8 MiB — enough to be unique without reading 100MB
        h.update(f.read(8 * 1024 * 1024))
    return h.hexdigest()[:16]


def _sample_timestamps(total_frames: int, fps: float, k: int) -> list[int]:
    """Evenly-spaced frame indices to sample, capped at k."""
    if total_frames <= 0:
        return []
    if total_frames <= k:
        return list(range(total_frames))
    step = total_frames / k
    return [int(i * step) for i in range(k)]


def _load_detector():
    """Lazy-load the device detector. The same model file the live
    /api/analyze pipeline uses, so no separate model to maintain."""
    from ultralytics import YOLO
    import json
    cfg_path = Path(__file__).resolve().parents[1] / "config.json"
    cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    model_path = cfg["models"]["devices"]
    if not os.path.isabs(model_path):
        model_path = str(Path(__file__).resolve().parents[1] / model_path)
    return YOLO(model_path)


def _detect_devices(model, bgr_frame):
    """Run device detection on one frame. Returns a list of
    (x_center, width, conf) tuples."""
    res = model.predict(bgr_frame, verbose=False, conf=DETECTOR_CONF_THRESHOLD)[0]
    if res.boxes is None or len(res.boxes) == 0:
        return []
    xyxy = res.boxes.xyxy.cpu().numpy()
    conf = res.boxes.conf.cpu().numpy()
    out = []
    for (x1, y1, x2, y2), c in zip(xyxy, conf):
        cx = (x1 + x2) / 2.0
        w  = max(1.0, x2 - x1)
        out.append((float(cx), float(w), float(c)))
    return out


def _frame_signature(detections, frame_width):
    """Area-weighted mean X-center of all detected device boxes,
    normalized to [0, 1] across the frame width. Frames with no
    detections return None (treated as pan-transition)."""
    if not detections or frame_width <= 0:
        return None, 0, 0.0
    weights = [d[1] for d in detections]
    xs      = [d[0] for d in detections]
    confs   = [d[2] for d in detections]
    mean_x  = float(np.average(xs, weights=weights))
    return mean_x / frame_width, len(detections), float(np.mean(confs))


def _sharpness(bgr_frame):
    gray = cv2.cvtColor(bgr_frame, cv2.COLOR_BGR2GRAY)
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def _visual_fingerprint(bgr_frame, target_w: int = 96):
    """Small HSV color histogram. Robust to minor camera shake within a
    rack but changes a lot when the scene changes (different rack —
    different devices, cabling, room background). Used as a second
    rack-boundary signal alongside the device-X-shift signature, because
    head-on shots of two different racks can produce the same mean-X
    even though the visual content is completely different."""
    h, w = bgr_frame.shape[:2]
    if w > target_w:
        scale = target_w / float(w)
        small = cv2.resize(bgr_frame, (target_w, max(1, int(h * scale))))
    else:
        small = bgr_frame
    hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
    hist = cv2.calcHist([hsv], [0, 1], None, [16, 16], [0, 180, 0, 256])
    cv2.normalize(hist, hist)
    return hist


def _visual_distance(hist_a, hist_b) -> float:
    """0.0 = identical scene, ~1.0 = completely different scene."""
    if hist_a is None or hist_b is None:
        return 0.0
    corr = cv2.compareHist(hist_a, hist_b, cv2.HISTCMP_CORREL)
    return max(0.0, 1.0 - float(corr))


def split_video_into_racks(video_path: str, output_dir: str | None = None) -> list[dict]:
    """Main entry. Returns a list of dicts, one per detected rack:
        {
          "position":       1,                     # 1-based, in pan order
          "label":          "Rack 1",              # auto-generated
          "best_frame_path": ".../rack_1.jpg",
          "frame_index":    143,                   # source frame number
          "device_count":   12,                    # in the best frame
          "score":          0.84,                  # internal ranking score
        }
    """
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return []

    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    fps   = float(cap.get(cv2.CAP_PROP_FPS) or 30.0)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    if total <= 0 or width <= 0:
        cap.release()
        return []

    indices = _sample_timestamps(total, fps, MAX_SAMPLED_FRAMES)
    print(f"[multi-rack] sampling {len(indices)} of {total} frames @ fps={fps:.1f}",
          file=sys.stderr)

    # Load detector once (workers reuse it across frames)
    model = _load_detector()

    # Sample + detect
    samples = []
    for idx in indices:
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ok, frame = cap.read()
        if not ok or frame is None:
            continue
        dets = _detect_devices(model, frame)
        sig, n_dev, mean_conf = _frame_signature(dets, frame.shape[1])
        sharp = _sharpness(frame) if n_dev > 0 else 0.0
        fp    = _visual_fingerprint(frame)
        samples.append({
            "index":      idx,
            "frame":      frame,
            "n_devices":  n_dev,
            "sig":        sig,        # normalized mean X, or None
            "mean_conf":  mean_conf,
            "sharpness":  sharp,
            "fp":         fp,         # HSV histogram fingerprint
        })
    cap.release()

    if not samples:
        return []

    # ── Segment by signature shifts ──────────────────────────────────
    # Walk samples in order. Start a new segment when ANY of:
    #   * device-X signature jumps by > TRANSITION_X_SHIFT_RATIO   (clear pan)
    #   * scene fingerprint changes by > VISUAL_CHANGE_THRESHOLD   (different rack)
    #   * we cross a stretch of frames with no detections          (pan blur)
    # The visual-fingerprint signal catches the case where the user films
    # two different racks each centered head-on — both have mean-X ≈ 0.5
    # so the X-shift never trips, but the room/device colors are obviously
    # different scenes.
    segments: list[list[dict]] = []
    current: list[dict] = []
    last_sig = None
    last_fp  = None
    for s in samples:
        if s["sig"] is None or s["n_devices"] < MIN_DEVICES_FOR_RACK:
            # Likely mid-pan. Close out the current segment.
            if current:
                segments.append(current)
                current = []
            last_sig = None
            last_fp  = None
            continue
        big_x_shift     = (last_sig is not None
                           and abs(s["sig"] - last_sig) > TRANSITION_X_SHIFT_RATIO)
        visual_distance = _visual_distance(s["fp"], last_fp)
        big_visual_jump = (last_fp is not None
                           and visual_distance > VISUAL_CHANGE_THRESHOLD)
        if big_x_shift or big_visual_jump:
            reason = "x-shift" if big_x_shift else f"scene-change(d={visual_distance:.2f})"
            print(f"[multi-rack]   split at sample idx={s['index']} ({reason})",
                  file=sys.stderr)
            if current:
                segments.append(current)
            current = []
        current.append(s)
        last_sig = s["sig"]
        last_fp  = s["fp"]
    if current:
        segments.append(current)

    # Drop too-short segments (single-frame flickers from camera shake)
    segments = [seg for seg in segments if len(seg) >= MIN_FRAMES_PER_RACK]
    if not segments:
        # If aggressive splitting killed everything, treat the whole
        # video as one rack — pick the globally best detected frame.
        viable = [s for s in samples if s["n_devices"] >= MIN_DEVICES_FOR_RACK]
        if not viable:
            return []
        segments = [viable]

    print(f"[multi-rack] detected {len(segments)} rack segment(s)",
          file=sys.stderr)

    # ── Pick the best frame per segment + persist ────────────────────
    out_root = Path(output_dir) if output_dir else (
        Path(__file__).resolve().parents[1] / "outputs" / "multi" / _video_hash(video_path)
    )
    out_root.mkdir(parents=True, exist_ok=True)

    # Normalize device counts across all samples so segments with very
    # different occupancy don't get unfairly penalized.
    max_dev = max((s["n_devices"] for seg in segments for s in seg), default=1) or 1
    max_sharp = max((s["sharpness"] for seg in segments for s in seg), default=1.0) or 1.0

    results: list[dict] = []
    for pos, seg in enumerate(segments, start=1):
        best = max(seg, key=lambda s: (
            0.45 * (s["n_devices"]  / max_dev) +
            0.35 *  s["mean_conf"] +
            0.20 * (s["sharpness"] / max_sharp)
        ))
        best_path = out_root / f"rack_{pos}.jpg"
        cv2.imwrite(str(best_path), best["frame"], [cv2.IMWRITE_JPEG_QUALITY, 92])
        results.append({
            "position":        pos,
            "label":           f"Rack {pos}",
            "best_frame_path": str(best_path),
            "frame_index":     best["index"],
            "device_count":    best["n_devices"],
            "mean_conf":       round(best["mean_conf"], 3),
            "score":           round(
                0.45 * (best["n_devices"]  / max_dev) +
                0.35 *  best["mean_conf"] +
                0.20 * (best["sharpness"] / max_sharp), 3),
        })
    return results

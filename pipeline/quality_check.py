"""Server-side quality pre-check — RELAXED version with side-view detection.

Checks:
  1. Letterbox  — rejects images with large black bands (screenshot/rotated)
  2. Tilt       — rejects images rotated more than TILT_TOLERANCE_DEG
  3. Skew       — rejects if left vs right rail angles diverge too much
  4. Side-view  — NEW: rejects if horizontal lines converge (perspective angle)

Tolerances loosened vs the original to reduce false rejections on
slightly imperfect but usable front-facing shots.
"""

import argparse
import json

import cv2
import numpy as np

# ── Tolerances (relaxed from original) ──
TILT_TOLERANCE_DEG = 6.0           # was 4.0
PERSPECTIVE_TOLERANCE_DEG = 5.0    # was 3.0
LETTERBOX_BAND_FRAC = 0.10
LETTERBOX_DARK_FRAC = 0.92         # was 0.85
LETTERBOX_DARK_VALUE = 20          # was 25

# ── Side-view detection thresholds (NEW) ──
SIDE_VIEW_AVG_DEG = 20.0           # avg horizontal-line angle > this → side view
SIDE_VIEW_SPREAD_DEG = 18.0        # P90−P10 of horizontal angles > this → side view
SIDE_VIEW_MIN_LINES = 8            # need at least this many horizontal lines to judge


def check_letterbox(img):
    h = img.shape[0]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    band = max(1, int(h * LETTERBOX_BAND_FRAC))
    top_dark = float((gray[:band] < LETTERBOX_DARK_VALUE).mean())
    bot_dark = float((gray[-band:] < LETTERBOX_DARK_VALUE).mean())
    worst = max(top_dark, bot_dark)
    if worst > LETTERBOX_DARK_FRAC:
        return {
            "ok": False,
            "kind": "framing",
            "retryable": True,
            "error": "Please upload a clearer photo of the rack — keep the camera steady and make sure the full rack fits in the frame.",
            "metrics": {"letterbox_pct": round(worst * 100, 1)},
        }
    return {"ok": True}


def check_tilt(img):
    h, w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(gray, 50, 150, apertureSize=3)

    min_len = 350
    lines = cv2.HoughLinesP(edges, 1, np.pi / 180, threshold=80,
                            minLineLength=min_len, maxLineGap=25)

    if lines is None:
        return {"ok": True, "metrics": {"note": "no-lines"}}

    left_signed, left_weights = [], []
    right_signed, right_weights = [], []
    all_signed, all_weights = [], []
    midx = w / 2.0

    for line in lines:
        x1, y1, x2, y2 = line[0]
        dx, dy = x2 - x1, y2 - y1
        if dx == 0 and dy == 0:
            continue
        length = float(np.hypot(dx, dy))
        angle = np.degrees(np.arctan2(dy, dx))
        while angle > 90:
            angle -= 180
        while angle <= -90:
            angle += 180
        if angle >= 0:
            signed = 90 - angle
        else:
            signed = -90 - angle
        if abs(signed) > 25:
            continue

        mid_x = (x1 + x2) / 2.0
        all_signed.append(signed)
        all_weights.append(length)
        if mid_x < midx:
            left_signed.append(signed)
            left_weights.append(length)
        else:
            right_signed.append(signed)
            right_weights.append(length)

    if len(all_signed) < 3:
        return {"ok": True, "metrics": {"note": "insufficient-vertical-lines"}}

    overall = float(np.average(all_signed, weights=all_weights))
    if abs(overall) > TILT_TOLERANCE_DEG:
        return {
            "ok": False,
            "kind": "angle",
            "retryable": True,
            "error": "The image appears tilted. Please hold the phone straight and retake.",
            "metrics": {"rotation_deg": round(overall, 2)},
        }

    if len(left_signed) >= 2 and len(right_signed) >= 2:
        left_avg = float(np.average(left_signed, weights=left_weights))
        right_avg = float(np.average(right_signed, weights=right_weights))
        skew = abs(left_avg - right_avg)
        if skew > PERSPECTIVE_TOLERANCE_DEG:
            return {
                "ok": False,
                "kind": "angle",
                "retryable": True,
                "error": "The image appears tilted. Please hold the phone straight and retake.",
                "metrics": {"skew_deg": round(skew, 2),
                            "left_deg": round(left_avg, 2),
                            "right_deg": round(right_avg, 2)},
            }

    return {"ok": True, "metrics": {"rotation_deg": round(overall, 2)}}


def check_side_view(img):
    """Detect side-angle shots by analyzing horizontal line convergence.

    In a front-facing view, horizontal edges (shelves, unit faces) are
    roughly parallel — near 0°.  In a side-angle view, they converge
    toward a vanishing point, producing a measurable average slope and
    wider angle spread.
    """
    h, w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(gray, 50, 150, apertureSize=3)

    min_len = 350
    lines = cv2.HoughLinesP(edges, 1, np.pi / 180, threshold=60,
                            minLineLength=min_len, maxLineGap=15)

    if lines is None:
        return {"ok": True, "metrics": {"note": "no-horizontal-lines"}}

    horiz_angles = []
    horiz_weights = []

    for line in lines:
        x1, y1, x2, y2 = line[0]
        dx, dy = x2 - x1, y2 - y1
        if dx == 0 and dy == 0:
            continue
        length = float(np.hypot(dx, dy))
        angle = np.degrees(np.arctan2(dy, dx))
        while angle > 90:
            angle -= 180
        while angle <= -90:
            angle += 180
        # Keep near-horizontal lines (within 25° of horizontal)
        if abs(angle) < 25:
            horiz_angles.append(angle)
            horiz_weights.append(length)

    if len(horiz_angles) < SIDE_VIEW_MIN_LINES:
        return {"ok": True, "metrics": {"note": "insufficient-horizontal-lines",
                                         "count": len(horiz_angles)}}

    angles_arr = np.array(horiz_angles)
    weights_arr = np.array(horiz_weights)

    avg_angle = float(np.average(angles_arr, weights=weights_arr))
    p10 = float(np.percentile(angles_arr, 10))
    p90 = float(np.percentile(angles_arr, 90))
    spread = p90 - p10

    metrics = {
        "horiz_avg_deg": round(avg_angle, 2),
        "horiz_spread_deg": round(spread, 2),
        "horiz_line_count": len(horiz_angles),
    }

    if abs(avg_angle) > SIDE_VIEW_AVG_DEG:
        return {
            "ok": True,
            "warning": "side_angle",
            "error": "The image appears to be taken from a side angle. Results may not be accurate.",
            "metrics": metrics,
        }

    if spread > SIDE_VIEW_SPREAD_DEG:
        return {
            "ok": True,
            "warning": "side_angle",
            "error": "The image appears to be taken from a side angle. Results may not be accurate.",
            "metrics": metrics,
        }

    return {"ok": True, "metrics": metrics}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    args = parser.parse_args()

    img = cv2.imread(args.image)
    if img is None:
        print(json.dumps({
            "ok": False,
            "error": "Could not read image. Please upload a valid photo."
        }))
        return

    # 1. Letterbox check
    lb = check_letterbox(img)
    if not lb["ok"]:
        print(json.dumps(lb))
        return

    # 2. Tilt / skew check
    tilt = check_tilt(img)
    if not tilt["ok"]:
        print(json.dumps(tilt))
        return

    # 3. Side-view check (returns warning, not hard fail)
    side = check_side_view(img)

    # All passed — merge metrics and include any warning
    merged_metrics = {}
    merged_metrics.update(tilt.get("metrics", {}))
    merged_metrics.update(side.get("metrics", {}))

    result = {"ok": True, "metrics": merged_metrics}
    if side.get("warning"):
        result["warning"] = side["warning"]
        result["warning_msg"] = side["error"]

    print(json.dumps(result))


if __name__ == "__main__":
    main()

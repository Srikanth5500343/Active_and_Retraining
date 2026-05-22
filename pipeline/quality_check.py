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

# ── Occlusion (cable clutter) thresholds ──
# Image-only heuristic that runs PRE-analyze. Detects heavily-cabled racks
# where the front of the equipment is blocked by patch cables / cable spaghetti.
#
# Two independent signals — if EITHER fires, the rack is flagged:
#
#  (a) Edge-orientation ratio: clean racks have dominant HORIZONTAL edges
#      (top/bottom of each 1U device); cabled racks have dominant VERTICAL/
#      DIAGONAL edges (cables crossing across devices). Misses racks with
#      visible U-position labels (the labels create strong horizontal edges
#      even when cables block the equipment behind them) — hence signal (b).
#
#  (b) Color-saturation fraction: cables are vividly colored (blue, orange,
#      yellow, red); device faces are desaturated (gray/black/white). When
#      a large fraction of the central rack region is high-saturation
#      pixels, cables dominate the view.
OCCLUSION_NONHORIZ_RATIO = 1.45    # non_horizontal/horizontal edge mag → "warning"
OCCLUSION_NONHORIZ_HARD  = 2.10    # above this → "hard" (offer multi-angle)
OCCLUSION_SAT_FRAC_WARN  = 0.22    # fraction of high-saturation pixels → warning
OCCLUSION_SAT_FRAC_HARD  = 0.38    # fraction of high-saturation pixels → hard
OCCLUSION_SAT_THRESHOLD  = 80      # HSV saturation value considered "vivid"
OCCLUSION_MIN_STRONG_PX  = 1500    # minimum strong-edge pixel count to judge at all


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


def check_occlusion(img):
    """Detect rack images where cables block the front of the equipment.

    Two independent image-only signals (either firing → occluded):

      (a) Edge orientation — strong edges with HORIZONTAL gradient (vertical
          image lines) come from cables; strong edges with VERTICAL gradient
          (horizontal image lines) come from 1U/2U device faces. v_to_h_ratio
          captures cable dominance from edges alone.

      (b) Color saturation fraction — cables are vivid (blue/orange/yellow);
          device faces and rack frames are desaturated grays. When >20% of
          the central rack region's pixels are high-saturation, cables
          dominate the view. This catches racks whose labels would otherwise
          keep horizontal edges high (signal (a) misses them).

    Returns:
      - {"ok": True}                                 # clean enough
      - {"ok": True, "warning": "occlusion", ...}    # cabled but proceed-able
      - {"ok": False, "kind": "occlusion", ...}      # severely occluded — pop modal
    """
    h, w = img.shape[:2]
    if h < 64 or w < 64:
        return {"ok": True, "metrics": {"note": "image-too-small"}}

    # Central rack region (skip floor / ceiling / wall margin) shared by both signals.
    y0, y1 = int(h * 0.10), int(h * 0.92)
    x0, x1 = int(w * 0.05), int(w * 0.95)
    central_color = img[y0:y1, x0:x1]
    if central_color.size == 0:
        return {"ok": True, "metrics": {"note": "no-central-region"}}

    # ── Signal (a) — edge orientation ratio ──
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (3, 3), 0)
    central_gray = gray[y0:y1, x0:x1]
    gx = cv2.Sobel(central_gray, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(central_gray, cv2.CV_32F, 0, 1, ksize=3)
    mag = np.hypot(gx, gy)
    if mag.size == 0 or float(mag.max()) < 1.0:
        ratio = 0.0
        strong_count = 0
    else:
        thresh = float(np.percentile(mag, 75))
        strong = mag > thresh
        strong_count = int(strong.sum())
        if strong_count < OCCLUSION_MIN_STRONG_PX:
            ratio = 0.0
        else:
            abs_gx = np.abs(gx[strong])
            abs_gy = np.abs(gy[strong])
            vertical_line_mag    = float(np.sum(abs_gx[abs_gx > abs_gy * 1.732]))
            horizontal_line_mag  = float(np.sum(abs_gy[abs_gy > abs_gx * 1.732]))
            if horizontal_line_mag < 1.0:
                ratio = 99.0
            else:
                ratio = vertical_line_mag / horizontal_line_mag

    # ── Signal (b) — color-saturation fraction ──
    hsv = cv2.cvtColor(central_color, cv2.COLOR_BGR2HSV)
    sat = hsv[..., 1]
    # Also require some minimum brightness (avoid counting dark noisy regions
    # whose saturation is technically high but visually invisible).
    val = hsv[..., 2]
    vivid_mask = (sat >= OCCLUSION_SAT_THRESHOLD) & (val >= 50)
    sat_frac = float(vivid_mask.mean()) if vivid_mask.size > 0 else 0.0
    mean_sat = float(sat.mean()) if sat.size > 0 else 0.0

    metrics = {
        "v_to_h_ratio":  round(ratio, 2),
        "strong_edge_px": strong_count,
        "sat_frac":      round(sat_frac, 3),
        "mean_sat":      round(mean_sat, 1),
    }

    # ── Decision: hard fail if EITHER signal is severe ──
    hard_by_ratio = ratio >= OCCLUSION_NONHORIZ_HARD
    hard_by_sat   = sat_frac >= OCCLUSION_SAT_FRAC_HARD
    if hard_by_ratio or hard_by_sat:
        reasons = []
        if hard_by_ratio: reasons.append(f"cable edges dominate ({ratio:.1f}x device edges)")
        if hard_by_sat:   reasons.append(f"{int(sat_frac*100)}% of view is colored cables")
        return {
            "ok": False,
            "kind": "occlusion",
            "retryable": True,
            "error": ("This rack is heavily covered by cables — " + " and ".join(reasons) +
                      ". For better accuracy, take additional photos from the left and right "
                      "sides of the rack so we can see behind the cable bundles, or proceed "
                      "with this image (results may miss devices)."),
            "metrics": metrics,
        }

    warn_by_ratio = ratio >= OCCLUSION_NONHORIZ_RATIO
    warn_by_sat   = sat_frac >= OCCLUSION_SAT_FRAC_WARN
    if warn_by_ratio or warn_by_sat:
        return {
            "ok": True,
            "warning": "occlusion",
            "warning_msg": ("Cables cover much of the rack — some devices behind cable bundles "
                            "may not be detected. Side-angle photos would improve accuracy."),
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

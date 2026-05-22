import os
import cv2
import numpy as np
from ultralytics import YOLO

# Step 02: Detection utilities (new dual-model + rack-crop flow)
#
# Models:
#   - best 33.pt ("server" model)  — contributes ONLY its `server` class
#   - best 32.pt ("general" model) — contributes every class EXCEPT `server`
#
# Class names from YOLO are normalized to the Title-Case forms the rest of
# the pipeline (and the Node server's label codes) expect.

FALLBACK_DEVICE_CLASS_NAMES = {"Closed Unit", "Empty"}

_CLASS_NAME_OVERRIDES = {
    "patch panel":   "Patch Panel",
    "patch_panel":   "Patch Panel",
    "patchpanel":    "Patch Panel",
    "closed unit":   "Closed Unit",
    "closed_unit":   "Closed Unit",
    "storage unit":  "Storage Unit",
    "storage_unit":  "Storage Unit",
    "load balancer": "Load Balancer",
    "load_balancer": "Load Balancer",
    "pdu":           "PDU",
    "psu":           "PSU",
    "ups":           "UPS",
}


def normalize_class_name(raw):
    """Map YOLO class strings to the Title-Case forms the backend uses."""
    s = str(raw).strip().replace("_", " ").lower()
    if s in _CLASS_NAME_OVERRIDES:
        return _CLASS_NAME_OVERRIDES[s]
    return s.title()


def _find_class_id(names_dict, target_name):
    target = str(target_name).lower().strip()
    for k, v in (names_dict or {}).items():
        if str(v).lower().strip() == target:
            return int(k)
    return None


_MODEL_CACHE = {}


def load_model(model_path: str):
    """Load a YOLO model; cached so a persistent worker pays the load cost once."""
    cached = _MODEL_CACHE.get(model_path)
    if cached is not None:
        return cached
    if not os.path.exists(model_path):
        raise FileNotFoundError(f"Model file not found: {model_path}")
    model = YOLO(model_path)
    _MODEL_CACHE[model_path] = model
    return model


def print_model_classes(model, model_name: str):
    names = getattr(model, "names", {})
    print(f"\nAvailable classes for {model_name} model:")
    for class_id, class_name in sorted(names.items()):
        print(f"  {class_id}: {class_name}")


# ── Geometry helpers ───────────────────────────────────────────

def _intersection_area(box_a, box_b):
    ax1, ay1, ax2, ay2 = box_a
    bx1, by1, bx2, by2 = box_b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    if ix2 <= ix1 or iy2 <= iy1:
        return 0
    return (ix2 - ix1) * (iy2 - iy1)


def _box_area(box):
    x1, y1, x2, y2 = box
    return max(0, x2 - x1) * max(0, y2 - y1)


def _iou(box_a, box_b):
    inter = _intersection_area(box_a, box_b)
    if inter == 0:
        return 0.0
    union = _box_area(box_a) + _box_area(box_b) - inter
    return inter / union if union > 0 else 0.0


def _box_overlap_ratio(box_a, box_b):
    intersection = _intersection_area(box_a, box_b)
    if intersection == 0:
        return 0.0
    return intersection / min(_box_area(box_a), _box_area(box_b))


# ── Rack bounding box (Hough lines) ────────────────────────────

def detect_rack_bounds(img):
    """Detect the rack bounding box using near-horizontal/near-vertical Hough
    line segments. Returns (x1, y1, x2, y2) in the image's pixel space, or
    None if no rack-like structure is found (caller should fall back to the
    full image in that case).
    """
    if img is None or img.size == 0:
        return None
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blur, 50, 150)

    lines = cv2.HoughLinesP(
        edges, 1, np.pi / 180,
        threshold=100, minLineLength=200, maxLineGap=20,
    )

    xs, ys = [], []
    if lines is not None:
        for line in lines:
            x1, y1, x2, y2 = line[0]
            # Keep only near-horizontal or near-vertical segments
            if abs(x1 - x2) < 20 or abs(y1 - y2) < 20:
                xs.extend([x1, x2])
                ys.extend([y1, y2])

    if not xs:
        return None
    return (int(min(xs)), int(min(ys)), int(max(xs)), int(max(ys)))


# ── Dual-model device detection ────────────────────────────────
#
# Logic mirrors device_detection.py::_detect_devices exactly — that
# detector is field-tested at ~99% accuracy and is the source of truth
# for "what's in this rack image". We keep this function's signature
# (conf params, return shape) so runner.py and the rest of the pipeline
# don't have to change.

# Label normalisation table — same dataset as device_detection.py.
_VALID_LABELS_DUAL = {
    "Closed Unit", "Empty", "Firewall", "Gateway", "PDU", "PSU",
    "Patch Panel", "Router", "Server", "Storage Unit", "Switch", "UPS",
}
_LABEL_MAP_DUAL = {
    "patch_panel": "Patch Panel", "patch panel": "Patch Panel",
    "switch": "Switch", "network switch": "Switch", "ethernet switch": "Switch",
    "server": "Server", "server rack": "Server",
    "pdu": "PDU", "power distribution unit": "PDU", "power strip": "PDU",
    "ups": "UPS", "uninterruptible power supply": "UPS", "cyberpower": "UPS",
    "firewall": "Firewall", "router": "Router", "gateway": "Gateway",
    "psu": "PSU", "power supply unit": "PSU",
    "storage": "Storage Unit", "storage unit": "Storage Unit",
    "closed unit": "Closed Unit", "empty": "Empty",
}


def _normalize_label_dual(raw: str) -> str:
    """Same logic as device_detection.py::normalize_label."""
    if not raw:
        return "Empty"
    key = raw.strip().lower()
    if key in _LABEL_MAP_DUAL:
        return _LABEL_MAP_DUAL[key]
    titled = raw.strip().title()
    return titled if titled in _VALID_LABELS_DUAL else "Empty"


def detect_devices_dual(img, model_server, model_general,
                        conf_server=0.25, conf_general=0.2, iou_thresh=0.5):
    """Dual-model device detection — mirrors device_detection.py.

    Pass 1: model_server (best 33.pt) → Server class only.
    Pass 2: model_general (best 32.pt) → every other class, IoU dedup vs Pass 1.

    Each accepted box is shrunk by 2 pixels per side to suppress
    border noise; boxes smaller than 10×10 after the shrink are dropped.

    Coordinates are in the coordinate space of the passed-in `img`.
    Output shape is preserved for downstream compatibility:
        { class_id, class_name, confidence, box[xyxy], center[cx,cy], source }
    """
    h, w = img.shape[:2]
    detections = []
    seen_boxes = []
    PAD = 2

    # ── Pass 1: Server only ────────────────────────────────────────────
    if model_server is not None:
        s_names = getattr(model_server, "names", {})
        server_id_s = next(
            (k for k, v in s_names.items() if str(v).lower() == "server"),
            None,
        )
        if server_id_s is not None:
            res_s = model_server(img, conf=conf_server)
            if res_s and res_s[0].boxes is not None and len(res_s[0].boxes) > 0:
                xyxy = res_s[0].boxes.xyxy.cpu().numpy()
                cls_ids = res_s[0].boxes.cls.cpu().numpy().astype(int)
                scores = res_s[0].boxes.conf.cpu().numpy()
                for box, cid, score in zip(xyxy, cls_ids, scores):
                    if int(cid) != server_id_s:
                        continue
                    x1, y1, x2, y2 = (int(v) for v in box)
                    x1 = min(max(x1 + PAD, 0), w - 1)
                    y1 = min(max(y1 + PAD, 0), h - 1)
                    x2 = max(min(x2 - PAD, w - 1), x1 + 1)
                    y2 = max(min(y2 - PAD, h - 1), y1 + 1)
                    if (x2 - x1) < 10 or (y2 - y1) < 10:
                        continue
                    box_xyxy = [x1, y1, x2, y2]
                    detections.append({
                        "class_id":   int(cid),
                        "class_name": "Server",
                        "confidence": float(score),
                        "box":        box_xyxy,
                        "center":     [(x1 + x2) // 2, (y1 + y2) // 2],
                        "source":     "server_model",
                    })
                    seen_boxes.append(box_xyxy)

    # ── Pass 2: every other class (general model), IoU dedup vs Pass 1
    g_names = getattr(model_general, "names", {})
    server_id_g = next(
        (k for k, v in g_names.items() if str(v).lower() == "server"),
        None,
    )
    res_l = model_general(img, conf=conf_general)
    if res_l and res_l[0].boxes is not None and len(res_l[0].boxes) > 0:
        xyxy = res_l[0].boxes.xyxy.cpu().numpy()
        cls_ids = res_l[0].boxes.cls.cpu().numpy().astype(int)
        scores = res_l[0].boxes.conf.cpu().numpy()
        for box, cid, score in zip(xyxy, cls_ids, scores):
            cid = int(cid)
            if server_id_g is not None and cid == server_id_g:
                continue
            x1, y1, x2, y2 = (int(v) for v in box)
            x1 = min(max(x1 + PAD, 0), w - 1)
            y1 = min(max(y1 + PAD, 0), h - 1)
            x2 = max(min(x2 - PAD, w - 1), x1 + 1)
            y2 = max(min(y2 - PAD, h - 1), y1 + 1)
            if (x2 - x1) < 10 or (y2 - y1) < 10:
                continue
            cur = [x1, y1, x2, y2]
            if any(_iou(cur, prev) > iou_thresh for prev in seen_boxes):
                continue
            seen_boxes.append(cur)
            detections.append({
                "class_id":   cid,
                "class_name": _normalize_label_dual(str(g_names.get(cid, cid))),
                "confidence": float(score),
                "box":        cur,
                "center":     [(x1 + x2) // 2, (y1 + y2) // 2],
                "source":     "general_model",
            })

    return detections


def shift_boxes(detections, dx, dy):
    """Translate every detection's box + center by (dx, dy). Used to map
    boxes from a rack-cropped frame back into full-image coordinates."""
    for d in detections:
        x1, y1, x2, y2 = d["box"]
        d["box"] = [x1 + dx, y1 + dy, x2 + dx, y2 + dy]
        cx, cy = d["center"]
        d["center"] = [cx + dx, cy + dy]
    return detections


def detect_devices_retry(img, model_server, model_general, primary_devices,
                         conf_server=0.08, conf_general=0.08, iou_thresh=0.5):
    """Low-conf retry pass — DISABLED.

    The primary `detect_devices_dual` now mirrors device_detection.py and is
    field-tested at ~99% accuracy on the rack imagery, so the second-pass
    retry is no longer needed and could only add false positives. The
    function is kept as a no-op so runner.py and other callers keep working
    without conditional imports.
    """
    return primary_devices


# ── Unit grid: YOLO unit model + contiguous post-processing ────

def build_unit_grid(img, unit_model_path=None, conf=0.25):
    """Build a unit grid using YOLO unit detection + post-processing.

    1. Detect units with YOLO → get count and approximate positions.
    2. Sort by y-position (top to bottom).
    3. Compute mean height and mean width.
    4. Make contiguous: y1[i] = y2[i-1] (no gaps, no overlaps).
    5. Standardize: all units = same height, same width, centered.
    """
    if unit_model_path is None:
        return []

    model = load_model(unit_model_path)
    results = model(img, conf=conf)

    if not results or results[0].boxes is None or len(results[0].boxes) == 0:
        return []

    boxes = results[0].boxes.data.cpu().numpy()

    # Filter out "rail" detections if the model has named classes
    names = getattr(model, "names", {})
    cls_ids = boxes[:, 5].astype(int) if boxes.shape[1] > 5 else None
    if cls_ids is not None:
        keep = [i for i, cid in enumerate(cls_ids)
                if str(names.get(int(cid), "")).lower() != "rail"]
        if keep:
            boxes = boxes[keep]

    if len(boxes) < 1:
        return []

    # Sort by top y-coordinate (ascending)
    boxes = boxes[boxes[:, 1].argsort()]

    # Compute mean height and width
    heights = boxes[:, 3] - boxes[:, 1]
    widths = boxes[:, 2] - boxes[:, 0]
    mean_h = float(heights.mean())
    mean_w = float(widths.mean())

    # Make contiguous + standardize
    for i in range(len(boxes)):
        if i > 0:
            boxes[i][1] = boxes[i - 1][3]  # y1 = previous y2
        boxes[i][3] = boxes[i][1] + mean_h  # y2 = y1 + mean_h
        center_x = (boxes[i][0] + boxes[i][2]) / 2
        boxes[i][0] = center_x - mean_w / 2
        boxes[i][2] = center_x + mean_w / 2

    units = []
    for box in boxes:
        x1, y1, x2, y2 = (int(round(v)) for v in (box[0], box[1], box[2], box[3]))
        units.append({
            "box": [x1, y1, x2, y2],
            "center": [(x1 + x2) // 2, (y1 + y2) // 2],
            "center_y": (y1 + y2) / 2,
        })

    units = assign_units(units)
    return units


def assign_units(units):
    sorted_units = sorted(units, key=lambda u: u["box"][1])
    for index, unit in enumerate(sorted_units, start=1):
        unit["label"] = f"u{index:02d}"
        unit["center_y"] = (unit["box"][1] + unit["box"][3]) / 2
    return sorted_units


def _snap_to_edge(gray_roi, approx_y, half=45):
    """Snap `approx_y` to the strongest horizontal gradient within ±half px."""
    h = gray_roi.shape[0]
    y1 = max(0, approx_y - half)
    y2 = min(h, approx_y + half + 1)
    if y2 <= y1:
        return approx_y
    strip = gray_roi[y1:y2, :].astype(np.float32)
    sobel = cv2.Sobel(strip, cv2.CV_32F, 0, 1, ksize=3)
    strength = np.abs(sobel).mean(axis=1)
    return y1 + int(np.argmax(strength))


def normalize_units(units, img):
    """Snap each unit's top/bottom edge to the nearest strong horizontal
    gradient in the grayscale image — aligns unit boundaries to visible rack
    rails. No-op when the YOLO grid is empty."""
    if not units:
        return units

    img_h, img_w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    left_x = max(0, min(u["box"][0] for u in units))
    right_x = min(img_w, max(u["box"][2] for u in units))
    gray_roi = gray[:, left_x:right_x]

    n = len(units)
    approx = [units[0]["box"][1]] + [u["box"][3] for u in units]
    snapped = sorted(set(_snap_to_edge(gray_roi, ay) for ay in approx))

    if len(snapped) < n + 1:
        top_y = snapped[0] if snapped else units[0]["box"][1]
        avg_h = max(1, int(round(sum(u["box"][3] - u["box"][1] for u in units) / n)))
        snapped = [min(img_h, top_y + i * avg_h) for i in range(n + 1)]

    row_pairs = [(snapped[i], snapped[i + 1]) for i in range(n)]

    for unit, (y1, y2) in zip(units, row_pairs):
        unit["box"] = [left_x, y1, right_x, y2]
        unit["center"] = [(left_x + right_x) // 2, (y1 + y2) // 2]
        unit["center_y"] = (y1 + y2) / 2

    return units


# ── Device-tiling fallback (used when YOLO unit grid looks wrong) ──

def derive_unit_height(devices):
    """Pick unit_h from the median height of detected Switches, falling back
    to Patch Panels. Returns None when neither type is present."""
    heights_sw = [d["box"][3] - d["box"][1]
                  for d in devices if d.get("class_name") == "Switch"]
    if heights_sw:
        return int(np.median(heights_sw))
    heights_pp = [d["box"][3] - d["box"][1]
                  for d in devices if d.get("class_name") == "Patch Panel"]
    if heights_pp:
        return int(np.median(heights_pp))
    return None


def estimate_expected_units(img, devices, unit_h):
    """Rough count of how many 1U slots the image should contain, based on
    device heights plus gap-tiling estimate. Used as a sanity check for
    the YOLO unit grid."""
    if not devices or not unit_h or unit_h <= 0:
        return 0
    total = 0
    ordered = sorted(devices, key=lambda d: d["box"][1])
    img_h = img.shape[0]
    cursor = 0
    for dev in ordered:
        dy1, dy2 = dev["box"][1], dev["box"][3]
        gap = max(0, dy1 - cursor)
        total += max(0, int(round(gap / unit_h)))
        total += max(1, int(round((dy2 - dy1) / unit_h)))
        cursor = dy2
    total += max(0, int(round(max(0, img_h - cursor) / unit_h)))
    return total


def build_unit_grid_from_devices(img, devices, unit_h):
    """Fallback unit grid: tile unit boxes top-to-bottom using `unit_h`.

    - Each gap between devices becomes `round(gap_h / unit_h)` slices
      (≥ 0.5 × unit_h is guaranteed at least one slice).
    - Each device span becomes `round(device_h / unit_h)` slices so
      `assign_devices_to_units` still has a unit per device.
    - Grid spans full image height — so UPS/PDU chassis above or below
      the detected devices still get rows.

    Returns unit dicts labeled u01..uNN top-to-bottom.
    """
    if unit_h is None or unit_h <= 0 or not devices:
        return []

    img_h, img_w = img.shape[:2]
    left_x, right_x = 0, img_w - 1
    top_y, bot_y = 0, img_h
    ordered = sorted(devices, key=lambda d: d["box"][1])
    units = []

    def push_unit(y1, y2):
        y1 = int(max(top_y, y1))
        y2 = int(min(bot_y, y2))
        if y2 - y1 <= 0:
            return
        units.append({
            "box": [left_x, y1, right_x, y2],
            "center": [(left_x + right_x) // 2, (y1 + y2) // 2],
            "center_y": float((y1 + y2) / 2),
        })

    def tile_gap(y_from, y_to):
        gap_h = y_to - y_from
        if gap_h <= 0:
            return
        n = int(round(gap_h / unit_h))
        if n == 0 and gap_h >= 0.5 * unit_h:
            n = 1
        if n <= 0:
            return
        step = gap_h / n
        for i in range(n):
            push_unit(round(y_from + i * step), round(y_from + (i + 1) * step))

    cursor = top_y
    for dev in ordered:
        dy1, dy2 = int(dev["box"][1]), int(dev["box"][3])
        tile_gap(cursor, dy1)
        dev_h = max(1, dy2 - dy1)
        n_units = max(1, int(round(dev_h / unit_h)))
        step = dev_h / n_units
        for i in range(n_units):
            push_unit(round(dy1 + i * step), round(dy1 + (i + 1) * step))
        cursor = dy2
    tile_gap(cursor, bot_y)

    for i, u in enumerate(units):
        u["label"] = f"u{i + 1:02d}"
    return units


# ── Device post-processing (used by runner) ────────────────────

def remove_overlapping_devices(devices, max_overlap_ratio=0.01):
    filtered = []
    for dev in sorted(devices, key=lambda d: (d["box"][1], -d["confidence"])):
        keep = True
        for kept in filtered:
            if _box_overlap_ratio(dev["box"], kept["box"]) > max_overlap_ratio:
                keep = False
                print(f"[info] removing overlapping device: {dev['class_name']} overlaps {kept['class_name']}")
                break
        if keep:
            filtered.append(dev)
    return filtered


def validate_device_stack(devices):
    for i, a in enumerate(devices):
        for b in devices[i + 1:]:
            if _intersection_area(a["box"], b["box"]) > 0:
                print(f"[warning] overlapping devices detected: {a['class_name']} vs {b['class_name']}")


def is_device_inside_unit(device, unit, threshold=0.99):
    device_area = _box_area(device["box"])
    if device_area == 0:
        return False
    overlap = _intersection_area(device["box"], unit["box"])
    return overlap / device_area >= threshold


def filter_devices_inside_units(devices, units, threshold=0.99):
    filtered = []
    for dev in devices:
        if any(is_device_inside_unit(dev, unit, threshold=threshold) for unit in units):
            filtered.append(dev)
        else:
            print(f"[info] discarding device outside units: {dev['class_name']} box={dev['box']}")
    return filtered


def assign_devices_to_units(devices, units):
    """Assign each device the top-N grid units it overlaps, where N is the
    device's natural unit count derived from its height relative to the
    true 1U height.

    Rule (per user spec):
      - 1U devices get 1 unit  (the grid unit with the largest overlap)
      - 2U devices get 2 units (the two with the largest overlaps)
      - 3U devices get 3, etc.

    This is independent of whether the YOLO grid over-slices 1U slots into
    halves — a 1U device straddling two half-units at 50/50 still ends up
    claiming only one. Orphaned grid units (overlap with a device but not
    picked in the top-N) are cleaned up by `cleanup_duplicate_units` so
    they don't show up as phantom "Empty" rows in the report."""
    if not units:
        for dev in devices:
            dev["units"] = []
        return devices

    for dev in devices:
        dev["units"] = []

    # Reference 1U height from median Switch / Patch-Panel box. Used to
    # translate each device's pixel height into an expected unit count.
    true_unit_h = derive_unit_height(devices)

    for dev in devices:
        dev_area = _box_area(dev["box"])
        if dev_area <= 0:
            continue
        dev_h = max(1, dev["box"][3] - dev["box"][1])
        expected_n = (
            max(1, int(round(dev_h / true_unit_h)))
            if true_unit_h and true_unit_h > 0
            else 1
        )

        # All overlapping units, sorted by overlap area (largest first).
        candidates = []
        for unit in units:
            overlap = _intersection_area(dev["box"], unit["box"])
            if overlap > 0:
                candidates.append((unit, overlap))

        if not candidates:
            # Device doesn't overlap any grid unit — fall back to nearest by
            # y-center. Rare, but keeps the picker label sane.
            nearest = min(units, key=lambda u: abs(dev["center"][1] - u["center_y"]))
            dev["units"].append(nearest["label"])
            continue

        candidates.sort(key=lambda c: -c[1])
        for unit, _ in candidates[:expected_n]:
            dev["units"].append(unit["label"])

    # Sort each device's units so the label range reads U01-U02, not U02-U01.
    for dev in devices:
        dev["units"] = sorted(set(dev["units"]))

    return devices


def cleanup_duplicate_units(devices, units):
    """Drop grid units that overlap a device but weren't picked by any
    device in the top-N pass. These are the half-height duplicates that
    the YOLO grid over-detected — keeping them around would show as
    phantom "Empty" rows in the unit report.

    Truly empty units (no overlap with any device) are preserved — they
    represent real rack gaps.
    """
    if not units or not devices:
        return units

    claimed = set()
    for dev in devices:
        claimed.update(dev.get("units", []))

    kept = []
    for unit in units:
        if unit["label"] in claimed:
            kept.append(unit)
            continue
        overlaps_a_device = any(
            _intersection_area(unit["box"], d["box"]) > 0 for d in devices
        )
        if overlaps_a_device:
            # Orphan duplicate — a device covers this region but chose a
            # different grid unit for it. Drop.
            continue
        kept.append(unit)

    # Re-label u01..uNN after removal and patch device.units to match.
    label_map = {}
    for i, unit in enumerate(sorted(kept, key=lambda u: u["box"][1]), start=1):
        old = unit["label"]
        new = f"u{i:02d}"
        label_map[old] = new
        unit["label"] = new

    for dev in devices:
        dev["units"] = [label_map[u] for u in dev.get("units", []) if u in label_map]
        dev["units"] = sorted(set(dev["units"]))

    return sorted(kept, key=lambda u: u["box"][1])


# Classes the model treats as real rack equipment. Used to anchor the unit
# grid — so a rack rail / frame / nameplate misclassified as "Closed Unit"
# at the very top or bottom doesn't pull the grid into the ceiling / floor.
_REAL_EQUIP_CLASSES = {
    "Switch", "Patch Panel", "Firewall", "Gateway",
    "Server", "Router", "UPS", "PDU", "PSU",
    "Storage Unit", "Load Balancer", "Modem",
    "Controller", "Recorder", "Amplifier",
}


def build_contiguous_unit_grid(devices, unit_h, rack_bounds=None, img_shape=None):
    """Build a strictly uniform, contiguous unit grid anchored to detected
    equipment, extended to cover any visible rack space the detector
    missed. Physical-rack rules enforced:

      - Every unit is EXACTLY `unit_h` tall.
      - Units are back-to-back, no gaps between them.
      - Anchors start at the topmost / bottommost REAL-equipment device
        (Switch, Patch Panel, Server, UPS, PDU, ...), so a rack rail
        misclassified as 'Closed Unit' doesn't pull the grid off.
      - If Hough-detected rack bounds extend ≥ 0.6 × unit_h above the top
        anchor (or below the bottom anchor), add that many extra rows —
        those are almost certainly undetected chassis, not rack frame.
      - Labels follow standard rack convention: **u01 at the BOTTOM**,
        increasing upward (u01, u02, ... uNN).
    """
    if not devices or not unit_h or unit_h <= 0:
        return []

    sorted_devs = sorted(devices, key=lambda d: d["box"][1])

    # Top anchor: topmost REAL device.
    grid_top = None
    for d in sorted_devs:
        if d["class_name"] in _REAL_EQUIP_CLASSES:
            grid_top = int(d["box"][1])
            break
    if grid_top is None:
        grid_top = int(sorted_devs[0]["box"][1])

    # Bottom anchor: bottommost REAL device.
    grid_bot = None
    for d in reversed(sorted_devs):
        if d["class_name"] in _REAL_EQUIP_CLASSES:
            grid_bot = int(d["box"][3])
            break
    if grid_bot is None:
        grid_bot = int(max(d["box"][3] for d in sorted_devs))

    # --- Extend grid to cover visible rack space the detector missed ---
    # Use Hough rack bounds (or a margined full-image fallback) to probe
    # how much rack sits above/below the detected-equipment span. Anything
    # ≥ 0.6 * unit_h above or below is almost certainly an undetected
    # device. Smaller slivers are frame/rail and are ignored.
    if rack_bounds is not None:
        rack_top_y = int(rack_bounds[1])
        rack_bot_y = int(rack_bounds[3])
    elif img_shape is not None:
        img_h_px = int(img_shape[0])
        # 2% margin keeps the grid from running into black borders when
        # Hough didn't give us a rack outline.
        margin = max(5, int(img_h_px * 0.02))
        rack_top_y = margin
        rack_bot_y = img_h_px - margin
    else:
        rack_top_y, rack_bot_y = 0, 10_000

    # If Hough just handed back the full image as a fallback, swap in a
    # small margin so we don't tile into image-edge black bars.
    if img_shape is not None:
        img_h_px = int(img_shape[0])
        if rack_top_y <= 2 and rack_bot_y >= img_h_px - 2:
            margin = max(5, int(img_h_px * 0.02))
            rack_top_y = margin
            rack_bot_y = img_h_px - margin

    space_above = grid_top - rack_top_y
    if space_above >= 0.6 * unit_h:
        extra_rows = max(1, int(round(space_above / unit_h)))
        grid_top = max(rack_top_y, grid_top - extra_rows * unit_h)

    space_below = rack_bot_y - grid_bot
    if space_below >= 0.6 * unit_h:
        extra_rows = max(1, int(round(space_below / unit_h)))
        grid_bot = min(rack_bot_y, grid_bot + extra_rows * unit_h)

    if rack_bounds is not None:
        left_x = int(rack_bounds[0])
        right_x = int(rack_bounds[2])
    elif img_shape is not None:
        left_x, right_x = 0, int(img_shape[1]) - 1
    else:
        left_x, right_x = 0, 1000

    span_px = max(0, grid_bot - grid_top)
    raw_count = span_px / unit_h if unit_h > 0 else 0
    count = int(raw_count)
    # Only round up when the leftover is clearly its own row (≥ 80% of unit_h).
    if raw_count - count >= 0.8:
        count += 1
    count = max(1, count)

    # Number from the BOTTOM (standard rack convention: U1 = bottom, UN = top).
    # Iterate top-to-bottom in pixel space, but label so the bottom row is u01.
    units = []
    for i in range(count):
        y_top = grid_top + i * unit_h
        y_bot = y_top + unit_h
        label_num = count - i                    # top row = count, bottom = 1
        units.append({
            "label": f"u{label_num:02d}",
            "box": [left_x, int(y_top), right_x, int(y_bot)],
            "center": [(left_x + right_x) // 2, int((y_top + y_bot) / 2)],
            "center_y": float((y_top + y_bot) / 2),
        })
    return units


def fill_unit_grid_gaps(units, unit_h, img_w, img_h, rack_bounds=None):
    """Extend the YOLO unit grid by tiling any uncovered y-range with
    `unit_h`-tall synthetic unit boxes. Ensures the grid spans the full
    rack (or full image, when Hough detection failed) even in regions
    where the YOLO unit model missed slots — so areas with undetected
    devices (top UPS, bottom PDU, etc.) still get a row in the grid.

    Does NOT relabel; caller should reapply u01..uNN after this runs.
    """
    if not unit_h or unit_h <= 0:
        return units

    if rack_bounds is not None:
        left_x, top_y, right_x, bot_y = rack_bounds
    else:
        left_x, right_x = 0, img_w - 1
        top_y, bot_y = 0, img_h

    sorted_u = sorted(units or [], key=lambda u: u["box"][1])
    filled = list(sorted_u)

    def push_fill(y_from, y_to):
        h = y_to - y_from
        if h <= 0:
            return
        n = int(round(h / unit_h))
        # A gap at least half a unit tall gets at least one row.
        if n == 0 and h >= 0.5 * unit_h:
            n = 1
        if n <= 0:
            return
        step = h / n
        for i in range(n):
            y1 = int(round(y_from + i * step))
            y2 = int(round(y_from + (i + 1) * step))
            filled.append({
                "box": [int(left_x), y1, int(right_x), y2],
                "center": [int((left_x + right_x) // 2), (y1 + y2) // 2],
                "center_y": float((y1 + y2) / 2),
                "source": "synthetic_fill",
            })

    cursor = top_y
    for u in sorted_u:
        push_fill(cursor, u["box"][1])
        cursor = max(cursor, u["box"][3])
    push_fill(cursor, bot_y)

    return sorted(filled, key=lambda u: u["box"][1])


def ensure_every_unit_has_device(devices, units):
    """Guarantee every grid unit has a device entry. For any unit that no
    real detection claims — even after the low-confidence retry pass —
    synthesize an 'Unidentified' placeholder. We deliberately don't call
    these 'Empty' because a rack row almost always contains *something*;
    'Empty' would be a false certainty.

    Returns the (possibly extended) devices list, sorted top-to-bottom."""
    if not units:
        return devices

    claimed = set()
    for dev in devices:
        claimed.update(dev.get("units", []))

    synthetic = []
    for unit in units:
        if unit["label"] in claimed:
            continue
        x1, y1, x2, y2 = unit["box"]
        synthetic.append({
            "class_id": -1,
            "class_name": "Unidentified",
            "confidence": 0.0,
            "box": [int(x1), int(y1), int(x2), int(y2)],
            "center": [int((x1 + x2) // 2), int((y1 + y2) // 2)],
            "units": [unit["label"]],
            "port_count": 0,
            "ports": [],
            "console_ports": [],
            "sfp_ports": [],
            "connected_ports": [],
            "source": "synthetic_unidentified",
        })

    out = devices + synthetic
    out.sort(key=lambda d: d["box"][1])
    return out


def build_device_mapping(devices):
    mapping = {}
    for device in devices:
        for unit_label in device.get("units", []):
            mapping.setdefault(device["class_name"], set()).add(unit_label)
    return {name: sorted(list(units)) for name, units in mapping.items()}

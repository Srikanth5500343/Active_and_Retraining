"""YOLO-based three-stage pipeline.

Replaces the earlier OCR heuristic with the user's production CV stack:

  STAGE 1 — Device + Unit detection   (full.py)
            * best 33.pt  → Server class
            * best 32.pt  → every other class (Switch, Patch Panel, UPS, ...)
            * unit.pt     → 1U rack-slot grid
  STAGE 2 — Pick the target device that matches the ticket
  STAGE 3 — Port detection + classification   (port.py + port_pattern.py)
            * port_count.pt → main / SFP / console ports
            * highlights the specific port number called out in the ticket

Models are loaded once at import / first call and cached.  Subsequent
requests reuse the in-memory weights.
"""
import base64
import io
import os
import re
import time

import cv2
import numpy as np
from PIL import Image

import full
import port
import port_pattern


# ---------- Model paths (overridable via env) ----------
MODEL_DEVICE_SERVER  = os.environ.get("MODEL_DEVICE_SERVER",  os.path.join("Models", "device_server.pt"))
MODEL_DEVICE_GENERAL = os.environ.get("MODEL_DEVICE_GENERAL", os.path.join("Models", "device_general.pt"))
MODEL_UNIT           = os.environ.get("MODEL_UNIT",           os.path.join("Models", "unit.pt"))
MODEL_PORT           = os.environ.get("MODEL_PORT",           os.path.join("Models", "port_count.pt"))

_loaded = {}

def _models():
    """Lazy load on first use. Cached in _loaded."""
    if not _loaded:
        print("Loading YOLO models (one-time)...", flush=True)
        _loaded["server"]  = full.load_model(MODEL_DEVICE_SERVER)
        _loaded["general"] = full.load_model(MODEL_DEVICE_GENERAL)
        _loaded["port"]    = port.load_port_model(MODEL_PORT)
        _loaded["unit_path"] = MODEL_UNIT
        print("YOLO models ready.", flush=True)
    return _loaded


# ---------- Image prep ----------

MAX_WIDTH = 1600

def _load_bgr(image_bytes):
    pil = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    if pil.width > MAX_WIDTH:
        ratio = MAX_WIDTH / pil.width
        pil = pil.resize((MAX_WIDTH, int(pil.height * ratio)))
    return cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR)


# ---------- Ticket → expected device class ----------

# Maps clues in the ticket (model name, hostname prefix) to detector classes.
_HOSTNAME_PREFIX_TO_CLASS = {
    "SW":   "Switch",
    "FW":   "Firewall",
    "RTR":  "Router",
    "RT":   "Router",
    "GW":   "Gateway",
    "PP":   "Patch Panel",
    "UPS":  "UPS",
    "PDU":  "PDU",
    "SRV":  "Server",
}

def _expected_class(expected):
    """Infer the device class the ticket is about."""
    model = (expected.get("model") or "").lower()
    if "catalyst" in model or "switch" in model:
        return "Switch"
    if "patch" in model or "panel" in model:
        return "Patch Panel"
    if "firewall" in model:
        return "Firewall"
    if "router" in model:
        return "Router"
    if "ups" in model:
        return "UPS"

    device = (expected.get("device") or "").upper()
    for prefix, cls in _HOSTNAME_PREFIX_TO_CLASS.items():
        if device.startswith(prefix):
            return cls

    return "Switch"   # network-ticket default


def _extract_unit_number(expected):
    """Extract the rack-unit number from the ticket.

    Sources (in priority order):
      1. ``u_position`` field  (e.g. "10")
      2. unit embedded in the device name  (e.g. "SW-U10" → 10)

    Returns an int or None.
    """
    # 1. Explicit u_position field
    u_pos = expected.get("u_position")
    if u_pos is not None:
        try:
            return int(u_pos)
        except (ValueError, TypeError):
            pass

    # 2. Parse from device name  (patterns like SW-U10, RTR-U3, FW-U22)
    device = expected.get("device") or ""
    m = re.search(r"[_\-]U(\d+)", device, re.IGNORECASE)
    if m:
        return int(m.group(1))

    return None


def _pick_target_device(devices, target_class, target_unit=None):
    """Pick the device that best matches the ticket's expected class and unit.

    When *target_unit* is provided (e.g. 10 for U10), prefer the device whose
    assigned ``units`` list contains that slot.  Falls back to the largest
    device of the target class when no unit match exists.
    """
    matches = [d for d in devices if d.get("class_name") == target_class]
    if not matches:
        return None

    # If a unit number was given, try to narrow to devices at that unit
    if target_unit is not None:
        target_label = f"U{target_unit}"
        unit_matches = [d for d in matches if target_label in d.get("units", [])]
        if unit_matches:
            return max(unit_matches, key=lambda d: (d["box"][2] - d["box"][0]) * (d["box"][3] - d["box"][1]))

    # Fallback: largest device of the target class
    return max(matches, key=lambda d: (d["box"][2] - d["box"][0]) * (d["box"][3] - d["box"][1]))


# ---------- Stage 1: devices + units ----------

def stage_1_devices(bgr_image):
    m = _models()
    devices = full.detect_devices_dual(bgr_image, m["server"], m["general"])
    devices = full.remove_overlapping_devices(devices)

    # Unit grid is best-effort — many close-up faceplate shots have no visible
    # rack structure, in which case the unit model returns nothing.  That's OK.
    units = []
    try:
        units = full.build_unit_grid(bgr_image, m["unit_path"])
        if units:
            units = full.normalize_units(units, bgr_image)
            devices = full.assign_devices_to_units(devices, units)
            units = full.cleanup_duplicate_units(devices, units)
    except Exception as e:
        print(f"[warn] unit grid failed (non-fatal): {e}", flush=True)
        units = []

    return devices, units


# ---------- Stage 3: ports on a single device ----------

def stage_3_ports(bgr_image, target_device):
    """Crop to the target device, run port detection, shift boxes back to
    full-image coordinates so the final annotation lines up.
    """
    if target_device is None:
        return {"console_ports": [], "main_ports": [], "sfp_ports": [], "all_boxes": []}

    x1, y1, x2, y2 = target_device["box"]
    crop = bgr_image[y1:y2, x1:x2]
    if crop.size == 0:
        return {"console_ports": [], "main_ports": [], "sfp_ports": [], "all_boxes": []}

    classified = port.detect_and_classify_ports(crop, _models()["port"])

    # Translate all port boxes/centers back into the full image's coordinate space.
    for key in ("console_ports", "main_ports", "sfp_ports"):
        for p in classified.get(key, []):
            bx1, by1, bx2, by2 = p["box"]
            p["box"]    = [bx1 + x1, by1 + y1, bx2 + x1, by2 + y1]
            p["center"] = [p["center"][0] + x1, p["center"][1] + y1]
    classified["all_boxes"] = [
        (b[0] + x1, b[1] + y1, b[2] + x1, b[3] + y1) for b in classified.get("all_boxes", [])
    ]
    return classified


# ---------- Annotation ----------

# BGR colors
DEVICE_COLORS = {
    "Switch":       (255, 120,   0),   # blue
    "Patch Panel":  (255, 200,   0),   # cyan-blue
    "Server":       ( 60, 180,  60),   # green
    "Storage Unit": ( 60, 180, 120),   # teal-green
    "UPS":          (  0, 165, 255),   # orange
    "PDU":          (  0, 100, 255),   # deep orange
    "Firewall":     (180,   0, 180),   # purple
    "Router":       (180, 130,   0),   # teal
    "Gateway":      (180,  90,   0),   # dark teal
    "PSU":          (100, 100, 255),   # pink
    "Empty":        (130, 130, 130),   # gray
    "Closed Unit":  (100, 100, 100),   # dark gray
}
DEFAULT_DEVICE_COLOR = (180, 180, 180)
COLOR_UNIT          = (  0, 220, 220)   # yellow
COLOR_TARGET_DEV    = (200,   0, 200)   # bright magenta
COLOR_PORT_MAIN     = (  0,   0, 220)   # red
COLOR_PORT_SFP      = (  0, 220, 220)   # yellow
COLOR_PORT_CONSOLE  = (220, 220,   0)   # cyan
COLOR_TARGET_PORT   = (  0, 220,   0)   # bright green


def _label(img, text, x, y, color, scale=0.55, thickness=2):
    (tw, th), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, scale, thickness)
    ty = max(th + 4, y - 4)
    cv2.rectangle(img, (x, ty - th - 6), (x + tw + 8, ty + 2), color, -1)
    cv2.putText(img, text, (x + 4, ty - 3),
                cv2.FONT_HERSHEY_SIMPLEX, scale, (255, 255, 255), thickness)


def annotate(bgr_image, devices, units, target_device, ports, target_port):
    img = bgr_image.copy()

    # --- Unit grid (yellow strip on the left, thin lines spanning right) ---
    for u in units or []:
        x1, y1, x2, y2 = u["box"]
        # left strip only — keeps the rest of the image uncluttered
        strip_w = 90
        sx2 = x1 + min(strip_w, x2 - x1)
        cv2.rectangle(img, (x1, y1), (sx2, y2), COLOR_UNIT, 1)
        cv2.putText(img, u.get("label", ""), (x1 + 4, y1 + 18),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, COLOR_UNIT, 1)

    # --- Devices (one color per class) ---
    for d in devices:
        x1, y1, x2, y2 = d["box"]
        cls = d.get("class_name", "?")
        color = DEVICE_COLORS.get(cls, DEFAULT_DEVICE_COLOR)
        cv2.rectangle(img, (x1, y1), (x2, y2), color, 2)
        units_str = "/".join(d.get("units", [])) if d.get("units") else ""
        label_txt = f"{cls}" + (f" [{units_str}]" if units_str else "")
        _label(img, label_txt, x1, y1, color, scale=0.5, thickness=1)

    # --- Ports inside the target device ---
    for p in ports.get("console_ports", []):
        x1, y1, x2, y2 = p["box"]
        cv2.rectangle(img, (x1, y1), (x2, y2), COLOR_PORT_CONSOLE, 1)
    for p in ports.get("sfp_ports", []):
        x1, y1, x2, y2 = p["box"]
        cv2.rectangle(img, (x1, y1), (x2, y2), COLOR_PORT_SFP, 1)
    for p in ports.get("main_ports", []):
        x1, y1, x2, y2 = p["box"]
        cv2.rectangle(img, (x1, y1), (x2, y2), COLOR_PORT_MAIN, 1)
        idx = p.get("index")
        if idx is not None:
            cv2.putText(img, str(idx), (x1 + 1, y1 - 2),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.35, (255, 255, 255), 1)

    # --- Target device outline (over everything) ---
    if target_device is not None:
        x1, y1, x2, y2 = target_device["box"]
        cv2.rectangle(img, (x1, y1), (x2, y2), COLOR_TARGET_DEV, 4)
        _label(img, f"TARGET: {target_device['class_name']}", x1, y1, COLOR_TARGET_DEV,
               scale=0.65, thickness=2)

    # --- Target port (last, brightest) ---
    if target_port is not None:
        x1, y1, x2, y2 = target_port["box"]
        # Halo
        pad = 6
        cv2.rectangle(img, (x1 - pad, y1 - pad), (x2 + pad, y2 + pad), COLOR_TARGET_PORT, 3)
        cx, cy = target_port["center"]
        cv2.circle(img, (cx, cy), max(10, (x2 - x1) // 2 + 4), COLOR_TARGET_PORT, 3)
        _label(img, f"PORT {target_port['index']} [{target_port.get('status','unknown')}]",
               x1 - pad, y1 - pad, COLOR_TARGET_PORT, scale=0.6, thickness=2)

    return img


def _encode_b64(bgr_image, quality=82):
    ok, buf = cv2.imencode(".jpg", bgr_image, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
    return base64.b64encode(buf.tobytes()).decode("ascii") if ok else None


# ---------- Orchestrator ----------

def run_pipeline(image_bytes, expected):
    """Run all three stages. Returns the dict the Flask app will jsonify."""
    timings = {}

    # 0. Load image
    t0 = time.time()
    bgr = _load_bgr(image_bytes)
    timings["preprocess_ms"] = int((time.time() - t0) * 1000)

    # 1. Devices + units
    t0 = time.time()
    devices, units = stage_1_devices(bgr)
    timings["stage_1_ms"] = int((time.time() - t0) * 1000)

    # 2. Pick target device (by class + unit number when available)
    t0 = time.time()
    target_class  = _expected_class(expected)
    target_unit   = _extract_unit_number(expected)
    target_device = _pick_target_device(devices, target_class, target_unit)
    timings["stage_2_ms"] = int((time.time() - t0) * 1000)

    # 3. Ports on the target device
    t0 = time.time()
    classified = stage_3_ports(bgr, target_device)
    target_port_num = expected.get("port")
    try:
        target_port_num = int(target_port_num)
    except (TypeError, ValueError):
        target_port_num = None
    target_port = None
    if target_port_num is not None:
        target_port = next(
            (p for p in classified.get("main_ports", []) if p.get("index") == target_port_num),
            None,
        )
    timings["stage_3_ms"] = int((time.time() - t0) * 1000)

    # 4. Annotate
    t0 = time.time()
    annotated = annotate(bgr, devices, units, target_device, classified, target_port)
    annotated_b64 = _encode_b64(annotated)
    timings["annotate_ms"] = int((time.time() - t0) * 1000)

    # ---------- Build response (UI cards) ----------
    device_counts = {}
    for d in devices:
        device_counts[d["class_name"]] = device_counts.get(d["class_name"], 0) + 1

    n_main    = len(classified.get("main_ports", []))
    n_sfp     = len(classified.get("sfp_ports", []))
    n_console = len(classified.get("console_ports", []))

    # Verdict logic
    expected_status_raw = (expected.get("port_status") or "").lower()
    expected_down = "down" in expected_status_raw or "disconnect" in expected_status_raw
    actual_status = (target_port or {}).get("status", "unknown")
    verdict = "inconclusive"
    if target_port is not None and actual_status != "unknown":
        if expected_down and actual_status == "empty":
            verdict = "matches_report"
        elif expected_down and actual_status == "connected":
            verdict = "contradicts_report"
        elif not expected_down and actual_status == "connected":
            verdict = "matches_report"

    unit_info = f" at U{target_unit}" if target_unit else ""
    s1 = {
        "devices_detected_count": len(devices),
        "device_class_counts":    device_counts,
        "target_class_expected":  target_class,
        "target_unit_expected":   f"U{target_unit}" if target_unit else None,
        "target_device_found":    target_device is not None,
        "target_device_confidence": (target_device or {}).get("confidence"),
        "target_device_units":   (target_device or {}).get("units", []),
        "match_confidence": (
            "high" if target_device and target_device.get("confidence", 0) >= 0.6 else
            "medium" if target_device else "none"
        ),
        "reasoning": (
            f"Detected {len(devices)} device(s); looking for {target_class}{unit_info}: "
            + (f"found 1 at {target_device['box']} (units: {target_device.get('units', [])})"
               if target_device else "none found.")
        ),
    }
    s2 = {
        "port_grid_visible":       n_main > 0,
        "main_port_count":         n_main,
        "sfp_port_count":          n_sfp,
        "console_port_count":      n_console,
        "units_in_rack":           len(units),
        "target_port_requested":   target_port_num,
        "target_port_in_grid":     target_port is not None,
        "reasoning": (
            f"Detected {n_main} main, {n_sfp} SFP, {n_console} console port(s). "
            f"Unit grid: {len(units)} slot(s)."
        ),
    }
    s3 = {
        "target_port_visible": target_port is not None,
        "target_port":         (
            {k: target_port[k] for k in ("index", "status", "class_name", "confidence")}
            if target_port else None
        ),
        "verdict":             verdict,
        "expected_status":     expected_status_raw or None,
        "reasoning": (
            f"Port {target_port_num} → {actual_status}; expected "
            + ("down/disconnected" if expected_down else "up/connected")
            + "." if target_port is not None
            else f"Port {target_port_num} not located on detected device."
        ),
    }

    return {
        "device_identification": s1,
        "port_grid_detection":   s2,
        "target_port_analysis":  s3,
        "timings_ms":            timings,
        "annotated_image_b64":   annotated_b64,
    }

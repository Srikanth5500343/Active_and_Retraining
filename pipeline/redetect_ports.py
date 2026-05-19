"""
Re-run port detection for an existing scan without re-running device
detection — useful after the port-detection pipeline has been improved
and we want existing scans to reflect the new counts without redoing
the whole capture.

For each device in <rackId>/device_unit_map.json:
  - Re-run classify_ports_by_pattern (switches/firewalls/gateways) or
    detect_patch_panel_ports (patch panels) on the saved device crop.
  - Optionally ground the count via OCR (device_db) when available.
  - Replace port_count, ports, connected_ports, sfp_ports.

Then update outputs/<rackId>/scan_result.json so the UI picks up the
new counts on next read, and regenerate topology.json so the 3D view
stays in sync.

Usage:
    python -m pipeline.redetect_ports --rack-id RK-XXXXX
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

import cv2

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from pipeline.port import load_port_model
from pipeline.port_pattern import classify_ports_by_pattern, detect_patch_panel_ports

try:
    from pipeline.device_db import read_device_model
except Exception:  # pragma: no cover
    read_device_model = lambda *a, **k: (None, None, None)

OUTPUTS_BASE = ROOT / "outputs"
PORT_BEARING_CLASSES = {"Switch", "Patch Panel", "Firewall", "Gateway"}
PATCH_CLASSES        = {"Patch Panel"}


def _load_config() -> dict:
    cfg_path = ROOT / "config.json"
    if not cfg_path.exists():
        return {"models": {"port_count": "Models/port_best.pt",
                           "port_patch_panel": "Models/port_count.pt"},
                "detection": {"ports_conf": 0.23}}
    with open(cfg_path, "r", encoding="utf-8") as f:
        return json.load(f)


def _detect_for_class(crop, main_model, pp_model, class_name: str, conf: float) -> dict:
    if class_name in PATCH_CLASSES:
        return detect_patch_panel_ports(crop, pp_model, conf=conf)
    return classify_ports_by_pattern(crop, main_model, conf=conf,
                                     status_model=pp_model)


def _safe_crop(img, box):
    if box is None or len(box) != 4:
        return None
    x1, y1, x2, y2 = (int(v) for v in box)
    h, w = img.shape[:2]
    x1 = max(0, min(w - 1, x1)); y1 = max(0, min(h - 1, y1))
    x2 = max(0, min(w,     x2)); y2 = max(0, min(h,     y2))
    if x2 <= x1 or y2 <= y1:
        return None
    return img[y1:y2, x1:x2]


def _atomic_write_json(path: Path, payload: dict) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
    os.replace(tmp, path)


def _u_from_units(units: list[str]) -> int | None:
    for u_str in units or []:
        m = re.match(r"u0*(\d+)", str(u_str).lower())
        if m:
            return int(m.group(1))
    return None


def redetect(rack_id: str) -> int:
    rack_dir = OUTPUTS_BASE / rack_id
    img_path = rack_dir / "original_image.jpg"
    map_path = rack_dir / "device_unit_map.json"
    scan_path = rack_dir / "scan_result.json"

    if not img_path.exists():
        # Try other extensions
        for ext in (".jpeg", ".png"):
            alt = rack_dir / f"original_image{ext}"
            if alt.exists():
                img_path = alt
                break
        else:
            print(f"ERROR: no original_image at {rack_dir}", file=sys.stderr)
            return 1
    if not map_path.exists():
        print(f"ERROR: no device_unit_map.json at {rack_dir}", file=sys.stderr)
        return 1

    img = cv2.imread(str(img_path))
    if img is None:
        print(f"ERROR: cv2.imread returned None for {img_path}", file=sys.stderr)
        return 1

    cfg = _load_config()
    model_path = ROOT / cfg["models"]["port_count"]
    pp_model_rel = cfg["models"].get("port_patch_panel")
    pp_model_path = (ROOT / pp_model_rel) if pp_model_rel else model_path
    conf = float(cfg.get("detection", {}).get("ports_conf", 0.23))
    model = load_port_model(str(model_path))
    pp_model = load_port_model(str(pp_model_path)) if str(pp_model_path) != str(model_path) else model

    with open(map_path, "r", encoding="utf-8") as f:
        m = json.load(f)

    devices = m.get("devices") or []
    print(f"[redetect] rack={rack_id}  devices={len(devices)}  conf={conf}")
    print(f"{'#':>3} {'pos':<6} {'class':<14} {'old':>4} {'new':>4} {'sfp':>4}  ocr")
    print("-" * 70)

    for i, dev in enumerate(devices, 1):
        cls = dev.get("class_name") or ""
        if cls not in PORT_BEARING_CLASSES:
            continue
        crop = _safe_crop(img, dev.get("box"))
        if crop is None:
            continue
        try:
            classified = _detect_for_class(crop, model, pp_model, cls, conf)
        except Exception as e:
            print(f"{i:>3}  detect failed: {e}")
            continue

        main_ports    = classified.get("main_ports")    or []
        sfp_ports     = classified.get("sfp_ports")     or []
        console_ports = classified.get("console_ports") or []

        old_pc = dev.get("port_count")
        new_pc = len(main_ports)

        # OCR grounding (no-op if backend unavailable)
        ocr_label = ""
        try:
            ocr_name, ocr_total, ocr_sfp = read_device_model(crop)
        except Exception:
            ocr_name = ocr_total = ocr_sfp = None
        if ocr_name and ocr_total:
            expected_main = max(0, int(ocr_total) - int(ocr_sfp or 0))
            if new_pc < expected_main * 0.75:
                ocr_label = f"{ocr_name} → {expected_main}"
                new_pc = expected_main
                dev["port_count_source"] = f"ocr:{ocr_name}"
            else:
                ocr_label = ocr_name
            dev["ocr_model"] = ocr_name
            dev["ocr_expected_ports"] = expected_main
            dev["ocr_expected_sfp"] = int(ocr_sfp or 0)

        dev["port_count"]      = new_pc
        dev["ports"]           = main_ports
        dev["sfp_ports"]       = sfp_ports
        dev["console_ports"]   = console_ports
        dev["connected_ports"] = [p for p in main_ports if p.get("status") == "connected"]

        u = _u_from_units(dev.get("units") or [])
        u_str = f"U{u:02d}" if u is not None else "?"
        print(f"{i:>3} {u_str:<6} {cls:<14} {old_pc!s:>4} {new_pc:>4} {len(sfp_ports):>4}  {ocr_label}")

    _atomic_write_json(map_path, m)

    # ── Update scan_result.json (just the per-device counts) ─────────────
    if scan_path.exists():
        with open(scan_path, "r", encoding="utf-8") as f:
            scan = json.load(f)
        # The scan_result schema stores integer counts per device. Walk the
        # devices in parallel by index when possible — they're built from
        # the same device_unit_map ordering by app.js.
        scan_devices = scan.get("devices") or []
        if len(scan_devices) == len(devices):
            for sd, md in zip(scan_devices, devices):
                if md.get("class_name") in PORT_BEARING_CLASSES:
                    sd["port_count"]      = int(md.get("port_count") or 0)
                    sd["sfp_ports"]       = len(md.get("sfp_ports") or [])
                    sd["console_ports"]   = len(md.get("console_ports") or [])
                    sd["connected_ports"] = len(md.get("connected_ports") or [])
                    if "ocr_model" in md:
                        sd["ocr_model"] = md["ocr_model"]
                        sd["ocr_expected_ports"] = md.get("ocr_expected_ports")
            _atomic_write_json(scan_path, scan)
            print(f"[redetect] updated {scan_path}")
        else:
            print(f"[redetect] WARNING: scan_result.json has {len(scan_devices)} devices "
                  f"but device_unit_map.json has {len(devices)}; left scan_result.json untouched")

    print(f"[redetect] updated {map_path}")
    print(f"[redetect] tip: re-run topology_generate.py to refresh the 3D view")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--rack-id", required=True, help="Rack ID, e.g. RK-B9E33E5A")
    args = p.parse_args()
    return redetect(args.rack_id)


if __name__ == "__main__":
    sys.exit(main())

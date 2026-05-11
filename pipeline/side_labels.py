"""
side_labels.py — extract device-identifier labels from rack-side strips.

Targeted complement to ocr_devices.py: instead of OCR'ing each detected
device's chassis crop (which fails when CV missed the device entirely),
this pass crops the LEFT and RIGHT margins of the rack image and looks
for identifier-shaped text — the "SWHOME / SWFIBRA1 / DB-PROD-04" chips
that techs stick on the rails. These are the highest-truth signal in
the photo because they're high-contrast, fixed-position, and one per
device.

Output is sorted top-to-bottom and includes a Y-position so the caller
can match each label to a CV-detected device band (or notice that the
label has no matching device — the recall gap we want to surface).

Usage:
    python -m pipeline.side_labels <rack_id>
    python -m pipeline.side_labels <rack_id> --json

Reads the rack image from outputs/<rackId>/original_image.{jpg,jpeg,png}
(same convention as ocr_devices.py). Writes side_labels.json to the
same folder when run without --json.

Output schema:
{
  "rack_id": "RK-...",
  "image_size": { "w": 1920, "h": 2400 },
  "labels": [
    { "text": "SWHOME",   "yPct": 14.6, "side": "right", "conf": 0.92 },
    { "text": "SWGEST1",  "yPct": 32.1, "side": "right", "conf": 0.88 },
    ...
  ],
  "summary": { "count": 5, "rightCount": 5, "leftCount": 0 }
}
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


OUTPUTS_DIR = ROOT / "outputs"

# How wide a strip to OCR on each side, as a fraction of image width.
# 12% covers most rack-rail label widths even on wider photos. Going
# narrower misses labels that wrap; wider invites chassis-edge noise.
SIDE_FRACTION = 0.12

# Identifier-shaped text we keep. Examples that match:
#   SWHOME, SWFIBRA1, SW-CORE-01, RACK1, DB-PROD-04, AP-WL3, FW01
# Examples that DON'T match (deliberately filtered):
#   1, 24, JetLan, MikroTik, Cloud, "1Gbps", "12345"
IDENTIFIER_RE = re.compile(r"^[A-Z][A-Z0-9]{1,}[A-Z0-9\-_]{0,18}$")

# Common false positives we always reject even if they pattern-match:
# vendor names, generic hardware nouns, U-numbers, etc. Anything that
# could legitimately appear as a label is omitted from this list.
NEGATIVE_TERMS = {
    "MIKROTIK", "CISCO", "TPLINK", "DLINK", "JUNIPER", "ARUBA",
    "ARISTA", "HUAWEI", "DELL", "HPE", "NETGEAR", "UBIQUITI",
    "JETLAN", "GENERAL", "CABLE", "STARTECH", "CLOUD", "ROUTER",
    "SWITCH", "PORT", "PORTS", "SFP", "QSFP", "POE", "GIGABIT",
    "ACTLINK", "CONSOLE", "RESET", "MODE", "FAULT", "POWER",
    "USER", "USB", "MGMT", "PWR",
    # Common fascia model fragments (these aren't *identifiers*, they're
    # model numbers — handled by ocr_devices.py)
    "CRS", "CRS328", "CRS326", "CRS518",
}


def _normalize(s: str) -> str:
    return re.sub(r"[^A-Z0-9\-_]", "", (s or "").upper())


def _is_identifier(text: str) -> bool:
    norm = _normalize(text)
    if len(norm) < 3 or len(norm) > 20:
        return False
    if norm in NEGATIVE_TERMS:
        return False
    # Rack-section labels (RACK1, RACK2, RACK 3) — these identify rack
    # positions on the cabinet rail, not specific devices. They'd show up
    # as false-positive "unmatched" entries in the recall gap banner.
    if re.fullmatch(r"RACK\d{0,3}", norm):
        return False
    # U-position labels (U10, U37) — same story; rail measurements.
    if re.fullmatch(r"U\d{1,3}", norm):
        return False
    # Pure numbers, port labels
    if re.fullmatch(r"\d+", norm):
        return False
    if not IDENTIFIER_RE.fullmatch(norm):
        return False
    # Must contain at least one letter (already implied by IDENTIFIER_RE)
    # and not be 100% letters-only at very short length (e.g. "ON", "OK")
    if len(norm) <= 3 and not re.search(r"\d", norm):
        return False
    return True


def _ocr_strip(reader, img, x_start: int, x_end: int) -> list[dict]:
    """OCR a vertical slice of the image. Returns labels with image-space
    coordinates restored from the strip-relative coords easyocr emits."""
    import numpy as np
    if x_end <= x_start:
        return []
    strip = img[:, x_start:x_end]
    if strip.size == 0:
        return []
    results = reader.readtext(strip, detail=1, paragraph=False)
    out = []
    for (pts, text, conf) in results:
        text = (text or "").strip()
        if not text:
            continue
        ys = [p[1] for p in pts]
        xs = [p[0] for p in pts]
        y_mid = (min(ys) + max(ys)) / 2
        x_mid = (min(xs) + max(xs)) / 2 + x_start
        out.append({
            "text": text,
            "raw_conf": float(conf),
            "x_mid": float(x_mid),
            "y_mid": float(y_mid),
            "h": float(max(ys) - min(ys)),
        })
    return out


def extract_side_labels(image_path: str) -> dict:
    import cv2
    import easyocr

    img = cv2.imread(image_path)
    if img is None:
        raise FileNotFoundError(f"Could not read image: {image_path}")
    h_img, w_img = img.shape[:2]

    side_w = max(40, int(w_img * SIDE_FRACTION))
    reader = easyocr.Reader(["en"], gpu=False, verbose=False)

    right_raw = _ocr_strip(reader, img, w_img - side_w, w_img)
    left_raw  = _ocr_strip(reader, img, 0, side_w)

    labels = []
    for raw in right_raw:
        if _is_identifier(raw["text"]):
            labels.append({
                "text": _normalize(raw["text"]),
                "yPct": round(raw["y_mid"] / h_img * 100, 2),
                "y":    int(raw["y_mid"]),
                "side": "right",
                "conf": round(raw["raw_conf"], 3),
            })
    for raw in left_raw:
        if _is_identifier(raw["text"]):
            labels.append({
                "text": _normalize(raw["text"]),
                "yPct": round(raw["y_mid"] / h_img * 100, 2),
                "y":    int(raw["y_mid"]),
                "side": "left",
                "conf": round(raw["raw_conf"], 3),
            })

    # Dedupe — sometimes the same chip is read twice (slight bbox jitter).
    seen = set()
    deduped = []
    for l in sorted(labels, key=lambda x: x["yPct"]):
        key = (l["text"], round(l["yPct"]))
        if key in seen:
            continue
        seen.add(key)
        deduped.append(l)

    right_count = sum(1 for l in deduped if l["side"] == "right")
    left_count  = sum(1 for l in deduped if l["side"] == "left")

    return {
        "image_size": { "w": w_img, "h": h_img },
        "labels": deduped,
        "summary": {
            "count": len(deduped),
            "rightCount": right_count,
            "leftCount":  left_count,
        },
    }


def _resolve_image(rack_dir: Path) -> Path | None:
    for ext in ("jpg", "jpeg", "png"):
        p = rack_dir / f"original_image.{ext}"
        if p.exists():
            return p
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("rack_id")
    ap.add_argument("--json", action="store_true",
                    help="Emit single-line JSON on stdout instead of writing the cache file")
    args = ap.parse_args()

    rack_dir = OUTPUTS_DIR / args.rack_id
    if not rack_dir.exists():
        msg = { "ok": False, "error": f"rack {args.rack_id} not found",
                "rack_id": args.rack_id, "labels": [] }
        sys.stdout.write(json.dumps(msg))
        sys.exit(1)

    img_path = _resolve_image(rack_dir)
    if not img_path:
        msg = { "ok": False, "error": "no original_image found",
                "rack_id": args.rack_id, "labels": [] }
        sys.stdout.write(json.dumps(msg))
        sys.exit(1)

    try:
        result = extract_side_labels(str(img_path))
    except Exception as e:
        msg = { "ok": False, "error": str(e),
                "rack_id": args.rack_id, "labels": [] }
        sys.stdout.write(json.dumps(msg))
        sys.exit(1)

    payload = {
        "ok": True,
        "rack_id": args.rack_id,
        "generated_at": _dt.datetime.utcnow().replace(microsecond=0).isoformat() + "Z",
        **result,
    }

    if not args.json:
        out_path = rack_dir / "side_labels.json"
        out_path.write_text(json.dumps(payload, indent=2))

    sys.stdout.write(json.dumps(payload))
    sys.stdout.flush()


if __name__ == "__main__":
    main()

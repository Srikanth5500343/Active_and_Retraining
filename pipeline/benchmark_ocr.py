"""
benchmark_ocr.py — run full-image OCR + the production make/model parser
on a folder of rack images, emit JSON results.

This bypasses CV detection (no device_unit_map.json needed) — it OCRs
each image whole and feeds the joined text into ocr_devices.parse_make_model
the same way the per-bbox pipeline does. Lets us evaluate "what does our
OCR pipeline see in this photo?" independent of whether YOLO detected
the chassis.

Usage:
    python -m pipeline.benchmark_ocr <folder>

Output (stdout, single JSON document):
    {
      "results": [
        { "image": "rack 71.jpg", "make": "Cisco", "model": "C9300-48P", "raw_excerpt": "..." },
        ...
      ]
    }
"""
from __future__ import annotations

import argparse
import json
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("folder")
    args = ap.parse_args()

    folder = Path(args.folder)
    if not folder.is_dir():
        sys.stdout.write(json.dumps({"error": f"not a folder: {folder}"}))
        sys.exit(1)

    # Lazy imports — easyocr is heavy.
    import cv2
    import easyocr
    from pipeline.ocr_devices import parse_make_model, parse_version, load_vendor_names

    vendors = load_vendor_names()
    reader = easyocr.Reader(["en"], gpu=False, verbose=False)

    results = []
    exts = (".jpg", ".jpeg", ".png", ".webp")
    images = sorted(p for p in folder.iterdir()
                    if p.is_file() and p.suffix.lower() in exts)

    for img_path in images:
        try:
            img = cv2.imread(str(img_path))
            if img is None:
                results.append({
                    "image": img_path.name,
                    "error": "could not read image",
                })
                continue

            ocr_results = reader.readtext(str(img_path), detail=1, paragraph=False)
            text_parts = []
            for (_pts, text, conf) in ocr_results:
                text = (text or "").strip()
                if len(text) < 2 or float(conf) < 0.20:
                    continue
                text_parts.append(text)
            joined = " ".join(text_parts)

            make, model = parse_make_model(joined, vendors)
            version = parse_version(joined)

            results.append({
                "image": img_path.name,
                "make": make,
                "model": model,
                "version": version,
                "raw_excerpt": joined[:300],
                "raw_length": len(joined),
                "ocr_phrase_count": len(text_parts),
            })
        except Exception as e:
            results.append({
                "image": img_path.name,
                "error": f"{type(e).__name__}: {e}",
            })

    sys.stdout.write(json.dumps({"results": results}, indent=2))
    sys.stdout.flush()


if __name__ == "__main__":
    main()

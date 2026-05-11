"""
benchmark_full.py — per-device CV + OCR benchmark on a folder of rack images.

Unlike benchmark_ocr.py (full-image OCR, one answer per image), this runs
the real production pipeline: CV device detection → per-bbox EasyOCR →
make/model parsing. Output is one row per *detected device*, so the score
reflects how well the pipeline does at the granularity that actually
matters for CMDB sync.

Per image:
  1. Copy image into outputs/_bench_<slug>/original_image.<ext>
  2. Spawn runner.py --detect_only to produce device_unit_map.json
  3. Run ocr_devices.py to produce ocr_devices.json (per-bbox parsed)
  4. Aggregate: count of devices, count with make, count with model

Output (stdout, single JSON document):
  {
    "totals": { "images":12, "devices":N, "with_make":M, "with_model":K },
    "per_image": [ ... ]
  }
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
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


def _slug_for_path(p: Path) -> str:
    return "".join(c if c.isalnum() else "_" for c in p.stem)


def _process_image(img_path: Path, py: str, project_root: Path) -> dict:
    rack_id = f"_bench_{_slug_for_path(img_path)}"
    rack_dir = project_root / "outputs" / rack_id
    if rack_dir.exists():
        shutil.rmtree(rack_dir, ignore_errors=True)
    rack_dir.mkdir(parents=True, exist_ok=True)

    # The pipeline expects original_image.<ext> next to its outputs.
    ext = img_path.suffix.lower().lstrip(".")
    if ext == "jpeg":
        ext = "jpg"
    if ext == "webp":
        # ocr_devices.py only resolves jpg/jpeg/png. Decode webp and re-save as png.
        try:
            import cv2
            img = cv2.imread(str(img_path))
            if img is None:
                raise RuntimeError("cv2 returned None")
            cv2.imwrite(str(rack_dir / "original_image.png"), img)
        except Exception as e:
            return {
                "image": img_path.name,
                "stage": "decode",
                "error": f"webp decode failed: {e}",
                "devices": [],
            }
    else:
        if ext not in ("jpg", "png"):
            ext = "jpg"
        shutil.copyfile(img_path, rack_dir / f"original_image.{ext}")

    # --- Stage 1: CV detection via runner.py --detect_only --------------
    detect_log_tail = ""
    try:
        proc = subprocess.run(
            [py, "-u", "-m", "pipeline.runner",
             "--image", str(rack_dir / f"original_image.{ext}"),
             "--output_dir", str(rack_dir),
             "--detect_only"],
            cwd=str(project_root),
            capture_output=True, text=True, timeout=300,
            env={"PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8",
                 **__import__("os").environ},
        )
        detect_log_tail = (proc.stderr or "")[-300:]
    except subprocess.TimeoutExpired:
        return {"image": img_path.name, "stage": "detect", "error": "CV detect timed out", "devices": []}
    except Exception as e:
        return {"image": img_path.name, "stage": "detect", "error": str(e), "devices": []}

    dum_path = rack_dir / "device_unit_map.json"
    if not dum_path.exists():
        return {"image": img_path.name, "stage": "detect",
                "error": f"no device_unit_map.json (rc={proc.returncode}); stderr_tail={detect_log_tail!r}",
                "devices": []}

    try:
        dum = json.loads(dum_path.read_text(encoding="utf-8"))
    except Exception as e:
        return {"image": img_path.name, "stage": "detect", "error": f"dum parse: {e}", "devices": []}

    cv_device_count = len(dum.get("devices", []))

    # --- Stage 2: per-bbox OCR via ocr_devices.py -----------------------
    try:
        proc = subprocess.run(
            [py, "-u", "-m", "pipeline.ocr_devices", rack_id, "--json"],
            cwd=str(project_root),
            capture_output=True, text=True, timeout=300,
            env={"PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8",
                 **__import__("os").environ},
        )
    except subprocess.TimeoutExpired:
        return {"image": img_path.name, "stage": "ocr", "error": "OCR timed out",
                "cv_device_count": cv_device_count, "devices": []}

    last_line = (proc.stdout.strip().split("\n") or [""])[-1]
    try:
        ocr_payload = json.loads(last_line) if last_line else {}
    except Exception:
        ocr_payload = {}

    devices = ocr_payload.get("devices", []) or []

    return {
        "image": img_path.name,
        "stage": "ok",
        "cv_device_count": cv_device_count,
        "ocr_device_count": len(devices),
        "devices": [
            {
                "position": d.get("position"),
                "class_name": d.get("class_name"),
                "make": d.get("make"),
                "model": d.get("model"),
                "version": d.get("version"),
                "raw_text": (d.get("raw_text") or "")[:160],
                "source": d.get("source"),
                "match_conf": d.get("match_conf"),
            }
            for d in devices
        ],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("folder")
    ap.add_argument("--out", help="Write JSON to this path instead of stdout")
    args = ap.parse_args()

    folder = Path(args.folder)
    if not folder.is_dir():
        sys.stdout.write(json.dumps({"error": f"not a folder: {folder}"}))
        sys.exit(1)

    py = sys.executable

    exts = (".jpg", ".jpeg", ".png", ".webp")
    images = sorted(p for p in folder.iterdir()
                    if p.is_file() and p.suffix.lower() in exts)

    per_image = []
    for img_path in images:
        sys.stderr.write(f"[bench] {img_path.name} ...\n")
        sys.stderr.flush()
        result = _process_image(img_path, py, ROOT)
        per_image.append(result)
        sys.stderr.write(f"[bench]    -> stage={result.get('stage')} "
                         f"cv={result.get('cv_device_count')} "
                         f"devs={len(result.get('devices', []))} "
                         f"makes={sum(1 for d in result.get('devices', []) if d.get('make'))} "
                         f"models={sum(1 for d in result.get('devices', []) if d.get('model'))}\n")
        sys.stderr.flush()

    totals = {
        "images": len(per_image),
        "cv_devices_total": sum(r.get("cv_device_count") or 0 for r in per_image),
        "ocr_devices_total": sum(len(r.get("devices", [])) for r in per_image),
        "with_make":  sum(1 for r in per_image for d in r.get("devices", []) if d.get("make")),
        "with_model": sum(1 for r in per_image for d in r.get("devices", []) if d.get("model")),
    }

    payload = json.dumps({"totals": totals, "per_image": per_image}, indent=2)
    if args.out:
        Path(args.out).write_text(payload, encoding="utf-8")
        sys.stderr.write(f"[bench] wrote {args.out}\n")
    sys.stdout.write(payload)
    sys.stdout.flush()


if __name__ == "__main__":
    main()

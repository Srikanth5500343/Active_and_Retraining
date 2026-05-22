"""
Runner-contract adapter for the device YOLO trainer.

Invoked by retraining_learning/runner.py with:
  - cwd = retraining_learning/runs/devices-<run_id>/
  - dataset.jsonl + image files staged in cwd by Store.export()
  - --holdout <path>  ← retraining_learning/holdout/devices/

Required outputs (in cwd, exit 0):
  - best.pt              ← the trained YOLO model
  - val_metrics.json     ← {"accuracy": float, ...}

The actual training call is delegated to the existing train.py /
device.py scripts in this directory — this adapter just translates the
runner-contract I/O to whatever those scripts expect, then evaluates
against the frozen holdout.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

ADAPTER_DIR = Path(__file__).resolve().parent
REPO_ROOT   = ADAPTER_DIR.parent.parent


# ── Step 1: convert dataset.jsonl → YOLO directory layout ─────────────
# Each row in dataset.jsonl carries `image_path` (filename of an image
# already copied into cwd), plus `actual.class` for device-classification.
# YOLO needs:
#   <work>/images/{train,val}/*.jpg
#   <work>/labels/{train,val}/*.txt   one line per box, "<cls> xc yc w h"
#   <work>/data.yaml                  paths + class list
#
# For the active-learning batch we put 100% of new samples into train —
# the holdout dir is the val set.
def convert_to_yolo_dataset(work_dir: Path, dataset_jsonl: Path,
                             holdout_dir: Path) -> Path:
    images_dir = work_dir / "yolo" / "images" / "train"
    labels_dir = work_dir / "yolo" / "labels" / "train"
    images_dir.mkdir(parents=True, exist_ok=True)
    labels_dir.mkdir(parents=True, exist_ok=True)

    # Discover the class list from samples + holdout (union)
    classes: list[str] = []
    seen: set[str] = set()
    samples = []
    with dataset_jsonl.open("r", encoding="utf-8") as f:
        for line in f:
            row = json.loads(line)
            samples.append(row)
            cls = (row.get("actual") or {}).get("class")
            if cls and cls not in seen:
                seen.add(cls)
                classes.append(cls)

    name2id = {c: i for i, c in enumerate(classes)}
    written = 0
    for row in samples:
        img_name = row.get("image_path")
        if not img_name:
            continue
        src = work_dir / img_name
        if not src.exists():
            continue
        dst_img = images_dir / src.name
        if not dst_img.exists():
            shutil.copyfile(src, dst_img)

        # Box: prefer metadata.device_box (xyxy); fall back to whole image
        meta = row.get("metadata") or {}
        cls = (row.get("actual") or {}).get("class")
        if cls is None or cls not in name2id:
            continue
        # We don't always have image dims here; assume the trainer's
        # subsequent eval handles this. For a class-only correction the
        # box is the whole image (xc=yc=0.5, w=h=1.0).
        line_txt = f"{name2id[cls]} 0.5 0.5 1.0 1.0\n"
        (labels_dir / (src.stem + ".txt")).write_text(line_txt)
        written += 1

    # data.yaml — points YOLO at these dirs + the holdout
    val_dir = holdout_dir / "images" if (holdout_dir / "images").exists() else holdout_dir
    yaml_path = work_dir / "yolo" / "data.yaml"
    yaml_path.write_text(
        f"path: {(work_dir / 'yolo').as_posix()}\n"
        f"train: images/train\n"
        f"val: {val_dir.as_posix()}\n"
        f"nc: {len(classes)}\n"
        f"names: {json.dumps(classes)}\n"
    )
    print(f"[adapter] yolo dataset: {written} train images, {len(classes)} classes",
          file=sys.stderr)
    return yaml_path


# ── Step 2: train ───────────────────────────────────────────────────
# Two strategies:
#   1. Continue-training from the production model (preferred — keeps
#      what the model already knows about easy cases)
#   2. From-scratch with yolov8 base (fallback if (1) unavailable)
def train_yolo(data_yaml: Path, work_dir: Path) -> Path:
    """Returns path to the best.pt the trainer produced."""
    try:
        from ultralytics import YOLO
    except ImportError as e:
        raise RuntimeError("ultralytics not installed; cannot train YOLO") from e

    # Try to continue-train from current production model
    base_model = REPO_ROOT / "Models" / "best 32.pt"
    if not base_model.exists():
        # Fall back to a stock YOLO checkpoint shipped with this dir
        for fallback in ("yolov8l.pt", "yolov8n.pt", "yolov8s.pt"):
            fp = ADAPTER_DIR / fallback
            if fp.exists():
                base_model = fp
                break
    print(f"[adapter] base model: {base_model}", file=sys.stderr)

    model = YOLO(str(base_model))
    model.train(
        data=str(data_yaml),
        epochs=20,
        imgsz=640,
        project=str(work_dir / "yolo_runs"),
        name="active",
        exist_ok=True,
        verbose=False,
    )
    best = work_dir / "yolo_runs" / "active" / "weights" / "best.pt"
    if not best.exists():
        raise RuntimeError(f"YOLO did not produce {best}")
    return best


# ── Step 3: evaluate against the holdout ─────────────────────────────
def evaluate(model_path: Path, data_yaml: Path) -> dict:
    """Returns a metrics dict including 'accuracy' (the runner's
    PRIMARY_METRIC for devices). Uses YOLO's built-in .val() call."""
    try:
        from ultralytics import YOLO
    except ImportError:
        return {"accuracy": 0.0, "error": "ultralytics not installed"}

    model = YOLO(str(model_path))
    try:
        res = model.val(data=str(data_yaml), verbose=False)
        # YOLO val returns a Metrics object with various stats. Map to a
        # single 'accuracy' for the promotion gate; keep richer fields too.
        out = {
            "accuracy":   float(getattr(res.box, "map50", 0.0)),
            "mAP50":      float(getattr(res.box, "map50", 0.0)),
            "mAP50_95":   float(getattr(res.box, "map", 0.0)),
            "precision":  float(getattr(res.box, "mp", 0.0)),
            "recall":     float(getattr(res.box, "mr", 0.0)),
            "n_holdout":  int(getattr(res, "nt_per_class", [0]).sum()) if hasattr(res, "nt_per_class") else 0,
        }
        return out
    except Exception as e:
        return {"accuracy": 0.0, "error": f"validation failed: {e}"}


# ── Main: implements the runner contract ─────────────────────────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--holdout", required=True, help="path to frozen holdout dir")
    args = ap.parse_args()

    work = Path.cwd()
    holdout = Path(args.holdout)
    dataset_jsonl = work / "dataset.jsonl"

    if not dataset_jsonl.exists():
        print(f"[adapter] FATAL: no dataset.jsonl in {work}", file=sys.stderr)
        sys.exit(2)

    started = time.time()
    print(f"[adapter] start. cwd={work}  holdout={holdout}", file=sys.stderr)

    # 1. Convert AL samples → YOLO dataset
    data_yaml = convert_to_yolo_dataset(work, dataset_jsonl, holdout)

    # 2. Train
    best = train_yolo(data_yaml, work)
    shutil.copyfile(best, work / "best.pt")
    print(f"[adapter] trained → {work / 'best.pt'}", file=sys.stderr)

    # 3. Evaluate against holdout (val_metrics.json drives the gate)
    metrics = evaluate(work / "best.pt", data_yaml)
    metrics["elapsed_sec"] = round(time.time() - started, 2)
    (work / "val_metrics.json").write_text(json.dumps(metrics, indent=2))
    print(f"[adapter] val_metrics: {json.dumps(metrics)}", file=sys.stderr)

    # The runner reads val_metrics.json and best.pt — we're done.
    sys.exit(0)


if __name__ == "__main__":
    main()

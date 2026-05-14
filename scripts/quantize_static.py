#!/usr/bin/env python3
"""Static INT8 quantization for the on-device pipeline models.

The existing dynamic INT8 builds (Models/exported/*_int8.onnx) hang ORT's
createSession() on the Galaxy A35 5G because the graph is full of
QuantizeLinear / DequantizeLinear pairs around every weight tensor.

Static INT8 with QOperator format folds those into fused INT8 kernels
(QLinearConv etc.), giving ORT a much simpler graph to initialize.

Reads the FP32 ONNX exports from Models/exported/, runs calibration on
a small representative sample, writes new *_int8_static.onnx files
alongside.

    py scripts/quantize_static.py
"""

import argparse
import random
import sys
from pathlib import Path

import numpy as np
import cv2
import onnx
from onnxruntime.quantization import (
    quantize_static,
    CalibrationDataReader,
    QuantType,
    QuantFormat,
    CalibrationMethod,
)

REPO_ROOT = Path(__file__).resolve().parent.parent
EXPORTED = REPO_ROOT / "Models" / "exported"

# Calibration source pools.
WHOLE_RACK_DIRS = [
    REPO_ROOT / "server" / "uploads",
    REPO_ROOT / "outputs",
    REPO_ROOT / "retraining_learning" / "Devices_Retraining" / "temp",
    REPO_ROOT / "retraining_learning" / "Devices_Retraining" / "review_dataset" / "images",
]
DEVICE_CROP_DIR = REPO_ROOT / "active_learning_Cache" / "data" / "devices" / "samples"

random.seed(42)


def collect_images(roots, exts=(".jpg", ".jpeg", ".png")):
    paths = []
    for root in roots:
        if not root.exists():
            continue
        if root.is_file() and root.suffix.lower() in exts:
            paths.append(root)
        else:
            for p in root.rglob("*"):
                if p.is_file() and p.suffix.lower() in exts:
                    paths.append(p)
    return paths


def preprocess(img_path, size):
    img = cv2.imread(str(img_path))
    if img is None:
        return None
    img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    img = cv2.resize(img, (size, size))
    img = img.astype(np.float32) / 255.0
    img = img.transpose(2, 0, 1)
    img = np.expand_dims(img, 0)
    return img


class FolderReader(CalibrationDataReader):
    def __init__(self, image_paths, input_name, input_size, max_samples=50):
        self.paths = list(image_paths)[:max_samples]
        self.idx = 0
        self.input_name = input_name
        self.input_size = input_size

    def get_next(self):
        while self.idx < len(self.paths):
            t = preprocess(self.paths[self.idx], self.input_size)
            self.idx += 1
            if t is not None:
                return {self.input_name: t}
        return None

    def rewind(self):
        self.idx = 0


def get_input_name(model_path):
    m = onnx.load(str(model_path))
    return m.graph.input[0].name


# (name, input_size, calibration_pool_key)
MODELS = [
    ("unit",                     640, "rack"),
    ("Units",                    640, "rack"),
    ("best_32",                  640, "rack"),
    ("best_33",                  640, "rack"),
    ("Device_final",             640, "rack"),
    ("port_count",               640, "rack"),
    ("port_best",                640, "crop"),
    ("switch_patch",             640, "crop"),
    ("best_model_efficientnet",  224, "crop"),
]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", help="Comma-separated subset of model names to run")
    parser.add_argument("--max-samples", type=int, default=50,
                        help="Max calibration samples per model (lower if OOM)")
    args = parser.parse_args()

    only = set(args.only.split(",")) if args.only else None

    rack_pool = collect_images(WHOLE_RACK_DIRS)
    crop_pool = collect_images([DEVICE_CROP_DIR])
    print(f"Whole-rack calibration pool: {len(rack_pool)} images")
    print(f"Device-crop calibration pool: {len(crop_pool)} images")
    print(f"Max samples per model: {args.max_samples}")
    if only:
        print(f"Filter: {sorted(only)}")
    if len(rack_pool) < 5:
        print("WARNING: small whole-rack pool; quantization may be sub-optimal.")
    random.shuffle(rack_pool)
    random.shuffle(crop_pool)

    pools = {"rack": rack_pool, "crop": crop_pool}

    summary = []
    for name, size, pool_key in MODELS:
        if only and name not in only:
            continue
        src = EXPORTED / f"{name}_fp32.onnx"
        dst = EXPORTED / f"{name}_int8_static.onnx"
        if not src.exists():
            print(f"\n[{name}] SKIP — {src} not found")
            summary.append((name, "missing source", 0, 0))
            continue

        input_name = get_input_name(src)
        pool = pools[pool_key]
        print(f"\n[{name}] size={size} input={input_name!r} pool={pool_key} ({len(pool)} imgs)")

        reader = FolderReader(pool, input_name, size, max_samples=args.max_samples)
        try:
            quantize_static(
                model_input=str(src),
                model_output=str(dst),
                calibration_data_reader=reader,
                # QOperator format with the ARM-CPU-friendly type pairing:
                # QUInt8 activations + QInt8 weights. (Full QInt8/QInt8 with
                # per_channel=False produced zero-detection models for our
                # YOLOs — too aggressive a quantization for the detection
                # head's confidence outputs to survive.)
                quant_format=QuantFormat.QOperator,
                activation_type=QuantType.QUInt8,
                weight_type=QuantType.QInt8,
                per_channel=True,
                calibrate_method=CalibrationMethod.Entropy,
            )
            sz_mb = dst.stat().st_size / 1e6
            src_mb = src.stat().st_size / 1e6
            print(f"  -> {dst.name}: {src_mb:.1f} MB -> {sz_mb:.1f} MB")
            summary.append((name, "ok", src_mb, sz_mb))
        except Exception as e:
            print(f"  -> FAILED: {type(e).__name__}: {e}")
            summary.append((name, f"FAILED: {type(e).__name__}", 0, 0))

    print("\n" + "=" * 60)
    print("Summary")
    print("=" * 60)
    print(f"{'Model':<28} {'Status':<14} {'FP32 (MB)':>11} {'INT8 (MB)':>11}")
    for name, status, fp32, int8 in summary:
        print(f"{name:<28} {status:<14} {fp32:>11.1f} {int8:>11.1f}")


if __name__ == "__main__":
    sys.exit(main() or 0)

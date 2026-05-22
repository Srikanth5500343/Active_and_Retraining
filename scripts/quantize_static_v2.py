#!/usr/bin/env python3
"""Static INT8 quantization for YOLO ONNX models — version 2.

The earlier attempts produced all-zero outputs because we let ORT quantize
the YOLOv8 detection head (the `/model.22/...` subtree: Sigmoid, DFL
softmax, box-decoding slice/add). That head is numerically sensitive —
when its sigmoid sees a slightly wrong INT8-rounded input, it saturates
to 0 and every confidence collapses.

The fix: skip those nodes. Quantize the convolutional backbone (95% of
the FLOPs / weights), keep the detection head in FP32. That's exactly
what TensorRT and TFLite do automatically for YOLO models.

Outputs to Models/exported/*_int8_v2.onnx and verifies each against
the FP32 baseline so we can see immediately if outputs are still zero.

    py scripts/quantize_static_v2.py
"""

import random
import sys
from pathlib import Path

import numpy as np
import cv2
import onnx
import onnxruntime as ort
from onnxruntime.quantization import (
    quantize_static,
    CalibrationDataReader,
    QuantType,
    QuantFormat,
    CalibrationMethod,
)

REPO = Path(__file__).resolve().parent.parent
EXPORTED = REPO / "Models" / "exported"

# Calibration pools.
WHOLE_RACK_DIRS = [
    REPO / "server" / "uploads",
    REPO / "outputs",
    REPO / "retraining_learning" / "Devices_Retraining" / "temp",
]
DEVICE_CROP_DIR = REPO / "active_learning_Cache" / "data" / "devices" / "samples"

random.seed(42)

# (model basename, input_size, calibration_pool_key)
# All 9 — the 6 the server actually uses, plus the 3 alternatives kept
# in the bundle for benchmark/comparison work.
MODELS = [
    ("unit",                     640, "rack"),
    ("best_32",                  640, "rack"),
    ("best_33",                  640, "rack"),
    ("port_count",               640, "rack"),
    ("port_best",                640, "crop"),
    ("best_model_efficientnet",  224, "crop"),
    ("Units",                    640, "rack"),
    ("Device_final",             640, "rack"),
    ("switch_patch",             640, "crop"),
]


def collect(roots, exts=(".jpg", ".jpeg", ".png")):
    out = []
    for r in roots:
        if not r.exists():
            continue
        for p in r.rglob("*"):
            if p.is_file() and p.suffix.lower() in exts:
                out.append(p)
    return out


def letterbox_preprocess(img_path, size):
    """Match what the Android plugin does at runtime — letterbox, not stretch."""
    img = cv2.imread(str(img_path))
    if img is None:
        return None
    img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    H, W = img.shape[:2]
    scale = min(size / W, size / H)
    nW, nH = round(W * scale), round(H * scale)
    resized = cv2.resize(img, (nW, nH))
    lb = np.full((size, size, 3), 114, dtype=np.uint8)
    dx, dy = (size - nW) // 2, (size - nH) // 2
    lb[dy:dy + nH, dx:dx + nW] = resized
    t = lb.astype(np.float32) / 255.0
    return np.expand_dims(t.transpose(2, 0, 1), 0)


class Reader(CalibrationDataReader):
    def __init__(self, paths, input_name, size, n=30):
        self.paths = paths[:n]
        self.idx = 0
        self.input_name = input_name
        self.size = size

    def get_next(self):
        while self.idx < len(self.paths):
            t = letterbox_preprocess(self.paths[self.idx], self.size)
            self.idx += 1
            if t is not None:
                return {self.input_name: t}
        return None

    def rewind(self):
        self.idx = 0


def detection_head_nodes(model_path):
    """Return the list of node names in /model.22/... — Ultralytics
    YOLOv8's detection head. Skipping these from quantization is what
    avoids the all-zeros output we hit in v1."""
    m = onnx.load(str(model_path))
    names = []
    for n in m.graph.node:
        if n.name.startswith("/model.22/"):
            names.append(n.name)
    return names


def quantize_one(name, size, pool, sample_image):
    src = EXPORTED / f"{name}_fp32.onnx"
    dst = EXPORTED / f"{name}_int8_v2.onnx"
    if not src.exists():
        return ("missing source", 0, 0)

    input_name = onnx.load(str(src)).graph.input[0].name
    # YOLO detection head — skip if present (EfficientNet won't have it).
    excluded = detection_head_nodes(src)
    reader = Reader(pool, input_name, size, n=30)

    try:
        quantize_static(
            model_input=str(src),
            model_output=str(dst),
            calibration_data_reader=reader,
            quant_format=QuantFormat.QOperator,
            activation_type=QuantType.QUInt8,
            weight_type=QuantType.QInt8,
            per_channel=True,
            calibrate_method=CalibrationMethod.Entropy,
            nodes_to_exclude=excluded,
        )
    except Exception as e:
        return (f"FAILED: {type(e).__name__}: {e}", 0, 0)

    src_mb = src.stat().st_size / 1e6
    dst_mb = dst.stat().st_size / 1e6

    # Smoke-test: run on a real image and verify the output isn't a tensor
    # of zeros. For YOLO outputs we read max conf from channel 4 onward.
    tensor = letterbox_preprocess(sample_image, size)
    sess_fp32 = ort.InferenceSession(str(src), providers=["CPUExecutionProvider"])
    sess_int8 = ort.InferenceSession(str(dst), providers=["CPUExecutionProvider"])
    out_fp32 = sess_fp32.run(None, {input_name: tensor})[0]
    out_int8 = sess_int8.run(None, {input_name: tensor})[0]

    def yolo_max_conf(o):
        if o.ndim == 3 and o.shape[1] >= 5:
            return float(o[0, 4:].max())
        # EfficientNet classifier
        return float(np.abs(o).max())

    return ("ok", src_mb, dst_mb, yolo_max_conf(out_fp32), yolo_max_conf(out_int8), len(excluded))


def main():
    rack_pool = collect(WHOLE_RACK_DIRS)
    crop_pool = collect([DEVICE_CROP_DIR])
    random.shuffle(rack_pool)
    random.shuffle(crop_pool)
    pools = {"rack": rack_pool, "crop": crop_pool}
    sample_rack = REPO / "client" / "public" / "test_rack.jpg"
    sample_crop = next(DEVICE_CROP_DIR.glob("*.jpg")) if DEVICE_CROP_DIR.exists() else sample_rack
    samples = {"rack": sample_rack, "crop": sample_crop}

    print(f"rack pool: {len(rack_pool)}   crop pool: {len(crop_pool)}")
    print()

    summary = []
    for name, size, pool_key in MODELS:
        print(f"--- {name} ({size}x{size}, {pool_key} pool) ---")
        result = quantize_one(name, size, pools[pool_key], samples[pool_key])
        status = result[0]
        if status == "ok":
            _, fp32_mb, int8_mb, fp32_conf, int8_conf, n_excluded = result
            print(f"  excluded {n_excluded} detection-head nodes")
            print(f"  {fp32_mb:.1f} MB -> {int8_mb:.1f} MB")
            print(f"  max conf  FP32={fp32_conf:.4f}  INT8={int8_conf:.4f}")
            ok = int8_conf > 0.01
            print(f"  {'PASS' if ok else 'FAIL — outputs near zero'}")
            summary.append((name, fp32_mb, int8_mb, int8_conf, "ok" if ok else "zero-out"))
        else:
            print(f"  {status}")
            summary.append((name, 0, 0, 0, status))
        print()

    print("=" * 70)
    print(f"{'Model':<28} {'FP32 (MB)':>10} {'INT8 (MB)':>10} {'Max conf':>10}  Status")
    t1 = t2 = 0
    for n, f32, i8, conf, st in summary:
        print(f"{n:<28} {f32:>10.1f} {i8:>10.1f} {conf:>10.4f}  {st}")
        t1 += f32
        t2 += i8
    print("-" * 70)
    print(f"{'Total':<28} {t1:>10.1f} {t2:>10.1f}")


if __name__ == "__main__":
    sys.exit(main() or 0)

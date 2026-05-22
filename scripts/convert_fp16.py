#!/usr/bin/env python3
"""Convert all 9 FP32 ONNX exports to FP16.

ORT static-INT8 quantization broke our YOLO outputs (all zeros). FP16
keeps the graph topology intact - no Q/DQ ops, no calibration, no
per-channel scales - and only loses ~3 decimal digits of precision,
which is well above what these detectors need.

Outputs to Models/exported/*_fp16.onnx, then verifies each one against
the FP32 baseline on a real rack image and prints confidence stats so
we can spot any model that quietly broke.

    py scripts/convert_fp16.py
"""

from pathlib import Path

import numpy as np
import cv2
import onnx
import onnxruntime as ort
from onnxconverter_common import float16

REPO = Path(__file__).resolve().parent.parent
EXPORTED = REPO / "Models" / "exported"

MODELS = [
    ("unit",                    640),
    ("Units",                   640),
    ("best_32",                 640),
    ("best_33",                 640),
    ("Device_final",            640),
    ("port_count",              640),
    ("port_best",               640),
    ("switch_patch",            640),
    ("best_model_efficientnet", 224),
]

TEST_IMAGE = REPO / "retraining_learning" / "Devices_Retraining" / "temp" / "T1.jpg"


def preprocess(img_path, size):
    img = cv2.imread(str(img_path))
    img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    img = cv2.resize(img, (size, size))
    img = img.astype(np.float32) / 255.0
    return np.expand_dims(img.transpose(2, 0, 1), 0)


def run_and_report(model_path, tensor, label):
    sess = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
    inp_name = sess.get_inputs()[0].name
    # With keep_io_types=True, FP16 models still take FP32 inputs.
    out = sess.run(None, {inp_name: tensor})[0]
    # YOLO output is [1, C, N] for C >= 5 (cx,cy,w,h,conf[,...class scores]).
    # EfficientNet output is [1, K] (classification logits).
    if out.ndim == 3 and out.shape[1] >= 5:
        conf = out[0, 4].astype(np.float32)
        print(f"  {label:<14} shape={out.shape} max_conf={conf.max():.4f} "
              f">0.12={(conf > 0.12).sum():>4} boxes  >0.01={(conf > 0.01).sum():>4} boxes")
    else:
        flat = out.flatten().astype(np.float32)
        print(f"  {label:<14} shape={out.shape} max={flat.max():.4f} min={flat.min():.4f}")


def main():
    if not TEST_IMAGE.exists():
        print(f"Test image missing: {TEST_IMAGE}")
        return

    summary = []
    for name, size in MODELS:
        src = EXPORTED / f"{name}_fp32.onnx"
        dst = EXPORTED / f"{name}_fp16.onnx"
        if not src.exists():
            print(f"\n[{name}] SKIP - {src.name} not found")
            continue

        print(f"\n=== {name} ({size}x{size}) ===")
        # Convert. Keep IO in FP32 so the plugin still feeds FP32 tensors;
        # block ops that the converter handles badly (Resize was producing
        # type-mismatched outputs that wouldn't load in ORT). Blocked ops
        # stay in FP32 with cast nodes around them.
        m = onnx.load(str(src))
        m16 = float16.convert_float_to_float16(
            m,
            keep_io_types=True,
            disable_shape_infer=False,
            op_block_list=["Resize", "Range", "Pad", "NonMaxSuppression"],
        )
        onnx.save(m16, str(dst))
        src_mb = src.stat().st_size / 1e6
        dst_mb = dst.stat().st_size / 1e6
        print(f"  {src.name} ({src_mb:.1f} MB) -> {dst.name} ({dst_mb:.1f} MB)")

        # Verify on the test image.
        tensor = preprocess(TEST_IMAGE, size)
        run_and_report(src, tensor, "FP32")
        run_and_report(dst, tensor, "FP16")

        summary.append((name, src_mb, dst_mb))

    print("\n" + "=" * 60)
    print("Summary")
    print("=" * 60)
    print(f"{'Model':<28} {'FP32 (MB)':>11} {'FP16 (MB)':>11}")
    total_src = total_dst = 0
    for name, fp32, fp16_sz in summary:
        print(f"{name:<28} {fp32:>11.1f} {fp16_sz:>11.1f}")
        total_src += fp32
        total_dst += fp16_sz
    print("-" * 56)
    print(f"{'Total':<28} {total_src:>11.1f} {total_dst:>11.1f}")


if __name__ == "__main__":
    main()

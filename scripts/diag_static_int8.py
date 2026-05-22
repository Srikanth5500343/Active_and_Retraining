#!/usr/bin/env python3
"""Compare static-INT8 vs FP32 YOLO outputs on the same image.

If the INT8 model's confidence channel is squashed to ~0 while FP32
produces real confidences, our quantization config is destroying the
detector. If both produce similar distributions, the issue is elsewhere
(e.g., conf threshold too high, preprocessing mismatch).

    py scripts/diag_static_int8.py
"""

from pathlib import Path

import numpy as np
import cv2
import onnxruntime as ort

REPO_ROOT = Path(__file__).resolve().parent.parent
EXPORTED = REPO_ROOT / "Models" / "exported"

# Pick one whole-rack image. Anything from the calibration pool works.
CANDIDATE_IMAGES = [
    REPO_ROOT / "retraining_learning" / "Devices_Retraining" / "temp" / "T1.jpg",
    REPO_ROOT / "outputs" / "RK-9C4DBDC0" / "original_image.jpg",
    REPO_ROOT / "outputs" / "RK-E6F7B496" / "original_image.jpg",
]

MODELS = [
    ("unit",   640),
    ("best_32",  640),   # the YOLOv8l-class device detector
]


def preprocess(img_path, size):
    img = cv2.imread(str(img_path))
    img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    img = cv2.resize(img, (size, size))
    img = img.astype(np.float32) / 255.0
    img = img.transpose(2, 0, 1)
    return np.expand_dims(img, 0)


def summarize_yolo_output(out, name):
    # YOLO output shape: [1, C, N] where C=5 for single-class (cx,cy,w,h,conf)
    arr = out[0]   # [C, N]
    print(f"  {name}: shape={out.shape}, dtype={out.dtype}")
    if arr.shape[0] >= 5:
        conf = arr[4]
        print(f"    conf  min={conf.min():.4f} max={conf.max():.4f} mean={conf.mean():.4f}")
        for thresh in (0.5, 0.25, 0.12, 0.05, 0.01, 0.001):
            n = int((conf > thresh).sum())
            print(f"    conf > {thresh:<6}: {n} boxes")


def main():
    img_path = next((p for p in CANDIDATE_IMAGES if p.exists()), None)
    if img_path is None:
        print("No calibration image found.")
        return
    print(f"Using image: {img_path}")

    for name, size in MODELS:
        print(f"\n=== {name} (input {size}x{size}) ===")
        tensor = preprocess(img_path, size)

        for variant, fname in [("FP32", f"{name}_fp32.onnx"),
                               ("INT8", f"{name}_int8_static.onnx")]:
            model_path = EXPORTED / fname
            if not model_path.exists():
                print(f"  {variant}: {fname} not found")
                continue
            sess = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
            input_name = sess.get_inputs()[0].name
            out = sess.run(None, {input_name: tensor})[0]
            summarize_yolo_output(out, variant)


if __name__ == "__main__":
    main()

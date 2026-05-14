#!/usr/bin/env python3
"""Test whether quant_pre_process fixes the all-zeros INT8 output.

Steps for one model (unit):
  1. shape_inference.quant_pre_process(unit_fp32.onnx) -> unit_fp32_prep.onnx
  2. quantize_static(unit_fp32_prep.onnx) -> unit_int8_prep.onnx
  3. Run unit_int8_prep on the same image and compare confidences.

If output is non-zero with real confidences, the fix is `quant_pre_process`
and we apply it to all 9 in the main script.
"""

from pathlib import Path
import numpy as np
import cv2
import onnxruntime as ort
from onnxruntime.quantization import (
    quantize_static, CalibrationDataReader, QuantType, QuantFormat, CalibrationMethod,
)
from onnxruntime.quantization.shape_inference import quant_pre_process

REPO = Path(__file__).resolve().parent.parent
EXPORTED = REPO / "Models" / "exported"

CALIB_DIRS = [
    REPO / "retraining_learning" / "Devices_Retraining" / "temp",
    REPO / "outputs" / "RK-9C4DBDC0",
    REPO / "outputs" / "RK-E6F7B496",
    REPO / "server" / "uploads",
]


def preprocess(img_path, size):
    img = cv2.imread(str(img_path))
    img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    img = cv2.resize(img, (size, size))
    img = img.astype(np.float32) / 255.0
    img = img.transpose(2, 0, 1)
    return np.expand_dims(img, 0)


class Reader(CalibrationDataReader):
    def __init__(self, paths, input_name, size, n=10):
        self.paths = paths[:n]
        self.idx = 0
        self.input_name = input_name
        self.size = size

    def get_next(self):
        if self.idx >= len(self.paths):
            return None
        t = preprocess(self.paths[self.idx], self.size)
        self.idx += 1
        return {self.input_name: t}

    def rewind(self):
        self.idx = 0


def collect_images(roots, exts=(".jpg", ".jpeg", ".png")):
    paths = []
    for r in roots:
        if r.is_dir():
            for p in r.rglob("*"):
                if p.is_file() and p.suffix.lower() in exts:
                    paths.append(p)
    return paths


def main():
    src = EXPORTED / "unit_fp32.onnx"
    prep = EXPORTED / "unit_fp32_prep.onnx"
    int8 = EXPORTED / "unit_int8_prep.onnx"

    print("Step 1: quant_pre_process …")
    quant_pre_process(input_model=str(src), output_model_path=str(prep), skip_optimization=False)
    print(f"  wrote {prep.name}")

    print("\nStep 2: quantize_static (per_channel=True, Entropy, QUInt8/QInt8) …")
    images = collect_images(CALIB_DIRS)
    print(f"  {len(images)} calibration images")
    reader = Reader(images, "images", 640, n=10)
    quantize_static(
        model_input=str(prep),
        model_output=str(int8),
        calibration_data_reader=reader,
        quant_format=QuantFormat.QOperator,
        activation_type=QuantType.QUInt8,
        weight_type=QuantType.QInt8,
        per_channel=True,
        calibrate_method=CalibrationMethod.Entropy,
    )
    print(f"  wrote {int8.name} ({int8.stat().st_size / 1e6:.1f} MB)")

    print("\nStep 3: run INT8 on test image, compare to FP32 …")
    test_img = next((p for p in CALIB_DIRS for q in p.rglob("*.jpg") if q.is_file()), None)
    if test_img is None:
        for d in CALIB_DIRS:
            for q in d.rglob("*.jpg"):
                test_img = q
                break
            if test_img: break
    test_img = next(EXPORTED.parent.rglob("T1.jpg"))
    tensor = preprocess(test_img, 640)

    for label, path in [("FP32 (original)", src), ("INT8 (preprocessed quant)", int8)]:
        s = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
        out = s.run(None, {s.get_inputs()[0].name: tensor})[0]
        conf = out[0, 4]
        print(f"  {label}: max conf {conf.max():.4f}  > 0.12 = {(conf > 0.12).sum()} boxes  > 0.01 = {(conf > 0.01).sum()} boxes")


if __name__ == "__main__":
    main()

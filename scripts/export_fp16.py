#!/usr/bin/env python3
"""Export the 8 YOLO models to FP16 ONNX via Ultralytics.

The onnxconverter_common.float16 path produced broken Resize nodes
that wouldn't load. Ultralytics' built-in `half=True` export is the
tested path - it generates FP16 ONNX directly from the .pt sources.

EfficientNet (.pth) doesn't go through Ultralytics, so we leave its
FP32 ONNX in place and convert it separately.

    py scripts/export_fp16.py
"""

from pathlib import Path
import shutil

import numpy as np
import cv2
import onnxruntime as ort
from ultralytics import YOLO

REPO = Path(__file__).resolve().parent.parent
MODELS = REPO / "Models"
EXPORTED = REPO / "Models" / "exported"

# (.pt filename, output base name)
YOLO_MODELS = [
    ("unit.pt",         "unit"),
    ("Units.pt",        "Units"),
    ("best 32.pt",      "best_32"),
    ("best 33.pt",      "best_33"),
    ("Device_final.pt", "Device_final"),
    ("port_count.pt",   "port_count"),
    ("port_best.pt",    "port_best"),
    ("switch_patch.pt", "switch_patch"),
]

TEST_IMAGE = REPO / "retraining_learning" / "Devices_Retraining" / "temp" / "T1.jpg"


def preprocess(path, size):
    img = cv2.imread(str(path))
    img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    img = cv2.resize(img, (size, size))
    img = img.astype(np.float32) / 255.0
    return np.expand_dims(img.transpose(2, 0, 1), 0)


def smoke(model_path, tensor, label):
    sess = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
    inp = sess.get_inputs()[0]
    t = tensor.astype(np.float16) if "float16" in inp.type else tensor
    out = sess.run(None, {inp.name: t})[0]
    if out.ndim == 3 and out.shape[1] >= 5:
        conf = out[0, 4].astype(np.float32)
        print(f"  {label:<10} dtype={out.dtype} shape={out.shape} "
              f"max_conf={conf.max():.4f} >0.12={(conf > 0.12).sum()} >0.01={(conf > 0.01).sum()}")
    else:
        f = out.flatten().astype(np.float32)
        print(f"  {label:<10} dtype={out.dtype} shape={out.shape} max={f.max():.4f} min={f.min():.4f}")


def main():
    tensor640 = preprocess(TEST_IMAGE, 640)
    summary = []
    for pt_name, base in YOLO_MODELS:
        pt_path = MODELS / pt_name
        if not pt_path.exists():
            print(f"\n[{base}] SKIP — {pt_path} not found")
            continue

        print(f"\n=== {base} ===")
        model = YOLO(str(pt_path))
        # Ultralytics export writes alongside the .pt with the same basename.
        out = model.export(format="onnx", half=True, imgsz=640, dynamic=False, simplify=False)
        gen_path = Path(out)

        dst = EXPORTED / f"{base}_fp16.onnx"
        if dst.exists():
            dst.unlink()
        shutil.move(str(gen_path), str(dst))
        dst_mb = dst.stat().st_size / 1e6
        fp32_path = EXPORTED / f"{base}_fp32.onnx"
        fp32_mb = fp32_path.stat().st_size / 1e6 if fp32_path.exists() else 0
        print(f"  -> {dst.name} ({fp32_mb:.1f} MB FP32 -> {dst_mb:.1f} MB FP16)")

        # Smoke-test: confidences should be > 0.
        if fp32_path.exists():
            smoke(fp32_path, tensor640, "FP32")
        smoke(dst, tensor640, "FP16")
        summary.append((base, fp32_mb, dst_mb))

    # EfficientNet has its FP32 export already; FP16 conversion of that via
    # Ultralytics doesn't apply. Use onnxconverter_common with op_block_list.
    print(f"\n=== best_model_efficientnet ===")
    src = EXPORTED / "best_model_efficientnet_fp32.onnx"
    dst = EXPORTED / "best_model_efficientnet_fp16.onnx"
    if src.exists():
        import onnx
        from onnxconverter_common import float16
        m = onnx.load(str(src))
        m16 = float16.convert_float_to_float16(
            m,
            keep_io_types=True,
            disable_shape_infer=False,
        )
        onnx.save(m16, str(dst))
        fp32_mb = src.stat().st_size / 1e6
        dst_mb = dst.stat().st_size / 1e6
        print(f"  -> {dst.name} ({fp32_mb:.1f} MB FP32 -> {dst_mb:.1f} MB FP16)")
        tensor224 = preprocess(TEST_IMAGE, 224)
        smoke(src, tensor224, "FP32")
        smoke(dst, tensor224, "FP16")
        summary.append(("best_model_efficientnet", fp32_mb, dst_mb))

    print("\n" + "=" * 60)
    print("Summary")
    print("=" * 60)
    print(f"{'Model':<28} {'FP32 (MB)':>11} {'FP16 (MB)':>11}")
    t1 = t2 = 0
    for name, fp32, fp16 in summary:
        print(f"{name:<28} {fp32:>11.1f} {fp16:>11.1f}")
        t1 += fp32
        t2 += fp16
    print("-" * 56)
    print(f"{'Total':<28} {t1:>11.1f} {t2:>11.1f}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Shrink ALL SIX bundled models to FP16 and prove parity.

The on-device bundle keeps the full server-parity model set (6 models).
Shipping them as FP32 is ~488 MB; FP16 halves every file with no
measurable accuracy change. We convert from the FP32 ONNX exports in
Models/exported/ and install over the bundled `*_int8.onnx` names
(filename retained for JS compatibility — the BenchmarkPage scan flow
loads best_32 + port_best by those names; the rest ride along).

FP16 recipe: ONNX Runtime's own float16 converter (NOT
onnxconverter_common, which converts Resize's scales input to fp16 and
produces an INVALID_GRAPH). ORT's converter has an ALWAYS_FLOAT_INPUTS
table that pins Resize roi/scales/sizes to float32. keep_io_types=True
keeps every model's I/O FP32 so the Android plugin needs zero changes.

Parity is type-aware:
  * YOLO detectors  -> box count over threshold + max confidence
  * efficientnet     -> top-class index + score

    py scripts/fp16_shrink.py            # convert + verify, no install
    py scripts/fp16_shrink.py --install  # also overwrite bundled models
"""

import sys
from pathlib import Path

import numpy as np
import cv2
import onnx
import onnxruntime as ort
from onnxruntime.transformers.float16 import convert_float_to_float16

REPO = Path(__file__).resolve().parent.parent
SRC = REPO / "Models" / "exported"
BUNDLE = REPO / "client" / "public" / "models"
OUT = SRC  # intermediate fp16 files live next to the fp32 sources
TEST_IMG = REPO / "client" / "public" / "test_rack.jpg"

CONF_THRESH = 0.20      # config.json devices_conf / BenchmarkPage value
NMS_IOU = 0.45

# (fp32 source base, bundled filename, input size, kind)
MODELS = [
    ("best_32",                 "best_32_int8.onnx",                 640, "yolo"),
    ("port_best",               "port_best_int8.onnx",               640, "yolo"),
    ("best_33",                 "best_33_int8.onnx",                 640, "yolo"),
    ("port_count",              "port_count_int8.onnx",              640, "yolo"),
    ("unit",                    "unit_int8.onnx",                    640, "yolo"),
    ("best_model_efficientnet", "best_model_efficientnet_int8.onnx", 224, "cls"),
]


def preprocess(path, size):
    """Plain resize — only needs to be IDENTICAL across fp32/fp16 for the
    parity delta to be meaningful; need not match the device letterbox."""
    img = cv2.imread(str(path))
    img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    img = cv2.resize(img, (size, size))
    img = img.astype(np.float32) / 255.0
    return np.expand_dims(img.transpose(2, 0, 1), 0)


def measure(model_path, tensor, kind):
    import time
    so = ort.SessionOptions()
    t0 = time.perf_counter()
    sess = ort.InferenceSession(str(model_path), so, providers=["CPUExecutionProvider"])
    load_ms = (time.perf_counter() - t0) * 1000
    name = sess.get_inputs()[0].name
    raw = sess.run(None, {name: tensor})[0].astype(np.float32)
    if kind == "yolo":
        o = raw[0]                       # [4+C, N]
        nc = o.shape[0] - 4
        conf = o[4:4 + nc].max(axis=0)   # per-box conf = max class score
        return ("yolo", int((conf > CONF_THRESH).sum()), float(conf.max()),
                load_ms, raw)
    flat = raw.reshape(-1)               # classifier logits [K]
    return ("cls", int(flat.argmax()), float(flat.max()), load_ms, raw)


def parity_ok(a, b, kind):
    # FP16 keeps ~3 decimal digits — far above detector/classifier noise.
    if kind == "yolo":
        return abs(a[1] - b[1]) <= 2 and abs(a[2] - b[2]) <= 0.02
    return a[1] == b[1] and abs(a[2] - b[2]) <= 0.05   # same top class


def main():
    install = "--install" in sys.argv
    if not TEST_IMG.exists():
        print(f"FATAL: test image missing: {TEST_IMG}")
        sys.exit(1)

    all_ok = True
    converted = []
    for base, bundled, size, kind in MODELS:
        src = SRC / f"{base}_fp32.onnx"
        if not src.exists():
            print(f"FATAL: {src} not found")
            sys.exit(1)
        dst = OUT / f"{base}_fp16.onnx"

        print(f"\n=== {base}  ({kind}, {size}x{size}) ===")
        m16 = convert_float_to_float16(
            onnx.load(str(src)),
            keep_io_types=True,
            disable_shape_infer=False,
        )
        onnx.save(m16, str(dst))
        s_mb = src.stat().st_size / 1e6
        d_mb = dst.stat().st_size / 1e6
        print(f"  size: {s_mb:6.1f} MB FP32  ->  {d_mb:6.1f} MB FP16  "
              f"({100 * (1 - d_mb / s_mb):.0f}% smaller)")

        tensor = preprocess(TEST_IMG, size)
        r32 = measure(src, tensor, kind)
        r16 = measure(dst, tensor, kind)
        # Accuracy loss: element-wise difference of the raw model outputs.
        a, b = r32[4], r16[4]
        mae = float(np.abs(a - b).mean())
        maxerr = float(np.abs(a - b).max())
        denom = float(np.abs(a).mean()) or 1.0
        rel = 100.0 * mae / denom
        if kind == "yolo":
            print(f"  FP32: {r32[1]:>5} boxes >{CONF_THRESH}  max_conf={r32[2]:.5f}")
            print(f"  FP16: {r16[1]:>5} boxes >{CONF_THRESH}  max_conf={r16[2]:.5f}")
        else:
            print(f"  FP32: top class {r32[1]}  score={r32[2]:.5f}")
            print(f"  FP16: top class {r16[1]}  score={r16[2]:.5f}")
        print(f"  ACCURACY LOSS: mean abs err={mae:.2e}  max abs err={maxerr:.2e}"
              f"  (~{rel:.3f}% of mean output)")
        print(f"  LOAD (desktop ORT): FP32 {r32[3]:.0f} ms  ->  FP16 {r16[3]:.0f} ms")
        ok = parity_ok(r32, r16, kind) and d_mb < 0.6 * s_mb
        print(f"  PARITY: {'PASS' if ok else 'FAIL'}")
        all_ok &= ok
        converted.append((bundled, dst, s_mb, d_mb))

    print("\n" + "=" * 60)
    if not all_ok:
        print("PARITY FAILED — not installing. Inspect output above.")
        sys.exit(2)

    tot_s = sum(s for *_, s, _ in converted)
    tot_d = sum(d for *_, _, d in converted)
    print("All 6 parity checks PASSED.")
    print(f"Full 6-model bundle: {tot_s:.0f} MB FP32  ->  {tot_d:.0f} MB FP16")

    if install:
        BUNDLE.mkdir(parents=True, exist_ok=True)
        for bundled, dst, _, _ in converted:
            onnx.save(onnx.load(str(dst)), str(BUNDLE / bundled))
            print(f"  installed -> client/public/models/{bundled}")
    else:
        print("(dry run — pass --install to overwrite bundled models)")


if __name__ == "__main__":
    main()

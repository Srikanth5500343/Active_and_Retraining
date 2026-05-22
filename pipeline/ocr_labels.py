"""
OCR-only label extraction for rack images.

Runs EasyOCR on a single image and prints a JSON document to stdout.
No segmentation, no grouping, no HTML — just text + bbox + confidence.

Usage:
    python pipeline/ocr_labels.py <image_path>
    python pipeline/ocr_labels.py <image_path> --min-conf 0.5

Output (stdout, single line of JSON):
    {
      "image_size": { "w": 1920, "h": 1080 },
      "labels": [
        {
          "text":  "SW-U10",
          "conf":  0.92,
          "bbox":  { "x": 412, "y": 580, "w": 96, "h": 22, "yPct": 53.7 }
        },
        ...
      ]
    }
"""
import argparse
import json
import sys


def extract_labels(image_path: str, min_conf: float = 0.25) -> dict:
    import cv2
    import easyocr

    img = cv2.imread(image_path)
    if img is None:
        raise FileNotFoundError(f"Could not read image: {image_path}")
    h_img, w_img = img.shape[:2]

    reader  = easyocr.Reader(["en"], gpu=False, verbose=False)
    results = reader.readtext(image_path, detail=1, paragraph=False)

    labels = []
    for (pts, text, conf) in results:
        text = (text or "").strip()
        if len(text) < 2 or float(conf) < min_conf:
            continue
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        x1 = max(0, int(min(xs)))
        y1 = max(0, int(min(ys)))
        x2 = min(w_img, int(max(xs)))
        y2 = min(h_img, int(max(ys)))
        if x2 - x1 < 5 or y2 - y1 < 5:
            continue
        labels.append({
            "text": text,
            "conf": round(float(conf), 3),
            "bbox": {
                "x": x1, "y": y1,
                "w": x2 - x1, "h": y2 - y1,
                "yPct": round(y1 / h_img * 100, 2),
                "xPct": round(x1 / w_img * 100, 2),
            },
        })

    return {
        "image_size": { "w": w_img, "h": h_img },
        "labels": labels,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("image_path")
    ap.add_argument("--min-conf", type=float, default=0.25,
                    help="Drop OCR detections below this confidence (default: 0.25)")
    args = ap.parse_args()

    try:
        result = extract_labels(args.image_path, min_conf=args.min_conf)
    except Exception as e:
        # Always emit JSON so the Node side can parse cleanly.
        sys.stdout.write(json.dumps({ "error": str(e), "labels": [] }))
        sys.stdout.flush()
        sys.exit(1)

    sys.stdout.write(json.dumps(result))
    sys.stdout.flush()


if __name__ == "__main__":
    main()

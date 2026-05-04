"""
RackTrack — Device Detection (single-file)
─────────────────────────────────────────────────────────────
Self-contained YOLO device detection server.

Pipeline per request:
  1. YOLO Pass 1 : model_s (best 33.pt) — Server class only
  2. YOLO Pass 2 : model_l (best 32.pt) — All other classes, IoU dedup
  3. Build percent-coordinate device + unit slots from raw boxes

Run:
    pip install fastapi uvicorn ultralytics opencv-python-headless numpy
    python device_detection.py

POST /detect with JSON body:
    { "image": "<base64-encoded image>", "media_type": "image/jpeg" }

Response includes:
    slots[]           — device + unit slots (id, label, y_top, y_bot, confidence)
    summary{}         — counts by class
    unit_h_pct        — median 1U height as % of image
    rack_top_pct,
    rack_bot_pct      — vertical extent of detected rack
"""

import base64
import os

import cv2
import numpy as np
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from ultralytics import YOLO


# ─── Model paths ─────────────────────────────────────────────────────────────
# Defaults match the original Z:\ layout; override via env when running inside
# this repo (e.g. RACKTRACK_MODEL_S=Models/best\ 33.pt). The detection logic
# below is unchanged.
MODEL_S_PATH = os.environ.get(
    "RACKTRACK_MODEL_S", r"Z:\rackTrack_test\models\best 33.pt"
)   # Server-only model
MODEL_L_PATH = os.environ.get(
    "RACKTRACK_MODEL_L", r"Z:\rackTrack_test\models\best 32.pt"
)   # All other classes


# ─── Label normalization ─────────────────────────────────────────────────────
VALID_LABELS = {
    "Closed Unit", "Empty", "Firewall", "Gateway", "PDU", "PSU",
    "Patch Panel", "Router", "Server", "Storage Unit", "Switch", "UPS"
}
LABEL_MAP = {
    "patch_panel": "Patch Panel", "patch panel": "Patch Panel",
    "switch": "Switch", "network switch": "Switch", "ethernet switch": "Switch",
    "server": "Server", "server rack": "Server",
    "pdu": "PDU", "power distribution unit": "PDU", "power strip": "PDU",
    "ups": "UPS", "uninterruptible power supply": "UPS", "cyberpower": "UPS",
    "firewall": "Firewall", "router": "Router", "gateway": "Gateway",
    "psu": "PSU", "power supply unit": "PSU",
    "storage": "Storage Unit", "storage unit": "Storage Unit",
    "closed unit": "Closed Unit", "empty": "Empty",
}


def normalize_label(raw: str) -> str:
    if not raw:
        return "Empty"
    key = raw.strip().lower()
    if key in LABEL_MAP:
        return LABEL_MAP[key]
    titled = raw.strip().title()
    return titled if titled in VALID_LABELS else "Empty"


# ─── IoU helper ──────────────────────────────────────────────────────────────
def iou(a, b):
    xi1, yi1 = max(a[0], b[0]), max(a[1], b[1])
    xi2, yi2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0, xi2 - xi1) * max(0, yi2 - yi1)
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


# ─── FastAPI app ─────────────────────────────────────────────────────────────
app = FastAPI(title="RackTrack Device Detection")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)


# ─── Load models at startup ──────────────────────────────────────────────────
print("Loading YOLO device models …")
model_s = YOLO(MODEL_S_PATH)
model_l = YOLO(MODEL_L_PATH)
SERVER_ID_S = next((k for k, v in model_s.names.items() if v.lower() == "server"), None)
SERVER_ID_L = next((k for k, v in model_l.names.items() if v.lower() == "server"), None)
print(f"  model_s → {model_s.names}  (server id: {SERVER_ID_S})")
print(f"  model_l → {model_l.names}  (server id: {SERVER_ID_L})")
print("Models ready ✅")


# ─── Schema ──────────────────────────────────────────────────────────────────
class DetectRequest(BaseModel):
    image: str
    media_type: str = "image/jpeg"


# ─── Detection pipeline ──────────────────────────────────────────────────────
def _detect_devices(img: np.ndarray) -> dict:
    h, w = img.shape[:2]
    detections = []
    seen_boxes = []
    PAD = 2  # shrink each box by 2 px / side to suppress border noise

    # ── Pass 1: Server only (model_s) ────────────────────────────────────────
    res_s = model_s(img)[0]
    if res_s.boxes is not None and SERVER_ID_S is not None:
        for box in res_s.boxes:
            if int(box.cls[0]) != SERVER_ID_S:
                continue
            x1, y1, x2, y2 = map(int, box.xyxy[0])
            x1 = min(max(x1 + PAD, 0), w - 1)
            y1 = min(max(y1 + PAD, 0), h - 1)
            x2 = max(min(x2 - PAD, w - 1), x1 + 1)
            y2 = max(min(y2 - PAD, h - 1), y1 + 1)
            if (x2 - x1) >= 10 and (y2 - y1) >= 10:
                detections.append({
                    "label": "Server",
                    "x1": x1, "y1": y1, "x2": x2, "y2": y2,
                    "conf": float(box.conf[0]),
                })
                seen_boxes.append((x1, y1, x2, y2))

    # ── Pass 2: every other class (model_l), dedup vs Pass 1 by IoU > 0.5 ────
    res_l = model_l(img)[0]
    if res_l.boxes is not None:
        for box in res_l.boxes:
            cls = int(box.cls[0])
            if SERVER_ID_L is not None and cls == SERVER_ID_L:
                continue
            x1, y1, x2, y2 = map(int, box.xyxy[0])
            x1 = min(max(x1 + PAD, 0), w - 1)
            y1 = min(max(y1 + PAD, 0), h - 1)
            x2 = max(min(x2 - PAD, w - 1), x1 + 1)
            y2 = max(min(y2 - PAD, h - 1), y1 + 1)
            if (x2 - x1) < 10 or (y2 - y1) < 10:
                continue
            cur = (x1, y1, x2, y2)
            if any(iou(cur, prev) > 0.5 for prev in seen_boxes):
                continue
            seen_boxes.append(cur)
            detections.append({
                "label": normalize_label(model_l.names[cls]),
                "x1": x1, "y1": y1, "x2": x2, "y2": y2,
                "conf": float(box.conf[0]),
            })

    detections.sort(key=lambda d: d["y1"])

    if not detections:
        return {
            "unit_h_pct": 0, "unit_source": "none",
            "rack_top_pct": 0, "rack_bot_pct": 0,
            "slots": [],
            "summary": {
                "total_units_tiled": 0, "total_devices_detected": 0,
                "switches": 0, "patch_panels": 0, "empty_unit_slots": 0,
            },
        }

    # ── Rack geometry: estimate 1U height from Switch / Patch Panel medians ──
    rack_top_pct = detections[0]["y1"] / h * 100
    rack_bot_pct = detections[-1]["y2"] / h * 100
    ref = [d for d in detections if d["label"] in ("Switch", "Patch Panel")] or detections
    heights = sorted((d["y2"] - d["y1"]) / h * 100 for d in ref)
    unit_h = heights[len(heights) // 2] if heights else 4.0
    unit_src = "switch" if any(d["label"] == "Switch" for d in detections) else "patch panel"

    # ── Build device slots (percent coordinates) ─────────────────────────────
    device_slots = [
        {
            "id": f"D{i+1}", "type": "device", "label": d["label"],
            "status": "occupied",
            "y_top": round(d["y1"] / h * 100, 2),
            "y_bot": round(d["y2"] / h * 100, 2),
            "confidence": round(d["conf"], 3),
            "units": [],
        }
        for i, d in enumerate(detections)
    ]

    # ── Build unit slots tiled across the detected rack span ─────────────────
    unit_slots = []
    rack_h = rack_bot_pct - rack_top_pct
    if rack_h > 0 and unit_h > 0:
        unit_count = max(1, round(rack_h / unit_h))
        actual_uh = rack_h / unit_count
        unit_slots = [
            {
                "id": f"U{k+1}", "type": "unit", "label": "empty", "status": "empty",
                "y_top": round(rack_top_pct + k * actual_uh, 2),
                "y_bot": round(rack_top_pct + (k + 1) * actual_uh, 2),
            }
            for k in range(unit_count)
        ]

    # ── Cross-reference: which units does each device occupy ─────────────────
    for ds in device_slots:
        ds["units"] = [
            u["id"] for u in unit_slots
            if min(ds["y_bot"], u["y_bot"]) - max(ds["y_top"], u["y_top"]) > 0
        ]

    slots = sorted(unit_slots + device_slots, key=lambda s: s["y_top"])

    return {
        "unit_h_pct": round(unit_h, 2),
        "unit_source": unit_src,
        "rack_top_pct": round(rack_top_pct, 2),
        "rack_bot_pct": round(rack_bot_pct, 2),
        "slots": slots,
        "summary": {
            "total_units_tiled": len(unit_slots),
            "total_devices_detected": len(device_slots),
            "switches": sum(1 for d in detections if d["label"] == "Switch"),
            "patch_panels": sum(1 for d in detections if d["label"] == "Patch Panel"),
            "empty_unit_slots": len(unit_slots),
        },
    }


# ─── HTTP endpoints ──────────────────────────────────────────────────────────
@app.post("/detect")
async def detect(req: DetectRequest):
    try:
        img_bytes = base64.b64decode(req.image)
        nparr = np.frombuffer(img_bytes, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if img is None:
            raise ValueError("imdecode returned None")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Image decode error: {e}")
    return _detect_devices(img)


@app.get("/health")
async def health():
    return {"status": "ok", "models": ["model_s", "model_l"]}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8001, reload=False)

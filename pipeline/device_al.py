"""
Active-learning lookup for device-class corrections.

The React feedback UI stores user corrections in
server/data/active_learning/device_corrections.json. During future device
detection, this module checks each detected device crop against those learned
corrections and returns the user-provided class when the crop matches.
"""

from __future__ import annotations

import io
import json
import time
from pathlib import Path
from typing import Optional, Tuple

import cv2
import numpy as np
from PIL import Image

try:
    from active_learning_Cache.embedder import phash, embed, cos_sim
    HAS_EMBEDDER = True
except Exception:
    HAS_EMBEDDER = False

    def phash(img, size=16) -> str:
        if isinstance(img, bytes):
            img = Image.open(io.BytesIO(img))
        elif isinstance(img, np.ndarray):
            img = Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
        elif not isinstance(img, Image.Image):
            img = Image.open(img)
        g = img.convert("L").resize((size, size), Image.BILINEAR)
        arr = np.asarray(g, dtype=np.float32)
        bits = (arr > arr.mean()).flatten()
        return "".join("1" if b else "0" for b in bits)


CORRECTIONS_FILE = Path(__file__).resolve().parents[1] / "server" / "data" / "active_learning" / "device_corrections.json"
_CACHE = None
_CACHE_TIME = 0.0

VALID_DEVICE_CLASSES = {
    "Switch", "Patch Panel", "Firewall", "Router", "Server",
    "Load Balancer", "Modem", "Controller", "Recorder", "Amplifier",
    "Gateway", "PDU", "PSU", "UPS", "Closed Unit", "Empty",
    "Storage Unit", "Unidentified",
}

_CLASS_ALIASES = {
    "patch_panel": "Patch Panel",
    "patch panel": "Patch Panel",
    "load_balancer": "Load Balancer",
    "load balancer": "Load Balancer",
    "closed_unit": "Closed Unit",
    "closed unit": "Closed Unit",
    "storage_unit": "Storage Unit",
    "storage unit": "Storage Unit",
    "pdu": "PDU",
    "psu": "PSU",
    "ups": "UPS",
}


def load_corrections() -> dict:
    global _CACHE, _CACHE_TIME
    try:
        if not CORRECTIONS_FILE.exists():
            return {}
        now = time.time()
        if _CACHE is not None and (now - _CACHE_TIME) < 5:
            return _CACHE
        _CACHE = json.loads(CORRECTIONS_FILE.read_text(encoding="utf-8"))
        _CACHE_TIME = now
        return _CACHE
    except Exception as exc:
        print(f"[device AL] failed to load corrections: {exc}")
        return {}


def hamming_distance(a: str, b: str) -> int:
    if not a or not b or len(a) != len(b):
        return 10**9
    return sum(c1 != c2 for c1, c2 in zip(a, b))


def normalize_device_label(label: Optional[str]) -> Optional[str]:
    if not label:
        return None
    raw = str(label).strip()
    key = raw.replace("-", " ").replace("_", " ").lower()
    if raw in VALID_DEVICE_CLASSES:
        return raw
    if key in _CLASS_ALIASES:
        return _CLASS_ALIASES[key]
    titled = key.title()
    return titled if titled in VALID_DEVICE_CLASSES else raw


def _to_pil(image_input) -> Optional[Image.Image]:
    try:
        if isinstance(image_input, Image.Image):
            return image_input.convert("RGB")
        if isinstance(image_input, bytes):
            return Image.open(io.BytesIO(image_input)).convert("RGB")
        if isinstance(image_input, np.ndarray):
            return Image.fromarray(cv2.cvtColor(image_input, cv2.COLOR_BGR2RGB)).convert("RGB")
        return Image.open(image_input).convert("RGB")
    except Exception:
        return None


def get_device_correction(
    image_input,
    predicted_class: Optional[str] = None,
    tolerance: int = 12,
) -> Optional[Tuple[str, str]]:
    img = _to_pil(image_input)
    if img is None:
        return None

    corrections = load_corrections()
    if not corrections:
        return None

    try:
        h = phash(img)
    except Exception as exc:
        print(f"[device AL] phash failed: {exc}")
        return None

    best_label = None
    best_record = None
    best_dist = tolerance + 1
    for stored_h, record in corrections.items():
        dist = hamming_distance(h, stored_h)
        if dist < best_dist:
            best_label = record.get("label")
            best_record = record
            best_dist = dist

    if best_label and best_dist <= tolerance:
        corrected = normalize_device_label(best_label)
        print(f"[device AL] Hash match (distance={best_dist}): {predicted_class} -> {corrected}")
        return corrected, "hash"

    if not HAS_EMBEDDER:
        return None

    try:
        current_emb = embed(img)
        best_label = None
        best_score = 0.88
        for record in corrections.values():
            stored_emb = record.get("embedding")
            if not stored_emb:
                continue
            score = cos_sim(current_emb, stored_emb)
            if score > best_score:
                best_label = record.get("label")
                best_score = score
        if best_label:
            corrected = normalize_device_label(best_label)
            print(f"[device AL] Embedding match (similarity={best_score:.3f}): {predicted_class} -> {corrected}")
            return corrected, "embedding"
    except Exception as exc:
        print(f"[device AL] embedding lookup failed: {exc}")

    return None

"""
Active Learning Corrections Lookup
Applies learned cable color corrections to raw model predictions before
returning results. This complements model retraining and provides immediate
feedback improvement based on user corrections stored by the UI.

Usage:
    from pipeline.cable_al import get_correction

    # After classifying a cable with the model:
    predicted_color = model.predict(...)

    # Check for learned correction:
    corrected = get_correction(cable_image, predicted_color)
    if corrected:
        predicted_color = corrected  # Use the learned label instead
"""

import json
import io
import os
from pathlib import Path
from typing import Optional, Tuple
from PIL import Image
import numpy as np

# Try to import embedder; if not available, fall back to hash-only matching
try:
    from active_learning_Cache.embedder import phash, find_correction as embedder_find_correction
    HAS_EMBEDDER = True
except ImportError:
    HAS_EMBEDDER = False
    # Fallback: simple perceptual hash computation
    def phash(img_path, size=16) -> str:
        if isinstance(img_path, bytes):
            from io import BytesIO
            img = Image.open(BytesIO(img_path))
        else:
            img = Image.open(img_path) if isinstance(img_path, str) else img_path
        g = img.convert("L").resize((size, size), Image.BILINEAR)
        arr = np.asarray(g, dtype=np.float32)
        bits = (arr > arr.mean()).flatten()
        return "".join("1" if b else "0" for b in bits)


# Corrections database path (populated by server when users provide feedback)
CORRECTIONS_DIR = Path(__file__).parent.parent / "server" / "data" / "active_learning"
CORRECTIONS_FILE = CORRECTIONS_DIR / "cable_corrections.json"
_CORRECTIONS_CACHE = None
_CORRECTIONS_CACHE_TIME = 0


def load_corrections() -> dict:
    """Load active learning corrections from server's AL database with caching."""
    global _CORRECTIONS_CACHE, _CORRECTIONS_CACHE_TIME

    try:
        if not CORRECTIONS_FILE.exists():
            return {}

        # Cache for 5 seconds to avoid excessive disk reads
        import time
        now = time.time()
        if _CORRECTIONS_CACHE is not None and (now - _CORRECTIONS_CACHE_TIME) < 5:
            return _CORRECTIONS_CACHE

        with open(CORRECTIONS_FILE, 'r') as f:
            _CORRECTIONS_CACHE = json.load(f)
            _CORRECTIONS_CACHE_TIME = now
            return _CORRECTIONS_CACHE
    except Exception as e:
        print(f"[AL] Warning: failed to load corrections from {CORRECTIONS_FILE}: {e}")

    return {}


def hamming_distance(a: str, b: str) -> int:
    """Compute Hamming distance between two hash strings."""
    if not a or not b or len(a) != len(b):
        return 999
    return sum(c1 != c2 for c1, c2 in zip(a, b))


def _normalize_correction_label(label: Optional[str], record: dict) -> Optional[str]:
    """Convert UI color-only corrections into cable classifier labels."""
    if not label:
        return None

    label = str(label).strip()
    if "_" in label or label.startswith("RJ-45") or label.startswith("SC "):
        return label.replace("SC ", "SC_", 1)

    metadata = record.get("metadata") or {}
    connector = str(metadata.get("cable_connector") or "").upper()
    connector = connector.replace("-", "").replace("_", "").replace(" ", "")

    if label == "Aqua":
        return "LC_Aqua"
    if label == "Violet":
        return "RJ-45 Violet"
    if connector == "SC" and label in {"Orange", "Yellow"}:
        return f"SC_{label}"
    if connector == "LC":
        return f"LC_{label}"
    return f"RJ_45 {label}"


def get_correction(
    image_input,
    predicted_color: Optional[str] = None,
    tolerance: int = 6
) -> Optional[Tuple[str, str]]:
    """
    Look up a learned correction for a cable image.

    Args:
        image_input: PIL Image, image buffer (bytes), or file path
        predicted_color: the model's original prediction (for logging)
        tolerance: max Hamming distance for hash-based matching (default 6)

    Returns:
        (corrected_color, method) tuple where method is 'hash' or 'embedding',
        or None if no correction found
    """
    try:
        # Compute perceptual hash from the image
        if isinstance(image_input, bytes):
            img = Image.open(io.BytesIO(image_input)).convert("RGB")
            h = phash(img)
        elif isinstance(image_input, str):
            img = Image.open(image_input).convert("RGB")
            h = phash(img)
        elif isinstance(image_input, Image.Image):
            img = image_input.convert("RGB")
            h = phash(img)
        else:
            return None

        if not h:
            return None

        corrections = load_corrections()
        if not corrections:
            return None

        # Fast path: exact-ish hash match with tolerance
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
            corrected_label = _normalize_correction_label(best_label, best_record or {})
            print(f"[AL] Hash match (distance={best_dist}): {predicted_color} -> {corrected_label}")
            return (corrected_label, "hash")

        # If embedder available, try embedding-based matching for harder cases
        if HAS_EMBEDDER:
            try:
                from active_learning_Cache.embedder import embed, cos_sim
                emb = embed(img)

                # Try embedding similarity
                best_label = None
                best_record = None
                best_sim = 0.88  # similarity threshold
                for record in corrections.values():
                    stored_emb = record.get("embedding")
                    if not stored_emb:
                        continue
                    sim = cos_sim(emb, stored_emb)
                    if sim > best_sim:
                        best_label = record.get("label")
                        best_record = record
                        best_sim = sim

                if best_label:
                    corrected_label = _normalize_correction_label(best_label, best_record or {})
                    print(f"[AL] Embedding match (similarity={best_sim:.3f}): {predicted_color} -> {corrected_label}")
                    return (corrected_label, "embedding")
            except Exception as e:
                # Embedder load/run failed; already found hash match or will return None
                pass

    except Exception as e:
        print(f"[AL] Error in get_correction: {e}")

    return None


def get_corrections_summary() -> dict:
    """Get summary statistics about stored corrections."""
    try:
        corrections = load_corrections()
        return {
            "total_corrections": len(corrections),
            "file_path": str(CORRECTIONS_FILE),
            "labels": list(set(r.get("label") for r in corrections.values() if r.get("label"))),
        }
    except Exception as e:
        return {"error": str(e)}


if __name__ == "__main__":
    # Quick test
    summary = get_corrections_summary()
    print(f"Active Learning Summary: {summary}")

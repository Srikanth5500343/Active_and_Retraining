"""
Shared embedder module for active learning â€” used by both the Flask UI
and the production feedback system. Computes perceptual hash + ResNet18
embeddings for cable patches to store/lookup learned corrections.
"""

import numpy as np
import torch
import torchvision
from torchvision import transforms
from PIL import Image
from pathlib import Path

# Global state â€” initialized lazily
_DEVICE = None
_EMB_MODEL = None
_TF_224 = None

HASH_SIZE = 16
HAMMING_TOL = 6
SIM_THRESH = 0.88


def _init_embedder():
    """Initialize the embedder on first use."""
    global _DEVICE, _EMB_MODEL, _TF_224
    if _EMB_MODEL is not None:
        return

    _DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"[Embedder] Initializing on {_DEVICE}")

    _EMB_MODEL = torchvision.models.resnet18(
        weights=torchvision.models.ResNet18_Weights.DEFAULT
    )
    _EMB_MODEL.fc = torch.nn.Identity()
    _EMB_MODEL.eval().to(_DEVICE)

    _TF_224 = transforms.Compose([
        transforms.Resize((224, 224)),
        transforms.ToTensor(),
        transforms.Normalize(mean=[0.485, 0.456, 0.406],
                             std=[0.229, 0.224, 0.225]),
    ])


def phash(pil_img: Image.Image, size: int = HASH_SIZE) -> str:
    """Compute perceptual hash of an image."""
    g = pil_img.convert("L").resize((size, size), Image.BILINEAR)
    arr = np.asarray(g, dtype=np.float32)
    bits = (arr > arr.mean()).flatten()
    return "".join("1" if b else "0" for b in bits)


def hamming(a: str, b: str) -> int:
    """Hamming distance between two hash strings."""
    return sum(c1 != c2 for c1, c2 in zip(a, b)) if len(a) == len(b) else 10**9


def embed(pil_img: Image.Image) -> list:
    """Compute normalized ResNet18 embedding (normalized float32 vector)."""
    _init_embedder()
    with torch.no_grad():
        x = _TF_224(pil_img.convert("RGB")).unsqueeze(0).to(_DEVICE)
        v = _EMB_MODEL(x).squeeze(0).cpu().numpy()
        v = v / (np.linalg.norm(v) + 1e-9)
    return v.astype(np.float32).tolist()


def cos_sim(a, b) -> float:
    """Cosine similarity between two embedding vectors."""
    return float(np.dot(np.asarray(a, dtype=np.float32),
                        np.asarray(b, dtype=np.float32)))


def find_correction(h: str, emb: list, corrections_dict: dict) -> tuple:
    """
    Find a matching correction by perceptual hash or embedding similarity.

    Returns:
        (label, method) where method is 'hash', 'embedding', or None
    """
    # Fast path: exact-ish perceptual hash match
    best, best_d = None, HAMMING_TOL + 1
    for stored_h, rec in corrections_dict.items():
        d = hamming(h, stored_h)
        if d < best_d:
            best, best_d = rec["label"], d
    if best is not None:
        return best, "hash"

    # Robust path: cosine similarity on embeddings
    best, best_s = None, SIM_THRESH
    for rec in corrections_dict.values():
        v = rec.get("embedding")
        if not v:
            continue
        s = cos_sim(emb, v)
        if s > best_s:
            best, best_s = rec["label"], s
    if best is not None:
        return best, "embedding"

    return None, None

"""
Device-model lookup — ground-truth port count from the brand label.

Many switches and patch panels have their model name printed on the
faceplate (e.g. "TL-SG2428P", "DGS-1016D"). When the visual port-count
detector is fooled by cable occlusion or double-row layouts, OCR'ing
the device crop and matching the recovered text against a small known-
model table gives us a reliable port count.

Two pieces:
  - DEVICE_MODELS: dict of canonical model regex → (port_count, sfp_ports)
  - read_device_model(crop) -> (model_str | None, ports | None, sfp | None)

The OCR backend is auto-detected (EasyOCR preferred, pytesseract second).
If neither is installed read_device_model() returns (None, None, None) so
callers can fall back to the visual count without crashing.

To enable on Windows:
  - EasyOCR:  `pip install easyocr` (one-shot ~64 MB model download)
  - Tesseract: install from https://github.com/UB-Mannheim/tesseract/wiki
              + `pip install pytesseract`
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class ModelSpec:
    pattern: re.Pattern[str]
    port_count: int
    sfp_ports: int = 0
    canonical: str = ""


# Compact whitelist. Each entry maps a regex (case-insensitive, allowing
# common typo/spacing variants) to total RJ45 ports + SFP ports.
# Sources: vendor datasheets. Add liberally — the matcher is regex so
# new device names just need one line.
DEVICE_MODELS: list[ModelSpec] = [
    # ── TP-Link (Smart / Managed Gigabit) ─────────────────────────────────
    ModelSpec(re.compile(r"\bTL[-\s]?SG[-\s]?2428P\b",  re.I), 24,  4, "TL-SG2428P"),
    ModelSpec(re.compile(r"\bTL[-\s]?SG[-\s]?3428P?\b", re.I), 24,  4, "TL-SG3428"),
    ModelSpec(re.compile(r"\bTL[-\s]?SG[-\s]?1016\b",   re.I), 16,  0, "TL-SG1016"),
    ModelSpec(re.compile(r"\bTL[-\s]?SG[-\s]?1024\b",   re.I), 24,  0, "TL-SG1024"),
    ModelSpec(re.compile(r"\bTL[-\s]?SG[-\s]?108E?\b",  re.I),  8,  0, "TL-SG108"),

    # ── D-Link (DGS series) ───────────────────────────────────────────────
    ModelSpec(re.compile(r"\bDGS[-\s]?1016[A-Z]?\b",    re.I), 16,  0, "DGS-1016D"),
    ModelSpec(re.compile(r"\bDGS[-\s]?1024[A-Z]?\b",    re.I), 24,  0, "DGS-1024"),
    ModelSpec(re.compile(r"\bDGS[-\s]?1100[-\s]?16\b",  re.I), 16,  0, "DGS-1100-16"),
    ModelSpec(re.compile(r"\bDGS[-\s]?1210[-\s]?28\b",  re.I), 24,  4, "DGS-1210-28"),
    ModelSpec(re.compile(r"\bDGS[-\s]?1210[-\s]?48\b",  re.I), 48,  4, "DGS-1210-48"),
    ModelSpec(re.compile(r"\bDGS[-\s]?3000[-\s]?52\b",  re.I), 48,  4, "DGS-3000-52"),
    ModelSpec(re.compile(r"\bDGS[-\s]?3120[-\s]?48\b",  re.I), 48,  4, "DGS-3120-48"),

    # ── Cisco Catalyst (compact subset; trailing letter suffix optional) ──
    ModelSpec(re.compile(r"\bCATALYST.{0,4}2960X[-\s]?24[A-Z]?", re.I), 24,  0, "Catalyst 2960X-24"),
    ModelSpec(re.compile(r"\bCATALYST.{0,4}9300[-\s]?24[A-Z]?",  re.I), 24,  4, "Catalyst 9300-24"),
    ModelSpec(re.compile(r"\bCATALYST.{0,4}9300[-\s]?48[A-Z]?",  re.I), 48,  4, "Catalyst 9300-48"),
    ModelSpec(re.compile(r"\bCATALYST.{0,4}9500[-\s]?32[A-Z]?",  re.I), 32,  0, "Catalyst 9500-32"),

    # ── Patch panels (model strings vary widely; match the format clue) ──
    # "CAT.6 1-48" or "CAT6-48" pattern → 48-port copper patch panel
    ModelSpec(re.compile(r"\bCAT[\.\s]?6.{0,8}48\b",          re.I), 48, 0, "Cat6 48-port panel"),
    ModelSpec(re.compile(r"\bCAT[\.\s]?6.{0,8}24\b",          re.I), 24, 0, "Cat6 24-port panel"),
    ModelSpec(re.compile(r"\bPATCH.{0,10}48\b",                re.I), 48, 0, "48-port patch panel"),
    ModelSpec(re.compile(r"\bPATCH.{0,10}24\b",                re.I), 24, 0, "24-port patch panel"),
]


def match_model(text: str) -> Optional[ModelSpec]:
    """Return the first ModelSpec whose pattern matches the OCR text."""
    if not text:
        return None
    for spec in DEVICE_MODELS:
        if spec.pattern.search(text):
            return spec
    return None


# ─────────────────────────────────────────────────────────────────────────
# OCR backend dispatch — lazy-loaded so importing this module is cheap.
# ─────────────────────────────────────────────────────────────────────────

_OCR_READER = None       # cached EasyOCR Reader, when available
_OCR_BACKEND: Optional[str] = None


def _init_ocr() -> Optional[str]:
    """Detect and cache the available OCR backend. Returns 'easyocr' /
    'tesseract' / None."""
    global _OCR_READER, _OCR_BACKEND
    if _OCR_BACKEND is not None:
        return _OCR_BACKEND if _OCR_BACKEND != "none" else None

    try:
        import easyocr  # type: ignore
        # GPU off by default — keeps memory low and avoids CUDA surprises.
        _OCR_READER = easyocr.Reader(['en'], gpu=False, verbose=False)
        _OCR_BACKEND = "easyocr"
        return "easyocr"
    except Exception:
        pass

    try:
        import pytesseract  # type: ignore
        _ = pytesseract.get_tesseract_version()  # noqa: F841 — probe
        _OCR_BACKEND = "tesseract"
        return "tesseract"
    except Exception:
        pass

    _OCR_BACKEND = "none"
    return None


def ocr_text(image_bgr) -> str:
    """Run OCR on a BGR image (numpy array). Returns concatenated text,
    or empty string if no OCR backend is available."""
    backend = _init_ocr()
    if not backend:
        return ""
    if backend == "easyocr":
        try:
            results = _OCR_READER.readtext(image_bgr, detail=0, paragraph=True)
            return " ".join(r for r in results if isinstance(r, str))
        except Exception:
            return ""
    if backend == "tesseract":
        try:
            import cv2
            import pytesseract  # type: ignore
            gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY) if image_bgr.ndim == 3 else image_bgr
            return pytesseract.image_to_string(gray, config="--psm 6") or ""
        except Exception:
            return ""
    return ""


def read_device_model(image_bgr) -> tuple[Optional[str], Optional[int], Optional[int]]:
    """Try to recognise the device model from its faceplate.

    Returns (canonical_name, total_rj45_ports, sfp_ports) on success, or
    (None, None, None) if OCR is unavailable or no known model matched.
    """
    text = ocr_text(image_bgr)
    if not text:
        return None, None, None
    spec = match_model(text)
    if not spec:
        return None, None, None
    return spec.canonical, spec.port_count, spec.sfp_ports

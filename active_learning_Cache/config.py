"""
Central configuration for the active-learning cache.

One source of truth for paths and thresholds, so changing a threshold
doesn't require greping three files. Resolve everything relative to the
repo root so the layout works on any machine (no hard-coded paths).
"""

import os
from pathlib import Path


def _env_int(name: str, default: int) -> int:
    """Read an int from env, falling back to default if unset/invalid.
    Negative or zero values are treated as the default (env can't disable
    a threshold, only lower/raise it)."""
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        v = int(raw)
        return v if v > 0 else default
    except ValueError:
        return default

# ── Paths ─────────────────────────────────────────────────────────────
# This file lives at <repo>/active_learning_Cache/config.py — repo root
# is two parents up.
PACKAGE_DIR = Path(__file__).resolve().parent
REPO_ROOT   = PACKAGE_DIR.parent

# Per-model staging area. Subdirectory created on first use.
DATA_DIR = PACKAGE_DIR / "data"

# Where the production server appends user-corrected feedback.
SERVER_FEEDBACK_JSONL = REPO_ROOT / "server" / "feedback.jsonl"
SERVER_FEEDBACK_WRONG_DIR = REPO_ROOT / "server" / "feedback" / "wrong"

# Marker file that tracks which feedback.jsonl rows we've already
# ingested, so re-running `cli ingest` is idempotent.
INGEST_CURSOR = DATA_DIR / ".ingest_cursor"


# ── Models ────────────────────────────────────────────────────────────
# Names match the keys used in retraining_learning/registry.json.
# Add new models here; the rest of the system auto-discovers them.
MODELS = ("devices", "cable", "port_count")


# ── Thresholds ────────────────────────────────────────────────────────
# When `store.count(model) >= RETRAIN_THRESHOLDS[model]` the runner in
# retraining_learning/ will export the queue and kick off training.
#
# Tune these per model:
#   - Object detection (YOLO devices) wants ~200-500 corrections/class
#     to move the needle without overfitting.
#   - Single-label classification (cable type) needs more (≥ 30/class
#     across the 14 classes — start at 200 total to ship something).
#   - port_count is a small regression-style head, ~100 should do.
#
# Override per-model with env vars so dev/demo can verify the full loop
# without queuing hundreds of corrections by hand:
#   RETRAIN_THRESHOLD_DEVICES=5  RETRAIN_THRESHOLD_CABLE=3  RETRAIN_THRESHOLD_PORT_COUNT=3
RETRAIN_THRESHOLDS = {
    "devices":    _env_int("RETRAIN_THRESHOLD_DEVICES",    200),
    "cable":      _env_int("RETRAIN_THRESHOLD_CABLE",      200),
    "port_count": _env_int("RETRAIN_THRESHOLD_PORT_COUNT", 100),
}


# ── Low-confidence sampling ───────────────────────────────────────────
# Inferences with top-class confidence below this threshold are queued
# as candidate labels (active-learning's classic uncertainty sampling).
# The user gets prompted on the cases the model is most unsure about.
# Set to 0.0 to disable.
LOW_CONF_THRESHOLDS = {
    "devices":    0.55,
    "cable":      0.50,
    "port_count": 0.60,
}


# ── Optional: cap on stored samples per model (anti-runaway) ──────────
# 0 = unlimited. If non-zero, store.add() rejects new samples once the
# pending count hits this. Use as a circuit-breaker for noisy ingest.
MAX_PENDING_PER_MODEL = {
    "devices":    5000,
    "cable":      5000,
    "port_count": 2000,
}


def model_dir(model: str) -> Path:
    """Per-model staging directory: <data>/<model>/."""
    if model not in MODELS:
        raise ValueError(f"unknown model {model!r}; known: {MODELS}")
    p = DATA_DIR / model
    p.mkdir(parents=True, exist_ok=True)
    return p


def samples_dir(model: str) -> Path:
    p = model_dir(model) / "samples"
    p.mkdir(parents=True, exist_ok=True)
    return p


def corrections_log(model: str) -> Path:
    return model_dir(model) / "corrections.jsonl"


def manifest_path(model: str) -> Path:
    return model_dir(model) / "manifest.json"

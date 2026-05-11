"""
Retrain-side configuration. Pulls thresholds from the cache config so
the two sides can never disagree.
"""

from pathlib import Path

# Cache-side config is the single source of truth for thresholds + model list.
from active_learning_Cache import config as cache_config

PACKAGE_DIR = Path(__file__).resolve().parent
REPO_ROOT   = PACKAGE_DIR.parent

# Where each retrain attempt's artifacts go (snapshot, log, metrics, .pt).
RUNS_DIR = PACKAGE_DIR / "runs"

# Frozen validation sets — never touched by retrain. The runner expects
# `holdout/<model>/` to contain whatever shape that model's evaluator
# wants (YOLO val.yaml, image folders by class, etc.).
HOLDOUT_DIR = PACKAGE_DIR / "holdout"

# Source of truth for which model file is currently in production.
REGISTRY_PATH = PACKAGE_DIR / "registry.json"

# Per-model trainer entry points. The runner shells out to these with
# cwd = runs/<model>-<run_id>/, and they must honor the runner contract:
#   * Read dataset.jsonl + image files from cwd (already staged there)
#   * Accept --holdout <path> argv
#   * Write best.pt + val_metrics.json into cwd before exit 0
#
# The runner_adapter.py files in each subdir wrap the existing trainer
# logic to implement that contract. The original main.py / main2.py
# scripts the user wrote are left untouched and can still be run
# directly for ad-hoc training.
TRAINER_ENTRY = {
    "devices":    PACKAGE_DIR / "Devices_Retraining" / "runner_adapter.py",
    "cable":      PACKAGE_DIR / "Cable_retraining"   / "runner_adapter.py",
    "port_count": None,  # not yet wired — runner will skip
}

# How long to give a trainer subprocess before killing it.
TRAINER_TIMEOUT_SEC = 60 * 60 * 4   # 4 hours

# Promotion gate: a candidate must beat the production model's primary
# metric by at least this much (absolute) to be promoted. Stops noisy
# tiny improvements from churning the production model.
PROMOTION_MIN_DELTA = {
    "devices":    0.005,   # ≥ +0.5pp accuracy on holdout
    "cable":      0.005,
    "port_count": 0.010,
}

# Which metric is the "primary" for the promotion check, per model.
# Trainers must emit a val_metrics.json containing at least this key.
PRIMARY_METRIC = {
    "devices":    "accuracy",
    "cable":      "accuracy",
    "port_count": "exact_match",
}

# Re-export from cache config so callers only import retraining_learning.config
MODELS = cache_config.MODELS
THRESHOLDS = cache_config.RETRAIN_THRESHOLDS


def trainer_path(model: str) -> Path | None:
    return TRAINER_ENTRY.get(model)


def holdout_path(model: str) -> Path:
    p = HOLDOUT_DIR / model
    p.mkdir(parents=True, exist_ok=True)
    return p


def run_dir(model: str, run_id: str) -> Path:
    p = RUNS_DIR / f"{model}-{run_id}"
    p.mkdir(parents=True, exist_ok=True)
    return p

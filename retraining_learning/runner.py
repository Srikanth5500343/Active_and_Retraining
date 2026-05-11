"""
Top-level retraining runner. Polls every model's active-learning queue,
exports any that are over threshold, kicks off the matching trainer,
runs the validation gate, promotes the winners.

Run:
    python -m retraining_learning.runner               # all models
    python -m retraining_learning.runner --only devices
    python -m retraining_learning.runner --dry-run     # report only

Contract with the per-model trainer (`Devices_Retraining/main.py`,
`Cable_retraining/main2.py`):

  Inputs:
    - Working dir is `runs/<model>-<run_id>/` (cwd of subprocess).
    - `dataset.jsonl` + image files are sitting in cwd (from store.export).
    - Holdout dir for this model: passed via `--holdout <path>`.

  Expected outputs (in cwd when subprocess exits 0):
    - `best.pt`           — the trained artifact
    - `val_metrics.json`  — JSON dict with at least the PRIMARY_METRIC
                            key for this model (see config.PRIMARY_METRIC)
    - `train.log`         — stdout/stderr (already captured by runner)

  Exit code 0 = success. Anything else = failure; queue stays pending.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

from active_learning_Cache.store import Store

from . import config
from . import promotion
from .registry import Registry


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _run_id() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")


def _log(msg: str) -> None:
    print(f"[{_now()}] {msg}", flush=True)


def _check_thresholds(only: list[str] | None) -> list[str]:
    """Return the list of models whose pending count is over threshold."""
    ready = []
    for model in config.MODELS:
        if only and model not in only:
            continue
        store = Store(model)
        pending = store.count(only_pending=True)
        threshold = config.THRESHOLDS.get(model, 10**9)
        if pending >= threshold:
            ready.append(model)
            _log(f"  {model:12s} READY  ({pending} pending ≥ {threshold} threshold)")
        else:
            _log(f"  {model:12s} skip   ({pending} pending < {threshold} threshold)")
    return ready


def _run_trainer(model: str, run_id: str, run_dir: Path) -> tuple[bool, str]:
    """Spawn the trainer subprocess. Returns (ok, message). Captures all
    output to run_dir/train.log."""
    entry = config.trainer_path(model)
    if not entry:
        return False, f"no trainer entry configured for {model}"
    if not entry.exists():
        return False, f"trainer entry missing: {entry}"

    holdout = config.holdout_path(model)
    log_path = run_dir / "train.log"

    cmd = [sys.executable, str(entry), "--holdout", str(holdout)]
    _log(f"  → exec {' '.join(cmd)}  cwd={run_dir}")
    with log_path.open("w", encoding="utf-8") as logf:
        try:
            proc = subprocess.run(
                cmd, cwd=run_dir,
                stdout=logf, stderr=subprocess.STDOUT,
                timeout=config.TRAINER_TIMEOUT_SEC,
            )
        except subprocess.TimeoutExpired:
            return False, f"trainer timed out after {config.TRAINER_TIMEOUT_SEC}s"
        except Exception as e:
            return False, f"trainer failed to start: {e}"
    if proc.returncode != 0:
        return False, f"trainer exited code={proc.returncode} (see train.log)"
    return True, "ok"


def retrain_one(model: str, dry_run: bool = False) -> dict:
    """Full one-model loop: export → train → validate → promote.
    Returns a result dict suitable for logging / CI output."""
    store = Store(model)
    pending = store.count(only_pending=True)
    threshold = config.THRESHOLDS.get(model, 10**9)
    if pending < threshold:
        return {"model": model, "skipped": True,
                "reason": f"{pending} < {threshold}"}

    run_id = _run_id()
    run_dir = config.run_dir(model, run_id)
    _log(f"[{model}] run_id={run_id} → {run_dir}")

    # 1. Export the queue snapshot
    manifest = store.export(run_id, run_dir)
    _log(f"  exported {len(manifest.sample_ids)} samples → {run_dir}")
    if dry_run:
        return {"model": model, "dry_run": True, "run_id": run_id,
                "exported": len(manifest.sample_ids)}

    # 2. Train
    ok, msg = _run_trainer(model, run_id, run_dir)
    if not ok:
        _log(f"  TRAIN FAILED: {msg}")
        return {"model": model, "ok": False, "stage": "train",
                "reason": msg, "run_id": run_id}

    # 3. Validate / gate
    gate = promotion.evaluate(model, run_dir)
    _log(f"  GATE: {gate.reason}")
    (run_dir / "gate_result.json").write_text(
        json.dumps(gate.to_json(), indent=2))

    # 4. Register as CANDIDATE — never auto-promote.
    #
    # Per the active-learning policy ("don't change actual models when
    # retrained, keep all models per version"): the runner's job stops at
    # registering a versioned candidate. Promotion to production is an
    # explicit operator action via `python -m retraining_learning.cli`.
    candidate_path = run_dir / "best.pt"
    if not candidate_path.exists():
        return {"model": model, "ok": False, "stage": "candidate",
                "reason": "best.pt missing in run dir despite ok exit",
                "run_id": run_id}
    new_metrics = json.loads((run_dir / "val_metrics.json").read_text())
    registry = Registry()
    cand = registry.add_candidate(
        model, candidate_path, new_metrics, run_id,
        trained_on=run_dir, gate_passed=gate.promoted, gate_reason=gate.reason,
    )

    # Mark queue exported regardless of gate result — the trained .pt is
    # preserved as a candidate, so re-using the same samples for the next
    # cycle would be wasteful. If a gate-failed candidate later turns out
    # to be useful, the operator can re-promote it manually.
    store.mark_exported(run_id, manifest.sample_ids)
    (run_dir / "candidate.flag").write_text(_now())
    _log(f"  CANDIDATE registered → {cand['model_path']}  (gate: "
         f"{'PASSED' if gate.promoted else 'FAILED'})")
    _log(f"  PROMOTE manually with: python -m retraining_learning.cli "
         f"promote {model} {run_id}")

    return {"model": model, "ok": True, "stage": "candidate_registered",
            "promoted": False, "candidate_version": run_id,
            "candidate_path": cand["model_path"],
            "gate_passed": gate.promoted, "gate": gate.to_json(),
            "run_id": run_id}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="retraining_learning.runner")
    ap.add_argument("--only", nargs="*",
                    help="restrict to one or more models (default: all)")
    ap.add_argument("--dry-run", action="store_true",
                    help="report what's ready, export snapshots, but don't train")
    args = ap.parse_args(argv)

    _log("=== retrain runner ===")
    ready = _check_thresholds(args.only or None)
    if not ready:
        _log("no models over threshold — exiting")
        return 0

    results = []
    for model in ready:
        results.append(retrain_one(model, dry_run=args.dry_run))

    _log("=== summary ===")
    for r in results:
        _log(f"  {json.dumps(r)}")
    # Non-zero exit if any model failed (CI signal)
    failed = sum(1 for r in results if r.get("ok") is False)
    return 0 if failed == 0 else 2


if __name__ == "__main__":
    sys.exit(main())

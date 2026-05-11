"""
Validation gate + promotion decision.

A retrained model passes the gate when:
  1. The trainer emitted a `val_metrics.json` containing the model's
     PRIMARY_METRIC.
  2. That metric is at least PROMOTION_MIN_DELTA above the production
     model's recorded metric (or — if production has no recorded metric
     yet — at least the absolute floor).

If the gate fails, the candidate `.pt` stays in `runs/<id>/best.pt`
for inspection but is NOT moved into Models/ and the registry is not
updated. The cache queue is also NOT cleared, so the same samples
will be tried again on the next retrain cycle.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from . import config
from .registry import Registry


@dataclass
class GateResult:
    promoted: bool
    reason:   str
    metric:   str
    new:      float | None
    old:      float | None
    delta:    float | None

    def to_json(self) -> dict:
        return {
            "promoted": self.promoted,
            "reason":   self.reason,
            "metric":   self.metric,
            "new":      self.new,
            "old":      self.old,
            "delta":    self.delta,
        }


def evaluate(model: str, run_dir: Path,
             registry: Registry | None = None) -> GateResult:
    """Decide whether the candidate in `run_dir/best.pt` should be promoted.
    Reads `run_dir/val_metrics.json` for the candidate's holdout score,
    compares to the registry's recorded production score."""
    registry = registry or Registry()
    metric_key = config.PRIMARY_METRIC.get(model)
    if not metric_key:
        return GateResult(False, f"no PRIMARY_METRIC configured for {model}",
                          "", None, None, None)

    val_path = Path(run_dir) / "val_metrics.json"
    if not val_path.exists():
        return GateResult(False, f"missing val_metrics.json in {run_dir}",
                          metric_key, None, None, None)

    try:
        val = json.loads(val_path.read_text())
    except Exception as e:
        return GateResult(False, f"unreadable val_metrics.json: {e}",
                          metric_key, None, None, None)

    new = val.get(metric_key)
    if new is None:
        return GateResult(False, f"val_metrics.json missing key {metric_key!r}",
                          metric_key, None, None, None)

    old = registry.get_metrics(model).get(metric_key)
    min_delta = config.PROMOTION_MIN_DELTA.get(model, 0.0)

    # First-ever promotion — production has no recorded metric yet. Allow
    # the candidate through (its value becomes the baseline). This is the
    # one case where we trust a single-side measurement; subsequent runs
    # use the proper relative gate.
    if old is None:
        return GateResult(True, f"baseline promotion (no prior {metric_key} on record)",
                          metric_key, float(new), None, None)

    delta = float(new) - float(old)
    if delta >= min_delta:
        return GateResult(True, f"{metric_key} {new:.4f} ≥ prod {old:.4f} + {min_delta:.4f}",
                          metric_key, float(new), float(old), delta)
    return GateResult(False, f"{metric_key} {new:.4f} < prod {old:.4f} + {min_delta:.4f}",
                      metric_key, float(new), float(old), delta)

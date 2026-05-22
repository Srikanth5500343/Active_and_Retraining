"""
Model registry — tracks the production model and every retrained candidate.

Two-stage lifecycle:
  1. Retrain produces a CANDIDATE (one .pt per run, kept forever under
     Models/candidates/). Registered with metrics + provenance.
     ── DOES NOT change the production model. ──
  2. After human review, the operator manually PROMOTES a candidate. That's
     the only action that touches config.json (the file the pipeline workers
     read at startup).

This means: every retrained model is preserved (versioned), nothing is
deployed automatically, and the operator can A/B compare candidates against
prod indefinitely before pulling the trigger.

Public API (read):
    Registry().get(model)              → full entry (production + candidates)
    Registry().get_metrics(model)      → production model's metrics
    Registry().model_path(model)       → absolute path to production .pt
    Registry().candidates(model)       → list[dict] of all kept candidates
    Registry().candidate(model, ver)   → one candidate's full record

Public API (write):
    Registry().add_candidate(model, .pt path, metrics, run_id, trained_on)
        → copies .pt to Models/candidates/<model>-<run_id>.pt
        → appends to candidates[] (NEVER touches model_path)
    Registry().promote_candidate(model, version)
        → moves the candidate to active production
        → updates config.json so pipeline workers pick it up
        → records the previous prod entry in history[] for rollback
    Registry().reject_candidate(model, version, reason)
        → marks candidate rejected (kept on disk for audit / re-evaluation)
    Registry().rollback(model)
        → swap current production with the most recent history[] entry
"""

from __future__ import annotations

import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

from . import config


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


CANDIDATES_DIR = config.REPO_ROOT / "Models" / "candidates"


class Registry:
    def __init__(self, path: Path | None = None):
        self.path = path or config.REGISTRY_PATH
        if not self.path.exists():
            self._write({})
        CANDIDATES_DIR.mkdir(parents=True, exist_ok=True)

    # ── reads ─────────────────────────────────────────────────────────

    def all(self) -> dict:
        return self._read()

    def get(self, model: str) -> dict | None:
        return self._read().get(model)

    def get_metrics(self, model: str) -> dict:
        entry = self.get(model)
        return ((entry or {}).get("production") or {}).get("metrics") or {}

    def model_path(self, model: str) -> Path | None:
        entry = self.get(model)
        if not entry:
            return None
        rel = (entry.get("production") or {}).get("model_path")
        if not rel:
            return None
        p = Path(rel)
        return p if p.is_absolute() else (config.REPO_ROOT / rel)

    def candidates(self, model: str, include_rejected: bool = False) -> list[dict]:
        entry = self.get(model) or {}
        cands = entry.get("candidates", []) or []
        if include_rejected:
            return cands
        return [c for c in cands if not c.get("rejected")]

    def candidate(self, model: str, version: str) -> dict | None:
        for c in self.candidates(model, include_rejected=True):
            if c.get("version") == version:
                return c
        return None

    # ── writes: candidate stage ───────────────────────────────────────

    def add_candidate(self, model: str, candidate_path: Path,
                      metrics: dict, run_id: str,
                      trained_on: Path | None = None,
                      gate_passed: bool = True,
                      gate_reason: str = "") -> dict:
        """Register a freshly retrained model as a CANDIDATE.

        Copies the .pt under Models/candidates/<model>-<run_id>.<ext> so it's
        kept forever (versioned, immutable). Appends to candidates[]. Does
        NOT change which model is currently in production."""
        candidate_path = Path(candidate_path)
        if not candidate_path.exists():
            raise FileNotFoundError(candidate_path)

        canonical = CANDIDATES_DIR / f"{model}-{run_id}{candidate_path.suffix}"
        shutil.copyfile(candidate_path, canonical)
        rel_path = canonical.relative_to(config.REPO_ROOT).as_posix()
        rel_train = (trained_on.relative_to(config.REPO_ROOT).as_posix()
                     if trained_on else None)

        cand = {
            "version":       run_id,
            "model_path":    rel_path,
            "trained_on":    rel_train,
            "metrics":       metrics,
            "gate_passed":   bool(gate_passed),
            "gate_reason":   gate_reason,
            "trained_ts":    _now(),
            "promoted":      False,
            "rejected":      False,
            "evaluated_ts":  None,
            "notes":         None,
        }

        registry = self._read()
        entry = registry.get(model) or {"production": None, "candidates": [], "history": []}
        entry.setdefault("candidates", []).append(cand)
        registry[model] = entry
        self._write(registry)
        return cand

    # ── writes: promotion (operator action) ───────────────────────────

    def promote_candidate(self, model: str, version: str,
                          sync_to_config: bool = True) -> dict:
        """Make the named candidate the new production model.

        Updates the registry's `production` entry, demotes the prior
        production into `history[]` (for rollback), and — if
        `sync_to_config=True` — rewrites config.json's `models.<key>`
        path so the pipeline workers pick up the new file on next load."""
        cand = self.candidate(model, version)
        if cand is None:
            raise ValueError(f"no candidate {version!r} for model {model!r}")
        if cand.get("rejected"):
            raise ValueError(f"candidate {version!r} was rejected; un-reject first")

        registry = self._read()
        entry = registry.get(model) or {"production": None, "candidates": [], "history": []}

        # Push current production into history (for rollback)
        prior = entry.get("production")
        if prior:
            entry.setdefault("history", []).append({
                **prior,
                "demoted_ts": _now(),
            })

        # Promote the candidate
        new_prod = {
            "version":     cand["version"],
            "model_path":  cand["model_path"],
            "trained_on":  cand.get("trained_on"),
            "metrics":     cand.get("metrics", {}),
            "promoted_ts": _now(),
        }
        entry["production"] = new_prod
        # Mark the candidate row as promoted (kept in candidates[] for audit)
        for c in entry.get("candidates", []):
            if c.get("version") == version:
                c["promoted"] = True
                c["evaluated_ts"] = _now()
                break
        registry[model] = entry
        self._write(registry)

        if sync_to_config:
            self._sync_config_json(model, new_prod["model_path"])

        return new_prod

    # ── writes: reject + rollback ─────────────────────────────────────

    def reject_candidate(self, model: str, version: str, reason: str = "") -> dict:
        """Mark a candidate as rejected (poor performance / regression /
        operator's call). The .pt file stays on disk so the rejection can
        be revisited later."""
        registry = self._read()
        entry = registry.get(model) or {}
        for c in entry.get("candidates", []):
            if c.get("version") == version:
                c["rejected"] = True
                c["evaluated_ts"] = _now()
                c["notes"] = reason or c.get("notes")
                self._write(registry)
                return c
        raise ValueError(f"no candidate {version!r} for model {model!r}")

    def rollback(self, model: str, sync_to_config: bool = True) -> dict | None:
        """Roll the production model back to the most recent history[]
        entry. The current prod is pushed back into candidates[] (un-promoted)
        so it can be re-promoted later if desired."""
        registry = self._read()
        entry = registry.get(model)
        if not entry or not entry.get("history"):
            return None
        history = entry["history"]
        previous = history.pop()  # most recent
        previous.pop("demoted_ts", None)

        # Save the current prod back as a candidate (so we can roll forward)
        current = entry.get("production")
        if current:
            entry.setdefault("candidates", []).append({
                "version":      current.get("version"),
                "model_path":   current.get("model_path"),
                "trained_on":   current.get("trained_on"),
                "metrics":      current.get("metrics", {}),
                "gate_passed":  True,
                "gate_reason":  "rolled-back-from-prod",
                "trained_ts":   current.get("promoted_ts"),
                "promoted":     False,
                "rejected":     False,
                "evaluated_ts": _now(),
                "notes":        f"was production until {_now()}",
            })

        previous["promoted_ts"] = _now()
        entry["production"] = previous
        registry[model] = entry
        self._write(registry)
        if sync_to_config and previous.get("model_path"):
            self._sync_config_json(model, previous["model_path"])
        return previous

    # ── internals ─────────────────────────────────────────────────────

    def _read(self) -> dict:
        try:
            data = json.loads(self.path.read_text())
            data.pop("_doc", None)
            return data
        except Exception:
            return {}

    def _write(self, data: dict) -> None:
        out = {"_doc": "Production registry. Updated by retraining_learning. Each entry has 'production' (current) + 'candidates' (kept retrained models awaiting review) + 'history' (rollback chain)."}
        out.update(data)
        tmp = self.path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(out, indent=2))
        tmp.replace(self.path)

    def _sync_config_json(self, model: str, rel_path: str) -> None:
        """Write the new production path into config.json under models.<key>.
        Mapping registry-model-name → config.json key:
            devices    → 'devices' (and 'server' shares this for now)
            cable      → 'cable_classifier'
            port_count → 'port_count'
        Pipeline workers read config.json at startup; they pick up the new
        path on next reload / restart."""
        cfg_path = config.REPO_ROOT / "config.json"
        if not cfg_path.exists():
            return  # serving config not present (dev box without pipeline)
        try:
            cfg = json.loads(cfg_path.read_text())
        except Exception:
            return
        cfg.setdefault("models", {})
        key = {
            "devices":    "devices",
            "cable":      "cable_classifier",
            "port_count": "port_count",
        }.get(model)
        if not key:
            return
        cfg["models"][key] = rel_path
        # Atomic write
        tmp = cfg_path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(cfg, indent=2))
        tmp.replace(cfg_path)

"""
Per-model staging store for the active-learning queue.

Storage:
  - data/<model>/corrections.jsonl   append-only event log
  - data/<model>/samples/<id>.jpg    optional image artifact per sample
  - data/<model>/manifest.json       cached counters + retrain history

Why JSONL: every row is a self-contained training candidate, append-only
gives us a trivial audit trail, and any tool can read it (jq, pandas,
the trainers themselves). Manifest is a derived view — rebuildable from
the JSONL at any time, kept around for fast `count()` calls.

Public API:
    Store(model)
        .add(record, image_bytes=None) -> sample_id
        .count(only_pending=True)      -> int
        .list_pending()                -> Iterator[dict]
        .list_all()                    -> Iterator[dict]
        .export(run_id, dest_dir)      -> ExportManifest
        .mark_exported(run_id, ids)
        .clear(before=None)
        .stats()                       -> dict (count, threshold, last_export, ...)
"""

from __future__ import annotations

import json
import shutil
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Iterator

from . import config


# ── Sample lifecycle ──────────────────────────────────────────────────
# Every row in corrections.jsonl is one of three kinds:
#   1. "add"       — new training candidate
#   2. "export"    — marker that a batch was used in retrain run R
#   3. "supersede" — a later add() that replaces an earlier id (e.g. the
#                    user re-corrected the same image)
# The manifest is built by replaying these events, so the JSONL is the
# canonical truth.

KIND_ADD       = "add"
KIND_EXPORT    = "export"
KIND_SUPERSEDE = "supersede"

VALID_SOURCES = {"user_correction", "low_confidence", "flask_ui", "ingest"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _new_id() -> str:
    return uuid.uuid4().hex[:16]


@dataclass
class ExportManifest:
    """Returned by Store.export(). Hand it to the trainer."""
    run_id: str
    model: str
    dest_dir: Path
    sample_ids: list[str] = field(default_factory=list)
    exported_ts: str = field(default_factory=_now)

    def to_json(self) -> dict:
        return {
            "run_id": self.run_id,
            "model": self.model,
            "dest_dir": str(self.dest_dir),
            "sample_ids": self.sample_ids,
            "exported_ts": self.exported_ts,
            "count": len(self.sample_ids),
        }


class Store:
    def __init__(self, model: str):
        if model not in config.MODELS:
            raise ValueError(f"unknown model {model!r}; known: {config.MODELS}")
        self.model = model
        self.log_path = config.corrections_log(model)
        self.samples_dir = config.samples_dir(model)
        self.manifest_path = config.manifest_path(model)
        # Touch so callers can stat() reliably
        self.log_path.touch(exist_ok=True)

    # ── write ─────────────────────────────────────────────────────────

    def add(self, record: dict, image_bytes: bytes | None = None,
            image_ext: str = ".jpg") -> str:
        """Stage a new training candidate. Returns the sample id.

        `record` must minimally include `predicted` and `actual` dicts
        and a `source` from VALID_SOURCES. The store fills in id, model,
        added_ts, and image_path (if image_bytes provided)."""
        cap = config.MAX_PENDING_PER_MODEL.get(self.model, 0)
        if cap and self.count(only_pending=True) >= cap:
            raise RuntimeError(
                f"store {self.model!r} at cap ({cap} pending samples). "
                "Run a retrain export or raise MAX_PENDING_PER_MODEL.")

        source = record.get("source", "user_correction")
        if source not in VALID_SOURCES:
            raise ValueError(f"source {source!r} not in {VALID_SOURCES}")

        sid = record.get("id") or _new_id()
        ts = record.get("added_ts") or _now()

        image_rel = None
        if image_bytes is not None:
            ext = image_ext if image_ext.startswith(".") else "." + image_ext
            img_path = self.samples_dir / f"{sid}{ext}"
            img_path.write_bytes(image_bytes)
            # Store relative path so the JSONL is portable across machines
            image_rel = str(img_path.relative_to(config.REPO_ROOT)).replace("\\", "/")

        row = {
            "kind":       KIND_ADD,
            "id":         sid,
            "model":      self.model,
            "added_ts":   ts,
            "source":     source,
            "image_path": image_rel,
            **{k: v for k, v in record.items()
               if k not in ("id", "added_ts", "source", "image_path", "model")},
        }
        self._append(row)
        self._refresh_manifest()
        return sid

    def supersede(self, old_id: str, new_record: dict,
                  image_bytes: bytes | None = None) -> str:
        """Mark `old_id` as superseded by a fresh sample with corrected
        labels. Old row stays in the log for audit; only new is pending."""
        new_id = self.add(new_record, image_bytes)
        self._append({
            "kind":      KIND_SUPERSEDE,
            "id":        old_id,
            "by":        new_id,
            "ts":        _now(),
        })
        self._refresh_manifest()
        return new_id

    # ── read ──────────────────────────────────────────────────────────

    def list_all(self) -> Iterator[dict]:
        """All add events (including already-exported and superseded)."""
        for row in self._read_log():
            if row.get("kind") == KIND_ADD:
                yield row

    def list_pending(self) -> Iterator[dict]:
        """Adds not yet exported and not yet superseded — i.e. the
        actual training queue right now."""
        exported, superseded = self._derived_sets()
        for row in self.list_all():
            sid = row.get("id")
            if sid in exported or sid in superseded:
                continue
            yield row

    def count(self, only_pending: bool = True) -> int:
        return sum(1 for _ in (self.list_pending() if only_pending else self.list_all()))

    # ── retrain export ────────────────────────────────────────────────

    def export(self, run_id: str, dest_dir: Path) -> ExportManifest:
        """Snapshot all currently-pending samples into `dest_dir/` (copies
        images + writes a labels.jsonl). Returns an ExportManifest the
        trainer can hand to its dataset builder."""
        dest_dir = Path(dest_dir)
        dest_dir.mkdir(parents=True, exist_ok=True)
        ids: list[str] = []
        labels_path = dest_dir / "labels.jsonl"
        with labels_path.open("w", encoding="utf-8") as f:
            for row in self.list_pending():
                ids.append(row["id"])
                # Copy image (if any) into dest so the export is self-contained
                src_rel = row.get("image_path")
                exported_image_path = None
                if src_rel:
                    src_abs = config.REPO_ROOT / src_rel
                    if src_abs.exists():
                        dst = dest_dir / Path(src_rel).name
                        shutil.copyfile(src_abs, dst)
                        exported_image_path = dst.name
                out_row = dict(row)
                if exported_image_path is not None:
                    out_row["image_path"] = exported_image_path
                f.write(json.dumps(out_row) + "\n")
        return ExportManifest(
            run_id=run_id, model=self.model,
            dest_dir=dest_dir, sample_ids=ids,
        )

    def mark_exported(self, run_id: str, sample_ids: Iterable[str]) -> None:
        """Record that this batch has been used in retrain `run_id`. Once
        marked, those samples are no longer in `list_pending()` — but stay
        in `list_all()` for reproducibility."""
        sample_ids = list(sample_ids)
        self._append({
            "kind":         KIND_EXPORT,
            "run_id":       run_id,
            "model":        self.model,
            "ts":           _now(),
            "sample_ids":   sample_ids,
            "count":        len(sample_ids),
        })
        self._refresh_manifest()

    # ── housekeeping ──────────────────────────────────────────────────

    def clear(self, before: str | None = None) -> int:
        """Remove the JSONL + sample artifacts (older than `before` ISO
        date if provided). Returns rows removed. Use sparingly — this is
        the only operation that destroys data."""
        kept: list[dict] = []
        removed = 0
        for row in self._read_log():
            ts = row.get("added_ts") or row.get("ts")
            if before is None or (ts and ts >= before):
                kept.append(row)
            else:
                removed += 1
                src_rel = row.get("image_path")
                if src_rel:
                    src_abs = config.REPO_ROOT / src_rel
                    if src_abs.exists():
                        try: src_abs.unlink()
                        except Exception: pass
        # Rewrite the log atomically
        tmp = self.log_path.with_suffix(".jsonl.tmp")
        with tmp.open("w", encoding="utf-8") as f:
            for row in kept:
                f.write(json.dumps(row) + "\n")
        tmp.replace(self.log_path)
        self._refresh_manifest()
        return removed

    def stats(self) -> dict:
        return {
            "model":      self.model,
            "pending":    self.count(only_pending=True),
            "total":      self.count(only_pending=False),
            "threshold":  config.RETRAIN_THRESHOLDS.get(self.model, 0),
            "ready":      self.count(only_pending=True) >= config.RETRAIN_THRESHOLDS.get(self.model, 10**9),
            "last_export": self._last_export_ts(),
            "log_path":   str(self.log_path.relative_to(config.REPO_ROOT)).replace("\\", "/"),
        }

    # ── internals ─────────────────────────────────────────────────────

    def _append(self, row: dict) -> None:
        with self.log_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(row) + "\n")

    def _read_log(self) -> Iterator[dict]:
        if not self.log_path.exists():
            return
        with self.log_path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    # Corrupt line — skip but don't crash the whole queue
                    continue

    def _derived_sets(self) -> tuple[set[str], set[str]]:
        exported: set[str] = set()
        superseded: set[str] = set()
        for row in self._read_log():
            kind = row.get("kind")
            if kind == KIND_EXPORT:
                exported.update(row.get("sample_ids", []))
            elif kind == KIND_SUPERSEDE:
                superseded.add(row.get("id"))
        return exported, superseded

    def _last_export_ts(self) -> str | None:
        last = None
        for row in self._read_log():
            if row.get("kind") == KIND_EXPORT:
                last = row.get("ts")
        return last

    def _refresh_manifest(self) -> None:
        """Cache derived counters + history into manifest.json so other
        tooling can read summary state without scanning the JSONL."""
        history: list[dict] = []
        for row in self._read_log():
            if row.get("kind") == KIND_EXPORT:
                history.append({
                    "ts":      row.get("ts"),
                    "run_id":  row.get("run_id"),
                    "count":   row.get("count"),
                })
        manifest = {
            "model":         self.model,
            "pending":       self.count(only_pending=True),
            "total":         self.count(only_pending=False),
            "threshold":     config.RETRAIN_THRESHOLDS.get(self.model, 0),
            "last_export":   self._last_export_ts(),
            "history":       history,
            "refreshed_ts":  _now(),
        }
        self.manifest_path.write_text(json.dumps(manifest, indent=2))

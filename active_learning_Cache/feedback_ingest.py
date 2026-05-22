"""
Ingest user feedback from server/feedback.jsonl into the per-model
stores. Idempotent — a cursor file tracks the last byte offset we
read, so re-running is safe and cheap.

Mapping from feedback row → model:
    feedback_type == "port_count"       → model "port_count"
    feedback_type == "port"   (cable_*) → model "cable"
    feedback_type == "device"           → model "devices"
                                          (when the React UI starts logging
                                           device-class corrections)

Image artifacts referenced by the feedback row (`device_crop_image`,
`port_crop_image`) live in `server/feedback/wrong/`. We read them and
embed into the store so the export is self-contained.
"""

from __future__ import annotations

import json
from pathlib import Path

from . import config
from .store import Store


def _read_cursor() -> int:
    if not config.INGEST_CURSOR.exists():
        return 0
    try:
        return int(config.INGEST_CURSOR.read_text().strip() or "0")
    except ValueError:
        return 0


def _write_cursor(offset: int) -> None:
    config.INGEST_CURSOR.parent.mkdir(parents=True, exist_ok=True)
    config.INGEST_CURSOR.write_text(str(offset))


def _resolve_image(filename: str | None) -> bytes | None:
    """Look up an image in server/feedback/wrong/. Returns bytes or None
    if the file isn't there (some feedback rows have no crop saved)."""
    if not filename:
        return None
    p = config.SERVER_FEEDBACK_WRONG_DIR / filename
    if not p.exists():
        return None
    try:
        return p.read_bytes()
    except Exception:
        return None


def _route(row: dict) -> str | None:
    """Decide which model store this feedback row belongs to. Returns
    None if the row should be skipped (unknown type, or correct=true so
    nothing to learn from)."""
    if row.get("is_correct") is True:
        # Confirmed-correct rows are great as positive examples too, but
        # they don't move the needle on a model's weak points. Skip for
        # now; revisit if we want to use them as held-out validation.
        return None
    ft = (row.get("feedback_type") or "").lower()
    if ft == "port_count":
        return "port_count"
    if ft == "port":
        # Port-level feedback updates the cable classifier (color/connector)
        return "cable"
    if ft == "device":
        return "devices"
    return None


def _normalize(row: dict, model: str) -> dict:
    """Convert a server/feedback.jsonl row into the active-learning
    sample shape (`predicted` + `actual` dicts + metadata)."""
    base = {
        "source":       "ingest",
        "scan_id":      row.get("scanId"),
        "device_index": row.get("device_index"),
        "added_ts":     row.get("timestamp"),
        "metadata": {
            "device_class":        row.get("device_class"),
            "device_box":          row.get("device_box"),
            "feedback_type":       row.get("feedback_type"),
            "wrong_fields":        row.get("wrong_fields"),
        },
    }

    if model == "port_count":
        base["predicted"] = {"port_count": row.get("predicted_port_count")}
        base["actual"]    = {"port_count": row.get("actual_port_count")}

    elif model == "cable":
        base["predicted"] = {
            "port":         row.get("predicted_port"),
            "cable_color":  row.get("predicted_cable_color"),
        }
        base["actual"] = {
            "port":         row.get("actual_port"),
            "cable_color":  row.get("actual_cable_color"),
        }
        base["metadata"].update({
            "port_status":     row.get("port_status"),
            "cable_color":     row.get("cable_color"),
            "cable_connector": row.get("cable_connector"),
            "cable_type":      row.get("cable_type"),
            "port_location":   row.get("port_location"),
        })

    elif model == "devices":
        base["predicted"] = {"class": row.get("predicted_class")}
        base["actual"]    = {"class": row.get("actual_class")}

    return base


def ingest_server_feedback(verbose: bool = True) -> dict:
    """Pull all rows in server/feedback.jsonl past the saved cursor and
    add them to the appropriate per-model store. Returns a summary dict.
    Idempotent: cursor is updated only after successful pass."""
    src = config.SERVER_FEEDBACK_JSONL
    if not src.exists():
        return {"ok": False, "reason": f"missing {src}", "ingested": 0}

    start = _read_cursor()
    src_size = src.stat().st_size
    if start >= src_size:
        return {"ok": True, "ingested": 0, "reason": "no new rows"}

    by_model: dict[str, int] = {}
    skipped = 0
    end_offset = start
    stores: dict[str, Store] = {}

    with src.open("r", encoding="utf-8") as f:
        f.seek(start)
        for raw in f:
            end_offset += len(raw.encode("utf-8"))
            line = raw.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                skipped += 1
                continue

            model = _route(row)
            if not model:
                skipped += 1
                continue

            store = stores.get(model) or stores.setdefault(model, Store(model))
            normalized = _normalize(row, model)

            # Image: prefer port_crop, fall back to device_crop
            img_name = row.get("port_crop_image") or row.get("device_crop_image")
            img_bytes = _resolve_image(img_name)

            try:
                sid = store.add(normalized, image_bytes=img_bytes)
                by_model[model] = by_model.get(model, 0) + 1
                if verbose:
                    print(f"  + {model:11s} {sid}  scan={row.get('scanId')}")
            except Exception as e:
                skipped += 1
                if verbose:
                    print(f"  ! skipped {row.get('scanId')}: {e}")

    _write_cursor(end_offset)
    return {
        "ok":         True,
        "ingested":   sum(by_model.values()),
        "by_model":   by_model,
        "skipped":    skipped,
        "cursor":     end_offset,
        "src_size":   src_size,
    }

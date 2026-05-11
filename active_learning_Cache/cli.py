"""
Command-line surface for the active-learning cache.

    python -m active_learning_Cache.cli status
    python -m active_learning_Cache.cli ingest
    python -m active_learning_Cache.cli export <model> --to <dir> --run-id <id>
    python -m active_learning_Cache.cli clear  <model> [--before YYYY-MM-DD]

`status` is the daily one — prints how many corrections are queued per
model and whether each is over its retrain threshold. The retrain
runner in retraining_learning/ uses the same Store API directly, so
this CLI is mostly for humans poking at the queue.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from datetime import datetime, timezone

from . import config
from .store import Store
from .feedback_ingest import ingest_server_feedback


def cmd_status(args: argparse.Namespace) -> int:
    rows = []
    for model in config.MODELS:
        s = Store(model).stats()
        rows.append(s)

    # Pretty-print
    print(f"{'model':12s} {'pending':>9s} {'total':>9s} {'thresh':>8s}  ready  last_export")
    print("-" * 70)
    for s in rows:
        ready = "YES" if s["ready"] else " no"
        last = s["last_export"] or "—"
        print(f"{s['model']:12s} {s['pending']:>9d} {s['total']:>9d} "
              f"{s['threshold']:>8d}   {ready}   {last}")
    if args.json:
        print()
        print(json.dumps(rows, indent=2))
    return 0


def cmd_ingest(args: argparse.Namespace) -> int:
    print(f"Ingesting from {config.SERVER_FEEDBACK_JSONL}")
    res = ingest_server_feedback(verbose=args.verbose)
    print(json.dumps(res, indent=2))
    return 0 if res.get("ok") else 1


def cmd_export(args: argparse.Namespace) -> int:
    if args.model not in config.MODELS:
        print(f"unknown model {args.model!r}; known: {config.MODELS}", file=sys.stderr)
        return 2
    store = Store(args.model)
    pending = store.count(only_pending=True)
    if pending == 0:
        print(f"{args.model}: nothing to export.")
        return 0
    run_id = args.run_id or datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    dest = Path(args.to or (config.PACKAGE_DIR / "exports" / args.model / run_id))
    manifest = store.export(run_id, dest)
    print(json.dumps(manifest.to_json(), indent=2))
    if args.mark_exported:
        store.mark_exported(run_id, manifest.sample_ids)
        print(f"marked {len(manifest.sample_ids)} samples as exported under run {run_id!r}")
    return 0


def cmd_clear(args: argparse.Namespace) -> int:
    if args.model not in config.MODELS:
        print(f"unknown model {args.model!r}; known: {config.MODELS}", file=sys.stderr)
        return 2
    if not args.yes:
        print("refusing to clear without --yes (this destroys data)", file=sys.stderr)
        return 2
    store = Store(args.model)
    n = store.clear(before=args.before)
    print(f"removed {n} rows from {args.model}")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="active_learning_Cache.cli")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_status = sub.add_parser("status", help="show queue counters per model")
    p_status.add_argument("--json", action="store_true")

    p_ingest = sub.add_parser("ingest", help="pull server/feedback.jsonl into per-model stores")
    p_ingest.add_argument("-v", "--verbose", action="store_true")

    p_exp = sub.add_parser("export", help="snapshot a model's pending queue to a directory")
    p_exp.add_argument("model")
    p_exp.add_argument("--to", help="destination dir (default: exports/<model>/<run_id>)")
    p_exp.add_argument("--run-id", help="explicit run id (default: timestamp)")
    p_exp.add_argument("--mark-exported", action="store_true",
                       help="record the export so these samples won't re-train next cycle")

    p_clr = sub.add_parser("clear", help="delete samples (use --before YYYY-MM-DD to prune old)")
    p_clr.add_argument("model")
    p_clr.add_argument("--before", help="ISO date; only remove samples older than this")
    p_clr.add_argument("--yes", action="store_true", help="confirm destructive op")

    args = ap.parse_args(argv)

    return {
        "status": cmd_status,
        "ingest": cmd_ingest,
        "export": cmd_export,
        "clear":  cmd_clear,
    }[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())

"""
Operator CLI for the retraining loop.

Production models change ONLY through this CLI. The runner's job is to
produce versioned candidates; you decide which one ships.

    # see what's in production + every retrained candidate
    python -m retraining_learning.cli status
    python -m retraining_learning.cli list devices
    python -m retraining_learning.cli show devices 20260507-143012

    # change which candidate is in production (writes to config.json)
    python -m retraining_learning.cli promote devices 20260507-143012
    python -m retraining_learning.cli reject  devices 20260507-143012 \
            --reason "regressed on dark-rack samples"
    python -m retraining_learning.cli rollback devices

    # bulk: trigger one full ingest+retrain cycle (same as runner.py)
    python -m retraining_learning.cli cycle [--only devices]

    # ad-hoc: re-sync config.json from the registry's current production
    python -m retraining_learning.cli sync
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

from . import config
from .registry import Registry


def _fmt_metric(v):
    if v is None: return "—"
    if isinstance(v, float): return f"{v:.4f}"
    return str(v)


# ── status / list / show ──────────────────────────────────────────────

def cmd_status(args):
    reg = Registry()
    print(f"{'model':12s} {'production':28s} {'cand':>5s} {'rej':>4s} {'history':>8s}")
    print("-" * 70)
    for model in config.MODELS:
        entry = reg.get(model) or {}
        prod = entry.get("production") or {}
        ver = prod.get("version", "—")
        path = prod.get("model_path", "—")
        cands = entry.get("candidates", [])
        n_cand = sum(1 for c in cands if not c.get("rejected") and not c.get("promoted"))
        n_rej = sum(1 for c in cands if c.get("rejected"))
        n_hist = len(entry.get("history", []))
        print(f"{model:12s} {ver+'  ('+Path(path).name+')':28s} "
              f"{n_cand:>5d} {n_rej:>4d} {n_hist:>8d}")
    return 0


def cmd_list(args):
    reg = Registry()
    cands = reg.candidates(args.model, include_rejected=args.all)
    if not cands:
        print(f"no candidates for {args.model}")
        return 0
    metric_key = config.PRIMARY_METRIC.get(args.model, "?")
    print(f"{'version':22s} {'gate':>6s} {metric_key:>10s} {'state':>10s}  trained")
    print("-" * 70)
    for c in cands:
        state = ("PROMOTED" if c.get("promoted")
                 else "REJECTED" if c.get("rejected")
                 else "candidate")
        gate = "pass" if c.get("gate_passed") else "fail"
        m = (c.get("metrics") or {}).get(metric_key)
        print(f"{c['version']:22s} {gate:>6s} {_fmt_metric(m):>10s} "
              f"{state:>10s}  {c.get('trained_ts','')}")
    return 0


def cmd_show(args):
    reg = Registry()
    cand = reg.candidate(args.model, args.version)
    if cand is None:
        print(f"no candidate {args.version!r} for {args.model}", file=sys.stderr)
        return 2
    print(json.dumps(cand, indent=2))
    return 0


# ── promote / reject / rollback ───────────────────────────────────────

def cmd_promote(args):
    reg = Registry()
    cand = reg.candidate(args.model, args.version)
    if cand is None:
        print(f"no candidate {args.version!r} for {args.model}", file=sys.stderr)
        return 2
    print(f"current production: {(reg.get(args.model) or {}).get('production', {}).get('version')}")
    print(f"new production:     {args.version}")
    print(f"candidate metrics:  {json.dumps(cand.get('metrics', {}), indent=2)}")
    if not args.yes:
        print("  ↳ refusing to promote without --yes (rewrites config.json + serves new model on next worker reload)", file=sys.stderr)
        return 2
    new_prod = reg.promote_candidate(args.model, args.version,
                                     sync_to_config=not args.no_sync)
    print(f"PROMOTED {args.model} → {new_prod['model_path']}")
    if not args.no_sync:
        print(f"config.json updated. Restart pipeline workers to reload.")
    return 0


def cmd_reject(args):
    reg = Registry()
    cand = reg.reject_candidate(args.model, args.version, reason=args.reason or "")
    print(f"REJECTED {args.model} {args.version}")
    print(f"  reason: {cand.get('notes') or '(none given)'}")
    print(f"  .pt kept on disk at: {cand.get('model_path')}")
    return 0


def cmd_rollback(args):
    reg = Registry()
    if not args.yes:
        print("refusing to rollback without --yes (rewrites config.json)", file=sys.stderr)
        return 2
    prev = reg.rollback(args.model, sync_to_config=not args.no_sync)
    if prev is None:
        print(f"no history to roll back to for {args.model}")
        return 1
    print(f"ROLLED BACK {args.model} → {prev['model_path']} (was version {prev['version']})")
    return 0


# ── full cycle (ingest + retrain) ─────────────────────────────────────

def cmd_cycle(args):
    """Run one full ingest + retrain cycle. Equivalent to:
        python -m active_learning_Cache.cli ingest
        python -m retraining_learning.runner [--only ...]
    """
    print("=== step 1/2: ingesting fresh feedback ===")
    r1 = subprocess.run(
        [sys.executable, "-m", "active_learning_Cache.cli", "ingest"],
        cwd=config.REPO_ROOT,
    )
    if r1.returncode != 0:
        print("ingest failed; aborting cycle", file=sys.stderr)
        return r1.returncode
    print("=== step 2/2: running retrain runner ===")
    cmd = [sys.executable, "-m", "retraining_learning.runner"]
    if args.only:
        cmd += ["--only", *args.only]
    if args.dry_run:
        cmd += ["--dry-run"]
    r2 = subprocess.run(cmd, cwd=config.REPO_ROOT)
    return r2.returncode


# ── sync config.json from registry ────────────────────────────────────

def cmd_sync(args):
    """Re-write config.json's models.* paths from the registry's current
    production entries. Useful if config.json was hand-edited and you
    want to restore the registry's view."""
    reg = Registry()
    written = []
    for model in config.MODELS:
        entry = reg.get(model) or {}
        prod = entry.get("production") or {}
        rel_path = prod.get("model_path")
        if rel_path:
            reg._sync_config_json(model, rel_path)
            written.append(f"{model} → {rel_path}")
    if written:
        print("config.json synced:")
        for w in written:
            print(f"  {w}")
    else:
        print("nothing to sync (registry has no production entries)")
    return 0


# ── argparse wiring ───────────────────────────────────────────────────

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="retraining_learning.cli")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("status", help="one-line per model: production + candidate counts")

    p_list = sub.add_parser("list", help="list candidates for a model")
    p_list.add_argument("model")
    p_list.add_argument("--all", action="store_true", help="include rejected")

    p_show = sub.add_parser("show", help="full record for one candidate")
    p_show.add_argument("model")
    p_show.add_argument("version")

    p_prom = sub.add_parser("promote", help="make a candidate the production model")
    p_prom.add_argument("model")
    p_prom.add_argument("version")
    p_prom.add_argument("--yes", action="store_true",
                        help="confirm: writes config.json + changes serving")
    p_prom.add_argument("--no-sync", action="store_true",
                        help="update registry but do NOT touch config.json")

    p_rej = sub.add_parser("reject", help="mark a candidate as rejected (kept on disk)")
    p_rej.add_argument("model")
    p_rej.add_argument("version")
    p_rej.add_argument("--reason", help="freeform notes")

    p_rb = sub.add_parser("rollback", help="restore the previous production model")
    p_rb.add_argument("model")
    p_rb.add_argument("--yes", action="store_true",
                      help="confirm: writes config.json")
    p_rb.add_argument("--no-sync", action="store_true")

    p_cyc = sub.add_parser("cycle", help="ingest + run retrain in one step")
    p_cyc.add_argument("--only", nargs="*")
    p_cyc.add_argument("--dry-run", action="store_true")

    sub.add_parser("sync", help="re-write config.json from registry production entries")

    args = ap.parse_args(argv)
    return {
        "status":   cmd_status,
        "list":     cmd_list,
        "show":     cmd_show,
        "promote":  cmd_promote,
        "reject":   cmd_reject,
        "rollback": cmd_rollback,
        "cycle":    cmd_cycle,
        "sync":     cmd_sync,
    }[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())

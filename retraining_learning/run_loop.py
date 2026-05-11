"""
Long-running scheduler that runs ingest + retrain on a fixed cadence.

Designed to be supervised by systemd / Docker / `pm2`. NOT intended to
run inside the Node API server (a retrain spike would flap request
latency).

    python -m retraining_learning.run_loop                     # default 1h cadence
    python -m retraining_learning.run_loop --interval-min 30   # every 30 min
    python -m retraining_learning.run_loop --once              # one cycle then exit (cron-style)

Each cycle:
  1. Pull fresh feedback rows from server/feedback.jsonl into the cache
     stores (idempotent via byte-offset cursor).
  2. For each model whose pending count is over its threshold:
       a. Export the queue snapshot.
       b. Spawn the trainer adapter as a subprocess.
       c. On success + gate pass → register as a CANDIDATE (kept under
          Models/candidates/<model>-<run_id>.pt). DOES NOT change the
          production model — promotion is a deliberate operator action
          via `python -m retraining_learning.cli promote ...`.

Exit codes:
   0  success (or `--once` and nothing was ready)
   1  ingest failed (treated as warning; loop continues if not --once)
   2  one or more trainers failed (loop continues if not --once)
"""

from __future__ import annotations

import argparse
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from . import config


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _log(msg: str) -> None:
    print(f"[{_now()}] [run_loop] {msg}", flush=True)


def run_one_cycle(only: list[str] | None = None) -> int:
    """One full ingest + retrain. Returns the worse of the two exit codes."""
    _log("=== cycle start ===")

    # 1) ingest
    _log("ingest: pulling server/feedback.jsonl …")
    r1 = subprocess.run(
        [sys.executable, "-m", "active_learning_Cache.cli", "ingest"],
        cwd=config.REPO_ROOT,
    )
    if r1.returncode != 0:
        _log(f"ingest failed (exit {r1.returncode}); continuing with retrain anyway")

    # 2) retrain runner
    _log("retrain: checking thresholds …")
    cmd = [sys.executable, "-m", "retraining_learning.runner"]
    if only:
        cmd += ["--only", *only]
    r2 = subprocess.run(cmd, cwd=config.REPO_ROOT)
    if r2.returncode != 0:
        _log(f"runner reported issues (exit {r2.returncode})")

    _log("=== cycle done ===")
    return max(r1.returncode, r2.returncode)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="retraining_learning.run_loop")
    ap.add_argument("--interval-min", type=float, default=60.0,
                    help="minutes between cycles (default 60)")
    ap.add_argument("--once", action="store_true",
                    help="run one cycle then exit (cron mode)")
    ap.add_argument("--only", nargs="*",
                    help="restrict to one or more models")
    args = ap.parse_args(argv)

    if args.once:
        return run_one_cycle(args.only)

    # Long-running: handle SIGTERM gracefully so systemd stop is clean
    stopping = {"flag": False}
    def _stop(*_):
        stopping["flag"] = True
        _log("SIGTERM received — finishing current cycle then exiting")
    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)

    interval_sec = max(60.0, args.interval_min * 60.0)
    _log(f"scheduler started — cycle every {args.interval_min} min")
    while not stopping["flag"]:
        try:
            run_one_cycle(args.only)
        except Exception as e:
            _log(f"cycle crashed: {e!r}")
        if stopping["flag"]:
            break
        # Sleep in small chunks so SIGTERM is responsive
        target = time.monotonic() + interval_sec
        while not stopping["flag"] and time.monotonic() < target:
            time.sleep(min(5.0, target - time.monotonic()))
    _log("exiting cleanly")
    return 0


if __name__ == "__main__":
    sys.exit(main())

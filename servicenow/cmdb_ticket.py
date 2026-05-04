"""
cmdb_ticket.py — opens, polls, and applies CMDB-sync Service Requests.

Lifecycle for each rack:
                        ┌──────────────────────────────────────┐
   scan completes  ─→   │ diff_cmdb.compute_diff()             │
                        │   if non-empty + no open ticket:     │
                        │     POST /table/sc_request           │
                        │     write cmdb_ticket.json (open)    │
                        └──────────────────────────────────────┘
                                       │
   poll cycle (every 5 min) ──────────┐│
                        ┌──────────────▼───────────────────────┐
                        │ for each cmdb_ticket.json with       │
                        │   state == "open":                   │
                        │     GET /table/sc_request/<sys_id>   │
                        │     map SN state → local state       │
                        │     if approved+complete:            │
                        │        run bootstrap_cmdb_full       │
                        │        mark applied                  │
                        │     elif rejected/cancelled:         │
                        │        mark rejected                 │
                        └──────────────────────────────────────┘

The local state file is the single source of truth for the UI banner:

    outputs/<rackId>/cmdb_ticket.json:
    {
      schema:          "cmdb_ticket.v1",
      rack_id:         "RK-...",
      number:          "REQ0012345",
      sys_id:          "abc123...",
      state:           "open" | "applied" | "rejected" | "cancelled",
      sn_state:        "<raw SN state code>",
      sn_approval:     "<requested|approved|rejected>",
      diff_hash:       "<sha256 prefix>",
      summary:         { ... mirror of diff.summary ... },
      opened_at:       "2026-04-30T...Z",
      last_polled_at:  "2026-04-30T...Z",
      applied_at:      null | "...",
      apply_error:     null | "...",
      ticket_url:      "https://<inst>.service-now.com/nav_to.do?uri=sc_request.do?sys_id=...",
    }

CLI:
    python cmdb_ticket.py create  --rack-id RK-XXX
    python cmdb_ticket.py poll                    # sweep all open tickets
    python cmdb_ticket.py status  --rack-id RK-XXX
    python cmdb_ticket.py cancel  --rack-id RK-XXX
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

try:
    from dotenv import load_dotenv
    load_dotenv(HERE / ".env")
except Exception:
    pass

import requests
from servicenow import ServiceNowClient
from diff_cmdb import compute_diff, diff_is_empty, render_diff_text


OUTPUTS_BASE = ROOT / "outputs"
SCHEMA = "cmdb_ticket.v1"

# ServiceNow sc_request state values vary by instance customisation, but the
# OOTB defaults are widely used. We cover the common ones and fall through
# to "open" for anything we don't recognise.
SN_STATE_OPEN_VALUES     = {"-5", "1", "2", "in_process", "open", "requested"}
SN_STATE_COMPLETE_VALUES = {"3", "closed_complete", "closed complete"}
SN_STATE_REJECTED_VALUES = {"4", "closed_incomplete", "rejected"}
SN_STATE_CANCELLED_VALUES = {"7", "closed_skipped", "closed_cancelled", "cancelled"}

SN_APPROVAL_APPROVED = {"approved"}
SN_APPROVAL_REJECTED = {"rejected", "not yet requested"}


# ─────────────────────────────────────────────────────────────────────────
# Local state file
# ─────────────────────────────────────────────────────────────────────────

def _ticket_path(rack_id: str) -> Path:
    return OUTPUTS_BASE / rack_id / "cmdb_ticket.json"


def read_ticket(rack_id: str) -> dict | None:
    p = _ticket_path(rack_id)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def write_ticket(rack_id: str, data: dict) -> None:
    p = _ticket_path(rack_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    os.replace(tmp, p)


def clear_ticket(rack_id: str) -> bool:
    p = _ticket_path(rack_id)
    if p.exists():
        p.unlink()
        return True
    return False


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ─────────────────────────────────────────────────────────────────────────
# ServiceNow client
# ─────────────────────────────────────────────────────────────────────────

def _sn() -> ServiceNowClient | None:
    inst = os.environ.get("SN_INSTANCE")
    user = os.environ.get("SN_USER")
    pw   = os.environ.get("SN_PASSWORD")
    if not (inst and user and pw):
        return None
    return ServiceNowClient(inst, user, pw)


def _sn_post(client: ServiceNowClient, path: str, payload: dict) -> dict:
    r = requests.post(
        f"{client.base}{path}",
        json=payload,
        auth=client.auth,
        headers=client.headers,
        timeout=20,
    )
    r.raise_for_status()
    return r.json().get("result") or {}


def _sn_patch(client: ServiceNowClient, path: str, payload: dict) -> dict:
    r = requests.patch(
        f"{client.base}{path}",
        json=payload,
        auth=client.auth,
        headers=client.headers,
        timeout=20,
    )
    r.raise_for_status()
    return r.json().get("result") or {}


def _ticket_url(client: ServiceNowClient, sys_id: str) -> str:
    inst = client.base.replace("https://", "").split(".service-now.com")[0]
    return f"https://{inst}.service-now.com/nav_to.do?uri=sc_request.do?sys_id={sys_id}"


# ─────────────────────────────────────────────────────────────────────────
# Create ticket
# ─────────────────────────────────────────────────────────────────────────

def _classify_sn_state(sn_state: str | None, sn_approval: str | None) -> str:
    """Map an SN sc_request row to one of: open / applied-pending / rejected
    / cancelled. We only return the *terminal* labels; the apply step itself
    flips to 'applied' once bootstrap_cmdb_full runs."""
    state = (sn_state or "").strip().lower()
    appr  = (sn_approval or "").strip().lower()

    if state in SN_STATE_CANCELLED_VALUES:
        return "cancelled"
    if state in SN_STATE_REJECTED_VALUES or appr in SN_APPROVAL_REJECTED:
        return "rejected"
    if state in SN_STATE_COMPLETE_VALUES and appr in SN_APPROVAL_APPROVED:
        return "approved"
    if state in SN_STATE_COMPLETE_VALUES:
        # Closed but no approval flag — treat as approved since the ticket
        # was actively closed-complete, not cancelled.
        return "approved"
    return "open"


def create_ticket_for_rack(rack_id: str, *, force: bool = False) -> dict:
    """Compute the diff, open an SR if needed, write the local state file.

    Returns a result dict:
        { ok, action: "created"|"unchanged"|"empty"|"failed",
          number, sys_id, state, error?, ticket }
    """
    existing = read_ticket(rack_id)
    if existing and existing.get("state") == "open" and not force:
        # Already an open ticket — recompute the diff and decide what to do.
        try:
            diff = compute_diff(rack_id)
        except Exception as e:
            return {"ok": False, "action": "failed", "error": str(e),
                    "ticket": existing}
        if diff_is_empty(diff):
            return {"ok": True, "action": "unchanged", "ticket": existing,
                    "note": "scan now matches CMDB; existing ticket left in place"}
        if diff["diff_hash"] == existing.get("diff_hash"):
            return {"ok": True, "action": "unchanged", "ticket": existing,
                    "note": "diff unchanged from existing open ticket"}
        # Diff changed → append a work-note describing what's new.
        client = _sn()
        if client is None:
            return {"ok": False, "action": "failed",
                    "error": "SN not configured; cannot append work note",
                    "ticket": existing}
        try:
            _sn_patch(client, f"/table/sc_request/{existing['sys_id']}", {
                "work_notes": (
                    f"RackTrack: scan re-run produced a different diff "
                    f"(was {existing.get('diff_hash')[:8]}, now {diff['diff_hash'][:8]}).\n\n"
                    + render_diff_text(diff)
                ),
            })
        except Exception as e:
            return {"ok": False, "action": "failed",
                    "error": f"work-note PATCH failed: {e}",
                    "ticket": existing}
        existing["diff_hash"] = diff["diff_hash"]
        existing["summary"]   = diff.get("summary")
        existing["last_polled_at"] = _now()
        write_ticket(rack_id, existing)
        return {"ok": True, "action": "updated", "ticket": existing}

    # No open ticket (or force=True) — compute and possibly create.
    try:
        diff = compute_diff(rack_id)
    except Exception as e:
        return {"ok": False, "action": "failed", "error": str(e), "ticket": existing}

    if diff_is_empty(diff) and not force:
        # Scan matches CMDB — nothing to do, and clear any stale rejected
        # state so the UI doesn't keep showing "rejected" forever.
        if existing and existing.get("state") in ("rejected", "cancelled", "applied"):
            clear_ticket(rack_id)
        return {"ok": True, "action": "empty", "ticket": None,
                "note": "scan matches CMDB; no ticket needed"}

    client = _sn()
    if client is None:
        return {"ok": False, "action": "failed",
                "error": "SN_INSTANCE/SN_USER/SN_PASSWORD not configured"}

    short_desc = (
        f"RackTrack: CMDB sync for {diff.get('rack_name')} ({rack_id}) — "
        f"+{diff['summary']['added_devices']} / "
        f"-{diff['summary']['removed_devices']} / "
        f"~{diff['summary']['changed_devices']} devices"
    )[:160]
    description = (
        render_diff_text(diff)
        + "\n\n--- machine-readable ---\n"
        + json.dumps(diff, indent=2)[:8000]   # cap so we don't break SN field limit
    )

    payload = {
        "short_description": short_desc,
        "description":       description,
        "category":          "inquiry",
        "urgency":           "3",
        "impact":            "3",
        "u_racktrack_rack_id":   rack_id,    # custom field; ignored if SN doesn't have it
        "u_racktrack_diff_hash": diff["diff_hash"],
    }
    try:
        ci = _sn_post(client, "/table/sc_request", payload)
    except Exception as e:
        return {"ok": False, "action": "failed",
                "error": f"sc_request POST failed: {e}"}

    sys_id = ci.get("sys_id")
    number = ci.get("number")
    if not sys_id or not number:
        return {"ok": False, "action": "failed",
                "error": "SN created the row but didn't return number/sys_id"}

    state_obj = {
        "schema":         SCHEMA,
        "rack_id":        rack_id,
        "rack_name":      diff.get("rack_name"),
        "number":         number,
        "sys_id":         sys_id,
        "state":          "open",
        "sn_state":       ci.get("state"),
        "sn_approval":    ci.get("approval"),
        "diff_hash":      diff["diff_hash"],
        "summary":        diff.get("summary"),
        "opened_at":      _now(),
        "last_polled_at": _now(),
        "applied_at":     None,
        "apply_error":    None,
        "ticket_url":     _ticket_url(client, sys_id),
    }
    write_ticket(rack_id, state_obj)
    return {"ok": True, "action": "created", "ticket": state_obj}


# ─────────────────────────────────────────────────────────────────────────
# Apply (run bootstrap_cmdb_full.py for the rack)
# ─────────────────────────────────────────────────────────────────────────

def _apply_to_cmdb(rack_id: str) -> tuple[bool, str]:
    """Trigger the actual CMDB write via the rack-generic cmdb_apply.py.

    Spawned in --json mode so we get a single-line status back. Failures
    bubble up so the poller can leave the ticket in `open` state and retry
    on the next cycle.
    """
    applier = HERE / "cmdb_apply.py"
    if not applier.exists():
        return False, f"cmdb_apply.py missing at {applier}"
    env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
    try:
        proc = subprocess.run(
            [sys.executable, str(applier), "--rack-id", rack_id, "--json"],
            cwd=ROOT, env=env,
            capture_output=True, text=True, timeout=600,
        )
    except Exception as e:
        return False, f"cmdb_apply spawn failed: {e}"
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip().splitlines()[-15:]
        return False, "cmdb_apply exited " + str(proc.returncode) + ":\n" + "\n".join(tail)
    out = (proc.stdout or "").strip().splitlines()
    if not out:
        return True, "ok"
    try:
        data = json.loads(out[-1])
        if data.get("ok"):
            c = data.get("counters") or {}
            return True, (f"created={c.get('created',0)} "
                          f"updated={c.get('updated',0)} "
                          f"ports={c.get('ports',0)} rels={c.get('rels',0)}")
        return False, data.get("error") or "cmdb_apply returned ok=false"
    except Exception:
        return True, out[-1]


# ─────────────────────────────────────────────────────────────────────────
# Poll
# ─────────────────────────────────────────────────────────────────────────

def poll_one(rack_id: str) -> dict:
    """Re-fetch SN state for a rack's ticket and act on it."""
    existing = read_ticket(rack_id)
    if not existing:
        return {"ok": True, "rack_id": rack_id, "action": "no_ticket"}
    if existing.get("state") in ("applied", "rejected", "cancelled"):
        return {"ok": True, "rack_id": rack_id, "action": "terminal",
                "ticket": existing}

    client = _sn()
    if client is None:
        return {"ok": False, "rack_id": rack_id, "action": "failed",
                "error": "SN not configured"}

    sys_id = existing.get("sys_id")
    if not sys_id:
        return {"ok": False, "rack_id": rack_id, "action": "failed",
                "error": "no sys_id in local state"}

    try:
        resp = client._get(f"/table/sc_request/{sys_id}")
        ci = resp.get("result") or {}
    except Exception as e:
        return {"ok": False, "rack_id": rack_id, "action": "failed",
                "error": f"sc_request GET failed: {e}"}

    sn_state    = ci.get("state")
    sn_approval = ci.get("approval")
    classified  = _classify_sn_state(sn_state, sn_approval)

    existing["sn_state"]       = sn_state
    existing["sn_approval"]    = sn_approval
    existing["last_polled_at"] = _now()

    if classified == "open":
        write_ticket(rack_id, existing)
        return {"ok": True, "rack_id": rack_id, "action": "still_open",
                "ticket": existing}

    if classified == "approved":
        ok, msg = _apply_to_cmdb(rack_id)
        if ok:
            existing["state"]       = "applied"
            existing["applied_at"]  = _now()
            existing["apply_error"] = None
        else:
            existing["state"]       = "open"   # leave open; will retry next cycle
            existing["apply_error"] = msg
        write_ticket(rack_id, existing)
        return {"ok": ok, "rack_id": rack_id,
                "action": "applied" if ok else "apply_failed",
                "ticket": existing, "apply_msg": msg}

    if classified in ("rejected", "cancelled"):
        existing["state"] = classified
        write_ticket(rack_id, existing)
        return {"ok": True, "rack_id": rack_id, "action": classified,
                "ticket": existing}

    # Should never hit, but be safe.
    write_ticket(rack_id, existing)
    return {"ok": True, "rack_id": rack_id, "action": "unknown_state",
            "ticket": existing}


def poll_all() -> dict:
    """Walk every rack with a cmdb_ticket.json and poll each one whose
    state is still 'open'."""
    if not OUTPUTS_BASE.exists():
        return {"ok": True, "swept": 0, "results": []}
    results = []
    swept = 0
    for sub in sorted(OUTPUTS_BASE.iterdir()):
        if not sub.is_dir() or not sub.name.startswith("RK-"):
            continue
        if not (sub / "cmdb_ticket.json").exists():
            continue
        swept += 1
        try:
            results.append(poll_one(sub.name))
        except Exception as e:
            results.append({"ok": False, "rack_id": sub.name, "action": "failed",
                            "error": str(e)})
    return {"ok": True, "swept": swept, "results": results}


# ─────────────────────────────────────────────────────────────────────────
# Cancel (manual, from the UI)
# ─────────────────────────────────────────────────────────────────────────

def cancel_local(rack_id: str) -> dict:
    """Drop the local state file. Doesn't touch the SN ticket — the user
    can close it manually in SN. Useful for "I made a mistake, start over"."""
    if clear_ticket(rack_id):
        return {"ok": True, "rack_id": rack_id, "action": "cleared"}
    return {"ok": True, "rack_id": rack_id, "action": "no_ticket"}


# ─────────────────────────────────────────────────────────────────────────
# Dev approve — bypasses ServiceNow approval workflow for demos
# ─────────────────────────────────────────────────────────────────────────

def dev_approve(rack_id: str) -> dict:
    """Demo flow: approve and sync immediately, returning a structured
    summary of the synthesised inventory that's now considered authoritative
    for this rack. Runs in <1 second — no live ServiceNow calls in the
    request path. The full CMDB write is fired off as a background process
    so the real PDI catches up asynchronously without blocking the UI.

    Steps:
      1. Read the local ticket (must exist; the create flow opens it).
      2. Mark it `applied` locally so the banner / API status reflects sync.
      3. Build a `details` block from synth + topology.json so the modal
         can render exactly what the user will see in CMDB.
      4. Best-effort: spawn cmdb_apply.py detached so SN eventually catches
         up. Failures here never affect the user-visible outcome.
    """
    existing = read_ticket(rack_id)
    if not existing:
        # No prior ticket — synthesise a minimal one so the UI flow still
        # works in demo / fresh-rack scenarios. The "real" auto-create path
        # will fill in number/sys_id later if/when SN is reachable.
        existing = {
            "schema":        SCHEMA,
            "rack_id":       rack_id,
            "rack_name":     None,
            "number":        f"DEV-{rack_id}",
            "sys_id":        None,
            "state":         "applied",
            "sn_state":      "3",
            "sn_approval":   "approved",
            "diff_hash":     None,
            "summary":       {},
            "opened_at":     _now(),
            "last_polled_at": _now(),
            "applied_at":    _now(),
            "apply_error":   None,
            "ticket_url":    None,
        }
    elif existing.get("state") == "applied":
        details = _build_apply_details(rack_id, "")
        return {"ok": True, "rack_id": rack_id, "action": "already_applied",
                "ticket": existing, "details": details}

    existing["state"]       = "applied"
    existing["applied_at"]  = _now()
    existing["sn_state"]    = "3"
    existing["sn_approval"] = "approved"
    existing["apply_error"] = None
    write_ticket(rack_id, existing)

    # Fire-and-forget: kick off the real CMDB write in a detached child so
    # the live PDI picks up the data eventually. We don't wait, don't read
    # output, don't surface errors — this is purely so the SN-side mirrors
    # reality at some point. The local "applied" state is the source of
    # truth for the UI.
    _spawn_background_apply(rack_id)

    details = _build_apply_details(rack_id, "")
    return {"ok": True, "rack_id": rack_id, "action": "applied",
            "ticket": existing, "details": details}


def _spawn_background_apply(rack_id: str) -> None:
    """Detached cmdb_apply.py — fires and exits without waiting."""
    applier = HERE / "cmdb_apply.py"
    if not applier.exists():
        return
    try:
        # On Windows, DETACHED_PROCESS + creationflags decouples from this
        # process tree so it survives our return.
        kwargs = {
            "cwd": str(ROOT),
            "env": {**os.environ, "PYTHONIOENCODING": "utf-8"},
            "stdout": subprocess.DEVNULL,
            "stderr": subprocess.DEVNULL,
            "stdin":  subprocess.DEVNULL,
        }
        if os.name == "nt":
            DETACHED = 0x00000008
            CREATE_NO_WINDOW = 0x08000000
            kwargs["creationflags"] = DETACHED | CREATE_NO_WINDOW
        else:
            kwargs["start_new_session"] = True
        subprocess.Popen(
            [sys.executable, str(applier), "--rack-id", rack_id, "--json"],
            **kwargs,
        )
    except Exception:
        pass  # non-fatal — local applied state still holds


def _build_apply_details(rack_id: str, apply_msg: str) -> dict:
    """Read the scan + topology snapshot for this rack and emit a structured
    summary describing the inventory that's now considered authoritative.
    The UI renders this so users see exactly what got registered."""
    rack_dir = ROOT / "outputs" / rack_id
    scan = {}
    topo = {}
    try:
        scan = json.loads((rack_dir / "scan_result.json").read_text())
    except Exception:
        pass
    try:
        topo = json.loads((rack_dir / "topology.json").read_text())
    except Exception:
        pass

    devices = topo.get("devices", []) or scan.get("devices", []) or []
    cables  = topo.get("edges", []) or topo.get("cables", []) or []

    # Roll up port counts from the per-device port arrays in topology.json.
    total_ports = 0
    for d in devices:
        ports = d.get("ports") or []
        total_ports += len(ports)

    # Build a normalised device list — name, role, all the synthesised
    # enrichment fields the user cares about. This is what renders in the
    # "Registered records" list in the modal.
    device_records = []
    for d in devices:
        ports = d.get("ports") or []
        device_records.append({
            "name":       d.get("name") or d.get("device") or "device",
            "kind":       d.get("class") or d.get("kind") or d.get("type") or d.get("device_type"),
            "model":      d.get("model"),
            "mgmt_ip":    d.get("mgmt_ip") or d.get("ip"),
            "mac":        d.get("mac"),
            "asset_tag":  d.get("asset_tag"),
            "serial":     d.get("serial"),
            "u_position": d.get("u_position"),
            "u_size":     d.get("u_size"),
            "port_count": len(ports),
            "synthetic":  bool(d.get("synthetic")),
        })

    # A short sample of cables for the "Connections" section. topology.json
    # represents each edge as { src: {device, port}, dst: {device, port} }.
    def _end(e, side):
        v = e.get(side) or {}
        if isinstance(v, dict):
            return v.get("device"), v.get("port")
        return v, None
    cable_records = []
    for c in cables[:8]:
        f_dev, f_port = _end(c, "src")
        t_dev, t_port = _end(c, "dst")
        # Strip device prefix from port labels (e.g. "SW-U09:Gi0/23" → "Gi0/23")
        def _short_port(name):
            if not name: return None
            return name.split(":", 1)[1] if ":" in name else name
        cable_records.append({
            "from":   f_dev,
            "from_p": _short_port(f_port),
            "to":     t_dev,
            "to_p":   _short_port(t_port),
            "type":   c.get("cable_type") or c.get("type"),
            "cable":  c.get("cable_id") or c.get("id"),
        })

    counters = {
        "devices": len(devices),
        "ports":   total_ports,
        "cables":  len(cables),
    }

    return {
        "rack_id":      rack_id,
        "rack_name":    topo.get("rackName") or topo.get("rack_name"),
        "u_size":       topo.get("u_size"),
        "device_count": len(devices),
        "port_count":   total_ports,
        "cable_count":  len(cables),
        "counters":     counters,
        "devices":      device_records,
        "cables":       cable_records,
        "scan_meta": {
            "captured_at": (scan.get("captured_at")
                            or topo.get("generated_at")
                            or scan.get("scanned_at")
                            or scan.get("timestamp")),
            "image":       scan.get("image") or (topo.get("image") or {}).get("imageHash"),
        },
    }


# ─────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────

def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)
    p_create = sub.add_parser("create", help="Compute diff and open an SR if needed")
    p_create.add_argument("--rack-id", required=True)
    p_create.add_argument("--force", action="store_true")
    p_create.add_argument("--json",  action="store_true")
    p_poll = sub.add_parser("poll", help="Sweep all open tickets")
    p_poll.add_argument("--rack-id", help="Poll only this rack")
    p_poll.add_argument("--json", action="store_true")
    p_status = sub.add_parser("status", help="Show local state for one rack")
    p_status.add_argument("--rack-id", required=True)
    p_status.add_argument("--json", action="store_true")
    p_cancel = sub.add_parser("cancel", help="Drop local state for one rack")
    p_cancel.add_argument("--rack-id", required=True)
    p_cancel.add_argument("--json", action="store_true")
    p_dev = sub.add_parser("dev-approve",
        help="Demo-only: skip SN approval, apply scan to CMDB immediately")
    p_dev.add_argument("--rack-id", required=True)
    p_dev.add_argument("--json", action="store_true")

    args = p.parse_args()
    out: Any
    if args.cmd == "create":
        out = create_ticket_for_rack(args.rack_id, force=bool(args.force))
    elif args.cmd == "poll":
        out = poll_one(args.rack_id) if args.rack_id else poll_all()
    elif args.cmd == "status":
        t = read_ticket(args.rack_id)
        out = {"ok": True, "rack_id": args.rack_id, "ticket": t}
    elif args.cmd == "cancel":
        out = cancel_local(args.rack_id)
    elif args.cmd == "dev-approve":
        out = dev_approve(args.rack_id)
    else:
        out = {"ok": False, "error": f"unknown cmd {args.cmd}"}

    if getattr(args, "json", False):
        print(json.dumps(out, indent=2, default=str))
    else:
        # Compact human print
        if isinstance(out, dict) and out.get("ticket"):
            t = out["ticket"]
            print(f"rack:     {t.get('rack_id')}")
            print(f"state:    {t.get('state')}    (sn={t.get('sn_state')}/approval={t.get('sn_approval')})")
            print(f"number:   {t.get('number')}")
            print(f"sys_id:   {t.get('sys_id')}")
            print(f"opened:   {t.get('opened_at')}")
            print(f"polled:   {t.get('last_polled_at')}")
            if t.get("applied_at"):  print(f"applied:  {t['applied_at']}")
            if t.get("apply_error"): print(f"apply err: {t['apply_error']}")
            if t.get("ticket_url"):  print(f"url:      {t['ticket_url']}")
        else:
            print(json.dumps(out, indent=2, default=str))
    return 0 if (isinstance(out, dict) and out.get("ok", True)) else 1


if __name__ == "__main__":
    sys.exit(main())

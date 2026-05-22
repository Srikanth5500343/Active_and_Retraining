"""
diff_cmdb.py — compute "what would change in CMDB if we pushed this scan?".

Read the scan-derived inventory (synth.build_inventory) and the current CMDB
state for the same rack (live SN REST queries), produce a structured diff:

    {
      rack_id, rack_name, computed_at, diff_hash,
      summary: { added_devices, removed_devices, changed_devices,
                 added_ports,   removed_ports                       },
      added:    [ { name, class, model, ip, ports, ... } ],
      removed:  [ { name, class, model, ip                     } ],
      changed:  [ { name, field, old, new                       } ],
    }

The hash is sha256 of the canonical JSON form of the diff (sans timestamp) so
re-runs against an unchanged scan + CMDB produce the same hash. That lets the
ticket creator skip work when nothing's actually different from the last run.

Usage:
    python diff_cmdb.py --rack-id RK-XXXXX                # human output
    python diff_cmdb.py --rack-id RK-XXXXX --json         # machine output
    python diff_cmdb.py --rack-id RK-XXXXX --no-cmdb      # offline, treat CMDB as empty
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
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

from synth import build_inventory, load_override, load_port_detail, merge_port_detail
from servicenow import ServiceNowClient


OUTPUTS_BASE = ROOT / "outputs"


# ─────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────

def _u_size_total(host: dict, kind: str) -> int:
    if kind == "Switch":
        return int(host.get("ports") or 0) + int(host.get("sfp_ports") or 0)
    return int(host.get("ports") or 0)


def _scan_device_summary(name: str, host: dict, kind: str) -> dict:
    """Distill a scan-side device dict into the small set of fields we'll
    actually compare against CMDB. Anything not in this dict is considered
    cosmetic and won't generate a diff."""
    return {
        "name":      name,
        "class":     kind,
        "model":     host.get("model_number") or host.get("model"),
        "serial":    host.get("serial_number") or host.get("serial"),
        "ip":        host.get("mgmt_ip") or host.get("ip_address"),
        "mac":       host.get("mac") or host.get("mac_address"),
        "os":        host.get("os") or host.get("os_version"),
        "ports":     _u_size_total(host, kind),
    }


def _cmdb_device_summary(ci: dict, kind: str) -> dict:
    """Same shape as _scan_device_summary but built from a SN CI row."""
    return {
        "name":      ci.get("name"),
        "class":     kind,
        "model":     ci.get("model_number") or None,
        "serial":    ci.get("serial_number") or None,
        "ip":        ci.get("ip_address") or None,
        "mac":       ci.get("mac_address") or None,
        "os":        ci.get("os_version") or ci.get("os") or None,
        # CMDB doesn't always store port_count on the CI itself; the related
        # cmdb_ci_network_adapter rows are authoritative. Fill at the caller.
        "ports":     None,
    }


def _norm(v: Any) -> Any:
    """Normalise empty-string-ish values to None for comparison."""
    if v is None:
        return None
    if isinstance(v, str):
        s = v.strip()
        return s if s else None
    return v


def _changed_fields(scan: dict, cmdb: dict, ignore_keys=("ports",)) -> list[dict]:
    """Return a list of {name, field, old, new} for every key that differs.
    Port count is compared separately (it's a derived/related-table field)."""
    out = []
    for k, v in scan.items():
        if k in ignore_keys or k in ("name", "class"):
            continue
        n_scan = _norm(v)
        n_cmdb = _norm(cmdb.get(k))
        if n_scan is None and n_cmdb is None:
            continue
        if n_scan != n_cmdb:
            out.append({
                "name":  scan["name"],
                "field": k,
                "old":   n_cmdb,
                "new":   n_scan,
            })
    return out


# ─────────────────────────────────────────────────────────────────────────
# Pull the rack's current CMDB state via SN REST.
# ─────────────────────────────────────────────────────────────────────────

def _sn_client() -> ServiceNowClient | None:
    inst = os.environ.get("SN_INSTANCE")
    user = os.environ.get("SN_USER")
    pw   = os.environ.get("SN_PASSWORD")
    if not (inst and user and pw):
        return None
    return ServiceNowClient(inst, user, pw)


def fetch_cmdb_state(rack_id: str, sn: ServiceNowClient | None) -> dict:
    """Snapshot the current CMDB state for a rack.

    Returns:
      { rack: <ci|None>, devices: { name -> summary_dict } }

    `summary_dict` matches `_scan_device_summary` shape, with `ports`
    counted from the rack-child cmdb_ci_network_adapter / cmdb_ci_port rows
    so we can compare port counts.
    """
    if sn is None:
        return {"rack": None, "devices": {}, "reachable": False, "error": "SN env not configured"}

    try:
        rack_resp = sn._get("/table/cmdb_ci_rack", {
            "sysparm_query": f"u_racktrack_scan_id={rack_id}",
            "sysparm_limit": 1,
        })
    except Exception as e:
        return {"rack": None, "devices": {}, "reachable": False, "error": str(e)}

    rack_rows = rack_resp.get("result", [])
    if not rack_rows:
        # Not in CMDB yet — treat as "no current state".
        return {"rack": None, "devices": {}, "reachable": True}

    rack = rack_rows[0]
    rack_sys_id = rack.get("sys_id")

    # Walk the rack's children to find devices.
    cls_to_kind = {
        "cmdb_ci_ip_switch": "Switch",
        "cmdb_ci_netgear":   "Patch Panel",
        "cmdb_ci_server":    "Server",
        "cmdb_ci_firewall_network": "Firewall",
        "cmdb_ci_router":    "Router",
    }

    devices: dict[str, dict] = {}
    try:
        for ci in sn.get_rack_children(rack_sys_id):
            cls = ci.get("sys_class_name")
            kind = cls_to_kind.get(cls)
            if not kind:
                continue
            name = ci.get("name")
            if not name:
                continue
            summary = _cmdb_device_summary(ci, kind)
            # Count this device's ports via the cmdb_ci_network_adapter
            # (Switches / Servers) or cmdb_ci_port (Patch panels) tables.
            port_count = 0
            try:
                if kind == "Patch Panel":
                    pr = sn._get("/table/cmdb_ci_port", {
                        "sysparm_query": f"name>={name}:Port^name<={name}:Port~",
                        "sysparm_fields": "sys_id",
                        "sysparm_limit": "200",
                    })
                else:
                    pr = sn._get("/table/cmdb_ci_network_adapter", {
                        "sysparm_query": f"cmdb_ci={ci.get('sys_id')}",
                        "sysparm_fields": "sys_id",
                        "sysparm_limit": "200",
                    })
                port_count = len(pr.get("result", []))
            except Exception:
                pass
            summary["ports"] = port_count
            devices[name] = summary
    except Exception as e:
        return {"rack": rack, "devices": devices, "reachable": True, "error": str(e)}

    return {"rack": rack, "devices": devices, "reachable": True}


# ─────────────────────────────────────────────────────────────────────────
# Diff
# ─────────────────────────────────────────────────────────────────────────

def compute_diff(rack_id: str, *, use_cmdb: bool = True) -> dict:
    """Build the full diff dict for `rack_id`."""
    rack_dir = OUTPUTS_BASE / rack_id
    scan_path = rack_dir / "scan_result.json"
    if not scan_path.exists():
        raise FileNotFoundError(f"no scan_result.json at {scan_path}")
    scan = json.loads(scan_path.read_text(encoding="utf-8"))
    override = load_override(rack_id)
    inv = build_inventory(rack_id, scan, override)
    merge_port_detail(inv, load_port_detail(str(rack_dir)))

    # ── Build the "scan side" map: name -> summary ───────────────────────
    scan_devices: dict[str, dict] = {}
    for name, host in (inv.get("switches") or {}).items():
        scan_devices[name] = _scan_device_summary(name, host, "Switch")
    for name, host in (inv.get("panels") or {}).items():
        scan_devices[name] = _scan_device_summary(name, host, "Patch Panel")
    server = inv.get("server")
    if server and server.get("name"):
        nics = server.get("nics") or []
        meta = server.get("meta") or {}
        srv_summary = _scan_device_summary(server["name"], {
            "model_number":  meta.get("model_number"),
            "serial_number": meta.get("serial_number"),
            "mgmt_ip":       (nics[0].get("ip") if nics else None),
            "mac":           (nics[0].get("mac") if nics else None),
            "os":            meta.get("os"),
            "ports":         len(nics),
        }, "Server")
        scan_devices[server["name"]] = srv_summary

    # ── Pull the CMDB side ───────────────────────────────────────────────
    if use_cmdb:
        cmdb_state = fetch_cmdb_state(rack_id, _sn_client())
    else:
        cmdb_state = {"rack": None, "devices": {}, "reachable": True}
    cmdb_devices = cmdb_state.get("devices") or {}

    # ── Diff ─────────────────────────────────────────────────────────────
    added: list[dict] = []
    removed: list[dict] = []
    changed: list[dict] = []
    added_ports = 0
    removed_ports = 0

    scan_names = set(scan_devices.keys())
    cmdb_names = set(cmdb_devices.keys())

    for name in sorted(scan_names - cmdb_names):
        d = scan_devices[name]
        added.append(d)
        added_ports += int(d.get("ports") or 0)

    for name in sorted(cmdb_names - scan_names):
        d = cmdb_devices[name]
        removed.append(d)
        removed_ports += int(d.get("ports") or 0)

    for name in sorted(scan_names & cmdb_names):
        s = scan_devices[name]
        c = cmdb_devices[name]
        # field-level diffs (model, serial, ip, mac, os)
        for ch in _changed_fields(s, c):
            changed.append(ch)
        # port count diff (separate, as it can be large + meaningful)
        s_ports = int(s.get("ports") or 0)
        c_ports = int(c.get("ports") or 0)
        if s_ports != c_ports:
            changed.append({
                "name":  name,
                "field": "port_count",
                "old":   c_ports,
                "new":   s_ports,
            })
            if s_ports > c_ports:
                added_ports += (s_ports - c_ports)
            else:
                removed_ports += (c_ports - s_ports)

    summary = {
        "added_devices":   len(added),
        "removed_devices": len(removed),
        "changed_devices": len({c["name"] for c in changed}),
        "added_ports":     added_ports,
        "removed_ports":   removed_ports,
    }

    diff_body = {
        "rack_id":    rack_id,
        "rack_name":  inv.get("rack_name") or rack_id,
        "summary":    summary,
        "added":      added,
        "removed":    removed,
        "changed":    changed,
        "cmdb_reachable": cmdb_state.get("reachable", True),
    }
    diff_body["diff_hash"] = _hash_diff(diff_body)
    diff_body["computed_at"] = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    if cmdb_state.get("error"):
        diff_body["cmdb_error"] = cmdb_state["error"]
    return diff_body


def _hash_diff(diff_body: dict) -> str:
    """Deterministic hash. Excludes computed_at + diff_hash itself so the
    same scan vs the same CMDB state always produces the same hash."""
    payload = {k: v for k, v in diff_body.items()
               if k not in ("computed_at", "diff_hash")}
    canon = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canon.encode("utf-8")).hexdigest()[:16]


def diff_is_empty(diff: dict) -> bool:
    s = diff.get("summary") or {}
    return (s.get("added_devices",   0) == 0
        and s.get("removed_devices", 0) == 0
        and s.get("changed_devices", 0) == 0)


# ─────────────────────────────────────────────────────────────────────────
# Human-friendly text rendering for the ticket description.
# ─────────────────────────────────────────────────────────────────────────

def render_diff_text(diff: dict) -> str:
    s = diff.get("summary") or {}
    lines = [
        f"RackTrack CMDB sync request for {diff.get('rack_id')} "
        f"({diff.get('rack_name')})",
        "",
        f"Summary:",
        f"  added devices:   {s.get('added_devices', 0)}",
        f"  removed devices: {s.get('removed_devices', 0)}",
        f"  changed devices: {s.get('changed_devices', 0)}",
        f"  port delta:      +{s.get('added_ports', 0)} / -{s.get('removed_ports', 0)}",
        "",
    ]
    if diff.get("added"):
        lines.append("Added devices:")
        for d in diff["added"]:
            lines.append(
                f"  + {d.get('name'):<14} {d.get('class'):<14} "
                f"{(d.get('model') or '—'):<24} "
                f"{(d.get('ip') or '—'):<16} "
                f"{int(d.get('ports') or 0)} ports"
            )
        lines.append("")
    if diff.get("removed"):
        lines.append("Removed devices:")
        for d in diff["removed"]:
            lines.append(
                f"  - {d.get('name'):<14} {d.get('class'):<14} "
                f"{(d.get('model') or '—'):<24} "
                f"{(d.get('ip') or '—'):<16} "
                f"{int(d.get('ports') or 0)} ports"
            )
        lines.append("")
    if diff.get("changed"):
        lines.append("Changed fields:")
        for c in diff["changed"]:
            lines.append(
                f"  ~ {c.get('name'):<14} {c.get('field'):<16} "
                f"{c.get('old')!r}  →  {c.get('new')!r}"
            )
        lines.append("")
    if not diff.get("cmdb_reachable", True):
        lines.append(f"NOTE: CMDB not reachable when this diff was computed.")
        if diff.get("cmdb_error"):
            lines.append(f"  reason: {diff['cmdb_error']}")
        lines.append("")
    lines.append(f"diff_hash: {diff.get('diff_hash')}")
    lines.append(f"computed_at: {diff.get('computed_at')}")
    return "\n".join(lines)


# ─────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────

def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--rack-id", required=True)
    p.add_argument("--json",     action="store_true")
    p.add_argument("--no-cmdb",  action="store_true",
                   help="Treat CMDB as empty (offline mode); useful when SN is down.")
    args = p.parse_args()

    try:
        diff = compute_diff(args.rack_id, use_cmdb=not args.no_cmdb)
    except Exception as e:
        if args.json:
            print(json.dumps({"ok": False, "error": str(e)}))
        else:
            print(f"ERROR: {e}", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps({"ok": True, "diff": diff}))
    else:
        print(render_diff_text(diff))
    return 0


if __name__ == "__main__":
    sys.exit(main())

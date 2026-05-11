"""
cmdb_apply.py — push a rack's scan + override into ServiceNow CMDB.

Generic version of bootstrap_cmdb_full.py. Takes a `--rack-id` and works
for any rack (not just RK-00A187E2). Reads inventory from
synth.build_inventory + the per-rack override file, then upserts:

  - cmdb_ci_rack             rack chassis row
  - cmdb_ci_ip_switch        each Switch / AGG-CORE
  - cmdb_ci_netgear          each Patch Panel
  - cmdb_ci_server           the server (one per rack)
  - cmdb_ci_network_adapter  each switch/server port (NICs)
  - cmdb_ci_port             each patch-panel port
  - cmdb_rel_ci              Contains rels for rack→device, device→port
                             Connects-to rels for cable peers

Idempotent: every operation is "find by name → patch existing OR create
new". Re-running against an unchanged scan touches no rows.

Usage:
    python cmdb_apply.py --rack-id RK-XXXXX                # apply now
    python cmdb_apply.py --rack-id RK-XXXXX --dry-run      # log only
    python cmdb_apply.py --rack-id RK-XXXXX --json         # one-line status

This is what the SR poller invokes once a ticket is approved.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

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
from synth import build_inventory, load_override, load_port_detail, merge_port_detail


# ─────────────────────────────────────────────────────────────────────────
# Tiny SN client (similar to servicenow.py but with PATCH/POST helpers)
# ─────────────────────────────────────────────────────────────────────────

class SN:
    def __init__(self):
        inst = os.environ["SN_INSTANCE"]
        self.base = f"https://{inst}.service-now.com/api/now"
        self.auth = (os.environ["SN_USER"], os.environ["SN_PASSWORD"])
        self.headers = {"Accept": "application/json", "Content-Type": "application/json"}

    def find_one(self, table: str, query: str) -> dict | None:
        r = requests.get(f"{self.base}/table/{table}",
                         params={"sysparm_query": query, "sysparm_limit": 1},
                         auth=self.auth, headers=self.headers, timeout=20)
        r.raise_for_status()
        rows = r.json().get("result", [])
        return rows[0] if rows else None

    def create(self, table: str, payload: dict) -> dict:
        r = requests.post(f"{self.base}/table/{table}", json=payload,
                          auth=self.auth, headers=self.headers, timeout=20)
        r.raise_for_status()
        return r.json().get("result") or {}

    def patch(self, table: str, sys_id: str, payload: dict) -> dict:
        r = requests.patch(f"{self.base}/table/{table}/{sys_id}", json=payload,
                           auth=self.auth, headers=self.headers, timeout=20)
        r.raise_for_status()
        return r.json().get("result") or {}


# ─────────────────────────────────────────────────────────────────────────
# Apply
# ─────────────────────────────────────────────────────────────────────────

def apply_rack(rack_id: str, *, dry_run: bool = False) -> dict:
    rack_dir = ROOT / "outputs" / rack_id
    scan_path = rack_dir / "scan_result.json"
    if not scan_path.exists():
        return {"ok": False, "rack_id": rack_id,
                "error": f"no scan_result.json at {scan_path}"}
    scan = json.loads(scan_path.read_text(encoding="utf-8"))
    override = load_override(rack_id)
    inv = build_inventory(rack_id, scan, override)
    merge_port_detail(inv, load_port_detail(str(rack_dir)))

    rack_name = inv.get("rack_name") or rack_id
    rack_meta = inv.get("rack_meta") or {}

    if not all(os.environ.get(k) for k in ("SN_INSTANCE", "SN_USER", "SN_PASSWORD")):
        return {"ok": False, "rack_id": rack_id,
                "error": "SN_INSTANCE / SN_USER / SN_PASSWORD not set"}

    sn = SN() if not dry_run else None
    counters = {"created": 0, "updated": 0, "rels": 0, "ports": 0}

    def upsert(table: str, name: str, payload: dict, extra_q: str = "") -> dict:
        if dry_run:
            counters["updated"] += 1
            return {"sys_id": f"DRYRUN-{name}", "name": name}
        q = f"name={name}"
        if extra_q:
            q += f"^{extra_q}"
        existing = sn.find_one(table, q)
        if existing:
            sn.patch(table, existing["sys_id"], payload)
            counters["updated"] += 1
            return existing
        created = sn.create(table, {"name": name, **payload})
        counters["created"] += 1
        return created

    # ── 1. Rack ──────────────────────────────────────────────────────────
    rack_payload = {**rack_meta, "u_racktrack_scan_id": rack_id}
    rack = upsert("cmdb_ci_rack", rack_name, rack_payload)
    rack_sys_id = rack.get("sys_id")

    # ── Resolve relationship type sys_ids ────────────────────────────────
    contains_type = "55c95343c0a8010e0118ec7056ebc54a"  # default seeded by SN
    connects_type = "5599a965c0a8010e00da3b58b113d70e"
    if not dry_run:
        rt = sn.find_one("cmdb_rel_type", "name=Contains::Contained by")
        if rt:
            contains_type = rt["sys_id"]

    def ensure_rel(parent_id: str, child_id: str, rel_type: str):
        if dry_run:
            counters["rels"] += 1
            return
        existing = sn.find_one("cmdb_rel_ci",
            f"parent={parent_id}^child={child_id}^type={rel_type}")
        if existing:
            return
        sn.create("cmdb_rel_ci",
            {"parent": parent_id, "child": child_id, "type": rel_type})
        counters["rels"] += 1

    # ── 2. Switches + their ports ────────────────────────────────────────
    for name, host in (inv.get("switches") or {}).items():
        ip = host.get("mgmt_ip")
        if not ip or ip in ("0.0.0.0", "0", "unknown"):
            continue   # don't create CIs for unidentified placeholders
        # Provenance line — what's real, what's synthesized, where OCR
        # got us. Lives in `comments` (a standard CMDB field) so anyone
        # browsing the CI in ServiceNow can see exactly where each
        # populated field came from. The same info is repeated in the UI
        # via the discovery_source field we expose through list_rack_switches.
        disc = host.get("discovery_source") or "synth"
        provenance_bits = [f"discovery_source={disc}"]
        if host.get("ocr_make"):
            provenance_bits.append(f"ocr_make={host['ocr_make']}")
        if host.get("ocr_model"):
            provenance_bits.append(f"ocr_model={host['ocr_model']}")
        if host.get("ocr_version"):
            provenance_bits.append(f"ocr_version={host['ocr_version']}")
        if host.get("ocr_conf") is not None:
            provenance_bits.append(f"ocr_conf={host['ocr_conf']}")
        if disc.startswith("synth"):
            provenance_bits.append("synthetic_data=true")
        if host.get("ocr_raw"):
            provenance_bits.append(f"ocr_raw='{host['ocr_raw'][:120]}'")
        sw_payload = {
            "model_number":      host.get("model_number") or "",
            "serial_number":     host.get("serial_number") or "",
            "ip_address":        ip,
            "mac_address":       host.get("mac") or "",
            "os_version":        host.get("os") or "",
            "short_description": host.get("short_description") or "",
            "comments":          "; ".join(provenance_bits),
        }
        sw = upsert("cmdb_ci_ip_switch", name, sw_payload)
        if rack_sys_id and sw.get("sys_id"):
            ensure_rel(rack_sys_id, sw["sys_id"], contains_type)
        # Ports
        prefix = host.get("port_prefix") or "p"
        port_count = int(host.get("ports") or 0) + int(host.get("sfp_ports") or 0)
        for i in range(1, port_count + 1):
            pname = f"{name}:{prefix}{i}"
            mac = f"AA:BB:CC:{int(name.split('-U')[1] or 0):02X}:{i:02X}:{i:02X}"
            p = upsert("cmdb_ci_network_adapter", pname, {
                "cmdb_ci": sw.get("sys_id"),
                "mac_address": mac,
                "alias": f"{prefix}{i}",
            }, extra_q=f"cmdb_ci={sw.get('sys_id')}")
            counters["ports"] += 1
            if sw.get("sys_id") and p.get("sys_id"):
                ensure_rel(sw["sys_id"], p["sys_id"], contains_type)

    # ── 3. Patch panels + their ports ────────────────────────────────────
    for name, host in (inv.get("panels") or {}).items():
        pp_payload = {
            "model_number":      host.get("model_number") or "",
            "serial_number":     host.get("serial_number") or "",
            "short_description": host.get("short_description") or "",
        }
        pp = upsert("cmdb_ci_netgear", name, pp_payload)
        if rack_sys_id and pp.get("sys_id"):
            ensure_rel(rack_sys_id, pp["sys_id"], contains_type)
        nports = int(host.get("ports") or 0)
        for i in range(1, nports + 1):
            pname = f"{name}:Port{i}"
            p = upsert("cmdb_ci_port", pname, {
                "model_number": "Cat6a Jack",
                "short_description": f"port {i} of {name}",
            })
            counters["ports"] += 1
            if pp.get("sys_id") and p.get("sys_id"):
                ensure_rel(pp["sys_id"], p["sys_id"], contains_type)

    # ── 4. Server (optional) ─────────────────────────────────────────────
    server = inv.get("server")
    if server and server.get("name"):
        meta = server.get("meta") or {}
        srv = upsert("cmdb_ci_server", server["name"], meta)
        if rack_sys_id and srv.get("sys_id"):
            ensure_rel(rack_sys_id, srv["sys_id"], contains_type)
        for nic in (server.get("nics") or []):
            n = upsert("cmdb_ci_network_adapter", nic["name"], {
                "cmdb_ci":            srv.get("sys_id"),
                "mac_address":        nic.get("mac"),
                "ip_address":         nic.get("ip"),
                "netmask":            nic.get("netmask"),
                "ip_default_gateway": nic.get("gateway"),
                "fqdn":               nic.get("fqdn"),
                "alias":              nic.get("alias"),
                "short_description":  nic.get("short_description"),
            }, extra_q=f"cmdb_ci={srv.get('sys_id')}")
            counters["ports"] += 1
            if srv.get("sys_id") and n.get("sys_id"):
                ensure_rel(srv["sys_id"], n["sys_id"], contains_type)

    return {
        "ok":       True,
        "rack_id":  rack_id,
        "dry_run":  dry_run,
        "counters": counters,
    }


# ─────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────

def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--rack-id", required=True)
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--json",    action="store_true")
    args = p.parse_args()

    try:
        result = apply_rack(args.rack_id, dry_run=bool(args.dry_run))
    except Exception as e:
        result = {"ok": False, "rack_id": args.rack_id, "error": str(e)}

    if args.json:
        print(json.dumps(result))
        return 0 if result.get("ok") else 1

    if result.get("ok"):
        c = result["counters"]
        print(f"[cmdb-apply] {result['rack_id']} → "
              f"{c['created']} created, {c['updated']} updated, "
              f"{c['ports']} ports touched, {c['rels']} relationships"
              + (" (DRY RUN)" if result.get("dry_run") else ""))
        return 0
    print(f"[cmdb-apply] FAILED: {result.get('error')}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())

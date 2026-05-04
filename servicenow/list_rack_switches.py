"""
list_rack_switches.py

Given a RackTrack scan_id, find the matching rack CI in ServiceNow CMDB
and return its switch children with serial / model / mgmt_ip.

Usage: python list_rack_switches.py <rack_scan_id>
Stdout (last line): JSON object {"rack": <name>, "switches": [...]}
"""
import json
import os
import re
import sys
from pathlib import Path

# Make repo-relative imports work whether invoked from project root or elsewhere.
HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:
    pass

from servicenow import ServiceNowClient


def extract_position(name: str | None) -> str | None:
    if not name:
        return None
    m = re.search(r"U(\d{1,2})", name)
    return f"U{m.group(1).zfill(2)}" if m else None


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "rack_scan_id argument required", "switches": []}))
        sys.exit(2)
    rack_scan_id = sys.argv[1]

    inst = os.environ.get("SN_INSTANCE")
    user = os.environ.get("SN_USER")
    pw   = os.environ.get("SN_PASSWORD")
    if not (inst and user and pw):
        # No SN — return empty so UI can render "—" for serials.
        print(json.dumps({"error": "ServiceNow env vars not configured", "switches": []}))
        return

    sn = ServiceNowClient(inst, user, pw)

    # Find the rack CI by u_racktrack_scan_id (custom field on cmdb_ci_rack).
    rack_resp = sn._get("/table/cmdb_ci_rack", {
        "sysparm_query": f"u_racktrack_scan_id={rack_scan_id}",
        "sysparm_limit": 1,
    })
    rack_rows = rack_resp.get("result", [])
    if not rack_rows:
        print(json.dumps({"rack": None, "switches": []}))
        return

    rack = rack_rows[0]
    rack_sys_id = rack.get("sys_id")
    rack_name = rack.get("name")

    children = sn.get_rack_children(rack_sys_id)
    out = []
    for ci in children:
        if ci.get("sys_class_name") != "cmdb_ci_ip_switch":
            continue
        out.append({
            "name":          ci.get("name"),
            "serial_number": ci.get("serial_number") or None,
            "model_number":  ci.get("model_number") or None,
            "ip_address":    ci.get("ip_address") or None,
            "mac_address":   ci.get("mac_address") or None,
            "position":      ci.get("u_position") or extract_position(ci.get("name")),
        })

    print(json.dumps({"rack": rack_name, "switches": out}))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"error": str(exc), "switches": []}))
        sys.exit(0)  # don't fail the request — return empty switches gracefully

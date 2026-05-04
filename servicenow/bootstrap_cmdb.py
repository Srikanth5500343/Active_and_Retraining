"""
Provision the CMDB for the RackTrack demo via ServiceNow REST.

Creates (idempotently):
  - 1 Rack CI (RACK-DARK-01) with u_racktrack_scan_id = RK-00A187E2
  - 12 child CIs matching the real scan detections in mock_scans/RK-00A187E2/
      5 Switches, 6 Patch Panels, 1 Server
  - 12 cmdb_rel_ci rows (rack Contains child)

Re-run after a PDI hibernation reset — it skips existing records.

Usage:
    python bootstrap_cmdb.py

Requires .env with SN_INSTANCE, SN_USER, SN_PASSWORD.
"""
import os
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

import requests
from dotenv import load_dotenv


RACK_NAME = "RACK-DARK-01"
RACK_SCAN_ID = "RK-00A187E2"
RACK_UNITS = 18

# Maps real scan detections to CIs we're creating.
# (name, sys_class_name, u_position, optional model hint)
CIS = [
    ("SRV-U01", "cmdb_ci_server", 1, "Dell PowerEdge"),
    ("SW-U02",  "cmdb_ci_ip_switch", 2, "Cisco Catalyst"),
    ("SW-U04",  "cmdb_ci_ip_switch", 4, "Cisco Catalyst"),
    ("PP-U06",  "cmdb_ci_netgear",   6, "Panduit Patch Panel"),
    ("SW-U07",  "cmdb_ci_ip_switch", 7, "Cisco Catalyst"),
    ("PP-U08",  "cmdb_ci_netgear",   8, "Panduit Patch Panel"),
    ("SW-U10",  "cmdb_ci_ip_switch", 10, "Cisco Catalyst 9300"),
    ("PP-U12",  "cmdb_ci_netgear",   12, "Panduit Patch Panel"),
    ("PP-U13",  "cmdb_ci_netgear",   13, "Panduit Patch Panel"),
    ("SW-U15",  "cmdb_ci_ip_switch", 15, "Cisco Catalyst"),
    ("PP-U17",  "cmdb_ci_netgear",   17, "Panduit Patch Panel"),
    ("PP-U18",  "cmdb_ci_netgear",   18, "Panduit Patch Panel"),
]


def main() -> int:
    load_dotenv()
    instance = os.environ["SN_INSTANCE"]
    auth = (os.environ["SN_USER"], os.environ["SN_PASSWORD"])
    base = f"https://{instance}.service-now.com/api/now"
    headers = {"Accept": "application/json", "Content-Type": "application/json"}

    def find(table: str, query: str) -> dict | None:
        r = requests.get(
            f"{base}/table/{table}",
            params={"sysparm_query": query, "sysparm_limit": 1},
            auth=auth, headers=headers, timeout=20,
        )
        r.raise_for_status()
        rows = r.json().get("result", [])
        return rows[0] if rows else None

    def create(table: str, payload: dict) -> dict:
        r = requests.post(
            f"{base}/table/{table}",
            json=payload, auth=auth, headers=headers, timeout=20,
        )
        r.raise_for_status()
        return r.json()["result"]

    def upsert_ci(table: str, name: str, payload: dict) -> dict:
        existing = find(table, f"name={name}")
        if existing:
            print(f"  [skip] {table}/{name} already exists (sys_id={existing['sys_id']})")
            return existing
        created = create(table, {"name": name, **payload})
        print(f"  [new ] {table}/{name} (sys_id={created['sys_id']})")
        return created

    # 1. Rack
    print("→ Rack")
    rack = upsert_ci("cmdb_ci_rack", RACK_NAME, {
        "rack_units": str(RACK_UNITS),
        "u_racktrack_scan_id": RACK_SCAN_ID,
    })

    # If it existed already, make sure the scan ID is set (edits are cheap here)
    if rack.get("u_racktrack_scan_id") != RACK_SCAN_ID:
        r = requests.patch(
            f"{base}/table/cmdb_ci_rack/{rack['sys_id']}",
            json={"u_racktrack_scan_id": RACK_SCAN_ID},
            auth=auth, headers=headers, timeout=20,
        )
        r.raise_for_status()
        print(f"  [patched] {RACK_NAME}.u_racktrack_scan_id = {RACK_SCAN_ID}")

    # 2. Child CIs
    print("→ Child CIs")
    children = []
    for name, cls, u_pos, model in CIS:
        payload = {
            "rack_unit_position": str(u_pos),
            "short_description": model,
        }
        ci = upsert_ci(cls, name, payload)
        children.append(ci)

    # 3. Resolve the Contains::Contained by relationship type
    print("→ Relationship type")
    reltype = find("cmdb_rel_type", "name=Contains::Contained by")
    if not reltype:
        print("  ERROR: cannot find 'Contains::Contained by' relationship type on this instance")
        return 1
    reltype_sys_id = reltype["sys_id"]
    print(f"  Contains::Contained by = {reltype_sys_id}")

    # 4. Relationships
    print("→ Relationships (rack Contains child)")
    for ci in children:
        existing = find(
            "cmdb_rel_ci",
            f"parent={rack['sys_id']}^child={ci['sys_id']}^type={reltype_sys_id}",
        )
        if existing:
            print(f"  [skip] {RACK_NAME} Contains {ci['name']}")
            continue
        create("cmdb_rel_ci", {
            "parent": rack["sys_id"],
            "child":  ci["sys_id"],
            "type":   reltype_sys_id,
        })
        print(f"  [new ] {RACK_NAME} Contains {ci['name']}")

    print()
    print(f"Done. Rack {RACK_NAME} has {len(children)} CIs linked.")
    print(f"Next: python main.py <incident-number>  (create an incident referencing SW-U10 first)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

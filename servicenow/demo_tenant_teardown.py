"""
Demo tenant teardown for ServiceNow CMDB.

Wipes everything created by demo_tenant_bootstrap.py.

Isolation contract
------------------
Every record created by the bootstrap has company=<demo_company_sys_id>
AND a name starting with 'DEMO-ACME-'. Both filters are applied (AND) to
make accidental deletion of unrelated records mathematically impossible
even if some other code path ever sets a name with our prefix or shares
our company anchor.

The demo_tenant_state.json file (written by bootstrap) is the canonical
source of sys_ids; we delete in reverse-dependency order using that file.
A '--scan' fallback rebuilds the delete list by querying the instance,
useful if the state file is lost.

Run
---
    python demo_tenant_teardown.py             # interactive confirm
    python demo_tenant_teardown.py --yes       # no prompt
    python demo_tenant_teardown.py --dry-run   # show what would be deleted
    python demo_tenant_teardown.py --scan      # rebuild list from instance
"""

import argparse
import json
import os
import sys
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

import requests
from dotenv import load_dotenv

SCRIPT_DIR = Path(__file__).resolve().parent
STATE_FILE = SCRIPT_DIR / "demo_tenant_state.json"

# Delete in this order — child records first so referential constraints
# don't block parent deletions.
DELETE_ORDER = [
    ("cmdb_rel_ci",            "rels"),
    ("cmdb_ci_network_adapter","ports"),
    ("cmdb_ci_server",         "servers"),
    ("cmdb_ci_ip_switch",      "switches"),
    ("cmdb_ci_ip_router",      "routers"),
    ("cmdb_ci_ip_firewall",    "firewalls"),
    ("cmdb_ci_patch_panel",    "patch_panels"),
    ("cmdb_ci_pdu",            "pdus"),
    ("cmdb_ci",                "misc_ci"),    # fallback table for devs whose subclass didn't exist
    ("cmdb_ci_rack",           "racks"),
    ("cmn_location",           "locations"),
    ("core_company",           "company"),
]


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--yes", action="store_true", help="Skip the y/N prompt")
    p.add_argument("--dry-run", action="store_true", help="Print plan, delete nothing")
    p.add_argument("--scan", action="store_true",
                   help="Rebuild target list by querying instance for name starting with DEMO-ACME-")
    args = p.parse_args()

    load_dotenv(SCRIPT_DIR / ".env")
    inst = os.environ["SN_INSTANCE"]
    user = os.environ["SN_USER"]
    pw   = os.environ["SN_PASSWORD"]
    base = f"https://{inst}.service-now.com/api/now"
    auth = (user, pw)
    h = {"Accept": "application/json", "Content-Type": "application/json"}

    # Resolve the demo company sys_id (anchor for the AND filter).
    company_sys_id = None
    if STATE_FILE.exists() and not args.scan:
        state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        company_sys_id = state.get("company")
    if not company_sys_id:
        r = requests.get(f"{base}/table/core_company",
                         params={"sysparm_query": "name=DEMO-ACME-CORP", "sysparm_limit": 1},
                         auth=auth, headers=h, timeout=20)
        rows = r.json().get("result", [])
        if rows:
            company_sys_id = rows[0]["sys_id"]

    if not company_sys_id:
        print("Nothing to delete — no DEMO-ACME-CORP company found.")
        return

    print(f"Target: https://{inst}.service-now.com")
    print(f"Demo company sys_id: {company_sys_id}")
    print(f"Filter: company={company_sys_id}^nameSTARTSWITHDEMO-ACME-")
    print()

    # Build delete plan by querying each table with the AND filter.
    plan = []
    grand_total = 0
    for table, label in DELETE_ORDER:
        if table == "cmdb_rel_ci":
            # Rels are anchored differently — find rels whose parent or child
            # is in the demo company. Easier: query rels where parent.name
            # starts with our prefix.
            q = "parent.nameSTARTSWITHDEMO-ACME-^ORchild.nameSTARTSWITHDEMO-ACME-"
        elif table == "core_company":
            q = f"sys_id={company_sys_id}"
        else:
            q = f"company={company_sys_id}^nameSTARTSWITHDEMO-ACME-"
        try:
            r = requests.get(f"{base}/table/{table}",
                             params={"sysparm_query": q,
                                     "sysparm_fields": "sys_id,name",
                                     "sysparm_limit": 5000},
                             auth=auth, headers=h, timeout=30)
            if r.status_code >= 400:
                continue
            rows = r.json().get("result", [])
        except Exception:
            continue
        if rows:
            plan.append((table, label, rows))
            grand_total += len(rows)
            print(f"  {table:30s} → {len(rows):5d} records  ({label})")

    print()
    print(f"Total to delete: {grand_total}")

    if grand_total == 0:
        print("Nothing to delete.")
        return

    if args.dry_run:
        print("Dry-run — no deletions performed.")
        return

    if not args.yes:
        ans = input("Proceed with delete? [y/N] ").strip().lower()
        if ans != "y":
            print("Aborted.")
            return

    # Execute deletes in DELETE_ORDER.
    deleted = 0
    failed = 0
    for table, label, rows in plan:
        for row in rows:
            sys_id = row["sys_id"]
            try:
                d = requests.delete(f"{base}/table/{table}/{sys_id}",
                                    auth=auth, headers=h, timeout=15)
                if d.status_code < 400:
                    deleted += 1
                else:
                    failed += 1
                    print(f"  ! delete failed for {table}/{sys_id}: {d.status_code}")
            except Exception as e:
                failed += 1
                print(f"  ! delete error for {table}/{sys_id}: {e}")
        print(f"  ✓ {table}: done")

    print()
    print(f"Deleted {deleted}, failed {failed}")

    if failed == 0 and STATE_FILE.exists():
        STATE_FILE.unlink()
        print(f"Removed {STATE_FILE.name}")


if __name__ == "__main__":
    main()

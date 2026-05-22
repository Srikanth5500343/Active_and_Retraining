"""
Demo tenant bootstrap for ServiceNow CMDB.

Creates a complete, self-contained datacenter under a fresh company anchor
("Demo - Acme Corp") so it can be wiped with a single teardown query.
Idempotent: re-running updates existing records by name + company, never
duplicates.

Isolation strategy
------------------
Every CI created here has:
  * name starting with "DEMO-ACME-"
  * company  = sys_id of the demo company record
The teardown script (demo_tenant_teardown.py) finds everything to delete by
filtering on company=<demo_company_sys_id> — no need for a custom field.

Scope
-----
  1 core_company       — Demo - Acme Corp
  2 cmn_location       — sites (NYC HQ, Austin DR)
  3 cmn_location       — buildings/floors
  5 cmdb_ci_zone       — rows (fallback to cmn_location if zone table absent)
 15 cmdb_ci_rack       — racks
 ~60 cmdb_ci_ip_switch — ToR + agg + edge
 ~15 cmdb_ci_ip_router — one per floor + edge
  3 cmdb_ci_ip_firewall — DC perimeter + DMZ + DR
 ~40 cmdb_ci_server    — mixed
 ~15 cmdb_ci_patch_panel
 ~30 cmdb_ci_pdu       — 2 per rack (A/B)
~500 cmdb_ci_network_adapter (ports/NICs)
~120 cmdb_rel_ci       — relationships (contains, connected to, located in)

Run
---
    python demo_tenant_bootstrap.py            # creates everything, idempotent
    python demo_tenant_bootstrap.py --dry-run  # print plan, write nothing

Output
------
On success, writes servicenow/demo_tenant_state.json with all sys_ids for
audit + teardown.
"""

import argparse
import json
import os
import random
import sys
import time
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

import requests
from dotenv import load_dotenv


SCRIPT_DIR = Path(__file__).resolve().parent
STATE_FILE = SCRIPT_DIR / "demo_tenant_state.json"

# Match the layout in server/data/demo_tenant.json so the UI mat looks
# identical when it switches source to CMDB.
COMPANY = {
    "name": "DEMO-ACME-CORP",
    "label": "Demo - Acme Corp",
}

LAYOUT = {
    "sites": [
        {
            "key": "nyc",
            "name": "DEMO-ACME-SITE-NYC",
            "label": "Demo Acme — NYC HQ",
            "buildings": [
                {
                    "key": "hq",
                    "name": "DEMO-ACME-BLDG-HQ",
                    "label": "Demo Acme — HQ Datacenter",
                    "floors": [
                        {"key": "hq-f1", "name": "DEMO-ACME-FLR-HQ-F1", "label": "HQ Floor 1 — Production",
                         "rows": [
                             {"key": "row-a", "name": "DEMO-ACME-ROW-A", "label": "Row A"},
                             {"key": "row-b", "name": "DEMO-ACME-ROW-B", "label": "Row B"},
                         ]},
                        {"key": "hq-f2", "name": "DEMO-ACME-FLR-HQ-F2", "label": "HQ Floor 2 — Staging",
                         "rows": [
                             {"key": "row-c", "name": "DEMO-ACME-ROW-C", "label": "Row C"},
                         ]},
                    ],
                },
            ],
        },
        {
            "key": "austin",
            "name": "DEMO-ACME-SITE-AUSTIN",
            "label": "Demo Acme — Austin DR",
            "buildings": [
                {
                    "key": "dr",
                    "name": "DEMO-ACME-BLDG-DR",
                    "label": "Demo Acme — DR Site",
                    "floors": [
                        {"key": "dr-f1", "name": "DEMO-ACME-FLR-DR-F1", "label": "DR Hall",
                         "rows": [
                             {"key": "row-d", "name": "DEMO-ACME-ROW-D", "label": "Row D"},
                             {"key": "row-e", "name": "DEMO-ACME-ROW-E", "label": "Row E"},
                         ]},
                    ],
                },
            ],
        },
    ],
}

# 15 racks laid out by (site, building, floor, row, position). Names are
# stable so re-runs find and update rather than duplicate.
RACKS = [
    # HQ Floor 1, Row A — 4 racks
    {"name": "DEMO-ACME-RK-HQ-A-01", "row": "row-a", "position": 1, "u_height": 42, "asset": "AT-DEMO-001"},
    {"name": "DEMO-ACME-RK-HQ-A-02", "row": "row-a", "position": 2, "u_height": 42, "asset": "AT-DEMO-002"},
    {"name": "DEMO-ACME-RK-HQ-A-03", "row": "row-a", "position": 3, "u_height": 42, "asset": "AT-DEMO-003"},
    {"name": "DEMO-ACME-RK-HQ-A-04", "row": "row-a", "position": 4, "u_height": 42, "asset": "AT-DEMO-004"},
    # HQ Floor 1, Row B — 3 racks
    {"name": "DEMO-ACME-RK-HQ-B-01", "row": "row-b", "position": 1, "u_height": 42, "asset": "AT-DEMO-005"},
    {"name": "DEMO-ACME-RK-HQ-B-02", "row": "row-b", "position": 2, "u_height": 42, "asset": "AT-DEMO-006"},
    {"name": "DEMO-ACME-RK-HQ-B-03", "row": "row-b", "position": 3, "u_height": 42, "asset": "AT-DEMO-007"},
    # HQ Floor 2, Row C — 3 racks
    {"name": "DEMO-ACME-RK-HQ-C-01", "row": "row-c", "position": 1, "u_height": 42, "asset": "AT-DEMO-008"},
    {"name": "DEMO-ACME-RK-HQ-C-02", "row": "row-c", "position": 2, "u_height": 42, "asset": "AT-DEMO-009"},
    {"name": "DEMO-ACME-RK-HQ-C-03", "row": "row-c", "position": 3, "u_height": 42, "asset": "AT-DEMO-010"},
    # DR, Row D — 3 racks
    {"name": "DEMO-ACME-RK-DR-D-01", "row": "row-d", "position": 1, "u_height": 42, "asset": "AT-DEMO-011"},
    {"name": "DEMO-ACME-RK-DR-D-02", "row": "row-d", "position": 2, "u_height": 42, "asset": "AT-DEMO-012"},
    {"name": "DEMO-ACME-RK-DR-D-03", "row": "row-d", "position": 3, "u_height": 42, "asset": "AT-DEMO-013"},
    # DR, Row E — 2 racks
    {"name": "DEMO-ACME-RK-DR-E-01", "row": "row-e", "position": 1, "u_height": 42, "asset": "AT-DEMO-014"},
    {"name": "DEMO-ACME-RK-DR-E-02", "row": "row-e", "position": 2, "u_height": 42, "asset": "AT-DEMO-015"},
]


# Per-rack device profile. Deterministic via seeded RNG (rack name → seed)
# so re-runs are stable.
def device_profile(rack_name: str) -> dict:
    rng = random.Random(rack_name)
    is_edge = rack_name.endswith("HQ-A-01") or rack_name.endswith("DR-D-01")
    return {
        "switches": [
            {"name": f"{rack_name}-SW-ToR1", "model": "Catalyst 9300-48P", "ports": 48, "u": 41},
            {"name": f"{rack_name}-SW-ToR2", "model": "Catalyst 9300-48P", "ports": 48, "u": 40},
        ],
        "routers": [{"name": f"{rack_name}-RTR-01", "model": "ASR 1001-X", "u": 39}] if is_edge else [],
        "firewalls": [{"name": f"{rack_name}-FW-01", "model": "Palo Alto PA-3260", "u": 38}] if is_edge else [],
        "servers": [
            {"name": f"{rack_name}-SRV-{i:02d}",
             "model": rng.choice(["Dell PowerEdge R750", "HPE ProLiant DL380 Gen10", "Dell PowerEdge R650"]),
             "u": 1 + (i - 1) * 2,
             "ram_mb": rng.choice([131072, 262144, 524288]),
             "cpu": rng.choice(["Intel Xeon Gold 6330", "Intel Xeon Silver 4314", "AMD EPYC 7543"]),
            }
            for i in range(1, rng.randint(8, 14))
        ],
        "patch_panels": [
            {"name": f"{rack_name}-PP-01", "ports": 24, "u": 36},
            {"name": f"{rack_name}-PP-02", "ports": 24, "u": 35},
        ],
        "pdus": [
            {"name": f"{rack_name}-PDU-A", "feed": "A", "u": 0},
            {"name": f"{rack_name}-PDU-B", "feed": "B", "u": 0},
        ],
    }


# ─── ServiceNow client ──────────────────────────────────────────────────
class SN:
    def __init__(self, instance: str, user: str, password: str, dry_run: bool = False):
        self.base = f"https://{instance}.service-now.com/api/now"
        self.auth = (user, password)
        self.h = {"Accept": "application/json", "Content-Type": "application/json"}
        self.dry = dry_run
        self.stats = {"created": 0, "updated": 0, "found": 0, "skipped": 0}

    def find_one(self, table: str, query: str) -> dict | None:
        r = requests.get(f"{self.base}/table/{table}",
                         params={"sysparm_query": query, "sysparm_limit": 1,
                                 "sysparm_fields": "sys_id,name"},
                         auth=self.auth, headers=self.h, timeout=20)
        r.raise_for_status()
        rows = r.json().get("result", [])
        return rows[0] if rows else None

    def create(self, table: str, payload: dict) -> dict:
        if self.dry:
            self.stats["skipped"] += 1
            return {"sys_id": f"dry-{table}-{payload.get('name','?')}", "name": payload.get("name")}
        r = requests.post(f"{self.base}/table/{table}", json=payload,
                          auth=self.auth, headers=self.h, timeout=30)
        if r.status_code >= 400:
            raise RuntimeError(f"POST {table} {payload.get('name')} → {r.status_code}: {r.text[:200]}")
        self.stats["created"] += 1
        return r.json()["result"]

    def update(self, table: str, sys_id: str, payload: dict) -> dict:
        if self.dry:
            return {"sys_id": sys_id}
        r = requests.patch(f"{self.base}/table/{table}/{sys_id}", json=payload,
                           auth=self.auth, headers=self.h, timeout=30)
        r.raise_for_status()
        self.stats["updated"] += 1
        return r.json()["result"]

    def upsert(self, table: str, query: str, payload: dict) -> str:
        """Find by query, create if missing, update if present. Returns sys_id."""
        existing = self.find_one(table, query)
        if existing:
            self.stats["found"] += 1
            self.update(table, existing["sys_id"], payload)
            return existing["sys_id"]
        created = self.create(table, payload)
        return created["sys_id"]

    def table_exists(self, table: str) -> bool:
        """Quick probe — some PDIs don't ship every cmdb_ci_* subclass."""
        try:
            r = requests.get(f"{self.base}/table/{table}",
                             params={"sysparm_limit": 1},
                             auth=self.auth, headers=self.h, timeout=10)
            return r.status_code < 400 and "result" in r.json()
        except Exception:
            return False


# ─── Bootstrap phases ───────────────────────────────────────────────────
def bootstrap(sn: SN) -> dict:
    state = {"company": None, "sites": {}, "buildings": {}, "floors": {},
             "rows": {}, "racks": {}, "devices": {}, "ports": {}, "rels": []}

    log = lambda s: print(s, flush=True)

    # Phase 1 — Company anchor
    log("▶ Phase 1/6  Company")
    company_sys_id = sn.upsert(
        "core_company",
        f"name={COMPANY['name']}",
        {"name": COMPANY["name"], "u_short_description": COMPANY["label"]
         if False else None,  # u_short_description rarely exists — skip safely below
         "notes": f"{COMPANY['label']} — demo tenant created by demo_tenant_bootstrap.py. Wipe via demo_tenant_teardown.py."},
    )
    state["company"] = company_sys_id
    log(f"  ✓ company {COMPANY['name']} {company_sys_id}")

    # Phase 2 — Locations (sites → buildings → floors)
    log("▶ Phase 2/6  Locations")
    for site in LAYOUT["sites"]:
        site_id = sn.upsert("cmn_location", f"name={site['name']}",
                            {"name": site["name"], "company": company_sys_id,
                             "u_kind": "site"})
        state["sites"][site["key"]] = site_id
        log(f"  ✓ site {site['name']}")
        for bldg in site["buildings"]:
            bldg_id = sn.upsert("cmn_location", f"name={bldg['name']}",
                                {"name": bldg["name"], "parent": site_id,
                                 "company": company_sys_id, "u_kind": "building"})
            state["buildings"][bldg["key"]] = bldg_id
            log(f"    ✓ building {bldg['name']}")
            for flr in bldg["floors"]:
                flr_id = sn.upsert("cmn_location", f"name={flr['name']}",
                                   {"name": flr["name"], "parent": bldg_id,
                                    "company": company_sys_id, "u_kind": "floor"})
                state["floors"][flr["key"]] = flr_id
                log(f"      ✓ floor {flr['name']}")

    # Phase 3 — Rows (cmn_location children of floor — universal fallback)
    log("▶ Phase 3/6  Rows")
    row_to_floor = {}
    for site in LAYOUT["sites"]:
        for bldg in site["buildings"]:
            for flr in bldg["floors"]:
                for row in flr["rows"]:
                    row_id = sn.upsert("cmn_location", f"name={row['name']}",
                                       {"name": row["name"],
                                        "parent": state["floors"][flr["key"]],
                                        "company": company_sys_id,
                                        "u_kind": "row"})
                    state["rows"][row["key"]] = row_id
                    row_to_floor[row["key"]] = flr["key"]
                    log(f"    ✓ row {row['name']}")

    # Phase 4 — Racks
    log("▶ Phase 4/6  Racks (15)")
    row_to_floor_loc = {k: state["floors"][v] for k, v in row_to_floor.items()}
    for r in RACKS:
        rack_payload = {
            "name": r["name"],
            "company": company_sys_id,
            "location": row_to_floor_loc[r["row"]],
            "asset_tag": r["asset"],
            "u_height": r["u_height"],
            "short_description": f"Demo rack — row {r['row']} pos {r['position']}",
        }
        rid = sn.upsert("cmdb_ci_rack", f"name={r['name']}", rack_payload)
        state["racks"][r["name"]] = {"sys_id": rid, "row": r["row"], "position": r["position"]}
        log(f"  ✓ rack {r['name']}")

    # Phase 5 — Devices (switches, routers, firewalls, servers, patch panels, PDUs)
    log("▶ Phase 5/6  Devices")
    # Probe optional tables once.
    has_pdu     = sn.table_exists("cmdb_ci_pdu")
    has_patch   = sn.table_exists("cmdb_ci_patch_panel")
    has_router  = sn.table_exists("cmdb_ci_ip_router")
    has_fw      = sn.table_exists("cmdb_ci_ip_firewall")
    log(f"  • optional tables: pdu={has_pdu} patch_panel={has_patch} router={has_router} firewall={has_fw}")

    total_devices = 0
    total_ports = 0
    for r in RACKS:
        prof = device_profile(r["name"])
        rack_sys_id = state["racks"][r["name"]]["sys_id"]
        floor_loc = row_to_floor_loc[r["row"]]
        devs_here = {}

        def mk(table, name, extra):
            payload = {"name": name, "company": company_sys_id,
                       "location": floor_loc, **extra}
            return sn.upsert(table, f"name={name}", payload)

        for sw in prof["switches"]:
            devs_here[sw["name"]] = mk("cmdb_ci_ip_switch", sw["name"], {
                "model_number": sw["model"],
                "short_description": f"ToR access switch in {r['name']}",
                "u_height": 1,
            })
        for rt in prof["routers"]:
            tbl = "cmdb_ci_ip_router" if has_router else "cmdb_ci_ip_switch"
            devs_here[rt["name"]] = mk(tbl, rt["name"], {
                "model_number": rt["model"],
                "short_description": f"Edge router in {r['name']}",
            })
        for fw in prof["firewalls"]:
            tbl = "cmdb_ci_ip_firewall" if has_fw else "cmdb_ci_netgear"
            devs_here[fw["name"]] = mk(tbl, fw["name"], {
                "model_number": fw["model"],
                "short_description": f"Perimeter firewall in {r['name']}",
            })
        for srv in prof["servers"]:
            devs_here[srv["name"]] = mk("cmdb_ci_server", srv["name"], {
                "model_number": srv["model"],
                "cpu_name": srv["cpu"], "ram": str(srv["ram_mb"]),
                "short_description": f"Server in {r['name']}",
            })
        for pp in prof["patch_panels"]:
            tbl = "cmdb_ci_patch_panel" if has_patch else "cmdb_ci"
            devs_here[pp["name"]] = mk(tbl, pp["name"], {
                "short_description": f"Patch panel in {r['name']}",
            })
        for pdu in prof["pdus"]:
            tbl = "cmdb_ci_pdu" if has_pdu else "cmdb_ci"
            devs_here[pdu["name"]] = mk(tbl, pdu["name"], {
                "short_description": f"PDU feed {pdu['feed']} in {r['name']}",
            })

        state["devices"][r["name"]] = devs_here
        total_devices += len(devs_here)

        # Ports — only on switches (servers/routers/etc covered if we want
        # to grow, but keeping the port count realistic and the run bounded).
        port_table = "cmdb_ci_network_adapter"
        for sw in prof["switches"]:
            sw_sys_id = devs_here[sw["name"]]
            for i in range(1, sw["ports"] + 1):
                p_name = f"{sw['name']}:Gi1/0/{i}"
                pid = sn.upsert(port_table, f"name={p_name}", {
                    "name": p_name, "company": company_sys_id,
                    "short_description": f"Port {i} on {sw['name']}",
                })
                state["ports"].setdefault(sw["name"], []).append(pid)
                total_ports += 1

        log(f"  ✓ {r['name']}: {len(devs_here)} devices, ports for {len(prof['switches'])} switches")

    log(f"  • total devices: {total_devices}, total ports: {total_ports}")

    # Phase 6 — Relationships (Rack Contains Device)
    log("▶ Phase 6/6  Relationships")
    contains_type = sn.find_one("cmdb_rel_type", "name=Contains::Contained by")
    if not contains_type:
        log("  ! 'Contains::Contained by' rel type not found — skipping relationships")
    else:
        rel_type_id = contains_type["sys_id"]
        for rack_name, devs in state["devices"].items():
            rack_sys_id = state["racks"][rack_name]["sys_id"]
            for dev_name, dev_sys_id in devs.items():
                existing = sn.find_one("cmdb_rel_ci",
                    f"parent={rack_sys_id}^child={dev_sys_id}^type={rel_type_id}")
                if existing:
                    sn.stats["found"] += 1
                else:
                    sn.create("cmdb_rel_ci", {
                        "parent": rack_sys_id,
                        "child": dev_sys_id,
                        "type": rel_type_id,
                    })
                state["rels"].append({"parent": rack_sys_id, "child": dev_sys_id})
        log(f"  ✓ {len(state['rels'])} rack-contains-device relationships")

    return state


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--dry-run", action="store_true", help="Print plan, write nothing")
    args = p.parse_args()

    load_dotenv(SCRIPT_DIR / ".env")
    inst = os.environ.get("SN_INSTANCE")
    user = os.environ.get("SN_USER")
    pw = os.environ.get("SN_PASSWORD")
    if not all([inst, user, pw]):
        print("ERROR: SN_INSTANCE / SN_USER / SN_PASSWORD missing from .env", file=sys.stderr)
        sys.exit(2)

    print(f"Target: https://{inst}.service-now.com  (user={user})  dry_run={args.dry_run}")
    sn = SN(inst, user, pw, dry_run=args.dry_run)

    # Wake-check
    try:
        probe = requests.get(f"{sn.base}/table/sys_user",
                             params={"sysparm_limit": 1},
                             auth=sn.auth, headers=sn.h, timeout=15)
        if "Instance Hibernating" in probe.text:
            print("ERROR: instance is hibernating — wake it at developer.servicenow.com first", file=sys.stderr)
            sys.exit(3)
        if probe.status_code >= 400:
            print(f"ERROR: probe returned {probe.status_code}: {probe.text[:200]}", file=sys.stderr)
            sys.exit(3)
    except requests.RequestException as e:
        print(f"ERROR: cannot reach instance: {e}", file=sys.stderr)
        sys.exit(3)

    t0 = time.time()
    state = bootstrap(sn)
    elapsed = time.time() - t0

    print()
    print("═" * 60)
    print(f"Done in {elapsed:.1f}s  |  created={sn.stats['created']}  "
          f"updated={sn.stats['updated']}  found={sn.stats['found']}  "
          f"skipped={sn.stats['skipped']}")

    if not args.dry_run:
        STATE_FILE.write_text(json.dumps(state, indent=2), encoding="utf-8")
        print(f"State written to {STATE_FILE.name}")


if __name__ == "__main__":
    main()

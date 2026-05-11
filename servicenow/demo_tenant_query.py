"""
Query the demo tenant out of ServiceNow CMDB, shaped for the /demo/topology
UI. Mirrors the JSON envelope returned by GET /api/demo/tenant-mat so the
frontend can swap source without changes.

Anchored on the demo company sys_id (read from demo_tenant_state.json),
so this script only ever sees demo CIs — never real tenant data.

Run
---
    python demo_tenant_query.py            # prints JSON to stdout
    python demo_tenant_query.py --pretty   # indented

Output envelope:
    {
      tenant:    { id, slug, name, rack_count },
      buildings: [ { id, name, city, floors: [ { id, label, width_m, height_m,
                                                 rows: [ { id, label, y_m } ] } ] } ],
      racks:     [ { id, name, u_size, building_id, floor_id, row_id,
                     position, x_m, y_m, rotation_deg, status, scanned, in_cmdb,
                     last_seen, device_count, power_kw, model, serial,
                     drift_notes? } ],
      summary:   { total, ok, drift, cmdb_only, scan_only }
    }
"""
import argparse
import json
import os
import sys
from collections import defaultdict
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

import requests
from dotenv import load_dotenv

SCRIPT_DIR = Path(__file__).resolve().parent
STATE_FILE = SCRIPT_DIR / "demo_tenant_state.json"

# Floor plan dimensions and row Y positions — kept in sync with the
# original JSON-backed view so the mat looks identical when source flips
# from json to cmdb.
FLOOR_DIMS = {
    "hq-f1": {"width_m": 30, "height_m": 18, "city": "New York, NY"},
    "hq-f2": {"width_m": 24, "height_m": 14, "city": "New York, NY"},
    "dr-f1": {"width_m": 36, "height_m": 20, "city": "Austin, TX"},
}
ROW_Y_M = {"row-a": 4, "row-b": 10, "row-c": 5, "row-d": 5, "row-e": 13}


def floor_key_from_name(name: str) -> str:
    # DEMO-ACME-FLR-HQ-F1 → hq-f1
    suffix = name.replace("DEMO-ACME-FLR-", "").lower()
    return suffix


def row_key_from_name(name: str) -> str:
    # DEMO-ACME-ROW-A → row-a
    return "row-" + name.replace("DEMO-ACME-ROW-", "").lower()


def building_id_from_name(name: str) -> str:
    # DEMO-ACME-BLDG-HQ → bldg-hq
    return "bldg-" + name.replace("DEMO-ACME-BLDG-", "").lower()


def site_city(name: str) -> str:
    if "NYC" in name: return "New York, NY"
    if "AUSTIN" in name: return "Austin, TX"
    return ""


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--pretty", action="store_true")
    args = p.parse_args()

    load_dotenv(SCRIPT_DIR / ".env")
    inst = os.environ["SN_INSTANCE"]
    base = f"https://{inst}.service-now.com/api/now"
    auth = (os.environ["SN_USER"], os.environ["SN_PASSWORD"])
    h = {"Accept": "application/json", "Content-Type": "application/json"}

    if not STATE_FILE.exists():
        print(json.dumps({"error": "demo_tenant_state.json missing — run bootstrap first"}))
        sys.exit(2)
    state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    company_sys_id = state["company"]

    def q(table, query, fields):
        r = requests.get(f"{base}/table/{table}",
                         params={"sysparm_query": query,
                                 "sysparm_fields": ",".join(fields),
                                 "sysparm_limit": 5000,
                                 "sysparm_display_value": "all"},
                         auth=auth, headers=h, timeout=30)
        r.raise_for_status()
        return r.json().get("result", [])

    # Locations — sites/buildings/floors/rows all live in cmn_location.
    # We derive kind from the name prefix because the u_kind custom field
    # doesn't persist on PDIs without table-schema customization.
    locs = q("cmn_location",
             f"company={company_sys_id}^nameSTARTSWITHDEMO-ACME-",
             ["sys_id", "name", "parent"])

    def kind_from_name(name: str) -> str:
        if "-SITE-" in name: return "site"
        if "-BLDG-" in name: return "building"
        if "-FLR-"  in name: return "floor"
        if "-ROW-"  in name: return "row"
        return ""

    def parse_ref(v):
        if isinstance(v, dict):
            return v.get("value")
        return v or None
    def parse_name(row, key):
        v = row.get(key)
        if isinstance(v, dict):
            return v.get("display_value") or v.get("value") or ""
        return v or ""

    sites, buildings_idx, floors_idx, rows_idx = {}, {}, {}, {}
    for l in locs:
        name = parse_name(l, "name")
        kind = kind_from_name(name)
        sid = l["sys_id"] if isinstance(l.get("sys_id"), str) else l["sys_id"].get("value")
        rec = {"sys_id": sid, "name": name, "parent": parse_ref(l.get("parent"))}
        if kind == "site":     sites[sid] = rec
        elif kind == "building": buildings_idx[sid] = rec
        elif kind == "floor":  floors_idx[sid] = rec
        elif kind == "row":    rows_idx[sid] = rec

    # Build buildings → floors → rows tree in the UI shape.
    buildings_out = []
    bldg_id_by_sysid = {}
    for b_sysid, b in buildings_idx.items():
        bid = building_id_from_name(b["name"])
        bldg_id_by_sysid[b_sysid] = bid
        parent_site = sites.get(b["parent"])
        city = site_city(parent_site["name"]) if parent_site else ""
        b_floors = []
        for f_sysid, f in floors_idx.items():
            if f["parent"] != b_sysid: continue
            fkey = floor_key_from_name(f["name"])
            dims = FLOOR_DIMS.get(fkey, {"width_m": 30, "height_m": 18})
            f_rows = []
            for r_sysid, r in rows_idx.items():
                if r["parent"] != f_sysid: continue
                rkey = row_key_from_name(r["name"])
                f_rows.append({"id": rkey, "label": r["name"].replace("DEMO-ACME-ROW-", "Row "),
                               "y_m": ROW_Y_M.get(rkey, 5)})
            b_floors.append({
                "id": fkey,
                "label": f["name"].replace("DEMO-ACME-FLR-", ""),
                "width_m": dims["width_m"],
                "height_m": dims["height_m"],
                "rows": sorted(f_rows, key=lambda x: x["y_m"]),
            })
        buildings_out.append({
            "id": bid,
            "name": b["name"].replace("DEMO-ACME-BLDG-", "Demo Acme — "),
            "city": city,
            "floors": b_floors,
        })

    # Racks. Pull and bucket by row (parsed from the name) and floor (location).
    racks_raw = q("cmdb_ci_rack",
                  f"company={company_sys_id}^nameSTARTSWITHDEMO-ACME-",
                  ["sys_id", "name", "location", "asset_tag", "u_height", "short_description"])

    # We need: floor key, row key, position (parsed from name like DEMO-ACME-RK-HQ-A-01).
    def parse_rack_name(name):
        # DEMO-ACME-RK-HQ-A-01 → ("hq-f1"... actually we need floor inference)
        # The floor isn't encoded in the rack name directly, but the row is —
        # so we look up the row→floor via location parents.
        parts = name.replace("DEMO-ACME-RK-", "").split("-")
        # ['HQ','A','01'] or ['DR','D','01']
        if len(parts) >= 3:
            bldg_token = parts[0].lower()  # hq or dr
            row_letter = parts[1].lower()
            pos = int(parts[2])
            return bldg_token, "row-" + row_letter, pos
        return None, None, None

    # Map row sys_ids → row key, and floor sys_ids → floor key.
    row_sysid_to_key = {sysid: row_key_from_name(r["name"]) for sysid, r in rows_idx.items()}
    row_key_to_floor_key = {}
    for sysid, r in rows_idx.items():
        floor_sysid = r["parent"]
        floor = floors_idx.get(floor_sysid)
        if floor:
            row_key_to_floor_key[row_key_from_name(r["name"])] = floor_key_from_name(floor["name"])

    # Count devices per rack via cmdb_rel_ci where parent=rack.
    rack_sys_ids = [parse_ref(r.get("sys_id")) or r["sys_id"] for r in racks_raw]
    rack_sys_ids = [x for x in rack_sys_ids if x]
    device_counts = defaultdict(int)
    if rack_sys_ids:
        # Chunk to keep query under URL limits.
        for i in range(0, len(rack_sys_ids), 50):
            chunk = rack_sys_ids[i:i + 50]
            rels = q("cmdb_rel_ci",
                     "parentIN" + ",".join(chunk),
                     ["parent", "child"])
            for rel in rels:
                p_sysid = parse_ref(rel.get("parent"))
                if p_sysid: device_counts[p_sysid] += 1

    racks_out = []
    for rr in racks_raw:
        sysid = rr["sys_id"] if isinstance(rr["sys_id"], str) else rr["sys_id"].get("value")
        name = parse_name(rr, "name")
        bldg_token, row_key, pos = parse_rack_name(name)
        floor_key = row_key_to_floor_key.get(row_key, "hq-f1")
        # Per-row x_m baseline + per-position step.
        x_m = 3 + (pos - 1) * 2.4
        y_m = ROW_Y_M.get(row_key, 5)
        bid = f"bldg-{bldg_token}" if bldg_token else "bldg-hq"
        # Pretty display name
        disp = name.replace("DEMO-ACME-RK-", "")
        u_height = rr.get("u_height")
        if isinstance(u_height, dict):
            u_height_v = u_height.get("value")
        else:
            u_height_v = u_height
        try:
            u_size = int(u_height_v) if u_height_v else 42
        except (TypeError, ValueError):
            u_size = 42
        racks_out.append({
            "id": sysid,
            "name": disp,
            "u_size": u_size,
            "building_id": bid,
            "floor_id": floor_key,
            "row_id": row_key,
            "position": pos or 1,
            "x_m": x_m, "y_m": y_m, "rotation_deg": 0,
            "status": "ok",          # all CMDB-sourced racks are 'in CMDB';
            "scanned": True,         # for the demo we mark them all as ok+scanned
            "in_cmdb": True,
            "last_seen": None,
            "device_count": device_counts.get(sysid, 0),
            "power_kw": None,
            "model": "APC AR3100",
            "serial": parse_name(rr, "asset_tag") or sysid[:8],
        })

    racks_out.sort(key=lambda r: (r["building_id"], r["floor_id"], r["row_id"], r["position"]))

    summary = {"total": len(racks_out), "ok": len(racks_out),
               "drift": 0, "cmdb_only": 0, "scan_only": 0}

    out = {
        "tenant": {"id": "demo-acme-cmdb", "slug": "acme",
                   "name": "Acme Corp (live from CMDB)",
                   "rack_count": len(racks_out)},
        "buildings": buildings_out,
        "racks": racks_out,
        "summary": summary,
        "source": "cmdb",
    }
    print(json.dumps(out, indent=2 if args.pretty else None))


if __name__ == "__main__":
    main()

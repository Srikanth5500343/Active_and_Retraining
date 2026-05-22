"""
cmdb_size.py — quick inventory of how much is in the CMDB.

Hits the ServiceNow Aggregate API (/stats/<table>?sysparm_count=true) for each
relevant CMDB table and prints the row count. Filters cmdb_ci by sys_class_name
to break down what kinds of CIs we have.

Usage: python cmdb_size.py
"""
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

import requests
from dotenv import load_dotenv

load_dotenv(HERE / ".env")

INSTANCE = os.environ["SN_INSTANCE"]
AUTH = (os.environ["SN_USER"], os.environ["SN_PASSWORD"])
BASE = f"https://{INSTANCE}.service-now.com/api/now"
HEADERS = {"Accept": "application/json"}

TABLES = [
    "cmdb_ci",                    # all CIs (umbrella)
    "cmdb_ci_rack",
    "cmdb_ci_ip_switch",
    "cmdb_ci_netgear",            # patch panels live here
    "cmdb_ci_server",
    "cmdb_ci_network_adapter",    # switch ports + server NICs
    "cmdb_ci_port",               # patch panel ports
    "cmdb_ci_disk",
    "cmdb_ci_disk_partition",
    "cmdb_rel_ci",                # relationships (Contains / Connects to)
]


def count(table: str, query: str = "") -> int:
    """Count rows. Tries Aggregate API first, falls back to Table API + X-Total-Count."""
    params = {"sysparm_count": "true"}
    if query:
        params["sysparm_query"] = query
    r = requests.get(f"{BASE}/stats/{table}", params=params,
                     auth=AUTH, headers=HEADERS, timeout=20)
    if r.status_code == 200 and r.headers.get("Content-Type", "").startswith("application/json"):
        try:
            return int(r.json()["result"]["stats"]["count"])
        except (KeyError, ValueError):
            pass
    # Fallback: Table API with sysparm_limit=1 and read X-Total-Count header
    tparams = {"sysparm_limit": "1", "sysparm_fields": "sys_id"}
    if query:
        tparams["sysparm_query"] = query
    r = requests.get(f"{BASE}/table/{table}", params=tparams,
                     auth=AUTH, headers=HEADERS, timeout=30)
    r.raise_for_status()
    total = r.headers.get("X-Total-Count")
    if total is not None:
        return int(total)
    raise RuntimeError(f"could not count {table}")


def class_breakdown() -> dict[str, int]:
    """Group cmdb_ci rows by sys_class_name. Falls back to per-class counts."""
    r = requests.get(
        f"{BASE}/stats/cmdb_ci",
        params={
            "sysparm_count": "true",
            "sysparm_group_by": "sys_class_name",
        },
        auth=AUTH, headers=HEADERS, timeout=30,
    )
    if r.status_code == 200 and r.headers.get("Content-Type", "").startswith("application/json"):
        try:
            rows = r.json()["result"]
            out = {}
            for row in rows:
                cls = row.get("groupby_fields", [{}])[0].get("value", "?")
                n = int(row["stats"]["count"])
                out[cls] = n
            return dict(sorted(out.items(), key=lambda kv: -kv[1]))
        except (KeyError, ValueError):
            pass

    # Fallback: page through cmdb_ci and tally sys_class_name client-side
    out: dict[str, int] = {}
    offset = 0
    while True:
        r = requests.get(
            f"{BASE}/table/cmdb_ci",
            params={
                "sysparm_limit": "500",
                "sysparm_offset": str(offset),
                "sysparm_fields": "sys_class_name",
            },
            auth=AUTH, headers=HEADERS, timeout=60,
        )
        r.raise_for_status()
        rows = r.json().get("result", [])
        if not rows:
            break
        for row in rows:
            cls = row.get("sys_class_name") or "?"
            out[cls] = out.get(cls, 0) + 1
        if len(rows) < 500:
            break
        offset += 500
    return dict(sorted(out.items(), key=lambda kv: -kv[1]))


def main() -> int:
    print(f"Instance: {INSTANCE}.service-now.com")
    print()
    print(f"{'Table':<32} {'Rows':>8}")
    print("-" * 42)
    total_cis = 0
    for t in TABLES:
        try:
            n = count(t)
        except requests.HTTPError as e:
            print(f"{t:<32} {'ERR':>8}  ({e.response.status_code})")
            continue
        print(f"{t:<32} {n:>8}")
        if t == "cmdb_ci":
            total_cis = n

    print()
    print("Breakdown of cmdb_ci by sys_class_name:")
    print("-" * 42)
    try:
        for cls, n in class_breakdown().items():
            print(f"  {cls:<38} {n:>6}")
    except Exception as e:
        print(f"  (group-by failed: {e})")

    print()
    print("Relationship breakdown:")
    print("-" * 42)
    try:
        contains = count("cmdb_rel_ci",
                         "type.name=Contains::Contained by")
        connects = count("cmdb_rel_ci",
                         "type.name=Connects to::Connected by")
        print(f"  Contains::Contained by                {contains:>6}")
        print(f"  Connects to::Connected by             {connects:>6}")
    except Exception as e:
        print(f"  (rel breakdown failed: {e})")

    return 0


if __name__ == "__main__":
    sys.exit(main())

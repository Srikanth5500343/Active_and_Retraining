"""
Full CMDB enrichment — expands on bootstrap_cmdb.py to add:
  - Rack/device metadata (asset tags, serials, mgmt IPs, MACs, OS versions)
  - Network ports per switch matching scan port_count + sfp_ports
  - Patch panel ports matching scan port_count
  - Server NICs, disks, partitions
  - AGG-CORE-01 (out-of-rack aggregation switch) for uplink termination
  - Cable chain derived from scan_result.json so every connected port has a peer
  - Topology snapshot at outputs/<rackId>/topology.json for the UI

Idempotent: checks existence before creating. Re-run safe.

Run order:
    python bootstrap_cmdb.py        # creates rack + 12 CIs (once)
    python bootstrap_cmdb_full.py   # enriches with ports/nics/disks/cables + topology snapshot

Usage:
    python bootstrap_cmdb_full.py
"""
import datetime as dt
import json
import os
import re
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

import requests
from dotenv import load_dotenv


RACK_NAME = "RACK-DARK-01"
SCAN_RACK_ID = "RK-00A187E2"
SCAN_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..", "outputs", SCAN_RACK_ID, "scan_result.json",
)
OUTPUT_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..", "outputs", SCAN_RACK_ID,
)

RACK_META = {
    "asset_tag": "AT-RACK-DARK-01",
    "serial_number": "APC-NS-42U-001",
    "short_description": "42U APC NetShelter in DC-East Row B; 208V/30A circuits; 2x PDU; cooling zone B2",
    "comments": "Owner: Platform/Network; power_total_kw=8.4; pdu_a=serial APC-PDU-4401; pdu_b=serial APC-PDU-4402; temperature_sensor=on",
}

# Port counts match scan_result.json for RK-00A187E2.
# ports = main port count, sfp_ports = SFP/uplink ports. Total enumerated = ports + sfp_ports.
SWITCHES = {
    "SW-U02": {
        "model_number": "Catalyst 2960X-24",
        "serial_number": "FCW2501A002",
        "mgmt_ip": "10.10.4.2",
        "mac": "AA:BB:CC:10:10:02",
        "os": "IOS 15.2(7)E4",
        "ports": 23,           # scan: U02-SW04 port_count=23
        "sfp_ports": 0,
        "port_prefix": "Gi0/",
        "short_description": "ToR access switch (lower) — 23 RJ45 ports, no SFP",
    },
    "SW-U04": {
        "model_number": "Catalyst 9300-48P",
        "serial_number": "FCW2501A004",
        "mgmt_ip": "10.10.4.4",
        "mac": "AA:BB:CC:10:10:04",
        "os": "IOS-XE 17.09.03",
        "ports": 48,           # scan: U04-SW03 port_count=48 + sfp_ports=4
        "sfp_ports": 4,
        "port_prefix": "Gi1/0/",
        "short_description": "Access switch — 48 RJ45 + 4 SFP+ uplinks",
    },
    "SW-U07": {
        # Scan classified U07 as Unidentified; we keep the CI but with zero ports
        # so the topology view matches what's actually on the rack.
        "model_number": "Unknown / Unidentified",
        "serial_number": "UNKNOWN-U07",
        "mgmt_ip": "0.0.0.0",
        "mac": "00:00:00:00:00:00",
        "os": "unknown",
        "ports": 0,
        "sfp_ports": 0,
        "port_prefix": "",
        "short_description": "Unidentified device at U07 — low-confidence scan, no port enumeration",
    },
    "SW-U10": {
        "model_number": "Catalyst 9300-48P",
        "serial_number": "FCW2501A100",
        "mgmt_ip": "10.10.4.10",
        "mac": "AA:BB:CC:10:10:10",
        "os": "IOS-XE 17.09.03",
        "ports": 48,           # scan: U10-SW02 port_count=48 + sfp_ports=4
        "sfp_ports": 4,
        "port_prefix": "Gi1/0/",
        "short_description": "Core switch — 48 RJ45 + 4 SFP+; STP root for VLANs 10,20,30; uplink Gi1/0/49-52",
    },
    "SW-U15": {
        "model_number": "Catalyst 9300-48UN",
        "serial_number": "FCW2501A015",
        "mgmt_ip": "10.10.4.15",
        "mac": "AA:BB:CC:10:10:15",
        "os": "IOS-XE 17.09.03",
        "ports": 52,           # scan: U15-SW01 port_count=52
        "sfp_ports": 0,
        "port_prefix": "Gi1/0/",
        "short_description": "Distribution switch — 52 RJ45 ports",
    },
}

PATCH_PANELS = {
    "PP-U06": {"model_number": "Panduit DP24584TGY", "serial_number": "PND-DP24-006", "ports": 24, "short_description": "Cat6a 24-port patch panel"},
    "PP-U08": {"model_number": "Panduit DP18584TGY", "serial_number": "PND-DP18-008", "ports": 18, "short_description": "Cat6a 18-port patch panel (smaller frame)"},
    "PP-U12": {"model_number": "Panduit DP24584TGY", "serial_number": "PND-DP24-012", "ports": 24, "short_description": "Cat6a 24-port patch panel"},
    "PP-U13": {"model_number": "Panduit DP24584TGY", "serial_number": "PND-DP24-013", "ports": 24, "short_description": "Cat6a 24-port patch panel"},
    "PP-U17": {"model_number": "Panduit DP24584TGY", "serial_number": "PND-DP24-017", "ports": 24, "short_description": "Cat6a 24-port patch panel"},
    "PP-U18": {"model_number": "Panduit DP24584TGY", "serial_number": "PND-DP24-018", "ports": 24, "short_description": "Cat6a 24-port patch panel"},
}

SERVER = {
    "name": "SRV-U01",
    "meta": {
        "model_number": "Dell PowerEdge R750",
        "serial_number": "DELL-R750-001",
        "os": "Ubuntu 22.04 LTS",
        "cpu_name": "Intel Xeon Gold 6330",
        "cpu_count": "2",
        "cpu_core_count": "28",
        "ram": "262144",  # 256 GB in MB
        "short_description": "Primary web server for prod; owner Platform/Web; kernel 5.15.0-91-generic",
        "comments": "Services: nginx (active), docker (active), node_exporter, filebeat. Uptime 42d. Services bind to eth0:443,80.",
    },
    "nics": [
        {"name": "SRV-U01:eth0", "alias": "eth0", "mac": "AA:BB:CC:01:01:01", "ip": "10.10.4.100", "netmask": "255.255.255.0", "gateway": "10.10.4.1", "fqdn": "web01.prod.dark", "short_description": "vlan=10 mode=access speed=1000M oper=up admin=up mtu=1500"},
        {"name": "SRV-U01:eth1", "alias": "eth1", "mac": "AA:BB:CC:01:01:02", "ip": "10.10.4.101", "netmask": "255.255.255.0", "gateway": "10.10.4.1", "fqdn": "web01-mgmt.prod.dark", "short_description": "vlan=99 (mgmt) mode=access speed=1000M oper=up admin=up"},
    ],
    "disks": [
        {
            "name": "SRV-U01:/dev/sda",
            "size_bytes": "500107862016",  # 500 GB
            "short_description": "SSD Samsung PM893 boot drive",
            "partitions": [
                {"name": "/boot", "partition_number": "1", "size_bytes": "1073741824",   "short_description": "fs=ext4 used=280M total=1G mount=/boot"},
                {"name": "/",     "partition_number": "2", "size_bytes": "499034120192", "short_description": "fs=ext4 used=142G total=465G mount=/"},
            ],
        },
        {
            "name": "SRV-U01:/dev/sdb",
            "size_bytes": "2000398934016",  # 2 TB
            "short_description": "NVMe Samsung PM9A3 data drive",
            "partitions": [
                {"name": "/var",  "partition_number": "1", "size_bytes": "536870912000",  "short_description": "fs=xfs used=55G total=500G mount=/var"},
                {"name": "/data", "partition_number": "2", "size_bytes": "1463528022016", "short_description": "fs=xfs used=980G total=1.4T mount=/data"},
            ],
        },
    ],
}

# Out-of-rack aggregation switch — receives uplinks from access switches.
AGG_CORE_NAME = "AGG-CORE-01"
AGG_CORE = {
    "model_number": "Catalyst 9500-32C",
    "serial_number": "AGGCORE-2026-01",
    "mgmt_ip": "10.10.4.1",
    "mac": "AA:BB:CC:99:99:01",
    "os": "IOS-XE 17.12.01",
    "ports": 32,
    "sfp_ports": 0,
    "port_prefix": "Up",
    "short_description": "Aggregation/core switch (adjacent rack); receives uplinks from RACK-DARK-01 access switches",
}

CONNECTS_TO_REL_TYPE = "5599a965c0a8010e00da3b58b113d70e"  # Connects to::Connected by
CONTAINS_REL_TYPE = None  # resolved at runtime


# ─────────────────────────────────────────────────────────────────────────────
# Wiring derivation: build cable list so every connected port in the scan has
# a peer relationship in CMDB. Deterministic given the same scan.
# ─────────────────────────────────────────────────────────────────────────────

def derive_wiring_from_scan(scan_path, switches, patch_panels, server):
    """
    Returns list of (src_device, src_port, dst_device, dst_port, cable_id, cable_type, length).

    Strategy:
      1. Up to 4 uplinks per active switch -> AGG-CORE
      2. Demo chain: SW-U10:Gi1/0/12 -> PP-U08:Port12 -> SRV-U01:eth0 (preserved)
      3. Second server chain: SW-U02:Gi0/5 -> PP-U06:Port5 -> SRV-U01:eth1
      4. Greedy fill: each remaining switch port -> nearest patch panel by U-distance
      5. Overflow (when PPs are full) -> AGG-CORE (extra uplinks)

    The number of cables touching each device equals the scan's connected_ports
    count for that device, so the CMDB topology matches the photographed rack.
    """
    with open(scan_path, "r", encoding="utf-8") as f:
        scan = json.load(f)

    by_u = {}
    for d in scan["devices"]:
        m = re.match(r"U(\d{2})", d["position"])
        if m:
            by_u[int(m.group(1))] = d

    connected = {}
    for sw_name in switches:
        u = int(sw_name.split("-U")[1])
        d = by_u.get(u)
        connected[sw_name] = d["connected_ports"] if d and d["class_name"] == "Switch" else 0
    for pp_name in patch_panels:
        u = int(pp_name.split("-U")[1])
        d = by_u.get(u)
        connected[pp_name] = d["connected_ports"] if d and d["class_name"] == "Patch Panel" else 0

    used = {n: set() for n in list(switches) + list(patch_panels) + [AGG_CORE_NAME]}

    def total_ports(name):
        if name in switches:
            return switches[name]["ports"] + switches[name].get("sfp_ports", 0)
        if name in patch_panels:
            return patch_panels[name]["ports"]
        if name == AGG_CORE_NAME:
            return AGG_CORE["ports"] + AGG_CORE.get("sfp_ports", 0)
        return 0

    def alloc_port(name, prefer=None):
        cap = total_ports(name)
        if prefer is not None and prefer not in used[name] and 1 <= prefer <= cap:
            used[name].add(prefer)
            return prefer
        for i in range(1, cap + 1):
            if i not in used[name]:
                used[name].add(i)
                return i
        raise RuntimeError(f"out of ports on {name} (cap={cap})")

    def port_label(device, port_num):
        if device in switches:
            return f"{device}:{switches[device]['port_prefix']}{port_num}"
        if device in patch_panels:
            return f"{device}:Port{port_num}"
        if device == AGG_CORE_NAME:
            return f"{device}:{AGG_CORE['port_prefix']}{port_num}"
        raise ValueError(f"unknown device {device}")

    cables = []
    cable_counter = [200]  # demo chain uses C-0142..0145; auto-IDs start at C-0201

    def next_cable_id():
        cable_counter[0] += 1
        return f"C-{cable_counter[0]:04d}"

    # 1. Uplinks: up to 4 per active switch, top-of-rack first (stable order).
    UPLINKS_PER_SW = 4
    active_switches = sorted(
        [sw for sw, c in connected.items() if c > 0 and sw in switches],
        key=lambda n: -int(n.split("-U")[1]),
    )
    for sw in active_switches:
        for _ in range(min(UPLINKS_PER_SW, connected[sw])):
            sp = alloc_port(sw)
            ap = alloc_port(AGG_CORE_NAME)
            cables.append((sw, port_label(sw, sp), AGG_CORE_NAME, port_label(AGG_CORE_NAME, ap),
                           next_cable_id(), "Cat6a", "5m"))

    # 2. Demo chain (preserves original SW-U10 port 12 broken-port story).
    if "SW-U10" in switches and "PP-U08" in patch_panels and connected.get("SW-U10", 0) >= 5:
        sw_p = alloc_port("SW-U10", prefer=12)
        pp_p = alloc_port("PP-U08", prefer=12)
        cables.append(("SW-U10", port_label("SW-U10", sw_p),
                       "PP-U08", port_label("PP-U08", pp_p),
                       "C-0142", "Cat6a", "2m"))
        cables.append(("PP-U08", port_label("PP-U08", pp_p),
                       server["name"], f"{server['name']}:eth0",
                       "C-0143", "Cat6a", "3m"))

    # 3. Second server chain.
    if "SW-U02" in switches and "PP-U06" in patch_panels and connected.get("SW-U02", 0) >= 5:
        sw_p = alloc_port("SW-U02", prefer=5)
        pp_p = alloc_port("PP-U06", prefer=5)
        cables.append(("SW-U02", port_label("SW-U02", sw_p),
                       "PP-U06", port_label("PP-U06", pp_p),
                       "C-0144", "Cat6a", "2m"))
        cables.append(("PP-U06", port_label("PP-U06", pp_p),
                       server["name"], f"{server['name']}:eth1",
                       "C-0145", "Cat6a", "3m"))

    # 4. Greedy-fill remaining switch connected ports to nearest PP.
    def u_pos(name):
        return int(name.split("-U")[1])

    sw_remaining = {sw: max(0, connected[sw] - len(used[sw])) for sw in active_switches}
    active_pps = sorted([pp for pp, c in connected.items() if pp in patch_panels and c > 0],
                       key=lambda n: u_pos(n))
    pp_remaining = {pp: max(0, connected[pp] - len(used[pp])) for pp in active_pps}

    for sw in active_switches:
        sw_u = u_pos(sw)
        sorted_pps = sorted(active_pps, key=lambda pp: abs(u_pos(pp) - sw_u))
        for pp in sorted_pps:
            while sw_remaining[sw] > 0 and pp_remaining[pp] > 0:
                sp = alloc_port(sw)
                pp_p = alloc_port(pp)
                length = f"{1 + ((sp + pp_p) % 5)}m"
                cables.append((sw, port_label(sw, sp), pp, port_label(pp, pp_p),
                               next_cable_id(), "Cat6a", length))
                sw_remaining[sw] -= 1
                pp_remaining[pp] -= 1

    # 5. Overflow → AGG-CORE.
    for sw in active_switches:
        while sw_remaining[sw] > 0:
            sp = alloc_port(sw)
            ap = alloc_port(AGG_CORE_NAME)
            cables.append((sw, port_label(sw, sp), AGG_CORE_NAME, port_label(AGG_CORE_NAME, ap),
                           next_cable_id(), "Cat6a", "5m"))
            sw_remaining[sw] -= 1

    return cables, scan


# ─────────────────────────────────────────────────────────────────────────────
# Topology snapshot — frontend reads this as the source of truth for /api/topology
# ─────────────────────────────────────────────────────────────────────────────

def write_topology_snapshot(scan, switches, patch_panels, server, cables, output_dir):
    devices = []

    # Switches in rack
    for sw_name, details in switches.items():
        u = int(sw_name.split("-U")[1])
        total = details["ports"] + details.get("sfp_ports", 0)
        ports = []
        for i in range(1, total + 1):
            is_sfp = i > details["ports"]
            ports.append({
                "name": f"{sw_name}:{details['port_prefix']}{i}" if details["port_prefix"] else f"{sw_name}:p{i}",
                "label": f"{details['port_prefix']}{i}" if details["port_prefix"] else f"p{i}",
                "kind": "sfp" if is_sfp else "main",
                "is_uplink": i >= total - 1 and total > 0,
            })
        devices.append({
            "name": sw_name,
            "class": "switch",
            "u_position": u,
            "u_size": 1,
            "model": details["model_number"],
            "mgmt_ip": details["mgmt_ip"],
            "in_rack": True,
            "ports": ports,
            "summary": f"{total} port{'s' if total != 1 else ''}" if total else "no ports detected",
        })

    # Patch panels in rack
    for pp_name, details in patch_panels.items():
        u = int(pp_name.split("-U")[1])
        ports = []
        for i in range(1, details["ports"] + 1):
            ports.append({
                "name": f"{pp_name}:Port{i}",
                "label": f"Port{i}",
                "kind": "main",
                "is_uplink": False,
            })
        devices.append({
            "name": pp_name,
            "class": "patch_panel",
            "u_position": u,
            "u_size": 1,
            "model": details["model_number"],
            "mgmt_ip": None,
            "in_rack": True,
            "ports": ports,
            "summary": f"{details['ports']} ports",
        })

    # Server
    server_ports = [{"name": nic["name"], "label": nic["alias"], "kind": "nic", "is_uplink": False}
                    for nic in server["nics"]]
    devices.append({
        "name": server["name"],
        "class": "server",
        "u_position": 1,
        "u_size": 1,
        "model": server["meta"]["model_number"],
        "mgmt_ip": server["nics"][0]["ip"] if server["nics"] else None,
        "in_rack": True,
        "ports": server_ports,
        "summary": "Dell PowerEdge — 2 NICs",
        "extras": {
            "disks": [
                {
                    "name": d["name"],
                    "size_bytes": d["size_bytes"],
                    "partitions": [{"name": p["name"], "size_bytes": p["size_bytes"]} for p in d["partitions"]],
                }
                for d in server["disks"]
            ],
        },
    })

    # Closed units / unidentified — purely visual placeholders.
    # Skip a U if a switch/PP/server already covers it (e.g. SW-U07 covers
    # the "Unidentified" detection at U07).
    occupied_u = {d["u_position"] for d in devices if d.get("u_position") is not None}
    for d in scan["devices"]:
        if d["class_name"] in ("Closed Unit", "Unidentified"):
            m = re.match(r"U(\d{2})", d["position"])
            if not m:
                continue
            u = int(m.group(1))
            if u in occupied_u:
                continue
            klass = "closed_unit" if d["class_name"] == "Closed Unit" else "unidentified"
            devices.append({
                "name": d["label"],
                "class": klass,
                "u_position": u,
                "u_size": 1,
                "model": None,
                "mgmt_ip": None,
                "in_rack": True,
                "ports": [],
                "summary": d["class_name"],
            })

    # AGG-CORE (out of rack)
    agg_total = AGG_CORE["ports"] + AGG_CORE.get("sfp_ports", 0)
    agg_ports = [{"name": f"{AGG_CORE_NAME}:{AGG_CORE['port_prefix']}{i}",
                  "label": f"{AGG_CORE['port_prefix']}{i}",
                  "kind": "uplink",
                  "is_uplink": True}
                 for i in range(1, agg_total + 1)]
    devices.append({
        "name": AGG_CORE_NAME,
        "class": "switch",
        "u_position": None,
        "u_size": None,
        "model": AGG_CORE["model_number"],
        "mgmt_ip": AGG_CORE["mgmt_ip"],
        "in_rack": False,
        "ports": agg_ports,
        "summary": "Adjacent-rack aggregation switch",
    })

    edges = []
    for src_d, src_p, dst_d, dst_p, cid, ctype, length in cables:
        edges.append({
            "src": {"device": src_d, "port": src_p},
            "dst": {"device": dst_d, "port": dst_p},
            "cable_id": cid,
            "cable_type": ctype,
            "length": length,
        })

    snapshot = {
        "schema": "topology.v1",
        "rackId": SCAN_RACK_ID,
        "rackName": RACK_NAME,
        "u_size": 18,
        "generated_at": dt.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "image": scan.get("image"),
        "devices": devices,
        "edges": edges,
        "stats": {
            "device_count_in_rack": sum(1 for d in devices if d["in_rack"]),
            "edge_count": len(edges),
        },
    }

    out_path = os.path.join(output_dir, "topology.json")
    os.makedirs(output_dir, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(snapshot, f, indent=2)
    print(f"[snapshot] wrote {out_path} — {snapshot['stats']['device_count_in_rack']} devices, {len(edges)} edges")
    return snapshot


def main() -> int:
    load_dotenv()
    instance = os.environ["SN_INSTANCE"]
    auth = (os.environ["SN_USER"], os.environ["SN_PASSWORD"])
    base = f"https://{instance}.service-now.com/api/now"
    headers = {"Accept": "application/json", "Content-Type": "application/json"}

    import time as _time
    def _retry(fn):
        last = None
        for attempt in range(4):
            try:
                return fn()
            except (requests.exceptions.ReadTimeout, requests.exceptions.ConnectionError) as e:
                last = e
                _time.sleep(2 * (attempt + 1))
        raise last

    def find(table, query):
        def _do():
            r = requests.get(f"{base}/table/{table}", params={"sysparm_query": query, "sysparm_limit": 1}, auth=auth, headers=headers, timeout=90)
            r.raise_for_status()
            return r.json().get("result", [])
        rows = _retry(_do)
        return rows[0] if rows else None

    def create(table, payload):
        def _do():
            r = requests.post(f"{base}/table/{table}", json=payload, auth=auth, headers=headers, timeout=90)
            r.raise_for_status()
            return r.json()["result"]
        return _retry(_do)

    def patch_ci(table, sys_id, payload):
        def _do():
            r = requests.patch(f"{base}/table/{table}/{sys_id}", json=payload, auth=auth, headers=headers, timeout=90)
            r.raise_for_status()
            return r.json()["result"]
        return _retry(_do)

    def upsert(table, name, extra_query, payload):
        query = f"name={name}"
        if extra_query:
            query += f"^{extra_query}"
        ex = find(table, query)
        if ex:
            return ex, False
        created = create(table, {"name": name, **payload})
        return created, True

    def ensure_rel(parent_sys_id, child_sys_id, rel_type):
        existing = find("cmdb_rel_ci", f"parent={parent_sys_id}^child={child_sys_id}^type={rel_type}")
        if existing:
            return False
        create("cmdb_rel_ci", {"parent": parent_sys_id, "child": child_sys_id, "type": rel_type})
        return True

    # 0. Resolve rel types
    global CONTAINS_REL_TYPE
    rt = find("cmdb_rel_type", "name=Contains::Contained by")
    CONTAINS_REL_TYPE = rt["sys_id"]
    print(f"Contains rel type: {CONTAINS_REL_TYPE}")
    print(f"Connects to rel type: {CONNECTS_TO_REL_TYPE}")

    # 1. Undo drift demo: rename SW-U11 -> SW-U10 if needed
    sw_u11 = find("cmdb_ci_ip_switch", "name=SW-U11")
    if sw_u11:
        patch_ci("cmdb_ci_ip_switch", sw_u11["sys_id"], {"name": "SW-U10"})
        print("[revert] SW-U11 -> SW-U10 (drift demo undone)")

    # 2. Enrich rack
    rack = find("cmdb_ci_rack", f"name={RACK_NAME}")
    if not rack:
        print(f"ERROR: {RACK_NAME} not found. Run bootstrap_cmdb.py first.")
        return 1
    patch_ci("cmdb_ci_rack", rack["sys_id"], RACK_META)
    print(f"[enriched] rack {RACK_NAME}")

    # 3. Enrich + port-create switches (matches scan port_count + sfp_ports)
    for sw_name, details in SWITCHES.items():
        sw = find("cmdb_ci_ip_switch", f"name={sw_name}")
        if not sw:
            print(f"  skip {sw_name} (not found)")
            continue
        patch_ci("cmdb_ci_ip_switch", sw["sys_id"], {
            "model_number": details["model_number"],
            "serial_number": details["serial_number"],
            "ip_address": details["mgmt_ip"],
            "mac_address": details["mac"],
            "os_version": details["os"],
            "short_description": details["short_description"],
        })
        total = details["ports"] + details.get("sfp_ports", 0)
        print(f"[enriched] switch {sw_name} ({total} ports = {details['ports']} main + {details.get('sfp_ports', 0)} sfp)")
        created_ports = 0
        for i in range(1, total + 1):
            is_sfp = i > details["ports"]
            port_name = f"{sw_name}:{details['port_prefix']}{i}"
            admin_state = "up" if i <= (total - 2) else "down"
            vlan = {10: 10, 20: 20, 30: 30}.get(i, 10)
            is_uplink = i >= total - 1
            # SW-U10 port 12 is the demo broken-port
            oper_state = "up" if not (sw_name == "SW-U10" and i == 12) else "DOWN"
            kind = "SFP+" if is_sfp else "RJ45"
            sd = (
                f"admin={admin_state} oper={oper_state} speed={'10G' if is_sfp or is_uplink else '1G'} "
                f"duplex=full vlan={vlan} mode={'trunk' if is_uplink else 'access'} "
                f"stp={'forwarding' if oper_state == 'up' else 'disabled'} kind={kind}"
            )
            mac = f"AA:BB:CC:{int(sw_name[-2:]):02X}:{i:02X}:{i:02X}"
            port, made = upsert("cmdb_ci_network_adapter", port_name, f"cmdb_ci={sw['sys_id']}", {
                "cmdb_ci": sw["sys_id"],
                "mac_address": mac,
                "short_description": sd,
                "alias": f"{details['port_prefix']}{i}",
            })
            if made:
                created_ports += 1
                ensure_rel(sw["sys_id"], port["sys_id"], CONTAINS_REL_TYPE)
        print(f"  + {created_ports} new ports ({total} total in CMDB)")

    # 4. Upsert AGG-CORE-01 (out-of-rack uplink termination)
    print(f"[agg] upsert {AGG_CORE_NAME}")
    agg, made = upsert("cmdb_ci_ip_switch", AGG_CORE_NAME, "", {
        "model_number": AGG_CORE["model_number"],
        "serial_number": AGG_CORE["serial_number"],
        "ip_address": AGG_CORE["mgmt_ip"],
        "mac_address": AGG_CORE["mac"],
        "os_version": AGG_CORE["os"],
        "short_description": AGG_CORE["short_description"],
    })
    print(f"  {'[new]' if made else '[skip]'} {AGG_CORE_NAME} (sys_id={agg['sys_id']})")
    # Patch even if skipped, to ensure attrs are current
    if not made:
        patch_ci("cmdb_ci_ip_switch", agg["sys_id"], {
            "model_number": AGG_CORE["model_number"],
            "ip_address": AGG_CORE["mgmt_ip"],
            "short_description": AGG_CORE["short_description"],
        })
    agg_total = AGG_CORE["ports"] + AGG_CORE.get("sfp_ports", 0)
    created_ports = 0
    for i in range(1, agg_total + 1):
        port_name = f"{AGG_CORE_NAME}:{AGG_CORE['port_prefix']}{i}"
        sd = f"admin=up oper=up speed=10G mode=trunk role=aggregation-uplink"
        mac = f"AA:BB:CC:99:99:{i:02X}"
        port, was_new = upsert("cmdb_ci_network_adapter", port_name, f"cmdb_ci={agg['sys_id']}", {
            "cmdb_ci": agg["sys_id"],
            "mac_address": mac,
            "short_description": sd,
            "alias": f"{AGG_CORE['port_prefix']}{i}",
        })
        if was_new:
            created_ports += 1
            ensure_rel(agg["sys_id"], port["sys_id"], CONTAINS_REL_TYPE)
    print(f"  + {created_ports} new uplink ports ({agg_total} total)")

    # 5. Enrich + port-create patch panels
    for pp_name, details in PATCH_PANELS.items():
        pp = find("cmdb_ci_netgear", f"name={pp_name}")
        if not pp:
            print(f"  skip {pp_name}")
            continue
        patch_ci("cmdb_ci_netgear", pp["sys_id"], {
            "model_number": details["model_number"],
            "serial_number": details["serial_number"],
            "short_description": details["short_description"],
        })
        print(f"[enriched] patch panel {pp_name} ({details['ports']} ports)")
        created_ports = 0
        for i in range(1, details["ports"] + 1):
            port_name = f"{pp_name}:Port{i}"
            sd = f"type=Cat6a length={2 + i % 3}m label=PP-{pp_name[-3:]}-{i:02d}"
            port, made = upsert("cmdb_ci_port", port_name, "", {
                "short_description": sd,
                "model_number": "Panduit Cat6a Jack",
            })
            if made:
                created_ports += 1
                ensure_rel(pp["sys_id"], port["sys_id"], CONTAINS_REL_TYPE)
        print(f"  + {created_ports} new ports ({details['ports']} total)")

    # 6. Enrich server + create NICs, disks, partitions
    srv = find("cmdb_ci_server", f"name={SERVER['name']}")
    if srv:
        patch_ci("cmdb_ci_server", srv["sys_id"], SERVER["meta"])
        print(f"[enriched] server {SERVER['name']}")
        for nic in SERVER["nics"]:
            adapter, made = upsert("cmdb_ci_network_adapter", nic["name"], f"cmdb_ci={srv['sys_id']}", {
                "cmdb_ci": srv["sys_id"],
                "mac_address": nic["mac"],
                "ip_address": nic["ip"],
                "netmask": nic["netmask"],
                "ip_default_gateway": nic["gateway"],
                "fqdn": nic["fqdn"],
                "alias": nic["alias"],
                "short_description": nic["short_description"],
            })
            if made:
                ensure_rel(srv["sys_id"], adapter["sys_id"], CONTAINS_REL_TYPE)
                print(f"  + NIC {nic['name']}")
        for disk in SERVER["disks"]:
            d, made = upsert("cmdb_ci_disk", disk["name"], "", {
                "size_bytes": disk["size_bytes"],
                "short_description": disk["short_description"],
            })
            if made:
                ensure_rel(srv["sys_id"], d["sys_id"], CONTAINS_REL_TYPE)
                print(f"  + disk {disk['name']}")
            for p in disk["partitions"]:
                pname = f"{disk['name']}:{p['name']}"
                part, made_p = upsert("cmdb_ci_disk_partition", pname, f"computer={srv['sys_id']}", {
                    "computer": srv["sys_id"],
                    "disk": d["sys_id"],
                    "partition_number": p["partition_number"],
                    "size_bytes": p["size_bytes"],
                    "short_description": p["short_description"],
                })
                if made_p:
                    print(f"    + partition {pname}")

    # 7. Cable relationships (Connects to between ports) — derived from scan
    print(f"[cables] deriving wiring from {SCAN_PATH}")
    cables, scan = derive_wiring_from_scan(SCAN_PATH, SWITCHES, PATCH_PANELS, SERVER)
    print(f"[cables] {len(cables)} cables derived; pushing Connects-to rels to CMDB")
    new_count = 0
    miss_count = 0
    for src_name, src_port, dst_name, dst_port, cable_id, cable_type, length in cables:
        src_p = find("cmdb_ci_network_adapter", f"name={src_port}") or find("cmdb_ci_port", f"name={src_port}")
        dst_p = find("cmdb_ci_network_adapter", f"name={dst_port}") or find("cmdb_ci_port", f"name={dst_port}")
        if not src_p or not dst_p:
            print(f"  MISS: {src_port} <-> {dst_port}")
            miss_count += 1
            continue
        src_table = "cmdb_ci_network_adapter" if src_p.get("mac_address") is not None else "cmdb_ci_port"
        dst_table = "cmdb_ci_network_adapter" if dst_p.get("mac_address") is not None else "cmdb_ci_port"
        cable_note = f" cable_id={cable_id} cable_type={cable_type} cable_length={length}"
        # Avoid endlessly appending cable notes on rerun
        sd_src = src_p.get("short_description", "") or ""
        if cable_id not in sd_src:
            patch_ci(src_table, src_p["sys_id"], {"short_description": (sd_src + cable_note).strip()})
        sd_dst = dst_p.get("short_description", "") or ""
        if cable_id not in sd_dst:
            patch_ci(dst_table, dst_p["sys_id"], {"short_description": (sd_dst + cable_note).strip()})
        if ensure_rel(src_p["sys_id"], dst_p["sys_id"], CONNECTS_TO_REL_TYPE):
            new_count += 1
    print(f"[cables] {new_count} new rels, {len(cables) - new_count - miss_count} already existed, {miss_count} missed")

    # 8. Topology snapshot
    write_topology_snapshot(scan, SWITCHES, PATCH_PANELS, SERVER, cables, OUTPUT_DIR)

    print()
    print("Done. CMDB is fully enriched and topology snapshot written.")
    print(f"  Snapshot: outputs/{SCAN_RACK_ID}/topology.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())

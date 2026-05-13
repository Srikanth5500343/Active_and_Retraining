"""
Realistic synthetic network topology generator.
Builds a CLOS fabric: 5 spines, 20 leaves, 52 ports each.
"""

import json
import random
from datetime import datetime, timedelta
from pathlib import Path

NUM_SPINES        = 5
NUM_LEAVES        = 20
PORTS_PER_SWITCH  = 52
HOST_OCCUPANCY    = 0.70
ARCHIVED_FRACTION = 0.15
MOVED_FRACTION    = 0.05

OUTPUT_DIR = Path("topology_data")

VENDOR_OUIS = {
    "Apple":     ["00:1A:11", "AC:DE:48", "F0:18:98", "A4:83:E7"],
    "Dell":      ["00:14:22", "B8:CA:3A", "D4:BE:D9", "F8:DB:88"],
    "HP":        ["00:1F:29", "EC:B1:D7", "9C:8E:99", "70:5A:0F"],
    "Intel":     ["00:1B:21", "A0:36:9F", "EC:8E:B5", "3C:FD:FE"],
    "Cisco":     ["00:1B:0C", "00:1E:13", "F4:CF:E2", "70:E4:22"],
    "Lenovo":    ["00:21:CC", "54:E1:AD", "C8:5B:76", "E4:54:E8"],
    "Samsung":   ["00:12:FB", "84:25:DB", "C8:19:F7"],
    "Huawei":    ["00:18:82", "D4:6E:5C", "78:1D:BA"],
    "Raspberry": ["B8:27:EB", "DC:A6:32", "E4:5F:01"],
    "Polycom":   ["00:04:F2", "64:16:7F"],
    "AxisCam":   ["00:40:8C", "AC:CC:8E"],
}

DEVICE_TYPES = [
    ("workstation", "pc",       ["Dell", "HP", "Lenovo"],            25),
    ("laptop",      "lt",       ["Apple", "Dell", "HP", "Lenovo"],    20),
    ("server",      "srv",      ["Dell", "HP", "Intel"],              10),
    ("printer",     "prn",      ["HP"],                                5),
    ("phone",       "phone",    ["Cisco", "Polycom"],                 15),
    ("camera",      "cam",      ["AxisCam"],                           5),
    ("iot",         "iot",      ["Raspberry"],                         5),
    ("ap",          "ap",       ["Cisco", "Huawei"],                   5),
    ("mobile",      "mob",      ["Samsung", "Apple"],                  5),
    ("tv",          "tv",       ["Samsung"],                           2),
    ("voip",        "voip",     ["Cisco", "Polycom"],                  3),
]

DEPARTMENTS = {
    "fin":     {"vlan": 10, "desc": "Finance"},
    "hr":      {"vlan": 20, "desc": "Human Resources"},
    "eng":     {"vlan": 30, "desc": "Engineering"},
    "mkt":     {"vlan": 40, "desc": "Marketing"},
    "ops":     {"vlan": 50, "desc": "Operations"},
    "it":      {"vlan": 60, "desc": "IT"},
    "sales":   {"vlan": 70, "desc": "Sales"},
    "lab":     {"vlan": 80, "desc": "Lab/Testing"},
    "rnd":     {"vlan": 90, "desc": "R&D"},
    "qa":      {"vlan": 100, "desc": "QA"},
}

HOST_NAMES = {
    "workstation": ["ws", "desktop", "pc"],
    "laptop": ["laptop", "macbook", "thinkpad"],
    "server": ["srv", "web", "db", "app", "file"],
    "printer": ["printer", "mfp"],
    "phone": ["phone", "voip", "handset"],
    "camera": ["cam", "nvr"],
    "iot": ["iot", "sensor", "device"],
    "ap": ["ap", "wifi", "access"],
    "mobile": ["mobile", "phone", "ipad"],
    "tv": ["display", "screen"],
    "voip": ["voip", "pbx"],
}

SPINE_MODELS = [
    ("Arista",  "DCS-7280SR3-48YC8", "EOS",   "4.32.0F"),
    ("Cisco",   "Nexus 9504",         "NX-OS", "10.3(2)F"),
    ("Juniper", "QFX10002-60C",       "Junos", "23.4R1"),
]
LEAF_MODELS = [
    ("Arista",  "DCS-7050SX3-48YC8", "EOS",   "4.32.0F"),
    ("Cisco",   "Nexus 93180YC-FX",  "NX-OS", "10.3(2)F"),
    ("Cumulus", "Mellanox SN2410",   "CL",    "5.7.0"),
    ("Juniper", "QFX5120-48Y",       "Junos", "23.4R1"),
]


def random_mac(oui):
    suffix = ":".join(f"{random.randint(0, 255):02x}" for _ in range(3))
    return f"{oui.lower()}:{suffix}"


def chassis_mac(idx):
    return f"44:38:39:00:{(idx >> 8) & 0xff:02x}:{idx & 0xff:02x}"


def random_iso_ts(start_days_ago=400, end_days_ago=0):
    base = datetime(2026, 4, 29, 10, 30, 0)
    delta_days = random.uniform(end_days_ago, start_days_ago)
    ts = base - timedelta(days=delta_days)
    return ts.strftime("%Y-%m-%dT%H:%M:%S")


def make_host(leaf_idx, port_num, host_counter):
    chosen = random.choices(DEVICE_TYPES, weights=[d[3] for d in DEVICE_TYPES])[0]
    dtype, hint, vendor_pool, _ = chosen
    vendor = random.choice(vendor_pool)
    oui = random.choice(VENDOR_OUIS[vendor])
    dept_code = random.choice(list(DEPARTMENTS.keys()))
    dept_info = DEPARTMENTS[dept_code]
    
    # Generate realistic hostname
    prefix = random.choice(HOST_NAMES[dtype])
    counter = host_counter % 100
    hostname = f"{prefix}-{dept_code}-{counter:02d}"
    
    # IP based on department
    subnet = dept_info["vlan"]
    ip = f"10.{subnet}.{(port_num // 4) + 1}.{(port_num % 4) * 60 + random.randint(10, 60)}"
    vlan = dept_info["vlan"]
    
    return {
        "name": hostname, "mac": random_mac(oui), "ip": ip,
        "vendor": vendor, "type": dtype, "vlan": vlan,
        "dept": dept_code, "dept_name": dept_info["desc"],
    }


def build():
    random.seed(42)
    devices, ports, nodes, ip_records = [], [], [], []

    for s in range(1, NUM_SPINES + 1):
        ip = f"192.168.100.{s}"
        name = f"spine{s:02d}"
        cmac = chassis_mac(s)
        vendor, model, os_name, os_ver = random.choice(SPINE_MODELS)
        devices.append({
            "ip": ip, "dns": name, "name": name,
            "mac": cmac, "serial": cmac,
            "vendor": vendor, "model": model,
            "os": os_name, "os_ver": os_ver,
            "uptime_days": random.randint(30, 800),
            "role": "spine",
            "location": f"DC1 / Row{s} / Rack-Spine",
        })
        # Add loopback port
        ports.append({
            "ip": ip, "port": "lo", "name": "lo",
            "mac": cmac, "up": "up", "up_admin": "up",
            "speed": None, "vlan": None,
            "remote_id": None, "remote_dns": None, "remote_ip": None, "remote_port": None,
            "descr": "loopback",
        })
        # Add switch ports (swp) for spine-to-leaf connections
        for p in range(1, NUM_LEAVES + 1):
            ports.append({
                "ip": ip, "port": f"swp{p}", "name": f"swp{p}",
                "mac": cmac,
                "up": "up",
                "up_admin": "up",
                "speed": "100GbE",
                "vlan": None,
                "remote_id": None, "remote_dns": None, "remote_ip": None, "remote_port": None,
                "descr": f"to leaf{p:02d}",
            })
        # Remaining ports as unused
        for p in range(NUM_LEAVES + 1, PORTS_PER_SWITCH + 1):
            ports.append({
                "ip": ip, "port": f"swp{p}", "name": f"swp{p}",
                "mac": cmac,
                "up": "down",
                "up_admin": "down",
                "speed": "100GbE",
                "vlan": None,
                "remote_id": None, "remote_dns": None, "remote_ip": None, "remote_port": None,
                "descr": "unused",
            })

    for L in range(1, NUM_LEAVES + 1):
        ip = f"192.168.100.{100 + L}"
        name = f"leaf{L:02d}"
        cmac = chassis_mac(100 + L)
        vendor, model, os_name, os_ver = random.choice(LEAF_MODELS)
        rack = ((L - 1) // 4) + 1
        devices.append({
            "ip": ip, "dns": name, "name": name,
            "mac": cmac, "serial": cmac,
            "vendor": vendor, "model": model,
            "os": os_name, "os_ver": os_ver,
            "uptime_days": random.randint(10, 600),
            "role": "leaf",
            "location": f"DC1 / Row{rack} / Rack{L:02d}",
        })
        # Add loopback
        ports.append({
            "ip": ip, "port": "lo", "name": "lo",
            "mac": cmac, "up": "up", "up_admin": "up",
            "speed": None, "vlan": None,
            "remote_id": None, "remote_dns": None, "remote_ip": None, "remote_port": None,
            "descr": "loopback",
        })
        # Add access ports (eth) for host connections
        num_access_ports = PORTS_PER_SWITCH - NUM_SPINES
        for p in range(1, num_access_ports + 1):
            access_vlan = list(DEPARTMENTS.values())[p % len(DEPARTMENTS)]["vlan"]
            ports.append({
                "ip": ip, "port": f"eth{p}", "name": f"eth{p}",
                "mac": cmac, "up": "up", "up_admin": "up",
                "speed": "25GbE",
                "vlan": str(access_vlan),
                "remote_id": None, "remote_dns": None, "remote_ip": None, "remote_port": None,
                "descr": f"access vlan {access_vlan}",
            })
        # Add uplink ports (swp) for spine connections
        for p in range(1, NUM_SPINES + 1):
            ports.append({
                "ip": ip, "port": f"swp{p}", "name": f"swp{p}",
                "mac": cmac, "up": "up", "up_admin": "up",
                "speed": "100GbE",
                "vlan": None,
                "remote_id": None, "remote_dns": None, "remote_ip": None, "remote_port": None,
                "descr": f"to spine{p:02d}",
            })

    port_index = {(p["ip"], p["port"]): p for p in ports}
    for L in range(1, NUM_LEAVES + 1):
        leaf_ip = f"192.168.100.{100 + L}"
        leaf_cmac = chassis_mac(100 + L)
        for s in range(1, NUM_SPINES + 1):
            spine_ip = f"192.168.100.{s}"
            spine_cmac = chassis_mac(s)
            leaf_port = f"swp{s}"  # leaf uplink swp1-swp5
            spine_port = f"swp{L}"  # spine switch port swp1-swp20
            lp = port_index[(leaf_ip, leaf_port)]
            lp["remote_id"] = spine_cmac
            lp["remote_dns"] = f"spine{s:02d}"
            lp["remote_ip"] = spine_ip
            lp["remote_port"] = spine_port
            sp = port_index[(spine_ip, spine_port)]
            sp["remote_id"] = leaf_cmac
            sp["remote_dns"] = f"leaf{L:02d}"
            sp["remote_ip"] = leaf_ip
            sp["remote_port"] = leaf_port

    for L in range(1, NUM_LEAVES + 1):
        leaf_ip = f"192.168.100.{100 + L}"
        for p in range(1, PORTS_PER_SWITCH - NUM_SPINES + 1):
            if random.random() > HOST_OCCUPANCY:
                continue
            host = make_host(L, p, len(nodes))
            archived = random.random() < ARCHIVED_FRACTION
            first = random_iso_ts(start_days_ago=400, end_days_ago=200)
            last = random_iso_ts(start_days_ago=180, end_days_ago=80) if archived \
                else random_iso_ts(start_days_ago=7, end_days_ago=0)

            # Update the port description with the connected host
            port_key = (leaf_ip, f"eth{p}")
            if port_key in port_index:
                port_index[port_key]["descr"] = f"{host['name']} ({host['type']})"

            nodes.append({
                "switch": leaf_ip, "dns": f"leaf{L:02d}",
                "port": f"eth{p}", "mac": host["mac"],
                "vlan": host["vlan"], "active": not archived,
                "time_first": first, "time_last": last,
                "vendor": host["vendor"], "type": host["type"],
                "hostname": host["name"], "dept": host["dept"],
            })
            ip_records.append({
                "mac": host["mac"], "ip": host["ip"], "dns": host["name"],
                "active": not archived,
                "time_first": first, "time_last": last,
            })

            if random.random() < MOVED_FRACTION:
                other_leaf = random.choice([x for x in range(1, NUM_LEAVES + 1) if x != L])
                other_port = random.randint(1, PORTS_PER_SWITCH - NUM_SPINES)
                old_first = random_iso_ts(start_days_ago=600, end_days_ago=400)
                old_last = random_iso_ts(start_days_ago=400, end_days_ago=200)
                nodes.append({
                    "switch": f"192.168.100.{100 + other_leaf}",
                    "dns": f"leaf{other_leaf:02d}",
                    "port": f"eth{other_port}",
                    "mac": host["mac"], "vlan": host["vlan"],
                    "active": False,
                    "time_first": old_first, "time_last": old_last,
                    "vendor": host["vendor"], "type": host["type"],
                    "hostname": host["name"],
                })

    return devices, ports, nodes, ip_records


def write_outputs(devices, ports, nodes, ip_records):
    OUTPUT_DIR.mkdir(exist_ok=True)
    (OUTPUT_DIR / "devices.json").write_text(json.dumps(devices, indent=2))
    (OUTPUT_DIR / "ports.json").write_text(json.dumps(ports, indent=2))
    (OUTPUT_DIR / "nodes.json").write_text(json.dumps(nodes, indent=2))
    (OUTPUT_DIR / "ips.json").write_text(json.dumps(ip_records, indent=2))
    print(f"  Wrote {len(devices)} devices, {len(ports)} ports, "
          f"{len(nodes)} sightings, {len(ip_records)} ip bindings to {OUTPUT_DIR}/")


if __name__ == "__main__":
    devices, ports, nodes, ip_records = build()
    write_outputs(devices, ports, nodes, ip_records)
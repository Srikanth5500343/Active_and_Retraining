"""
Netdisco Database Seeder (final, schema-matched)
=================================================
Loads synthetic topology JSON into a local Netdisco's PostgreSQL.

Tested against schema:
  device, device_port, node, node_ip   (Netdisco 2.x)

Prerequisites:
  - Netdisco running via docker compose at localhost
  - Port 5432 exposed to host (your compose.yaml has this)
  - pip install psycopg2-binary
  - topology_data/ folder (from generate_topology.py) sitting next to this script
"""

import json
import sys
from pathlib import Path

try:
    import psycopg2
    from psycopg2.extras import execute_batch, Json
except ImportError:
    print("Missing dependency. Run:  pip install psycopg2-binary")
    sys.exit(1)

DATA_DIR = Path("topology_data")

DB_CONFIG = {
    "host":     "localhost",
    "port":     5432,
    "dbname":   "netdisco",
    "user":     "netdisco",
    "password": "netdisco",
}


# ---------------------------------------------------------------------------
def connect():
    try:
        conn = psycopg2.connect(**DB_CONFIG)
        conn.autocommit = False
        return conn
    except psycopg2.OperationalError as e:
        print("Could not connect to Netdisco's PostgreSQL.")
        print(f"  {e}")
        sys.exit(1)


def truncate_existing(cur):
    """Wipe any previous seed so we don't get duplicate-key errors on re-runs."""
    print("  Clearing previous seed data...")
    cur.execute("TRUNCATE topology, node_ip, node, device_port, device_ip, device CASCADE;")


def seed_device_ips(cur):
    """The Neighbors-tab netmap (Virtual::DeviceLinks) joins device_port.remote_ip
    against device_ip.alias. Without a row per device here, the CTE returns 0 rows
    and the topology graph renders empty even though device_port has neighbor data."""
    print("  Inserting device_ip aliases (required for netmap to resolve neighbors)...")
    cur.execute("""
        INSERT INTO device_ip (ip, alias, dns, creation)
        SELECT ip, ip, dns, NOW() FROM device
        ON CONFLICT DO NOTHING
    """)
    print(f"    Inserted {cur.rowcount} device_ip rows")


# ---------------------------------------------------------------------------
def seed_devices(cur, devices):
    print(f"  Inserting {len(devices)} devices...")
    rows = []
    for d in devices:
        # uptime is stored as bigint timeticks (1/100 sec). 1 day = 8_640_000.
        uptime_ticks = int(d["uptime_days"]) * 8_640_000
        # layers: 8-bit binary string. '00000010' = bit 1 (layer 2 / data link)
        # spines act as L3, leaves as L2/L3
        layers = "00000110" if d["role"] == "spine" else "00000010"
        rows.append((
            d["ip"],                  # ip (PK, inet)
            d["dns"],                 # dns
            d["dns"],                 # name (we use dns as name too)
            d["mac"],                 # mac (macaddr)
            d["serial"],              # serial
            d["vendor"],              # vendor
            d["model"],               # model
            d["os"],                  # os
            d["os_ver"],              # os_ver
            uptime_ticks,             # uptime
            d["location"],            # location
            layers,                   # layers
            f"{d['vendor']} {d['model']} running {d['os']} {d['os_ver']}",  # description
            d["mac"],                 # chassis_id (string form of MAC)
            52,                       # num_ports (we know it's 52)
        ))
    execute_batch(cur, """
        INSERT INTO device
            (ip, dns, name, mac, serial, vendor, model, os, os_ver, uptime,
             location, layers, description, chassis_id, num_ports,
             last_discover, last_macsuck, last_arpnip, creation)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                %s, %s, %s, %s, %s,
                NOW(), NOW(), NOW(), NOW())
    """, rows, page_size=100)


def seed_ports(cur, ports):
    print(f"  Inserting {len(ports)} ports...")
    rows = []
    for p in ports:
        # Netdisco uses 'descr' (not 'description') in device_port.
        rows.append((
            p["ip"],                              # ip
            p["port"],                            # port (PK part)
            p.get("name") or p["port"],           # name (display)
            p.get("descr") or "",                 # descr
            p["mac"],                             # mac
            p["up"],                              # up         ('up'/'down')
            p["up_admin"],                        # up_admin
            p["speed"],                           # speed
            p.get("vlan"),                        # vlan (text or NULL)
            p.get("remote_id"),                   # remote_id (chassis MAC of neighbor)
            p.get("remote_ip"),                   # remote_ip (IP address of neighbor device)
            p.get("remote_port"),                 # remote_port
            "ethernetCsmacd",                     # type
        ))
    execute_batch(cur, """
        INSERT INTO device_port
            (ip, port, name, descr, mac, up, up_admin, speed, vlan,
             remote_id, remote_ip, remote_port, type, creation)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s,
                %s, %s, %s, %s, NOW())
    """, rows, page_size=200)


def _oui_from_mac(mac):
    """Return the first 6 hex chars (no colons), upper-case — matches Netdisco's char(9) but truncated."""
    if not mac:
        return None
    hex_only = mac.replace(":", "").upper()
    return hex_only[:6]


def seed_nodes(cur, nodes):
    """node primary key is (mac, switch, port, vlan). De-dupe before insert."""
    print(f"  Inserting {len(nodes)} host sightings (deduped on PK)...")
    seen_keys = set()
    rows = []
    for n in nodes:
        vlan = str(n.get("vlan") or 0)
        key = (n["mac"], n["switch"], n["port"], vlan)
        if key in seen_keys:
            continue
        seen_keys.add(key)
        rows.append((
            n["mac"],                # mac
            n["switch"],             # switch (inet)
            n["port"],               # port
            vlan,                    # vlan (text)
            bool(n.get("active")),   # active
            _oui_from_mac(n["mac"]), # oui
            n["time_first"],         # time_first
            n["time_last"],          # time_recent
            n["time_last"],          # time_last
        ))
    execute_batch(cur, """
        INSERT INTO node
            (mac, switch, port, vlan, active, oui,
             time_first, time_recent, time_last)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
    """, rows, page_size=200)


def seed_node_ips(cur, ips):
    """node_ip primary key is (mac, ip, vrf). vrf has NOT NULL default ''."""
    print(f"  Inserting {len(ips)} MAC<->IP bindings...")
    seen_keys = set()
    rows = []
    for r in ips:
        key = (r["mac"], r["ip"], "")
        if key in seen_keys:
            continue
        seen_keys.add(key)
        rows.append((
            r["mac"],                  # mac
            r["ip"],                   # ip
            "",                        # vrf (PK part, default empty)
            bool(r.get("active")),     # active
            r.get("dns"),              # dns
            r["time_first"],           # time_first
            r["time_last"],            # time_last
        ))
    execute_batch(cur, """
        INSERT INTO node_ip
            (mac, ip, vrf, active, dns, time_first, time_last)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
    """, rows, page_size=200)


def seed_topology(cur):
    """Populate topology table with discovered neighbor relationships from device_port data."""
    print(f"  Populating topology table with neighbor relationships...")
    cur.execute("""
        INSERT INTO topology (dev1, port1, dev2, port2)
        SELECT 
          d1.ip as dev1,
          dp1.port as port1,
          d2.ip as dev2,
          dp1.remote_port as port2
        FROM device_port dp1
        JOIN device d1 ON dp1.ip = d1.ip
        JOIN device d2 ON dp1.remote_ip = d2.ip
        WHERE dp1.remote_id IS NOT NULL 
          AND dp1.remote_ip IS NOT NULL
          AND dp1.remote_port IS NOT NULL
    """)
    count = cur.rowcount
    print(f"    Created {count} topology links")
    
    # Mark ports with neighbor information as manual topology for UI display
    print(f"  Marking neighbor ports for UI display...")
    cur.execute("""
        UPDATE device_port 
        SET manual_topo = true 
        WHERE remote_id IS NOT NULL AND remote_ip IS NOT NULL AND remote_port IS NOT NULL
    """)
    marked = cur.rowcount
    print(f"    Marked {marked} ports with manual topology")


# ---------------------------------------------------------------------------
def main():
    if not DATA_DIR.exists():
        print(f"Missing {DATA_DIR}/ — run generate_topology.py first.")
        sys.exit(1)

    devices = json.loads((DATA_DIR / "devices.json").read_text())
    ports   = json.loads((DATA_DIR / "ports.json").read_text())
    nodes   = json.loads((DATA_DIR / "nodes.json").read_text())
    ips     = json.loads((DATA_DIR / "ips.json").read_text())

    print(f"Loaded JSON: {len(devices)} devices, {len(ports)} ports, "
          f"{len(nodes)} sightings, {len(ips)} ip bindings.\n")

    print("Connecting to Netdisco's PostgreSQL on localhost:5432 ...")
    conn = connect()
    cur = conn.cursor()

    try:
        truncate_existing(cur)
        seed_devices(cur, devices)
        seed_device_ips(cur)
        seed_ports(cur, ports)
        seed_nodes(cur, nodes)
        seed_node_ips(cur, ips)
        seed_topology(cur)
        conn.commit()
        print("\n  Done. Refresh http://localhost:5000 and try a search.")
        print("  Try searching for: leaf01   or   spine01   or any MAC from nodes.json")
    except Exception as e:
        conn.rollback()
        print(f"\nFAILED, rolling back. Error:\n  {e}")
        print("\nIf the error mentions a missing column or constraint, copy the")
        print("full error and paste it back so we can patch the seeder.")
        sys.exit(1)
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
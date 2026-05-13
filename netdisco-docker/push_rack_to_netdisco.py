"""
push_rack_to_netdisco.py
========================
Push a RackTrack scan into Netdisco's PostgreSQL — analogous to
servicenow/bootstrap_cmdb_full.py but writing to the Netdisco schema.

After every scan finishes, Netdisco gets:
  - one `device` row per scanned switch / firewall / gateway / patch panel
  - one `device_ip` row per device  (needed for the netmap topology view)
  - one `device_port` row per detected port, with neighbor fields populated
    from the topology.json edges so LLDP-style neighbours show up
  - matching rows in `topology` so the Neighbours tab joins cleanly

Idempotent: every write is an INSERT … ON CONFLICT DO UPDATE keyed on the
table's natural PK. Re-running just refreshes the same rows. Other racks
that have been pushed previously are not touched.

Usage:
    python push_rack_to_netdisco.py --rack-id RK-XXXXX

Env (overrides DB_CONFIG defaults):
    NETDISCO_DB_HOST, NETDISCO_DB_PORT, NETDISCO_DB_NAME,
    NETDISCO_DB_USER, NETDISCO_DB_PASS

Requires:  pip install psycopg2-binary
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
SERVICENOW_DIR = ROOT / "servicenow"

# ── Make synth.py importable so we share the same IP/MAC/model logic that
#    topology_generate.py uses. That keeps Netdisco, ServiceNow CMDB and
#    the topology view all consistent.
if str(SERVICENOW_DIR) not in sys.path:
    sys.path.insert(0, str(SERVICENOW_DIR))

try:
    import psycopg2
    from psycopg2.extras import execute_batch
except ImportError:
    print("Missing dependency. Run:  pip install psycopg2-binary")
    sys.exit(1)

from synth import (
    build_inventory, load_override, load_port_detail, merge_port_detail,
    synth_ip, synth_mac,
)


DB_CONFIG = {
    "host":     os.environ.get("NETDISCO_DB_HOST",     "localhost"),
    "port":     int(os.environ.get("NETDISCO_DB_PORT", 5432)),
    "dbname":   os.environ.get("NETDISCO_DB_NAME",     "netdisco"),
    "user":     os.environ.get("NETDISCO_DB_USER",     "netdisco"),
    "password": os.environ.get("NETDISCO_DB_PASS",     "netdisco"),
}

OUTPUTS_BASE = ROOT / "outputs"


# ─────────────────────────────────────────────────────────────────────────
# Connection helpers
# ─────────────────────────────────────────────────────────────────────────

def connect():
    try:
        c = psycopg2.connect(**DB_CONFIG)
        c.autocommit = False
        return c
    except psycopg2.OperationalError as e:
        print(f"ERROR: cannot connect to Netdisco Postgres at "
              f"{DB_CONFIG['host']}:{DB_CONFIG['port']} — {e}")
        sys.exit(2)


# ─────────────────────────────────────────────────────────────────────────
# Per-rack inventory builder. We re-use synth.build_inventory() so the IPs,
# MACs, models, port labels we push here are byte-identical to what the
# topology view and the CMDB script use.
# ─────────────────────────────────────────────────────────────────────────

def build_rack_payload(rack_id: str) -> dict:
    rack_dir = OUTPUTS_BASE / rack_id
    scan_path = rack_dir / "scan_result.json"
    if not scan_path.exists():
        raise FileNotFoundError(f"no scan_result.json at {scan_path}")
    scan = json.loads(scan_path.read_text(encoding="utf-8"))

    override = load_override(rack_id)
    inv = build_inventory(rack_id, scan, override)
    merge_port_detail(inv, load_port_detail(str(rack_dir)))

    switches = inv.get("switches") or {}
    panels   = inv.get("panels") or {}
    server   = inv.get("server")
    agg      = inv.get("agg_core") or {}
    rack_name = inv.get("rack_name") or rack_id

    devices = []   # list of dicts ready for INSERT
    ports   = []   # list of dicts ready for INSERT
    edges   = []   # neighbour edges (dev1,port1,dev2,port2) for topology

    # ── Switches and panels (in-rack) ───────────────────────────────────
    for name, host in {**switches, **panels}.items():
        kind = "Switch" if name in switches else "Patch Panel"
        ip = host.get("mgmt_ip") or host.get("ip_address")
        # Patch panels almost never have a real mgmt IP — synthesise one so
        # Netdisco still gets a row per panel. Same for any switch missing
        # an IP (e.g. unidentified). Placeholder "0.0.0.0" is rejected too.
        if not ip or ip in ("0.0.0.0", "0", "unknown"):
            try:
                u = int(name.split("-U")[1])
            except Exception:
                u = 0
            ip = synth_ip(rack_id, name, u)
            host.setdefault("mac_address", synth_mac(rack_id, name))
        device = _build_device(rack_id, rack_name, name, kind, host, ip_override=ip)
        devices.append(device)
        # Build the port list. Switch port labels come from port_prefix
        # (e.g. "Gi1/0/1"); patch-panel ports use "Port1"…"Port24".
        if kind == "Switch":
            prefix = host.get("port_prefix") or "p"
            port_count = int(host.get("ports") or 0) + int(host.get("sfp_ports") or 0)
            label_for = lambda i: f"{prefix}{i}"
        else:
            port_count = int(host.get("ports") or 0)
            label_for = lambda i: f"Port{i}"
        det = host.get("_port_detail") or {}
        connected_idx = set(det.get("connected_indices") or [])
        # If we have no per-port detection (e.g. the override defines port
        # count but the scan didn't run port detection on this device),
        # treat the first N ports as connected so the UI has something
        # plausible to show.
        if not connected_idx and host.get("ports"):
            from_count = min(port_count, _scan_connected_count(scan, name))
            connected_idx = set(range(1, from_count + 1)) if from_count else set()
        for i in range(1, port_count + 1):
            ports.append({
                "device_ip": ip,
                "port":      label_for(i),
                "name":      label_for(i),
                "mac":       _port_mac(rack_id, name, i),
                "up":        "up" if i in connected_idx else "down",
                "up_admin":  "up",
                "speed":     "1000" if kind == "Switch" else None,
                "vlan":      "1",
                "descr":     f"{name} port {i}",
                "remote_id":   None,   # filled in later from edges
                "remote_ip":   None,
                "remote_port": None,
            })

    # ── Server (one device, NICs as ports) ───────────────────────────────
    if server and server.get("name"):
        nics = server.get("nics") or []
        srv_ip = (nics[0].get("ip") if nics else None) or synth_ip(rack_id, server["name"], 1)
        srv_meta = server.get("meta") or {}
        # Fold the meta into a host-shaped dict so _build_device can read it.
        srv_host = {
            "mgmt_ip":       srv_ip,
            "mac":           (nics[0].get("mac") if nics else None) or synth_mac(rack_id, server["name"]),
            "model_number":  srv_meta.get("model_number") or "Server",
            "serial_number": srv_meta.get("serial_number"),
            "os":            srv_meta.get("os"),
            "ports":         len(nics),
            "sfp_ports":     0,
        }
        srv_device = _build_device(rack_id, rack_name, server["name"], "Server", srv_host, ip_override=srv_ip)
        srv_device["layers"] = "00000010"   # L2 host
        devices.append(srv_device)
        for i, nic in enumerate(nics, 1):
            label = nic.get("alias") or f"eth{i-1}"
            ports.append({
                "device_ip":   srv_ip,
                "port":        label,
                "name":        label,
                "mac":         nic.get("mac") or _port_mac(rack_id, server["name"], i),
                "up":          "up",
                "up_admin":    "up",
                "speed":       "1000",
                "vlan":        "1",
                "descr":       f"{server['name']} {label}",
                "remote_id":   None,
                "remote_ip":   None,
                "remote_port": None,
            })

    # ── AGG-CORE (out-of-rack uplink termination) ────────────────────────
    if agg and agg.get("name") and agg.get("mgmt_ip"):
        agg_device = _build_device(rack_id, rack_name, agg["name"], "Switch", agg)
        # _build_device already produces a clean "Vendor Model … [racktrack:RK-...]"
        # description; just append the role suffix so this stands out from
        # the in-rack switches.
        agg_device["description"] = agg_device["description"].replace(
            f"[racktrack:{rack_id}]",
            f"(aggregation/uplink) [racktrack:{rack_id}]",
        )
        devices.append(agg_device)
        agg_total = int(agg.get("ports") or 0) + int(agg.get("sfp_ports") or 0)
        agg_prefix = agg.get("port_prefix") or "Up"
        for i in range(1, agg_total + 1):
            label = f"{agg_prefix}{i}"
            ports.append({
                "device_ip": agg["mgmt_ip"],
                "port":      label,
                "name":      label,
                "mac":       _port_mac(rack_id, agg["name"], i),
                "up":        "up",
                "up_admin":  "up",
                "speed":     "10000",
                "vlan":      "1",
                "descr":     f"{agg['name']} uplink port {i}",
                "remote_id":   None,
                "remote_ip":   None,
                "remote_port": None,
            })

    # ── Wire up the neighbour fields from topology.json edges ───────────
    topo_path = rack_dir / "topology.json"
    if topo_path.exists():
        try:
            topo = json.loads(topo_path.read_text(encoding="utf-8"))
        except Exception:
            topo = None
    else:
        topo = None

    if topo and isinstance(topo.get("edges"), list):
        # Build a lookup: device_name → ip, port_name (canonical) → label.
        name_to_ip = {}
        for d in devices:
            name_to_ip[d["_logical_name"]] = d["ip"]
        # Each edge: src.device, src.port, dst.device, dst.port
        # The port string in topology.json is "<dev>:<label>" — strip the prefix.
        port_index = { (p["device_ip"], p["port"]): p for p in ports }
        for e in topo["edges"]:
            src_dev = e.get("src", {}).get("device")
            dst_dev = e.get("dst", {}).get("device")
            src_port_raw = e.get("src", {}).get("port", "") or ""
            dst_port_raw = e.get("dst", {}).get("port", "") or ""
            src_port = src_port_raw.split(":", 1)[1] if ":" in src_port_raw else src_port_raw
            dst_port = dst_port_raw.split(":", 1)[1] if ":" in dst_port_raw else dst_port_raw
            src_ip = name_to_ip.get(src_dev)
            dst_ip = name_to_ip.get(dst_dev)
            if not src_ip or not dst_ip:
                continue
            # Pull MACs to use as remote_id (chassis MAC).
            src_dev_mac = next((d["mac"] for d in devices if d["ip"] == src_ip), None)
            dst_dev_mac = next((d["mac"] for d in devices if d["ip"] == dst_ip), None)
            # Annotate the src port with the dst end as its neighbour.
            src_p = port_index.get((src_ip, src_port))
            if src_p:
                src_p["remote_id"]   = dst_dev_mac
                src_p["remote_ip"]   = dst_ip
                src_p["remote_port"] = dst_port
            # And the reverse direction so neighbour appears on the other end too.
            dst_p = port_index.get((dst_ip, dst_port))
            if dst_p:
                dst_p["remote_id"]   = src_dev_mac
                dst_p["remote_ip"]   = src_ip
                dst_p["remote_port"] = src_port
            edges.append((src_ip, src_port, dst_ip, dst_port))

    return {
        "rack_id":   rack_id,
        "rack_name": rack_name,
        "devices":   devices,
        "ports":     ports,
        "edges":     edges,
    }


def _scan_connected_count(scan: dict, name: str) -> int:
    """Read `connected_ports` count from the scan_result.json for the
    device whose CMDB name is `name` (SW-Uxx / PP-Uxx / SRV-Uxx)."""
    try:
        u = int(name.split("-U")[1])
    except Exception:
        return 0
    for d in scan.get("devices") or []:
        pos = d.get("position") or ""
        if pos.startswith(f"U{u:02d}"):
            cp = d.get("connected_ports")
            if isinstance(cp, int):
                return cp
            if isinstance(cp, list):
                return len(cp)
    return 0


def _build_device(rack_id: str, rack_name: str, name: str, kind: str, host: dict, ip_override: str | None = None) -> dict:
    ip = ip_override or host.get("mgmt_ip") or host.get("ip_address")
    mac = host.get("mac") or host.get("mac_address") or synth_mac(rack_id, name)
    model = host.get("model_number") or host.get("model") or "Unknown"
    serial = host.get("serial_number") or host.get("serial") or ""
    vendor = _vendor_from_model(model)
    os_name, os_ver = _os_split(host.get("os") or host.get("os_version") or "")
    port_count = int(host.get("ports") or 0) + int(host.get("sfp_ports") or 0)
    uptime_ticks = 30 * 8_640_000        # arbitrary 30-day uptime placeholder
    layers = "00000110" if kind == "Switch" else "00000010"  # L3/L2 vs L2 only
    desc_parts = [vendor, model]
    if os_name and os_name != "Unknown":
        desc_parts.append(f"running {os_name}")
        if os_ver:
            desc_parts.append(os_ver)
    # Tag stays at the END so it doesn't dominate Netdisco's UI but is still
    # easy to grep on for cleanup — `description LIKE '%[racktrack:%'`.
    desc_parts.append(f"[racktrack:{rack_id}]")
    return {
        "ip":           ip,
        "dns":          name,                          # bare device name, e.g. "SW-U10"
        "name":         name,
        "mac":          mac,
        "serial":       serial,
        "vendor":       vendor,
        "model":        model,
        "os":           os_name,
        "os_ver":       os_ver,
        "uptime":       uptime_ticks,
        "location":     rack_name,
        "layers":       layers,
        "description":  " ".join(desc_parts),
        "chassis_id":   mac,
        "num_ports":    port_count,
        # private — used inside this module only, stripped before INSERT.
        "_logical_name": name,
    }


def _vendor_from_model(model: str) -> str:
    m = (model or "").lower()
    if "catalyst" in m or "cisco" in m:        return "Cisco"
    if "juniper" in m or "qfx" in m:           return "Juniper"
    if "arista" in m or "dcs-" in m:           return "Arista"
    if "tp-link" in m or "tl-sg" in m:         return "TP-Link"
    if "d-link" in m or "dgs-" in m:           return "D-Link"
    if "panduit" in m:                         return "Panduit"
    if "dell" in m or "poweredge" in m:        return "Dell"
    if "hpe" in m or "aruba" in m:             return "HPE"
    return "Generic"


def _os_split(os_field: str) -> tuple[str, str]:
    s = (os_field or "").strip()
    if not s:
        return ("Unknown", "")
    parts = s.split(maxsplit=1)
    return (parts[0], parts[1] if len(parts) > 1 else "")


def _port_mac(rack_id: str, dev_name: str, port_idx: int) -> str:
    import hashlib
    h = hashlib.sha256(f"{rack_id}|{dev_name}|port|{port_idx}".encode()).hexdigest()[:12]
    return ":".join(h[i:i+2].upper() for i in range(0, 12, 2))


# ─────────────────────────────────────────────────────────────────────────
# Database upserts — natural PKs let us re-run safely.
# ─────────────────────────────────────────────────────────────────────────

DEVICE_UPSERT = """
INSERT INTO device
    (ip, dns, name, mac, serial, vendor, model, os, os_ver, uptime,
     location, layers, description, chassis_id, num_ports,
     last_discover, last_macsuck, last_arpnip, creation)
VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
        %s, %s, %s, %s, %s,
        NOW(), NOW(), NOW(), NOW())
ON CONFLICT (ip) DO UPDATE SET
    dns         = EXCLUDED.dns,
    name        = EXCLUDED.name,
    mac         = EXCLUDED.mac,
    serial      = EXCLUDED.serial,
    vendor      = EXCLUDED.vendor,
    model       = EXCLUDED.model,
    os          = EXCLUDED.os,
    os_ver      = EXCLUDED.os_ver,
    uptime      = EXCLUDED.uptime,
    location    = EXCLUDED.location,
    layers      = EXCLUDED.layers,
    description = EXCLUDED.description,
    chassis_id  = EXCLUDED.chassis_id,
    num_ports   = EXCLUDED.num_ports,
    last_discover = NOW(),
    last_macsuck  = NOW(),
    last_arpnip   = NOW();
"""

DEVICE_IP_UPSERT = """
INSERT INTO device_ip (ip, alias, dns, creation)
VALUES (%s, %s, %s, NOW())
ON CONFLICT DO NOTHING;
"""

PORT_UPSERT = """
INSERT INTO device_port
    (ip, port, name, descr, mac, up, up_admin, speed, vlan,
     remote_id, remote_ip, remote_port, type, creation)
VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s,
        %s, %s, %s, %s, NOW())
ON CONFLICT (ip, port) DO UPDATE SET
    name        = EXCLUDED.name,
    descr       = EXCLUDED.descr,
    mac         = EXCLUDED.mac,
    up          = EXCLUDED.up,
    up_admin    = EXCLUDED.up_admin,
    speed       = EXCLUDED.speed,
    vlan        = EXCLUDED.vlan,
    remote_id   = EXCLUDED.remote_id,
    remote_ip   = EXCLUDED.remote_ip,
    remote_port = EXCLUDED.remote_port;
"""

TOPOLOGY_UPSERT = """
INSERT INTO topology (dev1, port1, dev2, port2)
VALUES (%s, %s, %s, %s)
ON CONFLICT DO NOTHING;
"""


def push(payload: dict) -> dict:
    devices = payload["devices"]
    ports   = payload["ports"]
    edges   = payload["edges"]

    conn = connect()
    cur  = conn.cursor()

    try:
        # 1. devices
        device_rows = [
            (d["ip"], d["dns"], d["name"], d["mac"], d["serial"], d["vendor"],
             d["model"], d["os"], d["os_ver"], d["uptime"], d["location"],
             d["layers"], d["description"], d["chassis_id"], d["num_ports"])
            for d in devices
        ]
        execute_batch(cur, DEVICE_UPSERT, device_rows, page_size=100)

        # 2. device_ip aliases (so the netmap can resolve neighbours)
        device_ip_rows = [(d["ip"], d["ip"], d["dns"]) for d in devices]
        execute_batch(cur, DEVICE_IP_UPSERT, device_ip_rows, page_size=200)

        # 3. ports
        port_rows = [
            (p["device_ip"], p["port"], p["name"], p["descr"], p["mac"],
             p["up"], p["up_admin"], p["speed"], p["vlan"],
             p["remote_id"], p["remote_ip"], p["remote_port"], "ethernetCsmacd")
            for p in ports
        ]
        execute_batch(cur, PORT_UPSERT, port_rows, page_size=200)

        # 4. topology — straight insert from the edges we annotated above.
        execute_batch(cur, TOPOLOGY_UPSERT, edges, page_size=200)

        conn.commit()
        return {
            "ok": True,
            "rack_id":  payload["rack_id"],
            "devices":  len(device_rows),
            "ports":    len(port_rows),
            "edges":    len(edges),
        }
    except Exception as e:
        conn.rollback()
        return {"ok": False, "rack_id": payload["rack_id"], "error": str(e)}
    finally:
        cur.close()
        conn.close()


# ─────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────

def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--rack-id", required=True, help="Rack ID, e.g. RK-B9E33E5A")
    p.add_argument("--json", action="store_true",
                   help="Emit a single-line JSON status (used by the server endpoint).")
    args = p.parse_args()

    try:
        payload = build_rack_payload(args.rack_id)
    except Exception as e:
        msg = {"ok": False, "rack_id": args.rack_id, "error": str(e)}
        print(json.dumps(msg) if args.json else f"ERROR: {e}")
        return 1

    result = push(payload)
    if args.json:
        print(json.dumps(result))
        return 0 if result.get("ok") else 1

    if result.get("ok"):
        print(f"[netdisco] {result['rack_id']} pushed: "
              f"{result['devices']} devices, {result['ports']} ports, {result['edges']} edges")
        return 0
    else:
        print(f"[netdisco] FAILED for {result['rack_id']}: {result.get('error')}")
        return 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)

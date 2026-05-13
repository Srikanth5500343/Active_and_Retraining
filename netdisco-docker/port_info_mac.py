"""
Netdisco MAC Tracer
====================
Given a MAC address, identify it on the network.

The script answers two questions for any MAC you give it:

  CASE A. Is this MAC the address of a switch port itself?
          -> Show the device that owns the port: device name, IP, port name.

  CASE B. Has this MAC been seen as a host on any switch port?
          -> Show the switch + port where it was learned.
          -> If that port has an LLDP/CDP neighbor, show the device on the
             other end (its name, IP/id, and port). If there is no neighbor,
             the other end is an end-host (laptop, server, IoT) so the only
             identifier we have is the MAC itself.

Usage:
    python netdisco_mac.py <mac>
    python netdisco_mac.py                # will prompt for a MAC
"""

import requests
import sys
from concurrent.futures import ThreadPoolExecutor

# BASE_URL = "https://netdisco2-demo.herokuapp.com"
# USERNAME = "guest"
# PASSWORD = "guest"

BASE_URL = "http://localhost:5000"
USERNAME = "admin"
PASSWORD = "admin"

# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------
def login():
    try:
        r = requests.post(
            f"{BASE_URL}/login",
            json={"username": USERNAME, "password": PASSWORD},
            headers={"Accept": "application/json"},
            timeout=15,
        )
        if r.status_code == 200:
            return r.json().get("api_key")
    except requests.exceptions.RequestException as e:
        print(f"Login error: {e}")
    return None


def api_headers(api_key):
    h = {"Accept": "application/json"}
    if api_key:
        h["Authorization"] = f"apikey {api_key}"
    return h


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _norm(mac):
    return (mac or "").lower().replace("-", ":").strip()


def list_all_devices(headers):
    """Return every device in the inventory."""
    r = requests.get(
        f"{BASE_URL}/api/v1/search/device",
        headers=headers,
        params={"q": "%"},
        timeout=30,
    )
    if r.status_code != 200:
        return []
    body = r.json() or []
    return [d for d in body if isinstance(d, dict)]


def list_device_ports(headers, device_ip):
    """Return every port on a device (each port carries its own MAC + neighbor info)."""
    r = requests.get(
        f"{BASE_URL}/api/v1/object/device/{device_ip}/ports",
        headers=headers,
        timeout=30,
    )
    if r.status_code != 200:
        return []
    body = r.json() or []
    return [p for p in body if isinstance(p, dict)]


def build_port_cache(headers, devices, max_workers=12):
    """
    Fetch every device's port list in parallel and return a dict:
        { device_ip: [port_dict, port_dict, ...] }
    This is the single most expensive part of the script; doing it once
    up-front lets both CASE A (finding port owners) and CASE B (reading
    LLDP neighbor fields) run as in-memory lookups afterwards.
    """
    ips = [d.get("ip") for d in devices if d.get("ip")]
    cache = {}
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        for ip, ports in zip(ips, pool.map(lambda i: list_device_ports(headers, i), ips)):
            cache[ip] = ports
    return cache


def neighbor_from_port(port):
    """Pull (remote_device_id, remote_port) out of a port record."""
    if not isinstance(port, dict):
        return None, None
    remote_dev = (
        port.get("remote_id")
        or port.get("remote_ip")
        or port.get("remote_dns")
        or port.get("neighbor")
        or port.get("neighbor_ip")
    )
    remote_port = (
        port.get("remote_port")
        or port.get("neighbor_port")
        or port.get("remote_interface")
    )
    return remote_dev, remote_port


def resolve_device(devices, identifier):
    """
    Look an identifier (chassis MAC, IP, DNS, serial, etc.) up against the
    device inventory and return the matching device record. The web UI does
    this cross-reference to turn a raw LLDP chassis-id like a0:00:00:00:00:14
    into a friendly name like leaf04.
    """
    if not identifier:
        return None
    ident = _norm(identifier)
    for d in devices:
        for field in ("ip", "dns", "name", "serial", "id", "mac", "snmp_engineid"):
            v = d.get(field)
            if v and _norm(v) == ident:
                return d
        # 'serial' on a Cumulus / Linux switch is often the chassis MAC, but
        # may be stored without colons; compare hex-only too.
        for field in ("serial", "id"):
            v = d.get(field)
            if v and _norm(v).replace(":", "") == ident.replace(":", ""):
                return d
    return None


def describe_device(d, fallback):
    """Return (name, ip) for a resolved device, or sensible fallbacks."""
    if not d:
        return fallback or "-", "-"
    name = d.get("dns") or d.get("name") or fallback or "-"
    ip = d.get("ip") or "-"
    return name, ip


# ---------------------------------------------------------------------------
# CASE A: is this MAC the MAC of a switch port itself?
# ---------------------------------------------------------------------------
def _is_partial(query):
    """A MAC the user types is 'partial' if it doesn't have all 6 octets."""
    octets = [o for o in _norm(query).split(":") if o]
    return len(octets) < 6


def find_port_owners(mac, devices, port_cache):
    """
    Look in the cached port lists for ports whose own MAC matches <mac>.
    If the user typed a partial MAC (e.g. '08:00:27' for a vendor OUI), match
    by prefix; otherwise require an exact match.
    Pure in-memory; no HTTP calls.
    """
    target = _norm(mac)
    partial = _is_partial(mac)
    owners = []
    for d in devices:
        ip = d.get("ip")
        if not ip:
            continue
        for p in port_cache.get(ip, []):
            pm = _norm(p.get("mac"))
            if not pm:
                continue
            if (partial and pm.startswith(target)) or (not partial and pm == target):
                owners.append({"device": d, "port": p})
    return owners


# ---------------------------------------------------------------------------
# CASE B: has this MAC been seen as a host on any switch port?
# ---------------------------------------------------------------------------
def find_node_data(headers, mac):
    """Query /search/node and return {'nodes': [...], 'ips': [...]}."""
    params = {
        "q": mac,
        "archive_node": "true",
        "partial_node": "true",
        "stamps_node": "true",
        "archive": "true",
        "partial": "true",
        "stamps": "true",
    }
    r = requests.get(
        f"{BASE_URL}/api/v1/search/node",
        headers=headers,
        params=params,
        timeout=30,
    )
    if r.status_code != 200:
        return {"nodes": [], "ips": []}

    body = r.json() or {}
    if isinstance(body, list):
        body = {"nodes": [n for n in body if isinstance(n, dict)], "ips": []}

    nodes = body.get("nodes") or body.get("results") or []
    ips = body.get("ips") or []
    return {
        "nodes": [n for n in nodes if isinstance(n, dict)],
        "ips": [n for n in ips if isinstance(n, dict)],
    }


def get_port_from_cache(port_cache, device_ip, port_name):
    """Read a port record from the cache (no HTTP)."""
    for p in port_cache.get(device_ip, []):
        if p.get("port") == port_name or p.get("name") == port_name:
            return p
    return None


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------
def _fmt_time(value):
    return str(value or "-")[:19].replace("T", " ")


def print_case_a(owners, devices):
    """Print: this MAC IS a port on the following device(s)."""
    print()
    print("  >> CASE A: this MAC is a switch port's own address.")
    print()
    for o in owners:
        d = o["device"]
        p = o["port"]
        local_name = d.get("dns") or d.get("name") or "-"
        local_ip = d.get("ip") or "-"
        port_name = p.get("port") or p.get("name") or "-"
        port_mac = p.get("mac") or "-"

        print(f"    Device name : {local_name}")
        print(f"    Device IP   : {local_ip}")
        print(f"    Device id   : {d.get('serial') or d.get('id') or '-'}")
        print(f"    Port        : {port_name}")
        print(f"    Port MAC    : {port_mac}")
        print(f"    Port descr  : {p.get('name') or p.get('descr') or '-'}")
        print(f"    Port status : up={p.get('up') or '-'}  admin={p.get('up_admin') or '-'}")

        remote_dev, remote_port = neighbor_from_port(p)
        if remote_dev or remote_port:
            resolved = resolve_device(devices, remote_dev)
            remote_name, remote_ip = describe_device(resolved, remote_dev)
            print(f"    Wired to    : {remote_name}  ({remote_ip})  port {remote_port or '-'}")
            print(f"    Neighbor id : {remote_dev or '-'}")
            print()
            print(f"    Summary: {port_name} ({port_mac}) of {local_name}")
            print(f"             is connected to {remote_name} port {remote_port or '-'}")
        else:
            print(f"    Wired to    : (no LLDP/CDP neighbor on this port)")
            print()
            print(f"    Summary: {port_name} ({port_mac}) of {local_name}")
            print(f"             has no neighbor reported (edge / down / disabled)")
        print("    " + "-" * 70)


def print_case_b(sightings, devices, port_cache):
    """Print: this MAC was learned as a host on the following switch ports."""
    print()
    print("  >> CASE B: this MAC was learned as a host on the following port(s).")
    print()

    seen = {}
    for s in sightings:
        switch = s.get("switch") or s.get("device") or s.get("dns") or "?"
        port = s.get("port") or "?"
        key = (switch, port)
        if key not in seen or (s.get("time_last") or "") > (seen[key].get("time_last") or ""):
            seen[key] = s

    for (switch, port), record in seen.items():
        device_ip = switch
        local_resolved = resolve_device(devices, device_ip)
        local_name, _ = describe_device(local_resolved,
                                        record.get("dns") or record.get("name") or switch)
        active = record.get("active")
        active_str = "active" if active in (True, 1, "1", "t", "true") else "archived"

        print(f"    Learned on switch : {local_name}  ({device_ip})")
        print(f"    Switch port       : {port}")
        print(f"    Status            : {active_str}")
        print(f"    First / Last seen : {_fmt_time(record.get('time_first'))}  ->  {_fmt_time(record.get('time_last'))}")

        port_info = get_port_from_cache(port_cache, device_ip, port)
        remote_dev, remote_port = neighbor_from_port(port_info)
        if remote_dev or remote_port:
            resolved = resolve_device(devices, remote_dev)
            remote_name, remote_ip = describe_device(resolved, remote_dev)
            print(f"    Other end         : {remote_name}  ({remote_ip})  port {remote_port or '-'}")
            print(f"    Neighbor id       : {remote_dev or '-'}")
            print()
            print(f"    Summary: MAC seen on {local_name} port {port}")
            print(f"             -> connected to {remote_name} port {remote_port or '-'}")
        else:
            print(f"    Other end         : end-host (no LLDP/CDP neighbor on this port)")
            print()
            print(f"    Summary: MAC seen on {local_name} port {port}  ->  end-host on the wire")
        print("    " + "-" * 70)


def print_ips(ips):
    if not ips:
        return
    print()
    print(f"  >> IP addresses ever bound to this MAC ({len(ips)}):")
    print()
    for ipr in ips:
        ip = ipr.get("ip") or "-"
        first = _fmt_time(ipr.get("time_first"))
        last = _fmt_time(ipr.get("time_last"))
        active = ipr.get("active")
        status = "active" if active in (True, 1, "1", "t", "true") else "archived"
        print(f"    {ip:<42} {status:<10} first {first}   last {last}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    mac = (sys.argv[1] if len(sys.argv) > 1 else input("Enter MAC address: ")).strip()
    if not mac:
        print("No MAC address given.")
        sys.exit(1)

    partial = _is_partial(mac)
    if partial:
        print(f"\nPartial MAC '{mac}' — matching every MAC that starts with it.")
    print(f"Looking up MAC {mac} on {BASE_URL} ...")
    headers = api_headers(login())

    devices = list_all_devices(headers)
    print(f"  Inventory: {len(devices)} device(s) to scan.")

    # One parallel sweep to fetch every device's port list, then everything
    # else (port-owner lookup, neighbor lookup) is in-memory.
    port_cache = build_port_cache(headers, devices)

    owners = find_port_owners(mac, devices, port_cache)
    node_data = find_node_data(headers, mac)
    sightings = node_data["nodes"]
    ips = node_data["ips"]

    if not (owners or sightings or ips):
        print(f"\n  MAC {mac} was not found anywhere in the database.")
        return

    print()
    print("=" * 78)
    label = f"Report for MAC: {mac}"
    if partial:
        label += "  (partial / prefix match)"
    print(f"  {label}")
    print("=" * 78)

    if owners:
        if partial:
            print()
            print(f"  >> CASE A: {len(owners)} switch port(s) match this MAC prefix.")
        print_case_a(owners, devices)
    else:
        print()
        print("  >> CASE A: this MAC is NOT a switch port's own address (no device owns it).")

    if sightings:
        print_case_b(sightings, devices, port_cache)
    else:
        print()
        print("  >> CASE B: this MAC has NOT been learned as a host on any switch port.")

    print_ips(ips)
    print("=" * 78)
    print()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nInterrupted.")
        sys.exit(0)

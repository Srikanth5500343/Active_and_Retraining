"""
Netdisco — Device Port Report
==============================
Give it a device IP, get a clean table of every port on that device:
  - Port name + status (up / down)
  - Port MAC
  - What's connected on the other end (LLDP/CDP neighbor, resolved to a
    friendly device name)
  - How many host MACs the port is currently learning

Usage:
    python info_ip.py <device_ip>
    python info_ip.py                # will prompt
"""

import requests
import sys

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
# Tiny helpers
# ---------------------------------------------------------------------------
def _norm(s):
    return (s or "").lower().replace("-", ":").strip()


def _get(headers, path, params=None):
    r = requests.get(f"{BASE_URL}{path}", headers=headers, params=params, timeout=30)
    if r.status_code != 200:
        return None
    return r.json()


# ---------------------------------------------------------------------------
# API calls
# ---------------------------------------------------------------------------
def get_device(headers, device_ip):
    body = _get(headers, f"/api/v1/object/device/{device_ip}")
    if isinstance(body, dict):
        return body
    return None


def get_ports(headers, device_ip):
    body = _get(headers, f"/api/v1/object/device/{device_ip}/ports") or []
    return [p for p in body if isinstance(p, dict)]


def get_nodes(headers, device_ip):
    """Host MACs currently learned on this device (per-port count)."""
    body = _get(headers, f"/api/v1/object/device/{device_ip}/nodes") or []
    return [n for n in body if isinstance(n, dict)]


def list_inventory(headers):
    """Used to resolve LLDP chassis-ids to friendly names."""
    body = _get(headers, "/api/v1/search/device", params={"q": "%"}) or []
    return [d for d in body if isinstance(d, dict)]


# ---------------------------------------------------------------------------
# Logic
# ---------------------------------------------------------------------------
def resolve_device(devices, identifier):
    """Match an LLDP chassis-id / IP / serial against the device inventory."""
    if not identifier:
        return None
    ident = _norm(identifier)
    ident_nocolons = ident.replace(":", "")
    for d in devices:
        for field in ("ip", "dns", "name", "serial", "id", "mac"):
            v = d.get(field)
            if not v:
                continue
            n = _norm(v)
            if n == ident or n.replace(":", "") == ident_nocolons:
                return d
    return None


def neighbor_info(port, devices):
    """
    Return a dict describing the LLDP/CDP neighbor on this port,
    or None if there is no neighbor.
    """
    remote_id = (
        port.get("remote_id") or port.get("remote_ip")
        or port.get("remote_dns") or port.get("neighbor")
        or port.get("neighbor_ip")
    )
    remote_port = (
        port.get("remote_port") or port.get("neighbor_port")
        or port.get("remote_interface")
    )
    if not (remote_id or remote_port):
        return None

    resolved = resolve_device(devices, remote_id)
    if resolved:
        name = resolved.get("dns") or resolved.get("name") or remote_id or "?"
        ip = resolved.get("ip") or "-"
    else:
        name = remote_id or "?"
        ip = "-"

    return {
        "local_port": port.get("port") or port.get("name") or "?",
        "local_mac": port.get("mac") or "-",
        "name": name,
        "ip": ip,
        "remote_port": remote_port or "-",
        "chassis_id": remote_id or "-",
    }


def neighbor_label(n):
    """Pretty 'name (ip)' label, falling back gracefully when fields are missing."""
    if n["name"] and n["name"] != "-" and n["ip"] != "-":
        return f"{n['name']} ({n['ip']})"
    if n["name"] and n["name"] != "-":
        return n["name"]
    return n["chassis_id"]


def neighbor_name(port, devices):
    """Compact 'leaf04 (192.168.0.14) - swp51' string, or None."""
    info = neighbor_info(port, devices)
    if not info:
        return None
    ip_part = f" ({info['ip']})" if info['ip'] != "-" else ""
    return f"{info['name']}{ip_part} - {info['remote_port']}"


def host_count_per_port(nodes):
    """Build {port_name: number_of_active_host_macs}."""
    counts = {}
    for n in nodes:
        if n.get("active") in (True, 1, "1", "t", "true"):
            p = n.get("port")
            if p:
                counts[p] = counts.get(p, 0) + 1
    return counts


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------
def print_table(rows, headers_row):
    """Simple aligned table printer."""
    if not rows:
        return
    widths = [len(h) for h in headers_row]
    for row in rows:
        for i, cell in enumerate(row):
            widths[i] = max(widths[i], len(str(cell)))
    fmt = "  ".join(f"{{:<{w}}}" for w in widths)
    print(fmt.format(*headers_row))
    print("  ".join("-" * w for w in widths))
    for row in rows:
        print(fmt.format(*[str(c) for c in row]))


def status_str(p):
    up = (p.get("up") or "").lower()
    admin = (p.get("up_admin") or "").lower()
    if up == "up":
        return "up"
    if admin and admin != "up":
        return f"down ({admin})"
    return "down"


def main():
    arg = sys.argv[1].strip() if len(sys.argv) > 1 else ""
    if not arg:
        arg = input("Enter device IP: ").strip()
    if not arg:
        print("No IP given.")
        sys.exit(1)

    print(f"\nFetching info for {arg} from {BASE_URL} ...\n")
    headers = api_headers(login())

    device = get_device(headers, arg)
    if not device:
        print(f"  Device {arg} not found.")
        return

    ports = get_ports(headers, arg)
    nodes = get_nodes(headers, arg)
    inventory = list_inventory(headers)
    host_counts = host_count_per_port(nodes)

    name = device.get("dns") or device.get("name") or arg
    print("=" * 78)
    print(f"  Device : {name}   ({device.get('ip') or arg})")
    print(f"  Vendor : {device.get('vendor') or '-'}    Model: {device.get('model') or '-'}")
    print(f"  OS     : {device.get('os') or '-'}    Uptime: {device.get('uptime') or '-'}")
    print(f"  Ports  : {len(ports)} total")
    print("=" * 78)
    print()

    if not ports:
        print("  No ports found.")
        return

    rows = []
    for p in ports:
        port_name = p.get("port") or p.get("name") or "?"
        port_mac = p.get("mac") or "-"
        vlan = p.get("native") or p.get("vlan") or "-"
        connected = neighbor_name(p, inventory)
        if connected is None:
            hc = host_counts.get(port_name, 0)
            connected = f"{hc} host MAC(s)" if hc else "-"
        rows.append([
            port_name,
            status_str(p),
            port_mac,
            str(vlan),
            connected,
        ])

    # Sort: up ports first, then by port name
    rows.sort(key=lambda r: (0 if r[1] == "up" else 1, r[0]))

    print_table(rows, ["Port", "Status", "Port MAC", "VLAN", "Connected to"])
    print()

    # ---- Dedicated neighbours section ---------------------------------
    neighbours = [n for n in (neighbor_info(p, inventory) for p in ports) if n]
    neighbours.sort(key=lambda n: n["local_port"])

    print()
    print(f"  Neighbours (LLDP/CDP)  —  {len(neighbours)} link(s)")
    print("  " + "-" * 60)
    print()

    if not neighbours:
        print("  No LLDP/CDP neighbours discovered on this device.")
        print()
        return

    nb_rows = [
        [
            n["local_port"],
            n["local_mac"],
            "->",
            neighbor_label(n),
            n["remote_port"],
        ]
        for n in neighbours
    ]
    print_table(
        nb_rows,
        ["Local Port", "Local MAC", "", "Connected To", "Remote Port"],
    )
    print()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nInterrupted.")
        sys.exit(0)

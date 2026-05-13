"""
Netdisco API Explorer — Beginner Edition
==========================================
This script connects to the public Netdisco demo and pulls the same
information you saw in the web UI:
  1. List of all network devices (switches/routers)
  2. Details of one specific device
  3. Search for a MAC address (find which port it's on)
  4. Save everything as a CSV inventory

Run it with:   python netdisco_explorer.py
Requires:      pip install requests
"""

import requests
import csv
import json
import sys

# ----------------------------------------------------------------------
# CONFIGURATION
# ----------------------------------------------------------------------
BASE_URL = "https://netdisco2-demo.herokuapp.com"
USERNAME = "guest"
PASSWORD = "guest"

# A MAC we know exists in the demo (you saw this earlier)
TEST_MAC = "08:00:27:6f:f8:83"


# ----------------------------------------------------------------------
# AUTHENTICATION
# ----------------------------------------------------------------------
def login():
    """
    Log into Netdisco and get an API key.
    Returns the api_key string, or None if login failed.
    """
    print(f"[1/5] Logging in as '{USERNAME}'...")

    url = f"{BASE_URL}/login"
    try:
        # Netdisco supports two auth styles. We try JSON first.
        response = requests.post(
            url,
            json={"username": USERNAME, "password": PASSWORD},
            headers={"Accept": "application/json"},
            timeout=15,
        )

        if response.status_code == 200:
            data = response.json()
            api_key = data.get("api_key")
            if api_key:
                print(f"      Success. API key starts with: {api_key[:8]}...")
                return api_key

        # Fallback: form-based login (some Netdisco versions use this)
        response = requests.post(
            url,
            data={"username": USERNAME, "password": PASSWORD},
            headers={"Accept": "application/json"},
            timeout=15,
        )
        if response.status_code == 200:
            data = response.json()
            api_key = data.get("api_key")
            if api_key:
                print(f"      Success (form auth). Key: {api_key[:8]}...")
                return api_key

        print(f"      Login response: HTTP {response.status_code}")
        print(f"      Body: {response.text[:200]}")
        return None

    except requests.exceptions.RequestException as e:
        print(f"      ERROR: {e}")
        return None


def make_headers(api_key):
    """Build the headers used for every API call."""
    headers = {"Accept": "application/json"}
    if api_key:
        # Netdisco accepts the API key in this header
        headers["Authorization"] = f"apikey {api_key}"
    return headers


# ----------------------------------------------------------------------
# API CALLS — each one mirrors something you saw in the web UI
# ----------------------------------------------------------------------
def list_all_devices(headers):
    """Equivalent to clicking 'Inventory' in the web UI."""
    print("\n[2/5] Fetching all network devices (the Inventory page)...")
    url = f"{BASE_URL}/api/v1/search/device"

    try:
        # The endpoint requires a query; '%' is a SQL ILIKE wildcard that matches all rows.
        r = requests.get(url, headers=headers, params={"q": "%"}, timeout=30)
        if r.status_code != 200:
            print(f"      Failed: HTTP {r.status_code}")
            print(f"      Body: {r.text[:200]}")
            return []

        devices = r.json()
        print(f"      Found {len(devices)} device(s).\n")

        # Print a neat table
        print(f"      {'NAME':<20} {'IP':<18} {'MODEL':<25} {'OS':<15}")
        print(f"      {'-'*20} {'-'*18} {'-'*25} {'-'*15}")
        for d in devices[:20]:  # first 20 only, to keep output short
            name = str(d.get("dns") or d.get("name") or "")[:20]
            ip = str(d.get("ip") or "")[:18]
            model = str(d.get("model") or "")[:25]
            os_name = str(d.get("os") or "")[:15]
            print(f"      {name:<20} {ip:<18} {model:<25} {os_name:<15}")

        return devices

    except requests.exceptions.RequestException as e:
        print(f"      ERROR: {e}")
        return []


def get_device_details(headers, device_ip):
    """Equivalent to clicking on a single device in the Inventory."""
    print(f"\n[3/5] Fetching details for device {device_ip}...")
    url = f"{BASE_URL}/api/v1/object/device/{device_ip}"

    try:
        r = requests.get(url, headers=headers, timeout=30)
        if r.status_code != 200:
            print(f"      Failed: HTTP {r.status_code}")
            return None

        device = r.json()
        print(f"      Name:     {device.get('dns') or device.get('name')}")
        print(f"      Model:    {device.get('model')}")
        print(f"      Vendor:   {device.get('vendor')}")
        print(f"      OS:       {device.get('os')}")
        print(f"      Location: {device.get('location')}")
        print(f"      Uptime:   {device.get('uptime')}")
        return device

    except requests.exceptions.RequestException as e:
        print(f"      ERROR: {e}")
        return None


def get_device_ports(headers, device_ip):
    """Equivalent to the 'Ports' tab on a device page."""
    print(f"\n[4/5] Fetching ports of device {device_ip}...")
    url = f"{BASE_URL}/api/v1/object/device/{device_ip}/ports"

    try:
        r = requests.get(url, headers=headers, timeout=30)
        if r.status_code != 200:
            print(f"      Failed: HTTP {r.status_code}")
            return []

        ports = r.json()
        print(f"      This device has {len(ports)} port(s):")
        for p in ports[:10]:
            port_name = p.get("port") or p.get("name")
            mac = p.get("mac") or ""
            up = p.get("up") or p.get("status") or ""
            print(f"        - {port_name:<15} MAC: {mac:<20} Status: {up}")
        return ports

    except requests.exceptions.RequestException as e:
        print(f"      ERROR: {e}")
        return []


def get_device_nodes(headers, device_ip):
    """Return MAC sightings on a device — used to find a MAC that actually exists."""
    url = f"{BASE_URL}/api/v1/object/device/{device_ip}/nodes"
    try:
        r = requests.get(url, headers=headers, params={"archive": "true"}, timeout=30)
        if r.status_code != 200:
            return []
        return r.json() or []
    except requests.exceptions.RequestException:
        return []


def _normalize_results(payload, headers):
    """Coerce whatever /search/node returns into a list[dict] of sightings."""
    if isinstance(payload, dict):
        results = payload.get("results") or payload.get("nodes") or []
    else:
        results = payload or []

    # If the API only gave us bare MAC strings, fetch each MAC's sightings.
    if results and isinstance(results[0], str):
        expanded = []
        for m in results:
            detail = requests.get(
                f"{BASE_URL}/api/v1/object/node/{m}",
                headers=headers,
                params={"archive": "true"},
                timeout=15,
            )
            if detail.status_code == 200:
                body = detail.json()
                expanded.extend(body if isinstance(body, list) else [body])
        results = expanded

    return [n for n in results if isinstance(n, dict)]


def lookup_mac_sightings(headers, mac):
    """Every (switch, port) where this MAC has been seen, archived + active."""
    r = requests.get(
        f"{BASE_URL}/api/v1/search/node",
        headers=headers,
        params={"q": mac, "archive": "true", "partial": "true", "stamps": "true"},
        timeout=30,
    )
    if r.status_code != 200:
        return [], f"HTTP {r.status_code}: {r.text[:200]}"
    return _normalize_results(r.json(), headers), None


def lookup_mac_ips(headers, mac):
    """Every IP this MAC has had (from the ARP/NodeIP table)."""
    r = requests.get(
        f"{BASE_URL}/api/v1/search/nodeip",
        headers=headers,
        params={"q": mac, "archive": "true", "stamps": "true"},
        timeout=30,
    )
    if r.status_code != 200:
        return []
    payload = r.json() or []
    if isinstance(payload, dict):
        payload = payload.get("results") or payload.get("nodes") or []
    return [n for n in payload if isinstance(n, dict)]


def _fmt_time(value):
    if not value:
        return "—"
    return str(value)[:19].replace("T", " ")


def _print_table(headers_row, rows):
    """Print a list of rows as an aligned ASCII table."""
    if not rows:
        return
    cols = list(zip(headers_row, *rows))
    widths = [max(len(str(cell)) for cell in col) for col in cols]
    fmt = "  " + "  ".join(f"{{:<{w}}}" for w in widths)
    sep = "  " + "  ".join("-" * w for w in widths)
    print(fmt.format(*headers_row))
    print(sep)
    for row in rows:
        print(fmt.format(*[str(c) for c in row]))


def report_mac(headers, mac):
    """Pretty end-to-end report for a single MAC address."""
    print()
    print("=" * 78)
    print(f" MAC Address Report:  {mac}")
    print("=" * 78)

    sightings, err = lookup_mac_sightings(headers, mac)
    if err:
        print(f"\n  Lookup failed: {err}")
        return
    if not sightings:
        print(f"\n  MAC {mac} not found in the Netdisco database.")
        return

    # ---- IP history ------------------------------------------------------
    ips = lookup_mac_ips(headers, mac)
    print("\n  IP addresses ever associated with this MAC:")
    if not ips:
        print("    (none recorded)")
    else:
        ip_rows = []
        for n in sorted(ips, key=lambda x: x.get("time_last") or "", reverse=True):
            ip_rows.append([
                n.get("ip") or "—",
                "active" if not n.get("active") in (False, 0, "0") and n.get("active", True) else "archived",
                _fmt_time(n.get("time_first")),
                _fmt_time(n.get("time_last")),
            ])
        _print_table(["IP", "Status", "First seen", "Last seen"], ip_rows)

    # ---- Switch port sightings ------------------------------------------
    print(f"\n  Switch port sightings ({len(sightings)} record(s), newest first):")
    sightings_sorted = sorted(
        sightings, key=lambda x: x.get("time_last") or "", reverse=True
    )

    rows = []
    for n in sightings_sorted:
        switch = n.get("switch") or n.get("device") or n.get("dns") or "—"
        port = n.get("port") or "—"
        vlan = n.get("vlan") or n.get("native") or "—"
        active_flag = n.get("active")
        active = "yes" if active_flag in (True, 1, "1", "t", "true") else "no"
        rows.append([
            str(switch),
            str(port),
            str(vlan),
            _fmt_time(n.get("time_first")),
            _fmt_time(n.get("time_last")),
            active,
        ])
    _print_table(
        ["Switch", "Port", "VLAN", "First seen", "Last seen", "Active"],
        rows,
    )

    # ---- "Currently here" summary ---------------------------------------
    active_now = [n for n in sightings_sorted
                  if n.get("active") in (True, 1, "1", "t", "true")]
    most_recent = active_now[0] if active_now else sightings_sorted[0]
    label = "Currently seen on" if active_now else "Most recently seen on"
    print(f"\n  {label}:")
    print(f"    {most_recent.get('switch') or most_recent.get('device') or '—'} "
          f"/ {most_recent.get('port') or '—'}   "
          f"(last seen {_fmt_time(most_recent.get('time_last'))})")
    print("=" * 78)
    return sightings


# Back-compat alias so the rest of the script can keep its name.
def find_mac(headers, mac):
    return report_mac(headers, mac)


# ----------------------------------------------------------------------
# SAVE A CSV REPORT — like a real network admin would
# ----------------------------------------------------------------------
def save_inventory_csv(devices, filename="network_inventory.csv"):
    if not devices:
        print("\n[bonus] No devices to save.")
        return

    print(f"\n[bonus] Saving inventory to '{filename}'...")
    with open(filename, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["Name", "IP", "Model", "Vendor", "OS", "Location"])
        for d in devices:
            writer.writerow([
                d.get("dns") or d.get("name") or "",
                d.get("ip") or "",
                d.get("model") or "",
                d.get("vendor") or "",
                d.get("os") or "",
                d.get("location") or "",
            ])
    print(f"        Saved {len(devices)} device(s) to {filename}")


# ----------------------------------------------------------------------
# MAIN
# ----------------------------------------------------------------------
def main():
    # Usage: python netdisco.py            -> full inventory tour
    #        python netdisco.py <mac>      -> focused report for one MAC
    cli_mac = sys.argv[1] if len(sys.argv) > 1 else None

    print("=" * 78)
    print(" Netdisco API Explorer — running against the public demo")
    print("=" * 78)

    api_key = login()
    headers = make_headers(api_key)

    if not api_key:
        print("\nLogin didn't return a key — trying API anyway (some")
        print("endpoints may still work without authentication).")

    # If the user passed a MAC on the command line, do just that lookup.
    if cli_mac:
        report_mac(headers, cli_mac)
        return

    # Otherwise: full tour (inventory + drill-in + auto-discovered MAC report).
    devices = list_all_devices(headers)

    mac_to_search = TEST_MAC
    if devices:
        first_device_ip = devices[0].get("ip")
        if first_device_ip:
            get_device_details(headers, first_device_ip)
            get_device_ports(headers, first_device_ip)

            for d in devices[:5]:
                nodes = get_device_nodes(headers, d.get("ip"))
                if nodes:
                    real_mac = nodes[0].get("mac")
                    if real_mac:
                        print(f"\n      (Auto-picked a real MAC from {d.get('ip')}: {real_mac})")
                        mac_to_search = real_mac
                        break

    report_mac(headers, mac_to_search)
    save_inventory_csv(devices)

    print("\n" + "=" * 78)
    print(" Done. Open 'network_inventory.csv' to see the saved inventory.")
    print(" Tip: run  python netdisco.py <mac>  to look up any MAC directly.")
    print("=" * 78)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n\nInterrupted by user.")
        sys.exit(0)
"""
Poll ServiceNow for open incidents, extract {switch, port} from each, and
save a lightweight ticket record to this directory. This is what the
RackTrack app reads after the technician logs in and captures a scan —
it tells the app *what device and what port* to verify.

One file per incident: <INC>.ticket.json
One aggregate file:    active_tickets.json (all currently open, latest first)

Usage:
    python poll.py                 # poll once
    python poll.py --watch 30      # poll every 30 seconds

Credentials: reads .env from this dir, or h:/dark_mobile/, or h:/SERVICENOW/.
"""
import json
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

import requests
from dotenv import load_dotenv


HERE = Path(__file__).resolve().parent
# Look for .env in the sibling servicenow/ bridge dir. Layout:
#   dark_mobile/
#     ├── servicenow/          <- bridge code + .env
#     └── servicenow_inbox/    <- this script lives here
ENV_CANDIDATES = [
    HERE.parent / "servicenow" / ".env",  # dark_mobile/servicenow/.env
    HERE / ".env",
    HERE.parent / ".env",
]


def load_env():
    for p in ENV_CANDIDATES:
        if p.exists():
            load_dotenv(p)
            return p
    raise FileNotFoundError(
        f"No .env found in any of: {', '.join(str(p) for p in ENV_CANDIDATES)}"
    )


def extract_port(text):
    m = re.search(r"port[\s#:]*(\d+)", text or "", re.I)
    return int(m.group(1)) if m else None


RACKTRACK_DEVICE_RE = re.compile(r"\b((?:SW|SRV|PP)-U\d{1,2})\b", re.I)


def extract_device_from_text(text):
    """Fallback: parse SW-Uxx, SRV-Uxx, PP-Uxx from text."""
    m = RACKTRACK_DEVICE_RE.search(text or "")
    return m.group(1).upper() if m else None


def is_racktrack_actionable(rec):
    """Only tickets with a parseable RackTrack-style device AND a port number
    are actionable — the RackTrack app needs both to know what to verify.
    Also accepts tickets where cmdb_ci is already set to a RackTrack-pattern name.
    """
    t = rec.get("target", {})
    if t.get("port") is None:
        return False
    dev = t.get("device") or ""
    return bool(RACKTRACK_DEVICE_RE.match(dev))


def fetch_open_incidents(base, auth, headers):
    r = requests.get(
        f"{base}/table/incident",
        params={
            "sysparm_query": "active=true^stateIN1,2",  # New + In Progress
            "sysparm_display_value": "true",
            "sysparm_exclude_reference_link": "true",
            "sysparm_fields": (
                "number,sys_id,short_description,description,"
                "cmdb_ci,priority,urgency,state,category,opened_at,opened_by"
            ),
            "sysparm_limit": 200,
        },
        auth=auth,
        headers=headers,
        timeout=20,
    )
    r.raise_for_status()
    return r.json().get("result", [])


_SWITCH_SUBCLASS_TABLES = ["cmdb_ci_ip_switch", "cmdb_ci_netgear", "cmdb_ci_server"]


def fetch_cmdb_device_details(base, auth, headers, device_name, port_num):
    """Look up the CMDB record for the device named in the ticket, plus the
    specific port adapter if known. Returns mgmt_ip, mac, model, serial,
    os_version, interface_alias (e.g. 'Gi1/0/15'), interface_name, rack, and U.
    """
    details = {"mgmt_ip": None, "mac": None, "model": None, "serial": None,
               "os_version": None, "vendor": None, "sys_class_name": None,
               "interface_name": None, "interface_alias": None,
               "port_short_description": None, "rack_name": None, "rack_scan_id": None,
               "u_position": None}

    device = None
    device_class = None
    for tbl in _SWITCH_SUBCLASS_TABLES:
        r = requests.get(f"{base}/table/{tbl}",
                         params={"sysparm_query": f"name={device_name}", "sysparm_limit": 1},
                         auth=auth, headers=headers, timeout=15)
        if r.status_code == 200 and r.json().get("result"):
            device = r.json()["result"][0]
            device_class = tbl
            break
    if not device:
        return details

    details["mgmt_ip"] = device.get("ip_address") or None
    details["mac"] = device.get("mac_address") or None
    details["model"] = device.get("model_number") or None
    details["serial"] = device.get("serial_number") or None
    details["os_version"] = device.get("os_version") or None
    details["sys_class_name"] = device_class
    # Zurich PDI sometimes puts Cisco IOS strings in os_version, infer vendor
    osv = (details["os_version"] or "").lower()
    if "ios" in osv or "catalyst" in (details["model"] or "").lower():
        details["vendor"] = "cisco-ios"
    # U position from name suffix
    m = re.search(r"[-_]U(\d{1,2})$", device_name or "", re.I)
    if m:
        details["u_position"] = int(m.group(1))

    # Find the specific port adapter for this device + port_num
    if port_num is not None:
        r = requests.get(f"{base}/table/cmdb_ci_network_adapter",
                         params={"sysparm_query": f"cmdb_ci={device['sys_id']}",
                                 "sysparm_fields": "name,alias,mac_address,short_description",
                                 "sysparm_limit": 100},
                         auth=auth, headers=headers, timeout=15)
        if r.status_code == 200:
            for p in r.json().get("result", []):
                alias = (p.get("alias") or "")
                # match by trailing /N or exact-ending N in alias/name
                if alias.endswith(f"/{port_num}") or alias == f"Gi0/{port_num}" or alias.endswith(str(port_num)):
                    details["interface_alias"] = alias
                    details["interface_name"] = p.get("name")
                    details["port_short_description"] = p.get("short_description")
                    break

    # Parent rack via Contains rel
    rel_type = requests.get(f"{base}/table/cmdb_rel_type",
                            params={"sysparm_query": "name=Contains::Contained by", "sysparm_limit": 1},
                            auth=auth, headers=headers, timeout=15).json().get("result")
    if rel_type:
        r = requests.get(f"{base}/table/cmdb_rel_ci",
                         params={"sysparm_query": f"child={device['sys_id']}^type={rel_type[0]['sys_id']}"
                                                  f"^parent.sys_class_name=cmdb_ci_rack", "sysparm_limit": 1},
                         auth=auth, headers=headers, timeout=15)
        rels = r.json().get("result", [])
        if rels:
            parent_ref = rels[0].get("parent", {})
            parent_id = parent_ref.get("value") if isinstance(parent_ref, dict) else parent_ref
            if parent_id:
                rr = requests.get(f"{base}/table/cmdb_ci_rack/{parent_id}",
                                  auth=auth, headers=headers, timeout=15)
                if rr.status_code == 200:
                    rack = rr.json().get("result", {})
                    details["rack_name"] = rack.get("name")
                    details["rack_scan_id"] = rack.get("u_racktrack_scan_id")
    return details


def ticket_record(inc, base=None, auth=None, headers=None):
    text = f"{inc.get('short_description') or ''} {inc.get('description') or ''}"
    port = extract_port(text)
    device_from_ci = inc.get("cmdb_ci") or None
    device_from_text = extract_device_from_text(text)
    switch = device_from_ci or device_from_text

    cmdb_details = {}
    if switch and base is not None:
        cmdb_details = fetch_cmdb_device_details(base, auth, headers, switch, port)

    return {
        "incident_number": inc.get("number"),
        "sys_id": inc.get("sys_id"),
        "state": inc.get("state"),
        "priority": inc.get("priority"),
        "urgency": inc.get("urgency"),
        "category": inc.get("category"),
        "opened_at": inc.get("opened_at"),
        "opened_by": inc.get("opened_by"),
        "short_description": inc.get("short_description"),
        "description": inc.get("description"),
        "target": {
            "device": switch,
            "port": port,
            "device_source": "cmdb_ci" if device_from_ci else ("parsed_text" if device_from_text else None),
            "port_source": "parsed_text" if port is not None else None,
        },
        "cmdb": cmdb_details,
        "instance_url": None,  # set by caller
        "polled_at": datetime.now(tz=__import__("datetime").timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
    }


def write_records(records, instance):
    # Remove stale per-incident ticket files not in current set
    current_names = {f"{r['incident_number']}.ticket.json" for r in records}
    for p in HERE.glob("*.ticket.json"):
        if p.name not in current_names:
            p.unlink()

    # Per-incident files
    for rec in records:
        rec["instance_url"] = f"https://{instance}.service-now.com/incident.do?sys_id={rec['sys_id']}"
        path = HERE / f"{rec['incident_number']}.ticket.json"
        with open(path, "w", encoding="utf-8") as f:
            json.dump(rec, f, indent=2)

    # Aggregate index, sorted by opened_at desc
    records_sorted = sorted(records, key=lambda r: r.get("opened_at") or "", reverse=True)
    index = {
        "polled_at": datetime.now(tz=__import__("datetime").timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "count": len(records_sorted),
        "tickets": records_sorted,
    }
    with open(HERE / "active_tickets.json", "w", encoding="utf-8") as f:
        json.dump(index, f, indent=2)


def poll_once():
    env_file = load_env()
    instance = os.environ["SN_INSTANCE"]
    auth = (os.environ["SN_USER"], os.environ["SN_PASSWORD"])
    base = f"https://{instance}.service-now.com/api/now"
    headers = {"Accept": "application/json"}

    incs = fetch_open_incidents(base, auth, headers)
    # First pass — cheap parse only, to filter out non-RackTrack tickets
    # (30+ stock ServiceNow demo incidents) before hitting CMDB.
    cheap = [ticket_record(i) for i in incs]
    actionable_incs = [i for i, r in zip(incs, cheap) if is_racktrack_actionable(r)]
    # Second pass — enrich only the actionable ones with CMDB lookups.
    records = [ticket_record(i, base, auth, headers) for i in actionable_incs]
    skipped = len(incs) - len(records)
    write_records(records, instance)

    print(f"[{datetime.utcnow().isoformat(timespec='seconds')}Z] "
          f"polled {instance}: {len(records)} RackTrack-actionable ticket(s) "
          f"(+{skipped} skipped, .env: {env_file})")
    for r in records:
        t = r["target"]
        print(f"  {r['incident_number']}  [{t['device']}:port{t['port']}]  "
              f"{r.get('short_description','')[:70]}")
    print(f"  -> {HERE / 'active_tickets.json'}")


def main(argv):
    if argv and argv[0] == "--watch":
        interval = int(argv[1]) if len(argv) > 1 else 30
        print(f"Polling every {interval}s. Ctrl-C to stop.")
        while True:
            try:
                poll_once()
            except Exception as e:
                print(f"  ERROR: {e}")
            time.sleep(interval)
    else:
        poll_once()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

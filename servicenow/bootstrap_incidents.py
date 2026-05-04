"""
Create a spread of realistic RackTrack-actionable incidents in the ServiceNow
PDI. Covers multiple switches and a mix of situations (misconfig, perf,
security, hardware, STP, cable, PoE). Each short_description matches the
regex in servicenow_inbox/poll.py so tickets show up in the mobile inbox.

Idempotent: looks up incidents by short_description first and skips any that
already exist.

Usage:
    python bootstrap_incidents.py
"""
import os
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

import requests
from dotenv import load_dotenv


INCIDENTS = [
    {
        "device": "SW-U10",
        "port": 13,
        "short_description": "Port 13 on SW-U10 assigned wrong VLAN - user on VLAN 10 instead of VLAN 20",
        "description": (
            "Helpdesk ticket from finance user on SW-U10 port 13 (Gi1/0/13). Link is up, "
            "DHCP gives an address in 10.10.10.0/24 (VLAN 10) but user should be on VLAN 20. "
            "Check interface VLAN assignment and reconfigure if the switchport is still in "
            "the wrong access VLAN. Link appears physically healthy."
        ),
        "priority": "4",
        "urgency": "2",
    },
    {
        "device": "SW-U10",
        "port": 15,
        "short_description": "Port 15 on SW-U10 speed mismatch - negotiating 100M half instead of 1G full",
        "description": (
            "Monitoring reports SW-U10 port 15 (Gi1/0/15) auto-negotiated to 100Mbps/half "
            "for the past 2 hours. User complaint about slow file copies from SRV-U01. "
            "Suspect degraded cable or bad patch. Link is up, traffic passes, but throughput "
            "is ~10x below expected. Verify cable integrity and PHY autoneg."
        ),
        "priority": "3",
        "urgency": "2",
    },
    {
        "device": "SW-U10",
        "port": 16,
        "short_description": "Port 16 on SW-U10 MAC flap - unknown device, possible rogue",
        "description": (
            "Security monitoring flagged MAC flapping on SW-U10 port 16 (Gi1/0/16) between "
            "two MAC addresses (AA:BB:CC:DE:AD:01 and AA:BB:CC:DE:AD:02) over the last 30 "
            "minutes. Neither MAC matches inventory. Could be an unauthorized device or a "
            "misplaced patch. Physical verification needed to identify what is plugged in."
        ),
        "priority": "2",
        "urgency": "1",
    },
    {
        "device": "SW-U10",
        "port": 22,
        "short_description": "Port 22 on SW-U10 PoE over-budget - IP camera power cycling",
        "description": (
            "SW-U10 port 22 (Gi1/0/22) reports PoE over-budget events; connected IP camera "
            "is rebooting every ~8 minutes. Class-4 device drawing >25W on a Class-3 config. "
            "Either reduce PoE priority on another port or re-class the interface. Link itself "
            "is up and data passes between reboots."
        ),
        "priority": "3",
        "urgency": "2",
    },
    {
        "device": "SW-U10",
        "port": 8,
        "short_description": "Port 8 on SW-U10 err-disabled by bpdu-guard",
        "description": (
            "SW-U10 port 8 (Gi1/0/8) transitioned to err-disable state 14 minutes ago after "
            "bpdu-guard received a BPDU on a port configured as portfast. Most likely someone "
            "plugged a switch or hub into an access port. Port is admin-up, oper-down. Need "
            "to identify the offending device before clearing the err-disable."
        ),
        "priority": "3",
        "urgency": "2",
    },
    {
        "device": "SW-U10",
        "port": 30,
        "short_description": "Port 30 on SW-U10 link never came up after patch install",
        "description": (
            "Cable was run to SW-U10 port 30 (Gi1/0/30) yesterday during the desk move for "
            "MKT-4. Link has never come up. Admin=up, oper=DOWN, no light. Either the patch "
            "was never completed at PP-U08, cable is damaged, or the far-end device is off. "
            "Walk the cable and verify both ends."
        ),
        "priority": "4",
        "urgency": "3",
    },
    {
        "device": "SW-U02",
        "port": 2,
        "short_description": "Port 2 on SW-U02 link flapping - up/down every 30-60 seconds",
        "description": (
            "SW-U02 port 2 (Gi0/2) has flapped 47 times in the last hour. STP is reconverging "
            "each time and costing a few seconds of traffic. Typical signature of a bad patch "
            "cable, loose RJ45, or a dying NIC at the far end. Reseat or replace cable, then "
            "observe for 15 minutes."
        ),
        "priority": "3",
        "urgency": "2",
    },
    {
        "device": "SW-U04",
        "port": 4,
        "short_description": "Port 4 on SW-U04 CRC errors rising - suspect cable damage",
        "description": (
            "SW-U04 port 4 (Gi0/4) CRC error counter is climbing at ~200/minute. Link is up "
            "and passing traffic but with heavy retransmits. Cable is routed along a PDU run "
            "and may be picking up EMI, or a connector is cracked. Replace patch cable and "
            "clear counters; escalate if errors return within 1 hour."
        ),
        "priority": "3",
        "urgency": "2",
    },
]


def load_env():
    env_path = os.path.join(os.path.dirname(__file__), ".env")
    if os.path.exists(env_path):
        load_dotenv(env_path)
    else:
        load_dotenv()


def find_switch_sys_id(base, auth, headers, device_name):
    """Look up switch sys_id in cmdb_ci_ip_switch so incidents can hang off the
    right CI. Returns None if the switch isn't in the CMDB."""
    r = requests.get(
        f"{base}/table/cmdb_ci_ip_switch",
        params={"sysparm_query": f"name={device_name}", "sysparm_limit": 1,
                "sysparm_fields": "sys_id,name"},
        auth=auth, headers=headers, timeout=15,
    )
    r.raise_for_status()
    results = r.json().get("result", [])
    return results[0]["sys_id"] if results else None


def find_existing_incident(base, auth, headers, short_description):
    """Skip-if-exists check by short_description. Using the full string keeps
    it unique enough for a demo — SN escapes it safely on the query side."""
    r = requests.get(
        f"{base}/table/incident",
        params={"sysparm_query": f"short_description={short_description}^active=true",
                "sysparm_limit": 1,
                "sysparm_fields": "number,sys_id,short_description"},
        auth=auth, headers=headers, timeout=15,
    )
    r.raise_for_status()
    results = r.json().get("result", [])
    return results[0] if results else None


def create_incident(base, auth, headers, payload):
    r = requests.post(
        f"{base}/table/incident",
        json=payload,
        auth=auth, headers=headers, timeout=20,
    )
    r.raise_for_status()
    return r.json().get("result", {})


def main():
    load_env()
    instance = os.environ["SN_INSTANCE"]
    auth = (os.environ["SN_USER"], os.environ["SN_PASSWORD"])
    base = f"https://{instance}.service-now.com/api/now"
    headers = {"Accept": "application/json", "Content-Type": "application/json"}

    # Cache switch sys_ids so we only hit /table/cmdb_ci_ip_switch once per switch
    switch_cache = {}

    created, skipped, missing = 0, 0, 0
    for spec in INCIDENTS:
        dev = spec["device"]

        if dev not in switch_cache:
            switch_cache[dev] = find_switch_sys_id(base, auth, headers, dev)
        sys_id = switch_cache[dev]
        if not sys_id:
            print(f"  [skip] {dev} port {spec['port']}: switch not found in CMDB")
            missing += 1
            continue

        existing = find_existing_incident(base, auth, headers, spec["short_description"])
        if existing:
            print(f"  [exists] {existing['number']}: {spec['short_description'][:70]}")
            skipped += 1
            continue

        payload = {
            "short_description": spec["short_description"],
            "description": spec["description"],
            "cmdb_ci": sys_id,
            "category": "network",
            "priority": spec["priority"],
            "urgency": spec["urgency"],
            "state": "1",
        }
        result = create_incident(base, auth, headers, payload)
        print(f"  [new] {result.get('number')}: {spec['short_description'][:70]}")
        created += 1

    print()
    print(f"Created: {created}  Already existed: {skipped}  Switch missing: {missing}")
    if created:
        print()
        print("Next: cd ../servicenow_inbox && python poll.py")
        print("      Then they'll show up in the RackTrack mobile inbox.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
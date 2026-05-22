"""
Bootstrap 10 incidents designed to TEST the intelligent agent in
servicenow_inbox/. Five are "medium" — the agent's rules + fuzzy match
should solve them (and the baseline regex in poll.py should NOT). Five
are "hard" — they push the agent into low-confidence territory, the
"needs human review" bucket, or the time-window correlation path.

This is a separate script from bootstrap_incidents.py so the two
corpora stay distinct:
  - bootstrap_incidents.py            → regex-friendly baseline demos
  - bootstrap_agent_test_incidents.py → agent acceptance suite

Idempotent: skips any incident whose short_description already exists.

Usage:
    python bootstrap_agent_test_incidents.py
    python bootstrap_agent_test_incidents.py --delete   (cleanup)

================================================================
TEST MATRIX
================================================================

MEDIUM (5) — agent should solve; regex alone fails

  M1  word_to_number         "the third uplink on SW-U10"
                             → device=SW-U10, port=3, failure=flapping
  M2  hyphenation_typo       "SW U-04 port 9 amber LED"
                             → fuzzy match → SW-U04, port=9, failure=amber
  M3  gi_notation            "Gi1/0/18 on SW-U10 dropping"
                             → device=SW-U10, port=18, failure=flapping
  M4  poe_failure_phrasing   "port 22 PoE camera rebooting"
                             → device=SW-U02, port=22, failure=hardware_replace
  M5  device_only_no_port    "SRV-U01 losing network"
                             → device=SRV-U01, port=null, failure=unreachable
                               (agent flags 'no port specified — physical check')

HARD (5) — agent should struggle, route to human review, or cluster

  H1  multi_device_ambig     "Maintenance on SW-U10 + SW-U02 broke
                              WEB-01/WEB-02/DB-01"
                             → multiple devices, no single port — confidence
                               drops below 0.4, routes to needs_human_review
  H2  network_layer_only     "Broadcast storm on VLAN 30, STP instability"
                             → no device, no port, no rack — full
                               needs_human_review
  H3  vague_human_language   "Rack 4 smells warm, fans loud"
                             → no device, no port, only rack — agent should
                               surface as 'physical inspection of RACK-04'
                               (rack-level only, not port-level)
  H4  rack_event_pair_a      "DB-01 lost network around 14:30"
                             → alone: needs_human_review (no port, vague)
  H5  rack_event_pair_b      "WEB-02 unreachable since ~14:40"
                             → alone: needs_human_review
                             → with H4: time-window correlation fires,
                               cluster as 'likely rack-wide event in RACK-04'

================================================================
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
    # ============================================================
    # MEDIUM — agent should solve these
    # ============================================================
    {
        "id": "M1",
        "difficulty": "medium",
        "tests": "word_to_number",
        "cmdb_device": "SW-U10",
        "short_description": "The third uplink on SW-U10 has been flapping since lunch",
        "description": (
            "Network ops noticed the third uplink port on SW-U10 keeps bouncing — link "
            "comes up for a minute, drops, comes back. Has been going on since around "
            "noon today. STP keeps reconverging. Suspect a bad patch cable or a loose "
            "RJ45 at the far end. Need someone on the floor to reseat or swap the cable."
        ),
        "priority": "3", "urgency": "2",
    },
    {
        "id": "M2",
        "difficulty": "medium",
        "tests": "hyphenation_fuzzy_match",
        "cmdb_device": "SW-U04",
        "short_description": "SW U-04 port 9 amber LED, no traffic passing",
        "description": (
            "Helpdesk forwarded this from a desktop user. They say the access switch "
            "in rack 4 (labeled 'SW U-04' on the front, position 4 from the top) has "
            "an amber light on port 9. Their machine cannot reach the network. Switch "
            "itself is up and reachable from monitoring. Probably a port-level fault, "
            "PHY or transceiver issue. Walk to the rack and replace the patch."
        ),
        "priority": "3", "urgency": "2",
    },
    {
        "id": "M3",
        "difficulty": "medium",
        "tests": "gi_notation_port",
        "cmdb_device": "SW-U10",
        "short_description": "Gi1/0/18 on SW-U10 connection drops every few minutes",
        "description": (
            "Monitoring is alerting on Gi1/0/18 (SW-U10) — link drops once or twice per "
            "5 minute window. Counters show CRC errors climbing slowly, ~30/min, and "
            "input errors on the same interface. Pattern is classic dirty fiber or a "
            "cracked RJ45 connector. Replace patch cable and observe for 30 min."
        ),
        "priority": "3", "urgency": "2",
    },
    {
        "id": "M4",
        "difficulty": "medium",
        "tests": "non_standard_failure_keyword",
        "cmdb_device": "SW-U02",
        "short_description": "Port 22 on SW-U02 PoE camera keeps rebooting every 8 min",
        "description": (
            "Security camera connected to SW-U02 port 22 power-cycles every ~8 minutes. "
            "Switch logs show PoE over-budget warnings on the same port. Camera draws "
            "more than the port was configured for. Either re-class the port to a higher "
            "PoE class or swap to a different port that can deliver the wattage. Camera "
            "hardware itself looks fine — same model is running fine on port 24."
        ),
        "priority": "3", "urgency": "2",
    },
    {
        "id": "M5",
        "difficulty": "medium",
        "tests": "device_only_no_port",
        "cmdb_device": "SRV-U01",
        "short_description": "SRV-U01 keeps losing network connection at random times",
        "description": (
            "Owner of SRV-U01 (app server, rack 4 position 1) reports the box keeps "
            "dropping off the network — sometimes minutes, sometimes hours. No ticket "
            "from the switch side. Could be a flapping uplink to the server, a bad NIC, "
            "or someone walking through the rack. No specific port number identified at "
            "this end; whoever takes the ticket will need to trace the cable physically."
        ),
        "priority": "3", "urgency": "2",
    },

    # ============================================================
    # HARD — agent should struggle / route to needs_human_review
    # ============================================================
    {
        "id": "H1",
        "difficulty": "hard",
        "tests": "multi_device_ambiguity",
        "cmdb_device": "SW-U10",  # one of several mentioned — deliberately ambiguous
        "short_description": "Maintenance on SW-U10 and SW-U02 left WEB-01, WEB-02, DB-01 disconnected",
        "description": (
            "Last night's planned maintenance touched both SW-U10 and SW-U02. This "
            "morning multiple users report problems — WEB-01 cannot reach the internet, "
            "WEB-02 is intermittent, DB-01 lost its replication peer. Not clear which "
            "switch caused which symptom, or which ports are involved. Possibly a "
            "config rollback issue. Needs a network engineer to bisect."
        ),
        "priority": "2", "urgency": "1",
    },
    {
        "id": "H2",
        "difficulty": "hard",
        "tests": "network_layer_only",
        "cmdb_device": None,  # no CI — pure network-layer ticket
        "short_description": "Broadcast storm on VLAN 30 — STP root bridge instability",
        "description": (
            "Spanning-tree topology change notifications flooding for VLAN 30. Root "
            "bridge keeps changing between two switches every ~90 seconds. Symptoms "
            "are user-facing slowness across the whole VLAN, not tied to any specific "
            "port. Likely a misconfigured priority or a rogue switch announcing itself. "
            "Network team to investigate from the control-plane side, not the rack."
        ),
        "priority": "1", "urgency": "1",
    },
    {
        "id": "H3",
        "difficulty": "hard",
        "tests": "vague_human_language",
        "cmdb_device": None,  # no CI, only a rack reference
        "short_description": "Rack 4 smells warm and fans sound louder than normal",
        "description": (
            "Walking past rack 4 this morning the air coming out the back was "
            "noticeably hotter than the rest of the row, and the fans on one of the "
            "units (bottom half of the rack) sound louder than usual. No alerts in "
            "monitoring yet. Could be a failing PSU, blocked airflow, or just a "
            "hot day. Send someone to physically inspect."
        ),
        "priority": "3", "urgency": "2",
    },
    {
        "id": "H4",
        "difficulty": "hard",
        "tests": "time_window_correlation_pair_A",
        "cmdb_device": "DB-01",
        "short_description": "DB-01 lost network around 14:30, no other devices affected as far as I can see",
        "description": (
            "Got a call from the DB team — DB-01 dropped off the network at about "
            "14:30 this afternoon. They restarted the host-side bond and it came "
            "back. No switch-side alerts visible to them. Nothing else seemed to be "
            "affected. Logging this for visibility in case it happens again."
        ),
        "priority": "3", "urgency": "3",
    },
    {
        "id": "H5",
        "difficulty": "hard",
        "tests": "time_window_correlation_pair_B",
        "cmdb_device": "WEB-02",
        "short_description": "WEB-02 unreachable since ~14:40, web team working on it",
        "description": (
            "WEB-02 went unreachable around 14:40. Web team is investigating — could "
            "be the app, could be the network, could be the host. They will update "
            "once they have a root cause. Filing separately so it's tracked."
        ),
        "priority": "3", "urgency": "2",
    },
]


def load_env():
    env_path = os.path.join(os.path.dirname(__file__), ".env")
    if os.path.exists(env_path):
        load_dotenv(env_path)
    else:
        load_dotenv()


def find_ci_sys_id(base, auth, headers, device_name):
    """Look up a CI sys_id across the tables we use in this project.
    Servers live in cmdb_ci_server, switches in cmdb_ci_ip_switch."""
    if not device_name:
        return None
    for tbl in ("cmdb_ci_ip_switch", "cmdb_ci_server", "cmdb_ci_netgear"):
        r = requests.get(
            f"{base}/table/{tbl}",
            params={"sysparm_query": f"name={device_name}", "sysparm_limit": 1,
                    "sysparm_fields": "sys_id,name"},
            auth=auth, headers=headers, timeout=15,
        )
        if r.status_code == 200 and r.json().get("result"):
            return r.json()["result"][0]["sys_id"]
    return None


def find_existing_incident(base, auth, headers, short_description):
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


def delete_existing(base, auth, headers):
    """Delete every test incident in our suite (matched by short_description).
    Use --delete to wipe the suite for a clean re-run."""
    removed = 0
    for spec in INCIDENTS:
        existing = find_existing_incident(base, auth, headers, spec["short_description"])
        if not existing:
            continue
        r = requests.delete(
            f"{base}/table/incident/{existing['sys_id']}",
            auth=auth, headers=headers, timeout=15,
        )
        if r.status_code in (200, 204):
            print(f"  [del] {existing['number']}: {spec['id']}")
            removed += 1
        else:
            print(f"  [err] {existing['number']}: HTTP {r.status_code}")
    print(f"Removed: {removed}")
    return 0


def main(argv):
    load_env()
    instance = os.environ["SN_INSTANCE"]
    auth = (os.environ["SN_USER"], os.environ["SN_PASSWORD"])
    base = f"https://{instance}.service-now.com/api/now"
    headers = {"Accept": "application/json", "Content-Type": "application/json"}

    if argv and argv[0] == "--delete":
        return delete_existing(base, auth, headers)

    ci_cache = {}
    created, skipped, missing_ci, no_ci_ok = 0, 0, 0, 0

    for spec in INCIDENTS:
        dev = spec.get("cmdb_device")

        # Resolve CI if the test case names one
        sys_id = None
        if dev:
            if dev not in ci_cache:
                ci_cache[dev] = find_ci_sys_id(base, auth, headers, dev)
            sys_id = ci_cache[dev]
            if not sys_id:
                print(f"  [skip] {spec['id']} ({dev}): CI not found in CMDB — "
                      f"populate CMDB first (see servicenow/cmdb_seed.md)")
                missing_ci += 1
                continue

        existing = find_existing_incident(base, auth, headers, spec["short_description"])
        if existing:
            print(f"  [exists] {existing['number']} [{spec['id']}/{spec['difficulty']}]: "
                  f"{spec['short_description'][:60]}")
            skipped += 1
            continue

        payload = {
            "short_description": spec["short_description"],
            "description": spec["description"],
            "category": "network",
            "priority": spec["priority"],
            "urgency": spec["urgency"],
            "state": "1",
        }
        if sys_id:
            payload["cmdb_ci"] = sys_id
        else:
            # H2/H3 deliberately have no CI — that's part of the test
            no_ci_ok += 1

        result = create_incident(base, auth, headers, payload)
        ci_label = dev or "(no CI — intentional)"
        print(f"  [new]  {result.get('number')} [{spec['id']}/{spec['difficulty']}] "
              f"{ci_label}: {spec['short_description'][:55]}")
        created += 1

    print()
    print(f"Created: {created}  Existed: {skipped}  "
          f"Missing CI: {missing_ci}  No-CI-by-design: {no_ci_ok}")
    if created:
        print()
        print("Next:")
        print("  1. cd ../servicenow_inbox && python poll.py")
        print("  2. Inspect active_tickets.json — check that:")
        print("     - M1-M5 land in 'ranked' with confidence >= 0.5")
        print("     - H2, H3 land in 'needs_human_review'")
        print("     - H4 + H5 surface together in 'batches' (same rack, ~10min apart)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

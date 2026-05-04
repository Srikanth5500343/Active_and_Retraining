"""
Delete a set of incidents from ServiceNow by number. One-shot utility — edit
the INCIDENT_NUMBERS list before running.

Usage:
    python delete_incidents.py
"""
import os
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

import requests
from dotenv import load_dotenv


INCIDENT_NUMBERS = [
    "INC0010004",  # SW-U15 port 3 (pre-existing)
    "INC0010012",  # SW-U15 port 5
    "INC0010015",  # SW-U07 port 1
]


def load_env():
    env_path = os.path.join(os.path.dirname(__file__), ".env")
    if os.path.exists(env_path):
        load_dotenv(env_path)
    else:
        load_dotenv()


def find_incident(base, auth, headers, number):
    r = requests.get(
        f"{base}/table/incident",
        params={"sysparm_query": f"number={number}", "sysparm_limit": 1,
                "sysparm_fields": "sys_id,number,short_description"},
        auth=auth, headers=headers, timeout=15,
    )
    r.raise_for_status()
    results = r.json().get("result", [])
    return results[0] if results else None


def delete_incident(base, auth, headers, sys_id):
    r = requests.delete(
        f"{base}/table/incident/{sys_id}",
        auth=auth, headers=headers, timeout=20,
    )
    r.raise_for_status()
    return r.status_code


def main():
    load_env()
    instance = os.environ["SN_INSTANCE"]
    auth = (os.environ["SN_USER"], os.environ["SN_PASSWORD"])
    base = f"https://{instance}.service-now.com/api/now"
    headers = {"Accept": "application/json", "Content-Type": "application/json"}

    deleted, missing = 0, 0
    for number in INCIDENT_NUMBERS:
        inc = find_incident(base, auth, headers, number)
        if not inc:
            print(f"  [missing] {number} not found")
            missing += 1
            continue
        delete_incident(base, auth, headers, inc["sys_id"])
        print(f"  [deleted] {number}: {inc['short_description'][:70]}")
        deleted += 1

    print()
    print(f"Deleted: {deleted}  Missing: {missing}")
    if deleted:
        print()
        print("Next: cd ../servicenow_inbox && python poll.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
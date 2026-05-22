"""
CLI entry point.

Usage:
    python main.py INC0010001

Flow:
    1. Load credentials from .env
    2. Fetch incident from ServiceNow
    3. Read its cmdb_ci field → switch CI
    4. Walk cmdb_rel_ci → parent rack CI
    5. Read rack's u_racktrack_scan_id → scan ID
    6. Fetch RackTrack scan (mock or live)
    7. Reconcile → build work note
    8. Show preview, ask for confirmation
    9. PATCH incident with the work note
"""
import os
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

from dotenv import load_dotenv

from racktrack import get_scan
from reconciler import reconcile
from servicenow import ServiceNowClient


def fatal(msg: str, code: int = 1) -> int:
    print(f"ERROR: {msg}", file=sys.stderr)
    return code


def main(incident_number: str) -> int:
    load_dotenv()

    try:
        sn = ServiceNowClient(
            instance=os.environ["SN_INSTANCE"],
            user=os.environ["SN_USER"],
            password=os.environ["SN_PASSWORD"],
        )
    except KeyError as e:
        return fatal(f"missing env var {e}. Did you copy .env.example to .env?")

    print(f"→ Fetching incident {incident_number} …")
    incident = sn.get_incident(incident_number)
    if not incident:
        return fatal(f"incident {incident_number} not found in ServiceNow")
    print(f"  {incident_number}: {incident.get('short_description', '(no description)')}")

    ci_ref = incident.get("cmdb_ci")
    if not ci_ref or not (isinstance(ci_ref, dict) and ci_ref.get("value")):
        return fatal(
            f"incident {incident_number} has no cmdb_ci set. "
            f"Open it in ServiceNow and set a Configuration item."
        )

    print("→ Fetching primary CI …")
    primary_ci = sn.get_ci(ci_ref["value"])
    if not primary_ci:
        return fatal(f"CI {ci_ref['value']} not found")
    print(f"  CI: {primary_ci.get('name')} ({primary_ci.get('sys_class_name')})")

    print("→ Walking CMDB to find parent rack …")
    rack_ci = sn.get_parent_rack(primary_ci["sys_id"])
    if not rack_ci:
        return fatal(
            f"CI {primary_ci.get('name')} has no parent rack relationship in cmdb_rel_ci. "
            "Create a 'Contains::Contained by' relationship with a rack as parent."
        )
    print(f"  Rack: {rack_ci.get('name')}")

    rack_scan_id = rack_ci.get("u_racktrack_scan_id")
    if not rack_scan_id:
        return fatal(
            f"rack {rack_ci.get('name')} has no u_racktrack_scan_id set. "
            f"Open it in ServiceNow and set RackTrack scan ID = RK-DC1RACK4."
        )
    print(f"  RackTrack scan ID: {rack_scan_id}")

    print("→ Loading RackTrack scan …")
    try:
        scan = get_scan(rack_scan_id)
    except FileNotFoundError as e:
        return fatal(str(e))
    except Exception as e:
        return fatal(f"RackTrack fetch failed: {e}")
    print(f"  {len(scan.get('devices', []))} devices in scan")

    print("→ Loading rack inventory for audit …")
    rack_children = sn.get_rack_children(rack_ci["sys_id"])
    print(f"  {len(rack_children)} CIs in rack")

    note = reconcile(incident, primary_ci, rack_ci, rack_children, scan)

    print()
    print("─" * 60)
    print(note)
    print("─" * 60)
    print()

    confirm = input("Post this as a work note on the incident? [y/N] ").strip().lower()
    if confirm != "y":
        print("Not posted.")
        return 0

    print("→ Posting work note …")
    sn.add_work_note(incident["sys_id"], note)
    url = f"https://{os.environ['SN_INSTANCE']}.service-now.com/incident.do?sys_id={incident['sys_id']}"
    print(f"✓ Posted. View: {url}")
    return 0


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python main.py <incident_number>")
        print("Example: python main.py INC0010001")
        sys.exit(2)
    sys.exit(main(sys.argv[1]))

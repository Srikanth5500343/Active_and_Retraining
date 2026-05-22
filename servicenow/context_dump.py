"""
Context dump: given a ServiceNow incident about a specific port, extract the
full chain of CMDB data and hand it to RackTrack.

Flow:
  1. Fetch incident, parse port number + device name from ticket text.
  2. Resolve primary CI (the device the ticket is about — a switch here).
  3. Walk the cable chain starting from the affected port:
       switch port -> (Connects to) -> patch panel port -> (Connects to) -> server NIC
  4. For each hop, fetch the device + all its data (IPs, MACs, VLANs,
     short_description metadata, disks, partitions, rack position).
  5. Bundle into a single JSON payload.
  6. Write it to outputs/<incident>.json (RackTrack ingest point).
  7. Post a summarized work note on the incident.

Usage:
    python context_dump.py <INC-NUMBER>
"""
import json
import os
import re
import sys
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

import requests
from dotenv import load_dotenv


CONNECTS_TO_REL_TYPE = "5599a965c0a8010e00da3b58b113d70e"
CONTAINS_REL_TYPE_NAME = "Contains::Contained by"


class SN:
    def __init__(self):
        load_dotenv()
        self.inst = os.environ["SN_INSTANCE"]
        self.auth = (os.environ["SN_USER"], os.environ["SN_PASSWORD"])
        self.base = f"https://{self.inst}.service-now.com/api/now"
        self.h = {"Accept": "application/json", "Content-Type": "application/json"}

    def get(self, path, params=None):
        r = requests.get(f"{self.base}{path}", params=params or {}, auth=self.auth, headers=self.h, timeout=20)
        r.raise_for_status()
        return r.json().get("result")

    def find(self, table, query, limit=1):
        res = self.get(f"/table/{table}", {"sysparm_query": query, "sysparm_limit": limit})
        return (res[0] if res else None) if limit == 1 else res

    def get_ci_subclass(self, sys_id):
        base = self.get(f"/table/cmdb_ci/{sys_id}")
        if not base:
            return None
        cls = base.get("sys_class_name")
        if not cls or cls == "cmdb_ci":
            return base
        specific = self.get(f"/table/{cls}/{sys_id}")
        return specific or base

    def connected_to(self, port_sys_id, visited=None):
        """Find the port on the other end of a cable from this port (either direction).

        Uses ^NQ to run two properly-ANDed sub-queries (type+parent, type+child)
        rather than ^OR which loses the type constraint on the OR branch.
        Skips any port in `visited` to prevent bouncing back and forth.
        """
        visited = visited or set()
        # parent=me branch
        rels = self.find("cmdb_rel_ci",
                         f"type={CONNECTS_TO_REL_TYPE}^parent={port_sys_id}"
                         f"^NQtype={CONNECTS_TO_REL_TYPE}^child={port_sys_id}",
                         limit=20) or []
        for rel in rels:
            parent_ref = rel.get("parent", {})
            child_ref = rel.get("child", {})
            p_id = parent_ref.get("value") if isinstance(parent_ref, dict) else parent_ref
            c_id = child_ref.get("value") if isinstance(child_ref, dict) else child_ref
            far_id = c_id if p_id == port_sys_id else p_id
            if not far_id or far_id == port_sys_id or far_id in visited:
                continue
            far = self.find("cmdb_ci_network_adapter", f"sys_id={far_id}")
            if far:
                return far, "cmdb_ci_network_adapter"
            far = self.find("cmdb_ci_port", f"sys_id={far_id}")
            if far:
                return far, "cmdb_ci_port"
        return None, None

    def port_parent_device(self, port_sys_id, port_table):
        """Find the device this port belongs to."""
        if port_table == "cmdb_ci_network_adapter":
            port = self.find("cmdb_ci_network_adapter", f"sys_id={port_sys_id}")
            if port and port.get("cmdb_ci"):
                parent_id = port["cmdb_ci"]["value"] if isinstance(port["cmdb_ci"], dict) else port["cmdb_ci"]
                return self.get_ci_subclass(parent_id)
        # Fallback: walk Contains relationship upward
        contains_type = self.find("cmdb_rel_type", f"name={CONTAINS_REL_TYPE_NAME}")
        if not contains_type:
            return None
        rel = self.find("cmdb_rel_ci", f"type={contains_type['sys_id']}^child={port_sys_id}")
        if rel:
            parent_ref = rel.get("parent", {})
            parent_id = parent_ref.get("value") if isinstance(parent_ref, dict) else parent_ref
            if parent_id:
                return self.get_ci_subclass(parent_id)
        return None

    def device_ports(self, device_sys_id):
        """All network adapters attached to a device."""
        return self.find("cmdb_ci_network_adapter", f"cmdb_ci={device_sys_id}", limit=100) or []

    def server_disks(self, server_sys_id):
        contains = self.find("cmdb_rel_type", f"name={CONTAINS_REL_TYPE_NAME}")
        if not contains:
            return []
        rels = self.find("cmdb_rel_ci", f"parent={server_sys_id}^type={contains['sys_id']}", limit=100) or []
        disks = []
        for rel in rels:
            child_ref = rel.get("child", {})
            child_id = child_ref.get("value") if isinstance(child_ref, dict) else child_ref
            if not child_id:
                continue
            disk = self.find("cmdb_ci_disk", f"sys_id={child_id}")
            if disk:
                disks.append(disk)
        return disks

    def server_partitions(self, server_sys_id):
        return self.find("cmdb_ci_disk_partition", f"computer={server_sys_id}", limit=100) or []

    def rack_of_device(self, device_sys_id):
        contains = self.find("cmdb_rel_type", f"name={CONTAINS_REL_TYPE_NAME}")
        rel = self.find("cmdb_rel_ci", f"child={device_sys_id}^type={contains['sys_id']}^parent.sys_class_name=cmdb_ci_rack")
        if rel:
            parent_ref = rel.get("parent", {})
            pid = parent_ref.get("value") if isinstance(parent_ref, dict) else parent_ref
            return self.get_ci_subclass(pid)
        return None


def extract_port_number(incident):
    text = (incident.get("short_description") or "") + " " + (incident.get("description") or "")
    m = re.search(r"port[\s#:]*(\d+)", text, re.I)
    return int(m.group(1)) if m else None


def strip_refs(d):
    """Replace ServiceNow reference objects with their display values for readable JSON."""
    if not isinstance(d, dict):
        return d
    out = {}
    for k, v in d.items():
        if isinstance(v, dict) and "display_value" in v:
            out[k] = v["display_value"] or v.get("value", "")
        elif isinstance(v, dict):
            out[k] = strip_refs(v)
        else:
            out[k] = v
    return out


def main(inc_number):
    sn = SN()

    print(f"[1/7] Fetching incident {inc_number} ...")
    incident = sn.find("incident", f"number={inc_number}")
    if not incident:
        print(f"  ERROR: {inc_number} not found")
        return 1
    print(f"  {incident['number']}: {incident.get('short_description','')}")

    print("[2/7] Extracting port number from ticket text ...")
    port_num = extract_port_number(incident)
    if not port_num:
        print("  ERROR: no port number found in ticket text")
        return 1
    print(f"  port={port_num}")

    print("[3/7] Resolving primary CI (switch) ...")
    ci_ref = incident.get("cmdb_ci")
    if not ci_ref or not (isinstance(ci_ref, dict) and ci_ref.get("value")):
        print("  ERROR: incident has no cmdb_ci")
        return 1
    switch = sn.get_ci_subclass(ci_ref["value"])
    print(f"  {switch.get('name')} ({switch.get('sys_class_name')})")

    print("[4/7] Finding port adapter ...")
    port_candidates = sn.device_ports(switch["sys_id"])
    affected_port = None
    for p in port_candidates:
        alias = (p.get("alias") or "")
        if alias.endswith(f"/{port_num}") or alias == f"Gi0/{port_num}" or alias.endswith(f"{port_num}"):
            affected_port = p
            break
    if not affected_port:
        for p in port_candidates:
            if p.get("name", "").endswith(f"/{port_num}"):
                affected_port = p
                break
    if not affected_port:
        print(f"  ERROR: could not find port {port_num} on {switch.get('name')}")
        return 1
    print(f"  {affected_port.get('name')}  mac={affected_port.get('mac_address')}  {affected_port.get('short_description','')[:80]}")

    print("[5/7] Tracing cable chain ...")
    chain = [("switch_port", affected_port, "cmdb_ci_network_adapter")]
    current = affected_port
    current_table = "cmdb_ci_network_adapter"
    visited = {affected_port["sys_id"]}
    max_hops = 5
    for hop in range(max_hops):
        far, far_table = sn.connected_to(current["sys_id"], visited)
        if not far:
            break
        chain.append(("remote_port", far, far_table))
        visited.add(far["sys_id"])
        current = far
        current_table = far_table
    print(f"  {len(chain)} hops: " + " -> ".join(c[1].get("name", "?") for c in chain))

    print("[6/7] Assembling full context ...")
    rack = sn.rack_of_device(switch["sys_id"])

    # Resolve far-end device (last port's parent)
    far_end_device = None
    far_end_extra = {}
    if len(chain) >= 3:
        last_port, last_table = chain[-1][1], chain[-1][2]
        far_end_device = sn.port_parent_device(last_port["sys_id"], last_table)
        if far_end_device and far_end_device.get("sys_class_name") == "cmdb_ci_server":
            server_sys_id = far_end_device["sys_id"]
            far_end_extra["all_nics"] = [strip_refs(p) for p in sn.device_ports(server_sys_id)]
            far_end_extra["disks"] = [strip_refs(d) for d in sn.server_disks(server_sys_id)]
            far_end_extra["partitions"] = [strip_refs(p) for p in sn.server_partitions(server_sys_id)]

    # Mid-chain devices (patch panel, etc.)
    mid_devices = []
    for label, port, table in chain[1:-1] if len(chain) > 2 else []:
        parent = sn.port_parent_device(port["sys_id"], table)
        if parent:
            mid_devices.append(strip_refs(parent))

    context = {
        "source": "servicenow-cmdb",
        "incident": {
            "number": incident.get("number"),
            "short_description": incident.get("short_description"),
            "description": incident.get("description"),
            "priority": incident.get("priority"),
            "category": incident.get("category"),
            "sys_id": incident.get("sys_id"),
        },
        "parsed": {
            "port_number": port_num,
            "device_name": switch.get("name"),
        },
        "rack": strip_refs(rack) if rack else None,
        "switch": strip_refs(switch),
        "affected_port": strip_refs(affected_port),
        "cable_chain": [
            {
                "hop": i,
                "role": c[0],
                "port_table": c[2],
                "port": strip_refs(c[1]),
            }
            for i, c in enumerate(chain)
        ],
        "mid_devices": mid_devices,
        "far_end_device": strip_refs(far_end_device) if far_end_device else None,
        "far_end_extra": far_end_extra,
    }

    # Dump JSON to the sibling servicenow_inbox/ directory. This script lives
    # at dark_mobile/servicenow/context_dump.py, and the inbox is at
    # dark_mobile/servicenow_inbox/.
    inbox = Path(__file__).resolve().parent.parent / "servicenow_inbox"
    if not inbox.exists():
        inbox = Path(__file__).parent / "outputs"
    inbox.mkdir(parents=True, exist_ok=True)
    out_path = inbox / f"{inc_number}.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(context, f, indent=2, default=str)
    print(f"  wrote {out_path}")

    print("[7/7] Posting summarized work note ...")
    summary = build_work_note(context)
    print()
    print("─" * 70)
    print(summary)
    print("─" * 70)
    print()
    resp = input("Post this work note + attach the full context JSON? [y/N] ").strip().lower()
    if resp != "y":
        print("Not posted.")
        return 0

    # Post note
    requests.patch(
        f"{sn.base}/table/incident/{incident['sys_id']}",
        json={"work_notes": summary},
        auth=sn.auth, headers=sn.h, timeout=20,
    ).raise_for_status()

    # Attach full JSON as a file on the incident
    with open(out_path, "rb") as f:
        r = requests.post(
            f"{sn.base.replace('/api/now','')}/api/now/attachment/file",
            params={
                "table_name": "incident",
                "table_sys_id": incident["sys_id"],
                "file_name": f"{inc_number}_cmdb_context.json",
            },
            data=f.read(),
            auth=sn.auth,
            headers={"Content-Type": "application/json", "Accept": "application/json"},
            timeout=30,
        )
        r.raise_for_status()
    print(f"  work note posted, context JSON attached")
    print(f"  open: https://{sn.inst}.service-now.com/incident.do?sys_id={incident['sys_id']}")
    return 0


def build_work_note(ctx):
    lines = []
    inc = ctx["incident"]
    lines.append(f"CMDB context for {inc['number']}")
    lines.append("")

    rack = ctx["rack"] or {}
    lines.append(f"Rack:   {rack.get('name','?')}  (scan_id={rack.get('u_racktrack_scan_id','?')}, asset_tag={rack.get('asset_tag','?')}, serial={rack.get('serial_number','?')})")

    sw = ctx["switch"]
    lines.append(f"Switch: {sw.get('name')}  model={sw.get('model_number')}  serial={sw.get('serial_number')}  mgmt_ip={sw.get('ip_address')}  mac={sw.get('mac_address')}")

    p = ctx["affected_port"]
    lines.append("")
    lines.append(f"Affected port: {p.get('name')}")
    lines.append(f"  MAC: {p.get('mac_address')}")
    lines.append(f"  Config: {p.get('short_description','')}")

    lines.append("")
    lines.append(f"Cable chain ({len(ctx['cable_chain'])} hops):")
    for hop in ctx["cable_chain"]:
        pp = hop["port"]
        lines.append(f"  [{hop['hop']}] {pp.get('name')}  ({hop['port_table']})")
        if pp.get("short_description"):
            lines.append(f"       {pp['short_description']}")

    mids = ctx.get("mid_devices", [])
    if mids:
        lines.append("")
        lines.append("Intermediate devices:")
        for d in mids:
            lines.append(f"  - {d.get('name')} ({d.get('sys_class_name')})  model={d.get('model_number')}  serial={d.get('serial_number')}")

    far = ctx.get("far_end_device")
    if far:
        lines.append("")
        lines.append(f"Far-end device: {far.get('name')} ({far.get('sys_class_name')})")
        lines.append(f"  OS: {far.get('os_version') or far.get('os')}  model={far.get('model_number')}  serial={far.get('serial_number')}")
        nics = ctx.get("far_end_extra", {}).get("all_nics", [])
        if nics:
            lines.append(f"  NICs ({len(nics)}):")
            for n in nics:
                lines.append(f"    - {n.get('name')}  mac={n.get('mac_address')}  ip={n.get('ip_address')}  fqdn={n.get('fqdn','')}")
        disks = ctx.get("far_end_extra", {}).get("disks", [])
        if disks:
            lines.append(f"  Disks ({len(disks)}):")
            for d in disks:
                size = d.get("size_bytes")
                try:
                    size_str = f"{int(size)/1e9:.1f} GB"
                except (TypeError, ValueError):
                    size_str = str(size)
                lines.append(f"    - {d.get('name')}  size={size_str}  {d.get('short_description','')}")
        parts = ctx.get("far_end_extra", {}).get("partitions", [])
        if parts:
            lines.append(f"  Partitions ({len(parts)}):")
            for p in parts:
                lines.append(f"    - {p.get('name')} (part #{p.get('partition_number')})  {p.get('short_description','')}")

    lines.append("")
    lines.append("Full CMDB payload handed to RackTrack:")
    lines.append(f"  outputs/{inc['number']}.json  (also attached to this ticket)")
    lines.append("")
    lines.append("RackTrack can now correlate this full context with the last rack scan")
    lines.append("to physically verify every link on this cable path.")

    return "\n".join(lines)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python context_dump.py <INC-NUMBER>")
        sys.exit(2)
    sys.exit(main(sys.argv[1]))

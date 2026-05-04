"""
Ingest handler: reads a ServiceNow CMDB context JSON from this inbox, verifies
every device in the cable chain against the actual rack scan, and writes a
verification report alongside the input.

Flow:
  1. Load <INC>.json from this directory.
  2. Pull rackId from the payload.
  3. Load rack scan from h:/dark_mobile/outputs/<rackId>/device_unit_map.json
     + scan_meta.json for timestamp.
  4. For each device the CMDB claims is involved (switch, patch panel, server):
     - Parse expected U position from name suffix (e.g. SW-U10 -> 10).
     - Look up the scan's detections at that U.
     - Compare CMDB-expected device class against scan-observed class.
  5. Emit verification report: <INC>.verification.json (structured) and
     <INC>.verification.txt (human-readable).

Usage:
    python ingest.py INC0010002.json
    python ingest.py --all      (process every unverified JSON in inbox)
"""
import json
import re
import sys
from datetime import datetime
from pathlib import Path


INBOX = Path(__file__).parent
DM_OUTPUTS = INBOX.parent / "outputs"

CMDB_CLASS_TO_SCAN_CLASS = {
    "cmdb_ci_ip_switch": "Switch",
    "cmdb_ci_switch": "Switch",
    "cmdb_ci_server": "Server",
    "cmdb_ci_linux_server": "Server",
    "cmdb_ci_win_server": "Server",
}

NAME_PREFIX_TO_SCAN_CLASS = {
    "PP-": "Patch Panel",
    "SW-": "Switch",
    "SRV-": "Server",
}

LOW_CONF = 0.5


def expected_class(device):
    cls = (device or {}).get("sys_class_name", "") if isinstance(device, dict) else ""
    if cls in CMDB_CLASS_TO_SCAN_CLASS:
        return CMDB_CLASS_TO_SCAN_CLASS[cls]
    name = (device or {}).get("name", "") if isinstance(device, dict) else ""
    for prefix, sc in NAME_PREFIX_TO_SCAN_CLASS.items():
        if name.startswith(prefix):
            return sc
    return cls or "?"


def u_from_name(name):
    m = re.search(r"[-_]U(\d{1,2})$", name or "", re.I)
    return int(m.group(1)) if m else None


def detections_at(scan, u):
    target = f"u{u:02d}"
    return [(d.get("class_name", "?"), float(d.get("confidence", 0)))
            for d in scan.get("devices", []) if target in d.get("units", [])]


def verify_device(device, scan):
    if not device:
        return {"status": "skip", "reason": "no device"}
    name = device.get("name", "?")
    u = u_from_name(name)
    exp = expected_class(device)
    if u is None:
        return {"name": name, "expected_class": exp, "status": "unknown",
                "reason": "no U position derivable from name"}
    dets = detections_at(scan, u)
    if not dets:
        return {"name": name, "u": u, "expected_class": exp, "status": "miss",
                "reason": f"scan saw nothing at U{u:02d}"}
    matches = [(c, conf) for c, conf in dets if c == exp]
    if matches:
        best = max(conf for _, conf in matches)
        return {"name": name, "u": u, "expected_class": exp, "status": "match",
                "confidence": round(best, 3),
                "low_confidence": best < LOW_CONF,
                "detections_at_u": [{"class": c, "conf": round(cf, 3)} for c, cf in dets]}
    return {"name": name, "u": u, "expected_class": exp, "status": "drift",
            "reason": f"expected {exp} at U{u:02d}, scan saw {', '.join(c for c, _ in dets)}",
            "detections_at_u": [{"class": c, "conf": round(cf, 3)} for c, cf in dets]}


def load_scan(rack_id):
    folder = DM_OUTPUTS / rack_id
    dmap = folder / "device_unit_map.json"
    meta = folder / "scan_meta.json"
    if not dmap.exists():
        raise FileNotFoundError(f"No scan for rack {rack_id} at {dmap}")
    with open(dmap) as f:
        scan = json.load(f)
    if meta.exists():
        with open(meta) as f:
            m = json.load(f)
        scan.setdefault("rackId", m.get("rackId"))
        scan.setdefault("scannedAt", m.get("timestamp"))
    return scan


def process(json_path):
    with open(json_path, encoding="utf-8") as f:
        ctx = json.load(f)

    inc = ctx.get("incident", {})
    inc_num = inc.get("number", json_path.stem)
    rack = ctx.get("rack") or {}
    rack_id = rack.get("u_racktrack_scan_id") or rack.get("rackId")
    if not rack_id:
        raise ValueError(f"No rack scan ID in payload {json_path}")

    scan = load_scan(rack_id)

    devices_to_check = []
    sw = ctx.get("switch")
    if sw:
        devices_to_check.append(("incident switch", sw))
    for d in ctx.get("mid_devices") or []:
        devices_to_check.append(("mid", d))
    far = ctx.get("far_end_device")
    if far:
        devices_to_check.append(("far end", far))

    results = []
    for role, dev in devices_to_check:
        v = verify_device(dev, scan)
        v["role"] = role
        results.append(v)

    verification = {
        "source": "racktrack-ingest",
        "incident": inc_num,
        "rackId": rack_id,
        "scan_time": scan.get("scannedAt"),
        "verified_at": datetime.utcnow().isoformat() + "Z",
        "results": results,
        "summary": {
            "total": len(results),
            "matches": sum(1 for r in results if r.get("status") == "match"),
            "low_confidence": sum(1 for r in results if r.get("low_confidence")),
            "drifts": sum(1 for r in results if r.get("status") == "drift"),
            "misses": sum(1 for r in results if r.get("status") == "miss"),
        },
    }

    out_json = json_path.with_suffix(".verification.json")
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(verification, f, indent=2)

    out_txt = json_path.with_suffix(".verification.txt")
    with open(out_txt, "w", encoding="utf-8") as f:
        f.write(format_text(verification, ctx))

    return verification, out_json, out_txt


def format_text(v, ctx):
    lines = []
    lines.append(f"RackTrack ingest verification — {v['incident']}")
    lines.append(f"Rack {v['rackId']}  scan {v.get('scan_time','?')}")
    lines.append(f"Verified at {v['verified_at']}")
    lines.append("")

    parsed = ctx.get("parsed") or {}
    if parsed:
        lines.append(f"Ticket context: port {parsed.get('port_number')} on {parsed.get('device_name')}")
        lines.append("")

    chain = ctx.get("cable_chain") or []
    if chain:
        lines.append("Cable chain from ticket:")
        for hop in chain:
            p = hop.get("port") or {}
            lines.append(f"  [{hop['hop']}] {p.get('name')}  ({hop.get('port_table')})")
        lines.append("")

    sym = {"match": "✓", "drift": "✗", "miss": "✗", "unknown": "?", "skip": "-"}
    lines.append("Device-level physical verification:")
    for r in v["results"]:
        s = sym.get(r.get("status"), "?")
        tag = f"⚠ low-conf" if r.get("low_confidence") else ""
        name = r.get("name", "?")
        u = r.get("u")
        exp = r.get("expected_class", "?")
        u_str = f"U{u:02d}" if isinstance(u, int) else "U??"
        extra = ""
        if r.get("status") == "match":
            extra = f"confirmed (conf {r.get('confidence')})"
        elif r.get("status") == "drift":
            extra = r.get("reason", "")
        elif r.get("status") == "miss":
            extra = r.get("reason", "")
        lines.append(f"  {s} [{r.get('role')}] {name} @ {u_str} — expected {exp}  {extra} {tag}".rstrip())

    s = v["summary"]
    lines.append("")
    lines.append(f"Summary: {s['matches']}/{s['total']} devices match  "
                 f"({s['drifts']} drifts, {s['misses']} misses, {s['low_confidence']} low-conf)")

    lines.append("")
    if s["drifts"] or s["misses"]:
        lines.append("CONCLUSION: Physical rack does not fully match CMDB for this incident path.")
        lines.append("Dispatch a technician with the printed cable chain for on-site verification.")
    else:
        lines.append("CONCLUSION: Every CMDB-expected device on this cable path is physically "
                     "present at the expected rack position. Incident is likely logical "
                     "(port config, VLAN, far-end service) rather than physical.")
    return "\n".join(lines)


def main(argv):
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0

    targets = []
    if argv[0] == "--all":
        for p in INBOX.glob("*.json"):
            if p.stem.endswith(".verification"):
                continue
            if (p.parent / (p.stem + ".verification.json")).exists():
                continue
            targets.append(p)
    else:
        p = INBOX / argv[0] if not argv[0].endswith(".json") else INBOX / argv[0]
        if not p.exists() and not argv[0].endswith(".json"):
            p = INBOX / (argv[0] + ".json")
        targets = [p]

    for path in targets:
        print(f"→ {path.name}")
        try:
            v, out_j, out_t = process(path)
        except Exception as e:
            print(f"  FAILED: {e}")
            continue
        s = v["summary"]
        print(f"  {s['matches']}/{s['total']} match  ({s['drifts']} drift, {s['misses']} miss, {s['low_confidence']} low-conf)")
        print(f"  {out_j.name}")
        print(f"  {out_t.name}")
    return 0


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    sys.exit(main(sys.argv[1:]))

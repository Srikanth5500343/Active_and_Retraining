"""
Reconciliation logic — compares CMDB expectation with physical scan reality.

Inputs:
  - incident: ServiceNow incident dict
  - primary_ci: the CI referenced by the incident (switch, server, patch panel...)
  - rack_ci: the parent rack CI (walked via cmdb_rel_ci)
  - rack_children: all CIs in the rack (audit scope)
  - scan: the RackTrack device_unit_map merged with scan_meta for this rack

The RackTrack scan identifies devices by visual class ('Switch', 'Patch Panel',
'Server', 'Closed Unit') and U position. It does NOT know device names — that's
the CMDB's job. Reconciliation = CMDB says 'SW-U10 (Switch) at U10', scan says
'Switch at U10', ✓ match. Drift = class disagreement at a U position.
"""
from datetime import datetime


CMDB_CLASS_TO_SCAN_CLASS = {
    "cmdb_ci_ip_switch": "Switch",
    "cmdb_ci_switch": "Switch",
    "cmdb_ci_patch_panel": "Patch Panel",
    "cmdb_ci_server": "Server",
    "cmdb_ci_linux_server": "Server",
    "cmdb_ci_win_server": "Server",
}

NAME_PREFIX_TO_SCAN_CLASS = {
    "PP-": "Patch Panel",
    "SW-": "Switch",
    "SRV-": "Server",
}

LOW_CONF_THRESHOLD = 0.5


def _expected_scan_class(ci: dict) -> str:
    """Map a CI to the scan class label it should match against.

    First tries sys_class_name (when the CMDB subclass is specific).
    Falls back to name prefix for generic classes like cmdb_ci_netgear,
    where Zurich PDI groups patch panels and other network gear together.
    """
    ci_class = ci.get("sys_class_name", "")
    if ci_class in CMDB_CLASS_TO_SCAN_CLASS:
        return CMDB_CLASS_TO_SCAN_CLASS[ci_class]
    name = ci.get("name", "") or ""
    for prefix, scan_class in NAME_PREFIX_TO_SCAN_CLASS.items():
        if name.startswith(prefix):
            return scan_class
    return ci_class or "?"


def _ci_u(ci: dict) -> int | None:
    """Extract the U position from a CI.

    Tries stored fields first (if the CMDB schema has a rack position column),
    then falls back to parsing the CI name — our naming convention embeds U
    position as the suffix, e.g. SW-U10 -> 10, PP-U12 -> 12.
    """
    import re
    for key in ("rack_unit_position", "u_position_in_rack"):
        val = ci.get(key)
        if val in (None, "", 0, "0"):
            continue
        try:
            return int(val)
        except (ValueError, TypeError):
            continue
    name = ci.get("name", "") or ""
    m = re.search(r"[-_]U(\d{1,2})$", name, re.I)
    if m:
        return int(m.group(1))
    return None


def _manufacturer(ci: dict) -> str:
    m = ci.get("manufacturer")
    if isinstance(m, dict):
        return m.get("display_value") or "Unknown"
    return str(m) if m else "Unknown"


def _format_timestamp(ts: str) -> str:
    if not ts:
        return "unknown time"
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        return dt.strftime("%Y-%m-%d %H:%M UTC")
    except ValueError:
        return ts


def _scan_detections_at(scan: dict, u: int) -> list[tuple[str, float]]:
    """Return [(class_name, confidence), ...] for all scan devices at the given U."""
    target = f"u{u:02d}"
    out = []
    for dev in scan.get("devices", []):
        units = dev.get("units", [])
        if target in units:
            out.append((dev.get("class_name", "?"), float(dev.get("confidence", 0))))
    return out


def _check_ci(ci: dict, scan: dict) -> tuple[str, str]:
    """Return (symbol, description) for a single CI against the scan.

    Symbols: ✓ match, ⚠ low-confidence match, ✗ mismatch, ? unknown/missing data.
    """
    expected = _expected_scan_class(ci)
    u = _ci_u(ci)
    if u is None:
        return "?", "no rack_unit_position set in CMDB"

    detections = _scan_detections_at(scan, u)
    if not detections:
        return "✗", f"expected {expected} at U{u:02d}, scan detected nothing"

    matches = [(c, conf) for c, conf in detections if c == expected]
    if matches:
        best_conf = max(conf for _, conf in matches)
        if best_conf < LOW_CONF_THRESHOLD:
            return "⚠", f"U{u:02d}: {expected} detected (low confidence {best_conf:.2f})"
        return "✓", f"U{u:02d}: {expected} confirmed (confidence {best_conf:.2f})"

    seen = ", ".join(f"{c} ({conf:.2f})" for c, conf in detections)
    return "✗", f"U{u:02d}: expected {expected}, scan saw {seen}"


def _format_rack_audit_line(ci: dict, scan: dict) -> tuple[str, int | None]:
    sym, desc = _check_ci(ci, scan)
    name = ci.get("name", "?")
    u = _ci_u(ci)
    u_str = f"U{u:02d}" if u is not None else "U??"
    # strip "Uxx: " prefix from desc since we're already showing it
    tail = desc.split(": ", 1)[-1] if desc.startswith(u_str + ":") else desc
    return f"  {sym} {u_str} {name} — {tail}", u


def reconcile(
    incident: dict,
    primary_ci: dict,
    rack_ci: dict,
    rack_children: list[dict],
    scan: dict,
) -> str:
    """Build the reconciliation work note."""
    primary_name = primary_ci.get("name", "UNKNOWN")
    primary_expected = _expected_scan_class(primary_ci)
    primary_u = _ci_u(primary_ci)
    rack_name = rack_ci.get("name", "UNKNOWN")
    mfr = _manufacturer(primary_ci)

    scan_id = scan.get("rackId", "?")
    scanned_at = _format_timestamp(scan.get("scannedAt", ""))
    n_detections = len(scan.get("devices", []))

    lines = []
    lines.append(f"RackTrack correlation for {incident.get('number', '?')}")
    lines.append("")
    lines.append(
        f"CMDB: {primary_name} ({mfr}, {primary_expected}) in {rack_name}"
        + (f" at U{primary_u:02d}" if primary_u is not None else "")
    )
    lines.append(f"Scan: {scan_id} ({scanned_at}, {n_detections} devices detected)")
    lines.append("")

    primary_sym, primary_desc = _check_ci(primary_ci, scan)
    lines.append(f"Physical verification of {primary_name}:")
    lines.append(f"  {primary_sym} {primary_desc}")
    lines.append("")

    lines.append("Rack inventory audit (CMDB ↔ scan):")
    children_sorted = sorted(
        rack_children,
        key=lambda c: -(_ci_u(c) if _ci_u(c) is not None else -1),
    )
    total = 0
    matched = 0
    for ci in children_sorted:
        line, u = _format_rack_audit_line(ci, scan)
        if u is None:
            continue
        lines.append(line)
        total += 1
        if line.startswith("  ✓") or line.startswith("  ⚠"):
            matched += 1
    lines.append("")
    lines.append(f"Summary: {matched}/{total} CMDB entries agree with physical scan")
    lines.append("")

    if primary_sym == "✓":
        lines.append(f"Suggested action: CMDB and physical rack agree on {primary_name}.")
        lines.append(
            "Incident is likely a logical/config issue — check interface state, "
            "VLAN, or far-end device. No physical action needed."
        )
    elif primary_sym == "⚠":
        lines.append(
            f"Suggested action: {primary_name} detected at expected U but low-confidence scan. "
            "Trigger a rescan (better lighting / angle) before dispatching hands-on."
        )
    elif primary_sym == "✗":
        lines.append(
            f"Suggested action: PHYSICAL DRIFT — {primary_name} does not match rack scan. "
            "Verify the device is actually installed where CMDB says, or update CMDB if moved."
        )
    else:
        lines.append(
            f"Suggested action: cannot verify {primary_name} — CMDB lacks rack position data. "
            "Set rack_unit_position on the CI and rerun."
        )

    return "\n".join(lines)

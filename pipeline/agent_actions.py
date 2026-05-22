"""
Phase 2 — Suggested-action templates.

Keyed by (failure_mode, device_role). Each template is a Python format
string. The agent picks one and fills it in. No generation, no LLM —
deterministic string substitution.

Lookup falls back from specific (mode, role) → (mode, "*") → ("*", "*").
"""

TEMPLATES = {
    # ── Port down ─────────────────────────────────────────────────────────
    ("port_down", "uplink"):
        "Walk to {rack} {u_str}, verify uplink cable on port {port} of {device}; "
        "check both ends + link LED. If LED is off on both sides, swap patch cable.",

    ("port_down", "access"):
        "Walk to {rack} {u_str}, verify cable on port {port} of {device}; "
        "check patch panel mapping. Reseat both ends, observe LED.",

    ("port_down", "management"):
        "Walk to {rack} {u_str}, verify management port {port} on {device}; "
        "this isolates remote access — restore quickly.",

    ("port_down", "*"):
        "Walk to {rack} {u_str}, verify cable on port {port} of {device}; "
        "check LED, reseat both ends.",

    # ── Cable issues ─────────────────────────────────────────────────────
    ("cable_swap", "*"):
        "Walk to {rack} {u_str}, replace patch cable on port {port} of {device}. "
        "After swap, clear interface counters and observe for 15 min.",

    ("flapping", "*"):
        "Walk to {rack} {u_str}, inspect port {port} of {device} for loose RJ45 "
        "or worn cable. Reseat or replace; monitor for re-flap.",

    # ── Slow link / errors ───────────────────────────────────────────────
    ("slow_link", "*"):
        "Walk to {rack} {u_str}, inspect cable on port {port} of {device} for "
        "kinks/EMI exposure. Verify autoneg / duplex on both ends.",

    ("crc_errors", "*"):
        "Walk to {rack} {u_str}, replace patch cable on port {port} of {device}. "
        "Re-route away from PDU/power runs if applicable. Clear counters.",

    # ── Device unreachable ───────────────────────────────────────────────
    ("device_unreachable", "*"):
        "Walk to {rack} {u_str}, verify {device} is powered and front LEDs are green. "
        "If dark: check PDU outlet, then PSU. If lit but unreachable: console in.",

    # ── PoE issues ───────────────────────────────────────────────────────
    ("poe_issue", "*"):
        "Walk to {rack} {u_str}, inspect powered device on port {port} of {device}. "
        "Check PoE budget on switch; reduce priority on other PoE ports if needed.",

    # ── Err-disable / security ───────────────────────────────────────────
    ("err_disabled", "*"):
        "Walk to {rack} {u_str}, identify device plugged into port {port} of {device} "
        "(triggered bpdu-guard / storm-control). Remove or reconfigure before clearing err-disable.",

    ("rogue_device", "*"):
        "Walk to {rack} {u_str}, physically inspect what is plugged into port {port} "
        "of {device}. Compare MAC against inventory; remove if unauthorized.",

    # ── VLAN / config ────────────────────────────────────────────────────
    ("config_change", "*"):
        "Port {port} on {device} ({rack} {u_str}) likely has misconfigured VLAN/ACL. "
        "Verify switchport config remotely first; physical visit only if unresolved.",

    # ── Hardware replace ─────────────────────────────────────────────────
    ("hardware_replace", "*"):
        "Walk to {rack} {u_str}, replace failed component on {device}. "
        "Have spare ready; coordinate maintenance window before pulling power.",

    # ── Generic fallback ─────────────────────────────────────────────────
    ("*", "*"):
        "Walk to {rack} {u_str} and physically verify port {port} on {device}. "
        "Check LED, cable seating, and downstream device.",
}


def get_template(failure_mode: str, device_role: str) -> str:
    """Return the best-matching template string for (mode, role)."""
    fm = failure_mode or "*"
    role = device_role or "*"
    for key in [(fm, role), (fm, "*"), ("*", "*")]:
        if key in TEMPLATES:
            return TEMPLATES[key]
    return TEMPLATES[("*", "*")]


def render(failure_mode: str, device_role: str, **fields) -> str:
    """Render a suggested-action string. Missing fields render as '?'."""
    template = get_template(failure_mode, device_role)
    # Provide sensible defaults so missing fields don't crash format().
    defaults = {
        "rack": "?", "u_str": "U??", "port": "?",
        "device": "?", "u_position": "??",
    }
    defaults.update({k: v for k, v in fields.items() if v is not None})
    if isinstance(defaults.get("u_position"), int):
        defaults["u_str"] = f"U{defaults['u_position']:02d}"
    try:
        return template.format(**defaults)
    except KeyError:
        return template  # fallback: return raw template if formatting fails

"""
RackTrack Intelligent Agent — zero-LLM, self-contained.

Adds the "brain" on top of poll.py + ingest.py:

  Phase 1 — extract_incident(): smarter extraction (patterns + fuzzy + word-to-num)
  Phase 2 — build_reasoning(): step-by-step reasoning chain with evidence + confidence
  Phase 3 — rank_and_cluster(): triage, batching, anomaly detection
  Phase 4 — auto_post_analysis(): close the loop, posts work notes to SN

No LLM, no paid services, no ML models. Pattern dictionaries, fuzzy matching,
arithmetic on a confidence score, and string-templated suggested actions.
"""
from __future__ import annotations

import hashlib
import json
import re
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable

try:
    from rapidfuzz import process as fuzz_process
    from rapidfuzz import fuzz
    _HAS_RAPIDFUZZ = True
except ImportError:  # graceful fallback
    _HAS_RAPIDFUZZ = False

from action_templates import render as render_action


HERE = Path(__file__).resolve().parent
POSTED_LOG = HERE / "posted.json"          # Phase 4 dedup state
UNMATCHED_LOG = HERE / "unmatched.log"     # Phase 1 telemetry


# ═══════════════════════════════════════════════════════════════════════════
# Phase 1 — SMARTER EXTRACTION
# ═══════════════════════════════════════════════════════════════════════════

# Pattern dictionary — keyword → failure_mode bucket.
# Each keyword has a weight; longer / more specific phrases score higher.
FAILURE_PATTERNS = {
    # phrase                           # (failure_mode, weight)
    "err-disabled":                    ("err_disabled",        0.95),
    "err disabled":                    ("err_disabled",        0.95),
    "bpdu-guard":                      ("err_disabled",        0.90),
    "bpdu guard":                      ("err_disabled",        0.90),
    "storm control":                   ("err_disabled",        0.85),

    "mac flap":                        ("rogue_device",        0.85),
    "rogue":                           ("rogue_device",        0.80),
    "unauthorized":                    ("rogue_device",        0.70),
    "unknown device":                  ("rogue_device",        0.70),

    "poe over-budget":                 ("poe_issue",           0.90),
    "poe over budget":                 ("poe_issue",           0.90),
    "poe":                             ("poe_issue",           0.40),
    "power cycling":                   ("poe_issue",           0.60),

    "crc error":                       ("crc_errors",          0.90),
    "crc errors":                      ("crc_errors",          0.90),
    "crc":                             ("crc_errors",          0.60),

    "flapping":                        ("flapping",            0.90),
    "flap":                            ("flapping",            0.70),
    "link bounce":                     ("flapping",            0.80),

    "speed mismatch":                  ("slow_link",           0.90),
    "duplex mismatch":                 ("slow_link",           0.90),
    "auto-negotiated":                 ("slow_link",           0.60),
    "slow":                            ("slow_link",           0.50),
    "throughput":                      ("slow_link",           0.50),

    "wrong vlan":                      ("config_change",       0.85),
    "vlan":                            ("config_change",       0.50),

    "unreachable":                     ("device_unreachable",  0.85),
    "cannot be reached":               ("device_unreachable",  0.85),
    "ping fails":                      ("device_unreachable",  0.80),
    "no response":                     ("device_unreachable",  0.70),

    "replace":                         ("hardware_replace",    0.50),
    "swap cable":                      ("cable_swap",          0.80),
    "replace cable":                   ("cable_swap",          0.85),
    "patch cable":                     ("cable_swap",          0.50),

    # Port down — keep last because it's a catch-all for many things above
    "link down":                       ("port_down",           0.90),
    "port down":                       ("port_down",           0.85),
    "no link":                         ("port_down",           0.80),
    "down":                            ("port_down",           0.50),
    "not working":                     ("port_down",           0.60),
    "oper-down":                       ("port_down",           0.85),
    "oper=down":                       ("port_down",           0.85),
    "dark":                            ("port_down",           0.40),
}

# Device role inference from text or interface alias
ROLE_PATTERNS = {
    "uplink":     ("uplink", 0.85),
    "trunk":      ("uplink", 0.70),
    "management": ("management", 0.85),
    "mgmt":       ("management", 0.80),
    "console":    ("management", 0.75),
    "access":     ("access", 0.70),
    "user port":  ("access", 0.65),
}

URGENCY_PATTERNS = {
    "user complaint":       ("user_reported",    0.85),
    "helpdesk ticket":      ("user_reported",    0.85),
    "user reports":         ("user_reported",    0.80),
    "monitoring":           ("monitoring_alert", 0.85),
    "monitoring reports":   ("monitoring_alert", 0.90),
    "security monitoring":  ("monitoring_alert", 0.85),
    "scheduled":            ("scheduled",        0.80),
    "maintenance":          ("scheduled",        0.70),
}

# Word-to-number expansion — "the third port" → 3.
WORD_TO_NUM = {
    "first": 1, "1st": 1,
    "second": 2, "2nd": 2,
    "third": 3, "3rd": 3,
    "fourth": 4, "4th": 4,
    "fifth": 5, "5th": 5,
    "sixth": 6, "6th": 6,
    "seventh": 7, "7th": 7,
    "eighth": 8, "8th": 8,
    "ninth": 9, "9th": 9,
    "tenth": 10, "10th": 10,
    "eleventh": 11, "twelfth": 12,
    "thirteenth": 13, "fourteenth": 14,
    "fifteenth": 15, "sixteenth": 16,
    "twentieth": 20,
}

WORD_NUM_RE = re.compile(
    r"\b(" + "|".join(re.escape(k) for k in WORD_TO_NUM) + r")\s+(?:port|uplink|interface)\b",
    re.I,
)
PORT_NUM_RE = re.compile(r"\bport[\s#:]*(\d+)\b", re.I)
INTERFACE_RE = re.compile(r"\bGi\d+/\d+/(\d+)\b", re.I)


def _extract_port_number(text: str) -> tuple[int | None, str | None, float]:
    """Returns (port, source, weight). source ∈ {regex, word_num, interface, None}."""
    text = text or ""

    # Try regex: "port 12", "Port#12", "port: 12"
    m = PORT_NUM_RE.search(text)
    if m:
        return int(m.group(1)), "regex:port_num", 0.95

    # Try interface notation: Gi1/0/12 → 12
    m = INTERFACE_RE.search(text)
    if m:
        return int(m.group(1)), "regex:interface", 0.90

    # Try word-to-number: "the third port"
    m = WORD_NUM_RE.search(text)
    if m:
        word = m.group(1).lower()
        return WORD_TO_NUM[word], f"word_num:{word}->{WORD_TO_NUM[word]}", 0.75

    return None, None, 0.0


_DEVICE_RE = re.compile(r"\b((?:SW|SRV|PP|RTR|GW|FW)-[A-Z]*U?\d{1,3})\b", re.I)


def _extract_device(text: str, cmdb_device_names: list[str] | None = None) -> tuple[str | None, str | None, float]:
    """Returns (device_name, source, weight)."""
    text = text or ""

    # Direct regex match
    m = _DEVICE_RE.search(text)
    if m:
        return m.group(1).upper(), "regex:device_pattern", 0.95

    # Fuzzy match against CMDB device list
    if _HAS_RAPIDFUZZ and cmdb_device_names:
        # Try matching the whole text first
        result = fuzz_process.extractOne(
            text, cmdb_device_names,
            scorer=fuzz.partial_ratio, score_cutoff=85,
        )
        if result:
            match, score, _ = result
            return match, f"fuzzy:{match}({score:.0f})", min(0.85, score / 100)

    return None, None, 0.0


def _hits(text: str, patterns: dict) -> list[tuple[str, str, float]]:
    """Find all keyword hits. Returns [(phrase, bucket, weight)]."""
    text_lower = (text or "").lower()
    out = []
    for phrase, (bucket, weight) in patterns.items():
        if phrase in text_lower:
            out.append((phrase, bucket, weight))
    return out


def _pick_top(hits: list[tuple[str, str, float]], default=("other", 0.0), default_signal=""):
    """From [(phrase, bucket, weight)], return (top_bucket, top_weight, signals)."""
    if not hits:
        return default[0], default[1], ([default_signal] if default_signal else [])
    # Aggregate weight per bucket so multiple weak hits can beat one strong hit
    by_bucket: dict[str, list[tuple[str, float]]] = {}
    for phrase, bucket, weight in hits:
        by_bucket.setdefault(bucket, []).append((phrase, weight))
    best_bucket = max(by_bucket, key=lambda b: max(w for _, w in by_bucket[b]))
    best_weight = max(w for _, w in by_bucket[best_bucket])
    signals = [f"keyword:{phrase}" for phrase, _ in by_bucket[best_bucket]]
    return best_bucket, best_weight, signals


def extract_incident(text: str, cmdb_device_list: list[str] | None = None) -> dict:
    """Phase 1 — extract structured fields from messy ticket text.

    Returns a dict matching the plan spec:
        failure_mode, affected_device, affected_port, affected_role,
        urgency_signal, one_line_summary, confidence, signals_used
    """
    signals: list[str] = []
    weights: list[float] = []

    # ── failure mode ──────────────────────────────────────────────────────
    failure_mode, fm_weight, fm_signals = _pick_top(
        _hits(text, FAILURE_PATTERNS),
        default=("other", 0.2),
        default_signal="default:other",
    )
    signals.extend(fm_signals)
    if fm_weight > 0:
        weights.append(fm_weight)

    # ── device ────────────────────────────────────────────────────────────
    device, device_src, device_w = _extract_device(text, cmdb_device_list)
    if device_src:
        signals.append(device_src)
        weights.append(device_w)

    # ── port ──────────────────────────────────────────────────────────────
    port, port_src, port_w = _extract_port_number(text)
    if port_src:
        signals.append(port_src)
        weights.append(port_w)

    # ── role ──────────────────────────────────────────────────────────────
    role, role_weight, role_signals = _pick_top(
        _hits(text, ROLE_PATTERNS),
        default=("unknown", 0.0),
    )
    if role_signals:
        signals.extend(role_signals)
        if role_weight > 0:
            weights.append(role_weight * 0.5)  # role is secondary signal

    # ── urgency ───────────────────────────────────────────────────────────
    urgency, urg_weight, urg_signals = _pick_top(
        _hits(text, URGENCY_PATTERNS),
        default=("monitoring_alert", 0.3),
    )
    signals.extend(urg_signals)
    if urg_weight > 0:
        weights.append(urg_weight * 0.4)  # urgency is tertiary

    # ── confidence ────────────────────────────────────────────────────────
    # Use a soft sum capped at 1.0. Multi-signal agreement raises confidence;
    # a single weak signal stays around 0.4 → "needs human review".
    confidence = min(1.0, sum(weights) / 2.5)

    # Penalize when we have no device or no port — without those, the agent
    # can't actually direct a technician anywhere.
    if not device:
        confidence *= 0.6
    if port is None and failure_mode != "device_unreachable":
        confidence *= 0.7

    # ── one-line summary (templated, not generated) ───────────────────────
    fm_human = failure_mode.replace("_", " ")
    parts = []
    if device:
        parts.append(device)
    if port is not None:
        parts.append(f"port {port}")
    if role != "unknown":
        parts.append(f"({role})")
    parts.append(fm_human)
    summary = " ".join(parts).strip() or "incident with no extractable details"

    result = {
        "failure_mode":      failure_mode,
        "affected_device":   device,
        "affected_port":     port,
        "affected_role":     role,
        "urgency_signal":    urgency,
        "one_line_summary":  summary,
        "confidence":        round(confidence, 3),
        "signals_used":      signals,
    }

    # Log misses for weekly review
    if not device and not port and failure_mode == "other":
        try:
            with open(UNMATCHED_LOG, "a", encoding="utf-8") as f:
                f.write(f"{datetime.utcnow().isoformat()}Z | {text[:200]}\n")
        except Exception:
            pass

    return result


# ═══════════════════════════════════════════════════════════════════════════
# Phase 2 — REASONING CHAIN
# ═══════════════════════════════════════════════════════════════════════════

def _step(name: str, evidence: str, confidence: float) -> dict:
    return {"step": name, "evidence": evidence, "confidence": round(confidence, 2)}


def build_reasoning(
    ticket: dict,
    extracted: dict,
    cmdb: dict | None = None,
    last_scan: dict | None = None,
) -> list[dict]:
    """Build a step-by-step reasoning chain. Each step is structured, not prose."""
    steps: list[dict] = []

    # Step 1 — parsed incident
    sig_summary = ", ".join(extracted.get("signals_used", [])[:3])
    steps.append(_step(
        "parsed_incident",
        f"Failure mode '{extracted.get('failure_mode')}' via [{sig_summary}]; "
        f"device={extracted.get('affected_device')}, port={extracted.get('affected_port')}",
        extracted.get("confidence", 0.0),
    ))

    # Step 2 — CMDB lookup
    cmdb = cmdb or {}
    if cmdb.get("mgmt_ip") or cmdb.get("model"):
        ev_parts = []
        if cmdb.get("sys_class_name"):
            ev_parts.append(cmdb["sys_class_name"])
        if cmdb.get("model"):
            ev_parts.append(cmdb["model"])
        if cmdb.get("mgmt_ip"):
            ev_parts.append(f"mgmt={cmdb['mgmt_ip']}")
        if cmdb.get("interface_alias"):
            ev_parts.append(f"if={cmdb['interface_alias']}")
        steps.append(_step(
            "looked_up_cmdb",
            "; ".join(ev_parts) or "CMDB record found",
            1.0,
        ))
    else:
        steps.append(_step(
            "looked_up_cmdb",
            "No matching CMDB record found",
            0.3,
        ))

    # Step 3 — rack lookup
    if cmdb.get("rack_name"):
        u_str = f"U{cmdb['u_position']:02d}" if isinstance(cmdb.get("u_position"), int) else "U??"
        steps.append(_step(
            "found_rack",
            f"Rack {cmdb['rack_name']} at {u_str}; scan ID {cmdb.get('rack_scan_id') or 'n/a'}",
            1.0,
        ))

    # Step 4 — checked last scan
    if last_scan:
        scan_time = last_scan.get("scannedAt") or last_scan.get("scan_time") or "unknown time"
        # Look for the target device in the scan
        u = cmdb.get("u_position")
        observed = None
        if u is not None:
            for d in last_scan.get("devices", []) or []:
                if f"u{u:02d}" in (d.get("units") or []):
                    observed = d.get("class_name")
                    break
        steps.append(_step(
            "checked_last_scan",
            f"Last scan {scan_time}: observed {observed or 'nothing'} at "
            f"U{u:02d}" if isinstance(u, int) else f"Last scan {scan_time}",
            0.9 if observed else 0.5,
        ))

        # Step 5 — drift detection (only if both CMDB and scan have an observation)
        expected_class = _cmdb_to_scan_class(cmdb.get("sys_class_name"), extracted.get("affected_device"))
        if observed and expected_class and observed != expected_class:
            steps.append(_step(
                "detected_drift",
                f"CMDB expects {expected_class} at U{u:02d}; scan saw {observed} — drift detected",
                0.95,
            ))
        elif observed and expected_class and observed == expected_class:
            steps.append(_step(
                "verified_no_drift",
                f"CMDB expects {expected_class} at U{u:02d}; scan confirms — no drift",
                0.95,
            ))

    # Step 6 — suggested action (always last)
    steps.append(_step(
        "suggested_action",
        render_action(
            extracted.get("failure_mode") or "other",
            extracted.get("affected_role") or "*",
            rack=cmdb.get("rack_name") or "?",
            u_position=cmdb.get("u_position"),
            port=extracted.get("affected_port"),
            device=extracted.get("affected_device") or "?",
        ),
        0.7,
    ))

    return steps


_CMDB_TO_SCAN = {
    "cmdb_ci_ip_switch": "Switch",
    "cmdb_ci_switch":    "Switch",
    "cmdb_ci_server":    "Server",
    "cmdb_ci_linux_server": "Server",
    "cmdb_ci_win_server":   "Server",
}

def _cmdb_to_scan_class(sys_class_name: str | None, device_name: str | None) -> str | None:
    if sys_class_name and sys_class_name in _CMDB_TO_SCAN:
        return _CMDB_TO_SCAN[sys_class_name]
    if device_name:
        if device_name.startswith("SW-"):  return "Switch"
        if device_name.startswith("PP-"):  return "Patch Panel"
        if device_name.startswith("SRV-"): return "Server"
    return None


# ═══════════════════════════════════════════════════════════════════════════
# Phase 3 — TRIAGE, BATCHING, ANOMALY DETECTION
# ═══════════════════════════════════════════════════════════════════════════

def _priority_int(p) -> int:
    """'1 - Critical' → 1; 1 → 1; None → 5."""
    if p is None:
        return 5
    if isinstance(p, int):
        return p
    m = re.match(r"\s*(\d+)", str(p))
    return int(m.group(1)) if m else 5


def _age_hours(opened_at: str | None) -> float:
    if not opened_at:
        return 0.0
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%SZ"):
        try:
            dt = datetime.strptime(opened_at, fmt).replace(tzinfo=timezone.utc)
            return max(0.0, (datetime.now(timezone.utc) - dt).total_seconds() / 3600)
        except ValueError:
            continue
    return 0.0


def _score(ticket: dict, batch_size: int, has_anomaly: bool, has_scan: bool) -> float:
    """Triage score — higher = sooner."""
    priority = _priority_int(ticket.get("priority"))
    # Priority 1 → +40, priority 5 → +8
    score = (6 - priority) * 8
    score += min(_age_hours(ticket.get("opened_at")), 20)  # +1/hr capped at +20
    if batch_size >= 2:
        score += 15
    if has_scan:
        score += 10
    if has_anomaly:
        score += 25
    return round(score, 1)


def rank_and_cluster(tickets: list[dict], scan_history: dict | None = None) -> dict:
    """Phase 3 — rank tickets, group same-rack batches, surface anomalies.

    Each ticket must already have an 'extracted' and 'reasoning' field populated
    (done by ticket_record() → extract_incident() in the modified poll.py).
    """
    scan_history = scan_history or {}
    ranked: list[dict] = []
    needs_review: list[dict] = []
    anomalies: list[dict] = []

    # ── Group by rack for batching ────────────────────────────────────────
    by_rack: dict[str, list[dict]] = {}
    for t in tickets:
        rack = (t.get("cmdb") or {}).get("rack_name")
        if rack:
            by_rack.setdefault(rack, []).append(t)

    # Time-window correlation: only batch if tickets are within 1h of each other
    batches: list[dict] = []
    for rack, rack_tickets in by_rack.items():
        if len(rack_tickets) < 2:
            continue
        # Sort by opened_at and check time spread
        rack_tickets_sorted = sorted(rack_tickets, key=lambda t: t.get("opened_at") or "")
        ages = [_age_hours(t.get("opened_at")) for t in rack_tickets_sorted]
        if max(ages) - min(ages) <= 1.0:  # all within 1h window
            # Look for a shared root-cause hint from common failure modes
            modes = [t.get("extracted", {}).get("failure_mode") for t in rack_tickets_sorted]
            mode_counts: dict[str, int] = {}
            for m in modes:
                if m:
                    mode_counts[m] = mode_counts.get(m, 0) + 1
            dominant = max(mode_counts, key=mode_counts.get) if mode_counts else None
            hint = (
                f"All {len(rack_tickets_sorted)} mention {dominant} on devices in "
                f"same rack within {int((max(ages)-min(ages))*60)}min — possible shared event"
                if dominant else f"{len(rack_tickets_sorted)} tickets in same rack within 1h"
            )
            batches.append({
                "rack": rack,
                "incident_count": len(rack_tickets_sorted),
                "shared_root_cause_hint": hint,
                "tickets": [t.get("incident_number") for t in rack_tickets_sorted],
            })

    # ── Anomaly detection (rack drift from reasoning chain) ───────────────
    drift_by_rack: dict[str, list[str]] = {}
    for t in tickets:
        for step in t.get("reasoning") or []:
            if step.get("step") == "detected_drift":
                rack = (t.get("cmdb") or {}).get("rack_name") or "?"
                drift_by_rack.setdefault(rack, []).append(t.get("incident_number"))
    for rack, incs in drift_by_rack.items():
        anomalies.append({
            "type": "rack_drift",
            "rack": rack,
            "evidence": f"CMDB vs. last scan disagree at this rack — flagged on {len(incs)} ticket(s)",
            "tickets_affected": incs,
        })

    # ── Score each ticket and split into buckets ──────────────────────────
    drift_incidents = {inc for incs in drift_by_rack.values() for inc in incs}

    for t in tickets:
        ext = t.get("extracted") or {}
        confidence = ext.get("confidence", 0.0)

        if confidence < 0.4:
            needs_review.append({
                "incident_number": t.get("incident_number"),
                "reason": "extraction confidence below 0.4",
                "confidence": confidence,
                "summary": ext.get("one_line_summary"),
            })
            continue

        rack = (t.get("cmdb") or {}).get("rack_name")
        batch_size = len(by_rack.get(rack, [])) if rack else 0
        has_anomaly = t.get("incident_number") in drift_incidents
        has_scan = bool((t.get("cmdb") or {}).get("rack_scan_id"))

        t_copy = dict(t)
        t_copy["agent_score"] = _score(t, batch_size, has_anomaly, has_scan)
        ranked.append(t_copy)

    ranked.sort(key=lambda r: r.get("agent_score", 0), reverse=True)

    return {
        "ranked": ranked,
        "batches": batches,
        "anomalies": anomalies,
        "needs_human_review": needs_review,
        "top": ranked[0] if ranked else None,
    }


# ═══════════════════════════════════════════════════════════════════════════
# Phase 4 — AUTO-POST WORK NOTES
# ═══════════════════════════════════════════════════════════════════════════

POST_CONFIDENCE_FLOOR = 0.5
POST_RATE_LIMIT_HOURS = 24


def _load_posted() -> dict:
    if not POSTED_LOG.exists():
        return {}
    try:
        with open(POSTED_LOG, encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return {}


def _save_posted(state: dict) -> None:
    try:
        with open(POSTED_LOG, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=2)
    except OSError as e:
        print(f"[agent] could not write {POSTED_LOG}: {e}")


def _analysis_hash(extracted: dict, reasoning: list[dict]) -> str:
    """Stable hash of the agent's conclusion. Re-post only when this changes."""
    blob = json.dumps({
        "failure_mode":    extracted.get("failure_mode"),
        "device":          extracted.get("affected_device"),
        "port":            extracted.get("affected_port"),
        "confidence_bin":  round(extracted.get("confidence", 0) * 10) / 10,
        "drift":           any(s.get("step") == "detected_drift" for s in reasoning or []),
    }, sort_keys=True)
    return hashlib.sha256(blob.encode()).hexdigest()[:16]


def _format_work_note(ticket: dict, related: list[str] | None = None) -> str:
    """Build the work-note text. Templated, not generated."""
    ext      = ticket.get("extracted") or {}
    reasoning = ticket.get("reasoning") or []
    cmdb     = ticket.get("cmdb") or {}

    lines = []
    lines.append("RackTrack Agent Analysis — auto-generated")
    lines.append("")
    lines.append(f"Incident: {ext.get('one_line_summary', 'n/a')}")
    lines.append(f"Confidence: {ext.get('confidence', 0)}")
    lines.append(f"Signals: {', '.join(ext.get('signals_used', [])) or 'none'}")
    lines.append("")

    lines.append("Reasoning:")
    for i, step in enumerate(reasoning, 1):
        lines.append(f"  {i}. [{step['step']}] {step['evidence']}  (conf {step['confidence']})")
    lines.append("")

    # The last reasoning step is "suggested_action" — pull it out for emphasis
    action_step = next((s for s in reasoning if s["step"] == "suggested_action"), None)
    if action_step:
        lines.append("Suggested action:")
        lines.append(f"  {action_step['evidence']}")
        lines.append("")

    if related:
        lines.append(f"Related incidents in same rack: {', '.join(related)}")

    return "\n".join(lines)


def auto_post_analysis(ticket: dict, sn_client, related_in_batch: list[str] | None = None) -> dict:
    """Phase 4 — post a work note back to ServiceNow, with guards.

    Returns dict with status: 'posted' | 'skipped_low_confidence' |
    'skipped_no_change' | 'skipped_rate_limit' | 'error'.
    """
    inc_num = ticket.get("incident_number")
    sys_id  = ticket.get("sys_id")
    ext     = ticket.get("extracted") or {}
    reasoning = ticket.get("reasoning") or []
    confidence = ext.get("confidence", 0.0)

    if not sys_id:
        return {"status": "error", "reason": "no sys_id on ticket"}

    if confidence < POST_CONFIDENCE_FLOOR:
        return {"status": "skipped_low_confidence", "confidence": confidence}

    posted = _load_posted()
    prev = posted.get(inc_num) or {}
    cur_hash = _analysis_hash(ext, reasoning)

    if prev.get("hash") == cur_hash:
        return {"status": "skipped_no_change", "hash": cur_hash}

    last_posted_iso = prev.get("posted_at")
    if last_posted_iso:
        try:
            last_dt = datetime.fromisoformat(last_posted_iso.replace("Z", "+00:00"))
            if datetime.now(timezone.utc) - last_dt < timedelta(hours=POST_RATE_LIMIT_HOURS):
                return {"status": "skipped_rate_limit",
                        "last_posted": last_posted_iso}
        except (ValueError, TypeError):
            pass

    note_text = _format_work_note(ticket, related=related_in_batch)
    try:
        sn_client.add_work_note(sys_id, note_text)
    except Exception as e:
        return {"status": "error", "reason": str(e)}

    posted[inc_num] = {
        "hash":      cur_hash,
        "posted_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "confidence": confidence,
    }
    _save_posted(posted)
    return {"status": "posted", "hash": cur_hash}

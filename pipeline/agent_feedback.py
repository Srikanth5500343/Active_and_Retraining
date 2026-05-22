"""
Plan 5 — Learn from what worked.

When a ticket gets resolved in ServiceNow, the agent reads the resolution notes,
compares them to its original prediction, and tracks accuracy over time.

Scoreboard output:
  - Total predictions vs correct
  - Per-pattern accuracy (which failure_mode keywords work, which mislead)
  - Confidence calibration (are high-confidence predictions actually right?)

State (feedback_state.json) lives under outputs/agent_state/ — outside the
pipeline package so it survives reinstalls and is co-located with the
agent's posted.json / unmatched.log.
"""
from __future__ import annotations

import json
import os
import re
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from pipeline.agent import extract_incident, FAILURE_PATTERNS

_REPO_ROOT = Path(__file__).resolve().parent.parent
_STATE_DIR = Path(os.environ.get("RACKTRACK_AGENT_STATE_DIR", _REPO_ROOT / "outputs" / "agent_state"))
_STATE_DIR.mkdir(parents=True, exist_ok=True)
STATE_FILE = _STATE_DIR / "feedback_state.json"


# ── Resolution keyword → failure_mode mapping (mirrors agent.py patterns) ──
RESOLUTION_KEYWORDS = {
    "replaced cable":      "cable_swap",
    "swap cable":          "cable_swap",
    "new cable":           "cable_swap",
    "reseated":            "port_down",
    "reseat":              "port_down",
    "link restored":       "port_down",
    "port came back":      "port_down",
    "bouncing":            "flapping",
    "flapping":            "flapping",
    "stopped flapping":    "flapping",
    "crc":                 "crc_errors",
    "crc cleared":         "crc_errors",
    "err-disable":         "err_disabled",
    "errdisable":          "err_disabled",
    "bpdu":                "err_disabled",
    "rogue":               "rogue_device",
    "unauthorized":        "rogue_device",
    "removed device":      "rogue_device",
    "poe":                 "poe_issue",
    "power budget":        "poe_issue",
    "speed mismatch":      "slow_link",
    "duplex":              "slow_link",
    "auto-negotiate":      "slow_link",
    "vlan":                "config_change",
    "config":              "config_change",
    "misconfigured":       "config_change",
    "unreachable":         "device_unreachable",
    "power cycled":        "device_unreachable",
    "psu":                 "hardware_replace",
    "replaced":            "hardware_replace",
    "firmware":            "hardware_replace",
}


def _load_state() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    return {
        "predictions": {},       # inc_number -> prediction record
        "outcomes": {},          # inc_number -> outcome record
        "pattern_stats": {},     # failure_mode -> {correct, incorrect, total}
        "signal_stats": {},      # signal_keyword -> {correct, incorrect}
        "monthly_stats": {},     # "YYYY-MM" -> {correct, total}
        "calibration": {},       # confidence_bin -> {correct, total}
    }


def _save_state(state: dict) -> None:
    STATE_FILE.write_text(json.dumps(state, indent=2, default=str), encoding="utf-8")


def _infer_actual_mode(resolution_text: str) -> str | None:
    """Infer the actual failure mode from resolution/close notes."""
    text_lower = (resolution_text or "").lower()
    hits = []
    for phrase, mode in RESOLUTION_KEYWORDS.items():
        if phrase in text_lower:
            hits.append((phrase, mode, len(phrase)))
    if not hits:
        return None
    # Longest match wins
    return max(hits, key=lambda h: h[2])[1]


def record_prediction(incident_number: str, extracted: dict) -> None:
    """Store the agent's prediction for a ticket before it's resolved."""
    state = _load_state()
    state["predictions"][incident_number] = {
        "failure_mode": extracted.get("failure_mode"),
        "confidence": extracted.get("confidence", 0.0),
        "signals_used": extracted.get("signals_used", []),
        "affected_device": extracted.get("affected_device"),
        "affected_port": extracted.get("affected_port"),
        "predicted_at": datetime.now(timezone.utc).isoformat(),
    }
    _save_state(state)


def evaluate_resolution(incident_number: str, resolution_notes: str,
                        close_notes: str = "") -> dict:
    """Compare the agent's prediction to the actual resolution.

    Returns:
        {
            "incident_number": ...,
            "predicted_mode": ...,
            "actual_mode": ...,
            "correct": bool,
            "confidence_was": float,
            "signals_that_contributed": [...],
        }
    """
    state = _load_state()
    pred = state["predictions"].get(incident_number)
    if not pred:
        return {"incident_number": incident_number, "error": "no prediction recorded"}

    combined_text = f"{resolution_notes or ''} {close_notes or ''}"
    actual_mode = _infer_actual_mode(combined_text)

    if actual_mode is None:
        return {
            "incident_number": incident_number,
            "predicted_mode": pred["failure_mode"],
            "actual_mode": None,
            "correct": None,
            "note": "could not infer actual failure mode from resolution text",
        }

    correct = pred["failure_mode"] == actual_mode
    predicted_conf = pred.get("confidence", 0.0)
    month_key = datetime.now(timezone.utc).strftime("%Y-%m")

    # Update pattern stats
    pm = pred["failure_mode"]
    if pm not in state["pattern_stats"]:
        state["pattern_stats"][pm] = {"correct": 0, "incorrect": 0, "total": 0}
    state["pattern_stats"][pm]["total"] += 1
    if correct:
        state["pattern_stats"][pm]["correct"] += 1
    else:
        state["pattern_stats"][pm]["incorrect"] += 1

    # Update signal stats
    for sig in pred.get("signals_used", []):
        keyword = sig.split(":")[-1] if ":" in sig else sig
        if keyword not in state["signal_stats"]:
            state["signal_stats"][keyword] = {"correct": 0, "incorrect": 0}
        if correct:
            state["signal_stats"][keyword]["correct"] += 1
        else:
            state["signal_stats"][keyword]["incorrect"] += 1

    # Update monthly stats
    if month_key not in state["monthly_stats"]:
        state["monthly_stats"][month_key] = {"correct": 0, "total": 0}
    state["monthly_stats"][month_key]["total"] += 1
    if correct:
        state["monthly_stats"][month_key]["correct"] += 1

    # Update calibration buckets (0.0-0.1, 0.1-0.2, ..., 0.9-1.0)
    conf_bin = f"{int(predicted_conf * 10) / 10:.1f}"
    if conf_bin not in state["calibration"]:
        state["calibration"][conf_bin] = {"correct": 0, "total": 0}
    state["calibration"][conf_bin]["total"] += 1
    if correct:
        state["calibration"][conf_bin]["correct"] += 1

    # Store outcome
    state["outcomes"][incident_number] = {
        "actual_mode": actual_mode,
        "correct": correct,
        "resolution_text": combined_text[:500],
        "evaluated_at": datetime.now(timezone.utc).isoformat(),
    }

    _save_state(state)

    return {
        "incident_number": incident_number,
        "predicted_mode": pred["failure_mode"],
        "actual_mode": actual_mode,
        "correct": correct,
        "confidence_was": predicted_conf,
        "signals_that_contributed": pred.get("signals_used", []),
    }


def process_resolved_incidents(sn_base: str, sn_auth: tuple,
                               sn_headers: dict, limit: int = 50) -> list[dict]:
    """Fetch recently resolved incidents from ServiceNow and evaluate each.

    Returns a list of evaluation results.
    """
    import requests

    state = _load_state()
    already_evaluated = set(state.get("outcomes", {}).keys())

    # Fetch resolved network incidents
    try:
        r = requests.get(
            f"{sn_base}/table/incident",
            params={
                "sysparm_query": (
                    "state=6^ORstate=7^category=network"
                    "^ORDERBYDESCresolved_at"
                ),
                "sysparm_fields": (
                    "sys_id,number,short_description,description,"
                    "close_notes,close_code,resolved_at,priority"
                ),
                "sysparm_display_value": "true",
                "sysparm_limit": limit,
            },
            auth=sn_auth, headers=sn_headers, timeout=20,
        )
        r.raise_for_status()
        incidents = r.json().get("result", [])
    except Exception as e:
        return [{"error": f"ServiceNow fetch failed: {e}"}]

    results = []
    for inc in incidents:
        inc_num = inc.get("number")
        if not inc_num or inc_num in already_evaluated:
            continue

        # If we don't have a prediction, create one retroactively from the text
        if inc_num not in state["predictions"]:
            text = f"{inc.get('short_description', '')} {inc.get('description', '')}"
            extracted = extract_incident(text)
            record_prediction(inc_num, extracted)
            state = _load_state()  # reload after write

        close_notes = inc.get("close_notes", "")
        result = evaluate_resolution(inc_num, close_notes)
        results.append(result)

    return results


def get_scoreboard() -> dict:
    """Build the scoreboard summary for the UI.

    Returns:
        {
            "total_evaluated": int,
            "total_correct": int,
            "accuracy_pct": float,
            "monthly": [{month, correct, total, accuracy_pct}, ...],
            "patterns_that_worked": [{pattern, accuracy_pct, count}, ...],
            "patterns_that_misled": [{pattern, accuracy_pct, count}, ...],
            "signal_leaderboard": [{signal, correct, incorrect, accuracy_pct}, ...],
            "calibration": [{bin, correct, total, accuracy_pct}, ...],
        }
    """
    state = _load_state()

    total_correct = sum(
        1 for o in state.get("outcomes", {}).values()
        if o.get("correct") is True
    )
    total_evaluated = sum(
        1 for o in state.get("outcomes", {}).values()
        if o.get("correct") is not None
    )

    # Monthly breakdown
    monthly = []
    for month, stats in sorted(state.get("monthly_stats", {}).items()):
        t = stats["total"]
        c = stats["correct"]
        monthly.append({
            "month": month,
            "correct": c,
            "total": t,
            "accuracy_pct": round(c / t * 100, 1) if t > 0 else 0,
        })

    # Pattern accuracy — split into worked vs misled
    worked = []
    misled = []
    for pattern, stats in state.get("pattern_stats", {}).items():
        t = stats["total"]
        if t == 0:
            continue
        acc = round(stats["correct"] / t * 100, 1)
        entry = {"pattern": pattern, "accuracy_pct": acc, "count": t}
        if acc >= 60:
            worked.append(entry)
        else:
            misled.append(entry)
    worked.sort(key=lambda x: -x["accuracy_pct"])
    misled.sort(key=lambda x: x["accuracy_pct"])

    # Signal leaderboard
    signal_board = []
    for sig, stats in state.get("signal_stats", {}).items():
        c = stats["correct"]
        ic = stats["incorrect"]
        t = c + ic
        if t == 0:
            continue
        signal_board.append({
            "signal": sig,
            "correct": c,
            "incorrect": ic,
            "accuracy_pct": round(c / t * 100, 1),
        })
    signal_board.sort(key=lambda x: -x["accuracy_pct"])

    # Calibration
    calibration = []
    for bin_label, stats in sorted(state.get("calibration", {}).items()):
        t = stats["total"]
        c = stats["correct"]
        calibration.append({
            "bin": bin_label,
            "correct": c,
            "total": t,
            "accuracy_pct": round(c / t * 100, 1) if t > 0 else 0,
        })

    return {
        "total_evaluated": total_evaluated,
        "total_correct": total_correct,
        "accuracy_pct": round(total_correct / total_evaluated * 100, 1)
            if total_evaluated > 0 else 0,
        "monthly": monthly,
        "patterns_that_worked": worked,
        "patterns_that_misled": misled,
        "signal_leaderboard": signal_board,
        "calibration": calibration,
    }

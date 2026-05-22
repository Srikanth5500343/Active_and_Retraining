"""
Plan 7 — Capture team knowledge.

When a senior tech knows "that's always the PSU on these old switches," there's a
one-click way for them to teach that to the agent.

Features:
  - "Teach the agent" — submit a phrase → failure_mode rule from any resolved ticket.
  - Unmatched phrase log — phrases the agent couldn't classify (from unmatched.log).
  - Approve/reject interface for pending rules.
  - Approved rules are injected into the agent's pattern dictionary at runtime.

Storage: knowledge_rules.json in the same directory.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

HERE = Path(__file__).resolve().parent
RULES_FILE = HERE / "knowledge_rules.json"
UNMATCHED_LOG = HERE / "unmatched.log"


VALID_FAILURE_MODES = [
    "port_down", "cable_swap", "flapping", "slow_link", "crc_errors",
    "err_disabled", "rogue_device", "poe_issue", "config_change",
    "device_unreachable", "hardware_replace", "other",
]


def _load_rules() -> dict:
    if RULES_FILE.exists():
        try:
            return json.loads(RULES_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    return {
        "approved": [],     # [{phrase, failure_mode, weight, submitted_by, approved_at}]
        "pending": [],      # [{id, phrase, failure_mode, weight, submitted_by, submitted_at}]
        "rejected": [],     # [{id, phrase, failure_mode, rejected_at, reason}]
    }


def _save_rules(rules: dict) -> None:
    RULES_FILE.write_text(json.dumps(rules, indent=2, default=str), encoding="utf-8")


def _next_id(rules: dict) -> int:
    """Generate a simple incrementing ID for pending rules."""
    all_ids = []
    for category in ("approved", "pending", "rejected"):
        for r in rules.get(category, []):
            if isinstance(r.get("id"), int):
                all_ids.append(r["id"])
    return max(all_ids, default=0) + 1


def submit_rule(phrase: str, failure_mode: str, weight: float = 0.80,
                submitted_by: str = "anonymous") -> dict:
    """Submit a new pattern rule for approval.

    Args:
        phrase: The keyword/phrase to match (e.g., "PSU on old Catalyst").
        failure_mode: The failure_mode bucket it maps to.
        weight: Confidence weight (0.0-1.0).
        submitted_by: Name/ID of the tech who submitted it.

    Returns:
        The created pending rule dict.
    """
    phrase = phrase.strip().lower()
    if not phrase:
        return {"error": "phrase is required"}
    if failure_mode not in VALID_FAILURE_MODES:
        return {"error": f"invalid failure_mode; must be one of {VALID_FAILURE_MODES}"}
    weight = max(0.1, min(1.0, weight))

    rules = _load_rules()

    # Check for duplicates in approved + pending
    for r in rules["approved"] + rules["pending"]:
        if r["phrase"] == phrase:
            return {"error": f"rule for '{phrase}' already exists"}

    rule_id = _next_id(rules)
    rule = {
        "id": rule_id,
        "phrase": phrase,
        "failure_mode": failure_mode,
        "weight": weight,
        "submitted_by": submitted_by,
        "submitted_at": datetime.now(timezone.utc).isoformat(),
    }
    rules["pending"].append(rule)
    _save_rules(rules)
    return rule


def approve_rule(rule_id: int) -> dict:
    """Approve a pending rule, moving it to the approved list."""
    rules = _load_rules()
    target = None
    new_pending = []
    for r in rules["pending"]:
        if r.get("id") == rule_id:
            target = r
        else:
            new_pending.append(r)

    if not target:
        return {"error": f"pending rule {rule_id} not found"}

    target["approved_at"] = datetime.now(timezone.utc).isoformat()
    rules["approved"].append(target)
    rules["pending"] = new_pending
    _save_rules(rules)

    # Inject into agent's live pattern dictionary
    _inject_rule(target)

    return {"status": "approved", "rule": target}


def reject_rule(rule_id: int, reason: str = "") -> dict:
    """Reject a pending rule."""
    rules = _load_rules()
    target = None
    new_pending = []
    for r in rules["pending"]:
        if r.get("id") == rule_id:
            target = r
        else:
            new_pending.append(r)

    if not target:
        return {"error": f"pending rule {rule_id} not found"}

    target["rejected_at"] = datetime.now(timezone.utc).isoformat()
    target["reason"] = reason
    rules["rejected"].append(target)
    rules["pending"] = new_pending
    _save_rules(rules)
    return {"status": "rejected", "rule": target}


def _inject_rule(rule: dict) -> None:
    """Inject an approved rule into agent.FAILURE_PATTERNS at runtime."""
    try:
        import agent
        phrase = rule["phrase"]
        mode = rule["failure_mode"]
        weight = rule.get("weight", 0.80)
        if phrase not in agent.FAILURE_PATTERNS:
            agent.FAILURE_PATTERNS[phrase] = (mode, weight)
    except Exception:
        pass


def load_approved_into_agent() -> int:
    """Load all approved rules into the agent's FAILURE_PATTERNS.

    Call this at startup to ensure team knowledge persists across restarts.
    Returns the number of rules injected.
    """
    rules = _load_rules()
    count = 0
    for r in rules.get("approved", []):
        _inject_rule(r)
        count += 1
    return count


def get_unmatched_phrases(limit: int = 50) -> list[dict]:
    """Read the agent's unmatched.log and return recent unmatched phrases.

    These are phrases the agent couldn't classify — candidates for new rules.
    """
    if not UNMATCHED_LOG.exists():
        return []

    entries = []
    try:
        lines = UNMATCHED_LOG.read_text(encoding="utf-8").strip().splitlines()
        # Take the most recent entries
        for line in lines[-limit:]:
            parts = line.split(" | ", 1)
            if len(parts) == 2:
                entries.append({
                    "timestamp": parts[0].strip(),
                    "text": parts[1].strip(),
                })
            else:
                entries.append({"timestamp": "", "text": line.strip()})
    except OSError:
        pass

    # Reverse so newest is first
    entries.reverse()
    return entries


def get_all_rules() -> dict:
    """Return all rules grouped by status for the UI."""
    rules = _load_rules()
    return {
        "approved": rules.get("approved", []),
        "pending": rules.get("pending", []),
        "rejected": rules.get("rejected", []),
        "unmatched_phrases": get_unmatched_phrases(),
        "valid_failure_modes": VALID_FAILURE_MODES,
    }

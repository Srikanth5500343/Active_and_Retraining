"""
Plan 6 — Work between tickets.

The agent looks at the data center even when nothing is broken, and surfaces
things humans haven't asked about yet.

Daily insight cards:
  - "RACK-09 hasn't been scanned in 73 days."
  - "Row 4 had 6 port-down tickets this month, 4 of them Thursday mornings."
  - "Cables installed before 2023 are failing 3x more often."

Data sources: ServiceNow CMDB + incident table.
"""
from __future__ import annotations

import json
from collections import defaultdict
from datetime import datetime, timezone, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
INSIGHTS_CACHE = HERE / "proactive_insights.json"


def _save_insights(insights: list[dict]) -> None:
    INSIGHTS_CACHE.write_text(
        json.dumps(insights, indent=2, default=str), encoding="utf-8"
    )


def _load_insights() -> list[dict]:
    if INSIGHTS_CACHE.exists():
        try:
            return json.loads(INSIGHTS_CACHE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    return []


# ── Insight generators ──────────────────────────────────────────────────────

def _find_stale_scans(cmdb_records: list[dict], threshold_days: int = 60) -> list[dict]:
    """Find racks/CIs that haven't been scanned recently."""
    now = datetime.now(timezone.utc)
    insights = []

    rack_last_scan: dict[str, datetime | None] = {}
    for ci in cmdb_records:
        rack = ci.get("rack_name") or ci.get("u_rack", {}).get("display_value")
        last_scan_str = ci.get("last_scanned") or ci.get("u_last_scanned")
        if not rack:
            continue

        last_scan_dt = None
        if last_scan_str:
            for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%d"):
                try:
                    last_scan_dt = datetime.strptime(last_scan_str, fmt).replace(
                        tzinfo=timezone.utc
                    )
                    break
                except ValueError:
                    continue

        existing = rack_last_scan.get(rack)
        if last_scan_dt and (existing is None or last_scan_dt > existing):
            rack_last_scan[rack] = last_scan_dt

    for rack, last_dt in rack_last_scan.items():
        if last_dt is None:
            insights.append({
                "type": "stale_scan",
                "severity": "warning",
                "title": f"{rack} has never been scanned",
                "detail": f"{rack} has no scan record in CMDB.",
                "rack": rack,
                "days_since_scan": None,
            })
        else:
            days = (now - last_dt).days
            if days >= threshold_days:
                insights.append({
                    "type": "stale_scan",
                    "severity": "warning" if days < 90 else "critical",
                    "title": f"{rack} hasn't been scanned in {days} days",
                    "detail": f"Last scan was {last_dt.strftime('%Y-%m-%d')}. "
                              f"Consider scheduling a physical audit.",
                    "rack": rack,
                    "days_since_scan": days,
                })

    return sorted(insights, key=lambda x: -(x.get("days_since_scan") or 9999))


def _find_recurring_patterns(incidents: list[dict]) -> list[dict]:
    """Find time-based and location-based recurring patterns in incidents."""
    insights = []
    now = datetime.now(timezone.utc)
    thirty_days_ago = now - timedelta(days=30)

    # Parse incidents into structured records
    parsed = []
    for inc in incidents:
        opened_at_str = inc.get("opened_at") or inc.get("sys_created_on")
        if not opened_at_str:
            continue
        opened_dt = None
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%SZ"):
            try:
                opened_dt = datetime.strptime(opened_at_str, fmt).replace(
                    tzinfo=timezone.utc
                )
                break
            except ValueError:
                continue
        if not opened_dt or opened_dt < thirty_days_ago:
            continue

        desc = (inc.get("short_description") or "").lower()
        rack = None
        # Try to extract rack from description or CMDB fields
        import re
        rack_match = re.search(r"(RACK[-_]?\d+|rack[-_]?\d+|ROW[-_]?\d+)", desc, re.I)
        if rack_match:
            rack = rack_match.group(0).upper()

        parsed.append({
            "number": inc.get("number"),
            "opened_dt": opened_dt,
            "weekday": opened_dt.strftime("%A"),
            "hour": opened_dt.hour,
            "rack": rack,
            "description": desc,
        })

    # ── Pattern: same rack, multiple tickets this month ──
    by_rack = defaultdict(list)
    for p in parsed:
        if p["rack"]:
            by_rack[p["rack"]].append(p)

    for rack, tickets in by_rack.items():
        if len(tickets) >= 3:
            # Check if they cluster on a day of week
            day_counts = defaultdict(int)
            for t in tickets:
                day_counts[t["weekday"]] += 1
            top_day, top_count = max(day_counts.items(), key=lambda x: x[1])
            detail = (
                f"{rack} had {len(tickets)} tickets this month"
            )
            if top_count >= 3:
                detail += f", {top_count} of them on {top_day}s"

            insights.append({
                "type": "recurring_location",
                "severity": "warning" if len(tickets) >= 5 else "info",
                "title": detail,
                "detail": f"Tickets: {', '.join(t['number'] for t in tickets[:5])}",
                "rack": rack,
                "ticket_count": len(tickets),
            })

    # ── Pattern: same hour of day ──
    by_hour = defaultdict(list)
    for p in parsed:
        by_hour[p["hour"]].append(p)

    for hour, tickets in by_hour.items():
        if len(tickets) >= 4:
            # Check if specific day + hour combo
            day_counts = defaultdict(int)
            for t in tickets:
                day_counts[t["weekday"]] += 1
            top_day, top_count = max(day_counts.items(), key=lambda x: x[1])
            if top_count >= 3:
                insights.append({
                    "type": "recurring_time",
                    "severity": "info",
                    "title": (
                        f"{top_count} alerts at {hour:02d}:00 on {top_day}s this month"
                    ),
                    "detail": (
                        f"Possible scheduled job or maintenance window causing alerts. "
                        f"Total {len(tickets)} tickets at this hour."
                    ),
                    "hour": hour,
                    "day": top_day,
                    "ticket_count": top_count,
                })

    return insights


def _find_aging_equipment(cmdb_records: list[dict]) -> list[dict]:
    """Flag equipment installed before a cutoff that's failing more often."""
    insights = []
    now = datetime.now(timezone.utc)
    cutoff_year = now.year - 3  # e.g., 2023

    old_count = 0
    new_count = 0
    old_failures = 0
    new_failures = 0

    for ci in cmdb_records:
        install_str = ci.get("install_date") or ci.get("u_install_date")
        if not install_str:
            continue
        try:
            install_dt = datetime.strptime(install_str[:10], "%Y-%m-%d")
        except (ValueError, TypeError):
            continue

        incident_count = 0
        try:
            incident_count = int(ci.get("incident_count", 0))
        except (ValueError, TypeError):
            pass

        if install_dt.year <= cutoff_year:
            old_count += 1
            old_failures += incident_count
        else:
            new_count += 1
            new_failures += incident_count

    if old_count > 0 and new_count > 0:
        old_rate = old_failures / old_count if old_count else 0
        new_rate = new_failures / new_count if new_count else 0
        if old_rate > 0 and new_rate > 0:
            ratio = round(old_rate / new_rate, 1)
            if ratio >= 2.0:
                insights.append({
                    "type": "aging_equipment",
                    "severity": "warning",
                    "title": (
                        f"Equipment installed before {cutoff_year} is failing "
                        f"{ratio}x more often"
                    ),
                    "detail": (
                        f"Pre-{cutoff_year}: {old_count} items, "
                        f"{old_failures} incidents ({old_rate:.1f}/item). "
                        f"Post-{cutoff_year}: {new_count} items, "
                        f"{new_failures} incidents ({new_rate:.1f}/item)."
                    ),
                    "ratio": ratio,
                    "old_count": old_count,
                    "new_count": new_count,
                })

    return insights


# ── Main entry point ────────────────────────────────────────────────────────

def generate_proactive_insights(
    sn_base: str, sn_auth: tuple, sn_headers: dict
) -> list[dict]:
    """Fetch data from ServiceNow and generate proactive insight cards.

    Returns a list of insight dicts, each with:
        type, severity, title, detail, and type-specific fields.
    """
    import requests

    all_insights = []

    # ── Fetch CMDB CIs (network devices) ──
    cmdb_records = []
    try:
        r = requests.get(
            f"{sn_base}/table/cmdb_ci_ip_switch",
            params={
                "sysparm_fields": (
                    "name,sys_class_name,u_rack,rack_name,install_date,"
                    "u_install_date,u_last_scanned,last_scanned,"
                    "incident_count"
                ),
                "sysparm_display_value": "true",
                "sysparm_limit": 500,
            },
            auth=sn_auth, headers=sn_headers, timeout=20,
        )
        r.raise_for_status()
        cmdb_records = r.json().get("result", [])
    except Exception:
        pass

    # Also try generic CMDB CI table
    try:
        r = requests.get(
            f"{sn_base}/table/cmdb_ci_netgear",
            params={
                "sysparm_fields": (
                    "name,sys_class_name,u_rack,rack_name,install_date,"
                    "u_install_date,u_last_scanned,last_scanned,"
                    "incident_count"
                ),
                "sysparm_display_value": "true",
                "sysparm_limit": 500,
            },
            auth=sn_auth, headers=sn_headers, timeout=10,
        )
        if r.ok:
            cmdb_records.extend(r.json().get("result", []))
    except Exception:
        pass

    # ── Fetch recent incidents (last 30 days) ──
    recent_incidents = []
    try:
        thirty_days_ago = (
            datetime.now(timezone.utc) - timedelta(days=30)
        ).strftime("%Y-%m-%d")
        r = requests.get(
            f"{sn_base}/table/incident",
            params={
                "sysparm_query": (
                    f"category=network^opened_at>={thirty_days_ago}"
                    "^ORDERBYDESCopened_at"
                ),
                "sysparm_fields": (
                    "number,short_description,opened_at,sys_created_on,priority"
                ),
                "sysparm_display_value": "true",
                "sysparm_limit": 500,
            },
            auth=sn_auth, headers=sn_headers, timeout=20,
        )
        r.raise_for_status()
        recent_incidents = r.json().get("result", [])
    except Exception:
        pass

    # ── Generate insights ──
    all_insights.extend(_find_stale_scans(cmdb_records))
    all_insights.extend(_find_recurring_patterns(recent_incidents))
    all_insights.extend(_find_aging_equipment(cmdb_records))

    # Add timestamp
    generated_at = datetime.now(timezone.utc).isoformat()
    for ins in all_insights:
        ins["generated_at"] = generated_at

    _save_insights(all_insights)
    return all_insights


def get_cached_insights() -> list[dict]:
    """Return the last generated insights without hitting ServiceNow."""
    return _load_insights()

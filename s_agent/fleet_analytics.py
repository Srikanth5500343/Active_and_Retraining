"""
Plan 8 — Fleet-wide patterns.

The agent stops looking at one rack at a time and looks across everything at once.

Insights:
  - "All your 2am Thursday alerts are from one misconfigured backup job, not hardware."
  - "Failures cluster on firmware version 15.2 — 80% of recent incidents."
  - "Site A's records are 96% accurate, Site B's are 71%."

Data sources: ServiceNow incident table + CMDB.
"""
from __future__ import annotations

import json
import re
from collections import defaultdict
from datetime import datetime, timezone, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
FLEET_CACHE = HERE / "fleet_analytics.json"


def _save_analytics(data: dict) -> None:
    FLEET_CACHE.write_text(json.dumps(data, indent=2, default=str), encoding="utf-8")


def _load_analytics() -> dict:
    if FLEET_CACHE.exists():
        try:
            return json.loads(FLEET_CACHE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def _parse_dt(s: str) -> datetime | None:
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%SZ"):
        try:
            return datetime.strptime(s, fmt).replace(tzinfo=timezone.utc)
        except (ValueError, TypeError):
            continue
    return None


# ── Analyzers ───────────────────────────────────────────────────────────────

def _time_pattern_analysis(incidents: list[dict]) -> list[dict]:
    """Find time-correlated alert clusters (e.g., all 2am Thursday alerts)."""
    insights = []

    # Group by (hour, weekday)
    combos = defaultdict(list)
    for inc in incidents:
        dt = _parse_dt(inc.get("opened_at") or inc.get("sys_created_on") or "")
        if not dt:
            continue
        key = (dt.hour, dt.strftime("%A"))
        combos[key].append(inc)

    # Find concentrated patterns
    total = len(incidents) or 1
    for (hour, day), cluster in combos.items():
        count = len(cluster)
        if count < 3:
            continue
        pct = round(count / total * 100, 1)
        if pct < 5:
            continue

        # Check if they share a common short_description pattern
        descs = [inc.get("short_description", "").lower() for inc in cluster]
        # Find most common 2-word phrase
        word_pairs = defaultdict(int)
        for d in descs:
            words = d.split()
            for i in range(len(words) - 1):
                pair = f"{words[i]} {words[i+1]}"
                word_pairs[pair] += 1

        common_phrase = ""
        if word_pairs:
            top_pair, top_count = max(word_pairs.items(), key=lambda x: x[1])
            if top_count >= count * 0.5:
                common_phrase = top_pair

        detail = (
            f"{count} alerts ({pct}% of total) occur at {hour:02d}:00 on {day}s."
        )
        if common_phrase:
            detail += (
                f" Most mention '{common_phrase}' — possible scheduled job, "
                f"not hardware failure."
            )

        insights.append({
            "type": "time_cluster",
            "severity": "info" if count < 6 else "warning",
            "title": f"All your {hour:02d}:00 {day} alerts may share a root cause",
            "detail": detail,
            "hour": hour,
            "day": day,
            "count": count,
            "pct_of_total": pct,
            "common_phrase": common_phrase or None,
        })

    insights.sort(key=lambda x: -x["count"])
    return insights


def _firmware_clustering(cmdb_records: list[dict],
                         incidents: list[dict]) -> list[dict]:
    """Find firmware versions that correlate with more failures."""
    insights = []

    # Build a device → firmware map
    device_firmware: dict[str, str] = {}
    firmware_devices: dict[str, list[str]] = defaultdict(list)
    for ci in cmdb_records:
        name = ci.get("name", "")
        fw = (ci.get("firmware_version") or ci.get("u_firmware_version")
              or ci.get("os_version") or "")
        if name and fw:
            device_firmware[name.upper()] = fw
            firmware_devices[fw].append(name.upper())

    if not device_firmware:
        return insights

    # Count incidents per firmware version
    fw_incidents: dict[str, int] = defaultdict(int)
    total_with_fw = 0
    for inc in incidents:
        desc = (inc.get("short_description", "") + " "
                + inc.get("description", "")).upper()
        for device, fw in device_firmware.items():
            if device in desc:
                fw_incidents[fw] += 1
                total_with_fw += 1
                break

    if total_with_fw == 0:
        return insights

    # Find firmware versions with disproportionate failure share
    for fw, count in fw_incidents.items():
        pct = round(count / total_with_fw * 100, 1)
        device_count = len(firmware_devices.get(fw, []))
        device_pct = round(device_count / len(device_firmware) * 100, 1) if device_firmware else 0

        # Flag if failure % is significantly higher than fleet %
        if pct > device_pct * 1.5 and count >= 3:
            insights.append({
                "type": "firmware_cluster",
                "severity": "warning",
                "title": (
                    f"Failures cluster on firmware {fw} — "
                    f"{pct}% of incidents"
                ),
                "detail": (
                    f"Firmware '{fw}' runs on {device_count} devices "
                    f"({device_pct}% of fleet) but accounts for {count} "
                    f"incidents ({pct}% of total). Consider upgrading."
                ),
                "firmware": fw,
                "incident_count": count,
                "incident_pct": pct,
                "device_count": device_count,
                "device_pct": device_pct,
            })

    insights.sort(key=lambda x: -x["incident_pct"])
    return insights


def _site_accuracy(cmdb_records: list[dict],
                   incidents: list[dict]) -> list[dict]:
    """Compare CMDB record accuracy across sites/locations."""
    insights = []

    # Group CMDB records by location/site
    site_records: dict[str, list[dict]] = defaultdict(list)
    for ci in cmdb_records:
        site = (ci.get("location", {}).get("display_value") if isinstance(ci.get("location"), dict)
                else ci.get("location") or ci.get("u_site") or ci.get("u_location") or "Unknown")
        if site:
            site_records[str(site)].append(ci)

    if len(site_records) < 2:
        return insights

    # Score each site's CMDB completeness
    required_fields = [
        "name", "sys_class_name", "serial_number", "model_id",
        "ip_address", "install_date",
    ]

    site_scores = {}
    for site, records in site_records.items():
        if not records:
            continue
        total_fields = 0
        filled_fields = 0
        for ci in records:
            for field in required_fields:
                total_fields += 1
                val = ci.get(field)
                if isinstance(val, dict):
                    val = val.get("display_value")
                if val and str(val).strip():
                    filled_fields += 1
        accuracy = round(filled_fields / total_fields * 100, 1) if total_fields > 0 else 0
        site_scores[site] = {
            "accuracy_pct": accuracy,
            "record_count": len(records),
            "filled": filled_fields,
            "total": total_fields,
        }

    if len(site_scores) < 2:
        return insights

    # Compare sites
    sorted_sites = sorted(site_scores.items(), key=lambda x: -x[1]["accuracy_pct"])
    best_site, best = sorted_sites[0]
    worst_site, worst = sorted_sites[-1]

    if best["accuracy_pct"] - worst["accuracy_pct"] >= 10:
        detail_parts = []
        for site, stats in sorted_sites:
            detail_parts.append(
                f"{site}: {stats['accuracy_pct']}% "
                f"({stats['record_count']} records)"
            )

        insights.append({
            "type": "site_accuracy",
            "severity": "warning" if worst["accuracy_pct"] < 80 else "info",
            "title": (
                f"{best_site}'s records are {best['accuracy_pct']}% accurate, "
                f"{worst_site}'s are {worst['accuracy_pct']}%"
            ),
            "detail": " | ".join(detail_parts),
            "sites": {site: stats for site, stats in sorted_sites},
        })

    return insights


def _category_breakdown(incidents: list[dict]) -> dict:
    """Break down incidents by failure mode / category for the overview."""
    by_category = defaultdict(int)
    by_priority = defaultdict(int)

    for inc in incidents:
        cat = inc.get("category") or inc.get("subcategory") or "uncategorized"
        by_category[str(cat)] += 1
        pri = inc.get("priority", "?")
        by_priority[str(pri)] += 1

    return {
        "by_category": dict(sorted(by_category.items(), key=lambda x: -x[1])),
        "by_priority": dict(sorted(by_priority.items())),
        "total_incidents": len(incidents),
    }


# ── Main entry point ────────────────────────────────────────────────────────

def run_fleet_analytics(
    sn_base: str, sn_auth: tuple, sn_headers: dict,
    lookback_days: int = 90
) -> dict:
    """Fetch data from ServiceNow and run all fleet-wide analyses.

    Returns:
        {
            "generated_at": ...,
            "summary": {total_incidents, by_category, by_priority},
            "time_patterns": [...],
            "firmware_clusters": [...],
            "site_accuracy": [...],
        }
    """
    import requests

    cutoff = (
        datetime.now(timezone.utc) - timedelta(days=lookback_days)
    ).strftime("%Y-%m-%d")

    # ── Fetch incidents ──
    incidents = []
    try:
        r = requests.get(
            f"{sn_base}/table/incident",
            params={
                "sysparm_query": (
                    f"category=network^opened_at>={cutoff}"
                    "^ORDERBYDESCopened_at"
                ),
                "sysparm_fields": (
                    "number,short_description,description,opened_at,"
                    "sys_created_on,priority,category,subcategory,"
                    "cmdb_ci,assignment_group,state"
                ),
                "sysparm_display_value": "true",
                "sysparm_limit": 1000,
            },
            auth=sn_auth, headers=sn_headers, timeout=30,
        )
        r.raise_for_status()
        incidents = r.json().get("result", [])
    except Exception as e:
        return {"error": f"Failed to fetch incidents: {e}"}

    # ── Fetch CMDB records ──
    cmdb_records = []
    for table in ("cmdb_ci_ip_switch", "cmdb_ci_server", "cmdb_ci_netgear"):
        try:
            r = requests.get(
                f"{sn_base}/table/{table}",
                params={
                    "sysparm_fields": (
                        "name,sys_class_name,serial_number,model_id,"
                        "ip_address,install_date,firmware_version,"
                        "u_firmware_version,os_version,location,"
                        "u_site,u_location,u_rack,rack_name,"
                        "incident_count"
                    ),
                    "sysparm_display_value": "true",
                    "sysparm_limit": 500,
                },
                auth=sn_auth, headers=sn_headers, timeout=20,
            )
            if r.ok:
                cmdb_records.extend(r.json().get("result", []))
        except Exception:
            continue

    # ── Run analyses ──
    result = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "lookback_days": lookback_days,
        "summary": _category_breakdown(incidents),
        "time_patterns": _time_pattern_analysis(incidents),
        "firmware_clusters": _firmware_clustering(cmdb_records, incidents),
        "site_accuracy": _site_accuracy(cmdb_records, incidents),
    }

    _save_analytics(result)
    return result


def get_cached_analytics() -> dict:
    """Return last computed fleet analytics without hitting ServiceNow."""
    return _load_analytics()

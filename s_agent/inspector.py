"""
Per-ticket inspector.

Two inputs:
  1. An active incident picked from a dropdown (fetched live from ServiceNow)
  2. An uploaded rack/switch image

Output (no posting, no triage, no anomalies):
  - Agent extraction      (device, port, failure_mode, confidence, signals)
  - Agent reasoning chain (step-by-step with evidence + per-step confidence)
  - Vision annotated image (devices + target device + ports + target port)
  - Work-note preview      (exact text that *would* be posted to SN — preview only)

Run:
    python inspector.py
Then open http://127.0.0.1:5003
"""
import os
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request

# Load .env before importing modules that read env vars
HERE = Path(__file__).resolve().parent
for p in (HERE / ".env", HERE.parent / ".env", HERE.parent / "servicenow" / ".env"):
    if p.exists():
        load_dotenv(p)
        break

import requests

from agent import extract_incident, build_reasoning, _format_work_note, _analysis_hash, POST_CONFIDENCE_FLOOR
from vision_pipeline import run_pipeline as run_vision_pipeline
from feedback_loop import (
    get_scoreboard, process_resolved_incidents, record_prediction,
)
from proactive_scanner import generate_proactive_insights, get_cached_insights


app = Flask(__name__)

INSTANCE = os.environ.get("SN_INSTANCE")
USER     = os.environ.get("SN_USER")
PASSWORD = os.environ.get("SN_PASSWORD")

if not (INSTANCE and USER and PASSWORD):
    raise SystemExit("Missing SN_INSTANCE / SN_USER / SN_PASSWORD in .env")

SN_BASE = f"https://{INSTANCE}.service-now.com/api/now"
SN_AUTH = (USER, PASSWORD)
SN_HEADERS = {"Accept": "application/json"}


# ── Description-block parser (same as servicenow_client.extract_target) ──
def _extract_target_from_desc(description: str) -> dict:
    """Pull the '--- Device / Rack context ---' block out of the description.

    Returns a dict with keys like device, port, mgmt_ip, model, rack, u_position, etc.
    """
    info = {}
    in_block = False
    for line in (description or "").splitlines():
        if "Device / Rack context" in line:
            in_block = True
            continue
        if not in_block:
            continue
        if ":" in line:
            key, _, val = line.partition(":")
            key = key.strip().lower().replace(" ", "_")
            val = val.strip()
            if key and val:
                info[key] = val
    # Coerce port to int where possible
    if "port" in info:
        try:
            info["port"] = int(info["port"])
        except (ValueError, TypeError):
            pass
    return info


# ── Routes ───────────────────────────────────────────────────────────────

@app.get("/")
def index():
    return render_template("inspector.html")


@app.get("/api/incidents")
def list_incidents():
    """Active network incidents for the dropdown. Live from ServiceNow."""
    try:
        r = requests.get(
            f"{SN_BASE}/table/incident",
            params={
                "sysparm_query": "active=true^category=network^ORDERBYDESCsys_created_on",
                "sysparm_fields": "sys_id,number,short_description,priority,state",
                "sysparm_display_value": "true",
                "sysparm_limit": 100,
            },
            auth=SN_AUTH, headers=SN_HEADERS, timeout=20,
        )
        r.raise_for_status()
        items = r.json().get("result", [])
    except Exception as e:
        return jsonify({"error": f"ServiceNow query failed: {e}"}), 502

    return jsonify([
        {
            "sys_id":            i["sys_id"],
            "number":            i["number"],
            "short_description": i["short_description"],
            "priority":          i["priority"],
            "state":             i["state"],
        }
        for i in items
    ])


@app.post("/api/analyze")
def analyze():
    sys_id = request.form.get("incident_sys_id", "").strip()
    if not sys_id:
        return jsonify({"error": "incident_sys_id is required"}), 400
    if "image" not in request.files:
        return jsonify({"error": "image file is required"}), 400
    image_bytes = request.files["image"].read()
    if not image_bytes:
        return jsonify({"error": "uploaded image is empty"}), 400

    # 1) Fetch the full incident from ServiceNow ───────────────────────
    try:
        r = requests.get(
            f"{SN_BASE}/table/incident/{sys_id}",
            params={"sysparm_display_value": "true"},
            auth=SN_AUTH, headers=SN_HEADERS, timeout=20,
        )
        r.raise_for_status()
        incident = r.json().get("result", {})
    except Exception as e:
        return jsonify({"error": f"could not fetch incident: {e}"}), 502

    text = f"{incident.get('short_description') or ''} {incident.get('description') or ''}"

    # 2) Agent — extraction (Phase 1) ──────────────────────────────────
    extracted = extract_incident(text, cmdb_device_list=None)

    # Plan 5 — record prediction for later feedback evaluation
    inc_number = incident.get("number")
    if inc_number:
        record_prediction(inc_number, extracted)

    # 3) Agent — reasoning chain (Phase 2) ─────────────────────────────
    # Pull the structured device/rack block out of the description so the
    # reasoning chain has CMDB-like info to work with.
    desc_target = _extract_target_from_desc(incident.get("description", ""))
    cmdb_facts = {
        "sys_class_name":  "cmdb_ci_ip_switch" if (desc_target.get("device") or "").upper().startswith("SW") else None,
        "model":           desc_target.get("model"),
        "serial":          desc_target.get("serial"),
        "mgmt_ip":         desc_target.get("mgmt_ip"),
        "interface_alias": desc_target.get("interface"),
        "rack_name":       desc_target.get("rack"),
        "rack_scan_id":    desc_target.get("rack_scan_id"),
        "u_position":      desc_target.get("u_position"),
    }
    # Coerce u_position to int if possible
    try:
        if cmdb_facts["u_position"] is not None:
            cmdb_facts["u_position"] = int(cmdb_facts["u_position"])
    except (ValueError, TypeError):
        pass

    ticket = {
        "incident_number":   incident.get("number"),
        "sys_id":            sys_id,
        "short_description": incident.get("short_description"),
        "description":       incident.get("description"),
        "priority":          incident.get("priority"),
        "cmdb":              cmdb_facts,
        "extracted":         extracted,
    }
    reasoning = build_reasoning(ticket, extracted, cmdb_facts, last_scan=None)
    ticket["reasoning"] = reasoning

    # 4) Vision pipeline (YOLO) ────────────────────────────────────────
    # Build the 'expected' dict that vision_pipeline.run_pipeline wants
    vision_expected = {
        "device":      desc_target.get("device") or extracted.get("affected_device"),
        "model":       desc_target.get("model"),
        "serial":      desc_target.get("serial"),
        "rack":        desc_target.get("rack"),
        "rack_scan_id": desc_target.get("rack_scan_id"),
        "mgmt_ip":     desc_target.get("mgmt_ip"),
        "port":        desc_target.get("port") or extracted.get("affected_port"),
        "port_status": desc_target.get("port_status"),
        "u_position":  desc_target.get("u_position"),
    }
    try:
        vision = run_vision_pipeline(image_bytes, vision_expected)
    except Exception as e:
        vision = {
            "error": str(e),
            "device_identification": {"reasoning": f"Vision pipeline failed: {e}"},
            "port_grid_detection":   {"reasoning": ""},
            "target_port_analysis":  {"reasoning": ""},
            "annotated_image_b64":   None,
            "timings_ms":            {},
        }

    # 5) Work-note preview (Phase 4 — preview only, no posting) ────────
    work_note = _format_work_note(ticket, related=None)
    will_post = extracted.get("confidence", 0) >= POST_CONFIDENCE_FLOOR
    note_status = (
        f"would post (confidence ≥ {POST_CONFIDENCE_FLOOR:.1f})"
        if will_post
        else f"would NOT post (confidence {extracted.get('confidence', 0):.2f} below floor {POST_CONFIDENCE_FLOOR:.1f})"
    )

    return jsonify({
        "incident": {
            "number":            incident.get("number"),
            "short_description": incident.get("short_description"),
            "priority":          incident.get("priority"),
            "state":             incident.get("state"),
        },
        "expected_target":   vision_expected,
        "agent_extraction":  extracted,
        "agent_reasoning":   reasoning,
        "vision":            vision,
        "work_note_preview": {
            "text":       work_note,
            "would_post": will_post,
            "status":     note_status,
            "hash":       _analysis_hash(extracted, reasoning),
        },
    })


# ═════════════════════════════════════════════════════════════════════════
# Plan 5 — Learn from what worked (feedback loop)
# ═════════════════════════════════════════════════════════════════════════

@app.get("/api/feedback/scoreboard")
def feedback_scoreboard():
    """Return the agent accuracy scoreboard."""
    return jsonify(get_scoreboard())


@app.post("/api/feedback/refresh")
def feedback_refresh():
    """Fetch resolved incidents and evaluate agent predictions."""
    results = process_resolved_incidents(SN_BASE, SN_AUTH, SN_HEADERS)
    scoreboard = get_scoreboard()
    return jsonify({"evaluations": results, "scoreboard": scoreboard})


# ═════════════════════════════════════════════════════════════════════════
# Plan 6 — Work between tickets (proactive scanner)
# ═════════════════════════════════════════════════════════════════════════

@app.get("/api/proactive/insights")
def proactive_insights():
    """Return cached proactive insights."""
    return jsonify(get_cached_insights())


@app.post("/api/proactive/refresh")
def proactive_refresh():
    """Generate fresh proactive insights from ServiceNow data."""
    insights = generate_proactive_insights(SN_BASE, SN_AUTH, SN_HEADERS)
    return jsonify(insights)



if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5003, debug=False)

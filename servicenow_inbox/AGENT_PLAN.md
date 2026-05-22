# Intelligent Incident Agent — Build Plan (zero-LLM, self-contained)

**Owner:** TBD (teammate)
**Hard constraints:**
- **$0 budget.** No paid APIs, no LLM, no cloud inference.
- **Self-contained.** Agent runs in-process, no external service except ServiceNow itself.
- **Fully automated.** No human in the loop — once started, it polls, decides, acts.
- **Must look intelligent.** The product story is "the agent figured this out," not "we wrote a script."

**Demo win condition:** Tech opens the RackTrack app. Sees a queue ranked by the agent. Top item is a *batch* ("3 related tickets — visit RACK-04 once"). Each ticket shows a reasoning chain with evidence. Without anyone asking, the agent has already posted a work note on each incident in ServiceNow with its analysis.

---

## Where the "intelligence" actually comes from (no LLM needed)

This is the engine room. Six deterministic signals — each cheap, each auditable, each combined to produce something that *looks like* AI:

| # | Signal | What it does | Where the data comes from |
|---|---|---|---|
| 1 | **Expanded pattern dictionary** | Maps failure keywords to buckets: `down`, `slow`, `no_link`, `cable`, `replace`, `unreachable`, `blinking_amber`, `flapping` | Hand-curated dict in `agent.py` |
| 2 | **Fuzzy CMDB matching** | "core switch 1" → `SW-CORE-01` via Levenshtein against the actual CMDB device name list | `rapidfuzz` (free, pure Python) + CMDB device list already fetched in [poll.py:102](poll.py#L102) |
| 3 | **Word-to-number** | "the third port" → `3`, "second uplink" → `2` | Tiny static dict, no library |
| 4 | **Scan-history diff** | Compare current scan against last scan for the same rack — flag ports that flipped state, devices that moved or disappeared | `outputs/<rackId>/device_unit_map.json` history (already on disk) |
| 5 | **Time-window correlation** | N incidents in <1h pointing to the same rack ⇒ likely shared root cause; surface as a single batch | `active_tickets.json` (already built every poll) |
| 6 | **Class-mismatch detection** | CMDB says position U10 is a switch; last scan saw a server there ⇒ rack drift | CMDB lookup vs. scan output, both already in [poll.py:144-180](poll.py#L144-L180) |

**Confidence scoring** (so the agent honestly says "I'm not sure" instead of bluffing): each signal contributes a score 0-1. Multi-signal agreement raises confidence; conflicting signals lower it; a single weak signal caps confidence at 0.4 ⇒ ticket goes to a "needs human review" bucket.

That's it. No model. No API. No training data. It runs forever on the PDI for free.

---

## What exists today (do NOT rebuild)

| Piece | File | Role |
|---|---|---|
| Poller | [poll.py](poll.py) | Hits SN every N sec, regex-extracts `{device, port}`, enriches with CMDB, writes `active_tickets.json` |
| Verifier | [ingest.py](ingest.py) | Compares CMDB devices against a real rack scan |
| Server endpoint | [server/app.js:2705](../server/app.js#L2705) `GET /api/incidents/active` | Passes the inbox to the app |
| Server endpoint | [server/app.js:2722](../server/app.js#L2722) `GET /api/incidents/:inc/expected-rack` | Per-incident "what to photograph" |
| App consumer | [client/src/pages/ScanPage.jsx](../client/src/pages/ScanPage.jsx) | Already reads the active-tickets feed |
| SN client | [servicenow/servicenow.py](../servicenow/servicenow.py) | Has `add_work_note()` for auto-posting back |

Baseline is mechanical. This plan adds the brain.

---

## Build phases — 4 phases, each self-contained, each ships independently

### Phase 1 — Smarter extraction (rules + fuzzy match, no LLM)

**New file:** `servicenow_inbox/agent.py`

**Function:** `extract_incident(text, cmdb_device_list) -> dict`

Returns:
```json
{
  "failure_mode": "port_down | cable_swap | device_unreachable | hardware_replace | config_change | other",
  "affected_device": "SW-CORE-01",
  "affected_port": 12,
  "affected_role": "uplink | access | management | unknown",
  "urgency_signal": "user_reported | monitoring_alert | scheduled",
  "one_line_summary": "WEB-01 lost link, port 12 on access switch suspected",
  "confidence": 0.78,
  "signals_used": ["keyword:down", "fuzzy_match:SW-CORE-01", "word_num:third->3"]
}
```

How it works:
1. **Tokenize** the short_description + description.
2. **Pattern dictionary hit** → failure_mode + role.
3. **Word-to-number expansion** → resolve "third", "first", "Gi1/0/12".
4. **Fuzzy device match** with `rapidfuzz.process.extractOne(text, cmdb_names, score_cutoff=85)` → exact-or-close device name.
5. **One-line summary** = template fill, not generation: `f"{device} {failure_mode_human}, port {port} suspected"`.
6. **Confidence** = `min(1.0, sum(signal_weights))`.

**Wiring:** call from [poll.py:184 `ticket_record()`](poll.py#L184) **after** the existing regex pass. If the agent agrees with regex → confidence boost. If they disagree → keep the higher-confidence one and log both.

**Demo win:** show a ticket with messy text — *"the third uplink on the access switch in row 4 went dark around 9am"* — regex returns nothing; agent returns `{device: SW-ACC-01, port: 3, role: uplink, urgency: user_reported, confidence: 0.82}`.

---

### Phase 2 — Reasoning chain (deterministic, but visible)

For each actionable ticket, the agent emits a `reasoning` array that walks through what it did, with evidence. **No generation — it's just narrating the pipeline.**

```json
"reasoning": [
  {"step": "parsed_incident",
   "evidence": "Matched keyword 'down', fuzzy-matched 'SW-CORE-01' (score 92)",
   "confidence": 0.85},
  {"step": "looked_up_cmdb",
   "evidence": "SW-CORE-01 found in cmdb_ci_ip_switch, port 12 = Gi1/0/12",
   "confidence": 1.0},
  {"step": "found_rack",
   "evidence": "Contains-rel parent: RACK-04, scan ID RK-DC1RACK4",
   "confidence": 1.0},
  {"step": "checked_last_scan",
   "evidence": "Last scan 2026-05-18: port 12 visual state EMPTY",
   "confidence": 0.9},
  {"step": "detected_drift",
   "evidence": "CMDB expects port 12 CONNECTED; scan saw EMPTY — drift detected",
   "confidence": 0.95},
  {"step": "suggested_action",
   "evidence": "Walk to RACK-04 U10, verify cable to port 12; check patch panel PP-01 port mapping",
   "confidence": 0.7}
]
```

**How it's built:** new helper `build_reasoning(ticket, cmdb, last_scan) -> list[step]`. Each step is appended as the existing pipeline runs — extraction emits step 1, CMDB lookup emits step 2, rack lookup emits step 3, scan diff emits steps 4-5, action template emits step 6.

**Suggested-action templates** live in `servicenow_inbox/action_templates.py` — keyed by `(failure_mode, device_role)`:
```python
TEMPLATES = {
  ("port_down", "uplink"): "Walk to {rack} {u_position}, verify uplink cable on port {port}; check both ends + LED",
  ("port_down", "access"): "Walk to {rack} {u_position}, verify cable on port {port}; check patch panel mapping",
  ("device_unreachable", "*"): "Walk to {rack} {u_position}, verify {device} is powered and front LEDs are green",
  # ... ~15-20 templates total covers 90% of demo incidents
}
```

**Client:** new component `<IncidentReasoning />` under [ScanPage.jsx](../client/src/pages/ScanPage.jsx). Collapsible "Why this rack?" panel. Each step a row: icon + step name + evidence + a small confidence pill.

**Demo win:** the reasoning panel makes leadership say "wait — it actually thought about this." Looks like AI. Is actually a switch statement.

---

### Phase 3 — Triage, batching, anomaly detection

The agent ranks the queue and recommends visit order. **This is the most visible "intelligence" feature** because it surfaces things humans miss.

**New function:** `rank_and_cluster(tickets, scan_history) -> dict`

Scoring per ticket:
- Priority weight (`1` = highest → +40)
- Age in hours (+1/hr, capped +20)
- **Same-rack batch bonus** (+15 if ≥2 tickets in the same rack within 1h)
- Scan-data-available bonus (+10 if recent scan exists)
- **Anomaly bonus** (+25 if drift detected — CMDB vs. scan class mismatch, or port-state flip since last scan)
- Confidence floor: `<0.4` → "needs_human_review" bucket

Output additions to `/api/incidents/active` payload:
```json
{
  "polled_at": "...",
  "count": 7,
  "ranked": [...],                         // sorted by score
  "batches": [                              // surfaced as grouped cards in UI
    {
      "rack": "RACK-04",
      "incident_count": 3,
      "shared_root_cause_hint": "All 3 mention port_down on switches in same rack within 22min — possible PSU/uplink event",
      "tickets": [...]
    }
  ],
  "anomalies": [                            // standalone surfaced items
    {
      "type": "rack_drift",
      "rack": "RACK-04",
      "evidence": "CMDB places SW-CORE-01 at U22; last scan saw a server at U22",
      "tickets_affected": ["INC0010001", "INC0010005"]
    }
  ],
  "needs_human_review": [...],
  "top": {...}
}
```

**Server change:** none — `/api/incidents/active` already passes through the JSON.

**Demo win:** "The agent noticed 3 tickets are about the same rack and grouped them into one visit. It also flagged that the CMDB position for SW-CORE-01 doesn't match what we last photographed — rack drift. No one would have caught that manually."

---

### Phase 4 — Automated work-note posting (closes the loop, fully autonomous)

This is where "automation" becomes literal. Without anyone clicking anything, every actionable incident gets a work note posted back to ServiceNow with the agent's analysis.

**New function:** `auto_post_analysis(ticket, sn_client)` — uses existing [servicenow.py:112 `add_work_note()`](../servicenow/servicenow.py#L112).

Work note template:
```
RackTrack Agent Analysis — auto-generated

Incident: WEB-01 unreachable, port 12 suspected
Confidence: 0.82

Reasoning:
  1. Parsed text: failure_mode=port_down, device=SW-CORE-01, port=12
  2. CMDB: SW-CORE-01 lives in RACK-04, port 12 = Gi1/0/12
  3. Last rack scan (2026-05-18): port 12 was EMPTY
  4. Drift detected: CMDB expects port 12 CONNECTED

Suggested action:
  Walk to RACK-04 (U10), verify cable on port 12, check patch panel PP-01.

Related incidents in same rack: INC0010003, INC0010005
```

**Guards (so it doesn't spam SN):**
- Track posted incidents in `servicenow_inbox/posted.json` — `{incident_number: agent_analysis_hash}`.
- Re-post only if the analysis hash changes (i.e. new scan data changed the conclusion).
- Hard cap: max 1 post per incident per 24h.
- Confidence floor: only post if `confidence >= 0.5`. Below that → log only, no SN write.

**Wiring:** add at end of [poll.py:281](poll.py#L281) main loop — `for record in records: auto_post_analysis(record, sn)`.

**Demo win:** the killer beat. *"And here's the incident in ServiceNow — the work note is already there. The agent did it 30 seconds ago, without anyone touching the system."*

---

## Automation layer (how the whole thing runs hands-free)

This is the "automation" the user asked for — the agent runs on its own, forever, no input required.

**Single command starts everything:**
```powershell
python servicenow_inbox/poll.py --watch 60
```

What runs every 60 seconds:
1. Fetch open incidents from SN ([poll.py:81](poll.py#L81))
2. For each: regex extract → **agent extract (Phase 1)** → CMDB enrich → **reasoning chain (Phase 2)**
3. After all tickets gathered: **rank + cluster + anomaly-detect (Phase 3)**
4. Write `active_tickets.json` (server picks it up automatically)
5. **Auto-post work notes back to SN (Phase 4)** — only changed ones

No human input. No interactive prompts. No LLM calls. No paid services. Runs forever on a free PDI + free Python.

**Optional Windows Task Scheduler entry** (so the teammate doesn't need a terminal open):
- Action: `python h:\SERVICENOW\SERVICENOW\dark_mobile\servicenow_inbox\poll.py --watch 60`
- Trigger: at logon
- Restart on failure

---

## Demo script (90 seconds, for leadership)

1. **Setup shown:** terminal running the poller, app open on a phone (or browser).
2. **In ServiceNow:** show a fresh incident — *no work notes yet*.
3. **Wait ~60 seconds.** Refresh the incident. Work note appears with the agent's full reasoning. *"Nobody clicked anything."*
4. **In the app:** open the Tickets tab. Show the ranked queue with the top item flagged "**BATCH: 3 incidents in RACK-04** — possible shared root cause."
5. **Tap the top ticket.** Show the "Why this rack?" reasoning panel — 5 steps, evidence per step, confidence pills.
6. **Show an anomaly card:** "Rack drift detected — CMDB and last scan disagree on position U22."
7. **Show the "needs human review" bucket:** one low-confidence ticket the agent honestly admits it doesn't know. *"It doesn't bluff."*
8. **Closer:** "Zero API cost. Runs on a laptop. Catches things humans miss. Posts back to ServiceNow without being asked."

---

## File layout

```
servicenow_inbox/
├── poll.py                    [EXISTS — modify ticket_record() + main loop]
├── ingest.py                  [EXISTS — unchanged]
├── agent.py                   [NEW — extraction + reasoning + ranking]
├── action_templates.py        [NEW — suggested-action templates]
├── posted.json                [NEW — work-note dedup state, gitignored]
└── AGENT_PLAN.md              [this file]
```

Dependencies to add to `requirements.txt`:
```
rapidfuzz>=3.0     # fuzzy CMDB matching, pure Python, ~1MB
```

That's the only new dep. No ML libs, no models, no API SDKs.

---

## Non-goals (push back if scope creeps)

- **No LLM. No paid services. No ML models.** Hard constraint.
- **No auto-close of incidents.** Agent suggests; humans close.
- **No write-back to CMDB.** Already a hard rule from [servicenow/PLAN.md:347-350](../servicenow/PLAN.md#L347).
- **No port-as-CI modeling in SN.** Already decided.
- **No retry-the-LLM logic** — there's no LLM to retry.

---

## Effort estimate

| Phase | Effort | What ships |
|---|---|---|
| 1 — Smarter extraction (rules + fuzzy) | 1 day | Better device/port parsing on messy tickets |
| 2 — Reasoning chain + UI panel | 1 day | The "AI thinking" moment |
| 3 — Triage + batching + anomaly detection | 1 day | The "agent recommends" + drift-catch story |
| 4 — Auto-post work notes (closed-loop automation) | 0.5 day | The autonomous beat |
| **Total** | **~3.5 days** | Full self-contained product |

Ship phases in order. Each phase merges via PR before starting the next.

---

## Definition of done (per phase)

- **Phase 1:** Ticket text *"the third port on the access switch is dead"* yields `{device: SW-ACC-01, port: 3, confidence ≥ 0.6}`. Regex alone returned null.
- **Phase 2:** App's ticket detail view shows a "Why this rack?" panel with ≥4 reasoning steps and per-step confidence for every actionable ticket.
- **Phase 3:** `/api/incidents/active` response includes `ranked`, `batches`, `anomalies`, `needs_human_review`. App renders batches as grouped cards.
- **Phase 4:** A new SN incident, within one poll cycle, automatically gets a work note posted back containing the full reasoning chain. Posting a second time with no changes is a no-op (dedup works).

---

## Risks

| Risk | Mitigation |
|---|---|
| Pattern dictionary misses a phrasing | Log all "extraction returned nothing" cases in `unmatched.log`; teammate reviews weekly and adds patterns |
| Fuzzy match maps to wrong device | Score cutoff 85; on confidence <0.5 → "needs human review", don't auto-post |
| Anomaly false-positive spams SN | Confidence floor on auto-post (≥0.5); hash dedup; 24h rate limit per incident |
| Demo flakes because PDI hibernated | Pre-demo: wake the PDI, run poller once, verify work note posted. Have a recorded video as fallback |

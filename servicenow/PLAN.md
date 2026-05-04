# RackTrack × ServiceNow — 1-Day Build Plan

## What you'll have by end of day

A Python service that you run like this:

```
python main.py INC0010001
```

…and within ~3 seconds, a work note appears on that incident in ServiceNow:

```
RackTrack correlation for INC0010001
CMDB: SW-CORE-01 (Cisco) in RACK-04 at U10
Ticket references: Port 12
RackTrack scan RK-DC1RACK4 (2026-04-20): switch confirmed at rack position
  Port 12 visual state: EMPTY
Neighbors: PP-01 above (U11), WEB-01 below (U09)
Suggested action: verify physical cable — CMDB expects port 12 connected
```

That's your product demo: one command, real ServiceNow, real CMDB, real correlation against a physical rack scan.

## Before you start (do this now, takes 5 minutes)

- [ ] Python 3.10+ installed (`python3 --version`)
- [ ] Git installed (`git --version`)
- [ ] A working email address for ServiceNow signup
- [ ] Block 8 hours on your calendar, no meetings

Project files you already have in this folder (don't rewrite, just use):

```
PLAN.md                       ← this file
README.md                     ← quick reference
requirements.txt              ← Python dependencies
.env.example                  ← copy to .env and fill in
servicenow.py                 ← ServiceNow REST client
racktrack.py                  ← RackTrack client (mock + live modes)
reconciler.py                 ← correlation logic
main.py                       ← CLI entry point
cmdb_seed.md                  ← exact CMDB values to type into SN UI
mock_scans/RK-DC1RACK4/
    device_unit_map.json      ← sample RackTrack scan to test against
```

---

## Hour-by-hour plan

| Time  | Task                                   | Blocker if it fails              |
|-------|----------------------------------------|----------------------------------|
| 0:00  | Request ServiceNow PDI, set aside      | No PDI = no Day 1                |
| 0:15  | Local project setup, venv, install     | Python issues                    |
| 0:30  | Log into PDI, orient                   | PDI not provisioned yet → wait   |
| 0:45  | Add custom field `u_racktrack_id`      | Tables app permissions           |
| 1:00  | Populate CMDB: rack, switches, servers | Slow typing                      |
| 1:45  | Create relationships in cmdb_rel_ci    | Common gotcha — see notes        |
| 2:00  | Export CMDB records to JSON (git them) | Hibernation protection           |
| 2:15  | Raise test incident, note its number   | Trivial                          |
| 2:30  | Verify REST API works with `curl`      | 401 = password wrong             |
| 2:45  | Lunch / buffer                         |                                  |
| 3:30  | Run `main.py`, iterate on errors       | Most of your debugging time      |
| 5:00  | Confirm work note posts correctly      | PATCH permissions                |
| 5:30  | Polish output format                   | Presentation                     |
| 6:00  | Write README, document your demo       |                                  |
| 6:30  | Record a short screen capture          | For LinkedIn / manager           |
| 7:00  | Buffer for anything that broke         |                                  |
| 8:00  | Done                                   |                                  |

---

## 0:00 — Request ServiceNow PDI

1. Go to **https://developer.servicenow.com**
2. Top right → *Sign Up and Start Building*
3. Create an account, verify email, log in
4. On the dashboard → top right → *Request Instance*
5. Select the **latest release** version
6. Submit

You'll get an email in ~10-15 minutes with three things you must save:
- **Instance URL** (e.g. `https://dev123456.service-now.com`)
- **Username** (usually `admin`)
- **Password** (a random string — save this to a password manager immediately)

While you wait, move to the next step.

---

## 0:15 — Local project setup

Open a terminal in this folder. Then:

```bash
python3 -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
```

Open `.env` in your editor. You'll fill in the ServiceNow values once your PDI email arrives:

```
SN_INSTANCE=dev123456
SN_USER=admin
SN_PASSWORD=your-pdi-password
RACKTRACK_USE_MOCK=true
RACKTRACK_URL=http://localhost:3000
RACKTRACK_JWT=
```

`SN_INSTANCE` is just the subdomain, not the full URL.

---

## 0:30 — Log into PDI, orient

Click the instance URL from the email. Log in with `admin` + the password. You land on the ServiceNow admin UI.

Quick tour:
- **Filter navigator** (top left search box) — type a table name + `.list` to open any record list. You'll use this constantly.
- Try: type `incident.list` → you'll see the pre-populated sample incidents. Type `cmdb_ci.list` → all CIs. These are live, queryable via REST.

Bookmark the instance URL in your browser.

---

## 0:45 — Add custom field `u_racktrack_id` to the Rack table

This is the single most important schema decision, and it takes 3 minutes.

1. Filter navigator → type `sys_db_object.list` → Enter. This is the list of all tables.
2. Find the row where Name = `cmdb_ci_rack`. Click to open.
3. Scroll down to the **Columns** related list at the bottom.
4. Click *New* (top right of the columns list).
5. Fill:
   - **Column label**: `RackTrack scan ID`
   - **Type**: String
   - **Max length**: 40
   - (Column name auto-fills as `u_racktrack_id` — good, don't change it)
6. Right-click the header bar → *Save*.

Now `u_racktrack_id` is a real column on every rack CI.

---

## 1:00 — Populate CMDB

**See `cmdb_seed.md` for the exact values to type.** It has field-by-field data for:
- 1 rack (RACK-04, with `u_racktrack_id = RK-DC1RACK4`)
- 2 switches (SW-CORE-01, SW-ACC-01)
- 5 servers (WEB-01, WEB-02, DB-01, APP-01, APP-02)
- 1 patch panel (PP-01)

For each, use the filter navigator to open the right list (`cmdb_ci_ip_switch.list`, `cmdb_ci_server.list`, etc.), click *New*, paste values, save.

**Tip**: after saving the first switch, you can clone it (right-click the header → *Insert and Stay*) and just change the fields that differ. Faster than re-typing.

Time: ~45 minutes of data entry. Put on a podcast.

---

## 1:45 — Create CMDB relationships

This is the part that trips people up. CMDB relationships live in a separate table called `cmdb_rel_ci`. Each row links a *parent* CI to a *child* CI with a *type* (like "Contains::Contained by").

**The relationships you need:**

| Parent     | Type              | Child       |
|------------|-------------------|-------------|
| RACK-04    | Contains          | SW-CORE-01  |
| RACK-04    | Contains          | SW-ACC-01   |
| RACK-04    | Contains          | PP-01       |
| RACK-04    | Contains          | WEB-01      |
| RACK-04    | Contains          | WEB-02      |
| RACK-04    | Contains          | DB-01       |
| RACK-04    | Contains          | APP-01      |
| RACK-04    | Contains          | APP-02      |

**How to create each one:**

1. Filter navigator → `cmdb_rel_ci.list` → Enter
2. Click *New*
3. Parent: click the magnifier → search `RACK-04` → select
4. Type: search for `Contains` — pick the one that reads `Contains::Contained by` (there are several similar ones; this is the standard containment relationship)
5. Child: click magnifier → search `SW-CORE-01` → select
6. Save
7. Repeat for all 8 rows above

**Shortcut**: after creating the first relationship, use *Insert and Stay* (right-click header) and just change the Child field for each subsequent one. Saves 80% of the clicking.

**Verify it worked**: open the RACK-04 record. Scroll down to the *Related Items* (or BSM map) — you should see all 8 children hanging off it.

---

## 2:00 — Export CMDB to JSON (hibernation protection)

PDI instances hibernate after ~10 days of inactivity and can be wiped by ServiceNow periodically. If you lose your CMDB data, you'll want to restore from git, not re-type.

For each CI record (8 CIs + 8 relationships = 16 records), do this once:

1. Open the record
2. Right-click the header bar → *Export* → *JSON*
3. Save the file into this project folder, in a subfolder called `cmdb_backup/`

Commit to git:

```bash
git init
git add cmdb_backup/ .env.example *.py *.md requirements.txt mock_scans/
echo ".env" > .gitignore
echo "venv/" >> .gitignore
git add .gitignore
git commit -m "Initial: CMDB baseline + correlator"
```

If the instance resets: **System Import Sets** → import each JSON → your CMDB is back in 10 minutes.

---

## 2:15 — Raise the test incident

1. Filter navigator → `incident.list` → Enter
2. Click *New*
3. Fill:
   - **Short description**: `Port 12 on SW-CORE-01 down — WEB-01 unreachable`
   - **Description**: `User reports WEB-01 unreachable since 9am. Switch port 12 appears down.`
   - **Configuration item** (cmdb_ci): click magnifier → search `SW-CORE-01` → select
   - **Priority**: 3 - Moderate
4. Save. Note the incident number (something like `INC0010001`). **Write it down.**

---

## 2:30 — Verify REST API

With your `.env` filled in, from the project folder:

```bash
source venv/bin/activate
python -c "
from dotenv import load_dotenv
load_dotenv()
import os, requests
r = requests.get(
    f'https://{os.environ[\"SN_INSTANCE\"]}.service-now.com/api/now/table/incident',
    params={'sysparm_query': 'number=INC0010001', 'sysparm_limit': 1},
    auth=(os.environ['SN_USER'], os.environ['SN_PASSWORD']),
    headers={'Accept': 'application/json'}
)
print(r.status_code)
print(r.json()['result'][0]['short_description'])
"
```

Expected output: `200` and your incident's short description. If you get 401, recheck password. If 200 but empty result, check the incident number.

---

## 3:30 — Run the correlator end-to-end

The code is already in this folder. You shouldn't need to modify it. Just run:

```bash
python main.py INC0010001
```

What it does (look at `main.py` to follow along):

1. Loads `.env` credentials
2. Fetches incident `INC0010001` from ServiceNow
3. Reads the incident's `cmdb_ci` field → gets the switch sys_id
4. Fetches the switch CI details
5. Walks `cmdb_rel_ci` to find the parent rack
6. Reads `u_racktrack_id` from the rack CI → gets `RK-DC1RACK4`
7. Loads `mock_scans/RK-DC1RACK4/device_unit_map.json` (since `RACKTRACK_USE_MOCK=true`)
8. Runs the reconciler to produce the work note text
9. Prints the preview, asks you to confirm
10. PATCHes the incident with the work note

On the first run, expect failures. Common ones:

- **`KeyError: 'cmdb_ci'`** — your incident doesn't have a CI set. Go back to the incident, set cmdb_ci = SW-CORE-01, save.
- **Switch has no parent rack** — the cmdb_rel_ci row is missing. Go back to 1:45.
- **`u_racktrack_id` is empty** — the custom field wasn't populated on RACK-04. Open the rack, set it to `RK-DC1RACK4`, save.
- **Mock scan not found** — check the file is at `mock_scans/RK-DC1RACK4/device_unit_map.json`.

---

## 5:00 — Confirm work note posts

Once the script prints the reconciliation preview and asks `Post this as a work note? [y/N]`, type `y` and Enter.

Then open the incident in ServiceNow UI. Scroll to *Activity* at the bottom. Your work note should be there.

If the PATCH fails with 403: your admin user needs the `itil` role (should already, on a fresh PDI, but check if it errors).

---

## 5:30 — Polish the work note format

Open `reconciler.py`. The function `reconcile()` builds the note string. Edit to taste:

- Want emojis? Add them to the lines.
- Want a different summary style? Change the line order.
- Want to include the scan timestamp? `scan.get("scannedAt")` is available.

Re-run after each edit. Each run posts a fresh work note, so you can see your changes in the activity stream.

---

## 6:00 — README + demo notes

Write 5-10 sentences in `README.md` (already stubbed) explaining what this does and how to run it. Future you will forget.

---

## 6:30 — Screen capture for the demo

Record a 60-second video:
1. Show the empty incident in ServiceNow (no work notes yet)
2. Flip to terminal, run `python main.py INC0010001`
3. Show the console output
4. Press `y`
5. Flip back to ServiceNow, refresh, show the work note
6. Voiceover: "Most ticket systems tell you what the database says should be there. RackTrack tells you what the camera actually saw. This reconciles both in one tap."

That video is your artifact for LinkedIn, your manager, or a portfolio.

---

## Switching from mock to live RackTrack

When your RackTrack server is running locally and reachable:

1. Edit `.env`: `RACKTRACK_USE_MOCK=false`
2. Set `RACKTRACK_URL` to your server (e.g. `http://localhost:3000`)
3. Paste a valid JWT into `RACKTRACK_JWT` (get one from your RackTrack login flow)
4. Make sure your RackTrack database has a scan with `rackId = RK-DC1RACK4`

No code changes needed — `racktrack.py` routes based on the `USE_MOCK` env var.

---

## What's deliberately NOT in this Day 1 plan

These are real features, but skipping them keeps you shippable:

- **Modeling each port as a separate CI.** ServiceNow supports it. Don't. RackTrack owns port granularity — CMDB stays at device level for v1.
- **Auto-writing to CMDB from RackTrack detections.** Observer mode only. Once a photo silently corrupts your source of truth, you'll never win that trust back.
- **SNMP / LLDP live network check (the "Network Reality" layer in your 7-step doc).** That's Phase 3.
- **AI suggestion layer.** The current "Suggested action:" line in the work note is a rule-based template, not LLM-generated. Upgrade in Phase 4 when you have enough reconciliation examples to feed it.
- **Slack / Teams / Outlook push.** Your RackTrack already has `slack_email.py`, `teams_send.py`, `outlook_send.py`. One afternoon to wire them in after Day 1 works.

---

## Troubleshooting

| Symptom                                    | Fix                                                                 |
|--------------------------------------------|---------------------------------------------------------------------|
| `401 Unauthorized` on SN calls             | Password wrong, or PDI hibernated → wake it at developer.servicenow.com |
| `empty result` for incident lookup         | Check incident number, check your `.env` SN_INSTANCE subdomain       |
| Switch found but no parent rack            | `cmdb_rel_ci` row missing — re-check relationship type              |
| `u_racktrack_id` column not showing        | Refresh the list view; if still missing, re-add column              |
| PATCH work_notes returns 403               | admin user role insufficient → System Security → User Administration → admin → add `itil` |
| Mock scan JSON not found                   | File must be at `mock_scans/<rack_scan_id>/device_unit_map.json`    |
| PDI won't wake                             | Try 10 min later, or request a new instance (old data lost — that's why we export to git) |

---

## Day 2+ candidates, ranked by business value

1. **Wire up 3 more incidents** with different failure modes (port missing, wrong rack, unknown device) so your demo shows the system catching real drift.
2. **Background poller** — a loop that checks for new incidents with a specific category every 60s and auto-correlates. Turns this from a manual tool into an automated assistant.
3. **Flow Designer** — ServiceNow's built-in automation UI. Have an incident create-trigger call a ServiceNow-side script that hits your correlator's HTTP endpoint. Fully native workflow.
4. **Slack/Teams posting** (1 hour using your existing code).
5. **Network Reality layer** (SNMP via `pysnmp`) — the 4th of your 7 steps.
6. **LLM suggestion layer** — feed the reconciliation payload to Claude/GPT and ask for a ranked action list.

Ship Day 1 first. Don't let Days 2-6 keep you from finishing today.

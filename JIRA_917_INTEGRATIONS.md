# SPRTMS-917 · End to End integration — additional subtasks to add

**Parent epic:** SPRTMS-917 · End to End integration
**Description (parent):** Integrate all detection, classification, and selection stages into a single deterministic backend pipeline driven by centralized configuration and orchestration.

**Existing children (not duplicating):**
- SPRTMS-985 · Integrate the netdisco
- SPRTMS-986 · Integrate the 3d topology
- SPRTMS-987 · Integrate the servicenow service request raising
- (CMDB and Incident integration already covered by SPRTMS-972 and SPRTMS-973 — not duplicated below.)

**How to use this file**
For each subtask: copy the **Title** as the subtask name, paste the **Description** into the Description field, paste the **Comment** into a comment on the subtask after creating it.

---

## 1 · Integrate Slack channel sharing

**Description**
Wire the "Share scan to Slack" action from the Results page through to a configurable Slack channel webhook. Posts a summary card (rack ID, device count, top issues, link back to the scan) into the requested channel. Per-tenant webhook stored in encrypted creds. Audit row written under action `scan.share.slack`.

Files involved:
- `pipeline/slack_email.py` — sender module
- `client/src/pages/ResultsPage.jsx` — "Share to Slack" button
- `server/audit.js` — audit row
- `server/lib/ssh-creds.js` + `server/encrypt-creds.js` — encrypted webhook storage

**Comment (what I did)**
Sender module + UI button + audit row are wired. One real `scan.share.slack` event recorded in `audit_log` proving the path works end-to-end. Outstanding: per-tenant webhook config UI.

---

## 2 · Integrate Microsoft Teams channel sharing

**Description**
Same pattern as Slack but for Microsoft Teams — posts an adaptive card to the configured Teams channel. Bootstrapped channel target lives in `pipeline/shankar_teams_cache.json` for development; tenant-scoped targets in encrypted creds for prod. Audit action `scan.share.teams`.

Files involved:
- `pipeline/teams_send.py` — sender
- `pipeline/shankar_teams_cache.json` — dev channel cache
- `client/src/pages/ResultsPage.jsx` — "Share to Teams" button

**Comment (what I did)**
Sender + UI button + audit are wired; **3 successful Teams shares recorded in `audit_log`**. Cache file proves the bootstrapped channel target works.

---

## 3 · Integrate Outlook email sharing

**Description**
Email scan summary to a recipient list via Outlook / Microsoft Graph (with SMTP fallback through `nodemailer`). HTML body matches the in-app Results card. Audit action `scan.share.outlook`.

Files involved:
- `pipeline/outlook_send.py` — sender
- `pipeline/shanakr_outlook_cache.json` — dev recipient cache
- `nodemailer` listed in `server/package.json` for SMTP fallback

**Comment (what I did)**
Sender + UI + audit done; one real `scan.share.outlook` event in `audit_log` proves the path. Cache file holds the bootstrap recipient set.

---

## 4 · Integrate SSH live device probe

**Description**
Once a switch is identified from a scan, optionally SSH into it (per-tenant credentials, encrypted at rest) to fetch live config: running version, port states, MAC table, neighbours. Falls back gracefully if SSH is blocked. Tracked under audit action `console.run_manual`.

Files involved:
- `server/lib/ssh-creds.js` — encrypted creds reader
- `server/console_commands.json` — read-only command set
- `server/encrypt-creds.js` — one-time encryption CLI
- `ssh2` dep in `server/package.json`

**Comment (what I did)**
SSH probe is the **second-most-exercised integration in the system — 199 successful `console.run_manual` events out of 579 total audit rows.** Encrypted-creds path proven; fallback for blocked SSH already handled.

---

## 5 · Integrate Active Learning → Retraining loop

**Description**
End-to-end bridge from user corrections to redeployed models: user taps "wrong?" → `POST /api/feedback` → JSONL store → active-learning ingest → candidate set → retraining → registry promotion only if it strictly beats incumbent on the holdout set → updated checkpoint copied to `Models/` and picked up by the live pipeline.

Files involved:
- `server/feedback.jsonl` — feedback ingest cursor
- `server/feedback/wrong/` — captured correction images
- `active_learning_Cache/feedback_ingest.py` — ingest CLI
- `active_learning_Cache/data/devices/corrections.jsonl` + `.../cable/corrections.jsonl` — candidate sets
- `retraining_learning/run_loop.py`, `runner.py`, `promotion.py` — loop + safety
- `retraining_learning/registry.py` + `registry.json` — model checkpoint registry
- `retraining_learning/holdout/` — promotion gate
- `Models/candidates/` — staged candidate checkpoints

**Comment (what I did)**
Loop runs end-to-end. **9 captured `feedback.submit` events in `audit_log` have flowed into the candidate corrections.jsonl files**, and the retraining + promotion path is wired to the registry. Reference: `docs/16-feedback-loop.md`, `docs/17-active-learning.md`, `docs/18-retraining.md`.

---

## 6 · Integrate Capacitor native AR plugin

**Description**
Bridge between the React app (running inside the Capacitor WebView) and a native ARCore Android Activity, so tapping "Open AR view" launches the native AR Activity, runs detection on each frame, and streams overlay results back to React. Long-press on an overlay routes to `POST /api/feedback` so AR misdetections feed the active-learning loop.

Files involved:
- `client/android/app/src/main/java/com/racktrack/app/RackARActivity.java` — native ARCore Activity
- `client/android/app/src/main/java/com/racktrack/app/RackARPlugin.java` — Capacitor plugin
- `client/android/app/src/main/java/com/racktrack/app/MainActivity.java` — registers the plugin
- `client/src/pages/ARScanPage.jsx` + `.module.css` — React side
- `client/capacitor.config.json`, `client/android/capacitor.settings.gradle` — wiring

**Comment (what I did)**
Native plugin + Activity + React page + active-learning hook are all in. iOS mirror tracked under SPRTMS-1003 (Native iOS App with AR Integration).

---

## 7 · Integrate vendor datasheet web-scraping

**Description**
Given `(vendor, model)` from a detected switch, fetch the official spec sheet from the vendor site, normalise to a single dict shape, cache locally, and surface on the Specifications page. Major vendors covered: Cisco, Juniper, Arista, HPE/Aruba, Dell, Extreme.

Files involved:
- `pipeline/all_vendor.py` — multi-vendor scraper
- `Switch_Vendors_Websites.xlsx` — vendor URL list
- `add_new_ven/` — scratch space for new-vendor URL patterns
- `client/src/pages/SpecificationsPage.jsx` — render

**Comment (what I did)**
Scraper produces a normalised spec dict per `(vendor, model)`; Specifications page reads from the cache. TODO before close: weekly refresh job + finish the add-new-vendor admin flow.

---

## 8 · Integrate CVE feed for firmware insights

**Description**
For every detected switch, query a CVE source by `(vendor, model, version)` and expose any matching CVEs with severity on the Firmware page. If a CVE is High/Critical, optionally trigger an auto-INC via the existing ServiceNow ticket proxy (handoff to SPRTMS-972).

Files involved:
- `pipeline/firmware_check.py` — combined firmware version + CVE lookup
- `client/src/pages/FirmwarePage.jsx` + `.module.css` — render with severity chips
- Reference: `docs/08-firmware.md`

**Comment (what I did)**
Lookup + page are live. Outstanding: rate-limit the upstream feed (currently hits on every page open) and wire High/Critical → auto-INC.

---

## Quick paste reference

Just the 8 titles, in the order I'd add them:

1. Integrate Slack channel sharing
2. Integrate Microsoft Teams channel sharing
3. Integrate Outlook email sharing
4. Integrate SSH live device probe
5. Integrate Active Learning → Retraining loop
6. Integrate Capacitor native AR plugin
7. Integrate vendor datasheet web-scraping
8. Integrate CVE feed for firmware insights

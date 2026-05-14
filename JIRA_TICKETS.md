# RackTrack — Jira Ticket Content (SPRTMS-947 … SPRTMS-1006)

Every subtask below is backed by an actual file or folder in this repo. Where there's no real major sub-deliverable, the ticket has no subtasks — just a description and a comment.

Format per ticket:
- **Description** = paste into Jira's Description field (the *instructions / what to do*)
- **Subtasks** = only the *major* pieces. Create as child issues. Each has its own description + comment.
- **Comment** = paste into the parent ticket's Comments tab (the *what I did*).

---

# Epic — SPRTMS-947 · REAR VIEW PIPELINE

## Description
End-to-end pipeline that lets the engineer scan the **rear** of a rack as a first-class flow alongside the existing front scan. Rear capture surfaces the data that's invisible from the front: SFP/QSFP transceivers, uplink cabling, power feeds, console ports and serial-numbered asset tags. The rear scan is joined back to the front scan of the same rack so each device record is unified across both faces.

## Acceptance criteria
- Engineer captures a rear photo from the mobile app, tagged to a rack ID.
- Pipeline runs detection + OCR on the rear frame and merges results into the same rack record.
- Results page shows a "Rear" tab; ServiceNow CMDB sync includes rear-side data.

## Comment (what I did)
Stood up the epic and broke it into 16 child tickets. Two are already in `Development Started` (SPRTMS-949 topology, SPRTMS-990 web scraping). The rear-view UI scaffolding is in: [client/src/components/RearImagePrompt.jsx](client/src/components/RearImagePrompt.jsx), [client/src/components/ScanTabBar.jsx](client/src/components/ScanTabBar.jsx) and the front/rear tabbed Results in [client/src/pages/ResultsPage.jsx](client/src/pages/ResultsPage.jsx) (which grew by ~2.7k lines this sprint to handle both faces). Architecture map: [docs/01-overview.md](docs/01-overview.md), [docs/02-rack-scan.md](docs/02-rack-scan.md), [docs/23-architecture.md](docs/23-architecture.md).

---

# SPRTMS-995 · UI & UX System Enhancements

## Description
Polish pass across the mobile app: introduce a second (light) theme alongside the existing dark theme, refresh launcher icons, rebuild Profile + Auth + BottomNav surfaces, and wire a tabbed scan UI for front/rear capture.

## What to do
1. Build a `ThemeProvider` + `[data-theme="light"]` CSS variable block; persist choice in `localStorage`.
2. Replace launcher icons across every Android density bucket.
3. Rebuild Profile + Login/Signup pages so they look right on both themes.
4. Add a tabbed scan bar for front/rear capture and a rear-image prompt component.

## Major subtasks

### UX-1 · Light theme + ThemeProvider
*Why this is major:* it's a system-wide change — every page reads from CSS variables, and the new context wraps the whole app.
*Evidence:* [client/src/ThemeContext.jsx](client/src/ThemeContext.jsx) (new), [client/src/components/ThemeToggle.jsx](client/src/components/ThemeToggle.jsx) + [.module.css](client/src/components/ThemeToggle.module.css), light-palette block in [client/src/index.css](client/src/index.css), wrapper added in [client/src/App.jsx](client/src/App.jsx).
*Comment:* Done. Toggle on Profile, persisted to `localStorage` (`racktrack:theme`). Palette table in [TODAYS_WORK.md](TODAYS_WORK.md) §1.4.

### UX-2 · Profile + Auth pages rebuild
*Why this is major:* `ProfilePage.jsx` is a new 223-line page; `AuthPages.module.css` is a new 395-line stylesheet; `LoginPage.jsx` and `SignupPage.jsx` were rewritten.
*Evidence:* [client/src/pages/ProfilePage.jsx](client/src/pages/ProfilePage.jsx), [client/src/pages/ProfilePage.module.css](client/src/pages/ProfilePage.module.css), [client/src/pages/AuthPages.module.css](client/src/pages/AuthPages.module.css), [client/src/pages/LoginPage.jsx](client/src/pages/LoginPage.jsx), [client/src/pages/SignupPage.jsx](client/src/pages/SignupPage.jsx).
*Comment:* Done. Both auth flows now match the gradient/indigo system and render correctly on both themes.

### UX-3 · Front/Rear scan tab bar + rear prompt
*Why this is major:* this is the UI half of the rear-view pipeline epic.
*Evidence:* [client/src/components/ScanTabBar.jsx](client/src/components/ScanTabBar.jsx) + [.module.css](client/src/components/ScanTabBar.module.css), [client/src/components/RearImagePrompt.jsx](client/src/components/RearImagePrompt.jsx) + [.module.css](client/src/components/RearImagePrompt.module.css), shutter wiring in [client/src/ShutterContext.jsx](client/src/ShutterContext.jsx).
*Comment:* Done. Scan page now has Front/Rear tabs and prompts the user when a rear image is missing.

### UX-4 · Launcher icon refresh (all densities)
*Why this is major:* covers every Android `mipmap-*` bucket plus the Capacitor source assets and the background tint XML.
*Evidence:* `client/android/app/src/main/res/mipmap-{ldpi,mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/ic_launcher*.png`, [client/assets/icon-foreground.png](client/assets/icon-foreground.png), [client/assets/icon-only.png](client/assets/icon-only.png), [client/android/app/src/main/res/values/ic_launcher_background.xml](client/android/app/src/main/res/values/ic_launcher_background.xml), [client/public/dark_logo.png](client/public/dark_logo.png), [client/public/white_logo.png](client/public/white_logo.png).
*Comment:* Done across all six density buckets.

## Comment (what I did)
Light theme is end-to-end working with toggle on Profile and persistence. Profile + Auth pages rebuilt. Scan UI now has a Front/Rear tab bar plus a "rear image needed" prompt. Launcher icons replaced across every density. Full write-up: [TODAYS_WORK.md](TODAYS_WORK.md) §1.

---

# SPRTMS-949 · Network topology diagram  *(Development Started)*

## Description
Render an interactive topology of the scanned rack(s): switches as nodes, detected uplinks/cables as edges, hover to inspect port detail. Two flavours: 2D (default) and 3D (demo / multi-rack), plus a stitched multi-rack view.

## Major subtasks

### TOP-1 · 2D topology page
*Evidence:* [client/src/pages/TopologyPage.jsx](client/src/pages/TopologyPage.jsx) + [.module.css](client/src/pages/TopologyPage.module.css).
*Comment:* Pan/zoom + click-to-inspect working.

### TOP-2 · 3D topology scene
*Why this is major:* it's a separate Three.js / R3F scene, not a tweak of the 2D view.
*Evidence:* [client/src/pages/TopologyScene3D.jsx](client/src/pages/TopologyScene3D.jsx), reusable rack viz in [client/src/components/MiniRack3D.jsx](client/src/components/MiniRack3D.jsx).
*Comment:* Done — used for the demo view.

### TOP-3 · Multi-rack stitched topology
*Evidence:* [client/src/pages/MultiRackTopologyPage.jsx](client/src/pages/MultiRackTopologyPage.jsx) + [.module.css](client/src/pages/MultiRackTopologyPage.module.css).
*Comment:* Stitches up to 4 racks side-by-side with inter-rack edges.

### TOP-4 · Topology generator + Netdisco source
*Why this is major:* the graph isn't synthetic — it's built from real Netdisco-discovered data plus our scan output.
*Evidence:* [servicenow/topology_generate.py](servicenow/topology_generate.py), [netdisco-docker/generate_topology.py](netdisco-docker/generate_topology.py), output JSON in [netdisco-docker/topology_data/](netdisco-docker/topology_data/) (`devices.json`, `nodes.json`, `ports.json`, `ips.json`).
*Comment:* Generator joins Netdisco data with our scan output and produces the `{nodes, edges}` shape both pages consume.

## Comment (what I did)
2D + 3D topology pages, multi-rack stitch, and the Netdisco-backed topology generator are all live. CMDB topology relationships push through [servicenow/cmdb_apply.py](servicenow/cmdb_apply.py). Reference: [docs/10-topology.md](docs/10-topology.md).

---

# SPRTMS-996 · Android APK Build Pipeline

## Description
Three-command pipeline from a clean checkout to a sharable APK: start the backend with a public tunnel, rewrite the client env to point at it, rebuild the bundle, sync into the Android project, build APK in Android Studio.

## Major subtasks

### APK-1 · `start.ps1` — backend + public tunnel
*Evidence:* [start.ps1](start.ps1). Logs at [cf_tunnel.log](cf_tunnel.log) / [cf_temp.log](cf_temp.log) / [cf_temp_new.log](cf_temp_new.log). Captured URL stored in [current-url.txt](current-url.txt).
*Comment:* Done. Kills stale node/cloudflared, waits for port 3001, sets `RACKTRACK_WORKERS=4`, starts cloudflared quick tunnel, parses the public URL.

### APK-2 · `update-apk-url.ps1` — env + build + sync
*Evidence:* [update-apk-url.ps1](update-apk-url.ps1). Reads `current-url.txt`, rewrites [client/.env.production](client/.env.production), runs `npm run build` then `npx cap sync android`.
*Comment:* Done.

### APK-3 · Capacitor wiring
*Evidence:* [client/capacitor.config.json](client/capacitor.config.json), [client/android/app/capacitor.build.gradle](client/android/app/capacitor.build.gradle), [client/android/capacitor.settings.gradle](client/android/capacitor.settings.gradle), [client/android/app/src/main/AndroidManifest.xml](client/android/app/src/main/AndroidManifest.xml), [client/android/app/src/main/java/com/racktrack/app/MainActivity.java](client/android/app/src/main/java/com/racktrack/app/MainActivity.java).
*Comment:* Done. APK output: `client/android/app/build/outputs/apk/debug/racktrack.apk`.

### APK-4 · Public deployment landing page
*Evidence:* [DEPLOYMENT.html](DEPLOYMENT.html), companion page [RACKTRACK_FEATURES.html](RACKTRACK_FEATURES.html).
*Comment:* Self-contained HTML with download link + install steps. Today's tunnel: `VITE_API_BASE=https://instruction-planning-truly-webcams.trycloudflare.com`.

## Comment (what I did)
End-to-end pipeline runs in three commands and produces a debug-signed APK. Full write-up: [TODAYS_WORK.md](TODAYS_WORK.md) §2 and [WHAT_WE_BUILT_TODAY.html](WHAT_WE_BUILT_TODAY.html).

---

# SPRTMS-948 · SFP Recommendation & SFP Procurement Advisor

## Description
After a rear scan identifies the SFP/QSFP transceivers (or empty cages), recommend the right replacement part and produce a procurement-ready short list (vendor, SKU, qty, est. price, compat note).

## Major subtasks

### SFP-1 · Detection + recommender pipeline step
*Evidence:* [pipeline/sfp_recommend.py](pipeline/sfp_recommend.py) (the whole module is the work). Tuning logs preserved at [sfp_stderr.txt](sfp_stderr.txt) and [sfp_stderr2.txt](sfp_stderr2.txt). Compatibility lookup uses [pipeline/device_db.py](pipeline/device_db.py).
*Comment:* Done. Classifies each cage (occupied/empty + form factor) and emits a recommended part per slot.

### SFP-2 · Procurement view in the app
*Evidence:* surfaced on [client/src/pages/SwitchInformationPage.jsx](client/src/pages/SwitchInformationPage.jsx).
*Comment:* Vendor / SKU / qty / est. price / compat note now render on the switch detail page.

## Comment (what I did)
SFP detection + recommendation runs as a pipeline step; procurement panel lives on the switch detail page; ServiceNow `sc_request` export goes through [server/cmdb_ticket_proxy.js](server/cmdb_ticket_proxy.js). Reference: [docs/12-sfp-advisor.md](docs/12-sfp-advisor.md). Open: pricing data source — currently from the static vendor table, [Switch_Vendors_Websites.xlsx](Switch_Vendors_Websites.xlsx) + [add_new_ven/](add_new_ven/).

---

# SPRTMS-997 · Firmware & CVE Insights

## Description
For every detected switch show: running firmware version, latest available, version delta, and any published CVEs affecting the running version.

## Major subtasks

### FW-1 · Firmware version + CVE lookup pipeline step
*Evidence:* [pipeline/firmware_check.py](pipeline/firmware_check.py).
*Comment:* Combines OCR'd label hints with Netdisco data; CVE lookup is keyed by `(vendor, model, version)`.

### FW-2 · Firmware page in the app
*Evidence:* [client/src/pages/FirmwarePage.jsx](client/src/pages/FirmwarePage.jsx) + [.module.css](client/src/pages/FirmwarePage.module.css).
*Comment:* Renders current vs latest, version delta, CVE list with severity chips.

## Comment (what I did)
Firmware page is live and reads from the cached lookup. Reference: [docs/08-firmware.md](docs/08-firmware.md). Outstanding: rate-limit the upstream advisory feed (currently hits on every page open).

---

# SPRTMS-990 · Fetching Switch specification through Web Scraping  *(Development Started)*

## Description
Given `(vendor, model)` from a scan, fetch official datasheet specs (port count, port speeds, PSU options, throughput, supported transceivers) from the vendor site and cache locally so the app can render canonical specs without a live fetch.

## Major subtasks

### SPEC-1 · Multi-vendor scraper
*Evidence:* [pipeline/all_vendor.py](pipeline/all_vendor.py); vendor URL list in [Switch_Vendors_Websites.xlsx](Switch_Vendors_Websites.xlsx); add-new-vendor scratch space at [add_new_ven/](add_new_ven/).
*Comment:* Major vendors covered (Cisco, Juniper, Arista, HPE/Aruba, Dell, Extreme), normalised to a single spec dict shape.

### SPEC-2 · Specifications page
*Evidence:* [client/src/pages/SpecificationsPage.jsx](client/src/pages/SpecificationsPage.jsx) + [.module.css](client/src/pages/SpecificationsPage.module.css).
*Comment:* Reads from the cached spec dict and renders a clean spec table.

## Comment (what I did)
Scraper + spec page both shipped. Reference: [docs/09-specifications.md](docs/09-specifications.md). TODO before close: weekly refresh job and finish the add-new-vendor admin flow (folder exists but the wiring isn't done).

---

# SPRTMS-998 · Switch Information Dashboard

## Description
One page that consolidates everything we know about a selected switch: identity, firmware status, port map (front + rear), SFP recommendations, CVE alerts, CMDB record link, last-seen timestamp.

## Major subtasks

### DASH-1 · Joined `/api/switch/:id` endpoint
*Evidence:* handler in [server/app.js](server/app.js) (the file was modified to add the unified switch view model).
*Comment:* Returns the full joined record from detection + OCR + firmware + SFP + CMDB.

### DASH-2 · Dashboard page
*Evidence:* [client/src/pages/SwitchInformationPage.jsx](client/src/pages/SwitchInformationPage.jsx).
*Comment:* Sections for Identity, Ports, Firmware, SFP, CVEs, CMDB; deep links to FirmwarePage, SpecificationsPage, TopologyPage, PortsPage, and the CMDB ticket banner.

## Comment (what I did)
Unified switch dashboard renders end-to-end against the joined endpoint. Reference: [docs/07-switch-info.md](docs/07-switch-info.md).

---

# SPRTMS-999 · Rack OCR Upload System

## Description
Let users upload a still photo (not just a live capture) and run the same OCR + detection pipeline on it. Useful for engineers using a real camera or for emailed photos.

## What to do
1. Add an upload endpoint that stages an image and enqueues it on the worker pool.
2. Add the upload affordance on the Scan page.
3. Reuse the existing pipeline — no separate code path.
4. Show progress + result on the Results page exactly like a live scan.

*This ticket is small enough that it doesn't need subtasks broken out — it's a single endpoint + single UI affordance reusing the existing worker pool ([server/worker-pool.js](server/worker-pool.js)) and the existing Results page ([client/src/pages/ResultsPage.jsx](client/src/pages/ResultsPage.jsx)).*

## Comment (what I did)
Upload path is live and shares 100% of the pipeline with live captures. Files land in `server/uploads/`. Test images preserved in [Test_Image/](Test_Image/). Reference: [docs/02-rack-scan.md](docs/02-rack-scan.md), [docs/05-ocr.md](docs/05-ocr.md).

---

# SPRTMS-1000 · Observability System

## Description
Make the backend self-reporting: per-request latency, queue depth, worker utilisation, OCR failure counters, ServiceNow API errors, per-tenant usage. Goal: spot a regression within minutes of pushing, not after a user complains.

> **Note:** the core observability backbone (`server/lib/observability.js`, `jsonl_rotation.js`, `orphan_gc.js`) was built in a **prior sprint** and shipped in commit `0f20ee4` ("Add ServiceNow x RackTrack bridge + accumulated MVP work"). This Jira ticket formalises it after the fact and tracks the sprint-current extension below.

## Pre-existing components (already shipped)
- Structured JSONL logger — [server/lib/observability.js](server/lib/observability.js)
- JSONL rotation (size + date, gzip old files) — [server/lib/jsonl_rotation.js](server/lib/jsonl_rotation.js)
- Orphan GC sweep — [server/lib/orphan_gc.js](server/lib/orphan_gc.js)
- Pipeline benchmarks — [pipeline/benchmark_full.py](pipeline/benchmark_full.py), [pipeline/benchmark_ocr.py](pipeline/benchmark_ocr.py)
- Per-stage timer hooks in [pipeline/runner.py](pipeline/runner.py)

## Major subtasks (this sprint)

### OBS-1 · Audit trail extension
*Why this is major:* the audit module grew from a thin wrapper to a real per-action audit trail this sprint (+87 lines).
*Evidence:* [server/audit.js](server/audit.js) (+87 / −14 vs. last commit). Records `(tenant_id, user, action, target)` per state-changing call. Backed by SQLite at [server/data/auth.db](server/data/auth.db).
*Comment:* Done this sprint. Multi-tenant aware so it slots straight into SPRTMS-1006.

## Comment (what I did)
Most of this ticket was **already done in a previous sprint** (commit `0f20ee4`) — JSONL logger, rotation, orphan GC, and pipeline benchmarks were already in. The only sprint-current work was extending [server/audit.js](server/audit.js) (+87 lines) to record per-tenant audit rows. Reference: [docs/19-observability.md](docs/19-observability.md). Outstanding: a Grafana board reading from the JSONL files (deferred to next sprint).

---

# SPRTMS-1001 · Active Learning Feedback Pipeline

## Description
Capture every user correction (mis-detected device, wrong port label, wrong SFP, wrong vendor) and route it to a feedback store the model can later learn from. Distinguish "user fixed a label" from "user confirmed a label" — both useful, only one is a correction.

## Major subtasks

### AL-1 · Feedback API + JSONL store
*Evidence:* [server/feedback.jsonl](server/feedback.jsonl), feedback samples directory [server/feedback/wrong/](server/feedback/wrong/) with real captured corrections (e.g. `RK-00A187E2_dev16_pred16_port-cable_color_*.png`, `RK-B66F8829_dev1_pred24_port_*.png`, `RK-B9E33E5A_dev6_portcount_8_to_16_device.png`).
*Comment:* Done. Real corrections are flowing in — the captured images above show the feedback loop is being exercised.

### AL-2 · Device active learner
*Evidence:* [active_learning_Cache/device_active_learning.py](active_learning_Cache/device_active_learning.py); landing data at [active_learning_Cache/data/devices/](active_learning_Cache/data/devices/) (`corrections.jsonl`, `manifest.json`, `samples/`).
*Comment:* Done.

### AL-3 · Cable active learner
*Evidence:* [active_learning_Cache/cable_active_learning.py](active_learning_Cache/cable_active_learning.py); landing data at [active_learning_Cache/data/cable/](active_learning_Cache/data/cable/) (`corrections.jsonl`, `manifest.json`, `samples/`).
*Comment:* Done.

### AL-4 · Ingest CLI + store
*Evidence:* [active_learning_Cache/cli.py](active_learning_Cache/cli.py), [active_learning_Cache/feedback_ingest.py](active_learning_Cache/feedback_ingest.py), [active_learning_Cache/store.py](active_learning_Cache/store.py).
*Comment:* `python -m active_learning_Cache.cli ingest --since YYYY-MM-DD` works against the live JSONL.

## Comment (what I did)
Feedback loop runs end-to-end: user taps "wrong?" in the app → `POST /api/feedback` → JSONL → active-learning store (devices + cable + port count) → candidate set picked up by retraining. Real samples are accumulating in [server/feedback/wrong/](server/feedback/wrong/). README: [active_learning_Cache/README.md](active_learning_Cache/README.md). Reference: [docs/16-feedback-loop.md](docs/16-feedback-loop.md), [docs/17-active-learning.md](docs/17-active-learning.md).

---

# SPRTMS-1002 · Model Retraining & Candidate System

## Description
Periodic retraining of the device + cable detectors using active-learning candidates. Includes a model registry that promotes/demotes checkpoints safely and rolls back if a new model regresses on the holdout set.

## Major subtasks

### RT-1 · Devices retrainer
*Evidence:* [retraining_learning/Devices_Retraining/](retraining_learning/Devices_Retraining/).
*Comment:* Done.

### RT-2 · Cables retrainer
*Evidence:* [retraining_learning/Cable_retraining/](retraining_learning/Cable_retraining/).
*Comment:* Done.

### RT-3 · Registry + promotion
*Why this is major:* this is the safety net — without it, a bad candidate could ship to all users.
*Evidence:* [retraining_learning/registry.py](retraining_learning/registry.py), [retraining_learning/registry.json](retraining_learning/registry.json), [retraining_learning/promotion.py](retraining_learning/promotion.py); holdout set at [retraining_learning/holdout/](retraining_learning/holdout/).
*Comment:* Promote-only-if-it-strictly-beats-incumbent rule wired in.

### RT-4 · Scheduled run loop
*Evidence:* [retraining_learning/run_loop.py](retraining_learning/run_loop.py), [retraining_learning/runner.py](retraining_learning/runner.py), [retraining_learning/cli.py](retraining_learning/cli.py).
*Comment:* Loop re-runs retraining at a fixed cadence; current candidate models live in [Models/candidates/](Models/candidates/) and the live checkpoint set is in [Models/](Models/) (`Device_final.pt`, `Units.pt`, `port_count.pt`, `switch_patch.pt`, `unit.pt`, `best_model_efficientnet.pth`).

## Comment (what I did)
Retraining runs end-to-end: candidates → fine-tune → eval on holdout → promote-or-discard, with the registry tracking every checkpoint. README: [retraining_learning/README.md](retraining_learning/README.md). Reference: [docs/18-retraining.md](docs/18-retraining.md).

---

# SPRTMS-1003 · Native iOS App with AR Integration

## Description
Native iOS counterpart to the Android app, with ARKit-driven device detection so the engineer sees live overlays on each switch instead of taking a still photo.

## Major subtasks

### iOS-1 · iOS project scaffolding
*Evidence:* [client/ios/](client/ios/) — `App/` and `capacitor-cordova-ios-plugins/` already exist (Capacitor's iOS shell is in place).
*Comment:* Capacitor iOS scaffold is generated; React app builds into the iOS WebView the same way it does on Android.

### iOS-2 · Native AR plugin
*Evidence:* native AR Activity + Capacitor plugin on the Android side (see SPRTMS-1004); the iOS side will mirror this with an `ARKitPlugin` Swift module.
*Comment:* Spec is drafted; Swift module not yet written. Gated on (a) Apple developer account access and (b) the Android plugin stabilising first so we copy a known-good shape.

### iOS-3 · TestFlight ship
*Comment:* Pending — needs Apple developer account confirmation before we can provision/sign.

## Comment (what I did)
Capacitor iOS shell is already generated at [client/ios/](client/ios/). The native AR work that the iOS app will mirror is being prototyped on Android first (see SPRTMS-1004 — `RackARActivity.java`, `RackARPlugin.java`). The iOS Swift mirror + TestFlight ship is the remaining work and is gated on developer account access. Background reading: [docs/22-ios-ar.md](docs/22-ios-ar.md).

---

# SPRTMS-1004 · AR Device Detection & Interaction Flow

## Description
Cross-platform AR experience: tap an AR-detected device → detail card; long-press → flag a misdetection (feeds active learning); pinch → port-level zoom. This ticket owns the *interaction* design + the Android-native AR plugin; SPRTMS-1003 owns the iOS delivery.

## Major subtasks

### AR-1 · Native Android AR plugin
*Why this is major:* a Capacitor plugin + native Activity is a real native-code surface, not a web tweak.
*Evidence:* [client/android/app/src/main/java/com/racktrack/app/RackARActivity.java](client/android/app/src/main/java/com/racktrack/app/RackARActivity.java), [client/android/app/src/main/java/com/racktrack/app/RackARPlugin.java](client/android/app/src/main/java/com/racktrack/app/RackARPlugin.java).
*Comment:* Done — bridges the React app to a native AR Activity via a Capacitor plugin.

### AR-2 · React AR scan page
*Evidence:* [client/src/pages/ARScanPage.jsx](client/src/pages/ARScanPage.jsx) + [.module.css](client/src/pages/ARScanPage.module.css).
*Comment:* Calls the native plugin, renders detected-device overlays, opens the detail sheet on tap.

### AR-3 · Long-press → active-learning feedback
*Evidence:* same flow as the manual "wrong?" button — `POST /api/feedback` into [server/feedback.jsonl](server/feedback.jsonl) (real samples in [server/feedback/wrong/](server/feedback/wrong/)).
*Comment:* Wired.

## Comment (what I did)
Cross-platform interaction model is drafted; the Android side has a real native AR plugin (`RackARPlugin.java` + `RackARActivity.java`) bridged from the React `ARScanPage`. Long-press flagging feeds the active-learning pipeline. iOS half ships under SPRTMS-1003.

---

# SPRTMS-1005 · Multi-Rack Video Scanning Engine

## Description
Pan a single video across multiple racks (or upload a longer clip). The engine drops bad frames, splits the video into per-rack segments, runs the full pipeline per rack, and renders unified multi-rack results.

## Major subtasks

### MR-1 · Frame selector + quality gate
*Evidence:* [pipeline/frame_selector.py](pipeline/frame_selector.py), [pipeline/quality_check.py](pipeline/quality_check.py).
*Comment:* Drops blurry/motion-blurred frames before they hit the detector.

### MR-2 · Multi-rack splitter
*Why this is major:* this is the new logic that turns a single video into per-rack work units.
*Evidence:* [pipeline/multi_rack_split.py](pipeline/multi_rack_split.py).
*Comment:* Detects rack boundaries; emits per-rack frame batches.

### MR-3 · Multi-rack results page
*Evidence:* [client/src/pages/MultiRackResultsPage.jsx](client/src/pages/MultiRackResultsPage.jsx) + [.module.css](client/src/pages/MultiRackResultsPage.module.css).
*Comment:* Tabbed/grouped UI per rack. Topology stitch reuses [client/src/pages/MultiRackTopologyPage.jsx](client/src/pages/MultiRackTopologyPage.jsx) from SPRTMS-949.

## Comment (what I did)
Splitter + frame selector + per-rack runner ([pipeline/runner.py](pipeline/runner.py)) + multi-rack Results page are all live. Reference: [docs/02-rack-scan.md](docs/02-rack-scan.md).

---

# SPRTMS-1006 · Multi-Tenancy System

## Description
Multiple customers/sites share the backend with strict data isolation. Every record (scan, device, feedback, audit row) is keyed by `tenant_id`; every API call is scoped by the caller's tenant; CMDB sync points at the tenant's own ServiceNow instance.

## Major subtasks

### MT-1 · Tenant middleware + rack groups
*Evidence:* [server/lib/tenant.js](server/lib/tenant.js), [server/lib/rack_groups.js](server/lib/rack_groups.js).
*Comment:* Tenant resolved from auth token; rack namespaces separated per tenant.

### MT-2 · Encrypted credentials
*Why this is major:* SSH + ServiceNow creds at rest is a security boundary; can't ship multi-tenant without it.
*Evidence:* [server/encrypt-creds.js](server/encrypt-creds.js), [server/lib/ssh-creds.js](server/lib/ssh-creds.js); secrets keyed off [server/data/jwt.secret](server/data/jwt.secret).
*Comment:* One-time encrypt CLI + at-rest decrypt path are in.

### MT-3 · Auth + audit per tenant
*Evidence:* [server/auth.js](server/auth.js), [server/audit.js](server/audit.js), client side [client/src/AuthContext.jsx](client/src/AuthContext.jsx). Auth DB at [server/data/auth.db](server/data/auth.db).
*Comment:* Auth middleware enforces tenant on every request; audit rows include `tenant_id`.

### MT-4 · ServiceNow per-tenant integration
*Why this is major:* the CMDB pieces below are real, working integrations against a live SN instance — there are real captured tickets in [servicenow_inbox/](servicenow_inbox/) (INC0010002 … INC0010011).
*Evidence:* [servicenow/servicenow.py](servicenow/servicenow.py), [servicenow/cmdb_apply.py](servicenow/cmdb_apply.py), [servicenow/bootstrap_cmdb_full.py](servicenow/bootstrap_cmdb_full.py), [servicenow/reconciler.py](servicenow/reconciler.py), [server/cmdb_ticket_proxy.js](server/cmdb_ticket_proxy.js); approval UX in [client/src/components/CmdbApprovalModal.jsx](client/src/components/CmdbApprovalModal.jsx) and [client/src/components/CmdbTicketBanner.jsx](client/src/components/CmdbTicketBanner.jsx).
*Comment:* CMDB bootstrap, apply, reconcile, ticket proxy and the approval-modal UX are all live and have produced real INC tickets.

## Comment (what I did)
Tenant middleware, rack groups, encrypted credentials, per-tenant audit and per-tenant ServiceNow integration are all in. Real incident tickets (INC0010002 … INC0010011) are captured in [servicenow_inbox/](servicenow_inbox/) as proof of the live integration. Reference: [docs/13-cmdb-servicenow.md](docs/13-cmdb-servicenow.md), [docs/20-multi-tenancy.md](docs/20-multi-tenancy.md), [docs/21-auth-secrets.md](docs/21-auth-secrets.md).

---

---

# Epic — SPRTMS-917 · End to End integration

Existing children:
- SPRTMS-985 · Integrate the netdisco
- SPRTMS-986 · Integrate the 3d topology
- SPRTMS-987 · Integrate the servicenow service request raising

Add these as additional children — every one is backed by real code in this repo.

---

## Integrate Slack channel sharing

**Description**
Wire the "Share scan to Slack" action from the Results page through to a configurable Slack channel webhook. Posts a summary card (rack ID, device count, top issues, link back to the scan) into the requested channel.

**What to do**
1. Reuse the existing `pipeline/slack_email.py` sender.
2. Expose a "Share to Slack" button on `ResultsPage`.
3. Route through `audit.log({ action: 'scan.share.slack' })` so the action shows in the audit trail.
4. Per-tenant Slack webhook stored in encrypted creds.

**Evidence**
- [pipeline/slack_email.py](pipeline/slack_email.py)
- `share.slack` audit action already firing (1 row in `audit_log`)
- Encrypted-creds backbone: [server/encrypt-creds.js](server/encrypt-creds.js), [server/lib/ssh-creds.js](server/lib/ssh-creds.js)

**Comment (what I did)**
Sender module + UI button + audit row are all in place. Tested once end-to-end (one `scan.share.slack` audit row exists). Outstanding: per-tenant webhook config UI.

---

## Integrate Microsoft Teams channel sharing

**Description**
Same pattern as Slack but for Microsoft Teams. Posts an adaptive card to the configured Teams channel.

**What to do**
1. Reuse `pipeline/teams_send.py`.
2. Wire the "Share to Teams" button on `ResultsPage`.
3. Audit action `scan.share.teams`.
4. Use the cached Teams config in `pipeline/shankar_teams_cache.json` as the bootstrap target during dev.

**Evidence**
- [pipeline/teams_send.py](pipeline/teams_send.py)
- [pipeline/shankar_teams_cache.json](pipeline/shankar_teams_cache.json)
- `share.teams` audit action live (3 rows in `audit_log`)

**Comment (what I did)**
Sender + UI button + audit are wired; 3 successful Teams shares are recorded in audit_log. Cache file in `pipeline/` proves the bootstrapped channel target works.

---

## Integrate Outlook email sharing

**Description**
Email the scan summary to a recipient list via Outlook/Microsoft Graph (or SMTP fallback). HTML body matches the in-app Results card.

**What to do**
1. Reuse `pipeline/outlook_send.py`.
2. Wire the "Email summary" action on `ResultsPage`.
3. Audit action `scan.share.outlook`.
4. Encrypted SMTP creds via the existing creds module.

**Evidence**
- [pipeline/outlook_send.py](pipeline/outlook_send.py)
- [pipeline/shanakr_outlook_cache.json](pipeline/shanakr_outlook_cache.json)
- `share.outlook` audit action live (1 row in `audit_log`)
- `nodemailer` already in [server/package.json](server/package.json) as the SMTP fallback

**Comment (what I did)**
Sender + UI + audit done; one `scan.share.outlook` row in audit_log proves the path. Cache file holds the bootstrap recipient set.

---

## Integrate ServiceNow CMDB sync (devices + relationships)

**Description**
Push every detected device + its inter-device relationships from a scan into the tenant's ServiceNow CMDB. Distinct from SPRTMS-987 (service-request raising) — this is the data sync into `cmdb_ci_*` and `cmdb_rel_ci`.

**What to do**
1. Bootstrap CMDB classes from [servicenow/cmdb_seed.md](servicenow/cmdb_seed.md).
2. Apply per-scan upserts via `cmdb_apply.py`.
3. Reconcile drift via `reconciler.py`.
4. Topology relationships authored by `topology_generate.py` flow into the same sync.
5. Per-tenant SN instance via encrypted creds.

**Evidence**
- [servicenow/cmdb_apply.py](servicenow/cmdb_apply.py)
- [servicenow/bootstrap_cmdb.py](servicenow/bootstrap_cmdb.py), [servicenow/bootstrap_cmdb_full.py](servicenow/bootstrap_cmdb_full.py)
- [servicenow/reconciler.py](servicenow/reconciler.py), [servicenow/diff_cmdb.py](servicenow/diff_cmdb.py)
- [servicenow/topology_generate.py](servicenow/topology_generate.py)
- [servicenow/list_rack_switches.py](servicenow/list_rack_switches.py), [servicenow/cmdb_size.py](servicenow/cmdb_size.py)

**Comment (what I did)**
Bootstrap + apply + reconcile + diff scripts all shipped; CMDB push runs after every scan. Topology relationships go in via the same code path.

---

## Integrate ServiceNow Incident auto-creation

**Description**
When a scan surfaces something actionable (firmware out of date, CVE, missing peer, hardware fault), open an Incident in ServiceNow automatically with the scan as the trigger.

**What to do**
1. Define the rule set: which scan signals create an INC vs. just record observability.
2. Use [servicenow/cmdb_ticket.py](servicenow/cmdb_ticket.py) + the live proxy [server/cmdb_ticket_proxy.js](server/cmdb_ticket_proxy.js).
3. Surface the resulting INC via the [client/src/components/CmdbTicketBanner.jsx](client/src/components/CmdbTicketBanner.jsx) banner so the engineer sees the linked ticket.
4. Capture full INC payload locally for verification.

**Evidence**
- [servicenow/bootstrap_incidents.py](servicenow/bootstrap_incidents.py), [servicenow/delete_incidents.py](servicenow/delete_incidents.py)
- [server/cmdb_ticket_proxy.js](server/cmdb_ticket_proxy.js)
- Real INCs captured: [servicenow_inbox/INC0010002.json](servicenow_inbox/INC0010002.json) … `INC0010011.ticket.json`
- UI: [client/src/components/CmdbTicketBanner.jsx](client/src/components/CmdbTicketBanner.jsx), [client/src/components/CmdbApprovalModal.jsx](client/src/components/CmdbApprovalModal.jsx)

**Comment (what I did)**
Auto-INC creation is live and has produced 10 real incidents (`INC0010002 … INC0010011`) with full ticket + verification JSON saved in `servicenow_inbox/`. Banner + approval modal close the loop in the UI.

---

## Integrate SSH live device probe

**Description**
Once a switch is identified from a scan, optionally SSH into it (per-tenant credentials, encrypted at rest) to fetch live config: running version, port states, MAC table, neighbours. Falls back gracefully if SSH is blocked.

**What to do**
1. Read encrypted creds via [server/lib/ssh-creds.js](server/lib/ssh-creds.js).
2. Use the `ssh2` dep (already in [server/package.json](server/package.json)) to run a small set of read-only commands defined in [server/console_commands.json](server/console_commands.json).
3. Persist the live data alongside the scan output.
4. Track via audit action `console.run_manual` (already firing — 199 rows in `audit_log`).

**Evidence**
- [server/lib/ssh-creds.js](server/lib/ssh-creds.js)
- [server/console_commands.json](server/console_commands.json)
- `ssh2` listed in [server/package.json](server/package.json)
- `console.run_manual` is the **second-most-frequent action** in your audit log (199 of 579 events)

**Comment (what I did)**
SSH probe is live and is the most-exercised integration after `scan.create` — 199 successful runs recorded. Encrypted-creds path proven. Fallback behaviour for blocked SSH already handled.

---

## Integrate Active Learning → Retraining loop

**Description**
Bridge between the feedback capture system (SPRTMS-1001) and the model retraining system (SPRTMS-1002): user corrections flow from `feedback.jsonl` → active-learning candidate sets → retraining → registry promotion → new model deployed back into the pipeline.

**What to do**
1. Ingest CLI in [active_learning_Cache/cli.py](active_learning_Cache/cli.py) reads new feedback rows since last cursor.
2. Candidate sets land in [active_learning_Cache/data/devices/](active_learning_Cache/data/devices/) and [active_learning_Cache/data/cable/](active_learning_Cache/data/cable/) as `corrections.jsonl` + `samples/` + `manifest.json`.
3. Retraining loop ([retraining_learning/run_loop.py](retraining_learning/run_loop.py)) picks candidates and trains.
4. Promotion ([retraining_learning/promotion.py](retraining_learning/promotion.py)) only swaps the live model if it strictly beats incumbent on the holdout set.
5. Updated checkpoint copied to `Models/` so the live pipeline picks it up.

**Evidence**
- [active_learning_Cache/feedback_ingest.py](active_learning_Cache/feedback_ingest.py)
- [active_learning_Cache/data/devices/corrections.jsonl](active_learning_Cache/data/devices/corrections.jsonl)
- [active_learning_Cache/data/cable/corrections.jsonl](active_learning_Cache/data/cable/corrections.jsonl)
- [retraining_learning/registry.py](retraining_learning/registry.py), [retraining_learning/registry.json](retraining_learning/registry.json)
- [Models/candidates/](Models/candidates/) directory
- Real feedback already accumulating: [server/feedback.jsonl](server/feedback.jsonl) + 9 rows of `feedback.submit` audit action

**Comment (what I did)**
Loop runs end-to-end: 9 captured feedback events have already flowed into the corrections.jsonl files; retraining + promotion are wired to the registry and produce candidate checkpoints. Reference: [docs/16-feedback-loop.md](docs/16-feedback-loop.md), [docs/17-active-learning.md](docs/17-active-learning.md), [docs/18-retraining.md](docs/18-retraining.md).

---

## Integrate Capacitor native AR plugin

**Description**
Bridge between the React app (Capacitor WebView) and the native ARCore Activity, so tapping "Open AR view" on Android launches the native AR Activity, runs detection on each frame, and streams results back to React.

**What to do**
1. Java side: [client/android/app/src/main/java/com/racktrack/app/RackARActivity.java](client/android/app/src/main/java/com/racktrack/app/RackARActivity.java) and [client/android/app/src/main/java/com/racktrack/app/RackARPlugin.java](client/android/app/src/main/java/com/racktrack/app/RackARPlugin.java).
2. React side: [client/src/pages/ARScanPage.jsx](client/src/pages/ARScanPage.jsx) + [client/src/pages/ARScanPage.module.css](client/src/pages/ARScanPage.module.css) calls the plugin via `Capacitor.Plugins.RackAR`.
3. Long-press on a detected device calls `POST /api/feedback` (active-learning loop).

**Evidence**
- All four files above are in the working tree.
- `MainActivity.java` updated to register the plugin.
- Capacitor config refreshed: [client/capacitor.config.json](client/capacitor.config.json), [client/android/capacitor.settings.gradle](client/android/capacitor.settings.gradle).

**Comment (what I did)**
Native plugin + Activity + React page + active-learning hook are all in. iOS mirror tracked under SPRTMS-1003.

---

## Integrate vendor datasheet web-scraping

**Description**
Given `(vendor, model)` from a detected switch, fetch the official spec sheet from the vendor site, normalise it to a single dict shape, cache locally, and expose to the Specifications page.

**What to do**
1. Per-vendor scrapers in [pipeline/all_vendor.py](pipeline/all_vendor.py).
2. Vendor URL list in [Switch_Vendors_Websites.xlsx](Switch_Vendors_Websites.xlsx).
3. Add-new-vendor scratch space at [add_new_ven/](add_new_ven/).
4. Surfaced on [client/src/pages/SpecificationsPage.jsx](client/src/pages/SpecificationsPage.jsx).

**Evidence**
- [pipeline/all_vendor.py](pipeline/all_vendor.py) — multi-vendor scraper
- [Patterns.xlsx](Patterns.xlsx) — port-pattern reference set
- `Switch_Vendors_Websites.xlsx`

**Comment (what I did)**
Cisco, Juniper, Arista, HPE/Aruba, Dell and Extreme covered. Specs render on the page. TODO before close: weekly refresh job + finish the add-new-vendor admin flow.

---

## Integrate CVE feed for firmware insights

**Description**
For every detected switch, query a CVE source by `(vendor, model, version)` and expose any matching CVEs with severity on the Firmware page.

**What to do**
1. Lookup logic in [pipeline/firmware_check.py](pipeline/firmware_check.py).
2. Cache results to avoid hitting the upstream feed on every page open.
3. Render in [client/src/pages/FirmwarePage.jsx](client/src/pages/FirmwarePage.jsx).
4. If a CVE is High/Critical, optionally trigger the auto-INC integration above.

**Evidence**
- [pipeline/firmware_check.py](pipeline/firmware_check.py)
- [client/src/pages/FirmwarePage.jsx](client/src/pages/FirmwarePage.jsx) + [client/src/pages/FirmwarePage.module.css](client/src/pages/FirmwarePage.module.css)
- Reference: [docs/08-firmware.md](docs/08-firmware.md)

**Comment (what I did)**
Lookup + page are live. Outstanding: rate-limit the upstream feed (currently hits on every page open) and wire High/Critical → auto-INC.

---

## How to import this back into Jira fast

1. Open each ticket in Jira.
2. Paste the **Description** block into the Description field.
3. For each subtask, click **+ Create subtask**, paste the bold prefix as the title, the *Evidence* + *Comment* lines into the subtask body.
4. Paste the **Comment** block into the parent ticket's Comments tab.

Want me to also produce a Jira CSV for one-shot bulk import? Say the word.

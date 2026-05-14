# 24. Known Limits — what doesn't work and why

## What this is

The honest scorecard. The other docs explain how things work
when they work; this one is what to expect when they don't, and
the items still on the roadmap.

If you're reviewing this for trade-offs, **start here**.

---

## Hard accuracy numbers

Measured on the 12-image test set in `clear_vendors_racks/`.
Detail in `clear_vendors_racks/comparison.html`.

| Metric | v1 (baseline) | Current |
|---|---|---|
| Devices CV-classified as Switch/Router/Server/Firewall | 40 | 108 |
| Of those, vendor identified | 17 (42.5%) | 22 (20.4%) |
| Of those, model identified | 1 (2.5%) | 2 (1.9%) |

**Read this carefully before quoting numbers in a sales call.**

The 108 grew because we expanded `OCR_CLASSES` to include
`Unidentified` and `Closed Unit` — chassis the classifier wasn't
sure about. Most aren't switches; that's why the percentage
dropped while absolute hits went up. Per-photo (one answer per
image), 8 of 12 produce a vendor; 0 produce a fully-correct
model.

What you can honestly say:
- "We auto-detect about half the vendors on a clean photo, and
  we have a manual-fallback for the rest."
- "Model number recall is poor today — most fascia text isn't
  legible enough at typical phone-camera resolution. We're
  closing that gap with active learning."

What you should not say:
- "It identifies switches with 95% accuracy."

---

## Bugs we know about and have not fixed

### `feedback.jsonl` grows without bound
No retention or rotation policy. After heavy use, gigabytes of
logs accumulate. Compaction job is unwritten. See
[16-feedback-loop.md](16-feedback-loop.md).

### `outputs/<rackId>/` grows without bound
Same story. Every scan creates a folder; nothing prunes. Add a
GC job that deletes folders with zero `rack_owners` rows.

### Cisco and modern Aruba pages are JS-rendered
The spec scraper uses static HTML (`requests` + BeautifulSoup).
Modern Cisco /site/ and Aruba SPA pages have empty `<body>` until
JS runs, so we extract nothing. Open-web fallback (distributors)
catches some; doesn't catch all. Headless-browser path
(Puppeteer) would fix it but adds 1-2s per call. See
[09-specifications.md](09-specifications.md).

### CVE counts are not version-applicable
NVD's free API takes free-text. We approximate version
applicability by checking if the description names the version
verbatim (`matchesCurrentVersion` flag) — useful but not exact.
A real fix would use the structured CPE matching API and
parse `cpe:2.3:a:vendor:product:version:*` URIs from each CVE.
See [08-firmware.md](08-firmware.md).

### Recall-gap banner removed
We built a side-rail label cross-check
(`pipeline/side_labels.py` + UI banner) that flagged "we found 7
labels on the rails but only resolved 5 switches — please check
these 2." The matching logic was broken (the matcher checked
the wrong fields), so it surfaced false-positive "missing
switches." The UI render was removed; the Python and endpoint
remain in case we want to fix and re-enable. See
[10-topology.md](10-topology.md).

### Manual entries don't flow to ServiceNow
When the user types a make/model into the Switch card, the
override is in localStorage only. `synth.py` doesn't read these
overrides when building the CMDB push. Symptom: a tech corrects
"Mikrotik CRS326-24G-2S+RM", pushes to CMDB, and the row in
ServiceNow still has the OCR's garbled value. See
[07-switch-info.md](07-switch-info.md), [13-cmdb-servicenow.md](13-cmdb-servicenow.md).

### Multi-rack topology is data-only
The topology JSON has `crossRackEdges` and `neighbors` fields,
and the 3D scene draws ghost shells of neighbour racks
(`NeighborRacks` in `TopologyScene3D.jsx`), but there's no
"room view" rendering N racks with cross-rack cables traversing
between them. See [10-topology.md](10-topology.md).

### Dev-approve bypass in CMDB
`POST /api/cmdb/ticket/:rackId/dev-approve` skips the ServiceNow
approval workflow. Authenticated (behind `requireAuth`), but
auditors flag this as authorization-gap. Production fix: gate
behind `process.env.NODE_ENV !== 'production'` or wire to a
real auto-approve flow. See [13-cmdb-servicenow.md](13-cmdb-servicenow.md).

### ServiceNow auth is HTTP Basic
8+ scripts in `servicenow/` hard-code `auth=(SN_USER, SN_PASSWORD)`.
Move to OAuth client-credentials grant. See
[21-auth-secrets.md](21-auth-secrets.md), [13-cmdb-servicenow.md](13-cmdb-servicenow.md).

### Worker pool doesn't reload models on promotion
Retraining promotes a new `Models/X.pt`. The Node-spawned
subprocess pipeline picks it up next call (each call is a fresh
Python). The warm worker pool keeps Python alive between calls
and won't notice the new file until restart. Workaround:
restart Node after a model promotion. See [18-retraining.md](18-retraining.md).

---

## Roadmap items, by category

### Detection accuracy
- **CLAHE + unsharp on per-bbox crops** — done; deliverable
  ~5% gain. Headroom is the OCR engine itself.
- **PaddleOCR fallback when EasyOCR returns nothing** — adds a
  second engine at ~50% extra latency, recovers some of the 4-of-
  12 zero-OCR cases. Not yet wired.
- **Photo-quality gate, stricter** — current gate accepts photos
  EasyOCR can't read. Tighter thresholds + clearer retake hints
  would prevent the worst per-device misses.
- **Active learning** — capture and queue exists; retrain runner
  exists; **operating cycle is manual today**. Cron + alerting on
  promotion is a small ops change.

### Multi-rack
- **Room view** — render N racks in a single 3D scene, with
  floor-plan layout. Data already exists; rendering layer needed.
- **Floor-plan import** — accept SVG / IFC for rack layout
  positioning. Today rack positions are Y-axis only (within one
  rack).

### Mobile / native
- **iOS build** — `npx cap add ios` + Xcode signing. Half a day
  to first APK, second day to App Store flow.
- **AR overlays anchored to chassis** — RackAR plugin TS
  bridge done, web fallback done, native Swift/Kotlin pending.
  Plane-anchored overlay is the hard part.
- **On-device inference** — quantized YOLO + cable classifier
  shipped as CoreML / TFLite assets. Expect 1-3% accuracy drop
  post-quantization.

### Platform
- **Per-tenant rate limiting** — `express-rate-limit` keyed by
  `req.user.tenant_id`. Currently no rate limit at all on
  `/api/analyze`.
- **GDPR delete-my-data flow** — drop `rack_owners` rows is
  trivial; pruning shared `outputs/<rackId>/` folders when the
  last owner leaves needs a GC job.
- **Postgres migration** — SQLite is fine at current scale.
  Multi-writer scale (many concurrent scans across tenants) wants
  Postgres.

### Operations
- **Hot-reload model weights** — restart-free promotion. Worker
  pool change.
- **Cron-driven retrain** — daily check, email on promotion or
  validation regression.
- **Postgres metrics** — currently we expose Prometheus metrics
  but don't have an alerting pipeline. Add Alertmanager rules.
- **OTel exporter** — Observability is OTel-shaped; wire an
  OTLP exporter for distributed tracing visibility.

### Documentation
- **Per-tenant deployment runbook** — how to add a tenant,
  rotate SSH keys, troubleshoot common ops.
- **Vendor-coverage matrix** — which vendors / models are
  reliably parsed end-to-end vs which need manual entry.

---

## What we explicitly chose not to build

- **Real-time CMDB sync** (writes flowing back from ServiceNow
  into the app without re-scanning). Cost is more than
  benefit at current customer count; explicit re-scan is
  acceptable.
- **In-house CVE database**. NVD gives us this for free; we
  don't add value by mirroring it.
- **Vendor-specific extractors per vendor**. Generic
  table/`<dl>` extraction handles most vendors; the long tail
  (Cisco modern, Aruba modern) gets the headless-browser fallback
  (above), not bespoke per-vendor code.
- **iOS support before Android stability**. Android is the
  primary field deployment target — most rugged datacenter
  phones are Android. iOS is for consultants who BYO; secondary.

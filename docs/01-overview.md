# 01. Overview — What the app does

A field engineer or datacenter tech opens the app on their phone,
takes a photo of an open rack, and gets back a structured inventory
of what's inside it: which switches, which ports are free, what
cables go where, and whether the firmware on those switches is up to
date. The same data syncs to ServiceNow CMDB so the office team has
the same picture without anyone manually retyping serial numbers
into a form.

That's the whole product in one paragraph. Everything else is
implementation detail.

## The user journey

1. Open the app, log in.
2. Tap **Scan Rack**, point camera at the rack, take a photo.
3. The phone uploads the photo. The server runs computer vision to
   find each device, then runs OCR on each device's chassis to read
   the make / model / firmware label.
4. While that's running, the phone also kicks off a background SSH
   probe of the live switch (port status), a topology generation
   pass (cable routing), and a CMDB lookup for any prior knowledge
   of this rack.
5. When the user lands on the **Results** page, every tab — Overview,
   Ports, Topology, Network, Switches — is already populated. No
   per-tab loading spinner, because everything fired the moment the
   scan finished.
6. If something didn't get picked up automatically (e.g. OCR
   couldn't read a chassis), the user can tap and type the missing
   make / model / firmware version. Those manual entries flow back
   into the same vendor-specs and CVE lookups as the auto-detected
   values.
7. From the Results page, the user can sync to CMDB (creates a
   ServiceNow change ticket) or share the report by Slack / Teams /
   Outlook.

## The parts, in one sentence each

- **Rack scan** — phone photo → CV finds each chassis → per-bbox OCR
  reads the labels.
- **Port detection** — separate CV model counts and classifies ports
  on each switch's front panel.
- **Switch info** — given vendor + model, scrapes the vendor's
  product page for specs, and the NIST NVD for known CVEs.
- **Topology** — given the rack layout and patch-panel data, renders
  a 3D view with cables routed between devices.
- **Available ports** — opens an SSH session to the live switch,
  parses `show interface status`, returns who's connected and who's
  free.
- **SFP advisor** — given which SFP cages exist and the switch
  model, recommends compatible transceiver part numbers.
- **CMDB sync** — pushes the scan result into ServiceNow's CMDB as
  a change ticket; ticket polls back for approval status.
- **Netdisco proxy** — surfaces an existing netdisco install's LLDP
  neighbour data through the same UI.
- **Feedback** — captures user corrections to OCR/CV mistakes into
  a JSONL file for later retraining.

---

## Technical map (for the lead)

### Process topology

Three independent processes:

```
┌─────────────┐         ┌─────────────┐         ┌─────────────┐
│   client    │  HTTPS  │   server    │  spawn  │   pipeline  │
│  (React +   │ ──────▶ │  (Express   │ ──────▶ │  (Python    │
│ Capacitor)  │         │   on Node)  │         │   modules)  │
└─────────────┘         └─────────────┘         └─────────────┘
                              │
                              │ outbound HTTPS
                              ▼
                        ┌─────────────┐
                        │ ServiceNow  │
                        │   netdisco  │
                        │   vendor    │
                        │   sites,    │
                        │   NIST NVD  │
                        └─────────────┘
```

- The **client** is a React SPA wrapped with Capacitor. Today it
  builds an Android APK (`client/android/`). No iOS build exists
  yet (`client/ios/` is absent — see
  [11-known-limits.md](11-known-limits.md)).
- The **server** is a single Express app at `server/app.js`
  (~3,900 LOC), with two route modules pulled in:
  `server/cmdb_ticket_proxy.js` (CMDB ticketing) and
  `server/netdisco_proxy.js` (netdisco proxy). 45 + 6 + 7 = 58
  total HTTP routes.
- The **pipeline** is a folder of Python modules at `pipeline/`.
  The server spawns them as subprocesses (`-m pipeline.<name>
  --json`) and parses one JSON line off stdout. There is also a
  separate `servicenow/` Python package for CMDB sync that runs the
  same way.

### Per-rack data layout

Every scan creates a folder `outputs/<rackId>/` with:

| File | Produced by | Consumed by |
|---|---|---|
| `original_image.jpg` | analyze upload | every downstream stage |
| `device_unit_map.json` | `pipeline.runner` (CV) | OCR, ports, topology |
| `ocr_devices.json` | `pipeline.ocr_devices` | UI, CMDB synth |
| `side_labels.json` | `pipeline.side_labels` | (currently unused — see [05](05-topology.md)) |
| `topology.json` | `servicenow/topology_generate.py` | TopologyPage |
| `scan_result.json` | `writeCanonicalScanResult` in app.js | Results page |
| `scan_meta.json` | `/api/analyze` | re-runs, port lookups |
| `ticket_state.json` | `cmdb_ticket.py` | CMDB ticket UI |
| `labels-front.json`, `labels-rear.json` | `pipeline.ocr_labels` | label-merge endpoint |

The `rackId` is `RK-XXXXXXXX` where `XXXXXXXX` is the first 8 hex
chars of the SHA-256 of the normalized image. Same image = same
rackId, which lets the cache-hit path in `/api/analyze` short-circuit
a re-upload.

### Concurrent work after a scan

When `/api/analyze` returns, the client immediately fires
`prefetchScan(rackId)` in
[client/src/utils/scanPrefetch.js](../client/src/utils/scanPrefetch.js).
That kicks off, in parallel:

- `GET /api/scan/:rackId/result` (full bundle)
- `GET /api/topology/:rackId`
- `GET /api/cmdb/rack/:rackId/switches`
- A poll loop on `GET /api/scan/:rackId/ocr-devices` until the
  server-side OCR finishes
- Per-device specs + firmware lookups (`POST /api/specs`,
  `POST /api/firmware`) once OCR resolves

The server side also auto-fires per-device OCR via
`scheduleOcrDevices` in `app.js` so the client's poll usually
returns cached data within seconds.

### Stack summary

| Layer | What | Where |
|---|---|---|
| UI | React 19, Vite 6, React Router 7 | `client/src/` |
| Mobile shell | Capacitor 7 | `client/capacitor.config.json` |
| 3D | Three.js 0.169 + React Three Fiber 8 | `client/src/pages/TopologyScene3D.jsx` |
| API | Express 4, JWT auth, helmet | `server/` |
| Logging | `pino` deps installed but **not wired** — see [11](11-known-limits.md) | `server/package.json` |
| Metrics | `prom-client` deps installed but **not wired** | `server/package.json` |
| CV | YOLOv8 weights at `Models/` (`best 32.pt` devices, `best 33.pt` server class, `port_count.pt` ports, `unit.pt` U-positions, `best_model_efficientnet.pth` cable classifier) | `pipeline/runner.py`, `pipeline/detection.py` |
| OCR | EasyOCR (Python) | `pipeline/ocr_devices.py`, `pipeline/ocr_labels.py`, `pipeline/side_labels.py` |
| Vendor scrape | requests + cloudscraper, BeautifulSoup, `ddgs` for search | `pipeline/all_vendor.py`, `pipeline/firmware_check.py` |
| CVE source | NIST NVD public API | `pipeline/firmware_check.py:NVD_API` |
| ServiceNow | HTTP Basic auth via `servicenow/cmdb_apply.py` etc. | `servicenow/` |
| Netdisco | proxy to existing `netdisco-docker` install | `server/netdisco_proxy.js` |

### Key files to know your way around

- `server/app.js` — the bulk of the server. Find a route by name:
  `grep -n "^app\\." server/app.js`.
- `pipeline/runner.py` — the CV pipeline entry point.
- `pipeline/ocr_devices.py` — per-bbox OCR + make/model/version
  parsing. The fuzzy match + brand-keyword table lives here.
- `pipeline/all_vendor.py` — vendor-site scraping for specs.
- `pipeline/firmware_check.py` — release-notes scraping + NVD CVE
  lookup. Version-plausibility heuristics live here.
- `servicenow/synth.py` — synthesizes a CMDB-ready inventory from the
  scan + OCR + override files.
- `servicenow/cmdb_ticket.py` — ServiceNow change-ticket lifecycle.
- `client/src/pages/ResultsPage.jsx` — the multi-tab results screen
  (Overview / Ports / Topology / Network / Switches).
- `client/src/pages/SwitchInformationPage.jsx` — switch cards,
  manual-entry fallback, specs/firmware/CVE rendering.

### Outputs you should never delete by hand

`outputs/<rackId>/` per-rack folders are the source of truth between
stages. Deleting one mid-flow strands later steps. The `dev-approve`
CMDB endpoint and the per-rack share endpoints both read from
`outputs/`. There is no retention policy — see
[11-known-limits.md](11-known-limits.md).

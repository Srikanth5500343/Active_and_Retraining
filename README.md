# RackTrack

AI-assisted datacenter rack identification for field technicians. Point a phone at a rack, get back the unit map, switch model, firmware, port states, and the cross-reference to the CMDB record in ServiceNow.

## What it does

A technician opens the mobile app, captures the front (and optionally rear) of a rack, and the server runs a multi-stage computer-vision pipeline that produces:

- **Unit grid** — every U position in the rack, contiguous from top to bottom
- **Device map** — which unit each device occupies (switch, server, firewall, PDU, blank)
- **Switch identity** — vendor + model from logo and label OCR, cross-checked against the vendor database
- **Port layout** — port count, type (RJ45 / SFP / SFP+ / QSFP), and per-port occupancy from cable detection
- **Firmware** — recommended firmware for the detected model, sourced from the vendor matrix
- **Topology** — a 3D rendering of the rack and, for multi-rack scans, the inter-rack uplinks
- **CMDB reconciliation** — the scan is matched against the ServiceNow CMDB; mismatches (wrong U, wrong model, unplugged port) generate work notes on the related incident

## Architecture

```
 ┌─────────────────────────┐         ┌────────────────────────────┐
 │  Mobile client          │  HTTPS  │  Node / Express API        │
 │  (React + Capacitor)    │ ──────▶ │  - auth + audit (SQLite)   │
 │  iOS · Android · web    │         │  - worker pool             │
 │  AR view (ARCore/ARKit) │         │  - SSH switch probe        │
 └─────────────────────────┘         └─────────────┬──────────────┘
                                                   │ spawn
                                                   ▼
                                     ┌────────────────────────────┐
                                     │  Python CV pipeline        │
                                     │  YOLO units / devices /    │
                                     │  ports · EfficientNet      │
                                     │  cable classifier · OCR    │
                                     └─────────────┬──────────────┘
                                                   │
                                                   ▼
                                     ┌────────────────────────────┐
                                     │  ServiceNow bridge         │
                                     │  CMDB lookup + work notes  │
                                     └────────────────────────────┘
```

- **`client/`** — React 18 + Vite SPA, wrapped with Capacitor 6 for iOS and Android. Three.js for the 3D rack and topology views. A native ARCore activity on Android is exposed through a Capacitor plugin (`RackAR`).
- **`server/`** — Node/Express API. JWT auth, per-tenant scoping, audit log in SQLite, structured logging with pino, Prometheus metrics, a worker pool that fans scans out to Python subprocesses, and an SSH probe that pulls live port state from Cisco / Juniper / Arista switches.
- **`pipeline/`** — the CV pipeline. Five YOLO models (`Models/*.pt`) plus an EfficientNet cable classifier, OCR for device and side labels, multi-rack splitting, firmware lookup against the vendor matrix, and quality checks that decide whether a frame is good enough to score.
- **`servicenow/`** — Python bridge that correlates a ServiceNow incident with a CMDB walk and the most recent RackTrack scan, then posts a reconciliation work note back to the incident.
- **`dashboard/`** — owner-only, read-only inspector for audit logs, scans, and active-learning feedback. Binds to `127.0.0.1:4100` and is never exposed by the tunnel.
- **`active_learning_Cache/` + `retraining_learning/`** — captured "wrong?" corrections and the offline retraining pipeline that consumes them.
- **`netdisco-docker/`** — dockerised Netdisco instance used as the live-network source of truth for the topology view.

## Repository layout

```
client/                React + Capacitor mobile/web app
server/                Node/Express API, worker pool, SSH probe
pipeline/              Python CV pipeline (YOLO + OCR + cable + firmware)
Models/                Trained model weights (.pt / .pth)
servicenow/            ServiceNow ↔ RackTrack reconciliation
dashboard/             Owner-only read-only dashboard
active_learning_Cache/ Captured corrections from the field
retraining_learning/   Offline retraining pipeline
netdisco-docker/       Netdisco container for topology
config.json            Model paths and detection thresholds
start.ps1              Local dev launcher (server + cloudflared)
```

## Running it locally

Prerequisites: Node 18+, Python 3.10+, the model weights in `Models/`, and (for mobile builds) Android Studio with the Android SDK or Xcode for iOS.

Install everything:

```bash
npm run install:all
pip install -r servicenow/requirements.txt
```

Run the client and server together in dev mode:

```bash
npm run dev
```

Or, on Windows, launch the production-style stack (server + Cloudflare quick-tunnel for phone testing):

```powershell
.\start.ps1
```

The tunnel URL is written to `current-url.txt`; the helper `update-apk-url.ps1` patches the Android build to point at it.

### Mobile builds

```bash
cd client
npm run build
npx cap sync android   # or ios
npx cap open android   # or ios
```

On Android, the camera and AR activity require ARCore-capable hardware (Pixel, recent Galaxy S, etc.); lower-end devices fall back to the standard capture flow.

### ServiceNow bridge

```bash
cd servicenow
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env       # add your PDI credentials
python main.py INC0010001
```

See `servicenow/README.md` for the mock-vs-live switch and the work-note format.

## Configuration

`config.json` at the repo root controls model paths and detection thresholds:

```json
{
  "models": {
    "units":            "Models/unit.pt",
    "devices":          "Models/best 32.pt",
    "server":           "Models/best 33.pt",
    "port_count":       "Models/port_count.pt",
    "cable_classifier": "Models/best_model_efficientnet.pth"
  },
  "detection": {
    "units_conf":   0.25,
    "devices_conf": 0.20,
    "ports_conf":   0.23
  }
}
```

Lowering confidence thresholds increases recall at the cost of false positives — the pipeline includes a retry pass at the `_low` thresholds when the first pass finds nothing.

## Observability

- Logs: `server/lib/observability.js` — structured JSON via pino, with a pretty printer in dev
- Metrics: `GET /metrics` (Prometheus format)
- Health: `GET /healthz`
- Audit: every state-changing route writes to `audit_log` in `server/data/auth.db`; viewable through the owner dashboard

## Status

Pre-production. The vision pipeline, mobile capture flow, ServiceNow bridge, and owner dashboard are working end-to-end on a single-tenant deployment. Active areas of work: multi-tenant hardening, on-device inference for offline scans, and broadening the vendor matrix beyond Cisco / Juniper / Arista / HPE.

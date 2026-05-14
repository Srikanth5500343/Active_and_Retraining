# 23. Architecture — how the parts fit together

## What it does (junior view)

Three independent processes work together. Each one has a clear job:

- **Client** — the React app the user sees. Runs in a browser or
  inside a Capacitor mobile shell (Android today, iOS soon). Calls
  the server over HTTPS.
- **Server** — Express on Node.js. Receives requests, talks to
  ServiceNow / netdisco / vendor sites / NIST, spawns Python
  subprocesses for the heavy work, persists state to the
  filesystem and SQLite.
- **Pipeline** — folders of Python modules: `pipeline/`,
  `servicenow/`, `active_learning_Cache/`, `retraining_learning/`.
  Each invocation is a subprocess that reads inputs, does work,
  prints one JSON line of output.

Why the split: the heavy work (CV, OCR, scraping) is Python-shaped
because that's where the libraries are. The HTTP / auth / session
work is Node-shaped because Express is good at that. The two
talk through subprocess stdout/stderr.

A typical request flow (rack scan):

```
[user phone]                        [Express server]                    [pipeline]
     |   POST /api/analyze + image      |                                  |
     |--------------------------------->|                                  |
     |                                   | runQualityCheck → pool worker    |
     |                                   |--------------------------------->|
     |                                   |<-- {ok, metrics}                 |
     |                                   | runPipelineAnalyze → subprocess  |
     |                                   |--------------------------------->|
     |                                   |       (CV + OCR + topology)      |
     |                                   |<-- one JSON line on stdout       |
     |   res.json(result)                |                                  |
     |<----------------------------------|                                  |
     |                                                                      |
     | (in parallel) prefetchScan(rackId):                                  |
     |   GET /api/scan/:rackId/result                                       |
     |   GET /api/topology/:rackId                                          |
     |   GET /api/cmdb/rack/:rackId/switches                                |
     |   poll GET /api/scan/:rackId/ocr-devices                             |
     |   POST /api/specs (per device)                                       |
     |   POST /api/firmware (per device)                                    |
```

## What it doesn't do

- It doesn't run inference in the browser. (Yet — the AR plugin
  paves the way.)
- It doesn't rely on a managed message queue. Subprocess
  spawning is the entire job-queue. Adequate at current scale;
  swap-in Redis/SQS would be a future change.
- It doesn't replicate the database. SQLite, single-writer.
  Multi-writer scale needs PostgreSQL.

---

## Technical detail (lead view)

### Process topology

```
        ┌──────────────────────────────┐
        │           CLIENT             │
        │   React 19 + Vite 6 SPA      │
        │   Capacitor 7 wrapper        │
        │   Three.js for 3D            │
        │   Android: built APK         │
        │   iOS:     not yet built     │
        └──────────────┬───────────────┘
                       │ HTTPS (JWT in Authorization)
                       ▼
        ┌──────────────────────────────┐
        │           SERVER             │
        │   Express 4 on Node 20+      │
        │   helmet + cors              │
        │   pino logs + prom metrics   │
        │   SQLite (better-sqlite3):   │
        │     users, tenants,          │
        │     rack_owners, sessions    │
        │   filesystem state:          │
        │     outputs/<rackId>/        │
        │     server/feedback*.jsonl   │
        └─┬───────────┬────────────────┘
          │           │
          │ spawn     │ outbound HTTPS
          ▼           ▼
   ┌────────────┐  ┌─────────────────────────────┐
   │  PIPELINE  │  │ EXTERNAL                     │
   │ subprocess │  │  ServiceNow REST API         │
   │ Python 3.x │  │  netdisco container REST     │
   │ EasyOCR    │  │  vendor product pages        │
   │ YOLOv8     │  │  NIST NVD (CVE)              │
   │ requests   │  │  Slack / Teams webhooks      │
   │ ddgs       │  │  Microsoft Graph (Outlook)   │
   └────────────┘  └─────────────────────────────┘
```

### Server overview

`server/app.js` is the bulk of it (~3,900 LOC). It does:

- **Bootstrap** — load config, init DB, wire observability
- **Middleware** — helmet, cors, requestId, httpLogger, httpMetrics, body-parser, multer (uploads)
- **Auth routes** — `/api/auth/login`, `/api/auth/signup`, `/api/auth/me`, `/api/auth/refresh`, `/api/auth/logout`
- **Scan routes** — `/api/analyze`, `/api/scan/:rackId/*` (result, ocr-devices, side-labels, slack/teams/outlook, ports-map)
- **Switch info** — `/api/specs/vendors`, `/api/specs`, `/api/firmware`, `/api/sfp/analyze`
- **Live data** — `/api/switch/console/run`, `/api/switch/default-host`
- **CMDB** — mounted from `cmdb_ticket_proxy.js`
- **Netdisco** — mounted from `netdisco_proxy.js`
- **Topology** — `/api/topology/:rackId`
- **Health** — `/healthz`, `/readyz`, `/metrics`
- **Static** — serves the built `client/dist` so production is one process

Routes total: 45 in app.js + 6 in cmdb_ticket_proxy.js + 7 in
netdisco_proxy.js = **58**.

### Subprocess spawning

`runPipelineModule(name, args)` at `app.js:3330` is the standard
helper:

```js
function runPipelineModule(moduleName, extraArgs) {
  return new Promise(resolve => {
    const child = spawn(pythonCmd, ['-u', '-m', moduleName, ...extraArgs], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
    });
    // collect stdout, parse last JSON line, resolve
    // 90s timeout; on timeout SIGKILL + friendly error
  });
}
```

Used for all on-demand pipeline calls (specs, firmware, SFP,
ocr-devices, side-labels). The friendly-error strings are at
the timeout/exit/spawn-error paths — never leak a Python
traceback to the client.

For long-running CV scans, there's a separate worker pool
(`server/worker-pool.js`) that keeps Python processes warm
between requests, paying the ~700ms Python startup cost once.

### Python side spawn shapes

Every Python entry point follows the same pattern:

```python
import argparse, json, sys
def main():
    p = argparse.ArgumentParser()
    p.add_argument(...)
    p.add_argument('--json', action='store_true')
    args = p.parse_args()
    try:
        result = do_work(args)
    except Exception as e:
        print(json.dumps({'ok': False, 'error': str(e)}))
        sys.exit(2)
    print(json.dumps(result))   # one JSON line on stdout
    sys.exit(0 if result.get('ok') else 1)
```

The server reads stdout, splits on newline, parses the last
non-empty line. Anything else (debug prints) goes to stderr and
into the structured log on the Node side.

### State on disk

| Location | Purpose |
|---|---|
| `outputs/<rackId>/original_image.<ext>` | Raw image |
| `outputs/<rackId>/scan_meta.json` | Quality metrics, hash, timestamps |
| `outputs/<rackId>/device_unit_map.json` | CV result |
| `outputs/<rackId>/ocr_devices.json` | Per-bbox OCR result |
| `outputs/<rackId>/topology.json` | Topology JSON |
| `outputs/<rackId>/scan_result.json` | Canonical result bundle |
| `outputs/<rackId>/labels-front.json`, `labels-rear.json` | Whole-image label OCR |
| `outputs/<rackId>/side_labels.json` | Rack-rail label OCR |
| `outputs/<rackId>/ticket_state.json` | CMDB ticket state |
| `outputs/.specs_cache/<key>.json` | Cached specs lookups |
| `server/feedback.jsonl` | Append-only feedback log |
| `server/feedback/wrong/<file>.jpg` | Per-correction crops |
| `server/data/auth.db` | SQLite: users, tenants, rack_owners |
| `server/.env`, `server/.env.key` | SSH creds + key |
| `servicenow/.env` | SNOW credentials |
| `active_learning_Cache/data/<model>/...` | Per-model AL queue |
| `retraining_learning/runs/<model>-<id>/...` | Retrain artifacts |
| `retraining_learning/registry.json` | Model registry |
| `retraining_learning/holdout/<model>/...` | Frozen validation sets |
| `Models/*.pt`, `Models/*.pth` | Production model weights |

### Client overview

```
client/src/
├── App.jsx                  ← top-level router
├── main.jsx                 ← entry; wraps App in providers
├── AuthContext.jsx          ← login state + token
├── ThemeContext.jsx         ← light/dark theme
├── ShutterContext.jsx       ← global shutter button (camera flow)
├── pages/                   ← one file per route
│   ├── HomePage.jsx
│   ├── ScanPage.jsx
│   ├── ResultsPage.jsx        (the multi-tab result page)
│   ├── SwitchInformationPage.jsx
│   ├── TopologyPage.jsx + TopologyScene3D.jsx
│   ├── PortsPage.jsx
│   ├── NetdiscoPage.jsx
│   ├── HistoryPage.jsx
│   ├── ProfilePage.jsx
│   ├── FirmwarePage.jsx
│   ├── SpecificationsPage.jsx
│   ├── LoginPage.jsx, SignupPage.jsx, AuthPages.module.css
│   └── LogoCompare.jsx, ResultsPage.module.css, ...
├── components/              ← reusable: BottomNav, MiniRack3D, RearImagePrompt, ThemeToggle
├── plugins/                 ← Capacitor plugins
│   ├── RackAR.ts
│   └── RackAR.web.ts
└── utils/
    ├── api.js               ← apiUrl + authFetch
    ├── portsProbe.js        ← SSH probe state machine
    ├── scanPrefetch.js      ← post-analyze parallel prefetch
    ├── sfpDatabase.js       ← SFP advisor client cache + offline fallback
    └── validateMedia.js     ← client-side photo pre-flight
```

### Stack versions

| What | Version | Notes |
|---|---|---|
| Node.js | 20+ | required by some deps; package.json `engines` |
| Express | 4.x | classic; Express 5 not yet adopted |
| React | 19.x | with Vite 6 |
| Capacitor | 7.x | Android in `client/android/` |
| Three.js | 0.169 | with `@react-three/fiber 8.x` |
| pino, pino-http, pino-pretty | latest | logging |
| prom-client | 15.x | metrics |
| better-sqlite3 | latest | SQLite |
| jsonwebtoken | latest | JWT |
| bcrypt | latest | password hashing |
| ssh2 | latest | switch SSH probe |
| puppeteer-core | latest | PDF generation for share |
| Python | 3.10+ | venv at `venv/` |
| ultralytics | latest | YOLO |
| easyocr | latest | OCR |
| beautifulsoup4 | latest | HTML scrape |
| ddgs | latest | search engine |
| cloudscraper | optional | CF-protected sites |
| openpyxl | latest | Switch_Vendors_Websites.xlsx |

### Deployment

`Dockerfile` at the project root builds a single image with:
1. Node 20 + Python 3
2. Project root, with `client/dist/` pre-built
3. Models, Excel files, .env templates
4. Entry: `node server/app.js`

A typical deployment:
- Cloudflare tunnel exposes the container (current dev path uses
  `cloudflared.exe`)
- Logs to stdout (JSON), scraped by whatever log aggregator is
  configured
- `/metrics` scraped by Prometheus
- TLS terminated at the tunnel / reverse proxy

### Files in this feature

(See above.)

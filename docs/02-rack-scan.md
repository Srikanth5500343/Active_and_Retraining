# 02. Rack Scan — photo to inventory

## What it does (junior view)

The user opens **Scan Rack**, takes a photo of an open rack, and the
app figures out what's inside. By the time they navigate to the
Results page, every device has been located, every switch has had
its make / model / firmware label read, and the page is already
filled in.

Two stages run inside the same upload:

1. **Computer vision** — finds rectangles in the photo that look like
   network gear, classifies each one (Switch, Server, Router, Patch
   Panel, UPS, PDU, Closed Unit, etc.), and figures out which
   rack-unit slot (U1, U2, U3 …) each rectangle occupies.

2. **OCR per device** — for each detected switch, crops the front
   panel from the original photo and runs text recognition on just
   that crop. The text is then parsed into vendor + model + firmware
   version using a list of known patterns.

The scan also has guardrails:

- A **photo-quality check** runs before CV. If the photo is blurry,
  too tilted, glare-heavy, or doesn't show enough rack rails, the
  user gets a "retake the photo" prompt with a specific reason.
  They can override and proceed anyway (the override is recorded).
- If CV doesn't find any devices, the upload is rejected with a
  hint that the camera was probably pointed at the back of the
  rack or at something that isn't a rack.

What ends up on the user's screen, per detected switch:

- A card with vendor + model in the title
- A `Photo NN%` confidence badge (so they know whether to trust it)
- The U-position (`U10`, `U37`, etc.)
- Firmware version, IP / MAC / serial if any of those came through

If OCR couldn't read a label, the card shows **"Identification —
Not detected"** with an **Enter make / model** button. The user
types the values; everything downstream (specs, firmware check,
CVE list) flows against the entered values.

## What it doesn't do

- It doesn't read the back of the rack from a front photo (obvious
  but worth saying — there's a separate "rear image" prompt).
- It doesn't yet read serial-number stickers reliably. Serials are
  often on a side label or smaller than fascia text; OCR misses
  most of them.
- It doesn't tell you which port is plugged into which other device
  from a photo alone — that's the topology stage, which uses
  patch-panel data + LLDP, not pixels.

---

## Technical detail (lead view)

### Endpoint

[`POST /api/analyze`](../server/app.js) at `server/app.js:1241`.

Request:
```
multipart/form-data
  image: <file>                        (required — JPEG/PNG/HEIC)
  skipQualityCheck: '1'                (optional — set after user
                                        clicks "Proceed anyway")
```

Response (200):
```json
{
  "rackId": "RK-F74FFCF9",
  "units_detected": ["U01","U02","U03","U04","U05","U06","U07","U08","U09","U10","U11","U12","U13","U14","U15"],
  "units_range": "U01-U15",
  "devices": [
    { "name": "Switch-1", "class_name": "Switch", "u_position": "U10",
      "box": [320,140,1180,210], "port_count": 24, "sfp_ports": [...] },
    ...
  ],
  "stats": { "device_count_in_rack": 5, "edge_count": 27 },
  "timings": { "normalize_ms": 412, "quality_check_ms": 1240, "pipeline_ms": 18420, "total_ms": 20140 },
  "qualityWarning": false
}
```

Response (400, retryable):
```json
{
  "error": "Please take the photo from the front of the rack — we need to see the devices and ports face-on.",
  "retryable": true,
  "kind": "quality"
}
```

### Pipeline call chain

```
/api/analyze (Express)
  ├─ normalizeImage()                   server/app.js
  │     - reads upload, EXIF-rotates,
  │     - re-encodes to JPEG, strips metadata
  ├─ computeRackId()                    SHA-256 prefix as rackId
  ├─ cache-hit short-circuit            if outputs/<rackId>/device_unit_map.json exists
  ├─ runQualityCheck()                  spawns pipeline.quality_check
  │     - blur, tilt, brightness, framing, U-rail visibility
  ├─ writeMeta()                        scan_meta.json
  ├─ runPipelineAnalyze()               spawns pipeline.runner
  │     - YOLO devices: best 32.pt
  │     - YOLO server-class: best 33.pt
  │     - YOLO ports: port_count.pt
  │     - YOLO units: unit.pt
  │     - cable classifier: best_model_efficientnet.pth
  │     - writes device_unit_map.json
  ├─ post-pipeline framing check        rejects if 0 devices or <3 units
  ├─ scheduleCanonicalRefresh()         setImmediate → writeCanonicalScanResult + scheduleOcrDevices
  └─ res.json(...)                      includes timings
```

`scheduleOcrDevices` in `app.js:1007` is the key line: it
fire-and-forgets per-bbox OCR (`pipeline.ocr_devices`) right after
analyze returns. By the time the user lands on Results, OCR is
either done or close to it. The client polls
`GET /api/scan/:rackId/ocr-devices` (cached `ocr_devices.json`)
until it sees results.

### CV pipeline (`pipeline/runner.py`)

The runner is one Python module that loads multiple YOLO weights
and runs them in sequence on the same image:

| Stage | Weights | Output |
|---|---|---|
| Rack-bounds detection | None — Hough lines | `(rx1, ry1, rx2, ry2)` crop into the rack region |
| Device detection (general) | `Models/best 32.pt` | bboxes + class for switch/router/patch-panel/PDU/etc. |
| Device detection (server-class) | `Models/best 33.pt` | bboxes for chassis missed by general model (servers, blade enclosures) |
| Low-confidence retry | both, with `conf=0.08` | catches UPS, PDU, blank panels the primary pass missed |
| U-position detection | `Models/unit.pt` | U-rail markers; each device bbox is mapped to overlapping U range |
| Port-count detection | `Models/port_count.pt` | counts ports per chassis (used by `port.py`) |
| Cable classification | `Models/best_model_efficientnet.pth` | CAT/fiber/DAC label for visible cables |

Class taxonomy used by downstream code:
`Switch, Server, Router, Firewall, Aggregation Core, Patch Panel,
PDU, UPS, Storage Unit, Closed Unit, Empty, Unidentified`. Of those,
the OCR stage only targets a subset — see [04-switch-info.md](04-switch-info.md).

### Quality gate (`pipeline/quality_check.py`)

Runs before the heavy CV pipeline. Checks:

- Laplacian variance (blur)
- Detected line angle (tilt) — reject if rack rails aren't roughly
  vertical
- Mean brightness + saturation (over/under-exposure, glare)
- Detected text count (helps catch "this is a wall not a rack" cases)

When it fails, it returns `{ retryable: true, kind: 'quality',
error: '<reason>' }` and the user gets the option to retry or
proceed anyway. Override is recorded with `qualityWarning: true`
in `scan_meta.json`.

### Cache hit semantics

If a user uploads the same physical photo twice (same SHA-256), the
endpoint short-circuits at `app.js:1257` — it skips the pipeline
entirely and returns the cached `device_unit_map.json`. This is
intentional: re-uploading because a network blip dropped the
response should not re-run a 30-second CV pipeline. The downside is
that an upload of a re-shot photo of the same rack at the same
angle can hit the cache too — rare in practice because phone JPEG
encoding produces different bytes each shot.

### Per-bbox OCR (`pipeline/ocr_devices.py`)

After CV writes `device_unit_map.json`, this module reads it and:

1. Filters devices to `OCR_CLASSES` (Switch, Server, Router,
   Firewall, Aggregation Core, Unidentified, Closed Unit). Patch
   panels, PDUs, UPS, blank panels, storage units are **skipped**
   — they rarely have useful chassis text and their port-rows
   produce garbage if OCR'd.
2. For each targeted device, crops its bbox from
   `original_image.jpg`, upscales to 120px tall via cubic
   interpolation if smaller (small text reads better at higher
   resolution), then runs EasyOCR three times:
   - Raw crop
   - CLAHE contrast-enhanced (`_preprocess_for_ocr`)
   - Unsharp-masked (`_preprocess_unsharp`)
3. Merges results, dedupes by lowercased text, keeps the best
   confidence per phrase.
4. Joins all phrases into one string, runs `parse_make_model()` and
   `parse_version()`.

Output: `outputs/<rackId>/ocr_devices.json`. Schema per device:

```json
{
  "position": "U10",
  "class_name": "Switch",
  "box": [x1, y1, x2, y2],
  "make": "Mikrotik",
  "model": "CRS326-24G-2S+RM",
  "version": "10.5.0.7",
  "raw_text": "Mikrotik Cloud Router Switch CRS326-24G-2S+RM ...",
  "ocr_conf": 0.74,
  "match_conf": 0.88,
  "source": "ocr_full"  // ocr_full | ocr_make_only | ocr_failed | skipped
}
```

`source` matters downstream: `ocr_full` means we got both make and
model; `ocr_make_only` is vendor without model; `ocr_failed` is the
classifier targeted this bbox but couldn't read anything;
`skipped` means the class wasn't in `OCR_CLASSES`.

### `parse_make_model()` (the parser)

Lives at `pipeline/ocr_devices.py:297`. Two-stage:

1. **Model regex** — try every entry in `MODEL_PATTERNS` against
   the joined OCR text. First match wins. Patterns cover Cisco
   Catalyst/Nexus/PIX, TP-Link TL-/T-, D-Link DGS/DXS/DSR, Juniper
   EX/QFX/MX/SRX, Aruba CX, HP 1820/1920/2530/etc., Arista 7xxx,
   Huawei S/CE, Dell S/N/R-series, MikroTik CRS/CCR/CSS/RB,
   Ubiquiti USW/USG/UDM/ER, NETGEAR GS/JGS, SonicWall TZ/NSa,
   Synology DS/RS, QNAP TS/TVS, APC SU/SMT/SRT, Eaton 5SC/9SX,
   TRENDnet TEG/TPE, HikVision DS-.

2. **Brand keyword + fuzzy match** — if no model regex hit, walk
   `BRAND_KEYWORDS` (26 vendors, each with canonical spelling +
   common OCR misreads). Token-level Levenshtein distance up to
   1–3 (depending on keyword length) catches OCR drift like
   `Csco` → Cisco, `Mikrorik` → MikroTik, `Unfi` → UniFi.

Why fuzzy match scales with length: a 1-character drift on a
5-char word is 20% noise (suspicious), but a 1-character drift on
a 10-char word is 10% (very plausible). The budget is `1` for
words ≤ 8 chars, `2` for 9–12, `3` for 13+.

Pre-compiled regex test cases against the live cache live in
`pipeline/benchmark_ocr.py` — you can re-run them at any time:

```
python -m pipeline.benchmark_ocr clear_vendors_racks/
```

### `parse_version()`

Three regex shapes:
- `V200R022C00` (Huawei VRP)
- `9.3(5)I7(7)` (Cisco NX-OS bracketed)
- `10.5.0.7` (standard dotted)

Returns the first hit. The version is later cleaned by
`cleanVersion()` in the React side ([SwitchInformationPage.jsx:112](../client/src/pages/SwitchInformationPage.jsx#L112)) before being sent to firmware lookup.

### Honest accuracy numbers

Measured on a 12-image test set in `clear_vendors_racks/`:

| Metric | v1 (baseline) | v2 (current) |
|---|---|---|
| Devices CV-classified as Switch/Router/Server/Firewall | 40 | 108 |
| Of those, vendor identified | 17 (42.5%) | 22 (20.4%) |
| Of those, model identified | 1 (2.5%) | 2 (1.9%) |

The denominator grew because `Unidentified` and `Closed Unit` were
added to `OCR_CLASSES` to catch unusual chassis the classifier
wasn't sure about. Most of those devices aren't actually switches
— but a few were (CRS518-style fiber switches with non-standard
fascia design), and we recovered them. The percentage drop is the
trade-off for absolute-hit gain.

The full breakdown is in
`clear_vendors_racks/comparison.html` — it has v1 vs v2 columns,
raw OCR excerpts per image, and a manual ground-truth column.

### What goes wrong

- **Empty OCR.** Three of twelve test images returned **zero**
  phrases from EasyOCR. The chassis text is occluded by patch
  cables, glared, or the photo is too low-resolution. No parser
  change fixes this — see [11-known-limits.md](11-known-limits.md).
- **Wrong-but-confident OCR.** Even when text is read, OCR
  routinely substitutes characters: `CRS326` → `CRS3Zo` (the `26`
  read as `Zo`), `Smart` → `Stnort`. The fuzzy keyword match
  handles vendor names; the strict model regex doesn't, so model
  recall is low.
- **CV over-detection.** A 1080p photo of a dense rack can produce
  20+ "device" bboxes including patch panels, blank panels, cable
  routing channels, etc. The class filter at `OCR_CLASSES` keeps
  the OCR pass narrow, but it depends on the classifier getting
  the class right — it sometimes labels a real switch as
  `Unidentified` and a patch-panel row as `Switch`.

### Files in this feature

| File | Role |
|---|---|
| `server/app.js:1241` | `/api/analyze` route |
| `pipeline/runner.py` | CV pipeline (devices, units, ports, cables) |
| `pipeline/quality_check.py` | photo-quality gate |
| `pipeline/detection.py` | YOLO inference helpers |
| `pipeline/ocr_devices.py` | per-bbox OCR + parser |
| `pipeline/all_vendor.py` | brand keyword + fuzzy match utilities (shared with [04](04-switch-info.md)) |
| `client/src/pages/ScanPage.jsx` | upload UI + progress + retry |
| `client/src/utils/scanPrefetch.js` | post-analyze parallel prefetch |
| `Models/best 32.pt`, `Models/best 33.pt`, `Models/unit.pt` | YOLO weights |

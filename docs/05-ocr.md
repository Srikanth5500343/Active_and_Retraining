# 05. OCR — reading text from chassis labels

## What it does (junior view)

After CV finds each switch in the rack photo, OCR runs on each
switch separately to read the printed text on its front panel
— vendor name, model number, sometimes firmware version, sometimes
a serial number. The text gets parsed into structured fields the
rest of the app uses.

Three OCR passes happen on every chassis crop:

1. **The original crop**, OCR'd as-is. Works for cleanly-lit, clear
   chassis text.
2. **Contrast-enhanced** (CLAHE — adaptive histogram equalization).
   Works for chassis where the label is faded or sitting in shadow.
3. **Edge-sharpened** (unsharp mask). Works for cleanly-lit
   chassis where CLAHE's contrast pump introduces noise.

Each pass produces text + a confidence score; we merge them all
and keep the best confidence per phrase. Three independent passes
catch text any single pass would miss.

The text we read is then run through a parser that knows what real
network-gear model numbers look like. If it sees `CRS326-24G-2S+RM`
it knows that's a MikroTik switch. If it sees `Csco` (a common OCR
misread of "Cisco") it knows that's still Cisco. If it sees a long
brand-name label like `Mikrorik` it still maps to MikroTik via fuzzy
match.

## What it doesn't do well

- **Tiny fascia text.** Model numbers on the chassis are often
  printed in 4-6pt. At a 1080p rack photo, those characters end up
  as ~5 pixels tall. EasyOCR struggles below ~10px.
- **Text occluded by patch cables.** A typical rack has cables
  draped across switches; whatever's under the cable doesn't get
  read.
- **Glare.** A flash photo or overhead light on a glossy black
  chassis washes the label out completely.

For these cases, the user can manually type the make / model / firmware
in the UI — see [07-switch-info.md](07-switch-info.md). That manual
entry flows into the same vendor-specs and CVE lookups as the
auto-detected values.

## What we measured

On a 12-image test set, per-device:

- 108 chassis OCR'd
- 22 produced a vendor (20.4%)
- 2 produced a model number (1.9%)

Translation: vendor recall is OK once we know to OCR a chassis;
model recall is poor. The model strings simply aren't in EasyOCR's
output — when OCR returns text, it usually reads brand text and
buzzwords (`Cloud Router Switch`, `Mikrotik`) but mangles the
model number (`CRS3Zo` instead of `CRS326`). No regex fix recovers
text that wasn't captured.

---

## Technical detail (lead view)

### Two parallel OCR pipelines

There are three OCR-related Python modules that do related but
different jobs:

| Module | Inputs | Output | Used by |
|---|---|---|---|
| `pipeline.ocr_devices` | `device_unit_map.json` + `original_image.<ext>` | `ocr_devices.json` (per-device make/model/version) | Switch info UI, CMDB synth, firmware/specs lookups |
| `pipeline.ocr_labels` | `original_image.<ext>` | `labels-front.json` / `labels-rear.json` (raw labels with bbox) | Front/rear merge endpoint, label-to-device matching |
| `pipeline.side_labels` | `original_image.<ext>` | `side_labels.json` (rack-rail identifier chips) | Recall-gap banner (currently disabled in UI) |

`ocr_devices` is the primary path — it's what populates the
Switches tab. `ocr_labels` is older and runs on the **whole image**
(not per-bbox); used to surface generic text labels with positions.
`side_labels` was an experiment to detect rack-rail device-name
chips (`SWHOME`, `SWFIBRA1`) and cross-check against detected
devices — see [10-topology.md](10-topology.md).

### Per-bbox OCR pipeline

Entry point: `pipeline/ocr_devices.py:run(rack_id)`.

```
read device_unit_map.json
load original_image.<ext>
load EasyOCR Reader (English, CPU)
load vendor names from Switch_Vendors_Websites.xlsx

for each device in device_unit_map.devices:
    if device.class_name not in OCR_CLASSES: skip
    crop = image[bbox]
    if crop is shorter than 120px: bicubic upscale to 120px tall
    labels = _extract_labels_in_box(reader, crop)   # 3-pass
    text = " ".join(labels)
    make, model = parse_make_model(text, vendors)
    version = parse_version(text)
    out_devices.append({...})

write ocr_devices.json
```

`OCR_CLASSES` (which device classes are worth OCR'ing) is at
`pipeline/ocr_devices.py:71`:

```python
OCR_CLASSES = {
    "Switch", "Server", "Router", "Firewall", "Aggregation Core",
    "Unidentified", "Closed Unit",
}
```

`Unidentified` and `Closed Unit` are deliberately included — when
the classifier can't pin down a chassis, it's often the unusual one
we most need OCR for (CRS518 wavy fascia, the rare HP cube).

### Three preprocessing passes

`_extract_labels_in_box` at `pipeline/ocr_devices.py:362`:

```python
def _extract_labels_in_box(reader, crop) -> list[dict]:
    sources = [crop, _preprocess_for_ocr(crop), _preprocess_unsharp(crop)]
    seen, canonical = {}, {}
    for source in sources:
        results = reader.readtext(source, detail=1, paragraph=False)
        for (_pts, text, conf) in results:
            ... merge into seen + canonical
    return [{"text": canonical[k], "conf": seen[k]} for k in seen]
```

`_preprocess_for_ocr` (CLAHE):
```python
gray  = cv2.cvtColor(crop, COLOR_BGR2GRAY)
clahe = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8,8))
enhanced = clahe.apply(gray)
return cv2.cvtColor(enhanced, COLOR_GRAY2BGR)
```

`_preprocess_unsharp` (sharpening, added in the v2 round):
```python
blurred   = cv2.GaussianBlur(crop, (0,0), sigmaX=1.4)
sharpened = cv2.addWeighted(crop, 1.5, blurred, -0.5, 0)
```

Why three passes and not more: each pass adds ~50ms per crop on
CPU. Adding more (rotation, multi-scale) starts to dominate the
overall analyze time. Three was the empirical sweet spot.

### Upscale target

```python
target_h = 120  # was bumped to 200 then reverted (see history)
```

Upscaling tiny crops gives EasyOCR more pixels to work with. The
target was bumped from 120 to 200 once, but **regression**: bigger
crops introduced cubic-interpolation artifacts that made some
already-readable mid-size crops produce **worse** OCR output. So
120 is back. The setting is at `pipeline/ocr_devices.py:519`.

### `parse_make_model()` — the parser

`pipeline/ocr_devices.py:297`. Two-tier:

**Tier 1: Model regex.** Walk `MODEL_PATTERNS` (a list of
`(vendor, regex)` tuples). First hit returns `(vendor, model)`.

```python
MODEL_PATTERNS = [
    ("Cisco",     re.compile(r"\b(?:WS-C|C)\d{4,5}[A-Z]*-\d{1,3}...")),
    ("Cisco",     re.compile(r"\bN\d[A-Z]?-C\d{4,5}...")),
    ("Cisco",     re.compile(r"\bPIX-?\d{3,4}[A-Z]?\b")),
    ("TP-Link",   re.compile(r"\bTL-[A-Z]{2,4}\d{3,5}[A-Z]{0,4}\b")),
    ("D-Link",    re.compile(r"\bD[GX]S-\d{3,4}[A-Z]?-\d{1,3}...")),
    ("D-Link",    re.compile(r"\bDSR-\d{3,4}[A-Z]?\b")),
    ("Juniper",   re.compile(r"\b(?:EX|QFX|MX|SRX)\d{3,5}...")),
    ("Aruba",     re.compile(r"\bCX\s?\d{4}[A-Z]?\b")),
    ("HP",        re.compile(r"\b...(?:1810|1820|1910|1920|2530|2540|...)...")),
    ("HP",        re.compile(r"\bMicroServer\s*Gen\d+\b", IGNORECASE)),
    ("HP",        re.compile(r"\bProLiant\s*[A-Z]{2}\d{2,4}...", IGNORECASE)),
    ("Mikrotik",  re.compile(r"\b(?:CRS|CCR|CSS)\d{3,4}(?:-\w{1,12})*\b")),
    ("Mikrotik",  re.compile(r"\bRB\d{3,4}[A-Z]{0,4}(?:-\w{1,8})?\b")),
    ("Ubiquiti",  re.compile(r"\bUSW-[A-Z][A-Za-z0-9]*(?:-\w{1,12}){0,3}\b")),
    ("Ubiquiti",  re.compile(r"\bU(?:SG|DM|AP|XG)-[A-Z0-9]{2,12}...")),
    ("NETGEAR",   re.compile(r"\b(?:GS|JGS|FS|XS|MS|M4|M5)\d{3,4}...")),
    ("SonicWall", re.compile(r"\b(?:TZ|NSa|NSv|NSsp)-?\d{3,4}[A-Z]?\b")),
    ("Synology",  re.compile(r"\bDS\d{3,4}\+?(?:II|III)?\b")),
    ("QNAP",      re.compile(r"\b(?:TS|TVS|TES|TS-h)-\d{2,4}[A-Z+]{0,6}\b")),
    ("APC",       re.compile(r"\b(?:SU[AM]|SMT|SRT|BR|BX|BE)\d{3,4}...")),
    ("Eaton",     re.compile(r"\b(?:5SC|5PX?|9SX|9PX|EBM)\d{3,4}...")),
    ("TRENDnet",  re.compile(r"\bT(?:EG|PE|FC|FI|U)-[A-Z0-9]{2,8}\b")),
    ("HikVision", re.compile(r"\bDS-\d{1,4}[A-Z]?-\w{2,12}...")),
    # ... ~24 patterns total
]
```

Patterns try **normalized** then **original** text. Normalization
(`_normalize_ocr_text`) collapses `_-` and `-_` to `-`, replaces
underscores between alphanumerics with `-`, and collapses spaces
inside model-like tokens. Catches OCR-introduced punctuation noise
like `TL_-SG2428` → `TL-SG2428`.

**Tier 2: Brand keyword + fuzzy match.** If no model regex hits,
walk `BRAND_KEYWORDS` (26 vendors) using `_fuzzy_keyword_match`:

```python
def _fuzzy_keyword_match(text_lower, keyword):
    if keyword in text_lower: return True            # exact
    if len(keyword) < 5: return False                # too short to fuzzy
    budget = 1 if len(keyword) <= 8 else (2 if len(keyword) <= 12 else 3)
    for tok in _TOKEN_RE.findall(text_lower):
        if abs(len(tok) - len(keyword)) > budget: continue
        if _levenshtein_bounded(tok, keyword, budget) <= budget:
            return True
    return False
```

Edit budget scales with keyword length because a 1-char drift on
a 5-char word is 20% noise (suspicious) but on a 10-char word
is 10% (very plausible).

`BRAND_KEYWORDS` includes both canonical spellings and known OCR
misreads:

```python
("Cisco",     ("cisco", "catalyst", "nexus", "meraki", "csco")),
("Mikrotik",  ("mikrotik", "mikrorik", "mikroz", "mikrot",
               "routeros", "routerboard", "cloudrouter",
               "cloudswitch", "cloudsmart")),
("Ubiquiti",  ("ubiquiti", "unifi", "edgeswitch", "edgemax",
               "edgerouter", "amplifi", "ufiber")),
... 23 more
```

When this tier hits, `model` is `None` (we identified the vendor
but couldn't extract a model number). The downstream UI shows a
"Vendor not detected" or "Model not detected" badge depending on
which fields came back, and offers manual entry.

### `parse_version()`

```python
VERSION_PATTERNS = [
    re.compile(r"\bV\d{3}R\d{1,3}(?:C\d{1,3})?\b"),                            # Huawei VRP
    re.compile(r"\b\d{1,3}\.\d{1,3}\(\d{1,3}[A-Za-z]?\)(?:[A-Z]\d{1,3}...)?"), # Cisco NX-OS
    re.compile(r"\b\d{1,3}\.\d{1,3}(?:\.\d{1,3}){1,3}(?:[A-Za-z]\d{0,3})?\b"), # standard
]
```

Returns the first hit. Fed into firmware lookup
([08-firmware.md](08-firmware.md)).

### Output JSON schema

`outputs/<rackId>/ocr_devices.json`:

```json
{
  "ok": true,
  "rack_id": "RK-F74FFCF9",
  "image": "original_image.jpg",
  "generated_at": "2026-05-07T13:55:19Z",
  "devices": [
    {
      "position": "U10",
      "class_name": "Switch",
      "box": [320, 380, 1180, 460],
      "make": "Mikrotik",
      "model": "CRS326-24G-2S+RM",
      "version": "10.5.0.7",
      "raw_text": "Mikrotik Cloud Router Switch CRS326-24G-2S+RM ...",
      "ocr_conf": 0.74,
      "match_conf": 0.88,
      "source": "ocr_full"
    },
    ...
  ]
}
```

`source` enum:
- `ocr_full` — make + model both resolved
- `ocr_make_only` — vendor only (fuzzy keyword path)
- `ocr_failed` — chassis was OCR'd but parser couldn't extract anything
- `skipped` — class wasn't in `OCR_CLASSES`, OCR didn't run

### Triggers + caching

Two trigger paths:

1. **Auto, after analyze**. `scheduleOcrDevices` in
   `server/app.js:1007` fires after `/api/analyze` returns. Runs
   the Python module via `spawnChild`, fire-and-forget.
2. **Manual.** `POST /api/scan/:rackId/ocr-devices` re-runs the
   stage. Used when the user wants to re-OCR after fixing a photo
   or testing a parser change.

Result is cached at `outputs/<rackId>/ocr_devices.json`. The
client polls `GET /api/scan/:rackId/ocr-devices` until the file
appears (see `client/src/utils/scanPrefetch.js`).

### Files in this feature

| File | Role |
|---|---|
| `pipeline/ocr_devices.py` | Main per-bbox OCR pipeline + parser |
| `pipeline/ocr_labels.py` | Whole-image label extraction (front + rear) |
| `pipeline/side_labels.py` | Rack-rail identifier chip OCR (currently dormant) |
| `pipeline/all_vendor.py` | `_pick_vendor_strict`, brand-keyword shared helpers |
| `Switch_Vendors_Websites.xlsx` | Canonical vendor names (column B) |
| `pipeline/benchmark_ocr.py` | Full-image benchmark across a folder of images |
| `pipeline/benchmark_full.py` | Per-device benchmark — runs the real CV+OCR pipeline |
| `clear_vendors_racks/comparison.html` | Manual vs pipeline scoreboard on the 12-image test set |
| `server/app.js:3327, 3377` | `/api/scan/:rackId/ocr-devices` POST + GET routes |
| `client/src/pages/SwitchInformationPage.jsx` | UI consumer of `ocr_devices.json` |

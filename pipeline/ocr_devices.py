"""
ocr_devices.py — per-device OCR for chassis labels.

For each device detected by the rack-scan CV pipeline, crops its bounding box
from the rack image and runs EasyOCR on that crop. Parses the recognized
text for vendor name, model number, and firmware version. Output is keyed by
U-position so the CMDB synth layer can use it as a real-data source.

Pipeline:
  1. Load device_unit_map.json (per-device boxes from CV).
  2. Resolve the original_image (.png/.jpg) from outputs/<rackId>/.
  3. Per device: crop bbox, run EasyOCR, normalize text, parse make/model.
  4. Match make against the Switch_Vendors_Websites.xlsx vendor list.
  5. Write outputs/<rackId>/ocr_devices.json with one record per device.

Output schema (single JSON file):
{
  "rack_id": "RK-XXXXXXXX",
  "image": "original_image.jpg",
  "generated_at": "2026-05-05T19:55:19Z",
  "devices": [
    {
      "position":     "U18",
      "class_name":   "Switch",
      "box":          [x1, y1, x2, y2],
      "make":         "Cisco" | null,
      "model":        "C9300-48P" | null,
      "version":      "16.9.5" | null,
      "raw_text":     "Cisco Catalyst 9300 ...",
      "ocr_conf":     0.84,        # avg OCR confidence inside this crop
      "match_conf":   0.95,        # vendor-list/model-regex match strength
      "source":       "ocr_full" | "ocr_make_only" | "ocr_failed",
    },
    ...
  ]
}

Usage:
    python pipeline/ocr_devices.py <rack_id>
    python pipeline/ocr_devices.py <rack_id> --json    # one JSON line on stdout

Reads paths relative to the project root (parent of this file's dir).
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


VENDOR_EXCEL = ROOT / "Switch_Vendors_Websites.xlsx"

# Class names from the CV pipeline that we actually try to OCR.
#
# Includes "Unidentified" and "Closed Unit" deliberately: when the CV
# classifier can't pin down a device, it tends to be the unusual chassis
# we most need OCR for (CRS518 wavy fascia, the rare HP/QNAP/Synology unit
# the model wasn't trained on). Skipping them costs us recall on exactly
# the devices we already struggle with.
#
# Patch panels, PDUs, UPS, blank panels, and pure storage chassis are
# still skipped — those rarely have model text on the front, and OCRing
# them just adds noise (port-number text "1 2 3 ... 24" everywhere).
OCR_CLASSES = {
    "Switch",
    "Server",
    "Router",
    "Firewall",
    "Aggregation Core",
    "Unidentified",
    "Closed Unit",
}


def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", (s or "").lower())


def load_vendor_names() -> list[str]:
    """Vendor display names from the Excel sheet (column B). Used as the
    canonical list to match OCR'd manufacturer text against."""
    if not VENDOR_EXCEL.exists():
        return []
    try:
        import openpyxl
        wb = openpyxl.load_workbook(VENDOR_EXCEL, read_only=True, data_only=True)
        ws = wb.active
        out = []
        rows = ws.iter_rows(values_only=True)
        next(rows, None)  # header
        for row in rows:
            if len(row) < 2:
                continue
            name = row[1]
            if name and isinstance(name, str):
                out.append(name.strip())
        return out
    except Exception:
        return []


# Per-vendor model-number patterns. We try each in order; the first to hit
# wins. These are intentionally conservative — false positives would push
# wrong data into CMDB. Better to fall back to "ocr_make_only" than to
# guess a model.
MODEL_PATTERNS: list[tuple[str, re.Pattern]] = [
    # Cisco Catalyst part numbers: WS-C2960X-24TS-L, C9300-48P, C9500-32C, etc.
    ("Cisco",   re.compile(r"\b(?:WS-C|C)\d{4,5}[A-Z]*-\d{1,3}[A-Z]{0,4}(?:-\w{1,4})?\b")),
    # Cisco Nexus
    ("Cisco",   re.compile(r"\bN\d[A-Z]?-C\d{4,5}[A-Z0-9-]*\b")),
    # Cisco PIX firewalls (legacy but still in production at small sites)
    ("Cisco",   re.compile(r"\bPIX-?\d{3,4}[A-Z]?\b")),
    # TP-Link JetStream / TL-prefix
    ("TP-Link", re.compile(r"\bTL-[A-Z]{2,4}\d{3,5}[A-Z]{0,4}\b")),
    ("TP-Link", re.compile(r"\bT[1-9]\d{2,3}[A-Z]{0,4}\b")),
    # D-Link
    ("D-Link",  re.compile(r"\bD[GX]S-\d{3,4}[A-Z]?-\d{1,3}[A-Z]{0,4}\b")),
    # D-Link DSR (services router) and DIR (consumer)
    ("D-Link",  re.compile(r"\bDSR-\d{3,4}[A-Z]?\b")),
    # Juniper EX/QFX/MX/SRX
    ("Juniper", re.compile(r"\b(?:EX|QFX|MX|SRX)\d{3,5}[A-Z0-9-]*\b")),
    # Aruba (HPE) — CX 6100, 8320, 8400 series; older 2530/2540
    ("Aruba",   re.compile(r"\bCX\s?\d{4}[A-Z]?\b")),
    ("Aruba",   re.compile(r"\b\d{4}[A-Z]{1,3}-\d{1,3}[A-Z]{0,4}\b")),
    # HP / HPE OfficeConnect & ProCurve switches: 1820-24G, 1920-48G,
    # 2530-24G-PoE+, 2920-48G, V1810. Also MicroServer Gen8/Gen10.
    ("HP",      re.compile(r"\b(?:HP[E]?-?)?(?:1810|1820|1910|1920|2530|2540|2620|2920|2930|3810)[A-Z]?-?\d{0,3}[A-Z+]{0,4}\b")),
    ("HP",      re.compile(r"\bMicroServer\s*Gen\d+\b", re.IGNORECASE)),
    ("HP",      re.compile(r"\bProLiant\s*[A-Z]{2}\d{2,4}[A-Z0-9]*\b", re.IGNORECASE)),
    # Arista 7050, 7280, 7500 series
    ("Arista",  re.compile(r"\b(?:DCS-)?7\d{3}[A-Z]?-\d{1,3}[A-Z0-9-]*\b")),
    # Huawei S-series / CE-series
    ("Huawei",  re.compile(r"\b(?:S|CE)\d{4}[A-Z]?-\d{1,3}[A-Z0-9-]*\b")),
    # Dell PowerSwitch / PowerEdge
    ("Dell",    re.compile(r"\b(?:S|N|R)\d{4}[A-Z]{1,3}\b")),
    # Mikrotik CRS / CCR / CSS / RB series. CRS328, CRS354-48G-4S+2Q+RM,
    # CCR2004, CSS326-24G-2S+RM (Cloud Smart Switch), RB2011iL-RM, etc.
    ("Mikrotik",re.compile(r"\b(?:CRS|CCR|CSS)\d{3,4}(?:-\w{1,12})*\b")),
    ("Mikrotik",re.compile(r"\bRB\d{3,4}[A-Z]{0,4}(?:-\w{1,8})?\b")),
    # Ubiquiti UniFi switches (USW-*), gateways (USG/UDM), access points (UAP-*)
    ("Ubiquiti",re.compile(r"\bUSW-[A-Z][A-Za-z0-9]*(?:-\w{1,12}){0,3}\b")),
    ("Ubiquiti",re.compile(r"\bU(?:SG|DM|AP|XG)-[A-Z0-9]{2,12}(?:-\w{1,8}){0,2}\b")),
    ("Ubiquiti",re.compile(r"\bES-\d{2,4}[A-Z]?(?:-\w{1,8})?\b")),  # EdgeSwitch
    ("Ubiquiti",re.compile(r"\bER-[A-Z0-9]{2,12}\b")),              # EdgeRouter
    # NETGEAR ProSafe / ReadyNAS: GS108, GS724T, JGS524, GS308P, M4300-24X4F
    ("NETGEAR", re.compile(r"\b(?:GS|JGS|FS|XS|MS|M4|M5)\d{3,4}[A-Z]{0,4}(?:-\w{1,8})?\b")),
    # SonicWall TZ-series, NSa, NSv: TZ370, TZ670, NSa-2700, NSv-470
    ("SonicWall", re.compile(r"\b(?:TZ|NSa|NSv|NSsp)-?\d{3,4}[A-Z]?\b")),
    # Synology DiskStation NAS: DS216+II, DS918+, DS1819+
    ("Synology",re.compile(r"\bDS\d{3,4}\+?(?:II|III)?\b")),
    ("Synology",re.compile(r"\bRS\d{3,4}\+?(?:II|III)?\b")),  # RackStation
    # QNAP TS-, TVS-, TS-h-, TES-: TS-451+, TVS-872XT, TS-h1290FX
    ("QNAP",    re.compile(r"\b(?:TS|TVS|TES|TS-h)-\d{2,4}[A-Z+]{0,6}\b")),
    # APC Smart-UPS / Back-UPS: SUA1500R, SMT2200RM2U, SRT3000RMXLI
    ("APC",     re.compile(r"\b(?:SU[AM]|SMT|SRT|BR|BX|BE)\d{3,4}[A-Z0-9]{0,8}\b")),
    # Eaton UPS series: 5SC1500i, 9SX2000I, 5P1500R, 5PX1500iRT
    ("Eaton",   re.compile(r"\b(?:5SC|5PX?|9SX|9PX|EBM)\d{3,4}[A-Za-z0-9]{0,8}\b")),
    # TRENDnet: TEG-S82g, TPE-S88, TEG-30284
    ("TRENDnet",re.compile(r"\bT(?:EG|PE|FC|FI|U)-[A-Z0-9]{2,8}\b")),
    # HikVision NVRs / PoE switches: DS-7732NI-K4, DS-3E0528P-E
    ("HikVision",re.compile(r"\bDS-\d{1,4}[A-Z]?-\w{2,12}(?:-\w{1,6})?\b")),
]

# Firmware-version patterns inside a label region.
VERSION_PATTERNS = [
    re.compile(r"\bV\d{3}R\d{1,3}(?:C\d{1,3})?\b"),                 # Huawei VRP
    re.compile(r"\b\d{1,3}\.\d{1,3}\(\d{1,3}[A-Za-z]?\)(?:[A-Z]\d{1,3})?\b"),  # NX-OS
    re.compile(r"\b\d{1,3}\.\d{1,3}(?:\.\d{1,3}){1,3}(?:[A-Za-z]\d{0,3})?\b"),  # standard
]


def _normalize_ocr_text(text: str) -> str:
    """Normalize common OCR misreads before model-regex matching.
    - Underscores near letters/digits → hyphens (TL_SG → TL-SG)
    - Double punctuation collapse (_- or -_ → -)
    - Spaces inside model-like tokens removed (TL -SG → TL-SG)
    """
    # Collapse _- or -_ to single hyphen
    text = re.sub(r"[_][-]|[-][_]", "-", text)
    # Underscores between alphanumeric chars → hyphen
    text = re.sub(r"(?<=[A-Za-z0-9])_(?=[A-Za-z0-9])", "-", text)
    # Space between letters and hyphen (e.g., "TL -SG" → "TL-SG")
    text = re.sub(r"([A-Z]{2})\s+(-[A-Z])", r"\1\2", text)
    return text


# Brand keyword index. The keyword list per vendor includes both the
# canonical spelling and the most common OCR misreads we've actually seen
# in the wild ("Csco" for Cisco, "Mikrorik" for MikroTik, "Unfi" for
# UniFi, etc.). The fuzzy matcher below catches single-character drifts
# beyond what's enumerated here, so we don't have to spell out every
# possible mangling — only the ones short enough that fuzzy can't safely
# bridge them on its own.
BRAND_KEYWORDS: list[tuple[str, tuple[str, ...]]] = [
    ("Cisco",     ("cisco", "catalyst", "nexus", "meraki", "csco")),
    ("TP-Link",   ("tplink", "tp-link", "jetstream", "omada")),
    ("D-Link",    ("dlink", "d-link")),
    ("Juniper",   ("juniper",)),
    ("Aruba",     ("aruba", "procurve")),
    ("Arista",    ("arista",)),
    ("Huawei",    ("huawei",)),
    ("Dell",      ("dell", "poweredge", "powerswitch", "idrac")),
    ("NETGEAR",   ("netgear", "prosafe", "readynas")),
    # Ubiquiti / UniFi — OCR commonly drops a letter ("Unfi", "Ubiqui");
    # fuzzy match handles those.
    ("Ubiquiti",  ("ubiquiti", "unifi", "edgeswitch", "edgemax", "edgerouter",
                   "amplifi", "ufiber")),
    # MikroTik OCR misreads we've seen on real photos: Mikrorik, Mikroz,
    # Mikrovi, Mikroi, Ruzot (badly mangled). Fuzzy match takes care of
    # "mikrot" / "mikrok" 1-edit variants.
    ("Mikrotik",  ("mikrotik", "mikrorik", "mikroz", "mikrot", "routeros",
                   "routerboard", "cloudrouter", "cloudswitch", "cloudsmart")),
    ("HP",        ("hewlett", "hewlettpackard", "proliant", "microserver",
                   "officeconnect")),
    ("HPE",       ("hpe",)),
    ("SonicWall", ("sonicwall", "sonicos")),
    ("Synology",  ("synology", "diskstation", "rackstation")),
    ("QNAP",      ("qnap",)),
    ("APC",       ("apc", "smartups", "smart-ups", "back-ups", "schneider")),
    ("Eaton",     ("eaton",)),
    ("TRENDnet",  ("trendnet",)),
    ("HikVision", ("hikvision", "hikrision")),
    ("Fortinet",  ("fortinet", "fortigate", "fortiswitch", "fortiap")),
    ("CheckPoint",("checkpoint",)),
    ("Palo Alto", ("paloalto", "panos")),
    ("Extreme",   ("extreme", "extremenetworks", "summit")),
    ("Brocade",   ("brocade", "ruckus", "icx")),
    ("Zyxel",     ("zyxel",)),
    ("Allied Telesis", ("alliedtelesis", "allied-telesis")),
    ("Edge-Core", ("edgecore", "edge-core")),
]


def _levenshtein_bounded(a: str, b: str, max_dist: int) -> int:
    """Return Levenshtein distance, but bail out (returning > max_dist) as
    soon as we know the answer can't be ≤ max_dist. Faster than full DP
    when we only care about close matches."""
    la, lb = len(a), len(b)
    if abs(la - lb) > max_dist:
        return max_dist + 1
    if la == 0: return lb
    if lb == 0: return la
    if a == b:  return 0
    prev = list(range(lb + 1))
    for i, ca in enumerate(a, 1):
        curr = [i] + [0] * lb
        row_min = curr[0]
        for j, cb in enumerate(b, 1):
            curr[j] = min(prev[j] + 1, curr[j-1] + 1, prev[j-1] + (ca != cb))
            if curr[j] < row_min:
                row_min = curr[j]
        if row_min > max_dist:
            return max_dist + 1
        prev = curr
    return prev[-1]


# Pre-compile token splitter — one regex used per OCR pass.
_TOKEN_RE = re.compile(r"[a-z0-9]+")


def _fuzzy_keyword_match(text_lower: str, keyword: str) -> bool:
    """Token-level fuzzy match for brand keywords.

    First a cheap substring check (the original behavior — catches exact
    hits and embedded matches like "mikrotik" inside "mikrotikrouterboard").

    Then a token-level Levenshtein pass: split the text into alphanumeric
    tokens and accept any token within the distance budget. The budget
    grows with keyword length:
       length ≤ 4: NO fuzzy (ambiguity risk too high — "ASP" vs "APC")
       5–8 chars : 1 edit allowed     (Csco→Cisco, Unfi→UniFi)
       9–12 chars: 2 edits allowed   (Mikrorik→Mikrotik, Hewlett→Hewlettt)
       13+       : 3 edits allowed   (PowerEdge→PoverEdges, EdgeSwitch typos)

    Distance scales with length because a single OCR misread
    represents a smaller fraction of total characters in longer words —
    "Mikrorik" vs "Mikrotik" is still 87% similar at 1 edit / 8 chars."""
    if keyword in text_lower:
        return True
    klen = len(keyword)
    if klen < 5:
        return False
    budget = 1 if klen <= 8 else (2 if klen <= 12 else 3)
    for tok in _TOKEN_RE.findall(text_lower):
        if abs(len(tok) - klen) > budget:
            continue
        if _levenshtein_bounded(tok, keyword, budget) <= budget:
            return True
    return False


def parse_make_model(text: str, vendor_names: list[str]) -> tuple[str | None, str | None]:
    """Returns (make, model). make is the canonical name from the Excel
    sheet when matched; model comes from MODEL_PATTERNS."""
    if not text:
        return None, None

    # Normalize OCR artifacts before attempting regex match
    normalized = _normalize_ocr_text(text)

    # Try MODEL_PATTERNS first — a model match also nails down the make.
    # Try on both normalized and original text.
    for vendor, rx in MODEL_PATTERNS:
        m = rx.search(normalized) or rx.search(text)
        if m:
            return vendor, m.group(0).upper()

    # No model — try to identify make from vendor list (substring, slugified).
    text_slug = _slug(text)
    for name in vendor_names:
        if not name or len(name) < 3:
            continue
        if _slug(name) and _slug(name) in text_slug:
            return name, None

    # Brand-keyword pass with fuzzy matching. Goal: tolerate the common
    # OCR misreads ("Csco", "Unfi", "Mikrorik") that would otherwise drop
    # us to "no vendor identified" even when the brand was clearly visible
    # in the photo. Two passes: lowercased original (preserves token
    # boundaries — needed for fuzzy) and slugified (catches keywords that
    # only appear without separators, e.g. "tplink").
    text_lower = text.lower()
    for vendor, kws in BRAND_KEYWORDS:
        for kw in kws:
            if _fuzzy_keyword_match(text_lower, kw) or kw in text_slug:
                return vendor, None

    return None, None


def parse_version(text: str) -> str | None:
    if not text:
        return None
    for rx in VERSION_PATTERNS:
        m = rx.search(text)
        if m:
            return m.group(0)
    return None


def _preprocess_for_ocr(crop):
    """Phone-scanned chassis labels are small + lit unevenly. Run grayscale
    + CLAHE (adaptive histogram eq) so faint text on dark plastic comes out
    legible. Returns the enhanced image; original used as fallback."""
    import cv2
    try:
        gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
        clahe = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8, 8))
        enhanced = clahe.apply(gray)
        # Back to 3ch BGR — EasyOCR is happier with 3-channel input.
        return cv2.cvtColor(enhanced, cv2.COLOR_GRAY2BGR)
    except Exception:
        return crop


def _preprocess_unsharp(crop):
    """Second preprocessing variant: unsharp mask. Sharpens edges without
    pushing contrast as hard as CLAHE — reads better on cleanly lit
    chassis where CLAHE introduces noise. Different failure mode means we
    catch text that CLAHE-pass loses to over-enhancement."""
    import cv2
    try:
        blurred = cv2.GaussianBlur(crop, (0, 0), sigmaX=1.4)
        # amount=1.5 is a moderate sharpen — strong enough to re-edge
        # 1px-wide chassis text strokes without ringing on solid panels.
        sharpened = cv2.addWeighted(crop, 1.5, blurred, -0.5, 0)
        return sharpened
    except Exception:
        return crop


def _extract_labels_in_box(reader, crop) -> list[dict]:
    """Run EasyOCR three times on a single cropped region:
       1. Raw crop                        — baseline
       2. CLAHE-enhanced (contrast)       — wins on dark/uneven lighting
       3. Unsharp-masked (edges)          — wins on cleanly lit chassis

    Merge, dedup by lowercase text, keep the best confidence per phrase.
    Three passes with different preprocessing catches text any single pass
    would lose — and EasyOCR is the bottleneck so adding two more passes
    on small bbox crops is fast (~50ms each)."""
    sources = [crop, _preprocess_for_ocr(crop), _preprocess_unsharp(crop)]

    seen: dict[str, float] = {}
    canonical: dict[str, str] = {}
    for source in sources:
        try:
            results = reader.readtext(source, detail=1, paragraph=False)
        except Exception:
            continue
        for (_pts, text, conf) in results:
            text = (text or "").strip()
            if len(text) < 2:
                continue
            key = text.lower()
            prior = seen.get(key, 0.0)
            if float(conf) > prior:
                seen[key] = float(conf)
            if key not in canonical or len(text) > len(canonical[key]):
                canonical[key] = text

    return [{"text": canonical.get(key, key), "conf": conf}
            for key, conf in seen.items()]


def _resolve_image(rack_dir: Path) -> Path | None:
    for fname in ("original_image.jpg", "original_image.png", "original_image.jpeg"):
        p = rack_dir / fname
        if p.exists():
            return p
    return None


def _sort_labels_by_position(labels: list[dict]) -> list[dict]:
    """OCR returns boxes in detection order. For label-line reading we
    want top-to-bottom, left-to-right within a row."""
    return sorted(labels, key=lambda l: (l.get("y", 0), l.get("x", 0)))


def run(rack_id: str) -> dict:
    rack_dir = ROOT / "outputs" / rack_id
    dum_path = rack_dir / "device_unit_map.json"
    if not dum_path.exists():
        return {"ok": False, "error": f"no device_unit_map.json at {dum_path}",
                "rack_id": rack_id, "devices": []}

    img_path = _resolve_image(rack_dir)
    if not img_path:
        return {"ok": False, "error": f"no original image in {rack_dir}",
                "rack_id": rack_id, "devices": []}

    dum = json.loads(dum_path.read_text(encoding="utf-8"))
    raw_devices = dum.get("devices") or []

    # Lazy imports — these are heavy and we only need them on a real run.
    import cv2
    import easyocr

    img = cv2.imread(str(img_path))
    if img is None:
        return {"ok": False, "error": f"cv2 could not read image {img_path}",
                "rack_id": rack_id, "devices": []}
    h_img, w_img = img.shape[:2]

    reader = easyocr.Reader(["en"], gpu=False, verbose=False)
    vendor_names = load_vendor_names()

    out_devices = []
    for dev in raw_devices:
        cls = dev.get("class_name") or ""
        box = dev.get("box") or []
        units = dev.get("units") or []
        position = (units[0] if units else "").upper() or None

        # Skip CV detections we never expect to label-OCR usefully.
        if cls not in OCR_CLASSES:
            out_devices.append({
                "position":   position,
                "class_name": cls,
                "box":        box,
                "make":       None,
                "model":      None,
                "version":    None,
                "raw_text":   "",
                "ocr_conf":   0.0,
                "match_conf": 0.0,
                "source":     "skipped",
            })
            continue

        if len(box) != 4:
            out_devices.append({
                "position":   position,
                "class_name": cls,
                "box":        box,
                "make":       None, "model": None, "version": None,
                "raw_text":   "", "ocr_conf": 0.0, "match_conf": 0.0,
                "source":     "ocr_failed",
            })
            continue

        x1, y1, x2, y2 = [int(v) for v in box]
        # Clamp + tiny pad so tight boxes don't slice off the edge of text.
        pad = 2
        x1 = max(0, x1 - pad); y1 = max(0, y1 - pad)
        x2 = min(w_img, x2 + pad); y2 = min(h_img, y2 + pad)
        if x2 - x1 < 10 or y2 - y1 < 8:
            out_devices.append({
                "position":   position,
                "class_name": cls,
                "box":        box,
                "make":       None, "model": None, "version": None,
                "raw_text":   "", "ocr_conf": 0.0, "match_conf": 0.0,
                "source":     "ocr_failed",
            })
            continue

        crop = img[y1:y2, x1:x2]
        # Upscale tiny crops so OCR has more pixels to chew on. Switch
        # labels in a 1080p rack image are often only ~25px tall — push
        # them to ~120px so even small chassis stickers are readable.
        # 120 is the proven baseline; pushing higher (e.g. 200) introduces
        # interpolation artifacts that hurt OCR on already-medium crops
        # more than they help small ones.
        ch, cw = crop.shape[:2]
        target_h = 120
        if ch < target_h:
            scale = target_h / float(ch)
            new_w = max(1, int(cw * scale))
            new_h = max(1, int(ch * scale))
            crop = cv2.resize(crop, (new_w, new_h), interpolation=cv2.INTER_CUBIC)

        labels = _extract_labels_in_box(reader, crop)
        # Concatenated text (preserves left-to-right reading inside one row).
        text = " ".join(l["text"] for l in labels)
        ocr_conf = round(sum(l["conf"] for l in labels) / len(labels), 3) if labels else 0.0

        make, model = parse_make_model(text, vendor_names)
        version = parse_version(text)

        if make and model:
            source = "ocr_full"
            # Strong prior: we matched a model regex AND the OCR was readable.
            match_conf = round(min(1.0, 0.6 + 0.4 * ocr_conf), 3)
        elif make:
            source = "ocr_make_only"
            match_conf = round(min(1.0, 0.4 + 0.4 * ocr_conf), 3)
        else:
            source = "ocr_failed"
            match_conf = 0.0

        out_devices.append({
            "position":   position,
            "class_name": cls,
            "box":        [x1, y1, x2, y2],
            "make":       make,
            "model":      model,
            "version":    version,
            "raw_text":   text,
            "ocr_conf":   ocr_conf,
            "match_conf": match_conf,
            "source":     source,
        })

    return {
        "ok":           True,
        "rack_id":      rack_id,
        "image":        img_path.name,
        "generated_at": _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "devices":      out_devices,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("rack_id")
    ap.add_argument("--json", action="store_true",
                    help="Emit one JSON line on stdout (for backend use).")
    args = ap.parse_args()

    try:
        result = run(args.rack_id)
    except Exception as e:
        result = {"ok": False, "error": f"unexpected: {e}",
                  "rack_id": args.rack_id, "devices": []}

    # Always persist to outputs/<rackId>/ocr_devices.json so synth.py can
    # pick it up on the next CMDB build, even if --json wasn't requested.
    if result.get("ok"):
        try:
            out_path = ROOT / "outputs" / args.rack_id / "ocr_devices.json"
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
        except Exception as e:
            result["_persist_error"] = str(e)

    if args.json:
        sys.stdout.write(json.dumps(result))
        sys.stdout.flush()
        sys.exit(0 if result.get("ok") else 2)

    # Pretty mode — human-readable summary for CLI runs.
    if not result.get("ok"):
        print(f"FAILED: {result.get('error')}")
        sys.exit(2)
    devs = result["devices"]
    full = sum(1 for d in devs if d["source"] == "ocr_full")
    partial = sum(1 for d in devs if d["source"] == "ocr_make_only")
    failed = sum(1 for d in devs if d["source"] == "ocr_failed")
    skipped = sum(1 for d in devs if d["source"] == "skipped")
    print(f"Rack {args.rack_id}: {full} full / {partial} make-only / "
          f"{failed} failed / {skipped} skipped (of {len(devs)} devices)")
    for d in devs:
        if d["source"] in ("ocr_full", "ocr_make_only"):
            print(f"  {d.get('position') or '?':<5} {d['class_name']:<14} "
                  f"{d.get('make') or '—'} {d.get('model') or '—'} "
                  f"v={d.get('version') or '—'} (conf={d['match_conf']})")


if __name__ == "__main__":
    main()

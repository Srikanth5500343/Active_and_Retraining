#!/usr/bin/env python3
"""
Dynamic SFP Procurement Recommender.

Determines compatible SFP transceiver modules for a given switch by:
  1. Fetching the switch's datasheet (via all_vendor spec pipeline)
  2. Analyzing specs for SFP slot type information
  3. Searching the web for compatible transceivers
  4. Scraping vendor / retailer pages for real module listings

Returns structured JSON. No hardcoded switch-to-SFP mapping — everything
is inferred dynamically from live web data.

Usage (called by Express backend via runPipelineModule):
  python -m pipeline.sfp_recommend --json --vendor TP-Link --model TL-SG2428P
  python -m pipeline.sfp_recommend --json --vendor Cisco --model C9300-48P \
         --interfaces Te1/0/1,Te1/0/2
"""

import re
import os
import sys
import json
import argparse
import hashlib
import time
from urllib.parse import urlparse, quote_plus
from concurrent.futures import ThreadPoolExecutor, as_completed

from bs4 import BeautifulSoup

# ── Dependencies (same as all_vendor.py) ──────────────────────
try:
    import cloudscraper
    SESSION = cloudscraper.create_scraper(
        browser={"browser": "chrome", "platform": "windows", "mobile": False}
    )
except ImportError:
    import requests as _req
    SESSION = _req.Session()
    SESSION.headers.update({"User-Agent": "Mozilla/5.0"})

try:
    from ddgs import DDGS
    _HAS_DDGS = True
except ImportError:
    _HAS_DDGS = False

# Reuse the spec-fetching pipeline for datasheet analysis.
try:
    from pipeline.all_vendor import fetch_specs
    _HAS_SPECS = True
except ImportError:
    _HAS_SPECS = False

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_PROJECT_ROOT = os.path.dirname(_SCRIPT_DIR)

# ── SFP Standards (IEEE / MSA — these are physics, not "static data") ─
SFP_STANDARDS = {
    "SFP":      {"speed": "1 Gbps",   "standard": "1000BASE-X",  "connector": "LC Duplex",   "form": "SFP"},
    "SFP+":     {"speed": "10 Gbps",  "standard": "10GBASE",     "connector": "LC Duplex",   "form": "SFP+"},
    "SFP28":    {"speed": "25 Gbps",  "standard": "25GBASE",     "connector": "LC Duplex",   "form": "SFP28"},
    "QSFP+":    {"speed": "40 Gbps",  "standard": "40GBASE",     "connector": "MPO/MTP-12",  "form": "QSFP+"},
    "QSFP28":   {"speed": "100 Gbps", "standard": "100GBASE",    "connector": "MPO/MTP-12",  "form": "QSFP28"},
    "QSFP-DD":  {"speed": "400 Gbps", "standard": "400GBASE",    "connector": "MPO/MTP-12",  "form": "QSFP-DD"},
}

# Cable standards — engineering facts, not "static data".
CABLE_STANDARDS = {
    "SR":   {"fiber": "OM3/OM4 MMF",   "connector": "LC-LC Duplex",   "maxDist": "300m"},
    "SX":   {"fiber": "OM3/OM4 MMF",   "connector": "LC-LC Duplex",   "maxDist": "550m"},
    "LR":   {"fiber": "OS2 SMF",       "connector": "LC-LC Duplex",   "maxDist": "10km"},
    "LX":   {"fiber": "OS2 SMF",       "connector": "LC-LC Duplex",   "maxDist": "10km"},
    "SR4":  {"fiber": "OM3/OM4 MMF",   "connector": "MPO-12 Trunk",   "maxDist": "150m"},
    "LR4":  {"fiber": "OS2 SMF",       "connector": "LC-LC Duplex",   "maxDist": "10km"},
    "T":    {"fiber": "Copper Cat6a",   "connector": "RJ45",           "maxDist": "30-100m"},
    "DAC":  {"fiber": "Twinax Copper",  "connector": "Direct Attach",  "maxDist": "1-5m"},
}

# ── Caching ───────────────────────────────────────────────────
_CACHE_DIR = os.path.join(_PROJECT_ROOT, "outputs", "sfp_cache")
_CACHE_TTL_SEC = 7 * 24 * 60 * 60


def _cache_key(vendor, model):
    # Bump the version suffix when scrape/parse logic changes so older
    # cached payloads (which may contain phantom SKUs from a prior parser)
    # are no longer returned.
    raw = f"v4|{vendor.strip().lower()}|{model.strip().lower()}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def _cache_load(key):
    p = os.path.join(_CACHE_DIR, f"{key}.json")
    if not os.path.isfile(p):
        return None
    try:
        if time.time() - os.path.getmtime(p) > _CACHE_TTL_SEC:
            return None
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _cache_save(key, payload):
    try:
        os.makedirs(_CACHE_DIR, exist_ok=True)
        with open(os.path.join(_CACHE_DIR, f"{key}.json"), "w",
                  encoding="utf-8") as f:
            json.dump(payload, f, indent=2)
    except Exception:
        pass


# ── Step 1: Determine SFP slot type from spec data ───────────

_SFP_SPEC_KEYS = re.compile(
    r"(sfp|transceiver|optic|uplink|expansion|fiber|module|slot)",
    re.I,
)

_SLOT_PATTERNS = [
    (re.compile(r"QSFP-?DD|400G",  re.I), "QSFP-DD"),
    (re.compile(r"QSFP28|100G",    re.I), "QSFP28"),
    (re.compile(r"QSFP\+?|40G",    re.I), "QSFP+"),
    (re.compile(r"SFP28|25G",       re.I), "SFP28"),
    (re.compile(r"SFP\+|10G\s*SFP|10GbE?\s*SFP|10GBASE", re.I), "SFP+"),
    (re.compile(r"\bSFP\b|1000BASE|GbE?\s*SFP",            re.I), "SFP"),
]


def infer_slot_from_specs(specs):
    """Parse scraped spec data for SFP slot type.
    Returns (slot_type, evidence_text) or (None, None)."""
    if not specs:
        return None, None

    # First pass: look only at SFP-related spec keys for precision.
    for key, val in specs.items():
        if not _SFP_SPEC_KEYS.search(key):
            continue
        combined = f"{key} {val}"
        for pattern, slot in _SLOT_PATTERNS:
            if pattern.search(combined):
                return slot, combined.strip()

    # Second pass: scan ALL spec values (lower precision, catches things like
    # "Networking Standards: IEEE 802.3ae 10GBASE" which lives under generic keys).
    full_text = " ".join(f"{k}: {v}" for k, v in specs.items())
    for pattern, slot in _SLOT_PATTERNS:
        m = pattern.search(full_text)
        if m:
            start = max(0, m.start() - 40)
            end = min(len(full_text), m.end() + 40)
            return slot, full_text[start:end].strip()

    return None, None


def infer_slot_from_interfaces(interfaces):
    """Infer SFP slot type from CLI interface names (e.g. Te1/0/1 → SFP+)."""
    if not interfaces:
        return None
    for iface in interfaces:
        if re.match(r"Hu",  iface, re.I): return "QSFP28"
        if re.match(r"Fo",  iface, re.I): return "QSFP+"
        if re.match(r"Twe", iface, re.I): return "SFP28"
        if re.match(r"Te",  iface, re.I): return "SFP+"
        if re.match(r"Gi|Fa", iface, re.I): return "SFP"
    return "SFP"


def infer_slot_from_model(vendor, model):
    """Infer from speed hints in the model string."""
    s = f"{vendor} {model}"
    if re.search(r"400G|QSFP-DD",             s, re.I): return "QSFP-DD"
    if re.search(r"100G|QSFP28",              s, re.I): return "QSFP28"
    if re.search(r"40G|QSFP\+?(?!28|DD)",     s, re.I): return "QSFP+"
    if re.search(r"25G|SFP28",                s, re.I): return "SFP28"
    if re.search(r"10G|SFP\+|XG",             s, re.I): return "SFP+"
    return None


# ── Step 2: Search the web for compatible modules ─────────────

_SEARCH_BACKENDS = ["api", "html", "lite"]
_SEARCH_TIMEOUT = 15


def _ddg_search(query, max_results=8):
    """DuckDuckGo search — try backends sequentially to avoid rate limiting."""
    if not _HAS_DDGS:
        return []

    for backend in _SEARCH_BACKENDS:
        try:
            hits = list(DDGS().text(query, max_results=max_results,
                                    backend=backend))
            if hits:
                return hits
        except Exception:
            continue
    return []


def search_sfp_modules(vendor, model, slot_type):
    """Search the web for compatible SFP modules.
    Returns list of {url, title, snippet}."""
    # Multiple targeted queries pull from different retailer ecosystems —
    # FS.com, 10Gtek, Amazon, eBay all index differently, so casting a wider
    # net surfaces more real product listings (each query → up to 6 hits).
    queries = [
        f"{vendor} {model} compatible {slot_type} transceiver buy price",
        f"site:fs.com {slot_type} transceiver {vendor} compatible",
        f"site:10gtek.com {slot_type} {vendor} compatible",
        f"{slot_type} SFP transceiver module {vendor} compatible specifications price",
        f"{vendor} compatible {slot_type} optic 10GBASE-SR 10GBASE-LR transceiver",
        f"third-party {vendor} {slot_type} SFP module 850nm 1310nm",
    ]

    seen = set()
    results = []
    for q in queries:
        try:
            hits = _ddg_search(q, max_results=6)
        except Exception:
            continue
        for hit in hits:
            url = (hit.get("href") or hit.get("url") or "").strip()
            if not url or url in seen:
                continue
            # Skip forums, wikis, Reddit, YouTube — they never have product data
            if re.search(r"reddit\.com|youtube\.com|wikipedia\.org|forum\.|"
                         r"community\.|discuss\.|stackoverflow\.|quora\.com",
                         url, re.I):
                continue
            seen.add(url)
            results.append({
                "url": url,
                "title": (hit.get("title") or "").strip(),
                "snippet": (hit.get("body") or "").strip(),
            })
        # Stop once we have plenty of URLs — keeps total runtime bounded
        if len(results) >= 18:
            break
    return results


# ── Step 3: Scrape pages for structured module data ───────────

# Part number: STRICT — must look like a real product SKU:
#   - Starts with 2-6 letters
#   - Followed by a hyphen
#   - Then alphanumeric segment(s) that MUST contain at least one digit
#   - Total length >= 8 characters
# This filters out garbage like "al-41", "high-speed", "vendor-coded" etc.
_PART_RE = re.compile(
    r"\b([A-Z]{2,6}[-_](?=[A-Z0-9]*\d)[A-Z0-9]{2,}(?:[-_][A-Z0-9]+)*)\b",
    re.I,
)

# Words that are definitely NOT part numbers — reject immediately.
_JUNK_WORDS = re.compile(
    r"^(high|low|ultra|non|multi|single|third|vendor|trade|auto|full|half|"
    r"bi-?di|long|short|hot|cold|dual|quad|fiber|optic|copper|module|"
    r"speed|density|bandwidth|party|coded|range|mode|plug|form|base|wave)-",
    re.I,
)

# Speed: match "1G", "10G", "25G", "40G", "100G", "400G" specifically —
# not arbitrary numbers like "24-Port" or "4x Gigabit".
# Negative lookbehind (?<!\.) prevents matching "25" from "1.25Gbps".
_SPEED_RE = re.compile(r"(?<![.\d])(1|10|25|40|100|400)\s*(?:G(?:bps?|igabit|BE|b/s)?)\b", re.I)

_TYPE_PATTERNS = [
    (re.compile(r"\bSR4\b",  re.I), "SR4"),
    (re.compile(r"\bLR4\b",  re.I), "LR4"),
    (re.compile(r"\bCWDM4\b", re.I), "CWDM4"),
    (re.compile(r"\bDR4\b",  re.I), "DR4"),
    (re.compile(r"\bFR4\b",  re.I), "FR4"),
    (re.compile(r"\bSR\b",   re.I), "SR"),
    (re.compile(r"\bLR\b",   re.I), "LR"),
    (re.compile(r"\bSX\b",   re.I), "SX"),
    (re.compile(r"\bLX\b",   re.I), "LX"),
    (re.compile(r"\bDAC\b",  re.I), "DAC"),
    (re.compile(r"\bcopper\b", re.I), "T"),
    (re.compile(r"\bRJ45\b", re.I), "T"),
]

_PRICE_RE = re.compile(r"\$\s?([\d,]+(?:\.\d{1,2})?)")
_DIST_RE  = re.compile(r"(\d+)\s*(m|km|meter|kilometer)s?", re.I)
_WAVE_RE  = re.compile(r"(\d{3,4})\s*nm", re.I)
_BRAND_RE = re.compile(
    r"\b(Cisco|TP-Link|Juniper|Aruba|HPE|HP|MikroTik|Ubiquiti|Netgear|"
    r"D-Link|Finisar|Brocade|Mellanox|NVIDIA|Intel|FS\.com|10Gtek|"
    r"Fortinet|Alcatel|Nokia|Dell|Huawei|ZTE|Extreme|Ruckus|Allied|"
    r"Axiom|Transition|StarTech|Tripp\s*Lite|ProLabs|AddOn|"
    r"Perle|Antaira|Avago|Amphenol|Molex|FluxLight|"
    r"Oplink|JDSU|Agilent|Emcore|Inphi|Macom|II-VI|Lumentum|"
    r"Viavi|Oclaro|Acacia|Innolight|Hisense|Source\s*Photonics|"
    r"Ligent|Optoway|WTD|Methode|Vitesse|Broadcom|Marvell|Semtech|"
    r"Zyxel|Linksys|Planet|Comnet|Advantech|Moxa|Black\s*Box|Monoprice|"
    r"Belden|Panduit|Corning|Fiberhome|Ciena|Infinera|ADTRAN|Calix|"
    r"Ribbon|Ericsson|Sumitomo|Furukawa|CommScope|Sterlite)\b",
    re.I,
)

# Source domain → brand for URL-based brand inference fallback.
# When page text has no recognisable brand name, use the retailer/vendor
# domain so we still show something meaningful instead of dropping the module.
_DOMAIN_BRAND = {
    "fs.com":              "FS.com",
    "10gtek.com":          "10Gtek",
    "cisco.com":           "Cisco",
    "juniper.net":         "Juniper",
    "hpe.com":             "HPE",
    "aruba.com":           "Aruba",
    "mikrotik.com":        "MikroTik",
    "ubiquiti.com":        "Ubiquiti",
    "netgear.com":         "Netgear",
    "dlink.com":           "D-Link",
    "tp-link.com":         "TP-Link",
    "dell.com":            "Dell",
    "huawei.com":          "Huawei",
    "extremenetworks.com": "Extreme",
    "alliedtelesis.com":   "Allied Telesis",
    "fortinet.com":        "Fortinet",
    "axiomoptics.com":     "Axiom",
    "startech.com":        "StarTech",
    "tripplite.com":       "Tripp Lite",
    "prolabs.com":         "ProLabs",
    "addonnetworks.com":   "AddOn Networks",
    "fluxlight.com":       "FluxLight",
    "lumentum.com":        "Lumentum",
    "ii-vi.com":           "II-VI",
    "viavisolutions.com":  "Viavi",
    "ciena.com":           "Ciena",
    "infinera.com":        "Infinera",
    "adtran.com":          "ADTRAN",
    "calix.com":           "Calix",
    "moxa.com":            "Moxa",
    "blackbox.com":        "Black Box",
    "monoprice.com":       "Monoprice",
}


def _extract_type(text):
    """Extract transceiver type (SR, LR, etc.) from text."""
    for pat, tp in _TYPE_PATTERNS:
        if pat.search(text):
            return tp
    return None


def _scrape_page(url):
    """Fetch a page and extract SFP module entries."""
    try:
        r = SESSION.get(url, timeout=15, allow_redirects=True)
        if r.status_code != 200:
            return []
        ct = (r.headers.get("content-type") or "").lower()
        if "html" not in ct:
            return []
        soup = BeautifulSoup(r.text, "html.parser")
    except Exception:
        return []

    modules = []
    seen_parts = set()

    # Try to extract prices from JSON-LD structured data (e-commerce standard)
    json_ld_prices = {}
    json_ld_brands = {}
    try:
        for script in soup.find_all("script", {"type": "application/ld+json"}):
            data = json.loads(script.string)
            if isinstance(data, dict):
                if data.get("@type") == "Product" and data.get("name") and data.get("offers"):
                    offer = data["offers"][0] if isinstance(data["offers"], list) else data["offers"]
                    pn_match = _PART_RE.search(data.get("name", ""))
                    if pn_match:
                        pn = pn_match.group(1)
                        if offer.get("price"):
                            json_ld_prices[pn] = f"${offer['price']}"
                        # Brand from JSON-LD is the most reliable source
                        ld_brand = (data.get("brand") or {})
                        if isinstance(ld_brand, dict):
                            ld_brand = ld_brand.get("name", "")
                        if ld_brand:
                            json_ld_brands[pn] = str(ld_brand)
    except Exception:
        pass

    # Strategy 1: Table rows — most structured data source.
    for table in soup.find_all("table"):
        for row in table.find_all("tr"):
            cells = row.find_all(["td", "th"])
            if len(cells) < 2:
                continue
            row_text = " ".join(c.get_text(strip=True) for c in cells)
            if not re.search(r"(SFP|QSFP|transceiver|optic|module)", row_text, re.I):
                continue
            mod = _parse_module_text(row_text, url)
            if mod and mod["partNumber"] not in seen_parts:
                seen_parts.add(mod["partNumber"])
                if not mod.get("price") and mod["partNumber"] in json_ld_prices:
                    mod["price"] = json_ld_prices[mod["partNumber"]]
                if not mod.get("brand") and mod["partNumber"] in json_ld_brands:
                    mod["brand"] = json_ld_brands[mod["partNumber"]]
                mod["sourceUrl"] = url
                modules.append(mod)

    # Strategy 2: Product cards / list items with part numbers.
    for el in soup.find_all(["div", "li", "article", "section"]):
        text = el.get_text(" ", strip=True)
        if len(text) < 20 or len(text) > 600:
            continue
        if not re.search(r"(SFP|QSFP|transceiver|optic)", text, re.I):
            continue
        mod = _parse_module_text(text, url)
        if mod and mod["partNumber"] not in seen_parts:
            seen_parts.add(mod["partNumber"])
            if not mod.get("price") and mod["partNumber"] in json_ld_prices:
                mod["price"] = json_ld_prices[mod["partNumber"]]
            if not mod.get("brand") and mod["partNumber"] in json_ld_brands:
                mod["brand"] = json_ld_brands[mod["partNumber"]]
            mod["sourceUrl"] = url
            modules.append(mod)
        if len(modules) >= 8:
            break

    return modules[:8]


_MARKETPLACE_RE = re.compile(
    r"^(amazon|ebay|aliexpress|alibaba|google|bing|youtube|"
    r"reddit|stackoverflow|wikipedia|quora|forum|community)\.",
    re.I,
)


def _humanize_domain(host):
    """Convert a hostname into a readable brand label.
    'shop.acme-tech.co.uk' → 'Acme Tech', 'foo.com' → 'Foo'."""
    if not host:
        return None
    parts = host.split(".")
    # Handle multi-level TLDs like .co.uk / .com.au
    if (len(parts) >= 3 and
            parts[-2] in ("co", "com", "org", "net", "ac", "gov", "edu")):
        sld = parts[-3]
    elif len(parts) >= 2:
        sld = parts[-2]
    else:
        sld = host
    # Hyphens / underscores → spaces, then title-case
    label = re.sub(r"[-_]+", " ", sld).strip().title()
    return label or None


def _domain_brand(url):
    """Infer brand from source URL domain.
    1. Known vendor/retailer → mapped brand label
    2. Marketplace listing  → None (so the JSON-LD brand wins instead)
    3. Anything else        → humanized domain (e.g. 'fluxlight' → 'Fluxlight')
       — gives us *some* attribution so the UI never shows 'Unknown'."""
    try:
        host = urlparse(url).hostname or ""
        host = re.sub(r"^www\.", "", host)
        # Marketplace pages: don't claim the marketplace as the brand;
        # the JSON-LD brand or text-mined brand should take over instead.
        if _MARKETPLACE_RE.match(host):
            return None
        # Exact / suffix match in the curated map (Cisco, FS.com, etc.)
        if host in _DOMAIN_BRAND:
            return _DOMAIN_BRAND[host]
        for domain, brand in _DOMAIN_BRAND.items():
            if host.endswith("." + domain) or host == domain:
                return brand
        # Fallback: humanize the second-level domain so every live-scraped
        # listing has a real attribution. This is still dynamic — the
        # label comes from the actual page that was fetched.
        return _humanize_domain(host)
    except Exception:
        pass
    return None


def _parse_module_text(text, source_url=""):
    """Try to extract a structured module record from a text block."""
    pn = _PART_RE.search(text)
    if not pn:
        return None
    part_number = pn.group(1)
    # Must be at least 8 characters.
    if len(part_number) < 8:
        return None
    # Reject junk words that look like part numbers but aren't.
    if _JUNK_WORDS.match(part_number):
        return None
    # Reject CSS-class style identifiers where one form factor wraps another
    # e.g. "sfp-sfpplus1", "sfp-sfp28", "qsfp-qsfpdd" — these are type names,
    # not product SKUs. Real SKUs like "SFP-10G-SR" pair the form factor with
    # a speed/type, not with another form factor.
    if re.match(r"^(sfp|sfp\+|sfp28|qsfp|qsfp28|qsfp-dd|xfp|gbic)[-_]"
                r"(sfp|sfp\+|sfp28|qsfp|qsfp28|qsfp-dd|xfp|gbic)",
                part_number, re.I):
        return None
    # Reject MSA / IEEE / industry spec references masquerading as SKUs.
    # e.g. SFF-8431 (SFP+ form factor MSA), SFF-8472 (diagnostics MSA),
    # IEEE-802.3, MSA-XXX — these are standards documents, not products.
    if re.match(r"^(sff|ieee|msa|iso|iec|ansi|tia|eia|rfc)[-_]\d",
                part_number, re.I):
        return None
    # Skip switch models, cables, UPS, and other non-SFP items.
    if re.match(r"(TL-SG|TL-ER|C9[23]|DGS-|DXS-|USW-|CRS\d|WS-C|N9K|N5K|"
                r"LC-LC|SC-SC|FTC\d|UPS-|CAT-|OM[1-5]-|OS[12]-|"
                r"HTTP|HTML|CSS-|URL-)", part_number, re.I):
        return None

    speed_m = _SPEED_RE.search(text)
    speed = f"{speed_m.group(1)}G" if speed_m else None

    mod_type = _extract_type(text)

    price_m = _PRICE_RE.search(text)
    price = f"${price_m.group(1)}" if price_m else None

    dist_m = _DIST_RE.search(text)
    distance = f"{dist_m.group(1)}{dist_m.group(2)}" if dist_m else None

    wave_m = _WAVE_RE.search(text)
    wavelength = f"{wave_m.group(1)}nm" if wave_m else None

    brand_m = _BRAND_RE.search(text)
    brand = brand_m.group(1) if brand_m else _domain_brand(source_url)

    return {
        "partNumber": part_number,
        "brand": brand,
        "type": mod_type,
        "speed": speed,
        "wavelength": wavelength,
        "maxDistance": distance,
        "price": price,
        "source": "web",
    }


# ── Step 4: Assemble the recommendation ──────────────────────

def recommend(vendor, model, interfaces=None):
    """Full dynamic recommendation pipeline."""
    key = _cache_key(vendor, model)
    cached = _cache_load(key)
    if cached is not None:
        cached["_cached"] = True
        return cached

    slot_type = None
    slot_source = None
    evidence = None
    spec_data = None
    product_url = None

    # 4a. Fetch spec data via existing pipeline.
    if _HAS_SPECS and vendor and model:
        try:
            spec_result = fetch_specs(vendor, model)
            if spec_result.get("ok") and spec_result.get("specs"):
                spec_data = spec_result["specs"]
                product_url = spec_result.get("productUrl")
                slot_type, evidence = infer_slot_from_specs(spec_data)
                if slot_type:
                    slot_source = "datasheet"
        except Exception as e:
            print(f"[sfp] spec fetch failed: {e}", file=sys.stderr)

    # 4b. Fallback: infer from model name.
    if not slot_type:
        slot_type = infer_slot_from_model(vendor, model)
        if slot_type:
            slot_source = "model-name"

    # 4c. Fallback: infer from interface names.
    if not slot_type and interfaces:
        slot_type = infer_slot_from_interfaces(interfaces)
        if slot_type:
            slot_source = "interface-name"

    # 4d. Last resort default.
    if not slot_type:
        slot_type = "SFP"
        slot_source = "default"

    slot_info = SFP_STANDARDS.get(slot_type, SFP_STANDARDS["SFP"])

    # 4e. Search the web for compatible modules.
    try:
        search_results = search_sfp_modules(vendor, model, slot_type)
    except Exception as e:
        print(f"[sfp] search failed: {e}", file=sys.stderr)
        search_results = []

    # 4f. Scrape top results for structured module data.
    modules = []
    source_urls = []

    try:
        # Scrape up to 12 URLs in parallel — most pages yield 0-2 valid
        # modules, so widening the source set is the main lever for variety.
        urls_to_scrape = [r["url"] for r in search_results[:12]]
        if urls_to_scrape:
            with ThreadPoolExecutor(max_workers=10) as ex:
                futs = {ex.submit(_scrape_page, u): u for u in urls_to_scrape}
                for fut in as_completed(futs, timeout=45):
                    try:
                        scraped = fut.result()
                        if scraped:
                            modules.extend(scraped)
                            source_urls.append(futs[fut])
                    except Exception:
                        pass
    except Exception as e:
        print(f"[sfp] scrape failed: {e}", file=sys.stderr)

    # Always mine part numbers from search snippets too — snippets surface
    # SKUs that didn't appear in scraped page bodies (or whose pages timed
    # out / blocked the scraper). Dedup later by part number handles overlap.
    for hit in search_results:
        snippet = hit.get("snippet", "") + " " + hit.get("title", "")
        if not re.search(r"(SFP|QSFP|transceiver|optic)", snippet, re.I):
            continue
        mod = _parse_module_text(snippet, hit.get("url", ""))
        if mod and mod.get("brand"):
            mod["sourceUrl"] = hit.get("url", "")
            modules.append(mod)

    # Deduplicate by part number, prefer entries with more fields.
    seen = {}
    for m in modules:
        pn = m["partNumber"]
        if pn not in seen:
            seen[pn] = m
        else:
            existing_fields = sum(1 for v in seen[pn].values() if v)
            new_fields = sum(1 for v in m.values() if v)
            if new_fields > existing_fields:
                seen[pn] = m
    modules = list(seen.values())

    # Quality filter: require a recognized brand — brandless entries are
    # scraping noise (CSS class names, internal IDs, navigation links, etc.).
    # Never fall back to brandless modules; show nothing rather than junk.
    modules = [m for m in modules if m.get("brand")]

    # No fallback to a static/generic module list — if we couldn't find real
    # products via live scraping, we return an empty list so the UI can show
    # an honest "no results" state instead of phantom or pre-baked entries.

    # Cap at 15 — gives the UI enough variety for Primary + Budget +
    # ~12 alternatives without being overwhelming.
    modules = modules[:15]

    # 4g. Determine cable recommendations — always use standard set for slot type.
    # Scraped module types are often incomplete (null), so use the full standard
    # set rather than only types found in scraped data.
    if slot_type in ("SFP",):
        module_types = ["SX", "LX", "T"]
    elif slot_type in ("SFP+", "SFP28"):
        module_types = ["SR", "LR", "T", "DAC"]
    elif slot_type in ("QSFP+", "QSFP28", "QSFP-DD"):
        module_types = ["SR4", "LR4", "DAC"]
    else:
        module_types = list(set(m["type"] for m in modules if m.get("type"))) or ["SR", "LR"]

    cables = []
    for mt in module_types:
        cs = CABLE_STANDARDS.get(mt)
        if cs:
            cables.append({"type": mt, **cs})

    # 4h. Generate procurement summary.
    # Prefer same-vendor optics first (exact brand match), then well-known
    # third-party "compatible" suppliers (FS.com, 10Gtek, ProLabs, AddOn,
    # FluxLight, Axiom) — these explicitly sell modules coded for any switch
    # vendor. Avoid promoting another switch vendor's branded optics
    # (e.g. MikroTik for a TP-Link switch) since lock-coding can fail.
    def _norm(s):
        return re.sub(r"[\s\.\-_]", "", (s or "").lower())
    vendor_norm = _norm(vendor)
    # Pre-normalized: "fs.com" → "fscom", "Tripp Lite" → "tripplite", etc.
    third_party = {"fscom", "10gtek", "prolabs", "addon", "addonnetworks",
                   "fluxlight", "axiom", "tripplite", "startech"}
    same_vendor = [m for m in modules
                   if vendor_norm and _norm(m.get("brand")) == vendor_norm]
    third_party_modules = [m for m in modules
                           if _norm(m.get("brand")) in third_party]
    if same_vendor:
        recommended = same_vendor[0]
    elif third_party_modules:
        recommended = third_party_modules[0]
    elif modules:
        recommended = modules[0]
    else:
        recommended = None
    budget = None
    if modules:
        priced = [m for m in modules if m.get("price")]
        if priced:
            priced.sort(key=lambda m: float(
                re.sub(r"[^\d.]", "", m["price"])[:10] or "9999"))
            budget = priced[0]

    payload = {
        "ok": True,
        "vendor": vendor,
        "model": model,
        "slotType": slot_type,
        "slotSource": slot_source,
        "slotInfo": slot_info,
        "evidence": evidence,
        "productUrl": product_url,
        "modules": modules[:15],
        "recommended": recommended,
        "budget": budget,
        "cables": cables,
        "searchResults": search_results[:6],
        "sourceUrls": source_urls,
        "moduleTypes": module_types,
    }

    # Only cache successful, non-empty results — caching an empty payload
    # would lock the user into "no results" for the full 7-day TTL even if
    # scraping might succeed on the next run.
    if payload["modules"]:
        _cache_save(key, payload)
    return payload


# ── CLI ───────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Dynamic SFP procurement recommender")
    parser.add_argument("--vendor", required=True)
    parser.add_argument("--model",  required=True)
    parser.add_argument("--interfaces", default="",
                        help="Comma-separated interface names (e.g. Te1/0/1,Te1/0/2)")
    parser.add_argument("--json", action="store_true",
                        help="Emit single JSON line on stdout")
    args = parser.parse_args()

    ifaces = [i.strip() for i in args.interfaces.split(",") if i.strip()] \
             if args.interfaces else None

    try:
        result = recommend(args.vendor, args.model, interfaces=ifaces)
    except Exception as e:
        slot = infer_slot_from_model(args.vendor, args.model) or \
               (infer_slot_from_interfaces(ifaces) if ifaces else "SFP")
        result = {
            "ok": True,
            "vendor": args.vendor,
            "model": args.model,
            "slotType": slot,
            "slotSource": "default",
            "slotInfo": SFP_STANDARDS.get(slot, SFP_STANDARDS["SFP"]),
            "modules": [],
            "recommended": None,
            "budget": None,
            "cables": [],
            "searchResults": [],
            "sourceUrls": [],
            "moduleTypes": [],
            "_error": str(e),
        }

    if args.json:
        print(json.dumps(result))
    else:
        print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()

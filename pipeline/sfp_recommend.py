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
from urllib.parse import urlparse, quote_plus, urljoin
from concurrent.futures import ThreadPoolExecutor, as_completed

from bs4 import BeautifulSoup
import requests as _req  # always available; used for the image-validation session

# ── Dependencies (same as all_vendor.py) ──────────────────────
try:
    import cloudscraper
    SESSION = cloudscraper.create_scraper(
        browser={"browser": "chrome", "platform": "windows", "mobile": False}
    )
except ImportError:
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


# DuckDuckGo image-search fallback. Used when page scraping fails to
# return a per-SKU image (Amazon blocks us, FS.com PDPs return 202,
# random blog posts have no product photos, etc). Returns up to N
# candidate URLs in ranked order so the caller can validate each and
# fall through to the next when the top hit is hot-link-blocked.
def _ddg_image_search(query, max_results=6):
    if not _HAS_DDGS:
        return []
    try:
        hits = list(DDGS().images(query, max_results=max_results,
                                  safesearch="off"))
    except Exception:
        return []
    out = []
    for h in hits or []:
        url = h.get("image") or h.get("thumbnail") or h.get("url")
        if url and url.startswith("http"):
            out.append(url)
    return out


# Dedicated session for image-URL validation. Cloudscraper's SSL context
# rejects `verify=False` (check_hostname conflict), so we use a plain
# requests.Session with cert verification disabled — image URLs don't
# carry credentials, and Python's trust store on Windows commonly fails
# legit retailer certs that every browser accepts.
import urllib3 as _urllib3
_urllib3.disable_warnings(_urllib3.exceptions.InsecureRequestWarning)
_IMG_VALIDATION_SESSION = _req.Session()
_IMG_VALIDATION_SESSION.headers.update({
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                   "AppleWebKit/537.36 (KHTML, like Gecko) "
                   "Chrome/120.0 Safari/537.36"),
    "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
})


# Validate an image URL. Three outcomes:
#   - True   : we have positive evidence it's an image (HTTP 200+image/*,
#              or magic-bytes match on a response body)
#   - False  : we have positive evidence it's NOT an image (404, HTML
#              error page, payload-too-small, blocklist pattern match)
#   - True   : we can't tell (network timeout / SSL error / corporate
#              proxy intercept) — accept and let the browser try, since
#              "can't reach from Python" is not the same as "broken in
#              browser" (different cert store, system proxy, etc.)
#
# This was tightened from "any failure → reject" because the user's
# network blocks bhphotovideo / bciimage at the Python layer (proxy at
# 10.10.1.1) while the browser handles them fine via the same proxy.
def _validate_image_url(url):
    if _IMG_SKIP_RE.search(url):
        return False
    sess = _IMG_VALIDATION_SESSION
    # 1. HEAD — cheapest, most CDNs answer this.
    head = None
    try:
        head = sess.head(url, timeout=4, allow_redirects=True, verify=False)
    except Exception:
        head = None
    if head is not None:
        ct = (head.headers.get("content-type") or "").lower()
        if head.status_code in (200, 304) and ct.startswith("image/"):
            return True
        if head.status_code == 404:
            return False
        if head.status_code in (200, 304) and ct.startswith("text/html"):
            return False  # 200 HTML = "page not found" disguised as success
    # 2. GET-tail — covers CDNs that block HEAD or send the wrong
    #    content-type. Magic-byte sniff catches images served with
    #    text/html headers (some CDNs misconfigure this).
    try:
        r = sess.get(url, timeout=5, stream=True, verify=False,
                     headers={"Range": "bytes=0-1024"})
    except Exception:
        # Network unreachable from Python — could still work in browser
        # (different proxy path, cert store). Be permissive.
        return True
    if r.status_code == 404:
        return False
    ct = (r.headers.get("content-type") or "").lower()
    if r.status_code in (200, 206) and ct.startswith("image/"):
        return True
    try:
        magic = next(r.iter_content(chunk_size=16), b"") or b""
    except Exception:
        magic = b""
    is_image = (
        magic.startswith(b"\xff\xd8\xff")       or   # JPEG
        magic.startswith(b"\x89PNG\r\n\x1a\n")  or   # PNG
        magic.startswith(b"GIF87a")             or
        magic.startswith(b"GIF89a")             or
        (magic.startswith(b"RIFF") and b"WEBP" in magic) or
        magic.startswith(b"<svg")               or
        magic.startswith(b"<?xml")
    )
    if is_image:
        return True
    if r.status_code in (200, 206) and ct.startswith("text/html"):
        return False  # HTML body → definitely not an image
    # Ambiguous result (403/401/500 etc.): assume browser may succeed
    # via cookies / different proxy path / system trust store.
    return True


# Best-of-N: walk a list of candidate image URLs in order and return
# the first one that validates. Stops as soon as it finds a winner so
# we don't waste round-trips when the top hit is already good.
def _pick_first_valid_image(candidates):
    for url in candidates or []:
        if _validate_image_url(url):
            return url
    return None


# ── Image proxy / local cache ─────────────────────────────────────────
# To eliminate every browser-side image failure mode (hot-link blocks,
# CORS, corporate-proxy intercept, mixed-content errors), we DOWNLOAD
# each candidate image server-side and store it under outputs/sfp_images
# keyed by a hash of the remote URL. The path /outputs/* is already
# served statically by app.js, so the client gets a same-origin URL it
# always loads cleanly. Any URL we can't fetch from our network is also
# unavailable to the client — so a successful download is a stronger
# guarantee than HEAD-validation alone.
_IMG_CACHE_DIR = os.path.join(_PROJECT_ROOT, "outputs", "sfp_images")
_MAX_DOWNLOAD_BYTES = 4 * 1024 * 1024   # 4MB hard cap per image
_MIN_KEEP_BYTES     = 1500              # below this is almost certainly an icon

def _detect_image_ext(first_bytes, content_type=""):
    if first_bytes.startswith(b"\xff\xd8\xff"):           return "jpg"
    if first_bytes.startswith(b"\x89PNG\r\n\x1a\n"):      return "png"
    if first_bytes.startswith(b"GIF87a") or first_bytes.startswith(b"GIF89a"): return "gif"
    if first_bytes.startswith(b"RIFF") and b"WEBP" in first_bytes: return "webp"
    ct = (content_type or "").lower()
    if ct.startswith("image/jpeg") or ct.startswith("image/jpg"): return "jpg"
    if ct.startswith("image/png"):  return "png"
    if ct.startswith("image/gif"):  return "gif"
    if ct.startswith("image/webp"): return "webp"
    return None

def _download_image_to_cache(remote_url):
    """Download an image to outputs/sfp_images/<hash>.<ext>.
    Returns the LOCAL relative URL on success, None on failure.
    Failures include: blocklisted URL, network errors, non-image body,
    file below the minimum-keep-size (i.e. an icon or placeholder).
    """
    if not remote_url or _IMG_SKIP_RE.search(remote_url):
        return None
    h = hashlib.sha1(remote_url.encode("utf-8")).hexdigest()[:16]
    # Cache hit — we've already downloaded this URL in a prior run.
    try:
        for fn in os.listdir(_IMG_CACHE_DIR):
            if fn.startswith(h + "."):
                return f"/outputs/sfp_images/{fn}"
    except FileNotFoundError:
        pass
    os.makedirs(_IMG_CACHE_DIR, exist_ok=True)
    try:
        r = _IMG_VALIDATION_SESSION.get(
            remote_url, timeout=8, verify=False, stream=True,
        )
    except Exception:
        return None
    if r.status_code not in (200, 206):
        return None
    # Sniff first chunk → derive extension; if we can't tell it's an
    # image, drop without writing anything.
    try:
        first = next(r.iter_content(chunk_size=64), b"") or b""
    except Exception:
        return None
    ext = _detect_image_ext(first, r.headers.get("content-type", ""))
    if not ext:
        return None
    dest = os.path.join(_IMG_CACHE_DIR, f"{h}.{ext}")
    total = len(first)
    try:
        with open(dest, "wb") as f:
            f.write(first)
            for chunk in r.iter_content(chunk_size=16384):
                if not chunk:
                    continue
                total += len(chunk)
                if total > _MAX_DOWNLOAD_BYTES:
                    raise RuntimeError("too large")
                f.write(chunk)
    except Exception:
        try: os.remove(dest)
        except Exception: pass
        return None
    # Reject tiny files — almost always icons / "image not found" pages
    # that slipped past the magic-byte check (e.g. tiny 1px PNG).
    try:
        if os.path.getsize(dest) < _MIN_KEEP_BYTES:
            os.remove(dest)
            return None
    except Exception:
        return None
    return f"/outputs/sfp_images/{h}.{ext}"


# Try N candidate URLs in order; first one that DOWNLOADS to our cache
# wins. Returns the local URL (same-origin path) or None.
def _pick_and_cache_image(candidates):
    for url in candidates or []:
        local = _download_image_to_cache(url)
        if local:
            return local
    return None


# Trust gate for scraped imageUrls. A scraped image is only safe to
# use directly when it's *from the same domain as the page that listed
# the product* (or from a well-known retailer/distributor CDN). Random
# off-site hosts (stock-photo sites, blog content CDNs, image-board
# uploaders) often serve unrelated images even when they validate as
# "200 + image/*". Anything outside the trust gate gets a forced DDG
# image-search fallback so the user doesn't see banners/badges/wrong
# product photos that happen to be valid PNGs.
_TRUSTED_IMG_HOST_RE = re.compile(
    r"(^|\.)(fs\.com|cisco\.com|"
    r"amazon\.(com|co\.uk|de|fr|it|es|ca|com\.au)|m\.media-amazon\.com|"
    r"ssl-images-amazon\.com|"
    r"startech\.com|infinitecables\.com|10gtek\.com|fluxlight\.com|"
    r"digikey\.com|mouser\.com|arrow\.com|avnet\.com|tessco\.com|"
    r"juniper\.net|arista\.com|aruba(hpe)?\.com|ui\.com|ubnt\.com|"
    r"tp-link\.com|tplinkcdn\.com|netgear\.com|dell\.com|hpe\.com|"
    r"shopify\.com|myshopify\.com|cdn\.shopify\.com|"
    r"cloudfront\.net|akamaized\.net|cloudinary\.com|wp\.com|imgix\.net|"
    r"newegg\.com|bhphotovideo\.com|ebayimg\.com|cdw\.com|cdwg\.com|"
    r"worldwidesupply\.net|provantage\.com|amazon\.in|flipkart\.com)$",
    re.I,
)
def _is_trusted_image_host(img_url, source_url):
    img_host = (urlparse(img_url).hostname or "").lower()
    src_host = (urlparse(source_url).hostname or "").lower()
    img_host = re.sub(r"^www\.", "", img_host)
    src_host = re.sub(r"^www\.", "", src_host)
    if not img_host:
        return False
    # Same hostname or sub/superdomain of the page that listed the product.
    if img_host == src_host:
        return True
    if src_host:
        # Strip down to the registrable domain (last two labels for .com,
        # last three for multi-part TLDs like .co.uk) so a CDN subdomain
        # of the same site is recognised.
        parts = src_host.split(".")
        if len(parts) >= 3 and parts[-2] in ("co", "com", "org", "net"):
            root = ".".join(parts[-3:])
        else:
            root = ".".join(parts[-2:])
        if img_host == root or img_host.endswith("." + root):
            return True
    return bool(_TRUSTED_IMG_HOST_RE.search(img_host))


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

    # Try to extract prices + product images from JSON-LD structured data
    # (e-commerce standard). JSON-LD images are per-SKU and the most
    # reliable — Cisco, FS.com, Amazon, big retailers all emit them.
    json_ld_prices = {}
    json_ld_brands = {}
    json_ld_images = {}
    try:
        for script in soup.find_all("script", {"type": "application/ld+json"}):
            data = json.loads(script.string)
            if isinstance(data, dict):
                if data.get("@type") == "Product" and data.get("name"):
                    pn_match = _PART_RE.search(data.get("name", ""))
                    if pn_match:
                        pn = pn_match.group(1)
                        offers = data.get("offers")
                        if offers:
                            offer = offers[0] if isinstance(offers, list) else offers
                            if isinstance(offer, dict) and offer.get("price"):
                                json_ld_prices[pn] = f"${offer['price']}"
                        ld_brand = (data.get("brand") or {})
                        if isinstance(ld_brand, dict):
                            ld_brand = ld_brand.get("name", "")
                        if ld_brand:
                            json_ld_brands[pn] = str(ld_brand)
                        # Image field is sometimes a string, sometimes a list,
                        # sometimes an ImageObject dict with a `url` field.
                        img = data.get("image")
                        if isinstance(img, list) and img:
                            img = img[0]
                        if isinstance(img, dict):
                            img = img.get("url") or img.get("contentUrl")
                        if isinstance(img, str) and img:
                            json_ld_images[pn] = urljoin(url, img)
    except Exception:
        pass

    # Page-level og:image / twitter:image — used as a fallback ONLY when
    # the page is showing a single product. On multi-product list pages
    # the OG image is usually a banner / category hero, not a real photo.
    page_og_image = None
    for sel in (("meta", {"property": "og:image"}),
                ("meta", {"name": "og:image"}),
                ("meta", {"property": "twitter:image"}),
                ("meta", {"name": "twitter:image"})):
        tag = soup.find(*sel)
        if tag and tag.get("content"):
            page_og_image = urljoin(url, tag["content"].strip())
            break

    # Strategy 1: Table rows — most structured data source.
    # We also harvest a per-row image from <img> tags inside each row so a
    # table that lists products with thumbnails (FS.com, Cisco Commerce,
    # most catalog pages) yields the right photo per SKU even when JSON-LD
    # is missing.
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
                row_img = _best_img_in(row, url)
                img = json_ld_images.get(mod["partNumber"]) or row_img
                if img:
                    mod["imageUrl"] = img
                mod["sourceUrl"] = url
                modules.append(mod)

    # Strategy 2: Product cards / list items with part numbers. Same
    # per-element image harvest as Strategy 1.
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
            el_img = _best_img_in(el, url)
            img = json_ld_images.get(mod["partNumber"]) or el_img
            if img:
                mod["imageUrl"] = img
            mod["sourceUrl"] = url
            modules.append(mod)
        if len(modules) >= 8:
            break

    # Rescue pass: if text-snippet strategies found nothing but the page
    # has JSON-LD Product schema (typical of FS.com / Shopify / Magento
    # product-detail pages with long descriptions that overflow the
    # 20-600 char text window), build the module straight from JSON-LD.
    if not modules and (json_ld_prices or json_ld_brands or json_ld_images):
        all_pns = set(json_ld_prices) | set(json_ld_brands) | set(json_ld_images)
        for pn in all_pns:
            mod = _parse_module_text(pn, url) or {"partNumber": pn}
            if not mod.get("partNumber"):
                mod["partNumber"] = pn
            if json_ld_prices.get(pn):  mod["price"]    = json_ld_prices[pn]
            if json_ld_brands.get(pn):  mod["brand"]    = json_ld_brands[pn]
            if json_ld_images.get(pn):  mod["imageUrl"] = json_ld_images[pn]
            mod["sourceUrl"] = url
            modules.append(mod)
        if not modules:
            # Still nothing — fall back to a single module from the page
            # itself, since at minimum we know it's a product page.
            pass

    # Final pass: when a page yields exactly one module, it's almost
    # certainly a product-detail page — look for the main product image
    # in the conventional product-gallery containers first, and only
    # fall back to og:image if those don't yield anything. Both paths
    # apply the same logo / banner filters so we don't end up showing
    # the site brand again.
    if len(modules) == 1 and not modules[0].get("imageUrl"):
        pn = modules[0]["partNumber"]
        img = _find_product_image(soup, url, pn)
        if not img and page_og_image and not _IMG_SKIP_RE.search(page_og_image):
            img = page_og_image
        if img:
            modules[0]["imageUrl"] = img

    return modules[:8]


# Hunt for the main product image on a product-detail page. Walks the
# DOM looking for <img> inside containers whose class/id matches the
# common "product gallery" patterns, then takes the largest one. Used
# only when a single module was extracted (i.e. likely a PDP).
def _find_product_image(soup, base_url, part_number=None):
    candidate_imgs = []
    # 1. Containers with product-image-flavoured class or id.
    for tag in soup.find_all(["div", "section", "figure", "ul", "li"]):
        cls = " ".join(tag.get("class") or [])
        tag_id = tag.get("id") or ""
        if _PRODUCT_IMG_CLASS_RE.search(cls) or _PRODUCT_IMG_CLASS_RE.search(tag_id):
            for img in tag.find_all("img"):
                src = _img_src(img)
                if src and not src.startswith("data:") and not _IMG_SKIP_RE.search(src):
                    candidate_imgs.append((img, src))
    # 2. Common shop themes nest the main image inside <a class="product-image">.
    for a in soup.find_all("a", {"class": _PRODUCT_IMG_CLASS_RE}):
        for img in a.find_all("img"):
            src = _img_src(img)
            if src and not src.startswith("data:") and not _IMG_SKIP_RE.search(src):
                candidate_imgs.append((img, src))
    if not candidate_imgs:
        return None
    # If the part number matches an alt, trust that hit unconditionally.
    if part_number:
        pn_re = re.compile(re.escape(part_number), re.I)
        for img, src in candidate_imgs:
            if pn_re.search(img.get("alt") or ""):
                return urljoin(base_url, src.strip())
    # Otherwise return the largest by declared size (or the first when
    # nothing has declared dimensions).
    best, best_score = None, -1
    for img, src in candidate_imgs:
        try:
            w = int(img.get("width") or 0)
            h = int(img.get("height") or 0)
        except (TypeError, ValueError):
            w = h = 0
        score = (w * h) or 1
        if score > best_score:
            best_score = score
            best = urljoin(base_url, src.strip())
    return best


# Best <img> inside a given element — picks the most product-likely
# image and rejects site logos, banners, and tracking junk. Returns
# absolute URL or None.
#
# Filtering tiers (highest priority first):
#   1. <img alt="..."> contains the part number  → strong match, use it
#   2. <img> whose src/alt doesn't look like a logo/banner → take largest
#   3. Otherwise → None (caller falls through to silhouette)
#
# Site logos are the main false-positive — FS.com, Amazon, Cisco all
# embed brand banners inside product cards. We reject by URL path, alt
# text, and (for og:image) declared role.
_IMG_SKIP_RE = re.compile(
    r"(pixel|spacer|blank|tracking|favicon|loader|sprite|placeholder|"
    r"logo|banner|header[-_]?img|brand[-_]?mark|sitelogo|site[-_]?logo|"
    r"badge|trustpilot|payment|cards?\.(svg|png|jpg)|"
    # FS.com banner/promo images live under /mall/generalImg/ — no
    # actual product photos are stored there. Same pattern for any
    # /general/ or /promo/ path on retailer CDNs.
    r"/(generalImg|general|promo|hero[-_]banner|category)/|"
    # "Image coming soon" placeholders — OPTCORE literally serves a
    # file called `image-comming-soon_500.jpg` (their typo) on every
    # product without a photo, which validates as a real image. Catch
    # by URL pattern; nothing useful has "coming-soon" / "no-image" in
    # its path.
    r"(comming[-_]?soon|coming[-_]?soon|no[-_]?image|no[-_]?photo|"
    r"nopic|image[-_]?unavailable|product[-_]?placeholder|"
    r"tbd[-_]?image|missing[-_]?image|default[-_]?product))",
    re.I,
)
# Product-image container class names — when we find ONE module on a
# page we look inside these first, since they reliably hold the real
# product photo on retailer product-detail pages (FS, Cisco Commerce,
# Shopify themes, Magento, WooCommerce, BigCommerce).
_PRODUCT_IMG_CLASS_RE = re.compile(
    r"\b(product[-_]?(image|gallery|photo|media|main)?|"
    r"gallery[-_]?(image|main|hero)?|"
    r"main[-_]?(image|photo)|hero[-_]?image|"
    r"primary[-_]?image|sku[-_]?image|featured[-_]?image)\b",
    re.I,
)
_LOGO_ALT_RE = re.compile(
    r"\b(logo|banner|company|brand|home\s*page|site)\b", re.I,
)
def _best_img_in(el, base_url, part_number=None):
    # First pass: an <img> whose alt explicitly names this part number is
    # almost certainly the right product photo. Trust it unconditionally.
    if part_number:
        pn_re = re.compile(re.escape(part_number), re.I)
        for img in el.find_all("img"):
            alt = (img.get("alt") or "").strip()
            src = _img_src(img)
            if not src or src.startswith("data:"):
                continue
            if pn_re.search(alt):
                return urljoin(base_url, src.strip())
    # Second pass: largest non-logo image. Score = w×h, with unsized
    # images getting a small floor so they remain candidates.
    best = None
    best_score = 0
    for img in el.find_all("img"):
        src = _img_src(img)
        if not src or src.startswith("data:"):
            continue
        if _IMG_SKIP_RE.search(src):
            continue
        alt = (img.get("alt") or "").strip()
        if alt and _LOGO_ALT_RE.search(alt):
            continue
        # Reject images whose alt is exactly the site domain (typical of
        # the top-of-page brand mark).
        host = urlparse(base_url).hostname or ""
        bare = re.sub(r"^www\.|\.com$|\.net$|\.org$", "", host).strip()
        if bare and alt.lower() == bare.lower():
            continue
        try:
            w = int(img.get("width") or 0)
            h = int(img.get("height") or 0)
        except (TypeError, ValueError):
            w = h = 0
        score = (w * h) or 1
        if score > best_score:
            best_score = score
            best = urljoin(base_url, src.strip())
    return best


def _img_src(img):
    return (img.get("src") or img.get("data-src") or
            img.get("data-lazy-src") or img.get("data-original") or "")


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

    # Image enrichment via server-side download + local cache. For each
    # module we collect candidate URLs (scraped first if trusted, then
    # DDG image search) and try to actually fetch each one to our
    # outputs/sfp_images/ cache. The first that downloads cleanly wins
    # and we hand the client a same-origin /outputs/... URL so browser
    # CORS / hot-link / corporate-proxy issues can't affect rendering.
    # Modules whose images can't be downloaded are DROPPED entirely —
    # we never recommend a part the user can't see.
    def _resolve(mod):
        existing = mod.get("imageUrl")
        source   = mod.get("sourceUrl", "")
        candidates = []
        # Scraped URL is tried first only if it came from a trusted host
        # (page's own domain or a recognized retailer). Random off-site
        # URLs go through the DDG path so we don't propagate banners /
        # site logos / wrong-product images sourced from blog content.
        if existing and _is_trusted_image_host(existing, source):
            candidates.append(existing)
        q = f"{mod.get('brand', '')} {mod['partNumber']} SFP transceiver"
        for c in _ddg_image_search(q.strip(), max_results=8):
            if c not in candidates:
                candidates.append(c)
        return mod, _pick_and_cache_image(candidates)
    try:
        with ThreadPoolExecutor(max_workers=8) as ex:
            for mod, img in ex.map(_resolve, modules):
                if img:
                    mod["imageUrl"] = img
                elif mod.get("imageUrl"):
                    mod.pop("imageUrl", None)
    except Exception as e:
        print(f"[sfp] image enrichment failed: {e}", file=sys.stderr)

    # Hard requirement: a module without a working image is dropped.
    # The procurement card needs a photo so the user can identify what
    # they'd actually be buying; a silhouette is worse than not
    # recommending the part at all.
    modules = [m for m in modules if m.get("imageUrl")]

    # Brand diversification: round-robin across brands so a single
    # high-volume vendor (e.g. OPTCORE's category page lists 8 SKUs)
    # can't crowd out everyone else. Each brand contributes one module
    # per pass until the cap is reached. Within a brand we keep input
    # order, so the most-relevant SKU still surfaces first.
    from collections import OrderedDict
    by_brand = OrderedDict()
    for m in modules:
        by_brand.setdefault(m["brand"], []).append(m)
    diverse = []
    target = 15
    while len(diverse) < target and any(by_brand.values()):
        for brand, bucket in by_brand.items():
            if bucket:
                diverse.append(bucket.pop(0))
                if len(diverse) >= target:
                    break
    modules = diverse

    # No fallback to a static/generic module list — if we couldn't find real
    # products via live scraping, we return an empty list so the UI can show
    # an honest "no results" state instead of phantom or pre-baked entries.

    # (Cap of 15 already enforced by the diversity round-robin above.)

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

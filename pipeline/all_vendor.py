#!/usr/bin/env python3

import re
import os
import sys
import json
import argparse
from urllib.parse import urlparse
from bs4 import BeautifulSoup
import openpyxl

try:
    import cloudscraper
    SESSION = cloudscraper.create_scraper(
        browser={"browser": "chrome", "platform": "windows", "mobile": False}
    )
except ImportError:
    import requests
    SESSION = requests.Session()
    SESSION.headers.update({"User-Agent": "Mozilla/5.0"})
    print("[warn] cloudscraper not installed — Cloudflare-protected sites may return 403. "
          "Install with: pip install cloudscraper",
          file=sys.stderr)

try:
    from ddgs import DDGS
    _HAS_DDGS = True
except ImportError:
    _HAS_DDGS = False
    print("[warn] ddgs not installed — vendor product search will fail. "
          "Install with: pip install ddgs",
          file=sys.stderr)

import hashlib
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from concurrent.futures import TimeoutError as _FuturesTimeoutError


# Default to the spreadsheet shipped with the repo.
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_PROJECT_ROOT = os.path.dirname(_SCRIPT_DIR)
DEFAULT_EXCEL = os.path.join(_PROJECT_ROOT, r"H:\SERVICENOW\SERVICENOW\dark_mobile\Switch_Vendors_Websites.xlsx")


# ─────────────────────────────────────────────
# LOAD VENDOR LIST
# ─────────────────────────────────────────────
def load_vendors(path):
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb.active
    rows = ws.iter_rows(values_only=True)
    next(rows, None)  # header
    out = []
    for row in rows:
        if len(row) < 3:
            continue
        _, name, url = row[0], row[1], row[2]
        if name and url:
            out.append((str(name).strip(), str(url).strip()))
    return out


def _slug(s):
    return re.sub(r"[^a-z0-9]+", "", s.lower())


def pick_vendor(query, vendors):
    q = _slug(query)
    if not q:
        return None

    for name, url in vendors:
        if _slug(name) == q:
            return name, url

    matches = [(n, u) for n, u in vendors if q in _slug(n)]
    if not matches:
        matches = [(n, u) for n, u in vendors if q in _slug(urlparse(u).netloc)]

    if not matches:
        return None
    if len(matches) == 1:
        return matches[0]

    print(f"\nMultiple matches for '{query}':")
    for i, (n, _) in enumerate(matches, 1):
        print(f"  {i}. {n}")
    sel = input("Select #: ").strip()
    try:
        idx = int(sel) - 1
        if 0 <= idx < len(matches):
            return matches[idx]
    except ValueError:
        pass
    return None


# ─────────────────────────────────────────────
# NORMALIZE MODEL
# ─────────────────────────────────────────────
def normalize_model(raw):
    """Extract the SKU from a free-form model string.

    Users routinely type 'Nexus 93180YC-FX' or 'Cisco Nexus 93180YC-FX' when
    they really mean SKU '93180YC-FX'. The previous behavior concatenated all
    words ('CISCONEXUS-93180YC-FX') and additionally injected a hyphen between
    the letter prefix and digits — both wrong. New behavior:

      - Multi-token input → keep ONLY the SKU-shaped token (has both letters
        and digits, prefer the one with the most digits).
      - Single token → just clean separators.
      - Never inject hyphens (Aruba JL675A, Cisco C9300-24T must stay intact).
    """
    s = raw.strip().upper()
    s = s.replace("–", "-").replace("—", "-")

    tokens = s.split()
    if len(tokens) > 1:
        sku_like = [t for t in tokens
                    if re.search(r"\d", t) and re.search(r"[A-Z]", t)]
        if sku_like:
            s = max(sku_like, key=lambda t: sum(c.isdigit() for c in t))
        else:
            s = re.sub(r"\s+", "", s)
    else:
        s = re.sub(r"[\s_]+", "", s)

    s = re.sub(r"-+", "-", s).strip("-")
    return s


# ─────────────────────────────────────────────
# FUZZY MODEL EXPANSION
# OCR sometimes returns partial model strings like "CRS3265" instead of
# "CRS326-24G-2S+RM". This table maps known partial prefixes/fragments to
# the most common full model for each vendor. Used as a fallback when the
# normalized model looks incomplete (no hyphens, suspiciously short, etc.)
# ─────────────────────────────────────────────

# Format: vendor_slug → list of (fragment_pattern, full_model)
# Patterns are matched case-insensitively against the normalized model.
# First match wins, so put more specific patterns before general ones.
_FUZZY_MODEL_DB = {
    "mikrotik": [
        (r"^CRS3265?$",          "CRS326-24G-2S+RM"),
        (r"^CRS3261?",           "CRS326-24G-2S+RM"),
        (r"^CRS3541?",           "CRS354-48G-4S+2Q+RM"),
        (r"^CRS3121?",           "CRS312-4C+8XG-RM"),
        (r"^CRS3171?",           "CRS317-1G-16S+RM"),
        (r"^CRS3051?",           "CRS305-1G-4S+IN"),
        (r"^CRS3281?",           "CRS328-24P-4S+RM"),
        (r"^CRS3282?",           "CRS328-4C-20S-4S+RM"),
        (r"^CRS5181?",           "CRS518-16XS-2XQ-RM"),
        (r"^CRS5041?",           "CRS504-4XQ-IN"),
        (r"^CCR20041?",          "CCR2004-1G-12S+2XS"),
        (r"^CCR20161?",          "CCR2016-1G-12S+2XS"),
        (r"^CCR10091?",          "CCR1009-7G-1C-1S+"),
        (r"^CCR10361?",          "CCR1036-12G-4S"),
        (r"^CCR10721?",          "CCR1072-1G-8S+"),
        (r"^RB4011",             "RB4011iGS+RM"),
        (r"^RB3011",             "RB3011UiAS-RM"),
        (r"^RB2011",             "RB2011UiAS-2HnD-IN"),
        (r"^CSS3261?",           "CSS326-24G-2S+RM"),
        (r"^CSS1061?",           "CSS106-5G-1S"),
    ],
    "cisco": [
        (r"^C93001?",            "C9300-24T"),
        (r"^C93004?",            "C9300-48T"),
        (r"^C93002?",            "C9300-24P"),
        (r"^C93006?",            "C9300-48P"),
        (r"^C92001?",            "C9200-24T"),
        (r"^C92004?",            "C9200-48T"),
        (r"^WSC29601?",          "WS-C2960X-24TS-L"),
        (r"^WSC29604?",          "WS-C2960X-48TS-L"),
        (r"^WSC35601?",          "WS-C3560X-24T-S"),
        (r"^N93001?",            "N9K-C9300-GX"),
        (r"^N95001?",            "N9K-C9500-60C"),
    ],
    "tplink": [
        (r"^TLSG24281?",         "TL-SG2428P"),
        (r"^TLSG10081?",         "TL-SG1008"),
        (r"^TLSG10161?",         "TL-SG1016"),
        (r"^TLSG30101?",         "TL-SG3210"),
        (r"^T15281?",            "T1528"),
        (r"^T25281?",            "T2528"),
        (r"^T35281?",            "T3528"),
    ],
    "juniper": [
        (r"^EX44001?",           "EX4400-24T"),
        (r"^EX43001?",           "EX4300-48T"),
        (r"^EX22001?",           "EX2200-24T-4G"),
        (r"^QFX51001?",          "QFX5100-48S"),
        (r"^QFX51001?",          "QFX5100-24Q"),
    ],
    "aruba": [
        (r"^CX63001?",           "CX 6300M 24-port"),
        (r"^CX64001?",           "CX 6400 Switch"),
        (r"^JL6751?",            "JL675A"),
        (r"^JL3551?",            "JL355A"),
    ],
    "dlink": [
        (r"^DGS30281?",          "DGS-3028"),
        (r"^DGS15101?",          "DGS-1510-28X"),
        (r"^DXS33001?",          "DXS-3300-28SC"),
    ],
}


def _vendor_slug(vendor_str):
    """Normalize vendor name to a lookup key."""
    v = re.sub(r"[^a-z0-9]", "", (vendor_str or "").lower())
    # Aliases
    if "tplink" in v or "tp" in v:
        return "tplink"
    if "mikro" in v:
        return "mikrotik"
    if "cisco" in v:
        return "cisco"
    if "juniper" in v:
        return "juniper"
    if "aruba" in v or "hpe" in v:
        return "aruba"
    if "dlink" in v:
        return "dlink"
    return v


def _looks_partial(model):
    """Return True if the model string looks like an incomplete OCR fragment.
    Heuristics:
      - No hyphens at all (real SKUs almost always have them)
      - Very short (< 6 chars after stripping)
      - Ends abruptly with only digits (e.g. CRS3265 — missing suffix)
    """
    m = model.strip()
    if len(m) < 5:
        return True
    if "-" not in m and "+" not in m and len(m) < 12:
        return True
    # Ends with 1-2 digits that look like a truncated suffix
    if re.search(r"[A-Z]\d{1,2}$", m):
        return True
    return False


def expand_partial_model(model, vendor=""):
    """Try to expand a partial/OCR-garbled model to the best full model.

    Returns the expanded model string, or the original if no match found.
    """
    if not _looks_partial(model):
        return model

    slug = _vendor_slug(vendor)
    candidates = _FUZZY_MODEL_DB.get(slug, [])

    # Also try all vendors if vendor is unknown
    if not candidates:
        for v_candidates in _FUZZY_MODEL_DB.values():
            candidates.extend(v_candidates)

    # Flatten the model for comparison: strip hyphens/+ for matching
    flat = re.sub(r"[^A-Z0-9]", "", model.upper())

    for pattern, full_model in candidates:
        # Match against both the original and flattened form
        if re.match(pattern, model, re.I) or re.match(pattern, flat, re.I):
            return full_model

    # Last resort: if vendor is MikroTik and model starts with CRS/CCR,
    # search the web for the best match via DDGS
    return model


# ─────────────────────────────────────────────
# SEARCH VENDOR DOMAIN VIA PUBLIC SEARCH ENGINES
# ─────────────────────────────────────────────
def _root_domain(url):
    host = urlparse(url).netloc.lower()
    if host.startswith("www."):
        host = host[4:]
    return host


# Vendors that publish spec/release content across multiple domains. The
# Excel sheet only carries one URL per vendor; that URL is often outdated
# or points to a marketing landing page while the actual product/support
# content lives on a different domain. We search all listed domains in
# parallel so users don't get "Product page not found" just because we
# only checked the wrong one.
#
# Vendor key matches the canonical name returned by _pick_vendor_strict
# (case-insensitive). The first domain in each list is treated as primary
# (used for product search); the rest are fallbacks searched in order.
VENDOR_DOMAIN_ALIASES = {
    # HPE acquired Aruba; modern AOS-CX docs + product pages live on
    # arubanetworking.hpe.com and support.hpe.com. The legacy
    # arubanetworks.com still exists but is mostly redirects.
    "Aruba (HPE)": [
        "arubanetworking.hpe.com",
        "support.hpe.com",
        "arubanetworks.com",
        "hpe.com",
    ],
    "Aruba": [
        "arubanetworking.hpe.com",
        "support.hpe.com",
        "arubanetworks.com",
        "hpe.com",
    ],
    "HPE": [
        "hpe.com",
        "support.hpe.com",
        "arubanetworking.hpe.com",
    ],
    # Dell PowerSwitch spec sheets live under dell.com support/manuals
    # paths; the shop URL in the Excel only covers product listings.
    "Dell": [
        "dell.com",
        "infohub.delltechnologies.com",
        "delltechnologies.com",
    ],
    # Cisco product pages use both /c/en/us/products and /site/ patterns
    # under cisco.com; community.cisco.com is excluded by the search-side
    # forum penalty.
    "Cisco": [
        "cisco.com",
    ],
    # Juniper rebranded a few times; juniper.net is canonical.
    "Juniper": [
        "juniper.net",
    ],
    # MikroTik publishes spec sheets at mikrotik.com/products/...
    "Mikrotik": [
        "mikrotik.com",
        "help.mikrotik.com",
    ],
    "MikroTik": [
        "mikrotik.com",
        "help.mikrotik.com",
    ],
    # TP-Link splits between consumer (.com) and business (.com/business).
    "TP-Link": [
        "tp-link.com",
    ],
    # NETGEAR docs split between www and kb subdomains.
    "NETGEAR": [
        "netgear.com",
        "kb.netgear.com",
    ],
    # Ubiquiti / Synology / QNAP / Fortinet — single-domain but worth
    # listing for completeness so future updates have one place to edit.
    "Ubiquiti": ["ui.com", "ubnt.com"],
    "Synology": ["synology.com"],
    "QNAP": ["qnap.com"],
    # Fortinet docs.fortinet.com indexes everything; put it FIRST so the
    # release-notes search lands on /document/fortigate/X.Y.Z/release-notes/
    # rather than on a marketing page on fortinet.com.
    "Fortinet": ["docs.fortinet.com", "fortinet.com"],
    # Huawei: support.huawei.com is the firmware/release-notes home.
    # e.huawei.com (Excel default) is the enterprise marketing site.
    "Huawei": [
        "support.huawei.com",
        "e.huawei.com",
        "consumer.huawei.com",
    ],
    # ZTE: support.zte.com.cn is firmware-bearing; zte.com.cn is marketing.
    "ZTE": [
        "support.zte.com.cn",
        "zte.com.cn",
    ],
    # H3C: h3c.com.hk and en.h3c.com both host docs; primary is en.h3c.com.
    "H3C": [
        "h3c.com",
        "en.h3c.com",
    ],
    # Allied Telesis: alliedtelesis.com hosts firmware under /support/
    # and /resources/; release notes are at alliedtelesis.com/.../release-notes
    "Allied Telesis": [
        "alliedtelesis.com",
        "support.alliedtelesis.com",
    ],
    # Westermo: westermo.com hosts changelog/firmware under /support/.
    "Westermo": ["westermo.com"],
    # Ruijie: ruijienetworks.com (English) and ruijie.com.cn (Chinese).
    # Firmware lives behind login on ruijienetworks.com/support/ but the
    # public release-notes pages are reachable.
    "Ruijie Networks": ["ruijienetworks.com", "ruijie.com.cn"],
    # Yamaha: switches/routers are at network.yamaha.com (separate site
    # from yamahaproaudio.com which is the Excel default for AV gear).
    "Yamaha": [
        "network.yamaha.com",
        "yamahaproaudio.com",
    ],
    # Belden / Hirschmann: post-acquisition the Hirschmann doc tree
    # lives at hirschmann.com and partly under belden.com/products.
    "Belden": [
        "belden.com",
        "hirschmann.com",
    ],
    # ADTRAN: support docs are at adtran.com/.../support and
    # supportcommunity.adtran.com (login).
    "ADTRAN": [
        "adtran.com",
        "supportcommunity.adtran.com",
    ],
    # Alcatel-Lucent Enterprise: al-enterprise.com is the Excel default,
    # myportal.al-enterprise.com hosts the firmware behind login. Also
    # mention support.al-enterprise.com.
    "Alcatel-Lucent Enterprise": [
        "al-enterprise.com",
        "support.al-enterprise.com",
    ],
    # Linksys: linksys.com firmware under /support-product/ (consumer)
    # and /firmware/ (business LGS series).
    "Linksys": ["linksys.com"],
    # DrayTek: draytek.com firmware under /support/.
    "DrayTek": ["draytek.com", "fae.draytek.com"],
    # ZyXEL: zyxel.com (consumer) and service-provider.zyxel.com (carrier).
    # Plus support.zyxel.eu for EU firmware listings.
    "ZyXEL": [
        "zyxel.com",
        "support.zyxel.eu",
        "service-provider.zyxel.com",
    ],
    # Edimax: edimax.com firmware under /us/support/.
    "Edimax Technology": ["edimax.com"],
    # TRENDnet: trendnet.com firmware under /support/.
    "TRENDnet": ["trendnet.com"],
    # TOTOLINK: totolink.net firmware under /home/menu/.
    "TOTOLINK": ["totolink.net"],
    # Avaya: avaya.com (was) — networking spun off into Extreme Networks
    # in 2017. Real release notes for "Avaya ERS" boxes now live on
    # extremenetworks.com under the documentation/legacy section.
    "Avaya": [
        "support.avaya.com",
        "extremenetworks.com",
        "avaya.com",
    ],
    # Buffalo: split between US (buffalotech.com) and JP (buffalo.jp).
    # JP site has the canonical firmware listings translated into English.
    "Buffalo Technology": ["buffalotech.com", "buffalo.jp"],
    # Edgecore: edge-core.com hosts firmware under /support/.
    "Edgecore Networks": ["edge-core.com"],
    # Brocade: now under broadcom.com after acquisition; brocade.com still
    # redirects in places. ICX-series firmware lives on commscope.com
    # (Ruckus/Brocade ICX line was spun out to CommScope).
    "Brocade Communications Systems": [
        "broadcom.com",
        "commscope.com",
        "support.commscope.com",
    ],
    # Ruckus: support.commscope.com is canonical post-acquisition.
    "Ruckus Networks": [
        "commscope.com",
        "support.commscope.com",
        "ruckusnetworks.com",
    ],
    # Schneider Electric: download.schneider-electric.com for firmware,
    # se.com for marketing/products.
    "Schneider Electric": [
        "se.com",
        "download.schneider-electric.com",
        "schneider-electric.com",
    ],
    # Lenovo: datacentersupport.lenovo.com for firmware on switches.
    "Lenovo": [
        "datacentersupport.lenovo.com",
        "lenovopress.lenovo.com",
        "lenovo.com",
    ],
    # Phoenix Contact: phoenixcontact.com hosts firmware under
    # /global/en/products/<product>/downloads.
    "Phoenix Contact (incl. Hirschmann)": [
        "phoenixcontact.com",
        "hirschmann.com",
    ],
    # Moxa: moxa.com firmware under /support/.
    "Moxa": ["moxa.com"],
    # Hikvision: hikvision.com firmware under /en/support/download/.
    "Hikvision Digital Technology": ["hikvision.com"],
    # Teltonika: teltonika-networks.com firmware under wiki and /support/.
    "Teltonika Networks": ["teltonika-networks.com", "wiki.teltonika-networks.com"],
    # Planet: planet.com.tw firmware under /en/support.
    "Planet Technology": ["planet.com.tw", "planetechusa.com"],
    # FS: fs.com hosts firmware/manuals under /products/<sku>.
    "FS (FiberStore)": ["fs.com"],
    # Supermicro: supermicro.com firmware under /support/resources/.
    "Supermicro": ["supermicro.com"],
    # Versa Networks: versa-networks.com docs under /support/.
    "Versa Networks": ["versa-networks.com", "docs.versa-networks.com"],
    # Nokia: nokia.com (marketing) and infocenter.nokia.com (docs).
    "Nokia Networks": ["nokia.com", "infocenter.nokia.com"],
    # NVIDIA Mellanox: docs.nvidia.com/networking and nvidia.com/en-us/networking
    "NVIDIA (Mellanox)": ["nvidia.com", "docs.nvidia.com"],
    # Lantronix: lantronix.com firmware under /support/.
    "Lantronix": ["lantronix.com"],
}


# Case-insensitive lookup table — built once at import. The Excel sheet
# uses inconsistent capitalization ("Netgear" vs "NETGEAR", "Mikrotik" vs
# "MikroTik"), and alias keys above use whatever the curator typed. Without
# this normalization, "Netgear" silently failed to find the "NETGEAR"
# alias entry and queries went to the Excel domain only — which is the
# entire reason Netgear/ZyXEL/D-Link returned zero hits.
_VENDOR_DOMAIN_ALIASES_CI = {k.lower(): v for k, v in VENDOR_DOMAIN_ALIASES.items()}


def _resolve_domains(vendor_name, vendor_url, *, max_domains=3):
    """Returns the ordered list of domains to search for this vendor.
    Combines the curated alias list (if any) with the Excel-supplied URL
    so we never miss the configured domain even when aliases exist.

    `max_domains` caps the result to keep search cost bounded — searching
    every alias × every query × every backend explodes runtime past the
    spawn timeout. Three domains is the sweet spot: curated primary
    (e.g. modern docs.fortinet.com), curated fallback (fortinet.com),
    plus the Excel-listed entry as a safety net.

    Lookup is case-insensitive: 'Netgear', 'NETGEAR', 'netgear' all
    resolve to the same alias list. Vendors whose Excel name contains
    a parenthetical suffix (e.g. 'Phoenix Contact (incl. Hirschmann)')
    are also tried with the suffix stripped, so curator entries like
    'Phoenix Contact' still match."""
    aliases = _VENDOR_DOMAIN_ALIASES_CI.get((vendor_name or "").lower(), [])
    if not aliases and "(" in (vendor_name or ""):
        bare = vendor_name.split("(")[0].strip().lower()
        aliases = _VENDOR_DOMAIN_ALIASES_CI.get(bare, [])
    excel_domain = _root_domain(vendor_url) if vendor_url else None
    out = list(aliases)
    if excel_domain and excel_domain not in out:
        out.append(excel_domain)
    if not out and excel_domain:
        out = [excel_domain]
    return out[:max_domains]


_SEARCH_BACKENDS = ("bing", "google", "mullvad")
_SEARCH_TIMEOUT_SEC = 6


def _search_one(backend, query, max_results):
    # Fresh DDGS per thread — sharing one across threads breaks the Bing path.
    try:
        hits = DDGS().text(query, max_results=max_results, backend=backend)
    except Exception:
        return backend, []
    urls = []
    for h in hits or []:
        href = (h.get("href") or h.get("url") or "").strip()
        if href.startswith("http"):
            urls.append(href)
    return backend, urls


def _search_query(q, max_results=15):
    """Run an arbitrary query string against multiple backends in parallel;
    return the first non-empty result list. Replaces the old Bing/DDG-HTML
    scrapers that broke in 2026 (Bing went JS-rendered; DDG HTML serves an
    anti-bot block page). Used by both vendor-restricted and open-web search."""
    if not _HAS_DDGS:
        return []
    # No `with` block — its __exit__ blocks until ALL futures complete, killing
    # the speed win. We shutdown(wait=False) and let stragglers be GC'd.
    ex = ThreadPoolExecutor(max_workers=len(_SEARCH_BACKENDS))
    try:
        futures = [ex.submit(_search_one, b, q, max_results) for b in _SEARCH_BACKENDS]
        try:
            for fut in as_completed(futures, timeout=_SEARCH_TIMEOUT_SEC):
                try:
                    _backend, urls = fut.result()
                except Exception:
                    continue
                if urls:
                    return urls
        except (_FuturesTimeoutError, TimeoutError):
            # All backends slow this round; check what (if anything) finished.
            # Catches both classes — concurrent.futures.TimeoutError is
            # distinct from the built-in until Python 3.11.
            for fut in futures:
                if fut.done():
                    try:
                        _backend, urls = fut.result()
                        if urls:
                            return urls
                    except Exception:
                        pass
        return []
    finally:
        ex.shutdown(wait=False, cancel_futures=True)


def search_ddgs(domain, model, max_results=15):
    """Vendor-restricted search — `site:domain model`."""
    return _search_query(f"site:{domain} {model}", max_results)


def search_open_web(model, vendor_name="", max_results=15):
    """Open-web search — no site: filter. Used as fallback when the vendor's
    own site has no parseable spec page (eg modern Cisco /site/ pages, or
    SKUs documented only by third-party distributors / aggregators)."""
    queries = [
        f'"{model}" specifications',
        f'"{model}" product specifications',
        f'"{model}" datasheet',
        f"{model} specs",
    ]
    if vendor_name:
        queries.insert(0, f'"{vendor_name}" "{model}" specifications')
    pool = []
    seen = set()
    for q in queries:
        for u in _search_query(q, max_results):
            if u not in seen:
                seen.add(u)
                pool.append(u)
    return pool


_FORUM_SUBDOMAINS = ("community.", "forum.", "forums.", "answers.", "ask.")
_THREAD_PATH_HINTS = ("/td-p/", "/discussion", "/thread", "/viewprofile", "/t5/")
_NON_PRODUCT_PATHS = ("/support/", "/download/", "/downloads/", "/manual/",
                      "/manuals/", "/faq/", "/help/", "/eol/", "/end-of-life")


_REGION_SUFFIX_RE = re.compile(
    r"-(rm|us|eu|cn|jp|kr|ap|na|emea|in|uk|au|row|intl|global)$",
    re.I,
)


def _model_match_score(url, model_dashed):
    """How strongly does `url` reference `model_dashed`?
    Vendor URL conventions vary wildly:
      - Cisco:    cisco.com/.../c9300-48p.html             (lowercase, dashed)
      - MikroTik: mikrotik.com/product/crs518_16xs_2xq     (underscores, no -RM)
      - Aruba:    arubanetworks.com/.../jl355a/            (no dashes at all)
    So we compare against several flattened forms and return the strength of
    the match instead of a yes/no."""
    # Both URL and model: strip - and _ and lowercase, so all vendor flavors
    # collapse to the same comparable shape.
    u_flat = re.sub(r"[-_]", "", url.lower())
    m = (model_dashed or "").lower()
    if not m:
        return 0
    full_flat = m.replace("-", "")
    if full_flat and full_flat in u_flat:
        return 60
    # Try the model with a regional suffix stripped (CRS518-16XS-2XQ-RM ->
    # CRS518-16XS-2XQ). MikroTik, TP-Link, etc. routinely drop these in URLs.
    core = _REGION_SUFFIX_RE.sub("", m)
    core_flat = core.replace("-", "")
    if core_flat and core_flat != full_flat and core_flat in u_flat:
        return 50
    # Partial match: vendor-prefix + first number group (CRS518, C9300,
    # EX4400). Long enough to be unambiguous, short enough that vendors who
    # truncate the URL still match.
    parts = m.split("-")
    if len(parts) >= 2:
        partial = (parts[0] + parts[1]).replace(" ", "")
        if len(partial) >= 6 and partial in u_flat:
            return 25
    return 0


def _score_candidate(url, domain, flat_model, canonical_netloc=None):
    """flat_model here is the model in dashed form (eg 'CRS518-16XS-2XQ-RM');
    we re-flatten variants inside _model_match_score to handle vendor URL
    quirks."""
    u = url.lower()
    netloc = urlparse(u).netloc.lower()
    if domain not in netloc:
        return -1
    # Penalize sibling subdomains (eg meraki.cisco.com when vendor is
    # www.cisco.com) — those are different product lines that share the
    # parent domain but won't have specs for our SKU.
    if canonical_netloc:
        canon = canonical_netloc.lower()
        if canon.startswith("www."):
            canon = canon[4:]
        host = netloc[4:] if netloc.startswith("www.") else netloc
        if host != canon:
            s_subdomain_penalty = -20
        else:
            s_subdomain_penalty = 0
    else:
        s_subdomain_penalty = 0
    s = 0
    if any(bad in netloc for bad in _FORUM_SUBDOMAINS):
        s -= 100
    if any(bad in u for bad in _THREAD_PATH_HINTS):
        s -= 100
    if any(bad in u for bad in _NON_PRODUCT_PATHS):
        s -= 40
    # End-of-life / End-of-sale notices match patterns like
    # '...switches-eol.html' or '/eos/...' or '-end-of-life-'. These pages
    # mention the SKU (so they get a model-match bonus) but contain ZERO
    # specs — only retirement dates and replacement-product pointers.
    if re.search(r"[-_/](eol|eos|end[-_]?of[-_]?life|discontinued|archive)([-_./]|$)", u):
        s -= 80
    if "/products/" in u or "/product/" in u:
        s += 25
    if "/switches/" in u or "switch" in u:
        s += 15
    if "data-sheet" in u or "datasheet" in u:
        s += 25
    # Cisco publishes data sheets under /c/.../products/collateral/. Reward
    # this directly so a real datasheet beats an EOL/landing page even when
    # the latter has the SKU in its URL.
    if "/collateral/" in u:
        s += 30
    if "/networking/" in u:
        s += 10
    if "/series" in u or "-series" in u:
        s += 10

    # Penalize landing/category pages — these match /products/ + /switches
    # and would otherwise outscore a real SKU page if the SKU's URL doesn't
    # use those keywords. /products/group/, /products/category/, /shop/ etc.
    if re.search(r"/(group|category|categories|shop|listing|catalog)s?/", u):
        s -= 30

    # Strongest signal — does the URL actually NAME this SKU? We score a
    # full match (CRS518-16XS-2XQ-RM in URL) higher than a core match
    # (CRS518-16XS-2XQ, ie MikroTik dropping -RM in the slug) higher than
    # a vendor-prefix-only partial match (CRS518).
    s += _model_match_score(u, flat_model)

    # BeautifulSoup can't extract specs from PDFs; deprioritize but don't ban.
    if u.endswith(".pdf"):
        s -= 50
    s += s_subdomain_penalty
    return s


_OPEN_WEB_BAD_HOSTS = (
    "reddit.com", "youtube.com", "facebook.com", "twitter.com", "x.com",
    "linkedin.com", "pinterest.com", "instagram.com", "tiktok.com",
    "quora.com", "stackexchange.com", "stackoverflow.com",
    "medium.com", "substack.com",
)


def _score_open_web_candidate(url, model):
    """Looser cousin of `_score_candidate` — accepts any host, but rejects
    social/forum noise and rewards datasheet/distributor URLs that name
    the SKU."""
    u = url.lower()
    netloc = urlparse(u).netloc
    if any(bad in netloc for bad in _OPEN_WEB_BAD_HOSTS):
        return -1
    s = 0
    if any(bad in netloc for bad in _FORUM_SUBDOMAINS):
        s -= 100
    if any(bad in u for bad in _THREAD_PATH_HINTS):
        s -= 100
    if "/product/" in u or "/products/" in u:
        s += 25
    if "data-sheet" in u or "datasheet" in u or "specifications" in u or "/specs" in u:
        s += 30
    if u.endswith(".pdf"):
        s -= 50  # we don't parse PDFs in this script
    if re.search(r"[-_/](eol|eos|end[-_]?of[-_]?life|discontinued|archive)([-_./]|$)", u):
        s -= 80
    s += _model_match_score(u, model)
    return s


def _page_mentions_model(soup, model):
    """Cheap sanity check used for OPEN-WEB results — a third-party page that
    doesn't actually mention our SKU is going to extract specs for someone
    else's product. Title / headings / first ~5KB of body."""
    if not model:
        return True
    flat = re.sub(r"[^a-z0-9]", "", model.lower())
    if not flat:
        return True
    if soup.title:
        if flat in re.sub(r"[^a-z0-9]", "", soup.title.get_text().lower()):
            return True
    for h in soup.find_all(["h1", "h2", "h3"]):
        if flat in re.sub(r"[^a-z0-9]", "", h.get_text(" ", strip=True).lower()):
            return True
    body = soup.find("body")
    if body:
        head_text = body.get_text(" ", strip=True)[:5000].lower()
        if flat in re.sub(r"[^a-z0-9]", "", head_text):
            return True
    return False


def find_open_web_urls(model, vendor_name="", top_n=6):
    """Open-web fallback. Searches without `site:vendor.com`, scores results
    leniently (any host OK except social/forum), returns top_n ranked."""
    pool = search_open_web(model, vendor_name=vendor_name)
    if not pool:
        return []
    scored = [(_score_open_web_candidate(u, model), u) for u in pool]
    scored = [(sc, u) for sc, u in scored if sc >= 0]
    if not scored:
        return []
    scored.sort(key=lambda x: -x[0])
    return [u for _, u in scored[:top_n]]


def find_product_urls(vendor_url, model, top_n=6, *, vendor_name=""):
    """Return up to `top_n` candidate URLs ranked best-first.

    Searches every domain in VENDOR_DOMAIN_ALIASES for the vendor (plus
    the Excel-supplied URL). Some vendors publish spec/release content
    across multiple domains — Aruba is on arubanetworking.hpe.com AND
    arubanetworks.com AND support.hpe.com; Dell is on dell.com AND
    infohub.delltechnologies.com — and which one carries a given product
    is not always predictable. Searching only the Excel-listed domain
    means we miss valid product pages and return "Product page not
    found" for products that have very public spec sheets elsewhere.

    The chosen URL sometimes turns out to have no extractable specs —
    modern Cisco /site/ pages are JS-rendered and our static-HTML
    extractors return nothing. The caller iterates this list, trying
    each in turn, so we don't have to be right on the first guess.
    """
    domains = _resolve_domains(vendor_name, vendor_url)
    if not domains:
        return []
    canonical = urlparse(vendor_url).netloc.lower() if vendor_url else ""

    queries = [
        model,                       # bare query — still cheap, baseline coverage
        f'"{model}"',                # quoted — pushes search toward exact-match pages
        f"{model} data sheet",
        f"{model} specifications",
    ]
    pool = []
    seen = set()
    for domain in domains:
        for q in queries:
            for u in search_ddgs(domain, q):
                if u not in seen:
                    seen.add(u)
                    pool.append(u)

    if not pool:
        return []
    # Scoring still uses the primary domain so the canonical-host bonus
    # works as before; URLs from alias domains are accepted but don't get
    # the same affinity boost. That's fine — the open-web fallback handles
    # mismatched-domain cases too.
    primary = domains[0]
    scored = [(_score_candidate(u, primary, model, canonical), u) for u in pool]
    # Aliased domains: also accept URLs whose host is in the alias list,
    # even if their score against `primary` is borderline.
    alias_set = set(domains)
    boosted = []
    for sc, u in scored:
        host = urlparse(u).netloc.lower()
        if host.startswith("www."):
            host = host[4:]
        # If the URL is from any of our known vendor domains, give it a
        # small bump to compensate for not being the primary domain.
        if any(host == d or host.endswith("." + d) for d in alias_set):
            sc = sc + 5 if sc >= 0 else sc
        boosted.append((sc, u))
    boosted = [(sc, u) for sc, u in boosted if sc >= 0]
    if not boosted:
        return []
    boosted.sort(key=lambda x: -x[0])
    return [u for _, u in boosted[:top_n]]


def find_product_url(vendor_url, model):
    """Single-best candidate. Preserved for backward compatibility."""
    urls = find_product_urls(vendor_url, model, top_n=1)
    return urls[0] if urls else None


# ─────────────────────────────────────────────
# EXTRACT SPECIFICATIONS
# ─────────────────────────────────────────────
# A row whose KEY looks like a vendor part number (eg "C9300-NM-8M",
# "STACK-T1-50CM", "PWR-C1-350WAC-P", "LIC-C9300-24A-1Y") should be dropped
# when we're scraping a series-wide datasheet — those rows are entries in
# accessory/license/MTBF tables, not specs of the user's specific model.
# Pattern: starts with letters, contains a digit somewhere, may have dashes
# and a trailing '=' (Cisco "spare" suffix), and has no spaces.
_SKU_KEY_RE = re.compile(r"^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*=?$")


def _normalize_for_sku_check(key):
    """Strip footnote markers, trailing whitespace, and unify space/dash
    separators so the SKU regex can match real-world key strings.
    Vendor pages routinely append '*', '**', '†' to SKU rows that have
    footnotes, and Cisco occasionally writes 'STACK T3-3M' with a space
    where a dash belongs."""
    s = (key or "").strip()
    s = re.sub(r"[*†‡§¶]+\s*$", "", s).strip()
    s = re.sub(r"\s+", "-", s)
    return s


def _looks_like_any_sku(key):
    """True if `key` matches the shape of a vendor part number — regardless
    of which product. Used both to filter individual rows AND to detect
    'SKU-list tables' (every row is a different SKU)."""
    if not key:
        return False
    s = _normalize_for_sku_check(key).upper()
    if not s or len(s) < 5:
        return False
    if not _SKU_KEY_RE.match(s):
        return False
    if not (re.search(r"\d", s) and re.search(r"[A-Z]", s)):
        return False
    dash_count = s.count("-")
    if dash_count < 2 and len(s) < 7:
        return False
    return True


def _looks_like_other_sku(key, our_model_flat):
    """True if `key` looks like a vendor SKU that ISN'T ours."""
    if not _looks_like_any_sku(key):
        return False
    s = _normalize_for_sku_check(key).upper()
    flat_key = s.replace("-", "").rstrip("=")
    return flat_key != our_model_flat.upper()


def _is_sku_list_table(table):
    """A 'SKU-list table' is one whose first column is mostly vendor part
    numbers — eg an MTBF table or accessory price list on a series
    datasheet. Skip the whole table; even our own SKU's row in such a
    table is just an MTBF/price, not a real spec."""
    rows = table.find_all("tr")
    if len(rows) < 3:
        return False
    sku_rows = 0
    counted = 0
    for r in rows:
        cols = r.find_all(["td", "th"])
        if not cols:
            continue
        counted += 1
        if _looks_like_any_sku(cols[0].get_text(" ", strip=True)):
            sku_rows += 1
    return counted >= 3 and sku_rows >= max(2, counted * 0.5)


def _extract_from_comparison_table(table, our_model):
    """If `table` is a multi-column comparison table whose header row
    contains our SKU, return only the (label -> value) pairs from our SKU's
    column. Otherwise return {}."""
    rows = table.find_all("tr")
    if not rows:
        return {}

    flat_model = our_model.replace("-", "").lower()
    target_idx = None
    header_row = None
    # Walk the first few rows looking for one that names our SKU in a cell.
    # Many vendor comparison tables put model SKUs in the header row, others
    # in the second row (with a "Feature" or "Specification" label first).
    for r in rows[:4]:
        cells = r.find_all(["th", "td"])
        if len(cells) < 3:
            continue
        for i, c in enumerate(cells):
            cell_flat = c.get_text(" ", strip=True).lower().replace("-", "").replace(" ", "")
            if flat_model and flat_model in cell_flat:
                target_idx = i
                header_row = r
                break
        if target_idx is not None:
            break

    if target_idx is None or header_row is None:
        return {}

    out = {}
    started = False
    for r in rows:
        if r is header_row:
            started = True
            continue
        if not started:
            continue
        cols = r.find_all(["td", "th"])
        if len(cols) <= target_idx:
            continue
        k = cols[0].get_text(" ", strip=True)
        v = cols[target_idx].get_text(" ", strip=True)
        if not k or not v or k.lower() == v.lower():
            continue
        # Skip header-bleed rows where col 0 is itself a SKU
        if _SKU_KEY_RE.match(k.strip().upper()):
            continue
        if _is_header_row(k, v):
            continue
        out.setdefault(k, v)
    return out


def _row_in_skipped_table(elem, skipped_table_ids):
    cur = elem
    while cur is not None:
        if cur.name == "table" and id(cur) in skipped_table_ids:
            return True
        cur = cur.parent
    return False


_HEADER_WORDS = {
    "description", "specification","product specifications" "specifications", "value", "values",
    "notes", "note", "details", "detail", "feature", "features",
    "model", "type", "name", "category", "metric", "measurement",
}


# Sub-headings under a "Specifications" section that mark NON-spec boilerplate.
# When iterating from spec_heading we stop on these — otherwise the iteration
# walks past the real specs into ordering/sustainability/EOL sections and the
# row extractor hoovers up suffix codes ('-NA', '-EU') and CSR contact info.
_NON_SPEC_SECTION_RE = re.compile(
    r"\b(ordering|order(?:s|ing)?|sku\b|country|region|sustainability|"
    r"warranty|licensing|environmental|takeback|recycle|recycling|compliance|"
    r"\bcsr\b|legal|shipping|return|terms|service\s+contract|cisco\s+capital|"
    r"end[-\s]of[-\s]life|software\s+download|manuals?|safety|rohs)\b",
    re.I,
)


def _is_non_spec_subheading(elem):
    if not elem or not getattr(elem, "name", None):
        return False
    if elem.name not in ("h2", "h3", "h4", "h5"):
        return False
    text = elem.get_text(" ", strip=True)
    if not text or len(text) > 80:
        return False
    return bool(_NON_SPEC_SECTION_RE.search(text))


def _looks_like_country_suffix(key):
    """'-NA', '-BR', '-EU', '-UK' — country suffix codes from ordering tables."""
    if not key:
        return False
    return bool(re.match(r"^-[A-Z]{2,4}$", key.strip()))


_SUSTAIN_ROW_RE = re.compile(
    r"\b(sustainability|takeback|reuse\s+program|weee|electronic\s+waste|"
    r"\bcsr\b|csr_inquiries|cisco\s+takeback|recycle)\b",
    re.I,
)


def _looks_like_sustainability_row(k, v):
    if not k:
        return False
    return bool(_SUSTAIN_ROW_RE.search(f"{k} {v or ''}"))


def _kv_from_li(li):
    """Some vendor pages (MikroTik's Tailwind product pages, modern
    marketing-template sites) lay out spec rows as <li> with two inline
    children — a label and a value — instead of using a <table> or a
    'key: value' string. Detect that pattern and return (key, value)."""
    if li.find("li"):    # nested list: not a leaf row
        return None
    children = [c for c in li.children if getattr(c, "name", None)]
    if len(children) != 2:
        return None
    if not all(c.name in ("span", "div", "p", "strong", "b", "label", "em", "i") for c in children):
        return None
    k = children[0].get_text(" ", strip=True)
    v = children[1].get_text(" ", strip=True)
    if not k or not v or k.lower() == v.lower():
        return None
    if len(k) > 80 or len(v) > 400:
        return None
    # Filter nav noise: both halves must contain at least one alphanumeric,
    # and the label must be a real word (>= 3 chars).
    if not re.search(r"[A-Za-z0-9]", k) or not re.search(r"[A-Za-z0-9]", v):
        return None
    if len(k.strip()) < 3:
        return None
    return (k, v)


def _kv_pairs_from_dl(dl):
    """Definition lists: <dt>key</dt><dd>value</dd>. Some vendors (HPE
    Aruba, older sites) use these instead of tables."""
    out = []
    dts = dl.find_all("dt", recursive=False) or dl.find_all("dt")
    for dt in dts:
        dd = dt.find_next_sibling("dd")
        if dd is None:
            continue
        k = dt.get_text(" ", strip=True)
        v = dd.get_text(" ", strip=True)
        if k and v and k.lower() != v.lower() and len(k) <= 80 and len(v) <= 400:
            out.append((k, v))
    return out


def _is_header_row(k, v):
    """Drop rows where BOTH cells are generic header words ('Model' /
    'Description', 'Description' / 'Specification'). These are table-header
    bleeds, not real specs."""
    if not k or not v:
        return False
    kl = k.strip().lower()
    vl = v.strip().lower()
    if kl in _HEADER_WORDS and vl in _HEADER_WORDS:
        return True
    if re.match(r"^measured\s", vl):
        return True
    return False


_SPEC_HEADING_RE = re.compile(
    r"\b(specifications?|specs?|tech(?:nical)?\s+specs?|"
    r"product\s+specifications?|technical\s+specifications?|"
    r"hardware\s+specifications?|key\s+features?|"
    r"features?\s+(?:and|&)\s+specifications?|"
    r"product\s+details?|technical\s+details?)\b",
    re.I,
)
_PRIMARY_SPEC_HEADING_RE = re.compile(
    r"^\s*(product\s+|technical\s+|hardware\s+)?(specifications?|specs?|"
    r"product\s+details?|technical\s+details?|key\s+features?|"
    r"features?\s+(?:and|&)\s+specifications?)\s*$",
    re.I,
)


def extract_specs(soup, our_model=""):
    specs = {}
    our_model_flat = our_model.replace("-", "")

    # Prefer EXACT headings ('Specifications', 'Product Specifications',
    # 'Features and Specifications', etc.) over compound/sub-section names.
    # Skip non-spec hits like 'Country specifications' or 'Sustainability'.
    candidates = []
    for h in soup.find_all(["h1", "h2", "h3", "h4"]):
        text = h.get_text(" ", strip=True)
        if not _SPEC_HEADING_RE.search(text):
            continue
        if _NON_SPEC_SECTION_RE.search(text):
            continue
        candidates.append(h)
    spec_heading = None
    for h in candidates:
        if _PRIMARY_SPEC_HEADING_RE.match(h.get_text(" ", strip=True).strip()):
            spec_heading = h
            break
    if spec_heading is None and candidates:
        spec_heading = candidates[0]

    if spec_heading is None:
        return specs

    # Collect everything in the section. Stop at h1/h2 (next major section)
    # OR at h3/h4 sub-headings that mark non-spec boilerplate (Ordering,
    # Sustainability, Country/Region codes, EOL, RoHS, etc.).
    stop_levels = {"h1", "h2"}
    section = []
    for elem in spec_heading.find_all_next():
        if elem.name in stop_levels and elem is not spec_heading:
            break
        if _is_non_spec_subheading(elem) and elem is not spec_heading:
            break
        section.append(elem)

    # Classify each <table> in the section.
    #   - Comparison tables (header names our SKU): extract our column only.
    #   - SKU-list tables (col-0 is mostly part numbers): skip wholesale.
    #   - Regular tables: process row-by-row below.
    comparison_results = {}
    skipped_tables = set()
    for el in section:
        if el.name != "table":
            continue
        if our_model:
            ours = _extract_from_comparison_table(el, our_model)
            if ours:
                for k, v in ours.items():
                    comparison_results.setdefault(k, v)
                skipped_tables.add(id(el))   # don't double-count its rows
                continue
        if _is_sku_list_table(el):
            skipped_tables.add(id(el))

    # When a comparison table gave us our SKU's column, that IS the answer —
    # don't pollute with rows from accessory/MTBF tables on the same page.
    if comparison_results:
        return comparison_results

    # Pass 2: row-by-row, but skip rows that live inside a SKU-list table
    # AND drop any individual rows whose key is itself a different SKU.
    for elem in section:
        if elem.name == "tr":
            if _row_in_skipped_table(elem, skipped_tables):
                continue
            cols = elem.find_all(["td", "th"])
            if len(cols) == 2:
                k = cols[0].get_text(" ", strip=True)
                v = cols[1].get_text(" ", strip=True)
                if k and v and k.lower() != v.lower():
                    if our_model and _looks_like_other_sku(k, our_model_flat):
                        continue
                    if _is_header_row(k, v):
                        continue
                    if _looks_like_country_suffix(k):
                        continue
                    if _looks_like_sustainability_row(k, v):
                        continue
                    specs.setdefault(k, v)
        elif elem.name == "li":
            # Try the two-element-child format first (MikroTik etc.)
            pair = _kv_from_li(elem)
            if pair:
                k, v = pair
                if our_model and _looks_like_other_sku(k, our_model_flat):
                    continue
                if _looks_like_country_suffix(k):
                    continue
                if _looks_like_sustainability_row(k, v):
                    continue
                specs.setdefault(k, v)
                continue
            # Fall back to "key: value" text format
            text = elem.get_text(" ", strip=True)
            if ":" in text and 4 < len(text) < 300:
                k, _, v = text.partition(":")
                k, v = k.strip(), v.strip()
                if our_model and _looks_like_other_sku(k, our_model_flat):
                    continue
                if _looks_like_country_suffix(k):
                    continue
                if _looks_like_sustainability_row(k, v):
                    continue
                specs.setdefault(k, v)
        elif elem.name == "dl":
            # Definition list: <dt>label</dt><dd>value</dd> (HPE Aruba etc.)
            for k, v in _kv_pairs_from_dl(elem):
                if our_model and _looks_like_other_sku(k, our_model_flat):
                    continue
                if _looks_like_country_suffix(k):
                    continue
                if _looks_like_sustainability_row(k, v):
                    continue
                specs.setdefault(k, v)

    return specs


def fallback_specs(soup, our_model=""):
    """Whole-page fallback when there's no 'Specifications' heading on the
    page (eg Cisco series datasheets, which scatter spec-like info across
    sections without a single heading). Same filters as extract_specs +
    comparison-table extraction across all tables."""
    our_model_flat = our_model.replace("-", "")

    # First: check every table on the page for a comparison table whose
    # header names our SKU. If found, that's the single best answer.
    if our_model:
        comparison = {}
        for table in soup.find_all("table"):
            ours = _extract_from_comparison_table(table, our_model)
            if ours:
                for k, v in ours.items():
                    comparison.setdefault(k, v)
        if comparison:
            return comparison

    skipped_tables = set()
    for table in soup.find_all("table"):
        if _is_sku_list_table(table):
            skipped_tables.add(id(table))

    specs = {}
    for row in soup.select("table tr"):
        if _row_in_skipped_table(row, skipped_tables):
            continue
        cols = row.find_all(["td", "th"])
        if len(cols) == 2:
            k = cols[0].get_text(" ", strip=True)
            v = cols[1].get_text(" ", strip=True)
            if k and v and k.lower() != v.lower():
                if our_model and _looks_like_other_sku(k, our_model_flat):
                    continue
                if _is_header_row(k, v):
                    continue
                if _looks_like_country_suffix(k):
                    continue
                if _looks_like_sustainability_row(k, v):
                    continue
                specs.setdefault(k, v)
    return specs



# ─────────────────────────────────────────────
# Programmatic API — used by the JSON CLI mode
# and the Express backend (via subprocess).
# ─────────────────────────────────────────────
def _pick_vendor_strict(query, vendors):
    """Like pick_vendor() but never prompts. Returns (name, url) or None."""
    q = _slug(query)
    if not q:
        return None
    for name, url in vendors:
        if _slug(name) == q:
            return name, url
    matches = [(n, u) for n, u in vendors if q in _slug(n)]
    if not matches:
        matches = [(n, u) for n, u in vendors if q in _slug(urlparse(u).netloc)]
    if not matches:
        return None
    return matches[0]


_CACHE_DIR = os.path.join(_PROJECT_ROOT, "outputs", "spec_cache")
_CACHE_TTL_SEC = 7 * 24 * 60 * 60


def _cache_key(vendor_query, model_query):
    raw = f"{vendor_query.strip().lower()}|{model_query.strip().lower()}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


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
        with open(os.path.join(_CACHE_DIR, f"{key}.json"), "w", encoding="utf-8") as f:
            json.dump(payload, f)
    except Exception:
        pass


def _try_extract(url, model, validate_model=False):
    """Fetch one URL and try to extract specs. Returns (specs, soup) or ({}, None).
    With `validate_model=True`, page must mention the SKU in title/heading/body
    or specs are discarded — used for open-web third-party pages where a URL
    might match by keyword but the page is actually about a different product."""
    try:
        r = SESSION.get(url, timeout=15)
        soup = BeautifulSoup(r.text, "html.parser")
    except Exception:
        return {}, None
    if validate_model and not _page_mentions_model(soup, model):
        return {}, None
    specs = extract_specs(soup, our_model=model) or fallback_specs(soup, our_model=model)
    return specs, soup


def fetch_specs(vendor_query, model_query, excel_path=DEFAULT_EXCEL):
    """Returns a dict the CLI/JSON mode and the HTTP layer share."""
    cache_key = _cache_key(vendor_query, model_query)
    cached = _cache_load(cache_key)
    if cached is not None:
        cached["_cached"] = True
        return cached

    vendors = load_vendors(excel_path)
    if not vendors:
        return {"ok": False, "error": "No vendors loaded from Excel"}

    chosen = _pick_vendor_strict(vendor_query, vendors)
    if not chosen:
        return {"ok": False, "error": f"Vendor not found: {vendor_query}"}
    vendor_name, vendor_url = chosen

    model = normalize_model(model_query)
    model = expand_partial_model(model, vendor_name)
    candidates = find_product_urls(vendor_url, model, vendor_name=vendor_name)
    if not candidates:
        return {
            "ok": False,
            "error": "Product page not found",
            "vendor": vendor_name,
            "vendorUrl": vendor_url,
            "model": model,
        }

    # Walk the ranked vendor-domain list — first URL with extractable specs wins.
    specs = {}
    used_url = None
    for url in candidates:
        s, _ = _try_extract(url, model)
        if s:
            specs = s
            used_url = url
            break

    # Open-web fallback: vendor's own pages had nothing parseable, so look at
    # third-party distributors / aggregators (eg fgtechstore.com, router-switch.com).
    open_web_tried = []
    if not specs:
        open_web_tried = find_open_web_urls(model, vendor_name=vendor_name)
        for url in open_web_tried:
            s, _ = _try_extract(url, model, validate_model=True)
            if s:
                specs = s
                used_url = url
                break

    if not specs:
        return {
            "ok": False,
            "error": "No specifications found on any candidate URL",
            "vendor": vendor_name,
            "vendorUrl": vendor_url,
            "model": model,
            "productUrl": candidates[0],
            "triedUrls": candidates + open_web_tried,
        }

    payload = {
        "ok": True,
        "vendor": vendor_name,
        "vendorUrl": vendor_url,
        "model": model,
        "productUrl": used_url,
        "specs": specs,
    }
    _cache_save(cache_key, payload)
    return payload


# ─────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--vendor", help="Vendor name (substring match allowed)")
    parser.add_argument("--model", help="Model name")
    parser.add_argument("--excel", default=DEFAULT_EXCEL, help="Path to vendor Excel")
    parser.add_argument("--json", action="store_true",
                        help="Emit a single JSON line on stdout (for backend use)")
    parser.add_argument("--list-vendors", action="store_true",
                        help="Print vendor list as JSON and exit")
    args = parser.parse_args()

    if args.list_vendors:
        try:
            vendors = load_vendors(args.excel)
        except FileNotFoundError:
            print(json.dumps({"ok": False, "error": f"Excel not found: {args.excel}"}))
            sys.exit(1)
        out = [{"name": n, "url": u} for n, u in vendors]
        print(json.dumps({"ok": True, "vendors": out}))
        return

    if args.json:
        if not args.vendor or not args.model:
            print(json.dumps({"ok": False, "error": "--vendor and --model are required with --json"}))
            sys.exit(1)
        try:
            result = fetch_specs(args.vendor, args.model, args.excel)
        except FileNotFoundError:
            result = {"ok": False, "error": f"Excel not found: {args.excel}"}
        except Exception as e:
            result = {"ok": False, "error": f"unexpected: {e}"}
        print(json.dumps(result))
        sys.exit(0 if result.get("ok") else 2)

    # ── Interactive (original) path ──────────────────────────
    try:
        vendors = load_vendors(args.excel)
    except FileNotFoundError:
        print(f"Excel not found: {args.excel}")
        return
    if not vendors:
        print("No vendors loaded from Excel")
        return

    raw_vendor = args.vendor or input("Enter vendor: ")
    chosen = pick_vendor(raw_vendor, vendors)
    if not chosen:
        print(f"Vendor not found: {raw_vendor}")
        return
    vendor_name, vendor_url = chosen
    print(f"Vendor: {vendor_name} ({vendor_url})")

    raw_model = args.model or input("Enter model: ")
    model = normalize_model(raw_model)
    model = expand_partial_model(model, vendor_name)
    print(f"Model: {model}")
    print("Searching product page...")

    candidates = find_product_urls(vendor_url, model)
    if not candidates:
        print("Product page not found")
        return

    # Walk the ranked list — many vendor pages exist for a given SKU
    # (per-SKU page, series datasheet, EOL notice, marketing landing).
    # The top hit isn't always the one with extractable specs (eg modern
    # Cisco /site/ URLs are JS-rendered), so try each in order until one
    # yields real specs.
    specs = {}
    used_url = None
    for i, url in enumerate(candidates, 1):
        marker = "Found" if i == 1 else f"Trying #{i}"
        print(f"{marker}: {url}")
        s, _ = _try_extract(url, model)
        if s:
            specs = s
            used_url = url
            break

    # Open-web fallback: nothing parseable on the vendor's own site, so
    # look at third-party distributors / aggregators that often republish
    # the same datasheet info (fgtechstore, router-switch, fs.com, cdw, etc.).
    if not specs:
        print("Vendor site exhausted — searching the open web...")
        open_web = find_open_web_urls(model, vendor_name=vendor_name)
        for i, url in enumerate(open_web, 1):
            print(f"Web #{i}: {url}")
            s, _ = _try_extract(url, model, validate_model=True)
            if s:
                specs = s
                used_url = url
                break

    if not specs:
        print("No specifications found on any candidate URL")
        return

    if used_url and used_url != candidates[0]:
        print(f"\nUsed: {used_url}")
    print("\nSpecifications:\n")
    for k, v in specs.items():
        if len(v) > 150:
            v = v[:147] + "..."
        print(f"{k:<30}: {v}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Firmware version + known-bug checker for network gear.

Inputs:  vendor, model, current_version
Outputs: latest version detected on the vendor's site, any release-notes /
         changelog snippets we could scrape, and CVEs from the NIST NVD API
         that mention the product (and optionally the current version).

Why hybrid?
  - Spec tables are fairly consistent across vendor product pages.
  - Release-notes / known-bug pages are NOT — every vendor has its own format
    (Cisco Bug Search needs login for many entries, Juniper has PRs, Aruba
    publishes PDFs, etc). So we use:
      1. NIST NVD's free public API for CVE data (high signal, structured)
      2. A best-effort site-search + scrape for the changelog text
"""

import os
import re
import sys
import json
import argparse
import urllib.parse
import urllib.request
from urllib.parse import urlparse, urljoin
from concurrent.futures import ThreadPoolExecutor, as_completed, TimeoutError as _FutTimeout
from bs4 import BeautifulSoup

from pipeline.all_vendor import (
    SESSION,
    DEFAULT_EXCEL,
    load_vendors,
    _pick_vendor_strict,
    normalize_model,
    _root_domain,
    _resolve_domains,
)


def _light_normalize_model(raw):
    """Like all_vendor.normalize_model but does NOT insert a dash between
    the leading letters and digits. Cisco's part numbers are written without
    that dash on cisco.com and in NVD (`C93180YC-EX`, not `C-93180YC-EX`),
    so the original normalizer hurts more than it helps for firmware lookup."""
    s = (raw or "").strip().upper()
    s = s.replace("–", "-").replace("—", "-")
    s = re.sub(r"[\s_]+", "", s)
    s = re.sub(r"-+", "-", s).strip("-")
    return s

try:
    from ddgs import DDGS
except ImportError:
    DDGS = None


NVD_API = "https://services.nvd.nist.gov/rest/json/cves/2.0"
NVD_TIMEOUT = 25
PAGE_TIMEOUT = 15

# Real network-OS version formats only — no JS bundle hashes, no IPs.
# Whitelisted shapes:
#   - Huawei VRP:        V200R022, V200R023C00
#   - Standard 3+ parts: 17.15.1, 4.32.1F, 10.13.1010, 5.5.4-2.1
#   - Juniper:           22.4R3, 22.4R3-S2
#   - Cisco NX-OS:       9.3(5), 9.3(7)I7(7), 10.2(3)F
VERSION_RE = re.compile(
    r"("
    r"\bV\d{2,4}R\d{1,4}(?:C\d{1,4})?\b"
    r"|"
    r"\b\d{1,4}(?:\.\d{1,4}){2,4}(?:[A-Za-z][A-Za-z0-9]{0,5})?(?:-[A-Za-z0-9]{1,8})?\b"
    r"|"
    r"\b\d{1,3}\.\d{1,3}[A-Z]\d{1,3}(?:-[A-Z]\d{1,3})?\b"
    r"|"
    r"\b\d{1,3}\.\d{1,3}\(\d{1,3}[A-Za-z]?\)(?:[A-Z]\d{1,3}(?:\(\d{1,3}\))?)?"
    r")"
)
# When prefixed with a keyword we trust the match a bit more — used to
# pull the version out of a heading like "Release Notes for 17.15.1".
LABELLED_VERSION_RE = re.compile(
    r"(?:version|release|firmware|software|train|v)\s*[:\.]?\s*"
    r"(V?\d+\.\d+(?:\.\d+){0,3}(?:[A-Za-z][A-Za-z0-9\-]{0,12})?)",
    re.I,
)


# ─────────────────────────────────────────────
# Search helpers
# ─────────────────────────────────────────────
_SEARCH_BACKENDS = ("bing", "google", "mullvad")
_SEARCH_TIMEOUT_SEC = 6


def _ddgs_text_one(backend, query, max_results):
    """One backend's worth of hits. Returns list of hit dicts (or [])."""
    try:
        hits = DDGS().text(query, max_results=max_results, backend=backend)
    except Exception:
        return []
    return list(hits or [])


def _ddgs_query(query, max_results=15):
    """Fan out across multiple DDGS backends in parallel; return whichever
    backend yields hits first. Mirrors all_vendor.search_ddgs but keeps the
    full hit dict (title/body) so callers can verify model match."""
    if DDGS is None:
        return []
    ex = ThreadPoolExecutor(max_workers=len(_SEARCH_BACKENDS))
    try:
        futures = [ex.submit(_ddgs_text_one, b, query, max_results)
                   for b in _SEARCH_BACKENDS]
        try:
            for fut in as_completed(futures, timeout=_SEARCH_TIMEOUT_SEC):
                try:
                    hits = fut.result()
                except Exception:
                    continue
                if hits:
                    return hits
        except _FutTimeout:
            for fut in futures:
                if fut.done():
                    try:
                        hits = fut.result()
                        if hits:
                            return hits
                    except Exception:
                        pass
        return []
    finally:
        ex.shutdown(wait=False, cancel_futures=True)


# Build a query/keyword set broad enough to land on the release-notes,
# firmware-download, security-advisory, or version-history page that vendors
# variously use. A vendor only needs to match one of these for us to find
# something useful.
# Reduced from 10 → 5 suffixes per domain. The 10-suffix sweep was sending
# 2 domains × 10 suffixes × 3 backends = 60 search calls per vendor lookup,
# which tripped DDGS rate limits and turned legitimate vendors (Netgear,
# Allied Telesis, ZyXEL) into 60-second timeouts even though their pages
# exist. The 5 suffixes below cover the four common shapes vendors actually
# use ("Release Notes", "Firmware Download", "Changelog", "Version History",
# "Security Advisory") — anything else was pure tail.
_RN_QUERY_SUFFIXES = (
    "release notes",
    "firmware download",
    "changelog",
    "version history",
    "security advisory",
)

_RN_URL_KEYWORDS = (
    # release-notes shapes
    "release-note", "release_note", "releasenotes", "release-notes",
    "release", "changelog", "change-log", "what-s-new", "whats-new",
    # firmware/software shapes
    "firmware", "software-download", "software", "softwarelist",
    "downloads", "download",
    # security/advisory shapes
    "advisor", "advisories", "bulletin", "security",
    # history/notes shapes
    "version-history", "history", "patches", "patch-notes", "kbs",
    "support-bulletin", "version", "notes",
)


_LOGINWALL_HOSTS = (
    "supportportal.juniper.net",
    "casecentral.cisco.com", "id.cisco.com",
    "fndn.fortinet.net",
    "support.symantec.com",
    "myportal.al-enterprise.com",
    "supportcommunity.adtran.com",
)
_LOGINWALL_PATHS = (
    "/bugsearch", "/bst/", "/casemanagement", "/sign-in", "/signin",
    "/login", "/auth/", "/hpesc/public/api", "/myhpe", "/hpesupport/",
    "/portal/community/", "/cdrr/",
    # support.juniper.net/support/downloads/ requires login; other paths
    # under support.juniper.net (like /tickets/) are public.
    "/support/downloads/",
    # Fortinet's support portal is partially walled — /document/ is free,
    # /downloads/ and /products/ require a contract.
    "/support/downloads",
)


def _is_loginwall_or_eol(url):
    """Hard reject: URLs we KNOW won't yield versions.
       - login-walled portals (Juniper supportportal, Cisco bugsearch, etc.)
       - end-of-life / end-of-sale notices
       - HPE doc-display SPA endpoints (JS-rendered, no static HTML)
    """
    if not url:
        return False
    u = url.lower()
    netloc = urlparse(u).netloc
    if any(h in netloc for h in _LOGINWALL_HOSTS):
        return True
    if any(p in u for p in _LOGINWALL_PATHS):
        return True
    if re.search(r"[-_/](eol|eos|end[-_]?of[-_]?life|end[-_]?of[-_]?sale|"
                 r"discontinued|advisories?-notices?)([-_./]|$)", u):
        return True
    if "/docdisplay" in u and "hpe.com" in netloc:
        return True
    return False


def _open_web_release_notes(model, vendor_name="", vendor_url=""):
    """Open-web fallback when the vendor's own domain returns nothing.
    Some vendors (TP-Link business switches, Allied Telesis, Buffalo,
    smaller industrial brands) have poor search engine indexing of
    their support pages — a `site:vendor.com model release notes` query
    returns zero hits even though their downloads page exists.

    Two-pass strategy:
      Pass 1 — vendor-domain only. Open-web search may surface vendor.com
        hits that the vendor-restricted `site:` query missed (search index
        timing, CDN host quirks, etc.). Strongly preferred — this is what
        we actually want.
      Pass 2 — third-party authoritative hosts. Only run if Pass 1 is empty.
        Accept distributor/datasheet sites (router-switch.com, fs.com,
        cdw.com) but reject classified-ad / used-gear sites that pollute
        the search results (2dehands.be, manuals.co.uk, driverguide.com,
        fmv.se etc.) which were appearing as "release notes" hits despite
        having no version content at all.
    """
    if DDGS is None or not model:
        return None
    queries = []
    if vendor_name:
        queries.append(f'"{vendor_name}" "{model}" release notes')
        queries.append(f'"{vendor_name}" "{model}" firmware')
        queries.append(f'"{vendor_name}" "{model}" software download')
    queries.append(f'"{model}" release notes')
    queries.append(f'"{model}" firmware download')

    # Resolve vendor domains so we can recognize hits on the same brand
    # served from a different host than the Excel one (HPE Aruba, Cisco
    # /td/docs/ vs /support/).
    try:
        from pipeline.all_vendor import _resolve_domains as _resolve
        vendor_domains = set(_resolve(vendor_name, vendor_url) if vendor_name else [])
    except Exception:
        vendor_domains = set()

    # Authoritative redistributors that legitimately republish vendor
    # release-notes content. These are NOT a substitute for the vendor's
    # own page but better than reseller/classified-ad noise.
    _GOOD_THIRDPARTY = (
        "router-switch.com", "fs.com", "cdw.com", "newegg.com",
        "tigerdirect.com", "techbuy.com.au", "anixter.com",
    )
    _BAD_THIRDPARTY = (
        "2dehands.be", "marktplaats.nl", "ebay.", "amazon.",
        "manuals.co.uk", "driverguide.com", "manualslib.com",
        "manualsdir.com", "fmv.se", "getsetup.io",
        "alibaba.com", "aliexpress.com", "made-in-china.com",
    )

    model_low = model.lower()
    model_flat = model_low.replace("-", "")

    def score_hit(href, prefer_vendor):
        low = href.lower()
        netloc = urlparse(low).netloc
        host = netloc[4:] if netloc.startswith("www.") else netloc
        if any(b in netloc for b in _BAD_THIRDPARTY):
            return -1
        if any(s in netloc for s in ("reddit.com", "youtube.com",
                                     "facebook.com", "twitter.com",
                                     "x.com", "linkedin.com",
                                     "pinterest.com", "instagram.com",
                                     "tiktok.com")):
            return -1
        if any(s in netloc for s in ("community.", "forum.", "forums.",
                                     "answers.", "ask.")):
            return -1
        is_vendor = any(host == d or host.endswith("." + d)
                        for d in vendor_domains)
        if prefer_vendor and not is_vendor:
            return -1
        is_good_third = any(g in netloc for g in _GOOD_THIRDPARTY)
        if not prefer_vendor and not is_good_third:
            return -1
        kw = any(k in low for k in _RN_URL_KEYWORDS)
        mm = (model_low in low) or (model_flat in low.replace("-", ""))
        score = 0
        if kw and mm:        score = 80
        elif mm:             score = 50
        elif kw:             score = 30
        else:
            return -1
        if is_vendor:
            score += 30
        if low.endswith(".pdf"):
            score -= 20
        return score

    def search(prefer_vendor):
        seen = set()
        best_score = -1
        best_url = None
        for q in queries:
            for h in _ddgs_query(q, max_results=10):
                href = (h.get("href") or h.get("url") or "").strip()
                if not href.startswith("http") or href in seen:
                    continue
                seen.add(href)
                if _is_loginwall_or_eol(href):
                    continue
                s = score_hit(href, prefer_vendor)
                if s > best_score:
                    best_score = s
                    best_url = href
        return best_url if best_score > 30 else None

    return search(prefer_vendor=True) or search(prefer_vendor=False)


def find_release_notes_url(domain, model, *, vendor_name=""):
    """Find a release-notes / changelog / firmware-download / security-advisory
    page for `model`. Searches every domain associated with this vendor
    (the Excel-listed one + any aliases curated in
    VENDOR_DOMAIN_ALIASES). Returns a URL or None.

    Aliasing matters: HPE Aruba publishes AOS-CX release notes on
    `arubanetworking.hpe.com/techdocs/...`, not on `arubanetworks.com`,
    so a vendor-restricted search of just the Excel-listed domain misses
    them entirely and you get "Couldn't reach vendor" even though the
    page very much exists."""
    # Tokens we'll use to verify the result actually pertains to the model.
    # Strip dashes so "C93180YC-EX" matches both "c93180yc-ex" and
    # "c93180ycex" in URLs/titles.
    model_low_dashed = model.lower()
    model_low_flat = model_low_dashed.replace("-", "")

    def mentions_model(haystack):
        if not haystack:
            return False
        h = haystack.lower()
        return model_low_dashed in h or model_low_flat in h.replace("-", "")

    # Build the domain list: curated aliases first, then the Excel-listed
    # domain. Pass through _resolve_domains so the alias map is the
    # single source of truth.
    domains_to_search = _resolve_domains(vendor_name, f"https://{domain}") if vendor_name else [domain]

    # Vendor pages don't always mention the model in URL/title — sometimes only
    # in the body, or only on the firmware-list landing page. We rank candidates
    # so a strong match (URL keyword + model in URL/title) wins, and accept
    # weaker fallbacks if nothing strong shows up.
    best_score = -1
    best_url = None

    for d in domains_to_search:
     for suffix in _RN_QUERY_SUFFIXES:
        q = f"site:{d} {model} {suffix}"
        for h in _ddgs_query(q):
            href = (h.get("href") or h.get("url") or "").strip()
            title = (h.get("title") or "").strip()
            body = (h.get("body") or h.get("snippet") or "").strip()
            if not href.startswith("http"):
                continue
            host = urlparse(href).netloc.lower()
            if not any(host == da or host.endswith("." + da) for da in domains_to_search):
                continue

            low = href.lower()
            kw_url = any(k in low for k in _RN_URL_KEYWORDS)
            kw_title = any(k in title.lower() for k in _RN_URL_KEYWORDS)
            mm_url = mentions_model(low)
            mm_title = mentions_model(title)
            mm_body = mentions_model(body)

            # Score: stronger evidence -> higher.
            # Body-only model matches (snippet text) are downgraded heavily —
            # they trigger false positives on cross-product release-notes pages.
            # Searching for "FortiGate-100F" was returning
            # docs.fortinet.com/document/fortimanager/6.4.10/release-notes
            # (a FortiManager RN page that mentions FortiGate-100F in the
            # body but is not what we want; latest_version then comes back
            # as 6.4.10 instead of the FortiOS 7.x our model actually runs).
            score = 0
            if kw_url and mm_url:        score = 100   # ideal
            elif kw_url and mm_title:    score = 80
            elif kw_url and mm_body:     score = 35    # body-only is weak
            elif kw_title and mm_url:    score = 55
            elif kw_title and mm_title:  score = 50
            elif kw_title and mm_body:   score = 25    # body-only is weak
            elif kw_url:                 score = 20    # rn page, model not confirmed
            else:
                continue

            # Heavily penalize community/forum content — these surface often
            # in firmware searches because forum threads include both the
            # model and a version, but they're user discussions, not
            # authoritative release notes. We use a penalty large enough that
            # a forum thread loses to even a weak non-forum match.
            netloc = urlparse(low).netloc
            if any(sd in netloc for sd in ("community.", "forum.", "forums.",
                                           "answers.", "ask.")):
                score -= 100
            # Forum-thread URL paths used by Lithium/Khoros/Discourse boards
            # ("/t5/...", "/t/...", "/td-p/...", "/discussion/", "/thread/").
            if re.search(r"/(t5|t|td-p|discussion|thread)s?/", low):
                score -= 80
            # Prefer non-PDF (we can't extract versions from PDFs reliably).
            if low.endswith(".pdf"):
                score -= 20
            # End-of-life / end-of-sale notices — these match the model in URL
            # but contain ZERO version data, only retirement dates and
            # replacement-product pointers. The Arista DCS-7050SX-72 case hit
            # arista.com/.../advisories-notices/end-of-... and got "no version"
            # because the page is a discontinued-product announcement.
            if re.search(r"[-_/](eol|eos|end[-_]?of[-_]?life|end[-_]?of[-_]?sale|"
                         r"discontinued|archive|advisories?-notices?)([-_./]|$)", low):
                score -= 80
            # Login-walled portals — supportportal.juniper.net, the
            # support.hpe.com/.../docDisplay SPA, support.hpe.com/.../api/...,
            # the Cisco Bug Search Tool. These return either a "sign in"
            # page or a JSON envelope rather than scrapeable HTML, so the
            # version extractor sees nothing useful even though the URL
            # superficially matches release-notes keywords.
            if any(sd in netloc for sd in ("supportportal.", "casecentral.",
                                           "softwarekey.", "license.",
                                           "credentials.")):
                score -= 90
            if re.search(r"/(bugsearch|bst|case|ticket|sign[-_]?in|login|"
                         r"docdisplay|hpesc/public/api|public/api/document)", low):
                score -= 80
            # Cisco /support/docs/ TechNotes — these are short FAQ-style
            # docs that mention the model in passing but rarely list versions.
            # Real release notes live under /td/docs/.../release_notes/.
            if "/support/docs/" in low:
                score -= 30

            if score > best_score:
                best_score = score
                best_url = href
                if score >= 100:
                    return best_url   # nothing will beat this

    # Don't return a URL that scored negative after all penalties — at that
    # point we've degraded to "vaguely on-topic forum noise" and the scrape
    # will yield garbage versions.
    if best_score <= 0 or best_url is None:
        # Last-ditch: open-web search. Many vendor sites (TP-Link business
        # switches, Allied Telesis, Buffalo, Edimax, smaller brands) have
        # poor search-engine indexing under their own `site:` filter, so
        # a vendor-restricted query returns nothing even when their
        # downloads page exists. The open-web fallback often surfaces
        # the same page via a third-party listing or via a different
        # domain than the alias map knows about.
        return _open_web_release_notes(model, vendor_name=vendor_name)
    # Final guard: even if the chosen URL scored above zero, reject it
    # if it's a login-walled or EOL page — those return ZERO version data
    # at fetch time, which propagates as "no version found" downstream
    # and worse, the URL is still presented to the user as "release notes".
    if _is_loginwall_or_eol(best_url):
        return _open_web_release_notes(model, vendor_name=vendor_name)
    return best_url


def is_index_page(url, soup):
    """Heuristic: is this a list/index of release notes rather than a single
    release notes page? Index pages typically have many links to other
    release-notes pages and no significant changelog content."""
    if not url:
        return False
    low = url.lower()
    if any(k in low for k in ("release-notes-list", "products-release-notes-list",
                              "release_notes_list", "/list.html", "-list.html")):
        return True
    # Heuristic: many links matching /release.note in the body
    rn_links = [a for a in soup.find_all("a", href=True)
                if re.search(r"release.?notes?", a["href"], re.I)]
    return len(rn_links) >= 6 and not extract_changelog_snippets(soup, max_sections=1)


def follow_to_real_release_notes(base_url, soup):
    """If `soup` is an index page, return the URL of the most relevant
    individual release-notes link. Otherwise None."""
    candidates = []
    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        if not href or href.startswith("#"):
            continue
        full = urljoin(base_url, href)
        if not full.startswith("http"):
            continue
        if not re.search(r"release.?notes?", full, re.I):
            continue
        title = a.get_text(" ", strip=True) or full
        candidates.append((full, title))

    if not candidates:
        return None

    # Prefer titles/URLs containing the highest version number.
    def rank(item):
        full, title = item
        text = f"{full} {title}"
        nums = []
        for m in VERSION_RE.finditer(text):
            t = _ver_tuple(m.group(0))
            if t:
                nums.append(t)
        return max(nums) if nums else (0,)

    candidates.sort(key=rank, reverse=True)
    return candidates[0][0]


# ─────────────────────────────────────────────
# Version parsing / comparison
# ─────────────────────────────────────────────
def _ver_tuple(s):
    """Comparable tuple from a version string. Letters are dropped — we sort
    on the numeric prefix only, which is good enough for 'latest' detection."""
    if not s:
        return None
    nums = re.findall(r"\d+", s)
    if not nums:
        return None
    return tuple(int(n) for n in nums[:6])


def _looks_like_date(nums):
    """True if a 3- or 4-part numeric tuple looks like Y/M/D rather than a
    real version string. Catches 'Last updated 2024.10.15' style noise."""
    if len(nums) < 3:
        return False
    y, mo, d = nums[0], nums[1], nums[2]
    if 1990 <= y <= 2099 and 1 <= mo <= 12 and 1 <= d <= 31:
        return True
    return False


def _is_plausible_version(v, *, labelled=False):
    """Centralized 'is this a real version' check. Used by extraction and
    the context-aware ranker so both apply the same noise filters.

    `labelled=True` means the candidate appeared next to a 'version:'/'release:'/
    'firmware:' keyword on the page — a strong positive signal that lets us
    accept ambiguous IP-shaped strings like '10.5.6.7' that would otherwise
    be rejected by the IP heuristic below."""
    if not v:
        return False
    numeric_parts = re.findall(r"\d+", v)
    if not numeric_parts:
        return False
    nums = [int(p) for p in numeric_parts]

    # Reject all-zero versions like "0000.0000.0000".
    if all(n == 0 for n in nums):
        return False
    # Reject Chrome-/build-style versions: 4+ parts where any middle segment
    # exceeds 1500. Real network-OS minor/patch numbers stay small.
    if len(nums) >= 4 and any(n > 1500 for n in nums[1:-1]):
        return False
    # IP address heuristic — exact 4 octets, all 0-255, no alphabetic suffix.
    # Previous code only rejected when the first octet was >= 100, which
    # famously let 10.x.x.x IPs through (Aruba bug surfaced "10.100.222.115"
    # as "latest version" because the scraped release-notes page had a
    # 10.x example IP near a heading). New rule: 4-octet all-≤255 strings
    # must come with a 'version:'/'release:' label nearby OR have at least
    # one octet > 255 to be accepted. This still keeps real 4-part versions
    # like '10.13.1010' (1010 > 255), '32.7.1.4' (labelled), '8.10.0.4'
    # (labelled), and '10.5.6.7' (labelled), while rejecting bare IPs.
    if (len(nums) == 4
            and all(0 <= n <= 255 for n in nums)
            and v == ".".join(numeric_parts)
            and not labelled):
        return False
    # Date-shaped versions ("2024.10.15", "20.10.2024") — noise on most pages.
    if _looks_like_date(nums):
        return False
    return True


def extract_versions(soup):
    """Pull plausible version strings from the page text."""
    text = soup.get_text(" ", strip=True)[:80_000]
    seen = set()
    out = []
    for m in VERSION_RE.finditer(text):
        v = m.group(1).strip().rstrip(".")
        if not _is_plausible_version(v):
            continue
        if v in seen:
            continue
        seen.add(v)
        out.append(v)
    return out


def latest_of(versions):
    rated = [(v, _ver_tuple(v)) for v in versions]
    rated = [(v, t) for v, t in rated if t]
    if not rated:
        return None
    rated.sort(key=lambda x: x[1], reverse=True)
    return rated[0][0]


# Phrases that, when sitting next to a version number, strongly suggest the
# version IS the "latest" / "current" one the page is about — not a historical
# reference. Used to weight context-aware version selection.
_LATEST_LABEL_RE = re.compile(
    r"\b(latest|current|newest|recommended|stable|now\s+available|"
    r"general\s+availability|ga\b|now\s+shipping)\b",
    re.I,
)


def _versions_in_text(text, *, labelled=False):
    """Yield plausible version strings from one chunk of text.

    `labelled=True` means the caller knows this text is a strong-context
    location (page title, h1, near a 'latest:' keyword, etc.). It relaxes
    the IP-shape filter in `_is_plausible_version` so 4-octet versions
    like '10.5.6.7' that appear in titles/headings can come through —
    while bare body-text occurrences of the same shape are still rejected
    as likely-IP."""
    for m in VERSION_RE.finditer(text or ""):
        v = m.group(1).strip().rstrip(".")
        if _is_plausible_version(v, labelled=labelled):
            yield v


def latest_version_smart(soup):
    """Pick the latest version using on-page CONTEXT, not just the highest
    tuple in the document. Walks tiers from most- to least-trusted, and within
    the first tier that has any versions, returns the HIGHEST tuple in that
    tier. This keeps:

      - single-version release-notes pages ('Release Notes for 16.12.7') honest
      - multi-version download/history pages picking the actual highest

    Tiers:
      1. <title> + <h1>            — page-headline versions
      2. <h2>/<h3>/<h4>            — section headings (often per-release blocks)
      3. 'latest/current/newest/GA' label proximity
      4. 'Version: X.Y.Z' / 'Release X.Y.Z' labelled body text
      5. Anywhere in body text"""

    def best_in(versions):
        rated = [(v, _ver_tuple(v)) for v in versions]
        rated = [(v, t) for v, t in rated if t]
        if not rated:
            return None
        rated.sort(key=lambda x: x[1], reverse=True)
        return rated[0][0]

    # Tier 1: title + h1 — treat as labelled context. Page titles like
    # "SmartFabric OS10 10.5.6.7 Release Notes" or "AOS-CX 10.10.1010
    # Release Notes" carry strong contextual signal that the embedded
    # version is the headline release, so we relax the IP-shape filter.
    tier1 = []
    title_el = soup.find("title")
    if title_el:
        tier1.extend(_versions_in_text(title_el.get_text(" ", strip=True), labelled=True))
    for h1 in soup.find_all("h1"):
        tier1.extend(_versions_in_text(h1.get_text(" ", strip=True), labelled=True))
    pick = best_in(tier1)
    if pick:
        return pick

    # Tier 2: h2/h3/h4 — section headings. Lower-confidence than h1, but
    # still curated by the page author. Treat as labelled to catch real
    # versions like '10.5.6.7' in subheadings; the IP-shape false positive
    # rate at this tier on real release-notes pages is low.
    tier2 = []
    for h in soup.find_all(["h2", "h3", "h4"]):
        tier2.extend(_versions_in_text(h.get_text(" ", strip=True), labelled=True))
    pick = best_in(tier2)
    if pick:
        return pick

    body_text = soup.get_text(" ", strip=True)[:80_000]

    # Tier 3: latest/current/newest/GA label proximity — strong context.
    tier3 = []
    for m in _LATEST_LABEL_RE.finditer(body_text):
        window = body_text[m.start(): m.start() + 120]
        tier3.extend(_versions_in_text(window, labelled=True))
    pick = best_in(tier3)
    if pick:
        return pick

    # Tier 4: explicit "Version: X.Y.Z" / "Release X.Y.Z" patterns.
    tier4 = []
    for m in LABELLED_VERSION_RE.finditer(body_text):
        v = m.group(1).strip().rstrip(".")
        if _is_plausible_version(v, labelled=True):
            tier4.append(v)
    pick = best_in(tier4)
    if pick:
        return pick

    # Tier 5: anywhere — unlabelled, IP-shape strings rejected. This is
    # last resort and the strict filter is intentional: scraping body
    # text for a "version" without context is how '10.100.222.115'
    # (an example IP from a config snippet) ended up being shown as the
    # latest AOS-CX version on an Aruba page.
    return best_in(list(_versions_in_text(body_text)))


# ─────────────────────────────────────────────
# Changelog scraper
# ─────────────────────────────────────────────
_CHANGELOG_HEADING_RE = re.compile(
    r"(release|version|firmware|changelog|what.?s\s+new|known\s+issue|"
    r"resolved|fixed|enhancements?|new\s+features?)",
    re.I,
)


def extract_changelog_snippets(soup, max_sections=8, max_chars=1500):
    """Find changelog-like sections. Returns:
       [{'section': '...', 'version': '1.2.3' or None, 'text': '...'}]"""
    out = []
    for h in soup.find_all(["h1", "h2", "h3", "h4"]):
        title = h.get_text(" ", strip=True)
        if not title or not _CHANGELOG_HEADING_RE.search(title):
            continue

        parts = []
        total = 0
        for elem in h.find_all_next():
            if elem.name and elem.name in ("h1", "h2", "h3", "h4") and elem is not h:
                break
            if elem.name in ("p", "li", "td"):
                t = elem.get_text(" ", strip=True)
                if not t:
                    continue
                parts.append(t)
                total += len(t)
                if total > max_chars:
                    break
        body = "\n".join(parts).strip()
        if not body:
            continue

        ver = None
        mver = VERSION_RE.search(title)
        if mver:
            ver = mver.group(1)

        out.append({
            "section": title.strip(),
            "version": ver,
            "text": body[:max_chars],
        })
        if len(out) >= max_sections:
            break
    return out


# ─────────────────────────────────────────────
# NIST NVD CVE lookup
# ─────────────────────────────────────────────
def query_nvd_cves(keywords, max_results=12):
    """Hit the NIST NVD CVE API. Returns a normalized list of dicts.

    The free, no-key tier is rate-limited to ~5 req/30s. We do at most 2
    calls per /api/firmware request, so this is safe for interactive use."""
    if not keywords or not keywords.strip():
        return []
    params = {
        "keywordSearch": keywords,
        "resultsPerPage": str(max(1, min(int(max_results), 50))),
    }
    url = NVD_API + "?" + urllib.parse.urlencode(params)
    headers = {
        "User-Agent": "RackTrack-Firmware-Check/1.0",
        "Accept": "application/json",
    }
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=NVD_TIMEOUT) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        print(f"[warn] NVD query failed: {e}", file=sys.stderr)
        return []

    out = []
    for item in data.get("vulnerabilities", []):
        cve = item.get("cve") or {}
        cve_id = cve.get("id")
        if not cve_id:
            continue

        desc = ""
        for d in cve.get("descriptions", []):
            if d.get("lang") == "en":
                desc = d.get("value", "")
                break

        severity = None
        score = None
        metrics = cve.get("metrics", {}) or {}
        for key in ("cvssMetricV31", "cvssMetricV30", "cvssMetricV2"):
            arr = metrics.get(key, []) or []
            if arr:
                m = arr[0]
                cvss = m.get("cvssData", {}) or {}
                severity = cvss.get("baseSeverity") or m.get("baseSeverity")
                score = cvss.get("baseScore") or m.get("baseScore")
                break

        out.append({
            "id": cve_id,
            "description": (desc or "")[:600],
            "severity": severity,
            "score": score,
            "published": cve.get("published"),
            "url": f"https://nvd.nist.gov/vuln/detail/{cve_id}",
        })
    return out


# ─────────────────────────────────────────────
# Main entry point — used by CLI and the Express backend
# ─────────────────────────────────────────────
_OVERRIDES_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                               "firmware_overrides.json")
_OVERRIDES_CACHE = None


def _alnum_lower(s):
    return re.sub(r"[^A-Za-z0-9]+", "", s or "").lower()


def _load_firmware_overrides():
    """Read pipeline/firmware_overrides.json once and cache. Curated entries
    are consulted before the (frequently-blocked) web scraper. See the JSON
    file's `_doc` field for matching rules."""
    global _OVERRIDES_CACHE
    if _OVERRIDES_CACHE is not None:
        return _OVERRIDES_CACHE
    try:
        with open(_OVERRIDES_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        _OVERRIDES_CACHE = data.get("entries", []) or []
    except Exception as e:
        print(f"[warn] firmware_overrides.json unreadable: {e}", file=sys.stderr)
        _OVERRIDES_CACHE = []
    return _OVERRIDES_CACHE


def _lookup_override(vendor_name, model):
    """Return the best-matching override entry, or None.

    Vendor: case-insensitive substring match against entry.vendor or any
    of entry.vendor_aliases. Model: alphanumeric-stripped, case-insensitive
    substring match against entry.model_pattern. Among multiple matches,
    the longest model_pattern wins (most specific entry beats the family
    fallback)."""
    entries = _load_firmware_overrides()
    if not entries:
        return None
    vendor_l = (vendor_name or "").lower()
    model_n = _alnum_lower(model or "")
    if not vendor_l or not model_n:
        return None

    best = None
    best_specificity = -1
    for e in entries:
        vendors_to_match = [e.get("vendor", "")] + list(e.get("vendor_aliases") or [])
        if not any(v and v.lower() in vendor_l or vendor_l in (v or "").lower()
                   for v in vendors_to_match):
            continue
        pat = _alnum_lower(e.get("model_pattern", ""))
        if not pat or pat not in model_n:
            continue
        if len(pat) > best_specificity:
            best = e
            best_specificity = len(pat)
    return best


def fetch_firmware_info(vendor_query, model_query, current_version,
                        excel_path=DEFAULT_EXCEL, *, skip_cves=False):
    # Curated override is consulted FIRST — even before vendor-Excel
    # resolution. This way a vendor not in the Excel (e.g. nvidia, who
    # ships Cumulus Linux on Mellanox-derived switches) still produces a
    # usable response when we have a hand-curated entry for the model.
    override = _lookup_override(vendor_query, model_query)

    vendors = load_vendors(excel_path)
    chosen = _pick_vendor_strict(vendor_query, vendors) if vendors else None

    if not chosen and not override:
        return {"ok": False, "error": f"Vendor not found: {vendor_query}"}

    if chosen:
        vendor_name, vendor_url = chosen
    else:
        # Override-only path: fall back to override's vendor + releaseNotesUrl.
        vendor_name = override.get("vendor") or vendor_query
        vendor_url = override.get("releaseNotesUrl") or ""
    # Try both normalisations: the raw uppercase form (used by Cisco/NVD) and
    # the dash-inserted form (used by some other vendors). Prefer the form
    # that finds a release-notes URL.
    model_light = _light_normalize_model(model_query)
    model_dashed = normalize_model(model_query)
    model = model_light  # what we display + send to NVD
    domain = _root_domain(vendor_url)

    # When a curated override matched, short-circuit the scraper. The
    # release-notes URL + latestVersion come straight from the JSON file;
    # CVE lookup still runs below.
    override_used = bool(override and override.get("latestVersion"))
    rn_followed_from = None
    versions = []
    changelog = []
    rn_error = None

    if override_used:
        rn_url = override.get("releaseNotesUrl") or None
        latest_version = override.get("latestVersion")
    else:
        # Release notes / changelog scrape — try both model normalisations.
        rn_url = find_release_notes_url(domain, model_light, vendor_name=vendor_name)
        if not rn_url and model_dashed != model_light:
            rn_url = find_release_notes_url(domain, model_dashed, vendor_name=vendor_name)
        latest_version = None

    def _page_mentions_model(soup, model_str):
        """Quick check: does the page actually reference this SKU? Title,
        h1-h3, or first ~5 KB of body text. Generic 'support/home/downloads'
        pages match release-notes keywords but talk about every product —
        if the page doesn't name our model, the version we'd extract from
        it is a different product's version."""
        if not model_str:
            return True
        flat = re.sub(r"[^a-z0-9]", "", model_str.lower())
        if not flat:
            return True
        if soup.title:
            tflat = re.sub(r"[^a-z0-9]", "", soup.title.get_text().lower())
            if flat in tflat:
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

    # Scraping is skipped entirely when a curated override has set
    # latest_version — the vendor sites we'd hit are mostly blocked or
    # JS-rendered anyway, and we don't want a failed scrape to clobber
    # the override value.
    if rn_url and not override_used:
        try:
            r = SESSION.get(rn_url, timeout=PAGE_TIMEOUT)
            soup = BeautifulSoup(r.text, "html.parser")
            # Reject pages that don't mention our model — but ONLY when
            # the URL isn't on the vendor's own domain. Vendor-own pages
            # often legitimately don't name a specific SKU: Juniper's
            # Junos release notes are per-OS-version (juniper.net/
            # documentation/us/en/software/junos/22.4r3/release-notes)
            # and never list "QFX5100-48S" because they apply to all
            # QFX hardware. The same is true of MikroTik RouterOS
            # changelogs and Cisco IOS-XE per-train release notes.
            #
            # The model-mention check is meant to catch open-web/3rd-party
            # noise: netgear.com/support/home/downloads (generic landing
            # page) or driverguide.com/AMD-Radeon-HD-6300M (totally wrong
            # product, model SKU only matched in URL). Skip it for
            # vendor-domain hits.
            _vendor_doms = set(_resolve_domains(vendor_name, vendor_url))
            _host = urlparse(rn_url).netloc.lower()
            _host = _host[4:] if _host.startswith("www.") else _host
            on_vendor = any(_host == d or _host.endswith("." + d)
                            for d in _vendor_doms)
            if not on_vendor and \
               not _page_mentions_model(soup, model_light) and \
               not _page_mentions_model(soup, model_dashed):
                # Try the open-web fallback once before giving up — it may
                # surface a model-specific page (e.g. router-switch.com)
                # that the vendor's own site lacks.
                fallback = _open_web_release_notes(model_light,
                                                   vendor_name=vendor_name,
                                                   vendor_url=vendor_url)
                if fallback and fallback != rn_url:
                    rn_url = fallback
                    r = SESSION.get(rn_url, timeout=PAGE_TIMEOUT)
                    soup = BeautifulSoup(r.text, "html.parser")
                else:
                    rn_url = None  # don't claim we found release notes
                    soup = None
            if soup is not None:
                # If this is a list/index page (e.g. Cisco "release-notes-list"),
                # follow into the highest-versioned linked release-notes page.
                if is_index_page(rn_url, soup):
                    follow = follow_to_real_release_notes(rn_url, soup)
                    if follow and follow != rn_url:
                        rn_followed_from = rn_url
                        rn_url = follow
                        r = SESSION.get(rn_url, timeout=PAGE_TIMEOUT)
                        soup = BeautifulSoup(r.text, "html.parser")
                versions = extract_versions(soup)
                changelog = extract_changelog_snippets(soup)
                # Prefer a context-aware pick (title/heading/labelled) over a
                # raw tuple max — pages often list older versions for download
                # alongside the headline current release.
                latest_version = latest_version_smart(soup) or latest_of(versions)
        except Exception as e:
            rn_error = f"failed to fetch release notes: {e}"
            print(f"[warn] {rn_error}", file=sys.stderr)

    if latest_version is None:
        latest_version = latest_of(versions)

    # 2. Version comparison
    cur_t = _ver_tuple(current_version)
    lat_t = _ver_tuple(latest_version) if latest_version else None

    # Sanity check: if the "latest" we found is wildly incompatible with
    # current's major version, it's almost certainly page noise — a docs
    # system version, embedded library version, marketing copy ("now in
    # its 2nd generation"), etc. — not a real firmware release.
    #
    # The Aruba CX 6300M was showing "Up to date" with latest=2.5.8
    # against current=10.08.1000 because the comparison (10,8,1000) >=
    # (2,5,8) is technically true. Returning a confidently-wrong "Up to
    # date" verdict is much worse than admitting we couldn't determine
    # latest, so reject lat_t entirely when the major versions disagree
    # by more than ~2× in either direction.
    if cur_t and lat_t and cur_t[0] > 0 and lat_t[0] > 0:
        cur_major, lat_major = cur_t[0], lat_t[0]
        # Two complementary sanity checks:
        #  (a) Multiplicative — covers small-numbered OSes where +6 absolute
        #      would over-reject a real generation jump (e.g. 2.x → 12.x).
        #  (b) Absolute +6 — covers larger-numbered OSes where the multiplicative
        #      rule is too generous (Cisco IOS-XE 17 → 26 should be rejected;
        #      17*2+5=39, so the multiplicative rule alone allowed 26 to slip
        #      through and report "Catalyst 9200 latest=26.1.1" — which was
        #      page noise, the real latest is 17.12.x.).
        # Apply the tighter (a OR b) — if either trips, reject.
        major_jump = lat_major - cur_major
        too_low = lat_major * 2 < cur_major
        too_high_mult = lat_major > cur_major * 2 + 5
        too_high_abs = cur_major >= 5 and major_jump > 6
        if too_low or too_high_mult or too_high_abs:
            print(f"[warn] rejecting latest={latest_version!r} — major mismatch with current={current_version!r}",
                  file=sys.stderr)
            latest_version = None
            lat_t = None

    up_to_date = None
    if cur_t and lat_t:
        up_to_date = cur_t >= lat_t

    # 3. CVE lookup — try progressively broader keywords until something
    # comes back. NVD's keyword index is full-text, so over-specifying
    # (vendor + exact model + version) often returns nothing for niche gear,
    # while vendor-only is too noisy as a default. Try 4 tiers.
    vendor_short = vendor_name.split()[0]
    candidate_kws = []
    # tier 1: vendor + model + version
    if current_version:
        candidate_kws.append(" ".join(filter(None,
            [vendor_short, model, current_version])).strip())
    # tier 2: vendor + model
    candidate_kws.append(" ".join(filter(None, [vendor_short, model])).strip())
    # tier 3: just the model (catches CVEs that name the product without
    # the vendor brand — common with Aruba/HPE, Brocade, etc.)
    if model:
        candidate_kws.append(model.strip())
    # tier 4: vendor + 'switch'/'router' product class — last-ditch broad scoop
    candidate_kws.append(f"{vendor_short} switch".strip())

    cves = []
    cves_used_keywords = ""
    if not skip_cves:
        seen_kws = set()
        for kw in candidate_kws:
            if not kw or kw in seen_kws:
                continue
            seen_kws.add(kw)
            cves = query_nvd_cves(kw)
            cves_used_keywords = kw
            if cves:
                break

    # Annotate each CVE with a 'matchesCurrentVersion' flag — best-effort
    # textual check against the description. Won't catch every case but is
    # useful when the description names the version explicitly.
    cur_norm = (current_version or "").strip().lower()
    for c in cves:
        c["matchesCurrentVersion"] = bool(
            cur_norm and cur_norm in (c.get("description") or "").lower()
        )

    return {
        "ok": True,
        "vendor": vendor_name,
        "vendorUrl": vendor_url,
        "model": model,
        "currentVersion": current_version,
        "latestVersion": latest_version,
        "upToDate": up_to_date,
        "releaseNotesUrl": rn_url,
        "releaseNotesIndexUrl": rn_followed_from,
        "releaseNotesError": rn_error,
        "versionsFound": versions[:25],
        "changelog": changelog,
        "cves": cves,
        "cvesKeywords": cves_used_keywords,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--vendor", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--current-version", required=True,
                        help="Currently-installed firmware/OS version, e.g. 15.2.4")
    parser.add_argument("--excel", default=DEFAULT_EXCEL)
    parser.add_argument("--json", action="store_true",
                        help="Emit one JSON line on stdout (for backend use)")
    args = parser.parse_args()

    try:
        result = fetch_firmware_info(args.vendor, args.model,
                                     args.current_version, args.excel)
    except FileNotFoundError:
        result = {"ok": False, "error": f"Excel not found: {args.excel}"}
    except Exception as e:
        result = {"ok": False, "error": f"unexpected: {e}"}

    if args.json:
        print(json.dumps(result))
        sys.exit(0 if result.get("ok") else 2)

    # Pretty CLI output
    if not result.get("ok"):
        print(f"Error: {result.get('error')}")
        sys.exit(1)
    print(f"Vendor:          {result['vendor']}")
    print(f"Model:           {result['model']}")
    print(f"Current version: {result['currentVersion']}")
    print(f"Latest version:  {result.get('latestVersion') or 'unknown'}")
    if result.get("upToDate") is True:
        print("Status:          up to date")
    elif result.get("upToDate") is False:
        print("Status:          UPGRADE AVAILABLE")
    if result.get("releaseNotesUrl"):
        print(f"Release notes:   {result['releaseNotesUrl']}")
    cves = result.get("cves", [])
    print(f"\nCVEs ({len(cves)}, keywords='{result.get('cvesKeywords','')}'):")
    for c in cves[:8]:
        sev = f"[{c.get('severity') or '?'} {c.get('score') or ''}]".strip()
        print(f"  · {c['id']} {sev} — {c['description'][:120]}")


if __name__ == "__main__":
    main()

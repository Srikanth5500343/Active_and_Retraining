# 08. Firmware — latest version, upgrade status, CVEs

## What it does (junior view)

Given a switch's vendor + model + current firmware version, the
firmware-check stage answers three questions:

1. **What's the latest published version?** Scrapes the vendor's
   release-notes page for the highest version it can find.
2. **Is the user up to date?** Compares current vs latest; returns
   one of *Up to date / Upgrade available / Upgrade strongly
   recommended / Couldn't read latest*.
3. **Are there known security bugs in the current version?**
   Queries the NIST National Vulnerability Database (NVD) for
   CVEs that mention this vendor + model + version.

The result drives the **Firmware** card on the Switches tab —
status pill, CVE count breakdown (`12 (2c/7h)` = 12 total,
2 critical, 7 high), Release notes link.

The system errs on the side of saying **"Couldn't read latest —
check vendor"** rather than confidently wrong. Earlier, an Aruba
switch was showing **"Up to date"** because the scraper had read
`2.5.8` (a docs-system version) as "latest" and the comparison
`(10,8,1000) >= (2,5,8)` was technically true. We now reject any
"latest" candidate whose major version is wildly incompatible with
the user's current — see the technical section.

## What it doesn't do well

- **Latest version detection** is brittle. Vendor pages move,
  redirect, or move content behind login. When the scraper can't
  reach the right page, it honestly says "Couldn't read latest"
  instead of guessing.
- **CVE relevance to a specific version.** NVD's free API takes a
  free-text query; it returns CVEs that mention the keywords, not
  CVEs that are guaranteed to apply to the user's exact firmware
  build. The card flags any CVE whose description names the user's
  current version explicitly (best-effort), but the count is
  approximate.

---

## Technical detail (lead view)

### Endpoint

[`POST /api/firmware`](../server/app.js) at `server/app.js:3336`.

Request:
```json
{
  "vendor": "Mikrotik",
  "model":  "CRS326-24G-2S+RM",
  "currentVersion": "10.5.0.7"
}
```

All three fields required (400 otherwise).

Response:
```json
{
  "ok": true,
  "vendor": "Mikrotik",
  "vendorUrl": "https://www.mikrotik.com",
  "model": "CRS326-24G-2S+RM",
  "currentVersion": "10.5.0.7",
  "latestVersion": "7.16.2",
  "upToDate": false,
  "releaseNotesUrl": "https://help.mikrotik.com/docs/...",
  "releaseNotesIndexUrl": null,
  "releaseNotesError": null,
  "versionsFound": ["7.16.2", "7.16.1", "7.16", ...],
  "changelog": [{"title": "RouterOS 7.16.2", "text": "..."}, ...],
  "cves": [
    {
      "id": "CVE-2024-XXXXX",
      "score": 7.5,
      "severity": "HIGH",
      "description": "...",
      "matchesCurrentVersion": false
    }
  ],
  "cvesKeywords": "Mikrotik CRS326-24G-2S+RM 10.5.0.7"
}
```

### Pipeline

`pipeline/firmware_check.py:fetch_firmware_info()`. Steps:

```
1. Resolve vendor       → _pick_vendor_strict(query, vendors)
                           reads Switch_Vendors_Websites.xlsx
2. Normalize model      → _light_normalize_model (preserves dashes)
3. Find release-notes URL
                        → find_release_notes_url(domain, model)
                          uses ddgs (DuckDuckGo) site:domain queries
                          across multiple alias domains
4. If found, scrape it  → BeautifulSoup
   - is_index_page?     → follow_to_real_release_notes
   - extract_versions   → all version-shaped strings on page
   - latest_version_smart → tier-walked highest-tuple selection
   - extract_changelog_snippets
5. Sanity-check latest  → reject if major version wildly mismatched
6. Compare to current   → upToDate = cur_t >= lat_t
7. Query NVD            → query_nvd_cves(keywords) with 4-tier fallback
                          (vendor+model+version → vendor+model →
                           model → vendor+"switch")
8. Annotate CVEs        → matchesCurrentVersion if version in description
```

### Domain alias map

`pipeline/all_vendor.py:VENDOR_DOMAIN_ALIASES`. The Excel sheet
lists one URL per vendor; that URL is often outdated or points to
a marketing page while the actual product/release content lives on
a different subdomain. Aliases let us search all known domains for
this vendor:

```python
"Aruba (HPE)": [
    "arubanetworking.hpe.com",   # modern AOS-CX docs live here
    "support.hpe.com",            # KB + support articles
    "arubanetworks.com",          # legacy, mostly redirects
    "hpe.com",
],
"Dell": [
    "dell.com",
    "infohub.delltechnologies.com",
    "delltechnologies.com",
],
# ... 8 more vendors
```

`_resolve_domains(vendor_name, vendor_url, max_domains=2)` returns
the top-2 aliases. Capped at 2 to keep the search amplification
bounded — without the cap, 4 domains × 4 query strings × 3 search
backends = ~60s round trip, blowing past the 90s spawn timeout.

### Version regex (`VERSION_RE`)

`pipeline/firmware_check.py:65-75`. Whitelisted shapes:

```
\bV\d{2,4}R\d{1,4}(?:C\d{1,4})?\b              # Huawei VRP V200R023C00
\b\d{1,4}(?:\.\d{1,4}){2,4}                    # standard 3-5-part dotted
       (?:[A-Za-z][A-Za-z0-9]{0,5})?           #   optional letter suffix
       (?:-[A-Za-z0-9]{1,8})?\b                #   optional dash-suffix
\b\d{1,3}\.\d{1,3}[A-Z]\d{1,3}                 # Juniper 22.4R3
       (?:-[A-Z]\d{1,3})?\b
\b\d{1,3}\.\d{1,3}\(\d{1,3}[A-Za-z]?\)         # Cisco NX-OS 9.3(7)I7(7)
       (?:[A-Z]\d{1,3}(?:\(\d{1,3}\))?)?
```

`LABELLED_VERSION_RE` is the same shape preceded by
`version|release|firmware|software|train|v` — used in the
context-aware tier walk to give labelled candidates a stronger
signal.

### `_is_plausible_version(v, labelled=False)`

Filters out things that match `VERSION_RE` shape but aren't real
versions:

- All-zero (`0.0.0.0`)
- Chrome/build-style (4+ parts, middle segment > 1500)
- IP addresses (4 octets all 0-255, not labelled — see below)
- Date-shaped (`2024.10.15`, `20.10.2024`)

The IP filter is the subtle one. The old rule was "reject when
4-octet all-≤255 AND first octet ≥ 100", which let `10.x.x.x` IPs
through (Aruba was showing `10.100.222.115` as "latest" — a 10.x
example IP from a config snippet on the page). The new rule:

- 4-octet all-≤255 strings are **rejected** unless the caller
  passes `labelled=True`.
- Labelled positions: page title, h1/h2/h3/h4, near a "latest"
  keyword, after a "Version:" label.
- Strings with at least one octet > 255 (real Aruba `10.13.1010`)
  are accepted unconditionally.

This catches the IP false-positive while still admitting real
4-part versions like `10.5.6.7` (Dell SmartFabric) or `8.10.0.4`
(older Aruba) when they appear in title/heading positions.

### `latest_version_smart(soup)` — tier-walked extraction

`pipeline/firmware_check.py:408`. Walks 5 tiers, returns the first
tier with any plausible versions:

| Tier | Source | Labelled? |
|---|---|---|
| 1 | `<title>` + `<h1>` | yes |
| 2 | `<h2>/<h3>/<h4>` | yes |
| 3 | text near "latest"/"current"/"GA" keyword (within 120 chars) | yes |
| 4 | `Version: X.Y.Z` / `Release X.Y.Z` body matches | yes |
| 5 | anywhere in body text | no |

Within a tier, the **highest** version tuple wins. Tier 5 is the
strict-IP-filter tier — used as last resort when none of the
labelled tiers had anything.

### Major-version sanity check

`pipeline/firmware_check.py:642`. After picking `latest_version`,
do a final reasonability check:

```python
if cur_t and lat_t and cur_t[0] > 0 and lat_t[0] > 0:
    cur_major, lat_major = cur_t[0], lat_t[0]
    if lat_major * 2 < cur_major or lat_major > cur_major * 5 + 5:
        # major mismatch — reject silently, treat latest as unknown
        latest_version = None
        lat_t = None
```

Why: even after the IP filter, the scraper occasionally finds a
**real-shape** version that's actually unrelated noise (a
docs-system version like `2.5.8` on a Confluence-hosted page).
Returning a confident "Up to date" verdict when the comparison
input is garbage is much worse than admitting we couldn't tell.

The `× 2` / `× 5 + 5` thresholds are tuned to keep legitimate
upgrades (Aruba 8.x → 10.x, Cisco IOS 15 → 17, JunOS 22 → 24)
while rejecting `10.x → 2.x` style noise. The 14 test cases at
`pipeline/test_*` (run inline in the parser harness) cover these.

### CVE lookup (NVD API)

`pipeline/firmware_check.py:520`. NIST NVD public endpoint
(`https://services.nvd.nist.gov/rest/json/cves/2.0`). No API key
required; rate-limited to ~5 req/30s without one (we don't hit
the limit in normal use because each user firmware lookup makes
at most 4 NVD queries due to the keyword fallback).

Four-tier keyword fallback because over-specifying returns nothing
for niche gear, and under-specifying is too noisy:

```
tier 1: vendor + model + version       e.g. "Mikrotik CRS326 10.5.0.7"
tier 2: vendor + model                 e.g. "Mikrotik CRS326"
tier 3: model only                     e.g. "CRS326"
tier 4: vendor + 'switch'              e.g. "Mikrotik switch"
```

First tier that returns >0 results wins. The CVE list returned
includes id, score, severity (`CRITICAL/HIGH/MEDIUM/LOW`), description,
and a `matchesCurrentVersion` boolean (true if the description
contains the current version string verbatim).

### Caching

There is **no caching layer** for firmware lookups. Each call hits
ddgs and NVD live. The client-side `scanPrefetch` keeps results in
memory after the first call so navigating between switches doesn't
re-fetch, but the server has no on-disk cache for `(vendor, model,
version) → result`. A scrape costs roughly 5-15s; on rack-scan
prefetch we fan out one per detected switch in parallel.

If this becomes a bottleneck, the right place to add a TTL cache
is in `runPipelineModule` keyed by the args list. NVD results
could go on a 24h TTL; release-notes scrapes on 12h.

### Files in this feature

| File | Role |
|---|---|
| `pipeline/firmware_check.py` | All scraping + parsing + NVD calls |
| `pipeline/all_vendor.py` | `_pick_vendor_strict`, `_resolve_domains`, search backends |
| `Switch_Vendors_Websites.xlsx` | Canonical vendor names + URLs |
| `server/app.js:3336 /api/firmware` | HTTP endpoint |
| `client/src/pages/SwitchInformationPage.jsx:425` | `fwHeadline` derivation |
| `client/src/pages/SwitchInformationPage.jsx:loadDetails` | Cached fetch caller |

# 09. Specifications — vendor product-page scraping

## What it does (junior view)

Given a vendor + model, the specs stage finds the vendor's product
page on the web and reads the spec table off it. Result: the
**Specifications** section of the Switches tab (port count,
throughput, supported protocols, dimensions, power draw, etc.).

The specs come straight from the vendor — we don't maintain our
own database of switch specs, because every vendor publishes their
own datasheets and any cached copy goes stale the day they release
a new revision.

How the lookup decides which page to read:

1. **Search the vendor's website** for the model number. Specifically:
   `site:vendor.com MODEL` plus three variants (`"MODEL"`,
   `MODEL data sheet`, `MODEL specifications`).
2. **Score every URL that came back** — products pages get a
   bonus, datasheet collateral pages get a bigger bonus, EOL/EOS
   pages get a penalty, forum threads get a heavy penalty,
   community discussions are blocked.
3. **Try each candidate in score order** — fetch, parse the HTML,
   extract any spec-shaped tables. First page with parseable specs
   wins.
4. **Open-web fallback** — if the vendor's own site has no
   parseable spec page (modern Cisco /site/ pages are
   JS-rendered), search the open web for distributor /
   aggregator pages (router-switch.com, FS.com, etc.) and try
   those.

If nothing works, the user sees **"Product page not found"** or
**"Couldn't load specs"**. There's a **View full details** link to
the vendor's product page so they can read it themselves.

## What it doesn't do

- It doesn't render PDFs. Many vendors publish only PDF datasheets;
  those get heavily de-prioritized in scoring (PDF can't be parsed
  by BeautifulSoup) but are still kept as a last-resort link.
- It doesn't currently maintain a vendor-specific extractor per
  vendor. The extractor is generic — it looks for `<table>`
  patterns and `<dl>` definition lists with key/value rows. Some
  vendors (Cisco modern /site/ pages, Aruba newer SPA pages)
  render specs entirely client-side with React, so the static
  HTML has nothing to extract.

---

## Technical detail (lead view)

### Endpoint

[`POST /api/specs`](../server/app.js) at `server/app.js:3304`.

Request:
```json
{ "vendor": "Mikrotik", "model": "CRS326-24G-2S+RM" }
```

Response (success):
```json
{
  "ok": true,
  "vendor": "Mikrotik",
  "vendorUrl": "https://www.mikrotik.com",
  "model": "CRS326-24G-2S+RM",
  "productUrl": "https://mikrotik.com/product/crs326-24g-2srm",
  "specs": {
    "Switch Chip": "98DX3236",
    "CPU nominal frequency": "800 MHz",
    "RAM": "512 MB",
    "Total non-blocking Throughput": "26 Gbps",
    "Switching Capacity": "52 Gbps",
    "Forwarding Rate (64-byte packets)": "39 Mpps",
    "10/100/1000 Ethernet ports": "24",
    "SFP+ ports": "2",
    "Console port": "RJ45",
    "Dimensions": "443x144x44 mm",
    "Operating Temperature": "-40°C to +70°C",
    ...
  }
}
```

Response (failure):
```json
{
  "ok": false,
  "error": "Product page not found",
  "vendor": "Mikrotik",
  "vendorUrl": "https://www.mikrotik.com",
  "model": "CRS326-24G-2S+RM"
}
```

`error` strings the user can see: *"Product page not found"* (no
candidate URLs returned by search), *"No specifications found on
any candidate URL"* (URLs returned but none had parseable specs).

### Pipeline

`pipeline/all_vendor.py:fetch_specs(vendor_query, model_query)`.
~80 lines. Steps:

```
1. cache check        — _cache_load(_cache_key(vendor, model))
                        in-memory + on-disk (outputs/.specs_cache/)
2. vendor resolve     — _pick_vendor_strict(query, vendors)
                        loads Switch_Vendors_Websites.xlsx
3. model normalize    — normalize_model + expand_partial_model
                        (fuzzy expansion of partial model fragments)
4. domain candidates  — _resolve_domains(vendor, vendor_url, max=2)
                        same alias map as firmware_check
5. URL candidates     — find_product_urls(vendor_url, model, top_n=6)
                        4 search queries × 2 domains, scored and ranked
6. try each URL       — _try_extract(url, model)
                        first one with parseable specs wins
7. open-web fallback  — find_open_web_urls(model, vendor_name)
                        if vendor pages all failed
8. write cache + return
```

### `find_product_urls()` scoring

`pipeline/all_vendor.py:554`. Each candidate URL gets scored on:

| Signal | Score |
|---|---|
| URL contains `/products/` or `/product/` | +25 |
| URL contains `/switches/` or `switch` | +15 |
| URL contains `data-sheet` or `datasheet` | +25 |
| URL contains `/collateral/` (Cisco datasheet path) | +30 |
| URL contains `/networking/` | +10 |
| URL contains `series` or `-series` | +10 |
| Forum subdomain (`community.`, `forum.`) | -100 |
| Forum-thread URL path (`/t5/`, `/t/`, `/td-p/`) | -100 |
| Non-product path (`/about/`, `/careers/`, `/legal/`) | -40 |
| EOL/EOS page (`-eol`, `/eos/`, `-end-of-life-`) | -80 |
| `/group/`, `/category/`, `/shop/`, `/listing/`, `/catalog/` | -30 |
| Model name appears in URL (full match) | +20-50 |
| Model name in URL but only the family prefix | +10 |
| URL is a PDF | -50 |
| Subdomain different from canonical vendor host | -20 |
| Host is in vendor's alias list | +5 (alias bonus) |

Final score < 0 → rejected. Top `top_n=6` by score → tried in
order until one yields specs.

### `extract_specs(soup)` — table extractor

`pipeline/all_vendor.py:_try_extract`. Walks every `<table>` and
`<dl>` on the page, applies these heuristics to decide if a
table is a "spec table":

- ≥3 rows
- Each row has 2 cells (key / value), or 3 cells (key / unit /
  value)
- Keys are short (typically <60 chars) and don't look like SKU
  part numbers (which signal an accessory/MTBF table — see
  `_is_sku_list_table`)
- The page mentions our model somewhere (`_page_mentions_model`)

When multiple spec tables are found on one page, they're merged
into one dict (later tables overwrite earlier same-key entries —
deliberately, because vendors typically put summary specs first
and detailed specs further down).

### SKU-list table filter

A common false positive: a vendor product page has the spec table
plus a "compatible accessories" table where every row is a
different SKU (`STACK-T1-50CM`, `PWR-C1-350WAC-P`, etc.). Without
filtering, those rows pollute the spec dict.

`_is_sku_list_table(table)` detects this — if the **first column**
of the table is mostly part-number-shaped strings, the whole
table is dropped. The shape detector is at line 619
(`_looks_like_any_sku`), regex `^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*=?$`
plus length and digit-density checks.

### `expand_partial_model()` — fuzzy fragment expansion

Users (and OCR) sometimes type partial model fragments like
`CRS326`, `RB951`, `93180YC`. `expand_partial_model` knows the
common families:

```python
[/^CRS3265?$/i,   'CRS326-24G-2S+RM'],
[/^CRS3261?$/i,   'CRS326-24G-2S+RM'],
[/^CRS5181?/i,    'CRS518-16XS-2XQ-RM'],
[/^CCR20041?/i,   'CCR2004-1G-12S+2XS'],
[/^C93001?$/i,    'C9300-24T'],
[/^TLSG24281?/i,  'TL-SG2428P'],
# ...
```

Same map exists on the JS side in `SwitchInformationPage.jsx:73`
(`PARTIAL_MODEL_MAP`) — should stay in sync.

### Open-web fallback

`pipeline/all_vendor.py:find_open_web_urls`. Searches the web
without a `site:` filter, accepts any host except social /
forum / paywall noise:

```python
queries = [
    f'"{model}" specifications',
    f'"{model}" product specifications',
    f'"{model}" datasheet',
    f"{model} specs",
]
if vendor_name:
    queries.insert(0, f'"{vendor_name}" "{model}" specifications')
```

Distributor and aggregator pages (router-switch.com, FS.com,
nuvias-ds.com) often have parseable spec tables when the vendor's
own page is JS-rendered. The vendor-restricted pass is tried
first; this only runs when the vendor pass produced nothing
parseable.

### Caching

In-memory dict keyed by `_cache_key(vendor, model)` (slugified
both). Plus on-disk persistence in
`outputs/.specs_cache/<key>.json`. The cache survives server
restarts — useful in production where the vendor pages are
reasonably stable. There's no TTL today; entries are valid until
manually deleted.

The cached payload includes `_cached: True` so the caller can
distinguish a cache hit (cheap, instant) from a fresh scrape
(slow, network-dependent).

### Failure modes

| Failure | Cause | What user sees |
|---|---|---|
| "Product page not found" | search returned no candidates after scoring | Specs section: "Product page not found" |
| "No specifications found on any candidate URL" | candidates returned but extractor pulled nothing parseable | Specs section: error or "Couldn't load specs" |
| Timeout (90s spawn limit) | search amplification on slow vendor sites | Specs section: friendly fallback (the user-visible string is sanitised by `looksLikeBackendNoise` on the client) |
| Cloudscraper blocked | vendor has aggressive anti-bot (e.g. Cloudflare challenge) | Same as no-content — falls through to open-web fallback |

### Performance

Per-call cost on a cache miss:

- 4 search queries × 2 domains × ~6s (parallelised across 3 search backends) ≈ 8-15s
- Plus 1-3 page fetches (`_try_extract` short-circuits at first hit) ≈ 2-6s
- Total: typically 10-20s, occasionally up to ~60s on slow sites

Cache hit is sub-millisecond.

### Files in this feature

| File | Role |
|---|---|
| `pipeline/all_vendor.py` | All of it: vendor resolve, model normalise, search, extract, cache |
| `Switch_Vendors_Websites.xlsx` | Vendor name → URL map (column A: number, B: name, C: URL) |
| `server/app.js:3304 /api/specs` | HTTP endpoint |
| `server/app.js:3296 /api/specs/vendors` | Vendor list (read from same Excel) |
| `client/src/pages/SwitchInformationPage.jsx:loadDetails` | Caller, with prefetch cache |
| `client/src/utils/scanPrefetch.js:_prefetchSpecs` | Pre-fetcher fired post-analyze |

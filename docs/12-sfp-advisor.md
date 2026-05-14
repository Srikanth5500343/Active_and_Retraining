# 12. SFP Advisor — recommending transceiver modules

## What it does (junior view)

When a switch has SFP cages (the slots that take fiber or DAC
transceivers), the **SFP Procurement Advisor** card recommends:

- What **slot type** the cages are (SFP, SFP+, SFP28, QSFP+,
  QSFP28, QSFP-DD)
- A **primary recommendation** — a specific part number from a
  major brand that fits this switch
- A **budget option** — a compatible third-party part for the same
  speed class
- **Other compatible options** (collapsible list)
- **Cable types** the slot supports (OM3/OM4 multimode, OS2 single-
  mode, DAC twinax, copper)
- Direct **buy/view links** to vendor pages where available

The recommendation set is **dynamic**, not from a hardcoded
database. Every call:

1. Asks the vendor's product page what slot type the model uses
2. Searches the open web for compatible transceivers
3. Returns a list ranked by brand authority + price

If the server is offline or the vendor scrape times out, the
advisor falls back to a slot-type inference from the switch
model name alone (`/^(Te|Fo|Hu)/i.test(iface)` etc.) plus
generic IEEE-standard cable specs (which fiber for which
distance). The fallback gives slot type + cable guidance but no
specific module SKUs.

The advisor is only shown when the switch has at least one SFP
port. For a pure copper switch (24-port RJ45, no SFP), the section
is hidden.

## What it doesn't do

- It doesn't check **current pricing live** — module prices are
  what the search results pages happened to display when scraped.
  Prices may be stale; the user is expected to confirm before
  buying.
- It doesn't model **bidirectional transceivers** (BiDi) or
  **DWDM/CWDM** properly. Most recommendations are off-the-shelf
  short-range or LR modules.
- It doesn't account for **vendor compatibility lists**. A
  third-party module that's electrically compatible may still be
  rejected by the switch's firmware lock — the advisor flags
  generic options but doesn't predict per-firmware compatibility.

---

## Technical detail (lead view)

### Files

| File | Role |
|---|---|
| `client/src/utils/sfpDatabase.js` | Client-side fetch + cache + offline fallback |
| `client/src/pages/PortsPage.jsx:SfpAdvisor` | The UI card |
| `pipeline/sfp_recommend.py` | Server-side: scrape + search + rank |
| `server/app.js:/api/sfp/analyze` | HTTP endpoint |

### Endpoint

`POST /api/sfp/analyze`:

```json
{
  "vendor": "Mikrotik",
  "model":  "CRS328-24P-4S+RM",
  "interfaces": "sfp+1,sfp+2,sfp+3,sfp+4"   // optional, comma-separated
}
```

Response:

```json
{
  "ok": true,
  "vendor": "Mikrotik",
  "model": "CRS328-24P-4S+RM",
  "slotType": "SFP+",
  "slotInfo": {
    "formFactor": "SFP+",
    "maxSpeed": "10 Gbps",
    "standard": "10GBASE"
  },
  "slotSource": "model-name" | "interface-name" | "scraped",
  "recommended": {
    "partNumber": "SFP-10G-SR",
    "brand": "Cisco",
    "speed": "10G",
    "type": "SR",
    "maxDistance": "300m",
    "wavelength": "850nm",
    "price": "$45.00",
    "sourceUrl": "https://..."
  },
  "budget": {
    "partNumber": "SFP-10GSR-85",
    "brand": "FS.com",
    "price": "$18.50",
    ...
  },
  "modules": [...all candidates...],
  "cables": [
    {"type":"SR","fiber":"OM3/OM4 MMF","connector":"LC-LC Duplex","maxDist":"300m"},
    ...
  ],
  "searchResults": [...source URLs...],
  "productUrl": "https://mikrotik.com/product/crs328-24p-4srm"
}
```

### Slot-type detection

Three stages, in priority:

1. **Scraped from vendor datasheet.** `sfp_recommend.py` calls
   `pipeline.all_vendor.fetch_specs(vendor, model)` and inspects
   the spec dict for any key containing `SFP`, `QSFP`, `Form
   factor`, `Cage type`. Pattern-matches `(SFP|SFP\+|SFP28|QSFP\+|QSFP28|QSFP-DD)`.
2. **Inferred from model name.** Regex against the model string —
   `400G/QSFP-DD`, `100G/QSFP28`, `40G/QSFP+`, `25G/SFP28`,
   `10G/SFP+|XG`, default `SFP`.
3. **Inferred from interface name.** Cisco-style: `Hu` →
   QSFP28, `Fo` → QSFP+, `Twe` → SFP28, `Te` → SFP+, `Gi` → SFP.

The `slotSource` field tells the UI which path was used so the
display can show `(inferred)` vs scraped.

### Module recommendation

`sfp_recommend.py` doesn't ship a hardcoded compatibility table.
Instead:

```
1. Build search queries:
   - "<slot type> compatible <vendor> <model> transceiver"
   - "<slot type> module for <model>"
   - "<slot type> SR LR DAC modules"
2. Run open-web search (`ddgs`)
3. Filter results to known transceiver-vendor domains
   (cisco.com, fs.com, 10gtek.com, finisar.com, etc.) and
   distributor pages (router-switch.com)
4. Scrape each candidate page; extract part numbers + prices +
   specs (speed, type, wavelength, distance)
5. Score by brand authority (Cisco/FS/Finisar = high), price
   availability, spec completeness
6. Pick top as `recommended`, lowest-priced same-spec as `budget`
```

### Offline fallback

`client/src/utils/sfpDatabase.js:generateOfflineFallback()`. When
the server returns a non-OK response or the call times out, the
client renders this client-side using:

- `inferSfpSlotType(interfaces)` — same regex map as above, JS
  port
- `inferFromModelName(vendor, model)` — same idea
- `getCableRecs(slotType)` — IEEE-standard cable types for the
  slot:

  ```js
  CABLE_STANDARDS = {
    SR:  {fiber:'OM3/OM4 MMF', connector:'LC-LC Duplex', maxDist:'300m'},
    LR:  {fiber:'OS2 SMF',     connector:'LC-LC Duplex', maxDist:'10km'},
    DAC: {fiber:'Twinax Copper', connector:'Direct Attach', maxDist:'1-5m'},
    ...
  }
  ```

The offline fallback returns no `modules` list (no specific SKUs
without scraping) — the UI shows the empty-modules state with a
note, plus the cable-type guidance which is engineering fact, not
scraped data.

### Client-side cache + dedupe

`client/src/utils/sfpDatabase.js` has a Map cache + an inflight
dedupe map:

```js
const _sfpAnalysisCache    = new Map();
const _sfpAnalysisInflight = new Map();

function _sfpCacheKey(vendor, model, interfaces) {
  return `${vendor||'Unknown'}|${model||'Unknown'}|${(interfaces||[]).join(',')}`;
}
```

Same `(vendor, model, interfaces)` returns the cached result
synchronously. Concurrent calls with the same key share one
in-flight promise — a tab switch back to Available Ports won't
fire two parallel scrapes.

The cache is session-scoped (cleared on page reload); on-disk
caching for the SFP advisor isn't currently implemented because
results often depend on live transceiver-vendor pricing.

### UI

`client/src/pages/PortsPage.jsx:SfpAdvisor`. Sections:

1. Header — "SFP Procurement Advisor" + AI badge
2. Procurement control — slot type chip, max speed chip, quantity
   selector (defaults to the count of available SFP cages)
3. Primary Recommendation — large module card with brand, part
   number, specs, unit + total cost, "View & Buy" link
4. Budget-Friendly Option — same card pattern
5. Other Compatible Options — collapsible list with up to 12
   alternatives
6. Cable Types — table of compatible cable types for this slot
7. Info section — link to the switch's datasheet, count of
   modules found across N sources

When the server returns `loading`, the section shows a spinner
with `Analyzing<dot dot dot>` text.

### Files in this feature

| File | Role |
|---|---|
| `pipeline/sfp_recommend.py` | Server-side scrape + rank |
| `client/src/utils/sfpDatabase.js` | Client cache, inflight dedupe, offline fallback |
| `client/src/pages/PortsPage.jsx:SfpAdvisor` | UI card |
| `server/app.js:/api/sfp/analyze` | HTTP endpoint |
| `pipeline/all_vendor.py` | Used for slot-type scrape from vendor specs |

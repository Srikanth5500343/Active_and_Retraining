# 07. Switch Information — the Switches tab

## What it does (junior view)

After a rack scan, the **Switches** tab shows one card per detected
switch. Each card has:

- A title with vendor + model (`Mikrotik CRS326-24G-2S+RM`)
- A small **Photo NN%** confidence badge if the data came from the
  rack photo, or **CMDB** if it came from the office database, or
  **Manual entry** if the user typed it in
- The U-position (`U10`)
- A field grid: Vendor / Model / Firmware / Serial / IP / MAC

Tap the card to expand it. The expanded view has three sections:

1. **Identification** — appears only when something is missing.
   Shows what we have and what we don't, with an **Edit** /
   **Add model** / **Add vendor** / **Enter make / model** button
   depending on the situation. Tap → inline editor → save → the
   value flows into the specs and firmware lookups below.
2. **Firmware** — shows current version, latest known version,
   and a CVE count. Status pill says **Up to date**, **Upgrade
   available**, **Upgrade strongly recommended**, or **Couldn't
   read latest — check vendor**.
3. **Specifications** — a table of vendor specs (port count,
   throughput, supported protocols, etc.), pulled live from the
   vendor's product page. Has a **View full details** link to the
   vendor's product page.

The user can correct anything that's wrong: model came back garbled,
firmware version wasn't read, or the OCR identified the vendor but
not the model. Manual entries are persisted per (rack, switch) so
they survive page reloads. A future re-scan that finally reads the
chassis correctly automatically takes precedence over a manual
entry.

## What it doesn't do

- It doesn't currently let the user override the **CV
  classification** (e.g. "this isn't a switch, it's a router"). The
  manual entry is for vendor/model/firmware text only.
- It doesn't sync the manual entry to ServiceNow CMDB automatically.
  The CMDB sync flow is a separate explicit action (see
  [13-cmdb-servicenow.md](13-cmdb-servicenow.md)).

---

## Technical detail (lead view)

### File

[`client/src/pages/SwitchInformationPage.jsx`](../client/src/pages/SwitchInformationPage.jsx)
(~1,100 lines).

Two entry points:
- `<SwitchInfoContent rackId={...} />` — embedded in the Results
  page tabs.
- Default export `SwitchInformationPage` — standalone route at
  `/switch-info`.

Both share `useSwitchData(rackId)` for fetching.

### Data sources, in priority order

1. **CMDB** — `GET /api/cmdb/rack/:rackId/switches`. If a previous
   scan was applied to ServiceNow, this returns the canonical
   record (with manufacturer, model_number, os_version,
   serial_number, mac_address, ip_address). Highest trust.
2. **Per-bbox OCR** — `GET /api/scan/:rackId/ocr-devices`. Falls
   back to this when CMDB is empty for the rack. Each device gets
   a `_fromOcr: true` flag so the SourceBadge can render a
   "Photo" pill.
3. **User overrides** — read from `localStorage` keyed by
   `racktrack:<field>:<rackId>::<stableId>` where
   `stableId = serial > mac > position > name`. Three field
   slots: `make`, `model`, `fwVersion`.

`useSwitchData` merges CMDB + OCR. Inside each card, `effective*`
values combine the pipeline's value with the user override:
`effectiveMake = sw.manufacturer || userMake`. Real CMDB / OCR data
wins over manual entry; manual entry only fills gaps.

### Card states

A card is in one of these states (mutually exclusive, derived from
`effectiveMake` and `effectiveModel`):

| State | Trigger | UI |
|---|---|---|
| `complete` | both make + model present | "Manual entry" badge if user-supplied, else SourceBadge; specs + firmware load on mount |
| `identMissing` | both empty | **"Not detected"** amber badge + **"Enter make / model"** CTA + status line |
| `identIncomplete` | make ✓ model ✗ | **"Model not detected"** badge + **"Add model"** CTA |
| `identIncomplete` | make ✗ model ✓ | **"Vendor not detected"** badge + **"Add vendor"** CTA |
| user-supplied | userMake/userModel set | **"Manual entry"** purple badge + **Edit** link |

The state computation is at `SwitchInformationPage.jsx:240-260`.

### Card auto-loads on mount, not on expand

Earlier behaviour: specs + firmware fired only when the card was
expanded. New behaviour: a `useEffect` at line 326 fires
`loadDetails()` as soon as the card mounts with a resolvable
`(vendor, model)` pair. Together with the prefetcher
(`scanPrefetch`), this means by the time the user taps the card,
specs and firmware are already in memory and render instantly.

### Manual-entry persistence

The override key uses `serial > mac > position > name` so it's
stable across re-scans:

```js
function switchStableId(sw) {
  if (sw.serial_number) return `s:${sw.serial_number}`;
  if (sw.mac_address)   return `m:${sw.mac_address}`;
  if (sw.position)      return `p:${sw.position}`;
  return `n:${sw.name || 'unknown'}`;
}
function userOverrideKey(rackId, sw, field) {
  return `racktrack:${field}:${rackId || '_'}::${switchStableId(sw)}`;
}
```

Saving:

```js
saveOverride(rackId, sw, 'make',  newMake);
saveOverride(rackId, sw, 'model', newModel);
```

The values are read back on every mount via `loadOverride()`. There
is no server-side persistence — manual entry today is purely
local-storage.

### Source badge

`SourceBadge` at `SwitchInformationPage.jsx:148`. Resolves the
`discovery_source` field plus `ocr_conf` into a coloured pill:

| Source | Label | Colour |
|---|---|---|
| `_fromOcr=true` | `Photo NN%` or `From photo` | amber |
| `discovery_source = 'ocr*'` | `Photo NN%` or `From photo` | cyan |
| `'override'` | `Manual` | violet |
| `'synth'` | `Synth` | grey |
| anything else (CMDB) | `CMDB` | green |

`Synth` means the device record was synthesised by
`servicenow/synth.py` — placeholder values inserted to keep the
CMDB consistent when OCR didn't read the chassis but a scan
established the device exists.

### `IdentEditor` component

Lines 838-940. Two text inputs (Make, Model) + Save / Cancel /
Clear. Save button is disabled until both fields have non-empty
text. Enter submits, Escape cancels. The Clear button only shows
when there's an existing override to clear.

After Save, three things happen in order:
1. `userMake` / `userModel` state updates synchronously
2. `saveOverride` writes both to localStorage
3. `setSpecs(null)` / `setFirmware(null)` invalidates cached
   results
4. `setSpecsStatus('idle')` / `setFirmwareStatus('idle')` so the
   `useEffect` re-fires `loadDetails()` against the new values

A `setTimeout(..., 0)` defers the actual `loadDetails()` call by
one tick so the state updates have flushed first.

### Specs + firmware lookup, with cache

`loadDetails(overrideVersion?)` at line 263. Reads the prefetch
cache first; falls back to network on miss. Cache keys:

```js
cacheKey.specs(rackId, vendor, model)
cacheKey.firmware(rackId, vendor, model, version)
```

Both come from `scanPrefetch.js`. After fetch, the result is
written back into the same cache so subsequent visits to the same
card render synchronously.

### Firmware-status headline

The `fwHeadline` derivation at line 425:

```js
const fwHeadline =
  firmware?.upToDate === true ? 'Up to date'
  : firmware?.upToDate === false
    ? (crit > 0 ? 'Upgrade strongly recommended' : 'Upgrade available')
    : firmware?.releaseNotesUrl
      ? "Couldn't read latest — check vendor"
      : "Couldn't reach vendor right now";
```

The two "Couldn't" branches are deliberately distinct: if the
scraper found a release-notes page but no version, we link to it
so the user can verify themselves; if we couldn't even find a
release-notes page, we say so.

### Backend-noise filter

`looksLikeBackendNoise` at line 124. Hides developer-facing
strings that occasionally slip through the server's friendly
wrapper:

```js
m.includes('expecting value') ||
m.includes('traceback') ||
m.includes('jsondecode') ||
m.includes('line 1 column') ||
m.startsWith('http ') ||
m.includes('econnrefused') ||
m.includes('etimedout') ||
m.includes('pipeline.') ||      // catches "pipeline.all_vendor timed out"
m.includes('timed out') ||
m.includes('spawn ') ||
m.includes('python exited') ||
m.includes('exit code')
```

When this returns `true`, the UI shows a friendly fallback
("Couldn't load specs") instead of the raw error.

### What flows from this page into other parts of the app

- **Specs lookup** — `POST /api/specs` with `{vendor, model}` →
  scrape vendor page → return spec table. See
  [09-specifications.md](09-specifications.md).
- **Firmware/CVE lookup** — `POST /api/firmware` with
  `{vendor, model, currentVersion}` → scrape release notes + query
  NVD for CVEs. See [08-firmware.md](08-firmware.md).
- **CMDB sync** — manual entries don't auto-flow to CMDB. The user
  has to explicitly trigger CMDB sync from the Overview tab. See
  [13-cmdb-servicenow.md](13-cmdb-servicenow.md).

### Files in this feature

| File | Role |
|---|---|
| `client/src/pages/SwitchInformationPage.jsx` | Main UI |
| `client/src/utils/scanPrefetch.js` | Prefetch coordinator (caches specs/firmware) |
| `server/app.js:3296 /api/specs/vendors` | Vendor list for autocomplete |
| `server/app.js:3304 /api/specs` | Specs lookup endpoint |
| `server/app.js:3336 /api/firmware` | Firmware/CVE lookup endpoint |
| `pipeline/all_vendor.py` | Spec scraper |
| `pipeline/firmware_check.py` | Firmware + CVE check |

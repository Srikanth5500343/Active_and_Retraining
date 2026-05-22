// Scan prefetch coordinator — fires every per-rack data fetch the moment
// the analyze succeeds, so that by the time the user lands on the
// Overview / Ports / Topology / Switches tabs, the data is already in
// memory and the cards render instantly.
//
// Architecture:
//   1. prefetchScan(rackId) — fire once from ScanPage.jsx after the
//      analyze succeeds. Idempotent — calling twice for the same rackId
//      is a no-op.
//   2. Each prefetch step writes into the shared cache (Map<key,Promise>).
//   3. Data-consuming pages call getCached(key) for instant access; if
//      the cache miss, they fall back to their existing fetch.
//
// All prefetches are best-effort and silent — failures don't propagate
// to the user. The fallback fetch on the consuming page handles errors.

import { apiUrl, authFetch } from './api';

// rackId -> { startedAt, cache: Map<key, Promise<any>> }
const _scans = new Map();
// Module-level cache of resolved values (separate from inflight promises
// so we can synchronously return cached data without re-awaiting).
const _values = new Map();

function _key(rackId, kind, ...parts) {
  return [rackId, kind, ...parts].join('::');
}

/**
 * Synchronously look up a previously-prefetched value.
 * Returns null if not yet cached. Pages should treat this as an
 * optimization — always have a fallback fetch path.
 */
export function getCached(key) {
  return _values.has(key) ? _values.get(key) : null;
}

export function setCached(key, value) {
  _values.set(key, value);
}

/**
 * Wait for a prefetch to resolve. Returns null if the prefetch hasn't
 * been initiated. Useful when a page wants to use prefetched data when
 * available but is willing to wait the same amount of time it'd wait on
 * its own fetch.
 */
export function awaitCached(key) {
  if (_values.has(key)) return Promise.resolve(_values.get(key));
  for (const scan of _scans.values()) {
    if (scan.cache.has(key)) return scan.cache.get(key);
  }
  return Promise.resolve(null);
}

// ── Prefetch primitives ────────────────────────────────────────────

async function _fetchJson(url, init) {
  try {
    const r = await authFetch(apiUrl(url), init);
    if (!r.ok) return null;
    const text = await r.text();
    try { return text ? JSON.parse(text) : null; } catch { return null; }
  } catch (_) {
    return null;
  }
}

// Like _fetchJson but reports HTTP status separately so callers can
// distinguish "not there yet, retry" (404) from "succeeded but body
// was empty/non-JSON" (return null but ok=true).
async function _fetchJsonWithStatus(url, init) {
  try {
    const r = await authFetch(apiUrl(url), init);
    if (!r.ok) return { ok: false, status: r.status, data: null };
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    return { ok: true, status: r.status, data };
  } catch (_) {
    return { ok: false, status: 0, data: null };
  }
}

// Session-level memory of racks we've already given up on. If a rack
// produces MAX_404 consecutive misses on one page-load, every subsequent
// prefetch in this tab returns immediately. Without this, navigating
// between rack pages restarts the poll and the server gets hammered with
// 404s for racks that genuinely don't have OCR (legacy folders without
// an original_image, or scans where ocr_devices failed silently).
const _ocrGaveUp = new Set();

export function _markOcrUnavailable(rackId) { _ocrGaveUp.add(rackId); }
export function _clearOcrGiveUp(rackId) { _ocrGaveUp.delete(rackId); }

// Poll the ocr_devices.json endpoint until it returns 200. The server-
// side scheduleOcrDevices fires after analyze; we wait for the result so
// downstream specs/firmware prefetches can use the resolved make/model.
//
// Backoff: 404 means OCR hasn't finished yet (or was never scheduled).
// Bail after MAX_404_BEFORE_GIVE_UP consecutive misses, which still
// gives ~16s of grace for a fresh OCR run, then stop polling permanently
// for this rack until the page is reloaded.
async function _waitForOcr(rackId, { maxMs = 180_000, intervalMs = 2_000 } = {}) {
  if (_ocrGaveUp.has(rackId)) return null;
  const MAX_404_BEFORE_GIVE_UP = 8;
  const deadline = Date.now() + maxMs;
  let consecutive404 = 0;
  while (Date.now() < deadline) {
    if (_ocrGaveUp.has(rackId)) return null;
    const res = await _fetchJsonWithStatus(
      `/api/scan/${encodeURIComponent(rackId)}/ocr-devices`);
    if (res.ok && res.data && Array.isArray(res.data.devices)) return res.data;
    if (res.status === 404) {
      consecutive404++;
      if (consecutive404 >= MAX_404_BEFORE_GIVE_UP) {
        _ocrGaveUp.add(rackId);
        return null;
      }
    } else {
      consecutive404 = 0;
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return null;
}

// ── Per-step prefetches ────────────────────────────────────────────

function _prefetchScanResult(rackId, scan) {
  const key = _key(rackId, 'scanResult');
  const p = _fetchJson(`/api/scan/${encodeURIComponent(rackId)}/result`)
    .then(d => { if (d) _values.set(key, d); return d; });
  scan.cache.set(key, p);
}

function _prefetchTopology(rackId, scan) {
  const key = _key(rackId, 'topology');
  const p = _fetchJson(`/api/topology/${encodeURIComponent(rackId)}`)
    .then(d => { if (d) _values.set(key, d); return d; });
  scan.cache.set(key, p);
}

function _prefetchOcrDevices(rackId, scan) {
  const key = _key(rackId, 'ocrDevices');
  const p = _waitForOcr(rackId).then(d => { if (d) _values.set(key, d); return d; });
  scan.cache.set(key, p);
  return p;
}

function _prefetchCmdb(rackId, scan) {
  const key = _key(rackId, 'cmdb');
  const p = _fetchJson(`/api/cmdb/rack/${encodeURIComponent(rackId)}/switches`)
    .then(d => { if (d) _values.set(key, d); return d; });
  scan.cache.set(key, p);
}

// Specs lookup per (vendor, model). Cached server-side via the
// /api/specs endpoint's own cache; we cache the response client-side too
// so the SwitchInformationPage card can render instantly.
function _prefetchSpecs(rackId, vendor, model, scan) {
  if (!vendor || !model) return;
  const key = _key(rackId, 'specs', vendor, model);
  if (scan.cache.has(key)) return; // already prefetching
  const p = _fetchJson('/api/specs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vendor, model }),
  }).then(d => { if (d) _values.set(key, d); return d; });
  scan.cache.set(key, p);
}

function _prefetchFirmware(rackId, vendor, model, version, scan) {
  if (!vendor || !model || !version) return;
  const key = _key(rackId, 'firmware', vendor, model, version);
  if (scan.cache.has(key)) return;
  const p = _fetchJson('/api/firmware', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vendor, model, currentVersion: version }),
  }).then(d => { if (d) _values.set(key, d); return d; });
  scan.cache.set(key, p);
}

function _prefetchSfp(rackId, vendor, model, ifaces, scan) {
  if (!vendor || !model || !ifaces || ifaces.length === 0) return;
  const key = _key(rackId, 'sfp', vendor, model, ifaces.join(','));
  if (scan.cache.has(key)) return;
  const p = _fetchJson('/api/sfp/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vendor, model, interfaces: ifaces.join(',') }),
  }).then(d => { if (d) _values.set(key, d); return d; });
  scan.cache.set(key, p);
}

// Fan-out prefetches that depend on OCR resolving first (we need vendor +
// model per device, plus the SFP port list, before we can ask vendor
// servers for specs/firmware/SFP recommendations).
async function _prefetchOcrDependents(rackId, scan) {
  const ocr = await scan.cache.get(_key(rackId, 'ocrDevices'));
  if (!ocr || !Array.isArray(ocr.devices)) return;

  // Per-device specs + firmware. Limit concurrency implicitly via the
  // server's request handling — we kick all in parallel and let them
  // queue up server-side.
  for (const dev of ocr.devices) {
    if (dev.make && dev.model) {
      _prefetchSpecs(rackId, dev.make, dev.model, scan);
    }
    if (dev.make && dev.model && dev.version) {
      _prefetchFirmware(rackId, dev.make, dev.model, dev.version, scan);
    }
  }

  // SFP advisor: identify the primary switch and prefetch SFP analysis.
  const primarySwitch = ocr.devices.find(d => d.class_name === 'Switch' && d.make);
  if (primarySwitch) {
    // We need the SFP port interfaces — those come from the SSH probe,
    // not OCR. The probe is already running (kicked off in ScanPage via
    // triggerBackgroundProbe). We can't reliably prefetch SFP analysis
    // here without that info; instead we just warm the cache from the
    // first scan_result fetch. The PortsPage's existing fetchSfpAnalysis
    // already has its own session cache and inflight dedupe.
  }
}

// ── Public entry point ─────────────────────────────────────────────

/**
 * Kick off all per-rack prefetches in the background. Idempotent.
 * Call this immediately after /api/analyze returns successfully so that
 * by the time the user navigates to /results and clicks through tabs,
 * every panel's data is already loaded (or close to it).
 */
export function prefetchScan(rackId) {
  if (!rackId) return;
  if (_scans.has(rackId)) return;

  const scan = { startedAt: Date.now(), cache: new Map() };
  _scans.set(rackId, scan);

  // Independent fetches — fire all at once, no dependencies.
  _prefetchScanResult(rackId, scan);
  _prefetchTopology(rackId, scan);
  _prefetchCmdb(rackId, scan);

  // OCR is the slow path (~30-60s on CPU). Kick it; downstream specs +
  // firmware fan out once it resolves.
  const ocrPromise = _prefetchOcrDevices(rackId, scan);
  ocrPromise.then(() => _prefetchOcrDependents(rackId, scan));
}

// Helpers for components to compose with the cache. The page-side
// "useXxx" hooks call these to skip the network when prefetched data
// exists.
export const cacheKey = {
  scanResult: (rackId) => _key(rackId, 'scanResult'),
  topology:   (rackId) => _key(rackId, 'topology'),
  ocrDevices: (rackId) => _key(rackId, 'ocrDevices'),
  cmdb:       (rackId) => _key(rackId, 'cmdb'),
  specs:      (rackId, vendor, model) => _key(rackId, 'specs', vendor, model),
  firmware:   (rackId, vendor, model, version) => _key(rackId, 'firmware', vendor, model, version),
  sfp:        (rackId, vendor, model, ifaces) => _key(rackId, 'sfp', vendor, model, (ifaces || []).join(',')),
};

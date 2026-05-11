// ── SFP Procurement Engine ──────────────────────────────────
// Dynamic analysis: scrapes vendor datasheets and searches the web for
// compatible SFP modules. NO hardcoded switch-to-SFP mapping.
//
// Flow:
//   1. Calls POST /api/sfp/analyze with vendor + model + interface names
//   2. Server scrapes the vendor's datasheet to determine SFP slot type
//   3. Server searches the web for compatible transceiver modules
//   4. Returns structured recommendations from LIVE data
//
// Client-side inference is kept ONLY as an offline fallback when the
// server is unreachable.

import { apiUrl, authFetch } from './api';

// ── SFP Standards (IEEE / MSA — engineering facts, not "static data") ─
export const SFP_SLOT_TYPES = {
  SFP:       { formFactor: 'SFP',      maxSpeed: '1 Gbps',   standard: '1000BASE-X' },
  'SFP+':    { formFactor: 'SFP+',     maxSpeed: '10 Gbps',  standard: '10GBASE' },
  SFP28:     { formFactor: 'SFP28',    maxSpeed: '25 Gbps',  standard: '25GBASE' },
  'QSFP+':   { formFactor: 'QSFP+',    maxSpeed: '40 Gbps',  standard: '40GBASE' },
  QSFP28:    { formFactor: 'QSFP28',   maxSpeed: '100 Gbps', standard: '100GBASE' },
  'QSFP-DD': { formFactor: 'QSFP-DD',  maxSpeed: '400 Gbps', standard: '400GBASE' },
};

// Cable standards — physics, not static data.
const CABLE_STANDARDS = {
  SR:   { fiber: 'OM3/OM4 MMF',  connector: 'LC-LC Duplex',  maxDist: '300m' },
  SX:   { fiber: 'OM3/OM4 MMF',  connector: 'LC-LC Duplex',  maxDist: '550m' },
  LR:   { fiber: 'OS2 SMF',      connector: 'LC-LC Duplex',  maxDist: '10km' },
  LX:   { fiber: 'OS2 SMF',      connector: 'LC-LC Duplex',  maxDist: '10km' },
  SR4:  { fiber: 'OM3/OM4 MMF',  connector: 'MPO-12 Trunk',  maxDist: '150m' },
  LR4:  { fiber: 'OS2 SMF',      connector: 'LC-LC Duplex',  maxDist: '10km' },
  T:    { fiber: 'Copper Cat6a',  connector: 'RJ45',          maxDist: '30-100m' },
  DAC:  { fiber: 'Twinax Copper', connector: 'Direct Attach', maxDist: '1-5m' },
};


// ── Offline fallback: infer SFP type from interface names ────
export function inferSfpSlotType(interfaces) {
  if (!interfaces?.length) return 'SFP';
  for (const iface of interfaces) {
    if (/^Hu/i.test(iface))  return 'QSFP28';
    if (/^Fo/i.test(iface))  return 'QSFP+';
    if (/^Twe/i.test(iface)) return 'SFP28';
    if (/^Te/i.test(iface))  return 'SFP+';
    if (/^Gi/i.test(iface))  return 'SFP';
    if (/^Fa/i.test(iface))  return 'SFP';
  }
  return 'SFP';
}

function inferFromModelName(vendor, model) {
  const s = `${vendor || ''} ${model || ''}`;
  if (/400G|QSFP-DD/i.test(s))          return 'QSFP-DD';
  if (/100G|QSFP28/i.test(s))           return 'QSFP28';
  if (/40G|QSFP\+?(?!28|DD)/i.test(s))  return 'QSFP+';
  if (/25G|SFP28/i.test(s))             return 'SFP28';
  if (/10G|SFP\+|XG/i.test(s))          return 'SFP+';
  return null;
}


// ── Dynamic API call ─────────────────────────────────────────

/**
 * Fetch dynamic SFP recommendations from the server.
 * The server scrapes vendor datasheets + searches the web — no hardcoded DB.
 *
 * @param {string} vendor  - Switch vendor (e.g. "TP-Link")
 * @param {string} model   - Switch model (e.g. "TL-SG2428P")
 * @param {string[]} interfaces - SFP interface names from the SSH probe
 * @returns {Promise<object>} - Structured recommendation or null
 */
// In-memory cache so navigating away/back doesn't trigger another scrape.
// Keyed by vendor+model+interfaces — the same inputs always produce the
// same recommendation, so a session-scoped cache is safe. Cleared on full
// page reload, which is the right scope for this kind of advisory data.
const _sfpAnalysisCache = new Map();
const _sfpAnalysisInflight = new Map();

function _sfpCacheKey(vendor, model, interfaces) {
  return `${vendor || 'Unknown'}|${model || 'Unknown'}|${(interfaces || []).join(',')}`;
}

export async function fetchSfpAnalysis(vendor, model, interfaces = []) {
  const key = _sfpCacheKey(vendor, model, interfaces);
  if (_sfpAnalysisCache.has(key)) return _sfpAnalysisCache.get(key);
  if (_sfpAnalysisInflight.has(key)) return _sfpAnalysisInflight.get(key);

  const promise = (async () => {
    try {
      const r = await authFetch(apiUrl('/api/sfp/analyze'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vendor: vendor || 'Unknown',
          model: model || 'Unknown',
          interfaces: interfaces.join(','),
        }),
      });
      const data = await r.json();
      if (data?.ok) {
        _sfpAnalysisCache.set(key, data);
        return data;
      }
      return null;
    } catch (_) {
      return null;
    } finally {
      _sfpAnalysisInflight.delete(key);
    }
  })();
  _sfpAnalysisInflight.set(key, promise);
  return promise;
}


// ── Offline fallback recommendation ──────────────────────────
// Used ONLY when the server is unreachable (no network, server down).
// Returns slot-type and cable guidance (engineering facts) but NO modules —
// without live scraping we have no honest way to recommend a specific SKU,
// and a baked-in list would be exactly the static/generic fallback we want
// to avoid. The UI shows the empty / "no results" state instead.

function getCableRecs(slotType) {
  const typeMap = {
    SFP:        ['SX', 'LX', 'T'],
    'SFP+':     ['SR', 'LR', 'T', 'DAC'],
    SFP28:      ['SR', 'LR', 'DAC'],
    'QSFP+':    ['SR4', 'LR4', 'DAC'],
    QSFP28:     ['SR4', 'LR4', 'DAC'],
    'QSFP-DD':  ['DR4', 'LR4'],
  };
  const types = typeMap[slotType] || ['SR', 'LR'];
  return types
    .map(t => CABLE_STANDARDS[t] ? { type: t, ...CABLE_STANDARDS[t] } : null)
    .filter(Boolean);
}

export function generateOfflineFallback({ vendor, model, sfpPorts }) {
  const ifaces = sfpPorts?.map(p => p.iface) || [];
  let slotType = inferFromModelName(vendor, model);
  let slotSource = slotType ? 'model-name' : null;

  if (!slotType) {
    slotType = inferSfpSlotType(ifaces);
    slotSource = 'interface-name';
  }

  const slotInfo = SFP_SLOT_TYPES[slotType] || SFP_SLOT_TYPES['SFP'];
  const cables = getCableRecs(slotType);

  return {
    ok: true,
    offline: true,
    vendor: vendor || 'Unknown',
    model: model || 'Unknown',
    slotType,
    slotSource,
    slotInfo,
    modules: [],
    recommended: null,
    budget: null,
    cables,
    searchResults: [],
    sourceUrls: [],
    moduleTypes: cables.map(c => c.type),
  };
}

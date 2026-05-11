import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import styles from './SpecificationsPage.module.css';
import ThemeToggle from '../components/ThemeToggle.jsx';
import { apiUrl, authFetch } from '../utils/api';
import { useTheme } from '../ThemeContext.jsx';
import { getCached, setCached, cacheKey } from '../utils/scanPrefetch';

// CMDB-driven switch info. Reads the list of switches stored in CMDB for
// this rack, and on demand fetches vendor specs + firmware-update info per
// device. Distinct from the live SSH "Switch Info" modal in port mode —
// that one talks directly to the device; this one trusts what's in CMDB.

// Map common CMDB manufacturer strings to the display name in the
// vendor-spec Excel sheet so /api/specs matches.
function vendorFromCmdb(manufacturer, model) {
  const m = (manufacturer || '').toLowerCase();
  if (m.includes('cisco'))   return 'Cisco';
  if (m.includes('tp-link') || m.includes('tplink')) return 'TP-Link';
  if (m.includes('d-link')   || m.includes('dlink')) return 'D-Link';
  if (m.includes('juniper')) return 'Juniper';
  if (m.includes('aruba'))   return 'Aruba';
  if (m.includes('arista'))  return 'Arista';
  if (m.includes('huawei'))  return 'Huawei';
  if (m.includes('dell'))    return 'Dell';
  if (m.includes('hpe') || m.includes('hewlett')) return 'HPE';
  // Last-ditch: guess from the model number prefix.
  const mod = (model || '').toUpperCase();
  if (mod.startsWith('C9') || mod.startsWith('WS-C')) return 'Cisco';
  if (mod.startsWith('TL-'))                          return 'TP-Link';
  if (mod.startsWith('DGS-') || mod.startsWith('DXS-')) return 'D-Link';
  return manufacturer || '';
}

// Client-side fallback: extract model number from raw OCR text when the
// pipeline returned make but missed the model (e.g. underscore/hyphen misread).
function extractModelFromRaw(rawText, make) {
  if (!rawText) return '';
  // Normalize underscores → hyphens (same logic as pipeline fix)
  const norm = rawText.replace(/[_][-]|[-][_]/g, '-').replace(/(?<=[A-Za-z0-9])_(?=[A-Za-z0-9])/g, '-');
  const patterns = [
    /\b(?:WS-C|C)\d{4,5}[A-Z]*-\d{1,3}[A-Z]{0,4}(?:-\w{1,4})?\b/,  // Cisco
    /\bTL-[A-Z]{2,4}\d{3,5}[A-Z]{0,4}\b/,                            // TP-Link
    /\bT[1-9]\d{2,3}[A-Z]{0,4}\b/,                                    // TP-Link JetStream
    /\bD[GX]S-\d{3,4}[A-Z]?-\d{1,3}[A-Z]{0,4}\b/,                   // D-Link
    /\b(?:EX|QFX|MX|SRX)\d{3,5}[A-Z0-9-]*\b/,                       // Juniper
    /\bCX\s?\d{4}[A-Z]?\b/,                                           // Aruba
    /\b(?:DCS-)?7\d{3}[A-Z]?-\d{1,3}[A-Z0-9-]*\b/,                  // Arista
    /\b(?:CRS|CCR)\d{3,4}(?:-[\w+]{1,12})*\b/i,                      // Mikrotik
  ];
  for (const rx of patterns) {
    const m = norm.match(rx);
    if (m) return m[0].toUpperCase();
  }
  // Fuzzy fallback for Mikrotik: OCR often garbles CRS→CAS/CR5/@R5 etc.
  // Look for patterns like *RS3xx or *RS1xx followed by dash-separated suffixes
  if (make && make.toLowerCase().includes('mikro')) {
    const fuzzy = norm.match(/[A-Z@][A-Z]*[RS]\d{3,4}(?:-[\w+]{1,12})*/i);
    if (fuzzy) {
      // Try to reconstruct: assume CRS or CCR prefix
      const raw = fuzzy[0];
      const digits = raw.match(/\d{3,4}(?:-[\w+]{1,12})*/);
      if (digits) {
        const prefix = raw.toLowerCase().includes('ccr') ? 'CCR' : 'CRS';
        return prefix + digits[0].toUpperCase();
      }
    }
  }
  return '';
}

// Expand known partial OCR model fragments to full model numbers.
// Mirrors the _FUZZY_MODEL_DB in pipeline/all_vendor.py.
const PARTIAL_MODEL_MAP = [
  // MikroTik
  [/^CRS3265?$/i,   'CRS326-24G-2S+RM'],
  [/^CRS3261?$/i,   'CRS326-24G-2S+RM'],
  [/^CRS3541?/i,    'CRS354-48G-4S+2Q+RM'],
  [/^CRS3121?/i,    'CRS312-4C+8XG-RM'],
  [/^CRS3171?/i,    'CRS317-1G-16S+RM'],
  [/^CRS3051?/i,    'CRS305-1G-4S+IN'],
  [/^CRS3281?/i,    'CRS328-24P-4S+RM'],
  [/^CRS5181?/i,    'CRS518-16XS-2XQ-RM'],
  [/^CCR20041?/i,   'CCR2004-1G-12S+2XS'],
  [/^CCR20161?/i,   'CCR2016-1G-12S+2XS'],
  // Cisco
  [/^C93001?$/i,    'C9300-24T'],
  [/^C93004?$/i,    'C9300-48T'],
  [/^C93002?$/i,    'C9300-24P'],
  [/^C93006?$/i,    'C9300-48P'],
  // TP-Link
  [/^TLSG24281?/i,  'TL-SG2428P'],
];

function expandPartialModel(model) {
  if (!model) return model;
  // Only try to expand if it looks partial: no hyphens and short, or ends with 1-2 digits
  const looksPartial = (!model.includes('-') && !model.includes('+') && model.length < 12)
    || /[A-Z]\d{1,2}$/i.test(model);
  if (!looksPartial) return model;
  for (const [rx, full] of PARTIAL_MODEL_MAP) {
    if (rx.test(model)) return full;
  }
  return model;
}

function cleanModel(m) {
  if (!m) return '';
  return String(m).trim().replace(/\s+v?\d+(?:\.\d+){0,2}\s*$/i, '').trim();
}

// Pull a clean dotted version out of messy firmware strings.
function cleanVersion(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  const nx = s.match(/\b\d+\.\d+\([^)]+\)(?:[A-Z]\d+(?:\([^)]+\))?)?/);
  if (nx) return nx[0];
  const dotted = s.match(/\b\d+\.\d+(?:\.\d+){0,3}(?:[A-Za-z][A-Za-z0-9]{0,5})?(?:-[A-Za-z0-9]{1,8})?\b/);
  return dotted ? dotted[0] : s;
}

// Spot raw Python tracebacks / JSONDecodeError text leaking from the
// backend so we can hide them behind a friendly empty state rather than
// dumping them in the UI. The user shouldn't have to read "Expecting
// value: line 1 column 1 (char 0)" — that's a backend signal, not a
// user-actionable message.
function looksLikeBackendNoise(msg) {
  if (!msg || typeof msg !== 'string') return false;
  const m = msg.toLowerCase();
  return (
    m.includes('expecting value') ||
    m.includes('traceback') ||
    m.includes('jsondecode') ||
    m.includes('line 1 column') ||
    m.startsWith('http ') ||
    m.includes('econnrefused') ||
    m.includes('etimedout') ||
    // Catch anything that looks like a Python module / dotted path or
    // a stray "X timed out" message — those are developer-facing
    // strings that occasionally slip through the server's friendly
    // wrapper and shouldn't reach end users.
    m.includes('pipeline.') ||
    m.includes('timed out') ||
    m.includes('spawn ') ||
    m.includes('python exited') ||
    m.includes('exit code')
  );
}

function SourceBadge({ sw }) {
  const source = sw.discovery_source || '';
  const conf = sw.ocr_conf != null ? Math.round(sw.ocr_conf * 100) : null;

  let label, bg, color;
  if (sw._fromOcr) {
    // From the rack photo — confidence shown when available.
    label = conf != null ? `Photo ${conf}%` : 'From photo';
    bg = 'rgba(251,191,36,0.15)';
    color = '#fbbf24';
  } else if (source.startsWith('ocr')) {
    label = conf != null ? `Photo ${conf}%` : 'From photo';
    bg = 'rgba(34,211,238,0.12)';
    color = '#22d3ee';
  } else if (source === 'override') {
    label = 'Manual';
    bg = 'rgba(168,85,247,0.12)';
    color = '#a855f7';
  } else if (source === 'synth') {
    label = 'Synth';
    bg = 'rgba(148,163,184,0.12)';
    color = '#94a3b8';
  } else {
    label = 'CMDB';
    bg = 'rgba(52,211,153,0.12)';
    color = '#34d399';
  }

  return (
    <span style={{
      fontSize: '.6rem', fontWeight: 600, textTransform: 'uppercase',
      letterSpacing: '.04em', padding: '2px 6px', borderRadius: 4,
      background: bg, color,
    }}>
      {label}
    </span>
  );
}

// Stable per-switch identifier for localStorage keys. Uses serial > mac >
// position as the primary key — deliberately NOT manufacturer/model
// because those are exactly the fields the user can override, and the
// key needs to be stable across edits so a saved override survives a
// re-scan that returns different OCR text.
function switchStableId(sw) {
  if (sw.serial_number) return `s:${sw.serial_number}`;
  if (sw.mac_address)   return `m:${sw.mac_address}`;
  if (sw.position)      return `p:${sw.position}`;
  // Last-ditch fallback — at least pin to the original (CV-derived) name
  // so multiple unidentified devices at the same scan don't collide.
  return `n:${sw.name || 'unknown'}`;
}

function userOverrideKey(rackId, sw, field) {
  return `racktrack:${field}:${rackId || '_'}::${switchStableId(sw)}`;
}
function loadOverride(rackId, sw, field) {
  try { return localStorage.getItem(userOverrideKey(rackId, sw, field)) || ''; }
  catch { return ''; }
}
function saveOverride(rackId, sw, field, value) {
  try {
    const k = userOverrideKey(rackId, sw, field);
    if (value) localStorage.setItem(k, value);
    else localStorage.removeItem(k);
  } catch (_) {}
}

// Backwards-compat helpers for the existing firmware-version override.
function loadUserVersion(rackId, sw)        { return loadOverride(rackId, sw, 'fwVersion'); }
function saveUserVersion(rackId, sw, value) { saveOverride(rackId, sw, 'fwVersion', value); }

function SwitchCard({ sw, rackId }) {
  const { theme } = useTheme();
  const lt = theme === 'light';

  const [expanded, setExpanded] = useState(false);
  const [specs, setSpecs] = useState(null);
  const [specsStatus, setSpecsStatus] = useState('idle');
  const [firmware, setFirmware] = useState(null);
  const [firmwareStatus, setFirmwareStatus] = useState('idle');

  // User-supplied overrides — used when OCR / CMDB didn't capture the
  // value. Persisted per switch (keyed by serial > mac > position) so
  // they survive reloads and aren't disturbed by a re-scan that returns
  // different OCR text. Empty string means "not set".
  const [userMake, setUserMake]       = useState(() => loadOverride(rackId, sw, 'make'));
  const [userModel, setUserModel]     = useState(() => loadOverride(rackId, sw, 'model'));
  const [userVersion, setUserVersion] = useState(() => loadUserVersion(rackId, sw));
  const [editingIdent, setEditingIdent] = useState(false);
  const [identDraftMake,  setIdentDraftMake]  = useState('');
  const [identDraftModel, setIdentDraftModel] = useState('');
  const [editingVersion, setEditingVersion] = useState(false);
  const [versionDraft, setVersionDraft] = useState('');

  // Effective values: user override wins over OCR/CMDB. This means a user
  // who corrects OCR garbage gets the corrected value flowing into the
  // specs / firmware lookups below.
  const effectiveMake  = sw.manufacturer || userMake;
  const effectiveModel = sw.model_number || userModel;
  const makeIsUserSupplied  = !sw.manufacturer && !!userMake;
  const modelIsUserSupplied = !sw.model_number && !!userModel;

  const displayVendor = vendorFromCmdb(effectiveMake, effectiveModel);
  const lookupModel = cleanModel(effectiveModel);
  const effectiveVersionRaw = sw.os_version || userVersion;
  const lookupVersion = cleanVersion(effectiveVersionRaw);
  const versionIsUserSupplied = !sw.os_version && !!userVersion;

  // OCR/CMDB returned nothing for either field — surface the editor as
  // the primary call-to-action instead of a tiny "edit" affordance.
  const identMissing = !effectiveMake && !effectiveModel;
  // OCR got vendor but missed model (the common case after fuzzy-match
  // recovery) or vice-versa. Still surface the editor, just less
  // prominently — the user requested manual entry whenever the pipeline
  // failed on *either* field, not just both.
  const identIncomplete = !identMissing && (!effectiveMake || !effectiveModel);

  const loadDetails = async (overrideVersion) => {
    if (!displayVendor || !lookupModel) {
      setSpecsStatus('skipped');
      setFirmwareStatus('skipped');
      return;
    }
    const versionForLookup = overrideVersion != null
      ? cleanVersion(overrideVersion)
      : lookupVersion;

    // Check the prefetch cache first — if scanPrefetch already populated
    // this (vendor, model) pair, render synchronously and skip the network.
    const specsCached = rackId ? getCached(cacheKey.specs(rackId, displayVendor, lookupModel)) : null;
    if (specsCached) {
      setSpecs(specsCached);
      setSpecsStatus(specsCached.ok ? 'ready' : 'error');
    } else {
      setSpecsStatus(prev => prev === 'ready' ? prev : 'loading');
    }

    const firmwareCached = (rackId && versionForLookup)
      ? getCached(cacheKey.firmware(rackId, displayVendor, lookupModel, versionForLookup))
      : null;
    if (firmwareCached) {
      if (firmwareCached.ok) { setFirmware(firmwareCached); setFirmwareStatus('ready'); }
      else { setFirmwareStatus('error'); }
    } else {
      setFirmwareStatus(versionForLookup ? 'loading' : 'skipped');
    }

    if (!specsCached && specsStatus !== 'ready') {
      authFetch(apiUrl('/api/specs'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vendor: displayVendor, model: lookupModel }),
      }).then(async r => {
        const text = await r.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch {}
        if (data && data.ok) {
          setSpecs(data); setSpecsStatus('ready');
          if (rackId) setCached(cacheKey.specs(rackId, displayVendor, lookupModel), data);
        } else {
          setSpecs(data); setSpecsStatus('error');
        }
      }).catch(() => setSpecsStatus('error'));
    }

    if (!firmwareCached && versionForLookup) {
      authFetch(apiUrl('/api/firmware'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vendor: displayVendor, model: lookupModel, currentVersion: versionForLookup }),
      }).then(async r => {
        const text = await r.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch {}
        if (data && data.ok) {
          setFirmware(data); setFirmwareStatus('ready');
          if (rackId) setCached(cacheKey.firmware(rackId, displayVendor, lookupModel, versionForLookup), data);
        } else {
          setFirmwareStatus('error');
        }
      }).catch(() => setFirmwareStatus('error'));
    }
  };

  // Auto-fire details on mount (rather than waiting for expand) — the
  // prefetcher has already done the network work, so this just wires the
  // cached payload into the card's render state. If the cache misses,
  // it falls back to the same on-mount fetch a one-time visit would do.
  useEffect(() => {
    if (displayVendor && lookupModel && specsStatus === 'idle') {
      loadDetails();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayVendor, lookupModel]);

  const onToggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && specsStatus === 'idle' && firmwareStatus === 'idle') loadDetails();
  };

  const startEditVersion = () => {
    setVersionDraft(userVersion || '');
    setEditingVersion(true);
  };
  const cancelEditVersion = () => {
    setEditingVersion(false);
    setVersionDraft('');
  };
  const saveVersion = () => {
    const v = versionDraft.trim();
    setUserVersion(v);
    saveUserVersion(rackId, sw, v);
    setEditingVersion(false);
    setVersionDraft('');
    setFirmware(null);
    setFirmwareStatus(v ? 'loading' : 'skipped');
    if (v) loadDetails(v);
  };
  const clearVersion = () => {
    setUserVersion('');
    saveUserVersion(rackId, sw, '');
    setEditingVersion(false);
    setVersionDraft('');
    setFirmware(null);
    setFirmwareStatus('skipped');
  };

  // Make/model editor — used when OCR couldn't pin down vendor or model.
  // Saving triggers a fresh specs/firmware lookup against the new values.
  const startEditIdent = () => {
    setIdentDraftMake(userMake || sw.manufacturer || '');
    setIdentDraftModel(userModel || sw.model_number || '');
    setEditingIdent(true);
  };
  const cancelEditIdent = () => {
    setEditingIdent(false);
    setIdentDraftMake('');
    setIdentDraftModel('');
  };
  const saveIdent = () => {
    const newMake  = identDraftMake.trim();
    const newModel = identDraftModel.trim();
    setUserMake(newMake);
    setUserModel(newModel);
    saveOverride(rackId, sw, 'make',  newMake);
    saveOverride(rackId, sw, 'model', newModel);
    setEditingIdent(false);
    setIdentDraftMake('');
    setIdentDraftModel('');
    // New values invalidate any cached spec/firmware results — re-fetch.
    setSpecs(null);
    setSpecsStatus('idle');
    setFirmware(null);
    setFirmwareStatus('idle');
    if (newMake && newModel && expanded) {
      // Trigger fresh lookup with the new values; loadDetails reads
      // displayVendor/lookupModel from state which won't have updated
      // yet, so pass the values explicitly via a microtask.
      setTimeout(() => loadDetails(), 0);
    }
  };
  const clearIdent = () => {
    setUserMake('');
    setUserModel('');
    saveOverride(rackId, sw, 'make',  '');
    saveOverride(rackId, sw, 'model', '');
    setEditingIdent(false);
    setIdentDraftMake('');
    setIdentDraftModel('');
    setSpecs(null);
    setSpecsStatus('idle');
    setFirmware(null);
    setFirmwareStatus('idle');
  };

  const cves = firmware?.cves || [];
  const crit = cves.filter(c => (c.severity || '').toUpperCase() === 'CRITICAL').length;
  const high = cves.filter(c => (c.severity || '').toUpperCase() === 'HIGH').length;
  const fwTone =
    firmware?.upToDate === true && cves.length === 0 ? 'ok'
    : (crit > 0 || (firmware?.upToDate === false && high > 0)) ? 'critical'
    : firmware?.upToDate === false ? 'warn' : 'neutral';
  // Headline. When the vendor scrape couldn't confirm the latest version
  // (upToDate === null), say so honestly rather than the prior cryptic
  // "Latest version unknown" — the user has no idea what to do with that.
  // Tell them we couldn't check and offer a path to the vendor's release
  // notes so they can verify themselves.
  const fwHeadline =
    firmware?.upToDate === true ? 'Up to date'
    : firmware?.upToDate === false
      ? (crit > 0 ? 'Upgrade strongly recommended' : 'Upgrade available')
      : firmware?.releaseNotesUrl
        ? "Couldn't read latest — check vendor"
        : "Couldn't reach vendor right now";
  const fwColor =
    fwTone === 'ok' ? '#16a34a' : fwTone === 'critical' ? '#dc2626'
    : fwTone === 'warn' ? '#d97706' : lt ? '#6B7280' : 'rgba(230,235,245,0.7)';

  // Accent: indigo (light) / cyan (dark) for CMDB; amber for OCR
  const accent      = sw._fromOcr ? '#d97706' : lt ? '#4F46E5' : '#22d3ee';
  const accentDim   = sw._fromOcr ? (lt ? 'rgba(217,119,6,0.10)'  : 'rgba(245,158,11,0.15)')
                                  : (lt ? 'rgba(99,102,241,0.10)' : 'rgba(34,211,238,0.12)');
  const accentBorder= sw._fromOcr ? (lt ? 'rgba(217,119,6,0.35)'  : 'rgba(245,158,11,0.35)')
                                  : (lt ? 'rgba(99,102,241,0.35)' : 'rgba(34,211,238,0.25)');

  // Theme tokens
  const cardBg      = lt ? '#ffffff'                         : 'rgba(10,18,40,0.95)';
  const cardBorder  = lt ? '#E5E7EB'                         : 'rgba(255,255,255,0.08)';
  const titleColor  = lt ? '#111827'                         : '#e2e8f0';
  const subColor    = lt ? '#6B7280'                         : 'rgba(148,163,184,0.8)';
  const divider     = lt ? '#E5E7EB'                         : 'rgba(255,255,255,0.06)';
  const fieldBg     = lt ? '#FAFAFC'                         : 'rgba(255,255,255,0.03)';
  const fieldBorder = lt ? '#E5E7EB'                         : 'rgba(255,255,255,0.07)';
  const valueColor  = lt ? '#111827'                         : '#e2e8f0';
  const chevronColor= lt ? '#6B7280'                         : 'rgba(148,163,184,0.6)';
  const statusColor = lt ? '#6B7280'                         : 'rgba(148,163,184,0.7)';
  const linkColor   = lt ? '#4F46E5'                         : '#22d3ee';

  const displayVersion = sw.os_version || userVersion;
  const hasDetails = effectiveMake || effectiveModel || displayVersion || sw.serial_number || sw.ip_address || sw.mac_address;

  return (
    <article style={{
      borderRadius: 14,
      background: cardBg,
      border: `1px solid ${cardBorder}`,
      borderTop: `2px solid ${accent}`,
      marginBottom: 12,
      overflow: 'hidden',
      boxShadow: lt
        ? '0 1px 2px rgba(17,24,39,0.04), 0 4px 16px rgba(17,24,39,0.04)'
        : '0 4px 24px rgba(0,0,0,0.35)',
    }}>

      {/* ── Header ── */}
      <button
        onClick={onToggle}
        aria-expanded={expanded}
        style={{
          display: 'flex', width: '100%', alignItems: 'center', gap: 12,
          background: 'transparent', border: 0, color: 'inherit', textAlign: 'left',
          cursor: 'pointer', padding: '14px 16px',
        }}
      >
        <div style={{
          width: 36, height: 36, borderRadius: 10, flexShrink: 0,
          background: accentDim, border: `1px solid ${accentBorder}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="6" width="20" height="12" rx="2"/>
            <line x1="6" y1="12" x2="6" y2="12"/><line x1="10" y1="12" x2="10" y2="12"/>
            <line x1="14" y1="12" x2="14" y2="12"/><line x1="18" y1="12" x2="18" y2="12"/>
          </svg>
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 800, fontSize: '1rem', letterSpacing: '-0.01em', color: titleColor }}>
              {effectiveMake && effectiveModel
                ? `${effectiveMake} ${specs?.model || effectiveModel}`
                : effectiveMake || effectiveModel || sw.name || 'Unidentified device'}
            </span>
            <SourceBadge sw={sw} />
            {(makeIsUserSupplied || modelIsUserSupplied) && (
              <span style={{
                fontSize: '.58rem', fontWeight: 700, letterSpacing: '.06em',
                padding: '1px 5px', borderRadius: 3,
                background: 'rgba(168,85,247,0.14)', color: '#a855f7',
              }}>YOU</span>
            )}
          </div>
          <div style={{ fontSize: '.72rem', color: subColor, marginTop: 3, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {sw.position   && <span style={{ color: accent, fontWeight: 600 }}>{sw.position}</span>}
            {sw.ip_address && <span>{sw.ip_address}</span>}
            {displayVersion && (
              <span>
                fw {displayVersion}
                {versionIsUserSupplied && (
                  <span style={{
                    marginLeft: 4, fontSize: '.58rem', fontWeight: 700, letterSpacing: '.06em',
                    padding: '1px 5px', borderRadius: 3,
                    background: 'rgba(168,85,247,0.14)', color: '#a855f7',
                  }}>YOU</span>
                )}
              </span>
            )}
          </div>
        </div>

        <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
          stroke={chevronColor} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          style={{ flexShrink: 0, transform: expanded ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform .2s ease' }}>
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>

      {/* ── Fields grid ── */}
      {hasDetails && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 1, borderTop: `1px solid ${divider}` }}>
          {[
            effectiveMake    && ['Vendor',   makeIsUserSupplied ? `${effectiveMake} · entered` : effectiveMake],
            effectiveModel   && ['Model',    specs?.model || (modelIsUserSupplied ? `${effectiveModel} · entered` : effectiveModel)],
            displayVersion   && ['Firmware', versionIsUserSupplied ? `${displayVersion} · entered` : displayVersion],
            sw.serial_number && ['Serial',   sw.serial_number],
            sw.mac_address   && ['MAC',      sw.mac_address],
            sw.ip_address    && ['IP',       sw.ip_address],
          ].filter(Boolean).map(([label, value]) => (
            <div key={label} style={{ padding: '10px 16px', background: fieldBg }}>
              <span style={{ display: 'block', fontSize: '.6rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.07em', color: accent, marginBottom: 3 }}>
                {label}
              </span>
              <span style={{ display: 'block', fontSize: '.82rem', fontWeight: 600, color: valueColor }}>
                {value}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* ── Expanded: firmware + specs ── */}
      {expanded && (
        <div style={{ borderTop: `1px solid ${divider}`, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* Identifier section — shown whenever OCR didn't pin down the
              full make + model, or whenever the user wants to correct
              what OCR returned. The user explicitly asked for manual
              entry on either-missing, not just both-missing. */}
          {(identMissing || identIncomplete || editingIdent || makeIsUserSupplied || modelIsUserSupplied) && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <span style={{ fontSize: '.65rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.08em', color: statusColor }}>
                  Identification
                </span>
                {identMissing && !editingIdent && (
                  <span style={{ fontSize: '.7rem', fontWeight: 700, color: '#d97706', background: 'rgba(217,119,6,0.15)', padding: '2px 8px', borderRadius: 20, border: '1px solid rgba(217,119,6,0.4)' }}>
                    Not detected
                  </span>
                )}
                {identIncomplete && !editingIdent && !makeIsUserSupplied && !modelIsUserSupplied && (
                  <span style={{ fontSize: '.7rem', fontWeight: 700, color: '#d97706', background: 'rgba(217,119,6,0.15)', padding: '2px 8px', borderRadius: 20, border: '1px solid rgba(217,119,6,0.4)' }}>
                    {effectiveMake ? 'Model not detected' : 'Vendor not detected'}
                  </span>
                )}
                {(makeIsUserSupplied || modelIsUserSupplied) && !editingIdent && (
                  <span style={{ fontSize: '.7rem', fontWeight: 700, color: '#a855f7', background: 'rgba(168,85,247,0.15)', padding: '2px 8px', borderRadius: 20, border: '1px solid rgba(168,85,247,0.4)' }}>
                    Manual entry
                  </span>
                )}
                {!editingIdent && (
                  <button
                    type="button"
                    onClick={startEditIdent}
                    style={{
                      marginLeft: 'auto', background: 'transparent', border: 0,
                      color: linkColor, fontSize: '.7rem', fontWeight: 600, cursor: 'pointer',
                      padding: 0,
                    }}
                  >{
                    identMissing && !makeIsUserSupplied && !modelIsUserSupplied
                      ? 'Enter make / model'
                      : identIncomplete && !makeIsUserSupplied && !modelIsUserSupplied
                        ? (effectiveMake ? 'Add model' : 'Add vendor')
                        : 'Edit'
                  }</button>
                )}
              </div>
              {editingIdent ? (
                <IdentEditor
                  draftMake={identDraftMake}
                  setDraftMake={setIdentDraftMake}
                  draftModel={identDraftModel}
                  setDraftModel={setIdentDraftModel}
                  onSave={saveIdent}
                  onCancel={cancelEditIdent}
                  hasExisting={!!(userMake || userModel)}
                  onClear={clearIdent}
                  accent={accent}
                  fieldBg={fieldBg}
                  fieldBorder={fieldBorder}
                  valueColor={valueColor}
                  statusColor={statusColor}
                />
              ) : identMissing ? (
                <StatusLine color={statusColor}>
                  We couldn't identify this device from the rack photo.
                </StatusLine>
              ) : identIncomplete && !makeIsUserSupplied && !modelIsUserSupplied ? (
                <StatusLine color={statusColor}>
                  {effectiveMake
                    ? `We identified "${effectiveMake}" but couldn't read the model. Specs and firmware checks need both.`
                    : `We read a model but couldn't identify the vendor.`}
                </StatusLine>
              ) : null}
            </div>
          )}

          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <span style={{ fontSize: '.65rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.08em', color: statusColor }}>Firmware</span>
              {firmwareStatus === 'ready' && (
                <span style={{ fontSize: '.7rem', fontWeight: 700, color: fwColor, background: `${fwColor}18`, padding: '2px 8px', borderRadius: 20, border: `1px solid ${fwColor}40` }}>
                  {fwHeadline}
                </span>
              )}
              {versionIsUserSupplied && !editingVersion && (firmwareStatus === 'ready' || firmwareStatus === 'error') && (
                <button
                  type="button"
                  onClick={startEditVersion}
                  style={{
                    marginLeft: 'auto', background: 'transparent', border: 0,
                    color: linkColor, fontSize: '.7rem', fontWeight: 600, cursor: 'pointer',
                    padding: 0,
                  }}
                >Edit version</button>
              )}
            </div>
            {versionIsUserSupplied && editingVersion && (firmwareStatus === 'ready' || firmwareStatus === 'error') && (
              <div style={{ marginBottom: 10 }}>
                <VersionEditor
                  editing
                  draft={versionDraft}
                  setDraft={setVersionDraft}
                  onSave={saveVersion}
                  onCancel={cancelEditVersion}
                  hasExisting={!!userVersion}
                  onClear={clearVersion}
                  onStartEdit={startEditVersion}
                  accent={accent}
                  fieldBg={fieldBg}
                  fieldBorder={fieldBorder}
                  valueColor={valueColor}
                  statusColor={statusColor}
                />
              </div>
            )}
            {firmwareStatus === 'loading' && <StatusLine color={statusColor}>Checking for updates…</StatusLine>}
            {firmwareStatus === 'skipped' && lookupModel && (
              <VersionEditor
                editing={editingVersion || !displayVersion}
                draft={versionDraft}
                setDraft={setVersionDraft}
                onSave={saveVersion}
                onCancel={cancelEditVersion}
                hasExisting={!!userVersion}
                onClear={clearVersion}
                onStartEdit={startEditVersion}
                accent={accent}
                fieldBg={fieldBg}
                fieldBorder={fieldBorder}
                valueColor={valueColor}
                statusColor={statusColor}
              />
            )}
            {firmwareStatus === 'skipped' && !lookupModel && (
              <StatusLine color={statusColor}>Add a model to check for updates.</StatusLine>
            )}
            {firmwareStatus === 'error'   && <StatusLine color={statusColor}>Couldn't check for updates right now.</StatusLine>}
            {firmwareStatus === 'ready' && firmware && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: 8 }}>
                <MiniField label="Current" value={firmware.currentVersion} accent={accent} fieldBg={fieldBg} fieldBorder={fieldBorder} valueColor={valueColor} />
                <MiniField label="Latest"  value={firmware.latestVersion || '—'} accent={accent} fieldBg={fieldBg} fieldBorder={fieldBorder} valueColor={valueColor} />
                <MiniField label="CVEs"    value={`${cves.length}${(crit+high)>0?` (${crit}c/${high}h)`:''}`} accent={crit>0?'#dc2626':high>0?'#d97706':accent} fieldBg={fieldBg} fieldBorder={fieldBorder} valueColor={valueColor} />
                {firmware.releaseNotesUrl && (
                  <a href={firmware.releaseNotesUrl} target="_blank" rel="noreferrer noopener"
                    style={{ display: 'flex', alignItems: 'center', fontSize: '.72rem', color: linkColor, textDecoration: 'none' }}>
                    Release notes ↗
                  </a>
                )}
              </div>
            )}
          </div>

          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <span style={{ fontSize: '.65rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.08em', color: statusColor }}>
                Specifications
              </span>
              {specs?.productUrl && (
                <a href={specs.productUrl} target="_blank" rel="noreferrer noopener"
                  style={{ fontSize: '.72rem', fontWeight: 600, color: linkColor, textDecoration: 'none' }}>
                  View full details ↗
                </a>
              )}
            </div>
            {specsStatus === 'loading' && <StatusLine color={statusColor}>Looking up specs…</StatusLine>}
            {specsStatus === 'skipped' && <StatusLine color={statusColor}>Add vendor and model to see specs.</StatusLine>}
            {specsStatus === 'error'   && <StatusLine color={statusColor}>{looksLikeBackendNoise(specs?.error) ? 'Couldn’t load specs.' : (specs?.error || 'Couldn’t load specs.')}</StatusLine>}
            {specsStatus === 'ready' && specs?.specs && (
              <div style={{ display: 'flex', flexDirection: 'column', borderRadius: 10, border: `1px solid ${fieldBorder}`, overflow: 'hidden' }}>
                {Object.entries(specs.specs).slice(0, 20).map(([k, v], i) => (
                  <div key={k} style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(110px, 42%) 1fr',
                    gap: 10,
                    padding: '9px 12px',
                    background: i % 2 === 0 ? fieldBg : 'transparent',
                    borderBottom: i < Object.entries(specs.specs).slice(0, 20).length - 1 ? `1px solid ${fieldBorder}` : 'none',
                    alignItems: 'start',
                  }}>
                    <span style={{ fontSize: '.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: accent, lineHeight: 1.4, paddingTop: 1 }}>
                      {k}
                    </span>
                    <span style={{ fontSize: '.82rem', fontWeight: 500, color: valueColor, lineHeight: 1.45, wordBreak: 'break-word' }}>
                      {String(v).length > 120 ? String(v).slice(0, 117) + '…' : String(v)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </article>
  );
}

function VersionEditor({
  editing, draft, setDraft, onSave, onCancel, hasExisting, onClear, onStartEdit,
  accent, fieldBg, fieldBorder, valueColor, statusColor,
}) {
  if (!editing) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <StatusLine color={statusColor}>No firmware version recorded.</StatusLine>
        <button
          type="button"
          onClick={onStartEdit}
          style={{
            background: 'transparent', border: `1px solid ${accent}`,
            color: accent, fontSize: '.72rem', fontWeight: 600,
            padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
          }}
        >Enter version</button>
      </div>
    );
  }
  return (
    <div style={{
      padding: 10, borderRadius: 10,
      background: fieldBg, border: `1px solid ${fieldBorder}`,
    }}>
      <span style={{
        display: 'block', fontSize: '.62rem', fontWeight: 700,
        textTransform: 'uppercase', letterSpacing: '.08em',
        color: accent, marginBottom: 8,
      }}>
        Enter firmware version
      </span>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <input
          type="text"
          autoFocus
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); onSave(); }
            else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
          }}
          placeholder="e.g. 1.0.6 Build 20210323"
          style={{
            flex: '1 1 160px', minWidth: 0,
            padding: '6px 10px', borderRadius: 6,
            background: 'transparent', color: valueColor,
            border: `1px solid ${fieldBorder}`,
            fontSize: '.82rem', fontFamily: 'inherit',
            outline: 'none',
          }}
        />
        <button
          type="button"
          onClick={onSave}
          disabled={!draft.trim()}
          style={{
            background: accent, color: '#fff', border: 0,
            padding: '6px 12px', borderRadius: 6,
            fontSize: '.78rem', fontWeight: 700, cursor: draft.trim() ? 'pointer' : 'not-allowed',
            opacity: draft.trim() ? 1 : 0.5,
          }}
        >Save</button>
        <button
          type="button"
          onClick={onCancel}
          style={{
            background: 'transparent', color: statusColor,
            border: `1px solid ${fieldBorder}`,
            padding: '6px 10px', borderRadius: 6,
            fontSize: '.78rem', fontWeight: 600, cursor: 'pointer',
          }}
        >Cancel</button>
        {hasExisting && (
          <button
            type="button"
            onClick={onClear}
            style={{
              background: 'transparent', color: '#dc2626',
              border: `1px solid rgba(220,38,38,0.35)`,
              padding: '6px 10px', borderRadius: 6,
              fontSize: '.78rem', fontWeight: 600, cursor: 'pointer',
            }}
          >Clear</button>
        )}
      </div>
    </div>
  );
}

// Make + model editor. Used when OCR couldn't pin down identification
// or when the user is correcting what OCR returned. Saves both fields
// atomically — model regex resolution happens server-side at /api/specs
// time, so the UI doesn't need to validate model strings.
function IdentEditor({
  draftMake, setDraftMake, draftModel, setDraftModel,
  onSave, onCancel, hasExisting, onClear,
  accent, fieldBg, fieldBorder, valueColor, statusColor,
}) {
  const inputStyle = {
    flex: '1 1 140px', minWidth: 0,
    padding: '6px 10px', borderRadius: 6,
    background: 'transparent', color: valueColor,
    border: `1px solid ${fieldBorder}`,
    fontSize: '.82rem', fontFamily: 'inherit',
    outline: 'none',
  };
  const onKeyDown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); onSave(); }
    else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
  };
  const canSave = !!(draftMake.trim() && draftModel.trim());
  return (
    <div style={{
      padding: 10, borderRadius: 10,
      background: fieldBg, border: `1px solid ${fieldBorder}`,
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div>
          <span style={{
            display: 'block', fontSize: '.6rem', fontWeight: 700,
            textTransform: 'uppercase', letterSpacing: '.07em',
            color: accent, marginBottom: 4,
          }}>Make / Vendor</span>
          <input
            type="text"
            autoFocus
            value={draftMake}
            onChange={e => setDraftMake(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="e.g. MikroTik"
            style={inputStyle}
          />
        </div>
        <div>
          <span style={{
            display: 'block', fontSize: '.6rem', fontWeight: 700,
            textTransform: 'uppercase', letterSpacing: '.07em',
            color: accent, marginBottom: 4,
          }}>Model</span>
          <input
            type="text"
            value={draftModel}
            onChange={e => setDraftModel(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="e.g. CRS328-24P-4S+RM"
            style={inputStyle}
          />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
        <button
          type="button"
          onClick={onSave}
          disabled={!canSave}
          style={{
            background: accent, color: '#fff', border: 0,
            padding: '6px 12px', borderRadius: 6,
            fontSize: '.78rem', fontWeight: 700, cursor: canSave ? 'pointer' : 'not-allowed',
            opacity: canSave ? 1 : 0.5,
          }}
        >Save</button>
        <button
          type="button"
          onClick={onCancel}
          style={{
            background: 'transparent', color: statusColor,
            border: `1px solid ${fieldBorder}`,
            padding: '6px 10px', borderRadius: 6,
            fontSize: '.78rem', fontWeight: 600, cursor: 'pointer',
          }}
        >Cancel</button>
        {hasExisting && (
          <button
            type="button"
            onClick={onClear}
            style={{
              background: 'transparent', color: '#dc2626',
              border: `1px solid rgba(220,38,38,0.35)`,
              padding: '6px 10px', borderRadius: 6,
              fontSize: '.78rem', fontWeight: 600, cursor: 'pointer',
            }}
          >Clear</button>
        )}
      </div>
    </div>
  );
}

function StatusLine({ children, color }) {
  return (
    <p style={{ margin: 0, fontSize: '.78rem', color: color || 'rgba(148,163,184,0.7)', fontStyle: 'italic' }}>
      {children}
    </p>
  );
}

function MiniField({ label, value, accent, fieldBg, fieldBorder, valueColor }) {
  return (
    <div style={{ padding: '8px 10px', borderRadius: 8, background: fieldBg, border: `1px solid ${fieldBorder}` }}>
      <span style={{ display: 'block', fontSize: '.58rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.07em', color: accent, marginBottom: 3 }}>
        {label}
      </span>
      <span style={{ display: 'block', fontSize: '.8rem', fontWeight: 600, color: valueColor, wordBreak: 'break-word' }}>
        {value || '—'}
      </span>
    </div>
  );
}

function Field({ label, value }) {
  return (
    <div>
      <span style={{ display: 'block', fontSize: '.65rem', color: 'rgba(230,235,245,0.5)', textTransform: 'uppercase', letterSpacing: '.06em' }}>
        {label}
      </span>
      <span style={{ display: 'block', fontSize: '.82rem', color: '#e2e8f0', wordBreak: 'break-word' }}>
        {value || '—'}
      </span>
    </div>
  );
}

// ── Shared data + rendering logic ────────────────────────────
function useSwitchData(rackId) {
  // Prefer prefetched data if it's already in memory — that's the
  // common case after a fresh /api/analyze, since ScanPage fired
  // prefetchScan(rackId) the moment the analyze succeeded. We only
  // show the loading state when neither the prefetch cache nor the
  // network has resolved yet, so the typical re-visit to this page
  // renders instantly without a spinner flash.
  const cmdbCached = rackId ? getCached(cacheKey.cmdb(rackId)) : null;
  const ocrCached  = rackId ? getCached(cacheKey.ocrDevices(rackId)) : null;
  const ocrCachedDevs = ocrCached?.devices && Array.isArray(ocrCached.devices)
    ? ocrCached.devices
    : null;

  const [loading, setLoading] = useState(!(cmdbCached || ocrCachedDevs));
  const [data, setData]       = useState(cmdbCached);
  const [ocrDevices, setOcrDevices] = useState(ocrCachedDevs);

  useEffect(() => {
    if (!rackId) { setLoading(false); return; }
    let cancelled = false;
    // If we already have both halves cached, skip the fetches entirely.
    const haveCmdb = !!cmdbCached;
    const haveOcr  = !!ocrCachedDevs;
    if (haveCmdb && haveOcr) { setLoading(false); return; }

    if (!haveCmdb && !haveOcr) setLoading(true);

    const cmdbPromise = haveCmdb
      ? Promise.resolve(cmdbCached)
      : authFetch(apiUrl(`/api/cmdb/rack/${encodeURIComponent(rackId)}/switches`))
          .then(async r => {
            const text = await r.text();
            try { return text ? JSON.parse(text) : null; } catch { return null; }
          })
          .catch(() => null);

    const ocrPromise = haveOcr
      ? Promise.resolve(ocrCached)
      : authFetch(apiUrl(`/api/scan/${encodeURIComponent(rackId)}/ocr-devices`))
          .then(async r => {
            if (!r.ok) return null;
            const text = await r.text();
            try { return text ? JSON.parse(text) : null; } catch { return null; }
          })
          .catch(() => null);

    Promise.all([cmdbPromise, ocrPromise]).then(([cmdbData, ocrData]) => {
      if (cancelled) return;
      if (cmdbData) {
        setData(cmdbData);
        setCached(cacheKey.cmdb(rackId), cmdbData);
      }
      const devs = Array.isArray(ocrData) ? ocrData
                 : (ocrData?.devices && Array.isArray(ocrData.devices)) ? ocrData.devices
                 : null;
      if (devs) {
        setOcrDevices(devs);
        if (ocrData && !ocrCached) setCached(cacheKey.ocrDevices(rackId), ocrData);
      }
    }).finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [rackId]);

  const cmdbSwitches = data?.switches || [];
  const NETWORK_CLASSES = ['switch', 'router'];
  const switches = cmdbSwitches.length > 0
    ? cmdbSwitches
    : (ocrDevices || [])
        .filter(ocr => NETWORK_CLASSES.includes((ocr.class_name || '').toLowerCase()))
        .map(ocr => {
          // Prefer extracting from raw_text (more complete), fall back to ocr.model
          const rawExtracted = extractModelFromRaw(ocr.raw_text, ocr.make);
          const model = expandPartialModel(rawExtracted || ocr.model || '');
          return {
            name: ocr.position ? `${ocr.class_name} (${ocr.position})` : (ocr.name || ocr.class_name || 'Detected switch'),
            manufacturer: ocr.make || '',
            model_number: model,
            os_version: ocr.version || '',
            serial_number: '',
            mac_address: '',
            ip_address: '',
            position: ocr.position || '',
            discovery_source: ocr.source || 'ocr',
            ocr_conf: ocr.match_conf,
            raw_text: ocr.raw_text || '',
            _fromOcr: true,
          };
        });
  const showingOcrOnly = cmdbSwitches.length === 0 && switches.length > 0;

  return { loading, data, switches, showingOcrOnly };
}

function SwitchInfoBody({ rackId, loading, data, switches, showingOcrOnly }) {
  return (
    <>
      {loading && (
        <div style={{ padding: '32px 16px', textAlign: 'center' }}>
          <p style={{ margin: 0, fontSize: '.88rem', color: 'rgba(230,235,245,0.55)' }}>
            Scanning rack for switches…
          </p>
        </div>
      )}

      {!loading && switches.length === 0 && (
        <div style={{
          marginTop: 18, padding: 16, borderRadius: 12,
          background: 'rgba(96,165,250,0.06)',
          border: '1px solid rgba(96,165,250,0.20)',
        }}>
          <p style={{ margin: 0, fontWeight: 600, color: 'var(--t1)', fontSize: '.92rem' }}>
            Scanning…
          </p>
          <p style={{ margin: '6px 0 0', fontSize: '.78rem', color: 'rgba(120,120,140,0.85)' }}>
            Run a rack scan to detect switches. Their make, model and firmware version will appear here once detected.
          </p>
        </div>
      )}

      {!loading && switches.length > 0 && (
        <section style={{ marginTop: 16 }}>
          {switches.map((sw, i) => (
            <SwitchCard key={sw.serial_number || sw.name || i} sw={sw} rackId={rackId} />
          ))}
        </section>
      )}
    </>
  );
}

// ── Embeddable content (used as a tab in ResultsPage) ────────
export function SwitchInfoContent({ rackId }) {
  const d = useSwitchData(rackId);
  return <SwitchInfoBody rackId={rackId} {...d} />;
}

// ── Standalone page (used by /switch-info route) ─────────────
export default function SwitchInformationPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams();
  const rackId = params.rackId || location.state?.rackId || null;
  const switchData = useSwitchData(rackId);
  const { loading, data, switches, showingOcrOnly } = switchData;

  return (
    <div className={`page page-full ${styles.specs}`}>
      <div className={styles.amb} />
      <div className={styles.amb2} />

      <header className={styles.header}>
        <button className={styles.backBtn} onClick={() => navigate(-1)} aria-label="Back">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="19" y1="12" x2="5" y2="12"/>
            <polyline points="12 19 5 12 12 5"/>
          </svg>
        </button>
        <h1 className={styles.title}>Switch Information</h1>
        <ThemeToggle />
      </header>

      <SwitchInfoBody rackId={rackId} {...switchData} />
    </div>
  );
}

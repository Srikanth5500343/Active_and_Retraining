import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useEffect, useRef, useState, useMemo } from 'react';
import styles from './ResultsPage.module.css';
import { apiUrl, authFetch } from '../utils/api';
import CmdbApprovalModal from '../components/CmdbApprovalModal.jsx';
import ScanTabBar from '../components/ScanTabBar.jsx';
import RackTabs from '../components/RackTabs.jsx';
import { PortsContent } from './PortsPage.jsx';
import { TopologyContent } from './TopologyPage.jsx';
import { NetdiscoContent } from './NetdiscoPage.jsx';
import { SwitchInfoContent } from './SwitchInformationPage.jsx';
import { PortHistoryContent } from './PortHistoryPage.jsx';

// ── Naming convention ─────────────────────────────────────────
const CLASS_CODE = {
  'Switch': 'SW', 'Patch Panel': 'PP', 'Firewall': 'FW', 'Router': 'RO',
  'Server': 'SVR', 'Load Balancer': 'LB', 'Modem': 'MO',
  'Controller': 'CTRL', 'Recorder': 'REC', 'Amplifier': 'AMP', 'Gateway': 'GT',
  'PDU': 'PDU', 'PSU': 'PSU', 'UPS': 'UPS', 'Empty': 'EMP', 'Closed Unit': 'CL',
};
const TYPE_COLOR = {
  'Switch': '#22d3ee', 'Patch Panel': '#60a5fa', 'Server': '#a78bfa',
  'Gateway': '#fb923c', 'Firewall': '#f87171', 'PDU': '#fbbf24',
  'PSU': '#f472b6', 'UPS': '#34d399', 'Router': '#818cf8',
  'Load Balancer': '#c084fc', 'Modem': '#94a3b8',
  'Controller': '#67e8f9', 'Recorder': '#86efac', 'Amplifier': '#fda4af',
  'Closed Unit': '#f43f5e', 'Empty': 'rgba(6,182,212,0.3)',
};
const DEFAULT_COLOR = '#22d3ee';

function getColor(name) { return TYPE_COLOR[name] || DEFAULT_COLOR; }

function parseUnitNumber(label) {
  const match = String(label || '').match(/\d+/);
  return match ? Number(match[0]) : null;
}

function formatUnitsRange(units = []) {
  const numbers = [...new Set((units || [])
    .map(parseUnitNumber)
    .filter((n) => n !== null))].sort((a, b) => a - b);
  if (!numbers.length) return '';

  const ranges = [];
  let start = numbers[0];
  let prev = numbers[0];

  for (let i = 1; i < numbers.length; i += 1) {
    const current = numbers[i];
    if (current === prev + 1) {
      prev = current;
      continue;
    }
    ranges.push([start, prev]);
    start = current;
    prev = current;
  }
  ranges.push([start, prev]);

  return ranges.map(([s, e]) =>
    s === e
      ? `U${String(s).padStart(2, '0')}`
      : `U${String(s).padStart(2, '0')}-U${String(e).padStart(2, '0')}`
  ).join(' ');
}

function buildDeviceLabels(devices, unitsDetected = [], pattern = null) {
  const counts = {};
  const padding = pattern?.padding || 2;
  return devices.map(dev => {
    const code = CLASS_CODE[dev.class_name] || dev.class_name.replace(/\s+/g, '').slice(0, 4).toUpperCase();
    counts[code] = (counts[code] || 0) + 1;
    const seq = String(counts[code]).padStart(padding, '0');
    // When OCR detected a real label on this rack, mint matching names for
    // the rest (e.g. RVEW-CORE-SW01 → RVEW-CORE-PDU01) instead of falling
    // back to the unit-prefixed scheme.
    if (pattern) return `${pattern.prefix}${pattern.sep}${code}${seq}`;
    const labelUnits = dev.units?.length ? dev.units : unitsDetected.length ? [unitsDetected[0]] : [];
    const formatted = formatUnitsRange(labelUnits) || 'U01';
    const primaryLabel = formatted.split(' ')[0];
    return `${primaryLabel}-${code}${seq}`;
  });
}

function buildPortLabel(deviceLabel, className, portNum) {
  const p = String(portNum).padStart(2, '0');
  switch (className) {
    case 'Switch':      return `${deviceLabel}-IF-Gi1/0/${portNum}`;
    case 'Patch Panel': return `${deviceLabel}-FP-${p}`;
    case 'PDU':         return `${deviceLabel}-OUT-${p}`;
    case 'Server': case 'PSU': case 'UPS': return `${deviceLabel}-PWR-${p}`;
    case 'Gateway': case 'Router': case 'Firewall': return `${deviceLabel}-IF-${p}`;
    default:            return `${deviceLabel}-P${p}`;
  }
}

const DEVICE_CLASS_OPTIONS = [
  'Switch', 'Patch Panel', 'Firewall', 'Router', 'Server', 'Load Balancer',
  'Modem', 'Controller', 'Recorder', 'Amplifier', 'Gateway', 'PDU', 'PSU', 'UPS',
];
const CABLE_COLOR_OPTIONS = [
  'Black', 'Blue', 'Brown', 'Green', 'Grey', 'Orange',
  'Pink', 'Red', 'White', 'Yellow', 'Violet', 'Aqua',
];

const CABLE_COLOR_MAP = {
  black: '#1a1a2e', blue: '#3b82f6', brown: '#92400e', green: '#22c55e',
  grey: '#9ca3af', gray: '#9ca3af', orange: '#f97316', pink: '#ec4899',
  red: '#ef4444', white: '#e8e8e8', yellow: '#eab308', violet: '#8b5cf6',
  aqua: '#06b6d4',
};
function cableColorCSS(name) {
  if (!name) return '#60a5fa';
  return CABLE_COLOR_MAP[name.toLowerCase()] || '#60a5fa';
}

function parseCableType(label) {
  if (!label) return { raw: '', display: '', colorName: '' };
  const raw = String(label).trim();
  const normalized = raw.replace(/_/g, ' ').replace(/RJ[ _]?45/i, 'RJ-45');
  const parts = normalized.split(/\s+/);
  const colors = ['aqua','black','blue','brown','green','grey','gray','orange','pink','red','white','yellow','violet'];
  const found = parts.find(part => colors.includes(part.toLowerCase()));
  const colorName = found ? found[0].toUpperCase() + found.slice(1).toLowerCase() : '';
  const displayParts = found ? parts.filter(part => part.toLowerCase() !== found.toLowerCase()) : parts;
  const display = displayParts.join(' ');
  return { raw, display, colorName };
}

// ── Port report builder ──────────────────────────────────────
// Parses the console transcript into a structured report:
//   { switch, port, link, learnedMacs[{mac,vlan,type,vendor,ip}], lldp, cable, stp, vlan }
// Heuristic regexes — tolerant to TP-Link, Cisco, D-Link dialects.

function normalizeMac(s) {
  const hex = (s || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  if (hex.length !== 12) return (s || '').toLowerCase().trim();
  return hex.match(/.{2}/g).join(':');
}

function parseLearnedMacs(text) {
  if (!text) return [];
  const macRx = /([0-9a-fA-F]{2}[:\-.][0-9a-fA-F]{2}[:\-.]?[0-9a-fA-F]{2}[:\-.]?[0-9a-fA-F]{2}[:\-.]?[0-9a-fA-F]{2}[:\-.]?[0-9a-fA-F]{2})\s+(\d+)\s+(\S+)\s+(\S+)/;
  const out = [];
  for (const line of text.split('\n')) {
    const m = line.match(macRx);
    if (!m) continue;
    const mac = normalizeMac(m[1]);
    if (mac.split(':').length !== 6) continue;
    out.push({ mac, vlan: m[2], port: m[3], type: m[4] });
  }
  return out;
}

function parseInterfaceStatus(text, iface) {
  if (!text) return null;
  // `Gi1/0/6   LinkUp      1000M     Full      Disable     Copper`
  const esc = (iface || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^\\s*${esc}\\s+(\\S+)\\s+(\\S+)\\s+(\\S+)\\s+(\\S+)\\s+(\\S+)\\s*(.*)$`, 'm');
  const m = text.match(re);
  if (!m) return null;
  return {
    status: m[1], speed: m[2], duplex: m[3],
    flow: m[4], medium: m[5], description: (m[6] || '').trim(),
  };
}

function parseLldpNeighborBlock(text) {
  if (!text) return null;
  if (/No Neighbor/i.test(text) || /no lldp neighbor/i.test(text)) return null;
  const pick = (re) => { const m = text.match(re); return m ? m[1].trim() : null; };
  const info = {
    chassis_id:    pick(/Chassis (?:ID|Id)\s*[:=]\s*([^\n]+)/i),
    port_id:       pick(/Port (?:ID|Id)\s*[:=]\s*([^\n]+)/i),
    port_desc:     pick(/Port [Dd]escription\s*[:=]\s*([^\n]+)/i),
    system_name:   pick(/System [Nn]ame\s*[:=]\s*([^\n]+)/i),
    system_desc:   pick(/System [Dd]escription\s*[:=]\s*([^\n]+)/i),
    mgmt_addr:     pick(/(?:Management [Aa]ddress|Management IP)[^\n]*?\b((?:\d{1,3}\.){3}\d{1,3})\b/i),
    pvid:          pick(/Port VLAN ID\(PVID\)\s*[:=]\s*(\d+)/i),
    ttl:           pick(/TTL\s*[:=]\s*(\d+)/i),
  };
  const hasAny = Object.values(info).some(v => v && v.toLowerCase() !== 'none');
  return hasAny ? info : null;
}

function parseCableDiag(text) {
  if (!text) return null;
  const pairs = {};
  for (const line of text.split('\n')) {
    const m = line.match(/[Pp]air[-\s]?([A-D1-4])[\s:]+(\S+)(?:[^0-9]*(\d+))?/);
    if (!m) continue;
    pairs[m[1].toUpperCase()] = { status: m[2], length_m: m[3] ? +m[3] : null };
  }
  return Object.keys(pairs).length ? pairs : null;
}

function parseStp(text) {
  if (!text) return null;
  if (/Spanning tree is disabled/i.test(text)) return { state: 'disabled' };
  if (/Interface information is not available/i.test(text)) return { state: 'unknown' };
  return { state: 'enabled' };
}

function buildPortReport({ host, vendor, iface, portNum, entries = [], neighbor, neighborMethod }) {
  const byName = {};
  for (const e of entries) if (e && e.name) byName[e.name.toLowerCase()] = e;

  const ifaceStatusText = (byName['interface status'] || byName['port status'] || {}).output || '';
  const macText = (byName['mac address-table'] || byName['mac address table'] || {}).output || '';
  const lldpText = (byName['lldp neighbor'] || byName['lldp remote ports'] || {}).output || '';
  const cableText = (byName['cable diagnostics'] || byName['cable diag'] || {}).output || '';
  const stpText = (byName['spanning tree'] || {}).output || '';

  const link = parseInterfaceStatus(ifaceStatusText, iface);
  const macs = parseLearnedMacs(macText);
  const lldp = parseLldpNeighborBlock(lldpText);
  const cable = parseCableDiag(cableText);
  const stp = parseStp(stpText);

  // If we already resolved a neighbor via the quick-lookup fallback chain, merge it in.
  const mergedLldp = lldp || (neighbor?.found ? {
    system_name: neighbor.system_name || null,
    port_id: neighbor.port_id || null,
    port_desc: neighbor.port_description || null,
    chassis_id: neighbor.chassis_id || null,
    system_desc: neighbor.system_description || null,
    mgmt_addr: neighbor.management_address || null,
    _via: neighborMethod || null,
  } : null);

  // One-line end-device verdict
  let verdict;
  if (link?.status === 'LinkDown') {
    verdict = 'Link is DOWN — no device connected (or cable unplugged at the far end).';
  } else if (mergedLldp?.system_name || mergedLldp?.chassis_id) {
    const name = mergedLldp.system_name || mergedLldp.chassis_id;
    const mgmt = mergedLldp.mgmt_addr ? ` @ ${mergedLldp.mgmt_addr}` : '';
    verdict = `${name}${mgmt}${mergedLldp._via ? ` (via ${mergedLldp._via})` : ''}`;
  } else if (macs.length === 1) {
    verdict = `One endpoint: ${macs[0].mac} (VLAN ${macs[0].vlan})`;
  } else if (macs.length > 1) {
    verdict = `${macs.length} MACs learned — likely a downstream switch/hub/AP`;
  } else {
    verdict = 'Link is UP but no MAC learned yet and no LLDP neighbor — device is silent.';
  }

  return {
    generatedAt: new Date().toISOString(),
    switch: { host, vendor },
    port: { iface, number: portNum },
    link, macs, lldp: mergedLldp, cable, stp,
    verdict,
    transcript: entries,
  };
}

// ── Switch info parser ───────────────────────────────────────
// Parses live SSH output (show version / show system-info) into a small set
// of fields we surface in the Switch Info modal. Live data only — never
// persisted, never reconciled with CMDB.
function parseSwitchInfo(raw, vendor) {
  const text = String(raw || '').replace(/\r/g, '');
  const out = { model: null, firmware: null, uptime: null, serial: null, mac: null, hostname: null };
  if (!text) return out;

  const grab = (re) => {
    const m = text.match(re);
    return m ? m[1].trim() : null;
  };

  if (vendor === 'tplink') {
    out.model    = grab(/(?:Device\s*Model|Hardware\s*Version)\s*[-:]\s*([^\r\n]+)/i);
    out.firmware = grab(/(?:Software|Firmware)\s*Version\s*[-:]\s*([^\r\n]+)/i);
    // "Running Time" is the actual uptime; "System Time" is wall-clock.
    out.uptime   = grab(/Running\s*Time\s*[-:]\s*([^\r\n]+)/i)
                || grab(/System\s*Up\s*Time\s*[-:]\s*([^\r\n]+)/i);
    out.serial   = grab(/Serial\s*Number\s*[-:]\s*(\S+)/i);
    out.mac      = grab(/(?:System\s*)?MAC\s*Address\s*[-:]\s*([0-9A-Fa-f:.\- ]+)/i);
    out.hostname = grab(/(?:Device\s*Name|System\s*Name)\s*[-:]\s*([^\r\n]+)/i);
  } else if (vendor === 'dlink') {
    out.model    = grab(/(?:Device\s*Type|System\s*Hardware\s*Version)\s*:\s*([^\r\n]+)/i);
    out.firmware = grab(/(?:Firmware|System\s*Firmware)\s*Version\s*:\s*([^\r\n]+)/i);
    out.uptime   = grab(/System\s*Up\s*Time\s*:\s*([^\r\n]+)/i);
    out.serial   = grab(/Serial\s*Number\s*:\s*([^\r\n]+)/i);
    out.mac      = grab(/(?:System\s*)?MAC\s*Address\s*:\s*([0-9A-Fa-f:.\- ]+)/i);
    out.hostname = grab(/(?:Device\s*Name|System\s*Name)\s*:\s*([^\r\n]+)/i);
  } else {
    // cisco-ios (default): `show version`
    // Hardware model: try Model number first, then "cisco <MODEL> (...)"
    out.model =
      grab(/Model\s*number\s*:\s*([^\r\n]+)/i) ||
      grab(/^cisco\s+(\S+)\s*\(/im);
    // IOS / IOS-XE software version
    out.firmware =
      grab(/(?:IOS\s*XE\s*Software|IOS\s*Software)[^\n]*Version\s+([^\s,]+)/i) ||
      grab(/Version\s+([^\s,]+),\s*RELEASE/i);
    out.uptime   = grab(/uptime\s+is\s+([^\r\n]+)/i);
    out.serial   = grab(/(?:Processor\s*board\s*ID|System\s*Serial\s*Number)\s*:?\s*([A-Z0-9]+)/i);
    out.hostname = grab(/^([^\s]+)\s+uptime\s+is/im);
  }
  return out;
}

// Vendor → command we run for the Switch Info modal. Live SSH only.
const SWITCH_INFO_CMD = {
  'cisco-ios': 'show version',
  'tplink':    'show system-info',
  'dlink':     'show switch',
};

// SSH vendor code → vendor display name in the spec-scraper Excel sheet.
// The /api/specs and /api/firmware backends take a free-text vendor and
// substring-match it against the sheet, so we need the canonical brand name.
const SSH_VENDOR_TO_DISPLAY = {
  'cisco-ios': 'Cisco',
  'tplink':    'TP-Link',
  'dlink':     'D-Link',
};

// Strip a trailing hardware-revision suffix ("TL-SG2428P 5.0" → "TL-SG2428P")
// so the vendor product page actually resolves. Vendors don't put hw rev in
// the URL slug; SSH does include it in `Hardware Version`.
function cleanModelForLookup(m) {
  if (!m) return '';
  return String(m).trim().replace(/\s+v?\d+(?:\.\d+){0,2}\s*$/i, '').trim();
}

// Extract a clean dotted version from messy firmware strings.
//   "5.0.2 Build 20220909 Rel.75392" → "5.0.2"
//   "16.9.5"                          → "16.9.5"
//   "9.3(7)I7(7)"                     → "9.3(7)I7(7)"
function cleanFirmwareVersion(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  // Cisco NX-OS form first — has parentheses our generic regex would miss.
  const nx = s.match(/\b\d+\.\d+\([^)]+\)(?:[A-Z]\d+(?:\([^)]+\))?)?/);
  if (nx) return nx[0];
  const dotted = s.match(/\b\d+\.\d+(?:\.\d+){0,3}(?:[A-Za-z][A-Za-z0-9]{0,5})?(?:-[A-Za-z0-9]{1,8})?\b/);
  return dotted ? dotted[0] : s;
}

// ── Switch info modal ────────────────────────────────────────
// Live snapshot of the switch over SSH — model, firmware, uptime, serial.
// Independent of CMDB / Netdisco / any synthesized data.
function SwitchInfoModal({
  status, info, raw, error, host, vendor,
  specs, specsStatus, specsError,
  firmware, firmwareStatus, firmwareError,
  onClose, onRetry,
}) {
  const [rawOpen, setRawOpen] = useState(false);

  return (
    <div className={styles.portReportBackdrop} onClick={onClose}>
      <div className={`${styles.portReport} ${styles.siModal}`} onClick={(e) => e.stopPropagation()}>
        {/* ── Header ── */}
        <div className={styles.siHeader}>
          <div className={styles.siHeaderLeft}>
            <div className={styles.siHeaderIcon}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="3" width="20" height="18" rx="3"/>
                <circle cx="7" cy="16" r="1.2" fill="currentColor" stroke="none"/>
                <circle cx="11" cy="16" r="1.2" fill="currentColor" stroke="none"/>
                <line x1="6" y1="8" x2="18" y2="8"/>
              </svg>
            </div>
            <div>
              <div className={styles.siTitle}>Switch Info</div>
              <div className={styles.siSub}>
                <span className={styles.siLiveDot} />
                live · {host || '—'} · {vendor || '—'}
              </div>
            </div>
          </div>
          <button className={styles.portReportClose} onClick={onClose} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        <div className={styles.siBody}>
          {status === 'loading' && (
            <div className={styles.siCard}>
              <p className={styles.prEmpty}>Querying switch over SSH…</p>
            </div>
          )}

          {status === 'error' && (
            <div className={styles.siCard}>
              <div className={styles.siCardHead}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f87171" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
                <h4>Could not reach switch</h4>
              </div>
              <p className={styles.prEmpty}>{error || 'Unknown error'}</p>
              <div style={{ marginTop: 10 }}>
                <button className={styles.reportChip} onClick={onRetry}>Retry</button>
              </div>
            </div>
          )}

          {status === 'ready' && info && (
            <>
              {/* ── Hardware & Firmware card ── */}
              <div className={styles.siCard}>
                <div className={styles.siCardHead}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg>
                  <h4>Hardware &amp; Firmware</h4>
                </div>
                <div className={styles.siTable}>
                  <div className={styles.siRow}><span>Model</span><span>{info.model || '—'}</span></div>
                  <div className={styles.siRow}><span>Firmware</span><span>{info.firmware || '—'}</span></div>
                  <div className={styles.siRow}><span>Serial</span><span>{info.serial || '—'}</span></div>
                  <div className={styles.siRow}><span>Uptime</span><span>{info.uptime || '—'}</span></div>
                  {info.hostname && <div className={styles.siRow}><span>Hostname</span><span>{info.hostname}</span></div>}
                  {info.mac && <div className={styles.siRow}><span>MAC Address</span><span>{info.mac}</span></div>}
                </div>
              </div>

              {/* ── Firmware Update card ── */}
              <div className={styles.siCard}>
                <div className={styles.siCardHead}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                  <h4>Firmware Update</h4>
                </div>
                {firmwareStatus === 'loading' && (
                  <p className={styles.prEmpty}>Checking vendor site for newer firmware…</p>
                )}
                {firmwareStatus === 'error' && (
                  <p className={styles.prEmpty}>Could not check: {firmwareError || 'lookup failed'}</p>
                )}
                {firmwareStatus === 'ready' && firmware && (() => {
                  const cves = firmware.cves || [];
                  const counts = cves.reduce((a, c) => {
                    const s = (c.severity || 'NONE').toUpperCase();
                    a[s] = (a[s] || 0) + 1;
                    return a;
                  }, {});
                  const crit = counts.CRITICAL || 0;
                  const high = counts.HIGH || 0;
                  const tone =
                    firmware.upToDate === true && cves.length === 0 ? 'ok'
                    : (crit > 0 || (firmware.upToDate === false && high > 0)) ? 'critical'
                    : firmware.upToDate === false ? 'warn'
                    : 'neutral';
                  const headline =
                    firmware.upToDate === true ? "Up to date"
                    : firmware.upToDate === false
                      ? (crit > 0 ? 'Upgrade strongly recommended' : 'Upgrade available')
                      : 'Could not determine latest version';
                  const icon =
                    tone === 'ok' ? '✓' : tone === 'critical' ? '!' : tone === 'warn' ? '↑' : '?';
                  return (
                    <>
                      <div className={`${styles.siBadge} ${styles[`siBadge_${tone}`]}`}>
                        <span className={styles.siBadgeIcon}>{icon}</span>
                        {headline}
                      </div>
                      <div className={styles.siTable} style={{ marginTop: 10 }}>
                        <div className={styles.siRow}>
                          <span>Current version</span>
                          <span>{firmware.currentVersion || '—'}</span>
                        </div>
                        <div className={styles.siRow}>
                          <span>Latest version</span>
                          <span>{firmware.latestVersion || '—'}</span>
                        </div>
                        <div className={styles.siRow}>
                          <span>Known CVEs</span>
                          <span>
                            {cves.length === 0 ? 'None' : (
                              <>{cves.length}{(crit + high) > 0 && <span className={styles.siCveSub}> ({crit} critical, {high} high)</span>}</>
                            )}
                          </span>
                        </div>
                      </div>
                      {firmware.releaseNotesUrl && (
                        <a href={firmware.releaseNotesUrl} target="_blank" rel="noreferrer noopener"
                           className={styles.siLink}>
                          Release notes
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/></svg>
                        </a>
                      )}
                    </>
                  );
                })()}
                {firmwareStatus === 'skipped' && (
                  <p className={styles.prEmpty}>Need both model and firmware version to check for updates.</p>
                )}
              </div>

              {/* ── Vendor Specifications card ── */}
              <div className={styles.siCard}>
                <div className={styles.siCardHead}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
                  <h4>Vendor Specifications</h4>
                  {specsStatus === 'ready' && specs?.productUrl && (
                    <a href={specs.productUrl} target="_blank" rel="noreferrer noopener"
                       className={styles.siLink} style={{ marginLeft: 'auto' }}>
                      Source
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/></svg>
                    </a>
                  )}
                </div>
                {specsStatus === 'loading' && (
                  <p className={styles.prEmpty}>Looking up specs on vendor site…</p>
                )}
                {specsStatus === 'error' && (
                  <p className={styles.prEmpty}>Could not fetch specs: {specsError || 'lookup failed'}</p>
                )}
                {specsStatus === 'ready' && specs?.specs && (
                  <div className={styles.siTable}>
                    {Object.entries(specs.specs).slice(0, 12).map(([k, v]) => (
                      <div className={styles.siRow} key={k}>
                        <span>{k}</span>
                        <span>{String(v).length > 80 ? String(v).slice(0, 77) + '…' : String(v)}</span>
                      </div>
                    ))}
                  </div>
                )}
                {specsStatus === 'skipped' && (
                  <p className={styles.prEmpty}>Need a model to look up specs.</p>
                )}
              </div>

              {/* ── Raw Output (collapsible) ── */}
              {raw && (
                <div className={styles.siCard}>
                  <button className={styles.siCardToggle} onClick={() => setRawOpen(o => !o)}>
                    <div className={styles.siCardHead} style={{ margin: 0 }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
                      <h4>Raw Output</h4>
                    </div>
                    <span className={`${styles.siChevron} ${rawOpen ? styles.siChevronOpen : ''}`}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                    </span>
                  </button>
                  {rawOpen && (
                    <pre className={styles.siRawPre}>{raw}</pre>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Port report modal (shown when the user presses "Done" in the console) ────
function PortReportModal({ report, onClose }) {
  const {
    switch: sw, port, link, macs = [], lldp, cable, stp, verdict, transcript = [],
  } = report || {};
  return (
    <div className={styles.portReportBackdrop} onClick={onClose}>
      <div className={styles.portReport} onClick={(e) => e.stopPropagation()}>
        <div className={styles.portReportHead}>
          <div>
            <div className={styles.portReportTitle}>Port Report · {port?.iface}</div>
            <div className={styles.portReportSub}>{sw?.host} · {sw?.vendor}</div>
          </div>
          <button className={styles.portReportClose} onClick={onClose} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        <div className={styles.portReportVerdict}>▸ {verdict}</div>

        <div className={styles.portReportBody}>
          <section className={styles.prSection}>
            <h4>Link</h4>
            {link ? (
              <div className={styles.prGrid}>
                <div><span>Status</span><b>{link.status}</b></div>
                <div><span>Speed</span><b>{link.speed}</b></div>
                <div><span>Duplex</span><b>{link.duplex}</b></div>
                <div><span>Flow Ctrl</span><b>{link.flow}</b></div>
                <div><span>Medium</span><b>{link.medium}</b></div>
                <div><span>Description</span><b>{link.description || '—'}</b></div>
              </div>
            ) : <p className={styles.prEmpty}>Link status not captured.</p>}
          </section>

          <section className={styles.prSection}>
            <h4>End device(s) on this port</h4>
            {macs.length === 0 ? (
              <p className={styles.prEmpty}>No MACs learned — port idle or never carried traffic.</p>
            ) : (
              <ul className={styles.prMacList}>
                {macs.map((m, i) => (
                  <li key={i}>
                    <code>{m.mac}</code>
                    <span>VLAN {m.vlan}</span>
                    <span>{m.type}</span>
                  </li>
                ))}
              </ul>
            )}
            {macs.length > 1 && (
              <p className={styles.prHint}>
                Multiple MACs on this port — likely a downstream switch, hub, or access point.
              </p>
            )}
          </section>

          <section className={styles.prSection}>
            <h4>LLDP neighbor</h4>
            {lldp ? (
              <div className={styles.prGrid}>
                {lldp.system_name && <div><span>System name</span><b>{lldp.system_name}</b></div>}
                {lldp.chassis_id && <div><span>Chassis ID</span><b>{lldp.chassis_id}</b></div>}
                {lldp.port_id && <div><span>Remote port</span><b>{lldp.port_id}</b></div>}
                {lldp.port_desc && <div><span>Port desc</span><b>{lldp.port_desc}</b></div>}
                {lldp.mgmt_addr && <div><span>Management IP</span><b>{lldp.mgmt_addr}</b></div>}
                {lldp.pvid && <div><span>PVID</span><b>{lldp.pvid}</b></div>}
                {lldp.ttl && <div><span>TTL</span><b>{lldp.ttl}</b></div>}
                {lldp._via && <div><span>Resolved via</span><b>{lldp._via}</b></div>}
                {lldp.system_desc && <div className={styles.prWide}><span>System desc</span><b>{lldp.system_desc}</b></div>}
              </div>
            ) : <p className={styles.prEmpty}>No LLDP neighbor advertised — endpoint does not speak LLDP, or it is disabled.</p>}
          </section>

          <section className={styles.prSection}>
            <h4>Cable</h4>
            {cable ? (
              <ul className={styles.prPairList}>
                {Object.keys(cable).sort().map(pair => (
                  <li key={pair}>
                    Pair {pair}: <b>{cable[pair].status}</b>
                    {cable[pair].length_m != null && <span> @ {cable[pair].length_m}m</span>}
                  </li>
                ))}
              </ul>
            ) : <p className={styles.prEmpty}>Cable diagnostics not run on this port.</p>}
          </section>

          <section className={styles.prSection}>
            <h4>Spanning tree</h4>
            <p className={styles.prEmpty}>{stp?.state ? `STP state: ${stp.state}` : 'STP state unknown.'}</p>
          </section>

          <section className={styles.prSection}>
            <h4>Full transcript</h4>
            <div className={styles.prTranscript}>
              {transcript.map((e, i) => (
                <details key={i} className={styles.prCmd}>
                  <summary>{e.name || 'manual'} — <code>{e.cmd}</code></summary>
                  {e.error
                    ? <pre className={styles.prCmdErr}>{e.error}</pre>
                    : <pre>{e.output || '(no output)'}</pre>}
                </details>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

// ── Switch credentials modal ──────────────────────────────────
// Vendor is locked to TP-Link for now — multi-vendor picker can be
// reintroduced later by restoring VENDOR_CHOICES + the segmented control.
const STATIC_VENDOR = 'tplink';
const STATIC_VENDOR_LABEL = 'TP-Link';

function CredsModal({ initial, onCancel, onSubmit }) {
  const [host, setHost] = useState(initial?.host || '');
  const [user, setUser] = useState(initial?.username || '');
  const [pass, setPass] = useState(initial?.password || '');
  const vendor = STATIC_VENDOR;             // locked to TP-Link for now
  const [enablePass, setEnablePass] = useState(initial?.enablePassword || '');

  // Does the encrypted env store already have user/password? If so, hide
  // those fields and ask for only the switch IP.
  const [credsStatus, setCredsStatus] = useState(null);
  useEffect(() => {
    let cancelled = false;
    setCredsStatus(null);
    fetch(apiUrl(`/api/switch/creds-status?vendor=${encodeURIComponent(vendor)}`))
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(data => { if (!cancelled) setCredsStatus(data); })
      .catch(() => { if (!cancelled) setCredsStatus({ has_username: false, has_password: false, has_enable: false }); });
    return () => { cancelled = true; };
  }, [vendor]);

  const stored = !!(credsStatus?.has_username && credsStatus?.has_password);
  const disabled = !host.trim() || (!stored && (!user.trim() || !pass));

  return (
    <div className={styles.credsBackdrop} onClick={onCancel}>
      <div className={styles.credsModal} onClick={e => e.stopPropagation()}>
        <div className={styles.credsHeader}>
          <div className={styles.vendorStaticPill}>{STATIC_VENDOR_LABEL}</div>
          <button className={styles.credsClose} onClick={onCancel} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        {!stored && (
          <p className={styles.credsHint}>
            Stored only in memory for this session. SSH is used to query LLDP / MAC table on the switch.
          </p>
        )}
        <label className={styles.credsField}>
          <span>Switch IP</span>
          <input className="input" type="text" autoFocus value={host} onChange={e => setHost(e.target.value)} placeholder="e.g. 10.0.0.5"
            onKeyDown={e => e.key === 'Enter' && !disabled && onSubmit(host, user, pass, vendor, enablePass)} />
        </label>

        {!stored && (
          <>
            <label className={styles.credsField}>
              <span>Username</span>
              <input className="input" type="text" value={user} onChange={e => setUser(e.target.value)} autoComplete="username" />
            </label>
            <label className={styles.credsField}>
              <span>Password</span>
              <input className="input" type="password" value={pass} onChange={e => setPass(e.target.value)} autoComplete="current-password"
                onKeyDown={e => e.key === 'Enter' && !disabled && onSubmit(host, user, pass, vendor, enablePass)} />
            </label>
            <label className={styles.credsField}>
              <span>Enable password <span style={{ opacity: 0.6 }}>(optional)</span></span>
              <input className="input" type="password" value={enablePass} onChange={e => setEnablePass(e.target.value)} autoComplete="off"
                placeholder="Only if your switch requires one"
                onKeyDown={e => e.key === 'Enter' && !disabled && onSubmit(host, user, pass, vendor, enablePass)} />
            </label>
          </>
        )}
        <div className={styles.credsActions}>
          <button className={styles.credsCancel} onClick={onCancel}>Cancel</button>
          <button className={styles.credsSubmit} disabled={disabled} onClick={() => onSubmit(host, user, pass, vendor, enablePass)}>Connect →</button>
        </div>
      </div>
    </div>
  );
}

// ── Device picker dropdown ────────────────────────────────────
// 'Unidentified' is a synthetic placeholder the pipeline inserts for rack
// rows where no detector produced a class even at low confidence — hide
// it from the picker (nothing to inspect) while keeping it on the rack
// map / report so the row isn't lost visually.
const HIDDEN_DEVICE_TYPES = new Set(['Empty', 'Closed Unit', 'Unidentified']);

function isDevicePickable(dev) {
  if (!dev || HIDDEN_DEVICE_TYPES.has(dev.class_name)) return false;
  const totalPorts = (dev.port_count || 0)
    + (dev.console_ports?.length || 0)
    + (dev.sfp_ports?.length || 0);
  return totalPorts > 0;
}

// ── All components ───────────────────────────────────────────
function AllDevicesView({ devices, labels, rackId, scanId, originalExt, onBack, embedded = false }) {
  const navigate = useNavigate();
  const { state } = useLocation();
  const safeDevices = Array.isArray(devices) ? devices : [];
  const safeLabels  = Array.isArray(labels)  ? labels  : [];
  const visible = safeDevices
    .map((dev, i) => ({ dev: dev || {}, label: safeLabels[i], idx: i }))
    .filter(({ dev }) => dev && !HIDDEN_DEVICE_TYPES.has(dev.class_name));

  const [selectedCard, setSelectedCard] = useState(null);
  const [imgNat, setImgNat] = useState(null);
  const heroSrc = apiUrl(`/outputs/${scanId}/original_image.${originalExt || 'png'}`);

  // CMDB approval modal — shows once after a fresh detect-mode scan when
  // the rack isn't yet registered in CMDB. Skipped for ticket-mode scans
  // (which are investigating a specific incident on a known device) and
  // for navigation arrivals without a fresh scan (history, back button).
  const cmdbRackId = rackId || scanId;
  const isFreshDetectScan = !!state?.result && !state?.ticketMode;
  const [cmdbTicket, setCmdbTicket] = useState(null);
  const [cmdbModalOpen, setCmdbModalOpen] = useState(false);
  const dismissKey = cmdbRackId ? `rt_cmdbModalDismissed_${cmdbRackId}` : null;

  useEffect(() => {
    if (!cmdbRackId || !isFreshDetectScan) return;
    const dismissed = dismissKey && sessionStorage.getItem(dismissKey) === '1';
    if (dismissed) return;

    // Server auto-creates the CMDB ticket ~4s after canonical scan write.
    // Poll the status endpoint for up to 25s, then surface the modal once
    // we see an open ticket with missing-data summary.
    let cancelled = false;
    let attempt = 0;
    const maxAttempts = 12;     // 12 × 2s = 24s
    const intervalMs = 2000;

    const tick = async () => {
      if (cancelled) return;
      try {
        const r = await authFetch(apiUrl(`/api/cmdb/ticket/${cmdbRackId}`));
        const d = await r.json();
        if (cancelled) return;
        const t = d?.ticket || null;
        if (t) setCmdbTicket(t);
        const hasMissing = t && t.state === 'open' &&
          ((t.summary?.added_devices ?? 0) > 0 ||
           (t.summary?.added_ports   ?? 0) > 0 ||
           (t.summary?.changed_devices ?? 0) > 0);
        if (hasMissing) {
          setCmdbModalOpen(true);
          return;             // stop polling
        }
        if (t && t.state === 'applied') return;   // already in CMDB
      } catch (_) { /* keep polling */ }
      attempt += 1;
      if (attempt < maxAttempts) {
        setTimeout(tick, intervalMs);
      }
    };
    // Wait 1s before the first attempt so the server's debounced
    // auto-create has a chance to fire.
    const initial = setTimeout(tick, 1000);
    return () => { cancelled = true; clearTimeout(initial); };
  }, [cmdbRackId, dismissKey, isFreshDetectScan]);

  const closeCmdbModal = () => {
    setCmdbModalOpen(false);
    if (dismissKey) {
      try { sessionStorage.setItem(dismissKey, '1'); } catch (_) {}
    }
  };

  const allBody = (
      <div className={embedded ? styles.tabContent : styles.allWrap}>
        {cmdbModalOpen && cmdbRackId && (
          <CmdbApprovalModal
            rackId={cmdbRackId}
            ticket={cmdbTicket}
            onTicketUpdate={(t) => setCmdbTicket(t)}
            onClose={closeCmdbModal}
          />
        )}
        {/* Show rack image with selected device highlighted */}
        {selectedCard !== null && (
          <div className={styles.resultHero}>
            <img src={heroSrc} alt="Rack" className={styles.heroImg}
              onLoad={e => setImgNat({ w: e.target.naturalWidth, h: e.target.naturalHeight })} />
            {imgNat && (() => {
              const dev = safeDevices[selectedCard];
              if (!dev?.box) return null;
              const [bx1, by1, bx2, by2] = dev.box;
              const w = bx2 - bx1, h = by2 - by1;
              return (
                <svg className={styles.devOverlay} viewBox={`0 0 ${imgNat.w} ${imgNat.h}`} preserveAspectRatio="xMidYMid meet">
                  <defs>
                    <filter id="neonAll">
                      <feGaussianBlur in="SourceGraphic" stdDeviation="4" result="blur" />
                      <feMerge><feMergeNode in="blur" /><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
                    </filter>
                  </defs>
                  <rect x={bx1} y={by1} width={w} height={h} rx="6"
                    fill="none" stroke={getColor(dev.class_name)} strokeWidth="3" filter="url(#neonAll)"
                    className={styles.devNeonBorder} />
                </svg>
              );
            })()}
          </div>
        )}

        {visible.length === 0 ? (
          <div className={styles.empty}>
            <p>No components detected.</p>
            <button className="btn btn-primary" onClick={onBack}>Back to scan results</button>
          </div>
        ) : (
          <div className={styles.allCards}>
            {visible.map(({ dev, label, idx }, i) => {
              const c = getColor(dev.class_name);
              const units = formatUnitsRange(dev.units)?.toUpperCase() || '—';
              const active = selectedCard === idx;
              return (
                <div key={i} className={styles.allCard}
                  style={active ? { borderColor: c, background: `${c}11` } : undefined}
                  onClick={() => setSelectedCard(active ? null : idx)}>
                  <div className={styles.allCardBar} style={{ background: c }} />
                  <div className={styles.allCardBody}>
                    <div className={styles.allCardTop}>
                      <span className={styles.allCardLabel} style={{ color: c }}>{label}</span>
                      <span className={styles.allCardType}>{dev.class_name}</span>
                    </div>
                    <div className={styles.allCardBottom}>
                      <span className={styles.allCardUnit}>
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="2" y="3" width="20" height="18" rx="2"/><line x1="2" y1="9" x2="22" y2="9"/>
                        </svg>
                        {units}
                      </span>
                      <span className={styles.allCardPorts}>
                        {dev.port_count > 0 && <span className={styles.portPill}>{dev.port_count}p</span>}
                        {dev.console_ports?.length > 0 && <span className={styles.portPillC}>{dev.console_ports.length}c</span>}
                        {dev.sfp_ports?.length > 0 && <span className={styles.portPillS}>{dev.sfp_ports.length}s</span>}
                        {!dev.port_count && !dev.console_ports?.length && !dev.sfp_ports?.length && (
                          <span className={styles.noPorts}>—</span>
                        )}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
  );

  if (embedded) return allBody;

  return (
    <div className={styles.allPage}>
      <div className={styles.amb} />
      <header className={styles.header} style={{ position: 'sticky', top: 0 }}>
        <button className="btn btn-ghost btn-icon" onClick={onBack}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
          </svg>
        </button>
        <div className={styles.headerCenter}>
          <h2 className={styles.headerTitle}>All Components</h2>
          <span className={styles.headerMono}>{rackId ? `${rackId} · ` : ''}{visible.length} devices</span>
        </div>
        <div style={{ width: 40 }} />
      </header>
      {allBody}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────
export default function ResultsPage() {
  const navigate = useNavigate();
  const { state } = useLocation();
  const { rackId: urlRackId } = useParams();
  // Two ways to land here:
  //   1. ScanPage navigated with state.result = full /api/analyze response
  //   2. RackTabs navigated to /results/<rackId> (no state) — fetch via API
  const [fetchedResult, setFetchedResult] = useState(null);
  const result = state?.result || fetchedResult;

  // Cold-link / rack-tab-switch path: when there's no state but the URL
  // carries a rackId, hit /api/scan/:rackId once to materialize the same
  // payload shape ScanPage's analyze response would provide.
  useEffect(() => {
    if (state?.result || !urlRackId) return;
    if (fetchedResult?.rackId === urlRackId) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await authFetch(apiUrl(`/api/scan/${encodeURIComponent(urlRackId)}`));
        if (!r.ok) return;
        const data = await r.json();
        if (!cancelled) setFetchedResult(data);
      } catch { /* leave fetchedResult null — page renders an empty state */ }
    })();
    return () => { cancelled = true; };
  }, [urlRackId, state?.result, fetchedResult?.rackId]);

  const [selectedIdx, setSelectedIdx] = useState(null);
  const [portNum,     setPortNum]     = useState('');
  const [phase,       setPhase]       = useState('detect');
  const [tab,         setTab]         = useState('overview');
  const [resultImg,   setResultImg]   = useState(null);
  const [portInfo,    setPortInfo]    = useState(null);
  const [zoom,        setZoom]        = useState(1);
  const [offset,      setOffset]      = useState({ x: 0, y: 0 });
  const [imgNat,      setImgNat]      = useState(null);
  const [dragStart,   setDragStart]   = useState(null);
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState(null);
  const [nextPort,  setNextPort]  = useState('');
  const [rackImg,   setRackImg]   = useState(null);
  const [portView,  setPortView]  = useState('rack'); // 'rack' → 'device' → 'zoom' → 'rack'
  const [feedbackStatus, setFeedbackStatus] = useState('idle'); // 'idle' | 'wrong-port' | 'wrong-color' | 'submitting' | 'submitted' | 'hidden'
  const [actualPortInput, setActualPortInput] = useState('');
  const [actualCableColor, setActualCableColor] = useState('');
  const [feedbackError, setFeedbackError] = useState(null);
  // Device-classification feedback (separate flow)
  const [deviceFbStatus, setDeviceFbStatus] = useState('idle'); // 'idle' | 'wrong-pending' | 'submitting' | 'submitted' | 'hidden'
  const [actualDeviceClass, setActualDeviceClass] = useState('');
  const [deviceFbError, setDeviceFbError] = useState(null);
  // Port-count feedback (main ports detected per device — separate flow)
  const [portCountFbStatus, setPortCountFbStatus] = useState('idle');
  const [actualPortCount, setActualPortCount] = useState('');
  const [portCountFbError, setPortCountFbError] = useState(null);
  // Developer diagnostics (timings + confidences)
  const [portTimings, setPortTimings] = useState(null);
  const [devOpen, setDevOpen] = useState(() => {
    try { return localStorage.getItem('rt_devOpen') === '1'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem('rt_devOpen', devOpen ? '1' : '0'); } catch { /* ignore */ }
  }, [devOpen]);
  const [reportOpen, setReportOpen] = useState(false);
  const [sessionPorts, setSessionPorts] = useState([]); // [{deviceIdx, port, deviceLabel, deviceClass, status}]
  const [shareStatus, setShareStatus] = useState('idle'); // 'idle' | 'sending' | 'sent' | 'error'
  const [shareMsg, setShareMsg] = useState(null);
  const [shareChannel, setShareChannel] = useState(null); // 'slack' | 'teams' | 'outlook'
  const [shareMenuOpen, setShareMenuOpen] = useState(false);
  // Recipient prompt — channel is the active dialog (null = closed). Email +
  // optional note (Outlook subject / Teams + Slack message) are filled by the user.
  const [shareDialogChannel, setShareDialogChannel] = useState(null);
  const [shareEmailInput, setShareEmailInput] = useState('');
  const [shareNoteInput, setShareNoteInput]   = useState('');
  const [shareEmailErr, setShareEmailErr]     = useState(null);
  // Switch SSH / LLDP neighbor lookup — credentials held in memory only.
  // Host defaults to the in-office switch so the LLDP pre-fetch can fire
  // automatically as soon as a port is picked. Username/password still come
  // from the encrypted server-side store or the creds modal.
  const [switchCreds, setSwitchCreds] = useState({ host: '192.168.1.13', username: '', password: '', vendor: 'tplink', enablePassword: '' });
  // Track which port the in-flight LLDP call belongs to, so a rapid port
  // switch doesn't overwrite the current result with a stale one.
  const neighborPortRef = useRef(null);
  const [credsOpen, setCredsOpen] = useState(false);
  const [neighborStatus, setNeighborStatus] = useState('idle'); // 'idle' | 'loading' | 'ok' | 'empty' | 'error'
  const [neighbor, setNeighbor] = useState(null);
  const [neighborMethod, setNeighborMethod] = useState(null); // 'lldp' | 'cdp' | 'mac_arp' | 'mac_only' | 'none'
  const [neighborChain, setNeighborChain] = useState(null);
  const [neighborErr, setNeighborErr] = useState(null);
  const [neighborDetailsOpen, setNeighborDetailsOpen] = useState(false);
  // Console sheet state
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [consoleEntries, setConsoleEntries] = useState([]);
  const [consoleStatus, setConsoleStatus] = useState('idle'); // 'idle' | 'running-auto' | 'running-manual' | 'ready' | 'error'
  const [consolePlan, setConsolePlan] = useState([]);            // planned commands emitted by the server at stream start
  const [runningIdx, setRunningIdx] = useState(-1);              // index of command currently executing
  const [manualCmd, setManualCmd] = useState('');
  // Detailed per-port console report (shown when the user presses "Done")
  const [portReportOpen, setPortReportOpen] = useState(false);
  const [portReport, setPortReport] = useState(null);
  // Switch Info modal — live SSH snapshot, independent of CMDB/Netdisco.
  const [switchInfoOpen, setSwitchInfoOpen] = useState(false);
  const [switchInfoStatus, setSwitchInfoStatus] = useState('idle'); // 'idle' | 'loading' | 'ready' | 'error'
  const [switchInfoData, setSwitchInfoData] = useState(null);
  const [switchInfoRaw, setSwitchInfoRaw] = useState('');
  const [switchInfoError, setSwitchInfoError] = useState(null);
  // Specifications + firmware-update lookups — fired after we have a model
  // from SSH. Independent of the SSH call so a slow vendor scrape doesn't
  // hold back the basic info section.
  const [switchSpecs, setSwitchSpecs] = useState(null);
  const [switchSpecsStatus, setSwitchSpecsStatus] = useState('idle'); // 'idle' | 'loading' | 'ready' | 'error' | 'skipped'
  const [switchSpecsError, setSwitchSpecsError] = useState(null);
  const [switchFirmware, setSwitchFirmware] = useState(null);
  const [switchFirmwareStatus, setSwitchFirmwareStatus] = useState('idle'); // 'idle' | 'loading' | 'ready' | 'error' | 'skipped'
  const [switchFirmwareError, setSwitchFirmwareError] = useState(null);
  const consoleTermRef = useRef(null);
  // Auto-scroll the console terminal to the bottom as entries stream in so
  // the user always sees the latest command / output, not the first one.
  useEffect(() => {
    const el = consoleTermRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [consoleEntries.length, runningIdx, consolePlan.length]);
  // After which action: the console was invoked with creds already — otherwise we prompt.
  const [pendingConsoleOpen, setPendingConsoleOpen] = useState(false);
  // How long the auto-run took to complete (ms). Set when the stream ends.
  const [consoleRunMs, setConsoleRunMs] = useState(null);
  const consoleRunStartRef = useRef(null);
  // Track whether an auto-run is currently in flight so we don't fire two
  // concurrent SSH sessions if creds get re-submitted or the console is
  // opened mid-run.
  const autoRunInFlightRef = useRef(false);
  // ── Intent dropdown state ──
  // List of {id, label, cmd} fetched from the server based on switch vendor.
  const [consoleIntents, setConsoleIntents] = useState([]);
  const [selectedIntentId, setSelectedIntentId] = useState('');
  // ── Switch credentials status (per vendor, booleans only) ──
  // True when the encrypted env store already has user/pass for this vendor —
  // lets the page send requests with just `host` and have the server fill
  // username/password from the encrypted store on its side.
  const [credsStatus, setCredsStatus] = useState({ has_username: false, has_password: false, has_enable: false });
  useEffect(() => {
    const vendor = switchCreds.vendor || 'tplink';
    let cancelled = false;
    fetch(apiUrl(`/api/switch/creds-status?vendor=${encodeURIComponent(vendor)}`))
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(d => { if (!cancelled) setCredsStatus(d); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [switchCreds.vendor]);

  // Fetch the intent dropdown for the current vendor whenever the console
  // sheet is opened. Cheap GET, no SSH, no automation.
  useEffect(() => {
    if (!consoleOpen) return;
    const vendor = switchCreds.vendor || 'tplink';
    let cancelled = false;
    let attempt = 0;
    const tryFetch = () => {
      authFetch(apiUrl(`/api/switch/console/intents?vendor=${encodeURIComponent(vendor)}`))
        .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
        .then(data => {
          if (cancelled) return;
          setConsoleIntents(data.intents || []);
        })
        .catch((err) => {
          if (cancelled) return;
          attempt += 1;
          // One quick retry — covers transient WebView/network hiccups.
          if (attempt < 2) {
            setTimeout(tryFetch, 600);
          } else {
            console.warn('[console] intent fetch failed:', err?.message || err);
            setConsoleIntents([]);
          }
        });
    };
    tryFetch();
    return () => { cancelled = true; };
  }, [consoleOpen, switchCreds.vendor]);

  const { scanId, rackId, cached, devices: initialDevices = [], units_detected = [], originalExt, qualityWarning, qualityWarningMsg, timings: analysisTimings } = result || {};
  const [fetchedOcrLabels, setFetchedOcrLabels] = useState(null);
  // Prefer the bundle ScanPage handed us via navigation state (front+rear merge
  // from RearImagePrompt); on cold-load (refresh / History / Profile route)
  // fall back to a fetched bundle so detected labels survive a page reload.
  const ocrLabels = state?.ocrLabels || fetchedOcrLabels;
  const [warningDismissed, setWarningDismissed] = useState(false);

  // ── Ticket-mode bootstrapping ──
  // When ScanPage routed us here with a ticket-driven bundled payload, skip
  // the device picker entirely and jump straight into the port view.
  const ticketMode = !!state?.ticketMode;
  const ticket = state?.ticket || null;
  const lldp = result?.lldp || null;
  const ticketResolved = result?.resolved || null;

  // ── Live port monitoring (ticket mode only) ──
  // Polls /api/switch/port-status every 5s while we're in the port view of a
  // ticket. Surfaces a "cable attached — problem solved" banner as soon as
  // the port transitions from "no activity" (no neighbor, no MACs) to active.
  const [liveSnapshot, setLiveSnapshot] = useState(null);
  const [liveLastAt,   setLiveLastAt]   = useState(null);
  const [liveResolvedAt, setLiveResolvedAt] = useState(null); // set when we detect transition to active
  const liveInFlightRef = useRef(false);
  const livePrevActiveRef = useRef(null); // null = no reading yet
  const LIVE_POLL_MS = 5000;
  const [ticketReportOpen, setTicketReportOpen] = useState(false);
  useEffect(() => {
    if (!ticketMode || !result) return;
    // Drift case: a dedicated early-return render handles it; just don't
    // switch to the port phase (there's no port to pinpoint).
    if (result.driftDetected) return;
    if (!ticketResolved) return;
    setSelectedIdx(ticketResolved.device_index);
    setPortNum(String(ticketResolved.port));
    if (result.resultImageUrl) setResultImg(apiUrl(result.resultImageUrl));
    if (result.rackImageUrl)   setRackImg(apiUrl(result.rackImageUrl));
    if (result.portInfo)       setPortInfo(result.portInfo);
    // Don't pre-populate neighbor state here — the native LLDP panel
    // auto-fires against the configured switch host (which is the reachable
    // real switch) and shows live data. Our server-side LLDP against CMDB's
    // mgmt_ip is best-effort and may fail for demo IPs.
    setPhase('port');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live polling loop: in ticket-mode port phase, hit /api/switch/port-status
  // every LIVE_POLL_MS. Uses the configured switchCreds.host (which is the
  // real reachable switch). The interface name must match the vendor dialect
  // (TP-Link expects "1/0/15", Cisco IOS expects "Gi1/0/15") — derive from
  // the ticket's raw port number using VENDOR_IFACE.
  useEffect(() => {
    if (!ticketMode || phase !== 'port') return;
    const host = switchCreds.host || ticket?.cmdb?.mgmt_ip;
    const vendor = switchCreds.vendor || 'tplink';
    const ifaceFn = VENDOR_IFACE[vendor] || VENDOR_IFACE['tplink'];
    const portNumber = ticket?.target?.port;
    if (!host || portNumber == null) return;
    const iface = ifaceFn(portNumber);

    let cancelled = false;

    const tick = async () => {
      if (cancelled || liveInFlightRef.current) return;
      liveInFlightRef.current = true;
      try {
        const res = await fetch(apiUrl('/api/switch/port-status'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            host,
            interface: iface,
            vendor,
            username: switchCreds.username || undefined,
            password: switchCreds.password || undefined,
            enablePassword: switchCreds.enablePassword || undefined,
          }),
        });
        const data = await res.json().catch(() => null);
        if (cancelled || !data) return;
        setLiveSnapshot(data);
        setLiveLastAt(Date.now());
        const nowActive = !!data.link_active;
        const prev = livePrevActiveRef.current;
        // Transition detection: prev was observed inactive → now active → resolved.
        if (prev === false && nowActive && !liveResolvedAt) {
          setLiveResolvedAt(Date.now());
        }
        if (data.ok) livePrevActiveRef.current = nowActive;
      } catch { /* swallow transient network errors; next tick tries again */ }
      finally { liveInFlightRef.current = false; }
    };

    tick(); // fire immediately, then interval
    const id = setInterval(tick, LIVE_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticketMode, phase, ticket?.incident_number, switchCreds.host, switchCreds.vendor]);

  // Auto-fire the native LLDP panel (the "LINKED ENDPOINT" card) in ticket
  // mode so the user doesn't have to press "Find end device". The normal
  // code paths that call findNeighbor after port-select don't run in
  // ticket-mode because we jump straight into phase='port'.
  useEffect(() => {
    if (!ticketMode || phase !== 'port') return;
    if (neighborStatus !== 'idle') return;
    const p = ticket?.target?.port;
    if (!p) return;
    findNeighbor(null, { port: p, silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticketMode, phase, ticket?.target?.port, switchCreds.host, switchCreds.vendor, credsStatus.has_username, credsStatus.has_password]);
  // Mutable copy of devices so feedback-triggered re-labels (port count) can
  // patch a single entry without round-tripping the whole result. Reset only
  // when the scan itself changes — not on every render (result destructures
  // create a new array reference each pass).
  const [devices, setDevices] = useState(initialDevices);
  useEffect(() => { setDevices(initialDevices); }, [scanId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Refresh from the server on mount: navigation state can be stale (e.g. when
  // the page is reached via History/Profile, which serve cached fullResult
  // from localStorage, or after a backend re-detection updated device_unit_map.json).
  // We fetch /api/scan/:rackId and overwrite the devices array so port counts
  // and per-port detection reflect what's actually on disk right now.
  useEffect(() => {
    if (!scanId) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await authFetch(apiUrl(`/api/scan/${scanId}`));
        if (!r.ok) return;
        const fresh = await r.json();
        if (cancelled) return;
        if (Array.isArray(fresh.devices)) setDevices(fresh.devices);
      } catch { /* network blip — keep what we have */ }
    })();
    return () => { cancelled = true; };
  }, [scanId]);

  // Always fetch /api/ocr/labels/:rackId on mount so refresh, deep-link, and
  // navigation-from-history routes pick up the latest OCR-derived names and
  // reclassifications. We still honor a navigation-state bundle from ScanPage
  // (RearImagePrompt) as a fast path, but only if it carries the modern shape
  // (pattern + reclassifications). Older shapes are ignored — otherwise stale
  // state silently suppresses the network call and the page renders with the
  // synthesized fallback even though the server has correct data.
  useEffect(() => {
    if (!scanId) return;
    const stateBundle = state?.ocrLabels;
    const stateIsModern = stateBundle && ('pattern' in stateBundle || 'reclassifications' in stateBundle);
    if (stateIsModern) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await authFetch(apiUrl(`/api/ocr/labels/${encodeURIComponent(scanId)}`));
        if (!r.ok) return;
        const data = await r.json();
        if (cancelled) return;
        const hasLabels = Array.isArray(data?.deviceLabels) && data.deviceLabels.some(d => d.label);
        const hasReclass = Array.isArray(data?.reclassifications) && data.reclassifications.length > 0;
        if (hasLabels || data?.pattern || hasReclass) setFetchedOcrLabels(data);
      } catch { /* ignore — fall back to synthesized names */ }
    })();
    return () => { cancelled = true; };
  }, [scanId, state?.ocrLabels]);

  const fmtMs = (ms) => {
    if (ms == null || isNaN(ms)) return '—';
    return `${(ms / 1000).toFixed(2)} s`;
  };
  const fmtPct = (v) => {
    if (v == null || isNaN(v)) return '—';
    return `${Math.round(Number(v) * 100)}%`;
  };
  const heroImgSrc = resultImg || apiUrl(`/outputs/${scanId}/original_image.${originalExt || 'png'}`);

  // Apply brand-token reclassifications from the OCR labels endpoint, so a
  // Planar AV controller YOLO labelled as UPS gets bumped to "Controller" for
  // both naming and rendering. Synthesizing labels reads class_name, so the
  // override must precede buildDeviceLabels.
  const effectiveDevices = useMemo(() => {
    const reclass = ocrLabels?.reclassifications;
    if (!Array.isArray(reclass) || reclass.length === 0) return devices;
    const byIdx = new Map(reclass.map(r => [r.device_index, r]));
    return devices.map((dev, idx) => {
      const r = byIdx.get(idx);
      if (!r || !r.class_name || r.class_name === dev?.class_name) return dev;
      return { ...dev, class_name: r.class_name, _reclassifiedFrom: dev.class_name, _reclassifiedBrand: r.brand };
    });
  }, [devices, ocrLabels]);

  const labels = useMemo(() => {
    const pattern = ocrLabels?.pattern || null;
    const generated = buildDeviceLabels(effectiveDevices, units_detected, pattern);

    // If we have OCR labels, use them preferentially, falling back to the
    // pattern-derived synthetic names from buildDeviceLabels.
    if (ocrLabels && Array.isArray(ocrLabels.deviceLabels)) {
      return effectiveDevices.map((_, idx) => {
        const ocr = ocrLabels.deviceLabels.find(d => d.device_index === idx);
        const synthetic = generated[idx] || `Device ${idx}`;
        if (ocr?.label && (ocr.conf || 0) >= 0.4) return ocr.label;
        return synthetic;
      });
    }

    return generated;
  }, [effectiveDevices, units_detected, ocrLabels]);

  const clampZoom = (value) => Math.min(2.5, Math.max(0.8, value));
  const zoomIn = () => setZoom((prev) => clampZoom(prev + 0.15));
  const zoomOut = () => setZoom((prev) => clampZoom(prev - 0.15));
  const resetZoom = () => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  };
  const handleWheel = (event) => {
    event.preventDefault();
    const delta = event.deltaY < 0 ? 0.15 : -0.15;
    setZoom((prev) => clampZoom(prev + delta));
  };
  const handlePointerDown = (event) => {
    if (event.button !== 0) return;
    // Only engage pan when zoomed in — otherwise capturing the pointer would
    // swallow taps meant for the device rectangles on the hero overlay.
    if (zoom <= 1) return;
    setDragStart({ x: event.clientX, y: event.clientY });
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const handlePointerMove = (event) => {
    if (!dragStart) return;
    const dx = event.clientX - dragStart.x;
    const dy = event.clientY - dragStart.y;
    setOffset((prev) => ({ x: prev.x + dx, y: prev.y + dy }));
    setDragStart({ x: event.clientX, y: event.clientY });
  };
  const handlePointerUp = (event) => {
    if (!dragStart) return;
    setDragStart(null);
    event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const handlePointerCancel = (event) => {
    if (!dragStart) return;
    setDragStart(null);
    event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const handlePointerLeave = () => {
    if (!dragStart) return;
    setDragStart(null);
  };
  const cursorStyle = zoom > 1 ? (dragStart ? 'grabbing' : 'grab') : 'zoom-in';
  const imageTransform = `translate(${offset.x / zoom}px, ${offset.y / zoom}px) scale(${zoom})`;

  useEffect(() => {
    if (!result) return;
    const existing = JSON.parse(localStorage.getItem('rackTrackHistory') || '[]');
    const history  = Array.isArray(existing) ? existing : [];
    if (!history.some(h => h.scanId === result.scanId)) {
      history.unshift({
        scanId: result.scanId, timestamp: result.timestamp, severity: 'info',
        incidentLabel: labels[0] || 'Rack scan',
        componentLabel: `${devices.length} devices`,
        scanSummary: `${formatUnitsRange(units_detected) || `${units_detected.length} units`} scanned`,
        imageUrl: result.imageUrl, fullResult: result,
      });
      localStorage.setItem('rackTrackHistory', JSON.stringify(history.slice(0, 12)));
    }
  }, [result]);

  if (!result) {
    // Deep-linked /results/:rackId — fetch in flight. Show a benign
    // loading state instead of the cold "No scan result" panel.
    if (urlRackId) {
      return (
        <div className={`page page-full ${styles.results}`}>
          <div className={styles.empty}><p>Loading rack {urlRackId}…</p></div>
        </div>
      );
    }
    return (
      <div className={`page page-full ${styles.results}`}>
        <div className={styles.empty}>
          <p>No scan result.</p>
          <button className="btn btn-primary" onClick={() => navigate('/scan')}>Start a Scan</button>
        </div>
      </div>
    );
  }

  // phase='all' is now handled by the 'all' tab — no early return needed

  const selectedDevice = selectedIdx ? effectiveDevices[selectedIdx - 1] : null;
  const selectedLabel  = selectedIdx ? labels[selectedIdx - 1]  : null;
  const selColor       = selectedDevice ? getColor(selectedDevice.class_name) : DEFAULT_COLOR;
  const cableInfo      = parseCableType(portInfo?.cable_type);

  const findPort = async (forcedPort) => {
    const portArg = forcedPort != null ? String(forcedPort) : portNum;
    if (!selectedDevice || !portArg) return;
    const p = parseInt(portArg, 10);
    if (isNaN(p) || p < 1 || (selectedDevice.port_count > 0 && p > selectedDevice.port_count)) {
      setError(selectedDevice.port_count > 0
        ? `Port must be between 1 and ${selectedDevice.port_count}`
        : 'Invalid port number');
      return;
    }
    if (forcedPort != null) setPortNum(String(forcedPort));
    setLoading(true); setError(null);
    try {
      const res  = await fetch(apiUrl('/api/select'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scanId, device_index: selectedIdx, port: p }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Port detection failed');
      setResultImg(apiUrl(data.resultImageUrl));
      setRackImg(data.rackImageUrl ? apiUrl(data.rackImageUrl) : null);
      setPortView('rack');
      setPortInfo(data.portInfo || null);

      setPortTimings(data.timings || null);
      resetFeedback();
      setNeighborStatus('idle');
      setNeighbor(null);
      setNeighborErr(null);
      setConsoleEntries([]);
      setConsoleStatus('idle');
      setManualCmd('');
      setSessionPorts(prev => {
        const next = prev.filter(sp => !(sp.deviceIdx === selectedIdx && sp.port === p));
        next.push({
          deviceIdx: selectedIdx,
          port: p,
          deviceLabel: labels[selectedIdx - 1] || `Device ${selectedIdx}`,
          deviceClass: selectedDevice?.class_name || '',
          status: data.portInfo?.status || null,
        });
        return next;
      });
      setPhase('port');
      // Pre-fetch the LLDP neighbour in the background so end-device info
      // is ready by the time the user looks for it — silent on missing creds.
      findNeighbor(null, { port: p, silent: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const portLabel = selectedLabel && portNum
    ? buildPortLabel(selectedLabel, selectedDevice?.class_name, portNum)
    : null;

  // step state: 0=idle, 1=device selected, 2=port filled

  // ── Port result ──────────────────────────────────────────
  // ── Find another port on the same device ──
  const findAnotherPort = async (forcedPort) => {
    const portArg = forcedPort != null ? String(forcedPort) : nextPort;
    if (!selectedDevice || !portArg) return;
    const p = parseInt(portArg, 10);
    if (isNaN(p) || p < 1 || (selectedDevice.port_count > 0 && p > selectedDevice.port_count)) {
      setError(selectedDevice.port_count > 0
        ? `Port must be between 1 and ${selectedDevice.port_count}`
        : 'Invalid port number');
      return;
    }
    setLoading(true); setError(null);
    try {
      const res  = await fetch(apiUrl('/api/select'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scanId, device_index: selectedIdx, port: p }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Port detection failed');
      setResultImg(apiUrl(data.resultImageUrl) + '?t=' + Date.now());
      setRackImg(data.rackImageUrl ? apiUrl(data.rackImageUrl) + '?t=' + Date.now() : null);
      setPortView('rack');
      setPortInfo(data.portInfo || null);

      setPortTimings(data.timings || null);
      setPortNum(String(p));
      setNextPort('');
      resetFeedback();
      setNeighborStatus('idle');
      setNeighbor(null);
      setNeighborErr(null);
      setConsoleEntries([]);
      setConsoleStatus('idle');
      setManualCmd('');
      setSessionPorts(prev => {
        const next = prev.filter(sp => !(sp.deviceIdx === selectedIdx && sp.port === p));
        next.push({
          deviceIdx: selectedIdx,
          port: p,
          deviceLabel: labels[selectedIdx - 1] || `Device ${selectedIdx}`,
          deviceClass: selectedDevice?.class_name || '',
          status: data.portInfo?.status || null,
        });
        return next;
      });
      findNeighbor(null, { port: p, silent: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const reloadSessionPort = async (entry) => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(apiUrl('/api/select'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scanId, device_index: entry.deviceIdx, port: entry.port }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Port detection failed');
      setSelectedIdx(entry.deviceIdx);
      setPortNum(String(entry.port));
      setResultImg(apiUrl(data.resultImageUrl) + '?t=' + Date.now());
      setRackImg(data.rackImageUrl ? apiUrl(data.rackImageUrl) + '?t=' + Date.now() : null);
      setPortView('rack');
      setPortInfo(data.portInfo || null);

      setPortTimings(data.timings || null);
      resetFeedback();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Interface name differs by vendor CLI; keep this table in sync with server VENDORS.
  const VENDOR_IFACE = {
    'cisco-ios': (p) => `Gi1/0/${p}`,
    'dlink':     (p) => String(p),
    'tplink':    (p) => `1/0/${p}`,
  };
  const deriveInterface = (p) => (VENDOR_IFACE[switchCreds.vendor] || VENDOR_IFACE['tplink'])(p);

  const findNeighbor = async (credsOverride, opts = {}) => {
    const { port: portOverride, silent = false } = opts;
    const creds = credsOverride || switchCreds;
    const targetPort = portOverride != null ? portOverride : portNum;
    // Host is always required from the user. User/pass can come from the
    // encrypted env store on the server side — if it has them, the client
    // doesn't need to ask.
    const userOk = !!creds.username || credsStatus.has_username;
    const passOk = !!creds.password || credsStatus.has_password;
    if (!creds.host || !userOk || !passOk) {
      // In background mode we just bail silently instead of popping the
      // creds modal on top of the user.
      if (silent) return;
      setCredsOpen(true);
      return;
    }
    if (!targetPort) return;
    neighborPortRef.current = String(targetPort);
    setNeighborStatus('loading'); setNeighborErr(null); setNeighbor(null);
    try {
      const vendor = creds.vendor || 'tplink';
      const ifaceFn = VENDOR_IFACE[vendor] || VENDOR_IFACE['tplink'];
      const res = await fetch(apiUrl('/api/switch/lldp-neighbor'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host: creds.host,
          username: creds.username,
          password: creds.password,
          enablePassword: creds.enablePassword || '',
          interface: ifaceFn(targetPort),
          vendor,
        }),
      });
      const data = await res.json();
      // Drop stale response: the user moved to a different port while this
      // was in flight.
      if (neighborPortRef.current !== String(targetPort)) return;
      if (!res.ok || !data.ok) throw new Error(data.error || 'Lookup failed');
      setNeighbor(data.neighbor);
      setNeighborMethod(data.method || null);
      setNeighborChain(data.chain || null);
      setNeighborDetailsOpen(false);
      setNeighborStatus(data.neighbor?.found ? 'ok' : 'empty');
    } catch (err) {
      if (neighborPortRef.current !== String(targetPort)) return;
      if (silent) { setNeighborStatus('idle'); return; }
      setNeighborErr(err.message);
      setNeighborStatus('error');
    }
  };

  const submitCreds = (host, username, password, vendor, enablePassword) => {
    const next = { host: host.trim(), username: username.trim(), password, vendor: vendor || 'tplink', enablePassword: enablePassword || '' };
    setSwitchCreds(next);
    setCredsOpen(false);
    // No automatic console run any more — user picks an action from the
    // intent dropdown inside the console sheet.
    if (pendingConsoleOpen) {
      setPendingConsoleOpen(false);
      setConsoleOpen(true);
    } else {
      // "Find another end of device" is the only auto-fired action — and
      // only when that's why we asked for creds.
      findNeighbor(next);
    }
  };

  // Streams the predefined console commands one-at-a-time via SSE.
  // Runs in the background — does NOT open the console sheet. The user can
  // open the sheet later to watch live progress / inspect completed entries.
  const startAutoConsoleRun = async (credsOverride) => {
    const creds = credsOverride || switchCreds;
    if (!creds.host || !creds.username || !creds.password) return;
    if (!portNum) return;
    if (autoRunInFlightRef.current) return; // already running
    autoRunInFlightRef.current = true;

    setConsoleStatus('running-auto');
    setConsoleEntries([]);
    setConsolePlan([]);
    setRunningIdx(-1);
    setPortReportOpen(false);
    setPortReport(null);
    setConsoleRunMs(null);
    consoleRunStartRef.current = Date.now();

    const vendor = creds.vendor || 'tplink';
    const ifaceFn = VENDOR_IFACE[vendor] || VENDOR_IFACE['tplink'];
    const iface = ifaceFn(portNum);

    try {
      const res = await fetch(apiUrl('/api/switch/console/run-auto-stream'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
        body: JSON.stringify({
          host: creds.host,
          username: creds.username,
          password: creds.password,
          enablePassword: creds.enablePassword || '',
          interface: iface,
          vendor,
          scanId,
          device_index: selectedIdx,
          port: parseInt(portNum, 10),
        }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // SSE frames are separated by a blank line.
        let sep;
        while ((sep = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            let msg;
            try { msg = JSON.parse(payload); } catch { continue; }
            if (msg.type === 'plan') {
              setConsolePlan(msg.commands || []);
            } else if (msg.type === 'running') {
              setRunningIdx(msg.i);
            } else if (msg.type === 'entry') {
              setConsoleEntries(prev => [...prev, msg.entry]);
            } else if (msg.type === 'done') {
              setRunningIdx(-1);
              setConsoleStatus('ready');
              if (consoleRunStartRef.current != null) {
                setConsoleRunMs(Date.now() - consoleRunStartRef.current);
                consoleRunStartRef.current = null;
              }
            } else if (msg.type === 'error') {
              throw new Error(msg.error || 'Stream error');
            }
          }
        }
      }
      setRunningIdx(-1);
      setConsoleStatus(prev => (prev === 'error' ? 'error' : 'ready'));
      if (consoleRunStartRef.current != null) {
        setConsoleRunMs(Date.now() - consoleRunStartRef.current);
        consoleRunStartRef.current = null;
      }
    } catch (err) {
      setConsoleEntries(prev => [...prev, { name: 'Error', cmd: '(auto-run)', output: '', error: err.message, source: 'auto' }]);
      setRunningIdx(-1);
      setConsoleStatus('error');
      if (consoleRunStartRef.current != null) {
        setConsoleRunMs(Date.now() - consoleRunStartRef.current);
        consoleRunStartRef.current = null;
      }
    } finally {
      autoRunInFlightRef.current = false;
    }
  };

  // Console open → just unveils the sheet. Nothing runs until the user
  // picks an action from the intent dropdown inside.
  const openConsole = async (credsOverride) => {
    const creds = credsOverride || switchCreds;
    const userOk = !!creds.username || credsStatus.has_username;
    const passOk = !!creds.password || credsStatus.has_password;
    if (!creds.host || !userOk || !passOk) {
      setPendingConsoleOpen(true);
      setCredsOpen(true);
      return;
    }
    setConsoleOpen(true);
  };

  // Live SSH snapshot of the switch — model, firmware, uptime, serial.
  // Fires the vendor's "switch info" command (show version / show
  // system-info) and parses the output. Does NOT pass scanId/device_index/
  // port so the server skips appending to the persisted transcript — this
  // is an out-of-band lookup, not part of the rack scan record.
  // Fire /api/specs in the background once we know vendor + model.
  // No await on the caller — this runs in parallel with the firmware check.
  const lookupSpecs = async (displayVendor, lookupModel) => {
    if (!displayVendor || !lookupModel) {
      setSwitchSpecsStatus('skipped');
      return;
    }
    setSwitchSpecsStatus('loading');
    setSwitchSpecsError(null);
    setSwitchSpecs(null);
    try {
      const res = await authFetch(apiUrl('/api/specs'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vendor: displayVendor, model: lookupModel }),
      });
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
      if (!data) throw new Error(`HTTP ${res.status}`);
      if (!res.ok || !data.ok) {
        setSwitchSpecsError(data.error || `HTTP ${res.status}`);
        setSwitchSpecs(data); // preserve any partial fields (productUrl etc.)
        setSwitchSpecsStatus('error');
        return;
      }
      setSwitchSpecs(data);
      setSwitchSpecsStatus('ready');
    } catch (err) {
      setSwitchSpecsError(err.message || String(err));
      setSwitchSpecsStatus('error');
    }
  };

  // Fire /api/firmware in the background — needs vendor + model + version.
  const lookupFirmware = async (displayVendor, lookupModel, currentVersion) => {
    if (!displayVendor || !lookupModel || !currentVersion) {
      setSwitchFirmwareStatus('skipped');
      return;
    }
    setSwitchFirmwareStatus('loading');
    setSwitchFirmwareError(null);
    setSwitchFirmware(null);
    try {
      const res = await authFetch(apiUrl('/api/firmware'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vendor: displayVendor, model: lookupModel, currentVersion }),
      });
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
      if (!data) throw new Error(`HTTP ${res.status}`);
      if (!res.ok || !data.ok) {
        setSwitchFirmwareError(data.error || `HTTP ${res.status}`);
        setSwitchFirmwareStatus('error');
        return;
      }
      setSwitchFirmware(data);
      setSwitchFirmwareStatus('ready');
    } catch (err) {
      setSwitchFirmwareError(err.message || String(err));
      setSwitchFirmwareStatus('error');
    }
  };

  const fetchSwitchInfo = async () => {
    const vendor = switchCreds.vendor || 'tplink';
    const cmd = SWITCH_INFO_CMD[vendor] || 'show version';
    setSwitchInfoStatus('loading');
    setSwitchInfoError(null);
    setSwitchInfoData(null);
    setSwitchInfoRaw('');
    // Reset downstream lookups so a stale prior result doesn't flash.
    setSwitchSpecs(null);
    setSwitchSpecsStatus('idle');
    setSwitchSpecsError(null);
    setSwitchFirmware(null);
    setSwitchFirmwareStatus('idle');
    setSwitchFirmwareError(null);
    try {
      const res = await fetch(apiUrl('/api/switch/console/run'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host: switchCreds.host,
          username: switchCreds.username,
          password: switchCreds.password,
          enablePassword: switchCreds.enablePassword || '',
          command: cmd,
          vendor,
          // Slow on some platforms; allow up to 30s.
          timeoutMs: 30000,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok || data.entry?.error) {
        throw new Error(data.entry?.error || data.error || 'Command failed');
      }
      const raw = data.entry?.output || '';
      const parsed = parseSwitchInfo(raw, vendor);
      setSwitchInfoRaw(raw);
      setSwitchInfoData(parsed);
      setSwitchInfoStatus('ready');

      // Kick off specs + firmware lookups in parallel. These are best-effort
      // and don't block the modal; each section renders its own status.
      const displayVendor = SSH_VENDOR_TO_DISPLAY[vendor] || '';
      const lookupModel = cleanModelForLookup(parsed.model);
      const cleanVer = cleanFirmwareVersion(parsed.firmware);
      lookupSpecs(displayVendor, lookupModel);
      lookupFirmware(displayVendor, lookupModel, cleanVer);
    } catch (err) {
      setSwitchInfoError(err.message || String(err));
      setSwitchInfoStatus('error');
    }
  };

  const openSwitchInfo = () => {
    const userOk = !!switchCreds.username || credsStatus.has_username;
    const passOk = !!switchCreds.password || credsStatus.has_password;
    if (!switchCreds.host || !userOk || !passOk) {
      setCredsOpen(true);
      return;
    }
    setSwitchInfoOpen(true);
    fetchSwitchInfo();
  };

  // Run a single intent — exactly the command behind the user's chosen
  // dropdown option, nothing else. Result lands in consoleEntries with the
  // intent's English label as the entry name (we hide the raw cmd in the UI).
  const runIntent = async (intentId) => {
    const intent = consoleIntents.find(i => i.id === intentId);
    if (!intent) return;
    const userOk = !!switchCreds.username || credsStatus.has_username;
    const passOk = !!switchCreds.password || credsStatus.has_password;
    if (!switchCreds.host || !userOk || !passOk) {
      setCredsOpen(true);
      return;
    }
    setConsoleStatus('running-manual');
    try {
      const res = await fetch(apiUrl('/api/switch/console/run'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host: switchCreds.host,
          username: switchCreds.username,
          password: switchCreds.password,
          enablePassword: switchCreds.enablePassword || '',
          command: intent.cmd,
          interface: deriveInterface(portNum),
          vendor: switchCreds.vendor || 'tplink',
          scanId,
          device_index: selectedIdx,
          port: parseInt(portNum, 10),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Command failed');
      // Override the entry name with the friendly label so the UI shows it
      // instead of the shell command.
      const entry = { ...(data.entry || {}), name: intent.label, intent_id: intent.id };
      setConsoleEntries(prev => [...prev, entry]);
      setConsoleStatus('ready');
    } catch (err) {
      setConsoleEntries(prev => [...prev, {
        name: intent.label, cmd: intent.cmd, output: '', error: err.message, source: 'intent', intent_id: intent.id,
      }]);
      setConsoleStatus('ready');
    }
  };

  // Build a structured report from the captured transcript, close the console
  // sheet, and open the report modal in one step. Done = "show me the report".
  const finishConsole = () => {
    const built = buildPortReport({
      host: switchCreds.host,
      vendor: switchCreds.vendor,
      iface: deriveInterface(portNum),
      portNum,
      entries: consoleEntries,
      neighbor,
      neighborMethod,
    });
    setPortReport(built);
    setPortReportOpen(true);
    setConsoleOpen(false);
    setConsoleStatus('idle');
    setManualCmd('');
  };

  const runManualCommand = async () => {
    const cmd = manualCmd.trim();
    if (!cmd) return;
    setConsoleStatus('running-manual');
    try {
      const res = await fetch(apiUrl('/api/switch/console/run'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host: switchCreds.host,
          username: switchCreds.username,
          password: switchCreds.password,
          enablePassword: switchCreds.enablePassword || '',
          command: cmd,
          interface: deriveInterface(portNum),
          vendor: switchCreds.vendor || 'tplink',
          scanId,
          device_index: selectedIdx,
          port: parseInt(portNum, 10),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Command failed');
      setConsoleEntries(prev => [...prev, data.entry]);
      setManualCmd('');
      setConsoleStatus('ready');
    } catch (err) {
      setConsoleEntries(prev => [...prev, { name: 'Manual', cmd, output: '', error: err.message, source: 'manual' }]);
      setManualCmd('');
      setConsoleStatus('ready');
    }
  };

  // Exit closes the sheet; transcript is already persisted server-side, so the next
  // report generation includes it automatically.
  const exitConsole = () => {
    setConsoleOpen(false);
    setConsoleStatus('idle');
    setManualCmd('');
  };

  const SHARE_CHANNELS = [
    {
      key: 'teams', label: 'Teams',
      icon: (
        <svg width="20" height="20" viewBox="0 0 32 32" fill="none" aria-hidden>
          <rect x="2" y="6" width="18" height="20" rx="3" fill="#5059c9"/>
          <path d="M6 12h10M11 12v10" stroke="#fff" strokeWidth="2.2" strokeLinecap="round"/>
          <circle cx="25" cy="11" r="3" fill="#7b83eb"/>
          <rect x="21" y="15" width="9" height="10" rx="2" fill="#7b83eb"/>
        </svg>
      ),
    },
    {
      key: 'outlook', label: 'Outlook',
      icon: (
        <svg width="20" height="20" viewBox="0 0 32 32" fill="none" aria-hidden>
          <rect x="2" y="7" width="17" height="18" rx="2" fill="#0078d4"/>
          <circle cx="10.5" cy="16" r="4.5" fill="none" stroke="#fff" strokeWidth="2"/>
          <rect x="20" y="10" width="10" height="12" rx="1.5" fill="#50d9ff"/>
          <path d="M20 11l5 4 5-4" stroke="#0078d4" strokeWidth="1.4" fill="none"/>
        </svg>
      ),
    },
    {
      key: 'slack', label: 'Slack',
      icon: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path d="M5 15a2 2 0 114 0v1H7a2 2 0 01-2-2z" fill="#36c5f0"/>
          <path d="M9 5a2 2 0 114 0v5a2 2 0 11-4 0z" fill="#2eb67d"/>
          <path d="M19 9a2 2 0 11-4 0V8h2a2 2 0 012 2z" fill="#ecb22e"/>
          <path d="M15 19a2 2 0 11-4 0v-5a2 2 0 114 0z" fill="#e01e5a"/>
        </svg>
      ),
    },
  ];

  // Per-channel last recipient is cached in localStorage so the dialog pre-fills
  // with the address the user most recently sent to via that channel.
  const SHARE_LS_KEY = (channel) => `racktrack.share.lastRecipient.${channel}`;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const SHARE_NOTE_LABEL = { teams: 'Message', slack: 'Message', outlook: 'Subject' };
  const SHARE_NOTE_PLACEHOLDER = {
    teams:   'Hi, please find the attached rack scan report.',
    slack:   'Sharing the latest rack scan report for your review.',
    outlook: `Rack scan report for ${rackId || scanId}`,
  };

  const openShareDialog = (channel) => {
    setShareMenuOpen(false);
    setShareDialogChannel(channel);
    setShareEmailErr(null);
    let prefill = '';
    try { prefill = localStorage.getItem(SHARE_LS_KEY(channel)) || ''; } catch (_) {}
    setShareEmailInput(prefill);
    setShareNoteInput('');
  };

  const closeShareDialog = () => {
    setShareDialogChannel(null);
    setShareEmailInput('');
    setShareNoteInput('');
    setShareEmailErr(null);
  };

  const confirmShareSend = async () => {
    const channel = shareDialogChannel;
    if (!channel) return;
    const email = shareEmailInput.trim();
    if (!email) { setShareEmailErr('Recipient email is required.'); return; }
    if (!EMAIL_RE.test(email)) { setShareEmailErr('Enter a valid email address.'); return; }

    const note = shareNoteInput.trim();
    const payload = { email };
    if (note) {
      if (channel === 'outlook') payload.subject = note;
      else if (channel === 'teams') payload.message = note;
      else if (channel === 'slack') payload.comment = note;
    }

    try { localStorage.setItem(SHARE_LS_KEY(channel), email); } catch (_) {}

    setShareDialogChannel(null);
    setShareStatus('sending');
    setShareChannel(channel);
    setShareMsg(null);
    try {
      const res = await fetch(apiUrl(`/api/scan/${scanId}/${channel}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `${channel} send failed`);
      setShareStatus('sent');
      setShareMsg(`Sent to ${data.recipient} via ${channel}`);
      setTimeout(() => { setShareStatus('idle'); setShareMsg(null); setShareChannel(null); }, 3500);
    } catch (err) {
      setShareStatus('error');
      setShareMsg(err.message);
    }
  };

  const reportUrl = (format) => apiUrl(`/api/scan/${scanId}/report?format=${format}`);
  const viewReport = () => setReportOpen(true);
  const downloadReport = async (format) => {
    try {
      const res = await fetch(reportUrl(format));
      if (!res.ok) throw new Error(`Report request failed (${res.status})`);
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = `${scanId}_report.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    } catch (err) {
      setError(`Download failed: ${err.message}`);
    }
  };

  const resetFeedback = () => {
    setFeedbackStatus('idle');
    setActualPortInput('');
    setActualCableColor('');
    setFeedbackError(null);
    setDeviceFbStatus('idle');
    setActualDeviceClass('');
    setDeviceFbError(null);
    setPortCountFbStatus('idle');
    setActualPortCount('');
    setPortCountFbError(null);
  };

  // Step 1 of the wrong-pending flow: validate the port number.
  // If the port is connected, advance to color step; otherwise submit immediately.
  const advancePortStep = () => {
    if (!selectedDevice) return;
    const a = parseInt(actualPortInput, 10);
    if (isNaN(a) || a < 1 || (selectedDevice.port_count > 0 && a > selectedDevice.port_count)) {
      setFeedbackError(selectedDevice.port_count > 0
        ? `Port must be between 1 and ${selectedDevice.port_count}`
        : 'Invalid port number');
      return;
    }
    setFeedbackError(null);
    if (portInfo?.status === 'connected') {
      setFeedbackStatus('wrong-color');
    } else {
      submitFeedback(false);
    }
  };

  const submitFeedback = async (isCorrect, overrides = {}) => {
    if (!selectedDevice || !portNum) return;
    let payloadActualPort = null;
    let payloadActualCableColor = null;

    if (!isCorrect) {
      const portCandidate = overrides.actualPort ?? actualPortInput;
      const a = parseInt(portCandidate, 10);
      if (isNaN(a) || a < 1 || (selectedDevice.port_count > 0 && a > selectedDevice.port_count)) {
        setFeedbackError(selectedDevice.port_count > 0
          ? `Port must be between 1 and ${selectedDevice.port_count}`
          : 'Invalid port number');
        setFeedbackStatus('wrong-port');
        return;
      }
      payloadActualPort = a;
      if (portInfo?.status === 'connected') {
        const colorCandidate = overrides.actualCableColor ?? actualCableColor;
        if (!colorCandidate) {
          setFeedbackError('Pick the actual cable color.');
          setFeedbackStatus('wrong-color');
          return;
        }
        payloadActualCableColor = colorCandidate;
      }
    }

    setFeedbackStatus('submitting'); setFeedbackError(null);
    try {
      const res = await fetch(apiUrl('/api/feedback'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scanId,
          device_index: selectedIdx,
          predicted_port: parseInt(portNum, 10),
          is_correct: isCorrect,
          actual_port: payloadActualPort,
          actual_cable_color: payloadActualCableColor,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Feedback failed');
      // Optimistic: reflect the user's correction in the "Port Located" card
      // immediately. Server overlays the same change into scan_result.json
      // (see applyFeedbackOverrides in server/app.js), so a refresh would
      // also show this — but the user shouldn't have to refresh to see
      // their own correction take effect.
      if (!isCorrect) {
        if (payloadActualPort != null) setPortNum(String(payloadActualPort));
        if (payloadActualCableColor || payloadActualPort != null) {
          setPortInfo(prev => {
            if (!prev) return prev;
            const next = { ...prev };
            if (payloadActualPort != null) next.port_number = payloadActualPort;
            if (payloadActualCableColor) {
              next.cable_color = payloadActualCableColor;
              const colorWord = /\b(?:White|Black|Blue|Red|Green|Yellow|Grey|Gray|Brown|Orange|Purple|Pink|Violet|Aqua)\b/i;
              if (next.cable_type && colorWord.test(next.cable_type)) {
                next.cable_type = next.cable_type.replace(colorWord, payloadActualCableColor);
              }
            }
            return next;
          });
        }
      }
      setFeedbackStatus('submitted');
      setTimeout(() => {
        setFeedbackStatus('hidden');
        setActualPortInput('');
        setActualCableColor('');
        setFeedbackError(null);
      }, 2000);
    } catch (err) {
      setFeedbackError(err.message);
      setFeedbackStatus(isCorrect ? 'idle' : 'wrong-port');
    }
  };

  const submitDeviceFeedback = async (isCorrect) => {
    if (!selectedDevice) return;
    if (!isCorrect && !actualDeviceClass) {
      setDeviceFbError('Pick the actual device type.');
      return;
    }
    setDeviceFbStatus('submitting'); setDeviceFbError(null);
    try {
      const res = await fetch(apiUrl('/api/feedback/device'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scanId,
          device_index: selectedIdx,
          is_correct: isCorrect,
          actual_device_class: isCorrect ? null : actualDeviceClass,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Feedback failed');
      // Optimistic: reflect the user's device-class correction in the
      // local devices[] so the picker / "Selected Device" line updates
      // without a refresh. Server overlays the same change into
      // scan_result.json via applyFeedbackOverrides.
      if (!isCorrect && actualDeviceClass) {
        setDevices(prev => prev.map((d, i) =>
          (i + 1 === selectedIdx) ? { ...d, class_name: actualDeviceClass } : d
        ));
      }
      setDeviceFbStatus('submitted');
      setTimeout(() => {
        setDeviceFbStatus('hidden');
        setActualDeviceClass('');
        setDeviceFbError(null);
      }, 2000);
    } catch (err) {
      setDeviceFbError(err.message);
      setDeviceFbStatus(isCorrect ? 'idle' : 'wrong-pending');
    }
  };

  const submitPortCountFeedback = async (isCorrect) => {
    if (!selectedDevice) return;
    let actualNum = null;
    if (!isCorrect) {
      const a = parseInt(actualPortCount, 10);
      if (isNaN(a) || a < 0) {
        setPortCountFbError('Enter a valid port count (0 or more).');
        return;
      }
      actualNum = a;
    }
    setPortCountFbStatus('submitting'); setPortCountFbError(null);
    try {
      const res = await fetch(apiUrl('/api/feedback/port-count'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scanId,
          device_index: selectedIdx,
          is_correct: isCorrect,
          actual_port_count: isCorrect ? null : actualNum,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Feedback failed');
      // If the server re-labeled the device with the user's target count,
      // patch the local devices array so the picker reflects the new count
      // immediately — no page refresh needed.
      if (data.relabel?.ok && data.relabel?.device) {
        const idx = data.relabel.device_index;
        setDevices(prev => prev.map((d, i) => (i + 1 === idx ? data.relabel.device : d)));
      }
      setPortCountFbStatus('submitted');
      setTimeout(() => {
        setPortCountFbStatus('hidden');
        setActualPortCount('');
        setPortCountFbError(null);
      }, 2000);
    } catch (err) {
      setPortCountFbError(err.message);
      setPortCountFbStatus(isCorrect ? 'idle' : 'wrong-pending');
    }
  };

  // ── Ticket-mode drift view ─────────────────────────────────────────────
  // When the ticket-driven analyze detected physical drift (CMDB expected
  // e.g. Switch at U15 but scan sees Closed Unit), we don't have a port to
  // pinpoint. Render a dedicated "something is wrong" view instead of the
  // port layout.
  if (ticketMode && result?.driftDetected) {
    const drift = result.drift || {};
    const uStr = `U${String(drift.expected_u ?? '?').padStart(2, '0')}`;
    const seen = drift.detections_at_u || [];
    const rackImgUrl = result.rackImageUrl ? apiUrl(result.rackImageUrl) : (result.imageUrl ? apiUrl(result.imageUrl) : null);
    return (
      <div className={`page page-full ${styles.results}`}>
        <div className={styles.portAmb} style={{ '--ac': '#ef4444' }} />

        <header className={styles.header}>
          <button className="btn btn-ghost btn-icon" onClick={() => navigate('/')}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
            </svg>
          </button>
          <div className={styles.headerCenter}>
            <h2 className={styles.headerTitle} style={{color:'#ef4444'}}>Physical Drift Detected</h2>
            <div className={styles.headerMetaRow}>
              {rackId && <span className={styles.headerMono}>{rackId}</span>}
            </div>
          </div>
          <div style={{ width: 40 }} />
        </header>

        <div className={styles.portBody}>
          {/* Drift alert card */}
          <div style={{
            background: 'linear-gradient(135deg, rgba(239,68,68,0.15), rgba(239,68,68,0.05))',
            border: '1px solid rgba(239,68,68,0.55)',
            borderRadius: 12,
            padding: '14px 16px',
            margin: '8px 12px 12px',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}>
            <div style={{display:'flex',alignItems:'center',gap:8,fontSize:11,fontWeight:600,letterSpacing:'0.08em',color:'#ef4444',textTransform:'uppercase'}}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
                <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
              CMDB ↔ scan mismatch for {ticket?.incident_number}
            </div>
            <div style={{fontSize:14,color:'var(--text, #e5e7eb)',lineHeight:1.45}}>
              {drift.reason}
            </div>
            {/* CMDB vs scan comparison */}
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginTop:4}}>
              <div style={{background:'rgba(255,255,255,0.03)',border:'1px solid rgba(255,255,255,0.08)',borderRadius:8,padding:10}}>
                <div style={{fontSize:10,fontWeight:600,letterSpacing:'0.06em',color:'var(--muted, #9ca3af)',textTransform:'uppercase',marginBottom:4}}>CMDB expects</div>
                <div style={{fontSize:13,color:'var(--text, #e5e7eb)'}}>
                  <strong>{drift.expected_device}</strong>
                </div>
                <div style={{fontSize:12,color:'var(--muted, #9ca3af)',marginTop:2}}>
                  {drift.expected_class} @ {uStr}
                </div>
              </div>
              <div style={{background:'rgba(239,68,68,0.06)',border:'1px solid rgba(239,68,68,0.3)',borderRadius:8,padding:10}}>
                <div style={{fontSize:10,fontWeight:600,letterSpacing:'0.06em',color:'#fca5a5',textTransform:'uppercase',marginBottom:4}}>Scan sees at {uStr}</div>
                {seen.length === 0 ? (
                  <div style={{fontSize:13,color:'var(--text, #e5e7eb)'}}>nothing</div>
                ) : (
                  seen.map((d, i) => (
                    <div key={i} style={{fontSize:13,color:'var(--text, #e5e7eb)'}}>
                      <strong>{d.class_name}</strong>
                      <span style={{fontSize:11,color:'var(--muted, #9ca3af)',marginLeft:6}}>
                        conf {typeof d.confidence === 'number' ? d.confidence.toFixed(2) : '?'}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Next-step guidance */}
            <div style={{fontSize:12,color:'var(--muted, #9ca3af)',lineHeight:1.5,marginTop:4}}>
              <strong style={{color:'var(--text, #e5e7eb)'}}>Next steps:</strong> either the CMDB is stale (device was moved/replaced) or someone installed the wrong hardware. Verify physically at rack <strong>{ticket?.cmdb?.rack_name || '?'}</strong>, then update whichever side is wrong.
            </div>
          </div>

          {/* Annotated rack scan so the tech can eyeball what the camera saw */}
          {rackImgUrl && (
            <div style={{margin:'0 12px',borderRadius:10,overflow:'hidden',border:'1px solid rgba(255,255,255,0.08)'}}>
              <img src={rackImgUrl} alt="Annotated rack scan" style={{display:'block',width:'100%',height:'auto'}} />
            </div>
          )}
        </div>
      </div>
    );
  }

  if (phase === 'port') {
    const rc = selectedDevice ? getColor(selectedDevice.class_name) : DEFAULT_COLOR;
    const resultLabel = buildPortLabel(selectedLabel, selectedDevice?.class_name, portNum);
    const isConn = portInfo?.status === 'connected';
    const connectorVal = portInfo?.cable_connector || cableInfo?.display;
    const colorVal = portInfo?.cable_color || cableInfo?.colorName;
    return (
      <div className={`page page-full ${styles.results}`}>
        <div className={styles.portAmb} style={{ '--ac': rc }} />

        <header className={styles.header}>
          <div style={{ width: 40 }} />
          <div className={styles.headerCenter}>
            <h2 className={styles.headerTitle}>Port Located</h2>
            <div className={styles.headerMetaRow}>
              {rackId && <span className={styles.headerMono}>{rackId}</span>}
            </div>
          </div>
          <div style={{ width: 40 }} />
        </header>

        {/* Full-screen port result layout */}
        <div className={styles.portBody}>

          {/* Ticket context + LLDP result (only in ticket-mode) */}
          {ticketMode && ticket && (
            <div style={{
              background: 'linear-gradient(135deg, rgba(239,68,68,0.08), rgba(34,211,238,0.05))',
              border: '1px solid rgba(34,211,238,0.35)',
              borderRadius: 12,
              padding: '12px 14px',
              margin: '8px 12px 4px',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              fontSize: 13,
            }}>
              <div style={{display:'flex',alignItems:'center',gap:8,fontSize:11,fontWeight:600,letterSpacing:'0.08em',color:'#22d3ee',textTransform:'uppercase'}}>
                Auto-targeted from {ticket.incident_number}
              </div>
              <div style={{color:'var(--text, #e5e7eb)',lineHeight:1.4}}>
                {ticket.short_description}
              </div>
              <div style={{display:'flex',gap:10,flexWrap:'wrap',color:'var(--muted, #9ca3af)',fontSize:12}}>
                <span><strong style={{color:'var(--text, #e5e7eb)'}}>{ticket.cmdb?.rack_name || '?'}</strong></span>
                <span>·</span>
                <span><strong style={{color:'var(--text, #e5e7eb)'}}>{ticket.target?.device}</strong> ({ticket.cmdb?.model || '?'})</span>
                <span>·</span>
                <span>port <strong style={{color:'var(--text, #e5e7eb)'}}>{ticket.cmdb?.interface_alias || `#${ticket.target?.port}`}</strong></span>
                {ticket.cmdb?.mgmt_ip && <><span>·</span><span>{ticket.cmdb.mgmt_ip}</span></>}
              </div>

              {/* Resolved banner — shows when the port transitions to active */}
              {liveResolvedAt && (
                <div style={{
                  marginTop:8,
                  background:'linear-gradient(135deg, rgba(52,211,153,0.20), rgba(52,211,153,0.06))',
                  border:'1px solid rgba(52,211,153,0.6)',
                  borderRadius:10,
                  padding:'10px 12px',
                  display:'flex',
                  alignItems:'center',
                  gap:10,
                }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10"/><polyline points="9 12 11 14 15 10"/>
                  </svg>
                  <div style={{display:'flex',flexDirection:'column'}}>
                    <div style={{fontSize:13,fontWeight:600,color:'#34d399'}}>Cable attached — port is now active</div>
                    <div style={{fontSize:11,color:'var(--muted, #9ca3af)'}}>
                      Detected at {new Date(liveResolvedAt).toLocaleTimeString()} · incident {ticket.incident_number} likely resolved
                    </div>
                  </div>
                </div>
              )}

              {/* Live monitoring status strip */}
              <div style={{
                marginTop: liveResolvedAt ? 6 : 8,
                paddingTop: 6,
                borderTop:'1px dashed rgba(255,255,255,0.1)',
                display:'flex',
                flexWrap:'wrap',
                alignItems:'center',
                gap:10,
                fontSize:11,
                color:'var(--muted, #9ca3af)',
              }}>
                <span style={{display:'inline-flex',alignItems:'center',gap:6}}>
                  <span style={{
                    width:8, height:8, borderRadius:'50%',
                    background: liveSnapshot?.link_active ? '#34d399' : (liveSnapshot?.ok ? '#9ca3af' : '#fbbf24'),
                    boxShadow: liveSnapshot?.link_active ? '0 0 6px #34d399' : 'none',
                    animation: liveInFlightRef.current ? 'pulse 1.2s ease-in-out infinite' : 'none',
                  }}/>
                  Live · every {Math.round(LIVE_POLL_MS/1000)}s
                </span>
                {liveSnapshot?.ok ? (
                  <>
                    <span>·</span>
                    <span>link: <strong style={{color: liveSnapshot.link_active ? '#34d399' : '#fbbf24'}}>
                      {liveSnapshot.link_active ? 'active' : 'idle'}
                    </strong></span>
                    <span>·</span>
                    <span>neighbor: <strong style={{color:'var(--text, #e5e7eb)'}}>
                      {liveSnapshot.has_neighbor ? (liveSnapshot.neighbor?.sysname || 'present') : 'none'}
                    </strong></span>
                    <span>·</span>
                    <span>MACs: <strong style={{color:'var(--text, #e5e7eb)'}}>{liveSnapshot.mac_count ?? 0}</strong></span>
                  </>
                ) : liveSnapshot ? (
                  <span>· last attempt failed: {liveSnapshot.error?.slice(0, 60) || 'unknown'}</span>
                ) : (
                  <span>· waiting for first sample…</span>
                )}
                {liveLastAt && (
                  <>
                    <span>·</span>
                    <span>updated {Math.round((Date.now() - liveLastAt)/1000)}s ago</span>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Port image — tap to cycle: rack → device → zoomed port → rack */}
          {(() => {
            const cycleView = () => {
              if (portView === 'rack') setPortView('device');
              else if (portView === 'device') setPortView('zoom');
              else setPortView('rack');
            };
            const isRack = portView === 'rack' && rackImg;
            const isZoom = portView === 'zoom';
            const imgSrc = isRack ? rackImg : resultImg;
            const wrapClass = isRack ? styles.portImgRack : isZoom ? styles.portImgZoom : styles.portImgDev;
            const hint = isRack ? 'Tap for device view' : isZoom ? 'Tap for rack view' : 'Tap to zoom port';

            let zoomStyle = {};
            if (isZoom && portInfo?.location && selectedDevice?.box) {
              const [px1, py1, px2, py2] = portInfo.location;
              const [dx1, dy1, dx2, dy2] = selectedDevice.box;
              const devW = dx2 - dx1;
              const devH = dy2 - dy1;
              const portW = px2 - px1;
              const portH = py2 - py1;
              const pctX = Math.max(10, Math.min(90, (((px1 + px2) / 2 - dx1) / devW) * 100));
              const rawY = (((py1 + py2) / 2 - dy1) / devH) * 100;
              const pctY = Math.max(25, Math.min(75, rawY));
              const scale = Math.min(devW / (portW * 2.2), devH / (portH * 2.2), 6);
              zoomStyle = { transform: `scale(${scale}) translateY(8%)`, transformOrigin: `${pctX}% ${pctY}%` };
            }

            return (
              <div className={`${styles.portImgWrap} ${wrapClass}`} onClick={cycleView}>
                <img src={imgSrc} alt="Port located"
                  className={styles.portImg}
                  style={zoomStyle}
                  draggable="false" />
                <span className={styles.portImgHint}>{hint}</span>
                {portTimings?.total_ms != null && (
                  <span className={`${styles.timingBadge} ${styles.heroTiming}`} title="Time from device+port submit to result">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                    </svg>
                    Done in {fmtMs(portTimings.total_ms)}
                  </span>
                )}
              </div>
            );
          })()}

          {/* Port label — plain text, no container, below hero image */}
          <div className={styles.prLabelLine} style={{ '--ac': rc }}>
            {resultLabel}
          </div>

          {/* Port verdict — telemetry-style dashboard */}
          {(() => {
            const s = portInfo?.status;
            const isOn = s === 'connected';
            const isEmpty = s === 'empty';
            const statusText = isOn ? 'Connected' : isEmpty ? 'Empty' : 'Unknown';
            const statusColor = isOn ? '#34d399' : isEmpty ? '#94a3b8' : '#fbbf24';
            return (
              <div className={styles.prDash} style={{ '--sc': statusColor, '--ac': rc }}>
                <div className={styles.prPortTile}>
                  <span className={styles.prPortLabel}>PORT</span>
                  <span className={styles.prPortNum}>{portNum}</span>
                  <span className={styles.prPortGlow} aria-hidden />
                </div>
                <div className={styles.prMetrics}>
                  <div className={`${styles.prMetric} ${styles.prMetricStatus}`}>
                    <span className={styles.prMetricLabel}>Status</span>
                    <span className={styles.prMetricVal}>
                      <span className={styles.prMetricDot} />
                      {statusText}
                    </span>
                  </div>
                  <div className={styles.prMetric}>
                    <span className={styles.prMetricLabel}>Device</span>
                    <span className={styles.prMetricVal}>
                      {selectedDevice?.class_name || '—'}
                      {selectedDevice?.confidence != null && (
                        <span className={styles.prMetricConf}>{fmtPct(selectedDevice.confidence)}</span>
                      )}
                    </span>
                  </div>
                  {connectorVal && (
                    <div className={styles.prMetric}>
                      <span className={styles.prMetricLabel}>Cable</span>
                      <span className={styles.prMetricVal}>
                        {connectorVal}
                        {portInfo?.cable_confidence != null && (
                          <span className={styles.prMetricConf}>{fmtPct(portInfo.cable_confidence)}</span>
                        )}
                      </span>
                    </div>
                  )}
                  {colorVal && (
                    <div className={styles.prMetric}>
                      <span className={styles.prMetricLabel}>Color</span>
                      <span className={styles.prMetricVal}>
                        <span className={styles.prMetricSwatch}
                          style={{ background: cableColorCSS(colorVal), boxShadow: `0 0 8px ${cableColorCSS(colorVal)}` }} />
                        {colorVal}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            );
          })()}

          {/* End device — single inline line with shimmer while resolving */}
          <div className={styles.prEnd} style={{ '--ac': rc }}>
            {neighborStatus === 'loading' && (
              <>
                <span className={styles.prEndPulse} />
                <span className={styles.prEndDim}>Resolving end device…</span>
              </>
            )}
            {neighborStatus === 'ok' && neighbor && (() => {
              // Pick a clean name: skip any field that contains a trailing
              // colon (which means the LLDP parser returned a field label
              // like "System description:" by mistake).
              const isLabelish = (v) => !v || /:\s*$/.test(String(v).trim());
              const cleanOrNull = (v) => (v && !isLabelish(v) ? String(v).trim() : null);
              const name = cleanOrNull(neighbor.chassis_id)
                || cleanOrNull(neighbor.system_name)
                || cleanOrNull(neighbor.port_id)
                || 'End device';
              const metaRaw = [
                cleanOrNull(neighbor.port_id) !== name ? cleanOrNull(neighbor.port_id) : null,
                cleanOrNull(neighbor.port_description),
              ].filter(Boolean);
              const chips = metaRaw
                .flatMap(m => String(m).split(/\s*·\s*/))
                .map(s => s.trim())
                .filter(Boolean)
                .map((text, i) => {
                  const isMac = /^(?:[0-9a-f]{2}[:\-]){5}[0-9a-f]{2}$/i.test(text);
                  const ttlMatch = text.match(/^TTL\s*[:=]?\s*(\d+)/i);
                  if (isMac) return { key: `c${i}`, kind: 'mac', label: 'MAC', value: text };
                  if (ttlMatch) return { key: `c${i}`, kind: 'ttl', label: 'TTL', value: `${ttlMatch[1]}s` };
                  return { key: `c${i}`, kind: 'info', label: null, value: text };
                });
              return (
                <div className={styles.prEndCreative}>
                  <div className={styles.prEndIcon} aria-hidden>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="2" y="3" width="20" height="14" rx="2"/>
                      <line x1="8" y1="21" x2="16" y2="21"/>
                      <line x1="12" y1="17" x2="12" y2="21"/>
                    </svg>
                    <span className={styles.prEndLiveDot} />
                  </div>
                  <div className={styles.prEndBody}>
                    <div className={styles.prEndHead}>
                      <span className={styles.prEndLabel}>Linked endpoint</span>
                      <span className={styles.prEndTag}>LIVE</span>
                    </div>
                    <strong className={styles.prEndName}>{name}</strong>
                    {chips.length > 0 && (
                      <div className={styles.prEndChips}>
                        {chips.map(chip => (
                          <span key={chip.key} className={`${styles.prEndChip} ${styles[`prEndChip_${chip.kind}`]}`}>
                            {chip.kind === 'mac' && (
                              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M6 4v6m12-6v6m-14 0h16v4a4 4 0 01-4 4h-1v4h-2v-4H9v4H7v-4H6a4 4 0 01-4-4v-4h2z"/>
                              </svg>
                            )}
                            {chip.kind === 'ttl' && (
                              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <circle cx="12" cy="12" r="9"/>
                                <polyline points="12 7 12 12 15 14"/>
                              </svg>
                            )}
                            {chip.label && <span className={styles.prEndChipKey}>{chip.label}</span>}
                            <span className={styles.prEndChipVal}>{chip.value}</span>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })()}
            {neighborStatus === 'empty' && (
              <span className={styles.prEndDim}>No end device responded on this port</span>
            )}
            {neighborStatus === 'error' && (
              <>
                <span className={styles.prEndDim}>End device lookup failed</span>
                <button className={styles.prEndAction} onClick={() => findNeighbor()}>Retry</button>
              </>
            )}
            {neighborStatus === 'idle' && (
              <button className={styles.prEndAction} onClick={() => findNeighbor()}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                </svg>
                Find end device
              </button>
            )}
          </div>

          {/* Feedback — clear natural-language question with inline expansion */}
          {!ticketMode && feedbackStatus !== 'hidden' && (
            <div className={styles.prFb} style={{ '--ac': rc }}>
              {feedbackStatus === 'idle' && (
                <>
                  <span className={styles.fbPrompt}>
                    Port {portNum}{selectedDevice?.class_name ? ` on ${selectedDevice.class_name}` : ''}. Right?
                  </span>
                  <div className={styles.fbBtnRow}>
                    <button className={`${styles.fbBtn} ${styles.fbBtnYes}`}
                      disabled={!selectedDevice || !portNum}
                      onClick={() => submitFeedback(true)}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                      Yes
                    </button>
                    <button className={`${styles.fbBtn} ${styles.fbBtnNo}`}
                      onClick={() => { setFeedbackStatus('wrong-port'); setFeedbackError(null); }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                      No
                    </button>
                  </div>
                </>
              )}
              {feedbackStatus === 'wrong-port' && (
                <>
                  <div className={styles.prFbHead}>
                    <span className={styles.prFbStep}>Step 1{portInfo?.status === 'connected' ? ' of 2' : ''}</span>
                    <span className={styles.prFbHeadQ}>Which port is it actually?</span>
                    <button className={styles.prFbClose}
                      onClick={() => { setFeedbackStatus('idle'); setActualPortInput(''); setActualCableColor(''); setFeedbackError(null); }}
                      aria-label="Close">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                  </div>
                  <div className={styles.portInputRow}>
                    <input
                      className={`input ${styles.portInput}`}
                      type="number" min="1"
                      max={selectedDevice?.port_count > 0 ? selectedDevice.port_count : undefined}
                      style={{ '--focus-color': rc }}
                      placeholder={selectedDevice?.port_count > 0 ? `1–${selectedDevice.port_count}` : 'Port #'}
                      value={actualPortInput}
                      onChange={e => { setActualPortInput(e.target.value); setFeedbackError(null); }}
                      onKeyDown={e => e.key === 'Enter' && actualPortInput && advancePortStep()}
                      autoFocus />
                    <button
                      type="button"
                      className={`btn btn-primary ${styles.findBtn}`}
                      style={{ '--btn-glow': rc }}
                      disabled={!actualPortInput}
                      onClick={advancePortStep}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                      </svg>
                      {portInfo?.status === 'connected' ? 'Next' : 'Submit'}
                    </button>
                  </div>
                </>
              )}
              {feedbackStatus === 'wrong-color' && (
                <>
                  <div className={styles.prFbHead}>
                    <span className={styles.prFbStep}>Step 2 of 2</span>
                    <span className={styles.prFbHeadQ}>What color is the cable?</span>
                    <button className={styles.prFbClose}
                      onClick={() => { setFeedbackStatus('wrong-port'); setFeedbackError(null); }}
                      aria-label="Back">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
                    </button>
                  </div>
                  <div className={styles.prColorGrid}>
                    {CABLE_COLOR_OPTIONS.map(c => {
                      const isSel = actualCableColor === c;
                      return (
                        <button key={c}
                          className={`${styles.prColorTile} ${isSel ? styles.prColorTileOn : ''}`}
                          style={{ '--c': cableColorCSS(c) }}
                          onClick={() => {
                            setActualCableColor(c);
                            setFeedbackError(null);
                            submitFeedback(false, { actualCableColor: c });
                          }}>
                          <span className={styles.prColorSwatch} />
                          <span className={styles.prColorName}>{c}</span>
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
              {feedbackStatus === 'submitting' && (
                <div className={styles.prFbSaving}>
                  <span className={styles.btnSpinner} />
                  <span>Saving…</span>
                </div>
              )}
              {feedbackStatus === 'submitted' && (
                <div className={styles.prFbDone}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                  Thanks — feedback saved
                </div>
              )}
              {feedbackError && (
                <span className={styles.prFbErr}>{feedbackError}</span>
              )}
            </div>
          )}

          {/* Jump to another port — single compact input row, no header */}
          {!ticketMode && selectedDevice && (
            <div className={styles.prAnother} style={{ '--ac': rc }}>
              <input
                className={`input ${styles.portInput}`}
                type="number" min="1"
                max={selectedDevice.port_count > 0 ? selectedDevice.port_count : undefined}
                style={{ '--focus-color': rc }}
                placeholder={selectedDevice.port_count > 0
                  ? `Another port · 1–${selectedDevice.port_count}`
                  : 'Another port #'}
                value={nextPort}
                onChange={e => { setNextPort(e.target.value); setError(null); }}
                onKeyDown={e => e.key === 'Enter' && nextPort && findAnotherPort()}
              />
              <button
                type="button"
                className={`btn btn-primary ${styles.findBtn}`}
                style={{ '--btn-glow': rc }}
                disabled={!nextPort || loading}
                onClick={() => findAnotherPort()}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                </svg>
                Find
              </button>
            </div>
          )}
          {loading && (
            <div className={styles.portLoadingRow}>
              <span className={styles.btnSpinner} />
              <span>Locating port…</span>
            </div>
          )}

          {error && (
            <div className={styles.errBox}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              {error}
            </div>
          )}

          {shareMsg && (
            <div className={`${styles.slackMsg} ${shareStatus === 'error' ? styles.slackMsgErr : styles.slackMsgOk}`}>
              {shareMsg}
            </div>
          )}

          {/* Report row — View / Download / Share as labeled chips */}
          <div className={styles.reportRow} style={{ '--ac': rc }}>
            <button className={`${styles.reportChip} ${styles.reportChipView}`}
              onClick={ticketMode ? () => setTicketReportOpen(true) : viewReport}
              title="View report">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
              View
            </button>
            <button className={styles.reportChip}
              onClick={ticketMode
                ? () => setTicketReportOpen(true)
                : () => window.open(reportUrl('html') + '#download', '_blank')}
              title={ticketMode ? 'View ticket report' : `Download rack-report-${rackId || scanId}.pdf`}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              Report
            </button>
            <button className={`${styles.reportChip} ${styles.reportChipSwitchInfo}`}
              onClick={openSwitchInfo}
              title="Live switch model, firmware & uptime over SSH">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="4" y="4" width="16" height="16" rx="2"/>
                <rect x="9" y="9" width="6" height="6"/>
                <line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/>
                <line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/>
                <line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/>
                <line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/>
              </svg>
              Switch Info
            </button>
            <button className={`${styles.reportChip} ${styles.reportChipConsole}`}
              onClick={() => openConsole()}
              title="Open SSH console for this port">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="4 17 10 11 4 5"/>
                <line x1="12" y1="19" x2="20" y2="19"/>
              </svg>
              Console
            </button>
            <div className={styles.shareWrap}>
              <button className={`${styles.reportChip} ${styles.reportChipShare} ${shareStatus === 'sent' ? styles.reportChipSlackSent : ''} ${shareStatus === 'error' ? styles.reportChipSlackErr : ''}`}
                onClick={() => { if (shareStatus !== 'sending') setShareMenuOpen(v => !v); }}
                disabled={shareStatus === 'sending'}
                title="Share report">
                {shareStatus === 'sending' ? (
                  <span className={styles.btnSpinner} />
                ) : shareStatus === 'sent' ? (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
                )}
                {shareStatus === 'sending'
                  ? `Sending${shareChannel ? ` to ${shareChannel}` : ''}`
                  : shareStatus === 'sent' ? 'Sent' : 'Share'}
              </button>
              {shareMenuOpen && (
                <>
                  <div className={styles.shareBackdrop} onClick={() => setShareMenuOpen(false)} />
                  <div className={styles.shareMenu} role="menu">
                    {SHARE_CHANNELS.map(ch => (
                      <button key={ch.key}
                        className={styles.shareMenuItem}
                        onClick={() => openShareDialog(ch.key)}
                        role="menuitem"
                        aria-label={ch.label}
                        title={ch.label}>
                        <span className={styles.shareMenuIcon}>{ch.icon}</span>
                        <span>{ch.label}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Nav actions — change device / new scan */}
          <div className={styles.pActions} style={{ '--ac': rc }}>
            <button className={styles.pActionBtn} onClick={() => {
              setPhase('detect');
              setTab('overview');
              setSelectedIdx(null);
              setPortNum(''); setNextPort(''); setPortInfo(null);
              setResultImg(null); setRackImg(null); setPortView('rack');
              setDeviceFbStatus('idle'); setActualDeviceClass(''); setDeviceFbError(null);
              setPortCountFbStatus('idle'); setActualPortCount(''); setPortCountFbError(null);
              setError(null); resetZoom();
            }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="4" rx="1"/><rect x="2" y="10" width="20" height="4" rx="1"/><rect x="2" y="17" width="20" height="4" rx="1"/></svg>
              Change Device
            </button>
            <button className={styles.pActionBtn} onClick={() => navigate('/scan')}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/></svg>
              New Scan
            </button>
          </div>
        </div>

        {loading && (
          <div className={styles.loadOverlay}>
            <div className={styles.loadRing} style={{ '--c': rc }}><div className={styles.loadRingInner} /></div>
            <p className={styles.loadTitle}>Identifying</p>
            <p className={styles.loadSub}>{buildPortLabel(selectedLabel, selectedDevice?.class_name, nextPort || portNum)}</p>
          </div>
        )}

        {shareDialogChannel && (() => {
          const channel = shareDialogChannel;
          const meta = SHARE_CHANNELS.find(c => c.key === channel);
          const title = `Send report via ${meta?.label || channel}`;
          return (
            <div className={styles.shareDialogBackdrop}
                 onClick={(e) => { if (e.target === e.currentTarget) closeShareDialog(); }}
                 onKeyDown={(e) => { if (e.key === 'Escape') closeShareDialog(); }}
                 role="dialog" aria-modal="true" aria-labelledby="shareDialogTitle">
              <div className={styles.shareDialog}>
                <div className={styles.shareDialogHeader}>
                  <span className={styles.shareDialogIcon}>{meta?.icon}</span>
                  <span id="shareDialogTitle" className={styles.shareDialogTitle}>{title}</span>
                  <button type="button" className={styles.shareDialogClose}
                          onClick={closeShareDialog} aria-label="Close">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                         strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                  </button>
                </div>

                <form className={styles.shareDialogBody}
                      onSubmit={(e) => { e.preventDefault(); confirmShareSend(); }}>
                  <p className={styles.shareDialogHint}>
                    Enter the recipient for this rack scan report. The address is remembered
                    on this device for next time.
                  </p>

                  <label className={styles.shareDialogLabel} htmlFor="shareEmailInput">
                    Recipient email <span aria-hidden className={styles.shareDialogReq}>*</span>
                  </label>
                  <input
                    id="shareEmailInput"
                    type="email"
                    autoFocus
                    required
                    autoComplete="email"
                    inputMode="email"
                    spellCheck={false}
                    placeholder="name@company.com"
                    className={`${styles.shareDialogInput} ${shareEmailErr ? styles.shareDialogInputErr : ''}`}
                    value={shareEmailInput}
                    onChange={(e) => { setShareEmailInput(e.target.value); if (shareEmailErr) setShareEmailErr(null); }}
                  />
                  {shareEmailErr && (
                    <div className={styles.shareDialogFieldErr}>{shareEmailErr}</div>
                  )}

                  <label className={styles.shareDialogLabel} htmlFor="shareNoteInput">
                    {SHARE_NOTE_LABEL[channel]} <span className={styles.shareDialogOpt}>(optional)</span>
                  </label>
                  <textarea
                    id="shareNoteInput"
                    rows={channel === 'outlook' ? 2 : 3}
                    placeholder={SHARE_NOTE_PLACEHOLDER[channel]}
                    className={styles.shareDialogTextarea}
                    value={shareNoteInput}
                    onChange={(e) => setShareNoteInput(e.target.value)}
                  />

                  <div className={styles.shareDialogActions}>
                    <button type="button" className={styles.shareDialogCancel}
                            onClick={closeShareDialog}>Cancel</button>
                    <button type="submit" className={styles.shareDialogSend}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                           strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="22" y1="2" x2="11" y2="13"/>
                        <polygon points="22 2 15 22 11 13 2 9 22 2"/>
                      </svg>
                      Send report
                    </button>
                  </div>
                </form>
              </div>
            </div>
          );
        })()}

        {reportOpen && (
          <div className={styles.reportModalBackdrop}>
            <div className={styles.reportModal}>
              <div className={styles.reportModalHeader}>
                <span className={styles.reportModalTitle}>Scan Report · {scanId}</span>
                <button className={styles.reportModalClose} onClick={() => setReportOpen(false)} aria-label="Close">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </div>
              <iframe className={styles.reportModalFrame} src={reportUrl('html')} title="Scan report" />
            </div>
          </div>
        )}

        {credsOpen && (
          <CredsModal
            initial={switchCreds}
            onCancel={() => { setCredsOpen(false); setPendingConsoleOpen(false); }}
            onSubmit={submitCreds}
          />
        )}

        {consoleOpen && (
          <div className={styles.consoleSheetWrap}>
            <div className={styles.consoleSheetBackdrop} onClick={exitConsole} />
            <div className={styles.consoleSheet}>
              <div className={styles.consoleSheetHandle} />
              <div className={styles.consoleSheetHeader}>
                <div className={styles.consoleSheetTitleWrap}>
                  <span className={styles.consoleSheetTitle}>Switch Console</span>
                  <span className={styles.consoleSheetSub}>
                    {switchCreds.host} · {deriveInterface(portNum)}
                    {consoleRunMs != null && (
                      <span className={styles.timingBadge} style={{ marginLeft: 8 }} title="Time to complete automated console commands">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                        </svg>
                        Done in {fmtMs(consoleRunMs)}
                      </span>
                    )}
                  </span>
                </div>
                <div className={styles.consoleSheetActions}>
                  <button
                    className={styles.consoleSheetDone}
                    onClick={finishConsole}
                    disabled={consoleEntries.length === 0}
                    title="Show consolidated report for this port">
                    Done
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                  </button>
                  <button className={styles.consoleSheetExit} onClick={exitConsole}>
                    Exit
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  </button>
                </div>
              </div>

              {/* ── Intent picker bar — user-driven, no automation ── */}
              <div className={styles.intentBar}>
                <select
                  className={styles.intentSelect}
                  value={selectedIntentId}
                  onChange={e => setSelectedIntentId(e.target.value)}
                  disabled={consoleStatus === 'running-manual' || consoleIntents.length === 0}
                  aria-label="Choose what to look up">
                  <option value="">Choose what to look up…</option>
                  {consoleIntents.map(it => (
                    <option key={it.id} value={it.id}>{it.label}</option>
                  ))}
                </select>
                <button
                  className={styles.intentRunBtn}
                  onClick={() => selectedIntentId && runIntent(selectedIntentId)}
                  disabled={!selectedIntentId || consoleStatus === 'running-manual'}>
                  {consoleStatus === 'running-manual'
                    ? <span className={styles.btnSpinner} />
                    : <>Run <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg></>}
                </button>
              </div>

              <div className={styles.consoleTerminal} ref={consoleTermRef}>
                {consoleEntries.length === 0 && consoleStatus !== 'running-manual' && (
                  <div className={styles.consoleEmpty}>
                    Pick an option above and tap <strong>Run</strong> to query the switch.
                    Nothing runs until you ask.
                  </div>
                )}

                {/* Result list — show only the friendly label + the cleaned
                    output. The raw shell command is intentionally hidden. */}
                {consoleEntries.map((entry, i) => (
                  <div key={`e-${i}`} className={styles.consoleEntry}>
                    <div className={styles.consoleEntryHead}>
                      <span className={styles.consolePrompt}>▸</span>
                      <span className={styles.intentLabel}>{entry.name || 'Result'}</span>
                    </div>
                    {entry.error
                      ? <pre className={`${styles.consoleOut} ${styles.consoleOutErr}`}>{entry.error}</pre>
                      : <pre className={styles.consoleOut}>{entry.output || '(no output)'}</pre>}
                  </div>
                ))}

                {consoleStatus === 'running-manual' && (
                  <div className={styles.consoleTermLine}>
                    <span className={styles.consolePrompt}>▸</span>
                    <span className={styles.consoleHint}>Running…</span>
                  </div>
                )}
              </div>

              <div className={styles.consoleInputRow}>
                <span className={styles.consolePrompt}>$</span>
                <input className={styles.consoleInput}
                  type="text"
                  placeholder="Or type any command (e.g. show version)"
                  value={manualCmd}
                  onChange={e => setManualCmd(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && manualCmd.trim() && runManualCommand()}
                  disabled={consoleStatus === 'running-manual'} />
                <button className={styles.consoleSendBtn}
                  onClick={runManualCommand}
                  disabled={!manualCmd.trim() || consoleStatus === 'running-auto' || consoleStatus === 'running-manual'}>
                  Run
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Ticket-mode simplified report modal — just the essentials */}
        {ticketReportOpen && ticketMode && ticket && (
          <div
            onClick={() => setTicketReportOpen(false)}
            style={{
              position:'fixed', inset:0, zIndex:9999,
              background:'rgba(0,0,0,0.75)',
              display:'flex', alignItems:'center', justifyContent:'center',
              padding:16,
            }}>
            <div
              onClick={e => e.stopPropagation()}
              style={{
                width:'min(560px, 100%)',
                maxHeight:'90vh',
                overflow:'auto',
                background:'#0f1420',
                border:'1px solid rgba(255,255,255,0.12)',
                borderRadius:14,
                padding:18,
                color:'var(--text, #e5e7eb)',
              }}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:12}}>
                <div>
                  <div style={{fontSize:10,fontWeight:600,letterSpacing:'0.08em',color:'#22d3ee',textTransform:'uppercase'}}>Incident Report</div>
                  <div style={{fontSize:18,fontWeight:600,marginTop:2}}>{ticket.incident_number}</div>
                </div>
                <button onClick={() => setTicketReportOpen(false)} style={{background:'none',border:'none',color:'var(--muted, #9ca3af)',cursor:'pointer',fontSize:20,lineHeight:1}}>×</button>
              </div>

              {/* Incident */}
              <div style={{marginBottom:14}}>
                <div style={{fontSize:10,fontWeight:600,letterSpacing:'0.06em',color:'var(--muted, #9ca3af)',textTransform:'uppercase',marginBottom:4}}>Incident</div>
                <div style={{fontSize:14,lineHeight:1.4}}>{ticket.short_description}</div>
                <div style={{fontSize:12,color:'var(--muted, #9ca3af)',marginTop:4}}>
                  {ticket.priority} · opened {ticket.opened_at || '?'}
                </div>
              </div>

              {/* Image */}
              <div style={{marginBottom:14}}>
                <div style={{fontSize:10,fontWeight:600,letterSpacing:'0.06em',color:'var(--muted, #9ca3af)',textTransform:'uppercase',marginBottom:4}}>Image</div>
                {rackImg || resultImg ? (
                  <img src={rackImg || resultImg} alt="Located port" style={{width:'100%',maxHeight:280,objectFit:'contain',borderRadius:8,border:'1px solid rgba(255,255,255,0.08)'}}/>
                ) : <div style={{fontSize:12,color:'var(--muted, #9ca3af)'}}>not available</div>}
              </div>

              {/* Port located */}
              <div style={{marginBottom:14}}>
                <div style={{fontSize:10,fontWeight:600,letterSpacing:'0.06em',color:'var(--muted, #9ca3af)',textTransform:'uppercase',marginBottom:4}}>Port Located</div>
                <div style={{fontSize:14}}>
                  <strong>{ticket.target?.device}</strong> @ <strong>{ticket.cmdb?.interface_alias || `port ${ticket.target?.port}`}</strong>
                </div>
                <div style={{fontSize:12,color:'var(--muted, #9ca3af)',marginTop:2}}>
                  {ticket.cmdb?.rack_name} · {ticket.cmdb?.model || '?'} · mgmt {ticket.cmdb?.mgmt_ip || '?'}
                </div>
              </div>

              {/* Output */}
              <div style={{marginBottom:14}}>
                <div style={{fontSize:10,fontWeight:600,letterSpacing:'0.06em',color:'var(--muted, #9ca3af)',textTransform:'uppercase',marginBottom:4}}>Output</div>
                {liveSnapshot?.ok ? (
                  <div style={{fontSize:13,lineHeight:1.6,fontFamily:'ui-monospace, monospace',background:'rgba(255,255,255,0.03)',padding:10,borderRadius:6}}>
                    <div>link        : <strong style={{color: liveSnapshot.link_active ? '#34d399' : '#fbbf24'}}>{liveSnapshot.link_active ? 'active' : 'idle'}</strong></div>
                    <div>neighbor    : {liveSnapshot.has_neighbor ? (liveSnapshot.neighbor?.sysname || 'present') : 'none'}</div>
                    {liveSnapshot.neighbor?.port_id && <div>remote port : {liveSnapshot.neighbor.port_id}</div>}
                    {liveSnapshot.neighbor?.mgmt_ip && <div>remote mgmt : {liveSnapshot.neighbor.mgmt_ip}</div>}
                    <div>macs        : {liveSnapshot.mac_count}{liveSnapshot.first_mac ? ` (${liveSnapshot.first_mac})` : ''}</div>
                    <div>method      : {liveSnapshot.neighbor_method}</div>
                    <div>as of       : {new Date(liveSnapshot.as_of).toLocaleTimeString()}</div>
                  </div>
                ) : liveSnapshot ? (
                  <div style={{fontSize:12,color:'#fbbf24'}}>Live sample failed: {liveSnapshot.error}</div>
                ) : (
                  <div style={{fontSize:12,color:'var(--muted, #9ca3af)'}}>no live sample yet</div>
                )}
              </div>

              {/* Suggestions */}
              <div>
                <div style={{fontSize:10,fontWeight:600,letterSpacing:'0.06em',color:'var(--muted, #9ca3af)',textTransform:'uppercase',marginBottom:4}}>Suggestions</div>
                <div style={{fontSize:13,lineHeight:1.5}}>
                  {(() => {
                    if (liveResolvedAt) return <span style={{color:'#34d399'}}>✓ Port is active now — cable was attached at {new Date(liveResolvedAt).toLocaleTimeString()}. Incident likely resolved; verify with monitoring, then close the ticket.</span>;
                    if (liveSnapshot?.link_active) return <span style={{color:'#34d399'}}>Port is currently active. Issue may be intermittent — watch for re-flaps over the next few minutes.</span>;
                    if (liveSnapshot?.ok && !liveSnapshot.link_active) return <span>No traffic on this port right now. Verify the cable is plugged in on both ends, check the far-end device power/NIC status, then re-monitor.</span>;
                    if (liveSnapshot && !liveSnapshot.ok) return <span>Cannot reach the switch over SSH to verify. Check mgmt connectivity to {ticket.cmdb?.mgmt_ip || 'the switch'}.</span>;
                    return <span style={{color:'var(--muted, #9ca3af)'}}>Waiting for first live sample.</span>;
                  })()}
                </div>
              </div>
            </div>
          </div>
        )}

        {portReportOpen && portReport && (
          <PortReportModal report={portReport} onClose={() => setPortReportOpen(false)} />
        )}

        {switchInfoOpen && (
          <SwitchInfoModal
            status={switchInfoStatus}
            info={switchInfoData}
            raw={switchInfoRaw}
            error={switchInfoError}
            host={switchCreds.host}
            vendor={switchCreds.vendor}
            specs={switchSpecs}
            specsStatus={switchSpecsStatus}
            specsError={switchSpecsError}
            firmware={switchFirmware}
            firmwareStatus={switchFirmwareStatus}
            firmwareError={switchFirmwareError}
            onClose={() => setSwitchInfoOpen(false)}
            onRetry={fetchSwitchInfo}
          />
        )}
      </div>
    );
  }

  // ── Detect view ──────────────────────────────────────────
  return (
    <div className={`page page-full ${styles.results}`}>
      <div className={styles.amb} />

      <header className={styles.header}>
        <button className="btn btn-ghost btn-icon" onClick={() => navigate('/scan')}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
          </svg>
        </button>
        <div className={styles.headerCenter}>
          <h2 className={styles.headerTitle}>Scan Results</h2>
          <div className={styles.headerMetaRow}>
            <span className={styles.headerMono}>
              {rackId || scanId}
            </span>
          </div>
        </div>
        <div style={{ width: 40 }} />
      </header>

      {/* Rack-tab strip — only renders when this rack is part of a multi-rack scan */}
      <RackTabs rackId={rackId || scanId} />

      <ScanTabBar
        activeTab={tab}
        onTabChange={setTab}
        badges={{
          ports: devices.filter(d => d.class_name === 'Switch').reduce((s, d) => s + (d.port_count || 0), 0) || undefined,
          switches: devices.filter(d => d.class_name === 'Switch' || d.class_name === 'Router').length || undefined,
        }}
      />

      {tab === 'overview' && (<>
      {qualityWarning && !warningDismissed && (
        <div className={styles.qualityModalBackdrop}>
          <div className={styles.qualityModal}>
            <div className={styles.qualityModalIcon}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
                <line x1="12" y1="9" x2="12" y2="13"/>
                <line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
            </div>
            <h3 className={styles.qualityModalTitle}>Image quality warning</h3>
            <p className={styles.qualityModalMsg}>
              {qualityWarningMsg || 'Image may not be ideal — results may be less accurate.'}
            </p>
            <ul className={styles.qualityModalTips}>
              <li>Stand directly in front of the rack — not at an angle.</li>
              <li>Keep the camera level with the middle of the rack.</li>
              <li>Make sure the full rack fits inside the frame.</li>
            </ul>
            <div className={styles.qualityModalActions}>
              <button className={styles.qualityRetake} onClick={() => navigate('/scan')}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="23 4 23 10 17 10"/>
                  <path d="M20.49 15A9 9 0 1 1 5.64 5.64L23 10"/>
                </svg>
                Retake
              </button>
              <button className={styles.qualityProceed} onClick={() => setWarningDismissed(true)}>
                Proceed anyway
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Hero image ── */}
      <div className={styles.heroWrap}>
        <div className={styles.zoomViewport}
          onWheel={handleWheel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onPointerLeave={handlePointerLeave}
        >
          <div className={styles.heroImgWrap} style={{ transform: imageTransform, cursor: cursorStyle }}>
            <img src={heroImgSrc} alt="Rack scan" className={styles.heroImg}
              onLoad={e => setImgNat({ w: e.target.naturalWidth, h: e.target.naturalHeight })}
              draggable="false"
            />
            {imgNat && (
              <svg className={styles.devOverlay} viewBox={`0 0 ${imgNat.w} ${imgNat.h}`} preserveAspectRatio="xMidYMid meet">
                <defs>
                  <filter id="neon">
                    <feGaussianBlur in="SourceGraphic" stdDeviation="4" result="blur" />
                    <feMerge><feMergeNode in="blur" /><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
                  </filter>
                </defs>
                {/* Rect + label chip per detected device.
                    Pickable (port-bearing) devices are tappable for port inspection;
                    other real devices (PDU/UPS/Server-no-ports, etc.) still render so
                    the user sees the full detection coverage at a glance. Placeholder
                    Empty / Unidentified / Closed Unit boxes stay hidden — they're
                    rack-slot fillers, not actionable. Uses effectiveDevices so any
                    brand-token class override (Planar→Controller, etc.) drives both
                    chip color and the hidden/visible filter. */}
                {effectiveDevices.map((dev, i) => {
                  if (!dev?.box || HIDDEN_DEVICE_TYPES.has(dev.class_name)) return null;
                  const idx = i + 1;
                  const isSel = selectedIdx === idx;
                  if (isSel) return null; // selected rendered last for z-order
                  const pickable = isDevicePickable(dev);
                  const [bx1, by1, bx2, by2] = dev.box;
                  const w = bx2 - bx1, h = by2 - by1;
                  const color = getColor(dev.class_name);
                  const lbl = labels[i] || '';
                  // Chip size scales with image resolution so it reads on any rack size
                  const chipH = Math.max(18, Math.min(44, h * 0.42));
                  const chipPadX = chipH * 0.6;
                  const chipW = Math.max(chipH * 2.2, lbl.length * chipH * 0.45 + chipPadX * 2);
                  const chipX = bx1 + 4;
                  const chipY = by1 + 4;
                  const handleTap = pickable ? (e) => {
                    e.stopPropagation();
                    setSelectedIdx(idx);
                    setPortNum(''); setPortInfo(null); setError(null);
                    setDeviceFbStatus('idle');
                    setActualDeviceClass('');
                    setDeviceFbError(null);
                    setPortCountFbStatus('idle');
                    setActualPortCount('');
                    setPortCountFbError(null);
                  } : undefined;
                  return (
                    <g
                      key={idx}
                      className={styles.devPickGroup}
                      onClick={handleTap}
                      style={pickable ? undefined : { opacity: 0.7, pointerEvents: 'none' }}
                    >
                      <rect
                        x={bx1} y={by1} width={w} height={h} rx="4"
                        className={styles.devPickRect}
                        style={{
                          stroke: color,
                          strokeDasharray: pickable ? undefined : '6 4',
                        }}
                      />
                      {lbl && (
                        <g className={styles.devPickChip}>
                          <rect
                            x={chipX} y={chipY}
                            width={chipW} height={chipH}
                            rx={chipH / 2}
                            fill="rgba(0,0,0,0.78)"
                            stroke={color}
                            strokeWidth="1.5"
                          />
                          <text
                            x={chipX + chipW / 2}
                            y={chipY + chipH / 2}
                            textAnchor="middle"
                            dominantBaseline="central"
                            fill={color}
                            fontFamily="var(--mono, monospace)"
                            fontWeight="700"
                            fontSize={chipH * 0.52}
                          >
                            {lbl}
                          </text>
                        </g>
                      )}
                    </g>
                  );
                })}
                {selectedDevice && (() => {
                  const [bx1, by1, bx2, by2] = selectedDevice.box;
                  const w = bx2 - bx1, h = by2 - by1;
                  const c = 40;
                  return (
                    <g>
                      {/* Bright red neon border */}
                      <rect x={bx1} y={by1} width={w} height={h} rx="6"
                        fill="none" stroke="#ef4444" strokeWidth="3" filter="url(#neon)"
                        className={styles.devNeonBorder}
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedIdx(null);
                          setPortNum(''); setPortInfo(null); setError(null);
                        }}
                      />
                      {/* Red corner brackets */}
                      <g filter="url(#neon)" className={styles.devNeonCorners}>
                        <path d={`M${bx1},${by1+c} L${bx1},${by1} L${bx1+c},${by1}`} fill="none" stroke="#ff6b6b" strokeWidth="5" strokeLinecap="round" />
                        <path d={`M${bx2-c},${by1} L${bx2},${by1} L${bx2},${by1+c}`} fill="none" stroke="#ff6b6b" strokeWidth="5" strokeLinecap="round" />
                        <path d={`M${bx1},${by2-c} L${bx1},${by2} L${bx1+c},${by2}`} fill="none" stroke="#ff6b6b" strokeWidth="5" strokeLinecap="round" />
                        <path d={`M${bx2-c},${by2} L${bx2},${by2} L${bx2},${by2-c}`} fill="none" stroke="#ff6b6b" strokeWidth="5" strokeLinecap="round" />
                      </g>
                    </g>
                  );
                })()}
              </svg>
            )}
          </div>
        </div>
        <div className={styles.zoomControls}>
          <button type="button" className={styles.zoomButton} onClick={zoomOut} aria-label="Zoom out">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="7" />
              <line x1="16.5" y1="16.5" x2="21" y2="21" />
              <line x1="8" y1="11" x2="14" y2="11" />
            </svg>
          </button>
          <button type="button" className={styles.zoomButton} onClick={zoomIn} aria-label="Zoom in">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="7" />
              <line x1="16.5" y1="16.5" x2="21" y2="21" />
              <line x1="11" y1="8" x2="11" y2="14" />
              <line x1="8" y1="11" x2="14" y2="11" />
            </svg>
          </button>
        </div>
        {analysisTimings?.total_ms != null && (
          <span className={`${styles.timingBadge} ${styles.heroTiming}`} title="Time from image upload to detect mode">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
            </svg>
            Done in {fmtMs(analysisTimings.total_ms)}
          </span>
        )}
        {/* scan line animation */}
        <div className={styles.scanLine} />
        {/* corner HUD */}
        <span className={`${styles.hc} ${styles.hcTL}`} />
        <span className={`${styles.hc} ${styles.hcTR}`} />
        <span className={`${styles.hc} ${styles.hcBL}`} />
        <span className={`${styles.hc} ${styles.hcBR}`} />
        {/* bottom fade */}
        <div className={styles.heroFade} />
        {/* info badge */}
        <div className={styles.heroBadge}>
          <span className={styles.heroBadgeDot} />
          <span className={styles.heroBadgeTxt}>ANALYZED</span>
        </div>
        {/* Tap-to-select prompt — shown only until a device is picked */}
        {!selectedDevice && (
          <div className={styles.tapPrompt}>
            <span className={styles.tapPromptPulse} />
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 11.24V7.5a2.5 2.5 0 015 0v3.74"/>
              <path d="M14 10V4.5a2.5 2.5 0 015 0v9.75"/>
              <path d="M19 14.5a2.5 2.5 0 015 0v2.94a7 7 0 01-7 7h-3a7 7 0 01-6.15-3.64L6 17.5"/>
            </svg>
            Tap a device to inspect its ports
          </div>
        )}
      </div>

      {/* Selected device label — plain text just below the hero, no container. */}
      {selectedDevice && (
        <div className={styles.heroLabel}>
          <span className={styles.heroLabelVal} style={{ color: selColor }}>{selectedLabel}</span>
          <span className={styles.heroLabelType}>{selectedDevice.class_name}</span>
        </div>
      )}

      {/* ── Action sheet ── */}
      <div className={styles.sheet}>

        {/* Manual-mode device dropdown — alternative to tapping the hero
            rectangle (mobile-friendly). Hidden in ticket-mode and when the
            all-devices view is up. */}
        {!ticketMode && phase !== 'all' && (() => {
          const pickables = effectiveDevices
            .map((dev, i) => ({ dev, idx: i + 1, label: labels[i] || `Device ${i + 1}` }))
            .filter(({ dev }) => isDevicePickable(dev));
          if (pickables.length === 0) return null;
          return (
            <div style={{margin:'0 0 14px', padding:'0 2px'}}>
              <label style={{
                display:'block',
                fontSize:11,
                fontWeight:600,
                letterSpacing:'0.10em',
                color:'var(--t2)',
                textTransform:'uppercase',
                marginBottom:6,
              }}>
                Device
              </label>
              <select
                value={selectedIdx || ''}
                onChange={(e) => {
                  const v = e.target.value;
                  if (!v) {
                    setSelectedIdx(null);
                    setPortNum(''); setPortInfo(null); setError(null);
                    return;
                  }
                  const idx = parseInt(v, 10);
                  setSelectedIdx(idx);
                  setPortNum(''); setPortInfo(null); setError(null);
                  setDeviceFbStatus('idle');
                  setActualDeviceClass('');
                  setDeviceFbError(null);
                  setPortCountFbStatus('idle');
                  setActualPortCount('');
                  setPortCountFbError(null);
                }}
                style={{
                  width:'100%',
                  padding:'10px 12px',
                  borderRadius:10,
                  background:'var(--card)',
                  color:'var(--t1)',
                  border:`1px solid ${selectedIdx ? selColor : 'var(--gb)'}`,
                  fontSize:14,
                  appearance:'auto',
                }}>
                <option value="">— Pick a device (or tap one in the image) —</option>
                {pickables.map(({ dev, idx, label }) => (
                  <option key={idx} value={idx}>
                    {label} · {dev.class_name}
                    {dev.port_count > 0 ? ` · ${dev.port_count} ports` : ''}
                  </option>
                ))}
              </select>
            </div>
          );
        })()}

        {selectedDevice && (
          <div className={styles.portCard} style={{ '--accent': selColor }}>
            <div className={styles.portCardTop}>
              <div>
                <p className={styles.portCardTitle}>Port number</p>
                <p className={styles.portCardSub}>
                  {selectedDevice.port_count > 0
                    ? `Enter port number · ${selectedDevice.port_count} detected`
                    : 'Enter the port number'}
                </p>
              </div>
              {portLabel && (
                <span className={styles.portCardLabel} style={{ color: selColor }}>
                  {portLabel}
                </span>
              )}
            </div>
            <div className={styles.portInputRow}>
              <input
                className={`input ${styles.portInput}`}
                type="number" min="1"
                max={selectedDevice.port_count > 0 ? selectedDevice.port_count : undefined}
                style={{ '--focus-color': selColor }}
                placeholder={selectedDevice.port_count > 0 ? `1–${selectedDevice.port_count}` : 'Port #'}
                value={portNum}
                onChange={e => { setPortNum(e.target.value); setPortInfo(null); setError(null); }}
                onKeyDown={e => e.key === 'Enter' && portNum && findPort()}
                autoFocus
              />
              <button
                type="button"
                className={`btn btn-primary ${styles.findBtn}`}
                style={{ '--btn-glow': selColor }}
                disabled={!portNum || loading}
                onClick={() => findPort()}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                </svg>
                Find Port
              </button>
            </div>
            {loading && (
              <div className={styles.portLoadingRow}>
                <span className={styles.btnSpinner} />
                <span>Locating port…</span>
              </div>
            )}
          </div>
        )}

        {/* Device-classification feedback — shown below the port picker */}
        {selectedDevice && deviceFbStatus !== 'hidden' && (
          <div className={styles.fbCard} style={{ '--ac': selColor }}>
            {deviceFbStatus === 'idle' && (
              <>
                <span className={styles.fbPrompt}>
                  Detected as {selectedDevice.class_name}. Right?
                </span>
                <div className={styles.fbBtnRow}>
                  <button className={`${styles.fbBtn} ${styles.fbBtnYes}`}
                    onClick={() => submitDeviceFeedback(true)}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                    Yes
                  </button>
                  <button className={`${styles.fbBtn} ${styles.fbBtnNo}`}
                    onClick={() => { setDeviceFbStatus('wrong-pending'); setDeviceFbError(null); }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    No
                  </button>
                </div>
              </>
            )}
            {deviceFbStatus === 'wrong-pending' && (
              <>
                <span className={styles.fbPrompt}>What's the actual device type?</span>
                <div className={styles.fbInputRow}>
                  <select className={`input ${styles.fbInput}`}
                    style={{ '--focus-color': selColor }}
                    value={actualDeviceClass}
                    onChange={e => { setActualDeviceClass(e.target.value); setDeviceFbError(null); }}
                    autoFocus>
                    <option value="">Pick actual type…</option>
                    {DEVICE_CLASS_OPTIONS.map(c => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                  <button className={`${styles.fbBtn} ${styles.fbBtnSubmit}`}
                    style={{ '--btn-glow': selColor }}
                    disabled={!actualDeviceClass}
                    onClick={() => submitDeviceFeedback(false)}>
                    Submit
                  </button>
                  <button className={`${styles.fbBtn} ${styles.fbBtnCancel}`}
                    onClick={() => { setDeviceFbStatus('idle'); setActualDeviceClass(''); setDeviceFbError(null); }}>
                    Cancel
                  </button>
                </div>
              </>
            )}
            {deviceFbStatus === 'submitting' && (
              <span className={styles.fbPrompt}>Saving…</span>
            )}
            {deviceFbStatus === 'submitted' && (
              <span className={styles.fbDone}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                Thanks — device feedback saved
              </span>
            )}
            {deviceFbError && (
              <span className={styles.fbErr}>{deviceFbError}</span>
            )}
          </div>
        )}

        {/* Port-count feedback — shown independently once the device feedback is
            no longer visible ('hidden' or 'submitted'). Using both states makes
            the chain robust even if the device fb is skipped. */}
        {selectedDevice && (deviceFbStatus === 'hidden' || deviceFbStatus === 'submitted') && portCountFbStatus !== 'hidden' && (
          <div className={styles.fbCard} style={{ '--ac': selColor }}>
            {portCountFbStatus === 'idle' && (
              <>
                <span className={styles.fbPrompt}>
                  Detected {selectedDevice.port_count ?? 0} port{selectedDevice.port_count === 1 ? '' : 's'}. Right?
                </span>
                <div className={styles.fbBtnRow}>
                  <button className={`${styles.fbBtn} ${styles.fbBtnYes}`}
                    onClick={() => submitPortCountFeedback(true)}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                    Yes
                  </button>
                  <button className={`${styles.fbBtn} ${styles.fbBtnNo}`}
                    onClick={() => { setPortCountFbStatus('wrong-pending'); setPortCountFbError(null); }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    No
                  </button>
                </div>
              </>
            )}
            {portCountFbStatus === 'wrong-pending' && (
              <>
                <span className={styles.fbPrompt}>What's the actual port count?</span>
                <div className={styles.fbInputRow}>
                  <input className={`input ${styles.fbInput}`} type="number" min="0"
                    style={{ '--focus-color': selColor }}
                    placeholder="e.g. 24"
                    value={actualPortCount}
                    onChange={e => { setActualPortCount(e.target.value); setPortCountFbError(null); }}
                    onKeyDown={e => e.key === 'Enter' && actualPortCount !== '' && submitPortCountFeedback(false)}
                    autoFocus />
                  <button className={`${styles.fbBtn} ${styles.fbBtnSubmit}`}
                    style={{ '--btn-glow': selColor }}
                    disabled={actualPortCount === ''}
                    onClick={() => submitPortCountFeedback(false)}>
                    Submit
                  </button>
                  <button className={`${styles.fbBtn} ${styles.fbBtnCancel}`}
                    onClick={() => { setPortCountFbStatus('idle'); setActualPortCount(''); setPortCountFbError(null); }}>
                    Cancel
                  </button>
                </div>
              </>
            )}
            {portCountFbStatus === 'submitting' && (
              <span className={styles.fbPrompt}>Saving…</span>
            )}
            {portCountFbStatus === 'submitted' && (
              <span className={styles.fbDone}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                Thanks — port-count feedback saved
              </span>
            )}
            {portCountFbError && (
              <span className={styles.fbErr}>{portCountFbError}</span>
            )}
          </div>
        )}

        {error && (
          <div className={styles.errBox}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            {error}
          </div>
        )}
      </div>
      </>)}

      {/* ── Tab: Ports ── */}
      {tab === 'ports' && (
        <div className={styles.tabContent}>
          <PortsContent rackId={rackId || scanId} />
        </div>
      )}

      {/* ── Tab: Topology ── */}
      {tab === 'topology' && (
        <div className={styles.tabContent}>
          <TopologyContent rackId={rackId || scanId} />
        </div>
      )}

      {/* ── Tab: Network ── */}
      {tab === 'network' && (
        <div className={styles.tabContent}>
          <NetdiscoContent rackId={rackId || scanId} />
        </div>
      )}

      {/* ── Tab: Switches ── */}
      {tab === 'switches' && (
        <div className={styles.tabContent}>
          <SwitchInfoContent rackId={rackId || scanId} />
        </div>
      )}

      {/* ── Tab: Drift (continuous SSH telemetry from monitored switches) ── */}
      {tab === 'drift' && (
        <div className={styles.tabContent}>
          <PortHistoryContent />
        </div>
      )}

      {/* Loading overlay */}
      {loading && (
        <div className={styles.loadOverlay}>
          <div className={styles.loadRing} style={{ '--c': selColor }}>
            <div className={styles.loadRingInner} />
          </div>
          <p className={styles.loadTitle}>Identifying</p>
          <p className={styles.loadSub}>{buildPortLabel(selectedLabel, selectedDevice?.class_name, portNum)}</p>
        </div>
      )}

      {reportOpen && (
        <div className={styles.reportModalBackdrop}>
          <div className={styles.reportModal}>
            <div className={styles.reportModalHeader}>
              <span className={styles.reportModalTitle}>Scan Report · {scanId}</span>
              <button className={styles.reportModalClose} onClick={() => setReportOpen(false)} aria-label="Close">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
            <iframe className={styles.reportModalFrame} src={reportUrl('html')} title="Scan report" />
          </div>
        </div>
      )}

      {devOpen && (
        <div className={styles.diagPanel}>
          <div className={styles.diagHeader}>
            <span className={styles.diagTitle}>Diagnostics</span>
            <button className={styles.diagClose} onClick={() => setDevOpen(false)} aria-label="Close diagnostics">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>

          <div className={styles.diagSection}>
            <div className={styles.diagSectionLabel}>Image → Detect</div>
            {analysisTimings ? (
              <>
                {analysisTimings.cached && <div className={styles.diagRow}><span>cache</span><span className={styles.diagVal}>HIT</span></div>}
                <div className={styles.diagRow}><span>normalize</span><span className={styles.diagVal}>{fmtMs(analysisTimings.normalize_ms)}</span></div>
                <div className={styles.diagRow}><span>quality_check</span><span className={styles.diagVal}>{fmtMs(analysisTimings.quality_check_ms)}</span></div>
                <div className={styles.diagRow}><span>pipeline</span><span className={styles.diagVal}>{fmtMs(analysisTimings.pipeline_ms)}</span></div>
                <div className={`${styles.diagRow} ${styles.diagRowTotal}`}><span>total</span><span className={styles.diagVal}>{fmtMs(analysisTimings.total_ms)}</span></div>
              </>
            ) : (
              <div className={styles.diagEmpty}>No timing data</div>
            )}
          </div>

          {phase === 'port' && (
            <div className={styles.diagSection}>
              <div className={styles.diagSectionLabel}>Device + Port → Result</div>
              {portTimings ? (
                <>
                  <div className={styles.diagRow}><span>pipeline</span><span className={styles.diagVal}>{fmtMs(portTimings.pipeline_ms)}</span></div>
                  <div className={`${styles.diagRow} ${styles.diagRowTotal}`}><span>total</span><span className={styles.diagVal}>{fmtMs(portTimings.total_ms)}</span></div>
                </>
              ) : (
                <div className={styles.diagEmpty}>No port detection yet</div>
              )}
            </div>
          )}

          {selectedDevice && (
            <div className={styles.diagSection}>
              <div className={styles.diagSectionLabel}>Confidences</div>
              <div className={styles.diagRow}><span>device class</span><span className={styles.diagVal}>{fmtPct(selectedDevice.confidence)}</span></div>
              {portInfo && (
                <>
                  <div className={styles.diagRow}><span>port detection</span><span className={styles.diagVal}>{fmtPct(portInfo.confidence)}</span></div>
                  {portInfo.cable_confidence != null && (
                    <div className={styles.diagRow}><span>cable color</span><span className={styles.diagVal}>{fmtPct(portInfo.cable_confidence)}</span></div>
                  )}
                  {portInfo.port_type_confidence != null && (
                    <div className={styles.diagRow}><span>port type</span><span className={styles.diagVal}>{fmtPct(portInfo.port_type_confidence)}</span></div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

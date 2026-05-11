// Singleton SSH probe of the user's network switch.
//
// Triggered at scan-start (parallel to CV) and the result is cached in
// localStorage so subsequent visits to the Available Ports page show the
// last-known state instantly without re-probing. Re-fires only when:
//   - a new scan starts (ScanPage calls triggerBackgroundProbe)
//   - the user clicks Retry (force: true)
//
// Independent of the LLDP "find the other end of this cable" feature —
// different consumer, same encrypted credentials path on the server.
import { apiUrl, authFetch } from './api';

const STORAGE_KEY = 'racktrack:portsProbe';

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (data?.status === 'ok' && Array.isArray(data.ports)) return data;
    return null;
  } catch (_) { return null; }
}
function saveToStorage(s) {
  try {
    if (s?.status === 'ok') localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch (_) { /* quota / disabled */ }
}

const cached = loadFromStorage();
const state = cached || {
  status: 'idle',     // 'idle' | 'running' | 'ok' | 'error'
  ports: null,        // [{ iface, status, description }]
  error: null,
  host: null,
  startedAt: null,
  finishedAt: null,
};
const subs = new Set();

function notify() { for (const fn of subs) { try { fn({ ...state }); } catch (_) {} } }
function setState(patch) { Object.assign(state, patch); saveToStorage(state); notify(); }

export function getProbeState() { return { ...state }; }
export function subscribeProbe(fn) {
  subs.add(fn);
  try { fn({ ...state }); } catch (_) {}
  return () => subs.delete(fn);
}
export function resetProbe() {
  try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
  setState({ status: 'idle', ports: null, error: null, host: null, startedAt: null, finishedAt: null });
}

// Parse `show interface status` rows. Tolerant to TP-Link / Cisco-ish layouts.
function parseInterfaceStatusTable(text) {
  if (!text) return [];
  // Strip null bytes and paging prompts that remain after --More-- auto-advance.
  // TP-Link emits: "Press any key to continue (Q to quit)\0<spaces><next line>"
  const cleaned = text
    .replace(/\x00/g, '')
    .replace(/Press any key to continue[^\n]*/gi, '\n')
    .replace(/--More--[^\n]*/g, '\n')
    .replace(/<--- More --->[^\n]*/g, '\n');
  const out = [];
  for (const rawLine of cleaned.split('\n')) {
    const line = rawLine.replace(/\r$/, '').trim();
    if (!line) continue;
    if (/^port\b/i.test(line)) continue;
    if (/^-+\s*$/.test(line)) continue;
    if (/^\s*Total/i.test(line)) continue;
    const m = line.match(/^(\S+)\s+(\S+)(?:\s+(\S+))?(?:\s+(\S+))?(?:\s+(\S+))?(?:\s+(\S+))?(?:\s+(.*))?$/);
    if (!m) continue;
    const iface = m[1];
    if (!/^([A-Za-z]{1,4}\d+(\/\d+){0,3}|Eth\d+(\/\d+)?)$/i.test(iface)) continue;
    out.push({
      iface,
      status: (m[2] || '').toLowerCase(),
      medium: (m[6] || '').trim().toLowerCase(),   // 'copper' | 'fiber' | ''
      description: (m[7] || '').trim(),
    });
  }
  return out;
}
export { parseInterfaceStatusTable };

export function logicalVerdict(row) {
  const s = (row.status || '').toLowerCase();
  const hasDesc = !!(row.description && row.description.trim());
  if (/(linkup|connected|^up$)/i.test(s)) return 'used';
  if (/(err|disable|shutdown|admin)/i.test(s)) return 'reserved';
  return hasDesc ? 'reserved' : 'available';
}

let inflight = false;

// Idempotent: if a probe is already running or finished successfully, this
// returns immediately. Pass `force: true` to re-probe (e.g. user-pressed Retry).
export async function triggerBackgroundProbe({ force = false } = {}) {
  if (!force) {
    if (state.status === 'ok' || state.status === 'running') return;
  }
  if (inflight) return;
  inflight = true;
  setState({ status: 'running', error: null, startedAt: Date.now(), finishedAt: null });

  try {
    // Resolve the switch host. Prefer the user's last successful SSH host
    // (server-side, per-user). NEVER fall back to the default gateway —
    // that's almost never the managed switch and produces a 20-second
    // ETIMEDOUT. If `last_host` is empty, use the in-office default the
    // ResultsPage flow has been using (192.168.1.13).
    const FALLBACK_SWITCH_HOST = '192.168.1.13';
    let host = state.host;
    if (!host) {
      try {
        const hr = await fetch(apiUrl('/api/switch/default-host'));
        const hj = hr.ok ? await hr.json() : null;
        host = hj?.last_host || FALLBACK_SWITCH_HOST;
      } catch (_) { host = FALLBACK_SWITCH_HOST; }
    }
    if (!host) {
      setState({ status: 'error', error: 'No network switch host configured.', finishedAt: Date.now() });
      return;
    }

    const r = await authFetch(apiUrl('/api/switch/console/run'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        host,
        command: 'show interface status',
        vendor: 'tplink',
        timeoutMs: 45000,
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
    const entry = data.entry || {};
    if (entry.error) throw new Error(entry.error);
    const parsed = parseInterfaceStatusTable(entry.output || '');
    if (parsed.length === 0) {
      setState({ status: 'error', error: 'Probe returned no port rows.', host, finishedAt: Date.now() });
      return;
    }
    setState({ status: 'ok', ports: parsed, host, finishedAt: Date.now() });
  } catch (err) {
    setState({ status: 'error', error: err.message || String(err), finishedAt: Date.now() });
  } finally {
    inflight = false;
  }
}

/**
 * Netdisco proxy router.
 *
 * Sits in front of the local Netdisco Docker stack and exposes a small,
 * stable REST surface that the React UI can call without juggling api-key
 * login, cookies, or the legacy Netdisco endpoint shapes.
 *
 *   GET  /api/netdisco/health
 *   GET  /api/netdisco/devices                    list all devices
 *   GET  /api/netdisco/devices/:ip                one device's details
 *   GET  /api/netdisco/devices/:ip/ports          port list (with neighbors + node counts)
 *   GET  /api/netdisco/mac/:mac                   MAC report (sightings + IP history)
 *   GET  /api/netdisco/scan/:rackId/match         join a RackTrack scan to Netdisco devices
 *
 * Mirrors the Python helpers under netdisco-docker/ (netdisco.py, info_ip.py,
 * port_info_mac.py, seed_netdisco.py) — same endpoints, same fallback
 * patterns. All routes require auth like the rest of the app.
 *
 * Configuration via env (server/.env):
 *   NETDISCO_URL       (default: http://localhost:5000)
 *   NETDISCO_USER      (default: admin)
 *   NETDISCO_PASSWORD  (default: admin)
 */
const express = require('express');
const path    = require('path');
const { logger, recordEvent } = require('./lib/observability');
const fs      = require('fs');
const { spawn } = require('child_process');
const auth    = require('./auth');

const router = express.Router();
const PROJECT_ROOT  = path.resolve(__dirname, '..');
const NETDISCO_DIR  = path.join(PROJECT_ROOT, 'netdisco-docker');
const PUSH_SCRIPT   = path.join(NETDISCO_DIR, 'push_rack_to_netdisco.py');
const PYTHON_CMD    = process.env.PYTHON_CMD || (process.platform === 'win32' ? 'python' : 'python3');

const NETDISCO_URL  = process.env.NETDISCO_URL      || 'http://localhost:5000';
const ND_USER       = process.env.NETDISCO_USER     || 'admin';
const ND_PASSWORD   = process.env.NETDISCO_PASSWORD || 'admin';
const TIMEOUT_MS    = 15000;

// ── API-key cache ────────────────────────────────────────────────────────
// Netdisco's /login returns an api_key. We cache it in memory and refresh
// on 401. Same shape as netdisco.py's login() helper.
let _apiKey = null;
let _loginInFlight = null;

async function _loginOnce() {
  // JSON auth first (modern Netdisco), then form-data fallback.
  const tryLogin = async (body, contentType) => {
    const res = await fetch(`${NETDISCO_URL}/login`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': contentType },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    let data;
    try { data = await res.json(); } catch { return null; }
    return data && data.api_key ? data.api_key : null;
  };

  let key = await tryLogin(
    JSON.stringify({ username: ND_USER, password: ND_PASSWORD }),
    'application/json',
  );
  if (key) return key;

  const form = new URLSearchParams({ username: ND_USER, password: ND_PASSWORD });
  key = await tryLogin(form.toString(), 'application/x-www-form-urlencoded');
  return key;
}

async function getApiKey({ force = false } = {}) {
  if (_apiKey && !force) return _apiKey;
  if (_loginInFlight) return _loginInFlight;
  _loginInFlight = (async () => {
    try {
      _apiKey = await _loginOnce();
    } finally {
      _loginInFlight = null;
    }
    return _apiKey;
  })();
  return _loginInFlight;
}

// ── Authenticated GET helper with one auto-retry on 401 ──────────────────
async function ndGet(pathAndQuery) {
  const url = `${NETDISCO_URL}${pathAndQuery}`;
  const headers = { Accept: 'application/json' };
  const apiKey = await getApiKey().catch(() => null);
  if (apiKey) headers.Authorization = `apikey ${apiKey}`;

  let res;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    const e = new Error(`Netdisco unreachable: ${err.message}`);
    e.statusCode = 502;
    throw e;
  }

  if (res.status === 401 && apiKey) {
    // Stale key — log in again, retry once.
    _apiKey = null;
    const fresh = await getApiKey({ force: true }).catch(() => null);
    if (fresh) {
      headers.Authorization = `apikey ${fresh}`;
      res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    }
  }

  if (!res.ok) {
    let body = '';
    try { body = (await res.text()).slice(0, 300); } catch {}
    const e = new Error(`Netdisco ${res.status}: ${body || res.statusText}`);
    e.statusCode = res.status;
    throw e;
  }

  try { return await res.json(); }
  catch { return null; }
}

function safeAsync(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      const status = err.statusCode || 500;
      logger.error(`[netdisco] ${req.method} ${req.originalUrl} — ${err.message}`);
      res.status(status).json({ error: err.message });
    }
  };
}

// ── Health probe — does NOT require auth (so the page can show "down" state)
router.get('/api/netdisco/health', safeAsync(async (req, res) => {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(NETDISCO_URL, { signal: ctrl.signal });
    clearTimeout(t);
    const apiKey = await getApiKey().catch(() => null);
    res.json({
      ok: r.ok || r.status < 500,
      url: NETDISCO_URL,
      authenticated: !!apiKey,
      status: r.status,
    });
  } catch (err) {
    res.json({ ok: false, url: NETDISCO_URL, authenticated: false, error: err.message });
  }
}));

// All routes below this line require app auth.
router.use('/api/netdisco', auth.requireAuth);

// ── List all devices ─────────────────────────────────────────────────────
//   Behaviour mirrors netdisco.py::list_all_devices — q=% returns everything.
router.get('/api/netdisco/devices', safeAsync(async (req, res) => {
  const q = (req.query.q || '%').toString();
  const data = await ndGet(`/api/v1/search/device?q=${encodeURIComponent(q)}`);
  const arr = Array.isArray(data) ? data : (data?.results || []);
  // Trim to fields the UI needs — keeps payload small.
  const devices = arr.map(d => ({
    ip:        d.ip || null,
    name:      d.dns || d.name || null,
    model:     d.model || null,
    vendor:    d.vendor || null,
    os:        d.os || null,
    os_ver:    d.os_ver || null,
    location:  d.location || null,
    contact:   d.contact || null,
    serial:    d.serial || null,
    uptime:    d.uptime || null,
    last_discover: d.last_discover || null,
  }));
  res.json({ count: devices.length, devices });
}));

// ── One device's details ─────────────────────────────────────────────────
router.get('/api/netdisco/devices/:ip', safeAsync(async (req, res) => {
  const { ip } = req.params;
  const data = await ndGet(`/api/v1/object/device/${encodeURIComponent(ip)}`);
  res.json({ device: data || null });
}));

// ── Ports for a device, with neighbors + active-MAC counts ───────────────
//   Each port object Netdisco returns already has remote_id/remote_ip/
//   remote_port populated, so we don't need a separate /neighbors call —
//   that endpoint actually returns a graph-viz blob (data.nodes/links),
//   not a per-port array, and earlier code mis-parsed it as an array.
//
//   /nodes (active MAC sightings) is fetched separately and joined by port.
//   It legitimately may return [] for synthesised RackTrack devices.
router.get('/api/netdisco/devices/:ip/ports', safeAsync(async (req, res) => {
  const { ip } = req.params;
  const ipEnc = encodeURIComponent(ip);

  // Pull the device list alongside so we can resolve remote_id (chassis
  // MAC) to a friendly device name. Netdisco's /ports response doesn't
  // include remote_dns for synthesised devices.
  const [portsResp, nodesResp, deviceListResp] = await Promise.all([
    ndGet(`/api/v1/object/device/${ipEnc}/ports`).catch(() => []),
    ndGet(`/api/v1/object/device/${ipEnc}/nodes`).catch(() => []),
    ndGet(`/api/v1/search/device?q=%25`).catch(() => []),
  ]);

  const ports = Array.isArray(portsResp) ? portsResp : [];
  const nodes = Array.isArray(nodesResp) ? nodesResp : [];
  const allDevs = Array.isArray(deviceListResp) ? deviceListResp : (deviceListResp?.results || []);

  // Build chassis_id → friendly name map so we can show "SW-U02" instead
  // of "AA:BB:CC:10:10:02" in the neighbour column.
  const nameByChassis = {};
  const nameByIp = {};
  for (const d of allDevs) {
    const friendly = d.dns || d.name || null;
    if (!friendly) continue;
    if (d.mac)        nameByChassis[String(d.mac).toUpperCase()] = friendly;
    if (d.chassis_id) nameByChassis[String(d.chassis_id).toUpperCase()] = friendly;
    if (d.ip)         nameByIp[d.ip] = friendly;
  }

  // Active-MAC counts per port.
  const macsByPort = {};
  for (const n of nodes) {
    const portKey = n.port || n.name;
    if (!portKey) continue;
    if (!macsByPort[portKey]) macsByPort[portKey] = [];
    macsByPort[portKey].push({
      mac:    n.mac,
      vlan:   n.vlan,
      active: n.active === true || n.active === 't' || n.active === 1,
      time_last: n.time_last,
    });
  }

  const enriched = ports.map(p => {
    const portKey = p.port || p.name;
    const hasNeighbor = !!(p.remote_id || p.remote_ip || p.remote_port);
    // Resolve a friendly device name for the other end of the cable.
    // Order: explicit dns/name from upstream → chassis_id lookup → ip
    // lookup → fall back to whatever raw value we have.
    let remote_device = p.remote_dns || p.remote_name || null;
    if (!remote_device && p.remote_id)
      remote_device = nameByChassis[String(p.remote_id).toUpperCase()] || null;
    if (!remote_device && p.remote_ip)
      remote_device = nameByIp[p.remote_ip] || null;
    if (!remote_device)
      remote_device = p.remote_id || p.remote_ip || null;
    return {
      port:        portKey,
      name:        p.name || portKey,
      descr:       p.descr || p.description || null,
      type:        p.type || null,
      speed:       p.speed || null,
      duplex:      p.duplex || null,
      vlan:        p.vlan || null,
      up_admin:    p.up_admin || null,
      up:          p.up || null,
      mac:         p.mac || null,
      neighbor:    hasNeighbor ? {
        remote_device,
        remote_port: p.remote_port || null,
        remote_ip:   p.remote_ip || null,
        remote_type: p.remote_type || null,
        protocol:    p.proto || p.protocol || null,
      } : null,
      active_mac_count: (macsByPort[portKey] || []).filter(m => m.active).length,
      learned_macs:     macsByPort[portKey] || [],
    };
  });

  res.json({ count: enriched.length, ports: enriched });
}));

// ── MAC report — sightings (switch + port over time) + IP history ────────
//   Mirrors netdisco.py::report_mac and port_info_mac.py.
router.get('/api/netdisco/mac/:mac', safeAsync(async (req, res) => {
  const macRaw = (req.params.mac || '').trim();
  if (!macRaw) {
    return res.status(400).json({ error: 'mac is required' });
  }
  const macEnc = encodeURIComponent(macRaw);

  const [sightingsResp, ipsResp] = await Promise.all([
    ndGet(`/api/v1/search/node?q=${macEnc}&archive=true&partial=true&stamps=true`).catch(() => []),
    ndGet(`/api/v1/search/nodeip?q=${macEnc}&archive=true&stamps=true`).catch(() => []),
  ]);

  // Some Netdisco builds return bare MAC strings on /search/node — expand
  // each with an /object/node fetch. Cap expansion to keep latency bounded.
  let sightings = Array.isArray(sightingsResp) ? sightingsResp : (sightingsResp?.results || []);
  if (sightings.length && typeof sightings[0] === 'string') {
    const limited = sightings.slice(0, 8);
    const expanded = await Promise.all(limited.map(m =>
      ndGet(`/api/v1/object/node/${encodeURIComponent(m)}?archive=true`).catch(() => null)
    ));
    sightings = expanded.flat().filter(x => x && typeof x === 'object');
  }
  sightings = sightings.filter(s => s && typeof s === 'object');

  let ips = Array.isArray(ipsResp) ? ipsResp : (ipsResp?.results || []);
  ips = ips.filter(s => s && typeof s === 'object');

  const sortDesc = (a, b) => String(b.time_last || '').localeCompare(String(a.time_last || ''));
  sightings.sort(sortDesc);
  ips.sort(sortDesc);

  const activeSightings = sightings.filter(s => s.active === true || s.active === 't' || s.active === 1);
  const current = activeSightings[0] || sightings[0] || null;

  res.json({
    mac:         macRaw,
    sighting_count: sightings.length,
    ip_count:    ips.length,
    current:     current ? {
      switch: current.switch || current.device || current.dns || null,
      port:   current.port  || null,
      vlan:   current.vlan  || null,
      time_last: current.time_last || null,
      active: !!activeSightings.length,
    } : null,
    sightings: sightings.map(s => ({
      switch: s.switch || s.device || s.dns || null,
      port:   s.port || null,
      vlan:   s.vlan || s.native || null,
      time_first: s.time_first || null,
      time_last:  s.time_last  || null,
      active:     s.active === true || s.active === 't' || s.active === 1,
    })),
    ips: ips.map(n => ({
      ip:         n.ip || null,
      time_first: n.time_first || null,
      time_last:  n.time_last || null,
      active:     n.active === true || n.active === 't' || n.active === 1,
    })),
  });
}));

// ── Scan-to-Netdisco match ───────────────────────────────────────────────
// Take a RackTrack scan's devices and tell the UI which Netdisco devices
// they correspond to. Uses three strategies, in order:
//   1. mgmt_ip from a servicenow override file (highest confidence)
//   2. ocr_model field on the scan device, fuzzy-matched against Netdisco model
//   3. unmatched — UI shows the device with no Netdisco link and lets the
//      user search Netdisco manually.
router.get('/api/netdisco/scan/:rackId/match', safeAsync(async (req, res) => {
  const { rackId } = req.params;
  const projectRoot = path.resolve(__dirname, '..');
  const rackDir = path.join(projectRoot, 'outputs', rackId);
  const mapPath = path.join(rackDir, 'device_unit_map.json');
  if (!fs.existsSync(mapPath)) {
    return res.status(404).json({ error: `rack ${rackId} not found` });
  }

  const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  const scanDevices = (map.devices || []).filter(d =>
    ['Switch', 'Patch Panel', 'Firewall', 'Gateway', 'Router'].includes(d.class_name)
  );

  // Pull override IPs (if any) so we know which scanned devices have known
  // mgmt IPs. RackTrack stores these under servicenow/overrides/<rackId>.json.
  let overrideIps = {};
  const overridePath = path.join(projectRoot, 'servicenow', 'overrides', `${rackId}.json`);
  if (fs.existsSync(overridePath)) {
    try {
      const override = JSON.parse(fs.readFileSync(overridePath, 'utf8'));
      const sw = override.switches || {};
      for (const [name, attrs] of Object.entries(sw)) {
        if (attrs && attrs.mgmt_ip) overrideIps[name] = attrs.mgmt_ip;
      }
    } catch (_) {}
  }

  // Pull the Netdisco inventory once and index it for matching.
  let ndDevices = [];
  try {
    const nd = await ndGet('/api/v1/search/device?q=%25');
    ndDevices = Array.isArray(nd) ? nd : (nd?.results || []);
  } catch (err) {
    // Surface a clean message — strip the wrapping "Netdisco unreachable:"
    // prefix that ndGet adds, so the client doesn't render it twice.
    const raw = String(err.message || 'connection failed');
    const cleaned = raw.replace(/^netdisco unreachable:\s*/i, '');
    return res.json({
      rackId,
      netdisco_reachable: false,
      error: cleaned,
      matches: [],
    });
  }

  const ndByIp    = {};
  const ndByModel = {};
  for (const d of ndDevices) {
    if (d.ip) ndByIp[d.ip] = d;
    if (d.model) {
      const k = String(d.model).toLowerCase();
      if (!ndByModel[k]) ndByModel[k] = [];
      ndByModel[k].push(d);
    }
  }

  // Index ndByName too so we can match on hostname when IPs aren't in the override.
  // The push script writes the device's CMDB name (SW-U10, PP-U18 …) into Netdisco's
  // `dns` and `name` columns, so a name match is high-confidence.
  const ndByName = {};
  for (const d of ndDevices) {
    if (d.dns)  ndByName[String(d.dns).toLowerCase()]  = d;
    if (d.name && !ndByName[String(d.name).toLowerCase()]) {
      ndByName[String(d.name).toLowerCase()] = d;
    }
  }

  // Pull port-status counts for every Netdisco device we plan to surface.
  // Done in a single batch so the page renders fast — one /ports call per
  // matched device, run in parallel.
  const matchedDevices = [];
  for (const d of scanDevices) {
    // Build the canonical CMDB name like the push script does:
    //   "u06" -> "U06"   (preserve the leading zero so name lookup matches)
    let u = null;
    if (d.units && d.units[0]) {
      const m = String(d.units[0]).match(/(\d+)/);
      if (m) u = `U${m[1].padStart(2, '0')}`;
    }
    const prefix = d.class_name === 'Patch Panel' ? 'PP-'
                : d.class_name === 'Server' ? 'SRV-' : 'SW-';
    const cmdbName = u ? `${prefix}${u}` : null;
    let nd = null;
    if (cmdbName && overrideIps[cmdbName] && ndByIp[overrideIps[cmdbName]]) {
      nd = ndByIp[overrideIps[cmdbName]];
    } else if (cmdbName && ndByName[cmdbName.toLowerCase()]) {
      nd = ndByName[cmdbName.toLowerCase()];
    } else if (d.ocr_model) {
      const target = String(d.ocr_model).toLowerCase();
      for (const [mk, list] of Object.entries(ndByModel)) {
        if (mk.includes(target) || target.includes(mk)) { nd = list[0]; break; }
      }
    }
    matchedDevices.push({ scanDev: d, cmdbName, nd });
  }

  const portStats = await Promise.all(matchedDevices.map(async ({ nd }) => {
    if (!nd?.ip) return null;
    try {
      const ports = await ndGet(`/api/v1/object/device/${encodeURIComponent(nd.ip)}/ports`);
      const arr = Array.isArray(ports) ? ports : [];
      let up = 0, down = 0, connected = 0;
      for (const p of arr) {
        const isUp = p.up === true || p.up === 't' || p.up === 1
                  || (typeof p.up === 'string' && /^(up|true|t|1)$/i.test(p.up));
        if (isUp) up += 1; else down += 1;
        if (p.remote_ip || p.remote_id) connected += 1;
      }
      return { total: arr.length, up, down, connected };
    } catch {
      return null;
    }
  }));

  const matches = matchedDevices.map(({ scanDev: d, cmdbName, nd }, i) => ({
    scan: {
      index:      d.index,
      class_name: d.class_name,
      units:      d.units,
      cmdb_name:  cmdbName,
      port_count: d.port_count || 0,
      connected_count: Array.isArray(d.connected_ports) ? d.connected_ports.length : (d.connected_ports || 0),
    },
    netdisco: nd ? {
      ip:     nd.ip || null,
      name:   nd.dns || nd.name || null,
      model:  nd.model || null,
      vendor: nd.vendor || null,
      os:     nd.os || null,
      stats:  portStats[i],
    } : null,
  }));

  res.json({
    rackId,
    netdisco_reachable:    true,
    netdisco_device_count: ndDevices.length,
    scan_device_count:     scanDevices.length,
    matched_count:         matches.filter(m => m.netdisco).length,
    matches,
  });
}));

// ── Push a RackTrack scan into Netdisco's Postgres ─────────────────────
// Wraps netdisco-docker/push_rack_to_netdisco.py. Used both by the manual
// "Sync to Netdisco" button on NetdiscoPage and by the auto-fire helper
// below (which app.js calls after every successful scan).
function runPushScript(rackId) {
  return new Promise((resolve) => {
    if (!fs.existsSync(PUSH_SCRIPT)) {
      return resolve({ ok: false, error: `push script not found at ${PUSH_SCRIPT}` });
    }
    const env = {
      ...process.env,
      NETDISCO_DB_HOST: process.env.NETDISCO_DB_HOST || 'localhost',
      NETDISCO_DB_PORT: process.env.NETDISCO_DB_PORT || '5432',
      NETDISCO_DB_NAME: process.env.NETDISCO_DB_NAME || 'netdisco',
      NETDISCO_DB_USER: process.env.NETDISCO_DB_USER || 'netdisco',
      NETDISCO_DB_PASS: process.env.NETDISCO_DB_PASS || 'netdisco',
      PYTHONIOENCODING: 'utf-8',
    };
    const child = spawn(PYTHON_CMD, [PUSH_SCRIPT, '--rack-id', rackId, '--json'], {
      cwd: PROJECT_ROOT,
      env,
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      resolve({ ok: false, error: 'push script timed out (60s)' });
    }, 60_000);
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('close', () => {
      clearTimeout(timer);
      const lastLine = stdout.trim().split('\n').filter(Boolean).pop() || '';
      let parsed = null;
      try { parsed = JSON.parse(lastLine); } catch (_) {}
      if (parsed && typeof parsed === 'object') {
        return resolve(parsed);
      }
      resolve({
        ok: false,
        error: stderr.trim().slice(-500) || stdout.trim().slice(-500) || 'unknown push failure',
      });
    });
  });
}

// Background scheduler — best-effort, non-blocking. app.js calls this from
// the post-scan flow so a Netdisco refresh happens transparently after every
// scan, the same way scheduleTopologyRegen keeps the 3D view in sync.
const _pushSchedule = new Map();   // rackId → setTimeout handle (debounce)
function scheduleNetdiscoSync(rackId, delayMs = 1500) {
  if (!rackId) return;
  if (_pushSchedule.has(rackId)) clearTimeout(_pushSchedule.get(rackId));
  _pushSchedule.set(rackId, setTimeout(async () => {
    _pushSchedule.delete(rackId);
    try {
      const r = await runPushScript(rackId);
      if (r.ok) {
        logger.info(`[netdisco] ${rackId} synced — ${r.devices} devices, ${r.ports} ports, ${r.edges} edges`);
      } else {
        logger.warn(`[netdisco] ${rackId} sync failed — ${r.error}`);
      }
    } catch (err) {
      logger.warn(`[netdisco] ${rackId} sync threw — ${err.message}`);
    }
  }, delayMs));
}

router.post('/api/netdisco/sync/:rackId', safeAsync(async (req, res) => {
  const { rackId } = req.params;
  const r = await runPushScript(rackId);
  if (!r.ok) {
    logger.warn(`[netdisco] sync ${rackId} failed:`, r.error);
    return res.status(502).json({ ok: false, error: 'Network View sync is temporarily unavailable.' });
  }
  res.json(r);
}));

// Expose the scheduler so server/app.js can call it from the post-scan flow.
router.scheduleNetdiscoSync = scheduleNetdiscoSync;

module.exports = router;

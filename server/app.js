const path     = require('path');
const fs       = require('fs');

// Load server/.env into process.env so SMTP_* (and anything else downstream
// modules read at require-time) is populated before the first require runs.
// Minimal parser: KEY=VALUE per line, # comments, no quoting or substitution.
(function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const eq = s.indexOf('=');
    if (eq < 1) continue;
    const key = s.slice(0, eq).trim();
    if (key in process.env) continue; // real env wins
    process.env[key] = s.slice(eq + 1).trim();
  }
})();

const express  = require('express');
const cors     = require('cors');
const multer   = require('multer');
const crypto   = require('crypto');
const sharp    = require('sharp');
const { v4: uuidv4 } = require('uuid');
const { WorkerPool } = require('./worker-pool');
const auth = require('./auth');
const audit = require('./audit');
const tenant = require('./lib/tenant');
const rackGroups = require('./lib/rack_groups');
const { appendLineWithRotation } = require('./lib/jsonl_rotation');
const orphanGC = require('./lib/orphan_gc');
const jwt = require('jsonwebtoken');
const sshCreds = require('./lib/ssh-creds');
// Central observability — must be required before anything that wants to
// log structured events. Provides logger + metrics + middleware + helpers.
const o11y = require('./lib/observability');
const { logger, withSpan, recordEvent } = o11y;

// Merge stored env credentials (per vendor) into request body fields. Values
// sent explicitly by the client take precedence over the env-stored defaults.
function resolveSwitchCreds(body) {
  const v = sshCreds.getForVendor(body.vendor || 'cisco-ios') || {};
  const clientEnable = body.enablePassword;
  return {
    username:       body.username || v.username || '',
    password:       body.password || v.password || '',
    enablePassword: (clientEnable != null && clientEnable !== '')
      ? clientEnable
      : (v.enablePassword || ''),
  };
}

// Best-effort: extract userId from a Bearer token if present and valid.
// Returns null when no token, an invalid token, or the auth module's secret
// path can't be read. Routes that *require* auth still use auth.requireAuth.
function softAuthUserId(req) {
  return softAuthPayload(req)?.sub || null;
}

// Same as above but returns the whole JWT payload (so callers can also
// read tenantId for tenant-scoped reads on otherwise public routes).
function softAuthPayload(req) {
  const header = req.headers.authorization || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  try {
    const secretPath = path.join(__dirname, 'data', 'jwt.secret');
    if (!fs.existsSync(secretPath)) return null;
    const secret = fs.readFileSync(secretPath, 'utf8').trim();
    return jwt.verify(m[1], secret);
  } catch { return null; }
}

const app  = express();
const PORT = process.env.PORT || 3001;

const PROJECT_ROOT = path.join(__dirname, '..');
const CONFIG_PATH  = path.join(PROJECT_ROOT, 'config.json');
const uploadsDir   = path.join(__dirname, 'uploads');
const outputsDir   = path.join(PROJECT_ROOT, 'outputs');

[uploadsDir, outputsDir].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// Windows sometimes keeps a lingering handle on files sharp just wrote,
// causing transient EPERM on unlink. Retry briefly, then give up — a
// leftover tmp file is harmless.
function safeUnlink(p) {
  if (!p || !fs.existsSync(p)) return;
  for (let i = 0; i < 5; i++) {
    try { fs.unlinkSync(p); return; }
    catch (err) {
      if (err.code !== 'EPERM' && err.code !== 'EBUSY') return;
      // tight synchronous retry — usually clears within ~50ms
      const until = Date.now() + 50;
      while (Date.now() < until) {}
    }
  }
}

// ── Tenant guard for any route that takes :rackId ────────────────────
// Express's `app.param` callback fires whenever a route definition has
// `:rackId` in its path, just before the handler runs. This means EVERY
// scan/topology/ocr/share endpoint that takes a rackId is automatically
// gated by tenant ownership — no per-route wiring needed.
//
// Behavior:
//   * Authenticated request whose tenant doesn't own this rack → 404
//     (404 not 403 — don't reveal that the rack exists in another tenant)
//   * Unauthenticated request → falls through (preserves legacy
//     dev/test access; the routes themselves can require auth if they want)
app.param('rackId', (req, res, next, rackId) => {
  const auth = softAuthPayload(req);
  if (!auth?.tenantId) return next();
  if (!tenant.tenantOwnsRack(auth.tenantId, rackId)) {
    logger.warn({
      event: 'tenant.access_denied',
      tenantId: auth.tenantId, rackId, route: req.path,
    }, `tenant ${auth.tenantId} blocked from rack ${rackId}`);
    return res.status(404).json({ error: 'Rack not found' });
  }
  next();
});

// ── Observability middleware (must be installed before any routes) ───
// Order matters: requestId first (so other middleware can read req.id) →
// httpLogger (logs each request, inherits requestId) → httpMetrics
// (records duration histogram) → cors/json/static → routes.
app.use(o11y.requestId);
app.use(o11y.httpLogger);
app.use(o11y.httpMetrics);

app.use(cors({ origin: true }));
app.use(express.json());
app.use('/uploads', express.static(uploadsDir));
app.use('/outputs', express.static(outputsDir));

// Health + metrics — placed early so they bypass auth/static/etc and
// stay reachable even if the main app is degraded.
app.get('/healthz', o11y.healthHandler);
app.get('/metrics', o11y.metricsHandler);

// Netdisco integration — read-only proxy onto the local Netdisco docker
// stack so the UI can join scan output with live-network truth (LLDP
// neighbours, learned MACs, etc). All routes under /api/netdisco/*.
try {
  app.use(require('./netdisco_proxy'));
  logger.info({ event: 'proxy.loaded', proxy: 'netdisco' }, 'netdisco proxy loaded');
} catch (err) {
  logger.warn({ event: 'proxy.load_failed', proxy: 'netdisco', err: err.message },
    'netdisco proxy not loaded');
}

// CMDB-ticket integration — every CMDB write is gated behind an SR
// (sc_request) approval. Routes under /api/cmdb/ticket/*; the poller
// runs every 5 min.
let _cmdbTicketProxy = null;
try {
  _cmdbTicketProxy = require('./cmdb_ticket_proxy');
  app.use(_cmdbTicketProxy);
  if (typeof _cmdbTicketProxy.startTicketPoller === 'function') {
    _cmdbTicketProxy.startTicketPoller();
    logger.info({ event: 'poller.started', name: 'cmdb-ticket' },
      'cmdb-ticket poller started');
  }
  logger.info({ event: 'proxy.loaded', proxy: 'cmdb-ticket' }, 'cmdb-ticket proxy loaded');
} catch (err) {
  logger.warn({ event: 'proxy.load_failed', proxy: 'cmdb-ticket', err: err.message },
    'cmdb-ticket proxy not loaded');
}

const clientDist = path.join(PROJECT_ROOT, 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
}

// ── File upload ───────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename:    (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `tmp_${uuidv4()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 340 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(jpe?g|png|gif|heic|heif|mp4|mov|webm)$/i.test(file.originalname);
    cb(ok ? null : new Error('Invalid file type'), ok);
  },
});

// ── Image normalization ───────────────────────────────────────
// Converts HEIC/HEIF to JPEG and applies EXIF rotation so downstream
// code (cv2, pipeline) always sees an upright standard JPEG.
async function normalizeImage(inputPath) {
  const ext = path.extname(inputPath).toLowerCase();
  const isVideo = /\.(mp4|mov|webm)$/i.test(ext);
  if (isVideo) {
    // Hand the video to the Python worker, which scores frames and writes
    // the best one to disk. From here on the rest of the pipeline treats
    // it as a normal photo upload.
    const outputPath = inputPath.replace(/\.[^.]+$/, '') + '_frame.jpg';
    const res = await pool.request('extract_best_frame', {
      video_path: inputPath,
      output_path: outputPath,
    });
    if (!res.ok) {
      safeUnlink(inputPath);
      throw new Error(res.error || 'Could not extract a frame from the video.');
    }
    safeUnlink(inputPath);
    return outputPath;
  }

  const outputPath = inputPath.replace(/\.[^.]+$/, '') + '_norm.jpg';
  await sharp(inputPath)
    .rotate()             // auto-orient from EXIF, strips the tag
    .jpeg({ quality: 92, mozjpeg: true })
    .toFile(outputPath);
  safeUnlink(inputPath);
  return outputPath;
}

// ── Rack ID ───────────────────────────────────────────────────
// Derived from SHA-256 of file contents → stable for the same physical rack image
function computeRackId(filePath) {
  const hash = crypto
    .createHash('sha256')
    .update(fs.readFileSync(filePath))
    .digest('hex');
  return `RK-${hash.slice(0, 8).toUpperCase()}`;
}

// ── Persistent Python worker pool ─────────────────────────────
const pythonCmd = process.env.PYTHON_PATH || (process.platform === 'win32' ? 'py' : 'python3');
const WORKER_COUNT = Math.max(1, parseInt(process.env.RACKTRACK_WORKERS, 10) || 1);

const pool = new WorkerPool({
  size: WORKER_COUNT,
  pythonCmd,
  pythonArgs: ['-u', '-m', 'pipeline.worker'],
  cwd: PROJECT_ROOT,
  env: { ...process.env, PYTHONUNBUFFERED: '1', YOLO_VERBOSE: 'False' },
});

async function runQualityCheck(imagePath) {
  return withSpan('pipeline.quality_check', async (log) => {
    try {
      return await pool.request('quality_check', { image_path: imagePath });
    } catch (err) {
      log.warn({ err: err.message }, 'quality_check skipped');
      return { ok: true, metrics: { note: 'check-failed-skipped' } };
    }
  }, { imagePath });
}

async function runPipelineAnalyze(imagePath, outputDir) {
  return withSpan('pipeline.analyze', async () => {
    const res = await pool.request('analyze', {
      image_path: imagePath,
      config_path: CONFIG_PATH,
      output_dir:  outputDir,
    });
    if (!res.ok) throw new Error(res.error || 'pipeline analyze failed');
    return res;
  }, { imagePath, outputDir });
}

async function runPipelineSelect(imagePath, outputDir, deviceIndex, port) {
  return withSpan('pipeline.select', async () => {
    const res = await pool.request('select', {
      image_path:   imagePath,
      config_path:  CONFIG_PATH,
      output_dir:   outputDir,
      device_index: deviceIndex,
      port,
    });
    if (!res.ok) throw new Error(res.error || 'pipeline select failed');
    return res;
  }, { imagePath, outputDir, deviceIndex, port });
}

// Re-detect ports for one device using a user-supplied target count.
// Updates device_unit_map.json and returns the patched device.
async function runRelabelPortCount(rackDir, deviceIndex, targetCount) {
  return await pool.request('relabel_port_count', {
    rack_dir:     rackDir,
    device_index: deviceIndex,
    target_count: targetCount,
    config_path:  CONFIG_PATH,
  });
}

// ── Helpers ───────────────────────────────────────────────────
function readMeta(rackId) {
  const p = path.join(outputsDir, rackId, 'scan_meta.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

function writeMeta(rackId, meta) {
  const dir = path.join(outputsDir, rackId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'scan_meta.json'), JSON.stringify(meta, null, 2));
}

async function ensurePortCounts(rackId) {
  const rackDir = path.join(outputsDir, rackId);
  const meta = readMeta(rackId);
  if (!meta?.imagePath) return;

  const jsonPath = path.join(rackDir, 'device_unit_map.json');
  if (!fs.existsSync(jsonPath)) return;

  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  if (!Array.isArray(data.devices)) return;
  if (data.devices.every(dev => typeof dev.port_count === 'number')) return;

  await runPipelineAnalyze(meta.imagePath, rackDir);
}

function buildResponse(rackId, cached) {
  const rackDir  = path.join(outputsDir, rackId);
  const jsonPath = path.join(rackDir, 'device_unit_map.json');
  const data     = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const meta     = readMeta(rackId);
  // Prefer 2_devices_only.png; fall back to the combined render if it's missing.
  const imageFile = fs.existsSync(rackImagePath(rackDir, '2_devices_only.png'))
    ? rackImageUrlPath(rackDir, '2_devices_only.png')
    : rackImageUrlPath(rackDir, '3_units_and_devices.png');
  const devices = (data.devices || []).map(dev => ({
    ...dev,
    port_count: typeof dev.port_count === 'number' ? dev.port_count : null,
    ports: dev.ports || [],
    console_ports: dev.console_ports || [],
    sfp_ports: dev.sfp_ports || [],
    connected_ports: dev.connected_ports || [],
  }));

  // Detect original image extension
  let originalExt = 'png';
  for (const ext of ['jpg', 'jpeg', 'png']) {
    if (fs.existsSync(path.join(rackDir, `original_image.${ext}`))) {
      originalExt = ext;
      break;
    }
  }

  return {
    rackId,
    scanId:          rackId,               // kept for backwards compat
    timestamp:       meta?.timestamp || new Date().toISOString(),
    cached,
    imageUrl:        `/outputs/${rackId}/${imageFile}`,
    originalExt,
    devices,
    units_detected:  data.units_detected || [],
    qualityWarning:    meta?.qualityWarning || null,
    qualityWarningMsg: meta?.qualityWarningMsg || null,
  };
}

// ── Report generation ─────────────────────────────────────────
// Single source of truth:
//   buildScanReportData(rackId)  → pure structured object (canonical content)
//   renderHTMLReport(data, ...)  → standalone HTML (the file saved to disk)
//   renderJSONReport(data)       → JSON string
//   renderCSVReport(data)        → CSV string (Excel-friendly)
// HTML is self-contained: CSS + images inline as base64, so the file is
// shareable as a single attachment (Slack, email, disk).
const CLASS_CODE_SRV = {
  'Switch': 'SW', 'Patch Panel': 'PP', 'Firewall': 'FW', 'Router': 'RO',
  'Server': 'SVR', 'Load Balancer': 'LB', 'Modem': 'MO',
  'Controller': 'CTRL', 'Recorder': 'REC', 'Amplifier': 'AMP', 'Gateway': 'GT',
  'PDU': 'PDU', 'PSU': 'PSU', 'UPS': 'UPS', 'Empty': 'EMP', 'Closed Unit': 'CL',
};

function formatUnitsRangeSrv(units = []) {
  const nums = [...new Set((units || [])
    .map(u => { const m = String(u).match(/\d+/); return m ? Number(m[0]) : null; })
    .filter(n => n !== null))].sort((a, b) => a - b);
  if (!nums.length) return '';
  const ranges = [];
  let start = nums[0], prev = nums[0];
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] === prev + 1) { prev = nums[i]; continue; }
    ranges.push([start, prev]); start = nums[i]; prev = nums[i];
  }
  ranges.push([start, prev]);
  return ranges.map(([s, e]) =>
    s === e ? `U${String(s).padStart(2, '0')}`
            : `U${String(s).padStart(2, '0')}-U${String(e).padStart(2, '0')}`
  ).join(' ');
}

function buildScanReportData(rackId) {
  const rackDir = path.join(outputsDir, rackId);
  const meta    = readMeta(rackId);
  if (!meta) throw new Error(`Scan ${rackId} not found`);

  const mapPath = path.join(rackDir, 'device_unit_map.json');
  const mapData = fs.existsSync(mapPath) ? JSON.parse(fs.readFileSync(mapPath, 'utf8')) : {};
  const rawDevices = mapData.devices || [];
  const unitsDetected = mapData.units_detected || [];

  const counts = {};
  const devices = rawDevices.map((dev, i) => {
    const code = CLASS_CODE_SRV[dev.class_name] || (dev.class_name || 'UNK').replace(/\s+/g, '').slice(0, 4).toUpperCase();
    counts[code] = (counts[code] || 0) + 1;
    const seq = String(counts[code]).padStart(2, '0');
    const labelUnits = dev.units?.length ? dev.units : unitsDetected.length ? [unitsDetected[0]] : [];
    const unitRange = formatUnitsRangeSrv(labelUnits) || 'U01';
    const label = `${unitRange.split(' ')[0]}-${code}${seq}`;
    return {
      index: i + 1,
      label,
      class_name: dev.class_name || 'Unknown',
      position: unitRange,
      port_count: dev.port_count || 0,
      console_ports: dev.console_ports?.length || 0,
      sfp_ports: dev.sfp_ports?.length || 0,
      connected_ports: dev.connected_ports?.length || 0,
    };
  });

  // Latest port identification only — walk newest-first and take the first valid line
  const idsPath = path.join(rackDir, 'port_identifications.jsonl');
  const portIdentifications = [];
  if (fs.existsSync(idsPath)) {
    const raw = fs.readFileSync(idsPath, 'utf8').split('\n').filter(Boolean);
    for (let i = raw.length - 1; i >= 0; i--) {
      try {
        portIdentifications.push(JSON.parse(raw[i]));
        break;
      } catch { /* skip malformed line */ }
    }
  }

  const fbPath = path.join(rackDir, 'feedback.jsonl');
  let feedbackEntries = [];
  if (fs.existsSync(fbPath)) {
    feedbackEntries = fs.readFileSync(fbPath, 'utf8')
      .split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  }
  const fbCorrect = feedbackEntries.filter(e => e.is_correct).length;

  // Candidate report images, resolved through rackImageUrlPath so that we
  // pick up either the new images/ subfolder or the legacy flat layout.
  const candidateImages = [
    '3_units_and_devices.png',
    '7_rack_all_ports.png',
    '5_selected_device_with_port.png',
    '6_full_rack_selected_port.png',
  ];
  const images = candidateImages
    .filter(f => fs.existsSync(rackImagePath(rackDir, f)))
    .map(f => rackImageUrlPath(rackDir, f));

  return {
    rackId,
    timestamp: meta.timestamp || null,
    quality_note: meta.quality?.note || null,
    units_detected: unitsDetected,
    units_range: formatUnitsRangeSrv(unitsDetected),
    devices,
    port_identifications: portIdentifications.map(e => {
      const p = e.port_info || {};
      const dev = devices[e.device_index - 1];
      const console_transcript = readConsoleTranscript(rackDir, e.device_index, e.port);
      return {
        timestamp: e.timestamp,
        device_index: e.device_index,
        device_label: dev?.label || null,
        device_class: dev?.class_name || null,
        device_position: dev?.position || null,
        port: e.port,
        status: p.status || null,
        cable_color: p.cable_color || null,
        cable_connector: p.cable_connector || null,
        cable_type: p.cable_type || null,
        device_image: e.device_image || null,
        full_rack_image: e.full_rack_image || null,
        console: console_transcript ? {
          host: console_transcript.host,
          interface: console_transcript.interface,
          updated_at: console_transcript.updated_at,
          entries: console_transcript.entries || [],
        } : null,
      };
    }),
    feedback: {
      total: feedbackEntries.length,
      correct: fbCorrect,
      wrong: feedbackEntries.length - fbCorrect,
      accuracy: feedbackEntries.length ? fbCorrect / feedbackEntries.length : null,
      entries: feedbackEntries,
    },
    images, // relative filenames under outputs/<rackId>/
    _rackDir: rackDir, // internal: used by renderers, not exported in JSON
  };
}

function htmlEscape(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function imageToDataUri(absPath) {
  try {
    const buf = fs.readFileSync(absPath);
    const ext = path.extname(absPath).toLowerCase().slice(1);
    const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch { return null; }
}

const TYPE_ACCENT = {
  'Switch': '#22d3ee', 'Patch Panel': '#60a5fa', 'Server': '#a78bfa',
  'Gateway': '#fb923c', 'Firewall': '#f87171', 'PDU': '#fbbf24',
  'PSU': '#f472b6', 'UPS': '#34d399', 'Router': '#818cf8',
  'Load Balancer': '#c084fc', 'Modem': '#94a3b8',
  'Controller': '#67e8f9', 'Recorder': '#86efac', 'Amplifier': '#fda4af',
  'Closed Unit': '#f43f5e', 'Empty': '#64748b',
};
const TYPE_DEFAULT_ACCENT = '#22d3ee';
const accentFor = (cls) => TYPE_ACCENT[cls] || TYPE_DEFAULT_ACCENT;

function formatTimestamp(ts) {
  if (!ts) return 'unknown time';
  try {
    const d = new Date(ts);
    return d.toLocaleString('en-US', {
      year: 'numeric', month: 'short', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
  } catch { return ts; }
}

function renderHTMLReport(data, { inlineImages = true } = {}) {
  const d = data;
  const srcFor = (fname) => {
    if (!fname) return null;
    // Resolve through the helper so old (flat) and new (subfolder) layouts both work
    const abs = resolveRelativeArtifact(d._rackDir, fname);
    return inlineImages ? imageToDataUri(abs) : fname;
  };

  const portIdsHtml = d.port_identifications.map(p => {
    const a = accentFor(p.device_class || '');
    const devSrc  = srcFor(p.device_image);
    const fullSrc = srcFor(p.full_rack_image);
    const imgs = [fullSrc, devSrc].filter(Boolean)
      .map(src => `<div class="portImg"><img src="${src}" alt=""/></div>`).join('');

    let consoleHtml = '';
    if (p.console && Array.isArray(p.console.entries) && p.console.entries.length) {
      const entryBlocks = p.console.entries.map(e => `
  <article class="cmdBlock">
    <header class="cmdHeader">
      <span class="cmdName">${htmlEscape(e.name || 'Command')}</span>
      <code class="cmdLine">${htmlEscape(e.cmd)}</code>
    </header>
    ${e.error
      ? `<pre class="cmdErr">${htmlEscape(e.error)}</pre>`
      : `<pre class="cmdOut">${htmlEscape(e.output || '(no output)')}</pre>`}
  </article>`).join('');
      consoleHtml = `
  <div class="consoleWrap">
    <div class="consoleHead">
      <span class="consoleKey">Console · ${htmlEscape(p.console.host || '—')}${p.console.interface ? ` · ${htmlEscape(p.console.interface)}` : ''}</span>
    </div>
    ${entryBlocks}
  </div>`;
    }

    return `
<section class="portCard" style="--accent:${a}">
  <div class="portCardHead">
    <div class="portBadge" style="background:${a};box-shadow:0 0 14px ${a}90">Port ${htmlEscape(p.port)}</div>
    <div class="portCardTitle">
      <div class="portDevice">${htmlEscape(p.device_label || `Device ${p.device_index}`)}</div>
      <div class="portDeviceSub">${htmlEscape(p.device_class || '')}${p.device_position ? ` · ${htmlEscape(p.device_position)}` : ''}</div>
    </div>
  </div>
  ${imgs ? `<div class="portImgs">${imgs}</div>` : ''}
  ${consoleHtml}
</section>`;
  }).join('\n');

  const ts = formatTimestamp(d.timestamp);

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Rack Scan Report — ${htmlEscape(d.rackId)}</title>
<style>
  /* Light theme — clean, attractive, looks the same on screen and in PDF */
  :root {
    --bg:#f6f8fc; --bg2:#eef2fa;
    --card:#ffffff;
    --fg:#0f172a; --muted:#64748b; --softMuted:#94a3b8;
    --accent:#0891b2; --accent2:#4f46e5; --accent3:#7c3aed;
    --border:#e2e8f0; --borderSoft:#eef2f7;
    --shadow:0 1px 2px rgba(15,23,42,0.04), 0 8px 24px rgba(15,23,42,0.06);
    --shadowSm:0 1px 2px rgba(15,23,42,0.05);
  }
  *{box-sizing:border-box}
  html,body{margin:0;padding:0}
  body{
    background:
      radial-gradient(900px 360px at 0% 0%, rgba(8,145,178,0.07), transparent 70%),
      radial-gradient(900px 360px at 100% 0%, rgba(124,58,237,0.06), transparent 70%),
      linear-gradient(180deg, var(--bg) 0%, var(--bg2) 100%);
    color:var(--fg);
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    line-height:1.5; min-height:100vh;
  }
  .wrap{max-width:1080px;margin:0 auto;padding:24px 22px 48px}

  /* ── Hero ── */
  .hero{
    position:relative;
    padding:30px 30px 26px;
    border-radius:20px;
    color:#fff;
    background:linear-gradient(135deg, #0891b2 0%, #4f46e5 55%, #7c3aed 100%);
    box-shadow:0 12px 32px rgba(79,70,229,0.22), 0 2px 6px rgba(15,23,42,0.08);
    overflow:hidden;
  }
  .hero::before{
    content:'';position:absolute;inset:0;pointer-events:none;
    background:
      radial-gradient(420px 180px at 90% -10%, rgba(255,255,255,0.22), transparent 70%),
      radial-gradient(280px 120px at 10% 110%, rgba(255,255,255,0.12), transparent 70%);
  }
  .heroEyebrow{
    display:inline-flex;align-items:center;gap:8px;
    font-size:.7rem;font-weight:800;letter-spacing:.18em;text-transform:uppercase;
    color:#fff;
    padding:5px 12px;border-radius:999px;
    background:rgba(255,255,255,0.18);border:1px solid rgba(255,255,255,0.35);
    backdrop-filter:blur(4px);
  }
  .heroEyebrow::before{content:'';width:6px;height:6px;border-radius:50%;background:#a7f3d0;box-shadow:0 0 10px #a7f3d0}
  h1{
    font-size:2.1rem;margin:14px 0 6px;letter-spacing:-0.025em;
    color:#fff;font-weight:800;
    text-shadow:0 2px 8px rgba(0,0,0,0.18);
  }
  .heroMeta{display:flex;flex-wrap:wrap;gap:14px;color:rgba(255,255,255,0.88);font-size:.88rem}
  .heroMeta .k{color:rgba(255,255,255,0.65);margin-right:4px}
  .heroMeta code{
    font-family:'SF Mono',Menlo,Consolas,monospace;
    background:rgba(255,255,255,0.18);padding:3px 9px;border-radius:6px;
    color:#fff;border:1px solid rgba(255,255,255,0.28);
  }

  /* ── Stat cards ── */
  .stats{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:18px 0 8px}
  .stat{
    position:relative;
    padding:16px 18px;border-radius:14px;
    background:var(--card);
    border:1px solid var(--border);
    box-shadow:var(--shadow);
    overflow:hidden;
  }
  .stat::before{
    content:'';position:absolute;left:0;top:0;bottom:0;width:3px;
    background:linear-gradient(180deg, var(--accent), var(--accent2));
  }
  .stat .k{font-size:.66rem;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
  .stat .v{
    font-size:2rem;font-weight:800;margin-top:4px;letter-spacing:-0.02em;
    color:transparent;
    background:linear-gradient(135deg, var(--accent), var(--accent2));
    -webkit-background-clip:text;background-clip:text;
  }

  /* ── Section heading ── */
  .section{margin-top:32px}
  .sectionTitle{
    display:flex;align-items:center;gap:10px;margin:0 0 14px;
    font-size:.78rem;font-weight:800;letter-spacing:.16em;
    text-transform:uppercase;color:var(--muted);
  }
  .sectionTitle::before{content:'';width:22px;height:2px;border-radius:2px;background:linear-gradient(90deg, var(--accent), var(--accent2))}
  .sectionTitle::after{content:'';flex:1;height:1px;background:linear-gradient(90deg, var(--border), transparent)}

  /* ── Port identification cards ── */
  .portCard{
    position:relative;margin-top:14px;
    padding:18px 20px 20px;border-radius:16px;
    background:var(--card);
    border:1px solid var(--border);
    box-shadow:var(--shadow);
    overflow:hidden;
  }
  .portCard::before{
    content:'';position:absolute;left:0;top:0;bottom:0;width:4px;
    background:linear-gradient(180deg, var(--accent), var(--accent2));
  }
  .portCardHead{display:flex;align-items:center;gap:14px;margin-bottom:14px}
  .portBadge{
    display:inline-flex;align-items:center;justify-content:center;
    padding:8px 14px;border-radius:10px;
    font-family:'SF Mono',Menlo,Consolas,monospace;
    font-size:.85rem;font-weight:800;color:#fff;letter-spacing:.02em;
    box-shadow:0 4px 12px rgba(0,0,0,0.15);
    flex-shrink:0;
  }
  .portCardTitle{display:flex;flex-direction:column;gap:2px;min-width:0}
  .portDevice{font-size:1.05rem;font-weight:800;color:var(--fg);letter-spacing:-0.01em}
  .portDeviceSub{font-size:.78rem;color:var(--muted);font-weight:500}
  .portImgs{
    display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px;
  }
  .portImg{
    border-radius:12px;overflow:hidden;
    border:1px solid var(--border);
    background:#f8fafc;
    box-shadow:var(--shadowSm);
  }
  .portImg img{width:100%;display:block}

  .empty{
    color:var(--muted);font-style:italic;padding:24px;text-align:center;
    background:var(--card);border:1px dashed var(--border);border-radius:12px;
  }

  /* ── Console transcript inside port card ── */
  .consoleWrap{margin-top:14px;padding-top:12px;border-top:1px dashed var(--border)}
  .consoleHead{margin-bottom:8px}
  .consoleKey{font-size:.68rem;font-weight:800;letter-spacing:.16em;text-transform:uppercase;color:var(--accent)}
  .cmdBlock{
    margin-top:10px;background:#f8fafc;border:1px solid var(--border);
    border-radius:10px;overflow:hidden;
  }
  .cmdHeader{
    display:flex;align-items:baseline;gap:10px;padding:8px 12px;
    background:#eef2f7;border-bottom:1px solid var(--border);
  }
  .cmdName{font-size:.66rem;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--accent)}
  .cmdLine{font-family:'SF Mono',Menlo,Consolas,monospace;font-size:.75rem;color:#334155;background:transparent}
  .cmdOut,.cmdErr{
    margin:0;padding:12px 14px;
    font-family:'SF Mono',Menlo,Consolas,monospace;font-size:.78rem;line-height:1.5;
    color:#1e293b;background:transparent;
    white-space:pre-wrap;word-break:break-word;
    max-height:420px;overflow:auto;
  }
  .cmdErr{color:#b91c1c;background:#fef2f2}

  @media (max-width:600px){
    .wrap{padding:18px 14px 40px}
    .hero{padding:22px 20px}
    h1{font-size:1.55rem}
    .stat .v{font-size:1.6rem}
    .portCardHead{flex-wrap:wrap}
  }

  /* ── Sticky top bar (PDF download button) ── */
  .topBar{
    position:sticky; top:0; z-index:20;
    display:flex; align-items:center; justify-content:space-between; gap:10px;
    padding:10px 18px;
    background:rgba(255,255,255,0.92);
    backdrop-filter:blur(16px); -webkit-backdrop-filter:blur(16px);
    border-bottom:1px solid var(--border);
  }
  .topBarTitle{font-size:.78rem;font-weight:700;color:var(--muted);letter-spacing:.04em}
  .pdfBtn{
    display:inline-flex;align-items:center;gap:8px;
    padding:8px 14px;border-radius:10px;
    font-size:.82rem;font-weight:700;
    background:linear-gradient(135deg, var(--accent), var(--accent2));
    color:#fff;border:none;
    box-shadow:0 4px 14px rgba(8,145,178,0.3);
    cursor:pointer; font-family:inherit;
    transition:transform .12s, box-shadow .15s;
  }
  .pdfBtn:hover{transform:translateY(-1px); box-shadow:0 6px 20px rgba(8,145,178,0.4);}
  .pdfBtn svg{width:14px;height:14px}

  /* ── PDF / print niceties ── */
  /* Hide the sticky bar in print and html2pdf snapshots. */
  body.pdfMode .topBar, @media print { .topBar{display:none} }
  body.pdfMode .cmdOut, body.pdfMode .cmdErr,
  @media print { .cmdOut, .cmdErr { max-height:none !important; overflow:visible !important } }
  /* html2canvas can't render -webkit-background-clip:text, so any gradient
     text (h1, .stat .v) needs to fall back to a solid colour. */
  body.pdfMode h1 {
    color:#fff !important;
    -webkit-text-fill-color:#fff !important;
    text-shadow:none !important;
  }
  body.pdfMode .stat .v {
    background:none !important;
    -webkit-background-clip:initial !important;
    background-clip:initial !important;
    -webkit-text-fill-color:initial !important;
    color:#0891b2 !important;
  }
  body.pdfMode .portImg img { max-height:300px; object-fit:contain; }
  /* Allow port cards to split across pages so we never leave huge gaps. */
  body.pdfMode .portCard { break-inside:auto; page-break-inside:auto; }
  @media print {
    .portCard { break-inside:auto; page-break-inside:auto; }
  }
</style>
<script src="https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.2/html2pdf.bundle.min.js"></script>
</head><body>

<div class="topBar">
  <span class="topBarTitle">Rack Scan Report · ${htmlEscape(d.rackId)}</span>
  <button class="pdfBtn" id="pdfBtn" type="button">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
      <polyline points="7 10 12 15 17 10"/>
      <line x1="12" y1="15" x2="12" y2="3"/>
    </svg>
    <span id="pdfBtnLabel">Download PDF</span>
  </button>
</div>

<script>
(function () {
  const btn = document.getElementById('pdfBtn');
  const label = document.getElementById('pdfBtnLabel');
  const filename = 'rack-report-${htmlEscape(d.rackId)}.pdf';

  btn.addEventListener('click', async () => {
    if (typeof html2pdf === 'undefined') {
      // Library failed to load (offline?) — fall back to the print dialog.
      window.print();
      return;
    }
    btn.disabled = true;
    const original = label.textContent;
    label.textContent = 'Generating…';
    document.body.classList.add('pdfMode');
    try {
      await html2pdf().set({
        margin: [8, 8, 10, 8],
        filename,
        image: { type: 'jpeg', quality: 0.92 },
        html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff' },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
        // Let content flow naturally — only honor explicit CSS hints, no
        // global "avoid" that creates half-empty pages.
        pagebreak: { mode: ['css'] },
      }).from(document.querySelector('.wrap')).save();
    } catch (err) {
      logger.error('PDF generation failed:', err);
      window.print(); // last-ditch fallback
    } finally {
      document.body.classList.remove('pdfMode');
      label.textContent = original;
      btn.disabled = false;
    }
  });

  // Auto-trigger PDF download when the report is opened with #download
  // in the URL hash. Lets external callers (e.g. the results page) link
  // straight to a PDF without showing the report first.
  function maybeAutoDownload() {
    if (window.location.hash !== '#download') return;
    const fire = () => btn.click();
    if (typeof html2pdf !== 'undefined') {
      // Slight delay so all images and fonts have a chance to settle
      setTimeout(fire, 250);
    } else {
      window.addEventListener('load', () => setTimeout(fire, 350), { once: true });
    }
  }
  maybeAutoDownload();
})();
</script>

<div class="wrap">

<div class="hero">
  <span class="heroEyebrow">Rack Scan Report</span>
  <h1>${htmlEscape(d.rackId)}</h1>
  <div class="heroMeta">
    <span><span class="k">Scanned:</span> <code>${htmlEscape(ts)}</code></span>
  </div>
</div>

<div class="stats">
  <div class="stat"><div class="k">Units</div><div class="v">${htmlEscape(d.units_range || `${d.units_detected.length}`)}</div></div>
  <div class="stat"><div class="k">Devices</div><div class="v">${d.devices.length}</div></div>
</div>

<div class="section">
  <div class="sectionTitle">Port Identifications</div>
  ${d.port_identifications.length
    ? portIdsHtml
    : `<p class="empty">No ports have been identified yet.</p>`}
</div>

</div></body></html>`;
}

function renderJSONReport(data) {
  const { _rackDir, ...publicData } = data;
  return JSON.stringify(publicData, null, 2);
}

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function renderCSVReport(data) {
  const lines = [];
  lines.push(`# Rack Scan Report,${data.rackId}`);
  lines.push(`# Timestamp,${data.timestamp || ''}`);
  lines.push(`# Units,${data.units_range || ''}`);
  if (data.port_identifications?.length) {
    lines.push('');
    lines.push('## Port Identifications');
    lines.push(['timestamp','device_index','device_label','device_class','device_position','port','status','cable_color','cable_connector','cable_type'].join(','));
    data.port_identifications.forEach(p => {
      lines.push([p.timestamp, p.device_index, p.device_label, p.device_class, p.device_position, p.port, p.status, p.cable_color, p.cable_connector, p.cable_type].map(csvEscape).join(','));
    });

    // Per-port console transcripts. One row per command run, with the
    // raw output collapsed into a single CSV cell.
    const portsWithConsole = data.port_identifications.filter(p =>
      p.console && Array.isArray(p.console.entries) && p.console.entries.length
    );
    if (portsWithConsole.length) {
      lines.push('');
      lines.push('## Port Command Transcripts');
      lines.push(['timestamp','device_index','device_label','port','host','interface','command_name','command','output','error'].join(','));
      portsWithConsole.forEach(p => {
        const host = p.console.host || '';
        const iface = p.console.interface || '';
        p.console.entries.forEach(e => {
          lines.push([
            p.timestamp, p.device_index, p.device_label, p.port,
            host, iface,
            e.name || '', e.cmd || '', e.output || '', e.error || '',
          ].map(csvEscape).join(','));
        });
      });
    }
  }
  if (data.feedback.total > 0) {
    lines.push('');
    lines.push('## Feedback');
    lines.push(`total,correct,wrong,accuracy`);
    lines.push([data.feedback.total, data.feedback.correct, data.feedback.wrong, data.feedback.accuracy].map(csvEscape).join(','));
    lines.push('');
    lines.push('## Feedback Entries');
    lines.push(['timestamp','feedback_type','device_index','device_class','predicted_port','actual_port','predicted_device_class','actual_device_class','predicted_cable_color','actual_cable_color','predicted_port_count','actual_port_count','is_correct','port_status','cable_color','cable_connector'].join(','));
    data.feedback.entries.forEach(e => {
      lines.push([
        e.timestamp, e.feedback_type, e.device_index, e.device_class,
        e.predicted_port, e.actual_port,
        e.predicted_device_class, e.actual_device_class,
        e.predicted_cable_color, e.actual_cable_color,
        e.predicted_port_count, e.actual_port_count,
        e.is_correct, e.port_status, e.cable_color, e.cable_connector,
      ].map(csvEscape).join(','));
    });
  }
  return lines.join('\n');
}

// Generates the canonical HTML file on disk and returns all formats + paths.
function buildScanReport(rackId, { inlineImages = true } = {}) {
  const data = buildScanReportData(rackId);
  const html = renderHTMLReport(data, { inlineImages });
  const reportPath = path.join(data._rackDir, 'report.html');
  fs.writeFileSync(reportPath, html, 'utf8');
  // Keep the canonical scan_result.json in sync whenever a report is built.
  // Failures are swallowed inside writeCanonicalScanResult.
  writeCanonicalScanResult(rackId, data);
  return {
    rackId,
    data,
    html,
    json: renderJSONReport(data),
    csv: renderCSVReport(data),
    reportPath,
  };
}

const SCAN_RESULT_SCHEMA = 'scan_result.v1';

// Writes outputs/<rackId>/scan_result.json — the single canonical merged view
// of one scan: metadata + devices + units + ports + selection + console +
// feedback. Atomic (write tmp → rename) so partial writes can't be observed.
//
// Pass `prebuiltData` when you already have the result of buildScanReportData
// to avoid re-reading the source files; otherwise we build it ourselves.
function writeCanonicalScanResult(rackId, prebuiltData) {
  let outPath;
  try {
    const data = prebuiltData || buildScanReportData(rackId);
    const { _rackDir, ...publicData } = data;

    let selectedPort = null;
    const selPath = path.join(_rackDir, 'selected_port_info.json');
    if (fs.existsSync(selPath)) {
      try { selectedPort = JSON.parse(fs.readFileSync(selPath, 'utf8')); }
      catch (e) { logger.warn(`[scan_result] selected_port_info parse failed for ${rackId}: ${e.message}`); }
    }

    const meta = readMeta(rackId) || {};
    const result = {
      schema: SCAN_RESULT_SCHEMA,
      rackId,
      createdAt: meta.timestamp || null,
      updatedAt: new Date().toISOString(),
      createdBy: meta.userId ? { userId: meta.userId } : null,
      image: {
        imageHash:         meta.imageHash || null,
        originalImagePath: meta.imagePath || null,
        qualityWarning:    meta.qualityWarning || null,
        qualityWarningMsg: meta.qualityWarningMsg || null,
      },
      ...publicData,
      selectedPort,
    };

    // Overlay any user feedback corrections on top of the model's
    // predictions before persisting. Mutates `result` in place; the
    // original predictions are preserved on each modified field's
    // `_correction.original` for audit.
    applyFeedbackOverrides(rackId, result);

    outPath = path.join(_rackDir, 'scan_result.json');
    const tmpPath = outPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(result, null, 2));
    fs.renameSync(tmpPath, outPath);
    // After every canonical write, regen the topology snapshot in the
    // background so the topology view stays in sync with the scan.
    scheduleTopologyRegen(rackId);
    return result;
  } catch (err) {
    logger.error(`[scan_result] write failed for ${rackId}: ${err.message}`);
    return null;
  }
}

// Schedule a canonical-result refresh for after the response is sent. Used by
// mutation endpoints that don't already build the report inline. Also kicks
// off per-device OCR in the background — fully silent, the user never sees
// it; the result lands in outputs/<rackId>/ocr_devices.json and synth.py
// picks it up the next time CMDB is built.
function scheduleCanonicalRefresh(rackId) {
  setImmediate(() => {
    writeCanonicalScanResult(rackId);
    scheduleOcrDevices(rackId);
  });
}

// Fire-and-forget per-device OCR after a scan finishes. Runs only when
// outputs/<rackId>/ocr_devices.json doesn't already exist — re-running OCR
// on every canonical refresh would be wasteful (1-2 min on CPU). The user
// can still trigger a re-run via POST /api/scan/:rackId/ocr-devices.
//
// When OCR completes, we re-trigger downstream syncs (Netdisco, topology,
// canonical scan_result) so Netdisco/CMDB pick up real make/model instead
// of synth values. Without this re-sync, Netdisco would always be 1-2 min
// behind reality because its initial sync fires before OCR finishes.
const _ocrRunning = new Set();
function scheduleOcrDevices(rackId) {
  if (!rackId || _ocrRunning.has(rackId)) return;
  const rackDir = path.join(outputsDir, rackId);
  const ocrPath = path.join(rackDir, 'ocr_devices.json');
  const dumPath = path.join(rackDir, 'device_unit_map.json');
  // Need a device_unit_map to know what to crop; skip silently otherwise.
  if (!fs.existsSync(dumPath) || fs.existsSync(ocrPath)) return;
  _ocrRunning.add(rackId);
  const child = spawnChild(pythonCmd,
    ['-u', '-m', 'pipeline.ocr_devices', rackId, '--json'],
    { cwd: PROJECT_ROOT,
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' } });
  // Don't keep node process alive waiting on this; we just want it to run.
  if (typeof child.unref === 'function') child.unref();
  let stderr = '';
  child.stderr.on('data', c => { stderr += c.toString(); });
  child.on('close', () => {
    _ocrRunning.delete(rackId);
    if (!fs.existsSync(ocrPath)) {
      logger.warn(`[ocr_devices] ${rackId} produced no output: ${stderr.slice(-300)}`);
      return;
    }
    // OCR ran — re-sync downstream consumers so they pick up the real
    // make/model. All silent / fire-and-forget; the user never sees this.
    try { writeCanonicalScanResult(rackId); } catch (_) {}
    try {
      const ndProxy = require('./netdisco_proxy');
      if (ndProxy && typeof ndProxy.scheduleNetdiscoSync === 'function') {
        ndProxy.scheduleNetdiscoSync(rackId);
      }
    } catch (e) {
      logger.warn(`[ocr_devices→netdisco] resync skipped for ${rackId}: ${e.message}`);
    }
  });
  child.on('error', err => {
    _ocrRunning.delete(rackId);
    logger.warn(`[ocr_devices] spawn failed for ${rackId}: ${err.message}`);
  });
}

// Resolve a working Python interpreter once at startup. Prefer the project
// venv if it actually runs (cross-machine venvs can be broken stubs pointing
// at user-specific Python paths that don't exist on this PC), otherwise fall
// back to PYTHON_BIN env or "python" on PATH.
let _resolvedPython = null;
function resolvePythonBin() {
  if (_resolvedPython) return _resolvedPython;
  const { spawnSync } = require('child_process');
  const candidates = [];
  if (process.platform === 'win32') {
    candidates.push(path.join(__dirname, '..', 'venv', 'Scripts', 'python.exe'));
  } else {
    candidates.push(path.join(__dirname, '..', 'venv', 'bin', 'python'));
  }
  if (process.env.PYTHON_BIN) candidates.push(process.env.PYTHON_BIN);
  candidates.push(process.platform === 'win32' ? 'python' : 'python3');
  candidates.push('python');

  for (const c of candidates) {
    try {
      const r = spawnSync(c, ['-c', 'import sys; sys.exit(0)'], {
        stdio: 'ignore', timeout: 5000, windowsHide: true,
      });
      if (r.status === 0) {
        _resolvedPython = c;
        logger.info(`[python] using interpreter: ${c}`);
        return c;
      }
    } catch (_) { /* try next */ }
  }
  _resolvedPython = candidates[candidates.length - 1];
  logger.warn(`[python] no working interpreter found; falling back to ${_resolvedPython}`);
  return _resolvedPython;
}

// Background topology snapshot regeneration — runs servicenow/topology_generate.py
// after every canonical refresh so the topology view works for any scanned
// rack without a manual bootstrap step. Pure file I/O on the Python side
// (no ServiceNow API calls), so failure here is non-fatal and doesn't block
// the scan flow. Coalesces concurrent refreshes per rack.
const _topoRegenInflight = new Set();
function scheduleTopologyRegen(rackId) {
  if (!rackId || _topoRegenInflight.has(rackId)) return;
  _topoRegenInflight.add(rackId);
  const { spawn } = require('child_process');
  const pyBin = resolvePythonBin();
  const script = path.join(__dirname, '..', 'servicenow', 'topology_generate.py');
  const child = spawn(pyBin, [script, '--rack-id', rackId], {
    cwd: path.join(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { err += d.toString(); });
  child.on('close', (code) => {
    _topoRegenInflight.delete(rackId);
    if (code === 0) {
      logger.info({ event: 'topology.regenerated', rackId },
        `topology regenerated for ${rackId}`);
      recordEvent('topology.regenerated', { rackId });
    } else {
      logger.warn({ event: 'topology.regen_failed', rackId, exit: code,
        stderr: (err.trim() || out.trim()).slice(0, 500) },
        `topology regen failed for ${rackId} (exit ${code})`);
      recordEvent('topology.regen_failed', { rackId, exit: code });
    }
    // Whether topology regen succeeded or not, push the scan into Netdisco
    // so its DB stays in lock-step with what's on disk. Best-effort —
    // failure is logged inside the proxy module and never blocks the response.
    try {
      const ndProxy = require('./netdisco_proxy');
      if (ndProxy && typeof ndProxy.scheduleNetdiscoSync === 'function') {
        ndProxy.scheduleNetdiscoSync(rackId);
      }
    } catch (e) {
      logger.warn(`[netdisco] sync skipped for ${rackId}: ${e.message}`);
    }

    // Compute the CMDB diff and (if non-empty) auto-open / update the SR.
    // No direct CMDB writes happen here; the actual push waits for the
    // ticket to be approved + closed-complete in ServiceNow, at which
    // point the 5-min poller invokes bootstrap_cmdb_full.py.
    try {
      if (_cmdbTicketProxy && typeof _cmdbTicketProxy.scheduleCmdbTicket === 'function') {
        _cmdbTicketProxy.scheduleCmdbTicket(rackId);
      }
    } catch (e) {
      logger.warn(`[cmdb-ticket] auto-create skipped for ${rackId}: ${e.message}`);
    }
  });
  child.on('error', (e) => {
    _topoRegenInflight.delete(rackId);
    logger.warn(`[topology] failed to spawn for ${rackId}: ${e.message}`);
  });
}

// Lazy-loaded puppeteer + a single shared browser, kept warm across requests
// because launching Chromium is ~1s and we hit it from every share endpoint.
let _puppeteer = null;
let _browserPromise = null;
async function getBrowser() {
  if (!_puppeteer) _puppeteer = require('puppeteer');
  if (_browserPromise) {
    try {
      const b = await _browserPromise;
      if (b.connected ?? b.isConnected?.()) return b;
    } catch (_) { /* fall through and relaunch */ }
  }
  _browserPromise = _puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  return _browserPromise;
}

// Renders the canonical report.html through headless Chromium and writes
// report.pdf next to it. Body class `pdfMode` triggers the print-mode CSS that
// already lives in the HTML (hides the top bar, fixes gradient text, etc.).
async function buildScanReportPDF(rackId) {
  const built = buildScanReport(rackId);
  const pdfPath = path.join(built.data._rackDir, 'report.pdf');
  const fileUrl = 'file:///' + built.reportPath.replace(/\\/g, '/').replace(/^\//, '');

  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    // Block external network requests — the report HTML embeds an html2pdf
    // CDN script we don't need server-side, and we don't want PDF generation
    // to hang if the host is offline or behind a firewall.
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const url = req.url();
      if (url.startsWith('file:') || url.startsWith('data:')) return req.continue();
      return req.abort();
    });

    await page.goto(fileUrl, { waitUntil: 'load', timeout: 60_000 });
    await page.evaluate(() => document.body.classList.add('pdfMode'));
    await page.pdf({
      path: pdfPath,
      format: 'A4',
      printBackground: true,
      margin: { top: '14mm', right: '12mm', bottom: '14mm', left: '12mm' },
    });
  } finally {
    await page.close().catch(() => {});
  }
  return { ...built, pdfPath };
}

// ── Routes ────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '3.0.0', service: 'RackTrack API' });
});

// Auth endpoints (signup, verify, login, resend, me)
auth.registerRoutes(app);

// ── Audit log query (auth-required) ───────────────────────────
//
// GET /api/audit?action=&targetType=&targetId=&status=&since=&until=&limit=&offset=
//
// By default returns ONLY the calling user's events. Pass `?scope=all` to see
// every event — but only if the caller's username appears in the
// AUDIT_ADMINS env var (comma-separated). Without admin status, scope=all is
// silently downgraded to scope=self so we never leak other users' actions.
app.get('/api/audit', auth.requireAuth, (req, res) => {
  const adminUsers = String(process.env.AUDIT_ADMINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const isAdmin = adminUsers.includes(req.user.username);
  // scope=self  → only this user's events
  // scope=tenant → every event in this user's tenant (admin-gated)
  // scope=all   → cross-tenant view (super-admin; downgraded to tenant
  //               for non-admins so we never leak across tenants)
  let scope = req.query.scope || 'self';
  if (scope === 'all' && !isAdmin) scope = 'tenant';
  if (scope === 'tenant' && !isAdmin) scope = 'self';

  try {
    const rows = audit.query({
      userId:     scope === 'self'   ? req.user.id        : undefined,
      tenantId:   scope === 'tenant' ? req.user.tenant_id : undefined,
      action:     req.query.action     || undefined,
      targetType: req.query.targetType || undefined,
      targetId:   req.query.targetId   || undefined,
      status:     req.query.status     || undefined,
      sinceTs:    req.query.since      || undefined,
      untilTs:    req.query.until      || undefined,
      limit:      req.query.limit      || 100,
      offset:     req.query.offset     || 0,
    });
    res.json({ ok: true, scope, count: rows.length, events: rows });
  } catch (err) {
    logger.error('[audit] query failed:', err);
    res.status(500).json({ ok: false, error: 'Audit query failed' });
  }
});

// ── Active-learning loop ─────────────────────────────────────────────
// POST /api/admin/active-learning/cycle  → fire one ingest+retrain cycle.
// Heavy job: spawned as a detached subprocess so the HTTP request returns
// immediately. Caller polls GET /api/admin/active-learning/status for state.
//
// Restricted to AUDIT_ADMINS (same allow-list used for org-wide audit
// access). Logs every invocation as a business event so it shows up in
// metrics + the audit trail.
const _alState = { running: false, lastRunAt: null, lastExitCode: null, lastResult: null };

app.post('/api/admin/active-learning/cycle', auth.requireAuth, (req, res) => {
  const adminUsers = String(process.env.AUDIT_ADMINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (adminUsers.length && !adminUsers.includes(req.user.username)) {
    return res.status(403).json({ ok: false, error: 'admin only' });
  }
  if (_alState.running) {
    return res.status(409).json({ ok: false, error: 'cycle already running',
      startedAt: _alState.lastRunAt });
  }

  _alState.running = true;
  _alState.lastRunAt = new Date().toISOString();
  recordEvent('active_learning.cycle.started', { triggeredBy: req.user.username });
  audit.log({ req, action: 'active_learning.cycle', status: 'ok',
    payload: { triggeredBy: req.user.username } });

  const py = process.env.PYTHON_PATH || (process.platform === 'win32' ? 'py' : 'python3');
  const child = require('child_process').spawn(
    py, ['-m', 'retraining_learning.run_loop', '--once'],
    { cwd: PROJECT_ROOT, detached: false,
      stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let stdout = '', stderr = '';
  child.stdout.on('data', d => { stdout += d.toString(); });
  child.stderr.on('data', d => { stderr += d.toString(); });
  child.on('exit', (code) => {
    _alState.running = false;
    _alState.lastExitCode = code;
    _alState.lastResult = {
      finishedAt: new Date().toISOString(),
      exitCode: code,
      stdoutTail: stdout.split('\n').slice(-30).join('\n'),
      stderrTail: stderr.split('\n').slice(-30).join('\n'),
    };
    logger.info({
      event: 'active_learning.cycle.finished',
      exitCode: code,
      stdoutTail: stdout.slice(-500),
      stderrTail: stderr.slice(-500),
    }, `active-learning cycle exit=${code}`);
    recordEvent('active_learning.cycle.finished', { exitCode: code });
  });

  res.status(202).json({
    ok: true, started: true,
    startedAt: _alState.lastRunAt,
    pollAt: '/api/admin/active-learning/status',
  });
});

app.get('/api/admin/active-learning/status', auth.requireAuth, (req, res) => {
  const adminUsers = String(process.env.AUDIT_ADMINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (adminUsers.length && !adminUsers.includes(req.user.username)) {
    return res.status(403).json({ ok: false, error: 'admin only' });
  }
  res.json({ ok: true, ..._alState });
});

// ── Orphan GC (admin-only) ──────────────────────────────────────────
// POST /api/admin/orphan-gc/run  body: { dryRun?: bool, retentionDays?: int }
// Lists outputs/<rackId>/ folders with no rack_owners row + (when
// dryRun=false) deletes them. Default dryRun=true so it never destroys
// anything by accident.
function _isAdmin(req) {
  const adminUsers = String(process.env.AUDIT_ADMINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  return adminUsers.length === 0 || adminUsers.includes(req.user.username);
}

app.post('/api/admin/orphan-gc/run', auth.requireAuth, (req, res) => {
  if (!_isAdmin(req)) return res.status(403).json({ ok: false, error: 'admin only' });
  const dryRun = req.body?.dryRun !== false;       // default true
  const retentionDays = Number(req.body?.retentionDays) || 14;
  try {
    const summary = orphanGC.run({ dryRun, retentionDays });
    audit.log({ req, action: 'orphan_gc.run', status: 'ok', payload: {
      dryRun, retentionDays,
      scanned: summary.scanned, removed: summary.removed,
      freedBytes: summary.freedBytes,
    }});
    recordEvent('orphan_gc.run', { dryRun, removed: summary.removed });
    res.json({ ok: true, ...summary });
  } catch (e) {
    logger.error({ event: 'orphan_gc.failed', err: e.message }, 'orphan GC failed');
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Scheduled daily orphan GC. Default: dry-run only (logs counts but
// doesn't delete) so an operator can review the metric before
// flipping ORPHAN_GC_APPLY=1.
const _orphanGcIntervalMs = 24 * 60 * 60 * 1000;
const _orphanGcApply = process.env.ORPHAN_GC_APPLY === '1';
const _orphanGcRetentionDays = parseInt(process.env.ORPHAN_GC_RETENTION_DAYS, 10) || 14;
setInterval(() => {
  try {
    const summary = orphanGC.run({
      dryRun: !_orphanGcApply,
      retentionDays: _orphanGcRetentionDays,
    });
    logger.info({
      event: 'orphan_gc.scheduled',
      ...summary, orphans: undefined,   // omit per-folder list from log
      sampleOrphans: (summary.orphans || []).slice(0, 5).map(o => o.rackId),
    }, `scheduled orphan GC: ${summary.removed}/${summary.scanned} ${_orphanGcApply ? 'pruned' : 'would-prune'}`);
  } catch (e) {
    logger.warn({ event: 'orphan_gc.scheduled_failed', err: e.message },
      `scheduled orphan GC failed: ${e.message}`);
  }
}, _orphanGcIntervalMs).unref();

/**
 * POST /api/detect
 * Stateless live-overlay detection — runs only YOLO bbox classification on
 * the uploaded JPEG. NO rack folder, NO OCR, NO port detection, NO audit
 * log, NO image renders. Used by the Camera viewfinder's per-frame loop.
 *
 * Response: { devices: [{ class_name, confidence, bbox:[x,y,w,h] }],
 *             image_size: { w, h } }
 */
app.post('/api/detect', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image file provided' });
  const tmpPath = req.file.path;
  try {
    const result = await pool.request('detect_only', {
      image_path:  tmpPath,
      config_path: CONFIG_PATH,
    });
    if (!result.ok) {
      return res.status(400).json({ error: result.error || 'detection failed' });
    }
    res.json({
      devices:    result.devices || [],
      image_size: result.image_size || null,
    });
  } catch (err) {
    logger.error({ err: err.message }, 'detect failed');
    res.status(500).json({ error: 'detection failed' });
  } finally {
    safeUnlink(tmpPath);
  }
});

/**
 * POST /api/analyze
 * 1. Hash the uploaded image → RK-XXXXXXXX
 * 2. If outputs/RK-XXXXXXXX/device_unit_map.json exists → return cached result
 * 3. Otherwise run pipeline --detect_only, save outputs, return fresh result
 */
app.post('/api/analyze', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image file provided' });

  let tmpPath = req.file.path;
  const reqStart = Date.now();
  const timings = {};

  try {
    const tNormStart = Date.now();
    tmpPath = await normalizeImage(tmpPath);
    timings.normalize_ms = Date.now() - tNormStart;
    const rackId    = computeRackId(tmpPath);
    const rackDir   = path.join(outputsDir, rackId);
    const jsonPath  = path.join(rackDir, 'device_unit_map.json');

    // Tenant ownership: anyone scanning an image (cached or fresh) is
    // making a tenant-scoped claim on this rack. Idempotent — multiple
    // tenants can co-own the same RK-id when they scan the same image.
    const _authPayload = softAuthPayload(req);
    const _scanTenantId = _authPayload?.tenantId || null;
    const _scanUserId = _authPayload?.sub || null;
    if (_scanTenantId) tenant.claimRack(_scanTenantId, rackId, _scanUserId);

    // ── Cache hit ──────────────────────────────────────────
    if (fs.existsSync(jsonPath)) {
      safeUnlink(tmpPath); // discard duplicate upload
      logger.info({ event: 'scan.cache_hit', rackId, tenantId: _scanTenantId }, `cache hit ${rackId}`);
      recordEvent('scan.cache_hit', { rackId, tenantId: _scanTenantId });
      await ensurePortCounts(rackId);
      timings.total_ms = Date.now() - reqStart;
      timings.cached = true;
      audit.log({ req, action: 'scan.create', status: 'ok', targetType: 'rack', targetId: rackId, payload: { cached: true } });
      scheduleCanonicalRefresh(rackId);
      return res.json({ ...buildResponse(rackId, true), timings });
    }

    // ── Quality pre-check (tilt) ───────────────────────────
    const skipQualityCheck = req.body?.skipQualityCheck === '1' || req.body?.skipQualityCheck === 'true';
    const tQualStart = Date.now();
    const quality = skipQualityCheck
      ? { ok: true, metrics: { note: 'user-override' } }
      : await runQualityCheck(tmpPath);
    timings.quality_check_ms = Date.now() - tQualStart;
    if (!quality.ok) {
      safeUnlink(tmpPath);
      return res.status(400).json({
        error: quality.error,
        metrics: quality.metrics,
        kind: quality.kind || null,
        retryable: quality.retryable === true,
      });
    }

    // ── Cache miss — run pipeline ──────────────────────────
    fs.mkdirSync(rackDir, { recursive: true });

    // Persist image inside the rack folder so /api/select always finds it.
    // normalizeImage() outputs JPEG, so always use .jpg regardless of original extension.
    const ext          = path.extname(tmpPath) || '.jpg';
    const imagePath    = path.join(rackDir, `original_image${ext}`);
    fs.copyFileSync(tmpPath, imagePath);
    safeUnlink(tmpPath); // remove from uploads/

    const meta = {
      rackId,
      userId:     softAuthUserId(req),  // null for unauthenticated scans
      imageHash:  crypto.createHash('sha256').update(fs.readFileSync(imagePath)).digest('hex'),
      imagePath,
      timestamp:  new Date().toISOString(),
      quality:    quality.metrics || null,
      qualityWarning:    quality.warning || null,
      qualityWarningMsg: quality.warning_msg || null,
    };
    writeMeta(rackId, meta);

    const tPipeStart = Date.now();
    await runPipelineAnalyze(imagePath, rackDir);
    timings.pipeline_ms = Date.now() - tPipeStart;

    // ── Front-of-rack + framing check (post-pipeline) ──────
    const mapData = fs.existsSync(jsonPath) ? JSON.parse(fs.readFileSync(jsonPath, 'utf8')) : {};
    const deviceCount = Array.isArray(mapData.devices) ? mapData.devices.length : 0;
    const unitCount = Array.isArray(mapData.units_detected) ? mapData.units_detected.length : 0;

    // When the user clicked "Proceed" on the quality warning, they have
    // explicitly asked us to accept whatever the pipeline produces. Don't
    // re-gate on deviceCount / unitCount in that case — the pipeline ran,
    // so whatever it found is what they'll see.
    if (!skipQualityCheck) {
      if (deviceCount === 0) {
        fs.rmSync(rackDir, { recursive: true, force: true });
        return res.status(400).json({
          error: 'Please take the photo from the front of the rack — we need to see the devices and ports face-on.',
          retryable: true,
          kind: 'quality',
        });
      }
      if (unitCount < 3) {
        fs.rmSync(rackDir, { recursive: true, force: true });
        return res.status(400).json({
          error: 'Please upload a clearer photo of the rack — keep the camera steady and make sure the full rack fits in the frame.',
          retryable: true,
          kind: 'quality',
        });
      }
    }

    timings.total_ms = Date.now() - reqStart;
    timings.cached = false;
    logger.info({ event: 'scan.created', rackId, durationMs: timings.total_ms, timings },
      `new scan ${rackId} (analyze ${timings.total_ms}ms)`);
    recordEvent('scan.created', { rackId, durationMs: timings.total_ms });
    audit.log({
      req,
      action: 'scan.create',
      status: 'ok',
      targetType: 'rack',
      targetId: rackId,
      payload: { devices: deviceCount, units: unitCount, totalMs: timings.total_ms },
    });
    scheduleCanonicalRefresh(rackId);
    res.json({ ...buildResponse(rackId, false), timings });

  } catch (err) {
    // Clean up tmp if still around
    safeUnlink(tmpPath);
    logger.error(err.message);
    audit.log({ req, action: 'scan.create', status: 'fail', error: err.message });
    res.status(400).json({
      error: 'Please upload a clearer photo of the rack — keep the camera steady and make sure the full rack fits in the frame.',
      retryable: true,
      kind: 'quality',
    });
  }
});

/**
 * POST /api/ocr/labels
 * Runs EasyOCR on an uploaded image (front or rear of rack) and returns
 * extracted text labels with bounding boxes. Used to enrich device names
 * in the analyze flow when physical labels exist on the rack/devices.
 *
 * Body (multipart/form-data):
 *   image  (file, required)         — JPEG/PNG of the rack
 *   side   ('front' | 'rear')       — which face this image is (default: front)
 *   rackId (string, optional)       — if provided, labels are cached under
 *                                     outputs/<rackId>/labels-<side>.json so
 *                                     they can be mapped to detected devices.
 *
 * Response:
 *   {
 *     image_size: { w, h },
 *     labels:     [ { text, conf, bbox } ],
 *     side:       'front' | 'rear',
 *     summary:    { count, highConfCount, hasLabels }
 *   }
 *
 * "hasLabels" is true when ≥3 detections exceed conf 0.6 — the threshold the
 * client uses to decide whether to prompt the user for a rear-of-rack image.
 */
function runOcrLabels(imagePath) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const pyBin = resolvePythonBin();
    const script = path.join(__dirname, '..', 'pipeline', 'ocr_labels.py');
    const child = spawn(pyBin, [script, imagePath], {
      cwd: path.join(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '', err = '';
    child.stdout.on('data', d => out += d.toString());
    child.stderr.on('data', d => err += d.toString());
    child.on('close', code => {
      if (code !== 0) {
        return reject(new Error(`OCR failed (exit ${code}): ${err.trim() || out.trim() || 'no output'}`));
      }
      try {
        resolve(JSON.parse(out));
      } catch (e) {
        reject(new Error(`OCR output was not JSON: ${e.message}`));
      }
    });
    child.on('error', e => reject(e));
  });
}

app.post('/api/ocr/labels', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image file provided' });

  const side   = (req.body?.side === 'rear') ? 'rear' : 'front';
  const rackId = (req.body?.rackId || '').trim() || null;

  let tmpPath = req.file.path;
  try {
    tmpPath = await normalizeImage(tmpPath);
    const result = await runOcrLabels(tmpPath);

    // Cache labels under the rack folder so they can be mapped to devices later.
    if (rackId) {
      const rackDir = path.join(outputsDir, rackId);
      fs.mkdirSync(rackDir, { recursive: true });
      fs.writeFileSync(
        path.join(rackDir, `labels-${side}.json`),
        JSON.stringify(result, null, 2)
      );
    }

    safeUnlink(tmpPath);

    const HIGH_CONF  = 0.6;
    const MIN_LABELS = 3;
    const labels = Array.isArray(result.labels) ? result.labels : [];
    const highConfCount = labels.filter(l => (l.conf || 0) >= HIGH_CONF).length;

    res.json({
      image_size: result.image_size || null,
      labels,
      side,
      summary: {
        count: labels.length,
        highConfCount,
        hasLabels: highConfCount >= MIN_LABELS,
      },
    });
  } catch (e) {
    safeUnlink(tmpPath);
    logger.warn(`[ocr] failed: ${e.message}`);
    res.status(500).json({ error: e.message, labels: [] });
  }
});

/**
 * GET /api/ocr/labels/:rackId
 * Returns the cached OCR labels for a rack (front + rear, if both exist) and
 * maps each label to its best-matching detected device by vertical bbox
 * overlap with the device's U-slot region. Devices without an OCR match keep
 * their synthetic name (the client can decide whether to display the label).
 *
 * Response:
 *   {
 *     front:  { labels: [...], image_size: {w,h} } | null,
 *     rear:   { labels: [...], image_size: {w,h} } | null,
 *     deviceLabels: [
 *       { device_index, synthetic_name, label, conf, source: 'front'|'rear' }
 *     ]
 *   }
 */
app.get('/api/ocr/labels/:rackId', (req, res) => {
  const rackId  = req.params.rackId;
  const rackDir = path.join(outputsDir, rackId);
  if (!fs.existsSync(rackDir)) return res.status(404).json({ error: `Rack ${rackId} not found` });

  const readJson = (p) => {
    try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; }
    catch { return null; }
  };

  const front = readJson(path.join(rackDir, 'labels-front.json'));
  const rear  = readJson(path.join(rackDir, 'labels-rear.json'));
  const dum   = readJson(path.join(rackDir, 'device_unit_map.json'));

  const deviceLabels = [];
  if (dum && Array.isArray(dum.devices)) {
    // For each device, find the best-matching label by Y-overlap (front → rear fallback).
    const matchSide = (sideName, sideData) => {
      if (!sideData?.labels?.length || !sideData.image_size) return null;
      const imgH = sideData.image_size.h || 1;
      return dum.devices.map((dev, idx) => {
        const yPct  = (dev.bbox?.y ?? 0) / (dum.image_size?.h || imgH) * 100;
        const hPct  = (dev.bbox?.h ?? 0) / (dum.image_size?.h || imgH) * 100;
        // Find label whose center yPct falls inside the device's vertical band.
        let best = null, bestScore = -1;
        for (const l of sideData.labels) {
          const lYPct = (l.bbox?.yPct ?? 0) + (l.bbox?.h ?? 0) / imgH * 50;
          // overlap score: 1.0 if center is inside the device band, else falls off
          if (lYPct < yPct - 1 || lYPct > yPct + hPct + 1) continue;
          const score = (l.conf || 0);
          if (score > bestScore) { bestScore = score; best = l; }
        }
        return best ? { idx, label: best, side: sideName } : null;
      }).filter(Boolean);
    };

    const frontMatches = matchSide('front', front) || [];
    const rearMatches  = matchSide('rear',  rear)  || [];

    // Front wins; rear fills in gaps.
    const matched = new Map();
    for (const m of frontMatches) matched.set(m.idx, m);
    for (const m of rearMatches) if (!matched.has(m.idx)) matched.set(m.idx, m);

    dum.devices.forEach((dev, idx) => {
      const m = matched.get(idx);
      deviceLabels.push({
        device_index:   idx,
        synthetic_name: dev.name || `dev${idx}`,
        label:          m ? m.label.text : null,
        conf:           m ? m.label.conf : null,
        source:         m ? m.side : null,
      });
    });
  }

  res.json({ front, rear, deviceLabels });
});

/**
 * POST /api/select
 * Runs full pipeline with --device_index and --port on the cached rack image.
 * Reads imagePath from scan_meta.json — no in-memory state required.
 */
app.post('/api/select', async (req, res) => {
  const { scanId, device_index, port } = req.body;
  const rackId = scanId;

  if (!rackId || device_index == null || port == null) {
    return res.status(400).json({ error: 'scanId, device_index, and port are required' });
  }

  const meta = readMeta(rackId);
  if (!meta) {
    return res.status(404).json({ error: `Rack ${rackId} not found. Please re-upload the image.` });
  }

  // meta.imagePath may be a stale absolute path from another machine
  // (e.g. scans copied between systems). Fall back to scanning the rack
  // folder for original_image.{jpg,jpeg,png} — same pattern as the
  // ticket-mode select route below.
  const rackDir = path.join(outputsDir, rackId);
  let imagePath = meta.imagePath && fs.existsSync(meta.imagePath) ? meta.imagePath : null;
  if (!imagePath) {
    for (const ext of ['jpg', 'jpeg', 'png']) {
      const candidate = path.join(rackDir, `original_image.${ext}`);
      if (fs.existsSync(candidate)) { imagePath = candidate; break; }
    }
  }
  if (!imagePath) {
    return res.status(404).json({ error: 'Original image missing from rack folder. Please re-upload.' });
  }

  const reqStart = Date.now();
  const timings = {};

  try {
    const tPipeStart = Date.now();
    await runPipelineSelect(imagePath, rackDir, device_index, port);
    timings.pipeline_ms = Date.now() - tPipeStart;

    const infoPath = path.join(rackDir, 'selected_port_info.json');
    const fullData = fs.existsSync(infoPath)
      ? JSON.parse(fs.readFileSync(infoPath, 'utf8'))
      : {};
    const portInfo = fullData.port_info || {};

    // Archive per-port image copies + log this identification so the report
    // can show every port the user has inspected (not just the last one).
    // New layout: copies live under <rack>/ports/, source pipeline PNGs
    // under <rack>/images/.
    const idsPath = path.join(rackDir, 'port_identifications.jsonl');
    const baseDevice = `d${device_index}_p${port}_device.png`;
    const baseFull   = `d${device_index}_p${port}_full.png`;
    const srcDevice = rackImagePath(rackDir, '5_selected_device_with_port.png');
    const srcFull   = rackImagePath(rackDir, '6_full_rack_selected_port.png');
    const dstDevice = rackPortPath(rackDir, baseDevice);
    const dstFull   = rackPortPath(rackDir, baseFull);
    try {
      if (fs.existsSync(srcDevice)) fs.copyFileSync(srcDevice, dstDevice);
      if (fs.existsSync(srcFull))   fs.copyFileSync(srcFull, dstFull);
    } catch (e) { logger.error('port image archive failed:', e.message); }

    const idEntry = {
      timestamp: new Date().toISOString(),
      device_index: Number(device_index),
      port: Number(port),
      port_info: portInfo,
      port_classification: fullData.port_classification || null,
      device_image: fs.existsSync(dstDevice) ? rackPortRelative(rackDir, baseDevice) : null,
      full_rack_image: fs.existsSync(dstFull) ? rackPortRelative(rackDir, baseFull) : null,
    };
    try {
      fs.appendFileSync(idsPath, JSON.stringify(idEntry) + '\n');
    } catch (e) { logger.error('port id log failed:', e.message); }

    timings.total_ms = Date.now() - reqStart;
    audit.log({
      req,
      action: 'scan.select_port',
      status: 'ok',
      targetType: 'rack',
      targetId: rackId,
      payload: { device_index: Number(device_index), port: Number(port) },
    });
    scheduleCanonicalRefresh(rackId);
    res.json({
      resultImageUrl: `/outputs/${rackId}/${rackImageUrlPath(rackDir, '5_selected_device_with_port.png')}`,
      rackImageUrl:   `/outputs/${rackId}/${rackImageUrlPath(rackDir, '6_full_rack_selected_port.png')}`,
      portInfo,
      portClassification: fullData.port_classification || null,
      timings,
    });
  } catch (err) {
    logger.error(err.message);
    audit.log({
      req,
      action: 'scan.select_port',
      status: 'fail',
      targetType: 'rack',
      targetId: rackId,
      error: err.message,
      payload: { device_index, port },
    });
    res.status(500).json({ error: 'Pipeline failed', details: err.message });
  }
});

// ── ServiceNow incident integration ────────────────────────────
// Poller writes tickets into ../servicenow_inbox/. Scan page reads them
// via /api/incidents/active and targets the specific port without any
// manual device/port selection.

const INBOX_DIR = path.join(__dirname, '..', 'servicenow_inbox');

function readActiveTickets() {
  const p = path.join(INBOX_DIR, 'active_tickets.json');
  if (!fs.existsSync(p)) return { count: 0, tickets: [] };
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return { count: 0, tickets: [] };
  }
}

function readTicketByNumber(inc) {
  const p = path.join(INBOX_DIR, `${inc}.ticket.json`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/**
 * Map a CMDB device name (e.g. SW-U10) to a device_index inside a scan's
 * device_unit_map.json. Matching rule: class matches the name prefix
 * (SW→Switch, PP→Patch Panel, SRV→Server) AND the scan lists the device at
 * the same U position that the name encodes (U10 → "u10" in units).
 */
function deviceIndexFromTicket(rackDir, cmdbDeviceName) {
  const r = resolveTicketDevice(rackDir, cmdbDeviceName);
  return r.device_index;
}

/**
 * Resolve a CMDB device name to a scan device_index + full diagnostic about
 * what the scan sees at the expected U. Used for drift detection.
 *
 * Returns:
 *   {
 *     device_index: number | null,         // null on drift / miss / bad name
 *     expected_class: "Switch" | ...,       // derived from name prefix
 *     expected_u: number | null,           // derived from name suffix
 *     detections_at_u: [{class_name, confidence}],  // everything the scan sees at expected_u
 *   }
 */
function resolveTicketDevice(rackDir, cmdbDeviceName) {
  const result = { device_index: null, expected_class: null, expected_u: null, detections_at_u: [] };
  const mapPath = path.join(rackDir, 'device_unit_map.json');
  if (!fs.existsSync(mapPath)) return result;
  const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  const prefixToClass = { 'SW-': 'Switch', 'PP-': 'Patch Panel', 'SRV-': 'Server' };
  const prefix = Object.keys(prefixToClass).find(p => cmdbDeviceName.toUpperCase().startsWith(p));
  if (!prefix) return result;
  result.expected_class = prefixToClass[prefix];
  const m = /U(\d{1,2})$/i.exec(cmdbDeviceName);
  if (!m) return result;
  const uNum = parseInt(m[1], 10);
  result.expected_u = uNum;
  const uTarget = `u${String(uNum).padStart(2, '0')}`;
  const devices = map.devices || [];
  let best = -1;
  let bestConf = -1;
  for (let i = 0; i < devices.length; i++) {
    const d = devices[i];
    if ((d.units || []).includes(uTarget)) {
      result.detections_at_u.push({ class_name: d.class_name, confidence: d.confidence, device_index: i });
    }
    if (d.class_name === result.expected_class && (d.units || []).includes(uTarget)) {
      if ((d.confidence || 0) > bestConf) { best = i; bestConf = d.confidence; }
    }
  }
  if (best >= 0) result.device_index = best;
  // Sort detections by confidence desc for display
  result.detections_at_u.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  return result;
}

/**
 * POST /api/analyze-video
 *
 * Multi-rack scan: user uploads ONE video that pans across N parallel
 * racks. The server:
 *   1. Saves the video, computes a stable hash (group key).
 *   2. Splits the video into N best-frames via the worker
 *      (`split_video_racks` command → pipeline.multi_rack_split).
 *   3. For each best-frame, runs the same /api/analyze flow that single
 *      images use — produces a normal RK-XXXXXXXX scan with full output
 *      directory, port detection, etc. So every per-rack feature
 *      (Ports / Topology / SFP advisor / Firmware) works as-is.
 *   4. Records the parent group (rack_groups) + members so the UI can
 *      navigate "Rack 1 / Rack 2 / Rack 3" from a single entry point.
 *
 * Returns:
 *   { ok: true, groupId, count, racks: [
 *       { rackId, position, label, deviceCount, score, cached }
 *     ] }
 */
app.post('/api/analyze-video', upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No video file provided' });
  const reqStart = Date.now();
  const videoPath = req.file.path;

  // Tenant required — multi-rack scans always go into someone's tenant.
  const authPayload = softAuthPayload(req);
  const tenantId = authPayload?.tenantId;
  const userId   = authPayload?.sub || null;
  if (!tenantId) {
    safeUnlink(videoPath);
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    // 1. Split video into per-rack best frames (worker call).
    const splitResult = await withSpan('multi_rack.split', async () => {
      const r = await pool.request('split_video_racks', {
        video_path: videoPath,
      });
      if (!r.ok) throw new Error(r.error || 'split failed');
      return r;
    }, { videoPath });

    const detected = Array.isArray(splitResult.racks) ? splitResult.racks : [];
    if (detected.length === 0) {
      safeUnlink(videoPath);
      return res.status(400).json({ error: 'No racks detected in the video. Try a clearer pan.' });
    }

    // 2. Run /api/analyze logic on each best frame, in series so we
    //    don't melt the worker pool. (For 2-3 racks this is fine; for
    //    huge videos we'd parallelize.)
    const racks = [];
    const videoHash = crypto.createHash('sha256')
      .update(fs.readFileSync(videoPath))
      .digest('hex').slice(0, 16);
    const groupId = rackGroups.create({ tenantId, userId, videoHash });

    for (const r of detected) {
      try {
        // Normalize the JPEG so it goes through the same pipeline as
        // an image upload (auto-orient, mozjpeg, etc.)
        const normalizedPath = await normalizeImage(r.best_frame_path);
        const rackId = computeRackId(normalizedPath);
        const rackDir = path.join(outputsDir, rackId);
        const jsonPath = path.join(rackDir, 'device_unit_map.json');

        // Tenant ownership for each member rack
        tenant.claimRack(tenantId, rackId, userId);

        let cached = false;
        if (fs.existsSync(jsonPath)) {
          // Cache hit — just record group membership, no re-analysis.
          cached = true;
          await ensurePortCounts(rackId);
        } else {
          // Fresh analysis — same path /api/analyze takes. We save the
          // file under the same name single-rack scans use ("original_image")
          // so:
          //   * the Results-page hero image URL (/outputs/<rackId>/original_image.<ext>) resolves
          //   * pipeline.ocr_devices can find the source crop
          //   * scheduleCanonicalRefresh / Netdisco / CMDB all use the same file
          fs.mkdirSync(rackDir, { recursive: true });
          const ext = path.extname(normalizedPath) || '.jpg';
          const imagePath = path.join(rackDir, `original_image${ext}`);
          fs.copyFileSync(normalizedPath, imagePath);
          await runPipelineAnalyze(imagePath, rackDir);
          await ensurePortCounts(rackId);
          writeMeta(rackId, {
            rackId, userId,
            imageHash: crypto.createHash('sha256')
              .update(fs.readFileSync(imagePath)).digest('hex'),
            imagePath,
            timestamp: new Date().toISOString(),
          });
        }
        safeUnlink(normalizedPath);

        rackGroups.addMember({
          groupId, rackId,
          position: r.position,
          label:    r.label,
          deviceCount: r.device_count,
          score:    r.score,
        });

        racks.push({
          rackId, position: r.position, label: r.label,
          deviceCount: r.device_count, score: r.score, cached,
        });
        scheduleCanonicalRefresh(rackId);
      } catch (err) {
        logger.warn({
          event: 'multi_rack.member_failed',
          err: err.message, frameIndex: r.frame_index, position: r.position,
        }, `member rack ${r.position} failed: ${err.message}`);
      }
    }

    safeUnlink(videoPath);

    audit.log({
      req, action: 'scan.video', status: 'ok', targetType: 'rack_group',
      targetId: groupId,
      payload: { count: racks.length, durationMs: Date.now() - reqStart },
    });
    recordEvent('multi_rack.scan_completed', {
      groupId, count: racks.length, tenantId,
    });
    logger.info({
      event: 'multi_rack.scan_completed',
      groupId, count: racks.length, durationMs: Date.now() - reqStart,
    }, `multi-rack scan: ${racks.length} racks under ${groupId}`);

    res.json({
      ok: true, groupId, count: racks.length,
      durationMs: Date.now() - reqStart,
      racks,
    });
  } catch (err) {
    safeUnlink(videoPath);
    logger.error({
      event: 'multi_rack.scan_failed', err: err.message,
    }, 'multi-rack scan failed');
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/rack-group/:groupId
 *
 * Returns the parent group + each member rack. Tenant-scoped: 404 if
 * the group's tenant doesn't match the caller's tenant.
 */
app.get('/api/rack-group/:groupId', auth.requireAuth, (req, res) => {
  const data = rackGroups.get(req.params.groupId);
  if (!data) return res.status(404).json({ error: 'Group not found' });
  if (data.group.tenant_id !== req.user.tenant_id) {
    // 404 not 403 — don't reveal cross-tenant existence
    return res.status(404).json({ error: 'Group not found' });
  }
  res.json({ ok: true, ...data });
});

/**
 * GET /api/rack/:rackId/group
 *
 * Returns the parent rack-group (if any) for a single rack. Used by
 * per-rack pages (Results, Ports, Topology) to detect that a rack is
 * part of a multi-rack scan and render the rack-switcher tabs at the
 * top. Returns { ok: true, group: null } when the rack is standalone.
 */
app.get('/api/rack/:rackId/group', auth.requireAuth, (req, res) => {
  const groupId = rackGroups.findGroupForRack(req.params.rackId);
  if (!groupId) return res.json({ ok: true, group: null });
  const data = rackGroups.get(groupId);
  if (!data) return res.json({ ok: true, group: null });
  // Don't reveal cross-tenant membership
  if (data.group.tenant_id !== req.user.tenant_id) {
    return res.json({ ok: true, group: null });
  }
  res.json({ ok: true, ...data });
});

/**
 * GET /api/rack-groups
 * List recent multi-rack scans for the caller's tenant.
 */
app.get('/api/rack-groups', auth.requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
  const groups = rackGroups.listForTenant(req.user.tenant_id, limit);
  res.json({ ok: true, groups });
});

/**
 * GET /api/incidents/active
 * Returns the current list of RackTrack-actionable tickets pulled from
 * ServiceNow by the poller, plus the top one as a convenience field.
 */
app.get('/api/incidents/active', (req, res) => {
  const data = readActiveTickets();
  res.json({
    polled_at: data.polled_at || null,
    count: data.count || 0,
    top: (data.tickets && data.tickets[0]) || null,
    tickets: data.tickets || [],
  });
});

/**
 * POST /api/analyze-for-ticket
 * Scan-page one-shot: upload image + incident_number. Server does:
 *   1. Normal analyze (or cache hit)
 *   2. Resolve ticket → device_index via CMDB u_position + class
 *   3. Run the port-select pipeline for that device+port
 *   4. Try LLDP over SSH to the switch's mgmt_ip for the interface
 * Returns the bundled payload so the client has one round trip.
 */
app.post('/api/analyze-for-ticket', upload.single('image'), async (req, res) => {
  const incNumber = req.body?.incident_number;
  if (!incNumber) return res.status(400).json({ error: 'incident_number is required' });

  const ticket = readTicketByNumber(incNumber);
  if (!ticket) return res.status(404).json({ error: `Ticket ${incNumber} not in inbox` });

  const cmdb = ticket.cmdb || {};
  const target = ticket.target || {};
  if (!target.device || target.port == null) {
    return res.status(400).json({ error: 'ticket missing target.device or target.port' });
  }
  if (!req.file) return res.status(400).json({ error: 'No image file provided' });

  const reqStart = Date.now();
  const timings = {};

  try {
    // STEP 1 — analyze the rack (reuse logic from /api/analyze inline)
    let tmpPath = req.file.path;
    tmpPath = await normalizeImage(tmpPath);
    const rackId   = computeRackId(tmpPath);
    const rackDir  = path.join(outputsDir, rackId);
    const jsonPath = path.join(rackDir, 'device_unit_map.json');

    // Tenant ownership claim (same logic as /api/analyze).
    const _ticketAuth = softAuthPayload(req);
    if (_ticketAuth?.tenantId) {
      tenant.claimRack(_ticketAuth.tenantId, rackId, _ticketAuth.sub || null);
    }

    if (fs.existsSync(jsonPath)) {
      safeUnlink(tmpPath);
      logger.info({ event: 'ticket.cache_hit', rackId }, `ticket cache hit ${rackId}`);
      recordEvent('ticket.cache_hit', { rackId });
    } else {
      // Skip quality check in ticket mode — the tech is directed to a specific
      // rack by the ticket, we don't want to gate on tilt/lighting.
      fs.mkdirSync(rackDir, { recursive: true });
      const ext = path.extname(tmpPath) || '.jpg';
      const imagePath = path.join(rackDir, `original_image${ext}`);
      fs.copyFileSync(tmpPath, imagePath);
      safeUnlink(tmpPath);
      const tPipeStart = Date.now();
      await runPipelineAnalyze(imagePath, rackDir);
      timings.analyze_ms = Date.now() - tPipeStart;
    }

    // STEP 2 — resolve ticket device to a scan device_index, and in the same
    // call gather "what is physically there at the expected U" for drift reporting.
    const resolved = resolveTicketDevice(rackDir, target.device);
    if (resolved.device_index == null) {
      // PHYSICAL DRIFT — CMDB says there should be a `expected_class` at U`expected_u`,
      // but the scan sees something else (or nothing). Return a drift payload with
      // enough context for the client to render a "something is wrong" view.
      const analyzeResp = buildResponse(rackId, fs.existsSync(jsonPath));
      const seen = resolved.detections_at_u;
      const reason = seen.length === 0
        ? `CMDB says ${target.device} (${resolved.expected_class}) should be at U${String(resolved.expected_u).padStart(2,'0')}, but the scan detected nothing at that position.`
        : `CMDB says ${target.device} (${resolved.expected_class}) should be at U${String(resolved.expected_u).padStart(2,'0')}, but the scan sees ${seen.map(d => d.class_name).join(', ')} instead.`;
      timings.total_ms = Date.now() - reqStart;
      audit.log({
        req,
        action: 'scan.analyze_for_ticket',
        status: 'ok',
        targetType: 'rack',
        targetId: rackId,
        payload: { incident: incNumber, device: target.device, drift: true, expected_u: resolved.expected_u, seen: seen.map(d => d.class_name) },
      });
      return res.json({
        ...analyzeResp,
        ticket,
        resolved: null,
        driftDetected: true,
        drift: {
          expected_device: target.device,
          expected_class: resolved.expected_class,
          expected_u: resolved.expected_u,
          detections_at_u: seen,
          reason,
        },
        rackImageUrl: analyzeResp.imageUrl,
        resultImageUrl: analyzeResp.imageUrl,
        portInfo: null,
        portClassification: null,
        lldp: null,
        timings,
      });
    }
    const device_index = resolved.device_index;

    // STEP 3 — run port-select for this device + port. Find the cached image:
    // readMeta() may miss it (demo folders shipped without scan_meta.json), so
    // fall back to scanning rackDir for original_image.{jpg,jpeg,png}.
    const meta = readMeta(rackId);
    let imagePath = meta && meta.imagePath && fs.existsSync(meta.imagePath) ? meta.imagePath : null;
    if (!imagePath) {
      for (const ext of ['jpg', 'jpeg', 'png']) {
        const candidate = path.join(rackDir, `original_image.${ext}`);
        if (fs.existsSync(candidate)) { imagePath = candidate; break; }
      }
    }
    if (!imagePath) {
      return res.status(500).json({ error: `Cached image not found in ${rackDir}. Please upload the image again.` });
    }
    // Python pipeline expects 1-based device_index (runner.py:373 validates
    // `1 <= args.device_index <= len(devices)`); our resolveTicketDevice uses
    // 0-based. Convert on the wire.
    const pipelineDeviceIdx = device_index + 1;
    const tSelStart = Date.now();
    await runPipelineSelect(imagePath, rackDir, pipelineDeviceIdx, target.port);
    timings.select_ms = Date.now() - tSelStart;

    const infoPath = path.join(rackDir, 'selected_port_info.json');
    const fullData = fs.existsSync(infoPath) ? JSON.parse(fs.readFileSync(infoPath, 'utf8')) : {};
    const portInfo = fullData.port_info || {};

    // Archive per-port images (use the 1-based index to match ResultsPage conventions)
    const baseDevice = `d${pipelineDeviceIdx}_p${target.port}_device.png`;
    const baseFull   = `d${pipelineDeviceIdx}_p${target.port}_full.png`;
    const srcDevice  = rackImagePath(rackDir, '5_selected_device_with_port.png');
    const srcFull    = rackImagePath(rackDir, '6_full_rack_selected_port.png');
    const dstDevice  = rackPortPath(rackDir, baseDevice);
    const dstFull    = rackPortPath(rackDir, baseFull);
    try {
      if (fs.existsSync(srcDevice)) fs.copyFileSync(srcDevice, dstDevice);
      if (fs.existsSync(srcFull))   fs.copyFileSync(srcFull, dstFull);
    } catch (e) { logger.error('port image archive failed:', e.message); }

    // STEP 4 — LLDP / SSH (best-effort; network is often unreachable in demo)
    let lldp = null;
    const host  = cmdb.mgmt_ip;
    const iface = cmdb.interface_alias;
    if (host && iface) {
      const vendorKey = VENDORS[cmdb.vendor] ? cmdb.vendor : 'tplink';
      const { username, password, enablePassword } = resolveSwitchCreds({ vendor: vendorKey });
      if (username && password) {
        const tLldpStart = Date.now();
        try {
          const out = await findNeighborChain({ host, port: 22, username, password, enablePassword, iface, vendor: vendorKey });
          lldp = { ok: true, ...out };
        } catch (err) {
          lldp = { ok: false, error: err.message, host, iface, vendor: vendorKey };
        }
        timings.lldp_ms = Date.now() - tLldpStart;
      } else {
        lldp = { ok: false, error: 'No SSH creds configured for this vendor', host, iface, vendor: vendorKey };
      }
    } else {
      lldp = { ok: false, error: 'Ticket CMDB has no mgmt_ip or interface_alias', host, iface };
    }

    timings.total_ms = Date.now() - reqStart;
    audit.log({
      req,
      action: 'scan.analyze_for_ticket',
      status: 'ok',
      targetType: 'rack',
      targetId: rackId,
      payload: { incident: incNumber, device: target.device, port: target.port, device_index },
    });

    // Merge full analyze response (devices list, units_detected, imageUrl, etc.)
    // with the ticket-specific fields so ResultsPage has the same shape it's
    // used to, plus the bundled ticket/resolved/lldp extras.
    const analyzeResp = buildResponse(rackId, fs.existsSync(jsonPath));
    res.json({
      ...analyzeResp,
      ticket,
      // device_index returned to the client is 1-based to match the Python
      // pipeline + ResultsPage conventions (devices[selectedIdx - 1]).
      resolved: { device_index: pipelineDeviceIdx, device_name: target.device, port: Number(target.port) },
      rackImageUrl:   `/outputs/${rackId}/${rackImageUrlPath(rackDir, '6_full_rack_selected_port.png')}`,
      resultImageUrl: `/outputs/${rackId}/${rackImageUrlPath(rackDir, '5_selected_device_with_port.png')}`,
      portInfo,
      portClassification: fullData.port_classification || null,
      lldp,
      timings,
    });
  } catch (err) {
    logger.error('[analyze-for-ticket]', err.message);
    res.status(400).json({
      error: 'Analysis failed. Please check the image and try again.',
      retryable: true,
      kind: 'quality',
    });
  }
});

/**
 * GET /api/racks
 * Tenant-scoped: returns only racks the calling user's tenant has scanned.
 * If no auth token is present, falls back to the legacy "all racks" view
 * but logged so we can see if anything still hits it that way.
 */
app.get('/api/racks', (req, res) => {
  try {
    const auth = softAuthPayload(req);
    const tid = auth?.tenantId;
    let allowed;
    if (tid) {
      allowed = tenant.tenantRackIds(tid);
    } else {
      logger.warn({ event: 'racks.unauthenticated' },
        'GET /api/racks served without auth — returning unfiltered list');
      allowed = null; // unfiltered (legacy)
    }
    const racks = fs.readdirSync(outputsDir)
      .filter(name => name.startsWith('RK-'))
      .filter(name => allowed === null || allowed.has(name))
      .map(name => {
        const meta = readMeta(name);
        return meta ? { rackId: name, timestamp: meta.timestamp } : { rackId: name };
      })
      .sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
    res.json({ racks });
  } catch (err) {
    res.json({ racks: [] });
  }
});

// ── Per-user scan history ────────────────────────────────────
// Returns the rich list of scans owned by the authenticated user, with
// device/unit counts and the timestamp of the latest port identification.
// Used by the Profile page's history list.
app.get('/api/scans', auth.requireAuth, (req, res) => {
  const userId = req.user.id;
  const tenantId = req.user.tenant_id;
  // Tenant-scoped filter: defence-in-depth. The historical filter is
  // meta.userId === current user; multi-tenancy adds: AND the rack must
  // belong to the user's tenant. So a user moved between tenants
  // (rare) keeps seeing only what their *current* tenant owns.
  const tenantRacks = tenantId ? tenant.tenantRackIds(tenantId) : null;
  try {
    const scans = fs.readdirSync(outputsDir)
      .filter(name => name.startsWith('RK-'))
      .map(rackId => {
        if (tenantRacks && !tenantRacks.has(rackId)) return null;
        const meta = readMeta(rackId);
        if (!meta || meta.userId !== userId) return null;
        const rackDir  = path.join(outputsDir, rackId);
        const mapPath  = path.join(rackDir, 'device_unit_map.json');
        let deviceCount = 0, unitCount = 0;
        try {
          if (fs.existsSync(mapPath)) {
            const data = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
            deviceCount = Array.isArray(data.devices) ? data.devices.length : 0;
            unitCount   = Array.isArray(data.units_detected) ? data.units_detected.length : 0;
          }
        } catch (_) {}
        // Latest port identification timestamp (if any) for activity sorting
        let lastPortAt = null, portCount = 0;
        const idsPath = path.join(rackDir, 'port_identifications.jsonl');
        if (fs.existsSync(idsPath)) {
          const lines = fs.readFileSync(idsPath, 'utf8').split('\n').filter(Boolean);
          portCount = lines.length;
          if (lines.length) {
            try { lastPortAt = JSON.parse(lines[lines.length - 1]).timestamp || null; } catch {}
          }
        }
        return {
          rackId,
          timestamp: meta.timestamp || null,
          deviceCount,
          unitCount,
          portCount,
          lastPortAt,
          qualityWarning: meta.qualityWarning || null,
        };
      })
      .filter(Boolean)
      .sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
    res.json({ scans });
  } catch (err) {
    logger.error('/api/scans failed:', err.message);
    res.status(500).json({ error: 'Failed to load scans' });
  }
});

// ── Report endpoints ──────────────────────────────────────────
// One source of truth (buildScanReportData), four output formats:
//   GET /api/scan/:rackId/report                 → JSON metadata (no file written)
//   GET /api/scan/:rackId/report?format=html     → standalone HTML (regenerates + saves to disk)
//   GET /api/scan/:rackId/report?format=json     → JSON data
//   GET /api/scan/:rackId/report?format=csv      → CSV (Excel opens this directly)
//   POST /api/scan/:rackId/report                → regenerates HTML file and returns metadata
// The HTML file lives at outputs/<rackId>/report.html (single self-contained file with inline images).
app.get('/api/scan/:rackId/report', (req, res) => {
  const { rackId } = req.params;
  const format = (req.query.format || 'meta').toLowerCase();
  try {
    if (format === 'html') {
      const { html } = buildScanReport(rackId);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(html);
    }
    if (format === 'json') {
      const data = buildScanReportData(rackId);
      res.setHeader('Content-Type', 'application/json');
      return res.send(renderJSONReport(data));
    }
    if (format === 'csv') {
      const data = buildScanReportData(rackId);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${rackId}_report.csv"`);
      return res.send(renderCSVReport(data));
    }
    // Default: metadata + URLs for each format
    const data = buildScanReportData(rackId);
    res.json({
      rackId,
      timestamp: data.timestamp,
      summary: {
        devices: data.devices.length,
        units: data.units_range,
        feedback_total: data.feedback.total,
        accuracy: data.feedback.accuracy,
      },
      htmlUrl: `/api/scan/${rackId}/report?format=html`,
      jsonUrl: `/api/scan/${rackId}/report?format=json`,
      csvUrl:  `/api/scan/${rackId}/report?format=csv`,
      htmlFileUrl: `/outputs/${rackId}/report.html`,
    });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.post('/api/scan/:rackId/report', (req, res) => {
  const { rackId } = req.params;
  try {
    const { reportPath, data } = buildScanReport(rackId);
    audit.log({ req, action: 'report.regen', status: 'ok', targetType: 'rack', targetId: rackId });
    res.json({
      rackId,
      reportPath,
      htmlFileUrl: `/outputs/${rackId}/report.html`,
      summary: {
        devices: data.devices.length,
        feedback_total: data.feedback.total,
        accuracy: data.feedback.accuracy,
      },
    });
  } catch (err) {
    audit.log({ req, action: 'report.regen', status: 'fail', targetType: 'rack', targetId: rackId, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/scan/:rackId/result
// Returns the canonical merged scan_result.json (schema scan_result.v1).
// If the file doesn't exist yet (e.g. older scan, or it was never refreshed),
// regenerate it on the fly so callers always get a current view.
// GET /api/cmdb/rack/:rackId/switches
// Returns { rack, switches: [{ name, serial_number, model_number, ip_address, mac_address, os_version, manufacturer, position }] }.
// Spawns servicenow/list_rack_switches.py which queries cmdb_ci_rack by
// u_racktrack_scan_id and walks Contains-relations to its switch children.
// Empty switches[] when SN env vars aren't set or the rack isn't in CMDB —
// the UI just shows "—" for serials in that case.
const _cmdbCache = new Map(); // rackId -> { at, payload }
app.get('/api/cmdb/rack/:rackId/switches', (req, res) => {
  const { rackId } = req.params;
  const cached = _cmdbCache.get(rackId);
  if (cached && Date.now() - cached.at < 60_000) {
    return res.json(cached.payload);
  }
  const scriptPath = path.join(PROJECT_ROOT, 'servicenow', 'list_rack_switches.py');
  if (!fs.existsSync(scriptPath)) {
    return res.json({ rack: null, switches: [] });
  }
  const child = spawnChild(pythonCmd, ['-u', scriptPath, rackId], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
  });
  let stdout = '', stderr = '', settled = false;
  const send = (status, body) => { if (settled) return; settled = true; res.status(status).json(body); };
  const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} send(504, { error: 'CMDB lookup timed out', switches: [] }); }, 15_000);
  child.stdout.on('data', c => { stdout += c.toString(); });
  child.stderr.on('data', c => { stderr += c.toString(); });
  child.on('close', () => {
    clearTimeout(killer);
    const lastLine = stdout.trim().split('\n').filter(Boolean).pop() || '';
    let payload = null;
    try { payload = JSON.parse(lastLine); } catch (_) {}
    if (!payload || typeof payload !== 'object') {
      return send(200, { rack: null, switches: [], error: stderr.slice(-500) || 'no JSON from script' });
    }
    _cmdbCache.set(rackId, { at: Date.now(), payload });
    send(200, payload);
  });
});

// GET /api/topology/:rackId
// Serves the topology snapshot written by servicenow/bootstrap_cmdb_full.py
// (mirror of CMDB rack→device→port tree + Connects-to cable edges).
// Snapshot lives at outputs/<rackId>/topology.json.
app.get('/api/topology/:rackId', (req, res) => {
  const { rackId } = req.params;
  const snapPath = path.join(outputsDir, rackId, 'topology.json');
  if (!fs.existsSync(snapPath)) {
    // Fire-and-forget: try to (re)generate the snapshot in the background so a
    // refresh in a few seconds returns the real topology.
    try { scheduleTopologyRegen(rackId); } catch (_) {}
    return res.status(404).json({ error: 'pending' });
  }
  try {
    res.setHeader('Content-Type', 'application/json');
    res.send(fs.readFileSync(snapPath, 'utf8'));
  } catch (err) {
    res.status(500).json({ error: 'Failed to read topology snapshot', details: err.message });
  }
});

// GET /api/scan/:rackId
// Returns the same shape as POST /api/analyze (cached) — devices array with
// per-port arrays, units_detected, originalExt, etc. The All Components and
// Topology pages call this on mount so port counts stay in sync with the
// underlying device_unit_map.json after re-detection runs.
app.get('/api/scan/:rackId', (req, res) => {
  const { rackId } = req.params;
  const rackDir = path.join(outputsDir, rackId);
  const jsonPath = path.join(rackDir, 'device_unit_map.json');
  if (!fs.existsSync(jsonPath)) {
    return res.status(404).json({ error: `Rack ${rackId} not found` });
  }
  try {
    res.json(buildResponse(rackId, true));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/scan/:rackId/result', (req, res) => {
  const { rackId } = req.params;
  const rackDir = path.join(outputsDir, rackId);
  if (!fs.existsSync(rackDir)) {
    return res.status(404).json({ error: `Rack ${rackId} not found` });
  }
  const resultPath = path.join(rackDir, 'scan_result.json');
  try {
    if (!fs.existsSync(resultPath)) {
      const result = writeCanonicalScanResult(rackId);
      if (!result) return res.status(500).json({ error: 'Failed to build scan_result.json' });
      return res.json(result);
    }
    res.setHeader('Content-Type', 'application/json');
    res.send(fs.readFileSync(resultPath, 'utf8'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Switch LLDP neighbor lookup ───────────────────────────────
// SSH into a Cisco-IOS-style switch, run
//   show lldp neighbors <interface> detail
// and parse the output for the neighbor on the other end of the cable.
// Credentials come per-request — never stored on the server.
const { Client: SSHClient } = require('ssh2');

function runSwitchCommand({ host, port = 22, username, password, command, timeoutMs = 20000, pagingOff = 'terminal length 0', enable = null, enablePassword = null }) {
  return new Promise((resolve, reject) => {
    const conn = new SSHClient();
    let resolved = false;
    const finish = (err, data) => {
      if (resolved) return;
      resolved = true;
      try { conn.end(); } catch (_) {}
      clearTimeout(killer);
      err ? reject(err) : resolve(data);
    };
    const killer = setTimeout(() => finish(new Error(`SSH/command timed out after ${timeoutMs}ms`)), timeoutMs);

    // Shell prompts vary by vendor: `Switch>`, `Switch#`, `TL-SG2428P>`, `rtr(config)#`, etc.
    // We match `>` / `#` at end-of-buffer after optional whitespace/ANSI escapes.
    const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
    const PROMPT_RE   = /[>#]\s*$/;
    const PASSWD_RE   = /password\s*:\s*$/i;
    const PROMPT_OR_PASSWD_RE = /(?:password\s*:\s*$)|(?:[>#]\s*$)/i;

    conn
      .on('keyboard-interactive', (_name, _instructions, _lang, _prompts, cb) => {
        // Many switches (notably TP-Link and some D-Link) only accept
        // keyboard-interactive auth, not the default `password` method.
        cb(_prompts.map(() => password));
      })
      .on('ready', () => {
        conn.shell({ term: 'vt100' }, (err, stream) => {
          if (err) return finish(err);

          let buf = '';
          let pagedAt = -1;
          const PAGING_RE = /Press any key to continue|--More--|<--- More --->/i;
          const waiters = []; // { re, resolve, timer }
          const checkWaiters = () => {
            const clean = stripAnsi(buf);
            for (let i = waiters.length - 1; i >= 0; i--) {
              const w = waiters[i];
              if (w.re.test(clean)) {
                clearTimeout(w.timer);
                waiters.splice(i, 1);
                w.resolve(buf);
              }
            }
          };
          stream
            .on('data', (chunk) => {
              buf += chunk.toString();
              // Auto-advance past --More-- pagination prompts.
              // Search from after the last acknowledged prompt so we detect
              // subsequent pages (buf.match() only returns the first hit).
              const searchFrom = pagedAt < 0 ? 0 : pagedAt + 1;
              if (searchFrom < buf.length) {
                const tail = buf.slice(searchFrom);
                const m = tail.match(PAGING_RE);
                if (m) {
                  pagedAt = searchFrom + m.index;
                  try { stream.write(' '); } catch (_) {}
                }
              }
              checkWaiters();
            })
            .on('close', () => finish(null, buf))
            .stderr.on('data', (chunk) => { buf += chunk.toString(); checkWaiters(); });
          stream.setEncoding('utf8');

          const waitFor = (re, timeout = 4000) => new Promise((res) => {
            if (re.test(stripAnsi(buf))) return res(buf);
            const w = { re, resolve: res };
            w.timer = setTimeout(() => {
              const idx = waiters.indexOf(w);
              if (idx >= 0) waiters.splice(idx, 1);
              res(buf); // resolve with whatever we have; caller decides
            }, timeout);
            waiters.push(w);
          });
          // Reset buffer so subsequent waitFor() only sees new output.
          const resetBuf = () => { buf = ''; pagedAt = -1; };

          (async () => {
            try {
              await waitFor(PROMPT_RE, 5000); // initial banner + prompt

              if (enable) {
                resetBuf();
                stream.write(`${enable}\r\n`);
                await waitFor(PROMPT_OR_PASSWD_RE, 4000);
                if (PASSWD_RE.test(stripAnsi(buf))) {
                  resetBuf();
                  stream.write(`${enablePassword || ''}\r\n`);
                  await waitFor(PROMPT_RE, 4000);
                }
              }

              if (pagingOff) {
                resetBuf();
                stream.write(`${pagingOff}\r\n`);
                await waitFor(PROMPT_RE, 3000);
              }

              resetBuf();
              stream.write(`${command}\r\n`);
              await waitFor(PROMPT_RE, timeoutMs - 3000);
              const output = buf;

              try { stream.end('exit\r\n'); } catch (_) {}
              finish(null, output);
            } catch (e) {
              finish(null, buf);
            }
          })();
        });
      })
      .on('error', finish)
      .connect({
        host, port, username, password,
        tryKeyboard: true, // fall back to keyboard-interactive if password auth fails
        readyTimeout: timeoutMs,
        // Legacy-friendly algorithm set. Only include names that node's `ssh2`
        // library actually supports — passing unknown strings throws
        // "Unsupported algorithm: <name>" even if the switch asks for them.
        algorithms: {
          kex: [
            'curve25519-sha256', 'curve25519-sha256@libssh.org',
            'ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'ecdh-sha2-nistp521',
            'diffie-hellman-group-exchange-sha256',
            'diffie-hellman-group16-sha512', 'diffie-hellman-group18-sha512',
            'diffie-hellman-group14-sha256', 'diffie-hellman-group14-sha1',
            'diffie-hellman-group-exchange-sha1',
            'diffie-hellman-group1-sha1',
          ],
          cipher: [
            'chacha20-poly1305@openssh.com',
            'aes128-gcm@openssh.com', 'aes256-gcm@openssh.com',
            'aes128-ctr', 'aes192-ctr', 'aes256-ctr',
            'aes128-cbc', 'aes192-cbc', 'aes256-cbc',
            '3des-cbc',
          ],
          serverHostKey: [
            'ssh-ed25519',
            'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521',
            'rsa-sha2-512', 'rsa-sha2-256',
            'ssh-rsa',
            'ssh-dss',
          ],
          hmac: [
            'hmac-sha2-256-etm@openssh.com', 'hmac-sha2-512-etm@openssh.com',
            'hmac-sha2-256', 'hmac-sha2-512',
            'hmac-sha1', 'hmac-sha1-96',
          ],
        },
      });
  });
}

// Run a list of commands over ONE persistent SSH shell. This is the path the
// streaming /run-auto-stream endpoint uses: opening a fresh session per command
// was causing the switch to throttle rapid reconnects, hanging after the first
// command. Using one shell makes every command ~instant after the first login.
//
// onEntry(i, entry) is invoked after each command completes (or fails).
// Returns a promise that resolves once every command has been attempted.
function runSwitchCommandsSequential({
  host, port = 22, username, password,
  commands,                      // [{ name, cmd }]
  onEntry,                       // (index, entry) => void
  timeoutMsPerCmd = 20000,
  pagingOff = 'terminal length 0',
  enable = null,
  enablePassword = null,
  isCancelled = () => false,
}) {
  return new Promise((resolve, reject) => {
    const conn = new SSHClient();
    let settled = false;
    const settle = (err) => {
      if (settled) return;
      settled = true;
      try { conn.end(); } catch (_) {}
      err ? reject(err) : resolve();
    };

    const overallTimeoutMs = (commands.length + 2) * timeoutMsPerCmd + 30000;
    const overallTimer = setTimeout(
      () => settle(new Error(`SSH session timed out after ${overallTimeoutMs}ms`)),
      overallTimeoutMs,
    );

    conn
      .on('keyboard-interactive', (_name, _instr, _lang, prompts, cb) => {
        cb(prompts.map(() => password));
      })
      .on('error', (err) => { clearTimeout(overallTimer); settle(err); })
      .on('ready', () => {
        conn.shell({ term: 'vt100' }, (err, stream) => {
          if (err) { clearTimeout(overallTimer); return settle(err); }

          const stripAnsi = (s) => s
            .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
            .replace(/\x1b\][^\x07]*\x07/g, '');
          const PROMPT_RE   = /[>#]\s*$/;
          const PASSWD_RE   = /password\s*:\s*$/i;
          const PROMPT_OR_PASSWD_RE = /(?:password\s*:\s*$)|(?:[>#]\s*$)/i;
          // Some switches page output even with `terminal length 0`; auto-advance.
          const PAGING_RE   = /Press any key to continue|--More--|<--- More --->/i;

          let buf = '';
          let pagedAt = -1;
          const resetBuf = () => { buf = ''; pagedAt = -1; };

          stream.setEncoding('utf8');
          stream.on('data', (chunk) => {
            buf += chunk;
            const m = buf.match(PAGING_RE);
            if (m && m.index > pagedAt) {
              pagedAt = m.index;
              try { stream.write(' '); } catch (_) {}
            }
          });
          stream.stderr.on('data', (chunk) => { buf += chunk; });
          stream.on('close', () => { /* handled by settle */ });

          const waitFor = (re, timeout) => new Promise((res) => {
            const t0 = Date.now();
            const tick = () => {
              if (re.test(stripAnsi(buf))) return res(true);
              if (Date.now() - t0 > timeout) return res(false);
              setTimeout(tick, 50);
            };
            tick();
          });

          (async () => {
            try {
              await waitFor(PROMPT_RE, 5000);

              if (enable) {
                resetBuf();
                stream.write(`${enable}\r\n`);
                await waitFor(PROMPT_OR_PASSWD_RE, 4000);
                if (PASSWD_RE.test(stripAnsi(buf))) {
                  resetBuf();
                  stream.write(`${enablePassword || ''}\r\n`);
                  await waitFor(PROMPT_RE, 4000);
                }
              }

              if (pagingOff) {
                resetBuf();
                stream.write(`${pagingOff}\r\n`);
                await waitFor(PROMPT_RE, 3000);
              }

              for (let i = 0; i < commands.length; i++) {
                if (isCancelled()) break;
                const { name, cmd } = commands[i];
                const startedAt = new Date().toISOString();
                let entry;
                try {
                  resetBuf();
                  stream.write(`${cmd}\r\n`);
                  await waitFor(PROMPT_RE, timeoutMsPerCmd);
                  entry = {
                    name, cmd,
                    output: cleanShellOutput(buf, cmd),
                    error: null, startedAt, source: 'auto',
                  };
                } catch (e) {
                  entry = { name, cmd, output: '', error: e.message, startedAt, source: 'auto' };
                }
                try { onEntry(i, entry); } catch (_) {}
              }

              try { stream.end('exit\r\n'); } catch (_) {}
              clearTimeout(overallTimer);
              settle(null);
            } catch (e) {
              clearTimeout(overallTimer);
              settle(e);
            }
          })();
        });
      })
      .connect({
        host, port, username, password,
        tryKeyboard: true,
        readyTimeout: 15000,
        algorithms: {
          kex: [
            'curve25519-sha256', 'curve25519-sha256@libssh.org',
            'ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'ecdh-sha2-nistp521',
            'diffie-hellman-group-exchange-sha256',
            'diffie-hellman-group16-sha512', 'diffie-hellman-group18-sha512',
            'diffie-hellman-group14-sha256', 'diffie-hellman-group14-sha1',
            'diffie-hellman-group-exchange-sha1',
            'diffie-hellman-group1-sha1',
          ],
          cipher: [
            'chacha20-poly1305@openssh.com',
            'aes128-gcm@openssh.com', 'aes256-gcm@openssh.com',
            'aes128-ctr', 'aes192-ctr', 'aes256-ctr',
            'aes128-cbc', 'aes192-cbc', 'aes256-cbc',
            '3des-cbc',
          ],
          serverHostKey: [
            'ssh-ed25519',
            'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521',
            'rsa-sha2-512', 'rsa-sha2-256',
            'ssh-rsa',
            'ssh-dss',
          ],
          hmac: [
            'hmac-sha2-256-etm@openssh.com', 'hmac-sha2-512-etm@openssh.com',
            'hmac-sha2-256', 'hmac-sha2-512',
            'hmac-sha1', 'hmac-sha1-96',
          ],
        },
      });
  });
}

// ── Vendor configuration ──────────────────────────────────────
// Each vendor defines the CLI commands it speaks for LLDP / CDP / MAC / ARP,
// the paging-off command to disable "--More--" prompts, and how a port
// number maps to an interface name in its CLI.
const VENDORS = {
  'cisco-ios': {
    label: 'Cisco IOS',
    paging_off: 'terminal length 0',
    commands: {
      lldp:      'show lldp neighbors {iface} detail',
      cdp:       'show cdp neighbors {iface} detail',
      mac_table: 'show mac address-table interface {iface}',
      arp:       'show arp | include {mac}',
    },
    // The console's auto-command list is sourced from console_commands.json
    // (per-vendor section). Edit that file to change commands — no code edit needed.
    derive_interface: (p) => `Gi1/0/${p}`,
  },
  'dlink': {
    label: 'D-Link',
    paging_off: 'disable clipaging',
    commands: {
      lldp:      'show lldp remote_ports {iface}',
      cdp:       null, // D-Link does not speak CDP
      mac_table: 'show fdb port {iface}',
      arp:       'show arpentry',
    },
    derive_interface: (p) => String(p),
  },
  'tplink': {
    label: 'TP-Link',
    // TP-Link JetStream `show lldp neighbor-information` etc. require
    // privileged (enable) mode — user-mode prompt `>` rejects them.
    enable: 'enable',
    paging_off: 'disable pager',
    commands: {
      // TP-Link JetStream uses `gigabitEthernet` as the port-type keyword.
      // `ethernet 1/0/24` errors with "Invalid parameter" / "Too many parameters".
      lldp:      'show lldp neighbor-information interface gigabitEthernet {iface}',
      cdp:       null, // TP-Link does not speak CDP
      mac_table: 'show mac address-table interface gigabitEthernet {iface}',
      arp:       'show ip arp',
    },
    derive_interface: (p) => `1/0/${p}`,
  },
};

// ── Vendor-agnostic "loose" parsers ───────────────────────────
// These extract common fields (system name, port id, MAC, IP, VLAN, etc.)
// from LLDP/CDP output across Cisco, D-Link, TP-Link, Aruba, Juniper, etc.
// They trade precision for breadth — good enough for reporting a neighbor.
function parseLooseNeighbor(raw) {
  const text = (raw || '').replace(/\r/g, '');
  const pick = (re) => { const m = text.match(re); return m ? m[1].trim() : null; };
  const result = {
    system_name:        pick(/(?:^|\n)\s*(?:System Name|Device ID|Remote System Name|SysName|System name|Neighbor name)\s*[:=]\s*([^\n]+)/i),
    port_id:            pick(/(?:^|\n)\s*(?:Port ID|Remote Port|Port id|Port Identifier|Neighbor port|PortID)\s*[:=]\s*([^\n]+)/i),
    port_description:   pick(/(?:^|\n)\s*(?:Port Description|Port Desc|Remote Port Description)\s*[:=]\s*([^\n]+)/i),
    chassis_id:         pick(/(?:^|\n)\s*(?:Chassis ID|Chassis Identifier|Chassis Id|Neighbor chassis)\s*[:=]\s*([^\n]+)/i),
    system_description: pick(/(?:System Description|Version|Remote System Description)\s*[:=]\s*([\s\S]*?)(?:\n\s*\n|\n[A-Z][^:\n]{0,40}:)/i),
    management_address: pick(/(?:Management Address|Management IP|Management Addresses?|Mgmt IP|Address)\s*[:=]?[^\n]{0,80}?\b((?:\d{1,3}\.){3}\d{1,3})\b/i),
    vlan_id:            pick(/(?:Vlan ID|VLAN|Native VLAN|Port VLAN ID|PVID)\s*[:=]\s*(\d+)/i),
    capabilities:       pick(/(?:System Capabilities|Capabilities|Enabled Capabilities)\s*[:=]\s*([^\n]+)/i),
  };
  const noData = /no (?:lldp|cdp) neighbors|no entries|no entry|not found/i.test(text);
  const found = !noData && !!(result.system_name || result.port_id || result.management_address || result.chassis_id);
  return { found, ...result };
}

// Per-port console log path, so the report can pick it up later.
// New layout: <rack>/console/d{idx}_p{port}.json
// Falls back to the legacy flat path if the file already exists there.
function consoleLogPath(rackDir, deviceIndex, port) {
  const dir = path.join(rackDir, 'console');
  fs.mkdirSync(dir, { recursive: true });
  const newPath = path.join(dir, `d${deviceIndex}_p${port}.json`);
  const legacy  = path.join(rackDir, `port_console_d${deviceIndex}_p${port}.json`);
  if (!fs.existsSync(newPath) && fs.existsSync(legacy)) return legacy;
  return newPath;
}

// Resolve a pipeline image filename to a real path inside the rack.
// Prefers the new images/ subfolder, falls back to legacy flat layout.
function rackImagePath(rackDir, fname) {
  const inSub = path.join(rackDir, 'images', fname);
  if (fs.existsSync(inSub)) return inSub;
  return path.join(rackDir, fname); // legacy
}
// Same idea but returns the URL-relative path that the client uses to
// fetch the file via /outputs/<rackId>/...
function rackImageUrlPath(rackDir, fname) {
  return fs.existsSync(path.join(rackDir, 'images', fname)) ? `images/${fname}` : fname;
}
// Per-port artifacts (5/6 PNG copies) — new layout: <rack>/ports/<base>.png
function rackPortPath(rackDir, baseName) {
  const dir = path.join(rackDir, 'ports');
  fs.mkdirSync(dir, { recursive: true });
  const newPath = path.join(dir, baseName);
  const legacy  = path.join(rackDir, `port_${baseName}`);
  if (!fs.existsSync(newPath) && fs.existsSync(legacy)) return legacy;
  return newPath;
}
function rackPortRelative(rackDir, baseName) {
  // What we store in the JSONL log so the report can find the file later.
  // Always returns the new-layout name; reading code resolves either path.
  return path.join('ports', baseName).replace(/\\/g, '/');
}
function resolveRelativeArtifact(rackDir, rel) {
  // For values stored in port_identifications.jsonl that may be old-style
  // ("port_d1_p2_device.png") or new-style ("ports/d1_p2_device.png").
  if (!rel) return null;
  const direct = path.join(rackDir, rel);
  if (fs.existsSync(direct)) return direct;
  // Try interpreting as a legacy basename
  const legacy = path.join(rackDir, rel.replace(/^ports\//, 'port_'));
  if (fs.existsSync(legacy)) return legacy;
  return direct; // let caller see the missing file
}

// Read console_commands.json and return the auto-command list for the given
// vendor. Falls back to the top-level `auto_commands` list if the vendor has
// no section — keeps legacy installs working.
function loadConsoleCommandsForVendor(vendor) {
  const raw = loadConsoleCommands();
  const vlist = raw?.vendors?.[vendor]?.auto_commands;
  if (Array.isArray(vlist) && vlist.length) return vlist;
  return raw?.auto_commands || [];
}

// Returns the user-facing intent list for a vendor (label + cmd template).
function loadConsoleIntentsForVendor(vendor) {
  const raw = loadConsoleCommands();
  const list = raw?.vendors?.[vendor]?.intents;
  return Array.isArray(list) ? list : [];
}

function loadConsoleCommands() {
  const p = path.join(__dirname, 'console_commands.json');
  if (!fs.existsSync(p)) return { auto_commands: [] };
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { logger.error('console_commands.json parse error:', e.message); return { auto_commands: [] }; }
}

function substIface(cmd, iface) {
  return String(cmd || '').replace(/\{iface\}/g, iface);
}

// Persist the current console transcript for a (scanId, device_index, port) tuple.
function saveConsoleTranscript({ scanId, device_index, port, interface: iface, host, entries }) {
  if (!scanId) return null;
  const rackDir = path.join(outputsDir, scanId);
  if (!fs.existsSync(rackDir)) return null;
  const filePath = consoleLogPath(rackDir, device_index, port);
  const payload = {
    scanId,
    device_index: Number(device_index),
    port: Number(port),
    interface: iface,
    host,
    updated_at: new Date().toISOString(),
    entries,
  };
  try { fs.writeFileSync(filePath, JSON.stringify(payload, null, 2)); return filePath; }
  catch (e) { logger.error('console transcript save failed:', e.message); return null; }
}

function readConsoleTranscript(rackDir, deviceIndex, port) {
  const p = consoleLogPath(rackDir, deviceIndex, port);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// Strip the command echo, paging prompts, and trailing shell prompts from output.
function cleanShellOutput(raw, cmd) {
  if (!raw) return '';
  let out = raw.replace(/\r/g, '');
  // remove null bytes left by some TP-Link firmware after paging prompts
  out = out.replace(/\x00/g, '');
  // strip paging prompts: "Press any key to continue (Q to quit)", "--More--", etc.
  // These leave the data after them on the same line, so replace with newline.
  out = out.replace(/Press any key to continue[^\n]*/gi, '\n');
  out = out.replace(/--More--[^\n]*/g, '\n');
  out = out.replace(/<--- More --->[^\n]*/g, '\n');
  // remove the first occurrence of the command (which the switch echoed back)
  if (cmd) {
    const idx = out.indexOf(cmd);
    if (idx >= 0) out = out.slice(idx + cmd.length);
  }
  // drop any trailing lines that look like a shell prompt (`hostname#` or `hostname>`)
  const lines = out.split('\n');
  while (lines.length && /^[A-Za-z0-9._-]+[>#]\s*$/.test(lines[lines.length - 1].trim())) lines.pop();
  return lines.join('\n').trim();
}

// GET /api/switch/console/intents?vendor=cisco-ios
// Returns the user-facing dropdown list for the console (intent id + English
// label + command template). Used by the client to populate the picker.
app.get('/api/switch/console/intents', (req, res) => {
  const vendor = String(req.query.vendor || 'cisco-ios');
  res.json({ vendor, intents: loadConsoleIntentsForVendor(vendor) });
});

// GET /api/switch/creds-status?vendor=X
// Booleans only — never returns the actual secret values. Lets the client
// know whether the encrypted env store already has username / password /
// enable for this vendor, so the login modal can hide those fields and ask
// the user for only the switch IP.
app.get('/api/switch/creds-status', (req, res) => {
  const vendor = String(req.query.vendor || 'cisco-ios');
  const v = sshCreds.getForVendor(vendor) || {};
  res.json({
    vendor,
    has_username: !!(v.username && String(v.username).length),
    has_password: !!(v.password && String(v.password).length),
    has_enable:   !!(v.enablePassword && String(v.enablePassword).length),
  });
});

// GET /api/switch/default-host
// Suggests a switch IP without asking the user. Two sources, in order:
//   1. The current user's last successful SSH host (kept in scan_meta of the
//      most recent scan they own — small read, no extra storage).
//   2. The server machine's default gateway (on most LANs the gateway IS
//      the switch, or one hop away). Best-effort, may be null.
// Always responds with JSON; missing values come back as null instead of
// errors so the client can prefill what it has.
const { execSync } = require('child_process');
function detectDefaultGateway() {
  try {
    if (process.platform === 'win32') {
      const out = execSync('route print 0.0.0.0', { timeout: 2000 }).toString();
      // Match the IPv4 default route line: "0.0.0.0  0.0.0.0  <gateway>  ..."
      const m = out.match(/^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\d+\.\d+\.\d+\.\d+)/m);
      return m ? m[1] : null;
    }
    // Linux / macOS
    const out = execSync("ip route show default 2>/dev/null || route -n get default 2>/dev/null", { timeout: 2000, shell: '/bin/sh' }).toString();
    const m = out.match(/(?:default via|gateway:)\s+(\d+\.\d+\.\d+\.\d+)/);
    return m ? m[1] : null;
  } catch { return null; }
}
let _gatewayCache = null;
let _gatewayCachedAt = 0;
function defaultGateway() {
  // Cache for 60s — gateway rarely changes and shelling out per-request is wasteful.
  const now = Date.now();
  if (_gatewayCache !== null && (now - _gatewayCachedAt) < 60_000) return _gatewayCache;
  _gatewayCache = detectDefaultGateway();
  _gatewayCachedAt = now;
  return _gatewayCache;
}

// Path of a per-user "last host" file — keyed by userId so each account
// keeps its own most-recent switch IP separately.
const lastHostDir = path.join(__dirname, 'data', 'last-hosts');
function readLastHost(userId) {
  if (!userId) return null;
  try {
    const p = path.join(lastHostDir, `${userId}.txt`);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() || null : null;
  } catch { return null; }
}
function writeLastHost(userId, host) {
  if (!userId || !host) return;
  try {
    fs.mkdirSync(lastHostDir, { recursive: true });
    fs.writeFileSync(path.join(lastHostDir, `${userId}.txt`), String(host).trim());
  } catch (err) { logger.error('[last-host] write failed:', err.message); }
}

app.get('/api/switch/default-host', (req, res) => {
  const userId = softAuthUserId(req);
  const last    = readLastHost(userId);
  const gateway = defaultGateway();
  // Suggested = last (preferred) → gateway (fallback). Either may be null.
  res.json({
    suggested: last || gateway || null,
    last_host: last,
    gateway,
  });
});

// POST /api/switch/console/run-auto
// Body: { host, username, password, interface, scanId?, device_index?, port? }
// Runs every configured auto-command, one SSH session per command, returns full list.
// If scanId/device_index/port provided, persists transcript for the report.
app.post('/api/switch/console/run-auto', async (req, res) => {
  const { host, sshPort, interface: iface, vendor,
          scanId, device_index, port } = req.body || {};
  const { username, password, enablePassword } = resolveSwitchCreds(req.body || {});
  if (!host || !username || !password || !iface) {
    return res.status(400).json({ error: 'host, interface, and credentials (body or env) required' });
  }
  const vconf = VENDORS[vendor] || VENDORS['cisco-ios'];
  // Vendor-specific auto-commands override the JSON file. The file is still
  // used as the default for vendors without a bundled list (e.g. cisco-ios).
  const autoCommands = loadConsoleCommandsForVendor(vendor || 'cisco-ios');
  const entries = [];
  for (const item of autoCommands) {
    const cmd = substIface(item.cmd, iface);
    const startedAt = new Date().toISOString();
    try {
      const raw = await runSwitchCommand({ host, port: sshPort, username, password, command: cmd, pagingOff: vconf.paging_off, enable: vconf.enable, enablePassword });
      entries.push({ name: item.name, cmd, output: cleanShellOutput(raw, cmd), error: null, startedAt, source: 'auto' });
    } catch (err) {
      entries.push({ name: item.name, cmd, output: '', error: err.message, startedAt, source: 'auto' });
    }
  }
  const saved = saveConsoleTranscript({ scanId, device_index, port, interface: iface, host, entries });
  audit.log({ req, action: 'console.run_auto', status: 'ok',
              targetType: scanId ? 'rack' : null, targetId: scanId || null,
              payload: { host, interface: iface, vendor: vendor || 'cisco-ios', cmd_count: entries.length, transcript_saved: Boolean(saved) } });
  if (saved && scanId) scheduleCanonicalRefresh(scanId);
  res.json({ ok: true, host, interface: iface, vendor: vendor || 'cisco-ios', entries, transcript_saved: Boolean(saved) });
});

// POST /api/switch/console/run-auto-stream
// Same body as run-auto, but streams each command's result as an SSE frame so
// the client can render one command at a time as it completes.
// Frames:
//   { type: 'plan',    total, commands:[{i,name,cmd}] }
//   { type: 'running', i, name, cmd, startedAt }
//   { type: 'entry',   i, entry }
//   { type: 'done',    total, transcript_saved }
//   { type: 'error',   error }
app.post('/api/switch/console/run-auto-stream', async (req, res) => {
  const { host, sshPort, interface: iface, vendor,
          scanId, device_index, port } = req.body || {};
  const { username, password, enablePassword } = resolveSwitchCreds(req.body || {});
  if (!host || !username || !password || !iface) {
    return res.status(400).json({ error: 'host, interface, and credentials (body or env) required' });
  }
  const vconf = VENDORS[vendor] || VENDORS['cisco-ios'];
  const autoCommands = loadConsoleCommandsForVendor(vendor || 'cisco-ios');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const send = (payload) => {
    try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch (_) { /* socket gone */ }
  };
  const heartbeat = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch (_) {}
  }, 10000);
  // If the client closes early we just let the SSH run to completion; subsequent
  // res.write() calls fall through the try/catch in send() without crashing.

  // Pre-substitute {iface} so both the plan frame and the SSH shell use the
  // exact same command strings.
  const plannedCommands = autoCommands.map(c => ({ name: c.name, cmd: substIface(c.cmd, iface) }));

  try {
    send({
      type: 'plan',
      total: plannedCommands.length,
      commands: plannedCommands.map((c, i) => ({ i, name: c.name, cmd: c.cmd })),
    });

    const entries = [];
    // Announce which command is about to run just before it actually starts
    // on the shared shell.
    let nextAnnounceIdx = 0;
    const announce = (upTo) => {
      while (nextAnnounceIdx <= upTo && nextAnnounceIdx < plannedCommands.length) {
        const c = plannedCommands[nextAnnounceIdx];
        send({ type: 'running', i: nextAnnounceIdx, name: c.name, cmd: c.cmd, startedAt: new Date().toISOString() });
        nextAnnounceIdx++;
      }
    };
    // Announce the very first command immediately so the UI shows activity
    // while we're still negotiating SSH.
    announce(0);

    await runSwitchCommandsSequential({
      host, port: sshPort, username, password,
      commands: plannedCommands,
      pagingOff: vconf.paging_off,
      enable: vconf.enable,
      enablePassword,
      // Don't short-circuit on `cancelled` — earlier attempts did this and a
      // false-positive close signal on some Node versions aborted the loop
      // before ANY command ran, leaving the UI with an empty terminal.
      isCancelled: () => false,
      timeoutMsPerCmd: 20000,
      onEntry: (i, entry) => {
        entries.push(entry);
        send({ type: 'entry', i, entry });
        // Announce the NEXT command so the client shows the running indicator
        // the moment the previous one finished, not only when it starts writing.
        if (i + 1 < plannedCommands.length) announce(i + 1);
      },
    });

    const saved = saveConsoleTranscript({ scanId, device_index, port, interface: iface, host, entries });
    audit.log({ req, action: 'console.run_auto_stream', status: 'ok',
                targetType: scanId ? 'rack' : null, targetId: scanId || null,
                payload: { host, interface: iface, vendor: vendor || 'cisco-ios', cmd_count: entries.length, transcript_saved: Boolean(saved) } });
    if (saved && scanId) scheduleCanonicalRefresh(scanId);
    send({ type: 'done', total: entries.length, transcript_saved: Boolean(saved) });
  } catch (err) {
    logger.error('[console stream] failed:', err && err.stack ? err.stack : err);
    audit.log({ req, action: 'console.run_auto_stream', status: 'fail',
                targetType: scanId ? 'rack' : null, targetId: scanId || null,
                error: (err && err.message) || String(err),
                payload: { host, interface: iface } });
    try { send({ type: 'error', error: (err && err.message) || String(err) || 'Stream error' }); } catch (_) {}
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

// POST /api/switch/console/run
// Body: { host, username, password, command, scanId?, device_index?, port?, interface? }
// Runs a single manual command and (optionally) appends to the persisted transcript.
app.post('/api/switch/console/run', async (req, res) => {
  const { host, sshPort, command, vendor,
          scanId, device_index, port, interface: iface, timeoutMs: bodyTimeoutMs } = req.body || {};
  const { username, password, enablePassword } = resolveSwitchCreds(req.body || {});
  if (!host || !username || !password || !command) {
    return res.status(400).json({ error: 'host, command, and credentials (body or env) required' });
  }
  // Substitute the {iface} placeholder if the caller passed an interface.
  // Intent-driven commands carry placeholders like
  // `show lldp neighbor-information interface gigabitEthernet {iface}` and
  // would otherwise be sent literally to the switch.
  const cmd = iface ? substIface(command, iface) : command;
  const vconf = VENDORS[vendor] || VENDORS['cisco-ios'];
  // Allow the client to extend the SSH/command timeout for slow commands
  // (e.g. `show interface status` on a 48-port TP-Link). Capped at 90s and
  // floored at 5s; falls back to runSwitchCommand's own default when omitted.
  let timeoutMs;
  if (bodyTimeoutMs != null) {
    const n = Number(bodyTimeoutMs);
    if (Number.isFinite(n)) timeoutMs = Math.max(5000, Math.min(90000, Math.floor(n)));
  }
  const startedAt = new Date().toISOString();
  let entry;
  try {
    const raw = await runSwitchCommand({ host, port: sshPort, username, password, command: cmd, pagingOff: vconf.paging_off, enable: vconf.enable, enablePassword, ...(timeoutMs ? { timeoutMs } : {}) });
    entry = { name: 'Manual', cmd, output: cleanShellOutput(raw, cmd), error: null, startedAt, source: 'manual' };
    writeLastHost(softAuthUserId(req), host);
  } catch (err) {
    entry = { name: 'Manual', cmd, output: '', error: err.message, startedAt, source: 'manual' };
  }

  // Append to persisted transcript if the scan context is known.
  if (scanId && device_index != null && port != null) {
    const rackDir = path.join(outputsDir, scanId);
    const existing = readConsoleTranscript(rackDir, device_index, port);
    const entries = existing?.entries ? [...existing.entries, entry] : [entry];
    saveConsoleTranscript({ scanId, device_index, port, interface: iface || existing?.interface, host, entries });
    scheduleCanonicalRefresh(scanId);
  }

  audit.log({ req, action: 'console.run_manual',
              status: entry.error ? 'fail' : 'ok',
              targetType: scanId ? 'rack' : null, targetId: scanId || null,
              error: entry.error || null,
              payload: { host, interface: iface || null, command: cmd } });
  res.json({ ok: true, entry });
});

// Extract first MAC address (and VLAN if on same line) from any vendor's MAC-table output.
// Accepts MACs in `aabb.ccdd.eeff`, `aa:bb:cc:dd:ee:ff`, or `aa-bb-cc-dd-ee-ff` formats.
function parseLooseMacTable(raw) {
  const text = (raw || '').replace(/\r/g, '');
  const lines = text.split('\n');
  const macRe = /\b([0-9a-fA-F]{4}\.[0-9a-fA-F]{4}\.[0-9a-fA-F]{4}|(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2})\b/;
  for (const line of lines) {
    const m = line.match(macRe);
    if (!m) continue;
    // Skip obviously-non-data lines
    if (/^---|={3,}|no mac/i.test(line.trim())) continue;
    const vlanM = line.match(/^\s*(\d+)\b/);
    return { found: true, mac: m[1].toLowerCase(), vlan: vlanM ? vlanM[1] : null };
  }
  return { found: false };
}

// Find a line containing the remote MAC (in any format) and extract an IP from it.
function parseLooseArp(raw, macNormalized) {
  const text = (raw || '').replace(/\r/g, '');
  const variants = macFormatVariants(macNormalized);
  for (const line of text.split('\n')) {
    const low = line.toLowerCase();
    if (variants.some(v => low.includes(v))) {
      const ip = line.match(/\b((?:\d{1,3}\.){3}\d{1,3})\b/);
      if (ip) return { found: true, ip: ip[1], raw: line.trim() };
    }
  }
  return { found: false };
}

// Return every common textual representation of a MAC so parsers match regardless
// of separator style used by the vendor's ARP output.
function macFormatVariants(mac) {
  const hex = String(mac || '').replace(/[:.-]/g, '').toLowerCase();
  if (hex.length !== 12) return [String(mac || '').toLowerCase()];
  return [
    hex,
    `${hex.slice(0,4)}.${hex.slice(4,8)}.${hex.slice(8,12)}`,
    `${hex.slice(0,2)}:${hex.slice(2,4)}:${hex.slice(4,6)}:${hex.slice(6,8)}:${hex.slice(8,10)}:${hex.slice(10,12)}`,
    `${hex.slice(0,2)}-${hex.slice(2,4)}-${hex.slice(4,6)}-${hex.slice(6,8)}-${hex.slice(8,10)}-${hex.slice(10,12)}`,
  ];
}

async function reverseDnsLookup(ip) {
  return new Promise((resolve) => {
    require('dns').reverse(ip, (err, names) => {
      resolve(err ? null : (names && names[0]) || null);
    });
  });
}

// Runs the full fallback chain using the vendor's CLI and loose parsers, returning
// the first useful result along with a log of every method tried.
async function findNeighborChain({ host, port, username, password, enablePassword, iface, vendor = 'cisco-ios' }) {
  const vconf = VENDORS[vendor] || VENDORS['cisco-ios'];
  const chain = [];
  const cred = { host, port, username, password, pagingOff: vconf.paging_off, enable: vconf.enable, enablePassword };
  const subst = (cmd, extra = {}) => {
    let s = String(cmd).replace(/\{iface\}/g, iface);
    for (const [k, v] of Object.entries(extra)) s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
    return s;
  };

  // Truncate raw shell output so the response stays small but the UI can still diagnose.
  const tail = (s) => (s || '').slice(-1200);

  // 1. LLDP — supported by every major managed switch vendor
  if (vconf.commands.lldp) {
    try {
      const cmd = subst(vconf.commands.lldp);
      const raw = await runSwitchCommand({ ...cred, command: cmd });
      const parsed = parseLooseNeighbor(raw);
      chain.push({ method: 'lldp', command: cmd, found: parsed.found, data: parsed, raw_tail: tail(raw) });
      if (parsed.found) return { method: 'lldp', neighbor: parsed, chain };
    } catch (err) {
      chain.push({ method: 'lldp', error: err.message, found: false });
    }
  }

  // 2. CDP — Cisco only (vendor config has cdp=null for others)
  if (vconf.commands.cdp) {
    try {
      const cmd = subst(vconf.commands.cdp);
      const raw = await runSwitchCommand({ ...cred, command: cmd });
      const parsed = parseLooseNeighbor(raw);
      chain.push({ method: 'cdp', command: cmd, found: parsed.found, data: parsed, raw_tail: tail(raw) });
      if (parsed.found) return { method: 'cdp', neighbor: parsed, chain };
    } catch (err) {
      chain.push({ method: 'cdp', error: err.message, found: false });
    }
  }

  // 3. MAC address table — last resort, gives us the remote MAC
  let macResult = null;
  if (vconf.commands.mac_table) {
    try {
      const cmd = subst(vconf.commands.mac_table);
      const raw = await runSwitchCommand({ ...cred, command: cmd });
      macResult = parseLooseMacTable(raw);
      chain.push({ method: 'mac_table', command: cmd, found: macResult.found, data: macResult, raw_tail: tail(raw) });
    } catch (err) {
      chain.push({ method: 'mac_table', error: err.message, found: false });
    }
  }

  if (!macResult?.found) return { method: 'none', neighbor: { found: false }, chain };

  // 4. ARP lookup — MAC → IP
  let arpResult = null;
  if (vconf.commands.arp) {
    try {
      const cmd = subst(vconf.commands.arp, { mac: macResult.mac });
      const raw = await runSwitchCommand({ ...cred, command: cmd });
      arpResult = parseLooseArp(raw, macResult.mac);
      chain.push({ method: 'arp', command: cmd, found: arpResult.found, data: arpResult, raw_tail: tail(raw) });
    } catch (err) {
      chain.push({ method: 'arp', error: err.message, found: false });
    }
  }

  // 5. Reverse DNS — IP → hostname (runs on the Node server, not the switch)
  let hostname = null;
  if (arpResult?.found && arpResult.ip) {
    hostname = await reverseDnsLookup(arpResult.ip);
    chain.push({ method: 'rdns', found: !!hostname, data: { hostname } });
  }

  const synth = {
    found: true,
    system_name:        hostname || null,
    port_id:            null,
    port_description:   null,
    chassis_id:         macResult.mac,
    system_description: null,
    management_address: arpResult?.ip || null,
    vlan_id:            macResult.vlan || null,
    capabilities:       null,
  };
  return { method: arpResult?.found ? 'mac_arp' : 'mac_only', neighbor: synth, chain };
}

/**
 * POST /api/switch/port-status
 * One-shot SSH snapshot of a specific port. Runs the LLDP-neighbor chain +
 * MAC-table query and returns a compact "is this port doing anything right
 * now" structure suitable for polling every few seconds from the client.
 *
 * Body: { host, sshPort?, interface, vendor?, username?, password?, enablePassword? }
 * Response: {
 *   ok: true,
 *   as_of: ISO timestamp,
 *   has_neighbor: bool,            // LLDP/CDP neighbor discovered
 *   neighbor: {...} | null,        // same shape as lldp-neighbor endpoint
 *   neighbor_method: "lldp"|...,
 *   mac_count: number,             // MACs learned on this port right now
 *   first_mac: string | null,
 *   link_active: bool,             // has_neighbor || mac_count > 0
 * }
 *
 * We reuse findNeighborChain() + the existing VENDORS.mac_table command —
 * no new vendor-specific parsers needed. One SSH roundtrip, ~1-3s per poll.
 */
app.post('/api/switch/port-status', async (req, res) => {
  const { host, sshPort, interface: iface, vendor } = req.body || {};
  const { username, password, enablePassword } = resolveSwitchCreds(req.body || {});
  if (!host || !username || !password || !iface) {
    return res.status(400).json({ error: 'host, interface, and credentials (body or env) required' });
  }
  const vendorKey = VENDORS[vendor] ? vendor : 'cisco-ios';
  const dialect = VENDORS[vendorKey];
  try {
    // LLDP / neighbor chain (also gets us MAC learning via chain.mac_table)
    let neighborOut = { method: 'none', neighbor: null, chain: null };
    try {
      neighborOut = await findNeighborChain({
        host, port: sshPort, username, password, enablePassword, iface, vendor: vendorKey,
      });
    } catch (e) {
      return res.json({
        ok: false,
        as_of: new Date().toISOString(),
        error: e.message,
        has_neighbor: false,
        link_active: false,
      });
    }

    // Extract MAC count from the chain output (findNeighborChain runs
    // mac_table as part of its normal probe and includes the raw text).
    let mac_count = 0;
    let first_mac = null;
    const chainText = (() => {
      if (!neighborOut.chain) return '';
      if (Array.isArray(neighborOut.chain)) {
        return neighborOut.chain.map(c => typeof c === 'string' ? c : (c?.output || c?.raw || JSON.stringify(c))).join('\n');
      }
      return String(neighborOut.chain);
    })();
    const macMatches = chainText.match(/[0-9a-fA-F]{2}[:\-.][0-9a-fA-F]{2,4}(?:[:\-.][0-9a-fA-F]{2,4}){1,4}/g) || [];
    const uniqMacs = [...new Set(macMatches.map(m => m.toLowerCase()))];
    mac_count = uniqMacs.length;
    first_mac = uniqMacs[0] || null;

    const has_neighbor = !!(neighborOut.neighbor && (neighborOut.neighbor.sysname || neighborOut.neighbor.chassis_id || neighborOut.neighbor.port_id));
    res.json({
      ok: true,
      as_of: new Date().toISOString(),
      host, interface: iface, vendor: vendorKey,
      has_neighbor,
      neighbor: neighborOut.neighbor || null,
      neighbor_method: neighborOut.method || 'none',
      mac_count,
      first_mac,
      link_active: has_neighbor || mac_count > 0,
    });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

app.post('/api/switch/lldp-neighbor', async (req, res) => {
  const { host, sshPort, interface: iface, vendor } = req.body || {};
  const { username, password, enablePassword } = resolveSwitchCreds(req.body || {});
  if (!host || !username || !password || !iface) {
    return res.status(400).json({ error: 'host, interface, and credentials (body or env) required' });
  }
  const vendorKey = VENDORS[vendor] ? vendor : 'cisco-ios';
  try {
    const { method, neighbor, chain } = await findNeighborChain({
      host, port: sshPort, username, password, enablePassword, iface, vendor: vendorKey,
    });
    writeLastHost(softAuthUserId(req), host);
    res.json({ ok: true, host, interface: iface, vendor: vendorKey, method, neighbor, chain });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

// GET /api/vendors — list supported switch vendors for the UI picker.
app.get('/api/vendors', (req, res) => {
  res.json({
    vendors: Object.entries(VENDORS).map(([key, v]) => ({ key, label: v.label })),
  });
});

// ── Spec sheet & firmware lookup ──────────────────────────────
// Spawns a python module under pipeline/ with --json. The module reads
// Switch_Vendors_Websites.xlsx, picks the vendor URL, searches the vendor
// site, and scrapes the relevant block (specs, release notes, CVEs).
const { spawn: _spawnPyMod } = require('child_process');
const PY_MOD_TIMEOUT_MS = 90_000;

function runPipelineModule(moduleName, extraArgs) {
  return new Promise((resolve) => {
    const child = _spawnPyMod(pythonCmd, ['-u', '-m', moduleName, ...extraArgs], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
    });

    let stdout = '', stderr = '', settled = false;
    const finish = (payload) => { if (settled) return; settled = true; resolve(payload); };

    const killTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      // Friendly user-facing string. The real module name + stderr are
      // kept on the result object for server-log debugging but never
      // surface to the UI directly.
      finish({
        ok: false,
        error: 'Lookup took too long. Try again in a moment.',
        _moduleName: moduleName,
        _stderr: stderr,
      });
    }, PY_MOD_TIMEOUT_MS);

    child.stdout.on('data', c => { stdout += c.toString(); });
    child.stderr.on('data', c => { stderr += c.toString(); });
    child.on('error', (err) => {
      clearTimeout(killTimer);
      finish({ ok: false, error: 'Lookup failed to start. Try again.', _spawnError: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(killTimer);
      const lastLine = stdout.trim().split('\n').filter(Boolean).pop();
      let parsed = null;
      if (lastLine) { try { parsed = JSON.parse(lastLine); } catch (_) {} }
      if (parsed) return finish(parsed);
      finish({
        ok: false,
        error: 'Lookup didn’t return a usable result. Try again.',
        _exitCode: code,
        _stderr: stderr.trim().slice(-500),
      });
    });
  });
}

// GET /api/specs/vendors — vendor names from the Excel sheet.
app.get('/api/specs/vendors', async (req, res) => {
  const result = await runPipelineModule('pipeline.all_vendor', ['--list-vendors']);
  if (!result.ok) return res.status(500).json(result);
  res.json(result);
});

// POST /api/specs  body: { vendor, model }
// → resolves the vendor URL, searches the site, scrapes specs.
app.post('/api/specs', async (req, res) => {
  const vendor = String(req.body?.vendor || '').trim();
  const model  = String(req.body?.model  || '').trim();
  if (!vendor || !model) {
    return res.status(400).json({ ok: false, error: 'vendor and model are required' });
  }
  const result = await runPipelineModule('pipeline.all_vendor',
    ['--json', '--vendor', vendor, '--model', model]);
  if (!result.ok) return res.status(404).json(result);
  res.json(result);
});

// POST /api/sfp/analyze  body: { vendor, model, interfaces? }
// → dynamically determines SFP slot type by scraping vendor datasheets,
//   then searches the web for compatible transceiver modules.
//   No hardcoded switch database — everything is inferred from live data.
app.post('/api/sfp/analyze', async (req, res) => {
  const vendor     = String(req.body?.vendor || '').trim();
  const model      = String(req.body?.model  || '').trim();
  const interfaces = req.body?.interfaces || '';  // comma-separated iface names
  if (!vendor && !model) {
    return res.status(400).json({ ok: false, error: 'vendor or model required' });
  }
  const args = ['--json', '--vendor', vendor || 'Unknown', '--model', model || 'Unknown'];
  if (interfaces) args.push('--interfaces', interfaces);
  const result = await runPipelineModule('pipeline.sfp_recommend', args);
  res.json(result);
});

// POST /api/firmware  body: { vendor, model, currentVersion }
// → finds release notes / changelog on the vendor's site and queries
//   NIST NVD for CVEs that mention the product. Best-effort by design.
app.post('/api/firmware', async (req, res) => {
  const vendor         = String(req.body?.vendor || '').trim();
  const model          = String(req.body?.model  || '').trim();
  const currentVersion = String(req.body?.currentVersion || '').trim();
  if (!vendor || !model || !currentVersion) {
    return res.status(400).json({
      ok: false,
      error: 'vendor, model, and currentVersion are required',
    });
  }
  const result = await runPipelineModule('pipeline.firmware_check', [
    '--json',
    '--vendor', vendor,
    '--model',  model,
    '--current-version', currentVersion,
  ]);
  if (!result.ok) return res.status(404).json(result);
  res.json(result);
});

// POST /api/scan/:rackId/ocr-devices
// Runs pipeline.ocr_devices on a rack — per-device EasyOCR pass against
// each detected device's chassis crop, parsing make/model/firmware. Writes
// outputs/<rackId>/ocr_devices.json which servicenow/synth.py picks up on
// the next CMDB build to populate real (instead of synthesized) make/model.
// Slow path: EasyOCR on CPU can take 1-2 minutes for a full rack. We use
// a generous timeout (5 min) and run synchronously since the user is
// usually waiting on the result before triggering the CMDB push.
const OCR_DEVICES_TIMEOUT_MS = 5 * 60_000;
app.post('/api/scan/:rackId/ocr-devices', (req, res) => {
  const { rackId } = req.params;
  const rackDir = path.join(outputsDir, rackId);
  if (!fs.existsSync(rackDir)) {
    return res.status(404).json({ ok: false, error: `rack ${rackId} not found` });
  }
  const child = spawnChild(pythonCmd,
    ['-u', '-m', 'pipeline.ocr_devices', rackId, '--json'],
    { cwd: PROJECT_ROOT,
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' } });
  let stdout = '', stderr = '', settled = false;
  const send = (status, body) => {
    if (settled) return;
    settled = true;
    res.status(status).json(body);
  };
  const killer = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch (_) {}
    send(504, { ok: false, error: 'OCR timed out', rackId });
  }, OCR_DEVICES_TIMEOUT_MS);
  child.stdout.on('data', c => { stdout += c.toString(); });
  child.stderr.on('data', c => { stderr += c.toString(); });
  child.on('error', err => {
    clearTimeout(killer);
    send(500, { ok: false, error: `spawn failed: ${err.message}` });
  });
  child.on('close', () => {
    clearTimeout(killer);
    const lastLine = stdout.trim().split('\n').filter(Boolean).pop() || '';
    let parsed = null;
    try { parsed = JSON.parse(lastLine); } catch (_) {}
    if (!parsed) {
      return send(500, { ok: false,
        error: stderr.slice(-400) || 'no JSON on stdout',
        rackId });
    }
    audit.log({ req, action: 'scan.ocr_devices',
                status: parsed.ok ? 'ok' : 'fail',
                targetType: 'rack', targetId: rackId,
                payload: { devices: (parsed.devices || []).length,
                           full: (parsed.devices || []).filter(d => d.source === 'ocr_full').length,
                           partial: (parsed.devices || []).filter(d => d.source === 'ocr_make_only').length } });
    send(parsed.ok ? 200 : 500, parsed);
  });
});

// GET /api/scan/:rackId/ocr-devices
// Returns the cached ocr_devices.json if it exists. No SSH, no scrape — just
// reads the file written by the POST endpoint above. Used by the Switch
// Information page to know whether OCR has been run for this rack.
app.get('/api/scan/:rackId/ocr-devices', (req, res) => {
  const { rackId } = req.params;
  const p = path.join(outputsDir, rackId, 'ocr_devices.json');
  if (!fs.existsSync(p)) {
    return res.status(404).json({ ok: false, error: 'OCR not yet run for this rack', rackId });
  }
  try {
    res.setHeader('Content-Type', 'application/json');
    res.send(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, rackId });
  }
});

// POST /api/scan/:rackId/side-labels
// Runs pipeline.side_labels — extracts identifier-shaped text from the
// LEFT and RIGHT margins of the rack photo (the green "SWHOME / SWFIBRA1"
// chips techs apply to rack rails). This is independent of the CV
// detector: even when YOLO misses a device with an unusual fascia, the
// side label is still readable. The client uses the result to surface
// recall gaps ("5 labels found, 3 switches identified — confirm the
// missing 2") instead of silently under-counting.
//
// Same spawn pattern as ocr-devices (synchronous, generous timeout —
// EasyOCR on CPU). Cheaper than the full-image pass because we only OCR
// ~24% of the pixels (12% on each margin).
const SIDE_LABELS_TIMEOUT_MS = 3 * 60_000;
app.post('/api/scan/:rackId/side-labels', (req, res) => {
  const { rackId } = req.params;
  const rackDir = path.join(outputsDir, rackId);
  if (!fs.existsSync(rackDir)) {
    return res.status(404).json({ ok: false, error: `rack ${rackId} not found` });
  }
  const child = spawnChild(pythonCmd,
    ['-u', '-m', 'pipeline.side_labels', rackId, '--json'],
    { cwd: PROJECT_ROOT,
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' } });
  let stdout = '', stderr = '', settled = false;
  const send = (status, body) => {
    if (settled) return;
    settled = true;
    res.status(status).json(body);
  };
  const killer = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch (_) {}
    send(504, { ok: false, error: 'side-label OCR timed out', rackId });
  }, SIDE_LABELS_TIMEOUT_MS);
  child.stdout.on('data', c => { stdout += c.toString(); });
  child.stderr.on('data', c => { stderr += c.toString(); });
  child.on('error', err => {
    clearTimeout(killer);
    send(500, { ok: false, error: `spawn failed: ${err.message}` });
  });
  child.on('close', () => {
    clearTimeout(killer);
    const lastLine = stdout.trim().split('\n').filter(Boolean).pop() || '';
    let parsed = null;
    try { parsed = JSON.parse(lastLine); } catch (_) {}
    if (!parsed) {
      return send(500, { ok: false,
        error: stderr.slice(-400) || 'no JSON on stdout',
        rackId });
    }
    // Cache for cheap re-fetch from the GET endpoint.
    if (parsed.ok) {
      try {
        fs.writeFileSync(
          path.join(rackDir, 'side_labels.json'),
          JSON.stringify(parsed, null, 2),
        );
      } catch (e) {
        logger.warn(`[side_labels] cache write failed for ${rackId}: ${e.message}`);
      }
    }
    send(parsed.ok ? 200 : 500, parsed);
  });
});

// GET /api/scan/:rackId/side-labels
// Returns the cached side_labels.json if present, otherwise 404. The
// client falls back to triggering a POST when this 404s.
app.get('/api/scan/:rackId/side-labels', (req, res) => {
  const { rackId } = req.params;
  const p = path.join(outputsDir, rackId, 'side_labels.json');
  if (!fs.existsSync(p)) {
    return res.status(404).json({ ok: false, error: 'side labels not yet extracted', rackId });
  }
  try {
    res.setHeader('Content-Type', 'application/json');
    res.send(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, rackId });
  }
});

// POST /api/scan/:rackId/{slack,teams,outlook}
// Each regenerates the report as PDF (via headless Chromium) and spawns the
// matching Python sender (pipeline.slack_email / pipeline.teams_send /
// pipeline.outlook_send). The sender emits a single JSON line on stdout; we
// forward it to the client.
const { spawn: spawnChild } = require('child_process');

// No hardcoded recipient — the client must supply one (env vars below are an ops override).
const SHARE_PDF_TIMEOUT_MS = 120_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function runShareSender(req, res, { rackId, channel, pyModule, email, extraArgs }) {
  if (!email) {
    audit.log({ req, action: `scan.share.${channel}`, status: 'fail', targetType: 'rack', targetId: rackId, error: 'missing recipient' });
    return res.status(400).json({ ok: false, channel, error: 'Recipient email is required' });
  }
  if (!EMAIL_RE.test(email)) {
    audit.log({ req, action: `scan.share.${channel}`, status: 'fail', targetType: 'rack', targetId: rackId, error: 'invalid recipient', payload: { recipient: email } });
    return res.status(400).json({ ok: false, channel, error: 'Recipient email is not a valid address' });
  }

  let pdfPath;
  try {
    ({ pdfPath } = await buildScanReportPDF(rackId));
  } catch (err) {
    const code = /not.*found|ENOENT/i.test(String(err?.message)) ? 404 : 500;
    logger.error(`[share:${channel}] PDF build failed for ${rackId}:`, err);
    audit.log({ req, action: `scan.share.${channel}`, status: 'fail', targetType: 'rack', targetId: rackId,
                error: `pdf build: ${err.message}`, payload: { recipient: email } });
    return res.status(code).json({ ok: false, channel, error: 'Could not generate the report. Please try again.' });
  }

  const args = ['-u', '-m', pyModule, '--email', email, '--file', pdfPath, ...extraArgs];
  const child = spawnChild(pythonCmd, args, {
    cwd: PROJECT_ROOT,
    env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
  });

  let stdout = '', stderr = '', settled = false;
  const send = (status, body) => {
    if (settled) return;
    settled = true;
    res.status(status).json(body);
  };

  const killTimer = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch (_) {}
  }, SHARE_PDF_TIMEOUT_MS);

  child.stdout.on('data', c => { stdout += c.toString(); });
  child.stderr.on('data', c => { stderr += c.toString(); });

  child.on('close', (code) => {
    clearTimeout(killTimer);
    let parsed = null;
    const lastLine = stdout.trim().split('\n').filter(Boolean).pop();
    if (lastLine) { try { parsed = JSON.parse(lastLine); } catch (_) {} }

    if (code === 0 && parsed?.ok) {
      audit.log({ req, action: `scan.share.${channel}`, status: 'ok', targetType: 'rack', targetId: rackId,
                  payload: { recipient: email } });
      return send(200, {
        ok: true,
        channel,
        rackId,
        recipient: email,
        reportPath: pdfPath,
        result: parsed,
      });
    }
    logger.error(`[share:${channel}] sender exited code=${code} for ${rackId}`, { stderr: stderr.slice(-500) });
    audit.log({ req, action: `scan.share.${channel}`, status: 'fail', targetType: 'rack', targetId: rackId,
                error: parsed?.error || `exit ${code}`, payload: { recipient: email } });
    send(502, {
      ok: false,
      channel,
      error: parsed?.error || stderr || `${channel} sender exited with code ${code}`,
      stdout: stdout.slice(-2000),
      stderr: stderr.slice(-2000),
    });
  });

  child.on('error', (err) => {
    clearTimeout(killTimer);
    logger.error(`[share:${channel}] failed to spawn Python:`, err);
    audit.log({ req, action: `scan.share.${channel}`, status: 'fail', targetType: 'rack', targetId: rackId,
                error: `spawn: ${err.message}`, payload: { recipient: email } });
    send(500, { ok: false, channel, error: `Failed to spawn Python: ${err.message}` });
  });
}

app.post('/api/scan/:rackId/slack', async (req, res) => {
  const { rackId } = req.params;
  const email   = (req.body?.email || process.env.SLACK_RECIPIENT_EMAIL || '').trim();
  const comment = (req.body?.comment || `Rack scan report for ${rackId}`).toString();
  await runShareSender(req, res, {
    rackId, channel: 'slack', pyModule: 'pipeline.slack_email', email,
    extraArgs: ['--comment', comment],
  });
});

app.post('/api/scan/:rackId/teams', async (req, res) => {
  const { rackId } = req.params;
  const email   = (req.body?.email || process.env.TEAMS_RECIPIENT_EMAIL || '').trim();
  const message = (req.body?.message || `Rack scan report for ${rackId}`).toString();
  await runShareSender(req, res, {
    rackId, channel: 'teams', pyModule: 'pipeline.teams_send', email,
    extraArgs: ['--message', message],
  });
});

app.post('/api/scan/:rackId/outlook', async (req, res) => {
  const { rackId } = req.params;
  const email   = (req.body?.email || process.env.OUTLOOK_RECIPIENT_EMAIL || '').trim();
  const subject = (req.body?.subject || `Rack scan report for ${rackId}`).toString();
  const extra = ['--subject', subject];
  if (req.body?.body) extra.push('--body', String(req.body.body));
  await runShareSender(req, res, {
    rackId, channel: 'outlook', pyModule: 'pipeline.outlook_send', email,
    extraArgs: extra,
  });
});

// Exported for in-process use (e.g. your Slack sender):
//   const { buildScanReport, buildScanReportData, renderHTMLReport,
//           renderJSONReport, renderCSVReport } = require('./app');
module.exports = module.exports || {};
module.exports.buildScanReport         = buildScanReport;
module.exports.buildScanReportPDF      = buildScanReportPDF;
module.exports.buildScanReportData     = buildScanReportData;
module.exports.writeCanonicalScanResult = writeCanonicalScanResult;
module.exports.renderHTMLReport        = renderHTMLReport;
module.exports.renderJSONReport        = renderJSONReport;
module.exports.renderCSVReport         = renderCSVReport;

// ── User feedback on port identification ──────────────────────
const feedbackDir      = path.join(__dirname, 'feedback');
const feedbackWrongDir = path.join(feedbackDir, 'wrong');
const feedbackLogPath  = path.join(__dirname, 'feedback.jsonl');
[feedbackDir, feedbackWrongDir].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// ── Feedback override layer ──────────────────────────────────
// Reads server/feedback.jsonl for a given scan and overlays the user's
// `actual_*` corrections on top of the model's predictions in the scan
// result. Keeps a `_correction` audit trail so the original prediction
// is never lost.
//
// Applied during writeCanonicalScanResult, so the corrected values land
// in scan_result.json — every consumer (UI, exports, ServiceNow) sees
// the same overlaid view. Re-runs after every feedback POST because
// scheduleCanonicalRefresh fires after the audit.log success.
function _readFeedbackForScan(scanId) {
  if (!fs.existsSync(feedbackLogPath)) return [];
  let raw;
  try { raw = fs.readFileSync(feedbackLogPath, 'utf8'); }
  catch (err) {
    logger.warn(`[feedback_overlay] read failed for ${scanId}: ${err.message}`);
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const r = JSON.parse(line);
      if (r.scanId === scanId && r.is_correct === false) out.push(r);
    } catch (_) { /* skip malformed */ }
  }
  return out;
}

// Re-derive cable_type when the color changes. Heuristic: replace any
// known color word in the existing cable_type string. If we can't
// detect a color word, leave cable_type unchanged.
const _CABLE_COLOR_WORD = /\b(?:White|Black|Blue|Red|Green|Yellow|Grey|Gray|Brown|Orange|Purple|Pink)\b/i;
function _swapCableTypeColor(cableType, newColor) {
  if (!cableType || !newColor) return cableType;
  if (!_CABLE_COLOR_WORD.test(cableType)) return cableType;
  return cableType.replace(_CABLE_COLOR_WORD, newColor);
}

function applyFeedbackOverrides(scanId, payload) {
  if (!payload) return payload;
  const rows = _readFeedbackForScan(scanId);
  if (!rows.length) return payload;

  // Latest correction wins per (key). Keys differ by feedback_type:
  //  - port:       device_index + port_location signature
  //  - device:     device_index
  //  - port_count: device_index
  const latest = new Map();
  for (const r of rows) {
    const ft = r.feedback_type;
    let key = null;
    if (ft === 'port') key = `port:${r.device_index}:${(r.port_location || []).join(',')}`;
    else if (ft === 'device') key = `device:${r.device_index}`;
    else if (ft === 'port_count') key = `count:${r.device_index}`;
    if (!key) continue;
    const prev = latest.get(key);
    if (!prev || (r.timestamp || '') > (prev.timestamp || '')) latest.set(key, r);
  }

  // 1) selectedPort.port_info — the "Port Located" card the UI renders.
  const sp = payload.selectedPort;
  if (sp && sp.device_index != null && sp.port_info) {
    const pi = sp.port_info;
    const k = `port:${sp.device_index}:${(pi.location || []).join(',')}`;
    const fb = latest.get(k);
    if (fb) {
      const fields = [];
      const original = {};
      if (fb.actual_port != null && fb.actual_port !== pi.port_number) {
        original.port_number = pi.port_number;
        pi.port_number = fb.actual_port;
        fields.push('port_number');
      }
      if (fb.actual_cable_color && fb.actual_cable_color !== pi.cable_color) {
        original.cable_color = pi.cable_color;
        pi.cable_color = fb.actual_cable_color;
        fields.push('cable_color');
        const newType = _swapCableTypeColor(pi.cable_type, fb.actual_cable_color);
        if (newType && newType !== pi.cable_type) {
          original.cable_type = pi.cable_type;
          pi.cable_type = newType;
          fields.push('cable_type');
        }
      }
      if (fields.length) {
        pi._correction = { applied_at: fb.timestamp, source: 'user_feedback', fields, original };
      }
    }

    // selected_device.class_name from device-class feedback
    if (sp.selected_device) {
      const dfb = latest.get(`device:${sp.device_index}`);
      if (dfb && dfb.actual_device_class && dfb.actual_device_class !== sp.selected_device.class_name) {
        const original = { class_name: sp.selected_device.class_name };
        sp.selected_device.class_name = dfb.actual_device_class;
        sp.selected_device._correction = {
          applied_at: dfb.timestamp, source: 'user_feedback',
          fields: ['class_name'], original,
        };
      }
    }
  }

  // 2) devices[] — class_name (device feedback) + port_count (port-count feedback)
  for (const dev of payload.devices || []) {
    if (!dev || dev.index == null) continue;

    const dfb = latest.get(`device:${dev.index}`);
    if (dfb && dfb.actual_device_class && dfb.actual_device_class !== dev.class_name) {
      dev._correction = dev._correction || { source: 'user_feedback', fields: [], original: {} };
      dev._correction.original.class_name = dev.class_name;
      dev._correction.fields.push('class_name');
      dev._correction.applied_at = dfb.timestamp;
      dev.class_name = dfb.actual_device_class;
    }

    const cfb = latest.get(`count:${dev.index}`);
    if (cfb && cfb.actual_port_count != null && cfb.actual_port_count !== dev.port_count) {
      dev._correction = dev._correction || { source: 'user_feedback', fields: [], original: {} };
      dev._correction.original.port_count = dev.port_count;
      dev._correction.fields.push('port_count');
      dev._correction.applied_at = cfb.timestamp;
      dev.port_count = cfb.actual_port_count;
    }
  }

  // 3) Per-device port re-indexing from port-feedback corrections.
  //
  // When a user corrects a port number (e.g. "this is port 8, model said 2"),
  // they're anchoring one physical port at an absolute number. The same
  // shift applies to every other port the detector found on that device:
  // it just started counting at the wrong place.
  //
  //   shift = actual_port - predicted_port
  //
  // Positive shift  → model missed `shift` ports at the start of the row.
  //                   Every detection bumps up by `shift`. Device's
  //                   port_count grows by `shift` to make room.
  // Negative shift  → model emitted spurious detections before the actual
  //                   start of the port row. Drop the leading |shift|
  //                   detections; lower port_count by |shift|.
  //
  // Multiple corrections on one device are summed chronologically, because
  // each correction's `predicted_port` reflects the value the user saw at
  // that moment (which may already include prior shifts). Summing deltas
  // in chronological order yields the correct total shift relative to the
  // raw detector output.
  const sortedPortRows = rows
    .filter(r => r.feedback_type === 'port' && r.actual_port != null && r.predicted_port != null)
    .sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
  const deviceShifts = new Map(); // device_index -> { shift, ts }
  for (const r of sortedPortRows) {
    const delta = Number(r.actual_port) - Number(r.predicted_port);
    if (!delta) continue;
    const prev = deviceShifts.get(r.device_index);
    deviceShifts.set(r.device_index, {
      shift: (prev?.shift || 0) + delta,
      ts: r.timestamp,
    });
  }

  const idents = payload.port_identifications || [];
  const newIdents = [];
  for (const ident of idents) {
    if (!ident || ident.device_index == null) { newIdents.push(ident); continue; }
    const ds = deviceShifts.get(ident.device_index);
    if (!ds || !ds.shift) { newIdents.push(ident); continue; }
    const newPort = ident.port + ds.shift;
    if (newPort <= 0) continue; // before actual start of port row — drop
    const fields = ['port'];
    const original = { port: ident.port };
    const shifted = { ...ident, port: newPort };

    // If the latest port-feedback row for this device matches THIS detection
    // (same original port number) and supplies a cable color, overlay it too.
    const matchingFb = sortedPortRows.findLast
      ? sortedPortRows.findLast(r => r.device_index === ident.device_index && r.predicted_port === ident.port)
      : [...sortedPortRows].reverse().find(r => r.device_index === ident.device_index && r.predicted_port === ident.port);
    if (matchingFb && matchingFb.actual_cable_color && matchingFb.actual_cable_color !== shifted.cable_color) {
      original.cable_color = shifted.cable_color;
      shifted.cable_color = matchingFb.actual_cable_color;
      fields.push('cable_color');
      const newType = _swapCableTypeColor(shifted.cable_type, matchingFb.actual_cable_color);
      if (newType && newType !== shifted.cable_type) {
        original.cable_type = shifted.cable_type;
        shifted.cable_type = newType;
        fields.push('cable_type');
      }
    }
    shifted._correction = {
      applied_at: ds.ts, source: 'user_feedback',
      fields, original, port_shift: ds.shift,
    };
    newIdents.push(shifted);
  }
  payload.port_identifications = newIdents;

  // Reflect the shift on each device's port_count so the picker / "port
  // 1-N" range reflects the corrected layout.
  for (const dev of payload.devices || []) {
    if (!dev || dev.index == null) continue;
    const ds = deviceShifts.get(dev.index);
    if (!ds || !ds.shift) continue;
    if (typeof dev.port_count !== 'number') continue;
    const newCount = Math.max(0, dev.port_count + ds.shift);
    if (newCount === dev.port_count) continue;
    dev._correction = dev._correction || { source: 'user_feedback', fields: [], original: {} };
    if (!('port_count' in (dev._correction.original || {}))) {
      dev._correction.original = dev._correction.original || {};
      dev._correction.original.port_count = dev.port_count;
    }
    if (!Array.isArray(dev._correction.fields)) dev._correction.fields = [];
    if (!dev._correction.fields.includes('port_count')) dev._correction.fields.push('port_count');
    dev._correction.applied_at = ds.ts;
    dev._correction.port_shift = ds.shift;
    dev.port_count = newCount;
  }

  return payload;
}

// ── Active-learning trigger ───────────────────────────────────
// Each feedback POST kicks off a fire-and-forget run_loop --once:
// ingest (cursor-tracked, idempotent) + threshold-check + retrain
// when ready. Deduped so a burst of feedback doesn't fan out into
// N concurrent subprocesses. The trainer itself runs in its own
// subprocess inside run_loop, so even a real retrain spike is
// isolated from the API server. Disable with ACTIVE_LEARNING_AUTOTRAIN=0.
let _activeLearningRunning = false;
let _activeLearningPending  = false;
function triggerActiveLearning(reason) {
  if (process.env.ACTIVE_LEARNING_AUTOTRAIN === '0') return;
  if (_activeLearningRunning) {
    // Coalesce: if a cycle is already running, mark that another
    // pass should kick off when the current one finishes. New rows
    // arriving mid-cycle aren't lost — they'll be picked up next.
    _activeLearningPending = true;
    return;
  }
  _activeLearningRunning = true;
  _activeLearningPending = false;
  const repoRoot = path.join(__dirname, '..');
  let child;
  try {
    child = require('child_process').spawn(
      pythonCmd,
      ['-m', 'retraining_learning.run_loop', '--once'],
      { cwd: repoRoot, detached: true, stdio: 'ignore', windowsHide: true }
    );
  } catch (err) {
    _activeLearningRunning = false;
    logger.warn(`[active_learning] spawn threw: ${err.message}`);
    return;
  }
  logger.info(`[active_learning] cycle started (reason=${reason}, pid=${child.pid})`);
  child.on('exit', (code) => {
    _activeLearningRunning = false;
    logger.info(`[active_learning] cycle done (exit ${code})`);
    if (_activeLearningPending) {
      _activeLearningPending = false;
      setImmediate(() => triggerActiveLearning('coalesced'));
    }
  });
  child.on('error', (err) => {
    _activeLearningRunning = false;
    logger.warn(`[active_learning] failed to spawn: ${err.message}`);
  });
  child.unref();
}

async function cropBoxImage(rackId, box, destPath, padRatio = 0.25, minPad = 6) {
  if (!Array.isArray(box) || box.length !== 4) return false;
  const meta = readMeta(rackId);
  if (!meta?.imagePath || !fs.existsSync(meta.imagePath)) return false;

  const [x1, y1, x2, y2] = box.map(v => Math.round(Number(v)));
  const w = x2 - x1, h = y2 - y1;
  if (w <= 0 || h <= 0) return false;

  try {
    const image = sharp(meta.imagePath);
    const { width: imgW, height: imgH } = await image.metadata();
    const pad = Math.max(minPad, Math.round(Math.min(w, h) * padRatio));
    const left   = Math.max(0, x1 - pad);
    const top    = Math.max(0, y1 - pad);
    const right  = Math.min(imgW, x2 + pad);
    const bottom = Math.min(imgH, y2 + pad);
    await image
      .extract({ left, top, width: right - left, height: bottom - top })
      .png()
      .toFile(destPath);
    return true;
  } catch (err) {
    logger.error('cropBoxImage failed:', err.message);
    return false;
  }
}

app.post('/api/feedback', async (req, res) => {
  const {
    scanId, device_index, predicted_port, is_correct,
    actual_port, actual_cable_color,
  } = req.body || {};

  if (!scanId || device_index == null || predicted_port == null || typeof is_correct !== 'boolean') {
    return res.status(400).json({ error: 'scanId, device_index, predicted_port, is_correct are required' });
  }
  if (!is_correct && actual_port == null && !actual_cable_color) {
    return res.status(400).json({
      error: 'When is_correct is false, supply at least one of actual_port, actual_cable_color',
    });
  }

  // Tenant guard: feedback endpoints take scanId in the BODY (not the path),
  // so the global app.param('rackId',...) doesn't fire here. Verify the
  // calling user's tenant owns this rack before letting them write feedback.
  const fbAuth = softAuthPayload(req);
  if (fbAuth?.tenantId && !tenant.tenantOwnsRack(fbAuth.tenantId, scanId)) {
    logger.warn({ event: 'tenant.access_denied', tenantId: fbAuth.tenantId,
      rackId: scanId, route: '/api/feedback' },
      `tenant ${fbAuth.tenantId} blocked from feedback on rack ${scanId}`);
    return res.status(404).json({ error: `Scan ${scanId} not found` });
  }

  const meta = readMeta(scanId);
  if (!meta) return res.status(404).json({ error: `Scan ${scanId} not found` });

  const rackDir  = path.join(outputsDir, scanId);
  const infoPath = path.join(rackDir, 'selected_port_info.json');
  const fullData = fs.existsSync(infoPath) ? JSON.parse(fs.readFileSync(infoPath, 'utf8')) : {};
  const portInfo = fullData.port_info || {};

  let deviceClass = null;
  let deviceBox = null;
  try {
    const mapPath = path.join(rackDir, 'device_unit_map.json');
    if (fs.existsSync(mapPath)) {
      const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
      const dev = (map.devices || [])[Number(device_index) - 1];
      deviceClass = dev?.class_name || null;
      deviceBox   = dev?.box || null;
    }
  } catch (_) {}

  const wrongFields = [];
  if (!is_correct) {
    if (actual_port != null)  wrongFields.push('port');
    if (actual_cable_color)   wrongFields.push('cable_color');
  }

  let portCropSavedAs = null;
  let deviceCropSavedAs = null;
  if (!is_correct) {
    const tag = wrongFields.length ? wrongFields.join('-') : 'unspecified';
    const base = `${scanId}_dev${device_index}_pred${predicted_port}_${tag}`;
    const portDest = path.join(feedbackWrongDir, `${base}_port.png`);
    if (await cropBoxImage(scanId, portInfo.location, portDest, 0.25, 6)) {
      portCropSavedAs = `${base}_port.png`;
    }
    const devDest = path.join(feedbackWrongDir, `${base}_device.png`);
    if (await cropBoxImage(scanId, deviceBox, devDest, 0.05, 4)) {
      deviceCropSavedAs = `${base}_device.png`;
    }
  }

  const entry = {
    timestamp: new Date().toISOString(),
    feedback_type: 'port',
    scanId,
    device_index: Number(device_index),
    device_class: deviceClass,
    is_correct,
    wrong_fields: wrongFields,
    // Port index
    predicted_port: Number(predicted_port),
    actual_port: (is_correct || actual_port == null) ? null : Number(actual_port),
    // Cable color
    predicted_cable_color: portInfo.cable_color || null,
    actual_cable_color: is_correct ? null : (actual_cable_color || null),
    // Context
    port_status: portInfo.status || null,
    cable_color: portInfo.cable_color || null,
    cable_connector: portInfo.cable_connector || null,
    cable_type: portInfo.cable_type || null,
    port_location: portInfo.location || null,
    device_box: deviceBox,
    port_crop_image: portCropSavedAs,
    device_crop_image: deviceCropSavedAs,
  };
  const line = JSON.stringify(entry) + '\n';

  try {
    appendLineWithRotation(feedbackLogPath, line);
    appendLineWithRotation(path.join(rackDir, 'feedback.jsonl'), line);
  } catch (err) {
    logger.error('feedback write failed:', err.message);
    audit.log({ req, action: 'feedback.submit', status: 'fail', targetType: 'rack', targetId: scanId,
                error: err.message, payload: { feedback_type: 'port' } });
    return res.status(500).json({ error: 'Failed to save feedback' });
  }

  audit.log({ req, action: 'feedback.submit', status: 'ok', targetType: 'rack', targetId: scanId,
              payload: { feedback_type: 'port', device_index: Number(device_index), is_correct } });
  scheduleCanonicalRefresh(scanId);
  triggerActiveLearning('port-feedback');
  res.json({ ok: true, port_crop_image: portCropSavedAs, device_crop_image: deviceCropSavedAs });
});

// ── Device-only feedback ──────────────────────────────────────
// Independent of port/cable feedback. The user looks at a device's
// predicted class and either confirms it or supplies the actual class.
app.post('/api/feedback/device', async (req, res) => {
  const { scanId, device_index, is_correct, actual_device_class } = req.body || {};

  if (!scanId || device_index == null || typeof is_correct !== 'boolean') {
    return res.status(400).json({ error: 'scanId, device_index, is_correct are required' });
  }
  if (!is_correct && !actual_device_class) {
    return res.status(400).json({ error: 'actual_device_class is required when is_correct is false' });
  }

  // Tenant guard (scanId is in body, not path)
  const fbAuth = softAuthPayload(req);
  if (fbAuth?.tenantId && !tenant.tenantOwnsRack(fbAuth.tenantId, scanId)) {
    return res.status(404).json({ error: `Scan ${scanId} not found` });
  }

  const meta = readMeta(scanId);
  if (!meta) return res.status(404).json({ error: `Scan ${scanId} not found` });

  const rackDir = path.join(outputsDir, scanId);

  let predictedClass = null;
  let deviceBox = null;
  try {
    const mapPath = path.join(rackDir, 'device_unit_map.json');
    if (fs.existsSync(mapPath)) {
      const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
      const dev = (map.devices || [])[Number(device_index) - 1];
      predictedClass = dev?.class_name || null;
      deviceBox      = dev?.box || null;
    }
  } catch (_) {}

  let deviceCropSavedAs = null;
  if (!is_correct) {
    const safeActual = String(actual_device_class).replace(/[^A-Za-z0-9_-]+/g, '_');
    const safePred   = String(predictedClass || 'Unknown').replace(/[^A-Za-z0-9_-]+/g, '_');
    const base = `${scanId}_dev${device_index}_devclass_${safePred}_to_${safeActual}`;
    const devDest = path.join(feedbackWrongDir, `${base}_device.png`);
    if (await cropBoxImage(scanId, deviceBox, devDest, 0.05, 4)) {
      deviceCropSavedAs = `${base}_device.png`;
    }
  }

  const entry = {
    timestamp: new Date().toISOString(),
    feedback_type: 'device',
    scanId,
    device_index: Number(device_index),
    is_correct,
    predicted_device_class: predictedClass,
    actual_device_class: is_correct ? null : actual_device_class,
    device_box: deviceBox,
    device_crop_image: deviceCropSavedAs,
  };
  const line = JSON.stringify(entry) + '\n';

  try {
    appendLineWithRotation(feedbackLogPath, line);
    appendLineWithRotation(path.join(rackDir, 'feedback.jsonl'), line);
  } catch (err) {
    logger.error('device feedback write failed:', err.message);
    audit.log({ req, action: 'feedback.submit', status: 'fail', targetType: 'rack', targetId: scanId,
                error: err.message, payload: { feedback_type: 'device' } });
    return res.status(500).json({ error: 'Failed to save feedback' });
  }

  audit.log({ req, action: 'feedback.submit', status: 'ok', targetType: 'rack', targetId: scanId,
              payload: { feedback_type: 'device', device_index: Number(device_index), is_correct } });
  scheduleCanonicalRefresh(scanId);
  triggerActiveLearning('device-feedback');
  res.json({ ok: true, device_crop_image: deviceCropSavedAs });
});

// ── Port-count feedback (main ports detected per device) ──────
// Independent of device-class and port/cable feedback. The user
// confirms how many main ports the model detected for the selected
// device, or supplies the actual count.
app.post('/api/feedback/port-count', async (req, res) => {
  const { scanId, device_index, is_correct, actual_port_count } = req.body || {};

  if (!scanId || device_index == null || typeof is_correct !== 'boolean') {
    return res.status(400).json({ error: 'scanId, device_index, is_correct are required' });
  }
  const actualNum = actual_port_count == null ? null : Number(actual_port_count);
  if (!is_correct && (actualNum == null || isNaN(actualNum) || actualNum < 0)) {
    return res.status(400).json({ error: 'actual_port_count is required (>= 0) when is_correct is false' });
  }

  // Tenant guard (scanId is in body, not path)
  const fbAuth = softAuthPayload(req);
  if (fbAuth?.tenantId && !tenant.tenantOwnsRack(fbAuth.tenantId, scanId)) {
    return res.status(404).json({ error: `Scan ${scanId} not found` });
  }

  const meta = readMeta(scanId);
  if (!meta) return res.status(404).json({ error: `Scan ${scanId} not found` });

  const rackDir = path.join(outputsDir, scanId);
  let predictedCount = null;
  let deviceClass = null;
  let deviceBox = null;
  try {
    const mapPath = path.join(rackDir, 'device_unit_map.json');
    if (fs.existsSync(mapPath)) {
      const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
      const dev = (map.devices || [])[Number(device_index) - 1];
      predictedCount = typeof dev?.port_count === 'number' ? dev.port_count : null;
      deviceClass    = dev?.class_name || null;
      deviceBox      = dev?.box || null;
    }
  } catch (_) {}

  let deviceCropSavedAs = null;
  if (!is_correct) {
    const safePred = predictedCount == null ? 'na' : String(predictedCount);
    const base = `${scanId}_dev${device_index}_portcount_${safePred}_to_${actualNum}`;
    const devDest = path.join(feedbackWrongDir, `${base}_device.png`);
    if (await cropBoxImage(scanId, deviceBox, devDest, 0.05, 4)) {
      deviceCropSavedAs = `${base}_device.png`;
    }
  }

  const entry = {
    timestamp: new Date().toISOString(),
    feedback_type: 'port_count',
    scanId,
    device_index: Number(device_index),
    device_class: deviceClass,
    is_correct,
    predicted_port_count: predictedCount,
    actual_port_count: is_correct ? null : actualNum,
    device_box: deviceBox,
    device_crop_image: deviceCropSavedAs,
  };
  const line = JSON.stringify(entry) + '\n';

  try {
    appendLineWithRotation(feedbackLogPath, line);
    appendLineWithRotation(path.join(rackDir, 'feedback.jsonl'), line);
  } catch (err) {
    logger.error('port-count feedback write failed:', err.message);
    audit.log({ req, action: 'feedback.submit', status: 'fail', targetType: 'rack', targetId: scanId,
                error: err.message, payload: { feedback_type: 'port_count' } });
    return res.status(500).json({ error: 'Failed to save feedback' });
  }

  audit.log({ req, action: 'feedback.submit', status: 'ok', targetType: 'rack', targetId: scanId,
              payload: { feedback_type: 'port_count', device_index: Number(device_index), is_correct, actual_port_count: actualNum } });
  triggerActiveLearning('port-count-feedback');

  // If the user supplied an actual count, re-run port detection for this
  // device with that target so the device's port_count reflects ground truth.
  let relabel = null;
  if (!is_correct && actualNum != null) {
    try {
      const r = await runRelabelPortCount(rackDir, Number(device_index), actualNum);
      if (r?.ok) {
        relabel = {
          ok: true,
          device_index: r.device_index,
          new_port_count: r.port_count,
          device: r.device,
        };
      } else {
        relabel = { ok: false, error: r?.error || 'relabel failed' };
      }
    } catch (err) {
      logger.error('relabel_port_count failed:', err.message);
      relabel = { ok: false, error: err.message };
    }
  }

  // Refresh canonical scan_result.json after both the feedback append and any
  // port-count relabel mutation to device_unit_map.json.
  scheduleCanonicalRefresh(scanId);
  res.json({
    ok: true,
    device_crop_image: deviceCropSavedAs,
    relabel,
  });
});

app.get('/api/feedback/stats', (req, res) => {
  if (!fs.existsSync(feedbackLogPath)) {
    return res.json({ total: 0, correct: 0, wrong: 0, accuracy: null, by_device_class: {} });
  }
  try {
    const lines = fs.readFileSync(feedbackLogPath, 'utf8').split('\n').filter(Boolean);
    const byCls = {};
    let total = 0, correct = 0;
    for (const ln of lines) {
      let e;
      try { e = JSON.parse(ln); } catch { continue; }
      total += 1;
      if (e.is_correct) correct += 1;
      const cls = e.device_class || 'Unknown';
      if (!byCls[cls]) byCls[cls] = { total: 0, correct: 0 };
      byCls[cls].total += 1;
      if (e.is_correct) byCls[cls].correct += 1;
    }
    res.json({
      total,
      correct,
      wrong: total - correct,
      accuracy: total ? correct / total : null,
      by_device_class: byCls,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get(/^\/(?!api|uploads|outputs).*/, (req, res, next) => {
  const indexPath = path.join(clientDist, 'index.html');
  if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
  next();
});

app.use((err, req, res, next) => {
  logger.error(err.message);
  res.status(500).json({ error: err.message });
});

// Global error handler — must be installed AFTER all routes/middleware so
// it catches anything that throws or calls next(err). Logs with full
// context (requestId, route, stack) and returns a sanitized JSON body.
app.use(o11y.errorHandler);

// Only bind the port when run directly (`node app.js` / `npm start`). Loading
// app.js as a module (tests, scripts, in-process tools like buildScanReportPDF)
// must not start a second listener.
if (require.main === module) {
  // Bind with retry-on-EADDRINUSE. The previous implementation created a fresh
  // server inside setTimeout without re-attaching the 'error' handler — a second
  // EADDRINUSE then crashed the process via an unhandled 'error' event. Wrap
  // listen() so every attempt has the same handler, and retry indefinitely
  // (a stale dev process usually clears within seconds).
  let server;
  let attempt = 0;
  const MAX_ATTEMPTS = 20;
  const tryListen = () => {
    attempt += 1;
    server = app.listen(PORT, () => {
      o11y.logBootBanner({ port: PORT, workers: WORKER_COUNT });
      logger.info({
        event: 'server.listening',
        attempt, outputsDir, workers: WORKER_COUNT,
      }, `listening on :${PORT}${attempt > 1 ? ` (after ${attempt} attempts)` : ''}`);
    });
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && attempt < MAX_ATTEMPTS) {
        logger.warn({
          event: 'server.eaddrinuse',
          port: PORT, attempt, maxAttempts: MAX_ATTEMPTS,
        }, `port ${PORT} in use, retrying in 3s`);
        setTimeout(tryListen, 3000);
        return;
      }
      logger.fatal({
        event: 'server.listen_failed',
        err: err.code || err.message,
      }, 'listen failed');
      process.exit(1);
    });
  };
  tryListen();

  const gracefulShutdown = (signal) => {
    logger.info({ event: 'server.shutdown', signal },
      `${signal} received — stopping workers and HTTP server`);
    pool.shutdown().finally(() => {
      if (server) server.close(() => process.exit(0));
      else process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
}

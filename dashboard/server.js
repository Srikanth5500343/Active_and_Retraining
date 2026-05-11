/**
 * RackTrack — Owner Dashboard
 *
 * Standalone read-only dashboard for the owner of the workstation.
 * Bound to 127.0.0.1 only, so the Cloudflare tunnel (which forwards :3001)
 * cannot reach it. No auth — access control is "you have a shell on this box."
 *
 * Reads from:
 *   - server/data/auth.db     → audit_log table (per-tenant audit trail)
 *   - outputs/<rackId>/...    → scan_result.json + scan_meta.json per scan
 *   - server/feedback.jsonl   → active-learning feedback ingest cursor
 *   - server/feedback/wrong/  → captured "wrong?" correction images
 *   - http://localhost:3001/metrics → live Prometheus metrics
 *
 * Run:   node dashboard/server.js
 *        (or:  .\dashboard\start.ps1 )
 *
 * Open:  http://127.0.0.1:4100
 */

const path     = require('path');
const fs       = require('fs');
const http     = require('http');
const PROJECT  = path.resolve(__dirname, '..');

// Reuse the server's node_modules — no second npm install needed.
const NM = path.join(PROJECT, 'server', 'node_modules');
const req = (m) => require(path.join(NM, m));
const express  = req('express');
const Database = req('better-sqlite3');

const PORT      = parseInt(process.env.DASHBOARD_PORT || '4100', 10);
const HOST      = '127.0.0.1';
const AUTH_DB   = path.join(PROJECT, 'server', 'data', 'auth.db');
const OUTPUTS   = path.join(PROJECT, 'outputs');
const FEEDBACK  = path.join(PROJECT, 'server', 'feedback.jsonl');
const WRONG_DIR = path.join(PROJECT, 'server', 'feedback', 'wrong');
const API_BASE  = process.env.RACKTRACK_API_BASE || 'http://127.0.0.1:3001';

// ── DB ──────────────────────────────────────────────────────────────
let db = null;
let auditCols = new Set();
function openDb() {
  if (!fs.existsSync(AUTH_DB)) return null;
  const d = new Database(AUTH_DB, { readonly: true, fileMustExist: true });
  d.pragma('journal_mode = WAL');
  auditCols = new Set(d.prepare('PRAGMA table_info(audit_log)').all().map(c => c.name));
  return d;
}
try { db = openDb(); }
catch (e) { console.warn('[dashboard] auth.db open failed:', e.message); }

const HAS_TENANT = () => auditCols.has('tenant_id');

// tenants(id, slug, name) — small table, query each request so newly-created
// orgs show up without restarting the dashboard.
function getTenantsMap() {
  const byId = new Map(), bySlug = new Map();
  if (!db) return { byId, bySlug };
  try {
    for (const t of db.prepare('SELECT id, slug, name FROM tenants').all()) {
      byId.set(t.id, t);
      bySlug.set(t.slug, t);
    }
  } catch {}
  return { byId, bySlug };
}
function resolveOrg({ byId, bySlug }, value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return byId.get(value) || null;
  const asNum = parseInt(value, 10);
  if (Number.isFinite(asNum) && byId.has(asNum)) return byId.get(asNum);
  return bySlug.get(value) || null;
}

// users(id, username) lookup so we can resolve created_by → username for scans.
function getUsersMap() {
  const byId = new Map();
  if (!db) return byId;
  try {
    for (const u of db.prepare('SELECT id, username, tenant_id FROM users').all()) {
      byId.set(u.id, u);
    }
  } catch {}
  return byId;
}

// rack_owners(tenant_id, rack_id, created_by) is the source of truth for
// "who owns this rack" — scan_meta.json/scan_result.json don't carry
// tenant_id or username, so we have to join here.
function getOwnersMap() {
  const byRack = new Map();
  if (!db) return byRack;
  try {
    const has = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='rack_owners'`).get();
    if (!has) return byRack;
    for (const o of db.prepare('SELECT tenant_id, rack_id, created_by, created_at FROM rack_owners').all()) {
      byRack.set(o.rack_id, o);
    }
  } catch {}
  return byRack;
}

// ── App ─────────────────────────────────────────────────────────────
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  // Belt-and-braces: refuse anything that didn't arrive on the loopback iface.
  const ip = req.socket.remoteAddress || '';
  if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
    return res.status(403).type('text/plain').send('owner-only — loopback access required');
  }
  next();
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── /api/health ─────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    db: !!db,
    hasTenantCol: HAS_TENANT(),
    paths: {
      authDb:    fs.existsSync(AUTH_DB),
      outputs:   fs.existsSync(OUTPUTS),
      feedback:  fs.existsSync(FEEDBACK),
      wrongDir:  fs.existsSync(WRONG_DIR),
    },
    apiBase: API_BASE,
    ts: new Date().toISOString(),
  });
});

// ── /api/audit ──────────────────────────────────────────────────────
// Filters: tenant, user, action, target (rackId), status, since, until,
//          q (free-text on payload/error/username), limit, offset
app.get('/api/audit', (req, res) => {
  if (!db) return res.json({ rows: [], total: 0, note: 'auth.db not present' });
  const {
    tenant, user, action, target, status, since, until, q,
    limit  = '200', offset = '0',
  } = req.query;
  const where = [];
  const args  = {};
  if (tenant && HAS_TENANT()) { where.push('tenant_id = @tenant'); args.tenant = tenant; }
  if (user)   { where.push('(username = @user OR CAST(user_id AS TEXT) = @user)'); args.user = user; }
  if (action) { where.push('action LIKE @action'); args.action = `${action}%`; }
  if (target) { where.push('target_id = @target'); args.target = target; }
  if (status) { where.push('status = @status'); args.status = status; }
  if (since)  { where.push('ts >= @since'); args.since = since; }
  if (until)  { where.push('ts <= @until'); args.until = until; }
  if (q)      {
    where.push('(payload LIKE @q OR error LIKE @q OR username LIKE @q OR target_id LIKE @q)');
    args.q = `%${q}%`;
  }
  const wsql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const lim  = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 1000);
  const off  = Math.max(parseInt(offset, 10) || 0, 0);
  const cols = HAS_TENANT()
    ? 'id, ts, tenant_id, user_id, username, action, target_type, target_id, status, ip, payload, error'
    : 'id, ts, NULL AS tenant_id, user_id, username, action, target_type, target_id, status, ip, payload, error';
  const rows  = db.prepare(`SELECT ${cols} FROM audit_log ${wsql} ORDER BY ts DESC LIMIT ${lim} OFFSET ${off}`).all(args);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM audit_log ${wsql}`).get(args).n;
  const tenants = getTenantsMap();
  for (const r of rows) {
    const t = resolveOrg(tenants, r.tenant_id);
    r.tenant_name = t?.name || null;
    r.tenant_slug = t?.slug || null;
  }
  res.json({ rows, total, limit: lim, offset: off });
});

// ── /api/audit/facets ───────────────────────────────────────────────
// Distinct values for the filter dropdowns. Capped to keep the page snappy.
app.get('/api/audit/facets', (req, res) => {
  if (!db) return res.json({ tenants: [], users: [], actions: [], statuses: [] });
  const tenants = HAS_TENANT()
    ? db.prepare(`
        SELECT t.id, t.slug, t.name
        FROM tenants t
        WHERE t.id IN (SELECT DISTINCT tenant_id FROM audit_log WHERE tenant_id IS NOT NULL)
        ORDER BY t.name COLLATE NOCASE
        LIMIT 100`).all()
    : [];
  const users    = db.prepare(`SELECT DISTINCT username AS v FROM audit_log WHERE username IS NOT NULL ORDER BY username LIMIT 200`).all().map(r => r.v);
  const actions  = db.prepare(`SELECT action AS v, COUNT(*) AS n FROM audit_log GROUP BY action ORDER BY n DESC LIMIT 100`).all();
  const statuses = db.prepare(`SELECT DISTINCT status AS v FROM audit_log ORDER BY status`).all().map(r => r.v);
  res.json({ tenants, users, actions, statuses });
});

// ── /api/audit/summary ──────────────────────────────────────────────
// Roll-ups for the top-of-page stat cards. Honours the same filters as /api/audit
// minus pagination, so the summary always matches the filtered table view.
app.get('/api/audit/summary', (req, res) => {
  if (!db) return res.json({ total: 0, byStatus: [], byTenant: [], byAction: [], series: [] });
  const { tenant, user, action, target, status, since, until, q } = req.query;
  const where = [];
  const args  = {};
  if (tenant && HAS_TENANT()) { where.push('tenant_id = @tenant'); args.tenant = tenant; }
  if (user)   { where.push('(username = @user OR CAST(user_id AS TEXT) = @user)'); args.user = user; }
  if (action) { where.push('action LIKE @action'); args.action = `${action}%`; }
  if (target) { where.push('target_id = @target'); args.target = target; }
  if (status) { where.push('status = @status'); args.status = status; }
  if (since)  { where.push('ts >= @since'); args.since = since; }
  if (until)  { where.push('ts <= @until'); args.until = until; }
  if (q)      { where.push('(payload LIKE @q OR error LIKE @q OR username LIKE @q OR target_id LIKE @q)'); args.q = `%${q}%`; }
  const wsql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total    = db.prepare(`SELECT COUNT(*) AS n FROM audit_log ${wsql}`).get(args).n;
  const byStatus = db.prepare(`SELECT status, COUNT(*) AS n FROM audit_log ${wsql} GROUP BY status`).all(args);
  const byTenantRaw = HAS_TENANT()
    ? db.prepare(`SELECT tenant_id, COUNT(*) AS n FROM audit_log ${wsql} GROUP BY tenant_id ORDER BY n DESC LIMIT 25`).all(args)
    : [];
  const tenantsMap = getTenantsMap();
  const byTenant = byTenantRaw.map(r => {
    const t = resolveOrg(tenantsMap, r.tenant_id);
    return {
      tenant_id:   r.tenant_id,
      tenant_name: t?.name || null,
      tenant_slug: t?.slug || null,
      n: r.n,
    };
  });
  const byAction = db.prepare(`SELECT action, COUNT(*) AS n FROM audit_log ${wsql} GROUP BY action ORDER BY n DESC LIMIT 25`).all(args);
  // 24-hour bucketing — handy for the sparkline.
  const series = db.prepare(`
    SELECT substr(ts,1,13) || ':00' AS hour, COUNT(*) AS n
    FROM audit_log ${wsql}
    GROUP BY substr(ts,1,13)
    ORDER BY hour DESC
    LIMIT 48
  `).all(args).reverse();
  res.json({ total, byStatus, byTenant, byAction, series });
});

// ── /api/scans ──────────────────────────────────────────────────────
// Reads outputs/<rackId>/scan_result.json (when present) + scan_meta.json.
// Cheap directory scan — fine up to a few thousand racks; beyond that we'd
// want an index but that's a future problem.
app.get('/api/scans', (req, res) => {
  const { tenant, user, q, limit = '200' } = req.query;
  const lim = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 1000);
  if (!fs.existsSync(OUTPUTS)) return res.json({ rows: [], total: 0 });

  // The on-disk JSON files don't carry tenant_id / username — those live in
  // rack_owners + users. Build the lookup tables once per request.
  const tenants = getTenantsMap();
  const owners  = getOwnersMap();
  const users   = getUsersMap();

  const rackIds = fs.readdirSync(OUTPUTS, { withFileTypes: true })
    .filter(d => d.isDirectory()).map(d => d.name);
  const rows = [];
  for (const rackId of rackIds) {
    const dir       = path.join(OUTPUTS, rackId);
    const metaPath  = path.join(dir, 'scan_meta.json');
    const resPath   = path.join(dir, 'scan_result.json');
    let meta = null, result = null;
    try { if (fs.existsSync(metaPath)) meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch {}
    try { if (fs.existsSync(resPath))  result = JSON.parse(fs.readFileSync(resPath,  'utf8')); } catch {}
    let mtime = null;
    try { mtime = fs.statSync(resPath || dir).mtime.toISOString(); } catch {}

    // Source of truth: rack_owners. Fallback to JSON, then to anonymous.
    const owner   = owners.get(rackId) || null;
    const userId  = owner?.created_by ?? meta?.userId ?? result?.createdBy ?? null;
    const userRec = userId != null ? users.get(userId) : null;
    const tenantId = owner?.tenant_id
      ?? userRec?.tenant_id
      ?? result?.tenant_id
      ?? meta?.tenant_id
      ?? null;
    const t = resolveOrg(tenants, tenantId);

    const row = {
      rackId,
      tenant_id:   tenantId,
      tenant_name: t?.name || null,
      tenant_slug: t?.slug || null,
      user_id:     userId,
      user:        userRec?.username || result?.username || meta?.username || null,
      deviceCount: Array.isArray(result?.devices) ? result.devices.length : null,
      mtime,
      hasResult:   !!result,
      hasMeta:     !!meta,
      ownedInDb:   !!owner,
    };

    // Filter by tenant: accept either numeric id or slug; the dropdown sends id.
    if (tenant) {
      const wantNum = parseInt(tenant, 10);
      const matchesId   = Number.isFinite(wantNum) && row.tenant_id === wantNum;
      const matchesSlug = row.tenant_slug && row.tenant_slug === tenant;
      if (!matchesId && !matchesSlug) continue;
    }
    if (user) {
      const matchesName = row.user && row.user === user;
      const matchesId   = row.user_id != null && String(row.user_id) === String(user);
      if (!matchesName && !matchesId) continue;
    }
    if (q) {
      const hay = `${rackId} ${row.tenant_name || ''} ${row.tenant_slug || ''} ${row.user || ''}`.toLowerCase();
      if (!hay.includes(String(q).toLowerCase())) continue;
    }
    rows.push(row);
  }
  rows.sort((a, b) => (b.mtime || '').localeCompare(a.mtime || ''));
  res.json({ rows: rows.slice(0, lim), total: rows.length });
});

// ── /api/scans/:rackId ──────────────────────────────────────────────
app.get('/api/scans/:rackId', (req, res) => {
  const rackId = req.params.rackId;
  const dir = path.join(OUTPUTS, rackId);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'unknown rackId' });
  const out = { rackId, files: [], audit: [] };
  for (const f of fs.readdirSync(dir)) {
    try {
      const st = fs.statSync(path.join(dir, f));
      out.files.push({ name: f, size: st.size, mtime: st.mtime.toISOString() });
    } catch {}
  }
  for (const f of ['scan_result.json', 'scan_meta.json']) {
    try {
      const p = path.join(dir, f);
      if (fs.existsSync(p)) out[f] = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) { out[`${f}_error`] = e.message; }
  }
  if (db) {
    out.audit = db.prepare(`SELECT * FROM audit_log WHERE target_id = ? ORDER BY ts DESC LIMIT 200`).all(rackId);

    // Ownership: rack_owners → users → tenants
    const tenants = getTenantsMap();
    const owners  = getOwnersMap();
    const users   = getUsersMap();
    const owner   = owners.get(rackId) || null;
    const userId  = owner?.created_by ?? out['scan_meta.json']?.userId ?? out['scan_result.json']?.createdBy ?? null;
    const userRec = userId != null ? users.get(userId) : null;
    const tenantId = owner?.tenant_id ?? userRec?.tenant_id ?? null;
    const t = resolveOrg(tenants, tenantId);
    out.ownership = {
      tenant_id:   tenantId,
      tenant_name: t?.name || null,
      tenant_slug: t?.slug || null,
      user_id:     userId,
      username:    userRec?.username || null,
      created_at:  owner?.created_at || null,
      ownedInDb:   !!owner,
    };
  }
  res.json(out);
});

// ── /api/feedback ───────────────────────────────────────────────────
// Tail of the feedback JSONL + listing of "wrong" correction images.
app.get('/api/feedback', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
  const out = { jsonl: [], wrongImages: [] };
  if (fs.existsSync(FEEDBACK)) {
    try {
      const buf = fs.readFileSync(FEEDBACK, 'utf8').trim().split(/\r?\n/);
      const tail = buf.slice(-limit);
      out.jsonl = tail.map((line, i) => {
        try { return { i: buf.length - tail.length + i, ...JSON.parse(line) }; }
        catch { return { i: buf.length - tail.length + i, raw: line.slice(0, 500) }; }
      }).reverse();
    } catch (e) { out.error = e.message; }
  }
  if (fs.existsSync(WRONG_DIR)) {
    out.wrongImages = fs.readdirSync(WRONG_DIR)
      .filter(f => /\.(png|jpg|jpeg)$/i.test(f))
      .map(f => {
        const st = fs.statSync(path.join(WRONG_DIR, f));
        return { name: f, size: st.size, mtime: st.mtime.toISOString() };
      })
      .sort((a, b) => b.mtime.localeCompare(a.mtime))
      .slice(0, limit);
  }
  res.json(out);
});

// Static-ish image serving for the wrong-correction samples (loopback only).
app.get('/api/feedback/wrong/:file', (req, res) => {
  const safe = path.basename(req.params.file);
  const p = path.join(WRONG_DIR, safe);
  if (!fs.existsSync(p)) return res.status(404).end();
  res.sendFile(p);
});

// ── /api/metrics ────────────────────────────────────────────────────
// Proxies the live /metrics endpoint, parses Prometheus text format into
// a JSON shape the page can render. Intentionally simple — counters and
// gauges only; histograms collapse to count + sum (good enough for cards).
app.get('/api/metrics', (req, res) => {
  const url = `${API_BASE}/metrics`;
  http.get(url, (r) => {
    let body = '';
    r.on('data', (c) => body += c);
    r.on('end', () => {
      try { res.json(parseProm(body)); }
      catch (e) { res.status(502).json({ error: 'parse failed', detail: e.message, raw: body.slice(0, 500) }); }
    });
  }).on('error', (e) => res.status(502).json({ error: 'metrics unreachable', detail: e.message, url }));
});

function parseProm(text) {
  const lines = text.split(/\r?\n/);
  const out   = { metrics: {}, fetchedAt: new Date().toISOString() };
  for (const line of lines) {
    if (!line || line.startsWith('#')) continue;
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(-?[\d.eE+-]+|NaN)$/.exec(line);
    if (!m) continue;
    const [, name, lbls, val] = m;
    const labels = {};
    if (lbls) {
      const inner = lbls.slice(1, -1);
      for (const kv of inner.split(',')) {
        const eq = kv.indexOf('=');
        if (eq < 0) continue;
        const k = kv.slice(0, eq).trim();
        let v = kv.slice(eq + 1).trim();
        if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
        labels[k] = v;
      }
    }
    out.metrics[name] = out.metrics[name] || [];
    out.metrics[name].push({ labels, value: Number(val) });
  }
  return out;
}

// ── Boot ────────────────────────────────────────────────────────────
const server = app.listen(PORT, HOST, () => {
  console.log(`\n┌──────────────────────────────────────────────────────────┐`);
  console.log(`│  RackTrack — Owner Dashboard                              │`);
  console.log(`│  http://${HOST}:${PORT}                              │`);
  console.log(`│  Loopback only — Cloudflare tunnel cannot reach this port │`);
  console.log(`└──────────────────────────────────────────────────────────┘\n`);
});

process.on('SIGINT', () => { try { db?.close(); } catch {} server.close(() => process.exit(0)); });

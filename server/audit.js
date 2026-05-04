/**
 * Audit log — append-only event trail for every authenticated/sensitive action.
 *
 * Storage: shares server/data/auth.db (a single SQLite file keeps backup +
 * restore trivial). Table is created on first require.
 *
 * Usage:
 *   const audit = require('./audit');
 *   audit.log({ req, action: 'auth.login', status: 'ok', targetType: 'user', targetId: user.id });
 *   audit.log({ req, action: 'scan.share', status: 'fail', targetType: 'rack', targetId: rackId,
 *               error: err.message, payload: { channel: 'slack' } });
 *
 * Reads:
 *   audit.query({ userId, action, sinceTs, untilTs, limit, offset })
 *
 * Design notes:
 *   - All log() calls are best-effort: a DB error is caught + logged, never thrown.
 *     Audit logging must never break the request path.
 *   - We snapshot username at write time so deleting a user later does not
 *     erase their trail.
 *   - payload is JSON-stringified; we cap it at 8 KiB to bound row size.
 *   - `req` is optional — pass it when available so we can capture IP + UA.
 */

const path     = require('path');
const fs       = require('fs');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, 'auth.db');

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS audit_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ts           TEXT    NOT NULL DEFAULT (datetime('now')),
    user_id      INTEGER,
    username     TEXT,
    action       TEXT    NOT NULL,
    target_type  TEXT,
    target_id    TEXT,
    status       TEXT    NOT NULL CHECK (status IN ('ok','fail')),
    ip           TEXT,
    user_agent   TEXT,
    payload      TEXT,
    error        TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_audit_user_ts   ON audit_log(user_id, ts DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_action_ts ON audit_log(action, ts DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_target    ON audit_log(target_type, target_id);
`);

const insertStmt = db.prepare(`
  INSERT INTO audit_log
    (user_id, username, action, target_type, target_id, status, ip, user_agent, payload, error)
  VALUES
    (@user_id, @username, @action, @target_type, @target_id, @status, @ip, @user_agent, @payload, @error)
`);

const PAYLOAD_LIMIT = 8 * 1024;

function clientIp(req) {
  if (!req) return null;
  // Trust the first non-internal X-Forwarded-For hop if Express was set up
  // with `app.set('trust proxy', ...)`; otherwise fall back to req.ip.
  const xff = req.headers?.['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) {
    return xff.split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || null;
}

function safeStringify(payload) {
  if (payload == null) return null;
  try {
    const s = typeof payload === 'string' ? payload : JSON.stringify(payload);
    if (s.length <= PAYLOAD_LIMIT) return s;
    return s.slice(0, PAYLOAD_LIMIT - 3) + '...';
  } catch {
    return null;
  }
}

function log(opts = {}) {
  const {
    req,
    user,                  // optional explicit user object {id, username}
    action,
    targetType = null,
    targetId   = null,
    status     = 'ok',
    error      = null,
    payload    = null,
  } = opts;

  if (!action || typeof action !== 'string') {
    console.warn('[audit] dropped event: missing action');
    return;
  }
  if (status !== 'ok' && status !== 'fail') {
    console.warn(`[audit] dropped event "${action}": invalid status "${status}"`);
    return;
  }

  // Resolve user from req.user (set by requireAuth) if not passed explicitly.
  const u = user || req?.user || null;
  const targetIdStr = targetId == null ? null : String(targetId);

  try {
    insertStmt.run({
      user_id:     u?.id ?? null,
      username:    u?.username ?? null,
      action,
      target_type: targetType,
      target_id:   targetIdStr,
      status,
      ip:          clientIp(req),
      user_agent:  req?.headers?.['user-agent']?.slice(0, 512) ?? null,
      payload:     safeStringify(payload),
      error:       error ? String(error).slice(0, 1024) : null,
    });
  } catch (err) {
    // Never let audit failures break the caller. Surface to console for ops.
    console.error('[audit] failed to record event', { action, targetId: targetIdStr, err: err.message });
  }
}

/**
 * Query the audit log. All filters are optional. Newest-first.
 * Returns an array of rows.
 */
function query({
  userId   = undefined,
  action   = undefined,
  targetType = undefined,
  targetId = undefined,
  status   = undefined,
  sinceTs  = undefined,  // ISO string or SQLite-friendly 'YYYY-MM-DD HH:MM:SS'
  untilTs  = undefined,
  limit    = 100,
  offset   = 0,
} = {}) {
  const where = [];
  const params = {};

  if (userId !== undefined && userId !== null && userId !== '') {
    where.push('user_id = @userId');
    params.userId = Number(userId);
  }
  if (action) {
    // Allow wildcard suffix like 'scan.*'
    if (action.endsWith('.*')) {
      where.push('action LIKE @actionPrefix');
      params.actionPrefix = action.slice(0, -1) + '%';
    } else {
      where.push('action = @action');
      params.action = action;
    }
  }
  if (targetType) { where.push('target_type = @targetType'); params.targetType = targetType; }
  if (targetId)   { where.push('target_id   = @targetId');   params.targetId   = String(targetId); }
  if (status)     { where.push('status      = @status');     params.status     = status; }
  if (sinceTs)    { where.push('ts >= @sinceTs');            params.sinceTs    = sinceTs; }
  if (untilTs)    { where.push('ts <= @untilTs');            params.untilTs    = untilTs; }

  const sql = `
    SELECT id, ts, user_id, username, action, target_type, target_id, status, ip, user_agent, payload, error
    FROM audit_log
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY id DESC
    LIMIT @limit OFFSET @offset
  `;
  params.limit  = Math.min(Math.max(1, Number(limit) || 100), 1000);
  params.offset = Math.max(0, Number(offset) || 0);

  const rows = db.prepare(sql).all(params);
  // Parse payload back to JSON for callers; keep raw string on parse failure.
  return rows.map(r => {
    if (r.payload) {
      try { r.payload = JSON.parse(r.payload); } catch { /* leave as string */ }
    }
    return r;
  });
}

module.exports = { log, query, _db: db };

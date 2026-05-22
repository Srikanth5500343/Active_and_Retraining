/**
 * Tenant ownership helpers.
 *
 * A "rack" in this app is identified by SHA-256(image_bytes), so two
 * tenants who scan the same physical rack get the same RK-id. The output
 * artifacts on disk under `outputs/RK-XXXX/` are shared (efficient — we
 * don't re-run the pipeline). The rack_owners table records which
 * tenants have claimed each rack, so the structured-data API enforces
 * "you can only see racks your tenant has scanned."
 *
 * Schema (created in auth.js migration):
 *   rack_owners(tenant_id INTEGER, rack_id TEXT,
 *               created_by INTEGER, created_at TEXT,
 *               PRIMARY KEY (tenant_id, rack_id))
 *
 * Public API:
 *   claimRack(tenantId, rackId, userId)  — idempotent INSERT OR IGNORE
 *   tenantOwnsRack(tenantId, rackId)     → bool
 *   tenantRackIds(tenantId)              → Set<string>
 *   listRacksForTenant(tenantId, limit)  → [{rack_id, created_at, created_by}]
 *   requireRackOwnership(req, res, next) — Express middleware on
 *                                          routes that take :rackId
 */

const path = require('path');
const Database = require('better-sqlite3');
const { logger } = require('./observability');

const dbPath = path.join(__dirname, '..', 'data', 'auth.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// Prepared statements (better-sqlite3 caches by SQL text but explicit
// is faster + clearer). Created lazily so this module can be required
// before auth.js has finished its CREATE TABLE.
let _stmtClaim, _stmtOwns, _stmtList, _stmtRackIds;
function _prep() {
  if (_stmtClaim) return;
  _stmtClaim = db.prepare(
    `INSERT OR IGNORE INTO rack_owners (tenant_id, rack_id, created_by)
     VALUES (?, ?, ?)`);
  _stmtOwns = db.prepare(
    `SELECT 1 FROM rack_owners WHERE tenant_id = ? AND rack_id = ?`);
  _stmtList = db.prepare(
    `SELECT rack_id, created_at, created_by FROM rack_owners
     WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?`);
  _stmtRackIds = db.prepare(
    `SELECT rack_id FROM rack_owners WHERE tenant_id = ?`);
}

/** Record that this tenant has scanned this rack. Idempotent. */
function claimRack(tenantId, rackId, userId = null) {
  if (!tenantId || !rackId) return false;
  _prep();
  const r = _stmtClaim.run(Number(tenantId), String(rackId), userId);
  if (r.changes > 0) {
    logger.info({
      event: 'tenant.rack_claimed',
      tenantId, rackId, userId,
    }, `tenant ${tenantId} claimed rack ${rackId}`);
  }
  return r.changes > 0;
}

/** Is this rack owned by this tenant? */
function tenantOwnsRack(tenantId, rackId) {
  if (!tenantId || !rackId) return false;
  _prep();
  return !!_stmtOwns.get(Number(tenantId), String(rackId));
}

/** All rack ids this tenant owns, as a Set for fast membership checks. */
function tenantRackIds(tenantId) {
  if (!tenantId) return new Set();
  _prep();
  return new Set(_stmtRackIds.all(Number(tenantId)).map(r => r.rack_id));
}

/** Recent racks for this tenant (for the rack list endpoint). */
function listRacksForTenant(tenantId, limit = 200) {
  if (!tenantId) return [];
  _prep();
  return _stmtList.all(Number(tenantId), Math.min(Math.max(1, limit), 1000));
}

/**
 * Express middleware: gates routes that take a :rackId path param. Must
 * be installed AFTER requireAuth so req.user is available. 404 (not 403)
 * on miss so we don't leak whether the rack exists in another tenant.
 */
function requireRackOwnership(req, res, next) {
  const tenantId = req.user?.tenant_id;
  const rackId = req.params?.rackId;
  if (!tenantId) return res.status(401).json({ error: 'Authentication required' });
  if (!rackId) return res.status(400).json({ error: 'rackId required' });
  if (!tenantOwnsRack(tenantId, rackId)) {
    logger.warn({
      event: 'tenant.access_denied',
      tenantId, rackId, userId: req.user.id,
      route: req.path,
    }, `tenant ${tenantId} attempted to access rack ${rackId} (not owned)`);
    // 404 not 403 — don't reveal that the rack exists elsewhere
    return res.status(404).json({ error: 'Rack not found' });
  }
  next();
}

module.exports = {
  claimRack,
  tenantOwnsRack,
  tenantRackIds,
  listRacksForTenant,
  requireRackOwnership,
};

/**
 * Orphan garbage collection for outputs/<rackId>/.
 *
 * After multi-tenancy landed, every legitimate rack folder has at
 * least one row in the `rack_owners` table (claimed at scan time by
 * /api/analyze + /api/analyze-for-ticket + /api/analyze-video).
 *
 * Anything in outputs/ that ISN'T owned by some tenant is dead weight
 * — leftover from pre-tenancy days, manual mkdirs, or scans whose
 * tenant got deleted. This module finds them and (optionally) deletes.
 *
 * Two safety belts:
 *   1. We only target folders matching /^RK-[A-F0-9]+$/ — won't touch
 *      anything else under outputs/.
 *   2. `retentionDays` (default 14) — folder must also be older than
 *      this. Stops a race where a fresh scan's folder exists for a
 *      tick before its rack_owners row is committed.
 *
 * Usage:
 *   const { findOrphans, pruneOrphans } = require('./lib/orphan_gc');
 *   const orphans = findOrphans({ retentionDays: 14 });
 *   pruneOrphans(orphans, { dryRun: false });
 *
 * Or as a CLI:
 *   node server/lib/orphan_gc.js --dry-run
 *   node server/lib/orphan_gc.js --apply --retention-days 30
 *
 * Or via HTTP:
 *   POST /api/admin/orphan-gc/run    body: { dryRun: true|false }
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

let _logger = null;
function _log() {
  if (_logger) return _logger;
  try { _logger = require('./observability').logger; }
  catch { _logger = { info: console.log, warn: console.warn, error: console.error }; }
  return _logger;
}

const DB_PATH = path.join(__dirname, '..', 'data', 'auth.db');
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUTPUTS_DIR = path.join(REPO_ROOT, 'outputs');

const RACK_FOLDER_RE = /^RK-[A-F0-9]+$/i;

/** Return { rackId, fullPath, sizeBytes, ageDays } for every folder
 *  in outputs/ that has NO row in rack_owners and is older than the
 *  retention threshold. */
function findOrphans({
  outputsDir = OUTPUTS_DIR,
  retentionDays = 14,
} = {}) {
  if (!fs.existsSync(outputsDir)) return [];
  const db = new Database(DB_PATH, { readonly: true });
  let ownedSet;
  try {
    const rows = db.prepare('SELECT DISTINCT rack_id FROM rack_owners').all();
    ownedSet = new Set(rows.map(r => r.rack_id));
  } finally {
    db.close();
  }

  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const orphans = [];
  for (const name of fs.readdirSync(outputsDir)) {
    if (!RACK_FOLDER_RE.test(name)) continue;   // safety #1: only RK-* folders
    if (ownedSet.has(name)) continue;
    const full = path.join(outputsDir, name);
    let stat;
    try { stat = fs.statSync(full); }
    catch { continue; }
    if (!stat.isDirectory()) continue;
    if (stat.mtimeMs > cutoffMs) continue;       // safety #2: too young
    orphans.push({
      rackId:    name,
      fullPath:  full,
      sizeBytes: _dirSize(full),
      ageDays:   Math.floor((Date.now() - stat.mtimeMs) / (24 * 60 * 60 * 1000)),
    });
  }
  return orphans;
}

function _dirSize(dir) {
  let total = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      try {
        if (e.isDirectory())     total += _dirSize(full);
        else if (e.isFile())     total += fs.statSync(full).size;
      } catch { /* file vanished mid-scan, ignore */ }
    }
  } catch { /* ignore */ }
  return total;
}

function _rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    return true;
  } catch (err) {
    return false;
  }
}

/** Delete the orphans returned by findOrphans. Returns a summary. */
function pruneOrphans(orphans, { dryRun = true } = {}) {
  let removed = 0, freedBytes = 0, failed = 0;
  for (const o of orphans) {
    if (dryRun) {
      removed++;
      freedBytes += o.sizeBytes;
      continue;
    }
    if (_rmrf(o.fullPath)) {
      removed++;
      freedBytes += o.sizeBytes;
      _log().info({
        event: 'orphan_gc.removed',
        rackId: o.rackId, sizeBytes: o.sizeBytes, ageDays: o.ageDays,
      }, `pruned orphan rack folder ${o.rackId} (${(o.sizeBytes/1e6).toFixed(1)}MB)`);
    } else {
      failed++;
      _log().warn({
        event: 'orphan_gc.remove_failed',
        rackId: o.rackId, fullPath: o.fullPath,
      }, `could not remove ${o.rackId}`);
    }
  }
  return { dryRun, scanned: orphans.length, removed, freedBytes, failed };
}

/** Convenience: scan + prune. Used by CLI + HTTP endpoint. */
function run({ dryRun = true, retentionDays = 14 } = {}) {
  const orphans = findOrphans({ retentionDays });
  const summary = pruneOrphans(orphans, { dryRun });
  summary.retentionDays = retentionDays;
  summary.orphans = orphans.map(o => ({
    rackId: o.rackId, sizeBytes: o.sizeBytes, ageDays: o.ageDays,
  }));
  return summary;
}

module.exports = { findOrphans, pruneOrphans, run, RACK_FOLDER_RE };

// ── CLI ────────────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--apply');
  const ix = args.indexOf('--retention-days');
  const retentionDays = ix >= 0 ? Number(args[ix + 1]) || 14 : 14;
  const summary = run({ dryRun, retentionDays });
  console.log(JSON.stringify(summary, null, 2));
  if (dryRun && summary.scanned > 0) {
    console.log(`\nDry run only — re-run with --apply to actually delete.`);
  }
}

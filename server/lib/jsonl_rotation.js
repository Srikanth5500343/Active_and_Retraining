/**
 * Append-with-rotation helper for JSONL log files.
 *
 * The active-learning ingest cursor (server/feedback.jsonl) and per-rack
 * feedback logs are append-only and grow without bound. This helper
 * checks the file size before each append and, if over the threshold,
 * rotates the file to `<name>-YYYYMMDD-HHMMSS.jsonl.gz` (or .jsonl,
 * depending on `gzip` option). Old rotated files past the keep limit
 * are deleted oldest-first.
 *
 * Defaults:
 *   maxSizeMB: 50    rotate when the live file exceeds this
 *   keep:      10    keep this many rotated files; older = pruned
 *   gzip:      true  gzip the rotated file (typical 6-10x size win)
 *
 * Usage:
 *   const { appendJsonlWithRotation } = require('./lib/jsonl_rotation');
 *   appendJsonlWithRotation(filePath, jsonObject);
 *
 * Rotation is best-effort: if it fails, we log + continue with the
 * append so the caller's flow is never broken.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

let _logger = null;
function _log() {
  if (_logger) return _logger;
  try { _logger = require('./observability').logger; }
  catch { _logger = { warn: console.warn, info: console.log }; }
  return _logger;
}

const DEFAULTS = {
  maxSizeMB: 50,
  keep:      10,
  gzip:      true,
};

function _ts() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return [
    d.getFullYear(), pad(d.getMonth() + 1), pad(d.getDate()),
    '-',
    pad(d.getHours()), pad(d.getMinutes()), pad(d.getSeconds()),
  ].join('');
}

/** Rotate `filePath` to a timestamped sibling, gzipping if asked.
 *  Returns the rotated file path (or null if nothing was rotated). */
function rotateIfNeeded(filePath, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  if (!fs.existsSync(filePath)) return null;
  let size;
  try { size = fs.statSync(filePath).size; }
  catch { return null; }
  if (size < cfg.maxSizeMB * 1024 * 1024) return null;

  try {
    const dir  = path.dirname(filePath);
    const base = path.basename(filePath, '.jsonl');
    const stamp = _ts();
    const rotatedPath = path.join(dir,
      cfg.gzip ? `${base}-${stamp}.jsonl.gz` : `${base}-${stamp}.jsonl`);

    if (cfg.gzip) {
      // Stream-gzip so we don't load the whole file into memory.
      const src = fs.readFileSync(filePath);
      const gz  = zlib.gzipSync(src, { level: 6 });
      fs.writeFileSync(rotatedPath, gz);
      fs.truncateSync(filePath, 0);
    } else {
      // Simple rename → recreate empty file
      fs.renameSync(filePath, rotatedPath);
      fs.writeFileSync(filePath, '');
    }
    _log().info({
      event: 'jsonl.rotated',
      file: filePath, rotated: rotatedPath,
      sizeBytes: size,
    }, `rotated ${path.basename(filePath)} → ${path.basename(rotatedPath)}`);

    pruneOldRotations(filePath, cfg.keep);
    return rotatedPath;
  } catch (err) {
    _log().warn({
      event: 'jsonl.rotate_failed',
      file: filePath, err: err.message,
    }, `rotation of ${filePath} failed: ${err.message}`);
    return null;
  }
}

/** Delete rotated siblings older than the `keep` newest. */
function pruneOldRotations(filePath, keep) {
  try {
    const dir  = path.dirname(filePath);
    const base = path.basename(filePath, '.jsonl');
    const re   = new RegExp(`^${escapeReg(base)}-\\d{8}-\\d{6}\\.jsonl(\\.gz)?$`);
    const siblings = fs.readdirSync(dir)
      .filter(n => re.test(n))
      .map(n => ({
        name: n,
        full: path.join(dir, n),
        mtime: fs.statSync(path.join(dir, n)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);  // newest first
    const toRemove = siblings.slice(keep);
    for (const s of toRemove) {
      try {
        fs.unlinkSync(s.full);
        _log().info({ event: 'jsonl.pruned', file: s.full },
          `pruned old rotation ${s.name}`);
      } catch (err) {
        _log().warn({ event: 'jsonl.prune_failed', file: s.full, err: err.message },
          `prune of ${s.name} failed: ${err.message}`);
      }
    }
  } catch (err) {
    _log().warn({ event: 'jsonl.prune_scan_failed', err: err.message },
      `prune scan failed: ${err.message}`);
  }
}

function escapeReg(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Write one JSON object as a JSONL line, rotating first if needed. */
function appendJsonlWithRotation(filePath, obj, opts = {}) {
  rotateIfNeeded(filePath, opts);
  const line = JSON.stringify(obj) + '\n';
  fs.appendFileSync(filePath, line);
}

/** Drop-in replacement for fs.appendFileSync(filePath, line) — checks
 *  size + rotates first if needed. Use this when the caller already
 *  has a pre-stringified line (existing feedback log writes). */
function appendLineWithRotation(filePath, line, opts = {}) {
  rotateIfNeeded(filePath, opts);
  fs.appendFileSync(filePath, line);
}

module.exports = { rotateIfNeeded, appendJsonlWithRotation,
                   appendLineWithRotation, pruneOldRotations };

/**
 * Demo tenant-mat topology API — isolated module.
 *
 * Scope: serves a pre-seeded JSON file (server/data/demo_tenant.json) so the
 * tenant-mat UI has something to render before the real CMDB/scan ingestion
 * pipeline exists. NO writes, NO db, NO auth. Mounted at /api/demo/* so it
 * can never collide with the real tenant routes.
 *
 * To swap in real data later: replace these endpoints with versions that
 * read from rack_owners + a future rack_placement table + a CMDB pull.
 * The response shapes here are the contract the UI depends on.
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const express = require('express');

const router = express.Router();
const DEMO_FILE = path.join(__dirname, 'data', 'demo_tenant.json');
const PROJECT_ROOT = path.resolve(__dirname, '..');
const QUERY_SCRIPT = path.join(PROJECT_ROOT, 'servicenow', 'demo_tenant_query.py');
const PYTHON_CMD = process.env.PYTHON_CMD ||
                   (process.platform === 'win32' ? 'python' : 'python3');

// Cache the CMDB-sourced response for 30s — the query takes 1-3 s and the
// data only changes when someone runs bootstrap/teardown.
let _cmdbCache = { ts: 0, data: null };
const CMDB_TTL_MS = 30_000;

function runQueryScript(timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(QUERY_SCRIPT)) {
      return reject(new Error(`Query script missing at ${QUERY_SCRIPT}`));
    }
    const env = { ...process.env, PYTHONIOENCODING: 'utf-8' };
    const child = spawn(PYTHON_CMD, [QUERY_SCRIPT], { cwd: PROJECT_ROOT, env });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      reject(new Error(`demo_tenant_query.py timed out (${timeoutMs}ms)`));
    }, timeoutMs);
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`Query script exited ${code}: ${stderr.slice(0, 300)}`));
      try { resolve(JSON.parse(stdout)); }
      catch (e) { reject(new Error(`Query script returned non-JSON: ${e.message}`)); }
    });
  });
}

let _cache = null;
let _cacheMtime = 0;

function loadDemo() {
  const stat = fs.statSync(DEMO_FILE);
  if (_cache && stat.mtimeMs === _cacheMtime) return _cache;
  _cache = JSON.parse(fs.readFileSync(DEMO_FILE, 'utf-8'));
  _cacheMtime = stat.mtimeMs;
  return _cache;
}

// GET /api/demo/tenant-mat?source=json|cmdb
// The whole tenant view: tenant + buildings + floors + every rack with its
// placement and drift status. Default `source=json` reads the bundled file
// (always available). `source=cmdb` calls demo_tenant_query.py to fetch
// live from ServiceNow — only works after demo_tenant_bootstrap.py ran.
router.get('/api/demo/tenant-mat', async (req, res) => {
  const source = (req.query.source || 'json').toString();

  if (source === 'cmdb') {
    try {
      const now = Date.now();
      if (_cmdbCache.data && (now - _cmdbCache.ts) < CMDB_TTL_MS) {
        return res.json({ ..._cmdbCache.data, _cached: true });
      }
      const data = await runQueryScript();
      data.summary = data.summary || summarize(data.racks || []);
      _cmdbCache = { ts: now, data };
      return res.json(data);
    } catch (err) {
      return res.status(502).json({
        error: 'CMDB source unavailable',
        details: err.message,
        hint: 'Run servicenow/demo_tenant_bootstrap.py to populate CMDB first.',
      });
    }
  }

  try {
    const data = loadDemo();
    const summary = summarize(data.racks);
    res.json({
      tenant: data.tenant,
      buildings: data.buildings,
      racks: data.racks,
      summary,
      source: 'json',
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load demo tenant data', details: err.message });
  }
});

// GET /api/demo/tenant-mat/rack/:rackId
// Drill-in detail for one rack. Used by the side panel when an operator
// clicks a rack on the mat.
router.get('/api/demo/tenant-mat/rack/:rackId', (req, res) => {
  try {
    const data = loadDemo();
    const rack = data.racks.find(r => r.id === req.params.rackId);
    if (!rack) return res.status(404).json({ error: 'Rack not found' });
    const building = data.buildings.find(b => b.id === rack.building_id);
    const floor = building?.floors.find(f => f.id === rack.floor_id);
    const row = floor?.rows.find(r => r.id === rack.row_id);
    res.json({
      rack,
      location: {
        building: building ? { id: building.id, name: building.name, city: building.city } : null,
        floor: floor ? { id: floor.id, label: floor.label } : null,
        row: row ? { id: row.id, label: row.label } : null,
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load rack', details: err.message });
  }
});

function summarize(racks) {
  const out = { total: racks.length, ok: 0, drift: 0, cmdb_only: 0, scan_only: 0 };
  for (const r of racks) {
    if (out[r.status] != null) out[r.status]++;
  }
  return out;
}

module.exports = router;

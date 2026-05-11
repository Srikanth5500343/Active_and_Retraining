// Port history + drift API.
//
// Exposes the time-series and change-event data produced by port_poller
// to the client. Routes:
//   GET    /api/ports/devices                    — list monitored switches
//   POST   /api/ports/devices                    — add one (body: host, vendor, label)
//   PATCH  /api/ports/devices/:id                — { enabled: 0|1 }
//   DELETE /api/ports/devices/:id
//   GET    /api/ports/:deviceId/overview         — latest snapshot per port
//   GET    /api/ports/:deviceId/events           — recent events across device
//   GET    /api/ports/:deviceId/:port/events     — events for one port
//   GET    /api/ports/:deviceId/:port/history    — Arista-modal shape:
//                                                  current state + value at
//                                                  1h / 3h / 12h / 1d / 1w ago
//                                                  + recent change events
//   POST   /api/ports/:deviceId/poll             — trigger a poll now
//
// All routes require auth.

const express = require('express');
const router  = express.Router();

const auth    = require('./auth');
const portsDb = require('./lib/port_history_db');
const poller  = require('./lib/port_poller');
const { logger } = require('./lib/observability');

router.use('/api/ports', auth.requireAuth);

function safeAsync(handler) {
  return async (req, res) => {
    try { await handler(req, res); }
    catch (err) {
      const status = err.statusCode || 500;
      logger?.error?.(`[port_history] ${req.method} ${req.originalUrl} — ${err.message}`);
      res.status(status).json({ error: err.message });
    }
  };
}

// ── monitored_devices ────────────────────────────────────────────────
// Listing is the only "device discovery" the client gets. host / ssh_port
// stay server-side; the UI works off the display_name (system name /
// model / serial) returned by toClientView.
router.get('/api/ports/devices', safeAsync(async (_req, res) => {
  res.json({ devices: portsDb.listDevices().map(portsDb.toClientView) });
}));

// ── snapshots / overview ─────────────────────────────────────────────
router.get('/api/ports/:deviceId/overview', safeAsync(async (req, res) => {
  const id = Number(req.params.deviceId);
  const device = portsDb.getDevice(id);
  if (!device) return res.status(404).json({ error: 'device not found' });
  res.json({
    device: portsDb.toClientView(device),
    ports:  portsDb.latestSnapshotsForDevice(id),
  });
}));

// ── per-device events ────────────────────────────────────────────────
router.get('/api/ports/:deviceId/events', safeAsync(async (req, res) => {
  const id    = Number(req.params.deviceId);
  const limit = Math.min(Number(req.query.limit) || 500, 5000);
  if (!portsDb.getDevice(id)) return res.status(404).json({ error: 'device not found' });
  res.json({ events: portsDb.eventsForDevice(id, limit) });
}));

// ── per-port events ──────────────────────────────────────────────────
router.get('/api/ports/:deviceId/:port/events', safeAsync(async (req, res) => {
  const id    = Number(req.params.deviceId);
  const port  = req.params.port;
  const limit = Math.min(Number(req.query.limit) || 200, 5000);
  if (!portsDb.getDevice(id)) return res.status(404).json({ error: 'device not found' });
  res.json({ events: portsDb.eventsForPort(id, port, limit) });
}));

// ── per-port "history" — the Arista-modal shape ──────────────────────
//   { current, offsets: { '1h': snap, '3h': snap, ... }, events: [...] }
//
// `current` is the most recent snapshot. `offsets` answer "what was
// this port's state N ago" by picking MAX(ts) WHERE ts <= now-N — so
// even though we only write snapshots on change, the lookup returns a
// real value as long as the port has been polled at least once.
const OFFSETS = [
  ['1h',  60 * 60 * 1000],
  ['3h',  3  * 60 * 60 * 1000],
  ['12h', 12 * 60 * 60 * 1000],
  ['1d',  24 * 60 * 60 * 1000],
  ['1w',  7  * 24 * 60 * 60 * 1000],
];

router.get('/api/ports/:deviceId/:port/history', safeAsync(async (req, res) => {
  const id   = Number(req.params.deviceId);
  const port = req.params.port;
  if (!portsDb.getDevice(id)) return res.status(404).json({ error: 'device not found' });
  const now = Date.now();
  const offsets = {};
  for (const [label, ms] of OFFSETS) {
    offsets[label] = portsDb.snapshotAt(id, port, new Date(now - ms).toISOString());
  }
  res.json({
    current: portsDb.latestSnapshot(id, port),
    offsets,
    events:  portsDb.eventsForPort(id, port, 200),
  });
}));

// Timeline data for the stacked-bar visualization: every snapshot
// within `windowSec` (default 1h), plus the snapshot that was current
// at the window start so the leading edge of each bar has a value.
// The client uses these to build per-field {from, to, value} segments.
router.get('/api/ports/:deviceId/:port/timeline', safeAsync(async (req, res) => {
  const id   = Number(req.params.deviceId);
  const port = req.params.port;
  if (!portsDb.getDevice(id)) return res.status(404).json({ error: 'device not found' });
  const windowSec = Math.max(60, Math.min(Number(req.query.window) || 3600, 7 * 24 * 3600));
  const endMs   = Date.now();
  const startMs = endMs - windowSec * 1000;
  const startIso = new Date(startMs).toISOString();
  const endIso   = new Date(endMs).toISOString();
  res.json({
    start_at:  startIso,
    end_at:    endIso,
    initial:   portsDb.snapshotAt(id, port, startIso),
    snapshots: portsDb.snapshotsBetween(id, port, startIso, endIso),
  });
}));

// ── manual poll trigger (debugging) ──────────────────────────────────
router.post('/api/ports/:deviceId/poll', safeAsync(async (req, res) => {
  const id = Number(req.params.deviceId);
  const device = portsDb.getDevice(id);
  if (!device) return res.status(404).json({ error: 'device not found' });
  await poller.pollDevice(device);
  res.json({ ok: true, device });
}));

module.exports = router;

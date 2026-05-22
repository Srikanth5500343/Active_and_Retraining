// Port-history store.
//
// Backs the "continuous polling / port drift" feature: a poller (see
// port_poller.js) SSHes into each monitored switch on a timer, parses
// the per-port state, and feeds it through writePoll() below — which
// diffs against the most-recent stored snapshot and persists both the
// new full-state snapshot AND one row per changed field in port_events.
//
// Storage strategy: we only write a snapshot when SOMETHING changed,
// so port_snapshots is event-sourced. To answer "what was the state at
// time T" the API picks MAX(ts) WHERE ts <= T for that (device, port).
//
// Tables:
//   monitored_devices(id, host, ssh_port, vendor, label, enabled, created_at)
//   port_snapshots   (id, device_id, port, ts, oper, admin, speed_mbps,
//                     duplex, flowctrl, medium, descr)
//   port_events      (id, device_id, port, field, from_val, to_val, at)

const path = require('path');
const Database = require('better-sqlite3');

const dbPath = path.join(__dirname, '..', 'data', 'auth.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS monitored_devices (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    host        TEXT NOT NULL UNIQUE,
    ssh_port    INTEGER NOT NULL DEFAULT 22,
    vendor      TEXT NOT NULL DEFAULT 'tplink',
    label       TEXT,
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    system_name        TEXT,
    system_description TEXT,
    system_location    TEXT,
    model       TEXT,
    serial      TEXT,
    sw_version  TEXT,
    hw_version  TEXT,
    mac         TEXT,
    last_seen   TEXT
  );

  CREATE TABLE IF NOT EXISTS port_snapshots (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id    INTEGER NOT NULL,
    port         TEXT NOT NULL,
    ts           TEXT NOT NULL,
    oper         TEXT,
    admin        TEXT,
    speed_mbps   INTEGER,
    duplex       TEXT,
    flowctrl     TEXT,
    medium       TEXT,
    descr        TEXT,
    lldp_chassis TEXT,
    lldp_port    TEXT,
    lldp_system  TEXT,
    FOREIGN KEY (device_id) REFERENCES monitored_devices(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_snap_dev_port_ts
    ON port_snapshots(device_id, port, ts DESC);

  CREATE TABLE IF NOT EXISTS port_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id   INTEGER NOT NULL,
    port        TEXT NOT NULL,
    field       TEXT NOT NULL,
    from_val    TEXT,
    to_val      TEXT,
    at          TEXT NOT NULL,
    FOREIGN KEY (device_id) REFERENCES monitored_devices(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_evt_dev_port_at
    ON port_events(device_id, port, at DESC);
  CREATE INDEX IF NOT EXISTS idx_evt_dev_at
    ON port_events(device_id, at DESC);
`);

// Lazy column migration — tolerates DBs created by an earlier release
// that didn't have the newer columns. ALTER TABLE ADD COLUMN throws
// "duplicate column" if it already exists; that's fine.
const META_COLS = [
  'system_name',  'system_description', 'system_location',
  'model', 'serial', 'sw_version', 'hw_version', 'mac', 'last_seen',
];
const existingMetaCols = new Set(
  db.prepare(`PRAGMA table_info(monitored_devices)`).all().map((r) => r.name)
);
for (const col of META_COLS) {
  if (existingMetaCols.has(col)) continue;
  db.exec(`ALTER TABLE monitored_devices ADD COLUMN ${col} TEXT`);
}
const SNAPSHOT_META_COLS = ['lldp_chassis', 'lldp_port', 'lldp_system'];
const existingSnapCols = new Set(
  db.prepare(`PRAGMA table_info(port_snapshots)`).all().map((r) => r.name)
);
for (const col of SNAPSHOT_META_COLS) {
  if (existingSnapCols.has(col)) continue;
  db.exec(`ALTER TABLE port_snapshots ADD COLUMN ${col} TEXT`);
}

// Auto-seed: if no devices exist, insert the default bench TP-Link.
// Host comes from env (TPLINK_BENCH_HOST) so we don't bake an IP into
// source. Falls back to the captured-fixture address as a last resort.
const DEFAULT_HOST   = process.env.TPLINK_BENCH_HOST || '192.168.1.13';
const DEFAULT_VENDOR = 'tplink';
const seedCount = db.prepare(`SELECT COUNT(*) AS n FROM monitored_devices`).get().n;
if (seedCount === 0) {
  db.prepare(`
    INSERT INTO monitored_devices (host, ssh_port, vendor, enabled)
    VALUES (?, 22, ?, 1)
  `).run(DEFAULT_HOST, DEFAULT_VENDOR);
}

const TRACKED_FIELDS = [
  'oper', 'admin', 'speed_mbps', 'duplex', 'flowctrl', 'medium', 'descr',
  'lldp_chassis', 'lldp_port', 'lldp_system',
];

// ── monitored_devices ────────────────────────────────────────────────
const stmtListDevices    = db.prepare(`SELECT * FROM monitored_devices ORDER BY id`);
const stmtListEnabled    = db.prepare(`SELECT * FROM monitored_devices WHERE enabled = 1 ORDER BY id`);
const stmtGetDevice      = db.prepare(`SELECT * FROM monitored_devices WHERE id = ?`);
const stmtGetDeviceHost  = db.prepare(`SELECT * FROM monitored_devices WHERE host = ?`);
const stmtInsertDevice   = db.prepare(`
  INSERT INTO monitored_devices (host, ssh_port, vendor, label, enabled)
  VALUES (@host, @ssh_port, @vendor, @label, @enabled)
`);
const stmtUpdateEnabled  = db.prepare(`UPDATE monitored_devices SET enabled = ? WHERE id = ?`);
const stmtDeleteDevice   = db.prepare(`DELETE FROM monitored_devices WHERE id = ?`);

function listDevices({ enabledOnly = false } = {}) {
  return (enabledOnly ? stmtListEnabled : stmtListDevices).all();
}
function getDevice(id) { return stmtGetDevice.get(id); }
function getDeviceByHost(host) { return stmtGetDeviceHost.get(host); }
function addDevice({ host, ssh_port = 22, vendor = 'tplink', label = null, enabled = 1 }) {
  const info = stmtInsertDevice.run({ host, ssh_port, vendor, label, enabled });
  return getDevice(info.lastInsertRowid);
}
function setEnabled(id, enabled) { stmtUpdateEnabled.run(enabled ? 1 : 0, id); }
function deleteDevice(id) { stmtDeleteDevice.run(id); }

// Update device metadata from `show system-info`. Only writes columns
// that were provided (non-null) so a transient parse miss doesn't blank
// out previously-recorded values.
function updateDeviceMetadata(id, meta = {}) {
  const writable = [
    'system_name', 'system_description', 'system_location',
    'model', 'serial', 'sw_version', 'hw_version', 'mac',
  ];
  const sets = [];
  const args = [];
  for (const col of writable) {
    if (meta[col] != null && meta[col] !== '') {
      sets.push(`${col} = ?`);
      args.push(String(meta[col]));
    }
  }
  sets.push(`last_seen = ?`);
  args.push(new Date().toISOString());
  args.push(id);
  db.prepare(`UPDATE monitored_devices SET ${sets.join(', ')} WHERE id = ?`).run(...args);
}

// Strip operationally-sensitive fields (host, ssh_port) from a device
// row before returning it to the client. The UI works off id + a human
// label, never the IP — that stays a server-side concern.
function toClientView(d) {
  if (!d) return null;
  const display = d.system_name || d.label || d.model || `Switch #${d.id}`;
  return {
    id:                 d.id,
    vendor:             d.vendor,
    enabled:            d.enabled,
    display_name:       display,
    system_name:        d.system_name,
    system_description: d.system_description,
    system_location:    d.system_location,
    model:              d.model,
    serial:             d.serial,
    sw_version:         d.sw_version,
    hw_version:         d.hw_version,
    mac:                d.mac,
    last_seen:          d.last_seen,
  };
}

// ── snapshots ────────────────────────────────────────────────────────
const stmtLatestSnapshot = db.prepare(`
  SELECT * FROM port_snapshots
   WHERE device_id = ? AND port = ?
   ORDER BY ts DESC LIMIT 1
`);
const stmtSnapshotAtOrBefore = db.prepare(`
  SELECT * FROM port_snapshots
   WHERE device_id = ? AND port = ? AND ts <= ?
   ORDER BY ts DESC LIMIT 1
`);
const stmtSnapshotsRange = db.prepare(`
  SELECT * FROM port_snapshots
   WHERE device_id = ? AND port = ? AND ts >= ? AND ts <= ?
   ORDER BY ts ASC
`);
const stmtLatestAllPorts = db.prepare(`
  SELECT s.* FROM port_snapshots s
   JOIN (
     SELECT port, MAX(ts) AS max_ts
       FROM port_snapshots WHERE device_id = ?
      GROUP BY port
   ) m ON m.port = s.port AND m.max_ts = s.ts
   WHERE s.device_id = ?
   ORDER BY s.port
`);
const stmtInsertSnapshot = db.prepare(`
  INSERT INTO port_snapshots
    (device_id, port, ts, oper, admin, speed_mbps, duplex, flowctrl, medium, descr,
     lldp_chassis, lldp_port, lldp_system)
  VALUES
    (@device_id, @port, @ts, @oper, @admin, @speed_mbps, @duplex, @flowctrl, @medium, @descr,
     @lldp_chassis, @lldp_port, @lldp_system)
`);

function latestSnapshot(deviceId, port) { return stmtLatestSnapshot.get(deviceId, port); }
function latestSnapshotsForDevice(deviceId) { return stmtLatestAllPorts.all(deviceId, deviceId); }
function snapshotAt(deviceId, port, isoTs) { return stmtSnapshotAtOrBefore.get(deviceId, port, isoTs); }
function snapshotsBetween(deviceId, port, fromIso, toIso) {
  return stmtSnapshotsRange.all(deviceId, port, fromIso, toIso);
}

// ── events ───────────────────────────────────────────────────────────
const stmtEventsForPort = db.prepare(`
  SELECT * FROM port_events
   WHERE device_id = ? AND port = ?
   ORDER BY at DESC LIMIT ?
`);
const stmtEventsForDevice = db.prepare(`
  SELECT * FROM port_events
   WHERE device_id = ?
   ORDER BY at DESC LIMIT ?
`);
const stmtInsertEvent = db.prepare(`
  INSERT INTO port_events (device_id, port, field, from_val, to_val, at)
  VALUES (@device_id, @port, @field, @from_val, @to_val, @at)
`);

function eventsForPort(deviceId, port, limit = 200) {
  return stmtEventsForPort.all(deviceId, port, limit);
}
function eventsForDevice(deviceId, limit = 500) {
  return stmtEventsForDevice.all(deviceId, limit);
}

// ── core write path ──────────────────────────────────────────────────
// Called by the poller once per port per poll. `row` is the merged
// per-port state from the TP-Link parser. Returns the list of detected
// changes (possibly empty). All writes happen in one transaction so
// snapshot + events are atomic.
const writePollTxn = db.transaction((deviceId, row, ts) => {
  const prev = latestSnapshot(deviceId, row.port);
  const changes = [];
  if (prev) {
    for (const f of TRACKED_FIELDS) {
      const a = normForCompare(prev[f]);
      const b = normForCompare(row[f]);
      if (a !== b) {
        changes.push({ field: f, from: prev[f] ?? null, to: row[f] ?? null });
      }
    }
    if (changes.length === 0) return changes;
  }
  // First-ever snapshot OR something changed → write a fresh snapshot
  stmtInsertSnapshot.run({
    device_id: deviceId,
    port:      row.port,
    ts,
    oper:         row.oper         ?? null,
    admin:        row.admin        ?? null,
    speed_mbps:   row.speed_mbps   ?? null,
    duplex:       row.duplex       ?? null,
    flowctrl:     row.flowctrl     ?? null,
    medium:       row.medium       ?? null,
    descr:        row.descr        ?? null,
    lldp_chassis: row.lldp_chassis ?? null,
    lldp_port:    row.lldp_port    ?? null,
    lldp_system:  row.lldp_system  ?? null,
  });
  for (const c of changes) {
    stmtInsertEvent.run({
      device_id: deviceId,
      port:      row.port,
      field:     c.field,
      from_val:  c.from == null ? null : String(c.from),
      to_val:    c.to   == null ? null : String(c.to),
      at:        ts,
    });
  }
  return changes;
});

function writePoll(deviceId, row, ts = new Date().toISOString()) {
  return writePollTxn(deviceId, row, ts);
}

function normForCompare(v) {
  if (v === null || v === undefined) return null;
  return String(v);
}

module.exports = {
  TRACKED_FIELDS,
  listDevices, getDevice, getDeviceByHost,
  addDevice, setEnabled, deleteDevice,
  updateDeviceMetadata, toClientView,
  latestSnapshot, latestSnapshotsForDevice, snapshotAt, snapshotsBetween,
  eventsForPort, eventsForDevice,
  writePoll,
};

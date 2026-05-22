// Port-state poller.
//
// On a fixed interval (default 60s), SSHes into every enabled row in
// monitored_devices, runs the vendor's "hot" commands, parses the
// output, and feeds each per-port row to port_history_db.writePoll
// — which handles diff vs the prior snapshot and atomic write of
// snapshot + change events. Drives the "what changed when" timeline.
//
// One persistent SSH session per device per poll cycle (re-opened each
// poll, not held across polls — keeps the poller stateless and tolerant
// of brief network blips). For one bench switch this is plenty.
//
// Public API: start({intervalMs}) → stop()

const { logger } = require('./observability');
const sshCreds   = require('./ssh-creds');
const portsDb    = require('./port_history_db');
const tplink     = require('./tplink_parser');

const DEFAULT_INTERVAL_MS = 60_000;

// Per-vendor recipe: the SSH command runner needs (enable, paging_off,
// commands list) and the parser turns raw outputs → per-port rows + a
// device-meta blob (from `show system-info`). Keep this self-contained
// so adding cisco/dlink later is a copy-paste.
const VENDOR_RECIPES = {
  tplink: {
    enable:    'enable',
    pagingOff: 'disable pager',
    commands: [
      { key: 'sysinfo', cmd: 'show system-info' },
      { key: 'status',  cmd: 'show interface status' },
      { key: 'config',  cmd: 'show interface configuration' },
      // All-port LLDP in one shot — much cheaper than 28 per-port calls.
      // A neighbor change here lets the diff path emit drift events on
      // lldp_chassis / lldp_port / lldp_system (catches cable reroutes
      // that don't affect oper/speed).
      { key: 'lldp',    cmd: 'show lldp neighbor-information' },
    ],
    parse(outputs) {
      const status = tplink.parseInterfaceStatus(outputs.status || '');
      const config = tplink.parseInterfaceConfiguration(outputs.config || '');
      const lldp   = tplink.parseLldpNeighbors(outputs.lldp || '');
      const meta   = tplink.parseSystemInfo(outputs.sysinfo || '');
      return { rows: tplink.mergePortRows(status, config, lldp), meta };
    },
  },
};

let _timer = null;
let _runSwitchCommandsSequential = null;
let _busy = new Set();   // device-ids currently mid-poll, prevents overlap

// app.js owns the SSH runner — inject it on start() to avoid a require
// cycle (app.js itself loads this module indirectly via the router).
function setSshRunner(fn) { _runSwitchCommandsSequential = fn; }

async function pollDevice(device) {
  if (_busy.has(device.id)) return; // previous poll still in flight
  _busy.add(device.id);
  const recipe = VENDOR_RECIPES[device.vendor];
  if (!recipe) {
    logger?.warn?.(`[port_poller] no recipe for vendor=${device.vendor}, skipping ${device.host}`);
    _busy.delete(device.id);
    return;
  }
  if (!_runSwitchCommandsSequential) {
    logger?.warn?.(`[port_poller] SSH runner not injected — skipping ${device.host}`);
    _busy.delete(device.id);
    return;
  }
  const creds = sshCreds.getForVendor(device.vendor);
  if (!creds || !creds.username) {
    logger?.warn?.(`[port_poller] no SSH creds for vendor=${device.vendor}, skipping ${device.host}`);
    _busy.delete(device.id);
    return;
  }

  const outputs = {};
  const cmdList = recipe.commands.map((c) => ({ name: c.key, cmd: c.cmd }));
  try {
    await _runSwitchCommandsSequential({
      host:     device.host,
      port:     device.ssh_port || 22,
      username: creds.username,
      password: creds.password,
      enable:          recipe.enable,
      enablePassword:  creds.enablePassword || creds.password,
      pagingOff:       recipe.pagingOff,
      commands: cmdList,
      timeoutMsPerCmd: 15_000,
      onEntry: (_i, entry) => {
        if (entry && entry.name && !entry.error) outputs[entry.name] = entry.output || '';
      },
    });
  } catch (err) {
    logger?.warn?.(`[port_poller] SSH failed for ${device.host}: ${err.message}`);
    _busy.delete(device.id);
    return;
  }

  let parsed;
  try {
    parsed = recipe.parse(outputs);
  } catch (err) {
    logger?.error?.(`[port_poller] parse failed for ${device.host}: ${err.message}`);
    _busy.delete(device.id);
    return;
  }
  const { rows, meta } = parsed;

  if (meta && Object.values(meta).some((v) => v != null && v !== '')) {
    try { portsDb.updateDeviceMetadata(device.id, meta); }
    catch (err) { logger?.warn?.(`[port_poller] meta update failed: ${err.message}`); }
  }

  const ts = new Date().toISOString();
  let totalChanges = 0;
  for (const row of rows) {
    const changes = portsDb.writePoll(device.id, row, ts);
    totalChanges += changes.length;
  }
  if (totalChanges > 0) {
    logger?.info?.(`[port_poller] ${device.host}: ${rows.length} ports polled, ${totalChanges} drift event(s)`);
  }
  _busy.delete(device.id);
}

async function pollAll() {
  const devices = portsDb.listDevices({ enabledOnly: true });
  if (devices.length === 0) return;
  await Promise.all(devices.map((d) => pollDevice(d).catch((e) => {
    logger?.error?.(`[port_poller] uncaught for ${d.host}: ${e.message}`);
  })));
}

function start({ intervalMs = DEFAULT_INTERVAL_MS, sshRunner } = {}) {
  if (_timer) return;
  if (sshRunner) setSshRunner(sshRunner);
  // Kick off an immediate poll so the first snapshot lands without
  // waiting a full interval. Errors are swallowed (logged inside).
  pollAll();
  _timer = setInterval(pollAll, intervalMs);
  if (typeof _timer.unref === 'function') _timer.unref(); // don't block exit
  logger?.info?.(`[port_poller] started, interval=${intervalMs}ms`);
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { start, stop, setSshRunner, pollAll, pollDevice };

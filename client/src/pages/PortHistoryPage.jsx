import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiUrl, authFetch } from '../utils/api';
import styles from './PortHistoryPage.module.css';

// "Continuous polling & port drift" view — the client side of
// /api/ports/*. Auto-targets the single monitored switch (host /
// credentials live server-side and are intentionally not exposed).
// The interface-detail panel mirrors the Arista CloudVision layout:
// Interface Details + Interface Status (stacked-bar timeline) +
// Interface Configuration + Maintenance State + change log.

const OVERVIEW_REFRESH_MS = 15_000;
const HISTORY_REFRESH_MS  = 15_000;
const TIMELINE_REFRESH_MS = 20_000;

const WINDOW_OPTIONS = [
  { key: '1h',  label: 'Last 1 Hour',  sec: 3600 },
  { key: '3h',  label: 'Last 3 Hours', sec: 3  * 3600 },
  { key: '12h', label: 'Last 12 Hours',sec: 12 * 3600 },
  { key: '1d',  label: 'Last 1 Day',   sec: 24 * 3600 },
  { key: '1w',  label: 'Last 1 Week',  sec: 7  * 24 * 3600 },
];
const OFFSET_KEYS = ['1h', '3h', '12h', '1d', '1w'];

// Bars rendered in the Interface Status timeline. Mirrors the four
// rows in the Arista screenshot — we just substitute Flow Control for
// "Auto Negotiation Status" since TP-Link surfaces the former, not the
// latter. Each bar has a colour function so transitions are obvious at
// a glance.
const TIMELINE_BARS = [
  {
    label: 'Administrative State', field: 'admin',
    colorOf: (v) => v === 'enabled'  ? '#2563eb'
                  : v === 'disabled' ? '#475569'
                  : '#334155',
    formatValue: (v) => v ? v.charAt(0).toUpperCase() + v.slice(1) : '—',
  },
  {
    label: 'Flow Control',         field: 'flowctrl',
    colorOf: (v) => v === 'Enable'  ? '#a78bfa'
                  : v === 'Disable' ? '#475569'
                  : '#334155',
    formatValue: (v) => v || 'Off',
  },
  {
    label: 'Operational Status',   field: 'oper',
    colorOf: (v) => v === 'up'   ? '#ef4444'   // Arista uses red for the row colour
                  : v === 'down' ? '#7f1d1d'
                  : '#334155',
    // Render label as Up / Down — the colour itself signals state
    formatValue: (v) => v ? v.toUpperCase() : '—',
  },
  {
    label: 'Speed',                field: 'speed_mbps',
    colorOf: (v) => v ? '#93c5fd' : '#334155',
    formatValue: (v) => fmtSpeed(v),
  },
  {
    label: 'LLDP Neighbor',        field: 'lldp_system',
    // Hash the neighbor name to a stable colour so identity is obvious
    // at a glance — different segments → different colours → cable was
    // re-routed to a different switch / host.
    colorOf: (v) => v ? hashColor(v) : '#334155',
    formatValue: (v) => v || 'none',
  },
];

// Stable string → hex colour map used by the LLDP bar so each neighbour
// name gets a consistent hue across renders. Deliberately avoids the
// reds/greens used by the operational bar so the two are distinguishable.
function hashColor(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const palette = ['#6366f1', '#a78bfa', '#facc15', '#fb923c', '#34d399', '#f472b6', '#60a5fa', '#fde68a'];
  return palette[h % palette.length];
}

function fmtTs(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}
function fmtAgo(iso) {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60)     return `${s}s ago`;
  if (s < 3600)   return `${Math.floor(s/60)}m ago`;
  if (s < 86400)  return `${Math.floor(s/3600)}h ago`;
  return `${Math.floor(s/86400)}d ago`;
}
function fmtSpeed(mbps) {
  if (mbps == null) return '—';
  if (mbps >= 1000) return `${(mbps / 1000).toFixed(0)} Gbps`;
  return `${mbps} Mbps`;
}

// Plain-English summary of a change-log event. Treats null / 0 / empty
// string as "no value" since the poller emits "∅"-equivalent values when
// the port had no negotiated state. Falls back to a generic phrasing for
// any field we haven't taught it about so new fields still get a sentence.
function humanizeEvent(e) {
  const from = e.from_val, to = e.to_val;
  const empty = (v) => v == null || v === '' || v === '0' || v === 0;
  const speed = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n === 0) return null;
    return n >= 1000 ? `${(n / 1000).toFixed(0)} Gbps` : `${n} Mbps`;
  };
  switch (e.field) {
    case 'oper':
      if (to === 'up')   return empty(from) ? 'Link came up' : 'Link came back up';
      if (to === 'down') return 'Link went down';
      return `Operational state → ${to ?? 'unknown'}`;
    case 'admin':
      if (to === 'enabled')  return 'Port administratively enabled';
      if (to === 'disabled') return 'Port administratively disabled';
      return `Admin state → ${to ?? 'unknown'}`;
    case 'speed_mbps': {
      const t = speed(to), f = speed(from);
      if (!t && f) return 'Speed lost (link gone)';
      if (t && !f) return `Speed negotiated at ${t}`;
      if (t && f)  return `Speed changed ${f} → ${t}`;
      return 'Speed cleared';
    }
    case 'duplex':
      if (empty(to))   return 'Duplex cleared';
      if (empty(from)) return `Duplex negotiated as ${to}`;
      return `Duplex changed ${from} → ${to}`;
    case 'flowctrl':
      if (to === 'Enable')  return 'Flow control enabled';
      if (to === 'Disable') return empty(from) ? 'Flow control set to Disable' : 'Flow control disabled';
      if (empty(to))        return 'Flow control cleared';
      return `Flow control → ${to}`;
    case 'medium':
      if (empty(to)) return 'Active medium cleared';
      return `Active medium → ${to}`;
    case 'descr':
      if (empty(to))   return 'Description cleared';
      if (empty(from)) return `Description set to "${to}"`;
      return 'Description updated';
    case 'lldp_system':
      if (empty(to))   return 'LLDP neighbor lost';
      if (empty(from)) return `LLDP neighbor seen: ${to}`;
      return `LLDP neighbor changed: ${from} → ${to}`;
    case 'lldp_chassis':
      return empty(to) ? 'LLDP chassis ID cleared' : 'LLDP chassis ID changed';
    case 'lldp_port':
      return empty(to) ? 'LLDP remote port cleared' : `LLDP remote port → ${to}`;
    default:
      return `${e.field} changed`;
  }
}
function operClass(oper) {
  if (oper === 'up')   return styles.up;
  if (oper === 'down') return styles.down;
  return styles.unknown;
}
// Time-axis tick formatter — short HH:MM for windows ≤ 1d, otherwise
// includes the date so day-boundary transitions read correctly.
function fmtTick(ms, windowSec) {
  const d = new Date(ms);
  if (windowSec <= 24 * 3600) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
// Build {startMs,endMs,value} segments for one field across the window.
function buildSegments(initial, snapshots, field, windowStartMs, windowEndMs) {
  const points = [];
  if (initial && initial[field] != null) {
    points.push({ ms: windowStartMs, value: initial[field] });
  }
  for (const s of snapshots) {
    const ms = new Date(s.ts).getTime();
    if (ms < windowStartMs || ms > windowEndMs) continue;
    points.push({ ms, value: s[field] });
  }
  if (points.length === 0) return [];
  // Collapse adjacent identical values, then turn into segments by
  // pairing each point with the next point (or the window end).
  const segs = [];
  let cur = points[0];
  for (let i = 1; i < points.length; i++) {
    if (String(points[i].value) === String(cur.value)) continue;
    segs.push({ startMs: cur.ms, endMs: points[i].ms, value: cur.value });
    cur = points[i];
  }
  segs.push({ startMs: cur.ms, endMs: windowEndMs, value: cur.value });
  return segs;
}

// ─────────────────────────────────────────────────────────────────────
// Routable page wrapper — used by /port-history.
// Embeddable content — used by the ResultsPage "Drift" tab.
// ─────────────────────────────────────────────────────────────────────
export function PortHistoryContent() {
  return <PortHistoryInner embedded />;
}

export default function PortHistoryPage() {
  const navigate = useNavigate();
  return (
    <div className={styles.page}>
      <div className={styles.amb} aria-hidden />
      <header className={styles.header}>
        <button className={styles.backBtn} onClick={() => navigate(-1)} aria-label="Back">‹</button>
        <div className={styles.headerCenter}>
          <h1 className={styles.headerTitle}>Port history &amp; drift</h1>
          <p className={styles.headerSub}>Continuous SSH telemetry</p>
        </div>
        <span className={styles.spacer} />
      </header>
      <main className={styles.main}>
        <PortHistoryInner embedded={false} />
      </main>
    </div>
  );
}

function PortHistoryInner({ embedded }) {
  const [devices, setDevices]   = useState([]);
  const [loadErr, setLoadErr]   = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [overview, setOverview] = useState(null);
  const [overviewErr, setOverviewErr] = useState(null);
  const [selectedPort, setSelectedPort] = useState(null);

  // Load device list once — server auto-seeds the bench switch so the
  // list is always non-empty after a single poll has succeeded.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await authFetch(apiUrl('/api/ports/devices'));
        const data = await r.json();
        if (cancelled) return;
        setDevices(data.devices || []);
        if (data.devices?.length === 1) setSelectedId(data.devices[0].id);
        else if (data.devices?.length) setSelectedId(data.devices[0].id);
      } catch (err) {
        if (!cancelled) setLoadErr(err.message);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Poll overview while a device is selected (live port grid).
  useEffect(() => {
    if (!selectedId) { setOverview(null); return; }
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await authFetch(apiUrl(`/api/ports/${selectedId}/overview`));
        if (!r.ok) {
          const text = await r.text().catch(() => '');
          if (!cancelled) { setOverviewErr(text || `HTTP ${r.status}`); }
          return;
        }
        const data = await r.json();
        if (!cancelled) { setOverview(data); setOverviewErr(null); }
      } catch (err) {
        if (!cancelled) setOverviewErr(err.message);
      }
    };
    tick();
    const id = setInterval(tick, OVERVIEW_REFRESH_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [selectedId]);

  const triggerPoll = async () => {
    if (!selectedId) return;
    try { await authFetch(apiUrl(`/api/ports/${selectedId}/poll`), { method: 'POST' }); }
    catch (_) {}
  };

  const device = overview?.device;

  return (
    <div className={embedded ? styles.embeddedWrap : ''}>
      {/* ── Switch identity hero ────────────────────────────── */}
      <section className={styles.switchHero}>
        {loadErr && <div className={styles.errorLine}>{loadErr}</div>}

        {!device ? (
          <div className={styles.muted}>Waiting for first poll…</div>
        ) : (
          <>
            <div className={styles.switchHeroGlow} aria-hidden />
            <div className={styles.switchHeroRow}>
              <div className={styles.switchHeroIcon} aria-hidden>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="7" width="20" height="10" rx="2" />
                  <path d="M6 11h.01M9 11h.01M12 11h.01M15 11h.01M18 11h.01" />
                  <path d="M6 14h12" />
                </svg>
              </div>
              <div className={styles.switchHeroBody}>
                <div className={styles.switchHeroTitleRow}>
                  <h2 className={styles.switchHeroName}>
                    {device.display_name || device.model || 'Switch'}
                  </h2>
                  <span className={[
                    styles.switchStatus,
                    device.enabled ? styles.switchStatusOk : styles.switchStatusOff,
                  ].join(' ')}>
                    <span className={styles.switchStatusDot} />
                    {device.enabled ? 'Streaming' : 'Paused'}
                  </span>
                </div>
                {device.system_description && (
                  <p className={styles.switchHeroSub}>{device.system_description}</p>
                )}
                <div className={styles.switchHeroFacts}>
                  {device.model && device.model !== device.display_name && (
                    <span className={styles.heroFact}>{device.model}</span>
                  )}
                  {device.serial && (
                    <span className={styles.heroFact}>
                      <span className={styles.heroFactKey}>SN</span>
                      <span className={styles.heroFactVal}>{device.serial}</span>
                    </span>
                  )}
                  {device.sw_version && (
                    <span className={styles.heroFact}>
                      <span className={styles.heroFactKey}>FW</span>
                      <span className={styles.heroFactVal}>{device.sw_version.split(' ')[0]}</span>
                    </span>
                  )}
                </div>
              </div>
              <button
                type="button"
                className={styles.pollBtn}
                onClick={triggerPoll}
                title="Poll now"
                aria-label="Poll now"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M3 12a9 9 0 0 1 15.6-6.1L21 8" />
                  <path d="M21 3v5h-5" />
                  <path d="M21 12a9 9 0 0 1-15.6 6.1L3 16" />
                  <path d="M3 21v-5h5" />
                </svg>
              </button>
            </div>
          </>
        )}
      </section>

      {/* ── Port grid ─────────────────────────────────────────── */}
      {selectedId && (
        <section className={styles.card}>
          <div className={styles.cardHead}>
            <h2 className={styles.cardTitle}>Interface inventory</h2>
            {overview && <span className={styles.muted}>{overview.ports.length} ports</span>}
          </div>

          {overviewErr && <div className={styles.errorLine}>{overviewErr}</div>}

          {!overview ? (
            <div className={styles.muted}>Loading…</div>
          ) : overview.ports.length === 0 ? (
            <div className={styles.muted}>
              No port data yet. The poller runs once per minute — first
              snapshot lands shortly after the switch becomes reachable.
            </div>
          ) : (
            <>
              <div className={styles.legend}>
                <span className={[styles.dot, styles.up].join(' ')} /> link up
                <span className={[styles.dot, styles.down].join(' ')} /> link down
                <span className={[styles.dot, styles.unknown].join(' ')} /> unknown
              </div>
              <div className={styles.portGrid}>
                {[...overview.ports].sort((a, b) => {
                  // Sort by the trailing numeric index in the port name
                  // (e.g. Gi1/0/2 < Gi1/0/10). Server returns lexicographic
                  // order which puts "10" before "2".
                  const num = (s) => {
                    const m = String(s).match(/(\d+)\s*$/);
                    return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
                  };
                  return num(a.port) - num(b.port);
                }).map((p) => (
                  <button
                    key={p.port}
                    className={[
                      styles.portCell,
                      operClass(p.oper),
                      selectedPort === p.port ? styles.portCellActive : '',
                      p.admin === 'disabled' ? styles.portDisabled : '',
                    ].join(' ')}
                    onClick={() => setSelectedPort(p.port === selectedPort ? null : p.port)}
                    title={`${p.port} · ${p.oper} · ${fmtSpeed(p.speed_mbps)}`}
                  >
                    <span className={styles.portName}>{p.port.replace('Gi1/0/', '')}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </section>
      )}

      {/* ── Per-port Arista-style detail ──────────────────────── */}
      {selectedId && selectedPort && (
        <InterfaceDetail
          deviceId={selectedId}
          device={device}
          port={selectedPort}
          onClose={() => setSelectedPort(null)}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Per-port detail — Arista CloudVision-style layout:
//   Header (port + close)
//   Interface Details
//   Interface Status  (stacked-bar timeline + window selector)
//   Interface Configuration
//   Maintenance State
//   Value at 1h/3h/12h/1d/1w ago
//   Change log
// ─────────────────────────────────────────────────────────────────────
function InterfaceDetail({ deviceId, device, port, onClose }) {
  const [history, setHistory]   = useState(null);
  const [timeline, setTimeline] = useState(null);
  const [windowKey, setWindowKey] = useState('1h');
  const windowSec = useMemo(
    () => WINDOW_OPTIONS.find((o) => o.key === windowKey)?.sec ?? 3600,
    [windowKey],
  );

  // Poll the textual history (current + offsets + events)
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await authFetch(apiUrl(
          `/api/ports/${deviceId}/${encodeURIComponent(port)}/history`));
        const data = await r.json();
        if (!cancelled) setHistory(data);
      } catch (_) {}
    };
    tick();
    const id = setInterval(tick, HISTORY_REFRESH_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [deviceId, port]);

  // Poll the timeline data — rebuilds when the window selector changes
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await authFetch(apiUrl(
          `/api/ports/${deviceId}/${encodeURIComponent(port)}/timeline?window=${windowSec}`));
        const data = await r.json();
        if (!cancelled) setTimeline(data);
      } catch (_) {}
    };
    tick();
    const id = setInterval(tick, TIMELINE_REFRESH_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [deviceId, port, windowSec]);

  const current = history?.current;
  const events  = history?.events || [];
  const offsets = history?.offsets || {};

  return (
    <section className={styles.card}>
      <div className={styles.cardHead}>
        <h2 className={styles.cardTitle}>
          <span className={styles.portChip}>{port}</span>
          <span className={styles.portSubtitle}>
            on {device?.display_name || 'switch'}
          </span>
        </h2>
        <button className={styles.ghostBtn} onClick={onClose}>Close</button>
      </div>

      {/* Interface — merged Details + Configuration. De-dupes fields that
          appeared in both sections (speed / duplex / medium) and orders
          the most important state first. */}
      <h3 className={styles.subTitle}>Interface</h3>
      <div className={styles.kvGrid}>
        <KV label="Operational"   value={current?.oper || '—'} cls={operClass(current?.oper)} />
        <KV label="Admin State"   value={current?.admin || '—'} />
        <KV label="Speed"         value={fmtSpeed(current?.speed_mbps)} />
        <KV label="Duplex"        value={current?.duplex || '—'} />
        <KV label="Flow Control"  value={current?.flowctrl || '—'} />
        <KV label="Active Medium" value={current?.medium || '—'} />
        <KV label="MAC"           value={device?.mac || '—'} mono />
        <KV label="Description"   value={current?.descr || '(none)'} />
        <KV label="Last change"   value={current?.ts ? fmtAgo(current.ts) : '—'} />
        <KV label="Last poll"     value={device?.last_seen ? fmtAgo(device.last_seen) : '—'} />
      </div>

      {/* Status timeline */}
      <div className={styles.statusBlockHead}>
        <h3 className={styles.subTitle} style={{ marginBottom: 0 }}>Status timeline</h3>
        <select
          className={styles.select}
          value={windowKey}
          onChange={(e) => setWindowKey(e.target.value)}
        >
          {WINDOW_OPTIONS.map((o) => (
            <option key={o.key} value={o.key}>{o.label}</option>
          ))}
        </select>
      </div>
      <StackedTimeline
        timeline={timeline}
        windowSec={windowSec}
      />

      {/* Value at... — only rows that actually have a snapshot. Hides the
          mostly-empty "—" rows that dominated the old layout. */}
      {OFFSET_KEYS.some((k) => offsets[k]) && (
        <>
          <h3 className={styles.subTitle}>Value at</h3>
          <div className={styles.offsetTableWrap}>
            <table className={styles.offsetTable}>
              <thead>
                <tr><th>Ago</th><th>Oper</th><th>Admin</th><th>Speed</th><th>Recorded</th></tr>
              </thead>
              <tbody>
                {OFFSET_KEYS.filter((k) => offsets[k]).map((k) => {
                  const s = offsets[k];
                  return (
                    <tr key={k}>
                      <td>{k}</td>
                      <td className={operClass(s.oper)}>{s.oper ?? '—'}</td>
                      <td>{s.admin ?? '—'}</td>
                      <td>{fmtSpeed(s.speed_mbps)}</td>
                      <td className={styles.tsCell}>{fmtTs(s.ts)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Change log */}
      <h3 className={styles.subTitle}>Change log ({events.length})</h3>
      {events.length === 0 ? (
        <div className={styles.muted}>No changes recorded yet.</div>
      ) : (
        <ul className={styles.eventList}>
          {events.map((e) => (
            <li key={e.id} className={styles.eventRow}>
              <div className={styles.eventMain}>
                <div className={styles.eventHuman}>{humanizeEvent(e)}</div>
                <div className={styles.eventRaw}>
                  <span className={styles.eventField}>{e.field}</span>
                  <code className={styles.eventVal}>{e.from_val ?? '∅'}</code>
                  <span className={styles.arrow}>→</span>
                  <code className={styles.eventVal}>{e.to_val ?? '∅'}</code>
                </div>
              </div>
              <span className={styles.eventTime} title={fmtTs(e.at)}>{fmtAgo(e.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function KV({ label, value, cls = '', mono = false }) {
  return (
    <div className={styles.kvRow}>
      <div className={styles.kvLabel}>{label}</div>
      <div className={[styles.kvValue, mono ? styles.kvMono : '', cls].join(' ')}>{value}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// StackedTimeline — four horizontal bars (one per tracked field) with
// transition segments coloured by value, plus a tick axis. Reproduces
// the Interface Status panel from the Arista CV screenshot.
// ─────────────────────────────────────────────────────────────────────
function StackedTimeline({ timeline, windowSec }) {
  const data = useMemo(() => {
    if (!timeline) return null;
    const startMs = new Date(timeline.start_at).getTime();
    const endMs   = new Date(timeline.end_at).getTime();
    return { startMs, endMs };
  }, [timeline]);

  if (!timeline || !data) {
    return <div className={styles.timelineEmpty}>Loading timeline…</div>;
  }
  const { startMs, endMs } = data;
  const totalMs = endMs - startMs;
  const noData  = !timeline.initial && timeline.snapshots.length === 0;

  // Build 5 evenly-spaced ticks for the axis.
  const ticks = Array.from({ length: 5 }, (_, i) =>
    startMs + (totalMs * i) / 4
  );

  return (
    <div className={styles.timelineCard}>
      {/* time axis on top */}
      <div className={styles.timelineAxis}>
        {ticks.map((t, i) => (
          <span key={i} className={styles.timelineTick}>{fmtTick(t, windowSec)}</span>
        ))}
      </div>

      {noData ? (
        <div className={styles.timelineEmpty}>
          No snapshots in this window yet — let the poller run for a few
          cycles and the bars below will fill in.
        </div>
      ) : (
        <div className={styles.timelineStack}>
          {TIMELINE_BARS.map((bar) => {
            const segments = buildSegments(
              timeline.initial, timeline.snapshots, bar.field, startMs, endMs,
            );
            const last = segments[segments.length - 1];
            return (
              <div key={bar.field} className={styles.timelineRow}>
                <div className={styles.timelineRowHead}>
                  <span className={styles.timelineRowLabel}>{bar.label}</span>
                  {last && (
                    <span
                      className={styles.timelineRowValue}
                      style={{ '--seg-color': bar.colorOf(last.value) }}
                    >
                      {bar.formatValue(last.value)}
                    </span>
                  )}
                </div>
                <div className={styles.timelineTrack}>
                  {segments.length === 0 && (
                    <div className={styles.timelineEmptyBar}>no data</div>
                  )}
                  {segments.map((seg, i) => {
                    const left  = ((seg.startMs - startMs) / totalMs) * 100;
                    const width = ((seg.endMs   - seg.startMs) / totalMs) * 100;
                    return (
                      <div
                        key={i}
                        className={styles.timelineSegment}
                        style={{
                          left:   `${Math.max(0, left)}%`,
                          width:  `${Math.max(0.5, width)}%`,
                          background: bar.colorOf(seg.value),
                        }}
                        title={`${bar.label}: ${bar.formatValue(seg.value)} from ${fmtTs(new Date(seg.startMs).toISOString())}`}
                      />
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

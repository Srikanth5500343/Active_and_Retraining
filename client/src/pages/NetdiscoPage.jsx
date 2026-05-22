import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { apiUrl, authFetch } from '../utils/api';
import styles from './NetdiscoPage.module.css';

// Spot raw protocol-level / Python-level error text leaking from the
// Netdisco proxy (ECONNREFUSED, JSONDecodeError, tracebacks, generic HTTP
// numbers, etc.) so we can hide it behind the friendly offline banner
// instead of dumping it into the UI. Same idea as the CMDB page filter.
function looksLikeNetdiscoNoise(msg) {
  if (!msg || typeof msg !== 'string') return false;
  const m = msg.toLowerCase();
  return (
    m.includes('expecting value') ||
    m.includes('traceback') ||
    m.includes('jsondecode') ||
    m.includes('econnrefused') ||
    m.includes('etimedout') ||
    m.includes('enotfound') ||
    m.includes('fetch failed') ||
    m.includes('failed to fetch') ||
    m.startsWith('http ') ||
    /^\d{3}$/.test(m.trim())   // bare status code
  );
}

/**
 * Netdisco view scoped to a RackTrack scan.
 *
 * The page is a single scrollable list of cards — one per scan device —
 * that show live data joined from Netdisco. Each card is collapsible and
 * reveals the device's full port table with up/down state, VLAN, LLDP/CDP
 * neighbours and the count of MACs learned per port. A "Sync to Netdisco"
 * button at the top force-pushes the scan into Netdisco's DB.
 *
 * Below the device cards is a free-form MAC lookup that hits the whole
 * Netdisco database, not just this rack — useful for "where did this MAC
 * end up?" questions while looking at the rack.
 */
// ── Embeddable content (used as a tab in ResultsPage) ────────
export function NetdiscoContent({ rackId }) {
  return <NetdiscoInner rackId={rackId} embedded />;
}

export default function NetdiscoPage() {
  const navigate = useNavigate();
  const { rackId } = useParams();

  return <NetdiscoInner rackId={rackId} embedded={false} />;
}

function NetdiscoInner({ rackId, embedded }) {
  const navigate = useNavigate();

  const [health, setHealth]       = useState(null);
  const [match, setMatch]         = useState(null);
  const [matchLoading, setMatchLoading] = useState(true);
  const [matchError, setMatchError] = useState(null);

  // Per-device expansion + cached port detail (keyed by Netdisco IP).
  const [openIp, setOpenIp]       = useState(null);
  const [portsByIp, setPortsByIp] = useState({});      // ip -> ports[]
  const [loadingIps, setLoadingIps] = useState({});    // ip -> bool

  const [macInput, setMacInput] = useState('');
  const [macReport, setMacReport] = useState(null);
  const [macLoading, setMacLoading] = useState(false);
  const [macError, setMacError] = useState(null);

  const [syncStatus, setSyncStatus] = useState(null);   // null | 'syncing' | result obj
  const [syncError,  setSyncError]  = useState(null);

  // ── Health probe ──────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(apiUrl('/api/netdisco/health'));
        const data = await r.json();
        if (!cancelled) setHealth(data);
      } catch (err) {
        if (!cancelled) setHealth({ ok: false, error: err.message });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ── Match list (one fetch per rack) ───────────────────────────────────
  const fetchMatch = async () => {
    setMatchLoading(true);
    setMatchError(null);
    try {
      const r = await authFetch(apiUrl(`/api/netdisco/scan/${rackId}/match`));
      // Defensive parse: Netdisco's proxy can return empty body on cold
      // start, which would otherwise throw "Unexpected end of JSON input"
      // straight into the UI.
      const text = await r.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
      if (!r.ok || !data) {
        // Suppress raw protocol-level chatter (ECONNREFUSED, traceback,
        // JSONDecodeError, etc.) — the on-screen "backend is unreachable"
        // banner already says what the user needs to know.
        const msg = data?.error || '';
        setMatchError(looksLikeNetdiscoNoise(msg) ? null : (msg || null));
        setMatch(data || { netdisco_reachable: false });
      } else {
        setMatch(data);
      }
    } catch (err) {
      // Network failure (proxy down, etc.) — render the friendly offline
      // state rather than the raw "Failed to fetch" exception text.
      setMatchError(null);
      setMatch({ netdisco_reachable: false });
      void err;
    } finally {
      setMatchLoading(false);
    }
  };

  useEffect(() => {
    if (!rackId) return;
    fetchMatch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rackId]);

  // ── On expand: lazy-load that device's port detail ────────────────────
  const togglePorts = async (ip) => {
    if (!ip) return;
    if (openIp === ip) {
      setOpenIp(null);
      return;
    }
    setOpenIp(ip);
    if (portsByIp[ip] !== undefined) return;
    setLoadingIps(s => ({ ...s, [ip]: true }));
    try {
      const r = await authFetch(apiUrl(`/api/netdisco/devices/${encodeURIComponent(ip)}/ports`));
      const data = await r.json();
      setPortsByIp(s => ({ ...s, [ip]: data.ports || [] }));
    } catch {
      setPortsByIp(s => ({ ...s, [ip]: [] }));
    } finally {
      setLoadingIps(s => ({ ...s, [ip]: false }));
    }
  };

  // ── Sync (push scan to Netdisco DB) ───────────────────────────────────
  const runSync = async () => {
    if (!rackId) return;
    setSyncStatus('syncing');
    setSyncError(null);
    try {
      const r = await authFetch(apiUrl(`/api/netdisco/sync/${rackId}`), { method: 'POST' });
      const data = await r.json();
      if (!r.ok || !data.ok) {
        setSyncError(data.error || `HTTP ${r.status}`);
        setSyncStatus(null);
        return;
      }
      setSyncStatus(data);
      setPortsByIp({});            // invalidate cached port data
      await fetchMatch();
    } catch (err) {
      setSyncError(err.message);
      setSyncStatus(null);
    }
  };

  // ── MAC lookup ────────────────────────────────────────────────────────
  const runMacLookup = async (e) => {
    e?.preventDefault?.();
    const mac = macInput.trim();
    if (!mac) return;
    setMacLoading(true);
    setMacError(null);
    setMacReport(null);
    try {
      const r = await authFetch(apiUrl(`/api/netdisco/mac/${encodeURIComponent(mac)}`));
      const data = await r.json();
      if (!r.ok) {
        setMacError(data.error || `HTTP ${r.status}`);
      } else {
        setMacReport(data);
      }
    } catch (err) {
      setMacError(err.message);
    } finally {
      setMacLoading(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────
  const mainContent = (
    <main className={embedded ? undefined : styles.main}>

        {/* ── Devices in this rack ────────────────────────────────────── */}
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h3>Devices in this rack</h3>
            <div className={styles.headRight}>
              {match && match.netdisco_reachable !== false && (
                <span className={styles.subtle}>
                  {match.matched_count}/{match.scan_device_count} live in Network View
                </span>
              )}
              <button
                className={`${styles.syncBtn} ${syncStatus === 'syncing' ? styles.syncBtnSpin : ''}`}
                onClick={runSync}
                disabled={syncStatus === 'syncing' || !health?.ok}
                title={!health?.ok ? 'Network View is offline' : 'Re-sync this scan into Network View'}
                aria-label="Refresh"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="23 4 23 10 17 10"/>
                  <polyline points="1 20 1 14 7 14"/>
                  <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"/>
                  <path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14"/>
                </svg>
              </button>
            </div>
          </div>

          {syncStatus && syncStatus !== 'syncing' && syncStatus.ok && (
            <div className={styles.success}>
              Pushed {syncStatus.devices} devices, {syncStatus.ports} ports, {syncStatus.edges} cables into Network View.
            </div>
          )}
          {syncError && <div className={styles.error}>Couldn't sync to Network View. Please try again in a moment.</div>}
          {matchLoading && <div className={styles.loading}>Loading…</div>}
          {matchError && <div className={styles.error}>{matchError}</div>}

          {match && match.netdisco_reachable === false && (
            <div className={styles.warn}>
              <strong>Network View is offline.</strong>
              <br />Start Docker Desktop, then run{' '}
              <code style={{
                background: 'rgba(0,0,0,0.06)',
                padding: '1px 5px',
                borderRadius: 3,
                fontFamily: 'ui-monospace, Menlo, monospace',
                fontSize: '0.92em',
              }}>
                docker compose up -d
              </code>{' '}
              from <code style={{
                background: 'rgba(0,0,0,0.06)',
                padding: '1px 5px',
                borderRadius: 3,
                fontFamily: 'ui-monospace, Menlo, monospace',
                fontSize: '0.92em',
              }}>netdisco-docker/</code>, then refresh.
            </div>
          )}

          {match && match.netdisco_reachable !== false && match.matches?.length > 0 && (
            <div className={styles.deviceList}>
              {match.matches
                .filter(m => m.scan.class_name !== 'Patch Panel')
                .map((m, i) => (
                <DeviceCard
                  key={i}
                  m={m}
                  open={openIp === m.netdisco?.ip}
                  ports={m.netdisco?.ip ? portsByIp[m.netdisco.ip] : null}
                  loading={m.netdisco?.ip ? !!loadingIps[m.netdisco.ip] : false}
                  onToggle={() => togglePorts(m.netdisco?.ip)}
                  onMacClick={(mac) => { setMacInput(mac); runMacLookup(); }}
                />
              ))}
            </div>
          )}
        </section>


      </main>
  );

  if (embedded) return mainContent;

  return (
    <div className={styles.page}>
      <div className={styles.amb} />

      <header className={styles.header}>
        <button className="btn btn-ghost btn-icon" onClick={() => navigate(-1)}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
          </svg>
        </button>
        <div className={styles.headerCenter}>
          <h2 className={styles.headerTitle}>Network View</h2>
          <span className={styles.headerMono}>{rackId} · live network view</span>
        </div>
        <HealthPill health={health} />
      </header>

      {mainContent}
    </div>
  );
}


// ─────────────────────────────────────────────────────────────────────────
// One device row — collapsed shows summary chips, expanded shows port table.
// ─────────────────────────────────────────────────────────────────────────
function DeviceCard({ m, open, ports, loading, onToggle, onMacClick }) {
  const live = !!m.netdisco;
  const liveCount = m.netdisco?.stats?.connected ?? (m.scan.connected_count || 0);

  return (
    <div className={`${styles.deviceCard} ${open ? styles.deviceCardOpen : ''} ${!live ? styles.deviceCardDim : ''}`}>
      <button className={styles.deviceHead} onClick={live ? onToggle : undefined}
              disabled={!live} type="button">
        <div className={styles.deviceTitle}>
          <span className={styles.deviceName}>{m.scan.cmdb_name || '—'}</span>
          <span className={styles.deviceClass}>{m.scan.class_name}</span>
        </div>

        <div className={styles.deviceSub}>
          {m.netdisco ? (
            <>
              {m.netdisco.model && <span className={styles.modelTag}>{m.netdisco.model}</span>}
              {m.netdisco.ip && <span className={styles.ipTag}>{m.netdisco.ip}</span>}
            </>
          ) : (
            <span className={styles.unmanaged}>not in Network View</span>
          )}
        </div>

        <div className={styles.deviceCounts}>
          <span className={`${styles.cnt} ${styles.cntLive}`}>
            <b>{liveCount}</b><i>live</i>
          </span>
        </div>

        {live && <span className={styles.chev} aria-hidden="true">{open ? '▾' : '▸'}</span>}
      </button>

      {open && live && (
        <div className={styles.deviceBody}>
          {loading && <div className={styles.loading}>Loading ports…</div>}
          {!loading && (!ports || ports.length === 0) && (
            <div className={styles.empty}>No ports reported by Network View for this device.</div>
          )}
          {!loading && ports && ports.length > 0 && (
            <PortTable ports={ports} onMacClick={onMacClick} />
          )}
        </div>
      )}
    </div>
  );
}


function PortTable({ ports, onMacClick }) {
  const [filter, setFilter] = useState('live');
  const visible = useMemo(() => {
    if (!ports) return [];
    if (filter === 'live') return ports.filter(p => p.neighbor || p.active_mac_count > 0 || isUp(p.up));
    if (filter === 'up')   return ports.filter(p => isUp(p.up));
    if (filter === 'down') return ports.filter(p => !isUp(p.up));
    return ports;
  }, [ports, filter]);

  const upCount   = ports.filter(p => isUp(p.up)).length;
  const downCount = ports.filter(p => !isUp(p.up)).length;
  const liveCount = ports.filter(p => p.neighbor || p.active_mac_count > 0 || isUp(p.up)).length;

  // Only show the MACs column when at least one port has node data —
  // otherwise it's a sea of dashes that adds noise.
  const anyMacs = ports.some(p => p.active_mac_count > 0);

  return (
    <>
      <div className={styles.portFilter}>
        <FilterBtn active={filter === 'live'} onClick={() => setFilter('live')}>Live ({liveCount})</FilterBtn>
        <FilterBtn active={filter === 'up'}   onClick={() => setFilter('up')}>Up ({upCount})</FilterBtn>
        <FilterBtn active={filter === 'down'} onClick={() => setFilter('down')}>Down ({downCount})</FilterBtn>
        <FilterBtn active={filter === 'all'}  onClick={() => setFilter('all')}>All ({ports.length})</FilterBtn>
      </div>

      {visible.length === 0 ? (
        <div className={styles.empty}>No ports match this filter.</div>
      ) : (
        <div className={`${styles.portTable} ${anyMacs ? styles.portTable5 : styles.portTable4}`}>
          <div className={styles.portHead}>
            <span>Port</span>
            <span>State</span>
            <span>VLAN</span>
            <span>Neighbour</span>
            {anyMacs && <span>MACs</span>}
          </div>
          {visible.map((p, i) => (
            <div key={i} className={styles.portRow}>
              <div className={styles.portName}>
                <strong>{p.name || p.port}</strong>
                {p.descr && <span className={styles.subtle}>{p.descr}</span>}
              </div>
              <div className={styles.portState}>
                <span className={isUp(p.up) ? styles.dotActive : styles.dotIdle} />
                <span>{stateLabel(p.up, p.up_admin)}</span>
              </div>
              <div className={styles.portVlan}>{p.vlan || '—'}</div>
              <div className={styles.portNb}>
                {p.neighbor ? (
                  <>
                    <strong>{p.neighbor.remote_device || '—'}</strong>
                    <span className={styles.subtle}>
                      {p.neighbor.remote_port}{p.neighbor.protocol ? ` · ${p.neighbor.protocol}` : ''}
                    </span>
                  </>
                ) : (
                  <span className={styles.subtle}>—</span>
                )}
              </div>
              {anyMacs && (
                <div>
                  {p.active_mac_count > 0 ? (
                    <button
                      className={styles.macChip}
                      onClick={() => {
                        const m = p.learned_macs?.find(mm => mm.active) || p.learned_macs?.[0];
                        if (m?.mac && onMacClick) onMacClick(m.mac);
                      }}
                      title="Look up the first active MAC behind this port"
                    >
                      {p.active_mac_count}
                    </button>
                  ) : (
                    <span className={styles.subtle}>—</span>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}


// ── Small helpers ─────────────────────────────────────────────────────────

function HealthPill({ health }) {
  if (!health) return <span className={styles.healthPill}>checking…</span>;
  const ok = !!health.ok;
  return (
    <span className={`${styles.healthPill} ${ok ? styles.healthOk : styles.healthBad}`}>
      <span className={styles.healthDot} />
      {ok ? 'Network View online' : 'Network View offline'}
    </span>
  );
}

function FilterBtn({ active, onClick, children }) {
  return (
    <button
      className={`${styles.filterBtn} ${active ? styles.filterBtnActive : ''}`}
      onClick={onClick}
      type="button"
    >{children}</button>
  );
}

function isUp(v) {
  if (v === true || v === 1) return true;
  if (typeof v === 'string') return /^(up|true|t|1)$/i.test(v.trim());
  return false;
}

function stateLabel(up, up_admin) {
  const oper = isUp(up) ? 'up' : 'down';
  const admin = isUp(up_admin) ? 'up' : (up_admin ? 'down' : null);
  if (!admin || admin === oper) return oper;
  return `${oper} (admin ${admin})`;
}

function fmtTime(t) {
  if (!t) return '—';
  return String(t).slice(0, 19).replace('T', ' ');
}

function stripPrefix(text, prefix) {
  if (!text || !prefix) return text || '';
  let out = String(text).trim();
  while (out.toLowerCase().startsWith(prefix.toLowerCase())) {
    out = out.slice(prefix.length).trim();
  }
  return out;
}

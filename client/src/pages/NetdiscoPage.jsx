import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { apiUrl, authFetch } from '../utils/api';
import styles from './NetdiscoPage.module.css';

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
export default function NetdiscoPage() {
  const navigate = useNavigate();
  const { rackId } = useParams();

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
      const data = await r.json();
      if (!r.ok) {
        setMatchError(data.error || `HTTP ${r.status}`);
        setMatch(null);
      } else {
        setMatch(data);
      }
    } catch (err) {
      setMatchError(err.message);
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

      <main className={styles.main}>

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
              Network View backend is unreachable{match.error ? ` (${stripPrefix(match.error, 'Netdisco unreachable:')})` : ''}.
              <br />Make sure the discovery service is running, then refresh.
            </div>
          )}

          {match && match.netdisco_reachable !== false && match.matches?.length > 0 && (
            <div className={styles.deviceList}>
              {match.matches.map((m, i) => (
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

        {/* ── MAC lookup (compact, secondary) ─────────────────────────── */}
        <section className={styles.macSection}>
          <form onSubmit={runMacLookup} className={styles.macForm}>
            <span className={styles.macLabel}>MAC</span>
            <input
              type="text"
              placeholder="aa:bb:cc:dd:ee:ff"
              value={macInput}
              onChange={(e) => setMacInput(e.target.value)}
              className={styles.macInput}
            />
            <button type="submit" disabled={macLoading || !macInput.trim()} className={styles.macBtn}>
              {macLoading ? '…' : 'Look up'}
            </button>
          </form>

          {macError && <div className={styles.error}>{macError}</div>}

          {macReport && macReport.sighting_count === 0 && (
            <div className={styles.empty}>MAC <code>{macReport.mac}</code> not found in Network View.</div>
          )}

          {macReport && macReport.sighting_count > 0 && (
            <div className={styles.macReport}>
              {macReport.current && (
                <div className={styles.currentLoc}>
                  <span className={styles.currentLabel}>
                    {macReport.current.active ? 'Currently on' : 'Most recently on'}
                  </span>
                  <strong>{macReport.current.switch || '—'}</strong>
                  <span className={styles.subtle}>port {macReport.current.port}</span>
                  {macReport.current.vlan && <span className={styles.subtle}>vlan {macReport.current.vlan}</span>}
                </div>
              )}

              {macReport.ips?.length > 0 && (
                <>
                  <div className={styles.subhead}>IP history</div>
                  <div className={styles.miniTable}>
                    {macReport.ips.slice(0, 10).map((ip, i) => (
                      <div key={i} className={styles.miniRow}>
                        <strong>{ip.ip}</strong>
                        <span className={styles.subtle}>{fmtTime(ip.time_first)} → {fmtTime(ip.time_last)}</span>
                        <span className={ip.active ? styles.dotActive : styles.dotIdle} />
                        <span className={styles.subtle}>{ip.active ? 'active' : 'archived'}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}

              <div className={styles.subhead}>
                Switch / port sightings ({macReport.sighting_count})
              </div>
              <div className={styles.miniTable}>
                {macReport.sightings.slice(0, 15).map((s, i) => (
                  <div key={i} className={styles.miniRow}>
                    <strong>{s.switch}</strong>
                    <span className={styles.subtle}>{s.port}</span>
                    {s.vlan && <span className={styles.subtle}>vlan {s.vlan}</span>}
                    <span className={styles.subtle}>last {fmtTime(s.time_last)}</span>
                    <span className={s.active ? styles.dotActive : styles.dotIdle} />
                    <span className={styles.subtle}>{s.active ? 'active' : 'archived'}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>

      </main>
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

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import styles from './ProfilePage.module.css';
import { useAuth } from '../AuthContext.jsx';
import { apiUrl, authFetch } from '../utils/api';
import ThemeToggle from '../components/ThemeToggle.jsx';

function formatDate(d) {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch { return d; }
}
function formatDateTime(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleString(); } catch { return d; }
}
function formatRelative(d) {
  if (!d) return '—';
  const ms = Date.now() - new Date(d).getTime();
  if (isNaN(ms) || ms < 0) return 'now';
  const m = Math.floor(ms / 60000);
  if (m < 1)   return 'now';
  if (m < 60)  return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24)  return `${h}h`;
  const days = Math.floor(h / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  return `${months}mo`;
}

export default function ProfilePage() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [scans, setScans] = useState([]);
  const [scansLoading, setScansLoading] = useState(true);
  const [scansError, setScansError] = useState(null);
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);

  // Fetch the authed user's scans from the server. localStorage is no longer
  // used — every signed-in user sees only their own history.
  useEffect(() => {
    let cancelled = false;
    setScansLoading(true);
    authFetch(apiUrl('/api/scans'))
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(data => { if (!cancelled) { setScans(data.scans || []); setScansError(null); } })
      .catch(err => { if (!cancelled) setScansError(err.message); })
      .finally(() => { if (!cancelled) setScansLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const initial = useMemo(() => (user?.username || user?.email || '?').charAt(0).toUpperCase(), [user]);

  const onSignOut = () => {
    logout();
    navigate('/', { replace: true });
  };

  const openScan = async (rackId) => {
    // Re-run the cache-hit /api/analyze path to fetch the full result payload
    // expected by ResultsPage. Cheap because the pipeline is cached.
    try {
      const meta = scans.find(s => s.rackId === rackId);
      // Pull the cached scan result via the resync endpoint
      const res = await authFetch(apiUrl(`/api/scan/${rackId}/report?format=json`));
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load scan');
      // Build a minimal result shape that ResultsPage understands
      const result = {
        scanId: rackId,
        rackId,
        cached: true,
        timestamp: meta?.timestamp,
        devices: data.devices || [],
        units_detected: data.units_detected || [],
        originalExt: 'jpg',
      };
      navigate('/results', { state: { result } });
    } catch (err) {
      setScansError(err.message);
    }
  };

  return (
    <div className={`page page-full ${styles.profile}`}>
      <div className={styles.amb} />
      <div className={styles.amb2} />

      {/* ── Top-right action cluster: theme toggle + sign-out ── */}
      <div className={styles.topRightActions}>
        <ThemeToggle />
        <button className={styles.signOutBtn} onClick={() => setConfirmingSignOut(true)} aria-label="Sign out" title="Sign out">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/>
            <polyline points="16 17 21 12 16 7"/>
            <line x1="21" y1="12" x2="9" y2="12"/>
          </svg>
        </button>
      </div>

      {/* ── Top 40% — clean profile hero ── */}
      <section className={styles.identity}>
        {/* Decorative grid behind the card (no scanline, no sweep) */}
        <div className={styles.idGrid} />

        <div className={styles.idCard}>
          {/* Avatar — overhangs the top edge, no rotating ring */}
          <div className={styles.idAvatarWrap}>
            <div className={styles.idAvatar}>
              <span className={styles.idAvatarInitial}>{initial}</span>
              <span className={styles.idAvatarStatus} title="Online"/>
            </div>
          </div>

          {/* Identity text */}
          <div className={styles.idText}>
            <div className={styles.idNameRow}>
              <h1 className={styles.idName}>{user?.username || 'Guest'}</h1>
            </div>
            {user?.email && <p className={styles.idEmail}>{user.email}</p>}
          </div>

          {/* Stats strip — scans + ports only */}
          <div className={styles.idStats}>
            <div className={styles.idStatTile}>
              <svg className={styles.idStatIcon} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="3" width="20" height="18" rx="2"/><line x1="2" y1="9" x2="22" y2="9"/><line x1="6" y1="13" x2="14" y2="13"/>
              </svg>
              <div className={styles.idStatVals}>
                <span className={styles.idStatNum}>{scans.length}</span>
                <span className={styles.idStatKey}>scans</span>
              </div>
            </div>
            <div className={styles.idStatTile}>
              <svg className={styles.idStatIcon} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="4" width="20" height="6" rx="1.5"/><rect x="2" y="14" width="20" height="6" rx="1.5"/>
                <line x1="6" y1="7" x2="6.01" y2="7"/><line x1="6" y1="17" x2="6.01" y2="17"/>
              </svg>
              <div className={styles.idStatVals}>
                <span className={styles.idStatNum}>
                  {scans.reduce((acc, s) => acc + (s.portCount || 0), 0)}
                </span>
                <span className={styles.idStatKey}>ports</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Quick-action: live port drift (continuous SSH polling) ── */}
      <button
        type="button"
        onClick={() => navigate('/port-history')}
        style={{
          margin: '0 14px 8px',
          padding: '12px 14px',
          background: 'linear-gradient(180deg, rgba(34,211,238,0.14), rgba(59,130,246,0.10))',
          border: '1px solid rgba(34,211,238,0.35)',
          borderRadius: 12,
          color: '#ecfeff',
          fontSize: 13,
          fontWeight: 600,
          textAlign: 'left',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
        }}
      >
        <span>Live port drift · monitored switches</span>
        <span aria-hidden style={{ opacity: 0.7 }}>›</span>
      </button>

      {/* ── Bottom 60% — scan history ── */}
      <section className={styles.historyWrap}>
        <div className={styles.historyHead}>
          <h2 className={styles.historyTitle}>Scan history</h2>
          {scansLoading && <span className={styles.spinnerSmall}/>}
        </div>

        <div className={styles.list}>
          {scansError && (
            <div className={styles.errBanner}>{scansError}</div>
          )}
          {!scansLoading && scans.length === 0 && !scansError ? (
            <div className={styles.empty}>
              <div className={styles.emptyIcon}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="3" width="20" height="18" rx="2"/>
                  <line x1="2" y1="9" x2="22" y2="9"/>
                  <line x1="6" y1="13" x2="14" y2="13"/>
                </svg>
              </div>
              <p className={styles.emptyText}>You haven't scanned a rack yet.</p>
              <button className={styles.startBtn} onClick={() => navigate('/scan')}>Start your first scan</button>
            </div>
          ) : (
            scans.map((s) => (
              <article
                key={s.rackId}
                className={styles.card}
                onClick={() => openScan(s.rackId)}
              >
                <div className={styles.cardTop}>
                  <div>
                    <p className={styles.cardTitle}>{s.rackId}</p>
                    <p className={styles.cardMeta}>{formatDateTime(s.timestamp)}</p>
                  </div>
                  {s.qualityWarning && (
                    <span className={`${styles.sevBadge} ${styles.sevWarn}`} title="Image quality warning">⚠ side angle</span>
                  )}
                </div>
                <div className={styles.cardInfo}>
                  <span className={styles.cardChip}>{s.deviceCount} devices</span>
                  <span className={styles.cardChip}>{s.unitCount} units</span>
                  {s.portCount > 0 && <span className={styles.cardChip}>{s.portCount} port{s.portCount === 1 ? '' : 's'} located</span>}
                </div>
              </article>
            ))
          )}
        </div>
      </section>

      {/* ── Sign-out confirm modal ── */}
      {confirmingSignOut && (
        <div className={styles.confirmBackdrop}>
          <div className={styles.confirmModal}>
            <div className={styles.confirmIcon}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/>
                <polyline points="16 17 21 12 16 7"/>
                <line x1="21" y1="12" x2="9" y2="12"/>
              </svg>
            </div>
            <h3 className={styles.confirmTitle}>Sign out?</h3>
            <p className={styles.confirmMsg}>You'll need to sign in again to scan racks.</p>
            <div className={styles.confirmActions}>
              <button className={styles.confirmCancel} onClick={() => setConfirmingSignOut(false)}>Cancel</button>
              <button className={styles.confirmGo} onClick={onSignOut}>Sign out</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

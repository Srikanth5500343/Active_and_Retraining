import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import styles from './ProfilePage.module.css';
import { useAuth } from '../AuthContext.jsx';
import { apiUrl, authFetch } from '../utils/api';
import ThemeToggle from '../components/ThemeToggle.jsx';

function formatJoined(d) {
  if (!d) return null;
  try {
    return new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
  } catch { return null; }
}
function formatRelative(d) {
  if (!d) return '—';
  const ms = Date.now() - new Date(d).getTime();
  if (isNaN(ms) || ms < 0) return 'now';
  const m = Math.floor(ms / 60000);
  if (m < 1)   return 'just now';
  if (m < 60)  return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)  return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 7)  return `${days}d ago`;
  if (days < 30) return `${Math.floor(days/7)}w ago`;
  return `${Math.floor(days/30)}mo ago`;
}

// Decorative data-center scene rendered behind the hero text. Subtle so it
// reads as texture, not clutter: a couple of rack outlines, a port row, a
// pair of connection lines, and three status LEDs (one pulses).
function DataCenterDecor() {
  return (
    <svg
      className={styles.heroDecor}
      viewBox="0 0 360 240"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true">
      <defs>
        <pattern id="dcDots" x="0" y="0" width="18" height="18" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="1" fill="rgba(99,102,241,0.22)" />
        </pattern>
      </defs>

      {/* faint dot grid covering the whole hero */}
      <rect x="0" y="0" width="360" height="240" fill="url(#dcDots)" />

      {/* connection lines weaving across */}
      <path d="M 20 60 Q 100 30 180 80 T 340 110"
        fill="none" stroke="rgba(99,102,241,0.18)" strokeWidth="1" strokeDasharray="2 4"/>
      <path d="M 40 180 Q 140 200 220 170 T 350 200"
        fill="none" stroke="rgba(167,139,250,0.18)" strokeWidth="1" strokeDasharray="2 4"/>

      {/* left-side rack server icon */}
      <g transform="translate(28 36)" stroke="rgba(165,180,252,0.45)" fill="none" strokeWidth="0.9">
        <rect x="0" y="0" width="22" height="34" rx="2.5"/>
        <line x1="4" y1="6"  x2="18" y2="6"/>
        <line x1="4" y1="11" x2="18" y2="11"/>
        <line x1="4" y1="16" x2="18" y2="16"/>
        <line x1="4" y1="21" x2="18" y2="21"/>
        <line x1="4" y1="26" x2="18" y2="26"/>
        <circle cx="17" cy="6"  r="0.9" fill="rgba(99,102,241,0.8)" stroke="none"/>
        <circle cx="17" cy="11" r="0.9" fill="rgba(34,197,94,0.85)" stroke="none"/>
        <circle cx="17" cy="16" r="0.9" fill="rgba(99,102,241,0.7)" stroke="none"/>
      </g>

      {/* second small rack, lower-left */}
      <g transform="translate(60 158)" stroke="rgba(165,180,252,0.32)" fill="none" strokeWidth="0.8">
        <rect x="0" y="0" width="16" height="22" rx="2"/>
        <line x1="3" y1="5"  x2="13" y2="5"/>
        <line x1="3" y1="10" x2="13" y2="10"/>
        <line x1="3" y1="15" x2="13" y2="15"/>
      </g>

      {/* horizontal port row (upper-right, sat below the action buttons) */}
      <g transform="translate(248 110)" stroke="rgba(165,180,252,0.45)" fill="none" strokeWidth="0.9">
        <rect x="0" y="0" width="86" height="16" rx="2.5"/>
        <line x1="10" y1="4"  x2="10" y2="12"/>
        <line x1="20" y1="4"  x2="20" y2="12"/>
        <line x1="30" y1="4"  x2="30" y2="12"/>
        <line x1="40" y1="4"  x2="40" y2="12"/>
        <line x1="50" y1="4"  x2="50" y2="12"/>
        <line x1="60" y1="4"  x2="60" y2="12"/>
        <line x1="70" y1="4"  x2="70" y2="12"/>
      </g>

      {/* topology nodes */}
      <g>
        <circle cx="312" cy="160" r="4"   fill="rgba(99,102,241,0.55)"/>
        <circle cx="312" cy="160" r="8"   fill="none" stroke="rgba(99,102,241,0.30)" strokeWidth="0.8"/>
        <circle cx="278" cy="200" r="3"   fill="rgba(99,102,241,0.65)"/>
        <circle cx="200" cy="50"  r="2.5" fill="rgba(167,139,250,0.7)"/>
        {/* two extra dots scattered on the left half (unconnected) */}
        <circle cx="105" cy="110" r="3"   fill="rgba(99,102,241,0.55)"/>
        <circle cx="142" cy="158" r="2.5" fill="rgba(167,139,250,0.6)"/>
        <line x1="278" y1="200" x2="312" y2="160" stroke="rgba(99,102,241,0.35)" strokeWidth="0.8" strokeDasharray="2 2"/>
      </g>

      {/* pulsing LED in the upper-middle area */}
      <circle cx="184" cy="22" r="1.8" fill="#6366F1">
        <animate attributeName="opacity" values="0.4;1;0.4" dur="2.2s" repeatCount="indefinite"/>
      </circle>
    </svg>
  );
}

export default function ProfilePage() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [scans, setScans] = useState([]);
  const [scansLoading, setScansLoading] = useState(true);
  const [scansError, setScansError] = useState(null);
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);

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
  const joined  = useMemo(() => formatJoined(user?.created_at), [user]);

  const totals = useMemo(() => ({
    scans:   scans.length,
    ports:   scans.reduce((acc, s) => acc + (s.portCount   || 0), 0),
    devices: scans.reduce((acc, s) => acc + (s.deviceCount || 0), 0),
  }), [scans]);

  const recent = useMemo(() => scans.slice(0, 5), [scans]);

  const onSignOut = () => {
    logout();
    navigate('/', { replace: true });
  };

  const openScan = async (rackId) => {
    try {
      const meta = scans.find(s => s.rackId === rackId);
      const res  = await authFetch(apiUrl(`/api/scan/${rackId}/report?format=json`));
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load scan');
      const result = {
        scanId: rackId, rackId, cached: true, timestamp: meta?.timestamp,
        devices: data.devices || [], units_detected: data.units_detected || [],
        originalExt: 'jpg',
      };
      navigate('/results', { state: { result } });
    } catch (err) { setScansError(err.message); }
  };

  return (
    <div className={`page page-full ${styles.profile}`}>
      {/* ── Hero band: dark navy data-center scene, curved bottom. The
            avatar lives OUTSIDE the hero (as a sibling) so it doesn't get
            clipped by overflow:hidden on the curve. Stays dark even in
            light theme — it's a brand band, like Jennifer Sanchez's teal. ── */}
      <div className={styles.heroWrap}>
        <section className={styles.hero}>
          <DataCenterDecor />

          <div className={styles.heroActions}>
            <ThemeToggle />
            <button
              type="button"
              className={styles.heroIconBtn}
              onClick={() => setConfirmingSignOut(true)}
              aria-label="Sign out">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/>
                <polyline points="16 17 21 12 16 7"/>
                <line x1="21" y1="12" x2="9" y2="12"/>
              </svg>
            </button>
          </div>

          <h1 className={styles.heroLabel}>Profile</h1>
        </section>

        <div className={styles.avatarWrap}>
          <div className={styles.avatar}>
            <span className={styles.avatarInitial}>{initial}</span>
            <span className={styles.avatarStatus} title="Online"/>
          </div>
        </div>
      </div>

      {/* ── Identity block ── */}
      <section className={styles.identity}>
        <h2 className={styles.name}>{user?.username || 'Guest'}</h2>
        {user?.email && <p className={styles.email}>{user.email}</p>}
        <div className={styles.meta}>
          {user?.tenant?.name && <span className={styles.metaBadge}>{user.tenant.name}</span>}
          {joined && <span className={styles.metaJoined}>Since {joined}</span>}
        </div>
      </section>

      {/* ── Stat tiles ── */}
      <section className={styles.stats}>
        <div className={styles.statTile}>
          <span className={styles.statIcon}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="6" y="3" width="12" height="18" rx="2"/>
              <line x1="9" y1="7"  x2="15" y2="7"/>
              <line x1="9" y1="11" x2="15" y2="11"/>
              <line x1="9" y1="15" x2="15" y2="15"/>
              <circle cx="14" cy="7" r="0.6" fill="currentColor"/>
            </svg>
          </span>
          <span className={styles.statValue}>{totals.scans}</span>
          <span className={styles.statLabel}>Scans</span>
        </div>
        <div className={styles.statTile}>
          <span className={styles.statIcon}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="4" width="20" height="6" rx="1.5"/>
              <rect x="2" y="14" width="20" height="6" rx="1.5"/>
              <line x1="6" y1="7"  x2="6.01" y2="7"/>
              <line x1="6" y1="17" x2="6.01" y2="17"/>
            </svg>
          </span>
          <span className={styles.statValue}>{totals.devices}</span>
          <span className={styles.statLabel}>Devices</span>
        </div>
        <div className={styles.statTile}>
          <span className={styles.statIcon}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="7"  width="20" height="10" rx="1.5"/>
              <line x1="6"  y1="11" x2="6"  y2="13"/>
              <line x1="10" y1="11" x2="10" y2="13"/>
              <line x1="14" y1="11" x2="14" y2="13"/>
              <line x1="18" y1="11" x2="18" y2="13"/>
            </svg>
          </span>
          <span className={styles.statValue}>{totals.ports}</span>
          <span className={styles.statLabel}>Ports</span>
        </div>
      </section>

      {/* ── Recent scans ── */}
      <section className={styles.card}>
        <header className={styles.cardHead}>
          <h3 className={styles.cardTitle}>Recent scans</h3>
          {scansLoading && <span className={styles.spinner}/>}
        </header>
        {/* On-Device Scan — runs the pipeline locally, works offline */}
        <button
          type="button"
          onClick={() => navigate('/benchmark')}
          style={{
            marginTop: 4,
            marginBottom: 12,
            padding: '10px 16px',
            border: '1px solid rgba(34,197,94,0.45)',
            background: 'rgba(34,197,94,0.08)',
            color: '#16a34a',
            borderRadius: 999,
            fontSize: 13,
            fontWeight: 600,
            letterSpacing: '0.02em',
            cursor: 'pointer',
            alignSelf: 'center',
          }}
        >
          On-Device Scan · works offline
        </button>
        {scansError && <div className={styles.errBanner}>{scansError}</div>}
        {!scansLoading && recent.length === 0 && !scansError ? (
          <div className={styles.empty}>
            <p className={styles.emptyText}>No scans yet.</p>
            <button className={styles.startBtn} onClick={() => navigate('/scan')}>
              Start your first scan
            </button>
          </div>
        ) : (
          <ul className={styles.scanList}>
            {recent.map(s => (
              <li
                key={s.rackId}
                className={styles.scanRow}
                onClick={() => openScan(s.rackId)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter') openScan(s.rackId); }}>
                <span className={styles.scanRowIcon}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="6" y="3" width="12" height="18" rx="2"/>
                    <line x1="9" y1="7"  x2="15" y2="7"/>
                    <line x1="9" y1="11" x2="15" y2="11"/>
                    <line x1="9" y1="15" x2="15" y2="15"/>
                  </svg>
                </span>
                <div className={styles.scanRowMain}>
                  <p className={styles.scanRowTitle}>{s.rackId}</p>
                  <p className={styles.scanRowMeta}>
                    {s.deviceCount} dev · {s.unitCount} units · {s.portCount} port{s.portCount === 1 ? '' : 's'}
                  </p>
                </div>
                <div className={styles.scanRowTime}>
                  <span>{formatRelative(s.timestamp)}</span>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="9 18 15 12 9 6"/>
                  </svg>
                </div>
              </li>
            ))}
          </ul>
        )}
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

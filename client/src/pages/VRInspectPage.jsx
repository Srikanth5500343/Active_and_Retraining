import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { apiUrl, authFetch } from '../utils/api';
import styles from './VRInspectPage.module.css';

const VRRackCanvas = lazy(() => import('./VRRackCanvas.jsx'));

// ── Convert scan API response to topology-compatible shape ──────────────
function scanToTopo(scan) {
  if (!scan) return null;
  return {
    rackName: scan.rackId || 'Rack',
    u_size: scan.units_detected?.length || 42,
    devices: (scan.devices || []).map((d, i) => ({
      name:       d.name || `Device ${i + 1}`,
      class:      d.class_name || d.class || 'Device',
      class_name: d.class_name || d.class || 'Device',
      in_rack:    true,
      u_position: d.u_position || i + 1,
      u_size:     d.u_size || 1,
      model:      d.model || '',
      vendor:     d.vendor || '',
      bbox:       d.bbox || d.box || null,
      ports:      d.ports || [],
    })),
    edges: [],
  };
}

// ── VR Support Banner (enter-VR button) ──────────────────────────────────
function VRSupportBanner({ onEnterVR }) {
  const [supported, setSupported] = useState(null);
  useEffect(() => {
    if (!navigator.xr) { setSupported(false); return; }
    navigator.xr.isSessionSupported('immersive-vr')
      .then(ok => setSupported(ok))
      .catch(() => setSupported(false));
  }, []);

  if (supported === null) return null;
  if (!supported) return null;

  return (
    <button
      onClick={onEnterVR}
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '7px 14px', borderRadius: 999,
        border: '1px solid rgba(99,102,241,0.4)',
        background: 'rgba(99,102,241,0.15)',
        color: '#a5b4fc', fontSize: 12, fontWeight: 700,
        letterSpacing: '0.06em', textTransform: 'uppercase',
        cursor: 'pointer',
      }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 8a4 4 0 014-4h12a4 4 0 014 4v6a4 4 0 01-4 4h-2l-2 2-2-2H6a4 4 0 01-4-4V8z"/>
        <circle cx="8" cy="11" r="2"/><circle cx="16" cy="11" r="2"/>
      </svg>
      Enter VR
    </button>
  );
}

// ── Embeddable content (for ResultsPage tab) ────────────────────────────
export function VRInspectContent({ rackId }) {
  const canvasRef = useRef(null);
  const [topo, setTopo]     = useState(null);
  const [scan, setScan]     = useState(null);
  const [error, setError]   = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!rackId) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        // Try topology first, fall back to scan
        let topoData = null;
        try {
          const r = await authFetch(apiUrl(`/api/topology/${rackId}`));
          if (r.ok) topoData = await r.json();
        } catch { /* ignore */ }

        // Always need scan data for photo + device bboxes
        const sr = await authFetch(apiUrl(`/api/scan/${rackId}`));
        if (!sr.ok) throw new Error(`Scan fetch failed: ${sr.status}`);
        const scanData = await sr.json();

        if (cancelled) return;
        setScan(scanData);
        setTopo(topoData || scanToTopo(scanData));
      } catch (e) {
        if (!cancelled) setError(e?.message || String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [rackId]);

  const msgStyle = {
    position: 'absolute', inset: 0,
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    gap: 10, padding: 20, textAlign: 'center', color: '#9ca3af',
  };

  if (loading) {
    return <div style={msgStyle}><p style={{ fontSize: 13 }}>Loading VR scene...</p></div>;
  }
  if (error) {
    return (
      <div style={msgStyle}>
        <p style={{ fontSize: 14, color: '#ef4444' }}>Failed to load</p>
        <p style={{ fontSize: 12 }}>{error}</p>
      </div>
    );
  }
  if (!scan) {
    return <div style={msgStyle}><p style={{ fontSize: 13 }}>No scan data available.</p></div>;
  }

  return (
    <div className={styles.embedded}>
      <div className={styles.header}>
        <span className={styles.title}>VR Inspect</span>
        <div className={styles.vrBtn}>
          <VRSupportBanner onEnterVR={() => canvasRef.current?.enterVR()} />
        </div>
      </div>
      <div className={styles.canvasWrap}>
        <Suspense fallback={<div style={msgStyle}><p>Initializing 3D...</p></div>}>
          <VRRackCanvas
            ref={canvasRef}
            topo={topo}
            scanData={scan}
            style={{ position: 'absolute', inset: 0 }}
          />
        </Suspense>
      </div>
    </div>
  );
}

// ── Standalone page (route: /results/:rackId/vr-inspect) ────────────────
export default function VRInspectPage() {
  const { rackId } = useParams();
  const navigate = useNavigate();
  const canvasRef = useRef(null);
  const [topo, setTopo]     = useState(null);
  const [scan, setScan]     = useState(null);
  const [error, setError]   = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!rackId) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        let topoData = null;
        try {
          const r = await authFetch(apiUrl(`/api/topology/${rackId}`));
          if (r.ok) topoData = await r.json();
        } catch { /* ignore */ }

        const sr = await authFetch(apiUrl(`/api/scan/${rackId}`));
        if (!sr.ok) throw new Error(`Scan fetch failed: ${sr.status}`);
        const scanData = await sr.json();

        if (cancelled) return;
        setScan(scanData);
        setTopo(topoData || scanToTopo(scanData));
      } catch (e) {
        if (!cancelled) setError(e?.message || String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [rackId]);

  const msgStyle = {
    position: 'absolute', inset: 0,
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    gap: 10, padding: 20, textAlign: 'center', color: '#9ca3af',
  };

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <button className={styles.backBtn} onClick={() => navigate(-1)} aria-label="Back">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
        </button>
        <span className={styles.title}>VR Inspect &middot; {rackId}</span>
        <div className={styles.vrBtn}>
          <VRSupportBanner onEnterVR={() => canvasRef.current?.enterVR()} />
        </div>
      </div>
      <div className={styles.canvasWrap}>
        {loading && <div style={msgStyle}><p>Loading VR scene...</p></div>}
        {error && (
          <div style={msgStyle}>
            <p style={{ fontSize: 14, color: '#ef4444' }}>Failed to load</p>
            <p style={{ fontSize: 12 }}>{error}</p>
          </div>
        )}
        {!loading && !error && scan && (
          <Suspense fallback={<div style={msgStyle}><p>Initializing 3D...</p></div>}>
            <VRRackCanvas
              ref={canvasRef}
              topo={topo}
              scanData={scan}
              style={{ position: 'absolute', inset: 0 }}
            />
          </Suspense>
        )}
      </div>
    </div>
  );
}

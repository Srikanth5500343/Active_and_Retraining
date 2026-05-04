import { useEffect, useState } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { apiUrl, authFetch } from '../utils/api';
import {
  subscribeProbe,
  triggerBackgroundProbe,
  logicalVerdict,
} from '../utils/portsProbe';
import styles from './PortsPage.module.css';

function fmtMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return '';
  return `${(ms / 1000).toFixed(2)} s`;
}

// ── Page ─────────────────────────────────────────────────────
// Available Ports = live state from the managed switch over SSH.
// CV-derived "physical" port counts are no longer shown — the SSH probe is
// the only source of truth.
export default function PortsPage() {
  const { rackId } = useParams();
  const navigate = useNavigate();
  const { state } = useLocation();

  const [scan, setScan] = useState(null);
  const [scanErr, setScanErr] = useState(null);

  const scanDurationMs = state?.result?.timings?.total_ms ?? null;

  // Probe is cached in localStorage and refreshed only on scan-start (or
  // explicit Retry). Subscribe once; if cache is empty, fire it.
  // triggerBackgroundProbe is idempotent — early-returns when status is
  // 'ok' or 'running'.
  const [probe, setProbe] = useState({ status: 'idle' });
  useEffect(() => subscribeProbe(setProbe), []);
  useEffect(() => {
    if (probe.status === 'idle') triggerBackgroundProbe();
  }, [probe.status]);

  useEffect(() => {
    if (!rackId) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await authFetch(apiUrl(`/api/scan/${rackId}/result`));
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        if (!cancelled) setScan(data);
      } catch (err) {
        if (!cancelled) setScanErr(err.message || 'Failed to load scan');
      }
    })();
    return () => { cancelled = true; };
  }, [rackId]);

  if (scanErr) {
    return (
      <div className={styles.page}>
        <PageHeader rackId={rackId} onBack={() => navigate(-1)} />
        <div className={styles.error}>Failed to load scan: {scanErr}</div>
      </div>
    );
  }
  if (!scan) {
    return (
      <div className={styles.page}>
        <PageHeader rackId={rackId} onBack={() => navigate(-1)} />
        <div className={styles.loading}>Loading rack…</div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <PageHeader rackId={rackId} onBack={() => navigate(-1)} />
      <LogicalView probe={probe} scan={scan} scanDurationMs={scanDurationMs} />
    </div>
  );
}

// ── Header ───────────────────────────────────────────────────
function PageHeader({ rackId, onBack }) {
  return (
    <header className={styles.header}>
      <button className={styles.backBtn} onClick={onBack}>← Back</button>
      <div className={styles.headerCenter}>
        <h2>Available Ports</h2>
        <span className={styles.headerMono}>{rackId}</span>
      </div>
      <div style={{ width: 64 }} />
    </header>
  );
}

// ── Hero card: rack identity + stat tiles in one uniform card ───
function RackHero({ scan, scanDurationMs, avail, used, reserved }) {
  return (
    <section className={styles.hero}>
      <div className={styles.heroTop}>
        <div className={styles.heroIdent}>
          <div className={styles.rackTitle}>{scan.rackId}</div>
          <div className={styles.rackSubLine}>
            {scan.units_range && <span className={styles.rackChip}>{scan.units_range}</span>}
            <span className={styles.rackChip}>{(scan.units_detected || []).length} units</span>
          </div>
        </div>
        {scanDurationMs != null && (
          <span className={styles.scanTimer} title="Scan duration">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
            </svg>
            Done in {fmtMs(scanDurationMs)}
          </span>
        )}
      </div>

      <div className={styles.heroStats}>
        <Stat label="Available" value={avail}    accent="green" />
        <Stat label="Used"      value={used}     accent="red" />
        <Stat label="Reserved"  value={reserved} accent="dim" />
      </div>
    </section>
  );
}

function Stat({ label, value, accent }) {
  return (
    <div className={styles.stat}>
      <div className={`${styles.statValue} ${styles[`stat_${accent}`] || ''}`}>{value}</div>
      <div className={styles.statLabel}>{label}</div>
    </div>
  );
}

// ── Logical view ─────────────────────────────────────────────
function LogicalView({ probe, scan, scanDurationMs }) {
  if (probe.status === 'running' || probe.status === 'idle') {
    return (
      <>
        <RackHero scan={scan} scanDurationMs={scanDurationMs} avail="—" used="—" reserved="—" />
        <OrbitalLoader startedAt={probe.startedAt} />
      </>
    );
  }
  if (probe.status === 'error') {
    return (
      <>
        <RackHero scan={scan} scanDurationMs={scanDurationMs} avail="—" used="—" reserved="—" />
        <div className={styles.errorBox}>
          <span>Probe failed: {probe.error}</span>
          <button className={styles.retryBtn} onClick={() => triggerBackgroundProbe({ force: true })}>Retry</button>
        </div>
      </>
    );
  }

  const ports = Array.isArray(probe.ports) ? probe.ports : [];
  let avail = 0, used = 0, reserved = 0;
  for (const p of ports) {
    const v = logicalVerdict(p);
    if (v === 'available') avail++;
    else if (v === 'used') used++;
    else reserved++;
  }

  return (
    <>
      <RackHero scan={scan} scanDurationMs={scanDurationMs} avail={avail} used={used} reserved={reserved} />

      <section className={styles.cardGrid}>
        <p className={styles.tableHint}>
          Live state from your network switch (admin via stored credentials). Available = admin-up, link-down, no description.
        </p>
        <div className={styles.rowHead}>
          <span>Switch</span>
          <span className={styles.rowHeadNum}>Avail</span>
          <span className={styles.rowHeadNum}>Used</span>
          <span className={styles.rowHeadNum}>Reserved</span>
        </div>
        <div className={styles.switchRow}>
          <div className={styles.rowLabel}>
            <span className={styles.rowName}>Network switch</span>
            <span className={styles.rowPos}>TP-Link</span>
          </div>
          <div className={styles.rowAvailCell}>
            <span className={styles.rowNum} data-tone="green">{avail}</span>
          </div>
          <div className={styles.rowAvailCell}>
            <span className={styles.rowNum} data-tone="red">{used}</span>
          </div>
          <div className={styles.rowAvailCell}>
            {reserved > 0
              ? <span className={styles.rowNum} data-tone="dim">{reserved}</span>
              : <span className={styles.rowDim}>—</span>}
          </div>
        </div>
      </section>
    </>
  );
}

// Two concentric counter-rotating arcs + a soft pulsing core. Mirrors the
// look-and-feel of ScanPage's analyze step — no plain "Probing…" stripe.
function OrbitalLoader({ startedAt }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!startedAt) return;
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 250);
    return () => clearInterval(id);
  }, [startedAt]);
  return (
    <div className={styles.orbitalWrap}>
      <div className={styles.orbital}>
        <span className={styles.orbitalRing} />
        <span className={styles.orbitalRing} />
        <span className={styles.orbitalCore} />
      </div>
      <div className={styles.orbitalLabel}>
        Loading<span className={styles.dotPulse}>.</span><span className={styles.dotPulse}>.</span><span className={styles.dotPulse}>.</span>
      </div>
      {startedAt && <div className={styles.orbitalElapsed}>{elapsed}s</div>}
    </div>
  );
}

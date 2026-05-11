import { useEffect, useState, useMemo } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { apiUrl, authFetch } from '../utils/api';
import {
  subscribeProbe,
  triggerBackgroundProbe,
  logicalVerdict,
} from '../utils/portsProbe';
import { fetchSfpAnalysis, generateOfflineFallback, SFP_SLOT_TYPES } from '../utils/sfpDatabase';
import RackTabs from '../components/RackTabs.jsx';
import styles from './PortsPage.module.css';

function fmtMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return '';
  return `${(ms / 1000).toFixed(2)} s`;
}

// ── Port classification ─────────────────────────────────────
function classifyPorts(probePorts, scan) {
  if (!probePorts?.length) return { rj45: [], sfp: [] };

  // Best signal: the switch told us the medium (TP-Link Active-Medium column)
  const hasMedium = probePorts.some(p => p.medium === 'fiber' || p.medium === 'copper');
  if (hasMedium) {
    const rj45 = [], sfp = [];
    for (const p of probePorts) {
      if (p.medium === 'fiber') sfp.push(p);
      else rj45.push(p);
    }
    return { rj45, sfp };
  }

  // Cisco-style: classify by interface prefix
  const hasCiscoNames = probePorts.some(p =>
    /^(Gi|Fa|Te|Fo|Hu)/i.test(p.iface)
  );
  if (hasCiscoNames) {
    const rj45 = [], sfp = [];
    for (const p of probePorts) {
      if (/^(Te|Fo|Hu)/i.test(p.iface)) sfp.push(p);
      else rj45.push(p);
    }
    return { rj45, sfp };
  }

  // Fallback: use scan data's CV-detected port_count to find split point
  const switchDev = scan?.devices?.find(d =>
    d.class_name === 'Switch' && d.port_count > 0
  );
  const cvMainCount = switchDev?.port_count || 0;
  const cvSfpCount = switchDev?.sfp_ports?.length || 0;
  const total = probePorts.length;

  let splitAt;
  if (cvMainCount > 0 && cvMainCount < total) {
    splitAt = cvMainCount;
  } else if (cvSfpCount > 0 && (total - cvSfpCount) > 0) {
    splitAt = total - cvSfpCount;
  } else if (total > 24) {
    splitAt = total - 4;
  } else if (total > 8) {
    splitAt = total - 2;
  } else {
    splitAt = total;
  }

  return {
    rj45: probePorts.slice(0, splitAt),
    sfp: probePorts.slice(splitAt),
  };
}

function shortLabel(iface) {
  const tpMatch = iface.match(/^1\/0\/(\d+)$/);
  if (tpMatch) return tpMatch[1];
  const ciscoMatch = iface.match(/^[A-Za-z]{1,2}\d+\/\d+\/(\d+)$/);
  if (ciscoMatch) return ciscoMatch[1];
  const nums = iface.match(/(\d+)$/);
  return nums ? nums[1] : iface;
}

function countByVerdict(portList) {
  let avail = 0, used = 0, reserved = 0;
  for (const p of portList) {
    const v = logicalVerdict(p);
    if (v === 'available') avail++;
    else if (v === 'used') used++;
    else reserved++;
  }
  return { avail, used, reserved };
}

// ── Ports summary card ───────────────────────────────────────
function PortsSummaryCard({ totalPorts, sfpCount, availableCount, availablePorts, sfpPortIfaces }) {
  const [showTable, setShowTable] = useState(false);

  // Breakdown so the card can show ETH vs SFP availability at a glance
  // — a single "5 ports free" doesn't tell you whether you can plug in
  // an SFP+ uplink.
  const availSfp = availablePorts.filter(p => sfpPortIfaces.has(p.iface)).length;
  const availEth = availableCount - availSfp;
  const usedCount = Math.max(0, totalPorts - availableCount);
  const utilizationPct = totalPorts > 0
    ? Math.round((usedCount / totalPorts) * 100)
    : 0;
  const hasAny = availableCount > 0;

  return (
    <section className={styles.summaryCard}>
      <div className={styles.summaryHero}>
        {/* Big count badge */}
        <div className={`${styles.heroBadge} ${hasAny ? '' : styles.heroBadgeEmpty}`}>
          <span className={styles.heroCount}>{availableCount}</span>
          <span className={styles.heroOf}>of {totalPorts}</span>
        </div>

        {/* Label + breakdown chips */}
        <div className={styles.heroBody}>
          <span className={styles.heroLabel}>Available ports</span>
          <div className={styles.heroChips}>
            <span className={`${styles.heroChip} ${styles.heroChipEth}`}>
              <span className={styles.heroChipDot} />
              <span className={styles.heroChipNum}>{availEth}</span>
              <span className={styles.heroChipLabel}>ETH</span>
            </span>
            {sfpCount > 0 && (
              <span className={`${styles.heroChip} ${styles.heroChipSfp}`}>
                <span className={styles.heroChipDot} />
                <span className={styles.heroChipNum}>{availSfp}</span>
                <span className={styles.heroChipLabel}>SFP</span>
              </span>
            )}
            <span className={styles.heroUsed}>· {usedCount} in use</span>
          </div>
        </div>

        {/* Toggle to show full list */}
        {hasAny && (
          <button
            type="button"
            className={`${styles.summaryInlineToggle} ${showTable ? styles.summaryInlineToggleOpen : ''}`}
            onClick={() => setShowTable(v => !v)}
            aria-label={showTable ? 'Hide port list' : 'Show port list'}
            aria-expanded={showTable}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ transform: showTable ? 'rotate(180deg)' : 'none', transition: 'transform .2s ease' }}>
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        )}
      </div>

      {/* Utilization bar — visual context for "how full is this switch" */}
      {totalPorts > 0 && (
        <div className={styles.utilWrap} role="img" aria-label={`${utilizationPct}% utilized`}>
          <div className={styles.utilBar}>
            <div
              className={styles.utilFill}
              style={{ width: `${utilizationPct}%` }}
            />
          </div>
          <span className={styles.utilPct}>{utilizationPct}%</span>
        </div>
      )}

      {/* Available ports table — only shown when toggled */}
      {showTable && (
        availableCount === 0
          ? <div className={styles.summaryNone}>None available</div>
          : (
            <div className={styles.portTable}>
              <div className={styles.portTableHead}>
                <span>Port</span>
                <span>Type</span>
                <span>Interface</span>
                <span>Status</span>
              </div>
              {availablePorts.map((p, i) => {
                const isSfp = sfpPortIfaces.has(p.iface);
                return (
                  <div key={p.iface} className={`${styles.portTableRow} ${i % 2 === 1 ? styles.portTableRowAlt : ''}`}>
                    <span className={styles.portTableNum}>{shortLabel(p.iface)}</span>
                    <span className={`${styles.portTableType} ${isSfp ? styles.portTableTypeSfp : styles.portTableTypeEth}`}>
                      {isSfp ? 'SFP' : 'ETH'}
                    </span>
                    <span className={styles.portTableIface}>{p.iface}</span>
                    <span className={styles.portTableStatus}>Available</span>
                  </div>
                );
              })}
            </div>
          )
      )}
    </section>
  );
}

// ── Embeddable content (used as a tab in ResultsPage) ────────
export function PortsContent({ rackId }) {
  const [scan, setScan] = useState(null);
  const [scanErr, setScanErr] = useState(null);

  const [probe, setProbe] = useState({ status: 'idle' });
  useEffect(() => subscribeProbe(setProbe), []);
  useEffect(() => {
    triggerBackgroundProbe();
  }, []);

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

  if (scanErr) return <div className={styles.error}>Failed to load scan: {scanErr}</div>;
  if (!scan) return <div className={styles.loading}>Loading rack...</div>;

  return <LogicalView probe={probe} scan={scan} scanDurationMs={null} />;
}

// ── Standalone page (used by /results/:rackId/ports route) ───
export default function PortsPage() {
  const { rackId } = useParams();
  const navigate = useNavigate();
  const { state } = useLocation();

  const [scan, setScan] = useState(null);
  const [scanErr, setScanErr] = useState(null);

  const scanDurationMs = state?.result?.timings?.total_ms ?? null;

  const [probe, setProbe] = useState({ status: 'idle' });
  useEffect(() => subscribeProbe(setProbe), []);
  useEffect(() => {
    triggerBackgroundProbe();
  }, []);

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
        <div className={styles.loading}>Loading rack...</div>
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
    <>
      <header className={styles.header}>
        <button className={styles.backBtn} onClick={onBack}>← Back</button>
        <div className={styles.headerCenter}>
          <h2>Available Ports</h2>
          <span className={styles.headerMono}>{rackId}</span>
        </div>
        <div style={{ width: 64 }} />
      </header>
      {/* Renders nothing when this rack is standalone */}
      <RackTabs rackId={rackId} />
    </>
  );
}

// ── Filter chip ──────────────────────────────────────────────
function FilterChip({ active, onClick, label, count, color }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${styles.filterChip} ${active ? styles.filterChipActive : ''}`}
    >
      {color && <span className={styles.filterChipDot} style={{ background: color }} />}
      <span>{label}</span>
      <span className={styles.filterChipCount}>{count}</span>
    </button>
  );
}

// ── Port tile ────────────────────────────────────────────────
function PortTile({ port, onClick }) {
  const verdict = logicalVerdict(port);
  const label = shortLabel(port.iface);
  return (
    <button
      type="button"
      className={`${styles.portTile} ${styles[`tile_${verdict}`]}`}
      onClick={onClick}
      title={port.iface}
    >
      <span className={styles.tileLabel}>{label}</span>
    </button>
  );
}

// ── Port detail popover ──────────────────────────────────────
function PortDetail({ port, onClose }) {
  const verdict = logicalVerdict(port);
  const verdictLabel = verdict.charAt(0).toUpperCase() + verdict.slice(1);
  return (
    <div className={styles.detailOverlay} onClick={onClose}>
      <div className={styles.detailCard} onClick={e => e.stopPropagation()}>
        <div className={styles.detailHeader}>
          <span className={`${styles.detailStatus} ${styles[`detail_${verdict}`]}`}>
            {verdictLabel}
          </span>
          <button className={styles.detailClose} onClick={onClose}>&times;</button>
        </div>
        <div className={styles.detailRow}>
          <span className={styles.detailKey}>Interface</span>
          <span className={styles.detailVal}>{port.iface}</span>
        </div>
        <div className={styles.detailRow}>
          <span className={styles.detailKey}>Status</span>
          <span className={styles.detailVal}>{port.status || '\u2014'}</span>
        </div>
        {port.description && (
          <div className={styles.detailRow}>
            <span className={styles.detailKey}>Description</span>
            <span className={styles.detailVal}>{port.description}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Logical view ─────────────────────────────────────────────
function LogicalView({ probe, scan, scanDurationMs }) {
  if (probe.status === 'running' || probe.status === 'idle') {
    return <OrbitalLoader startedAt={probe.startedAt} />;
  }
  if (probe.status === 'error') {
    return (
      <div className={styles.errorBox}>
        <span>Probe failed: {probe.error}</span>
        <button className={styles.retryBtn} onClick={() => triggerBackgroundProbe({ force: true })}>Retry</button>
      </div>
    );
  }

  const ports = Array.isArray(probe.ports) ? probe.ports : [];
  const { rj45, sfp } = classifyPorts(ports, scan);
  const sfpCounts = countByVerdict(sfp);
  const totalAvail = countByVerdict(rj45).avail + sfpCounts.avail;

  const availablePorts = ports.filter(p => logicalVerdict(p) === 'available');
  const sfpPortIfaces = new Set(sfp.map(p => p.iface));

  return (
    <>
      <PortsSummaryCard
        totalPorts={ports.length}
        sfpCount={sfp.length}
        availableCount={totalAvail}
        availablePorts={availablePorts}
        sfpPortIfaces={sfpPortIfaces}
      />

      {/* SFP Procurement Advisor */}
      {sfp.length > 0 && (
        <SfpAdvisor scan={scan} sfpPorts={sfp} sfpCounts={sfpCounts} />
      )}
    </>
  );
}

// ── SFP Procurement Advisor (Dynamic — scrapes vendor data live) ─────
function SfpAdvisor({ scan, sfpPorts, sfpCounts }) {
  const [expanded, setExpanded] = useState(false);
  const [advice, setAdvice] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showAlternatives, setShowAlternatives] = useState(false);

  const scanSwitch = scan?.devices?.find(d => d.class_name === 'Switch');
  const vendor = scanSwitch?.make || 'Unknown';
  const model = scanSwitch?.model || 'Unknown';
  const ifaces = sfpPorts?.map(p => p.iface) || [];

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      let v = vendor, m = model;
      try {
        const ocrR = await authFetch(apiUrl(`/api/scan/${scan.rackId}/ocr-devices`));
        if (ocrR.ok) {
          const ocrData = await ocrR.json();
          const ocrSwitch = (ocrData.devices || []).find(d =>
            d.class_name === 'Switch' && (d.make || d.model)
          );
          if (ocrSwitch) {
            if (v === 'Unknown' && ocrSwitch.make) v = ocrSwitch.make;
            if (m === 'Unknown' && ocrSwitch.model) m = ocrSwitch.model;
          }
        }
      } catch (_) {}
      const result = await fetchSfpAnalysis(v, m, ifaces);
      if (cancelled) return;
      setAdvice(result || generateOfflineFallback({ vendor: v, model: m, sfpPorts, sfpCounts }));
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [scan?.rackId]);

  if (loading) {
    return (
      <section className={styles.advisorSection}>
        <div className={styles.advisorHead}>
          <div className={styles.advisorTitleRow}>
            <svg className={styles.advisorIcon} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
            <h3 className={styles.advisorTitle}>SFP Procurement Advisor</h3>
            <span className={styles.advisorBadge}>AI</span>
          </div>
        </div>
        <div className={styles.advisorLoading}>
          <div className={styles.advisorSpinner} />
          <div className={styles.advisorLoadingText}>
            Analyzing<span className={styles.dotPulse}>.</span><span className={styles.dotPulse}>.</span><span className={styles.dotPulse}>.</span>
          </div>
        </div>
      </section>
    );
  }

  if (!advice) return null;

  const slotInfo = advice.slotInfo || SFP_SLOT_TYPES[advice.slotType] || SFP_SLOT_TYPES['SFP'];
  const sfpsToProcure = sfpCounts?.avail || 0;
  const allModules = advice.modules || [];
  const cables = advice.cables || [];
  
  // Total cost in cards is computed against all available SFP ports.
  const currentQty = sfpsToProcure;

  // Categorize modules for better presentation.
  // Dedup by partNumber: `advice.recommended` and `advice.modules[i]` are
  // separate objects after JSON parsing even when they hold the same module,
  // so reference equality (m !== recommended) would leak the recommended
  // entry into the alternatives list.
  const recommended = advice.recommended;
  const budgetOption = advice.budget;
  const recPN = recommended?.partNumber;
  const budgetPN = budgetOption?.partNumber;
  const alternativeModules = allModules.filter(m =>
    m.partNumber !== recPN && m.partNumber !== budgetPN
  ).slice(0, 12);  // Show up to 12 alternatives

  const parsePrice = (p) => {
    if (!p) return null;
    const n = parseFloat(String(p).replace(/[$,]/g, ''));
    return isNaN(n) ? null : n;
  };
  const fmtTotal = (unit, qty) =>
    unit != null ? `$${(unit * qty).toFixed(2)}` : null;
  const sourceDomain = (url) => {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch (_) {
      return null;
    }
  };
  const specsLine = (m) =>
    [m.speed, m.type, m.maxDistance, m.wavelength].filter(Boolean).join(' · ');

  return (
    <section className={styles.advisorSection}>
      <div className={styles.advisorHead}>
        <div className={styles.advisorTitleRow}>
          <svg className={styles.advisorIcon} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
          </svg>
          <h3 className={styles.advisorTitle}>SFP Procurement Advisor</h3>
          <span className={styles.advisorBadge}>AI</span>
          <span className={styles.headSpacer} />
          <span className={styles.headSlotInfo}>
            <span className={styles.metaSlot}>{slotInfo.formFactor || advice.slotType}</span>
            <span className={styles.metaDot} aria-hidden>·</span>
            <span className={styles.metaSpeed}>{slotInfo.maxSpeed || slotInfo.speed}</span>
          </span>
        </div>
      </div>

      <div className={styles.advisorContent}>
        {/* EMPTY STATE — couldn't find live listings, offer direct search
            links to common third-party suppliers so the user has a one-click
            path to find a real product instead of a dead-end. */}
        {!recommended && allModules.length === 0 && (() => {
          const q = encodeURIComponent(
            `${vendor} ${model} compatible ${advice.slotType} transceiver`
          );
          const links = [
            { label: 'FS.com',  url: `https://www.fs.com/search.html?keyword=${q}` },
            { label: '10Gtek',  url: `https://www.10gtek.com/?s=${q}` },
            { label: 'Google',  url: `https://www.google.com/search?q=${q}` },
          ];
          return (
            <div className={styles.emptyHint}>
              <strong>No live listings found</strong> for {vendor} {model} {advice.slotType} transceivers.
              Try a direct search:
              <div className={styles.emptyLinks}>
                {links.map(l => (
                  <a key={l.label} href={l.url} target="_blank" rel="noopener noreferrer" className={styles.emptyLink}>
                    {l.label} →
                  </a>
                ))}
              </div>
            </div>
          );
        })()}

        {/* HERO TOP PICK — visually dominant card for the recommended module */}
        {recommended && (() => {
          const unit = parsePrice(recommended.price);
          const total = fmtTotal(unit, currentQty);
          const domain = recommended.sourceUrl ? sourceDomain(recommended.sourceUrl) : null;
          return (
            <div className={styles.heroPick}>
              <div className={styles.heroPickRibbon}>
                <span className={styles.heroPickBadge}>★ TOP PICK</span>
                <span className={styles.heroPickBrand}>{recommended.brand || 'Unknown'}</span>
              </div>
              <div className={styles.heroPickSku}>{recommended.partNumber}</div>
              <div className={styles.heroPickSpecs}>
                {recommended.speed && <span className={styles.heroSpecChip}>{recommended.speed}</span>}
                {recommended.type && <span className={styles.heroSpecChip}>{recommended.type}</span>}
                {recommended.maxDistance && <span className={styles.heroSpecChip}>{recommended.maxDistance}</span>}
                {recommended.wavelength && <span className={styles.heroSpecChip}>{recommended.wavelength}</span>}
              </div>
              {recommended.price && (
                <div className={styles.heroPickPrice}>
                  <span className={styles.heroPickUnit}>{recommended.price}<span className={styles.heroPickEa}>each</span></span>
                  {currentQty > 1 && total && (
                    <>
                      <span className={styles.heroPickPriceDot}>·</span>
                      <span className={styles.heroPickTotal}>{total} for {currentQty}</span>
                    </>
                  )}
                </div>
              )}
              {recommended.sourceUrl && (
                <a
                  href={recommended.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={styles.heroPickCta}
                >
                  {domain ? `View on ${domain}` : 'View product'} →
                </a>
              )}
            </div>
          );
        })()}

        {/* COMPACT BUDGET — single-row layout, less visual weight than the hero */}
        {budgetOption && budgetOption.partNumber !== recPN && (() => {
          const unit = parsePrice(budgetOption.price);
          const total = fmtTotal(unit, currentQty);
          return (
            <a
              href={budgetOption.sourceUrl || '#'}
              target={budgetOption.sourceUrl ? '_blank' : undefined}
              rel={budgetOption.sourceUrl ? 'noopener noreferrer' : undefined}
              className={styles.compactPick}
              onClick={!budgetOption.sourceUrl ? (e) => e.preventDefault() : undefined}
            >
              <div className={styles.compactPickTag}>$ BEST PRICE</div>
              <div className={styles.compactPickInfo}>
                <div className={styles.compactPickHead}>
                  <span className={styles.compactPickBrand}>{budgetOption.brand || 'Unknown'}</span>
                  <span className={styles.compactPickSku}>{budgetOption.partNumber}</span>
                </div>
                <div className={styles.compactPickMeta}>{specsLine(budgetOption)}</div>
              </div>
              <div className={styles.compactPickRight}>
                {budgetOption.price && (
                  <div className={styles.compactPickPrices}>
                    <span className={styles.compactPickUnit}>{budgetOption.price}</span>
                    {currentQty > 1 && total && (
                      <span className={styles.compactPickTotal}>{total}</span>
                    )}
                  </div>
                )}
                {budgetOption.sourceUrl && (
                  <span className={styles.compactPickArrow}>→</span>
                )}
              </div>
            </a>
          );
        })()}

        {/* ALTERNATIVES — preview chips when collapsed, row list when expanded */}
        {alternativeModules.length > 0 && (
          <div className={styles.altsBlock}>
            <button
              type="button"
              className={styles.altsHeader}
              onClick={() => setShowAlternatives(v => !v)}
            >
              <span className={styles.altsHeaderLabel}>
                <span className={styles.altsCount}>{alternativeModules.length}</span>
                more compatible {alternativeModules.length === 1 ? 'module' : 'modules'}
              </span>
              <span className={styles.altsHeaderToggle}>{showAlternatives ? '−' : '+'}</span>
            </button>
            {!showAlternatives && (
              <div className={styles.altsPreview}>
                {alternativeModules.slice(0, 5).map(m => (
                  <span key={m.partNumber} className={styles.altsPreviewChip}>
                    <span className={styles.altsPreviewBrand}>{m.brand || '?'}</span>
                    <span className={styles.altsPreviewSku}>{m.partNumber}</span>
                  </span>
                ))}
                {alternativeModules.length > 5 && (
                  <span className={styles.altsPreviewMore}>+{alternativeModules.length - 5}</span>
                )}
              </div>
            )}
            {showAlternatives && (
              <div className={styles.altsList}>
                {alternativeModules.map(m => {
                  const unit = parsePrice(m.price);
                  const total = fmtTotal(unit, currentQty);
                  const Tag = m.sourceUrl ? 'a' : 'div';
                  const linkProps = m.sourceUrl
                    ? { href: m.sourceUrl, target: '_blank', rel: 'noopener noreferrer' }
                    : {};
                  return (
                    <Tag
                      key={m.partNumber}
                      {...linkProps}
                      className={styles.altsRow}
                    >
                      <div className={styles.altsRowMain}>
                        <span className={styles.altsRowBrand}>{m.brand || 'Unknown'}</span>
                        <span className={styles.altsRowSku}>{m.partNumber}</span>
                      </div>
                      <div className={styles.altsRowMeta}>{specsLine(m) || '—'}</div>
                      <div className={styles.altsRowSide}>
                        {m.price && (
                          <span className={styles.altsRowPrice}>
                            {m.price}
                            {currentQty > 1 && total && (
                              <span className={styles.altsRowPriceTotal}>{total}</span>
                            )}
                          </span>
                        )}
                        {m.sourceUrl && <span className={styles.altsRowArrow}>→</span>}
                      </div>
                    </Tag>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* CABLING — compact horizontal strip, one item per cable type */}
        {cables.length > 0 && (
          <div className={styles.cableStrip}>
            <div className={styles.cableStripHead}>
              <span className={styles.cableStripTitle}>Compatible cabling</span>
              <span className={styles.cableStripSub}>{advice.slotType}</span>
            </div>
            <div className={styles.cableStripList}>
              {cables.slice(0, 3).map((c, i) => (
                <div key={i} className={styles.cableStripItem}>
                  <div className={styles.cableStripItemType}>{c.type}</div>
                  <div className={styles.cableStripItemFiber}>{c.fiber}</div>
                  <div className={styles.cableStripItemConnector}>{c.connector}</div>
                  <div className={styles.cableStripItemDist}>{c.maxDist}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* FOOTER — datasheet link + sources count, single line */}
        {(advice.searchResults?.length > 0 || advice.productUrl) && (
          <div className={styles.advisorFooter}>
            {advice.productUrl && (
              <a
                href={advice.productUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={styles.advisorFooterLink}
              >
                📄 Switch datasheet
              </a>
            )}
            {advice.searchResults?.length > 0 && (
              <span className={styles.advisorFooterNote}>
                {allModules.length} {allModules.length === 1 ? 'module' : 'modules'} · {advice.searchResults.length} sources
              </span>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

// ── Orbital loader ───────────────────────────────────────────
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

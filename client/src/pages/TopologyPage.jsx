import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { apiUrl, authFetch } from '../utils/api';
import { getCached, setCached, cacheKey } from '../utils/scanPrefetch';
import RackTabs from '../components/RackTabs.jsx';
import styles from './TopologyPage.module.css';

const TopologyScene3D = lazy(() => import('./TopologyScene3D.jsx'));

const TIER_COLOR = {
  core: '#f59e0b',          // amber — uplink/core
  distribution: '#6366f1',  // cyan — switches
  access: '#60a5fa',        // blue — patch panels
  endpoint: '#a78bfa',      // violet — servers / hosts
};

const CLASS_LABEL = {
  switch: 'Switch',
  patch_panel: 'Patch Panel',
  server: 'Server',
};

function tierOf(dev) {
  if (!dev.in_rack && dev.class === 'switch') return 'core';
  if (dev.class === 'switch') return 'distribution';
  if (dev.class === 'patch_panel') return 'access';
  if (dev.class === 'server') return 'endpoint';
  return null;
}

const TIER_ORDER = ['core', 'distribution', 'access', 'endpoint'];
const TIER_LABEL = {
  core: 'CORE / UPLINK',
  distribution: 'SWITCHES',
  access: 'PATCH PANELS',
  endpoint: 'END HOSTS',
};

const VIEW_KEY = 'topology.view';

// Cable-type filter — matches the same buckets as cableColor() in TopologyScene3D.
function matchesCableType(cable_type, filter) {
  if (filter === 'all') return true;
  const t = (cable_type || '').toLowerCase();
  if (filter === 'fiber') return /fiber|mm|sm/.test(t);
  if (filter === 'dac')   return /dac|twinax/.test(t);
  if (filter === 'cat')   return t.startsWith('cat');
  return true;
}

// Capacity → color: green (lots free) → amber → red (nearly full).
function heatmapColor(freePct) {
  if (freePct === null || freePct === undefined) return '#475569';
  if (freePct >= 0.5)  return '#22c55e';
  if (freePct >= 0.25) return '#f59e0b';
  return '#ef4444';
}

// ── Embeddable content (used as a tab in ResultsPage) ────────
export function TopologyContent({ rackId }) {
  return <TopologyInner rackId={rackId} embedded />;
}

// ── Standalone page (used by /results/:rackId/topology route) ───
export default function TopologyPage() {
  const { rackId } = useParams();
  return <TopologyInner rackId={rackId} embedded={false} />;
}

function TopologyInner({ rackId, embedded }) {
  const navigate = useNavigate();
  // Hydrate from the prefetch cache so that a tab/page switch into
  // /results/:rackId/topology after a fresh analyze renders the 3D scene
  // immediately, without the "Loading topology…" spinner. ScanPage fired
  // prefetchScan(rackId) at analyze time so this is normally already
  // resolved by the time the user gets here.
  const cachedTopo = rackId ? getCached(cacheKey.topology(rackId)) : null;
  const [topo, setTopo] = useState(cachedTopo);
  const [err, setErr] = useState(null);
  const [selected, setSelected] = useState(null); // { kind: 'node'|'edge', id }
  const [view, setView] = useState(() => {
    try { return localStorage.getItem(VIEW_KEY) || '3d'; } catch { return '3d'; }
  });
  const [cableFilter, setCableFilter] = useState('all'); // 'all' | 'cat' | 'fiber' | 'dac'
  const [heatmap, setHeatmap]         = useState(false);
  const [traceMode, setTraceMode]     = useState(false);
  const [traceA, setTraceA]           = useState(null);
  const [traceB, setTraceB]           = useState(null);
  const [hoverInfo, setHoverInfo]     = useState(null); // { name, dev, freePct, tier }

  useEffect(() => {
    try { localStorage.setItem(VIEW_KEY, view); } catch {}
  }, [view]);

  useEffect(() => {
    if (!rackId) return;
    // If we already hydrated from the prefetch cache, no fetch needed.
    if (topo) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await authFetch(apiUrl(`/api/topology/${rackId}`));
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${r.status}`);
        }
        const data = await r.json();
        if (!cancelled) {
          setTopo(data);
          setCached(cacheKey.topology(rackId), data);
        }
      } catch (e) {
        if (!cancelled) setErr(e.message);
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rackId]);

  // Filtered topology — same shape, just with cables narrowed by the active
  // pill. Filter at the topo level so both 2D + 3D + bottom-panel agree.
  const filteredTopo = useMemo(() => {
    if (!topo) return null;
    if (cableFilter === 'all') return topo;
    return {
      ...topo,
      edges: topo.edges.filter(e => matchesCableType(e.cable_type, cableFilter)),
    };
  }, [topo, cableFilter]);

  // Per-cable-type counts for the filter pill labels.
  const cableCounts = useMemo(() => {
    const c = { all: 0, cat: 0, fiber: 0, dac: 0 };
    if (!topo) return c;
    c.all = topo.edges.length;
    for (const e of topo.edges) {
      const t = (e.cable_type || '').toLowerCase();
      if (t.startsWith('cat'))           c.cat++;
      else if (/fiber|mm|sm/.test(t))    c.fiber++;
      else if (/dac|twinax/.test(t))     c.dac++;
    }
    return c;
  }, [topo]);

  // Free-port % per device — drives the capacity heatmap when toggled on.
  const freePctByDevice = useMemo(() => {
    const m = new Map();
    if (!topo) return m;
    for (const d of topo.devices) {
      const total = (d.ports || []).length;
      if (total === 0) { m.set(d.name, null); continue; }
      const connected = d.ports.filter(p => p.connected !== false).length;
      m.set(d.name, (total - connected) / total);
    }
    return m;
  }, [topo]);

  // Aggregate edges by unordered device pair: 24 cables SW-U10↔PP-U12 -> 1 edge with count=24.
  const aggEdges = useMemo(() => {
    if (!filteredTopo) return [];
    const m = new Map();
    for (const e of filteredTopo.edges) {
      const a = e.src.device, b = e.dst.device;
      const key = a < b ? `${a}::${b}` : `${b}::${a}`;
      if (!m.has(key)) m.set(key, { a: a < b ? a : b, b: a < b ? b : a, count: 0, cables: [] });
      const v = m.get(key);
      v.count += 1;
      v.cables.push(e);
    }
    return Array.from(m.values());
  }, [filteredTopo]);

  // BFS the device-pair graph to find a connection path A → B.
  const tracePath = useMemo(() => {
    if (!traceMode || !traceA || !traceB) return null;
    const adj = new Map();
    for (const e of aggEdges) {
      if (!adj.has(e.a)) adj.set(e.a, new Set());
      if (!adj.has(e.b)) adj.set(e.b, new Set());
      adj.get(e.a).add(e.b);
      adj.get(e.b).add(e.a);
    }
    if (traceA === traceB) return [traceA];
    const visited = new Set([traceA]);
    const queue   = [[traceA]];
    while (queue.length) {
      const path = queue.shift();
      const node = path[path.length - 1];
      for (const next of (adj.get(node) || [])) {
        if (visited.has(next)) continue;
        visited.add(next);
        const newPath = [...path, next];
        if (next === traceB) return newPath;
        queue.push(newPath);
      }
    }
    return [];   // empty array = no path found
  }, [traceMode, traceA, traceB, aggEdges]);

  // Set of edge keys ("a::b" sorted) that make up the trace path.
  const traceEdgeKeys = useMemo(() => {
    if (!tracePath || tracePath.length < 2) return null;
    const keys = new Set();
    for (let i = 0; i < tracePath.length - 1; i++) {
      const a = tracePath[i], b = tracePath[i+1];
      keys.add(a < b ? `${a}::${b}` : `${b}::${a}`);
    }
    return keys;
  }, [tracePath]);

  const tracePathSet = useMemo(
    () => (tracePath && tracePath.length > 0 ? new Set(tracePath) : null),
    [tracePath]
  );

  // Wrap setSelected so trace mode intercepts clicks: 1st click → A, 2nd → B,
  // 3rd → resets to a new A. Click-empty (PointerMissed) clears trace too.
  const handleSelect = (sel) => {
    if (traceMode && sel?.kind === 'node') {
      if (!traceA || (traceA && traceB)) { setTraceA(sel.id); setTraceB(null); }
      else if (sel.id !== traceA)        { setTraceB(sel.id); }
      return;
    }
    setSelected(sel);
  };

  // Selection details (used by BottomPanel — works for both 2D and 3D views)
  const selectionInfo = useMemo(() => {
    if (!topo || !selected) return null;
    const deviceMap = new Map(topo.devices.map(d => [d.name, d]));
    if (selected.kind === 'node') {
      const dev = deviceMap.get(selected.id);
      if (!dev) return null;
      const peers = aggEdges
        .filter(e => e.a === dev.name || e.b === dev.name)
        .map(e => ({ peer: e.a === dev.name ? e.b : e.a, count: e.count, cables: e.cables }))
        .sort((x, y) => y.count - x.count);
      return { kind: 'node', dev, peers };
    }
    if (selected.kind === 'cable') {
      const cable = topo.edges.find(c => c.cable_id === selected.id);
      return cable ? { kind: 'cable', cable } : null;
    }
    const e = aggEdges.find(x => `${x.a}::${x.b}` === selected.id);
    return e ? { kind: 'edge', edge: e } : null;
  }, [topo, selected, aggEdges]);

  if (err) {
    if (embedded) {
      return (
        <>
          <div className={styles.error}>Topology is being prepared</div>
          <div className={styles.errorHint}>
            The 3D topology for this rack isn't ready yet. Try again in a few seconds, or rescan to regenerate it.
          </div>
        </>
      );
    }
    return (
      <div className={styles.page}>
        <PageHeader rackId={rackId} onBack={() => navigate(-1)} />
        <div className={styles.error}>Topology is being prepared</div>
        <div className={styles.errorHint}>
          The 3D topology for this rack isn't ready yet. Try again in a few seconds, or rescan to regenerate it.
        </div>
      </div>
    );
  }
  if (!topo) {
    if (embedded) return <div className={styles.loading}>Loading topology…</div>;
    return (
      <div className={styles.page}>
        <PageHeader rackId={rackId} onBack={() => navigate(-1)} />
        <div className={styles.loading}>Loading topology…</div>
      </div>
    );
  }

  const topoBody = (
    <>
      {!embedded && (
        <PageHeader
          rackId={rackId}
          onBack={() => navigate(-1)}
          stats={topo.stats}
          view={view}
          setView={(v) => { setView(v); setSelected(null); }}
          showCables={view === '2d'}
        />
      )}
      <RackBanner
        topo={topo}
        view={embedded ? view : null}
        setView={embedded ? ((v) => { setView(v); setSelected(null); }) : null}
      />

      <Toolbar
        cableFilter={cableFilter}
        setCableFilter={setCableFilter}
        cableCounts={cableCounts}
        heatmap={heatmap}
        setHeatmap={setHeatmap}
        traceMode={traceMode}
        toggleTrace={() => {
          setTraceMode(v => !v);
          setTraceA(null); setTraceB(null);
          setSelected(null);
        }}
      />
      {traceMode && (
        <TraceBanner
          traceA={traceA} traceB={traceB} tracePath={tracePath}
          clear={() => { setTraceA(null); setTraceB(null); }}
        />
      )}

      <div className={styles.graphWrap}>
        {view === '3d' ? (
          <Suspense fallback={<div className={styles.loading}>Initializing 3D scene…</div>}>
            <div className={styles.scene3dWrap}>
              <TopologyScene3D
                topo={filteredTopo}
                selected={selected}
                setSelected={handleSelect}
                aggEdges={aggEdges}
                heatmap={heatmap}
                freePctByDevice={freePctByDevice}
                traceMode={traceMode}
                traceA={traceA}
                traceB={traceB}
                tracePathSet={tracePathSet}
                traceEdgeKeys={traceEdgeKeys}
                onHoverDevice={setHoverInfo}
              />
              <SceneOverlay traceMode={traceMode} />
              {hoverInfo && <HoverInfoCard info={hoverInfo} />}
            </div>
          </Suspense>
        ) : (
          <Graph2D
            topo={filteredTopo}
            selected={selected}
            setSelected={handleSelect}
            aggEdges={aggEdges}
            heatmap={heatmap}
            freePctByDevice={freePctByDevice}
            traceMode={traceMode}
            traceA={traceA}
            traceB={traceB}
            tracePathSet={tracePathSet}
            traceEdgeKeys={traceEdgeKeys}
          />
        )}

        <BottomPanel
          info={selectionInfo}
          clear={() => setSelected(null)}
          topo={filteredTopo}
          aggEdges={aggEdges}
        />
      </div>
    </>
  );

  if (embedded) return topoBody;
  return <div className={styles.page}>{topoBody}</div>;
}

function RackBanner({ topo, view, setView }) {
  const switches = topo.devices.filter(d => d.in_rack && d.class === 'switch').length;
  const panels   = topo.devices.filter(d => d.in_rack && d.class === 'patch_panel').length;
  const servers  = topo.devices.filter(d => d.in_rack && d.class === 'server').length;
  const showToggle = !!(view && setView);
  return (
    <div className={styles.rackBanner}>
      <div className={styles.rackBannerHead}>
        <span className={styles.rackBadge}>RACK</span>
        <div className={styles.rackBannerCol}>
          <span className={styles.rackBannerName}>{topo.rackName}</span>
          <span className={styles.rackBannerId}>{topo.rackId}</span>
        </div>
        {showToggle && (
          <div className={styles.viewToggle} role="tablist" aria-label="Topology view">
            <button
              type="button"
              className={`${styles.viewBtn} ${view === '2d' ? styles.viewBtnActive : ''}`}
              onClick={() => setView('2d')}
              aria-pressed={view === '2d'}
            >2D</button>
            <button
              type="button"
              className={`${styles.viewBtn} ${view === '3d' ? styles.viewBtnActive : ''}`}
              onClick={() => setView('3d')}
              aria-pressed={view === '3d'}
            >3D</button>
          </div>
        )}
      </div>
      <div className={styles.rackBannerStats}>
        <Stat label="size"     value={`${topo.u_size}U`}        tone="size" />
        <Stat label="switches" value={switches}                  tone="switch" />
        <Stat label="panels"   value={panels}                    tone="panel" />
        <Stat label="servers"  value={servers}                   tone="server" />
        <Stat label="cables"   value={topo.stats.edge_count}     tone="cable" />
      </div>
    </div>
  );
}

function Stat({ label, value, tone }) {
  const toneClass = tone ? styles[`bannerStat_${tone}`] : '';
  return (
    <div className={`${styles.bannerStat} ${toneClass}`}>
      <span className={styles.bannerStatValue}>{value}</span>
      <span className={styles.bannerStatLabel}>{label}</span>
    </div>
  );
}

function PageHeader({ rackId, onBack, stats, view, setView, showCables = true }) {
  const subtitle = stats
    ? `${rackId} · ${stats.device_count_in_rack} devices${showCables ? ` · ${stats.edge_count} cables` : ''}`
    : rackId;
  return (
    <>
      <header className={styles.header}>
        <button className={styles.backBtn} onClick={onBack}>← Back</button>
        <div className={styles.headerCenter}>
          <h2>Rack Topology</h2>
          <span className={styles.headerMono}>{subtitle}</span>
        </div>
        {view ? (
          <div className={styles.viewToggle} role="tablist" aria-label="Topology view">
            <button
              type="button"
              className={`${styles.viewBtn} ${view === '2d' ? styles.viewBtnActive : ''}`}
              onClick={() => setView('2d')}
              aria-pressed={view === '2d'}
            >2D</button>
            <button
              type="button"
              className={`${styles.viewBtn} ${view === '3d' ? styles.viewBtnActive : ''}`}
              onClick={() => setView('3d')}
              aria-pressed={view === '3d'}
            >3D</button>
          </div>
        ) : (
          <div style={{ width: 64 }} />
        )}
      </header>
      <RackTabs rackId={rackId} />
    </>
  );
}

// ── Toolbar: cable-type filter pills + capacity-heatmap + trace ─────────────
function Toolbar({ cableFilter, setCableFilter, cableCounts, heatmap, setHeatmap,
                   traceMode, toggleTrace }) {
  return (
    <div className={styles.toolbar}>
      <div className={styles.filterPills}>
        <FilterPill active={cableFilter==='all'}   onClick={() => setCableFilter('all')}
                    label="All"   count={cableCounts.all} />
        <FilterPill active={cableFilter==='cat'}   onClick={() => setCableFilter('cat')}
                    label="Cat"   count={cableCounts.cat}   color="#6366f1" />
        <FilterPill active={cableFilter==='fiber'} onClick={() => setCableFilter('fiber')}
                    label="Fiber" count={cableCounts.fiber} color="#fbbf24" />
        <FilterPill active={cableFilter==='dac'}   onClick={() => setCableFilter('dac')}
                    label="DAC"   count={cableCounts.dac}   color="#a78bfa" />
      </div>
      <div className={styles.toolbarRight}>
        <button
          type="button"
          className={`${styles.heatmapBtn} ${heatmap ? styles.heatmapBtnActive : ''}`}
          onClick={() => setHeatmap(v => !v)}
          title="Color devices by free-port %"
        >
          {heatmap ? 'Capacity ON' : 'Capacity'}
        </button>
        <button
          type="button"
          className={`${styles.heatmapBtn} ${traceMode ? styles.traceBtnActive : ''}`}
          onClick={toggleTrace}
          title="Click two devices to trace the cable path between them"
        >
          {traceMode ? 'Trace ON' : 'Trace'}
        </button>
      </div>
    </div>
  );
}

// Trace banner — appears under the toolbar when trace mode is on. Shows
// which endpoints are picked + path summary + clear button.
function TraceBanner({ traceA, traceB, tracePath, clear }) {
  let body;
  if (!traceA) {
    body = <span className={styles.traceHint}>Click the <b>first</b> device.</span>;
  } else if (!traceB) {
    body = (
      <span className={styles.traceHint}>
        From <code>{traceA}</code> · click the <b>second</b> device.
      </span>
    );
  } else if (!tracePath || tracePath.length === 0) {
    body = (
      <span className={styles.traceHint} style={{ color: '#fda4af' }}>
        No cable path between <code>{traceA}</code> and <code>{traceB}</code>.
      </span>
    );
  } else {
    body = (
      <span className={styles.traceHint}>
        <code>{traceA}</code>
        <span className={styles.peerArrow}> → </span>
        <code>{traceB}</code>
        <span style={{ marginLeft: 8, color: '#67e8f9' }}>
          {tracePath.length - 1} hop{tracePath.length - 1 === 1 ? '' : 's'}
        </span>
        <span style={{ marginLeft: 6, color: 'rgba(255,255,255,0.55)' }}>
          ({tracePath.join(' → ')})
        </span>
      </span>
    );
  }
  return (
    <div className={styles.traceBanner}>
      {body}
      {(traceA || traceB) && (
        <button className={styles.clearBtn} onClick={clear}>clear</button>
      )}
    </div>
  );
}

function FilterPill({ active, onClick, label, count, color }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${styles.filterPill} ${active ? styles.filterPillActive : ''}`}
    >
      {color && <span className={styles.filterPillDot} style={{ background: color }} />}
      <span>{label}</span>
      <span className={styles.filterPillCount}>{count}</span>
    </button>
  );
}

// ── 3D scene chrome: a single orbit hint pinned to the bottom-right corner.
// (Tier legend is already in the bottom panel — no need to duplicate it here.)
// Pinned hover card in the top-left of the 3D scene — never overlaps devices.
function HoverInfoCard({ info }) {
  const ports     = info.dev.ports || [];
  const total     = ports.length;
  const connected = ports.filter(p => p.connected !== false).length;
  const free      = total - connected;
  const tierLabel = CLASS_LABEL[info.dev.class] || info.dev.class;
  return (
    <div className={styles.hoverCard} aria-hidden="true">
      <div className={styles.hoverCardName}>{info.dev.name}</div>
      <div className={styles.hoverCardSub}>
        {tierLabel}{info.dev.u_position ? ` · U${String(info.dev.u_position).padStart(2,'0')}` : ''}
        {info.dev.model ? ` · ${info.dev.model}` : ''}
      </div>
      {total > 0 && (
        <div className={styles.hoverCardPorts}>
          <span style={{ color: '#67e8f9' }}>{connected}/{total}</span> connected
          <span style={{ color: 'rgba(255,255,255,0.45)', marginLeft: 6 }}>· {free} free</span>
        </div>
      )}
    </div>
  );
}


function SceneOverlay({ traceMode }) {
  const hint = traceMode
    ? 'TRACE MODE · click two devices to find the cable path between them'
    : 'drag to orbit · scroll to zoom · zoom in to switch to hand-pan';
  return (
    <div className={styles.sceneOverlay} aria-hidden="true">
      <div className={styles.sceneHint}>{hint}</div>
    </div>
  );
}

// ── 2D graph (the original SVG view) ───────────────────────────────────────
function Graph2D({ topo, selected, setSelected, aggEdges, heatmap, freePctByDevice,
                   traceMode, traceA, traceB, tracePathSet, traceEdgeKeys }) {
  // Map devices into tiers; drop closed-units / unidentified (no cables, no value).
  const tiers = useMemo(() => {
    const t = { core: [], distribution: [], access: [], endpoint: [] };
    for (const d of topo.devices) {
      const tier = tierOf(d);
      if (!tier) continue;
      t[tier].push(d);
    }
    // Order by U-position descending within each tier so SW-U15 sits leftmost (matches rack top).
    for (const k of Object.keys(t)) {
      t[k].sort((a, b) => (b.u_position ?? -1) - (a.u_position ?? -1));
    }
    return t;
  }, [topo]);

  // Layout: each tier laid out across the canvas width.
  const W = 1100, H = 680;
  const TIER_Y = { core: 90, distribution: 240, access: 410, endpoint: 580 };

  const positions = useMemo(() => {
    const pos = new Map();
    for (const tier of TIER_ORDER) {
      const list = tiers[tier];
      if (!list.length) continue;
      const y = TIER_Y[tier];
      const gap = W / (list.length + 1);
      list.forEach((d, i) => {
        pos.set(d.name, { x: gap * (i + 1), y, tier });
      });
    }
    return pos;
  }, [tiers]);

  // Helper: stroke width grows (sub-linearly) with cable count.
  const strokeForCount = (n) => Math.max(1.6, Math.min(7, 1.4 + Math.log2(n + 1) * 1.4));

  // Compute selected highlight set.
  const highlightedDevices = new Set();
  const highlightedEdgeKeys = new Set();
  if (selected?.kind === 'node') {
    highlightedDevices.add(selected.id);
    for (const e of aggEdges) {
      if (e.a === selected.id || e.b === selected.id) {
        highlightedEdgeKeys.add(`${e.a}::${e.b}`);
        highlightedDevices.add(e.a);
        highlightedDevices.add(e.b);
      }
    }
  } else if (selected?.kind === 'edge') {
    const [a, b] = selected.id.split('::');
    highlightedEdgeKeys.add(selected.id);
    highlightedDevices.add(a);
    highlightedDevices.add(b);
  }

  // Trace mode overrides selection dimming when a path is active.
  const traceActive = traceMode && tracePathSet && tracePathSet.size > 0;
  const isDimmed = (deviceName) => {
    if (traceActive) return !tracePathSet.has(deviceName);
    return selected && !highlightedDevices.has(deviceName);
  };
  const isEdgeDimmed = (key) => {
    if (traceActive) return !traceEdgeKeys?.has(key);
    return selected && !highlightedEdgeKeys.has(key);
  };

  const deviceMap = useMemo(() => new Map(topo.devices.map(d => [d.name, d])), [topo]);

  return (
    <svg className={styles.graphSvg} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet"
         onClick={() => setSelected(null)}>
      <defs>
        <filter id="topoGlow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="3" />
          <feMerge>
            <feMergeNode />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <linearGradient id="rackBg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="rgba(99, 102, 241,0.04)" />
          <stop offset="100%" stopColor="rgba(168,85,247,0.04)" />
        </linearGradient>
      </defs>

      {/* Rack outline framing distribution + access + endpoint tiers */}
      <rect x={20} y={TIER_Y.distribution - 70} width={W - 40} height={TIER_Y.endpoint + 70 - (TIER_Y.distribution - 70)}
            rx={20} ry={20}
            fill="url(#rackBg)" stroke="rgba(255,255,255,0.08)" strokeWidth={1} strokeDasharray="6 6" />
      <text x={W - 40} y={TIER_Y.distribution - 50} textAnchor="end"
            fill="rgba(255,255,255,0.32)" fontSize="11"
            fontFamily="ui-monospace, Menlo, monospace" letterSpacing="0.1em">
        {topo.rackName} · {topo.u_size}U
      </text>

      {/* Tier guide labels */}
      {TIER_ORDER.map(tier => (
        tiers[tier].length > 0 && (
          <text key={tier}
                x={36} y={TIER_Y[tier]}
                fill={TIER_COLOR[tier]} fontSize="10"
                fontFamily="ui-monospace, Menlo, monospace"
                letterSpacing="0.12em" opacity="0.6">
            {TIER_LABEL[tier]}
          </text>
        )
      ))}

      {/* Edges (drawn first so they sit under nodes) */}
      <g>
        {aggEdges.map(e => {
          const pa = positions.get(e.a);
          const pb = positions.get(e.b);
          if (!pa || !pb) return null;
          const key = `${e.a}::${e.b}`;
          const dimmed = isEdgeDimmed(key);
          const highlighted = highlightedEdgeKeys.has(key);
          const mx = (pa.x + pb.x) / 2;
          const my = (pa.y + pb.y) / 2;
          const dx = pb.x - pa.x;
          const dy = pb.y - pa.y;
          const c1 = { x: pa.x + dx * 0.35, y: pa.y + dy * 0.55 };
          const c2 = { x: pb.x - dx * 0.35, y: pb.y - dy * 0.55 };
          const path = `M ${pa.x} ${pa.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${pb.x} ${pb.y}`;
          const sw = strokeForCount(e.count);
          const tierA = positions.get(e.a)?.tier;
          const tierB = positions.get(e.b)?.tier;
          const stroke = (tierA === 'core' || tierB === 'core')
            ? TIER_COLOR.core
            : ((tierA === 'endpoint' || tierB === 'endpoint') ? TIER_COLOR.endpoint : TIER_COLOR.access);
          return (
            <g key={key}
               onClick={(ev) => { ev.stopPropagation(); setSelected({ kind: 'edge', id: key }); }}
               style={{ cursor: 'pointer' }}>
              <path d={path} stroke="transparent" strokeWidth={Math.max(14, sw + 8)} fill="none" />
              <path d={path}
                    stroke={stroke}
                    strokeWidth={highlighted ? sw + 1.8 : sw}
                    strokeOpacity={dimmed ? 0.12 : (highlighted ? 0.95 : 0.55)}
                    fill="none"
                    filter={highlighted ? 'url(#topoGlow)' : undefined}
                    strokeLinecap="round" />
              {e.count >= 2 && (
                <g>
                  <rect x={mx - 16} y={my - 9} width="32" height="18" rx="9"
                        fill="rgba(2,8,28,0.85)"
                        stroke={stroke}
                        strokeOpacity={dimmed ? 0.2 : 0.65}
                        strokeWidth="1" />
                  <text x={mx} y={my + 4}
                        textAnchor="middle"
                        fontFamily="ui-monospace, Menlo, monospace"
                        fontSize="10"
                        fontWeight="700"
                        fill={dimmed ? 'rgba(255,255,255,0.4)' : '#fff'}>
                    {e.count}
                  </text>
                </g>
              )}
            </g>
          );
        })}
      </g>

      {/* Nodes (on top of edges) */}
      <g>
        {Array.from(positions.entries()).map(([name, p]) => {
          const dev = deviceMap.get(name);
          if (!dev) return null;
          const dimmed = isDimmed(name);
          const isSel = selected?.kind === 'node' && selected.id === name;
          const color = heatmap
            ? heatmapColor(freePctByDevice?.get(name))
            : TIER_COLOR[p.tier];
          const traceEndpoint = traceMode && (name === traceA || name === traceB);
          return (
            <NodeShape key={name}
                       dev={dev} pos={p} color={color}
                       dimmed={dimmed} selected={isSel || traceEndpoint}
                       onClick={(ev) => { ev.stopPropagation(); setSelected({ kind: 'node', id: name }); }} />
          );
        })}
      </g>
    </svg>
  );
}

function NodeShape({ dev, pos, color, dimmed, selected, onClick }) {
  const w = 132, h = 56;
  const x = pos.x - w / 2;
  const y = pos.y - h / 2;
  const opacity = dimmed ? 0.32 : 1;

  const glyph = dev.class === 'switch'      ? <SwitchGlyph color={color} /> :
                dev.class === 'patch_panel' ? <PatchGlyph color={color} /> :
                dev.class === 'server'      ? <ServerGlyph color={color} /> :
                null;

  return (
    <g transform={`translate(${x} ${y})`} onClick={onClick} style={{ cursor: 'pointer', opacity }}>
      <rect x="0" y="0" width={w} height={h} rx="10"
            fill="rgba(2,8,28,0.78)"
            stroke={color}
            strokeWidth={selected ? 2.2 : 1.2}
            filter={selected ? 'url(#topoGlow)' : undefined} />
      <g transform={`translate(10 ${(h - 28) / 2})`}>
        {glyph}
      </g>
      <text x="48" y="22" fontFamily="ui-monospace, Menlo, monospace"
            fontSize="12" fontWeight="700" fill="#e6edf6">
        {dev.name}
      </text>
      <text x="48" y="38" fontFamily="ui-monospace, Menlo, monospace"
            fontSize="9" fill="rgba(255,255,255,0.5)" letterSpacing="0.05em">
        {dev.u_position ? `U${String(dev.u_position).padStart(2, '0')} · ` : ''}
        {CLASS_LABEL[dev.class] || dev.class}
      </text>
      <text x={w - 8} y="14" textAnchor="end" fontSize="9"
            fill="rgba(255,255,255,0.4)" fontFamily="ui-monospace, Menlo, monospace">
        {dev.ports?.length ? `${dev.ports.length}p` : ''}
      </text>
    </g>
  );
}

function SwitchGlyph({ color }) {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
      <rect x="2" y="9" width="24" height="10" rx="2" stroke={color} strokeWidth="1.6" />
      <rect x="5" y="12" width="3" height="4" fill={color} />
      <rect x="10" y="12" width="3" height="4" fill={color} />
      <rect x="15" y="12" width="3" height="4" fill={color} />
      <rect x="20" y="12" width="3" height="4" fill={color} opacity="0.6" />
    </svg>
  );
}
function PatchGlyph({ color }) {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
      <rect x="2" y="8" width="24" height="12" rx="1.5" stroke={color} strokeWidth="1.6" />
      <line x1="5" y1="14" x2="23" y2="14" stroke={color} strokeWidth="0.8" />
      {[5,9,13,17,21].map(cx => (
        <circle key={cx} cx={cx} cy="14" r="1.2" fill={color} />
      ))}
    </svg>
  );
}
function ServerGlyph({ color }) {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
      <rect x="3" y="4"  width="22" height="6" rx="1.5" stroke={color} strokeWidth="1.6" />
      <rect x="3" y="11" width="22" height="6" rx="1.5" stroke={color} strokeWidth="1.6" />
      <rect x="3" y="18" width="22" height="6" rx="1.5" stroke={color} strokeWidth="1.6" />
      <circle cx="6" cy="7"  r="1" fill={color} />
      <circle cx="6" cy="14" r="1" fill={color} />
      <circle cx="6" cy="21" r="1" fill={color} />
    </svg>
  );
}

function BottomPanel({ info, clear, topo, aggEdges }) {
  if (!info) {
    return (
      <div className={styles.bottomBar}>
        <div className={styles.legend}>
          <Legend color={TIER_COLOR.core}         label="core / uplink" />
          <Legend color={TIER_COLOR.distribution} label="switches" />
          <Legend color={TIER_COLOR.access}       label="patch panels" />
          <Legend color={TIER_COLOR.endpoint}     label="end hosts" />
        </div>
        <div className={styles.bottomHint}>
          Click any node or edge to inspect. {topo.stats.edge_count} cables aggregated into {aggEdges.length} links.
        </div>
      </div>
    );
  }

  if (info.kind === 'node') {
    const { dev, peers } = info;
    return (
      <div className={styles.bottomBar}>
        <div className={styles.detailRow}>
          <div className={styles.detailMain}>
            <span className={styles.detailName}>{dev.name}</span>
            <span className={styles.detailSub}>
              {CLASS_LABEL[dev.class] || dev.class}
              {dev.u_position ? ` · U${String(dev.u_position).padStart(2,'0')}` : ''}
              {dev.model ? ` · ${dev.model}` : ''}
              {dev.mgmt_ip ? ` · ${dev.mgmt_ip}` : ''}
            </span>
          </div>
          <button className={styles.clearBtn} onClick={clear}>clear</button>
        </div>
        <div className={styles.peerStrip}>
          {peers.length === 0 && <span className={styles.bottomHint}>No connected peers.</span>}
          {peers.map(p => (
            <span key={p.peer} className={styles.peerChip}>
              <code>{p.peer}</code>
              <span className={styles.peerCount}>{p.count}×</span>
            </span>
          ))}
        </div>
        <PortsTable dev={dev} topo={topo} />
      </div>
    );
  }

  // Single cable selected — drilled in from the 3D scene's tube click.
  if (info.kind === 'cable') {
    const c = info.cable;
    return (
      <div className={styles.bottomBar}>
        <div className={styles.detailRow}>
          <div className={styles.detailMain}>
            <span className={styles.detailName}>
              <span className={styles.cableId}>{c.cable_id}</span>
            </span>
            <span className={styles.detailSub}>
              {c.cable_type}
              {c.length ? ` · ${c.length}` : ''}
              {c.color ? ` · ${c.color}` : ''}
            </span>
          </div>
          <button className={styles.clearBtn} onClick={clear}>clear</button>
        </div>
        <div className={styles.cableMini} style={{ marginTop: 10 }}>
          <code>{c.src.device}:{c.src.port}</code>
          <span className={styles.peerArrow}>↔</span>
          <code>{c.dst.device}:{c.dst.port}</code>
          <span className={styles.cableMeta}>
            {c.is_uplink ? 'uplink' : (c.kind || 'patch')}
          </span>
        </div>
      </div>
    );
  }

  // Edge selected
  const { edge } = info;
  return (
    <div className={styles.bottomBar}>
      <div className={styles.detailRow}>
        <div className={styles.detailMain}>
          <span className={styles.detailName}>
            <code>{edge.a}</code>
            <span className={styles.peerArrow}>↔</span>
            <code>{edge.b}</code>
          </span>
          <span className={styles.detailSub}>{edge.count} cable{edge.count > 1 ? 's' : ''}</span>
        </div>
        <button className={styles.clearBtn} onClick={clear}>clear</button>
      </div>
      <div className={styles.cableScroll}>
        {edge.cables.slice(0, 50).map(c => (
          <div key={`${c.cable_id}-${c.src.port}-${c.dst.port}`} className={styles.cableMini}>
            <span className={styles.cableId}>{c.cable_id}</span>
            <code>{c.src.port}</code>
            <span className={styles.peerArrow}>↔</span>
            <code>{c.dst.port}</code>
            <span className={styles.cableMeta}>{c.cable_type} · {c.length}</span>
          </div>
        ))}
        {edge.cables.length > 50 && (
          <div className={styles.bottomHint}>+ {edge.cables.length - 50} more cables…</div>
        )}
      </div>
    </div>
  );
}

function PortsTable({ dev, topo }) {
  const byPort = useMemo(() => {
    const m = new Map();
    for (const e of topo.edges) {
      for (const side of ['src', 'dst']) {
        const k = e[side].port;
        if (!m.has(k)) m.set(k, []);
        m.get(k).push({ self: e[side], peer: side === 'src' ? e.dst : e.src, edge: e });
      }
    }
    return m;
  }, [topo]);

  const rows = useMemo(() => {
    return (dev.ports || []).map(p => {
      const links = byPort.get(p.name) || [];
      const primary = links[0];
      const connector = primary ? guessConnector(p, primary.edge) : null;
      return { port: p, links, primary, connector };
    });
  }, [dev, byPort]);

  if (!rows.length) {
    return <div className={styles.bottomHint} style={{ marginTop: 12 }}>No ports on this device.</div>;
  }

  const connected = rows.filter(r => r.links.length > 0).length;
  const free = rows.length - connected;

  return (
    <div className={styles.portsTableWrap}>
      <div className={styles.portsTableHead}>
        <span className={styles.detailSub}>Ports</span>
        <span className={styles.bottomHint}>
          {rows.length} total · <span style={{color:'#67e8f9'}}>{connected} connected</span> · <span style={{color:'rgba(255,255,255,0.5)'}}>{free} free</span>
        </span>
      </div>
      <div className={styles.portsTableScroll}>
        <table className={styles.portsTable}>
          <thead>
            <tr>
              <th>Port</th>
              <th>Status</th>
              <th>Cable</th>
              <th>Connector</th>
              <th>Type · Length</th>
              <th>Other end</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ port, links, primary, connector }) => {
              const isConnected = links.length > 0;
              const extras = links.length - 1;
              return (
                <tr key={port.name} className={isConnected ? styles.rowConnected : styles.rowFree}>
                  <td>
                    <code className={styles.tdPort}>{port.label}</code>
                    {port.kind === 'sfp'    && <span className={styles.tag}>SFP</span>}
                    {port.kind === 'nic'    && <span className={styles.tag}>NIC</span>}
                    {port.is_uplink         && <span className={styles.tagUplink}>uplink</span>}
                  </td>
                  <td>
                    {isConnected
                      ? <span className={styles.statusDotConnected}>●</span>
                      : <span className={styles.statusDotFree}>○</span>}
                    {isConnected ? 'connected' : 'free'}
                  </td>
                  <td>
                    {primary
                      ? <code className={styles.cableId}>{primary.edge.cable_id}</code>
                      : <span className={styles.tdDim}>—</span>}
                  </td>
                  <td>{connector || <span className={styles.tdDim}>—</span>}</td>
                  <td>
                    {primary
                      ? <span className={styles.tdMono}>{primary.edge.cable_type} · {primary.edge.length}</span>
                      : <span className={styles.tdDim}>—</span>}
                  </td>
                  <td>
                    {primary ? (
                      <div className={styles.tdPeer}>
                        <code>{primary.peer.port}</code>
                        <span className={styles.tdDim}>{primary.peer.device}</span>
                        {extras > 0 && <span className={styles.peerCount}>+{extras}</span>}
                      </div>
                    ) : <span className={styles.tdDim}>—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function guessConnector(port, edge) {
  const t = (edge.cable_type || '').toLowerCase();
  if (port.kind === 'sfp') return 'LC';
  if (t.startsWith('cat') || t.includes('utp')) return 'RJ45';
  if (t.includes('fiber') || t.includes('mm') || t.includes('sm')) return 'LC';
  if (t.includes('dac') || t.includes('twinax')) return 'SFP+';
  return 'RJ45';
}

function Legend({ color, label }) {
  return (
    <span className={styles.legendItem}>
      <span className={styles.legendDot} style={{ background: color, boxShadow: `0 0 6px ${color}` }} />
      {label}
    </span>
  );
}

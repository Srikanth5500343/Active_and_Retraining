import { useEffect, useMemo, useState, lazy, Suspense } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiUrl } from '../utils/api';
import styles from './TenantMatPage.module.css';

// Lazy-load the real 3D scene used by /results/:rackId/topology and
// /multi-rack/.../topology — keeps three.js out of the initial bundle.
const TopologyScene3D = lazy(() => import('./TopologyScene3D.jsx'));

/**
 * Tenant rack-layout view — modelled on Arista CloudVision's
 * Network Provisioning page: left tree-explorer, canvas with view-mode
 * toggle (Map | Tree | Table | 3D), right detail panel.
 *
 * Single page, fetched once from /api/demo/tenant-mat. Tree selection
 * narrows what every view shows (pick a Floor → views show that floor's
 * racks only). All four views read from the same in-memory data.
 */

const STATUS_META = {
  ok:         { label: 'OK',         color: '#10b981' },
  drift:      { label: 'Drift',      color: '#f59e0b' },
  cmdb_only:  { label: 'Unscanned',  color: '#94a3b8' },
  scan_only:  { label: 'Orphan',     color: '#ef4444' },
};

const VIEW_MODES = [
  { id: 'map',   label: 'Floor map',  desc: 'Racks placed on a floor plan, the way they physically sit',  icon: IcMap },
  { id: 'tree',  label: 'Hierarchy',  desc: 'Same racks shown as a family tree (Company → Site → Rack)', icon: IcTree },
  { id: 'table', label: 'List',       desc: 'Same racks as a sortable spreadsheet — click a column to sort', icon: IcTable },
  { id: 'rack',  label: '3D rack',    desc: 'Pick a rack from the tree — see it in 3D',                     icon: IcRack },
];

export default function TenantMatPage() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [source, setSource] = useState(() => {
    try { return new URLSearchParams(window.location.search).get('source') || 'json'; }
    catch { return 'json'; }
  });
  const [mode, setMode] = useState('map');
  const [selectedNode, setSelectedNode] = useState(null);   // {type, id, path}
  const [selectedRack, setSelectedRack] = useState(null);
  const [treeOpen, setTreeOpen] = useState(true);

  // CMDB-ready banner state: when user picks CMDB and it isn't populated
  // yet, instead of hard-erroring we silently fall back to Local and show a
  // dismissible banner explaining why.
  const [cmdbPending, setCmdbPending] = useState(false);

  useEffect(() => {
    setData(null); setErr(null);
    setSelectedNode(null); setSelectedRack(null);
    setCmdbPending(false);
    fetch(apiUrl(`/api/demo/tenant-mat?source=${source}`))
      .then(async r => {
        const j = await r.json();
        if (j.error && source === 'cmdb') {
          // Auto-fall-back to Local so the user is never on a blank error page.
          setCmdbPending(true);
          const r2 = await fetch(apiUrl('/api/demo/tenant-mat?source=json'));
          return r2.json();
        }
        return j;
      })
      .then(j => { if (j.error) setErr(`${j.error}${j.hint ? ' — ' + j.hint : ''}`); else setData(j); })
      .catch(e => setErr(String(e)));
  }, [source]);

  // Compose tree from data (memo-friendly).
  const tree = useMemo(() => data ? buildTree(data) : null, [data]);

  // Filter racks by selectedNode scope.
  const visibleRacks = useMemo(() => {
    if (!data) return [];
    return filterRacks(data.racks, selectedNode);
  }, [data, selectedNode]);

  if (err) return <ErrorView err={err} onBack={() => navigate(-1)} />;
  if (!data) return <LoadingView />;

  return (
    <div className={styles.page}>
      {cmdbPending && (
        <div className={styles.banner}>
          <span>⏳</span>
          <span>CMDB not populated yet — showing Local data. The bootstrap script is still running; try CMDB again in a few minutes.</span>
          <button className={styles.bannerClose} onClick={() => setCmdbPending(false)}>×</button>
        </div>
      )}
      <header className={styles.header}>
        <button className={styles.back} onClick={() => navigate(-1)}>‹</button>
        <button
          className={styles.treeToggleBtn}
          onClick={() => setTreeOpen(o => !o)}
          title={treeOpen ? 'Hide tree' : 'Show tree'}
        ><IcSidebar /></button>
        <h2>
          {data.tenant.name}
          {selectedNode && selectedNode.type !== 'tenant' && (
            <span className={styles.crumb}> / {selectedNode.label}</span>
          )}
        </h2>
        <SourceToggle source={source} onChange={setSource} />
        <SummaryPill summary={data.summary} />
      </header>

      <div className={styles.body}>
        {treeOpen && (
          <TreeExplorer
            tree={tree}
            selectedId={selectedNode?.id || 'tenant'}
            onSelect={(node) => {
              setSelectedNode(node);
              if (node?.type === 'rack') {
                setSelectedRack(node.id);
                setMode('rack');
              }
            }}
          />
        )}

        <div className={styles.canvasWrap}>
          <ViewModeBar mode={mode} onChange={setMode} />
          <div className={styles.canvas}>
            {mode === 'map'   && <MapView   data={data} racks={visibleRacks} selectedNode={selectedNode} onPickRack={setSelectedRack} />}
            {mode === 'tree'  && <TreeView  tree={tree} selectedId={selectedNode?.id || 'tenant'} onSelect={setSelectedNode} />}
            {mode === 'table' && <TableView racks={visibleRacks} onPickRack={setSelectedRack} />}
            {mode === 'rack'  && <Rack3DView rack={data.racks.find(r => r.id === selectedRack) || visibleRacks[0]} />}
          </div>
        </div>

        {selectedRack && (
          <DetailPanel
            rackId={selectedRack}
            source={source}
            data={data}
            onClose={() => setSelectedRack(null)}
          />
        )}
      </div>

      <Legend />
    </div>
  );
}

/* ─── Tree explorer ─────────────────────────────────────────────────── */

function TreeExplorer({ tree, selectedId, onSelect }) {
  const [expanded, setExpanded] = useState(() => new Set(['tenant']));
  const toggle = (id) => {
    setExpanded(s => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  };
  return (
    <aside className={styles.tree}>
      <div className={styles.treeHead}>Containers</div>
      <div className={styles.treeBody}>
        {tree && <TreeNode node={tree} depth={0}
          expanded={expanded} toggle={toggle}
          selectedId={selectedId} onSelect={onSelect} />}
      </div>
    </aside>
  );
}

function TreeNode({ node, depth, expanded, toggle, selectedId, onSelect }) {
  const hasChildren = node.children && node.children.length > 0;
  const isOpen = expanded.has(node.id);
  const isSelected = node.id === selectedId;
  return (
    <div>
      <div
        className={`${styles.treeRow} ${isSelected ? styles.treeRowSel : ''}`}
        style={{ paddingLeft: 6 + depth * 14 }}
        onClick={() => onSelect(node)}
      >
        {hasChildren ? (
          <button className={styles.treeCaret} onClick={(e) => { e.stopPropagation(); toggle(node.id); }}>
            {isOpen ? '▾' : '▸'}
          </button>
        ) : (
          <span className={styles.treeCaretBlank} />
        )}
        <span className={styles.treeIcon} data-type={node.type}>{TYPE_ICON[node.type] || '•'}</span>
        <span className={styles.treeLabel}>{node.label}</span>
        {typeof node.count === 'number' && (
          <span className={styles.treeCount}>({node.count})</span>
        )}
      </div>
      {hasChildren && isOpen && (
        <div>
          {node.children.map(c => (
            <TreeNode key={c.id} node={c} depth={depth + 1}
              expanded={expanded} toggle={toggle}
              selectedId={selectedId} onSelect={onSelect} />
          ))}
        </div>
      )}
    </div>
  );
}

const TYPE_ICON = {
  tenant:   '◉',
  building: '▤',
  floor:    '▦',
  row:      '═',
  rack:     '▥',
};

/* ─── View mode bar ─────────────────────────────────────────────────── */

function ViewModeBar({ mode, onChange }) {
  const active = VIEW_MODES.find(m => m.id === mode);
  return (
    <div className={styles.modeBarWrap}>
      <div className={styles.modeBar}>
        {VIEW_MODES.map(m => (
          <button
            key={m.id}
            className={`${styles.modeBtn} ${mode === m.id ? styles.modeBtnActive : ''}`}
            onClick={() => onChange(m.id)}
          >
            <m.icon />
            <span>{m.label}</span>
          </button>
        ))}
      </div>
      {active && <div className={styles.modeBarHelp}>{active.desc}</div>}
    </div>
  );
}

/* ─── Map view (floor-plan, multi-floor stack) ──────────────────────── */

function MapView({ data, racks, selectedNode, onPickRack }) {
  // If a single floor is selected, render only that floor; otherwise stack
  // every floor with rack content for the visible set.
  const allFloors = [];
  for (const b of data.buildings) {
    for (const f of b.floors) {
      const fracks = racks.filter(r => r.floor_id === f.id);
      if (fracks.length > 0) {
        allFloors.push({ building: b, floor: f, racks: fracks });
      }
    }
  }
  if (allFloors.length === 0) {
    return <div className={styles.empty}>No racks match the current selection.</div>;
  }
  return (
    <div className={styles.mapStack}>
      {allFloors.map(({ building, floor, racks }) => (
        <FloorPlan key={floor.id} building={building} floor={floor} racks={racks} onPickRack={onPickRack} />
      ))}
    </div>
  );
}

function FloorPlan({ building, floor, racks, onPickRack }) {
  const RACK_W = 0.6, RACK_D = 1.0, PAD = 1;
  return (
    <div className={styles.floorBlock}>
      <div className={styles.floorBlockHead}>
        <strong>{building.name}</strong>
        <span>·</span>
        <span>{floor.label}</span>
        <span className={styles.floorBlockMeta}>{racks.length} racks</span>
      </div>
      <svg
        className={styles.mat}
        viewBox={`${-PAD} ${-PAD} ${floor.width_m + PAD * 2} ${floor.height_m + PAD * 2}`}
        preserveAspectRatio="xMidYMid meet"
      >
        <rect x="0" y="0" width={floor.width_m} height={floor.height_m} className={styles.floorRect} />
        {Array.from({ length: Math.floor(floor.width_m) + 1 }).map((_, i) => (
          <line key={`vx${i}`} x1={i} y1="0" x2={i} y2={floor.height_m} className={styles.gridLine} />
        ))}
        {Array.from({ length: Math.floor(floor.height_m) + 1 }).map((_, i) => (
          <line key={`hy${i}`} x1="0" y1={i} x2={floor.width_m} y2={i} className={styles.gridLine} />
        ))}
        {floor.rows.map(row => (
          <text key={row.id} x="0.2" y={row.y_m + 0.2} className={styles.rowLabel}>{row.label}</text>
        ))}
        {racks.map(r => (
          <g key={r.id}
            transform={`translate(${r.x_m - RACK_W / 2} ${r.y_m - RACK_D / 2}) rotate(${r.rotation_deg} ${RACK_W / 2} ${RACK_D / 2})`}
            className={styles.rackG}
            onClick={() => onPickRack(r.id)}
          >
            <rect width={RACK_W} height={RACK_D}
              fill={STATUS_META[r.status]?.color || '#888'}
              fillOpacity={r.scanned ? 0.85 : 0.15}
              stroke={STATUS_META[r.status]?.color || '#888'}
              strokeWidth="0.05"
              strokeDasharray={r.scanned ? 'none' : '0.12 0.08'}
              rx="0.05"
            />
            <text x={RACK_W / 2} y={RACK_D / 2 + 0.08} className={styles.rackLbl} textAnchor="middle">{r.name}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}

/* ─── Tree-graph view (Arista-style hierarchical layout) ────────────── */

function TreeView({ tree, selectedId, onSelect }) {
  // Recursive layout: each level is a row, children spread under parents.
  // Uses a tidy-tree layout: compute x-position per leaf, parents centered
  // over their child range. Output a flat list of nodes with (x, y) and a
  // list of edges (parentId, childId).
  const { nodes, edges, width, height } = useMemo(() => layoutTree(tree), [tree]);
  const LEVEL_H = 90;
  const NODE_W = 130;

  if (!tree) return null;
  return (
    <div className={styles.treeView}>
      <svg
        viewBox={`-40 -30 ${width + 80} ${height + 60}`}
        preserveAspectRatio="xMidYMid meet"
        className={styles.treeSvg}
      >
        {edges.map((e, i) => {
          const p = nodes[e.parent], c = nodes[e.child];
          const midY = (p.y + c.y) / 2;
          return (
            <path key={i}
              d={`M ${p.x} ${p.y + 14} C ${p.x} ${midY}, ${c.x} ${midY}, ${c.x} ${c.y - 14}`}
              className={styles.treeEdge} />
          );
        })}
        {Object.values(nodes).map(n => {
          const isSel = n.id === selectedId;
          const status = n.data?.status;
          const dotColor = status ? STATUS_META[status]?.color : null;
          return (
            <g key={n.id}
              transform={`translate(${n.x} ${n.y})`}
              className={styles.treeNodeG}
              onClick={() => onSelect(n.data)}
            >
              <rect x={-NODE_W / 2} y={-14} width={NODE_W} height={28}
                rx="6"
                className={`${styles.treeNodeRect} ${isSel ? styles.treeNodeSel : ''}`} />
              {dotColor && (
                <circle cx={-NODE_W / 2 + 10} cy={0} r="3.5" fill={dotColor} />
              )}
              <text className={styles.treeNodeText} textAnchor="middle" y="4">
                {n.label.length > 16 ? n.label.slice(0, 15) + '…' : n.label}
              </text>
              {typeof n.count === 'number' && (
                <text className={styles.treeNodeCount} textAnchor="middle" y="22">
                  ({n.count})
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/* ─── Table view ────────────────────────────────────────────────────── */

function TableView({ racks, onPickRack }) {
  const [sort, setSort] = useState({ key: 'name', dir: 'asc' });
  const sorted = useMemo(() => {
    const arr = [...racks];
    arr.sort((a, b) => {
      const av = a[sort.key], bv = b[sort.key];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (av < bv) return sort.dir === 'asc' ? -1 : 1;
      if (av > bv) return sort.dir === 'asc' ? 1 : -1;
      return 0;
    });
    return arr;
  }, [racks, sort]);
  const click = (key) => setSort(s => ({ key, dir: s.key === key && s.dir === 'asc' ? 'desc' : 'asc' }));
  const ind = (k) => sort.key === k ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th onClick={() => click('name')}>Rack{ind('name')}</th>
            <th onClick={() => click('building_id')}>Building{ind('building_id')}</th>
            <th onClick={() => click('floor_id')}>Floor{ind('floor_id')}</th>
            <th onClick={() => click('row_id')}>Row{ind('row_id')}</th>
            <th onClick={() => click('position')}>Pos{ind('position')}</th>
            <th onClick={() => click('status')}>Status{ind('status')}</th>
            <th onClick={() => click('device_count')}>Devices{ind('device_count')}</th>
            <th onClick={() => click('power_kw')}>Power{ind('power_kw')}</th>
            <th onClick={() => click('last_seen')}>Last seen{ind('last_seen')}</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map(r => (
            <tr key={r.id} onClick={() => onPickRack(r.id)}>
              <td><b>{r.name}</b></td>
              <td>{r.building_id}</td>
              <td>{r.floor_id}</td>
              <td>{r.row_id}</td>
              <td>{r.position}</td>
              <td>
                <span className={styles.tableStatus} style={{ background: STATUS_META[r.status]?.color }} />
                {STATUS_META[r.status]?.label}
              </td>
              <td>{r.device_count}</td>
              <td>{r.power_kw != null ? `${r.power_kw} kW` : '—'}</td>
              <td>{r.last_seen ? new Date(r.last_seen).toLocaleDateString() : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {sorted.length === 0 && <div className={styles.empty}>No racks.</div>}
    </div>
  );
}

/* ─── Rack 3D view ─────────────────────────────────────────────────────
   Reuses TopologyScene3D — the same component that renders the
   per-rack 3D view at /results/:rackId/topology — so the demo
   3D matches the rest of the app pixel-for-pixel. We synthesize a
   topo JSON from the rack metadata since demo racks don't have a
   real scan-derived topology.json on disk.
   ──────────────────────────────────────────────────────────────────── */

function Rack3DView({ rack }) {
  if (!rack) {
    return <div className={styles.empty}>Pick a rack from the tree to see it in 3D.</div>;
  }
  const topo = useMemo(() => synthTopology(rack), [rack.id]);
  return (
    <div className={styles.r3dWrap}>
      <Suspense fallback={<div className={styles.empty}>Loading 3D scene…</div>}>
        <TopologyScene3D topo={topo} />
      </Suspense>
      <div className={styles.r3dCaption}>
        <span className={styles.r3dCaptionLabel}>{rack.name}</span>
        <span className={styles.r3dCaptionMeta}>{rack.device_count} devices · {rack.u_size}U · {rack.model}</span>
      </div>
    </div>
  );
}

/** Build a TopologyScene3D-shaped topo from rack metadata, deterministically
 *  so the same rack always renders the same layout. */
function synthTopology(rack) {
  const seed = rack.id || rack.name;
  let h = 0; for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  const rng = () => { h = (h * 1664525 + 1013904223) | 0; return ((h >>> 0) % 1000) / 1000; };

  const uSize = rack.u_size || 42;
  const deviceTarget = Math.max(4, Math.min(rack.device_count || 12, 18));
  const devices = [];
  let u = uSize - 1;  // top-down, leaving U=uSize for cable mgr

  // 2 ToR switches at the top
  for (let s = 0; s < 2 && u > 4; s++) {
    const name = `SW-U${String(u).padStart(2, '0')}`;
    const portCount = 48;
    const ports = [];
    for (let p = 1; p <= portCount; p++) {
      ports.push({
        name: `${name}:Gi1/0/${p}`,
        label: `Gi1/0/${p}`,
        kind: 'main',
        is_uplink: p > portCount - 4,
        connected: rng() < 0.55,
      });
    }
    devices.push({
      name, class: 'switch',
      u_position: u, u_size: 1,
      model: 'Catalyst 9300-48P',
      mgmt_ip: `10.10.${10 + (h & 0xff)}.${u}`,
      in_rack: true, synthetic: true,
      ports,
    });
    u -= 1;
  }
  // Blank U
  u -= 1;
  // Mid: servers
  let placed = 2;
  while (placed < deviceTarget && u > 2) {
    const tall = rng() < 0.25;
    const size = tall ? 2 : 1;
    if (u - size < 1) break;
    const name = `SRV-U${String(u).padStart(2, '0')}`;
    devices.push({
      name, class: 'server',
      u_position: u, u_size: size,
      model: rng() < 0.5 ? 'Dell PowerEdge R750' : 'HPE ProLiant DL380 Gen10',
      mgmt_ip: `10.10.${10 + (h & 0xff)}.${u + 100}`,
      in_rack: true, synthetic: true,
      ports: [],
    });
    u -= size + (rng() < 0.3 ? 1 : 0);   // sometimes leave a gap
    placed += 1;
  }
  // Bottom: PDU
  if (u > 1) {
    devices.push({
      name: 'PDU-U01', class: 'pdu',
      u_position: 1, u_size: 1,
      model: 'APC AP8941', in_rack: true, synthetic: true, ports: [],
    });
  }

  return {
    schema: 'topology.v1',
    rackId: rack.id,
    rackName: rack.name,
    u_size: uSize,
    generated_at: new Date().toISOString(),
    image: { imageHash: null, originalImagePath: null, qualityWarning: null, qualityWarningMsg: null },
    devices,
  };
}

/* ─── Right detail panel (unchanged from prior version) ─────────────── */

function DetailPanel({ rackId, source, data, onClose }) {
  const [d, setD] = useState(null);
  useEffect(() => {
    if (source === 'cmdb') {
      const rack = data?.racks?.find(r => r.id === rackId);
      if (!rack) { setD({ error: 'Rack not found in loaded data' }); return; }
      const building = data.buildings.find(b => b.id === rack.building_id);
      const floor = building?.floors.find(f => f.id === rack.floor_id);
      const row = floor?.rows.find(r => r.id === rack.row_id);
      setD({
        rack,
        location: {
          building: building && { id: building.id, name: building.name, city: building.city },
          floor: floor && { id: floor.id, label: floor.label },
          row: row && { id: row.id, label: row.label },
        },
      });
      return;
    }
    setD(null);
    fetch(apiUrl(`/api/demo/tenant-mat/rack/${rackId}`))
      .then(r => r.json()).then(setD).catch(e => setD({ error: String(e) }));
  }, [rackId, source, data]);
  if (!d) return null;
  if (d.error) return (
    <aside className={styles.panel}>
      <button className={styles.panelClose} onClick={onClose}>×</button>
      <div className={styles.empty}>{d.error}</div>
    </aside>
  );
  const { rack, location } = d;
  return (
    <aside className={styles.panel}>
      <button className={styles.panelClose} onClick={onClose}>×</button>
      <div className={styles.panelHead}>
        <div className={styles.panelDot} style={{ background: STATUS_META[rack.status]?.color }} />
        <div>
          <div className={styles.panelTitle}>{rack.name}</div>
          <div className={styles.panelSub}>{rack.id}</div>
        </div>
      </div>
      <div className={styles.kv}><span>Status</span><b>{STATUS_META[rack.status]?.label}</b></div>
      <div className={styles.kv}><span>Location</span><b>{location?.building?.name} / {location?.floor?.label} / {location?.row?.label} · pos {rack.position}</b></div>
      <div className={styles.kv}><span>Model</span><b>{rack.model}</b></div>
      <div className={styles.kv}><span>Serial</span><b>{rack.serial}</b></div>
      <div className={styles.kv}><span>U size</span><b>{rack.u_size}U</b></div>
      <div className={styles.kv}><span>Devices</span><b>{rack.device_count}</b></div>
      <div className={styles.kv}><span>Power</span><b>{rack.power_kw != null ? `${rack.power_kw} kW` : '—'}</b></div>
      <div className={styles.kv}><span>Last seen</span><b>{rack.last_seen ? new Date(rack.last_seen).toLocaleString() : 'Never'}</b></div>
      {rack.drift_notes?.length > 0 && (
        <div className={styles.notes}>
          <div className={styles.notesTitle}>Notes</div>
          <ul>{rack.drift_notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
        </div>
      )}
    </aside>
  );
}

/* ─── Shared bits ───────────────────────────────────────────────────── */

function SourceToggle({ source, onChange }) {
  return (
    <div className={styles.srcToggle}>
      <button className={`${styles.srcBtn} ${source === 'json' ? styles.srcBtnActive : ''}`}
              onClick={() => onChange('json')}>Local</button>
      <button className={`${styles.srcBtn} ${source === 'cmdb' ? styles.srcBtnActive : ''}`}
              onClick={() => onChange('cmdb')}>CMDB</button>
    </div>
  );
}

function SummaryPill({ summary }) {
  return (
    <div className={styles.summary}>
      <span className={styles.sm}><b>{summary.total}</b> racks</span>
      <span className={`${styles.sm} ${styles.smOk}`}><b>{summary.ok}</b> ok</span>
      <span className={`${styles.sm} ${styles.smWarn}`}><b>{summary.drift}</b> drift</span>
      <span className={`${styles.sm} ${styles.smMute}`}><b>{summary.cmdb_only}</b> unscanned</span>
      <span className={`${styles.sm} ${styles.smErr}`}><b>{summary.scan_only}</b> orphan</span>
    </div>
  );
}

function Legend() {
  return (
    <div className={styles.legend}>
      {Object.entries(STATUS_META).map(([k, m]) => (
        <span key={k} className={styles.legendItem}>
          <span className={styles.legendDot} style={{ background: m.color }} />
          {m.label}
        </span>
      ))}
    </div>
  );
}

function ErrorView({ err, onBack }) {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <button className={styles.back} onClick={onBack}>‹</button>
        <h2>Tenant topology</h2>
      </header>
      <div className={styles.empty}>Failed to load demo data: {err}</div>
    </div>
  );
}

function LoadingView() {
  return <div className={styles.page}><div className={styles.empty}>Loading tenant…</div></div>;
}

/* ─── SVG icons (no external deps) ──────────────────────────────────── */

function IcMap()    { return <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="2" width="5" height="5" rx="0.6"/><rect x="9" y="2" width="5" height="5" rx="0.6"/><rect x="2" y="9" width="5" height="5" rx="0.6"/><rect x="9" y="9" width="5" height="5" rx="0.6"/></svg>; }
function IcTree()   { return <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8" cy="3" r="1.6"/><circle cx="3.5" cy="13" r="1.6"/><circle cx="8" cy="13" r="1.6"/><circle cx="12.5" cy="13" r="1.6"/><line x1="8" y1="4.6" x2="3.5" y2="11.4"/><line x1="8" y1="4.6" x2="8" y2="11.4"/><line x1="8" y1="4.6" x2="12.5" y2="11.4"/></svg>; }
function IcTable()  { return <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="3" width="12" height="10" rx="0.6"/><line x1="2" y1="6.5" x2="14" y2="6.5"/><line x1="2" y1="10" x2="14" y2="10"/><line x1="8" y1="3" x2="8" y2="13"/></svg>; }
function IcRack()   { return <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3.5" y="2" width="9" height="12" rx="0.6"/><line x1="3.5" y1="5" x2="12.5" y2="5"/><line x1="3.5" y1="8" x2="12.5" y2="8"/><line x1="3.5" y1="11" x2="12.5" y2="11"/></svg>; }
function IcSidebar(){ return <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="2" width="12" height="12" rx="1"/><line x1="6" y1="2" x2="6" y2="14"/></svg>; }

/* ─── Helpers ───────────────────────────────────────────────────────── */

function buildTree(data) {
  // Tenant → Building → Floor → Row → Rack
  const root = {
    id: 'tenant', type: 'tenant', label: data.tenant.name,
    count: data.racks.length, children: [], data: { type: 'tenant', id: 'tenant', label: data.tenant.name },
  };
  for (const b of data.buildings) {
    const bRacks = data.racks.filter(r => r.building_id === b.id);
    if (bRacks.length === 0 && b.floors.length === 0) continue;
    const bNode = {
      id: b.id, type: 'building', label: b.name, count: bRacks.length, children: [],
      data: { type: 'building', id: b.id, label: b.name },
    };
    for (const f of b.floors) {
      const fRacks = data.racks.filter(r => r.floor_id === f.id);
      const fNode = {
        id: f.id, type: 'floor', label: f.label, count: fRacks.length, children: [],
        data: { type: 'floor', id: f.id, label: f.label, buildingId: b.id },
      };
      for (const row of f.rows) {
        const rRacks = data.racks.filter(r => r.floor_id === f.id && r.row_id === row.id);
        const rNode = {
          id: `${f.id}::${row.id}`, type: 'row', label: row.label, count: rRacks.length, children: [],
          data: { type: 'row', id: `${f.id}::${row.id}`, label: row.label, floorId: f.id, rowId: row.id },
        };
        for (const rack of rRacks) {
          rNode.children.push({
            id: rack.id, type: 'rack', label: rack.name,
            data: { type: 'rack', id: rack.id, label: rack.name, status: rack.status },
            status: rack.status,
          });
        }
        fNode.children.push(rNode);
      }
      bNode.children.push(fNode);
    }
    root.children.push(bNode);
  }
  return root;
}

function filterRacks(racks, node) {
  if (!node || node.type === 'tenant' || node.id === 'tenant') return racks;
  if (node.type === 'building') return racks.filter(r => r.building_id === node.id);
  if (node.type === 'floor')    return racks.filter(r => r.floor_id === node.id);
  if (node.type === 'row')      return racks.filter(r => r.floor_id === node.floorId && r.row_id === node.rowId);
  if (node.type === 'rack')     return racks.filter(r => r.id === node.id);
  return racks;
}

function layoutTree(root) {
  if (!root) return { nodes: {}, edges: [], width: 0, height: 0 };
  // tidy-tree: assign each leaf a column, parents centered over children.
  const LEAF_GAP = 110, LEVEL_H = 90;
  const nodes = {};
  const edges = [];
  let leafCounter = 0;

  function walk(n, depth) {
    nodes[n.id] = { id: n.id, label: n.label, count: n.count, data: n.data, status: n.status, y: depth * LEVEL_H, x: 0 };
    if (!n.children || n.children.length === 0) {
      nodes[n.id].x = leafCounter * LEAF_GAP;
      leafCounter++;
      return;
    }
    for (const c of n.children) {
      walk(c, depth + 1);
      edges.push({ parent: n.id, child: c.id });
    }
    const xs = n.children.map(c => nodes[c.id].x);
    nodes[n.id].x = (Math.min(...xs) + Math.max(...xs)) / 2;
  }
  walk(root, 0);
  const xs = Object.values(nodes).map(n => n.x);
  const ys = Object.values(nodes).map(n => n.y);
  return {
    nodes, edges,
    width: Math.max(...xs) - Math.min(...xs) + 200,
    height: Math.max(...ys) + 60,
  };
}


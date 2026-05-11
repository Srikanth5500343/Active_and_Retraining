import { useMemo, useRef, useState, useEffect } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, Text, QuadraticBezierLine, Grid, Environment } from '@react-three/drei';
import * as THREE from 'three';

// ── Scene palettes ──────────────────────────────────────────────────────────
// Two palettes, picked per the app's [data-theme] attribute (set by
// ThemeContext). Exported so MultiRackTopologyPage can use the same
// colors for its shared floor / fog.
export const SCENE_PALETTES = {
  dark: {
    bg:           '#0e1830',
    fog:          '#0e1830',
    floor:        '#0c1428',
    floorOpacity:  0.88,
    gridCell:     '#2e4a78',
    gridSection:  '#5388c8',
    poolColor:    '#2a4f9e',
    poolOpacity:   0.22,
    cableJacket:  '#e6ebf2',  // off-white — pops on dark
    environment:  'warehouse',
    envIntensity:  0.55,
    ambientBoost:  1.0,
  },
  light: {
    bg:           '#f4f6fb',
    fog:          '#eef1f7',
    floor:        '#dde3ee',
    floorOpacity:  0.95,
    gridCell:     '#9aa6bd',
    gridSection:  '#4b5b7a',
    poolColor:    '#7ca0d6',
    poolOpacity:   0.20,
    cableJacket:  '#1f2937',  // dark slate — pops on light
    environment:  'apartment',
    envIntensity:  0.85,
    ambientBoost:  1.15,
  },
};

// Read the current scene palette from the document theme. Re-evaluates
// when the theme attribute changes so the canvas swaps palette live.
export function useScenePalette() {
  const read = () => {
    const t = typeof document !== 'undefined'
      ? document.documentElement.getAttribute('data-theme')
      : 'dark';
    return SCENE_PALETTES[t === 'light' ? 'light' : 'dark'];
  };
  const [palette, setPalette] = useState(read);
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return;
    const mo = new MutationObserver(() => setPalette(read()));
    mo.observe(document.documentElement, {
      attributes: true, attributeFilter: ['data-theme'],
    });
    return () => mo.disconnect();
  }, []);
  return palette;
}

const TIER_COLOR = {
  core:         '#f59e0b',
  distribution: '#22d3ee',
  access:       '#60a5fa',
  endpoint:     '#a78bfa',
};

// Capacity → color (matches the heatmap helper in TopologyPage).
function capacityColor(freePct) {
  if (freePct === null || freePct === undefined) return '#475569';
  if (freePct >= 0.5)  return '#22c55e';
  if (freePct >= 0.25) return '#f59e0b';
  return '#ef4444';
}

const CLASS_LABEL = {
  switch:      'Switch',
  patch_panel: 'Patch Panel',
  server:      'Server',
};

function tierOf(dev) {
  if (!dev.in_rack && dev.class === 'switch') return 'core';
  if (dev.class === 'switch')                 return 'distribution';
  if (dev.class === 'patch_panel')            return 'access';
  if (dev.class === 'server')                 return 'endpoint';
  return null;
}

// World-unit constants
export const U_HEIGHT   = 0.42;
export const DEV_DEPTH  = 1.4;
export const DEV_WIDTH  = 3.0;
const FRAME_THK  = 0.07;
const FRONT_Z    = DEV_DEPTH / 2;
export const FOV_DEG    = 42;
const SHELF_GAP  = 0.5;   // U-units of empty space between top of rack and uplink shelf

// World-X distance between centers of adjacent racks in a multi-rack scene.
// DEV_WIDTH is the chassis width; the gap is a constant breathing space so
// cables/labels never collide between neighboring racks.
export const RACK_GAP     = 1.6;
export const RACK_SPACING = DEV_WIDTH + RACK_GAP;

// Convert an integer-or-half U position to a chassis-relative Y.
// uPos=1 is the bottom slot, uPos=chassisU is the top slot.
function uCenterY(uPos, sizeU, chassisU) {
  return -chassisU * U_HEIGHT / 2 + (uPos - 1 + sizeU / 2) * U_HEIGHT;
}

// Render simplified ghost racks to either side if the topology JSON tells us
// about neighbors. Looks for either:
//   topo.neighbors = [{ side: 'left'|'right', name, u_size }]
// or  topo.crossRackEdges = [{ peerRack, count }] — in which case we synthesize
// generic ghost racks. If nothing is provided this component renders nothing.
function NeighborRacks({ topo, chassisU }) {
  const neighbors = useMemo(() => {
    if (Array.isArray(topo.neighbors) && topo.neighbors.length) {
      return topo.neighbors.map((n, i) => ({
        side: n.side || (i % 2 === 0 ? 'left' : 'right'),
        name: n.name || `RACK-${i+1}`,
        uSize: n.u_size || 18,
        count: n.cable_count || 0,
      }));
    }
    if (Array.isArray(topo.crossRackEdges) && topo.crossRackEdges.length) {
      return topo.crossRackEdges.map((cr, i) => ({
        side: i % 2 === 0 ? 'left' : 'right',
        name: cr.peerRack,
        uSize: 18,
        count: cr.count || 0,
      }));
    }
    return [];
  }, [topo]);

  if (!neighbors.length) return null;

  const totalH = chassisU * U_HEIGHT + 0.5;
  const offsetX = 6.5;

  return (
    <group>
      {neighbors.map((n, i) => {
        const dir = n.side === 'left' ? -1 : 1;
        const x = dir * (offsetX + (i >> 1) * 4.5);
        return (
          <group key={`${n.name}-${i}`} position={[x, 0, -1.0]}>
            <mesh>
              <boxGeometry args={[2.2, totalH * 0.85, 1.4]} />
              <meshStandardMaterial color="#0b1428" metalness={0.6} roughness={0.55}
                                    transparent opacity={0.55}
                                    emissive="#1a2547" emissiveIntensity={0.22} />
            </mesh>
            {/* Connecting beam from main rack toward this neighbor */}
            <mesh position={[-dir * 1.1, 0, 1.0]} rotation={[0, dir > 0 ? -0.18 : 0.18, 0]}>
              <boxGeometry args={[Math.max(0.5, offsetX - 2), 0.04, 0.04]} />
              <meshBasicMaterial color="#22d3ee" transparent opacity={0.55} />
            </mesh>
            <Text
              position={[0, totalH/2 * 0.85 + 0.15, 0.72]}
              fontSize={0.18}
              color="#cbd5f5"
              anchorX="center"
              anchorY="bottom"
              outlineWidth={0.005}
              outlineColor="#020617"
            >
              {n.name}
            </Text>
            {n.count > 0 && (
              <Text
                position={[0, 0, 0.72]}
                fontSize={0.14}
                color="#67e8f9"
                anchorX="center"
                anchorY="middle"
              >
                {`${n.count} cables`}
              </Text>
            )}
          </group>
        );
      })}
    </group>
  );
}

// Bundled cable trunk that runs down the rear corner of the rack — visual
// only (the real per-cable runs are still drawn from front ports on click).
// Renders a fat dark cylinder with a few thin colored bands around it.
function CableArm({ side, totalH, totalD, totalW }) {
  const x = side === 'left' ? -totalW/2 + 0.06 : totalW/2 - 0.06;
  const z = -totalD/2 + 0.07;
  const armH = totalH - 0.4;
  // Velcro band colors match the realistic cable jacket palette:
  // copper-blue, fiber-MM-aqua, fiber-SM-yellow.
  const bandColors = ['#2563eb', '#22d3b8', '#fbbf24'];
  return (
    <group position={[x, 0, z]}>
      {/* Main bundle */}
      <mesh>
        <cylinderGeometry args={[0.06, 0.06, armH, 12]} />
        <meshStandardMaterial color="#070b1c" metalness={0.3} roughness={0.85} />
      </mesh>
      {/* Velcro/cable bands */}
      {bandColors.map((c, i) => {
        const yPos = -armH/2 + (i + 1) * (armH / (bandColors.length + 1));
        return (
          <mesh key={i} position={[0, yPos, 0]}>
            <cylinderGeometry args={[0.07, 0.07, 0.04, 14]} />
            <meshStandardMaterial color={c} metalness={0.5} roughness={0.4}
                                  emissive={c} emissiveIntensity={0.18} />
          </mesh>
        );
      })}
    </group>
  );
}

// Front vertical cable manager — a thin recessed channel rail running
// floor-to-ceiling on each side of the rack. Just the channel itself, no
// floating "finger" bars — those read as visual noise rather than as real
// cable management. Cables route inside the channel (matches CABLE_X /
// CABLE_Z used in PortCables).
function CableManagerFront({ side, totalH }) {
  const sign = side === 'left' ? -1 : 1;
  const x = sign * (DEV_WIDTH / 2 + 0.18);
  const z = FRONT_Z + 0.10;
  const railH = totalH - 0.20;
  return (
    <group position={[x, 0, z]}>
      {/* Outer rail — narrow dark anodized strip, sits flush against
          the rack post. Same metal finish as the chassis so it reads as
          part of the frame, not a separate gadget. */}
      <mesh>
        <boxGeometry args={[0.08, railH, 0.04]} />
        <meshStandardMaterial color="#0d1322" metalness={0.6} roughness={0.5} />
      </mesh>
      {/* Recessed gutter — slightly inset darker channel where cables drop
          in. Reads as a cable-routing slot rather than a solid bar. */}
      <mesh position={[0, 0, 0.022]}>
        <boxGeometry args={[0.04, railH - 0.06, 0.012]} />
        <meshStandardMaterial color="#04081a" metalness={0.3} roughness={0.85} />
      </mesh>
    </group>
  );
}

// Animated swing-open hinge for a side glass panel.
function SwingPanel({ side, totalH, totalD, totalW, open, onClick }) {
  const ref = useRef();
  const target = open ? -Math.PI * 0.6 * (side === 'left' ? 1 : -1) : 0;
  useFrame(() => {
    if (!ref.current) return;
    // Smooth lerp toward target rotation.
    ref.current.rotation.y += (target - ref.current.rotation.y) * 0.12;
  });
  // Hinge pivot is at the FRONT edge of the side, so the panel swings outward.
  const hingeX = side === 'left' ? -totalW/2 + 0.012 : totalW/2 - 0.012;
  const hingeZ = totalD/2 - 0.012;
  // Inside the swinging group, the panel is offset so its front edge sits
  // at the hinge (pivot), and it extends backward toward -Z by totalD-0.024.
  const panelLen = totalD - 0.024;
  return (
    <group ref={ref} position={[hingeX, 0, hingeZ]}>
      <mesh
        position={[0, 0, -panelLen/2]}
        rotation={[0, side === 'left' ? Math.PI/2 : -Math.PI/2, 0]}
        onClick={(e) => { e.stopPropagation(); onClick && onClick(); }}
      >
        <planeGeometry args={[panelLen, totalH - 0.04]} />
        <meshStandardMaterial
          color="#0a1228"
          metalness={0.3}
          roughness={0.2}
          transparent
          opacity={0.22}
          emissive="#1a2547"
          emissiveIntensity={0.22}
          side={THREE.DoubleSide}
        />
      </mesh>
      {/* Subtle hinge marker so users see where it swings from */}
      <mesh position={[0, 0, -0.03]}>
        <boxGeometry args={[0.02, totalH - 0.06, 0.04]} />
        <meshStandardMaterial color="#1a2547" metalness={0.6} roughness={0.5} />
      </mesh>
    </group>
  );
}

// ── Rack chassis: posts, plates, 3-sided glass enclosure, U markings ───────
function RackChassis({ totalU, chassisU, rackName, hasShelf, leftOpen, rightOpen,
                      toggleLeft, toggleRight }) {
  const totalH = chassisU * U_HEIGHT + 0.5;
  const totalW = DEV_WIDTH + 0.55;
  const totalD = DEV_DEPTH + 0.30;
  const POST_W = FRAME_THK * 1.4;       // a touch chunkier — reads as real metal

  // Anodized aluminum — mid-dark so the rack frame reads as a real metal
  // chassis against the navy backdrop. High metalness so the IBL probe
  // gives it a polished specular sheen instead of flat plastic.
  const bodyMat = (
    <meshStandardMaterial
      color="#2a3358"
      metalness={0.85}
      roughness={0.34}
      emissive="#3a4570"
      emissiveIntensity={0.10}
    />
  );

  const post = (x, z, key) => (
    <mesh key={key} position={[x, 0, z]}>
      <boxGeometry args={[POST_W, totalH, POST_W]} />
      {bodyMat}
    </mesh>
  );
  const plate = (y, key) => (
    <mesh key={key} position={[0, y, 0]}>
      <boxGeometry args={[totalW, FRAME_THK, totalD]} />
      {bodyMat}
    </mesh>
  );

  // Y of the shelf separator line (between U18 top and uplink shelf bottom)
  const shelfSeparatorY = -chassisU * U_HEIGHT / 2 + (totalU + SHELF_GAP / 2) * U_HEIGHT;

  // Top vent slats — sit on top of the top plate, front portion, evokes airflow.
  const VENT_COUNT = 7;
  const ventStripW = totalW * 0.55;
  const ventGap    = ventStripW / VENT_COUNT;

  return (
    <group>
      {/* Four corner posts */}
      {post(-totalW/2, -totalD/2, 'p1')}
      {post( totalW/2, -totalD/2, 'p2')}
      {post(-totalW/2,  totalD/2, 'p3')}
      {post( totalW/2,  totalD/2, 'p4')}
      {/* Top + bottom plates */}
      {plate( totalH/2, 'plt-top')}
      {plate(-totalH/2, 'plt-bot')}

      {/* Base kick plate — wider, sits just under the bottom plate */}
      <mesh position={[0, -totalH/2 - 0.05, 0]}>
        <boxGeometry args={[totalW + 0.10, 0.10, totalD + 0.06]} />
        <meshStandardMaterial
          color="#080d1f"
          metalness={0.6}
          roughness={0.55}
        />
      </mesh>

      {/* Top vent grille — array of thin recessed slats on the top plate */}
      <group position={[0, totalH/2 + FRAME_THK/2 + 0.001, 0]}>
        {Array.from({ length: VENT_COUNT }).map((_, i) => {
          const x = -ventStripW/2 + ventGap/2 + i * ventGap;
          return (
            <mesh key={`vent-${i}`} position={[x, 0, totalD/4]}>
              <boxGeometry args={[ventGap * 0.45, 0.02, totalD * 0.32]} />
              <meshStandardMaterial color="#04081a" metalness={0.4} roughness={0.85} />
            </mesh>
          );
        })}
      </group>

      {/* Back panel — dark tinted glass */}
      <mesh position={[0, 0, -totalD/2 + 0.012]}>
        <planeGeometry args={[totalW - 0.04, totalH - 0.04]} />
        <meshStandardMaterial
          color="#0a1228"
          metalness={0.4}
          roughness={0.35}
          transparent
          opacity={0.55}
          emissive="#0e1a3a"
          emissiveIntensity={0.20}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Left + right glass panels — clickable, swing open on click */}
      <SwingPanel side="left"  totalH={totalH} totalD={totalD} totalW={totalW}
                  open={leftOpen}  onClick={toggleLeft} />
      <SwingPanel side="right" totalH={totalH} totalD={totalD} totalW={totalW}
                  open={rightOpen} onClick={toggleRight} />

      {/* U numbering on left rail (front-facing) — only for physical 1..totalU */}
      {Array.from({ length: totalU }).map((_, i) => {
        const u = i + 1;
        const y = uCenterY(u, 1, chassisU);
        return (
          <Text
            key={`u-${u}`}
            position={[-totalW/2 - 0.08, y, totalD/2 + 0.02]}
            fontSize={0.12}
            color="rgba(255,255,255,0.5)"
            anchorX="right"
            anchorY="middle"
            outlineWidth={0.003}
            outlineColor="#020617"
          >
            {`U${String(u).padStart(2,'0')}`}
          </Text>
        );
      })}

      {/* Uplink shelf separator line + label */}
      {hasShelf && (
        <group>
          {/* Thin amber separator line on the front of the rack */}
          <mesh position={[0, shelfSeparatorY, totalD/2 + 0.005]}>
            <planeGeometry args={[totalW - 0.18, 0.014]} />
            <meshBasicMaterial color="#fcd34d" transparent opacity={0.45} />
          </mesh>
          {/* Label on the left rail, just above the separator */}
          <Text
            position={[-totalW/2 - 0.08, shelfSeparatorY + 0.20, totalD/2 + 0.02]}
            fontSize={0.082}
            color="#fcd34d"
            anchorX="right"
            anchorY="middle"
            letterSpacing={0.18}
          >
            UPLINK
          </Text>
        </group>
      )}

      {/* Cable management arms — bundled trunks running down the rear corners,
          gives the rack the proper "wired up" feel without rendering every
          per-cable run in the back. Two arms, one per rear post. */}
      <CableArm side="left"  totalH={totalH} totalD={totalD} totalW={totalW} />
      <CableArm side="right" totalH={totalH} totalD={totalD} totalW={totalW} />

      {/* Front vertical cable managers — recessed channel rails on each side
          rail that the per-port cables route through. Visible from the front. */}
      <CableManagerFront side="left"  totalH={totalH} />
      <CableManagerFront side="right" totalH={totalH} />

      {/* Rack nameplate — small brushed-metal badge above the rack */}
      <group position={[0, totalH/2 + 0.16, totalD/2 + 0.04]}>
        <mesh position={[0, 0.10, 0]}>
          <boxGeometry args={[Math.max(1.4, rackName?.length * 0.12 || 1.6), 0.28, 0.04]} />
          <meshStandardMaterial color="#0c1428" metalness={0.85} roughness={0.35}
                                emissive="#1a2547" emissiveIntensity={0.18} />
        </mesh>
        {/* Thin cyan accent stripe along the bottom of the badge */}
        <mesh position={[0, -0.04, 0.022]}>
          <planeGeometry args={[Math.max(1.3, rackName?.length * 0.115 || 1.5), 0.018]} />
          <meshBasicMaterial color="#22d3ee" transparent opacity={0.7} />
        </mesh>
        <Text
          position={[0, 0.10, 0.022]}
          fontSize={0.16}
          color="#e2e8f0"
          anchorX="center"
          anchorY="middle"
          outlineWidth={0.005}
          outlineColor="#020617"
          letterSpacing={0.08}
        >
          {rackName}
        </Text>
      </group>
    </group>
  );
}

// ── Cable color by physical type ───────────────────────────────────────────
// Real datacenter cable jacket colors — TIA-598 fiber color codes for the
// optics, common-practice colors for copper. We match by class first
// (most-specific keyword wins) then fall back to family defaults so
// generic strings like "fiber" or "cat6" still resolve.
function cableColor(cable_type) {
  const t = (cable_type || '').toLowerCase();
  // Single-mode fiber (OS1/OS2) — yellow jacket
  if (t.includes('sm') || t.includes('single') ||
      t.includes('os1') || t.includes('os2'))                       return '#fbbf24';
  // OM5 wideband multi-mode — lime green jacket
  if (t.includes('om5'))                                             return '#a3e635';
  // OM3 / OM4 multi-mode — aqua jacket
  if (t.includes('om3') || t.includes('om4') || t.includes('mm'))   return '#22d3b8';
  // Generic fiber default → aqua (most common datacenter MMF)
  if (t.includes('fiber') || t.includes('fibre'))                   return '#22d3b8';
  // Direct-attach copper / twinax — black jacket with metal connectors
  if (t.includes('dac') || t.includes('twinax'))                    return '#475569';
  // Copper Ethernet (Cat5e/Cat6/Cat6a/Cat7) — datacenter blue
  if (t.startsWith('cat'))                                          return '#2563eb';
  // Unknown → muted slate so it stays readable but doesn't pretend a type
  return '#64748b';
}

// ── Port layout: returns Map<portName, [relX, relY]> on the device front face.
// relX/relY are device-local (relative to device center). Caller adds centerY.
// Layouts mirror the physical reality of each class:
//   - switches: 2 rows of N/2 ports
//   - patch panels: 1 row of N jacks
//   - servers: 2-column NIC cluster on the right
function computePortPositions(dev, h) {
  const map = new Map();
  const ports = dev.ports || [];
  const n = ports.length;
  if (n === 0) return map;

  if (dev.class === 'switch') {
    const cols = Math.ceil(n / 2);
    const rowsY = [h * 0.20, -h * 0.20];
    const xMin  = -DEV_WIDTH * 0.34;
    const xMax  =  DEV_WIDTH * 0.34;
    ports.forEach((p, i) => {
      const row = i < cols ? 0 : 1;
      const col = row === 0 ? i : i - cols;
      const denom = Math.max(1, cols - 1);
      const t = denom === 0 ? 0.5 : col / denom;
      map.set(p.name, [xMin + t * (xMax - xMin), rowsY[row]]);
    });
  } else if (dev.class === 'patch_panel') {
    const xMin = -DEV_WIDTH * 0.40;
    const xMax =  DEV_WIDTH * 0.40;
    ports.forEach((p, i) => {
      const t = n === 1 ? 0.5 : i / (n - 1);
      map.set(p.name, [xMin + t * (xMax - xMin), 0]);
    });
  } else if (dev.class === 'server') {
    // Two-column NIC stack on the right portion of the faceplate
    const xCols = [DEV_WIDTH * 0.18, DEV_WIDTH * 0.30];
    ports.forEach((p, i) => {
      const col = i % 2;
      const row = Math.floor(i / 2);
      const y = h * 0.20 - row * (h * 0.18);
      map.set(p.name, [xCols[col], y]);
    });
  }
  return map;
}

// ── Port grid: one visible element per real port, at its mapped position ───
// Each port now renders as a recessed jack: a metallic rim (slightly raised)
// + a dark inner cavity. RJ45 rectangles for switches, LC-style circles for
// patch panels, smaller circles for server NICs. Highlighted/uplink ports
// keep the bright color so they still pop.
function PortGrid({ dev, h, dimmed, portMap, highlightedPorts }) {
  const ports = dev.ports || [];
  if (!ports.length) return null;
  const isSwitch = dev.class === 'switch';
  const isPanel  = dev.class === 'patch_panel';
  const isServer = dev.class === 'server';

  const COL_EMPTY   = '#020617';
  const COL_CONNECT = '#1a2540';
  const COL_UPLINK  = '#fcd34d';
  const COL_HL      = '#ffffff';
  const COL_RIM     = '#5b6b8a';  // brushed-metal jack rim

  return (
    <group>
      {ports.map((p) => {
        const rel = portMap.get(p.name);
        if (!rel) return null;
        const [x, y] = rel;
        const isHL  = highlightedPorts && highlightedPorts.has(p.name);
        const isConnected = p.connected !== false;
        const color = isHL
          ? COL_HL
          : (p.is_uplink ? COL_UPLINK
              : (isConnected ? COL_CONNECT : COL_EMPTY));
        const baseOpacity = isConnected ? 0.95 : 0.6;
        const opacity = dimmed ? 0.30 : (isHL ? 1.0 : baseOpacity);
        const rimOpacity = dimmed ? 0.22 : 0.85;

        if (isSwitch) {
          const sw = 0.085;
          const sh = Math.min(0.05, h * 0.13);
          const rimW = sw + 0.014;
          const rimH = sh + 0.014;
          return (
            <group key={p.name} position={[x, y, 0]}>
              {/* Metallic jack rim (slightly raised) */}
              <mesh position={[0, 0, 0.001]}>
                <planeGeometry args={[rimW, rimH]} />
                <meshBasicMaterial color={COL_RIM} transparent opacity={rimOpacity} />
              </mesh>
              {/* Inner cavity / hole */}
              <mesh position={[0, 0, 0.0025]}>
                <planeGeometry args={[sw, sh]} />
                <meshBasicMaterial color={color} transparent opacity={opacity} />
              </mesh>
              {/* Tiny shadow line at the bottom of the rim — fakes recess */}
              <mesh position={[0, -rimH/2 + 0.003, 0.002]}>
                <planeGeometry args={[rimW, 0.005]} />
                <meshBasicMaterial color="#000000" transparent opacity={dimmed ? 0.2 : 0.55} />
              </mesh>
            </group>
          );
        }
        if (isPanel) {
          const r = Math.min(0.045, h * 0.12);
          const rimR = r + 0.012;
          return (
            <group key={p.name} position={[x, y, 0]}>
              <mesh position={[0, 0, 0.001]}>
                <circleGeometry args={[rimR, 18]} />
                <meshBasicMaterial color={COL_RIM} transparent opacity={rimOpacity} />
              </mesh>
              <mesh position={[0, 0, 0.0025]}>
                <circleGeometry args={[r, 18]} />
                <meshBasicMaterial color={color} transparent opacity={opacity} />
              </mesh>
              {/* tiny inner highlight dot — gives the LC port a 3D feel */}
              <mesh position={[-r * 0.3, r * 0.3, 0.003]}>
                <circleGeometry args={[r * 0.18, 10]} />
                <meshBasicMaterial color="#ffffff" transparent
                                   opacity={dimmed ? 0.05 : 0.18} />
              </mesh>
            </group>
          );
        }
        if (isServer) {
          const r = Math.min(0.04, h * 0.10);
          const rimR = r + 0.010;
          return (
            <group key={p.name} position={[x, y, 0]}>
              <mesh position={[0, 0, 0.001]}>
                <circleGeometry args={[rimR, 16]} />
                <meshBasicMaterial color={COL_RIM} transparent opacity={rimOpacity} />
              </mesh>
              <mesh position={[0, 0, 0.0025]}>
                <circleGeometry args={[r, 16]} />
                <meshBasicMaterial color={color} transparent opacity={opacity} />
              </mesh>
            </group>
          );
        }
        return null;
      })}
    </group>
  );
}

// ── Device box — used for both in-rack and uplink-shelf devices ────────────
function DeviceBox({ dev, uPos, sizeU, chassisU, color, dimmed, selected, isCore,
                     portMap, highlightedPorts, onClick, onHoverIn, onHoverOut }) {
  const y = uCenterY(uPos, sizeU, chassisU);
  const h = sizeU * U_HEIGHT * 0.92;
  const w = DEV_WIDTH;
  const d = DEV_DEPTH;
  const opacity      = dimmed ? 0.30 : 1;
  const baseEmissive = selected ? 0.62 : (isCore ? 0.30 : 0.18);

  // Synced subtle "breathing" pulse on the body's emissive intensity.
  // Phase shifted by U position so the rack doesn't pulse as one block.
  const matRef = useRef();
  const ledRef = useRef();
  const phase  = uPos * 0.42;
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    if (matRef.current) {
      matRef.current.emissiveIntensity =
        baseEmissive + (selected ? 0 : Math.sin(t * 1.6 + phase) * 0.05);
    }
    if (ledRef.current) {
      // LED blinks faster, varies opacity 0.55..1
      ledRef.current.opacity = dimmed ? 0.25
        : 0.78 + Math.sin(t * 2.6 + phase * 1.7) * 0.22;
    }
  });

  // Faceplate is a tier-tinted brushed-metal plate slightly raised above the body.
  // The tint is subtle (~22% of the tier color into a deep navy base) — enough
  // that you can read tier at a glance, but never cartoony.
  const FACE_INSET = 0.018;
  const FACE_DEPTH = 0.025;
  const faceW      = w - FACE_INSET * 2;
  const faceH      = h - FACE_INSET * 2;
  const faceZ      = d/2 + FACE_DEPTH/2;

  const isSwitch = dev.class === 'switch';
  const isPanel  = dev.class === 'patch_panel';

  // Real datacenter equipment is dark anodized aluminum or matte black —
  // switches, patch panels, servers all live in shades of charcoal with
  // brand/status colors confined to small LEDs and accent strips. Tier
  // color is no longer used as a body tint; it stays as the LED rim, edge
  // trim, and brand stripe so the tier is still readable at a glance.
  const { bodyColor, faceColor, bodyMetalness, bodyRoughness } = useMemo(() => {
    if (dev.class === 'patch_panel') {
      // Matte black powder-coated panel — most patch panels look like this.
      // Lifted enough that ports + labels remain readable against the rack.
      return {
        bodyColor: new THREE.Color('#1a2138'),
        faceColor: new THREE.Color('#222a44'),
        bodyMetalness: 0.35,
        bodyRoughness: 0.72,
      };
    }
    if (dev.class === 'server') {
      // Server chassis — light charcoal, metallic brushed finish
      return {
        bodyColor: new THREE.Color('#2c3450'),
        faceColor: new THREE.Color('#363f5c'),
        bodyMetalness: 0.78,
        bodyRoughness: 0.36,
      };
    }
    // Default: switch — anodized aluminum, mid-dark so it reads as metal
    return {
      bodyColor: new THREE.Color('#252e48'),
      faceColor: new THREE.Color('#2f3a58'),
      bodyMetalness: 0.72,
      bodyRoughness: 0.38,
    };
  }, [dev.class]);

  return (
    <group position={[0, y, 0]}>
      {/* Body — dark anodized chassis. Tier emissive stays subtle so the
          device reads as metal first, status indicator second. */}
      <mesh
        onClick={(e) => { e.stopPropagation(); onClick && onClick(); }}
        onPointerOver={(e) => { e.stopPropagation(); onHoverIn && onHoverIn(); }}
        onPointerOut={(e)  => { onHoverOut && onHoverOut(); }}
      >
        <boxGeometry args={[w, h, d]} />
        <meshStandardMaterial
          ref={matRef}
          color={bodyColor}
          metalness={bodyMetalness}
          roughness={bodyRoughness}
          emissive={color}
          emissiveIntensity={baseEmissive * 0.18}
          transparent
          opacity={opacity}
        />
      </mesh>

      {/* Faceplate — slightly lighter dark panel, raised proud of the body */}
      <mesh position={[0, 0, faceZ]}>
        <boxGeometry args={[faceW, faceH, FACE_DEPTH]} />
        <meshStandardMaterial
          color={faceColor}
          metalness={0.50}
          roughness={0.50}
          emissive={color}
          emissiveIntensity={selected ? 0.14 : 0.04}
          transparent
          opacity={opacity}
        />
      </mesh>

      {/* Brushed-metal highlight — narrow soft line across the top edge of
          the faceplate, simulates a single directional reflection. Subtle,
          not a bright bar. */}
      <mesh position={[0, faceH/2 - 0.012, d/2 + FACE_DEPTH + 0.002]}>
        <planeGeometry args={[faceW * 0.92, 0.003]} />
        <meshBasicMaterial color="#a5b4cf" transparent
                           opacity={dimmed ? 0.06 : 0.18} />
      </mesh>

      {/* Tier indicator — tiny LED-style dot on the right edge of the face.
          Replaces the previous full-device halo: real switches don't glow,
          they just have status lights. Highlights when the device is
          selected, otherwise sits as an unobtrusive accent. */}
      <mesh position={[w/2 - 0.06, h * 0.28, d/2 + FACE_DEPTH + 0.003]}>
        <circleGeometry args={[Math.min(0.022, h * 0.06), 12]} />
        <meshBasicMaterial color={color} transparent
                           opacity={dimmed ? 0.25 : (selected ? 1 : 0.85)} />
      </mesh>

      {/* Bottom tier-color trim — single thin LED line at the base of the
          faceplate (the rack-rail "activity strip"). Top trim removed to
          reduce visual noise. */}
      <mesh position={[0, -faceH/2 + 0.005, d/2 + FACE_DEPTH + 0.002]}>
        <planeGeometry args={[faceW * 0.92, 0.005]} />
        <meshBasicMaterial color={color} transparent
                           opacity={dimmed ? 0.18 : (selected ? 0.85 : 0.40)} />
      </mesh>

      {/* Brand stripe — narrow vertical accent on the left edge, like the
          colored badge most switches have at the corner. Thin, not a bar. */}
      <mesh position={[-w/2 + 0.030, 0, d/2 + FACE_DEPTH + 0.003]}>
        <planeGeometry args={[0.014, h * 0.55]} />
        <meshBasicMaterial color={color} transparent
                           opacity={dimmed ? 0.20 : (selected ? 0.90 : 0.55)} />
      </mesh>

      {/* Port-bank recess — subtle strip behind the port rows. Light enough
          that the dark port sockets contrast against it. */}
      {(isSwitch || isPanel) && (
        <mesh position={[0, 0, d/2 + FACE_DEPTH + 0.001]}>
          <planeGeometry args={[
            w * (isSwitch ? 0.74 : 0.86),
            h * (isSwitch ? 0.62 : 0.36),
          ]} />
          <meshBasicMaterial color="#cbd5f5" transparent
                             opacity={dimmed ? 0.18 : 0.45} />
        </mesh>
      )}

      {/* Side vent slits on the right edge of the faceplate (switches only).
          Five thin dark vertical slits — reads as airflow / fan exhaust. */}
      {isSwitch && Array.from({ length: 5 }).map((_, i) => (
        <mesh
          key={`vent-${i}`}
          position={[w/2 - 0.10 - i * 0.035, h * 0.08, d/2 + FACE_DEPTH + 0.002]}
        >
          <planeGeometry args={[0.012, h * 0.32]} />
          <meshBasicMaterial color="#04081a" transparent opacity={0.85} />
        </mesh>
      ))}

      {/* Status LED — recessed dark socket + bright inner dot */}
      <group position={[-w/2 + 0.115, h * 0.32, d/2 + FACE_DEPTH + 0.002]}>
        <mesh>
          <circleGeometry args={[Math.min(0.06, h * 0.16), 16]} />
          <meshBasicMaterial color="#04081a" />
        </mesh>
        <mesh position={[0, 0, 0.001]}>
          <circleGeometry args={[Math.min(0.04, h * 0.10), 14]} />
          <meshBasicMaterial
            ref={ledRef}
            color={isCore ? '#fcd34d' : '#86efac'}
            transparent
            opacity={1}
          />
        </mesh>
      </group>

      {/* Real ports — each rendered at its true position on the face */}
      <group position={[0, 0, d/2 + FACE_DEPTH + 0.003]}>
        <PortGrid dev={dev} h={h} dimmed={dimmed}
                  portMap={portMap} highlightedPorts={highlightedPorts} />
      </group>

      {/* Device name */}
      <Text
        position={[-w/2 + 0.16, h * 0.04, d/2 + FACE_DEPTH + 0.003]}
        fontSize={Math.min(0.18, h * 0.45)}
        color="#f8fafc"
        anchorX="left"
        anchorY="middle"
        outlineWidth={0.005}
        outlineColor="#020617"
      >
        {dev.name}
      </Text>

      {/* Class / model — or CORE / UPLINK badge */}
      <Text
        position={[w/2 - 0.1, -h * 0.20, d/2 + FACE_DEPTH + 0.003]}
        fontSize={Math.min(0.10, h * 0.26)}
        color={isCore ? '#fcd34d' : 'rgba(241,245,249,0.62)'}
        anchorX="right"
        anchorY="middle"
        outlineWidth={0.003}
        outlineColor="#020617"
        letterSpacing={isCore ? 0.12 : 0}
      >
        {isCore ? 'CORE / UPLINK' : (dev.model || CLASS_LABEL[dev.class] || dev.class)}
      </Text>

      {/* Port count badge */}
      {dev.ports?.length ? (
        <Text
          position={[w/2 - 0.1, h * 0.24, d/2 + FACE_DEPTH + 0.003]}
          fontSize={Math.min(0.085, h * 0.22)}
          color="rgba(255,255,255,0.50)"
          anchorX="right"
          anchorY="middle"
        >
          {`${dev.ports.length}p`}
        </Text>
      ) : null}
    </group>
  );
}

// Stable string-hash → 0..1 (used for tiny per-cable bow randomization)
function hash01(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

// ── Selection-driven port-accurate cables ─────────────────────────────────
// Click a device → every real cable on every real port of that device is
// drawn from the exact src-port position to the exact dst-port position.
// Lines colored by cable_type (Cat6a / Fiber / DAC). Each cable has a small
// hash-based bow offset so a 24-cable trunk fans out instead of overlapping.
function PortCables({ selected, topo, positions, traceEdgeKeys, setSelected, cableJacketColor = '#e6ebf2' }) {
  const groupRef = useRef();

  useFrame((state) => {
    if (!groupRef.current) return;
    const t = state.clock.elapsedTime;
    groupRef.current.position.z = 0.02 + Math.sin(t * 1.4) * 0.012;
  });

  const cables = useMemo(() => {
    const out = [];
    const traceMode = traceEdgeKeys && traceEdgeKeys.size > 0;
    const selDev    = selected?.kind === 'node' ? selected.id : null;
    // When a single cable is selected, render the whole trunk between the
    // two devices it spans — so the user sees its siblings + the chosen one.
    const selCable  = selected?.kind === 'cable'
      ? topo.edges.find(e => e.cable_id === selected.id)
      : null;
    const trunkPair = selCable
      ? [selCable.src.device, selCable.dst.device].sort().join('::')
      : null;

    // Default mode (no selection, no trace): render every cable at a subtle
    // ambient opacity so the wiring is visible from the start. Selection /
    // trace still classifies cables as focused vs background, but the
    // background ones stay rendered (just dimmer) so the rack never looks
    // bare again once you pan away.
    const hasFocus = !!(traceMode || selDev || trunkPair);

    // Vertical cable-manager channels live just outside each rack rail.
    // Cables exit a port → run forward briefly → drop into the channel →
    // travel vertically → re-enter the destination port. This mimics how
    // patch cords physically route in a real rack instead of bowing forward
    // through the air.
    const CHANNEL_X = DEV_WIDTH / 2 + 0.18;  // x of the side rail manager
    const CHANNEL_Z = FRONT_Z + 0.16;         // depth at which cables run
    const PORT_EXIT_Z = FRONT_Z + 0.09;       // how far the cable sticks out of the jack

    for (const e of topo.edges) {
      const a = e.src.device, b = e.dst.device;
      const key = a < b ? `${a}::${b}` : `${b}::${a}`;
      const inTrace = traceMode && traceEdgeKeys.has(key);
      const inSel   = !traceMode && selDev && (a === selDev || b === selDev);
      const inTrunk = trunkPair && key === trunkPair;
      const focused = inTrace || inSel || inTrunk;

      // In trace mode the user is asking for a *single* path — hide the rest
      // so the routed path stands out unambiguously. Outside trace mode we
      // always render every edge (focused or not).
      if (traceMode && !focused) continue;

      const srcDev = positions.get(a);
      const dstDev = positions.get(b);
      if (!srcDev || !dstDev) continue;

      const srcRel = srcDev.portMap?.get(e.src.port);
      const dstRel = dstDev.portMap?.get(e.dst.port);
      if (!srcRel || !dstRel) continue;

      const startV = new THREE.Vector3(srcRel[0], srcDev.centerY + srcRel[1], FRONT_Z + 0.025);
      const endV   = new THREE.Vector3(dstRel[0], dstDev.centerY + dstRel[1], FRONT_Z + 0.025);

      // Pick a routing side per cable. Strategy:
      //   * If both ports are clearly on the same half of the device,
      //     route via that side's manager — keeps natural runs short.
      //   * Otherwise (cable spans the device), use a stable per-cable
      //     hash so consecutive cables in a trunk fan evenly between
      //     the left and right rails instead of all bunching on one side.
      const sideThresh = DEV_WIDTH * 0.10;
      let sideDir;
      if (srcRel[0] < -sideThresh && dstRel[0] < -sideThresh)      sideDir = -1;
      else if (srcRel[0] > sideThresh && dstRel[0] > sideThresh)   sideDir = 1;
      else  sideDir = hash01(e.cable_id + 'side') >= 0.5 ? 1 : -1;

      // Small per-cable jitter so a 24-cable trunk fans across the channel
      // depth instead of overlapping into a single line.
      const jx = (hash01(e.cable_id + 'x') - 0.5) * 0.08;
      const jz = (hash01(e.cable_id + 'z') - 0.5) * 0.05;
      const channelX = sideDir * (CHANNEL_X + Math.abs(jx));
      const channelZ = CHANNEL_Z + jz;

      // Cable path: jack → forward exit → channel entry → channel sag mid →
      // channel exit → forward at destination → jack. CatmullRom gives smooth
      // bends without overshoot.
      const exitA = new THREE.Vector3(startV.x, startV.y, PORT_EXIT_Z);
      const exitB = new THREE.Vector3(endV.x,   endV.y,   PORT_EXIT_Z);
      const chA   = new THREE.Vector3(channelX, startV.y, channelZ);
      const chB   = new THREE.Vector3(channelX, endV.y,   channelZ);
      // Sag: longer vertical runs droop slightly forward in the channel
      const dy = Math.abs(endV.y - startV.y);
      const sagZ = channelZ + Math.min(0.10, dy * 0.025);
      const chMid = new THREE.Vector3(
        channelX, (startV.y + endV.y) / 2, sagZ
      );
      const points = [startV, exitA, chA, chMid, chB, exitB, endV];

      const curve = new THREE.CatmullRomCurve3(points, false, 'catmullrom', 0.5);
      out.push({
        edge: e, curve, color: cableColor(e.cable_type),
        focused, hasFocus,
        // Endpoints + tangent for connector orientation
        startV, endV,
      });
    }
    return out;
  }, [selected, topo, positions, traceEdgeKeys]);

  if (!cables.length) return null;

  const selCableId = selected?.kind === 'cable' ? selected.id : null;

  return (
    <group ref={groupRef}>
      {cables.map((c) => {
        const isSelected = selCableId === c.edge.cable_id;
        // All cables render as off-white PVC jackets. Type-color stays on
        // the strain-relief band of each connector boot so cable type can
        // still be read end-on. Visual tiers:
        //   selected → thick + bright white
        //   focused → normal white
        //   background (something IS selected) → thin + low alpha
        //   default ambient (no selection) → standard
        let radius, opacity, transparent;
        const cableHex = cableJacketColor;   // theme-driven jacket color
        if (isSelected) {
          radius = 0.026; opacity = 1;    transparent = false;
        } else if (c.focused) {
          radius = 0.018; opacity = 1;    transparent = false;
        } else if (c.hasFocus) {
          radius = 0.011; opacity = 0.22; transparent = true;
        } else {
          radius = 0.014; opacity = 1;    transparent = false;
        }
        // Connector boots sit at each port — small dark blocks that anchor
        // the cable into the jack. The strain-relief band carries the
        // cable-type color so type can be read at the connector even though
        // the cable jacket is white.
        const connDim = (isSelected || c.focused) ? 0.038 : 0.026;
        const connBandOpacity = isSelected ? 1 : (c.focused ? 0.85 : (c.hasFocus ? 0.18 : 0.55));
        const connBandColor = isSelected ? '#ffffff' : c.color;
        const connBodyOpacity = c.hasFocus && !c.focused && !isSelected ? 0.25 : 0.9;
        return (
          <group key={c.edge.cable_id}>
            <mesh
              onClick={(e) => {
                e.stopPropagation();
                setSelected && setSelected({ kind: 'cable', id: c.edge.cable_id });
              }}
              onPointerOver={(e) => { e.stopPropagation(); document.body.style.cursor = 'pointer'; }}
              onPointerOut={() => { document.body.style.cursor = ''; }}
            >
              <tubeGeometry args={[c.curve, 40, radius, 12, false]} />
              {/* meshStandardMaterial responds to lighting — gives the tube
                  a proper rounded shading falloff so it reads as a physical
                  cable jacket instead of a flat line. Low metalness +
                  medium roughness mimics PVC. */}
              <meshStandardMaterial
                color={cableHex}
                metalness={0.08}
                roughness={0.55}
                transparent={transparent}
                opacity={opacity}
              />
            </mesh>
            {/* Connector boot at each end — body + color band */}
            {[c.startV, c.endV].map((p, i) => (
              <group key={i} position={[p.x, p.y, p.z + connDim * 0.5 + 0.003]}>
                <mesh>
                  <boxGeometry args={[connDim * 1.3, connDim * 0.9, connDim]} />
                  <meshStandardMaterial
                    color="#0a1020"
                    metalness={0.45}
                    roughness={0.55}
                    transparent
                    opacity={connBodyOpacity}
                  />
                </mesh>
                {/* Strain-relief color band on the cable side */}
                <mesh position={[0, 0, connDim * 0.5 + 0.003]}>
                  <boxGeometry args={[connDim * 1.32, connDim * 0.94, 0.008]} />
                  <meshBasicMaterial
                    color={connBandColor}
                    transparent
                    opacity={connBandOpacity}
                  />
                </mesh>
              </group>
            ))}
          </group>
        );
      })}
    </group>
  );
}

// ── Lights ─────────────────────────────────────────────────────────────────
// Symmetric setup so the rack lights uniformly — no more "half violet, half
// cyan" split. The colored rim lights are balanced with matching siblings
// across the rack centerline.
function Lights({ chassisU, ambientBoost = 1 }) {
  const topY = chassisU * U_HEIGHT / 2 + 1.2;
  return (
    <>
      {/* Generous ambient so devices read as lit, not silhouetted in shadow.
          The rack still pops because the key + rim lights are stronger.
          ambientBoost is bumped on light themes to keep dark chassis legible. */}
      <ambientLight intensity={1.05 * ambientBoost} />
      <directionalLight position={[ 6, 7,  5]} intensity={1.0} color="#f3f6ff" />
      <directionalLight position={[-6, 7,  5]} intensity={1.0} color="#f3f6ff" />
      {/* Bright key from front-above — main illumination on the faceplate */}
      <spotLight
        position={[0, topY + 4, 2.6]}
        angle={0.6}
        penumbra={0.55}
        intensity={2.6}
        distance={22}
        color="#f4f7ff"
      />
      {/* Front fills — closer to the rack so port detail reads clearly */}
      <pointLight position={[-3.5, 1.2, 4]} intensity={0.7} color="#dbe4f7" distance={14} />
      <pointLight position={[ 3.5, 1.2, 4]} intensity={0.7} color="#dbe4f7" distance={14} />
      {/* Cyan rim from above-behind — outlines the rack silhouette against
          the backdrop, same role as a stage rim light. */}
      <pointLight position={[ 0, topY - 0.5, -4.2]} intensity={1.0} color="#22d3ee" distance={11} />
      {/* Warm low backlight — soft amber kick behind the base, gives depth */}
      <pointLight position={[ 0, -topY + 2, -2.8]} intensity={0.45} color="#f59e0b" distance={10} />
    </>
  );
}

// ── Floor: lifted mid-tone with a brighter cyan grid ───────────────────────
function DataCenterFloor({ chassisU, palette }) {
  const y = -chassisU * U_HEIGHT / 2 - 0.4;
  const pal = palette || SCENE_PALETTES.dark;
  return (
    <group position={[0, y, 0]}>
      {/* Floor backing — slightly darker than bg so the rack still reads as
          the brightest element, but light enough that the grid lines and
          any reflections are visible. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[40, 40]} />
        <meshStandardMaterial color={pal.floor} metalness={0.5} roughness={0.65}
                              transparent opacity={pal.floorOpacity} />
      </mesh>
      {/* Per-rack pool of light is now painted by <RackContent>, so each
          rack in a multi-rack scene gets its own pool that travels with it. */}
      <Grid
        position={[0, 0.003, 0]}
        args={[40, 40]}
        cellSize={0.5}
        cellThickness={0.7}
        cellColor={pal.gridCell}
        sectionSize={3}
        sectionThickness={1.3}
        sectionColor={pal.gridSection}
        fadeDistance={22}
        fadeStrength={1.3}
        infiniteGrid
        followCamera={false}
      />
    </group>
  );
}

// Switches the canvas to "hand pan" mode automatically when the user is zoomed
// in past a threshold — drag pans, cursor becomes a grab hand. When zoomed
// out, drag returns to orbit. Mounts inside <Canvas> so it has access to the
// active OrbitControls (via makeDefault).
function AutoPanCursor({ panThreshold = 9 }) {
  const { camera, controls, gl } = useThree();
  const lastZoom = useRef(null);
  useFrame(() => {
    if (!controls?.target) return;
    const d = camera.position.distanceTo(controls.target);
    const zoomed = d < panThreshold;
    if (zoomed === lastZoom.current) return;
    lastZoom.current = zoomed;
    if (zoomed) {
      controls.mouseButtons.LEFT  = THREE.MOUSE.PAN;
      controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;
      controls.touches.ONE = THREE.TOUCH.PAN;
      controls.touches.TWO = THREE.TOUCH.DOLLY_ROTATE;
      gl.domElement.style.cursor = 'grab';
    } else {
      controls.mouseButtons.LEFT  = THREE.MOUSE.ROTATE;
      controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
      controls.touches.ONE = THREE.TOUCH.ROTATE;
      controls.touches.TWO = THREE.TOUCH.DOLLY_PAN;
      gl.domElement.style.cursor = '';
    }
  });
  return null;
}

// Pure layout: turn a topology JSON into per-device positions, chassis size,
// and the "has uplink shelf" flag. Module-scope so single- and multi-rack
// scenes share one source of truth.
export function computeRackLayout(topo, totalU) {
  const map    = new Map();
  const inRack = [];
  const cores  = [];
  for (const d of topo.devices) {
    const tier = tierOf(d);
    if (!tier) continue;
    if (d.in_rack) inRack.push({ d, tier });
    else           cores.push({ d, tier });
  }
  const coreCount = cores.length;
  const shelfU    = coreCount > 0 ? coreCount + SHELF_GAP : 0;
  const chassisU  = totalU + shelfU;

  for (const { d, tier } of inRack) {
    const u  = d.u_position || 1;
    const sz = d.u_size     || 1;
    const cy = uCenterY(u, sz, chassisU);
    const h  = sz * U_HEIGHT * 0.92;
    map.set(d.name, {
      uPos: u, sizeU: sz, isCore: false,
      centerY: cy,
      attach: [0, cy, FRONT_Z + 0.02],
      portMap: computePortPositions(d, h),
      tier, dev: d,
    });
  }
  cores.forEach(({ d, tier }, i) => {
    // First core sits at u = totalU + 1 + SHELF_GAP (e.g. 19.5),
    // each subsequent core stacked one U above.
    const u  = totalU + 1 + SHELF_GAP + i;
    const sz = 1;
    const cy = uCenterY(u, sz, chassisU);
    const h  = sz * U_HEIGHT * 0.92;
    map.set(d.name, {
      uPos: u, sizeU: sz, isCore: true,
      centerY: cy,
      attach: [0, cy, FRONT_Z + 0.02],
      portMap: computePortPositions(d, h),
      tier, dev: d,
    });
  });
  return { positions: map, chassisU, hasShelf: coreCount > 0 };
}

// One rack's scene contents — chassis + devices + cables + neighbor ghosts —
// inside a positioned <group>. Used twice: directly inside this file's
// single-rack <Canvas>, and from MultiRackTopologyPage.jsx which renders
// N of these side-by-side in one shared <Canvas>.
export function RackContent({
  topo, xOffset = 0,
  selected, setSelected, heatmap, freePctByDevice,
  traceMode, traceA, traceB, tracePathSet, traceEdgeKeys,
  onHoverDevice,
  showNeighbors = true,
  showFloorPool = true,
  // World-Y of the shared scene floor. When a multi-rack scene packs
  // several RackContent instances together, every rack's bottom should
  // land on the SAME floor — but each rack's chassisU may differ. By
  // default we don't shift (single-rack case where the floor is sized
  // to this rack); when a parent scene passes in floorY, we compute a
  // group-Y offset so rack-bottom = floorY + clearance regardless of
  // chassisU.
  floorY = null,
  // Optional theme palette override. When omitted, uses the live theme.
  palette = null,
}) {
  const livePalette = useScenePalette();
  const pal = palette || livePalette;
  const totalU = topo.u_size || 18;
  const traceActive = traceMode && tracePathSet && tracePathSet.size > 0;
  const [leftOpen,  setLeftOpen]  = useState(false);
  const [rightOpen, setRightOpen] = useState(false);

  const { positions, chassisU, hasShelf } = useMemo(
    () => computeRackLayout(topo, totalU), [topo, totalU]);

  // When a device is selected, mark which of its ports actually have cables.
  const highlightedPortsByDevice = useMemo(() => {
    const m = new Map();
    if (selected?.kind !== 'node') return m;
    const sel = selected.id;
    for (const e of topo.edges) {
      if (e.src.device === sel) {
        if (!m.has(sel)) m.set(sel, new Set());
        m.get(sel).add(e.src.port);
        if (!m.has(e.dst.device)) m.set(e.dst.device, new Set());
        m.get(e.dst.device).add(e.dst.port);
      } else if (e.dst.device === sel) {
        if (!m.has(sel)) m.set(sel, new Set());
        m.get(sel).add(e.dst.port);
        if (!m.has(e.src.device)) m.set(e.src.device, new Set());
        m.get(e.src.device).add(e.src.port);
      }
    }
    return m;
  }, [selected, topo]);

  const isDimmed = (n) => {
    if (traceActive) return !tracePathSet.has(n);
    if (traceMode && (traceA || traceB)) return n !== traceA && n !== traceB;
    return selected?.kind === 'node' && selected.id !== n;
  };

  // Compute the Y-shift this rack's group needs so its chassis BOTTOM
  // lands on the shared floor. With chassis centered at local y=0 and
  // half-height = chassisU * U_HEIGHT / 2, the bottom of this rack in
  // world coords = groupY - chassisU * U_HEIGHT / 2. We want that to
  // equal floorY + 0.4 (the clearance the single-rack scene already uses).
  const FLOOR_CLEARANCE = 0.4;
  const groupY = floorY != null
    ? floorY + FLOOR_CLEARANCE + chassisU * U_HEIGHT / 2
    : 0;

  // Floor pool is in *local* coords. After the group's Y shift it lands
  // at world y = groupY + poolY. We want that = floorY + 0.003. Solve:
  //   poolY = floorY - groupY + 0.003
  // For the single-rack case (floorY=null, groupY=0) this collapses to
  // the original formula -chassisU*U_HEIGHT/2 - 0.4 + 0.003.
  const poolY = floorY != null
    ? floorY - groupY + 0.003
    : -chassisU * U_HEIGHT / 2 - 0.4 + 0.003;

  return (
    <group position={[xOffset, groupY, 0]}>
      <RackChassis
        totalU={totalU}
        chassisU={chassisU}
        rackName={topo.rackName}
        hasShelf={hasShelf}
        leftOpen={leftOpen}
        rightOpen={rightOpen}
        toggleLeft={() => setLeftOpen(v => !v)}
        toggleRight={() => setRightOpen(v => !v)}
      />

      {Array.from(positions.entries()).map(([name, p]) => {
        const freePct = freePctByDevice?.get(name);
        const color   = heatmap ? capacityColor(freePct) : TIER_COLOR[p.tier];
        const dimmed  = isDimmed(name);
        const isTraceEnd = traceMode && (name === traceA || name === traceB);
        const isSel   = isTraceEnd
                        || (traceActive && tracePathSet.has(name))
                        || (selected?.kind === 'node' && selected.id === name);
        const hlPorts = highlightedPortsByDevice.get(name) || null;
        return (
          <DeviceBox
            key={name}
            dev={p.dev} uPos={p.uPos} sizeU={p.sizeU} chassisU={chassisU}
            color={color} dimmed={dimmed} selected={isSel} isCore={p.isCore}
            portMap={p.portMap} highlightedPorts={hlPorts}
            onClick={() => setSelected({ kind: 'node', id: name })}
            onHoverIn={() => onHoverDevice && onHoverDevice({ name, dev: p.dev, freePct, tier: p.tier })}
            onHoverOut={() => onHoverDevice && onHoverDevice(null)}
          />
        );
      })}

      <PortCables
        selected={selected}
        setSelected={setSelected}
        topo={topo}
        positions={positions}
        traceEdgeKeys={traceEdgeKeys}
        cableJacketColor={pal.cableJacket}
      />

      {showNeighbors && <NeighborRacks topo={topo} chassisU={chassisU} />}

      {/* Per-rack pool of light on the floor — anchors each rack visually
          even when several share one Canvas in the multi-rack view. */}
      {showFloorPool && (
        <mesh position={[0, poolY, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <circleGeometry args={[3.6, 48]} />
          <meshBasicMaterial color={pal.poolColor} transparent opacity={pal.poolOpacity} />
        </mesh>
      )}
    </group>
  );
}

export default function TopologyScene3D(props) {
  const { topo, setSelected } = props;
  const totalU = topo.u_size || 18;
  // Compute chassisU here (independently of RackContent) so we can size
  // camera + floor + lights to it. computeRackLayout is cheap.
  const { chassisU } = useMemo(
    () => computeRackLayout(topo, totalU), [topo, totalU]);

  // Live theme palette — re-renders the Canvas when the user toggles theme
  // so the bg/floor/cable colors swap without a hard reload.
  const palette = useScenePalette();

  // Camera framing — fits the entire chassis with margin, using vertical fov.
  const sceneH    = chassisU * U_HEIGHT + 0.8;
  const fovRad    = (FOV_DEG * Math.PI) / 180;
  const baseDist  = (sceneH * 1.05) / (2 * Math.tan(fovRad / 2));
  const camDist   = Math.max(7.5, baseDist);
  const cameraInit = [camDist * 0.34, camDist * 0.10, camDist * 0.94];
  const camTarget  = [0, 0, 0];

  return (
    <Canvas
      shadows={false}
      camera={{ position: cameraInit, fov: FOV_DEG, near: 0.1, far: 120 }}
      gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
      dpr={[1, 2]}
      onPointerMissed={() => setSelected(null)}
      style={{ touchAction: 'none' }}
    >
      <color attach="background" args={[palette.bg]} />
      <fog  attach="fog"        args={[palette.fog, 24, 52]} />
      <Environment preset={palette.environment} background={false} environmentIntensity={palette.envIntensity} />
      <Lights chassisU={chassisU} ambientBoost={palette.ambientBoost} />
      <DataCenterFloor chassisU={chassisU} palette={palette} />

      {/* Single-rack: don't double-paint the floor pool — RackContent's
          per-rack pool already provides the same visual. */}
      <RackContent {...props} xOffset={0} showFloorPool={true} palette={palette} />

      <OrbitControls
        target={camTarget}
        enablePan
        enableDamping
        dampingFactor={0.08}
        minDistance={4}
        maxDistance={28}
        minPolarAngle={0.25}
        maxPolarAngle={Math.PI - 0.25}
        makeDefault
      />
      <AutoPanCursor />
    </Canvas>
  );
}

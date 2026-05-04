import { useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, Text, QuadraticBezierLine, Grid, Environment } from '@react-three/drei';
import * as THREE from 'three';

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
const U_HEIGHT   = 0.42;
const DEV_DEPTH  = 1.4;
const DEV_WIDTH  = 3.0;
const FRAME_THK  = 0.07;
const FRONT_Z    = DEV_DEPTH / 2;
const FOV_DEG    = 42;
const SHELF_GAP  = 0.5;   // U-units of empty space between top of rack and uplink shelf

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
  const bandColors = ['#22d3ee', '#fbbf24', '#a78bfa'];
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

  // Dark anodized aluminum — high metalness so the IBL probe still gives the
  // chassis a polished sheen instead of flat-black plastic.
  const bodyMat = (
    <meshStandardMaterial
      color="#0e1630"
      metalness={0.9}
      roughness={0.28}
      emissive="#1a2547"
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
function cableColor(cable_type) {
  const t = (cable_type || '').toLowerCase();
  if (t.includes('fiber') || t.includes('mm') || t.includes('sm')) return '#fbbf24';
  if (t.includes('dac')   || t.includes('twinax'))                 return '#a78bfa';
  if (t.startsWith('cat'))                                          return '#22d3ee';
  return '#60a5fa';
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

  // Tier-tinted body + faceplate colors (memoized so we don't churn allocations).
  // Mid-tone bases + stronger lerp so devices read as actually-tier-colored
  // metal in a lit room — not nearly-black silhouettes.
  const { bodyColor, faceColor } = useMemo(() => {
    const tier  = new THREE.Color(color);
    const bBase = new THREE.Color('#1c2a4a');
    const fBase = new THREE.Color('#26345e');
    return {
      bodyColor: bBase.clone().lerp(tier, 0.22),
      faceColor: fBase.clone().lerp(tier, 0.40),
    };
  }, [color]);

  return (
    <group position={[0, y, 0]}>
      {/* Body — dark anodized with a hint of tier color */}
      <mesh
        onClick={(e) => { e.stopPropagation(); onClick && onClick(); }}
        onPointerOver={(e) => { e.stopPropagation(); onHoverIn && onHoverIn(); }}
        onPointerOut={(e)  => { onHoverOut && onHoverOut(); }}
      >
        <boxGeometry args={[w, h, d]} />
        <meshStandardMaterial
          ref={matRef}
          color={bodyColor}
          metalness={0.7}
          roughness={0.42}
          emissive={color}
          emissiveIntensity={baseEmissive * 0.45}
          transparent
          opacity={opacity}
        />
      </mesh>

      {/* Faceplate — tier-tinted brushed-metal panel, raised proud of the body */}
      <mesh position={[0, 0, faceZ]}>
        <boxGeometry args={[faceW, faceH, FACE_DEPTH]} />
        <meshStandardMaterial
          color={faceColor}
          metalness={0.55}
          roughness={0.45}
          emissive={color}
          emissiveIntensity={selected ? 0.18 : 0.08}
          transparent
          opacity={opacity}
        />
      </mesh>

      {/* Brushed-metal highlight — bright thin line across the top of the face,
          fakes a directional sheen and gives the device a premium feel */}
      <mesh position={[0, faceH/2 - 0.012, d/2 + FACE_DEPTH + 0.002]}>
        <planeGeometry args={[faceW * 0.96, 0.006]} />
        <meshBasicMaterial color="#e6f0ff" transparent
                           opacity={dimmed ? 0.10 : 0.32} />
      </mesh>

      {/* Soft tier-color halo behind faceplate edges (rim) */}
      <mesh position={[0, 0, d/2 + 0.001]}>
        <planeGeometry args={[w * 0.998, h * 0.97]} />
        <meshBasicMaterial color={color} transparent
                           opacity={dimmed ? 0.10 : (selected ? 0.42 : 0.18)} />
      </mesh>

      {/* Top + bottom tier-color trim lines on the faceplate edges */}
      <mesh position={[0, faceH/2 - 0.005, d/2 + FACE_DEPTH + 0.002]}>
        <planeGeometry args={[faceW * 0.985, 0.012]} />
        <meshBasicMaterial color={color} transparent
                           opacity={dimmed ? 0.30 : (selected ? 1 : 0.70)} />
      </mesh>
      <mesh position={[0, -faceH/2 + 0.005, d/2 + FACE_DEPTH + 0.002]}>
        <planeGeometry args={[faceW * 0.985, 0.012]} />
        <meshBasicMaterial color={color} transparent
                           opacity={dimmed ? 0.30 : (selected ? 1 : 0.70)} />
      </mesh>

      {/* Vertical brand stripe — wider, brighter, the focal "tier badge" */}
      <mesh position={[-w/2 + 0.045, 0, d/2 + FACE_DEPTH + 0.003]}>
        <planeGeometry args={[0.045, h * 0.78]} />
        <meshBasicMaterial color={color} transparent
                           opacity={dimmed ? 0.35 : (selected ? 1 : 0.95)} />
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
function PortCables({ selected, topo, positions, traceEdgeKeys, setSelected }) {
  const groupRef = useRef();

  useFrame((state) => {
    if (!groupRef.current) return;
    const t = state.clock.elapsedTime;
    groupRef.current.position.z = 0.02 + Math.sin(t * 1.4) * 0.012;
  });

  const cables = useMemo(() => {
    const out = [];
    const includeAll  = traceEdgeKeys && traceEdgeKeys.size > 0;
    const selDev      = selected?.kind === 'node' ? selected.id : null;
    // When a single cable is selected, render the whole trunk between the
    // two devices it spans — so the user sees its siblings + the chosen one.
    const selCable    = selected?.kind === 'cable'
      ? topo.edges.find(e => e.cable_id === selected.id)
      : null;
    const trunkPair   = selCable
      ? [selCable.src.device, selCable.dst.device].sort().join('::')
      : null;
    if (!includeAll && !selDev && !trunkPair) return out;

    for (const e of topo.edges) {
      const a = e.src.device, b = e.dst.device;
      const key = a < b ? `${a}::${b}` : `${b}::${a}`;
      const inTrace = includeAll && traceEdgeKeys.has(key);
      const inSel   = !includeAll && (a === selDev || b === selDev);
      const inTrunk = trunkPair && key === trunkPair;
      if (!inTrace && !inSel && !inTrunk) continue;

      const srcDev = positions.get(a);
      const dstDev = positions.get(b);
      if (!srcDev || !dstDev) continue;

      const srcRel = srcDev.portMap?.get(e.src.port);
      const dstRel = dstDev.portMap?.get(e.dst.port);
      if (!srcRel || !dstRel) continue;

      const startV = new THREE.Vector3(srcRel[0], srcDev.centerY + srcRel[1], FRONT_Z + 0.025);
      const endV   = new THREE.Vector3(dstRel[0], dstDev.centerY + dstRel[1], FRONT_Z + 0.025);
      const mid    = startV.clone().add(endV).multiplyScalar(0.5);
      const dy = Math.abs(endV.y - startV.y);
      const jitter = hash01(e.cable_id) * 0.6 - 0.3;
      mid.z += 0.55 + Math.min(2.2, dy * 0.5) + jitter;
      mid.x += (endV.x - startV.x) * 0.05 + (hash01(e.cable_id + 'x') - 0.5) * 0.18;

      const curve = new THREE.QuadraticBezierCurve3(startV, mid, endV);
      out.push({
        edge: e, curve, color: cableColor(e.cable_type),
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
        const radius = isSelected ? 0.026 : 0.013;
        const color  = isSelected ? '#ffffff' : c.color;
        const opacity = isSelected ? 1 : (selCableId ? 0.45 : 0.85);
        return (
          <mesh
            key={c.edge.cable_id}
            onClick={(e) => {
              e.stopPropagation();
              setSelected && setSelected({ kind: 'cable', id: c.edge.cable_id });
            }}
            onPointerOver={(e) => { e.stopPropagation(); document.body.style.cursor = 'pointer'; }}
            onPointerOut={() => { document.body.style.cursor = ''; }}
          >
            <tubeGeometry args={[c.curve, 18, radius, 8, false]} />
            <meshBasicMaterial color={color} transparent opacity={opacity} />
          </mesh>
        );
      })}
    </group>
  );
}

// ── Lights ─────────────────────────────────────────────────────────────────
// Symmetric setup so the rack lights uniformly — no more "half violet, half
// cyan" split. The colored rim lights are balanced with matching siblings
// across the rack centerline.
function Lights({ chassisU }) {
  const topY = chassisU * U_HEIGHT / 2 + 1.2;
  return (
    <>
      <ambientLight intensity={0.85} />
      <directionalLight position={[ 6, 7,  5]} intensity={0.7} color="#e8efff" />
      <directionalLight position={[-6, 7,  5]} intensity={0.7} color="#e8efff" />
      {/* Bright key from above — clearly lights the front of the rack */}
      <spotLight
        position={[0, topY + 4, 2.6]}
        angle={0.6}
        penumbra={0.6}
        intensity={1.9}
        distance={22}
        color="#f0f4ff"
      />
      {/* Cool fill across both sides — same color/intensity, no split */}
      <pointLight position={[-5, 1.2, 4]} intensity={0.45} color="#cbd5f5" distance={14} />
      <pointLight position={[ 5, 1.2, 4]} intensity={0.45} color="#cbd5f5" distance={14} />
      {/* Subtle warm accent from behind so the chassis silhouette pops */}
      <pointLight position={[0, topY - 1, -3]} intensity={0.40} color="#f59e0b" distance={12} />
    </>
  );
}

// ── Floor: lifted mid-tone with a brighter cyan grid ───────────────────────
function DataCenterFloor({ chassisU }) {
  const y = -chassisU * U_HEIGHT / 2 - 0.4;
  return (
    <group position={[0, y, 0]}>
      {/* Lifted backing — mid navy with a violet tint so the grid pops */}
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[40, 40]} />
        <meshStandardMaterial color="#0e1735" metalness={0.5} roughness={0.7}
                              transparent opacity={0.88} />
      </mesh>
      <Grid
        position={[0, 0.001, 0]}
        args={[40, 40]}
        cellSize={0.5}
        cellThickness={0.7}
        cellColor="#3a5a8c"
        sectionSize={3}
        sectionThickness={1.4}
        sectionColor="#67e8f9"
        fadeDistance={22}
        fadeStrength={1.2}
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

export default function TopologyScene3D({
  topo, selected, setSelected, heatmap, freePctByDevice,
  traceMode, traceA, traceB, tracePathSet, traceEdgeKeys,
  onHoverDevice,
}) {
  const totalU = topo.u_size || 18;
  const traceActive = traceMode && tracePathSet && tracePathSet.size > 0;
  const [leftOpen,  setLeftOpen]  = useState(false);
  const [rightOpen, setRightOpen] = useState(false);

  // Layout: in-rack devices at their actual U positions, cores stacked above
  // a SHELF_GAP separator. The chassis grows to enclose both regions.
  const { positions, chassisU, hasShelf } = useMemo(() => {
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
  }, [topo, totalU]);

  // When a device is selected, mark which of its ports actually have cables
  // (so PortGrid can light them up — gives the "ports + cables exact" feel).
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
      <color attach="background" args={['#0c1530']} />
      <fog  attach="fog"        args={['#0c1530', 16, 44]} />

      {/* Static image-based lighting — gives the metal chassis real specular
          reflections so it looks polished, not flat. Not animated. */}
      <Environment preset="warehouse" background={false} environmentIntensity={0.55} />

      <Lights chassisU={chassisU} />

      <DataCenterFloor chassisU={chassisU} />

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

      {/* Devices (in-rack + uplink shelf, all inside the enclosure) */}
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

      {/* Click-driven port-accurate cables — every real cable, src-port → dst-port */}
      <PortCables
        selected={selected}
        setSelected={setSelected}
        topo={topo}
        positions={positions}
        traceEdgeKeys={traceEdgeKeys}
      />

      {/* Optional neighbor-rack ghosts when topology carries cross-rack data */}
      <NeighborRacks topo={topo} chassisU={chassisU} />

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

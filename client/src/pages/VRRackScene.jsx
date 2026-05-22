import { useEffect, useMemo, useRef, useState } from 'react';
import { useThree, useLoader } from '@react-three/fiber';
import { Environment, Grid } from '@react-three/drei';
import * as THREE from 'three';
import VRInfoPanel from './VRInfoPanel.jsx';
import { apiUrl } from '../utils/api';

// ── constants ──────────────────────────────────────────────────────────────
const RACK_HEIGHT = 12;              // world-units (tall rack for photo)
const BG_COLOR   = '#0e1830';

const TYPE_COLORS = {
  Switch:        '#00e5ff',
  Router:        '#00e5ff',
  Server:        '#a855f6',
  Firewall:      '#ef4444',
  'Patch Panel': '#60a5fa',
  UPS:           '#f59e0b',
  PDU:           '#f59e0b',
  Controller:    '#22d3ee',
};

function colorFor(cls) {
  if (!cls) return '#94a3b8';
  for (const [k, v] of Object.entries(TYPE_COLORS)) {
    if (cls.toLowerCase().includes(k.toLowerCase())) return v;
  }
  return '#94a3b8';
}

// ── exported helper: compute a good camera for this rack ────────────────
export function computeVRCamera(aspect) {
  const d = RACK_HEIGHT * 0.95;
  return {
    position: [0, RACK_HEIGHT * 0.45, d],
    fov: 42,
    target: [0, RACK_HEIGHT * 0.45, 0],
    minDist: 2,
    maxDist: d * 3,
  };
}

// ── Rack enclosure ──────────────────────────────────────────────────────
function RackEnclosure({ rackW, rackH, rackD }) {
  const postW = 0.15;
  const halfW = rackW / 2;
  const halfD = rackD / 2;
  const yCenter = rackH / 2;

  const bodyMat = (
    <meshStandardMaterial
      color="#1a2744"
      metalness={0.85}
      roughness={0.34}
      emissive="#1e2d50"
      emissiveIntensity={0.08}
    />
  );

  const darkMetal = (
    <meshStandardMaterial
      color="#0c1428"
      metalness={0.7}
      roughness={0.45}
    />
  );

  const post = (x, z, key) => (
    <mesh key={key} position={[x, yCenter, z]}>
      <boxGeometry args={[postW, rackH, postW]} />
      {bodyMat}
    </mesh>
  );

  // Vent slats on top
  const VENT_COUNT = 6;
  const ventStripW = rackW * 0.6;
  const ventGap = ventStripW / VENT_COUNT;

  return (
    <group>
      {/* 4 corner posts */}
      {post(-halfW, -halfD, 'p-fl')}
      {post( halfW, -halfD, 'p-fr')}
      {post(-halfW,  halfD, 'p-bl')}
      {post( halfW,  halfD, 'p-br')}

      {/* Top plate */}
      <mesh position={[0, rackH + 0.03, 0]}>
        <boxGeometry args={[rackW + 0.08, 0.06, rackD + 0.06]} />
        {bodyMat}
      </mesh>
      {/* Bottom plate */}
      <mesh position={[0, -0.03, 0]}>
        <boxGeometry args={[rackW + 0.08, 0.06, rackD + 0.06]} />
        {bodyMat}
      </mesh>

      {/* Base kick plate */}
      <mesh position={[0, -0.12, 0]}>
        <boxGeometry args={[rackW + 0.16, 0.12, rackD + 0.10]} />
        <meshStandardMaterial color="#080d1f" metalness={0.6} roughness={0.55} />
      </mesh>

      {/* Back panel — solid metal */}
      <mesh position={[0, yCenter, -halfD + 0.015]}>
        <boxGeometry args={[rackW - 0.04, rackH - 0.04, 0.03]} />
        {darkMetal}
      </mesh>

      {/* Left side panel — solid metal */}
      <mesh position={[-halfW + 0.015, yCenter, 0]}>
        <boxGeometry args={[0.03, rackH - 0.04, rackD - 0.04]} />
        {darkMetal}
      </mesh>

      {/* Right side panel — solid metal */}
      <mesh position={[halfW - 0.015, yCenter, 0]}>
        <boxGeometry args={[0.03, rackH - 0.04, rackD - 0.04]} />
        {darkMetal}
      </mesh>

      {/* Top vent slats */}
      <group position={[0, rackH + 0.06 + 0.001, 0]}>
        {Array.from({ length: VENT_COUNT }).map((_, i) => {
          const x = -ventStripW / 2 + ventGap / 2 + i * ventGap;
          return (
            <mesh key={`vent-${i}`} position={[x, 0, rackD / 4]}>
              <boxGeometry args={[ventGap * 0.42, 0.02, rackD * 0.3]} />
              <meshStandardMaterial color="#04081a" metalness={0.4} roughness={0.85} />
            </mesh>
          );
        })}
      </group>

      {/* Cable management trunks (rear corners) */}
      {[-1, 1].map(side => (
        <mesh key={`cable-${side}`}
              position={[side * (halfW - 0.06), yCenter, -halfD + 0.08]}>
          <cylinderGeometry args={[0.06, 0.06, rackH - 0.2, 12]} />
          <meshStandardMaterial color="#0f1a30" metalness={0.5} roughness={0.6} />
        </mesh>
      ))}
    </group>
  );
}

// ── Device overlay (colored border line) ─────────────────────────────────
function DeviceOverlay({ device, index, rackW, rackH, imgW, imgH,
                         hovered, selected, onHover, onSelect }) {
  const bb = normalizeBbox(device);
  if (!bb) return null;
  const [bx, by, bw, bh] = bb;

  // Map image-pixel bbox → world coords on the front face
  const worldX = ((bx + bw / 2) / imgW - 0.5) * rackW;
  const worldY = (1 - (by + bh / 2) / imgH) * rackH;
  const worldW = (bw / imgW) * rackW;
  const worldH = (bh / imgH) * rackH;

  const accent = colorFor(device.class_name || device.class || '');
  const show = hovered || selected;

  if (!show) {
    // Invisible clickable plane for hover/click detection
    return (
      <mesh
        position={[worldX, worldY, rackW * 0.5 + 0.02]}
        onPointerOver={(e) => { e.stopPropagation(); onHover(index); }}
        onPointerOut={(e) => { e.stopPropagation(); onHover(null); }}
        onClick={(e) => { e.stopPropagation(); onSelect(index); }}
      >
        <planeGeometry args={[worldW, worldH]} />
        <meshBasicMaterial transparent opacity={0} side={THREE.DoubleSide} />
      </mesh>
    );
  }

  // Colored border lines using 4 thin box edges
  const thickness = 0.02;
  const z = rackW * 0.5 + 0.02;
  const col = new THREE.Color(accent);

  return (
    <group
      onPointerOver={(e) => { e.stopPropagation(); onHover(index); }}
      onPointerOut={(e) => { e.stopPropagation(); onHover(null); }}
      onClick={(e) => { e.stopPropagation(); onSelect(index); }}
    >
      {/* Top edge */}
      <mesh position={[worldX, worldY + worldH / 2, z]}>
        <boxGeometry args={[worldW + thickness, thickness, thickness]} />
        <meshBasicMaterial color={col} />
      </mesh>
      {/* Bottom edge */}
      <mesh position={[worldX, worldY - worldH / 2, z]}>
        <boxGeometry args={[worldW + thickness, thickness, thickness]} />
        <meshBasicMaterial color={col} />
      </mesh>
      {/* Left edge */}
      <mesh position={[worldX - worldW / 2, worldY, z]}>
        <boxGeometry args={[thickness, worldH, thickness]} />
        <meshBasicMaterial color={col} />
      </mesh>
      {/* Right edge */}
      <mesh position={[worldX + worldW / 2, worldY, z]}>
        <boxGeometry args={[thickness, worldH, thickness]} />
        <meshBasicMaterial color={col} />
      </mesh>

      {/* Invisible fill for easier interaction */}
      <mesh position={[worldX, worldY, z - 0.01]}>
        <planeGeometry args={[worldW, worldH]} />
        <meshBasicMaterial transparent opacity={0} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

// ── FitToViewport: auto-position camera to see the full rack ─────────────
function FitToViewport({ rackW, rackH }) {
  const { camera } = useThree();
  useEffect(() => {
    const cam = computeVRCamera();
    camera.position.set(...cam.position);
    camera.fov = cam.fov;
    camera.updateProjectionMatrix();
  }, [camera, rackW, rackH]);
  return null;
}

// ── Datacenter lighting ─────────────────────────────────────────────────
function DatacenterLights({ rackH }) {
  return (
    <>
      <ambientLight intensity={0.45} />
      <directionalLight position={[5, rackH + 4, 6]} intensity={0.75} />
      <directionalLight position={[-5, rackH + 2, -4]} intensity={0.45} />
      <spotLight
        position={[0, rackH + 6, 2]}
        angle={0.4}
        penumbra={0.6}
        intensity={1.2}
        target-position={[0, rackH * 0.5, 0]}
      />
      {/* Rim light from rear */}
      <pointLight position={[0, rackH * 0.6, -6]} intensity={0.3} color="#4a7fff" />
      {/* Accent from side */}
      <pointLight position={[6, rackH * 0.3, 0]} intensity={0.2} color="#6366f1" />
    </>
  );
}

// ── Main scene component ────────────────────────────────────────────────
export default function VRRackScene({ topo, scanData }) {
  const [hoveredIdx, setHoveredIdx]   = useState(null);
  const [selectedIdx, setSelectedIdx] = useState(null);

  const rackId = scanData?.rackId || '';
  const ext    = scanData?.originalExt || 'jpg';
  const devices = scanData?.devices || [];

  // Load rack photo texture
  const imageUrl = apiUrl(`/outputs/${rackId}/original_image.${ext}`);
  const tex = useLoader(THREE.TextureLoader, imageUrl);
  useMemo(() => { tex.colorSpace = THREE.SRGBColorSpace; }, [tex]);

  const imgW = tex.image?.width  || 1;
  const imgH = tex.image?.height || 1;
  const aspect = imgW / imgH;

  const rackH = RACK_HEIGHT;
  const rackW = rackH * aspect;
  const rackD = Math.max(2.5, rackW * 1.1);

  const selectedDevice = selectedIdx != null ? devices[selectedIdx] : null;

  // Info panel position: float next to the selected device
  const infoPanelPos = useMemo(() => {
    if (!selectedDevice) return [0, 0, 0];
    const bb = normalizeBbox(selectedDevice);
    if (!bb) return [rackW * 0.5 + 1.5, rackH * 0.5, rackW * 0.5 + 0.5];
    const [bx, by, bw, bh] = bb;
    const worldX = ((bx + bw / 2) / imgW - 0.5) * rackW;
    const worldY = (1 - (by + bh / 2) / imgH) * rackH;
    return [worldX + rackW * 0.35, worldY, rackW * 0.5 + 0.8];
  }, [selectedDevice, rackW, rackH, imgW, imgH]);

  return (
    <>
      <color attach="background" args={[BG_COLOR]} />
      <fog attach="fog" args={[BG_COLOR, rackH * 1.5, rackH * 4]} />

      <DatacenterLights rackH={rackH} />
      <Environment preset="warehouse" environmentIntensity={0.55} />

      <FitToViewport rackW={rackW} rackH={rackH} />

      {/* Rack enclosure */}
      <RackEnclosure rackW={rackW + 0.3} rackH={rackH} rackD={rackD} />

      {/* Rack photo on front face */}
      <mesh position={[0, rackH / 2, (rackW + 0.3) / 2 + 0.005]}>
        <planeGeometry args={[rackW, rackH]} />
        <meshBasicMaterial map={tex} toneMapped={false} />
      </mesh>

      {/* Device bounding box overlays */}
      {devices.map((dev, i) => (
        <DeviceOverlay
          key={`dev-${i}`}
          device={dev}
          index={i}
          rackW={rackW}
          rackH={rackH}
          imgW={imgW}
          imgH={imgH}
          hovered={hoveredIdx === i}
          selected={selectedIdx === i}
          onHover={setHoveredIdx}
          onSelect={(idx) => setSelectedIdx(prev => prev === idx ? null : idx)}
        />
      ))}

      {/* Info panel for selected device */}
      {selectedDevice && (
        <VRInfoPanel
          device={selectedDevice}
          position={infoPanelPos}
          onClose={() => setSelectedIdx(null)}
        />
      )}

      {/* Floor plane with grid */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.13, 0]}>
        <planeGeometry args={[80, 80]} />
        <meshStandardMaterial color="#080d1f" roughness={0.9} />
      </mesh>

      <Grid
        position={[0, -0.12, 0]}
        args={[60, 60]}
        cellSize={1}
        cellThickness={0.6}
        cellColor="#1e3a6a"
        sectionSize={5}
        sectionThickness={1.2}
        sectionColor="#2e4a78"
        fadeDistance={30}
        fadeStrength={1.5}
        infiniteGrid
      />

      {/* Pool of light under the rack */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.11, rackD * 0.15]}>
        <circleGeometry args={[Math.max(rackW, 3) * 1.2, 48]} />
        <meshBasicMaterial color="#1d3a72" transparent opacity={0.18} />
      </mesh>
    </>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────
function normalizeBbox(d) {
  if (d?.bbox && typeof d.bbox === 'object' && !Array.isArray(d.bbox) &&
      'x' in d.bbox && 'y' in d.bbox && 'w' in d.bbox && 'h' in d.bbox) {
    const a = [d.bbox.x, d.bbox.y, d.bbox.w, d.bbox.h].map(Number);
    return a.every(Number.isFinite) ? a : null;
  }
  if (Array.isArray(d?.bbox) && d.bbox.length === 4) {
    const a = d.bbox.map(Number);
    return a.every(Number.isFinite) ? a : null;
  }
  if (Array.isArray(d?.box) && d.box.length === 4) {
    const [x1, y1, x2, y2] = d.box.map(Number);
    if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
    return [x1, y1, x2 - x1, y2 - y1];
  }
  return null;
}

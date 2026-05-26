import { Billboard, Text } from '@react-three/drei';
import * as THREE from 'three';

const TYPE_COLORS = {
  Switch:      '#00e5ff',
  Router:      '#00e5ff',
  Server:      '#a855f6',
  Firewall:    '#ef4444',
  'Patch Panel': '#60a5fa',
  UPS:         '#f59e0b',
  PDU:         '#f59e0b',
  Controller:  '#22d3ee',
};

function colorFor(cls) {
  if (!cls) return '#94a3b8';
  for (const [k, v] of Object.entries(TYPE_COLORS)) {
    if (cls.toLowerCase().includes(k.toLowerCase())) return v;
  }
  return '#94a3b8';
}

export default function VRInfoPanel({ device, position, onClose }) {
  if (!device) return null;

  const accent = colorFor(device.class_name || device.class || '');
  const name = device.name || 'Unknown Device';
  const cls  = device.class_name || device.class || 'Device';
  const uPos = device.u_position ? `U${device.u_position}` : '';
  const line2 = [cls, uPos].filter(Boolean).join(' \u00B7 ');
  const vendor = device.vendor || '';
  const model  = device.model  || '';
  const line3  = [vendor, model].filter(Boolean).join(' ') || '';

  const panelW = 1.8;
  const panelH = 1.0;
  const barW   = 0.045;

  return (
    <Billboard position={position} follow lockX={false} lockY={false} lockZ={false}>
      <group>
        {/* Dark background panel */}
        <mesh position={[0, 0, -0.001]}>
          <planeGeometry args={[panelW, panelH]} />
          <meshBasicMaterial color="#0c1225" transparent opacity={0.92} side={THREE.DoubleSide} />
        </mesh>

        {/* Border */}
        <mesh position={[0, 0, -0.0005]}>
          <planeGeometry args={[panelW + 0.02, panelH + 0.02]} />
          <meshBasicMaterial color="#1e293b" transparent opacity={0.8} side={THREE.DoubleSide} />
        </mesh>

        {/* Colored accent bar on left edge */}
        <mesh position={[-panelW / 2 + barW / 2, 0, 0.001]}>
          <planeGeometry args={[barW, panelH - 0.04]} />
          <meshBasicMaterial color={accent} side={THREE.DoubleSide} />
        </mesh>

        {/* Device name */}
        <Text
          position={[-panelW / 2 + barW + 0.1, panelH / 2 - 0.2, 0.002]}
          fontSize={0.12}
          color={accent}
          anchorX="left"
          anchorY="middle"
          fontWeight="bold"
          maxWidth={panelW - barW - 0.3}
        >
          {name}
        </Text>

        {/* Class + U position */}
        <Text
          position={[-panelW / 2 + barW + 0.1, panelH / 2 - 0.4, 0.002]}
          fontSize={0.09}
          color="#94a3b8"
          anchorX="left"
          anchorY="middle"
          maxWidth={panelW - barW - 0.3}
        >
          {line2}
        </Text>

        {/* Vendor / Model */}
        {line3 && (
          <Text
            position={[-panelW / 2 + barW + 0.1, panelH / 2 - 0.58, 0.002]}
            fontSize={0.08}
            color="#64748b"
            anchorX="left"
            anchorY="middle"
            maxWidth={panelW - barW - 0.3}
          >
            {line3}
          </Text>
        )}

        {/* Close button */}
        <group position={[panelW / 2 - 0.14, panelH / 2 - 0.14, 0.002]}
               onClick={(e) => { e.stopPropagation(); onClose(); }}>
          <mesh>
            <circleGeometry args={[0.09, 24]} />
            <meshBasicMaterial color="#1e293b" side={THREE.DoubleSide} />
          </mesh>
          <Text fontSize={0.1} color="#94a3b8" anchorX="center" anchorY="middle"
                position={[0, 0, 0.001]}>
            {'\u00D7'}
          </Text>
        </group>
      </group>
    </Billboard>
  );
}

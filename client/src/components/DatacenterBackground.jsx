import { useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { RoundedBox } from '@react-three/drei';

/* DatacenterBackground — a full-screen ambient 3D layer of glowing
   datacenter props (mini racks, switches, data nodes) drifting behind
   the page content. Visible but soft. Slow Y-rotation + a faint
   horizontal drift only — NO vertical (up/down) motion.
   Fixed / transparent / pointer-events:none. */

function FloatItem({ position, scale = 1, phase = 0, kind, accent }) {
  const ref = useRef();
  useFrame((s) => {
    if (!ref.current) return;
    const t = s.clock.elapsedTime;
    // horizontal drift + slow turn ONLY — y stays fixed
    ref.current.position.x = position[0] + Math.sin(t * 0.12 + phase) * 0.35;
    ref.current.rotation.y = phase + t * 0.13;
  });
  const body = '#1b2433';
  return (
    <group ref={ref} position={position} scale={scale}>
      {kind === 'node' ? (
        <mesh>
          <octahedronGeometry args={[0.42, 0]} />
          <meshStandardMaterial color={accent} emissive={accent}
            emissiveIntensity={2.1} toneMapped={false}
            transparent opacity={0.9} />
        </mesh>
      ) : kind === 'switch' ? (
        <group>
          <RoundedBox args={[1.15, 0.3, 0.6]} radius={0.05} smoothness={2}>
            <meshStandardMaterial color={body} roughness={0.6} metalness={0.3}
              transparent opacity={0.82} />
          </RoundedBox>
          {[-0.38, -0.19, 0, 0.19, 0.38].map((x) => (
            <mesh key={x} position={[x, 0, 0.32]}>
              <boxGeometry args={[0.08, 0.08, 0.04]} />
              <meshStandardMaterial color={accent} emissive={accent}
                emissiveIntensity={2.6} toneMapped={false} />
            </mesh>
          ))}
        </group>
      ) : (
        <group>
          <RoundedBox args={[0.78, 1.25, 0.62]} radius={0.06} smoothness={2}>
            <meshStandardMaterial color={body} roughness={0.6} metalness={0.32}
              transparent opacity={0.82} />
          </RoundedBox>
          {/* glowing edge + top strip */}
          <mesh position={[0, 0.52, 0.33]}>
            <boxGeometry args={[0.56, 0.07, 0.04]} />
            <meshStandardMaterial color={accent} emissive={accent}
              emissiveIntensity={2.8} toneMapped={false} />
          </mesh>
          {[-0.36, 0.36].map((x) => (
            <mesh key={x} position={[x, 0, 0.33]}>
              <boxGeometry args={[0.04, 1.05, 0.04]} />
              <meshStandardMaterial color={accent} emissive={accent}
                emissiveIntensity={2.0} toneMapped={false} />
            </mesh>
          ))}
          {[0.16, -0.02, -0.2, -0.38].map((y) => (
            <mesh key={y} position={[0, y, 0.33]}>
              <boxGeometry args={[0.5, 0.13, 0.02]} />
              <meshStandardMaterial color="#2a3550" roughness={0.55}
                transparent opacity={0.85} />
            </mesh>
          ))}
        </group>
      )}
    </group>
  );
}

/* Spread across the tall portrait screen. Fixed Y (no bob). */
const FLOATERS = [
  { position: [-3.4,  4.0, -2.2], scale: 0.78, kind: 'rack',   phase: 0.4 },
  { position: [ 3.6,  2.6, -2.8], scale: 0.85, kind: 'switch', phase: 1.7 },
  { position: [-3.9,  0.6, -1.8], scale: 0.6,  kind: 'node',   phase: 2.9 },
  { position: [ 4.0, -0.6, -2.4], scale: 0.8,  kind: 'rack',   phase: 0.9 },
  { position: [-3.0, -2.4, -1.6], scale: 0.62, kind: 'switch', phase: 3.6 },
  { position: [ 3.3, -3.6, -2.6], scale: 0.6,  kind: 'node',   phase: 1.2 },
  { position: [-3.7, -4.4, -3.0], scale: 0.8,  kind: 'rack',   phase: 2.2 },
  { position: [ 1.6,  5.0, -3.4], scale: 0.55, kind: 'node',   phase: 5.0 },
];

export default function DatacenterBackground({ accent = '#3FA9FF' }) {
  return (
    <div
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 0,
        pointerEvents: 'none',
      }}
    >
      <Canvas
        camera={{ position: [0, 0, 9], fov: 46 }}
        dpr={[1, 1.6]}
        gl={{ antialias: true, alpha: true }}
        style={{ background: 'transparent' }}
      >
        <ambientLight intensity={0.7} />
        <directionalLight position={[4, 6, 6]} intensity={0.8} />
        <pointLight position={[0, 0, 4]} intensity={2} distance={14} color={accent} />
        {FLOATERS.map((f, i) => (
          <FloatItem key={i} {...f} accent={accent} />
        ))}
      </Canvas>
    </div>
  );
}

import { useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { RoundedBox, OrbitControls } from '@react-three/drei';

/* Rack3D — a real WebGL server rack built from primitives.
   Dark graphite chassis + emissive accent glow (theme-colored), slowly
   auto-rotates and can be dragged to orbit. No external assets / HDRI
   (works offline in the iOS webview). */

function Rack({ accent }) {
  const UNITS = [0, 1, 2, 3, 4, 5];
  const litRows = new Set([1, 4]);

  const chassis = '#12161e';
  const panel   = '#0d1016';
  const unitCol = '#1b2230';

  const ref = useRef();
  // Front first, then swing symmetrically: front → left → front →
  // right → front … forever. Amplitude eases in from rest so the
  // start from the front is smooth (no jerk). Y-rotation only.
  useFrame((s) => {
    if (!ref.current) return;
    const t = s.clock.elapsedTime;
    const HOLD = 1.0;                       // hold the front view first
    const AMP = (55 * Math.PI) / 180;       // ~55° to each side
    const SPEED = 0.35;                     // slow
    if (t < HOLD) { ref.current.rotation.y = 0; return; }
    const k = Math.min(1, (t - HOLD) / 2.0);            // ease amplitude in
    ref.current.rotation.y = Math.sin((t - HOLD) * SPEED) * AMP * k;
  });

  return (
    <group ref={ref} rotation={[0, 0, 0]} position={[0, -0.05, 0]}>
      {/* main chassis */}
      <RoundedBox args={[1.75, 2.55, 1.55]} radius={0.09} smoothness={4} castShadow>
        <meshStandardMaterial color={chassis} metalness={0.55} roughness={0.42} />
      </RoundedBox>

      {/* recessed front panel */}
      <RoundedBox args={[1.5, 2.34, 0.08]} radius={0.04} smoothness={3}
                  position={[0, 0, 0.76]}>
        <meshStandardMaterial color={panel} metalness={0.5} roughness={0.6} />
      </RoundedBox>

      {/* glowing top accent strip */}
      <mesh position={[0, 1.07, 0.81]}>
        <boxGeometry args={[1.36, 0.07, 0.05]} />
        <meshStandardMaterial color={accent} emissive={accent}
                              emissiveIntensity={2.6} toneMapped={false} />
      </mesh>
      {/* vertical edge light strips */}
      {[-0.69, 0.69].map((x) => (
        <mesh key={x} position={[x, 0, 0.78]}>
          <boxGeometry args={[0.045, 2.3, 0.05]} />
          <meshStandardMaterial color={accent} emissive={accent}
                                emissiveIntensity={1.8} toneMapped={false} />
        </mesh>
      ))}

      {/* rack units */}
      {UNITS.map((i) => {
        const y = 0.82 - i * 0.345;
        const lit = litRows.has(i);
        return (
          <group key={i} position={[0, y, 0.8]}>
            <RoundedBox args={[1.34, 0.3, 0.12]} radius={0.03} smoothness={3}>
              <meshStandardMaterial color={unitCol} metalness={0.5} roughness={0.5} />
            </RoundedBox>
            {/* status LED */}
            <mesh position={[-0.56, 0, 0.08]}>
              <boxGeometry args={[0.07, 0.07, 0.04]} />
              <meshStandardMaterial
                color={lit ? accent : '#3a4254'}
                emissive={lit ? accent : '#000000'}
                emissiveIntensity={lit ? 3 : 0} toneMapped={false} />
            </mesh>
            {/* vent slots */}
            {[-0.2, -0.1, 0, 0.1, 0.2].map((vx) => (
              <mesh key={vx} position={[vx, 0, 0.075]}>
                <boxGeometry args={[0.018, 0.16, 0.02]} />
                <meshStandardMaterial color="#070a0f" roughness={0.9} />
              </mesh>
            ))}
            {/* port LEDs */}
            {[0.36, 0.46, 0.56].map((px, k) => {
              const on = lit && k === 2;
              return (
                <mesh key={px} position={[px, 0, 0.08]}>
                  <boxGeometry args={[0.05, 0.05, 0.04]} />
                  <meshStandardMaterial
                    color={on ? accent : '#2a3142'}
                    emissive={on ? accent : '#000000'}
                    emissiveIntensity={on ? 3 : 0} toneMapped={false} />
                </mesh>
              );
            })}
          </group>
        );
      })}

      {/* accent fill light so the glow spills onto the chassis */}
      <pointLight position={[0.9, 0.6, 1.6]} intensity={6} distance={6} color={accent} />
      <pointLight position={[-0.9, -0.6, 1.4]} intensity={3} distance={5} color={accent} />
    </group>
  );
}

export default function Rack3D({ className, accent = '#3FA9FF' }) {
  return (
    <div className={className}>
      <Canvas
        camera={{ position: [0, 0.1, 7], fov: 26 }}
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: true }}
        style={{ background: 'transparent' }}
      >
        <ambientLight intensity={0.55} />
        <directionalLight position={[5, 8, 5]} intensity={1.15} />
        <directionalLight position={[-4, 2, -3]} intensity={0.4} color="#9fc4ff" />
        <Rack accent={accent} />
        <OrbitControls
          enableZoom={false}
          enablePan={false}
          enableDamping
          dampingFactor={0.08}
          minPolarAngle={Math.PI / 3}
          maxPolarAngle={Math.PI / 2.02}
          minAzimuthAngle={-0.7}
          maxAzimuthAngle={0.7}
          target={[0, 0, 0]}
        />
      </Canvas>
    </div>
  );
}

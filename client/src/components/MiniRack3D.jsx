import { Suspense, useMemo, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import * as THREE from 'three';

// Mini server rack — realistic chassis, active port LEDs, swaying patch
// cables, traveling scan beam, mounting hardware. Slow Y-axis rotation
// showcases all sides; the active unit (driven by progress, top→bottom)
// pulses brighter.

const COLORS = {
  rail:        '#4f46e5',
  chassisDark: '#2a2659',
  chassisMid:  '#3730a3',
  chassisAlt:  '#4338ca',
  faceplate:   '#15123a',
  vent:        '#0a0820',
  ledPurple:   '#c4b5fd',
  ledBlue:     '#7dd3fc',
  ledGreen:    '#86efac',
  ledOrange:   '#fdba74',
  ledRed:      '#fca5a5',
  cable1:      '#a78bfa',
  cable2:      '#60a5fa',
  cable3:      '#f472b6',
};

// ── Reusable port grid ──
function PortGrid({ rows = 2, cols = 12, scanLit, ledColor, width = 2.0 }) {
  const refs = useRef([]);
  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    refs.current.forEach((m, i) => {
      if (!m) return;
      const phase = i * 0.31 + t * (scanLit ? 3.5 : 1.2);
      const base = scanLit ? 1.6 : 0.5;
      const amp  = scanLit ? 1.8 : 0.5;
      m.material.emissiveIntensity = base + Math.abs(Math.sin(phase)) * amp;
    });
  });

  const cells = [];
  const h = 0.085;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = -width / 2 + (c / (cols - 1)) * width;
      const y = rows === 1 ? 0 : (r === 0 ? h / 2 : -h / 2);
      cells.push({ x, y, idx: r * cols + c });
    }
  }
  return (
    <>
      {cells.map(({ x, y, idx }) => (
        <mesh
          key={idx}
          ref={(el) => (refs.current[idx] = el)}
          position={[x, y, 0.002]}
        >
          <boxGeometry args={[Math.min(0.09, (width / cols) * 0.7), 0.05, 0.012]} />
          <meshStandardMaterial
            color={ledColor}
            emissive={ledColor}
            emissiveIntensity={0.5}
            toneMapped={false}
          />
        </mesh>
      ))}
    </>
  );
}

// ── Side fan grille (decorative, on chassis side) ──
function FanGrille({ position, scanLit }) {
  const fanRef = useRef();
  useFrame(({ clock }) => {
    if (fanRef.current) {
      fanRef.current.rotation.x = clock.getElapsedTime() * (scanLit ? 8 : 3);
    }
  });
  return (
    <group position={position} rotation={[0, Math.PI / 2, 0]}>
      <mesh>
        <ringGeometry args={[0.05, 0.13, 16]} />
        <meshStandardMaterial color="#0a0820" metalness={0.4} />
      </mesh>
      {/* fan blades */}
      <group ref={fanRef}>
        {[0, 1, 2, 3].map((i) => (
          <mesh key={i} rotation={[(i * Math.PI) / 2, 0, 0]}>
            <boxGeometry args={[0.005, 0.1, 0.03]} />
            <meshStandardMaterial color="#3a3680" metalness={0.6} />
          </mesh>
        ))}
      </group>
      {/* hub */}
      <mesh>
        <cylinderGeometry args={[0.02, 0.02, 0.01, 12]} />
        <meshStandardMaterial color="#0a0820" />
      </mesh>
    </group>
  );
}

// ── Mounting screws on the rack ears ──
function Screws({ y }) {
  return (
    <>
      {[
        [-1.18, 0.66],
        [-1.18, -0.66],
        [1.18, 0.66],
        [1.18, -0.66],
      ].map(([x, z], i) => (
        <mesh key={i} position={[x, y, z + 0.01]}>
          <cylinderGeometry args={[0.025, 0.025, 0.02, 8]} />
          <meshStandardMaterial color="#9ca3af" metalness={0.95} roughness={0.2} />
        </mesh>
      ))}
    </>
  );
}

function SwitchUnit({ y, scanLit }) {
  return (
    <group position={[0, y, 0]}>
      {/* main chassis */}
      <mesh castShadow>
        <boxGeometry args={[2.5, 0.36, 1.3]} />
        <meshStandardMaterial color={COLORS.chassisMid} metalness={0.78} roughness={0.28} />
      </mesh>
      {/* top vent grooves */}
      <mesh position={[0, 0.181, 0]}>
        <boxGeometry args={[2.0, 0.005, 0.9]} />
        <meshStandardMaterial color={COLORS.vent} />
      </mesh>
      {/* faceplate */}
      <mesh position={[0, 0, 0.66]}>
        <boxGeometry args={[2.45, 0.32, 0.02]} />
        <meshStandardMaterial color={COLORS.faceplate} metalness={0.5} roughness={0.55} />
      </mesh>
      {/* port grid (24 ports in 2 rows) */}
      <group position={[0.15, 0, 0.673]}>
        <PortGrid rows={2} cols={12} scanLit={scanLit} ledColor={COLORS.ledBlue} width={1.85} />
      </group>
      {/* SFP module on left */}
      <mesh position={[-1.05, 0, 0.674]}>
        <boxGeometry args={[0.32, 0.16, 0.01]} />
        <meshStandardMaterial color="#0a0820" metalness={0.6} />
      </mesh>
      {/* status LEDs */}
      <mesh position={[-1.16, 0.07, 0.676]}>
        <boxGeometry args={[0.04, 0.04, 0.01]} />
        <meshStandardMaterial color={COLORS.ledGreen} emissive={COLORS.ledGreen} emissiveIntensity={scanLit ? 3.5 : 1.4} toneMapped={false} />
      </mesh>
      <mesh position={[-1.16, -0.07, 0.676]}>
        <boxGeometry args={[0.04, 0.04, 0.01]} />
        <meshStandardMaterial color={COLORS.ledOrange} emissive={COLORS.ledOrange} emissiveIntensity={scanLit ? 2.5 : 0.5} toneMapped={false} />
      </mesh>
      <FanGrille position={[1.27, 0, 0.4]} scanLit={scanLit} />
      <FanGrille position={[1.27, 0, -0.4]} scanLit={scanLit} />
      <Screws y={0} />
    </group>
  );
}

function PatchPanel({ y, scanLit }) {
  return (
    <group position={[0, y, 0]}>
      <mesh castShadow>
        <boxGeometry args={[2.5, 0.32, 1.3]} />
        <meshStandardMaterial color={COLORS.chassisAlt} metalness={0.7} roughness={0.32} />
      </mesh>
      <mesh position={[0, 0, 0.66]}>
        <boxGeometry args={[2.45, 0.28, 0.02]} />
        <meshStandardMaterial color="#221e57" metalness={0.4} roughness={0.6} />
      </mesh>
      {/* RJ45 socket grid (24 ports) */}
      <group position={[0, 0, 0.673]}>
        <PortGrid rows={1} cols={16} scanLit={scanLit} ledColor={COLORS.ledPurple} width={1.95} />
      </group>
      {/* "PATCH PANEL" silver strip on left */}
      <mesh position={[-1.07, 0, 0.674]}>
        <boxGeometry args={[0.18, 0.06, 0.005]} />
        <meshStandardMaterial color="#cbd5e1" metalness={0.9} roughness={0.25} />
      </mesh>
      <Screws y={0} />
    </group>
  );
}

function ServerUnit({ y, scanLit }) {
  const screenRef = useRef();
  const fanRef = useRef();
  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (screenRef.current) {
      const i = scanLit ? 2.8 : 1.0;
      screenRef.current.material.emissiveIntensity = i + Math.sin(t * 3) * 0.5;
    }
    if (fanRef.current) {
      fanRef.current.rotation.z = t * (scanLit ? 10 : 4);
    }
  });
  return (
    <group position={[0, y, 0]}>
      <mesh castShadow>
        <boxGeometry args={[2.5, 0.5, 1.3]} />
        <meshStandardMaterial color={COLORS.chassisMid} metalness={0.78} roughness={0.28} />
      </mesh>
      <mesh position={[0, 0, 0.66]}>
        <boxGeometry args={[2.45, 0.46, 0.02]} />
        <meshStandardMaterial color={COLORS.faceplate} metalness={0.5} roughness={0.55} />
      </mesh>
      {/* LCD-style status display */}
      <mesh ref={screenRef} position={[-0.95, 0.02, 0.674]}>
        <boxGeometry args={[0.5, 0.18, 0.005]} />
        <meshStandardMaterial
          color={COLORS.ledBlue}
          emissive={COLORS.ledBlue}
          emissiveIntensity={1.0}
          toneMapped={false}
        />
      </mesh>
      {/* pixel rows on screen for "text" effect */}
      {Array.from({ length: 3 }).map((_, r) => (
        <mesh key={r} position={[-0.95, 0.07 - r * 0.05, 0.677]}>
          <boxGeometry args={[0.36, 0.012, 0.001]} />
          <meshBasicMaterial color="#0a0820" toneMapped={false} />
        </mesh>
      ))}
      {/* drive bays */}
      {Array.from({ length: 6 }).map((_, i) => (
        <mesh key={i} position={[-0.32 + i * 0.2, 0, 0.674]}>
          <boxGeometry args={[0.16, 0.34, 0.005]} />
          <meshStandardMaterial color="#0a0820" metalness={0.6} roughness={0.4} />
        </mesh>
      ))}
      {/* drive activity LEDs */}
      {Array.from({ length: 6 }).map((_, i) => (
        <mesh key={`led-${i}`} position={[-0.32 + i * 0.2, 0.155, 0.677]}>
          <boxGeometry args={[0.05, 0.025, 0.005]} />
          <meshStandardMaterial
            color={i % 2 === 0 ? COLORS.ledGreen : COLORS.ledOrange}
            emissive={i % 2 === 0 ? COLORS.ledGreen : COLORS.ledOrange}
            emissiveIntensity={scanLit ? 2.5 : 0.9}
            toneMapped={false}
          />
        </mesh>
      ))}
      {/* power button glow */}
      <mesh position={[1.12, 0.1, 0.674]}>
        <cylinderGeometry args={[0.045, 0.045, 0.01, 16]} />
        <meshStandardMaterial
          color={COLORS.ledGreen}
          emissive={COLORS.ledGreen}
          emissiveIntensity={scanLit ? 3.5 : 1.6}
          toneMapped={false}
        />
      </mesh>
      {/* small visible fan (front-facing) */}
      <group position={[1.12, -0.12, 0.674]} ref={fanRef}>
        <mesh>
          <ringGeometry args={[0.04, 0.075, 12]} />
          <meshStandardMaterial color="#0a0820" />
        </mesh>
        {[0, 1, 2].map((i) => (
          <mesh key={i} rotation={[0, 0, (i * 2 * Math.PI) / 3]}>
            <boxGeometry args={[0.01, 0.06, 0.005]} />
            <meshStandardMaterial color="#3a3680" metalness={0.6} />
          </mesh>
        ))}
      </group>
      <Screws y={0} />
    </group>
  );
}

function RackFrame() {
  return (
    <group>
      {[
        [1.27, 0.66],
        [1.27, -0.66],
        [-1.27, 0.66],
        [-1.27, -0.66],
      ].map(([x, z], i) => (
        <mesh key={i} position={[x, 0, z]}>
          <boxGeometry args={[0.07, 2.7, 0.07]} />
          <meshStandardMaterial
            color={COLORS.rail}
            metalness={0.85}
            roughness={0.25}
            emissive={COLORS.rail}
            emissiveIntensity={0.12}
          />
        </mesh>
      ))}
      <mesh position={[0, -1.4, 0]}>
        <boxGeometry args={[2.7, 0.06, 1.45]} />
        <meshStandardMaterial color="#1e1b4b" metalness={0.6} roughness={0.45} />
      </mesh>
      <mesh position={[0, 1.4, 0]}>
        <boxGeometry args={[2.7, 0.06, 1.45]} />
        <meshStandardMaterial color="#1e1b4b" metalness={0.6} roughness={0.45} />
      </mesh>
      {/* shelf cross-bars between units */}
      {[1.15, 0.7, 0.2, -0.3, -0.8, -1.25].map((y, i) => (
        <mesh key={`x-${i}`} position={[0, y, 0.66]}>
          <boxGeometry args={[2.55, 0.015, 0.015]} />
          <meshStandardMaterial color="#9ca3af" metalness={0.9} roughness={0.3} />
        </mesh>
      ))}
      {/* base soft glow */}
      <mesh position={[0, -1.46, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[1.6, 32]} />
        <meshBasicMaterial color={COLORS.ledPurple} transparent opacity={0.18} toneMapped={false} />
      </mesh>
    </group>
  );
}

function CableBundle() {
  // Build curve geometry once, then animate sway via vertex displacement.
  const tubeRefs = useRef([]);
  const curves = useMemo(() => {
    return [
      { offset: -0.05, color: COLORS.cable1 },
      { offset:  0.0,  color: COLORS.cable2 },
      { offset:  0.05, color: COLORS.cable3 },
    ];
  }, []);

  // Static base geometry; we'll just oscillate the whole tube group.
  const geoms = useMemo(() => {
    return curves.map(({ offset }) => {
      const pts = [
        new THREE.Vector3(1.18, 0.95, 0.55 + offset),
        new THREE.Vector3(1.36, 0.55, 0.78 + offset),
        new THREE.Vector3(1.45, 0.0,  0.7 + offset),
        new THREE.Vector3(1.36, -0.55, 0.78 + offset),
        new THREE.Vector3(1.18, -0.95, 0.55 + offset),
      ];
      return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 36, 0.025, 8, false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curves]);

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    tubeRefs.current.forEach((m, i) => {
      if (!m) return;
      m.position.z = Math.sin(t * 1.5 + i * 0.7) * 0.015;
      m.position.x = Math.cos(t * 1.2 + i * 0.5) * 0.01;
    });
  });

  return (
    <>
      {curves.map((c, i) => (
        <mesh
          key={i}
          ref={(el) => (tubeRefs.current[i] = el)}
          geometry={geoms[i]}
        >
          <meshStandardMaterial color={c.color} roughness={0.65} metalness={0.15} />
        </mesh>
      ))}
    </>
  );
}

function ScanBeam({ progress }) {
  // Glowing horizontal plane that follows progress top→bottom and pulses.
  const beamRef = useRef();
  const yPositions = [0.95, 0.45, -0.05, -0.55, -1.05];
  const targetY = useMemo(() => {
    const idx = Math.min(
      Math.floor((progress / 100) * yPositions.length),
      yPositions.length - 1,
    );
    return yPositions[idx];
  }, [progress]);

  useFrame(({ clock }) => {
    if (!beamRef.current) return;
    beamRef.current.position.y += (targetY - beamRef.current.position.y) * 0.15;
    const t = clock.getElapsedTime();
    beamRef.current.material.opacity = 0.35 + Math.abs(Math.sin(t * 3.5)) * 0.5;
  });

  return (
    <mesh ref={beamRef} position={[0, 0, 0.69]}>
      <planeGeometry args={[2.8, 0.32]} />
      <meshBasicMaterial
        color={COLORS.ledPurple}
        transparent
        opacity={0.5}
        toneMapped={false}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

function ScanRing({ progress }) {
  const ref = useRef();
  const yPositions = [0.95, 0.45, -0.05, -0.55, -1.05];
  const targetY = useMemo(() => {
    const idx = Math.min(
      Math.floor((progress / 100) * yPositions.length),
      yPositions.length - 1,
    );
    return yPositions[idx];
  }, [progress]);

  useFrame(({ clock }) => {
    if (!ref.current) return;
    ref.current.position.y += (targetY - ref.current.position.y) * 0.12;
    ref.current.material.opacity = 0.45 + Math.abs(Math.sin(clock.getElapsedTime() * 2.5)) * 0.4;
    ref.current.rotation.z = clock.getElapsedTime() * 0.5;
  });

  return (
    <mesh ref={ref} position={[0, 0, 0]} rotation={[Math.PI / 2, 0, 0]}>
      <torusGeometry args={[1.7, 0.025, 8, 64]} />
      <meshBasicMaterial color={COLORS.ledPurple} transparent opacity={0.65} toneMapped={false} />
    </mesh>
  );
}

function Scene({ progress }) {
  const groupRef = useRef();
  useFrame(({ clock }) => {
    if (groupRef.current) {
      groupRef.current.rotation.y = clock.getElapsedTime() * 0.5;
      groupRef.current.position.y = Math.sin(clock.getElapsedTime() * 0.9) * 0.04;
    }
  });

  // Top → bottom: progress 0% → top unit; progress 100% → bottom unit.
  const scanIdx = Math.min(Math.floor((progress / 100) * 5), 4);

  return (
    <group ref={groupRef}>
      <RackFrame />
      <SwitchUnit  y={0.95}  scanLit={scanIdx === 0} />
      <PatchPanel  y={0.45}  scanLit={scanIdx === 1} />
      <ServerUnit  y={-0.05} scanLit={scanIdx === 2} />
      <PatchPanel  y={-0.55} scanLit={scanIdx === 3} />
      <SwitchUnit  y={-1.05} scanLit={scanIdx === 4} />
      <CableBundle />
      <ScanBeam progress={progress} />
      <ScanRing progress={progress} />
    </group>
  );
}

export default function MiniRack3D({ progress = 0, size = 150 }) {
  return (
    <div style={{ width: size, height: size, pointerEvents: 'none' }}>
      <Canvas
        camera={{ position: [4.6, 2.4, 4.6], fov: 32 }}
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
      >
        <ambientLight intensity={0.55} />
        <directionalLight position={[5, 6, 4]} intensity={1.5} color="#ffffff" castShadow />
        <pointLight position={[-3, -2, 3]} intensity={0.9} color="#a78bfa" />
        <pointLight position={[3, 1, -3]} intensity={0.7} color="#60a5fa" />
        <Suspense fallback={null}>
          <Scene progress={progress} />
        </Suspense>
      </Canvas>
    </div>
  );
}

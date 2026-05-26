import { forwardRef, useImperativeHandle, useMemo, Suspense } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { XR, createXRStore, useXR } from '@react-three/xr';
import VRRackScene, { computeVRCamera } from './VRRackScene.jsx';

// ── Orbit controls that auto-disable during an XR session ──────────────
function FallbackControls() {
  const xr = useXR();
  const inSession = !!xr?.session;

  const cam = computeVRCamera();

  if (inSession) return null;

  return (
    <OrbitControls
      target={cam.target}
      enablePan
      enableDamping
      dampingFactor={0.08}
      minPolarAngle={0.25}
      maxPolarAngle={Math.PI - 0.25}
      minDistance={cam.minDist}
      maxDistance={cam.maxDist}
    />
  );
}

// ── Canvas wrapper ──────────────────────────────────────────────────────
const VRRackCanvas = forwardRef(function VRRackCanvas({ topo, scanData, style }, ref) {
  const store = useMemo(
    () => createXRStore({ foveation: 1, hand: { model: false }, emulate: false }),
    []
  );

  useImperativeHandle(ref, () => ({
    enterVR() {
      store.enterVR();
    },
  }), [store]);

  const cam = computeVRCamera();

  return (
    <Canvas
      camera={{
        position: cam.position,
        fov: cam.fov,
        near: 0.1,
        far: 120,
      }}
      gl={{
        antialias: true,
        alpha: true,
        powerPreference: 'high-performance',
      }}
      dpr={[1, 2]}
      style={{ touchAction: 'none', ...style }}
    >
      <XR store={store}>
        <FallbackControls />
        <Suspense fallback={null}>
          <VRRackScene topo={topo} scanData={scanData} />
        </Suspense>
      </XR>
    </Canvas>
  );
});

export default VRRackCanvas;

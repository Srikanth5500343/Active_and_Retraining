import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Canvas, useLoader } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { apiUrl, authFetch } from '../utils/api';

const TopologyScene3D = lazy(() => import('./TopologyScene3D.jsx'));

const VIEWS = [
  { key: 'topology', label: 'Topology', hint: 'Abstract 3D scene built from detected devices and ports.' },
  { key: 'photo3d',  label: 'Photo · 3D', hint: 'Your front photo wrapped onto a 3D chassis — orbit around.' },
  { key: 'rack3d',   label: 'Rack · 3D',  hint: 'Each detected device becomes its own 3D box, textured from the photo.' },
  { key: 'sides',    label: '360°',       hint: 'Upload or record all four sides for a true walkaround.' },
  { key: 'real',     label: 'Real 3D',    hint: 'Drop in a .glb mesh scanned with Polycam / Object Capture on iPhone.' },
];

// ── Top-level page ──────────────────────────────────────────────────────────
export default function VRPage() {
  const { rackId: rackIdParam } = useParams();
  const navigate = useNavigate();

  const [historyEntry, setHistoryEntry] = useState(null);
  const [topo, setTopo]       = useState(null);
  const [topoErr, setTopoErr] = useState(null);
  const [empty, setEmpty]     = useState(false);
  const [view, setView]       = useState('topology');

  // Resolve the scan: URL param if present, else latest history entry.
  useEffect(() => {
    let hist = [];
    try { hist = JSON.parse(localStorage.getItem('rackTrackHistory') || '[]'); } catch { /* ignore */ }
    if (!Array.isArray(hist) || hist.length === 0) { setEmpty(true); return; }
    const entry = rackIdParam ? hist.find(h => h.scanId === rackIdParam) || hist[0] : hist[0];
    setHistoryEntry(entry);
  }, [rackIdParam]);

  // Lazy-fetch topology when entering that view.
  useEffect(() => {
    if (view !== 'topology' || !historyEntry?.scanId || topo) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await authFetch(apiUrl(`/api/topology/${historyEntry.scanId}`));
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        if (!cancelled) setTopo(data);
      } catch (e) {
        if (!cancelled) setTopoErr(e?.message || String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [view, historyEntry, topo]);

  const imageUrl = historyEntry?.imageUrl ? apiUrl(historyEntry.imageUrl) : null;
  const scanId   = historyEntry?.scanId   || null;
  const devices  = historyEntry?.fullResult?.devices || [];

  const msg = {
    position:'absolute', inset:0,
    display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center',
    gap:14, padding:'28px 20px', textAlign:'center', color:'#9ca3af',
  };

  if (empty) {
    return (
      <Shell onClose={() => navigate(-1)} view={view} setView={setView} hideToggle>
        <div style={msg}>
          <div style={{fontSize:36}}>🗄️</div>
          <p style={{fontSize:15, fontWeight:600, color:'#e5e7eb'}}>No scans yet</p>
          <p style={{fontSize:12, maxWidth:300, lineHeight:1.5}}>
            Scan a rack first, then come back here to view it.
          </p>
          <button className="btn btn-primary" onClick={() => navigate('/scan')}>Start a Scan</button>
        </div>
      </Shell>
    );
  }
  if (!historyEntry) {
    return (
      <Shell onClose={() => navigate(-1)} view={view} setView={setView} hideToggle>
        <div style={msg}><p>Loading your scan…</p></div>
      </Shell>
    );
  }

  return (
    <Shell onClose={() => navigate(-1)} view={view} setView={setView}
           hint={VIEWS.find(v => v.key === view)?.hint}>
      {view === 'topology' && (
        topo ? (
          <Suspense fallback={<div style={msg}><p>Initializing 3D scene…</p></div>}>
            <TopologyScene3D topo={topo} setSelected={() => {}} />
          </Suspense>
        ) : topoErr ? (
          <div style={msg}>
            <div style={{fontSize:36}}>⚠️</div>
            <p style={{fontSize:14, color:'#ef4444'}}>Couldn't load topology</p>
            <p style={{fontSize:12, maxWidth:300}}>{topoErr}</p>
          </div>
        ) : (
          <div style={msg}><p>Loading topology…</p></div>
        )
      )}
      {view === 'photo3d' && <Photo3DView imageUrl={imageUrl} />}
      {view === 'rack3d'  && <Rack3DView imageUrl={imageUrl} devices={devices} />}
      {view === 'sides'   && <SidesView scanId={scanId} frontFallback={imageUrl} />}
      {view === 'real'    && <Real3DView scanId={scanId} />}
    </Shell>
  );
}

// ── Layout shell with top bar + view toggle ─────────────────────────────────
function Shell({ children, onClose, view, setView, hint, hideToggle }) {
  return (
    <div style={{ position:'fixed', inset:0, background:'#0e1830', zIndex:1000 }}>
      {children}

      <div style={{
        position:'absolute', top:'env(safe-area-inset-top, 0px)', left:0, right:0,
        height:48, display:'flex', alignItems:'center', justifyContent:'space-between',
        padding:'0 14px', pointerEvents:'none', zIndex:5,
      }}>
        <div style={{
          fontSize:10, fontWeight:700, letterSpacing:'0.10em',
          color:'#34d399', textTransform:'uppercase',
          textShadow:'0 1px 2px rgba(0,0,0,0.6)',
        }}>VR view</div>
        <button onClick={onClose} aria-label="Close VR view"
          style={{
            pointerEvents:'auto',
            background:'rgba(15,23,42,0.7)', backdropFilter:'blur(10px)',
            WebkitBackdropFilter:'blur(10px)',
            border:'1px solid rgba(255,255,255,0.12)',
            borderRadius:999, width:36, height:36,
            display:'flex', alignItems:'center', justifyContent:'center',
            color:'#e5e7eb', cursor:'pointer',
          }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>

      {!hideToggle && (
        <div style={{
          position:'absolute',
          bottom:'calc(env(safe-area-inset-bottom, 0px) + 18px)',
          left:0, right:0,
          display:'flex', flexDirection:'column', alignItems:'center', gap:8,
          pointerEvents:'none', zIndex:5,
        }}>
          {hint && (
            <div style={{
              maxWidth:340, padding:'6px 12px', borderRadius:999,
              fontSize:11, color:'#cbd5e1',
              background:'rgba(15,23,42,0.6)', backdropFilter:'blur(8px)',
              WebkitBackdropFilter:'blur(8px)',
              border:'1px solid rgba(255,255,255,0.08)',
              textAlign:'center',
            }}>{hint}</div>
          )}
          <div style={{
            display:'flex', gap:4, padding:4, borderRadius:999,
            background:'rgba(1,11,31,0.78)',
            backdropFilter:'blur(12px)', WebkitBackdropFilter:'blur(12px)',
            border:'1px solid rgba(255,255,255,0.12)',
            pointerEvents:'auto',
          }}>
            {VIEWS.map(v => (
              <button key={v.key} type="button"
                onClick={() => setView(v.key)}
                style={{
                  border:'none', cursor:'pointer',
                  padding:'8px 14px', borderRadius:999,
                  fontSize:11, fontWeight:700, letterSpacing:'0.06em',
                  textTransform:'uppercase',
                  color: view === v.key ? '#fff' : 'rgba(255,255,255,0.55)',
                  background: view === v.key ? 'rgba(59,130,246,0.28)' : 'transparent',
                  boxShadow: view === v.key ? '0 0 14px rgba(59,130,246,0.3)' : 'none',
                  WebkitTapHighlightColor:'transparent',
                }}>{v.label}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── View: Photo · 3D (single front photo wrapped on a chassis) ──────────────
function Photo3DView({ imageUrl }) {
  if (!imageUrl) {
    return (
      <div style={{
        position:'absolute', inset:0, display:'flex', alignItems:'center',
        justifyContent:'center', color:'#9ca3af', fontSize:13,
      }}>No image available for this scan.</div>
    );
  }
  return (
    <Canvas camera={{ position:[1.6, 1.4, 2.6], fov:55, near:0.05, far:60 }}
            gl={{ antialias:true }}
            style={{ position:'absolute', inset:0, touchAction:'none' }}>
      <color attach="background" args={['#0e1830']} />
      <fog attach="fog" args={['#0e1830', 6, 18]} />
      <ambientLight intensity={0.55} />
      <directionalLight position={[3, 5, 4]} intensity={0.9} />
      <hemisphereLight args={[0x9bb1ff, 0x1f2937, 0.35]} />
      <gridHelper args={[24, 48, '#2e4a78', '#1c2c4a']} />
      <Suspense fallback={null}>
        <PhotoRack imageUrl={imageUrl} />
      </Suspense>
      <OrbitControls target={[0, 1.1, 0]} enableDamping
        minDistance={1.2} maxDistance={6}
        maxPolarAngle={Math.PI * 0.495} />
    </Canvas>
  );
}

function PhotoRack({ imageUrl }) {
  const tex = useLoader(THREE.TextureLoader, imageUrl);
  const { width, height } = useMemo(() => {
    const img = tex.image;
    const ar = img && img.width && img.height ? img.width / img.height : 0.55;
    const h = 2.2;
    return { width: h * ar, height: h };
  }, [tex]);
  useMemo(() => { tex.colorSpace = THREE.SRGBColorSpace; }, [tex]);
  const depth = Math.max(0.8, width * 1.2);
  const yCenter = height / 2 + 0.02;
  return (
    <group>
      <mesh position={[0, yCenter, depth / 2 + 0.005]}>
        <planeGeometry args={[width, height]} />
        <meshBasicMaterial map={tex} toneMapped={false} />
      </mesh>
      <mesh position={[0, yCenter, 0]}>
        <boxGeometry args={[width * 1.02, height * 1.02, depth]} />
        <meshStandardMaterial color="#111827" metalness={0.35} roughness={0.7} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.001, 0]}>
        <circleGeometry args={[width * 1.6, 48]} />
        <meshBasicMaterial color="#1d3a72" transparent opacity={0.22} />
      </mesh>
    </group>
  );
}

// ── View: Rack · 3D (per-device textured box stack) ─────────────────────────
function Rack3DView({ imageUrl, devices }) {
  const [crops, setCrops] = useState(null);
  const [imgDims, setImgDims] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setCrops(null); setError(null);
    if (!imageUrl) return;
    (async () => {
      try {
        const img = await loadImage(imageUrl);
        if (cancelled) return;
        const W = img.naturalWidth, H = img.naturalHeight;
        const out = [];
        for (let i = 0; i < devices.length; i++) {
          const d = devices[i];
          const bb = normalizeBbox(d);
          if (!bb) continue;
          let [x, y, w, h] = bb.map(v => Math.max(0, v));
          // Clip to image bounds.
          w = Math.min(w, W - x); h = Math.min(h, H - y);
          if (w < 6 || h < 6) continue;
          const canvas = document.createElement('canvas');
          canvas.width = Math.min(640, Math.round(w));
          canvas.height = Math.round(canvas.width * (h / w));
          canvas.getContext('2d').drawImage(img, x, y, w, h, 0, 0, canvas.width, canvas.height);
          out.push({
            id: `dev_${i}`,
            bbox: [x, y, w, h],
            label: String(d.class_name || d.class || 'device'),
            color: colorForClass(d.class_name || d.class || ''),
            dataUrl: canvas.toDataURL('image/jpeg', 0.88),
          });
        }
        if (!cancelled) {
          setImgDims({ w: W, h: H });
          setCrops(out);
        }
      } catch (e) {
        if (!cancelled) setError(e?.message || String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [imageUrl, devices]);

  if (!imageUrl) {
    return (
      <div style={{
        position:'absolute', inset:0, display:'flex', alignItems:'center',
        justifyContent:'center', color:'#9ca3af', fontSize:13,
      }}>No image available for this scan.</div>
    );
  }
  if (error) {
    return (
      <div style={{
        position:'absolute', inset:0, display:'flex', flexDirection:'column',
        alignItems:'center', justifyContent:'center', gap:8, padding:20,
        color:'#ef4444', fontSize:13, textAlign:'center',
      }}>
        <div style={{fontSize:30}}>⚠️</div>
        <p>Couldn't crop devices from photo</p>
        <p style={{color:'#9ca3af', fontSize:12}}>{error}</p>
      </div>
    );
  }
  if (!crops) {
    return (
      <div style={{
        position:'absolute', inset:0, display:'flex', alignItems:'center',
        justifyContent:'center', color:'#9ca3af', fontSize:13,
      }}>Cropping devices…</div>
    );
  }
  if (crops.length === 0) {
    return (
      <div style={{
        position:'absolute', inset:0, display:'flex', flexDirection:'column',
        alignItems:'center', justifyContent:'center', gap:8, padding:20,
        color:'#9ca3af', fontSize:13, textAlign:'center',
      }}>
        <div style={{fontSize:30}}>🔍</div>
        <p>No devices were detected in this scan.</p>
        <p style={{fontSize:11}}>Use Photo · 3D or 360° instead.</p>
      </div>
    );
  }

  return (
    <Canvas camera={{ position:[2.0, 1.4, 3.0], fov:55, near:0.05, far:60 }}
            gl={{ antialias:true }}
            style={{ position:'absolute', inset:0, touchAction:'none' }}>
      <color attach="background" args={['#0e1830']} />
      <fog attach="fog" args={['#0e1830', 8, 22]} />
      <ambientLight intensity={0.6} />
      <directionalLight position={[3, 6, 4]} intensity={0.95} />
      <hemisphereLight args={[0x9bb1ff, 0x1f2937, 0.4]} />
      <gridHelper args={[24, 48, '#2e4a78', '#1c2c4a']} />
      <Suspense fallback={null}>
        <PerDeviceRack crops={crops} imgDims={imgDims} />
      </Suspense>
      <OrbitControls target={[0, 1.1, 0]} enableDamping
        minDistance={1.2} maxDistance={6.5}
        maxPolarAngle={Math.PI * 0.495} />
    </Canvas>
  );
}

function PerDeviceRack({ crops, imgDims }) {
  const rackH = 2.2;
  const rackW = rackH * (imgDims.w / imgDims.h);

  return (
    <group>
      {/* Rack back panel */}
      <mesh position={[0, rackH / 2, -0.18]}>
        <boxGeometry args={[rackW * 1.06, rackH * 1.03, 0.04]} />
        <meshStandardMaterial color="#0f172a" roughness={0.8} />
      </mesh>
      {/* Rack rails */}
      <mesh position={[-rackW / 2 - 0.04, rackH / 2, -0.05]}>
        <boxGeometry args={[0.05, rackH * 1.03, 0.32]} />
        <meshStandardMaterial color="#1f2937" metalness={0.5} roughness={0.55} />
      </mesh>
      <mesh position={[rackW / 2 + 0.04, rackH / 2, -0.05]}>
        <boxGeometry args={[0.05, rackH * 1.03, 0.32]} />
        <meshStandardMaterial color="#1f2937" metalness={0.5} roughness={0.55} />
      </mesh>
      {/* Floor pool */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.001, 0]}>
        <circleGeometry args={[Math.max(rackW, 1.6) * 1.4, 48]} />
        <meshBasicMaterial color="#1d3a72" transparent opacity={0.22} />
      </mesh>

      {crops.map(c => {
        const [x, y, w, h] = c.bbox;
        const cx = (x + w / 2) / imgDims.w;
        const cy = (y + h / 2) / imgDims.h;
        const worldW = (w / imgDims.w) * rackW;
        const worldH = (h / imgDims.h) * rackH;
        const worldX = (cx - 0.5) * rackW;
        const worldY = (1 - cy) * rackH;
        const depth  = depthForClass(c.label);
        return (
          <DeviceBox key={c.id}
            crop={c}
            position={[worldX, worldY, depth / 2]}
            size={[worldW, worldH, depth]} />
        );
      })}
    </group>
  );
}

function DeviceBox({ crop, position, size }) {
  const tex = useLoader(THREE.TextureLoader, crop.dataUrl);
  useMemo(() => { tex.colorSpace = THREE.SRGBColorSpace; }, [tex]);
  const accent = new THREE.Color(crop.color);
  const sideMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: accent, metalness: 0.35, roughness: 0.55 }),
    [crop.color] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const darkMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#0a0f1d', roughness: 0.85 }),
    []
  );
  const frontMat = useMemo(
    () => new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }),
    [tex]
  );
  const materials = useMemo(
    () => [sideMat, sideMat, darkMat, darkMat, frontMat, darkMat],
    [sideMat, darkMat, frontMat]
  );
  return (
    <mesh position={position} material={materials}>
      <boxGeometry args={size} />
    </mesh>
  );
}

function depthForClass(cls) {
  const c = String(cls || '').toLowerCase();
  if (c.includes('server'))      return 0.65;
  if (c.includes('router'))      return 0.45;
  if (c.includes('switch'))      return 0.32;
  if (c.includes('patch'))       return 0.18;
  if (c.includes('cable'))       return 0.10;
  return 0.30;
}

// ── View: Real 3D (uploaded .glb mesh from Polycam / Object Capture) ────────
function Real3DView({ scanId }) {
  const [blobUrl, setBlobUrl] = useState(null);
  const [filename, setFilename] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Load any previously-saved mesh for this scanId.
  useEffect(() => {
    if (!scanId) return;
    let revoke = null;
    (async () => {
      try {
        const stored = await idbGet(`vrMesh_${scanId}`);
        if (stored && stored.blob) {
          const url = URL.createObjectURL(stored.blob);
          revoke = url;
          setBlobUrl(url);
          setFilename(stored.name || 'rack.glb');
        }
      } catch (e) {
        console.warn('vrMesh load failed:', e);
      }
    })();
    return () => { if (revoke) URL.revokeObjectURL(revoke); };
  }, [scanId]);

  const onPickFile = async (file) => {
    if (!file) return;
    setBusy(true); setError(null);
    try {
      const lower = file.name.toLowerCase();
      const ok = lower.endsWith('.glb') || lower.endsWith('.gltf');
      if (!ok) {
        throw new Error('Please export your scan as .glb (recommended) or .gltf. USDZ isn\'t supported in the web viewer yet.');
      }
      const url = URL.createObjectURL(file);
      setBlobUrl(prev => { if (prev) URL.revokeObjectURL(prev); return url; });
      setFilename(file.name);
      if (scanId) {
        await idbSet(`vrMesh_${scanId}`, { blob: file, name: file.name }).catch(e => {
          console.warn('vrMesh save failed (quota?):', e);
        });
      }
    } catch (e) {
      setError(e?.message || String(e));
    } finally { setBusy(false); }
  };

  const clearMesh = async () => {
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    setBlobUrl(null); setFilename(null);
    if (scanId) await idbDel(`vrMesh_${scanId}`).catch(() => {});
  };

  if (blobUrl) {
    return (
      <>
        <Canvas
          camera={{ position:[2.5, 1.6, 3.2], fov:55, near:0.05, far:80 }}
          gl={{ antialias:true }}
          style={{ position:'absolute', inset:0, touchAction:'none' }}>
          <color attach="background" args={['#0e1830']} />
          <fog attach="fog" args={['#0e1830', 8, 30]} />
          <ambientLight intensity={0.65} />
          <directionalLight position={[4, 7, 5]} intensity={1.0} castShadow />
          <hemisphereLight args={[0x9bb1ff, 0x1f2937, 0.4]} />
          <gridHelper args={[24, 48, '#2e4a78', '#1c2c4a']} />
          <Suspense fallback={null}>
            <UploadedMesh url={blobUrl} />
          </Suspense>
          <OrbitControls enableDamping
            minDistance={0.8} maxDistance={12}
            maxPolarAngle={Math.PI * 0.495} />
        </Canvas>
        <div style={{
          position:'absolute',
          top:'calc(env(safe-area-inset-top, 0px) + 56px)',
          right:14,
          display:'flex', gap:8, zIndex:6,
        }}>
          <span style={{
            background:'rgba(15,23,42,0.7)', backdropFilter:'blur(10px)',
            WebkitBackdropFilter:'blur(10px)',
            border:'1px solid rgba(255,255,255,0.12)',
            borderRadius:999, padding:'6px 12px',
            color:'#cbd5e1', fontSize:10, fontWeight:600,
            maxWidth:160, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap',
          }}>{filename}</span>
          <button onClick={clearMesh}
            style={{
              background:'rgba(15,23,42,0.7)', backdropFilter:'blur(10px)',
              WebkitBackdropFilter:'blur(10px)',
              border:'1px solid rgba(255,255,255,0.12)',
              borderRadius:999, padding:'6px 12px',
              color:'#e5e7eb', fontSize:11, fontWeight:700, letterSpacing:'0.06em',
              textTransform:'uppercase', cursor:'pointer',
            }}>Replace</button>
        </div>
      </>
    );
  }

  return (
    <div style={{
      position:'absolute', inset:0, overflowY:'auto',
      paddingTop:'calc(env(safe-area-inset-top, 0px) + 60px)',
      paddingBottom:'calc(env(safe-area-inset-bottom, 0px) + 180px)',
      paddingLeft:16, paddingRight:16,
      display:'flex', flexDirection:'column', alignItems:'center', gap:16,
    }}>
      <div style={{
        fontSize:10, fontWeight:700, letterSpacing:'0.10em',
        color:'#34d399', textTransform:'uppercase',
      }}>Real 3D mesh</div>
      <p style={{
        fontSize:13, color:'#cbd5e1', maxWidth:360, lineHeight:1.5,
        textAlign:'center', margin:0,
      }}>
        Drop in a 3D scan of your rack. This view renders the actual mesh —
        real geometry, real textures, full walkaround.
      </p>

      <ol style={{
        fontSize:12, color:'#9ca3af', maxWidth:360, lineHeight:1.6,
        paddingLeft:20, margin:0,
      }}>
        <li>On iPhone 17 Pro: open <b style={{color:'#e5e7eb'}}>Polycam</b> (App Store, free) or <b style={{color:'#e5e7eb'}}>Reality Composer</b>.</li>
        <li>Scan the rack — Polycam: "LiDAR" mode; Reality Composer: "Object Capture". ~30–60 s.</li>
        <li>Export → <b style={{color:'#e5e7eb'}}>glTF / GLB</b> (recommended). USDZ also works in Apple apps but not here yet.</li>
        <li>Tap the button below, pick the file from Files app.</li>
      </ol>

      <label className="btn btn-primary" style={{
        display:'flex', alignItems:'center', justifyContent:'center', gap:8,
        cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.6 : 1,
        minWidth:200,
      }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
          <polyline points="17 8 12 3 7 8"/>
          <line x1="12" y1="3" x2="12" y2="15"/>
        </svg>
        {busy ? 'Loading…' : 'Upload .glb / .gltf'}
        <input type="file" accept=".glb,.gltf,model/gltf-binary,model/gltf+json"
          style={{ display:'none' }}
          disabled={busy}
          onChange={(e) => onPickFile(e.target.files?.[0])} />
      </label>

      {error && (
        <p style={{ fontSize:12, color:'#ef4444', textAlign:'center', maxWidth:360 }}>
          {error}
        </p>
      )}

      <p style={{
        fontSize:11, color:'#6b7280', textAlign:'center', maxWidth:360,
        lineHeight:1.5, marginTop:4,
      }}>
        Tip: iPhone 17 Pro's LiDAR gives metric-accurate geometry. Aim for
        even lighting and scan all four sides slowly for the cleanest mesh.
      </p>
    </div>
  );
}

function UploadedMesh({ url }) {
  const gltf = useLoader(GLTFLoader, url);
  const ref = useRef();
  // Center + scale-fit the mesh: most scanner outputs are in meters but
  // origin/orientation varies, so we recenter and scale to a reasonable size.
  useMemo(() => {
    const box = new THREE.Box3().setFromObject(gltf.scene);
    const size = new THREE.Vector3(); box.getSize(size);
    const center = new THREE.Vector3(); box.getCenter(center);
    const target = 2.4; // target longest-axis size in world units
    const longest = Math.max(size.x, size.y, size.z) || 1;
    const scale = target / longest;
    gltf.scene.scale.setScalar(scale);
    // Recenter horizontally, sit on the floor.
    gltf.scene.position.set(
      -center.x * scale,
      -box.min.y * scale + 0.001,
      -center.z * scale
    );
  }, [gltf]);
  return <primitive ref={ref} object={gltf.scene} />;
}

// ── View: 360° walkaround (4-side uploader + textured cube) ─────────────────
const SIDES = [
  { key: 'front', label: 'Front' },
  { key: 'right', label: 'Right' },
  { key: 'back',  label: 'Back'  },
  { key: 'left',  label: 'Left'  },
];

function SidesView({ scanId, frontFallback }) {
  const storageKey = scanId ? `vrSides_${scanId}` : null;
  const [sides, setSides] = useState(() => loadSides(storageKey));
  const [busy, setBusy]   = useState(null); // 'video' | 'side:<key>' | null
  const [error, setError] = useState(null);

  const allFilled = SIDES.every(s => !!sides[s.key]);
  const [editing, setEditing] = useState(!allFilled);

  const setSide = (k, dataUrl) => {
    const next = { ...sides, [k]: dataUrl };
    setSides(next);
    saveSides(storageKey, next);
  };

  const onPickSide = async (k, file) => {
    if (!file) return;
    setBusy(`side:${k}`); setError(null);
    try {
      const dataUrl = await fileToScaledDataURL(file, 900);
      setSide(k, dataUrl);
    } catch (e) {
      setError(`Failed to read ${k} image: ${e?.message || e}`);
    } finally { setBusy(null); }
  };

  const onPickVideo = async (file) => {
    if (!file) return;
    setBusy('video'); setError(null);
    try {
      const frames = await videoToFourFrames(file, 900);
      const next = { ...sides, ...frames };
      setSides(next);
      saveSides(storageKey, next);
    } catch (e) {
      setError(`Couldn't extract frames: ${e?.message || e}`);
    } finally { setBusy(null); }
  };

  if (!editing && allFilled) {
    return <Sides3DScene sides={sides} onEdit={() => setEditing(true)} />;
  }
  return (
    <SidesUploader sides={sides} frontFallback={frontFallback}
      busy={busy} error={error}
      onPickSide={onPickSide} onPickVideo={onPickVideo}
      onDone={() => setEditing(false)}
      canDone={SIDES.some(s => !!sides[s.key])} />
  );
}

function SidesUploader({ sides, frontFallback, busy, error, onPickSide, onPickVideo, onDone, canDone }) {
  const allFilled = SIDES.every(s => !!sides[s.key]);
  return (
    <div style={{
      position:'absolute', inset:0, overflowY:'auto',
      paddingTop:'calc(env(safe-area-inset-top, 0px) + 60px)',
      paddingBottom:'calc(env(safe-area-inset-bottom, 0px) + 180px)',
      paddingLeft:16, paddingRight:16,
      display:'flex', flexDirection:'column', alignItems:'center', gap:16,
    }}>
      <div style={{
        fontSize:10, fontWeight:700, letterSpacing:'0.10em',
        color:'#34d399', textTransform:'uppercase',
      }}>360° Walkaround</div>
      <p style={{
        fontSize:13, color:'#cbd5e1', maxWidth:340, lineHeight:1.5,
        textAlign:'center', margin:0,
      }}>
        Walk around your rack and capture all four sides. Each photo wraps
        onto the matching face of a 3D model so you can orbit it like the real thing.
      </p>

      <div style={{
        display:'grid', gridTemplateColumns:'repeat(2, 1fr)', gap:12,
        width:'100%', maxWidth:360,
      }}>
        {SIDES.map(s => (
          <SideSlot key={s.key} side={s}
            image={sides[s.key] || (s.key === 'front' ? frontFallback : null)}
            isFallback={!sides[s.key] && s.key === 'front' && !!frontFallback}
            busy={busy === `side:${s.key}`}
            onPick={(f) => onPickSide(s.key, f)} />
        ))}
      </div>

      <div style={{ display:'flex', flexDirection:'column', gap:8, width:'100%', maxWidth:360 }}>
        <label className="btn btn-primary" style={{
          display:'flex', alignItems:'center', justifyContent:'center', gap:8,
          cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.6 : 1,
        }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="23 7 16 12 23 17 23 7"/>
            <rect x="1" y="5" width="15" height="14" rx="2"/>
          </svg>
          {busy === 'video' ? 'Extracting frames…' : 'Record walkaround video'}
          <input type="file" accept="video/*" capture="environment"
            style={{ display:'none' }}
            disabled={!!busy}
            onChange={(e) => onPickVideo(e.target.files?.[0])} />
        </label>
        <p style={{
          fontSize:11, color:'#9ca3af', textAlign:'center', margin:0, lineHeight:1.4,
        }}>
          Start facing the front, walk clockwise around the rack. We'll auto-extract
          four frames: front, right, back, left.
        </p>
      </div>

      {error && (
        <p style={{ fontSize:12, color:'#ef4444', textAlign:'center', maxWidth:340 }}>
          {error}
        </p>
      )}

      {canDone && (
        <button className="btn btn-primary"
          onClick={onDone}
          style={{ marginTop:4 }}>
          {allFilled ? 'View in 3D' : 'Preview with what I have'}
        </button>
      )}
    </div>
  );
}

function SideSlot({ side, image, isFallback, busy, onPick }) {
  return (
    <label style={{
      position:'relative', display:'block', borderRadius:12, overflow:'hidden',
      aspectRatio:'3 / 4',
      background:'rgba(15,23,42,0.55)',
      border: image ? '1px solid rgba(59,130,246,0.35)' : '1px dashed rgba(255,255,255,0.18)',
      cursor: busy ? 'wait' : 'pointer',
    }}>
      {image ? (
        <img src={image} alt={side.label}
          style={{
            position:'absolute', inset:0, width:'100%', height:'100%',
            objectFit:'cover', opacity: isFallback ? 0.55 : 1,
          }} />
      ) : (
        <div style={{
          position:'absolute', inset:0,
          display:'flex', alignItems:'center', justifyContent:'center',
          color:'rgba(255,255,255,0.4)', fontSize:28,
        }}>+</div>
      )}
      <div style={{
        position:'absolute', top:6, left:8,
        fontSize:10, fontWeight:700, letterSpacing:'0.10em',
        color:'#fff', textTransform:'uppercase',
        textShadow:'0 1px 2px rgba(0,0,0,0.8)',
      }}>
        {side.label}{isFallback ? ' · Scan' : ''}
      </div>
      {busy && (
        <div style={{
          position:'absolute', inset:0, background:'rgba(0,0,0,0.6)',
          display:'flex', alignItems:'center', justifyContent:'center',
          color:'#cbd5e1', fontSize:11,
        }}>Loading…</div>
      )}
      <input type="file" accept="image/*" capture="environment"
        style={{ display:'none' }}
        disabled={!!busy}
        onChange={(e) => onPick(e.target.files?.[0])} />
    </label>
  );
}

function Sides3DScene({ sides, onEdit }) {
  return (
    <>
      <Canvas camera={{ position:[2.2, 1.4, 3.0], fov:55, near:0.05, far:60 }}
              gl={{ antialias:true }}
              style={{ position:'absolute', inset:0, touchAction:'none' }}>
        <color attach="background" args={['#0e1830']} />
        <fog attach="fog" args={['#0e1830', 6, 18]} />
        <ambientLight intensity={0.6} />
        <directionalLight position={[3, 5, 4]} intensity={0.9} />
        <hemisphereLight args={[0x9bb1ff, 0x1f2937, 0.35]} />
        <gridHelper args={[24, 48, '#2e4a78', '#1c2c4a']} />
        <Suspense fallback={null}>
          <TexturedRack sides={sides} />
        </Suspense>
        <OrbitControls target={[0, 1.1, 0]} enableDamping
          minDistance={1.4} maxDistance={6.5}
          maxPolarAngle={Math.PI * 0.495} />
      </Canvas>
      <button onClick={onEdit}
        style={{
          position:'absolute',
          top:'calc(env(safe-area-inset-top, 0px) + 56px)',
          right:14,
          background:'rgba(15,23,42,0.7)', backdropFilter:'blur(10px)',
          WebkitBackdropFilter:'blur(10px)',
          border:'1px solid rgba(255,255,255,0.12)',
          borderRadius:999, padding:'6px 12px',
          color:'#e5e7eb', fontSize:11, fontWeight:700, letterSpacing:'0.06em',
          textTransform:'uppercase', cursor:'pointer', zIndex:6,
        }}>
        Retake sides
      </button>
    </>
  );
}

function TexturedRack({ sides }) {
  const [tFront, tRight, tBack, tLeft] = useLoader(THREE.TextureLoader, [
    sides.front, sides.right, sides.back, sides.left,
  ]);
  useMemo(() => {
    for (const t of [tFront, tRight, tBack, tLeft]) {
      if (t) t.colorSpace = THREE.SRGBColorSpace;
    }
  }, [tFront, tRight, tBack, tLeft]);

  // Front photo defines width; left/right photo defines depth. Height = 2.2m.
  const dims = useMemo(() => {
    const h = 2.2;
    const arFront = tFront?.image ? tFront.image.width / tFront.image.height : 0.55;
    const arSide  = tLeft?.image  ? tLeft.image.width  / tLeft.image.height  : 0.55;
    return { width: h * arFront, height: h, depth: h * arSide };
  }, [tFront, tLeft]);

  // Box face material order: [+X, -X, +Y, -Y, +Z, -Z]
  // We treat +Z as the front of the rack (toward camera at start).
  const materials = useMemo(() => ([
    new THREE.MeshBasicMaterial({ map: tRight, toneMapped: false }),
    new THREE.MeshBasicMaterial({ map: tLeft,  toneMapped: false }),
    new THREE.MeshStandardMaterial({ color: '#1f2937' }),
    new THREE.MeshStandardMaterial({ color: '#1f2937' }),
    new THREE.MeshBasicMaterial({ map: tFront, toneMapped: false }),
    new THREE.MeshBasicMaterial({ map: tBack,  toneMapped: false }),
  ]), [tFront, tRight, tBack, tLeft]);

  return (
    <group>
      <mesh position={[0, dims.height / 2 + 0.02, 0]} material={materials}>
        <boxGeometry args={[dims.width, dims.height, dims.depth]} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.001, 0]}>
        <circleGeometry args={[Math.max(dims.width, dims.depth) * 1.4, 48]} />
        <meshBasicMaterial color="#1d3a72" transparent opacity={0.22} />
      </mesh>
    </group>
  );
}

// ── helpers ────────────────────────────────────────────────────────────────
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

function colorForClass(cls) {
  const c = String(cls || '').toLowerCase();
  if (c.includes('switch'))  return '#22d3ee';
  if (c.includes('patch'))   return '#a78bfa';
  if (c.includes('server'))  return '#f59e0b';
  if (c.includes('router'))  return '#10b981';
  return '#94a3b8';
}

function loadSides(key) {
  if (!key) return {};
  try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch { return {}; }
}
function saveSides(key, sides) {
  if (!key) return;
  try { localStorage.setItem(key, JSON.stringify(sides)); } catch (e) {
    console.warn('vrSides save failed (quota?)', e);
  }
}

function loadImage(src) {
  return new Promise((res, rej) => {
    const i = new Image();
    i.onload  = () => res(i);
    i.onerror = rej;
    i.src = src;
  });
}

async function fileToScaledDataURL(file, maxDim) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    return drawScaled(img, img.width, img.height, maxDim);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function drawScaled(source, srcW, srcH, maxDim) {
  const ratio = Math.min(1, maxDim / Math.max(srcW, srcH));
  const w = Math.max(1, Math.round(srcW * ratio));
  const h = Math.max(1, Math.round(srcH * ratio));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(source, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', 0.85);
}

// Tiny IndexedDB helpers for storing uploaded meshes (too big for localStorage).
const IDB_NAME = 'racktrack-vr';
const IDB_STORE = 'kv';
function idbOpen() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });
}
async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const r = tx.objectStore(IDB_STORE).get(key);
    r.onsuccess = () => res(r.result);
    r.onerror   = () => rej(r.error);
  });
}
async function idbSet(key, value) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => res();
    tx.onerror    = () => rej(tx.error);
  });
}
async function idbDel(key) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(key);
    tx.oncomplete = () => res();
    tx.onerror    = () => rej(tx.error);
  });
}

async function videoToFourFrames(file, maxDim) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true; video.playsInline = true;
  video.preload = 'auto';
  video.src = url;
  try {
    await new Promise((res, rej) => {
      video.onloadedmetadata = () => res();
      video.onerror = () => rej(new Error('video load failed'));
    });
    const dur = video.duration;
    if (!isFinite(dur) || dur < 0.4) throw new Error('Video too short or invalid');
    const ts = [0.02, 0.27, 0.52, 0.77].map(p => Math.min(dur - 0.05, p * dur));
    const out = [];
    for (const t of ts) {
      video.currentTime = t;
      await new Promise(res => { video.onseeked = () => res(); });
      out.push(drawScaled(video, video.videoWidth || 720, video.videoHeight || 1280, maxDim));
    }
    return { front: out[0], right: out[1], back: out[2], left: out[3] };
  } finally {
    URL.revokeObjectURL(url);
  }
}

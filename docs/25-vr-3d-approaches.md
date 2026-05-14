# 25. VR / 3D Visualization Approaches

This catalog covers every realistic way to render a "real" rack in 3D inside
RackTrack's VR mode. Each section answers: **how it works**, **what the user
has to do**, **what we can show them**, **realism**, **build effort**,
**runtime cost**, **GPU / compute needs**, **pros**, **cons**.

The approaches are roughly ordered from cheapest/least-real to most-expensive/
most-real. Mix-and-match is expected — for example, today's VR page combines
approaches 2 + 3 + 4 + topology.

---

## At-a-glance matrix

| # | Approach                              | User input             | Output                    | Realism      | Build effort   | Per-scan time | GPU needed                  |
|---|---------------------------------------|------------------------|---------------------------|--------------|----------------|---------------|-----------------------------|
| 1 | Photo + detection labels              | 1 photo                | 2D overlay                | none (2D)    | ½ day          | instant       | none                        |
| 2 | Photo wrapped on a chassis            | 1 photo                | Flat plane on cube        | low          | ½ day          | instant       | any (mobile fine)           |
| 3 | 4-side textured cube                  | 4 photos OR 360° video | Textured cube             | low–mid      | 1 day          | instant       | any (mobile fine)           |
| 4 | Per-device box stack                  | 1 photo + detections   | Faceted stack of boxes    | mid          | 1 day          | <1s           | any (mobile fine)           |
| 5 | Monocular depth (MiDaS / Depth-Anything) | 1 photo             | 2.5D surface relief       | mid–high     | 3–5 days       | 0.2–2s        | mobile NN delegate OR server|
| 6 | Multi-view stereo from video (SfM)    | 30s 360° video         | Sparse point cloud + cams | mid–high     | 2 weeks + svc  | 1–5 min       | server CPU OK, GPU faster   |
| 7 | Dense MVS → textured mesh             | 30s 360° video         | Watertight textured mesh  | high         | 3–4 weeks + svc| 5–20 min      | server GPU recommended      |
| 8 | NeRF                                  | 60s video, 30+ frames  | Neural radiance field     | high         | 4–8 weeks      | 30 min – hrs  | server GPU required (≥8 GB) |
| 9 | 3D Gaussian Splatting                 | 60s video, 30+ frames  | Splat cloud (.ply)        | very high    | 4–8 weeks      | 30–90 min     | server GPU required (≥12 GB)|
|10 | LiDAR direct capture                  | iPhone Pro / S25 Ultra | Mesh + textures           | high         | 2 weeks        | real-time     | device LiDAR sensor         |

"Build effort" assumes integrating cleanly into the current `VRPage.jsx`,
including UI, loading states, error handling, and storage. "Per-scan time"
is processing time, not capture time.

---

## 1. Photo + detection labels

**How it works.** Render the original scan photo full-screen with the detected
device bounding boxes overlaid as colored rectangles, labeled by class
(switch, patch panel, server, router). No 3D involved — pure SVG over an
`<img>` with `objectFit: contain` and a `viewBox` in image pixels.

**User does.** Nothing beyond the normal scan.

**We show.** The literal photo with named device outlines. Tap a box to drill
into that device.

**Implementation.**
1. `<img>` with `objectFit: contain`.
2. Overlay `<svg viewBox="0 0 W H" preserveAspectRatio="xMidYMid meet">`.
3. For each device, draw a `<rect>` at its `bbox` (in image pixel coords) plus
   a `<text>` label.
4. Bbox normalization is already in `ScanPage.jsx` (`normalizeBbox`) — reuse it.

**Realism.** None — it's a 2D image. But it's the **most faithful** thing we
can show: it *is* the user's photo.

**Time to build.** Half a day.
**Time per scan.** Instant — pure rendering.
**GPU.** None.
**Pros.** Trivial. No misinterpretation — they see the actual photo.
**Cons.** Not 3D, can't "walk around." Not what you'd call "VR."

---

## 2. Single photo wrapped on a chassis

**How it works.** Put the photo on a flat plane in a Three.js scene, with a
dark box behind it to give visual thickness, on a grid floor. User orbits
with finger. The front face looks photoreal; sides/back are abstract.

**User does.** Nothing beyond the normal scan.

**We show.** A 3D scene where the front of "their" rack is the literal photo,
floating above a grid floor. Drag to rotate.

**Implementation.** (Currently shipping as the **Photo · 3D** view.)
```jsx
<Canvas>
  <ambientLight /><directionalLight />
  <gridHelper />
  <group>
    <mesh position={[0, yc, depth/2]}>
      <planeGeometry args={[w, h]} />
      <meshBasicMaterial map={tex} toneMapped={false} />
    </mesh>
    <mesh position={[0, yc, 0]}>
      <boxGeometry args={[w*1.02, h*1.02, depth]} />
      <meshStandardMaterial color="#111827" />
    </mesh>
  </group>
  <OrbitControls />
</Canvas>
```
Set `tex.colorSpace = THREE.SRGBColorSpace` so the photo doesn't oversaturate.

**Realism.** Low. From a head-on angle it looks fine; from oblique angles the
flat-plane illusion breaks.

**Time to build.** Half a day. *Already shipped.*
**Time per scan.** Instant — one texture load.
**GPU.** Any. Mobile GPUs run this at 60 fps easily.
**Pros.** Zero extra capture. Photoreal head-on. Cheap.
**Cons.** Sides are abstract. Doesn't show device protrusion / depth.

---

## 3. Four-side textured cube

**How it works.** User uploads (or shoots a video of) four sides — front,
right, back, left. Each photo wraps onto the corresponding face of a 3D box.
Orbit and see each side from its native angle.

**User does.** Either:
- Tap four upload slots and shoot/pick a photo per side, OR
- Record a single ~15 s video walking clockwise around the rack. We
  auto-extract frames at 2%, 27%, 52%, 77% of duration and assign them to
  front/right/back/left.

**We show.** A box you can orbit. Each face is one of the user's photos.

**Implementation.** (Currently shipping as the **360°** view.)
- 4 slots in a 2×2 grid backed by `<input type="file" accept="image/*" capture="environment">`.
- Video extraction: `<video>` element → seek to N timestamps → draw to
  `<canvas>` → `canvas.toDataURL('image/jpeg', 0.85)`. See `videoToFourFrames`
  in `client/src/pages/VRPage.jsx`.
- Box geometry with material array order `[+X, -X, +Y, -Y, +Z, -Z]` →
  `[right, left, top, bottom, front, back]`. Top/bottom kept dark.
- Persist data URLs in `localStorage` under `vrSides_<scanId>` (downscale to
  ≤900 px so 4 sides fit under the ~5 MB quota).

**Realism.** Low–mid. Genuinely "their rack" from each cardinal direction,
but corners and oblique angles look like a textured box because they are.

**Time to build.** ~1 day. *Already shipped.*
**Time per scan.** Instant once captures are in. Video frame extraction takes
~2 s on a phone for a 15 s clip.
**GPU.** Any. 4 textures at 900 px ≈ 12 MB VRAM, trivial.
**Pros.** Genuinely walk-around. Reuses the user's own photos.
**Cons.** Still cube-shaped — no real geometry. Corners look obviously
billboarded. Requires extra capture step beyond the normal scan.

---

## 4. Per-device box stack ★ *(this PR)*

**How it works.** We already detect every device in the rack with a bounding
box and a class. Instead of one flat photo, build the rack as a *stack* of
small textured boxes — one per detected device — each sized to its bbox in
image-space and depth-extruded by class (servers thick, patch panels thin).
The front face of each box is a *crop* of the photo at that device's bbox.

**User does.** Nothing beyond the normal scan.

**We show.** A rack frame with rails, and a column of separate boxes inside.
Each box's front face is the cropped photo of that specific device. Servers
poke out further than patch panels. From oblique angles you actually see the
profile of each device, not a flat front.

**Implementation.** (Shipping as the **Rack · 3D** view in `VRPage.jsx`.)
1. Load the source image into an offscreen `<canvas>`.
2. For each device:
   - Read its bbox via `normalizeBbox` (same helper used in AR mode).
   - Crop the canvas at the bbox; downscale longest edge to ≤640 px.
   - `canvas.toDataURL('image/jpeg', 0.88)` → texture data URL.
3. Compute world-space coords: rack height = 2.2 m; rack width = 2.2 ×
   (imgW / imgH). Each device's center maps from normalized bbox center
   `(cx, cy)` to world `((cx − 0.5) × rackW, (1 − cy) × rackH)`.
4. Depth by class: server 0.65 m, router 0.45 m, switch 0.32 m, patch panel
   0.18 m, cable manager 0.10 m, default 0.30 m.
5. Box geometry per device with a 6-material array: front face = photo crop
   texture, sides = class-accent color, top/bottom/back = dark.

**Realism.** Mid. Big jump in perceived fidelity vs flat plane: it actually
looks like a rack with stuff in it, not a sticker on a slab. You can see the
3D *profile* of each device when you orbit.

**Time to build.** ~1 day. *Shipped.*
**Time per scan.** <1 s — pure canvas operations.
**GPU.** Mobile fine. Each device texture is ~640 px square or smaller; a
typical rack has 8–25 devices → 8–25 textures.
**Pros.** Zero extra capture. Uses data we already have. Looks dramatically
more like a real rack than approach 2. Each box is interactive (can
hook into the existing port/device drill-down).
**Cons.** Sides and back of each device are placeholder colors. Devices that
weren't detected won't appear. Depth-by-class is a guess, not measured.

---

## 5. Monocular depth estimation

**How it works.** Run a monocular depth-estimation model on the front photo
(MiDaS, Depth-Anything, ZoeDepth) to predict a per-pixel depth map. Use the
depth map as a **displacement texture** in Three.js so the front face has
genuine surface relief — switch faceplates poke out, recessed ports actually
dip in.

**Models.**
- **MiDaS v3.1 small** (`midas-small-v21`): ONNX ~21 MB, mobile-friendly.
  Relative depth only (no metric scale). ~150–500 ms on a phone NPU.
- **Depth-Anything-V2 small** (2024): ~30 MB ONNX, much better edges than
  MiDaS. 200–800 ms on phone, 30–80 ms on a server GPU.
- **ZoeDepth**: gives metric depth (in meters), but slower (~1 s on GPU) and
  needs more careful preprocessing.

**User does.** Nothing — runs on the existing single photo. Optional: a
"reshoot at higher resolution" prompt if depth quality looks poor.

**We show.** Same scene as approach 2, but the front plane is now a high-poly
plane with vertex displacement driven by the depth map. Devices have
genuine 3D surface. Sides remain abstract (only one viewing angle has depth
data).

**Implementation outline.**
1. Bundle the ONNX model as a static asset (`/models/depth-anything-small.onnx`).
2. Run inference with `onnxruntime-web`. The repo already uses this pattern
   for detection — see `client/src/utils/...`. Note the prior native-ORT
   issue with INT8 dynamic quantization (memory: `native_ort_dead_end`); use
   the bundled WASM path or a static-INT8 build.
3. Output: H×W float32 array, values 0 (near) to 1 (far) for relative models,
   or meters for ZoeDepth.
4. Build a `<planeGeometry args={[w, h, segW, segH]} />` with segW, segH ≈ 200.
   In a custom shader (or via `displacementMap`), offset Z by depth × strength.
5. Strength is empirical — start at 0.15 m × rackHeight, expose a slider.

**Realism.** Mid–high *from the front*. Sides still abstract. Best result
when the camera was roughly perpendicular to the rack.

**Time to build.** 3–5 days (model integration + shader + UI tuning).
**Time per scan.** 0.2–2 s depending on model + device. Cached after first run.
**GPU.** Phone NPU/GPU via ORT WASM/WebGPU, OR a small backend GPU. CPU
fallback works but is ~3–5× slower.
**Pros.** Genuine surface relief from a single existing photo. No new capture.
**Cons.** Front-only — back/sides still flat. Relative depth needs a scale
guess. Depth errors at edges (haloing). Adds 20–30 MB to bundle if model
ships in-app.

---

## 6. Sparse multi-view stereo (Structure-from-Motion)

**How it works.** User shoots a 30 s 360° video. Backend extracts frames,
detects feature points (SIFT, ORB), matches them across pairs, triangulates a
sparse 3D point cloud + each frame's camera pose. This is the foundation
step that *every* later approach builds on.

**Tooling.**
- **COLMAP** (open-source, C++): the gold standard. GPU optional for SIFT
  matching, dramatically faster with one. Outputs `.ply` point cloud and
  `cameras.bin`/`images.bin`.
- **OpenMVG** (open-source, lighter than COLMAP). Pure CPU works.
- **AliceVision Meshroom** (open-source, node-based GUI). Wraps both.

**User does.** Records a 30 s walkaround video. App uploads to backend, polls
for status, then either views the result here or in the topology tab.

**We show.** A sparse 3D point cloud of the rack — looks like a constellation
of dots roughly outlining devices. Not pretty alone, but it's required
infrastructure for everything below.

**Implementation outline.**
1. Frontend: upload `video/mp4` to `/api/recon/sfm` along with `scanId`.
2. Backend service (new): worker queue (BullMQ / Celery). On job pick:
   - `ffmpeg -i in.mp4 -vf "fps=2" frames/%04d.jpg` → ~60 frames.
   - `colmap automatic_reconstructor --workspace_path ws --image_path frames`.
   - Output `.ply` and `cameras.txt`.
3. Stream progress over WebSocket / SSE so the UI can show a progress bar.
4. View: `three.js` `PointsMaterial` with the `.ply` → sprite per point.

**Realism.** Mid. Geometrically real, but visually sparse.

**Time to build.** 2 weeks plus the backend service (CI/CD, storage, queue,
auth). Plan for ops time too.
**Time per scan.** 1–5 min CPU, 30 s–2 min with a GPU. Plus ~15 s upload on
LTE.
**GPU.** CPU works, GPU ≥4 GB cuts time by ~5×.
**Pros.** True 3D geometry. Foundation for everything else.
**Cons.** Sparse output is ugly on its own. Big backend lift. Loss
of reliability points if reconstruction fails on shiny / featureless racks.

---

## 7. Dense MVS → textured mesh

**How it works.** Take the sparse SfM output from #6 and densify it: for each
camera pair, run patch-match stereo to fill in dense depth, then fuse depths
into a triangle mesh, then bake textures onto it from the original frames.

**Tooling.** Same as #6: COLMAP's `patch_match_stereo` + `stereo_fusion` +
`delaunay_mesher`, or AliceVision's MVS pipeline.

**User does.** Same as #6 — one 30 s video.

**We show.** A textured 3D mesh of the rack you can rotate, zoom, and walk
around. Holes are unavoidable on shiny / featureless surfaces but the
overall shape is genuinely the user's rack.

**Implementation outline.**
1. Extend the worker from #6 with mesh + texture steps:
   - `colmap patch_match_stereo` (slow — biggest GPU win here).
   - `colmap stereo_fusion` → fused dense point cloud.
   - `colmap delaunay_mesher` → triangle mesh.
   - Texturing: AliceVision `Texturing` node or Meshlab CLI.
   - Convert OBJ + texture → `.glb` with `gltfpack` for compact streaming.
2. Frontend: load `.glb` via `<useGLTF>` from drei. Cache in IndexedDB.

**Realism.** High. The user is genuinely walking around a 3D model of their
rack.

**Time to build.** 3–4 weeks including backend, queue, storage, retries.
**Time per scan.** 5–20 min on a server GPU. CPU-only is ~30–90 min — borderline
usable.
**GPU.** Server GPU strongly recommended (RTX 4090 / A10 / L4). 8 GB minimum.
**Pros.** True walkaround. Industry-standard pipeline. Outputs are reusable
(can hand the `.glb` to other systems).
**Cons.** Heaviest non-AI option. Failure modes are real (featureless metal
panels are tough). Storage cost: ~3–10 MB per rack mesh.

---

## 8. NeRF (Neural Radiance Fields)

**How it works.** Train a small neural network that, given any camera ray
`(origin, direction)`, returns the color and density along that ray. The
network is trained per-rack from the input video frames. Once trained, you
can render the rack from any angle by ray-marching the network.

**Tooling.**
- **Instant-NGP** (NVIDIA, CUDA only): the fast one. Trains in 5–15 min.
- **Nerfstudio** (Python, open): unified framework with multiple model
  variants (Nerfacto, etc.). Trains in 15–60 min.

**User does.** Records a 60 s walkaround with deliberate overlap. Quality
benefits from waving the camera slowly side-to-side rather than purely
rotating.

**We show.** A free-orbit view of the rack rendered by the neural network.
Looks photoreal from trained angles, hallucinates plausibly from unseen ones.
Renders in real-time after training.

**Implementation outline.**
1. Same upload + queue infra as #6/7.
2. Worker runs Nerfstudio: `ns-train nerfacto --data ./frames`. Output is a
   checkpoint, not a mesh.
3. Two ways to view in-app:
   - **Bake to mesh/splat** (recommended): Nerfstudio's `ns-export` → `.glb`.
     Loses some quality. Same render path as #7.
   - **Live NeRF rendering**: needs a custom WebGPU renderer (e.g.
     `nerfstudio-viewer`, `volinga.ai`). High effort.

**Realism.** High. View synthesis from arbitrary angles, including
view-dependent effects (reflections on the rack metal).

**Time to build.** 4–8 weeks if going beyond simple bake-to-mesh.
**Time per scan.** 30 min – 2 hrs train on server GPU. Render is real-time.
**GPU.** Server GPU **required**. Instant-NGP needs CUDA; ≥8 GB VRAM.
**Pros.** Best-in-class photoreal at the time of writing (pre-Gaussian-Splatting).
View-dependent shading.
**Cons.** Heavyweight infra. Per-rack training cost in $$. Live rendering
requires custom WebGPU code or a streaming server. Mostly superseded by
Gaussian Splatting now.

---

## 9. 3D Gaussian Splatting

**How it works.** Represent the rack as millions of tiny anisotropic 3D
Gaussian "splats," each with position, scale, rotation, opacity, and a
view-dependent color (spherical harmonics). Optimize the parameters of all
splats so that, rendered from the training cameras, they match the input
images. Renderer is rasterization, not ray-marching, so it's *fast*.

**Tooling.**
- **gaussian-splatting** (Inria, official): CUDA-only training.
- **Brush**: pure WebGPU training+viewing (slower but no CUDA).
- **Polycam** / **Luma** SDK: hosted, paid.
- **Mast3R**: feed-forward variant — no per-scene optimization, lower
  quality but seconds instead of an hour. Good for previews.

**User does.** Records a 60 s walkaround. Same capture flow as NeRF.

**We show.** A high-fidelity orbit-able rendering. Generally better-looking
than NeRF, and 5–10× faster to train. Renders well in-browser via WebGL or
WebGPU viewers (`gsplat.js`, `antimatter15/splat`).

**Implementation outline.**
1. Same upload + queue.
2. Worker: `python train.py -s ./scene_data --iterations 7000` (Inria repo).
   Outputs a `.ply` of splats (typical: 50–500 MB raw, 5–30 MB compressed).
3. Compress with `gsplat`'s INRIA-format compressor or
   [`SuperSplat`](https://playcanvas.com/supersplat).
4. View: `@gsplat.js/web` viewer component dropped into the existing
   fullscreen page.

**Realism.** Very high — currently the best balance of quality / training
time / render speed for novel-view synthesis.

**Time to build.** 4–8 weeks; render side is the easier half — backend infra
is the bigger lift.
**Time per scan.** 30–90 min train on server GPU. Faster with Mast3R-style
feed-forward (~30 s) at lower quality.
**GPU.** Server GPU required for high quality (≥12 GB VRAM for clean training).
**Pros.** State of the art. WebGL render works on mobile. Compressed splats
stream nicely.
**Cons.** Big training files. Same backend infra burden as NeRF/MVS. Hard to
edit / animate (splats aren't a mesh). Has trouble with reflective metal.

---

## 10. LiDAR direct capture

**How it works.** Use the LiDAR scanner on iPhone Pro / iPad Pro (or the few
Android phones with ToF — Galaxy S25 Ultra, Pixel 8 Pro). The phone outputs
a depth mesh + RGB textures directly; no reconstruction needed.

**Tooling.**
- **iOS**: ARKit's `ARMeshAnchor` (per-mesh chunks) or RoomPlan
  (`RoomCaptureSession` for whole-room captures, generates simple meshes).
  Output: USDZ or OBJ.
- **Android**: ARCore Depth API + a custom mesh-extraction step. Far less
  mature than iOS.

**User does.** Slowly walks around the rack with the phone for ~30 s,
following an on-screen guide.

**We show.** The captured mesh + texture, rendered directly. Genuine
geometric ground truth.

**Implementation outline.**
1. Native plugin (Capacitor): wrap `ARMeshAnchor` capture loop. Save USDZ
   plus a JPEG of each face's texture.
2. Convert USDZ → `.glb` with `usd_from_gltf` or
   `usdview`'s exporter.
3. Same `.glb` viewer as approaches 7/9.

**Realism.** High geometric, mid–high visual (LiDAR textures aren't always
crisp).

**Time to build.** ~2 weeks per platform (iOS first, Android later).
**Time per scan.** Real-time capture; zero post-processing for iOS RoomPlan.
**GPU.** Device — the LiDAR sensor and Apple Neural Engine do the work.
**Pros.** No backend service. Zero training time. Geometrically accurate by
construction.
**Cons.** Restricted to a small set of devices. iOS-only for the good path.
LiDAR doesn't see through glass / over reflective surfaces (rack doors,
patch-panel covers).

---

## Capture quality tips (for any video-based approach: 6–9)

- **Hold the phone steady, walk slowly.** 30 s minimum for a 4×4×2 m rack.
- **Overlap matters more than coverage.** Adjacent video frames should share
  ~70% of the visible content. A 360° lap at walking pace usually achieves
  this.
- **Even lighting.** Rolling shutter + flickering server LEDs murder SfM.
- **Avoid pure rotation.** Translate as well as rotate — pure rotation gives
  SfM zero parallax to work with.
- **Watch for reflections.** Glass doors and metal rails confuse all feature
  matchers; pre-open the rack if possible.

---

## Recommended path forward

Today the VR page ships approaches **2, 3, 4** plus the existing **Topology**
view. Suggested order to ship the rest:

1. **Now (free, in-app):** Done — approaches 2, 3, 4 are live.
2. **Next (~1 week, no backend):** Approach **5 (monocular depth)**. Single
   biggest realism jump from data we already have. Bundle Depth-Anything-V2
   small via `onnxruntime-web`.
3. **Once a recon backend exists (~1 month):** Approach **9 (Gaussian
   Splatting)** as the "premium" view. Skip MVS and NeRF — Splatting is
   strictly better at the same infra cost.
4. **Future, opt-in for Pro phones:** Approach **10 (LiDAR)** for users with
   the hardware. Tag the resulting model as "scan-verified."

Each step is independently shippable — the toggle picks whichever views the
current scan can support, and the others stay hidden.

---

## File references

- `client/src/pages/VRPage.jsx` — all in-app views (approaches 1–4 today).
- `client/src/pages/TopologyScene3D.jsx` — the abstract Topology view.
- `client/src/pages/ScanPage.jsx` — entry point + `normalizeBbox`, `colorForClass`.
- `client/src/utils/api.js` — `authFetch` / `apiUrl` for the backend services
  that approaches 5–9 would add.
- `client/package.json` — three / @react-three/fiber / @react-three/drei are
  already deps; `onnxruntime-web` is also present from the detection
  pipeline (re-usable for approach 5).

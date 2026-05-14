import { useState, useRef, useEffect } from 'react';
import * as ort from 'onnxruntime-web/wasm';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { OrtNative } from '../plugins/OrtNative';

ort.env.wasm.wasmPaths = '/ort-wasm/';
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;

// Backend toggle helpers.
async function openSession(backend, modelFile) {
  const t0 = performance.now();
  if (backend === 'native') {
    const handle = await OrtNative.loadSession({
      modelPath: `/models/${modelFile}`,
      useNnapi: false,   // CPU first; NNAPI can come later once load works.
    });
    return { backend, handle, loadMs: handle.loadMs };
  }
  const s = await ort.InferenceSession.create(`/models/${modelFile}`, {
    executionProviders: ['wasm'],
  });
  return { backend, session: s, loadMs: performance.now() - t0 };
}

async function runOne(sess, dataUrl, inputSize) {
  if (sess.backend === 'native') {
    const r = await OrtNative.runFromDataUrl({
      sessionId: sess.handle.sessionId,
      dataUrl,
      inputSize,
    });
    return {
      dims: r.dims,
      data: new Float32Array(r.output),
      inferMs: r.inferMs,
      letterbox: r.letterbox,
    };
  }
  const tensor = await preprocess(dataUrl, inputSize);
  const t0 = performance.now();
  const out = await sess.session.run({ [sess.session.inputNames[0]]: tensor });
  const inferMs = performance.now() - t0;
  const firstOut = out[sess.session.outputNames[0]];
  return { dims: firstOut.dims, data: firstOut.data, inferMs };
}

async function closeSession(sess) {
  if (sess.backend === 'native') {
    await OrtNative.releaseSession({ sessionId: sess.handle.sessionId });
  } else {
    await sess.session.release();
  }
}

// CONF was 0.12 to catch dynamic-INT8 detections that had compressed
// confidence. With FP32 native we get the full confidence range back, so
// 0.25 drops the long tail of low-quality duplicates while still keeping
// every real detection (server uses 0.20-0.25 too).
const CONF_THRESH = 0.25;
// NMS IoU = 0.3 (was 0.45) — merge more aggressively. YOLOv8 produces
// many slightly-offset anchors for the same physical object; at 0.45
// many of these survive as visual duplicates on the same port/device.
const NMS_IOU = 0.3;
// Cap how many device crops we run Pass 2 on (keeps total time tolerable).
const MAX_CROPS = 6;

// First pass — these run on the WHOLE rack image.
const PASS_1 = [
  { name: 'unit',         file: 'unit_int8.onnx',           size: 11.5, input: 640, kind: 'yolo', color: '#2563eb', note: 'rack-unit detector' },
  { name: 'best 33',      file: 'best_33_int8.onnx',        size: 11.5, input: 640, kind: 'yolo', color: '#dc2626', note: 'server detector' },
  { name: 'Units',        file: 'Units_int8.onnx',          size: 26.3, input: 640, kind: 'yolo', color: '#d97706', note: 'units (alt)' },
  { name: 'port_count',   file: 'port_count_int8.onnx',     size: 26.3, input: 640, kind: 'yolo', color: '#0891b2', note: 'port locator/counter' },
  { name: 'Device_final', file: 'Device_final_int8.onnx',   size: 44.1, input: 640, kind: 'yolo', color: '#db2777', note: 'final device pass' },
  { name: 'best 32',      file: 'best_32_int8.onnx',        size: 44.1, input: 640, kind: 'yolo', color: '#65a30d', note: 'non-server detector' },
];

// Second pass — these run on each CROP of a detected device.
const PASS_2 = [
  { name: 'switch_patch', file: 'switch_patch_int8.onnx',                  size: 11.5, input: 640, kind: 'yolo',         color: '#16a34a', note: 'patch-panel ports (per crop)' },
  { name: 'port_best',    file: 'port_best_int8.onnx',                     size: 26.3, input: 640, kind: 'yolo',         color: '#9333ea', note: 'class-aware ports (per crop)' },
  { name: 'efficientnet', file: 'best_model_efficientnet_int8.onnx',       size:  4.4, input: 224, kind: 'efficientnet', color: '#475569', note: 'cable / port-type class (per crop)' },
];

const ALL_MODELS = [...PASS_1, ...PASS_2];

async function preprocess(imgUrl, size) {
  const img = new Image();
  img.src = imgUrl;
  await new Promise((r) => { img.onload = r; });
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, size, size);
  const px = ctx.getImageData(0, 0, size, size).data;
  const n = size * size;
  const data = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    data[i] = px[i * 4] / 255;
    data[i + n] = px[i * 4 + 1] / 255;
    data[i + 2 * n] = px[i * 4 + 2] / 255;
  }
  return new ort.Tensor('float32', data, [1, 3, size, size]);
}

async function cropDataUrl(imgUrl, box, pad = 0.02) {
  const img = new Image();
  img.src = imgUrl;
  await new Promise((r) => { img.onload = r; });
  const W = img.naturalWidth, H = img.naturalHeight;
  const x = Math.max(0, (box.x - pad) * W);
  const y = Math.max(0, (box.y - pad) * H);
  const w = Math.min(W - x, (box.w + 2 * pad) * W);
  const h = Math.min(H - y, (box.h + 2 * pad) * H);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').drawImage(img, x, y, w, h, 0, 0, w, h);
  return c.toDataURL('image/jpeg', 0.85);
}

function decodeYolo(output, imgSize, confThresh = CONF_THRESH) {
  // YOLOv8 output shape is [1, 4+C, N]: 4 bbox channels + C class scores.
  // Detection confidence per box is max(class_scores) — NOT just class 0.
  // We were reading channel 4 only, which silently dropped every detection
  // that belonged to class 1..C-1 for multi-class models like best_32 (12
  // classes), Device_final (12), best_33 (18), and port_best (6).
  const [, numChan, numDet] = output.dims;
  const numClasses = numChan - 4;
  const d = output.data;
  const lb = output.letterbox;
  const boxes = [];
  for (let i = 0; i < numDet; i++) {
    const cx = d[0 * numDet + i];
    const cy = d[1 * numDet + i];
    const w  = d[2 * numDet + i];
    const h  = d[3 * numDet + i];
    let conf = 0;
    let cls = 0;
    for (let c = 0; c < numClasses; c++) {
      const v = d[(4 + c) * numDet + i];
      if (v > conf) { conf = v; cls = c; }
    }
    if (conf <= confThresh) continue;
    let box;
    if (lb) {
      // cx,cy,w,h are pixel coordinates inside the lb.size x lb.size
      // letterboxed input. The visible content sits in a lb.newW x lb.newH
      // rect offset by (lb.dx, lb.dy). Map back to ratio-of-original-image.
      box = {
        x: (cx - w/2 - lb.dx) / lb.newW,
        y: (cy - h/2 - lb.dy) / lb.newH,
        w: w / lb.newW,
        h: h / lb.newH,
        conf, cls,
      };
    } else {
      // WASM path — plain resize, output is in 0..imgSize squashed-image space.
      box = { x: (cx - w/2)/imgSize, y: (cy - h/2)/imgSize, w: w/imgSize, h: h/imgSize, conf, cls };
    }
    boxes.push(box);
  }
  return nms(boxes, NMS_IOU);
}

function iou(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

function nms(boxes, thresh) {
  const sorted = [...boxes].sort((p, q) => q.conf - p.conf);
  const kept = [];
  for (const b of sorted) {
    if (kept.every((k) => iou(k, b) < thresh)) kept.push(b);
  }
  return kept;
}

function topClass(output) {
  const d = output.data;
  let maxIdx = 0, maxVal = -Infinity;
  for (let i = 0; i < d.length; i++) {
    if (d[i] > maxVal) { maxVal = d[i]; maxIdx = i; }
  }
  return { idx: maxIdx, score: maxVal };
}

function drawBoxesOnCanvas(canvas, imgUrl, results, models, enabled) {
  const img = new Image();
  img.src = imgUrl;
  img.onload = () => {
    const maxW = 900;
    const scale = Math.min(1, maxW / img.naturalWidth);
    canvas.width = img.naturalWidth * scale;
    canvas.height = img.naturalHeight * scale;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    ctx.lineWidth = 3;
    models.forEach((m) => {
      const r = results[m.name];
      if (!r?.boxes) return;
      if (enabled && enabled[m.name] === false) return;
      ctx.strokeStyle = m.color;
      r.boxes.forEach((b) => {
        ctx.strokeRect(
          b.x * canvas.width,
          b.y * canvas.height,
          b.w * canvas.width,
          b.h * canvas.height,
        );
      });
    });
  };
}

function drawCropCanvas(canvas, imgUrl, perModelBoxes, models) {
  const img = new Image();
  img.src = imgUrl;
  img.onload = () => {
    const maxW = 600;
    const scale = Math.min(1, maxW / img.naturalWidth);
    canvas.width = img.naturalWidth * scale;
    canvas.height = img.naturalHeight * scale;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    ctx.lineWidth = 3;
    models.forEach((m) => {
      const boxes = perModelBoxes[m.name] || [];
      ctx.strokeStyle = m.color;
      boxes.forEach((b) => {
        ctx.strokeRect(
          b.x * canvas.width,
          b.y * canvas.height,
          b.w * canvas.width,
          b.h * canvas.height,
        );
      });
    });
  };
}

export default function BenchmarkPage() {
  const [imageDataUrl, setImageDataUrl] = useState(null);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState({});
  const [status, setStatus] = useState('');
  const [overallMs, setOverallMs] = useState(null);
  const [enabledMain, setEnabledMain] = useState({});
  const [crops, setCrops] = useState([]); // [{dataUrl, box, perModel: {switch_patch: [...], port_best: [...]}, classifierResult: {...}}]
  const [backend, setBackend] = useState('wasm');
  const mainCanvasRef = useRef(null);
  const cropRefs = useRef({});

  useEffect(() => {
    // Default: show only ONE rack-unit detector + ONE device detector + port_count.
    // The other detectors stack overlapping boxes that read as visual noise; the
    // user can toggle them on individually from the legend below.
    const DEFAULT_ON = new Set(['best 33', 'best 32', 'port_count']);
    setEnabledMain(Object.fromEntries(PASS_1.map((m) => [m.name, DEFAULT_ON.has(m.name)])));
  }, []);

  useEffect(() => {
    if (imageDataUrl && mainCanvasRef.current) {
      drawBoxesOnCanvas(mainCanvasRef.current, imageDataUrl, results, PASS_1, enabledMain);
    }
  }, [imageDataUrl, results, enabledMain]);

  useEffect(() => {
    crops.forEach((c, i) => {
      const ref = cropRefs.current[i];
      if (ref && c.dataUrl) {
        drawCropCanvas(ref, c.dataUrl, c.perModel || {}, PASS_2.filter((m) => m.kind === 'yolo'));
      }
    });
  }, [crops]);

  const updateResult = (name, patch) =>
    setResults((prev) => ({ ...prev, [name]: { ...(prev[name] || {}), ...patch } }));

  // Fetches /test_rack.jpg as a data URL so we can run the pipeline without
  // touching the camera UI. Lets adb drive the whole flow.
  const fetchTestImageDataUrl = async () => {
    const resp = await fetch('/test_rack.jpg');
    const blob = await resp.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  };

  const runAll = async (opts = {}) => {
    const useTestImage = !!opts.useTestImage;
    setRunning(true);
    setResults(Object.fromEntries(ALL_MODELS.map((m) => [m.name, { status: 'pending' }])));
    setOverallMs(null);
    setCrops([]);
    cropRefs.current = {};

    try {
      let dataUrl;
      if (useTestImage) {
        setStatus('Loading bundled test rack image...');
        dataUrl = await fetchTestImageDataUrl();
      } else {
        setStatus('Opening camera...');
        const photo = await Camera.getPhoto({
          quality: 80,
          resultType: CameraResultType.DataUrl,
          source: CameraSource.Camera,
          allowEditing: false,
        });
        dataUrl = photo.dataUrl;
      }
      setImageDataUrl(dataUrl);
      const photo = { dataUrl };   // keep the rest of the function unchanged below

      const tStart = performance.now();
      const deviceBoxes = [];

      // ── PASS 1: 6 whole-image models ───────────────────────────────
      for (const m of PASS_1) {
        setStatus(`Pass 1 — ${m.name} (${backend})`);
        updateResult(m.name, { status: 'loading' });
        const sess = await openSession(backend, m.file);
        updateResult(m.name, { status: 'inferring', loadMs: sess.loadMs });

        const r = await runOne(sess, photo.dataUrl, m.input);
        const boxes = decodeYolo(r, m.input);
        updateResult(m.name, {
          status: 'done', loadMs: sess.loadMs, inferMs: r.inferMs, boxes,
          summary: `${boxes.length} detection(s)`,
        });
        if (m.name === 'best 32' || m.name === 'best 33' || m.name === 'Device_final') {
          boxes.forEach((b) => deviceBoxes.push(b));
        }
        await closeSession(sess);
      }

      // ── Combine + NMS the device boxes across detectors, take top N ─
      const dedupedDevices = nms(deviceBoxes, 0.5).slice(0, MAX_CROPS);
      setStatus(`Found ${dedupedDevices.length} device(s) to crop for Pass 2`);

      if (dedupedDevices.length === 0) {
        PASS_2.forEach((m) => updateResult(m.name, {
          status: 'skipped',
          summary: 'no device crops (Pass 1 found nothing)',
        }));
      } else {
        // Pre-render crops so the UI shows them while Pass 2 runs.
        const cropList = [];
        for (const box of dedupedDevices) {
          const dataUrl = await cropDataUrl(photo.dataUrl, box);
          cropList.push({ dataUrl, box, perModel: {}, classifierResult: null });
        }
        setCrops(cropList);

        // Initialize Pass 2 model running state — these will run many times.
        PASS_2.forEach((m) => updateResult(m.name, {
          status: 'loading',
          totalLoadMs: 0,
          totalInferMs: 0,
          totalBoxes: 0,
          cropsRun: 0,
        }));

        // ── PASS 2: load each model ONCE, run it on every crop ──────
        for (const m of PASS_2) {
          setStatus(`Pass 2 — loading ${m.name} (${backend})`);
          updateResult(m.name, { status: 'loading' });
          const sess = await openSession(backend, m.file);
          const loadMs = sess.loadMs;
          updateResult(m.name, { status: 'inferring', totalLoadMs: loadMs });

          let totalInfer = 0;
          let totalBoxes = 0;
          let lastClass = null;
          for (let i = 0; i < cropList.length; i++) {
            setStatus(`Pass 2 — ${m.name} on crop ${i + 1}/${cropList.length}`);
            const r = await runOne(sess, cropList[i].dataUrl, m.input);
            totalInfer += r.inferMs;
            if (m.kind === 'yolo') {
              const boxes = decodeYolo(r, m.input);
              cropList[i].perModel[m.name] = boxes;
              totalBoxes += boxes.length;
            } else {
              const c = topClass(r);
              cropList[i].classifierResult = c;
              lastClass = c;
            }
            setCrops([...cropList]);
            updateResult(m.name, {
              status: 'inferring',
              totalInferMs: totalInfer,
              totalBoxes,
              cropsRun: i + 1,
            });
          }

          let summary;
          if (m.kind === 'yolo') {
            summary = `${totalBoxes} detection(s) across ${cropList.length} crop(s)`;
          } else {
            summary = `top class ${lastClass?.idx} (last crop score ${lastClass?.score.toFixed(2)})`;
          }
          updateResult(m.name, {
            status: 'done',
            loadMs,
            inferMs: totalInfer,
            summary,
          });
          await closeSession(sess);
        }
      }

      setOverallMs(performance.now() - tStart);
      setStatus(`Done — ${dedupedDevices.length} device crop(s) processed`);
    } catch (err) {
      setStatus(`ERROR: ${err.message || err}`);
    } finally {
      setRunning(false);
    }
  };

  const allRows = ALL_MODELS.map((m, i) => ({ m, r: results[m.name] || {}, i }));
  const totalLoad = allRows.reduce((s, x) => s + (x.r.loadMs || 0), 0);
  const totalInfer = allRows.reduce((s, x) => s + (x.r.inferMs || 0), 0);

  return (
    <div style={{
      padding: 16,
      fontFamily: '-apple-system, system-ui, sans-serif',
      color: '#0f172a',
      minHeight: '100vh',
      background: '#fff',
    }}>
      <h1 style={{ fontSize: 22, margin: '0 0 6px' }}>Full Pipeline On-Device</h1>
      <p style={{ color: '#475569', fontSize: 13, margin: '0 0 14px' }}>
        Two-pass pipeline, all on the phone.
        <strong> Pass 1:</strong> 6 models on the whole rack.
        <strong> Pass 2:</strong> 3 models on each detected device crop (up to {MAX_CROPS}).
        Conf threshold: {CONF_THRESH}.
      </p>

      <div style={{
        display: 'flex',
        gap: 0,
        marginBottom: 10,
        border: '1px solid #e2e8f0',
        borderRadius: 8,
        overflow: 'hidden',
        fontSize: 13,
      }}>
        {[
          { id: 'wasm',   label: 'WASM (browser)' },
          { id: 'native', label: 'Native CPU' },
        ].map((b) => (
          <button
            key={b.id}
            onClick={() => setBackend(b.id)}
            disabled={running}
            style={{
              flex: 1,
              padding: '10px 12px',
              border: 'none',
              background: backend === b.id ? '#2563eb' : '#fff',
              color: backend === b.id ? '#fff' : '#475569',
              fontWeight: 600,
              cursor: running ? 'not-allowed' : 'pointer',
            }}
          >
            {b.label}
          </button>
        ))}
      </div>
      <p style={{ color: '#94a3b8', fontSize: 11, margin: '0 0 14px' }}>
        Models are now static-INT8 quantized (QOperator format).
        {backend === 'native' ? ' Native CPU: APK only.' : ' WASM: any WebView.'}
      </p>

      <button
        onClick={() => runAll()}
        disabled={running}
        style={{
          background: running ? '#94a3b8' : '#2563eb',
          color: '#fff',
          border: 'none',
          borderRadius: 8,
          padding: '14px 20px',
          fontSize: 16,
          fontWeight: 600,
          width: '100%',
          marginBottom: 8,
        }}
      >
        {running ? 'Running...' : `Take Photo & Run All 9 Models (${backend})`}
      </button>
      <button
        id="run-test-image"
        onClick={() => runAll({ useTestImage: true })}
        disabled={running}
        style={{
          background: 'transparent',
          color: running ? '#94a3b8' : '#16a34a',
          border: `1px solid ${running ? '#cbd5e1' : '#86efac'}`,
          borderRadius: 8,
          padding: '12px 20px',
          fontSize: 13,
          fontWeight: 600,
          width: '100%',
          marginBottom: 14,
          cursor: running ? 'not-allowed' : 'pointer',
        }}
      >
        Run on bundled test rack (skip camera, deterministic)
      </button>

      {status && (
        <div style={{ fontSize: 13, color: '#475569', marginBottom: 10 }}>
          Status: <strong>{status}</strong>
        </div>
      )}

      {imageDataUrl && (
        <>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#0f172a', margin: '14px 0 6px' }}>
            Pass 1 — whole rack
          </div>
          <div style={{
            border: '1px solid #e2e8f0',
            borderRadius: 8,
            overflow: 'hidden',
            marginBottom: 8,
            background: '#000',
          }}>
            <canvas ref={mainCanvasRef} style={{ width: '100%', display: 'block' }} />
          </div>
          <Legend models={PASS_1} results={results} enabled={enabledMain} setEnabled={setEnabledMain} />
        </>
      )}

      {crops.length > 0 && (
        <>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#0f172a', margin: '20px 0 6px' }}>
            Pass 2 — {crops.length} device crop(s)
          </div>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
            gap: 8,
            marginBottom: 12,
          }}>
            {crops.map((c, i) => (
              <div key={i} style={{
                border: '1px solid #e2e8f0',
                borderRadius: 8,
                overflow: 'hidden',
                background: '#000',
              }}>
                <canvas
                  ref={(el) => { cropRefs.current[i] = el; }}
                  style={{ width: '100%', display: 'block' }}
                />
                <div style={{
                  background: '#fff',
                  padding: '6px 8px',
                  fontSize: 10,
                  color: '#475569',
                }}>
                  Crop {i + 1} · conf {c.box?.conf.toFixed(2)}
                  {c.classifierResult && (
                    <div style={{ color: '#475569' }}>
                      class {c.classifierResult.idx} ({c.classifierResult.score.toFixed(2)})
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 16, marginBottom: 14 }}>
        {allRows.map(({ m, r, i }) => (
          <div key={m.name} style={{
            borderLeft: `4px solid ${m.color}`,
            border: '1px solid #e2e8f0',
            borderLeftWidth: 4,
            borderRadius: 8,
            padding: '10px 12px',
            fontSize: 12,
            background: r.status === 'done' ? '#f0fdf4'
                       : r.status === 'inferring' || r.status === 'loading' ? '#eff6ff'
                       : r.status === 'skipped' ? '#fffbeb'
                       : '#f8fafc',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <strong style={{ color: '#0f172a' }}>{i + 1}. {m.name}
                <span style={{ fontSize: 10, color: '#94a3b8', fontWeight: 500, marginLeft: 6 }}>
                  {i < PASS_1.length ? '(Pass 1)' : '(Pass 2)'}
                </span>
              </strong>
              <span style={{ color: '#64748b' }}>{m.size} MB</span>
            </div>
            <div style={{ color: '#64748b', marginTop: 2 }}>{m.note}</div>
            {r.status === 'pending' && <div style={{ color: '#94a3b8', marginTop: 4 }}>waiting...</div>}
            {r.status === 'loading' && <div style={{ color: '#2563eb', marginTop: 4 }}>loading...</div>}
            {r.status === 'inferring' && i < PASS_1.length && (
              <div style={{ color: '#2563eb', marginTop: 4 }}>running inference...</div>
            )}
            {r.status === 'inferring' && i >= PASS_1.length && (
              <div style={{ color: '#2563eb', marginTop: 4 }}>
                running on crop {r.cropsRun}/{crops.length}... ({r.totalBoxes || 0} boxes so far)
              </div>
            )}
            {r.status === 'skipped' && (
              <div style={{ color: '#d97706', marginTop: 4 }}>⊘ skipped — {r.summary}</div>
            )}
            {r.status === 'done' && (
              <div style={{ marginTop: 4 }}>
                <span style={{ color: '#16a34a' }}>✓</span>{' '}
                load {r.loadMs?.toFixed(0)} ms, infer {r.inferMs?.toFixed(0)} ms — {r.summary}
              </div>
            )}
          </div>
        ))}
      </div>

      {overallMs !== null && (
        <div style={{
          background: '#f0fdf4',
          border: '1px solid #bbf7d0',
          borderRadius: 8,
          padding: 14,
          fontSize: 13,
          lineHeight: 1.7,
        }}>
          <strong style={{ color: '#16a34a', textTransform: 'uppercase', letterSpacing: '0.08em', fontSize: 11 }}>SUMMARY</strong>
          <div>Total wall-clock: <strong>{(overallMs / 1000).toFixed(1)} s</strong></div>
          <div>Total load time: <strong>{(totalLoad / 1000).toFixed(1)} s</strong></div>
          <div>Total inference: <strong>{(totalInfer / 1000).toFixed(1)} s</strong></div>
          <div>Device crops processed: <strong>{crops.length}</strong></div>
          <div style={{ color: '#475569', marginTop: 6, fontSize: 12 }}>
            Conf threshold {CONF_THRESH}, Pass 2 ran on every detected device.
          </div>
        </div>
      )}
    </div>
  );
}

function Legend({ models, results, enabled, setEnabled }) {
  return (
    <div style={{
      background: '#f8fafc',
      border: '1px solid #e2e8f0',
      borderRadius: 8,
      padding: '8px 10px',
      marginBottom: 8,
      fontSize: 12,
    }}>
      <div style={{ fontWeight: 600, marginBottom: 6, color: '#0f172a', fontSize: 11 }}>Tap to toggle</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {models.map((m) => {
          const r = results[m.name] || {};
          const on = enabled[m.name];
          return (
            <button
              key={m.name}
              onClick={() => setEnabled((e) => ({ ...e, [m.name]: !e[m.name] }))}
              style={{
                border: `1px solid ${on ? m.color : '#cbd5e1'}`,
                background: on ? '#fff' : '#f1f5f9',
                color: on ? m.color : '#94a3b8',
                borderRadius: 999,
                padding: '3px 9px',
                fontSize: 11,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              <span style={{
                display: 'inline-block',
                width: 8, height: 8, borderRadius: 2,
                background: on ? m.color : '#cbd5e1',
                marginRight: 5,
                verticalAlign: 'middle',
              }} />
              {m.name}{r.boxes ? ` (${r.boxes.length})` : ''}
            </button>
          );
        })}
      </div>
    </div>
  );
}

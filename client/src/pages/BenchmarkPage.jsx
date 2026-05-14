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

// CONF defaults to 0.25 for the rack-level detectors (units/devices) —
// drops the long tail of duplicates while keeping every real detection.
// Ports are smaller objects with naturally lower per-anchor confidences,
// so Pass 2 (port_best, switch_patch) uses a looser threshold or it
// silently produces 0 detections per crop.
const CONF_THRESH = 0.25;
const PORT_CONF_THRESH = 0.10;
// NMS IoU = 0.3 — merge YOLOv8's near-duplicate anchors for the same
// physical object.
const NMS_IOU = 0.3;
// Cap how many device crops we run Pass 2 on (keeps total time tolerable).
const MAX_CROPS = 6;

// Minimal pipeline for the user-facing scan flow:
//   1. Detect devices on the rack
//   2. For each detected device, detect ports
// Everything else (rack-unit positions, alt detectors, port-type classifier)
// is still available in the diag/benchmark code at branch
// on-device-inference-writeup but skipped here for speed and clarity.
const PASS_1 = [
  { name: 'best 32',   file: 'best_32_int8.onnx',   size: 44.1, input: 640, kind: 'yolo', color: '#65a30d', note: 'device detector' },
];
const PASS_2 = [
  { name: 'port_best', file: 'port_best_int8.onnx', size: 26.3, input: 640, kind: 'yolo', color: '#9333ea', note: 'class-aware ports' },
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

function drawBoxesOnCanvas(canvas, imgUrl, results, models, enabled, highlight) {
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
    if (highlight) {
      // Port-on-crop coordinates are RATIO-OF-THE-CROP. The crop itself
      // occupies a rack-image rectangle defined by highlight.deviceBox
      // (also ratio-of-the-rack-image, with optional pad applied at crop
      // time — assume 0 here, matches cropDataUrl default).
      const d = highlight.deviceBox;
      const portX = (d.x + highlight.box.x * d.w) * canvas.width;
      const portY = (d.y + highlight.box.y * d.h) * canvas.height;
      const portW = highlight.box.w * d.w * canvas.width;
      const portH = highlight.box.h * d.h * canvas.height;
      ctx.lineWidth = 5;
      ctx.strokeStyle = '#facc15';
      ctx.strokeRect(portX, portY, portW, portH);
      ctx.fillStyle = '#facc15';
      const tag = `Port ${highlight.portIndex}`;
      ctx.font = 'bold 14px system-ui, -apple-system, sans-serif';
      const tw = ctx.measureText(tag).width + 10;
      const ty = Math.max(0, portY - 22);
      ctx.fillRect(portX, ty, tw, 20);
      ctx.fillStyle = '#0f172a';
      ctx.fillText(tag, portX + 5, ty + 15);
    }
  };
}

function drawCropCanvas(canvas, imgUrl, perModelBoxes, models, highlight) {
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
    if (highlight) {
      // Selected port — thicker yellow outline + label.
      ctx.lineWidth = 5;
      ctx.strokeStyle = '#facc15';
      ctx.strokeRect(
        highlight.box.x * canvas.width,
        highlight.box.y * canvas.height,
        highlight.box.w * canvas.width,
        highlight.box.h * canvas.height,
      );
      ctx.fillStyle = '#facc15';
      const tag = `Port ${highlight.portIndex}`;
      ctx.font = 'bold 14px system-ui, -apple-system, sans-serif';
      const tw = ctx.measureText(tag).width + 10;
      const tx = highlight.box.x * canvas.width;
      const ty = Math.max(0, highlight.box.y * canvas.height - 22);
      ctx.fillRect(tx, ty, tw, 20);
      ctx.fillStyle = '#0f172a';
      ctx.fillText(tag, tx + 5, ty + 15);
    }
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
  // Always run native — simpler UI, faster pipeline. WASM toggle removed.
  const backend = 'native';
  // Post-scan interactive flow: user taps a device crop, then enters a port
  // number. The page highlights that exact port on both the device crop and
  // the main rack image and shows the classifier's port-type label.
  const [selectedDeviceIdx, setSelectedDeviceIdx] = useState(null);
  const [portNum, setPortNum] = useState('');
  const [portResult, setPortResult] = useState(null); // { deviceIdx, portIndex, box, totalPorts, label }
  const fileInputRef = useRef(null);
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
      // Highlight info for the rack-level canvas: port coords need to be
      // remapped from crop-local to rack-image via the crop's deviceBox.
      const mainHighlight = portResult?.box && crops[portResult.deviceIdx]
        ? {
            box: portResult.box,
            portIndex: portResult.portIndex,
            deviceBox: crops[portResult.deviceIdx].box,
          }
        : null;
      drawBoxesOnCanvas(mainCanvasRef.current, imageDataUrl, results, PASS_1, enabledMain, mainHighlight);
    }
  }, [imageDataUrl, results, enabledMain, portResult, crops]);

  useEffect(() => {
    crops.forEach((c, i) => {
      const ref = cropRefs.current[i];
      if (ref && c.dataUrl) {
        const cropHighlight = portResult?.box && portResult.deviceIdx === i
          ? { box: portResult.box, portIndex: portResult.portIndex }
          : null;
        drawCropCanvas(ref, c.dataUrl, c.perModel || {}, PASS_2.filter((m) => m.kind === 'yolo'), cropHighlight);
      }
    });
  }, [crops, portResult]);

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
    const presetDataUrl = opts.presetDataUrl;
    setRunning(true);
    setResults(Object.fromEntries(ALL_MODELS.map((m) => [m.name, { status: 'pending' }])));
    setOverallMs(null);
    setCrops([]);
    cropRefs.current = {};
    setSelectedDeviceIdx(null);
    setPortNum('');
    setPortResult(null);

    try {
      let dataUrl;
      if (presetDataUrl) {
        setStatus('Loading uploaded image...');
        dataUrl = presetDataUrl;
      } else if (useTestImage) {
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
              // Pass 2 (per-crop port detectors) needs a looser conf cutoff —
              // ports are small and the rack-level threshold drops most of them.
              const boxes = decodeYolo(r, m.input, PORT_CONF_THRESH);
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

  const handleFileSelected = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => runAll({ presetDataUrl: reader.result });
    reader.readAsDataURL(file);
    // Reset the input so the same file can be picked again.
    e.target.value = '';
  };

  // Picks the Nth port on the selected device's class-aware port detections,
  // sorted left-to-right (the natural port numbering on most switches).
  // Always sets portResult so the UI shows _something_ — silent no-ops
  // were leaving the user wondering whether the click registered.
  const findPort = () => {
    const n = parseInt(portNum, 10);
    if (selectedDeviceIdx == null) {
      setPortResult({ error: 'Tap a device crop above first.' });
      return;
    }
    if (!Number.isInteger(n) || n < 1) {
      setPortResult({ error: 'Enter a port number (1 or higher).' });
      return;
    }
    const crop = crops[selectedDeviceIdx];
    if (!crop) {
      setPortResult({ error: 'Device crop not available yet.' });
      return;
    }
    const portBoxes = [
      ...(crop.perModel?.port_best || []),
      ...(crop.perModel?.switch_patch || []),
    ];
    if (portBoxes.length === 0) {
      setPortResult({
        error: `No ports detected on Device ${selectedDeviceIdx + 1}. Pass 2 may not have found any — try a different device.`,
      });
      return;
    }
    const sorted = [...portBoxes].sort((a, b) => a.x - b.x);
    if (n > sorted.length) {
      setPortResult({
        deviceIdx: selectedDeviceIdx, portIndex: n, box: null,
        totalPorts: sorted.length, label: null,
      });
      return;
    }
    const box = sorted[n - 1];
    setPortResult({
      deviceIdx: selectedDeviceIdx,
      portIndex: n,
      box,
      totalPorts: sorted.length,
      label: box.cls != null ? `port-class ${box.cls}` : null,
    });
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
      <h1 style={{ fontSize: 22, margin: '0 0 6px' }}>On-Device Scan</h1>
      <p style={{ color: '#475569', fontSize: 13, margin: '0 0 14px' }}>
        Snap a photo (or upload one), pick the device you want, type the port
        number, and the page highlights that exact port. All on this phone —
        no server, no network.
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
        {running ? 'Scanning...' : `Take Photo & Scan`}
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
          marginBottom: 8,
          cursor: running ? 'not-allowed' : 'pointer',
        }}
      >
        Try with sample rack (no camera needed)
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={handleFileSelected}
      />
      <button
        onClick={() => fileInputRef.current?.click()}
        disabled={running}
        style={{
          background: 'transparent',
          color: running ? '#94a3b8' : '#64748b',
          border: `1px solid ${running ? '#cbd5e1' : '#cbd5e1'}`,
          borderRadius: 8,
          padding: '12px 20px',
          fontSize: 13,
          fontWeight: 600,
          width: '100%',
          marginBottom: 14,
          cursor: running ? 'not-allowed' : 'pointer',
        }}
      >
        Upload image from gallery
      </button>

      {status && (
        <div style={{ fontSize: 13, color: '#475569', marginBottom: 10 }}>
          Status: <strong>{status}</strong>
        </div>
      )}

      {imageDataUrl && (
        <>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a', margin: '14px 0 6px' }}>
            Detected devices
          </div>
          <div style={{
            border: '1px solid #e2e8f0',
            borderRadius: 8,
            overflow: 'hidden',
            marginBottom: 12,
            background: '#000',
          }}>
            <canvas ref={mainCanvasRef} style={{ width: '100%', display: 'block' }} />
          </div>
        </>
      )}

      {crops.length > 0 && (
        <>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a', margin: '20px 0 6px' }}>
            Tap a device — {crops.length} found
          </div>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
            gap: 8,
            marginBottom: 12,
          }}>
            {crops.map((c, i) => {
              const selected = i === selectedDeviceIdx;
              return (
                <div
                  key={i}
                  onClick={() => {
                    setSelectedDeviceIdx(i);
                    setPortNum('');
                    setPortResult(null);
                  }}
                  style={{
                    border: `2px solid ${selected ? '#2563eb' : '#e2e8f0'}`,
                    borderRadius: 8,
                    overflow: 'hidden',
                    background: '#000',
                    cursor: 'pointer',
                    boxShadow: selected ? '0 0 0 3px rgba(37,99,235,0.18)' : 'none',
                  }}>
                  <canvas
                    ref={(el) => { cropRefs.current[i] = el; }}
                    style={{ width: '100%', display: 'block' }}
                  />
                  <div style={{
                    background: selected ? '#eff6ff' : '#fff',
                    padding: '6px 8px',
                    fontSize: 10,
                    color: '#475569',
                  }}>
                    Device {i + 1} · conf {c.box?.conf.toFixed(2)}
                    {c.classifierResult && (
                      <div style={{ color: '#475569' }}>
                        type {c.classifierResult.idx} ({c.classifierResult.score.toFixed(2)})
                      </div>
                    )}
                    <div style={{ color: selected ? '#2563eb' : '#94a3b8', marginTop: 2 }}>
                      {(c.perModel?.port_best?.length || 0) + (c.perModel?.switch_patch?.length || 0)} ports detected
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {selectedDeviceIdx != null && (
            <div style={{
              border: '1px solid #bfdbfe',
              background: '#eff6ff',
              borderRadius: 10,
              padding: '12px 14px',
              marginBottom: 16,
            }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#1e3a8a', marginBottom: 8 }}>
                Find a port on Device {selectedDeviceIdx + 1}
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                <input
                  type="number"
                  min="1"
                  inputMode="numeric"
                  value={portNum}
                  onChange={(e) => setPortNum(e.target.value)}
                  placeholder="Port number"
                  style={{
                    flex: 1,
                    padding: '10px 12px',
                    fontSize: 14,
                    border: '1px solid #cbd5e1',
                    borderRadius: 8,
                  }}
                />
                <button
                  onClick={findPort}
                  disabled={!portNum}
                  style={{
                    padding: '10px 18px',
                    fontSize: 13,
                    fontWeight: 600,
                    background: portNum ? '#2563eb' : '#cbd5e1',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 8,
                    cursor: portNum ? 'pointer' : 'not-allowed',
                  }}>
                  Find
                </button>
              </div>
              {portResult && (
                <div style={{ fontSize: 12, color: '#0f172a' }}>
                  {portResult.error ? (
                    <span style={{ color: '#dc2626' }}>{portResult.error}</span>
                  ) : portResult.box ? (
                    <>
                      <strong style={{ color: '#16a34a' }}>✓</strong>{' '}
                      Port {portResult.portIndex} located on Device {portResult.deviceIdx + 1}.
                      {' '}({portResult.totalPorts} ports total)
                      {portResult.label && (
                        <div style={{ color: '#475569', marginTop: 2 }}>{portResult.label}</div>
                      )}
                      <div style={{ color: '#475569', marginTop: 2 }}>
                        Highlighted in yellow on the device crop and on the rack image above.
                      </div>
                    </>
                  ) : (
                    <span style={{ color: '#dc2626' }}>
                      Only {portResult.totalPorts} ports detected on this device. Port {portResult.portIndex} is out of range.
                    </span>
                  )}
                </div>
              )}
              <div style={{ fontSize: 10, color: '#64748b', marginTop: 6 }}>
                Ports are numbered left-to-right based on detected position. The numbering matches what's printed on most switches.
              </div>
            </div>
          )}
        </>
      )}

      {overallMs !== null && (
        <div style={{
          background: '#f0fdf4',
          border: '1px solid #bbf7d0',
          borderRadius: 8,
          padding: 12,
          fontSize: 12,
          color: '#0f172a',
          marginTop: 8,
        }}>
          ✓ Scan complete · {crops.length} device(s) · {(overallMs / 1000).toFixed(1)} s
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

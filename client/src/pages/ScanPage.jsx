import { useState, useRef, useCallback, useEffect, useMemo, Suspense, lazy } from 'react';
import { useNavigate } from 'react-router-dom';
import styles from './ScanPage.module.css';
import { validateMedia } from '../utils/validateMedia';
import { apiUrl, authFetch } from '../utils/api';
import { triggerBackgroundProbe } from '../utils/portsProbe';
import { prefetchScan } from '../utils/scanPrefetch';
import { useShutter } from '../ShutterContext.jsx';
import RearImagePrompt from '../components/RearImagePrompt.jsx';
import MiniRack3D from '../components/MiniRack3D.jsx';
import { RackAR } from '../plugins/RackAR';
import { useTheme } from '../ThemeContext.jsx';

// Lazy so the (~140 kB) three-fiber bundle only loads when the user opens VR.
const TopologyScene3D = lazy(() => import('./TopologyScene3D.jsx'));

// ── Preview Card ─────────────────────────────────────────────
function PreviewCard({ file, onClear }) {
  // Blob URL lifecycle must live inside useEffect so it survives StrictMode's
  // intentional double-mount — creating in useMemo + revoking in cleanup revokes
  // the URL before the <img> gets a chance to use it on the second mount.
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!file) return;
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  const isVideo = file?.type?.startsWith('video/');

  return (
    <div className={styles.previewCard}>
      {url && (isVideo
        ? <video src={url} className={styles.previewImg} muted playsInline controls />
        : <img src={url} alt="Preview" className={styles.previewImg} />)}
      <button className={styles.previewCloseBtn} onClick={onClear}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
      <div className={styles.previewGrid} />
      <div className={styles.previewBar} />
    </div>
  );
}

// ── Upload / Drop Zone ───────────────────────────────────────
function UploadZone({ onFile }) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);

  const handleFile = useCallback((file) => {
    if (file) onFile(file);
  }, [onFile]);

  const onDrop = (e) => {
    e.preventDefault(); setDragging(false);
    const f = e.dataTransfer.files[0]; if (f) handleFile(f);
  };

  return (
    <>
      <div
        className={`${styles.dropZone} ${dragging ? styles.dragOver : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
      >
        {/* Corner brackets */}
        <span className={`${styles.zc} ${styles.zcTL}`}/>
        <span className={`${styles.zc} ${styles.zcTR}`}/>
        <span className={`${styles.zc} ${styles.zcBL}`}/>
        <span className={`${styles.zc} ${styles.zcBR}`}/>

        {/* Pulsing ring + icon */}
        <div className={styles.iconRing}>
          <div className={styles.iconPulse} />
          <div className={styles.iconPulse2} />
          <div className={styles.iconWrap}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
              <polyline points="17 8 12 3 7 8"/>
              <line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
          </div>
        </div>

        <div className={styles.dropText}>
          <p className={styles.dropTitle}>Drop rack image here</p>
          <p className={styles.dropSub}>tap to browse · JPG, PNG, HEIC, MP4</p>
        </div>
      </div>
      <input ref={inputRef} type="file"
        accept="image/*,image/heic,image/heif,.heic,.heif,video/*"
        style={{display:'none'}}
        onChange={(e) => handleFile(e.target.files[0])} />
    </>
  );
}

// ── Camera Capture ───────────────────────────────────────────
function pickRecorderMime() {
  const candidates = [
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  for (const t of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}

function CameraCapture({ onCapture, onCancel }) {
  const navigate = useNavigate();
  const videoRef  = useRef(null);
  const canvasRef = useRef(null);
  const sampleRef = useRef(null);
  const streamRef = useRef(null);
  const recorderRef = useRef(null);
  const recordChunksRef = useRef([]);
  const { registerShutter, clearShutter } = useShutter();
  const [ready,    setReady]    = useState(false);
  const [error,    setError]    = useState(null);
  const [flash,    setFlash]    = useState(false);
  const [mode,     setMode]     = useState('photo');   // 'photo' | 'video' | 'ar' | 'vr'
  const [recording, setRecording] = useState(false);
  const [recordSecs, setRecordSecs] = useState(0);
  const [quality,  setQuality]  = useState({ sharp: false, framed: false, lit: false });

  // ── Live detection overlay ──────────────────────────────────
  // While the camera is streaming, sample frames at ~1Hz, send them to
  // /api/analyze, and overlay 2D HTML labels on top of the <video>. We
  // match each frame's detections against prior tracks by IoU so a device
  // that briefly drops below the model's confidence threshold doesn't get
  // a new label when it comes back, and run NMS so we never display two
  // overlapping labels on the same physical device.
  const [liveDevices, setLiveDevices] = useState([]); // already in display-pixel space
  const detectionInflightRef = useRef(false);
  const tracksRef        = useRef(new Map());
  const nextTrackIdRef   = useRef(1);
  const TRACK_IOU_MIN     = 0.2;
  const TRACK_TTL_FRAMES  = 1;   // single missed cycle (~400ms) drops the box — kills ghost-pan lingering
  const NMS_IOU           = 0.25; // tighter NMS so panning duplicates collapse onto the just-observed track
  const BBOX_EMA_ALPHA    = 0.6;  // when re-observing a track: 60% new + 40% old → reduces per-frame jitter
  const MIN_CONF          = 0.45; // drop low-confidence detections before they enter the tracker
  const MIN_HITS_TO_SHOW  = 2;    // single-frame false positives never render (need 2 consecutive matches)
  const DETECT_INTERVAL_MS = 400;

  const allGood = quality.sharp && quality.framed && quality.lit;
  const canShoot = mode === 'video' ? ready : ready && allGood;

  const startCamera = useCallback(async () => {
    try {
      setError(null);
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.onloadedmetadata = () => { videoRef.current.play(); setReady(true); };
      }
    } catch { setError('Camera access denied. Allow camera permission or use Upload.'); }
  }, []);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null; setReady(false);
  }, []);

  // Photo/Video use the web getUserMedia stream. AR launches a native
  // ARCore/ARKit session, so release the webcam first to avoid contention
  // for the camera resource and restart it when the user toggles back.
  // VR renders a WebXR scene and likewise doesn't need the live webcam.
  useEffect(() => {
    if (mode === 'ar' || mode === 'vr') { stopCamera(); return; }
    startCamera();
    return () => stopCamera();
  }, [mode, startCamera, stopCamera]);

  // ── Live quality sampling loop (photo mode only) ────────
  useEffect(() => {
    if (!ready || mode !== 'photo') return;
    const interval = setInterval(() => {
      const video = videoRef.current;
      const canvas = sampleRef.current;
      if (!video || !canvas || !video.videoWidth) return;

      const sw = 192;
      const sh = Math.max(1, Math.round(sw * video.videoHeight / video.videoWidth));
      canvas.width = sw; canvas.height = sh;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(video, 0, 0, sw, sh);
      const { data } = ctx.getImageData(0, 0, sw, sh);

      const gray = new Float32Array(sw * sh);
      let lumaSum = 0;
      for (let i = 0, j = 0; i < data.length; i += 4, j++) {
        const y = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        gray[j] = y; lumaSum += y;
      }
      const meanLuma = lumaSum / (sw * sh);

      // Measure sharpness + edge density inside the guide region
      const gx0 = Math.floor(sw * 0.15), gx1 = Math.floor(sw * 0.85);
      const gy0 = Math.floor(sh * 0.08), gy1 = Math.floor(sh * 0.92);
      let lapSum = 0, lapSumSq = 0, n = 0, edgeCount = 0;
      for (let y = gy0 + 1; y < gy1 - 1; y++) {
        for (let x = gx0 + 1; x < gx1 - 1; x++) {
          const i = y * sw + x;
          const v = -4 * gray[i] + gray[i-1] + gray[i+1] + gray[i-sw] + gray[i+sw];
          lapSum += v; lapSumSq += v * v; n++;
          if (Math.abs(v) > 40) edgeCount++;
        }
      }
      if (n === 0) return;
      const lapMean = lapSum / n;
      const sharpness = lapSumSq / n - lapMean * lapMean;
      const edgeDensity = edgeCount / n;

      setQuality({
        sharp:  sharpness > 60,
        framed: edgeDensity > 0.035,
        lit:    meanLuma > 35 && meanLuma < 235,
      });
    }, 350);
    return () => clearInterval(interval);
  }, [ready, mode]);

  const capturePhoto = useCallback(() => {
    const video = videoRef.current, canvas = canvasRef.current;
    if (!video || !canvas || !video.videoWidth) return;
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    setFlash(true);
    setTimeout(() => setFlash(false), 160);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const file = new File([blob], `capture_${Date.now()}.jpg`, { type: 'image/jpeg' });
      onCapture(file);
    }, 'image/jpeg', 0.92);
  }, [onCapture]);

  const startRecording = useCallback(() => {
    const stream = streamRef.current;
    if (!stream || typeof MediaRecorder === 'undefined') {
      setError('Video recording is not supported in this browser. Use Upload instead.');
      return;
    }
    const mime = pickRecorderMime();
    let recorder;
    try {
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    } catch {
      setError('Could not start video recording on this device.');
      return;
    }
    recordChunksRef.current = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) recordChunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      const type = recorder.mimeType || mime || 'video/webm';
      const ext = type.includes('mp4') ? 'mp4' : 'webm';
      const blob = new Blob(recordChunksRef.current, { type });
      recordChunksRef.current = [];
      if (!blob.size) return;
      const file = new File([blob], `capture_${Date.now()}.${ext}`, { type });
      onCapture(file);
    };
    recorder.start();
    recorderRef.current = recorder;
    setRecording(true);
    setRecordSecs(0);
  }, [onCapture]);

  const stopRecording = useCallback(() => {
    const r = recorderRef.current;
    if (r && r.state !== 'inactive') {
      try { r.stop(); } catch { /* ignore */ }
    }
    recorderRef.current = null;
    setRecording(false);
  }, []);

  const handleShutter = useCallback(() => {
    if (mode === 'video') {
      if (recording) stopRecording();
      else startRecording();
      return;
    }
    capturePhoto();
  }, [mode, recording, startRecording, stopRecording, capturePhoto]);

  // Recording timer
  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => setRecordSecs(s => s + 1), 1000);
    return () => clearInterval(id);
  }, [recording]);

  // If the user toggles modes while recording, stop cleanly.
  useEffect(() => {
    if (mode !== 'video' && recording) stopRecording();
  }, [mode, recording, stopRecording]);

  // Stop any in-flight recording when the camera unmounts.
  useEffect(() => () => {
    const r = recorderRef.current;
    if (r && r.state !== 'inactive') {
      try { r.stop(); } catch { /* ignore */ }
    }
  }, []);

  // ── Live detection loop ─────────────────────────────────
  // Runs while the camera is ready (Photo + Video modes both). Samples
  // a frame from <video> each tick → /api/analyze → IoU-match against
  // existing tracks → NMS → display labels on top of the viewfinder.
  // Single-flighted so a slow analyze doesn't queue requests.
  useEffect(() => {
    if (!ready) { setLiveDevices([]); return; }

    // Reset tracks on each camera (re)start so stale labels from a
    // previous viewfinder don't bleed into a fresh scene.
    tracksRef.current.clear();
    nextTrackIdRef.current = 1;
    setLiveDevices([]);

    let cancelled = false;
    const tick = async () => {
      if (cancelled || detectionInflightRef.current) return;
      if (typeof document !== 'undefined' && document.hidden) return;
      const video = videoRef.current;
      if (!video || !video.videoWidth) return;

      detectionInflightRef.current = true;
      try {
        const sw = video.videoWidth;
        const sh = video.videoHeight;
        // /api/detect runs YOLO at imgsz=320 for live throughput, so the
        // client only needs to send 320px wide. Smaller upload + decode +
        // inference together cuts round-trip ~3× vs 640.
        const targetW = Math.min(sw, 320);
        const targetH = Math.round(sh * targetW / sw);
        const canvas = document.createElement('canvas');
        canvas.width = targetW; canvas.height = targetH;
        canvas.getContext('2d').drawImage(video, 0, 0, targetW, targetH);
        const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.78));
        if (!blob || cancelled) return;

        const fd = new FormData();
        fd.append('image', blob, 'live-frame.jpg');
        const r = await authFetch(apiUrl('/api/detect'), { method: 'POST', body: fd });
        if (cancelled) return;
        const data = await r.json().catch(() => ({}));
        const rawDevices = data?.devices || [];

        // /api/detect returns bboxes in the JPEG's space (targetW × targetH).
        // Scale back to source resolution so display-coord math uses one
        // consistent space (sourceW × sourceH).
        const back = sw / targetW;

        const observations = rawDevices
          .map(d => {
            const bb = normalizeBbox(d);
            if (!bb) return null;
            const conf = Number(d.confidence ?? d.score ?? 1);
            if (conf < MIN_CONF) return null;
            return {
              bbox:  bb.map(v => v * back),
              cls:   String(d.class_name || d.class || 'Device'),
              color: colorForClass(d.class_name || d.class || ''),
              conf,
            };
          })
          .filter(Boolean)
          .slice(0, 32);

        const tracks = tracksRef.current;
        const claimed = new Set();
        for (const obs of observations) {
          let bestId = null;
          let bestIoU = TRACK_IOU_MIN;
          for (const [id, t] of tracks) {
            if (claimed.has(id) || t.cls !== obs.cls) continue;
            const iou = boxIoU(t.bbox, obs.bbox);
            if (iou > bestIoU) { bestIoU = iou; bestId = id; }
          }
          if (bestId !== null) {
            const t = tracks.get(bestId);
            const a = BBOX_EMA_ALPHA;
            t.bbox = [
              a * obs.bbox[0] + (1 - a) * t.bbox[0],
              a * obs.bbox[1] + (1 - a) * t.bbox[1],
              a * obs.bbox[2] + (1 - a) * t.bbox[2],
              a * obs.bbox[3] + (1 - a) * t.bbox[3],
            ];
            t.misses = 0;
            t.hits   = (t.hits || 0) + 1;
            claimed.add(bestId);
          } else {
            const id = `t${nextTrackIdRef.current++}`;
            tracks.set(id, {
              id,
              label:  obs.cls,         // "Switch", "Patch Panel", "Server", …
              cls:    obs.cls,
              color:  obs.color,
              bbox:   obs.bbox,
              misses: 0,
              hits:   1,
            });
            claimed.add(id);
          }
        }
        for (const [id, t] of tracks) {
          if (claimed.has(id)) continue;
          t.misses += 1;
          if (t.misses > TRACK_TTL_FRAMES) tracks.delete(id);
        }

        // NMS: two tracks should never claim the same image region —
        // happens after a strong camera move when an old (still-alive)
        // track's last bbox sits where a new track just spawned. Prefer
        // the just-observed one (misses == 0) and drop the stale.
        const alive = Array.from(tracks.values())
          .sort((a, b) => a.misses - b.misses);
        const kept = [];
        for (const t of alive) {
          if (kept.some(k => boxIoU(k.bbox, t.bbox) > NMS_IOU)) {
            tracks.delete(t.id);
          } else {
            kept.push(t);
          }
        }

        // Map source coords → display pixels (object-fit:cover math).
        const rect = video.getBoundingClientRect();
        const dispW = rect.width;
        const dispH = rect.height;
        if (!dispW || !dispH) { setLiveDevices([]); return; }
        const scale = Math.max(dispW / sw, dispH / sh);
        const offX = (sw * scale - dispW) / 2;
        const offY = (sh * scale - dispH) / 2;
        const positioned = kept
          .filter(t => t.hits >= MIN_HITS_TO_SHOW)
          .map(t => ({
            id:     t.id,
            label:  t.label,
            color:  t.color,
            left:   Math.round(t.bbox[0] * scale - offX),
            top:    Math.round(t.bbox[1] * scale - offY),
            width:  Math.round(t.bbox[2] * scale),
            height: Math.round(t.bbox[3] * scale),
          }));
        if (!cancelled) setLiveDevices(positioned);
      } catch (e) {
        // Keep the loop alive — single-frame failures (network blips,
        // 429s) are normal during a long viewfinder session.
        console.warn('live detect failed:', e?.message || e);
      } finally {
        detectionInflightRef.current = false;
      }
    };

    // Kick once immediately, then every DETECT_INTERVAL_MS.
    tick();
    const interval = setInterval(tick, DETECT_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(interval); };
  }, [ready]);

  // Expose capture/record toggle to the BottomNav's middle button via context.
  // AR and VR modes own their own start/stop UI — leave the shutter unbound
  // there so the bottom button doesn't show a stale capture action.
  useEffect(() => {
    if (mode === 'ar' || mode === 'vr') { clearShutter(); return; }
    registerShutter(handleShutter, canShoot);
    return () => clearShutter();
  }, [mode, handleShutter, canShoot, registerShutter, clearShutter]);

  if (error) return (
    <div className={styles.camError}>
      <div className={styles.camErrorIcon}>
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <line x1="1" y1="1" x2="23" y2="23"/>
          <path d="M21 21H3a2 2 0 01-2-2V8a2 2 0 012-2h3m3-3h6l2 3h4a2 2 0 012 2v9.34"/>
        </svg>
      </div>
      <p className={styles.camErrorText}>{error}</p>
    </div>
  );

  const photoHint = !ready
    ? 'Starting camera…'
    : allGood
      ? 'Looks great — tap the shutter below'
      : !quality.framed ? 'Move closer so the rack fills the frame'
      : !quality.lit    ? 'Move to better lighting'
      : !quality.sharp  ? 'Hold steady — keep still for focus'
      : 'Align full rack within the frame';

  const videoHint = !ready
    ? 'Starting camera…'
    : recording
      ? 'Recording — tap shutter to stop'
      : 'Tap shutter to start recording the rack';

  const hintText = mode === 'video' ? videoHint : photoHint;

  const fmtTimer = (s) => {
    const m = Math.floor(s / 60).toString().padStart(2, '0');
    const r = (s % 60).toString().padStart(2, '0');
    return `${m}:${r}`;
  };

  return (
    <div className={`${styles.camWrap} ${styles.camWrapFull}`}>
      {mode !== 'ar' && mode !== 'vr' && (
        <>
          <div className={`${styles.flashLayer} ${flash ? styles.flashOn : ''}`} />
          <video ref={videoRef} className={styles.camVideo} playsInline muted autoPlay />
          <canvas ref={canvasRef} style={{display:'none'}} />
          <canvas ref={sampleRef} style={{display:'none'}} />

          {/* Live detection labels — positioned absolutely on top of the
              video. Hidden during the photo flash so they don't leak into
              the captured still (they wouldn't anyway since canvas pulls
              from the <video> element directly, but it looks cleaner). */}
          <div className={styles.liveOverlay} aria-hidden="true">
            {liveDevices.map(d => (
              <div key={d.id} className={styles.liveBox}
                style={{
                  left:        d.left,
                  top:         d.top,
                  width:       d.width,
                  height:      d.height,
                  borderColor: d.color,
                }}>
                <div className={styles.liveChip}
                  style={{ background: d.color }}>
                  {d.label}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {mode === 'ar' && <ARMode />}
      {mode === 'vr' && <VRMode />}

      {onCancel && (
        <button className={styles.camCloseBtn} onClick={onCancel} aria-label="Close camera">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      )}

      <div className={styles.hud}>
        {mode !== 'ar' && mode !== 'vr' && (
          <>
            <div className={styles.hudGrid} />

            {/* Rack-shaped guide box. Photo mode: green when all checks pass. Video mode: red while recording. */}
            <div className={`${styles.guideBox} ${
              mode === 'photo' && canShoot ? styles.guideBoxOn : ''
            } ${recording ? styles.guideBoxRec : ''}`} />

            <div className={styles.hudTop}>
              <span className={styles.hudBadge}>
                {recording
                  ? <><span className={styles.recDot}/> REC {fmtTimer(recordSecs)}</>
                  : <><span className="dot dot-cyan" style={{width:5,height:5}}/> RACK SCAN</>}
              </span>
            </div>
          </>
        )}

        <div className={styles.modeToggle}>
          <button type="button"
            className={`${styles.modeBtn} ${mode === 'photo' ? styles.modeBtnOn : ''}`}
            onClick={() => setMode('photo')}
            disabled={recording}>
            Photo
          </button>
          <button type="button"
            className={`${styles.modeBtn} ${mode === 'video' ? styles.modeBtnOn : ''}`}
            onClick={() => setMode('video')}>
            Video
          </button>
          <button type="button"
            className={`${styles.modeBtn} ${mode === 'ar' ? styles.modeBtnOn : ''}`}
            onClick={() => setMode('ar')}
            disabled={recording}>
            AR
          </button>
          <button type="button"
            className={`${styles.modeBtn} ${mode === 'vr' ? styles.modeBtnOn : ''}`}
            onClick={() => setMode('vr')}
            disabled={recording}>
            VR
          </button>
        </div>

        {mode !== 'ar' && mode !== 'vr' && (
          <div className={styles.hudBottom}>
            <p className={styles.hudHint}>{hintText}</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── AR Mode ──────────────────────────────────────────────────
// Launches the native fullscreen ARCore session (Android) / ARKit (iOS) via
// the RackAR Capacitor plugin. While running, each emitted camera frame is
// POSTed to /api/detect; the returned bounding boxes are pushed back into
// the AR view via RackAR.setOverlay so labels track the live scene.
function ARMode() {
  const [support, setSupport]   = useState(null);  // { ar, camera, platform } | null while probing
  const [running, setRunning]   = useState(false);
  const [error,   setError]     = useState(null);
  const [lastN,   setLastN]     = useState(0);     // last detection count (status chip)
  const inflightRef = useRef(false);
  const frameSubRef = useRef(null);
  const endedSubRef = useRef(null);
  const tapSubRef   = useRef(null);
  const runningRef  = useRef(false);

  // Probe on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await RackAR.isSupported();
        if (!cancelled) setSupport(s);
      } catch (e) {
        if (!cancelled) setError(`Probe failed: ${e?.message || e}`);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const teardownListeners = useCallback(() => {
    try { frameSubRef.current?.remove?.(); } catch {}
    try { endedSubRef.current?.remove?.(); } catch {}
    try { tapSubRef.current?.remove?.();   } catch {}
    frameSubRef.current = endedSubRef.current = tapSubRef.current = null;
  }, []);

  const handleStart = useCallback(async () => {
    setError(null);
    try {
      const perm = await RackAR.requestPermissions();
      setSupport(perm);
      if (!perm.ar) {
        setError(`AR not available on this device (platform: ${perm.platform})`);
        return;
      }
      if (perm.camera === 'denied') {
        setError('Camera permission denied — enable in system settings');
        return;
      }

      // Subscribe BEFORE start so we don't miss early frame/ended events.
      frameSubRef.current = await RackAR.addListener('frame', async (f) => {
        if (inflightRef.current || !runningRef.current) return;
        inflightRef.current = true;
        try {
          const blob = base64ToBlob(f.jpegBase64, 'image/jpeg');
          const fd = new FormData();
          fd.append('image', blob, 'ar-frame.jpg');
          const r = await authFetch(apiUrl('/api/detect'), { method: 'POST', body: fd });
          const data = await r.json().catch(() => ({}));
          const rawDevices = data?.devices || [];
          const devices = rawDevices
            .map((d, i) => {
              const bb = normalizeBbox(d);
              if (!bb) return null;
              const conf = Number(d.confidence ?? d.score ?? 1);
              if (conf < 0.45) return null;
              return {
                id:    `ar_${i}`,
                label: String(d.class_name || d.class || 'Device'),
                bbox:  bb,
                color: colorForClass(d.class_name || d.class || ''),
              };
            })
            .filter(Boolean)
            .slice(0, 32);
          await RackAR.setOverlay({ devices });
          setLastN(devices.length);
        } catch (e) {
          // Network blips are expected during a long AR session — keep going.
          console.warn('ar detect failed:', e?.message || e);
        } finally {
          inflightRef.current = false;
        }
      });

      endedSubRef.current = await RackAR.addListener('ended', () => {
        runningRef.current = false;
        setRunning(false);
        teardownListeners();
      });

      tapSubRef.current = await RackAR.addListener('tap', (e) => {
        console.log('AR label tapped:', e?.id);
      });

      await RackAR.start({ frameRateHz: 1 });
      runningRef.current = true;
      setRunning(true);
    } catch (e) {
      setError(`Start failed: ${e?.message || e}`);
      teardownListeners();
    }
  }, [teardownListeners]);

  const handleStop = useCallback(async () => {
    try { await RackAR.stop(); } catch {}
    runningRef.current = false;
    setRunning(false);
    teardownListeners();
  }, [teardownListeners]);

  // Tear down on unmount.
  useEffect(() => () => {
    teardownListeners();
    if (runningRef.current) RackAR.stop().catch(() => {});
  }, [teardownListeners]);

  const wrap = {
    display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center',
    gap:14, padding:'28px 20px', minHeight:280, textAlign:'center',
  };

  if (!support) {
    return <div style={wrap}><p style={{color:'#9ca3af'}}>Probing AR capabilities…</p></div>;
  }
  if (!support.ar) {
    return (
      <div style={wrap}>
        <div style={{fontSize:36}}>🚫</div>
        <p style={{fontSize:15, fontWeight:600, color:'#e5e7eb'}}>AR unavailable on this device</p>
        <p style={{fontSize:12, color:'#9ca3af', lineHeight:1.5}}>
          Platform: {support.platform}<br/>
          Camera permission: {support.camera}<br/>
          {support.platform === 'web'
            ? 'Open the app on an ARCore/ARKit-capable phone.'
            : 'Device is not on the ARCore certified list, or ARCore service is missing.'}
        </p>
      </div>
    );
  }
  return (
    <div style={wrap}>
      <div style={{
        fontSize:10, fontWeight:700, letterSpacing:'0.10em', color:'#34d399',
        textTransform:'uppercase',
      }}>
        AR ready
      </div>
      <p style={{fontSize:13, color:'#9ca3af'}}>
        Platform: {support.platform} · camera: {support.camera}
        {running && <> · last frame: <b style={{color:'#e5e7eb'}}>{lastN}</b> devices</>}
      </p>
      {error && (
        <p style={{fontSize:12, color:'#ef4444', maxWidth:320, lineHeight:1.4}}>{error}</p>
      )}
      {!running ? (
        <button className="btn btn-primary btn-lg" onClick={handleStart}>
          Start AR
        </button>
      ) : (
        <>
          <p style={{fontSize:12, color:'#9ca3af'}}>
            AR view active. Back-press on the phone to end.
          </p>
          <button className="btn btn-ghost" onClick={handleStop}>
            Stop AR
          </button>
        </>
      )}
    </div>
  );
}

// ── VR Mode ──────────────────────────────────────────────────
// Loads the user's most recent scan from rackTrackHistory and renders it in
// 3D via the existing TopologyScene3D (same scene used on the Topology tab).
// On a non-VR phone this is a touch-orbit 3D walkthrough; the WebXR headset
// path is a follow-up.
function VRMode() {
  const navigate = useNavigate();
  const [topo, setTopo]     = useState(null);
  const [error, setError]   = useState(null);
  const [empty, setEmpty]   = useState(false);
  const [rackId, setRackId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let history = [];
      try {
        history = JSON.parse(localStorage.getItem('rackTrackHistory') || '[]');
      } catch { history = []; }
      const recent = Array.isArray(history) && history.length ? history[0] : null;
      if (!recent?.scanId) { if (!cancelled) setEmpty(true); return; }
      if (!cancelled) setRackId(recent.scanId);

      try {
        const r = await authFetch(apiUrl(`/api/topology/${recent.scanId}`));
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        if (!cancelled) setTopo(data);
      } catch (e) {
        if (!cancelled) setError(e?.message || String(e));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const msgWrap = {
    position:'absolute', inset:0,
    display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center',
    gap:14, padding:'28px 20px', textAlign:'center',
  };

  return (
    <div style={{ position:'absolute', inset:0, background:'#0e1830' }}>
      {topo ? (
        <Suspense fallback={<div style={msgWrap}><p style={{color:'#9ca3af'}}>Initializing 3D scene…</p></div>}>
          <TopologyScene3D topo={topo} setSelected={() => {}} />
        </Suspense>
      ) : empty ? (
        <div style={msgWrap}>
          <div style={{fontSize:36}}>🗄️</div>
          <p style={{fontSize:15, fontWeight:600, color:'#e5e7eb'}}>No scans yet</p>
          <p style={{fontSize:12, color:'#9ca3af', lineHeight:1.5, maxWidth:300}}>
            Scan a rack first using Photo or Video, then come back here to walk
            through it in 3D.
          </p>
        </div>
      ) : error ? (
        <div style={msgWrap}>
          <div style={{fontSize:36}}>⚠️</div>
          <p style={{fontSize:15, fontWeight:600, color:'#ef4444'}}>Couldn't load your rack</p>
          <p style={{fontSize:12, color:'#9ca3af', maxWidth:300}}>{error}</p>
          {rackId && (
            <button className="btn btn-ghost" onClick={() => navigate(`/results/${rackId}/topology`)}>
              Open in Topology tab
            </button>
          )}
        </div>
      ) : (
        <div style={msgWrap}><p style={{color:'#9ca3af'}}>Loading your last scan…</p></div>
      )}

      <div style={{
        position:'absolute', top:14, left:'50%', transform:'translateX(-50%)',
        fontSize:10, fontWeight:700, letterSpacing:'0.10em',
        color: topo ? '#34d399' : '#9ca3af', textTransform:'uppercase',
        pointerEvents:'none', textShadow:'0 1px 2px rgba(0,0,0,0.6)',
      }}>
        {topo ? '3D walkthrough · your last scan' : 'VR mode'}
      </div>
    </div>
  );
}

// ── AR helpers ───────────────────────────────────────────────
function base64ToBlob(b64, mime) {
  const bytes = atob(b64);
  const buf = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
  return new Blob([buf], { type: mime });
}

// /api/analyze returns devices in one of three bbox shapes — normalize
// to [x, y, w, h] image-pixel space for the native overlay re-projector.
function normalizeBbox(d) {
  if (d.bbox && typeof d.bbox === 'object' && !Array.isArray(d.bbox) &&
      'x' in d.bbox && 'y' in d.bbox && 'w' in d.bbox && 'h' in d.bbox) {
    const a = [d.bbox.x, d.bbox.y, d.bbox.w, d.bbox.h].map(Number);
    return a.every(Number.isFinite) ? a : null;
  }
  if (Array.isArray(d.bbox) && d.bbox.length === 4) {
    const a = d.bbox.map(Number);
    return a.every(Number.isFinite) ? a : null;
  }
  if (Array.isArray(d.box) && d.box.length === 4) {
    const [x1, y1, x2, y2] = d.box.map(Number);
    if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
    return [x1, y1, x2 - x1, y2 - y1];
  }
  return null;
}

function colorForClass(cls) {
  const c = String(cls || '').toLowerCase();
  if (c.includes('switch'))  return '#6366f1';
  if (c.includes('patch'))   return '#a78bfa';
  if (c.includes('server'))  return '#f59e0b';
  if (c.includes('router'))  return '#10b981';
  return '#94a3b8';
}

function isSwitchOrPatchPanel(cls) {
  const c = String(cls || '').toLowerCase();
  return c.includes('switch') || c.includes('patch');
}

function boxIoU(a, b) {
  const [ax, ay, aw, ah] = a;
  const [bx, by, bw, bh] = b;
  const x1 = Math.max(ax, bx);
  const y1 = Math.max(ay, by);
  const x2 = Math.min(ax + aw, bx + bw);
  const y2 = Math.min(ay + ah, by + bh);
  if (x2 <= x1 || y2 <= y1) return 0;
  const inter = (x2 - x1) * (y2 - y1);
  const union = aw * ah + bw * bh - inter;
  return union > 0 ? inter / union : 0;
}

// ── Cinematic Loading Overlay ────────────────────────────────
function AnalyzingOverlay({ progress, step }) {
  const STEPS = ['Preprocessing image', 'Detecting rack boundaries', 'Identifying components', 'Mapping ports', 'Locating target'];
  const active = Math.min(Math.floor((progress / 100) * STEPS.length), STEPS.length - 1);

  return (
    <div className={styles.overlay}>
      <div className={styles.overlayInner}>
        <div className={styles.ovRack3D}>
          <MiniRack3D progress={progress} size={150} />
          <div className={styles.ovRack3DGlow} aria-hidden="true" />
        </div>
        <p className={styles.ovTitle}>Analyzing rack…</p>
        <p className={styles.ovStep}>{step}</p>
        <div className={styles.ovTrack}>
          <div className={styles.ovFill} style={{width:`${progress}%`}}/>
          <div className={styles.ovGlow} style={{left:`${progress}%`}}/>
        </div>
        <span className={styles.ovPct}>{progress}%</span>
      </div>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────
export default function ScanPage() {
  const navigate = useNavigate();
  const { theme } = useTheme();
  const isLight = theme === 'light';
  // Surface tokens for the incident picker — opaque white panel in light
  // theme, dark navy in dark theme. Hover/divider use black-on-light vs
  // white-on-dark so they're visible against either page background.
  const pickerPanelBg   = isLight ? '#FFFFFF' : '#0f1420';
  const pickerTriggerBg = isLight ? '#FFFFFF' : 'rgba(255,255,255,0.04)';
  const pickerShadow    = isLight ? '0 8px 24px rgba(15,23,42,0.10)' : '0 12px 32px rgba(0,0,0,0.6)';
  const pickerDivider   = isLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.06)';
  const pickerHoverBg   = isLight ? 'rgba(0,0,0,0.04)' : 'rgba(255,255,255,0.05)';
  const [tab,      setTab]      = useState('upload');
  const [file,     setFile]     = useState(null);
  const [loading,  setLoading]  = useState(false);
  const [progress, setProgress] = useState(0);
  const [step,     setStep]     = useState('');
  const [error,    setError]    = useState(null);
  const [qualityChoice, setQualityChoice] = useState(null);  // {error, kind} — shows Retake/Proceed
  const [tickets, setTickets] = useState([]);        // all active ServiceNow incidents
  const [ticket,  setTicket]  = useState(null);      // the one the user has selected to work on
  const [incidentMenuOpen, setIncidentMenuOpen] = useState(false);
  const incidentTriggerRef = useRef(null);
  const [incidentMenuRect, setIncidentMenuRect] = useState(null);
  const [showRearPrompt, setShowRearPrompt] = useState(false);
  const [pendingResult, setPendingResult] = useState(null);
  const [ocrLabels, setOcrLabels] = useState(null);

  // ── Rack-identity verification (ticket-mode only) ──
  // When a ticket is selected, fetch the canonical rack metadata (site/row/
  // position + expected labels) so we can tell the tech *which* physical rack
  // to photograph. On upload, the server compares the uploaded image's OCR
  // labels against this expected set; if they don't match we surface a
  // rejection modal instead of proceeding to analyze.
  const [expectedRack, setExpectedRack] = useState(null);     // payload from GET expected-rack
  const [verifying,    setVerifying]    = useState(false);
  const [verifyReject, setVerifyReject] = useState(null);     // 409 payload — detected / expected diff

  const STEPS = ['Preprocessing image…','Detecting rack boundaries…','Identifying components…','Mapping ports and cables…','Locating incident target…'];

  // On mount, pull the list of active tickets from servicenow_inbox via our Node API.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await authFetch(apiUrl('/api/incidents/active'));
        if (!res.ok) return;
        const data = await res.json().catch(() => null);
        if (cancelled || !data) return;
        setTickets(data.tickets || []);
      } catch { /* no ticket backend available — fall back to manual flow */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // When a ticket is selected, fetch the rack-identity record so we can show
  // the tech the site/row/position + expected labels *before* they pick an
  // image. Server's CMDB rack file (cmdb_racks/<rack>.json) backs this.
  useEffect(() => {
    setExpectedRack(null);
    setVerifyReject(null);
    if (!ticket?.incident_number) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await authFetch(apiUrl(`/api/incidents/${encodeURIComponent(ticket.incident_number)}/expected-rack`));
        if (!res.ok) return;
        const data = await res.json().catch(() => null);
        if (!cancelled && data?.ok) setExpectedRack(data);
      } catch { /* no CMDB rack record — skip identity check, fall through */ }
    })();
    return () => { cancelled = true; };
  }, [ticket?.incident_number]);

  const analyze = async ({ override = false, verifiedSkip = false } = {}) => {
    if (!file) return;
    setError(null);
    setQualityChoice(null);
    setVerifyReject(null);

    if (!override) {
      const check = await validateMedia(file);
      if (!check.ok) {
        if (check.retryable) {
          setQualityChoice({ error: check.error, kind: check.kind || 'quality' });
        } else {
          setError(check.error);
        }
        return;
      }
    }

    // Rack-identity verification (ticket mode + CMDB rack record present).
    // Skip when the caller already passed verification once (verifiedSkip)
    // or when there's no CMDB rack record to compare against.
    const ticketActive = !!ticket && ticket.target && ticket.target.device && ticket.target.port != null;
    const shouldVerify = ticketActive && expectedRack?.rack?.rack_name && !verifiedSkip
      && !((file?.type || '').startsWith('video/'));
    let verifiedPassed = verifiedSkip;
    if (shouldVerify) {
      setVerifying(true);
      try {
        const vb = new FormData();
        vb.append('image', file);
        const vRes = await authFetch(
          apiUrl(`/api/incidents/${encodeURIComponent(ticket.incident_number)}/verify-rack`),
          { method: 'POST', body: vb },
        );
        const vData = await vRes.json().catch(() => ({}));
        setVerifying(false);
        if (vRes.status === 409 || vData.ok === false) {
          setVerifyReject(vData);
          return;
        }
        // ok:true covers both the label-match case and the soft-mode
        // no-labels-detected fallback (server falls back to our
        // synthesized pattern downstream). Either way, proceed silently.
        verifiedPassed = true;
      } catch (err) {
        setVerifying(false);
        setError(`Identity check failed: ${err.message}`);
        return;
      }
    }

    setLoading(true); setProgress(0); setStep(STEPS[0]);
    // Kick the network-switch SSH probe in parallel with the CV pipeline so
    // the Logical tab on the Available Ports page is ready by the time the
    // user gets there. Fire-and-forget — it can't fail the scan.
    try { triggerBackgroundProbe(); } catch (_) {}
    let si = 0;
    const ticker = setInterval(() => {
      setProgress(p => Math.min(p + 9, 88));
      si = Math.min(si + 1, STEPS.length - 1);
      setStep(STEPS[si]);
    }, 300);
    try {
      // Detect video uploads — if the user shot/picked a video clip, route
      // to the multi-rack pipeline. The server splits the video into one
      // best-frame per detected rack, runs the existing analyze on each,
      // and returns a group with N member rackIds.
      const isVideoUpload = (file?.type || '').startsWith('video/');
      const ticketActive = !!ticket && ticket.target && ticket.target.device && ticket.target.port != null;
      const useMultiRack = isVideoUpload && !ticketActive;

      const body = new FormData();
      body.append(useMultiRack ? 'video' : 'image', file);
      if (override) body.append('skipQualityCheck', '1');

      // Ticket-mode: one-shot endpoint that runs analyze + auto-targets the
      // ticket's device/port + runs LLDP. Returns a bundled payload.
      const useTicketMode = ticketActive;
      if (useTicketMode) {
        body.append('incident_number', ticket.incident_number);
        // Waive the server-side identity gate when we've already verified
        // (or the user manually confirmed). The server still re-runs the
        // check otherwise and rejects with 409 on mismatch.
        if (verifiedPassed) body.append('verified', '1');
      }
      const endpoint = useMultiRack
        ? '/api/analyze-video'
        : (useTicketMode ? '/api/analyze-for-ticket' : '/api/analyze');

      const res  = await authFetch(apiUrl(endpoint), { method: 'POST', body });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.retryable) {
          clearInterval(ticker); setLoading(false); setProgress(0);
          setQualityChoice({ error: data.error || 'Image quality issue.', kind: data.kind || 'quality' });
          return;
        }
        if (res.status === 409 && data.error === 'rack_mismatch') {
          clearInterval(ticker); setLoading(false); setProgress(0);
          setVerifyReject(data);
          return;
        }
        throw new Error(data.error || 'Analysis failed. Try again.');
      }
      clearInterval(ticker);
      setProgress(100); setStep(useTicketMode ? 'Port located!' : 'Target located!');

      // Multi-rack response — { groupId, racks:[...] }. Land the user on
      // the SAME /results overview a single-rack scan would show, just
      // for the FIRST rack. RackTabs at the top lets them switch between
      // members; per-rack sub-pages (Ports / Topology / Switches / etc.)
      // work unchanged because each member rack still has its own RK-id.
      if (useMultiRack && data.groupId) {
        const racks = data.racks || [];
        try {
          racks.forEach(r => r.rackId && prefetchScan(r.rackId));
        } catch (_) {}
        const first = racks.find(r => r.rackId);
        if (!first) {
          setError('Multi-rack scan succeeded but no rack ids returned.');
          return;
        }
        // Fetch the first rack's full scan payload so /results renders
        // identically to a fresh single-rack scan (devices, units, port
        // counts, hero image — everything the overview/Ports tab needs).
        let firstResult = null;
        try {
          const r = await authFetch(apiUrl(`/api/scan/${encodeURIComponent(first.rackId)}`));
          if (r.ok) firstResult = await r.json();
        } catch (_) { /* fall through to deep-link path */ }
        setTimeout(() => {
          if (firstResult) {
            navigate(`/results/${encodeURIComponent(first.rackId)}`,
              { state: { result: firstResult } });
          } else {
            // Fetch failed — let ResultsPage cold-fetch via useParams.
            navigate(`/results/${encodeURIComponent(first.rackId)}`);
          }
        }, 600);
        return;
      }

      // Kick off every per-rack prefetch the moment analyze succeeds —
      // OCR, topology, CMDB, specs, firmware, SFP. By the time the user
      // clicks through to the Switches / Topology / Ports tabs, the data
      // is already in memory and the cards render instantly instead of
      // showing a per-tab loading spinner.
      if (data.rackId) {
        try { prefetchScan(data.rackId); } catch (_) {}
      }

      // Store result and show rear image prompt if we got a rackId
      setPendingResult({
        result: data,
        ticketMode: useTicketMode,
        ticket: useTicketMode ? ticket : null,
      });

      if (data.rackId) {
        setTimeout(() => setShowRearPrompt(true), 600);
      } else {
        setTimeout(() => navigate('/results', {
          state: { result: data, ticketMode: useTicketMode, ticket: useTicketMode ? ticket : null }
        }), 600);
      }
    } catch (err) {
      clearInterval(ticker); setLoading(false); setProgress(0); setError(err.message);
    }
  };

  const handleRearImageComplete = (mergedData) => {
    // mergedData contains { front, rear, deviceLabels }
    setOcrLabels(mergedData);
    setShowRearPrompt(false);
    
    // Navigate to results with both the original result and the merged OCR labels
    setTimeout(() => navigate('/results', {
      state: {
        result: pendingResult.result,
        ticketMode: pendingResult.ticketMode,
        ticket: pendingResult.ticket,
        ocrLabels: mergedData,
      }
    }), 400);
  };

  const handleRearImageSkip = () => {
    setShowRearPrompt(false);
    
    // Navigate to results with just the original result
    setTimeout(() => navigate('/results', {
      state: {
        result: pendingResult.result,
        ticketMode: pendingResult.ticketMode,
        ticket: pendingResult.ticket,
      }
    }), 400);
  };

  const handleRetake = () => {
    setFile(null);
    setQualityChoice(null);
    setError(null);
  };

  return (
    <div className={`page ${styles.scan}`}>
      <div className={styles.amb}/>

      {/* Header */}
      <header className={styles.header}>
        <button className="btn btn-ghost btn-icon" onClick={() => navigate('/')}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
          </svg>
        </button>
        <span className={styles.headerTitle}>Scan your Rack</span>
        <div style={{width:40}}/>
      </header>

      <div className={`pc ${styles.scanContent}`}>
        <div className={styles.scanIntro}>
        </div>

        {/* Active-incident pill — just the chip, above the Upload/Camera tabs */}
        {ticket && (
          <div style={{display:'flex',justifyContent:'center',margin:'4px 0 12px'}}>
            <div style={{
              display:'inline-flex',
              alignItems:'center',
              gap:6,
              padding:'4px 10px',
              borderRadius:999,
              background:'rgba(239,68,68,0.10)',
              border:'1px solid rgba(239,68,68,0.35)',
              fontSize:10,
              fontWeight:700,
              letterSpacing:'0.10em',
              color:'#ef4444',
              textTransform:'uppercase',
            }}>
              <span style={{
                width:6, height:6, borderRadius:'50%',
                background:'#ef4444',
                boxShadow:'0 0 6px rgba(239,68,68,0.7)',
              }} />
              Active · {ticket.incident_number}
            </div>
          </div>
        )}

        {/* Tabs */}
        <div className={styles.tabs}>
          {[
            { id:'upload', label:'Upload', icon:<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg> },
            { id:'camera', label:'Camera', icon:<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg> },
          ].map(t => (
            <button key={t.id} className={`${styles.tab} ${tab===t.id ? styles.tabOn : ''}`}
              onClick={() => { setTab(t.id); setFile(null); setError(null); setQualityChoice(null); }}>
              {t.icon}{t.label}
            </button>
          ))}
        </div>

        {/* Expected-rack banner — only shows in ticket mode when a CMDB rack
            record exists for the ticket. Tells the tech which physical rack
            to photograph; the server will verify the upload's OCR labels
            against the expected list before running analyze. */}
        {ticket && expectedRack?.rack?.rack_name && (
          <div style={{
            margin:'0 0 12px',
            padding:'12px 14px',
            borderRadius:10,
            border:'1px solid rgba(59,130,246,0.45)',
            background:'rgba(59,130,246,0.07)',
            display:'flex',
            flexDirection:'column',
            gap:6,
          }}>
            <div style={{
              fontSize:10,
              fontWeight:700,
              letterSpacing:'0.10em',
              color:'#60a5fa',
              textTransform:'uppercase',
            }}>
              Photograph this rack
            </div>
            <div style={{fontSize:14,fontWeight:600,color:'var(--text, #e5e7eb)'}}>
              {expectedRack.rack.rack_name}
            </div>
            <div style={{fontSize:12,color:'var(--muted, #9ca3af)',display:'flex',flexWrap:'wrap',gap:8}}>
              {expectedRack.rack.site     && <span>Site: <b style={{color:'#e5e7eb'}}>{expectedRack.rack.site}</b></span>}
              {expectedRack.rack.row      && <span>Row: <b style={{color:'#e5e7eb'}}>{expectedRack.rack.row}</b></span>}
              {expectedRack.rack.position && <span>Position: <b style={{color:'#e5e7eb'}}>{expectedRack.rack.position}</b></span>}
              {expectedRack.rack.u_position && <span>Target U: <b style={{color:'#e5e7eb'}}>U{String(expectedRack.rack.u_position).padStart(2,'0')}</b></span>}
            </div>
            {Array.isArray(expectedRack.rack.expected_labels) && expectedRack.rack.expected_labels.length > 0 && (
              <details style={{fontSize:11,color:'var(--muted, #9ca3af)'}}>
                <summary style={{cursor:'pointer',userSelect:'none'}}>
                  Expected labels ({expectedRack.rack.expected_labels.length})
                </summary>
                <div style={{marginTop:6,display:'flex',flexWrap:'wrap',gap:4}}>
                  {[...new Set(expectedRack.rack.expected_labels)].map(l => (
                    <code key={l} style={{
                      padding:'2px 6px',
                      borderRadius:4,
                      background:'rgba(255,255,255,0.06)',
                      color:'#cbd5e1',
                      fontSize:10,
                    }}>{l}</code>
                  ))}
                </div>
              </details>
            )}
          </div>
        )}

        {/* Media box */}
        <div className={styles.mediaBox}>
          {file
            ? <PreviewCard file={file} onClear={() => setFile(null)}/>
            : tab === 'upload'
              ? <UploadZone onFile={setFile}/>
              : <CameraCapture
                  onCapture={(f) => { setFile(f); setTab('upload'); }}
                  onCancel={() => setTab('upload')}
                />}
        </div>

        {/* Selected-incident description — the short_description trimmed of any
            "— …" suffix. Sits directly above the picker. */}
        {ticket && (() => {
          const raw = ticket.short_description || '';
          const headline = raw.split(/\s+[—–-]\s+/)[0].trim() || raw;
          return (
            <h2 style={{
              margin:'16px 0 10px',
              fontSize:19,
              fontWeight:600,
              letterSpacing:'-0.01em',
              color:'var(--text, #e5e7eb)',
              lineHeight:1.25,
              textAlign:'center',
            }}>
              {headline}
            </h2>
          );
        })()}

        {/* Incident picker — custom dropdown (native <select> options ignore
            app styling, so we roll our own). Selecting an incident makes
            Analyze jump straight to that device+port. */}
        {tickets.length > 0 && (
          <div style={{margin:'8px 0 4px', position:'relative'}}>
            <label style={{
              display:'block',
              fontSize:11,
              fontWeight:600,
              letterSpacing:'0.10em',
              color:'var(--muted, #9ca3af)',
              textTransform:'uppercase',
              marginBottom:8,
              textAlign:'center',
            }}>
              Incident to resolve
            </label>

            {/* Trigger button — shows the selected ticket as a chip */}
            <button
              ref={incidentTriggerRef}
              type="button"
              onClick={() => {
                setIncidentMenuOpen(o => {
                  const next = !o;
                  if (next && incidentTriggerRef.current) {
                    setIncidentMenuRect(incidentTriggerRef.current.getBoundingClientRect());
                  }
                  return next;
                });
              }}
              style={{
                width:'100%',
                padding:'10px 12px',
                borderRadius:10,
                background: pickerTriggerBg,
                color:'var(--text, #e5e7eb)',
                border:`1px solid ${incidentMenuOpen ? 'rgba(239,68,68,0.55)' : 'rgba(239,68,68,0.35)'}`,
                fontSize:14,
                cursor:'pointer',
                display:'flex',
                alignItems:'center',
                justifyContent:'space-between',
                gap:10,
                textAlign:'left',
              }}>
              <span style={{display:'flex',flexDirection:'column',gap:2,minWidth:0,flex:1}}>
                {ticket ? (
                  <>
                    <span style={{fontSize:13,fontWeight:600}}>
                      {ticket.incident_number} · {ticket.target?.device}:{ticket.cmdb?.interface_alias || `port${ticket.target?.port}`}
                    </span>
                    <span style={{fontSize:11,color:'var(--muted, #9ca3af)',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>
                      {ticket.priority} · {ticket.short_description}
                    </span>
                  </>
                ) : (
                  <span style={{color:'var(--muted, #9ca3af)'}}>Manual scan (tap to link an incident)</span>
                )}
              </span>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                style={{transform: incidentMenuOpen ? 'rotate(180deg)' : 'none', transition:'transform 0.15s ease', color:'var(--muted, #9ca3af)', flexShrink:0}}>
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </button>

            {/* Custom dropdown menu — fully styled, no OS interference */}
            {incidentMenuOpen && (
              <>
                <div
                  onClick={() => setIncidentMenuOpen(false)}
                  style={{position:'fixed', inset:0, zIndex:40}}
                />
                <div style={{
                  position:'fixed',
                  top: incidentMenuRect ? incidentMenuRect.bottom + 4 : 0,
                  left: incidentMenuRect ? incidentMenuRect.left : 0,
                  width: incidentMenuRect ? incidentMenuRect.width : 'auto',
                  maxHeight: incidentMenuRect
                    ? `calc(100dvh - ${incidentMenuRect.bottom + 20}px)`
                    : '60vh',
                  zIndex:50,
                  background: pickerPanelBg,
                  border:'1px solid rgba(239,68,68,0.35)',
                  borderRadius:10,
                  boxShadow: pickerShadow,
                  overflowY:'auto',
                  WebkitOverflowScrolling:'touch',
                  overscrollBehavior:'contain',
                  padding:4,
                }}>
                  {/* Manual scan option — explicit opt-out of ticket mode */}
                  <button
                    type="button"
                    onClick={() => { setTicket(null); setIncidentMenuOpen(false); }}
                    style={{
                      display:'flex',
                      flexDirection:'column',
                      gap:3,
                      width:'100%',
                      textAlign:'left',
                      padding:'10px 12px',
                      borderRadius:8,
                      border:'none',
                      borderBottom:`1px solid ${pickerDivider}`,
                      background: !ticket ? 'rgba(99, 102, 241,0.12)' : 'transparent',
                      color:'var(--text, #e5e7eb)',
                      cursor:'pointer',
                      marginBottom:2,
                    }}
                    onMouseEnter={e => { if (ticket) e.currentTarget.style.background = pickerHoverBg; }}
                    onMouseLeave={e => { if (ticket) e.currentTarget.style.background = 'transparent'; }}>
                    <span style={{display:'flex',alignItems:'center',gap:8,fontSize:13,fontWeight:600}}>
                      {!ticket && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>}
                      <span>Manual scan</span>
                      <span style={{color:'var(--muted, #9ca3af)',fontWeight:400,fontSize:11}}>· no ticket</span>
                    </span>
                    <span style={{fontSize:11,color:'var(--muted, #9ca3af)',lineHeight:1.3}}>
                      Pick device and port yourself after the rack is analyzed
                    </span>
                  </button>
                  {tickets.map(t => {
                    const sel = ticket?.incident_number === t.incident_number;
                    return (
                      <button
                        key={t.incident_number}
                        type="button"
                        onClick={() => { setTicket(t); setIncidentMenuOpen(false); }}
                        style={{
                          display:'flex',
                          flexDirection:'column',
                          gap:3,
                          width:'100%',
                          textAlign:'left',
                          padding:'10px 12px',
                          borderRadius:8,
                          border:'none',
                          background: sel ? 'rgba(239,68,68,0.15)' : 'transparent',
                          color:'var(--text, #e5e7eb)',
                          cursor:'pointer',
                        }}
                        onMouseEnter={e => { if (!sel) e.currentTarget.style.background = pickerHoverBg; }}
                        onMouseLeave={e => { if (!sel) e.currentTarget.style.background = 'transparent'; }}>
                        <span style={{display:'flex',alignItems:'center',gap:8,fontSize:13,fontWeight:600}}>
                          {sel && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>}
                          <span>{t.incident_number}</span>
                          <span style={{color:'var(--muted, #9ca3af)',fontWeight:400}}>·</span>
                          <span>{t.target?.device}:{t.cmdb?.interface_alias || `port${t.target?.port}`}</span>
                          <span style={{color:'var(--muted, #9ca3af)',fontWeight:400,fontSize:11}}>· {t.priority}</span>
                        </span>
                        <span style={{fontSize:11,color:'var(--muted, #9ca3af)',lineHeight:1.3}}>
                          {t.short_description}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </>
            )}

          </div>
        )}

        {error && (
          <div className={styles.errBox}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--red)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            {error}
          </div>
        )}

        {qualityChoice && (
          <div className={styles.qualityChoice}>
            <div className={styles.qualityChoiceHead}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
                <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
              <span>{qualityChoice.error}</span>
            </div>
            <div className={styles.qualityChoiceActions}>
              <button className="btn btn-ghost" onClick={handleRetake}>Retake</button>
              <button className="btn btn-primary" onClick={() => analyze({ override: true })}>Proceed</button>
            </div>
          </div>
        )}

        {/* CTA — no magnifying glass, no chips */}
        {!qualityChoice && (
          <button className={`btn btn-primary btn-lg btn-full ${styles.cta}`}
            disabled={!file}
            style={{
              opacity: file ? 1 : 0.4,
              // Make sure the button clears the bottom nav bar on mobile —
              // add safe-area padding plus extra margin so a tall image doesn't
              // push it behind the fixed nav.
              marginBottom: 'calc(env(safe-area-inset-bottom, 0px) + 24px)',
            }}
            onClick={() => analyze()}>
            Analyze Rack
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
            </svg>
          </button>
        )}
        {/* Spacer so the last button isn't flush against the fixed bottom nav */}
        <div style={{height:'calc(env(safe-area-inset-bottom, 0px) + 72px)'}} aria-hidden="true" />
      </div>

      {loading && <AnalyzingOverlay progress={progress} step={step}/>}
      {verifying && <AnalyzingOverlay progress={50} step="Verifying rack identity…"/>}
      {showRearPrompt && pendingResult && (
        <RearImagePrompt
          rackId={pendingResult.result.rackId}
          onComplete={handleRearImageComplete}
          onSkip={handleRearImageSkip}
        />
      )}

      {/* Rejection modal — fired when the uploaded image's OCR labels don't
          match the ticket's expected rack. Shows detected vs expected and
          asks the tech to upload the correct rack. The "no labels detected"
          path falls through silently (server's soft mode accepts and the
          synthesized U-prefix pattern is used downstream). */}
      {verifyReject && (
        <VerifyRejectModal
          payload={verifyReject}
          onRetake={() => { setVerifyReject(null); setFile(null); }}
          onClose={()  => setVerifyReject(null)}
        />
      )}
    </div>
  );
}

// ── Verification modals ─────────────────────────────────────────
// Both modals share the same dark/overlay style — kept inline so they're
// trivially co-located with the verification logic in this page.

function VerifyRejectModal({ payload, onRetake, onClose }) {
  const detected = Array.isArray(payload?.detected) ? payload.detected : [];
  const expected = Array.isArray(payload?.expected) ? payload.expected : [];
  const expectedUnique = [...new Set(expected)];
  return (
    <div style={modalBackdrop} onClick={onClose}>
      <div style={modalDialog} onClick={(e) => e.stopPropagation()}>
        <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:6}}>
          <div style={{width:8,height:8,borderRadius:'50%',background:'#ef4444',boxShadow:'0 0 8px rgba(239,68,68,0.8)'}} />
          <div style={{fontSize:10,fontWeight:700,letterSpacing:'0.10em',color:'#ef4444',textTransform:'uppercase'}}>
            Wrong rack
          </div>
        </div>
        <h2 style={{margin:'0 0 8px',fontSize:18,fontWeight:600,color:'var(--text, #e5e7eb)'}}>
          This isn't <b>{payload?.expected_rack_name || 'the expected rack'}</b>
        </h2>
        <p style={{margin:'0 0 16px',fontSize:13,color:'var(--muted, #9ca3af)',lineHeight:1.5}}>
          {payload?.message || `The labels read from this image don't match the rack on the incident. Upload the correct rack photo to continue.`}
        </p>

        <div style={{display:'flex',gap:12,marginBottom:16}}>
          <div style={diffCol}>
            <div style={diffHeading}>Detected on your image</div>
            {detected.length === 0
              ? <div style={diffEmpty}>No labels read</div>
              : <div style={chipWrap}>
                  {detected.map(l => <code key={l} style={{...chip, background:'rgba(239,68,68,0.10)', color:'#fca5a5'}}>{l}</code>)}
                </div>}
          </div>
          <div style={diffCol}>
            <div style={diffHeading}>Expected on the rack</div>
            {expectedUnique.length === 0
              ? <div style={diffEmpty}>—</div>
              : <div style={chipWrap}>
                  {expectedUnique.map(l => <code key={l} style={{...chip, background:'rgba(34,197,94,0.10)', color:'#86efac'}}>{l}</code>)}
                </div>}
          </div>
        </div>

        <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
          <button type="button" onClick={onClose} style={btnGhost}>Dismiss</button>
          <button type="button" onClick={onRetake} style={btnPrimary}>Upload correct rack</button>
        </div>
      </div>
    </div>
  );
}

const modalBackdrop = {
  position:'fixed', inset:0, zIndex:100,
  background:'rgba(0,0,0,0.7)', backdropFilter:'blur(4px)',
  display:'flex', alignItems:'center', justifyContent:'center', padding:16,
};
const modalDialog = {
  width:'100%', maxWidth:520,
  background:'#0f1419', border:'1px solid rgba(255,255,255,0.08)',
  borderRadius:14, padding:'20px 22px',
  boxShadow:'0 24px 48px rgba(0,0,0,0.6)',
};
const diffCol = {
  flex:1, padding:10, borderRadius:8,
  background:'rgba(255,255,255,0.03)', border:'1px solid rgba(255,255,255,0.06)',
};
const diffHeading = {
  fontSize:10, fontWeight:700, letterSpacing:'0.08em',
  color:'var(--muted, #9ca3af)', textTransform:'uppercase', marginBottom:6,
};
const diffEmpty = { fontSize:11, color:'var(--muted, #6b7280)', fontStyle:'italic' };
const chipWrap  = { display:'flex', flexWrap:'wrap', gap:4 };
const chip = {
  padding:'2px 6px', borderRadius:4, fontSize:10, fontFamily:'var(--mono, monospace)',
};
const btnPrimary = {
  padding:'9px 16px', borderRadius:8, border:'none', cursor:'pointer',
  background:'#3b82f6', color:'#fff', fontSize:13, fontWeight:600,
};
const btnGhost = {
  padding:'9px 16px', borderRadius:8, cursor:'pointer',
  background:'transparent', color:'var(--text, #e5e7eb)',
  border:'1px solid rgba(255,255,255,0.15)', fontSize:13, fontWeight:600,
};

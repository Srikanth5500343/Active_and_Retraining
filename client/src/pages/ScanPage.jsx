import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import styles from './ScanPage.module.css';
import { validateMedia } from '../utils/validateMedia';
import { apiUrl, authFetch } from '../utils/api';
import { triggerBackgroundProbe } from '../utils/portsProbe';
import { useShutter } from '../ShutterContext.jsx';
import RearImagePrompt from '../components/RearImagePrompt.jsx';
import MiniRack3D from '../components/MiniRack3D.jsx';

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
  const [mode,     setMode]     = useState('photo');   // 'photo' | 'video'
  const [recording, setRecording] = useState(false);
  const [recordSecs, setRecordSecs] = useState(0);
  const [quality,  setQuality]  = useState({ sharp: false, framed: false, lit: false });

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

  useEffect(() => { startCamera(); return () => stopCamera(); }, [startCamera, stopCamera]);

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

  // Expose capture/record toggle to the BottomNav's middle button via context
  useEffect(() => {
    registerShutter(handleShutter, canShoot);
    return () => clearShutter();
  }, [handleShutter, canShoot, registerShutter, clearShutter]);

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
      <div className={`${styles.flashLayer} ${flash ? styles.flashOn : ''}`} />
      <video ref={videoRef} className={styles.camVideo} playsInline muted autoPlay />
      <canvas ref={canvasRef} style={{display:'none'}} />
      <canvas ref={sampleRef} style={{display:'none'}} />

      {onCancel && (
        <button className={styles.camCloseBtn} onClick={onCancel} aria-label="Close camera">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      )}

      <div className={styles.hud}>
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
        </div>

        <div className={styles.hudBottom}>
          <p className={styles.hudHint}>{hintText}</p>
        </div>
      </div>
    </div>
  );
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

  const analyze = async ({ override = false } = {}) => {
    if (!file) return;
    setError(null);
    setQualityChoice(null);

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
      const body = new FormData();
      body.append('image', file);
      if (override) body.append('skipQualityCheck', '1');

      // Ticket-mode: one-shot endpoint that runs analyze + auto-targets the
      // ticket's device/port + runs LLDP. Returns a bundled payload.
      const useTicketMode = !!ticket && ticket.target && ticket.target.device && ticket.target.port != null;
      if (useTicketMode) {
        body.append('incident_number', ticket.incident_number);
      }
      const endpoint = useTicketMode ? '/api/analyze-for-ticket' : '/api/analyze';

      const res  = await authFetch(apiUrl(endpoint), { method: 'POST', body });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.retryable) {
          clearInterval(ticker); setLoading(false); setProgress(0);
          setQualityChoice({ error: data.error || 'Image quality issue.', kind: data.kind || 'quality' });
          return;
        }
        throw new Error(data.error || 'Analysis failed. Try again.');
      }
      clearInterval(ticker);
      setProgress(100); setStep(useTicketMode ? 'Port located!' : 'Target located!');
      
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
                background:'rgba(255,255,255,0.04)',
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
                  background:'#0f1420',
                  border:'1px solid rgba(239,68,68,0.35)',
                  borderRadius:10,
                  boxShadow:'0 12px 32px rgba(0,0,0,0.6)',
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
                      borderBottom:'1px solid rgba(255,255,255,0.06)',
                      background: !ticket ? 'rgba(34,211,238,0.12)' : 'transparent',
                      color:'var(--text, #e5e7eb)',
                      cursor:'pointer',
                      marginBottom:2,
                    }}
                    onMouseEnter={e => { if (ticket) e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; }}
                    onMouseLeave={e => { if (ticket) e.currentTarget.style.background = 'transparent'; }}>
                    <span style={{display:'flex',alignItems:'center',gap:8,fontSize:13,fontWeight:600}}>
                      {!ticket && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#22d3ee" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>}
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
                        onMouseEnter={e => { if (!sel) e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; }}
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
      {showRearPrompt && pendingResult && (
        <RearImagePrompt
          rackId={pendingResult.result.rackId}
          onComplete={handleRearImageComplete}
          onSkip={handleRearImageSkip}
        />
      )}
    </div>
  );
}

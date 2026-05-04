const MIN_DIM = 480;
const BLUR_THRESHOLD = 100;
const MIN_DURATION = 1.0;
const MAX_DURATION = 60;
const SAMPLE_MAX_DIM = 512;

const QUALITY_ERROR = 'Please upload a clearer photo of the rack — keep the camera steady and make sure the full rack fits in the frame.';

export async function validateMedia(file) {
  if (!file) return { ok: false, error: 'No file selected.' };

  // HEIC/HEIF (iPhone default): most browsers can't decode in JS.
  // Skip client-side checks and let the server normalize + validate.
  if (/\.(heic|heif)$/i.test(file.name) ||
      file.type === 'image/heic' || file.type === 'image/heif') {
    return { ok: true, metrics: { skipped: 'heic-deferred-to-server' } };
  }

  if (file.type.startsWith('image/')) return validateImage(file);
  if (file.type.startsWith('video/')) return validateVideo(file);
  return { ok: false, error: 'Unsupported file type. Upload an image or video.' };
}

async function validateImage(file) {
  const img = await loadImage(file).catch(() => null);
  if (!img) return { ok: false, error: QUALITY_ERROR };

  const { width, height } = img;
  if (Math.min(width, height) < MIN_DIM) {
    URL.revokeObjectURL(img.src);
    return {
      ok: false,
      kind: 'resolution',
      retryable: true,
      error: `Image resolution is low (${width}×${height}). Results may be inaccurate.`,
    };
  }

  const sharpness = laplacianVariance(img, width, height);
  URL.revokeObjectURL(img.src);

  if (sharpness < BLUR_THRESHOLD) {
    return {
      ok: false,
      kind: 'sharpness',
      retryable: true,
      error: 'The image looks blurry. Results may be inaccurate.',
    };
  }
  return { ok: true, metrics: { width, height, sharpness: Math.round(sharpness) } };
}

async function validateVideo(file) {
  // Sharpness sampling on compressed video frames is unreliable (seeked
  // frames are often black or softened by codec smoothing). The server
  // picks the best frame and re-runs the same letterbox/tilt checks the
  // photo path uses, so on the client we only sanity-check dimensions
  // and duration here.
  const video = await loadVideo(file).catch(() => null);
  if (!video) return { ok: false, error: QUALITY_ERROR };

  const { videoWidth: width, videoHeight: height, duration } = video;
  cleanupVideo(video);

  if (Math.min(width, height) < MIN_DIM) {
    return {
      ok: false,
      kind: 'resolution',
      retryable: true,
      error: `Video resolution is low (${width}×${height}). Results may be inaccurate.`,
    };
  }
  if (!isFinite(duration) || duration < MIN_DURATION || duration > MAX_DURATION) {
    return { ok: false, error: QUALITY_ERROR };
  }
  return {
    ok: true,
    metrics: { width, height, duration: +duration.toFixed(1) },
  };
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

function loadVideo(file) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.src = URL.createObjectURL(file);
    video.onloadeddata = async () => {
      // MediaRecorder webm: Chrome reports duration as Infinity until we
      // seek past the end. Force-compute it so the validator can use it.
      if (!isFinite(video.duration)) {
        await new Promise((res) => {
          const settle = () => {
            video.removeEventListener('durationchange', onChange);
            video.currentTime = 0;
            res();
          };
          const onChange = () => { if (isFinite(video.duration)) settle(); };
          video.addEventListener('durationchange', onChange);
          video.currentTime = 1e9;
          setTimeout(settle, 1500);
        });
      }
      resolve(video);
    };
    video.onerror = reject;
  });
}

function seekVideo(video, time) {
  return new Promise((resolve, reject) => {
    const onSeeked = () => { video.removeEventListener('seeked', onSeeked); resolve(); };
    const onErr = (e) => { video.removeEventListener('error', onErr); reject(e); };
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('error', onErr);
    video.currentTime = Math.min(time, Math.max(0, video.duration - 0.05));
  });
}

function cleanupVideo(video) {
  if (video.src) URL.revokeObjectURL(video.src);
  video.src = '';
  video.load();
}

function laplacianVariance(source, srcW, srcH) {
  const scale = Math.min(1, SAMPLE_MAX_DIM / Math.max(srcW, srcH));
  const w = Math.max(8, Math.floor(srcW * scale));
  const h = Math.max(8, Math.floor(srcH * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);

  const gray = new Float32Array(w * h);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    gray[j] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }

  let sum = 0, sumSq = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v = -4 * gray[i] + gray[i - 1] + gray[i + 1] + gray[i - w] + gray[i + w];
      sum += v;
      sumSq += v * v;
      n++;
    }
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

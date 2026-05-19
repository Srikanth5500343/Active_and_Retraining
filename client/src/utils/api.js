// In dev, VITE_API_BASE is empty → Vite's proxy routes /api, /outputs, /uploads.
// In the APK build, we set VITE_API_BASE=https://<public-host> so the WebView
// can reach the real backend instead of its own (non-existent) origin.
const API_BASE = import.meta.env.VITE_API_BASE || '';
const APP_KEY  = import.meta.env.VITE_APP_KEY  || '';

// Append ?app_key=... to a URL so the server's app-key gate accepts it.
// fetch() requests already get the X-App-Key header via the global interceptor
// in main.jsx, but <img>/<video>/<a download> URLs bypass that — they need the
// key in the query string. We append on every URL so a single path works for
// both fetches and tag-driven media loads.
function withAppKey(url) {
  if (!APP_KEY) return url;
  const sep = url.includes('?') ? '&' : '?';
  return url + sep + 'app_key=' + encodeURIComponent(APP_KEY);
}

export function apiUrl(path) {
  if (!path) return path;
  if (/^https?:\/\//i.test(path)) return withAppKey(path); // already absolute
  return withAppKey(API_BASE + path);
}

// Wrapper around fetch that automatically attaches the auth Bearer token
// (read from localStorage where AuthContext persists it). Use this for any
// API call that may need to be attributed to the signed-in user. The global
// fetch interceptor in main.jsx watches for 401 responses and dispatches a
// 'rt:auth-expired' event so AuthContext can sign the user out.
export function authFetch(input, init = {}) {
  let token = null;
  try { token = localStorage.getItem('rt_authToken'); } catch { /* ignore */ }
  const headers = new Headers(init.headers || {});
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return fetch(input, { ...init, headers });
}

// In dev, VITE_API_BASE is empty → Vite's proxy routes /api, /outputs, /uploads.
// In the APK build, we set VITE_API_BASE=https://<public-host> so the WebView
// can reach the real backend instead of its own (non-existent) origin.
const API_BASE = import.meta.env.VITE_API_BASE || '';

export function apiUrl(path) {
  if (!path) return path;
  if (/^https?:\/\//i.test(path)) return path; // already absolute
  return API_BASE + path;
}

// Wrapper around fetch that automatically attaches the auth Bearer token
// (read from localStorage where AuthContext persists it). Use this for any
// API call that may need to be attributed to the signed-in user.
export function authFetch(input, init = {}) {
  let token = null;
  try { token = localStorage.getItem('rt_authToken'); } catch { /* ignore */ }
  const headers = new Headers(init.headers || {});
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return fetch(input, { ...init, headers });
}

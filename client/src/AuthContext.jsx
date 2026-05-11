import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { apiUrl } from './utils/api';

const AuthContext = createContext(null);
const TOKEN_KEY = 'rt_authToken';
const USER_KEY  = 'rt_authUser';

function readStored() {
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    const userRaw = localStorage.getItem(USER_KEY);
    return { token, user: userRaw ? JSON.parse(userRaw) : null };
  } catch {
    return { token: null, user: null };
  }
}

async function callApi(path, options = {}) {
  const res = await fetch(apiUrl(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON response */ }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export function AuthProvider({ children }) {
  const [{ token, user }, setState] = useState(readStored);
  const [loading, setLoading] = useState(false);

  // Persist on every change
  useEffect(() => {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
    if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
    else localStorage.removeItem(USER_KEY);
  }, [token, user]);

  // Validate stored token against the server on mount; clear if rejected.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    fetch(apiUrl('/api/auth/me'), { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(data => { if (!cancelled && data?.user) setState(prev => ({ ...prev, user: data.user })); })
      .catch(() => { if (!cancelled) setState({ token: null, user: null }); });
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const login = useCallback(async (username, password, tenant = '') => {
    setLoading(true);
    try {
      const body = { username, password };
      if (tenant) body.tenant = tenant;
      const data = await callApi('/api/auth/login', { body });
      setState({ token: data.token, user: data.user });
      return data.user;
    } finally { setLoading(false); }
  }, []);

  const forgotPassword = useCallback(async (email) => {
    return await callApi('/api/auth/forgot-password', { body: { email } });
  }, []);

  const resetPassword = useCallback(async (email, code, password) => {
    setLoading(true);
    try {
      const data = await callApi('/api/auth/reset-password', { body: { email, code, password } });
      setState({ token: data.token, user: data.user });
      return data.user;
    } finally { setLoading(false); }
  }, []);

  const signup = useCallback(async (email, username, password, company = '') => {
    setLoading(true);
    try {
      return await callApi('/api/auth/signup', {
        body: { email, username, password, company },
      });
    } finally { setLoading(false); }
  }, []);

  const verifyCode = useCallback(async (email, code) => {
    setLoading(true);
    try {
      const data = await callApi('/api/auth/verify', { body: { email, code } });
      setState({ token: data.token, user: data.user });
      return data.user;
    } finally { setLoading(false); }
  }, []);

  const resendCode = useCallback(async (email) => {
    return await callApi('/api/auth/resend-code', { body: { email } });
  }, []);

  const logout = useCallback(() => {
    setState({ token: null, user: null });
  }, []);

  return (
    <AuthContext.Provider value={{
      user, token, loading,
      isAuthed: !!user,
      login, signup, verifyCode, resendCode, logout,
      forgotPassword, resetPassword,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

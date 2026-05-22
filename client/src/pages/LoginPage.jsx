import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import styles from './AuthPages.module.css';
import { useAuth } from '../AuthContext.jsx';
import ThemeToggle from '../components/ThemeToggle.jsx';

const Arrow = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
  </svg>
);

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { login, loading } = useAuth();
  const [tenant,   setTenant]   = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPw,   setShowPw]   = useState(false);
  const [error,    setError]    = useState(null);

  const from = location.state?.from || '/scan';

  const submit = async (e) => {
    e?.preventDefault();
    setError(null);
    if (!username.trim() || !password) {
      setError('Enter your username and password.');
      return;
    }
    try {
      await login(username.trim(), password, tenant.trim());
      navigate(from, { replace: true });
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className={styles.authPage}>
      <span className={styles.orb} aria-hidden="true" />
      <span className={styles.grain} aria-hidden="true" />

      <header className={styles.authHeader}>
        <button className={styles.authBack} onClick={() => navigate('/')} aria-label="Back to home">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
          </svg>
        </button>
        <div className={styles.headerActions}>
          <div className={styles.themeBtn}><ThemeToggle /></div>
        </div>
      </header>

      <main className={styles.authShell}>
        <div className={styles.orbHero} aria-hidden="true">
          <span className={styles.orbRing} />
          <span className={styles.orbBall} />
          <span className={`${styles.orbSat} ${styles.sat1}`} />
          <span className={`${styles.orbSat} ${styles.sat2}`} />
          <span className={`${styles.orbSat} ${styles.sat3}`} />
        </div>

        <h1 className={styles.heading}>Welcome back</h1>
        <p className={styles.subheading}>Sign in to continue.</p>

        <form className={styles.form} onSubmit={submit} autoComplete="on">
          <div className={styles.field}>
            <label className={styles.label} htmlFor="login-tenant">Organization</label>
            <input
              id="login-tenant"
              className={styles.input}
              type="text"
              autoComplete="organization"
              value={tenant}
              onChange={e => { setTenant(e.target.value); setError(null); }}
              autoFocus
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="login-user">Username or email</label>
            <input
              id="login-user"
              className={styles.input}
              type="text"
              autoComplete="username"
              value={username}
              onChange={e => { setUsername(e.target.value); setError(null); }}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="login-pw">Password</label>
            <input
              id="login-pw"
              className={styles.input}
              type={showPw ? 'text' : 'password'}
              autoComplete="current-password"
              value={password}
              onChange={e => { setPassword(e.target.value); setError(null); }}
            />
            <button type="button" className={styles.eyeBtn} onClick={() => setShowPw(v => !v)}
              aria-label={showPw ? 'Hide password' : 'Show password'}>
              {showPw
                ? <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>}
            </button>
          </div>

          <div className={styles.forgotRow}>
            <Link
              to="/forgot-password"
              state={{ email: username.includes('@') ? username.trim() : '' }}
              className={styles.forgotLink}
            >
              Forgot password?
            </Link>
          </div>

          {error && (
            <div className={styles.errBox}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              {error}
            </div>
          )}

          <button type="submit" className={styles.primaryBtn} disabled={loading}>
            <span>Sign in</span>
            <span className={styles.btnArrow}>
              {loading ? <span className={styles.spinner}/> : <Arrow />}
            </span>
          </button>
        </form>

        <div className={styles.altRow}>
          New here?
          <Link to="/signup" state={{ from }} className={styles.altLink}>Create account</Link>
        </div>
      </main>
    </div>
  );
}

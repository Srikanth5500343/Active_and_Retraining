import { useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import styles from './AuthPages.module.css';
import { useAuth } from '../AuthContext.jsx';
import { CodeGrid, PW_RULES, STRENGTH_COLORS } from './SignupPage.jsx';

// Four-step password reset:
//   1. 'email'  — enter address, server emails a 6-digit code (1 min TTL).
//   2. 'code'   — enter the code; server *verifies* without consuming it.
//   3. 'choice' — "Code verified. Want to change your password?" Yes/No.
//   4. 'reset'  — collect new password and consume the reset row.
// The code stays valid through steps 2→3→4 (single password_resets row,
// not deleted until the final reset). If the user picks "No" we send them
// back to /login without resetting anything.
export default function ForgotPasswordPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { forgotPassword, verifyResetCode, resetPassword, loginWithCode, loading } = useAuth();

  const [step, setStep] = useState('email');   // 'email' | 'code' | 'choice' | 'reset'
  const [email, setEmail] = useState(location.state?.email || '');
  const [code, setCode]   = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm]   = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError]   = useState(null);
  const [info, setInfo]     = useState(null);

  const from = location.state?.from || '/scan';

  const pwInfo = useMemo(() => {
    const checks = PW_RULES.map(r => ({ ...r, ok: r.test(password) }));
    const satisfied = checks.filter(c => c.ok).length;
    const missing   = checks.filter(c => !c.ok).map(c => c.label);
    const color = STRENGTH_COLORS[satisfied] || '#6366F1';
    let label;
    if (password.length === 0)     label = '';
    else if (satisfied < 5)        label = `Need ${missing[0]}`;
    else                           label = '✓ Strong password';
    return { satisfied, color, label, allOk: satisfied === 5 };
  }, [password]);

  const matchOk = confirm.length > 0 && confirm === password;

  const submitEmail = async (e) => {
    e?.preventDefault();
    setError(null); setInfo(null);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError('Enter a valid email.');
      return;
    }
    try {
      await forgotPassword(email.trim());
      setStep('code');
      // We always show the same message regardless of whether the email is
      // registered — the server doesn't leak that distinction either.
      setInfo('If an account exists for that email, a 6-digit code is on its way.');
    } catch (err) { setError(err.message); }
  };

  // Verifies the 6-digit code WITHOUT consuming it. The code remains valid
  // for the final /reset-password call in the 'reset' step.
  const submitCode = async (e) => {
    e?.preventDefault();
    setError(null); setInfo(null);
    if (!/^\d{6}$/.test(code)) { setError('Enter the 6-digit code from your email.'); return; }
    try {
      await verifyResetCode(email.trim(), code);
      setStep('choice');
    } catch (err) { setError(err.message); }
  };

  const submitReset = async (e) => {
    e?.preventDefault();
    setError(null);
    if (!pwInfo.allOk) { setError('Password is too weak.'); return; }
    if (!matchOk)      { setError('Passwords do not match.'); return; }
    try {
      await resetPassword(email.trim(), code, password);
      navigate(from, { replace: true });
    } catch (err) { setError(err.message); }
  };

  // "No, keep current password" — the OTP already proved identity, so issue
  // a token without touching the password. The server consumes the reset row.
  const skipAndLogin = async () => {
    setError(null);
    try {
      await loginWithCode(email.trim(), code);
      navigate(from, { replace: true });
    } catch (err) { setError(err.message); }
  };

  const resend = async () => {
    setError(null); setInfo(null);
    try {
      await forgotPassword(email.trim());
      setInfo('Sent a fresh code.');
    } catch (err) { setError(err.message); }
  };

  return (
    <div className={styles.authPage}>
      <div className={styles.orb} />
      <div className={styles.grain} />

      <header className={styles.authHeader}>
        <button className={styles.authBack} onClick={() => navigate('/login')} aria-label="Back to sign in">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
          </svg>
        </button>
        <div style={{ width: 40 }} />
      </header>

      <main className={styles.authShell}>
        {step === 'email' && (
          <>
            <h1 className={styles.heading}>Forgot password</h1>
            <p className={styles.subheading}>Enter your email and we'll send a 6-digit reset code.</p>

            <form className={styles.form} onSubmit={submitEmail} autoComplete="on">
              <div className={styles.field}>
                <input
                  id="fp-email"
                  className={styles.input}
                  type="email"
                  placeholder=" "
                  autoComplete="email"
                  value={email}
                  onChange={e => { setEmail(e.target.value); setError(null); }}
                  autoFocus
                />
                <label className={styles.label} htmlFor="fp-email">Email</label>
              </div>

              {error && (
                <div className={styles.errBox}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                  {error}
                </div>
              )}

              <button type="submit" className={styles.primaryBtn} disabled={loading}>
                {loading ? <span className={styles.spinner}/> : <>Send reset code
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
                </>}
              </button>
            </form>

            <div className={styles.altRow}>
              Remembered it?
              <Link to="/login" state={{ from }} className={styles.altLink}>Sign in</Link>
            </div>
          </>
        )}

        {step === 'code' && (
          <>
            <h1 className={styles.heading}>Enter code</h1>
            <p className={styles.subheading}>
              Code sent to <b style={{color:'var(--text, #e5e7eb)'}}>{email}</b>. It expires in 1 minute.
            </p>

            <form className={styles.form} onSubmit={submitCode} autoComplete="off">
              <CodeGrid value={code} onChange={(v) => { setCode(v); setError(null); }} disabled={loading} />

              {info && !error && (
                <div className={styles.errBox} style={{background:'rgba(34,197,94,0.08)',color:'#86efac',borderColor:'rgba(34,197,94,0.35)'}}>
                  {info}
                </div>
              )}
              {error && (
                <div className={styles.errBox}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                  {error}
                </div>
              )}

              <button type="submit" className={styles.primaryBtn} disabled={loading}>
                {loading ? <span className={styles.spinner}/> : <>Verify code
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                </>}
              </button>
            </form>

            <div className={styles.altRow}>
              Didn't get a code?
              <button type="button" className={styles.altLink}
                onClick={resend}
                style={{background:'transparent',border:'none',padding:0,cursor:'pointer'}}>
                Resend
              </button>
            </div>
          </>
        )}

        {step === 'choice' && (
          <>
            <h1 className={styles.heading}>Code verified</h1>
            <p className={styles.subheading}>
              Do you want to change your password? You're already signed in either way.
            </p>

            <div className={styles.form}>
              <button
                type="button"
                className={styles.primaryBtn}
                onClick={() => { setError(null); setInfo(null); setStep('reset'); }}
                disabled={loading}>
                Yes, change password
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
              </button>
              <button
                type="button"
                onClick={skipAndLogin}
                disabled={loading}
                style={{
                  display:'inline-flex', alignItems:'center', justifyContent:'center',
                  gap:8, width:'100%', padding:'13px 16px', borderRadius:14,
                  background:'transparent', border:'1px solid rgba(148,163,184,0.35)',
                  color:'var(--text, #e5e7eb)', font:'inherit', fontWeight:600,
                  cursor: loading ? 'not-allowed' : 'pointer',
                  WebkitTapHighlightColor:'transparent',
                }}>
                {loading ? <span className={styles.spinner}/> : 'No, take me to the app'}
              </button>

              {error && (
                <div className={styles.errBox}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                  {error}
                </div>
              )}
            </div>
          </>
        )}

        {step === 'reset' && (
          <>
            <h1 className={styles.heading}>New password</h1>
            <p className={styles.subheading}>
              Set a new password for <b style={{color:'var(--text, #e5e7eb)'}}>{email}</b>.
            </p>

            <form className={styles.form} onSubmit={submitReset} autoComplete="off">
              <div className={styles.field}>
                <input
                  id="fp-pw"
                  className={styles.input}
                  type={showPw ? 'text' : 'password'}
                  placeholder=" "
                  autoComplete="new-password"
                  value={password}
                  onChange={e => { setPassword(e.target.value); setError(null); }}
                  autoFocus
                />
                <label className={styles.label} htmlFor="fp-pw">New password</label>
                <button type="button" className={styles.eyeBtn} onClick={() => setShowPw(v => !v)}
                  aria-label={showPw ? 'Hide password' : 'Show password'}>
                  {showPw
                    ? <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                    : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>}
                </button>
              </div>

              {pwInfo.label && (
                <div style={{fontSize:11,color:pwInfo.color,marginTop:-6,marginLeft:4}}>{pwInfo.label}</div>
              )}

              <div className={styles.field}>
                <input
                  id="fp-confirm"
                  className={styles.input}
                  type={showPw ? 'text' : 'password'}
                  placeholder=" "
                  autoComplete="new-password"
                  value={confirm}
                  onChange={e => { setConfirm(e.target.value); setError(null); }}
                />
                <label className={styles.label} htmlFor="fp-confirm">Confirm new password</label>
              </div>

              {error && (
                <div className={styles.errBox}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                  {error}
                </div>
              )}

              <button type="submit" className={styles.primaryBtn} disabled={loading}>
                {loading ? <span className={styles.spinner}/> : <>Reset password
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                </>}
              </button>
            </form>
          </>
        )}
      </main>
    </div>
  );
}

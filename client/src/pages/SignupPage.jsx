import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import styles from './AuthPages.module.css';
import { useAuth } from '../AuthContext.jsx';
import ThemeToggle from '../components/ThemeToggle.jsx';

export const PW_RULES = [
  { id: 'len',   label: '8 characters',   test: pw => pw.length >= 8 },
  { id: 'upper', label: 'an uppercase',   test: pw => /[A-Z]/.test(pw) },
  { id: 'lower', label: 'a lowercase',    test: pw => /[a-z]/.test(pw) },
  { id: 'digit', label: 'a digit',        test: pw => /[0-9]/.test(pw) },
  { id: 'spec',  label: 'a special char', test: pw => /[^A-Za-z0-9]/.test(pw) },
];
export const STRENGTH_COLORS = ['#fca5a5', '#fbbf24', '#fcd34d', '#86efac', '#34d399', '#6366F1'];

const Arrow = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
  </svg>
);
const Check = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12"/>
  </svg>
);

export function CodeGrid({ value, onChange, disabled }) {
  const refs = useRef([]);
  const digits = value.padEnd(6, ' ').split('').slice(0, 6);

  const setDigit = (i, ch) => {
    const cleaned = String(ch).replace(/\D/g, '').slice(0, 1);
    const next = (value.padEnd(6, ' ').split(''));
    next[i] = cleaned || ' ';
    onChange(next.join('').replace(/\s+$/, '').replace(/\s/g, ''));
    if (cleaned && i < 5) refs.current[i + 1]?.focus();
  };

  const handleKey = (i, e) => {
    if (e.key === 'Backspace' && !digits[i].trim() && i > 0) {
      refs.current[i - 1]?.focus();
    } else if (e.key === 'ArrowLeft' && i > 0) {
      refs.current[i - 1]?.focus(); e.preventDefault();
    } else if (e.key === 'ArrowRight' && i < 5) {
      refs.current[i + 1]?.focus(); e.preventDefault();
    }
  };

  const handlePaste = (e) => {
    const pasted = (e.clipboardData?.getData('text') || '').replace(/\D/g, '').slice(0, 6);
    if (!pasted) return;
    e.preventDefault();
    onChange(pasted);
    refs.current[Math.min(pasted.length, 5)]?.focus();
  };

  return (
    <div className={styles.codeGrid} onPaste={handlePaste}>
      {[0,1,2,3,4,5].map(i => (
        <input
          key={i}
          ref={el => refs.current[i] = el}
          className={`${styles.codeCell} ${digits[i].trim() ? styles.codeCellFilled : ''}`}
          type="text" inputMode="numeric" maxLength="1"
          value={digits[i].trim()}
          disabled={disabled}
          onChange={e => setDigit(i, e.target.value)}
          onKeyDown={e => handleKey(i, e)}
          onFocus={e => e.target.select()}
          aria-label={`Digit ${i + 1}`}
        />
      ))}
    </div>
  );
}

export default function SignupPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { signup, verifyCode, resendCode, loading } = useAuth();
  const [step, setStep] = useState('details');

  const [email, setEmail]       = useState('');
  const [username, setUsername] = useState('');
  // REQUIRED — the verify step creates a brand-new tenant for this user.
  // They become the founding member of that tenant and other employees
  // can later be invited into it. Multi-tenancy means each customer
  // company gets its own private space; without a company name there's
  // no tenant to put the user into.
  const [company, setCompany]   = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm]   = useState('');
  const [showPw, setShowPw]     = useState(false);

  const [code, setCode]         = useState('');
  const [error, setError]       = useState(null);
  const [info, setInfo]         = useState(null);

  const from = location.state?.from || '/scan';

  // Live password strength: count satisfied rules, pick a color, name what's missing.
  const pwInfo = useMemo(() => {
    const checks = PW_RULES.map(r => ({ ...r, ok: r.test(password) }));
    const satisfied = checks.filter(c => c.ok).length;
    const missing   = checks.filter(c => !c.ok).map(c => c.label);
    const color = STRENGTH_COLORS[satisfied] || '#6366F1';
    let label;
    if (password.length === 0)     label = '';
    else if (satisfied < 5)        label = `Need ${missing[0]}`;
    else                           label = '✓ Strong password';
    return { satisfied, total: checks.length, color, label, allOk: satisfied === 5 };
  }, [password]);

  const matchOk = confirm.length > 0 && confirm === password;

  const submitDetails = async (e) => {
    e?.preventDefault();
    setError(null); setInfo(null);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setError('Enter a valid email.'); return; }
    if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username))            { setError('Username 3–32 chars (letters, digits, . _ -).'); return; }
    if (!company.trim() || company.trim().length < 2)        { setError('Company name is required.'); return; }
    if (!pwInfo.allOk)                                       { setError('Password is too weak.'); return; }
    if (!matchOk)                                            { setError('Passwords do not match.'); return; }
    try {
      await signup(email.trim(), username.trim(), password, company.trim());
      setStep('code');
      setInfo('We sent a 6-digit code to your email.');
    } catch (err) { setError(err.message); }
  };

  const submitCode = async (e) => {
    e?.preventDefault();
    setError(null);
    if (code.length !== 6) { setError('Enter the full 6-digit code.'); return; }
    try {
      await verifyCode(email.trim(), code);
      navigate(from, { replace: true });
    } catch (err) { setError(err.message); }
  };

  const onResend = async () => {
    setError(null); setInfo(null);
    try {
      await resendCode(email.trim());
      setInfo('A new code has been sent.');
    } catch (err) { setError(err.message); }
  };

  useEffect(() => {
    if (step === 'code') {
      const first = document.querySelector(`.${styles.codeCell}`);
      first?.focus();
    }
  }, [step]);

  return (
    <div className={styles.authPage}>
      <span className={styles.orb} aria-hidden="true" />
      <span className={styles.grain} aria-hidden="true" />

      <header className={styles.authHeader}>
        <button className={styles.authBack}
          onClick={() => step === 'code' ? setStep('details') : navigate('/')}
          aria-label="Back">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
          </svg>
        </button>
        <div className={styles.headerActions}>
          <div className={styles.stepDots}>
            <span className={`${styles.stepDot} ${step === 'details' ? styles.stepDotActive : styles.stepDotDone}`}/>
            <span className={`${styles.stepDot} ${step === 'code' ? styles.stepDotActive : ''}`}/>
          </div>
          <div className={styles.themeBtn}><ThemeToggle /></div>
        </div>
      </header>

      <main className={styles.authShell}>
        <div className={`${styles.orbHero} ${styles.orbHeroSm}`} aria-hidden="true">
          <span className={styles.orbRing} />
          <span className={styles.orbBall} />
          <span className={`${styles.orbSat} ${styles.sat1}`} />
          <span className={`${styles.orbSat} ${styles.sat2}`} />
          <span className={`${styles.orbSat} ${styles.sat3}`} />
        </div>

        {step === 'details' ? (
          <>
            <h1 className={styles.heading}>Create your account</h1>

            <form className={styles.form} onSubmit={submitDetails} autoComplete="on">
              <div className={styles.field}>
                <label className={styles.label} htmlFor="su-email">Email</label>
                <input id="su-email" className={styles.input} type="email"
                  autoComplete="email" value={email}
                  onChange={e => { setEmail(e.target.value); setError(null); }} autoFocus />
              </div>

              <div className={styles.field}>
                <label className={styles.label} htmlFor="su-user">Username</label>
                <input id="su-user" className={styles.input} type="text"
                  autoComplete="username" value={username}
                  onChange={e => { setUsername(e.target.value); setError(null); }} />
              </div>

              <div className={styles.field}>
                <label className={styles.label} htmlFor="su-company">Company</label>
                <input id="su-company" className={styles.input} type="text"
                  autoComplete="organization" value={company}
                  onChange={e => { setCompany(e.target.value); setError(null); }}
                  required />
              </div>

              <div className={styles.field}>
                <label className={styles.label} htmlFor="su-pw">Password</label>
                <input id="su-pw" className={styles.input} type={showPw ? 'text' : 'password'}
                  autoComplete="new-password" value={password}
                  onChange={e => { setPassword(e.target.value); setError(null); }} />
                <button type="button" className={styles.eyeBtn} onClick={() => setShowPw(v => !v)}
                  aria-label={showPw ? 'Hide password' : 'Show password'}>
                  {showPw
                    ? <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                    : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>}
                </button>

                {/* Single strength bar + 1-line hint */}
                {password.length > 0 && (
                  <div className={styles.strength}>
                    <div className={styles.strengthTrack}>
                      <div className={styles.strengthFill}
                        style={{
                          width: `${(pwInfo.satisfied / pwInfo.total) * 100}%`,
                          background: pwInfo.color,
                          color: pwInfo.color,
                        }}/>
                    </div>
                    <span className={`${styles.strengthHint} ${pwInfo.allOk ? styles.strengthHintOk : ''}`}
                      style={pwInfo.allOk ? {} : { color: pwInfo.color }}>
                      {pwInfo.label}
                    </span>
                  </div>
                )}
              </div>

              <div className={styles.field}>
                <label className={styles.label} htmlFor="su-confirm">Confirm password</label>
                <input id="su-confirm" className={styles.input} type={showPw ? 'text' : 'password'}
                  autoComplete="new-password" value={confirm}
                  onChange={e => { setConfirm(e.target.value); setError(null); }} />
                {confirm.length > 0 && (
                  <span className={`${styles.matchHint} ${matchOk ? styles.matchOk : styles.matchBad}`}>
                    {matchOk ? '✓ matches' : '✗ no match'}
                  </span>
                )}
              </div>

              {error && (
                <div className={styles.errBox}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                  {error}
                </div>
              )}

              <button type="submit" className={styles.primaryBtn}
                disabled={loading || !pwInfo.allOk || !matchOk || !email || !username}>
                <span>Continue</span>
                <span className={styles.btnArrow}>
                  {loading ? <span className={styles.spinner}/> : <Arrow />}
                </span>
              </button>
            </form>

            <div className={styles.altRow}>
              Already have an account?
              <Link to="/login" state={{ from }} className={styles.altLink}>Sign in</Link>
            </div>
          </>
        ) : (
          <>
            <h1 className={styles.heading}>Almost there</h1>
            <p className={styles.sentTo}>
              Code sent to <span className={styles.sentToEmail}>{email}</span>
            </p>

            <form className={styles.form} onSubmit={submitCode}>
              <CodeGrid value={code} onChange={(v) => { setCode(v); setError(null); }} disabled={loading} />

              {info && (
                <div className={styles.infoBox}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
                  {info}
                </div>
              )}
              {error && (
                <div className={styles.errBox}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                  {error}
                </div>
              )}

              <button type="submit" className={styles.primaryBtn} disabled={loading || code.length !== 6}>
                <span>Verify</span>
                <span className={styles.btnArrow}>
                  {loading ? <span className={styles.spinner}/> : <Check />}
                </span>
              </button>
            </form>

            <div className={styles.altRow}>
              Didn't get it?
              <button type="button" className={styles.altLink} onClick={onResend}>Resend</button>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

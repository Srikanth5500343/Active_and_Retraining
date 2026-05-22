import { useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import styles from './HomeLight.module.css';
import ThemeToggle from '../components/ThemeToggle.jsx';
import { useAuth } from '../AuthContext.jsx';
import { usePointerGlow } from './useOrbLook.js';
import Rack3D from '../components/Rack3D.jsx';
import DatacenterBackground from '../components/DatacenterBackground.jsx';

/* ──────────────────────────────────────────────────────────────────────
   HomeLight — faithful build of the supplied reference (light, img 1).

   Soft lavender field, brand row + round control, a status pill, a
   premium soft-purple orb (now with a gentle face), a dotted ring and
   a floating "ready" chip, an editorial serif headline with an italic
   accent, and a deep-gradient primary CTA. Light theme only.
   ────────────────────────────────────────────────────────────────────── */

const ArrowR = (p) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
       strokeLinecap="round" strokeLinejoin="round" {...p}>
    <path d="M5 12h14M13 6l6 6-6 6"/>
  </svg>
);

export default function HomeLight() {
  const navigate = useNavigate();
  const wrapRef = useRef(null);
  usePointerGlow(wrapRef);
  const auth = useAuth();
  const name =
    auth?.user?.username ||
    auth?.user?.name ||
    (auth?.user?.email && String(auth.user.email).split('@')[0]) ||
    null;

  return (
    <div className={`page ${styles.wrap}`} ref={wrapRef}>
      <span className={styles.cursorGlow} aria-hidden="true" />
      <DatacenterBackground accent="#7C6CF6" />
      {/* brand row */}
      <header className={styles.top}>
        <div className={styles.brand}>
          <span className={styles.logo} aria-hidden="true">
          <span className={styles.markR}>R</span>
        </span>
          <span className={styles.brandName}>RackTrack</span>
        </div>
        <div className={styles.round}><ThemeToggle /></div>
      </header>

      {/* status pill */}
      <div className={styles.pill}>
        <span className={styles.dot} /> AI ready · scans in seconds
      </div>

      {/* interactive 3D rack */}
      <div className={styles.hero}>
        <Rack3D className={styles.rackArt} accent="#7C6CF6" />
      </div>

      {/* editorial headline */}
      <h1 className={styles.title}>
        Scan the rack. <span className={styles.titleItalic}>Know&nbsp;everything.</span>
      </h1>
      <p className={styles.sub}>
        AI-powered device &amp; port identification for datacenter technicians.
      </p>

      {/* primary CTA */}
      <button type="button" className={styles.cta} onClick={() => navigate('/scan')}>
        <span className={styles.ctaText}>Get started</span>
        <span className={styles.ctaGo}><ArrowR /></span>
      </button>
    </div>
  );
}

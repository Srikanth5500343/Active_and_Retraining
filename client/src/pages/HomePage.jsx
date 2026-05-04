import { useNavigate } from 'react-router-dom';
import styles from './HomePage.module.css';
import ThemeToggle from '../components/ThemeToggle.jsx';
import { useTheme } from '../ThemeContext.jsx';

const NODES = [
  { x: 44, y: 20, type: 'patch',    s: 'ok'     },
  { x: 70, y: 30, type: 'switch',   s: 'ok'     },
  { x: 78, y: 55, type: 'server',   s: 'ok'     },
  { x: 62, y: 72, type: 'server',   s: 'target' },
  { x: 33, y: 68, type: 'switch',   s: 'ok'     },
  { x: 20, y: 48, type: 'pdu',      s: 'warn'   },
  { x: 28, y: 28, type: 'firewall', s: 'ok'     },
  { x: 52, y: 48, type: 'core',     s: 'ok'     },
];

function RadarViz() {
  const target = NODES.find(n => n.s === 'target');
  return (
    <div className={styles.radar}>
      <svg viewBox="0 0 100 100" className={styles.radarSvg} aria-hidden="true">
        <circle cx="50" cy="50" r="47" fill="none" stroke="rgba(6,182,212,0.06)" strokeWidth="0.5"/>
        <circle cx="50" cy="50" r="40" fill="none" stroke="rgba(6,182,212,0.12)" strokeWidth="0.4" strokeDasharray="2 5"/>
        <circle cx="50" cy="50" r="28" fill="none" stroke="rgba(6,182,212,0.22)" strokeWidth="0.5"/>
        <circle cx="50" cy="50" r="16" fill="rgba(6,182,212,0.04)" stroke="rgba(6,182,212,0.28)" strokeWidth="0.6"/>
        <line x1="2" y1="50" x2="98" y2="50" stroke="rgba(6,182,212,0.07)" strokeWidth="0.3"/>
        <line x1="50" y1="2" x2="50" y2="98" stroke="rgba(6,182,212,0.07)" strokeWidth="0.3"/>
        {NODES.filter(n => n.s !== 'target').map((n, i) => (
          <line key={i} x1={n.x} y1={n.y} x2={target.x} y2={target.y}
            stroke="rgba(6,182,212,0.1)" strokeWidth="0.3"/>
        ))}
        <circle cx={target.x} cy={target.y} r="4"
          fill="none" stroke="rgba(244,63,94,0.5)" strokeWidth="0.6"
          className={styles.targetPulse1}/>
        <circle cx={target.x} cy={target.y} r="7"
          fill="none" stroke="rgba(244,63,94,0.2)" strokeWidth="0.4"
          className={styles.targetPulse2}/>
      </svg>
      <div className={styles.sweep} />
      {NODES.map((n, i) => (
        <div key={i}
          className={`${styles.node} ${
            n.s === 'target' ? styles.nodeTarget :
            n.s === 'warn'   ? styles.nodeWarn   :
            styles.nodeOk
          }`}
          style={{ left: `${n.x}%`, top: `${n.y}%` }}
        />
      ))}
      <div className={styles.radarCenter}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--c1)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="3" width="20" height="4" rx="1"/>
          <rect x="2" y="10" width="20" height="4" rx="1"/>
          <rect x="2" y="17" width="20" height="4" rx="1"/>
          <circle cx="18.5" cy="5"  r="1.2" fill="var(--green)" stroke="none"/>
          <circle cx="18.5" cy="12" r="1.2" fill="var(--c1)"   stroke="none"/>
          <circle cx="18.5" cy="19" r="1.2" fill="var(--red)"  stroke="none"/>
        </svg>
      </div>
      <div className={styles.incidentPin} style={{ left: `${target.x}%`, top: `${target.y}%` }}>
        <span className={styles.pinDot} />
        <span className={styles.pinLabel}>R750 · U39</span>
      </div>
    </div>
  );
}

export default function HomePage() {
  const navigate = useNavigate();
  const { theme } = useTheme();
  const logoSrc = theme === 'light' ? '/white_logo.png' : '/dark_logo.png';
  return (
    <div className={`page ${styles.home}`}>
      <div className={styles.ambTop} />
      <div className={styles.ambBL} />
      <div className={styles.ambBR} />

      {/* Header */}
      <header className={styles.header}>
        <div className={styles.logo}>
          <div className={styles.logoMark}>
            <img src={logoSrc} alt="RackTrack" className={styles.logoImg} />
          </div>
          <span className={styles.logoText}>RackTrack</span>
        </div>
        <ThemeToggle />
      </header>

      <div className={styles.content}>

        {/* ── Title ── */}
        <div className={styles.textBlock}>
          <div className={styles.eyebrow}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
            </svg>
            Smart Rack Intelligence
          </div>
          <h1 className={styles.h1}>
            Locate <span className="gt">ports</span> with one scan.
          </h1>
        </div>

        {/* ── Hero image — no background, invisible container ── */}
        <img src="/hero.png" alt="RackTrack hero" className={styles.heroImage} />

        {/* ── CTA ── */}
        <button
          className={`btn btn-primary btn-lg btn-full ${styles.cta}`}
          onClick={() => navigate('/scan')}
        >
          Start Scanning
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
          </svg>
        </button>

      </div>
    </div>
  );
}

import { Link } from 'react-router-dom';
import styles from './HomePage.module.css';

// Tiny preview of how the HomePage header looks with a given logo.
function PhonePreview({ logoSrc, label }) {
  return (
    <div style={{
      width: '320px',
      maxWidth: '90vw',
      height: '640px',
      borderRadius: '36px',
      background: '#010b1f',
      border: '8px solid #1a2238',
      boxShadow: '0 30px 60px rgba(0,0,0,0.45)',
      overflow: 'hidden',
      display: 'flex',
      flexDirection: 'column',
      position: 'relative',
    }}>
      {/* Notch */}
      <div style={{
        width: '100px', height: '24px',
        background: '#000',
        borderRadius: '0 0 16px 16px',
        margin: '0 auto',
      }}/>

      {/* Mini HomePage header */}
      <div style={{ padding: '32px 24px 0' }}>
        <div className={styles.logo} style={{ marginBottom: 24 }}>
          <div className={styles.logoMark}>
            <img src={logoSrc} alt="logo" className={styles.logoImg} />
          </div>
          <span className={styles.logoText}>RackTrack</span>
        </div>

        <div className={styles.eyebrow} style={{ marginBottom: 12 }}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
          </svg>
          Smart Rack Intelligence
        </div>
        <h1 className={styles.h1} style={{ fontSize: '1.5rem', lineHeight: 1.2 }}>
          Locate <span className="gt">ports</span> with one scan.
        </h1>
      </div>

      {/* Big logo preview centered for clarity — no background, no glow */}
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
      }}>
        <img src={logoSrc} alt="logo full" style={{
          maxWidth: '70%', maxHeight: '70%', objectFit: 'contain',
        }}/>
      </div>

      {/* Label strip */}
      <div style={{
        padding: '14px',
        textAlign: 'center',
        background: 'rgba(59,130,246,0.08)',
        borderTop: '1px solid rgba(59,130,246,0.2)',
        color: '#c8deff',
        fontSize: '0.85rem',
        fontWeight: 700,
        letterSpacing: '0.05em',
      }}>
        {label}
      </div>
    </div>
  );
}

export default function LogoCompare() {
  return (
    <div style={{
      minHeight: '100vh',
      background: 'radial-gradient(circle at 50% 0%, #0a1124 0%, #010b1f 50%, #02091a 100%)',
      padding: '32px 16px',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 24,
    }}>
      <div style={{ textAlign: 'center', color: '#f0f6ff' }}>
        <h2 style={{ margin: 0, fontSize: '1.4rem', fontWeight: 800 }}>Logo Comparison</h2>
        <p style={{ margin: '6px 0 0', color: 'rgba(255,255,255,0.6)', fontSize: '.85rem' }}>
          Pick the one you like — both shown how they appear in the app.
        </p>
      </div>

      <div style={{
        display: 'flex',
        gap: 32,
        flexWrap: 'wrap',
        justifyContent: 'center',
        alignItems: 'flex-start',
      }}>
        <PhonePreview logoSrc="/logo.png" label="logo.png" />
        <PhonePreview logoSrc="/logo2.png" label="logo2.png" />
      </div>

      <Link to="/" style={{
        marginTop: 16,
        color: '#60a5fa',
        textDecoration: 'none',
        fontSize: '.9rem',
      }}>← Back to app</Link>
    </div>
  );
}

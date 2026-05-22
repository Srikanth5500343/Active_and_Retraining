import { NavLink } from 'react-router-dom';
import styles from './BottomNav.module.css';
import { useShutter } from '../ShutterContext.jsx';
import { useAuth } from '../AuthContext.jsx';

const IconHome = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 9.5L12 3l9 6.5V20a1 1 0 01-1 1H4a1 1 0 01-1-1V9.5z"/>
    <path d="M9 21V12h6v9"/>
  </svg>
);
const IconScan = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/>
    <circle cx="12" cy="13" r="4"/>
  </svg>
);
const IconProfile = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/>
    <circle cx="12" cy="7" r="4"/>
  </svg>
);

const NAV_ITEMS = [
  { to: '/', end: true, icon: <IconHome />, label: 'Home' },
  { to: '/scan', icon: <IconScan />, label: 'Scan' },
  { to: '/profile', icon: <IconProfile />, label: 'Profile' },
];

export default function BottomNav() {
  const { fn: shutterFn, canShoot } = useShutter();
  const { isAuthed } = useAuth();
  const shutterActive = typeof shutterFn === 'function';

  // Hide the nav entirely for unauthenticated visitors — they should only
  // see the home/login/signup pages with no app chrome.
  if (!isAuthed) return null;

  return (
    <nav className={styles.nav}>
      <div className={styles.bar}>
        {NAV_ITEMS.map((item, idx) => {
          const isMiddle = idx === 1;
          if (isMiddle && shutterActive) {
            return (
              <button
                key="shutter"
                type="button"
                className={`${styles.item} ${styles.shutterItem} ${canShoot ? styles.shutterReady : ''}`}
                onClick={() => { if (canShoot) shutterFn(); }}
                disabled={!canShoot}
              >
                <div className={styles.iconWrap}>
                  <div className={styles.shutterDot}/>
                </div>
                <span className={styles.label}>Capture</span>
              </button>
            );
          }
          return (
            <NavLink key={item.to} to={item.to} end={item.end}
              className={({ isActive }) => `${styles.item} ${isActive ? styles.active : ''}`}>
              <div className={styles.iconWrap}>{item.icon}</div>
              <span className={styles.label}>{item.label}</span>
            </NavLink>
          );
        })}
      </div>
    </nav>
  );
}

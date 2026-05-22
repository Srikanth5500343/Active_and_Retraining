import styles from './ScanTabBar.module.css';

const TABS = [
  { key: 'overview',  label: 'Overview',  icon: <IconRack /> },
  { key: 'ports',     label: 'Ports',     icon: <IconPorts /> },
  { key: 'topology',  label: 'Topology',  icon: <IconTopology /> },
  { key: 'vr',        label: 'VR Inspect', icon: <IconVR /> },
  { key: 'network',   label: 'Network',   icon: <IconNetwork /> },
  { key: 'switches',  label: 'Switches',  icon: <IconSwitch /> },
  { key: 'drift',     label: 'Drift',     icon: <IconDrift /> },
];

export default function ScanTabBar({ activeTab, onTabChange, badges = {} }) {
  return (
    <nav className={styles.tabBar} role="tablist" aria-label="Scan results tabs">
      <div className={styles.tabScroll}>
        {TABS.map(tab => {
          const isActive = activeTab === tab.key;
          const badge = badges[tab.key];
          return (
            <button
              key={tab.key}
              role="tab"
              aria-selected={isActive}
              className={`${styles.tab} ${isActive ? styles.tabActive : ''}`}
              onClick={() => onTabChange(tab.key)}
              type="button"
            >
              <span className={styles.tabIcon}>{tab.icon}</span>
              <span className={styles.tabLabel}>{tab.label}</span>
              {badge != null && badge > 0 && (
                <span className={styles.tabBadge}>{badge}</span>
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

// ── Tab icons (20×20, clean stroke style) ───────────────────────

function IconRack() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="2" width="16" height="20" rx="2"/>
      <line x1="8" y1="6" x2="16" y2="6"/>
      <line x1="8" y1="10" x2="16" y2="10"/>
      <line x1="8" y1="14" x2="16" y2="14"/>
      <line x1="8" y1="18" x2="16" y2="18"/>
    </svg>
  );
}

function IconGrid() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1.5"/>
      <rect x="14" y="3" width="7" height="7" rx="1.5"/>
      <rect x="3" y="14" width="7" height="7" rx="1.5"/>
      <rect x="14" y="14" width="7" height="7" rx="1.5"/>
    </svg>
  );
}

function IconPorts() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="6" width="20" height="12" rx="2.5"/>
      <line x1="6" y1="10" x2="6" y2="14"/>
      <line x1="10" y1="10" x2="10" y2="14"/>
      <line x1="14" y1="10" x2="14" y2="14"/>
      <line x1="18" y1="10" x2="18" y2="14"/>
    </svg>
  );
}

function IconTopology() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="2" width="6" height="6" rx="1.5"/>
      <rect x="2" y="16" width="6" height="6" rx="1.5"/>
      <rect x="16" y="16" width="6" height="6" rx="1.5"/>
      <path d="M12 8v4M5 16v-4h14v4"/>
    </svg>
  );
}

function IconNetwork() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3"/>
      <circle cx="5" cy="5" r="2"/>
      <circle cx="19" cy="5" r="2"/>
      <circle cx="5" cy="19" r="2"/>
      <circle cx="19" cy="19" r="2"/>
      <line x1="7" y1="7" x2="10" y2="10"/>
      <line x1="17" y1="7" x2="14" y2="10"/>
      <line x1="7" y1="17" x2="10" y2="14"/>
      <line x1="17" y1="17" x2="14" y2="14"/>
    </svg>
  );
}

function IconSwitch() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="5" rx="1.5"/>
      <rect x="2" y="10" width="20" height="5" rx="1.5"/>
      <rect x="2" y="17" width="20" height="5" rx="1.5"/>
      <circle cx="18" cy="5.5" r="1.2" fill="currentColor" stroke="none"/>
      <circle cx="18" cy="12.5" r="1.2" fill="currentColor" stroke="none"/>
      <circle cx="18" cy="19.5" r="1.2" fill="currentColor" stroke="none"/>
    </svg>
  );
}

function IconDrift() {
  // Time-series glyph: a row of stepped bars suggesting state transitions
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 17h3v-5h4v-4h4v8h4v-3h3"/>
      <line x1="3" y1="21" x2="21" y2="21"/>
    </svg>
  );
}

function IconVR() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 8a4 4 0 014-4h12a4 4 0 014 4v6a4 4 0 01-4 4h-2l-2 2-2-2H6a4 4 0 01-4-4V8z"/>
      <circle cx="8" cy="11" r="2"/>
      <circle cx="16" cy="11" r="2"/>
    </svg>
  );
}

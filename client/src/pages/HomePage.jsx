import { useNavigate } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import styles from './HomePage.module.css';
import ThemeToggle from '../components/ThemeToggle.jsx';
import { useTheme } from '../ThemeContext.jsx';
import { useAuth } from '../AuthContext.jsx';
import HomeLight from './HomeLight.jsx';
import HomeDark from './HomeDark.jsx';

/* ──────────────────────────────────────────────────────────────────────
   HomePage — RackTrack, modelled on the EV app reference

   Views (user-controlled):
     home      — light/cream, greeting + rack card + uptime + DC map
     controls  — dark, rack centred + tile grid (Uptime/Temp/Net/Lock/Maint)
     alert     — red glow + alert pins on rack + 2 mild issues card
     network   — dark, rack at centre with named nodes + stats
     map       — dark, datacenter route + DC list

   The rack is a real CSS-3D object (no PNG) — it tilts as a stack of unit
   panels (switches, firewall, servers, PDU) and rotates via --rot-y.
   ────────────────────────────────────────────────────────────────────── */

const Back   = (p) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" {...p}><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>);
const ChevL  = (p) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" {...p}><polyline points="15 18 9 12 15 6"/></svg>);
const ChevR  = (p) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" {...p}><polyline points="9 18 15 12 9 6"/></svg>);
const Bolt   = (p) => (<svg viewBox="0 0 24 24" fill="currentColor" {...p}><path d="M13 2L3 14h7l-1 8 11-14h-7l0-6z"/></svg>);
const Bell   = (p) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 8H4c0-2 2-3 2-8z"/><path d="M10 21a2 2 0 0 0 4 0"/></svg>);
const ArrowR = (p) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" {...p}><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>);
const IcCamera = (p) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="4"/></svg>);

/* ─── Real CSS 3D rack ─────────────────────────────────────────────────
   The whole rack is a stack of unit panels rendered in 3D. The
   parent's --rot-y rotates them; each panel has a back/side face
   via pseudo-elements so depth is visible from any angle.
   ──────────────────────────────────────────────────────────────────── */
function Rack3D({ active, port }) {
  return (
    <div className={styles.rack3d}>
      {/* Frame edges (top + side bars to suggest the rack chassis) */}
      <div className={styles.rackFrameTop} aria-hidden="true" />
      <div className={styles.rackFrameSide} aria-hidden="true" />
      <div className={styles.rackFrameBase} aria-hidden="true" />

      {/* Unit stack — rendered top-down */}
      <div className={styles.rackStack}>
        {/* 1U switch — S-48 */}
        <div className={`${styles.u} ${styles.uSwitch} ${active === 'S-48' ? styles.uActive : ''}`} data-unit="S-48">
          <div className={styles.uFace}>
            <div className={styles.uTag}>S-48</div>
            <div className={styles.uPorts}>
              {Array.from({ length: 24 }).map((_, i) => {
                const isTarget = active === 'S-48' && port === i + 1;
                return (
                  <span
                    key={i}
                    className={`${styles.uPort} ${isTarget ? styles.uPortTarget : ''}`}
                    style={{ animationDelay: `${(i * 80) % 2400}ms` }}
                  />
                );
              })}
            </div>
            <div className={styles.uLed} />
          </div>
        </div>

        {/* 1U switch — S-24 */}
        <div className={styles.u}>
          <div className={styles.uFace}>
            <div className={styles.uTag}>S-24</div>
            <div className={styles.uPorts}>
              {Array.from({ length: 12 }).map((_, i) => (
                <span key={i} className={styles.uPort} style={{ animationDelay: `${(i * 110) % 2400}ms` }} />
              ))}
            </div>
            <div className={styles.uLed} />
          </div>
        </div>

        {/* 2U blank / cable management */}
        <div className={`${styles.u} ${styles.uBlank} ${styles.u2}`}>
          <div className={styles.uFace}>
            <div className={styles.uVent} />
            <div className={styles.uVent} />
            <div className={styles.uVent} />
          </div>
        </div>

        {/* 1U firewall — F-20 */}
        <div className={`${styles.u} ${styles.uFirewall} ${active === 'F-20' ? styles.uActive : ''}`} data-unit="F-20">
          <div className={styles.uFace}>
            <div className={styles.uTag}>F-20</div>
            <div className={styles.uScreen}>
              <span className={styles.uScreenBlip} />
              <span className={styles.uScreenBlip} />
              <span className={styles.uScreenBlip} />
            </div>
            <div className={`${styles.uLed} ${styles.uLedAmber}`} />
          </div>
        </div>

        {/* 1U server */}
        <div className={`${styles.u} ${styles.uServer}`}>
          <div className={styles.uFace}>
            <div className={styles.uDisks}>
              <span/><span/><span/><span/><span/><span/>
            </div>
            <div className={styles.uLed} />
          </div>
        </div>

        {/* 1U server */}
        <div className={`${styles.u} ${styles.uServer}`}>
          <div className={styles.uFace}>
            <div className={styles.uDisks}>
              <span/><span/><span/><span/><span/><span/>
            </div>
            <div className={styles.uLed} />
          </div>
        </div>

        {/* 2U PDU — PDU-A (warn state) */}
        <div className={`${styles.u} ${styles.u2} ${styles.uPdu} ${active === 'PDU-A' ? styles.uActive : ''}`} data-unit="PDU-A">
          <div className={styles.uFace}>
            <div className={styles.uTag}>PDU-A</div>
            <div className={styles.uOutlets}>
              {Array.from({ length: 6 }).map((_, i) => {
                const isTarget = active === 'PDU-A' && port === i + 1;
                return (
                  <span
                    key={i}
                    className={`${styles.uOutlet} ${isTarget ? styles.uOutletTarget : ''}`}
                  />
                );
              })}
            </div>
            <div className={`${styles.uLed} ${styles.uLedAmber}`} />
          </div>
        </div>
      </div>
    </div>
  );
}

/* Racks the user can swipe between, modelled on the real RackTrack
   data: short ID + role label, capacity (U-units + active ports), DC.
   Each rack carries its open ServiceNow incident — the same one is
   threaded through every view. Device IDs use the real
   U-XX-CLASS-NN format from ResultsPage (U01-SW01 etc). */
const RACKS = [
  {
    id: 'R-101', role: 'Core',     u: 24, ports: 48, dc: 'Chennai-DC1',
    devices: [
      { tag: 'U01-SW01', name: 'Catalyst 9300',     ports: 24, status: 'ok'   },
      { tag: 'U02-SW02', name: 'Catalyst 9200',     ports: 12, status: 'ok'   },
      { tag: 'U05-FW01', name: 'Firewall · HA',     ports: 8,  status: 'ok'   },
      { tag: 'U07-PP01', name: 'Patch panel · 48p', ports: 48, status: 'ok'   },
      { tag: 'U10-PDU01', name: 'PDU · 6× 120V',    ports: 6,  status: 'warn' },
    ],
    incident: {
      number: 'INC0042', priority: 'P3',
      device: 'U01-SW01', port: 14,
      summary: 'Port 14 link flapping · 4% packet loss',
      cmdb: { state: 'open', summary: { added_devices: 0, changed_devices: 1, added_ports: 0 }, opened: '2h ago' },
    },
  },
  {
    id: 'R-102', role: 'Edge A',   u: 24, ports: 24, dc: 'Chennai-DC1',
    devices: [
      { tag: 'U01-SW01', name: 'Edge switch',       ports: 12, status: 'ok' },
      { tag: 'U03-PP01', name: 'Patch panel · 24p', ports: 24, status: 'ok' },
    ],
    incident: null,
  },
  {
    id: 'R-103', role: 'Edge B',   u: 24, ports: 24, dc: 'Hyderabad-DC2',
    devices: [
      { tag: 'U01-SW01', name: 'Edge switch',       ports: 24, status: 'warn' },
      { tag: 'U06-PP01', name: 'Patch panel · 48p', ports: 48, status: 'ok'   },
    ],
    incident: {
      number: 'INC0058', priority: 'P2',
      device: 'U01-SW01', port: 14,
      summary: 'Port 14 link flapping · 4% packet loss',
      cmdb: { state: 'open', summary: { added_devices: 0, changed_devices: 0, added_ports: 0 }, opened: '14m ago' },
    },
  },
];

/* The SCREENS that loop when you tap the rack:
     home → controls → scan → network → alert → home → ...
   The 3 feature screens (scan/network/alert) are also reachable
   directly by tapping their tile in controls. */
const SCREENS    = ['home', 'controls', 'scan', 'alert'];
const FLOW       = ['scan', 'alert'];
/* Each non-home view is one step of a simple 3-step workflow that
   the user walks through — see the problem, find the device, fix it. */
const STEP_LABEL = {
  controls: 'Step 1 · See the issue',
  scan:     'Step 2 · Find the device',
  alert:    'Step 3 · Locate the port',
};

export default function HomePage() {
  const navigate = useNavigate();
  const { theme } = useTheme();
  const auth = useAuth();
  const userName =
    (auth?.user?.username) ||
    (auth?.user?.name) ||
    (auth?.user?.email && String(auth.user.email).split('@')[0]) ||
    'Engineer';
  const logoSrc = theme === 'light' ? '/white_logo.png' : '/dark_logo.png';

  const [view, setView] = useState('home');
  const [idx, setIdx]   = useState(0);
  const [rotY, setRotY] = useState(0);
  const dragRef = useRef({ active: false, startX: 0, base: 0, moved: 0 });
  const rack = RACKS[idx];

  const goView = (v) => () => setView(v);
  const goPrev = () => setIdx((i) => (i - 1 + RACKS.length) % RACKS.length);
  const goNext = () => setIdx((i) => (i + 1) % RACKS.length);

  /* Linear flow through the 5 in-page views */
  const flowIdx = FLOW.indexOf(view);
  const inFlow  = flowIdx !== -1;

  /* Tap on the rack ⇒ advance through all 5 SCREENS in a loop:
       home → controls → scan → network → alert → home → ...
     Drag still rotates; we use the moved-distance to distinguish. */
  const advanceOnTap = () => {
    const i = SCREENS.indexOf(view);
    setView(SCREENS[(i + 1) % SCREENS.length]);
  };

  /* Drag-to-rotate the 3D rack — also detects tap-without-drag */
  const onPointerDown = (e) => {
    dragRef.current = { active: true, startX: e.clientX, base: rotY, moved: 0 };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (!d.active) return;
    const delta = e.clientX - d.startX;
    d.moved = Math.max(d.moved, Math.abs(delta));
    setRotY(Math.max(-32, Math.min(32, d.base + delta * 0.30)));
  };
  const onPointerUp = (e) => {
    const d = dragRef.current;
    d.active = false;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    setRotY(0); /* spring back via CSS transition */
    /* If pointer barely moved, treat as a tap → advance the flow */
    if (d.moved < 6) advanceOnTap();
  };

  /* When view changes, reset rotation */
  useEffect(() => { setRotY(0); }, [view]);

  /* Light theme gets a completely separate, light-native home screen.
     (All hooks above still run — order is preserved — so this early
     return is React-safe and leaves the dark experience untouched.) */
  if (theme === 'light') return <HomeLight />;
  return <HomeDark />;

  /* eslint-disable no-unreachable */
  return (
    <div className={`page ${styles.home} ${styles[`v_${view}`]}`}>

      {/* Backdrop glow */}
      <div className={styles.backdrop} aria-hidden="true">
        <div className={styles.backdropGlow} />
      </div>

      {/* Back chevron — visible in non-home views.
          Any flow view returns to controls (the hub). Controls returns home. */}
      {view !== 'home' && (
        <button
          type="button"
          className={styles.backBtn}
          aria-label="Back"
          onClick={goView(inFlow ? 'controls' : 'home')}
        >
          <Back />
        </button>
      )}

      {/* Mode label — the step number + plain-English purpose of the view */}
      <div className={styles.modeLabel}>
        {STEP_LABEL[view] && (<span className={styles.modeBold}>{STEP_LABEL[view]}</span>)}
      </div>

      {/* 5-screen indicator dots — show position in the loop.
          The rack itself is the navigation: tap it to advance. */}
      {view !== 'home' && (
        <div className={styles.flowDots} aria-hidden="true">
          {SCREENS.map((s) => (
            <span key={s} className={`${styles.flowDot} ${s === view ? styles.flowDotOn : ''}`} />
          ))}
        </div>
      )}


      {/* ═══════════════════════════════════════════════════════════
          HOME — clean, compact, uniform layout with hero rack image
          ═══════════════════════════════════════════════════════════ */}
      <div className={styles.homeView}>
        <header className={styles.homeHead}>
          <div className={styles.brand}>
            <div className={styles.brandMark}>
              <img src={logoSrc} alt="" className={styles.brandLogo} />
            </div>
            <h1 className={styles.greet}>
              <span className={styles.greetLight}>Hey</span>{' '}
              <span className={styles.greetBold}>{userName}</span>
            </h1>
          </div>
          <ThemeToggle />
        </header>

        {/* Hero rack image — floating, no container, no labels.
            Ripple rings sit beneath the rack to signal "tap me". */}
        <button
          type="button"
          className={styles.rackHero}
          onClick={goView('controls')}
          aria-label={`Open ${rack.id}`}
        >
          <span className={styles.rackRipple} aria-hidden="true">
            <span className={styles.rackRippleRing} />
            <span className={styles.rackRippleRing} />
            <span className={styles.rackRippleRing} />
          </span>
          <img src="/hero.png" alt="" className={styles.rackHeroImg} />
        </button>

        {/* Two uniform action cards — same shape, primary filled, secondary outlined */}
        <button
          type="button"
          className={styles.primaryCta}
          onClick={() => navigate('/scan')}
        >
          <span className={styles.primaryCtaIcon}><IcCamera /></span>
          <span className={styles.primaryCtaText}>
            <span className={styles.primaryCtaTitle}>Snap a rack</span>
            <span className={styles.primaryCtaSub}>Identify every device in seconds</span>
          </span>
          <span className={styles.primaryCtaGo}><ArrowR /></span>
        </button>

      </div>

      {/* ═══════════════════════════════════════════════════════════
          CONTROLS — incident-led layout, not generic tile grid
          ───────────────────────────────────────────────────────────
          The active ServiceNow incident is the HERO of this screen
          (one big card with priority + target + summary + a single
          primary "Locate" action).  Underneath: a slim chip row of
          the three RackTrack tools — Scan / Topology / Devices.
          ═══════════════════════════════════════════════════════════ */}
      <div className={styles.controlsView}>

        {/* Step 1 panel — sophisticated, layered, single cohesive card.
            Ambient glow inside, iOS-style rounded icon tile, big typographic
            hierarchy, refined inline CTA. Restrained colour: severity reads
            from the ribbon, the icon tint, and the chip — not the whole card. */}
        {rack.incident ? (
          <div className={`${styles.issuePanel} ${styles[`issuePanel_${rack.incident.priority}`]}`}>
            {/* Ambient glow inside the card */}
            <span className={styles.issuePanelGlow} aria-hidden="true" />

            {/* Top meta strip */}
            <div className={styles.issuePanelMeta}>
              <span className={styles.issuePanelRackChip}>
                <span className={styles.issuePanelRackChipId}>{rack.id}</span>
                <span className={styles.issuePanelRackChipDot} />
                <span>{rack.role}</span>
                <span className={styles.issuePanelRackChipDot} />
                <span>{rack.dc}</span>
              </span>
              <span className={styles.issuePanelPri}>
                <span className={styles.issuePanelPriDot} />
                {rack.incident.priority} · {rack.incident.number}
              </span>
            </div>

            {/* Hero row — icon tile + headline stack */}
            <div className={styles.issuePanelHero}>
              <div className={styles.issuePanelIcon}>
                <span className={styles.issuePanelIconRing} aria-hidden="true" />
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 9v4"/><path d="M12 17h.01"/>
                  <path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                </svg>
              </div>
              <div className={styles.issuePanelHeroText}>
                <span className={styles.issuePanelEyebrow}>Heads up</span>
                <h2 className={styles.issuePanelTitle}>One of your devices needs attention</h2>
                <div className={styles.issuePanelTarget}>
                  <span className={styles.issuePanelTargetIcon}>
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1" fill="currentColor"/>
                    </svg>
                  </span>
                  Port&nbsp;<b>{rack.incident.port}</b>&nbsp;on&nbsp;<span className={styles.issuePanelTag}>{rack.incident.device}</span>
                </div>
              </div>
            </div>

            {/* Inline action */}
            <button type="button" className={styles.issuePanelAction} onClick={goView('scan')}>
              <span className={styles.issuePanelActionText}>Find it on the rack</span>
              <span className={styles.issuePanelActionArrow}><ArrowR /></span>
            </button>
          </div>
        ) : (
          <div className={`${styles.issuePanel} ${styles.issuePanel_clear}`}>
            <span className={styles.issuePanelGlow} aria-hidden="true" />
            <div className={styles.issuePanelMeta}>
              <span className={styles.issuePanelRackChip}>
                <span className={styles.issuePanelRackChipId}>{rack.id}</span>
                <span className={styles.issuePanelRackChipDot} />
                <span>{rack.role}</span>
                <span className={styles.issuePanelRackChipDot} />
                <span>{rack.dc}</span>
              </span>
              <span className={`${styles.issuePanelPri} ${styles.issuePanelPri_ok}`}>
                <span className={styles.issuePanelPriDot} />
                Healthy
              </span>
            </div>
            <div className={styles.issuePanelHero}>
              <div className={styles.issuePanelIcon}>
                <span className={styles.issuePanelIconRing} aria-hidden="true" />
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6 9 17l-5-5"/>
                </svg>
              </div>
              <div className={styles.issuePanelHeroText}>
                <span className={styles.issuePanelEyebrow}>All clear</span>
                <h2 className={styles.issuePanelTitle}>Everything looks good</h2>
                <div className={styles.issuePanelTarget}>No issues on this rack right now.</div>
              </div>
            </div>
            <button type="button" className={styles.issuePanelAction} onClick={goView('scan')}>
              <span className={styles.issuePanelActionText}>Scan anyway</span>
              <span className={styles.issuePanelActionArrow}><ArrowR /></span>
            </button>
          </div>
        )}

      </div>

      {/* ═══════════════════════════════════════════════════════════
          THE 3D RACK — single instance, repositions across views
          ═══════════════════════════════════════════════════════════ */}
      <div
        className={styles.rackStage}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{ '--rot-y': `${rotY}deg` }}
      >
        <div className={styles.rackSpot} aria-hidden="true" />
        {(() => {
          /* Map the real incident device tag to its visible rack unit. The
             same unit is highlighted in both Step 2 (find the device) and
             Step 3 (locate the port). The exact port glow only kicks in
             on Step 3 so Step 2 stays a clean "this is the device" view. */
          const DEVICE_UNIT = {
            'U01-SW01': 'S-48',
            'U02-SW02': 'S-24',
            'U05-FW01': 'F-20',
            'U10-PDU01': 'PDU-A',
          };
          const showHighlight = (view === 'scan' || view === 'alert') && rack.incident;
          const activeUnit = showHighlight ? DEVICE_UNIT[rack.incident.device] || null : null;
          const activePort = view === 'alert' ? rack.incident?.port : null;
          return <Rack3D active={activeUnit} port={activePort} />;
        })()}

        {/* Network mode overlay lives in the .netCanvas layer below — out of the rack stage */}
      </div>

      {/* ═══════════════════════════════════════════════════════════
          MAINTENANCE bottom card — modelled on CmdbTicketBanner.jsx.
          Shows the actual ServiceNow ticket lifecycle (open / applied
          / rejected / cancelled), the change summary (±devices, ±ports),
          and the same Refresh / View on ServiceNow / Cancel actions.
          ═══════════════════════════════════════════════════════════ */}
      <div className={`${styles.bottomCard} ${styles.alertCard}`}>
        {rack.incident ? (
          <>
            <div className={styles.portCard}>
              {/* Big port-number badge — this is the answer to "where do I fix it" */}
              <div className={styles.portBadge}>
                <span className={styles.portBadgeLabel}>PORT</span>
                <span className={styles.portBadgeNum}>{rack.incident.port}</span>
              </div>

              <div className={styles.portInfo}>
                <div className={styles.portInfoDevice}>{rack.incident.device}</div>
                <div className={styles.portInfoHint}>
                  This is the exact port to fix. It's highlighted on the rack above.
                </div>
              </div>
            </div>

          </>
        ) : (
          <div className={styles.cmdbClear}>
            <span className={styles.cmdbClearDot} />
            <div>
              <div className={styles.cmdbClearHead}>Nothing to fix right now</div>
              <div className={styles.cmdbClearSub}>{rack.id} is healthy and synced with ServiceNow.</div>
            </div>
          </div>
        )}
      </div>


      {/* ═══════════════════════════════════════════════════════════
          SCAN view — what RackTrack actually does on /scan:
          camera-based device detection, rack image goes through
          the model, devices are labelled U-XX-CLASS-NN, and the
          incident's port lights up red. The HUD bar mirrors the
          real "LOCATING …" state.
          ═══════════════════════════════════════════════════════════ */}
      <div className={styles.scanHud}>
        <div className={styles.scanHudBar}>
          <span className={styles.scanHudBarFill} />
          <span className={styles.scanHudBarLabel}>
            {rack.incident
              ? `Looking for ${rack.incident.device} in this rack`
              : `Found ${rack.devices.length} devices in this rack`}
          </span>
        </div>

        {/* Device tags floating over the rack — the first three devices
            from the real rack inventory. The one matching the incident
            target is rendered with a red border + pulsing red dot. */}
        {rack.devices.slice(0, 3).map((d, i) => {
          const isTarget = rack.incident?.device === d.tag;
          return (
            <span
              key={`scanchip-${d.tag}`}
              className={`${styles.arChip} ${styles[`arChip${i + 1}`]} ${isTarget ? styles.arChipTarget : ''}`}
            >
              <span className={`${styles.arChipDot} ${isTarget ? styles.arChipDotTarget : (d.status === 'warn' ? styles.arChipDotWarn : '')}`} />
              {d.tag}
              <span className={styles.arChipPorts}>· {d.ports}p</span>
            </span>
          );
        })}

        <button type="button" className={styles.scanHudCta} onClick={goView('alert')}>
          Find the port <ArrowR />
        </button>
      </div>


    </div>
  );
}

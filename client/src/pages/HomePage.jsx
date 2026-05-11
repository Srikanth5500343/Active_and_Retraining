import { useNavigate } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import styles from './HomePage.module.css';
import ThemeToggle from '../components/ThemeToggle.jsx';
import { useTheme } from '../ThemeContext.jsx';
import { useAuth } from '../AuthContext.jsx';

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
function Rack3D({ active }) {
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
              {Array.from({ length: 24 }).map((_, i) => (
                <span key={i} className={styles.uPort} style={{ animationDelay: `${(i * 80) % 2400}ms` }} />
              ))}
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
              {Array.from({ length: 6 }).map((_, i) => (
                <span key={i} className={styles.uOutlet} />
              ))}
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
      device: 'U10-PDU01', port: 6,
      summary: 'Outlet 6 · 87% load · breaker risk',
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

/* Sibling racks + their network status */
const NET_NODES = [
  { id: 'R-101', label: 'R-101 · Core',   status: 'ok',   ports: 48, links: 6 },
  { id: 'R-102', label: 'R-102 · Edge A', status: 'ok',   ports: 24, links: 4 },
  { id: 'R-103', label: 'R-103 · Edge B', status: 'warn', ports: 24, links: 3 },
  { id: 'R-104', label: 'R-104 · DMZ',    status: 'down', ports: 12, links: 0 },
];

/* The 5 SCREENS that loop when you tap the rack:
     home → controls → scan → network → alert → home → ...
   The 3 feature screens (scan/network/alert) are also reachable
   directly by tapping their tile in controls. */
const SCREENS    = ['home', 'controls', 'scan', 'network', 'alert'];
const FLOW       = ['scan', 'network', 'alert'];
const FLOW_LABEL = { scan: 'AR Scan', network: 'Topology', alert: 'Maintenance' };

export default function HomePage() {
  const navigate = useNavigate();
  const { theme } = useTheme();
  const auth = useAuth();
  const userName =
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

      {/* Mode label (active views) */}
      <div className={styles.modeLabel}>
        {view === 'controls' && (<><span className={styles.modeBold}>{rack.name}</span> <span className={styles.modeLight}>{rack.chassis}</span></>)}
        {inFlow && (<span className={styles.modeBold}>{FLOW_LABEL[view]}</span>)}
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
          HOME — uses the app's own theme (white in light, midnight in dark)
          Header: [logo] Hey {name}      [theme toggle]
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

        {/* Rack hero card — real RackTrack label format.
            The home view is the calm "scan entry point" — incident state
            shows up later in the controls/alert views. We deliberately
            don't render the red incident chip or the resolve cue here,
            so the home stays a clean scan affordance. */}
        <button type="button" className={styles.rackCard} onClick={goView('controls')}>
          <div className={styles.rackCardHead}>
            <div className={styles.rackCardName}>{rack.id}</div>
          </div>

          <div className={styles.rackCardSlot} aria-hidden="true">
            {/* The 3D rack lives in the floating .rackStage layer */}
          </div>
        </button>

        {/* Sequential rack nav */}
        <div className={styles.rackNav}>
          <button type="button" className={styles.rackNavBtn} onClick={goPrev} aria-label="Previous rack"><ChevL /></button>
          <div className={styles.rackNavDots}>
            {RACKS.map((r, i) => (
              <span key={r.id} className={`${styles.rackNavDot} ${i === idx ? styles.rackNavDotOn : ''}`} />
            ))}
          </div>
          <button type="button" className={styles.rackNavBtn} onClick={goNext} aria-label="Next rack"><ChevR /></button>
        </div>

        {/* Primary CTA — always the clean scan entry on home. Incident
            details (if any) surface in the controls/alert views, not here. */}
        <button
          type="button"
          className={styles.primaryCta}
          onClick={() => navigate('/scan')}
        >
          <span className={styles.primaryCtaIcon}><IcCamera /></span>
          <span className={styles.primaryCtaText}>
            <span className={styles.primaryCtaTitle}>Start a new scan</span>
            <span className={styles.primaryCtaSub}>Point your camera at the rack</span>
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

        {/* Active incident hero — only when there's one open */}
        {rack.incident ? (
          <div className={`${styles.incHero} ${styles[`incHero_${rack.incident.priority}`]}`}>
            <div className={styles.incHeroHead}>
              <span className={styles.incHeroPri}>{rack.incident.priority}</span>
              <span className={styles.incHeroNum}>{rack.incident.number}</span>
              <span className={styles.incHeroState}>
                <span className={styles.incHeroStateDot} />
                {rack.incident.cmdb.state === 'open' ? 'pending' : rack.incident.cmdb.state}
              </span>
            </div>
            <div className={styles.incHeroTarget}>
              <span className={styles.incHeroTag}>{rack.incident.device}</span>
              <span className={styles.incHeroSep}>:</span>
              <span className={styles.incHeroPort}>port&nbsp;{rack.incident.port}</span>
            </div>
            <div className={styles.incHeroDesc}>{rack.incident.summary}</div>
            <button type="button" className={styles.incHeroAction} onClick={goView('scan')}>
              <span className={styles.incHeroActionDot} />
              Locate on rack
              <ArrowR className={styles.incHeroActionGo} />
            </button>
          </div>
        ) : (
          <div className={`${styles.incHero} ${styles.incHero_clear}`}>
            <div className={styles.incHeroHead}>
              <span className={styles.incHeroStateClear}>
                <span className={styles.incHeroStateDot} />
                CLEAR
              </span>
            </div>
            <div className={styles.incHeroTarget}>No active incidents</div>
            <div className={styles.incHeroDesc}>{rack.id} is healthy · last scan synced</div>
            <button type="button" className={styles.incHeroAction} onClick={goView('scan')}>
              <span className={styles.incHeroActionDot} />
              Run a scan anyway
              <ArrowR className={styles.incHeroActionGo} />
            </button>
          </div>
        )}

        {/* Tool row — 3 small chips, NOT 3 hero cards */}
        <div className={styles.toolRow}>
          <button type="button" className={styles.tool} onClick={goView('scan')}>
            <span className={styles.toolIcon}>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/>
                <path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/>
                <circle cx="12" cy="12" r="4"/>
              </svg>
            </span>
            <span className={styles.toolLabel}>Scan</span>
            <span className={styles.toolMeta}>camera</span>
          </button>
          <button type="button" className={styles.tool} onClick={goView('network')}>
            <span className={styles.toolIcon}>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="5"  r="2.5"/><circle cx="5" cy="19" r="2.5"/><circle cx="19" cy="19" r="2.5"/>
                <line x1="12" y1="7.5" x2="6.5"  y2="17"/><line x1="12" y1="7.5" x2="17.5" y2="17"/>
                <line x1="7.5" y1="19" x2="16.5" y2="19"/>
              </svg>
            </span>
            <span className={styles.toolLabel}>Topology</span>
            <span className={styles.toolMeta}>4 racks</span>
          </button>
          <button type="button" className={styles.tool} onClick={goView('alert')}>
            <span className={styles.toolIcon}>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="6"  width="18" height="4" rx="1"/>
                <rect x="3" y="14" width="18" height="4" rx="1"/>
                <circle cx="18" cy="8"  r="0.8" fill="currentColor"/>
                <circle cx="18" cy="16" r="0.8" fill="currentColor"/>
              </svg>
            </span>
            <span className={styles.toolLabel}>Devices</span>
            <span className={styles.toolMeta}>{rack.devices.length}</span>
          </button>
        </div>

        {/* Tiny rack identity strip below — context for which rack you're working on */}
        <div className={styles.rackStrip}>
          <span className={styles.rackStripId}>{rack.id}</span>
          <span className={styles.rackStripDot} />
          <span className={styles.rackStripRole}>{rack.role}</span>
          <span className={styles.rackStripDot} />
          <span className={styles.rackStripDc}>{rack.dc}</span>
        </div>
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
        <Rack3D active={view === 'alert' ? 'PDU-A' : null} />

        {/* Alert pins — only in alert view */}
        <span className={`${styles.alertPin} ${styles.alertPin1}`}><span>!</span></span>
        <span className={`${styles.alertPin} ${styles.alertPin2}`}><span>!</span></span>

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
            <div className={styles.cmdbHead}>
              <div className={styles.cmdbBadge}>
                <span className={styles.cmdbBadgeDot} />
                ServiceNow CMDB
              </div>
              <div className={styles.cmdbState}>{rack.incident.cmdb.state} · {rack.incident.cmdb.opened}</div>
            </div>
            <div className={styles.cmdbTitle}>
              <span className={styles.cmdbTitleNum}>{rack.incident.number}</span>
              <span className={styles.cmdbTitleSep}>·</span>
              <span className={styles.cmdbTitlePri}>{rack.incident.priority}</span>
            </div>
            <div className={styles.cmdbSummary}>{rack.incident.summary}</div>
            <div className={styles.cmdbChanges}>
              <span><strong>+{rack.incident.cmdb.summary.added_devices}</strong> devices</span>
              <span className={styles.cmdbChangesSep}>·</span>
              <span><strong>~{rack.incident.cmdb.summary.changed_devices}</strong> changed</span>
              <span className={styles.cmdbChangesSep}>·</span>
              <span><strong>+{rack.incident.cmdb.summary.added_ports}</strong> ports</span>
            </div>
            <div className={styles.cmdbActions}>
              <button type="button" className={styles.cmdbBtn} onClick={() => navigate('/scan')}>
                Locate <ArrowR />
              </button>
              <button type="button" className={styles.cmdbBtnGhost}>Refresh</button>
              <button type="button" className={styles.cmdbBtnGhost}>View on SN</button>
            </div>
          </>
        ) : (
          <div className={styles.cmdbClear}>
            <span className={styles.cmdbClearDot} />
            <div>
              <div className={styles.cmdbClearHead}>No open incidents</div>
              <div className={styles.cmdbClearSub}>{rack.id} synced to CMDB · last scan ok</div>
            </div>
          </div>
        )}
      </div>

      {/* ═══════════════════════════════════════════════════════════
          NETWORK view — full-canvas graph spreading from the rack
          (which sits on the LEFT edge) outward to the right.
          NOT a list card.
          ═══════════════════════════════════════════════════════════ */}
      <div className={styles.netCanvas}>
        <svg className={styles.netCanvasSvg} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {NET_NODES.map((n, i) => {
            const cx = 22;
            const cy = 50;
            const positions = [
              { x: 70, y: 22 },
              { x: 84, y: 50 },
              { x: 70, y: 78 },
              { x: 50, y: 92 },
            ][i] || { x: 50, y: 50 };
            const stroke =
              n.status === 'down' ? 'rgba(239,68,68,0.85)' :
              n.status === 'warn' ? 'rgba(245,158,11,0.85)' :
              'rgba(99,102,241,0.65)';
            return (
              <line key={`canvasline-${n.id}`}
                x1={cx} y1={cy} x2={positions.x} y2={positions.y}
                stroke={stroke} strokeWidth="0.4"
                strokeDasharray={n.status === 'down' ? '0.8 1.4' : '1.2 2.0'}
                className={styles.netLine}
                style={{ animationDelay: `${i * 0.10}s` }} />
            );
          })}
        </svg>
        {NET_NODES.map((n, i) => {
          const positions = [
            { x: 70, y: 22 },
            { x: 84, y: 50 },
            { x: 70, y: 78 },
            { x: 50, y: 92 },
          ][i] || { x: 50, y: 50 };
          return (
            <span key={`canvasnode-${n.id}`}
              className={`${styles.netNode} ${styles[`netNode_${n.status}`]}`}
              style={{ left: `${positions.x}%`, top: `${positions.y}%`, animationDelay: `${0.3 + i * 0.10}s` }}>
              <span className={styles.netNodeDot} />
              <span>{n.id}</span>
            </span>
          );
        })}
        <div className={styles.netStrip}>
          <div><strong>{NET_NODES.length}</strong><span> racks</span></div>
          <div><strong>{NET_NODES.reduce((a, n) => a + n.links, 0)}</strong><span> links</span></div>
          <div className={styles.netStripWarn}><strong>1</strong><span> down</span></div>
        </div>
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
              ? `LOCATING ${rack.incident.device} · PORT ${rack.incident.port}`
              : `SCANNING · ${rack.devices.length} / ${rack.devices.length} identified`}
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

        <button type="button" className={styles.scanHudCta} onClick={() => navigate('/ar-scan')}>
          Open AR scan <ArrowR />
        </button>
      </div>


    </div>
  );
}

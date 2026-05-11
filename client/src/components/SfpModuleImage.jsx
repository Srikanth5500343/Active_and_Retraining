import { useState } from 'react';

// Visual identification for SFP transceiver modules.
//
// Renders a real product photo if the server has supplied `module.imageUrl`
// (the SFP pipeline scrapes per-SKU images from JSON-LD product schemas
// and from <img> tags in product cards / table rows). When the URL is
// missing OR fails to load (404, CORS, etc.) we fall back to an inline
// SVG that draws the *front face* of the module: the connector that the
// user will actually be looking at when handling the part. That's the
// most useful visual when no photo is available, because the connector
// determines what cable plugs in.
//
// Inferred from the module data:
//   form factor (SFP / SFP+ / SFP28 / QSFP+ / QSFP28 / QSFP-DD)
//       from partNumber / speed
//   connector (RJ45 / LC duplex / MPO / DAC)
//       from `type` (T / SR / LR / SX / LX / SR4 / LR4 / DAC ...)
//
// All inputs are best-effort — unknown values fall through to a generic
// SFP silhouette so we always render *something*.

const BRAND_COLOURS = {
  cisco:    '#1ba0d7',
  juniper:  '#54bd49',
  arista:   '#e87722',
  ubiquiti: '#0559c9',
  mikrotik: '#ed1c24',
  hpe:      '#01a982',
  dell:     '#007db8',
  netgear:  '#f7a823',
  tplink:   '#4acbd6',
  fs:       '#d5232a',
  finisar:  '#0073e6',
  default:  '#94a3b8',
};

function brandColor(brand) {
  const key = String(brand || '').toLowerCase().replace(/\s+/g, '');
  for (const k of Object.keys(BRAND_COLOURS)) {
    if (key.includes(k)) return BRAND_COLOURS[k];
  }
  return BRAND_COLOURS.default;
}

// Pull connector kind out of the `type` field. Examples:
//   "T"   → rj45     "SR"/"SX"/"LR"/"LX" → lc
//   "SR4"/"LR4"      → mpo    "DAC"              → dac
function inferConnector(module) {
  const t = String(module?.type || '').toUpperCase();
  const p = String(module?.partNumber || '').toUpperCase();
  if (/(^|[-_])T($|[-_])|BASE-?T|RJ45/.test(t) || /(^|[-_])T-?S?($|[-_])/.test(p)) return 'rj45';
  if (/^DAC|TWINAX|DIRECT/.test(t) || /\bDAC\b/.test(p))                          return 'dac';
  if (/SR4|LR4|MPO|MTP/.test(t)    || /\b(SR4|LR4|MPO)\b/.test(p))                return 'mpo';
  if (/SR|LR|SX|LX|ER|ZR/.test(t))                                                return 'lc';
  return 'lc'; // safest visual default for an unknown fiber SFP
}

// Pull form factor out of speed / partNumber. Bigger modules render a
// noticeably wider silhouette so the user can distinguish SFP from QSFP
// at a glance.
function inferFormFactor(module) {
  const s = `${module?.speed || ''} ${module?.partNumber || ''} ${module?.type || ''}`.toUpperCase();
  if (/400G|QSFP-?DD/.test(s)) return 'qsfp-dd';
  if (/100G|QSFP28/.test(s))   return 'qsfp28';
  if (/40G|QSFP/.test(s))      return 'qsfp+';
  if (/25G|SFP28/.test(s))     return 'sfp28';
  if (/10G|SFP\+|XGS?/.test(s))return 'sfp+';
  return 'sfp';
}

const FORM_HEIGHTS = {
  'sfp':     12,
  'sfp+':    12,
  'sfp28':   12,
  'qsfp+':   18,
  'qsfp28':  18,
  'qsfp-dd': 22,
};

// SfpModuleImage — props:
//   module: the SFP module object (partNumber, brand, type, speed, imageUrl?)
//   size:   'hero' (large, used in TOP PICK card) | 'compact' (small, list rows)
export default function SfpModuleImage({ module, size = 'compact' }) {
  // Track per-mount failure so a single 404 / CORS / decode error on the
  // scraped URL falls back to the silhouette instead of leaving a broken-
  // image icon. Once failed, re-using the same image is no use, so we
  // don't retry within a render lifetime.
  const [imgFailed, setImgFailed] = useState(false);
  if (module?.imageUrl && !imgFailed) {
    // No decorative container — the parent card supplies whatever
    // framing is wanted. Hero size uses `cover` so the product photo
    // visually fills its slot; compact thumb uses `contain` so small
    // images don't get cropped.
    const hero = size === 'hero';
    return (
      <img
        src={module.imageUrl}
        alt={`${module.brand || ''} ${module.partNumber || ''}`.trim()}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setImgFailed(true)}
        style={{
          width:  '100%',
          height: '100%',
          objectFit: hero ? 'cover' : 'contain',
          display: 'block',
        }}
      />
    );
  }

  const ff       = inferFormFactor(module);
  const conn     = inferConnector(module);
  const stripe   = brandColor(module?.brand);
  const bodyH    = FORM_HEIGHTS[ff] || 12;
  // Render-time constants — width fixed at 64 viewBox units; height varies
  // by form factor so QSFP looks visibly chunkier than SFP.
  const W = 64;
  const H = bodyH + 8;
  const wrap = size === 'hero'
    ? { width: '100%', maxWidth: 320, height: 'auto', aspectRatio: '5 / 2' }
    : { width: 56, height: 36 };

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`${module?.brand || ''} ${module?.partNumber || ''} silhouette`}
      style={{
        display: 'block',
        background: 'linear-gradient(135deg, rgba(15,23,42,0.7), rgba(2,8,23,0.7))',
        border: '1px solid rgba(148,163,184,0.18)',
        borderRadius: 10,
        ...wrap,
      }}
    >
      {/* Module body */}
      <rect
        x="6" y={(H - bodyH) / 2}
        width="50" height={bodyH}
        rx="2.5"
        fill="#0f172a"
        stroke="rgba(148,163,184,0.45)"
        strokeWidth="0.6"
      />
      {/* Heat-sink ridges (top) */}
      {[12, 18, 24, 30, 36, 42].map((x) => (
        <line key={x}
          x1={x} y1={(H - bodyH) / 2 + 1.5}
          x2={x} y2={(H - bodyH) / 2 + bodyH - 1.5}
          stroke="rgba(148,163,184,0.18)" strokeWidth="0.4"
        />
      ))}
      {/* Brand colour stripe near the pull-tab */}
      <rect
        x="48" y={(H - bodyH) / 2 + 1.5}
        width="6" height={bodyH - 3}
        rx="1"
        fill={stripe}
        opacity="0.85"
      />
      {/* Pull tab */}
      <rect
        x="54" y={(H - bodyH) / 2 + 3}
        width="6" height={bodyH - 6}
        rx="1"
        fill="rgba(148,163,184,0.55)"
      />
      {/* Front-face connector — drawn on the LEFT (where cable plugs in) */}
      <ConnectorFace
        kind={conn}
        cx={9} cy={H / 2} bodyH={bodyH}
      />
    </svg>
  );
}

// Connector renderer — draws one of: RJ45 / LC duplex / MPO / DAC stub
// on the left edge of the SFP body. Coordinates are tuned for the
// 64-unit-wide viewBox above.
function ConnectorFace({ kind, cx, cy, bodyH }) {
  if (kind === 'rj45') {
    // Trapezoidal RJ45 jack with pin lines
    const top = cy - bodyH / 3;
    const bot = cy + bodyH / 3;
    return (
      <g>
        <path
          d={`M ${cx-3} ${top} L ${cx+3} ${top-1} L ${cx+3} ${bot+1} L ${cx-3} ${bot} Z`}
          fill="#1e293b" stroke="#cbd5e1" strokeWidth="0.4"
        />
        {[-2, -1, 0, 1, 2].map((i) => (
          <line key={i}
            x1={cx + i * 0.9} y1={top + 0.5}
            x2={cx + i * 0.9} y2={bot - 0.5}
            stroke="#fbbf24" strokeWidth="0.25"
          />
        ))}
      </g>
    );
  }
  if (kind === 'mpo') {
    // Wide rectangular MPO with a row of fibre dots
    return (
      <g>
        <rect x={cx - 3} y={cy - bodyH/3} width="6" height={bodyH * 2/3}
          rx="0.6" fill="#1e293b" stroke="#cbd5e1" strokeWidth="0.4" />
        {[-2, -0.5, 1, 2.5].map((dx, i) => (
          <circle key={i} cx={cx + dx * 0.8} cy={cy} r="0.45" fill="#facc15" />
        ))}
      </g>
    );
  }
  if (kind === 'dac') {
    // No front connector — show a stub of attached cable curling away
    return (
      <g>
        <path
          d={`M ${cx} ${cy} q -5 -2 -8 2`}
          fill="none" stroke="#475569" strokeWidth="1.8" strokeLinecap="round"
        />
        <circle cx={cx} cy={cy} r="1" fill="#475569" />
      </g>
    );
  }
  // Default: LC duplex — two side-by-side fibre ports
  return (
    <g>
      <rect x={cx - 3} y={cy - bodyH/3} width="6" height={bodyH * 2/3}
        rx="0.6" fill="#1e293b" stroke="#cbd5e1" strokeWidth="0.4" />
      <circle cx={cx - 1.3} cy={cy} r="0.95" fill="#60a5fa" />
      <circle cx={cx + 1.3} cy={cy} r="0.95" fill="#60a5fa" />
    </g>
  );
}

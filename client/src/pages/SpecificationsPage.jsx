import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import styles from './SpecificationsPage.module.css';
import ThemeToggle from '../components/ThemeToggle.jsx';
import { apiUrl, authFetch } from '../utils/api';

// Try to surface the 4-6 specs a network admin actually scans for first
// (ports, throughput, layer, power, etc.) so the summary card can show a
// useful at-a-glance table instead of dumping 30+ rows immediately.
// Vendor pages use wildly different key wording, so each rule is a list
// of patterns matched case-insensitively against the key.
const HIGHLIGHT_RULES = [
  { label: 'Ports',       patterns: [/\bports?\b/i, /port count/i, /\binterfaces?\b/i] },
  { label: 'Throughput',  patterns: [/switching capacity/i, /throughput/i, /forwarding rate/i, /\bbandwidth\b/i] },
  { label: 'Layer',       patterns: [/\blayer\b/i, /switching layer/i] },
  { label: 'Form factor', patterns: [/form factor/i, /rack units?/i, /\b\dU\b/] },
  { label: 'Power',       patterns: [/power supply|^power\b|\bpsu\b/i, /\bwatts?\b/i, /input voltage/i] },
  { label: 'PoE',         patterns: [/\bpoe\b/i, /power over ethernet/i] },
  { label: 'Uplinks',     patterns: [/uplink/i, /\bsfp\+?\b/i, /\bqsfp\+?\b/i] },
  { label: 'MAC table',   patterns: [/mac (table|address)/i, /mac entries/i] },
  { label: 'Stacking',    patterns: [/stack/i] },
];

function pickHighlights(specs, max = 5) {
  if (!specs) return [];
  const entries = Object.entries(specs).filter(
    ([k, v]) => k && v && typeof v === 'string' && v.length < 200
  );
  const taken = new Set();
  const out = [];
  for (const rule of HIGHLIGHT_RULES) {
    if (out.length >= max) break;
    for (const [k, v] of entries) {
      if (taken.has(k)) continue;
      if (rule.patterns.some(re => re.test(k))) {
        out.push({ label: rule.label, key: k, value: v });
        taken.add(k);
        break;
      }
    }
  }
  return out;
}

export default function SpecificationsPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const deviceClass = location.state?.deviceClass || null;
  const [vendor, setVendor] = useState('');
  const [model, setModel]   = useState('');
  const [vendorList, setVendorList] = useState([]);
  const [vendorListErr, setVendorListErr] = useState(null);
  const [showSuggest, setShowSuggest] = useState(false);

  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);
  const [result, setResult]   = useState(null);
  const [showAll, setShowAll] = useState(false);
  const inputRef = useRef(null);

  const highlights = useMemo(() => pickHighlights(result?.specs), [result]);
  const totalSpecCount = result?.specs ? Object.keys(result.specs).length : 0;

  // Pull the vendor list once so the user gets type-ahead.
  useEffect(() => {
    let cancelled = false;
    authFetch(apiUrl('/api/specs/vendors'))
      .then(r => r.json())
      .then(data => {
        if (cancelled) return;
        if (data.ok) setVendorList(data.vendors || []);
        else setVendorListErr(data.error || 'Could not load vendors');
      })
      .catch(err => { if (!cancelled) setVendorListErr(err.message); });
    return () => { cancelled = true; };
  }, []);

  const suggestions = useMemo(() => {
    const q = vendor.trim().toLowerCase();
    if (!q) return [];
    return vendorList
      .filter(v => v.name.toLowerCase().includes(q))
      .slice(0, 6);
  }, [vendor, vendorList]);

  const onSubmit = async (e) => {
    e.preventDefault();
    if (!vendor.trim() || !model.trim()) {
      setError('Both vendor and model are required.');
      return;
    }
    setError(null);
    setResult(null);
    setShowAll(false);
    setLoading(true);
    try {
      const res = await authFetch(apiUrl('/api/specs'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vendor: vendor.trim(), model: model.trim() }),
      });
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
      if (!data) {
        setError(`Backend returned a non-JSON response (HTTP ${res.status}). Is the server running?`);
        return;
      }
      if (!res.ok || !data.ok) {
        setError(data.error || `HTTP ${res.status}`);
        // Still preserve any partial context (vendor/url) the backend echoed.
        if (data.vendor || data.productUrl) setResult(data);
      } else {
        setResult(data);
      }
    } catch (err) {
      setError(`Request failed: ${err.message}. Is the backend running on port 3001?`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={`page page-full ${styles.specs}`}>
      <div className={styles.amb} />
      <div className={styles.amb2} />

      <header className={styles.header}>
        <button
          className={styles.backBtn}
          onClick={() => navigate(-1)}
          aria-label="Back"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="19" y1="12" x2="5" y2="12"/>
            <polyline points="12 19 5 12 12 5"/>
          </svg>
        </button>
        <h1 className={styles.title}>Specifications</h1>
        <ThemeToggle />
      </header>

      <section className={styles.intro}>
        <p className={styles.eyebrow}>
          Vendor lookup{deviceClass ? ` · ${deviceClass}` : ''}
        </p>
        <h2 className={styles.h2}>
          {deviceClass
            ? `Find datasheet specs for this ${deviceClass.toLowerCase()}.`
            : 'Find datasheet specs for a device.'}
        </h2>
        <p className={styles.sub}>
          Enter the make and model — we'll search the vendor's site and
          pull the spec table.
        </p>
      </section>

      <form className={styles.form} onSubmit={onSubmit} autoComplete="off">
        <label className={styles.field}>
          <span className={styles.label}>Make / Vendor</span>
          <div className={styles.suggestWrap}>
            <input
              ref={inputRef}
              type="text"
              className={styles.input}
              placeholder="e.g. Cisco, Juniper, Aruba"
              value={vendor}
              onChange={e => { setVendor(e.target.value); setShowSuggest(true); }}
              onFocus={() => setShowSuggest(true)}
              onBlur={() => setTimeout(() => setShowSuggest(false), 120)}
            />
            {showSuggest && suggestions.length > 0 && (
              <ul className={styles.suggestList}>
                {suggestions.map(s => (
                  <li
                    key={s.name}
                    className={styles.suggestItem}
                    onMouseDown={() => { setVendor(s.name); setShowSuggest(false); }}
                  >
                    {s.name}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {vendorListErr && (
            <span className={styles.fieldHint}>Vendor list unavailable: {vendorListErr}</span>
          )}
        </label>

        <label className={styles.field}>
          <span className={styles.label}>Model</span>
          <input
            type="text"
            className={styles.input}
            placeholder="e.g. C9300-48P, EX4400-24T"
            value={model}
            onChange={e => setModel(e.target.value)}
          />
        </label>

        <button
          type="submit"
          className={`btn btn-primary btn-lg btn-full ${styles.cta}`}
          disabled={loading}
        >
          {loading ? 'Searching…' : 'Get specifications'}
        </button>
      </form>

      {error && <div className={styles.errBanner}>{error}</div>}

      {result && result.ok && (
        <>
          {/* Plain-English summary card with highlight specs. */}
          <section className={styles.summaryCard}>
            <div className={styles.summaryHead}>
              <div>
                <p className={styles.resultVendor}>{result.vendor}</p>
                <p className={styles.resultModel}>{result.model}</p>
              </div>
            </div>

            <p className={styles.summaryBody}>
              {totalSpecCount > 0
                ? `We pulled ${totalSpecCount} ${totalSpecCount === 1 ? 'spec' : 'specs'} from the vendor's product page${highlights.length > 0 ? ' — here are the most useful ones at a glance' : ''}.`
                : "We found the product page but couldn't extract a spec table."}
            </p>

            {highlights.length > 0 && (
              <div className={styles.highlights}>
                {highlights.map(h => (
                  <div key={h.key} className={styles.highlightRow}>
                    <span className={styles.highlightLabel}>{h.label}</span>
                    <span className={styles.highlightVal}>{h.value}</span>
                  </div>
                ))}
              </div>
            )}

            <div className={styles.summaryActions}>
              {result.productUrl && (
                <a
                  className={`btn btn-secondary ${styles.summaryBtn}`}
                  href={result.productUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  Open product page ↗
                </a>
              )}
              {totalSpecCount > 0 && (
                <button
                  type="button"
                  className={`btn btn-ghost ${styles.summaryBtn}`}
                  onClick={() => setShowAll(s => !s)}
                  aria-expanded={showAll}
                >
                  {showAll ? 'Hide all specs' : `Show all specs (${totalSpecCount})`}
                </button>
              )}
            </div>
          </section>

          {showAll && (
            <section className={styles.result}>
              <div className={styles.specTable}>
                {Object.entries(result.specs || {}).map(([k, v]) => (
                  <div key={k} className={styles.specRow}>
                    <span className={styles.specKey}>{k}</span>
                    <span className={styles.specVal}>{v}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {result && !result.ok && result.productUrl && (
        <section className={styles.result}>
          <p className={styles.fieldHint}>
            Found a candidate page but couldn't extract specs:
            {' '}
            <a href={result.productUrl} target="_blank" rel="noreferrer noopener">
              {result.productUrl}
            </a>
          </p>
        </section>
      )}
    </div>
  );
}

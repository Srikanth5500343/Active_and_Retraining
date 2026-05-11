import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import styles from './FirmwarePage.module.css';
import ThemeToggle from '../components/ThemeToggle.jsx';
import { apiUrl, authFetch } from '../utils/api';

const SEVERITY_ORDER = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, NONE: 4 };

// Plain-English headline + body for the summary card. Keeps the
// "what should I do" answer above the fold; raw CVE/changelog detail
// is hidden behind the "Show details" toggle.
function buildSummary(result, sortedCves) {
  if (!result || !result.ok) return null;
  const cur = result.currentVersion;
  const latest = result.latestVersion;
  const counts = sortedCves.reduce((acc, c) => {
    const sev = (c.severity || 'NONE').toUpperCase();
    acc[sev] = (acc[sev] || 0) + 1;
    return acc;
  }, {});
  const critical = counts.CRITICAL || 0;
  const high = counts.HIGH || 0;
  const totalCves = sortedCves.length;
  const matches = sortedCves.filter(c => c.matchesCurrentVersion).length;

  let tone = 'neutral';
  let headline = '';
  let body = '';

  if (result.upToDate === true) {
    tone = totalCves > 0 ? 'warn' : 'ok';
    headline = "You're up to date.";
    body = totalCves === 0
      ? `No known security issues found for ${result.vendor} ${result.model}.`
      : `You're on the latest version (${cur}), but we found ${totalCves} known security ${totalCves === 1 ? 'issue' : 'issues'} for this product.`;
  } else if (result.upToDate === false) {
    tone = critical > 0 || high > 0 ? 'critical' : 'warn';
    headline = critical > 0
      ? "Upgrade strongly recommended."
      : "An upgrade is available.";
    const verPart = `Latest is ${latest}, you're on ${cur}.`;
    const cvePart = totalCves === 0
      ? "No known security issues were reported for this product."
      : `${totalCves} known security ${totalCves === 1 ? 'issue' : 'issues'} were reported${
          (critical + high) > 0
            ? ` (${critical} critical, ${high} high)`
            : ''
        }${matches > 0 ? `, and ${matches} mentions your version directly` : ''}.`;
    body = `${verPart} ${cvePart}`;
  } else {
    tone = totalCves > 0 ? 'warn' : 'neutral';
    headline = "We couldn't confirm the latest version.";
    const verPart = latest
      ? `The newest version we saw was ${latest}, but we couldn't compare it to ${cur}.`
      : `The vendor's site didn't show a clear latest version.`;
    const cvePart = totalCves === 0
      ? ' No known security issues were reported.'
      : ` We did find ${totalCves} reported security ${totalCves === 1 ? 'issue' : 'issues'} for this product.`;
    body = verPart + cvePart;
  }
  return { tone, headline, body, totalCves, critical, high };
}

export default function FirmwarePage() {
  const navigate = useNavigate();
  const location = useLocation();
  const deviceClass = location.state?.deviceClass || null;

  const [vendor, setVendor] = useState('');
  const [model, setModel]   = useState('');
  const [currentVersion, setCurrentVersion] = useState('');

  const [vendorList, setVendorList] = useState([]);
  const [vendorListErr, setVendorListErr] = useState(null);
  const [showSuggest, setShowSuggest] = useState(false);

  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);
  const [result, setResult]   = useState(null);
  const [showDetails, setShowDetails] = useState(false);

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

  const sortedCves = useMemo(() => {
    const cves = result?.cves || [];
    return [...cves].sort((a, b) => {
      const sa = SEVERITY_ORDER[(a.severity || 'NONE').toUpperCase()] ?? 5;
      const sb = SEVERITY_ORDER[(b.severity || 'NONE').toUpperCase()] ?? 5;
      if (sa !== sb) return sa - sb;
      return (b.score || 0) - (a.score || 0);
    });
  }, [result]);

  const summary = useMemo(() => buildSummary(result, sortedCves), [result, sortedCves]);

  const onSubmit = async (e) => {
    e.preventDefault();
    if (!vendor.trim() || !model.trim() || !currentVersion.trim()) {
      setError('Vendor, model, and current version are all required.');
      return;
    }
    setError(null);
    setResult(null);
    setShowDetails(false);
    setLoading(true);
    try {
      const res = await authFetch(apiUrl('/api/firmware'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vendor: vendor.trim(),
          model: model.trim(),
          currentVersion: currentVersion.trim(),
        }),
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
        if (data.vendor || data.releaseNotesUrl) setResult(data);
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
    <div className={`page page-full ${styles.fw}`}>
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
            <polyline points="12 19 5 12 12 19"/>
          </svg>
        </button>
        <h1 className={styles.title}>Firmware Check</h1>
        <ThemeToggle />
      </header>

      <section className={styles.intro}>
        <p className={styles.eyebrow}>
          Version & known issues{deviceClass ? ` · ${deviceClass}` : ''}
        </p>
        <h2 className={styles.h2}>
          Check what's broken in your version — and what's new in the next.
        </h2>
        <p className={styles.sub}>
          We scrape the vendor's release notes and look up CVEs from the
          NIST National Vulnerability Database.
        </p>
      </section>

      <form className={styles.form} onSubmit={onSubmit} autoComplete="off">
        <label className={styles.field}>
          <span className={styles.label}>Make / Vendor</span>
          <div className={styles.suggestWrap}>
            <input
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
            placeholder="e.g. C9300-48P"
            value={model}
            onChange={e => setModel(e.target.value)}
          />
        </label>

        <label className={styles.field}>
          <span className={styles.label}>Current version</span>
          <input
            type="text"
            className={styles.input}
            placeholder="e.g. 16.12.1, 22.4R3"
            value={currentVersion}
            onChange={e => setCurrentVersion(e.target.value)}
          />
        </label>

        <button
          type="submit"
          className={`btn btn-primary btn-lg btn-full ${styles.cta}`}
          disabled={loading}
        >
          {loading ? 'Checking…' : 'Check firmware'}
        </button>
      </form>

      {error && <div className={styles.errBanner}>{error}</div>}

      {result && result.ok && summary && (
        <>
          {/* Plain-English summary — keep this short and readable. */}
          <section className={`${styles.summaryCard} ${styles[`tone_${summary.tone}`] || ''}`}>
            <h3 className={styles.summaryHeadline}>{summary.headline}</h3>
            <p className={styles.summaryBody}>{summary.body}</p>

            <div className={styles.summaryActions}>
              {result.releaseNotesUrl && (
                <a
                  className={`btn btn-secondary ${styles.summaryBtn}`}
                  href={result.releaseNotesUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  Open release notes ↗
                </a>
              )}
              <button
                type="button"
                className={`btn btn-ghost ${styles.summaryBtn}`}
                onClick={() => setShowDetails(s => !s)}
                aria-expanded={showDetails}
              >
                {showDetails ? 'Hide details' : 'Show details'}
              </button>
            </div>
          </section>

          {showDetails && (
            <>
              {/* Version status card */}
              <section className={styles.versionCard}>
                <div className={styles.versionRow}>
                  <div className={styles.versionCol}>
                    <span className={styles.versionLabel}>Current</span>
                    <span className={styles.versionVal}>{result.currentVersion}</span>
                  </div>
                  <div className={styles.versionArrow}>→</div>
                  <div className={styles.versionCol}>
                    <span className={styles.versionLabel}>Latest detected</span>
                    <span className={styles.versionVal}>
                      {result.latestVersion || <em className={styles.muted}>not detected</em>}
                    </span>
                  </div>
                </div>
                <div className={styles.versionStatus}>
                  {result.upToDate === true && (
                    <span className={`${styles.statusPill} ${styles.statusOk}`}>
                      Up to date
                    </span>
                  )}
                  {result.upToDate === false && (
                    <span className={`${styles.statusPill} ${styles.statusWarn}`}>
                      Upgrade available
                    </span>
                  )}
                  {result.upToDate === null && (
                    <span className={`${styles.statusPill} ${styles.statusUnknown}`}>
                      Couldn't compare versions
                    </span>
                  )}
                  {result.releaseNotesUrl && (
                    <a
                      className={styles.sourceLink}
                      href={result.releaseNotesUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      source ↗
                    </a>
                  )}
                </div>

                {/* When we couldn't detect a latest version, give the user
                    direct search links so they have a one-click path to
                    find the current firmware on the vendor's site / NVD /
                    Google instead of a dead-end "unknown". */}
                {!result.latestVersion && (() => {
                  const v = result.vendor || vendor;
                  const m = result.model || model;
                  const q = encodeURIComponent(
                    `${v} ${m} latest firmware release notes`
                  );
                  const links = [
                    result.vendorUrl && {
                      label: 'Vendor support',
                      url: `https://www.google.com/search?q=site:${encodeURIComponent(
                        new URL(result.vendorUrl).hostname.replace(/^www\./, '')
                      )}+${encodeURIComponent(`${m} release notes`)}`,
                    },
                    {
                      label: 'NVD CVEs',
                      url: `https://nvd.nist.gov/vuln/search/results?form_type=Basic&query=${encodeURIComponent(`${v} ${m}`)}`,
                    },
                    {
                      label: 'Google search',
                      url: `https://www.google.com/search?q=${q}`,
                    },
                  ].filter(Boolean);
                  return (
                    <div className={styles.versionFallback}>
                      <span className={styles.versionFallbackLabel}>
                        Find latest firmware:
                      </span>
                      <div className={styles.versionFallbackLinks}>
                        {links.map(l => (
                          <a
                            key={l.label}
                            href={l.url}
                            target="_blank"
                            rel="noreferrer noopener"
                            className={styles.versionFallbackLink}
                          >
                            {l.label} ↗
                          </a>
                        ))}
                      </div>
                    </div>
                  );
                })()}
              </section>

              {/* CVEs */}
              <section className={styles.section}>
                <div className={styles.sectionHead}>
                  <h3 className={styles.sectionTitle}>
                    Known vulnerabilities
                    <span className={styles.count}>{sortedCves.length}</span>
                  </h3>
                  <span className={styles.sectionSub}>
                    from NIST NVD · keywords <code>{result.cvesKeywords || '—'}</code>
                  </span>
                </div>
                {sortedCves.length === 0 ? (
                  <p className={styles.empty}>
                    No CVEs returned for this product/version. NVD's keyword search
                    may not cover every model — check the vendor's security advisories
                    directly for the most accurate picture.
                  </p>
                ) : (
                  <ul className={styles.cveList}>
                    {sortedCves.map(c => (
                      <li key={c.id} className={styles.cveItem}>
                        <div className={styles.cveHead}>
                          <a
                            className={styles.cveId}
                            href={c.url}
                            target="_blank"
                            rel="noreferrer noopener"
                          >
                            {c.id}
                          </a>
                          <span className={`${styles.sevPill} ${styles[`sev${(c.severity || 'NONE').toUpperCase()}`] || ''}`}>
                            {c.severity || 'unrated'}
                            {c.score != null ? ` · ${c.score}` : ''}
                          </span>
                          {c.matchesCurrentVersion && (
                            <span className={styles.matchPill}>mentions your version</span>
                          )}
                        </div>
                        <p className={styles.cveDesc}>{c.description}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {/* Changelog snippets */}
              <section className={styles.section}>
                <div className={styles.sectionHead}>
                  <h3 className={styles.sectionTitle}>
                    Release notes excerpts
                    <span className={styles.count}>{result.changelog?.length || 0}</span>
                  </h3>
                  <span className={styles.sectionSub}>
                    scraped from the vendor's release-notes page
                  </span>
                </div>
                {(!result.changelog || result.changelog.length === 0) ? (
                  <div className={styles.empty}>
                    <p style={{ margin: 0 }}>
                      {result.releaseNotesError
                        ? `Couldn't fetch release notes: ${result.releaseNotesError}`
                        : "Couldn't extract any changelog sections from the page."}
                    </p>
                    {(() => {
                      const v = result.vendor || vendor;
                      const m = result.model || model;
                      const q = encodeURIComponent(
                        `${v} ${m} release notes changelog`
                      );
                      return (
                        <div className={styles.versionFallbackLinks} style={{ marginTop: 8 }}>
                          <a
                            href={`https://www.google.com/search?q=${q}`}
                            target="_blank"
                            rel="noreferrer noopener"
                            className={styles.versionFallbackLink}
                          >
                            Search release notes ↗
                          </a>
                          {result.releaseNotesUrl && (
                            <a
                              href={result.releaseNotesUrl}
                              target="_blank"
                              rel="noreferrer noopener"
                              className={styles.versionFallbackLink}
                            >
                              Open page ↗
                            </a>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                ) : (
                  <div className={styles.changelogList}>
                    {result.changelog.map((entry, i) => (
                      <article key={i} className={styles.changelogItem}>
                        <header className={styles.changelogHead}>
                          <span className={styles.changelogSection}>{entry.section}</span>
                          {entry.version && (
                            <span className={styles.changelogVer}>{entry.version}</span>
                          )}
                        </header>
                        <p className={styles.changelogText}>{entry.text}</p>
                      </article>
                    ))}
                  </div>
                )}
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}

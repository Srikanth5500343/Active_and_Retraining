import { useEffect, useState } from 'react';
import { apiUrl, authFetch } from '../utils/api';
import styles from './CmdbTicketBanner.module.css';

/**
 * Renders the CMDB-sync state for a rack:
 *   - applied   → green "synced to CMDB" banner
 *   - open      → blue/violet "pending approval" banner with link
 *   - rejected  → grey "request rejected" + retry button
 *   - cancelled → grey "request cancelled" + retry button
 *   - apply_error → red "apply failed" + retry button
 *   - none      → invisible (no banner needed)
 *
 * Polls /api/cmdb/ticket/:rackId once on mount; re-fetches on refresh
 * action. Self-contained — drop into any rack page.
 */
export default function CmdbTicketBanner({ rackId }) {
  const [t, setT] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const refetch = async () => {
    if (!rackId) return;
    try {
      const r = await authFetch(apiUrl(`/api/cmdb/ticket/${rackId}`));
      const data = await r.json();
      setT(data?.ticket || null);
    } catch (e) {
      setErr(e.message);
    }
  };

  useEffect(() => { refetch(); /* eslint-disable-line */ }, [rackId]);

  const refresh = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await authFetch(apiUrl(`/api/cmdb/ticket/${rackId}/refresh`),
        { method: 'POST' });
      const data = await r.json();
      setT(data?.ticket || null);
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const create = async ({ force = false } = {}) => {
    setBusy(true); setErr(null);
    try {
      const url = `/api/cmdb/ticket/${rackId}/create${force ? '?force=1' : ''}`;
      const r = await authFetch(apiUrl(url), { method: 'POST' });
      const data = await r.json();
      if (!data?.ok) {
        setErr(data?.error || 'create failed');
      } else {
        setT(data?.ticket || null);
      }
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const cancel = async () => {
    if (!confirm('Drop the local CMDB sync state for this rack?\n(The ServiceNow ticket itself stays — close it manually if needed.)')) return;
    setBusy(true); setErr(null);
    try {
      const r = await authFetch(apiUrl(`/api/cmdb/ticket/${rackId}/cancel`),
        { method: 'POST' });
      const data = await r.json();
      if (data?.ok) setT(null);
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  if (!rackId || !t) return null;

  const state = t.state || 'open';
  const summary = t.summary || {};
  const cls = `${styles.banner} ${styles[`b_${state}`]}`;

  return (
    <div className={cls}>
      <div className={styles.dot} />
      <div className={styles.body}>
        <div className={styles.line1}>
          <span className={styles.title}>{titleFor(state, t)}</span>
          {t.number && (
            <a className={styles.numLink}
               href={t.ticket_url} target="_blank" rel="noreferrer">{t.number}</a>
          )}
        </div>
        <div className={styles.line2}>
          {summaryLine(state, t, summary)}
        </div>
        {t.apply_error && state === 'open' && (
          <div className={styles.errorLine}>apply error: {trimErr(t.apply_error)}</div>
        )}
        {err && <div className={styles.errorLine}>{err}</div>}
      </div>

      <div className={styles.actions}>
        {state === 'open' && (
          <button className={styles.btn} onClick={refresh} disabled={busy}
                  title="Re-poll ticket state from ServiceNow">
            {busy ? '…' : 'Refresh'}
          </button>
        )}
        {(state === 'rejected' || state === 'cancelled' || state === 'applied') && (
          <button className={styles.btn} onClick={() => create({ force: true })}
                  disabled={busy}
                  title="Open a new sync request based on the current scan">
            {busy ? '…' : 'New request'}
          </button>
        )}
        {state === 'open' && (
          <button className={styles.btnGhost} onClick={cancel} disabled={busy}
                  title="Drop the local state file">
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}


function titleFor(state, t) {
  if (state === 'applied')   return 'CMDB synced';
  if (state === 'rejected')  return 'CMDB sync rejected';
  if (state === 'cancelled') return 'CMDB sync cancelled';
  if (state === 'open' && t.apply_error) return 'CMDB sync — apply failed';
  return 'CMDB sync pending approval';
}


function summaryLine(state, t, s) {
  const parts = [];
  if (s?.added_devices)   parts.push(`+${s.added_devices} devices`);
  if (s?.removed_devices) parts.push(`-${s.removed_devices} devices`);
  if (s?.changed_devices) parts.push(`~${s.changed_devices} changed`);
  if (s?.added_ports)     parts.push(`+${s.added_ports} ports`);
  const summary = parts.length ? parts.join(' · ') : 'no changes';

  if (state === 'open' && t.opened_at) {
    return `${summary} · opened ${ago(t.opened_at)}`;
  }
  if (state === 'applied' && t.applied_at) {
    return `${summary} · applied ${ago(t.applied_at)}`;
  }
  if (state === 'rejected' || state === 'cancelled') {
    return `${summary} · was opened ${ago(t.opened_at)}`;
  }
  return summary;
}


function ago(iso) {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (!t) return '—';
  const sec = Math.max(1, Math.floor((Date.now() - t) / 1000));
  if (sec < 90)            return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 90)            return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 36)             return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}


function trimErr(s) {
  if (!s) return '';
  return String(s).split('\n')[0].slice(0, 220);
}

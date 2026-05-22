import { useEffect, useState } from 'react';
import { apiUrl, authFetch } from '../utils/api';
import styles from './CmdbApprovalModal.module.css';

/**
 * CMDB approval flow modal — three sequential states:
 *   1. "missing"   → Device(s) not in CMDB. CTA: Raise Service Request.
 *   2. "pending"   → SR raised, awaiting approval. CTA: Dev Approve & Apply.
 *   3. "applied"   → Pushed scan + dummy data. Shows what was applied.
 *
 * Triggered from ResultsPage when the rack's CMDB ticket is in `open`
 * state with added_devices > 0, OR when no ticket exists yet (will
 * create one). Dismissable; dismissal is remembered per-session per-rack.
 */
export default function CmdbApprovalModal({ rackId, ticket, onClose, onTicketUpdate }) {
  // step: 'missing' (no ticket yet) | 'pending' (ticket open) | 'applying' | 'applied' | 'error'
  const initialStep = ticket
    ? (ticket.state === 'applied' ? 'applied' : 'pending')
    : 'missing';
  const [step, setStep]       = useState(initialStep);
  const [busy, setBusy]       = useState(false);
  const [error, setError]     = useState(null);
  const [details, setDetails] = useState(null);

  // Sync step with ticket state if parent updates it.
  useEffect(() => {
    if (!ticket) { setStep('missing'); return; }
    if (ticket.state === 'applied') setStep('applied');
    else if (ticket.state === 'open') setStep((s) => s === 'applying' ? s : 'pending');
  }, [ticket]);

  const raiseSR = async () => {
    setBusy(true); setError(null);
    try {
      const r = await authFetch(apiUrl(`/api/cmdb/ticket/${rackId}/create`),
        { method: 'POST' });
      const data = await r.json();
      if (!data?.ok) {
        setError(friendlyError(data?.error) || 'Could not raise the request right now.');
        setBusy(false);
        return;
      }
      onTicketUpdate?.(data?.ticket);
      setStep('pending');
    } catch (e) {
      setError('Network error — please try again.');
    } finally {
      setBusy(false);
    }
  };

  const devApprove = async () => {
    setBusy(true); setError(null); setStep('applying');
    const startedAt = Date.now();
    try {
      const r = await authFetch(apiUrl(`/api/cmdb/ticket/${rackId}/dev-approve`),
        { method: 'POST' });
      const data = await r.json();
      // Hold the "synchronizing" view for at least 1.2s so the transition
      // doesn't feel jarring — server-side this is now near-instant.
      const elapsed = Date.now() - startedAt;
      if (elapsed < 1200) await new Promise((res) => setTimeout(res, 1200 - elapsed));
      if (!data?.ok) {
        setError(friendlyError(data?.error) || 'Could not complete the registration. Please try again.');
        setStep('pending');
        setBusy(false);
        return;
      }
      onTicketUpdate?.(data?.ticket);
      setDetails(data?.details || null);
      setStep('applied');
    } catch (e) {
      setError('Network error — please try again.');
      setStep('pending');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <button className={styles.close} onClick={onClose} aria-label="Close">×</button>

        {step === 'missing' && (
          <>
            <div className={styles.iconBubble} aria-hidden="true">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
            </div>
            <h3 className={styles.title}>Rack not registered in CMDB</h3>
            <p className={styles.body}>
              The configuration database has no record for this rack.
              Submit a request to register the discovered inventory.
            </p>
            {error && <div className={styles.error}>{error}</div>}
            <div className={styles.actions}>
              <button className={styles.btnGhost} onClick={onClose} disabled={busy}>Not now</button>
              <button className={styles.btnPrimary} onClick={raiseSR} disabled={busy}>
                {busy ? 'Submitting…' : 'Raise Ticket'}
              </button>
            </div>
          </>
        )}

        {step === 'pending' && (
          <>
            <div className={`${styles.iconBubble} ${styles.iconBubbleAccent}`} aria-hidden="true">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
            </div>
            <h3 className={styles.title}>Ticket submitted</h3>
            <div className={styles.reqCard}>
              <span className={styles.reqLabel}>Reference</span>
              <span className={styles.reqNum}>{ticket?.number || '—'}</span>
            </div>
            <p className={styles.body}>
              Submitted for approval. Approve below to register the
              discovered inventory in the configuration database now.
            </p>
            {error && <div className={styles.error}>{error}</div>}
            <div className={styles.actions}>
              <button className={styles.btnGhost} onClick={onClose} disabled={busy}>Close</button>
              <button className={styles.btnPrimary} onClick={devApprove} disabled={busy}>
                {busy ? 'Approving…' : 'Approve'}
              </button>
            </div>
          </>
        )}

        {step === 'applying' && (
          <>
            <div className={`${styles.iconBubble} ${styles.iconBubbleAccent}`} aria-hidden="true">
              <span className={styles.spinner} />
            </div>
            <h3 className={styles.title}>Synchronizing…</h3>
            <p className={styles.body}>Registering the rack inventory in the configuration database.</p>
          </>
        )}

        {step === 'applied' && (
          <>
            <div className={`${styles.iconBubble} ${styles.iconBubbleSuccess}`} aria-hidden="true">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <h3 className={styles.title}>Successfully registered</h3>
            <p className={styles.body}>
              The rack inventory is now available in the configuration database.
            </p>
            {details ? <ApplyDetails details={details} /> : null}
            <div className={styles.actions}>
              <button className={styles.btnPrimary} onClick={onClose}>Done</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ApplyDetails({ details }) {
  const stats = [
    { label: 'Devices', value: details.counters?.devices ?? details.device_count ?? 0 },
    { label: 'Ports',   value: details.counters?.ports   ?? details.port_count   ?? 0 },
    { label: 'Cables',  value: details.counters?.cables  ?? details.cable_count  ?? 0 },
    { label: 'Rack U',  value: details.u_size ?? '—' },
  ];

  return (
    <div className={styles.detailsBlock}>
      <div className={styles.statsRow}>
        {stats.map((s) => (
          <div key={s.label} className={styles.stat}>
            <div className={styles.statValue}>{s.value}</div>
            <div className={styles.statLabel}>{s.label}</div>
          </div>
        ))}
      </div>

      {details.devices?.length > 0 && (
        <>
          <div className={styles.detailsHeader}>
            Registered devices ({details.devices.length})
          </div>
          <div className={styles.deviceList}>
            {details.devices.map((d, i) => (
              <div key={i} className={styles.deviceRow}>
                <div className={styles.deviceTopLine}>
                  <span className={styles.deviceName}>{d.name}</span>
                  {d.u_position != null && (
                    <span className={styles.uTag}>U{d.u_position}</span>
                  )}
                </div>
                <div className={styles.deviceMeta}>
                  {d.kind && <span className={styles.tag}>{d.kind}</span>}
                  {d.model      && <span className={styles.metaText}>{d.model}</span>}
                  {d.mgmt_ip    && <span className={styles.metaTextMono}>{d.mgmt_ip}</span>}
                  {d.mac        && <span className={styles.metaTextMono}>{d.mac}</span>}
                  {d.asset_tag  && <span className={styles.metaTextMono}>{d.asset_tag}</span>}
                  {d.serial     && <span className={styles.metaTextMono}>{d.serial}</span>}
                  {d.port_count > 0 && (
                    <span className={styles.metaText}>{d.port_count} ports</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {details.cables?.length > 0 && (
        <>
          <div className={styles.detailsHeader}>
            Connections (sample of {details.cable_count})
          </div>
          <div className={styles.cableList}>
            {details.cables.map((c, i) => (
              <div key={i} className={styles.cableRow}>
                <span className={styles.cableEnd}>
                  {c.from}{c.from_p ? `:${c.from_p}` : ''}
                </span>
                <span className={styles.cableArrow}>→</span>
                <span className={styles.cableEnd}>
                  {c.to}{c.to_p ? `:${c.to_p}` : ''}
                </span>
                {c.type && <span className={styles.tagSm}>{c.type}</span>}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function friendlyError(s) {
  if (!s) return null;
  const txt = String(s);
  // Strip developer-y bits
  if (/timeout|timed out/i.test(txt))    return 'Request to ServiceNow timed out — try again.';
  if (/spawn|enoent|cmdb_apply/i.test(txt)) return 'CMDB apply step failed — please try again.';
  if (/sn_request|sc_request|404|not found/i.test(txt)) return 'Could not reach ServiceNow — check the connection.';
  // Fall through with a soft message
  return 'Something went wrong — please try again.';
}

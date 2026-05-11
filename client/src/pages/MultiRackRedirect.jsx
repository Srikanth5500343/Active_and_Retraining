import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { apiUrl, authFetch } from '../utils/api';

/**
 * Backwards-compat shim. The old multi-rack flow had its own landing
 * page at /multi-rack/:groupId; the new design drops that page and
 * sends users straight into the first member rack's existing Ports
 * page (where the rack-tabs strip handles switching between the rest
 * of the group). Anyone who bookmarked or deep-linked the old URL
 * lands here and is forwarded.
 */
export default function MultiRackRedirect() {
  const { groupId } = useParams();
  const navigate = useNavigate();
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await authFetch(apiUrl(`/api/rack-group/${encodeURIComponent(groupId)}`));
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || 'Group not found');
        const first = (j.members || []).find(m => m.rack_id);
        if (!alive) return;
        if (first) {
          navigate(`/results/${encodeURIComponent(first.rack_id)}`, { replace: true });
        } else {
          // Group exists but has no members — fall back to the combined
          // topology, which will surface the empty-state.
          navigate(`/multi-rack/${encodeURIComponent(groupId)}/topology`, { replace: true });
        }
      } catch (e) {
        if (alive) setError(e.message);
      }
    })();
    return () => { alive = false; };
  }, [groupId, navigate]);

  return (
    <div style={{
      minHeight: '60vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: 'rgba(220,230,250,0.6)',
      fontSize: 13,
    }}>
      {error ? `Couldn’t open scan: ${error}` : 'Opening scan…'}
    </div>
  );
}

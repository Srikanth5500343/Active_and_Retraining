import { useEffect, useState } from 'react';
import { apiUrl, authFetch } from '../utils/api';

// Cache responses per rackId for the lifetime of the page so navigating
// between Ports / Topology / Results doesn't re-fetch the same group.
const _cache = new Map(); // rackId → { group, members } | null

/**
 * useRackGroup(rackId)
 *
 * Returns { group, members, loading, error } describing the multi-rack
 * scan this rackId belongs to (if any). When the rack is standalone,
 * `group` is null — callers should treat that as "no rack tabs".
 */
export function useRackGroup(rackId) {
  const cached = rackId ? _cache.get(rackId) : undefined;
  const [data, setData] = useState(cached === undefined ? null : cached);
  const [loading, setLoading] = useState(cached === undefined);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!rackId) { setData(null); setLoading(false); return; }
    if (_cache.has(rackId)) {
      setData(_cache.get(rackId));
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const r = await authFetch(apiUrl(`/api/rack/${encodeURIComponent(rackId)}/group`));
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        const payload = j.group ? { group: j.group, members: j.members || [] } : null;
        _cache.set(rackId, payload);
        if (alive) setData(payload);
      } catch (e) {
        if (alive) setError(e.message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [rackId]);

  return { data, loading, error };
}

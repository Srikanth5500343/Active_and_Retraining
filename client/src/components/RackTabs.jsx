import { useNavigate, useLocation } from 'react-router-dom';
import styles from './RackTabs.module.css';
import { useRackGroup } from './useRackGroup';

/**
 * RackTabs — when the current rack belongs to a multi-rack scan group,
 * renders a horizontal scan-group navigation showing every member rack
 * and a quick jump to the Combined 3D view. Renders nothing for
 * standalone scans.
 *
 * Visual layout (left → right):
 *   ┌──────────┬─────────────────────────────────────┬──────────────┐
 *   │ N RACKS  │  ① Rack 1   ▶ ② Rack 2   ③ Rack 3  │  ⊞  3D ↗    │
 *   └──────────┴─────────────────────────────────────┴──────────────┘
 * The "▶" marker before the active rack is a colored bar; the position
 * "①" is a circular badge instead of a "#1" tag.
 */
export default function RackTabs({ rackId }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { data, loading } = useRackGroup(rackId);

  // Only render when there's actually a multi-rack group worth navigating
  // between. A single-rack "group" (e.g., the splitter only found 1 rack
  // in a video) would render a meaningless tab strip with one item, so
  // hide the whole bar when count <= 1.
  if (loading || !data || !data.members || data.members.length < 2) return null;

  const members = data.members;
  // Preserve the sub-page suffix when switching racks.
  //   /results/:rackId             → no suffix (overview)
  //   /results/:rackId/ports       → /ports
  //   /results/:rackId/topology    → /topology
  const segments = location.pathname.split('/').filter(Boolean);
  const rest = segments.slice(2).join('/');
  const suffix = rest ? `/${rest}` : '';

  return (
    <nav className={styles.bar} aria-label="Racks in this scan">
      <div className={styles.countBadge}>
        <span className={styles.countNum}>{members.length}</span>
        <span className={styles.countWord}>
          {members.length === 1 ? 'rack' : 'racks'}
        </span>
      </div>

      <ol className={styles.rail}>
        {members.map((m) => {
          const isCurrent = m.rack_id === rackId;
          return (
            <li key={m.rack_id} className={styles.railItem}>
              <button
                role="tab"
                aria-selected={isCurrent}
                className={`${styles.rack} ${isCurrent ? styles.rackActive : ''}`}
                disabled={isCurrent}
                onClick={() =>
                  navigate(`/results/${encodeURIComponent(m.rack_id)}${suffix}`)}
                title={m.rack_id}
              >
                <span className={styles.rackBadge} aria-hidden="true">
                  {m.position}
                </span>
                <span className={styles.rackName}>{m.label}</span>
                {isCurrent && <span className={styles.activeDot} aria-hidden="true" />}
              </button>
            </li>
          );
        })}
      </ol>

      {data.group && (
        <button
          className={styles.combined}
          onClick={() => navigate(`/multi-rack/${encodeURIComponent(data.group.id)}/topology`)}
          title="Open all racks in one 3D scene"
        >
          <svg
            className={styles.combinedIcon}
            width="14" height="14" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" strokeWidth="2.2"
            strokeLinecap="round" strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="3" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" />
            <rect x="14" y="14" width="7" height="7" rx="1" />
          </svg>
          <span>Combined&nbsp;3D</span>
          <svg
            width="11" height="11" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" strokeWidth="2.4"
            strokeLinecap="round" strokeLinejoin="round"
            aria-hidden="true"
          >
            <line x1="7" y1="17" x2="17" y2="7" />
            <polyline points="7 7 17 7 17 17" />
          </svg>
        </button>
      )}
    </nav>
  );
}

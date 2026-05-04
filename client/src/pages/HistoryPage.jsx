import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import styles from './HistoryPage.module.css';

export default function HistoryPage() {
  const navigate = useNavigate();
  const [history, setHistory] = useState([]);

  useEffect(() => {
    const stored = JSON.parse(localStorage.getItem('rackTrackHistory') || '[]');
    setHistory(Array.isArray(stored) ? stored : []);
  }, []);

  const clearHistory = () => {
    localStorage.removeItem('rackTrackHistory');
    setHistory([]);
  };

  return (
    <div className={`page page-full ${styles.history}`}>
      <div className={styles.amb} />

      <header className={styles.header}>
        <button className="btn btn-ghost btn-icon" onClick={() => navigate('/') }>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
          </svg>
        </button>
        <h2 className={styles.title}>Scan history</h2>
        <button className="btn btn-ghost btn-sm" onClick={clearHistory} disabled={history.length === 0}>
          Clear
        </button>
      </header>

      <div className={styles.body}>
        {history.length === 0 ? (
          <div className={styles.empty}>
            <p>No past scans yet.</p>
            <button className="btn btn-primary btn-full" onClick={() => navigate('/scan')}>Start first scan</button>
          </div>
        ) : (
          <div className={styles.list}>
            {history.map((item) => (
              <article
                key={item.scanId}
                className={styles.card}
                onClick={() => item.fullResult ? navigate('/results', { state: { result: item.fullResult } }) : null}
              >
                <div className={styles.cardTop}>
                  <div>
                    <p className={styles.cardTitle}>{item.incidentLabel || 'Rack incident'}</p>
                    <p className={styles.cardMeta}>{new Date(item.timestamp).toLocaleString()}</p>
                  </div>
                  <span className={`badge ${item.severity === 'critical' ? 'badge-red' : 'badge-cyan'}`}>{item.severity}</span>
                </div>
                <div className={styles.cardInfo}>
                  <span className={styles.cardChip}>{item.componentLabel || 'Unknown device'}</span>
                  <span className={styles.cardChip}>{item.scanSummary || 'Incident detected'}</span>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

import { useState, useRef } from 'react';
import { apiUrl, authFetch } from '../utils/api';
import styles from './RearImagePrompt.module.css';

/**
 * Modal that prompts the user to upload a rear rack image for OCR label
 * enhancement. After upload, runs OCR and merges with front labels.
 */
export default function RearImagePrompt({ rackId, onComplete, onSkip }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);

  const handleFile = async (file) => {
    if (!file || !file.type.startsWith('image/')) {
      setError('Please upload an image file');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const body = new FormData();
      body.append('image', file);
      body.append('side', 'rear');
      body.append('rackId', rackId);

      const res = await authFetch(apiUrl('/api/ocr/labels'), { method: 'POST', body });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'OCR analysis failed');
      }

      // Now fetch the merged labels (front + rear)
      const mergeRes = await authFetch(apiUrl(`/api/ocr/labels/${rackId}`));
      const mergeData = await mergeRes.json();

      if (!mergeRes.ok) {
        throw new Error(mergeData.error || 'Failed to merge labels');
      }

      // Pass back the merged device labels
      onComplete(mergeData);
    } catch (err) {
      setError(err.message || 'Failed to process rear image');
    } finally {
      setLoading(false);
    }
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  return (
    <div className={styles.modal}>
      <div className={styles.backdrop} onClick={onSkip} />
      <div className={styles.dialog}>
        <div className={styles.header}>
          <h2 className={styles.title}>Enhance with Rear Image</h2>
          <p className={styles.subtitle}>
            Scanning the rear of your rack helps identify devices on the back
          </p>
        </div>

        <div
          className={`${styles.dropZone} ${dragging ? styles.dragOver : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
        >
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
          <p className={styles.dropText}>
            <strong>Drop rear image here</strong>
          </p>
          <p className={styles.dropSub}>or tap to browse</p>
        </div>

        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
          }}
        />

        {error && (
          <div className={styles.error}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            {error}
          </div>
        )}

        {loading && (
          <div className={styles.progress}>
            <div className={styles.spinner} />
            <p>Analyzing rear image…</p>
          </div>
        )}

        <div className={styles.footer}>
          <button
            type="button"
            className={styles.btnSkip}
            onClick={onSkip}
            disabled={loading}
          >
            Skip for now
          </button>
        </div>
      </div>
    </div>
  );
}

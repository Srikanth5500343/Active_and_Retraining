import { useEffect, useRef } from 'react';
import styles from './PointerGlow.module.css';

/* App-wide soft light that follows the pointer (and gently drifts when
   idle / on touch). Fixed overlay, pointer-events:none, low opacity —
   visible on every page, never blocks interaction or hurts readability. */
export default function PointerGlow() {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let tx = window.innerWidth / 2, ty = window.innerHeight * 0.4;
    let cx = tx, cy = ty, lastMove = 0, raf = 0;

    const onMove = (e) => { tx = e.clientX; ty = e.clientY; lastMove = performance.now(); };
    window.addEventListener('pointermove', onMove, { passive: true });

    const tick = () => {
      const now = performance.now();
      if (now - lastMove > 1800) {
        const t = now / 1000;
        tx = window.innerWidth  * (0.5 + Math.sin(t * 0.40) * 0.22);
        ty = window.innerHeight * (0.40 + Math.sin(t * 0.55 + 0.8) * 0.18);
      }
      cx += (tx - cx) * 0.07;
      cy += (ty - cy) * 0.07;
      el.style.setProperty('--px', cx.toFixed(1) + 'px');
      el.style.setProperty('--py', cy.toFixed(1) + 'px');
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { window.removeEventListener('pointermove', onMove); cancelAnimationFrame(raf); };
  }, []);

  return <div ref={ref} className={styles.glow} aria-hidden="true" />;
}

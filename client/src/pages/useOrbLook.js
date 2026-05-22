import { useEffect } from 'react';

/* usePointerGlow(ref)
   A soft light that follows the pointer across the WHOLE screen.
   Sets --px / --py (px, viewport coords) on the element; idles with a
   slow drift so the light keeps moving on touch devices too. */
export function usePointerGlow(ref) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let tx = window.innerWidth / 2, ty = window.innerHeight * 0.4;
    let cx = tx, cy = ty, lastMove = 0, raf = 0;

    const onMove = (e) => { tx = e.clientX; ty = e.clientY; lastMove = performance.now(); };
    window.addEventListener('pointermove', onMove, { passive: true });

    const tick = () => {
      const now = performance.now();
      if (now - lastMove > 1600) {
        const t = now / 1000;
        tx = window.innerWidth  * (0.5 + Math.sin(t * 0.45) * 0.26);
        ty = window.innerHeight * (0.42 + Math.sin(t * 0.6 + 0.8) * 0.2);
      }
      cx += (tx - cx) * 0.08;
      cy += (ty - cy) * 0.08;
      el.style.setProperty('--px', cx.toFixed(1) + 'px');
      el.style.setProperty('--py', cy.toFixed(1) + 'px');
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { window.removeEventListener('pointermove', onMove); cancelAnimationFrame(raf); };
  }, [ref]);
}

/* useOrbLook(ref)
   Makes the orb feel alive: its face tracks the pointer and a soft
   highlight follows the cursor across it. When the pointer is idle
   (or on touch devices with no pointer), the orb gently looks around
   on its own so it's never static/lonely.

   Writes CSS custom properties on the orb element (no React re-renders):
     --lx, --ly  → -1..1   (face/eye offset)
     --gx, --gy  → %        (pointer-follow highlight position) */
export function useOrbLook(ref) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let tx = 0, ty = 0;          // target  (-1..1)
    let cx = 0, cy = 0;          // current (-1..1, eased)
    let lastMove = 0;
    let raf = 0;

    const onMove = (e) => {
      const r = el.getBoundingClientRect();
      const ox = r.left + r.width / 2;
      const oy = r.top + r.height / 2;
      tx = Math.max(-1, Math.min(1, (e.clientX - ox) / (r.width * 0.9)));
      ty = Math.max(-1, Math.min(1, (e.clientY - oy) / (r.height * 0.9)));
      lastMove = performance.now();
    };
    window.addEventListener('pointermove', onMove, { passive: true });

    const tick = () => {
      const now = performance.now();
      if (now - lastMove > 1600) {
        // idle / touch: gentle autonomous wander
        const t = now / 1000;
        tx = Math.sin(t * 0.55) * 0.55;
        ty = Math.sin(t * 0.83 + 1.1) * 0.32;
      }
      cx += (tx - cx) * 0.09;
      cy += (ty - cy) * 0.09;
      el.style.setProperty('--lx', cx.toFixed(3));
      el.style.setProperty('--ly', cy.toFixed(3));
      el.style.setProperty('--gx', (50 + cx * 32).toFixed(1) + '%');
      el.style.setProperty('--gy', (42 + cy * 30).toFixed(1) + '%');
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      window.removeEventListener('pointermove', onMove);
      cancelAnimationFrame(raf);
    };
  }, [ref]);
}

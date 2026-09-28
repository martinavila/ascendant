// Responsive helpers: media-query hooks and the draggable bottom sheet used for
// side panels on phones.

import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

/** Phones (portrait or landscape) and small tablets: compact HUD, drawers, full-screen modals. */
export const COMPACT_Q = '(max-width: 860px), (max-height: 500px)';
/** Landscape phones: very little height, so side panels stay on the right instead of the bottom. */
export const SHORT_Q = '(max-height: 500px)';
/** Narrow phones in portrait. */
export const PHONE_Q = '(max-width: 560px)';

export function useMedia(q: string) {
  const get = () => typeof window !== 'undefined' && !!window.matchMedia?.(q).matches;
  const [m, setM] = useState(get);
  useEffect(() => {
    const mql = window.matchMedia?.(q);
    if (!mql) return;
    const on = () => setM(mql.matches);
    on();
    mql.addEventListener?.('change', on);
    return () => mql.removeEventListener?.('change', on);
  }, [q]);
  return m;
}

export const useCompact = () => useMedia(COMPACT_Q);

export type SnapName = 'peek' | 'half' | 'full';

/**
 * A bottom sheet with a drag handle and three snap heights. Drag the handle
 * (or tap it) to resize; the map stays usable above it. Reports its height via
 * the `--sheet-h` CSS variable on <html> so floating buttons can sit above it.
 */
export function BottomSheet({ children, initial = 'peek', onClose }: { children: ComponentChildren; initial?: SnapName; onClose?: () => void }) {
  const [snap, setSnap] = useState<SnapName>(initial);
  const [dragH, setDragH] = useState<number | null>(null);
  const [vh, setVh] = useState(() => window.innerHeight);
  const drag = useRef<{ y0: number; h0: number; moved: boolean } | null>(null);

  useEffect(() => {
    const r = () => setVh(window.innerHeight);
    window.addEventListener('resize', r);
    return () => window.removeEventListener('resize', r);
  }, []);

  const heights: Record<SnapName, number> = {
    peek: Math.round(Math.min(200, vh * 0.3)),
    half: Math.round(vh * 0.55),
    full: Math.round(vh - 72),
  };
  const h = dragH ?? heights[snap];

  useLayoutEffect(() => {
    document.documentElement.style.setProperty('--sheet-h', `${h}px`);
  }, [h]);
  useEffect(() => () => document.documentElement.style.removeProperty('--sheet-h'), []);

  const order: SnapName[] = ['peek', 'half', 'full'];
  const down = (e: PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { y0: e.clientY, h0: h, moved: false };
  };
  const move = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dy = e.clientY - d.y0;
    if (!d.moved && Math.abs(dy) < 6) return;
    d.moved = true;
    setDragH(Math.max(60, Math.min(heights.full, d.h0 - dy)));
  };
  const up = (e: PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (!d.moved) {
      // Tap on the handle: step to the next height (wrapping back to peek).
      setSnap(order[(order.indexOf(snap) + 1) % order.length]);
      return;
    }
    const cur = Math.max(60, Math.min(heights.full, d.h0 - (e.clientY - d.y0)));
    setDragH(null);
    // Flung well below the peek height: dismiss.
    if (cur < heights.peek * 0.55 && onClose) { onClose(); return; }
    let best: SnapName = 'peek';
    for (const s of order) if (Math.abs(heights[s] - cur) < Math.abs(heights[best] - cur)) best = s;
    setSnap(best);
  };

  return (
    <div class={'panel sheet' + (dragH !== null ? ' dragging' : '')} style={{ height: h }}>
      <div class="sheet-handle" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { drag.current = null; setDragH(null); }}
        role="button" aria-label="Resize panel" data-snap={snap}>
        <i />
      </div>
      <div class="sheet-body">{children}</div>
    </div>
  );
}

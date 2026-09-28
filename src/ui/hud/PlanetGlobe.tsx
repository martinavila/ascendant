import { useEffect, useRef, useState } from 'preact/hooks';
import { useStore } from '../store';
import { BUILDING } from '../../sim/content';
import { PlanetGlobe as Globe } from '../../render3d/PlanetGlobe';

/** 3D planet globe with its tile grid. Clicking a tile calls `onTile(index)`. */
export function PlanetGlobe({ planetId, selectedTile, onTile, height = 420 }: { planetId: number; selectedTile: number | null; onTile: (i: number) => void; height?: number }) {
  const st = useStore();
  const w = st.world!;
  const host = useRef<HTMLDivElement>(null);
  const globe = useRef<Globe | null>(null);
  const tileCb = useRef(onTile);
  tileCb.current = onTile;
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const g = new Globe(host.current!, {
      onTile: (i) => tileCb.current(i),
      onHover: (i) => setHover(i),
    });
    globe.current = g;
    g.update(w, planetId, selectedTile);
    return () => { g.dispose(); globe.current = null; };
  }, []);

  useEffect(() => { globe.current?.update(w, planetId, selectedTile); }, [st.version, planetId, selectedTile]);

  const p = w.s.planets[planetId];
  const t = hover !== null ? p.tiles[hover] : null;
  const q = hover !== null ? p.queue.find((x) => 'tile' in x && x.tile === hover && !('orbital' in x && x.orbital)) : undefined;
  const idle = hover !== null && w.econ(p).idle.has(hover);

  return (
    <div style={{ position: 'relative', height, borderRadius: 10, overflow: 'hidden', border: '1px solid var(--line)' }}>
      <div ref={host} style={{ position: 'absolute', inset: 0 }} />
      <div class="tiny dim" style={{ position: 'absolute', right: 10, top: 8, pointerEvents: 'none' }}>drag to spin · wheel to zoom · tap a tile</div>
      {t && (
        <div class="card small" style={{ position: 'absolute', left: 10, bottom: 10, pointerEvents: 'none', maxWidth: 280 }}>
          <b style={{ textTransform: 'capitalize' }}>{t.c} tile</b>
          {t.b && <div>{BUILDING[t.b.id]?.name}{t.b.auto ? ' · automated' : ''}{idle ? <span class="bad"> · IDLE</span> : ''}</div>}
          {q && <div class="dim">Queued: {w.itemName(q)}</div>}
        </div>
      )}
    </div>
  );
}

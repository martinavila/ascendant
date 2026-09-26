import { useEffect, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { store, useStore } from '../store';
import { Icon } from '../icons';
import { fmt } from '../common';
import { PLANET_TYPE } from '../../sim/content';
import { STAR_LABEL } from '../../art/procedural';
import { fleetVisible } from '../../sim/visibility';
import { SystemScene, type SystemPick } from '../../render3d/SystemScene';

const SIZE_NAME = ['Tiny', 'Small', 'Medium', 'Large', 'Huge'];

/** Full-screen 3D view of one star system. Click a planet to open it, a fleet to select it. */
export function SystemView3D({ starId, onClose }: { starId: number; onClose: () => void }) {
  const st = useStore();
  const w = st.world!;
  const human = w.human()!;
  const star = w.s.stars[starId];
  const host = useRef<HTMLDivElement>(null);
  const labels = useRef<HTMLDivElement>(null);
  const scene = useRef<SystemScene | null>(null);
  const [hover, setHover] = useState<{ pick: SystemPick; x: number; y: number } | null>(null);

  useEffect(() => {
    const el = host.current!;
    const byKey = new Map<string, HTMLElement>();
    const s = new SystemScene(el, starId, w, {
      onPlanet: (id) => { onClose(); store.select({ planet: id, star: starId }); },
      onFleet: (id) => { onClose(); store.select({ fleet: id }); },
      onHover: (pick, x, y) => setHover(pick ? { pick, x, y } : null),
      onFrame: () => {
        const root = labels.current;
        if (!root) return;
        if (byKey.size !== root.childElementCount) {
          byKey.clear();
          for (const c of Array.from(root.children) as HTMLElement[]) byKey.set(c.dataset.key!, c);
        }
        for (const a of s.anchors()) {
          const lab = byKey.get(a.key);
          if (!lab) continue;
          lab.style.display = a.visible ? '' : 'none';
          lab.style.transform = `translate(${Math.round(a.x)}px, ${Math.round(a.y)}px) translate(-50%, ${a.kind === 'fleet' ? '-100%' : '0'})`;
        }
      },
    });
    scene.current = s;
    return () => { s.dispose(); scene.current = null; };
  }, [starId]);

  // Re-sync when the simulation changes (captures, arrivals, new orbitals).
  useEffect(() => { scene.current?.update(w); }, [st.version]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); onClose(); } };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [onClose]);

  const explored = human.explored[starId] === 2;
  const planets = explored ? star.planets.map((id) => w.s.planets[id]) : [];
  const fleets = w.fleetsAtStar(starId).filter((f) => f.transit === 0 && fleetVisible(w, human.id, f));

  let tip: preact.ComponentChildren = null;
  if (hover) {
    if (hover.pick.kind === 'planet') {
      const p = w.s.planets[hover.pick.id];
      const o = p.owner !== null ? w.s.empires[p.owner] : null;
      tip = (
        <>
          <b>{p.name}</b>
          <div class="dim">{SIZE_NAME[p.size]} {PLANET_TYPE[p.type].name}</div>
          <div>{o ? <><span class="dot" style={{ background: o.color }} /> {o.name} · pop {p.pop}</> : 'Unclaimed'}</div>
          {p.orbitals.some(Boolean) && <div class="dim">{p.orbitals.filter(Boolean).length} orbital structure(s)</div>}
          <div class="dim tiny">Click to open</div>
        </>
      );
    } else {
      const f = w.s.fleets[hover.pick.id];
      if (f) {
        const o = w.s.empires[f.owner];
        tip = (
          <>
            <b>{f.name}</b>
            <div><span class="dot" style={{ background: o.color }} /> {o.name}</div>
            <div class="dim">{f.ships.length} ship{f.ships.length === 1 ? '' : 's'} · strength {fmt(w.fleetStrength(f))}</div>
            <div class="dim tiny">Click to select</div>
          </>
        );
      }
    }
  }

  const view = (
    <div class="overlay" style={{ padding: '64px 16px 16px', background: 'rgba(2,3,8,0.7)' }} onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="panel modal" style={{ width: 'min(1400px, 100%)', height: '100%' }}>
        <div class="modal-head">
          <div class="col" style={{ gap: 2 }}>
            <h2>{star.name}</h2>
            <div class="dim small">{STAR_LABEL[star.cls]} · {planets.length} planet{planets.length === 1 ? '' : 's'} · drag to pan, right-drag to rotate, wheel to zoom</div>
          </div>
          <div class="spacer" />
          <div class="seg">
            <button onClick={onClose} data-tip="Back to the 2D map">2D</button>
            <button class="on">3D</button>
          </div>
          <button class="btn icon ghost" onClick={onClose} data-tip="Close (Esc)"><Icon.close /></button>
        </div>
        <div class="modal-body" style={{ position: 'relative' }}>
          <div ref={host} style={{ position: 'absolute', inset: 0, touchAction: 'none' }} />
          <div ref={labels} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}>
            {planets.map((p) => {
              const o = p.owner !== null ? w.s.empires[p.owner] : null;
              return (
                <div key={'p' + p.id} data-key={'p' + p.id} class="small" style={{ display: 'none', position: 'absolute', left: 0, top: 0, whiteSpace: 'nowrap', textShadow: '0 1px 3px #000, 0 0 6px #000', color: o ? o.color : 'var(--text-dim)', fontWeight: o ? 600 : 400 }}>
                  {p.name}
                </div>
              );
            })}
            {fleets.map((f) => (
              <div key={'f' + f.id} data-key={'f' + f.id} class="tiny" style={{ display: 'none', position: 'absolute', left: 0, top: 0, whiteSpace: 'nowrap', textShadow: '0 1px 3px #000', color: w.s.empires[f.owner].color }}>
                {f.name} ({f.ships.length})
              </div>
            ))}
          </div>
          {!explored && <div class="card small" style={{ position: 'absolute', left: 16, top: 16 }}>Unexplored. Send a ship to survey this system.</div>}
          {hover && tip && (
            <div class="tooltip" style={{ left: hover.x + 14, top: hover.y + 14 }}>{tip}</div>
          )}
        </div>
      </div>
    </div>
  );
  const target = (document.querySelector('.game') as HTMLElement | null) ?? document.body;
  return createPortal(view, target);
}

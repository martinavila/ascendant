import { useEffect, useRef, useState } from 'preact/hooks';
import { GalaxyView } from '../../render/galaxy';
import { store, useStore } from '../store';
import { moveFleet } from '../../sim/commands';
import { act } from '../common';
import { STAR_LABEL } from '../../art/procedural';

let view: GalaxyView | null = null;
export const galaxyView = () => view;

export function MapView() {
  const host = useRef<HTMLDivElement>(null);
  const st = useStore();
  const [hover, setHover] = useState<{ star: number; x: number; y: number } | null>(null);

  useEffect(() => {
    const v = new GalaxyView(host.current!, {
      onStar(star, e) {
        const w = store.world!;
        const human = w.human();
        if (store.pick) {
          store.pick.onPick(star);
          return;
        }
        const f = store.sel.fleet !== null ? w.s.fleets[store.sel.fleet] : undefined;
        // Right-click (or tap while a fleet is selected with the move tool) moves the fleet.
        if (e.button === 2 && f && human && f.owner === human.id) {
          act(moveFleet(w, f, star));
          v.routePreview = null;
          return;
        }
        store.select({ star, fleet: e.button === 2 ? store.sel.fleet : null, planet: null });
        if (e.double) v.focusOn(star, Math.max(v.zoom, 0.9));
      },
      onFleet(fleet) {
        const f = store.world!.s.fleets[fleet];
        store.select({ fleet, star: f?.star ?? null, planet: null });
      },
      onEmpty() {
        if (store.pick) return;
        store.select({ fleet: null, star: null, planet: null });
      },
      onHover(star, x, y) {
        setHover(star === null ? null : { star, x, y });
        // Route preview while a fleet is selected.
        const w = store.world;
        const f = w && store.sel.fleet !== null ? w.s.fleets[store.sel.fleet] : undefined;
        const human = w?.human();
        if (w && f && human && f.owner === human.id && star !== null) {
          const from = f.transit > 0 && f.route.length ? f.route[0] : f.star;
          v.routePreview = w.route(from, star, { unstable: w.fleetCanUseUnstable(f), speed: w.fleetSpeed(f) });
        } else v.routePreview = null;
      },
    });
    view = v;
    void v.init().then(() => {
      const w = store.world;
      if (w) {
        v.setWorld(w, w.human()?.id ?? 0);
        const cap = w.human()?.capital;
        if (cap != null) {
          const s = w.s.stars[w.s.planets[cap].star];
          v.cx = s.x;
          v.cy = s.y;
          v.zoom = 0.55;
        } else v.fitAll();
      }
    });
    return () => {
      v.destroy();
      view = null;
    };
  }, []);

  // Keep renderer state in sync with the store.
  useEffect(() => {
    if (!view) return;
    view.selStar = st.sel.star;
    view.selFleet = st.sel.fleet;
    view.showLabels = st.settings.showLabels;
    if (st.sel.fleet === null) view.routePreview = null;
  });
  useEffect(() => {
    if (view && st.focusRequest) view.focusOn(st.focusRequest.star);
  }, [st.focusRequest?.id]);

  const w = st.world;
  let hoverInfo = null;
  if (hover && w) {
    const human = w.human();
    const star = w.s.stars[hover.star];
    const ex = human ? human.explored[hover.star] : 2;
    const f = st.sel.fleet !== null ? w.s.fleets[st.sel.fleet] : undefined;
    let eta = '';
    if (f && human && f.owner === human.id && view?.routePreview) {
      const from = f.transit > 0 && f.route.length ? f.route[0] : f.star;
      const d = w.routeDays(from, view.routePreview, w.fleetSpeed(f)) + (f.transit > 0 ? f.transitTotal - f.transit : 0);
      eta = isFinite(d) ? `Right-click to move: ${d} days, ${view.routePreview.length} jump${view.routePreview.length === 1 ? '' : 's'}` : 'Unreachable';
    } else if (f && human && f.owner === human.id) eta = 'No route (unstable lanes need Lane Stabilizers)';
    const owners = [...w.ownerAtStar(hover.star)].map((o) => w.s.empires[o]);
    hoverInfo = (
      <div class="tooltip" style={{ left: Math.min(hover.x + 16, window.innerWidth - 300), top: hover.y + 16 }}>
        <b>{star.name}</b> <span class="dim">· {STAR_LABEL[star.cls]}</span>
        {ex === 0 ? <div class="dim">Unexplored</div> : (
          <div>
            {star.planets.length} planet{star.planets.length === 1 ? '' : 's'}
            {owners.length > 0 && <> · {owners.map((o) => <span key={o.id} style={{ color: o.color }}> {o.name}</span>)}</>}
            {ex === 1 && <div class="dim">Charted — send a ship to survey it</div>}
          </div>
        )}
        {eta && <div style={{ color: '#ffe27a' }}>{eta}</div>}
      </div>
    );
  }

  return (
    <>
      <div class="map" ref={host} />
      {hoverInfo}
    </>
  );
}

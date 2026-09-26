import { useEffect, useRef, useState } from 'preact/hooks';
import { GalaxyView, type GalaxyCallbacks } from '../../render/galaxy';
import { store, useStore, dispatch } from '../store';
import { act } from '../common';
import { STAR_LABEL } from '../../art/procedural';

/** What MapView needs from a galaxy renderer (2D PixiJS or 3D three.js). */
export interface MapRenderer {
  init(): Promise<void>;
  setWorld(w: NonNullable<typeof store.world>, viewer: number): void;
  destroy(): void;
  focusOn(star: number, zoom?: number): void;
  fitAll(): void;
  selStar: number | null;
  selFleet: number | null;
  routePreview: number[] | null;
  showLabels: boolean;
  zoom: number;
  cx: number;
  cy: number;
}

const MAP3D_KEY = 'ascendant-map3d';
const read3d = () => {
  try { return localStorage.getItem(MAP3D_KEY) === '1'; } catch { return false; }
};

let view: MapRenderer | null = null;
const devExpose = (r: MapRenderer) => { if (import.meta.env.DEV) (globalThis as unknown as { __mapView: MapRenderer }).__mapView = r; };
export const galaxyView = () => view;
/** Camera carried across 2D/3D switches. */
let lastCam: { cx: number; cy: number; zoom: number } | null = null;

export function MapView() {
  const host = useRef<HTMLDivElement>(null);
  const st = useStore();
  const [hover, setHover] = useState<{ star: number; x: number; y: number } | null>(null);
  const [use3d, setUse3d] = useState(read3d);

  const toggle3d = () => {
    const next = !use3d;
    try { localStorage.setItem(MAP3D_KEY, next ? '1' : '0'); } catch { /* storage unavailable */ }
    setUse3d(next);
  };

  useEffect(() => {
    let v: MapRenderer | null = null;
    let dead = false;
    const cb: GalaxyCallbacks = {
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
          act(dispatch({ t: 'moveFleet', fleet: f.id, dest: star }));
          if (v) v.routePreview = null;
          return;
        }
        store.select({ star, fleet: e.button === 2 ? store.sel.fleet : null, planet: null });
        if (e.double && v) v.focusOn(star, Math.max(v.zoom, 0.9));
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
        if (!v) return;
        if (w && f && human && f.owner === human.id && star !== null) {
          const from = f.transit > 0 && f.route.length ? f.route[0] : f.star;
          v.routePreview = w.route(from, star, { unstable: w.fleetCanUseUnstable(f), speed: w.fleetSpeed(f) });
        } else v.routePreview = null;
      },
    };
    const start = async (r: MapRenderer) => {
      await r.init();
      if (dead) return;
      const w = store.world;
      if (!w) return;
      r.setWorld(w, w.human()?.id ?? 0);
      r.selStar = store.sel.star;
      r.selFleet = store.sel.fleet;
      r.showLabels = store.settings.showLabels;
      if (lastCam) {
        r.cx = lastCam.cx;
        r.cy = lastCam.cy;
        r.zoom = lastCam.zoom;
        return;
      }
      const cap = w.human()?.capital;
      if (cap != null) {
        const s = w.s.stars[w.s.planets[cap].star];
        r.cx = s.x;
        r.cy = s.y;
        r.zoom = 0.55;
      } else r.fitAll();
    };
    const make2d = () => {
      const r = new GalaxyView(host.current!, cb);
      v = view = r;
      devExpose(r);
      void start(r);
    };
    if (use3d) {
      // three.js view is loaded on demand; fall back to 2D if WebGL2/three fails.
      void import('../../render3d/Galaxy3D').then(async ({ Galaxy3D }) => {
        if (dead) return;
        const r = new Galaxy3D(host.current!, cb);
        v = view = r;
        devExpose(r);
        try {
          await start(r);
        } catch (err) {
          console.warn('3D map unavailable, using 2D', err);
          r.destroy();
          if (!dead) make2d();
        }
      });
    } else make2d();
    return () => {
      dead = true;
      if (v) {
        lastCam = { cx: v.cx, cy: v.cy, zoom: v.zoom };
        v.destroy();
      }
      if (view === v) view = null;
      setHover(null);
    };
  }, [use3d]);

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

  const showRight = st.sel.fleet !== null || st.sel.star !== null;
  return (
    <>
      <div class="map" ref={host} key={use3d ? '3d' : '2d'} />
      {hoverInfo}
      <button class="btn sm" onClick={toggle3d} data-tip={use3d ? 'Switch to the flat 2D map' : 'Switch to the 3D map (right-drag or Shift-drag to tilt/rotate)'}
        style={{ position: 'absolute', top: 'calc(var(--topbar) + 18px)', right: showRight ? 'calc(var(--right) + 18px)' : 10, zIndex: 14, fontFamily: 'var(--display)', letterSpacing: '0.06em', minWidth: 44 }}>
        <span style={{ opacity: use3d ? 0.45 : 1 }}>2D</span>
        <span style={{ opacity: 0.35 }}>/</span>
        <span style={{ opacity: use3d ? 1 : 0.45 }}>3D</span>
      </button>
    </>
  );
}

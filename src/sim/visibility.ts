import type { EmpireId, Fleet, StarId } from './types';
import type { World } from './world';

const gridCache = new WeakMap<World, { cell: number; map: Map<string, StarId[]> }>();

function starGrid(w: World) {
  let g = gridCache.get(w);
  if (g) return g;
  const cell = 250;
  const map = new Map<string, StarId[]>();
  for (const s of w.s.stars) {
    const k = Math.floor(s.x / cell) + ',' + Math.floor(s.y / cell);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(s.id);
  }
  g = { cell, map };
  gridCache.set(w, g);
  return g;
}

export function starsWithin(w: World, x: number, y: number, r: number): StarId[] {
  const { cell, map } = starGrid(w);
  const out: StarId[] = [];
  const x0 = Math.floor((x - r) / cell), x1 = Math.floor((x + r) / cell);
  const y0 = Math.floor((y - r) / cell), y1 = Math.floor((y + r) / cell);
  for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) {
    for (const id of map.get(gx + ',' + gy) ?? []) {
      const s = w.s.stars[id];
      if ((s.x - x) ** 2 + (s.y - y) ** 2 <= r * r) out.push(id);
    }
  }
  return out;
}

/** Recompute what each empire can see today; update exploration memory. */
export function visibilityTick(w: World) {
  const s = w.s;
  const n = s.stars.length;
  const vis = s.empires.map(() => new Uint8Array(n));
  const mark = (e: EmpireId, star: StarId, range: number) => {
    const st = s.stars[star];
    for (const id of starsWithin(w, st.x, st.y, range)) vis[e][id] = 1;
    vis[e][star] = 1;
  };
  const seer = s.empires.map((e) => (w.species(e).trait === 'seers' ? 2 : 1));
  for (const p of s.planets) if (p.owner !== null) mark(p.owner, p.star, w.econ(p).scan * seer[p.owner]);
  for (const f of Object.values(s.fleets)) {
    let scan = 90;
    for (const id of f.ships) scan = Math.max(scan, w.statsOf(s.ships[id]).scan);
    mark(f.owner, f.star, scan * seer[f.owner]);
    if (f.route.length) vis[f.owner][f.route[0]] = 1;
  }
  // Allies share sensor data.
  for (const a of s.empires) for (const b of s.empires) {
    if (a.id < b.id && w.allied(a.id, b.id)) for (let i = 0; i < n; i++) if (vis[a.id][i] || vis[b.id][i]) vis[a.id][i] = vis[b.id][i] = 1;
  }
  for (const e of s.empires) {
    const v = vis[e.id];
    for (let i = 0; i < n; i++) {
      if (!v[i]) continue;
      e.explored[i] = 2;
      for (const { to } of w.adj[i]) if (e.explored[to] < 1) e.explored[to] = 1;
    }
  }
  w.visible = vis;
}

/** Can `viewer` see this fleet right now? */
export function fleetVisible(w: World, viewer: EmpireId, f: Fleet): boolean {
  if (f.owner === viewer || w.allied(viewer, f.owner)) return true;
  const v = w.visible[viewer];
  if (!v) return false;
  const seen = v[f.star] || (f.route.length > 0 && v[f.route[0]]);
  if (!seen) return false;
  if (w.fleetCloaked(f)) {
    // Detected only by presence at the same star (or adjacent, for Nyx shadows) with deep scanners.
    for (const g of w.fleetsAtStar(f.star)) if (g.owner === viewer && g.ships.some((id) => w.statsOf(w.s.ships[id]).scan >= 320)) return true;
    if (w.species(f.owner).trait === 'shadowed') {
      if (w.ownerAtStar(f.star).has(viewer)) return true;
      for (const { to } of w.adj[f.star]) if (w.fleetsAtStar(to).some((g) => g.owner === viewer) || w.ownerAtStar(to).has(viewer)) return true;
    }
    return false;
  }
  return true;
}

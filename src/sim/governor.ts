import { BUILDING, BUILDINGS } from './content';
import type { BuildItem, BuildingDef, EmpireId, GovernorFocus, Planet, TileColor } from './types';
import { tileMul, type World } from './world';

// The governor is the fix for Ascendancy's infamous micromanagement ("10,000
// clicks"). It is the same code the AI uses, so AI planets are laid out on the
// right colored tiles too — captured worlds no longer need rebuilding.

export const FOCUS_WEIGHTS: Record<GovernorFocus, { ind: number; res: number; pro: number; def: number }> = {
  balanced: { ind: 1, res: 1, pro: 0.9, def: 0.6 },
  industry: { ind: 1.7, res: 0.6, pro: 0.7, def: 0.6 },
  research: { ind: 0.7, res: 1.7, pro: 0.7, def: 0.6 },
  growth: { ind: 0.7, res: 0.6, pro: 1.8, def: 0.4 },
  defense: { ind: 0.9, res: 0.6, pro: 0.7, def: 2.2 },
};

export const FOCUS_LABEL: Record<GovernorFocus, string> = {
  balanced: 'Balanced', industry: 'Industry', research: 'Research', growth: 'Growth', defense: 'Defense',
};

interface Candidate {
  item: BuildItem;
  score: number;
  why: string;
}

const threatCache = new WeakMap<World, { day: number; maps: Map<EmpireId, Float32Array> }>();

/** Hostile pressure per star for an empire: at-war armed fleets and enemy colonies within 2 hops. */
export function threatMap(w: World, e: EmpireId): Float32Array {
  let c = threatCache.get(w);
  if (!c || c.day !== w.s.day) threatCache.set(w, (c = { day: w.s.day, maps: new Map() }));
  const hit = c.maps.get(e);
  if (hit) return hit;
  const s = w.s;
  const m = new Float32Array(s.stars.length);
  const enemies = s.empires.filter((o) => o.alive && w.atWar(e, o.id)).map((o) => o.id);
  if (enemies.length) {
    const seeds: [number, number][] = [];
    for (const f of Object.values(s.fleets)) if (enemies.includes(f.owner) && w.fleetArmed(f)) seeds.push([f.route.length ? f.route[f.route.length - 1] : f.star, w.fleetStrength(f)]);
    for (const o of enemies) for (const pid of w.planetsOf[o]) seeds.push([s.planets[pid].star, 4]);
    for (const [star, v] of seeds) {
      for (const [sid, h] of w.hops(star, 2)) m[sid] += v / (1 + h * 1.5);
    }
  }
  c.maps.set(e, m);
  return m;
}

function workerStats(w: World, p: Planet) {
  const ec = w.econ(p);
  const queuedWorkers = p.queue.filter((q) => q.kind === 'building' && BUILDING[q.id].needsWorker && !q.replace).length;
  const selfmod = w.knows(p.owner!, 'selfmod');
  return { ec, free: p.pop - ec.workersNeeded - queuedWorkers, selfmod };
}

type Weights = { ind: number; res: number; pro: number; def: number };

function valueOf(p: Planet, def: BuildingDef, color: TileColor, W: Weights, focus: GovernorFocus, ctx: ReturnType<typeof workerStats>, threat: number): { v: number; why: string } {
  const m = tileMul(color);
  const ec = ctx.ec;
  const room = ec.popMax - p.pop;
  const proUseful = p.pop === 0 ? 0 : room > 0 ? 1 + Math.min(1, room / 6) : 0.15;
  let v = W.ind * def.yield.ind * m.ind + W.res * def.yield.res * m.res + W.pro * def.yield.pro * m.pro * proUseful;
  let why = '';
  if (m.ind > 1 && def.yield.ind) why = 'on an industry (red) tile';
  if (m.res > 1 && def.yield.res) why = 'on a research (blue) tile';
  if (m.pro > 1 && def.yield.pro) why = 'on a prosperity (green) tile';
  // Opportunity cost: don't waste colored tiles on buildings that ignore their bonus.
  if (color === 'red' && !def.yield.ind) v -= 1.2 * W.ind;
  if (color === 'blue' && !def.yield.res) v -= 1.2 * W.res;
  if (color === 'green' && !def.yield.pro) v -= 0.9 * W.pro;
  if (def.housing) {
    const need = p.pop >= ec.popMax - 1 ? 1.4 : 0.35;
    v += def.housing * need * (0.6 + W.pro * 0.5);
    if (need > 1) why = why || 'population is at capacity';
  }
  if (def.bonus) {
    const y = ec.yield;
    v += W.ind * (def.bonus.ind ?? 0) * y.ind + W.res * (def.bonus.res ?? 0) * y.res + W.pro * (def.bonus.pro ?? 0) * y.pro * proUseful;
    why = 'planet-wide bonus';
  }
  if (def.needsWorker && !ctx.selfmod && ctx.free <= 0) {
    v *= room > 0 ? 0.4 : 0.08;
    why += (why ? '; ' : '') + 'will idle until population grows';
  }
  if (def.role === 'defense') {
    const d = def.defense;
    const power = d ? (d.damage ?? 0) * (d.shots ?? 1) + (d.shield ?? 0) * 0.7 + d.hp / 20 : def.id === 'garrison' ? 3 : 2;
    const t = Math.min(3, threat / 40) + (focus === 'defense' ? 0.6 : 0);
    // Diminishing returns: the fifth garrison is worth far less than the first.
    const same = p.tiles.filter((x) => x.b?.id === def.id).length + p.orbitals.filter((o) => o?.id === def.id).length + p.queue.filter((q) => q.kind === 'building' && q.id === def.id).length;
    v = (W.def * power * t * 0.35) / (1 + same * 0.8);
    if (def.id === 'orbshield' || def.id === 'megashield') v *= p.orbitals.filter((o) => o && BUILDING[o.id].defense?.damage).length >= 2 ? 1 : 0.1;
    if (def.id === 'surfshield' || def.id === 'garrison') v *= p.pop >= 4 ? 1 : 0.3;
    why = threat > 5 ? 'hostile forces nearby' : 'defense focus';
  }
  if (def.id === 'observatory') v += 0.6;
  return { v, why };
}

/**
 * Focus weights nudged toward whatever the empire is short of, so a "balanced"
 * empire without blue tiles still builds labs.
 */
function balancedWeights(w: World, e: EmpireId, focus: GovernorFocus): Weights {
  const base = FOCUS_WEIGHTS[focus];
  const last = w.s.empires[e].last;
  const total = last.ind + last.res;
  if (total < 5) return base;
  const tgtInd = base.ind / (base.ind + base.res), tgtRes = base.res / (base.ind + base.res);
  const shareInd = Math.max(0.05, last.ind / total), shareRes = Math.max(0.05, last.res / total);
  const clamp = (x: number) => Math.max(0.6, Math.min(1.9, x));
  return { ...base, ind: base.ind * clamp(Math.sqrt(tgtInd / shareInd)), res: base.res * clamp(Math.sqrt(tgtRes / shareRes)) };
}

function scoreOf(v: number, cost: number) {
  return v / Math.pow(cost, 0.72);
}

export function governorCandidates(w: World, p: Planet): Candidate[] {
  const owner = p.owner!;
  const focus = p.governor.focus;
  const ctx = workerStats(w, p);
  const threat = threatMap(w, owner)[p.star];
  const out: Candidate[] = [];
  const e = w.s.empires[owner];
  const W = balancedWeights(w, owner, focus);
  const avail = BUILDINGS.filter((b) => w.canBuild(p, b.id));
  const surface = avail.filter((b) => !b.orbital && b.id !== 'excavation');
  const orbital = avail.filter((b) => b.orbital);

  // Excavate ruins first: always worth it.
  if (avail.some((b) => b.id === 'excavation')) {
    const idx = p.tiles.findIndex((t, i) => !t.b && t.c !== 'black' && !w.tileTaken(p, i, false));
    if (idx >= 0) out.push({ item: { kind: 'building', id: 'excavation', tile: idx }, score: 10, why: 'excavate the ancient ruins' });
  }

  // Empty surface tiles.
  let emptyTiles = 0;
  p.tiles.forEach((t, i) => {
    if (t.c === 'black' || t.b || w.tileTaken(p, i, false)) return;
    emptyTiles++;
    for (const b of surface) {
      if (p.pop === 0 && b.needsWorker && !ctx.selfmod) continue;
      const { v, why } = valueOf(p, b, t.c, W, focus, ctx, threat);
      if (v <= 0) continue;
      out.push({ item: { kind: 'building', id: b.id, tile: i }, score: scoreOf(v, w.buildingCost(owner, b.id)), why });
    }
  });

  // Replacements: auto-upgrades (factory → megaplex) and fixing buildings on the wrong tiles.
  if (p.governor.autoUpgrade || e.prefs.autoUpgradeAll) {
    p.tiles.forEach((t, i) => {
      if (!t.b || w.tileQueued(p, i, false) || t.b.id === 'colonybase' || t.b.id === 'excavation') return;
      const cur = BUILDING[t.b.id];
      const curV = valueOf(p, cur, t.c, W, focus, { ...ctx, free: 1 }, threat).v;
      for (const b of surface) {
        if (b.id === cur.id || b.unique) continue;
        const nv = valueOf(p, b, t.c, W, focus, { ...ctx, free: 1 }, threat).v;
        const gain = nv - curV;
        if (gain < 1.2) continue;
        const upgrade = b.upgrades === cur.id;
        const score = scoreOf(gain, w.buildingCost(owner, b.id)) * (upgrade ? 1 : 0.7) * (emptyTiles ? 0.5 : 1);
        out.push({ item: { kind: 'building', id: b.id, tile: i, replace: true }, score, why: upgrade ? `upgrade ${cur.name}` : `${cur.name} is on the wrong tile` });
      }
    });
    p.orbitals.forEach((o, i) => {
      if (!o || w.tileQueued(p, i, true)) return;
      const up = orbital.find((b) => b.upgrades === o.id);
      if (up) out.push({ item: { kind: 'building', id: up.id, tile: i, orbital: true, replace: true }, score: scoreOf(2 + threat / 30, w.buildingCost(owner, up.id)), why: `upgrade ${BUILDING[o.id].name}` });
    });
  }

  // Orbitals.
  const freeOrbit = p.orbitals.findIndex((o, i) => !o && !w.tileTaken(p, i, true));
  if (freeOrbit >= 0) {
    const yards = w.planetsOf[owner].filter((id) => w.econ(w.s.planets[id]).hasShipyard).length;
    for (const b of orbital) {
      let v = 0, why = '';
      if (b.id === 'shipyard') {
        const want = 1 + Math.floor(w.planetsOf[owner].length / 5);
        if (yards < want && ctx.ec.yield.ind >= 5 && p.pop >= 3) { v = 3.5; why = 'the empire needs more shipyards'; }
        if (e.ai.personality === 'militarist' && yards < want + 1 && ctx.ec.yield.ind >= 8) { v = 3.5; why = 'forward shipyard'; }
      } else if (b.id === 'docks') {
        if (ctx.ec.yield.ind >= 12) { v = 2.5; why = 'cheaper ships'; }
      } else {
        ({ v, why } = valueOf(p, b, 'white', W, focus, ctx, threat));
      }
      if (v > 0) out.push({ item: { kind: 'building', id: b.id, tile: freeOrbit, orbital: true }, score: scoreOf(v, w.buildingCost(owner, b.id)), why });
    }
  }

  // Automation frees workers.
  if (w.knows(owner, 'automation')) {
    const idle = ctx.ec.idle;
    p.tiles.forEach((t, i) => {
      // Only automate structures that are idle for lack of workers.
      if (!t.b || t.b.auto || !idle.has(i) || !BUILDING[t.b.id].needsWorker || p.queue.some((q) => q.kind === 'automate' && q.tile === i)) return;
      const def = BUILDING[t.b.id];
      const { v } = valueOf(p, def, t.c, W, focus, { ...ctx, free: 1 }, threat);
      out.push({ item: { kind: 'automate', tile: i }, score: scoreOf(v * 0.75, w.buildingCost(owner, def.id)), why: 'idle for lack of workers' });
    });
  }

  // Terraforming when the surface is full.
  if (!emptyTiles && w.knows(owner, 'terraforming')) {
    const idx = p.tiles.findIndex((t, i) => t.c === 'black' && !w.tileTaken(p, i, false));
    if (idx >= 0) out.push({ item: { kind: 'terraform', tile: idx }, score: scoreOf(2.2, 80), why: 'reclaim a dead tile' });
  }

  out.sort((a, b) => b.score - a.score);
  return out;
}

/** Queue the single best item, or pick a project if nothing is worth building. */
export function governPlanet(w: World, p: Planet) {
  if (p.owner === null) return;
  const cands = governorCandidates(w, p);
  const best = cands[0];
  if (best && best.score > 0.03) {
    p.queue.push(best.item);
    return;
  }
  p.project = pickProject(w, p);
}

export function pickProject(w: World, p: Planet): string {
  const e = w.s.empires[p.owner!];
  const focus = p.governor.focus;
  if (focus === 'defense' && w.knows(e.id, 'assault')) return 'fortify';
  if (focus === 'research') return 'grants';
  if (focus === 'growth' && p.pop < w.econ(p).popMax) return 'festival';
  if (e.ai.personality === 'diplomat' && !e.human && w.knows(e.id, 'linguistics') && p.id % 3 === 0) return 'outreach';
  if (focus === 'industry' || w.planetsOf[e.id].length >= 4) return 'convoy';
  return 'grants';
}

/** Suggestions for the player (manual planets): top few with reasons. */
export function suggestions(w: World, p: Planet, n = 3) {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const c of governorCandidates(w, p)) {
    const key = c.item.kind + ((c.item as any).id ?? '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
    if (out.length >= n) break;
  }
  return out;
}

import { Rng } from './rng';
import { BUILDING, HULL, PART, PLANET_TYPE, SPECIES_BY_ID, TECH } from './content';
import type {
  BuildItem, Empire, EmpireId, EventKind, Fleet, FleetId, GameEvent, GameState, Planet, PlanetId, Ship,
  ShipDesign, SpeciesDef, Star, StarId, Yield,
} from './types';

export const SPEED_UNIT = 16;
export const MAX_EVENTS = 600;
export const MAX_BATTLES = 40;
export const AUTO_EFFICIENCY = 0.75;
export const ASCENSION_COST = 200000;

export interface ShipStats {
  hp: number;
  powerSupply: number;
  powerUse: number;
  /** Parts that receive power (in slot order); unpowered parts don't work. */
  powered: boolean[];
  speed: number;
  shield: number;
  scan: number;
  weapons: { part: string; damage: number; range: number; shots: number }[];
  attack: number;
  colony: number;
  outpost: number;
  invasion: number;
  repair: boolean;
  cloak: boolean;
  laneDrive: boolean;
  tractor: boolean;
  jammer: boolean;
  cost: number;
  warnings: string[];
}

export interface PlanetEcon {
  yield: Yield;
  popMax: number;
  workersNeeded: number;
  workersUsed: number;
  /** Tiles whose building is idle for lack of workers. */
  idle: Set<number>;
  growthNeeded: number;
  scan: number;
  defense: number;
  hasShipyard: boolean;
  hasDocks: boolean;
}

/**
 * Wraps a serializable GameState with derived indexes. Everything the UI and
 * AI need to query quickly lives here; `reindex()` rebuilds it after bulk
 * changes (load, day tick).
 */
export class World {
  rng: Rng;
  planetsOf: PlanetId[][] = [];
  fleetsAt = new Map<StarId, FleetId[]>();
  knownTech: Set<string>[] = [];
  adj: { to: StarId; lane: number }[][] = [];
  econCache = new Map<PlanetId, PlanetEcon>();
  shipStatsCache = new Map<string, ShipStats>();
  /** Per-empire star visibility for the current day (1 = visible now). */
  visible: Uint8Array[] = [];
  version = 0;

  constructor(public s: GameState) {
    this.rng = new Rng(s.rng);
    this.buildAdjacency();
    this.reindex();
  }

  // --- indexing -----------------------------------------------------------

  buildAdjacency() {
    this.adj = this.s.stars.map(() => []);
    for (const l of this.s.lanes) {
      this.adj[l.a].push({ to: l.b, lane: l.id });
      this.adj[l.b].push({ to: l.a, lane: l.id });
    }
  }

  reindex() {
    const s = this.s;
    this.planetsOf = s.empires.map(() => []);
    for (const p of s.planets) if (p.owner !== null) this.planetsOf[p.owner].push(p.id);
    this.fleetsAt.clear();
    for (const f of Object.values(s.fleets)) {
      let arr = this.fleetsAt.get(f.star);
      if (!arr) this.fleetsAt.set(f.star, (arr = []));
      arr.push(f.id);
    }
    this.knownTech = s.empires.map((e) => new Set(e.research.known));
    this.econCache.clear();
    if (this.visible.length !== s.empires.length) this.visible = s.empires.map(() => new Uint8Array(s.stars.length));
    this.version++;
  }

  touch() {
    this.econCache.clear();
    this.version++;
  }

  nextId() {
    return this.s.nextId++;
  }

  syncRng() {
    this.s.rng = this.rng.state;
  }

  // --- lookups ------------------------------------------------------------

  star(id: StarId): Star { return this.s.stars[id]; }
  planet(id: PlanetId): Planet { return this.s.planets[id]; }
  empire(id: EmpireId): Empire { return this.s.empires[id]; }
  fleet(id: FleetId): Fleet | undefined { return this.s.fleets[id]; }
  ship(id: number): Ship | undefined { return this.s.ships[id]; }
  design(id: number): ShipDesign | undefined { return this.s.designs[id]; }
  species(e: EmpireId | Empire): SpeciesDef {
    const emp = typeof e === 'number' ? this.s.empires[e] : e;
    return SPECIES_BY_ID[emp.species];
  }
  human(): Empire | undefined { return this.s.empires.find((e) => e.human); }

  knows(e: EmpireId, tech: string | undefined): boolean {
    return !tech || this.knownTech[e].has(tech);
  }

  fleetsAtStar(star: StarId): Fleet[] {
    return (this.fleetsAt.get(star) ?? []).map((id) => this.s.fleets[id]).filter(Boolean);
  }

  laneBetween(a: StarId, b: StarId) {
    const e = this.adj[a].find((x) => x.to === b);
    return e ? this.s.lanes[e.lane] : undefined;
  }

  dist(a: StarId, b: StarId) {
    const A = this.s.stars[a], B = this.s.stars[b];
    return Math.hypot(A.x - B.x, A.y - B.y);
  }

  event(empire: EmpireId, kind: EventKind, text: string, extra: Partial<GameEvent> = {}) {
    const ev: GameEvent = { id: this.nextId(), day: this.s.day, empire, kind, text, ...extra };
    this.s.events.push(ev);
    if (this.s.events.length > MAX_EVENTS) this.s.events.splice(0, this.s.events.length - MAX_EVENTS);
    return ev;
  }

  // --- diplomacy helpers --------------------------------------------------

  atWar(a: EmpireId, b: EmpireId) {
    return a !== b && this.s.empires[a].relations[b]?.stance === 'war';
  }

  allied(a: EmpireId, b: EmpireId) {
    return a !== b && this.s.empires[a].relations[b]?.stance === 'alliance';
  }

  // --- species multipliers -----------------------------------------------

  mult(e: EmpireId, k: keyof SpeciesDef['mult']): number {
    const m = this.species(e).mult[k];
    return m ?? (k === 'attitude' ? 0 : 1);
  }

  // --- planets ------------------------------------------------------------

  isFavored(p: Planet, e: EmpireId) {
    return this.species(e).favored.includes(p.type);
  }

  buildingCost(e: EmpireId, id: string) {
    return Math.round(BUILDING[id].cost * this.mult(e, 'cost'));
  }

  econ(p: Planet): PlanetEcon {
    const cached = this.econCache.get(p.id);
    if (cached) return cached;
    const e = p.owner;
    const pt = PLANET_TYPE[p.type];
    const y: Yield = { ind: 0, res: 0, pro: 0 };
    const bonus: Yield = { ind: 0, res: 0, pro: 0 };
    let buildable = 0;
    let housing = 0;
    let workersNeeded = 0;
    let scan = 120;
    let defense = 0;
    let hasShipyard = false, hasDocks = false;
    const idle = new Set<number>();
    const pop = p.pop;

    // Assign workers: best buildings first (tile-boosted), so shortages idle the weakest.
    const workerTiles: { i: number; v: number }[] = [];
    p.tiles.forEach((t, i) => {
      if (t.c !== 'black') buildable++;
      if (!t.b) return;
      const def = BUILDING[t.b.id];
      housing += def.housing;
      if (def.id === 'garrison') defense += 8;
      if (def.scan) scan = Math.max(scan, def.scan);
      if (def.needsWorker && !t.b.auto) {
        workersNeeded++;
        const m = tileMul(t.c);
        workerTiles.push({ i, v: def.yield.ind * m.ind + def.yield.res * m.res + def.yield.pro * m.pro + 0.5 });
      }
    });
    workerTiles.sort((a, b) => b.v - a.v);
    for (let k = pop; k < workerTiles.length; k++) idle.add(workerTiles[k].i);

    p.tiles.forEach((t, i) => {
      if (!t.b || idle.has(i)) return;
      const def = BUILDING[t.b.id];
      const m = tileMul(t.c);
      // Automated structures run without workers but less efficiently.
      const a = t.b.auto && def.needsWorker ? AUTO_EFFICIENCY : 1;
      y.ind += def.yield.ind * m.ind * a;
      y.res += def.yield.res * m.res * a;
      y.pro += def.yield.pro * m.pro * a;
      if (def.bonus) {
        bonus.ind += def.bonus.ind ?? 0;
        bonus.res += def.bonus.res ?? 0;
        bonus.pro += def.bonus.pro ?? 0;
      }
    });
    for (const o of p.orbitals) {
      if (!o) continue;
      const def = BUILDING[o.id];
      housing += def.housing;
      y.ind += def.yield.ind;
      y.res += def.yield.res;
      y.pro += def.yield.pro;
      if (def.id === 'shipyard') hasShipyard = true;
      if (def.id === 'docks') { hasDocks = true; hasShipyard = true; }
      if (def.defense) defense += (def.defense.damage ?? 0) * (def.defense.shots ?? 0) * 2 + (def.defense.shield ?? 0);
    }

    let popMax = 0;
    if (e !== null) {
      const fav = this.isFavored(p, e) ? 1.25 : 1;
      popMax = Math.floor(buildable * 0.3 * pt.popMul * fav) + housing + (this.species(e).trait === 'terraformers' ? 2 : 0);
      popMax = Math.max(popMax, housing);
      y.ind *= (1 + bonus.ind) * this.mult(e, 'ind');
      y.res *= (1 + bonus.res) * this.mult(e, 'res');
      y.pro *= (1 + bonus.pro) * this.mult(e, 'pro');
      // AI difficulty handicap/bonus.
      const emp = this.s.empires[e];
      if (!emp.human) {
        const b = [0.8, 1, 1.2, 1.45][emp.ai.difficulty] ?? 1;
        y.ind *= b;
        y.res *= b;
      }
      // Capital bonus: the seat of government coordinates better.
      if (this.s.empires[e].capital === p.id) {
        y.ind += 2;
        y.res += 2;
        y.pro += 1;
      }
    }
    const econ: PlanetEcon = {
      yield: y,
      popMax,
      workersNeeded,
      workersUsed: Math.min(pop, workersNeeded),
      idle,
      growthNeeded: Math.round((20 + 9 * pop) * pt.growth),
      scan,
      defense,
      hasShipyard,
      hasDocks,
    };
    this.econCache.set(p.id, econ);
    return econ;
  }

  itemCost(p: Planet, item: BuildItem): number {
    const e = p.owner!;
    switch (item.kind) {
      case 'building': return this.buildingCost(e, item.id);
      case 'ship': {
        const d = this.s.designs[item.design];
        const base = d ? this.designCost(d) : 999;
        return Math.round(base * (this.econ(p).hasDocks ? 0.75 : 1));
      }
      case 'automate': {
        const b = item.orbital ? p.orbitals[item.tile] : p.tiles[item.tile]?.b;
        return b ? this.buildingCost(e, b.id) : 0;
      }
      case 'terraform': return Math.round(80 * this.mult(e, 'cost'));
      case 'demolish': return 5;
      case 'refit': return Math.round((PART[item.part]?.cost ?? 0) * this.mult(e, 'cost')) + 5;
      case 'ascension': return ASCENSION_COST;
    }
  }

  itemName(item: BuildItem): string {
    switch (item.kind) {
      case 'building': return (item.replace ? 'Upgrade → ' : '') + BUILDING[item.id].name;
      case 'ship': return this.s.designs[item.design]?.name ?? 'Ship';
      case 'automate': return 'Automate structure';
      case 'terraform': return 'Terraform tile';
      case 'demolish': return 'Demolish';
      case 'refit': return `Refit: ${PART[item.part]?.name}`;
      case 'ascension': return 'Ascension Gate';
    }
  }

  canBuild(p: Planet, id: string): boolean {
    const def = BUILDING[id];
    const e = p.owner;
    if (e === null || !this.knows(e, def.tech)) return false;
    if (def.id === 'colonybase') return false;
    if (def.id === 'excavation' && (!p.ruins || p.ruins.dug)) return false;
    if (def.unique) {
      const has = def.orbital ? p.orbitals.some((o) => o?.id === id) : p.tiles.some((t) => t.b?.id === id);
      const queued = p.queue.some((q) => q.kind === 'building' && q.id === id);
      if (has || queued) return false;
    }
    if (id === 'docks' && !p.orbitals.some((o) => o?.id === 'shipyard')) return false;
    if (!def.orbital && p.pop === 0 && def.needsWorker && !this.knows(e, 'selfmod')) return false;
    return true;
  }

  /** Occupied by a structure or by something queued there. */
  tileTaken(p: Planet, tile: number, orbital: boolean) {
    const has = orbital ? !!p.orbitals[tile] : !!p.tiles[tile]?.b;
    return has || this.tileQueued(p, tile, orbital);
  }

  tileQueued(p: Planet, tile: number, orbital: boolean) {
    return p.queue.some((q) => (q.kind === 'building' || q.kind === 'terraform' || q.kind === 'automate' || q.kind === 'demolish') && q.tile === tile && !!(q as { orbital?: boolean }).orbital === orbital);
  }

  // --- ships --------------------------------------------------------------

  designCost(d: { hull: string; parts: string[]; owner: EmpireId }) {
    let c = HULL[d.hull].cost;
    for (const p of d.parts) if (p) c += PART[p].cost;
    return Math.round(c * this.mult(d.owner, 'cost'));
  }

  shipStats(owner: EmpireId, hull: string, parts: string[]): ShipStats {
    const key = owner + '|' + hull + '|' + parts.join(',');
    const hit = this.shipStatsCache.get(key);
    if (hit) return hit;
    const h = HULL[hull];
    const sp = SPECIES_BY_ID[this.s.empires[owner].species];
    let supply = 0;
    for (const id of parts) if (id && PART[id].category === 'generator') supply += PART[id].power + (sp.trait === 'luminous' ? 1 : 0);
    let used = 0;
    const powered: boolean[] = [];
    const st: ShipStats = {
      hp: h.hp, powerSupply: supply, powerUse: 0, powered, speed: 0, shield: 0, scan: 0, weapons: [], attack: 0,
      colony: 0, outpost: 0, invasion: 0, repair: false, cloak: false, laneDrive: sp.trait === 'laneFolder', tractor: false, jammer: false,
      cost: 0, warnings: [],
    };
    let unpowered = 0;
    for (const id of parts) {
      if (!id) { powered.push(false); continue; }
      const p = PART[id];
      let on = true;
      if (p.category !== 'generator' && p.power > 0) {
        if (used + p.power <= supply) used += p.power;
        else { on = false; unpowered++; }
      }
      powered.push(on);
      if (p.hp) st.hp += p.hp;
      if (!on) continue;
      switch (p.category) {
        case 'weapon': st.weapons.push({ part: id, damage: p.damage! * (sp.mult.damage ?? 1), range: p.range!, shots: p.shots! }); break;
        case 'shield': st.shield += p.strength! * (sp.mult.shield ?? 1); break;
        case 'drive': st.speed += p.speed!; break;
        case 'scanner': st.scan = Math.max(st.scan, p.scan!); break;
        case 'special':
          if (p.special === 'colony') st.colony++;
          if (p.special === 'outpost') st.outpost++;
          if (p.special === 'invasion') st.invasion++;
          if (p.special === 'repair') st.repair = true;
          if (p.special === 'cloak') st.cloak = true;
          if (p.special === 'laneDrive') st.laneDrive = true;
          if (p.special === 'tractor') st.tractor = true;
          if (p.special === 'jammer') st.jammer = true;
          break;
      }
    }
    st.hp = Math.round(st.hp * (sp.mult.hp ?? 1));
    st.powerUse = used;
    st.speed = (st.speed / h.mass) * (sp.mult.speed ?? 1);
    st.attack = st.weapons.reduce((a, w) => a + w.damage * w.shots, 0);
    st.cost = this.designCost({ hull, parts, owner });
    if (st.speed === 0) st.warnings.push('No working drive: this ship cannot leave its star.');
    if (unpowered) st.warnings.push(`${unpowered} part${unpowered > 1 ? 's are' : ' is'} unpowered — add generators.`);
    if (!parts.some((x) => x)) st.warnings.push('Empty design.');
    this.shipStatsCache.set(key, st);
    return st;
  }

  statsOf(ship: Ship) {
    return this.shipStats(ship.owner, ship.hull, ship.parts);
  }

  fleetSpeed(f: Fleet) {
    let sp = Infinity;
    for (const id of f.ships) sp = Math.min(sp, this.statsOf(this.s.ships[id]).speed);
    return sp === Infinity ? 0 : sp;
  }

  fleetCanUseUnstable(f: Fleet) {
    return f.ships.length > 0 && f.ships.every((id) => this.statsOf(this.s.ships[id]).laneDrive);
  }

  fleetStrength(f: Fleet) {
    let s = 0;
    for (const id of f.ships) {
      const sh = this.s.ships[id];
      const st = this.statsOf(sh);
      s += Math.sqrt(Math.max(0, st.attack) * (sh.hp + st.shield * 4)) * 2;
    }
    return s;
  }

  fleetArmed(f: Fleet) {
    return f.ships.some((id) => this.statsOf(this.s.ships[id]).attack > 0);
  }

  fleetCloaked(f: Fleet) {
    if (this.species(f.owner).trait === 'shadowed') return true;
    return f.ships.length > 0 && f.ships.every((id) => this.statsOf(this.s.ships[id]).cloak);
  }

  laneDays(laneLen: number, speed: number) {
    if (speed <= 0) return Infinity;
    return Math.max(1, Math.ceil(laneLen / (SPEED_UNIT * speed)));
  }

  // --- pathfinding (Dijkstra on lane days) ---------------------------------

  route(from: StarId, to: StarId, opts: { unstable: boolean; speed?: number; avoid?: (s: StarId) => boolean }): StarId[] | null {
    if (from === to) return [];
    const n = this.s.stars.length;
    const dist = new Float64Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const done = new Uint8Array(n);
    dist[from] = 0;
    // Binary heap keyed by distance.
    const heap: [number, number][] = [[0, from]];
    const push = (d: number, v: number) => {
      heap.push([d, v]);
      let i = heap.length - 1;
      while (i > 0) {
        const pi = (i - 1) >> 1;
        if (heap[pi][0] <= heap[i][0]) break;
        [heap[pi], heap[i]] = [heap[i], heap[pi]];
        i = pi;
      }
    };
    const pop = () => {
      const top = heap[0];
      const last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = i * 2 + 1, r = l + 1;
          let m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]];
          i = m;
        }
      }
      return top;
    };
    const speed = opts.speed && opts.speed > 0 ? opts.speed : 1;
    while (heap.length) {
      const [d, u] = pop();
      if (done[u]) continue;
      done[u] = 1;
      if (u === to) break;
      for (const { to: v, lane } of this.adj[u]) {
        const L = this.s.lanes[lane];
        if (L.unstable && !opts.unstable) continue;
        if (opts.avoid && v !== to && opts.avoid(v)) continue;
        const nd = d + this.laneDays(L.length, speed);
        if (nd < dist[v]) {
          dist[v] = nd;
          prev[v] = u;
          push(nd, v);
        }
      }
    }
    if (prev[to] === -1) return null;
    const path: StarId[] = [];
    for (let v = to; v !== from; v = prev[v]) path.push(v);
    return path.reverse();
  }

  routeDays(from: StarId, path: StarId[], speed: number) {
    let d = 0, cur = from;
    for (const s of path) {
      const l = this.laneBetween(cur, s);
      if (!l) return Infinity;
      d += this.laneDays(l.length, speed);
      cur = s;
    }
    return d;
  }

  /** Stars within N lane hops (BFS). */
  hops(from: StarId, maxHops: number): Map<StarId, number> {
    const out = new Map<StarId, number>([[from, 0]]);
    let frontier = [from];
    for (let h = 1; h <= maxHops; h++) {
      const next: StarId[] = [];
      for (const u of frontier) for (const { to } of this.adj[u]) if (!out.has(to)) { out.set(to, h); next.push(to); }
      frontier = next;
    }
    return out;
  }

  /** Research gets pricier as an empire sprawls, so wide empires don't snowball. */
  techCost(e: EmpireId, id: string) {
    const planets = this.planetsOf[e]?.length ?? 1;
    return Math.round(TECH[id].cost * (1 + Math.min(1.5, Math.max(0, planets - 4) * 0.04)));
  }

  ownerAtStar(star: StarId): Set<EmpireId> {
    const s = new Set<EmpireId>();
    for (const pid of this.s.stars[star].planets) {
      const o = this.s.planets[pid].owner;
      if (o !== null) s.add(o);
    }
    return s;
  }
}

export function tileMul(c: string): Yield {
  return {
    ind: c === 'red' ? 2 : 1,
    res: c === 'blue' ? 2 : 1,
    pro: c === 'green' ? 2 : 1,
  };
}

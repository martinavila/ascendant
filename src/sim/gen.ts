import { Rng, seedRng } from './rng';
import { PLANET_TYPES, PLANET_TYPE, SPECIES, SPECIES_BY_ID, STAR_NAMES, TECHS, NAME_SYLLABLES } from './content';
import type {
  Empire, GameSettings, GameState, Lane, Planet, Relation, ShipDesign, Star, StarClass, Tile, TileColor,
} from './types';
import { World } from './world';
import { refreshTotals } from './economy';

export const SAVE_VERSION = 1;

export const DEFAULT_SETTINGS: GameSettings = {
  seed: 1,
  stars: 150,
  shape: 'spiral',
  empires: 6,
  playerSpecies: 'zurvani',
  playerName: 'Zurvani Concord',
  playerColor: '',
  difficulty: 1,
  planetDensity: 1,
  unstableLanes: 0.12,
  victory: { conquest: true, domination: 60, ascension: true, diplomatic: true, dayLimit: 0 },
};

const GRID_SIZES: [number, number][] = [[4, 3], [5, 4], [6, 5], [7, 6], [8, 7]];
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
const EXTRA_COLORS = ['#e8e8e8', '#ff8a3d', '#3dd6b0', '#c77dff', '#ffd166', '#06d6a0', '#ef476f', '#118ab2', '#a0c4ff', '#ffadad'];

const STAR_CLASSES: { c: StarClass; w: number; planets: [number, number] }[] = [
  { c: 'O', w: 2, planets: [0, 3] },
  { c: 'B', w: 4, planets: [1, 4] },
  { c: 'A', w: 7, planets: [1, 5] },
  { c: 'F', w: 12, planets: [2, 6] },
  { c: 'G', w: 18, planets: [2, 7] },
  { c: 'K', w: 20, planets: [1, 6] },
  { c: 'M', w: 24, planets: [1, 5] },
  { c: 'WD', w: 5, planets: [0, 3] },
  { c: 'NS', w: 3, planets: [0, 2] },
  { c: 'BH', w: 1, planets: [0, 1] },
];

export function newGame(settings: GameSettings): World {
  const rng = Rng.fromSeed(settings.seed);
  const stars = placeStars(settings, rng);
  const lanes = connectStars(stars, settings, rng);
  const planets: Planet[] = [];
  const nameBag = rng.shuffle([...STAR_NAMES]);
  stars.forEach((s, i) => {
    s.name = i < nameBag.length ? nameBag[i] : procName(rng);
    const cls = STAR_CLASSES.find((c) => c.c === s.cls)!;
    const n = Math.round(rng.intRange(cls.planets[0], cls.planets[1]) * settings.planetDensity);
    for (let k = 0; k < Math.min(n, 9); k++) planets.push(makePlanet(planets.length, s, k, pickType(s.cls, k, rng), rng.weighted([0, 1, 2, 3, 4], (x) => [2, 4, 5, 3, 1.3][x]), rng));
  });
  // Ruins: rewards are rolled now, so the outcome is fixed for this galaxy.
  for (const p of planets) {
    if (p.type !== 'gasgiant' && rng.chance(0.055)) {
      const reward = rng.weighted(['tech', 'industry', 'research', 'pop', 'ship'] as const, (r) => ({ tech: 3, industry: 2, research: 2, pop: 1.5, ship: 1 })[r]);
      const tier = rng.intRange(2, 5);
      const pool = TECHS.filter((t) => t.tier === tier);
      p.ruins = { reward, value: rng.intRange(150, 450), tech: reward === 'tech' ? rng.pick(pool).id : undefined };
    }
  }

  const s: GameState = {
    version: SAVE_VERSION, settings, rng: seedRng(settings.seed ^ 0x5eed), day: 1,
    stars, lanes, planets, empires: [], fleets: {}, ships: {}, designs: {}, events: [], battles: [], proposals: [], nextId: 1,
  };
  const w = new World(s);
  placeEmpires(w, rng);
  w.reindex();
  refreshTotals(w);
  return w;
}

function procName(rng: Rng) {
  const n = rng.intRange(2, 3);
  let s = '';
  for (let i = 0; i < n; i++) s += rng.pick(NAME_SYLLABLES);
  return s[0].toUpperCase() + s.slice(1);
}

function placeStars(settings: GameSettings, rng: Rng): Star[] {
  const N = settings.stars;
  const spacing = 115;
  const R = Math.sqrt(N) * spacing * 0.62;
  const minD = spacing * 0.62;
  const cell = minD;
  const grid = new Map<string, number[]>();
  const pts: { x: number; y: number }[] = [];
  const ok = (x: number, y: number) => {
    const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const i of grid.get(gx + dx + ',' + (gy + dy)) ?? []) if (Math.hypot(pts[i].x - x, pts[i].y - y) < minD) return false;
    return true;
  };
  const add = (x: number, y: number) => {
    const k = Math.floor(x / cell) + ',' + Math.floor(y / cell);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k)!.push(pts.length);
    pts.push({ x, y });
  };
  const arms = 2 + (settings.seed % 3);
  const clusters = Array.from({ length: Math.max(3, Math.round(N / 30)) }, () => {
    const a = rng.next() * Math.PI * 2, r = Math.sqrt(rng.next()) * R * 0.8;
    return { x: Math.cos(a) * r, y: Math.sin(a) * r };
  });
  let attempts = 0;
  while (pts.length < N && attempts < N * 400) {
    attempts++;
    let x = 0, y = 0;
    const relax = 1 + attempts / (N * 120);
    switch (settings.shape) {
      case 'spiral': {
        const arm = rng.int(arms);
        const t = Math.pow(rng.next(), 0.8);
        const ang = (arm / arms) * Math.PI * 2 + t * 3.4 + rng.range(-0.35, 0.35) * (1.2 - t);
        const r = (0.12 + t * 0.95) * R * relax;
        x = Math.cos(ang) * r + rng.range(-1, 1) * spacing * 0.9;
        y = Math.sin(ang) * r + rng.range(-1, 1) * spacing * 0.9;
        if (rng.chance(0.18)) { const a = rng.next() * Math.PI * 2, rr = Math.sqrt(rng.next()) * R * 0.35; x = Math.cos(a) * rr; y = Math.sin(a) * rr; }
        break;
      }
      case 'elliptical': {
        const a = rng.next() * Math.PI * 2, r = Math.sqrt(rng.next()) * R * relax;
        x = Math.cos(a) * r * 1.35; y = Math.sin(a) * r * 0.75;
        break;
      }
      case 'ring': {
        const a = rng.next() * Math.PI * 2, r = R * (0.72 + rng.range(-0.22, 0.22) * relax);
        x = Math.cos(a) * r * 1.1; y = Math.sin(a) * r * 1.1;
        break;
      }
      case 'clusters': {
        const c = rng.pick(clusters);
        const a = rng.next() * Math.PI * 2, r = Math.sqrt(rng.next()) * R * 0.33 * relax;
        x = c.x + Math.cos(a) * r; y = c.y + Math.sin(a) * r;
        break;
      }
      default: {
        x = rng.range(-R, R) * 1.2 * relax; y = rng.range(-R, R) * 0.9 * relax;
        const n = Math.sin(x * 0.0021 + settings.seed) * Math.cos(y * 0.0027 - settings.seed);
        if (n < -0.35 && rng.chance(0.8)) continue;
      }
    }
    if (ok(x, y)) add(x, y);
  }
  return pts.map((p, i) => ({
    id: i, name: '', x: Math.round(p.x), y: Math.round(p.y),
    cls: rng.weighted(STAR_CLASSES, (c) => c.w).c, size: rng.range(0.8, 1.3), planets: [], lanes: [], region: 0,
  }));
}

function connectStars(stars: Star[], settings: GameSettings, rng: Rng): Lane[] {
  const n = stars.length;
  // Candidate edges: k nearest neighbours, filtered to the Gabriel graph (planar, no crossings).
  const cell = 200;
  const grid = new Map<string, number[]>();
  stars.forEach((s, i) => {
    const k = Math.floor(s.x / cell) + ',' + Math.floor(s.y / cell);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k)!.push(i);
  });
  const near = (x: number, y: number, r: number) => {
    const out: number[] = [];
    const g0x = Math.floor((x - r) / cell), g1x = Math.floor((x + r) / cell);
    const g0y = Math.floor((y - r) / cell), g1y = Math.floor((y + r) / cell);
    for (let gx = g0x; gx <= g1x; gx++) for (let gy = g0y; gy <= g1y; gy++) for (const i of grid.get(gx + ',' + gy) ?? []) out.push(i);
    return out;
  };
  const edges = new Map<string, { a: number; b: number; d: number }>();
  for (let i = 0; i < n; i++) {
    const s = stars[i];
    let cand: number[] = [];
    for (let r = 260; cand.length < 9 && r < 5000; r *= 1.6) cand = near(s.x, s.y, r).filter((j) => j !== i);
    cand.sort((a, b) => Math.hypot(stars[a].x - s.x, stars[a].y - s.y) - Math.hypot(stars[b].x - s.x, stars[b].y - s.y));
    for (const j of cand.slice(0, 8)) {
      const t = stars[j];
      const mx = (s.x + t.x) / 2, my = (s.y + t.y) / 2;
      const rad = Math.hypot(s.x - t.x, s.y - t.y) / 2;
      const blocked = near(mx, my, rad).some((k) => k !== i && k !== j && Math.hypot(stars[k].x - mx, stars[k].y - my) < rad * 0.999);
      if (blocked) continue;
      const key = i < j ? i + '-' + j : j + '-' + i;
      edges.set(key, { a: Math.min(i, j), b: Math.max(i, j), d: rad * 2 });
    }
  }
  // Kruskal MST guarantees connectivity; then add the shortest extras to reach ~2.5 lanes/star.
  const sorted = [...edges.values()].sort((a, b) => a.d - b.d);
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const chosen: { a: number; b: number; d: number; mst: boolean }[] = [];
  const rest: typeof sorted = [];
  for (const e of sorted) {
    const ra = find(e.a), rb = find(e.b);
    if (ra !== rb) { parent[ra] = rb; chosen.push({ ...e, mst: true }); } else rest.push(e);
  }
  // If the Gabriel candidates left islands (rare), bridge them by nearest pairs.
  for (;;) {
    const roots = new Set(stars.map((_, i) => find(i)));
    if (roots.size <= 1) break;
    const [r0] = roots;
    let best: { a: number; b: number; d: number } | null = null;
    for (let i = 0; i < n; i++) if (find(i) === r0) for (let j = 0; j < n; j++) if (find(j) !== r0) {
      const d = Math.hypot(stars[i].x - stars[j].x, stars[i].y - stars[j].y);
      if (!best || d < best.d) best = { a: i, b: j, d };
    }
    parent[find(best!.a)] = find(best!.b);
    chosen.push({ ...best!, mst: true });
  }
  const targetEdges = Math.round(n * 1.28);
  const deg = new Array(n).fill(0);
  for (const e of chosen) { deg[e.a]++; deg[e.b]++; }
  for (const e of rest) {
    if (chosen.length >= targetEdges) break;
    if (deg[e.a] >= 5 || deg[e.b] >= 5) continue;
    if (rng.chance(0.2)) continue;
    chosen.push({ ...e, mst: false });
    deg[e.a]++; deg[e.b]++;
  }
  const lanes: Lane[] = chosen.map((e, id) => ({
    id, a: e.a, b: e.b, length: Math.round(e.d),
    unstable: !e.mst && rng.chance(settings.unstableLanes * 2.4),
  }));
  for (const l of lanes) { stars[l.a].lanes.push(l.id); stars[l.b].lanes.push(l.id); }
  return lanes;
}

function pickType(cls: StarClass, orbit: number, rng: Rng) {
  const hot = cls === 'O' || cls === 'B' || cls === 'A';
  const dead = cls === 'WD' || cls === 'NS' || cls === 'BH';
  return rng.weighted(PLANET_TYPES, (t) => {
    let w = { barren: 10, primordial: 7, temperate: 8, garden: 3, ore: 7, deepore: 3, resonant: 5, sanctum: 2, rich: 4, opulent: 2, paragon: 0.4, glacial: 6, toxic: 6, gasgiant: 7 }[t.id] ?? 1;
    if (hot && (t.id === 'barren' || t.id === 'primordial' || t.id === 'deepore')) w *= 1.8;
    if (hot && (t.id === 'garden' || t.id === 'temperate')) w *= 0.4;
    if (dead && t.id !== 'barren' && t.id !== 'glacial' && t.id !== 'resonant' && t.id !== 'sanctum') w *= 0.3;
    if ((cls === 'G' || cls === 'K' || cls === 'F') && (t.id === 'temperate' || t.id === 'garden' || t.id === 'rich')) w *= 1.6;
    if (t.id === 'gasgiant') w *= orbit >= 3 ? 2 : 0.3;
    if (t.id === 'glacial') w *= orbit >= 3 ? 1.6 : 0.5;
    return w;
  }).id;
}

function makePlanet(id: number, star: Star, orbit: number, type: string, size: number, rng: Rng): Planet {
  const pt = PLANET_TYPE[type];
  if (type === 'gasgiant') size = Math.max(size, 3);
  const [w, h] = GRID_SIZES[size];
  const tiles: Tile[] = [];
  const colors: TileColor[] = ['white', 'black', 'red', 'green', 'blue'];
  for (let i = 0; i < w * h; i++) {
    const x = i % w, y = Math.floor(i / w);
    // Round the corners so planets read as discs rather than rectangles.
    const nx = (x + 0.5) / w * 2 - 1, ny = (y + 0.5) / h * 2 - 1;
    const edge = nx * nx + ny * ny > 1.25;
    const c = edge ? 'black' : rng.weighted(colors, (c) => pt.tiles[colors.indexOf(c)]);
    tiles.push({ c });
  }
  // Colored tiles cluster: nudge a few neighbours to match.
  for (let pass = 0; pass < 2; pass++) for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    if (t.c === 'red' || t.c === 'green' || t.c === 'blue') {
      const nb = [i - 1, i + 1, i - w, i + w].filter((j) => j >= 0 && j < tiles.length && tiles[j].c === 'white');
      if (nb.length && rng.chance(0.18)) tiles[rng.pick(nb)].c = t.c;
    }
  }
  const orbSlots = (type === 'gasgiant' ? 2 : 1) * (size + 2);
  const p: Planet = {
    id, star: star.id, orbit, name: '', type, size, gridW: w, gridH: h, tiles,
    orbitals: new Array(orbSlots).fill(null), owner: null, pop: 0, growth: 0, progress: 0, queue: [], project: null,
    governor: { on: true, focus: 'balanced', autoUpgrade: true },
  };
  star.planets.push(id);
  p.name = `${star.name || 'Star'} ${ROMAN[orbit]}`;
  return p;
}

function placeEmpires(w: World, rng: Rng) {
  const s = w.s;
  const settings = s.settings;
  const count = Math.min(settings.empires, 16, Math.floor(s.stars.length / 6));
  // Species: player's choice first, then distinct random picks (repeat only if >12 empires).
  const species: string[] = [settings.playerSpecies];
  const pool = rng.shuffle(SPECIES.map((x) => x.id).filter((x) => x !== settings.playerSpecies));
  while (species.length < count) species.push(pool.length ? pool.shift()! : rng.pick(SPECIES).id);

  // Homeworlds: farthest-point sampling over well-connected stars.
  const candidates = s.stars.filter((st) => st.lanes.length >= 2 && st.cls !== 'BH' && st.cls !== 'NS');
  const homes: number[] = [rng.pick(candidates).id];
  while (homes.length < count) {
    let best = -1, bestD = -1;
    for (const c of candidates) {
      if (homes.includes(c.id)) continue;
      const d = Math.min(...homes.map((h) => w.dist(h, c.id))) * (0.85 + rng.next() * 0.3);
      if (d > bestD) { bestD = d; best = c.id; }
    }
    homes.push(best);
  }
  // Put the human in a random home rather than always the first sampled.
  rng.shuffle(homes);

  for (let i = 0; i < count; i++) {
    const sp = SPECIES_BY_ID[species[i]];
    const human = i === 0 && !settings.spectate;
    const usedColors = s.empires.map((e) => e.color);
    let color = i === 0 && settings.playerColor ? settings.playerColor : sp.color;
    if (usedColors.includes(color)) color = EXTRA_COLORS.find((c) => !usedColors.includes(c)) ?? color;
    const e: Empire = {
      id: i,
      name: i === 0 && settings.playerName ? settings.playerName : `${sp.adjective} ${rng.pick(['Dominion', 'Collective', 'Ascendancy', 'Hegemony', 'Commonwealth', 'Union', 'Directorate', 'Assembly', 'Covenant', 'Throng'])}`,
      species: sp.id, color, human, alive: true, capital: null,
      research: { known: [], current: null, progress: 0, queue: [], auto: !human },
      relations: [], explored: new Array(s.stars.length).fill(0), abilityReadyDay: 30,
      ai: { personality: sp.personality, difficulty: human ? 1 : settings.difficulty, memory: {} },
      stats: [], prefs: { autoUpgradeAll: true, governNewColonies: true, autoResearch: !human },
      logistics: 0, last: { ind: 0, res: 0, pro: 0, pop: 0, logisticsIn: 0 },
    };
    s.empires.push(e);
    setupHomeworld(w, e, homes[i], rng);
  }
  // Relations matrix.
  for (const a of s.empires) {
    a.relations = s.empires.map((b): Relation => ({ met: a.id === b.id, stance: 'peace', mods: [], since: 0 }));
  }
  for (const a of s.empires) {
    const telepath = s.empires.some((x) => SPECIES_BY_ID[x.species].trait === 'telepathic');
    if (telepath) for (const b of s.empires) {
      if (SPECIES_BY_ID[a.species].trait === 'telepathic' || SPECIES_BY_ID[b.species].trait === 'telepathic') {
        a.relations[b.id].met = true;
        b.relations[a.id].met = true;
      }
    }
  }
}

function setupHomeworld(w: World, e: Empire, starId: number, rng: Rng) {
  const s = w.s;
  const star = s.stars[starId];
  if (star.cls === 'O' || star.cls === 'B' || star.cls === 'WD') star.cls = 'G';
  const sp = SPECIES_BY_ID[e.species];
  const homeType = sp.favored.find((t) => t !== 'gasgiant' && PLANET_TYPE[t].popMul >= 0.8) ?? 'temperate';
  // Ensure at least 3 planets, and replace the first with the homeworld.
  while (star.planets.length < 3) {
    const p = makePlanet(s.planets.length, star, star.planets.length, rng.pick(['barren', 'ore', 'temperate', 'glacial', 'gasgiant']), rng.intRange(1, 3), rng);
    s.planets.push(p);
  }
  const home = s.planets[star.planets[Math.min(1, star.planets.length - 1)]];
  const fresh = makePlanet(home.id, { ...star, planets: [] }, home.orbit, homeType, 3, rng);
  Object.assign(home, fresh, { name: home.name });
  // Guarantee a reasonable tile mix and no ruins on the capital.
  delete home.ruins;
  home.owner = e.id;
  home.pop = 6;
  home.foundedDay = 0;
  home.governor = { on: !e.human, focus: 'balanced', autoUpgrade: true };
  e.capital = home.id;
  const place = (id: string, pref: TileColor[]) => {
    const idx = home.tiles.findIndex((t) => !t.b && pref.includes(t.c));
    const fallback = home.tiles.findIndex((t) => !t.b && t.c === 'white');
    const i = idx >= 0 ? idx : fallback;
    if (i >= 0) home.tiles[i].b = { id };
  };
  // Make sure the capital has something of each color near the middle.
  const mid = Math.floor(home.tiles.length / 2);
  home.tiles[mid].c = 'white';
  place('colonybase', ['white']);
  place('factory', ['red', 'white']);
  place('factory', ['red', 'white']);
  place('agridome', ['green', 'white']);
  place('lab', ['blue', 'white']);
  place('lab', ['blue', 'white']);
  home.orbitals[0] = { id: 'shipyard' };
  if (sp.trait === 'synthetic') for (const t of home.tiles) if (t.b && t.b.id !== 'colonybase') t.b.auto = true;
  if (sp.trait === 'ancient') e.research.known.push(...TECHS.filter((t) => t.tier === 1).map((t) => t.id));

  // A second decent planet nearby helps early expansion feel good.
  const neighbours = w.hops(starId, 2);
  const colonizable = [...neighbours.keys()].flatMap((sid) => s.stars[sid].planets).filter((pid) => s.planets[pid].owner === null && s.planets[pid].type !== 'gasgiant');
  if (colonizable.length < 3) {
    const sid = [...neighbours.keys()].find((x) => x !== starId && s.stars[x].planets.length < 6);
    if (sid !== undefined) {
      const st = s.stars[sid];
      const p = makePlanet(s.planets.length, st, st.planets.length, rng.pick(['temperate', 'rich', 'ore', 'resonant']), rng.intRange(2, 3), rng);
      s.planets.push(p);
    }
  }

  // Starting designs & ships.
  const mk = (name: string, hull: string, parts: string[], role: ShipDesign['role']): ShipDesign => {
    const d: ShipDesign = { id: w.nextId(), owner: e.id, name, hull, parts, created: 0, role };
    s.designs[d.id] = d;
    return d;
  };
  const scout = mk('Pathfinder', 'small', ['iondrive', 'iondrive', 'fission', 'surveyarray', 'armor'], 'scout');
  const colony = mk('Seedship', 'medium', ['colonymod', 'iondrive', 'iondrive', 'fission', 'armor', '', '', ''], 'colony');
  const corvette = mk('Corvette', 'small', ['massdriver', 'massdriver', 'iondrive', 'fission', 'armor'], 'warship');
  const spawn = (d: ShipDesign, name: string) => {
    const fid = w.nextId();
    const sid = w.nextId();
    const st = w.shipStats(e.id, d.hull, d.parts);
    s.ships[sid] = { id: sid, owner: e.id, design: d.id, name, hull: d.hull, parts: [...d.parts], hp: st.hp, fleet: fid, built: 0, kills: 0 };
    s.fleets[fid] = { id: fid, owner: e.id, name, star: starId, route: [], transit: 0, transitTotal: 0, ships: [sid], stance: d.role === 'warship' ? 'aggressive' : 'evasive', order: { kind: 'none' } };
  };
  spawn(scout, 'Pathfinder I');
  spawn(scout, 'Pathfinder II');
  spawn(colony, 'Seedship I');
  spawn(corvette, 'Home Guard');
  e.explored[starId] = 2;
  for (const { to } of w.adj[starId]) e.explored[to] = Math.max(e.explored[to], 1);
}

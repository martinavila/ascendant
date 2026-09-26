import { BUILDING, PART } from './content';
import type { EmpireId, Fleet, Planet, ShipDesign, StarId } from './types';
import type { World } from './world';
import { addMod } from './economy';

export function spawnShip(w: World, d: ShipDesign, star: StarId, fleetId?: number) {
  const s = w.s;
  const st = w.shipStats(d.owner, d.hull, d.parts);
  const sid = w.nextId();
  const count = Object.values(s.ships).filter((x) => x.design === d.id).length + 1;
  let fleet = fleetId !== undefined ? s.fleets[fleetId] : undefined;
  if (!fleet) {
    const fid = w.nextId();
    fleet = {
      id: fid, owner: d.owner, name: `${d.name} ${count}`, star, route: [], transit: 0, transitTotal: 0, ships: [],
      stance: d.role === 'warship' ? 'aggressive' : 'evasive', order: { kind: 'none' },
    };
    s.fleets[fid] = fleet;
    let arr = w.fleetsAt.get(star);
    if (!arr) w.fleetsAt.set(star, (arr = []));
    arr.push(fid);
  }
  s.ships[sid] = { id: sid, owner: d.owner, design: d.id, name: `${d.name} ${count}`, hull: d.hull, parts: [...d.parts], hp: st.hp, fleet: fleet.id, built: s.day, kills: 0 };
  fleet.ships.push(sid);
  return s.ships[sid];
}

export function removeShip(w: World, id: number) {
  const sh = w.s.ships[id];
  if (!sh) return;
  const f = w.s.fleets[sh.fleet];
  delete w.s.ships[id];
  if (f) {
    f.ships = f.ships.filter((x) => x !== id);
    if (!f.ships.length) removeFleet(w, f.id);
  }
}

export function removeFleet(w: World, id: number) {
  const f = w.s.fleets[id];
  if (!f) return;
  for (const sid of f.ships) delete w.s.ships[sid];
  delete w.s.fleets[id];
  const arr = w.fleetsAt.get(f.star);
  if (arr) w.fleetsAt.set(f.star, arr.filter((x) => x !== id));
}

/** Plot a multi-hop route; returns false if unreachable. */
export function orderMove(w: World, f: Fleet, dest: StarId): boolean {
  if (dest === f.star && f.transit === 0) {
    f.route = [];
    return true;
  }
  // Mid-lane: keep heading to the next hop, then continue from there.
  const from = f.transit > 0 && f.route.length ? f.route[0] : f.star;
  const path = w.route(from, dest, { unstable: w.fleetCanUseUnstable(f), speed: w.fleetSpeed(f) });
  if (!path) return false;
  if (f.transit > 0 && f.route.length) {
    f.route = [f.route[0], ...path];
  } else {
    f.route = path;
    f.transit = 0;
    f.transitTotal = 0;
  }
  return true;
}

/** Advance all fleets one day along their routes. */
export function movementTick(w: World) {
  const s = w.s;
  for (const f of Object.values(s.fleets)) {
    if (!f.route.length) continue;
    const speed = w.fleetSpeed(f);
    if (speed <= 0) {
      f.route = [];
      if (s.empires[f.owner].human) w.event(f.owner, 'warning', `${f.name} has no working drive and cannot move.`, { fleet: f.id, star: f.star });
      continue;
    }
    const next = f.route[0];
    const lane = w.laneBetween(f.star, next);
    if (!lane || (lane.unstable && !w.fleetCanUseUnstable(f))) {
      f.route = [];
      f.transit = 0;
      continue;
    }
    if (!f.transitTotal) f.transitTotal = w.laneDays(lane.length, speed);
    f.transit++;
    if (f.transit >= f.transitTotal) arrive(w, f, next);
  }
}

function arrive(w: World, f: Fleet, star: StarId) {
  const s = w.s;
  const old = w.fleetsAt.get(f.star);
  if (old) w.fleetsAt.set(f.star, old.filter((x) => x !== f.id));
  f.lastStar = f.star;
  f.star = star;
  f.route.shift();
  f.transit = 0;
  f.transitTotal = 0;
  let arr = w.fleetsAt.get(star);
  if (!arr) w.fleetsAt.set(star, (arr = []));
  arr.push(f.id);
  const e = s.empires[f.owner];
  if (e.explored[star] < 2 && e.human) {
    const planets = s.stars[star].planets.length;
    const ruins = s.stars[star].planets.some((p) => s.planets[p].ruins && !s.planets[p].ruins!.dug);
    w.event(f.owner, 'discovery', `${f.name} surveyed ${s.stars[star].name}: ${planets} planet${planets === 1 ? '' : 's'}${ruins ? ', ancient ruins detected' : ''}.`, { star });
  }
  e.explored[star] = 2;
  for (const { to } of w.adj[star]) if (e.explored[to] < 1) e.explored[to] = 1;
  // Blockade: stop at stars holding armed enemies (or enemy-held planets with defenses).
  if (f.route.length && hostilePresence(w, f.owner, star)) {
    f.route = [];
    if (e.human) w.event(f.owner, 'combat', `${f.name} was stopped by hostile forces at ${s.stars[star].name}.`, { fleet: f.id, star });
  }
  // First contact with anyone present.
  for (const o of w.fleetsAtStar(star)) meet(w, f.owner, o.owner, star);
  for (const pid of s.stars[star].planets) {
    const o = s.planets[pid].owner;
    if (o !== null) meet(w, f.owner, o, star);
  }
}

export function hostilePresence(w: World, e: EmpireId, star: StarId) {
  for (const o of w.fleetsAtStar(star)) if (w.atWar(e, o.owner) && w.fleetArmed(o)) return true;
  for (const pid of w.s.stars[star].planets) {
    const p = w.s.planets[pid];
    if (p.owner !== null && w.atWar(e, p.owner) && p.orbitals.some((o) => o && BUILDING[o.id].defense?.damage)) return true;
  }
  return false;
}

export function meet(w: World, a: EmpireId, b: EmpireId, star?: StarId) {
  if (a === b) return;
  const ea = w.s.empires[a], eb = w.s.empires[b];
  if (ea.relations[b].met) return;
  ea.relations[b].met = true;
  eb.relations[a].met = true;
  ea.relations[b].since = eb.relations[a].since = w.s.day;
  addMod(ea, b, 'First impressions', 10, { decay: 2 });
  addMod(eb, a, 'First impressions', 10, { decay: 2 });
  for (const [x, y] of [[ea, eb], [eb, ea]]) {
    if (x.human) w.event(x.id, 'firstContact', `First contact: the ${w.species(y).plural} of the ${y.name}.`, { star, important: true });
  }
}

/** Execute standing orders (colonize/outpost/invade) for fleets that have arrived. */
export function ordersTick(w: World) {
  const s = w.s;
  for (const f of Object.values(s.fleets)) {
    if (f.route.length || f.order.kind === 'none' || f.order.kind === 'explore' || f.order.kind === 'patrol') continue;
    const p = s.planets[f.order.planet];
    if (!p || p.star !== f.star) continue;
    if (f.order.kind === 'colonize' || f.order.kind === 'outpost') {
      const kind = f.order.kind;
      const colonist = f.ships.find((id) => {
        const st = w.statsOf(s.ships[id]);
        return kind === 'colonize' ? st.colony > 0 : st.outpost > 0 || st.colony > 0;
      });
      const ownOutpost = p.owner === f.owner && p.pop === 0 && kind === 'colonize';
      if (colonist !== undefined && (p.owner === null || ownOutpost)) {
        const isColony = kind === 'colonize' && w.statsOf(s.ships[colonist]).colony > 0;
        consumeModule(w, colonist, isColony ? 'colony' : w.statsOf(s.ships[colonist]).outpost > 0 ? 'outpost' : 'colony');
        foundColony(w, p, f.owner, isColony);
      } else if (p.owner !== null && !ownOutpost && s.empires[f.owner].human) {
        w.event(f.owner, 'warning', `${p.name} is already claimed.`, { planet: p.id, star: p.star });
      }
      f.order = { kind: 'none' };
    } else if (f.order.kind === 'invade') {
      tryInvade(w, f, p);
      if (s.fleets[f.id]) f.order = { kind: 'none' };
    }
  }
}

function consumeModule(w: World, shipId: number, kind: 'colony' | 'outpost' | 'invasion') {
  const sh = w.s.ships[shipId];
  const idx = sh.parts.findIndex((p) => p && PART[p].special === kind);
  if (idx >= 0) sh.parts[idx] = '';
  // Colony ships are consumed entirely (the colonists *are* the ship); others keep flying.
  const st = w.statsOf(sh);
  if (kind === 'colony' || (st.attack === 0 && st.colony + st.outpost + st.invasion === 0)) removeShip(w, shipId);
}

export function foundColony(w: World, p: Planet, owner: EmpireId, populated: boolean) {
  const s = w.s;
  const e = s.empires[owner];
  const first = p.owner === null;
  p.owner = owner;
  p.foundedDay = s.day;
  p.queue = [];
  p.progress = 0;
  p.governor = { on: e.prefs.governNewColonies || !e.human, focus: 'balanced', autoUpgrade: true };
  if (populated) {
    p.pop = Math.max(p.pop, w.species(owner).trait === 'sporeborn' ? 3 : 1);
    // Aeolin cloud cities: open up most of a gas giant's "surface".
    if (p.type === 'gasgiant' && w.species(owner).trait === 'drifters' && !p.tiles.some((t) => t.c !== 'black')) {
      p.tiles.forEach((t, i) => { if ((i * 7 + p.id) % 10 < 6) t.c = i % 5 === 0 ? 'green' : 'white'; });
    }
    if (!p.tiles.some((t) => t.b?.id === 'colonybase')) {
      let idx = p.tiles.findIndex((t) => !t.b && t.c === 'white');
      if (idx < 0) idx = p.tiles.findIndex((t) => !t.b && t.c !== 'black');
      if (idx < 0) {
        // Gas giants and dead rocks: carve out one tile.
        idx = Math.floor(p.tiles.length / 2);
        p.tiles[idx].c = 'white';
      }
      p.tiles[idx].b = { id: 'colonybase' };
    }
  }
  w.planetsOf[owner].push(p.id);
  w.touch();
  if (first && e.human) w.event(owner, 'colony', `${populated ? 'Colony' : 'Outpost'} founded on ${p.name}.`, { planet: p.id, star: p.star, important: true });
  for (const o of s.empires) {
    if (o.id === owner) continue;
    const theirs = w.ownerAtStar(p.star).has(o.id);
    if (theirs) addMod(o, owner, 'Settled in our systems', -12, { decay: 2 });
  }
}

export function invasionDefense(w: World, p: Planet) {
  const ec = w.econ(p);
  let d = p.pop * 3 + (p.militia ?? 0) + p.tiles.filter((t) => t.b?.id === 'garrison').length * 8;
  if (p.tiles.some((t) => t.b?.id === 'surfshield')) d *= 1.6;
  if (p.pop === 0) d = Math.max(2, ec.defense * 0.1);
  return Math.round(d);
}

export function planetDefended(p: Planet) {
  return p.orbitals.some((o) => o && BUILDING[o.id].defense && (BUILDING[o.id].defense!.damage ?? 0) > 0);
}

function tryInvade(w: World, f: Fleet, p: Planet) {
  const s = w.s;
  if (p.owner === null || p.owner === f.owner) return;
  const attacker = s.empires[f.owner];
  if (!w.atWar(f.owner, p.owner)) {
    if (attacker.human) w.event(f.owner, 'warning', `You must be at war with the ${s.empires[p.owner].name} to invade ${p.name}.`, { planet: p.id });
    return;
  }
  if (planetDefended(p)) {
    if (attacker.human) w.event(f.owner, 'warning', `${p.name}'s orbital defenses must be destroyed before landing.`, { planet: p.id });
    return;
  }
  const troopShips = f.ships.filter((id) => w.statsOf(s.ships[id]).invasion > 0);
  if (!troopShips.length) return;
  let troops = 0;
  for (const id of troopShips) troops += w.statsOf(s.ships[id]).invasion * 12 * (w.species(f.owner).trait === 'raiders' ? 1.25 : 1);
  const defense = invasionDefense(w, p);
  const defender = p.owner;
  for (const id of troopShips) consumeModule(w, id, 'invasion');
  const roll = w.rng.range(0.85, 1.15);
  if (troops * roll > defense) {
    capturePlanet(w, p, f.owner);
  } else {
    p.pop = Math.max(1, p.pop - Math.floor(troops / 6));
    p.militia = Math.max(0, (p.militia ?? 0) - troops / 2);
    w.econCache.delete(p.id);
    const msg = `Invasion of ${p.name} failed (${Math.round(troops)} troops vs ${defense} defense).`;
    w.event(f.owner, 'invasion', msg, { planet: p.id, important: attacker.human });
    if (s.empires[defender].human) w.event(defender, 'invasion', `We repelled an invasion of ${p.name}!`, { planet: p.id, important: true });
  }
}

export function capturePlanet(w: World, p: Planet, owner: EmpireId) {
  const s = w.s;
  const prev = p.owner!;
  p.prevOwner = prev;
  p.owner = owner;
  p.pop = Math.max(1, Math.floor(p.pop * 0.7));
  p.queue = [];
  p.progress = 0;
  p.militia = 0;
  p.besieged = 0;
  p.governor = { on: s.empires[owner].prefs.governNewColonies || !s.empires[owner].human, focus: 'balanced', autoUpgrade: true };
  if (s.empires[prev].capital === p.id) {
    const rest = s.planets.filter((x) => x.owner === prev && x.id !== p.id).sort((a, b) => b.pop - a.pop);
    s.empires[prev].capital = rest[0]?.id ?? null;
  }
  w.reindex();
  addMod(s.empires[prev], owner, 'Seized our world', -35, { decay: 3 });
  w.event(owner, 'invasion', `We captured ${p.name}!`, { planet: p.id, star: p.star, important: s.empires[owner].human });
  w.event(prev, 'lost', `${p.name} has fallen to the ${s.empires[owner].name}.`, { planet: p.id, star: p.star, important: s.empires[prev].human });
}

export function repairTick(w: World) {
  const s = w.s;
  const docksAt = new Map<StarId, EmpireId[]>();
  for (const p of s.planets) {
    if (p.owner === null) continue;
    if (p.orbitals.some((o) => o?.id === 'docks' || o?.id === 'shipyard')) {
      const arr = docksAt.get(p.star) ?? [];
      arr.push(p.owner);
      docksAt.set(p.star, arr);
    }
  }
  for (const f of Object.values(s.fleets)) {
    const atYard = f.transit === 0 && (docksAt.get(f.star)?.some((o) => o === f.owner || w.allied(o, f.owner)) ?? false);
    for (const id of f.ships) {
      const sh = s.ships[id];
      const st = w.statsOf(sh);
      if (sh.hp >= st.hp) { sh.hp = st.hp; continue; }
      const rate = atYard ? 0.34 : st.repair ? 0.15 : f.transit === 0 && w.ownerAtStar(f.star).has(f.owner) ? 0.05 : 0.02;
      sh.hp = Math.min(st.hp, sh.hp + Math.max(1, Math.round(st.hp * rate)));
    }
  }
}

export function mergeFleets(w: World, into: Fleet, from: Fleet) {
  if (into.id === from.id || into.star !== from.star || into.owner !== from.owner || into.transit || from.transit) return false;
  for (const id of from.ships) w.s.ships[id].fleet = into.id;
  into.ships.push(...from.ships);
  from.ships = [];
  removeFleet(w, from.id);
  return true;
}

export function splitShips(w: World, from: Fleet, shipIds: number[], name?: string) {
  if (from.transit || !shipIds.length || shipIds.length >= from.ships.length) return null;
  const fid = w.nextId();
  const nf: Fleet = { ...from, id: fid, name: name ?? `${from.name} (detached)`, ships: [], route: [], order: { kind: 'none' } };
  w.s.fleets[fid] = nf;
  for (const id of shipIds) {
    from.ships = from.ships.filter((x) => x !== id);
    w.s.ships[id].fleet = fid;
    nf.ships.push(id);
  }
  w.fleetsAt.get(from.star)?.push(fid);
  return nf;
}

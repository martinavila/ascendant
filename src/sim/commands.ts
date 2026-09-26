// Player-facing actions. The UI calls only these, so every rule check lives in one place.
import { BUILDING, HULL, PART, TECH } from './content';
import type { BuildItem, EmpireId, Fleet, FleetStance, GovernorFocus, Planet, ShipDesign, StarId } from './types';
import type { World } from './world';
import { orderMove, mergeFleets, splitShips } from './fleets';
import { governPlanet } from './governor';
import { autoDesign, type DesignRole } from './ai/designer';

export type Result = { ok: true } | { ok: false; error: string };
const ok: Result = { ok: true };
const fail = (error: string): Result => ({ ok: false, error });

// --- planets -----------------------------------------------------------------

export function queueBuilding(w: World, p: Planet, id: string, tile: number, orbital: boolean, front = false): Result {
  const def = BUILDING[id];
  if (!def) return fail('Unknown structure.');
  if (def.orbital !== orbital) return fail(orbital ? 'That is a surface structure.' : 'That goes in orbit.');
  const existing = orbital ? p.orbitals[tile] : p.tiles[tile]?.b;
  if (!orbital && p.tiles[tile]?.c === 'black') return fail('Nothing can be built on dead (black) tiles.');
  if (w.tileTaken(p, tile, orbital) && !existing) return fail('Something is already queued there.');
  if (existing && existing.id === id) return fail('Already built.');
  if (!w.canBuild(p, id)) return fail(def.unique ? `Only one ${def.name} per planet.` : 'Not available yet.');
  const item: BuildItem = { kind: 'building', id, tile, orbital, replace: !!existing || undefined };
  front ? p.queue.unshift(item) : p.queue.push(item);
  w.touch();
  return ok;
}

export function queueItem(w: World, p: Planet, item: BuildItem, front = false): Result {
  if (item.kind === 'ship' && !w.econ(p).hasShipyard) return fail('This planet has no shipyard.');
  if (item.kind === 'automate' && !w.knows(p.owner!, 'automation')) return fail('Requires Automation.');
  if (item.kind === 'terraform' && !w.knows(p.owner!, 'terraforming')) return fail('Requires Terraforming.');
  if (item.kind === 'ascension' && !w.knows(p.owner!, 'transcendence')) return fail('Requires Transcendence Theory.');
  front ? p.queue.unshift(item) : p.queue.push(item);
  w.touch();
  return ok;
}

export function removeQueued(w: World, p: Planet, index: number) {
  p.queue.splice(index, 1);
  if (index === 0) p.progress = Math.min(p.progress, 50);
  w.touch();
}

export function moveQueued(w: World, p: Planet, index: number, dir: -1 | 1) {
  const j = index + dir;
  if (j < 0 || j >= p.queue.length) return;
  [p.queue[index], p.queue[j]] = [p.queue[j], p.queue[index]];
  w.touch();
}

export function setGovernor(w: World, p: Planet, patch: Partial<Planet['governor']>) {
  Object.assign(p.governor, patch);
  if (p.governor.on && !p.queue.length) governPlanet(w, p, true);
  w.touch();
}

export function setGovernorAll(w: World, e: EmpireId, patch: Partial<Planet['governor']>, filter?: (p: Planet) => boolean) {
  for (const id of w.planetsOf[e]) {
    const p = w.s.planets[id];
    if (!filter || filter(p)) setGovernor(w, p, patch);
  }
}

export function setProject(w: World, p: Planet, project: string | null) {
  p.project = project;
  w.touch();
}

/** One-click fix for captured or neglected worlds: queue replacements for badly placed structures. */
export function reoptimize(w: World, p: Planet) {
  const was = { ...p.governor };
  p.governor.autoUpgrade = true;
  let added = 0;
  for (let i = 0; i < 6; i++) {
    const before = p.queue.length;
    governPlanet(w, p, true);
    if (p.queue.length === before) break;
    added++;
  }
  p.governor = was;
  w.touch();
  return added;
}

// --- research ----------------------------------------------------------------

/** All unknown prerequisites of a tech in a valid order (the tech itself last). */
export function techPath(w: World, e: EmpireId, target: string): string[] {
  const out: string[] = [];
  const visit = (id: string) => {
    if (w.knows(e, id) || out.includes(id)) return;
    for (const p of TECH[id].prereqs) visit(p);
    out.push(id);
  };
  visit(target);
  return out;
}

export function researchTowards(w: World, e: EmpireId, target: string, append = false) {
  const r = w.s.empires[e].research;
  const path = techPath(w, e, target);
  if (!path.length) return;
  if (append) {
    r.queue = [...r.queue, ...path.filter((t) => !r.queue.includes(t) && t !== r.current)];
  } else {
    // Switch immediately: progress carries over (no penalty for changing your mind),
    // and whatever we were researching goes back into the queue right after the new path.
    const prev = r.current && !path.includes(r.current) ? [r.current] : [];
    r.current = path[0];
    r.queue = [...path.slice(1), ...prev, ...r.queue.filter((t) => !path.includes(t) && !prev.includes(t))];
  }
  normalizeResearchQueue(w, e);
  w.touch();
}

/** Keep the queue in prerequisite order (stable otherwise) and drop known/duplicate techs. */
export function normalizeResearchQueue(w: World, e: EmpireId) {
  const r = w.s.empires[e].research;
  const seen = new Set<string>();
  const out: string[] = [];
  const pending = r.queue.filter((t) => !w.knows(e, t) && t !== r.current && !seen.has(t) && (seen.add(t), true));
  const done = new Set<string>([...w.knownTech[e], ...(r.current ? [r.current] : [])]);
  while (pending.length) {
    const i = pending.findIndex((t) => TECH[t].prereqs.every((p) => done.has(p) || !pending.includes(p)));
    const t = pending.splice(i < 0 ? 0 : i, 1)[0];
    out.push(t);
    done.add(t);
  }
  r.queue = out;
}

export function dequeueResearch(w: World, e: EmpireId, tech: string) {
  const r = w.s.empires[e].research;
  // Removing a tech also removes queued techs that depend on it.
  const drop = new Set([tech]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of r.queue) if (!drop.has(t) && TECH[t].prereqs.some((p) => drop.has(p))) { drop.add(t); grew = true; }
  }
  r.queue = r.queue.filter((t) => !drop.has(t));
  w.touch();
}

/** Move a queued tech up/down without breaking prerequisite order. Returns false if blocked. */
export function moveResearch(w: World, e: EmpireId, index: number, dir: -1 | 1): boolean {
  const q = w.s.empires[e].research.queue;
  const j = index + dir;
  if (j < 0 || j >= q.length) return false;
  const [a, b] = dir < 0 ? [q[j], q[index]] : [q[index], q[j]];
  if (TECH[b].prereqs.includes(a)) return false;
  [q[index], q[j]] = [q[j], q[index]];
  w.touch();
  return true;
}

// --- fleets ------------------------------------------------------------------

export function moveFleet(w: World, f: Fleet, dest: StarId): Result {
  if (w.fleetSpeed(f) <= 0) return fail('This fleet has no working drive.');
  if (!orderMove(w, f, dest)) return fail(w.fleetCanUseUnstable(f) ? 'No route.' : 'No route — the only paths are unstable (red) lanes, which need Lane Stabilizers.');
  if (f.order.kind === 'explore') f.order = { kind: 'none' };
  w.touch();
  return ok;
}

export function setStance(w: World, f: Fleet, stance: FleetStance) {
  f.stance = stance;
  w.touch();
}

export function orderColonize(w: World, f: Fleet, planetId: number, outpost = false): Result {
  const p = w.s.planets[planetId];
  const has = f.ships.some((id) => {
    const st = w.statsOf(w.s.ships[id]);
    return outpost ? st.outpost > 0 || st.colony > 0 : st.colony > 0;
  });
  if (!has) return fail(outpost ? 'Needs an Outpost Kit or Colony Module.' : 'Needs a Colony Module.');
  if (p.owner !== null && !(p.owner === f.owner && p.pop === 0)) return fail('Already claimed.');
  if (!outpost && p.type === 'gasgiant') return fail('Gas giants can only hold outposts.');
  f.order = outpost ? { kind: 'outpost', planet: planetId } : { kind: 'colonize', planet: planetId };
  if (p.star !== f.star || f.transit) return moveFleet(w, f, p.star);
  w.touch();
  return ok;
}

export function orderInvade(w: World, f: Fleet, planetId: number): Result {
  const p = w.s.planets[planetId];
  if (!f.ships.some((id) => w.statsOf(w.s.ships[id]).invasion > 0)) return fail('Needs Invasion Modules.');
  if (p.owner === null || p.owner === f.owner) return fail('Choose an enemy planet.');
  if (!w.atWar(f.owner, p.owner)) return fail('You are not at war with them.');
  f.order = { kind: 'invade', planet: planetId };
  if (p.star !== f.star || f.transit) return moveFleet(w, f, p.star);
  w.touch();
  return ok;
}

export function merge(w: World, into: Fleet, from: Fleet) {
  const r = mergeFleets(w, into, from);
  w.touch();
  return r;
}

export function split(w: World, f: Fleet, ships: number[]) {
  const nf = splitShips(w, f, ships);
  w.touch();
  return nf;
}

export function renameFleet(w: World, f: Fleet, name: string) {
  f.name = name.slice(0, 40) || f.name;
  w.touch();
}

// --- designs -----------------------------------------------------------------

export function saveDesign(w: World, e: EmpireId, d: { id?: number; name: string; hull: string; parts: string[]; role?: ShipDesign['role'] }): ShipDesign {
  const s = w.s;
  const parts = d.parts.slice(0, HULL[d.hull].slots);
  while (parts.length < HULL[d.hull].slots) parts.push('');
  if (d.id && s.designs[d.id]?.owner === e) {
    Object.assign(s.designs[d.id], { name: d.name, hull: d.hull, parts, role: d.role ?? inferRole(w, e, d.hull, parts) });
    w.touch();
    return s.designs[d.id];
  }
  const nd: ShipDesign = { id: w.nextId(), owner: e, name: d.name, hull: d.hull, parts, created: s.day, role: d.role ?? inferRole(w, e, d.hull, parts) };
  s.designs[nd.id] = nd;
  w.touch();
  return nd;
}

export function inferRole(w: World, e: EmpireId, hull: string, parts: string[]): DesignRole {
  const st = w.shipStats(e, hull, parts);
  if (st.colony) return 'colony';
  if (st.outpost) return 'outpost';
  if (st.invasion) return 'invader';
  if (st.attack > 0) return 'warship';
  return 'scout';
}

export function suggestDesign(w: World, e: EmpireId, role: DesignRole, hull?: string) {
  return autoDesign(w, e, role, hull);
}

export function setObsolete(w: World, d: ShipDesign, obsolete: boolean) {
  d.obsolete = obsolete;
  w.touch();
}

/**
 * Queue per-component refits so every ship in a fleet matches a design.
 * Ships keep their identity (name, kills) — the fix for "refit one design and
 * lose track of which ship has what".
 */
export function refitFleetTo(w: World, f: Fleet, designId: number): Result {
  const s = w.s;
  const d = s.designs[designId];
  if (!d || d.owner !== f.owner) return fail('Unknown design.');
  const yard = w.planetsOf[f.owner].map((id) => s.planets[id]).find((p) => p.star === f.star && w.econ(p).hasShipyard);
  if (!yard) return fail('The fleet must be at one of your shipyards.');
  let n = 0, matched = 0;
  for (const id of f.ships) {
    const sh = s.ships[id];
    if (sh.hull !== d.hull) continue;
    matched++;
    d.parts.forEach((part, slot) => {
      if (part && sh.parts[slot] !== part && w.knows(f.owner, PART[part].tech)) {
        yard.queue.push({ kind: 'refit', ship: id, slot, part });
        n++;
      }
    });
    sh.design = d.id;
  }
  w.touch();
  if (!matched) return fail(`No ship in this fleet has a ${d.hull} hull like ${d.name}.`);
  return n ? ok : fail('Every matching ship already fits this design.');
}

export function refitShipPart(w: World, shipId: number, slot: number, part: string): Result {
  const s = w.s;
  const sh = s.ships[shipId];
  const f = s.fleets[sh.fleet];
  const yard = w.planetsOf[sh.owner].map((id) => s.planets[id]).find((p) => p.star === f.star && w.econ(p).hasShipyard);
  if (!yard) return fail('Refits happen at one of your shipyards.');
  if (part && !w.knows(sh.owner, PART[part].tech)) return fail('Unknown part.');
  yard.queue.push({ kind: 'refit', ship: shipId, slot, part });
  w.touch();
  return ok;
}

// --- empire ------------------------------------------------------------------

export function setPref(w: World, e: EmpireId, k: keyof import('./types').Empire['prefs'], v: boolean) {
  w.s.empires[e].prefs[k] = v;
  if (k === 'autoResearch') w.s.empires[e].research.auto = v;
  w.touch();
}

export function setFocusAll(w: World, e: EmpireId, focus: GovernorFocus) {
  setGovernorAll(w, e, { on: true, focus });
}

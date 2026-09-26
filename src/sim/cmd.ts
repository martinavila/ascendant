// Serializable player commands. Every player action in the UI is expressed as
// one of these plain-JSON objects and applied through `applyCommand`, so the
// same action can run locally (single-player) or travel over the network and be
// replayed in lockstep on every client (multiplayer). Pure and deterministic:
// no DOM, no clocks, no Math.random.

import { BUILDING, HULL, PART, PROJECT, TECH } from './content';
import type { BuildItem, EmpireId, FleetStance, GovernorFocus, Planet, ProposalKind, ShipDesign } from './types';
import type { World } from './world';
import * as C from './commands';
import { declareWar, propose, respond } from './diplomacy';
import { useAbility, type AbilityTarget } from './abilities';

/** Pseudo-empire id for commands issued by the session itself (e.g. AI takeover on disconnect). */
export const SYSTEM = -1;

export type GovernorPatch = Partial<Planet['governor']>;
export type PrefKey = keyof import('./types').Empire['prefs'];

export type Command =
  // planets
  | { t: 'queueBuilding'; planet: number; id: string; tile: number; orbital: boolean; front?: boolean }
  | { t: 'queueItem'; planet: number; item: BuildItem; front?: boolean }
  | { t: 'removeQueued'; planet: number; index: number }
  | { t: 'moveQueued'; planet: number; index: number; dir: -1 | 1 }
  | { t: 'governor'; planet: number; patch: GovernorPatch }
  | { t: 'governorMany'; planets: number[]; patch: GovernorPatch }
  | { t: 'governorAll'; patch: GovernorPatch; onlyGoverned?: boolean }
  | { t: 'focusAll'; focus: GovernorFocus }
  | { t: 'project'; planets: number[]; project: string | null }
  | { t: 'reoptimize'; planet: number }
  // research
  | { t: 'researchTowards'; tech: string; append?: boolean; keepPrevious?: boolean }
  | { t: 'dequeueResearch'; techs: string[] }
  | { t: 'moveResearch'; index: number; dir: -1 | 1 }
  | { t: 'setResearchQueue'; queue: string[] }
  | { t: 'pref'; key: PrefKey; value: boolean }
  // fleets
  | { t: 'moveFleet'; fleet: number; dest: number }
  | { t: 'stopFleet'; fleet: number }
  | { t: 'stance'; fleet: number; stance: FleetStance }
  | { t: 'fleetOrder'; fleet: number; order: 'none' | 'explore' }
  | { t: 'colonize'; fleet: number; planet: number; outpost?: boolean }
  | { t: 'invade'; fleet: number; planet: number }
  | { t: 'merge'; into: number; from: number }
  | { t: 'split'; fleet: number; ships: number[] }
  | { t: 'renameFleet'; fleet: number; name: string }
  // designs & refits
  | { t: 'saveDesign'; design: { id?: number; name: string; hull: string; parts: string[]; role?: ShipDesign['role'] }; refitFleet?: number }
  | { t: 'obsolete'; design: number; obsolete: boolean }
  | { t: 'refitFleet'; fleet: number; design: number }
  | { t: 'refitShip'; ship: number; slot: number; part: string }
  // diplomacy & abilities
  | { t: 'propose'; to: EmpireId; kind: ProposalKind; give?: string; get?: string }
  | { t: 'respond'; proposal: number; accept: boolean }
  | { t: 'declareWar'; target: EmpireId }
  | { t: 'ability'; target: AbilityTarget }
  // session (SYSTEM only)
  | { t: 'control'; empire: EmpireId; human: boolean };

export type CommandType = Command['t'];

export interface CmdResult {
  ok: boolean;
  error?: string;
  /** Command-specific payload: saved design id, new fleet id, proposal evaluation, etc. */
  value?: unknown;
}

const OK: CmdResult = { ok: true };
const fail = (error: string): CmdResult => ({ ok: false, error });
const from = (r: C.Result, value?: unknown): CmdResult => (r.ok ? { ok: true, value } : { ok: false, error: r.error });

const isInt = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x);

/**
 * Apply a command on behalf of `player`. Validates that the player may issue
 * it (only their own planets, fleets, designs, proposals), then calls the
 * existing sim functions. Never throws on bad input: returns `{ ok: false }`.
 */
export function applyCommand(w: World, player: EmpireId, cmd: Command): CmdResult {
  try {
    return apply(w, player, cmd);
  } catch (err) {
    return fail('Command failed: ' + (err as Error).message);
  }
}

function apply(w: World, player: EmpireId, cmd: Command): CmdResult {
  const s = w.s;
  if (!cmd || typeof cmd !== 'object') return fail('Malformed command.');

  if (cmd.t === 'control') {
    if (player !== SYSTEM) return fail('Not allowed.');
    const e = s.empires[cmd.empire];
    if (!e) return fail('No such empire.');
    e.human = !!cmd.human;
    w.touch();
    return OK;
  }

  const emp = s.empires[player];
  if (!emp) return fail('You do not control an empire.');
  if (!emp.alive) return fail('Your empire has fallen.');
  if (s.winner) return fail('The game is over.');

  const myPlanet = (id: number) => {
    const p = isInt(id) ? s.planets[id] : undefined;
    return p && p.owner === player ? p : null;
  };
  const myFleet = (id: number) => {
    const f = isInt(id) ? s.fleets[id] : undefined;
    return f && f.owner === player ? f : null;
  };
  const NOT_YOURS = fail('That is not yours to command.');

  switch (cmd.t) {
    // --- planets -------------------------------------------------------------
    case 'queueBuilding': {
      const p = myPlanet(cmd.planet);
      if (!p) return NOT_YOURS;
      return from(C.queueBuilding(w, p, cmd.id, cmd.tile, !!cmd.orbital, !!cmd.front));
    }
    case 'queueItem': {
      const p = myPlanet(cmd.planet);
      if (!p) return NOT_YOURS;
      const it = cmd.item;
      if (!it || typeof it !== 'object') return fail('Malformed item.');
      if (it.kind === 'ship' && s.designs[it.design]?.owner !== player) return fail('Unknown design.');
      if (it.kind === 'refit') {
        const sh = s.ships[it.ship];
        if (!sh || sh.owner !== player) return NOT_YOURS;
        if (it.part && !PART[it.part]) return fail('Unknown part.');
      }
      if (it.kind === 'building' && !BUILDING[it.id]) return fail('Unknown structure.');
      return from(C.queueItem(w, p, { ...it }, !!cmd.front));
    }
    case 'removeQueued': {
      const p = myPlanet(cmd.planet);
      if (!p) return NOT_YOURS;
      if (!isInt(cmd.index) || cmd.index < 0 || cmd.index >= p.queue.length) return fail('Nothing queued there.');
      C.removeQueued(w, p, cmd.index);
      return OK;
    }
    case 'moveQueued': {
      const p = myPlanet(cmd.planet);
      if (!p) return NOT_YOURS;
      if (!isInt(cmd.index) || (cmd.dir !== 1 && cmd.dir !== -1)) return fail('Malformed command.');
      C.moveQueued(w, p, cmd.index, cmd.dir);
      return OK;
    }
    case 'governor': {
      const p = myPlanet(cmd.planet);
      if (!p) return NOT_YOURS;
      C.setGovernor(w, p, cleanPatch(cmd.patch));
      return OK;
    }
    case 'governorMany': {
      const patch = cleanPatch(cmd.patch);
      for (const id of cmd.planets ?? []) {
        const p = myPlanet(id);
        if (p) C.setGovernor(w, p, patch);
      }
      return OK;
    }
    case 'governorAll':
      C.setGovernorAll(w, player, cleanPatch(cmd.patch), cmd.onlyGoverned ? (p) => p.governor.on : undefined);
      return OK;
    case 'focusAll':
      C.setFocusAll(w, player, cmd.focus);
      return OK;
    case 'project': {
      if (cmd.project !== null && !PROJECT[cmd.project]) return fail('Unknown project.');
      for (const id of cmd.planets ?? []) {
        const p = myPlanet(id);
        if (p) C.setProject(w, p, cmd.project);
      }
      return OK;
    }
    case 'reoptimize': {
      const p = myPlanet(cmd.planet);
      if (!p) return NOT_YOURS;
      return { ok: true, value: C.reoptimize(w, p) };
    }

    // --- research ------------------------------------------------------------
    case 'researchTowards': {
      if (!TECH[cmd.tech]) return fail('Unknown technology.');
      if (w.knows(player, cmd.tech)) return fail(`${TECH[cmd.tech].name} is already known.`);
      const r = emp.research;
      const prev = r.current;
      const path = C.techPath(w, player, cmd.tech);
      C.researchTowards(w, player, cmd.tech, !!cmd.append);
      // The research screen keeps a switched-away tech right after the new path.
      if (cmd.keepPrevious && !cmd.append && prev && prev !== r.current && !w.knows(player, prev) && !r.queue.includes(prev)) {
        r.queue = [...r.queue.slice(0, path.length - 1), prev, ...r.queue.slice(path.length - 1)];
        C.normalizeResearchQueue(w, player);
      }
      return { ok: true, value: path };
    }
    case 'dequeueResearch':
      for (const t of cmd.techs ?? []) if (TECH[t]) C.dequeueResearch(w, player, t);
      return OK;
    case 'moveResearch':
      if (!isInt(cmd.index) || (cmd.dir !== 1 && cmd.dir !== -1)) return fail('Malformed command.');
      return C.moveResearch(w, player, cmd.index, cmd.dir) ? OK : fail('Prerequisites must stay first.');
    case 'setResearchQueue': {
      if (!Array.isArray(cmd.queue) || cmd.queue.some((t) => !TECH[t])) return fail('Unknown technology.');
      // Same set of techs, new order: never a way to add research for free.
      emp.research.queue = cmd.queue.filter((t) => t !== emp.research.current && !w.knows(player, t));
      C.normalizeResearchQueue(w, player);
      w.touch();
      return OK;
    }
    case 'pref':
      if (!(cmd.key in emp.prefs)) return fail('Unknown setting.');
      C.setPref(w, player, cmd.key, !!cmd.value);
      return OK;

    // --- fleets --------------------------------------------------------------
    case 'moveFleet': {
      const f = myFleet(cmd.fleet);
      if (!f) return NOT_YOURS;
      if (!isInt(cmd.dest) || !s.stars[cmd.dest]) return fail('No such star.');
      return from(C.moveFleet(w, f, cmd.dest));
    }
    case 'stopFleet': {
      const f = myFleet(cmd.fleet);
      if (!f) return NOT_YOURS;
      f.route = f.transit > 0 ? f.route.slice(0, 1) : [];
      w.touch();
      return OK;
    }
    case 'stance': {
      const f = myFleet(cmd.fleet);
      if (!f) return NOT_YOURS;
      if (!['aggressive', 'defensive', 'evasive'].includes(cmd.stance)) return fail('Unknown stance.');
      C.setStance(w, f, cmd.stance);
      return OK;
    }
    case 'fleetOrder': {
      const f = myFleet(cmd.fleet);
      if (!f) return NOT_YOURS;
      f.order = cmd.order === 'explore' ? { kind: 'explore' } : { kind: 'none' };
      w.touch();
      return OK;
    }
    case 'colonize': {
      const f = myFleet(cmd.fleet);
      if (!f) return NOT_YOURS;
      if (!isInt(cmd.planet) || !s.planets[cmd.planet]) return fail('No such planet.');
      return from(C.orderColonize(w, f, cmd.planet, !!cmd.outpost));
    }
    case 'invade': {
      const f = myFleet(cmd.fleet);
      if (!f) return NOT_YOURS;
      if (!isInt(cmd.planet) || !s.planets[cmd.planet]) return fail('No such planet.');
      return from(C.orderInvade(w, f, cmd.planet));
    }
    case 'merge': {
      const into = myFleet(cmd.into), fr = myFleet(cmd.from);
      if (!into || !fr) return NOT_YOURS;
      return C.merge(w, into, fr) ? OK : fail('Fleets must be idle at the same star.');
    }
    case 'split': {
      const f = myFleet(cmd.fleet);
      if (!f) return NOT_YOURS;
      const ships = [...new Set(cmd.ships ?? [])].filter((id) => f.ships.includes(id));
      const nf = C.split(w, f, ships);
      return nf ? { ok: true, value: nf.id } : fail('Cannot split that fleet now.');
    }
    case 'renameFleet': {
      const f = myFleet(cmd.fleet);
      if (!f) return NOT_YOURS;
      C.renameFleet(w, f, String(cmd.name ?? ''));
      return OK;
    }

    // --- designs -------------------------------------------------------------
    case 'saveDesign': {
      const d = cmd.design;
      if (!d || !HULL[d.hull]) return fail('Unknown hull.');
      if (!w.knows(player, HULL[d.hull].tech)) return fail('Hull not researched.');
      if (!Array.isArray(d.parts) || d.parts.some((p) => p && (!PART[p] || !w.knows(player, PART[p].tech)))) return fail('Unknown part.');
      if (d.id !== undefined && s.designs[d.id] && s.designs[d.id].owner !== player) return NOT_YOURS;
      const saved = C.saveDesign(w, player, { id: d.id, name: String(d.name ?? '').slice(0, 60) || 'Design', hull: d.hull, parts: d.parts, role: d.role });
      if (cmd.refitFleet !== undefined) {
        const f = myFleet(cmd.refitFleet);
        if (!f) return NOT_YOURS;
        const r = C.refitFleetTo(w, f, saved.id);
        return r.ok ? { ok: true, value: saved.id } : { ok: false, error: r.error, value: saved.id };
      }
      return { ok: true, value: saved.id };
    }
    case 'obsolete': {
      const d = s.designs[cmd.design];
      if (!d || d.owner !== player) return NOT_YOURS;
      C.setObsolete(w, d, !!cmd.obsolete);
      return OK;
    }
    case 'refitFleet': {
      const f = myFleet(cmd.fleet);
      if (!f) return NOT_YOURS;
      return from(C.refitFleetTo(w, f, cmd.design));
    }
    case 'refitShip': {
      const sh = s.ships[cmd.ship];
      if (!sh || sh.owner !== player) return NOT_YOURS;
      if (cmd.part && !PART[cmd.part]) return fail('Unknown part.');
      if (!isInt(cmd.slot) || cmd.slot < 0 || cmd.slot >= HULL[sh.hull].slots) return fail('No such slot.');
      return from(C.refitShipPart(w, cmd.ship, cmd.slot, cmd.part));
    }

    // --- diplomacy -----------------------------------------------------------
    case 'propose': {
      const to = s.empires[cmd.to];
      if (!to || !to.alive || cmd.to === player) return fail('No such empire.');
      if (!emp.relations[cmd.to].met) return fail('You have not met them.');
      if ((cmd.kind === 'gift' || cmd.kind === 'trade') && (!cmd.give || !w.knows(player, cmd.give))) return fail('You can only offer technology you know.');
      if (cmd.kind === 'trade' && (!cmd.get || !w.knows(cmd.to, cmd.get))) return fail('They do not know that technology.');
      const ev = propose(w, { from: player, to: cmd.to, kind: cmd.kind, give: cmd.give, get: cmd.get });
      w.touch();
      return { ok: true, value: ev };
    }
    case 'respond': {
      const p = s.proposals.find((x) => x.id === cmd.proposal);
      if (!p || p.to !== player) return fail('That proposal is no longer open.');
      respond(w, cmd.proposal, !!cmd.accept);
      w.touch();
      return OK;
    }
    case 'declareWar': {
      const t = s.empires[cmd.target];
      if (!t || !t.alive || cmd.target === player) return fail('No such empire.');
      if (!emp.relations[cmd.target].met) return fail('You have not met them.');
      declareWar(w, player, cmd.target);
      w.touch();
      return OK;
    }
    case 'ability': {
      const err = useAbility(w, player, cmd.target ?? {});
      w.touch();
      return err ? fail(err) : OK;
    }
  }
  return fail('Unknown command.');
}

function cleanPatch(p: GovernorPatch | undefined): GovernorPatch {
  const out: GovernorPatch = {};
  if (!p) return out;
  if (typeof p.on === 'boolean') out.on = p.on;
  if (typeof p.autoUpgrade === 'boolean') out.autoUpgrade = p.autoUpgrade;
  if (p.focus && ['balanced', 'industry', 'research', 'growth', 'defense'].includes(p.focus)) out.focus = p.focus;
  return out;
}

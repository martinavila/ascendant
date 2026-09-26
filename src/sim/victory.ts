import type { Empire, EmpireId, EmpireStats } from './types';
import type { World } from './world';
import { removeFleet } from './fleets';
import { empirePower } from './diplomacy';

export const DIPLO_HOLD_DAYS = 120;

export function score(w: World, e: Empire) {
  const planets = w.planetsOf[e.id].length;
  return Math.round(e.last.pop * 2 + planets * 5 + e.research.known.length * 8 + empirePower(w, e.id) / 20);
}

export interface VictoryProgress {
  kind: string;
  label: string;
  /** 0..1 */
  value: number;
  detail: string;
  enabled: boolean;
}

export function victoryProgress(w: World, e: EmpireId): VictoryProgress[] {
  const s = w.s;
  const v = s.settings.victory;
  const emp = s.empires[e];
  const alive = s.empires.filter((x) => x.alive);
  const others = alive.filter((x) => x.id !== e);
  const totalPop = s.empires.reduce((a, x) => a + x.last.pop, 0) || 1;
  const share = emp.last.pop / totalPop;
  const alliedSince = emp.ai.memory.allAlliedSince;
  const allAllied = others.length > 0 && others.every((o) => w.allied(e, o.id));
  const eliminated = s.empires.length - alive.length;
  const gate = w.planetsOf[e].map((id) => s.planets[id]).find((p) => p.queue[0]?.kind === 'ascension');
  const gateFrac = gate ? Math.min(1, gate.progress / w.itemCost(gate, gate.queue[0])) : 0;
  const out: VictoryProgress[] = [
    { kind: 'conquest', label: 'Conquest', enabled: v.conquest, value: eliminated / Math.max(1, s.empires.length - 1), detail: `${others.length} rival${others.length === 1 ? '' : 's'} remain` },
    { kind: 'domination', label: 'Domination', enabled: v.domination > 0, value: Math.min(1, share / (v.domination / 100 || 1)), detail: `${Math.round(share * 100)}% of galactic population (need ${v.domination}%)` },
    {
      kind: 'ascension', label: 'Ascension', enabled: v.ascension,
      value: gate ? 0.5 + 0.5 * gateFrac : w.knows(e, 'transcendence') ? 0.5 : (emp.research.known.length / 52) * 0.5,
      detail: gate ? `Ascension Gate on ${gate.name}: ${Math.round(gateFrac * 100)}%` : w.knows(e, 'transcendence') ? 'Build the Ascension Gate on any planet' : 'Research Transcendence Theory, then build the Ascension Gate',
    },
    {
      kind: 'diplomatic', label: 'Galactic Accord', enabled: v.diplomatic,
      value: allAllied && alliedSince !== undefined ? Math.min(1, (s.day - alliedSince) / DIPLO_HOLD_DAYS) : others.filter((o) => w.allied(e, o.id)).length / Math.max(1, others.length) * 0.5,
      detail: `Allied with ${others.filter((o) => w.allied(e, o.id)).length}/${others.length}; hold an alliance with every survivor for ${DIPLO_HOLD_DAYS} days`,
    },
  ];
  if (v.dayLimit) out.push({ kind: 'score', label: 'Score', enabled: true, value: Math.min(1, s.day / v.dayLimit), detail: `Highest score on day ${v.dayLimit} wins (you: ${score(w, emp)})` });
  return out;
}

export function victoryTick(w: World) {
  const s = w.s;
  if (s.winner) return;
  // Elimination.
  for (const e of s.empires) {
    if (!e.alive) continue;
    const hasPlanets = w.planetsOf[e.id].length > 0;
    const hasColonists = Object.values(s.fleets).some((f) => f.owner === e.id && f.ships.some((id) => w.statsOf(s.ships[id]).colony > 0));
    if (!hasPlanets && !hasColonists) {
      e.alive = false;
      e.eliminatedDay = s.day;
      for (const f of Object.values(s.fleets)) if (f.owner === e.id) removeFleet(w, f.id);
      for (const o of s.empires) if (o.relations[e.id]?.met && o.human) w.event(o.id, 'diplomacy', `The ${e.name} ${o.id === e.id ? 'have' : 'has'} been eliminated.`, { important: true });
    }
  }
  const alive = s.empires.filter((e) => e.alive);
  const v = s.settings.victory;
  const human = s.empires.find((e) => e.human);
  const totalPop = s.empires.reduce((a, x) => a + x.last.pop, 0) || 1;
  const win = (e: Empire, kind: string) => {
    s.winner = { empire: e.id, kind, day: s.day };
    for (const o of s.empires) w.event(o.id, 'victory', `${e.name} wins a ${kind} victory!`, { important: true });
  };
  if (human && !human.alive && !s.settings.spectate) {
    const best = alive.sort((a, b) => score(w, b) - score(w, a))[0];
    if (best) return win(best, 'Conquest');
  }
  if (v.conquest && alive.length === 1) return win(alive[0], 'Conquest');
  for (const e of alive) {
    if (v.domination && e.last.pop / totalPop >= v.domination / 100 && s.day > 50) return win(e, 'Domination');
    const others = alive.filter((o) => o.id !== e.id);
    const allAllied = others.length > 0 && others.every((o) => w.allied(e.id, o.id));
    if (allAllied) {
      e.ai.memory.allAlliedSince ??= s.day;
      if (v.diplomatic && s.day - e.ai.memory.allAlliedSince >= DIPLO_HOLD_DAYS) return win(e, 'Galactic Accord');
    } else delete e.ai.memory.allAlliedSince;
  }
  if (v.dayLimit && s.day >= v.dayLimit) {
    const best = [...alive].sort((a, b) => score(w, b) - score(w, a))[0];
    return win(best, 'Score');
  }
}

export function statsTick(w: World) {
  const s = w.s;
  if (s.day % 10 !== 0) return;
  for (const e of s.empires) {
    if (!e.alive) continue;
    let ships = 0, military = 0;
    for (const f of Object.values(s.fleets)) if (f.owner === e.id) { ships += f.ships.length; military += w.fleetStrength(f); }
    const st: EmpireStats = {
      day: s.day, planets: w.planetsOf[e.id].length, pop: e.last.pop, ind: Math.round(e.last.ind), res: Math.round(e.last.res),
      pro: Math.round(e.last.pro), ships, military: Math.round(military), techs: e.research.known.length, score: score(w, e),
    };
    e.stats.push(st);
    // Keep history bounded for very long games: thin out old samples.
    if (e.stats.length > 400) e.stats = e.stats.filter((_, i) => i % 2 === 0 || i > 300);
  }
}

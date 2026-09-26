import { BUILDING, PART, SPECIES_BY_ID, TECH, TECHS } from './content';
import type { BuildItem, Empire, EmpireId, Planet, ShipDesign, TechCategory } from './types';
import type { World } from './world';
import { governPlanet } from './governor';
import { spawnShip } from './fleets';

/** Runs production, growth, and research for every empire for one day. */
export function economyTick(w: World) {
  const s = w.s;
  const resTotals = new Array(s.empires.length).fill(0);
  const indTotals = new Array(s.empires.length).fill(0);
  const proTotals = new Array(s.empires.length).fill(0);
  const popTotals = new Array(s.empires.length).fill(0);
  const outreach = new Array(s.empires.length).fill(0);

  for (const p of s.planets) {
    if (p.owner === null) continue;
    const e = s.empires[p.owner];
    const ec = w.econ(p);
    let ind = ec.yield.ind;
    let res = ec.yield.res;
    let pro = ec.yield.pro;
    if (p.besieged) {
      ind *= 0.5;
      p.besieged--;
    }

    if (p.queue.length === 0 && p.governor.on) governPlanet(w, p);

    if (p.queue.length === 0) {
      switch (p.project) {
        case 'grants': res += ind * 0.5; ind = 0; break;
        case 'festival': pro += ind * 0.5; ind = 0; break;
        case 'convoy': e.logistics += ind * (w.species(e).trait === 'haulers' ? 0.85 : 0.6); ind = 0; break;
        case 'outreach': outreach[p.owner] += ind; ind = 0; break;
        case 'fortify': p.militia = Math.min(60, (p.militia ?? 0) + ind * 0.03); ind = 0; break;
        default: p.progress = Math.min(p.progress + ind, 200); ind = 0;
      }
    } else {
      p.progress += ind;
      completeItems(w, p);
    }

    // Growth.
    const popMax = ec.popMax;
    if (p.pop > 0) {
      if (p.pop < popMax) {
        p.growth += pro;
        if (p.growth >= ec.growthNeeded) {
          p.growth -= ec.growthNeeded;
          p.pop++;
          w.econCache.delete(p.id);
        }
      } else {
        p.growth = Math.min(p.growth, ec.growthNeeded);
        if (p.pop > popMax && s.day % 10 === 0) {
          p.pop--;
          w.econCache.delete(p.id);
        }
      }
    }

    resTotals[p.owner] += res;
    indTotals[p.owner] += ec.yield.ind;
    proTotals[p.owner] += pro;
    popTotals[p.owner] += p.pop;
  }

  // Logistics: convoys feed planets that are building something, smallest producers first.
  for (const e of s.empires) {
    e.last = { ind: indTotals[e.id], res: resTotals[e.id], pro: proTotals[e.id], pop: popTotals[e.id], logisticsIn: 0 };
    if (e.logistics < 1) continue;
    const needy = w.planetsOf[e.id].map((id) => s.planets[id]).filter((p) => p.queue.length > 0);
    needy.sort((a, b) => w.econ(a).yield.ind - w.econ(b).yield.ind);
    for (const p of needy) {
      if (e.logistics < 1) break;
      const remaining = w.itemCost(p, p.queue[0]) - p.progress;
      const give = Math.min(e.logistics, Math.max(0, remaining), w.econ(p).yield.ind + 6);
      if (give <= 0) continue;
      p.progress += give;
      e.logistics -= give;
      e.last.logisticsIn += give;
      completeItems(w, p);
    }
    e.logistics = Math.min(e.logistics, w.species(e).trait === 'haulers' ? 8000 : 5000);
  }

  // Outreach improves relations monthly.
  if (s.day % 30 === 0) {
    for (const e of s.empires) {
      if (!outreach[e.id]) continue;
      const bonus = Math.min(15, Math.round(outreach[e.id] / 4));
      for (const o of s.empires) {
        if (o.id === e.id || !o.relations[e.id].met) continue;
        addMod(o, e.id, 'Diplomatic outreach', bonus, { decay: 3 });
      }
    }
  }

  for (const e of s.empires) if (e.alive) researchTick(w, e, resTotals[e.id]);
}

/** Fill `Empire.last` without advancing time (new games, loads). */
export function refreshTotals(w: World) {
  for (const e of w.s.empires) e.last = { ind: 0, res: 0, pro: 0, pop: 0, logisticsIn: 0 };
  for (const p of w.s.planets) {
    if (p.owner === null) continue;
    const y = w.econ(p).yield;
    const l = w.s.empires[p.owner].last;
    l.ind += y.ind; l.res += y.res; l.pro += y.pro; l.pop += p.pop;
  }
}

export function addMod(e: Empire, about: EmpireId, reason: string, value: number, opts: { until?: number; decay?: number } = {}) {
  const r = e.relations[about];
  const existing = r.mods.find((m) => m.reason === reason);
  if (existing) {
    existing.value = Math.max(-100, Math.min(100, existing.value + value));
    if (opts.until) existing.until = opts.until;
  } else r.mods.push({ reason, value, ...opts });
}

function completeItems(w: World, p: Planet) {
  let guard = 0;
  while (p.queue.length && guard++ < 4) {
    const item = p.queue[0];
    if (!validItem(w, p, item)) {
      p.queue.shift();
      continue;
    }
    const cost = w.itemCost(p, item);
    if (p.progress < cost) break;
    p.progress -= cost;
    p.queue.shift();
    finishItem(w, p, item);
    w.econCache.delete(p.id);
  }
  if (!p.queue.length) {
    p.progress = Math.min(p.progress, 50);
    if (!p.governor.on && !p.project && p.owner !== null && w.s.empires[p.owner].human) {
      w.event(p.owner, 'idle', `${p.name} has nothing to build.`, { planet: p.id, star: p.star });
    }
  }
}

function validItem(w: World, p: Planet, item: BuildItem): boolean {
  switch (item.kind) {
    case 'building': {
      const def = BUILDING[item.id];
      if (!w.knows(p.owner!, def.tech)) return false;
      if (item.orbital) return item.tile < p.orbitals.length && (!p.orbitals[item.tile] || !!item.replace);
      const t = p.tiles[item.tile];
      return !!t && t.c !== 'black' && (!t.b || !!item.replace);
    }
    case 'ship': return w.econ(p).hasShipyard && !!w.s.designs[item.design];
    case 'automate': {
      const b = item.orbital ? p.orbitals[item.tile] : p.tiles[item.tile]?.b;
      return !!b && !b.auto && w.knows(p.owner!, 'automation');
    }
    case 'terraform': return p.tiles[item.tile]?.c === 'black' && w.knows(p.owner!, 'terraforming');
    case 'demolish': return item.orbital ? !!p.orbitals[item.tile] : !!p.tiles[item.tile]?.b;
    case 'refit': {
      const sh = w.s.ships[item.ship];
      return !!sh && sh.owner === p.owner && w.s.fleets[sh.fleet]?.star === p.star && w.econ(p).hasShipyard && item.slot < sh.parts.length;
    }
    case 'ascension': return w.knows(p.owner!, 'transcendence');
  }
}

function finishItem(w: World, p: Planet, item: BuildItem) {
  const s = w.s;
  const owner = p.owner!;
  const human = s.empires[owner].human;
  switch (item.kind) {
    case 'building': {
      const def = BUILDING[item.id];
      const auto = def.needsWorker && (w.knows(owner, 'selfmod') || w.species(owner).trait === 'synthetic') ? true : undefined;
      const inst = auto ? { id: item.id, auto } : { id: item.id };
      if (item.orbital) p.orbitals[item.tile] = inst;
      else p.tiles[item.tile].b = inst;
      if (item.id === 'excavation') excavate(w, p);
      if (human && (def.role === 'shipyard' || def.unique)) w.event(owner, 'build', `${p.name}: ${def.name} complete.`, { planet: p.id, star: p.star });
      break;
    }
    case 'ship': {
      const d = s.designs[item.design];
      const n = item.count ?? 1;
      for (let i = 0; i < n; i++) spawnShip(w, d, p.star);
      if (human) w.event(owner, 'build', `${p.name}: ${d.name} launched.`, { planet: p.id, star: p.star });
      break;
    }
    case 'automate': {
      const b = item.orbital ? p.orbitals[item.tile] : p.tiles[item.tile].b;
      if (b) b.auto = true;
      break;
    }
    case 'terraform':
      p.tiles[item.tile].c = 'white';
      break;
    case 'demolish':
      if (item.orbital) p.orbitals[item.tile] = null;
      else delete p.tiles[item.tile].b;
      break;
    case 'refit': {
      const sh = s.ships[item.ship];
      const before = w.statsOf(sh).hp;
      sh.parts[item.slot] = item.part;
      const after = w.statsOf(sh).hp;
      sh.hp = Math.max(1, Math.min(after, sh.hp + (after - before)));
      if (human) w.event(owner, 'build', `${sh.name} refit with ${PART[item.part].name}.`, { star: p.star });
      break;
    }
    case 'ascension': {
      s.winner = { empire: owner, kind: 'Ascension', day: s.day };
      w.event(owner, 'victory', `${s.empires[owner].name} has opened the Ascension Gate at ${p.name}.`, { planet: p.id, important: true });
      break;
    }
  }
}

function excavate(w: World, p: Planet) {
  const r = p.ruins;
  const owner = p.owner!;
  const e = w.s.empires[owner];
  if (!r || r.dug) return;
  r.dug = true;
  let text = '';
  switch (r.reward) {
    case 'tech':
      if (r.tech && !w.knows(owner, r.tech)) {
        grantTech(w, e, r.tech);
        text = `recovered the secret of ${TECH[r.tech].name}!`;
      } else {
        e.research.progress += r.value;
        text = `recovered ${r.value} research worth of records.`;
      }
      break;
    case 'industry': e.logistics += r.value; text = `salvaged ${r.value} industry into the logistics pool.`; break;
    case 'research': e.research.progress += r.value; text = `deciphered archives worth ${r.value} research.`; break;
    case 'pop': p.pop += 3; text = 'found survivors in stasis: +3 population.'; break;
    case 'ship': {
      const d: ShipDesign = { id: w.nextId(), owner, name: 'Ancient Derelict', hull: 'large', parts: ['plasma', 'plasma', 'disruptor', 'deflector', 'deflector', 'gravdrive', 'gravdrive', 'hypercore', 'hypercore', 'fusioncore', 'neutronium', 'deepscan'], created: w.s.day, role: 'warship', obsolete: true };
      w.s.designs[d.id] = d;
      spawnShip(w, d, p.star);
      text = 'restored an ancient warship!';
      break;
    }
  }
  w.event(owner, 'discovery', `Excavation on ${p.name} ${text}`, { planet: p.id, star: p.star, important: e.human });
}

// --- research --------------------------------------------------------------

export function availableTechs(w: World, e: EmpireId) {
  const known = w.knownTech[e];
  return TECHS.filter((t) => !known.has(t.id) && t.prereqs.every((p) => known.has(p)));
}

export function grantTech(w: World, e: Empire, tech: string) {
  if (w.knownTech[e.id].has(tech)) return;
  e.research.known.push(tech);
  w.knownTech[e.id].add(tech);
  e.research.queue = e.research.queue.filter((q) => q !== tech);
  if (e.research.current === tech) e.research.current = null;
  w.shipStatsCache.clear();
  w.touch();
  if (TECH[tech].capstone) {
    for (const o of w.s.empires) if (o.id !== e.id && o.relations[e.id].met) {
      w.event(o.id, 'warning', `${e.name} has discovered Transcendence Theory and can now build the Ascension Gate.`, { important: true });
    }
  }
}

const CATEGORY_WEIGHTS: Record<string, Partial<Record<TechCategory, number>>> = {
  expansionist: { biology: 1.4, propulsion: 1.4, industry: 1.1 },
  militarist: { military: 1.8, energy: 1.3, propulsion: 1.1 },
  scientist: { information: 1.6, energy: 1.2, xeno: 1.3 },
  diplomat: { xeno: 1.6, information: 1.3, biology: 1.2 },
  industrialist: { industry: 1.7, energy: 1.2 },
  opportunist: { military: 1.2, industry: 1.2, information: 1.2 },
};

export function pickResearch(w: World, e: Empire): string | null {
  const avail = availableTechs(w, e.id);
  if (!avail.length) return null;
  const wts = CATEGORY_WEIGHTS[e.ai.personality] ?? {};
  let best = avail[0], bestV = -Infinity;
  for (const t of avail) {
    let v = (wts[t.category] ?? 1) * 1000 / t.cost;
    // Key unlocks every empire needs.
    if (['envseal', 'megafab', 'hyperlogic', 'hydroponics', 'automation', 'lanestab', 'kinetics', 'assault', 'supercond', 'deflectors'].includes(t.id)) v *= 1.5;
    if (t.capstone) v *= 3;
    v *= 0.9 + ((t.id.length * 7 + e.id * 13) % 10) / 50;
    if (v > bestV) { bestV = v; best = t; }
  }
  return best.id;
}

function researchTick(w: World, e: Empire, points: number) {
  const r = e.research;
  r.progress += points;
  let guard = 0;
  while (guard++ < 5) {
    if (!r.current || w.knownTech[e.id].has(r.current)) {
      r.current = null;
      while (r.queue.length && !r.current) {
        const next = r.queue.shift()!;
        const t = TECH[next];
        if (!w.knownTech[e.id].has(next) && t.prereqs.every((p) => w.knownTech[e.id].has(p))) r.current = next;
      }
      if (!r.current && (r.auto || e.prefs.autoResearch || !e.human)) r.current = pickResearch(w, e);
      if (!r.current) {
        r.progress = Math.min(r.progress, 2000);
        return;
      }
    }
    const cost = w.techCost(e.id, r.current);
    if (r.progress < cost) return;
    r.progress -= cost;
    const done = r.current;
    r.current = null;
    grantTech(w, e, done);
    if (e.human) w.event(e.id, 'research', `Research complete: ${TECH[done].name}.`, { important: true });
  }
}

export function speciesTrait(w: World, e: EmpireId) {
  return SPECIES_BY_ID[w.s.empires[e].species].trait;
}

import { BUILDING, TERRAFORM_NEXT } from './content';
import type { EmpireId } from './types';
import type { World } from './world';
import { addMod, availableTechs, grantTech } from './economy';
import { foundColony, removeShip, spawnShip } from './fleets';
import { starsWithin } from './visibility';

export type AbilityTarget = { planet?: number; star?: number; fleet?: number; empire?: EmpireId };

export function abilityReady(w: World, e: EmpireId) {
  return w.s.day >= w.s.empires[e].abilityReadyDay;
}

/** Returns an error string, or null if the ability can be used on this target. */
export function abilityCheck(w: World, e: EmpireId, t: AbilityTarget): string | null {
  const s = w.s;
  const sp = w.species(e);
  if (!abilityReady(w, e)) return `Ready on day ${s.empires[e].abilityReadyDay}.`;
  const p = t.planet !== undefined ? s.planets[t.planet] : undefined;
  switch (sp.ability.id) {
    case 'feast': case 'bloom': case 'reshape':
      if (!p || p.owner !== e) return 'Choose one of your planets.';
      if (sp.ability.id === 'bloom' && !p.queue.length) return 'That planet is not building anything.';
      if (sp.ability.id === 'bloom' && p.queue[0].kind === 'ascension') return 'The Ascension Gate cannot be hurried.';
      if (sp.ability.id === 'reshape' && !TERRAFORM_NEXT[p.type]) return 'That world cannot be improved further.';
      if (sp.ability.id === 'feast' && !p.tiles.some((x) => x.c === 'black')) return 'No dead tiles to eat.';
      return null;
    case 'foldjump': {
      const f = t.fleet !== undefined ? s.fleets[t.fleet] : undefined;
      if (!f || f.owner !== e) return 'Choose one of your fleets.';
      if (t.star === undefined || s.empires[e].explored[t.star] < 1) return 'Choose a charted destination star.';
      return null;
    }
    case 'flare':
      if (t.star === undefined || !w.visible[e]?.[t.star]) return 'Choose a star you can currently see.';
      return null;
    case 'accord':
      if (t.empire === undefined || t.empire === e || !s.empires[e].relations[t.empire].met) return 'Choose an empire you have met.';
      return null;
    case 'unravel':
      if (!p || p.owner === null || p.owner === e || w.allied(e, p.owner)) return 'Choose a rival planet.';
      if (!w.visible[e]?.[p.star]) return 'You must be able to see that planet.';
      return null;
    case 'seed':
      if (!p || p.owner !== null || p.type === 'gasgiant') return 'Choose an unclaimed, habitable planet.';
      if (!w.ownerAtStar(p.star).has(e) && !w.fleetsAtStar(p.star).some((f) => f.owner === e)) return 'You need a planet or fleet in that system.';
      return null;
    case 'epiphany':
      if (!s.empires[e].research.current) return 'Choose a research project first.';
      return null;
    case 'omen':
      if (t.star === undefined || s.empires[e].explored[t.star] < 1) return 'Choose a charted star.';
      return null;
    case 'cloudseed':
      if (!p || p.owner !== null || p.type !== 'gasgiant') return 'Choose an unclaimed gas giant.';
      if (s.empires[e].explored[p.star] < 2) return 'You must have surveyed that system.';
      return null;
    case 'infest':
      if (!p || p.owner === null || p.owner === e || w.allied(e, p.owner)) return 'Choose a rival planet.';
      if (!w.visible[e]?.[p.star]) return 'You must be able to see that planet.';
      if (p.pop <= 1) return 'Too few people there to infect.';
      return null;
    case 'recall':
      if (!availableTechs(w, e).length) return 'Nothing left to remember.';
      return null;
    case 'hatch':
      if (s.empires[e].capital === null) return 'You need a capital.';
      return null;
    default:
      return null;
  }
}

export function useAbility(w: World, e: EmpireId, t: AbilityTarget): string | null {
  const err = abilityCheck(w, e, t);
  if (err) return err;
  const s = w.s;
  const emp = s.empires[e];
  const sp = w.species(e);
  const p = t.planet !== undefined ? s.planets[t.planet] : undefined;
  let msg = '';
  switch (sp.ability.id) {
    case 'census':
      emp.explored = emp.explored.map(() => 2);
      msg = 'The Psychic Census charts every star in the galaxy.';
      break;
    case 'feast':
      p!.tiles.forEach((x) => { if (x.c === 'black') x.c = 'white'; });
      msg = `The Grakk devour the dead rock of ${p!.name}.`;
      break;
    case 'foldjump': {
      const f = s.fleets[t.fleet!];
      const arr = w.fleetsAt.get(f.star);
      if (arr) w.fleetsAt.set(f.star, arr.filter((x) => x !== f.id));
      f.lastStar = f.star;
      f.star = t.star!;
      f.route = [];
      f.transit = f.transitTotal = 0;
      (w.fleetsAt.get(f.star) ?? w.fleetsAt.set(f.star, []).get(f.star)!).push(f.id);
      emp.explored[f.star] = 2;
      msg = `${f.name} folds space to ${s.stars[f.star].name}.`;
      break;
    }
    case 'bloom':
      p!.progress = Math.max(p!.progress, Math.min(w.itemCost(p!, p!.queue[0]), p!.progress + 600));
      msg = `The lattice blooms on ${p!.name}.`;
      break;
    case 'brood':
      for (const id of w.planetsOf[e]) {
        const q = s.planets[id];
        if (q.pop > 0) q.pop = Math.min(w.econ(q).popMax, q.pop + 2);
      }
      msg = 'A brood surge swells every colony.';
      break;
    case 'epiphany':
      emp.research.progress += w.techCost(e, emp.research.current!) / 2;
      msg = 'An epiphany! Research leaps forward.';
      break;
    case 'frenzy':
      for (const sh of Object.values(s.ships)) if (sh.owner === e) sh.hp = w.statsOf(sh).hp;
      msg = 'War Frenzy: every ship is restored.';
      break;
    case 'flare': {
      let hits = 0;
      for (const f of w.fleetsAtStar(t.star!)) {
        if (f.owner === e || !w.atWar(e, f.owner)) continue;
        for (const id of [...f.ships]) {
          const sh = s.ships[id];
          sh.hp -= Math.round(w.statsOf(sh).hp * 0.4);
          hits++;
          if (sh.hp <= 0) removeShip(w, id);
        }
      }
      msg = `Solar Flare scorches ${hits} enemy ship${hits === 1 ? '' : 's'} at ${s.stars[t.star!].name}.`;
      break;
    }
    case 'reshape':
      p!.type = TERRAFORM_NEXT[p!.type];
      msg = `${p!.name} is reshaped into a better world.`;
      break;
    case 'accord':
      addMod(s.empires[t.empire!], e, 'Grand Accord', 40, { until: s.day + 360 });
      msg = `The ${s.empires[t.empire!].name} are charmed by a Grand Accord.`;
      break;
    case 'unravel': {
      const built = p!.tiles.map((x, i) => ({ x, i })).filter(({ x }) => x.b && x.b.id !== 'colonybase');
      if (built.length) {
        const pick = w.rng.pick(built);
        const name = BUILDING[pick.x.b!.id].name;
        delete pick.x.b;
        msg = `Nyx agents unravel a ${name} on ${p!.name}.`;
        addMod(s.empires[p!.owner!], e, 'Suspected sabotage', -10, { decay: 2 });
        if (s.empires[p!.owner!].human) w.event(p!.owner!, 'lost', `Saboteurs destroyed a ${name} on ${p!.name}.`, { planet: p!.id });
      } else msg = 'There was nothing worth unravelling.';
      break;
    }
    case 'seed':
      foundColony(w, p!, e, true);
      msg = `Seed pods take root on ${p!.name}.`;
      break;
    case 'omen': {
      const c = s.stars[t.star!];
      let n = 0;
      for (const id of starsWithin(w, c.x, c.y, 700)) { if (emp.explored[id] < 2) n++; emp.explored[id] = 2; }
      msg = `An omen reveals ${n} new system${n === 1 ? '' : 's'} around ${c.name}.`;
      break;
    }
    case 'hatch': {
      const d = Object.values(s.designs).filter((x) => x.owner === e && x.role === 'warship' && !x.obsolete).sort((a, b) => b.created - a.created)[0];
      const star = s.planets[emp.capital!].star;
      if (d) for (let i = 0; i < 3; i++) spawnShip(w, d, star);
      msg = d ? `Three ${d.name}s hatch above your capital.` : 'The hatchlings found no design to grow into.';
      break;
    }
    case 'overclock':
      emp.buffs = { ...emp.buffs, overclock: s.day + 20 };
      msg = 'Every foundry runs at double speed for 20 days.';
      break;
    case 'currents':
      emp.buffs = { ...emp.buffs, currents: s.day + 30 };
      msg = 'Deep currents speed every fleet for 30 days.';
      break;
    case 'cloudseed':
      foundColony(w, p!, e, true);
      msg = `A storm-city forms in the clouds of ${p!.name}.`;
      break;
    case 'recall': {
      const tech = availableTechs(w, e).sort((a, b) => a.cost - b.cost)[0];
      grantTech(w, emp, tech.id);
      msg = `The elders recall the art of ${tech.name}.`;
      break;
    }
    case 'infest':
      p!.pop = Math.max(1, p!.pop - 3);
      addMod(s.empires[p!.owner!], e, 'Spore attack', -15, { decay: 3 });
      if (s.empires[p!.owner!].human) w.event(p!.owner!, 'lost', `A spore blight strikes ${p!.name}: population falls.`, { planet: p!.id });
      msg = `Spores settle over ${p!.name}.`;
      break;
    case 'shellwall':
      for (const id of w.planetsOf[e]) s.planets[id].militia = (s.planets[id].militia ?? 0) + 25;
      msg = 'Every world raises a shell wall: +25 militia.';
      break;
    case 'convergence':
      emp.logistics += 4 * emp.last.ind;
      msg = `Convergence: ${Math.round(4 * emp.last.ind)} industry flows into the logistics pool.`;
      break;
  }
  emp.abilityReadyDay = s.day + sp.ability.cooldown;
  w.touch();
  w.event(e, 'ability', msg, { planet: t.planet, star: t.star ?? p?.star, important: emp.human });
  return null;
}

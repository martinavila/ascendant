import { PLANET_TYPE, TECH, TERRAFORM_NEXT } from '../content';
import type { Empire, EmpireId, Fleet, GovernorFocus, Planet, StarId } from '../types';
import type { World } from '../world';
import { ensureDesign } from './designer';
import { orderMove, mergeFleets, planetDefended, invasionDefense } from '../fleets';
import { threatMap } from '../governor';
import { attitude, declareWar, empirePower, evaluate, propose, sharesBorder } from '../diplomacy';
import { abilityCheck, abilityReady, useAbility, type AbilityTarget } from '../abilities';
import { fleetVisible } from '../visibility';

// A real opponent. The original AI "just sits there"; this one expands,
// builds fleets sized to threats, stages attacks, invades, and negotiates.

const AGGRESSION: Record<string, number> = { militarist: 1.0, opportunist: 0.75, expansionist: 0.55, industrialist: 0.45, scientist: 0.3, diplomat: 0.2 };

export function aiTick(w: World, e: Empire) {
  if (!e.alive) return;
  const s = w.s;
  const slot = (s.day + e.id * 3) % 5;
  if (slot === 0) managePlanets(w, e);
  if (slot === 1) manageProduction(w, e);
  if (slot === 3 && (s.day + e.id) % 10 < 5) manageDiplomacy(w, e);
  manageFleets(w, e);
  if (abilityReady(w, e.id)) tryAbility(w, e);
}

/** Human automation: fleets on "auto-explore" pick the nearest unexplored star. */
export function humanAutomation(w: World, e: Empire) {
  const taken = new Set<StarId>();
  for (const f of Object.values(w.s.fleets)) {
    if (f.owner !== e.id || f.order.kind !== 'explore') continue;
    if (f.route.length) { taken.add(f.route[f.route.length - 1]); continue; }
    const t = nearestUnexplored(w, e, f, taken);
    if (t === null) {
      f.order = { kind: 'none' };
      w.event(e.id, 'idle', `${f.name} has nothing left to explore nearby.`, { fleet: f.id, star: f.star });
      continue;
    }
    taken.add(t);
    orderMove(w, f, t);
  }
}

// --- planets ---------------------------------------------------------------

function managePlanets(w: World, e: Empire) {
  const threat = threatMap(w, e.id);
  for (const pid of w.planetsOf[e.id]) {
    const p = w.s.planets[pid];
    p.governor.on = true;
    p.governor.autoUpgrade = true;
    let focus: GovernorFocus = 'balanced';
    const count = (c: string) => p.tiles.filter((t) => t.c === c).length;
    const red = count('red'), blue = count('blue'), green = count('green');
    if (red >= 5 && red >= blue) focus = 'industry';
    else if (blue >= 5) focus = 'research';
    else if (green >= 6 && p.pop < w.econ(p).popMax - 3) focus = 'growth';
    if (e.capital === p.id) focus = 'balanced';
    if (threat[p.star] > 40 && p.pop >= 4) focus = 'defense';
    p.governor.focus = focus;
  }
}

// --- production ------------------------------------------------------------

interface Wants { colony: number; outpost: number; scout: number; warship: number; invader: number }

function colonyTargets(w: World, e: Empire, kind: 'colonize' | 'outpost') {
  const s = w.s;
  const claimed = new Set<number>();
  for (const f of Object.values(s.fleets)) if (f.owner === e.id && (f.order.kind === 'colonize' || f.order.kind === 'outpost')) claimed.add(f.order.planet);
  const home = e.capital !== null ? s.planets[e.capital].star : null;
  const out: { p: Planet; v: number }[] = [];
  for (const p of s.planets) {
    if (p.owner !== null || claimed.has(p.id) || e.explored[p.star] < 2) continue;
    if (kind === 'colonize' && p.type === 'gasgiant' && w.species(e).trait !== 'drifters') continue;
    // Avoid systems held by others unless we are much stronger.
    const others = [...w.ownerAtStar(p.star)].filter((o) => o !== e.id);
    if (others.some((o) => !w.atWar(e.id, o)) && kind === 'outpost') continue;
    const pt = PLANET_TYPE[p.type];
    let v = kind === 'colonize'
      ? p.tiles.filter((t) => t.c !== 'black').length * pt.popMul * (w.isFavored(p, e.id) ? 1.3 : 1) + p.tiles.filter((t) => t.c === 'red' || t.c === 'blue' || t.c === 'green').length * 0.8
      : 4 + p.orbitals.length;
    if (p.ruins && !p.ruins.dug) v += 8;
    if (others.length) v *= 0.4;
    const d = home !== null ? w.dist(home, p.star) : 0;
    v /= 1 + d / 900;
    out.push({ p, v });
  }
  return out.sort((a, b) => b.v - a.v);
}

function currentCounts(w: World, e: Empire) {
  const s = w.s;
  const c: Wants = { colony: 0, outpost: 0, scout: 0, warship: 0, invader: 0 };
  for (const f of Object.values(s.fleets)) {
    if (f.owner !== e.id) continue;
    for (const id of f.ships) {
      const role = s.designs[s.ships[id].design]?.role;
      if (role && role in c) c[role as keyof Wants]++;
    }
  }
  for (const pid of w.planetsOf[e.id]) for (const q of s.planets[pid].queue) {
    if (q.kind !== 'ship') continue;
    const role = s.designs[q.design]?.role;
    if (role && role in c) c[role as keyof Wants] += q.count ?? 1;
  }
  return c;
}

function militaryStrength(w: World, e: EmpireId) {
  let m = 0;
  for (const f of Object.values(w.s.fleets)) if (f.owner === e) m += w.fleetStrength(f);
  return m;
}

function manageProduction(w: World, e: Empire) {
  const s = w.s;
  const yards = w.planetsOf[e.id].map((id) => s.planets[id]).filter((p) => w.econ(p).hasShipyard);
  if (!yards.length) return;
  const have = currentCounts(w, e);
  const planets = w.planetsOf[e.id].length;
  const unexplored = e.explored.filter((x) => x < 2).length;
  const aggression = AGGRESSION[e.ai.personality] ?? 0.5;
  const targets = colonyTargets(w, e, 'colonize');
  const threat = Math.max(0, ...w.planetsOf[e.id].map((id) => threatMap(w, e.id)[s.planets[id].star]));
  const atWar = s.empires.some((o) => o.alive && w.atWar(e.id, o.id));
  const diffMul = [0.7, 1, 1.25, 1.5][e.ai.difficulty] ?? 1;
  const desiredMil = (e.last.ind * (3 + aggression * 6) + threat * 1.3 + (atWar ? 40 : 0)) * diffMul;
  const mil = militaryStrength(w, e.id);
  const want: Wants = {
    scout: unexplored > 0 && s.day < 400 ? 2 : 0,
    colony: targets.length ? Math.min(targets.length, 1 + Math.floor(planets / 5), 3) : 0,
    outpost: w.knows(e.id, 'survey') && colonyTargets(w, e, 'outpost').length ? 1 : 0,
    warship: mil < desiredMil ? have.warship + 1 : 0,
    invader: atWar && w.knows(e.id, 'assault') && e.ai.target !== undefined ? 4 + Math.floor(planets / 8) : 0,
  };
  const order: (keyof Wants)[] = mil < threat ? ['warship', 'colony', 'invader', 'scout', 'outpost'] : ['colony', 'scout', 'warship', 'invader', 'outpost'];
  // Big yards first.
  yards.sort((a, b) => w.econ(b).yield.ind - w.econ(a).yield.ind);
  let yi = 0;
  for (const role of order) {
    const deficit = want[role] - have[role];
    for (let k = 0; k < deficit && yi < yards.length * 2; k++) {
      const yard = yards[yi % yards.length];
      yi++;
      if (yard.queue.filter((q) => q.kind === 'ship').length >= 2) continue;
      const design = ensureDesign(w, e.id, role);
      const item = { kind: 'ship' as const, design };
      // Urgent military goes to the front of the queue.
      if (role === 'warship' && (threat > mil || atWar)) yard.queue.unshift(item);
      else if (role === 'colony' && yard.queue.length && yard.queue[0].kind === 'building') yard.queue.splice(1, 0, item);
      else yard.queue.push(item);
      have[role]++;
    }
  }
  // Ascension: scientists (and anyone who can) go for the gate at the best planet.
  if (w.knows(e.id, 'transcendence') && !w.planetsOf[e.id].some((id) => s.planets[id].queue.some((q) => q.kind === 'ascension'))) {
    const best = w.planetsOf[e.id].map((id) => s.planets[id]).sort((a, b) => w.econ(b).yield.ind - w.econ(a).yield.ind)[0];
    if (best && s.settings.victory.ascension) best.queue.unshift({ kind: 'ascension' });
  }
}

// --- fleets ------------------------------------------------------------------

function roleOf(w: World, f: Fleet) {
  const s = w.s;
  let war = 0, col = 0, out = 0, inv = 0;
  for (const id of f.ships) {
    const st = w.statsOf(s.ships[id]);
    if (st.colony) col++;
    else if (st.outpost) out++;
    else if (st.invasion) inv++;
    else if (st.attack > 0) war++;
  }
  if (col) return 'colony';
  if (out) return 'outpost';
  if (inv) return 'invader';
  if (war) return 'warship';
  return 'scout';
}

export function manageFleets(w: World, e: Empire) {
  const s = w.s;
  const fleets = Object.values(s.fleets).filter((f) => f.owner === e.id);
  const idle = fleets.filter((f) => !f.route.length && f.transit === 0);
  const scoutTargets = new Set<StarId>();
  for (const f of fleets) if (f.order.kind === 'explore' && f.route.length) scoutTargets.add(f.route[f.route.length - 1]);

  for (const f of idle) {
    if (!s.fleets[f.id]) continue;
    const role = roleOf(w, f);
    if (role === 'scout') {
      const target = nearestUnexplored(w, e, f, scoutTargets);
      if (target !== null) {
        scoutTargets.add(target);
        f.order = { kind: 'explore' };
        orderMove(w, f, target);
      }
    } else if (role === 'colony' || role === 'outpost') {
      if (f.order.kind === 'colonize' || f.order.kind === 'outpost') {
        const p = s.planets[f.order.planet];
        if (p.owner !== null && !(p.owner === e.id && p.pop === 0)) f.order = { kind: 'none' };
        else if (p.star !== f.star) { if (!orderMove(w, f, p.star)) f.order = { kind: 'none' }; }
        continue;
      }
      const kind = role === 'colony' ? 'colonize' : 'outpost';
      const targets = colonyTargets(w, e, kind);
      for (const t of targets.slice(0, 6)) {
        const path = w.route(f.star, t.p.star, { unstable: w.fleetCanUseUnstable(f), speed: w.fleetSpeed(f), avoid: (st) => threatMap(w, e.id)[st] > 25 });
        if (!path) continue;
        f.order = { kind, planet: t.p.id } as any;
        f.route = path;
        break;
      }
    } else if (role === 'invader') {
      handleInvaders(w, e, f);
    }
  }
  if ((s.day + e.id) % 3 === 0) handleWarships(w, e, fleets.filter((f) => s.fleets[f.id] && roleOf(w, f) === 'warship'));
}

function nearestUnexplored(w: World, e: Empire, f: Fleet, taken: Set<StarId>): StarId | null {
  // BFS by hops for cheapness; skip stars other scouts are heading to.
  const unstable = w.fleetCanUseUnstable(f);
  const seen = new Set([f.star]);
  let frontier = [f.star];
  for (let h = 0; h < 30 && frontier.length; h++) {
    const next: StarId[] = [];
    for (const u of frontier) for (const { to, lane } of w.adj[u]) {
      if (seen.has(to) || (w.s.lanes[lane].unstable && !unstable)) continue;
      seen.add(to);
      if (e.explored[to] < 2 && !taken.has(to)) return to;
      next.push(to);
    }
    frontier = next;
  }
  return null;
}

function stagingStar(w: World, e: Empire, target: StarId): StarId | null {
  let best: StarId | null = null, bestD = Infinity;
  for (const pid of w.planetsOf[e.id]) {
    const st = w.s.planets[pid].star;
    const d = w.dist(st, target);
    if (d < bestD) { bestD = d; best = st; }
  }
  return best;
}

function enemyStrengthAt(w: World, e: Empire, star: StarId) {
  let v = 0;
  for (const f of w.fleetsAtStar(star)) if (w.atWar(e.id, f.owner) && fleetVisible(w, e.id, f)) v += w.fleetStrength(f);
  for (const pid of w.s.stars[star].planets) {
    const p = w.s.planets[pid];
    if (p.owner !== null && w.atWar(e.id, p.owner)) v += w.econ(p).defense * 1.2;
  }
  return v;
}

function pickWarTarget(w: World, e: Empire): EmpireId | undefined {
  const enemies = w.s.empires.filter((o) => o.alive && w.atWar(e.id, o.id));
  if (!enemies.length) return undefined;
  if (e.ai.target !== undefined && enemies.some((o) => o.id === e.ai.target)) return e.ai.target;
  // Weakest reachable enemy.
  return enemies.sort((a, b) => empirePower(w, a.id) - empirePower(w, b.id))[0].id;
}

function handleWarships(w: World, e: Empire, war: Fleet[]) {
  const s = w.s;
  if (!war.length) return;
  const threat = threatMap(w, e.id);
  // 1) Merge idle fleets that share a star.
  const byStar = new Map<StarId, Fleet[]>();
  for (const f of war) if (!f.route.length && f.transit === 0) (byStar.get(f.star) ?? byStar.set(f.star, []).get(f.star)!).push(f);
  for (const arr of byStar.values()) for (let i = 1; i < arr.length; i++) mergeFleets(w, arr[0], arr[i]);
  const live = war.filter((f) => s.fleets[f.id]);

  // 2) Damaged fleets go home to repair.
  for (const f of live) {
    let hp = 0, max = 0;
    for (const id of f.ships) { hp += s.ships[id].hp; max += w.statsOf(s.ships[id]).hp; }
    if (hp / max < 0.45 && !f.route.length) {
      const yard = nearestYard(w, e, f.star);
      if (yard !== null && yard !== f.star) { orderMove(w, f, yard); f.stance = 'defensive'; }
    } else if (f.stance === 'defensive' && hp / max > 0.9) f.stance = 'aggressive';
  }

  // 3) Defend threatened planets.
  const endangered = w.planetsOf[e.id].map((id) => s.planets[id]).filter((p) => enemyStrengthAt(w, e, p.star) > 0 || threat[p.star] > 60);
  for (const p of endangered.slice(0, 2)) {
    const avail = live.filter((f) => !f.route.length && f.stance === 'aggressive');
    const need = enemyStrengthAt(w, e, p.star);
    const helper = avail.sort((a, b) => w.dist(a.star, p.star) - w.dist(b.star, p.star)).find((f) => w.fleetStrength(f) > need * 0.8);
    if (helper && helper.star !== p.star) orderMove(w, helper, p.star);
  }

  // 4) Offense.
  e.ai.target = pickWarTarget(w, e);
  if (e.ai.target === undefined) {
    // Peacetime: park fleets at the most threatened border world.
    const border = w.planetsOf[e.id].map((id) => s.planets[id]).sort((a, b) => threat[b.star] - threat[a.star])[0];
    if (border) for (const f of live) if (!f.route.length && f.star !== border.star && w.dist(f.star, border.star) > 1 && f.stance === 'aggressive' && s.day % 30 === e.id % 30) orderMove(w, f, border.star);
    return;
  }
  const targets = w.planetsOf[e.ai.target].map((id) => s.planets[id]).filter((p) => e.explored[p.star] >= 1);
  if (!targets.length) return;
  const main = live.filter((f) => f.stance === 'aggressive').sort((a, b) => w.fleetStrength(b) - w.fleetStrength(a));
  if (!main.length) return;
  const doom = main[0];
  const home = doom.star;
  const target = targets.sort((a, b) => w.dist(home, a.star) - w.dist(home, b.star))[0];
  const staging = stagingStar(w, e, target.star);
  const need = enemyStrengthAt(w, e, target.star) * (1.25 - (AGGRESSION[e.ai.personality] ?? 0.5) * 0.25);
  // Gather reinforcements at the doom stack.
  for (const f of main.slice(1)) if (!f.route.length && f.star !== doom.star && !endangered.some((p) => p.star === f.star)) orderMove(w, f, doom.route.length ? doom.route[doom.route.length - 1] : doom.star);
  if (doom.route.length) return;
  if (w.fleetStrength(doom) >= Math.max(need, 8)) {
    if (doom.star !== target.star) orderMove(w, doom, target.star);
  } else if (staging !== null && doom.star !== staging) orderMove(w, doom, staging);
}

function nearestYard(w: World, e: Empire, from: StarId): StarId | null {
  let best: StarId | null = null, bestD = Infinity;
  for (const pid of w.planetsOf[e.id]) {
    const p = w.s.planets[pid];
    if (!w.econ(p).hasShipyard) continue;
    const d = w.dist(from, p.star);
    if (d < bestD) { bestD = d; best = p.star; }
  }
  return best;
}

function handleInvaders(w: World, e: Empire, f: Fleet) {
  const s = w.s;
  if (e.ai.target === undefined) return;
  // Merge with other invaders sharing this star.
  for (const g of w.fleetsAtStar(f.star)) if (g.id !== f.id && g.owner === e.id && !g.route.length && roleOf(w, g) === 'invader') mergeFleets(w, f, g);
  const troops = f.ships.reduce((a, id) => a + w.statsOf(s.ships[id]).invasion * 12, 0);
  // Targets: undefended enemy worlds where our warships hold orbit.
  const candidates = w.planetsOf[e.ai.target].map((id) => s.planets[id]).filter((p) => !planetDefended(p) && w.fleetsAtStar(p.star).some((g) => g.owner === e.id && w.fleetArmed(g)));
  const t = candidates.filter((p) => troops >= invasionDefense(w, p) * 0.9).sort((a, b) => w.dist(f.star, a.star) - w.dist(f.star, b.star))[0];
  if (t) {
    f.order = { kind: 'invade', planet: t.id };
    if (f.star !== t.star) orderMove(w, f, t.star);
    return;
  }
  // Otherwise follow the main war fleet so troops are on hand when orbit is won.
  const main = Object.values(s.fleets).filter((g) => g.owner === e.id && roleOf(w, g) === 'warship').sort((a, b) => w.fleetStrength(b) - w.fleetStrength(a))[0];
  if (main) {
    const dest = main.route.length ? main.route[main.route.length - 1] : main.star;
    const safe = threatMap(w, e.id)[dest] < w.fleetStrength(main);
    const at = safe ? dest : main.star;
    if (at !== f.star) orderMove(w, f, at);
  }
}

// --- diplomacy ---------------------------------------------------------------

function manageDiplomacy(w: World, e: Empire) {
  const s = w.s;
  const aggression = (AGGRESSION[e.ai.personality] ?? 0.5) + e.ai.difficulty * 0.08;
  const myPower = empirePower(w, e.id);
  const wars = s.empires.filter((o) => o.alive && w.atWar(e.id, o.id)).length;
  for (const o of s.empires) {
    if (o.id === e.id || !o.alive || !e.relations[o.id].met) continue;
    const rel = e.relations[o.id];
    const att = attitude(w, e.id, o.id).total;
    const days = s.day - rel.since;
    const ratio = myPower / Math.max(1, empirePower(w, o.id));
    const recently = rel.lastProposal !== undefined && s.day - rel.lastProposal < 60;
    if (rel.stance === 'war') {
      const wantPeace = (ratio < 0.8 && days > 60) || days > 250 || (att > 10 && days > 90);
      if (wantPeace && !recently) {
        const ev = evaluate(w, { from: e.id, to: o.id, kind: 'peace' });
        if (o.human || ev.accept) propose(w, { from: e.id, to: o.id, kind: 'peace' });
        rel.lastProposal = s.day;
      }
    } else {
      const hostile = att < -20 + aggression * 25;
      const strongEnough = ratio > 1.5 - aggression * 0.4;
      if (rel.stance === 'peace' && hostile && strongEnough && wars === 0 && days > 80 && s.day > 120 && sharesBorder(w, e.id, o.id)) {
        declareWar(w, e.id, o.id);
        e.ai.target = o.id;
        return;
      }
      if (rel.stance === 'peace' && att >= 45 && !recently) {
        rel.lastProposal = s.day;
        if (o.human || evaluate(w, { from: e.id, to: o.id, kind: 'alliance' }).accept) propose(w, { from: e.id, to: o.id, kind: 'alliance' });
      }
      if (rel.stance === 'alliance' && att < -10) propose(w, { from: e.id, to: o.id, kind: 'endAlliance' });
      // Tech trades.
      if (!recently && att > 0 && s.day % 40 < 10) {
        const mine = e.research.known.filter((t) => !w.knows(o.id, t));
        const theirs = o.research.known.filter((t) => !w.knows(e.id, t));
        if (mine.length && theirs.length) {
          const get = theirs.sort((a, b) => TECH[b].cost - TECH[a].cost)[0];
          const give = mine.sort((a, b) => Math.abs(TECH[a].cost - TECH[get].cost) - Math.abs(TECH[b].cost - TECH[get].cost))[0];
          if (TECH[give].cost >= TECH[get].cost * 0.8) {
            rel.lastProposal = s.day;
            propose(w, { from: e.id, to: o.id, kind: 'trade', give, get });
          }
        }
      }
    }
  }
}

// --- abilities -----------------------------------------------------------------

function tryAbility(w: World, e: Empire) {
  const s = w.s;
  const sp = w.species(e);
  const mine = w.planetsOf[e.id].map((id) => s.planets[id]);
  let t: AbilityTarget | null = null;
  switch (sp.ability.id) {
    case 'census': case 'brood': case 'frenzy': case 'recall': case 'hatch': case 'convergence': t = {}; break;
    case 'overclock': if (mine.some((x) => x.queue.length)) t = {}; break;
    case 'currents': case 'shellwall': if (s.empires.some((o) => o.alive && w.atWar(e.id, o.id))) t = {}; break;
    case 'omen': { const st = s.stars.find((x) => e.explored[x.id] === 1); if (st) t = { star: st.id }; break; }
    case 'cloudseed': { const p = s.planets.find((x) => x.owner === null && x.type === 'gasgiant' && e.explored[x.star] === 2); if (p) t = { planet: p.id }; break; }
    case 'infest': { const p = s.planets.filter((x) => x.owner !== null && w.atWar(e.id, x.owner) && w.visible[e.id]?.[x.star] && x.pop > 3).sort((a, b) => b.pop - a.pop)[0]; if (p) t = { planet: p.id }; break; }
    case 'epiphany': if (e.research.current && TECH[e.research.current].cost > 300) t = {}; break;
    case 'feast': { const p = mine.sort((a, b) => b.tiles.filter((x) => x.c === 'black').length - a.tiles.filter((x) => x.c === 'black').length)[0]; if (p) t = { planet: p.id }; break; }
    case 'bloom': { const p = mine.filter((x) => x.queue.length).sort((a, b) => w.itemCost(b, b.queue[0]) - w.itemCost(a, a.queue[0]))[0]; if (p && w.itemCost(p, p.queue[0]) > 90) t = { planet: p.id }; break; }
    case 'reshape': { const p = mine.filter((x) => TERRAFORM_NEXT[x.type] && x.pop > 0).sort((a, b) => b.tiles.length - a.tiles.length)[0]; if (p) t = { planet: p.id }; break; }
    case 'accord': {
      const o = s.empires.filter((x) => x.alive && x.id !== e.id && e.relations[x.id].met && !w.atWar(e.id, x.id)).sort((a, b) => attitude(w, a.id, e.id).total - attitude(w, b.id, e.id).total)[0];
      if (o) t = { empire: o.id };
      break;
    }
    case 'flare': {
      for (const p of mine) {
        if (enemyStrengthAt(w, e, p.star) > 0) { t = { star: p.star }; break; }
      }
      break;
    }
    case 'unravel': {
      const p = s.planets.filter((x) => x.owner !== null && w.atWar(e.id, x.owner) && w.visible[e.id]?.[x.star]).sort((a, b) => b.pop - a.pop)[0];
      if (p) t = { planet: p.id };
      break;
    }
    case 'seed': {
      for (const p of mine) {
        const cand = s.stars[p.star].planets.map((id) => s.planets[id]).find((x) => x.owner === null && x.type !== 'gasgiant');
        if (cand) { t = { planet: cand.id }; break; }
      }
      break;
    }
    case 'foldjump': break; // Used tactically by the player; the AI prefers regular movement.
  }
  if (t && !abilityCheck(w, e.id, t)) useAbility(w, e.id, t);
}

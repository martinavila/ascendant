import { BUILDING } from './content';
import type { BattleFrame, BattleReport, BattleShipSnap, EmpireId, Fleet, Planet, StarId } from './types';
import { MAX_BATTLES, type World } from './world';
import { addMod } from './economy';
import { removeShip, planetDefended } from './fleets';

// Arena geometry. Kept compact so fleets close within 2–3 rounds and a hard round
// cap ends every battle — no enemies fleeing to the map edge to stall for time.
const ARENA_W = 1200, ARENA_H = 800, MAX_ROUNDS = 24;

interface Unit {
  uid: number;
  owner: EmpireId;
  name: string;
  hull: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  shieldMax: number;
  shield: number;
  weapons: { part: string; damage: number; range: number; shots: number }[];
  move: number;
  jammer: boolean;
  tractor: boolean;
  repair: boolean;
  evasive: boolean;
  escaped: boolean;
  dead: boolean;
  shipId?: number;
  planet?: { id: number; slot: number };
  fleet?: number;
}

/** Find and resolve every battle this day. */
export function combatTick(w: World) {
  const s = w.s;
  const stars = new Set<StarId>();
  for (const f of Object.values(s.fleets)) if (f.transit === 0) stars.add(f.star);
  for (const star of stars) {
    const b = battleAt(w, star);
    if (b) resolve(w, star, b.fleets, b.planets);
  }
}

function battleAt(w: World, star: StarId): { fleets: Fleet[]; planets: Planet[] } | null {
  const s = w.s;
  const fleets = w.fleetsAtStar(star).filter((f) => f.transit === 0 && f.ships.length);
  const planets = s.stars[star].planets.map((id) => s.planets[id]).filter((p) => p.owner !== null);
  const owners = new Set<EmpireId>([...fleets.map((f) => f.owner), ...planets.map((p) => p.owner!)]);
  if (owners.size < 2) return null;
  // Does anyone want to start a fight?
  let trigger = false;
  for (const f of fleets) {
    if (!w.fleetArmed(f) || f.stance === 'evasive') continue;
    for (const o of owners) {
      if (!w.atWar(f.owner, o)) continue;
      const enemyShips = fleets.some((g) => g.owner === o);
      const enemyDefended = planets.some((p) => p.owner === o && planetDefended(p));
      if (f.stance === 'aggressive' && (enemyShips || enemyDefended)) trigger = true;
      if (f.stance === 'defensive' && enemyShips && w.ownerAtStar(star).has(f.owner)) trigger = true;
    }
  }
  for (const p of planets) {
    if (!planetDefended(p)) continue;
    if (fleets.some((f) => w.atWar(p.owner!, f.owner) && !(w.fleetCloaked(f) && !detects(w, p.owner!, star)))) trigger = true;
  }
  if (!trigger) {
    // Unopposed armed enemies in orbit besiege undefended planets.
    for (const p of planets) {
      if (fleets.some((f) => w.atWar(p.owner!, f.owner) && w.fleetArmed(f) && f.stance === 'aggressive')) p.besieged = Math.max(p.besieged ?? 0, 3);
    }
    return null;
  }
  return { fleets, planets };
}

function detects(w: World, e: EmpireId, star: StarId) {
  for (const f of w.fleetsAtStar(star)) if (f.owner === e && f.ships.some((id) => w.statsOf(w.s.ships[id]).scan >= 320)) return true;
  return false;
}

function resolve(w: World, star: StarId, fleets: Fleet[], planets: Planet[]) {
  const s = w.s;
  const rng = w.rng;
  const units: Unit[] = [];
  const owners = [...new Set([...fleets.map((f) => f.owner), ...planets.map((p) => p.owner!)])];
  const angleOf = new Map(owners.map((o, i) => [o, (i / owners.length) * Math.PI * 2 + Math.PI]));
  let uid = 1;

  // Evasive fleets try to slip away before the shooting starts.
  const escaped: Fleet[] = [];
  for (const f of fleets) {
    if (f.stance !== 'evasive') continue;
    const hunters = fleets.some((g) => w.atWar(f.owner, g.owner) && w.fleetArmed(g) && g.ships.some((id) => w.statsOf(s.ships[id]).tractor));
    if (!hunters && w.fleetSpeed(f) > 0 && rng.chance(0.55) && f.lastStar !== undefined) escaped.push(f);
  }

  for (const f of fleets) {
    if (escaped.includes(f)) continue;
    const a = angleOf.get(f.owner)!;
    f.ships.forEach((id, k) => {
      const sh = s.ships[id];
      const st = w.statsOf(sh);
      const spread = (k - f.ships.length / 2) * 38;
      units.push({
        uid: uid++, owner: f.owner, name: sh.name, hull: sh.hull,
        x: ARENA_W / 2 + Math.cos(a) * 480 - Math.sin(a) * spread + rng.range(-20, 20),
        y: ARENA_H / 2 + Math.sin(a) * 300 + Math.cos(a) * spread + rng.range(-20, 20),
        hp: sh.hp, maxHp: st.hp, shieldMax: st.shield, shield: st.shield, weapons: st.weapons,
        move: 60 + 45 * Math.min(4, st.speed), jammer: st.jammer, tractor: st.tractor, repair: st.repair,
        evasive: f.stance === 'evasive' || st.attack === 0, escaped: false, dead: false, shipId: id, fleet: f.id,
      });
    });
  }
  for (const p of planets) {
    const shieldBonus = p.orbitals.reduce((a, o) => a + (o ? BUILDING[o.id].defense?.shield ?? 0 : 0), 0);
    const a = angleOf.get(p.owner!)!;
    p.orbitals.forEach((o, slot) => {
      if (!o) return;
      const d = BUILDING[o.id].defense;
      if (!d) return;
      units.push({
        uid: uid++, owner: p.owner!, name: `${p.name} ${BUILDING[o.id].name}`, hull: 'station',
        x: ARENA_W / 2 + Math.cos(a) * 250 + slot * 30 - 60, y: ARENA_H / 2 + Math.sin(a) * 160 + (slot % 2) * 30,
        hp: d.hp, maxHp: d.hp, shieldMax: shieldBonus, shield: shieldBonus,
        weapons: d.damage ? [{ part: o.id, damage: d.damage, range: d.range ?? 300, shots: d.shots ?? 1 }] : [],
        move: 0, jammer: false, tractor: false, repair: false, evasive: false, escaped: false, dead: false, planet: { id: p.id, slot },
      });
    });
  }

  const record = owners.some((o) => s.empires[o].human) || s.settings.spectate;
  const snaps: BattleShipSnap[] = units.map((u) => ({ id: u.uid, owner: u.owner, name: u.name, hull: u.hull, maxHp: u.maxHp, planet: !!u.planet }));
  const frames: BattleFrame[] = [];
  const snapFrame = (shots: BattleFrame['s']) => {
    if (!record) return;
    frames.push({ u: units.filter((u) => !u.dead && !u.escaped).map((u) => [u.uid, Math.round(u.x), Math.round(u.y), Math.round(u.hp), Math.round(u.shield)]), s: shots });
  };
  snapFrame([]);

  const hostile = (a: Unit, b: Unit) => w.atWar(a.owner, b.owner);
  const alive = () => units.filter((u) => !u.dead && !u.escaped);
  const fighting = () => {
    const al = alive();
    return al.some((a) => a.weapons.length && al.some((b) => hostile(a, b)));
  };

  for (let round = 0; round < MAX_ROUNDS && fighting(); round++) {
    const shots: BattleFrame['s'] = [];
    const live = alive();
    for (const u of live) {
      u.shield = u.shieldMax;
      if (u.repair && round % 3 === 2) u.hp = Math.min(u.maxHp, u.hp + u.maxHp * 0.05);
    }
    // Movement.
    for (const u of live) {
      if (u.move === 0) continue;
      const enemies = live.filter((o) => hostile(u, o) && !o.dead);
      if (!enemies.length) continue;
      if (u.evasive) {
        // Run for the edge; tractor beams in range hold it in place.
        const held = enemies.some((o) => o.tractor && dist(o, u) < 320);
        const dx = u.x - ARENA_W / 2, dy = u.y - ARENA_H / 2;
        const len = Math.hypot(dx, dy) || 1;
        if (!held) { u.x += (dx / len) * u.move; u.y += (dy / len) * u.move; }
        if (!held && (u.x < 0 || u.x > ARENA_W || u.y < 0 || u.y > ARENA_H)) u.escaped = true;
        continue;
      }
      const target = pickTarget(u, enemies);
      const pref = u.weapons.length ? Math.min(...u.weapons.map((wp) => wp.range)) * 0.8 : 200;
      const d = dist(u, target);
      const step = Math.min(u.move, Math.abs(d - pref));
      if (Math.abs(d - pref) > 10) {
        const dir = d > pref ? 1 : -1;
        u.x += ((target.x - u.x) / d) * step * dir;
        u.y += ((target.y - u.y) / d) * step * dir;
      }
      u.x = Math.max(10, Math.min(ARENA_W - 10, u.x));
      u.y = Math.max(10, Math.min(ARENA_H - 10, u.y));
    }
    // Fire.
    for (const u of live) {
      if (u.dead) continue;
      for (const wp of u.weapons) {
        for (let k = 0; k < wp.shots; k++) {
          const inRange = live.filter((o) => !o.dead && !o.escaped && hostile(u, o) && dist(u, o) <= wp.range);
          if (!inRange.length) break;
          const t = pickTarget(u, inRange);
          const d = dist(u, t);
          const hit = (0.92 - 0.3 * (d / wp.range)) * (t.jammer ? 0.75 : 1);
          if (!rng.chance(hit)) { shots.push([u.uid, t.uid, 0, wp.part]); continue; }
          let dmg = wp.damage;
          const absorbed = Math.min(t.shield, dmg);
          t.shield -= absorbed;
          dmg -= absorbed;
          t.hp -= dmg;
          shots.push([u.uid, t.uid, Math.round(wp.damage - absorbed), wp.part]);
          if (t.hp <= 0 && !t.dead) {
            t.dead = true;
            if (u.shipId && s.ships[u.shipId]) s.ships[u.shipId].kills++;
          }
        }
      }
    }
    snapFrame(shots);
  }

  // Apply results.
  const losses: Record<number, number> = {};
  for (const u of units) {
    if (u.shipId !== undefined) {
      const sh = s.ships[u.shipId];
      if (!sh) continue;
      if (u.dead) {
        losses[u.owner] = (losses[u.owner] ?? 0) + 1;
        removeShip(w, u.shipId);
      } else sh.hp = Math.max(1, Math.round(u.hp));
    } else if (u.planet && u.dead) {
      const p = s.planets[u.planet.id];
      p.orbitals[u.planet.slot] = null;
      losses[u.owner] = (losses[u.owner] ?? 0) + 1;
      w.econCache.delete(p.id);
    }
  }
  // Escapees (and evasive units that ran off the arena) fall back to where they came from.
  const escapedFleets = new Set<number>([...escaped.map((f) => f.id), ...units.filter((u) => u.escaped && u.fleet).map((u) => u.fleet!)]);
  for (const fid of escapedFleets) {
    const f = s.fleets[fid];
    if (f && f.lastStar !== undefined && f.lastStar !== f.star) f.route = [f.lastStar];
  }

  const survivors = alive();
  const armedOwners = new Set(survivors.filter((u) => u.weapons.length).map((u) => u.owner));
  const winner = armedOwners.size === 1 ? [...armedOwners][0] : null;
  for (const p of planets) {
    if (!planetDefended(p) && survivors.some((u) => u.weapons.length && w.atWar(u.owner, p.owner!))) p.besieged = Math.max(p.besieged ?? 0, 5);
  }
  // Grudges.
  for (const a of owners) for (const b of owners) {
    if (a !== b && w.atWar(a, b) && (losses[a] ?? 0) > 0) addMod(s.empires[a], b, 'Destroyed our forces', -Math.min(20, 4 * (losses[a] ?? 0)), { decay: 3 });
  }

  const starName = s.stars[star].name;
  const parts = owners.map((o) => `${s.empires[o].name} lost ${losses[o] ?? 0}`);
  const summary = `Battle of ${starName}: ${parts.join(', ')}.${winner !== null ? ` ${s.empires[winner].name} holds the field.` : ' Inconclusive.'}`;
  const report: BattleReport = { id: w.nextId(), day: s.day, star, sides: owners, units: snaps, frames, losses, winner, summary };
  s.battles.push(report);
  if (s.battles.length > MAX_BATTLES) s.battles.splice(0, s.battles.length - MAX_BATTLES);
  for (const o of owners) {
    if (s.empires[o].human) w.event(o, 'combat', summary, { star, battle: report.id, important: true });
  }
  w.touch();
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y) || 0.001;
}

function pickTarget(u: Unit, enemies: Unit[]): Unit {
  // Prefer armed targets we can finish, then nearest.
  let best = enemies[0], bestV = -Infinity;
  for (const e of enemies) {
    const d = dist(u, e);
    const threat = e.weapons.reduce((a, w) => a + w.damage * w.shots, 0);
    const v = threat * 2 - e.hp * 0.5 - d * 0.05 + (e.planet ? 5 : 0);
    if (v > bestV) { bestV = v; best = e; }
  }
  return best;
}

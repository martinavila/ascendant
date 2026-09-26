import { describe, expect, it } from 'vitest';
import { newGame, DEFAULT_SETTINGS } from '../src/sim/gen';
import { advanceDay } from '../src/sim/turn';
import { serialize, deserialize } from '../src/sim/save';
import { autoDesign } from '../src/sim/ai/designer';
import { governorCandidates } from '../src/sim/governor';
import { queueBuilding, techPath, researchTowards, moveFleet } from '../src/sim/commands';
import { TECHS, BUILDINGS, PARTS } from '../src/sim/content';
import type { GameSettings } from '../src/sim/types';

const settings = (over: Partial<GameSettings> = {}): GameSettings => ({ ...DEFAULT_SETTINGS, seed: 1234, stars: 80, empires: 4, ...over });

describe('content', () => {
  it('has consistent references', () => {
    const techIds = new Set(TECHS.map((t) => t.id));
    for (const t of TECHS) for (const p of t.prereqs) expect(techIds.has(p), `${t.id} -> ${p}`).toBe(true);
    for (const b of BUILDINGS) if (b.tech) expect(techIds.has(b.tech), b.id).toBe(true);
    for (const p of PARTS) if (p.tech) expect(techIds.has(p.tech), p.id).toBe(true);
  });
  it('tech tree is acyclic and fully reachable', () => {
    const known = new Set<string>();
    let progress = true;
    while (progress) {
      progress = false;
      for (const t of TECHS) if (!known.has(t.id) && t.prereqs.every((p) => known.has(p))) { known.add(t.id); progress = true; }
    }
    expect(known.size).toBe(TECHS.length);
  });
});

describe('galaxy generation', () => {
  for (const shape of ['spiral', 'elliptical', 'ring', 'clusters', 'irregular'] as const) {
    it(`${shape}: connected via stable lanes, homeworlds placed`, () => {
      const w = newGame(settings({ shape, stars: 150, empires: 6 }));
      expect(w.s.stars.length).toBeGreaterThan(140);
      // BFS over stable lanes only.
      const seen = new Set([0]);
      const q = [0];
      while (q.length) {
        const u = q.pop()!;
        for (const { to, lane } of w.adj[u]) if (!w.s.lanes[lane].unstable && !seen.has(to)) { seen.add(to); q.push(to); }
      }
      expect(seen.size).toBe(w.s.stars.length);
      expect(w.s.empires.length).toBe(6);
      for (const e of w.s.empires) expect(e.capital).not.toBeNull();
    });
  }
  it('is deterministic for a seed', () => {
    const a = newGame(settings());
    const b = newGame(settings());
    expect(serialize(a)).toBe(serialize(b));
  });
});

describe('simulation', () => {
  it('replays identically from a save (no save-scumming)', () => {
    const w = newGame(settings({ spectate: true }));
    for (let i = 0; i < 60; i++) advanceDay(w);
    const snapshot = serialize(w);
    const a = deserialize(snapshot);
    const b = deserialize(snapshot);
    for (let i = 0; i < 80; i++) { advanceDay(a); advanceDay(b); }
    expect(serialize(a)).toBe(serialize(b));
  });

  it('runs a long AI game without errors and keeps invariants', () => {
    const w = newGame(settings({ spectate: true, stars: 100, empires: 5 }));
    for (let i = 0; i < 400 && !w.s.winner; i++) advanceDay(w);
    for (const sh of Object.values(w.s.ships)) {
      expect(w.s.fleets[sh.fleet], `ship ${sh.id} fleet`).toBeDefined();
      expect(w.s.fleets[sh.fleet].ships).toContain(sh.id);
    }
    for (const f of Object.values(w.s.fleets)) expect(f.ships.length).toBeGreaterThan(0);
    for (const p of w.s.planets) {
      if (p.owner !== null) expect(w.s.empires[p.owner]).toBeDefined();
      expect(p.pop).toBeGreaterThanOrEqual(0);
    }
    // The AI should have expanded.
    const total = w.s.planets.filter((p) => p.owner !== null).length;
    expect(total).toBeGreaterThan(15);
  });
});

describe('player commands', () => {
  it('queues buildings and validates tiles', () => {
    const w = newGame(settings());
    const human = w.human()!;
    const cap = w.s.planets[human.capital!];
    const black = cap.tiles.findIndex((t) => t.c === 'black');
    if (black >= 0) expect(queueBuilding(w, cap, 'factory', black, false).ok).toBe(false);
    const empty = cap.tiles.findIndex((t) => t.c !== 'black' && !t.b);
    expect(queueBuilding(w, cap, 'factory', empty, false).ok).toBe(true);
    expect(queueBuilding(w, cap, 'lab', empty, false).ok).toBe(false);
  });

  it('research towards a deep tech queues its whole prerequisite chain', () => {
    const w = newGame(settings());
    const e = w.human()!;
    const path = techPath(w, e.id, 'automation');
    expect(path[path.length - 1]).toBe('automation');
    researchTowards(w, e.id, 'automation');
    expect([e.research.current, ...e.research.queue]).toEqual(path);
  });

  it('routes fleets across multiple lanes', () => {
    const w = newGame(settings());
    const e = w.human()!;
    const f = Object.values(w.s.fleets).find((x) => x.owner === e.id)!;
    const far = w.s.stars.reduce((a, b) => (w.dist(f.star, b.id) > w.dist(f.star, a.id) ? b : a));
    const r = moveFleet(w, f, far.id);
    if (r.ok) expect(f.route.length).toBeGreaterThan(1);
  });

  it('governor suggests building on matching colored tiles', () => {
    const w = newGame(settings());
    const e = w.human()!;
    const cap = w.s.planets[e.capital!];
    const c = governorCandidates(w, cap)[0];
    expect(c).toBeDefined();
    expect(c.score).toBeGreaterThan(0);
  });
});

describe('ship designer', () => {
  it('auto designs always have a drive and enough power', () => {
    const w = newGame(settings());
    const e = w.human()!;
    for (const t of TECHS) e.research.known.push(t.id);
    w.reindex();
    for (const role of ['warship', 'colony', 'scout', 'invader', 'outpost'] as const) {
      const d = autoDesign(w, e.id, role);
      const st = w.shipStats(e.id, d.hull, d.parts);
      expect(st.speed, role).toBeGreaterThan(0);
      expect(st.powerUse, role).toBeLessThanOrEqual(st.powerSupply);
    }
  });
});

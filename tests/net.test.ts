import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, newGame } from '../src/sim/gen';
import { serialize } from '../src/sim/save';
import { applyCommand, SYSTEM, type Command } from '../src/sim/cmd';
import { MemoryHub, MemoryTransport } from '../src/net/memory';
import { NetSession, type NetEvent } from '../src/net/lockstep';
import type { World } from '../src/sim/world';
import type { GameSettings } from '../src/sim/types';

const SETTINGS: GameSettings = { ...DEFAULT_SETTINGS, seed: 4242, stars: 60, empires: 4 };

function mkSession(hub: MemoryHub, id: string, host: boolean, species: string) {
  const t = new MemoryTransport(hub, { id, name: id, host });
  const s = new NetSession({
    transport: t, host, room: 'TEST', profile: { name: `${id} Empire`, species, color: '' },
    settings: host ? SETTINGS : undefined, timers: false, tickIntervalMs: 0, budgetMs: Infinity, now: () => 0,
  });
  const events: NetEvent[] = [];
  s.events.on((e) => events.push(e));
  return { s, t, events };
}

async function twoPlayerGame() {
  const hub = new MemoryHub();
  const H = mkSession(hub, 'host', true, 'zurvani');
  const C = mkSession(hub, 'guest', false, SETTINGS.playerSpecies === 'grakk' ? 'zurvani' : 'grakk');
  await H.s.connect();
  await C.s.connect();
  hub.flush();
  C.s.setProfile({}, true);
  hub.flush();
  expect(H.s.lobby.map((p) => p.id)).toEqual(['host', 'guest']);
  expect(H.s.canStart()).toBe(true);
  expect(H.s.startGame()).toBe(true);
  hub.flush();
  return { hub, H, C };
}

/** Pick an idle fleet of `e` and a neighbouring star to send it to. */
function someMove(w: World, e: number, salt: number): Command | null {
  const fleets = Object.values(w.s.fleets).filter((f) => f.owner === e && f.transit === 0 && !f.route.length);
  if (!fleets.length) return null;
  const f = fleets[salt % fleets.length];
  const adj = w.adj[f.star];
  if (!adj.length) return null;
  return { t: 'moveFleet', fleet: f.id, dest: adj[salt % adj.length].to };
}

describe('commands', () => {
  it('only lets a player command their own empire', () => {
    const w = newGame({ ...SETTINGS, players: [{ species: 'zurvani', name: 'A', color: '' }, { species: 'grakk', name: 'B', color: '' }] });
    expect(w.s.empires[0].human && w.s.empires[1].human && !w.s.empires[2].human).toBe(true);
    const theirs = Object.values(w.s.fleets).find((f) => f.owner === 1)!;
    const r = applyCommand(w, 0, { t: 'moveFleet', fleet: theirs.id, dest: w.adj[theirs.star][0].to });
    expect(r.ok).toBe(false);
    const cap = w.s.empires[1].capital!;
    expect(applyCommand(w, 0, { t: 'governor', planet: cap, patch: { on: true } }).ok).toBe(false);
    expect(applyCommand(w, 1, { t: 'governor', planet: cap, patch: { on: true } }).ok).toBe(true);
    expect(applyCommand(w, 0, { t: 'control', empire: 1, human: false }).ok).toBe(false);
    expect(applyCommand(w, SYSTEM, { t: 'control', empire: 1, human: false }).ok).toBe(true);
    expect(w.s.empires[1].human).toBe(false);
  });
});

describe('lockstep multiplayer', () => {
  it('two clients issuing commands stay identical for 200 days', async () => {
    const { hub, H, C } = await twoPlayerGame();
    const hw = H.s.world!, cw = C.s.world!;
    expect(H.s.me).toBe(0);
    expect(C.s.me).toBe(1);
    expect(serialize(hw)).toBe(serialize(cw));
    H.s.requestSpeed(6); // running: commands get the input delay
    hub.flush();
    expect(C.s.speed).toBe(6);

    const researchH = hw.s.empires[0].research, researchC = cw.s.empires[1].research;
    let cmdsOk = 0;
    C.events.length = 0;
    for (let day = 0; day < 200; day++) {
      if (day === 3) { H.s.command({ t: 'researchTowards', tech: 'linguistics' }); C.s.command({ t: 'researchTowards', tech: 'linguistics' }); }
      if (day % 7 === 0) { const m = someMove(hw, 0, day); if (m) H.s.command(m); }
      if (day % 5 === 2) { const m = someMove(cw, 1, day); if (m) C.s.command(m); }
      if (day === 10) C.s.command({ t: 'governor', planet: cw.s.empires[1].capital!, patch: { on: true, focus: 'industry' } });
      if (day === 12) H.s.command({ t: 'pref', key: 'autoResearch', value: true });
      if (day === 20) C.s.command({ t: 'pref', key: 'autoResearch', value: true });
      if (day === 40) { // pause, issue while paused, resume
        H.s.requestSpeed(0);
        hub.flush();
        C.s.command({ t: 'stance', fleet: Object.values(cw.s.fleets).find((f) => f.owner === 1)!.id, stance: 'defensive' });
        hub.flush();
        C.s.requestSpeed(20);
      }
      if (day === 60) C.s.command({ t: 'moveFleet', fleet: Object.values(cw.s.fleets).find((f) => f.owner === 0)!.id, dest: 0 }); // not theirs
      hub.flush();
      H.s.hostAdvance(1);
      hub.flush();
    }
    hub.flush();
    expect(hw.s.day).toBe(201);
    expect(cw.s.day).toBe(hw.s.day);
    expect(serialize(cw)).toBe(serialize(hw));
    // Commands really ran, on both machines.
    expect(hw.s.empires[1].prefs.autoResearch).toBe(true);
    expect(hw.planet(hw.s.empires[1].capital!).governor.focus).toBe('industry');
    expect(researchH.known.includes('linguistics') || researchH.current === 'linguistics').toBe(true);
    expect(researchC.known.includes('linguistics') || researchC.current === 'linguistics').toBe(true);
    const results = C.events.filter((e) => e.kind === 'result') as Extract<NetEvent, { kind: 'result' }>[];
    cmdsOk = results.filter((r) => r.result.ok).length;
    expect(cmdsOk).toBeGreaterThan(20);
    expect(results.some((r) => !r.result.ok && r.cmd.t === 'moveFleet')).toBe(true); // ownership rejected
    expect(C.s.speed).toBe(20);
  });

  it('detects a desync and resynchronizes from a host snapshot', async () => {
    const { hub, H, C } = await twoPlayerGame();
    for (let i = 0; i < 10; i++) { H.s.hostAdvance(1); hub.flush(); }
    const before = C.s.world!;
    // Corrupt the guest's state behind the lockstep layer's back.
    before.s.empires[1].logistics += 777;
    before.s.planets[before.s.empires[1].capital!].pop += 2;
    for (let i = 0; i < 20; i++) { H.s.hostAdvance(1); hub.flush(); }
    expect(H.s.world!.s.day).toBe(31);
    await H.s.settle();
    hub.flush();
    await C.s.settle();
    expect(H.events.some((e) => e.kind === 'toast' && e.text.includes('Desync'))).toBe(true);
    expect(C.events.some((e) => e.kind === 'world' && e.reason === 'desync')).toBe(true);
    const after = C.s.world!;
    expect(after).not.toBe(before);
    expect(after.me).toBe(1);
    expect(serialize(after)).toBe(serialize(H.s.world!));
    // And it stays in sync afterwards, with commands.
    for (let i = 0; i < 40; i++) {
      if (i === 5) C.s.command({ t: 'researchTowards', tech: 'linguistics' });
      H.s.hostAdvance(1);
      hub.flush();
    }
    expect(serialize(C.s.world!)).toBe(serialize(H.s.world!));
    expect(H.s.roster.length === 0 || H.s.roster.every((r) => r.sync === 'ok')).toBe(true);
  });

  it('hands a disconnected seat to the AI and back on rejoin', async () => {
    const { hub, H, C } = await twoPlayerGame();
    for (let i = 0; i < 5; i++) { H.s.hostAdvance(1); hub.flush(); }
    C.t.leave();
    hub.flush();
    for (let i = 0; i < 3; i++) { H.s.hostAdvance(1); hub.flush(); }
    expect(H.s.world!.s.empires[1].human).toBe(false);
    // Rejoin with the same client id (a page reload).
    const R = mkSession(hub, 'guest', false, 'grakk');
    await R.s.connect();
    hub.flush();
    await H.s.settle();
    hub.flush();
    await R.s.settle();
    hub.flush();
    expect(R.s.world).not.toBeNull();
    expect(R.s.me).toBe(1);
    for (let i = 0; i < 5; i++) { H.s.hostAdvance(1); hub.flush(); }
    expect(H.s.world!.s.empires[1].human).toBe(true);
    expect(serialize(R.s.world!)).toBe(serialize(H.s.world!));
  });

  it('ends the session for everyone when the host leaves', async () => {
    const { hub, H, C } = await twoPlayerGame();
    H.s.leave();
    hub.flush();
    expect(C.s.phase).toBe('ended');
    expect(C.events.some((e) => e.kind === 'ended')).toBe(true);
    expect(C.s.world).not.toBeNull(); // the game is kept locally
  });
});

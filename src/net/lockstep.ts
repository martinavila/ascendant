// Deterministic lockstep multiplayer.
//
// Every client runs the same simulation; only player commands travel over the
// network. The host (room creator) owns the clock and the game settings:
//
//   player --cmd--> host        host stamps each command with an execution day
//   host --exec--> everyone     (currentDay + inputDelay, or currentDay while
//                               paused) and a global sequence number
//   host --tick--> everyone     "you may advance up to day D; every command
//                               stamped before D has seq <= S"
//
// A client applies all commands stamped for its current day (in seq order)
// before advancing past that day, and never advances beyond the last tick —
// so every client executes the same inputs at the same simulated moment.
//
// Every `hashEvery` days all clients hash the serialized state and report it;
// on mismatch the host sends that client a compressed snapshot to load
// (automatic resync). Late joiners and reconnecting players get a snapshot
// too. A seat whose player disconnects is handed to the AI until they rejoin.
// If the host leaves, the session ends and each client keeps the game locally.
//
// This module is DOM-free (timers are opt-in) so tests can drive it directly.

import type { EmpireId, GameSettings, PlayerSeat } from '../sim/types';
import type { World } from '../sim/world';
import { newGame } from '../sim/gen';
import { advanceDay } from '../sim/turn';
import { serialize, deserialize } from '../sim/save';
import { visibilityTick } from '../sim/visibility';
import { applyCommand, SYSTEM, type CmdResult, type Command } from '../sim/cmd';
import { Emitter, type Envelope, type PeerMeta, type Transport } from './transport';

export interface Profile { name: string; species: string; color: string }
export interface LobbyPlayer extends Profile { id: string; ready: boolean; host: boolean }
export interface RosterEntry {
  id: string; name: string; color: string; seat: EmpireId | null; host: boolean;
  connected: boolean; ping: number | null; day: number; sync: 'ok' | 'desync';
}
export interface ChatLine { id: number; from: string; name: string; color: string; text: string; system?: boolean }
export type Phase = 'connecting' | 'lobby' | 'game' | 'ended';

interface Exec { seq: number; day: number; empire: EmpireId; cmd: Command; origin: string | null; cid: number }
interface SnapMeta { seq: number; allowed: number; speed: number; seats: Record<string, EmpireId>; reason: 'join' | 'desync' | 'request'; enc: 'gzip' | 'json' }

export type Msg =
  | { k: 'hello'; profile: Profile; ready: boolean }
  | { k: 'lobby'; players: LobbyPlayer[]; settings: GameSettings | null }
  | { k: 'start'; settings: GameSettings; seats: Record<string, EmpireId> }
  | { k: 'cmd'; cid: number; cmd: Command }
  | ({ k: 'exec' } & Exec)
  | { k: 'tick'; day: number; seq: number }
  | { k: 'speed'; speed: number; by: string }
  | { k: 'speedReq'; speed: number }
  | { k: 'stepReq'; days: number }
  | { k: 'hash'; day: number; hash: string }
  | { k: 'snapReq' }
  | { k: 'snap'; id: string; i: number; n: number; data: string; meta: SnapMeta }
  | { k: 'ping'; t: number; day: number; rtt: number | null }
  | { k: 'pong'; t: number }
  | { k: 'roster'; players: RosterEntry[] }
  | { k: 'chat'; name: string; color: string; text: string }
  | { k: 'end'; reason: string };

export type NetEvent =
  /** A world was created (game start / first snapshot) or replaced (resync). */
  | { kind: 'world'; world: World; reason: 'start' | 'join' | 'desync' | 'request' }
  /** The world advanced one day. `lastEventId` = newest event id before the advance. */
  | { kind: 'day'; world: World; lastEventId: number }
  /** A command this client sent has been executed. */
  | { kind: 'result'; cid: number; cmd: Command; result: CmdResult }
  | { kind: 'toast'; text: string; level: 'info' | 'error' }
  | { kind: 'ended'; reason: string };

export interface SessionOptions {
  transport: Transport;
  host: boolean;
  room: string;
  profile: Profile;
  /** Host only: the game settings chosen in the New Game screen. */
  settings?: GameSettings;
  /** Days between a command being stamped and executed while time runs. */
  inputDelay?: number;
  /** Compare state hashes every N days. */
  hashEvery?: number;
  /** Host: minimum ms between tick broadcasts (ticks are cumulative). */
  tickIntervalMs?: number;
  /** Host: stop advancing if a connected player falls this many days behind. */
  maxLag?: number;
  /** Start ping/roster timers (off in tests). */
  timers?: boolean;
  /** Max ms a client spends catching up per slice before yielding. */
  budgetMs?: number;
  now?: () => number;
}

const SNAP_CHUNK = 60_000;

export class NetSession {
  readonly transport: Transport;
  readonly isHost: boolean;
  readonly room: string;
  readonly self: PeerMeta;
  profile: Profile;
  ready = false;

  phase: Phase = 'connecting';
  lobby: LobbyPlayer[] = [];
  settings: GameSettings | null = null;
  world: World | null = null;
  /** Local player's empire, or null when spectating. */
  me: EmpireId | null = null;
  seats: Record<string, EmpireId> = {};
  roster: RosterEntry[] = [];
  chat: ChatLine[] = [];
  /** Days per second; 0 = paused. Authoritative on the host, mirrored on clients. */
  speed = 0;
  hostId: string | null = null;
  endReason = '';
  /** Round-trip time to the host in ms (clients). */
  rtt: number | null = null;
  /** True while this client waits for a snapshot from the host. */
  awaitingSnapshot = false;
  /** Host: why time is currently held back (a lagging player), for the UI. */
  holdReason: string | null = null;

  readonly changed = new Emitter<void>();
  readonly events = new Emitter<NetEvent>();

  // --- lockstep state ---------------------------------------------------------
  private log = new Map<number, Exec>();
  private nextSeq = 1;
  private allowed = 1;
  private tickSeq = 0;
  // host
  private seq = 0;
  private lastStamp = 0;
  private lastTickSent = -Infinity;
  private sentTick = { day: 0, seq: 0 };
  private hashes = new Map<number, string>();
  private peerInfo = new Map<string, { ping: number | null; day: number; sync: 'ok' | 'desync' }>();
  private synced = new Set<string>();
  private acc = 0;
  // client
  private cid = 0;
  private snaps = new Map<string, string[]>();
  private stalledSince: number | null = null;
  private pumpScheduled = false;

  private connected = new Set<string>();
  private everSawHost = false;
  private chatId = 0;
  private busy = new Set<Promise<unknown>>();
  private timersOn: ReturnType<typeof setInterval>[] = [];
  private unsub: (() => void)[] = [];
  private readonly inputDelay: number;
  private readonly hashEvery: number;
  private readonly tickIntervalMs: number;
  private readonly maxLag: number;
  private readonly budgetMs: number;
  private readonly now: () => number;

  constructor(private opts: SessionOptions) {
    this.transport = opts.transport;
    this.isHost = opts.host;
    this.room = opts.room;
    this.self = opts.transport.self;
    this.profile = opts.profile;
    this.settings = opts.settings ?? null;
    this.inputDelay = opts.inputDelay ?? 2;
    this.hashEvery = opts.hashEvery ?? 25;
    this.tickIntervalMs = opts.tickIntervalMs ?? 150;
    this.maxLag = opts.maxLag ?? 90;
    this.budgetMs = opts.budgetMs ?? 24;
    this.now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    if (this.isHost) {
      this.hostId = this.self.id;
      this.ready = true;
    }
  }

  // ===========================================================================
  // lifecycle
  // ===========================================================================

  async connect() {
    this.unsub.push(this.transport.onMessage((env) => this.recv(env as Envelope<Msg>)));
    this.unsub.push(this.transport.onPresence((peers) => this.onPresence(peers)));
    await this.transport.join(this.room);
    this.phase = 'lobby';
    if (this.isHost) {
      this.lobby = [{ id: this.self.id, ...this.profile, ready: true, host: true }];
      this.broadcastLobby();
    } else this.sendHello();
    if (this.opts.timers !== false) {
      this.timersOn.push(setInterval(() => this.heartbeat(), 1000));
    }
    this.emitChange();
  }

  /** Leave the room. The host ends the session for everyone. */
  leave(reason = 'You left the game.') {
    if (this.isHost && this.phase !== 'ended') this.send({ k: 'end', reason: 'The host ended the session.' });
    this.shutdown(reason, false);
  }

  private shutdown(reason: string, notify: boolean) {
    if (this.phase === 'ended') return;
    this.phase = 'ended';
    this.endReason = reason;
    this.speed = 0;
    for (const t of this.timersOn) clearInterval(t);
    this.timersOn = [];
    for (const u of this.unsub) u();
    this.unsub = [];
    this.transport.leave();
    if (notify) this.events.emit({ kind: 'ended', reason });
    this.emitChange();
  }

  /** Resolves once async work (snapshot compression) has finished. For tests. */
  async settle() {
    while (this.busy.size) await Promise.all([...this.busy]);
  }

  // ===========================================================================
  // lobby
  // ===========================================================================

  setProfile(p: Partial<Profile>, ready?: boolean) {
    this.profile = { ...this.profile, ...p };
    if (ready !== undefined) this.ready = ready;
    if (this.isHost) {
      const me = this.lobby.find((x) => x.id === this.self.id);
      if (me) Object.assign(me, this.profile);
      this.broadcastLobby();
    } else this.sendHello();
    this.emitChange();
  }

  /** Host: change the game settings shown in the lobby. */
  setSettings(s: GameSettings) {
    if (!this.isHost) return;
    this.settings = s;
    this.broadcastLobby();
  }

  canStart() {
    return this.isHost && this.phase === 'lobby' && !!this.settings && this.lobby.every((p) => p.ready);
  }

  /** Host: generate the galaxy on every client and begin. */
  startGame() {
    if (!this.canStart()) return false;
    const players: PlayerSeat[] = this.lobby.map((p) => ({ species: p.species, name: p.name, color: p.color }));
    const settings: GameSettings = { ...this.settings!, players, empires: Math.max(this.settings!.empires, players.length), spectate: false };
    const seats: Record<string, EmpireId> = {};
    this.lobby.forEach((p, i) => { seats[p.id] = i; });
    this.send({ k: 'start', settings, seats });
    for (const p of this.lobby) this.synced.add(p.id);
    this.beginGame(settings, seats);
    return true;
  }

  private beginGame(settings: GameSettings, seats: Record<string, EmpireId>) {
    const w = newGame(settings);
    visibilityTick(w);
    this.settings = settings;
    this.seats = seats;
    this.installWorld(w, 1, 0);
    this.phase = 'game';
    this.events.emit({ kind: 'world', world: w, reason: 'start' });
    this.emitChange();
  }

  private installWorld(w: World, allowed: number, appliedSeq: number) {
    this.me = this.seats[this.self.id] ?? null;
    w.me = this.me;
    this.world = w;
    this.allowed = Math.max(allowed, w.s.day);
    this.nextSeq = appliedSeq + 1;
    for (const s of [...this.log.keys()]) if (s <= appliedSeq) this.log.delete(s);
  }

  // ===========================================================================
  // commands & time (public API used by the store)
  // ===========================================================================

  /** Send a command for the local player. Returns a local id matched by the 'result' event. */
  command(cmd: Command): number {
    const cid = ++this.cid;
    if (this.phase !== 'game') return cid;
    if (this.isHost) this.hostStamp(this.self.id, cid, cmd);
    else this.send({ k: 'cmd', cid, cmd });
    return cid;
  }

  requestSpeed(speed: number) {
    if (this.isHost) this.setSpeed(speed, this.profile.name);
    else this.send({ k: 'speedReq', speed });
  }

  requestStep(days = 1) {
    if (this.isHost) { if (!this.speed) this.hostAdvance(days); }
    else this.send({ k: 'stepReq', days });
  }

  sendChat(text: string) {
    text = text.trim().slice(0, 400);
    if (!text) return;
    const color = this.world && this.me !== null ? this.world.s.empires[this.me].color : this.profile.color;
    this.send({ k: 'chat', name: this.profile.name, color, text });
    this.addChat({ from: this.self.id, name: this.profile.name, color, text });
  }

  /**
   * Host clock: call every frame with elapsed seconds; advances at `speed`
   * days per second. Returns the number of days advanced.
   */
  hostFrame(dtSec: number, budgetMs = 30): number {
    if (!this.isHost || !this.speed || !this.world) return 0;
    this.acc = Math.min(this.acc + dtSec * this.speed, Math.max(3, this.speed));
    const t0 = this.now();
    let n = 0;
    while (this.acc >= 1 && this.now() - t0 < budgetMs) {
      if (!this.hostAdvance(1)) { this.acc = 0; break; }
      this.acc -= 1;
      n++;
    }
    this.flushTick(false);
    return n;
  }

  /** Host: advance `days` days (sending ticks). Returns false if held back. */
  hostAdvance(days = 1): boolean {
    const w = this.world;
    if (!this.isHost || !w || this.phase !== 'game') return false;
    for (let i = 0; i < days; i++) {
      if (w.s.winner) { if (this.speed) this.setSpeed(0, ''); return false; }
      const lag = this.laggard();
      if (lag) {
        this.holdReason = `Waiting for ${lag}…`;
        this.emitChange();
        return false;
      }
      this.holdReason = null;
      this.allowed = w.s.day + 1;
      this.pump(Infinity);
    }
    this.flushTick(!this.speed);
    return true;
  }

  // ===========================================================================
  // host internals
  // ===========================================================================

  private hostStamp(origin: string | null, cid: number, cmd: Command, empireOverride?: EmpireId) {
    const w = this.world;
    if (!w) return;
    const empire = empireOverride ?? (origin ? this.seats[origin] : undefined);
    if (empire === undefined) {
      if (origin && origin !== this.self.id) this.send({ k: 'exec', seq: 0, day: 0, empire: -2, cmd, origin, cid }, origin); // rejected: spectator
      return;
    }
    const want = this.speed ? w.s.day + this.inputDelay : w.s.day;
    const day = Math.max(this.lastStamp, want);
    this.lastStamp = day;
    const ex: Exec = { seq: ++this.seq, day, empire, cmd, origin, cid };
    this.send({ k: 'exec', ...ex });
    this.onExec(ex);
  }

  /** Issue a command on behalf of the session (AI takeover etc.). */
  private hostSystem(cmd: Command) {
    this.hostStamp(null, 0, cmd, SYSTEM);
  }

  private setSpeed(speed: number, by: string) {
    if (!this.isHost) return;
    speed = Math.max(0, Math.min(60, speed));
    if (this.world?.s.winner) speed = 0;
    if (speed === this.speed) return;
    const was = this.speed;
    this.speed = speed;
    this.acc = speed ? 1 : 0;
    this.send({ k: 'speed', speed, by });
    this.onSpeed(speed, by, was);
    if (!speed) this.flushTick(true);
  }

  private onSpeed(speed: number, by: string, was: number) {
    if (by && (!speed || !was)) this.addChat({ from: '', name: '', color: '', text: `${by} ${speed ? 'resumed' : 'paused'} the game.`, system: true });
    this.emitChange();
  }

  private flushTick(force: boolean) {
    if (!this.isHost || !this.world) return;
    const t = this.now();
    if (this.sentTick.day === this.allowed && this.sentTick.seq === this.seq) return;
    if (!force && t - this.lastTickSent < this.tickIntervalMs) return;
    this.lastTickSent = t;
    this.sentTick = { day: this.allowed, seq: this.seq };
    this.send({ k: 'tick', day: this.allowed, seq: this.seq });
  }

  /** Name of a connected player who is too far behind, if any. */
  private laggard(): string | null {
    if (!this.world) return null;
    for (const [id, seat] of Object.entries(this.seats)) {
      if (id === this.self.id || !this.connected.has(id) || !this.synced.has(id)) continue;
      const info = this.peerInfo.get(id);
      if (info && this.world.s.day - info.day > this.maxLag) return this.world.s.empires[seat]?.name ?? 'a player';
    }
    return null;
  }

  private async sendSnapshot(to: string | undefined, reason: SnapMeta['reason']) {
    const w = this.world;
    if (!w) return;
    const json = serialize(w);
    const meta: Omit<SnapMeta, 'enc'> = { seq: this.nextSeq - 1, allowed: this.allowed, speed: this.speed, seats: { ...this.seats }, reason };
    const job = (async () => {
      const { data, enc } = await pack(json);
      const id = Math.floor(Math.random() * 1e9).toString(36) + (to ?? 'all');
      const n = Math.max(1, Math.ceil(data.length / SNAP_CHUNK));
      for (let i = 0; i < n; i++) this.send({ k: 'snap', id, i, n, data: data.slice(i * SNAP_CHUNK, (i + 1) * SNAP_CHUNK), meta: { ...meta, enc } }, to);
    })();
    this.busy.add(job);
    try { await job; } finally { this.busy.delete(job); }
  }

  // ===========================================================================
  // lockstep core (host and clients)
  // ===========================================================================

  private onExec(ex: Exec) {
    if (ex.seq < this.nextSeq) return; // already applied (or covered by a snapshot)
    this.log.set(ex.seq, ex);
    this.schedulePump();
  }

  private schedulePump() {
    if (this.isHost) { this.pump(Infinity); return; }
    this.pump(this.budgetMs);
  }

  /** Apply due commands and advance as far as ticks allow (bounded by a time budget). */
  pump(budgetMs = this.budgetMs) {
    const w = this.world;
    if (!w || this.phase !== 'game' || this.awaitingSnapshot) return;
    const t0 = this.now();
    let dirty = false;
    for (;;) {
      dirty = this.applyDue(w) || dirty;
      if (w.s.day >= this.allowed || w.s.winner) break;
      // Every command stamped for today must be in hand before leaving today.
      if (this.nextSeq <= this.tickSeq && !this.log.has(this.nextSeq)) {
        this.stalledSince ??= Date.now();
        break;
      }
      this.stalledSince = null;
      const lastEventId = w.s.events.length ? w.s.events[w.s.events.length - 1].id : 0;
      advanceDay(w);
      dirty = true;
      if (w.s.day % this.hashEvery === 0) this.recordHash(w);
      this.events.emit({ kind: 'day', world: w, lastEventId });
      if (this.now() - t0 > budgetMs) {
        this.applyDue(w);
        if (!this.pumpScheduled) {
          this.pumpScheduled = true;
          setTimeout(() => { this.pumpScheduled = false; this.pump(); }, 0);
        }
        break;
      }
    }
    // Keep a short history so a snapshot can rewind the pointer.
    for (const s of this.log.keys()) if (s < this.nextSeq - 2000) this.log.delete(s); else break;
    if (dirty) this.emitChange();
  }

  private applyDue(w: World): boolean {
    let any = false;
    for (;;) {
      const ex = this.log.get(this.nextSeq);
      if (!ex || ex.day > w.s.day) return any;
      if (ex.day < w.s.day) console.warn(`[net] command #${ex.seq} for day ${ex.day} applied late on day ${w.s.day}`);
      const result = applyCommand(w, ex.empire, ex.cmd);
      this.nextSeq++;
      any = true;
      if (ex.origin === this.self.id) this.events.emit({ kind: 'result', cid: ex.cid, cmd: ex.cmd, result });
      if (ex.cmd.t === 'control') {
        const who = w.s.empires[ex.cmd.empire];
        if (who) this.addChat({ from: '', name: '', color: '', text: ex.cmd.human ? `${who.name} is back in human hands.` : `${who.name} is now run by the AI.`, system: true });
      }
    }
  }

  private recordHash(w: World) {
    const h = hashString(serialize(w));
    if (this.isHost) {
      this.hashes.set(w.s.day, h);
      for (const d of this.hashes.keys()) if (d < w.s.day - this.hashEvery * 12) this.hashes.delete(d);
    } else this.send({ k: 'hash', day: w.s.day, hash: h });
  }

  private async loadSnapshot(meta: SnapMeta, data: string) {
    const json = await unpack(data, meta.enc);
    const w = deserialize(json);
    this.seats = meta.seats;
    this.installWorld(w, Math.max(meta.allowed, this.allowed), meta.seq);
    this.speed = meta.speed;
    this.awaitingSnapshot = false;
    this.stalledSince = null;
    this.phase = 'game';
    if (meta.reason === 'desync') this.events.emit({ kind: 'toast', text: 'Desync detected — resynchronized with the host.', level: 'error' });
    this.events.emit({ kind: 'world', world: w, reason: meta.reason });
    this.pump();
    this.emitChange();
  }

  // ===========================================================================
  // messaging
  // ===========================================================================

  private send(msg: Msg, to?: string) {
    if (this.phase === 'ended') return;
    this.transport.send(to ? { to, msg } : { msg });
  }

  private sendHello() {
    this.send({ k: 'hello', profile: this.profile, ready: this.ready });
  }

  private broadcastLobby() {
    this.send({ k: 'lobby', players: this.lobby, settings: this.settings });
    this.emitChange();
  }

  private recv(env: Envelope<Msg>) {
    const m = env.msg;
    const from = env.from;
    if (!m || typeof m !== 'object') return;
    if (this.isHost) this.recvHost(from, m);
    else this.recvClient(from, m);
    // Shared.
    if (m.k === 'chat') this.addChat({ from, name: String(m.name).slice(0, 40), color: m.color, text: String(m.text).slice(0, 400) });
  }

  private recvHost(from: string, m: Msg) {
    switch (m.k) {
      case 'hello': {
        this.connected.add(from);
        if (this.phase === 'lobby') {
          const p = this.lobby.find((x) => x.id === from);
          if (p) Object.assign(p, m.profile, { ready: m.ready });
          else if (this.lobby.length < 16) this.lobby.push({ id: from, ...m.profile, ready: m.ready, host: false });
          this.broadcastLobby();
        } else if (this.phase === 'game') {
          if (!this.synced.has(from)) {
            this.synced.add(from);
            const seat = this.seats[from];
            this.peerInfo.set(from, { ping: null, day: this.world?.s.day ?? 0, sync: 'ok' });
            this.addChat({ from: '', name: '', color: '', text: `${m.profile.name} ${seat !== undefined ? 'rejoined' : 'joined as a spectator'}.`, system: true });
            void this.sendSnapshot(from, 'join');
            if (seat !== undefined && this.world && !this.world.s.empires[seat].human) this.hostSystem({ t: 'control', empire: seat, human: true });
          }
        }
        break;
      }
      case 'cmd':
        if (this.phase === 'game') this.hostStamp(from, m.cid, m.cmd);
        break;
      case 'speedReq':
        if (this.seats[from] !== undefined) this.setSpeed(m.speed, this.nameOf(from));
        break;
      case 'stepReq':
        if (this.seats[from] !== undefined && !this.speed) this.hostAdvance(Math.max(1, Math.min(30, m.days | 0)));
        break;
      case 'hash': {
        const mine = this.hashes.get(m.day);
        const info = this.peerInfo.get(from);
        if (mine === undefined) break;
        if (mine !== m.hash) {
          if (info) info.sync = 'desync';
          this.events.emit({ kind: 'toast', text: `Desync with ${this.nameOf(from)} on day ${m.day} — resynchronizing.`, level: 'error' });
          void this.sendSnapshot(from, 'desync');
        } else if (info) info.sync = 'ok';
        this.emitChange();
        break;
      }
      case 'snapReq':
        void this.sendSnapshot(from, 'request');
        break;
      case 'ping': {
        this.send({ k: 'pong', t: m.t }, from);
        // Pings come only from clients that hold a world: if presence briefly
        // dropped them, hand their seat back without a full snapshot.
        if (this.phase === 'game' && !this.synced.has(from)) {
          this.synced.add(from);
          const seat = this.seats[from];
          if (seat !== undefined && this.world && !this.world.s.empires[seat].human) this.hostSystem({ t: 'control', empire: seat, human: true });
        }
        const info = this.peerInfo.get(from) ?? { ping: null, day: 0, sync: 'ok' as const };
        info.ping = m.rtt;
        info.day = m.day;
        this.peerInfo.set(from, info);
        break;
      }
    }
  }

  private recvClient(from: string, m: Msg) {
    switch (m.k) {
      case 'lobby':
        this.hostId = from;
        this.everSawHost = true;
        this.lobby = m.players;
        this.settings = m.settings;
        if (!m.players.some((p) => p.id === this.self.id) && this.phase === 'lobby') this.sendHello();
        this.emitChange();
        break;
      case 'start':
        this.hostId = from;
        if (this.phase === 'lobby') this.beginGame(m.settings, m.seats);
        break;
      case 'exec':
        if (m.empire === -2) { this.events.emit({ kind: 'toast', text: 'Spectators cannot give orders.', level: 'error' }); break; }
        this.onExec({ seq: m.seq, day: m.day, empire: m.empire, cmd: m.cmd, origin: m.origin, cid: m.cid });
        break;
      case 'tick':
        if (m.day > this.allowed) this.allowed = m.day;
        if (m.seq > this.tickSeq) this.tickSeq = m.seq;
        this.pump();
        break;
      case 'speed': {
        const was = this.speed;
        this.speed = m.speed;
        this.onSpeed(m.speed, m.by, was);
        break;
      }
      case 'snap': {
        let parts = this.snaps.get(m.id);
        if (!parts) this.snaps.set(m.id, (parts = new Array(m.n)));
        parts[m.i] = m.data;
        if (parts.filter((x) => x !== undefined).length === m.n) {
          this.snaps.delete(m.id);
          this.awaitingSnapshot = true;
          const job = this.loadSnapshot(m.meta, parts.join('')).catch((e) => {
            this.awaitingSnapshot = false;
            this.events.emit({ kind: 'toast', text: 'Could not load the host snapshot: ' + (e as Error).message, level: 'error' });
          });
          this.busy.add(job);
          void job.finally(() => this.busy.delete(job));
        }
        break;
      }
      case 'pong':
        this.rtt = Math.round(this.now() - m.t);
        break;
      case 'roster':
        this.roster = m.players;
        this.emitChange();
        break;
      case 'end':
        this.shutdown(m.reason, true);
        break;
    }
  }

  private onPresence(peers: PeerMeta[]) {
    const now = new Set(peers.map((p) => p.id));
    const gone = [...this.connected].filter((id) => !now.has(id));
    const came = [...now].filter((id) => !this.connected.has(id));
    this.connected = now;
    if (this.isHost) {
      if (this.phase === 'lobby' && gone.length) {
        this.lobby = this.lobby.filter((p) => p.host || now.has(p.id));
        this.broadcastLobby();
      }
      if (this.phase === 'game') {
        for (const id of gone) {
          this.synced.delete(id);
          const seat = this.seats[id];
          if (seat !== undefined && this.world?.s.empires[seat]?.human) {
            this.addChat({ from: '', name: '', color: '', text: `${this.world.s.empires[seat].name} disconnected.`, system: true });
            this.hostSystem({ t: 'control', empire: seat, human: false });
          }
        }
      }
      if (came.length && this.phase === 'lobby') this.broadcastLobby();
    } else {
      const host = peers.find((p) => p.host);
      if (host) { this.hostId = host.id; this.everSawHost = true; }
      if (this.everSawHost && this.hostId && !now.has(this.hostId) && this.phase !== 'ended') {
        this.shutdown('The host left the game.', true);
        return;
      }
      if (came.includes(this.hostId ?? '') || (this.phase === 'lobby' && !this.lobby.some((p) => p.id === this.self.id))) this.sendHello();
    }
    this.emitChange();
  }

  /** Every second: pings, roster, stall watchdog. Public so tests can call it. */
  heartbeat() {
    if (this.phase === 'ended') return;
    if (this.isHost) {
      this.flushTick(false);
      if (this.phase === 'game') {
        this.roster = this.buildRoster();
        this.send({ k: 'roster', players: this.roster });
        this.emitChange();
      }
    } else if (this.phase === 'game') {
      this.send({ k: 'ping', t: this.now(), day: this.world?.s.day ?? 0, rtt: this.rtt });
      if (!this.world && !this.awaitingSnapshot) this.sendHello();
      if (this.stalledSince !== null && Date.now() - this.stalledSince > 5000 && !this.awaitingSnapshot) {
        this.stalledSince = null;
        this.send({ k: 'snapReq' });
      }
    } else if (this.phase === 'lobby' && !this.lobby.some((p) => p.id === this.self.id)) this.sendHello();
  }

  private buildRoster(): RosterEntry[] {
    const w = this.world;
    const ids = new Set([...Object.keys(this.seats), ...this.synced]);
    const out: RosterEntry[] = [];
    for (const id of ids) {
      const seat = this.seats[id] ?? null;
      const lob = this.lobby.find((p) => p.id === id);
      const emp = seat !== null && w ? w.s.empires[seat] : null;
      const info = this.peerInfo.get(id);
      const host = id === this.self.id;
      out.push({
        id, seat, host,
        name: lob?.name ?? emp?.name ?? 'Spectator',
        color: emp?.color ?? lob?.color ?? '#999',
        connected: host || this.connected.has(id),
        ping: host ? 0 : info?.ping ?? null,
        day: host ? w?.s.day ?? 0 : info?.day ?? 0,
        sync: info?.sync ?? 'ok',
      });
    }
    return out.sort((a, b) => (a.seat ?? 99) - (b.seat ?? 99));
  }

  private nameOf(id: string) {
    return this.lobby.find((p) => p.id === id)?.name ?? 'a player';
  }

  private addChat(l: Omit<ChatLine, 'id'>) {
    this.chat.push({ ...l, id: ++this.chatId });
    if (this.chat.length > 200) this.chat.splice(0, this.chat.length - 200);
    this.emitChange();
  }

  private emitChange() { this.changed.emit(); }

  // --- debugging / tests ------------------------------------------------------
  get debug() {
    return { nextSeq: this.nextSeq, allowed: this.allowed, tickSeq: this.tickSeq, seq: this.seq, pending: this.log.size };
  }
}

// =============================================================================
// helpers
// =============================================================================

/** Fast 64-bit (two 32-bit lanes) string hash; not cryptographic. */
export function hashString(s: string): string {
  let h1 = 0x811c9dc5, h2 = 0x9747b28c;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ c, 2246822507) + (h2 >>> 13);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0') + ':' + s.length;
}

async function pack(json: string): Promise<{ data: string; enc: 'gzip' | 'json' }> {
  if (typeof CompressionStream === 'undefined') return { data: json, enc: 'json' };
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { data: btoa(bin), enc: 'gzip' };
}

async function unpack(data: string, enc: 'gzip' | 'json'): Promise<string> {
  if (enc === 'json') return data;
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

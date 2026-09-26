import { useEffect, useReducer } from 'preact/hooks';
import type { World } from '../sim/world';
import { advanceDay } from '../sim/turn';
import type { EmpireId, EventKind, GameEvent } from '../sim/types';
import { saveSlot } from '../sim/save';
import { applyCommand, type CmdResult, type Command } from '../sim/cmd';
import type { NetSession } from '../net/lockstep';
import { rememberRoom, setRoomInUrl } from '../net';

// A tiny observable store. The simulation mutates the World in place; the UI
// re-renders by watching a version counter. This keeps huge galaxies cheap.

export type Screen = 'none' | 'research' | 'designer' | 'diplomacy' | 'empire' | 'encyclopedia' | 'battle' | 'settings' | 'saves' | 'victory' | 'help';

export interface Selection {
  star: number | null;
  planet: number | null;
  fleet: number | null;
}

export interface Settings {
  /** Event kinds that pause "Play until event". */
  pauseOn: Record<EventKind, boolean>;
  classicArt: boolean;
  uiScale: number;
  showLabels: boolean;
  autosaveEvery: number;
  tutorialTips: boolean;
}

const DEFAULT_PAUSE: Record<EventKind, boolean> = {
  research: true, build: false, colony: true, combat: true, diplomacy: true, firstContact: true, growth: false, discovery: false,
  invasion: true, lost: true, ability: false, victory: true, warning: true, idle: false,
};

function loadSettings(): Settings {
  const base: Settings = { pauseOn: { ...DEFAULT_PAUSE }, classicArt: false, uiScale: 1, showLabels: true, autosaveEvery: 30, tutorialTips: true };
  try {
    const raw = localStorage.getItem('ascendant-settings');
    if (raw) {
      const s = JSON.parse(raw);
      return { ...base, ...s, pauseOn: { ...base.pauseOn, ...(s.pauseOn ?? {}) } };
    }
  } catch { /* storage unavailable */ }
  return base;
}

type Listener = () => void;

class Store {
  world: World | null = null;
  sel: Selection = { star: null, planet: null, fleet: null };
  screen: Screen = 'none';
  screenArg: unknown = null;
  /** 0 = paused; otherwise days per second. */
  speed = 0;
  untilEvent = false;
  settings = loadSettings();
  toast: { text: string; kind: 'info' | 'error'; id: number } | null = null;
  /** Map interaction mode: pick a target for an order. */
  pick: null | { kind: 'move' | 'ability' | 'colonize' | 'invade'; hint: string; onPick: (star: number, planet?: number) => void } = null;
  focusRequest: { star: number; id: number } | null = null;
  version = 0;
  /** Bumped whenever a different game is loaded, to remount the game view. */
  worldId = 0;
  /** Multiplayer session (lobby or game), or null in single-player. */
  net: NetSession | null = null;
  private listeners = new Set<Listener>();
  private acc = 0;
  private last = 0;
  private raf = 0;
  private netTimer: ReturnType<typeof setInterval> | null = null;
  private netUnsub: (() => void)[] = [];
  private pendingResults = new Map<number, (r: CmdResult) => void>();

  /** The local player's empire id (multiplayer seat, or the single-player human). */
  get me(): EmpireId | null {
    const w = this.world;
    if (!w) return null;
    return w.me ?? w.human()?.id ?? null;
  }

  /** True while playing a networked game. */
  get online() {
    return !!this.net && this.net.phase === 'game';
  }

  /**
   * Issue a player command. Single-player applies it immediately and returns
   * the result (errors are toasted either way). Multiplayer sends it through the lockstep host and returns
   * `{ ok: true, pending: true }`; `then` (and an error toast on failure) fire
   * once it has executed on this client.
   */
  dispatch(cmd: Command, then?: (r: CmdResult) => void): CmdResult & { pending?: boolean } {
    const w = this.world;
    if (!w) return { ok: false, error: 'No game.' };
    if (this.net && this.net.phase === 'game') {
      if (this.net.me === null) {
        this.notify('Spectators cannot give orders.', 'error');
        return { ok: false, error: 'Spectating.' };
      }
      const cid = this.net.command(cmd);
      if (then) this.pendingResults.set(cid, then);
      return { ok: true, pending: true };
    }
    const me = this.me;
    if (me === null) return { ok: false, error: 'You do not control an empire.' };
    const r = applyCommand(w, me, cmd);
    if (!r.ok) this.notify(r.error ?? 'Not possible.', 'error');
    then?.(r);
    this.emit();
    return r;
  }

  subscribe(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  emit() {
    this.version++;
    for (const l of this.listeners) l();
  }

  setWorld(w: World | null) {
    cancelAnimationFrame(this.raf);
    // Loading another game (or quitting) leaves any online session.
    if (this.net && w !== this.net.world) {
      const net = this.net;
      this.detachNet();
      net.leave();
    }
    this.world = w;
    this.worldId++;
    this.sel = { star: null, planet: null, fleet: null };
    this.screen = 'none';
    this.speed = 0;
    if (w) {
      const h = w.human();
      if (h?.capital != null) {
        const star = w.s.planets[h.capital].star;
        this.sel.star = star;
        this.focus(star);
      }
    }
    this.emit();
  }

  select(patch: Partial<Selection>) {
    this.sel = { ...this.sel, ...patch };
    this.emit();
  }

  open(screen: Screen, arg: unknown = null) {
    this.screen = screen;
    this.screenArg = arg;
    // Opening a screen pauses single-player; online, time is shared.
    if (screen !== 'none' && !this.net) this.pause();
    this.emit();
  }

  focus(star: number) {
    this.focusRequest = { star, id: Date.now() + Math.random() };
    this.emit();
  }

  notify(text: string, kind: 'info' | 'error' = 'info') {
    const id = Date.now();
    this.toast = { text, kind, id };
    this.emit();
    setTimeout(() => {
      if (this.toast?.id === id) {
        this.toast = null;
        this.emit();
      }
    }, kind === 'error' ? 4200 : 2600);
  }

  saveSettings() {
    try { localStorage.setItem('ascendant-settings', JSON.stringify(this.settings)); } catch { /* ignore */ }
    this.emit();
  }

  // --- time -----------------------------------------------------------------

  play(speed: number, untilEvent = false) {
    if (!this.world || this.world.s.winner) return;
    if (this.net) {
      // Online: the host owns the clock. "Until event" can't stop for everyone, so it runs fast.
      this.net.requestSpeed(untilEvent ? 20 : speed);
      return;
    }
    this.speed = speed;
    this.untilEvent = untilEvent;
    this.last = performance.now();
    this.acc = 1;
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.frame);
    this.emit();
  }

  pause() {
    if (this.net) {
      if (this.net.speed) this.net.requestSpeed(0);
      return;
    }
    if (!this.speed) return;
    this.speed = 0;
    cancelAnimationFrame(this.raf);
    this.emit();
  }

  step(days = 1) {
    if (!this.world) return;
    if (this.net) {
      this.net.requestStep(days);
      return;
    }
    for (let i = 0; i < days; i++) this.tick();
    this.emit();
  }

  private frame = (t: number) => {
    const w = this.world;
    if (!w || !this.speed) return;
    const dt = Math.min(0.25, (t - this.last) / 1000);
    this.last = t;
    this.acc += dt * this.speed;
    const start = performance.now();
    let stepped = false;
    while (this.acc >= 1 && performance.now() - start < 30) {
      this.acc -= 1;
      stepped = true;
      if (this.tick()) {
        this.pause();
        break;
      }
    }
    if (this.acc > 3) this.acc = 1; // Don't spiral when the sim can't keep up.
    if (stepped) this.emit();
    if (this.speed) this.raf = requestAnimationFrame(this.frame);
  };

  /** Advance one day. Returns true if we should pause. */
  private tick(): boolean {
    const w = this.world!;
    const lastId = w.s.events.length ? w.s.events[w.s.events.length - 1].id : 0;
    advanceDay(w);
    return this.afterDay(w, lastId);
  }

  /** Post-day bookkeeping shared by single-player and online play. Returns true if SP should pause. */
  private afterDay(w: World, lastId: number): boolean {
    if (w.s.winner) {
      this.screen = 'victory';
      return true;
    }
    if (this.settings.autosaveEvery && w.s.day % this.settings.autosaveEvery === 0) {
      const slot = this.net ? 'mp-autosave' : 'autosave';
      void saveSlot(w, slot, this.net ? `Online ${this.net.room} (autosave)` : 'Autosave').catch(() => {});
    }
    const human = w.human();
    if (!human) return false;
    if (w.s.proposals.some((p) => p.to === human.id && p.day === w.s.day)) {
      if (this.net) this.notify(`New diplomatic proposal — open Diplomacy (P).`);
      return true;
    }
    const fresh: GameEvent[] = [];
    for (let k = w.s.events.length - 1; k >= 0 && w.s.events[k].id > lastId; k--) if (w.s.events[k].empire === human.id) fresh.push(w.s.events[k]);
    const important = fresh.find((e) => this.settings.pauseOn[e.kind] && (e.important || this.untilEvent));
    if (important) {
      this.notify(important.text);
      return this.untilEvent || !!important.important;
    }
    return false;
  }

  // --- multiplayer ------------------------------------------------------------

  /** Attach a multiplayer session (from the lobby). Its game replaces the current world. */
  attachNet(net: NetSession) {
    this.detachNet();
    this.net = net;
    let queued = false;
    const emitSoon = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => { queued = false; this.emit(); });
    };
    this.netUnsub.push(net.changed.on(() => {
      if (this.speed !== net.speed) this.speed = net.speed;
      emitSoon();
    }));
    this.netUnsub.push(net.events.on((ev) => {
      switch (ev.kind) {
        case 'world':
          if (ev.reason === 'start' || !this.world) {
            this.setWorld(ev.world);
            if (net.me !== null) this.notify(`Welcome, leader of the ${ev.world.s.empires[net.me].name}. Time is shared: anyone can pause.`);
            else this.notify('Spectating this game.');
          } else this.replaceWorld(ev.world);
          this.speed = net.speed;
          break;
        case 'day':
          this.afterDay(ev.world, ev.lastEventId);
          break;
        case 'result': {
          const cb = this.pendingResults.get(ev.cid);
          this.pendingResults.delete(ev.cid);
          if (!ev.result.ok) this.notify(ev.result.error ?? 'Not possible.', 'error');
          cb?.(ev.result);
          emitSoon();
          break;
        }
        case 'toast':
          this.notify(ev.text, ev.level);
          break;
        case 'ended':
          void this.endOnline(ev.reason);
          break;
      }
    }));
    // The host drives the shared clock. setInterval (not rAF) keeps time
    // flowing while the host's tab is in the background.
    if (net.isHost) {
      let last = performance.now();
      this.netTimer = setInterval(() => {
        const t = performance.now();
        const dt = Math.min(1, (t - last) / 1000);
        last = t;
        if (net.phase === 'game' && net.hostFrame(dt) > 0) emitSoon();
      }, 33);
    }
    this.emit();
  }

  /** Leave the multiplayer session (keeps the current world, if any, as a single-player game). */
  leaveNet() {
    const net = this.net;
    if (!net) return;
    net.leave();
    void this.endOnline(net.isHost ? 'You ended the session.' : 'You left the game.');
  }

  private detachNet() {
    for (const u of this.netUnsub) u();
    this.netUnsub = [];
    if (this.netTimer) clearInterval(this.netTimer);
    this.netTimer = null;
    this.pendingResults.clear();
    this.net = null;
  }

  /** Session over: hand other seats to the AI, save, and keep playing offline. */
  private async endOnline(reason: string) {
    const net = this.net;
    this.detachNet();
    rememberRoom(null);
    setRoomInUrl(null);
    const w = this.world;
    this.speed = 0;
    if (w && net) {
      for (const e of w.s.empires) if (e.id !== w.me) e.human = false;
      w.touch();
      try {
        await saveSlot(w, 'mp-' + net.room, `Online ${net.room} — day ${w.s.day}`);
        this.notify(`${reason} The game was saved ("Online ${net.room}") and continues offline against the AI.`, 'error');
      } catch {
        this.notify(`${reason} Continuing offline.`, 'error');
      }
    } else this.notify(reason, 'error');
    this.emit();
  }

  /** Swap in a resynchronized world, keeping the selection and open screen. */
  private replaceWorld(w: World) {
    this.world = w;
    this.worldId++;
    const s = w.s;
    if (this.sel.fleet !== null && !s.fleets[this.sel.fleet]) this.sel = { ...this.sel, fleet: null };
    this.emit();
  }
}

export const store = new Store();

/** Re-render whenever the store emits. */
export function useStore() {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => store.subscribe(() => force(0)), []);
  return store;
}

(globalThis as unknown as { store: Store }).store = store;

/** Issue a player command (see Store.dispatch). */
export function dispatch(cmd: Command, then?: (r: CmdResult) => void) {
  return store.dispatch(cmd, then);
}

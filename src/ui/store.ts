import { useEffect, useReducer } from 'preact/hooks';
import type { World } from '../sim/world';
import { advanceDay } from '../sim/turn';
import type { EventKind, GameEvent } from '../sim/types';
import { saveSlot } from '../sim/save';

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
  private listeners = new Set<Listener>();
  private acc = 0;
  private last = 0;
  private raf = 0;

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
    if (screen !== 'none') this.pause();
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
    this.speed = speed;
    this.untilEvent = untilEvent;
    this.last = performance.now();
    this.acc = 1;
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.frame);
    this.emit();
  }

  pause() {
    if (!this.speed) return;
    this.speed = 0;
    cancelAnimationFrame(this.raf);
    this.emit();
  }

  step(days = 1) {
    if (!this.world) return;
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
    if (w.s.winner) {
      this.screen = 'victory';
      return true;
    }
    if (this.settings.autosaveEvery && w.s.day % this.settings.autosaveEvery === 0) void saveSlot(w, 'autosave', 'Autosave').catch(() => {});
    const human = w.human();
    if (!human) return false;
    if (w.s.proposals.some((p) => p.to === human.id && p.day === w.s.day)) return true;
    const fresh: GameEvent[] = [];
    for (let k = w.s.events.length - 1; k >= 0 && w.s.events[k].id > lastId; k--) if (w.s.events[k].empire === human.id) fresh.push(w.s.events[k]);
    const important = fresh.find((e) => this.settings.pauseOn[e.kind] && (e.important || this.untilEvent));
    if (important) {
      this.notify(important.text);
      return this.untilEvent || !!important.important;
    }
    return false;
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

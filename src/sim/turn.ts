import type { World } from './world';
import { economyTick } from './economy';
import { movementTick, ordersTick, repairTick } from './fleets';
import { combatTick } from './combat';
import { diplomacyTick } from './diplomacy';
import { visibilityTick } from './visibility';
import { victoryTick, statsTick } from './victory';
import { aiTick, humanAutomation } from './ai';

/** Advance the galaxy by one day. Pure simulation: no DOM, deterministic given the state. */
export function advanceDay(w: World) {
  const s = w.s;
  if (s.winner) return;
  s.day++;
  w.econCache.clear();
  economyTick(w);
  movementTick(w);
  combatTick(w);
  ordersTick(w);
  repairTick(w);
  visibilityTick(w);
  diplomacyTick(w);
  for (const e of s.empires) if (e.alive) e.human ? humanAutomation(w, e) : aiTick(w, e);
  w.reindex();
  victoryTick(w);
  statsTick(w);
  w.syncRng();
  w.version++;
}

/** Run until something important happens for the human, or `max` days pass. */
export function advanceUntilEvent(w: World, max: number, stopOn: (kind: string, important: boolean) => boolean) {
  const human = w.human();
  for (let i = 0; i < max; i++) {
    const before = w.s.events.length ? w.s.events[w.s.events.length - 1].id : 0;
    advanceDay(w);
    if (w.s.winner) return i + 1;
    if (human) {
      for (let k = w.s.events.length - 1; k >= 0 && w.s.events[k].id > before; k--) {
        const ev = w.s.events[k];
        if (ev.empire === human.id && stopOn(ev.kind, !!ev.important)) return i + 1;
      }
      if (w.s.proposals.some((p) => p.to === human.id && p.day === w.s.day)) return i + 1;
    }
  }
  return max;
}

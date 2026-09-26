// Per-subsystem timing for a large galaxy.
import { newGame, DEFAULT_SETTINGS } from '../src/sim/gen';
import { advanceDay } from '../src/sim/turn';
import { economyTick } from '../src/sim/economy';
import { movementTick, ordersTick, repairTick } from '../src/sim/fleets';
import { combatTick } from '../src/sim/combat';
import { diplomacyTick } from '../src/sim/diplomacy';
import { visibilityTick } from '../src/sim/visibility';
import { victoryTick, statsTick } from '../src/sim/victory';
import { aiTick } from '../src/sim/ai';

const w = newGame({ ...DEFAULT_SETTINGS, seed: 5, stars: 1200, empires: 16, spectate: true });
for (let d = 0; d < 600; d++) advanceDay(w);
const T: Record<string, number> = {};
const time = (k: string, f: () => void) => { const t = performance.now(); f(); T[k] = (T[k] ?? 0) + performance.now() - t; };
for (let d = 0; d < 100; d++) {
  const s = w.s;
  s.day++;
  w.econCache.clear();
  time('economy', () => economyTick(w));
  time('movement', () => movementTick(w));
  time('combat', () => combatTick(w));
  time('orders', () => ordersTick(w));
  time('repair', () => repairTick(w));
  time('visibility', () => visibilityTick(w));
  time('diplomacy', () => diplomacyTick(w));
  time('ai', () => { for (const e of s.empires) if (e.alive) aiTick(w, e); });
  time('reindex', () => w.reindex());
  time('victory', () => { victoryTick(w); statsTick(w); });
}
console.log(Object.entries(T).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k.padEnd(11)} ${(v / 100).toFixed(2)} ms/day`).join('\n'));
console.log('fleets', Object.keys(w.s.fleets).length, 'ships', Object.keys(w.s.ships).length, 'owned planets', w.s.planets.filter((p) => p.owner !== null).length);

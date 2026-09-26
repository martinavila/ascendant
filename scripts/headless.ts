// Headless AI-vs-AI simulation for balance and regression checks.
//   npm run sim -- --stars 200 --empires 8 --days 800 --seed 7
import { newGame, DEFAULT_SETTINGS } from '../src/sim/gen';
import { advanceDay } from '../src/sim/turn';
import { score } from '../src/sim/victory';
import { serialize, deserialize } from '../src/sim/save';

const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean).map((kv) => {
  const [k, v] = kv.trim().split(/\s+/);
  return [k, Number(v)];
}));
const settings = { ...DEFAULT_SETTINGS, seed: args.seed ?? 42, stars: args.stars ?? 150, empires: args.empires ?? 6, spectate: true };
const days = args.days ?? 600;

const t0 = performance.now();
const w = newGame(settings);
const tGen = performance.now() - t0;
console.log(`galaxy: ${w.s.stars.length} stars, ${w.s.lanes.length} lanes (${w.s.lanes.filter((l) => l.unstable).length} unstable), ${w.s.planets.length} planets — generated in ${tGen.toFixed(0)}ms`);

const t1 = performance.now();
for (let d = 0; d < days && !w.s.winner; d++) {
  advanceDay(w);
  if (w.s.day % 100 === 0) {
    const rows = w.s.empires.map((e) => `${e.species.padEnd(8)} ${e.alive ? '' : '(dead)'} pl=${w.planetsOf[e.id].length} pop=${e.last.pop} ind=${e.last.ind.toFixed(0)} res=${e.last.res.toFixed(0)} tech=${e.research.known.length} ships=${Object.values(w.s.ships).filter((s) => s.owner === e.id).length} score=${score(w, e)}`);
    const wars = w.s.empires.flatMap((a) => w.s.empires.filter((b) => b.id > a.id && w.atWar(a.id, b.id)).map((b) => `${a.id}-${b.id}`));
    const captures = w.s.events.filter((e) => e.kind === 'invasion' && e.text.startsWith('We captured')).length;
    console.log(`\nday ${w.s.day}  captures(recent)=${captures}  battles=${w.s.battles.length}  wars=[${wars.join(' ')}]\n  ` + rows.join('\n  '));
  }
}
const ms = performance.now() - t1;
console.log(`\n${w.s.day} days in ${ms.toFixed(0)}ms (${(ms / w.s.day).toFixed(2)} ms/day)`);
if (w.s.winner) console.log('WINNER:', w.s.empires[w.s.winner.empire].name, w.s.winner.kind, 'day', w.s.winner.day);
const json = serialize(w);
const w2 = deserialize(json);
console.log(`save size ${(json.length / 1024).toFixed(0)} KB; reload ok: ${w2.s.day === w.s.day}`);

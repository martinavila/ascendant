import { newGame, DEFAULT_SETTINGS } from '../src/sim/gen';
import { advanceDay } from '../src/sim/turn';
import { foundColony } from '../src/sim/fleets';
import { governorCandidates } from '../src/sim/governor';
const w = newGame({ ...DEFAULT_SETTINGS, seed: 7 });
const e = w.human()!;
import('../src/sim/content').then(() => {});
for (const t of ['orbital','survey','xenobio','ion','data','envseal','kinetics','spectral','chemistry','xenoarch','assault','hyperlogic','lanemech']) e.research.known.push(t);
w.reindex();
e.prefs.autoResearch = true; e.research.auto = true;
const cap = w.s.planets[e.capital!];
const p = w.s.stars[cap.star].planets.map((id) => w.s.planets[id]).find((x) => x.owner === null && x.type !== 'gasgiant')!;
foundColony(w, p, e.id, true);
let lastLen = 0;
for (let d = 0; d < 250; d++) {
  const before = p.queue.map((q) => JSON.stringify(q));
  if (!p.queue.length) {
    const c = governorCandidates(w, p).slice(0, 3);
    const ec = w.econ(p);
    if (c.length && w.s.day % 1 === 0 && c[0].score > 0.03) console.log(`day ${w.s.day} pop ${p.pop}/${ec.popMax} workers ${ec.workersNeeded} top:`, c.map((x) => `${(x.item as any).id ?? x.item.kind}${(x.item as any).replace ? '(R)' : ''} ${x.score.toFixed(3)} ${x.why}`).join(' | '));
  }
  advanceDay(w);
  void before; void lastLen;
}
const ec = w.econ(p);
console.log('final', p.pop, ec.popMax, ec.workersNeeded, p.tiles.filter((t) => t.b).map((t) => t.b!.id).join(','));

import { newGame, DEFAULT_SETTINGS } from '../src/sim/gen';
import { advanceDay } from '../src/sim/turn';
import { BUILDING } from '../src/sim/content';
const w = newGame({ ...DEFAULT_SETTINGS, seed: 42, stars: 120, empires: 6, spectate: true });
for (let d = 0; d < 600; d++) advanceDay(w);
for (const e of w.s.empires) {
  const counts: Record<string, number> = {};
  let auto = 0, projects: Record<string, number> = {};
  for (const id of w.planetsOf[e.id]) {
    const p = w.s.planets[id];
    for (const t of p.tiles) if (t.b) { counts[t.b.id] = (counts[t.b.id] ?? 0) + 1; if (t.b.auto) auto++; }
    for (const o of p.orbitals) if (o) counts[o.id] = (counts[o.id] ?? 0) + 1;
    if (!p.queue.length && p.project) projects[p.project] = (projects[p.project] ?? 0) + 1;
  }
  console.log(e.species, 'planets', w.planetsOf[e.id].length, 'pop', e.last.pop, 'ind', e.last.ind.toFixed(0), 'res', e.last.res.toFixed(0), 'techs', e.research.known.length, 'auto', auto, 'logistics', e.logistics.toFixed(0));
  console.log('   ', Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${BUILDING[k].name}:${v}`).join(', '));
  console.log('    projects', JSON.stringify(projects));
}

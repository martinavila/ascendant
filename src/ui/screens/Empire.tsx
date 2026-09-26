import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { store, useStore } from '../store';
import { Bar, Empty, Modal, Section, act, fmt, plural } from '../common';
import { EmpireDot, Icon, PlanetOrb, Portrait } from '../icons';
import { PLANET_TYPE, PROJECT, PROJECTS, SPECIES_BY_ID } from '../../sim/content';
import { FOCUS_LABEL } from '../../sim/governor';
import { setFocusAll, setGovernor, setGovernorAll, setPref, setProject } from '../../sim/commands';
import { score, victoryProgress } from '../../sim/victory';
import type { Empire, EmpireStats, GovernorFocus, Planet } from '../../sim/types';
import type { PlanetEcon, World } from '../../sim/world';

// The Empire screen is the answer to the original game's late-game "click
// fest": every planet in one sortable table, bulk governor/focus/project
// changes, empire-wide automation switches, and history charts.

type Tab = 'overview' | 'planets' | 'stats';
const FOCUSES = Object.keys(FOCUS_LABEL) as GovernorFocus[];

const CSS = `
.em-root { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.em-root > .tabs { flex: 0 0 auto; }
.em-root .tabs button { flex: 0 0 auto; padding: 10px 18px; display: inline-flex; align-items: center; gap: 7px; }
.em-body { flex: 1; min-height: 0; }
.em-over { display: grid; grid-template-columns: minmax(260px, 1fr) minmax(300px, 1.2fr) minmax(280px, 1fr); gap: 14px; padding: 14px; align-content: start; }
.em-over > .col { gap: 14px; min-width: 0; }
.em-card { background: var(--panel-2); border: 1px solid var(--line); border-radius: 10px; padding: 14px; min-width: 0; }
.em-card h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--text-dim); margin-bottom: 10px; display: flex; align-items: center; gap: 8px; }
.em-id { display: flex; gap: 14px; align-items: center; }
.em-id h1 { font-size: 22px; line-height: 1.15; }
.em-kpis { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.em-kpi { background: rgba(0, 0, 0, 0.22); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; min-width: 0; }
.em-kpi .v { font-family: var(--display); font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; display: flex; align-items: center; gap: 6px; }
.em-kpi .l { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-dim); margin-top: 2px; }
.em-vic { display: flex; flex-direction: column; gap: 12px; }
.em-vic-row .top { display: flex; align-items: baseline; gap: 8px; margin-bottom: 5px; }
.em-vic-row .name { font-family: var(--display); font-weight: 600; letter-spacing: 0.03em; }
.em-vic-row .pct { margin-left: auto; font-variant-numeric: tabular-nums; font-weight: 600; }
.em-vic-row .bar { height: 8px; }
.em-vic-row .bar > i { box-shadow: 0 0 10px currentColor; }
.em-vic-row .detail { font-size: 12px; color: var(--text-dim); margin-top: 4px; line-height: 1.4; }
.em-vic-row.off { opacity: 0.45; }
.em-score { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 8px; background: linear-gradient(90deg, rgba(180, 140, 255, 0.16), transparent); border: 1px solid rgba(180, 140, 255, 0.3); }
.em-score .v { font-family: var(--display); font-size: 24px; font-weight: 700; margin-left: auto; }
.em-toggle { display: flex; align-items: flex-start; gap: 12px; padding: 9px 0; border-bottom: 1px solid rgba(130, 160, 255, 0.08); cursor: pointer; }
.em-toggle:last-child { border-bottom: 0; }
.em-toggle .t { font-weight: 600; }
.em-toggle .d { font-size: 12px; color: var(--text-dim); line-height: 1.4; margin-top: 2px; }
.em-switch { flex: 0 0 auto; width: 36px; height: 20px; border-radius: 999px; background: rgba(255, 255, 255, 0.1); border: 1px solid var(--line-2); position: relative; cursor: pointer; transition: background 0.15s, border-color 0.15s; padding: 0; margin-top: 1px; }
.em-switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: var(--text-dim); transition: transform 0.15s, background 0.15s; }
.em-switch.on { background: rgba(127, 220, 255, 0.35); border-color: var(--accent); }
.em-switch.on::after { transform: translateX(16px); background: #fff; box-shadow: 0 0 8px var(--accent); }
.em-switch.sm { width: 30px; height: 17px; }
.em-switch.sm::after { width: 11px; height: 11px; }
.em-switch.sm.on::after { transform: translateX(13px); }
.em-attn { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 8px; cursor: pointer; }
.em-attn:hover { background: var(--panel-3); }
.em-seg-wrap { display: flex; flex-wrap: wrap; gap: 6px; }
.em-toolbar { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.em-toolbar input[type=search] { width: 220px; max-width: 100%; }
.em-bulk { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 8px 14px; background: rgba(127, 220, 255, 0.08); border-bottom: 1px solid rgba(127, 220, 255, 0.3); animation: rise 0.15s ease-out; }
.em-bulk select, .em-row select { padding: 3px 6px; font-size: 12px; }
.em-table td { vertical-align: middle; font-variant-numeric: tabular-nums; }
.em-table th.num, .em-table td.num { text-align: right; }
.em-table th .arrow { display: inline-block; width: 10px; color: var(--accent); }
.em-table th.nosort { cursor: default; }
.em-table td.nm { font-weight: 600; max-width: 180px; }
.em-table .build { min-width: 150px; max-width: 220px; }
.em-table .build .bar { height: 4px; margin-top: 4px; }
.em-table .flags { display: flex; gap: 4px; flex-wrap: wrap; }
.em-table input[type=checkbox] { accent-color: var(--accent); width: 15px; height: 15px; cursor: pointer; }
.em-gov { display: flex; align-items: center; gap: 6px; }
.em-chart-wrap { position: relative; }
.em-chart-wrap svg text { font-family: var(--font); fill: var(--text-faint); font-size: 11px; }
.em-readout { position: absolute; pointer-events: none; min-width: 170px; padding: 8px 10px; background: rgba(8, 11, 22, 0.96); border: 1px solid var(--line-2); border-radius: 8px; box-shadow: var(--shadow); font-size: 12px; z-index: 3; }
.em-readout .row { justify-content: space-between; gap: 14px; }
.em-legend { display: flex; flex-wrap: wrap; gap: 6px; }
.em-legend button { display: inline-flex; align-items: center; gap: 7px; padding: 5px 10px; border-radius: 999px; background: var(--panel-2); border: 1px solid var(--line); cursor: pointer; font-size: 12px; }
.em-legend button.off { opacity: 0.4; }
.em-legend button .val { color: var(--text-dim); font-variant-numeric: tabular-nums; }
.em-stats { padding: 14px; display: flex; flex-direction: column; gap: 12px; }
.em-metric-desc { font-size: 12px; color: var(--text-dim); }
@media (max-width: 1100px) {
  .em-over { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .em-over > .col:last-child { grid-column: 1 / -1; }
}
@media (max-width: 860px) {
  .em-over { grid-template-columns: minmax(0, 1fr); }
  .em-table .hide-sm { display: none; }
}
@media (max-width: 520px) {
  .em-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
`;

function Switch({ on, onToggle, small, tip }: { on: boolean; onToggle: () => void; small?: boolean; tip?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      class={'em-switch' + (on ? ' on' : '') + (small ? ' sm' : '')}
      data-tip={tip}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
    />
  );
}

export function EmpireScreen() {
  useStore();
  const w = store.world;
  const h = w?.human();
  const initial = (store.screenArg as { tab?: Tab } | null)?.tab;
  const [tab, setTab] = useState<Tab>(initial === 'planets' || initial === 'stats' ? initial : 'overview');
  if (!w || !h) return <Modal title="Empire"><Empty>No empire to show.</Empty></Modal>;
  return (
    <Modal title={<span class="row" style={{ gap: 10 }}><EmpireDot color={h.color} size={12} />{h.name}</span>}>
      <style>{CSS}</style>
      <div class="em-root">
        <div class="tabs">
          <button class={tab === 'overview' ? 'on' : ''} onClick={() => setTab('overview')}><Icon.star size={14} />Overview</button>
          <button class={tab === 'planets' ? 'on' : ''} onClick={() => setTab('planets')}><Icon.planet size={14} />Planets <span class="chip">{w.planetsOf[h.id].length}</span></button>
          <button class={tab === 'stats' ? 'on' : ''} onClick={() => setTab('stats')}><Icon.chart size={14} />Statistics</button>
        </div>
        <div class="em-body scroll">
          {tab === 'overview' && <Overview w={w} h={h} gotoPlanets={() => setTab('planets')} />}
          {tab === 'planets' && <PlanetsTab w={w} h={h} />}
          {tab === 'stats' && <StatsTab w={w} h={h} />}
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

const VIC_COLOR: Record<string, string> = { conquest: '#ff6b6b', domination: '#ffcf6a', ascension: '#b48cff', diplomatic: '#6fe08a', score: '#7fdcff' };

function shipCount(w: World, e: Empire) {
  let n = 0;
  for (const f of Object.values(w.s.fleets)) if (f.owner === e.id) n += f.ships.length;
  return n;
}

function gotoPlanet(p: Planet) {
  store.select({ star: p.star, planet: p.id, fleet: null });
  store.focus(p.star);
  store.open('none');
}

/** Things a player would otherwise have to hunt for planet by planet. */
function issuesOf(p: Planet, ec: PlanetEcon): string[] {
  const out: string[] = [];
  if (p.besieged) out.push('Under siege');
  if (ec.idle.size) out.push(`${plural(ec.idle.size, 'structure')} idle — not enough workers`);
  if (!p.queue.length && !p.project && !p.governor.on && p.pop > 0) out.push('Nothing to build and no project');
  if (p.pop > 0 && p.pop >= ec.popMax && ec.popMax > 0 && !p.governor.on && !p.queue.some((q) => q.kind === 'building')) out.push('At population cap');
  return out;
}

function Overview({ w, h, gotoPlanets }: { w: World; h: Empire; gotoPlanets: () => void }) {
  const sp = SPECIES_BY_ID[h.species];
  const planets = w.planetsOf[h.id].map((id) => w.s.planets[id]);
  const governed = planets.filter((p) => p.governor.on).length;
  const ships = shipCount(w, h);
  const vp = victoryProgress(w, h.id);
  const sc = score(w, h);
  const attention = planets
    .map((p) => ({ p, issues: issuesOf(p, w.econ(p)) }))
    .filter((x) => x.issues.length)
    .sort((a, b) => b.issues.length - a.issues.length || b.p.pop - a.p.pop);
  const ranks = w.s.empires.filter((o) => o.alive).map((o) => ({ o, s: score(w, o) })).sort((a, b) => b.s - a.s);
  const myRank = ranks.findIndex((r) => r.o.id === h.id) + 1;
  const [focus, setFocus] = useState<GovernorFocus>('balanced');

  const toggles: { k: keyof Empire['prefs']; t: string; d: string }[] = [
    { k: 'governNewColonies', t: 'Governors on new colonies', d: 'Every newly founded or conquered planet starts under a Balanced governor.' },
    { k: 'autoUpgradeAll', t: 'Auto-upgrade structures everywhere', d: 'Governors and manual planets alike replace obsolete structures (Factory → Megaplex) as soon as the tech allows.' },
    { k: 'autoResearch', t: 'Auto-research', d: 'When the research queue runs dry, pick the next technology automatically.' },
  ];

  return (
    <div class="em-over">
      <div class="col">
        <div class="em-card">
          <div class="em-id">
            <Portrait species={h.species} color={h.color} size={84} big />
            <div class="col" style={{ gap: 4, minWidth: 0 }}>
              <h1 class="ellipsis">{h.name}</h1>
              <div class="dim small">{sp.plural} · {sp.traitDesc.split(':')[0]}</div>
              <div class="small">Day <b class="mono">{w.s.day}</b> · Rank <b>{myRank}</b> of {ranks.length}</div>
              <div class="row" style={{ marginTop: 4 }}>
                <button class="btn sm" onClick={() => store.open('encyclopedia', { entry: `species:${h.species}` })}><Icon.book size={13} />Species</button>
              </div>
            </div>
          </div>
        </div>
        <div class="em-card">
          <h3>Empire totals <span class="spacer" /><span class="faint tiny" style={{ textTransform: 'none', letterSpacing: 0 }}>per day</span></h3>
          <div class="em-kpis">
            <div class="em-kpi" data-tip="Industry produced per day across all planets. Each planet spends its own industry on its build queue."><div class="v ind"><Icon.ind />{fmt(h.last.ind)}</div><div class="l">Industry</div></div>
            <div class="em-kpi" data-tip="Research per day, pooled empire-wide into the current technology."><div class="v res"><Icon.res />{fmt(h.last.res)}</div><div class="l">Research</div></div>
            <div class="em-kpi" data-tip="Prosperity per day. Each planet's prosperity grows its own population."><div class="v pro"><Icon.pro />{fmt(h.last.pro)}</div><div class="l">Prosperity</div></div>
            <div class="em-kpi" data-tip="Total population. Every pop works one structure."><div class="v pop"><Icon.pop />{fmt(h.last.pop)}</div><div class="l">Population</div></div>
            <div class="em-kpi" data-tip={`Logistics pool: industry shipped by Supply Convoy projects, spent automatically to speed up planets that are building something.\nDelivered yesterday: ${fmt(h.last.logisticsIn)}`}><div class="v" style={{ color: 'var(--warn)' }}><Icon.route />{fmt(h.logistics)}</div><div class="l">Logistics pool</div></div>
            <div class="em-kpi" data-tip="Technologies known"><div class="v res"><Icon.flask />{h.research.known.length}</div><div class="l">Techs</div></div>
            <div class="em-kpi" data-tip={`${governed} of ${planets.length} planets are under a governor`}><div class="v"><Icon.planet />{planets.length}</div><div class="l">Planets · {governed} gov.</div></div>
            <div class="em-kpi"><div class="v"><Icon.ship />{ships}</div><div class="l">Ships</div></div>
            <div class="em-kpi" data-tip="Score = 2×population + 5×planets + 8×techs + military power / 20"><div class="v" style={{ color: 'var(--accent-2)' }}><Icon.trophy />{fmt(sc)}</div><div class="l">Score</div></div>
          </div>
        </div>
      </div>

      <div class="col">
        <div class="em-card">
          <h3><Icon.trophy size={14} />Victory progress</h3>
          <div class="em-vic">
            {vp.filter((v) => v.enabled).map((v) => (
              <div class="em-vic-row" key={v.kind} style={{ color: VIC_COLOR[v.kind] ?? 'var(--accent)' }}>
                <div class="top">
                  <span class="name" style={{ color: 'var(--text)' }}>{v.label}</span>
                  <span class="pct">{Math.round(v.value * 100)}%</span>
                </div>
                <Bar value={v.value} max={1} color={VIC_COLOR[v.kind]} />
                <div class="detail">{v.detail}</div>
              </div>
            ))}
            {vp.filter((v) => !v.enabled).map((v) => (
              <div class="em-vic-row off" key={v.kind}>
                <div class="top"><span class="name">{v.label}</span><span class="pct dim small">disabled</span></div>
              </div>
            ))}
          </div>
          <div class="em-score" style={{ marginTop: 14 }}>
            <Icon.trophy />
            <div>
              <div style={{ fontWeight: 600 }}>Score</div>
              <div class="tiny dim">Leader: {ranks[0]?.o.id === h.id ? 'you' : (h.relations[ranks[0]?.o.id]?.met ? ranks[0].o.name : 'an unknown empire')}</div>
            </div>
            <span class="v">{fmt(sc)}</span>
          </div>
        </div>
        <div class="em-card">
          <h3><Icon.eye size={14} />Needs attention <span class="spacer" />{attention.length > 0 && <button class="btn sm ghost" onClick={gotoPlanets}>All planets →</button>}</h3>
          {attention.length === 0 ? (
            <div class="dim small">Every planet is busy. Nothing needs your attention.</div>
          ) : (
            <div class="col" style={{ gap: 2 }}>
              {attention.slice(0, 7).map(({ p, issues }) => (
                <div class="em-attn" key={p.id} onClick={() => gotoPlanet(p)} data-tip="Open this planet">
                  <PlanetOrb planet={p} size={26} />
                  <div class="grow">
                    <div class="ellipsis" style={{ fontWeight: 600 }}>{p.name}</div>
                    <div class="tiny warn ellipsis">{issues.join(' · ')}</div>
                  </div>
                  {!p.governor.on && (
                    <button class="btn sm" data-tip="Hand this planet to a governor" onClick={(e) => { e.stopPropagation(); setGovernor(w, p, { on: true }); act(undefined, `${p.name} is now governed.`); }}>
                      <Icon.gear size={12} />Govern
                    </button>
                  )}
                </div>
              ))}
              {attention.length > 7 && <div class="tiny dim" style={{ padding: '4px 8px' }}>…and {attention.length - 7} more</div>}
            </div>
          )}
        </div>
      </div>

      <div class="col">
        <div class="em-card">
          <h3><Icon.gear size={14} />Automation</h3>
          {toggles.map((t) => (
            <div class="em-toggle" key={t.k} onClick={() => act(setPref(w, h.id, t.k, !h.prefs[t.k]))}>
              <Switch on={h.prefs[t.k]} onToggle={() => act(setPref(w, h.id, t.k, !h.prefs[t.k]))} />
              <div>
                <div class="t">{t.t}</div>
                <div class="d">{t.d}</div>
              </div>
            </div>
          ))}
        </div>
        <div class="em-card">
          <h3><Icon.planet size={14} />Governors</h3>
          <div class="small dim" style={{ marginBottom: 8 }}>
            <b style={{ color: 'var(--text)' }}>{governed}</b> of {planets.length} planets governed.
          </div>
          <Bar value={governed} max={Math.max(1, planets.length)} style={{ marginBottom: 12 }} />
          <button
            class="btn primary"
            style={{ width: '100%' }}
            disabled={governed === planets.length}
            onClick={() => { setGovernorAll(w, h.id, { on: true }); act(undefined, `All ${plural(planets.length, 'planet')} are now under a governor.`); }}
          >
            <Icon.gear size={14} />Put every planet under a governor
          </button>
          <div class="caps" style={{ margin: '14px 0 6px' }}>Set every governed planet to</div>
          <div class="em-seg-wrap">
            <div class="seg">
              {FOCUSES.map((f) => <button key={f} class={focus === f ? 'on' : ''} onClick={() => setFocus(f)}>{FOCUS_LABEL[f]}</button>)}
            </div>
            <button
              class="btn sm"
              disabled={!governed}
              onClick={() => { setGovernorAll(w, h.id, { focus }, (p) => p.governor.on); act(undefined, `${plural(governed, 'governed planet')} now focus on ${FOCUS_LABEL[focus]}.`); }}
            >Apply</button>
          </div>
          <button
            class="btn sm ghost"
            style={{ marginTop: 8 }}
            onClick={() => { setFocusAll(w, h.id, focus); act(undefined, `Every planet is governed with a ${FOCUS_LABEL[focus]} focus.`); }}
            data-tip="Also turns the governor on for manual planets"
          >Govern all with {FOCUS_LABEL[focus]} focus</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Planets table
// ---------------------------------------------------------------------------

type SortKey = 'name' | 'system' | 'type' | 'pop' | 'ind' | 'res' | 'pro' | 'gov' | 'build';
type Quick = 'all' | 'manual' | 'governed' | 'issues';

interface Row {
  p: Planet;
  ec: PlanetEcon;
  system: string;
  type: string;
  build: string | null;
  frac: number;
  issues: string[];
}

function PlanetsTab({ w, h }: { w: World; h: Empire }) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'pop', dir: -1 });
  const [q, setQ] = useState('');
  const [quick, setQuick] = useState<Quick>('all');
  const [sel, setSel] = useState<Set<number>>(new Set());

  const all: Row[] = w.planetsOf[h.id].map((id) => {
    const p = w.s.planets[id];
    const ec = w.econ(p);
    const item = p.queue[0];
    const cost = item ? w.itemCost(p, item) : 0;
    return {
      p, ec,
      system: w.s.stars[p.star].name,
      type: PLANET_TYPE[p.type]?.name ?? p.type,
      build: item ? w.itemName(item) : null,
      frac: item && cost > 0 ? Math.min(1, p.progress / cost) : 0,
      issues: issuesOf(p, ec),
    };
  });
  const needle = q.trim().toLowerCase();
  const rows = all
    .filter((r) => !needle || r.p.name.toLowerCase().includes(needle) || r.system.toLowerCase().includes(needle) || r.type.toLowerCase().includes(needle) || (r.build ?? '').toLowerCase().includes(needle))
    .filter((r) => quick === 'all' || (quick === 'manual' ? !r.p.governor.on : quick === 'governed' ? r.p.governor.on : r.issues.length > 0));
  const val = (r: Row): string | number => {
    switch (sort.key) {
      case 'name': return r.p.name;
      case 'system': return r.system + ' ' + r.p.orbit;
      case 'type': return r.type;
      case 'pop': return r.p.pop * 1000 + r.ec.popMax;
      case 'ind': return r.ec.yield.ind;
      case 'res': return r.ec.yield.res;
      case 'pro': return r.ec.yield.pro;
      case 'gov': return (r.p.governor.on ? 10 : 0) + FOCUSES.indexOf(r.p.governor.focus);
      case 'build': return r.build ?? (r.p.project ? '~' + r.p.project : '~~');
    }
  };
  rows.sort((a, b) => {
    const va = val(a), vb = val(b);
    const c = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
    return c * sort.dir || a.p.id - b.p.id;
  });

  // Drop selections that no longer exist (planet lost) or are filtered away.
  const visibleIds = new Set(rows.map((r) => r.p.id));
  const selected = [...sel].filter((id) => visibleIds.has(id));
  const allOn = rows.length > 0 && rows.every((r) => sel.has(r.p.id));
  const toggleSel = (id: number) => { const n = new Set(sel); if (n.has(id)) n.delete(id); else n.add(id); setSel(n); };
  const projects = PROJECTS.filter((pr) => !pr.tech || w.knows(h.id, pr.tech));

  const bulk = (fn: (p: Planet) => void, msg: string) => {
    for (const id of selected) fn(w.s.planets[id]);
    act(undefined, msg);
  };

  const Th = ({ k, label, cls, tip }: { k: SortKey; label: string; cls?: string; tip?: string }) => (
    <th class={cls} data-tip={tip} onClick={() => setSort((s) => ({ key: k, dir: s.key === k ? (-s.dir as 1 | -1) : k === 'name' || k === 'system' || k === 'type' || k === 'build' ? 1 : -1 }))}>
      {label}<span class="arrow">{sort.key === k ? (sort.dir === 1 ? '▲' : '▼') : ''}</span>
    </th>
  );

  const quickCount = (k: Quick) => k === 'all' ? all.length : k === 'manual' ? all.filter((r) => !r.p.governor.on).length : k === 'governed' ? all.filter((r) => r.p.governor.on).length : all.filter((r) => r.issues.length).length;

  return (
    <div>
      <div class="em-toolbar">
        <input type="search" placeholder="Filter by planet, system, type, build…" value={q} onInput={(e) => setQ((e.currentTarget as HTMLInputElement).value)} />
        <div class="seg">
          {(['all', 'manual', 'governed', 'issues'] as Quick[]).map((k) => (
            <button key={k} class={quick === k ? 'on' : ''} onClick={() => setQuick(k)}>
              {k === 'all' ? 'All' : k === 'manual' ? 'Manual' : k === 'governed' ? 'Governed' : 'Needs attention'} <span class="faint">{quickCount(k)}</span>
            </button>
          ))}
        </div>
        <div class="spacer" />
        <span class="tiny dim">Click a row to open the planet</span>
      </div>
      {selected.length > 0 && (
        <div class="em-bulk">
          <b>{plural(selected.length, 'planet')} selected</b>
          <button class="btn sm" onClick={() => bulk((p) => setGovernor(w, p, { on: true }), `Governor on for ${plural(selected.length, 'planet')}.`)}><Icon.gear size={12} />Governor on</button>
          <button class="btn sm" onClick={() => bulk((p) => setGovernor(w, p, { on: false }), `Governor off for ${plural(selected.length, 'planet')}.`)}>Governor off</button>
          <select value="" onChange={(e) => { const f = (e.currentTarget as HTMLSelectElement).value as GovernorFocus; if (f) bulk((p) => setGovernor(w, p, { on: true, focus: f }), `${plural(selected.length, 'planet')} set to ${FOCUS_LABEL[f]} focus.`); }}>
            <option value="">Set focus…</option>
            {FOCUSES.map((f) => <option key={f} value={f}>{FOCUS_LABEL[f]}</option>)}
          </select>
          <select value="" onChange={(e) => { const v = (e.currentTarget as HTMLSelectElement).value; if (!v) return; const pr = v === '-' ? null : v; bulk((p) => setProject(w, p, pr), pr ? `${PROJECT[pr].name} set on ${plural(selected.length, 'planet')}.` : 'Projects cleared.'); }}>
            <option value="">Set idle project…</option>
            <option value="-">No project</option>
            {projects.map((pr) => <option key={pr.id} value={pr.id}>{pr.name}</option>)}
          </select>
          <div class="spacer" />
          <button class="btn sm ghost" onClick={() => setSel(new Set())}>Clear selection</button>
        </div>
      )}
      {rows.length === 0 ? (
        <Empty>{all.length ? 'No planets match this filter.' : 'You have no planets.'}</Empty>
      ) : (
        <table class="list em-table">
          <thead>
            <tr>
              <th class="nosort" style={{ width: 28 }}>
                <input type="checkbox" checked={allOn} onChange={() => setSel(allOn ? new Set() : new Set(rows.map((r) => r.p.id)))} data-tip="Select all shown" />
              </th>
              <th class="nosort" style={{ width: 36 }} />
              <Th k="name" label="Planet" />
              <Th k="system" label="System" cls="hide-sm" />
              <Th k="type" label="Type" cls="hide-sm" />
              <Th k="pop" label="Pop" cls="num" tip="Population / capacity" />
              <Th k="ind" label="Ind" cls="num" />
              <Th k="res" label="Res" cls="num" />
              <Th k="pro" label="Pro" cls="num" />
              <Th k="gov" label="Governor" />
              <Th k="build" label="Building" />
              <th class="nosort">Flags</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => <PlanetRow key={r.p.id} w={w} h={h} r={r} checked={sel.has(r.p.id)} onCheck={() => toggleSel(r.p.id)} />)}
          </tbody>
        </table>
      )}
    </div>
  );
}

function PlanetRow({ w, h, r, checked, onCheck }: { w: World; h: Empire; r: Row; checked: boolean; onCheck: () => void }) {
  const { p, ec } = r;
  const stop = (e: Event) => e.stopPropagation();
  const capital = h.capital === p.id;
  return (
    <tr class={'em-row' + (checked ? ' sel' : '')} onClick={() => gotoPlanet(p)}>
      <td onClick={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) onCheck(); }}><input type="checkbox" checked={checked} onChange={onCheck} /></td>
      <td><PlanetOrb planet={p} size={26} /></td>
      <td class="nm"><div class="ellipsis">{capital && <span style={{ color: 'var(--warn)' }} data-tip="Capital">★ </span>}{p.name}</div></td>
      <td class="hide-sm dim">{r.system}</td>
      <td class="hide-sm dim">{r.type}</td>
      <td class="num">{p.pop}<span class="faint">/{ec.popMax}</span></td>
      <td class="num ind">{fmt(ec.yield.ind, ec.yield.ind < 10 && ec.yield.ind % 1 ? 1 : 0)}</td>
      <td class="num res">{fmt(ec.yield.res, ec.yield.res < 10 && ec.yield.res % 1 ? 1 : 0)}</td>
      <td class="num pro">{fmt(ec.yield.pro, ec.yield.pro < 10 && ec.yield.pro % 1 ? 1 : 0)}</td>
      <td onClick={stop}>
        <div class="em-gov">
          <Switch small on={p.governor.on} tip={p.governor.on ? 'Governor on — click to manage by hand' : 'Managed by hand — click to hand over to a governor'} onToggle={() => { setGovernor(w, p, { on: !p.governor.on }); act(); }} />
          <select
            value={p.governor.focus}
            style={{ opacity: p.governor.on ? 1 : 0.5 }}
            onChange={(e) => { setGovernor(w, p, { focus: (e.currentTarget as HTMLSelectElement).value as GovernorFocus }); act(); }}
          >
            {FOCUSES.map((f) => <option key={f} value={f}>{FOCUS_LABEL[f]}</option>)}
          </select>
        </div>
      </td>
      <td class="build">
        {r.build ? (
          <div data-tip={p.queue.length > 1 ? `${p.queue.length - 1} more queued` : undefined}>
            <div class="row small" style={{ gap: 6 }}>
              <span class="ellipsis">{r.build}</span>
              {p.queue.length > 1 && <span class="faint tiny">+{p.queue.length - 1}</span>}
              <span class="spacer" />
              <span class="faint tiny mono">{Math.round(r.frac * 100)}%</span>
            </div>
            <Bar value={r.frac} max={1} color="var(--ind)" />
          </div>
        ) : p.project ? (
          <span class="chip" data-tip={PROJECT[p.project]?.desc}>{PROJECT[p.project]?.name ?? p.project}</span>
        ) : p.pop > 0 ? (
          <span class="chip warn">Idle</span>
        ) : (
          <span class="faint small">Outpost</span>
        )}
      </td>
      <td>
        <div class="flags">
          {ec.idle.size > 0 && <span class="chip bad" data-tip={`${plural(ec.idle.size, 'structure')} without workers — they produce nothing`}>{ec.idle.size} idle</span>}
          {!!p.besieged && <span class="chip bad" data-tip="Orbital defenses down; enemy fleets are blockading this world">Siege</span>}
          {ec.hasShipyard && <span class="chip" data-tip={ec.hasDocks ? 'Drydock Ring: ships cost 25% less' : 'Shipyard: can build ships'}><Icon.ship size={11} />{ec.hasDocks ? 'Docks' : 'Yard'}</span>}
          {ec.defense > 0 && <span class="chip" data-tip={`Defense rating ${Math.round(ec.defense)}`}><Icon.shield size={11} /></span>}
        </div>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

type Metric = Exclude<keyof EmpireStats, 'day'>;
const METRICS: { k: Metric; label: string; desc: string; color?: string }[] = [
  { k: 'score', label: 'Score', desc: 'Overall standing: population, planets, technology and military combined.' },
  { k: 'planets', label: 'Planets', desc: 'Colonies and outposts held.' },
  { k: 'pop', label: 'Population', desc: 'Total population across the empire.' },
  { k: 'ind', label: 'Industry', desc: 'Industry produced per day.' },
  { k: 'res', label: 'Research', desc: 'Research produced per day.' },
  { k: 'pro', label: 'Prosperity', desc: 'Prosperity produced per day.' },
  { k: 'ships', label: 'Ships', desc: 'Ships in service.' },
  { k: 'military', label: 'Military', desc: 'Combined combat strength of all fleets.' },
  { k: 'techs', label: 'Technologies', desc: 'Technologies known.' },
];

function niceStep(max: number, count = 5) {
  const raw = Math.max(max, 1e-9) / count;
  const p = 10 ** Math.floor(Math.log10(raw));
  const n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

function useWidth(ref: { current: HTMLElement | null }) {
  const [wd, setWd] = useState(800);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWd(el.clientWidth);
    const ro = new ResizeObserver((entries) => setWd(entries[0].contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return wd;
}

/** Last sample at or before `day`. */
function sampleAt(stats: EmpireStats[], day: number): EmpireStats | undefined {
  let best: EmpireStats | undefined;
  for (const s of stats) {
    if (s.day <= day) best = s;
    else break;
  }
  return best;
}

function StatsTab({ w, h }: { w: World; h: Empire }) {
  const [metric, setMetric] = useState<Metric>('score');
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const [hover, setHover] = useState<{ day: number; x: number; y: number } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const width = Math.max(320, useWidth(wrap));
  const height = Math.max(240, Math.min(420, Math.round(width * 0.42)));

  const empires = w.s.empires.filter((o) => o.id === h.id || h.relations[o.id]?.met);
  const series = empires.filter((o) => !hidden.has(o.id) && o.stats.length > 0);
  const m = METRICS.find((x) => x.k === metric)!;

  let maxDay = 0, minDay = Infinity, maxVal = 0;
  for (const o of series) for (const st of o.stats) {
    maxDay = Math.max(maxDay, st.day);
    minDay = Math.min(minDay, st.day);
    maxVal = Math.max(maxVal, st[metric]);
  }
  if (!isFinite(minDay)) minDay = 0;

  const pad = { l: 52, r: 18, t: 14, b: 30 };
  const iw = width - pad.l - pad.r;
  const ih = height - pad.t - pad.b;
  const step = niceStep(maxVal || 1);
  const top = Math.max(step, Math.ceil((maxVal || 1) / step) * step);
  const d0 = Math.min(minDay, maxDay - 10);
  const d1 = Math.max(maxDay, d0 + 10);
  const X = (d: number) => pad.l + ((d - d0) / (d1 - d0)) * iw;
  const Y = (v: number) => pad.t + ih - (v / top) * ih;
  const dayStep = niceStep(d1 - d0, Math.max(2, Math.floor(iw / 90)));
  const xTicks: number[] = [];
  for (let d = Math.ceil(d0 / dayStep) * dayStep; d <= d1; d += dayStep) xTicks.push(d);
  const yTicks: number[] = [];
  for (let v = 0; v <= top + 1e-9; v += step) yTicks.push(v);

  const enough = empires.some((o) => o.stats.length >= 2);

  const onMove = (e: JSX.TargetedPointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (x < pad.l || x > pad.l + iw) { setHover(null); return; }
    const day = d0 + ((x - pad.l) / iw) * (d1 - d0);
    // Snap to the nearest 10-day sample boundary.
    const snapped = Math.max(d0, Math.min(d1, Math.round(day / 10) * 10));
    setHover({ day: snapped, x: X(snapped), y: e.clientY - rect.top });
  };

  const readout = hover
    ? series
      .map((o) => ({ o, s: sampleAt(o.stats, hover.day) }))
      .filter((r): r is { o: Empire; s: EmpireStats } => !!r.s)
      .sort((a, b) => b.s[metric] - a.s[metric])
    : [];

  const fmtV = (v: number) => (step < 1 ? v.toFixed(1) : fmt(v));

  return (
    <div class="em-stats">
      <div class="row wrap" style={{ gap: 10 }}>
        <div class="seg" style={{ flexWrap: 'wrap' }}>
          {METRICS.map((x) => <button key={x.k} class={metric === x.k ? 'on' : ''} onClick={() => setMetric(x.k)}>{x.label}</button>)}
        </div>
        <span class="em-metric-desc">{m.desc} Sampled every 10 days.</span>
      </div>
      <div class="em-card" style={{ padding: 10 }}>
        <div class="em-chart-wrap" ref={wrap}>
          {!enough ? (
            <Empty>History is recorded every 10 days. Come back after a few weeks of play to compare empires.</Empty>
          ) : (
            <svg width={width} height={height} style={{ display: 'block' }} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
              {yTicks.map((v) => (
                <g key={'y' + v}>
                  <line x1={pad.l} x2={pad.l + iw} y1={Y(v)} y2={Y(v)} stroke="rgba(130,160,255,0.1)" stroke-dasharray={v === 0 ? undefined : '3 4'} />
                  <text x={pad.l - 8} y={Y(v) + 4} text-anchor="end">{fmtV(v)}</text>
                </g>
              ))}
              {xTicks.map((d) => (
                <g key={'x' + d}>
                  <line x1={X(d)} x2={X(d)} y1={pad.t + ih} y2={pad.t + ih + 4} stroke="rgba(130,160,255,0.35)" />
                  <text x={X(d)} y={pad.t + ih + 18} text-anchor={X(d) > pad.l + iw - 30 ? 'end' : X(d) < pad.l + 30 ? 'start' : 'middle'}>Day {Math.round(d)}</text>
                </g>
              ))}
              <line x1={pad.l} x2={pad.l} y1={pad.t} y2={pad.t + ih} stroke="rgba(130,160,255,0.3)" />
              <line x1={pad.l} x2={pad.l + iw} y1={pad.t + ih} y2={pad.t + ih} stroke="rgba(130,160,255,0.3)" />
              {series.map((o) => {
                const pts = o.stats.map((s) => `${X(s.day).toFixed(1)},${Y(s[metric]).toFixed(1)}`).join(' ');
                const me = o.id === h.id;
                const last = o.stats[o.stats.length - 1];
                return (
                  <g key={o.id}>
                    {me && <polyline points={pts} fill="none" stroke={o.color} stroke-width="7" stroke-opacity="0.15" stroke-linejoin="round" />}
                    <polyline points={pts} fill="none" stroke={o.color} stroke-width={me ? 2.6 : 1.7} stroke-linejoin="round" stroke-linecap="round" stroke-opacity={o.alive ? 1 : 0.5} stroke-dasharray={o.alive ? undefined : '5 4'} />
                    <circle cx={X(last.day)} cy={Y(last[metric])} r={me ? 3.5 : 2.5} fill={o.color} />
                  </g>
                );
              })}
              {hover && (
                <g pointer-events="none">
                  <line x1={hover.x} x2={hover.x} y1={pad.t} y2={pad.t + ih} stroke="rgba(223,230,255,0.4)" />
                  {readout.map(({ o, s }) => <circle key={o.id} cx={X(s.day)} cy={Y(s[metric])} r="4" fill={o.color} stroke="#03040a" stroke-width="1.5" />)}
                </g>
              )}
              <rect x={pad.l} y={pad.t} width={iw} height={ih} fill="transparent" />
            </svg>
          )}
          {hover && readout.length > 0 && (
            <div class="em-readout" style={{ left: hover.x > width / 2 ? hover.x - 190 : hover.x + 14, top: Math.max(0, Math.min(hover.y - 20, height - 40 - readout.length * 20)) }}>
              <div class="caps" style={{ marginBottom: 6 }}>Day {hover.day} · {m.label}</div>
              {readout.map(({ o, s }) => (
                <div class="row" key={o.id} style={{ fontWeight: o.id === h.id ? 700 : 400 }}>
                  <span class="row ellipsis" style={{ gap: 6 }}><EmpireDot color={o.color} size={8} />{o.id === h.id ? 'You' : o.name}</span>
                  <span class="mono">{fmtV(s[metric])}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <div class="em-legend">
        {empires.map((o) => {
          const last = o.stats[o.stats.length - 1];
          const off = hidden.has(o.id);
          return (
            <button
              key={o.id}
              class={off ? 'off' : ''}
              data-tip={off ? 'Show' : 'Hide'}
              onClick={() => { const n = new Set(hidden); if (off) n.delete(o.id); else n.add(o.id); setHidden(n); }}
            >
              <EmpireDot color={o.color} size={9} />
              <span style={{ fontWeight: o.id === h.id ? 700 : 500 }}>{o.id === h.id ? `${o.name} (you)` : o.name}</span>
              {!o.alive && <span class="chip bad">eliminated</span>}
              <span class="val">{last ? fmtV(last[metric]) : '—'}</span>
            </button>
          );
        })}
      </div>
      {empires.length === 1 && <div class="tiny dim">Only empires you have met appear here. Explore to find your neighbours.</div>}
      <Section title="Current standings">
        <table class="list">
          <thead>
            <tr><th class="nosort">Empire</th>{METRICS.map((x) => <th key={x.k} class="nosort" style={{ textAlign: 'right', color: x.k === metric ? 'var(--accent)' : undefined }} onClick={() => setMetric(x.k)}>{x.label}</th>)}</tr>
          </thead>
          <tbody>
            {[...empires].sort((a, b) => (b.stats.at(-1)?.[metric] ?? 0) - (a.stats.at(-1)?.[metric] ?? 0)).map((o) => {
              const last = o.stats.at(-1);
              return (
                <tr key={o.id} style={{ cursor: 'default' }}>
                  <td><span class="row" style={{ gap: 6 }}><EmpireDot color={o.color} size={8} /><span style={{ fontWeight: o.id === h.id ? 700 : 400 }}>{o.name}</span></span></td>
                  {METRICS.map((x) => <td key={x.k} class="mono" style={{ textAlign: 'right', color: x.k === metric ? 'var(--text)' : 'var(--text-dim)' }}>{last ? fmt(last[x.k]) : '—'}</td>)}
                </tr>
              );
            })}
          </tbody>
        </table>
      </Section>
    </div>
  );
}


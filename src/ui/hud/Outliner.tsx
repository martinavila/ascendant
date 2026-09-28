import { useState } from 'preact/hooks';
import { store, useStore } from '../store';
import { Icon, PlanetOrb, ShipImage } from '../icons';
import { Bar, Empty, fmt } from '../common';
import type { EventKind } from '../../sim/types';

type Tab = 'planets' | 'fleets' | 'events';

const EVENT_GROUPS: { label: string; kinds: EventKind[] }[] = [
  { label: 'All', kinds: [] },
  { label: 'War', kinds: ['combat', 'invasion', 'lost'] },
  { label: 'Empire', kinds: ['research', 'build', 'colony', 'growth', 'idle', 'warning'] },
  { label: 'Contact', kinds: ['diplomacy', 'firstContact'] },
  { label: 'Discovery', kinds: ['discovery', 'ability', 'victory'] },
];

const KIND_COLOR: Partial<Record<EventKind, string>> = {
  combat: 'var(--bad)', invasion: 'var(--bad)', lost: 'var(--bad)', research: 'var(--res)', colony: 'var(--good)', diplomacy: 'var(--accent-2)',
  firstContact: 'var(--accent-2)', discovery: 'var(--warn)', warning: 'var(--warn)', victory: 'var(--warn)', build: 'var(--ind)', idle: 'var(--warn)',
};

/**
 * Planets / fleets / log. Desktop: a panel on the left. Compact screens: a
 * slide-in drawer (`drawer`), closed after picking something.
 */
export function Outliner({ drawer, onClose }: { drawer?: boolean; onClose?: () => void }) {
  const st = useStore();
  const w = st.world!;
  const e = w.human()!;
  const [tab, setTab] = useState<Tab>('planets');
  const [collapsed, setCollapsed] = useState(false);
  const [group, setGroup] = useState(0);
  const [sort, setSort] = useState<'name' | 'pop' | 'ind' | 'res'>('pop');

  const done = () => { if (drawer) onClose?.(); };
  if (collapsed && !drawer) {
    return (
      <div class="panel left collapsed">
        <button class="btn ghost" onClick={() => setCollapsed(false)} data-tip="Show outliner"><Icon.menu /> Outliner</button>
      </div>
    );
  }

  const planets = w.planetsOf[e.id].map((id) => w.s.planets[id]);
  planets.sort((a, b) => {
    if (sort === 'name') return a.name.localeCompare(b.name);
    if (sort === 'pop') return b.pop - a.pop;
    const ea = w.econ(a).yield, eb = w.econ(b).yield;
    return sort === 'ind' ? eb.ind - ea.ind : eb.res - ea.res;
  });
  const fleets = Object.values(w.s.fleets).filter((f) => f.owner === e.id);
  const kinds = EVENT_GROUPS[group].kinds;
  const events = w.s.events.filter((ev) => ev.empire === e.id && (!kinds.length || kinds.includes(ev.kind))).slice(-200).reverse();

  const body = (
    <div class={'panel left' + (drawer ? ' drawer' : '')}>
      <div class="tabs">
        <button class={tab === 'planets' ? 'on' : ''} onClick={() => setTab('planets')}>Planets {planets.length}</button>
        <button class={tab === 'fleets' ? 'on' : ''} onClick={() => setTab('fleets')}>Fleets {fleets.length}</button>
        <button class={tab === 'events' ? 'on' : ''} onClick={() => setTab('events')}>Log</button>
        <button style={{ flex: '0 0 44px' }} onClick={() => (drawer ? onClose?.() : setCollapsed(true))} data-tip={drawer ? 'Close' : 'Collapse'} aria-label="Close"><Icon.close size={14} /></button>
      </div>
      {tab === 'planets' && (
        <>
          <div class="row small" style={{ padding: '6px 10px', gap: 6 }}>
            <span class="dim">Sort</span>
            <div class="seg">
              {(['pop', 'ind', 'res', 'name'] as const).map((s) => <button key={s} class={sort === s ? 'on' : ''} onClick={() => setSort(s)}>{s === 'pop' ? 'Pop' : s === 'ind' ? 'Ind' : s === 'res' ? 'Res' : 'A–Z'}</button>)}
            </div>
          </div>
          <div class="scroll" style={{ flex: 1, padding: '0 6px 6px' }}>
            {planets.map((p) => {
              const ec = w.econ(p);
              const head = p.queue[0];
              const idle = !head && !p.governor.on && !p.project;
              return (
                <div key={p.id} class={'fleet-row ' + (st.sel.planet === p.id ? 'sel' : '')} onClick={() => { store.select({ planet: p.id, star: p.star, fleet: null }); store.focus(p.star); done(); }}>
                  <PlanetOrb planet={p} size={30} />
                  <div class="grow" style={{ minWidth: 0 }}>
                    <div class="row small" style={{ gap: 5 }}>
                      <b class="ellipsis grow">{p.name}</b>
                      {p.governor.on && <span data-tip={`Governed (${p.governor.focus})`} style={{ color: 'var(--accent)' }}><Icon.gear size={12} /></span>}
                      {e.capital === p.id && <span data-tip="Capital" style={{ color: 'var(--warn)' }}><Icon.star size={12} /></span>}
                      {ec.idle.size > 0 && <span class="chip bad" style={{ padding: '0 5px' }} data-tip={`${ec.idle.size} structures idle for lack of workers`}>{ec.idle.size}</span>}
                      {p.besieged ? <span class="chip bad" style={{ padding: '0 5px' }}>siege</span> : null}
                    </div>
                    <div class="row tiny dim" style={{ gap: 8 }}>
                      <span class="pop">{p.pop}/{ec.popMax}</span>
                      <span class="ind">{fmt(ec.yield.ind)}</span>
                      <span class="res">{fmt(ec.yield.res)}</span>
                      <span class="ellipsis grow" style={{ textAlign: 'right' }}>{head ? w.itemName(head) : idle ? <span class="warn">idle</span> : p.project ? p.project : p.governor.on ? 'governed' : ''}</span>
                    </div>
                    {head && <Bar value={p.progress} max={w.itemCost(p, head)} color="var(--ind)" style={{ height: 3, marginTop: 2 }} />}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
      {tab === 'fleets' && (
        <div class="scroll" style={{ flex: 1, padding: 6 }}>
          {!fleets.length && <Empty>No fleets. Build ships at a planet with a shipyard.</Empty>}
          {fleets.map((f) => {
            const first = w.s.ships[f.ships[0]];
            const dest = f.route.length ? w.s.stars[f.route[f.route.length - 1]].name : null;
            return (
              <div key={f.id} class={'fleet-row ' + (st.sel.fleet === f.id ? 'sel' : '')} onClick={() => { store.select({ fleet: f.id, star: f.star, planet: null }); store.focus(dest && f.transit ? f.route[0] : f.star); done(); }}>
                <ShipImage species={e.species} hull={first?.hull ?? 'small'} color={e.color} size={30} />
                <div class="grow" style={{ minWidth: 0 }}>
                  <div class="row small"><b class="ellipsis grow">{f.name}</b><span class="dim">{f.ships.length}</span></div>
                  <div class="tiny dim ellipsis">{dest ? `→ ${dest}` : `at ${w.s.stars[f.star].name}`}{f.order.kind !== 'none' ? ` · ${f.order.kind}` : ''} · {f.stance}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {tab === 'events' && (
        <>
          <div class="row wrap" style={{ padding: '6px 8px', gap: 4 }}>
            {EVENT_GROUPS.map((g, i) => <button key={i} class={'btn sm ' + (group === i ? 'active' : 'ghost')} onClick={() => setGroup(i)}>{g.label}</button>)}
          </div>
          <div class="scroll" style={{ flex: 1, padding: '0 6px 6px' }}>
            {!events.length && <Empty>Nothing yet.</Empty>}
            {events.map((ev) => (
              <div key={ev.id} class={'event ' + (ev.important ? 'imp' : '')} onClick={() => {
                done();
                if (ev.battle) store.open('battle', { battle: ev.battle });
                else if (ev.planet !== undefined) { store.select({ planet: ev.planet, star: w.s.planets[ev.planet].star, fleet: null }); store.focus(w.s.planets[ev.planet].star); }
                else if (ev.star !== undefined) { store.select({ star: ev.star, planet: null }); store.focus(ev.star); }
                else if (ev.kind === 'research') store.open('research');
                else if (ev.kind === 'diplomacy' || ev.kind === 'firstContact') store.open('diplomacy');
              }}>
                <span class="d">d{ev.day}</span>
                <span style={{ color: KIND_COLOR[ev.kind] ?? 'var(--text)' }}>{ev.text}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
  if (!drawer) return body;
  return (
    <div class="drawer-wrap" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      {body}
    </div>
  );
}

import { useState } from 'preact/hooks';
import { store, useStore } from '../store';
import { Icon, ShipImage, PartIcon } from '../icons';
import { Bar, Section, act, fmt, Empty } from '../common';
import { merge, moveFleet, orderColonize, orderInvade, renameFleet, setStance, split, refitFleetTo } from '../../sim/commands';
import { abilityCheck, useAbility } from '../../sim/abilities';
import { invasionDefense, planetDefended } from '../../sim/fleets';
import { PART } from '../../sim/content';
import type { Fleet, FleetStance } from '../../sim/types';

const STANCES: { v: FleetStance; label: string; tip: string }[] = [
  { v: 'aggressive', label: 'Aggressive', tip: 'Attack enemies (at war) wherever this fleet goes, including planets with defenses.' },
  { v: 'defensive', label: 'Defensive', tip: 'Fight only when enemies are at a system we hold, or when attacked.' },
  { v: 'evasive', label: 'Evasive', tip: 'Avoid combat: tries to slip away before battle and retreats to where it came from.' },
];

export function FleetPanel({ fleet }: { fleet: Fleet }) {
  const st = useStore();
  const w = st.world!;
  const human = w.human()!;
  const mine = fleet.owner === human.id;
  const owner = w.s.empires[fleet.owner];
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [name, setName] = useState<string | null>(null);
  const speed = w.fleetSpeed(fleet);
  const star = w.s.stars[fleet.star];
  const dest = fleet.route.length ? w.s.stars[fleet.route[fleet.route.length - 1]] : null;
  const eta = fleet.route.length ? w.routeDays(fleet.transit > 0 ? fleet.route[0] : fleet.star, fleet.transit > 0 ? fleet.route.slice(1) : fleet.route, speed) + (fleet.transit > 0 ? fleet.transitTotal - fleet.transit : 0) : 0;
  const stats = fleet.ships.map((id) => ({ ship: w.s.ships[id], st: w.statsOf(w.s.ships[id]) }));
  const colony = stats.some((x) => x.st.colony > 0);
  const outpost = stats.some((x) => x.st.outpost > 0);
  const troops = stats.reduce((a, x) => a + x.st.invasion * 12, 0);
  const here = fleet.transit === 0 ? star.planets.map((id) => w.s.planets[id]) : [];
  const others = mine && fleet.transit === 0 ? w.fleetsAtStar(fleet.star).filter((f) => f.owner === human.id && f.id !== fleet.id && f.transit === 0) : [];
  const sp = w.species(human);
  const designs = Object.values(w.s.designs).filter((d) => d.owner === human.id && !d.obsolete && stats.some((x) => x.ship.hull === d.hull));
  const atYard = mine && fleet.transit === 0 && w.planetsOf[human.id].some((id) => w.s.planets[id].star === fleet.star && w.econ(w.s.planets[id]).hasShipyard);

  const pickMove = () => {
    store.pick = {
      kind: 'move', hint: `Move ${fleet.name}: click a destination star`, onPick: (s) => {
        store.pick = null;
        act(moveFleet(w, fleet, s));
      },
    };
    store.emit();
  };

  if (!mine) {
    return (
      <div class="col scroll" style={{ gap: 0, flex: 1 }}>
        <div class="section">
          <div class="row"><span class="dot" style={{ background: owner.color }} /><h2 style={{ fontSize: 18 }}>{fleet.name}</h2></div>
          <div class="dim small">{owner.name} · {w.atWar(human.id, owner.id) ? <span class="bad">at war</span> : w.allied(human.id, owner.id) ? <span class="good">allied</span> : 'at peace'}</div>
          <div class="small" style={{ marginTop: 6 }}>{fleet.ships.length} ships · estimated strength <b>{fmt(w.fleetStrength(fleet))}</b></div>
          {fleet.route.length > 0 && <div class="small dim">Moving{w.allied(human.id, owner.id) && dest ? ` to ${dest.name}` : ''}</div>}
        </div>
        <Section title="Ships">
          {stats.map(({ ship, st: s }) => (
            <div key={ship.id} class="row" style={{ padding: '4px 0' }}>
              <ShipImage species={owner.species} hull={ship.hull} color={owner.color} size={30} />
              <div class="grow"><div class="small">{ship.name}</div><Bar value={ship.hp} max={s.hp} color={owner.color} /></div>
            </div>
          ))}
        </Section>
      </div>
    );
  }

  return (
    <div class="col" style={{ gap: 0, flex: 1, minHeight: 0 }}>
      <div class="section">
        <div class="row">
          <span class="dot" style={{ background: owner.color }} />
          {name === null ? (
            <h2 style={{ fontSize: 18, cursor: 'text' }} onClick={() => setName(fleet.name)} data-tip="Click to rename">{fleet.name}</h2>
          ) : (
            <input value={name} autoFocus onInput={(e) => setName((e.target as HTMLInputElement).value)} onBlur={() => { renameFleet(w, fleet, name); setName(null); store.emit(); }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
          )}
        </div>
        <div class="small dim" style={{ marginTop: 4 }}>
          {fleet.transit > 0 ? `In transit` : `At ${star.name}`}
          {dest && <> → <b style={{ color: 'var(--text)' }}>{dest.name}</b> in {eta} day{eta === 1 ? '' : 's'}</>}
          {' · '}speed {speed.toFixed(2)}{w.fleetCanUseUnstable(fleet) ? ' · can cross unstable lanes' : ''}
        </div>
        <div class="row wrap" style={{ marginTop: 10, gap: 6 }}>
          <button class="btn sm primary" onClick={pickMove} data-tip="Pick a destination on the map (or right-click a star with this fleet selected)"><Icon.route size={14} /> Move</button>
          {fleet.route.length > 0 && <button class="btn sm" onClick={() => { fleet.route = fleet.transit > 0 ? [fleet.route[0]] : []; act(); }}>Stop</button>}
          <button class={'btn sm ' + (fleet.order.kind === 'explore' ? 'active' : '')} onClick={() => { fleet.order = fleet.order.kind === 'explore' ? { kind: 'none' } : { kind: 'explore' }; act(); }} data-tip="Automatically visit the nearest unexplored stars">Auto-explore</button>
          {sp.ability.target === 'fleet' && (
            <button class="btn sm" disabled={!!abilityCheck(w, human.id, { fleet: fleet.id, star: fleet.star }) && w.s.day < human.abilityReadyDay} onClick={() => {
              store.pick = { kind: 'ability', hint: `${sp.ability.name}: choose a destination`, onPick: (s) => { store.pick = null; const err = useAbility(w, human.id, { fleet: fleet.id, star: s }); if (err) store.notify(err, 'error'); store.emit(); } };
              store.emit();
            }} data-tip={sp.ability.desc}><Icon.bolt size={12} /> {sp.ability.name}</button>
          )}
        </div>
        <div style={{ marginTop: 10 }}>
          <div class="seg">
            {STANCES.map((s) => <button key={s.v} class={fleet.stance === s.v ? 'on' : ''} onClick={() => { setStance(w, fleet, s.v); store.emit(); }} data-tip={s.tip}>{s.label}</button>)}
          </div>
        </div>
      </div>
      <div class="scroll" style={{ flex: 1 }}>
        {(colony || outpost || troops > 0) && here.length > 0 && (
          <Section title="Orders here">
            {here.map((p) => {
              const owner2 = p.owner !== null ? w.s.empires[p.owner] : null;
              const canCol = colony && (!owner2 || (p.owner === human.id && p.pop === 0)) && p.type !== 'gasgiant';
              const canOut = (outpost || colony) && !owner2;
              const canInv = troops > 0 && owner2 && owner2.id !== human.id;
              if (!canCol && !canOut && !canInv) return null;
              const def = canInv ? invasionDefense(w, p) : 0;
              return (
                <div key={p.id} class="row small" style={{ padding: '4px 0' }}>
                  <span class="grow ellipsis">{p.name}</span>
                  {canCol && <button class="btn sm primary" onClick={() => act(orderColonize(w, fleet, p.id), 'Colony founded.')}>Colonize</button>}
                  {canOut && !canCol && <button class="btn sm" onClick={() => act(orderColonize(w, fleet, p.id, true))}>Outpost</button>}
                  {canInv && <button class="btn sm danger" disabled={planetDefended(p)} onClick={() => act(orderInvade(w, fleet, p.id))} data-tip={planetDefended(p) ? 'Destroy its orbital defenses first.' : `Troops ${troops} vs defense ${def} (±15%)`}>Invade {troops}/{def}</button>}
                </div>
              );
            })}
          </Section>
        )}
        {fleet.order.kind !== 'none' && fleet.order.kind !== 'explore' && fleet.order.kind !== 'patrol' && (
          <div class="section small">Standing order: <b>{fleet.order.kind}</b> {w.s.planets[fleet.order.planet]?.name} <button class="btn sm ghost" onClick={() => { fleet.order = { kind: 'none' }; act(); }}>Cancel</button></div>
        )}
        <Section title={`Ships · ${fleet.ships.length}`} right={picked.size > 0 && picked.size < fleet.ships.length && fleet.transit === 0 ? <button class="btn sm" onClick={() => { split(w, fleet, [...picked]); setPicked(new Set()); store.emit(); }}>Split {picked.size}</button> : null}>
          {stats.map(({ ship, st: s }) => {
            const d = w.s.designs[ship.design];
            const newer = d && Object.values(w.s.designs).some((x) => x.owner === human.id && x.role === d.role && x.hull === ship.hull && x.created > d.created && !x.obsolete);
            const differs = d && ship.parts.some((p, i) => p !== d.parts[i]);
            return (
              <div key={ship.id} class="row" style={{ padding: '5px 0', borderBottom: '1px solid rgba(130,160,255,0.06)' }}>
                <input type="checkbox" checked={picked.has(ship.id)} onChange={() => { const n = new Set(picked); n.has(ship.id) ? n.delete(ship.id) : n.add(ship.id); setPicked(n); }} />
                <ShipImage species={human.species} hull={ship.hull} color={human.color} size={34} />
                <div class="grow" style={{ minWidth: 0 }}>
                  <div class="row small" style={{ gap: 6 }}>
                    <b class="ellipsis">{ship.name}</b>
                    {newer && <span class="chip warn" data-tip="A newer design exists for this role — refit at a shipyard">outdated</span>}
                    {differs && <span class="chip" data-tip="Refitted: differs from its design">custom</span>}
                    {ship.kills > 0 && <span class="chip good">{ship.kills} kills</span>}
                  </div>
                  <div class="row tiny dim" style={{ gap: 8 }}>
                    <span>{d?.name}</span><span class="stat">{Icon.sword({ size: 11 })}{fmt(s.attack)}</span><span class="stat">{Icon.shield({ size: 11 })}{fmt(s.shield)}</span><span>spd {s.speed.toFixed(1)}</span>
                  </div>
                  <Bar value={ship.hp} max={s.hp} color={ship.hp / s.hp < 0.4 ? 'var(--bad)' : 'var(--good)'} style={{ marginTop: 3 }} />
                  {s.warnings.length > 0 && <div class="tiny warn">{s.warnings[0]}</div>}
                  <div class="row" style={{ gap: 2, marginTop: 3, flexWrap: 'wrap' }}>
                    {ship.parts.filter(Boolean).map((p, i) => <span key={i} data-tip={`${PART[p].name}${s.powered[ship.parts.indexOf(p)] === false ? ' (unpowered)' : ''}`}><PartIcon id={p} size={18} /></span>)}
                  </div>
                </div>
              </div>
            );
          })}
        </Section>
        {atYard && designs.length > 0 && (
          <Section title="Refit at shipyard">
            <div class="dim small" style={{ marginBottom: 6 }}>Refits swap individual components; each ship keeps its name and battle record.</div>
            <div class="row wrap" style={{ gap: 6 }}>
              {designs.map((d) => <button key={d.id} class="btn sm" onClick={() => act(refitFleetTo(w, fleet, d.id), `Refits queued to match ${d.name}.`)}>→ {d.name}</button>)}
              <button class="btn sm ghost" onClick={() => store.open('designer', { refitFleet: fleet.id })}>Designer…</button>
            </div>
          </Section>
        )}
        {others.length > 0 && (
          <Section title="Other fleets here">
            {others.map((f) => (
              <div key={f.id} class="row small" style={{ padding: '3px 0' }}>
                <span class="grow">{f.name} ({f.ships.length})</span>
                <button class="btn sm" onClick={() => { merge(w, fleet, f); store.emit(); }}>Merge in</button>
              </div>
            ))}
          </Section>
        )}
        {!stats.length && <Empty>Empty fleet.</Empty>}
      </div>
    </div>
  );
}

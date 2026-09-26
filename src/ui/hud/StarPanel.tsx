import { store, useStore } from '../store';
import { PlanetOrb, Icon, ShipImage } from '../icons';
import { Section, Yields, act, fmt, Empty } from '../common';
import { PLANET_TYPE } from '../../sim/content';
import { STAR_LABEL, sunCanvas } from '../../art/procedural';
import { classicSun } from '../../art/classic';
import { fleetVisible } from '../../sim/visibility';
import { orderColonize } from '../../sim/commands';
import { abilityCheck, useAbility } from '../../sim/abilities';
import type { Planet } from '../../sim/types';
import { useMemo } from 'preact/hooks';

const SIZE_NAME = ['Tiny', 'Small', 'Medium', 'Large', 'Huge'];

export function StarPanel({ starId }: { starId: number }) {
  const st = useStore();
  const w = st.world!;
  const human = w.human()!;
  const star = w.s.stars[starId];
  const ex = human.explored[starId];
  const planets = star.planets.map((id) => w.s.planets[id]);
  const fleets = w.fleetsAtStar(starId).filter((f) => f.transit === 0 && fleetVisible(w, human.id, f));
  const sunUrl = useMemo(() => (st.settings.classicArt && classicSun(star.cls)) || sunCanvas(star.cls, 256).toDataURL(), [star.cls, st.settings.classicArt]);
  const colonizers = fleets.filter((f) => f.owner === human.id && f.ships.some((id) => { const s = w.statsOf(w.s.ships[id]); return s.colony > 0 || s.outpost > 0; }));
  const sp = w.species(human);

  const open = (p: Planet) => store.select({ planet: p.id, star: starId });

  return (
    <div class="col" style={{ gap: 0, minHeight: 0, flex: 1 }}>
      <div class="section" style={{ position: 'relative', overflow: 'hidden', minHeight: 150 }}>
        <img src={sunUrl} style={{ position: 'absolute', right: -60, top: -50, width: 230, height: 230, opacity: 0.9, pointerEvents: 'none' }} />
        <div style={{ position: 'relative' }}>
          <h2 style={{ fontSize: 22 }}>{star.name}</h2>
          <div class="dim small">{STAR_LABEL[star.cls]} · {star.lanes.length} lane{star.lanes.length === 1 ? '' : 's'}{star.lanes.some((l) => w.s.lanes[l].unstable) ? ' (some unstable)' : ''}</div>
          {ex === 0 && <div class="warn small" style={{ marginTop: 8 }}>Unexplored. Send a ship to survey it.</div>}
          {ex === 1 && <div class="dim small" style={{ marginTop: 8 }}>Charted from afar. Details appear once a ship or sensor reaches it.</div>}
          {ex === 2 && (
            <div class="row wrap" style={{ marginTop: 10, gap: 6, maxWidth: 240 }}>
              {[...w.ownerAtStar(starId)].map((o) => <span key={o} class="chip" style={{ borderColor: w.s.empires[o].color }}><span class="dot" style={{ background: w.s.empires[o].color }} />{w.s.empires[o].name}</span>)}
              {!w.ownerAtStar(starId).size && <span class="chip">Unclaimed system</span>}
            </div>
          )}
        </div>
      </div>
      <div class="scroll" style={{ flex: 1 }}>
        {ex === 2 && (
          <Section title={`Planets · ${planets.length}`}>
            {!planets.length && <Empty>No planets — just the star.</Empty>}
            {planets.map((p) => {
              const owner = p.owner !== null ? w.s.empires[p.owner] : null;
              const mine = p.owner === human.id;
              const ec = w.econ(p);
              const abilityOk = sp.ability.target === 'planet' && !abilityCheck(w, human.id, { planet: p.id });
              return (
                <div key={p.id} class={'sysplanet ' + (st.sel.planet === p.id ? 'sel' : '')} onClick={() => open(p)}>
                  <PlanetOrb planet={p} size={24 + p.size * 8} />
                  <div class="grow">
                    <div class="row" style={{ gap: 6 }}>
                      <b class="ellipsis">{p.name}</b>
                      {owner && <span class="dot" style={{ background: owner.color }} data-tip={owner.name} />}
                      {p.ruins && !p.ruins.dug && <span class="chip warn" data-tip="Ancient ruins: research Xenoarchaeology and build an Excavation Site. The reward is fixed — reloading won't change it.">Ruins</span>}
                      {p.besieged ? <span class="chip bad">Besieged</span> : null}
                    </div>
                    <div class="dim small">{SIZE_NAME[p.size]} {PLANET_TYPE[p.type].name}{w.isFavored(p, human.id) ? <span class="good"> · favored</span> : ''}</div>
                    {mine ? (
                      <div class="row small" style={{ gap: 10, marginTop: 2 }}>
                        <span class="stat">{Icon.pop({ size: 12 })}{p.pop}/{ec.popMax}</span>
                        <Yields ind={ec.yield.ind} res={ec.yield.res} pro={ec.yield.pro} size={12} />
                      </div>
                    ) : owner ? (
                      <div class="small dim">Pop {p.pop}{w.visible[human.id]?.[starId] ? '' : ' (last seen)'}</div>
                    ) : (
                      <div class="small dim">{p.tiles.filter((t) => t.c !== 'black').length} buildable tiles · {p.orbitals.length} orbital slots</div>
                    )}
                  </div>
                  <div class="col" style={{ gap: 4, alignItems: 'flex-end' }}>
                    {!owner && colonizers.length > 0 && p.type !== 'gasgiant' && colonizers.some((f) => f.ships.some((id) => w.statsOf(w.s.ships[id]).colony > 0)) && (
                      <button class="btn sm primary" onClick={(ev) => { ev.stopPropagation(); act(orderColonize(w, colonizers.find((f) => f.ships.some((id) => w.statsOf(w.s.ships[id]).colony > 0))!, p.id), 'Colonists are landing.'); }}>Colonize</button>
                    )}
                    {!owner && colonizers.some((f) => f.ships.some((id) => w.statsOf(w.s.ships[id]).outpost > 0)) && (
                      <button class="btn sm" onClick={(ev) => { ev.stopPropagation(); act(orderColonize(w, colonizers.find((f) => f.ships.some((id) => w.statsOf(w.s.ships[id]).outpost > 0))!, p.id, true), 'Outpost established.'); }}>Outpost</button>
                    )}
                    {abilityOk && (
                      <button class="btn sm" onClick={(ev) => { ev.stopPropagation(); const err = useAbility(w, human.id, { planet: p.id }); if (err) store.notify(err, 'error'); store.emit(); }} data-tip={sp.ability.desc}><Icon.bolt size={12} />{sp.ability.name}</button>
                    )}
                  </div>
                </div>
              );
            })}
          </Section>
        )}
        <Section title={`Fleets · ${fleets.length}`}>
          {!fleets.length && <Empty>No visible fleets here.</Empty>}
          {fleets.map((f) => {
            const o = w.s.empires[f.owner];
            const first = w.s.ships[f.ships[0]];
            return (
              <div key={f.id} class={'fleet-row ' + (st.sel.fleet === f.id ? 'sel' : '')} onClick={() => store.select({ fleet: f.id })}>
                <ShipImage species={o.species} hull={first?.hull ?? 'small'} color={o.color} size={34} />
                <div class="grow">
                  <div class="row" style={{ gap: 6 }}><span class="dot" style={{ background: o.color }} /><b class="ellipsis">{f.name}</b></div>
                  <div class="small dim">{f.ships.length} ship{f.ships.length === 1 ? '' : 's'} · strength {fmt(w.fleetStrength(f))}{f.owner !== human.id ? ` · ${w.atWar(human.id, f.owner) ? 'hostile' : w.allied(human.id, f.owner) ? 'allied' : 'neutral'}` : ''}</div>
                </div>
              </div>
            );
          })}
        </Section>
      </div>
    </div>
  );
}

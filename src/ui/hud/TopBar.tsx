import { useState } from 'preact/hooks';
import { store, useStore } from '../store';
import { Icon, Portrait } from '../icons';
import { Bar, fmt } from '../common';
import { TECH } from '../../sim/content';
import { abilityCheck, abilityReady, useAbility } from '../../sim/abilities';

export const SPEEDS = [
  { v: 2, label: 'Slow', key: '1' },
  { v: 6, label: 'Normal', key: '2' },
  { v: 20, label: 'Fast', key: '3' },
];

export function TopBar({ onMenu }: { onMenu: () => void }) {
  const st = useStore();
  const w = st.world!;
  const e = w.human();
  const [abilityMenu, setAbilityMenu] = useState(false);
  if (!e) return null;
  const sp = w.species(e);
  const r = e.research;
  const cost = r.current ? w.techCost(e.id, r.current) : 0;
  const eta = r.current ? Math.max(0, Math.ceil((cost - r.progress) / Math.max(0.1, e.last.res))) : 0;
  const inbox = w.s.proposals.filter((p) => p.to === e.id).length;
  const ready = abilityReady(w, e.id);
  const planets = w.planetsOf[e.id].length;
  const ships = Object.values(w.s.ships).filter((s) => s.owner === e.id).length;
  const idle = w.planetsOf[e.id].filter((id) => { const p = w.s.planets[id]; return !p.queue.length && !p.governor.on && !p.project; }).length;

  const useAb = () => {
    const t = sp.ability.target;
    if (t === 'none') {
      const err = useAbility(w, e.id, {});
      if (err) store.notify(err, 'error');
      store.emit();
    } else if (t === 'star') {
      store.pick = {
        kind: 'ability', hint: `${sp.ability.name}: choose a star`, onPick: (star) => {
          const err = useAbility(w, e.id, { star });
          store.pick = null;
          if (err) store.notify(err, 'error');
          store.emit();
        },
      };
      store.emit();
    } else if (t === 'empire') setAbilityMenu((x) => !x);
    else if (t === 'planet') store.notify(`${sp.ability.name}: open a system and use the ability button next to the target planet.`);
    else if (t === 'fleet') store.notify(`${sp.ability.name}: select one of your fleets and use the ability from its panel.`);
  };

  return (
    <div class="panel topbar">
      <button class="btn ghost icon" onClick={onMenu} data-tip="Menu: save, load, settings"><Icon.menu /></button>
      <div class="brand" style={{ fontSize: 13 }}>ASCEND<span>ANT</span></div>
      <div class="row" style={{ gap: 6 }} data-tip={`${e.name}\n${sp.name} — ${sp.traitDesc}`}>
        <Portrait species={e.species} color={e.color} size={30} />
      </div>
      <div class="col" style={{ gap: 0, minWidth: 70 }}>
        <span class="caps" style={{ fontSize: 10 }}>Day</span>
        <span class="mono" style={{ fontFamily: 'var(--display)', fontSize: 18, lineHeight: 1 }}>{w.s.day}</span>
      </div>
      <div class="row" style={{ gap: 4 }}>
        <button class={'btn icon sm ' + (st.speed === 0 ? 'active' : '')} onClick={() => st.pause()} data-tip="Pause (Space)"><Icon.pause /></button>
        <button class="btn icon sm" onClick={() => st.step(1)} data-tip="Advance one day (.)"><Icon.step /></button>
        {SPEEDS.map((s, i) => (
          <button key={s.v} class={'btn icon sm ' + (st.speed === s.v && !st.untilEvent ? 'active' : '')} onClick={() => st.play(s.v)} data-tip={`${s.label}: ${s.v} days/sec (${s.key})`}>
            {i === 0 ? <Icon.play size={12} /> : i === 1 ? <Icon.play /> : <Icon.ff />}
          </button>
        ))}
        <button class={'btn sm ' + (st.untilEvent && st.speed ? 'active' : '')} onClick={() => st.play(60, true)} data-tip="Run until something needs your attention (4). Configure which events stop time in Settings.">
          <Icon.skip size={14} /> Until event
        </button>
      </div>
      <div class="row" style={{ gap: 14, marginLeft: 6 }}>
        <span class="stat" data-tip={`Industry per day across all planets.\nLogistics pool: ${fmt(e.logistics)} (Supply Convoys feed planets that are building)`}>{Icon.ind({ size: 18 })}<b>{fmt(e.last.ind)}</b></span>
        <span class="stat" data-tip="Research per day (pooled empire-wide)">{Icon.res({ size: 18 })}<b>{fmt(e.last.res)}</b></span>
        <span class="stat" data-tip="Prosperity per day (grows population on each planet)">{Icon.pro({ size: 18 })}<b>{fmt(e.last.pro)}</b></span>
        <span class="stat" data-tip={`Population ${e.last.pop} on ${planets} planets`}>{Icon.pop({ size: 18 })}<b>{e.last.pop}</b><span class="dim small">/{planets}</span></span>
        <span class="stat" data-tip={`${ships} ships`}>{Icon.ship({ size: 18 })}<b>{ships}</b></span>
      </div>
      <button class="btn ghost" style={{ minWidth: 190, maxWidth: 260, flexDirection: 'column', alignItems: 'stretch', gap: 3, padding: '4px 10px' }} onClick={() => st.open('research')} data-tip="Research (R)">
        <span class="row small" style={{ gap: 6 }}>{Icon.res({ size: 14 })}<span class="ellipsis grow" style={{ textAlign: 'left' }}>{r.current ? TECH[r.current].name : <span class="warn">Choose research!</span>}</span>{r.current && <span class="dim mono">{eta}d</span>}</span>
        <Bar value={r.progress} max={cost || 1} color="var(--res)" />
      </button>
      <div class="spacer" />
      <div style={{ position: 'relative' }}>
        <button class={'btn sm ' + (ready ? 'primary' : '')} disabled={!ready} onClick={useAb} data-tip={`${sp.ability.name}: ${sp.ability.desc}\nCooldown ${sp.ability.cooldown} days.${ready ? '' : `\nReady on day ${e.abilityReadyDay}.`}`}>
          <Icon.bolt size={14} /> {sp.ability.name}{!ready && <span class="mono dim"> {e.abilityReadyDay - w.s.day}d</span>}
        </button>
        {abilityMenu && (
          <div class="panel" style={{ position: 'absolute', top: 40, right: 0, padding: 6, minWidth: 220, zIndex: 50 }}>
            {w.s.empires.filter((o) => o.id !== e.id && o.alive && e.relations[o.id].met).map((o) => (
              <button key={o.id} class="btn ghost sm" style={{ width: '100%', justifyContent: 'flex-start' }} disabled={!!abilityCheck(w, e.id, { empire: o.id })} onClick={() => {
                const err = useAbility(w, e.id, { empire: o.id });
                if (err) store.notify(err, 'error');
                setAbilityMenu(false);
                store.emit();
              }}><span class="dot" style={{ background: o.color }} /> {o.name}</button>
            ))}
          </div>
        )}
      </div>
      <div class="row" style={{ gap: 4 }}>
        {idle > 0 && <button class="btn sm" onClick={() => nextIdle()} data-tip="Planets with nothing to do and no governor (N)"><span class="warn">{idle} idle</span></button>}
        <button class="btn icon" onClick={() => st.open('research')} data-tip="Research (R)"><Icon.res /></button>
        <button class="btn icon" onClick={() => st.open('designer')} data-tip="Ship designer (D)"><Icon.wrench /></button>
        <button class="btn icon" style={{ position: 'relative' }} onClick={() => st.open('diplomacy')} data-tip="Diplomacy (P)">
          <Icon.handshake />
          {inbox > 0 && <span style={{ position: 'absolute', top: -4, right: -4, background: 'var(--bad)', borderRadius: 999, fontSize: 10, padding: '0 5px', fontWeight: 700 }}>{inbox}</span>}
        </button>
        <button class="btn icon" onClick={() => st.open('empire')} data-tip="Empire overview (E)"><Icon.chart /></button>
        <button class="btn icon" onClick={() => st.open('battle')} data-tip="Battle reports (B)"><Icon.sword /></button>
        <button class="btn icon" onClick={() => st.open('encyclopedia')} data-tip="Encyclopedia & how to play (H)"><Icon.book /></button>
      </div>
    </div>
  );
}

export function nextIdle() {
  const w = store.world!;
  const e = w.human()!;
  const idle = w.planetsOf[e.id].map((id) => w.s.planets[id]).filter((p) => !p.queue.length && !p.governor.on && !p.project);
  if (!idle.length) return store.notify('No idle planets.');
  const cur = store.sel.planet;
  const i = idle.findIndex((p) => p.id === cur);
  const p = idle[(i + 1) % idle.length];
  store.select({ star: p.star, planet: p.id, fleet: null });
  store.focus(p.star);
}

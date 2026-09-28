import { useState } from 'preact/hooks';
import { store, useStore, dispatch } from '../store';
import { Icon, Portrait } from '../icons';
import { Bar, fmt, act } from '../common';
import { TECH } from '../../sim/content';
import { abilityCheck, abilityReady } from '../../sim/abilities';
import { NetBadge } from './NetPanel';

export const SPEEDS = [
  { v: 2, label: 'Slow', key: '1' },
  { v: 6, label: 'Normal', key: '2' },
  { v: 20, label: 'Fast', key: '3' },
];

export function TopBar({ onMenu, compact }: { onMenu: () => void; compact?: boolean }) {
  const st = useStore();
  const w = st.world!;
  const e = w.human();
  const [abilityMenu, setAbilityMenu] = useState(false);
  const [more, setMore] = useState(false);
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
      act(dispatch({ t: 'ability', target: {} }));
    } else if (t === 'star') {
      store.pick = {
        kind: 'ability', hint: `${sp.ability.name}: choose a star`, onPick: (star) => {
          store.pick = null;
          act(dispatch({ t: 'ability', target: { star } }));
        },
      };
      store.emit();
    } else if (t === 'empire') setAbilityMenu((x) => !x);
    else if (t === 'planet') store.notify(`${sp.ability.name}: open a system and use the ability button next to the target planet.`);
    else if (t === 'fleet') store.notify(`${sp.ability.name}: select one of your fleets and use the ability from its panel.`);
  };

  if (compact) {
    const speedIdx = SPEEDS.findIndex((x) => x.v === st.speed);
    const playing = st.speed > 0;
    const pct = r.current && cost ? Math.min(100, (r.progress / cost) * 100) : 0;
    return (
      <>
        <div class="panel topbar compact">
          <button class="btn ghost icon" onClick={onMenu} aria-label="Menu" data-tip="Menu: save, load, settings"><Icon.menu /></button>
          <div class="tb-day" data-tip={`Day ${w.s.day}`}><span class="caps">Day</span><b class="mono">{w.s.day}</b></div>
          <button class={'btn icon ' + (playing ? 'active' : '')} onClick={() => (playing ? st.pause() : st.play(SPEEDS[1].v))} aria-label={playing ? 'Pause' : 'Play'} data-tip={playing ? 'Pause' : 'Play at normal speed'}>
            {playing ? <Icon.pause /> : <Icon.play />}
          </button>
          <button class="btn icon tb-speed" onClick={() => st.play(SPEEDS[(Math.max(0, speedIdx) + 1) % SPEEDS.length].v)} aria-label="Change speed" data-tip="Tap to cycle speed: slow, normal, fast">
            <span class="mono">{st.untilEvent && playing ? '»' : speedIdx >= 0 ? '×' + (speedIdx + 1) : '×2'}</span>
          </button>
          <span class="stat tb-res" data-tip="Industry per day">{Icon.ind({ size: 16 })}<b>{fmt(e.last.ind)}</b></span>
          <span class="stat tb-res" data-tip="Research per day">{Icon.res({ size: 16 })}<b>{fmt(e.last.res)}</b></span>
          <span class="stat tb-res tb-wide" data-tip={`Population ${e.last.pop} on ${planets} planets`}>{Icon.pop({ size: 16 })}<b>{e.last.pop}</b></span>
          <button class={'btn ghost tb-research ' + (r.current ? '' : 'pulse')} onClick={() => st.open('research')} aria-label="Research" data-tip={r.current ? `${TECH[r.current].name} · ${eta} days` : 'Choose research!'}>
            <span class="row" style={{ gap: 4, minWidth: 0 }}>{Icon.res({ size: 14 })}<span class="ellipsis tb-rname">{r.current ? TECH[r.current].name : <span class="warn">Research!</span>}</span>{r.current && <span class="dim mono tiny">{eta}d</span>}</span>
            <span class="bar" style={{ height: 3 }}><i style={{ width: pct + '%', background: 'var(--res)' }} /></span>
          </button>
          <button class={'btn icon ' + (more ? 'active' : '')} style={{ position: 'relative' }} onClick={() => setMore((x) => !x)} aria-label="More" data-tip="Screens, speed, ability">
            <Icon.more />
            {(inbox > 0 || idle > 0 || ready) && <span class="tb-dot" />}
          </button>
        </div>
        {more && (
          <div class="overlay sheet-overlay" onPointerDown={(ev) => { if (ev.target === ev.currentTarget) setMore(false); }}>
            <div class="panel more-sheet" onClick={(ev) => { if ((ev.target as Element).closest('[data-close]')) setMore(false); }}>
              <div class="sheet-handle static"><i /></div>
              <div class="more-stats">
                <div class="row" style={{ gap: 8 }} data-tip={`${e.name}\n${sp.name} — ${sp.traitDesc}`}>
                  <Portrait species={e.species} color={e.color} size={36} />
                  <div class="col" style={{ gap: 0, minWidth: 0 }}><b class="ellipsis">{e.name}</b><span class="dim small">{sp.name}</span></div>
                </div>
                <div class="row wrap" style={{ gap: 14 }}>
                  <span class="stat">{Icon.ind({ size: 16 })}<b>{fmt(e.last.ind)}</b></span>
                  <span class="stat">{Icon.res({ size: 16 })}<b>{fmt(e.last.res)}</b></span>
                  <span class="stat">{Icon.pro({ size: 16 })}<b>{fmt(e.last.pro)}</b></span>
                  <span class="stat">{Icon.pop({ size: 16 })}<b>{e.last.pop}</b><span class="dim small">/{planets}</span></span>
                  <span class="stat">{Icon.ship({ size: 16 })}<b>{ships}</b></span>
                </div>
              </div>
              <div class="caps" style={{ padding: '0 14px' }}>Time</div>
              <div class="more-row">
                <button class={'btn ' + (st.speed === 0 ? 'active' : '')} onClick={() => st.pause()}><Icon.pause size={14} /> Pause</button>
                <button class="btn" onClick={() => st.step(1)}><Icon.step size={14} /> +1 day</button>
                {SPEEDS.map((x, i) => <button key={x.v} class={'btn ' + (st.speed === x.v && !st.untilEvent ? 'active' : '')} onClick={() => st.play(x.v)}>{i === 2 ? <Icon.ff size={14} /> : <Icon.play size={i === 0 ? 11 : 14} />} {x.label}</button>)}
                <button class={'btn ' + (st.untilEvent && st.speed ? 'active' : '')} onClick={() => st.play(60, true)} data-close><Icon.skip size={14} /> Until event</button>
              </div>
              <div class="caps" style={{ padding: '0 14px' }}>Screens</div>
              <div class="more-grid">
                <button class="btn" data-close onClick={() => st.open('research')}><Icon.res size={18} /><span>Research</span></button>
                <button class="btn" data-close onClick={() => st.open('designer')}><Icon.wrench size={18} /><span>Designer</span></button>
                <button class="btn" data-close style={{ position: 'relative' }} onClick={() => st.open('diplomacy')}><Icon.handshake size={18} /><span>Diplomacy</span>{inbox > 0 && <span class="tb-badge">{inbox}</span>}</button>
                <button class="btn" data-close onClick={() => st.open('empire')}><Icon.chart size={18} /><span>Empire</span></button>
                <button class="btn" data-close onClick={() => st.open('battle')}><Icon.sword size={18} /><span>Battles</span></button>
                <button class="btn" data-close onClick={() => st.open('encyclopedia')}><Icon.book size={18} /><span>Encyclopedia</span></button>
              </div>
              <div class="more-row">
                <button class={'btn grow ' + (ready ? 'primary' : '')} disabled={!ready} data-close={sp.ability.target === 'empire' ? undefined : ''} onClick={useAb}>
                  <Icon.bolt size={14} /> {sp.ability.name}{!ready && <span class="mono dim"> {e.abilityReadyDay - w.s.day}d</span>}
                </button>
                <button class="btn grow" disabled={!idle} data-close onClick={() => nextIdle()}><span class={idle ? 'warn' : ''}>{idle} idle planet{idle === 1 ? '' : 's'}</span></button>
              </div>
              {abilityMenu && (
                <div class="more-row">
                  {w.s.empires.filter((o) => o.id !== e.id && o.alive && e.relations[o.id].met).map((o) => (
                    <button key={o.id} class="btn" data-close disabled={!!abilityCheck(w, e.id, { empire: o.id })} onClick={() => { setAbilityMenu(false); act(dispatch({ t: 'ability', target: { empire: o.id } })); }}><span class="dot" style={{ background: o.color }} /> {o.name}</button>
                  ))}
                </div>
              )}
              {st.net && <div class="more-row"><NetBadge /></div>}
              <div class="more-row" style={{ paddingBottom: 'calc(12px + env(safe-area-inset-bottom))' }}>
                <button class="btn ghost grow" data-close>Close</button>
              </div>
            </div>
          </div>
        )}
      </>
    );
  }

  return (
    <div class="panel topbar">
      <button class="btn ghost icon" onClick={onMenu} data-tip="Menu: save, load, settings"><Icon.menu /></button>
      <div class="brand hide-lg" style={{ fontSize: 13 }}>ASCEND<span>ANT</span></div>
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
          <Icon.skip size={14} /><span class="hide-lg">Until event</span>
        </button>
      </div>
      <div class="row" style={{ gap: 14, marginLeft: 6 }}>
        <span class="stat" data-tip={`Industry per day across all planets.\nLogistics pool: ${fmt(e.logistics)} (Supply Convoys feed planets that are building)`}>{Icon.ind({ size: 18 })}<b>{fmt(e.last.ind)}</b></span>
        <span class="stat" data-tip="Research per day (pooled empire-wide)">{Icon.res({ size: 18 })}<b>{fmt(e.last.res)}</b></span>
        <span class="stat hide-md" data-tip="Prosperity per day (grows population on each planet)">{Icon.pro({ size: 18 })}<b>{fmt(e.last.pro)}</b></span>
        <span class="stat" data-tip={`Population ${e.last.pop} on ${planets} planets`}>{Icon.pop({ size: 18 })}<b>{e.last.pop}</b><span class="dim small">/{planets}</span></span>
        <span class="stat hide-md" data-tip={`${ships} ships`}>{Icon.ship({ size: 18 })}<b>{ships}</b></span>
      </div>
      <button class={'btn ghost ' + (r.current ? '' : 'pulse')} style={{ minWidth: 150, maxWidth: 260, flex: '0 1 240px', flexDirection: 'column', alignItems: 'stretch', gap: 3, padding: '4px 10px' }} onClick={() => st.open('research')} data-tip="Research (R)">
        <span class="row small" style={{ gap: 6 }}>{Icon.res({ size: 14 })}<span class="ellipsis grow" style={{ textAlign: 'left' }}>{r.current ? TECH[r.current].name : <span class="warn">Choose research!</span>}</span>{r.current && <span class="dim mono">{eta}d</span>}</span>
        <Bar value={r.progress} max={cost || 1} color="var(--res)" />
      </button>
      <div class="spacer" />
      <div style={{ position: 'relative' }}>
        <button class={'btn sm ' + (ready ? 'primary' : '')} disabled={!ready} onClick={useAb} data-tip={`${sp.ability.name}: ${sp.ability.desc}\nCooldown ${sp.ability.cooldown} days.${ready ? '' : `\nReady on day ${e.abilityReadyDay}.`}`}>
          <Icon.bolt size={14} /><span class="hide-lg">{sp.ability.name}</span>{!ready && <span class="mono dim"> {e.abilityReadyDay - w.s.day}d</span>}
        </button>
        {abilityMenu && (
          <div class="panel" style={{ position: 'absolute', top: 40, right: 0, padding: 6, minWidth: 220, zIndex: 50 }}>
            {w.s.empires.filter((o) => o.id !== e.id && o.alive && e.relations[o.id].met).map((o) => (
              <button key={o.id} class="btn ghost sm" style={{ width: '100%', justifyContent: 'flex-start' }} disabled={!!abilityCheck(w, e.id, { empire: o.id })} onClick={() => {
                setAbilityMenu(false);
                act(dispatch({ t: 'ability', target: { empire: o.id } }));
              }}><span class="dot" style={{ background: o.color }} /> {o.name}</button>
            ))}
          </div>
        )}
      </div>
      <NetBadge />
      <div class="row" style={{ gap: 4 }}>
        {idle > 0 && <button class="btn sm" onClick={() => nextIdle()} data-tip="Planets with nothing to do and no governor (N)"><span class="warn">{idle} idle</span></button>}
        <button class="btn icon" onClick={() => st.open('research')} data-tip="Research (R)"><Icon.res /></button>
        <button class="btn icon" onClick={() => st.open('designer')} data-tip="Ship designer (D)"><Icon.wrench /></button>
        <button class="btn icon" style={{ position: 'relative' }} onClick={() => st.open('diplomacy')} data-tip="Diplomacy (P)">
          <Icon.handshake />
          {inbox > 0 && <span style={{ position: 'absolute', top: -4, right: -4, background: 'var(--bad)', borderRadius: 999, fontSize: 10, padding: '0 5px', fontWeight: 700 }}>{inbox}</span>}
        </button>
        <button class="btn icon" onClick={() => st.open('empire')} data-tip="Empire overview (E)"><Icon.chart /></button>
        <button class="btn icon hide-md" onClick={() => st.open('battle')} data-tip="Battle reports (B)"><Icon.sword /></button>
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

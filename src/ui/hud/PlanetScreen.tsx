import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { store, useStore, dispatch } from '../store';
import { BuildingIcon, Icon, PartIcon } from '../icons';
import { Bar, Section, Yields, act, fmt, Empty } from '../common';
import { BUILDING, BUILDINGS, PLANET_TYPE, PROJECTS, TECH } from '../../sim/content';
import { FOCUS_LABEL, suggestions } from '../../sim/governor';
import { tileMul } from '../../sim/world';
import type { BuildItem, GovernorFocus, Planet } from '../../sim/types';
import { planetImage } from '../icons';
import { invasionDefense } from '../../sim/fleets';
import { PlanetGlobe } from './PlanetGlobe';

const FOCI: GovernorFocus[] = ['balanced', 'industry', 'research', 'growth', 'defense'];
const FOCUS_TIP: Record<GovernorFocus, string> = {
  balanced: 'Balance industry and research; keeps the empire from starving either.',
  industry: 'Factories and megaplexes first. Good for shipyards.',
  research: 'Labs and campuses first.',
  growth: 'Prosperity and housing: grow population quickly.',
  defense: 'Garrisons, shields and orbital weapons; drills the militia when idle.',
};
const SIZE_NAME = ['Tiny', 'Small', 'Medium', 'Large', 'Huge'];
const COLOR_TIP: Record<string, string> = {
  white: 'Ordinary ground.',
  black: 'Dead ground: nothing can be built here (Worldshaping can reclaim it).',
  red: 'Industry tile: structures that produce industry produce double here.',
  green: 'Prosperity tile: structures that produce prosperity produce double here.',
  blue: 'Research tile: structures that produce research produce double here.',
};

function itemIcon(w: NonNullable<typeof store.world>, item: BuildItem, p: Planet) {
  switch (item.kind) {
    case 'building': return <BuildingIcon id={item.id} size={30} />;
    case 'ship': { const d = w.s.designs[item.design]; return d ? <PartIcon id={d.parts.find(Boolean) ?? ''} size={26} /> : null; }
    case 'automate': return <Icon.gear size={22} />;
    case 'terraform': return <BuildingIcon id="action:terraform" size={30} />;
    case 'refit': return <PartIcon id={item.part} size={26} />;
    case 'demolish': return <Icon.trash size={20} />;
    case 'ascension': return <Icon.star size={24} />;
  }
  void p;
}

export function PlanetScreen({ planetId, onClose }: { planetId: number; onClose: () => void }) {
  const st = useStore();
  const w = st.world!;
  const human = w.human()!;
  const p = w.s.planets[planetId];
  const mine = p.owner === human.id;
  const ec = w.econ(p);
  const [brush, setBrush] = useState<string | null>(null);
  const [selTile, setSelTile] = useState<{ i: number; orbital: boolean } | null>(null);
  const painting = useRef(false);
  const [surfaceView, setSurfaceView] = useState<'grid' | 'globe'>('grid');
  const pt = PLANET_TYPE[p.type];
  const myPlanets = w.planetsOf[human.id];
  const idx = myPlanets.indexOf(p.id);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('input,textarea,select')) return;
      if (e.key === 'Escape') { if (brush) setBrush(null); else onClose(); }
      if (e.key.toLowerCase() === 'm' && mine) { const on = !p.governor.on; dispatch({ t: 'governor', planet: p.id, patch: { on } }); store.notify(`Governor ${on ? 'on' : 'off'} for ${p.name}`); }
      if (e.key === '[' || e.key === ']') cycle(e.key === ']' ? 1 : -1);
    };
    const up = () => { painting.current = false; };
    window.addEventListener('keydown', k);
    window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('keydown', k); window.removeEventListener('pointerup', up); };
  });

  const cycle = (d: number) => {
    if (!myPlanets.length) return;
    const n = myPlanets[(idx + d + myPlanets.length) % myPlanets.length];
    store.select({ planet: n, star: w.s.planets[n].star });
    store.focus(w.s.planets[n].star);
  };

  // Palette: everything buildable here; newest tech first so upgrades aren't buried.
  const recent = human.research.known.slice(-4);
  const palette = useMemo(() => BUILDINGS.filter((b) => w.knows(human.id, b.tech) && b.id !== 'colonybase').map((b) => ({
    b, can: mine && w.canBuild(p, b.id), isNew: !!b.tech && recent.includes(b.tech),
  })).sort((a, b) => (b.isNew ? 1 : 0) - (a.isNew ? 1 : 0) || (a.b.orbital ? 1 : 0) - (b.b.orbital ? 1 : 0) || b.b.cost - a.b.cost), [w.version, p.id]);

  const sugg = mine ? suggestions(w, p, 4) : [];
  const suggTiles = new Set(sugg.filter((s) => s.item.kind === 'building' && !s.item.orbital).map((s) => (s.item as { tile: number }).tile));
  const queuedAt = new Map<string, BuildItem>();
  for (const q of p.queue) if ('tile' in q) queuedAt.set(`${'orbital' in q && q.orbital ? 'o' : 't'}${q.tile}`, q);

  const place = (i: number, orbital: boolean) => {
    if (!mine) return;
    if (brush) {
      const def = BUILDING[brush];
      if (def.orbital !== orbital) return store.notify(def.orbital ? 'Orbital structures go in the orbit row.' : 'That is a surface structure.', 'error');
      const r = dispatch({ t: 'queueBuilding', planet: p.id, id: brush, tile: i, orbital });
      if (r.ok && def.unique) setBrush(null);
    } else setSelTile({ i, orbital });
  };

  const cols = p.gridW;
  const tileSize = Math.max(38, Math.min(72, Math.floor(430 / cols)));
  const growthPct = ec.growthNeeded ? Math.round((p.growth / ec.growthNeeded) * 100) : 0;
  const head = p.queue[0];
  const headCost = head ? w.itemCost(p, head) : 0;
  const ind = ec.yield.ind * (p.besieged ? 0.5 : 1);
  const owner = p.owner !== null ? w.s.empires[p.owner] : null;
  const explored = human.explored[p.star] === 2;
  const selInst = selTile ? (selTile.orbital ? p.orbitals[selTile.i] : p.tiles[selTile.i].b) : undefined;

  return (
    <div class="overlay" style={{ background: 'rgba(2,3,8,0.55)', padding: '76px 16px 16px' }} onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="panel modal" style={{ width: 'min(1180px, 100%)', height: '100%' }}>
        <div class="modal-head" style={{ gap: 14 }}>
          <div style={{ position: 'relative', width: 64, height: 64 }}>
            <img src={planetImage(p, 256)} width={64} height={64} style={{ objectFit: 'contain' }} />
          </div>
          <div class="col" style={{ gap: 2 }}>
            <div class="row"><h2>{p.name}</h2>{owner && <span class="chip" style={{ borderColor: owner.color }}><span class="dot" style={{ background: owner.color }} />{owner.name}</span>}</div>
            <div class="dim small">{SIZE_NAME[p.size]} {pt.name} · {pt.desc}{owner && w.isFavored(p, owner.id) ? <span class="good"> · favored by the {w.species(owner).plural}</span> : ''}</div>
          </div>
          <div class="spacer" />
          {mine && (
            <div class="row" style={{ gap: 18 }}>
              <div class="col" style={{ gap: 3, minWidth: 130 }} data-tip={`Population ${p.pop} of ${ec.popMax}. Each non-automated structure needs one worker.\nGrowth ${fmt(p.growth)}/${ec.growthNeeded} (+${fmt(ec.yield.pro, 1)}/day from prosperity)`}>
                <span class="row small">{Icon.pop({ size: 14 })}<b>{p.pop}</b><span class="dim">/ {ec.popMax}</span><span class="spacer" /><span class="dim tiny">{p.pop >= ec.popMax ? 'full' : `${growthPct}%`}</span></span>
                <Bar value={p.growth} max={ec.growthNeeded} color="var(--pro)" />
              </div>
              <Yields ind={ind} res={ec.yield.res} pro={ec.yield.pro} size={16} />
            </div>
          )}
          <div class="row" style={{ gap: 4 }}>
            {mine && myPlanets.length > 1 && <><button class="btn icon sm" onClick={() => cycle(-1)} data-tip="Previous planet ([)"><Icon.up style={{ transform: 'rotate(-90deg)' }} /></button><button class="btn icon sm" onClick={() => cycle(1)} data-tip="Next planet (])"><Icon.down style={{ transform: 'rotate(-90deg)' }} /></button></>}
            <button class="btn icon ghost" onClick={onClose} data-tip="Close (Esc)"><Icon.close /></button>
          </div>
        </div>
        <div class="modal-body" style={{ flexWrap: 'wrap', overflow: 'auto' }}>
          {/* Surface */}
          <div class="col" style={{ padding: 16, gap: 12, flex: '1 1 460px', minWidth: 0 }}>
            {!explored ? <Empty>This planet hasn't been surveyed.</Empty> : (
              <>
                <div class="row small dim" style={{ gap: 12 }}>
                  <span class="caps">Surface</span>
                  <span class="row" style={{ gap: 4 }}><i class="dot" style={{ background: '#b0473a' }} /> industry ×2</span>
                  <span class="row" style={{ gap: 4 }}><i class="dot" style={{ background: '#3464b8' }} /> research ×2</span>
                  <span class="row" style={{ gap: 4 }}><i class="dot" style={{ background: '#2f8a4c' }} /> prosperity ×2</span>
                  <span class="spacer" />
                  <div class="seg">
                    <button class={surfaceView === 'globe' ? 'on' : ''} onClick={() => setSurfaceView('globe')} data-tip="3D globe view of the surface">Globe</button>
                    <button class={surfaceView === 'grid' ? 'on' : ''} onClick={() => setSurfaceView('grid')} data-tip="Flat tile grid">Grid</button>
                  </div>
                  {brush && <span class="chip warn">Placing {BUILDING[brush].name} — click or drag across tiles · Esc to stop</span>}
                </div>
                {surfaceView === 'globe' ? (
                  <PlanetGlobe planetId={p.id} selectedTile={selTile && !selTile.orbital ? selTile.i : null} height={Math.max(320, Math.min(520, tileSize * p.gridH + 40))}
                    onTile={(i) => { const t = p.tiles[i]; if (t.c === 'black' && !(mine && w.knows(human.id, 'terraforming'))) return; place(i, false); }} />
                ) : (
                <div class="surface" style={{ gridTemplateColumns: `repeat(${cols}, ${tileSize}px)`, userSelect: 'none', touchAction: 'none' }}>
                  {p.tiles.map((t, i) => {
                    const q = queuedAt.get('t' + i);
                    const idle = ec.idle.has(i);
                    const def = t.b ? BUILDING[t.b.id] : null;
                    const m = tileMul(t.c);
                    const tip = [
                      def ? `${def.name}${t.b!.auto ? ' (automated — runs at 75% without a worker)' : ''}${idle ? '\nIDLE: not enough population to work it' : ''}` : '',
                      def && (def.yield.ind || def.yield.res || def.yield.pro) ? `Produces ${def.yield.ind * m.ind || ''}${def.yield.ind ? ' ind ' : ''}${def.yield.res * m.res || ''}${def.yield.res ? ' res ' : ''}${def.yield.pro * m.pro || ''}${def.yield.pro ? ' pro' : ''}` : '',
                      COLOR_TIP[t.c],
                      q ? `Queued: ${w.itemName(q)}` : '',
                      suggTiles.has(i) ? 'Governor recommends building here' : '',
                    ].filter(Boolean).join('\n');
                    return (
                      <div key={i}
                        class={`tile ${t.c} ${idle ? 'idle' : ''} ${q ? 'queued' : ''} ${suggTiles.has(i) && !t.b && !q && mine ? 'suggest' : ''} ${selTile && !selTile.orbital && selTile.i === i ? 'selected' : ''}`}
                        data-tip={tip}
                        onPointerDown={(e) => { if (t.c === 'black' && !(mine && w.knows(human.id, 'terraforming'))) return; e.preventDefault(); painting.current = true; place(i, false); }}
                        onPointerEnter={() => { if (painting.current && brush && t.c !== 'black' && !t.b) place(i, false); }}
                      >
                        {t.b && <BuildingIcon id={t.b.id} size={tileSize} />}
                        {t.b?.auto && <span class="badge auto" data-tip="Automated structure (gear): works without a worker at 75%"><Icon.gear size={11} /></span>}
                        {idle && <span class="idle-mark">IDLE</span>}
                        {q && q.kind === 'building' && <span class="ghost"><BuildingIcon id={q.id} size={tileSize * 0.8} /></span>}
                        {q && q.kind === 'terraform' && <span class="ghost center" style={{ inset: 0, position: 'absolute' }}>⛰</span>}
                      </div>
                    );
                  })}
                </div>
                )}
                <div class="caps" style={{ marginTop: 4 }}>Orbit · {p.orbitals.filter(Boolean).length}/{p.orbitals.length}</div>
                <div class="row wrap" style={{ gap: 4 }}>
                  {p.orbitals.map((o, i) => {
                    const q = queuedAt.get('o' + i);
                    const def = o ? BUILDING[o.id] : null;
                    return (
                      <div key={i} class={`tile white ${q ? 'queued' : ''} ${selTile?.orbital && selTile.i === i ? 'selected' : ''}`} style={{ width: 56, background: 'radial-gradient(circle at 50% 50%, #1a2240, #0b1022)' }}
                        data-tip={def ? `${def.name}\n${def.desc}` : q ? `Queued: ${w.itemName(q)}` : 'Empty orbital slot'}
                        onPointerDown={() => place(i, true)}>
                        {o && <BuildingIcon id={o.id} size={56} />}
                        {q && q.kind === 'building' && <span class="ghost"><BuildingIcon id={q.id} size={44} /></span>}
                      </div>
                    );
                  })}
                </div>
                {selTile && mine && (
                  <div class="card small">
                    {selInst ? (
                      <div class="row wrap" style={{ gap: 8 }}>
                        <b>{BUILDING[selInst.id].name}</b>
                        <span class="dim grow">{BUILDING[selInst.id].desc}</span>
                        {w.knows(human.id, 'automation') && BUILDING[selInst.id].needsWorker && !selInst.auto && (
                          <button class="btn sm" onClick={() => act(dispatch({ t: 'queueItem', planet: p.id, item: { kind: 'automate', tile: selTile.i, orbital: selTile.orbital } }), 'Automation queued.')} data-tip={`Cost ${w.buildingCost(human.id, selInst.id)}. Runs without a worker at 75%.`}><Icon.gear size={12} /> Automate</button>
                        )}
                        {selInst.id !== 'colonybase' && <button class="btn sm danger" onClick={() => act(dispatch({ t: 'queueItem', planet: p.id, item: { kind: 'demolish', tile: selTile.i, orbital: selTile.orbital } }))}>Demolish</button>}
                        <span class="dim tiny">Pick a structure from the palette to replace it.</span>
                      </div>
                    ) : !selTile.orbital && p.tiles[selTile.i].c === 'black' ? (
                      <div class="row"><span class="grow">Dead ground.</span>{w.knows(human.id, 'terraforming') && <button class="btn sm" onClick={() => act(dispatch({ t: 'queueItem', planet: p.id, item: { kind: 'terraform', tile: selTile.i } }), 'Terraforming queued.')}>Terraform ({w.itemCost(p, { kind: 'terraform', tile: 0 })})</button>}</div>
                    ) : (
                      <span class="dim">Empty {selTile.orbital ? 'orbital slot' : `${p.tiles[selTile.i].c} tile`}. Choose a structure from the palette to build here.</span>
                    )}
                  </div>
                )}
                {!mine && owner && w.atWar(human.id, owner.id) && <div class="card small">Invasion defense: <b>{invasionDefense(w, p)}</b>. Destroy its orbital defenses, then land troops with Assault Pods.</div>}
                {!owner && <div class="card small dim">Unclaimed. {p.type === 'gasgiant' ? 'Gas giants can only hold outposts (orbital structures).' : 'Send a colony ship to settle it, or an outpost kit to claim its orbit.'}{p.ruins && !p.ruins.dug ? ' Ancient ruins lie here.' : ''}</div>}
              </>
            )}
          </div>

          {/* Controls */}
          {mine && (
            <div class="col scroll" style={{ gap: 0, flex: '0 1 440px', minWidth: 320, borderLeft: '1px solid var(--line)' }}>
              <Section title="Governor" right={<span class="kbd">M</span>}>
                <div class="row" style={{ gap: 10 }}>
                  <button class={'btn ' + (p.governor.on ? 'primary' : '')} style={{ minWidth: 120 }} onClick={() => act(dispatch({ t: 'governor', planet: p.id, patch: { on: !p.governor.on } }))} data-tip="When on, the governor keeps this planet's build queue busy with the best option for its focus. You can still queue things yourself; it only acts when the queue is empty.">
                    <Icon.gear size={14} /> {p.governor.on ? 'Governed' : 'Manual'}
                  </button>
                  <label class="row small" data-tip="Replace structures with better ones as technology improves, and fix structures on the wrong tiles"><input type="checkbox" checked={p.governor.autoUpgrade} onChange={(e) => act(dispatch({ t: 'governor', planet: p.id, patch: { autoUpgrade: (e.target as HTMLInputElement).checked } }))} /> Auto-upgrade</label>
                </div>
                <div class="seg" style={{ marginTop: 8, flexWrap: 'wrap' }}>
                  {FOCI.map((f) => <button key={f} class={p.governor.focus === f ? 'on' : ''} onClick={() => act(dispatch({ t: 'governor', planet: p.id, patch: { focus: f } }))} data-tip={FOCUS_TIP[f]}>{FOCUS_LABEL[f]}</button>)}
                </div>
                {sugg.length > 0 && (
                  <div class="col" style={{ gap: 4, marginTop: 10 }}>
                    <div class="caps">{p.governor.on ? 'Up next' : 'Suggestions'}</div>
                    {sugg.map((s, k) => (
                      <button key={k} class="btn ghost sm" style={{ justifyContent: 'flex-start', textAlign: 'left' }} onClick={() => act(dispatch({ t: 'queueItem', planet: p.id, item: s.item }))} data-tip="Click to queue">
                        {itemIcon(w, s.item, p)}
                        <span class="grow ellipsis">{w.itemName(s.item)}{s.why ? <span class="dim"> — {s.why}</span> : ''}</span>
                        <span class="ind mono">{w.itemCost(p, s.item)}</span>
                      </button>
                    ))}
                    <button class="btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={() => dispatch({ t: 'reoptimize', planet: p.id }, (r) => { const n = (r.value as number) ?? 0; if (r.ok) store.notify(n ? `Queued ${n} improvements.` : 'Layout already looks good.'); })} data-tip="Queue replacements for outdated or badly placed structures (useful on captured worlds)">Re-optimize layout</button>
                  </div>
                )}
              </Section>

              <Section title={`Queue · ${p.queue.length}`} right={head ? <span class="small dim">{fmt(ind, 1)} ind/day</span> : null}>
                {!p.queue.length && (
                  <div class="col" style={{ gap: 6 }}>
                    <div class="small dim">Nothing queued. {p.governor.on ? 'The governor will pick something tomorrow.' : 'Idle industry goes to the planet project:'}</div>
                    <select value={p.project ?? ''} onChange={(e) => act(dispatch({ t: 'project', planets: [p.id], project: (e.target as HTMLSelectElement).value || null }))}>
                      <option value="">No project (industry is banked, up to 200)</option>
                      {PROJECTS.filter((x) => w.knows(human.id, x.tech)).map((x) => <option key={x.id} value={x.id}>{x.name} — {x.desc}</option>)}
                    </select>
                  </div>
                )}
                <div class="col" style={{ gap: 4 }}>
                  {p.queue.map((q, k) => {
                    const cost = w.itemCost(p, q);
                    const days = Math.ceil((cost - (k === 0 ? p.progress : 0)) / Math.max(0.1, ind));
                    return (
                      <div key={k} class="queue-item">
                        {itemIcon(w, q, p)}
                        <div class="grow" style={{ minWidth: 0 }}>
                          <div class="row small"><span class="ellipsis grow">{w.itemName(q)}</span><span class="ind mono">{cost}</span></div>
                          {k === 0 ? <Bar value={p.progress} max={headCost} color="var(--ind)" /> : null}
                          <div class="tiny dim">{k === 0 ? `${days} day${days === 1 ? '' : 's'} left` : `~${days} days`}</div>
                        </div>
                        <button class="btn icon sm ghost" disabled={k === 0} onClick={() => act(dispatch({ t: 'moveQueued', planet: p.id, index: k, dir: -1 }))}><Icon.up size={14} /></button>
                        <button class="btn icon sm ghost" onClick={() => act(dispatch({ t: 'removeQueued', planet: p.id, index: k }))}><Icon.trash size={14} /></button>
                      </div>
                    );
                  })}
                </div>
                {ec.hasShipyard && (
                  <div class="row wrap" style={{ gap: 6, marginTop: 8 }}>
                    <span class="caps">Build ship</span>
                    {Object.values(w.s.designs).filter((d) => d.owner === human.id && !d.obsolete).sort((a, b) => b.created - a.created).map((d) => (
                      <button key={d.id} class="btn sm" onClick={(e) => act(dispatch({ t: 'queueItem', planet: p.id, item: { kind: 'ship', design: d.id }, front: e.shiftKey }))} data-tip={`${d.name} (${d.role}) — cost ${w.itemCost(p, { kind: 'ship', design: d.id })}${w.econ(p).hasDocks ? ' (docks −25%)' : ''}\nShift-click to put it first.`}>{d.name} <span class="ind mono">{w.itemCost(p, { kind: 'ship', design: d.id })}</span></button>
                    ))}
                    <button class="btn sm ghost" onClick={() => store.open('designer')}>Designer…</button>
                  </div>
                )}
                {w.knows(human.id, 'transcendence') && !p.queue.some((q) => q.kind === 'ascension') && (
                  <button class="btn sm primary" style={{ marginTop: 8 }} onClick={() => act(dispatch({ t: 'queueItem', planet: p.id, item: { kind: 'ascension' } }), 'The Ascension Gate is under construction. Everyone will know.')}>Build the Ascension Gate</button>
                )}
              </Section>

              <Section title="Structures" right={brush ? <button class="btn sm ghost" onClick={() => setBrush(null)}>Cancel</button> : <span class="dim tiny">pick, then click tiles</span>}>
                <div class="palette">
                  {palette.map(({ b, can, isNew }) => {
                    const cost = w.buildingCost(human.id, b.id);
                    const y = b.yield;
                    const tip = `${b.name}${b.orbital ? ' (orbital)' : ''} — ${cost} industry\n${b.desc}${b.housing ? `\n+${b.housing} population capacity` : ''}${b.needsWorker ? '\nNeeds a worker' : '\nNo worker needed'}${b.tech ? `\nFrom ${TECH[b.tech].name}` : ''}${!can ? '\n(Not available on this planet right now)' : ''}`;
                    return (
                      <div key={b.id} class={`pal-item ${brush === b.id ? 'on' : ''} ${isNew ? 'new' : ''}`} style={{ opacity: can ? 1 : 0.4 }} data-tip={tip}
                        onClick={() => {
                          if (!can) return;
                          if (selTile && (selTile.orbital === b.orbital)) {
                            act(dispatch({ t: 'queueBuilding', planet: p.id, id: b.id, tile: selTile.i, orbital: selTile.orbital }));
                            setSelTile(null);
                          } else setBrush(brush === b.id ? null : b.id);
                        }}>
                        <BuildingIcon id={b.id} size={40} />
                        <span class="ellipsis" style={{ maxWidth: '100%' }}>{b.name}</span>
                        <span class="row tiny" style={{ gap: 4 }}>
                          <span class="cost">{cost}</span>
                          {y.ind ? <span class="ind">+{y.ind}</span> : null}{y.res ? <span class="res">+{y.res}</span> : null}{y.pro ? <span class="pro">+{y.pro}</span> : null}{b.housing ? <span class="pop">⌂{b.housing}</span> : null}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </Section>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

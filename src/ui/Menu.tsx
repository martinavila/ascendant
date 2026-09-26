import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { SPECIES } from '../sim/content';
import { newGame, DEFAULT_SETTINGS } from '../sim/gen';
import { visibilityTick } from '../sim/visibility';
import type { GalaxyShape, GameSettings } from '../sim/types';
import { listSaves, loadSlot, importFile, deleteSlot, type SaveMeta } from '../sim/save';
import { store } from './store';
import { portrait, Icon } from './icons';
import { nebulaCanvas } from '../art/procedural';
import { classicAvailable } from '../art/classic';
import { loadProfile } from '../net';

const SIZES = [
  { label: 'Tiny', stars: 40, empires: 3 },
  { label: 'Small', stars: 80, empires: 4 },
  { label: 'Medium', stars: 150, empires: 6 },
  { label: 'Large', stars: 300, empires: 8 },
  { label: 'Huge', stars: 600, empires: 12 },
  { label: 'Colossal', stars: 1200, empires: 16 },
];
const SHAPES: { v: GalaxyShape; label: string }[] = [
  { v: 'spiral', label: 'Spiral' }, { v: 'elliptical', label: 'Elliptical' }, { v: 'ring', label: 'Ring' }, { v: 'clusters', label: 'Clusters' }, { v: 'irregular', label: 'Irregular' },
];
const DIFFS = ['Relaxed', 'Normal', 'Hard', 'Brutal'];
const DIFF_TIP = [
  'AI economies at 80%; less aggressive.',
  'Even footing.',
  'AI economies at 120% and more willing to fight.',
  'AI economies at 145% and aggressive. Good luck.',
];

function Backdrop() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!;
    const src = nebulaCanvas(5, 1024);
    c.width = src.width;
    c.height = src.height;
    c.getContext('2d')!.drawImage(src, 0, 0);
  }, []);
  return <canvas ref={ref} class="neb" />;
}

export function MainMenu({ onNew, onMultiplayer }: { onNew: () => void; onMultiplayer: () => void }) {
  const [saves, setSaves] = useState<SaveMeta[]>([]);
  const [busy, setBusy] = useState(false);
  const refresh = () => void listSaves().then(setSaves);
  useEffect(refresh, []);
  const load = async (slot: string) => {
    setBusy(true);
    try {
      const w = await loadSlot(slot);
      if (w) store.setWorld(w);
    } catch (e) {
      store.notify('Could not load that save: ' + (e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const importSave = () => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.asc,.json,.gz';
    inp.onchange = async () => {
      const f = inp.files?.[0];
      if (!f) return;
      try { store.setWorld(await importFile(f)); } catch (e) { store.notify('Import failed: ' + (e as Error).message, 'error'); }
    };
    inp.click();
  };
  return (
    <div class="menu-bg">
      <Backdrop />
      <div style={{ position: 'relative', maxWidth: 760, margin: '0 auto', padding: '9vh 20px 40px' }}>
        <div class="title">ASCENDANT</div>
        <div class="subtitle" style={{ marginTop: 6 }}>A galaxy of strange species · after Ascendancy (1995)</div>
        <div class="col" style={{ alignItems: 'center', marginTop: 40, gap: 10 }}>
          {saves.length > 0 && <button class="btn primary" style={{ width: 280, padding: 12, fontSize: 16 }} disabled={busy} onClick={() => load(saves[0].slot)}>Continue — {saves[0].name}, day {saves[0].day}</button>}
          <button class={'btn ' + (saves.length ? '' : 'primary')} style={{ width: 280, padding: 12, fontSize: 16 }} onClick={onNew}>New Game</button>
          <button class="btn" style={{ width: 280, padding: 10, fontSize: 15 }} onClick={onMultiplayer} data-tip="Play with friends online, or with another tab of this browser">Multiplayer</button>
          <button class="btn" style={{ width: 280 }} onClick={importSave}>Import save file…</button>
        </div>
        {saves.length > 0 && (
          <div class="panel" style={{ marginTop: 30, padding: 10 }}>
            <div class="caps" style={{ padding: '4px 6px 8px' }}>Saved games</div>
            {saves.map((s) => (
              <div key={s.slot} class="fleet-row" onClick={() => load(s.slot)}>
                <img src={portrait(s.species || 'zurvani', '#7fdcff')} width={34} height={34} style={{ borderRadius: 6, objectFit: 'cover' }} />
                <div class="grow"><b>{s.name}</b><div class="small dim">Day {s.day} · {s.stars} stars · {new Date(s.savedAt).toLocaleString()} · {s.slot}</div></div>
                <button class="btn icon sm ghost" onClick={(e) => { e.stopPropagation(); void deleteSlot(s.slot).then(refresh); }} data-tip="Delete this save"><Icon.trash size={14} /></button>
              </div>
            ))}
          </div>
        )}
        <div class="small dim" style={{ textAlign: 'center', marginTop: 30, lineHeight: 1.6 }}>
          {classicAvailable()
            ? <>Classic art detected — upscaled from your copy of Ascendancy. Toggle it in Settings.</>
            : <>Using procedural art. Own the original? Run <span class="kbd">npm run import-classic</span> to upscale its art for local play.</>}
        </div>
      </div>
    </div>
  );
}

export function NewGame({ onBack, onHost }: { onBack: () => void; /** Multiplayer: create a room with these settings instead of starting. */ onHost?: (s: GameSettings) => Promise<void> }) {
  const [s, setS] = useState<GameSettings>(() => {
    const base = { ...DEFAULT_SETTINGS, seed: Math.floor(Math.random() * 1e9) };
    if (!onHost) return base;
    // Hosting: start from the saved multiplayer profile, and a smaller galaxy.
    const p = loadProfile();
    return { ...base, playerSpecies: p.species, playerName: p.name, playerColor: p.color, stars: 80, empires: 4 };
  });
  const [busy, setBusy] = useState(false);
  const sp = SPECIES.find((x) => x.id === s.playerSpecies)!;
  const set = (patch: Partial<GameSettings>) => setS((x) => ({ ...x, ...patch }));
  const sizeIdx = SIZES.findIndex((x) => x.stars === s.stars);
  const maxEmpires = Math.max(2, Math.min(16, Math.floor(s.stars / 8)));
  const names = useMemo(() => ['Concord', 'Hegemony', 'Covenant', 'Ascendancy', 'Commonwealth', 'Union'], []);

  const start = () => {
    setBusy(true);
    if (onHost) {
      void onHost({ ...s, empires: Math.min(s.empires, maxEmpires), playerName: s.playerName || `${sp.adjective} ${names[0]}` })
        .catch((e) => store.notify('Could not create the room: ' + (e as Error).message, 'error'))
        .finally(() => setBusy(false));
      return;
    }
    setTimeout(() => {
      const w = newGame({ ...s, empires: Math.min(s.empires, maxEmpires), playerName: s.playerName || `${sp.adjective} ${names[0]}` });
      visibilityTick(w);
      store.setWorld(w);
      store.notify(`Welcome, leader of the ${w.human()!.name}. Press Space or ▶ to let time flow.`);
    }, 20);
  };

  return (
    <div class="menu-bg">
      <Backdrop />
      <div style={{ position: 'relative', maxWidth: 1180, margin: '0 auto', padding: '28px 20px 40px' }}>
        <div class="row" style={{ marginBottom: 16 }}>
          <button class="btn ghost" onClick={onBack}>← Back</button>
          <h1 style={{ fontSize: 28 }}>{onHost ? 'Host a Multiplayer Game' : 'New Game'}</h1>
          <div class="spacer" />
          <button class="btn primary" style={{ padding: '10px 22px', fontSize: 16 }} disabled={busy} onClick={start}>{busy ? (onHost ? 'Opening room…' : 'Forming galaxy…') : onHost ? 'Create room' : 'Begin'}</button>
        </div>
        <div class="row" style={{ alignItems: 'stretch', gap: 16, flexWrap: 'wrap' }}>
          <div class="panel" style={{ flex: '2 1 560px', padding: 16 }}>
            <div class="caps" style={{ marginBottom: 10 }}>Choose your species</div>
            {onHost && <div class="small dim" style={{ marginBottom: 10 }}>Each player picks their own species in the lobby. "Empires" below is the total, including AI rivals (never fewer than the players who join).</div>}
            <div class="species-grid">
              {SPECIES.map((x) => (
                <div key={x.id} class={'species-card ' + (x.id === s.playerSpecies ? 'on' : '')} onClick={() => set({ playerSpecies: x.id, playerName: `${x.adjective} ${names[x.id.length % names.length]}` })}>
                  <div class="pic" style={{ backgroundImage: `url(${portrait(x.id, x.color, true)})` }} />
                  <div class="meta">
                    <div class="row"><span class="dot" style={{ background: x.color }} /><b>{x.name}</b></div>
                    <div class="tiny dim" style={{ marginTop: 3 }}>{x.traitDesc.split(':')[0]}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div class="panel col" style={{ flex: '1 1 340px', padding: 16, gap: 12 }}>
            <img src={portrait(sp.id, sp.color, true)} style={{ width: '100%', aspectRatio: '3/2', objectFit: 'cover', borderRadius: 10, border: `1px solid ${sp.color}` }} />
            <div>
              <h2 style={{ color: sp.color }}>{sp.plural}</h2>
              <div class="small" style={{ marginTop: 6, lineHeight: 1.5 }}>{sp.lore}</div>
            </div>
            <div class="card small"><b>Trait.</b> {sp.traitDesc}</div>
            <div class="card small"><b>{sp.ability.name}.</b> {sp.ability.desc} <span class="dim">(every {sp.ability.cooldown} days)</span></div>
            <div class="small dim">Thrives on: {sp.favored.join(', ')} worlds.</div>
            <label class="col small" style={{ gap: 4 }}>Empire name<input value={s.playerName} onInput={(e) => set({ playerName: (e.target as HTMLInputElement).value })} /></label>
          </div>
        </div>
        <div class="panel" style={{ marginTop: 16, padding: 16 }}>
          <div class="row wrap" style={{ gap: 24, alignItems: 'flex-start' }}>
            <div class="col" style={{ gap: 6 }}>
              <span class="caps">Galaxy size</span>
              <div class="seg">{SIZES.map((z) => <button key={z.label} class={s.stars === z.stars ? 'on' : ''} onClick={() => set({ stars: z.stars, empires: z.empires })} data-tip={`${z.stars} stars, ${z.empires} empires by default`}>{z.label}</button>)}</div>
              <span class="small dim">{s.stars} stars{sizeIdx < 0 ? ' (custom)' : ''}</span>
              <input type="range" min={30} max={2000} step={10} value={s.stars} onInput={(e) => set({ stars: +(e.target as HTMLInputElement).value })} />
            </div>
            <div class="col" style={{ gap: 6 }}>
              <span class="caps">Shape</span>
              <div class="seg">{SHAPES.map((z) => <button key={z.v} class={s.shape === z.v ? 'on' : ''} onClick={() => set({ shape: z.v })}>{z.label}</button>)}</div>
            </div>
            <div class="col" style={{ gap: 6, minWidth: 180 }}>
              <span class="caps">Empires: {Math.min(s.empires, maxEmpires)}</span>
              <input type="range" min={2} max={maxEmpires} value={Math.min(s.empires, maxEmpires)} onInput={(e) => set({ empires: +(e.target as HTMLInputElement).value })} />
            </div>
            <div class="col" style={{ gap: 6 }}>
              <span class="caps">Difficulty</span>
              <div class="seg">{DIFFS.map((d, i) => <button key={d} class={s.difficulty === i ? 'on' : ''} onClick={() => set({ difficulty: i })} data-tip={DIFF_TIP[i]}>{d}</button>)}</div>
            </div>
            <div class="col" style={{ gap: 6, minWidth: 160 }}>
              <span class="caps">Planet density {Math.round(s.planetDensity * 100)}%</span>
              <input type="range" min={0.5} max={1.5} step={0.1} value={s.planetDensity} onInput={(e) => set({ planetDensity: +(e.target as HTMLInputElement).value })} />
            </div>
            <div class="col" style={{ gap: 6, minWidth: 160 }}>
              <span class="caps" data-tip="Unstable (red) lanes need Lane Stabilizers to cross — they create chokepoints">Unstable lanes {Math.round(s.unstableLanes * 100)}%</span>
              <input type="range" min={0} max={0.4} step={0.02} value={s.unstableLanes} onInput={(e) => set({ unstableLanes: +(e.target as HTMLInputElement).value })} />
            </div>
          </div>
          <div class="row wrap" style={{ gap: 24, marginTop: 16, alignItems: 'center' }}>
            <span class="caps">Victory</span>
            <label class="row small"><input type="checkbox" checked={s.victory.conquest} onChange={(e) => set({ victory: { ...s.victory, conquest: (e.target as HTMLInputElement).checked } })} />Conquest</label>
            <label class="row small" data-tip="Control this share of the galaxy's population"><input type="checkbox" checked={s.victory.domination > 0} onChange={(e) => set({ victory: { ...s.victory, domination: (e.target as HTMLInputElement).checked ? 60 : 0 } })} />Domination {s.victory.domination > 0 && <input type="number" min={30} max={95} value={s.victory.domination} style={{ width: 60 }} onInput={(e) => set({ victory: { ...s.victory, domination: +(e.target as HTMLInputElement).value } })} />}%</label>
            <label class="row small" data-tip="Research Transcendence Theory and build the Ascension Gate"><input type="checkbox" checked={s.victory.ascension} onChange={(e) => set({ victory: { ...s.victory, ascension: (e.target as HTMLInputElement).checked } })} />Ascension</label>
            <label class="row small" data-tip="Stay allied with every surviving empire for 120 days"><input type="checkbox" checked={s.victory.diplomatic} onChange={(e) => set({ victory: { ...s.victory, diplomatic: (e.target as HTMLInputElement).checked } })} />Galactic Accord</label>
            <label class="row small">Day limit <input type="number" min={0} step={100} value={s.victory.dayLimit} style={{ width: 80 }} onInput={(e) => set({ victory: { ...s.victory, dayLimit: +(e.target as HTMLInputElement).value } })} /><span class="dim">(0 = none)</span></label>
            <div class="spacer" />
            <label class="row small">Seed <input type="number" value={s.seed} style={{ width: 130 }} onInput={(e) => set({ seed: +(e.target as HTMLInputElement).value })} /></label>
            <button class="btn sm" onClick={() => set({ seed: Math.floor(Math.random() * 1e9) })}>Randomize</button>
          </div>
        </div>
      </div>
    </div>
  );
}

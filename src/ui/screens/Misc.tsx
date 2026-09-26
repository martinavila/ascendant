import { useEffect, useState } from 'preact/hooks';
import { store, useStore } from '../store';
import { Modal, Section, Bar } from '../common';
import { Icon, Portrait } from '../icons';
import { saveSlot, listSaves, loadSlot, exportFile, deleteSlot, type SaveMeta } from '../../sim/save';
import { classicAvailable, setClassicEnabled } from '../../art/classic';
import { victoryProgress, score } from '../../sim/victory';
import type { EventKind } from '../../sim/types';

const PAUSE_LABELS: Record<EventKind, string> = {
  research: 'Research completed', build: 'Construction completed', colony: 'Colony founded', combat: 'Battles', diplomacy: 'Diplomacy',
  firstContact: 'First contact', growth: 'Population growth', discovery: 'Discoveries & surveys', invasion: 'Invasions', lost: 'Losses',
  ability: 'Species abilities', victory: 'Victory', warning: 'Warnings (stuck fleets, blocked orders)', idle: 'Planet has nothing to build',
};

export function SettingsScreen() {
  const st = useStore();
  const s = st.settings;
  const upd = () => st.saveSettings();
  return (
    <Modal title="Settings" width="720px" height="auto">
      <div class="col scroll" style={{ flex: 1, gap: 0, maxHeight: '80vh' }}>
        <Section title="Time">
          <div class="small dim" style={{ marginBottom: 8 }}>"Until event" runs time until one of these happens. Important ones (battles, first contact, losses) also pause normal play.</div>
          <div class="row wrap" style={{ gap: '6px 18px' }}>
            {(Object.keys(PAUSE_LABELS) as EventKind[]).map((k) => (
              <label key={k} class="row small" style={{ minWidth: 220 }}><input type="checkbox" checked={s.pauseOn[k]} onChange={(e) => { s.pauseOn[k] = (e.target as HTMLInputElement).checked; upd(); }} />{PAUSE_LABELS[k]}</label>
            ))}
          </div>
          <label class="row small" style={{ marginTop: 10 }}>Autosave every <input type="number" min={0} step={10} value={s.autosaveEvery} style={{ width: 70 }} onInput={(e) => { s.autosaveEvery = +(e.target as HTMLInputElement).value; upd(); }} /> days (0 = off)</label>
        </Section>
        <Section title="Graphics">
          <label class="row small"><input type="checkbox" disabled={!classicAvailable()} checked={s.classicArt && classicAvailable()} onChange={(e) => { s.classicArt = (e.target as HTMLInputElement).checked; setClassicEnabled(s.classicArt); upd(); }} />Use classic art (upscaled from your copy of the original)</label>
          {!classicAvailable() && <div class="small dim" style={{ marginTop: 6 }}>Not found. If you own Ascendancy, put its files in <span class="kbd">./ascendancy</span> and run <span class="kbd">npm run import-classic</span>. The art stays on your machine.</div>}
          <label class="row small" style={{ marginTop: 8 }}><input type="checkbox" checked={s.showLabels} onChange={(e) => { s.showLabels = (e.target as HTMLInputElement).checked; upd(); }} />Show star names on the map</label>
        </Section>
      </div>
    </Modal>
  );
}

export function SavesScreen() {
  const st = useStore();
  const w = st.world!;
  const [saves, setSaves] = useState<SaveMeta[]>([]);
  const [name, setName] = useState('');
  const refresh = () => void listSaves().then(setSaves);
  useEffect(refresh, []);
  const save = async (slot: string, label?: string) => {
    await saveSlot(w, slot, label);
    store.notify('Game saved.');
    refresh();
  };
  const download = async () => {
    const blob = await exportFile(w);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ascendant-day${w.s.day}.asc`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  return (
    <Modal title="Save & Load" width="720px" height="auto">
      <div class="col scroll" style={{ flex: 1, gap: 0, maxHeight: '80vh' }}>
        <Section title="Save">
          <div class="row">
            <input class="grow" placeholder={`${w.human()?.name} — day ${w.s.day}`} value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
            <button class="btn primary" onClick={() => save('slot-' + Date.now(), name || undefined)}><Icon.save size={14} /> Save new</button>
            <button class="btn" onClick={download} data-tip="Download a compressed save file you can import anywhere">Export file</button>
          </div>
          <div class="small dim" style={{ marginTop: 6 }}>Outcomes are seeded: reloading a save replays the same results, so there's nothing to gain from save-scumming.</div>
        </Section>
        <Section title="Saved games">
          {saves.map((s) => (
            <div key={s.slot} class="fleet-row">
              <div class="grow"><b>{s.name}</b><div class="small dim">Day {s.day} · {new Date(s.savedAt).toLocaleString()}</div></div>
              <button class="btn sm" onClick={() => save(s.slot, s.name)}>Overwrite</button>
              <button class="btn sm" onClick={async () => { const nw = await loadSlot(s.slot); if (nw) store.setWorld(nw); }}>Load</button>
              <button class="btn icon sm ghost" onClick={() => void deleteSlot(s.slot).then(refresh)}><Icon.trash size={14} /></button>
            </div>
          ))}
        </Section>
      </div>
    </Modal>
  );
}

export function VictoryScreen() {
  const st = useStore();
  const w = st.world!;
  const win = w.s.winner;
  const human = w.human();
  if (!win) {
    const prog = human ? victoryProgress(w, human.id) : [];
    return (
      <Modal title="Victory conditions" width="640px" height="auto">
        <div class="col" style={{ padding: 16, gap: 12, flex: 1 }}>
          {prog.filter((p) => p.enabled).map((p) => (
            <div key={p.kind}>
              <div class="row"><b>{p.label}</b><div class="spacer" /><span class="mono dim">{Math.round(p.value * 100)}%</span></div>
              <Bar value={p.value} max={1} color="var(--warn)" style={{ margin: '4px 0' }} />
              <div class="small dim">{p.detail}</div>
            </div>
          ))}
        </div>
      </Modal>
    );
  }
  const winner = w.s.empires[win.empire];
  const youWon = human && win.empire === human.id;
  const ranking = [...w.s.empires].sort((a, b) => score(w, b) - score(w, a));
  return (
    <Modal title={youWon ? 'Victory!' : 'Defeat'} width="760px" height="auto" onClose={() => st.open('none')}>
      <div class="col" style={{ padding: 20, gap: 16, flex: 1, alignItems: 'center', textAlign: 'center' }}>
        <Portrait species={winner.species} color={winner.color} size={140} big />
        <h2 style={{ fontSize: 28, color: winner.color }}>{winner.name}</h2>
        <div>{win.kind} victory on day {win.day}.</div>
        {!youWon && human && <div class="dim">Your {human.alive ? 'empire endures, but the galaxy belongs to another.' : 'empire has fallen.'}</div>}
        <table class="list" style={{ maxWidth: 560 }}>
          <thead><tr><th>Empire</th><th>Planets</th><th>Pop</th><th>Techs</th><th>Score</th></tr></thead>
          <tbody>
            {ranking.map((e) => (
              <tr key={e.id}><td><span class="dot" style={{ background: e.color }} /> {e.name}{e.alive ? '' : ' †'}</td><td>{w.planetsOf[e.id].length}</td><td>{e.last.pop}</td><td>{e.research.known.length}</td><td>{score(w, e)}</td></tr>
            ))}
          </tbody>
        </table>
        <div class="row">
          <button class="btn" onClick={() => st.open('none')}>Keep looking around</button>
          <button class="btn primary" onClick={() => store.setWorld(null)}>Main menu</button>
        </div>
      </div>
    </Modal>
  );
}

export function GameMenu({ onClose }: { onClose: () => void }) {
  const st = useStore();
  return (
    <div class="overlay" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="panel col" style={{ padding: 20, gap: 10, width: 300 }}>
        <div class="brand" style={{ textAlign: 'center', fontSize: 18, marginBottom: 8 }}>ASCEND<span>ANT</span></div>
        <button class="btn" onClick={() => { onClose(); st.open('saves'); }}><Icon.save size={14} /> Save / Load</button>
        <button class="btn" onClick={() => { onClose(); st.open('victory'); }}><Icon.trophy size={14} /> Victory progress</button>
        <button class="btn" onClick={() => { onClose(); st.open('settings'); }}><Icon.gear size={14} /> Settings</button>
        <button class="btn" onClick={() => { onClose(); st.open('encyclopedia', { entry: 'guide:basics' }); }}><Icon.help size={14} /> How to play</button>
        <button class="btn danger" onClick={async () => { onClose(); const w = st.world; if (w) await saveSlot(w, 'autosave', 'Autosave'); store.setWorld(null); }}>Save & quit to menu</button>
        <button class="btn ghost" onClick={onClose}>Resume</button>
      </div>
    </div>
  );
}

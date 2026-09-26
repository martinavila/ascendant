import { useEffect, useState } from 'preact/hooks';
import { useStore } from './store';
import { MainMenu, NewGame } from './Menu';
import { MapView, galaxyView } from './hud/MapView';
import { TopBar, SPEEDS, nextIdle } from './hud/TopBar';
import { Outliner } from './hud/Outliner';
import { StarPanel } from './hud/StarPanel';
import { FleetPanel } from './hud/FleetPanel';
import { PlanetScreen } from './hud/PlanetScreen';
import { FirstSteps } from './hud/FirstSteps';
import { TooltipLayer } from './common';
import { Icon } from './icons';
import { ResearchScreen } from './screens/Research';
import { DesignerScreen } from './screens/Designer';
import { DiplomacyScreen } from './screens/Diplomacy';
import { BattleScreen } from './screens/Battle';
import { EmpireScreen } from './screens/Empire';
import { EncyclopediaScreen } from './screens/Encyclopedia';
import { SettingsScreen, SavesScreen, VictoryScreen, GameMenu } from './screens/Misc';
import { setClassicEnabled } from '../art/classic';
import { Lobby, hostRoom } from './screens/Lobby';

export function App() {
  const st = useStore();
  const [phase, setPhase] = useState<'menu' | 'new' | 'mp' | 'mp-host'>(() => (new URLSearchParams(location.search).has('room') ? 'mp' : 'menu'));
  useEffect(() => setClassicEnabled(st.settings.classicArt), []);
  const initialRoom = new URLSearchParams(location.search).get('room');
  let body;
  if (st.world) body = <Game key={st.worldId} />;
  else if (st.net || phase === 'mp') body = <Lobby onBack={() => setPhase('menu')} onHost={() => setPhase('mp-host')} initialRoom={initialRoom} />;
  else if (phase === 'mp-host') body = <NewGame onBack={() => setPhase('mp')} onHost={async (s) => { await hostRoom(s); setPhase('mp'); }} />;
  else if (phase === 'new') body = <NewGame onBack={() => setPhase('menu')} />;
  else body = <MainMenu onNew={() => setPhase('new')} onMultiplayer={() => setPhase('mp')} />;
  return (
    <>
      {body}
      <TooltipLayer />
      {st.toast && <div class={'panel toast ' + st.toast.kind}>{st.toast.text}</div>}
    </>
  );
}

function Game() {
  const st = useStore();
  const w = st.world!;
  const [menu, setMenu] = useState(false);
  const [mobileOutliner, setMobileOutliner] = useState(false);
  const [planetOpen, setPlanetOpen] = useState(true);

  // Opening a planet from anywhere shows the planet screen.
  useEffect(() => { if (st.sel.planet !== null) setPlanetOpen(true); }, [st.sel.planet]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('input,textarea,select')) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();
      const modalOpen = st.screen !== 'none';
      if (key === ' ') {
        e.preventDefault();
        st.speed ? st.pause() : st.play(SPEEDS[1].v);
        return;
      }
      if (key === 'escape') {
        if (st.pick) { st.pick = null; st.emit(); return; }
        if (modalOpen) return; // Modal handles Esc.
        if (st.sel.planet !== null) return;
        if (st.sel.fleet !== null || st.sel.star !== null) { st.select({ fleet: null, star: null, planet: null }); return; }
        setMenu((m) => !m);
        return;
      }
      if (modalOpen) return;
      const idx = ['1', '2', '3'].indexOf(key);
      if (idx >= 0) return st.play(SPEEDS[idx].v);
      if (key === '4') return st.play(60, true);
      if (key === '.') return st.step(1);
      if (key === 'r') return st.open('research');
      if (key === 'd') return st.open('designer');
      if (key === 'p') return st.open('diplomacy');
      if (key === 'e') return st.open('empire');
      if (key === 'b') return st.open('battle');
      if (key === 'h' || key === '?') return st.open('encyclopedia');
      if (key === 'n') return nextIdle();
      if (key === 'f') return galaxyView()?.fitAll();
      if (key === 'c') {
        const cap = w.human()?.capital;
        if (cap != null) { st.select({ star: w.s.planets[cap].star, planet: null, fleet: null }); st.focus(w.s.planets[cap].star); }
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  const fleet = st.sel.fleet !== null ? w.s.fleets[st.sel.fleet] : undefined;
  const showRight = !!fleet || st.sel.star !== null;

  return (
    <div class="game">
      <MapView />
      <TopBar onMenu={() => setMenu(true)} />
      <Outliner mobileOpen={mobileOutliner} />
      <FirstSteps />
      <button class="btn icon" style={{ position: 'absolute', left: 8, bottom: 8, zIndex: 16, display: window.innerWidth < 860 ? 'flex' : 'none' }} onClick={() => setMobileOutliner((x) => !x)}><Icon.menu /></button>
      {showRight && (
        <div class="panel right">
          <div class="row" style={{ position: 'absolute', right: 6, top: 6, zIndex: 2 }}>
            <button class="btn icon sm ghost" onClick={() => st.select({ fleet: null, star: null, planet: null })} data-tip="Close (Esc)"><Icon.close size={14} /></button>
          </div>
          {fleet ? <FleetPanel key={fleet.id} fleet={fleet} /> : st.sel.star !== null ? <StarPanel key={st.sel.star} starId={st.sel.star} /> : null}
        </div>
      )}
      {st.sel.planet !== null && planetOpen && st.screen === 'none' && (
        <PlanetScreen planetId={st.sel.planet} onClose={() => { setPlanetOpen(false); st.select({ planet: null }); }} />
      )}
      {st.pick && (
        <div class="panel pickbar">
          <Icon.target size={16} /> <span>{st.pick.hint}</span>
          <button class="btn sm" onClick={() => { st.pick = null; st.emit(); }}>Cancel (Esc)</button>
        </div>
      )}
      {st.screen === 'research' && <ResearchScreen />}
      {st.screen === 'designer' && <DesignerScreen />}
      {st.screen === 'diplomacy' && <DiplomacyScreen />}
      {st.screen === 'battle' && <BattleScreen />}
      {st.screen === 'empire' && <EmpireScreen />}
      {st.screen === 'encyclopedia' && <EncyclopediaScreen />}
      {st.screen === 'settings' && <SettingsScreen />}
      {st.screen === 'saves' && <SavesScreen />}
      {st.screen === 'victory' && <VictoryScreen />}
      {menu && <GameMenu onClose={() => setMenu(false)} />}
    </div>
  );
}

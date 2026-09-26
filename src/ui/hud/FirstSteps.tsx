import { useState } from 'preact/hooks';
import { store, useStore } from '../store';
import { Icon } from '../icons';

// A short checklist for the first hour. The original dropped players into a
// dense UI with no guidance; this points at the five things that matter.

export function FirstSteps() {
  const st = useStore();
  const [hidden, setHidden] = useState(() => {
    try { return localStorage.getItem('ascendant-firststeps') === 'done'; } catch { return false; }
  });
  const w = st.world!;
  const e = w.human();
  if (!e || hidden || !st.settings.tutorialTips) return null;
  const mine = w.planetsOf[e.id].map((id) => w.s.planets[id]);
  const steps = [
    { done: !!e.research.current || e.research.known.length > 0, text: 'Pick something to research (R).', go: () => st.open('research') },
    { done: mine.some((p) => p.queue.length > 0 || p.governor.on), text: 'Open your capital and queue a structure — or switch on its Governor.', go: () => { const c = e.capital; if (c != null) st.select({ planet: c, star: w.s.planets[c].star }); } },
    { done: Object.values(w.s.fleets).some((f) => f.owner === e.id && (f.route.length > 0 || f.order.kind === 'explore' || f.lastStar !== undefined)), text: 'Send a Pathfinder to explore: select it, then Auto-explore or right-click a star.', go: () => st.select({ fleet: Object.values(w.s.fleets).find((f) => f.owner === e.id)?.id ?? null }) },
    { done: mine.length > 1, text: 'Settle a second world with your Seedship (Colonize in the system panel).', go: () => { const c = e.capital; if (c != null) st.select({ star: w.s.planets[c].star, planet: null, fleet: null }); } },
    { done: st.speed > 0 || w.s.day > 5, text: 'Let time flow: Space, or "Until event" to skip to the next thing that needs you.', go: () => st.play(6) },
  ];
  const close = () => {
    try { localStorage.setItem('ascendant-firststeps', 'done'); } catch { /* ignore */ }
    setHidden(true);
  };
  if (steps.every((s) => s.done) && w.s.day > 30) return null;
  return (
    <div class="panel firststeps">
      <div class="row" style={{ marginBottom: 6 }}>
        <b style={{ fontFamily: 'var(--display)' }}>First steps</b>
        <div class="spacer" />
        <button class="btn sm ghost" onClick={() => store.open('encyclopedia', { entry: 'guide:basics' })}><Icon.help size={13} /> Guide</button>
        <button class="btn icon sm ghost" onClick={close} data-tip="Hide for good"><Icon.close size={13} /></button>
      </div>
      <ul style={{ margin: 0, padding: 0 }}>
        {steps.map((s, i) => (
          <li key={i} class={s.done ? 'done' : ''} style={{ cursor: s.done ? 'default' : 'pointer' }} onClick={() => !s.done && s.go()}>
            <span class="ck">{s.done ? '✓' : i + 1}</span><span>{s.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

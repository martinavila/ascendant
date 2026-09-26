import { render } from 'preact';
import './ui/styles.css';
import { App } from './ui/App';
import { loadClassic } from './art/classic';
import { store } from './ui/store';
import { newGame, DEFAULT_SETTINGS } from './sim/gen';
import { visibilityTick } from './sim/visibility';

void loadClassic().then(() => {
  // Dev shortcut: ?quick[=seed] starts a default game immediately.
  const q = new URLSearchParams(location.search);
  if (q.has('quick')) {
    const w = newGame({ ...DEFAULT_SETTINGS, seed: Number(q.get('quick')) || 7, stars: Number(q.get('stars')) || DEFAULT_SETTINGS.stars });
    visibilityTick(w);
    store.setWorld(w);
  }
  render(<App />, document.getElementById('app')!);
});

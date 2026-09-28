import { render } from 'preact';
import './ui/styles.css';
import { App } from './ui/App';
import { loadClassic } from './art/classic';
import { store } from './ui/store';
import { newGame, DEFAULT_SETTINGS } from './sim/gen';
import { visibilityTick } from './sim/visibility';

// iOS Safari ignores user-scalable=no: block its pinch-zoom gestures so the
// page never zooms (maps and the tech web handle pinch themselves).
for (const ev of ['gesturestart', 'gesturechange']) document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });

// Offline cache / installability: production builds only (never interferes with Vite dev).
if (import.meta.env.PROD && 'serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => { void navigator.serviceWorker.register('./sw.js').catch(() => { /* optional */ }); });
}

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

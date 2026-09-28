// Minimal offline cache for Ascendant (registered in production builds only).
// - Hashed build assets (assets/*) and icons: cache-first (URLs change when content does).
// - 3D models (models/*): stale-while-revalidate, so a rebuilt model shows up on the next visit.
// - Page navigations: network-first, falling back to the cached shell offline.
// Everything else (Supabase, fonts, other origins) goes straight to the network.
const VERSION = 'ascendant-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const scope = new URL(self.registration.scope);
  const path = url.pathname.slice(scope.pathname.length);
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        const c = await caches.open(VERSION);
        c.put(scope.href, res.clone());
        return res;
      } catch {
        return (await caches.match(scope.href)) || Response.error();
      }
    })());
    return;
  }
  const put = async (res) => { if (res.ok) await (await caches.open(VERSION)).put(req, res.clone()); return res; };
  if (/^(assets|icons)\//.test(path)) {
    e.respondWith((async () => (await caches.match(req)) || put(await fetch(req)))());
  } else if (/^models\//.test(path)) {
    e.respondWith((async () => {
      const hit = await caches.match(req);
      const fresh = fetch(req).then(put);
      if (hit) { e.waitUntil(fresh.catch(() => {})); return hit; }
      return fresh;
    })());
  }
});

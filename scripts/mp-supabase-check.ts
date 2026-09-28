// Live check of multiplayer over the real Supabase project in .env.local:
//   npx vite-node scripts/mp-supabase-check.ts
import { DEFAULT_SETTINGS } from '../src/sim/gen';
import { serialize } from '../src/sim/save';
import { createClient } from '@supabase/supabase-js';
import { SupabaseTransport } from '../src/net/supabase';
import { NetSession } from '../src/net/lockstep';
import { makeRoomCode } from '../src/net/transport';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const room = makeRoomCode();
const settings = { ...DEFAULT_SETTINGS, seed: 77, stars: 60, empires: 4 };
const mk = (id: string, host: boolean, species: string) =>
  new NetSession({ transport: new SupabaseTransport({ id, name: id, host }, createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY)), host, room, profile: { name: id, species, color: '' }, settings: host ? settings : undefined, timers: true });

const H = mk('host-' + Date.now(), true, 'zurvani');
const C = mk('guest-' + Date.now(), false, 'grakk');
await H.connect();
await C.connect();
for (let i = 0; i < 40 && H.lobby.length < 2; i++) await sleep(250);
C.setProfile({}, true);
for (let i = 0; i < 40 && !H.canStart(); i++) await sleep(250);
console.log('room', room, 'lobby', H.lobby.map((p) => p.name), 'canStart', H.canStart());
H.startGame();
for (let i = 0; i < 60 && !C.world; i++) await sleep(250);
console.log('guest has world:', !!C.world, 'me', H.me, C.me);
H.requestSpeed(20);
const t0 = Date.now();
let sent = false;
while (Date.now() - t0 < 12000) {
  H.hostFrame(0.05);
  H.pump();
  C.pump();
  if (!sent && C.world && C.world.s.day > 10) {
    const f = Object.values(C.world.s.fleets).find((x) => x.owner === C.me && x.transit === 0)!;
    C.command({ t: 'moveFleet', fleet: f.id, dest: C.world.adj[f.star][0].to });
    sent = true;
  }
  await sleep(50);
}
H.requestSpeed(0);
await sleep(1500);
H.pump(); C.pump();
const hd = H.world!.s.day, cd = C.world!.s.day;
console.log('days host/guest', hd, cd);
if (hd === cd) console.log('identical state:', serialize(H.world!) === serialize(C.world!));
H.leave(); C.leave();
await sleep(500);
process.exit(0);

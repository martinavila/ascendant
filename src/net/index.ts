// Browser-side glue: player identity, saved lobby profile, transport choice.

import type { GameSettings } from '../sim/types';
import { SPECIES } from '../sim/content';
import { NetSession, type Profile } from './lockstep';
import { LocalTransport } from './local';
import { makeRoomCode, normalizeRoomCode, supabaseConfigured, type Transport } from './transport';

export { makeRoomCode, normalizeRoomCode, supabaseConfigured };
export type TransportKind = 'local' | 'supabase';

/** Stable per tab: survives reloads (so you rejoin your seat) but differs between tabs. */
export function clientId(): string {
  const KEY = 'ascendant-client-id';
  try {
    let id = sessionStorage.getItem(KEY);
    if (!id) {
      id = 'p' + Math.random().toString(36).slice(2, 10);
      sessionStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    return 'p' + Math.random().toString(36).slice(2, 10);
  }
}

export function loadProfile(): Profile {
  try {
    const raw = localStorage.getItem('ascendant-mp-profile');
    if (raw) {
      const p = JSON.parse(raw) as Profile;
      if (SPECIES.some((s) => s.id === p.species)) return p;
    }
  } catch { /* ignore */ }
  const sp = SPECIES[Math.floor(Math.random() * SPECIES.length)];
  return { name: `${sp.adjective} Concord`, species: sp.id, color: sp.color };
}

export function saveProfile(p: Profile) {
  try { localStorage.setItem('ascendant-mp-profile', JSON.stringify(p)); } catch { /* ignore */ }
}

/** `?net=local` forces the BroadcastChannel transport; otherwise Supabase when configured. */
export function defaultTransport(): TransportKind {
  const q = new URLSearchParams(location.search);
  if (q.get('net') === 'local') return 'local';
  if (q.get('net') === 'supabase') return 'supabase';
  return supabaseConfigured() ? 'supabase' : 'local';
}

async function makeTransport(kind: TransportKind, name: string, host: boolean): Promise<Transport> {
  const self = { id: clientId(), name, host };
  if (kind === 'supabase') {
    const { SupabaseTransport } = await import('./supabase');
    return new SupabaseTransport(self);
  }
  return new LocalTransport(self);
}

export async function createSession(opts: { kind: TransportKind; host: boolean; room: string; profile: Profile; settings?: GameSettings }): Promise<NetSession> {
  const transport = await makeTransport(opts.kind, opts.profile.name, opts.host);
  const session = new NetSession({ transport, host: opts.host, room: normalizeRoomCode(opts.room), profile: opts.profile, settings: opts.settings });
  await session.connect();
  rememberRoom(opts.host ? null : session.room);
  return session;
}

/** The room this tab last joined as a guest, so a page reload can rejoin automatically. */
export function rememberedRoom(): string | null {
  try { return sessionStorage.getItem('ascendant-room'); } catch { return null; }
}

export function rememberRoom(room: string | null) {
  try { room ? sessionStorage.setItem('ascendant-room', room) : sessionStorage.removeItem('ascendant-room'); } catch { /* ignore */ }
}

/** Shareable invite link for a room. */
export function inviteLink(room: string, kind: TransportKind): string {
  const u = new URL(location.href);
  u.search = '';
  u.searchParams.set('room', room);
  if (kind === 'local') u.searchParams.set('net', 'local');
  return u.toString();
}

/** Reflect the current room in the address bar (so a reload rejoins). */
export function setRoomInUrl(room: string | null) {
  try {
    const u = new URL(location.href);
    if (room) u.searchParams.set('room', room);
    else u.searchParams.delete('room');
    history.replaceState(null, '', u.toString());
  } catch { /* ignore */ }
}

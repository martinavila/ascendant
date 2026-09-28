// Internet transport over Supabase Realtime: one broadcast + presence channel
// per room code. No database tables are needed — Realtime broadcast relays
// messages between connected clients, and presence tracks who is in the room.
//
// Configure with VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (see docs/MULTIPLAYER.md).

import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import { Emitter, type Envelope, type PeerMeta, type Transport } from './transport';

let client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (client) return client;
  const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env;
  const url = env.VITE_SUPABASE_URL, key = env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('Supabase is not configured (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY).');
  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    // The lockstep host already batches ticks; allow short bursts (chat + commands + ticks).
    realtime: { params: { eventsPerSecond: 40 } },
  });
  return client;
}

export class SupabaseTransport implements Transport {
  readonly kind = 'Supabase Realtime';
  private ch: RealtimeChannel | null = null;
  private msgs = new Emitter<Envelope>();
  private pres = new Emitter<PeerMeta[]>();

  /** `client` lets tests run two players in one process (each needs its own socket). */
  constructor(readonly self: PeerMeta, private client?: SupabaseClient) {}

  join(room: string): Promise<void> {
    const sb = this.client ?? getClient();
    const ch = sb.channel('ascendant:' + room, {
      config: { broadcast: { self: false, ack: false }, presence: { key: this.self.id, enabled: true } },
    });
    this.ch = ch;
    ch.on('broadcast', { event: 'm' }, ({ payload }) => {
      const env = payload as Envelope;
      if (!env || env.from === this.self.id) return;
      if (env.to && env.to !== this.self.id) return;
      this.msgs.emit(env);
    });
    ch.on('presence', { event: 'sync' }, () => {
      const state = ch.presenceState<PeerMeta>();
      const peers = new Map<string, PeerMeta>([[this.self.id, this.self]]);
      for (const [key, metas] of Object.entries(state)) {
        const m = metas[metas.length - 1];
        if (m) peers.set(key, { id: key, name: m.name, host: m.host });
      }
      this.pres.emit([...peers.values()]);
    });
    return new Promise((resolve, reject) => {
      let settled = false;
      ch.subscribe(async (status, err) => {
        if (status === 'SUBSCRIBED') {
          await ch.track({ id: this.self.id, name: this.self.name, host: !!this.self.host });
          if (!settled) { settled = true; resolve(); }
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          if (!settled) { settled = true; reject(err ?? new Error('Could not connect to Supabase Realtime (' + status + ').')); }
          else console.warn('[net/supabase]', status, err);
        }
      });
    });
  }

  send(env: Omit<Envelope, 'from'>) {
    void this.ch?.send({ type: 'broadcast', event: 'm', payload: { ...env, from: this.self.id } });
  }

  onMessage(cb: (env: Envelope) => void) { return this.msgs.on(cb); }
  onPresence(cb: (peers: PeerMeta[]) => void) { return this.pres.on(cb); }

  leave() {
    const ch = this.ch;
    this.ch = null;
    if (ch) {
      void ch.untrack().catch(() => {});
      void (this.client ?? getClient()).removeChannel(ch);
    }
    this.msgs.clear();
    this.pres.clear();
  }
}

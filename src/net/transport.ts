// A room-scoped broadcast channel with presence. The lockstep layer only needs
// "send to everyone in the room" plus "who is here"; direct messages are
// broadcasts with a `to` field that other peers ignore.

export interface PeerMeta {
  /** Stable per browser tab (sessionStorage), so a reload rejoins the same seat. */
  id: string;
  name: string;
  host?: boolean;
}

export interface Envelope<M = unknown> {
  /** Sender peer id. */
  from: string;
  /** Recipient peer id; absent = everyone. */
  to?: string;
  msg: M;
}

export interface Transport {
  /** Human-readable kind for the UI ("Local (this browser)", "Supabase Realtime"). */
  readonly kind: string;
  readonly self: PeerMeta;
  /** Connect to a room. Resolves once messages can be sent. */
  join(room: string): Promise<void>;
  /** Broadcast to the room (never delivered back to the sender). */
  send(env: Omit<Envelope, 'from'>): void;
  onMessage(cb: (env: Envelope) => void): () => void;
  /** Fires with the full current peer list (including self) whenever it changes. */
  onPresence(cb: (peers: PeerMeta[]) => void): () => void;
  leave(): void;
}

/** Small helper so transports share listener bookkeeping. */
export class Emitter<T> {
  private ls = new Set<(v: T) => void>();
  on(cb: (v: T) => void) {
    this.ls.add(cb);
    return () => { this.ls.delete(cb); };
  }
  emit(v: T) {
    for (const l of [...this.ls]) {
      try { l(v); } catch (e) { console.error('[net]', e); }
    }
  }
  clear() { this.ls.clear(); }
}

export function supabaseConfigured(): boolean {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  return !!(env.VITE_SUPABASE_URL && env.VITE_SUPABASE_ANON_KEY);
}

/** Room codes: 6 unambiguous characters. */
export function makeRoomCode(): string {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  const buf = new Uint32Array(6);
  crypto.getRandomValues(buf);
  for (const n of buf) s += A[n % A.length];
  return s;
}

export function normalizeRoomCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}

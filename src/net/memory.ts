// In-memory transport for tests: every client shares a Hub. Messages queue up
// until `hub.flush()` (or deliver immediately with `auto`), so tests control
// ordering and latency exactly. Supports dropping / tampering for fault tests.

import { Emitter, type Envelope, type PeerMeta, type Transport } from './transport';

export class MemoryHub {
  members = new Map<string, MemoryTransport>();
  queue: { env: Envelope; room: string }[] = [];
  /** Optional hook: return false to drop a message. */
  filter: ((env: Envelope) => boolean) | null = null;
  constructor(public auto = false) {}

  post(room: string, env: Envelope) {
    if (this.filter && !this.filter(env)) return;
    this.queue.push({ env, room });
    if (this.auto) this.flush();
  }

  /** Deliver queued messages (including ones produced while delivering). Returns count. */
  flush(max = 1e6): number {
    let n = 0;
    while (this.queue.length && n < max) {
      const { env, room } = this.queue.shift()!;
      n++;
      for (const m of this.members.values()) if (m.room === room && m.self.id !== env.from && (!env.to || env.to === m.self.id)) m.deliver(env);
    }
    return n;
  }

  presenceChanged(room: string) {
    const peers = [...this.members.values()].filter((m) => m.room === room).map((m) => m.self);
    for (const m of this.members.values()) if (m.room === room) m.presence(peers);
  }
}

export class MemoryTransport implements Transport {
  readonly kind = 'Memory (tests)';
  room: string | null = null;
  private msgs = new Emitter<Envelope>();
  private pres = new Emitter<PeerMeta[]>();

  constructor(readonly hub: MemoryHub, readonly self: PeerMeta) {}

  async join(room: string) {
    this.room = room;
    this.hub.members.set(this.self.id, this);
    this.hub.presenceChanged(room);
  }

  send(env: Omit<Envelope, 'from'>) {
    if (this.room) this.hub.post(this.room, JSON.parse(JSON.stringify({ ...env, from: this.self.id })));
  }

  onMessage(cb: (env: Envelope) => void) { return this.msgs.on(cb); }
  onPresence(cb: (peers: PeerMeta[]) => void) { return this.pres.on(cb); }

  deliver(env: Envelope) { this.msgs.emit(env); }
  presence(peers: PeerMeta[]) { this.pres.emit(peers); }

  leave() {
    const room = this.room;
    this.hub.members.delete(this.self.id);
    this.room = null;
    if (room) this.hub.presenceChanged(room);
    this.msgs.clear();
    this.pres.clear();
  }
}

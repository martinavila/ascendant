// Same-machine transport over BroadcastChannel: open two tabs of the game and
// they can play together with no server at all. Presence is emulated with
// heartbeats (every second; a peer is gone after 10 s of silence or on "bye").

import { Emitter, type Envelope, type PeerMeta, type Transport } from './transport';

type Wire =
  | { k: 'beat'; peer: PeerMeta }
  | { k: 'bye'; id: string }
  | { k: 'env'; env: Envelope };

const BEAT_MS = 1000;
const TIMEOUT_MS = 10000;

export class LocalTransport implements Transport {
  readonly kind = 'Local (this browser)';
  private ch: BroadcastChannel | null = null;
  private msgs = new Emitter<Envelope>();
  private pres = new Emitter<PeerMeta[]>();
  private peers = new Map<string, { meta: PeerMeta; seen: number }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private unload = () => this.leave();

  constructor(readonly self: PeerMeta) {}

  async join(room: string) {
    this.ch = new BroadcastChannel('ascendant-room-' + room);
    this.ch.onmessage = (ev: MessageEvent<Wire>) => this.recv(ev.data);
    this.beat();
    this.timer = setInterval(() => { this.beat(); this.expire(); }, BEAT_MS);
    addEventListener('pagehide', this.unload);
    this.firePresence();
  }

  send(env: Omit<Envelope, 'from'>) {
    this.post({ k: 'env', env: { ...env, from: this.self.id } });
  }

  onMessage(cb: (env: Envelope) => void) { return this.msgs.on(cb); }
  onPresence(cb: (peers: PeerMeta[]) => void) { return this.pres.on(cb); }

  leave() {
    if (!this.ch) return;
    this.post({ k: 'bye', id: this.self.id });
    if (this.timer) clearInterval(this.timer);
    removeEventListener('pagehide', this.unload);
    this.ch.close();
    this.ch = null;
    this.peers.clear();
    this.msgs.clear();
    this.pres.clear();
  }

  private post(w: Wire) {
    try { this.ch?.postMessage(w); } catch (e) { console.error('[net/local] send failed', e); }
  }

  private beat() { this.post({ k: 'beat', peer: this.self }); }

  private recv(w: Wire) {
    if (w.k === 'beat') {
      const known = this.peers.get(w.peer.id);
      this.peers.set(w.peer.id, { meta: w.peer, seen: Date.now() });
      if (!known) {
        this.beat(); // Let the newcomer learn about us right away.
        this.firePresence();
      } else if (known.meta.name !== w.peer.name || known.meta.host !== w.peer.host) this.firePresence();
    } else if (w.k === 'bye') {
      if (this.peers.delete(w.id)) this.firePresence();
    } else if (w.k === 'env') {
      if (w.env.from === this.self.id) return;
      // Seeing a message also proves the peer is alive.
      const p = this.peers.get(w.env.from);
      if (p) p.seen = Date.now();
      if (w.env.to && w.env.to !== this.self.id) return;
      this.msgs.emit(w.env);
    }
  }

  private expire() {
    const now = Date.now();
    let changed = false;
    for (const [id, p] of this.peers) if (now - p.seen > TIMEOUT_MS) { this.peers.delete(id); changed = true; }
    if (changed) this.firePresence();
  }

  private firePresence() {
    this.pres.emit([this.self, ...[...this.peers.values()].map((p) => p.meta)]);
  }
}

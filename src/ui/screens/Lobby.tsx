// Multiplayer lobby: pick a transport and profile, host (via the New Game
// screen) or join a room by code, then wait for everyone to be ready.

import { useEffect, useState } from 'preact/hooks';
import { store, useStore } from '../store';
import { Icon, Portrait } from '../icons';
import { SPECIES, SPECIES_BY_ID } from '../../sim/content';
import type { GameSettings } from '../../sim/types';
import type { Profile } from '../../net/lockstep';
import {
  createSession, defaultTransport, inviteLink, loadProfile, makeRoomCode, normalizeRoomCode, rememberRoom, rememberedRoom, saveProfile, setRoomInUrl, supabaseConfigured, type TransportKind,
} from '../../net';
import { Chat } from '../hud/NetPanel';

const DIFFS = ['Relaxed', 'Normal', 'Hard', 'Brutal'];

let transportKind: TransportKind = defaultTransport();
export const getTransportKind = () => transportKind;

/** Host flow: called by the New Game screen in "host" mode. */
export async function hostRoom(settings: GameSettings) {
  const sp = SPECIES_BY_ID[settings.playerSpecies];
  const profile: Profile = { name: settings.playerName || `${sp.adjective} Concord`, species: sp.id, color: settings.playerColor || sp.color };
  saveProfile(profile);
  const room = makeRoomCode();
  const net = await createSession({ kind: transportKind, host: true, room, profile, settings });
  store.attachNet(net);
  setRoomInUrl(room);
}

export function Lobby({ onBack, onHost, initialRoom }: { onBack: () => void; onHost: () => void; initialRoom?: string | null }) {
  const st = useStore();
  return (
    <div class="menu-bg" style={{ overflowY: 'auto' }}>
      <div style={{ position: 'relative', maxWidth: 980, margin: '0 auto', padding: '28px 16px 40px' }}>
        {st.net && st.net.phase !== 'ended' ? <Room /> : <Entry onBack={onBack} onHost={onHost} initialRoom={initialRoom} />}
      </div>
    </div>
  );
}

function ProfileEditor({ profile, onChange, disabled }: { profile: Profile; onChange: (p: Profile) => void; disabled?: boolean }) {
  const sp = SPECIES_BY_ID[profile.species] ?? SPECIES[0];
  return (
    <div class="row wrap" style={{ gap: 12, alignItems: 'center' }}>
      <Portrait species={sp.id} color={profile.color || sp.color} size={56} />
      <label class="col small" style={{ gap: 4, flex: '1 1 180px' }}>Empire name
        <input value={profile.name} maxLength={40} disabled={disabled} onInput={(e) => onChange({ ...profile, name: (e.target as HTMLInputElement).value })} />
      </label>
      <label class="col small" style={{ gap: 4 }}>Species
        <select value={sp.id} disabled={disabled} onChange={(e) => {
          const nsp = SPECIES_BY_ID[(e.target as HTMLSelectElement).value];
          const autoName = profile.name === `${sp.adjective} Concord` || !profile.name;
          onChange({ ...profile, species: nsp.id, color: profile.color === sp.color ? nsp.color : profile.color, name: autoName ? `${nsp.adjective} Concord` : profile.name });
        }}>
          {SPECIES.map((x) => <option key={x.id} value={x.id}>{x.name} — {x.traitDesc.split(':')[0]}</option>)}
        </select>
      </label>
      <label class="col small" style={{ gap: 4 }}>Color
        <input type="color" value={profile.color || sp.color} disabled={disabled} style={{ width: 48, height: 30, padding: 0, border: 0, background: 'transparent' }} onInput={(e) => onChange({ ...profile, color: (e.target as HTMLInputElement).value })} />
      </label>
    </div>
  );
}

function TransportPicker({ kind, setKind }: { kind: TransportKind; setKind: (k: TransportKind) => void }) {
  const sb = supabaseConfigured();
  return (
    <div class="col" style={{ gap: 6 }}>
      <span class="caps">Connection</span>
      <div class="seg">
        <button class={kind === 'supabase' ? 'on' : ''} disabled={!sb} onClick={() => setKind('supabase')} data-tip={sb ? 'Play over the internet via Supabase Realtime' : 'Not configured: set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (see docs/MULTIPLAYER.md)'}>Internet (Supabase)</button>
        <button class={kind === 'local' ? 'on' : ''} onClick={() => setKind('local')} data-tip="Tabs of this browser on this machine — great for testing">Local (same browser)</button>
      </div>
      {!sb && <span class="tiny dim">Internet play needs a Supabase project — see docs/MULTIPLAYER.md. Local mode links tabs of this browser.</span>}
    </div>
  );
}

function Entry({ onBack, onHost, initialRoom }: { onBack: () => void; onHost: () => void; initialRoom?: string | null }) {
  const [profile, setProfile] = useState<Profile>(loadProfile);
  const [code, setCode] = useState(initialRoom ? normalizeRoomCode(initialRoom) : '');
  const [kind, setKindState] = useState<TransportKind>(transportKind);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const setKind = (k: TransportKind) => { transportKind = k; setKindState(k); };
  const upd = (p: Profile) => { setProfile(p); saveProfile(p); };

  const join = async () => {
    const room = normalizeRoomCode(code);
    if (room.length < 4) { setErr('Enter the room code from the host.'); return; }
    setBusy(true);
    setErr('');
    try {
      const net = await createSession({ kind, host: false, room, profile });
      store.attachNet(net);
      setRoomInUrl(room);
    } catch (e) {
      setErr('Could not join: ' + (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  // Reloaded mid-game (or mid-lobby)? Rejoin the same room, reclaiming our seat.
  useEffect(() => {
    if (initialRoom && rememberedRoom() === normalizeRoomCode(initialRoom)) void join();
  }, []);

  return (
    <>
      <div class="row" style={{ marginBottom: 16 }}>
        <button class="btn ghost" onClick={() => { setRoomInUrl(null); rememberRoom(null); onBack(); }}>← Back</button>
        <h1 style={{ fontSize: 28 }}>Multiplayer</h1>
      </div>
      <div class="panel col" style={{ padding: 16, gap: 16 }}>
        <div class="caps">Your empire</div>
        <ProfileEditor profile={profile} onChange={upd} />
        <TransportPicker kind={kind} setKind={setKind} />
      </div>
      <div class="row wrap" style={{ gap: 16, marginTop: 16, alignItems: 'stretch' }}>
        <div class="panel col" style={{ flex: '1 1 300px', padding: 16, gap: 10 }}>
          <h2>Host a game</h2>
          <div class="small dim">Choose the galaxy on the New Game screen. You own the clock and settings; share the room code with friends.</div>
          <div class="spacer" />
          <button class="btn primary" onClick={() => { saveProfile(profile); onHost(); }}>Set up galaxy…</button>
        </div>
        <div class="panel col" style={{ flex: '1 1 300px', padding: 16, gap: 10 }}>
          <h2>Join a game</h2>
          <label class="col small" style={{ gap: 4 }}>Room code
            <input value={code} placeholder="e.g. K7QM2X" style={{ fontFamily: 'var(--display)', fontSize: 20, letterSpacing: '0.2em', textTransform: 'uppercase' }} onInput={(e) => setCode((e.target as HTMLInputElement).value)} onKeyDown={(e) => { if (e.key === 'Enter') void join(); }} />
          </label>
          {err && <div class="small bad">{err}</div>}
          <button class="btn primary" disabled={busy || !code.trim()} onClick={() => void join()}>{busy ? 'Connecting…' : 'Join'}</button>
        </div>
      </div>
    </>
  );
}

function Room() {
  const st = useStore();
  const net = st.net!;
  const [copied, setCopied] = useState(false);
  const kind: TransportKind = net.transport.kind.startsWith('Supabase') ? 'supabase' : 'local';
  const link = inviteLink(net.room, kind);
  const s = net.settings;
  const allReady = net.lobby.every((p) => p.ready);
  const upd = (p: Profile) => { saveProfile(p); net.setProfile(p); };
  const copy = async () => {
    try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { store.notify(link); }
  };
  const leave = () => { setRoomInUrl(null); rememberRoom(null); store.leaveNet(); };

  return (
    <>
      <div class="row wrap" style={{ marginBottom: 16, gap: 12 }}>
        <button class="btn ghost" onClick={leave}>← Leave</button>
        <h1 style={{ fontSize: 28 }}>Room</h1>
        <span style={{ fontFamily: 'var(--display)', fontSize: 30, letterSpacing: '0.25em', color: 'var(--accent)' }} data-tip="Room code — friends enter this to join">{net.room}</span>
        <button class="btn sm" onClick={() => void copy()}>{copied ? 'Copied!' : 'Copy invite link'}</button>
        <div class="spacer" />
        <span class="chip" data-tip={kind === 'local' ? 'Only tabs of this browser can join' : 'Players anywhere can join with the code'}>{net.transport.kind}</span>
      </div>
      {net.phase === 'connecting' && <div class="panel small" style={{ padding: 12 }}>Connecting…</div>}
      <div class="row wrap" style={{ gap: 16, alignItems: 'stretch' }}>
        <div class="panel col" style={{ flex: '2 1 480px', padding: 0, gap: 0 }}>
          <div class="section"><div class="caps">Players · {net.lobby.length}</div></div>
          {net.lobby.map((p) => {
            const sp = SPECIES_BY_ID[p.species];
            return (
              <div key={p.id} class="section row" style={{ gap: 10 }}>
                <Portrait species={p.species} color={p.color || sp?.color} size={40} />
                <div class="grow" style={{ minWidth: 0 }}>
                  <div class="row" style={{ gap: 6 }}><span class="dot" style={{ background: p.color || sp?.color }} /><b class="ellipsis">{p.name}</b>{p.id === net.self.id && <span class="dim small">(you)</span>}</div>
                  <div class="tiny dim">{sp?.name} — {sp?.traitDesc.split(':')[0]}</div>
                </div>
                {p.host ? <span class="chip">★ Host</span> : p.ready ? <span class="chip good">Ready</span> : <span class="chip warn">Not ready</span>}
              </div>
            );
          })}
          {!net.lobby.length && <div class="section small dim">Waiting for the host…</div>}
          {net.lobby.length > 0 && s && (
            <div class="section small dim">+ {Math.max(0, Math.max(s.empires, net.lobby.length) - net.lobby.length)} AI empire{Math.max(s.empires, net.lobby.length) - net.lobby.length === 1 ? '' : 's'}</div>
          )}
        </div>
        <div class="panel col" style={{ flex: '1 1 300px', padding: 16, gap: 10 }}>
          <div class="caps">Galaxy</div>
          {s ? (
            <div class="small" style={{ lineHeight: 1.7 }}>
              {s.stars} stars · {s.shape}<br />
              {Math.max(s.empires, net.lobby.length)} empires · {DIFFS[s.difficulty]} AI<br />
              Victory: {[s.victory.conquest && 'Conquest', s.victory.domination && `Domination ${s.victory.domination}%`, s.victory.ascension && 'Ascension', s.victory.diplomatic && 'Accord', s.victory.dayLimit && `Day ${s.victory.dayLimit}`].filter(Boolean).join(', ')}<br />
              <span class="dim">Seed {s.seed}</span>
            </div>
          ) : <div class="small dim">The host is choosing…</div>}
          <div class="spacer" />
          {net.isHost ? (
            <>
              <button class="btn primary" style={{ padding: 10, fontSize: 15 }} disabled={!net.canStart()} onClick={() => { if (!net.startGame()) store.notify('Everyone must be ready.', 'error'); }}>
                {allReady ? 'Start game' : 'Waiting for players to be ready…'}
              </button>
              {net.lobby.length < 2 && <div class="tiny dim">You can start alone, but it's more fun with company: share the code.</div>}
            </>
          ) : (
            <button class={'btn ' + (net.ready ? '' : 'primary')} style={{ padding: 10, fontSize: 15 }} onClick={() => net.setProfile({}, !net.ready)}>{net.ready ? 'Not ready' : "I'm ready"}</button>
          )}
        </div>
      </div>
      <div class="row wrap" style={{ gap: 16, marginTop: 16, alignItems: 'stretch' }}>
        <div class="panel col" style={{ flex: '2 1 480px', padding: 16, gap: 10 }}>
          <div class="caps">Your empire {net.ready && !net.isHost && <span class="dim">(un-ready to change)</span>}</div>
          <ProfileEditor profile={net.profile} onChange={upd} disabled={net.ready && !net.isHost} />
          <div class="tiny dim"><Icon.help size={11} /> Two players may pick the same species; clashing colors are adjusted automatically.</div>
        </div>
        <div class="panel col" style={{ flex: '1 1 300px', padding: 0 }}>
          <Chat net={net} height={150} />
        </div>
      </div>
    </>
  );
}

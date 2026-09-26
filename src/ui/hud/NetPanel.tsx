// In-game multiplayer HUD: a top-bar badge that opens the player list
// (connection, ping, sync state) and the room chat.

import { useEffect, useRef, useState } from 'preact/hooks';
import { store, useStore } from '../store';
import { Icon } from '../icons';
import type { ChatLine, NetSession } from '../../net/lockstep';

export function NetBadge() {
  const st = useStore();
  const net = st.net;
  const [open, setOpen] = useState(false);
  const seen = useRef(0);
  const lastToast = useRef(0);
  const last = net?.chat[net.chat.length - 1];
  // Toast chat from others while the panel is closed.
  useEffect(() => {
    if (!net || !last || last.id <= lastToast.current) return;
    lastToast.current = last.id;
    if (!open && !last.system && last.from !== net.self.id) store.notify(`${last.name}: ${last.text}`);
  }, [last?.id]);
  if (!net || net.phase !== 'game') return null;
  if (open && last) seen.current = last.id;
  const unread = net.chat.filter((c) => c.id > seen.current && !c.system && c.from !== net.self.id).length;
  const players = net.roster.length ? net.roster.filter((r) => r.seat !== null) : [];
  const online = players.filter((p) => p.connected).length;
  const desync = players.some((p) => p.sync !== 'ok');
  return (
    <div style={{ position: 'relative' }}>
      <button class={'btn sm ' + (open ? 'active' : '')} onClick={() => setOpen((x) => !x)} data-tip={`Online game · room ${net.room} (${net.transport.kind})\nPlayers, ping and chat`}>
        <span class="dot" style={{ background: desync ? 'var(--warn)' : 'var(--good)' }} />
        <span class="hide-md">{net.room}</span>
        {players.length > 0 && <span class="mono dim">{online}/{players.length}</span>}
        {net.holdReason && <span class="warn tiny">hold</span>}
        {unread > 0 && <span style={{ background: 'var(--bad)', borderRadius: 999, fontSize: 10, padding: '0 5px', fontWeight: 700 }}>{unread}</span>}
      </button>
      {open && <NetPanel net={net} onClose={() => setOpen(false)} />}
    </div>
  );
}

function NetPanel({ net, onClose }: { net: NetSession; onClose: () => void }) {
  const w = store.world;
  return (
    <div class="panel col" style={{ position: 'absolute', top: 40, right: 0, width: 340, maxWidth: 'calc(100vw - 24px)', zIndex: 60, padding: 0, gap: 0 }}>
      <div class="section row" style={{ gap: 8 }}>
        <b>Room {net.room}</b>
        <span class="tiny dim">{net.transport.kind}{net.isHost ? ' · you host' : ''}</span>
        <div class="spacer" />
        <button class="btn icon sm ghost" onClick={onClose}><Icon.close size={13} /></button>
      </div>
      <div class="section" style={{ padding: '8px 12px' }}>
        {net.holdReason && <div class="small warn" style={{ marginBottom: 6 }}>{net.holdReason}</div>}
        {(net.roster.length ? net.roster : []).map((r) => {
          const emp = r.seat !== null && w ? w.s.empires[r.seat] : null;
          return (
            <div key={r.id} class="row small" style={{ padding: '3px 0', gap: 8 }}>
              <span class="dot" style={{ background: r.connected ? r.color : 'transparent', border: `2px solid ${r.color}` }} />
              <span class="grow ellipsis" style={{ opacity: r.connected ? 1 : 0.55 }}>
                {emp?.name ?? r.name}{r.id === net.self.id ? ' (you)' : ''}{r.host ? ' ★' : ''}
                {emp && !emp.alive && <span class="dim"> †</span>}
              </span>
              {!r.connected ? <span class="chip warn" data-tip="Disconnected: the AI runs this empire until they rejoin">AI</span>
                : r.sync !== 'ok' ? <span class="chip bad" data-tip="State mismatch detected — resynchronizing from the host">desync</span>
                : <span class="mono dim" data-tip="Round-trip time to the host">{r.host ? 'host' : r.ping == null ? '…' : `${r.ping} ms`}</span>}
              {!r.host && r.connected && w && w.s.day - r.day > 5 && <span class="tiny warn" data-tip="Days behind the host">−{w.s.day - r.day}d</span>}
            </div>
          );
        })}
        {!net.roster.length && <div class="small dim">Waiting for the player list…</div>}
        {!net.isHost && net.rtt != null && <div class="tiny dim" style={{ marginTop: 4 }}>Your ping to the host: {net.rtt} ms</div>}
      </div>
      <Chat net={net} height={180} />
      <div class="section row" style={{ gap: 6 }}>
        <span class="tiny dim grow">Anyone can pause (Space). Time is shared.</span>
        <button class="btn sm danger" onClick={() => { onClose(); store.leaveNet(); }}>{net.isHost ? 'End session' : 'Leave'}</button>
      </div>
    </div>
  );
}

export function Chat({ net, height = 200 }: { net: NetSession; height?: number }) {
  useStore();
  const [text, setText] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const lines: ChatLine[] = net.chat;
  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, [lines.length]);
  const send = () => {
    net.sendChat(text);
    setText('');
  };
  return (
    <div class="section col" style={{ gap: 6, padding: '8px 12px' }}>
      <div ref={box} class="scroll small" style={{ height, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 3 }}>
        {lines.length === 0 && <div class="dim">No messages yet.</div>}
        {lines.map((l) => l.system
          ? <div key={l.id} class="tiny dim" style={{ fontStyle: 'italic' }}>{l.text}</div>
          : <div key={l.id}><b style={{ color: l.color || 'var(--accent)' }}>{l.name}:</b> {l.text}</div>)}
      </div>
      <div class="row" style={{ gap: 6 }}>
        <input class="grow" value={text} maxLength={400} placeholder="Message everyone…" onInput={(e) => setText((e.target as HTMLInputElement).value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') send(); }} />
        <button class="btn sm" onClick={send} disabled={!text.trim()}>Send</button>
      </div>
    </div>
  );
}

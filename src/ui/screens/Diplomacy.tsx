import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { store, useStore } from '../store';
import { Bar, Empty, Modal, Section, fmt, plural } from '../common';
import { Icon, Portrait, EmpireDot } from '../icons';
import { TECH } from '../../sim/content';
import {
  attitude, declareWar, describe, empirePower, evaluate, metEmpires, propose, respond,
  type Evaluation,
} from '../../sim/diplomacy';
import { abilityCheck, useAbility } from '../../sim/abilities';
import type { AiPersonality, Empire, Proposal, Stance } from '../../sim/types';
import type { World } from '../../sim/world';

// ---------------------------------------------------------------------------
// Diplomacy: every number the AI uses is on screen. Attitude is a list of
// reasons; every proposal is previewed with evaluate() before it is sent.
// ---------------------------------------------------------------------------

const PERSONALITY: Record<AiPersonality, { name: string; desc: string }> = {
  expansionist: { name: 'Expansionist', desc: 'Grabs territory quickly and dislikes neighbours who crowd its borders.' },
  militarist: { name: 'Militarist', desc: 'Respects strength and starts wars readily. −10 attitude to everyone, and slow to accept peace.' },
  scientist: { name: 'Scientist', desc: 'Values knowledge. Technology gifts and fair trades win them over.' },
  diplomat: { name: 'Diplomat', desc: 'Seeks friends. +10 attitude to everyone and +10 toward alliance offers.' },
  industrialist: { name: 'Industrialist', desc: 'Builds quietly and trades pragmatically; focused on its own economy.' },
  opportunist: { name: 'Opportunist', desc: 'Circles the weak. −10 attitude if you look much weaker than them.' },
};

const STANCE_LABEL: Record<Stance, string> = { war: 'War', peace: 'Peace', alliance: 'Alliance' };

const CSS = `
.dp-root { flex: 1; min-height: 0; display: grid; grid-template-columns: 280px minmax(0, 1fr) 360px; position: relative; }
.dp-col { min-height: 0; display: flex; flex-direction: column; border-right: 1px solid var(--line); }
.dp-col:last-child { border-right: 0; }
.dp-emp { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 8px; cursor: pointer; border: 1px solid transparent; transition: background .12s, border-color .12s; }
.dp-emp:hover { background: var(--panel-3); border-color: var(--line); }
.dp-emp.on { background: rgba(127,220,255,.1); border-color: rgba(127,220,255,.45); }
.dp-emp .name { font-family: var(--display); font-weight: 600; font-size: 14px; }
.dp-emp .bar { height: 4px; margin-top: 5px; }
.dp-stance { display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px; border-radius: 999px; font-size: 10.5px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; border: 1px solid; }
.dp-stance.war { color: #ff8a8a; border-color: rgba(255,107,107,.55); background: rgba(255,107,107,.12); }
.dp-stance.peace { color: #9fc4ff; border-color: rgba(120,160,255,.4); background: rgba(120,160,255,.1); }
.dp-stance.alliance { color: #7ef0a0; border-color: rgba(111,224,138,.5); background: rgba(111,224,138,.12); }
.dp-att { font-family: var(--display); font-weight: 700; font-variant-numeric: tabular-nums; min-width: 34px; text-align: right; }
.dp-unknown { display: flex; align-items: center; gap: 10px; padding: 10px; margin: 4px 0; border-radius: 8px; border: 1px dashed var(--line-2); color: var(--text-faint); }
.dp-sil { width: 30px; height: 30px; border-radius: 8px; background: radial-gradient(circle at 50% 38%, #2a3350 0 26%, transparent 27%), radial-gradient(ellipse at 50% 100%, #2a3350 0 48%, transparent 49%), rgba(10,14,28,.9); border: 1px solid var(--line); flex-shrink: 0; }
.dp-inbox { border: 1px solid rgba(255,207,106,.55); background: linear-gradient(180deg, rgba(255,207,106,.1), rgba(255,207,106,.03)); border-radius: 10px; padding: 10px; margin: 10px; animation: dp-glow 2.4s ease-in-out infinite; }
@keyframes dp-glow { 0%,100% { box-shadow: 0 0 0 rgba(255,207,106,0); } 50% { box-shadow: 0 0 18px rgba(255,207,106,.18); } }
.dp-prop { padding: 8px; border-radius: 8px; background: rgba(0,0,0,.25); border: 1px solid var(--line); }
.dp-prop + .dp-prop { margin-top: 8px; }
.dp-badge { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: var(--warn); color: #221800; font-size: 11px; font-weight: 700; }
.dp-hero { display: flex; gap: 16px; padding: 16px; border-bottom: 1px solid var(--line); background: radial-gradient(ellipse at 0% 0%, var(--dp-c, rgba(127,220,255,.15)), transparent 60%); }
.dp-hero h2 { font-size: 24px; }
.dp-hero img { flex-shrink: 0; box-shadow: 0 0 30px var(--dp-glow, transparent); }
.dp-kv { display: grid; grid-template-columns: auto 1fr; gap: 6px 12px; font-size: 13px; line-height: 1.45; }
.dp-kv > .k { color: var(--text-dim); font-size: 11px; text-transform: uppercase; letter-spacing: .08em; font-weight: 600; padding-top: 2px; }
.dp-lore { font-style: italic; color: var(--text-dim); line-height: 1.5; border-left: 2px solid var(--line-2); padding-left: 10px; }
.dp-rel { display: flex; align-items: center; gap: 8px; padding: 5px 0; border-bottom: 1px solid rgba(130,160,255,.06); font-size: 13px; }
.dp-line { display: flex; align-items: center; gap: 8px; padding: 5px 0; font-size: 13px; border-bottom: 1px solid rgba(130,160,255,.06); }
.dp-line .v { font-family: var(--display); font-weight: 600; font-variant-numeric: tabular-nums; min-width: 38px; text-align: right; }
.dp-total { display: flex; align-items: center; gap: 8px; padding: 8px 0 2px; font-family: var(--display); font-weight: 700; font-size: 15px; }
.dp-gauge { position: relative; height: 10px; border-radius: 6px; margin: 10px 0 18px; background: linear-gradient(90deg, rgba(255,107,107,.55), rgba(255,107,107,.15) 45%, rgba(255,255,255,.08) 50%, rgba(111,224,138,.15) 55%, rgba(111,224,138,.55)); }
.dp-gauge .mark { position: absolute; top: -4px; width: 4px; height: 18px; margin-left: -2px; border-radius: 2px; background: #fff; box-shadow: 0 0 8px #fff; transition: left .3s; }
.dp-gauge .tick { position: absolute; top: 12px; font-size: 9.5px; color: var(--text-faint); transform: translateX(-50%); white-space: nowrap; }
.dp-gauge .tick::before { content: ''; position: absolute; left: 50%; top: -14px; height: 12px; border-left: 1px dashed rgba(255,255,255,.35); }
.dp-act { border: 1px solid var(--line); border-radius: 10px; padding: 10px; background: var(--panel-2); }
.dp-act + .dp-act { margin-top: 10px; }
.dp-act h4 { font-size: 13px; display: flex; align-items: center; gap: 6px; }
.dp-verdict { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; padding: 4px 8px; border-radius: 6px; margin: 8px 0 4px; }
.dp-verdict.yes { color: var(--good); background: rgba(111,224,138,.1); }
.dp-verdict.no { color: var(--bad); background: rgba(255,107,107,.1); }
.dp-reasons { margin: 0; padding-left: 16px; font-size: 11.5px; color: var(--text-dim); line-height: 1.5; }
.dp-act select { width: 100%; }
.dp-confirm { position: absolute; inset: 0; z-index: 5; display: flex; align-items: center; justify-content: center; background: rgba(2,3,8,.65); animation: fade .12s ease-out; padding: 16px; }
.dp-confirm .panel { width: min(460px, 100%); padding: 18px; }
@media (max-width: 1180px) {
  .dp-root { grid-template-columns: 250px minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); }
  .dp-root > .dp-center { overflow-y: auto; }
}
@media (max-width: 760px) {
  .dp-root { grid-template-columns: 1fr; overflow-y: auto; }
  .dp-root > .dp-col { border-right: 0; border-bottom: 1px solid var(--line); overflow: visible; }
  .dp-root > .dp-left .dp-list { max-height: 260px; }
  .dp-hero { flex-direction: column; align-items: flex-start; }
}
`;

type Draft = Omit<Proposal, 'id' | 'day'>;

function stanceChip(stance: Stance) {
  return <span class={'dp-stance ' + stance}>{stance === 'war' ? <Icon.sword size={11} /> : stance === 'alliance' ? <Icon.handshake size={11} /> : <Icon.shield size={11} />}{STANCE_LABEL[stance]}</span>;
}

const signed = (n: number) => (n > 0 ? '+' : n < 0 ? '−' : '±') + Math.abs(n);
const attClass = (n: number) => (n > 0 ? 'good' : n < 0 ? 'bad' : 'dim');

function techList(w: World, holder: Empire, lacks: Empire) {
  return [...new Set(holder.research.known)]
    .filter((t) => TECH[t] && !w.knows(lacks.id, t))
    .sort((a, b) => TECH[b].cost - TECH[a].cost || TECH[a].name.localeCompare(TECH[b].name));
}

function Verdict({ ev, note }: { ev: Evaluation; note?: string }) {
  return (
    <>
      <div class={'dp-verdict ' + (ev.accept ? 'yes' : 'no')}>
        {ev.accept ? '✓ Likely to accept' : '✗ Will refuse'}
        <span class="spacer" />
        <span class="tiny dim" data-tip="Internal acceptance score used by the AI.">score {Math.round(ev.score)}</span>
      </div>
      {ev.reasons.length > 0 && <ul class="dp-reasons">{ev.reasons.map((r) => <li>{r}</li>)}</ul>}
      {note && <div class="tiny faint" style={{ marginTop: 4 }}>{note}</div>}
    </>
  );
}

function ActionCard(props: { icon: ComponentChildren; title: string; children: ComponentChildren }) {
  return (
    <div class="dp-act">
      <h4>{props.icon}{props.title}</h4>
      {props.children}
    </div>
  );
}

function useMedia(query: string) {
  const [match, setMatch] = useState(() => typeof matchMedia !== 'undefined' && matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const f = () => setMatch(mq.matches);
    f();
    mq.addEventListener('change', f);
    return () => mq.removeEventListener('change', f);
  }, [query]);
  return match;
}

interface ConfirmState { title: string; body: ComponentChildren; ok: string; danger?: boolean; run: () => void }

export function DiplomacyScreen() {
  useStore();
  const w = store.world;
  const human = w?.human();
  const arg = store.screenArg as { empire?: number } | null;

  const met = useMemo(() => (w && human ? metEmpires(w, human) : []), [w, human, store.version]);
  const [sel, setSel] = useState<number | null>(() => {
    if (arg?.empire !== undefined) return arg.empire;
    if (w && human) {
      const inbox = w.s.proposals.find((p) => p.to === human.id);
      if (inbox) return inbox.from;
    }
    return met[0]?.id ?? null;
  });
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [gift, setGift] = useState('');
  const [give, setGive] = useState('');
  const [get, setGet] = useState('');
  const narrow = useMedia('(max-width: 1180px)');

  useEffect(() => {
    if (arg?.empire !== undefined) setSel(arg.empire);
  }, [arg]);
  // Keep the selection valid (an empire may die while the screen is open).
  useEffect(() => {
    if (sel === null || !met.some((e) => e.id === sel)) setSel(met[0]?.id ?? null);
  }, [met, sel]);
  useEffect(() => { setGift(''); setGive(''); setGet(''); }, [sel]);

  if (!w || !human) {
    return <Modal title="Diplomacy"><Empty>No player empire to conduct diplomacy for.</Empty></Modal>;
  }

  const inbox = w.s.proposals.filter((p) => p.to === human.id);
  const unmet = w.s.empires.filter((e) => e.id !== human.id && e.alive && !human.relations[e.id].met).length;
  const powers = new Map<number, number>();
  for (const e of [human, ...met]) powers.set(e.id, empirePower(w, e.id));
  const maxPower = Math.max(1, ...powers.values());
  const myPower = powers.get(human.id) ?? 1;
  const them = sel !== null ? w.s.empires[sel] : undefined;

  const answer = (p: Proposal, accept: boolean) => {
    const from = w.s.empires[p.from];
    respond(w, p.id, accept);
    store.notify(accept ? `Accepted ${describe(w, p)} with the ${from.name}.` : `Declined ${describe(w, p)}. The ${from.name} are displeased (−5).`);
    store.emit();
  };

  // --- left column ---------------------------------------------------------
  const left = (
    <div class="dp-col dp-left">
      {inbox.length > 0 && (
        <div class="dp-inbox">
          <div class="row" style={{ marginBottom: 8 }}>
            <Icon.handshake size={16} />
            <h3 style={{ fontSize: 13, letterSpacing: '.08em', textTransform: 'uppercase' }}>Incoming</h3>
            <span class="dp-badge">{inbox.length}</span>
          </div>
          <div class="scroll" style={{ maxHeight: 300 }}>
            {inbox.map((p) => <InboxItem w={w} p={p} onAnswer={answer} onView={() => setSel(p.from)} />)}
          </div>
        </div>
      )}
      <div class="row" style={{ padding: '10px 14px 4px' }}>
        <span class="caps">Known empires</span>
        <span class="spacer" />
        <span class="tiny faint">{met.length} met</span>
      </div>
      <div class="scroll dp-list" style={{ flex: 1, padding: '0 8px 8px' }}>
        <div class="dp-emp" style={{ cursor: 'default', opacity: 0.85 }} data-tip="Your empire, for comparison.">
          <Portrait species={human.species} color={human.color} size={36} />
          <div class="grow">
            <div class="row"><span class="name ellipsis">{human.name}</span><span class="tiny faint">(you)</span></div>
            <Bar value={myPower} max={maxPower} color={human.color} />
          </div>
        </div>
        {met.length === 0 && <Empty>You have not met anyone yet. Explore to make first contact.</Empty>}
        {met.map((e) => {
          const att = attitude(w, e.id, human.id).total;
          const rel = human.relations[e.id];
          const pw = powers.get(e.id) ?? 0;
          const pending = inbox.filter((p) => p.from === e.id).length;
          return (
            <div class={'dp-emp' + (e.id === sel ? ' on' : '')} onClick={() => setSel(e.id)}>
              <Portrait species={e.species} color={e.color} size={36} />
              <div class="grow">
                <div class="row" style={{ gap: 6 }}>
                  <span class="name ellipsis">{e.name}</span>
                  {pending > 0 && <span class="dp-badge" data-tip="Proposals waiting for your answer">{pending}</span>}
                </div>
                <div class="row" style={{ gap: 6, marginTop: 2 }}>
                  {stanceChip(rel.stance)}
                  <span class="tiny dim ellipsis">{w.species(e).name}</span>
                </div>
                <div data-tip={`Strength ${fmt(pw)} — ${(pw / Math.max(1, myPower)).toFixed(1)}× yours (fleets, defenses, population, industry).`}>
                  <Bar value={pw} max={maxPower} color={e.color} />
                </div>
              </div>
              <span class={'dp-att ' + attClass(att)} data-tip="Their attitude toward you (−100 … +100)">{signed(att)}</span>
            </div>
          );
        })}
        {unmet > 0 && (
          <div class="dp-unknown" data-tip="Empires you have not yet contacted. Scouts and expansion will find them.">
            <div class="dp-sil" />
            <div class="small">{plural(unmet, 'unknown empire')}<div class="tiny">Not yet contacted</div></div>
          </div>
        )}
      </div>
    </div>
  );

  if (!them) {
    return (
      <Modal title={<span class="row">Diplomacy{inbox.length > 0 && <span class="dp-badge">{inbox.length}</span>}</span>}>
        <style>{CSS}</style>
        <div class="dp-root" style={{ gridTemplateColumns: '280px 1fr' }}>
          {left}
          <div class="center" style={{ flexDirection: 'column', gap: 8, padding: 24 }}>
            <div class="dp-sil" style={{ width: 80, height: 80 }} />
            <div class="dim">Nobody to talk to — yet.</div>
            <div class="small faint">First contact happens when your ships or sensors reach another empire's territory.</div>
          </div>
        </div>
      </Modal>
    );
  }

  const sp = w.species(them);
  const rel = human.relations[them.id];
  const theirRel = them.relations[human.id];
  const att = attitude(w, them.id, human.id);
  const days = w.s.day - rel.since;
  const pers = PERSONALITY[them.ai.personality];
  const others = w.s.empires.filter((o) => o.alive && o.id !== them.id && o.id !== human.id && human.relations[o.id].met);

  // --- actions ---------------------------------------------------------------
  const base = { from: human.id, to: them.id };
  const send = (d: Draft, doneMsg: string) => {
    const r = propose(w, d);
    if (r === 'pending') store.notify('Proposal sent.');
    else if (r.accept) store.notify(`The ${them.name} accept ${describe(w, d)}. ${doneMsg}`);
    else store.notify(`The ${them.name} refuse ${describe(w, d)}: ${r.reasons.filter((x) => !x.startsWith('Attitude')).join('; ') || 'not interested'}.`, 'error');
    store.emit();
  };

  const pesterNote = 'A refusal costs −3 attitude ("Pestering us").';
  const peaceEv = rel.stance === 'war' ? evaluate(w, { ...base, kind: 'peace' }) : null;
  const allyEv = rel.stance === 'peace' ? evaluate(w, { ...base, kind: 'alliance' }) : null;
  const giftOpts = techList(w, human, them);
  const getOpts = techList(w, them, human);
  const giftEv = gift ? evaluate(w, { ...base, kind: 'gift', give: gift }) : null;
  const tradeEv = give && get ? evaluate(w, { ...base, kind: 'trade', give, get }) : null;

  const theirAllies = w.s.empires.filter((x) => x.alive && x.id !== human.id && x.id !== them.id && w.allied(x.id, them.id));
  const askWar = () => setConfirm({
    title: `Declare war on the ${them.name}?`,
    ok: 'Declare war',
    danger: true,
    body: (
      <div class="col" style={{ gap: 10 }}>
        <div class="small">Their fleets and planets become valid targets immediately, and they will remember it (−30 attitude, "Declared war on us").</div>
        {rel.stance === 'alliance' && <div class="small bad">You are allied with them. Breaking the alliance by force is a betrayal: −50 attitude ("Betrayed our alliance").</div>}
        {theirAllies.length > 0 ? (
          <div class="card" style={{ borderColor: 'rgba(255,107,107,.45)' }}>
            <div class="small bad" style={{ marginBottom: 6 }}>Their allies will join the war against you:</div>
            {theirAllies.map((x) => (
              <div class="row small" style={{ padding: '2px 0' }}>
                <EmpireDot color={x.color} />
                {human.relations[x.id].met ? x.name : 'An empire you have not met'}
                {w.allied(human.id, x.id) && <span class="chip warn">your ally too</span>}
              </div>
            ))}
          </div>
        ) : <div class="small good">They have no allies to call on.</div>}
      </div>
    ),
    run: () => {
      declareWar(w, human.id, them.id);
      store.notify(`War declared on the ${them.name}.`, 'error');
      store.emit();
    },
  });
  const askEnd = () => setConfirm({
    title: `End the alliance with the ${them.name}?`,
    ok: 'End alliance',
    body: <div class="small">Relations return to peace. They will resent it: −20 attitude ("Broke our alliance"), fading over time.</div>,
    run: () => send({ ...base, kind: 'endAlliance' }, 'Relations return to peace.'),
  });

  const ability = w.species(human).ability;
  const accordErr = ability.id === 'accord' ? abilityCheck(w, human.id, { empire: them.id }) : null;

  const attitudePanel = (
    <Section title="Their attitude toward you" right={<span class={'dp-att ' + attClass(att.total)} style={{ fontSize: 18 }}>{signed(att.total)}</span>}>
      <div class="dp-gauge" data-tip="Attitude drives every decision they make about you.">
        <span class="tick" style={{ left: '50%' }}>0</span>
        <span class="tick" style={{ left: `${(45 + 100) / 2}%` }}>alliance 45</span>
        <span class="mark" style={{ left: `${(att.total + 100) / 2}%` }} />
      </div>
      {att.lines.length === 0 && <div class="small dim">Completely neutral — no opinions either way.</div>}
      {[...att.lines].sort((a, b) => b.value - a.value).map((l) => (
        <div class="dp-line">
          <span class={l.value > 0 ? 'good' : 'bad'}>{l.value > 0 ? <Icon.up size={13} /> : <Icon.down size={13} />}</span>
          <span class="grow">{l.reason}</span>
          <span class={'v ' + attClass(l.value)}>{signed(l.value)}</span>
        </div>
      ))}
      <div class="dp-total">
        <span class="grow">Total</span>
        <span class={attClass(att.total)}>{signed(att.total)}</span>
      </div>
      {att.lines.reduce((s, l) => s + l.value, 0) !== att.total && <div class="tiny faint">Clamped to the −100 … +100 range.</div>}
      <div class="tiny faint" style={{ marginTop: 6 }}>Temporary modifiers fade every 30 days.</div>
    </Section>
  );

  const actionsPanel = (
    <Section title="Actions">
      {rel.stance === 'war' && peaceEv && (
        <ActionCard icon={<Icon.shield size={14} />} title="Propose peace">
          <Verdict ev={peaceEv} note={pesterNote} />
          <button class={'btn sm ' + (peaceEv.accept ? 'primary' : '')} style={{ marginTop: 8, width: '100%' }} onClick={() => send({ ...base, kind: 'peace' }, 'The guns fall silent.')}>Send peace offer</button>
        </ActionCard>
      )}
      {rel.stance === 'peace' && allyEv && (
        <ActionCard icon={<Icon.handshake size={14} />} title="Propose alliance">
          <Verdict ev={allyEv} note={pesterNote} />
          <button class={'btn sm ' + (allyEv.accept ? 'primary' : '')} style={{ marginTop: 8, width: '100%' }} onClick={() => send({ ...base, kind: 'alliance' }, 'You now share a common cause.')}>Send alliance offer</button>
        </ActionCard>
      )}
      <ActionCard icon={<Icon.flask size={14} />} title="Gift a technology">
        {giftOpts.length === 0 ? <div class="small dim" style={{ marginTop: 6 }}>They already know everything you know.</div> : (
          <>
            <select style={{ marginTop: 8 }} value={gift} onChange={(e) => setGift((e.target as HTMLSelectElement).value)}>
              <option value="">Choose a tech to give…</option>
              {giftOpts.map((t) => <option value={t}>{TECH[t].name} ({fmt(TECH[t].cost)})</option>)}
            </select>
            {giftEv && gift && (
              <>
                <Verdict ev={giftEv} />
                <div class="small good" style={{ marginTop: 4 }}>+{Math.min(25, Math.round(TECH[gift].cost / 25))} attitude ("Generous gifts"), fading 3 per month.</div>
              </>
            )}
            <button class="btn sm" style={{ marginTop: 8, width: '100%' }} disabled={!gift} onClick={() => { send({ ...base, kind: 'gift', give: gift }, 'They are grateful.'); setGift(''); }}>Send gift</button>
          </>
        )}
      </ActionCard>
      <ActionCard icon={<Icon.route size={14} />} title="Trade technologies">
        {giftOpts.length === 0 || getOpts.length === 0 ? (
          <div class="small dim" style={{ marginTop: 6 }}>{getOpts.length === 0 ? 'They know nothing you lack.' : 'You have nothing they lack.'}</div>
        ) : (
          <>
            <div class="tiny caps" style={{ marginTop: 8 }}>You give</div>
            <select value={give} onChange={(e) => setGive((e.target as HTMLSelectElement).value)}>
              <option value="">Choose…</option>
              {giftOpts.map((t) => <option value={t}>{TECH[t].name} ({fmt(TECH[t].cost)})</option>)}
            </select>
            <div class="tiny caps" style={{ marginTop: 6 }}>You receive</div>
            <select value={get} onChange={(e) => setGet((e.target as HTMLSelectElement).value)}>
              <option value="">Choose…</option>
              {getOpts.map((t) => <option value={t}>{TECH[t].name} ({fmt(TECH[t].cost)})</option>)}
            </select>
            {tradeEv && <Verdict ev={tradeEv} note="They accept when the value you give is roughly ≥ 85% of what you take (attitude shifts it)." />}
            <button class={'btn sm ' + (tradeEv?.accept ? 'primary' : '')} style={{ marginTop: 8, width: '100%' }} disabled={!give || !get} onClick={() => { send({ ...base, kind: 'trade', give, get }, 'Knowledge exchanged.'); setGive(''); setGet(''); }}>Offer trade</button>
          </>
        )}
      </ActionCard>
      {ability.id === 'accord' && (
        <ActionCard icon={<Icon.star size={14} />} title={ability.name}>
          <div class="small dim" style={{ marginTop: 4 }}>{ability.desc}</div>
          {accordErr && <div class="tiny warn" style={{ marginTop: 4 }}>{accordErr}</div>}
          <button class="btn sm primary" style={{ marginTop: 8, width: '100%' }} disabled={!!accordErr} onClick={() => {
            const err = useAbility(w, human.id, { empire: them.id });
            if (err) store.notify(err, 'error'); else store.notify(`Grand Accord: the ${them.name} warm to you (+40 for a year).`);
            store.emit();
          }}>Invoke {ability.name}</button>
        </ActionCard>
      )}
      <div class="row wrap" style={{ marginTop: 12, gap: 8 }}>
        {rel.stance === 'alliance' && <button class="btn sm" onClick={askEnd}>End alliance</button>}
        {rel.stance !== 'war' && <button class="btn sm danger" onClick={askWar}><Icon.sword size={13} />Declare war</button>}
      </div>
    </Section>
  );

  const center = (
    <div class="dp-col dp-center scroll">
      <div class="dp-hero" style={{ ['--dp-c' as string]: them.color + '33', ['--dp-glow' as string]: them.color + '55' }}>
        <Portrait species={them.species} color={them.color} size={148} big />
        <div class="col grow" style={{ gap: 6 }}>
          <div class="row wrap" style={{ gap: 10 }}>
            <h2>{them.name}</h2>
            {stanceChip(rel.stance)}
          </div>
          <div class="dim">{sp.plural} · {pers.name}</div>
          <div class="small">
            {STANCE_LABEL[rel.stance]} for <b>{plural(days, 'day')}</b>
            <span class="faint"> (since day {rel.since})</span>
          </div>
          <div class="row small" style={{ gap: 14, marginTop: 4 }}>
            <span data-tip="Planets they control">{Icon.planet({ size: 14 })} {w.planetsOf[them.id].length}</span>
            <span data-tip="Technologies they know">{Icon.res({ size: 14 })} {them.research.known.length}</span>
            <span data-tip="Overall strength relative to yours">{Icon.chart({ size: 14 })} {((powers.get(them.id) ?? 0) / Math.max(1, myPower)).toFixed(1)}× your strength</span>
          </div>
          <div class="row" style={{ gap: 6, marginTop: 6 }}>
            {them.capital != null && (
              <button class="btn sm ghost" onClick={() => {
                const star = w.s.planets[them.capital!].star;
                store.select({ star, planet: null, fleet: null });
                store.focus(star);
                store.open('none');
              }}>{Icon.target({ size: 13 })} Show capital</button>
            )}
          </div>
        </div>
      </div>
      <Section title="Profile">
        <div class="dp-kv">
          <span class="k">Trait</span><span>{sp.traitDesc}</span>
          <span class="k">Ability</span><span><b>{sp.ability.name}</b> — {sp.ability.desc}</span>
          <span class="k">Outlook</span><span><b>{pers.name}.</b> {pers.desc}</span>
        </div>
        <div class="dp-lore" style={{ marginTop: 10 }}>{sp.lore}</div>
      </Section>
      <Section title="Their relations" right={<span class="tiny faint">Empires you have met</span>}>
        {others.length === 0 && <div class="small dim">You know of no other empires they could deal with.</div>}
        {others.map((o) => {
          const r = them.relations[o.id];
          return (
            <div class="dp-rel">
              <EmpireDot color={o.color} />
              <span class="grow ellipsis" style={{ cursor: 'pointer' }} onClick={() => setSel(o.id)}>{o.name}</span>
              {r.met ? <>{stanceChip(r.stance)}<span class={'tiny ' + attClass(attitude(w, them.id, o.id).total)} style={{ minWidth: 30, textAlign: 'right' }} data-tip={`What the ${them.name} think of the ${o.name}`}>{signed(attitude(w, them.id, o.id).total)}</span></> : <span class="tiny faint">no contact</span>}
            </div>
          );
        })}
        {theirRel.lastProposal !== undefined && <div class="tiny faint" style={{ marginTop: 6 }}>Their last proposal to you: day {theirRel.lastProposal}.</div>}
      </Section>
      {narrow && attitudePanel}
      {narrow && actionsPanel}
    </div>
  );

  return (
    <Modal title={<span class="row">Diplomacy{inbox.length > 0 && <span class="dp-badge" data-tip="Proposals awaiting your answer">{inbox.length}</span>}</span>}>
      <style>{CSS}</style>
      <div class="dp-root">
        {left}
        {center}
        {!narrow && (
          <div class="dp-col dp-right scroll">
            {attitudePanel}
            {actionsPanel}
          </div>
        )}
        {confirm && (
          <div class="dp-confirm" onPointerDown={(e) => { if (e.target === e.currentTarget) setConfirm(null); }}>
            <div class="panel">
              <h3 style={{ fontSize: 18, marginBottom: 12 }}>{confirm.title}</h3>
              {confirm.body}
              <div class="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
                <button class="btn" onClick={() => setConfirm(null)}>Cancel</button>
                <button class={'btn ' + (confirm.danger ? 'danger' : 'primary')} onClick={() => { const c = confirm; setConfirm(null); c.run(); }}>{confirm.ok}</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function InboxItem({ w, p, onAnswer, onView }: { w: World; p: Proposal; onAnswer: (p: Proposal, accept: boolean) => void; onView: () => void }) {
  const from = w.s.empires[p.from];
  const left = Math.max(0, 45 - (w.s.day - p.day));
  let detail: ComponentChildren = null;
  switch (p.kind) {
    case 'peace': detail = 'End the war. Both sides keep what they hold.'; break;
    case 'alliance': detail = 'Share a common cause. Attacks on either of you draw in the other.'; break;
    case 'endAlliance': detail = 'They want to return to simple peace.'; break;
    case 'gift': detail = <>You receive <b class="res">{TECH[p.give!]?.name}</b> for free.</>; break;
    case 'trade': detail = <>You get <b class="good">{TECH[p.give!]?.name}</b> ({fmt(TECH[p.give!]?.cost ?? 0)}) and give <b class="bad">{TECH[p.get!]?.name}</b> ({fmt(TECH[p.get!]?.cost ?? 0)}).</>; break;
  }
  return (
    <div class="dp-prop">
      <div class="row" style={{ gap: 8 }}>
        <span style={{ cursor: 'pointer' }} onClick={onView}><Portrait species={from.species} color={from.color} size={30} /></span>
        <div class="grow">
          <div class="small"><b>{from.name}</b> propose {describe(w, p)}</div>
          <div class="tiny faint">Day {p.day} · expires in {plural(left, 'day')}</div>
        </div>
      </div>
      <div class="tiny dim" style={{ margin: '6px 0' }}>{detail}</div>
      <div class="row" style={{ gap: 6 }}>
        <button class="btn sm primary grow" onClick={() => onAnswer(p, true)}>Accept</button>
        <button class="btn sm grow" onClick={() => onAnswer(p, false)} data-tip="Declining costs −5 attitude with them.">Decline</button>
      </div>
    </div>
  );
}

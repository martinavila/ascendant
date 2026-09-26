import { TECH } from './content';
import type { Empire, EmpireId, Proposal, ProposalKind, Stance } from './types';
import type { World } from './world';
import { addMod, grantTech } from './economy';

// Diplomacy is transparent: every attitude is a list of visible reasons, and
// proposals show whether (and why) the other side would accept. The original's
// "wait a few thousand turns for them to warm up" is replaced with concrete levers.

export interface AttitudeLine { reason: string; value: number }

export function empirePower(w: World, e: EmpireId) {
  let p = 0;
  for (const f of Object.values(w.s.fleets)) if (f.owner === e) p += w.fleetStrength(f);
  for (const pid of w.planetsOf[e]) p += w.econ(w.s.planets[pid]).defense * 0.5 + w.s.planets[pid].pop * 1.5;
  p += w.s.empires[e].last.ind * 2;
  return p;
}

export function sharesBorder(w: World, a: EmpireId, b: EmpireId) {
  const mine = new Set(w.planetsOf[a].map((id) => w.s.planets[id].star));
  for (const pid of w.planetsOf[b]) {
    const st = w.s.planets[pid].star;
    if (mine.has(st)) return true;
    for (const { to } of w.adj[st]) if (mine.has(to)) return true;
  }
  return false;
}

/** How empire `a` feels about empire `b`, with reasons. */
export function attitude(w: World, a: EmpireId, b: EmpireId): { total: number; lines: AttitudeLine[] } {
  const ea = w.s.empires[a], eb = w.s.empires[b];
  const lines: AttitudeLine[] = [];
  const add = (reason: string, value: number) => { if (value) lines.push({ reason, value: Math.round(value) }); };
  add(`${w.species(b).plural} are ${w.species(b).trait === 'diplomats' ? 'natural diplomats' : 'telepathic'}`, w.mult(b, 'attitude'));
  if (!ea.human) {
    if (ea.ai.personality === 'militarist') add('Militaristic outlook', -10);
    if (ea.ai.personality === 'diplomat') add('Diplomatic outlook', 10);
    if (eb.human) add('Wary of you (difficulty)', -4 * ea.ai.difficulty);
  }
  const rel = ea.relations[b];
  if (rel.stance === 'war') add('We are at war', -25);
  if (rel.stance === 'alliance') add('Allies', 15);
  if (sharesBorder(w, a, b)) add('Shared border', -8);
  const commonEnemy = w.s.empires.some((c) => c.alive && c.id !== a && c.id !== b && w.atWar(a, c.id) && w.atWar(b, c.id));
  if (commonEnemy) add('Common enemy', 15);
  const ratio = empirePower(w, b) / Math.max(1, empirePower(w, a));
  if (ratio > 2 && ea.ai.personality !== 'militarist') add('They are far stronger than us', 8);
  if (ratio < 0.5 && (ea.ai.personality === 'militarist' || ea.ai.personality === 'opportunist')) add('They look weak', -10);
  if (w.species(a).id === w.species(b).id) add('Same species', 10);
  for (const m of rel.mods) add(m.reason, m.value);
  const total = Math.max(-100, Math.min(100, lines.reduce((s, l) => s + l.value, 0)));
  return { total, lines };
}

export function setStance(w: World, a: EmpireId, b: EmpireId, stance: Stance) {
  const ea = w.s.empires[a], eb = w.s.empires[b];
  const prev = ea.relations[b].stance;
  ea.relations[b].stance = stance;
  eb.relations[a].stance = stance;
  ea.relations[b].since = eb.relations[a].since = w.s.day;
  if (stance === 'war') {
    addMod(eb, a, 'Declared war on us', -30, { decay: 2 });
    for (const x of w.s.empires) {
      if (x.id === a || x.id === b || !x.alive) continue;
      if (w.allied(x.id, b)) {
        addMod(x, a, 'Attacked our ally', -30, { decay: 2 });
        if (!x.human && x.relations[a].stance !== 'war') setStance(w, x.id, a, 'war');
      }
    }
    // Wars cancel alliances with the enemy's allies.
  }
  if (prev === 'war' && stance === 'peace') {
    addMod(ea, b, 'Recent war', -15, { decay: 5 });
    addMod(eb, a, 'Recent war', -15, { decay: 5 });
  }
  const verb = stance === 'war' ? 'declared war on' : stance === 'alliance' ? 'formed an alliance with' : prev === 'alliance' ? 'ended their alliance with' : 'made peace with';
  for (const x of w.s.empires) {
    if (!x.human) continue;
    if (x.id === a || x.id === b || (x.relations[a].met && x.relations[b].met)) {
      const who = x.id === a ? 'We' : ea.name;
      const whom = x.id === b ? 'us' : eb.name;
      w.event(x.id, 'diplomacy', `${who} ${verb} ${whom}.`, { important: x.id === a || x.id === b });
    }
  }
}

export interface Evaluation { accept: boolean; reasons: string[]; score: number }

export function techValue(w: World, e: EmpireId, tech: string) {
  return w.knows(e, tech) ? 0 : TECH[tech].cost;
}

/** Would `p.to` accept this proposal from `p.from`? Used for AI and the player's preview. */
export function evaluate(w: World, p: Omit<Proposal, 'id' | 'day'>): Evaluation {
  const { from, to } = p;
  const eTo = w.s.empires[to];
  const att = attitude(w, to, from).total;
  const reasons: string[] = [`Attitude ${att >= 0 ? '+' : ''}${att}`];
  const rel = eTo.relations[from];
  const days = w.s.day - rel.since;
  switch (p.kind) {
    case 'peace': {
      if (rel.stance !== 'war') return { accept: false, reasons: ['Not at war'], score: 0 };
      const ratio = empirePower(w, from) / Math.max(1, empirePower(w, to));
      let score = att + 25 + Math.min(40, days / 8) + (ratio > 1.3 ? 25 : 0) - (ratio < 0.6 ? 25 : 0);
      if (days < 30) { score -= 40; reasons.push('The war has only just begun'); }
      if (ratio > 1.3) reasons.push('You are stronger than them');
      if (ratio < 0.6) reasons.push('They think they are winning');
      if (days > 150) reasons.push('War weariness');
      if (eTo.ai.personality === 'militarist') { score -= 15; reasons.push('Militaristic'); }
      return { accept: score > 20, reasons, score };
    }
    case 'alliance': {
      if (rel.stance === 'war') return { accept: false, reasons: ['At war — make peace first'], score: 0 };
      if (rel.stance === 'alliance') return { accept: false, reasons: ['Already allied'], score: 0 };
      if (!w.knows(from, 'linguistics') && !w.knows(to, 'linguistics')) return { accept: false, reasons: ['Needs Xenolinguistics (either side)'], score: 0 };
      let score = att;
      if (days < 40) { score -= 20; reasons.push('Relationship is too new'); }
      if (eTo.ai.personality === 'diplomat') { score += 10; reasons.push('Values alliances'); }
      return { accept: score >= 45, reasons: [...reasons, score >= 45 ? 'Trusts you enough' : 'Needs attitude ≥ 45'], score };
    }
    case 'trade': {
      if (!p.give || !p.get) return { accept: false, reasons: ['Pick both techs'], score: 0 };
      const gain = techValue(w, to, p.give), loss = TECH[p.get].cost;
      if (!w.knows(to, p.get)) return { accept: false, reasons: ['They do not know that tech'], score: 0 };
      if (gain === 0) return { accept: false, reasons: ['They already know what you offer'], score: 0 };
      const score = (gain / loss) * 100 + att * 0.5 - (rel.stance === 'war' ? 100 : 0);
      reasons.push(`Value ratio ${(gain / loss).toFixed(2)}`);
      if (rel.stance === 'war') reasons.push('We are at war');
      return { accept: score >= 85, reasons, score };
    }
    case 'gift':
      return { accept: true, reasons: ['Gifts are always welcome'], score: 100 };
    case 'endAlliance':
      return { accept: true, reasons: [], score: 100 };
  }
}

/** Apply an accepted proposal. */
export function enact(w: World, p: Omit<Proposal, 'id' | 'day'>) {
  const { from, to } = p;
  const eFrom = w.s.empires[from], eTo = w.s.empires[to];
  switch (p.kind) {
    case 'peace': setStance(w, from, to, 'peace'); break;
    case 'alliance': setStance(w, from, to, 'alliance'); break;
    case 'endAlliance': setStance(w, from, to, 'peace'); addMod(eTo, from, 'Broke our alliance', -20, { decay: 3 }); break;
    case 'trade':
      if (p.give) grantTech(w, eTo, p.give);
      if (p.get) grantTech(w, eFrom, p.get);
      addMod(eTo, from, 'Fair trade', 5, { decay: 2 });
      break;
    case 'gift':
      if (p.give) {
        grantTech(w, eTo, p.give);
        addMod(eTo, from, 'Generous gifts', Math.min(25, Math.round(TECH[p.give].cost / 25)), { decay: 3 });
      }
      break;
  }
}

/** Player or AI sends a proposal. AI recipients answer immediately; humans get it in their inbox. */
export function propose(w: World, p: Omit<Proposal, 'id' | 'day'>): Evaluation | 'pending' {
  const eTo = w.s.empires[p.to];
  if (eTo.human) {
    if (w.s.proposals.some((x) => x.from === p.from && x.to === p.to && x.kind === p.kind)) return 'pending';
    w.s.proposals.push({ ...p, id: w.nextId(), day: w.s.day });
    w.event(p.to, 'diplomacy', `${w.s.empires[p.from].name} proposes ${describe(w, p)}.`, { important: true });
    return 'pending';
  }
  const ev = evaluate(w, p);
  w.s.empires[p.from].relations[p.to].lastProposal = w.s.day;
  if (ev.accept) enact(w, p);
  else if (p.kind === 'alliance' || p.kind === 'peace') addMod(w.s.empires[p.to], p.from, 'Pestering us', -3, { decay: 3 });
  return ev;
}

export function describe(_w: World, p: Pick<Proposal, 'kind' | 'give' | 'get'>) {
  switch (p.kind) {
    case 'peace': return 'a peace treaty';
    case 'alliance': return 'an alliance';
    case 'endAlliance': return 'ending our alliance';
    case 'gift': return `a gift of ${TECH[p.give!]?.name}`;
    case 'trade': return `trading ${TECH[p.give!]?.name} for ${TECH[p.get!]?.name}`;
  }
}

export function respond(w: World, proposalId: number, accept: boolean) {
  const idx = w.s.proposals.findIndex((x) => x.id === proposalId);
  if (idx < 0) return;
  const p = w.s.proposals[idx];
  w.s.proposals.splice(idx, 1);
  if (accept) enact(w, p);
  else addMod(w.s.empires[p.from], p.to, 'Rejected our proposal', -5, { decay: 3 });
}

export function declareWar(w: World, a: EmpireId, b: EmpireId) {
  if (w.atWar(a, b)) return;
  if (w.allied(a, b)) addMod(w.s.empires[b], a, 'Betrayed our alliance', -50, { decay: 1 });
  setStance(w, a, b, 'war');
}

/** Daily bookkeeping: decay opinion modifiers; expire stale proposals. */
export function diplomacyTick(w: World) {
  const s = w.s;
  if (s.day % 30 === 0) {
    for (const e of s.empires) for (const r of e.relations) {
      r.mods = r.mods.filter((m) => {
        if (m.until !== undefined && m.until < s.day) return false;
        if (m.decay) {
          m.value = m.value > 0 ? Math.max(0, m.value - m.decay) : Math.min(0, m.value + m.decay);
          return m.value !== 0;
        }
        return true;
      });
    }
  }
  s.proposals = s.proposals.filter((p) => s.day - p.day < 45 && s.empires[p.from].alive);
}

export function metEmpires(w: World, e: Empire) {
  return w.s.empires.filter((o) => o.id !== e.id && o.alive && e.relations[o.id].met);
}

export function proposalKinds(): ProposalKind[] {
  return ['peace', 'alliance', 'trade', 'gift', 'endAlliance'];
}

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { store, useStore } from '../store';
import { Bar, Modal, Section, act, fmt } from '../common';
import { Icon } from '../icons';
import { TECH, TECHS, unlocksOf } from '../../sim/content';
import type { TechWithTier } from '../../sim/content/techs';
import { dequeueResearch, researchTowards, setPref, techPath } from '../../sim/commands';
import { availableTechs } from '../../sim/economy';
import type { Empire, TechCategory } from '../../sim/types';
import type { World } from '../../sim/world';

// The Research screen. The original game's tech "spiral" was iconic but
// opaque; this keeps the spiral (concentric tiers, sectors per category that
// twist as they climb) and makes it legible: clear node states, prerequisite
// paths lit on hover, one-click "research towards", and a real queue.
//
// Orientation: the web spirals INWARD. Tier 1 sits on the outer rim and the
// capstone (Transcendence) is the glowing core you climb towards. Tiers 2-5
// are the widest, and placing them on the long outer rings keeps labels
// readable. Flip SPIRAL_INWARD for a tier-1-at-centre layout.

const SPIRAL_INWARD = true;

// Layout constants, in SVG world units (1 unit ≈ 1px at zoom 1).
const NODE_R = 11;
const CAP_R = 17;
const STEP = 46; // radial distance between tier rings
const HUB_R = 70; // first ring when the core holds a single node
const FIRST_R = 64; // first ring otherwise
const MIN_ARC = 84; // minimum arc length per node (label width + air)
const GAP = 0.24; // radians kept free at the top for tier numerals
const TWIST = 0.085; // spiral twist per tier, radians
const CAT_PAD = 0.07; // extra radians per category sector
const LABEL_FS = 10.5;

const ACCENT = '#7fdcff';
const ACCENT2 = '#b48cff';
const MATCH = '#ffe27a';

const CAT_ORDER: TechCategory[] = ['propulsion', 'energy', 'military', 'industry', 'information', 'xeno', 'biology'];

const CAT: Record<string, { label: string; color: string; glyph: string }> = {
  energy: { label: 'Energy', color: '#ffd166', glyph: 'M13 2L4.5 13.5h6.5L10 22l9-12h-6.5z' },
  industry: { label: 'Industry', color: '#ff9f43', glyph: 'M12 8.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7zM12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1' },
  biology: { label: 'Biology', color: '#6fe08a', glyph: 'M5 20c9 0 14-6 14-16C11 4 5 8 5 15v5zM5 20c2-5 5-8 9-10' },
  information: { label: 'Information', color: '#5ab0ff', glyph: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 9.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5z' },
  military: { label: 'Military', color: '#ff6b6b', glyph: 'M12 5a7 7 0 1 0 0 14a7 7 0 1 0 0-14zM12 2v6M12 16v6M2 12h6M16 12h6' },
  propulsion: { label: 'Propulsion', color: '#45e3d0', glyph: 'M12 2.5c4 3 5 8 3 13.5H9C7 10.5 8 5.5 12 2.5zM9 16l-3 4.5h4M15 16l3 4.5h-4M12 8.5v2.5' },
  xeno: { label: 'Xeno', color: '#d08bff', glyph: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6z' },
};
const catOf = (c: string) => CAT[c] ?? { label: c.charAt(0).toUpperCase() + c.slice(1), color: '#a8b4d8', glyph: 'M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16z' };

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
const roman = (n: number) => ROMAN[n] ?? String(n);

const r1 = (n: number) => Math.round(n * 10) / 10;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const wrapPi = (a: number) => { while (a > Math.PI) a -= 2 * Math.PI; while (a <= -Math.PI) a += 2 * Math.PI; return a; };
const polar = (a: number, r: number) => [r * Math.cos(a), r * Math.sin(a)] as const;
const pt = (a: number, r: number) => { const [x, y] = polar(a, r); return `${r1(x)},${r1(y)}`; };

function fmtDays(d: number) {
  if (!isFinite(d)) return '∞';
  if (d < 1) return '<1 day';
  const n = Math.ceil(d);
  if (n > 9999) return '9999+ days';
  return n === 1 ? '1 day' : `${fmt(n)} days`;
}

function splitLabel(name: string): string[] {
  if (name.length <= 14) return [name];
  let best = -1;
  for (let i = 0; i < name.length; i++) if (name[i] === ' ' && (best < 0 || Math.abs(i - name.length / 2) < Math.abs(best - name.length / 2))) best = i;
  return best < 0 ? [name] : [name.slice(0, best), name.slice(best + 1)];
}

// --- layout (pure; computed once) --------------------------------------------

type Box = [number, number, number, number]; // x0, y0, x1, y1
const EST_FS = 12.5; // label size (world units) the placement plans for

function labelBox(n: { x: number; y: number; R: number; lines: string[] }, lp: LabelPos): Box {
  const w = Math.max(...n.lines.map((l) => l.length)) * 0.56 * EST_FS;
  const h = n.lines.length * 1.12 * EST_FS;
  const { x, y, R } = n;
  switch (lp) {
    case 'b': return [x - w / 2, y + R + 2, x + w / 2, y + R + 2 + h];
    case 't': return [x - w / 2, y - R - 3 - h, x + w / 2, y - R - 3];
    case 'r': return [x + R + 5, y - h / 2, x + R + 5 + w, y + h / 2];
    case 'l': return [x - R - 5 - w, y - h / 2, x - R - 5, y + h / 2];
  }
}
const overlap = (a: Box, b: Box) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));

/** Greedy label placement: below the node unless something is in the way. */
function placeLabels(nodes: LNode[]) {
  const discs: Box[] = nodes.map((n) => [n.x - n.R - 2, n.y - n.R - 2, n.x + n.R + 2, n.y + n.R + 2]);
  const placed: Box[] = [];
  const order = [...nodes].sort((a, b) => a.r - b.r || a.a - b.a);
  const bias: Record<LabelPos, number> = { b: 0, t: 40, r: 90, l: 90 };
  for (const n of order) {
    let best: LabelPos = 'b', bestScore = Infinity, bestBox: Box | null = null;
    for (const lp of ['b', 't', 'r', 'l'] as LabelPos[]) {
      const box = labelBox(n, lp);
      let score = bias[lp];
      for (const p of placed) score += overlap(box, p) * 3;
      for (let i = 0; i < nodes.length; i++) if (nodes[i] !== n) score += overlap(box, discs[i]) * 4;
      if (score < bestScore) { bestScore = score; best = lp; bestBox = box; }
    }
    n.lp = best;
    placed.push(bestBox!);
  }
}

type LabelPos = 'b' | 't' | 'r' | 'l';
interface LNode { t: TechWithTier; id: string; x: number; y: number; a: number; r: number; R: number; lines: string[]; lp: LabelPos }
interface LEdge { from: string; to: string; key: string; d: string }
interface Layout {
  nodes: LNode[];
  byId: Record<string, LNode>;
  edges: LEdge[];
  rings: { tier: number; r: number }[];
  wedges: { cat: string; d: string }[];
  boundaries: string[];
  catLabels: { cat: string; x: number; y: number; anchor: string }[];
  tierLabels: { tier: number; x: number; y: number }[];
  core: boolean;
  /** Half-width / half-height of the drawing for a given category-label font size. */
  ext: (catFs: number) => readonly [number, number];
  children: Record<string, string[]>;
  ancestors: Record<string, Set<string>>;
  search: Record<string, string>;
  unlockLines: Record<string, string[]>;
  cats: string[];
}

function buildLayout(): Layout {
  const techs = TECHS as TechWithTier[];
  const tiers = [...new Set(techs.map((t) => Math.max(1, t.tier)))].sort((a, b) => a - b);
  const tierOf = (t: TechWithTier) => Math.max(1, t.tier);
  const cats = [...CAT_ORDER.filter((c) => techs.some((t) => t.category === c)), ...[...new Set(techs.map((t) => t.category))].filter((c) => !CAT_ORDER.includes(c))];

  // Rings, inner → outer.
  const ringTiers = SPIRAL_INWARD ? [...tiers].reverse() : tiers;
  const count = (tier: number, cat?: string) => techs.filter((t) => tierOf(t) === tier && (!cat || t.category === cat)).length;
  const base: Record<number, number> = {};
  let prev = -1;
  const core = count(ringTiers[0]) === 1;
  ringTiers.forEach((tier, i) => {
    let r: number;
    if (i === 0 && core) r = 0;
    else {
      const b = i === 0 ? FIRST_R : prev === 0 ? HUB_R : prev + STEP;
      r = Math.max(b, (count(tier) * MIN_ARC) / ((2 * Math.PI - GAP) * 0.9));
    }
    base[tier] = r;
    prev = r;
  });

  // Push every (non-core) ring outwards until the category sectors fit.
  const avail = 2 * Math.PI - GAP;
  const demandAt = (delta: number) => {
    const d: Record<string, number> = {};
    for (const c of cats) {
      let m = 0;
      for (const tier of tiers) {
        const r = base[tier];
        if (r === 0) continue;
        m = Math.max(m, (count(tier, c) * MIN_ARC) / (r + delta));
      }
      d[c] = m + CAT_PAD;
    }
    return d;
  };
  const sum = (d: Record<string, number>) => Object.values(d).reduce((s, v) => s + v, 0);
  let delta = 0;
  if (sum(demandAt(0)) > avail) {
    let lo = 0, hi = 4000;
    for (let k = 0; k < 40; k++) { const mid = (lo + hi) / 2; if (sum(demandAt(mid)) > avail) lo = mid; else hi = mid; }
    delta = hi;
  }
  const radius: Record<number, number> = {};
  for (const tier of tiers) radius[tier] = base[tier] === 0 ? 0 : base[tier] + delta;
  const demand = demandAt(delta);
  const total = sum(demand);
  const sector: Record<string, { start: number; width: number }> = {};
  let a0 = -Math.PI / 2 + GAP / 2;
  for (const c of cats) { const width = (demand[c] / total) * avail; sector[c] = { start: a0, width }; a0 += width; }
  const twist = (tier: number) => (tier - 1) * TWIST;

  // Twist as a continuous function of radius, for the spiral sector boundaries.
  const ringList = ringTiers.map((tier) => ({ tier, r: radius[tier] }));
  const twistAtR = (r: number) => {
    const pts = ringList.filter((x) => x.r > 0 || ringList.length === 1);
    if (pts.length === 1) return twist(pts[0].tier);
    let i = 0;
    while (i < pts.length - 2 && r > pts[i + 1].r) i++;
    const A = pts[i], B = pts[i + 1];
    const k = (r - A.r) / (B.r - A.r || 1);
    return twist(A.tier) + (twist(B.tier) - twist(A.tier)) * k;
  };

  // Place nodes tier by tier (prerequisites first) so barycentres are known.
  const byId: Record<string, LNode> = {};
  for (const tier of tiers) {
    const r = radius[tier];
    for (const c of cats) {
      const list = techs.filter((t) => tierOf(t) === tier && t.category === c);
      if (!list.length) continue;
      const R = (t: TechWithTier) => (t.capstone ? CAP_R : NODE_R);
      if (r === 0) {
        for (const t of list) byId[t.id] = { t, id: t.id, x: 0, y: 0, a: -Math.PI / 2, r: 0, R: R(t), lines: splitLabel(t.name), lp: 'b' };
        continue;
      }
      const sec = sector[c];
      const s0 = sec.start + twist(tier);
      const mid = s0 + sec.width / 2;
      const bary = (t: TechWithTier) => {
        const ps = t.prereqs.map((p) => byId[p]).filter((p) => p && p.r > 0);
        if (!ps.length) return mid;
        return mid + ps.reduce((s, p) => s + wrapPi(p.a - mid), 0) / ps.length;
      };
      const sorted = list.map((t, i) => ({ t, b: bary(t), i })).sort((x, y) => x.b - y.b || x.i - y.i);
      const n = sorted.length;
      const sp = Math.min(sec.width / n, (MIN_ARC * 1.3) / r);
      const span = sp * (n - 1);
      const want = sorted.reduce((s, x) => s + x.b, 0) / n;
      const lo = s0 + sp / 2 + span / 2, hi = s0 + sec.width - sp / 2 - span / 2;
      const center = lo > hi ? mid : clamp(mid + (want - mid) * 0.6, lo, hi);
      sorted.forEach(({ t }, i) => {
        const a = center - span / 2 + i * sp;
        const [x, y] = polar(a, r);
        byId[t.id] = { t, id: t.id, x, y, a, r, R: R(t), lines: splitLabel(t.name), lp: 'b' };
      });
    }
  }
  const nodes = techs.map((t) => byId[t.id]).filter(Boolean);
  placeLabels(nodes);

  // Prerequisite edges: radial S-curves through the mid-radius.
  const edges: LEdge[] = [];
  for (const n of nodes) {
    for (const p of n.t.prereqs) {
      const A = byId[p];
      if (!A) continue;
      const B = n;
      let c1: string, c2: string;
      if (A.r === B.r) {
        const m = A.r + STEP * 0.55;
        c1 = pt(A.a, m); c2 = pt(B.a, m);
      } else {
        const m = (A.r + B.r) / 2;
        c1 = pt(A.r === 0 ? B.a : A.a, m);
        c2 = pt(B.r === 0 ? A.a : B.a, m);
      }
      edges.push({ from: p, to: n.id, key: p + '>' + n.id, d: `M${r1(A.x)},${r1(A.y)} C${c1} ${c2} ${r1(B.x)},${r1(B.y)}` });
    }
  }

  // Background geometry: spiral sector wedges and boundaries.
  const nonCore = ringList.filter((x) => x.r > 0);
  const rIn = core ? Math.max(24, (nonCore[0]?.r ?? HUB_R) - STEP * 0.6) : Math.max(20, (nonCore[0]?.r ?? FIRST_R) - STEP * 0.6);
  const rOut = (nonCore[nonCore.length - 1]?.r ?? HUB_R) + STEP * 0.62;
  const SAMPLES = 36;
  const boundaryPts = (angle: number) => {
    const out: [number, number][] = [];
    for (let i = 0; i <= SAMPLES; i++) { const r = rIn + ((rOut - rIn) * i) / SAMPLES; out.push([angle + twistAtR(r), r]); }
    return out;
  };
  const toPath = (pts: [number, number][]) => pts.map(([a, r], i) => (i ? 'L' : 'M') + pt(a, r)).join(' ');
  const wedges: Layout['wedges'] = [];
  const boundaries: string[] = [];
  for (const c of cats) {
    const { start, width } = sector[c];
    const A = boundaryPts(start), B = boundaryPts(start + width);
    const large = width > Math.PI ? 1 : 0;
    const outerEnd = B[B.length - 1], innerStart = A[0];
    wedges.push({
      cat: c,
      d: `${toPath(A)} A${r1(rOut)},${r1(rOut)} 0 ${large} 1 ${pt(outerEnd[0], outerEnd[1])} ${[...B].reverse().slice(1).map(([a, r]) => 'L' + pt(a, r)).join(' ')} A${r1(rIn)},${r1(rIn)} 0 ${large} 0 ${pt(innerStart[0], innerStart[1])} Z`,
    });
    boundaries.push(toPath(A));
  }
  boundaries.push(toPath(boundaryPts(-Math.PI / 2 + GAP / 2 + avail)));

  const catLabels = cats.map((c) => {
    const r = rOut + 16;
    const a = sector[c].start + sector[c].width / 2 + twistAtR(r);
    const [x, y] = polar(a, r);
    const cos = Math.cos(a);
    return { cat: c, x, y: y + (Math.sin(a) > 0.3 ? 10 : Math.sin(a) < -0.3 ? -2 : 4), anchor: Math.abs(cos) < 0.3 ? 'middle' : cos > 0 ? 'start' : 'end' };
  });
  const tierLabels = nonCore.map(({ tier, r }) => { const [x, y] = polar(-Math.PI / 2 + twistAtR(r), r); return { tier, x, y }; });
  if (core) tierLabels.push({ tier: ringList[0].tier, x: 0, y: -CAP_R - 20 });

  // Relations, search index, unlock summaries.
  const children: Record<string, string[]> = {};
  for (const t of techs) for (const p of t.prereqs) (children[p] ??= []).push(t.id);
  const ancestors: Record<string, Set<string>> = {};
  const anc = (id: string): Set<string> => {
    if (ancestors[id]) return ancestors[id];
    const s = new Set<string>();
    ancestors[id] = s;
    for (const p of TECH[id]?.prereqs ?? []) { s.add(p); for (const q of anc(p)) s.add(q); }
    return s;
  };
  const search: Record<string, string> = {};
  const unlockLines: Record<string, string[]> = {};
  for (const t of techs) {
    anc(t.id);
    const u = unlocksOf(t.id);
    const lines: string[] = [];
    const add = (label: string, list: { name: string }[]) => { if (list.length) lines.push(`${label}: ${list.map((x) => x.name).join(', ')}`); };
    add('Structures', u.buildings);
    add('Projects', u.projects);
    add('Hulls', u.hulls);
    add('Ship parts', u.parts);
    unlockLines[t.id] = lines;
    search[t.id] = [t.name, t.category, catOf(t.category).label, t.desc, ...u.buildings.map((x) => x.name), ...u.projects.map((x) => x.name), ...u.hulls.map((x) => x.name), ...u.parts.map((x) => x.name)].join(' ').toLowerCase();
  }

  const ext = (fs: number) => {
    const lw = (c: string) => catOf(c).label.length * fs * 0.82 + 6;
    return [
      Math.max(rOut + 24, ...catLabels.map((l) => Math.abs(l.x) + (l.anchor === 'middle' ? lw(l.cat) / 2 : lw(l.cat)))),
      Math.max(rOut + 24, ...catLabels.map((l) => Math.abs(l.y) + fs + 4)),
    ] as const;
  };
  return {
    nodes, byId, edges, rings: ringList, wedges, boundaries, catLabels, tierLabels, core,
    ext, children, ancestors, search, unlockLines, cats,
  };
}

function NodeLabel({ n, cls }: { n: LNode; cls: string }) {
  const k = n.lines.length;
  const { R, lp } = n;
  const x = lp === 'r' ? R + 5 : lp === 'l' ? -R - 5 : 0;
  const anchor = lp === 'r' ? 'start' : lp === 'l' ? 'end' : 'middle';
  const y = lp === 'b' ? R + 2 : lp === 't' ? -R - 3 : 0;
  const first = lp === 'b' ? 0.9 : lp === 't' ? -(k - 1) * 1.1 - 0.25 : 0.35 - (k - 1) * 0.55;
  return (
    <text class={cls} y={y} text-anchor={anchor}>
      {n.lines.map((l, i) => <tspan key={i} x={x} dy={`${i ? 1.1 : first}em`}>{l}</tspan>)}
    </text>
  );
}

// --- screen ------------------------------------------------------------------

export function ResearchScreen() {
  const s = useStore();
  const w = s.world;
  const e = w?.human();
  return (
    <Modal title="Research" width="min(1560px, 100%)" height="min(980px, 100%)" actions={w && e ? <HeaderStats w={w} e={e} /> : null}>
      {w && e ? <ResearchBody w={w} e={e} /> : null}
    </Modal>
  );
}

function HeaderStats({ w, e }: { w: World; e: Empire }) {
  const known = e.research.known.length;
  return (
    <div class="row rs-head">
      <span class="chip" data-tip="Research produced per day across your empire. Build laboratories and use the Research governor focus to raise it.">
        {Icon.res({ size: 13 })}<b class="mono">{fmt(e.last.res, e.last.res < 10 && e.last.res % 1 ? 1 : 0)}</b>/day
      </span>
      <span class="chip" data-tip={`Technologies discovered: ${known} of ${TECHS.length}.\nCosts rise slightly as your empire grows (${w.planetsOf[e.id]?.length ?? 0} planets).`}>
        <b class="mono">{known}</b><span class="dim">/ {TECHS.length} known</span>
      </span>
    </div>
  );
}

interface View { x: number; y: number; z: number }
const ZMIN = 0.6, ZMAX = 6;

function ResearchBody({ w, e }: { w: World; e: Empire }) {
  const L = useMemo(buildLayout, []);
  const r = e.research;
  const rate = Math.max(1, e.last.res);

  const [hover, setHover] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [catFocus, setCatFocus] = useState<string | null>(null);
  const initial = typeof store.screenArg === 'string' && L.byId[store.screenArg] ? (store.screenArg as string) : null;
  const [flash, setFlash] = useState<string | null>(initial);

  // --- pan / zoom ---------------------------------------------------------
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [size, setSize] = useState({ w: 900, h: 700 });
  const [view, setView] = useState<View>({ x: 0, y: 0, z: 1 });
  const [dragging, setDragging] = useState(false);
  const viewRef = useRef(view);
  viewRef.current = view;
  const catFsFor = (scale: number) => clamp(12 / scale, 12, 22);
  const fitFor = (fs: number) => { const [ex, ey] = L.ext(fs); return Math.min(size.w / (2 * ex), size.h / (2 * ey)); };
  const fit = fitFor(catFsFor(fitFor(catFsFor(fitFor(12)))));
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const sc = fit * view.z;
  const anim = useRef(0);
  const drag = useRef<{ sx: number; sy: number; vx: number; vy: number; moved: boolean; pid: number } | null>(null);
  const suppressClick = useRef(false);

  useLayoutEffect(() => {
    const el = wrapRef.current!;
    const measure = () => { const b = el.getBoundingClientRect(); if (b.width > 0 && b.height > 0) setSize({ w: b.width, h: b.height }); };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const animateTo = (target: View) => {
    cancelAnimationFrame(anim.current);
    const from = viewRef.current;
    const t0 = performance.now();
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const step = (t: number) => {
      const k = reduce ? 1 : Math.min(1, (t - t0) / 420);
      const q = 1 - Math.pow(1 - k, 3);
      setView({ x: from.x + (target.x - from.x) * q, y: from.y + (target.y - from.y) * q, z: from.z + (target.z - from.z) * q });
      if (k < 1) anim.current = requestAnimationFrame(step);
    };
    anim.current = requestAnimationFrame(step);
  };
  const zoomBy = (f: number) => { cancelAnimationFrame(anim.current); setView((v) => ({ ...v, z: clamp(v.z * f, ZMIN, ZMAX) })); };
  const fitAll = () => animateTo({ x: 0, y: 0, z: 1 });
  const centerOn = (id: string, zoom = 2) => {
    const n = L.byId[id];
    if (!n) return;
    animateTo({ x: n.x, y: n.y + 10, z: Math.max(viewRef.current.z, zoom) });
    setFlash(id);
  };

  useEffect(() => {
    if (initial) centerOn(initial, 2.2);
    return () => cancelAnimationFrame(anim.current);
  }, []);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 2600);
    return () => clearTimeout(t);
  }, [flash]);

  useEffect(() => {
    const el = svgRef.current!;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      cancelAnimationFrame(anim.current);
      const b = el.getBoundingClientRect();
      const mx = ev.clientX - b.left - b.width / 2, my = ev.clientY - b.top - b.height / 2;
      const k = ev.deltaMode === 1 ? 0.05 : ev.deltaMode === 2 ? 1 : 0.0016;
      setView((v) => {
        const s0 = fitRef.current * v.z;
        const wx = v.x + mx / s0, wy = v.y + my / s0;
        const z = clamp(v.z * Math.exp(-ev.deltaY * k), ZMIN, ZMAX);
        const s1 = fitRef.current * z;
        return { x: wx - mx / s1, y: wy - my / s1, z };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    const k = (ev: KeyboardEvent) => {
      const tag = (ev.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (ev.key === '/') { ev.preventDefault(); searchRef.current?.focus(); }
      else if (ev.key === '+' || ev.key === '=') zoomBy(1.25);
      else if (ev.key === '-' || ev.key === '_') zoomBy(0.8);
      else if (ev.key === '0') fitAll();
      else if (ev.key === 'c' || ev.key === 'C') { const id = e.research.current ?? e.research.queue[0]; if (id) centerOn(id); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  const onPointerDown = (ev: PointerEvent) => {
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    cancelAnimationFrame(anim.current);
    const v = viewRef.current;
    drag.current = { sx: ev.clientX, sy: ev.clientY, vx: v.x, vy: v.y, moved: false, pid: ev.pointerId };
  };
  const onPointerMove = (ev: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = ev.clientX - d.sx, dy = ev.clientY - d.sy;
    if (!d.moved) {
      if (Math.hypot(dx, dy) < 5) return;
      d.moved = true;
      try { svgRef.current?.setPointerCapture(d.pid); } catch { /* pointer gone */ }
      setDragging(true);
      setHover(null);
    }
    const s1 = fitRef.current * viewRef.current.z;
    setView((v) => ({ ...v, x: d.vx - dx / s1, y: d.vy - dy / s1 }));
  };
  const endDrag = () => {
    if (drag.current?.moved) { suppressClick.current = true; setTimeout(() => { suppressClick.current = false; }, 0); }
    drag.current = null;
    setDragging(false);
  };

  // --- derived state --------------------------------------------------------
  const knows = (id: string) => w.knows(e.id, id);
  const avail = availableTechs(w, e.id);
  const availSet = new Set(avail.map((t) => t.id));
  const qPos = new Map(r.queue.map((id, i) => [id, i + 1] as const));
  const cur = r.current && TECH[r.current] ? r.current : null;
  const curCost = cur ? w.techCost(e.id, cur) : 0;
  const version = store.version;

  type State = 'known' | 'current' | 'available' | 'locked';
  const stateOf = (id: string): State => (knows(id) ? 'known' : id === cur ? 'current' : availSet.has(id) ? 'available' : 'locked');

  // ETA for current + queue, carrying banked progress forward like the sim does.
  const etas = useMemo(() => {
    const out = new Map<string, number>();
    let carry = r.progress, days = 0;
    for (const id of [...(cur ? [cur] : []), ...r.queue]) {
      if (!TECH[id] || knows(id)) continue;
      const cost = w.techCost(e.id, id);
      days += Math.max(0, cost - carry) / rate;
      carry = Math.max(0, carry - cost);
      out.set(id, days);
    }
    return out;
  }, [version, rate]);

  const hl = useMemo(() => {
    if (!hover || !TECH[hover]) return null;
    const path = new Set(techPath(w, e.id, hover));
    path.add(hover);
    const edges = new Set<string>();
    const near = new Set(path);
    for (const id of path) for (const p of TECH[id].prereqs) { edges.add(p + '>' + id); near.add(p); }
    const out = new Set<string>();
    for (const c of L.children[hover] ?? []) { out.add(hover + '>' + c); near.add(c); }
    return { path, edges, out, near };
  }, [hover, version]);

  const q = query.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!q) return [] as string[];
    const toks = q.split(/\s+/);
    const hits = L.nodes.filter((n) => toks.every((tk) => L.search[n.id].includes(tk)));
    // Name matches first, then cheapest tier.
    return hits.sort((a, b) => Number(!a.t.name.toLowerCase().includes(toks[0])) - Number(!b.t.name.toLowerCase().includes(toks[0])) || a.t.tier - b.t.tier).map((n) => n.id);
  }, [q]);
  const matchSet = useMemo(() => new Set(matches), [matches]);

  const tips = useMemo(() => {
    const out: Record<string, string> = {};
    for (const n of L.nodes) {
      const t = n.t, id = n.id;
      const st = stateOf(id);
      const cost = w.techCost(e.id, id);
      const lines: string[] = [];
      lines.push(`${t.name}${t.capstone ? '  ★ Capstone' : ''}`);
      lines.push(`${catOf(t.category).label} · Tier ${roman(t.tier)} · ${st === 'known' ? 'Known' : st === 'current' ? `Researching ${Math.floor(clamp(r.progress / cost, 0, 1) * 100)}%` : qPos.has(id) ? `Queued #${qPos.get(id)}` : st === 'available' ? 'Available now' : 'Locked'}`);
      if (st !== 'known') {
        lines.push(`Cost ${fmt(cost)} RP · ~${fmtDays(cost / rate)} at ${fmt(e.last.res)} RP/day`);
        const path = techPath(w, e.id, id);
        if (path.length > 1) {
          const pc = path.reduce((s, p) => s + w.techCost(e.id, p), 0);
          lines.push(`Full path: ${path.length} techs · ${fmt(pc)} RP · ~${fmtDays(pc / rate)}`);
        }
        if (etas.has(id)) lines.push(`Completes in ~${fmtDays(etas.get(id)!)}`);
      }
      lines.push('', t.desc);
      const un = L.unlockLines[id];
      if (un.length) lines.push('', 'Unlocks', ...un.map((x) => '• ' + x));
      if (t.prereqs.length) lines.push('', 'Requires: ' + t.prereqs.map((p) => `${TECH[p]?.name ?? p}${knows(p) ? ' ✓' : ''}`).join(', '));
      const ch = L.children[id];
      if (ch?.length) lines.push('Leads to: ' + ch.map((c) => TECH[c]?.name ?? c).join(', '));
      if (st !== 'known') lines.push('', 'Click: research now (queues prerequisites)', 'Shift/right-click: add to end of queue');
      out[id] = lines.join('\n');
    }
    return out;
  }, [version, rate]);

  // --- commands -------------------------------------------------------------
  const research = (id: string, append: boolean) => {
    const t = TECH[id];
    if (!t) return;
    if (knows(id)) { store.notify(`${t.name} is already known.`); return; }
    if (append && (id === cur || qPos.has(id))) { store.notify(`${t.name} is already ${id === cur ? 'being researched' : 'queued'}.`); return; }
    const path = techPath(w, e.id, id);
    const prev = cur;
    researchTowards(w, e.id, id, append);
    // Switching drops the old current tech from the plan; keep it, right after the new path.
    if (!append && prev && prev !== r.current && !knows(prev) && !r.queue.includes(prev)) {
      r.queue = [...r.queue.slice(0, path.length - 1), prev, ...r.queue.slice(path.length - 1)];
    }
    normalizeQueue();
    const extra = path.length - 1;
    act(null, append
      ? `Queued ${t.name}${extra ? ` (+${extra} prerequisite${extra > 1 ? 's' : ''})` : ''}.`
      : extra ? `Researching ${TECH[path[0]].name}: ${path.length} steps to ${t.name}.` : `Researching ${t.name}.`);
  };
  /** The sim silently drops a queued tech whose prerequisites aren't known yet when
   *  it comes up, so keep every queued tech after its queued prerequisites. */
  const normalizeQueue = () => {
    const qq = r.queue, inQ = new Set(qq), seen = new Set<string>(), out: string[] = [];
    const visit = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      for (const p of TECH[id]?.prereqs ?? []) if (inQ.has(p)) visit(p);
      out.push(id);
    };
    qq.forEach(visit);
    if (out.some((id, i) => id !== qq[i])) r.queue = out;
    w.touch();
  };
  const canSwap = (i: number, j: number) => {
    const a = r.queue[i], b = r.queue[j];
    if (a == null || b == null) return false;
    // After swapping, b comes before a (if j < i) — a must not require b and vice versa.
    const [first, second] = i < j ? [a, b] : [b, a];
    return !L.ancestors[second]?.has(first);
  };
  const moveQueued = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= r.queue.length) return;
    if (!canSwap(i, j)) {
      const [first, second] = i < j ? [r.queue[i], r.queue[j]] : [r.queue[j], r.queue[i]];
      store.notify(`${TECH[second]?.name} requires ${TECH[first]?.name}.`, 'error');
      return;
    }
    const qq = [...r.queue];
    [qq[i], qq[j]] = [qq[j], qq[i]];
    r.queue = qq;
    w.touch();
    store.emit();
  };
  const dependentsQueued = (id: string) => r.queue.filter((x) => L.ancestors[x]?.has(id));
  const removeQueued = (id: string) => {
    const deps = dependentsQueued(id);
    dequeueResearch(w, e.id, id);
    for (const d of deps) dequeueResearch(w, e.id, d);
    act(null, deps.length ? `Removed ${TECH[id]?.name} and ${deps.length} dependent tech${deps.length > 1 ? 's' : ''}.` : undefined);
  };
  const clearQueue = () => { for (const id of [...r.queue]) dequeueResearch(w, e.id, id); act(null, 'Research queue cleared.'); };

  // --- render: web ------------------------------------------------------------
  const vb = `${r1(view.x - size.w / 2 / sc)} ${r1(view.y - size.h / 2 / sc)} ${r1(size.w / sc)} ${r1(size.h / sc)}`;
  const labelFs = clamp(9.5 / sc, LABEL_FS, 15);
  const showAllLabels = sc * labelFs >= 7.5;
  const dimNode = (n: LNode) => (hl ? !hl.near.has(n.id) : false) || (q ? !matchSet.has(n.id) : false) || (catFocus ? n.t.category !== catFocus : false);

  const edgeEls = [] as preact.JSX.Element[];
  const hotEdges = [] as preact.JSX.Element[];
  for (const ed of L.edges) {
    const toCat = catOf(L.byId[ed.to].t.category).color;
    if (hl?.edges.has(ed.key)) { hotEdges.push(<path key={ed.key} d={ed.d} class="rs-edge hot" stroke={ACCENT} />); continue; }
    if (hl?.out.has(ed.key)) { hotEdges.push(<path key={ed.key} d={ed.d} class="rs-edge out" stroke={ACCENT2} />); continue; }
    const fk = knows(ed.from), tk = knows(ed.to);
    const cls = tk ? 'known' : fk ? 'ready' : 'locked';
    const dim = !!hl || !!q || (catFocus ? L.byId[ed.to].t.category !== catFocus && L.byId[ed.from].t.category !== catFocus : false);
    edgeEls.push(<path key={ed.key} d={ed.d} class={`rs-edge ${cls}${dim ? ' dim' : ''}`} stroke={cls === 'locked' ? '#34406a' : toCat} />);
  }

  const nodeEl = (n: LNode) => {
    const id = n.id, t = n.t;
    const color = catOf(t.category).color;
    const st = stateOf(id);
    const qn = qPos.get(id);
    const isMatch = matchSet.has(id);
    const emph = hover === id || flash === id || isMatch || st === 'current' || (hl?.path.has(id) ?? false);
    const dim = dimNode(n) && !emph;
    const R = n.R;
    const fill = st === 'known' ? color : st === 'current' ? color + '40' : '#0a1024';
    const stroke = st === 'locked' ? (qn ? color + 'aa' : '#3a466c') : color;
    const glyphStroke = st === 'known' ? '#07101c' : st === 'locked' ? (qn ? color + 'cc' : '#5a6890') : color;
    const pct = st === 'current' ? clamp(r.progress / Math.max(1, curCost), 0, 1) : 0;
    const circ = 2 * Math.PI * (R + 3.5);
    const gs = (R * 1.25) / 24;
    return (
      <g
        key={id}
        class={`rs-node ${st}${dim ? ' dim' : ''}${hover === id ? ' hov' : ''}`}
        transform={`translate(${r1(n.x)},${r1(n.y)})`}
        data-tip={tips[id]}
        tabIndex={0}
        role="button"
        aria-label={`${t.name}, ${st === 'current' ? 'researching' : qn ? `queued ${qn}` : st}`}
        onMouseEnter={() => { if (!drag.current?.moved) setHover(id); }}
        onMouseLeave={() => setHover((h) => (h === id ? null : h))}
        onFocus={() => setHover(id)}
        onBlur={() => setHover((h) => (h === id ? null : h))}
        onClick={(ev) => { if (suppressClick.current) return; research(id, ev.shiftKey); }}
        onContextMenu={(ev) => { ev.preventDefault(); research(id, true); }}
        onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); research(id, ev.shiftKey); } }}
      >
        {t.capstone && <circle r={R + 12} class="rs-capglow" fill="url(#rs-core)" />}
        {(isMatch || flash === id) && <circle r={R + 7} fill="none" stroke={MATCH} stroke-width="2" class={flash === id ? 'rs-flash' : ''} />}
        {st === 'current' && <circle r={R + 4} fill="none" stroke={color} stroke-width="2" class="rs-pulse" />}
        {st === 'available' && <circle r={R + 4} fill="none" stroke={color} stroke-opacity=".28" stroke-width="3" />}
        <circle r={R + 10} fill="transparent" />
        <circle r={R} class="rs-disc" fill={fill} stroke={stroke} stroke-width={st === 'available' || st === 'current' ? 2.4 : 1.5} stroke-dasharray={st === 'locked' && qn ? '3 2.5' : undefined} filter={st === 'current' ? 'url(#rs-glow)' : undefined} />
        {st === 'current' && (
          <circle r={R + 3.5} fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-dasharray={`${r1(circ * pct)} ${r1(circ)}`} transform="rotate(-90)" />
        )}
        <g transform={`scale(${r1(gs * 100) / 100}) translate(-12,-12)`}>
          <path d={catOf(t.category).glyph} fill="none" stroke={glyphStroke} stroke-width={2.2} stroke-linecap="round" stroke-linejoin="round" />
        </g>
        {qn != null && (
          <g transform={`translate(${r1(R * 0.78)},${r1(-R * 0.78)})`} class="rs-badge">
            <circle r="7" fill={ACCENT} stroke="#04101a" stroke-width="1.5" />
            <text y="3" text-anchor="middle">{qn}</text>
          </g>
        )}
        {(showAllLabels || emph || st === 'available') && <NodeLabel n={n} cls={`rs-label ${st}`} />}
      </g>
    );
  };

  // Hovered / flashed labels are repeated in an overlay so they sit on top
  // (re-ordering the node elements themselves would break hover tracking).
  const onTop = [...new Set([hover, flash].filter((x): x is string => !!x && !!L.byId[x]))];

  // --- render: side panel ------------------------------------------------------
  const sortedAvail = [...avail].sort((a, b) => w.techCost(e.id, a.id) - w.techCost(e.id, b.id));
  const Dot = ({ id }: { id: string }) => <span class="dot" style={{ background: catOf(TECH[id].category).color, width: 8, height: 8 }} />;
  const rowHover = (id: string) => ({ onMouseEnter: () => setHover(id), onMouseLeave: () => setHover((h: string | null) => (h === id ? null : h)) });
  const catCounts = (c: string) => { const all = L.nodes.filter((n) => n.t.category === c); return [all.filter((n) => knows(n.id)).length, all.length]; };

  return (
    <div class="rs-root">
      <style>{CSS}</style>
      <div class="rs-map" ref={wrapRef}>
        <svg
          ref={svgRef}
          class={dragging ? 'drag' : ''}
          viewBox={vb}
          role="application"
          aria-label="Technology web. Drag to pan, scroll to zoom, Tab through technologies."
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDblClick={(ev) => { if ((ev.target as Element).closest('.rs-node')) return; fitAll(); }}
        >
          <defs>
            <filter id="rs-glow" x="-80%" y="-80%" width="260%" height="260%">
              <feGaussianBlur stdDeviation="4" result="b" />
              <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
            <radialGradient id="rs-core">
              <stop offset="0" stop-color="#ffe9a8" stop-opacity=".55" />
              <stop offset=".45" stop-color="#d08bff" stop-opacity=".22" />
              <stop offset="1" stop-color="#d08bff" stop-opacity="0" />
            </radialGradient>
            <radialGradient id="rs-bg">
              <stop offset="0" stop-color="#2a3a8a" stop-opacity=".35" />
              <stop offset=".6" stop-color="#141c44" stop-opacity=".18" />
              <stop offset="1" stop-color="#000" stop-opacity="0" />
            </radialGradient>
          </defs>

          <g class="rs-bgl">
            <circle r={r1(L.ext(12)[1] + 40)} fill="url(#rs-bg)" />
            {L.wedges.map((wd) => (
              <path key={wd.cat} d={wd.d} fill={catOf(wd.cat).color} fill-opacity={catFocus === wd.cat ? 0.11 : 0.045} />
            ))}
            {L.rings.filter((x) => x.r > 0).map((x) => (
              <circle key={x.tier} r={r1(x.r)} fill="none" stroke="#8aa0ff" stroke-opacity=".11" stroke-dasharray="2 5" />
            ))}
            {L.boundaries.map((d, i) => <path key={i} d={d} fill="none" stroke="#8aa0ff" stroke-opacity=".16" stroke-width="1" />)}
            {L.tierLabels.map((tl) => (
              <text key={tl.tier} x={r1(tl.x)} y={r1(tl.y) + 3.5} class="rs-tier" text-anchor="middle">{roman(tl.tier)}</text>
            ))}
            {L.catLabels.map((cl) => (
              <text
                key={cl.cat}
                x={r1(cl.x)}
                y={r1(cl.y)}
                text-anchor={cl.anchor}
                class={`rs-cat${catFocus === cl.cat ? ' on' : ''}`}
                fill={catOf(cl.cat).color}
                style={{ fontSize: `${r1(catFsFor(sc))}px` }}
                onClick={() => setCatFocus((c) => (c === cl.cat ? null : cl.cat))}
              >
                {catOf(cl.cat).label.toUpperCase()}
              </text>
            ))}
          </g>
          <g>{edgeEls}</g>
          <g>{hotEdges}</g>
          <g style={{ fontSize: `${r1(labelFs)}px` }}>
            {L.nodes.map(nodeEl)}
            <g class="rs-top" aria-hidden="true">
              {onTop.map((id) => { const n = L.byId[id]; return <g key={id} transform={`translate(${r1(n.x)},${r1(n.y)})`}><NodeLabel n={n} cls="rs-label hov" /></g>; })}
            </g>
          </g>
        </svg>

        <div class="rs-ctrls panel">
          <button class="btn icon sm ghost" onClick={() => zoomBy(1.3)} data-tip="Zoom in (+)" aria-label="Zoom in">{Icon.plus({ size: 15 })}</button>
          <button class="btn icon sm ghost" onClick={() => zoomBy(1 / 1.3)} data-tip="Zoom out (−)" aria-label="Zoom out">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M5 12h14" /></svg>
          </button>
          <button class="btn icon sm ghost" onClick={fitAll} data-tip="Show the whole web (0)" aria-label="Fit">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>
          </button>
          <button class="btn icon sm ghost" disabled={!cur && !r.queue.length} onClick={() => { const id = cur ?? r.queue[0]; if (id) centerOn(id); }} data-tip="Centre on current research (C)" aria-label="Centre on current research">{Icon.target({ size: 15 })}</button>
        </div>
        <div class="rs-hint">
          <span><b>Click</b> research now</span>
          <span><b>Shift/right-click</b> queue</span>
          <span><b>Drag</b> pan</span>
          <span><b>Wheel</b> zoom</span>
        </div>
      </div>

      <aside class="rs-side scroll">
        <div class="section rs-search">
          <div class="rs-searchbox">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
            <input
              ref={searchRef}
              type="search"
              placeholder="Search techs, structures, parts…"
              value={query}
              aria-label="Search technologies"
              onInput={(ev) => setQuery((ev.currentTarget as HTMLInputElement).value)}
              onKeyDown={(ev) => {
                if (ev.key === 'Escape' && query) { ev.stopPropagation(); setQuery(''); }
                else if (ev.key === 'Enter' && matches[0]) { if (ev.shiftKey) research(matches[0], true); else centerOn(matches[0]); }
              }}
            />
            <span class="kbd">/</span>
          </div>
          {q && (
            <div class="col rs-results">
              <div class="tiny dim">{matches.length ? `${matches.length} match${matches.length > 1 ? 'es' : ''} · Enter to locate` : 'No technologies match.'}</div>
              {matches.slice(0, 6).map((id) => {
                const st = stateOf(id);
                return (
                  <div key={id} class={`rs-item click${hover === id ? ' hov' : ''}`} {...rowHover(id)} onClick={() => centerOn(id)}>
                    <Dot id={id} />
                    <div class="grow">
                      <div class="ellipsis">{TECH[id].name}</div>
                      <div class="tiny dim">Tier {roman(TECH[id].tier)} · {st === 'known' ? 'Known' : st === 'current' ? 'Researching' : qPos.has(id) ? `Queued #${qPos.get(id)}` : st === 'available' ? 'Available' : `${techPath(w, e.id, id).length} steps`}</div>
                    </div>
                    {st !== 'known' && st !== 'current' && (
                      <button class="btn sm" onClick={(ev) => { ev.stopPropagation(); research(id, false); }} data-tip="Research now (queues prerequisites)">Research</button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <Section title="Current research">
          {cur ? (
            <div class={`rs-current${hover === cur ? ' hov' : ''}`} {...rowHover(cur)} style={{ '--c': catOf(TECH[cur].category).color }}>
              <div class="row">
                <Dot id={cur} />
                <button class="rs-link grow ellipsis" onClick={() => centerOn(cur)} data-tip={tips[cur]}>{TECH[cur].name}</button>
                <span class="chip">Tier {roman(TECH[cur].tier)}</span>
              </div>
              <Bar value={r.progress} max={curCost} color={catOf(TECH[cur].category).color} style={{ height: 8, margin: '9px 0 6px' }} />
              <div class="row small">
                <span class="mono">{fmt(Math.min(r.progress, curCost))} / {fmt(curCost)} RP</span>
                <span class="spacer" />
                <span class="mono" data-tip={`At ${fmt(e.last.res)} research per day`}>{Math.floor(clamp(r.progress / curCost, 0, 1) * 100)}% · {fmtDays(Math.max(0, curCost - r.progress) / rate)}</span>
              </div>
            </div>
          ) : (
            <div class="rs-idle">
              <b>No active research.</b>
              <div class="small dim">
                {r.queue.length ? 'The next queued tech starts tomorrow.' : e.prefs.autoResearch ? 'Auto-research will pick a tech tomorrow.' : 'Pick a technology on the web or from the list below.'}
                {r.progress > 0 && ` ${fmt(r.progress)} RP banked.`}
              </div>
            </div>
          )}
          {e.last.res <= 0 && <div class="small warn" style={{ marginTop: 8 }}>Your empire produces no research. Build laboratories or set planets to the Research focus.</div>}
        </Section>

        <Section
          title={`Queue${r.queue.length ? ` · ${r.queue.length}` : ''}`}
          right={r.queue.length ? <button class="btn sm ghost" onClick={clearQueue} data-tip="Remove everything from the queue (current research continues)">Clear</button> : undefined}
        >
          {r.queue.length ? (
            <div class="col" style={{ gap: 5 }}>
              {r.queue.map((id, i) => {
                const deps = dependentsQueued(id);
                return (
                  <div key={id} class={`rs-item${hover === id ? ' hov' : ''}`} {...rowHover(id)}>
                    <span class="rs-qn">{i + 1}</span>
                    <Dot id={id} />
                    <div class="grow">
                      <button class="rs-link ellipsis" onClick={() => centerOn(id)} data-tip={tips[id]}>{TECH[id]?.name ?? id}</button>
                      <div class="tiny dim mono">{fmt(w.techCost(e.id, id))} RP · done in {fmtDays(etas.get(id) ?? Infinity)}</div>
                    </div>
                    <div class="rs-qbtns">
                      <button class="btn icon sm ghost" disabled={i === 0 || !canSwap(i, i - 1)} onClick={() => moveQueued(i, -1)} aria-label="Move up" data-tip={i > 0 && !canSwap(i, i - 1) ? `Needs ${TECH[r.queue[i - 1]]?.name} first` : 'Move up'}>{Icon.up({ size: 13 })}</button>
                      <button class="btn icon sm ghost" disabled={i === r.queue.length - 1 || !canSwap(i, i + 1)} onClick={() => moveQueued(i, 1)} aria-label="Move down" data-tip={i < r.queue.length - 1 && !canSwap(i, i + 1) ? `${TECH[r.queue[i + 1]]?.name} needs this first` : 'Move down'}>{Icon.down({ size: 13 })}</button>
                      <button class="btn icon sm ghost" onClick={() => removeQueued(id)} aria-label="Remove" data-tip={deps.length ? `Remove (also removes ${deps.map((d) => TECH[d]?.name).join(', ')})` : 'Remove from queue'}>{Icon.close({ size: 13 })}</button>
                    </div>
                  </div>
                );
              })}
              <div class="tiny dim" style={{ marginTop: 2 }}>All queued research done in <b class="mono">{fmtDays(Math.max(0, ...etas.values()))}</b></div>
            </div>
          ) : (
            <div class="small dim">Empty. Click a distant tech to queue its whole prerequisite path, or shift-click to append.</div>
          )}
          <label class="rs-switch" data-tip="When nothing is queued, your science council picks the next technology automatically.">
            <input type="checkbox" checked={e.prefs.autoResearch} onChange={(ev) => act(setPref(w, e.id, 'autoResearch', (ev.currentTarget as HTMLInputElement).checked))} />
            <i />
            <span>Auto-research when idle</span>
          </label>
        </Section>

        <Section title={`Available now · ${sortedAvail.length}`}>
          {sortedAvail.length ? (
            <div class="col" style={{ gap: 5 }}>
              {sortedAvail.map((t) => {
                const id = t.id;
                const cost = w.techCost(e.id, id);
                const isCur = id === cur, qn = qPos.get(id);
                return (
                  <div
                    key={id}
                    class={`rs-item click${hover === id ? ' hov' : ''}${isCur ? ' cur' : ''}`}
                    {...rowHover(id)}
                    role="button"
                    tabIndex={0}
                    data-tip={tips[id]}
                    onClick={(ev) => research(id, ev.shiftKey)}
                    onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); research(id, ev.shiftKey); } }}
                  >
                    <Dot id={id} />
                    <div class="grow">
                      <div class="ellipsis">{t.name}</div>
                      <div class="tiny dim mono">{fmt(cost)} RP · {fmtDays(cost / rate)}</div>
                    </div>
                    {isCur ? <span class="chip good">Active</span> : qn ? <span class="chip">#{qn}</span> : (
                      <button class="btn icon sm ghost" onClick={(ev) => { ev.stopPropagation(); research(id, true); }} aria-label={`Queue ${t.name}`} data-tip="Add to end of queue">{Icon.plus({ size: 13 })}</button>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div class="small dim">{e.research.known.length >= TECHS.length ? 'Every technology is known.' : 'Nothing available.'}</div>
          )}
        </Section>

        <Section title="Legend" right={catFocus ? <button class="btn sm ghost" onClick={() => setCatFocus(null)}>Show all</button> : undefined}>
          <div class="rs-legend">
            {L.cats.map((c) => {
              const [k, n] = catCounts(c);
              return (
                <button key={c} class={`rs-cat-btn${catFocus === c ? ' on' : ''}`} aria-pressed={catFocus === c} onClick={() => setCatFocus((x) => (x === c ? null : c))} data-tip={`Highlight ${catOf(c).label} technologies`}>
                  <span class="dot" style={{ background: catOf(c).color }} />
                  <span class="grow ellipsis">{catOf(c).label}</span>
                  <span class="tiny dim mono">{k}/{n}</span>
                </button>
              );
            })}
          </div>
          <div class="rs-states">
            {([
              ['known', 'Known'], ['current', 'Researching'], ['available', 'Available'], ['queued', 'Queued'], ['locked', 'Locked'],
            ] as const).map(([k, label]) => (
              <span key={k} class="row tiny" style={{ gap: 5 }}>
                <svg width="18" height="18" viewBox="-9 -9 18 18">
                  {k === 'known' && <circle r="6" fill={ACCENT} stroke={ACCENT} stroke-width="1.5" />}
                  {k === 'current' && <><circle r="8" fill="none" stroke={ACCENT} stroke-opacity=".5" stroke-width="1.5" /><circle r="5.5" fill={ACCENT + '40'} stroke={ACCENT} stroke-width="2" /></>}
                  {k === 'available' && <circle r="6" fill="#0a1024" stroke={ACCENT} stroke-width="2" />}
                  {k === 'queued' && <><circle r="6" fill="#0a1024" stroke={ACCENT} stroke-width="1.5" stroke-dasharray="2.5 2" /><circle cx="4.5" cy="-4.5" r="3.5" fill={ACCENT} /></>}
                  {k === 'locked' && <circle r="6" fill="#0a1024" stroke="#3a466c" stroke-width="1.5" />}
                </svg>
                {label}
              </span>
            ))}
          </div>
        </Section>
      </aside>
    </div>
  );
}

const CSS = `
.rs-head .chip { font-size: 12px; padding: 3px 10px; gap: 6px; }
.rs-root { flex: 1; min-width: 0; min-height: 0; display: flex; }
.rs-map { position: relative; flex: 1; min-width: 0; min-height: 0; overflow: hidden;
  background: radial-gradient(ellipse at 50% 50%, rgba(46, 60, 140, 0.18), transparent 70%), rgba(2, 4, 12, 0.35); }
.rs-map > svg { position: absolute; inset: 0; width: 100%; height: 100%; display: block; touch-action: none; user-select: none; -webkit-user-select: none; cursor: grab; }
.rs-map > svg.drag { cursor: grabbing; }
.rs-map > svg.drag .rs-node { cursor: grabbing; }
.rs-edge { fill: none; transition: opacity 0.15s; }
.rs-edge.known { stroke-opacity: 0.4; stroke-width: 1.4; }
.rs-edge.ready { stroke-opacity: 0.8; stroke-width: 1.6; }
.rs-edge.locked { stroke-opacity: 0.55; stroke-width: 1.1; }
.rs-edge.dim { opacity: 0.25; }
.rs-edge.hot { stroke-width: 2.6; stroke-dasharray: 7 5; animation: rs-flow 0.7s linear infinite; filter: drop-shadow(0 0 3px rgba(127, 220, 255, 0.7)); }
.rs-edge.out { stroke-width: 1.6; stroke-dasharray: 3 4; stroke-opacity: 0.85; }
@keyframes rs-flow { to { stroke-dashoffset: -12; } }
.rs-node { cursor: pointer; outline: none; transition: opacity 0.15s; }
.rs-node.dim { opacity: 0.28; }
.rs-node.locked .rs-disc { opacity: 0.9; }
.rs-node:hover .rs-disc, .rs-node.hov .rs-disc { stroke: #fff; }
.rs-node:focus-visible .rs-disc { stroke: #fff; stroke-width: 3; }
.rs-label { font-family: var(--font); font-weight: 500; fill: var(--text); paint-order: stroke; stroke: rgba(3, 5, 12, 0.92); stroke-width: 3.2px; stroke-linejoin: round; pointer-events: none; }
.rs-label.locked { fill: var(--text-dim); }
.rs-label.known { fill: #c8d2f0; }
.rs-label.current { fill: #fff; font-weight: 700; }
.rs-node.hov .rs-label, .rs-label.hov { fill: #fff; }
.rs-top { pointer-events: none; }
.rs-badge text { font: 700 9px var(--font); fill: #04101a; pointer-events: none; }
.rs-pulse { transform-box: fill-box; transform-origin: center; animation: rs-pulse 1.8s ease-out infinite; }
@keyframes rs-pulse { 0% { transform: scale(1); opacity: 0.95; } 100% { transform: scale(1.9); opacity: 0; } }
.rs-flash { transform-box: fill-box; transform-origin: center; animation: rs-flash 0.9s ease-in-out 3; }
@keyframes rs-flash { 50% { transform: scale(1.35); opacity: 0.4; } }
.rs-capglow { animation: rs-breathe 4s ease-in-out infinite; transform-box: fill-box; transform-origin: center; }
@keyframes rs-breathe { 50% { transform: scale(1.25); opacity: 0.7; } }
.rs-tier { font: 600 10px var(--display); fill: var(--text-faint); letter-spacing: 0.08em; paint-order: stroke; stroke: rgba(3, 5, 12, 0.9); stroke-width: 3px; pointer-events: none; }
.rs-cat { font-family: var(--display); font-weight: 600; letter-spacing: 0.16em; cursor: pointer; opacity: 0.75; }
.rs-cat:hover, .rs-cat.on { opacity: 1; }
.rs-ctrls { position: absolute; left: 10px; top: 10px; display: flex; flex-direction: column; gap: 2px; padding: 3px; border-radius: 9px; }
.rs-ctrls .btn.icon { width: 30px; height: 30px; }
.rs-hint { position: absolute; left: 10px; bottom: 8px; right: 10px; display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 11px; color: var(--text-faint); pointer-events: none; }
.rs-hint b { color: var(--text-dim); font-weight: 600; }
.rs-side { width: 310px; flex: 0 0 auto; border-left: 1px solid var(--line); background: rgba(6, 9, 20, 0.45); min-height: 0; }
.rs-searchbox { display: flex; align-items: center; gap: 8px; padding: 0 8px; border: 1px solid var(--line-2); border-radius: 8px; background: var(--panel-2); color: var(--text-dim); }
.rs-searchbox:focus-within { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(127, 220, 255, 0.15); }
.rs-searchbox input { flex: 1; min-width: 0; border: 0; background: transparent; padding: 8px 0; outline: none; }
.rs-searchbox input::-webkit-search-cancel-button { filter: invert(0.7); }
.rs-results { gap: 5px; margin-top: 8px; }
.rs-item { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 8px; background: var(--panel-2); border: 1px solid var(--line); min-width: 0; transition: border-color 0.12s, background 0.12s; }
.rs-item.click { cursor: pointer; }
.rs-item.hov, .rs-item.click:hover { border-color: var(--line-2); background: rgba(40, 56, 104, 0.6); }
.rs-item.click:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.rs-item.cur { border-color: rgba(111, 224, 138, 0.45); }
.rs-item .grow { line-height: 1.25; }
.rs-qn { font: 600 11px var(--display); color: #04101a; background: var(--accent); min-width: 18px; height: 18px; border-radius: 9px; display: inline-flex; align-items: center; justify-content: center; padding: 0 4px; flex-shrink: 0; }
.rs-qbtns { display: flex; gap: 0; flex-shrink: 0; }
.rs-qbtns .btn.icon { width: 24px; height: 24px; padding: 4px; }
.rs-link { background: none; border: 0; padding: 0; cursor: pointer; text-align: left; display: block; max-width: 100%; font-weight: 500; }
.rs-link:hover { color: var(--accent); }
.rs-current { padding: 10px; border-radius: 10px; border: 1px solid color-mix(in srgb, var(--c) 45%, transparent); background: linear-gradient(135deg, color-mix(in srgb, var(--c) 14%, transparent), rgba(20, 28, 52, 0.5)); }
.rs-current .rs-link { font-family: var(--display); font-size: 15px; font-weight: 600; }
.rs-current .bar > i { box-shadow: 0 0 10px currentColor; }
.rs-idle { padding: 10px; border-radius: 10px; border: 1px dashed rgba(255, 207, 106, 0.45); background: rgba(255, 207, 106, 0.06); display: flex; flex-direction: column; gap: 3px; }
.rs-idle b { color: var(--warn); font-family: var(--display); font-weight: 600; }
.rs-switch { display: flex; align-items: center; gap: 10px; margin-top: 12px; cursor: pointer; font-size: 13px; position: relative; }
.rs-switch input { position: absolute; opacity: 0; width: 1px; height: 1px; }
.rs-switch i { width: 34px; height: 19px; border-radius: 10px; background: rgba(255, 255, 255, 0.1); border: 1px solid var(--line-2); position: relative; flex-shrink: 0; transition: background 0.15s; }
.rs-switch i::after { content: ''; position: absolute; left: 2px; top: 2px; width: 13px; height: 13px; border-radius: 50%; background: var(--text-dim); transition: transform 0.15s, background 0.15s; }
.rs-switch input:checked + i { background: rgba(127, 220, 255, 0.35); border-color: var(--accent); }
.rs-switch input:checked + i::after { transform: translateX(15px); background: #fff; }
.rs-switch input:focus-visible + i { outline: 2px solid var(--accent); outline-offset: 2px; }
.rs-legend { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }
.rs-cat-btn { display: flex; align-items: center; gap: 7px; padding: 5px 7px; border-radius: 7px; border: 1px solid transparent; background: transparent; cursor: pointer; font-size: 12px; min-width: 0; text-align: left; }
.rs-cat-btn:hover { background: var(--panel-3); border-color: var(--line); }
.rs-cat-btn.on { border-color: var(--accent); background: rgba(127, 220, 255, 0.12); }
.rs-states { display: flex; flex-wrap: wrap; gap: 6px 12px; margin-top: 10px; color: var(--text-dim); }
@media (prefers-reduced-motion: reduce) {
  .rs-pulse, .rs-flash, .rs-capglow, .rs-edge.hot { animation: none; }
}
@media (max-width: 1000px) {
  .rs-side { width: 272px; }
  .rs-head .chip:last-child { display: none; }
}
@media (max-width: 720px) {
  .rs-root { flex-direction: column; }
  .rs-map { flex: 1 1 55%; }
  .rs-side { width: auto; flex: 1 1 45%; border-left: 0; border-top: 1px solid var(--line); }
  .rs-hint { display: none; }
}
`;

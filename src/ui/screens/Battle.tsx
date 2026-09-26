import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { store, useStore } from '../store';
import { Bar, Empty, Modal, fmt, plural } from '../common';
import { Icon, Portrait, EmpireDot } from '../icons';
import { BUILDING, PART, SPECIES_BY_ID } from '../../sim/content';
import { shipPath, STAR_COLORS } from '../../art/procedural';
import type { BattleReport, BattleShipSnap } from '../../sim/types';
import type { World } from '../../sim/world';

// ---------------------------------------------------------------------------
// Battle replay. The sim records one frame per round: unit positions/hp and
// every shot fired. We interpolate movement, stagger the shots through the
// round, and derive hp drain, shield flashes and explosions from them.
// ---------------------------------------------------------------------------

const ARENA_W = 1200, ARENA_H = 800;
const ROUND_MS = 600;
const MOVE_END = 0.45;
const FIRE_START = 0.3, FIRE_SPAN = 0.55;

type WeaponKind = 'beam' | 'bolt' | 'missile' | 'slug' | 'orb';
const WEAPON_FX: Record<string, { kind: WeaponKind; color: string; width: number }> = {
  massdriver: { kind: 'slug', color: '#ffe3a0', width: 2 },
  seeker: { kind: 'missile', color: '#ffae5a', width: 2 },
  missilebase: { kind: 'missile', color: '#ffae5a', width: 2 },
  disruptor: { kind: 'beam', color: '#8dff9a', width: 2.5 },
  pulser: { kind: 'bolt', color: '#7fe8ff', width: 2 },
  plasma: { kind: 'orb', color: '#ff6be6', width: 5 },
  ultralaser: { kind: 'beam', color: '#ff5a5a', width: 3 },
  lens: { kind: 'beam', color: '#e6f6ff', width: 2.5 },
  hypersphere: { kind: 'orb', color: '#b28cff', width: 7 },
  nanodis: { kind: 'beam', color: '#d8ff6a', width: 3.5 },
  lance: { kind: 'beam', color: '#7fb4ff', width: 3 },
  heavylance: { kind: 'beam', color: '#9fc8ff', width: 4.5 },
};
const fxOf = (part: string) => WEAPON_FX[part] ?? { kind: 'beam' as const, color: '#ffffff', width: 2 };
const weaponName = (part: string) => PART[part]?.name ?? BUILDING[part]?.name ?? part;

interface Shot { from: number; to: number; dmg: number; part: string; t0: number; t1: number }
interface Death { id: number; t: number; x: number; y: number; size: number; color: string }
interface Replay {
  n: number;
  /** Per frame: id -> [x, y, hp, shield]. */
  frames: Map<number, [number, number, number, number]>[];
  /** Per frame: id -> heading (radians). */
  heading: Map<number, number>[];
  shots: Shot[];
  /** Shots grouped by segment (round k -> k+1). */
  segShots: Shot[][];
  deaths: Death[];
  deathAt: Map<number, number>;
  escapedAt: Map<number, number>;
  shieldMax: Map<number, number>;
  units: Map<number, BattleShipSnap>;
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const ease = (x: number) => x * x * (3 - 2 * x);
const hash = (n: number) => {
  let x = (n * 2654435761) >>> 0;
  x ^= x >>> 15; x = Math.imul(x, 2246822519) >>> 0; x ^= x >>> 13;
  return (x >>> 0) / 4294967295;
};
const hullScale = (hull: string) => ({ small: 0.7, medium: 0.85, large: 1, enormous: 1.2, titan: 1.4, station: 1 } as Record<string, number>)[hull] ?? 0.85;

function buildReplay(w: World, r: BattleReport): Replay {
  const units = new Map(r.units.map((u) => [u.id, u]));
  const frames = r.frames.map((f) => new Map(f.u.map(([id, x, y, hp, sh]) => [id, [x, y, hp, sh] as [number, number, number, number]])));
  const n = frames.length;
  const shieldMax = new Map<number, number>();
  for (const f of frames) for (const [id, v] of f) shieldMax.set(id, Math.max(shieldMax.get(id) ?? 0, v[3]));

  // Headings: face the nearest hostile unit (or direction of travel).
  const heading = frames.map((f, k) => {
    const h = new Map<number, number>();
    for (const [id, [x, y]] of f) {
      const me = units.get(id);
      if (!me) continue;
      let best = Infinity, ang = me.owner % 2 ? Math.PI : 0;
      for (const [oid, [ox, oy]] of f) {
        const o = units.get(oid);
        if (!o || o.owner === me.owner) continue;
        const d = (ox - x) ** 2 + (oy - y) ** 2;
        if (d < best) { best = d; ang = Math.atan2(oy - y, ox - x); }
      }
      if (best === Infinity && k > 0) {
        const p = frames[k - 1].get(id);
        if (p && (p[0] !== x || p[1] !== y)) ang = Math.atan2(y - p[1], x - p[0]);
      }
      h.set(id, ang);
    }
    return h;
  });

  const shots: Shot[] = [];
  const segShots: Shot[][] = [];
  for (let k = 0; k < n - 1; k++) {
    const list = r.frames[k + 1].s;
    const seg: Shot[] = [];
    list.forEach(([from, to, dmg, part], i) => {
      const a = frames[k].get(from), b = frames[k].get(to);
      const fx = fxOf(part);
      const dist = a && b ? Math.hypot(a[0] - b[0], a[1] - b[1]) : 300;
      const travel = fx.kind === 'beam' ? 0.16 : fx.kind === 'orb' ? 0.12 + dist / 2600 : 0.08 + dist / 3200;
      const t0 = k + FIRE_START + FIRE_SPAN * (list.length > 1 ? i / list.length : 0) + hash(k * 977 + i) * 0.04;
      const s: Shot = { from, to, dmg, part, t0, t1: Math.min(k + 0.97, t0 + travel) };
      seg.push(s);
      shots.push(s);
    });
    segShots.push(seg);
  }

  // Units present in frame k but gone in k+1 either died (took damage) or escaped.
  const deaths: Death[] = [];
  const deathAt = new Map<number, number>();
  const escapedAt = new Map<number, number>();
  for (let k = 0; k < n - 1; k++) {
    for (const [id, [x, y]] of frames[k]) {
      if (frames[k + 1].has(id)) continue;
      const hits = segShots[k].filter((s) => s.to === id && s.dmg > 0);
      const u = units.get(id);
      if (hits.length) {
        const t = Math.max(...hits.map((s) => s.t1));
        deathAt.set(id, t);
        deaths.push({ id, t, x, y, size: 26 * hullScale(u?.hull ?? 'medium'), color: u ? w.s.empires[u.owner]?.color ?? '#fff' : '#fff' });
      } else escapedAt.set(id, k);
    }
  }
  return { n, frames, heading, shots, segShots, deaths, deathAt, escapedAt, shieldMax, units };
}

function angLerp(a: number, b: number, t: number) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/** Interpolated state of a unit at global time t (in rounds). */
function unitAt(rp: Replay, id: number, t: number) {
  const k = Math.min(rp.n - 1, Math.floor(t));
  const p = t - k;
  const a = rp.frames[k]?.get(id);
  if (!a) return null;
  const died = rp.deathAt.get(id);
  if (died !== undefined && t >= died) return null;
  const b = k + 1 < rp.n ? rp.frames[k + 1].get(id) : undefined;
  const esc = rp.escapedAt.get(id);
  const m = ease(clamp01(p / MOVE_END));
  let x = a[0], y = a[1], alpha = 1;
  if (b) {
    x = a[0] + (b[0] - a[0]) * m;
    y = a[1] + (b[1] - a[1]) * m;
  } else if (esc === k) {
    // Fled the arena: keep flying outward and fade.
    const dx = a[0] - ARENA_W / 2, dy = a[1] - ARENA_H / 2, len = Math.hypot(dx, dy) || 1;
    x = a[0] + (dx / len) * 160 * m;
    y = a[1] + (dy / len) * 160 * m;
    alpha = 1 - m;
  }
  const ha = rp.heading[k].get(id) ?? 0;
  const hb = b ? rp.heading[k + 1].get(id) ?? ha : ha;
  const heading = angLerp(ha, hb, m);
  // HP drains as the round's damaging shots land.
  let hp = a[2];
  if (k < rp.n - 1) {
    const target = b ? b[2] : died !== undefined ? 0 : a[2];
    const hits = rp.segShots[k].filter((s) => s.to === id && s.dmg > 0);
    const total = hits.reduce((s, h) => s + h.dmg, 0);
    if (total > 0) {
      const landed = hits.reduce((s, h) => s + (h.t1 <= t ? h.dmg : 0), 0);
      hp = a[2] + (target - a[2]) * (landed / total);
    } else hp = a[2] + (target - a[2]) * clamp01(p);
  }
  const smax = rp.shieldMax.get(id) ?? 0;
  let shield = a[3];
  if (b && smax > 0) shield = p < FIRE_START ? smax : smax + (b[3] - smax) * clamp01((p - FIRE_START) / FIRE_SPAN);
  return { x, y, hp: Math.max(0, hp), shield, smax, heading, alpha };
}

// --- drawing -----------------------------------------------------------------

function makeStars(seed: number) {
  const pts: [number, number, number, number][] = [];
  for (let i = 0; i < 260; i++) pts.push([hash(seed * 31 + i) * ARENA_W, hash(seed * 57 + i * 7 + 1) * ARENA_H, hash(i * 13 + seed) * 1.4 + 0.3, hash(i * 3 + seed * 5) * 0.7 + 0.15]);
  return pts;
}

function drawHex(ctx: CanvasRenderingContext2D, r: number) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  ctx.closePath();
}

interface DrawOpts { hover: number | null; highlight: number | null; now: number }

function draw(ctx: CanvasRenderingContext2D, w: World, rp: Replay, t: number, stars: ReturnType<typeof makeStars>, sun: string | null, o: DrawOpts) {
  ctx.fillStyle = '#04060e';
  ctx.fillRect(0, 0, ARENA_W, ARENA_H);
  const g = ctx.createRadialGradient(ARENA_W * 0.5, ARENA_H * 0.5, 50, ARENA_W * 0.5, ARENA_H * 0.5, 760);
  g.addColorStop(0, 'rgba(40,50,110,0.25)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, ARENA_W, ARENA_H);
  if (sun) {
    // The system's star, glowing off in a corner.
    const sx = ARENA_W - 90, sy = 70;
    const sg = ctx.createRadialGradient(sx, sy, 0, sx, sy, 300);
    sg.addColorStop(0, '#ffffff');
    sg.addColorStop(0.08, sun);
    sg.addColorStop(0.2, sun + '55');
    sg.addColorStop(1, sun + '00');
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = sg;
    ctx.fillRect(sx - 300, sy - 300, 600, 600);
    ctx.globalAlpha = 1;
  }
  for (const [x, y, s, a] of stars) {
    ctx.globalAlpha = a * (0.75 + 0.25 * Math.sin(o.now / 900 + x));
    ctx.fillStyle = '#cfe0ff';
    ctx.fillRect(x, y, s, s);
  }
  ctx.globalAlpha = 1;
  // Faint arena grid.
  ctx.strokeStyle = 'rgba(127,160,255,0.05)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 100; x < ARENA_W; x += 100) { ctx.moveTo(x, 0); ctx.lineTo(x, ARENA_H); }
  for (let y = 100; y < ARENA_H; y += 100) { ctx.moveTo(0, y); ctx.lineTo(ARENA_W, y); }
  ctx.stroke();

  const k = Math.min(rp.n - 1, Math.floor(t));
  const ids = new Set<number>(rp.frames[k]?.keys() ?? []);
  const state = new Map<number, NonNullable<ReturnType<typeof unitAt>>>();
  for (const id of ids) {
    const s = unitAt(rp, id, t);
    if (s) state.set(id, s);
  }
  const pos = (id: number) => state.get(id) ?? (() => { const f = rp.frames[k]?.get(id); return f ? { x: f[0], y: f[1] } : null; })();

  // Units.
  for (const [id, s] of state) {
    const u = rp.units.get(id);
    if (!u) continue;
    const emp = w.s.empires[u.owner];
    const color = emp?.color ?? '#ccc';
    const style = SPECIES_BY_ID[emp?.species ?? '']?.classicIndex ?? 0;
    const size = 30 * hullScale(u.hull);
    const hl = o.hover === id || o.highlight === id;
    ctx.save();
    ctx.globalAlpha = s.alpha;
    ctx.translate(s.x, s.y);
    // Owner glow.
    const gl = ctx.createRadialGradient(0, 0, 2, 0, 0, size * 1.1);
    gl.addColorStop(0, color + '55');
    gl.addColorStop(1, color + '00');
    ctx.fillStyle = gl;
    ctx.beginPath(); ctx.arc(0, 0, size * 1.1, 0, Math.PI * 2); ctx.fill();
    if (u.planet) {
      drawHex(ctx, size * 0.55);
      ctx.fillStyle = color + '66';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = color;
      ctx.stroke();
      drawHex(ctx, size * 0.25);
      ctx.fillStyle = '#ffffffaa';
      ctx.fill();
    } else {
      ctx.rotate(s.heading);
      shipPath(ctx, u.hull, size * 1.3, style);
      const sg = ctx.createLinearGradient(0, -size / 2, 0, size / 2);
      sg.addColorStop(0, '#ffffff');
      sg.addColorStop(0.35, color);
      sg.addColorStop(1, '#0a0a14');
      ctx.fillStyle = sg;
      ctx.fill();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = 'rgba(255,255,255,0.65)';
      ctx.stroke();
      // Engine flare.
      ctx.fillStyle = color;
      ctx.globalAlpha = s.alpha * (0.5 + 0.5 * Math.sin(o.now / 80 + id));
      ctx.beginPath(); ctx.arc(-size * 0.5, 0, 2.5, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = s.alpha;
      ctx.rotate(-s.heading);
    }
    // Shield bubble: steady glow proportional to remaining shield, plus hit flashes.
    if (s.smax > 0) {
      let flash = 0;
      for (const sh of rp.segShots[k] ?? []) if (sh.to === id && t >= sh.t1 && t < sh.t1 + 0.22) flash = Math.max(flash, 1 - (t - sh.t1) / 0.22);
      const frac = s.shield / s.smax;
      const a = 0.12 * frac + 0.55 * flash * (0.4 + 0.6 * frac);
      if (a > 0.01) {
        ctx.strokeStyle = `rgba(127,220,255,${a})`;
        ctx.fillStyle = `rgba(127,220,255,${a * 0.25})`;
        ctx.lineWidth = 1.5 + flash * 1.5;
        ctx.beginPath(); ctx.arc(0, 0, size * 0.85, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
    }
    if (hl) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.arc(0, 0, size * 1.05, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
    }
    // HP bar.
    const bw = Math.max(26, size * 1.1), frac = u.maxHp > 0 ? s.hp / u.maxHp : 0;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(-bw / 2, size * 0.75, bw, 4);
    ctx.fillStyle = frac > 0.6 ? '#6fe08a' : frac > 0.3 ? '#ffcf6a' : '#ff6b6b';
    ctx.fillRect(-bw / 2, size * 0.75, bw * frac, 4);
    if (hl) {
      ctx.font = '600 13px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#fff';
      ctx.fillText(u.name, 0, -size * 0.95);
      ctx.font = '11px Inter, sans-serif';
      ctx.fillStyle = '#b8c4e8';
      ctx.fillText(`${Math.ceil(s.hp)} / ${u.maxHp} hp${s.smax ? ` · shield ${Math.round(s.shield)}` : ''}`, 0, size * 0.75 + 16);
    }
    ctx.restore();
  }

  // Shots.
  ctx.lineCap = 'round';
  const segs = [rp.segShots[k - 1], rp.segShots[k]];
  for (const seg of segs) {
    if (!seg) continue;
    for (const sh of seg) {
      if (t < sh.t0 || t > sh.t1 + 0.18) continue;
      const a = pos(sh.from), b = pos(sh.to);
      if (!a || !b) continue;
      const fx = fxOf(sh.part);
      const miss = sh.dmg <= 0;
      // Misses sail past the target.
      const off = miss ? (hash(sh.t0 * 1000) - 0.5) * 70 : 0;
      const tx = b.x + off, ty = b.y - off * 0.6;
      const p = clamp01((t - sh.t0) / (sh.t1 - sh.t0));
      const after = t > sh.t1 ? (t - sh.t1) / 0.18 : 0;
      ctx.globalAlpha = miss ? 0.28 : 1;
      if (fx.kind === 'beam') {
        const fade = t > sh.t1 ? 1 - after : 1;
        ctx.globalAlpha *= fade;
        ctx.strokeStyle = fx.color;
        ctx.shadowColor = fx.color;
        ctx.shadowBlur = miss ? 0 : 12;
        ctx.lineWidth = fx.width * (miss ? 0.6 : 1);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(a.x + (tx - a.x) * Math.min(1, p * 2.5), a.y + (ty - a.y) * Math.min(1, p * 2.5)); ctx.stroke();
        ctx.shadowBlur = 0;
      } else if (t <= sh.t1) {
        const x = a.x + (tx - a.x) * p, y = a.y + (ty - a.y) * p;
        const dx = tx - a.x, dy = ty - a.y, len = Math.hypot(dx, dy) || 1;
        const trail = fx.kind === 'missile' ? 26 : fx.kind === 'slug' ? 14 : fx.kind === 'bolt' ? 18 : 6;
        ctx.strokeStyle = fx.color;
        ctx.lineWidth = fx.width;
        ctx.beginPath(); ctx.moveTo(x - (dx / len) * trail, y - (dy / len) * trail); ctx.lineTo(x, y); ctx.stroke();
        if (fx.kind === 'orb' || fx.kind === 'missile') {
          ctx.fillStyle = fx.color;
          ctx.shadowColor = fx.color;
          ctx.shadowBlur = 10;
          ctx.beginPath(); ctx.arc(x, y, fx.kind === 'orb' ? fx.width : 2.5, 0, Math.PI * 2); ctx.fill();
          ctx.shadowBlur = 0;
        }
      }
      // Impact spark.
      if (!miss && t >= sh.t1 && after < 1) {
        ctx.globalAlpha = 1 - after;
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(b.x, b.y, 2 + 6 * after + Math.min(6, sh.dmg / 2), 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }

  // Explosions.
  for (const d of rp.deaths) {
    const age = t - d.t;
    if (age < 0 || age > 1.1) continue;
    const q = age / 1.1;
    ctx.globalAlpha = 1 - q;
    const fg = ctx.createRadialGradient(d.x, d.y, 0, d.x, d.y, d.size * (0.6 + q * 1.4));
    fg.addColorStop(0, '#ffffff');
    fg.addColorStop(0.25, '#ffd27a');
    fg.addColorStop(0.6, d.color + 'aa');
    fg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = fg;
    ctx.beginPath(); ctx.arc(d.x, d.y, d.size * (0.6 + q * 1.4), 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#ffe2a8';
    ctx.lineWidth = 3 * (1 - q) + 0.5;
    ctx.beginPath(); ctx.arc(d.x, d.y, d.size * (0.4 + q * 2.6), 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = d.color;
    ctx.lineWidth = 1.5 * (1 - q) + 0.3;
    ctx.beginPath(); ctx.arc(d.x, d.y, d.size * (0.2 + q * 1.7), 0, Math.PI * 2); ctx.stroke();
    // Debris.
    ctx.fillStyle = '#ffd9a0';
    for (let i = 0; i < 8; i++) {
      const a = hash(d.id * 17 + i) * Math.PI * 2, sp = 30 + hash(d.id * 31 + i) * 60;
      ctx.fillRect(d.x + Math.cos(a) * sp * q, d.y + Math.sin(a) * sp * q, 2, 2);
    }
    ctx.globalAlpha = 1;
  }

  // Round label.
  ctx.font = '600 15px "Chakra Petch", Inter, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(223,230,255,0.55)';
  ctx.fillText(k === 0 && t < 0.3 ? 'DEPLOYMENT' : `ROUND ${Math.min(rp.n - 1, Math.floor(t + 1 - FIRE_START))}`, 18, 30);
}

// --- component ---------------------------------------------------------------

const BT_CSS = `
.bt-root { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) 300px; }
.bt-stage { min-width: 0; min-height: 0; display: flex; flex-direction: column; border-right: 1px solid var(--line); }
.bt-canvas-wrap { flex: 1; min-height: 0; position: relative; display: flex; align-items: center; justify-content: center; background: #02030a; overflow: hidden; }
.bt-canvas-wrap canvas { display: block; border-radius: 6px; box-shadow: 0 0 0 1px var(--line); }
.bt-controls { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--line); flex-wrap: wrap; }
.bt-controls input[type=range] { flex: 1; min-width: 120px; accent-color: var(--accent); }
.bt-round { font-family: var(--display); font-variant-numeric: tabular-nums; min-width: 92px; text-align: center; color: var(--text-dim); }
.bt-side { padding: 10px 12px; border-bottom: 1px solid var(--line); }
.bt-side.win { background: linear-gradient(90deg, rgba(255,207,106,.08), transparent); }
.bt-unit { display: flex; align-items: center; gap: 8px; padding: 4px 6px; border-radius: 6px; font-size: 12px; cursor: default; }
.bt-unit:hover { background: var(--panel-3); }
.bt-unit.dead { opacity: .45; }
.bt-unit.dead .nm { text-decoration: line-through; }
.bt-unit .bar { width: 64px; flex-shrink: 0; }
.bt-hex { width: 12px; height: 12px; clip-path: polygon(25% 5%, 75% 5%, 100% 50%, 75% 95%, 25% 95%, 0 50%); flex-shrink: 0; }
.bt-tri { width: 12px; height: 12px; clip-path: polygon(0 10%, 100% 50%, 0 90%, 20% 50%); flex-shrink: 0; }
.bt-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 24px; text-align: center; }
.bt-list { flex: 1; min-height: 0; }
.bt-list td { vertical-align: middle; }
@media (max-width: 900px) {
  .bt-root { grid-template-columns: 1fr; grid-template-rows: minmax(260px, 1fr) auto; overflow-y: auto; }
  .bt-stage { border-right: 0; border-bottom: 1px solid var(--line); }
  .bt-panel { max-height: 40vh; }
}
`;

export function BattleScreen() {
  useStore();
  const w = store.world;
  const arg = store.screenArg as { battle?: number } | null;
  const report = w && arg?.battle !== undefined ? w.s.battles.find((b) => b.id === arg.battle) : undefined;
  if (!w) return <Modal title="Battles"><Empty>No game loaded.</Empty></Modal>;
  if (!report) return <BattleList w={w} missing={arg?.battle !== undefined} />;
  return <BattleView key={report.id} w={w} report={report} />;
}

function starName(w: World, id: number) {
  return w.s.stars[id]?.name ?? 'deep space';
}

function BattleList({ w, missing }: { w: World; missing: boolean }) {
  const human = w.human();
  const list = [...w.s.battles].sort((a, b) => b.day - a.day || b.id - a.id);
  return (
    <Modal title="Battle Reports">
      <style>{BT_CSS}</style>
      <div class="col grow" style={{ minHeight: 0 }}>
        {missing && <div class="small warn" style={{ padding: '10px 16px 0' }}>That battle report has expired — only the most recent battles are kept.</div>}
        {list.length === 0 ? <Empty>No battles have been fought yet.</Empty> : (
          <div class="scroll bt-list">
            <table class="list">
              <thead><tr><th>Day</th><th>Location</th><th>Belligerents</th><th>Losses</th><th>Outcome</th><th></th></tr></thead>
              <tbody>
                {list.map((b) => {
                  const mine = human && b.sides.includes(human.id);
                  const won = human && b.winner === human.id;
                  return (
                    <tr onClick={() => store.open('battle', { battle: b.id })}>
                      <td class="mono dim">{b.day}</td>
                      <td>{starName(w, b.star)}</td>
                      <td>
                        <span class="row" style={{ gap: 6 }}>
                          {b.sides.map((s) => <span class="row" style={{ gap: 4 }} data-tip={w.s.empires[s]?.name}><EmpireDot color={w.s.empires[s]?.color ?? '#888'} size={9} /><span class="small">{w.s.empires[s]?.name}</span></span>)}
                        </span>
                      </td>
                      <td class="small mono">{b.sides.map((s) => b.losses[s] ?? 0).join(' / ')}</td>
                      <td class="small">
                        {b.winner === null ? <span class="dim">Inconclusive</span>
                          : mine ? <span class={won ? 'good' : 'bad'}>{won ? 'Victory' : 'Defeat'}</span>
                          : <span>{w.s.empires[b.winner]?.name} won</span>}
                      </td>
                      <td class="small">{b.frames.length > 1 ? <span class="chip">{Icon.play({ size: 10 })} Replay</span> : <span class="faint">Report</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Modal>
  );
}

function BattleView({ w, report }: { w: World; report: BattleReport }) {
  const rp = useMemo(() => buildReplay(w, report), [report]);
  const hasReplay = rp.n > 1;
  const end = Math.max(0, rp.n - 1);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tRef = useRef(0);
  const [playing, setPlaying] = useState(hasReplay);
  const [speed, setSpeed] = useState(1);
  const [tick, setTick] = useState(0); // throttled UI time (quarter rounds)
  const [hover, setHover] = useState<number | null>(null);
  const [highlight, setHighlight] = useState<number | null>(null);
  const playRef = useRef({ playing, speed, hover, highlight });
  playRef.current = { playing, speed, hover, highlight };
  const stars = useMemo(() => makeStars(report.id), [report]);
  const sun = useMemo(() => {
    const c = STAR_COLORS[w.s.stars[report.star]?.cls];
    return c && /^#[0-9a-f]{6}$/i.test(c) ? c : null;
  }, [report]);
  const scaleRef = useRef(1);

  // Size canvas to fit the stage at 3:2.
  useEffect(() => {
    const wrap = wrapRef.current, cv = canvasRef.current;
    if (!wrap || !cv) return;
    const fit = () => {
      const pad = 12;
      const W = Math.max(100, wrap.clientWidth - pad * 2), H = Math.max(80, wrap.clientHeight - pad * 2);
      const scale = Math.min(W / ARENA_W, H / ARENA_H);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      cv.style.width = Math.floor(ARENA_W * scale) + 'px';
      cv.style.height = Math.floor(ARENA_H * scale) + 'px';
      cv.width = Math.floor(ARENA_W * scale * dpr);
      cv.height = Math.floor(ARENA_H * scale * dpr);
      scaleRef.current = scale * dpr;
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [hasReplay]);

  // Animation loop.
  useEffect(() => {
    if (!hasReplay) return;
    let raf = 0, last = performance.now(), lastTick = -1;
    const loop = (now: number) => {
      const dt = Math.min(100, now - last);
      last = now;
      const st = playRef.current;
      if (st.playing) {
        tRef.current = Math.min(end + 0.999, tRef.current + (dt / ROUND_MS) * st.speed);
        if (tRef.current >= end + 0.999) { tRef.current = end; setPlaying(false); }
      }
      const cv = canvasRef.current;
      const ctx = cv?.getContext('2d');
      if (cv && ctx) {
        const s = scaleRef.current;
        ctx.setTransform(s, 0, 0, s, 0, 0);
        draw(ctx, w, rp, Math.min(tRef.current, end), stars, sun, { hover: st.hover, highlight: st.highlight, now });
      }
      const q = Math.floor(tRef.current * 4);
      if (q !== lastTick) { lastTick = q; setTick(q); }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [rp]);

  // Keyboard: space toggles play.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === ' ' && hasReplay && !(e.target instanceof HTMLInputElement && e.target.type !== 'range')) {
        e.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });

  const togglePlay = () => {
    if (!playing && tRef.current >= end - 0.001) tRef.current = 0;
    setPlaying(!playing);
  };
  const restart = () => { tRef.current = 0; setTick(0); setPlaying(true); };
  const seek = (v: number) => { tRef.current = v; setTick(Math.floor(v * 4)); };

  const onMove = (e: PointerEvent) => {
    const cv = canvasRef.current;
    if (!cv) return;
    const rect = cv.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * ARENA_W, y = ((e.clientY - rect.top) / rect.height) * ARENA_H;
    let best: number | null = null, bd = 40 * 40;
    const t = Math.min(tRef.current, end);
    for (const id of rp.frames[Math.floor(t)]?.keys() ?? []) {
      const s = unitAt(rp, id, t);
      if (!s) continue;
      const d = (s.x - x) ** 2 + (s.y - y) ** 2;
      if (d < bd) { bd = d; best = id; }
    }
    if (best !== hover) setHover(best);
  };

  const t = Math.min(tick / 4, end);
  const round = Math.min(end, Math.floor(t + 1 - FIRE_START));
  const human = w.human();
  const winner = report.winner !== null ? w.s.empires[report.winner] : null;
  const title = winner
    ? `Battle of ${starName(w, report.star)} — ${human && report.winner === human.id ? 'Victory' : human && report.sides.includes(human.id) ? 'Defeat' : `${winner.name} victorious`}`
    : `Battle of ${starName(w, report.star)} — Inconclusive`;

  // Live unit status at the current (throttled) time.
  const liveHp = (u: BattleShipSnap): { hp: number; dead: boolean; fled: boolean } => {
    if (!hasReplay) return { hp: u.maxHp, dead: false, fled: false };
    const s = unitAt(rp, u.id, t);
    if (s) return { hp: s.hp, dead: false, fled: false };
    const died = rp.deathAt.get(u.id);
    if (died !== undefined && t >= died) return { hp: 0, dead: true, fled: false };
    const esc = rp.escapedAt.get(u.id);
    if (esc !== undefined && t >= esc + 1) return { hp: rp.frames[esc].get(u.id)?.[2] ?? 0, dead: false, fled: true };
    return { hp: 0, dead: true, fled: false };
  };

  // Shot log for the current round (for the side panel).
  const segIdx = Math.min(rp.segShots.length - 1, Math.floor(t));
  const seg = hasReplay ? rp.segShots[segIdx] ?? [] : [];
  const segHits = seg.filter((s) => s.dmg > 0);
  const segDmg = segHits.reduce((a, s) => a + s.dmg, 0);

  const panel = (
    <div class="bt-panel scroll">
      <div class="bt-side" style={{ paddingBottom: 12 }}>
        <div class="small" style={{ lineHeight: 1.45 }}>{report.summary}</div>
        <div class="row tiny dim" style={{ marginTop: 6, gap: 12 }}>
          <span>Day {report.day}</span>
          <span>{plural(report.units.length, 'combatant')}</span>
          {hasReplay && <span>{plural(end, 'round')}</span>}
        </div>
      </div>
      {report.sides.map((sid) => {
        const e = w.s.empires[sid];
        const units = report.units.filter((u) => u.owner === sid);
        const lost = report.losses[sid] ?? 0;
        const isWin = report.winner === sid;
        return (
          <div class={'bt-side' + (isWin ? ' win' : '')}>
            <div class="row" style={{ marginBottom: 6 }}>
              {e && <Portrait species={e.species} color={e.color} size={30} />}
              <div class="grow">
                <div class="row" style={{ gap: 6 }}>
                  <b class="ellipsis" style={{ fontFamily: 'var(--display)' }}>{e?.name ?? 'Unknown'}</b>
                  {isWin && <span class="chip warn">{Icon.trophy({ size: 11 })} Winner</span>}
                  {human?.id === sid && <span class="tiny faint">you</span>}
                </div>
                <div class="tiny dim">{plural(units.length, 'unit')} · <span class={lost ? 'bad' : 'good'}>{lost} lost</span></div>
              </div>
            </div>
            {units.map((u) => {
              const st = liveHp(u);
              return (
                <div class={'bt-unit' + (st.dead ? ' dead' : '')} onMouseEnter={() => setHighlight(u.id)} onMouseLeave={() => setHighlight(null)}
                  data-tip={`${u.name}\n${u.planet ? 'Orbital defense' : `${u.hull[0].toUpperCase() + u.hull.slice(1)} hull`} · ${u.maxHp} hp${rp.shieldMax.get(u.id) ? ` · ${rp.shieldMax.get(u.id)} shield` : ''}`}>
                  <span class={u.planet ? 'bt-hex' : 'bt-tri'} style={{ background: e?.color ?? '#aaa' }} />
                  <span class="nm grow ellipsis">{u.name}</span>
                  {st.fled ? <span class="tiny warn">fled</span> : st.dead ? <span class="tiny bad">destroyed</span> : (
                    <>
                      <Bar value={st.hp} max={u.maxHp} color={st.hp / u.maxHp > 0.6 ? 'var(--good)' : st.hp / u.maxHp > 0.3 ? 'var(--warn)' : 'var(--bad)'} />
                      <span class="tiny mono dim" style={{ minWidth: 44, textAlign: 'right' }}>{Math.ceil(st.hp)}/{u.maxHp}</span>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
      {hasReplay && seg.length > 0 && (
        <div class="bt-side">
          <div class="caps" style={{ marginBottom: 4 }}>Round {segIdx + 1} fire</div>
          <div class="small dim">{plural(seg.length, 'shot')} · {segHits.length} hit · {fmt(segDmg)} hull damage</div>
          <div class="row wrap tiny" style={{ marginTop: 6, gap: 6 }}>
            {[...new Set(seg.map((s) => s.part))].map((p) => <span class="chip"><span class="dot" style={{ background: fxOf(p).color, width: 7, height: 7 }} />{weaponName(p)}</span>)}
          </div>
        </div>
      )}
    </div>
  );

  const goTo = () => {
    store.select({ star: report.star, planet: null, fleet: null });
    store.focus(report.star);
    store.open('none');
  };

  return (
    <Modal title={title} actions={<>
      <button class="btn sm ghost" onClick={goTo} data-tip="Show this system on the map">{Icon.target({ size: 14 })} {starName(w, report.star)}</button>
      <button class="btn sm ghost" onClick={() => store.open('battle', null)} data-tip="All recent battles">{Icon.menu({ size: 14 })} All battles</button>
    </>}>
      <style>{BT_CSS}</style>
      <div class="bt-root">
        <div class="bt-stage">
          {hasReplay ? (
            <>
              <div class="bt-canvas-wrap" ref={wrapRef}>
                <canvas ref={canvasRef} onPointerMove={onMove} onPointerLeave={() => setHover(null)} style={{ cursor: hover !== null ? 'crosshair' : 'default' }} />
              </div>
              <div class="bt-controls">
                <button class="btn icon" onClick={togglePlay} data-tip={playing ? 'Pause (Space)' : 'Play (Space)'}>{playing ? <Icon.pause /> : <Icon.play />}</button>
                <button class="btn icon" onClick={restart} data-tip="Restart"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></svg></button>
                <div class="seg">
                  {[1, 2, 4].map((s) => <button class={speed === s ? 'on' : ''} onClick={() => setSpeed(s)}>{s}×</button>)}
                </div>
                <input type="range" min={0} max={end} step={0.01} value={t}
                  onInput={(e) => { setPlaying(false); seek(parseFloat((e.target as HTMLInputElement).value)); }} />
                <span class="bt-round">{t < FIRE_START && Math.floor(t) === 0 ? 'Deploy' : `Round ${Math.max(1, round)}`} / {end}</span>
              </div>
            </>
          ) : (
            <div class="bt-empty">
              <Icon.eye size={40} />
              <h3>No sensor recording</h3>
              <div class="small dim" style={{ maxWidth: 420 }}>You had no forces in this engagement, so only the outcome was reported. Losses by side are listed on the right.</div>
              <div class="row wrap" style={{ gap: 8, justifyContent: 'center', marginTop: 8 }}>
                {report.sides.map((s) => (
                  <div class="card row" style={{ gap: 8 }}>
                    <EmpireDot color={w.s.empires[s]?.color ?? '#888'} />
                    <span>{w.s.empires[s]?.name}</span>
                    <span class={(report.losses[s] ?? 0) ? 'bad' : 'good'}>−{report.losses[s] ?? 0}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        {panel}
      </div>
    </Modal>
  );
}


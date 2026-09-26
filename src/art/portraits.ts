// Original, procedurally painted species portraits. Each species has its own
// hand-written "recipe" built from a few painterly helpers (soft lit blobs,
// tapered tentacles, glowing eyes, noise texture), so no artwork from the 1995
// game is needed anywhere.

import { fbm } from './procedural';

type Ctx = CanvasRenderingContext2D;
type RGB = [number, number, number];

const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const rgba = (c: RGB, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const lighten = (c: RGB, t: number) => mix(c, [255, 255, 255], t);
const darken = (c: RGB, t: number) => mix(c, [0, 0, 0], t);

function rng(seed: string) {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

// --- painterly helpers -------------------------------------------------------

/** Fill the current path with a lit, shaded gradient (light from top-left) plus a rim light. */
function shade(ctx: Ctx, cx: number, cy: number, r: number, base: RGB, opts: { alpha?: number; rim?: RGB; gloss?: number } = {}) {
  const a = opts.alpha ?? 1;
  const g = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.05, cx, cy, r * 1.15);
  g.addColorStop(0, rgba(lighten(base, 0.45), a));
  g.addColorStop(0.45, rgba(base, a));
  g.addColorStop(1, rgba(darken(base, 0.7), a));
  ctx.fillStyle = g;
  ctx.fill();
  if (opts.rim) {
    ctx.save();
    ctx.clip();
    const rg = ctx.createRadialGradient(cx + r * 0.5, cy + r * 0.3, r * 0.6, cx + r * 0.2, cy, r * 1.3);
    rg.addColorStop(0, rgba(opts.rim, 0));
    rg.addColorStop(1, rgba(opts.rim, 0.55 * a));
    ctx.fillStyle = rg;
    ctx.fillRect(cx - r * 2, cy - r * 2, r * 4, r * 4);
    ctx.restore();
  }
  if (opts.gloss) {
    ctx.save();
    ctx.globalAlpha = opts.gloss * a;
    ctx.beginPath();
    ctx.ellipse(cx - r * 0.35, cy - r * 0.45, r * 0.28, r * 0.14, -0.6, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.restore();
  }
}

function ellipse(ctx: Ctx, x: number, y: number, rx: number, ry: number, rot = 0) {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2);
}

function blob(ctx: Ctx, x: number, y: number, r: number, base: RGB, opts: Parameters<typeof shade>[5] & { squash?: number; wobble?: number; seed?: number } = {}) {
  const n = 28;
  const R = rng('blob' + (opts.seed ?? x + y));
  const wob = opts.wobble ?? 0.08;
  const ph = R() * 10;
  ctx.beginPath();
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const k = 1 + Math.sin(a * 3 + ph) * wob + Math.sin(a * 5 + ph * 2) * wob * 0.5;
    const px = x + Math.cos(a) * r * k, py = y + Math.sin(a) * r * k * (opts.squash ?? 1);
    i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  }
  ctx.closePath();
  shade(ctx, x, y, r, base, opts);
}

/** A tapered, shaded tentacle/limb along a quadratic path. */
function limb(ctx: Ctx, pts: [number, number][], w0: number, w1: number, base: RGB, opts: { tipGlow?: RGB; segments?: number } = {}) {
  const seg = opts.segments ?? 30;
  const at = (t: number): [number, number] => {
    // Catmull-Rom through the control points.
    const n = pts.length - 1;
    const f = Math.min(n - 1e-6, t * n);
    const i = Math.floor(f), u = f - i;
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(n, i + 2)];
    const c = (a: number, b: number, cc: number, d: number) => 0.5 * (2 * b + (-a + cc) * u + (2 * a - 5 * b + 4 * cc - d) * u * u + (-a + 3 * b - 3 * cc + d) * u * u * u);
    return [c(p0[0], p1[0], p2[0], p3[0]), c(p0[1], p1[1], p2[1], p3[1])];
  };
  for (let k = 0; k < seg; k++) {
    const t = k / seg;
    const [x, y] = at(t);
    const w = w0 + (w1 - w0) * t;
    ellipse(ctx, x, y, w, w);
    shade(ctx, x, y, w, mix(base, darken(base, 0.3), t));
  }
  if (opts.tipGlow) {
    const [x, y] = at(0.999);
    glow(ctx, x, y, w1 * 3, opts.tipGlow, 0.8);
  }
}

function glow(ctx: Ctx, x: number, y: number, r: number, c: RGB, a = 1) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, rgba(lighten(c, 0.6), a));
  g.addColorStop(0.3, rgba(c, a * 0.6));
  g.addColorStop(1, rgba(c, 0));
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
  ctx.restore();
}

function eye(ctx: Ctx, x: number, y: number, r: number, iris: RGB, opts: { slit?: boolean; glowA?: number; lid?: number; white?: RGB } = {}) {
  ellipse(ctx, x, y, r, r * (opts.lid ?? 1));
  shade(ctx, x, y, r, opts.white ?? [235, 232, 220]);
  ellipse(ctx, x + r * 0.08, y + r * 0.05, r * 0.62, r * 0.62 * (opts.lid ?? 1));
  shade(ctx, x, y, r * 0.62, iris);
  if (opts.slit) ellipse(ctx, x + r * 0.08, y + r * 0.05, r * 0.14, r * 0.55 * (opts.lid ?? 1));
  else ellipse(ctx, x + r * 0.08, y + r * 0.05, r * 0.28, r * 0.28 * (opts.lid ?? 1));
  ctx.fillStyle = '#05060a';
  ctx.fill();
  ellipse(ctx, x - r * 0.25, y - r * 0.3, r * 0.16, r * 0.12);
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.fill();
  if (opts.glowA) glow(ctx, x, y, r * 2.4, iris, opts.glowA);
}

function glowEye(ctx: Ctx, x: number, y: number, r: number, c: RGB) {
  glow(ctx, x, y, r * 4, c, 0.7);
  ellipse(ctx, x, y, r, r * 0.7);
  ctx.fillStyle = rgba(lighten(c, 0.8));
  ctx.fill();
}

/** Overlay organic noise texture on whatever is already drawn (inside `clip` if given). */
function texture(ctx: Ctx, W: number, H: number, seed: number, strength = 0.18, scale = 0.02) {
  const small = 160;
  const c = document.createElement('canvas');
  c.width = small;
  c.height = Math.round((small * H) / W);
  const t = c.getContext('2d')!;
  const img = t.createImageData(c.width, c.height);
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
    const v = fbm(x * scale * 6, y * scale * 6, seed * 0.37, seed, 4);
    const i = (y * c.width + x) * 4;
    const k = v * 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = k;
    img.data[i + 3] = 255;
  }
  t.putImageData(img, 0, 0);
  ctx.save();
  ctx.globalCompositeOperation = 'overlay';
  ctx.globalAlpha = strength;
  ctx.drawImage(c, 0, 0, W, H);
  ctx.restore();
}

function sky(ctx: Ctx, W: number, H: number, top: string, bottom: string, seed: number, nebula?: string) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, top);
  g.addColorStop(1, bottom);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  const R = rng('sky' + seed);
  for (let i = 0; i < 90; i++) {
    ctx.fillStyle = `rgba(255,255,255,${0.2 + R() * 0.6})`;
    const s = R() * 1.6 + 0.3;
    ctx.fillRect(R() * W, R() * H * 0.7, s, s);
  }
  if (nebula) {
    const c = hex(nebula);
    for (let i = 0; i < 5; i++) glow(ctx, R() * W, R() * H * 0.6, 80 + R() * 140, c, 0.18);
  }
}

function ground(ctx: Ctx, W: number, H: number, y: number, c1: string, c2: string, seed: number, rough = 18) {
  const R = rng('ground' + seed);
  ctx.beginPath();
  ctx.moveTo(0, H);
  for (let x = 0; x <= W; x += 16) ctx.lineTo(x, y + Math.sin(x * 0.012 + seed) * rough + (R() - 0.5) * rough * 0.5);
  ctx.lineTo(W, H);
  ctx.closePath();
  const g = ctx.createLinearGradient(0, y - rough, 0, H);
  g.addColorStop(0, c1);
  g.addColorStop(1, c2);
  ctx.fillStyle = g;
  ctx.fill();
}

function vignette(ctx: Ctx, W: number, H: number, tint: RGB) {
  const g = ctx.createRadialGradient(W / 2, H * 0.45, H * 0.3, W / 2, H / 2, W * 0.75);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.75)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.globalCompositeOperation = 'soft-light';
  ctx.fillStyle = rgba(tint, 0.25);
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

// --- species recipes -----------------------------------------------------------
// All coordinates are in a 480x320 frame (scaled by the caller).

type Recipe = (ctx: Ctx, W: number, H: number, col: RGB) => void;

const RECIPES: Record<string, Recipe> = {
  oolari(ctx, W, H, col) {
    sky(ctx, W, H, '#1a0f33', '#4a2a6a', 1, '#b48cff');
    const sacs: [number, number, number][] = [[250, 130, 78], [160, 170, 48], [345, 185, 40]];
    for (const [x, y, r] of sacs) {
      for (let k = 0; k < 6; k++) {
        const dx = (k - 2.5) * r * 0.22;
        limb(ctx, [[x + dx, y + r * 0.7], [x + dx * 1.4 + Math.sin(k) * 10, y + r * 1.4], [x + dx * 1.8, y + r * 2.1 + k * 4]], r * 0.08, r * 0.02, darken(col, 0.2), { tipGlow: [200, 170, 255] });
      }
      blob(ctx, x, y, r, col, { alpha: 0.82, rim: [255, 220, 255], gloss: 0.5, squash: 0.9, seed: x });
      for (let k = 0; k < 4; k++) glow(ctx, x + Math.cos(k * 1.7) * r * 0.4, y + Math.sin(k * 2.3) * r * 0.35, r * 0.25, [255, 200, 255], 0.5);
    }
  },
  grakk(ctx, W, H, col) {
    sky(ctx, W, H, '#1a0a06', '#5a2410', 2, '#ff6a2a');
    ground(ctx, W, H, 250, '#3a1a0e', '#120604', 2, 10);
    // Faceted rock body.
    const pts: [number, number][] = [[120, 290], [110, 190], [160, 110], [240, 80], [330, 100], [380, 170], [375, 290]];
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    shade(ctx, 245, 190, 150, darken(col, 0.35), { rim: [255, 140, 60] });
    texture(ctx, W, H, 2, 0.25, 0.05);
    // Lava cracks.
    ctx.strokeStyle = 'rgba(255,140,40,0.9)';
    ctx.lineWidth = 3;
    const R = rng('grakk');
    for (let i = 0; i < 9; i++) {
      let x = 150 + R() * 200, y = 110 + R() * 150;
      ctx.beginPath();
      ctx.moveTo(x, y);
      for (let k = 0; k < 4; k++) { x += (R() - 0.5) * 40; y += R() * 26; ctx.lineTo(x, y); }
      ctx.stroke();
      glow(ctx, x, y, 18, [255, 120, 30], 0.35);
    }
    // Crystal spikes.
    for (const [x, y, h] of [[190, 100, 50], [260, 78, 70], [320, 95, 45]] as const) {
      ctx.beginPath();
      ctx.moveTo(x - 12, y + 10); ctx.lineTo(x, y - h); ctx.lineTo(x + 12, y + 10);
      ctx.closePath();
      shade(ctx, x, y - h / 2, h / 2, [255, 170, 90], { gloss: 0.4 });
    }
    glowEye(ctx, 215, 165, 8, [255, 200, 60]);
    glowEye(ctx, 275, 160, 8, [255, 200, 60]);
  },
  mirrith(ctx, W, H, col) {
    sky(ctx, W, H, '#020a1a', '#062a44', 3, '#46c7e6');
    ctx.strokeStyle = 'rgba(70,199,230,0.12)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 16; i++) {
      ctx.beginPath();
      for (let x = 0; x <= W; x += 10) ctx.lineTo(x, i * 22 + Math.sin(x * 0.02 + i) * 12);
      ctx.stroke();
    }
    for (let k = 0; k < 3; k++) {
      const pts: [number, number][] = [];
      for (let i = 0; i <= 8; i++) pts.push([40 + i * 52, 160 + Math.sin(i * 0.9 + k * 2) * (60 - k * 12) + k * 30 - 30]);
      limb(ctx, pts, 22 - k * 5, 3, k ? darken(col, 0.3) : col, { segments: 70, tipGlow: [150, 240, 255] });
    }
    eye(ctx, 64, 118, 9, [40, 220, 255], { slit: true, glowA: 0.4 });
    for (let i = 0; i < 5; i++) glow(ctx, 120 + i * 60, 150 + Math.sin(i) * 40, 14, [120, 230, 255], 0.5);
  },
  tessel(ctx, W, H, col) {
    sky(ctx, W, H, '#06141a', '#0c3a3a', 4, '#8fe3c0');
    ground(ctx, W, H, 262, '#0c2a2a', '#020a0a', 4, 6);
    const R = rng('tessel');
    const prisms: [number, number, number, number][] = [];
    for (let i = 0; i < 11; i++) prisms.push([130 + R() * 220, 270, 12 + R() * 22, 70 + R() * 150]);
    prisms.sort((a, b) => b[3] - a[3]);
    for (const [x, y, w, h] of prisms) {
      const lean = (x - 240) * 0.15;
      ctx.beginPath();
      ctx.moveTo(x - w, y); ctx.lineTo(x - w + lean, y - h); ctx.lineTo(x + lean, y - h - w * 0.8); ctx.lineTo(x + w + lean, y - h); ctx.lineTo(x + w, y);
      ctx.closePath();
      shade(ctx, x + lean * 0.5, y - h / 2, h / 2, col, { alpha: 0.75, rim: [220, 255, 240], gloss: 0.3 });
      glow(ctx, x + lean * 0.6, y - h * 0.6, w * 1.5, [180, 255, 220], 0.35);
    }
    ctx.strokeStyle = 'rgba(200,255,230,0.35)';
    for (let i = 0; i < prisms.length - 1; i++) {
      ctx.beginPath();
      ctx.moveTo(prisms[i][0], prisms[i][1] - prisms[i][3] * 0.5);
      ctx.lineTo(prisms[i + 1][0], prisms[i + 1][1] - prisms[i + 1][3] * 0.5);
      ctx.stroke();
    }
  },
  pheon(ctx, W, H, col) {
    sky(ctx, W, H, '#ffb6d9', '#ffe6f0', 5);
    ground(ctx, W, H, 230, '#6fbf5a', '#2f6a2a', 5, 12);
    const R = rng('pheon');
    const crowd: [number, number, number][] = [];
    for (let i = 0; i < 9; i++) crowd.push([40 + R() * 400, 200 + R() * 90, 18 + R() * 26]);
    crowd.sort((a, b) => a[1] - b[1]);
    crowd.push([240, 200, 64]);
    crowd.sort((a, b) => a[1] + a[2] - (b[1] + b[2]));
    for (const [x, y, r] of crowd) {
      blob(ctx, x, y, r, col, { wobble: 0.15, rim: [255, 240, 250], seed: x * 3 });
      texture(ctx, W, H, 5, 0.03, 0.2);
      eye(ctx, x - r * 0.35, y - r * 0.15, r * 0.3, [60, 30, 80]);
      eye(ctx, x + r * 0.35, y - r * 0.15, r * 0.3, [60, 30, 80]);
      ctx.beginPath();
      ctx.arc(x, y + r * 0.25, r * 0.22, 0.1 * Math.PI, 0.9 * Math.PI);
      ctx.strokeStyle = rgba(darken(col, 0.6));
      ctx.lineWidth = Math.max(1.5, r * 0.06);
      ctx.stroke();
    }
  },
  zurvani(ctx, W, H, col) {
    sky(ctx, W, H, '#060818', '#1a2050', 6, '#6f8cff');
    // Library pillars.
    for (const x of [40, 110, 370, 440]) {
      ctx.fillStyle = 'rgba(40,50,100,0.6)';
      ctx.fillRect(x - 14, 20, 28, 300);
      ctx.fillStyle = 'rgba(120,140,220,0.15)';
      ctx.fillRect(x - 14, 20, 6, 300);
    }
    // Floating glyph ring.
    ctx.strokeStyle = 'rgba(150,180,255,0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(240, 110, 120, 30, 0, 0, Math.PI * 2);
    ctx.stroke();
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      ctx.fillStyle = 'rgba(180,200,255,0.7)';
      ctx.fillRect(240 + Math.cos(a) * 120 - 3, 110 + Math.sin(a) * 30 - 4, 6, 8);
    }
    // Robe.
    ctx.beginPath();
    ctx.moveTo(240, 70); ctx.bezierCurveTo(300, 90, 330, 250, 350, 320); ctx.lineTo(130, 320); ctx.bezierCurveTo(150, 250, 180, 90, 240, 70);
    ctx.closePath();
    shade(ctx, 240, 200, 150, darken(col, 0.3), { rim: [150, 170, 255] });
    texture(ctx, W, H, 6, 0.15, 0.06);
    // Hood void and three eyes.
    ellipse(ctx, 240, 120, 40, 48);
    ctx.fillStyle = '#02030a';
    ctx.fill();
    glowEye(ctx, 226, 118, 5, [150, 190, 255]);
    glowEye(ctx, 254, 118, 5, [150, 190, 255]);
    glowEye(ctx, 240, 100, 4, [220, 180, 255]);
  },
  hkeet(ctx, W, H, col) {
    sky(ctx, W, H, '#2a0404', '#a0301a', 7, '#ff5a3a');
    ground(ctx, W, H, 270, '#2a0a06', '#0a0202', 7, 8);
    // Neck and head in profile, jaws open.
    limb(ctx, [[120, 330], [150, 250], [200, 190], [250, 160]], 60, 42, darken(col, 0.2), { segments: 40 });
    ctx.beginPath();
    ctx.moveTo(230, 120); ctx.quadraticCurveTo(330, 110, 420, 150); ctx.lineTo(330, 165); ctx.quadraticCurveTo(270, 170, 230, 190);
    ctx.closePath();
    shade(ctx, 300, 145, 90, col, { rim: [255, 180, 120] });
    ctx.beginPath();
    ctx.moveTo(235, 195); ctx.quadraticCurveTo(310, 215, 395, 200); ctx.lineTo(320, 185); ctx.quadraticCurveTo(270, 185, 240, 205);
    ctx.closePath();
    shade(ctx, 300, 200, 80, darken(col, 0.25));
    // Teeth.
    ctx.fillStyle = '#f5ecd8';
    for (let i = 0; i < 9; i++) {
      const x = 260 + i * 16;
      ctx.beginPath(); ctx.moveTo(x, 160 + i * 0.8); ctx.lineTo(x + 5, 176); ctx.lineTo(x + 10, 160 + i * 0.8); ctx.fill();
      ctx.beginPath(); ctx.moveTo(x - 4, 200 - i * 0.8); ctx.lineTo(x + 1, 186); ctx.lineTo(x + 6, 200 - i * 0.8); ctx.fill();
    }
    // Spines.
    for (let i = 0; i < 6; i++) {
      const x = 150 + i * 22, y = 230 - i * 20;
      ctx.beginPath(); ctx.moveTo(x - 8, y); ctx.lineTo(x - 20, y - 40); ctx.lineTo(x + 8, y - 6); ctx.closePath();
      shade(ctx, x, y - 20, 20, darken(col, 0.4));
    }
    eye(ctx, 285, 132, 11, [255, 210, 40], { slit: true, glowA: 0.35 });
  },
  luminar(ctx, W, H, col) {
    sky(ctx, W, H, '#000000', '#140a00', 8);
    glow(ctx, 380, 60, 120, [255, 180, 60], 0.3);
    const R = rng('lum');
    for (let i = 0; i < 40; i++) {
      const t = i / 40;
      const x = 240 + Math.sin(t * 9 + R()) * 50 * (1 - t);
      const y = 300 - t * 250;
      glow(ctx, x, y, 70 * (1 - t * 0.6), mix([255, 120, 20], hex('#ffe890'), t), 0.25);
    }
    glow(ctx, 240, 150, 60, [255, 255, 220], 0.9);
    for (let k = 0; k < 2; k++) {
      const s = k ? 1 : -1;
      for (let i = 0; i < 16; i++) glow(ctx, 240 + s * (20 + i * 8), 170 - Math.sin(i / 5) * 40, 22 - i, [255, 200, 90], 0.3);
    }
    void col;
  },
  cthari(ctx, W, H, col) {
    sky(ctx, W, H, '#8fd0ff', '#d8f0c8', 9);
    ground(ctx, W, H, 250, '#4a8a3a', '#1a3a14', 9, 10);
    // Trunk body.
    ctx.beginPath();
    ctx.moveTo(200, 320); ctx.bezierCurveTo(210, 240, 190, 170, 215, 110); ctx.lineTo(265, 110); ctx.bezierCurveTo(290, 170, 270, 240, 280, 320);
    ctx.closePath();
    shade(ctx, 240, 220, 110, [110, 80, 50], { rim: [200, 255, 150] });
    texture(ctx, W, H, 9, 0.3, 0.12);
    // Branch arms.
    limb(ctx, [[220, 170], [170, 150], [120, 110], [95, 70]], 12, 3, [100, 70, 40]);
    limb(ctx, [[262, 165], [320, 140], [360, 100], [390, 60]], 12, 3, [100, 70, 40]);
    // Leaf crown.
    const R = rng('cth');
    for (let i = 0; i < 26; i++) blob(ctx, 240 + (R() - 0.5) * 190, 80 + (R() - 0.5) * 90, 16 + R() * 20, mix(col, [30, 100, 30], R() * 0.6), { seed: i, wobble: 0.2 });
    glowEye(ctx, 228, 150, 5, [220, 255, 120]);
    glowEye(ctx, 254, 150, 5, [220, 255, 120]);
  },
  brool(ctx, W, H, col) {
    sky(ctx, W, H, '#2a1206', '#6a3410', 10);
    for (let i = 0; i < 8; i++) glow(ctx, 30 + i * 62, 40 + (i % 2) * 20, 28, [255, 190, 90], 0.5);
    const R = rng('brool');
    for (let i = 0; i < 8; i++) {
      const a = Math.PI * (0.15 + (i / 7) * 0.7);
      const x0 = 240 + Math.cos(a) * 50, y0 = 175 + Math.sin(a) * 20;
      limb(ctx, [[x0, y0], [x0 + Math.cos(a) * 60, y0 + 50], [x0 + Math.cos(a) * 120 + (R() - 0.5) * 40, y0 + 70 + R() * 40]], 14, 4, darken(col, 0.15));
    }
    for (const [x, y] of [[110, 260], [370, 255], [300, 290]] as const) {
      ellipse(ctx, x, y, 14, 14);
      shade(ctx, x, y, 14, [255, 215, 90], { gloss: 0.7 });
    }
    blob(ctx, 240, 120, 80, col, { squash: 1.05, rim: [255, 220, 170], gloss: 0.35 });
    texture(ctx, W, H, 10, 0.08, 0.1);
    eye(ctx, 212, 130, 14, [80, 50, 20], { lid: 0.8 });
    eye(ctx, 268, 130, 14, [80, 50, 20], { lid: 0.8 });
  },
  nyx(ctx, W, H) {
    sky(ctx, W, H, '#040406', '#12141c', 11);
    const R = rng('nyx');
    for (let i = 0; i < 60; i++) {
      const x = 240 + (R() - 0.5) * 220, y = 170 + (R() - 0.5) * 220 * R();
      const g = ctx.createRadialGradient(x, y, 0, x, y, 60);
      g.addColorStop(0, 'rgba(0,0,0,0.5)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - 60, y - 60, 120, 120);
    }
    for (let i = 0; i < 30; i++) {
      const g2 = ctx.createRadialGradient(240, 170, 20, 240, 170, 200);
      g2.addColorStop(0, 'rgba(90,95,120,0.02)');
      g2.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g2;
      ctx.fillRect(0, 0, W, H);
    }
    for (let i = 0; i < 9; i++) glowEye(ctx, 170 + R() * 140, 110 + R() * 110, 2 + R() * 3, [220, 225, 255]);
  },
  oorm(ctx, W, H, col) {
    sky(ctx, W, H, '#0a2010', '#3a6a2a', 12, '#b5e36b');
    ground(ctx, W, H, 280, '#2a4a1a', '#0a1a06', 12, 6);
    const R = rng('oorm');
    for (let t = 0; t < 4; t++) {
      const x = 110 + t * 90 + (R() - 0.5) * 20, top = 90 + R() * 50;
      for (let k = 0; k < 3; k++) limb(ctx, [[x, 250], [x - 30 + k * 30, 280], [x - 50 + k * 50, 305]], 7, 2, [90, 70, 40]);
      limb(ctx, [[x, 260], [x + (R() - 0.5) * 20, (260 + top) / 2], [x, top]], 14, 7, [110, 85, 50]);
      for (let i = 0; i < 8; i++) blob(ctx, x + (R() - 0.5) * 80, top - 10 + (R() - 0.5) * 40, 16 + R() * 14, mix(col, [40, 120, 40], R() * 0.5), { seed: t * 10 + i, wobble: 0.2 });
    }
    for (let i = 0; i < 30; i++) glow(ctx, R() * W, R() * H * 0.8, 3, [230, 255, 150], 0.7);
  },
  veyl(ctx, W, H, col) {
    sky(ctx, W, H, '#040c18', '#0c2a40', 13, '#9fe6ff');
    const R = rng('veyl');
    const eyes: [number, number, number][] = [[240, 150, 46]];
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      eyes.push([240 + Math.cos(a) * (110 + R() * 30), 150 + Math.sin(a) * (70 + R() * 20), 16 + R() * 14]);
    }
    ctx.strokeStyle = 'rgba(160,230,255,0.5)';
    ctx.lineWidth = 2;
    for (const [x, y] of eyes.slice(1)) {
      ctx.beginPath();
      ctx.moveTo(240, 150);
      ctx.quadraticCurveTo((x + 240) / 2 + 20, (y + 150) / 2 - 20, x, y);
      ctx.stroke();
    }
    for (const [x, y, r] of eyes) {
      glow(ctx, x, y, r * 2.2, hex('#9fe6ff'), 0.25);
      eye(ctx, x, y, r, mix(col, [40, 80, 200], 0.4), { white: [220, 235, 245] });
    }
  },
  kritach(ctx, W, H, col) {
    sky(ctx, W, H, '#1a1204', '#4a3a10', 14);
    // Hexagonal hive walls.
    ctx.strokeStyle = 'rgba(255,210,90,0.15)';
    ctx.lineWidth = 2;
    for (let y = 0; y < H; y += 34) for (let x = (y / 34) % 2 ? 20 : 0; x < W; x += 40) {
      ctx.beginPath();
      for (let k = 0; k < 6; k++) ctx.lineTo(x + Math.cos((k / 6) * Math.PI * 2) * 18, y + Math.sin((k / 6) * Math.PI * 2) * 18);
      ctx.closePath();
      ctx.stroke();
    }
    // Antennae.
    limb(ctx, [[220, 80], [180, 40], [140, 20]], 4, 1.5, darken(col, 0.3));
    limb(ctx, [[260, 80], [300, 40], [340, 20]], 4, 1.5, darken(col, 0.3));
    // Head carapace plates.
    blob(ctx, 240, 150, 86, col, { squash: 0.95, rim: [255, 240, 150], gloss: 0.4, wobble: 0.03 });
    ctx.strokeStyle = rgba(darken(col, 0.6), 0.8);
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(240, 70); ctx.lineTo(240, 150); ctx.stroke();
    // Compound eyes.
    for (const s of [-1, 1]) {
      ellipse(ctx, 240 + s * 50, 130, 30, 38, s * 0.3);
      shade(ctx, 240 + s * 50, 130, 34, [40, 80, 40], { gloss: 0.5 });
      ctx.fillStyle = 'rgba(160,255,160,0.25)';
      for (let i = 0; i < 20; i++) { ellipse(ctx, 240 + s * 50 + ((i % 5) - 2) * 9, 110 + Math.floor(i / 5) * 12, 3, 3); ctx.fill(); }
    }
    // Mandibles.
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(240 + s * 20, 210); ctx.quadraticCurveTo(240 + s * 70, 250, 240 + s * 20, 290); ctx.lineTo(240 + s * 30, 250); ctx.closePath();
      shade(ctx, 240 + s * 40, 250, 40, darken(col, 0.35), { gloss: 0.3 });
    }
  },
  ferrovox(ctx, W, H, col) {
    sky(ctx, W, H, '#05080c', '#1a2430', 15);
    ctx.strokeStyle = 'rgba(120,160,200,0.08)';
    for (let x = 0; x < W; x += 24) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    // Neck cables.
    for (let i = 0; i < 5; i++) limb(ctx, [[200 + i * 20, 330], [205 + i * 18, 270], [215 + i * 12, 230]], 7, 5, [60, 70, 80]);
    // Head plates.
    ctx.beginPath();
    ctx.moveTo(160, 90); ctx.lineTo(320, 90); ctx.lineTo(340, 170); ctx.lineTo(300, 235); ctx.lineTo(180, 235); ctx.lineTo(140, 170);
    ctx.closePath();
    shade(ctx, 240, 160, 110, col, { rim: [200, 230, 255], gloss: 0.25 });
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(150, 150); ctx.lineTo(330, 150); ctx.moveTo(240, 90); ctx.lineTo(240, 130); ctx.stroke();
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    for (const [x, y] of [[170, 105], [310, 105], [190, 220], [290, 220]]) { ellipse(ctx, x, y, 4, 4); ctx.fill(); }
    // Visor.
    ctx.beginPath();
    ctx.moveTo(170, 160); ctx.lineTo(310, 160); ctx.lineTo(300, 188); ctx.lineTo(180, 188); ctx.closePath();
    ctx.fillStyle = '#081018';
    ctx.fill();
    for (let i = 0; i < 6; i++) glow(ctx, 190 + i * 20, 174, 18, [90, 220, 255], 0.5);
    limb(ctx, [[300, 92], [320, 50], [330, 20]], 3, 2, [150, 160, 170], { tipGlow: [255, 80, 80] });
  },
  sessari(ctx, W, H, col) {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#0a4a5a');
    g.addColorStop(1, '#021418');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    for (let i = 0; i < 6; i++) {
      ctx.fillStyle = 'rgba(160,240,255,0.05)';
      ctx.beginPath(); ctx.moveTo(60 + i * 80, 0); ctx.lineTo(90 + i * 80, 0); ctx.lineTo(40 + i * 90, H); ctx.lineTo(20 + i * 90, H); ctx.fill();
    }
    ground(ctx, W, H, 280, '#1a3a3a', '#051010', 16, 8);
    const R = rng('sess');
    const branch = (x: number, y: number, a: number, len: number, w: number, d: number) => {
      if (d > 5 || len < 8) {
        glow(ctx, x, y, 8, [255, 180, 200], 0.6);
        return;
      }
      const x2 = x + Math.cos(a) * len, y2 = y + Math.sin(a) * len;
      limb(ctx, [[x, y], [x2, y2]], w, w * 0.7, mix(col, [255, 120, 140], d / 6), { segments: 10 });
      branch(x2, y2, a - 0.4 - R() * 0.3, len * 0.78, w * 0.7, d + 1);
      branch(x2, y2, a + 0.4 + R() * 0.3, len * 0.78, w * 0.7, d + 1);
    };
    branch(240, 290, -Math.PI / 2, 60, 12, 0);
    branch(130, 300, -Math.PI / 2 - 0.2, 40, 8, 1);
    branch(360, 300, -Math.PI / 2 + 0.2, 45, 8, 1);
    for (let i = 0; i < 24; i++) {
      const x = R() * W, y = R() * H, r = 2 + R() * 5;
      ellipse(ctx, x, y, r, r);
      ctx.strokeStyle = 'rgba(200,255,255,0.4)';
      ctx.stroke();
    }
    eye(ctx, 222, 150, 9, [20, 120, 140], { white: [220, 255, 240] });
    eye(ctx, 258, 150, 9, [20, 120, 140], { white: [220, 255, 240] });
  },
  aeolin(ctx, W, H, col) {
    sky(ctx, W, H, '#2a1a4a', '#8a6ab0', 17);
    const R = rng('aeo');
    const puffs: [number, number, number][] = [];
    for (let i = 0; i < 16; i++) puffs.push([240 + (R() - 0.5) * 240, 150 + (R() - 0.5) * 90, 30 + R() * 36]);
    puffs.sort((a, b) => a[1] - b[1]);
    for (const [x, y, r] of puffs) blob(ctx, x, y, r, mix(col, [255, 255, 255], 0.3), { wobble: 0.12, seed: x, rim: [255, 230, 255], alpha: 0.9 });
    // Lightning.
    ctx.strokeStyle = 'rgba(255,255,220,0.95)';
    ctx.lineWidth = 3;
    for (let k = 0; k < 2; k++) {
      let x = 200 + k * 90, y = 200;
      ctx.beginPath();
      ctx.moveTo(x, y);
      while (y < 320) { x += (R() - 0.5) * 40; y += 18 + R() * 14; ctx.lineTo(x, y); }
      ctx.stroke();
      glow(ctx, 200 + k * 90, 220, 60, [255, 255, 200], 0.3);
    }
    glowEye(ctx, 215, 145, 7, [255, 255, 255]);
    glowEye(ctx, 268, 145, 7, [255, 255, 255]);
  },
  ouroth(ctx, W, H, col) {
    sky(ctx, W, H, '#2a1206', '#c07a3a', 18);
    ground(ctx, W, H, 250, '#a0602a', '#3a1a08', 18, 16);
    // Coils.
    for (let k = 3; k >= 0; k--) {
      const r = 60 + k * 26;
      const pts: [number, number][] = [];
      for (let i = 0; i <= 12; i++) {
        const a = (i / 12) * Math.PI * 2 + k;
        pts.push([240 + Math.cos(a) * r, 250 + Math.sin(a) * r * 0.3]);
      }
      limb(ctx, pts, 20 - k * 2, 20 - k * 2, darken(col, k * 0.08), { segments: 60 });
    }
    // Rising neck and head.
    limb(ctx, [[260, 240], [290, 190], [270, 130], [230, 100]], 22, 16, col, { segments: 50 });
    blob(ctx, 210, 95, 34, col, { squash: 0.7, rim: [255, 220, 150], wobble: 0.03 });
    texture(ctx, W, H, 18, 0.2, 0.2);
    // Scale pattern.
    ctx.strokeStyle = rgba(darken(col, 0.5), 0.5);
    for (let i = 0; i < 14; i++) { ctx.beginPath(); ctx.arc(250 + (i % 4) * 10, 130 + i * 8, 6, 0, Math.PI); ctx.stroke(); }
    eye(ctx, 198, 88, 8, [120, 200, 60], { slit: true, lid: 0.55, glowA: 0.3 });
  },
  myccor(ctx, W, H, col) {
    sky(ctx, W, H, '#06040a', '#1a0f1a', 19, '#e07a5f');
    ground(ctx, W, H, 265, '#1a0f0a', '#060302', 19, 8);
    const R = rng('myc');
    const shrooms: [number, number, number][] = [[240, 250, 80], [140, 262, 46], [340, 258, 54], [80, 272, 28], [410, 270, 32], [190, 278, 24]];
    for (const [x, y, s] of shrooms) {
      limb(ctx, [[x, y + 20], [x + (R() - 0.5) * 10, y - s * 0.6], [x, y - s * 1.1]], s * 0.14, s * 0.1, [220, 210, 190], { segments: 16 });
      ctx.beginPath();
      ctx.ellipse(x, y - s * 1.1, s * 0.75, s * 0.45, 0, Math.PI, 0);
      ctx.closePath();
      shade(ctx, x, y - s * 1.2, s * 0.7, col, { gloss: 0.4, rim: [255, 200, 180] });
      for (let i = 0; i < 6; i++) { ellipse(ctx, x + (R() - 0.5) * s, y - s * 1.2 - R() * s * 0.25, s * 0.06, s * 0.05); ctx.fillStyle = 'rgba(255,240,220,0.8)'; ctx.fill(); }
      glow(ctx, x, y - s, s * 0.9, [255, 140, 110], 0.25);
    }
    for (let i = 0; i < 60; i++) glow(ctx, R() * W, R() * H * 0.9, 2 + R() * 3, [255, 190, 160], 0.6);
  },
  carapax(ctx, W, H, col) {
    sky(ctx, W, H, '#020816', '#0a2040', 20);
    ground(ctx, W, H, 270, '#1a2a3a', '#050a10', 20, 10);
    // Legs.
    for (const s of [-1, 1]) for (let i = 0; i < 3; i++) limb(ctx, [[240 + s * 70, 230], [240 + s * (120 + i * 25), 220 - i * 10], [240 + s * (150 + i * 30), 290]], 9, 5, darken(col, 0.35));
    // Claws.
    for (const s of [-1, 1]) {
      limb(ctx, [[240 + s * 80, 190], [240 + s * 130, 150], [240 + s * 150, 110]], 18, 16, darken(col, 0.15));
      ctx.beginPath();
      ctx.moveTo(240 + s * 140, 110); ctx.quadraticCurveTo(240 + s * 210, 40, 240 + s * 170, 60); ctx.quadraticCurveTo(240 + s * 180, 90, 240 + s * 160, 100);
      ctx.closePath();
      shade(ctx, 240 + s * 170, 80, 40, col, { gloss: 0.5, rim: [180, 220, 255] });
      ctx.beginPath();
      ctx.moveTo(240 + s * 150, 118); ctx.quadraticCurveTo(240 + s * 220, 110, 240 + s * 205, 80); ctx.quadraticCurveTo(240 + s * 190, 110, 240 + s * 158, 112);
      ctx.closePath();
      shade(ctx, 240 + s * 190, 105, 30, darken(col, 0.2), { gloss: 0.3 });
    }
    // Shell.
    blob(ctx, 240, 200, 95, col, { squash: 0.62, gloss: 0.45, rim: [180, 220, 255], wobble: 0.04 });
    ctx.strokeStyle = rgba(darken(col, 0.6), 0.6);
    ctx.lineWidth = 2;
    for (let i = 1; i < 4; i++) { ctx.beginPath(); ctx.ellipse(240, 205, 95 - i * 18, 58 - i * 12, 0, Math.PI * 1.1, Math.PI * 1.9); ctx.stroke(); }
    for (const s of [-1, 1]) {
      limb(ctx, [[240 + s * 20, 150], [240 + s * 26, 125]], 3, 3, darken(col, 0.3));
      eye(ctx, 240 + s * 26, 120, 8, [20, 20, 40]);
    }
  },
  quorin(ctx, W, H, col) {
    sky(ctx, W, H, '#140612', '#40183a', 21, '#ffa0c8');
    const R = rng('quo');
    const shapes: [number, number, number, number][] = [[240, 150, 70, 0]];
    for (let i = 0; i < 6; i++) shapes.push([240 + Math.cos(i * 1.05) * 140, 150 + Math.sin(i * 1.05) * 80, 20 + R() * 20, i + 1]);
    ctx.strokeStyle = 'rgba(255,190,220,0.35)';
    for (const [x, y] of shapes.slice(1)) { ctx.beginPath(); ctx.moveTo(240, 150); ctx.lineTo(x, y); ctx.stroke(); }
    for (const [x, y, r, k] of shapes) {
      const sides = 3 + (k % 4);
      ctx.beginPath();
      for (let i = 0; i < sides; i++) {
        const a = (i / sides) * Math.PI * 2 - Math.PI / 2 + k * 0.3;
        ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
      }
      ctx.closePath();
      shade(ctx, x, y, r, col, { alpha: 0.8, rim: [255, 255, 255], gloss: 0.3 });
      ctx.strokeStyle = 'rgba(255,230,245,0.9)';
      ctx.lineWidth = 2;
      ctx.stroke();
      glow(ctx, x, y, r * 1.3, [255, 180, 220], 0.35);
    }
    glowEye(ctx, 240, 150, 10, [255, 255, 255]);
  },
};

const cache = new Map<string, string>();

/** Data URL of a species portrait. Size is the output width; aspect is 3:2. */
export function portraitUrl(speciesId: string, color: string, width = 480): string {
  const key = `${speciesId}:${color}:${width}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const W = 480, H = 320;
  const c = document.createElement('canvas');
  c.width = width;
  c.height = Math.round((width * H) / W);
  const ctx = c.getContext('2d')!;
  ctx.scale(width / W, width / W);
  const col = hex(color);
  const recipe = RECIPES[speciesId];
  if (recipe) recipe(ctx, W, H, col);
  else {
    sky(ctx, W, H, '#05060c', '#1a2040', 0);
    blob(ctx, 240, 160, 90, col, { gloss: 0.4 });
  }
  texture(ctx, W, H, speciesId.length * 13, 0.1, 0.03);
  vignette(ctx, W, H, col);
  const url = c.toDataURL('image/png');
  cache.set(key, url);
  return url;
}

export const PORTRAIT_SPECIES = Object.keys(RECIPES);

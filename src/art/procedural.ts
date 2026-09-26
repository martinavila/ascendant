// Procedural, resolution-independent art. Everything is rendered once to a
// canvas and cached, so it looks crisp at any zoom (unlike the original's
// 320x200 sprites) and needs no copyrighted assets.

import { PLANET_TYPE } from '../sim/content';
import type { StarClass } from '../sim/types';

// --- noise -------------------------------------------------------------------

function hash3(x: number, y: number, z: number, seed: number) {
  let h = seed ^ Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function smooth(t: number) {
  return t * t * (3 - 2 * t);
}

function noise3(x: number, y: number, z: number, seed: number) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = smooth(x - xi), yf = smooth(y - yi), zf = smooth(z - zi);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  const c = (dx: number, dy: number, dz: number) => hash3(xi + dx, yi + dy, zi + dz, seed);
  return l(
    l(l(c(0, 0, 0), c(1, 0, 0), xf), l(c(0, 1, 0), c(1, 1, 0), xf), yf),
    l(l(c(0, 0, 1), c(1, 0, 1), xf), l(c(0, 1, 1), c(1, 1, 1), xf), yf),
    zf,
  );
}

function fbm(x: number, y: number, z: number, seed: number, oct = 5) {
  let a = 0.5, f = 1, s = 0, n = 0;
  for (let i = 0; i < oct; i++) {
    s += a * noise3(x * f, y * f, z * f, seed + i * 17);
    n += a;
    a *= 0.5;
    f *= 2.03;
  }
  return s / n;
}

type RGB = [number, number, number];
const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

function ramp(stops: [number, string][], t: number): RGB {
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1], [t1, c1] = stops[i];
      const k = (t - t0) / (t1 - t0 || 1);
      const a = hex(c0), b = hex(c1);
      return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
    }
  }
  return hex(stops[stops.length - 1][1]);
}

const PALETTES: Record<string, { stops: [number, string][]; atmo: string; bands?: boolean; clouds?: number; scale: number }> = {
  rock: { stops: [[0, '#2b2622'], [0.45, '#6b5e52'], [0.7, '#a39380'], [1, '#d6c8b4']], atmo: '#c9b9a0', scale: 2.4 },
  lava: { stops: [[0, '#1a0a06'], [0.4, '#3d1a10'], [0.55, '#7a2a12'], [0.62, '#ff6a1a'], [0.7, '#3a1a12'], [1, '#6e5a50']], atmo: '#ff7a3a', scale: 2.2 },
  ocean: { stops: [[0, '#08204a'], [0.5, '#15528f'], [0.58, '#2f8fb8'], [0.62, '#d9c98f'], [0.72, '#4f8f3a'], [1, '#e8f0f0']], atmo: '#7fc8ff', clouds: 0.5, scale: 2 },
  terran: { stops: [[0, '#0a2a5a'], [0.48, '#1d5ea3'], [0.53, '#d8c890'], [0.6, '#3f8a3a'], [0.78, '#6a7a3a'], [0.9, '#8a8070'], [1, '#f4f4f4']], atmo: '#8fd0ff', clouds: 0.45, scale: 2.1 },
  jungle: { stops: [[0, '#0c3a4a'], [0.4, '#1f6f5f'], [0.46, '#2f8a2a'], [0.75, '#6ab83a'], [1, '#d8f08a']], atmo: '#a8ffb0', clouds: 0.55, scale: 2.3 },
  ice: { stops: [[0, '#6a8aa8'], [0.5, '#a8c8e0'], [0.75, '#e0f0ff'], [1, '#ffffff']], atmo: '#d0f0ff', scale: 2.6 },
  gas: { stops: [[0, '#6a4a2a'], [0.3, '#c89a5a'], [0.5, '#f0d8a8'], [0.7, '#b8784a'], [1, '#f8e8c8']], atmo: '#ffe0b0', bands: true, scale: 1.4 },
  crystal: { stops: [[0, '#1a0f3a'], [0.4, '#4a3aa8'], [0.6, '#8a7af0'], [0.8, '#c8b8ff'], [1, '#f0e8ff']], atmo: '#b8a0ff', scale: 3.2 },
  desert: { stops: [[0, '#4a2a14'], [0.4, '#a8622a'], [0.7, '#e0a060'], [1, '#f8e0b0']], atmo: '#ffc890', scale: 2.2 },
  toxic: { stops: [[0, '#1a2a08'], [0.4, '#5a7a18'], [0.6, '#a8c82a'], [0.8, '#d8e870'], [1, '#f0f8c0']], atmo: '#d0ff60', clouds: 0.6, scale: 2.4 },
  gold: { stops: [[0, '#2a1a4a'], [0.35, '#3a6aa8'], [0.5, '#e8c85a'], [0.65, '#5ab86a'], [0.85, '#c85ab8'], [1, '#ffffff']], atmo: '#ffe890', clouds: 0.35, scale: 2.2 },
};

const cache = new Map<string, HTMLCanvasElement>();

function mkCanvas(w: number, h = w) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** A lit sphere for a planet type. `seed` varies the continents. */
export function planetCanvas(type: string, seed: number, size = 128): HTMLCanvasElement {
  const key = `p:${type}:${seed}:${size}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const pt = PLANET_TYPE[type];
  const pal = PALETTES[pt?.palette ?? 'rock'];
  const c = mkCanvas(size);
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const r = size / 2 - 2;
  const L = [-0.55, -0.45, 0.7];
  const ll = Math.hypot(...L);
  const atmo = hex(pal.atmo);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - size / 2 + 0.5) / r, dy = (y - size / 2 + 0.5) / r;
      const d2 = dx * dx + dy * dy;
      const i = (y * size + x) * 4;
      if (d2 > 1) {
        // Atmospheric halo.
        const d = Math.sqrt(d2);
        if (d < 1.08) {
          const a = (1 - (d - 1) / 0.08) ** 2 * 120;
          img.data[i] = atmo[0]; img.data[i + 1] = atmo[1]; img.data[i + 2] = atmo[2]; img.data[i + 3] = a;
        }
        continue;
      }
      const dz = Math.sqrt(1 - d2);
      const s = pal.scale;
      let n: number;
      if (pal.bands) {
        const turb = fbm(dx * 2, dy * 6, dz * 2, seed, 4);
        n = 0.5 + 0.5 * Math.sin(dy * 9 + turb * 5 + seed % 7);
        n = n * 0.7 + fbm(dx * 4, dy * 12, dz * 4, seed + 5, 3) * 0.3;
      } else {
        n = fbm(dx * s + 10, dy * s + 10, dz * s + 10, seed);
        n = Math.pow(n, 1.1) * 1.15 - 0.05;
      }
      let col = ramp(pal.stops, n);
      if (pal.clouds) {
        const cl = fbm(dx * 3 + 40, dy * 5 + 40, dz * 3 + 40, seed + 99, 4);
        const k = Math.max(0, (cl - (1 - pal.clouds)) / pal.clouds) * 0.85;
        col = [col[0] + (255 - col[0]) * k, col[1] + (255 - col[1]) * k, col[2] + (255 - col[2]) * k];
      }
      const lambert = Math.max(0, (dx * L[0] + dy * L[1] + dz * L[2]) / ll);
      const light = 0.12 + 0.95 * Math.pow(lambert, 0.85);
      const rim = Math.pow(1 - dz, 3) * 0.6;
      img.data[i] = Math.min(255, col[0] * light + atmo[0] * rim * lambert);
      img.data[i + 1] = Math.min(255, col[1] * light + atmo[1] * rim * lambert);
      img.data[i + 2] = Math.min(255, col[2] * light + atmo[2] * rim * lambert);
      // Soft anti-aliased edge.
      const edge = Math.min(1, (1 - Math.sqrt(d2)) * r);
      img.data[i + 3] = 255 * edge;
    }
  }
  ctx.putImageData(img, 0, 0);
  cache.set(key, c);
  return c;
}

const planetUrlCache = new Map<string, string>();
export function planetUrl(type: string, seed: number, size = 128) {
  const key = `${type}:${seed}:${size}`;
  let u = planetUrlCache.get(key);
  if (!u) {
    u = planetCanvas(type, seed, size).toDataURL();
    planetUrlCache.set(key, u);
  }
  return u;
}

export const STAR_COLORS: Record<StarClass, string> = {
  O: '#9bb0ff', B: '#aabfff', A: '#cad7ff', F: '#f8f7ff', G: '#fff4b0', K: '#ffd08a', M: '#ff9a6a', WD: '#e8f0ff', NS: '#a0e8ff', BH: '#6a4aa0',
};

export const STAR_LABEL: Record<StarClass, string> = {
  O: 'Blue giant (O)', B: 'Blue-white (B)', A: 'White (A)', F: 'Yellow-white (F)', G: 'Yellow dwarf (G)', K: 'Orange dwarf (K)', M: 'Red dwarf (M)',
  WD: 'White dwarf', NS: 'Neutron star', BH: 'Black hole',
};

/** Glowing star sprite (white core, colored corona, optional spikes). */
export function starCanvas(cls: StarClass, size = 64): HTMLCanvasElement {
  const key = `s:${cls}:${size}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const c = mkCanvas(size);
  const ctx = c.getContext('2d')!;
  const m = size / 2;
  const col = STAR_COLORS[cls];
  if (cls === 'BH') {
    const g = ctx.createRadialGradient(m, m, size * 0.08, m, m, m);
    g.addColorStop(0, '#000');
    g.addColorStop(0.2, '#000');
    g.addColorStop(0.28, '#d8a8ff');
    g.addColorStop(0.45, 'rgba(120,70,200,0.5)');
    g.addColorStop(1, 'rgba(60,20,120,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  } else {
    const g = ctx.createRadialGradient(m, m, 0, m, m, m);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.12, '#ffffff');
    g.addColorStop(0.22, col);
    g.addColorStop(0.45, col + '55');
    g.addColorStop(1, col + '00');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = col + '66';
    ctx.lineWidth = size / 64;
    for (const a of [0, Math.PI / 2]) {
      ctx.beginPath();
      ctx.moveTo(m + Math.cos(a) * m * 0.95, m + Math.sin(a) * m * 0.95);
      ctx.lineTo(m - Math.cos(a) * m * 0.95, m - Math.sin(a) * m * 0.95);
      ctx.stroke();
    }
  }
  cache.set(key, c);
  return c;
}

/** Big, soft sun for the system view. */
export function sunCanvas(cls: StarClass, size = 256): HTMLCanvasElement {
  const key = `sun:${cls}:${size}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const c = mkCanvas(size);
  const ctx = c.getContext('2d')!;
  const m = size / 2;
  const col = hex(STAR_COLORS[cls]);
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = (x - m) / (m * 0.5), dy = (y - m) / (m * 0.5);
    const d = Math.hypot(dx, dy);
    const i = (y * size + x) * 4;
    if (cls === 'BH') {
      const ring = Math.exp(-((d - 1.05) ** 2) / 0.01);
      const a = d < 0.95 ? 255 : Math.min(255, ring * 255 + Math.max(0, 1 - d / 2) * 60);
      img.data[i] = d < 0.95 ? 0 : 200; img.data[i + 1] = d < 0.95 ? 0 : 140; img.data[i + 2] = d < 0.95 ? 0 : 255; img.data[i + 3] = a;
      continue;
    }
    if (d < 1) {
      const n = fbm(dx * 4, dy * 4, Math.sqrt(1 - d * d) * 4, 7, 4);
      const limb = 0.75 + 0.25 * Math.sqrt(1 - d * d);
      const k = (0.85 + n * 0.3) * limb;
      img.data[i] = Math.min(255, (col[0] * 0.6 + 110) * k);
      img.data[i + 1] = Math.min(255, (col[1] * 0.6 + 100) * k);
      img.data[i + 2] = Math.min(255, (col[2] * 0.6 + 90) * k);
      img.data[i + 3] = 255;
    } else {
      const glow = Math.exp(-(d - 1) * 2.4);
      img.data[i] = col[0]; img.data[i + 1] = col[1]; img.data[i + 2] = col[2]; img.data[i + 3] = glow * 170;
    }
  }
  ctx.putImageData(img, 0, 0);
  cache.set(key, c);
  return c;
}

/** Large tiling nebula backdrop for the galaxy map. */
export function nebulaCanvas(seed: number, size = 1024): HTMLCanvasElement {
  const key = `neb:${seed}:${size}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const c = mkCanvas(size);
  const ctx = c.getContext('2d')!;
  const small = 256;
  const img = ctx.createImageData(small, small);
  const hues: RGB[] = [[70, 40, 140], [30, 80, 150], [140, 40, 90], [30, 110, 120]];
  const a = hues[seed % hues.length], b = hues[(seed + 1) % hues.length];
  for (let y = 0; y < small; y++) for (let x = 0; x < small; x++) {
    const u = x / small, v = y / small;
    // Tileable by sampling a torus.
    const nx = Math.cos(u * Math.PI * 2) * 1.2, ny = Math.sin(u * Math.PI * 2) * 1.2;
    const nz = Math.cos(v * Math.PI * 2) * 1.2, nw = Math.sin(v * Math.PI * 2) * 1.2;
    const n = fbm(nx + nz * 0.7, ny + nw * 0.7, nz - nw * 0.5, seed, 6);
    const m = fbm(nx * 2 + 5, ny * 2 + 5, nw * 2, seed + 3, 4);
    const k = Math.max(0, n - 0.45) * 2.4;
    const i = (y * small + x) * 4;
    img.data[i] = a[0] * k * (1 - m) + b[0] * k * m;
    img.data[i + 1] = a[1] * k * (1 - m) + b[1] * k * m;
    img.data[i + 2] = a[2] * k * (1 - m) + b[2] * k * m;
    img.data[i + 3] = 255;
  }
  const tmp = mkCanvas(small);
  tmp.getContext('2d')!.putImageData(img, 0, 0);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(tmp, 0, 0, size, size);
  // Dust of faint background stars.
  let h = seed * 9301 + 49297;
  const rnd = () => ((h = (h * 9301 + 49297) % 233280) / 233280);
  for (let i = 0; i < 900; i++) {
    const x = rnd() * size, y = rnd() * size, r = rnd() ** 3 * 1.4 + 0.2;
    ctx.fillStyle = `rgba(255,255,255,${0.15 + rnd() * 0.5})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  cache.set(key, c);
  return c;
}

/** Ship silhouette drawn as a path; scales with hull. Points right. */
export function shipPath(ctx: CanvasRenderingContext2D, hull: string, s: number, style: number) {
  const k = { small: 0.55, medium: 0.7, large: 0.85, enormous: 1, titan: 1.15, station: 0.9 }[hull] ?? 0.7;
  const L = s * k, W = s * k * (0.42 + (style % 3) * 0.08);
  ctx.beginPath();
  if (hull === 'station') {
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      ctx.lineTo(Math.cos(a) * L * 0.5, Math.sin(a) * L * 0.5);
    }
  } else if (style % 4 === 0) {
    ctx.moveTo(L * 0.6, 0); ctx.lineTo(-L * 0.4, W * 0.5); ctx.lineTo(-L * 0.25, 0); ctx.lineTo(-L * 0.4, -W * 0.5);
  } else if (style % 4 === 1) {
    ctx.moveTo(L * 0.6, 0); ctx.lineTo(L * 0.1, W * 0.5); ctx.lineTo(-L * 0.45, W * 0.35); ctx.lineTo(-L * 0.45, -W * 0.35); ctx.lineTo(L * 0.1, -W * 0.5);
  } else if (style % 4 === 2) {
    ctx.ellipse(0, 0, L * 0.55, W * 0.4, 0, 0, Math.PI * 2);
  } else {
    ctx.moveTo(L * 0.6, 0); ctx.lineTo(0, W * 0.2); ctx.lineTo(-L * 0.3, W * 0.55); ctx.lineTo(-L * 0.45, 0); ctx.lineTo(-L * 0.3, -W * 0.55); ctx.lineTo(0, -W * 0.2);
  }
  ctx.closePath();
}

export function shipCanvas(hull: string, color: string, style: number, size = 48): HTMLCanvasElement {
  const key = `ship:${hull}:${color}:${style}:${size}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const c = mkCanvas(size);
  const ctx = c.getContext('2d')!;
  ctx.translate(size / 2, size / 2);
  shipPath(ctx, hull, size * 0.9, style);
  const g = ctx.createLinearGradient(0, -size / 3, 0, size / 3);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.35, color);
  g.addColorStop(1, '#101018');
  ctx.fillStyle = g;
  ctx.fill();
  ctx.lineWidth = Math.max(1, size / 40);
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.stroke();
  cache.set(key, c);
  return c;
}

const shipUrlCache = new Map<string, string>();
export function shipUrl(hull: string, color: string, style: number, size = 48) {
  const key = `${hull}:${color}:${style}:${size}`;
  let u = shipUrlCache.get(key);
  if (!u) shipUrlCache.set(key, (u = shipCanvas(hull, color, style, size).toDataURL()));
  return u;
}

/** Abstract species sigil (a stand-in portrait): symmetric glyph from the species id. */
export function sigilCanvas(id: string, color: string, size = 128): HTMLCanvasElement {
  const key = `sig:${id}:${color}:${size}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const c = mkCanvas(size);
  const ctx = c.getContext('2d')!;
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const rnd = () => ((h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0) / 4294967296);
  const m = size / 2;
  const bg = ctx.createRadialGradient(m, m * 0.8, 0, m, m, m);
  bg.addColorStop(0, color + '55');
  bg.addColorStop(1, '#05060c');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, size, size);
  const sym = 3 + Math.floor(rnd() * 5);
  ctx.translate(m, m);
  ctx.strokeStyle = color;
  ctx.fillStyle = color + '40';
  ctx.lineWidth = size / 42;
  ctx.lineJoin = 'round';
  const pts: [number, number][] = [];
  for (let i = 0; i < 4; i++) pts.push([rnd() * m * 0.8, (rnd() - 0.5) * m * 0.6]);
  for (let k = 0; k < sym; k++) {
    ctx.save();
    ctx.rotate((k / sym) * Math.PI * 2);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    for (const [x, y] of pts) ctx.lineTo(x, y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
  ctx.beginPath();
  ctx.arc(0, 0, m * (0.12 + rnd() * 0.1), 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();
  cache.set(key, c);
  return c;
}

const sigilUrls = new Map<string, string>();
export function sigilUrl(id: string, color: string, size = 128) {
  const key = `${id}:${color}:${size}`;
  let u = sigilUrls.get(key);
  if (!u) sigilUrls.set(key, (u = sigilCanvas(id, color, size).toDataURL()));
  return u;
}

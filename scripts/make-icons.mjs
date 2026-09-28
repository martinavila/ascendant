// Generates the PWA / home-screen icons in public/icons/ procedurally (no
// dependencies): a glowing planet with a tilted ring on a deep-space field,
// matching the favicon. Run with `node scripts/make-icons.mjs`.

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = resolve(dirname(fileURLToPath(import.meta.url)), '../public/icons');
mkdirSync(out, { recursive: true });

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const mix = (a, b, t) => a.map((x, i) => x + (b[i] - x) * t);
// Deterministic hash noise for background stars.
const hash = (x, y) => { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); };

/** `pad` shrinks the artwork (maskable icons need a safe zone). */
function draw(size, { pad = 0, round = false } = {}) {
  const buf = Buffer.alloc(size * size * 4);
  const SS = 3; // supersampling
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let acc = [0, 0, 0], alpha = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const u = ((px + (sx + 0.5) / SS) / size) * 2 - 1;
        const v = ((py + (sy + 0.5) / SS) / size) * 2 - 1;
        let a = 1;
        if (round) { const r = Math.hypot(u, v); a = clamp((1 - r) * size * 0.5); }
        // Background: deep navy with a violet nebula glow.
        const r0 = Math.hypot(u + 0.1, v - 0.15);
        let c = mix([3, 4, 12], [34, 26, 78], clamp(1 - r0 * 0.9) ** 2);
        c = mix(c, [20, 60, 110], clamp(1 - Math.hypot(u - 0.5, v + 0.55) * 1.4) ** 2 * 0.6);
        const G = 36, gx = Math.floor((u + 1) * G), gy = Math.floor((v + 1) * G);
        if (hash(gx, gy) > 0.93) {
          const cx = (gx + 0.2 + 0.6 * hash(gy, gx)) / G - 1, cy = (gy + 0.2 + 0.6 * hash(gx + 7, gy)) / G - 1;
          const sd = Math.hypot(u - cx, v - cy);
          c = mix(c, [220, 230, 255], clamp(1 - sd / (0.006 + 0.008 * hash(gx + 3, gy + 5))) * 0.9);
        }
        // Artwork space (scaled for maskable safe zone).
        const k = 1 / (1 - pad);
        const x = u * k, y = v * k;
        // Ring: tilted ellipse, drawn behind the planet on top half, in front on bottom half.
        const rot = -0.35, cr = Math.cos(rot), sr = Math.sin(rot);
        const rx = x * cr - y * sr, ry = (x * sr + y * cr) / 0.34;
        const rr = Math.hypot(rx, ry);
        const ringA = clamp(1 - Math.abs(rr - 0.8) / 0.075) * 0.95;
        const ringC = mix([180, 140, 255], [127, 220, 255], clamp((rx + 0.8) / 1.6));
        const behind = ry < 0;
        if (behind) c = mix(c, ringC, ringA);
        // Planet: shaded sphere with a cyan limb glow.
        const pr = 0.5, d = Math.hypot(x, y);
        const glow = clamp(1 - (d - pr) / 0.35) ** 2 * (d > pr ? 0.55 : 0);
        c = mix(c, [127, 220, 255], glow);
        if (d < pr) {
          const nz = Math.sqrt(1 - (d / pr) ** 2);
          const lx = -0.5, ly = -0.6, lz = 0.62;
          const lam = clamp((x / pr) * lx + (y / pr) * ly + nz * lz);
          const band = 0.5 + 0.5 * Math.sin((y / pr) * 9 + Math.sin((x / pr) * 3) * 1.2);
          let pc = mix([22, 70, 130], [110, 210, 255], lam);
          pc = mix(pc, [60, 140, 210], band * 0.25 * lam);
          pc = mix(pc, [200, 245, 255], clamp(lam - 0.8) * 2);
          const edge = clamp((pr - d) * size * 0.5);
          c = mix(c, pc, edge);
        }
        if (!behind) c = mix(c, ringC, ringA * (d < pr ? 1 : 1));
        acc = acc.map((q, i) => q + c[i] * a);
        alpha += a;
      }
      const n = SS * SS;
      const o = (py * size + px) * 4;
      const al = alpha / n;
      buf[o] = al ? Math.round(acc[0] / alpha) : 0;
      buf[o + 1] = al ? Math.round(acc[1] / alpha) : 0;
      buf[o + 2] = al ? Math.round(acc[2] / alpha) : 0;
      buf[o + 3] = Math.round(al * 255);
    }
  }
  return png(size, buf);
}

const files = [
  ['icon-192.png', draw(192)],
  ['icon-512.png', draw(512)],
  ['maskable-512.png', draw(512, { pad: 0.22 })],
  ['apple-touch-icon.png', draw(180)],
  ['favicon-32.png', draw(32, { round: true })],
];
for (const [name, data] of files) {
  writeFileSync(resolve(out, name), data);
  console.log('wrote', name, data.length, 'bytes');
}

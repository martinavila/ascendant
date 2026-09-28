import { Application, Container, Graphics, Sprite, Text, Texture, TilingSprite } from 'pixi.js';
import type { World } from '../sim/world';
import type { Fleet, StarId } from '../sim/types';
import { nebulaCanvas, starCanvas, STAR_COLORS } from '../art/procedural';
import { fleetVisible } from '../sim/visibility';
import { lowPower, renderPixelRatio, LONG_PRESS_MS, bottomOcclusion } from './device';

// WebGL galaxy map. Scales to thousands of stars: one sprite per star, lanes in
// a single Graphics redrawn only when ownership/exploration changes, labels
// created lazily and culled by zoom level.

export interface StarTap { button: number; double: boolean; touch?: boolean; long?: boolean; x?: number; y?: number }

export interface GalaxyCallbacks {
  /**
   * `touch`: the tap came from a finger/pen. `long`: a long-press (touch
   * equivalent of right-click). `x`/`y` are client coordinates of the tap.
   */
  onStar(star: StarId, e: StarTap): void;
  onFleet(fleet: number): void;
  onEmpty(): void;
  onHover(star: StarId | null, x: number, y: number): void;
}

interface StarView {
  sprite: Sprite;
  label?: Text;
  labelColor?: string;
  ring: Graphics;
  terr: Sprite;
}

function blobTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return Texture.from(c);
}

function chevronTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 48;
  const ctx = c.getContext('2d')!;
  ctx.translate(24, 24);
  ctx.beginPath();
  ctx.moveTo(16, 0);
  ctx.lineTo(-12, 12);
  ctx.lineTo(-6, 0);
  ctx.lineTo(-12, -12);
  ctx.closePath();
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(0,0,0,0.7)';
  ctx.stroke();
  return Texture.from(c);
}

export class GalaxyView {
  app = new Application();
  root = new Container();
  bg!: TilingSprite;
  terrLayer = new Container();
  laneLayer = new Graphics();
  routeLayer = new Graphics();
  starLayer = new Container();
  ringLayer = new Container();
  fleetLayer = new Container();
  labelLayer = new Container();
  selLayer = new Graphics();
  views: StarView[] = [];
  fleetSprites = new Map<number, Sprite>();
  w: World | null = null;
  viewer = 0;
  zoom = 0.5;
  cx = 0;
  cy = 0;
  private lastVersion = -1;
  private lastLaneKey = '';
  private blob!: Texture;
  private chevron!: Texture;
  private ready = false;
  private anim: { x: number; y: number; z: number; t0: number; from: { x: number; y: number; z: number } } | null = null;
  selStar: StarId | null = null;
  selFleet: number | null = null;
  hoverStar: StarId | null = null;
  routePreview: StarId[] | null = null;
  showLabels = true;
  keys = new Set<string>();

  constructor(private host: HTMLElement, private cb: GalaxyCallbacks) {}

  async init() {
    await this.app.init({ resizeTo: this.host, background: '#03040a', antialias: !lowPower(), resolution: renderPixelRatio(), autoDensity: true, preference: 'webgl' });
    this.host.appendChild(this.app.canvas);
    this.blob = blobTexture();
    this.chevron = chevronTexture();
    this.bg = new TilingSprite({ texture: Texture.from(nebulaCanvas(3)), width: 100, height: 100 });
    this.bg.alpha = 0.9;
    this.app.stage.addChild(this.bg, this.root);
    this.root.addChild(this.terrLayer, this.laneLayer, this.routeLayer, this.ringLayer, this.starLayer, this.selLayer, this.fleetLayer, this.labelLayer);
    this.app.ticker.add(() => this.frame());
    this.bindInput();
    this.ready = true;
    if (this.w) this.build();
  }

  destroy() {
    this.cancelLong();
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('keyup', this.onKeyUp);
    this.app.destroy(true, { children: true, texture: false });
  }

  setWorld(w: World, viewer: number) {
    this.w = w;
    this.viewer = viewer;
    if (this.ready) this.build();
  }

  private build() {
    const w = this.w!;
    for (const v of this.views) {
      v.sprite.destroy();
      v.label?.destroy();
      v.ring.destroy();
      v.terr.destroy();
    }
    this.views = [];
    this.fleetSprites.forEach((s) => s.destroy());
    this.fleetSprites.clear();
    const starTex = new Map<string, Texture>();
    for (const st of w.s.stars) {
      let tex = starTex.get(st.cls);
      if (!tex) starTex.set(st.cls, (tex = Texture.from(starCanvas(st.cls, 64))));
      const sprite = new Sprite(tex);
      sprite.anchor.set(0.5);
      sprite.position.set(st.x, st.y);
      const size = (st.cls === 'O' || st.cls === 'B' ? 60 : st.cls === 'M' || st.cls === 'WD' ? 34 : 44) * st.size;
      sprite.width = sprite.height = size;
      const terr = new Sprite(this.blob);
      terr.anchor.set(0.5);
      terr.position.set(st.x, st.y);
      terr.width = terr.height = 300;
      terr.visible = false;
      const ring = new Graphics();
      ring.position.set(st.x, st.y);
      this.terrLayer.addChild(terr);
      this.starLayer.addChild(sprite);
      this.ringLayer.addChild(ring);
      this.views.push({ sprite, ring, terr });
    }
    const xs = w.s.stars.map((s) => s.x), ys = w.s.stars.map((s) => s.y);
    this.bounds = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
    this.lastVersion = -1;
    this.lastLaneKey = '';
  }

  bounds = { x0: 0, x1: 0, y0: 0, y1: 0 };

  // --- camera -----------------------------------------------------------------

  focusOn(star: StarId, zoom?: number) {
    const st = this.w?.s.stars[star];
    if (!st) return;
    const z = zoom ?? Math.max(this.zoom, 0.6);
    // Keep the star in the visible part of the map when a bottom sheet covers it.
    const dy = bottomOcclusion() / 2 / z;
    this.anim = { x: st.x, y: st.y + dy, z, t0: performance.now(), from: { x: this.cx, y: this.cy, z: this.zoom } };
  }

  fitAll() {
    const b = this.bounds;
    const W = this.app.screen.width, H = this.app.screen.height;
    const z = Math.min(W / (b.x1 - b.x0 + 400), H / (b.y1 - b.y0 + 400));
    this.anim = { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2, z, t0: performance.now(), from: { x: this.cx, y: this.cy, z: this.zoom } };
  }

  screenToWorld(sx: number, sy: number) {
    const W = this.app.screen.width, H = this.app.screen.height;
    return { x: (sx - W / 2) / this.zoom + this.cx, y: (sy - H / 2) / this.zoom + this.cy };
  }

  worldToScreen(x: number, y: number) {
    const W = this.app.screen.width, H = this.app.screen.height;
    return { x: (x - this.cx) * this.zoom + W / 2, y: (y - this.cy) * this.zoom + H / 2 };
  }

  private clampZoom(z: number) {
    return Math.max(0.05, Math.min(3, z));
  }

  // --- input ------------------------------------------------------------------

  private pointers = new Map<number, { x: number; y: number }>();
  private dragDist = 0;
  private pinch: { d: number; mx: number; my: number } | null = null;
  private lastTap = { t: 0, star: -1 };
  private touch = false;
  private longTimer = 0;
  private longFired = false;

  private cancelLong() {
    if (this.longTimer) clearTimeout(this.longTimer);
    this.longTimer = 0;
  }

  private bindInput() {
    const el = this.app.canvas;
    el.style.touchAction = 'none';
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.anim = null;
      const r = el.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      const before = this.screenToWorld(sx, sy);
      this.zoom = this.clampZoom(this.zoom * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
      const after = this.screenToWorld(sx, sy);
      this.cx += before.x - after.x;
      this.cy += before.y - after.y;
    }, { passive: false });
    const startPinch = () => {
      const [a, b] = [...this.pointers.values()];
      this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    };
    el.addEventListener('pointerdown', (e) => {
      try { el.setPointerCapture(e.pointerId); } catch { /* synthetic or already-released pointer */ }
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.touch = e.pointerType !== 'mouse';
      this.cancelLong();
      if (this.pointers.size === 1) {
        this.dragDist = 0;
        this.longFired = false;
        if (this.touch) {
          // Long-press on a star = touch equivalent of right-click (context actions).
          const x = e.clientX, y = e.clientY;
          this.longTimer = window.setTimeout(() => {
            this.longTimer = 0;
            if (this.pointers.size !== 1 || this.dragDist > 8) return;
            const r = el.getBoundingClientRect();
            const wp = this.screenToWorld(x - r.left, y - r.top);
            const star = this.hitStar(wp.x, wp.y, true);
            if (star === null) return;
            this.longFired = true;
            navigator.vibrate?.(12);
            this.cb.onStar(star, { button: 0, double: false, touch: true, long: true, x, y });
          }, LONG_PRESS_MS);
        }
      }
      if (this.pointers.size === 2) startPinch();
    });
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      const prev = this.pointers.get(e.pointerId);
      if (!prev) {
        if (e.pointerType !== 'mouse') return;
        const wp = this.screenToWorld(e.clientX - r.left, e.clientY - r.top);
        const hit = this.hitStar(wp.x, wp.y);
        if (hit !== this.hoverStar) {
          this.hoverStar = hit;
          this.cb.onHover(hit, e.clientX, e.clientY);
        }
        return;
      }
      const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 2) {
        // Pinch: zoom around the midpoint and pan with it.
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        if (this.pinch && this.pinch.d > 0) {
          this.anim = null;
          const before = this.screenToWorld(this.pinch.mx - r.left, this.pinch.my - r.top);
          this.zoom = this.clampZoom(this.zoom * (d / this.pinch.d));
          const after = this.screenToWorld(mx - r.left, my - r.top);
          this.cx += before.x - after.x;
          this.cy += before.y - after.y;
        }
        this.pinch = { d, mx, my };
        this.dragDist += 10;
        this.cancelLong();
        return;
      }
      if (this.pointers.size > 2) return;
      this.dragDist += Math.abs(dx) + Math.abs(dy);
      if (this.dragDist > (this.touch ? 8 : 4)) {
        this.cancelLong();
        this.anim = null;
        this.cx -= dx / this.zoom;
        this.cy -= dy / this.zoom;
        el.style.cursor = 'grabbing';
      }
    });
    const up = (e: PointerEvent) => {
      const had = this.pointers.delete(e.pointerId);
      el.style.cursor = '';
      this.cancelLong();
      if (this.pointers.size < 2) this.pinch = null;
      if (this.pointers.size === 2) startPinch();
      if (!had || this.pointers.size || this.longFired) return;
      if (this.dragDist > (this.touch ? 10 : 6)) return;
      const r = el.getBoundingClientRect();
      const wp = this.screenToWorld(e.clientX - r.left, e.clientY - r.top);
      const touch = e.pointerType !== 'mouse';
      const fleet = e.button === 0 ? this.hitFleet(wp.x, wp.y, touch) : null;
      if (fleet !== null) return this.cb.onFleet(fleet);
      const star = this.hitStar(wp.x, wp.y, touch);
      if (star === null) return this.cb.onEmpty();
      const now = performance.now();
      const double = this.lastTap.star === star && now - this.lastTap.t < 350;
      this.lastTap = { t: now, star };
      this.cb.onStar(star, { button: e.button, double, touch, x: e.clientX, y: e.clientY });
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', (e) => {
      this.pointers.delete(e.pointerId);
      this.cancelLong();
      if (this.pointers.size < 2) this.pinch = null;
    });
    el.addEventListener('pointerleave', () => { if (this.hoverStar !== null) { this.hoverStar = null; this.cb.onHover(null, 0, 0); } });
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKeyUp);
  }

  private onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.closest?.('input,textarea,select')) return;
    const k = e.key.toLowerCase();
    if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) this.keys.add(k);
    if (k === '=' || k === '+') this.zoom = this.clampZoom(this.zoom * 1.2);
    if (k === '-') this.zoom = this.clampZoom(this.zoom / 1.2);
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.key.toLowerCase());
  };

  hitStar(x: number, y: number, touch = false): StarId | null {
    const w = this.w;
    if (!w) return null;
    // Fingers are imprecise: accept taps within ~26 screen px of a star.
    const r = Math.max(22, (touch ? 26 : 14) / this.zoom);
    let best: StarId | null = null, bestD = r * r;
    for (const s of w.s.stars) {
      const d = (s.x - x) ** 2 + (s.y - y) ** 2;
      if (d < bestD) { bestD = d; best = s.id; }
    }
    return best;
  }

  hitFleet(x: number, y: number, touch = false): number | null {
    const r = Math.max(10, (touch ? 14 : 9) / this.zoom);
    let best: number | null = null, bestD = r * r;
    for (const [id, sp] of this.fleetSprites) {
      if (!sp.visible) continue;
      const d = (sp.x - x) ** 2 + (sp.y - y) ** 2;
      if (d < bestD) { bestD = d; best = id; }
    }
    return best;
  }

  // --- per-frame --------------------------------------------------------------

  private frame() {
    const w = this.w;
    if (!w) return;
    const dt = this.app.ticker.deltaMS / 1000;
    // Keyboard panning.
    const pan = 700 * dt / this.zoom;
    if (this.keys.has('arrowup')) this.cy -= pan;
    if (this.keys.has('arrowdown')) this.cy += pan;
    if (this.keys.has('arrowleft')) this.cx -= pan;
    if (this.keys.has('arrowright')) this.cx += pan;
    if (this.anim) {
      const t = Math.min(1, (performance.now() - this.anim.t0) / 450);
      const e = 1 - Math.pow(1 - t, 3);
      this.cx = this.anim.from.x + (this.anim.x - this.anim.from.x) * e;
      this.cy = this.anim.from.y + (this.anim.y - this.anim.from.y) * e;
      this.zoom = this.anim.from.z + (this.anim.z - this.anim.from.z) * e;
      if (t >= 1) this.anim = null;
    }
    const W = this.app.screen.width, H = this.app.screen.height;
    this.root.scale.set(this.zoom);
    this.root.position.set(W / 2 - this.cx * this.zoom, H / 2 - this.cy * this.zoom);
    this.bg.width = W;
    this.bg.height = H;
    this.bg.tilePosition.set(-this.cx * this.zoom * 0.15, -this.cy * this.zoom * 0.15);
    this.bg.tileScale.set(0.9 + this.zoom * 0.1);

    if (w.version !== this.lastVersion) {
      this.lastVersion = w.version;
      this.refreshStatic();
      this.refreshFleets();
    }
    this.drawLanes(true);
    this.refreshSelection();
    this.refreshLabels();
    this.applyScreenSizes();
  }

  /** Keep stars and fleet markers legible at any zoom. */
  private applyScreenSizes() {
    const w = this.w!;
    const k = Math.max(1, 0.55 / this.zoom);
    if (k !== this.lastScreenK) {
      this.lastScreenK = k;
      w.s.stars.forEach((st, i) => {
        const base = (st.cls === 'O' || st.cls === 'B' ? 60 : st.cls === 'M' || st.cls === 'WD' ? 34 : 44) * st.size;
        const v = this.views[i];
        v.sprite.width = v.sprite.height = base * Math.min(k, 3);
        v.ring.scale.set(Math.min(k, 2.5));
      });
    }
    // Fleet markers: ~20–30 px on screen regardless of zoom.
    for (const [id, sp] of this.fleetSprites) {
      const f = w.s.fleets[id];
      const n = f ? f.ships.length : 1;
      const size = (18 + Math.min(12, Math.sqrt(n) * 3)) / Math.min(this.zoom, 1.4);
      sp.width = sp.height = size;
    }
  }

  private lastScreenK = 0;

  private refreshStatic() {
    const w = this.w!;
    const s = w.s;
    const me = s.empires[this.viewer];
    const explored = me?.explored ?? [];
    // Stars.
    s.stars.forEach((st, i) => {
      const v = this.views[i];
      const ex = explored[i] ?? 2;
      v.sprite.alpha = ex === 0 ? 0.35 : ex === 1 ? 0.75 : 1;
      v.sprite.tint = ex === 0 ? 0x8890a0 : 0xffffff;
      // Territory & owner rings (only for stars we've seen).
      v.ring.clear();
      v.terr.visible = false;
      if (ex === 0) return;
      const owners = new Map<number, number>();
      for (const pid of st.planets) {
        const p = s.planets[pid];
        if (p.owner !== null) owners.set(p.owner, (owners.get(p.owner) ?? 0) + 1 + p.pop / 5);
      }
      if (!owners.size) return;
      const sorted = [...owners.entries()].sort((a, b) => b[1] - a[1]);
      const dom = sorted[0][0];
      v.terr.visible = true;
      v.terr.tint = s.empires[dom].color;
      v.terr.alpha = 0.16;
      let a0 = -Math.PI / 2;
      const total = sorted.reduce((t, [, n]) => t + n, 0);
      for (const [o, n] of sorted) {
        const a1 = a0 + (n / total) * Math.PI * 2;
        v.ring.arc(0, 0, 30, a0 + 0.08, a1 - 0.08).stroke({ width: 4, color: s.empires[o].color, alpha: 0.95 });
        a0 = a1;
      }
      if (w.s.empires[dom].capital !== null && s.planets[w.s.empires[dom].capital!]?.star === st.id) {
        v.ring.star(0, -40, 5, 7, 3).fill({ color: s.empires[dom].color });
      }
    });
    this.drawLanes(false);
  }

  private laneZoom = 0;

  /** Lanes are redrawn only when exploration/ownership changes or zoom moves a lot. */
  private drawLanes(zoomOnly: boolean) {
    const w = this.w!;
    const s = w.s;
    const explored = s.empires[this.viewer]?.explored ?? [];
    const zoomChanged = !this.laneZoom || Math.abs(Math.log(this.zoom / this.laneZoom)) > 0.18;
    if (zoomOnly && !zoomChanged) return;
    let oh = 0;
    for (const p of s.planets) if (p.owner !== null) oh = (oh * 31 + p.id * 7 + p.owner) | 0;
    const key = explored.join('') + '|' + oh;
    if (!zoomOnly && key === this.lastLaneKey && !zoomChanged) return;
    this.lastLaneKey = key;
    this.laneZoom = this.zoom;
    const px = 1 / this.zoom;
    const ownerOf = (sid: number) => {
      for (const pid of s.stars[sid].planets) { const o = s.planets[pid].owner; if (o !== null) return o; }
      return -1;
    };
    {
      const g = this.laneLayer;
      g.clear();
      for (const l of s.lanes) {
        const ea = explored[l.a] ?? 2, eb = explored[l.b] ?? 2;
        if (ea < 1 || eb < 1 || (ea < 2 && eb < 2 && !(ea === 1 && eb === 1))) continue;
        const A = s.stars[l.a], B = s.stars[l.b];
        if (l.unstable) {
          const n = Math.max(2, Math.floor(l.length / 24));
          for (let k = 0; k < n; k += 2) {
            const t0 = k / n, t1 = Math.min(1, (k + 1) / n);
            g.moveTo(A.x + (B.x - A.x) * t0, A.y + (B.y - A.y) * t0).lineTo(A.x + (B.x - A.x) * t1, A.y + (B.y - A.y) * t1);
          }
          g.stroke({ width: 2.2 * px, color: 0xff4a4a, alpha: 0.75 });
        } else {
          const oa = ea === 2 ? ownerOf(l.a) : -1, ob = eb === 2 ? ownerOf(l.b) : -1;
          const inside = oa >= 0 && oa === ob;
          g.moveTo(A.x, A.y).lineTo(B.x, B.y);
          g.stroke({ width: (inside ? 2.4 : 1.6) * px, color: inside ? s.empires[oa].color : 0x7f98e0, alpha: ea === 2 && eb === 2 ? (inside ? 0.8 : 0.55) : 0.25 });
        }
      }
    }
  }

  fleetPos(f: Fleet) {
    const s = this.w!.s;
    const A = s.stars[f.star];
    if (f.transit > 0 && f.route.length && f.transitTotal) {
      const B = s.stars[f.route[0]];
      const t = f.transit / f.transitTotal;
      return { x: A.x + (B.x - A.x) * t, y: A.y + (B.y - A.y) * t, angle: Math.atan2(B.y - A.y, B.x - A.x), moving: true };
    }
    return { x: A.x, y: A.y, angle: 0, moving: false };
  }

  private refreshFleets() {
    const w = this.w!;
    const s = w.s;
    const seen = new Set<number>();
    const perStar = new Map<number, number>();
    const all = Object.values(s.fleets);
    for (const f of all) {
      const vis = s.settings.spectate || fleetVisible(w, this.viewer, f);
      if (!vis) continue;
      seen.add(f.id);
      let sp = this.fleetSprites.get(f.id);
      if (!sp) {
        sp = new Sprite(this.chevron);
        sp.anchor.set(0.5);
        this.fleetLayer.addChild(sp);
        this.fleetSprites.set(f.id, sp);
      }
      sp.visible = true;
      sp.tint = s.empires[f.owner].color;
      const pos = this.fleetPos(f);
      if (pos.moving) {
        sp.position.set(pos.x, pos.y);
        sp.rotation = pos.angle;
      } else {
        // Orbit idle fleets around their star so several stay clickable.
        const k = perStar.get(f.star) ?? 0;
        perStar.set(f.star, k + 1);
        const a = -Math.PI / 4 + k * 0.7;
        const r = Math.max(40, 30 / this.zoom);
        sp.position.set(pos.x + Math.cos(a) * r, pos.y + Math.sin(a) * r);
        sp.rotation = a + Math.PI / 2;
      }
    }
    for (const [id, sp] of this.fleetSprites) {
      if (!seen.has(id)) {
        sp.destroy();
        this.fleetSprites.delete(id);
      }
    }
  }

  private refreshSelection() {
    const w = this.w!;
    const g = this.selLayer;
    g.clear();
    const t = performance.now() / 1000;
    if (this.selStar !== null) {
      const st = w.s.stars[this.selStar];
      const r = 38 + Math.sin(t * 3) * 2;
      g.circle(st.x, st.y, r).stroke({ width: 2.5 / Math.max(0.4, this.zoom), color: 0xffffff, alpha: 0.9 });
    }
    if (this.hoverStar !== null && this.hoverStar !== this.selStar) {
      const st = w.s.stars[this.hoverStar];
      g.circle(st.x, st.y, 36).stroke({ width: 1.5 / Math.max(0.4, this.zoom), color: 0xffffff, alpha: 0.4 });
    }
    // Routes: selected fleet (solid) + preview (dashed), plus faint lines for our moving fleets.
    const rg = this.routeLayer;
    rg.clear();
    const drawRoute = (from: { x: number; y: number }, stars: StarId[], color: number, alpha: number, width: number) => {
      let cur = from;
      for (const sid of stars) {
        const st = w.s.stars[sid];
        rg.moveTo(cur.x, cur.y).lineTo(st.x, st.y);
        cur = st;
      }
      rg.stroke({ width, color, alpha });
      if (stars.length) {
        const end = w.s.stars[stars[stars.length - 1]];
        rg.circle(end.x, end.y, 10).stroke({ width, color, alpha });
      }
    };
    for (const f of Object.values(w.s.fleets)) {
      if (f.owner !== this.viewer || !f.route.length || f.id === this.selFleet) continue;
      drawRoute(this.fleetPos(f), f.route, 0x9fd0ff, 0.25, 2 / Math.max(0.4, this.zoom));
    }
    const sf = this.selFleet !== null ? w.s.fleets[this.selFleet] : undefined;
    if (sf) {
      const p = this.fleetPos(sf);
      g.circle(this.fleetSprites.get(sf.id)?.x ?? p.x, this.fleetSprites.get(sf.id)?.y ?? p.y, 16).stroke({ width: 2 / Math.max(0.4, this.zoom), color: 0xffffff, alpha: 0.9 });
      if (sf.route.length) drawRoute(p, sf.route, 0x7fffd4, 0.9, 3 / Math.max(0.4, this.zoom));
    }
    if (this.routePreview && this.routePreview.length && sf) {
      const origin = sf.transit > 0 ? w.s.stars[sf.route[0]] : w.s.stars[sf.star];
      const dash = (t * 30) % 1;
      drawRoute(origin, this.routePreview, 0xffe27a, 0.6 + 0.3 * dash, 2.5 / Math.max(0.4, this.zoom));
    }
  }

  private refreshLabels() {
    const w = this.w!;
    const show = this.showLabels && this.zoom > 0.22;
    this.labelLayer.visible = show;
    if (!show) return;
    const W = this.app.screen.width, H = this.app.screen.height;
    const tl = this.screenToWorld(-100, -100), br = this.screenToWorld(W + 100, H + 100);
    const explored = w.s.empires[this.viewer]?.explored;
    const scale = 1 / Math.max(0.55, this.zoom);
    w.s.stars.forEach((st, i) => {
      const v = this.views[i];
      const inView = st.x > tl.x && st.x < br.x && st.y > tl.y && st.y < br.y;
      if (!inView) { if (v.label) v.label.visible = false; return; }
      const ex = explored ? explored[i] : 2;
      if (!v.label) {
        v.label = new Text({ text: st.name, style: { fontFamily: 'Chakra Petch, system-ui, sans-serif', fontSize: 26, fill: 0xdfe6ff, stroke: { color: 0x000000, width: 5 } } });
        v.label.anchor.set(0.5, 0);
        v.label.position.set(st.x, st.y + 26);
        this.labelLayer.addChild(v.label);
      }
      v.label.visible = true;
      v.label.alpha = ex === 0 ? 0.35 : ex === 1 ? 0.7 : 1;
      v.label.scale.set(scale * 0.8);
      let color = '#dfe6ff';
      if (ex) for (const pid of st.planets) { const o = w.s.planets[pid].owner; if (o !== null) { color = w.s.empires[o].color; break; } }
      // Changing style re-rasterizes the text, so only do it when the owner changes.
      if (v.labelColor !== color) {
        v.labelColor = color;
        v.label.style.fill = color;
      }
    });
  }

  starColor(cls: keyof typeof STAR_COLORS) {
    return STAR_COLORS[cls];
  }
}

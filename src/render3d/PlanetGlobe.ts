// 3D globe for one planet: the procedural planet sphere with its tile grid laid
// over the facing hemisphere as a lat/long patch, buildings standing on their
// tiles. Hosted by ui/hud/PlanetGlobe.tsx.

import * as THREE from 'three';
import { createStage, starfield, makePlanet, buildingModel, glowSprite, type Stage } from './common';
import { fitModel, disposeTree } from './SystemScene';
import type { World } from '../sim/world';
import type { Planet, TileColor } from '../sim/types';
import { BUILDING } from '../sim/content';

const R = 4;
const TILE_COLOR: Record<TileColor, number> = { white: 0xdfe6f5, black: 0x2a2e3a, red: 0xff6a4d, green: 0x4fdc7c, blue: 0x5a9cff };
const FILL_OPACITY: Record<TileColor, number> = { white: 0.1, black: 0.45, red: 0.26, green: 0.24, blue: 0.26 };

export interface GlobeOpts {
  onTile?: (index: number) => void;
  onHover?: (index: number | null, clientX: number, clientY: number) => void;
}

interface TileNode {
  i: number;
  fill: THREE.Mesh;
  line: THREE.LineLoop;
  content: THREE.Group;
  normal: THREE.Vector3;
  color: TileColor;
  sig: string;
}

function sphPoint(lat: number, lon: number, r: number) {
  return new THREE.Vector3(Math.cos(lat) * Math.sin(lon) * r, Math.sin(lat) * r, Math.cos(lat) * Math.cos(lon) * r);
}

/** A curved quad on the sphere between the given lat/lon bounds. */
function patchGeometry(lat0: number, lat1: number, lon0: number, lon1: number, r: number, seg = 5) {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let y = 0; y <= seg; y++) for (let x = 0; x <= seg; x++) {
    const p = sphPoint(lat0 + ((lat1 - lat0) * y) / seg, lon0 + ((lon1 - lon0) * x) / seg, r);
    pos.push(p.x, p.y, p.z);
  }
  for (let y = 0; y < seg; y++) for (let x = 0; x < seg; x++) {
    const a = y * (seg + 1) + x, b = a + 1, c = a + seg + 1, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function patchOutline(lat0: number, lat1: number, lon0: number, lon1: number, r: number, seg = 8) {
  const pts: THREE.Vector3[] = [];
  for (let k = 0; k < seg; k++) pts.push(sphPoint(lat0, lon0 + ((lon1 - lon0) * k) / seg, r));
  for (let k = 0; k < seg; k++) pts.push(sphPoint(lat0 + ((lat1 - lat0) * k) / seg, lon1, r));
  for (let k = 0; k < seg; k++) pts.push(sphPoint(lat1, lon1 - ((lon1 - lon0) * k) / seg, r));
  for (let k = 0; k < seg; k++) pts.push(sphPoint(lat1 - ((lat1 - lat0) * k) / seg, lon0, r));
  return new THREE.BufferGeometry().setFromPoints(pts);
}

/** Dim every material under `obj` (idle structures) or make it a translucent ghost (queued). */
function restyle(obj: THREE.Object3D, mode: 'idle' | 'ghost') {
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of mats as THREE.MeshStandardMaterial[]) {
      if (mode === 'idle') {
        mat.color?.multiplyScalar(0.35);
        if (mat.emissive) mat.emissiveIntensity = (mat.emissiveIntensity ?? 1) * 0.15;
      } else {
        mat.transparent = true;
        mat.opacity = 0.35;
        mat.depthWrite = false;
      }
    }
  });
}

export class PlanetGlobe {
  private stage: Stage;
  private tilt = new THREE.Group();
  private spin = new THREE.Group();
  private planetBody: THREE.Object3D | null = null;
  private tiles: TileNode[] = [];
  private planetKey = '';
  private hover: number | null = null;
  private selected: number | null = null;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private drag: { x: number; y: number; moved: number } | null = null;
  private over = false;
  private yaw = 0;
  private pitch = 0.34;
  private dist = 17;
  private zoom = 1;
  private swayT = 0;
  private clock = new THREE.Clock();
  private t = 0;
  private frames = 0;
  private raf = 0;
  private disposed = false;
  private gears: THREE.Object3D[] = [];
  private last = { x: 0, y: 0 };

  constructor(host: HTMLElement, private opts: GlobeOpts = {}) {
    this.stage = createStage(host, { fov: 38, far: 4000, background: 0x03040a });
    const { scene, camera, renderer } = this.stage;
    scene.add(starfield(1600, 1500));
    scene.add(new THREE.AmbientLight(0x9aa8c8, 0.75));
    const sun = new THREE.DirectionalLight(0xfff2dd, 2.2);
    sun.position.set(-8, 6, 10);
    scene.add(sun);
    const rim = new THREE.DirectionalLight(0x6f8cff, 0.8);
    rim.position.set(10, -3, -6);
    scene.add(rim);
    this.tilt.add(this.spin);
    scene.add(this.tilt);
    // Frame the globe (plus buildings) whatever the host's aspect ratio.
    const fit = (w: number, h: number) => {
      const half = THREE.MathUtils.degToRad(camera.fov / 2);
      const aspect = w / h;
      this.dist = (R * 1.42) / Math.tan(half) / Math.min(1, aspect);
    };
    this.stage.onResize = fit;
    fit(host.clientWidth || 1, host.clientHeight || 1);

    const el = renderer.domElement;
    el.style.cursor = 'grab';
    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    el.addEventListener('pointerenter', this.onEnter);
    el.addEventListener('pointerleave', this.onLeave);
    el.addEventListener('wheel', this.onWheel, { passive: false });
    document.addEventListener('visibilitychange', this.onVisibility);
    this.raf = requestAnimationFrame(this.frame);
  }

  // --- sync ------------------------------------------------------------------

  update(w: World, planetId: number, selected: number | null) {
    if (this.disposed) return;
    const p = w.s.planets[planetId];
    const key = `${p.id}:${p.type}:${p.gridW}x${p.gridH}`;
    if (key !== this.planetKey) this.rebuild(p, key);
    const owner = p.owner !== null ? w.s.empires[p.owner] : null;
    const color = owner?.color ?? '#9aa6c0';
    const ec = w.econ(p);
    const queued = new Map<number, string>();
    for (const q of p.queue) if (q.kind === 'building' && !q.orbital) queued.set(q.tile, q.id);
    p.tiles.forEach((t, i) => {
      const n = this.tiles[i];
      if (!n) return;
      if (n.color !== t.c) { n.color = t.c; this.paintTile(n); }
      const sig = `${t.b?.id ?? ''}|${t.b?.auto ? 1 : 0}|${ec.idle.has(i) ? 1 : 0}|${queued.get(i) ?? ''}|${color}`;
      if (sig !== n.sig) {
        n.sig = sig;
        this.buildContent(n, t.b?.id ?? null, !!t.b?.auto, ec.idle.has(i), queued.get(i) ?? null, color);
      }
    });
    this.selected = selected;
    this.refreshHighlights();
  }

  private rebuild(p: Planet, key: string) {
    this.planetKey = key;
    for (const c of [...this.spin.children]) { this.spin.remove(c); disposeTree(c); }
    this.tiles = [];
    this.gears = [];
    this.planetBody = makePlanet(p.type, p.id * 7919 + 13, R);
    // Tiles already color the surface; soften the gas-giant ring so it doesn't hide them.
    this.planetBody.traverse((o) => { if ((o as THREE.Mesh).geometry instanceof THREE.RingGeometry) o.visible = false; });
    this.spin.add(this.planetBody);

    // Square-ish tiles over the facing hemisphere; the grid's rounded corners are dead ground anyway.
    const d = Math.min(2.7 / p.gridW, 2.3 / p.gridH);
    const gap = d * 0.05;
    const lon0 = (-p.gridW * d) / 2, lat0 = (p.gridH * d) / 2;
    for (let i = 0; i < p.tiles.length; i++) {
      const x = i % p.gridW, y = Math.floor(i / p.gridW);
      const la = lat0 - y * d, lb = la - d, lo = lon0 + x * d, lp = lo + d;
      const fill = new THREE.Mesh(
        patchGeometry(lb + gap, la - gap, lo + gap, lp - gap, R * 1.012),
        new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide }),
      );
      fill.userData.tile = i;
      const line = new THREE.LineLoop(
        patchOutline(lb + gap, la - gap, lo + gap, lp - gap, R * 1.016),
        new THREE.LineBasicMaterial({ transparent: true, depthWrite: false }),
      );
      const content = new THREE.Group();
      const normal = sphPoint(la - d / 2, lo + d / 2, 1).normalize();
      content.position.copy(normal).multiplyScalar(R * 1.01);
      content.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
      content.userData.size = R * d * 0.72;
      this.spin.add(fill, line, content);
      const n: TileNode = { i, fill, line, content, normal, color: p.tiles[i].c, sig: '-' };
      this.paintTile(n);
      this.tiles.push(n);
    }
  }

  private paintTile(n: TileNode) {
    (n.fill.material as THREE.MeshBasicMaterial).color.setHex(TILE_COLOR[n.color]);
    (n.line.material as THREE.LineBasicMaterial).color.setHex(TILE_COLOR[n.color]);
  }

  private buildContent(n: TileNode, id: string | null, auto: boolean, idle: boolean, queued: string | null, color: string) {
    for (const c of [...n.content.children]) { n.content.remove(c); disposeTree(c); }
    this.gears = this.gears.filter((g) => g.parent);
    const size = n.content.userData.size as number;
    const holder = n.content;
    const load = (bid: string, mode: 'normal' | 'idle' | 'ghost') => {
      const def = BUILDING[bid];
      void buildingModel(bid, def?.role ?? 'industry', color).then((m) => {
        if (this.disposed || !holder.parent) { disposeTree(m); return; }
        if (mode !== 'normal') restyle(m, mode);
        const fitted = fitModel(m, size, true);
        fitted.rotation.y = ((n.i * 37) % 4) * (Math.PI / 2);
        fitted.userData.kind = mode;
        holder.add(fitted);
      });
    };
    if (id) {
      load(id, idle ? 'idle' : 'normal');
      if (auto) {
        const gear = new THREE.Group();
        const torus = new THREE.Mesh(
          new THREE.TorusGeometry(size * 0.32, size * 0.05, 6, 12),
          new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0x7fdcff, emissiveIntensity: 2.2 }),
        );
        torus.rotation.x = Math.PI / 2;
        gear.add(torus);
        gear.add(glowSprite(0x7fdcff, size * 0.9, 0.45));
        gear.position.y = size * 0.95;
        holder.add(gear);
        this.gears.push(gear);
      }
      if (idle) {
        const warn = glowSprite(0xff5050, size * 0.5, 0.9);
        warn.position.y = size * 0.9;
        holder.add(warn);
      }
    } else if (queued) load(queued, 'ghost');
  }

  private refreshHighlights() {
    for (const n of this.tiles) {
      const hov = n.i === this.hover, sel = n.i === this.selected;
      const fm = n.fill.material as THREE.MeshBasicMaterial;
      const lm = n.line.material as THREE.LineBasicMaterial;
      fm.opacity = FILL_OPACITY[n.color] + (hov ? 0.22 : 0) + (sel ? 0.15 : 0);
      if (sel) lm.color.setHex(0x7fdcff);
      else if (hov) lm.color.setHex(0xffffff);
      else lm.color.setHex(TILE_COLOR[n.color]);
      lm.opacity = sel || hov ? 1 : n.color === 'black' ? 0.25 : 0.6;
    }
  }

  // --- input -----------------------------------------------------------------

  private tileAt(cx: number, cy: number): number | null {
    const r = this.stage.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.stage.camera);
    const targets: THREE.Object3D[] = this.tiles.map((n) => n.fill);
    const body = this.planetBody?.getObjectByName('body');
    if (body) targets.push(body); // not the atmosphere shell, which encloses the tiles
    const hit = this.raycaster.intersectObjects(targets, false)[0];
    const i = hit?.object.userData.tile;
    return typeof i === 'number' ? i : null; // hitting the planet first means the tile is on the far side
  }

  private setHover(i: number | null, x: number, y: number) {
    if (i !== this.hover) {
      this.hover = i;
      this.refreshHighlights();
      this.stage.renderer.domElement.style.cursor = i !== null ? 'pointer' : 'grab';
    }
    this.opts.onHover?.(i, x, y);
  }

  private onDown = (e: PointerEvent) => {
    this.drag = { x: e.clientX, y: e.clientY, moved: 0 };
  };

  private onMove = (e: PointerEvent) => {
    this.last = { x: e.clientX, y: e.clientY };
    if (this.drag) {
      const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
      this.drag.x = e.clientX;
      this.drag.y = e.clientY;
      this.drag.moved += Math.abs(dx) + Math.abs(dy);
      this.yaw += dx * 0.008;
      this.pitch = Math.max(-1.1, Math.min(1.1, this.pitch + dy * 0.006));
      return;
    }
    if (this.over) this.setHover(this.tileAt(e.clientX, e.clientY), e.clientX, e.clientY);
  };

  private onUp = (e: PointerEvent) => {
    const d = this.drag;
    this.drag = null;
    if (!d || d.moved > 5 || e.button !== 0 || !this.over) return;
    const i = this.tileAt(e.clientX, e.clientY);
    if (i !== null) this.opts.onTile?.(i);
  };

  private onEnter = () => { this.over = true; };
  private onLeave = () => { this.over = false; if (!this.drag) this.setHover(null, 0, 0); };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.zoom = Math.max(0.45, Math.min(2.2, this.zoom * Math.exp(e.deltaY * 0.0012)));
  };

  private onVisibility = () => {
    if (!document.hidden && !this.disposed) {
      cancelAnimationFrame(this.raf);
      this.clock.getDelta();
      this.raf = requestAnimationFrame(this.frame);
    }
  };

  // --- frame -----------------------------------------------------------------

  private frame = () => {
    if (this.disposed || (document.hidden && this.frames > 0)) return; // first frame always renders
    const dt = Math.min(0.1, this.clock.getDelta());
    this.t += dt;
    // Gentle auto-sway keeps the tile grid facing the viewer; pauses while the pointer is over the globe.
    if (!this.over && !this.drag) this.swayT += dt;
    this.spin.rotation.y = this.yaw + Math.sin(this.swayT * 0.18) * 0.55;
    this.tilt.rotation.x = this.pitch;
    for (const g of this.gears) g.rotation.y += dt * 1.6;
    const cam = this.stage.camera;
    cam.position.set(0, 0, Math.max(R * 1.5, this.dist * this.zoom));
    cam.lookAt(0, 0, 0);
    if (this.over && !this.drag) {
      const i = this.tileAt(this.last.x, this.last.y);
      if (i !== this.hover) this.setHover(i, this.last.x, this.last.y);
    }
    this.stage.render();
    this.frames++;
    this.raf = requestAnimationFrame(this.frame);
  };

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    const el = this.stage.renderer.domElement;
    el.removeEventListener('pointerdown', this.onDown);
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    el.removeEventListener('pointerenter', this.onEnter);
    el.removeEventListener('pointerleave', this.onLeave);
    el.removeEventListener('wheel', this.onWheel);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.stage.dispose();
    this.tiles = [];
    this.gears = [];
  }
}

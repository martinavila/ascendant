// 3D battle replay. Battle.tsx owns the replay model and the playback clock;
// this scene only renders a given time `t` (in rounds), so scrubbing, pausing
// and speed changes all come from the same controls as the 2D canvas.
//
// Arena mapping: 2D (x, y) in a 1200x800 field -> 3D (X, Z) plane, with a
// small per-unit vertical offset for depth.

import * as THREE from 'three';
import { createStage, starfield, glowTexture, makeStar, makePlanet, shipModel, stationModel, OrbitRig, type Stage } from './common';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { SegBatch } from './Galaxy3D';
import type { StarClass } from '../sim/types';

export type WeaponKind = 'beam' | 'bolt' | 'missile' | 'slug' | 'orb';

export interface BattleUnit3D {
  id: number;
  name: string;
  hull: string;
  planet: boolean;
  color: string;
  /** Species ship style (picks the model family). */
  style: number;
  maxHp: number;
}

export interface UnitPose { x: number; y: number; hp: number; shield: number; smax: number; heading: number; alpha: number }
export interface ShotFx { from: number; to: number; dmg: number; t0: number; t1: number; kind: WeaponKind; color: string; width: number }
export interface DeathFx { id: number; t: number; x: number; y: number; size: number; color: string }

export interface BattleSceneSource {
  arenaW: number;
  arenaH: number;
  seed: number;
  /** System star class for the backdrop sun. */
  sun: StarClass | null;
  /** Optional backdrop planet (the defended world). */
  planet?: { type: string; seed: number } | null;
  units: BattleUnit3D[];
  shots: ShotFx[];
  deaths: DeathFx[];
  /** Interpolated state of a unit at time t, or null when gone. */
  unitAt(id: number, t: number): UnitPose | null;
  /** Units alive in the round containing t. */
  idsAt(t: number): Iterable<number>;
  /** Best-known position (falls back to last frame for just-destroyed units). */
  posAt(id: number, t: number): { x: number; y: number } | null;
}

export interface BattleRenderOpts { hover: number | null; highlight: number | null; label: string }

const S = 0.05; // arena px -> world units
const hash = (n: number) => {
  let x = (n * 2654435761) >>> 0;
  x ^= x >>> 15; x = Math.imul(x, 2246822519) >>> 0; x ^= x >>> 13;
  return (x >>> 0) / 4294967295;
};
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const HULL_LEN: Record<string, number> = { small: 2.4, medium: 3, large: 3.8, enormous: 4.8, titan: 6, station: 4.2 };

const SHIELD_VS = `varying vec3 vN; varying vec3 vV;
void main(){ vN = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position,1.0); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`;
const SHIELD_FS = `uniform vec3 c; uniform float k; varying vec3 vN; varying vec3 vV;
void main(){ float f = pow(1.0 - max(dot(vN, vV), 0.0), 2.2); gl_FragColor = vec4(c * (f * 0.9 + 0.08) * k, 1.0);
#include <colorspace_fragment>
}`;

interface UnitView {
  u: BattleUnit3D;
  root: THREE.Group;
  body: THREE.Group;
  shield: THREE.Mesh;
  shieldMat: THREE.ShaderMaterial;
  engine: THREE.Sprite;
  hpBg: THREE.Sprite;
  hpFg: THREE.Sprite;
  hpMat: THREE.SpriteMaterial;
  len: number;
  yOff: number;
  incoming: ShotFx[];
}

interface DeathView {
  d: DeathFx;
  group: THREE.Group;
  flash: THREE.Sprite;
  core: THREE.Sprite;
  ring: THREE.Mesh;
  debris: THREE.Points;
  vel: Float32Array;
}

class SpritePool {
  private list: THREE.Sprite[] = [];
  private used = 0;
  constructor(private parent: THREE.Object3D) {}
  begin() {
    this.used = 0;
  }
  get(color: THREE.ColorRepresentation, size: number, opacity: number) {
    let s = this.list[this.used];
    if (!s) {
      s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      this.parent.add(s);
      this.list.push(s);
    }
    this.used++;
    s.visible = true;
    (s.material as THREE.SpriteMaterial).color.set(color);
    (s.material as THREE.SpriteMaterial).opacity = opacity;
    s.scale.setScalar(size);
    return s;
  }
  end() {
    for (let i = this.used; i < this.list.length; i++) this.list[i].visible = false;
  }
}

export class BattleScene {
  private stage: Stage;
  private rig: OrbitRig;
  private units = new Map<number, UnitView>();
  private deaths: DeathView[] = [];
  private beamGlow: SegBatch;
  private beamCore: SegBatch;
  private trails: SegBatch;
  private sprites: SpritePool;
  private flashLight: THREE.PointLight;
  private overlay: HTMLDivElement;
  private labelEl: HTMLDivElement;
  private tipEl: HTMLDivElement;
  private lastNow = 0;
  private lastInput = -1e9;
  private disposed = false;
  private tmpV = new THREE.Vector3();
  private owned: { dispose(): void }[] = [];

  constructor(private host: HTMLElement, private src: BattleSceneSource) {
    this.stage = createStage(host, { fov: 42, near: 0.1, far: 3000, background: 0x02030a });
    const { scene, camera, renderer } = this.stage;
    const el = renderer.domElement;
    this.rig = new OrbitRig(camera, el);
    this.rig.yaw = 0.35;
    this.rig.pitch = 0.78;
    this.rig.dist = 62;
    this.rig.minDist = 12;
    this.rig.maxDist = 180;
    this.rig.minPitch = 0.12;
    this.rig.maxPitch = 1.45;
    this.rig.update();
    const mark = () => { this.lastInput = performance.now(); };
    el.addEventListener('pointerdown', mark);
    el.addEventListener('wheel', mark, { passive: true });
    el.style.touchAction = 'none';

    // Soft studio reflections so metallic hulls read in the dark.
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    const env = pmrem.fromScene(room, 0.04);
    room.dispose();
    scene.environment = env.texture;
    scene.environmentIntensity = 0.35;
    pmrem.dispose();
    this.owned.push(env);

    // Frame the opening positions.
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const id of src.idsAt(0)) {
      const p = src.unitAt(id, 0);
      if (!p) continue;
      x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
    }
    if (isFinite(x0)) {
      const c = this.toWorld((x0 + x1) / 2, (y0 + y1) / 2);
      this.rig.target.set(c.x, 0, c.z);
      const ext = Math.max((x1 - x0) * S, (y1 - y0) * S * 1.5, 10);
      this.rig.dist = Math.max(24, Math.min(55, ext * 0.9 + 12));
      this.rig.update();
    }

    // Backdrop.
    scene.add(starfield(2500, 1200));
    scene.add(new THREE.AmbientLight(0x8090b0, 0.55));
    scene.add(new THREE.HemisphereLight(0x9fb8ff, 0x1a1020, 0.7));
    const key = new THREE.DirectionalLight(0xffffff, 1.2);
    key.position.set(60, 40, -50);
    scene.add(key);
    if (src.sun) {
      const sun = makeStar(src.sun, 6);
      sun.position.set(130, -50, -230);
      scene.add(sun);
    }
    if (src.planet) {
      const p = makePlanet(src.planet.type, src.planet.seed, 16);
      p.position.set(-70, -34, -95);
      scene.add(p);
    }
    const grid = new THREE.PolarGridHelper(34, 16, 6, 64, 0x3a4c90, 0x22305e);
    for (const m of [grid.material].flat() as THREE.Material[]) {
      m.transparent = true;
      m.opacity = 0.22;
      m.depthWrite = false;
    }
    grid.position.y = -4;
    scene.add(grid);
    const nebula = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: 0x283a8a, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending }));
    nebula.scale.setScalar(260);
    nebula.position.set(-80, -40, -300);
    scene.add(nebula);

    this.flashLight = new THREE.PointLight(0xffc27a, 0, 40, 1.5);
    scene.add(this.flashLight);

    // Shot batches.
    this.beamGlow = new SegBatch(256, { width: 8 });
    this.beamCore = new SegBatch(256, { width: 2.2 });
    this.trails = new SegBatch(256, { width: 3 });
    for (const b of [this.beamGlow, this.beamCore, this.trails]) {
      b.obj.renderOrder = 10;
      scene.add(b.obj);
      this.owned.push(b);
    }
    const fx = new THREE.Group();
    scene.add(fx);
    this.sprites = new SpritePool(fx);
    const onResize = (w: number, h: number) => {
      for (const b of [this.beamGlow, this.beamCore, this.trails]) b.resize(w, h);
    };
    this.stage.onResize = onResize;
    onResize(host.clientWidth || 1, host.clientHeight || 1);

    // Units.
    const incoming = new Map<number, ShotFx[]>();
    for (const s of src.shots) {
      if (!incoming.has(s.to)) incoming.set(s.to, []);
      incoming.get(s.to)!.push(s);
    }
    for (const u of src.units) this.addUnit(u, incoming.get(u.id) ?? []);
    for (const d of src.deaths) this.addDeath(d);

    // HTML overlay: round label + hover tooltip.
    this.overlay = document.createElement('div');
    this.overlay.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;';
    this.labelEl = document.createElement('div');
    this.labelEl.style.cssText = 'position:absolute;left:18px;top:12px;font:600 15px "Chakra Petch",Inter,sans-serif;color:rgba(223,230,255,0.6);letter-spacing:.06em;';
    this.tipEl = document.createElement('div');
    this.tipEl.style.cssText = 'position:absolute;left:0;top:0;transform:translate(-50%,-100%);text-align:center;font:12px Inter,sans-serif;color:#b8c4e8;text-shadow:0 1px 3px #000,0 0 6px #000;white-space:nowrap;display:none;';
    this.overlay.append(this.labelEl, this.tipEl);
    host.appendChild(this.overlay);
  }

  private toWorld(x: number, y: number, yOff = 0) {
    return this.tmpV.set((x - this.src.arenaW / 2) * S, yOff, (y - this.src.arenaH / 2) * S);
  }

  private addUnit(u: BattleUnit3D, incoming: ShotFx[]) {
    const root = new THREE.Group();
    const body = new THREE.Group();
    root.add(body);
    const len = u.planet ? HULL_LEN.station : HULL_LEN[u.hull] ?? 2.2;
    const yOff = u.planet ? -2 + hash(u.id * 5 + 1) * 1.5 : (hash(u.id * 31 + 7) - 0.5) * 6;
    const load = u.planet ? stationModel(/Missile/.test(u.name ?? '') ? 'missile' : /Aegis|Shield/.test(u.name ?? '') ? 'shield' : 'lance', u.color) : shipModel(u.style, u.hull, u.color);
    void load.then((m) => {
      if (this.disposed) return;
      // Normalise any model to the hull's nominal length.
      const box = new THREE.Box3().setFromObject(m);
      const size = box.getSize(new THREE.Vector3());
      const k = len / Math.max(0.001, size.x, size.z, size.y * 0.8);
      m.scale.multiplyScalar(k);
      const c = box.getCenter(new THREE.Vector3()).multiplyScalar(k);
      m.position.sub(c);
      body.add(m);
    });
    const shieldMat = new THREE.ShaderMaterial({
      vertexShader: SHIELD_VS, fragmentShader: SHIELD_FS,
      uniforms: { c: { value: new THREE.Color(0x7fdcff) }, k: { value: 0 } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const shield = new THREE.Mesh(new THREE.SphereGeometry(len * 0.62, 32, 20), shieldMat);
    shield.visible = false;
    root.add(shield);
    const engine = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: u.color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    engine.scale.setScalar(len * 0.45);
    engine.visible = !u.planet;
    body.add(engine);
    engine.position.x = -len * 0.55;
    const owner = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: u.color, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending }));
    owner.scale.setScalar(len * 1.8);
    root.add(owner);
    const hpBg = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0x000000, transparent: true, opacity: 0.6, depthWrite: false, depthTest: false }));
    const hpMat = new THREE.SpriteMaterial({ color: 0x6fe08a, transparent: true, depthWrite: false, depthTest: false });
    const hpFg = new THREE.Sprite(hpMat);
    hpFg.center.set(0, 0.5);
    hpBg.renderOrder = hpFg.renderOrder = 30;
    this.stage.scene.add(root, hpBg, hpFg);
    root.visible = hpBg.visible = hpFg.visible = false;
    this.units.set(u.id, { u, root, body, shield, shieldMat, engine, hpBg, hpFg, hpMat, len, yOff, incoming });
  }

  private addDeath(d: DeathFx) {
    const group = new THREE.Group();
    const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: 0xffd27a, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    const core = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.85, 1, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffe2a8, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }),
    );
    const N = 36;
    const pos = new Float32Array(N * 3), vel = new Float32Array(N * 3), col = new Float32Array(N * 3);
    const base = new THREE.Color(d.color);
    for (let i = 0; i < N; i++) {
      const u = hash(d.id * 97 + i) * 2 - 1, a = hash(d.id * 53 + i * 3) * Math.PI * 2, r = Math.sqrt(1 - u * u);
      const sp = 3 + hash(d.id * 71 + i * 5) * 7;
      vel.set([Math.cos(a) * r * sp, u * sp * 0.6, Math.sin(a) * r * sp], i * 3);
      const c = i % 3 === 0 ? base : new THREE.Color(0xffd9a0);
      col.set([c.r, c.g, c.b], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const debris = new THREE.Points(g, new THREE.PointsMaterial({ size: 0.45, map: glowTexture(), vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    debris.frustumCulled = false;
    group.add(flash, core, ring, debris);
    group.visible = false;
    this.stage.scene.add(group);
    this.deaths.push({ d, group, flash, core, ring, debris, vel });
  }

  /** Unit world position at time t (null if absent). */
  private unitPos(id: number, t: number, out = new THREE.Vector3()) {
    const v = this.units.get(id);
    const p = this.src.unitAt(id, t) ?? this.src.posAt(id, t);
    if (!p) return null;
    const w = this.toWorld(p.x, p.y, v?.yOff ?? 0);
    return out.copy(w);
  }

  render(t: number, now: number, o: BattleRenderOpts) {
    if (this.disposed) return;
    const dt = Math.min(0.1, this.lastNow ? (now - this.lastNow) / 1000 : 0);
    this.lastNow = now;
    const { camera } = this.stage;
    // Cinematic drift: slow orbit unless the user touched the camera recently.
    if (performance.now() - this.lastInput > 4000) {
      this.rig.yaw += dt * 0.05;
      this.rig.update();
    }
    const camRight = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);

    // Units.
    const alive = new Set<number>(this.src.idsAt(t));
    let tipShown = false;
    for (const [id, v] of this.units) {
      const s = alive.has(id) ? this.src.unitAt(id, t) : null;
      const show = !!s && s.alpha > 0.03;
      v.root.visible = v.hpBg.visible = v.hpFg.visible = show;
      if (!s || !show) continue;
      const bob = Math.sin(now / 900 + id) * 0.12;
      const p = this.toWorld(s.x, s.y, v.yOff + bob);
      v.root.position.copy(p);
      v.body.rotation.set(0, -s.heading, 0);
      if (v.u.planet) v.body.rotation.y = now / 4000 + id;
      v.root.scale.setScalar(0.4 + 0.6 * s.alpha);
      (v.engine.material as THREE.SpriteMaterial).opacity = 0.55 + 0.45 * Math.sin(now / 70 + id);
      // Shield: steady glow proportional to remaining shield, plus hit flashes.
      let flash = 0;
      if (s.smax > 0) {
        for (const sh of v.incoming) {
          if (t >= sh.t1 && t < sh.t1 + 0.22) flash = Math.max(flash, 1 - (t - sh.t1) / 0.22);
        }
        const frac = s.shield / s.smax;
        const k = 0.25 * frac + 1.6 * flash * (0.4 + 0.6 * frac);
        v.shield.visible = k > 0.02;
        v.shieldMat.uniforms.k.value = k;
      } else v.shield.visible = false;
      // HP bar above the unit, left-aligned in screen space.
      const frac = v.u.maxHp > 0 ? s.hp / v.u.maxHp : 0;
      const bw = Math.max(1.6, v.len * 0.9), bh = 0.16;
      const top = p.y + v.len * 0.55 + 0.5;
      v.hpBg.position.set(p.x, top, p.z);
      v.hpBg.scale.set(bw, bh, 1);
      v.hpFg.position.set(p.x - camRight.x * bw / 2, top - camRight.y * bw / 2, p.z - camRight.z * bw / 2);
      v.hpFg.scale.set(Math.max(0.001, bw * frac), bh, 1);
      v.hpMat.color.set(frac > 0.6 ? 0x6fe08a : frac > 0.3 ? 0xffcf6a : 0xff6b6b);
      if ((o.hover === id || o.highlight === id) && !tipShown) {
        tipShown = true;
        const sp = this.toScreen(p.x, top + 0.3, p.z);
        if (sp) {
          this.tipEl.style.display = '';
          this.tipEl.style.left = sp.x + 'px';
          this.tipEl.style.top = sp.y + 'px';
          this.tipEl.innerHTML = `<div style="color:#fff;font-weight:600;font-size:13px">${escapeHtml(v.u.name)}</div><div>${Math.ceil(s.hp)} / ${v.u.maxHp} hp${s.smax ? ` · shield ${Math.round(s.shield)}` : ''}</div>`;
        }
      }
    }
    if (!tipShown) this.tipEl.style.display = 'none';

    // Shots.
    this.beamGlow.begin();
    this.beamCore.begin();
    this.trails.begin();
    this.sprites.begin();
    const A = new THREE.Vector3(), B = new THREE.Vector3(), T = new THREE.Vector3();
    const c = new THREE.Color(), white = new THREE.Color(0xffffff);
    for (const sh of this.src.shots) {
      if (t < sh.t0 || t > sh.t1 + 0.18) continue;
      if (!this.unitPos(sh.from, t, A) || !this.unitPos(sh.to, t, B)) continue;
      const miss = sh.dmg <= 0;
      const off = miss ? (hash(Math.floor(sh.t0 * 1000)) - 0.5) * 70 * S : 0;
      T.set(B.x + off, B.y + off * 0.5, B.z - off * 0.6);
      const p = clamp01((t - sh.t0) / Math.max(0.001, sh.t1 - sh.t0));
      const after = t > sh.t1 ? (t - sh.t1) / 0.18 : 0;
      const alpha = miss ? 0.35 : 1;
      c.set(sh.color);
      if (sh.kind === 'beam') {
        const fade = (t > sh.t1 ? 1 - after : 1) * alpha;
        const reach = Math.min(1, p * 2.5);
        const ex = A.x + (T.x - A.x) * reach, ey = A.y + (T.y - A.y) * reach, ez = A.z + (T.z - A.z) * reach;
        const heavy = Math.min(1.6, sh.width / 3);
        this.beamGlow.seg(A.x, A.y, A.z, ex, ey, ez, c, 0.45 * fade * heavy);
        const core = c.clone().lerp(white, 0.55);
        this.beamCore.seg(A.x, A.y, A.z, ex, ey, ez, core, fade);
        this.sprites.get(sh.color, 0.9 * heavy, 0.8 * fade).position.copy(A);
      } else if (t <= sh.t1) {
        const x = A.x + (T.x - A.x) * p, y = A.y + (T.y - A.y) * p, z = A.z + (T.z - A.z) * p;
        const len = A.distanceTo(T) || 1;
        const trail = (sh.kind === 'missile' ? 26 : sh.kind === 'slug' ? 14 : sh.kind === 'bolt' ? 18 : 6) * S * 1.4;
        const k = trail / len;
        this.trails.seg(x - (T.x - A.x) * k, y - (T.y - A.y) * k, z - (T.z - A.z) * k, x, y, z, c, alpha);
        const head = sh.kind === 'orb' ? sh.width * 0.28 : sh.kind === 'missile' ? 0.7 : 0.45;
        this.sprites.get(sh.color, head, alpha).position.set(x, y, z);
        if (sh.kind === 'orb') this.sprites.get(0xffffff, head * 0.45, alpha).position.set(x, y, z);
      }
      // Impact spark.
      if (!miss && t >= sh.t1 && after < 1) {
        const size = 0.6 + after * 1.4 + Math.min(1.5, sh.dmg / 8);
        this.sprites.get(0xffffff, size, 1 - after).position.copy(B);
        this.sprites.get(sh.color, size * 1.8, 0.6 * (1 - after)).position.copy(B);
      }
    }
    this.beamGlow.end();
    this.beamCore.end();
    this.trails.end();
    this.sprites.end();

    // Explosions.
    let bright = 0;
    for (const dv of this.deaths) {
      const age = t - dv.d.t;
      if (age < 0 || age > 1.4) { dv.group.visible = false; continue; }
      const q = age / 1.4;
      dv.group.visible = true;
      const v = this.units.get(dv.d.id);
      const w = this.toWorld(dv.d.x, dv.d.y, v?.yOff ?? 0);
      dv.group.position.copy(w);
      const sz = dv.d.size * S * 4;
      const fm = dv.flash.material as THREE.SpriteMaterial;
      fm.color.set(0xffd27a).lerp(new THREE.Color(dv.d.color), q);
      fm.opacity = (1 - q) * 0.95;
      dv.flash.scale.setScalar(sz * (1.2 + q * 2.6));
      (dv.core.material as THREE.SpriteMaterial).opacity = Math.max(0, 1 - q * 2.2);
      dv.core.scale.setScalar(sz * (0.6 + q * 0.8));
      const rm = dv.ring.material as THREE.MeshBasicMaterial;
      rm.opacity = (1 - q) * 0.8;
      dv.ring.scale.setScalar(sz * (0.3 + q * 2.4));
      const pos = dv.debris.geometry.attributes.position as THREE.BufferAttribute;
      const arr = pos.array as Float32Array;
      const tt = age * (1 - 0.25 * q);
      for (let i = 0; i < arr.length; i++) arr[i] = dv.vel[i] * tt;
      pos.needsUpdate = true;
      (dv.debris.material as THREE.PointsMaterial).opacity = 1 - q;
      const b = (1 - q) ** 2 * (dv.d.size / 26);
      if (b > bright) {
        bright = b;
        this.flashLight.position.copy(w);
      }
    }
    this.flashLight.intensity = bright * 60;

    if (this.labelEl.textContent !== o.label) this.labelEl.textContent = o.label;
    this.stage.render();
  }

  private toScreen(x: number, y: number, z: number) {
    const v = new THREE.Vector3(x, y, z).project(this.stage.camera);
    if (v.z > 1) return null;
    return { x: (v.x * 0.5 + 0.5) * this.host.clientWidth, y: (-v.y * 0.5 + 0.5) * this.host.clientHeight };
  }

  /** Unit under the cursor (screen-space nearest within ~30px). */
  pick(clientX: number, clientY: number, t: number): number | null {
    const r = this.stage.renderer.domElement.getBoundingClientRect();
    const x = clientX - r.left, y = clientY - r.top;
    let best: number | null = null, bd = 30 * 30;
    for (const id of this.src.idsAt(t)) {
      const s = this.src.unitAt(id, t);
      const v = this.units.get(id);
      if (!s || !v) continue;
      const w = this.toWorld(s.x, s.y, v.yOff);
      const p = this.toScreen(w.x, w.y, w.z);
      if (!p) continue;
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d < bd) { bd = d; best = id; }
    }
    return best;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.rig.dispose();
    for (const o of this.owned) o.dispose();
    this.overlay.remove();
    // Sprite materials share the cached glow texture; only geometry/material are freed.
    this.stage.renderer.forceContextLoss();
    this.stage.dispose();
  }
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

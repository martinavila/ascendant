// Three.js galaxy map. Drop-in alternative to the PixiJS GalaxyView: same
// public surface and callbacks, so MapView can swap between them.
//
// Layout: stars sit on the galactic plane (x -> X, y -> Z) with a small
// deterministic vertical offset for depth. The camera orbits a target on the
// plane with clamped tilt; interaction always resolves onto the plane.
//
// Scales to thousands of stars: stars are one Points draw, lanes/rings/routes
// are batched fat-line segments written into preallocated buffers, territory
// and fleets are InstancedMeshes, labels are a pooled HTML overlay.

import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { createStage, starfield, type Stage } from './common';
import { STAR_COLORS } from '../art/procedural';
import { fleetVisible } from '../sim/visibility';
import type { World } from '../sim/world';
import type { Fleet, StarId } from '../sim/types';
import type { GalaxyCallbacks } from '../render/galaxy';

// --- batched fat lines ------------------------------------------------------------

/**
 * A pool of fat line segments (LineSegments2) written into preallocated
 * buffers. `begin()`, `seg()`..., `end()` — no per-frame GPU allocations
 * unless capacity grows. Colors are premultiplied by alpha (use additive
 * blending) so one draw call handles varying opacity.
 */
export class SegBatch {
  obj: LineSegments2;
  mat: LineMaterial;
  private geom!: LineSegmentsGeometry;
  private pos!: Float32Array;
  private col!: Float32Array;
  private dist!: Float32Array;
  private posBuf!: THREE.InterleavedBuffer;
  private colBuf!: THREE.InterleavedBuffer;
  private distBuf!: THREE.InterleavedBuffer;
  private n = 0;
  private cap = 0;

  constructor(cap: number, opts: { width: number; dashed?: boolean; dash?: number; gap?: number; additive?: boolean; depthTest?: boolean }) {
    this.mat = new LineMaterial({
      linewidth: opts.width,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      depthTest: opts.depthTest ?? true,
      blending: opts.additive === false ? THREE.NormalBlending : THREE.AdditiveBlending,
    });
    if (opts.dashed) {
      this.mat.dashed = true;
      this.mat.dashSize = opts.dash ?? 10;
      this.mat.gapSize = opts.gap ?? 10;
    }
    this.obj = new LineSegments2(new LineSegmentsGeometry(), this.mat);
    this.obj.frustumCulled = false;
    this.alloc(Math.max(16, cap));
  }

  private alloc(cap: number) {
    this.cap = cap;
    const old = this.geom;
    this.pos = new Float32Array(cap * 6);
    this.col = new Float32Array(cap * 6);
    this.dist = new Float32Array(cap * 2);
    const g = new LineSegmentsGeometry();
    this.posBuf = new THREE.InstancedInterleavedBuffer(this.pos, 6, 1).setUsage(THREE.DynamicDrawUsage);
    this.colBuf = new THREE.InstancedInterleavedBuffer(this.col, 6, 1).setUsage(THREE.DynamicDrawUsage);
    this.distBuf = new THREE.InstancedInterleavedBuffer(this.dist, 2, 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('instanceStart', new THREE.InterleavedBufferAttribute(this.posBuf, 3, 0));
    g.setAttribute('instanceEnd', new THREE.InterleavedBufferAttribute(this.posBuf, 3, 3));
    g.setAttribute('instanceColorStart', new THREE.InterleavedBufferAttribute(this.colBuf, 3, 0));
    g.setAttribute('instanceColorEnd', new THREE.InterleavedBufferAttribute(this.colBuf, 3, 3));
    g.setAttribute('instanceDistanceStart', new THREE.InterleavedBufferAttribute(this.distBuf, 1, 0));
    g.setAttribute('instanceDistanceEnd', new THREE.InterleavedBufferAttribute(this.distBuf, 1, 1));
    g.instanceCount = 0;
    this.geom = g;
    this.obj.geometry = g;
    old?.dispose();
  }

  begin() {
    this.n = 0;
  }

  /** Add a segment; color components premultiplied by `a`. d0/d1 are dash distances. */
  seg(ax: number, ay: number, az: number, bx: number, by: number, bz: number, c: THREE.Color, a = 1, d0 = 0, d1 = -1) {
    if (this.n >= this.cap) {
      const keep = { pos: this.pos, col: this.col, dist: this.dist, n: this.n };
      this.alloc(this.cap * 2);
      this.pos.set(keep.pos);
      this.col.set(keep.col);
      this.dist.set(keep.dist);
      this.n = keep.n;
    }
    const i = this.n++;
    const p = i * 6;
    this.pos[p] = ax; this.pos[p + 1] = ay; this.pos[p + 2] = az;
    this.pos[p + 3] = bx; this.pos[p + 4] = by; this.pos[p + 5] = bz;
    const r = c.r * a, g = c.g * a, b = c.b * a;
    this.col[p] = r; this.col[p + 1] = g; this.col[p + 2] = b;
    this.col[p + 3] = r; this.col[p + 4] = g; this.col[p + 5] = b;
    this.dist[i * 2] = d0;
    this.dist[i * 2 + 1] = d1 < 0 ? d0 + Math.hypot(bx - ax, by - ay, bz - az) : d1;
  }

  end() {
    this.geom.instanceCount = this.n;
    this.posBuf.needsUpdate = true;
    this.colBuf.needsUpdate = true;
    this.distBuf.needsUpdate = true;
    this.obj.visible = this.n > 0;
  }

  get count() {
    return this.n;
  }

  resize(w: number, h: number) {
    this.mat.resolution.set(w, h);
  }

  dispose() {
    this.geom.dispose();
    this.mat.dispose();
  }
}

// --- textures -----------------------------------------------------------------------

function canvasTex(size: number, paint: (ctx: CanvasRenderingContext2D, s: number) => void) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  paint(c.getContext('2d')!, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const blobTex = () => canvasTex(128, (ctx, s) => {
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
});

const chevronTex = () => canvasTex(64, (ctx) => {
  ctx.translate(32, 32);
  ctx.beginPath();
  ctx.moveTo(22, 0);
  ctx.lineTo(-16, 16);
  ctx.lineTo(-8, 0);
  ctx.lineTo(-16, -16);
  ctx.closePath();
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(0,0,0,0.8)';
  ctx.stroke();
});

const discGlowTex = () => canvasTex(256, (ctx, s) => {
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,236,210,0.9)');
  g.addColorStop(0.12, 'rgba(200,190,255,0.45)');
  g.addColorStop(0.45, 'rgba(80,100,200,0.14)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
});

// --- helpers ------------------------------------------------------------------------

const hash = (n: number) => {
  let x = (n * 2654435761) >>> 0;
  x ^= x >>> 15; x = Math.imul(x, 2246822519) >>> 0; x ^= x >>> 13;
  return (x >>> 0) / 4294967295;
};

const FOV = 45;
const TAN = Math.tan((FOV / 2) * Math.PI / 180);
const HEIGHT_JITTER = 45;
const FOG_TINT = new THREE.Color(0x8890a0);
const LANE_COLOR = new THREE.Color(0x7f98e0);
const UNSTABLE_COLOR = new THREE.Color(0xff4a4a);
const WHITE = new THREE.Color(0xffffff);
const ROUTE_OWN = new THREE.Color(0x9fd0ff);
const ROUTE_SEL = new THREE.Color(0x7fffd4);
const ROUTE_PREVIEW = new THREE.Color(0xffe27a);

const starBase = (cls: string, size: number) => (cls === 'O' || cls === 'B' ? 60 : cls === 'M' || cls === 'WD' ? 34 : 44) * size;

const STAR_VS = `
attribute float size;
attribute float alpha;
attribute vec3 tint;
uniform float uScale;
uniform float uMinPx;
uniform float uMaxPx;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float px = size * uScale / max(1.0, -mv.z);
  gl_PointSize = clamp(px, uMinPx * (0.6 + 0.4 * alpha), uMaxPx);
  vColor = tint;
  vAlpha = alpha;
  gl_Position = projectionMatrix * mv;
}`;

const STAR_FS = `
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;
  float core = smoothstep(0.28, 0.0, r);
  float halo = pow(1.0 - r, 2.4);
  float spike = max(0.0, 1.0 - abs(p.x) * 14.0) * (1.0 - abs(p.y)) + max(0.0, 1.0 - abs(p.y) * 14.0) * (1.0 - abs(p.x));
  vec3 c = vColor * (halo * 1.1 + spike * 0.25) + vec3(1.0) * core * 0.9;
  gl_FragColor = vec4(c * vAlpha, 1.0);
  #include <colorspace_fragment>
}`;

interface FleetDisp { x: number; y: number; z: number; tx: number; ty: number; tz: number; dir: THREE.Vector3; size: number; color: THREE.Color; fresh: boolean }

// --- the view -------------------------------------------------------------------------

export class Galaxy3D {
  w: World | null = null;
  viewer = 0;
  selStar: StarId | null = null;
  selFleet: number | null = null;
  hoverStar: StarId | null = null;
  routePreview: StarId[] | null = null;
  showLabels = true;
  keys = new Set<string>();

  private stage!: Stage;
  private ready = false;
  private raf = 0;
  private lastT = 0;
  private overlay!: HTMLDivElement;

  // camera
  private target = new THREE.Vector3();
  private yaw = 0;
  private pitch = 1.05;
  private dist = 3000;
  private anim: { x: number; z: number; d: number; t0: number; from: { x: number; z: number; d: number } } | null = null;
  private pendingZoom: number | null = null;

  // scene objects
  private stars: THREE.Points | null = null;
  private starPos = new Float32Array(0);
  private starCol = new Float32Array(0);
  private starAlpha = new Float32Array(0);
  private starSize = new Float32Array(0);
  private starMat!: THREE.ShaderMaterial;
  private terr: THREE.InstancedMesh | null = null;
  private fleetMesh: THREE.InstancedMesh | null = null;
  private haze: THREE.Points | null = null;
  private disc: THREE.Mesh | null = null;
  private sky!: THREE.Points;
  private texBlob!: THREE.Texture;
  private texChevron!: THREE.Texture;
  private texDisc!: THREE.Texture;
  private lanesN!: SegBatch;
  private lanesIn!: SegBatch;
  private lanesU!: SegBatch;
  private stalks!: SegBatch;
  private rings!: SegBatch;
  private routes!: SegBatch;
  private routeSel!: SegBatch;
  private preview!: SegBatch;
  private sel!: SegBatch;
  private batches: SegBatch[] = [];

  private lastVersion = -1;
  private lastLaneKey = '';
  private ringDist = 0;
  private labelColor: string[] = [];
  private ownerColor: (THREE.Color | null)[] = [];
  private fleets = new Map<number, FleetDisp>();
  private bounds = { x0: 0, x1: 0, y0: 0, y1: 0 };
  private labels: HTMLDivElement[] = [];
  private screen = new Float32Array(0); // per star: sx, sy, depth (css px); depth<0 = behind
  private tmp = new THREE.Vector3();
  private ray = new THREE.Raycaster();
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  constructor(private host: HTMLElement, private cb: GalaxyCallbacks) {}

  // --- public API mirroring GalaxyView ----------------------------------------------

  get zoom() {
    return this.cssH() / (2 * TAN * this.dist);
  }
  set zoom(z: number) {
    this.anim = null;
    if (!this.ready) this.pendingZoom = z;
    this.dist = this.distFor(z);
  }
  get cx() {
    return this.target.x;
  }
  set cx(v: number) {
    this.anim = null;
    this.target.x = v;
  }
  get cy() {
    return this.target.z;
  }
  set cy(v: number) {
    this.anim = null;
    this.target.z = v;
  }

  async init() {
    this.stage = createStage(this.host, { fov: FOV, near: 4, far: 150000, background: 0x03040a });
    const { scene, renderer } = this.stage;
    this.texBlob = blobTex();
    this.texChevron = chevronTex();
    this.texDisc = discGlowTex();
    this.sky = starfield(3500, 60000);
    this.sky.renderOrder = -10;
    scene.add(this.sky);
    this.starMat = new THREE.ShaderMaterial({
      vertexShader: STAR_VS, fragmentShader: STAR_FS,
      uniforms: { uScale: { value: 1 }, uMinPx: { value: 7 }, uMaxPx: { value: 160 } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const mk = (cap: number, o: ConstructorParameters<typeof SegBatch>[1]) => {
      const b = new SegBatch(cap, o);
      this.batches.push(b);
      scene.add(b.obj);
      return b;
    };
    this.stalks = mk(1024, { width: 1 });
    this.lanesN = mk(2048, { width: 1.6 });
    this.lanesIn = mk(512, { width: 2.6 });
    this.lanesU = mk(256, { width: 2.2, dashed: true, dash: 24, gap: 24 });
    this.rings = mk(1024, { width: 3.2 });
    this.routes = mk(256, { width: 2, depthTest: false });
    this.routeSel = mk(128, { width: 3, depthTest: false });
    this.preview = mk(128, { width: 2.6, dashed: true, dash: 22, gap: 14, depthTest: false });
    this.sel = mk(256, { width: 2.4, depthTest: false });
    this.stage.onResize = (w, h) => {
      for (const b of this.batches) b.resize(w, h);
      this.starMat.uniforms.uScale.value = (h * renderer.getPixelRatio()) / (2 * TAN);
      this.starMat.uniforms.uMinPx.value = 7 * renderer.getPixelRatio();
      this.starMat.uniforms.uMaxPx.value = Math.min(256, 170 * renderer.getPixelRatio());
    };
    this.stage.onResize(this.host.clientWidth || 1, this.host.clientHeight || 1);
    this.overlay = document.createElement('div');
    this.overlay.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;contain:strict;';
    this.host.appendChild(this.overlay);
    this.bindInput();
    this.ready = true;
    if (this.pendingZoom !== null) this.dist = this.distFor(this.pendingZoom);
    if (this.w) this.build();
    this.lastT = performance.now();
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      if (document.hidden || !this.host.isConnected) return;
      const dt = Math.min(0.1, (now - this.lastT) / 1000);
      this.lastT = now;
      this.frame(dt, now / 1000);
    };
    this.raf = requestAnimationFrame(loop);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    if (!this.ready) return;
    const el = this.stage.renderer.domElement;
    el.removeEventListener('wheel', this.onWheel);
    for (const b of this.batches) b.dispose();
    this.texBlob.dispose();
    this.texChevron.dispose();
    this.texDisc.dispose();
    this.overlay.remove();
    this.stage.renderer.forceContextLoss();
    this.stage.dispose();
    this.ready = false;
  }

  setWorld(w: World, viewer: number) {
    this.w = w;
    this.viewer = viewer;
    if (this.ready) this.build();
  }

  focusOn(star: StarId, zoom?: number) {
    const st = this.w?.s.stars[star];
    if (!st) return;
    const z = zoom ?? Math.max(this.zoom, 0.6);
    this.anim = { x: st.x, z: st.y, d: this.distFor(z), t0: performance.now(), from: { x: this.target.x, z: this.target.z, d: this.dist } };
  }

  fitAll() {
    const b = this.bounds;
    const W = this.cssW(), H = this.cssH();
    const z = Math.min(W / (b.x1 - b.x0 + 400), H / (b.y1 - b.y0 + 400)) * 1.1;
    this.anim = { x: (b.x0 + b.x1) / 2, z: (b.y0 + b.y1) / 2, d: this.distFor(z), t0: performance.now(), from: { x: this.target.x, z: this.target.z, d: this.dist } };
  }

  // --- building -----------------------------------------------------------------------

  private cssW() {
    return Math.max(1, this.host.clientWidth);
  }
  private cssH() {
    return Math.max(1, this.host.clientHeight || 800);
  }
  private distFor(z: number) {
    const zc = Math.max(0.02, Math.min(3, z));
    return this.cssH() / (2 * TAN * zc);
  }

  starY(id: number) {
    return (hash(id * 7919 + 13) - 0.5) * 2 * HEIGHT_JITTER;
  }

  private build() {
    const w = this.w!;
    const { scene } = this.stage;
    const stars = w.s.stars;
    const n = stars.length;
    // Stars: one Points object.
    if (this.stars) {
      scene.remove(this.stars);
      this.stars.geometry.dispose();
    }
    this.starPos = new Float32Array(n * 3);
    this.starCol = new Float32Array(n * 3);
    this.starAlpha = new Float32Array(n);
    this.starSize = new Float32Array(n);
    this.screen = new Float32Array(n * 3);
    stars.forEach((st, i) => {
      this.starPos[i * 3] = st.x;
      this.starPos[i * 3 + 1] = this.starY(st.id);
      this.starPos[i * 3 + 2] = st.y;
      this.starSize[i] = starBase(st.cls, st.size) * 1.5;
      this.starAlpha[i] = 1;
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.starPos, 3));
    g.setAttribute('tint', new THREE.BufferAttribute(this.starCol, 3));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.starAlpha, 1));
    g.setAttribute('size', new THREE.BufferAttribute(this.starSize, 1));
    this.stars = new THREE.Points(g, this.starMat);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = 5;
    scene.add(this.stars);

    // Territory discs.
    if (this.terr) {
      scene.remove(this.terr);
      this.terr.geometry.dispose();
      (this.terr.material as THREE.Material).dispose();
    }
    const disc = new THREE.PlaneGeometry(320, 320).rotateX(-Math.PI / 2);
    this.terr = new THREE.InstancedMesh(disc, new THREE.MeshBasicMaterial({ map: this.texBlob, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }), n);
    this.terr.count = 0;
    this.terr.frustumCulled = false;
    this.terr.renderOrder = 1;
    scene.add(this.terr);

    // Galactic disc glow + dust haze following the star distribution.
    const xs = stars.map((s) => s.x), ys = stars.map((s) => s.y);
    this.bounds = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
    const b = this.bounds;
    const R = Math.max(b.x1 - b.x0, b.y1 - b.y0) / 2 + 400;
    if (this.disc) {
      scene.remove(this.disc);
      this.disc.geometry.dispose();
      (this.disc.material as THREE.Material).dispose();
    }
    this.disc = new THREE.Mesh(new THREE.PlaneGeometry(R * 2.6, R * 2.6).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: this.texDisc, transparent: true, opacity: 0.3, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.disc.position.set((b.x0 + b.x1) / 2, -HEIGHT_JITTER * 1.4, (b.y0 + b.y1) / 2);
    this.disc.renderOrder = 0;
    scene.add(this.disc);
    if (this.haze) {
      scene.remove(this.haze);
      this.haze.geometry.dispose();
      (this.haze.material as THREE.Material).dispose();
    }
    const hn = Math.min(12000, n * 8);
    const hp = new Float32Array(hn * 3), hc = new Float32Array(hn * 3);
    for (let i = 0; i < hn; i++) {
      const s = stars[Math.floor(hash(i * 3 + 1) * n) % n];
      const a = hash(i * 5 + 2) * Math.PI * 2, r = Math.sqrt(hash(i * 7 + 3)) * 160;
      hp[i * 3] = s.x + Math.cos(a) * r;
      hp[i * 3 + 1] = (hash(i * 11 + 4) - 0.5) * HEIGHT_JITTER * 3;
      hp[i * 3 + 2] = s.y + Math.sin(a) * r;
      const k = 0.18 + hash(i * 13 + 5) * 0.22, warm = hash(i * 17 + 6);
      hc[i * 3] = k * (0.8 + warm * 0.3);
      hc[i * 3 + 1] = k * 0.85;
      hc[i * 3 + 2] = k * (1.1 - warm * 0.3);
    }
    const hg = new THREE.BufferGeometry();
    hg.setAttribute('position', new THREE.BufferAttribute(hp, 3));
    hg.setAttribute('color', new THREE.BufferAttribute(hc, 3));
    this.haze = new THREE.Points(hg, new THREE.PointsMaterial({ size: 1.5, sizeAttenuation: false, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.haze.frustumCulled = false;
    scene.add(this.haze);

    this.fleets.clear();
    this.labelColor = new Array(n).fill('#dfe6ff');
    this.ownerColor = new Array(n).fill(null);
    this.lastVersion = -1;
    this.lastLaneKey = '';
    this.ringDist = 0;
  }

  // --- input --------------------------------------------------------------------------

  private pointers = new Map<number, { x: number; y: number }>();
  private dragDist = 0;
  private dragButton = 0;
  private dragMode: 'pan' | 'rotate' | null = null;
  private grab: THREE.Vector3 | null = null;
  private pinch0 = 0;
  private lastTap = { t: 0, star: -1 };

  private planeHit(clientX: number, clientY: number, out = new THREE.Vector3()): THREE.Vector3 | null {
    const r = this.stage.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(ndc, this.stage.camera);
    const hit = this.ray.ray.intersectPlane(this.plane, out);
    if (!hit) return null;
    // Ignore hits absurdly far away (near the horizon).
    if (hit.distanceTo(this.stage.camera.position) > this.dist * 8) return null;
    return hit;
  }

  private bindInput() {
    const el = this.stage.renderer.domElement;
    el.style.touchAction = 'none';
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('wheel', this.onWheel, { passive: false });
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.dragDist = 0;
      this.dragMode = null;
      this.dragButton = e.button;
      this.grab = this.planeHit(e.clientX, e.clientY);
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.pinch0 = Math.hypot(a.x - b.x, a.y - b.y);
      }
    });
    el.addEventListener('pointermove', (e) => {
      const prev = this.pointers.get(e.pointerId);
      if (!prev) {
        const hit = this.hitStar(e.clientX, e.clientY);
        if (hit !== this.hoverStar) {
          this.hoverStar = hit;
          this.cb.onHover(hit, e.clientX, e.clientY);
        }
        return;
      }
      const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (this.pinch0) this.zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, this.pinch0 / Math.max(1, d));
        this.pinch0 = d;
        this.dragDist += 10;
        return;
      }
      this.dragDist += Math.abs(dx) + Math.abs(dy);
      if (this.dragDist <= 4) return;
      this.anim = null;
      if (!this.dragMode) this.dragMode = this.dragButton === 2 || this.dragButton === 1 || e.shiftKey ? 'rotate' : 'pan';
      if (this.dragMode === 'rotate') {
        this.yaw -= dx * 0.005;
        this.pitch = Math.max(0.42, Math.min(1.52, this.pitch + dy * 0.004));
        this.updateCamera();
        el.style.cursor = 'move';
      } else {
        const cur = this.grab ? this.planeHit(e.clientX, e.clientY) : null;
        if (this.grab && cur) {
          this.target.x += this.grab.x - cur.x;
          this.target.z += this.grab.z - cur.z;
        } else {
          const k = 1 / this.zoom;
          const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
          this.target.x -= (dx * cy + dy * sy) * k;
          this.target.z -= (-dx * sy + dy * cy) * k;
        }
        this.updateCamera();
        el.style.cursor = 'grabbing';
      }
    });
    const up = (e: PointerEvent) => {
      const had = this.pointers.delete(e.pointerId);
      el.style.cursor = '';
      if (!had || this.dragDist > 6 || this.pointers.size) return;
      const fleet = e.button === 0 ? this.hitFleet(e.clientX, e.clientY) : null;
      if (fleet !== null) return this.cb.onFleet(fleet);
      const star = this.hitStar(e.clientX, e.clientY);
      if (star === null) return this.cb.onEmpty();
      const now = performance.now();
      const double = this.lastTap.star === star && now - this.lastTap.t < 350;
      this.lastTap = { t: now, star };
      this.cb.onStar(star, { button: e.button, double });
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', (e) => this.pointers.delete(e.pointerId));
    el.addEventListener('pointerleave', () => {
      if (this.hoverStar !== null && !this.pointers.size) {
        this.hoverStar = null;
        this.cb.onHover(null, 0, 0);
      }
    });
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.anim = null;
    this.zoomAt(e.clientX, e.clientY, Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
  };

  /** Scale camera distance by `f`, keeping the plane point under the cursor fixed. */
  private zoomAt(clientX: number, clientY: number, f: number) {
    this.updateCamera();
    const before = this.planeHit(clientX, clientY);
    this.dist = Math.max(this.distFor(3), Math.min(this.distFor(0.02), this.dist * f));
    this.updateCamera();
    const after = before ? this.planeHit(clientX, clientY) : null;
    if (before && after) {
      this.target.x += before.x - after.x;
      this.target.z += before.z - after.z;
      this.updateCamera();
    }
  }

  private onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.closest?.('input,textarea,select')) return;
    const k = e.key.toLowerCase();
    if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) this.keys.add(k);
    if (k === '=' || k === '+') { this.anim = null; this.dist = Math.max(this.distFor(3), this.dist / 1.2); }
    if (k === '-') { this.anim = null; this.dist = Math.min(this.distFor(0.02), this.dist * 1.2); }
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.key.toLowerCase());
  };

  private onBlur = () => this.keys.clear();

  /** Nearest star to the cursor in screen space (uses last frame's projection). */
  hitStar(clientX: number, clientY: number): StarId | null {
    const w = this.w;
    if (!w || !this.ready) return null;
    const r = this.stage.renderer.domElement.getBoundingClientRect();
    const x = clientX - r.left, y = clientY - r.top;
    this.projectStars();
    let best: StarId | null = null, bestD = Infinity;
    const n = w.s.stars.length;
    const f = this.cssH() / (2 * TAN);
    for (let i = 0; i < n; i++) {
      const depth = this.screen[i * 3 + 2];
      if (depth <= 0) continue;
      const ppu = f / depth;
      const rad = Math.max(14, 22 * ppu);
      const d = (this.screen[i * 3] - x) ** 2 + (this.screen[i * 3 + 1] - y) ** 2;
      if (d < rad * rad && d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  hitFleet(clientX: number, clientY: number): number | null {
    if (!this.ready) return null;
    const r = this.stage.renderer.domElement.getBoundingClientRect();
    const x = clientX - r.left, y = clientY - r.top;
    let best: number | null = null, bestD = 14 * 14;
    for (const [id, f] of this.fleets) {
      const p = this.toScreen(f.x, f.y, f.z);
      if (!p) continue;
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d < bestD) { bestD = d; best = id; }
    }
    return best;
  }

  private toScreen(x: number, y: number, z: number) {
    const v = this.tmp.set(x, y, z).applyMatrix4(this.stage.camera.matrixWorldInverse);
    if (v.z >= -1) return null;
    const depth = -v.z;
    v.applyMatrix4(this.stage.camera.projectionMatrix);
    return { x: (v.x * 0.5 + 0.5) * this.cssW(), y: (-v.y * 0.5 + 0.5) * this.cssH(), depth };
  }

  private projFrame = -1;
  private frameNo = 0;

  private projectStars() {
    if (this.projFrame === this.frameNo) return;
    this.updateCamera();
    this.projFrame = this.frameNo;
    const cam = this.stage.camera;
    const m = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).elements;
    const vm = cam.matrixWorldInverse.elements;
    const W = this.cssW(), H = this.cssH();
    const n = this.starPos.length / 3;
    for (let i = 0; i < n; i++) {
      const x = this.starPos[i * 3], y = this.starPos[i * 3 + 1], z = this.starPos[i * 3 + 2];
      const depth = -(vm[2] * x + vm[6] * y + vm[10] * z + vm[14]);
      if (depth <= 1) { this.screen[i * 3 + 2] = -1; continue; }
      const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
      const cx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / cw;
      const cy = (m[1] * x + m[5] * y + m[9] * z + m[13]) / cw;
      this.screen[i * 3] = (cx * 0.5 + 0.5) * W;
      this.screen[i * 3 + 1] = (-cy * 0.5 + 0.5) * H;
      this.screen[i * 3 + 2] = depth;
    }
  }

  // --- per frame ----------------------------------------------------------------------

  private updateCamera() {
    const cam = this.stage.camera;
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    cam.position.set(
      this.target.x + Math.sin(this.yaw) * cp * this.dist,
      this.target.y + sp * this.dist,
      this.target.z + Math.cos(this.yaw) * cp * this.dist,
    );
    cam.lookAt(this.target);
    cam.updateMatrixWorld();
    this.projFrame = -1;
  }

  private frame(dt: number, t: number) {
    const w = this.w;
    if (!w) {
      this.stage.render();
      return;
    }
    this.frameNo++;
    // Keyboard panning (screen-relative).
    const pan = (700 * dt) / this.zoom;
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw), rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
    let mx = 0, mz = 0;
    if (this.keys.has('arrowup')) { mx += fx; mz += fz; }
    if (this.keys.has('arrowdown')) { mx -= fx; mz -= fz; }
    if (this.keys.has('arrowleft')) { mx -= rx; mz -= rz; }
    if (this.keys.has('arrowright')) { mx += rx; mz += rz; }
    if (mx || mz) { this.anim = null; this.target.x += mx * pan; this.target.z += mz * pan; }
    if (this.anim) {
      const k = Math.min(1, (performance.now() - this.anim.t0) / 450);
      const e = 1 - Math.pow(1 - k, 3);
      const a = this.anim;
      this.target.x = a.from.x + (a.x - a.from.x) * e;
      this.target.z = a.from.z + (a.z - a.from.z) * e;
      // Interpolate distance in log space so zooms feel even.
      this.dist = Math.exp(Math.log(a.from.d) + (Math.log(a.d) - Math.log(a.from.d)) * e);
      if (k >= 1) this.anim = null;
    }
    this.updateCamera();
    this.sky.position.copy(this.stage.camera.position);

    if (w.version !== this.lastVersion) {
      this.lastVersion = w.version;
      this.refreshStatic();
      this.refreshFleetTargets();
    }
    if (!this.ringDist || Math.abs(Math.log(this.dist / this.ringDist)) > 0.15) this.drawRings();
    this.projectStars();
    this.updateFleets(dt);
    this.drawSelection(t);
    this.updateLabels();
    this.stage.render();
  }

  private ownerOf(sid: number) {
    const s = this.w!.s;
    for (const pid of s.stars[sid].planets) {
      const o = s.planets[pid].owner;
      if (o !== null) return o;
    }
    return -1;
  }

  private refreshStatic() {
    const w = this.w!;
    const s = w.s;
    const explored = s.empires[this.viewer]?.explored ?? [];
    const terr = this.terr!;
    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    let tn = 0;
    this.stalks.begin();
    s.stars.forEach((st, i) => {
      const ex = explored[i] ?? 2;
      c.set(STAR_COLORS[st.cls]);
      if (st.cls === 'BH') c.set(0x9070ff);
      if (ex === 0) c.lerp(FOG_TINT, 0.7);
      this.starCol[i * 3] = c.r;
      this.starCol[i * 3 + 1] = c.g;
      this.starCol[i * 3 + 2] = c.b;
      this.starAlpha[i] = ex === 0 ? 0.35 : ex === 1 ? 0.75 : 1;
      this.starSize[i] = starBase(st.cls, st.size) * (ex === 0 ? 1.1 : 1.5);
      this.labelColor[i] = '#dfe6ff';
      this.ownerColor[i] = null;
      const y = this.starPos[i * 3 + 1];
      if (ex > 0) this.stalks.seg(st.x, y, st.y, st.x, -HEIGHT_JITTER * 1.4, st.y, c, ex === 2 ? 0.1 : 0.05);
      if (ex === 0) return;
      const owners = new Map<number, number>();
      for (const pid of st.planets) {
        const p = s.planets[pid];
        if (p.owner !== null) owners.set(p.owner, (owners.get(p.owner) ?? 0) + 1 + p.pop / 5);
      }
      if (!owners.size) return;
      const dom = [...owners.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const col = new THREE.Color(s.empires[dom].color);
      this.labelColor[i] = s.empires[dom].color;
      this.ownerColor[i] = col;
      m.makeTranslation(st.x, -HEIGHT_JITTER * 1.2 + (i % 7) * 0.3, st.y);
      terr.setMatrixAt(tn, m);
      terr.setColorAt(tn, c.copy(col).multiplyScalar(0.2));
      tn++;
    });
    this.stalks.end();
    terr.count = tn;
    terr.instanceMatrix.needsUpdate = true;
    if (terr.instanceColor) terr.instanceColor.needsUpdate = true;
    const g = this.stars!.geometry;
    g.attributes.tint.needsUpdate = true;
    g.attributes.alpha.needsUpdate = true;
    g.attributes.size.needsUpdate = true;
    this.drawLanes();
    this.drawRings();
  }

  /** Lanes are rebuilt only when exploration or ownership changes. */
  private drawLanes() {
    const s = this.w!.s;
    const explored = s.empires[this.viewer]?.explored ?? [];
    let oh = 0;
    for (const p of s.planets) if (p.owner !== null) oh = (oh * 31 + p.id * 7 + p.owner) | 0;
    const key = explored.join('') + '|' + oh;
    if (key === this.lastLaneKey) return;
    this.lastLaneKey = key;
    this.lanesN.begin();
    this.lanesIn.begin();
    this.lanesU.begin();
    const P = this.starPos;
    const ec = new THREE.Color();
    for (const l of s.lanes) {
      const ea = explored[l.a] ?? 2, eb = explored[l.b] ?? 2;
      if (ea < 1 || eb < 1 || (ea < 2 && eb < 2 && !(ea === 1 && eb === 1))) continue;
      const a = l.a * 3, b = l.b * 3;
      if (l.unstable) {
        this.lanesU.seg(P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2], UNSTABLE_COLOR, 0.8, 0);
        continue;
      }
      const oa = ea === 2 ? this.ownerOf(l.a) : -1, ob = eb === 2 ? this.ownerOf(l.b) : -1;
      if (oa >= 0 && oa === ob) {
        ec.set(s.empires[oa].color);
        this.lanesIn.seg(P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2], ec, 0.85);
      } else {
        this.lanesN.seg(P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2], LANE_COLOR, ea === 2 && eb === 2 ? 0.5 : 0.22);
      }
    }
    this.lanesN.end();
    this.lanesIn.end();
    this.lanesU.end();
  }

  /** Owner arcs + capital markers; radius grows when zoomed out so they stay visible. */
  private drawRings() {
    const w = this.w;
    if (!w) return;
    this.ringDist = this.dist;
    const s = w.s;
    const explored = s.empires[this.viewer]?.explored ?? [];
    const k = Math.min(2.5, Math.max(1, 0.55 / this.zoom));
    const R = 30 * k;
    const c = new THREE.Color();
    this.rings.begin();
    s.stars.forEach((st, i) => {
      if (!this.ownerColor[i] || !(explored[i] ?? 2)) return;
      const owners = new Map<number, number>();
      for (const pid of st.planets) {
        const p = s.planets[pid];
        if (p.owner !== null) owners.set(p.owner, (owners.get(p.owner) ?? 0) + 1 + p.pop / 5);
      }
      const sorted = [...owners.entries()].sort((a, b) => b[1] - a[1]);
      const total = sorted.reduce((t, [, n]) => t + n, 0);
      const y = this.starPos[i * 3 + 1];
      let a0 = -Math.PI / 2;
      for (const [o, n] of sorted) {
        const a1 = a0 + (n / total) * Math.PI * 2;
        c.set(s.empires[o].color);
        const seg = Math.max(3, Math.ceil(((a1 - a0) / (Math.PI * 2)) * 32));
        const s0 = a0 + (sorted.length > 1 ? 0.08 : 0), s1 = a1 - (sorted.length > 1 ? 0.08 : 0);
        for (let j = 0; j < seg; j++) {
          const u0 = s0 + ((s1 - s0) * j) / seg, u1 = s0 + ((s1 - s0) * (j + 1)) / seg;
          this.rings.seg(st.x + Math.cos(u0) * R, y, st.y + Math.sin(u0) * R, st.x + Math.cos(u1) * R, y, st.y + Math.sin(u1) * R, c, 0.95);
        }
        a0 = a1;
      }
      const dom = sorted[0][0];
      const cap = s.empires[dom].capital;
      if (cap !== null && s.planets[cap]?.star === st.id) {
        // Five-pointed star marker above the ring.
        c.set(s.empires[dom].color);
        const cx = st.x, cz = st.y - R - 10 * k;
        const pts: [number, number][] = [];
        for (let j = 0; j < 10; j++) {
          const ang = -Math.PI / 2 + (j * Math.PI) / 5, rr = (j % 2 ? 3.2 : 8) * k;
          pts.push([cx + Math.cos(ang) * rr, cz + Math.sin(ang) * rr]);
        }
        for (let j = 0; j < 10; j++) {
          const [ax, az] = pts[j], [bx, bz] = pts[(j + 1) % 10];
          this.rings.seg(ax, y, az, bx, y, bz, c, 1);
        }
      }
    });
    this.rings.end();
  }

  private fleetTarget(f: Fleet) {
    const P = this.starPos;
    const a = f.star * 3;
    if (f.transit > 0 && f.route.length && f.transitTotal) {
      const b = f.route[0] * 3;
      const t = f.transit / f.transitTotal;
      return {
        x: P[a] + (P[b] - P[a]) * t, y: P[a + 1] + (P[b + 1] - P[a + 1]) * t, z: P[a + 2] + (P[b + 2] - P[a + 2]) * t,
        dir: new THREE.Vector3(P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]).normalize(), moving: true,
      };
    }
    return { x: P[a], y: P[a + 1], z: P[a + 2], dir: new THREE.Vector3(1, 0, 0), moving: false };
  }

  private idleSlot = new Map<number, number>();

  private refreshFleetTargets() {
    const w = this.w!;
    const s = w.s;
    const seen = new Set<number>();
    const perStar = new Map<number, number>();
    this.idleSlot.clear();
    for (const f of Object.values(s.fleets)) {
      if (!(s.settings.spectate || fleetVisible(w, this.viewer, f))) continue;
      seen.add(f.id);
      const p = this.fleetTarget(f);
      let d = this.fleets.get(f.id);
      if (!d) {
        d = { x: p.x, y: p.y, z: p.z, tx: p.x, ty: p.y, tz: p.z, dir: p.dir, size: 18, color: new THREE.Color(), fresh: true };
        this.fleets.set(f.id, d);
      }
      d.color.set(s.empires[f.owner].color).lerp(WHITE, 0.2);
      d.size = 1.35 * (18 + Math.min(12, Math.sqrt(f.ships.length || 1) * 3));
      d.tx = p.x; d.ty = p.y; d.tz = p.z;
      d.dir = p.dir;
      if (!p.moving) {
        const k = perStar.get(f.star) ?? 0;
        perStar.set(f.star, k + 1);
        this.idleSlot.set(f.id, k);
      }
    }
    for (const id of [...this.fleets.keys()]) if (!seen.has(id)) this.fleets.delete(id);
  }

  private updateFleets(dt: number) {
    const { scene, camera } = this.stage;
    const n = this.fleets.size;
    if (!this.fleetMesh || this.fleetMesh.instanceMatrix.count < n) {
      if (this.fleetMesh) {
        scene.remove(this.fleetMesh);
        this.fleetMesh.geometry.dispose();
        (this.fleetMesh.material as THREE.Material).dispose();
        this.fleetMesh.dispose();
      }
      const cap = Math.max(64, Math.ceil(n * 1.5));
      this.fleetMesh = new THREE.InstancedMesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({ map: this.texChevron, transparent: true, depthWrite: false, depthTest: false, alphaTest: 0.05 }),
        cap,
      );
      this.fleetMesh.frustumCulled = false;
      this.fleetMesh.renderOrder = 20;
      this.fleetMesh.setColorAt(0, WHITE);
      scene.add(this.fleetMesh);
    }
    const mesh = this.fleetMesh;
    const f0 = this.cssH() / (2 * TAN);
    const k = Math.min(1, dt * 6);
    const q = new THREE.Quaternion(), qz = new THREE.Quaternion(), zAxis = new THREE.Vector3(0, 0, 1);
    const m = new THREE.Matrix4(), sc = new THREE.Vector3(), pos = new THREE.Vector3();
    let i = 0;
    for (const [id, d] of this.fleets) {
      let tx = d.tx, tz = d.tz;
      const slot = this.idleSlot.get(id);
      let dir = d.dir;
      if (slot !== undefined) {
        // Orbit idle fleets around their star so several stay clickable.
        const depth = Math.max(1, this.toScreen(d.tx, d.ty, d.tz)?.depth ?? this.dist);
        const r = Math.max(40, 30 / (f0 / depth));
        const a = -Math.PI / 4 + slot * 0.7;
        tx += Math.cos(a) * r;
        tz += Math.sin(a) * r;
        dir = new THREE.Vector3(-Math.sin(a), 0, Math.cos(a));
      }
      if (d.fresh) { d.x = tx; d.y = d.ty; d.z = tz; d.fresh = false; }
      d.x += (tx - d.x) * k;
      d.y += (d.ty - d.y) * k;
      d.z += (tz - d.z) * k;
      const sp = this.toScreen(d.x, d.y, d.z);
      const depth = sp?.depth ?? this.dist;
      const size = d.size / (f0 / depth);
      // Screen-space heading so the chevron reads like the 2D map.
      const sp2 = this.toScreen(d.x + dir.x * 20, d.y + dir.y * 20, d.z + dir.z * 20);
      const ang = sp && sp2 ? Math.atan2(-(sp2.y - sp.y), sp2.x - sp.x) : 0;
      q.copy(camera.quaternion).multiply(qz.setFromAxisAngle(zAxis, ang));
      m.compose(pos.set(d.x, d.y, d.z), q, sc.set(size, size, size));
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, d.color);
      i++;
    }
    mesh.count = i;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  private circle(b: SegBatch, x: number, y: number, z: number, r: number, c: THREE.Color, a: number, screen = false) {
    const N = 40;
    const cam = this.stage.camera;
    const ux = new THREE.Vector3(), uy = new THREE.Vector3();
    if (screen) {
      ux.setFromMatrixColumn(cam.matrixWorld, 0);
      uy.setFromMatrixColumn(cam.matrixWorld, 1);
    } else {
      ux.set(1, 0, 0);
      uy.set(0, 0, 1);
    }
    for (let j = 0; j < N; j++) {
      const a0 = (j / N) * Math.PI * 2, a1 = ((j + 1) / N) * Math.PI * 2;
      const c0 = Math.cos(a0) * r, s0 = Math.sin(a0) * r, c1 = Math.cos(a1) * r, s1 = Math.sin(a1) * r;
      b.seg(x + ux.x * c0 + uy.x * s0, y + ux.y * c0 + uy.y * s0, z + ux.z * c0 + uy.z * s0, x + ux.x * c1 + uy.x * s1, y + ux.y * c1 + uy.y * s1, z + ux.z * c1 + uy.z * s1, c, a);
    }
  }

  private pxAt(x: number, y: number, z: number) {
    const depth = this.toScreen(x, y, z)?.depth ?? this.dist;
    return (this.cssH() / (2 * TAN)) / depth;
  }

  private drawSelection(t: number) {
    const w = this.w!;
    const P = this.starPos;
    this.sel.begin();
    if (this.selStar !== null && P.length > this.selStar * 3) {
      const i = this.selStar * 3;
      const ppu = this.pxAt(P[i], P[i + 1], P[i + 2]);
      const r = Math.max(38, 18 / ppu) * (1 + Math.sin(t * 3) * 0.05);
      this.circle(this.sel, P[i], P[i + 1], P[i + 2], r, WHITE, 0.9);
    }
    if (this.hoverStar !== null && this.hoverStar !== this.selStar) {
      const i = this.hoverStar * 3;
      const ppu = this.pxAt(P[i], P[i + 1], P[i + 2]);
      this.circle(this.sel, P[i], P[i + 1], P[i + 2], Math.max(36, 16 / ppu), WHITE, 0.4);
    }
    // Routes: our moving fleets (faint), selected fleet (solid), preview (dashed).
    this.routes.begin();
    this.routeSel.begin();
    this.preview.begin();
    const path = (b: SegBatch, from: { x: number; y: number; z: number }, stars: StarId[], c: THREE.Color, a: number) => {
      let cx = from.x, cy = from.y, cz = from.z, d = 0;
      for (const sid of stars) {
        const i = sid * 3;
        const len = Math.hypot(P[i] - cx, P[i + 1] - cy, P[i + 2] - cz);
        b.seg(cx, cy, cz, P[i], P[i + 1], P[i + 2], c, a, d, d + len);
        d += len;
        cx = P[i]; cy = P[i + 1]; cz = P[i + 2];
      }
      if (stars.length) this.circle(b, cx, cy, cz, Math.max(10, 7 / this.pxAt(cx, cy, cz)), c, a);
    };
    for (const f of Object.values(w.s.fleets)) {
      if (f.owner !== this.viewer || !f.route.length || f.id === this.selFleet) continue;
      path(this.routes, this.fleetTarget(f), f.route, ROUTE_OWN, 0.3);
    }
    const sf = this.selFleet !== null ? w.s.fleets[this.selFleet] : undefined;
    if (sf) {
      const d = this.fleets.get(sf.id);
      const p = d ?? this.fleetTarget(sf);
      this.circle(this.sel, p.x, p.y, p.z, 16 / this.pxAt(p.x, p.y, p.z), WHITE, 0.9, true);
      if (sf.route.length) path(this.routeSel, this.fleetTarget(sf), sf.route, ROUTE_SEL, 0.9);
      if (this.routePreview && this.routePreview.length) {
        const o = (sf.transit > 0 ? sf.route[0] : sf.star) * 3;
        path(this.preview, { x: P[o], y: P[o + 1], z: P[o + 2] }, this.routePreview, ROUTE_PREVIEW, 0.75 + 0.25 * Math.sin(t * 6));
        this.preview.mat.dashOffset = -t * 60;
      }
    }
    this.sel.end();
    this.routes.end();
    this.routeSel.end();
    this.preview.end();
  }

  private updateLabels() {
    const w = this.w!;
    const MAX = 320;
    const f0 = this.cssH() / (2 * TAN);
    const W = this.cssW(), H = this.cssH();
    const explored = w.s.empires[this.viewer]?.explored;
    let used = 0;
    if (this.showLabels) {
      const n = w.s.stars.length;
      for (let i = 0; i < n && used < MAX; i++) {
        const depth = this.screen[i * 3 + 2];
        if (depth <= 0) continue;
        const ppu = f0 / depth;
        if (ppu < 0.22) continue;
        const x = this.screen[i * 3], y = this.screen[i * 3 + 1];
        if (x < -100 || x > W + 100 || y < -60 || y > H + 60) continue;
        let el = this.labels[used];
        if (!el) {
          el = document.createElement('div');
          el.style.cssText = 'position:absolute;left:0;top:0;white-space:nowrap;font:600 16px "Chakra Petch",system-ui,sans-serif;text-shadow:0 0 3px #000,0 0 6px #000,0 1px 2px #000;transform-origin:0 0;will-change:transform;';
          this.overlay.appendChild(el);
          this.labels.push(el);
        }
        const name = w.s.stars[i].name;
        if (el.textContent !== name) el.textContent = name;
        const col = this.labelColor[i];
        if (el.dataset.c !== col) { el.dataset.c = col; el.style.color = col; }
        const ex = explored ? explored[i] : 2;
        const fade = Math.min(1, (ppu - 0.22) / 0.08);
        el.style.opacity = String((ex === 0 ? 0.35 : ex === 1 ? 0.7 : 1) * fade);
        const s = Math.min(1.05, Math.max(0.5, ppu / 0.55));
        el.style.transform = `translate(${x.toFixed(1)}px,${(y + Math.max(9, 24 * ppu)).toFixed(1)}px) scale(${s.toFixed(3)}) translateX(-50%)`;
        el.style.display = '';
        used++;
      }
    }
    for (let i = used; i < this.labels.length; i++) {
      if (this.labels[i].style.display !== 'none') this.labels[i].style.display = 'none';
    }
  }
}

// A single star system in 3D: star, orbiting planets, orbital structures and
// the fleets parked in the system. Pure three.js; the Preact overlay
// (ui/hud/SystemView3D.tsx) hosts it and draws HTML labels from `anchors()`.

import * as THREE from 'three';
import { createStage, starfield, makeStar, makePlanet, shipModel, stationModel, OrbitRig, glowSprite, type Stage } from './common';
import type { World } from '../sim/world';
import type { Fleet, Planet } from '../sim/types';
import { fleetVisible } from '../sim/visibility';
import { SPECIES_BY_ID } from '../sim/content';

export type SystemPick = { kind: 'planet' | 'fleet'; id: number };

export interface SystemAnchor {
  key: string;
  kind: 'planet' | 'fleet';
  id: number;
  x: number;
  y: number;
  visible: boolean;
}

export interface SystemSceneOpts {
  onPlanet?: (id: number) => void;
  onFleet?: (id: number) => void;
  /** Hovered object (null when nothing), with client coordinates for tooltips. */
  onHover?: (pick: SystemPick | null, clientX: number, clientY: number) => void;
  /** Called after each rendered frame (label positioning). */
  onFrame?: () => void;
}

/** Orbital building id → station model kind. */
export const STATION_KIND: Record<string, string> = {
  shipyard: 'shipyard', docks: 'docks', missilebase: 'missile', lance: 'lance', heavylance: 'lance',
  orbshield: 'shield', megashield: 'shield', solararray: 'solar', researchstation: 'research', habring: 'habitat',
};

const HULL_LEN: Record<string, number> = { small: 0.9, medium: 1.15, large: 1.45, enormous: 1.85, titan: 2.3 };
const MAX_SHIPS_SHOWN = 12;
const STAR_R = 2.4;

export const orbitRadius = (orbit: number) => 10 + orbit * 5.5;
export const planetRadius = (size: number) => 0.55 + size * 0.28;

/** Deterministic 0..1 hash so layouts are stable between openings. */
function hash01(n: number) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** Scale an arbitrary model so its largest dimension is `size`, centered on the origin. */
export function fitModel(obj: THREE.Object3D, size: number, base = false) {
  const box = new THREE.Box3().setFromObject(obj);
  const dim = box.getSize(new THREE.Vector3());
  const max = Math.max(dim.x, dim.y, dim.z) || 1;
  const k = size / max;
  const c = box.getCenter(new THREE.Vector3());
  const wrap = new THREE.Group();
  obj.scale.multiplyScalar(k);
  obj.position.set(-c.x * k, base ? -box.min.y * k : -c.y * k, -c.z * k);
  wrap.add(obj);
  return wrap;
}

/** Dispose geometries and materials below `root` (textures are shared caches and left alone). */
export function disposeTree(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!o.userData.sharedGeometry) m.geometry?.dispose?.();
    const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
    for (const mat of mats) (mat as THREE.Material).dispose();
  });
}

function circleLine(radius: number, color: THREE.ColorRepresentation, opacity: number, segments = 160) {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius));
  }
  const g = new THREE.BufferGeometry().setFromPoints(pts);
  return new THREE.LineLoop(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
}

function hitSphere(radius: number) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(radius, 12, 8), new THREE.MeshBasicMaterial());
  m.visible = false; // Raycasting still tests invisible meshes.
  return m;
}

interface PlanetNode {
  p: Planet;
  root: THREE.Group; // positioned on the orbit each frame
  body: THREE.Object3D;
  ring: THREE.LineLoop;
  halo: THREE.Sprite;
  orbitals: THREE.Group;
  hit: THREE.Mesh;
  radius: number;
  orbitR: number;
  angle0: number;
  speed: number;
  ownerSig: string;
  orbSig: string;
}

interface FleetNode {
  id: number;
  root: THREE.Group;
  ships: THREE.Group;
  hit: THREE.Mesh;
  sig: string;
  slot: number;
  phase: number;
}

export class SystemScene {
  private stage: Stage;
  private rig: OrbitRig;
  private planets = new Map<number, PlanetNode>();
  private fleets = new Map<number, FleetNode>();
  private hover: SystemPick | null = null;
  private hoverRing: THREE.Mesh;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private pointerIn = false;
  private lastClient = { x: 0, y: 0 };
  private clock = new THREE.Clock();
  private t = 0;
  private frames = 0;
  private raf = 0;
  private disposed = false;
  private fleetLayer = new THREE.Group();
  private tmp = new THREE.Vector3();

  constructor(host: HTMLElement, private starId: number, world: World, private opts: SystemSceneOpts = {}) {
    this.stage = createStage(host, { fov: 42, far: 6000 });
    const { scene, camera, renderer } = this.stage;
    scene.add(starfield(2600, 2000));
    scene.add(new THREE.AmbientLight(0x8090b0, 0.35));
    scene.add(new THREE.HemisphereLight(0x5a70a8, 0x0a0a14, 0.25));

    const star = world.s.stars[starId];
    const sun = makeStar(star.cls, STAR_R);
    const light = sun.children.find((c) => (c as THREE.PointLight).isPointLight) as THREE.PointLight | undefined;
    if (light) light.intensity = 4;
    scene.add(sun);
    scene.add(this.fleetLayer);

    // Hover highlight: a thin ring that always faces the camera.
    this.hoverRing = new THREE.Mesh(
      new THREE.RingGeometry(1, 1.08, 64),
      new THREE.MeshBasicMaterial({ color: 0x7fdcff, transparent: true, opacity: 0.85, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }),
    );
    this.hoverRing.visible = false;
    this.hoverRing.renderOrder = 10;
    scene.add(this.hoverRing);

    this.rig = new OrbitRig(camera, renderer.domElement);
    this.rig.pitch = 0.72;
    this.rig.minDist = 6;
    this.rig.maxDist = 400;
    this.update(world);
    const outer = Math.max(20, ...[...this.planets.values()].map((n) => n.orbitR));
    this.rig.dist = outer * 2.0;
    this.rig.update();

    const el = renderer.domElement;
    el.style.cursor = 'grab';
    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('pointerleave', this.onLeave);
    el.addEventListener('pointerup', this.onUp);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.raf = requestAnimationFrame(this.frame);
  }

  // --- sync with the simulation ------------------------------------------------

  update(w: World) {
    if (this.disposed) return;
    const star = w.s.stars[this.starId];
    const human = w.human();
    const explored = !human || human.explored[this.starId] === 2;

    // Planets (the list never changes, but ownership and orbitals do).
    if (explored) for (const pid of star.planets) {
      const p = w.s.planets[pid];
      let n = this.planets.get(pid);
      if (!n) n = this.addPlanet(p);
      const owner = p.owner !== null ? w.s.empires[p.owner] : null;
      const ownerSig = owner ? `${owner.id}:${owner.color}` : '';
      if (ownerSig !== n.ownerSig) {
        n.ownerSig = ownerSig;
        const ringMat = n.ring.material as THREE.LineBasicMaterial;
        ringMat.color.set(owner ? owner.color : 0x8aa0d0);
        ringMat.opacity = owner ? 0.42 : 0.13;
        n.halo.visible = !!owner;
        if (owner) (n.halo.material as THREE.SpriteMaterial).color.set(owner.color);
      }
      const orbSig = p.orbitals.map((o) => o?.id ?? '').join(',') + '|' + (owner?.color ?? '');
      if (orbSig !== n.orbSig) {
        n.orbSig = orbSig;
        this.buildOrbitals(n, p, owner?.color ?? '#9aa6c0');
      }
    }

    // Fleets parked here and visible to the player.
    const fleets = w.fleetsAtStar(this.starId).filter((f) => f.transit === 0 && (!human || fleetVisible(w, human.id, f)));
    const alive = new Set(fleets.map((f) => f.id));
    for (const [id, node] of this.fleets) {
      if (!alive.has(id)) {
        this.fleetLayer.remove(node.root);
        disposeTree(node.root);
        this.fleets.delete(id);
        if (this.hover?.kind === 'fleet' && this.hover.id === id) this.setHover(null);
      }
    }
    fleets.forEach((f, slot) => {
      const sig = this.fleetSig(w, f);
      const old = this.fleets.get(f.id);
      if (old && old.sig === sig) { old.slot = slot; return; }
      if (old) { this.fleetLayer.remove(old.root); disposeTree(old.root); }
      this.fleets.set(f.id, this.addFleet(w, f, sig, slot));
    });
    this.layoutFleets();
  }

  private addPlanet(p: Planet): PlanetNode {
    const { scene } = this.stage;
    const radius = planetRadius(p.size);
    const orbitR = orbitRadius(p.orbit);
    const root = new THREE.Group();
    const body = makePlanet(p.type, p.id * 7919 + 13, radius);
    body.rotation.z = (hash01(p.id + 5) - 0.5) * 0.5;
    root.add(body);
    const halo = glowSprite(0xffffff, radius * 4.4, 0.22);
    halo.visible = false;
    root.add(halo);
    const orbitals = new THREE.Group();
    root.add(orbitals);
    const hit = hitSphere(Math.max(radius * 1.35, 1.3));
    hit.userData.pick = { kind: 'planet', id: p.id } satisfies SystemPick;
    root.add(hit);
    scene.add(root);
    const ring = circleLine(orbitR, 0x8aa0d0, 0.13);
    scene.add(ring);
    const n: PlanetNode = {
      p, root, body, ring, halo, orbitals, hit, radius, orbitR,
      angle0: hash01(p.id) * Math.PI * 2,
      speed: 0.022 / Math.pow(orbitR / 10, 1.5),
      ownerSig: '-', orbSig: '-',
    };
    this.planets.set(p.id, n);
    return n;
  }

  private buildOrbitals(n: PlanetNode, p: Planet, color: string) {
    for (const c of [...n.orbitals.children]) { n.orbitals.remove(c); disposeTree(c); }
    const list = p.orbitals.filter((o): o is NonNullable<typeof o> => !!o);
    const r = n.radius * 1.9 + 0.35;
    n.orbitals.rotation.x = 0.25;
    list.forEach((o, k) => {
      const slot = new THREE.Group();
      const a = (k / list.length) * Math.PI * 2;
      slot.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
      slot.rotation.y = -a;
      n.orbitals.add(slot);
      const kind = STATION_KIND[o.id] ?? 'shipyard';
      void stationModel(kind, color).then((m) => {
        if (this.disposed || !slot.parent) { disposeTree(m); return; }
        slot.add(fitModel(m, 0.5 + n.radius * 0.15));
      });
    });
  }

  private fleetSig(w: World, f: Fleet) {
    const o = w.s.empires[f.owner];
    return `${o.color}|${f.ships.slice(0, MAX_SHIPS_SHOWN).map((id) => w.s.ships[id]?.hull ?? 'small').join(',')}`;
  }

  private addFleet(w: World, f: Fleet, sig: string, slot: number): FleetNode {
    const owner = w.s.empires[f.owner];
    const style = SPECIES_BY_ID[owner.species]?.style ?? 0;
    const root = new THREE.Group();
    const ships = new THREE.Group();
    root.add(ships);
    // Owner marker under the formation.
    const marker = new THREE.Mesh(
      new THREE.RingGeometry(1.75, 1.85, 48),
      new THREE.MeshBasicMaterial({ color: owner.color, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false }),
    );
    marker.rotation.x = -Math.PI / 2;
    marker.position.y = -0.5;
    root.add(marker);
    const hit = hitSphere(2.1);
    hit.userData.pick = { kind: 'fleet', id: f.id } satisfies SystemPick;
    root.add(hit);

    const shown = f.ships.slice(0, MAX_SHIPS_SHOWN);
    shown.forEach((sid, k) => {
      const hull = w.s.ships[sid]?.hull ?? 'small';
      const len = HULL_LEN[hull] ?? 1.15;
      // Chevron formation, lead ship at the front.
      const row = Math.ceil(k / 2), side = k === 0 ? 0 : k % 2 ? 1 : -1;
      const holder = new THREE.Group();
      holder.position.set(-row * 1.1, (hash01(sid) - 0.5) * 0.35, side * row * 0.95);
      holder.userData.bob = hash01(sid + 3) * Math.PI * 2;
      holder.userData.baseY = holder.position.y;
      ships.add(holder);
      const eng = glowSprite(0x7fdcff, len * 0.9, 0.8);
      eng.position.x = -len * 0.55;
      holder.add(eng);
      void shipModel(style, hull, owner.color).then((m) => {
        if (this.disposed || !holder.parent) { disposeTree(m); return; }
        holder.add(fitModel(m, len));
      });
    });
    // Center the formation on the group origin.
    const rows = Math.ceil((shown.length - 1) / 2);
    ships.position.x = rows * 0.55;
    this.fleetLayer.add(root);
    return { id: f.id, root, ships, hit, sig, slot, phase: hash01(f.id) * Math.PI * 2 };
  }

  private layoutFleets() {
    // Park fleets on an arc just outside the star's glow, facing along the arc.
    const count = this.fleets.size;
    for (const n of this.fleets.values()) {
      const r = 7.4 + Math.floor(n.slot / 10) * 3.4;
      const a = Math.PI / 2 - ((n.slot % 10) - Math.min(count - 1, 9) / 2) * 0.72;
      n.root.position.set(Math.cos(a) * r, 1.6, Math.sin(a) * r);
      n.root.rotation.y = -a - Math.PI / 2; // nose (+X) along the orbital tangent
      n.root.userData.baseY = 1.6;
    }
  }

  // --- interaction ------------------------------------------------------------

  private pickAt(clientX: number, clientY: number): SystemPick | null {
    const el = this.stage.renderer.domElement;
    const r = el.getBoundingClientRect();
    this.pointer.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.stage.camera);
    const targets: THREE.Object3D[] = [];
    for (const n of this.planets.values()) targets.push(n.hit);
    for (const n of this.fleets.values()) targets.push(n.hit);
    const hits = this.raycaster.intersectObjects(targets, false);
    return (hits[0]?.object.userData.pick as SystemPick | undefined) ?? null;
  }

  private setHover(p: SystemPick | null) {
    const same = p?.kind === this.hover?.kind && p?.id === this.hover?.id;
    this.hover = p;
    this.stage.renderer.domElement.style.cursor = p ? 'pointer' : 'grab';
    if (!same || p) this.opts.onHover?.(p, this.lastClient.x, this.lastClient.y);
  }

  private onMove = (e: PointerEvent) => {
    this.pointerIn = true;
    this.lastClient = { x: e.clientX, y: e.clientY };
    if (e.buttons) return; // dragging the camera
    this.setHover(this.pickAt(e.clientX, e.clientY));
  };

  private onLeave = () => {
    this.pointerIn = false;
    this.setHover(null);
  };

  private onUp = (e: PointerEvent) => {
    if (this.rig.moved > 5 || e.button !== 0) return;
    const p = this.pickAt(e.clientX, e.clientY);
    if (!p) return;
    if (p.kind === 'planet') this.opts.onPlanet?.(p.id);
    else this.opts.onFleet?.(p.id);
  };

  private onVisibility = () => {
    if (!document.hidden && !this.disposed) {
      cancelAnimationFrame(this.raf);
      this.clock.getDelta();
      this.raf = requestAnimationFrame(this.frame);
    }
  };

  // --- per frame --------------------------------------------------------------

  private frame = () => {
    if (this.disposed || (document.hidden && this.frames > 0)) return; // first frame always renders; resumed by visibilitychange
    const dt = Math.min(0.1, this.clock.getDelta());
    this.t += dt;
    const t = this.t;
    for (const n of this.planets.values()) {
      const a = n.angle0 + t * n.speed;
      n.root.position.set(Math.cos(a) * n.orbitR, 0, Math.sin(a) * n.orbitR);
      n.body.rotation.y += dt * 0.12;
      n.orbitals.rotation.y += dt * 0.25;
    }
    for (const n of this.fleets.values()) {
      n.root.position.y = (n.root.userData.baseY ?? 1.6) + Math.sin(t * 0.9 + n.phase) * 0.12;
      for (const h of n.ships.children) h.position.y = (h.userData.baseY ?? 0) + Math.sin(t * 1.4 + (h.userData.bob ?? 0)) * 0.06;
    }
    // Keep hover in sync while things orbit under a still cursor.
    if (this.pointerIn && !this.rig.moved) {
      const p = this.pickAt(this.lastClient.x, this.lastClient.y);
      if (p?.kind !== this.hover?.kind || p?.id !== this.hover?.id) this.setHover(p);
    }
    this.placeHoverRing();
    this.stage.render();
    this.frames++;
    this.opts.onFrame?.();
    this.raf = requestAnimationFrame(this.frame);
  };

  private placeHoverRing() {
    const h = this.hover;
    const ring = this.hoverRing;
    if (!h) { ring.visible = false; return; }
    let pos: THREE.Vector3 | null = null, r = 1;
    if (h.kind === 'planet') {
      const n = this.planets.get(h.id);
      if (n) { pos = n.root.position; r = n.radius * 1.45; }
    } else {
      const n = this.fleets.get(h.id);
      if (n) { pos = n.root.position; r = 2.2; }
    }
    if (!pos) { ring.visible = false; return; }
    ring.visible = true;
    ring.position.copy(pos);
    ring.scale.setScalar(r * (1 + Math.sin(this.t * 4) * 0.03));
    ring.quaternion.copy(this.stage.camera.quaternion);
  }

  /** Screen-space label anchors (CSS pixels relative to the host). */
  anchors(): SystemAnchor[] {
    const { camera, host } = this.stage;
    const w = host.clientWidth, h = host.clientHeight;
    const out: SystemAnchor[] = [];
    const project = (v: THREE.Vector3) => {
      this.tmp.copy(v).project(camera);
      return { x: (this.tmp.x * 0.5 + 0.5) * w, y: (-this.tmp.y * 0.5 + 0.5) * h, visible: this.tmp.z < 1 && Math.abs(this.tmp.x) < 1.1 && Math.abs(this.tmp.y) < 1.1 };
    };
    for (const n of this.planets.values()) {
      const v = n.root.position.clone();
      v.y -= n.radius * 1.25;
      out.push({ key: 'p' + n.p.id, kind: 'planet', id: n.p.id, ...project(v) });
    }
    for (const n of this.fleets.values()) {
      const v = n.root.position.clone();
      v.y += 1.5;
      out.push({ key: 'f' + n.id, kind: 'fleet', id: n.id, ...project(v) });
    }
    return out;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    const el = this.stage.renderer.domElement;
    el.removeEventListener('pointermove', this.onMove);
    el.removeEventListener('pointerleave', this.onLeave);
    el.removeEventListener('pointerup', this.onUp);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.rig.dispose();
    this.stage.dispose();
    this.planets.clear();
    this.fleets.clear();
  }
}

// Optional classic art, upscaled from the player's own copy of the 1995 game by
// tools/import_classic.py into public/classic/. Everything here degrades
// gracefully to procedural art when the folder is missing.

import type { StarClass } from '../sim/types';

interface Manifest { version: number; [k: string]: unknown }

let manifest: Manifest | null = null;
let enabled = true;
const base = './classic/';

export async function loadClassic(): Promise<boolean> {
  try {
    const r = await fetch(base + 'manifest.json', { cache: 'no-cache' });
    if (!r.ok) return false;
    const m = (await r.json()) as Manifest;
    manifest = m && typeof m.version === 'number' ? m : null;
  } catch {
    manifest = null;
  }
  return !!manifest;
}

export function classicAvailable() {
  return !!manifest;
}

export function setClassicEnabled(v: boolean) {
  enabled = v;
}

function has(sub: string, name: string) {
  if (!manifest || !enabled) return false;
  const list = manifest[sub];
  return Array.isArray(list) && list.includes(name);
}

const pad = (n: number) => String(n).padStart(2, '0');

// Original planet type order: husk, primordial, congenial, eden, mining, supermining,
// chapel, cathedral, rich, tycoon, cornucopia.
const PLANET_INDEX: Record<string, number> = {
  barren: 0, primordial: 1, temperate: 2, garden: 3, ore: 4, deepore: 5, resonant: 6, sanctum: 7, rich: 8, opulent: 9, paragon: 10,
};

export function classicPlanet(type: string): string | null {
  const i = PLANET_INDEX[type];
  return i !== undefined && has('planets', `t${pad(i)}`) ? `${base}planets/t${pad(i)}.png` : null;
}

const SUN_INDEX: Partial<Record<StarClass, number>> = { O: 0, B: 4, A: 5, F: 7, G: 3, K: 8, M: 2, WD: 10, NS: 11 };

export function classicSun(cls: StarClass): string | null {
  const i = SUN_INDEX[cls];
  return i !== undefined && has('suns', `s${pad(i)}`) ? `${base}suns/s${pad(i)}.png` : null;
}

export function classicPortrait(index: number): string | null {
  return has('portraits', `r${pad(index)}`) ? `${base}portraits/r${pad(index)}.png` : null;
}

export function classicFace(index: number): string | null {
  return has('faces', `r${pad(index)}`) ? `${base}faces/r${pad(index)}.png` : null;
}

const HULL_INDEX: Record<string, number> = { small: 0, medium: 1, large: 2, enormous: 3, titan: 3 };

export function classicShip(raceIndex: number, hull: string): string | null {
  const k = HULL_INDEX[hull] ?? 1;
  return has('ships', `r${pad(raceIndex)}_${k}`) ? `${base}ships/r${pad(raceIndex)}_${k}.png` : null;
}

export function classicDesign(raceIndex: number, hull: string): string | null {
  const k = HULL_INDEX[hull] ?? 1;
  return has('designs', `r${pad(raceIndex)}_${k}`) ? `${base}designs/r${pad(raceIndex)}_${k}.png` : null;
}

// planitem.shp frame order follows the original building list.
const BUILDING_INDEX: Record<string, number> = {
  factory: 0, agridome: 1, lab: 2, habitat: 3, metroplex: 4, colonybase: 5, megaplex: 6, hydrospire: 7, campus: 8,
  retreat: 10, surfcloak: 11, fusionhub: 12, biosphere: 13, datasphere: 14, cloningvats: 15, observatory: 16, garrison: 17,
  surfshield: 18, shipyard: 22, docks: 24, orbshield: 26, megashield: 27, missilebase: 28, lance: 29, heavylance: 30,
  excavation: 38, solararray: 25, researchstation: 23, habring: 20,
  // projects / actions
  'project:outreach': 31, 'project:convoy': 32, 'project:festival': 33, 'project:grants': 34, 'action:automate': 35, 'action:terraform': 36,
};

export function classicBuilding(id: string): string | null {
  const i = BUILDING_INDEX[id];
  return i !== undefined && has('buildings', `b${pad(i)}`) ? `${base}buildings/b${pad(i)}.png` : null;
}

// gizmos.shp frame order follows the original gizmo list.
const PART_INDEX: Record<string, number> = {
  massdriver: 0, seeker: 1, disruptor: 3, pulser: 4, plasma: 5, ultralaser: 6, lens: 7, hypersphere: 8, nanodis: 9,
  ionveil: 10, deflector: 11, phase: 12, resonance: 13, nullfield: 15,
  iondrive: 16, warpcoil: 17, gravdrive: 18, hyperdrive: 19, nanodrive: 20,
  surveyarray: 21, deepscan: 22, megascan: 25,
  fission: 27, fusioncore: 28, hypercore: 29, zeropoint: 30, nanoenergon: 31,
  cloakfield: 42, stabilizer: 43, tractor: 52, repairdrones: 58, colonymod: 70, outpostkit: 70, invasionmod: 72, jammer: 34,
  armor: 68, neutronium: 75,
};

export function classicPart(id: string): string | null {
  const i = PART_INDEX[id];
  return i !== undefined && has('parts', `g${pad(i)}`) ? `${base}parts/g${pad(i)}.png` : null;
}

export function classicNebula(i: number): string | null {
  return has('nebulae', `n${pad(i)}`) ? `${base}nebulae/n${pad(i)}.png` : null;
}

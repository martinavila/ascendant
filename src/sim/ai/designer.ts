import { HULLS, PARTS, HULL } from '../content';
import type { EmpireId, PartDef, ShipDesign } from '../types';
import type { World } from '../world';

export type DesignRole = NonNullable<ShipDesign['role']>;

/** Parts known to an empire, grouped and sorted best-first (newest tech wins ties). */
export function bestParts(w: World, e: EmpireId) {
  const known = PARTS.filter((p) => w.knows(e, p.tech));
  const by = (cat: string, score: (p: PartDef) => number) => known.filter((p) => p.category === cat).sort((a, b) => score(b) - score(a));
  return {
    weapons: by('weapon', (p) => (p.damage! * p.shots! * (1 + p.range! / 1200)) / (p.power + 1.5)),
    shields: by('shield', (p) => p.strength! / (p.power + 1)),
    drives: by('drive', (p) => p.speed! * 10 - p.power),
    generators: by('generator', (p) => p.power),
    scanners: by('scanner', (p) => p.scan!),
    armor: known.filter((p) => p.special === 'armor').sort((a, b) => b.hp! - a.hp!),
    special: (k: string) => known.find((p) => p.special === k),
  };
}

export function bestHull(w: World, e: EmpireId, role: DesignRole) {
  const hulls = HULLS.filter((h) => w.knows(e, h.tech));
  if (role === 'scout') return HULL.small;
  if (role === 'colony' || role === 'outpost') return hulls.find((h) => h.id === 'medium') ?? hulls[0];
  if (role === 'invader') return hulls[Math.min(hulls.length - 1, 2)] ?? hulls[hulls.length - 1];
  return hulls[hulls.length - 1];
}

/** Build a sensible parts list for a role. Guarantees a drive and enough power. */
export function autoDesign(w: World, e: EmpireId, role: DesignRole, hullId?: string): { hull: string; parts: string[] } {
  const hull = hullId ? HULL[hullId] : bestHull(w, e, role);
  const bp = bestParts(w, e);
  const parts: string[] = [];
  const drive = bp.drives[0];
  const gen = bp.generators[0];
  const slots = hull.slots;
  const powerOf = (ids: string[]) => {
    let sup = 0, use = 0;
    for (const id of ids) {
      const p = PARTS.find((x) => x.id === id)!;
      if (p.category === 'generator') sup += p.power; else use += p.power;
    }
    return { sup, use };
  };
  const add = (id: string | undefined) => {
    if (!id || parts.length >= slots) return false;
    parts.push(id);
    // Keep power balanced: add a generator whenever demand exceeds supply.
    const { sup, use } = powerOf(parts);
    if (use > sup && parts.length < slots) parts.push(gen.id);
    else if (use > sup) { parts.pop(); return false; }
    return true;
  };
  // Drives: target speed ~1.2 (scouts faster).
  const targetSpeed = role === 'scout' ? 2 : role === 'warship' ? 1.1 : 1.2;
  const drivesNeeded = Math.max(1, Math.ceil((hull.mass * targetSpeed) / drive.speed!));
  const moduleFor: Partial<Record<DesignRole, string>> = { colony: 'colony', outpost: 'outpost', invader: 'invasion' };
  if (moduleFor[role]) {
    const mod = bp.special(moduleFor[role]!);
    if (mod) {
      const count = role === 'invader' ? Math.max(1, Math.floor(slots / 3)) : 1;
      for (let i = 0; i < count; i++) add(mod.id);
    }
  }
  for (let i = 0; i < drivesNeeded; i++) add(drive.id);
  const stab = bp.special('laneDrive');
  if (stab && role !== 'colony' && slots >= 8) add(stab.id);
  if (role === 'scout') {
    add(bp.scanners[0]?.id);
    const cloak = bp.special('cloak');
    if (cloak) add(cloak.id);
  }
  if (role === 'warship') {
    const weapon = bp.weapons[0];
    const shield = bp.shields[0];
    const extras = ['repair', 'tractor', 'jammer'].map((k) => bp.special(k)).filter(Boolean) as PartDef[];
    if (slots >= 12) for (const x of extras.slice(0, slots >= 18 ? 2 : 1)) add(x.id);
    if (bp.scanners[0] && slots >= 12) add(bp.scanners[0].id);
    let k = 0;
    while (parts.length < slots - 1) {
      const ok = k % 4 === 3 && shield ? add(shield.id) : add(weapon?.id);
      if (!ok && !add(bp.armor[0]?.id)) break;
      k++;
    }
  }
  if (role === 'invader' || role === 'colony' || role === 'outpost') {
    if (bp.shields[0] && slots >= 8) add(bp.shields[0].id);
  }
  // Ensure at least one generator if anything draws power.
  const { sup, use } = powerOf(parts);
  if (use > sup && parts.length < slots) parts.push(gen.id);
  while (parts.length < slots && bp.armor[0]) parts.push(bp.armor[0].id);
  while (parts.length < slots) parts.push('');
  return { hull: hull.id, parts };
}

export function designScore(w: World, e: EmpireId, hull: string, parts: string[]) {
  const st = w.shipStats(e, hull, parts);
  return Math.sqrt(Math.max(0.1, st.attack) * (st.hp + st.shield * 4)) * (st.speed > 0 ? 1 : 0.1);
}

const ROLE_NAMES: Record<DesignRole, string[]> = {
  warship: ['Lancer', 'Warden', 'Paladin', 'Tempest', 'Dreadnought', 'Leviathan', 'Sovereign', 'Maelstrom', 'Harbinger', 'Colossus'],
  colony: ['Seedship', 'Ark', 'Settler', 'Pioneer', 'Homesteader'],
  outpost: ['Claimstake', 'Beacon', 'Waypost'],
  invader: ['Lander', 'Stormer', 'Vanguard', 'Siegebreaker'],
  scout: ['Pathfinder', 'Wayfarer', 'Farseer'],
  support: ['Tender'],
};

/** Keep one current design per role; returns the id to build for that role. */
export function ensureDesign(w: World, e: EmpireId, role: DesignRole): number {
  const s = w.s;
  const mine = Object.values(s.designs).filter((d) => d.owner === e && d.role === role && !d.obsolete);
  const fresh = autoDesign(w, e, role);
  const current = mine.sort((a, b) => b.created - a.created)[0];
  if (current) {
    const better = role === 'warship'
      ? designScore(w, e, fresh.hull, fresh.parts) > designScore(w, e, current.hull, current.parts) * 1.12
      : fresh.hull !== current.hull || w.shipStats(e, fresh.hull, fresh.parts).speed > w.shipStats(e, current.hull, current.parts).speed * 1.2;
    if (!better) return current.id;
    current.obsolete = true;
  }
  const names = ROLE_NAMES[role];
  const n = Object.values(s.designs).filter((d) => d.owner === e && d.role === role).length;
  const d: ShipDesign = { id: w.nextId(), owner: e, name: `${names[n % names.length]}${n >= names.length ? ' ' + (Math.floor(n / names.length) + 1) : ''}`, hull: fresh.hull, parts: fresh.parts, created: s.day, role };
  s.designs[d.id] = d;
  return d.id;
}

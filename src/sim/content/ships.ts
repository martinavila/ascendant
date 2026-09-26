import type { HullDef, PartDef } from '../types';

export const HULLS: HullDef[] = [
  { id: 'small', name: 'Small Hull', slots: 5, hp: 20, cost: 20, mass: 1 },
  { id: 'medium', name: 'Medium Hull', slots: 8, hp: 45, cost: 45, mass: 2 },
  { id: 'large', name: 'Large Hull', slots: 12, hp: 90, cost: 90, mass: 3, tech: 'largeconst' },
  { id: 'enormous', name: 'Enormous Hull', slots: 18, hp: 160, cost: 160, mass: 4, tech: 'megastruct' },
  { id: 'titan', name: 'Titan Hull', slots: 26, hp: 280, cost: 280, mass: 5, tech: 'colossal' },
];

export const PARTS: PartDef[] = [
  // Weapons — damage per shot, range in arena units, shots per round.
  { id: 'massdriver', name: 'Mass Driver', category: 'weapon', power: 1, cost: 12, damage: 2, range: 260, shots: 1, desc: 'Cheap kinetic slugs. Short range.' },
  { id: 'seeker', name: 'Seeker Missiles', category: 'weapon', power: 1, cost: 20, damage: 3, range: 420, shots: 1, tech: 'kinetics', desc: 'Guided missiles with good range.' },
  { id: 'disruptor', name: 'Molecular Disruptor', category: 'weapon', power: 2, cost: 36, damage: 6, range: 330, shots: 1, tech: 'explosives', desc: 'Corrodes hulls at the molecular level.' },
  { id: 'pulser', name: 'Pulse Emitter', category: 'weapon', power: 1, cost: 42, damage: 1, range: 350, shots: 5, tech: 'pulse', desc: 'Many weak hits; great against light shields, poor against heavy ones.' },
  { id: 'plasma', name: 'Plasma Cannon', category: 'weapon', power: 2, cost: 52, damage: 7, range: 680, shots: 1, tech: 'plasmatics', desc: 'Very long-range plasma bolts.' },
  { id: 'ultralaser', name: 'Ultralaser', category: 'weapon', power: 3, cost: 60, damage: 9, range: 380, shots: 2, tech: 'photonics', desc: 'Twin coherent beams.' },
  { id: 'lens', name: 'Refraction Lens', category: 'weapon', power: 0, cost: 60, damage: 6, range: 280, shots: 2, tech: 'photonics', desc: 'Focuses starlight. Needs no power at all.' },
  { id: 'hypersphere', name: 'Hypersphere Driver', category: 'weapon', power: 6, cost: 85, damage: 14, range: 520, shots: 2, tech: 'hypersphere', desc: 'Folds space around the target.' },
  { id: 'nanodis', name: 'Nanodisassembler', category: 'weapon', power: 6, cost: 100, damage: 18, range: 380, shots: 3, tech: 'nanoweapons', desc: 'The ultimate weapon.' },
  // Shields — absorb up to `strength` damage per round (regenerates).
  { id: 'ionveil', name: 'Ion Veil', category: 'shield', power: 1, cost: 10, strength: 2, tech: 'ion', desc: 'A thin ionized sheath.' },
  { id: 'deflector', name: 'Deflector', category: 'shield', power: 2, cost: 20, strength: 4, tech: 'deflectors', desc: 'Standard field shell.' },
  { id: 'phase', name: 'Phase Barrier', category: 'shield', power: 3, cost: 34, strength: 7, tech: 'phasebarrier', desc: 'Out-of-phase shielding.' },
  { id: 'resonance', name: 'Resonance Shell', category: 'shield', power: 4, cost: 50, strength: 11, tech: 'resonance', desc: 'Scatters incoming energy.' },
  { id: 'nullfield', name: 'Nullfield', category: 'shield', power: 5, cost: 70, strength: 16, tech: 'nullfield', desc: 'Near-total protection.' },
  // Drives — each point is speed; fleet speed = total drive / hull mass.
  { id: 'iondrive', name: 'Ion Drive', category: 'drive', power: 1, cost: 8, speed: 1, desc: 'Slow but reliable.' },
  { id: 'warpcoil', name: 'Warp Coil', category: 'drive', power: 2, cost: 15, speed: 2, tech: 'lanemech', desc: 'Rides the lane currents.' },
  { id: 'gravdrive', name: 'Gravitic Drive', category: 'drive', power: 2, cost: 26, speed: 3, tech: 'gravdrive', desc: 'Falls toward the destination.' },
  { id: 'hyperdrive', name: 'Hyperdrive', category: 'drive', power: 3, cost: 40, speed: 4, tech: 'hyperdrive', desc: 'Skips most of the trip.' },
  { id: 'nanodrive', name: 'Nanodrive', category: 'drive', power: 3, cost: 60, speed: 6, tech: 'nanodrive', desc: 'As fast as it gets.' },
  // Generators — supply power.
  { id: 'fission', name: 'Fission Pile', category: 'generator', power: 3, cost: 8, desc: 'Supplies 3 power.' },
  { id: 'fusioncore', name: 'Fusion Core', category: 'generator', power: 5, cost: 16, tech: 'supercond', desc: 'Supplies 5 power.' },
  { id: 'hypercore', name: 'Hyperpower Core', category: 'generator', power: 8, cost: 30, tech: 'hyperpower', desc: 'Supplies 8 power.' },
  { id: 'zeropoint', name: 'Zero-Point Tap', category: 'generator', power: 12, cost: 45, tech: 'zeropoint', desc: 'Supplies 12 power.' },
  { id: 'nanoenergon', name: 'Nanoenergon Cell', category: 'generator', power: 18, cost: 60, tech: 'nanoenergon', desc: 'Supplies 18 power.' },
  // Scanners — sensor range in map units.
  { id: 'surveyarray', name: 'Survey Array', category: 'scanner', power: 1, cost: 8, scan: 160, desc: 'Basic sensors.' },
  { id: 'deepscan', name: 'Deep Scanner', category: 'scanner', power: 1, cost: 18, scan: 320, tech: 'spectral', desc: 'Long-range sensors; also reveals cloaked ships nearby.' },
  { id: 'megascan', name: 'Megascanner', category: 'scanner', power: 2, cost: 36, scan: 520, tech: 'infiltration', desc: 'Sees nearly everything.' },
  // Specials
  { id: 'colonymod', name: 'Colony Module', category: 'special', power: 0, cost: 60, special: 'colony', consumable: true, desc: 'Founds a colony on any unclaimed planet. Consumed on use.' },
  { id: 'outpostkit', name: 'Outpost Kit', category: 'special', power: 0, cost: 30, special: 'outpost', consumable: true, tech: 'survey', desc: 'Claims a planet as an unpopulated outpost (orbitals only). Consumed on use.' },
  { id: 'invasionmod', name: 'Invasion Module', category: 'special', power: 0, cost: 40, special: 'invasion', consumable: true, tech: 'assault', desc: 'Troops for seizing an enemy planet once its defenses are down. Consumed on use.' },
  { id: 'armor', name: 'Armor Plating', category: 'special', power: 0, cost: 8, special: 'armor', hp: 10, desc: '+10 hull points.' },
  { id: 'neutronium', name: 'Neutronium Armor', category: 'special', power: 0, cost: 22, special: 'armor', hp: 28, tech: 'microbotics', desc: '+28 hull points.' },
  { id: 'repairdrones', name: 'Repair Drones', category: 'special', power: 1, cost: 30, special: 'repair', tech: 'planetarms', desc: 'Repairs 15% hull per day anywhere, and between combat rounds.' },
  { id: 'cloakfield', name: 'Cloaking Field', category: 'special', power: 3, cost: 40, special: 'cloak', tech: 'cloaking', desc: 'Fleet is invisible unless an enemy deep scanner is nearby. A fleet is only cloaked if every ship has one.' },
  { id: 'stabilizer', name: 'Lane Stabilizer', category: 'special', power: 1, cost: 20, special: 'laneDrive', tech: 'lanestab', desc: 'Lets the ship cross unstable (red) lanes. A fleet needs one on every ship.' },
  { id: 'tractor', name: 'Tractor Beam', category: 'special', power: 2, cost: 30, special: 'tractor', tech: 'gravity', desc: 'Stops enemies from retreating from battle.' },
  { id: 'jammer', name: 'Sensor Jammer', category: 'special', power: 1, cost: 26, special: 'jammer', tech: 'pulse', desc: 'Enemies targeting this ship hit 25% less often.' },
];

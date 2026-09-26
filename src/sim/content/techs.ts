import type { TechDef, TechCategory } from '../types';

const TIER_COST = [0, 150, 450, 1200, 3000, 7000, 15000, 28000, 55000];

function t(id: string, name: string, tier: number, category: TechCategory, prereqs: string[], desc: string, capstone = false): TechDef & { tier: number } {
  return { id, name, tier, category, prereqs, cost: TIER_COST[tier], desc, capstone };
}

export const TECHS = [
  // Tier 1
  t('orbital', 'Orbital Engineering', 1, 'industry', [], 'Stable construction in low orbit. Opens orbital slots to solar arrays and missile batteries.'),
  t('survey', 'Interstellar Survey', 1, 'propulsion', [], 'Systematic mapping of star lanes. Enables outposts on marginal worlds.'),
  t('xenobio', 'Exobiology', 1, 'biology', [], 'Life, but not as we know it. Better colonists and hardier crops.'),
  t('ion', 'Ion Containment', 1, 'energy', [], 'Charged-particle containment for power and protection.'),
  t('data', 'Data Lattices', 1, 'information', [], 'Crystalline storage that makes laboratories far more productive.'),
  // Tier 2
  t('lanemech', 'Lane Mechanics', 2, 'propulsion', ['survey'], 'The geometry of star lanes, and how to ride them faster.'),
  t('supercond', 'Lossless Conduction', 2, 'energy', ['ion'], 'Lossless current. Fusion becomes compact enough for ships.'),
  t('envseal', 'Environmental Sealing', 2, 'biology', ['xenobio', 'orbital'], 'Sealed habitats let colonies grow beyond what the land supports.'),
  t('kinetics', 'Guided Munitions', 2, 'military', ['orbital'], 'Smart ordnance for ships and orbital batteries.'),
  t('spectral', 'Stellar Spectroscopy', 2, 'information', ['data'], 'Read a star system from its light. Longer-range scanners.'),
  t('chemistry', 'Catalytic Chemistry', 2, 'industry', ['ion'], 'Catalysts and alloys for heavier industry.'),
  t('xenoarch', 'Xenoarchaeology', 2, 'xeno', ['xenobio'], 'Excavate the ruins of vanished civilizations. Each site holds a fixed secret.'),
  t('linguistics', 'Xenolinguistics', 2, 'information', ['data', 'xenobio'], 'Talk to aliens. Unlocks alliances and the Diplomatic Outreach project.'),
  t('assault', 'Assault Doctrine', 2, 'military', ['orbital', 'xenobio'], 'Boarding tactics and planetary landings. Invasion modules and garrisons.'),
  // Tier 3
  t('gravity', 'Graviton Mechanics', 3, 'propulsion', ['supercond', 'lanemech'], 'Local manipulation of gravity makes larger hulls feasible.'),
  t('explosives', 'Bond Cleavage', 3, 'military', ['chemistry', 'kinetics'], 'Weapons that unbind matter at the molecular level.'),
  t('hyperlogic', 'Manifold Logic', 3, 'information', ['spectral', 'data'], 'Many-valued logic engines. Research campuses.'),
  t('megafab', 'Recursive Fabrication', 3, 'industry', ['chemistry', 'orbital'], 'Factories that build factories. Megaplexes and orbital docks.'),
  t('hydroponics', 'Hydroponic Engineering', 3, 'biology', ['envseal'], 'Towering vertical farms feed booming populations.'),
  t('deflectors', 'Deflector Theory', 3, 'energy', ['supercond', 'kinetics'], 'Field shells that shrug off incoming fire, for ships and planets.'),
  t('lanestab', 'Lane Stabilization', 3, 'propulsion', ['lanemech', 'supercond'], 'Stabilizers let ships cross the treacherous unstable (red) lanes.'),
  t('cloaking', 'Refractive Optics', 3, 'information', ['spectral'], 'Bend light around a hull or a whole planet.'),
  t('advdiplo', 'Cultural Resonance', 3, 'xeno', ['linguistics'], 'Cultural exchange improves every relationship over time.'),
  t('fusion', 'Fusion Dynamics', 3, 'energy', ['supercond'], 'Fusion power at planetary scale.'),
  // Tier 4
  t('largeconst', 'Large-Scale Construction', 4, 'industry', ['gravity', 'megafab'], 'Large hulls and dense metroplexes.'),
  t('plasmatics', 'Plasma Containment', 4, 'military', ['explosives', 'deflectors'], 'Contained superheated plasma. Long-range cannons and lance platforms.'),
  t('automation', 'Autonomous Systems', 4, 'industry', ['hyperlogic', 'megafab'], 'Automate structures that are idle for lack of workers. Automated structures run at 75% and are marked with a gear.'),
  t('terraforming', 'Worldshaping', 4, 'biology', ['hydroponics', 'xenoarch'], 'Reclaim dead (black) tiles, one at a time.'),
  t('pulse', 'Electromagnetic Pulse', 4, 'military', ['explosives', 'spectral'], 'Rapid-fire disruptors and sensor jammers.'),
  t('hyperpower', 'Overdrive Power', 4, 'energy', ['fusion', 'megafab'], 'Hyperpower cores for ships and planet-wide industrial boosts.'),
  t('cloning', 'Tissue Replication', 4, 'biology', ['hydroponics', 'hyperlogic'], 'Cloning vats accelerate growth everywhere they are built.'),
  t('gravdrive', 'Gravitic Propulsion', 4, 'propulsion', ['gravity', 'lanestab'], 'Fall toward your destination.'),
  t('planetarms', 'Planetary Armaments', 4, 'military', ['kinetics', 'deflectors', 'gravity'], 'Heavy lance platforms and repair drones.'),
  // Tier 5
  t('megastruct', 'Megaconstruction', 5, 'industry', ['largeconst', 'automation'], 'Enormous hulls and orbital habitat rings.'),
  t('photonics', 'Phased Optics', 5, 'military', ['plasmatics', 'pulse'], 'Twin lancers and passive refraction lenses.'),
  t('hyperdrive', 'Skip Drive Theory', 5, 'propulsion', ['gravdrive', 'hyperpower'], 'Skip across lanes in a fraction of the time.'),
  t('phasebarrier', 'Phase Barriers', 5, 'energy', ['deflectors', 'hyperpower'], 'Shields that exist slightly out of phase with incoming fire.'),
  t('datasphere', 'Planetary Mindweb', 5, 'information', ['automation', 'hyperlogic'], 'A planet-wide thinking network boosts research by half.'),
  t('biosphere', 'Biosphere Engineering', 5, 'biology', ['terraforming', 'cloning'], 'Regulate an entire biosphere for explosive prosperity.'),
  t('infiltration', 'Remote Perception', 5, 'xeno', ['cloaking', 'advdiplo'], 'See what others see. Reveals rival research and plans.'),
  t('zeropoint', 'Zero-Point Energy', 5, 'energy', ['hyperpower', 'gravity'], 'Energy from the vacuum itself.'),
  t('microbotics', 'Swarm Engineering', 5, 'industry', ['automation', 'planetarms'], 'Swarms of tiny repair robots and neutronium armor.'),
  // Tier 6
  t('colossal', 'Colossal Architecture', 6, 'industry', ['megastruct', 'gravdrive'], 'Titan hulls: flying fortresses.'),
  t('hypersphere', 'Fold Geometry', 6, 'military', ['photonics', 'zeropoint'], 'Weapons that fold space around the target.'),
  t('resonance', 'Resonance Shells', 6, 'energy', ['phasebarrier', 'zeropoint'], 'Shields that ring like a bell and scatter energy.'),
  t('nanotech', 'Atomcraft', 6, 'information', ['microbotics', 'datasphere'], 'Engineering at the scale of single atoms.'),
  // Tier 7
  t('nanoweapons', 'Unmaking', 7, 'military', ['hypersphere', 'nanotech'], 'Disassemble enemy ships atom by atom.'),
  t('nullfield', 'Null Shells', 7, 'energy', ['resonance', 'nanotech'], 'The last word in defense.'),
  t('nanodrive', 'Picothrust', 7, 'propulsion', ['hyperdrive', 'nanotech'], 'The fastest drives possible.'),
  t('nanoenergon', 'Vacuum Cells', 7, 'energy', ['zeropoint', 'nanotech'], 'Power cells of absurd density.'),
  t('selfmod', 'Adaptive Architecture', 7, 'industry', ['nanotech', 'megastruct'], 'New structures come pre-automated.'),
  // Tier 8
  t('transcendence', 'Transcendence Theory', 8, 'xeno', ['nanotech', 'datasphere', 'biosphere', 'selfmod'], 'Understand what the ancients became. Unlocks the Ascension Gate — build it to win.', true),
];

export type TechWithTier = (typeof TECHS)[number];

import type { PlanetTypeDef, SpeciesDef } from '../types';

// Tile weights: [white, black, red(industry), green(prosperity), blue(research)]
export const PLANET_TYPES: PlanetTypeDef[] = [
  { id: 'barren', name: 'Barren', tiles: [55, 45, 0, 0, 0], growth: 1.8, popMul: 0.5, hue: 30, palette: 'rock', desc: 'A dead husk. Livable only with effort.' },
  { id: 'primordial', name: 'Primordial', tiles: [55, 28, 7, 6, 4], growth: 1.4, popMul: 0.7, hue: 15, palette: 'lava', desc: 'Young and volcanic, still cooling.' },
  { id: 'temperate', name: 'Temperate', tiles: [62, 14, 8, 11, 5], growth: 1.0, popMul: 1.0, hue: 120, palette: 'terran', desc: 'Oceans, continents, a breathable sky.' },
  { id: 'garden', name: 'Garden', tiles: [60, 5, 3, 28, 4], growth: 0.7, popMul: 1.4, hue: 100, palette: 'jungle', desc: 'A paradise of life. Rich in prosperity.' },
  { id: 'ore', name: 'Ore World', tiles: [45, 20, 30, 3, 2], growth: 1.3, popMul: 0.7, hue: 25, palette: 'desert', desc: 'Veins of metal near the surface. Rich in industry.' },
  { id: 'deepore', name: 'Deep-Ore World', tiles: [25, 20, 50, 3, 2], growth: 1.5, popMul: 0.6, hue: 5, palette: 'lava', desc: 'The richest mining in the galaxy.' },
  { id: 'resonant', name: 'Resonant World', tiles: [48, 18, 3, 3, 28], growth: 1.2, popMul: 0.8, hue: 200, palette: 'crystal', desc: 'Strange harmonics amplify thought. Rich in research.' },
  { id: 'sanctum', name: 'Sanctum', tiles: [30, 18, 2, 2, 48], growth: 1.3, popMul: 0.7, hue: 260, palette: 'crystal', desc: 'A world that seems built for scholars.' },
  { id: 'rich', name: 'Rich World', tiles: [50, 8, 14, 14, 14], growth: 0.9, popMul: 1.0, hue: 170, palette: 'ocean', desc: 'Balanced bounty.' },
  { id: 'opulent', name: 'Opulent World', tiles: [37, 5, 19, 20, 19], growth: 0.85, popMul: 1.1, hue: 45, palette: 'gold', desc: 'Remarkable in every way.' },
  { id: 'paragon', name: 'Paragon', tiles: [10, 0, 30, 30, 30], growth: 0.7, popMul: 1.3, hue: 300, palette: 'gold', desc: 'Legendary. Worth any war.' },
  { id: 'glacial', name: 'Glacial World', tiles: [50, 35, 5, 3, 7], growth: 1.6, popMul: 0.6, hue: 190, palette: 'ice', desc: 'Frozen oceans over warm depths.' },
  { id: 'toxic', name: 'Toxic World', tiles: [45, 40, 10, 0, 5], growth: 1.7, popMul: 0.5, hue: 75, palette: 'toxic', desc: 'Corrosive air, strange chemistry.' },
  { id: 'gasgiant', name: 'Gas Giant', tiles: [0, 100, 0, 0, 0], growth: 9, popMul: 0, hue: 35, palette: 'gas', desc: 'No surface at all — but double the orbital slots.' },
];

/** Upgrade path used by terraforming and the Cthari ability. */
export const TERRAFORM_NEXT: Record<string, string> = {
  barren: 'primordial', toxic: 'primordial', glacial: 'temperate', primordial: 'temperate', temperate: 'garden',
  ore: 'rich', resonant: 'rich', deepore: 'opulent', sanctum: 'opulent', rich: 'opulent', opulent: 'paragon',
};

export const SPECIES: SpeciesDef[] = [
  {
    id: 'oolari', name: 'Oolari', plural: 'Oolari', adjective: 'Oolari', trait: 'telepathic', color: '#b48cff', classicIndex: 18,
    traitDesc: 'Telepathic: meets every empire at the start; +10 attitude from everyone.',
    ability: { id: 'census', name: 'Psychic Census', desc: 'Chart every star in the galaxy.', cooldown: 360, target: 'none' },
    mult: { attitude: 10 }, favored: ['resonant', 'sanctum'], personality: 'diplomat',
    lore: 'Drifting gasbag minds who hear the thoughts of every species at once and find most of them tiresome.',
  },
  {
    id: 'grakk', name: 'Grakk', plural: 'Grakk', adjective: 'Grakk', trait: 'lithovore', color: '#d9823b', classicIndex: 2,
    traitDesc: 'Lithovores: +30% industry. Thrive on barren and ore worlds.',
    ability: { id: 'feast', name: 'Stone Feast', desc: 'Eat through the dead rock of one of your planets: every black tile becomes buildable.', cooldown: 240, target: 'planet' },
    mult: { ind: 1.3 }, favored: ['barren', 'ore', 'deepore'], personality: 'industrialist',
    lore: 'Slow, heavy, and hungry for minerals. Their cities are hollowed-out mountains.',
  },
  {
    id: 'mirrith', name: 'Mirrith', plural: 'Mirrith', adjective: 'Mirrithi', trait: 'laneFolder', color: '#46c7e6', classicIndex: 11,
    traitDesc: 'Lane-folders: ships cross unstable lanes freely and move 30% faster.',
    ability: { id: 'foldjump', name: 'Fold Jump', desc: 'Teleport one fleet to any star you have charted.', cooldown: 150, target: 'fleet' },
    mult: { speed: 1.3 }, favored: ['glacial', 'temperate'], personality: 'expansionist',
    lore: 'They perceive star lanes as folds in a sheet, and simply step across.',
  },
  {
    id: 'tessel', name: 'Tessel', plural: 'Tessel', adjective: 'Tesselate', trait: 'crystalline', color: '#8fe3c0', classicIndex: 3,
    traitDesc: 'Crystalline: structures and ships cost 20% less; research -10%.',
    ability: { id: 'bloom', name: 'Lattice Bloom', desc: 'Instantly complete the current construction on one planet (up to 600 industry).', cooldown: 120, target: 'planet' },
    mult: { cost: 0.8, res: 0.9 }, favored: ['resonant', 'glacial', 'barren'], personality: 'industrialist',
    lore: 'A lattice that grows and thinks. Every Tessel city is also a Tessel.',
  },
  {
    id: 'pheon', name: 'Pheon', plural: 'Pheon', adjective: 'Pheonic', trait: 'prolific', color: '#f06ba8', classicIndex: 6,
    traitDesc: 'Prolific: +50% prosperity.',
    ability: { id: 'brood', name: 'Brood Surge', desc: 'Every one of your planets gains +2 population (up to capacity).', cooldown: 200, target: 'none' },
    mult: { pro: 1.5 }, favored: ['garden', 'temperate', 'toxic'], personality: 'expansionist',
    lore: 'Joyful, numerous, and always somewhat underfoot.',
  },
  {
    id: 'zurvani', name: 'Zurvani', plural: 'Zurvani', adjective: 'Zurvani', trait: 'scholars', color: '#6f8cff', classicIndex: 9,
    traitDesc: 'Scholars: +35% research; ships have 15% less hull.',
    ability: { id: 'epiphany', name: 'Epiphany', desc: 'Gain half the cost of your current research instantly.', cooldown: 180, target: 'none' },
    mult: { res: 1.35, hp: 0.85 }, favored: ['sanctum', 'resonant'], personality: 'scientist',
    lore: 'Ascetic archivists who regard war as a failure of curiosity.',
  },
  {
    id: 'hkeet', name: 'Hkeet', plural: 'Hkeet', adjective: 'Hkeet', trait: 'raiders', color: '#e5484d', classicIndex: 4,
    traitDesc: 'Raiders: weapons deal 25% more damage.',
    ability: { id: 'frenzy', name: 'War Frenzy', desc: 'Instantly repair every one of your ships.', cooldown: 200, target: 'none' },
    mult: { damage: 1.25 }, favored: ['primordial', 'toxic', 'ore'], personality: 'militarist',
    lore: 'Pack hunters with a proud and extremely violent poetry.',
  },
  {
    id: 'luminar', name: 'Luminar', plural: 'Luminar', adjective: 'Luminari', trait: 'luminous', color: '#ffd84a', classicIndex: 20,
    traitDesc: 'Luminous: shields are 40% stronger.',
    ability: { id: 'flare', name: 'Solar Flare', desc: 'Scorch every enemy ship at a star you can see (40% of hull).', cooldown: 250, target: 'star' },
    mult: { shield: 1.4 }, favored: ['primordial', 'gasgiant', 'rich'], personality: 'opportunist',
    lore: 'Beings of structured plasma who remember being born in stars.',
  },
  {
    id: 'cthari', name: 'Cthari', plural: 'Cthari', adjective: 'Cthari', trait: 'terraformers', color: '#63c74d', classicIndex: 8,
    traitDesc: 'Terraformers: +2 capacity on every planet.',
    ability: { id: 'reshape', name: 'Reshape World', desc: 'Upgrade one of your planets to a better type.', cooldown: 300, target: 'planet' },
    mult: {}, favored: ['temperate', 'garden', 'toxic'], personality: 'expansionist',
    lore: 'Gardeners on a planetary scale, patient over centuries.',
  },
  {
    id: 'brool', name: 'Brool', plural: 'Brool', adjective: 'Broolish', trait: 'diplomats', color: '#f2a65a', classicIndex: 10,
    traitDesc: 'Diplomats: +25 attitude from everyone.',
    ability: { id: 'accord', name: 'Grand Accord', desc: 'One empire’s opinion of you improves by 40 for a year.', cooldown: 150, target: 'empire' },
    mult: { attitude: 25 }, favored: ['rich', 'opulent', 'temperate'], personality: 'diplomat',
    lore: 'Merchants and hosts. Everyone likes the Brool, eventually.',
  },
  {
    id: 'nyx', name: 'Nyx', plural: 'Nyx', adjective: 'Nyxian', trait: 'shadowed', color: '#9aa0b5', classicIndex: 0,
    traitDesc: 'Shadowed: your fleets are hidden unless a rival is at the same or an adjacent star.',
    ability: { id: 'unravel', name: 'Unravel', desc: 'Destroy a random structure on an enemy planet you can see.', cooldown: 180, target: 'planet' },
    mult: {}, favored: ['glacial', 'barren', 'toxic'], personality: 'opportunist',
    lore: 'No two accounts of the Nyx agree about what they look like.',
  },
  {
    id: 'oorm', name: 'Oorm', plural: 'Oorm', adjective: 'Oormish', trait: 'gardeners', color: '#b5e36b', classicIndex: 16,
    traitDesc: 'Seed-bearers: +25% prosperity, +10% research.',
    ability: { id: 'seed', name: 'Seedworld', desc: 'Colonize an unclaimed planet in a system you already hold, without a colony ship.', cooldown: 250, target: 'planet' },
    mult: { pro: 1.25, res: 1.1 }, favored: ['garden', 'temperate', 'rich'], personality: 'scientist',
    lore: 'Ambulatory forests who spread by seed pods fired into orbit.',
  },
];

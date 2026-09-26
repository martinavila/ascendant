import type { RngState } from './rng';

// ---------------------------------------------------------------------------
// Content (static, data-driven). IDs are string keys so mods/content packs can
// add entries without renumbering.
// ---------------------------------------------------------------------------

export type Yield = { ind: number; res: number; pro: number };

export type TileColor = 'white' | 'black' | 'red' | 'green' | 'blue';

export type TechCategory = 'energy' | 'industry' | 'biology' | 'information' | 'military' | 'propulsion' | 'xeno';

export interface TechDef {
  id: string;
  name: string;
  category: TechCategory;
  cost: number;
  prereqs: string[];
  desc: string;
  /** Final tech: unlocks the Ascension Gate victory project. */
  capstone?: boolean;
}

export type BuildingRole = 'industry' | 'research' | 'prosperity' | 'housing' | 'mixed' | 'defense' | 'special' | 'shipyard';

export interface BuildingDef {
  id: string;
  name: string;
  role: BuildingRole;
  orbital: boolean;
  yield: Yield;
  /** Extra population capacity. */
  housing: number;
  cost: number;
  tech?: string;
  /** Needs a worker (pop) unless automated. Orbital/defense buildings usually don't. */
  needsWorker: boolean;
  /** Only one allowed per planet. */
  unique?: boolean;
  /** Building this can replace (auto-upgrade chain). */
  upgrades?: string;
  /** Combat stats for orbital defenses. */
  defense?: { hp: number; shield?: number; damage?: number; range?: number; shots?: number };
  /** Planet-wide multiplier bonuses (e.g. +25% industry). */
  bonus?: Partial<Yield>;
  scan?: number;
  desc: string;
}

/** Repeatable "social projects" a planet can run when it has nothing to build. */
export interface ProjectDef {
  id: string;
  name: string;
  tech?: string;
  desc: string;
}

export type PartCategory = 'weapon' | 'shield' | 'drive' | 'generator' | 'scanner' | 'special';

export type SpecialKind =
  | 'colony' | 'outpost' | 'invasion' | 'repair' | 'cloak' | 'laneDrive' | 'tractor' | 'armor' | 'jammer' | 'survey';

export interface PartDef {
  id: string;
  name: string;
  category: PartCategory;
  /** Power drawn (or supplied, for generators). */
  power: number;
  cost: number;
  tech?: string;
  damage?: number;
  range?: number;
  shots?: number;
  strength?: number;
  speed?: number;
  scan?: number;
  special?: SpecialKind;
  /** Hit points added (armor). */
  hp?: number;
  /** Consumed on use (colony/outpost/invasion modules). */
  consumable?: boolean;
  desc: string;
}

export interface HullDef {
  id: string;
  name: string;
  slots: number;
  hp: number;
  cost: number;
  mass: number;
  tech?: string;
}

export interface PlanetTypeDef {
  id: string;
  name: string;
  /** Percent weights of tile colors: [white, black, red, green, blue]. */
  tiles: [number, number, number, number, number];
  /** Days per population growth at 1 prosperity. Lower = faster. */
  growth: number;
  /** Base population capacity multiplier. */
  popMul: number;
  desc: string;
  hue: number;
  palette: 'rock' | 'lava' | 'ocean' | 'terran' | 'jungle' | 'ice' | 'gas' | 'crystal' | 'desert' | 'toxic' | 'gold';
}

export type SpeciesTrait =
  | 'telepathic' | 'lithovore' | 'laneFolder' | 'crystalline' | 'prolific' | 'scholars' | 'raiders'
  | 'luminous' | 'terraformers' | 'diplomats' | 'shadowed' | 'gardeners';

export interface SpeciesDef {
  id: string;
  name: string;
  plural: string;
  adjective: string;
  trait: SpeciesTrait;
  traitDesc: string;
  ability: { id: string; name: string; desc: string; cooldown: number; target: 'none' | 'star' | 'planet' | 'fleet' | 'empire' };
  mult: Partial<{ ind: number; res: number; pro: number; hp: number; damage: number; shield: number; speed: number; cost: number; attitude: number }>;
  /** Planet types this species thrives on (+pop). */
  favored: string[];
  color: string;
  personality: AiPersonality;
  lore: string;
  classicIndex: number;
}

// ---------------------------------------------------------------------------
// Game state (serializable JSON).
// ---------------------------------------------------------------------------

export type EmpireId = number;
export type StarId = number;
export type PlanetId = number;
export type FleetId = number;
export type ShipId = number;
export type DesignId = number;

export type StarClass = 'O' | 'B' | 'A' | 'F' | 'G' | 'K' | 'M' | 'WD' | 'NS' | 'BH';

export interface Star {
  id: StarId;
  name: string;
  x: number;
  y: number;
  cls: StarClass;
  size: number;
  planets: PlanetId[];
  lanes: number[];
  /** Region/cluster index used for naming and AI sectoring. */
  region: number;
}

export interface Lane {
  id: number;
  a: StarId;
  b: StarId;
  length: number;
  /** Unstable lanes (the original's red links) need Lane Stabilizers or a lane-folding species. */
  unstable: boolean;
  /** Blockaded by an empire's lane blocker (future use). */
  blockedBy?: EmpireId;
}

export interface BuildingInst {
  id: string;
  /** Automated (roboticized): works without population. Rendered distinctly. */
  auto?: boolean;
}

export interface Tile {
  c: TileColor;
  b?: BuildingInst;
}

export type BuildItem =
  | { kind: 'building'; id: string; tile: number; orbital?: boolean; replace?: boolean }
  | { kind: 'ship'; design: DesignId; count?: number }
  | { kind: 'automate'; tile: number; orbital?: boolean }
  | { kind: 'terraform'; tile: number }
  | { kind: 'demolish'; tile: number; orbital?: boolean }
  | { kind: 'refit'; ship: ShipId; slot: number; part: string }
  | { kind: 'ascension' };

export type GovernorFocus = 'balanced' | 'industry' | 'research' | 'growth' | 'defense';

export interface Planet {
  id: PlanetId;
  star: StarId;
  orbit: number;
  name: string;
  type: string;
  size: number; // 0..4
  gridW: number;
  gridH: number;
  tiles: Tile[];
  orbitals: (BuildingInst | null)[];
  owner: EmpireId | null;
  pop: number;
  growth: number;
  progress: number;
  queue: BuildItem[];
  project: string | null;
  governor: { on: boolean; focus: GovernorFocus; autoUpgrade: boolean };
  /** Xeno-archaeology site: its reward is fixed at generation time. */
  ruins?: { reward: 'tech' | 'industry' | 'research' | 'pop' | 'ship'; value: number; tech?: string; dug?: boolean };
  /** Days of orbital suppression after losing its defenders. */
  besieged?: number;
  /** Extra invasion defense built up by the Fortify project. */
  militia?: number;
  foundedDay?: number;
  /** Owner empire before conquest, used for unrest/AI memory. */
  prevOwner?: EmpireId;
}

export interface ShipDesign {
  id: DesignId;
  owner: EmpireId;
  name: string;
  hull: string;
  parts: string[];
  obsolete?: boolean;
  created: number;
  role?: 'warship' | 'colony' | 'outpost' | 'invader' | 'scout' | 'support';
}

export interface Ship {
  id: ShipId;
  owner: EmpireId;
  design: DesignId;
  name: string;
  hull: string;
  /** Per-ship parts: each can be refit individually at a shipyard. */
  parts: string[];
  hp: number;
  fleet: FleetId;
  built: number;
  kills: number;
}

export type FleetStance = 'aggressive' | 'defensive' | 'evasive';

export type FleetOrder =
  | { kind: 'none' }
  | { kind: 'colonize'; planet: PlanetId }
  | { kind: 'outpost'; planet: PlanetId }
  | { kind: 'invade'; planet: PlanetId }
  | { kind: 'explore' }
  | { kind: 'patrol' };

export interface Fleet {
  id: FleetId;
  owner: EmpireId;
  name: string;
  star: StarId;
  /** Remaining route (next hop first). Empty = idle at `star`. */
  route: StarId[];
  /** Days progressed along the lane toward route[0]. */
  transit: number;
  transitTotal: number;
  ships: ShipId[];
  stance: FleetStance;
  order: FleetOrder;
  /** Star we came from, for retreats. */
  lastStar?: StarId;
}

export type Stance = 'war' | 'peace' | 'alliance';

export interface OpinionMod {
  reason: string;
  value: number;
  /** Day it expires; undefined = permanent until changed. */
  until?: number;
  /** Decays toward 0 by this much per 30 days. */
  decay?: number;
}

export interface Relation {
  met: boolean;
  stance: Stance;
  mods: OpinionMod[];
  since: number;
  /** Days of continuous alliance (diplomatic victory). */
  lastProposal?: number;
}

export type AiPersonality = 'expansionist' | 'militarist' | 'scientist' | 'diplomat' | 'industrialist' | 'opportunist';

export interface Empire {
  id: EmpireId;
  name: string;
  species: string;
  color: string;
  human: boolean;
  alive: boolean;
  capital: PlanetId | null;
  research: {
    known: string[];
    current: string | null;
    progress: number;
    queue: string[];
    auto: boolean;
  };
  relations: Relation[];
  /** 0 unknown, 1 charted (seen), 2 visited/in sensor range at some point. */
  explored: number[];
  abilityReadyDay: number;
  ai: { personality: AiPersonality; difficulty: number; target?: EmpireId; memory: Record<string, number> };
  stats: EmpireStats[];
  ascension?: { planet: PlanetId; progress: number; cost: number };
  eliminatedDay?: number;
  /** Per-empire toggles for automation. */
  prefs: { autoUpgradeAll: boolean; governNewColonies: boolean; autoResearch: boolean };
  /** Industry shipped by Supply Convoy projects, spent to speed up needy planets. */
  logistics: number;
  /** Totals from the last processed day (for UI). */
  last: { ind: number; res: number; pro: number; pop: number; logisticsIn: number };
}

export interface EmpireStats {
  day: number;
  planets: number;
  pop: number;
  ind: number;
  res: number;
  pro: number;
  ships: number;
  military: number;
  techs: number;
  score: number;
}

export type EventKind =
  | 'research' | 'build' | 'colony' | 'combat' | 'diplomacy' | 'firstContact' | 'growth' | 'discovery'
  | 'invasion' | 'lost' | 'ability' | 'victory' | 'warning' | 'idle';

export interface GameEvent {
  id: number;
  day: number;
  empire: EmpireId;
  kind: EventKind;
  text: string;
  star?: StarId;
  planet?: PlanetId;
  fleet?: FleetId;
  battle?: number;
  important?: boolean;
}

export interface BattleShipSnap {
  id: number;
  owner: EmpireId;
  name: string;
  hull: string;
  maxHp: number;
  planet?: boolean;
}

export interface BattleFrame {
  /** [id, x, y, hp, shield] */
  u: [number, number, number, number, number][];
  /** [fromId, toId, damage, weaponPartId] */
  s: [number, number, number, string][];
}

export interface BattleReport {
  id: number;
  day: number;
  star: StarId;
  sides: EmpireId[];
  units: BattleShipSnap[];
  frames: BattleFrame[];
  losses: Record<number, number>;
  winner: EmpireId | null;
  summary: string;
}

export type GalaxyShape = 'spiral' | 'elliptical' | 'ring' | 'clusters' | 'irregular';

export interface GameSettings {
  seed: number;
  stars: number;
  shape: GalaxyShape;
  empires: number;
  playerSpecies: string;
  playerName: string;
  playerColor: string;
  difficulty: number; // 0 easy .. 3 brutal
  planetDensity: number; // 0.5 .. 1.5
  unstableLanes: number; // fraction
  victory: { conquest: boolean; domination: number | 0; ascension: boolean; diplomatic: boolean; dayLimit: number | 0 };
  /** Everyone controlled by AI — used for headless sims/tests. */
  spectate?: boolean;
}

export type ProposalKind = 'peace' | 'alliance' | 'trade' | 'gift' | 'endAlliance';

export interface Proposal {
  id: number;
  from: EmpireId;
  to: EmpireId;
  kind: ProposalKind;
  day: number;
  /** Tech offered by `from` / requested from `to` (trades). */
  give?: string;
  get?: string;
}

export interface GameState {
  version: number;
  settings: GameSettings;
  rng: RngState;
  day: number;
  stars: Star[];
  lanes: Lane[];
  planets: Planet[];
  empires: Empire[];
  fleets: Record<number, Fleet>;
  ships: Record<number, Ship>;
  designs: Record<number, ShipDesign>;
  events: GameEvent[];
  battles: BattleReport[];
  proposals: Proposal[];
  nextId: number;
  winner?: { empire: EmpireId; kind: string; day: number };
}

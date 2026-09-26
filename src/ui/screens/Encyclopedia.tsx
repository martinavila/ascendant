import type { ComponentChildren, JSX } from 'preact';
import { createContext } from 'preact';
import { useContext, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { store, useStore, dispatch } from '../store';
import { Modal, Yields, act, fmt } from '../common';
import { BuildingIcon, Icon, PartIcon, PlanetOrb, Portrait, ShipImage } from '../icons';
import {
  BUILDING, BUILDINGS, HULL, HULLS, PART, PARTS, PLANET_TYPE, PLANET_TYPES, PROJECT, PROJECTS, SPECIES, SPECIES_BY_ID, TECH, TECHS, TERRAFORM_NEXT, unlocksOf,
} from '../../sim/content';
import { techPath } from '../../sim/commands';
import { AUTO_EFFICIENCY, ASCENSION_COST } from '../../sim/world';
import type { BuildingDef, HullDef, PartDef, PlanetTypeDef, ProjectDef, SpeciesDef, TechCategory } from '../../sim/types';

// The in-game Civilopedia. The 1995 original explained almost nothing; here
// every structure, part, tech, species and planet type has an article, and
// the "How to play" guides teach the systems in a few minutes of reading.

type Cat = 'guide' | 'species' | 'planet' | 'building' | 'project' | 'part' | 'hull' | 'tech';

const CATS: { id: Cat; label: string; icon: (p?: { size?: number }) => JSX.Element }[] = [
  { id: 'guide', label: 'How to play', icon: Icon.help },
  { id: 'species', label: 'Species', icon: Icon.pop },
  { id: 'planet', label: 'Planet types', icon: Icon.planet },
  { id: 'building', label: 'Structures', icon: Icon.ind },
  { id: 'project', label: 'Projects', icon: Icon.gear },
  { id: 'part', label: 'Ship parts', icon: Icon.wrench },
  { id: 'hull', label: 'Hulls', icon: Icon.ship },
  { id: 'tech', label: 'Technologies', icon: Icon.flask },
];

interface Entry { key: string; cat: Cat; id: string; name: string; sub: string; text: string }

// ---------------------------------------------------------------------------
// How-to-play guides
// ---------------------------------------------------------------------------

interface Guide { id: string; name: string; sub: string; body: () => JSX.Element }

const Nav = createContext<(key: string) => void>(() => {});

/** Cross-link to another article. */
function L({ to, children }: { to: string; children?: ComponentChildren }) {
  const go = useContext(Nav);
  return <a class="ency-link" href="#" onClick={(e) => { e.preventDefault(); go(to); }}>{children ?? nameOf(to)}</a>;
}

const K = ({ children }: { children: ComponentChildren }) => <span class="kbd">{children}</span>;
const Tip = ({ children }: { children: ComponentChildren }) => <div class="ency-tip"><Icon.bolt size={14} /><div>{children}</div></div>;

const GUIDES: Guide[] = [
  {
    id: 'basics', name: 'The basics', sub: 'Time, resources, tiles, population',
    body: () => (
      <>
        <p>Ascendant plays in continuous <b>days</b>. Nothing happens while the game is paused, so take your time: press <K>Space</K> to pause or resume, <K>1</K> <K>2</K> <K>3</K> to pick a speed, and <K>4</K> to <b>run until something happens</b> — the game pauses itself on the events you care about (configurable in Settings). Opening any screen pauses too.</p>
        <h4>Three resources</h4>
        <div class="ency-res">
          <div><span class="ind"><Icon.ind size={18} /></span><b>Industry</b><p>Produced and spent <i>on each planet</i>. It builds that planet’s structures and ships. A poor planet cannot borrow from a rich one — except through the logistics pool (see <L to="guide:planets" />).</p></div>
          <div><span class="res"><Icon.res size={18} /></span><b>Research</b><p>Pooled across the whole empire into your current technology. Research costs rise gently once you hold more than four planets, so wide empires don’t snowball.</p></div>
          <div><span class="pro"><Icon.pro size={18} /></span><b>Prosperity</b><p>Also local. Prosperity fills a planet’s growth meter; when it’s full, the planet gains one population. Bigger populations need more to grow.</p></div>
        </div>
        <h4>Colored tiles</h4>
        <p>Each planet surface is a grid of tiles. <span class="ency-sw" style={{ background: SW.white }} />White tiles are ordinary. <span class="ency-sw" style={{ background: SW.black }} />Black tiles cannot be built on. The colored tiles <b>double</b> the output of a matching structure:</p>
        <ul>
          <li><span class="ency-sw" style={{ background: SW.red }} /><b>Red</b> doubles industry — put <L to="building:factory">Factories</L> here.</li>
          <li><span class="ency-sw" style={{ background: SW.blue }} /><b>Blue</b> doubles research — put <L to="building:lab">Laboratories</L> here.</li>
          <li><span class="ency-sw" style={{ background: SW.green }} /><b>Green</b> doubles prosperity — put <L to="building:agridome">Agridomes</L> here.</li>
        </ul>
        <p>Orbital slots around the planet hold shipyards, solar arrays and defenses. They never need workers.</p>
        <h4>Population = workers</h4>
        <p>Each population point works one surface structure. If you build more structures than you have people, the weakest ones go <span class="bad">idle</span> and produce nothing (they’re greyed out with a red marker). <L to="building:colonybase" />, <L to="building:habitat">Habitats</L> and all orbitals need no workers. Any structure can later be <b>automated</b> for its build cost: it then runs without a worker at {Math.round(AUTO_EFFICIENCY * 100)}% efficiency.</p>
        <p>Population capacity comes from the planet’s buildable area, its <L to="planet:temperate">planet type</L>, whether your species favors it (+25%), and housing structures.</p>
        <Tip>Your capital gets a free +2 industry, +2 research and +1 prosperity. Protect it.</Tip>
      </>
    ),
  },
  {
    id: 'planets', name: 'Planets & governors', sub: 'Let the empire run itself',
    body: () => (
      <>
        <p>The original game made you hand-place every structure on every tile of every planet. Here each planet can be handed to a <b>governor</b> — the same planner the AI empires use. It picks the right structure for each colored tile, keeps enough workers, adds housing when the planet is full, builds defenses where threats are near, and fixes badly placed structures on conquered worlds.</p>
        <h4>Focuses</h4>
        <table class="list ency-kv">
          <tbody>
            <tr><td><b>Balanced</b></td><td>A little of everything. The safe default.</td></tr>
            <tr><td><b>Industry</b></td><td>Favors factories. Use on red-heavy worlds and shipbuilding hubs.</td></tr>
            <tr><td><b>Research</b></td><td>Favors labs. Use on blue-heavy worlds.</td></tr>
            <tr><td><b>Growth</b></td><td>Favors prosperity and housing, so population climbs fast.</td></tr>
            <tr><td><b>Defense</b></td><td>Prioritizes garrisons, shields and orbital weapons for border worlds.</td></tr>
          </tbody>
        </table>
        <p>You can mix: add your own items to a governed planet’s queue and the governor works around them. Press <K>M</K> on an open planet to toggle its governor, and <K>N</K> to jump to the next planet with nothing to do. A <Icon.gear size={12} /> gear badge marks governed planets.</p>
        <h4>Auto-upgrade</h4>
        <p>When a better structure is researched (for example <L to="building:megaplex" /> replacing <L to="building:factory" />), auto-upgrade queues the replacement for you. Turn it on per planet, or for the whole empire in the <b>Empire</b> screen (<K>E</K>).</p>
        <h4>Projects</h4>
        <p>A planet with an empty build queue would otherwise waste its industry. Give it a <b>project</b> instead:</p>
        <ul>
          {PROJECTS.map((p) => <li key={p.id}><L to={`project:${p.id}`}>{p.name}</L> — {p.desc}</li>)}
        </ul>
        <h4>The logistics pool</h4>
        <p>Industry sent by <L to="project:convoy" /> collects in the empire’s logistics pool. Each day it is spent on planets that are building something, smallest producers first — so a mature core world can fund a fresh colony’s first structures.</p>
        <h4>Managing many planets</h4>
        <p>The <b>Empire</b> screen lists every planet in one sortable table with multi-select: switch governors on or off, change focus, or assign projects to dozens of planets at once. Its “Needs attention” list shows only the planets that actually need you.</p>
        <Tip>Structures marked with a blue badge are automated and work without population.</Tip>
      </>
    ),
  },
  {
    id: 'explore', name: 'Exploration & colonization', sub: 'Scouts, colony ships, outposts, red lanes',
    body: () => (
      <>
        <p>Stars are joined by <b>star lanes</b>; ships can only travel along them. Unexplored stars are hidden until a ship or a planet’s sensors reach them.</p>
        <h4>Scouts</h4>
        <p>Cheap, fast ships with a scanner. Give a scout the <b>Explore</b> order and it will chart the galaxy on its own. Better scanners (<L to="part:deepscan" />) see further and reveal cloaked ships.</p>
        <h4>Colony ships</h4>
        <p>A ship carrying a <L to="part:colonymod" /> founds a populated colony on any unclaimed planet; the module is consumed. Check the planet type first — some are much better than others, and <L to={`species:${store.world?.human()?.species ?? SPECIES[0].id}`}>your species</L> favors certain types (+25% population).</p>
        <h4>Outposts</h4>
        <p>An <L to="part:outpostkit" /> (requires <L to="tech:survey" />) claims a planet without people. Outposts can only build orbital structures, but they are cheap and claim territory — ideal for gas giants and barren rocks.</p>
        <h4>Unstable (red) lanes</h4>
        <p>Some lanes are drawn in red. They are <b>unstable</b>: a fleet can only cross if <i>every</i> ship in it carries a <L to="part:stabilizer" /> (research <L to="tech:lanestab" />). The <L to="species:mirrith" /> fold lanes naturally and ignore this.</p>
        <Tip>Ruins on a planet are xeno-archaeology sites — colonize it and build an <L to="building:excavation" /> to dig up a technology, resources or a derelict ship.</Tip>
      </>
    ),
  },
  {
    id: 'ships', name: 'Ship design & refits', sub: 'Hulls, power, drives, per-part refits',
    body: () => (
      <>
        <p>Open the designer with <K>D</K>. A design is a <L to="hull:small">hull</L> plus one part per slot.</p>
        <h4>Power</h4>
        <p>Generators such as the <L to="part:fission" /> supply power; most other parts draw it. Parts are powered in slot order, so if you run short the last parts go dark and do nothing. The designer warns you and shows the power balance.</p>
        <h4>Speed</h4>
        <p>Each drive adds speed points; the ship’s speed is <b>total drive ÷ hull mass</b>. Bigger hulls need more drives to keep up. A fleet moves at the speed of its slowest ship.</p>
        <h4>Weapons and shields</h4>
        <p>Weapons differ in damage per shot, shots per round and range. Shields absorb up to their strength every round and fully recharge — so many small hits (<L to="part:pulser" />) shred light shields but bounce off heavy ones.</p>
        <h4>Refits</h4>
        <p>Ships remember their own parts. At a planet with a shipyard you can refit <b>one component at a time</b> for roughly the cost of the new part — no need to scrap an old fleet, as in the original. You can also refit a whole fleet to a newer design in one click.</p>
        <Tip>Drydock Rings make ships 25% cheaper at that planet. Mark outdated designs obsolete to keep your build menus clean.</Tip>
      </>
    ),
  },
  {
    id: 'combat', name: 'Combat & invasion', sub: 'Stances, sieges, troops',
    body: () => (
      <>
        <p>Battles are resolved automatically when hostile fleets meet; you can replay any battle from its event.</p>
        <h4>Fleet stances</h4>
        <table class="list ency-kv">
          <tbody>
            <tr><td><b>Aggressive</b></td><td>Attacks enemy ships and defended enemy planets on sight, and lays siege to enemy worlds. Default for warships.</td></tr>
            <tr><td><b>Defensive</b></td><td>Only fights enemy ships at stars where you hold a planet.</td></tr>
            <tr><td><b>Evasive</b></td><td>Avoids combat and flees if caught. Default for colony ships, scouts and transports.</td></tr>
          </tbody>
        </table>
        <p>Armed enemy fleets and defended enemy planets <b>blockade</b> a star: your fleets stop there instead of flying past.</p>
        <h4>Invasion</h4>
        <ol>
          <li><b>Destroy the orbital defenses.</b> Missile batteries, lance platforms and shields in orbit must be knocked out before any troops can land. The planet is then <i>besieged</i>.</li>
          <li><b>Land troops.</b> Each <L to="part:invasionmod" /> carries 12 troops (research <L to="tech:assault" />). Modules are used up whether or not the landing succeeds.</li>
          <li><b>Beat the defense.</b> Defense = 3 per population + militia (from the <L to="project:fortify" /> project) + 8 per <L to="building:garrison" />. Bring a comfortable margin; there is some luck in every landing.</li>
        </ol>
        <p>Conquered planets keep their structures, and governors will rearrange anything badly placed.</p>
        <Tip>Grapple fields stop enemies from escaping a battle; sensor jammers make your ships 25% harder to hit.</Tip>
      </>
    ),
  },
  {
    id: 'diplomacy', name: 'Diplomacy', sub: 'Attitude, proposals, alliances',
    body: () => (
      <>
        <p>Open diplomacy with <K>P</K>. You can only talk to empires you have met.</p>
        <h4>Transparent attitude</h4>
        <p>Every empire’s opinion of you is a number made of visible reasons — shared borders, wars, gifts, trade, species traits, relative power. Hover an attitude to see the full breakdown; nothing is hidden.</p>
        <h4>Proposals</h4>
        <p>Offer <b>peace</b>, an <b>alliance</b>, a <b>technology trade</b>, a <b>gift</b>, or end an alliance. Before you send, the screen shows whether they would accept and why. AI empires make proposals to you too; the game pauses when one arrives.</p>
        <h4>Alliances</h4>
        <p>Allies share victories against common enemies and count toward the <L to="guide:victory">Galactic Accord</L>. Breaking one sours everyone who hears of it.</p>
        <Tip>The <L to="project:outreach" /> project slowly warms every empire you have met. The <L to="species:brool" /> are natural diplomats.</Tip>
      </>
    ),
  },
  {
    id: 'victory', name: 'Victory', sub: 'Four ways to win',
    body: () => (
      <>
        <p>Victory conditions are chosen when the game is set up. Track your progress in the <b>Empire</b> screen (<K>E</K>).</p>
        <table class="list ency-kv">
          <tbody>
            <tr><td><b>Conquest</b></td><td>Be the last empire standing. An empire is eliminated when it has no planets and no colony ships left.</td></tr>
            <tr><td><b>Domination</b></td><td>Hold the configured share of the galaxy’s total population (after day 50).</td></tr>
            <tr><td><b>Ascension</b></td><td>Research <L to="tech:transcendence" />, then build the Ascension Gate on any planet — a {fmt(ASCENSION_COST)}-industry megaproject. Feed it with Supply Convoys and defend it: rivals will notice.</td></tr>
            <tr><td><b>Galactic Accord</b></td><td>Be allied with every surviving empire at once and hold it for 120 days.</td></tr>
            <tr><td><b>Score</b></td><td>If a day limit is set, the highest score wins when time runs out. Score counts population, planets, technology and military power.</td></tr>
          </tbody>
        </table>
      </>
    ),
  },
  {
    id: 'keys', name: 'Keyboard shortcuts', sub: 'Play faster',
    body: () => (
      <table class="list ency-kv ency-keys">
        <tbody>
          {([
            ['Space', 'Pause / resume'], ['1  2  3', 'Game speed'], ['4', 'Run until the next important event'],
            ['R', 'Research'], ['D', 'Ship designer'], ['P', 'Diplomacy'], ['E', 'Empire overview'], ['H', 'Encyclopedia (this screen)'],
            ['M', 'Toggle the governor on the open planet'], ['N', 'Next idle planet'], ['F', 'Fit the whole galaxy on screen'],
            ['Arrow keys', 'Pan the map'], ['+  −', 'Zoom'], ['Esc', 'Close the current screen / cancel'],
          ] as [string, string][]).map(([k, d]) => (
            <tr key={k}><td style={{ width: 150 }}>{k.split('  ').map((x) => <><K>{x}</K> </>)}</td><td>{d}</td></tr>
          ))}
        </tbody>
      </table>
    ),
  },
  {
    id: 'different', name: 'What’s different from 1995', sub: 'Fixes to the original',
    body: () => (
      <>
        <p>Ascendant keeps the heart of the 1995 classic — colored tiles, star lanes, strange species with unique powers — and fixes what made it hard to love:</p>
        <ul class="ency-diff">
          <li><b>No more click fest.</b> Planet governors, empire-wide auto-upgrade and bulk actions replace hand-placing thousands of structures.</li>
          <li><b>Idle planets are never silent.</b> Projects turn spare industry into research, prosperity, militia or logistics, and the Empire screen lists every planet that needs you.</li>
          <li><b>Smarter AI.</b> AI empires build on the right tiles (they use the governor), design sensible ships, and actually expand and fight.</li>
          <li><b>Refits.</b> Upgrade ships one part at a time instead of scrapping them.</li>
          <li><b>Transparent diplomacy.</b> You can see exactly why an empire likes you and whether it will accept a deal.</li>
          <li><b>Clear combat rules.</b> Stances, blockades and the “defenses first, then troops” invasion rule are explained and shown.</li>
          <li><b>Readable red lanes.</b> Unstable lanes are marked and routes avoid them automatically until you can cross.</li>
          <li><b>Run until event.</b> Time flows smoothly and pauses on what matters instead of forcing you to click through every day.</li>
          <li><b>More ways to win</b> — domination, ascension and a diplomatic accord alongside conquest.</li>
          <li><b>This encyclopedia.</b> Every structure, part, tech and species is documented in-game.</li>
        </ul>
      </>
    ),
  },
];
const GUIDE: Record<string, Guide> = Object.fromEntries(GUIDES.map((g) => [g.id, g]));

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

const SW = { white: '#56608a', black: '#1b1d2b', red: '#b0473a', green: '#2f8a4c', blue: '#3464b8' };
const TILE_ORDER: (keyof typeof SW)[] = ['white', 'black', 'red', 'green', 'blue'];
const TILE_LABEL: Record<keyof typeof SW, string> = { white: 'Plain', black: 'Unbuildable', red: 'Industry', green: 'Prosperity', blue: 'Research' };

const CAT_COLOR: Record<TechCategory, string> = {
  energy: '#ffcf6a', industry: '#ff9f43', biology: '#6fe08a', information: '#5ab0ff', military: '#ff6b6b', propulsion: '#7fdcff', xeno: '#b48cff',
};

const ROLE_LABEL: Record<string, string> = {
  industry: 'Industry', research: 'Research', prosperity: 'Prosperity', housing: 'Housing', mixed: 'Mixed', defense: 'Defense', special: 'Special', shipyard: 'Shipyard',
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const ENTRIES: Entry[] = [
  ...GUIDES.map((g) => ({ key: `guide:${g.id}`, cat: 'guide' as Cat, id: g.id, name: g.name, sub: g.sub, text: g.sub })),
  ...SPECIES.map((s) => ({ key: `species:${s.id}`, cat: 'species' as Cat, id: s.id, name: s.name, sub: s.traitDesc.split(':')[0], text: s.traitDesc + ' ' + s.lore + ' ' + s.ability.name })),
  ...PLANET_TYPES.map((p) => ({ key: `planet:${p.id}`, cat: 'planet' as Cat, id: p.id, name: p.name, sub: p.desc, text: p.desc })),
  ...BUILDINGS.map((b) => ({ key: `building:${b.id}`, cat: 'building' as Cat, id: b.id, name: b.name, sub: (b.orbital ? 'Orbital · ' : '') + ROLE_LABEL[b.role], text: b.desc })),
  ...PROJECTS.map((p) => ({ key: `project:${p.id}`, cat: 'project' as Cat, id: p.id, name: p.name, sub: 'Planet project', text: p.desc })),
  ...PARTS.map((p) => ({ key: `part:${p.id}`, cat: 'part' as Cat, id: p.id, name: p.name, sub: cap(p.category), text: p.desc })),
  ...HULLS.map((h) => ({ key: `hull:${h.id}`, cat: 'hull' as Cat, id: h.id, name: h.name, sub: `${h.slots} slots`, text: '' })),
  ...[...TECHS].sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name)).map((t) => ({ key: `tech:${t.id}`, cat: 'tech' as Cat, id: t.id, name: t.name, sub: `Tier ${t.tier} · ${cap(t.category)}`, text: t.desc })),
];
const ENTRY: Record<string, Entry> = Object.fromEntries(ENTRIES.map((e) => [e.key, e]));

function nameOf(key: string) {
  return ENTRY[key]?.name ?? key.split(':')[1];
}

function entryIcon(e: Entry, size = 22): JSX.Element {
  switch (e.cat) {
    case 'building': return <BuildingIcon id={e.id} size={size} />;
    case 'part': return <PartIcon id={e.id} size={size} />;
    case 'planet': return <PlanetOrb planet={{ type: e.id, id: orbSeed(e.id), size: 2 }} size={size} />;
    case 'species': return <Portrait species={e.id} color={SPECIES_BY_ID[e.id].color} size={size} />;
    case 'tech': return <span class="ency-dot" style={{ background: CAT_COLOR[TECH[e.id].category], boxShadow: `0 0 6px ${CAT_COLOR[TECH[e.id].category]}` }} />;
    case 'hull': return <Icon.ship size={Math.min(size, 16)} />;
    case 'project': return <Icon.gear size={Math.min(size, 16)} />;
    case 'guide': return <Icon.book size={Math.min(size, 16)} />;
  }
}

function orbSeed(id: string) {
  let h = 7;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 997;
  return h;
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

const CSS = `
.ency { flex: 1; min-width: 0; display: grid; grid-template-columns: 280px minmax(0, 1fr); }
.ency-side { border-right: 1px solid var(--line); display: flex; flex-direction: column; min-height: 0; }
.ency-search { padding: 12px; border-bottom: 1px solid var(--line); position: relative; }
.ency-search input { width: 100%; padding-left: 30px; }
.ency-search svg { position: absolute; left: 21px; top: 50%; transform: translateY(-50%); color: var(--text-faint); }
.ency-list { flex: 1; min-height: 0; padding: 6px; }
.ency-cat { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 8px; border: 0; background: transparent; cursor: pointer; border-radius: 6px; font-family: var(--display); font-size: 13px; letter-spacing: 0.04em; color: var(--text-dim); text-align: left; }
.ency-cat:hover { background: var(--panel-3); color: var(--text); }
.ency-cat.open { color: var(--text); }
.ency-cat .n { margin-left: auto; font-family: var(--font); font-size: 11px; color: var(--text-faint); }
.ency-item { display: flex; align-items: center; gap: 9px; width: 100%; padding: 5px 8px 5px 14px; border: 0; background: transparent; border-radius: 6px; cursor: pointer; text-align: left; border-left: 2px solid transparent; }
.ency-item:hover { background: var(--panel-3); }
.ency-item.on { background: rgba(127, 220, 255, 0.12); border-left-color: var(--accent); }
.ency-item .ic { width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.ency-item .ic img, .ency-item .ic svg { max-width: 24px; max-height: 24px; }
.ency-item .nm { font-size: 13px; }
.ency-item .sb { font-size: 11px; color: var(--text-faint); }
.ency-dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
.ency-art { min-height: 0; padding: 22px 28px 40px; line-height: 1.6; }
.ency-art-inner { max-width: 820px; animation: rise 0.18s ease-out; }
.ency-head { display: flex; gap: 18px; align-items: center; margin-bottom: 16px; }
.ency-hero { width: 104px; height: 104px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; border-radius: 14px; background: radial-gradient(circle at 50% 40%, rgba(127, 220, 255, 0.14), rgba(20, 28, 52, 0.6) 70%); border: 1px solid var(--line); }
.ency-hero img, .ency-hero svg { max-width: 88px; max-height: 88px; }
.ency-head h1 { font-size: 28px; line-height: 1.1; }
.ency-kicker { font-size: 11px; text-transform: uppercase; letter-spacing: 0.14em; color: var(--accent); font-weight: 600; margin-bottom: 4px; }
.ency-art h4 { font-family: var(--display); font-size: 13px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--text-dim); margin: 22px 0 8px; }
.ency-art p { margin: 0 0 10px; }
.ency-art ul, .ency-art ol { margin: 0 0 10px; padding-left: 20px; }
.ency-art li { margin-bottom: 5px; }
.ency-lead { font-size: 15px; color: var(--text); }
.ency-link { color: var(--accent); text-decoration: none; border-bottom: 1px dotted rgba(127, 220, 255, 0.5); cursor: pointer; }
.ency-link:hover { color: #fff; border-bottom-color: #fff; }
.ency-stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 8px; margin: 6px 0 4px; }
.ency-stat { background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; }
.ency-stat .l { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-dim); }
.ency-stat .v { font-family: var(--display); font-size: 17px; font-weight: 600; font-variant-numeric: tabular-nums; }
.ency-kv td { cursor: default; vertical-align: top; line-height: 1.5; }
.ency-kv tr { cursor: default; }
.ency-kv td:first-child { white-space: nowrap; }
.ency-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.ency-card-link { display: inline-flex; align-items: center; gap: 8px; padding: 5px 10px 5px 6px; border-radius: 8px; background: var(--panel-2); border: 1px solid var(--line); cursor: pointer; font-size: 13px; }
.ency-card-link:hover { border-color: var(--accent); }
.ency-card-link img, .ency-card-link svg { max-width: 26px; max-height: 26px; }
.ency-tip { display: flex; gap: 10px; align-items: flex-start; margin-top: 16px; padding: 10px 12px; border-radius: 8px; background: rgba(127, 220, 255, 0.07); border: 1px solid rgba(127, 220, 255, 0.25); font-size: 13px; }
.ency-tip > svg { color: var(--accent); flex-shrink: 0; margin-top: 3px; }
.ency-res { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.ency-res > div { background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
.ency-res > div > span { display: inline-flex; vertical-align: middle; margin-right: 6px; }
.ency-res p { font-size: 12.5px; color: var(--text-dim); margin: 6px 0 0; }
.ency-sw { display: inline-block; width: 12px; height: 12px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; border: 1px solid rgba(255, 255, 255, 0.15); }
.ency-tiles { display: flex; height: 14px; border-radius: 7px; overflow: hidden; border: 1px solid var(--line); margin: 6px 0 8px; }
.ency-tiles > i { display: block; height: 100%; }
.ency-legend { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 12px; color: var(--text-dim); }
.ency-status { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; border: 1px solid var(--line-2); }
.ency-status.known { color: var(--good); border-color: rgba(111, 224, 138, 0.5); background: rgba(111, 224, 138, 0.08); }
.ency-status.cur { color: var(--accent); border-color: rgba(127, 220, 255, 0.5); background: rgba(127, 220, 255, 0.08); }
.ency-diff li { margin-bottom: 8px; }
.ency-keys td { padding: 7px 8px; }
.ency-back { margin-bottom: 10px; }
@media (max-width: 860px) {
  .ency { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 38%) minmax(0, 1fr); }
  .ency-side { border-right: 0; border-bottom: 1px solid var(--line); }
  .ency-art { padding: 16px; }
  .ency-res { grid-template-columns: minmax(0, 1fr); }
  .ency-hero { width: 76px; height: 76px; }
  .ency-hero img, .ency-hero svg { max-width: 64px; max-height: 64px; }
  .ency-head h1 { font-size: 22px; }
}
`;

function initialEntry(): string {
  const e = (store.screenArg as { entry?: string } | null)?.entry;
  return e && ENTRY[e] ? e : 'guide:basics';
}

export function EncyclopediaScreen() {
  useStore();
  const [entry, setEntry] = useState(initialEntry);
  const [history, setHistory] = useState<string[]>([]);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Set<Cat>>(() => new Set<Cat>([ENTRY[initialEntry()].cat]));
  const artRef = useRef<HTMLDivElement>(null);
  const sideRef = useRef<HTMLDivElement>(null);
  const argEntry = (store.screenArg as { entry?: string } | null)?.entry;

  // Reopening the encyclopedia on a different entry (e.g. from a tooltip link).
  useEffect(() => {
    if (argEntry && ENTRY[argEntry]) go(argEntry, false);
  }, [argEntry]);

  // Keep the highlighted entry visible in the sidebar.
  useEffect(() => {
    sideRef.current?.querySelector('.ency-item.on')?.scrollIntoView({ block: 'nearest' });
  }, [entry]);

  function go(key: string, remember = true) {
    if (!ENTRY[key]) return;
    if (remember && key !== entry) setHistory((h) => [...h.slice(-30), entry]);
    setEntry(key);
    setOpen((o) => (o.has(ENTRY[key].cat) ? o : new Set([...o, ENTRY[key].cat])));
    artRef.current?.scrollTo({ top: 0 });
  }
  const back = () => {
    const prev = history[history.length - 1];
    if (!prev) return;
    setHistory(history.slice(0, -1));
    setEntry(prev);
    artRef.current?.scrollTo({ top: 0 });
  };

  const needle = q.trim().toLowerCase();
  const results = useMemo(() => {
    if (!needle) return null;
    return ENTRIES
      .map((e) => {
        const n = e.name.toLowerCase();
        const rank = n.startsWith(needle) ? 0 : n.includes(needle) ? 1 : e.sub.toLowerCase().includes(needle) ? 2 : e.text.toLowerCase().includes(needle) ? 3 : -1;
        return { e, rank };
      })
      .filter((x) => x.rank >= 0)
      .sort((a, b) => a.rank - b.rank || a.e.name.localeCompare(b.e.name))
      .map((x) => x.e);
  }, [needle]);

  const item = (e: Entry, showCat = false) => (
    <button key={e.key} class={'ency-item' + (e.key === entry ? ' on' : '')} onClick={() => go(e.key)}>
      <span class="ic">{entryIcon(e)}</span>
      <span class="grow">
        <div class="nm ellipsis">{e.name}</div>
        <div class="sb ellipsis">{showCat ? CATS.find((c) => c.id === e.cat)!.label + ' · ' : ''}{e.sub}</div>
      </span>
    </button>
  );

  const toggleCat = (c: Cat) => setOpen((o) => { const n = new Set(o); if (n.has(c)) n.delete(c); else n.add(c); return n; });

  return (
    <Modal title={<span class="row" style={{ gap: 10 }}><Icon.book size={20} />Encyclopedia</span>}>
      <style>{CSS}</style>
      <Nav.Provider value={go}>
        <div class="ency">
          <div class="ency-side">
            <div class="ency-search">
              <Icon.eye size={14} />
              <input
                type="search"
                placeholder="Search the encyclopedia…"
                value={q}
                onInput={(e) => setQ((e.currentTarget as HTMLInputElement).value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && results?.[0]) go(results[0].key); }}
              />
            </div>
            <div class="ency-list scroll" ref={sideRef}>
              {results ? (
                results.length ? results.slice(0, 80).map((e) => item(e, true)) : <div class="dim small" style={{ padding: 12 }}>Nothing matches “{q}”.</div>
              ) : (
                CATS.map((c) => {
                  const list = ENTRIES.filter((e) => e.cat === c.id);
                  const isOpen = open.has(c.id);
                  return (
                    <div key={c.id}>
                      <button class={'ency-cat' + (isOpen ? ' open' : '')} onClick={() => toggleCat(c.id)}>
                        {isOpen ? <Icon.down size={12} /> : <span style={{ display: 'inline-flex', transform: 'rotate(-90deg)' }}><Icon.down size={12} /></span>}
                        {c.icon({ size: 14 })}
                        {c.label}
                        <span class="n">{list.length}</span>
                      </button>
                      {isOpen && list.map((e) => item(e))}
                    </div>
                  );
                })
              )}
            </div>
          </div>
          <div class="ency-art scroll" ref={artRef}>
            <div class="ency-art-inner" key={entry}>
              {history.length > 0 && <button class="btn sm ghost ency-back" onClick={back}>← Back to {nameOf(history[history.length - 1])}</button>}
              <Article k={entry} />
            </div>
          </div>
        </div>
      </Nav.Provider>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Articles
// ---------------------------------------------------------------------------

function Article({ k }: { k: string }) {
  const [cat, id] = k.split(':') as [Cat, string];
  switch (cat) {
    case 'guide': return <GuideArticle g={GUIDE[id]} />;
    case 'species': return <SpeciesArticle s={SPECIES_BY_ID[id]} />;
    case 'planet': return <PlanetArticle t={PLANET_TYPE[id]} />;
    case 'building': return <BuildingArticle b={BUILDING[id]} />;
    case 'project': return <ProjectArticle p={PROJECT[id]} />;
    case 'part': return <PartArticle p={PART[id]} />;
    case 'hull': return <HullArticle h={HULL[id]} />;
    case 'tech': return <TechArticle id={id} />;
  }
}

function Head({ kicker, title, hero, children }: { kicker: ComponentChildren; title: ComponentChildren; hero?: JSX.Element; children?: ComponentChildren }) {
  return (
    <div class="ency-head">
      {hero && <div class="ency-hero">{hero}</div>}
      <div class="col" style={{ gap: 6, minWidth: 0 }}>
        <div class="ency-kicker">{kicker}</div>
        <h1>{title}</h1>
        {children}
      </div>
    </div>
  );
}

function Stats({ items }: { items: [string, ComponentChildren, string?][] }) {
  return (
    <div class="ency-stats">
      {items.map(([l, v, tip]) => <div class="ency-stat" key={l} data-tip={tip}><div class="l">{l}</div><div class="v">{v}</div></div>)}
    </div>
  );
}

function CardLink({ to }: { to: string }) {
  const go = useContext(Nav);
  const e = ENTRY[to];
  if (!e) return null;
  return <span class="ency-card-link" onClick={() => go(to)}>{entryIcon(e, 26)}<span>{e.name}</span></span>;
}

function GuideArticle({ g }: { g: Guide }) {
  const idx = GUIDES.indexOf(g);
  const next = GUIDES[idx + 1];
  return (
    <>
      <Head kicker="How to play" title={g.name}><div class="dim">{g.sub}</div></Head>
      {g.body()}
      {next && (
        <div style={{ marginTop: 24, paddingTop: 14, borderTop: '1px solid var(--line)' }}>
          <span class="dim small">Next: </span><L to={`guide:${next.id}`}>{next.name} →</L>
        </div>
      )}
    </>
  );
}

const MULT_LABEL: Record<string, string> = { ind: 'Industry', res: 'Research', pro: 'Prosperity', hp: 'Ship hull', damage: 'Weapon damage', shield: 'Shield strength', speed: 'Ship speed', cost: 'Build costs', attitude: 'Attitude' };

function SpeciesArticle({ s }: { s: SpeciesDef }) {
  const h = store.world?.human();
  const mine = h?.species === s.id;
  return (
    <>
      <Head kicker={mine ? 'Species · yours' : 'Species'} title={s.name} hero={<Portrait species={s.id} color={s.color} size={96} big />}>
        <div class="dim">{s.traitDesc}</div>
      </Head>
      <p class="ency-lead"><i>{s.lore}</i></p>
      <h4>Special ability — {s.ability.name}</h4>
      <p>{s.ability.desc}</p>
      <Stats items={[
        ['Recharge', `${s.ability.cooldown} days`],
        ['Target', s.ability.target === 'none' ? 'Instant' : cap(s.ability.target)],
        ['AI temperament', cap(s.personality)],
      ]} />
      <h4>Modifiers</h4>
      {Object.keys(s.mult).length ? (
        <table class="list ency-kv">
          <tbody>
            {Object.entries(s.mult).map(([k, v]) => {
              const txt = k === 'attitude' ? `+${v}` : `${v! >= 1 ? '+' : ''}${Math.round((v! - 1) * 100)}%`;
              const good = k === 'cost' ? v! < 1 : k === 'attitude' || v! >= 1;
              return <tr key={k}><td>{MULT_LABEL[k] ?? k}</td><td class={good ? 'good' : 'bad'} style={{ fontWeight: 600 }}>{txt}</td></tr>;
            })}
          </tbody>
        </table>
      ) : <p class="dim">No flat modifiers — this species’ strength is its trait: {s.traitDesc.split(': ')[1] ?? s.traitDesc}</p>}
      <h4>Favored worlds</h4>
      <p class="dim small">+25% population capacity on these planet types.</p>
      <div class="ency-chips">{s.favored.map((t) => <CardLink key={t} to={`planet:${t}`} />)}</div>
    </>
  );
}

function TileBar({ tiles }: { tiles: PlanetTypeDef['tiles'] }) {
  const total = tiles.reduce((a, b) => a + b, 0) || 1;
  return (
    <>
      <div class="ency-tiles">
        {tiles.map((v, i) => v > 0 && <i key={i} style={{ width: `${(v / total) * 100}%`, background: SW[TILE_ORDER[i]] }} data-tip={`${TILE_LABEL[TILE_ORDER[i]]}: ${Math.round((v / total) * 100)}%`} />)}
      </div>
      <div class="ency-legend">
        {tiles.map((v, i) => v > 0 && <span key={i}><span class="ency-sw" style={{ background: SW[TILE_ORDER[i]] }} />{TILE_LABEL[TILE_ORDER[i]]} {Math.round((v / total) * 100)}%</span>)}
      </div>
    </>
  );
}

function PlanetArticle({ t }: { t: PlanetTypeDef }) {
  const fans = SPECIES.filter((s) => s.favored.includes(t.id));
  const from = Object.entries(TERRAFORM_NEXT).filter(([, to]) => to === t.id).map(([f]) => f);
  const next = TERRAFORM_NEXT[t.id];
  const speed = t.growth <= 0.8 ? 'Fast' : t.growth <= 1.1 ? 'Normal' : t.growth <= 1.6 ? 'Slow' : 'Very slow';
  const best = (['red', 'green', 'blue'] as const).map((c, i) => ({ c, v: t.tiles[i + 2] })).sort((a, b) => b.v - a.v)[0];
  return (
    <>
      <Head kicker="Planet type" title={t.name} hero={<PlanetOrb planet={{ type: t.id, id: orbSeed(t.id), size: 3 }} size={96} />}>
        <div class="dim">{t.desc}</div>
      </Head>
      <h4>Surface</h4>
      <TileBar tiles={t.tiles} />
      <Stats items={[
        ['Population', t.popMul ? `×${t.popMul}` : 'None', 'Multiplier on population capacity from buildable tiles'],
        ['Growth', t.popMul ? `${speed} (×${t.growth})` : '—', 'Prosperity needed per new pop, relative to a Temperate world. Lower is faster.'],
        ['Best for', t.popMul === 0 ? 'Orbitals' : best.v > 0 ? TILE_LABEL[best.c] : 'Nothing special'],
      ]} />
      {t.id === 'gasgiant' && <p>Gas giants have no surface at all, so they can only be held as <L to="guide:explore">outposts</L> — but they offer double the orbital slots for solar arrays, research stations and defenses.</p>}
      {t.popMul > 0 && best.v >= 20 && <p>Rich in <b>{TILE_LABEL[best.c].toLowerCase()}</b> tiles: a governor with the {best.c === 'red' ? 'Industry' : best.c === 'blue' ? 'Research' : 'Growth'} focus will make the most of it.</p>}
      <h4>Favored by</h4>
      {fans.length ? <div class="ency-chips">{fans.map((s) => <CardLink key={s.id} to={`species:${s.id}`} />)}</div> : <p class="dim">No species calls this home.</p>}
      {(next || from.length > 0) && (
        <>
          <h4>Worldshaping</h4>
          {next && <p>Can be reshaped into <L to={`planet:${next}`} />.</p>}
          {from.length > 0 && <p>Reached by reshaping {from.map((f, i) => <>{i > 0 && (i === from.length - 1 ? ' or ' : ', ')}<L to={`planet:${f}`} /></>)}.</p>}
          <p class="dim small">The <L to="species:cthari" /> can reshape worlds with their special ability.</p>
        </>
      )}
    </>
  );
}

function BuildingArticle({ b }: { b: BuildingDef }) {
  const w = store.world;
  const h = w?.human();
  const upgradedBy = BUILDINGS.filter((x) => x.upgrades === b.id);
  const tile = !b.orbital && (b.yield.ind || b.yield.res || b.yield.pro)
    ? [b.yield.ind && 'red', b.yield.res && 'blue', b.yield.pro && 'green'].filter(Boolean) as ('red' | 'blue' | 'green')[]
    : [];
  const cost = w && h ? w.buildingCost(h.id, b.id) : b.cost;
  return (
    <>
      <Head kicker={`${b.orbital ? 'Orbital' : 'Surface'} structure · ${ROLE_LABEL[b.role]}`} title={b.name} hero={<BuildingIcon id={b.id} size={88} />}>
        {(b.yield.ind || b.yield.res || b.yield.pro) ? <Yields ind={b.yield.ind} res={b.yield.res} pro={b.yield.pro} size={16} /> : null}
      </Head>
      <p class="ency-lead">{b.desc}</p>
      <Stats items={[
        ['Cost', <span class="ind">{fmt(cost)}</span>, 'Industry to build (includes your species modifier)'],
        ['Workers', b.needsWorker ? '1' : 'None', b.needsWorker ? 'Needs one population to operate, unless automated' : 'Runs without population'],
        ...(b.housing ? [['Housing', `+${b.housing} pop`] as [string, string]] : []),
        ...(b.unique ? [['Limit', 'One per planet'] as [string, string]] : []),
        ...(b.scan ? [['Sensors', `${b.scan}`] as [string, string]] : []),
      ]} />
      {tile.length > 0 && (
        <p>Output is <b>doubled</b> on {tile.map((c, i) => <>{i > 0 && ' / '}<span class="ency-sw" style={{ background: SW[c] }} />{c}</>)} tiles.</p>
      )}
      {b.bonus && (
        <>
          <h4>Planet-wide bonus</h4>
          <ul>{Object.entries(b.bonus).map(([k, v]) => <li key={k}><b class="good">+{Math.round(v! * 100)}%</b> {MULT_LABEL[k].toLowerCase()} on this planet</li>)}</ul>
        </>
      )}
      {b.defense && (
        <>
          <h4>Defense</h4>
          <Stats items={[
            ['Hull', b.defense.hp],
            ...(b.defense.shield ? [['Shield', b.defense.shield] as [string, number]] : []),
            ...(b.defense.damage ? [['Damage', `${b.defense.damage} × ${b.defense.shots ?? 1}`] as [string, string]] : []),
            ...(b.defense.range ? [['Range', b.defense.range] as [string, number]] : []),
          ]} />
          {b.defense.damage ? <p class="small dim">Armed orbital defenses must be destroyed before enemy troops can land. See <L to="guide:combat" />.</p> : null}
        </>
      )}
      <h4>Availability</h4>
      <p>{b.tech ? <>Requires <L to={`tech:${b.tech}`} />{w && h ? (w.knows(h.id, b.tech) ? <span class="good"> — researched</span> : <span class="dim"> — not yet researched</span>) : null}.</> : 'Available from the start.'}</p>
      {b.upgrades && <p>Upgrades <L to={`building:${b.upgrades}`} />: with auto-upgrade on, existing ones are replaced automatically.</p>}
      {upgradedBy.length > 0 && <p>Replaced by {upgradedBy.map((u, i) => <>{i > 0 && ', '}<L to={`building:${u.id}`} /></>)} once researched.</p>}
    </>
  );
}

function ProjectArticle({ p }: { p: ProjectDef }) {
  return (
    <>
      <Head kicker="Planet project" title={p.name} hero={<span style={{ color: 'var(--accent)' }}><Icon.gear size={64} /></span>} />
      <p class="ency-lead">{p.desc}</p>
      <p>Projects run whenever a planet has nothing in its build queue, so its industry is never wasted. Set one from the planet panel, or on many planets at once from the Empire screen’s Planets tab.</p>
      <p>{p.tech ? <>Requires <L to={`tech:${p.tech}`} />.</> : 'Available from the start.'}</p>
      <h4>Other projects</h4>
      <div class="ency-chips">{PROJECTS.filter((x) => x.id !== p.id).map((x) => <CardLink key={x.id} to={`project:${x.id}`} />)}</div>
    </>
  );
}

function PartArticle({ p }: { p: PartDef }) {
  const w = store.world;
  const h = w?.human();
  const items: [string, ComponentChildren, string?][] = [
    ['Cost', <span class="ind">{p.cost}</span>],
    p.category === 'generator' ? ['Power supply', <span class="good">+{p.power}</span>] : ['Power draw', p.power ? <span class="warn">{p.power}</span> : 'None'],
  ];
  if (p.damage) {
    items.push(['Damage', `${p.damage} × ${p.shots ?? 1}`, 'Damage per shot × shots per round']);
    items.push(['Per round', `${p.damage * (p.shots ?? 1)}`]);
    items.push(['Range', `${p.range}`]);
  }
  if (p.strength) items.push(['Absorbs', `${p.strength} / round`, 'Blocks this much damage every round, then recharges']);
  if (p.speed) items.push(['Drive', `+${p.speed}`, 'Speed = total drive ÷ hull mass']);
  if (p.scan) items.push(['Sensors', `${p.scan}`]);
  if (p.hp) items.push(['Hull', `+${p.hp}`]);
  if (p.consumable) items.push(['Use', 'Consumed']);
  const peers = PARTS.filter((x) => x.category === p.category && x.id !== p.id);
  return (
    <>
      <Head kicker={`Ship part · ${cap(p.category)}`} title={p.name} hero={<PartIcon id={p.id} size={84} />} />
      <p class="ency-lead">{p.desc}</p>
      <Stats items={items} />
      <p>{p.tech ? <>Requires <L to={`tech:${p.tech}`} />{w && h ? (w.knows(h.id, p.tech) ? <span class="good"> — researched</span> : <span class="dim"> — not yet researched</span>) : null}.</> : 'Available from the start.'}</p>
      {p.category === 'weapon' && p.shots && p.shots > 2 && <p class="small dim">Many small shots: excellent against weak shields, poor against strong ones.</p>}
      {p.special === 'laneDrive' && <p class="small dim">Every ship in a fleet needs one to cross an unstable lane.</p>}
      <h4>Other {p.category === 'special' ? 'special parts' : p.category + 's'}</h4>
      <div class="ency-chips">{peers.map((x) => <CardLink key={x.id} to={`part:${x.id}`} />)}</div>
      <p class="small dim" style={{ marginTop: 12 }}>See <L to="guide:ships" /> for power, speed and refits.</p>
    </>
  );
}

function HullArticle({ h }: { h: HullDef }) {
  const w = store.world;
  const me = w?.human();
  const species = me?.species ?? SPECIES[0].id;
  const color = me?.color ?? SPECIES[0].color;
  return (
    <>
      <Head kicker="Ship hull" title={h.name} hero={<ShipImage species={species} hull={h.id} color={color} size={90} />} />
      <Stats items={[
        ['Slots', h.slots], ['Hull points', h.hp], ['Cost', <span class="ind">{h.cost}</span>],
        ['Mass', h.mass, 'Speed = total drive ÷ mass. Heavier hulls need more drives.'],
      ]} />
      <p>A {h.name.toLowerCase()} carries {h.slots} parts. With mass {h.mass}, it needs {h.mass} drive point{h.mass > 1 ? 's' : ''} for speed 1 — for example {h.mass} × <L to="part:iondrive" />.</p>
      <p>{h.tech ? <>Requires <L to={`tech:${h.tech}`} />.</> : 'Available from the start.'}</p>
      <h4>All hulls</h4>
      <table class="list ency-kv">
        <thead><tr><th>Hull</th><th>Slots</th><th>Hull pts</th><th>Mass</th><th>Cost</th></tr></thead>
        <tbody>
          {HULLS.map((x) => (
            <tr key={x.id} style={{ background: x.id === h.id ? 'rgba(127,220,255,0.08)' : undefined }}>
              <td>{x.id === h.id ? <b>{x.name}</b> : <L to={`hull:${x.id}`}>{x.name}</L>}</td><td>{x.slots}</td><td>{x.hp}</td><td>{x.mass}</td><td class="ind">{x.cost}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function TechArticle({ id }: { id: string }) {
  const t = TECH[id];
  const w = store.world;
  const h = w?.human();
  const u = unlocksOf(id);
  const leadsTo = TECHS.filter((x) => x.prereqs.includes(id));
  const known = w && h ? w.knows(h.id, id) : false;
  const current = h?.research.current === id;
  const queued = h?.research.queue.includes(id);
  const path = w && h && !known ? techPath(w, h.id, id) : [];
  const cost = w && h ? w.techCost(h.id, id) : t.cost;
  const color = CAT_COLOR[t.category];
  const unlockKeys = [
    ...u.buildings.map((b) => `building:${b.id}`),
    ...u.parts.map((p) => `part:${p.id}`),
    ...u.hulls.map((x) => `hull:${x.id}`),
    ...u.projects.map((p) => `project:${p.id}`),
  ];
  return (
    <>
      <Head
        kicker={<span style={{ color }}>Technology · Tier {t.tier} · {cap(t.category)}</span>}
        title={t.name}
        hero={<svg width="84" height="84" viewBox="0 0 84 84"><circle cx="42" cy="42" r="30" fill={color} fill-opacity="0.12" stroke={color} stroke-width="2" /><circle cx="42" cy="42" r="38" fill="none" stroke={color} stroke-opacity="0.3" stroke-dasharray="4 6" /><text x="42" y="50" text-anchor="middle" fill={color} font-size="24" font-family="Chakra Petch, sans-serif" font-weight="700">{['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'][t.tier] ?? t.tier}</text></svg>}
      >
        {h && (
          <div class="row wrap">
            {known ? <span class="ency-status known">✓ Researched</span> : current ? <span class="ency-status cur">Researching now</span> : queued ? <span class="ency-status cur">Queued</span> : <span class="ency-status">Not researched</span>}
            {!known && !current && w && h && (
              <button class="btn sm primary" onClick={() => { dispatch({ t: 'researchTowards', tech: id }); act(undefined, path.length > 1 ? `Researching toward ${t.name} (${path.length} steps).` : `Researching ${t.name}.`); }}>
                <Icon.flask size={13} />Research {path.length > 1 ? `(${path.length} steps)` : 'now'}
              </button>
            )}
          </div>
        )}
      </Head>
      <p class="ency-lead">{t.desc}</p>
      <Stats items={[
        ['Cost', <span class="res">{fmt(cost)}</span>, 'Research points. Costs rise slightly once you hold more than four planets.'],
        ['Tier', t.tier],
        ...(h && !known && path.length ? [['Steps away', path.length] as [string, number]] : []),
      ]} />
      {t.capstone && <p class="warn">The final discovery: unlocks the Ascension Gate. See <L to="guide:victory" />.</p>}
      <h4>Unlocks</h4>
      {unlockKeys.length ? <div class="ency-chips">{unlockKeys.map((k) => <CardLink key={k} to={k} />)}</div> : <p class="dim">No new structures or parts — this technology improves your empire directly or opens the way to later discoveries.</p>}
      <h4>Requires</h4>
      {t.prereqs.length ? (
        <div class="ency-chips">{t.prereqs.map((p) => <TechChip key={p} id={p} />)}</div>
      ) : <p class="dim">Nothing — available from the start.</p>}
      {leadsTo.length > 0 && (
        <>
          <h4>Leads to</h4>
          <div class="ency-chips">{leadsTo.map((x) => <TechChip key={x.id} id={x.id} />)}</div>
        </>
      )}
    </>
  );
}

function TechChip({ id }: { id: string }) {
  const go = useContext(Nav);
  const w = store.world;
  const h = w?.human();
  const known = w && h ? w.knows(h.id, id) : false;
  const t = TECH[id];
  return (
    <span class="ency-card-link" onClick={() => go(`tech:${id}`)} data-tip={`Tier ${t.tier} · ${cap(t.category)}`}>
      <span class="ency-dot" style={{ background: CAT_COLOR[t.category], marginLeft: 4 }} />
      <span>{t.name}</span>
      {known && <span class="good" style={{ fontSize: 12 }}>✓</span>}
    </span>
  );
}

# Ascendant — design notes

## Goals

1. Keep what made Ascendancy special: star lanes (including dangerous red lanes), planets as colored-tile grids where placement matters, a sprawling tech web, a component-based ship builder with per-part refits, and species that play differently rather than just carrying stat modifiers.
2. Fix what players complained about. The source is the r/4Xgaming thread ["Just discovered Ascendancy. So overwhelmed with emotions!"](https://www.reddit.com/r/4Xgaming/comments/m1xofl/) plus long-standing reviews.
3. Scale up: larger galaxies, more empires, longer games, without the UI cost growing with them.

## Complaints → fixes

| Source | Complaint | Fix | Where |
| --- | --- | --- | --- |
| u/meritan | "10 systems × 5 planets × 50 tiles × 2 builds × 4 clicks ≈ 10,000 clicks, nearly all mindless" | Governor per planet (focus: balanced/industry/research/growth/defense), queues, auto-upgrade chains (factory→megaplex…), empire-wide bulk governor/focus, drag-to-paint, suggestions with reasons | `sim/governor.ts`, `ui/hud/PlanetScreen.tsx`, Empire screen |
| u/coder111 | "I'd LOVE a remake with modern UI and some governor" | As above; the governor explains each pick ("on a research tile", "population is at capacity") | `governorCandidates().why` |
| u/Improv17 | Self-managed mode existed but was hidden behind the `M` key | Big visible toggle; new colonies are governed by default (a preference); `M` still toggles | PlanetScreen, `Empire.prefs` |
| OP, u/Celestael | AI "passive and incompetent"; the only challenge came from the Antagonizer patch | Strategic AI: personality-weighted expansion, threat maps, fleets sized to threats, doom-stack staging, invasion trains that follow the main fleet, war/peace/alliance decisions, tech trades, species abilities | `sim/ai/index.ts` |
| u/SedrynTyros | The Antagonizer patch made enemy ships flee to the edge to stall battles | Compact arena, hard cap of 24 rounds, evasive fleets retreat *off-map* to their previous star (the battle ends), tractor beams prevent escape | `sim/combat.ts` |
| u/tsubasanut | AI builds on the wrong squares, so captured planets need rebuilding | AI uses the same governor, so its layouts are sound; "Re-optimize layout" queues replacements | `commands.reoptimize` |
| u/VulcanTourist | Drop-downs don't prioritize the latest devices; let players customize them | Part and structure pickers sort best/newest first, show NEW badges, and offer auto-design per role | Designer, PlanetScreen palette |
| u/VulcanTourist | No visual distinction between roboticized and original structures | Automated structures get a gear badge and run at 75%; unstaffed structures are greyed and tagged IDLE | PlanetScreen, `World.econ` |
| u/VulcanTourist | RSI from clicks | Keyboard shortcuts for everything, "Until event" time mode, bulk actions | App shortcuts |
| u/coder111 | Save-scumming the xeno dig until it gives Engineering, which then dominates | Ruin rewards are rolled at galaxy generation; all randomness is seeded and saved; automation only helps idle structures and costs full price | `gen.ts`, `rng.ts` |
| u/DocBuckshot | "3D ship movement and combat could be clunky" | 2D map with smooth pan/zoom, multi-hop routes with ETAs; auto-resolved battles with a replay viewer | `render/galaxy.ts`, Battle screen |
| u/Improv17 | The iOS port could "command ships to go to any system from any system" | Dijkstra routing on lane travel time; right-click anywhere; blockades stop routes at hostile systems | `World.route` |
| u/Decmon | (Endless series) refitting changes every ship, and you lose track of which is which | Ships keep their identity; refits are per component and queued at shipyards; ships show "outdated"/"custom" tags | FleetPanel, `commands.refitFleetTo` |
| u/es0tericeccentric | Conquest victory triggers at 2/3 of the galaxy, and top rewards need odd "divide and conquer" play | Configurable conditions (conquest, domination %, ascension, galactic accord, score/day limit), all shown with progress | `sim/victory.ts` |
| Reviews | "Almost impossible to forge alliances … wait a few thousand turns" | Attitude = a visible sum of reasons; proposals preview acceptance and reasons before sending | `sim/diplomacy.ts` |
| OP | "Somewhat redundant UI" / overwhelming | Tooltips on everything, an encyclopedia with how-to-play guides, an outliner and an event log with filters | `ui/` |

## Scale

- Galaxy generation: rejection-sampled stars in 5 shapes; lanes from a Gabriel graph (planar, so no lanes cross) with an MST backbone to guarantee connectivity; unstable lanes are only ever *extra* edges, so every star stays reachable.
- Simulation: flat arrays, per-day caches (planet economy, threat maps, ship stats), Dijkstra with a binary heap. Roughly 1–6 ms per simulated day at 120–150 stars with 6–7 AI empires (`npm run sim`).
- Rendering: PixiJS/WebGL; one sprite per star, lanes redrawn only when exploration changes, star labels created lazily and culled by zoom and viewport, territory drawn as tinted blob sprites instead of blur filters.
- Saves: gzip in IndexedDB (a 150-star game at day 500 is roughly 750 KB of JSON before compression), plus export/import files.

## Economy in one paragraph

Each planet has a tile grid. Structures produce **industry** (spent on that planet's queue), **research** (pooled empire-wide) and **prosperity** (grows that planet's population). Red, blue and green tiles double the matching output. Each structure needs a worker (one population), unless it's automated. When a planet's queue is empty, its industry goes to a *project*: Research Grants, Endless Festival, Supply Convoy (feeds a logistics pool that speeds up needy planets), Diplomatic Outreach, or Fortify. Tech costs grow with empire size so wide empires don't snowball.

## Content is data

Techs, structures, projects, parts, hulls, planet types and species live in `src/sim/content/`. IDs are strings, so adding content doesn't renumber anything.

# Ascendant

**Play:** https://ascendant-sqfvt.ondigitalocean.app — works on desktop and phones (add it to your home screen for full-screen play).

A modern, browser-based 4X built on the framework of **Ascendancy** (The Logic Factory, 1995): star lanes, planets as tile grids with colored squares, a spiral tech tree, part-by-part ship design, and a galaxy of truly strange species — rebuilt to scale, and with the original's well-known problems fixed.

```bash
npm install
npm run dev          # play at http://localhost:5173
npm test             # simulation test suite
npm run sim -- --stars 300 --empires 8 --days 1500   # headless AI-vs-AI game
npm run build        # static build in dist/ (deploy anywhere)
```

Deploys: DigitalOcean App Platform static site from `.do/app.yaml` (app `ascendant`). It builds from the public git URL, so pushes don't auto-deploy — trigger a redeploy from the DO dashboard (or ask Claude). Online multiplayer uses the Supabase project `ascendant` (Realtime only, no tables).

Dev shortcut: open `http://localhost:5173/?quick` (or `?quick=SEED&stars=600`) to skip the menus.

## 3D and multiplayer

- **3D views:** galaxy map (2D/3D toggle at the top of the map), system view ("3D view" in the system panel), planet globe (Globe/Grid toggle on the planet screen), and battle replays (2D/3D in the replay controls). Ships, stations and buildings are original models generated in Blender: `npm run build-models` (see [docs/MODELS.md](docs/MODELS.md)).
- **Multiplayer:** deterministic lockstep: every player runs the same simulation and only commands are sent. Main menu → Multiplayer to host or join by room code. Works between tabs on one machine out of the box; for online play add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` to `.env.local` (see [docs/MULTIPLAYER.md](docs/MULTIPLAYER.md)).

## Original content

Everything the game ships with is original: 21 species with their own traits, abilities, lore and procedurally painted portraits (`src/art/portraits.ts`), plus new names for techs, structures, parts and planet types. The design follows Ascendancy's structure (game mechanics aren't copyrightable), but none of its names, text or art ship with the game.

## Classic art (optional, local only, off by default)

The game ships with resolution-independent procedural art and needs nothing else. If you own the original, you can use its art, upscaled:

```bash
# put the original game folder (with ASCEND0*.COB) at ./ascendancy, then:
npm run import-classic                # or: python3 tools/import_classic.py --game /path --scale 4
```

This decodes the original `.COB` archives and `.SHP` sprites (the format is documented in `tools/shp.py`), removes the 8-bit dithering, upscales with Lanczos and sharpening via `ffmpeg` (or Real-ESRGAN if `realesrgan-ncnn-vulkan` is on your PATH), and writes PNGs to `public/classic/`. The game detects them on startup and uses the original planets, suns, species portraits, structures, ship parts and ships; toggle it under Settings. That folder is git-ignored, and `npm run build` strips it from `dist/`. The original art is The Logic Factory's copyright, so keep it on your machine (`INCLUDE_CLASSIC=1 npm run build` if you really want a private local build with it).

## What's fixed from the original

See [docs/DESIGN.md](docs/DESIGN.md) for the full list. In short:

| Complaint about the 1995 game | Ascendant |
| --- | --- |
| ~10,000 clicks of per-tile micromanagement by midgame | Planet **governors** with focuses, build queues, auto-upgrades, drag-to-paint building, empire-wide bulk controls |
| Self-managed mode hidden behind the `M` key | Governor is a big visible toggle, on by default for new colonies (`M` still works) |
| Passive AI that "just sits there"; the Antagonizer patch only made enemies flee to the screen edge | AI with personalities that expands, stages fleets, invades and negotiates; battles are capped at 24 rounds, so they can't be dragged out |
| Part drop-downs don't prioritize the newest devices | Pickers sorted best-first, NEW badges, and auto-design for every role |
| No visual difference for automated ("roboticized") structures | Gear badge, and idle structures are greyed out with an IDLE tag |
| Save-scumming the xeno-archaeology dig for Engineering | Ruin rewards are rolled when the galaxy forms, and all randomness is seeded and saved |
| Captured planets have structures on the wrong squares | The AI uses the same governor; one-click **Re-optimize layout** |
| Clunky 3D ship movement | Flat 2D map with multi-hop routing and ETAs (click-to-route anywhere, like the iOS port) |
| Odd conquest rule (2/3 of the galaxy ends the game) | Clear, configurable victory conditions with progress bars |
| Alliances take thousands of turns to warm up | Attitude broken down into visible reasons; you see whether a proposal will be accepted before sending it |
| Tiny galaxies | 30 to 2,000 stars and 2 to 16 empires, rendered with WebGL |

## Project layout

```
src/sim/        deterministic simulation (no DOM) — runs in tests and headless
  content/      techs, structures, parts, hulls, planet types, species (data-driven)
  gen.ts        galaxy generation (5 shapes, planar lane network, homeworld placement)
  economy.ts    production, growth, logistics, research
  governor.ts   planet automation (shared by the player and the AI)
  combat.ts     2D tactical auto-resolve with replay frames
  diplomacy.ts  attitudes, proposals, evaluation
  ai/           strategic AI and the automatic ship designer
src/render/     PixiJS galaxy map
src/art/        procedural art + classic-art loader
src/ui/         Preact UI (HUD, planet screen, research, designer, diplomacy, …)
tools/          .COB/.SHP decoders and the classic-art importer
```

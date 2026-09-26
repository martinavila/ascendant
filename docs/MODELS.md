# 3D models

All ships, orbital stations and surface buildings are **original**, procedurally
modelled in Blender by one script, `tools/blender/build_assets.py`, and exported
as `.glb` into `public/models/`. The client loads them through
`public/models/manifest.json` (see `src/render3d/common.ts`), and falls back to
primitives when a model is missing.

## Regenerate

Requires Blender 4.2+ (built and tested with 5.2) on your `PATH`.

```sh
npm run build-models
# same as:
blender -b --factory-startup --python tools/blender/build_assets.py -- --out public/models
```

Options after `--`:

| flag | meaning |
| --- | --- |
| `--out DIR` | output directory (default `public/models`) |
| `--only STR` | rebuild only models whose key contains `STR`, e.g. `--only crystal_`. The manifest is still written in full. |
| `--blend DIR` | also save a `.blend` for each model into `DIR`, for hand editing (keep it outside the repo) |

The output is seeded (`random.Random(crc32(key))`), so the geometry comes out the
same on every run. The exporter can still write triangles in a different order,
so a rebuild may change `.glb` bytes without changing the shape. Only commit
`public/models` when a model has actually changed.

The full set is about 3 MB (53 files). No file is over 210 KB, and no file has
textures or UVs: every surface is a flat PBR material.

## Layout and naming

```
public/models/
  manifest.json
  ships/<family>_<hull>.glb      family: angular | organic | crystal | saucer
                                 hull:   small | medium | large | enormous | titan
  stations/<kind>.glb            shipyard docks missile lance shield solar research habitat
  buildings/<id-or-role>.glb
```

`manifest.json`:

```json
{ "version": 1,
  "ships":     { "angular_small": "ships/angular_small.glb", ... },
  "stations":  { "docks": "stations/docks.glb", "solararray": "stations/solar.glb", ... },
  "buildings": { "factory": "buildings/factory.glb", "industry": "buildings/industry.glb", ... } }
```

- **Stations** also have aliases for the orbital building ids (`solararray`,
  `researchstation`, `habring`, `missilebase`, `heavylance`, `orbshield`,
  `megashield`), which point at the matching station file.
- **Buildings** have one generic model per role (`industry research prosperity
  housing mixed defense special shipyard`) plus id-specific models (`colonybase
  factory lab agridome habitat megaplex campus hydrospire garrison observatory
  excavation metroplex fusionhub datasphere biosphere cloningvats surfshield`).
  The game looks up `buildings[id] ?? buildings[role]`.

### Axes and scale

The exporter converts Blender's Z-up to glTF/three.js Y-up.

| | Blender | three.js |
| --- | --- | --- |
| ships: nose | +X | +X |
| up | +Z | +Y |

- **Ships** are centred on the origin. Each is scaled so its length along X is
  exactly 1.0 / 1.5 / 2.0 / 2.5 / 3.0 for small, medium, large, enormous and titan.
  Wide hulls (saucers with rings, crystal clusters) can be about as wide as they are long.
- **Stations** are centred on the origin and measure about 0.8–1.5 units across.
  Rings (docks, habitat, shield) lie in the horizontal XZ plane in three.js.
- **Buildings** have a footprint of at most 1×1 centred on the origin, with the base at
  y = 0 and heights from 0.3 to 1.2.

### Material contract

The game recolours materials by their name prefix:

| prefix | use | in game |
| --- | --- | --- |
| `Paint*` (`Paint`, `PaintShell`, `PaintGem`) | main hull panels, roofs, trims | set to the empire colour |
| `Glow*` | engines, windows, lights, cores | emissive, set to the accent colour |
| anything else | `Metal`, `Dark`, `Glass`, `Bone`, `Sinew`, `Crystal`, `Gold`, `Concrete`, `Solar`, `Plant`, `Water`, `Rock` | left as authored |

All materials are Principled BSDF, so they export as glTF metallic-roughness.
`Glow` also exports `KHR_materials_emissive_strength`, which three.js supports.

## Family design language

- **angular**: a faceted wedge hull with a keel plate, a dark engine block with
  glowing bells, a glass canopy and swept wings. Larger hulls add canted twin tail
  fins, then armoured sponsons and turrets, then outboard nacelles on pylons.
  The titan adds a split bow, a command tower and dorsal vents.
- **organic**: a smooth, subdivided shell with bone rib hoops, a glowing rear
  orifice, glowing spots along the flanks and trailing tendrils. Larger hulls add
  membrane fins, then twin side lobes, then a dorsal crest of spines. The titan
  adds manta wings.
- **crystal**: a hexagonal bipyramid spine with a glowing rear heart and
  swept-back pale shards. Larger hulls add dark collars with glow bands, then a
  radial crown, then twin flanking prisms on struts. The titan adds a forward
  prism ring and a dorsal spire.
- **saucer**: a lens disc with a metal rim and a glowing underside ring, a glass
  dome, a forward sensor prow and a rear drive block. Larger hulls add side pods,
  then an outer ring on spokes, then an upper deck with ring-mounted pods. The
  titan adds a central spire with its own ring.

## Hand-editing a model

1. Generate `.blend` sources:
   `blender -b --factory-startup --python tools/blender/build_assets.py -- --out /tmp/models --blend /tmp/blends --only saucer_titan`
2. Open `/tmp/blends/saucer_titan.blend`. The model is one joined, triangulated
   mesh object. Edit it, but keep the material names, the axes and the origin rules above.
3. Export it with **File → Export → glTF 2.0**:
   - Format: glTF Binary (`.glb`)
   - Include → Limit to: Selected Objects
   - Transform: +Y Up
   - Data → Mesh: Apply Modifiers and Normals **on**, UVs **off** unless you add textures
   - Materials: Export
   - Save over `public/models/ships/saucer_titan.glb`
4. **A hand edit is lost when `npm run build-models` next rebuilds that key.**
   To keep an edit, either:
   - port the change into the builder function in `build_assets.py` (preferred), or
   - stop rebuilding that model: remove its builder from the script's
     `SHIP_BUILDERS` / `STATIONS` / `BUILDINGS` tables and add its manifest entry
     by hand in `main()`.

## Adding a model

Write a builder function `fn(rng)` in `build_assets.py` using the helpers:

- primitives: `bm_box`, `bm_cyl`, `bm_sphere`, `bm_ico`, `bm_torus`, `bm_lathe`,
  `bm_plate`, `bm_tube`, `bm_shard`, `bm_rings`
- placement: `add(bm, 'Material', loc=, rot=, scale=, bevel=, subsurf=, smooth=, mirror=, array=)`
  places a primitive and bakes its modifiers
- symmetry: `both(fn)` calls `fn` once for each side

Then register the function in `STATIONS` or `BUILDINGS`. For a new ship family, add
it to `SHIP_BUILDERS` and to `SHIP_FAMILIES` in `src/render3d/common.ts`.

"""
Ascendant -- procedural 3D asset builder.

Generates every ship, station and planet-surface building used by the game as
original, procedurally modelled glTF binaries, plus a manifest the client reads
(see src/render3d/common.ts).

Run (from the repo root):
    blender -b --factory-startup --python tools/blender/build_assets.py -- --out public/models
Options after "--":
    --out DIR        output directory (default: public/models)
    --only SUBSTR    only rebuild models whose key contains SUBSTR (manifest is still written in full)
    --blend DIR      also save a .blend per model into DIR (for hand editing)

Conventions (Blender space, converted by the glTF exporter to three.js Y-up):
    ships     nose along +X, up +Z (-> +Y in glTF), centred on the origin
    stations  centred on the origin
    buildings footprint centred on the origin, base on z = 0 (-> y = 0)
Material naming contract (the game recolours by prefix):
    Paint*  -> empire colour        Glow* -> emissive accent colour
    anything else (Metal, Dark, Glass, Bone, ...) is left as authored.

Everything is deterministic: randomness comes from random.Random(crc32(model key)).
"""

import bpy
import bmesh
import json
import math
import os
import random
import sys
import zlib
from mathutils import Euler, Matrix, Vector

TAU = math.pi * 2

# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    opts = {'out': 'public/models', 'only': None, 'blend': None}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ('--out', '--only', '--blend') and i + 1 < len(argv):
            opts[a[2:]] = argv[i + 1]
            i += 2
        else:
            i += 1
    return opts


# ---------------------------------------------------------------------------
# Materials
# ---------------------------------------------------------------------------

MAT_SPECS = {
    # name:        base colour,            metallic, roughness, emission (colour, strength)
    'Paint':       ((0.42, 0.50, 0.62), 0.45, 0.38, None),
    'PaintGem':    ((0.45, 0.55, 0.70), 0.25, 0.12, None),
    'PaintShell':  ((0.42, 0.50, 0.62), 0.10, 0.45, None),
    'Metal':       ((0.60, 0.62, 0.66), 0.85, 0.32, None),
    'Dark':        ((0.07, 0.075, 0.09), 0.60, 0.50, None),
    'Glass':       ((0.03, 0.07, 0.12), 0.30, 0.06, None),
    'Glow':        ((0.85, 0.95, 1.00), 0.00, 0.40, ((0.45, 0.85, 1.0), 3.0)),
    'Bone':        ((0.74, 0.70, 0.60), 0.00, 0.55, None),
    'Sinew':       ((0.16, 0.12, 0.15), 0.10, 0.50, None),
    'Crystal':     ((0.72, 0.86, 0.94), 0.10, 0.08, None),
    'Gold':        ((0.85, 0.65, 0.28), 1.00, 0.28, None),
    'Concrete':    ((0.46, 0.45, 0.43), 0.00, 0.85, None),
    'Solar':       ((0.04, 0.07, 0.20), 0.70, 0.18, None),
    'Plant':       ((0.16, 0.48, 0.16), 0.00, 0.80, None),
    'Water':       ((0.08, 0.30, 0.50), 0.20, 0.08, None),
    'Rock':        ((0.36, 0.28, 0.21), 0.00, 0.95, None),
}


def mat(name):
    m = bpy.data.materials.get(name)
    if m:
        return m
    base, metal, rough, emit = MAT_SPECS[name]
    m = bpy.data.materials.new(name)
    if m.node_tree is None:
        m.use_nodes = True
    bsdf = m.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*base, 1.0)
    bsdf.inputs['Metallic'].default_value = metal
    bsdf.inputs['Roughness'].default_value = rough
    if emit:
        bsdf.inputs['Emission Color'].default_value = (*emit[0], 1.0)
        bsdf.inputs['Emission Strength'].default_value = emit[1]
    m.diffuse_color = (*base, 1.0)
    return m


# ---------------------------------------------------------------------------
# bmesh primitive builders (return a fresh BMesh in local space)
# ---------------------------------------------------------------------------

def bm_rings(rings, closed=False, cap=True):
    """Skin a list of rings. A ring is a list of Vectors (all the same length) or a
    single Vector (an apex). closed=True joins the last ring back to the first."""
    bm = bmesh.new()
    vr = []
    for r in rings:
        if isinstance(r, Vector):
            vr.append(bm.verts.new(r))
        else:
            vr.append([bm.verts.new(p) for p in r])
    pairs = list(zip(vr, vr[1:]))
    if closed:
        pairs.append((vr[-1], vr[0]))
    for a, b in pairs:
        if isinstance(a, list) and isinstance(b, list):
            n = len(a)
            for i in range(n):
                bm.faces.new((a[i], a[(i + 1) % n], b[(i + 1) % n], b[i]))
        elif isinstance(a, list):
            n = len(a)
            for i in range(n):
                bm.faces.new((a[i], a[(i + 1) % n], b))
        else:
            n = len(b)
            for i in range(n):
                bm.faces.new((a, b[(i + 1) % n], b[i]))
    if cap and not closed:
        if isinstance(vr[0], list):
            bm.faces.new(vr[0])
        if isinstance(vr[-1], list):
            bm.faces.new(vr[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def ring_yz(x, pts, cy=0.0, cz=0.0):
    return [Vector((x, cy + y, cz + z)) for (y, z) in pts]


def circle_yz(x, r, n, zs=1.0, cy=0.0, cz=0.0, phase=0.0):
    return [Vector((x, cy + math.cos(phase + TAU * i / n) * r, cz + math.sin(phase + TAU * i / n) * r * zs)) for i in range(n)]


def bm_box(sx, sy, sz):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=Vector((sx, sy, sz)), verts=bm.verts)
    return bm


def bm_cyl(r1, r2, depth, n=16):
    """Cylinder / cone along +Z, centred."""
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=n, radius1=r1, radius2=r2, depth=depth)
    return bm


def bm_sphere(r, u=16, v=10):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=u, v_segments=v, radius=r)
    return bm


def bm_ico(r, sub=1):
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=sub, radius=r)
    return bm


def bm_torus(R, r, n=24, m=8):
    rings = []
    for i in range(n):
        u = TAU * i / n
        c = Vector((math.cos(u) * R, math.sin(u) * R, 0))
        rad = Vector((math.cos(u), math.sin(u), 0))
        rings.append([c + (rad * math.cos(TAU * j / m) + Vector((0, 0, 1)) * math.sin(TAU * j / m)) * r for j in range(m)])
    return bm_rings(rings, closed=True)


def bm_lathe(profile, n=32):
    """Revolve [(r, z), ...] around Z. r == 0 makes an apex."""
    rings = []
    for r, z in profile:
        if r <= 1e-6:
            rings.append(Vector((0, 0, z)))
        else:
            rings.append([Vector((math.cos(TAU * i / n) * r, math.sin(TAU * i / n) * r, z)) for i in range(n)])
    return bm_rings(rings)


def bm_plate(poly, t):
    """Extrude a 2D polygon [(x, y)] in the XY plane by thickness t along Z."""
    return bm_rings([[Vector((x, y, -t / 2)) for x, y in poly], [Vector((x, y, t / 2)) for x, y in poly]])


def bm_tube(path, radii, n=8, zs=1.0):
    """Sweep a circle along a polyline (list of Vector) with per-point radius (0 -> apex)."""
    path = [Vector(p) for p in path]
    k = len(path)
    tans = [(path[min(i + 1, k - 1)] - path[max(i - 1, 0)]).normalized() for i in range(k)]
    nrm = tans[0].orthogonal().normalized()
    if abs(nrm.z) < 0.5:
        # prefer an "up" reference so zs squashes vertically
        up = Vector((0, 0, 1))
        nrm = (up - tans[0] * up.dot(tans[0]))
        nrm = nrm.normalized() if nrm.length > 1e-6 else tans[0].orthogonal().normalized()
    rings = []
    for i, p in enumerate(path):
        if i > 0:
            ax = tans[i - 1].cross(tans[i])
            if ax.length > 1e-7:
                nrm = Matrix.Rotation(tans[i - 1].angle(tans[i]), 3, ax.normalized()) @ nrm
        b = tans[i].cross(nrm)
        r = radii[i]
        if r <= 1e-6:
            rings.append(p.copy())
        else:
            rings.append([p + (b * math.cos(TAU * j / n) + nrm * math.sin(TAU * j / n) * zs) * r for j in range(n)])
    return bm_rings(rings)


def bm_shard(length, radius, sides=6, base=0.18, shoulder=0.72, taper=0.85):
    """Crystal bipyramid along +X starting at x=0 (rear tip) to x=length (point)."""
    ph = math.pi / sides
    return bm_rings([
        Vector((0, 0, 0)),
        circle_yz(length * base, radius, sides, phase=ph),
        circle_yz(length * shoulder, radius * taper, sides, phase=ph),
        Vector((length, 0, 0)),
    ])


# ---------------------------------------------------------------------------
# Object assembly
# ---------------------------------------------------------------------------

def xform(loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1)):
    if isinstance(scale, (int, float)):
        scale = (scale, scale, scale)
    return Matrix.LocRotScale(Vector(loc), Euler(rot, 'XYZ'), Vector(scale))


def add(bm, m, loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1), bevel=0.0, segs=2, subsurf=0,
        smooth=False, angle=35, mirror=False, array=None, pre=None):
    """Bake a BMesh into a scene object with material `m` and apply modifiers.
    pre: optional extra Matrix applied before loc/rot/scale.
    array: (count, (dx, dy, dz)) constant-offset array (world units, applied after transform).
    mirror: mirror across the XZ plane (y -> -y)."""
    M = xform(loc, rot, scale)
    if pre is not None:
        M = M @ pre
    bmesh.ops.transform(bm, matrix=M, verts=bm.verts)
    if M.determinant() < 0:
        bmesh.ops.reverse_faces(bm, faces=bm.faces)
    me = bpy.data.meshes.new('part')
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new('part', me)
    bpy.context.scene.collection.objects.link(ob)
    me.materials.append(mat(m))
    me.shade_smooth()
    if not smooth:
        me.set_sharp_from_angle(angle=math.radians(angle))
    if array:
        md = ob.modifiers.new('arr', 'ARRAY')
        md.count = array[0]
        md.use_relative_offset = False
        md.use_constant_offset = True
        md.constant_offset_displace = array[1]
    if mirror:
        md = ob.modifiers.new('mir', 'MIRROR')
        md.use_axis = (False, True, False)
        md.use_mirror_merge = False
    if bevel > 0:
        md = ob.modifiers.new('bev', 'BEVEL')
        md.width = bevel
        md.segments = segs
        md.limit_method = 'ANGLE'
        md.angle_limit = math.radians(30)
        md.harden_normals = not smooth
        md.miter_outer = 'MITER_ARC'
    if subsurf:
        md = ob.modifiers.new('sub', 'SUBSURF')
        md.levels = subsurf
        md.render_levels = subsurf
    if ob.modifiers:
        dg = bpy.context.evaluated_depsgraph_get()
        new = bpy.data.meshes.new_from_object(ob.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
        old = ob.data
        ob.modifiers.clear()
        ob.data = new
        bpy.data.meshes.remove(old)
        new.materials.clear()
        new.materials.append(mat(m))
        if smooth:
            new.shade_smooth()
    return ob


def both(fn):
    """Call fn(side) for side in (+1, -1): handy for symmetric parts."""
    for s in (1, -1):
        fn(s)


def clear_scene():
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    for me in list(bpy.data.meshes):
        if me.users == 0:
            bpy.data.meshes.remove(me)


def finalize(name, anchor, length=None):
    """Join all parts into one mesh, re-centre (and optionally scale so the X extent
    equals `length`), return the object and its dimensions."""
    objs = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    vl = bpy.context.view_layer
    for o in bpy.context.scene.objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    vl.objects.active = objs[0]
    if len(objs) > 1:
        bpy.ops.object.join()
    ob = vl.objects.active
    ob.name = name
    ob.data.name = name
    co = [v.co for v in ob.data.vertices]
    lo = Vector((min(c.x for c in co), min(c.y for c in co), min(c.z for c in co)))
    hi = Vector((max(c.x for c in co), max(c.y for c in co), max(c.z for c in co)))
    c = (lo + hi) / 2
    if anchor == 'base':
        c.z = lo.z
    M = Matrix.Translation(-c)
    dims = hi - lo
    if length:
        k = length / dims.x
        M = Matrix.Scale(k, 4) @ M
        dims = dims * k
    ob.data.transform(M)
    # triangulate up front so the exporter's (threaded) triangulation can't reorder indices between runs
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.triangulate(bm, faces=bm.faces, quad_method='BEAUTY', ngon_method='BEAUTY')
    bm.to_mesh(ob.data)
    bm.free()
    ob.data.update()
    return ob, dims


def export(ob, path, blend_dir=None, key=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    for o in bpy.context.scene.objects:
        o.select_set(o == ob)
    bpy.ops.export_scene.gltf(
        filepath=path, export_format='GLB', use_selection=True, export_apply=True,
        export_texcoords=False, export_normals=True, export_tangents=False,
        export_materials='EXPORT', export_yup=True, export_cameras=False, export_lights=False,
        export_animations=False, export_extras=False, export_vertex_color='NONE',
    )
    if blend_dir:
        os.makedirs(blend_dir, exist_ok=True)
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(blend_dir, key + '.blend'), copy=True)


# ---------------------------------------------------------------------------
# Ships
# ---------------------------------------------------------------------------

HULLS = ['small', 'medium', 'large', 'enormous', 'titan']
HULL_LEN = {'small': 1.0, 'medium': 1.5, 'large': 2.0, 'enormous': 2.5, 'titan': 3.0}


def nozzle(x, y, z, r, L, m_body='Dark'):
    """Engine bell facing -X with a glowing core."""
    add(bm_cyl(r * 0.8, r, r * 1.3, 14), m_body, loc=(x - r * 0.4, y, z), rot=(0, math.pi / 2, 0), bevel=r * 0.08, segs=1)
    add(bm_cyl(r * 0.72, r * 0.72, r * 0.2, 14), 'Glow', loc=(x - r * 1.02, y, z), rot=(0, math.pi / 2, 0))


def turret(x, y, z, s, facing=0.0, barrels=2):
    add(bm_cyl(s, s * 0.85, s * 0.5, 10), 'Dark', loc=(x, y, z + s * 0.25), bevel=s * 0.1, segs=1)
    add(bm_box(s * 1.1, s * 1.0, s * 0.55), 'Metal', loc=(x, y, z + s * 0.7), rot=(0, 0, facing), bevel=s * 0.12, segs=1)
    for i in range(barrels):
        off = (i - (barrels - 1) / 2) * s * 0.45
        dx, dy = math.cos(facing), math.sin(facing)
        add(bm_cyl(s * 0.1, s * 0.08, s * 1.6, 6), 'Dark',
            loc=(x + dx * s * 1.2 - dy * off, y + dy * s * 1.2 + dx * off, z + s * 0.72), rot=(0, math.pi / 2, facing))


# --- angular: hard-edged wedge warships with fins ---------------------------------

def angular_section(x, w, top, bot, cy=0.0, cz=0.0):
    return ring_yz(x, [(0, top), (0.62 * w, 0.42 * top), (w, 0.02 * top), (0.52 * w, -bot),
                       (-0.52 * w, -bot), (-w, 0.02 * top), (-0.62 * w, 0.42 * top)], cy, cz)


def angular_hull(L, wf, cy=0.0, cz=0.0, m='Paint', prof=None):
    prof = prof or [(0.00, 0.17, 0.09, 0.06), (0.07, 0.19, 0.11, 0.07), (0.50, 0.16, 0.105, 0.065),
                    (0.84, 0.075, 0.06, 0.035), (1.00, 0.014, 0.012, 0.008)]
    rings = [angular_section(-L / 2 + t * L, w * L * wf, tp * L * wf, bt * L * wf, cy, cz) for t, w, tp, bt in prof]
    add(bm_rings(rings), m, bevel=0.006 * L, segs=2)


def ship_angular(k, L, rng):
    wf = 1.0 - 0.07 * k           # bigger hulls are relatively slimmer
    angular_hull(L, wf)
    rear = -L / 2
    # keel stripe (dark underside plate)
    add(bm_plate([(rear + 0.05 * L, -0.07 * L * wf), (rear + 0.62 * L, -0.045 * L * wf), (rear + 0.62 * L, 0.045 * L * wf),
                  (rear + 0.05 * L, 0.07 * L * wf)], 0.02 * L), 'Dark', loc=(0, 0, -0.065 * L * wf), bevel=0.003 * L, segs=1)
    # engine block
    add(bm_box(0.09 * L, 0.30 * L * wf, 0.13 * L * wf), 'Dark', loc=(rear + 0.01 * L, 0, 0.01 * L), bevel=0.01 * L, segs=2)
    n_eng = [1, 2, 3, 4, 5][k]
    er = 0.045 * L * wf * (1.0 if n_eng < 3 else 0.8)
    for i in range(n_eng):
        yy = (i - (n_eng - 1) / 2) * er * 2.3
        zz = 0.01 * L + (0.02 * L if (n_eng == 3 and i == 1) else 0)
        nozzle(rear - 0.03 * L, yy, zz, er, L)
    # bridge canopy
    add(bm_rings([angular_section(rear + 0.16 * L, 0.05 * L, 0.035 * L, 0.0, cz=0.075 * L * wf),
                  angular_section(rear + 0.30 * L, 0.045 * L, 0.03 * L, 0.0, cz=0.075 * L * wf),
                  angular_section(rear + 0.40 * L, 0.01 * L, 0.004 * L, 0.0, cz=0.07 * L * wf)]),
        'Glass', bevel=0.002 * L, segs=1)
    # swept main wings (mirrored)
    span = (0.30 + 0.03 * k) * L
    wing = [(rear + 0.06 * L, 0.12 * L), (rear + 0.42 * L, 0.10 * L), (rear + 0.16 * L, span),
            (rear + 0.02 * L, span)]
    add(bm_plate(wing, 0.018 * L), 'Metal', loc=(0, 0, -0.005 * L), rot=(0, 0, 0), bevel=0.004 * L, segs=1, mirror=True,
        pre=Matrix.Rotation(math.radians(-6), 4, 'X'))
    # wingtip glow strip + weapon pods
    def tip(s):
        add(bm_box(0.12 * L, 0.012 * L, 0.012 * L), 'Glow', loc=(rear + 0.09 * L, s * span, -0.005 * L - math.sin(math.radians(6)) * span * s * 0 ))
        add(bm_cyl(0.012 * L, 0.018 * L, 0.2 * L, 6), 'Dark', loc=(rear + 0.14 * L, s * (span - 0.01 * L), 0.0), rot=(0, math.pi / 2, 0), bevel=0.003 * L, segs=1)
    both(tip)
    if k >= 1:
        # canted twin tail fins
        fin = [(rear + 0.02 * L, 0), (rear + 0.22 * L, 0), (rear + 0.06 * L, (0.16 + 0.02 * k) * L), (rear - 0.03 * L, (0.16 + 0.02 * k) * L)]
        def tf(s):
            add(bm_plate(fin, 0.014 * L), 'Paint', loc=(0, s * 0.09 * L * wf, 0.05 * L * wf),
                rot=(math.pi / 2 - s * math.radians(18), 0, 0), bevel=0.003 * L, segs=1)
        both(tf)
        # side glow windows
        add(bm_box(0.2 * L, 0.004 * L, 0.008 * L), 'Glow', loc=(rear + 0.32 * L, 0.163 * L * wf, 0.018 * L * wf), mirror=True)
    if k >= 2:
        # armoured sponsons along the flanks
        def spon(s):
            add(bm_rings([angular_section(rear + 0.1 * L, 0.035 * L, 0.03 * L, 0.03 * L, cy=s * 0.17 * L * wf),
                          angular_section(rear + 0.5 * L, 0.035 * L, 0.03 * L, 0.03 * L, cy=s * 0.15 * L * wf),
                          angular_section(rear + 0.62 * L, 0.01 * L, 0.01 * L, 0.01 * L, cy=s * 0.13 * L * wf)]),
                'Metal', bevel=0.003 * L, segs=1)
        both(spon)
        turret(rear + 0.5 * L, 0, 0.085 * L * wf, 0.03 * L, 0.0)
        # dorsal sensor mast
        add(bm_plate([(0, 0), (0.1 * L, 0), (0.02 * L, 0.08 * L), (-0.02 * L, 0.08 * L)], 0.01 * L), 'Dark',
            loc=(rear + 0.24 * L, 0, 0.1 * L * wf), rot=(math.pi / 2, 0, 0), bevel=0.002 * L, segs=1)
    if k >= 3:
        # outboard engine nacelles on pylons
        def nac(s):
            y = s * (0.25 + 0.02 * k) * L
            prof = [(0.0, 0.05, 0.045, 0.045), (0.6, 0.05, 0.045, 0.045), (1.0, 0.012, 0.012, 0.012)]
            ln = 0.42 * L
            rings = [angular_section(rear + 0.02 * L + t * ln, w * L, tp * L, bt * L, cy=y, cz=0.02 * L) for t, w, tp, bt in prof]
            add(bm_rings(rings), 'Paint', bevel=0.004 * L, segs=1)
            nozzle(rear + 0.0 * L, y, 0.02 * L, 0.036 * L, L)
            add(bm_box(0.14 * L, abs(y) - 0.1 * L, 0.012 * L), 'Dark', loc=(rear + 0.14 * L, s * (abs(y) / 2 + 0.05 * L), 0.01 * L), bevel=0.003 * L, segs=1)
        both(nac)
        turret(rear + 0.36 * L, 0.08 * L * wf, 0.07 * L * wf, 0.022 * L, 0.0)
        turret(rear + 0.36 * L, -0.08 * L * wf, 0.07 * L * wf, 0.022 * L, 0.0)
    if k >= 4:
        # split bow prongs
        def prong(s):
            y = s * 0.11 * L
            prof = [(0.0, 0.05, 0.04, 0.035), (0.55, 0.045, 0.035, 0.03), (1.0, 0.006, 0.006, 0.004)]
            x0, ln = rear + 0.55 * L, 0.55 * L
            add(bm_rings([angular_section(x0 + t * ln, w * L, tp * L, bt * L, cy=y) for t, w, tp, bt in prof]), 'Metal', bevel=0.003 * L, segs=1)
            add(bm_box(0.3 * L, 0.006 * L, 0.01 * L), 'Glow', loc=(x0 + 0.25 * L, y + s * 0.045 * L, 0.0))
        both(prong)
        # command tower
        add(bm_rings([angular_section(rear + 0.12 * L, 0.05 * L, 0.02 * L, 0.0, cz=0.1 * L * wf),
                      angular_section(rear + 0.12 * L, 0.05 * L, 0.02 * L, 0.0, cz=0.16 * L * wf),
                      angular_section(rear + 0.30 * L, 0.03 * L, 0.012 * L, 0.0, cz=0.16 * L * wf),
                      angular_section(rear + 0.36 * L, 0.01 * L, 0.005 * L, 0.0, cz=0.1 * L * wf)]), 'Paint', bevel=0.003 * L, segs=1)
        add(bm_box(0.02 * L, 0.06 * L, 0.008 * L), 'Glow', loc=(rear + 0.3 * L, 0, 0.165 * L * wf))
        # dorsal vent array
        add(bm_box(0.025 * L, 0.05 * L, 0.01 * L), 'Glow', loc=(rear + 0.45 * L, 0, 0.083 * L * wf), array=(4, (0.05 * L, 0, -0.003 * L)))


# --- organic: smooth bio-shells, ribs, tendrils ------------------------------------

def organic_body(L, R, zs=0.72, cy=0.0, cz=0.0, x0=None, n=12, m='PaintShell', droop=0.05, sections=11):
    x0 = -L / 2 if x0 is None else x0
    rings = [Vector((x0 - 0.01 * L, cy, cz))]
    prof = []
    for i in range(sections):
        t = (i + 0.5) / sections
        r = R * math.sin(math.pi * (0.06 + 0.9 * t) ** 0.85) ** 0.75 * (1.0 - 0.35 * t)
        x = x0 + t * L
        z = cz + droop * L * math.sin(math.pi * t)
        rings.append(circle_yz(x, r, n, zs=zs, cy=cy, cz=z))
        prof.append((x, r, z))
    rings.append(Vector((x0 + L * 1.01, cy, cz)))
    add(bm_rings(rings), m, smooth=True, subsurf=1)
    return prof


def ship_organic(k, L, rng):
    R = (0.17 - 0.012 * k) * L
    zs = 0.72
    prof = organic_body(L, R, zs=zs)
    rear = -L / 2

    def r_at(x):
        best = min(prof, key=lambda p: abs(p[0] - x))
        return best[1], best[2]
    # rib bands
    # rib bands: elliptical hoops swept around the shell
    nrib = 2 + k
    for i in range(nrib):
        x = rear + (0.22 + 0.5 * i / (nrib - 1)) * L
        r, z = r_at(x)
        path = [Vector((x, math.cos(a) * r * 1.02, z + math.sin(a) * r * zs * 1.02)) for a in [TAU * j / 28 for j in range(29)]]
        add(bm_tube(path, [0.011 * L] * 29, n=6), 'Bone', smooth=True)
    # rear glowing orifice
    add(bm_sphere(R * 0.42, 16, 10), 'Glow', loc=(rear + 0.02 * L, 0, 0.0), scale=(0.6, 1, zs), smooth=True)
    # flank bioluminescent spots
    nspot = 3 + 2 * k
    for i in range(nspot):
        x = rear + (0.3 + 0.5 * i / max(1, nspot - 1)) * L
        r, z = r_at(x)
        a = math.radians(10)
        both(lambda s: add(bm_sphere(0.014 * L, 8, 6), 'Glow', loc=(x, s * r * math.cos(a) * 0.98, z + r * zs * math.sin(a)), smooth=True))
    # trailing tendrils
    nt = 2 + k
    for i in range(nt):
        ang = TAU * (i + 0.5) / nt + math.pi / 2
        sy, sz = math.cos(ang), math.sin(ang) * zs
        ln = (0.28 + 0.03 * k) * L
        path = []
        for j in range(8):
            t = j / 7
            path.append(Vector((rear + 0.12 * L - t * ln,
                                sy * R * (0.55 + 0.5 * t) + 0.04 * L * math.sin(t * 3 + i),
                                sz * R * (0.55 + 0.5 * t) + 0.03 * L * math.cos(t * 2.5 + i))))
        radii = [0.035 * L * (1 - t / 7) ** 1.2 + 0.001 for t in range(8)]
        radii[-1] = 0
        add(bm_tube(path, radii, n=7), 'Sinew', smooth=True, subsurf=1)
    if k >= 1:
        # lateral membrane fins
        def fin(s):
            add(bm_sphere(1.0, 16, 8), 'PaintShell', loc=(rear + 0.34 * L, s * R * 1.25, -0.01 * L),
                rot=(s * math.radians(-12), 0, s * math.radians(-28)), scale=(0.2 * L, R * 0.75, 0.012 * L), smooth=True)
            add(bm_tube([Vector((rear + 0.46 * L, s * R * 0.7, 0)), Vector((rear + 0.34 * L, s * R * 1.3, -0.01 * L)),
                         Vector((rear + 0.18 * L, s * R * 1.9, -0.03 * L))], [0.012 * L, 0.01 * L, 0.0], n=6), 'Bone', smooth=True)
        both(fin)
    if k >= 2:
        # twin side lobes (secondary pods)
        def lobe(s):
            organic_body(0.5 * L, R * 0.55, zs=0.8, cy=s * R * 1.05, cz=-0.03 * L, x0=rear + 0.05 * L, n=10, sections=7, droop=0.02)
            add(bm_sphere(R * 0.2, 12, 8), 'Glow', loc=(rear + 0.055 * L, s * R * 1.05, -0.03 * L), scale=(0.6, 1, 0.8), smooth=True)
        both(lobe)
    if k >= 3:
        # dorsal crest of curved spines
        ns = 3 + k
        for i in range(ns):
            x = rear + (0.25 + 0.45 * i / (ns - 1)) * L
            r, z = r_at(x)
            h = (0.10 + 0.04 * math.sin(math.pi * i / (ns - 1))) * L
            base = Vector((x, 0, z + r * zs * 0.85))
            add(bm_tube([base, base + Vector((-0.03 * L, 0, h * 0.6)), base + Vector((-0.09 * L, 0, h))],
                        [0.022 * L, 0.012 * L, 0], n=6), 'Bone', smooth=True)
    if k >= 4:
        # manta wings
        def manta(s):
            add(bm_sphere(1.0, 20, 10), 'PaintShell', loc=(rear + 0.55 * L, s * R * 1.7, 0.0),
                rot=(0, 0, s * math.radians(-35)), scale=(0.32 * L, R * 1.4, 0.02 * L), smooth=True)
            for j in range(3):
                add(bm_sphere(0.016 * L, 8, 6), 'Glow', loc=(rear + (0.48 + 0.08 * j) * L, s * R * (1.9 + 0.35 * j), 0.012 * L), smooth=True)
        both(manta)


# --- crystal: faceted prism clusters ------------------------------------------------

def shard(at, direction, length, radius, m, sides=6, roll=0.0, **kw):
    d = Vector(direction).normalized()
    q = Vector((1, 0, 0)).rotation_difference(d)
    M = Matrix.Translation(Vector(at)) @ q.to_matrix().to_4x4() @ Matrix.Rotation(roll, 4, 'X')
    add(bm_shard(length, radius, sides, **kw), m, pre=M, angle=20)


def collar(x, r, w, m='Dark', sides=6, zs=1.0):
    ph = math.pi / 6
    outer = [circle_yz(x - w / 2, r, sides, zs, phase=ph), circle_yz(x + w / 2, r, sides, zs, phase=ph)]
    add(bm_rings(outer), m, bevel=w * 0.12, segs=1)
    band = [circle_yz(x - w * 0.15, r * 1.02, sides, zs, phase=ph), circle_yz(x + w * 0.15, r * 1.02, sides, zs, phase=ph)]
    add(bm_rings(band), 'Glow', angle=20)


def ship_crystal(k, L, rng):
    rear = -L / 2
    rm = (0.11 - 0.008 * k) * L
    # main spine shard
    shard((rear, 0, 0), (1, 0, 0), L, rm, 'PaintGem', base=0.3, shoulder=0.68, taper=0.8)
    # glowing heart at the rear tip
    add(bm_ico(rm * 0.55, 1), 'Glow', loc=(rear + 0.06 * L, 0, 0), scale=(1.5, 1, 1), angle=10)
    # side shards swept back
    def side(s, x, ang, up, ln, rr, m):
        d = Vector((-math.cos(ang), s * math.sin(ang), up))
        shard((rear + x * L, 0, 0), d, ln * L, rr * L, m)
    both(lambda s: side(s, 0.55, math.radians(145), 0.0, 0.45, 0.045, 'Crystal'))
    if k >= 1:
        collar(rear + 0.3 * L, rm * 1.18, 0.05 * L)
        shard((rear + 0.5 * L, 0, 0), (-0.8, 0, 0.6), 0.32 * L, 0.035 * L, 'Crystal')
        shard((rear + 0.5 * L, 0, 0), (-0.8, 0, -0.6), 0.28 * L, 0.03 * L, 'Crystal')
    if k >= 2:
        # rear crown: radial shards pointing back and out
        nc = 5 + (k - 2)
        for i in range(nc):
            a = TAU * i / nc + math.pi / 2
            d = Vector((-1.0, math.cos(a) * 0.55, math.sin(a) * 0.55))
            shard((rear + 0.3 * L, math.cos(a) * rm * 0.5, math.sin(a) * rm * 0.5), d, 0.3 * L, 0.03 * L, 'PaintGem' if i % 2 else 'Crystal')
        collar(rear + 0.72 * L, rm * 0.9, 0.035 * L)
        add(bm_box(0.05 * L, 0.012 * L, 0.012 * L), 'Glow', loc=(rear + 0.72 * L, 0, rm * 0.95))
    if k >= 3:
        # flanking twin hulls joined by struts
        def flank(s):
            y = s * (0.22 + 0.02 * k) * L
            shard((rear + 0.08 * L, y, -0.01 * L), (1, 0, 0), 0.7 * L, 0.055 * L, 'PaintGem', base=0.25, shoulder=0.7)
            add(bm_ico(0.03 * L, 1), 'Glow', loc=(rear + 0.08 * L + 0.17 * L, y, -0.01 * L), scale=(1.5, 1, 1), angle=10)
            for x in (0.25, 0.55):
                add(bm_box(0.03 * L, abs(y), 0.02 * L), 'Dark', loc=(rear + x * L, y / 2, -0.005 * L), bevel=0.004 * L, segs=1)
        both(flank)
        both(lambda s: shard((rear + 0.3 * L, s * 0.26 * L, 0), (-0.6, s * 0.8, 0.1), 0.25 * L, 0.03 * L, 'Crystal'))
    if k >= 4:
        # forward prism ring + dorsal spire
        for i in range(6):
            a = TAU * i / 6
            d = Vector((1.0, math.cos(a) * 0.35, math.sin(a) * 0.35))
            shard((rear + 0.62 * L, math.cos(a) * rm * 0.6, math.sin(a) * rm * 0.6), d, 0.22 * L, 0.022 * L, 'Crystal')
        shard((rear + 0.35 * L, 0, rm * 0.4), (-0.35, 0, 1), 0.3 * L, 0.04 * L, 'PaintGem')
        collar(rear + 0.5 * L, rm * 1.1, 0.04 * L)


# --- saucer: discs, rings and pods --------------------------------------------------

def saucer_disc(R, T, z=0.0, m='Paint', n=36):
    prof = [(0, T * 0.9), (0.35 * R, T * 0.82), (0.78 * R, T * 0.42), (R, 0.0), (0.8 * R, -T * 0.45),
            (0.4 * R, -T * 0.72), (0, -T * 0.8)]
    add(bm_lathe(prof, n), m, loc=(0, 0, z), bevel=R * 0.01, segs=2, angle=25)
    add(bm_torus(R * 0.985, T * 0.14, n, 8), 'Metal', loc=(0, 0, z), smooth=True)
    add(bm_torus(R * 0.62, T * 0.07, n, 6), 'Glow', loc=(0, 0, z - T * 0.55), smooth=True)


def pod(x, y, z, ln, r, m='Paint'):
    path = [Vector((x + ln / 2, y, z)), Vector((x + ln * 0.35, y, z)), Vector((x - ln * 0.3, y, z)), Vector((x - ln / 2, y, z))]
    add(bm_tube(path, [0, r, r, r * 0.85], n=12), m, smooth=True, subsurf=1)
    add(bm_cyl(r * 0.7, r * 0.7, r * 0.2, 12), 'Glow', loc=(x - ln / 2 - r * 0.05, y, z), rot=(0, math.pi / 2, 0), smooth=True)


def ship_saucer(k, L, rng):
    ringed = k >= 2
    R = L / 2 * (0.72 if ringed else 0.92)
    T = R * (0.2 + 0.02 * k)
    saucer_disc(R, T)
    # bridge dome
    add(bm_sphere(R * 0.24, 20, 10), 'Glass', loc=(0.08 * R, 0, T * 0.75), scale=(1, 1, 0.6), smooth=True)
    add(bm_torus(R * 0.24, R * 0.02, 24, 6), 'Dark', loc=(0.08 * R, 0, T * 0.75), smooth=True)
    # forward sensor prow (orientation cue) and rear drive
    add(bm_rings([Vector((R * 1.18, 0, 0)), circle_yz(R * 0.9, T * 0.28, 8, zs=0.6), circle_yz(R * 0.55, T * 0.3, 8, zs=0.6)]),
        'Metal', angle=30)
    add(bm_box(R * 0.3, R * 0.5, T * 0.55), 'Dark', loc=(-R * 0.92, 0, 0), bevel=T * 0.08, segs=2)
    add(bm_box(R * 0.03, R * 0.4, T * 0.3), 'Glow', loc=(-R * 1.07, 0, 0))
    if k >= 1:
        both(lambda s: pod(-R * 0.55, s * R * 0.62, T * 0.15, R * 0.7, T * 0.35))
    if ringed:
        Ro = L / 2 * 0.97
        add(bm_torus(Ro, T * 0.16, 48, 8), 'Paint', smooth=True)
        add(bm_torus(Ro, T * 0.07, 48, 6), 'Glow', loc=(0, 0, T * 0.12), smooth=True)
        ns = 4 if k < 4 else 6
        for i in range(ns):
            a = TAU * (i + 0.5) / ns
            add(bm_box(Ro - R * 0.9, T * 0.18, T * 0.12), 'Dark', loc=(math.cos(a) * (R * 0.9 + Ro) / 2, math.sin(a) * (R * 0.9 + Ro) / 2, 0),
                rot=(0, 0, a), bevel=T * 0.03, segs=1)
    if k >= 3:
        # upper deck
        saucer_disc(R * 0.55, T * 0.7, z=T * 0.85)
        both(lambda s: add(bm_sphere(T * 0.25, 12, 8), 'Glow', loc=(0, s * R * 0.6, T * 0.4), smooth=True))
        # ring-mounted pods
        both(lambda s: pod(0.0, s * L / 2 * 0.97, 0.0, R * 0.55, T * 0.3, 'Metal'))
    if k >= 4:
        # central spire + second (inner) ring
        add(bm_cyl(T * 0.28, T * 0.08, T * 2.6, 12), 'Metal', loc=(0, 0, T * 2.1), bevel=T * 0.02, segs=1)
        add(bm_sphere(T * 0.18, 12, 8), 'Glow', loc=(0, 0, T * 3.45), smooth=True)
        add(bm_torus(R * 0.3, T * 0.08, 32, 6), 'Paint', loc=(0, 0, T * 2.2), smooth=True)
        add(bm_torus(R * 0.82, T * 0.06, 48, 6), 'Glow', loc=(0, 0, -T * 0.45), smooth=True)
        both(lambda s: pod(R * 0.3, s * L / 2 * 0.97, 0.0, R * 0.45, T * 0.25, 'Metal'))


SHIP_BUILDERS = {'angular': ship_angular, 'organic': ship_organic, 'crystal': ship_crystal, 'saucer': ship_saucer}


# ---------------------------------------------------------------------------
# Stations (~0.8 - 1.5 units across, centred)
# ---------------------------------------------------------------------------

def truss(a, b, w, m='Dark'):
    a, b = Vector(a), Vector(b)
    d = b - a
    q = Vector((1, 0, 0)).rotation_difference(d.normalized())
    M = Matrix.Translation((a + b) / 2) @ q.to_matrix().to_4x4()
    add(bm_box(d.length, w, w), m, pre=M, bevel=w * 0.15, segs=1)


def hub(r, h, m='Metal'):
    add(bm_cyl(r, r, h, 16), m, bevel=r * 0.08, segs=2)
    add(bm_cyl(r * 0.7, r * 0.4, h * 0.5, 16), 'Dark', loc=(0, 0, h * 0.72), bevel=r * 0.04, segs=1)
    add(bm_cyl(r * 0.7, r * 0.4, h * 0.5, 16), 'Dark', loc=(0, 0, -h * 0.72), rot=(math.pi, 0, 0), bevel=r * 0.04, segs=1)


def st_shipyard(rng):
    L, W, H = 1.3, 0.55, 0.45
    # gantry frame: four longerons + ribs
    for y in (-W / 2, W / 2):
        for z in (-H / 2, H / 2):
            truss((-L / 2, y, z), (L / 2, y, z), 0.035, 'Metal')
    for i in range(6):
        x = -L / 2 + L * i / 5
        truss((x, -W / 2, H / 2), (x, W / 2, H / 2), 0.03, 'Paint')
        truss((x, -W / 2, -H / 2), (x, W / 2, -H / 2), 0.03, 'Paint')
        truss((x, -W / 2, -H / 2), (x, -W / 2, H / 2), 0.025)
        truss((x, W / 2, -H / 2), (x, W / 2, H / 2), 0.025)
        both(lambda s: add(bm_box(0.02, 0.02, 0.02), 'Glow', loc=(x, s * W / 2, H / 2 + 0.025)))
    # half-built hull inside
    add(bm_rings([angular_section(-0.45, 0.15, 0.1, 0.08), angular_section(0.2, 0.14, 0.09, 0.07), angular_section(0.45, 0.02, 0.02, 0.02)]),
        'Metal', bevel=0.005, segs=1)
    for i in range(5):
        add(bm_torus(0.16, 0.008, 20, 4), 'Dark', loc=(-0.4 + 0.18 * i, 0, 0), rot=(0, math.pi / 2, 0), scale=(1, 1, 0.8))
    # crane arm + control block
    add(bm_box(0.25, 0.18, 0.12), 'Paint', loc=(-L / 2 - 0.08, 0, H / 2 - 0.02), bevel=0.015)
    add(bm_box(0.2, 0.19, 0.02), 'Glow', loc=(-L / 2 - 0.08, 0, H / 2 + 0.01))
    truss((0.1, 0, H / 2 + 0.03), (0.1, 0, H / 2 + 0.2), 0.03)
    truss((-0.2, 0, H / 2 + 0.2), (0.35, 0, H / 2 + 0.2), 0.03, 'Paint')
    truss((0.3, 0, H / 2 + 0.2), (0.3, 0, 0.12), 0.01)


def st_docks(rng):
    R = 0.6
    add(bm_torus(R, 0.07, 40, 10), 'Paint', smooth=True)
    add(bm_torus(R, 0.075, 40, 4), 'Metal', scale=(1, 1, 0.35), angle=50)
    add(bm_torus(R + 0.065, 0.012, 40, 4), 'Glow')
    hub(0.14, 0.22)
    for i in range(4):
        a = TAU * i / 4
        truss((math.cos(a) * 0.13, math.sin(a) * 0.13, 0), (math.cos(a) * (R - 0.05), math.sin(a) * (R - 0.05), 0), 0.035, 'Metal')
    # inward docking clamps holding berths
    for i in range(8):
        a = TAU * (i + 0.5) / 8
        c, s = math.cos(a), math.sin(a)
        add(bm_box(0.14, 0.05, 0.05), 'Dark', loc=(c * (R - 0.1), s * (R - 0.1), 0), rot=(0, 0, a), bevel=0.008, segs=1)
        add(bm_box(0.02, 0.06, 0.02), 'Glow', loc=(c * (R - 0.17), s * (R - 0.17), 0.02), rot=(0, 0, a))
        add(bm_cyl(0.03, 0.03, 0.1, 8), 'Metal', loc=(c * (R + 0.1), s * (R + 0.1), 0), rot=(0, math.pi / 2, a), bevel=0.005, segs=1)


def st_missile(rng):
    add(bm_cyl(0.42, 0.36, 0.1, 6), 'Paint', bevel=0.015)
    add(bm_cyl(0.3, 0.42, 0.08, 6), 'Dark', loc=(0, 0, -0.09), bevel=0.01, segs=1)
    add(bm_cyl(0.14, 0.12, 0.2, 12), 'Metal', loc=(0, 0, 0.13), bevel=0.01)
    add(bm_cyl(0.11, 0.11, 0.02, 12), 'Glow', loc=(0, 0, 0.24))
    for i in range(3):
        a = TAU * i / 3 + math.pi / 6
        c, s = math.cos(a) * 0.26, math.sin(a) * 0.26
        rot = (0, -math.radians(40), a)
        add(bm_box(0.24, 0.18, 0.14), 'Metal', loc=(c, s, 0.14), rot=rot, bevel=0.012)
        for yy in (-0.05, 0.0, 0.05):
            for zz in (-0.03, 0.03):
                M = Matrix.Translation((c, s, 0.14)) @ Euler(rot).to_matrix().to_4x4()
                p = M @ Vector((0.12, yy, zz))
                add(bm_cyl(0.018, 0.0, 0.05, 8), 'Glow', pre=Matrix.Translation(p) @ Euler(rot).to_matrix().to_4x4() @ Matrix.Rotation(math.pi / 2, 4, 'Y'))
    for i in range(6):
        a = TAU * i / 6
        add(bm_box(0.05, 0.05, 0.04), 'Glow', loc=(math.cos(a) * 0.39, math.sin(a) * 0.39, 0.03), rot=(0, 0, a))


def st_lance(rng):
    add(bm_cyl(0.07, 0.05, 1.3, 12), 'Metal', rot=(0, math.pi / 2, 0), bevel=0.006)
    for i in range(6):
        add(bm_torus(0.1, 0.022, 20, 6), 'Paint', loc=(-0.35 + 0.13 * i, 0, 0), rot=(0, math.pi / 2, 0), smooth=True)
    add(bm_cyl(0.045, 0.0, 0.14, 12), 'Glow', loc=(0.72, 0, 0), rot=(0, math.pi / 2, 0))
    add(bm_sphere(0.06, 12, 8), 'Glow', loc=(0.66, 0, 0), smooth=True)
    # reactor block at the rear
    add(bm_box(0.3, 0.3, 0.3), 'Paint', loc=(-0.55, 0, 0), bevel=0.03)
    add(bm_cyl(0.1, 0.1, 0.32, 12), 'Glow', loc=(-0.55, 0, 0), rot=(math.pi / 2, 0, 0))
    # radiator fins
    both(lambda s: add(bm_box(0.35, 0.02, 0.22), 'Dark', loc=(-0.55, s * 0.26, 0), bevel=0.005, segs=1, array=(3, (0, 0.05 * s, 0))))
    both(lambda s: add(bm_box(0.12, 0.08, 0.3), 'Metal', loc=(-0.2, s * 0.14, 0), rot=(s * 0.3, 0, 0), bevel=0.01))


def st_shield(rng):
    hub(0.16, 0.34, 'Paint')
    add(bm_sphere(0.1, 16, 10), 'Glow', loc=(0, 0, 0.3), smooth=True)
    add(bm_sphere(0.1, 16, 10), 'Glow', loc=(0, 0, -0.3), smooth=True)
    add(bm_torus(0.6, 0.035, 48, 8), 'Glow', smooth=True)
    add(bm_torus(0.6, 0.05, 48, 4), 'Metal', scale=(1, 1, 0.5), loc=(0, 0, 0.0), rot=(0, 0, math.pi / 4), angle=60)
    for i in range(6):
        a = TAU * i / 6
        c, s = math.cos(a), math.sin(a)
        truss((c * 0.15, s * 0.15, 0), (c * 0.56, s * 0.56, 0), 0.03, 'Dark')
        add(bm_cyl(0.045, 0.02, 0.18, 8), 'Metal', loc=(c * 0.6, s * 0.6, 0.1), bevel=0.005, segs=1)
        add(bm_sphere(0.022, 8, 6), 'Glow', loc=(c * 0.6, s * 0.6, 0.2), smooth=True)


def st_solar(rng):
    add(bm_cyl(0.04, 0.04, 1.3, 10), 'Metal', rot=(0, math.pi / 2, 0), bevel=0.004)
    hub(0.1, 0.2, 'Paint')
    def wing(s):
        for x in (-0.5, 0.18):
            add(bm_box(0.3, 0.44, 0.012), 'Solar', loc=(x, s * 0.3, 0), bevel=0.003, segs=1, array=(2, (0.33 if x < 0 else 0.0, 0, 0)) if x < 0 else None)
            truss((x, s * 0.05, 0), (x, s * 0.52, 0), 0.015, 'Dark')
        add(bm_box(0.3, 0.44, 0.012), 'Solar', loc=(0.5, s * 0.3, 0), bevel=0.003, segs=1)
        truss((0.5, s * 0.05, 0), (0.5, s * 0.52, 0), 0.015, 'Dark')
        add(bm_box(1.35, 0.012, 0.02), 'Paint', loc=(0, s * 0.525, 0))
    both(wing)
    both(lambda s: add(bm_box(0.04, 0.04, 0.04), 'Glow', loc=(s * 0.66, 0, 0)))


def st_research(rng):
    add(bm_sphere(0.22, 24, 14), 'Paint', smooth=True)
    add(bm_torus(0.22, 0.02, 32, 6), 'Glow', smooth=True)
    add(bm_torus(0.4, 0.035, 36, 8), 'Metal', rot=(math.radians(20), 0, 0), smooth=True)
    for i in range(3):
        a = TAU * i / 3
        c, s = math.cos(a), math.sin(a)
        truss((c * 0.2, s * 0.2, 0), (c * 0.45, s * 0.45, 0), 0.03)
        add(bm_cyl(0.07, 0.07, 0.16, 12), 'Paint', loc=(c * 0.5, s * 0.5, 0), bevel=0.01)
        add(bm_cyl(0.075, 0.075, 0.03, 12), 'Glow', loc=(c * 0.5, s * 0.5, 0))
    # sensor dish
    add(bm_lathe([(0, -0.02), (0.1, 0.0), (0.2, 0.06), (0.21, 0.07), (0.19, 0.065), (0.1, 0.01), (0, -0.005)], 24), 'Metal',
        loc=(0, 0, 0.33), rot=(math.radians(25), 0, 0), smooth=True)
    add(bm_cyl(0.015, 0.015, 0.2, 8), 'Dark', loc=(0, 0, 0.25))
    add(bm_cyl(0.01, 0.002, 0.14, 6), 'Glow', loc=(0, -0.03, 0.44), rot=(math.radians(25), 0, 0))
    add(bm_cyl(0.012, 0.012, 0.35, 6), 'Dark', loc=(0, 0, -0.35))
    add(bm_sphere(0.03, 8, 6), 'Glow', loc=(0, 0, -0.53), smooth=True)


def st_habitat(rng):
    R = 0.62
    add(bm_torus(R, 0.09, 48, 12), 'Paint', smooth=True, scale=(1, 1, 0.8))
    add(bm_torus(R + 0.005, 0.07, 48, 4), 'Glass', scale=(1, 1, 1.2), rot=(0, 0, math.pi / 4), angle=60)
    for i in range(24):
        a = TAU * i / 24
        add(bm_box(0.03, 0.015, 0.02), 'Glow', loc=(math.cos(a) * (R + 0.088), math.sin(a) * (R + 0.088), 0), rot=(0, 0, a + math.pi / 2))
    hub(0.13, 0.3)
    for i in range(3):
        a = TAU * i / 3
        truss((math.cos(a) * 0.12, math.sin(a) * 0.12, 0), (math.cos(a) * (R - 0.07), math.sin(a) * (R - 0.07), 0), 0.04, 'Metal')
    add(bm_cyl(0.02, 0.02, 0.3, 8), 'Dark', loc=(0, 0, 0.3))
    add(bm_sphere(0.03, 8, 6), 'Glow', loc=(0, 0, 0.46), smooth=True)


STATIONS = {
    'shipyard': st_shipyard, 'docks': st_docks, 'missile': st_missile, 'lance': st_lance,
    'shield': st_shield, 'solar': st_solar, 'research': st_research, 'habitat': st_habitat,
}
# extra manifest aliases for orbital building ids -> station kind
STATION_ALIASES = {
    'solararray': 'solar', 'researchstation': 'research', 'habring': 'habitat', 'missilebase': 'missile',
    'heavylance': 'lance', 'orbshield': 'shield', 'megashield': 'shield',
}


# ---------------------------------------------------------------------------
# Buildings (<= 1x1 footprint, base on z=0, height 0.3 - 1.2)
# ---------------------------------------------------------------------------

def pad(r=0.46, h=0.04, sides=8):
    add(bm_cyl(r, r * 0.96, h, sides), 'Concrete', loc=(0, 0, h / 2), bevel=0.008, segs=1)


def block(x, y, sx, sy, h, m='Metal', z0=0.0, roof='Paint', bev=0.015):
    add(bm_box(sx, sy, h), m, loc=(x, y, z0 + h / 2), bevel=bev)
    if roof:
        add(bm_box(sx * 0.86, sy * 0.86, 0.025), roof, loc=(x, y, z0 + h + 0.0125), bevel=0.006, segs=1)


def windows(x, y, sx, sy, z0, h, rows, side='x'):
    """Thin glowing window bands wrapped around a box."""
    for i in range(rows):
        z = z0 + h * (i + 0.6) / (rows + 0.2)
        add(bm_box(sx + 0.004, sy + 0.004, 0.012), 'Glow', loc=(x, y, z))


def dome(x, y, r, m='Glass', z0=0.0, zs=1.0, n=20):
    add(bm_sphere(r, n, 10), m, loc=(x, y, z0), scale=(1, 1, zs), smooth=True)
    add(bm_torus(r, r * 0.06, n, 6), 'Paint', loc=(x, y, z0), smooth=True)


def chimney(x, y, r, h, z0=0.0):
    add(bm_cyl(r, r * 0.8, h, 12), 'Metal', loc=(x, y, z0 + h / 2), bevel=r * 0.1, segs=1)
    add(bm_torus(r * 0.85, r * 0.12, 12, 4), 'Paint', loc=(x, y, z0 + h * 0.8))
    add(bm_cyl(r * 0.6, r * 0.6, 0.01, 12), 'Glow', loc=(x, y, z0 + h + 0.002))


# role models (generic, used when no id-specific model exists)

def b_industry(rng):
    pad()
    block(-0.08, 0.0, 0.55, 0.45, 0.24)
    for i in range(3):
        add(bm_box(0.16, 0.44, 0.08), 'Paint', loc=(-0.28 + 0.18 * i, 0, 0.29), rot=(0, math.radians(-22), 0), bevel=0.006, segs=1)
    chimney(0.28, 0.14, 0.06, 0.55)
    chimney(0.28, -0.12, 0.05, 0.42)
    add(bm_box(0.4, 0.02, 0.02), 'Glow', loc=(-0.08, 0.23, 0.1))


def b_research(rng):
    pad()
    block(0, 0, 0.5, 0.5, 0.18, roof=None)
    dome(0, 0, 0.2, 'Glass', z0=0.18)
    add(bm_cyl(0.015, 0.015, 0.3, 6), 'Metal', loc=(0.25, 0.25, 0.33))
    add(bm_sphere(0.025, 8, 6), 'Glow', loc=(0.25, 0.25, 0.49), smooth=True)
    windows(0, 0, 0.5, 0.5, 0.0, 0.18, 1)


def b_prosperity(rng):
    pad()
    add(bm_lathe([(0, 0.04), (0.3, 0.04), (0.3, 0.1), (0.2, 0.14), (0.14, 0.75), (0.08, 0.85), (0, 0.9)], 8), 'Metal', bevel=0.01, angle=40)
    add(bm_torus(0.2, 0.02, 24, 6), 'Paint', loc=(0, 0, 0.3), smooth=True)
    add(bm_torus(0.17, 0.018, 24, 6), 'Gold', loc=(0, 0, 0.5), smooth=True)
    add(bm_torus(0.15, 0.015, 24, 6), 'Glow', loc=(0, 0, 0.68), smooth=True)


def b_housing(rng):
    pad()
    for (x, y, h) in [(-0.2, -0.18, 0.35), (0.15, -0.2, 0.5), (-0.18, 0.2, 0.55), (0.2, 0.18, 0.3)]:
        block(x, y, 0.28, 0.28, h, m='Concrete')
        windows(x, y, 0.28, 0.28, 0.04, h - 0.04, int(h / 0.12))


def b_mixed(rng):
    pad()
    block(-0.15, 0, 0.45, 0.6, 0.2)
    block(0.2, 0.12, 0.22, 0.22, 0.6, m='Concrete')
    windows(0.2, 0.12, 0.22, 0.22, 0.04, 0.56, 4)
    dome(-0.15, 0.0, 0.14, 'Glass', z0=0.225)


def b_defense(rng):
    add(bm_cyl(0.46, 0.4, 0.14, 8), 'Concrete', loc=(0, 0, 0.07), bevel=0.012, angle=30)
    add(bm_cyl(0.22, 0.2, 0.1, 12), 'Paint', loc=(0, 0, 0.19), bevel=0.012)
    add(bm_box(0.24, 0.18, 0.1), 'Metal', loc=(0, 0, 0.28), bevel=0.015)
    both(lambda s: add(bm_cyl(0.025, 0.02, 0.36, 8), 'Dark', loc=(0.26, s * 0.05, 0.3), rot=(0, math.pi / 2 - 0.35, 0)))
    add(bm_box(0.1, 0.19, 0.015), 'Glow', loc=(0.06, 0, 0.3))


def b_special(rng):
    pad(0.42, 0.05, 6)
    add(bm_shard(0.9, 0.12, 4, base=0.1, shoulder=0.8, taper=0.7), 'Paint', rot=(0, -math.pi / 2, 0), loc=(0, 0, 0.02), angle=20)
    for i in range(4):
        a = TAU * i / 4 + math.pi / 4
        add(bm_box(0.05, 0.05, 0.25), 'Metal', loc=(math.cos(a) * 0.3, math.sin(a) * 0.3, 0.17), bevel=0.01)
        add(bm_sphere(0.03, 8, 6), 'Glow', loc=(math.cos(a) * 0.3, math.sin(a) * 0.3, 0.32), smooth=True)
    add(bm_torus(0.2, 0.015, 24, 6), 'Glow', loc=(0, 0, 0.45), smooth=True)


def b_shipyard(rng):
    pad(0.47, 0.04, 8)
    add(bm_cyl(0.3, 0.3, 0.012, 24), 'Paint', loc=(0, 0, 0.046))
    add(bm_torus(0.3, 0.01, 24, 4), 'Glow', loc=(0, 0, 0.05))
    for y in (-0.35, 0.35):
        truss((-0.35, y, 0.04), (-0.35, y, 0.55), 0.04, 'Metal')
        truss((0.35, y, 0.04), (0.35, y, 0.55), 0.04, 'Metal')
        truss((-0.35, y, 0.55), (0.35, y, 0.55), 0.04, 'Paint')
    truss((0.0, -0.35, 0.58), (0.0, 0.35, 0.58), 0.04, 'Dark')
    add(bm_box(0.08, 0.08, 0.06), 'Metal', loc=(0, 0.05, 0.53))
    add(bm_rings([angular_section(-0.25, 0.1, 0.07, 0.05, cz=0.2), angular_section(0.1, 0.09, 0.06, 0.045, cz=0.2),
                  angular_section(0.28, 0.01, 0.01, 0.01, cz=0.2)]), 'Metal', bevel=0.004, segs=1)


# id-specific models

def b_colonybase(rng):
    pad(0.47, 0.04, 10)
    dome(0.0, 0.0, 0.2, 'Glass', z0=0.04, zs=0.9)
    add(bm_cyl(0.21, 0.21, 0.05, 20), 'Paint', loc=(0, 0, 0.065), bevel=0.008, segs=1)
    for i in range(3):
        a = TAU * i / 3 + 0.4
        c, s = math.cos(a), math.sin(a)
        add(bm_cyl(0.08, 0.08, 0.16, 12), 'Metal', loc=(c * 0.33, s * 0.33, 0.12), bevel=0.01)
        add(bm_cyl(0.085, 0.085, 0.02, 12), 'Paint', loc=(c * 0.33, s * 0.33, 0.2))
        truss((c * 0.18, s * 0.18, 0.08), (c * 0.27, s * 0.27, 0.08), 0.05, 'Metal')
    add(bm_cyl(0.012, 0.012, 0.45, 6), 'Metal', loc=(-0.1, -0.3, 0.26))
    add(bm_sphere(0.022, 8, 6), 'Glow', loc=(-0.1, -0.3, 0.49), smooth=True)
    add(bm_torus(0.21, 0.008, 24, 4), 'Glow', loc=(0, 0, 0.092))


def b_factory(rng):
    add(bm_box(0.92, 0.7, 0.04), 'Concrete', loc=(0, 0, 0.02), bevel=0.008, segs=1)
    add(bm_box(0.62, 0.5, 0.2), 'Metal', loc=(-0.1, 0, 0.14), bevel=0.012)
    # saw-tooth roof
    for i in range(4):
        x = -0.36 + 0.155 * i
        add(bm_plate([(0, 0), (0.15, 0), (0.15, 0.09)], 0.48), 'Paint', loc=(x, 0.24, 0.24), rot=(math.pi / 2, 0, 0), bevel=0.004, segs=1)
        add(bm_box(0.008, 0.46, 0.07), 'Glow', loc=(x + 0.152, 0, 0.28))
    chimney(0.33, 0.18, 0.06, 0.7)
    chimney(0.33, -0.05, 0.05, 0.55)
    add(bm_cyl(0.1, 0.1, 0.22, 16), 'Paint', loc=(0.32, -0.25, 0.15), bevel=0.01)
    add(bm_sphere(0.1, 16, 8), 'Metal', loc=(0.32, -0.25, 0.26), scale=(1, 1, 0.5), smooth=True)
    truss((0.2, -0.25, 0.2), (0.32, -0.25, 0.2), 0.02, 'Dark')


def b_lab(rng):
    add(bm_box(0.84, 0.7, 0.04), 'Concrete', loc=(0, 0, 0.02), bevel=0.008, segs=1)
    block(-0.1, 0.0, 0.5, 0.5, 0.22)
    windows(-0.1, 0.0, 0.5, 0.5, 0.04, 0.18, 2)
    block(0.25, 0.18, 0.22, 0.22, 0.34, m='Concrete')
    add(bm_cyl(0.02, 0.02, 0.18, 8), 'Metal', loc=(-0.2, -0.1, 0.35))
    add(bm_lathe([(0, 0.0), (0.08, 0.01), (0.16, 0.06), (0.17, 0.07), (0.15, 0.065), (0.07, 0.02), (0, 0.012)], 20), 'Metal',
        loc=(-0.2, -0.1, 0.43), rot=(math.radians(35), 0, math.radians(30)), smooth=True)
    add(bm_sphere(0.02, 8, 6), 'Glow', loc=(-0.2, -0.13, 0.49), smooth=True)
    dome(0.25, 0.18, 0.08, 'Glass', z0=0.36)


def b_agridome(rng):
    pad(0.48, 0.04, 12)
    add(bm_cyl(0.4, 0.4, 0.02, 24), 'Plant', loc=(0, 0, 0.05))
    for i in range(7):
        a = TAU * i / 7
        r = 0.22 if i else 0.0
        add(bm_ico(0.06, 1), 'Plant', loc=(math.cos(a) * r, math.sin(a) * r, 0.1), scale=(1, 1, 1.3), smooth=True)
    # lattice dome: glass shell + paint ribs
    add(bm_sphere(0.42, 24, 12), 'Glass', loc=(0, 0, 0.04), scale=(1, 1, 0.75), smooth=True)
    for i in range(6):
        a = TAU * i / 12
        path = [Vector((math.cos(a) * 0.425 * math.cos(t), math.sin(a) * 0.425 * math.cos(t), 0.04 + 0.425 * 0.75 * math.sin(t)))
                for t in [math.pi * j / 16 for j in range(17)]]
        add(bm_tube(path, [0.012] * 17, n=5), 'Paint', smooth=True)
    add(bm_torus(0.425, 0.02, 32, 6), 'Paint', loc=(0, 0, 0.05), smooth=True)
    add(bm_sphere(0.05, 10, 6), 'Glow', loc=(0, 0, 0.36), smooth=True)


def b_habitat(rng):
    pad(0.47, 0.04, 10)
    for (x, y, r, h) in [(0.0, 0.0, 0.16, 0.8), (-0.26, 0.16, 0.11, 0.5), (0.24, 0.2, 0.1, 0.42), (0.1, -0.28, 0.1, 0.56)]:
        add(bm_cyl(r, r * 0.92, h, 16), 'Concrete', loc=(x, y, 0.04 + h / 2), bevel=0.01, segs=1)
        for i in range(int(h / 0.13)):
            add(bm_cyl(r * 1.02, r * 1.02, 0.014, 16), 'Glow', loc=(x, y, 0.1 + i * 0.12))
        dome(x, y, r * 0.95, 'Paint', z0=0.04 + h, zs=0.45, n=16)


def b_megaplex(rng):
    add(bm_box(0.94, 0.94, 0.05), 'Concrete', loc=(0, 0, 0.025), bevel=0.01, segs=1)
    # stepped ziggurat core
    z = 0.05
    for i, (s, h) in enumerate([(0.8, 0.18), (0.6, 0.22), (0.42, 0.24), (0.26, 0.24)]):
        add(bm_box(s, s, h), 'Metal' if i % 2 == 0 else 'Concrete', loc=(0, 0, z + h / 2), bevel=0.012)
        add(bm_box(s + 0.004, s + 0.004, 0.015), 'Glow', loc=(0, 0, z + h * 0.6))
        add(bm_box(s * 0.9, s * 0.9, 0.02), 'Paint', loc=(0, 0, z + h + 0.01), bevel=0.005, segs=1)
        z += h + 0.02
    chimney(0.35, 0.35, 0.04, 0.5)
    chimney(-0.35, 0.35, 0.04, 0.4)
    add(bm_cyl(0.012, 0.004, 0.15, 6), 'Glow', loc=(0, 0, z + 0.075))


def b_campus(rng):
    add(bm_box(0.94, 0.94, 0.03), 'Concrete', loc=(0, 0, 0.015), bevel=0.008, segs=1)
    add(bm_cyl(0.18, 0.18, 0.012, 24), 'Plant', loc=(0, 0, 0.036))
    for (x, y, sx, sy, h) in [(-0.3, 0.0, 0.26, 0.7, 0.2), (0.3, 0.0, 0.26, 0.7, 0.22), (0.0, 0.33, 0.34, 0.2, 0.18)]:
        block(x, y, sx, sy, h, z0=0.03)
        windows(x, y, sx, sy, 0.05, h - 0.03, 1)
    # the "think spire"
    add(bm_lathe([(0, 0.03), (0.1, 0.03), (0.07, 0.2), (0.05, 0.85), (0.0, 1.05)], 6), 'Metal', loc=(0, -0.25, 0), bevel=0.004, angle=30)
    for zz in (0.35, 0.55, 0.75):
        add(bm_torus(0.075 - zz * 0.03, 0.01, 16, 4), 'Glow', loc=(0, -0.25, zz))
    add(bm_torus(0.1, 0.015, 16, 6), 'Paint', loc=(0, -0.25, 0.08), smooth=True)


def b_hydrospire(rng):
    pad(0.46, 0.04, 8)
    add(bm_lathe([(0, 0.04), (0.2, 0.04), (0.12, 0.3), (0.09, 0.95), (0.05, 1.08), (0, 1.12)], 12), 'Metal', bevel=0.004, angle=35)
    for i, zz in enumerate([0.3, 0.52, 0.74, 0.94]):
        r = 0.22 - 0.03 * i
        add(bm_cyl(r, r, 0.07, 16), 'Glass', loc=(0, 0, zz), bevel=0.008, segs=1)
        add(bm_cyl(r * 0.94, r * 0.94, 0.05, 16), 'Plant', loc=(0, 0, zz + 0.005))
        add(bm_torus(r, 0.012, 20, 4), 'Paint', loc=(0, 0, zz + 0.035))
    for i in range(3):
        a = TAU * i / 3
        add(bm_cyl(0.08, 0.08, 0.2, 12), 'Water', loc=(math.cos(a) * 0.33, math.sin(a) * 0.33, 0.14), bevel=0.01, segs=1, smooth=False)
        add(bm_torus(0.08, 0.01, 12, 4), 'Paint', loc=(math.cos(a) * 0.33, math.sin(a) * 0.33, 0.24))
    add(bm_sphere(0.03, 8, 6), 'Glow', loc=(0, 0, 1.12), smooth=True)


def b_garrison(rng):
    # walled compound with corner towers
    add(bm_box(0.9, 0.9, 0.03), 'Concrete', loc=(0, 0, 0.015))
    for s in (1, -1):
        add(bm_box(0.84, 0.05, 0.14), 'Concrete', loc=(0, s * 0.4, 0.1), bevel=0.01, segs=1)
        add(bm_box(0.05, 0.84, 0.14), 'Concrete', loc=(s * 0.4, 0, 0.1), bevel=0.01, segs=1)
    for x in (-0.4, 0.4):
        for y in (-0.4, 0.4):
            add(bm_cyl(0.07, 0.06, 0.26, 8), 'Metal', loc=(x, y, 0.13), bevel=0.01)
            add(bm_cyl(0.08, 0.08, 0.03, 8), 'Paint', loc=(x, y, 0.27))
            add(bm_sphere(0.02, 8, 6), 'Glow', loc=(x, y, 0.3), smooth=True)
    block(-0.08, 0.05, 0.4, 0.3, 0.16)
    add(bm_box(0.3, 0.012, 0.015), 'Glow', loc=(-0.08, -0.105, 0.1))
    add(bm_cyl(0.1, 0.09, 0.08, 10), 'Metal', loc=(0.18, -0.18, 0.07), bevel=0.01)
    both(lambda s: add(bm_cyl(0.018, 0.015, 0.22, 6), 'Dark', loc=(0.24, -0.18 + s * 0.03, 0.14), rot=(0, math.pi / 2 - 0.5, 0)))


def b_observatory(rng):
    pad(0.44, 0.05, 12)
    add(bm_cyl(0.28, 0.28, 0.24, 24), 'Concrete', loc=(0, 0, 0.17), bevel=0.01)
    add(bm_torus(0.285, 0.012, 32, 4), 'Glow', loc=(0, 0, 0.2))
    add(bm_sphere(0.29, 28, 14), 'Paint', loc=(0, 0, 0.29), smooth=True)
    # slit (dark gap) and telescope poking out
    add(bm_cyl(0.06, 0.05, 0.4, 16), 'Metal', loc=(0, -0.15, 0.48), rot=(math.radians(-35), 0, 0), bevel=0.006)
    add(bm_cyl(0.045, 0.045, 0.01, 16), 'Glass', loc=(0, -0.265, 0.645), rot=(math.radians(-35), 0, 0))


def b_excavation(rng):
    # stepped open pit with a drill rig
    add(bm_lathe([(0, 0.02), (0.14, 0.02), (0.18, 0.06), (0.26, 0.06), (0.3, 0.1), (0.38, 0.1), (0.46, 0.12), (0.47, 0.0), (0, 0.0)], 14),
        'Rock', angle=25)
    add(bm_cyl(0.13, 0.13, 0.01, 14), 'Glow', loc=(0, 0, 0.022))
    for i in range(3):
        a = TAU * i / 3 + 0.3
        truss((math.cos(a) * 0.4, math.sin(a) * 0.4, 0.1), (0, 0, 0.62), 0.03, 'Metal')
    add(bm_box(0.12, 0.12, 0.1), 'Paint', loc=(0, 0, 0.64), bevel=0.012)
    add(bm_cyl(0.02, 0.01, 0.55, 8), 'Dark', loc=(0, 0, 0.32))
    add(bm_box(0.16, 0.12, 0.1), 'Paint', loc=(0.3, -0.3, 0.17), bevel=0.012)
    add(bm_box(0.1, 0.004 + 0.12, 0.02), 'Glow', loc=(0.3, -0.3, 0.2))
    for i, (x, y) in enumerate([(-0.33, -0.2), (-0.3, 0.25)]):
        add(bm_ico(0.07, 1), 'Rock', loc=(x, y, 0.15), scale=(1, 1, 0.6))


def b_metroplex(rng):
    add(bm_box(0.94, 0.94, 0.04), 'Concrete', loc=(0, 0, 0.02), bevel=0.01, segs=1)
    for (x, y, s, h) in [(-0.2, -0.2, 0.3, 0.9), (0.22, -0.18, 0.26, 0.65), (-0.18, 0.22, 0.26, 0.55), (0.2, 0.22, 0.28, 1.1)]:
        add(bm_box(s, s, h), 'Metal', loc=(x, y, 0.04 + h / 2), bevel=0.012)
        windows(x, y, s, s, 0.08, h - 0.08, int(h / 0.12))
        add(bm_box(s * 0.7, s * 0.7, 0.04), 'Paint', loc=(x, y, 0.06 + h), bevel=0.006, segs=1)
    truss((-0.2, -0.2, 0.5), (0.2, 0.22, 0.5), 0.05, 'Glass')
    truss((0.22, -0.18, 0.4), (0.2, 0.22, 0.4), 0.05, 'Glass')


def b_fusionhub(rng):
    pad(0.46, 0.05, 8)
    add(bm_sphere(0.24, 24, 12), 'Metal', loc=(0, 0, 0.3), smooth=True)
    add(bm_torus(0.3, 0.05, 32, 8), 'Paint', loc=(0, 0, 0.3), smooth=True)
    add(bm_torus(0.26, 0.02, 32, 6), 'Glow', loc=(0, 0, 0.3), rot=(math.pi / 2, 0, 0), smooth=True)
    add(bm_torus(0.26, 0.02, 32, 6), 'Glow', loc=(0, 0, 0.3), rot=(0, math.pi / 2, 0), smooth=True)
    for i in range(4):
        a = TAU * i / 4 + math.pi / 4
        add(bm_box(0.08, 0.08, 0.26), 'Concrete', loc=(math.cos(a) * 0.36, math.sin(a) * 0.36, 0.18), bevel=0.01)


def b_datasphere(rng):
    pad(0.44, 0.05, 6)
    add(bm_cyl(0.12, 0.2, 0.3, 6), 'Metal', loc=(0, 0, 0.2), bevel=0.01)
    add(bm_ico(0.2, 1), 'Paint', loc=(0, 0, 0.56), angle=10)
    add(bm_torus(0.27, 0.015, 32, 6), 'Glow', loc=(0, 0, 0.56), rot=(math.radians(20), 0, 0), smooth=True)
    add(bm_torus(0.27, 0.015, 32, 6), 'Glow', loc=(0, 0, 0.56), rot=(math.radians(-20), math.radians(60), 0), smooth=True)


def b_biosphere(rng):
    pad(0.47, 0.04, 12)
    add(bm_cyl(0.42, 0.42, 0.02, 24), 'Water', loc=(0, 0, 0.05))
    add(bm_ico(0.18, 1), 'Plant', loc=(0.05, 0.05, 0.08), scale=(1.2, 1, 0.7), smooth=True)
    add(bm_ico(0.42, 2), 'Glass', loc=(0, 0, 0.04), scale=(1, 1, 0.8), angle=5)
    add(bm_torus(0.42, 0.025, 32, 6), 'Paint', loc=(0, 0, 0.05), smooth=True)
    add(bm_cyl(0.015, 0.015, 0.2, 6), 'Metal', loc=(0, 0, 0.42))
    add(bm_sphere(0.03, 8, 6), 'Glow', loc=(0, 0, 0.53), smooth=True)


def b_cloningvats(rng):
    pad(0.46, 0.04, 8)
    for i in range(6):
        a = TAU * i / 6
        x, y = math.cos(a) * 0.28, math.sin(a) * 0.28
        add(bm_cyl(0.08, 0.08, 0.3, 12), 'Glass', loc=(x, y, 0.19), smooth=True)
        add(bm_cyl(0.06, 0.06, 0.24, 10), 'Glow', loc=(x, y, 0.18), smooth=True)
        add(bm_cyl(0.09, 0.09, 0.03, 12), 'Paint', loc=(x, y, 0.35))
    add(bm_cyl(0.12, 0.1, 0.4, 12), 'Metal', loc=(0, 0, 0.24), bevel=0.01)


def b_surfshield(rng):
    pad(0.46, 0.05, 8)
    add(bm_cyl(0.1, 0.06, 0.6, 8), 'Metal', loc=(0, 0, 0.35), bevel=0.008)
    add(bm_sphere(0.09, 12, 8), 'Glow', loc=(0, 0, 0.7), smooth=True)
    for zz, r in ((0.3, 0.28), (0.5, 0.2)):
        add(bm_torus(r, 0.02, 32, 6), 'Paint', loc=(0, 0, zz), smooth=True)
        add(bm_torus(r, 0.008, 32, 4), 'Glow', loc=(0, 0, zz + 0.02))
    for i in range(4):
        a = TAU * i / 4
        truss((math.cos(a) * 0.4, math.sin(a) * 0.4, 0.05), (math.cos(a) * 0.08, math.sin(a) * 0.08, 0.5), 0.025, 'Dark')


BUILDINGS = {
    # roles
    'industry': b_industry, 'research': b_research, 'prosperity': b_prosperity, 'housing': b_housing,
    'mixed': b_mixed, 'defense': b_defense, 'special': b_special, 'shipyard': b_shipyard,
    # ids
    'colonybase': b_colonybase, 'factory': b_factory, 'lab': b_lab, 'agridome': b_agridome, 'habitat': b_habitat,
    'megaplex': b_megaplex, 'campus': b_campus, 'hydrospire': b_hydrospire, 'garrison': b_garrison,
    'observatory': b_observatory, 'excavation': b_excavation,
    'metroplex': b_metroplex, 'fusionhub': b_fusionhub, 'datasphere': b_datasphere, 'biosphere': b_biosphere,
    'cloningvats': b_cloningvats, 'surfshield': b_surfshield,
}


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def build_one(key, fn, relpath, anchor, out, opts, stats, length=None):
    rng = random.Random(zlib.crc32(key.encode()))
    clear_scene()
    fn(rng)
    ob, dims = finalize(key, anchor, length)
    ob.data.calc_loop_triangles()
    tris = len(ob.data.loop_triangles)
    path = os.path.join(out, relpath)
    export(ob, path, opts['blend'], key)
    size = os.path.getsize(path)
    stats.append((key, relpath, tris, size, tuple(round(d, 2) for d in dims)))
    print(f'[models] {key:22s} {tris:6d} tris {size / 1024:7.1f} KB  dims(x,y,z blender)={tuple(round(d, 2) for d in dims)}')


def main():
    opts = parse_args()
    out = os.path.abspath(opts['out'])
    only = opts['only']
    manifest = {'version': 1, 'ships': {}, 'stations': {}, 'buildings': {}}
    jobs = []
    for fam, builder in SHIP_BUILDERS.items():
        for k, hull in enumerate(HULLS):
            key = f'{fam}_{hull}'
            rel = f'ships/{key}.glb'
            manifest['ships'][key] = rel
            L = HULL_LEN[hull]
            jobs.append((key, (lambda b, k, L: (lambda rng: b(k, L, rng)))(builder, k, L), rel, 'center', L))
    for kind, fn in STATIONS.items():
        rel = f'stations/{kind}.glb'
        manifest['stations'][kind] = rel
        jobs.append((kind, fn, rel, 'center', None))
    for alias, kind in STATION_ALIASES.items():
        manifest['stations'][alias] = f'stations/{kind}.glb'
    for bid, fn in BUILDINGS.items():
        rel = f'buildings/{bid}.glb'
        manifest['buildings'][bid] = rel
        jobs.append((bid, fn, rel, 'base', None))

    stats = []
    for key, fn, rel, anchor, length in jobs:
        if only and only not in key:
            continue
        build_one(key, fn, rel, anchor, out, opts, stats, length)
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, 'manifest.json'), 'w') as f:
        json.dump(manifest, f, indent=2, sort_keys=False)
        f.write('\n')
    total = sum(s[3] for s in stats)
    print(f'[models] built {len(stats)} models, {total / 1024:.1f} KB total -> {out}')


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""
Import and upscale art from YOUR OWN copy of Ascendancy (1995) for local play.

    npm run import-classic                      # looks in ./ascendancy
    python3 tools/import_classic.py --game /path/to/ascendancy --scale 4

Reads the original .COB archives, decodes the 256-color .SHP sprites, upscales
them (de-dither -> Lanczos -> sharpen via ffmpeg, or Real-ESRGAN if installed),
and writes PNGs + manifest.json into public/classic/ (git-ignored). The game
uses these automatically when present and falls back to procedural art.

The original art is copyrighted by The Logic Factory: keep it local, don't
redistribute it.
"""
import argparse, json, os, shutil, subprocess, sys, tempfile, time
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from uncob import read_cob
from shp import bank, write_png, to_rgba

def find_upscaler(pref):
    if pref in ('auto', 'realesrgan'):
        for exe in ('realesrgan-ncnn-vulkan', 'realesrgan'):
            if shutil.which(exe):
                return ('realesrgan', exe)
        if pref == 'realesrgan':
            sys.exit('realesrgan-ncnn-vulkan not found on PATH')
    if pref in ('auto', 'ffmpeg'):
        if shutil.which('ffmpeg'):
            return ('ffmpeg', 'ffmpeg')
        if pref == 'ffmpeg':
            sys.exit('ffmpeg not found on PATH')
    return ('none', None)

def upscale(kind, exe, src, dst, scale, blur):
    if kind == 'realesrgan':
        subprocess.run([exe, '-i', src, '-o', dst, '-s', str(min(4, scale)), '-n', 'realesrgan-x4plus'], check=True, capture_output=True)
        return
    if kind == 'ffmpeg':
        # Dithered 8-bit art turns "wormy" under pixel-art scalers (xBR/hqx); a slight
        # blur first removes the dither pattern, then Lanczos + unsharp restore edges.
        # Alpha is scaled separately so transparent edges stay clean.
        f = (f"[0]format=rgba,split[a][b];"
             f"[a]format=rgb24,gblur=sigma={blur},scale=iw*{scale}:ih*{scale}:flags=lanczos,unsharp=7:7:1.1:7:7:0[c];"
             f"[b]alphaextract,scale=iw*{scale}:ih*{scale}:flags=bicubic,format=gray[al];"
             f"[c][al]alphamerge")
        subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-i', src, '-filter_complex', f, dst], check=True)
        return
    shutil.copy(src, dst)

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    ap.add_argument('--game', default=os.path.join(root, 'ascendancy'), help='folder containing ASCEND0*.COB')
    ap.add_argument('--out', default=os.path.join(root, 'public', 'classic'))
    ap.add_argument('--scale', type=int, default=3)
    ap.add_argument('--upscaler', default='auto', choices=['auto', 'ffmpeg', 'realesrgan', 'none'])
    ap.add_argument('--jobs', type=int, default=os.cpu_count() or 4)
    args = ap.parse_args()

    files = {}
    for name in sorted(os.listdir(args.game)):
        if name.lower().endswith('.cob'):
            files.update(read_cob(os.path.join(args.game, name)))
    if not files:
        sys.exit(f'No .COB archives found in {args.game}')
    pal_raw = files['data/game.pal'][:768]
    pal = [tuple(min(255, c * 4) for c in pal_raw[i*3:i*3+3]) for i in range(256)]
    kind, exe = find_upscaler(args.upscaler)
    print(f'{len(files)} files in archives; upscaler: {kind}, scale x{args.scale}')

    # (bank, frame(s), output subdir/name, scale multiplier, blur)
    jobs = []
    def add(bank_name, frames, out, mul=1.0, blur=0.55):
        data = files.get('data/' + bank_name)
        if data is None:
            print('  missing', bank_name); return
        imgs = bank(data)
        for fi, name in frames:
            if fi < len(imgs):
                jobs.append((imgs[fi], out, name, max(1, round(args.scale * mul)), blur))
    for t in range(11):
        add(f'planal{t:02d}.shp', [(4, f't{t:02d}')], 'planets', 0.67)
    add('suns.shp', [(i, f's{i:02d}') for i in range(13)], 'suns')
    for r in range(21):
        add(f'lgrace{r:02d}.shp', [(0, f'r{r:02d}')], 'portraits', 1.0, 0.6)
        add(f'smrace{r:02d}.shp', [(0, f'r{r:02d}')], 'faces', 1.0, 0.5)
        add(f'smship{r:02d}.shp', [(k, f'r{r:02d}_{k}') for k in range(4)], 'ships', 0.67, 0.45)
        add(f'dkship{r:02d}.shp', [(k, f'r{r:02d}_{k}') for k in range(4)], 'designs', 0.67, 0.5)
    add('planitem.shp', [(i, f'b{i:02d}') for i in range(40)], 'buildings', 1.0, 0.4)
    add('gizmos.shp', [(i, f'g{i:02d}') for i in range(76)], 'parts', 1.0, 0.4)
    add('nebulae.shp', [(i, f'n{i:02d}') for i in range(9)], 'nebulae', 1.3, 0.8)

    os.makedirs(args.out, exist_ok=True)
    tmp = tempfile.mkdtemp(prefix='ascendant-')
    manifest = {'version': 1, 'generated': int(time.time()), 'upscaler': kind, 'scale': args.scale}
    def run(job):
        ((w, h, px), p), sub, name, scale, blur = job
        os.makedirs(os.path.join(args.out, sub), exist_ok=True)
        src = os.path.join(tmp, f'{sub}_{name}.png')
        write_png(src, w, h, to_rgba(w, h, px, p or pal))
        dst = os.path.join(args.out, sub, name + '.png')
        upscale(kind, exe, src, dst, scale, blur)
        return sub, name
    t0 = time.time()
    with ThreadPoolExecutor(args.jobs) as ex:
        for i, (sub, name) in enumerate(ex.map(run, jobs)):
            manifest.setdefault(sub, []).append(name)
            if (i + 1) % 50 == 0: print(f'  {i + 1}/{len(jobs)}')
    shutil.rmtree(tmp, ignore_errors=True)
    for k in manifest:
        if isinstance(manifest[k], list): manifest[k].sort()
    with open(os.path.join(args.out, 'manifest.json'), 'w') as f:
        json.dump(manifest, f, indent=1)
    print(f'Wrote {len(jobs)} images to {args.out} in {time.time() - t0:.1f}s')

if __name__ == '__main__':
    main()

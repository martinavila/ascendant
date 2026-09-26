#!/usr/bin/env python3
"""Contact sheet of every frame in a .shp bank (for mapping frames to game content)."""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from shp import bank, load_pal, write_png
pal = load_pal(sys.argv[1]); src = sys.argv[2]; out = sys.argv[3]
cols = int(sys.argv[4]) if len(sys.argv) > 4 else 8
imgs = bank(src)
cw = max(w for (w, h, px), p in imgs) + 4; ch = max(h for (w, h, px), p in imgs) + 4
rows = (len(imgs) + cols - 1) // cols
W, H = cw * cols, ch * rows
buf = bytearray(W * H * 4)
for i in range(W * H): buf[i*4:i*4+4] = b'\x20\x20\x28\xff'
for k, ((w, h, px), p) in enumerate(imgs):
    ox, oy = (k % cols) * cw + 2, (k // cols) * ch + 2
    pp = p or pal
    for y in range(h):
        for x in range(w):
            c = px[y][x]
            if c is None: continue
            i = ((oy + y) * W + ox + x) * 4
            buf[i:i+3] = bytes(pp[c]); buf[i+3] = 255
write_png(out, W, H, buf)
print(out, len(imgs), W, H)

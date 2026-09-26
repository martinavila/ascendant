#!/usr/bin/env python3
"""Decode Ascendancy .SHP sprite banks to RGBA PNGs.

Bank:  b'1.10', u32 count, count * (u32 image_offset, u32 palette_offset)
Image: u16 canvas_h-1, u16 canvas_w-1, u16 origin_y, u16 origin_x,
       i32 x1, y1, x2, y2 (bounding box relative to origin), then RLE rows of the box:
       0x00 end-of-row | 0x01 n: skip n transparent | even b: run (b>>1) of next byte
       odd b: (b>>1) literal bytes
"""
import struct, sys, os, zlib

def load_pal(path):
    raw = open(path, 'rb').read()[:768]
    scale = 4 if max(raw) < 64 else 1
    return [tuple(min(255, c * scale) for c in raw[i*3:i*3+3]) for i in range(256)]

def decode_image(d, off):
    _, _, oy, ox, x1, y1, x2, y2 = struct.unpack_from('<HHHHiiii', d, off)
    w = x2 - x1 + 1; h = y2 - y1 + 1
    p = off + 24
    px = [[None] * w for _ in range(h)]
    y = x = 0
    while y < h and p < len(d):
        b = d[p]; p += 1
        if b == 0:
            y += 1; x = 0
        elif b == 1:
            x += d[p]; p += 1
        elif b & 1:
            n = b >> 1
            for c in d[p:p+n]:
                if x < w: px[y][x] = c
                x += 1
            p += n
        else:
            n = b >> 1; c = d[p]; p += 1
            for _ in range(n):
                if x < w: px[y][x] = c
                x += 1
    return w, h, px

def bank(path_or_bytes):
    d = path_or_bytes if isinstance(path_or_bytes, (bytes, bytearray)) else open(path_or_bytes, 'rb').read()
    if d[:4] != b'1.10': raise ValueError('not a shp bank')
    n = struct.unpack_from('<I', d, 4)[0]
    out = []
    for i in range(n):
        io, po = struct.unpack_from('<II', d, 8 + i*8)
        pal = None
        if po:
            raw = d[po:po+768]
            pal = [tuple(min(255, c*4) for c in raw[j*3:j*3+3]) for j in range(256)]
        out.append((decode_image(d, io), pal))
    return out

def write_png(path, w, h, rgba):
    rows = b''.join(b'\0' + bytes(rgba[y*w*4:(y+1)*w*4]) for y in range(h))
    def chunk(t, data):
        c = struct.pack('>I', len(data)) + t + data
        return c + struct.pack('>I', zlib.crc32(t + data) & 0xffffffff)
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(rows, 9)) + chunk(b'IEND', b'')
    open(path, 'wb').write(png)

def to_rgba(w, h, px, pal):
    buf = bytearray(w * h * 4)
    for y in range(h):
        for x in range(w):
            c = px[y][x]
            if c is None: continue
            i = (y*w + x) * 4
            buf[i:i+3] = bytes(pal[c]); buf[i+3] = 255
    return buf

if __name__ == '__main__':
    pal = load_pal(sys.argv[1]); out = sys.argv[2]
    os.makedirs(out, exist_ok=True)
    for f in sys.argv[3:]:
        name = os.path.splitext(os.path.basename(f))[0]
        try:
            imgs = bank(f)
        except Exception as e:
            print('skip', f, e); continue
        for i, ((w, h, px), p) in enumerate(imgs):
            write_png(os.path.join(out, f'{name}_{i:03d}.png'), w, h, to_rgba(w, h, px, p or pal))
        print(name, len(imgs))

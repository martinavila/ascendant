#!/usr/bin/env python3
"""Extract Ascendancy .COB archives: u32 count, count*50-byte names, count*u32 offsets."""
import struct, sys, os
def extract(path, out):
    data = open(path, 'rb').read()
    n = struct.unpack_from('<I', data, 0)[0]
    names = [data[4+i*50:4+(i+1)*50].split(b'\0')[0].decode('latin1') for i in range(n)]
    offs = list(struct.unpack_from('<%dI' % n, data, 4+n*50)) + [len(data)]
    for i, name in enumerate(names):
        dst = os.path.join(out, name.replace('\\', '/'))
        os.makedirs(os.path.dirname(dst) or out, exist_ok=True)
        open(dst, 'wb').write(data[offs[i]:offs[i+1]])
    return names
if __name__ == '__main__':
    for p in sys.argv[2:]:
        print(p, len(extract(p, sys.argv[1])))

#!/usr/bin/env python3
"""Ikon PWA platform Cek Keaslian — generator PNG murni Python (tanpa dependensi).
Motif: kartu putih (strip magnetik gelap + chip emas + dua baris) di atas gradien indigo."""
import struct, zlib, pathlib

def write_png(path, size, pixels):
    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)
    raw = b"".join(b"\x00" + bytes(pixels[y*size*4:(y+1)*size*4]) for y in range(size))
    out = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    pathlib.Path(path).write_bytes(out)

def render(S):
    px = bytearray(S*S*4)
    def put(x, y, c):
        i = (y*S+x)*4
        px[i], px[i+1], px[i+2], px[i+3] = c[0], c[1], c[2], 255
    C1, C2 = (49, 46, 129), (109, 40, 217)
    for y in range(S):
        for x in range(S):
            t = (x + y) / (2.0*S)
            put(x, y, (int(C1[0]+(C2[0]-C1[0])*t), int(C1[1]+(C2[1]-C1[1])*t), int(C1[2]+(C2[2]-C1[2])*t)))
    cw, ch = int(S*0.80), int(S*0.52)
    x0, y0 = (S-cw)//2, int(S*0.28)
    r = max(2, int(S*0.055))
    def in_rrect(x, y):
        if not (x0 <= x < x0+cw and y0 <= y < y0+ch):
            return False
        corner_x = (x < x0+r) or (x >= x0+cw-r)
        corner_y = (y < y0+r) or (y >= y0+ch-r)
        if corner_x and corner_y:
            cx = x0+r if x < x0+r else x0+cw-1-r
            cy = y0+r if y < y0+r else y0+ch-1-r
            return (x-cx)**2 + (y-cy)**2 <= r*r
        return True
    sy0, sy1 = y0 + int(ch*0.16), y0 + int(ch*0.34)
    kx0, kx1 = x0 + int(cw*0.07), x0 + int(cw*0.23)
    ky0, ky1 = y0 + int(ch*0.52), y0 + int(ch*0.78)
    l1a, l1b = y0 + int(ch*0.56), y0 + int(ch*0.56) + max(2, int(ch*0.07))
    l2a, l2b = y0 + int(ch*0.74), y0 + int(ch*0.74) + max(2, int(ch*0.07))
    lx0, lx1, lx2 = x0 + int(cw*0.42), x0 + int(cw*0.92), x0 + int(cw*0.74)
    for y in range(y0, y0+ch):
        for x in range(x0, x0+cw):
            if not in_rrect(x, y):
                continue
            if sy0 <= y < sy1:
                put(x, y, (30, 27, 75))
            elif kx0 <= x < kx1 and ky0 <= y < ky1:
                put(x, y, (251, 191, 36))
            elif lx0 <= x < lx1 and l1a <= y < l1b:
                put(x, y, (199, 210, 254))
            elif lx0 <= x < lx2 and l2a <= y < l2b:
                put(x, y, (165, 180, 252))
            else:
                put(x, y, (255, 255, 255))
    return px

if __name__ == "__main__":
    out = pathlib.Path(__file__).parent / "pwa"
    out.mkdir(exist_ok=True)
    for s in (192, 512):
        write_png(out / ("icon-%d.png" % s), s, render(s))
        print("OK", out / ("icon-%d.png" % s))

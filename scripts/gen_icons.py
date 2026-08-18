import struct, zlib

def make_png(path, size, bg, fg):
    w = h = size
    fold = size // 4
    margin = size // 6
    px_left = margin
    px_right = size - margin
    px_top = margin
    px_bottom = size - margin

    rows = []
    for y in range(h):
        row = bytearray()
        row.append(0)  # filter type: none
        for x in range(w):
            if px_left <= x < px_right and px_top <= y < px_bottom:
                # folded corner cut (top-right)
                if x >= px_right - fold and y < px_top + fold and (x - (px_right - fold)) > (fold - (y - px_top)):
                    r, g, b = bg
                else:
                    r, g, b = fg
            else:
                r, g, b = bg
            row.extend((r, g, b, 255))
        rows.append(bytes(row))
    raw = b"".join(rows)
    compressed = zlib.compress(raw, 9)

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data +
                struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff))

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    with open(path, "wb") as f:
        f.write(sig)
        f.write(chunk(b"IHDR", ihdr))
        f.write(chunk(b"IDAT", compressed))
        f.write(chunk(b"IEND", b""))

navy = (0x1a, 0x2b, 0x4a)
paper = (0xf4, 0xf1, 0xea)

make_png("/home/user/Paperwork/icons/icon-192.png", 192, navy, paper)
make_png("/home/user/Paperwork/icons/icon-512.png", 512, navy, paper)
make_png("/home/user/Paperwork/icons/icon-maskable-512.png", 512, navy, paper)
print("done")

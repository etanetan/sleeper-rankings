#!/usr/bin/env python3
"""Generates the extension/site icon PNGs with no dependencies beyond the
stdlib (no Pillow) - just zlib + struct to write raw PNG bytes directly.

The mark: an amber (#d97706, the accent color content.css and panel.html
already use) rounded square with three white ascending bars, like a small
bar chart. Simple enough to read correctly at 16px.

Run: python3 tools/make_icons.py
Writes:
  extension/icons/icon-{16,32,48,128}.png  (toolbar icon, manifest.json)
  icons/icon-{180,192,512}.png             (site PWA icons, task 2)
"""
import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

AMBER = (217, 119, 6)     # #d97706
WHITE = (255, 255, 255)


def rounded_square_mask(size, radius):
    """True where (x, y) falls inside a size x size square with corner
    radius `radius`, sampled at pixel centers."""
    mask = [[False] * size for _ in range(size)]
    r = radius
    for y in range(size):
        for x in range(size):
            # Distance test only matters within radius of a corner; every
            # other pixel is inside the square outright.
            cx = min(max(x, r), size - 1 - r)
            cy = min(max(y, r), size - 1 - r)
            dx = x - cx
            dy = y - cy
            mask[y][x] = (dx * dx + dy * dy) <= r * r
    return mask


def bars_mask(size):
    """Three ascending bars, like a small bar chart, centered with margin."""
    margin = max(2, round(size * 0.22))
    gap = max(1, round(size * 0.08))
    inner = size - 2 * margin
    bar_w = (inner - 2 * gap) / 3
    heights = [0.35, 0.62, 0.9]  # fraction of inner height, ascending
    base_y = size - margin
    mask = [[False] * size for _ in range(size)]
    for i, h_frac in enumerate(heights):
        x0 = margin + i * (bar_w + gap)
        x1 = x0 + bar_w
        bar_h = inner * h_frac
        y0 = base_y - bar_h
        for y in range(size):
            if y < y0 - 0.5 or y > base_y:
                continue
            for x in range(size):
                if x0 - 0.5 <= x <= x1:
                    mask[y][x] = True
    return mask


def render(size):
    r = round(size * 0.22)
    bg = rounded_square_mask(size, r)
    bars = bars_mask(size)
    pixels = []
    for y in range(size):
        row = []
        for x in range(size):
            if bg[y][x]:
                color = WHITE if bars[y][x] else AMBER
                row.append((*color, 255))
            else:
                row.append((0, 0, 0, 0))
        pixels.append(row)
    return pixels


def write_png(path, pixels):
    size = len(pixels)
    raw = bytearray()
    for row in pixels:
        raw.append(0)  # filter type 0 (none) for this scanline
        for (r, g, b, a) in row:
            raw += bytes((r, g, b, a))
    compressed = zlib.compress(bytes(raw), 9)

    def chunk(tag, data):
        out = struct.pack(">I", len(data)) + tag + data
        out += struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        return out

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", ihdr)
    png += chunk(b"IDAT", compressed)
    png += chunk(b"IEND", b"")

    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(png)
    print(f"wrote {os.path.relpath(path, ROOT)} ({size}x{size})")


def main():
    for size in (16, 32, 48, 128):
        write_png(os.path.join(ROOT, "extension", "icons", f"icon-{size}.png"),
                   render(size))
    for size in (180, 192, 512):
        write_png(os.path.join(ROOT, "icons", f"icon-{size}.png"),
                   render(size))


if __name__ == "__main__":
    main()

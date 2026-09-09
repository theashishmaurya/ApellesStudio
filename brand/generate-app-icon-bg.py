#!/usr/bin/env python3
"""
generate-app-icon-bg.py — rebuilds apelles-mark-squircle.png (D-267).

Takes the alpha-cleared medallion (apelles-mark-transparent.png), lays it
over a linear vertical gradient background, then clips the whole thing to
the macOS Big Sur+ "continuous corner" squircle shape.

Why a gradient at all, and why linear over radial: the app icon needs an
OPAQUE background (every real macOS/Windows app icon fills its whole tile;
a transparent one floats oddly in the Dock next to them — see brand/README.md)
and a flat fill read as flat, not premium, once actually seen at Dock size.
A radial glow was tried first and rejected twice live — first too subtle to
read as a gradient at all, then too strong once made visible enough to see.
A linear top-to-bottom lift (the classic "light from above" icon convention)
is the version that actually stuck, tuned down once more after the first
pass had too much contrast between the light top and the dark bottom.

The two colour endpoints and the squircle radius below are the tuned,
confirmed values — this script exists so they are reproducible, not
retyped from memory, if the source medallion or its transparent cut ever
changes.
"""
from PIL import Image, ImageDraw

BASALT = (0x1c, 0x1a, 0x17)
MARBLE = (0xf4, 0xef, 0xe6)

# Top: basalt lifted 22% toward marble. Bottom: plain basalt (not pure
# black) -- the second, deliberately narrower pass after the first version
# ran all the way to #000 and read as too much contrast.
TOP = tuple(int(BASALT[i] * 0.78 + MARBLE[i] * 0.22) for i in range(3))
BOTTOM = BASALT

# Apple's macOS Big Sur+ "continuous corner" squircle: ~22.5% of the
# icon's own width, the standard approximation third-party icon generators
# use for this exact shape.
SQUIRCLE_RADIUS_FRACTION = 0.225

SRC = "apelles-mark-transparent.png"
DEST = "apelles-mark-squircle.png"


def linear_vertical_gradient(size, top, bottom):
    w, h = size
    bg = Image.new("RGBA", size)
    px = bg.load()
    for y in range(h):
        t = y / (h - 1)
        col = tuple(int(top[i] * (1 - t) + bottom[i] * t) for i in range(3))
        for x in range(w):
            px[x, y] = col + (255,)
    return bg


def apply_squircle(img, radius_fraction):
    w, h = img.size
    radius = int(w * radius_fraction)
    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, w - 1, h - 1], radius=radius, fill=255)
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    out.paste(img, (0, 0))
    out.putalpha(mask)
    return out


def main():
    mark = Image.open(SRC).convert("RGBA")
    bg = linear_vertical_gradient(mark.size, TOP, BOTTOM)
    bg.alpha_composite(mark)
    result = apply_squircle(bg, SQUIRCLE_RADIUS_FRACTION)
    result.save(DEST)
    print(f"wrote {DEST} ({result.size[0]}x{result.size[1]})")


if __name__ == "__main__":
    main()

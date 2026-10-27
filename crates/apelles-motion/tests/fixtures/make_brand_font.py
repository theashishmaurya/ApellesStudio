#!/usr/bin/env python3
"""Rebuild `brand-font.ttf`, the D-416 brand-kit render fixture's font file.

Source: Kenney's "Kenney Pixel" (`kenpixel.ttf`, CC0 1.0, kenney.nl/assets/kenney-fonts),
as shipped in `three/examples/fonts/ttf/` (the repo's own node_modules). As shipped it
fails Chrome's OpenType Sanitizer (`cmap: Range glyph reference too high (138 > 137)`):
its cmap maps characters to a glyph id past the end of the font, so a browser refuses
the whole file. This drops exactly those mappings and re-saves the font with fontTools,
which writes a consistent cmap. Glyph outlines are untouched.

Usage (from the repo root; needs fontTools, `pip install fonttools`):
    python3 crates/apelles-motion/tests/fixtures/make_brand_font.py
"""

from pathlib import Path

from fontTools.ttLib import TTFont

HERE = Path(__file__).resolve().parent
SOURCE = HERE.parents[2].parent / "node_modules/three/examples/fonts/ttf/kenpixel.ttf"
OUT = HERE / "brand-font.ttf"


def main() -> None:
    font = TTFont(SOURCE)
    glyphs = set(font.getGlyphOrder())
    for table in font["cmap"].tables:
        table.cmap = {code: name for code, name in table.cmap.items() if name in glyphs}
    font.save(OUT)
    print(f"{OUT} ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()

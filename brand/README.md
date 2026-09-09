# brand/

The source-of-truth master art for Apelles' visual identity (D-267).

- **`apelles-mark-transparent.png`** — the 1254×1254 medallion, alpha-cleared
  outside the circular badge (a flood fill from the corners, not a blanket
  colour-key, so nothing enclosed in the design — a hair shadow, an iris —
  is touched). Use this wherever the surface already has its own
  background: the website favicon set (`website/public/favicon*`,
  `apple-touch-icon.png`, `icon-192.png`) and the site's own nav-bar mark
  (`Nav.astro`).
- **`apelles-mark-squircle.png`** — the desktop app icon's real source,
  generated from the file above by `generate-app-icon-bg.py`: a linear
  top-to-bottom gradient background (not flat, not radial — both were tried
  and rejected live, see the script's own header comment for why), clipped
  to macOS Big Sur's "continuous corner" squircle shape. Regenerate it with:

  ```
  cd brand && python3 generate-app-icon-bg.py
  ```

  Every real macOS/Windows app icon fills its whole tile with an opaque
  background and matches the OS's own rounded shape — `apelles-mark-
  transparent.png` floats as a bare circle in the Dock next to Chrome's
  properly-shaped white tile, which is why this second file exists at all.
- **`apelles-mark-opaque.png`** — the original AI-generated render, kept for
  provenance. Not used by the current generation script (the squircle file
  is built from the transparent cut plus a designed gradient, not from this
  one directly), but the source of truth for what `apelles-mark-
  transparent.png`'s flood fill was cleaning up.

Keep all three whenever regenerating any output set — resizing FROM one of
these never loses quality; resizing from an already-downscaled export does.

Regenerate the desktop app icons with:

```
npx tauri icon brand/apelles-mark-squircle.png
```

(run from `app/`, matching this repo's own Tauri CLI convention).

The website favicon set has no equivalent one-command regenerator — it is a
short, fixed list of sizes (32/48/180/192, plus a bundled `.ico`); see
D-267 in `docs/08-decisions.md` for the exact sizes and why they were
chosen, and `website/tests/palette.test.ts`'s favicon describe block, which
fails loudly if a declared size drifts from what is actually on disk.

This directory holds source art only — nothing here is read by the running
app or the built website directly; both consume the generated outputs.

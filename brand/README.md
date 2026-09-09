# brand/

The source-of-truth master art for Apelles' visual identity (D-267).

`apelles-mark-master.png` — the transparent 1254×1254 raster the desktop app
icon set (`app/src-tauri/icons/`, generated via `npx tauri icon`) and the
website favicon set (`website/public/favicon*`, `apple-touch-icon.png`,
`icon-192.png`) are both derived from. Keep this file whenever regenerating
either set — resizing FROM here never loses quality; resizing from an
already-downscaled export does.

Regenerate the desktop app icons with:

```
npx tauri icon brand/apelles-mark-master.png
```

(run from `app/`, matching this repo's own Tauri CLI convention).

The website favicon set has no equivalent one-command regenerator — it is a
short, fixed list of sizes (32/48/180/192, plus a bundled `.ico`); see
D-267 in `docs/08-decisions.md` for the exact sizes and why they were
chosen, and `website/tests/palette.test.ts`'s favicon describe block, which
fails loudly if a declared size drifts from what is actually on disk.

This directory holds source art only — nothing here is read by the running
app or the built website directly; both consume the generated outputs.

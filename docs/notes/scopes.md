# notes/scopes.md — numeric colour analysis for the agent loop

Roadmap "Now" item 1. Built 2026-09-01. See also
`docs/notes/agent-visual-feedback.md` (the *why*) and `docs/08-decisions.md` D-021
(why this is JS, not WGSL).

## What shipped

**`app/src/utils/scopes.ts`** — a pure, dependency-free module. Downsamples to
≤512 px long edge (nearest-neighbour stride) before any per-pixel work.

- **`computeScopes(imageData) → Scopes`** — the numeric summary:
  | field | meaning |
  |---|---|
  | `blackPoint` / `whitePoint` | 1st / 99th-percentile luma (Rec709), 0–255 |
  | `clipLowPct` / `clipHighPct` | % of pixels with luma ≤1 / ≥254 |
  | `clip.{r,g,b}.{lo,hi}` | % of that channel pinned at 0 / 255 |
  | `meanRGB` | per-channel mean, 0–255 |
  | `zones.{shadows,mids,highs}.{meanRGB,luma}` | means split by luma <64 / 64–191 / >191 |
  | `cast.warmCool` | `mids.r − mids.b` (measured in the mids) |
  | `cast.greenMagenta` | `mids.g − (mids.r + mids.b)/2` |
  | `saturation` | mean HSV saturation, 0–1 |
  | `hueHistogram` | 12 bins × 30° from 0° (red), saturation-weighted, normalised to sum 1 — orange cluster ≈ skin, cyan/blue ≈ sky |
  | `frameSize` / `sampled` | source px dims / pixels actually read |

- **`computeGap(subj, ref) → GapHint`** — subject → reference delta as **hints that
  map onto knobs** (documented as hints, not commands):
  - `exposure` = `(ref.mids.luma − subj.mids.luma) / 64 * 0.5` (EV-ish)
  - `temperature` = sign+magnitude of `ref.cast.warmCool − subj.cast.warmCool` → `warmer` / `cooler` / `ok`
  - `tint` = same for `greenMagenta` → `greener` / `magenta` / `ok`
  - `contrast` = `(whitePoint − blackPoint)` spread, ref vs subj → `more` / `less` / `ok`
  - `saturation` = `ref.saturation / subj.saturation`
  - `reading` = one-line English summary
  magnitude buckets: `<2` slight, `<6` moderate, else strong.

- **`renderParade(imageData) → Promise<dataURL>`** — 320×256 PNG, R/G/B waveforms
  side by side, additive plot, 5-line IRE graticule. `OffscreenCanvas` when
  available, falls back to a DOM canvas.
- **`renderVectorscope(imageData) → Promise<dataURL>`** — 256×256 PNG, YUV chroma
  plot, graticule circles + crosshair, the ~123° skin-tone (I) line marked.
- **`samplePoint(imageData, x, y)`** / **`sampleRegion(imageData, x, y, w, h)`** —
  RGB (+ hex + luma) at a pixel / mean·min·max over a rect. Coords are in the
  rendered-frame pixel space (see `frameSize`).

Histogram is **not** recomputed here — it's passed through from
`useEditorStore.histogram` (RapidRAW's Rust analytics readback).

## Wiring — `app/src/hooks/useChromaControl.ts`

- New bridge ops: **`inspect_color({frame?, reference?})`**, **`sample({x,y})`**,
  **`sample_region({x,y,w,h})`**. Read-only (no settle / re-render).
  `inspect_color` captures the current frame via the same
  `generate_uncropped_preview` path `withFrame` uses, decodes it to `ImageData`
  in a DOM canvas, runs `computeScopes` + both scope images. A `reference`
  (absolute path) is loaded through the existing `generate_preview_for_path`
  Tauri command with neutral adjustments → `computeScopes` → `computeGap`.
- **Every mutating op response now also carries `scopes`** — `settleAndCapture`
  decodes the frame it already captured and folds in the compact `computeScopes`
  output (not the images). So after any grade change the agent gets the new
  numbers for free.

## MCP — `mcp/server.py`

New tools: `inspect_color(frame?, reference?)` (→ parade + vectorscope as image
blocks + readable scope JSON + the gap/reading when a reference is given),
`sample(x,y)`, `sample_region(x,y,w,h)`. Scope-first discipline is in the server
`instructions`, in `inspect_color`'s docstring, and appended to every mutating
tool (`set_primary`, `set_curve`, `set_color_grade`, `set_mask_adjust`) and to
`mcp/README.md`: *grade by the numbers, cite a scope value or a named region,
defer the creative call.*

## Not done / follow-ups

- No real-time GPU (WGSL) scopes for the **UI** — RapidRAW's Rust waveform path
  still owns that; this is a separate CPU path for the agent. A WGSL UI-scopes
  build can land later, independently (D-021).
- `inspect_color`'s `frame` arg is accepted but a seek must currently be a
  separate `seek` call — the op measures whatever frame is live.
- Sample coords are in preview-resolution space (e.g. 1920×1080), not source 4K.
  `frameSize` is returned so the agent can scale; a source-space mode is a later
  nicety.
- Scope images are recomputed per `inspect_color` call (~tens of ms on the
  512-px downsample). Fine for the measure→adjust→re-measure loop.

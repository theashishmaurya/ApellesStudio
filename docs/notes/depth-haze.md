# Depth-haze preset (`apply_haze`)

Roadmap item 4 / **D-024**. One action → depth-weighted atmospheric haze on the
background, pushing the subject forward. Completes the Phase 2 checkpoint and the
original "depth map and do haze" ask.

## What it builds

A mask container named **"Depth Haze"** with a single `ai-depth` sub-mask:

- sub-mask: `ai-depth`, **full range** (`minDepth 0`, `maxDepth 100`, `minFade 0`,
  `maxFade 0`, `feather 12`), **`invert: true`**.
  - `generate_ai_depth_bitmap` (engine) weights the mask by
    `depth_intensity = depth_pct/100` — Depth Anything V2's ONNX output is
    disparity-like, **bright = near**. So a full-range mask, inverted, gives a
    matte whose value tracks **distance**: the nearest surfaces (the subject) → ~0,
    the farthest (the back wall) → ~max. This sidesteps the depth-band picker's
    inverted stored-space (`MasksPanel.handleDepthRangeChange` maps
    `stored.minDepth = 100 - ui.maxDepth`) — full range has no band edges to get
    wrong, and it is also the physically right falloff for haze (haze accumulates
    with distance).
- container `adjustments`, scaled by `amount` (clamped 0–3, default 1.0):
  | knob | value @ amount 1 | why |
  |---|---|---|
  | `dehaze` | `-30` | **negative dehaze ADDS haze in-shader** (doc 09) — the milk |
  | `saturation` | `-25` | atmosphere desaturates with distance |
  | `blacks` | `+10` | lifts the background black point (no true black through haze) |
  | `shadows` | `+8` | fills the background shadows |
- no per-mask blur: `MaskAdjustments` has **no blur field** (`lensBlurAmount` is
  global only). Deferred — a depth-aware background blur would need either a global
  `lensBlurEnabled` pass driven off the same depth map or a new per-mask knob.

`amount` 0.4 = subtle, 1.0 = default, 1.6 = heavy. Measured on the 1080×1920 test
clip (baseline blackPoint 17, saturation 0.33):

| amount | blackPoint | saturation | shadows.luma |
|---|---|---|---|
| baseline | 17 | 0.33 | 46.6 |
| 0.4 | 25 | 0.29 | 48.3 |
| 1.0 | 33 | 0.24 | 50.4 |
| 1.6 | 39 | 0.20 | 52.2 |

## Depth is a STATIC map (v1)

`generate_ai_depth_mask` bakes the depth PNG into the sub-mask's
`maskDataBase64` at apply time. Every subsequent render/seek reuses that same PNG —
**the depth map does not follow the frame.** Fine for a static-camera talking head
(v1's one footage type). A moving camera wants a re-apply per section, or a future
keyframed / temporally-smoothed depth track (Phase 2 "Depth Anything V2 for video"
— the temporal-smoothing half is still open).

### Seek cache-bust (so a re-apply on a new frame is correct)

`ai_commands::generate_ai_depth_mask` caches the computed depth keyed by
`path_hash = hash(path + geometry)`. On a video the path + geometry are constant
across frames, so without a bust a re-apply on frame 400 would silently grade off
frame 0's depth. `chroma_seek` now clears `state.ai_state.depth_map` alongside the
other per-frame caches. (Minimal: one `if let` block, logged in doc 09.)

## `protect_subject` (default true)

A no-op flag in v1. Rationale: with a tracked `ai-subject` mask already on the
clip, that mask's own grade composites on top and keeps the subject punchy, so
nothing extra is needed here.

**Caveat:** a subject that physically stands in the far-depth band still picks up
some haze from this mask (measured: subject face luma +0.6 with haze on, but the
subject's lower torso — mid-distance — moved ~+2.6 luma / +11 blue vs the
background's +7–10 luma). The clean fix is a single container with an
**additive `ai-depth` + subtractive `ai-subject`** composite so the subject is
carved straight out of the haze matte. Deferred — `add_component` already exposes
the mechanism (D-023) if wanted manually.

## Verification (live bridge, C019-style talking-head clip)

`inspect_color` before → after `apply_haze({})`:

- blackPoint **17 → 33**, whitePoint 233 → 234
- saturation **0.33 → 0.24**
- warm–cool cast 20.8 → 15.0 (milkier)
- shadows meanRGB `[52, 45, 41] → [52, 50, 48]` (neutralised)
- clipLowPct 0.01 → 0 (blacks lifted off the floor)

`sample_region` background vs subject, haze off → on:

| point | off | on |
|---|---|---|
| bg (90,260) | `[73, 40, 37]` luma 47 | `[76, 53, 51]` luma 58 |
| bg (970,320) | `[110, 82, 77]` luma 87 | `[110, 91, 87]` luma 95 |
| subject face (540,620) | `[230, 219, 199]` luma 220 | `[229, 219, 207]` luma 220 |
| subject torso (540,1150) | `[233, 153, 125]` luma 168 | `[226, 157, 137]` luma 171 |

Background lifts ~10 luma and desaturates; the subject face is untouched. Confirms
the matte is distance-weighted.

## Surface

- Frontend: `useAiMasking.handleAddDepthHaze({ amount?, protectSubject? })`.
- UI: a single **"Add depth haze"** button in `MasksPanel`'s empty-state AI area.
- MCP op: `apply_haze({ amount?, protect_subject? })` → `{ maskId, subMaskId, amount }`
  + the rendered frame + scopes.
- MCP tool: `apply_haze(amount=1.0, protect_subject=True)` in `mcp/server.py`.

Also landed alongside (needed to test it — the required Rust rebuild restarts the
app and drops the open clip): `useChromaControl` **mounted at app level** (was in
`Editor`, only alive in the editor view) + a new **`open(path)`** op/tool so a file
can be loaded headlessly. (Phase 4 "mount `useChromaControl` at app level" line —
done early.)

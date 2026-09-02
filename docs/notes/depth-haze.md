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
  | `blur` | `min(40, 12·amount)` | depth-weighted background **defocus** (D-027) |
- background blur: **shipped** (D-027). The container's per-mask `blur` blends the
  masked (= far) region toward the shader's shared ~40 px pre-blur, weighted by
  `mask_weight · blur/100` — so the haze now milks *and* softly defocuses the
  background while the subject stays sharp. Fixed radius, ungraded blur sample; a
  variable-radius post-grade defocus would still need its own pass (see
  `docs/notes/mask-blur.md`).

`amount` 0.4 = subtle, 1.0 = default, 1.6 = heavy. Measured on the 1080×1920 test
clip (baseline blackPoint 17, saturation 0.33):

| amount | blackPoint | saturation | shadows.luma |
|---|---|---|---|
| baseline | 17 | 0.33 | 46.6 |
| 0.4 | 25 | 0.29 | 48.3 |
| 1.0 | 33 | 0.24 | 50.4 |
| 1.6 | 39 | 0.20 | 52.2 |

## Depth: a static bake OR a per-frame temporal track (D-036)

`generate_ai_depth_mask` (Rust ONNX Depth Anything V2) bakes **one** depth PNG
into the sub-mask's `maskDataBase64` at apply time — every render/seek reuses it.
**This is still the default**, and it's right for a locked-off talking head (and
for stills). It's also the fallback: `apply_haze` always does it, so there's a
baked map even if a track is later cleared.

For a **moving camera**, run a **depth track** (D-036): `apply_haze({tracked:
true})`, the "Track depth over clip" button, or the MCP `depth_track` tool. That
precomputes a *temporally-consistent* depth map per frame (Video Depth Anything —
Small, in the `ai/` sidecar) to `<clip>/.chroma/depth/<key>/`, stores that dir on
the sub-mask as `chromaDepthDir`, and the render-time hook in
`generate_ai_depth_bitmap` reads the **current source frame's** PNG instead of
the static bake — in lockstep with the frame, for scrub / playback / export
alike (mirrors the D-019 tracked-matte read). No `chromaDepthDir` → the static
bake, byte-identical to pre-D-036. Full detail: **`docs/notes/depth-track.md`**.

### Seek cache-bust (so a re-apply on a new frame is correct — static path)

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

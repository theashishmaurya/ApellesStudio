# notes/mask-keyframes.md — keyframing a shape mask's geometry

Round-3 item "mask keyframes". Built 2026-09-02. See `docs/08-decisions.md`
**D-034** (the render-time-hook call + the interpolation rules), **D-019**
(the tracked-matte precedent this mirrors), **D-025** (`grade.json`).

## What shipped

A shape sub-mask (`radial` / `linear` / `brush` / `flow`) can carry an ordered
list of geometry keyframes; the engine interpolates the geometry per source
frame at render time, so the mask glides between the keys on scrub, playback and
export. Geometry **only** — the grade adjustments, `mode`, `invert`, `opacity`
are not keyframed.

| piece | file |
|---|---|
| interpolation (pure, 14 unit tests) | `engine/src-tauri/src/chroma/keyframes.rs` |
| the one render hook | `engine/src-tauri/src/mask_generation.rs` — `generate_sub_mask_bitmap`, top |
| frontend mirror (overlay + button share it) | `engine/src/utils/maskKeyframes.ts` |
| keyframe button + diamond track | `engine/src/components/chroma/MaskKeyframeBar.tsx` (in `ChromaTimeline`) |
| interpolated overlay + drag-writes-key | `engine/src/components/panel/editor/ImageCanvas.tsx` |
| bridge ops | `engine/src/hooks/useChromaControl.ts` — `add_mask_keyframe` / `list_mask_keyframes` / `clear_mask_keyframe` / `clear_mask_keyframes` |
| MCP tools | `mcp/server.py` — same 4 names (27 → 31 tools) |

## Data model

On the sub-mask's `parameters`:

```jsonc
"chromaKeyframes": [
  { "frame": 0,  "params": { "centerX": 400, "centerY": 300, "radiusX": 120, "radiusY": 120, "rotation": 0, "feather": 50 } },
  { "frame": 90, "params": { "centerX": 950, "centerY": 320, "radiusX": 120, "radiusY": 120, "rotation": 0, "feather": 50 } }
]
```

- `frame` = absolute source-frame index (same axis as D-019 tracked mattes and
  the transport).
- `params` = the keyframed geometry subset for the type:

  | type | keyframed keys |
  |---|---|
  | `radial` | `centerX` `centerY` `radiusX` `radiusY` `rotation` `feather` |
  | `linear` | `startX` `startY` `endX` `endY` `range` |
  | `brush` / `flow` | `lines` (array of `{ tool, brushSize, points: [{x,y}], feather }`) |

- **Absent by default.** No `chromaKeyframes` key ⇒ the sub-mask is static,
  exactly as before. The Rust hook returns `None` (a zero-cost pass-through)
  before it clones anything, so an un-keyframed sub-mask and a still are
  byte-identical to pre-D-034.
- Round-trips through `grade.json` verbatim — it is just more `parameters`. No
  externalisation (the numbers are tiny; keep them inline). `grade.json`'s matte
  externalisation walks the same `parameters` and is unaffected.

## Interpolation rules (Rust and TS, identical)

- scalars: linear between the two bracketing keys.
- **`rotation`: shortest signed arc** — `350° → 10°` interpolates through `0°`,
  not `180°` (and the reverse). All other angles are plain linear.
- `frame ≤ first.frame` ⇒ hold the first key; `frame ≥ last.frame` ⇒ hold the
  last. A single keyframe ⇒ that geometry at every frame.
- exact-on-key ⇒ that key's params unchanged.
- a field present in only one of the two bracketing keys ⇒ held from that key
  (covers a key added later that introduces a field).
- **brush `points` / `lines`:** interpolated element-wise **only when the two
  bracketing keys have identical structure** — same number of lines, same number
  of points per line. Otherwise that field **snaps to the nearer keyframe**
  (`t < 0.5` → the low key, else the high key). Any non-numeric or
  shape-mismatched field snaps the same way.
  - **Limitation:** a brush stroke that gains or loses points between two
    adjacent keys will *jump* at the midpoint rather than morph. Keyframe brush
    masks with the stroke already drawn, then only move it.
- interpolated numbers are rounded to 6 dp (deterministic, no float dust in
  `grade.json`).

## Tracked vs keyframed — mutually exclusive

A sub-mask is either AI-tracked (`chromaTrackDir`, D-019) or keyframed, never
both. If both are somehow present, **tracked wins**: `interpolated_parameters`
returns `None`. The frontend hides the keyframe bar for a tracked sub-mask and
the MCP `add_mask_keyframe` op errors on one.

## Why it works on scrub / playback / export for free

All three set `chroma::state::current_video().frame` before the grade renders:

- **scrub** — `chroma_seek` → `commands::seek_and_install` → `load::install_frame`
  → `set_current_video(Some(CurrentVideo { …, frame }))`.
- **playback** — `chroma_play_frame` → `seek_and_install(frame, Some(dim), …)` →
  same path (D-031).
- **export** — the frame loop calls `chroma::state::set_current_frame(n)` before
  grading each frame (D-022 / D-019).

`generate_sub_mask_bitmap`'s new hook reads that same `frame`, so the mask
geometry, the tracked matte and the decoded pixels are always the one frame.

## UI

- **`MaskKeyframeBar`** sits just above the timeline thumbnail strip, visible
  only when a shape sub-mask is the active mask on a video:
  - **◆ Keyframe mask / Add key / Update key** — snapshots the sub-mask's current
    geometry into `chromaKeyframes` at `useChromaStore.currentFrame`. Pressing it
    again at a frame that already has a key replaces that key.
  - a **diamond track** — one diamond per keyed frame, positioned by
    `frame / (frameCount-1)`; click to seek to it. A thin white line marks the
    playhead.
  - **× at the current frame** (only when a key is there) — delete that key.
  - **Clear** — remove all keyframes; the sub-mask goes back to static (its base
    `parameters` are kept — the current interpolated pose is **not** baked).
- **Canvas** — when a sub-mask has keyframes, `ImageCanvas` draws the overlay at
  the **interpolated** geometry for the current frame (`effectiveParameters`),
  and a drag of the mask commits as a **keyframe upsert at the current frame**
  (a keyframe-aware `updateSubMask` wrapper) — not as a new static geometry.
  So: seek, drag the mask where it should be, and the key is written; no need to
  press the button after a drag.

## MCP workflow

```
seek(0)
add_mask(type="radial", geometry={cx:400, cy:300, rx:120, ry:120})   # or add_subject_mask etc.
add_mask_keyframe(mask_id, sub_mask_id)          # key at frame 0
seek(90)
# reposition: add_component / the app, or re-issue add_mask geometry, then:
add_mask_keyframe(mask_id, sub_mask_id)          # key at frame 90
seek(45) -> the mask is half-way between
```

`list_mask_keyframes(mask_id, sub_mask_id)` → `[{frame, params}]`.
`clear_mask_keyframe(mask_id, sub_mask_id, frame)` / `clear_mask_keyframes(…)`.

## Verification (2026-09-02)

- `cd engine/src-tauri && cargo check --no-default-features` — clean.
- `cargo test --no-default-features chroma::` — **37 passed** (23 baseline + 14
  new in `chroma::keyframes::tests`):
  `empty_or_missing_is_none`, `single_key_holds_everywhere`,
  `clamps_before_first_and_after_last`, `exact_on_key_equals_that_key`,
  `linear_between_keys_each_field`, `linear_shape_fields`,
  `rotation_takes_the_shortest_arc`, `rotation_negative_arc`,
  `brush_points_interpolate_when_structure_matches`,
  `brush_points_snap_when_counts_differ`, `field_present_in_only_one_key_is_held`,
  `keyframes_are_sorted_by_frame`, `unkeyframed_params_pass_through_untouched`
  (the hook's no-op guarantee = the byte-identical regression guard),
  `tracked_submask_wins_over_keyframes`.
- `cd engine && npx tsc --noEmit` — 74 pre-existing unrelated errors (baseline
  unchanged), none in `maskKeyframes.ts` / `MaskKeyframeBar.tsx` /
  `useChromaControl.ts` / `ImageCanvas.tsx` / `ChromaTimeline.tsx`.
- `python3 -m py_compile mcp/server.py` clean; `mcp/.venv/bin/python -c
  "import server"` OK — **31** tools.

## Manual smoke test (open — the bridge listener + running app were not driven)

Via the MCP server against an open clip:

1. `open` a video clip. `add_mask(type="radial")` — a radial appears.
2. `seek(0)`, position the radial over the subject's face (drag on canvas or
   `add_mask` with geometry), `add_mask_keyframe(mask_id, sub_mask_id)`.
3. `seek(N)` (say the last frame), move the radial to where the face is now,
   `add_mask_keyframe(mask_id, sub_mask_id)`.
4. Scrub between 0 and N — the radial overlay glides, and the graded region
   follows the face. `list_mask_keyframes` shows the two keys.
5. `export(kind="h264", from=0, to=N)` a short range — open the file: the mask
   moves in the render.
6. A second radial with **no** keyframes, and a still image, render exactly as
   before (regression).
7. In the GUI: select the shape sub-mask → the `MaskKeyframeBar` appears above
   the timeline; ◆ adds a key, the diamond track seeks, × / Clear remove keys;
   dragging the mask at a frame writes a key there.

## Deferred

- grade-adjustment keyframing (exposure/colour over time) — a separate roadmap
  item, explicitly out of scope here.
- easing / bezier interpolation handles — linear only for v1.
- keyframing `mode` / `invert` / `opacity`.
- a full dope-sheet timeline — the diamond track is deliberately minimal
  (matches `ChromaTimeline` / `ShotStrip` styling).
- brush strokes that change point count between keys snap instead of morphing.

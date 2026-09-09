# notes/export.md — graded-clip export + `.cube` bake

Roadmap "Now" item 2. Built 2026-09-01. See `docs/08-decisions.md` D-022 (the
pipe architecture), D-014 (`render_core` seam it rides on), D-019 (tracked matte
at render time), D-015 (ffmpeg CLI).

## What shipped

`app/src-tauri/src/chroma/export.rs` — new, self-contained.

| item | signature |
|---|---|
| `export_video` | `(&Path video, &Path out, &Value js_adjustments, u64 from, u64 to, ExportOpts) -> Result<ExportResult, String>` |
| `bake_primary_lut` | `(&Value js_adjustments, u32 size, &Path out) -> Result<LutBakeResult, String>` |
| `chroma_export_video` (cmd) | kicks a background export, returns `{started, out_path, from, to, total}` |
| `chroma_export_progress` (cmd) | `{ running, done, total, out_path?, error? }` |
| `chroma_bake_lut` (cmd) | synchronous, returns `LutBakeResult { out_path, size, warnings }` |

`ExportOpts { codec: "prores"(default) | "h264", quality?, fps_override? }`.

## The pipeline

```
ffmpeg decode pipe                 render_core (D-014)              ffmpeg encode pipe
------------------                 -------------------              ------------------
-i clip                            init_gpu_context()  ×1           -f rawvideo -pix_fmt rgb24
-vf select=between(n,FROM,TO)      OwnedRenderCaches   ×1           -framerate <src rate>
-f rawvideo -pix_fmt rgb24 -   ->  per frame:                  ->   -c:v prores_ks -profile:v 3
                                     set_current_frame(n)              -pix_fmt yuv422p10le   (prores)
   read W*H*3 bytes                  JSON -> AllAdjustments           -c:v libx264 -crf 18
                                     JSON.masks -> mask bitmaps        -pix_fmt yuv420p       (h264)
                                     render(ctx, caches, frame,
                                            hash=n, req, "export",
                                            output_to_display=false)
                                     -> RgbImage
                                   write RGB8 -> encoder stdin
```

- **One** GPU context + **one** `OwnedRenderCaches` for the whole run (B-002 — never
  re-init per frame).
- `transform_hash = frame_index + 1` per frame. The GPU input-texture cache in
  `process_and_get_dynamic_image_inner` is keyed on that hash; a constant hash would
  grade every frame through frame 0's pixels.
- Backpressure: single-threaded pump (read decode → grade → write encode), one thread
  draining each child's stderr (kept: last 16 KiB, surfaced on failure). If the encoder
  is slower than we grade, our `write_all` to its stdin blocks — that's flow control, not
  deadlock (we never read the encoder's stdout).
- Decoder uses **pure `select`, no input `-ss`** — see D-022 (matte sync). A late range
  decodes from frame 0; the perf fix is a proxy/persistent pipe (D-015), later.

## Per-frame tracked matte (D-019)

`generate_ai_subject_bitmap` → `chroma::mask::tracked_full_mask(params)` reads
`<params.chromaTrackDir>/<chroma::state::current_video().frame>.png` (nearest ≤ frame).
The export loop calls `chroma::state::set_current_frame(n)` **before** grading frame `n`,
so each encoded frame carries its own matte. The loop points `CurrentVideo` at the export
target on entry and restores the previous clip on exit.

Depth / shape / range masks: same JSON path as a still — nothing export-specific.

## `.cube` bake

`bake_primary_lut` builds a `size³` identity RGB lattice as a `DynamicImage`
(`x = R`, `y = B·size + G`, value `= channel / (size-1)`), strips `masks` / `lutPath` /
crop+rotation+flip from the adjustments, renders it once through `render_core::render`
with **no masks and no LUT**, and writes the graded lattice red-fastest:

```
TITLE "Apelles primary grade"
LUT_3D_SIZE <size>
DOMAIN_MIN 0 0 0
DOMAIN_MAX 1 1 1
<size^3 lines of "r g b" in 0..1>
```

**Limitations a 1D→3D LUT can't represent** (each adds a `warnings[]` entry):
- masked / local adjustments — only the global primary is baked;
- a `.cube` already in the grade — not chained (no LUT-on-LUT);
- the lattice is 8-bit on the input axis (`DynamicImage` is `Rgb8`): ~1/256 quantisation.
  Fine for the talking-head grades v1 targets; move to an f32 grid + f32 readback if
  banding appears. The output transform / AgX the grade shader applies **is** baked in
  (intended — that's what makes the `.cube` match Apelles' look in another app).

## MCP

`mcp/server.py` → `export(kind, path?, from_frame?, to_frame?, quality?)`:
- `kind = "cube"` → `chroma_bake_lut`, returns path + warnings.
- `kind = "prores" | "h264"` → kicks `chroma_export_video`, then polls
  `chroma_export_progress` at 1 Hz to completion, returns `{out_path, frames, total,
  error?}`. Default `path` = next to the source clip as `<name>.graded.mov / .mp4 /
  .cube`. It's a local file the user asked for — no confirm-before-write, but the
  resolved path is always returned.

Frontend bridge op (`app/src/hooks/useChromaControl.ts`): `export` /
`export_progress`, both marked READ_ONLY (no settle/re-render), pull
`useEditorStore.getState().adjustments` and `invoke` the command.

## Geometry IS applied here (B-042 / D-127 → D-135)

Crop, straighten (`rotation`), 90° `orientationSteps`, horizontal/vertical flip and the
perspective/lens warp are all a **CPU pre-pass**, `adjustment_utils::
apply_all_transformations`, that runs *before* the GPU grade. `AllAdjustments` — the
struct `render_core::render` actually consumes — carries no geometry at all.

**History, because it matters for reading the code.** The Colorist preview runs that
pre-pass (`process_preview_job` → `compute_full_transformed_res`) and so does the still
export; `grade_frame` did **not**, which until 2026-09-04 meant a video export silently
produced a full-frame file that disagreed with the preview the user had just been looking
at (the dimension check inside the encode loop was meant to catch it, but nothing in that
path could change a frame's size, so it was unreachable). **D-127** made `export_video`
refuse up front, naming every non-identity control. **D-135** replaced that refusal with
the real thing; `unsupported_geometry` is deleted.

**How it works now.**

- `grade_frame` → `prepare_frame` calls `apply_all_transformations` — *the same function*
  the preview and the still export call, not a re-implementation of the chain. Every stage
  is a `Cow` that stays `Borrowed` at identity, including `apply_crop`'s full-frame-rect
  early return, so a grade with no geometry copies nothing (there is a test asserting the
  `Cow` is still `Borrowed`).
- Mask bitmaps are rasterised at the **transformed** size with the **real** crop offset —
  `EXPORT_MASK_SCALE = 1.0` is the preview's `effective_scale` collapsed for a full-res
  render, which is exactly why the export's unscaled offset and the preview's
  `scaled_crop_offset` are the same number. The two relight resolvers get the same pair;
  they carried the same hardcoded `(0.0, 0.0)`.
- **The encoder is spawned lazily, on the first graded frame**, from that frame's measured
  dimensions. Predicting the size analytically would be a second copy of
  `apply_all_transformations`' arithmetic, free to drift by a pixel and shear every frame;
  measuring it cannot disagree with the pass, because it *is* the pass. The dead in-loop
  dimension check is now a live invariant: every frame must transform to the same size as
  the first.
- **D-019's tracked mattes needed no change.** `generate_ai_bitmap_from_full_mask` already
  walks each output pixel back through crop offset → straighten → flips → 90° steps into
  the full-resolution matte, so passing the real offset *is* the fix. D-019's parenthetical
  ("true for v1: no crop/geometry on video") was corrected in place: the assumption is
  about the matte's resolution, not about the frame being uncropped.
- **Even dimensions:** `yuv420p` (h.264) needs both even, `yuv422p10le` (ProRes) needs an
  even width, and `react-image-crop` guarantees neither. The rule is **round down to a
  multiple of 2, for every codec** — `align_encoder_dims` / `resolve_encoder_dims`, applied
  by `fit_frame_to_encoder` as a `crop_imm` trim of ≤1 row/column so the surviving pixels
  are bit-identical (never a pad, never a resample). Down rather than up because up has to
  invent the extra row; uniform across codecs so the same crop frames identically in a
  master and a review copy. Same convention as ffmpeg's `trunc(iw/2)*2` and HandBrake's
  modulus-2. Premiere/Resolve are not a precedent — their crop is a filter inside a fixed
  sequence resolution and cannot change the encoded size at all.
- Two things dropped by the same original omission also came back: the **lens blur** (it
  lives inside `apply_all_transformations`) and parametric **`color`/`luminance` masks**
  (`prepare_frame` builds the warped image they sample with `apply_geometry_warp`, only
  when a mask needs it — the GUI's `resolve_warped_image_for_masks` needs a `tauri::State`
  an export doesn't have).

**Still refused, and only this:** a crop that rounds to zero in either axis (a sub-2-pixel
drag). `resolve_encoder_dims` errors before the encoder is spawned, naming the size and the
rule. Nothing can encode that frame.

## Verification (2026-09-01, `010BEB07-…MOV`, 1080×1920)

- `cargo check --no-default-features` clean; `cargo clippy` clean on the new files; app
  rebuilt + relaunched under `tauri dev` with no errors.
- neutral frames 0–29 → `ffprobe`: `prores` (profile HQ), `1080×1920`, `yuv422p10le`,
  `nb_frames=30`. Plays.
- `{"exposure": 1.0}` frames 0–29 → frame 15 mean luma **112 → 155** (brighter).
- tracked: `ai-subject` mask + `chromaTrackDir` (527-frame `/track` cache) + `exposure: 5`,
  frames 0–260. Exported frame 0's brightened region IoU **0.762 vs matte 000000** /
  0.696 vs matte 000250; exported frame 250 IoU 0.712 vs matte 000000 / **0.746 vs matte
  000250** — the matte follows the frame in the output.
- `bake_primary_lut({"temperature": 20}, 17)` → `.cube` applied with `ffmpeg -vf
  lut3d=` warms a neutral grey `(126,126,126) → (135,129,116)`, R−B **+19**; centre
  lattice point asserts R > B.
- Not done: the `curl … /op {"op":"export",…}` round-trip — the control-server bridge is
  `bridge:false` until a file is open in the app, and MCP tools need a Claude Code restart
  to load. Rust + CLI paths verified instead.

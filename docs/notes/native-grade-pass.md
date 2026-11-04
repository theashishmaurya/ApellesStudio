# The Colorist grade as a native pass of the GPU render engine (D-450, B-381)

**Status (2026-11-04):** three parts built: the grade shader made faster, bit-identical (part 1); the
grade run natively on the engine's device with the LUT path deleted (part 2); and the structural costs a
per-stage breakdown found, removed with every pixel unchanged (part 3, the current numbers). A faster
large-radius blur (d) is held for the owner. Masks, the Colorist crop / geometry and relight are the next
step.
**Decision:** `docs/08-decisions.md` D-450. **Bug:** B-381. **Engine:** D-449
(`docs/notes/export-gpu-compositor.md` §15).

## Why

Since D-256 a clip's Colorist grade reached the Edit preview and the export as a 33³ lattice baked by
the Colorist's shader. A lattice is a per-pixel function, so everything in a grade that reads a pixel's
neighbours or its position was lost or approximated. That covers the local part of contrast, shadows,
highlights, whites and blacks (they read a tonal blur), and sharpen, clarity, structure, dehaze, glow,
halation, vignette and grain. On real footage the exports measured about 20 dB from the Colorist's own
render (B-381). The fix is the Colorist's own shader running per frame inside the engine, so the
Colorist, the Edit preview and the export are one picture.

Running it is the easy part: `GpuProcessor::run` takes any `Rgba16Float` texture on its device and, with
`output_to_display`, copies each finished tile into `working_texture` on the GPU, with no CPU read-back.
The hard part was speed.

## Part 1 — the shader's cost, measured, and made smaller without changing a pixel

`chroma::grade_pass`'s `measure_the_grade_shader_gpu_passes` times `GpuProcessor::run` with no
read-back (the shader's own GPU passes, which is what the engine will pay), best of 15, with the previous
version built beside the current one on the same device and run interleaved. The machine's GPU was
73–96% busy with other processes during every run (another agent's app), so the absolute numbers are
inflated; the interleaving keeps the comparisons fair.

**Where a 4K frame's time went first** (one run each, everything vs a pass switched off): all passes
462 ms; the four blurs alone 180 ms; the main pass alone 183 ms; neither 9 ms. The structure blur
(radius 40 × min(w, h) / 1080 = 80 px at 4K, a naive Gaussian with one `exp` per tap) was about 240 ms
of the 462 on its own. The CPU f16 conversion `process_and_get_dynamic_image_inner` does (43 ms at 4K)
and the upload (25 ms) were secondary, and the engine path does not pay them.

### The three changes, each held to bit-identical

`the_colorist_render_is_unchanged_by_a_shader_change` renders four grades (exposure only; the local
tone operators; every neighbourhood / position effect; all of them) at 1920×1080, 3840×2160 and
1283×721 through the Colorist's own path, saves them (`APELLES_GRADE_REF=write`) before a change and
requires every pixel to match after it (`=compare`).

| step | what | result vs the previous step |
|---|---|---|
| (a) | One tile for any frame that fits 4096 × 4096 (`tile_size_for`); larger images keep 2048-px tiles and their memory | 0 pixels differ, after the dither fix below |
| (b) | The vertical blur in 16×16 workgroups instead of 1×256 columns | 0 pixels differ |
| (c) | A blur runs only when an operator that reads it is on (`BlursNeeded`) | 0 pixels differ |

**The dither seam (found by step (a)).** The main pass adds a 1/255 dither keyed on
`dither(id.xy)`, the coordinate **inside the tile**, so in any image larger than one tile the dither
pattern restarted at every tile, a seam every 2048 px. Single-tiling necessarily moved those pixels. The
dither is now keyed on the pixel's image coordinate (`absolute_coord`), which is seamless and is the same
value wherever the image is one tile (every frame ≤ 2048 px). Proven in two checks: the dither fix alone on
the old tiling differs from the original render on exactly the same pixels single-tiling does (4K:
2,288,951 / 1,823,488 / 2,406,450 / 2,376,579 pixels for the four grades, max 1 code value, none at 1080p
or 1283×721), and single-tiling against that dither-fixed render differs on 0 pixels.

**Why (c) is exact.** Each blur's readers are guarded in the shader on totals that, with no mask, are the
global values: `apply_sharpen` on `abs(sharpness) >= 0.0005`; the tonal blur is read only by sharpen, by
the shadows / blacks lift of `apply_tonal_adjustments` (`shadows != 0 || blacks != 0`) and by
`apply_highlights_adjustment` (`highlights != 0`). Contrast and whites read no blur. Clarity is read by
clarity, centre and halation (`> 0`); structure by structure, dehaze and glow (`> 0`). A skipped blur's
binding is the dummy texture, read and discarded. Any mask adds to every total, so a masked grade runs all
four.

### Measured (GPU passes only, best of 15, under heavy shared GPU load)

| grade | 1080p: before → (a) → (b) → (c) | 4K: before → (a) → (b) → (c) |
|---|---|---|
| local tone (contrast, shadows, highlights, whites, blacks, colour) | 58.5 → 57.3 → 50.8 → **35.2 ms** | 393 → 376 → 326 → **161 ms** |
| neighbourhood (sharpen, clarity, structure, dehaze, vignette, grain, glow, halation) | 77.1 → 76.7 → 73.1 → **75.8 ms** | 506 → 433 → 383 → **370 ms** |
| everything | 81.8 → 78.5 → 72.4 → **68.5 ms** | 496 → 416 → 377 → **368 ms** |

(a) and (b) are about 10–15% each at 4K; (c) halves a grade that does not use the large blurs. A grade that
uses structure, glow or dehaze still pays the 80-px structure blur, and every grade pays the main pass
(about 150 ms at 4K under this load).

### Not done: (d), a faster large-radius blur — the owner's call

Every remaining large term changes pixels: a separable Gaussian with weights computed once instead of per
tap, a downsampled blur for radii past a few tens of pixels, or the hardware-filtered two-taps-per-fetch
trick. Each would change the look of every existing grade that uses structure, glow or dehaze, in the
Colorist too, so it is held for the owner with its measured gain and pixel tolerance.

What (d) would buy, from the part 2 measurements below: a neighbourhood grade costs 416 ms a frame at 4K
against 195 ms for a local-tone one, so the clarity and structure blurs are about 220 ms of it; a downsampled
large blur would take most of that. Its pixel tolerance has not been measured (it needs the prototype), so
it is quoted here as an upper bound on the gain only.

## Part 2 — the grade as a native pass of the engine

**One device.** `gpu_compositor::RenderDevice` opens the Colorist's `GpuContext` and builds the engine on
the same `wgpu::Device` (`Engine::with_device`), so the grade shader's output never leaves the GPU.

**Per graded clip and frame** (`grade_pass::grade_source`, called from `edit::step_for` before any
geometry):

1. `Engine::write_f16_texture` writes the decoded frame into the shader's `Rgba16Float` input on the GPU.
   The Colorist converts u8 → f32 → f16 on the CPU with round-to-nearest-even; Metal's `textureStore`
   truncates, so the kernel looks the value up in a 256-entry table computed on the CPU with the same
   rounding (`tables::half_of_u8`). Tested bit-identical for all 256 values against the `half` crate.
2. `GpuProcessor::run(.., skip_cpu_readback, output_to_display)` runs the shader into its
   `working_texture`.
3. One `copy_texture_to_buffer` into a fresh buffer (rows padded to 256 bytes), handed to the plan as
   `Source::Gpu(GpuImage { buffer, width, height, row_pixels })` and painted like any other layer.

The processor is kept on the device behind a lock and rebuilt only when a larger frame arrives (sizes
rounded up to 256); the last three input textures are kept by size. A clip with highlighter strokes is the
one case that reads its graded picture back (`Engine::read_gpu_image`), because strokes are drawn on the
CPU.

**What the grade is.** `grade_pass::resolve` reads the grade document through
`apelles_grade_model::load_grade`, strips masks and relight lights, parses the applied `.cube`, and
resolves `AllAdjustments` exactly as the Colorist does. A grade whose adjustments equal an empty
document's and has no `.cube` is no grade at all, so an ungraded or reset clip keeps the plain-decode fast
path, byte-identical to having no grade file. Memoised on the grade file's (mtime, len), so a frame of an
ungraded clip costs one `metadata()` call.

**Deleted:** the engine's LUT step and the `prepare` kernel's trilinear lookup, `Layer::lut`,
`grade_lut`'s per-clip cache, `lut_for_clip`, `resolve_clip_lut` and its pre-flight (now
`grade_pass::check_clip_grades`, behind the same `chroma_timeline_grade_luts` command), and their tests.
`grade_lut` keeps the Colorist's "bake this grade to a `.cube`" export.

### Measured

`a_natively_graded_frame_is_the_colorist_render`: the four reference grades at 1920×1080, 3840×2160 and
1283×721, through `grade_source` and an engine frame, against `GpuProcessor`'s own Colorist render of the
same picture: **0 pixels differ in all twelve cases** (PSNR ∞, SSIM 1). For comparison the lattice measured
49.2 dB, max 20 on a 720p graded frame (D-449 §15.7) and about 20 dB on real footage (B-381).

`a_graded_frame_hashes_the_same_every_time`: a graded base, a graded rounded, minified, rotated PIP and a
translucent title, drawn five times: identical bytes (hash `1561c0e1b632adf5` on this machine).

`measure_a_natively_graded_frame` (ignored; best of 10, upload of the decoded frame and read-back of the
finished frame included, which is what an export pays; load average about 14–35). **Superseded by part 3
below**, which found most of this was one structural cost in the main pass:

| grade | 1080p | 4K |
|---|---|---|
| exposure only | 34.2 ms | 179 ms |
| local tone | 38.6 ms | 195 ms |
| neighbourhood | 60.1 ms | 416 ms |
| everything | 89.6 ms | 453 ms |

So a graded 4K clip does not fit a 33 ms real-time budget, and a graded 1080p clip is close only for a
simple grade. The lattice frame cost 7 / 23 ms but was not the Colorist's picture. The preview draws at its
own, smaller size, where the shader's cost falls with the pixel count. The remaining large terms are the
main pass and the structure blur: (d) above, and the main pass itself, are where further speed is.

**The warm cast** (B-381) came from the lattice. The native frame is the Colorist's render bit for bit, so
it cannot recur on this path. Not re-checked on the owner's real footage: this wave used synthetic
pictures only.

## Part 3 — where a graded frame's time went

Asked after part 2, because an exposure-only grade costing 179 ms at 4K could not be the blurs.

`measure_where_a_graded_frame_spends` (ignored) runs one graded frame stage by stage on a device of its own
opened with `TIMESTAMP_QUERY`, waiting for each stage before the next, best and median of 10: the upload
and half-float conversion, the shader's CPU side, every compute pass of the shader by GPU timestamp (a
test-only `gpu_processing::pass_timer`, compiled out of every other build), the copy into the engine's
buffer, the engine's paint with the read-back, and the read-back alone. No tiling is left at 4K (one tile
up to 4096 px, part 1).

**Before** (load average about 4–7; best of 10, ms):

| stage | 1080p exposure | 4K exposure | 4K local tone | 4K everything |
|---|---|---|---|---|
| upload + `to_f16` | 2.1 | 5.5 | 5.4 | 5.4 |
| shader, CPU side | 0.5 | 1.5 | 1.6 | 1.9 |
| main pass (GPU) | 25.7 | 110.1 | 112.8 | 127.1 |
| blurs (GPU) | — | — | 5.3 | 75.0 |
| copy into `Source::Gpu` | 1.4 | 3.0 | 1.6 | 3.1 |
| engine paint + read-back | 1.8 | 5.5 | 4.0 | 5.5 |

So the main pass was nearly all of it. Stubbing one operator at a time (an experiment, never committed)
found the curves were 104 of its 110 ms at 4K: `apply_curve` copied its 16-point array into a local
`var` and the four curves were passed by value, so every pixel copied 512 bytes of curve data into
per-thread memory and indexed it there, for the default identity curve too.

### What changed, each step bit-identical

The reference test gained a **colour** grade (non-default luma and RGB curves, three HSL bands, colour
wheels, calibration) and a **masked** grade (two mask layers with their own curves, HSL, wheels and tone,
over a ramp and a disc bitmap), so the paths being changed are covered: six grades at three sizes, 18
renders, all 0 pixels different from the committed shader after every change.

1. **Curves read in place.** A curve is named by its owner (`GLOBAL_CURVES`, or a mask index) and channel,
   and `curve_point` / `curve_count` read it from the uniform. Same arithmetic; the one index that wrapped
   out of range for the first segment (`max(0u, i - 1u)` at `i == 0`, whose point is never used there)
   reads point 0 instead. Main pass 110 → 14 ms at 4K, 26 → 3.6 ms at 1080p.
2. **The empty mask array built once.** `run` allocated, zero-filled on the CPU and uploaded two
   frame-sized mask layers on every call (16.6 MB at 4K). With no mask bitmaps it now binds a zeroed array
   the processor's size, built once; every read is a `textureLoad` inside the image, so it reads the same.
   The shader's CPU side 1.5 → 0.07 ms at 4K.
3. **Tiles straight into the engine's buffer.** `run` takes a `TileOutput` (nothing, the display's
   `working_texture`, or a caller's buffer); the native pass passes the engine's buffer, so each finished
   tile is copied once, at its offset, instead of tile → `working_texture` → buffer.
4. **The half-float source buffer reused** between frames (`queue.write_buffer` is ordered after the
   previous frame's conversion), instead of a fresh 25 MB mapped buffer per 4K frame. A steadier upload
   (5.3–5.9 ms at 4K), not a large one.

**Tried and reverted: blurs staged in workgroup memory.** Exact (0 pixels), once WGSL's default zero-fill
of workgroup memory was switched off (it made the vertical pass 0.9 s), but no faster: the vertical pass
went from 2.7 to 4.3 ms (tonal) and 23 to 38 ms (structure) at 4K, the horizontal one barely moved. Apple's
texture cache already serves the direct loop; the blur's cost is its per-tap arithmetic.

**Kept, and why.**
- *The f16 conversion* already runs on the GPU (`to_f16.wgsl`, part 2). Its 1 KB table holds the CPU's
  correctly rounded `v / 255` in half precision. WGSL's `/` is accurate to 2.5 ulp, so computing `v / 255`
  in the kernel and rounding it there is not guaranteed to match the Colorist's own CPU conversion.
- *Operators at their defaults.* After the curves fix, stubbing each in turn: the curves are still about
  6 ms and the HSL panel about 4.5 ms of the 14-ms 4K main pass. Neither is an exact identity at its
  default (a default curve is evaluated through the Hermite segment and divided by 255; the HSL panel
  round-trips through HSV), so skipping them would change pixels.

### Measured after (load average about 8, GPU about 22% busy)

A frame's latency on the real path (`measure_a_natively_graded_frame`: upload, shader into the engine's
buffer, engine paint, read-back, one after the other), best / median of 10:

| grade | 1080p | 4K |
|---|---|---|
| exposure only | 7.4 / 7.6 ms | 24.8 / 26.5 ms |
| local tone | 9.1 / 9.2 ms | 32.3 / 33.9 ms |
| colour panels | 9.0 / 9.1 ms | 32.9 / 34.4 ms |
| neighbourhood | 21.5 / 22.9 ms | 117 / 118 ms |
| everything | 21.3 / 22.8 ms | 117 / 123 ms |

Per stage at 4K, best: exposure only is upload 5.6, shader 15.2 (main 14.1), paint and read-back 5.5 ms;
local tone is upload 5.4, shader 22.7 (main 15.2, tonal blur 5.6), paint and read-back 5.9 ms. An export
overlaps a frame's decode and upload with the previous frame's GPU work and reads frames back on its
writer thread, so what it pays per frame is the GPU's share, about 21 ms (exposure) and 26 ms (local
tone). Against the targets: exposure only and local tone are well under 16 ms at 1080p; at 4K exposure
only is inside 33 ms in latency and local tone is at it (inside it as GPU time).

**Where neighbourhood and everything land** (the honest base for (d)): 106 ms of GPU passes for a 4K
frame, of which the structure blur (radius 80) is 50 ms, the main pass 32 ms, the clarity blur 11 ms,
the tonal and sharpness blurs 9 ms. At 1080p, 18 ms: main 8, structure blur 6.5.

### The preview's size

The Edit preview decodes a clip at a 960-px long edge (`PREVIEW_LONG_EDGE`) and grades that frame, so a
graded preview frame costs 2.0 (exposure) to 6.3 ms (neighbourhood). This is not exact against grading
the full-size frame and scaling it down, and cannot be made so: the grade works in linear light and on
neighbourhoods, and neither commutes with resampling. `measure_the_preview_size_grade` on the 4K
reference picture: exposure only 39.7 dB (max 26), local tone 30.6 dB (max 99), colour 30.9 dB (max 101),
neighbourhood 36.4 dB (max 62), everything 33.1 dB (max 71). The reference picture has hard synthetic
edges, the worst case for this; real footage is smoother. This is how the preview has always graded (the
lattice was applied to the same 960-px decode); the export grades every frame at full size.

## Next: masks, the Colorist crop and geometry, relight

Not carried yet; the Export panel and `editor_get_grade_status` name them per clip (`not_carried`).

- **Masks and relight** read process-global current-frame state: `chroma::state::current_video().frame`,
  set by `set_current_frame`, picks a tracked mask's keyframe and the relight depth map. The parallel
  export segments and the live preview cannot share one global frame. The change they need: the frame
  index (and the depth map for that frame) passed in as part of the clip's grade inputs, and the mask
  bitmaps rasterised per frame from the grade document, so `grade_source` takes `(source, grade, frame)`.
- **The Colorist crop, rotation and flips** are a framing, not a colour: applying them inside the grade
  would change the clip's framing on the timeline. They need a decision on how a Colorist crop composes with
  the Edit transform before they are carried.

## Preview size after D-452 (2026-11-04, roadmap 00r 5d (b))

D-452 removed the decoder's scale argument, so a media-engine frame reached the grade at the source's full size and a graded 4K clip was graded at 4K on every played frame (~25 fps). `edit.rs` now resizes a `Source::Video` to the preview's picture-box size on the GPU first (`gpu_compositor::resized`: the engine's one-layer plan, its minify filter, the canvas copied into a buffer of its own, no read-back), and `Engine::write_f16_texture` reads that `Source::Gpu` in place. The export (`max_long_edge` = None) still grades at full size. Measured (`measure_the_preview_size_grade`): a graded 960×540 engine frame costs 3.6–8.2 ms across the five reference grades. Tests: `grading_a_gpu_resident_picture_equals_grading_it_from_the_cpu` (bit-identical), `a_resized_picture_stays_on_the_gpu_at_its_new_size`.

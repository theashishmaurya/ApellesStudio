# The Colorist grade as a native pass of the GPU render engine (D-450, B-381)

**Status (2026-11-04):** both parts built: the grade shader made faster, bit-identical (part 1), and the
grade run natively on the engine's device with the LUT path deleted (part 2). A faster large-radius blur
(d) is held for the owner. Masks, the Colorist crop / geometry and relight are the next step.
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
finished frame included, which is what an export pays; load average about 14–35):

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

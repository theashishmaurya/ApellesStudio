# The Colorist grade as a native pass of the GPU render engine (D-450, B-381)

**Status (2026-11-04):** part 1 (the grade shader made faster, bit-identical) is built; part 2 (the
grade run natively on the engine's device, the LUT path deleted) is in progress on the same branch.
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

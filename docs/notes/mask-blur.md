# Per-mask blur (`blur` on a mask's adjustments)

Round-2 item 2 / **D-027**. A `blur` field (0–100) on every mask container's
adjustment set. Blends the masked region toward a blurred copy of the frame in
the grade compute shader — defocus the background (completes depth-haze) or any
masked region ("blur the background" as a mask op).

## Approach chosen — (a), reuse the existing pre-blur

The grade shader already builds **four** separable-gaussian blurs of the input
every render (`gpu_processing.rs`, `run_blur(base_radius·scale)`):

| texture | base radius | used by |
|---|---:|---|
| `sharpness_blur` | 1.0 | sharpen |
| `tonal_blur` | 3.5 | contrast / shadows / whites / blacks / highlights |
| `clarity_blur` | 8.0 | clarity, halation |
| `structure_blur` | **40.0** | structure, glow, dehaze |

Per-mask blur rides `structure_blur` — the widest one, already the "regional"
blur. In the per-mask section of `shader.wgsl::main`, after the per-mask
colour-grade loop:

```wgsl
for (var i = 0u; i < adjustments.mask_count; i = i + 1u) {
    let mask_blur = adjustments.mask_adjustments[i].blur;
    if (mask_blur > 0.0) {
        let blur_w = clamp(get_mask_influence(i, absolute_coord) * mask_blur * 0.01, 0.0, 1.0);
        if (blur_w > 0.001) {
            // structure_blurred is display-space for non-raw; linear for raw
            let blurred_lin = srgb_to_linear(clamp(structure_blurred, 0.0, 1.0));
            composite_rgb_linear = mix(composite_rgb_linear, blurred_lin, blur_w);
        }
    }
}
```

Rejected:
- **(b) a dedicated variable-radius gaussian pass per masked ROI** — more correct
  (the slider would set the radius, not just the blend) but a real GPU pass per
  mask + new bind groups + ROI bookkeeping. Kept as the upgrade path.
- **(c) drive RapidRAW's global `lensBlur*` off the mask matte** — global only,
  wires depth-haze but not "blur any mask".

Why (a): one `f32` on the struct, ~20 lines of WGSL, **zero** new textures /
passes / bind-group entries, works for all 32 masks at once, and it covers both
target use cases. The fixed radius is the accepted v1 trade.

## Shader order

Applied in **linear light, after** the global + per-mask tone/colour/curve-less
grade (right after the per-mask `apply_color_grading` loop) and **before**
tone-mapping, vignette and curves. So:

- the un-blurred (sharp) parts of the frame are fully graded before we sample
  neighbours to blur;
- bokeh highlights roll off through the same AgX / sRGB transform as everything
  else (mixing after the tonemap would flatten them).

## Limits

1. **The blur sample is the ungraded input.** `structure_blur` is a pre-pass on
   the source pixels, not on the graded result. Under a strong *per-mask* grade
   (heavy exposure / WB / desat on the mask) the defocused area carries a little
   less of that grade than the sharp area does. Fine for a background defocus /
   depth-haze; a true post-grade blur is approach (b).
2. **Fixed radius** — ~40 px at scale 1 (the `structure_blur` radius, which
   scales with the preview/export resolution factor). The `blur` slider is the
   *blend amount*, not the radius. 0 = untouched, 100 = fully the blurred sample
   where the mask is opaque.
3. **Tiling** — `structure_blur` is computed per 2048 px tile with a 128 px
   overlap, so the 40 px radius is seam-safe; per-mask blur inherits that.

## Struct layout

`blur: f32` **replaces `_pad_cg1`** in `MaskAdjustments` (both the Rust
`#[repr(C)]` struct in `image_processing.rs` and the WGSL struct in
`shader.wgsl`). `_pad_cg1` was dead padding between `hue` and the 16-byte-ish
`ColorGradeSettings` run; consuming it keeps the struct size and every following
field offset byte-identical, so `bytemuck`, the `AllAdjustments` uniform-buffer
size and the array stride are all unchanged.

JSON → uniform: `get_mask_adjustments_from_json` reads
`get_val("details", "blur", 1.0).max(0.0)` — no scale, clamped ≥ 0, hidden when
the mask's "details" section visibility is off (same as clarity/dehaze).

## Surface

- **Frontend:** `INITIAL_MASK_ADJUSTMENTS.blur = 0`; a **"Blur"** slider (0–100,
  `fillOrigin="min"`) in `Details.tsx`'s *Presence* group, rendered only when
  `isForMask` — wired through the same `setMaskContainerAdjustments` setter as the
  other per-mask sliders.
- **Agent:** `set_mask_adjust(mask_id, {blur: 40})` — `blur` is in a new
  `MASK_ONLY_KNOBS` set in `useChromaControl.ts` (so `set_primary` still rejects
  it — there is no global blur). MCP `set_mask_adjust` gained a `blur` param +
  docstring line.
- New op **`add_mask(type, geometry)`** — creates a fresh container with one
  radial / linear sub-mask. The agent previously had no way to make a plain shape
  mask headlessly (`add_subject_mask` / `apply_haze` are AI mattes, `add_component`
  only carves into an existing container). Small, same `createSubMask` +
  geometry-mapping code as `add_component`.
- **Depth-haze:** `handleAddDepthHaze` adds `blur: min(40, 12·amount)` to the
  container recipe. `docs/notes/depth-haze.md` updated.

## Verification (2026-09-01, C019 talking-head, bridge live)

`add_mask` radial over the right side, then `set_mask_adjust(mask, {blur: N})`:

| edge patch (64², ΣRGB of max−min per channel) | blur 0 | blur 70 | Δ |
|---|---:|---:|---:|
| masked (1400,540) | 130 | 88 | **−42** |
| masked (1330,600) | 411 | 336 | **−75** |
| masked (1460,470) | 130 | 103 | **−27** |
| unmasked (300,540) | 63 | 63 | 0 |
| unmasked (520,320) | 23 | 23 | 0 |

Masked local contrast drops ~25–35 %; unmasked patches move exactly 0.
`blur: 0` → byte-identical PNG to the pre-blur render (reversible).

`apply_haze({amount: 1.2})` — background edge std (exported H.264 frame vs raw
source frame, 80² patch upper-right): `[18.4, 14.3, 7.9] → [12.8, 9.2, 5.7]`
(~30 % drop) on top of the haze mean-lift `[20, 13, 6] → [40, 37, 34]`; subject
patches unchanged. Blur is present in the exported file.

No wgsl compile error (`/tmp/chroma_tauri.log`, app renders + exports clean).
Slider path in the app is the same setter as `set_mask_adjust` (wired, not
click-tested headlessly).

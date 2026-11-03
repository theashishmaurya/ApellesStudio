# apelles-compositor

**Layer 1.** The Edit tab's one GPU render engine (D-449): it composites every
timeline frame, for the live preview, the Colorist's framed clip preview and
the export alike. It runs on wgpu (Metal on Apple Silicon).

- **Deps:** `apelles-gpu` (the headless device), `apelles-types` (`Lut3d`,
  `AdjustmentOps`), `wgpu` 29 (the version the rest of the workspace is pinned
  to), `pollster`, `bytemuck`, `image` (no codecs), `thiserror`, `log`. All of
  these were already in the workspace's dependency tree.
- **What it is:** `Engine::render(&FramePlan) -> RgbaImage`. A `FramePlan` is a
  canvas size, what the canvas starts as, and an ordered list of `Step`s: a
  picture `Layer` (its source pixels, an optional baked grade, the crop
  rectangle, the placement box, position, opacity, corner radius and rotation,
  all already in canvas pixels) or an adjustment operator.
- **What it does, per layer, in this order:** the baked Colorist grade (3D LUT,
  manual trilinear fetches, never a hardware sampler) → crop → resample into
  the box (bilinear when magnifying, on the fused path; the `image` crate's
  separable Triangle filter when minifying or rotating, on the general path) →
  rounded corners (the shared rounded-box SDF) → rotation about the box's centre
  (`imageproc`'s bilinear `rotate_about_center`) → opacity → source-over
  (`image`'s `Rgba::blend`, truncating). An adjustment step applies D-230's
  operator to the canvas as it stands.
- **What it does NOT do, on purpose:**
  - **Decide what is drawn.** No timeline, keyframe, fade, transition or
    geometry maths: `app/src-tauri`'s `chroma::edit` resolves each layer and
    converts its transform to pixels in one place (`paint_layer`), so the
    geometry keeps one implementation.
  - **Decode, rasterise titles or captions.** Those arrive as pixels.
  - **Run the Colorist's full grade shader per frame.** The grade arrives as
    the lattice that shader baked (D-256); spatial grade parts (masks) are not
    carried, as on every export path before it.
  - **Fall back to the CPU.** There is no CPU path. A device that cannot be
    opened, a validation error or a GPU that does not finish a frame within
    `GPU_TIMEOUT` is a `ComposeError` for the caller to surface.

## How it stays faithful to the CPU compositor it replaced

Every value that depends only on a layer's geometry (which source texels an
output column reads, with what fraction or weight; the rotation matrix; the
adjustment operator's two stages) is computed on the CPU in `tables.rs`, with
the CPU compositor's own expressions, and uploaded. The kernels only do the
per-pixel weighted sums and the blend, and round the way Rust does (half away
from zero, not WGSL's half to even). Measured against the CPU compositor
before it was deleted: every effect within one code value, the full stack
within two (`docs/notes/export-gpu-compositor.md` §15).

## Determinism

Each kernel writes each output pixel once, from inputs it does not write, with
a fixed summation order: no atomics, no cross-invocation reductions. The same
plan on the same device gives the same bytes, tested from one thread and from
several at once (`a_frame_renders_to_the_same_bytes_every_time`). Like any GPU
path this is a per-device guarantee: another GPU model may round a fused
multiply-add differently (D-363's stated cost, kept by D-449).

## Concurrency

One `Engine` per process (`chroma::gpu_compositor`), shared by every thread.
A frame takes its buffers out of a pool for its own use and returns them after
its submission completes; sources the caller shares through its own cache
(titles, stills, grade lattices) stay on the GPU while the caller still holds
them.

## Tests

`cargo test -p apelles-compositor` (needs the GPU): exact 1:1 copy, exact RGB
widening, the plate blend against `image`'s own blend, the adjustment against
`AdjustmentOps::apply_rgb8` on all 2^24 RGB values, the grade within one code
value of `Lut3d::apply_rgb8`, and the determinism test.

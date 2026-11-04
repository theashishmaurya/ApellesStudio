# apelles-gpu

**Layer 0 (foundation).** Headless wgpu device/queue/limits construction
(D-014, extracted D-144).

- **Deps:** `wgpu`, `pollster`, `log`. No `tauri`, no RapidRAW-core types.
- **What it is:** `init_gpu_context()` — request a high-performance adapter,
  open a device with its own limits, no display surface / window handle. This
  is the Tauri-free half of `render_core.rs`'s old `init_gpu_context()`.
- **What it does NOT do, on purpose:**
  - **No on-screen display.** `GpuContext` here is device + queue + limits
    only. The app's own `image_processing::GpuContext` (unchanged, stays in
    `app/src-tauri`) wraps this crate's fields plus a
    `display: Arc<Mutex<Option<WgpuDisplay>>>` — `WgpuDisplay`
    (`gpu_processing.rs`) owns a `wgpu::Surface<'static>` bound to a native
    window and the present-time render pipeline, which is a GUI concept, not
    a domain one. The D-141 scoping pass flagged this as the one real
    unknown for this slice and left it open; D-144 resolved it by reading
    both struct definitions — `GpuContext` really does split into two
    structs, not one shared type.
  - **No `render()`.** The grade-compute pass-through
    (`gpu_processing::process_and_get_dynamic_image_inner`, driven by
    `RenderCaches`/`RenderRequest`/`AllAdjustments`/mask bitmaps/LUTs) is
    entirely RapidRAW-core (`image_processing.rs`, `app_state.rs`,
    `gpu_processing.rs`). It stays in `app/src-tauri/src/render_core.rs`.
    Moving it is `apelles-grade` — gated on this crate existing, not part of
    it.

## API

- `GpuContext { instance, adapter, device, queue, limits }` — `Clone`, headless.
  `instance` and `adapter` are kept (D-451) so a caller can make a window
  surface the device can present to: a surface can only be configured with a
  device of the instance it was created from. Since D-454 this is the
  process's ONE context: `app/src-tauri`'s `chroma::gpu_compositor::device()`
  opens it, and the engine, the Colorist's grade pass, the Edit preview's
  `CAMetalLayer` surface and the Colorist tab's own window surface (B-006) all
  use its instance and device.
- `init_gpu_context() -> Result<GpuContext, String>`.

## Callers

`apelles-compositor`'s `Engine::new()` (D-449, its own tests and tools),
`app/src-tauri`'s `chroma::gpu_compositor::device()` (D-454, the process's one
device), and
`app/src-tauri/src/render_core.rs::init_gpu_context()`, and it is itself called from `chroma/export.rs`, `chroma/playback.rs`
and `chroma/relight.rs` (6 `render_core::` references total, all unchanged by
this extraction — see D-144).

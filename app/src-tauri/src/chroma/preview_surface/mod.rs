//! # `chroma::preview_surface` — the Edit preview's native GPU surface (D-451)
//!
//! **What it is:** the path by which a frame the GPU render engine has drawn
//! reaches the screen, without leaving the GPU. A `CAMetalLayer` in its own
//! `NSView`, placed in the window BEHIND the transparent `WKWebView`, exactly
//! under the preview's rectangle in the DOM; the webview's preview area is
//! transparent there ("the hole", the same mechanism the Colorist's
//! `gpu_processing::WgpuDisplay` has used since B-006), so every React overlay
//! (transform / crop / caption handles, the safe-area guide, the canvas
//! boundary) still draws on top of the picture and still takes the pointer.
//!
//! **What it does:**
//! - [`presenter::Presenter`] owns the `wgpu::Surface` made from that layer
//!   and draws a frame handed to it ([`presenter::PreviewFrame`], a GPU texture
//!   or the engine's packed RGBA8 canvas buffer, on the SAME device) into the
//!   layer's drawable with one fullscreen-triangle pass that places the picture
//!   in its box and fills the rest with the preview background. That pass is
//!   the whole per-frame cost on this side: no read-back, no IPC payload, no
//!   upload. [`presenter::Placement`] says where the picture goes (it follows
//!   the preview zoom and pan).
//! - `native_view` creates, places (CSS rect → AppKit frame, HiDPI scale,
//!   implicit animations off) and removes the view, on the main thread.
//! - [`gpu`] is the one wgpu instance + device the presenter needs the engine
//!   to draw on: a surface can only be configured with a device of the
//!   instance it was made from (`apelles_gpu::GpuContext::instance`).
//! - `commands` (the prototype's Tauri commands) and `sources` (a GPU test
//!   pattern standing in for the engine) drive it from the debug op
//!   `debug_native_preview`.
//!
//! **What it does NOT do:** composite anything (that is `apelles-compositor`,
//! D-448), decode, or decide what frame to show — the caller hands it frames.
//! It does not draw the React overlays (the webview does, on top). It has no
//! CPU fallback (D-448's one-render-path rule).
//!
//! **Status: a prototype behind `debug_assertions`.** The whole module is
//! compiled out of a release build until the GPU engine plugs into the seam
//! and the `<img>` path is deleted (roadmap 00r 5a, `docs/notes/
//! preview-gpu-surface.md` §7). The presenter and the native view are written
//! as product code; only `commands` and `sources` are prototype scaffolding.

pub mod commands;
mod native_view;
pub(crate) mod presenter;
mod sources;

use std::sync::Mutex;

/// The one wgpu instance + device the preview presenter shows frames from.
///
/// The GPU engine must draw the frames it hands to the presenter on THIS
/// device (`Engine::with_device(gpu()?.device, gpu()?.queue)`), because the
/// surface is created from this context's instance; a texture of another
/// device cannot be sampled here without a copy through the CPU.
pub(crate) fn gpu() -> Result<apelles_gpu::GpuContext, String> {
    static GPU: Mutex<Option<apelles_gpu::GpuContext>> = Mutex::new(None);
    let mut slot = GPU.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(ctx) = slot.as_ref() {
        return Ok(ctx.clone());
    }
    let ctx = apelles_gpu::init_gpu_context()?;
    *slot = Some(ctx.clone());
    Ok(ctx)
}

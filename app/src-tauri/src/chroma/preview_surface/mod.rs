//! # `chroma::preview_surface` — the Edit preview (D-451, D-454)
//!
//! **What it is:** how a frame the GPU render engine has drawn reaches the
//! screen without leaving the GPU. A `CAMetalLayer` in its own `NSView`,
//! placed in the window BEHIND the transparent `WKWebView`, exactly under the
//! preview's rectangle in the DOM; the webview's preview area is transparent
//! there ("the hole", the mechanism the Colorist's
//! `gpu_processing::WgpuDisplay` has used since B-006), so every React overlay
//! (transform / crop / caption handles, the safe-area guide, the canvas
//! boundary) still draws on top of the picture and still takes the pointer.
//! Since D-454 this is THE Edit preview, in release builds too; the JPEG over
//! IPC into an `<img>` it replaced is deleted.
//!
//! **What it does:**
//! - [`presenter::Presenter`] owns the `wgpu::Surface` made from that layer
//!   and the retained frame: the engine's finished canvas is unpacked into it
//!   inside the engine's own submission (`Destination::Present`, the engine's
//!   third terminal beside the read-back and the encoder's pixel buffer, in
//!   `chroma::gpu_compositor`), then drawn into a drawable in its picture box
//!   with the letterbox around it. No read-back, no IPC payload, no upload.
//! - `player` is the playback loop: clocked by the display (the presenter's
//!   one queued drawable), slaved to the audio clock
//!   (`apelles_media::audio_clock`), reporting each new frame to the webview.
//! - `native_view` creates, places (CSS rect → AppKit frame, HiDPI scale,
//!   implicit animations off, a paused re-present in the same transaction)
//!   and removes the view, on the main thread. The layer is tagged Rec.709.
//! - `commands` are the Tauri commands (`@apelles/bridge`'s `previewSurface`).
//! - `stats` (debug builds only) is what the presenter and the loop measured.
//!
//! Everything draws on the process's one render device
//! (`chroma::gpu_compositor::device`): a surface can only be configured with a
//! device of the instance it was made from, and the engine's canvas can only
//! be read on its own device.
//!
//! **What it does NOT do:** composite anything (that is `apelles-compositor`,
//! D-448), decode, or decide what the timeline shows at a position
//! (`chroma::edit::draw_preview_frame`). It does not draw the React overlays
//! (the webview does, on top). It has no CPU fallback (D-448's one-render-path
//! rule).

pub mod commands;
mod native_view;
mod player;
pub(crate) mod presenter;
#[cfg(debug_assertions)]
mod stats;

//! # apelles-compositor — L1, the Edit tab's GPU render engine (D-449)
//!
//! **What it is:** the one engine that composites a timeline frame, for the
//! live preview and the export alike — the shape every comparable editor uses
//! (Final Cut Pro's Metal engine, DaVinci Resolve's GPU image processing,
//! Premiere Pro's Mercury engine: one image engine for playback and export,
//! with hardware decode and encode around it). It runs on wgpu (Metal on
//! Apple Silicon, the only v1 platform), on a device from `apelles-gpu`.
//!
//! **What it does:** takes a [`FramePlan`] — a canvas and an ordered list of
//! picture layers and adjustment operators, already resolved for one frame in
//! canvas pixels — and returns the finished RGBA8 frame. Per layer, in the CPU
//! compositor's order (which it replaces, D-449): crop → resample into the
//! placement box (bilinear when magnifying, the `image` crate's separable
//! Triangle filter when minifying) → rounded corners (D-344) → rotation about
//! the box's centre → opacity → source-over. Adjustment clips (D-230) apply to
//! the canvas as it stands.
//!
//! **What it does NOT do:** decode video, rasterise titles or captions, resolve
//! a timeline, keyframes, fades or transitions (the caller, `app/src-tauri`'s
//! `chroma::edit`, owns all of that and the geometry maths, so it keeps one
//! implementation), or grade a clip: the Colorist's own grade shader does
//! that on the same device first (D-450), and its result arrives as a
//! [`Source::Gpu`] with no CPU read-back; [`Engine::write_f16_texture`] fills
//! that shader's input. There is no CPU fallback: a GPU problem is an error
//! (D-449).
//!
//! **Layer:** L1. Depends on `apelles-gpu` (the device) and `apelles-types`
//! (`AdjustmentOps`) only — no timeline, no media, no app types.

mod engine;
mod plan;
pub mod tables;

pub use engine::{ComposeError, Engine, EngineStats, GPU_TIMEOUT, PendingFrame};
pub use plan::{Background, FramePlan, GpuImage, Layer, Source, Step};

#[cfg(test)]
mod tests;

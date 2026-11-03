//! **What one frame asks the engine to draw** (D-449).
//!
//! A [`FramePlan`] is a pure descriptor: a canvas size, what the canvas starts
//! as, and an ordered list of [`Step`]s painted back to front. Nothing from the
//! timeline crosses this boundary: the caller (`app/src-tauri`'s
//! `chroma::edit`) has already resolved keyframes, fades, transitions, the
//! layer's crop rectangle and placement box in canvas pixels, so the geometry
//! maths keeps exactly one implementation (D-363's rule, kept by D-449).
//!
//! What this module does NOT do: decide how a layer is resampled. That is
//! [`Layer::fused`], the one rule shared by every kernel that paints.

use std::sync::Arc;

use apelles_types::adjustment::AdjustmentOps;
#[cfg(target_os = "macos")]
use apelles_types::video_frame::VideoFrame;
use image::{RgbImage, RgbaImage};

/// One frame: a `width` × `height` RGBA8 canvas, its starting contents, and the
/// steps painted onto it in order (the first step is at the back).
#[derive(Clone)]
pub struct FramePlan {
    pub width: u32,
    pub height: u32,
    pub background: Background,
    pub steps: Vec<Step>,
}

/// What the canvas holds before the first step.
#[derive(Clone)]
pub enum Background {
    /// Every pixel this RGBA value. The timeline's canvas is opaque black.
    Solid([u8; 4]),
    /// An existing canvas, `width` × `height`, painted over in place. Used by
    /// callers that composite one layer onto a canvas they already hold.
    Image(Arc<RgbaImage>),
}

/// One step of the back-to-front paint walk.
#[derive(Clone)]
pub enum Step {
    /// Paint a picture layer.
    Paint(Layer),
    /// D-230: apply an adjustment clip's colour operator to the canvas as it
    /// stands, i.e. to every layer below it.
    Adjust(AdjustmentOps),
}

/// A layer's pixels.
#[derive(Clone)]
pub enum Source {
    /// An RGBA8 image. A shared `Arc` (a rasterised title or a still, held by
    /// the caller's cache) is uploaded once and kept on the GPU while the
    /// caller keeps sharing it; a uniquely owned one (a decoded video frame) is
    /// uploaded for this frame only.
    Rgba(Arc<RgbaImage>),
    /// An RGB8 image, as `decode_pipe` produces it. Widened to RGBA on the GPU,
    /// so the CPU never makes the RGBA copy.
    Rgb(Arc<RgbImage>),
    /// A `width` × `height` layer of one colour (a dip-to-colour plate, D-226).
    Solid {
        width: u32,
        height: u32,
        rgba: [u8; 4],
    },
    /// Pixels already on the engine's device (D-450): a clip graded by the
    /// Colorist's shader, handed over with no CPU read-back.
    Gpu(GpuImage),
    /// D-452 — a decoded video frame, still in the decoder's IOSurface: its
    /// two Y'CbCr planes are imported as textures and converted to RGB on the
    /// GPU with the source's matrix and range (`ycbcr.wgsl`), so the CPU never
    /// touches its pixels.
    #[cfg(target_os = "macos")]
    Video(VideoFrame),
}

/// An RGBA8 picture in a storage buffer on the engine's own device, rows
/// `row_pixels` apart (a texture-to-buffer copy pads each row to 256 bytes).
/// Byte order is an `RgbaImage`'s: red first. The buffer must come from the
/// device the engine was built on ([`crate::Engine::with_device`]).
#[derive(Clone)]
pub struct GpuImage {
    pub buffer: wgpu::Buffer,
    pub width: u32,
    pub height: u32,
    pub row_pixels: u32,
}

impl Source {
    pub fn dimensions(&self) -> (u32, u32) {
        match self {
            Source::Rgba(img) => img.dimensions(),
            Source::Rgb(img) => img.dimensions(),
            Source::Solid { width, height, .. } => (*width, *height),
            Source::Gpu(g) => (g.width, g.height),
            #[cfg(target_os = "macos")]
            Source::Video(frame) => frame.buffer.dimensions(),
        }
    }

    /// The source's row length in pixels: its width, or a GPU image's padded
    /// stride.
    pub fn row_pixels(&self) -> u32 {
        match self {
            Source::Gpu(g) => g.row_pixels,
            other => other.dimensions().0,
        }
    }
}

/// One picture layer, already resolved for this frame in canvas pixels.
///
/// The CPU compositor this replaced (`chroma::edit::composite_layer_onto`,
/// D-132/D-217/B-218/D-338/D-344) defined every field's meaning; the kernels
/// reproduce its order exactly: crop → resample into the box →
/// round the box's corners → rotate about the box's centre → opacity → source-over.
#[derive(Clone)]
pub struct Layer {
    /// The layer's pixels. A graded clip's are already graded (D-450: the
    /// Colorist's shader runs before the plan, on the same device).
    pub source: Source,
    /// The kept rectangle of the source, `(x0, y0, x1, y1)` exclusive, in
    /// source pixels. Never empty (the caller drops a layer cropped away).
    pub crop: (u32, u32, u32, u32),
    /// The placement box in canvas pixels, each at least 1.
    pub size: (u32, u32),
    /// The box's unrounded top-left corner on the canvas, in canvas pixels.
    pub origin: (f64, f64),
    /// `0.0..=1.0`; a layer at 0 is not painted.
    pub opacity: f32,
    /// D-344: the box's corner radius in canvas pixels; `<= 0` is square.
    pub corner_radius: f64,
    /// Clockwise degrees about the box's centre; 0 for none.
    pub rotation_deg: f64,
}

impl Layer {
    /// Whether this layer takes the **fused** path: one pass that samples the
    /// crop bilinearly straight onto the canvas, touching only the canvas
    /// pixels the box covers (D-217). Taken when there is no rotation and the
    /// box is at least the crop's size on both axes (a magnify or 1:1), where
    /// the Triangle filter's support collapses to the same two taps a bilinear
    /// fetch uses. Every other layer takes the **general** path: a separable
    /// Triangle resample into a box-sized buffer (real area filtering when
    /// minifying), corner rounding, rotation, then the blend.
    pub fn fused(&self) -> bool {
        let (cx0, cy0, cx1, cy1) = self.crop;
        self.rotation_deg == 0.0 && self.size.0 >= cx1 - cx0 && self.size.1 >= cy1 - cy0
    }
}

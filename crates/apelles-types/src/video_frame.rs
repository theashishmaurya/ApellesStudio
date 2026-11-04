//! **A decoded video frame as it travels from the media engine to the GPU
//! engine (D-452).**
//!
//! What it is: the handle ([`PixelBuffer`], an IOSurface-backed CoreVideo
//! buffer) and the description of its Y'CbCr planes ([`YcbcrLayout`]) that
//! `apelles-media`'s VideoToolbox decoder produces and `apelles-compositor`
//! imports as Metal textures. Here, at L0, because both of those L1 crates
//! speak it and neither may depend on the other.
//!
//! What it does NOT do: decode, convert colour, or touch the pixels. The
//! layout types are plain data; the handle is a reference-counted pointer.

#[cfg(target_os = "macos")]
use std::ptr::NonNull;

#[cfg(target_os = "macos")]
use objc2_core_foundation::CFRetained;
#[cfg(target_os = "macos")]
use objc2_core_video::{CVPixelBuffer, CVPixelBufferGetHeight, CVPixelBufferGetWidth};

/// A decoded picture: a retained, IOSurface-backed `CVPixelBuffer`.
///
/// `Send + Sync` by assertion, and why that is sound: a `CVPixelBuffer` is a
/// reference-counted CoreFoundation object whose retain / release are atomic,
/// and nothing in Apelles writes a decoded frame's pixels after VideoToolbox
/// has delivered it. The GPU engine only reads it; the encoder's target
/// buffers (`vt_encode`) are written by the GPU and then handed to
/// VideoToolbox, one owner at a time.
#[cfg(target_os = "macos")]
#[derive(Clone)]
pub struct PixelBuffer(CFRetained<CVPixelBuffer>);

// SAFETY: see the type's doc: CoreFoundation retain/release is thread-safe and
// the pixels are never mutated concurrently.
#[cfg(target_os = "macos")]
unsafe impl Send for PixelBuffer {}
// SAFETY: as above; shared access only ever reads.
#[cfg(target_os = "macos")]
unsafe impl Sync for PixelBuffer {}

#[cfg(target_os = "macos")]
impl PixelBuffer {
    /// Wrap a retained buffer.
    pub fn new(buffer: CFRetained<CVPixelBuffer>) -> Self {
        Self(buffer)
    }

    /// The buffer, for the CoreVideo / Metal calls that take it.
    pub fn as_cv(&self) -> &CVPixelBuffer {
        &self.0
    }

    /// The raw pointer, for an FFI call that takes ownership-free access.
    pub fn as_ptr(&self) -> NonNull<CVPixelBuffer> {
        NonNull::from(&*self.0)
    }

    /// Picture size in pixels.
    pub fn dimensions(&self) -> (u32, u32) {
        let w = CVPixelBufferGetWidth(&self.0);
        let h = CVPixelBufferGetHeight(&self.0);
        (
            u32::try_from(w).unwrap_or(u32::MAX),
            u32::try_from(h).unwrap_or(u32::MAX),
        )
    }
}

#[cfg(target_os = "macos")]
impl std::fmt::Debug for PixelBuffer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let (w, h) = self.dimensions();
        write!(f, "PixelBuffer({w}x{h})")
    }
}

/// The R'G'B' ← Y'CbCr matrix of a source.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum YcbcrMatrix {
    /// ITU-R BT.601 (SMPTE 170M / BT.470BG), and swscale's default for an
    /// untagged source.
    Bt601,
    /// ITU-R BT.709.
    Bt709,
    /// ITU-R BT.2020 non-constant luminance.
    Bt2020,
}

impl YcbcrMatrix {
    /// The matrix ffmpeg converts a source of probed `color_space` with: its
    /// tag when it names one of these, else swscale's default, BT.601 — so
    /// the engine's RGB is the RGB ffmpeg produces for the same
    /// source.
    pub fn from_probe(color_space: &str) -> Self {
        match color_space {
            "bt709" => YcbcrMatrix::Bt709,
            "bt2020nc" | "bt2020c" => YcbcrMatrix::Bt2020,
            _ => YcbcrMatrix::Bt601,
        }
    }

    /// `(Kr, Kb)`.
    pub fn coefficients(self) -> (f64, f64) {
        match self {
            YcbcrMatrix::Bt601 => (0.299, 0.114),
            YcbcrMatrix::Bt709 => (0.2126, 0.0722),
            YcbcrMatrix::Bt2020 => (0.2627, 0.0593),
        }
    }
}

/// How a decoded frame's two planes are to be read.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct YcbcrLayout {
    pub matrix: YcbcrMatrix,
    /// Full ("pc") range rather than video ("tv") range.
    pub full_range: bool,
    /// Bits per sample: 8, or 10 (stored in the high bits of 16).
    pub bits: u8,
    /// Chroma subsampling as shifts: `(1, 1)` is 4:2:0, `(1, 0)` 4:2:2,
    /// `(0, 0)` 4:4:4.
    pub chroma_shift: (u8, u8),
}

impl YcbcrLayout {
    /// The layout to request for a source of probed `pix_fmt` and
    /// `color_space`, `full_range` as the track declares it.
    pub fn for_source(pix_fmt: &str, color_space: &str, full_range: bool) -> Self {
        let chroma_shift = if pix_fmt.contains("444") {
            (0, 0)
        } else if pix_fmt.contains("422") || pix_fmt.contains("p210") || pix_fmt.contains("p216") {
            (1, 0)
        } else {
            (1, 1)
        };
        let high_depth = ["10", "12", "16", "p010", "p210", "p410"]
            .iter()
            .any(|d| pix_fmt.contains(d));
        Self {
            matrix: YcbcrMatrix::from_probe(color_space),
            full_range: full_range || pix_fmt.starts_with("yuvj"),
            bits: if high_depth { 10 } else { 8 },
            chroma_shift,
        }
    }
}

/// One decoded frame on the nominal grid.
#[cfg(target_os = "macos")]
#[derive(Clone, Debug)]
pub struct VideoFrame {
    pub buffer: PixelBuffer,
    pub layout: YcbcrLayout,
    /// The nominal source frame this is (D-228).
    pub index: u64,
}

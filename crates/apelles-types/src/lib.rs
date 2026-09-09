//! # apelles-types — L0 foundation crate (D-039)
//!
//! **What it is:** the shared value types every other Apelles crate speaks in —
//! `Resolution`, `Rational` (a frame rate / aspect as an exact ratio), `Frame`,
//! `ColorSpace`, `TimeRange`, typed IDs, and the crate-wide error enum.
//!
//! **What it does NOT do:** no GPU (`wgpu`), no media I/O (`ffmpeg`), no
//! rendering, no filesystem. Pure data + `serde`. This crate is the root of the
//! one-directional dependency graph (D-039): everything depends on it, it
//! depends on nothing heavy.
//!
//! **Status:** D-039 migration step 2 — `Resolution`/`Rational`/`ChromaError`
//! are now real, in use by `app/src-tauri/src/chroma/{video,commands,session,
//! project}.rs` (see D-053). They're still deliberately small: the step-2
//! audit found most of `app/src-tauri`'s width/height and fps pairs live on
//! DTOs with independent-optionality or renamed-field semantics that are NOT
//! the same concept as an atomic `Resolution`/`Rational` (D-038's
//! `ProjectSettings`, D-049's `ExportOpts`) — those were deliberately left
//! alone rather than forced. `ColorSpace` and `TimeRange` have no real
//! duplicate anywhere yet (colour space is stored as a free string per D-038,
//! by design, until real colour management (D-004) lands; no time-range
//! struct exists outside `apelles-timeline`, which is out of scope for this
//! step) — they stay unadded rather than speculative. See D-053 for the full
//! audit.

use std::fmt;

use serde::{Deserialize, Serialize};

/// Pixel dimensions of a frame or output target. Field names (`width`,
/// `height`) are chosen to match the historical ad-hoc fields across
/// `app/src-tauri/src/chroma/*` exactly, so call sites can adopt this type via
/// `#[serde(flatten)]` with **zero change to any JSON wire shape** (Tauri IPC
/// payloads or persisted `project.json`) — see D-053.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Resolution {
    pub width: u32,
    pub height: u32,
}

impl Resolution {
    pub const fn new(width: u32, height: u32) -> Self {
        Self { width, height }
    }
}

impl fmt::Display for Resolution {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}x{}", self.width, self.height)
    }
}

/// An exact ratio — a frame rate (`Rational { num: 24000, den: 1001 }`) or a
/// pixel/display aspect. Kept exact (never collapsed to `f64`) so timebases
/// round-trip.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rational {
    pub num: i64,
    pub den: i64,
}

impl Rational {
    pub const fn new(num: i64, den: i64) -> Self {
        Self { num, den }
    }

    pub fn as_f64(self) -> f64 {
        self.num as f64 / self.den as f64
    }
}

/// `"{num}/{den}"` — the exact form `ffmpeg -r`/`-framerate` args want.
/// Real, previously ad-hoc use: `app/src-tauri/src/chroma/export.rs` used to
/// build this with a bare `format!("{}/{}", info.fps_num, info.fps_den)`.
impl fmt::Display for Rational {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}/{}", self.num, self.den)
    }
}

/// The crate-wide error type. Every fallible Apelles API returns
/// `Result<_, ChromaError>` (or a crate-local error that converts into this).
#[derive(Debug, thiserror::Error)]
pub enum ChromaError {
    #[error("invalid value: {0}")]
    Invalid(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("unsupported: {0}")]
    Unsupported(String),
}

/// Convenience alias.
pub type Result<T, E = ChromaError> = std::result::Result<T, E>;

/// The cubic-bezier easing curve every ramp in this project is shaped by
/// (D-147, moved out of [`fade`] by D-233 once keyframe easing became its
/// second consumer). Pure math — see the module doc for why it is L0.
pub mod ease;

pub use ease::EaseCurve;

/// The per-clip fade envelope, built over [`ease::EaseCurve`] (D-147). Pure,
/// unit-agnostic math — see the module doc for why it is L0 rather than living
/// beside the timeline model whose `Clip` fields are typed by it.
pub mod fade;

pub use fade::fade_gain;

/// The per-clip stereo pan law + the clip-volume guard (D-223). Pure math,
/// here rather than beside `apelles_timeline::Clip`'s own `pan`/`volume` fields
/// for exactly [`fade`]'s reason — the audio mixer that consumes it is L1 and
/// cannot reach up to L2.
pub mod pan;

pub use pan::{clip_volume, pan_gains};

/// The per-clip parametric-EQ band type + its Audio EQ Cookbook biquad math
/// (D-224). Here rather than beside `apelles_timeline::Clip`'s own `eq_bands`
/// for [`fade`]'s and [`pan`]'s reason — the mixer that runs the filters is L1
/// and cannot reach up to L2 — and, unlike those two, the ffmpeg exporter
/// consumes the COEFFICIENTS this produces directly rather than naming an
/// ffmpeg filter, so this module is the single definition of what a band means
/// in both engines. See its own doc for the measurement behind that choice.
pub mod eq;

pub use eq::{
    Biquad, BiquadCoeffs, EQ_DESIGN_SAMPLE_RATE, EQ_MAX_FREQ_HZ, EQ_MAX_GAIN_DB, EQ_MAX_Q,
    EQ_MIN_FREQ_HZ, EQ_MIN_Q, EqBand, EqBandKind, eq_response_db,
};

/// The adjustment-clip primary correction + the two-stage colour operator it
/// resolves to (D-230). Here for [`eq`]'s reason in its strongest form: the
/// live-preview compositor and the ffmpeg export compiler both consume the
/// OPERATOR this produces rather than each re-deriving the correction, which is
/// what makes an adjustment clip's preview and its export the same maths by
/// construction instead of by two implementations agreeing. See its own doc for
/// why the effect is not the Colorist grade, and why the operator is two stages.
pub mod adjustment;

pub use adjustment::{AdjustmentLayer, AdjustmentOps};

/// A baked 3D colour lookup table + its trilinear sampler and `.cube` writer
/// (D-256). Here for [`adjustment`]'s reason taken one step further: this is
/// what lets the **Colorist's real grade** — a wgpu shader with no CPU
/// implementation, which [`adjustment`]'s own header called structurally
/// unreachable from the Edit tab — cross into the Edit compositor and the
/// ffmpeg exporter as *data* rather than as code. The shader stays the only
/// implementation of the grade; this crate only interpolates what it baked.
/// See its own doc for why trilinear and not tetrahedral, and what a 3D LUT
/// inherently cannot carry.
pub mod lut3d;

pub use lut3d::Lut3d;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn it_builds() {
        let r = Resolution::new(3840, 2160);
        assert_eq!(r.width * r.height, 8_294_400);
        assert!((Rational::new(24000, 1001).as_f64() - 23.976).abs() < 0.001);
    }

    #[test]
    fn resolution_display() {
        assert_eq!(Resolution::new(1920, 1080).to_string(), "1920x1080");
    }

    #[test]
    fn rational_display_matches_ffmpeg_arg_form() {
        // exactly the string export.rs used to hand-build for `-r`/`-framerate`
        assert_eq!(Rational::new(30000, 1001).to_string(), "30000/1001");
        assert_eq!(Rational::new(24, 1).to_string(), "24/1");
    }

    #[test]
    fn resolution_flatten_round_trips_with_bare_width_height_json() {
        // the whole point of matching field names: a pre-D-053 caller's plain
        // `{"width":1920,"height":1080,...}` JSON must still deserialize into
        // a struct holding `#[serde(flatten)] resolution: Resolution`.
        #[derive(Serialize, Deserialize)]
        struct Dto {
            #[serde(flatten)]
            resolution: Resolution,
            codec: String,
        }
        let legacy_json = r#"{"width":1920,"height":1080,"codec":"h264"}"#;
        let dto: Dto = serde_json::from_str(legacy_json).unwrap();
        assert_eq!(dto.resolution, Resolution::new(1920, 1080));
        let round_tripped = serde_json::to_value(&dto).unwrap();
        assert_eq!(
            round_tripped,
            serde_json::from_str::<Value>(legacy_json).unwrap()
        );
    }
}

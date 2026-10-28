//! How a clip's source picture is sized into the timeline's frame (D-425,
//! B-325).
//!
//! **What it is.** [`ScalingMode`] — the per-clip "input scaling" choice every
//! NLE has (DaVinci Resolve: *Image Scaling → Input Scaling*, per clip under
//! *Retime and Scaling*; Premiere: *Set to Frame Size* / *Scale to Frame Size*)
//! — and [`fitted_footprint`], the one pure function that turns a source size
//! and a frame size into the clip's **footprint at `scale == 1`**.
//!
//! **What it does.** `Clip::scale` has always been "a multiplier of the clip's
//! own footprint" (D-353). This module decides what that footprint is:
//!
//! - [`ScalingMode::Fit`] — the whole source, scaled (up or down) until it
//!   touches the frame on its binding axis; the other axis letterboxes.
//!   A source whose aspect matches the frame fills it exactly.
//! - [`ScalingMode::Fill`] — scaled until it covers the frame on both axes; the
//!   overflow is cropped by the frame edge.
//! - [`ScalingMode::Native`] — one source pixel per frame pixel, no resize.
//!   This is the only behaviour clips had before D-425, so a clip with no
//!   `scaling` key *is* `Native`: an old project does not change look.
//!
//! Resolve's fourth mode, *Stretch*, is not a mode here: it is the existing
//! `box_width = box_height = 1` override (D-193), which both renderers already
//! agree on.
//!
//! **What it does NOT do.** It never probes a file (the caller supplies the
//! source size) and never reads the crop: the footprint is that of the
//! *uncropped* source, because `Clip::scale`'s width has never depended on crop
//! (see `ClipTransform::effective_size`). Its TypeScript twin is
//! `clipScaling.ts` in `@apelles/editor`; the shared vectors in both test
//! modules keep them in step.

use serde::{Deserialize, Serialize};

/// A clip's input-scaling mode. Serialised lowercase (`"fit"`, `"fill"`,
/// `"native"`) — the same strings the MCP tools and the Inspector use.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ScalingMode {
    /// Whole picture visible, letterboxed (Resolve's project default).
    #[default]
    Fit,
    /// Frame fully covered, overflow cropped.
    Fill,
    /// Source pixels 1:1 — the pre-D-425 behaviour.
    Native,
}

impl ScalingMode {
    /// The mode a timeline uses for new clips when it has not chosen one.
    pub const TIMELINE_DEFAULT: Self = Self::Fit;
    /// What a clip with **no** `scaling` key means: the behaviour every
    /// pre-D-425 project was saved under.
    pub const LEGACY: Self = Self::Native;

    /// The wire / UI spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Fit => "fit",
            Self::Fill => "fill",
            Self::Native => "native",
        }
    }
}

/// The clip's footprint at `scale == 1`, in the units of `frame` (pixels in,
/// pixels out). `source` and `frame` are `(width, height)`.
///
/// The binding axis of `Fit`/`Fill` is returned as *exactly* the frame's own
/// extent (not `source * (frame / source)`, which can be one ulp off), so a
/// source that matches the frame's aspect maps to precisely the frame — and the
/// exporter's exact-full-frame fast path (`footprint == 1`) is taken.
///
/// A non-positive source or frame edge has nothing to fit: the source is
/// returned unchanged (the `Native` answer) rather than dividing by zero.
pub fn fitted_footprint(mode: ScalingMode, source: (f64, f64), frame: (f64, f64)) -> (f64, f64) {
    let (sw, sh) = source;
    let (fw, fh) = frame;
    if mode == ScalingMode::Native || !(sw > 0.0 && sh > 0.0 && fw > 0.0 && fh > 0.0) {
        return source;
    }
    // Compare `fw/sw` with `fh/sh` by cross-multiplying: exact for the common
    // integer case, no division until the axis is chosen.
    let width_is_tighter = fw * sh <= fh * sw;
    let bind_width = match mode {
        ScalingMode::Fit => width_is_tighter,
        ScalingMode::Fill => !width_is_tighter,
        ScalingMode::Native => unreachable!("returned above"),
    };
    if bind_width {
        (fw, sh * fw / sw)
    } else {
        (sw * fh / sh, fh)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FRAME: (f64, f64) = (1080.0, 1920.0);

    #[test]
    fn a_matching_aspect_fills_the_frame_exactly() {
        // The B-325 case: a 2x Motion render on a timeline of the manifest's size.
        assert_eq!(
            fitted_footprint(ScalingMode::Fit, (2160.0, 3840.0), FRAME),
            FRAME
        );
        assert_eq!(
            fitted_footprint(ScalingMode::Fill, (2160.0, 3840.0), FRAME),
            FRAME
        );
    }

    #[test]
    fn fit_letterboxes_a_wider_source() {
        // 16:9 into 9:16 -> width-bound, 607.5 tall.
        assert_eq!(
            fitted_footprint(ScalingMode::Fit, (1920.0, 1080.0), FRAME),
            (1080.0, 607.5)
        );
    }

    #[test]
    fn fit_pillarboxes_a_taller_source() {
        // 9:16 into 16:9 -> height-bound, 607.5 wide.
        assert_eq!(
            fitted_footprint(ScalingMode::Fit, (1080.0, 1920.0), (1920.0, 1080.0)),
            (607.5, 1080.0)
        );
    }

    #[test]
    fn fit_scales_a_smaller_source_up() {
        assert_eq!(
            fitted_footprint(ScalingMode::Fit, (540.0, 960.0), FRAME),
            FRAME
        );
    }

    #[test]
    fn fill_covers_the_frame_and_overflows_the_other_axis() {
        // 16:9 into 9:16 -> height-bound, 3413.33 wide (cropped by the frame).
        let (w, h) = fitted_footprint(ScalingMode::Fill, (1920.0, 1080.0), FRAME);
        assert_eq!(h, 1920.0);
        assert!((w - 3413.333).abs() < 1e-3, "w = {w}");
    }

    #[test]
    fn native_is_the_source_unchanged() {
        assert_eq!(
            fitted_footprint(ScalingMode::Native, (2160.0, 3840.0), FRAME),
            (2160.0, 3840.0)
        );
    }

    #[test]
    fn a_degenerate_size_is_left_alone() {
        assert_eq!(
            fitted_footprint(ScalingMode::Fit, (0.0, 100.0), FRAME),
            (0.0, 100.0)
        );
        assert_eq!(
            fitted_footprint(ScalingMode::Fit, (100.0, 100.0), (0.0, 0.0)),
            (100.0, 100.0)
        );
    }

    #[test]
    fn the_wire_spelling_is_lowercase_and_a_missing_key_is_native_by_convention() {
        assert_eq!(serde_json::to_string(&ScalingMode::Fit).unwrap(), "\"fit\"");
        assert_eq!(
            serde_json::from_str::<ScalingMode>("\"native\"").unwrap(),
            ScalingMode::Native
        );
        assert_eq!(ScalingMode::LEGACY, ScalingMode::Native);
        assert_eq!(ScalingMode::TIMELINE_DEFAULT, ScalingMode::Fit);
    }
}

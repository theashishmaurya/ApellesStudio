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
//! [`fitted_origin`] (B-328, D-429) is the footprint's companion: where a
//! `fit`/`fill` footprint starts when `position` is 0, 0 — centred, not flush
//! top-left.
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

/// Where a `fit`/`fill` clip's footprint starts when `position` is `0, 0`, as
/// a fraction of `frame` on each axis (B-328).
///
/// `position` is the box's top-left corner (D-338), so a footprint that is not
/// the frame's own size would sit flush top-left. Every NLE centres the sized
/// picture instead (Resolve's *Scale entire image to fit*, Premiere's *Set to
/// Frame Size*), so the **origin** is half of what the footprint leaves over:
/// `(1 - footprint / frame) / 2` — positive for a letterbox/pillarbox, negative
/// for a `fill` overflow, and exactly `0` on a binding axis ([`fitted_footprint`]
/// returns the frame's own extent there). `Native` has no origin: it is the
/// pre-D-425 top-left behaviour every old project was saved under.
///
/// `footprint` is the **scale-1** footprint ([`fitted_footprint`]'s answer), so
/// the origin does not move as `scale` changes — `scale` grows the box from its
/// centred top-left corner, exactly as it always grew from the top-left. The
/// caller adds the result to `position` for any axis that has no explicit
/// `box_width`/`box_height` override (an override is a canvas fraction the
/// person set, not a footprint).
pub fn fitted_origin(mode: ScalingMode, footprint: (f64, f64), frame: (f64, f64)) -> (f64, f64) {
    let (pw, ph) = footprint;
    let (fw, fh) = frame;
    if mode == ScalingMode::Native || !(fw > 0.0 && fh > 0.0) {
        return (0.0, 0.0);
    }
    ((1.0 - pw / fw) / 2.0, (1.0 - ph / fh) / 2.0)
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
    fn a_letterboxed_fit_and_a_fill_overflow_are_centred() {
        // B-328: 16:9 into 9:16 -> 607.5 tall in 1920 -> equal bands above and below.
        let fit = fitted_footprint(ScalingMode::Fit, (1920.0, 1080.0), FRAME);
        let (ox, oy) = fitted_origin(ScalingMode::Fit, fit, FRAME);
        assert_eq!(ox, 0.0);
        assert!((oy - (1.0 - 607.5 / 1920.0) / 2.0).abs() < 1e-12);
        // 1480x1080 into 1920x1080 fit: pillarbox, 220 px each side.
        let wide = (1920.0, 1080.0);
        let fit = fitted_footprint(ScalingMode::Fit, (1480.0, 1080.0), wide);
        let (ox, oy) = fitted_origin(ScalingMode::Fit, fit, wide);
        assert!((ox - 220.0 / 1920.0).abs() < 1e-12 && oy == 0.0);
        // The same source filled: overflow cropped evenly top and bottom.
        let fill = fitted_footprint(ScalingMode::Fill, (1480.0, 1080.0), wide);
        let (ox, oy) = fitted_origin(ScalingMode::Fill, fill, wide);
        assert_eq!(ox, 0.0);
        // The hand-centring used on the Nemotron clips: -(fillH - 1) / 2 = -0.1486.
        assert!((oy + 0.1486).abs() < 1e-3, "oy = {oy}");
    }

    #[test]
    fn a_matching_aspect_and_native_have_no_origin() {
        let fit = fitted_footprint(ScalingMode::Fit, (2160.0, 3840.0), FRAME);
        assert_eq!(fitted_origin(ScalingMode::Fit, fit, FRAME), (0.0, 0.0));
        assert_eq!(
            fitted_origin(ScalingMode::Native, (607.5, 1080.0), FRAME),
            (0.0, 0.0)
        );
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

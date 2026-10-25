//! # Clip highlights — the "highlighter pen" sweep (D-396)
//!
//! **What it is:** [`Highlight`], one phrase highlight on a clip's own picture:
//! a box (fractions of the SOURCE image) that sweeps in left to right like a
//! highlighter pen starting at a source frame, then stays for the rest of the
//! clip. [`Clip::highlights`](crate::Clip::highlights) is a list of them.
//!
//! **What it does:** the pure geometry both renderers share. [`Highlight::
//! sweep_at`] resolves a highlight at a source frame and an image size into a
//! [`Sweep`] (the pen's current rounded rectangle in PIXELS, its colour and its
//! opacity), and [`Sweep::coverage`] answers how much of one pixel the stroke
//! covers. The live compositor (`chroma::edit`) blends that into the decoded
//! picture; the ffmpeg exporter (`timelineExport.ts`'s `highlightGeqStep`)
//! compiles the identical formula into a `geq` node.
//!
//! **What it does NOT do:** no pixels and no images (it returns coverage, the
//! caller blends), no OCR or transcript matching (that is the suggestion op in
//! `@apelles/editor`), no keyframing: the sweep is its own animation, not an
//! animatable property.
//!
//! **Image space, not canvas space.** The box is drawn onto the clip's decoded
//! picture BEFORE crop, scale, rotation and keyframes, so the highlight follows
//! every push-in for free and stays on the words it was authored over.
//!
//! **Absent means no work.** A clip with no highlights serialises without the
//! key and costs neither engine anything.

use apelles_types::ease::EaseCurve;
use apelles_types::shape::rounded_box_coverage;
use serde::{Deserialize, Serialize};

/// The default highlighter colour: a yellow-ochre that reads as a marker on a
/// white article page AND on a dark one (D-396 records the measurement).
pub const DEFAULT_HIGHLIGHT_COLOR: &str = "#F2B63A";
/// Default stroke opacity. Low enough that the text under the pen stays
/// legible, high enough to read on a dark page.
pub const DEFAULT_HIGHLIGHT_OPACITY: f64 = 0.45;
/// The sweep's easing: CSS `ease-out-cubic`, `cubic-bezier(0.215, 0.61, 0.355,
/// 1)`, as the one [`EaseCurve`] type every other eased thing in the model
/// uses. The exporter samples the same curve, so the two engines share the
/// shape and differ only by the exporter's piecewise-linear sampling.
pub const HIGHLIGHT_SWEEP_EASE: EaseCurve = EaseCurve {
    x1: 0.215,
    y1: 0.61,
    x2: 0.355,
    y2: 1.0,
};
/// How round the pen's leading end is, as a fraction of the box height. The
/// trailing (left) edge is always hard: a marker stroke starts square and ends
/// in the rounded tip of the nib.
pub const HIGHLIGHT_TIP_ROUNDING: f64 = 0.25;

/// The built-in colour as bytes, for the (unreachable in practice) case where
/// even the constant string fails to parse.
const DEFAULT_HIGHLIGHT_RGB: [u8; 3] = [0xF2, 0xB6, 0x3A];

/// One phrase highlight. Serialised as `{box, at, dur, color?, opacity?}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Highlight {
    /// `[x0, y0, x1, y1]` as fractions of the SOURCE image (0..1, top-left
    /// origin). Stored as written; [`Highlight::normalised_box`] sorts and
    /// clamps it ("the model stores what the UI wrote, the consumer decides
    /// what it means", `Clip::crop_left`'s rule).
    #[serde(rename = "box")]
    pub rect: [f64; 4],
    /// The clip SOURCE frame the sweep starts on, the same axis a keyframe's
    /// `frame` is on, so it survives a trim and a move.
    pub at: i64,
    /// Frames the sweep takes. `0` (or less) is an instant reveal at `at`.
    pub dur: i64,
    /// `#RRGGBB` / `#RGB`. `None` = [`DEFAULT_HIGHLIGHT_COLOR`]; an
    /// unparseable value falls back to it too, in both engines.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// `0..=1`. `None` = [`DEFAULT_HIGHLIGHT_OPACITY`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opacity: Option<f64>,
}

/// A highlight resolved at one frame for one image size: everything a renderer
/// needs to blend the stroke, in pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Sweep {
    /// The box's top and bottom edge, pixels.
    pub top: f64,
    pub bottom: f64,
    /// The hard left edge, pixels.
    pub left: f64,
    /// The pen's leading edge right now, pixels.
    pub right: f64,
    /// Corner radius of the leading end, pixels.
    pub tip_radius: f64,
    /// Stroke colour, 0..=255 per channel.
    pub rgb: [u8; 3],
    /// Stroke opacity, 0..=1.
    pub opacity: f32,
}

impl Highlight {
    /// The stroke colour as RGB. Falls back to [`DEFAULT_HIGHLIGHT_COLOR`] on
    /// an absent or malformed value, so a bad string degrades the same way in
    /// the compositor and the exporter.
    pub fn rgb(&self) -> [u8; 3] {
        self.color
            .as_deref()
            .and_then(parse_hex)
            .or_else(|| parse_hex(DEFAULT_HIGHLIGHT_COLOR))
            .unwrap_or(DEFAULT_HIGHLIGHT_RGB)
    }

    /// The effective opacity, clamped to `0..=1` (absent or non-finite → the
    /// default).
    pub fn opacity_value(&self) -> f64 {
        match self.opacity {
            Some(o) if o.is_finite() => o.clamp(0.0, 1.0),
            _ => DEFAULT_HIGHLIGHT_OPACITY,
        }
    }

    /// The box as `[x0, y0, x1, y1]` with the corners ordered and every value
    /// clamped to `0..=1`; `None` when it has no area or a non-finite edge.
    pub fn normalised_box(&self) -> Option<[f64; 4]> {
        if self.rect.iter().any(|v| !v.is_finite()) {
            return None;
        }
        let c = |v: f64| v.clamp(0.0, 1.0);
        let (x0, x1) = (
            c(self.rect[0].min(self.rect[2])),
            c(self.rect[0].max(self.rect[2])),
        );
        let (y0, y1) = (
            c(self.rect[1].min(self.rect[3])),
            c(self.rect[1].max(self.rect[3])),
        );
        (x1 > x0 && y1 > y0).then_some([x0, y0, x1, y1])
    }

    /// How far the pen has travelled at `source_frame`, `0.0..=1.0`, eased with
    /// [`HIGHLIGHT_SWEEP_EASE`]. `0.0` before `at`; `1.0` from `at + dur` on
    /// (and from `at` on for a zero-length sweep).
    pub fn progress_at(&self, source_frame: i64) -> f64 {
        if source_frame < self.at {
            return 0.0;
        }
        if self.dur <= 0 || source_frame >= self.at.saturating_add(self.dur) {
            return 1.0;
        }
        HIGHLIGHT_SWEEP_EASE.eval((source_frame - self.at) as f64 / self.dur as f64)
    }

    /// Resolve this highlight at `source_frame` for a `width`×`height` image.
    /// `None` when there is nothing to draw: not started yet, a degenerate box,
    /// zero opacity, or an empty image.
    pub fn sweep_at(&self, source_frame: i64, width: u32, height: u32) -> Option<Sweep> {
        let progress = self.progress_at(source_frame);
        let opacity = self.opacity_value();
        if progress <= 0.0 || opacity <= 0.0 || width == 0 || height == 0 {
            return None;
        }
        let [x0, y0, x1, y1] = self.normalised_box()?;
        let (w, h) = (width as f64, height as f64);
        let left = x0 * w;
        let right = left + (x1 - x0) * w * progress;
        let (top, bottom) = (y0 * h, y1 * h);
        Some(Sweep {
            top,
            bottom,
            left,
            right,
            tip_radius: HIGHLIGHT_TIP_ROUNDING * (bottom - top),
            rgb: self.rgb(),
            opacity: opacity as f32,
        })
    }
}

impl Sweep {
    /// The stroke's coverage of the pixel whose top-left corner is `(x, y)`,
    /// `0.0..=1.0`, WITHOUT the opacity (multiply by [`Self::opacity`]).
    ///
    /// The stroke is a rounded box that extends one tip radius LEFT of the hard
    /// edge, with everything left of the hard edge masked off: that gives a
    /// square trailing end and a rounded leading end from the one canonical
    /// rounded-box SDF, with no corner special cases. The exporter compiles the
    /// same shape, clamp and half-pixel convention to `geq`.
    pub fn coverage(&self, x: u32, y: u32) -> f32 {
        if (x as f64 + 0.5) < self.left {
            return 0.0;
        }
        let ext_left = self.left - self.tip_radius;
        rounded_box_coverage(
            x as f64 - ext_left,
            y as f64 - self.top,
            self.right - ext_left,
            self.bottom - self.top,
            self.tip_radius,
        )
    }

    /// The pixel rectangle `(x0, y0, x1, y1)` (exclusive end) that can have
    /// non-zero coverage inside a `width`×`height` image: the loop bounds, so
    /// a renderer touches only the stroke and not the whole picture.
    pub fn pixel_bounds(&self, width: u32, height: u32) -> (u32, u32, u32, u32) {
        let clamp = |v: f64, max: u32| v.clamp(0.0, max as f64) as u32;
        (
            clamp(self.left.floor(), width),
            clamp(self.top.floor(), height),
            clamp(self.right.ceil() + 1.0, width),
            clamp(self.bottom.ceil() + 1.0, height),
        )
    }
}

/// `#RRGGBB` or `#RGB` (the `#` optional) → RGB bytes.
fn parse_hex(raw: &str) -> Option<[u8; 3]> {
    let hex = raw.trim().trim_start_matches('#');
    let digits: Vec<u8> = hex
        .chars()
        .map(|c| c.to_digit(16).map(|d| d as u8))
        .collect::<Option<_>>()?;
    match digits.as_slice() {
        [r, g, b] => Some([r * 17, g * 17, b * 17]),
        [r1, r2, g1, g2, b1, b2] => Some([r1 * 16 + r2, g1 * 16 + g2, b1 * 16 + b2]),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hl(rect: [f64; 4], at: i64, dur: i64) -> Highlight {
        Highlight {
            rect,
            at,
            dur,
            color: None,
            opacity: None,
        }
    }

    #[test]
    fn json_shape_is_box_at_dur_and_omits_unset_fields() {
        let h = hl([0.1, 0.2, 0.6, 0.3], 12, 24);
        let json = serde_json::to_value(&h).unwrap();
        assert_eq!(
            json,
            serde_json::json!({"box": [0.1, 0.2, 0.6, 0.3], "at": 12, "dur": 24})
        );
        let back: Highlight = serde_json::from_value(json).unwrap();
        assert_eq!(back, h);
    }

    #[test]
    fn progress_is_zero_before_eased_between_and_one_after() {
        let h = hl([0.0, 0.0, 1.0, 1.0], 10, 20);
        assert_eq!(h.progress_at(9), 0.0);
        assert_eq!(h.progress_at(10), 0.0);
        let mid = h.progress_at(20);
        assert!(
            mid > 0.5 && mid < 1.0,
            "ease-out is ahead of linear at the midpoint: {mid}"
        );
        assert_eq!(h.progress_at(30), 1.0);
        assert_eq!(h.progress_at(500), 1.0);
    }

    #[test]
    fn a_zero_length_sweep_reveals_instantly() {
        let h = hl([0.0, 0.0, 1.0, 1.0], 10, 0);
        assert_eq!(h.progress_at(9), 0.0);
        assert_eq!(h.progress_at(10), 1.0);
    }

    #[test]
    fn nothing_to_draw_before_the_start_or_for_a_degenerate_box() {
        assert!(
            hl([0.1, 0.1, 0.5, 0.2], 10, 10)
                .sweep_at(9, 100, 100)
                .is_none()
        );
        assert!(
            hl([0.5, 0.1, 0.5, 0.2], 0, 10)
                .sweep_at(50, 100, 100)
                .is_none()
        );
        assert!(
            hl([f64::NAN, 0.1, 0.5, 0.2], 0, 10)
                .sweep_at(50, 100, 100)
                .is_none()
        );
        let mut zero = hl([0.1, 0.1, 0.5, 0.2], 0, 10);
        zero.opacity = Some(0.0);
        assert!(zero.sweep_at(50, 100, 100).is_none());
    }

    #[test]
    fn corners_are_ordered_and_clamped() {
        let h = hl([1.5, 0.5, -0.5, 0.25], 0, 0);
        assert_eq!(h.normalised_box(), Some([0.0, 0.25, 1.0, 0.5]));
    }

    #[test]
    fn the_pen_grows_from_the_hard_left_edge_to_the_box_right_edge() {
        let h = hl([0.1, 0.4, 0.9, 0.6], 0, 10);
        let done = h.sweep_at(10, 200, 100).unwrap();
        assert_eq!(
            (done.left, done.right, done.top, done.bottom),
            (20.0, 180.0, 40.0, 60.0)
        );
        let early = h.sweep_at(2, 200, 100).unwrap();
        assert!(early.right > early.left && early.right < done.right);
    }

    #[test]
    fn coverage_is_hard_on_the_left_and_rounded_on_the_leading_end() {
        let s = hl([0.1, 0.4, 0.9, 0.6], 0, 0)
            .sweep_at(0, 200, 100)
            .unwrap();
        // Hard left edge: the pixel just inside is fully covered, just outside nothing.
        assert_eq!(s.coverage(20, 50), 1.0);
        assert_eq!(s.coverage(19, 50), 0.0);
        // The square trailing corners are NOT rounded.
        assert_eq!(s.coverage(20, 40), 1.0);
        assert_eq!(s.coverage(20, 59), 1.0);
        // The leading corners are.
        assert!(s.coverage(179, 40) < 0.5);
        assert_eq!(s.coverage(179, 50), 1.0);
        assert_eq!(s.coverage(180, 50), 0.0);
    }

    #[test]
    fn pixel_bounds_contain_every_covered_pixel() {
        let s = hl([0.13, 0.31, 0.77, 0.52], 0, 0)
            .sweep_at(0, 120, 90)
            .unwrap();
        let (x0, y0, x1, y1) = s.pixel_bounds(120, 90);
        for y in 0..90 {
            for x in 0..120 {
                if s.coverage(x, y) > 0.0 {
                    assert!(
                        x >= x0 && x < x1 && y >= y0 && y < y1,
                        "({x},{y}) outside bounds"
                    );
                }
            }
        }
    }

    #[test]
    fn colour_parses_long_short_and_falls_back() {
        let mut h = hl([0.0, 0.0, 1.0, 1.0], 0, 0);
        assert_eq!(h.rgb(), [0xF2, 0xB6, 0x3A]);
        h.color = Some("#00ff80".into());
        assert_eq!(h.rgb(), [0, 255, 128]);
        h.color = Some("#f08".into());
        assert_eq!(h.rgb(), [255, 0, 136]);
        h.color = Some("not a colour".into());
        assert_eq!(h.rgb(), [0xF2, 0xB6, 0x3A]);
    }
}

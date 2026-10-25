//! Pixel-coverage shapes — the rounded-box signed distance field (D-344,
//! shared by D-396).
//!
//! **What it is:** [`rounded_box_coverage`], how much of one pixel a rounded
//! rectangle covers. **What it does NOT do:** no pixels are touched here, no
//! blending, no image type — callers multiply the returned coverage into
//! whatever they are drawing (a layer's alpha for a rounded clip corner, a
//! highlighter fill for a clip highlight). The ffmpeg exporter compiles the
//! identical formula into a `geq` expression (`timelineExport.ts`'s
//! `cornerRadiusMaskExpr` and `highlightCoverageExpr`); the two engines agree
//! because both are this one SDF, not because they are similar.

/// How much of the pixel whose top-left corner is `(x, y)` a `w`×`h` box
/// rounded to radius `r` covers: `1.0` well inside, `0.0` well outside, a
/// linear one-pixel ramp across the edge. All five arguments are in the box's
/// OWN pixel space (`(0, 0)` is its top-left).
///
/// This is the canonical `sdRoundedBox` (`q = |p| - (half - r)`,
/// `length(max(q, 0)) + min(max(q.x, q.y), 0) - r`), which needs no special
/// case on straight edges and is an exact identity at `r == 0`. `+ 0.5` on the
/// pixel centre and on the coverage threshold is the half-pixel convention that
/// makes the box span `0..w` rather than `0..w-1`. `r` is clamped to
/// `0 ..= min(w, h) / 2` at the point of use, so an over-large radius becomes a
/// pill or a circle rather than a degenerate shape.
pub fn rounded_box_coverage(x: f64, y: f64, w: f64, h: f64, r: f64) -> f32 {
    let r = r.max(0.0).min(w.min(h) / 2.0);
    let qx = (x + 0.5 - w / 2.0).abs() - (w / 2.0 - r);
    let qy = (y + 0.5 - h / 2.0).abs() - (h / 2.0 - r);
    let sd = qx.max(0.0).hypot(qy.max(0.0)) + qx.max(qy).min(0.0) - r;
    (0.5 - sd).clamp(0.0, 1.0) as f32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn square_box_covers_every_pixel_fully() {
        for y in 0..6 {
            for x in 0..8 {
                assert_eq!(rounded_box_coverage(x as f64, y as f64, 8.0, 6.0, 0.0), 1.0);
            }
        }
    }

    #[test]
    fn a_rounded_corner_pixel_is_cut_and_the_centre_is_not() {
        assert!(rounded_box_coverage(0.0, 0.0, 20.0, 20.0, 8.0) < 0.05);
        assert_eq!(rounded_box_coverage(10.0, 10.0, 20.0, 20.0, 8.0), 1.0);
    }

    #[test]
    fn a_pixel_outside_the_box_is_not_covered() {
        assert_eq!(rounded_box_coverage(-3.0, 2.0, 8.0, 6.0, 0.0), 0.0);
        assert_eq!(rounded_box_coverage(9.0, 2.0, 8.0, 6.0, 0.0), 0.0);
    }
}

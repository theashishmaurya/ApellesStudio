//! Per-clip fade in / fade out — the *envelope*, built out of
//! [`crate::ease::EaseCurve`]'s shape (D-147).
//!
//! **What it is:** the pure math behind `apelles_timeline::Clip`'s
//!   `fade_in_frames` / `fade_out_frames` / `fade_in_curve` / `fade_out_curve`.
//!   A fade is a multiplier in `0.0..=1.0` that ramps up over the clip's first
//!   `fade_in_frames` and down over its last `fade_out_frames`, each ramp
//!   shaped by an [`EaseCurve`].
//!
//! **What it does NOT do:** no I/O, no rendering, no media — same contract as
//!   the rest of this crate. It hands back a number; the two consumers decide
//!   what to multiply it into. `chroma::edit`'s compositor multiplies it into
//!   a clip's `opacity` (via `apelles_timeline::Clip::fade_multiplier_at`);
//!   `apelles_media::audio`'s mixer multiplies it into that clip's samples (via
//!   `FadeEnvelope`). See `docs/notes/audio-fade-duck-crossfade-plan.md` §2 for
//!   why one field pair drives both rather than separate video/audio fades.
//!
//! **It does not own the curve type any more** (D-233). [`EaseCurve`] moved to
//!   [`crate::ease`] once keyframe easing became its second consumer — a fade
//!   is an *envelope* (two windows over a clip's length, multiplied), the curve
//!   is the *shape* its ramps are drawn with, and neither is a kind of the
//!   other. Everything about the envelope is still here and unchanged; a
//!   `Clip`'s `fade_in_curve` is still the same four stored numbers it always
//!   was.
//!
//! **Why this is in `apelles-types` (L0) and not in `apelles-timeline` (L2),
//!   where `Clip` and its fade fields live.** It landed there first, in D-147's
//!   original single-consumer form. The second consumer is `apelles-media`'s
//!   audio mixer, which is **L1** — below the timeline model, and deliberately
//!   so ("no timeline model" is that crate's stated boundary, D-146). D-039's
//!   dependency graph is one-way, so L1 cannot reach up to L2 for the solver,
//!   and copying the bezier arithmetic into the mixer is exactly the
//!   duplication CLAUDE.md's "if two places need it, extract it" forbids. The
//!   only remaining move is down.
//!
//! **Unit-agnostic on purpose.** [`fade_gain`] takes `pos`, `len`, `fade_in`
//!   and `fade_out` in whatever unit the caller is working in: the compositor
//!   passes video frames, the audio mixer passes output *sample*-frames (so a
//!   fade steps per sample rather than per 1024-sample chunk, which would be
//!   audible zipper noise). Nothing here needs to know which.

use crate::ease::EaseCurve;

/// The fade multiplier at `pos` for a clip of length `len`, with fade windows
/// of `fade_in` at the head and `fade_out` at the tail — **all four in the
/// same unit**, whichever the caller is working in (see the module doc).
///
/// Returns exactly `1.0`, with no arithmetic at all, when neither window is
/// positive. That short-circuit is the backward-compatibility guarantee in
/// code: every clip in every existing project has `fade_in_frames == 0` and
/// `fade_out_frames == 0`, so this returns a value that multiplies to a no-op
/// and the render / mix paths are byte-identical to before D-147.
///
/// **Overlapping windows multiply rather than clamp.** If `fade_in +
/// fade_out > len` the two ramps overlap, and both apply — a 10-frame clip
/// with a 10-frame fade in *and* out is `0.5 × 0.5 = 0.25` in the middle: a
/// smooth dip, no discontinuity, no special case. That is well-defined for
/// every input and needs no clamping rule, and "the whole clip is a fade" is a
/// legitimate thing to author (a one-second stinger). Clamping each window to
/// `len` instead would silently move a handle the user placed.
///
/// The result is clamped to `0.0..=1.0`: `y1`/`y2` are deliberately
/// unclamped in storage (overshoot is legal in the curve model), but a
/// multiplier above unity would boost picture alpha past opaque and audio past
/// the source level, and one below zero would invert phase. See
/// [`EaseCurve::eval`] for why the clamp lives here.
pub fn fade_gain(
    pos: f64,
    len: f64,
    fade_in: f64,
    fade_out: f64,
    in_curve: &EaseCurve,
    out_curve: &EaseCurve,
) -> f64 {
    // A non-finite window is "no fade," not a panic and not a NaN gain — the
    // same "a malformed stored value degrades to the unset behaviour" posture
    // `parse_keyframes` takes for a malformed keyframe entry.
    let fade_in = if fade_in.is_finite() { fade_in } else { 0.0 };
    let fade_out = if fade_out.is_finite() { fade_out } else { 0.0 };
    if fade_in <= 0.0 && fade_out <= 0.0 {
        return 1.0; // the overwhelmingly common path — no fade, no work
    }
    if !pos.is_finite() || !len.is_finite() || len <= 0.0 {
        return 1.0;
    }
    let mut g = 1.0_f64;
    if fade_in > 0.0 && pos < fade_in {
        g *= in_curve.eval(pos / fade_in);
    }
    if fade_out > 0.0 {
        // Distance from the clip's out-point, normalised over the tail window.
        let from_end = len - pos;
        if from_end < fade_out {
            g *= out_curve.eval(from_end / fade_out);
        }
    }
    g.clamp(0.0, 1.0)
}

// --------------------------------------------------------------------------- //
// tests — the envelope over the curve (the curve's own math lives in `ease.rs`,
// and so do its tests)
// --------------------------------------------------------------------------- //

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-6
    }

    /// `y` overshoot is legal in storage but never escapes the envelope.
    #[test]
    fn y_overshoot_is_clamped_by_the_envelope_not_the_curve() {
        let overshoot = EaseCurve {
            x1: 0.3,
            y1: 2.0,
            x2: 0.7,
            y2: 2.0,
        };
        assert!(overshoot.eval(0.5) > 1.0, "the curve itself may overshoot");
        let g = fade_gain(50.0, 100.0, 100.0, 0.0, &overshoot, &EaseCurve::LINEAR);
        assert!((0.0..=1.0).contains(&g), "the envelope must clamp, got {g}");
    }
    // --- envelope ---------------------------------------------------------- //

    /// **The backward-compatibility case.** A clip with no fade configured —
    /// which is every clip in every project that existed before D-147 — must
    /// yield exactly `1.0`, the multiplicative identity, at every position.
    #[test]
    fn no_fade_configured_is_exactly_one_everywhere() {
        for pos in [-10.0, 0.0, 1.0, 50.0, 99.0, 100.0, 1e9] {
            let g = fade_gain(pos, 100.0, 0.0, 0.0, &EaseCurve::LINEAR, &EaseCurve::LINEAR);
            assert_eq!(g, 1.0, "pos {pos} gave {g}, must be exactly 1.0");
        }
        // negative / nonsense fade lengths are "no fade" too, not a panic
        assert_eq!(
            fade_gain(
                5.0,
                100.0,
                -3.0,
                -1.0,
                &EaseCurve::LINEAR,
                &EaseCurve::LINEAR
            ),
            1.0
        );
    }

    /// **Full fade to zero at the boundary.** The first frame of a fade-in is
    /// silent/transparent and the last frame of a fade-out is too — the
    /// property that makes a fade actually reach the ends.
    #[test]
    fn fade_reaches_exactly_zero_at_both_boundaries() {
        let lin = EaseCurve::LINEAR;
        // fade-in: pos 0 of a 100-frame clip with a 25-frame head fade
        assert_eq!(fade_gain(0.0, 100.0, 25.0, 0.0, &lin, &lin), 0.0);
        // fade-out: the out-point itself (pos == len)
        assert_eq!(fade_gain(100.0, 100.0, 0.0, 25.0, &lin, &lin), 0.0);
        // and for every preset, not just linear
        for c in [
            EaseCurve::EASE_IN,
            EaseCurve::EASE_OUT,
            EaseCurve::EASE_IN_OUT,
        ] {
            assert_eq!(fade_gain(0.0, 100.0, 25.0, 0.0, &c, &c), 0.0, "{c:?}");
            assert_eq!(fade_gain(100.0, 100.0, 0.0, 25.0, &c, &c), 0.0, "{c:?}");
        }
    }

    /// A linear fade is a straight ramp at real, checkable intermediate
    /// positions, and unity everywhere outside both windows.
    #[test]
    fn linear_fade_ramps_and_holds_unity_in_the_middle() {
        let lin = EaseCurve::LINEAR;
        let g = |pos: f64| fade_gain(pos, 100.0, 20.0, 20.0, &lin, &lin);
        assert!(close(g(5.0), 0.25));
        assert!(close(g(10.0), 0.5));
        assert!(close(g(15.0), 0.75));
        assert!(close(g(20.0), 1.0));
        assert!(close(g(50.0), 1.0)); // clear of both windows
        assert!(close(g(80.0), 1.0));
        assert!(close(g(90.0), 0.5));
        assert!(close(g(95.0), 0.25));
    }

    /// Overlapping windows multiply — a documented, well-defined outcome
    /// rather than a clamp that would move a handle the user placed.
    #[test]
    fn overlapping_windows_multiply() {
        let lin = EaseCurve::LINEAR;
        // a 10-unit clip fading fully in AND fully out
        let mid = fade_gain(5.0, 10.0, 10.0, 10.0, &lin, &lin);
        assert!(close(mid, 0.25), "expected 0.5*0.5, got {mid}");
        // still monotonic-to-the-middle and symmetric
        assert!(close(
            fade_gain(2.0, 10.0, 10.0, 10.0, &lin, &lin),
            fade_gain(8.0, 10.0, 10.0, 10.0, &lin, &lin)
        ));
    }

    /// Positions outside the clip clamp to the ends rather than extrapolating
    /// past them — a mid-clip Play whose envelope offset overruns, or a
    /// rounding step past the out-point, must not produce a gain above 1 or
    /// below 0.
    #[test]
    fn positions_outside_the_clip_clamp() {
        let lin = EaseCurve::LINEAR;
        assert_eq!(fade_gain(-5.0, 100.0, 20.0, 20.0, &lin, &lin), 0.0);
        assert_eq!(fade_gain(105.0, 100.0, 20.0, 20.0, &lin, &lin), 0.0);
    }
}

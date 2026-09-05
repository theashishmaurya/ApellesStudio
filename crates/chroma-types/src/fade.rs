//! Per-clip fade in / fade out, with real cubic-bezier curve shaping (D-147).
//!
//! **What it is:** the pure math behind `chroma_timeline::Clip`'s
//!   `fade_in_frames` / `fade_out_frames` / `fade_in_curve` / `fade_out_curve`.
//!   A fade is a multiplier in `0.0..=1.0` that ramps up over the clip's first
//!   `fade_in_frames` and down over its last `fade_out_frames`, shaped by a
//!   [`FadeCurve`] — the same `cubic-bezier(x1, y1, x2, y2)` model CSS
//!   transitions and After Effects keyframe easing use (`P0 = (0,0)` and
//!   `P3 = (1,1)` fixed, two free control-point handles).
//!
//! **What it does NOT do:** no I/O, no rendering, no media — same contract as
//!   the rest of this crate. It hands back a number; the two consumers decide
//!   what to multiply it into. `chroma::edit`'s compositor multiplies it into
//!   a clip's `opacity` (via `chroma_timeline::Clip::fade_multiplier_at`);
//!   `chroma_media::audio`'s mixer multiplies it into that clip's samples (via
//!   `FadeEnvelope`). See `docs/notes/audio-fade-duck-crossfade-plan.md` §2 for
//!   why one field pair drives both rather than separate video/audio fades.
//!
//! **Why this is in `chroma-types` (L0) and not in `chroma-timeline` (L2),
//!   where `Clip` and its fade fields live.** It landed there first, in D-147's
//!   original single-consumer form. The second consumer is `chroma-media`'s
//!   audio mixer, which is **L1** — below the timeline model, and deliberately
//!   so ("no timeline model" is that crate's stated boundary, D-146). D-039's
//!   dependency graph is one-way, so L1 cannot reach up to L2 for the solver,
//!   and copying the bezier arithmetic into the mixer is exactly the
//!   duplication CLAUDE.md's "if two places need it, extract it" forbids. The
//!   only remaining move is down: this module has no dependency of its own
//!   beyond `serde`, and [`FadeCurve`] is a shared value type in precisely the
//!   sense `Resolution` and `Rational` are. `chroma-timeline` re-exports both
//!   names, so nothing that already said `chroma_timeline::FadeCurve` changed.
//!
//! **Why the math is here and not in `chroma::keyframes` (D-034).** That
//!   engine is strictly linear (`lerp_value`; its only non-linear cases are
//!   `rotation`'s shortest arc and a nearest-key *snap*) and it interpolates
//!   between two *authored keys* in an untyped JSON map, in the
//!   `app/src-tauri` layer. A fade curve has no keys, interpolates within one
//!   clip's own window, and is needed by consumers on two crate layers below
//!   the app. Easing the D-034 engine itself would change how every existing
//!   mask and relight keyframe interpolates and is deliberately untouched.
//!
//! **Unit-agnostic on purpose.** [`fade_gain`] takes `pos`, `len`, `fade_in`
//!   and `fade_out` in whatever unit the caller is working in: the compositor
//!   passes video frames, the audio mixer passes output *sample*-frames (so a
//!   fade steps per sample rather than per 1024-sample chunk, which would be
//!   audible zipper noise). Nothing here needs to know which.

use serde::{Deserialize, Serialize};

/// A `cubic-bezier(x1, y1, x2, y2)` easing curve — the CSS / After Effects
/// model, with `P0 = (0,0)` and `P3 = (1,1)` implicit.
///
/// `x` is normalised progress through the fade window, `y` the multiplier at
/// that progress. Stored as four plain numbers, **with no preset name**: the
/// control points are the only truth, and the UI matches a stored curve back
/// to a preset label for display (see [`FadeCurve::preset_name`]). Storing a
/// name alongside the points would be two sources of truth that disagree the
/// moment a custom curve is authored.
///
/// `#[serde(default)]` on the `Clip` fields that hold these resolves a missing
/// key to [`FadeCurve::linear`] — a straight ramp, the only shape a user can
/// predict without opening a curve editor.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FadeCurve {
    pub x1: f64,
    pub y1: f64,
    pub x2: f64,
    pub y2: f64,
}

impl Default for FadeCurve {
    /// Manual, not `#[derive(Default)]`: the type's zero value
    /// (`0,0,0,0`) is a real, badly-behaved curve (a vertical start tangent
    /// AND a flat finish), not "no curve." Same reason `Clip` carries a manual
    /// `Default` for `opacity`/`scale`.
    fn default() -> Self {
        Self::LINEAR
    }
}

impl FadeCurve {
    /// The exact identity, `y = x`.
    ///
    /// **`1/3, 2/3` rather than CSS's own `linear` = `(0, 0, 1, 1)`, and the
    /// reason is numeric, not geometric.** *Any* pair of control points lying
    /// on the `y = x` diagonal produces the straight line — `(0,0,1,1)` and
    /// `(1/3,1/3,2/3,2/3)` trace exactly the same curve, they differ only in
    /// how `t` is distributed along it. (This is worth stating precisely
    /// because the intuition that one of them must be an S-curve is wrong, and
    /// [`tests::linear_is_the_exact_identity`] asserts both are the identity so
    /// nobody re-derives the wrong version of that intuition.)
    ///
    /// What `1/3, 2/3` buys is the **uniform** parameterisation: with
    /// `P0 = 0`, `P3 = 1` the cubic is `B(t) = 3(1-t)²t·P1 + 3(1-t)t²·P2 + t³`,
    /// and substituting `P1 = 1/3, P2 = 2/3` collapses it to exactly
    /// `B(t) = t`. So `x(t) = t`, [`solve_t_for_x`]'s initial guess `t = x` is
    /// already the exact root, and the default curve — the one every un-set
    /// fade in the app evaluates, per output sample-frame — costs one Newton
    /// residual check and exits. CSS's `(0,0,1,1)` has `x'(0) = 0`, a
    /// degenerate tangent that puts the solver on its bisection path near the
    /// start of every fade. Same line, cheaper and better-conditioned.
    pub const LINEAR: Self = Self {
        x1: 1.0 / 3.0,
        y1: 1.0 / 3.0,
        x2: 2.0 / 3.0,
        y2: 2.0 / 3.0,
    };
    /// CSS `ease-in` — slow start, fast finish. For an *audio* fade-in this
    /// tracks perceived loudness better than [`Self::LINEAR`] does, because
    /// loudness is roughly logarithmic in amplitude (see the plan doc §2 —
    /// stated rather than silently applied, so one stored number never means
    /// two different things for picture and sound).
    pub const EASE_IN: Self = Self {
        x1: 0.42,
        y1: 0.0,
        x2: 1.0,
        y2: 1.0,
    };
    /// CSS `ease-out` — fast start, slow finish.
    pub const EASE_OUT: Self = Self {
        x1: 0.0,
        y1: 0.0,
        x2: 0.58,
        y2: 1.0,
    };
    /// CSS `ease-in-out` — the symmetric S.
    pub const EASE_IN_OUT: Self = Self {
        x1: 0.42,
        y1: 0.0,
        x2: 0.58,
        y2: 1.0,
    };

    /// The named preset this curve exactly matches, or `None` for a custom
    /// one. Display only — nothing in the evaluation path calls it.
    ///
    /// Exact equality, not an epsilon: these values come from the preset
    /// constants themselves (round-tripped through JSON, which preserves
    /// `f64` bit-for-bit for these), so "the user picked ease-in" really is
    /// the exact literal — the same reasoning `ClipTransform::is_identity`
    /// uses for its own exact comparisons.
    pub fn preset_name(&self) -> Option<&'static str> {
        match *self {
            Self::LINEAR => Some("linear"),
            Self::EASE_IN => Some("ease-in"),
            Self::EASE_OUT => Some("ease-out"),
            Self::EASE_IN_OUT => Some("ease-in-out"),
            _ => None,
        }
    }

    /// Resolve a preset name (`"linear"`, `"ease-in"`, `"ease-out"`,
    /// `"ease-in-out"`, and `"ease"` for CSS's own default) to its control
    /// points. `None` for anything else — callers (the MCP op) report the
    /// unknown name rather than silently substituting a curve.
    pub fn from_preset_name(name: &str) -> Option<Self> {
        match name {
            "linear" => Some(Self::LINEAR),
            "ease-in" => Some(Self::EASE_IN),
            "ease-out" => Some(Self::EASE_OUT),
            "ease-in-out" => Some(Self::EASE_IN_OUT),
            // CSS's own `ease`, offered because a caller coming from CSS will
            // reach for it; deliberately not in `preset_name`'s reverse map or
            // the Inspector's list, which stay the four the UI actually shows.
            "ease" => Some(Self {
                x1: 0.25,
                y1: 0.1,
                x2: 0.25,
                y2: 1.0,
            }),
            _ => None,
        }
    }

    /// `y` at normalised progress `x` — the multiplier this curve gives
    /// `x` of the way through a fade window.
    ///
    /// **The real work is the inverse solve.** The curve is parametric: both
    /// `x` and `y` are functions of a hidden parameter `t`. We are handed `x`,
    /// so we must first solve `x(t) = x` for `t`, then evaluate `y(t)`.
    /// (De Casteljau's algorithm evaluates a bezier *at a given `t`* and so
    /// does not answer this question on its own — it would still need
    /// wrapping in a search, at which point the search is the algorithm.)
    ///
    /// Newton–Raphson on `x(t) - x` with the analytic derivative, capped at
    /// [`NEWTON_ITERATIONS`], falling through to bisection when the derivative
    /// is too small to trust or Newton escapes `[0, 1]` — WebKit's
    /// `UnitBezier`, which is what browsers actually ship for CSS easing.
    /// Newton converges in ~4 iterations on ordinary curves; bisection
    /// guarantees termination and a bounded error for pathological control
    /// points (`x1 == x2 == 0` gives a vertical start tangent where
    /// `x'(0) == 0`, and Newton alone would divide by ~zero there).
    ///
    /// **Deterministic** (a project invariant): pure `f64`, fixed iteration
    /// caps, an epsilon exit that depends only on the inputs. No wall clock,
    /// no RNG, no iteration-order dependence.
    ///
    /// `x1`/`x2` are clamped to `0.0..=1.0` **here, at the point of use** — a
    /// control point outside that range makes `x(t)` non-monotonic, and then
    /// the inverse is not unique and the solve is meaningless. `y1`/`y2` are
    /// deliberately NOT clamped (CSS allows overshoot, and a future "bounce"
    /// curve is a legitimate thing to want); the *final* multiplier is clamped
    /// by [`fade_gain`] instead. Same "the model stores what the UI wrote, the
    /// consumer decides what it means" discipline `Clip::crop_left` documents.
    pub fn eval(&self, x: f64) -> f64 {
        if !x.is_finite() {
            return 1.0;
        }
        let x = x.clamp(0.0, 1.0);
        // Exact at both ends regardless of the handles — P0 and P3 are fixed,
        // and short-circuiting here also keeps the `x1 == x2 == 0` /
        // `x1 == x2 == 1` degenerate tangents out of the solver entirely.
        if x <= 0.0 {
            return 0.0;
        }
        if x >= 1.0 {
            return 1.0;
        }
        let x1 = self.x1.clamp(0.0, 1.0);
        let x2 = self.x2.clamp(0.0, 1.0);
        let t = solve_t_for_x(x, x1, x2);
        bezier(t, self.y1, self.y2)
    }
}

/// Newton–Raphson iteration cap. Eight is WebKit's own number: ordinary
/// curves converge in about four, and past eight the bisection fallback is
/// strictly the better use of the remaining budget.
const NEWTON_ITERATIONS: usize = 8;
/// Bisection iteration cap — `2^-32` of the unit interval, far below any
/// difference a sample or a pixel can represent.
const BISECTION_ITERATIONS: usize = 32;
/// Convergence tolerance on `x`, and the floor below which a derivative is
/// treated as untrustworthy for a Newton step.
const EPSILON: f64 = 1e-7;

/// `B(t)` for a cubic bezier with `P0 = 0`, `P3 = 1` and the two given
/// control-point coordinates on one axis.
fn bezier(t: f64, p1: f64, p2: f64) -> f64 {
    let mt = 1.0 - t;
    3.0 * mt * mt * t * p1 + 3.0 * mt * t * t * p2 + t * t * t
}

/// `dB/dt` for [`bezier`] — the analytic derivative Newton needs.
fn bezier_slope(t: f64, p1: f64, p2: f64) -> f64 {
    let mt = 1.0 - t;
    3.0 * mt * mt * p1 + 6.0 * mt * t * (p2 - p1) + 3.0 * t * t * (1.0 - p2)
}

/// Solve `x(t) == x` for `t ∈ [0,1]`. `x1`/`x2` are already clamped by the
/// caller, so `x(t)` is monotonic and the root is unique.
fn solve_t_for_x(x: f64, x1: f64, x2: f64) -> f64 {
    // Newton–Raphson from `t = x`, which is the exact answer for a linear
    // curve and a good guess for every other one.
    let mut t = x;
    for _ in 0..NEWTON_ITERATIONS {
        let err = bezier(t, x1, x2) - x;
        if err.abs() < EPSILON {
            return t;
        }
        let slope = bezier_slope(t, x1, x2);
        if slope.abs() < EPSILON {
            break; // flat here — Newton would divide by ~zero
        }
        let next = t - err / slope;
        if !(0.0..=1.0).contains(&next) {
            break; // escaped the unit interval — bisection is safe, Newton isn't
        }
        t = next;
    }

    // Guaranteed-terminating fallback over the whole interval (not around
    // Newton's last guess, which may be exactly the bad point that got us
    // here).
    let (mut lo, mut hi) = (0.0_f64, 1.0_f64);
    let mut t = x;
    for _ in 0..BISECTION_ITERATIONS {
        let err = bezier(t, x1, x2) - x;
        if err.abs() < EPSILON {
            return t;
        }
        if err > 0.0 {
            hi = t;
        } else {
            lo = t;
        }
        t = (lo + hi) / 2.0;
    }
    t
}

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
/// [`FadeCurve::eval`] for why the clamp lives here.
pub fn fade_gain(
    pos: f64,
    len: f64,
    fade_in: f64,
    fade_out: f64,
    in_curve: &FadeCurve,
    out_curve: &FadeCurve,
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
// tests — pure curve + envelope math, no I/O, parallel-safe
// --------------------------------------------------------------------------- //

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-6
    }

    /// `linear` must be `y = x` exactly, at every `x` — it is the default
    /// every un-set fade uses, so a curve that merely *looks* straight would
    /// be a silent, invisible defect.
    ///
    /// Also pins the geometric fact `LINEAR`'s own doc turns on: CSS's
    /// `(0,0,1,1)` traces the *same* line, because both its control points sit
    /// on the diagonal too. The two differ only in parameterisation (which is
    /// the real, numeric reason we ship `1/3, 2/3`), not in shape — asserted
    /// here so the wrong intuition ("one of them must be an S") can't be
    /// re-derived into the constant later.
    #[test]
    fn linear_is_the_exact_identity() {
        let css_linear = FadeCurve {
            x1: 0.0,
            y1: 0.0,
            x2: 1.0,
            y2: 1.0,
        };
        for i in 0..=8 {
            let x = i as f64 / 8.0;
            let y = FadeCurve::LINEAR.eval(x);
            assert!(close(y, x), "linear at x={x} gave {y}, expected {x}");
            assert!(
                close(css_linear.eval(x), x),
                "css (0,0,1,1) at x={x} gave {} — it is the same line",
                css_linear.eval(x)
            );
        }
        // A control point genuinely OFF the diagonal is genuinely not linear —
        // so this test would actually catch a wrong constant.
        let off_diagonal = FadeCurve {
            x1: 0.0,
            y1: 0.5,
            x2: 1.0,
            y2: 0.5,
        };
        assert!(!close(off_diagonal.eval(0.25), 0.25));
    }

    /// Every curve pins both endpoints — `P0`/`P3` are fixed by the model.
    #[test]
    fn every_curve_pins_both_endpoints() {
        for c in [
            FadeCurve::LINEAR,
            FadeCurve::EASE_IN,
            FadeCurve::EASE_OUT,
            FadeCurve::EASE_IN_OUT,
            FadeCurve {
                x1: 0.9,
                y1: 0.05,
                x2: 0.1,
                y2: 0.95,
            },
        ] {
            assert_eq!(c.eval(0.0), 0.0, "{c:?} at 0");
            assert_eq!(c.eval(1.0), 1.0, "{c:?} at 1");
        }
    }

    /// Known control points → known values. `ease-in-out` is symmetric about
    /// its midpoint by construction (`x1 = 1 - x2`, `y1 = 1 - y2`), so
    /// `y(0.5) == 0.5` exactly, and `y(x) == 1 - y(1-x)` everywhere.
    #[test]
    fn ease_in_out_is_symmetric_about_its_midpoint() {
        assert!(close(FadeCurve::EASE_IN_OUT.eval(0.5), 0.5));
        for i in 1..10 {
            let x = i as f64 / 10.0;
            let a = FadeCurve::EASE_IN_OUT.eval(x);
            let b = FadeCurve::EASE_IN_OUT.eval(1.0 - x);
            assert!(close(a, 1.0 - b), "x={x}: {a} vs 1-{b}");
        }
    }

    /// `ease-in` starts below the diagonal (slow start), `ease-out` above it
    /// (fast start) — the defining property of each, checked as a real
    /// numeric comparison rather than trusting the label.
    #[test]
    fn ease_in_is_slow_at_the_start_and_ease_out_is_fast() {
        for i in 1..10 {
            let x = i as f64 / 10.0;
            assert!(
                FadeCurve::EASE_IN.eval(x) < x,
                "ease-in at {x} not below the diagonal"
            );
            assert!(
                FadeCurve::EASE_OUT.eval(x) > x,
                "ease-out at {x} not above the diagonal"
            );
        }
    }

    /// The exact CSS reference value for `ease-in` at the midpoint, computed
    /// independently: solve `x(t) = 0.5` for `cubic-bezier(0.42, 0, 1, 1)`,
    /// then evaluate `y(t)`. Pins the solver against a fixed number rather
    /// than only against shape properties.
    #[test]
    fn ease_in_midpoint_matches_an_independently_computed_value() {
        // x(t) = 3(1-t)²t(0.42) + 3(1-t)t²(1) + t³ ; solved numerically for
        // x = 0.5 by plain bisection here, deliberately NOT via solve_t_for_x
        // (a test that reused the implementation would prove nothing).
        let (mut lo, mut hi) = (0.0_f64, 1.0_f64);
        for _ in 0..200 {
            let t = (lo + hi) / 2.0;
            if bezier(t, 0.42, 1.0) < 0.5 {
                lo = t
            } else {
                hi = t
            }
        }
        let t = (lo + hi) / 2.0;
        let expected = bezier(t, 0.0, 1.0);
        assert!(
            close(FadeCurve::EASE_IN.eval(0.5), expected),
            "got {}, expected {expected}",
            FadeCurve::EASE_IN.eval(0.5)
        );
    }

    /// Pathological handles the Newton step cannot survive alone: a vertical
    /// start tangent (`x1 == x2 == 0`, slope zero at t=0) and a vertical
    /// finish (`x1 == x2 == 1`). Must still return a finite, monotonic,
    /// in-range curve via the bisection fallback.
    #[test]
    fn degenerate_handles_fall_back_to_bisection_and_stay_sane() {
        for c in [
            FadeCurve {
                x1: 0.0,
                y1: 0.0,
                x2: 0.0,
                y2: 1.0,
            },
            FadeCurve {
                x1: 1.0,
                y1: 0.0,
                x2: 1.0,
                y2: 1.0,
            },
            FadeCurve {
                x1: 0.0,
                y1: 1.0,
                x2: 1.0,
                y2: 0.0,
            },
        ] {
            // Every control value is inside [0,1] for these, so the bezier's
            // convex-hull property says the output must be too — a real
            // property to assert, not just "didn't panic".
            for i in 0..=20 {
                let y = c.eval(i as f64 / 20.0);
                assert!(y.is_finite(), "{c:?} produced {y}");
                assert!((0.0..=1.0).contains(&y), "{c:?} produced {y}");
            }
        }
    }

    /// `x1`/`x2` outside `[0,1]` are clamped rather than producing a
    /// non-monotonic `x(t)` with no unique inverse.
    #[test]
    fn out_of_range_x_handles_are_clamped_not_trusted() {
        let wild = FadeCurve {
            x1: -5.0,
            y1: 0.0,
            x2: 9.0,
            y2: 1.0,
        };
        let clamped = FadeCurve {
            x1: 0.0,
            y1: 0.0,
            x2: 1.0,
            y2: 1.0,
        };
        for i in 0..=10 {
            let x = i as f64 / 10.0;
            assert!(close(wild.eval(x), clamped.eval(x)), "at x={x}");
        }
    }

    /// `y` overshoot is legal in storage but never escapes the envelope.
    #[test]
    fn y_overshoot_is_clamped_by_the_envelope_not_the_curve() {
        let overshoot = FadeCurve {
            x1: 0.3,
            y1: 2.0,
            x2: 0.7,
            y2: 2.0,
        };
        assert!(overshoot.eval(0.5) > 1.0, "the curve itself may overshoot");
        let g = fade_gain(50.0, 100.0, 100.0, 0.0, &overshoot, &FadeCurve::LINEAR);
        assert!((0.0..=1.0).contains(&g), "the envelope must clamp, got {g}");
    }

    // --- envelope ---------------------------------------------------------- //

    /// **The backward-compatibility case.** A clip with no fade configured —
    /// which is every clip in every project that existed before D-147 — must
    /// yield exactly `1.0`, the multiplicative identity, at every position.
    #[test]
    fn no_fade_configured_is_exactly_one_everywhere() {
        for pos in [-10.0, 0.0, 1.0, 50.0, 99.0, 100.0, 1e9] {
            let g = fade_gain(pos, 100.0, 0.0, 0.0, &FadeCurve::LINEAR, &FadeCurve::LINEAR);
            assert_eq!(g, 1.0, "pos {pos} gave {g}, must be exactly 1.0");
        }
        // negative / nonsense fade lengths are "no fade" too, not a panic
        assert_eq!(
            fade_gain(
                5.0,
                100.0,
                -3.0,
                -1.0,
                &FadeCurve::LINEAR,
                &FadeCurve::LINEAR
            ),
            1.0
        );
    }

    /// **Full fade to zero at the boundary.** The first frame of a fade-in is
    /// silent/transparent and the last frame of a fade-out is too — the
    /// property that makes a fade actually reach the ends.
    #[test]
    fn fade_reaches_exactly_zero_at_both_boundaries() {
        let lin = FadeCurve::LINEAR;
        // fade-in: pos 0 of a 100-frame clip with a 25-frame head fade
        assert_eq!(fade_gain(0.0, 100.0, 25.0, 0.0, &lin, &lin), 0.0);
        // fade-out: the out-point itself (pos == len)
        assert_eq!(fade_gain(100.0, 100.0, 0.0, 25.0, &lin, &lin), 0.0);
        // and for every preset, not just linear
        for c in [
            FadeCurve::EASE_IN,
            FadeCurve::EASE_OUT,
            FadeCurve::EASE_IN_OUT,
        ] {
            assert_eq!(fade_gain(0.0, 100.0, 25.0, 0.0, &c, &c), 0.0, "{c:?}");
            assert_eq!(fade_gain(100.0, 100.0, 0.0, 25.0, &c, &c), 0.0, "{c:?}");
        }
    }

    /// A linear fade is a straight ramp at real, checkable intermediate
    /// positions, and unity everywhere outside both windows.
    #[test]
    fn linear_fade_ramps_and_holds_unity_in_the_middle() {
        let lin = FadeCurve::LINEAR;
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
        let lin = FadeCurve::LINEAR;
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
        let lin = FadeCurve::LINEAR;
        assert_eq!(fade_gain(-5.0, 100.0, 20.0, 20.0, &lin, &lin), 0.0);
        assert_eq!(fade_gain(105.0, 100.0, 20.0, 20.0, &lin, &lin), 0.0);
    }

    /// Preset names round-trip, and an unknown one is reported rather than
    /// silently substituted.
    #[test]
    fn preset_names_round_trip() {
        for name in ["linear", "ease-in", "ease-out", "ease-in-out"] {
            let c = FadeCurve::from_preset_name(name).expect(name);
            assert_eq!(c.preset_name(), Some(name));
        }
        assert!(FadeCurve::from_preset_name("bounce").is_none());
        assert!(FadeCurve::from_preset_name("ease").is_some());
        // a custom curve has no preset name
        assert_eq!(
            FadeCurve {
                x1: 0.1,
                y1: 0.2,
                x2: 0.3,
                y2: 0.4
            }
            .preset_name(),
            None
        );
    }

    /// `Default` is `linear`, not the type's zero value (which is a real,
    /// badly-behaved curve).
    #[test]
    fn default_is_linear_not_zeroes() {
        assert_eq!(FadeCurve::default(), FadeCurve::LINEAR);
        assert_ne!(
            FadeCurve::default(),
            FadeCurve {
                x1: 0.0,
                y1: 0.0,
                x2: 0.0,
                y2: 0.0
            }
        );
    }

    /// Determinism (a project invariant): the same inputs give bit-identical
    /// output every call, including through the bisection fallback.
    #[test]
    fn evaluation_is_bit_deterministic() {
        let curves = [
            FadeCurve::EASE_IN_OUT,
            FadeCurve {
                x1: 0.0,
                y1: 0.0,
                x2: 0.0,
                y2: 1.0,
            },
        ];
        for c in curves {
            for i in 0..=50 {
                let x = i as f64 / 50.0;
                assert_eq!(c.eval(x).to_bits(), c.eval(x).to_bits(), "{c:?} at {x}");
            }
        }
    }

    /// Serde: a `FadeCurve` round-trips through JSON in the camelCase shape
    /// the frontend and MCP speak.
    #[test]
    fn serde_round_trip_is_camel_case() {
        let json = serde_json::to_string(&FadeCurve::EASE_IN).unwrap();
        assert!(json.contains("\"x1\""), "{json}");
        let back: FadeCurve = serde_json::from_str(&json).unwrap();
        assert_eq!(back, FadeCurve::EASE_IN);
    }
}

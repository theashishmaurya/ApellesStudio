/**
 * @apelles/editor — the cubic-bezier easing curve solver, in TypeScript
 * (D-233; the solver itself is D-147's, extracted here from
 * `timelineExportAudio.ts` where it lived when a fade was its only caller).
 *
 * What it is: an exact, field-for-field mirror of `apelles_types::ease`
 * (Rust) — the `cubic-bezier(x1,y1,x2,y2)` model CSS transitions and After
 * Effects keyframe easing use, with `P0 = (0,0)` and `P3 = (1,1)` implicit.
 * Given normalised progress `x`, solve `x(t) = x` for the hidden parameter
 * `t` (Newton–Raphson from `t = x`, falling through to bisection), then
 * evaluate `y(t)`.
 *
 * What it does NOT do: it has no idea what it is easing. It has no notion of
 * a fade window, a keyframe, a clip or a value range. Three callers give it
 * those meanings:
 *   - `timelineExportAudio.ts`'s `fadeGainAt` — progress through a fade
 *     window → that window's gain multiplier.
 *   - `clipKeyframes.ts`'s `paramValueAt` — progress between two of one
 *     property's keyframes → how far through the value change we are
 *     (D-233's actual feature).
 *   - `curveEditor.ts` — the same numbers, drawn.
 *
 * **Why this file exists rather than a second copy.** The solve was written
 * once, inside the audio exporter, because a fade was the only thing shaped
 * by a curve. D-233 gives the same curve a second, completely unrelated
 * consumer (keyframe easing, which the *authoring* layer needs — and
 * `clipKeyframes.ts` importing an interpolator out of an ffmpeg export module
 * would be exactly the wrong dependency direction). That is the "if two
 * places need it, extract it" case CLAUDE.md names, and the same move D-197
 * already made for `ffmpegExpr.ts`.
 *
 * **Why a TS mirror of Rust maths at all** — the same reason `clipKeyframes
 * .ts`, `timelineExportAudio.ts` and `eq.ts` each already carry one: the
 * render path resolves its own values in Rust, but the exporter compiles
 * ffmpeg expressions and the UI has to draw and hit-test the very curve the
 * renderer will apply. A mirror that drifts is the B-090/B-094/B-095 bug
 * class, so this file is pinned to its Rust counterpart by
 * `easeCurve.test.ts`'s shared fixture vectors rather than by good intentions.
 *
 * Pure, no I/O, no React.
 */

import type { EaseCurve } from './timeline';

/** Newton-Raphson iteration cap — mirrors `apelles_types::ease::
 *  NEWTON_ITERATIONS` (WebKit's own number, see that constant's own doc). */
const NEWTON_ITERATIONS = 8;
/** Bisection fallback cap — mirrors `apelles_types::ease::BISECTION_ITERATIONS`. */
const BISECTION_ITERATIONS = 32;
/** Convergence tolerance — mirrors `apelles_types::ease::EPSILON`. */
const EPSILON = 1e-7;

/** `B(t)` for a cubic bezier with `P0 = 0`, `P3 = 1` and the two given
 *  control-point coordinates on one axis. Exported because the curve editor
 *  draws the curve by evaluating it, and a second copy of three lines of
 *  bezier arithmetic in a `.tsx` file is how mirrors start to drift. */
export function bezier(t: number, p1: number, p2: number): number {
  const mt = 1 - t;
  return 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t;
}

/** `dB/dt` for [`bezier`] — the analytic derivative Newton needs. */
function bezierSlope(t: number, p1: number, p2: number): number {
  const mt = 1 - t;
  return 3 * mt * mt * p1 + 6 * mt * t * (p2 - p1) + 3 * t * t * (1 - p2);
}

/** Solve `x(t) == x` for `t ∈ [0,1]`; `x1`/`x2` already clamped by the caller,
 *  so `x(t)` is monotonic and the root is unique. */
function solveTForX(x: number, x1: number, x2: number): number {
  let t = x;
  for (let i = 0; i < NEWTON_ITERATIONS; i++) {
    const err = bezier(t, x1, x2) - x;
    if (Math.abs(err) < EPSILON) return t;
    const slope = bezierSlope(t, x1, x2);
    if (Math.abs(slope) < EPSILON) break;
    const next = t - err / slope;
    if (next < 0 || next > 1) break;
    t = next;
  }
  let lo = 0;
  let hi = 1;
  t = x;
  for (let i = 0; i < BISECTION_ITERATIONS; i++) {
    const err = bezier(t, x1, x2) - x;
    if (Math.abs(err) < EPSILON) return t;
    if (err > 0) hi = t;
    else lo = t;
    t = (lo + hi) / 2;
  }
  return t;
}

/**
 * `y` at normalised progress `x` — mirrors `apelles_types::EaseCurve::eval`
 * field-for-field (same clamping, same short-circuit at the exact endpoints,
 * same Newton-then-bisection solve).
 *
 * **Both endpoints are pinned exactly**, whatever the handles say: `eval(0)`
 * is `0` and `eval(1)` is `1`. That is what makes easing safe to apply to a
 * keyframe segment — no curve can move the keyframes it runs between.
 *
 * `x1`/`x2` are clamped to `[0,1]` here, at the point of use, because a
 * control point outside that range makes `x(t)` non-monotonic and the inverse
 * is then not unique. `y1`/`y2` are deliberately NOT clamped: overshoot is
 * legal in this model (an anticipation/bounce ease is a real thing to author,
 * and CSS allows it), and each consumer decides whether the *result* needs
 * clamping — `fade_gain` clamps its multiplier, a keyframed position does not
 * want clamping at all.
 */
export function easeCurveEval(curve: EaseCurve, x: number): number {
  if (!Number.isFinite(x)) return 1;
  const xc = Math.min(1, Math.max(0, x));
  if (xc <= 0) return 0;
  if (xc >= 1) return 1;
  const x1 = Math.min(1, Math.max(0, curve.x1));
  const x2 = Math.min(1, Math.max(0, curve.x2));
  const t = solveTForX(xc, x1, x2);
  return bezier(t, curve.y1, curve.y2);
}

/** Is `curve` the identity (`y = x`), i.e. does easing by it change nothing?
 *
 *  Both control points lying **on the diagonal** is the exact condition — any
 *  such pair traces the straight line, which is why `linear` is stored as
 *  `(1/3, 2/3)` rather than CSS's `(0,0,1,1)` and why comparing against one
 *  literal preset would answer "no" for the other (see `EASE_PRESETS`' own
 *  doc, and `apelles_types::EaseCurve::LINEAR`'s).
 *
 *  Used to keep both renderers honest about the no-op case: the exporter emits
 *  a plain two-point linear segment rather than 20 sampled ones, and
 *  `paramValueAt` skips the solve entirely — so a timeline with no easing
 *  produces byte-identical ffmpeg argv and bit-identical resolved values to
 *  before D-233, which is the guarantee this feature's tests actually assert.
 */
export function isIdentityEase(curve: EaseCurve | undefined | null): boolean {
  if (!curve) return true;
  const { x1, y1, x2, y2 } = curve;
  if (![x1, y1, x2, y2].every(Number.isFinite)) return true;
  return x1 === y1 && x2 === y2;
}

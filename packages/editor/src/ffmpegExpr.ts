/**
 * @chroma/editor — the shared ffmpeg piecewise-linear time-expression
 * builder (D-197), extracted out of `timelineExport.ts`'s `keyframeExprAt`.
 *
 * What it is: given a sorted list of `{t, value}` points, the nested
 * `if(between(t,...),lerp,...)` ffmpeg expression that piecewise-linearly
 * interpolates between them, holding flat before the first point and after
 * the last (no extrapolation). Originally written once, inline, for
 * `keyframeExprAt` (D-183's position/scale keyframe export); D-197's real
 * audio-mixing pass needed the exact same construction for a completely
 * different input (densely SAMPLED points approximating a cubic-bezier fade
 * curve — see `timelineExportAudio.ts`'s `fadeGainExpr`), which is exactly
 * the "if two places need it, extract it" case CLAUDE.md calls out, not a
 * coincidence worth leaving as two copies.
 *
 * What it does NOT do: anything keyframe- or fade-specific. It has no idea
 * what the points mean — `keyframeExprAt` still owns "filter/sort a clip's
 * `chroma_keyframes` for one param", and `fadeGainExpr` still owns "sample a
 * cubic-bezier fade curve" — both just hand this the resulting points.
 *
 * Pure, no I/O — like everything else in this pure export-compiler package.
 */

/** One point of a piecewise-linear ffmpeg time-expression: at time `t`
 *  (whatever unit/variable the caller's `timeVar` is expressed in — clip-
 *  local seconds for a fade, session-relative seconds for a duck), the
 *  expression evaluates to exactly `value`. */
export interface ExprPoint {
  t: number;
  value: number;
}

/**
 * Build the ffmpeg expression string that piecewise-linearly interpolates
 * `points` (assumed already sorted ascending by `t`, and non-empty for any
 * real caller — see each case below), evaluated against `timeVar` (the
 * ffmpeg expression-language variable/sub-expression standing in for "the
 * current position", e.g. `'t'` for a clip-local fade or `'(t+2.5)'` for a
 * duck shifted onto the session timeline).
 *
 * - Zero points: `'0'` — should never actually be reachable (both real
 *   callers guard against an empty point list themselves), but a safe,
 *   inert fallback rather than an empty/invalid expression string.
 * - One point: a bare constant, regardless of `t` — matches
 *   `keyframeExprAt`'s own pre-existing "a single keyframe is a constant"
 *   contract byte-for-byte.
 * - Two or more: the nested `if(between(...))` chain, built from the LAST
 *   segment inward (the innermost default is "after the last point, hold"),
 *   then wrapped once more for "before the first point, hold" — exactly
 *   `keyframeExprAt`'s pre-extraction construction, unchanged.
 */
export function piecewiseLinearExpr(points: ExprPoint[], timeVar: string): string {
  if (points.length === 0) return '0';
  if (points.length === 1) return String(points[0].value);

  let expr = String(points[points.length - 1].value);
  for (let i = points.length - 2; i >= 0; i--) {
    const { t: t0, value: y0 } = points[i];
    const { t: t1, value: y1 } = points[i + 1];
    const slopeTerm = `${y0}+(${y1}-${y0})*(${timeVar}-${t0})/(${t1}-${t0})`;
    expr = `if(between(${timeVar},${t0},${t1}),${slopeTerm},${expr})`;
  }
  const firstT = points[0].t;
  expr = `if(lt(${timeVar},${firstT}),${points[0].value},${expr})`;
  return expr;
}

/**
 * @apelles/editor — the EQ response graph's pure geometry (D-237, roadmap item
 * 27's "EQ response curve UI" — the half of D-224's per-clip parametric EQ
 * that was deliberately deferred: Resolve's ±24 dB / log-frequency plot with a
 * draggable, hit-tested point per band).
 *
 * What it is: the log-frequency x axis and linear ±24 dB y axis Resolve's own
 * Clip Equalizer graph uses (`scratch/resolve-reference/soundtrack.jpg`), the
 * conversions between that axis and screen pixels in both directions, the
 * composite response curve's own SVG path (sampled, not solved — see below for
 * why that is fine here and is NOT fine in `curveEditor.ts`), where one band's
 * point sits on that axis, what dragging it means back in Hz/dB, and the
 * scroll-wheel-to-Q mapping `EqResponseGraph.tsx`'s own module doc explains
 * the reasoning for.
 *
 * What it does NOT do: no DOM, no React, no store — the same pure/wiring split
 * `curveEditor.ts` + `ClipCurveEditor.tsx` and `clipFade.ts` +
 * `ClipFadeOverlay.tsx` already use, for the identical reason (a drag's
 * geometry is exact-number-testable without mounting anything). It computes no
 * response value itself — every dB number comes from `eqResponseDb` (`./eq`,
 * D-224), imported and never re-derived, per this repo's own instruction that
 * the response math is pinned by measurement and has exactly one
 * implementation per language. This module is the SCREEN mapping around that
 * one function, nothing more.
 *
 * **Why the curve is SAMPLED here, unlike `curveEditor.ts`'s exact bezier
 * path.** An ease curve is a single cubic bezier with a closed-form SVG `C`
 * segment; a biquad cascade's magnitude response has no such closed form in
 * screen space (it is `20·log10` of a ratio of two trigonometric sums, evaluated
 * per frequency) — there is no small number of control points that trace it
 * exactly. Sampling is the same choice every DAW's own EQ curve makes, and it
 * is exact in the limit; [`EQ_CURVE_SAMPLES`] is chosen high enough (128,
 * log-spaced in frequency, so every bell and pass-filter corner gets many
 * samples rather than being spread thin at the top of the log axis) that the
 * drawn line and `eqResponseDb`'s own value visibly agree at any frequency a
 * test or a human would check.
 */

import {
  EQ_DESIGN_SAMPLE_RATE,
  EQ_MAX_FREQ_HZ,
  EQ_MAX_GAIN_DB,
  EQ_MAX_Q,
  EQ_MIN_FREQ_HZ,
  EQ_MIN_Q,
  eqKindUsesGain,
  eqResponseDb,
  type EqBand,
} from './eq';

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

// --------------------------------------------------------------------------- //
// axes
// --------------------------------------------------------------------------- //

const LOG_MIN_HZ = Math.log10(EQ_MIN_FREQ_HZ);
const LOG_MAX_HZ = Math.log10(EQ_MAX_FREQ_HZ);

/** A frequency (Hz, clamped to the model's own `EQ_MIN_FREQ_HZ..EQ_MAX_FREQ_HZ`
 *  range) to an x pixel in a plot `width` wide — Resolve's own log-frequency
 *  axis, the standard axis every parametric EQ graph uses because an octave
 *  (a doubling) is a constant WIDTH at any frequency on a log axis and a
 *  vanishing sliver at the top of a linear one. */
export function freqToX(freqHz: number, width: number): number {
  if (!(width > 0)) return 0;
  const t = (Math.log10(clamp(freqHz, EQ_MIN_FREQ_HZ, EQ_MAX_FREQ_HZ)) - LOG_MIN_HZ) / (LOG_MAX_HZ - LOG_MIN_HZ);
  return t * width;
}

/** The inverse of [`freqToX`] — an x pixel (clamped into the plot) back to a
 *  frequency. What a horizontal drag reads. */
export function xToFreq(x: number, width: number): number {
  if (!(width > 0)) return EQ_MIN_FREQ_HZ;
  const t = clamp(x / width, 0, 1);
  return Math.pow(10, LOG_MIN_HZ + t * (LOG_MAX_HZ - LOG_MIN_HZ));
}

/** A gain in dB (clamped to `±EQ_MAX_GAIN_DB`, Resolve's own graph's own
 *  labelled range) to a y pixel in a plot `height` tall. `+EQ_MAX_GAIN_DB` is
 *  the TOP (y=0, screen y grows downward) and `-EQ_MAX_GAIN_DB` the bottom. */
export function dbToY(db: number, height: number): number {
  if (!(height > 0)) return 0;
  const t = (clamp(db, -EQ_MAX_GAIN_DB, EQ_MAX_GAIN_DB) + EQ_MAX_GAIN_DB) / (2 * EQ_MAX_GAIN_DB);
  return height - t * height;
}

/** The inverse of [`dbToY`] — a y pixel (clamped into the plot) back to a
 *  gain in dB. What a vertical drag reads. */
export function yToDb(y: number, height: number): number {
  if (!(height > 0)) return 0;
  const t = clamp(1 - y / height, 0, 1);
  return t * 2 * EQ_MAX_GAIN_DB - EQ_MAX_GAIN_DB;
}

/** Frequency gridlines, Hz — a clean log-spaced set rather than Resolve's own
 *  screenshot ticks (`20, 62, 250, 1K, 4K, 16K`), which are pixel-even on ITS
 *  fixed graph width and not a set with any rounder meaning of its own. Round
 *  numbers a human actually reads off an axis. */
export const EQ_FREQ_GRIDLINES: readonly number[] = [50, 100, 200, 500, 1_000, 2_000, 5_000, 10_000, 20_000];

/** dB gridlines — the axis's own labelled ends plus its halves and the centre,
 *  matching Resolve's `+24 / +12 / 0 / −12 / −24`. */
export const EQ_DB_GRIDLINES: readonly number[] = [
  -EQ_MAX_GAIN_DB,
  -EQ_MAX_GAIN_DB / 2,
  0,
  EQ_MAX_GAIN_DB / 2,
  EQ_MAX_GAIN_DB,
];

// --------------------------------------------------------------------------- //
// the composite response curve
// --------------------------------------------------------------------------- //

/** How many points the curve is sampled at — see the module doc for why
 *  sampling (not an exact path) is the right call for a biquad cascade's
 *  response, unlike `curveEditor.ts`'s exact bezier segments. Log-spaced in
 *  frequency (one sample every `(LOG_MAX_HZ-LOG_MIN_HZ)/(N-1)` decades), so
 *  resolution is even across the log axis instead of being wasted on the top
 *  octave the way a linear-frequency sampling would waste it on the bottom. */
export const EQ_CURVE_SAMPLES = 128;

export interface EqCurvePoint {
  x: number;
  y: number;
  freqHz: number;
  db: number;
}

/** The whole band set's combined response, sampled across the full plot width
 *  — screen points ready to trace a path from, each still carrying the
 *  frequency/dB it was computed at so a caller (or a test) can check a
 *  specific point without re-deriving the log-x mapping. Delegates every dB
 *  value to [`eqResponseDb`] (`./eq`, D-224's own pinned math) — this function
 *  contributes only the sample frequencies and the screen mapping. */
export function eqCurveSamples(
  bands: readonly EqBand[],
  width: number,
  height: number,
  sampleRate: number = EQ_DESIGN_SAMPLE_RATE,
  count: number = EQ_CURVE_SAMPLES,
): EqCurvePoint[] {
  if (!(width > 0) || count < 2) return [];
  const points: EqCurvePoint[] = [];
  for (let i = 0; i < count; i++) {
    const x = (i / (count - 1)) * width;
    const freqHz = xToFreq(x, width);
    const db = eqResponseDb(bands, freqHz, sampleRate);
    points.push({ x, y: dbToY(db, height), freqHz, db });
  }
  return points;
}

/** The curve's own stroke path — a plain polyline through [`eqCurveSamples`]'s
 *  points. `EQ_CURVE_SAMPLES` points on a few-hundred-pixel-wide plot is dense
 *  enough that a straight-segment polyline and a true smooth interpolation are
 *  visually identical; a spline through them would be curve-fitting a curve
 *  that already came from real samples, for no visible gain. */
export function eqCurveLinePath(points: readonly EqCurvePoint[]): string {
  if (points.length === 0) return '';
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ');
}

/** The same line, closed down to the 0 dB baseline and back — what a filled
 *  "how far from flat" area under/over the curve traces. Closes at the FIRST
 *  and LAST sample's own x, so the fill's edges sit exactly on the plot's own
 *  left/right bound rather than at some other assumed width. */
export function eqCurveFillPath(points: readonly EqCurvePoint[], height: number): string {
  if (points.length === 0) return '';
  const zeroY = dbToY(0, height);
  const first = points[0];
  const last = points[points.length - 1];
  const line = eqCurveLinePath(points);
  return `${line} L ${last.x.toFixed(2)} ${zeroY.toFixed(2)} L ${first.x.toFixed(2)} ${zeroY.toFixed(2)} Z`;
}

// --------------------------------------------------------------------------- //
// one band's own point, and what a drag of it means
// --------------------------------------------------------------------------- //

export interface EqBandPoint {
  x: number;
  y: number;
}

/** Where one band's own draggable point sits. Frequency always positions it
 *  horizontally; vertically, a gain-using band (`low_shelf`/`peak`/
 *  `high_shelf`) sits at its own gain, and a pass filter — which
 *  [`eqKindUsesGain`] says has none — sits on the 0 dB line, matching
 *  `PropertyRow`'s own posture on a pass filter's Gain row (disabled, not
 *  hidden): the point still marks WHERE the filter acts, just not with a
 *  gain that means anything for it. */
export function eqBandPoint(band: EqBand, width: number, height: number): EqBandPoint {
  return {
    x: freqToX(band.freq_hz, width),
    y: dbToY(eqKindUsesGain(band.kind) ? band.gain_db : 0, height),
  };
}

/** What dragging a band's point to screen position `(x, y)` means, as a patch
 *  ready for `onEqBandChange`/`set_clip_eq` — mirrors `EqBand::sanitised`'s own
 *  intent (a stored value should be a clean, meaningful number, not a
 *  sub-pixel-derived float) by rounding frequency to the nearest Hz and gain to
 *  the nearest tenth of a dB, the finest step a human can dial in by ear.
 *
 *  Frequency is always in the patch; gain only for a band [`eqKindUsesGain`]
 *  says has one — a pass filter's y position carries no information (see
 *  [`eqBandPoint`]), so a drag of one must not write a `gain_db` it will then
 *  ignore forever until the kind changes back. */
export function eqPointDragPatch(band: EqBand, width: number, height: number, x: number, y: number): Partial<EqBand> {
  const freq_hz = Math.round(xToFreq(clamp(x, 0, width), width));
  if (!eqKindUsesGain(band.kind)) return { freq_hz };
  const gain_db = Math.round(yToDb(clamp(y, 0, height), height) * 10) / 10;
  return { freq_hz, gain_db };
}

// --------------------------------------------------------------------------- //
// Q — the scroll-wheel-over-the-point convention
// --------------------------------------------------------------------------- //

/** Multiplicative step per wheel "notch" (a `deltaY` of ~100, the common
 *  browser/OS unit for one physical detent). `Q` spans two orders of magnitude
 *  (`EQ_MIN_Q..EQ_MAX_Q`, 0.1..20) — a fixed additive step would be inert at
 *  the narrow end and useless at the wide end, so a constant RATIO per notch
 *  (a log control, the same idea `freqToX`'s axis already uses) feels the same
 *  everywhere on the range. 1.08 was picked so an unhurried scroll covers the
 *  full 0.1..20 range in on the order of 40 notches — enough ticks to dial in
 *  precisely, few enough that a real scroll gesture (which fires many notches
 *  per gesture on a trackpad) doesn't fly past a useful value in one motion. */
const EQ_Q_WHEEL_FACTOR = 1.08;

/** `currentQ` after one wheel event of `deltaY` — scroll up (`deltaY < 0`,
 *  the physical "push away"/"up" direction on both a mouse wheel and a
 *  trackpad) narrows the band (raises Q), scroll down widens it, matching
 *  Logic Pro's own Channel EQ convention (Apple's "Channel EQ parameters"
 *  guide: "You can adjust the Q value by scrolling with the mouse wheel while
 *  hovering over a band") — the real precedent this was checked against,
 *  since neither `soundtrack.jpg` nor any reachable Resolve documentation
 *  shows a drag gesture for Q at all (Resolve's own Clip Equalizer screenshot
 *  has no visible secondary axis for it). Chosen over a modifier-key drag
 *  (Logic also offers Option-Command-drag for gain+Q together) because a
 *  modifier is invisible until discovered by accident, while scroll-over-a-
 *  control is what this app's own zoom gestures (`PreviewPane`, `TimelinePane`)
 *  already train a user to try on this exact codebase. */
export function eqQAfterWheel(currentQ: number, deltaY: number): number {
  if (deltaY === 0 || !Number.isFinite(deltaY)) return clamp(currentQ, EQ_MIN_Q, EQ_MAX_Q);
  const factor = Math.pow(EQ_Q_WHEEL_FACTOR, -deltaY / 100);
  return clamp(Math.round(currentQ * factor * 100) / 100, EQ_MIN_Q, EQ_MAX_Q);
}

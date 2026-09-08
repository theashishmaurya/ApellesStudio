/**
 * @chroma/editor — the timeline curve editor's pure geometry (D-232, roadmap
 * item 27 "Bezier ease curves under a clip, editable directly").
 *
 * What it is: the maths behind `ClipCurveEditor.tsx` — the value axis a
 * property's animation is plotted against, the SVG path of each segment, where
 * that segment's two bezier control handles sit on screen, and what a drag of
 * one of them means back in curve space. Modelled on DaVinci Resolve's own
 * inline clip curve editor (`scratch/resolve-reference/curve.jpg`): a lane
 * under the clip, the property's name and its four ease presets in a header
 * strip, the value range labelled at both ends of the plot, keyframes as dots
 * on a real curve.
 *
 * What it does NOT do: no DOM, no React, no store, no time-to-pixel mapping.
 * **X is not this module's business** — the lane is time-aligned with the
 * timeline above it, so its x axis is the timeline's own `pxPerSec`/
 * `scrollLeft` mapping and the component passes already-resolved x
 * coordinates in. This module owns only the y (value) axis and the curve
 * shape between two given screen points. That split is deliberate: it is what
 * lets a segment's geometry be unit-tested against exact numbers without a
 * timeline, and it is the same pure/wiring split `clipFade.ts` +
 * `ClipFadeOverlay.tsx` and `transformGeometry.ts` + `TransformOverlay.tsx`
 * already use.
 *
 * **The curve is drawn exactly, never sampled** — the same fact D-207's fade
 * ramp turns on, and worth restating because the *exporter* does sample this
 * curve (ffmpeg has no bezier solver) and it would be easy to assume drawing
 * has the same constraint. It does not: an `EaseCurve` is
 * `cubic-bezier(x1,y1,x2,y2)` with `P0=(0,0)`/`P3=(1,1)` implicit, and an SVG
 * `C` segment is that same parametric cubic with the same control points, so
 * mapping the curve's unit square onto the segment's screen rectangle traces
 * the identical geometry with no solver and no sample count. The Newton/
 * bisection solve exists to answer "value at a given x", which drawing never
 * asks.
 *
 * Pure, deterministic, no I/O.
 */

import type { EaseCurve } from './timeline';
import type { ParamSegment } from './clipKeyframes';

/** 3dp — well below one screen pixel at every zoom this pane allows, and it
 *  keeps the emitted path (and this module's tests) readable. Same convention
 *  and same reason as `clipFade.ts`'s own `fmt`. */
function fmt(n: number): string {
  return (Math.round(n * 1000) / 1000).toString();
}

// --------------------------------------------------------------------------- //
// The value axis
// --------------------------------------------------------------------------- //

/** The plotted value range — what the lane's top and bottom edges mean, and
 *  what its two corner labels read (the `100.00` / `0.00` pair in Resolve's
 *  own editor). */
export interface CurveValueRange {
  min: number;
  max: number;
}

/** How much of the lane's height is left as breathing room above the highest
 *  and below the lowest keyframed value, as a fraction of the value span.
 *
 *  Without it a curve's extreme keys sit exactly on the lane's border, where
 *  their dots are half-clipped and — worse — an overshooting ease (legal, and
 *  the interesting case) is drawn outside the lane entirely with no hint that
 *  it went anywhere. 12% is enough to show a typical overshoot's shoulder
 *  while keeping the useful range large; it is a named constant rather than a
 *  literal because it is exactly the kind of number that otherwise gets
 *  re-tuned in three places. */
const VALUE_PADDING_FRACTION = 0.12;

/** The floor on a plotted range's height, in the property's own units.
 *
 *  A property whose keys all hold the SAME value has a zero-height range, and
 *  every value would map to the same y — a flat line, which is correct, but
 *  `valueToY` would also divide by zero getting there. This widens such a
 *  range symmetrically so the flat line lands mid-lane. Small enough that it
 *  never affects a range with real spread. */
const MIN_VALUE_SPAN = 1e-6;

/**
 * The value range to plot `segments` against, padded per
 * [`VALUE_PADDING_FRACTION`].
 *
 * Derived from the keyframed values themselves rather than from a property's
 * theoretical bounds, deliberately: `opacity` is `0..1` and `scale` is
 * unbounded, but an animation from `0.9` to `1.0` plotted against `0..1` is a
 * flat line you cannot read or edit, while the same animation plotted against
 * its own extent is the curve the user came here to see. Resolve's own editor
 * does the same — its `100.00`/`0.00` labels in the reference frame are that
 * clip's opacity extent, not opacity's definition.
 *
 * `staticValue` is included in the extent when there are no segments at all,
 * so a property with one key (or none) still plots a readable flat line rather
 * than an empty lane.
 */
export function curveValueRange(segments: ParamSegment[], staticValue: number): CurveValueRange {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const s of segments) {
    min = Math.min(min, s.fromValue, s.toValue);
    max = Math.max(max, s.fromValue, s.toValue);
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    min = staticValue;
    max = staticValue;
  }
  const span = Math.max(max - min, MIN_VALUE_SPAN);
  const pad = span * VALUE_PADDING_FRACTION;
  // A zero-spread range is widened symmetrically by the floor as well as the
  // padding, so its flat line lands exactly mid-lane.
  const grow = (MIN_VALUE_SPAN - (max - min)) / 2;
  const extra = grow > 0 ? grow : 0;
  return { min: min - pad - extra, max: max + pad + extra };
}

/** Screen y (0 at the lane's top) for a value in `range` over a lane of
 *  `height` px. Higher values are HIGHER on screen, which is the one
 *  orientation rule in this module and the opposite of the raw pixel axis. */
export function valueToY(value: number, range: CurveValueRange, height: number): number {
  const span = range.max - range.min;
  if (!(span > 0) || !(height > 0)) return height / 2;
  return height - ((value - range.min) / span) * height;
}

/** The exact inverse of [`valueToY`] — what a pointer at screen `y` means as a
 *  value. Used by the control-point drag, which is authored in screen space
 *  and stored in curve space. */
export function yToValue(y: number, range: CurveValueRange, height: number): number {
  const span = range.max - range.min;
  if (!(span > 0) || !(height > 0)) return range.min;
  return range.min + ((height - y) / height) * span;
}

// --------------------------------------------------------------------------- //
// One segment's shape
// --------------------------------------------------------------------------- //

/** One segment's rectangle on screen: where its two keyframes are. `x1`/`y1`
 *  is the LATER key, so a falling animation has `y1 > y0` — nothing here
 *  assumes a direction. */
export interface SegmentRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * The SVG path tracing one segment, exactly.
 *
 * A `null` (linear) ease emits a straight `L`, not a `C` with diagonal control
 * points. The two are geometrically identical, and emitting the `C` anyway
 * would have been simpler — but the path string is what the DOM tests read to
 * assert "this segment is not eased", and a straight line that *says* it is
 * straight is worth the branch.
 *
 * For an eased segment, the curve's unit square maps onto the rectangle
 * directly: `x` is progress from the earlier key to the later one, `y` is
 * progress through the value change, and both axes of the rectangle are linear
 * in exactly those. So the SVG control points are the curve's own, scaled —
 * no solver, no sampling. `y` is deliberately allowed to fall outside the
 * rectangle: that is what an overshooting ease looks like, and clamping it
 * would draw a curve the renderers do not produce.
 */
export function segmentPath(rect: SegmentRect, ease: EaseCurve | null): string {
  const { x0, y0, x1, y1 } = rect;
  if (!ease) return `M ${fmt(x0)} ${fmt(y0)} L ${fmt(x1)} ${fmt(y1)}`;
  const [c1, c2] = segmentHandlePoints(rect, ease);
  return (
    `M ${fmt(x0)} ${fmt(y0)} ` +
    `C ${fmt(c1.x)} ${fmt(c1.y)}, ${fmt(c2.x)} ${fmt(c2.y)}, ${fmt(x1)} ${fmt(y1)}`
  );
}

/** A bezier control handle's position on screen. */
export interface HandlePoint {
  x: number;
  y: number;
}

/**
 * Where a segment's two draggable control handles sit on screen: `[P1, P2]`,
 * the outgoing handle of the earlier keyframe and the incoming handle of the
 * later one — the pair After Effects and Resolve both draw, and exactly the
 * `(x1,y1)`/`(x2,y2)` this segment's single stored `EaseCurve` holds (see
 * `chroma::keyframes::interpolate_param` for why one curve per segment rather
 * than a handle pair per key).
 *
 * A linear segment still has handles, at the diagonal positions `1/3` and
 * `2/3` — the `LINEAR` preset's own control points, which is what makes
 * "start dragging a straight segment" a continuous gesture rather than a jump
 * from nowhere to somewhere.
 */
export function segmentHandlePoints(rect: SegmentRect, ease: EaseCurve | null): [HandlePoint, HandlePoint] {
  const { x0, y0, x1, y1 } = rect;
  const c = ease ?? { x1: 1 / 3, y1: 1 / 3, x2: 2 / 3, y2: 2 / 3 };
  const dx = x1 - x0;
  const dy = y1 - y0;
  return [
    { x: x0 + dx * c.x1, y: y0 + dy * c.y1 },
    { x: x0 + dx * c.x2, y: y0 + dy * c.y2 },
  ];
}

/** How far past a segment's own value range a control handle may be dragged,
 *  as a fraction of that range — i.e. how much overshoot the UI will author.
 *
 *  Overshoot is legal in the model and genuinely useful (anticipation, a
 *  bounce), so the drag must reach it; but it is unbounded in storage, and a
 *  handle dragged to the far side of a tall lane would author a curve whose
 *  own drawn shape leaves the lane and can no longer be grabbed back. One
 *  full range in each direction is well past any easing anyone authors on
 *  purpose and still lands inside a lane with [`VALUE_PADDING_FRACTION`]'s
 *  breathing room. MCP is NOT bound by this — `editor_set_keyframe_ease`
 *  writes what it is given, the same "the drag clamps, the model does not"
 *  split D-207 documents for fade lengths. */
const MAX_HANDLE_OVERSHOOT = 1;

/**
 * A drag of handle `which` to screen `(px, py)` → the curve that drag means.
 *
 * `x` is clamped to `[0, 1]`: a control point outside the segment horizontally
 * makes `x(t)` non-monotonic, at which point the inverse the renderers solve
 * for is not unique and the curve stops meaning anything (`EaseCurve::eval`
 * clamps it too, at the point of use — clamping the *gesture* as well is what
 * stops the handle drifting away from the pointer with no visible reason).
 *
 * `y` is clamped only to [`MAX_HANDLE_OVERSHOOT`] beyond the segment's own
 * range, so pulling a handle past a keyframe authors real overshoot — the
 * whole reason this is a curve editor and not a preset menu.
 *
 * A zero-width or zero-height segment rectangle (two keys one frame apart at a
 * steep zoom-out, or an animation between equal values) returns the ease
 * unchanged rather than dividing by zero: there is no meaningful drag axis, so
 * the honest answer is "this gesture did nothing".
 */
export function handleDragToEase(
  rect: SegmentRect,
  ease: EaseCurve | null,
  which: 1 | 2,
  px: number,
  py: number,
): EaseCurve {
  const current = ease ?? { x1: 1 / 3, y1: 1 / 3, x2: 2 / 3, y2: 2 / 3 };
  const dx = rect.x1 - rect.x0;
  const dy = rect.y1 - rect.y0;
  if (dx === 0 || dy === 0) return current;

  const nx = Math.min(1, Math.max(0, (px - rect.x0) / dx));
  const rawY = (py - rect.y0) / dy;
  const ny = Math.min(1 + MAX_HANDLE_OVERSHOOT, Math.max(-MAX_HANDLE_OVERSHOOT, rawY));

  return which === 1
    ? { ...current, x1: round4(nx), y1: round4(ny) }
    : { ...current, x2: round4(nx), y2: round4(ny) };
}

/** Four decimal places on a stored control point.
 *
 *  A curve is authored by dragging, so its numbers come from pixel positions
 *  and carry float dust that means nothing — `0.42000000000000004` is not a
 *  more faithful record of where the pointer was than `0.42`. Rounding on the
 *  way into the model keeps `project.json` diffable, keeps the determinism
 *  invariant easy to reason about, and (at 4dp, ~1/10000 of a segment) is
 *  finer than any lane this editor can render. It is also what lets a drag
 *  that lands exactly on a preset's numbers round-trip as that preset's NAME
 *  rather than as "custom". */
function round4(v: number): number {
  return Math.round(v * 10_000) / 10_000;
}

// --------------------------------------------------------------------------- //
// Hit target
// --------------------------------------------------------------------------- //

/**
 * The radius, in px, of each control handle'''s INVISIBLE grab circle.
 *
 * Comfortably larger than the visible dot it sits under — a handle you have to
 * hit exactly is a handle nobody uses — and small enough that a segment'''s two
 * handles never contend at any lane height this editor allows.
 *
 * It is a radius rather than a hit-test function on purpose. An earlier draft
 * of this module hand-rolled a radial `hitTestHandle(segments, rects, x, y)`
 * and dispatched from a pointerdown on the whole plot; that reimplements, less
 * correctly, what the browser already does for an SVG element (it ignored
 * paint order and `pointer-events`, and it could only work where a layout
 * engine had already run — so the jsdom tier could not drive the gesture at
 * all). Rendering a transparent `<circle r={HANDLE_HIT_RADIUS_PX}>` and
 * letting it take its own `pointerdown` is the canonical way to get a grab
 * target bigger than its glyph, and it deletes the hit test entirely.
 */
export const HANDLE_HIT_RADIUS_PX = 10;

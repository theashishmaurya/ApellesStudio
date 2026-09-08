/**
 * `curveEditor.ts` — the curve lane's pure geometry (D-232).
 */
import { describe, expect, it } from 'vitest';

import {
  curveValueRange,
  handleDragToEase,
  segmentHandlePoints,
  segmentPath,
  valueToY,
  yToValue,
  type SegmentRect,
} from './curveEditor';
import { easeCurveEval } from './easeCurve';
import { EASE_PRESETS, type EaseCurve } from './timeline';
import type { ParamSegment } from './clipKeyframes';

const EASE_IN = EASE_PRESETS[1].curve;
const EASE_IN_OUT = EASE_PRESETS[3].curve;

function seg(fromFrame: number, toFrame: number, fromValue: number, toValue: number, ease: EaseCurve | null = null): ParamSegment {
  return { fromFrame, toFrame, fromValue, toValue, ease };
}

describe('curveValueRange', () => {
  it('spans the keyed values with padding on both sides', () => {
    const r = curveValueRange([seg(0, 10, 0, 1)], 0.5);
    expect(r.min).toBeLessThan(0);
    expect(r.max).toBeGreaterThan(1);
    // Symmetric padding — the curve sits centred in the lane.
    expect(r.max - 1).toBeCloseTo(0 - r.min, 9);
  });

  it('uses the property\'s OWN extent, not its theoretical bounds', () => {
    // A 0.9 -> 1.0 opacity animation plotted against opacity's own 0..1 range
    // would be a flat, unreadable, un-editable line. This is the reason the
    // reference's own value labels are the clip's extent, not the property's.
    const r = curveValueRange([seg(0, 10, 0.9, 1.0)], 0.9);
    expect(r.min).toBeGreaterThan(0.8);
    expect(r.max).toBeLessThan(1.1);
  });

  it('gives a flat animation a real, non-zero range', () => {
    // Every key the same value: the honest plot is a flat line mid-lane, and
    // `valueToY` must not divide by zero getting there.
    const r = curveValueRange([seg(0, 10, 2, 2)], 2);
    expect(r.max).toBeGreaterThan(r.min);
    const height = 100;
    expect(valueToY(2, r, height)).toBeCloseTo(height / 2, 6);
  });

  it('falls back to the static value when there are no segments at all', () => {
    const r = curveValueRange([], 0.25);
    expect(r.min).toBeLessThan(0.25);
    expect(r.max).toBeGreaterThan(0.25);
  });

  it('covers every segment, not just the first', () => {
    const r = curveValueRange([seg(0, 10, 0, 1), seg(10, 20, 1, 5)], 0);
    expect(r.max).toBeGreaterThan(5);
    expect(r.min).toBeLessThan(0);
  });
});

describe('valueToY / yToValue', () => {
  const range = { min: 0, max: 1 };

  it('puts higher values HIGHER on screen', () => {
    expect(valueToY(1, range, 100)).toBeCloseTo(0, 9);
    expect(valueToY(0, range, 100)).toBeCloseTo(100, 9);
    expect(valueToY(0.5, range, 100)).toBeCloseTo(50, 9);
  });

  it('round-trips exactly — the drag reads screen space and stores value space', () => {
    for (const v of [0, 0.1, 0.5, 0.9, 1]) {
      expect(yToValue(valueToY(v, range, 137), range, 137)).toBeCloseTo(v, 9);
    }
  });

  it('degrades to mid-lane rather than dividing by zero', () => {
    expect(valueToY(1, { min: 1, max: 1 }, 100)).toBe(50);
    expect(valueToY(1, range, 0)).toBe(0);
  });
});

describe('segmentPath', () => {
  const rect: SegmentRect = { x0: 0, y0: 100, x1: 200, y1: 0 };

  it('emits a straight line for an un-eased segment', () => {
    // Says what it is, so a DOM test can assert "not eased" from the path.
    expect(segmentPath(rect, null)).toBe('M 0 100 L 200 0');
  });

  it('emits the curve\'s OWN control points, scaled onto the rectangle', () => {
    // The whole reason drawing needs no solver: the SVG cubic and the easing
    // cubic are the same parametric curve with the same control points.
    const d = segmentPath(rect, EASE_IN);
    // ease-in is (0.42, 0, 1, 1): x = 0 + 200*0.42 = 84, y = 100 + (-100)*0 = 100
    //                              x = 0 + 200*1    = 200, y = 100 + (-100)*1 = 0
    expect(d).toBe('M 0 100 C 84 100, 200 0, 200 0');
  });

  it('traces the same shape the renderers evaluate', () => {
    // The drawn curve and the resolved value must be the same function. Sample
    // the SVG cubic at several `t` and check its (x, y) satisfies the eased
    // value relation the interpolators use.
    const c = EASE_IN_OUT;
    const cubic = (t: number, p0: number, p1: number, p2: number, p3: number) => {
      const mt = 1 - t;
      return mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3;
    };
    const [h1, h2] = segmentHandlePoints(rect, c);
    for (let i = 1; i < 10; i++) {
      const t = i / 10;
      const x = cubic(t, rect.x0, h1.x, h2.x, rect.x1);
      const y = cubic(t, rect.y0, h1.y, h2.y, rect.y1);
      // progress along x, in the curve's own unit space
      const u = (x - rect.x0) / (rect.x1 - rect.x0);
      const expectedY = rect.y0 + (rect.y1 - rect.y0) * easeCurveEval(c, u);
      expect(y).toBeCloseTo(expectedY, 4);
    }
  });
});

describe('segmentHandlePoints', () => {
  const rect: SegmentRect = { x0: 0, y0: 0, x1: 100, y1: 100 };

  it('places a linear segment\'s handles on the diagonal at 1/3 and 2/3', () => {
    // So starting a drag on a straight segment is continuous — the handle is
    // already where the pointer expects it, not jumping in from nowhere.
    const [a, b] = segmentHandlePoints(rect, null);
    // `toBeCloseTo`, not `toEqual`: `x0 + dx * (1/3)` and `100/3` differ in the
    // last bit, and pinning float dust would be pinning the wrong thing.
    expect(a.x).toBeCloseTo(100 / 3, 9);
    expect(a.y).toBeCloseTo(100 / 3, 9);
    expect(b.x).toBeCloseTo(200 / 3, 9);
    expect(b.y).toBeCloseTo(200 / 3, 9);
  });

  it('maps the curve\'s control points onto the rectangle', () => {
    const [a, b] = segmentHandlePoints(rect, EASE_IN);
    expect(a).toEqual({ x: 42, y: 0 });
    expect(b).toEqual({ x: 100, y: 100 });
  });

  it('handles a DOWNWARD segment without assuming a direction', () => {
    const falling: SegmentRect = { x0: 0, y0: 0, x1: 100, y1: -50 };
    const [a] = segmentHandlePoints(falling, EASE_IN);
    expect(a).toEqual({ x: 42, y: 0 });
  });
});

describe('handleDragToEase', () => {
  const rect: SegmentRect = { x0: 0, y0: 0, x1: 100, y1: 100 };

  it('converts a pointer position into that control point', () => {
    const c = handleDragToEase(rect, null, 1, 25, 75);
    expect(c.x1).toBeCloseTo(0.25, 6);
    expect(c.y1).toBeCloseTo(0.75, 6);
    // ...and leaves the OTHER control point exactly as it was.
    expect(c.x2).toBeCloseTo(2 / 3, 6);
    expect(c.y2).toBeCloseTo(2 / 3, 6);
  });

  it('edits handle 2 independently', () => {
    const c = handleDragToEase(rect, EASE_IN, 2, 50, 20);
    expect(c.x2).toBeCloseTo(0.5, 6);
    expect(c.y2).toBeCloseTo(0.2, 6);
    expect(c.x1).toBe(EASE_IN.x1);
    expect(c.y1).toBe(EASE_IN.y1);
  });

  it('clamps x into the segment — a non-invertible curve means nothing', () => {
    expect(handleDragToEase(rect, null, 1, -400, 50).x1).toBe(0);
    expect(handleDragToEase(rect, null, 1, 900, 50).x1).toBe(1);
  });

  it('allows real overshoot on y, but bounded', () => {
    // Past the keyframe = overshoot, which must be reachable...
    expect(handleDragToEase(rect, null, 2, 50, 130).y2).toBeGreaterThan(1);
    expect(handleDragToEase(rect, null, 1, 50, -30).y1).toBeLessThan(0);
    // ...but not so far that the drawn curve leaves the lane and cannot be
    // grabbed back.
    expect(handleDragToEase(rect, null, 2, 50, 99999).y2).toBe(2);
    expect(handleDragToEase(rect, null, 1, 50, -99999).y1).toBe(-1);
  });

  it('rounds stored control points, so a drag onto a preset IS that preset', () => {
    const c = handleDragToEase(rect, null, 1, 42.000000001, 0.0000000001);
    expect(c.x1).toBe(0.42);
    expect(c.y1).toBe(0);
  });

  it('returns the curve unchanged for a degenerate segment', () => {
    // Two keys at the same frame, or between equal values: no drag axis, so
    // the honest answer is "this gesture did nothing" rather than a NaN curve.
    const flat: SegmentRect = { x0: 10, y0: 40, x1: 10, y1: 90 };
    expect(handleDragToEase(flat, EASE_IN, 1, 50, 50)).toEqual(EASE_IN);
    const level: SegmentRect = { x0: 0, y0: 40, x1: 100, y1: 40 };
    expect(handleDragToEase(level, EASE_IN, 1, 50, 50)).toEqual(EASE_IN);
  });
});

/**
 * D-437 S3b — the playhead's edge-autoscroll speed curve.
 */
import { describe, expect, it } from 'vitest';
import {
  AUTOSCROLL_EDGE_PX,
  AUTOSCROLL_MAX_OVERSHOOT,
  AUTOSCROLL_MAX_PX_PER_FRAME,
  edgeScrollSpeed,
} from './playheadAutoscroll';

describe('edgeScrollSpeed', () => {
  const L = 100;
  const R = 1100;

  it('is zero in the middle and at the inner border of an edge zone', () => {
    expect(edgeScrollSpeed(600, L, R)).toBe(0);
    expect(edgeScrollSpeed(L + AUTOSCROLL_EDGE_PX, L, R)).toBeCloseTo(0);
    expect(edgeScrollSpeed(R - AUTOSCROLL_EDGE_PX, L, R)).toBeCloseTo(0);
  });

  it('ramps linearly to full speed on the edge, left negative and right positive', () => {
    expect(edgeScrollSpeed(L + AUTOSCROLL_EDGE_PX / 2, L, R)).toBeCloseTo(-AUTOSCROLL_MAX_PX_PER_FRAME / 2);
    expect(edgeScrollSpeed(L, L, R)).toBeCloseTo(-AUTOSCROLL_MAX_PX_PER_FRAME);
    expect(edgeScrollSpeed(R - AUTOSCROLL_EDGE_PX / 2, L, R)).toBeCloseTo(AUTOSCROLL_MAX_PX_PER_FRAME / 2);
    expect(edgeScrollSpeed(R, L, R)).toBeCloseTo(AUTOSCROLL_MAX_PX_PER_FRAME);
  });

  it('keeps speeding up past the edge, up to a cap', () => {
    const past = edgeScrollSpeed(R + AUTOSCROLL_EDGE_PX / 2, L, R);
    expect(past).toBeGreaterThan(AUTOSCROLL_MAX_PX_PER_FRAME);
    expect(edgeScrollSpeed(R + 10_000, L, R)).toBeCloseTo(AUTOSCROLL_MAX_OVERSHOOT * AUTOSCROLL_MAX_PX_PER_FRAME);
    expect(edgeScrollSpeed(L - 10_000, L, R)).toBeCloseTo(-AUTOSCROLL_MAX_OVERSHOOT * AUTOSCROLL_MAX_PX_PER_FRAME);
  });

  it('is monotonic towards each edge', () => {
    let prev = 0;
    for (let x = R - AUTOSCROLL_EDGE_PX; x <= R + 60; x += 3) {
      const v = edgeScrollSpeed(x, L, R);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('is zero for a degenerate viewport, and splits a narrow one down the middle', () => {
    expect(edgeScrollSpeed(5, 10, 10)).toBe(0);
    expect(edgeScrollSpeed(5, 10, 0)).toBe(0);
    expect(edgeScrollSpeed(10 + 5, 10, 20)).toBe(0); // dead centre of a 10 px viewport
    expect(edgeScrollSpeed(11, 10, 20)).toBeLessThan(0);
    expect(edgeScrollSpeed(19, 10, 20)).toBeGreaterThan(0);
  });
});

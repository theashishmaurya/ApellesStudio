import { describe, it, expect } from 'vitest';
import {
  measureWorldMap,
  screenToWorld,
  worldDelta,
  unionRects,
  toContainerLocal,
  axisLock,
  rectFromPoints,
  rectsIntersect,
} from './canvasGeometry';

describe('measureWorldMap', () => {
  it('derives k from the measured rect width over the manifest width', () => {
    const map = measureWorldMap({ left: 100, top: 50, width: 960, height: 540 }, 1920);
    expect(map).toEqual({ left: 100, top: 50, k: 0.5 });
  });
});

describe('screenToWorld / worldDelta', () => {
  it('maps a screen point through an identity map (k=1, origin 0,0)', () => {
    const map = measureWorldMap({ left: 0, top: 0, width: 1920, height: 1080 }, 1920);
    expect(screenToWorld(map, { x: 400, y: 300 })).toEqual({ x: 400, y: 300 });
  });

  it('maps a screen point through a scaled + offset map', () => {
    const map = measureWorldMap({ left: 100, top: 50, width: 960, height: 540 }, 1920);
    expect(screenToWorld(map, { x: 100, y: 50 })).toEqual({ x: 0, y: 0 }); // the origin itself
    expect(screenToWorld(map, { x: 580, y: 250 })).toEqual({ x: 960, y: 400 });
  });

  it('worldDelta divides a screen-space delta by k and ignores origin entirely', () => {
    const map = measureWorldMap({ left: 9999, top: -1234, width: 960, height: 540 }, 1920);
    expect(worldDelta(map, { x: 50, y: -25 })).toEqual({ x: 100, y: -50 });
  });

  // The exact worked example from `docs/notes/motion-visual-builder-
  // research.md` §2c: camera fully pushed in at `x:1150,y:520,zoom:1.5`
  // (cx,cy = 960,540 → T = (-765,-240)), player fit-scale 1:1 so k === zoom.
  // The doc derives the text layer's world (180,300) lands on screen at
  // (-495,210) — this is the exact inverse, proving the two formulas agree
  // with the doc's own hand-worked arithmetic, not just with each other.
  it('matches the research doc\'s own worked camera example (§2c)', () => {
    const map = measureWorldMap({ left: -765, top: -240, width: 2880, height: 1620 }, 1920);
    expect(map.k).toBeCloseTo(1.5);
    expect(screenToWorld(map, { x: -495, y: 210 })).toEqual({ x: 180, y: 300 });
  });

  it('a screen delta of zero is a world delta of zero regardless of k', () => {
    const map = measureWorldMap({ left: 42, top: 17, width: 3840, height: 2160 }, 1920);
    expect(worldDelta(map, { x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
  });
});

describe('unionRects', () => {
  it('returns null for an empty list (the "no data-motion-box found" case)', () => {
    expect(unionRects([])).toBeNull();
  });

  it('returns the rect itself for a single-element list', () => {
    const r = { left: 10, top: 20, width: 30, height: 40 };
    expect(unionRects([r])).toEqual(r);
  });

  it('unions two disjoint rects into their bounding box', () => {
    const a = { left: 0, top: 0, width: 10, height: 10 }; // 0,0 -> 10,10
    const b = { left: 50, top: 5, width: 10, height: 10 }; // 50,5 -> 60,15
    expect(unionRects([a, b])).toEqual({ left: 0, top: 0, width: 60, height: 15 });
  });

  it('unions overlapping rects correctly', () => {
    const a = { left: 0, top: 0, width: 20, height: 20 };
    const b = { left: 10, top: 10, width: 20, height: 20 };
    expect(unionRects([a, b])).toEqual({ left: 0, top: 0, width: 30, height: 30 });
  });
});

describe('toContainerLocal', () => {
  it('subtracts the container origin, keeping width/height', () => {
    const rect = { left: 150, top: 80, width: 40, height: 20 };
    const container = { left: 100, top: 50, width: 1000, height: 1000 };
    expect(toContainerLocal(rect, container)).toEqual({ left: 50, top: 30, width: 40, height: 20 });
  });
});

describe('axisLock', () => {
  it('locks to X when the horizontal delta dominates', () => {
    expect(axisLock({ x: 10, y: 3 })).toEqual({ x: 10, y: 0 });
  });

  it('locks to Y when the vertical delta dominates', () => {
    expect(axisLock({ x: 2, y: 9 })).toEqual({ x: 0, y: 9 });
  });

  it('breaks a tie toward X', () => {
    expect(axisLock({ x: 5, y: 5 })).toEqual({ x: 5, y: 0 });
  });

  it('handles negative deltas by magnitude, not sign', () => {
    expect(axisLock({ x: -20, y: 4 })).toEqual({ x: -20, y: 0 });
    expect(axisLock({ x: 4, y: -20 })).toEqual({ x: 0, y: -20 });
  });
});

describe('rectFromPoints', () => {
  it('builds the same rect regardless of which corner is the drag origin', () => {
    const downRight = rectFromPoints({ x: 10, y: 10 }, { x: 50, y: 40 });
    const upLeft = rectFromPoints({ x: 50, y: 40 }, { x: 10, y: 10 });
    const expected = { left: 10, top: 10, width: 40, height: 30 };
    expect(downRight).toEqual(expected);
    expect(upLeft).toEqual(expected);
  });

  it('handles a diagonal in the other two directions too', () => {
    expect(rectFromPoints({ x: 100, y: 10 }, { x: 40, y: 70 })).toEqual({
      left: 40,
      top: 10,
      width: 60,
      height: 60,
    });
  });

  it('a zero-movement press is a zero-area rect, not an error', () => {
    expect(rectFromPoints({ x: 5, y: 5 }, { x: 5, y: 5 })).toEqual({ left: 5, top: 5, width: 0, height: 0 });
  });
});

describe('rectsIntersect', () => {
  it('detects a plain overlap', () => {
    const a = { left: 0, top: 0, width: 20, height: 20 };
    const b = { left: 10, top: 10, width: 20, height: 20 };
    expect(rectsIntersect(a, b)).toBe(true);
  });

  it('detects full containment either way round', () => {
    const outer = { left: 0, top: 0, width: 100, height: 100 };
    const inner = { left: 40, top: 40, width: 10, height: 10 };
    expect(rectsIntersect(outer, inner)).toBe(true);
    expect(rectsIntersect(inner, outer)).toBe(true);
  });

  it('misses on the horizontal axis alone', () => {
    const a = { left: 0, top: 0, width: 10, height: 100 };
    const b = { left: 20, top: 0, width: 10, height: 100 };
    expect(rectsIntersect(a, b)).toBe(false);
  });

  it('misses on the vertical axis alone', () => {
    const a = { left: 0, top: 0, width: 100, height: 10 };
    const b = { left: 0, top: 20, width: 100, height: 10 };
    expect(rectsIntersect(a, b)).toBe(false);
  });

  it('an exact edge-touch (open interval) does not count as an intersection', () => {
    const a = { left: 0, top: 0, width: 10, height: 10 };
    const b = { left: 10, top: 0, width: 10, height: 10 }; // shares the x=10 edge exactly
    expect(rectsIntersect(a, b)).toBe(false);
  });

  it('a zero-area rect grazing an edge does not count (marquee sub-pixel press)', () => {
    const a = { left: 5, top: 5, width: 0, height: 0 };
    const b = { left: 0, top: 0, width: 10, height: 10 };
    // a zero-width/height rect at (5,5) is strictly inside (0,0)-(10,10) on
    // open intervals, so this one DOES intersect — the true "graze" case is
    // the edge-touch test above, at exactly the boundary.
    expect(rectsIntersect(a, b)).toBe(true);
  });
});

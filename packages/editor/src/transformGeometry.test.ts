// @chroma/editor — unit tests for TransformOverlay's pure geometry (D-136,
// Phase 1 of `docs/notes/on-canvas-transform.md`). See `transformGeometry.ts`'s
// module doc for why this is a separate, DOM-free file.
import { describe, expect, it } from 'vitest';
import {
  MIN_DRAG_SCALE,
  boxToScreenRect,
  clipBoxFraction,
  dragCornerScale,
  dragReposition,
  fractionBoxContains,
  resolvedBoxSize,
  screenToFraction,
} from './transformGeometry';

describe('clipBoxFraction', () => {
  it('centres a full-frame, unscaled, unoffset clip exactly on the composition', () => {
    const box = clipBoxFraction({ width: 1, height: 1 }, { x: 0, y: 0 }, 1);
    expect(box).toEqual({ left: 0, top: 0, width: 1, height: 1 });
  });

  it('a smaller source sits centred, with equal margin on every side', () => {
    // a 0.4-wide, 0.3-tall natural footprint, unscaled, unoffset
    const box = clipBoxFraction({ width: 0.4, height: 0.3 }, { x: 0, y: 0 }, 1);
    expect(box.width).toBeCloseTo(0.4);
    expect(box.height).toBeCloseTo(0.3);
    expect(box.left).toBeCloseTo(0.3); // (1 - 0.4) / 2
    expect(box.top).toBeCloseTo(0.35); // (1 - 0.3) / 2
  });

  it('scale grows the box about its own centre, not the composition corner', () => {
    const natural = { width: 0.5, height: 0.5 };
    const position = { x: 0.1, y: -0.1 };
    const a = clipBoxFraction(natural, position, 1);
    const b = clipBoxFraction(natural, position, 2);
    const centerA = { x: a.left + a.width / 2, y: a.top + a.height / 2 };
    const centerB = { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    expect(centerB.x).toBeCloseTo(centerA.x);
    expect(centerB.y).toBeCloseTo(centerA.y);
    expect(b.width).toBeCloseTo(a.width * 2);
    expect(b.height).toBeCloseTo(a.height * 2);
  });

  it('position offsets the box by exactly that fraction, on top of centring', () => {
    const box = clipBoxFraction({ width: 0.2, height: 0.2 }, { x: 0.25, y: -0.1 }, 1);
    // centred would be left=0.4,top=0.4; offset by +0.25 x, -0.1 y
    expect(box.left).toBeCloseTo(0.65);
    expect(box.top).toBeCloseTo(0.3);
  });
});

describe('boxToScreenRect / screenToFraction', () => {
  const contentBox = { offsetX: 10, offsetY: 20, width: 200, height: 100 };

  it('boxToScreenRect places a full-frame box exactly over the content box', () => {
    const rect = boxToScreenRect({ left: 0, top: 0, width: 1, height: 1 }, contentBox);
    expect(rect).toEqual({ left: 10, top: 20, width: 200, height: 100 });
  });

  it('boxToScreenRect and screenToFraction are inverses at the box center', () => {
    const box = { left: 0.25, top: 0.25, width: 0.5, height: 0.5 };
    const rect = boxToScreenRect(box, contentBox);
    const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    const frac = screenToFraction(center, contentBox);
    expect(frac.x).toBeCloseTo(0.5);
    expect(frac.y).toBeCloseTo(0.5);
  });

  it('screenToFraction is 0,0 at the content box origin and 1,1 at its far corner', () => {
    expect(screenToFraction({ x: 10, y: 20 }, contentBox)).toEqual({ x: 0, y: 0 });
    expect(screenToFraction({ x: 210, y: 120 }, contentBox)).toEqual({ x: 1, y: 1 });
  });

  it('screenToFraction degrades to 0 rather than dividing by zero on an empty content box', () => {
    const empty = { offsetX: 0, offsetY: 0, width: 0, height: 0 };
    expect(screenToFraction({ x: 5, y: 5 }, empty)).toEqual({ x: 0, y: 0 });
  });
});

describe('dragReposition', () => {
  it('is a no-op when the pointer has not moved', () => {
    const p = { x: 0.3, y: 0.4 };
    expect(dragReposition(p, p, { x: 0.1, y: -0.1 })).toEqual({ x: 0.1, y: -0.1 });
  });

  it('shifts the start position by exactly the pointer delta', () => {
    const start = { x: 0.2, y: 0.2 };
    const current = { x: 0.35, y: 0.1 };
    const result = dragReposition(start, current, { x: 0, y: 0 });
    expect(result.x).toBeCloseTo(0.15);
    expect(result.y).toBeCloseTo(-0.1);
  });

  it('does not snap the box to the pointer — grabbing off-centre preserves the offset', () => {
    // grabbed 0.1 to the right of the box's own position; dragging the
    // pointer by +0.2 must move the box by +0.2, not put the box AT the
    // pointer (which would also jump it by the initial 0.1 grab offset).
    const grabPoint = { x: 0.6, y: 0.5 };
    const startPosition = { x: 0.5, y: 0.5 }; // box "position" independent of where it was grabbed
    const afterDrag = { x: grabPoint.x + 0.2, y: grabPoint.y };
    const result = dragReposition(grabPoint, afterDrag, startPosition);
    expect(result.x).toBeCloseTo(0.7);
    expect(result.y).toBeCloseTo(0.5);
  });
});

describe('dragCornerScale', () => {
  const center = { x: 0.5, y: 0.5 };

  it('is a no-op when the pointer has not moved', () => {
    const corner = { x: 0.7, y: 0.7 };
    expect(dragCornerScale(center, corner, corner, 1)).toBeCloseTo(1);
  });

  it('doubling the distance from the centre doubles the scale', () => {
    const startCorner = { x: 0.6, y: 0.5 }; // distance 0.1 from center
    const currentCorner = { x: 0.7, y: 0.5 }; // distance 0.2 from center
    expect(dragCornerScale(center, startCorner, currentCorner, 1)).toBeCloseTo(2);
  });

  it('dragging toward the centre shrinks the scale proportionally', () => {
    const startCorner = { x: 0.6, y: 0.5 };
    const currentCorner = { x: 0.55, y: 0.5 }; // half the original distance
    expect(dragCornerScale(center, startCorner, currentCorner, 2)).toBeCloseTo(1);
  });

  it('never returns below MIN_DRAG_SCALE, even dragging past the centre', () => {
    const startCorner = { x: 0.6, y: 0.5 };
    const collapsed = dragCornerScale(center, startCorner, center, 1);
    expect(collapsed).toBe(MIN_DRAG_SCALE);
  });

  it('a degenerate (zero-distance) start corner returns the unchanged start scale', () => {
    // the drag can't have started ON the pivot in practice (nothing to grab
    // there), but this guards the division rather than producing NaN/Infinity.
    expect(dragCornerScale(center, center, { x: 0.9, y: 0.9 }, 1.5)).toBe(1.5);
  });
});

// D-202 (B-085) — the two helpers `TransformOverlay`'s at-rest box and
// `canvasPick.ts`'s hit rect now share, so a click can never select a clip
// whose handles then draw somewhere else.
describe('resolvedBoxSize', () => {
  const natural = { width: 0.5, height: 0.25 };

  it('is natural × scale on both axes with no override', () => {
    expect(resolvedBoxSize(natural, 2, {})).toEqual({ width: 1, height: 0.5 });
  });

  it('lets an override win per axis, independently (D-193)', () => {
    expect(resolvedBoxSize(natural, 2, { width: 0.8 })).toEqual({ width: 0.8, height: 0.5 });
    expect(resolvedBoxSize(natural, 2, { height: 0.1 })).toEqual({ width: 1, height: 0.1 });
  });

  it('treats a null/undefined override as absent, not as zero', () => {
    expect(resolvedBoxSize(natural, 1, { width: null, height: undefined })).toEqual(natural);
  });

  it('honours an override of exactly 0 rather than falling back to scale', () => {
    // `??`, not `||` — a deliberately collapsed axis must stay collapsed.
    expect(resolvedBoxSize(natural, 1, { width: 0 }).width).toBe(0);
  });
});

describe('fractionBoxContains', () => {
  // Binary-exact edges (0.25 / 0.5 / 0.75) on purpose: an edge assertion
  // written with values like 0.2 + 0.4 tests floating-point representation,
  // not the containment rule.
  const box = { left: 0.25, top: 0.25, width: 0.5, height: 0.25 };

  it('contains an interior point', () => {
    expect(fractionBoxContains(box, { x: 0.5, y: 0.375 })).toBe(true);
  });

  it('includes the top-left edge and excludes the bottom-right one (half-open)', () => {
    expect(fractionBoxContains(box, { x: 0.25, y: 0.25 })).toBe(true);
    expect(fractionBoxContains(box, { x: 0.75, y: 0.375 })).toBe(false);
    expect(fractionBoxContains(box, { x: 0.5, y: 0.5 })).toBe(false);
  });

  it('rejects a point outside on either axis alone', () => {
    expect(fractionBoxContains(box, { x: 0.1, y: 0.375 })).toBe(false);
    expect(fractionBoxContains(box, { x: 0.5, y: 0.1 })).toBe(false);
  });
});

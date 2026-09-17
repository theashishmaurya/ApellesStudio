// @apelles/editor — unit tests for TransformOverlay's pure geometry (D-136,
// Phase 1 of `docs/notes/on-canvas-transform.md`). See `transformGeometry.ts`'s
// module doc for why this is a separate, DOM-free file.
import { describe, expect, it } from 'vitest';
import {
  MIN_DRAG_SCALE,
  boxToScreenRect,
  clipBoxFraction,
  dragCornerReposition,
  dragCornerScale,
  dragReposition,
  fractionBoxContains,
  resolvedBoxSize,
  scaleFractionBoxAbout,
  screenToFraction,
  translateFractionBox,
} from './transformGeometry';

describe('clipBoxFraction', () => {
  it('places a full-frame, unscaled, unoffset clip exactly over the composition', () => {
    const box = clipBoxFraction({ width: 1, height: 1 }, { x: 0, y: 0 }, 1);
    expect(box).toEqual({ left: 0, top: 0, width: 1, height: 1 });
  });

  // D-338 (B-201) — `position` IS the box's top-left corner, so a smaller
  // source at position 0,0 sits in the composition's top-left corner rather
  // than centred. That is what ffmpeg's `overlay=x='0*W':y='0*H'` does, and
  // since D-338 what `composite_layer_onto` does too.
  it('a smaller source sits at the composition origin, not centred', () => {
    // a 0.4-wide, 0.3-tall natural footprint, unscaled, unoffset
    const box = clipBoxFraction({ width: 0.4, height: 0.3 }, { x: 0, y: 0 }, 1);
    expect(box.width).toBeCloseTo(0.4);
    expect(box.height).toBeCloseTo(0.3);
    expect(box.left).toBeCloseTo(0);
    expect(box.top).toBeCloseTo(0);
  });

  it('scale grows the box about its own TOP-LEFT corner, which never moves', () => {
    const natural = { width: 0.5, height: 0.5 };
    const position = { x: 0.1, y: 0.1 };
    const a = clipBoxFraction(natural, position, 1);
    const b = clipBoxFraction(natural, position, 2);
    expect(b.left).toBeCloseTo(a.left);
    expect(b.top).toBeCloseTo(a.top);
    expect(b.width).toBeCloseTo(a.width * 2);
    expect(b.height).toBeCloseTo(a.height * 2);
  });

  it('position is the box corner verbatim, with no centring term', () => {
    const box = clipBoxFraction({ width: 0.2, height: 0.2 }, { x: 0.25, y: 0.1 }, 1);
    expect(box.left).toBeCloseTo(0.25);
    expect(box.top).toBeCloseTo(0.1);
  });

  it('the box size never enters into where the box starts', () => {
    // The pre-D-338 formula had `left = 0.5 - width/2 + position.x`, so a
    // wider box started further left for the same position. B-201 is exactly
    // that term; this pins its absence.
    const position = { x: 0.2, y: 0.3 };
    const narrow = clipBoxFraction({ width: 0.1, height: 0.1 }, position, 1);
    const wide = clipBoxFraction({ width: 0.9, height: 0.8 }, position, 1);
    expect(narrow.left).toBeCloseTo(wide.left);
    expect(narrow.top).toBeCloseTo(wide.top);
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

// D-338 (B-201) — the position half of the same gesture. A box is anchored at
// its top-left corner now, so holding its centre still while `scale` changes
// takes an explicit compensating shift; without one, every corner drag would
// slide the picture down and to the right by half the size change.
describe('dragCornerReposition', () => {
  const natural = { width: 0.4, height: 0.2 };

  it('is exactly a no-op when the scale did not change', () => {
    const start = { x: 0.3, y: 0.25 };
    expect(dragCornerReposition(start, natural, 1.5, 1.5)).toEqual(start);
  });

  it('keeps the box centre exactly where it was, growing and shrinking', () => {
    const start = { x: 0.3, y: 0.25 };
    const centreOf = (position: { x: number; y: number }, scale: number) => ({
      x: position.x + (natural.width * scale) / 2,
      y: position.y + (natural.height * scale) / 2,
    });
    const before = centreOf(start, 1);
    for (const scale of [2, 0.5, 1.37]) {
      const after = centreOf(dragCornerReposition(start, natural, 1, scale), scale);
      expect(after.x).toBeCloseTo(before.x);
      expect(after.y).toBeCloseTo(before.y);
    }
  });

  it('shifts each axis by half that axis own size change, per axis', () => {
    // 1 -> 2 on a 0.4 x 0.2 footprint: x by -0.2, y by -0.1. Per axis, like
    // every other geometry field here (see `position_is_normalised_per_axis`
    // on the Rust side).
    const moved = dragCornerReposition({ x: 0, y: 0 }, natural, 1, 2);
    expect(moved.x).toBeCloseTo(-0.2);
    expect(moved.y).toBeCloseTo(-0.1);
  });

  it('telescopes: the same end scale lands in the same place however it was reached', () => {
    // `TransformBox` calls this from the GESTURE's start on every pointermove,
    // never from the last frame's values. This pins that the two are equivalent
    // — a drag through 1.5 on the way to 2 ends exactly where a drag straight
    // to 2 does — so a caller that re-bases mid-gesture cannot drift the
    // picture, and the accumulate-twice bug has no room to exist.
    const start = { x: 0.3, y: 0.25 };
    const direct = dragCornerReposition(start, natural, 1, 2);
    const viaMidpoint = dragCornerReposition(dragCornerReposition(start, natural, 1, 1.5), natural, 1.5, 2);
    expect(viaMidpoint.x).toBeCloseTo(direct.x);
    expect(viaMidpoint.y).toBeCloseTo(direct.y);
  });
});

// D-204 (B-085) — the two helpers `TransformOverlay`'s at-rest box and
// `canvasPick.ts`'s hit rect now share, so a click can never select a clip
// whose handles then draw somewhere else.
describe('resolvedBoxSize', () => {
  const natural = { width: 0.5, height: 0.25 };

  it('is natural × scale on both axes with no override', () => {
    expect(resolvedBoxSize(natural, 2, {})).toEqual({ width: 1, height: 0.5 });
  });

  it('lets an override win per axis, independently (D-193)', () => {
    // B-223 — a `box_width` with no `box_height` keeps the box's own ASPECT
    // RATIO (0.8 wide × 0.5:0.25 → 0.4), which is what `scale=w=...:h=-2`
    // produces in the export and what `ClipTransform::effective_size` now
    // computes in the preview. It used to be `natural.height * scale` here,
    // and that number was never what either engine rendered.
    expect(resolvedBoxSize(natural, 2, { width: 0.8 })).toEqual({ width: 0.8, height: 0.4 });
    expect(resolvedBoxSize(natural, 2, { height: 0.1 })).toEqual({ width: 1, height: 0.1 });
  });

  it('derives an unoverridden height from the CROPPED aspect ratio (B-218)', () => {
    // Half the width cropped away -> the kept picture is twice as tall
    // relative to its width, so the same 1.0-wide box is 1.0 tall, not 0.5.
    expect(resolvedBoxSize(natural, 2, {}, { left: 0.25, right: 0.25 })).toEqual({ width: 1, height: 1 });
    // ...and an explicit `box_height` still wins outright over any crop.
    expect(resolvedBoxSize(natural, 2, { height: 0.3 }, { left: 0.25, right: 0.25 })).toEqual({
      width: 1,
      height: 0.3,
    });
  });

  it('is unchanged by absent/zero crop insets (B-218 safety)', () => {
    expect(resolvedBoxSize(natural, 2, {}, {})).toEqual(resolvedBoxSize(natural, 2, {}));
    expect(resolvedBoxSize(natural, 2, {}, { left: 0, top: 0, right: 0, bottom: 0 })).toEqual({
      width: 1,
      height: 0.5,
    });
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

// -------------------------------------------------------------------------- //
// D-316 — the two box transforms a MEASURED box (a caption's) needs, which a
// derived box (a video clip's) does not: its rectangle cannot be recomputed
// from the dragged values, so the gesture is applied to the rectangle itself.
// -------------------------------------------------------------------------- //

describe('translateFractionBox', () => {
  const box = { left: 0.25, top: 0.5, width: 0.5, height: 0.25 };

  it('moves the box and leaves its size alone', () => {
    expect(translateFractionBox(box, { x: 0.1, y: -0.25 })).toEqual({
      left: 0.35,
      top: 0.25,
      width: 0.5,
      height: 0.25,
    });
  });

  it('is the identity for a zero delta', () => {
    expect(translateFractionBox(box, { x: 0, y: 0 })).toEqual(box);
  });
});

describe('scaleFractionBoxAbout', () => {
  // The caption case: the pivot is the style anchor, which for a centred
  // subtitle is the bottom-CENTRE of the box.
  const box = { left: 0.25, top: 0.5, width: 0.5, height: 0.25 };
  const pivot = { x: 0.5, y: 0.75 };

  it('leaves the pivot exactly where it is', () => {
    const doubled = scaleFractionBoxAbout(box, pivot, 2);
    // The pivot was the bottom-centre; it still is.
    expect(doubled.left + doubled.width / 2).toBeCloseTo(pivot.x, 12);
    expect(doubled.top + doubled.height).toBeCloseTo(pivot.y, 12);
  });

  it('scales both dimensions by the factor', () => {
    const doubled = scaleFractionBoxAbout(box, pivot, 2);
    expect(doubled.width).toBeCloseTo(1, 12);
    expect(doubled.height).toBeCloseTo(0.5, 12);
    expect(doubled.left).toBeCloseTo(0, 12);
    expect(doubled.top).toBeCloseTo(0.25, 12);
  });

  it('shrinks about the same pivot', () => {
    const half = scaleFractionBoxAbout(box, pivot, 0.5);
    expect(half.width).toBeCloseTo(0.25, 12);
    expect(half.left + half.width / 2).toBeCloseTo(pivot.x, 12);
    expect(half.top + half.height).toBeCloseTo(pivot.y, 12);
  });

  it('is the identity for a factor of 1, and for a non-finite one', () => {
    expect(scaleFractionBoxAbout(box, pivot, 1)).toEqual(box);
    // A drag whose start distance was zero can only produce garbage; the box
    // must stay put rather than becoming NaN and vanishing from the DOM.
    expect(scaleFractionBoxAbout(box, pivot, Number.NaN)).toEqual(box);
  });
});

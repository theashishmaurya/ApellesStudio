/**
 * @apelles/editor — unit coverage for anchored timeline zoom (B-116).
 *
 * The invariant this feature IS: after a zoom, the frame that was under the
 * anchor is still under the anchor. That is a round-trip through the two
 * functions, so it is asserted as one — at many zoom levels, many scroll
 * offsets and many anchor positions, rather than at one hand-picked example
 * that could pass by coincidence.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  PINCH_MAX_DELTA_PX,
  buttonZoomAnchorX,
  createZoomCoalescer,
  frameAtViewportX,
  gestureZoomFactor,
  pinchZoomFactor,
  scrollLeftForAnchor,
} from './timelineZoom';
import { MIN_PX_PER_SEC, MAX_PX_PER_SEC, DEFAULT_PX_PER_SEC } from './ruler';

const FPS = 24;
const START_LEFT = 20; // `TimelinePane.tsx`'s own START_LEFT_PX
const VIEWPORT = 1200;

describe('frameAtViewportX', () => {
  it('reads the frame under an x using the same equation the ruler and playhead use', () => {
    // startLeft + frame/fps*pxPerSec - scrollLeft = x  →  x=110, scrollLeft=0,
    // pxPerSec=90 puts frame (110-20)/90*24 = 24 under the cursor.
    expect(frameAtViewportX(110, FPS, 90, 0, START_LEFT)).toBeCloseTo(24, 10);
  });

  it('accounts for the horizontal scroll', () => {
    // The same screen x with the timeline scrolled 90px (1s) right is one
    // second later in the edit.
    expect(frameAtViewportX(110, FPS, 90, 90, START_LEFT)).toBeCloseTo(48, 10);
  });

  it('is deliberately unrounded — an anchor is not a frame the user picked', () => {
    // Half a frame at this zoom is ~1.9px; rounding here would quantise every
    // zoom step to that, which is the visible drift this module removes.
    expect(frameAtViewportX(112, FPS, 90, 0, START_LEFT)).not.toBe(Math.round(frameAtViewportX(112, FPS, 90, 0, START_LEFT)));
  });
});

describe('scrollLeftForAnchor', () => {
  it('is the exact inverse of frameAtViewportX at the same zoom', () => {
    const frame = frameAtViewportX(500, FPS, 90, 240, START_LEFT);
    expect(scrollLeftForAnchor(frame, 500, FPS, 90, START_LEFT)).toBeCloseTo(240, 8);
  });

  it('never asks for a negative scroll — the timeline starts at 0', () => {
    // Anchoring frame 0 at x=400 would want scrollLeft = 20 - 400 = -380.
    expect(scrollLeftForAnchor(0, 400, FPS, 90, START_LEFT)).toBe(0);
  });
});

describe('the round trip — the frame under the anchor does not move', () => {
  const zooms = [MIN_PX_PER_SEC, 8, 30, DEFAULT_PX_PER_SEC, 160, 320, MAX_PX_PER_SEC];
  const scrolls = [0, 37, 240, 5000];
  const anchors = [0, 1, 137, 600, VIEWPORT - 1];

  it('holds across every zoom / scroll / anchor combination', () => {
    for (const before of zooms) {
      for (const after of zooms) {
        for (const scrollLeft of scrolls) {
          for (const anchorX of anchors) {
            const frame = frameAtViewportX(anchorX, FPS, before, scrollLeft, START_LEFT);
            // What holding the anchor would REQUIRE, before the clamp.
            const wanted = START_LEFT + (frame / FPS) * after - anchorX;
            const nextScroll = scrollLeftForAnchor(frame, anchorX, FPS, after, START_LEFT);
            if (wanted >= 0) {
              // The normal case, and the whole point: the anchored frame is
              // exactly where it was.
              const landedX = START_LEFT + (frame / FPS) * after - nextScroll;
              expect(landedX).toBeCloseTo(anchorX, 6);
            } else {
              // The one case that legitimately cannot hold the anchor: holding
              // it would need a NEGATIVE scroll, which is not a position the
              // container can be in (the anchor is in the `startLeft` gutter
              // before frame 0, or so near it that the zoom-out pushes it
              // there). The documented fallback is to pin to the timeline's
              // start — which is also all the user could see moving, since the
              // view is already hard against its left edge.
              expect(nextScroll).toBe(0);
            }
          }
        }
      }
    }
  });

  it('a zoom that changes nothing moves nothing', () => {
    const frame = frameAtViewportX(742, FPS, 137, 900, START_LEFT);
    expect(scrollLeftForAnchor(frame, 742, FPS, 137, START_LEFT)).toBeCloseTo(900, 8);
  });
});

describe('buttonZoomAnchorX — the anchor a +/- press has no cursor for', () => {
  it('is the playhead’s own x while the playhead is on screen', () => {
    // Frame 240 == 10s == 900px at 90px/s, scrolled 100 → x = 20+900-100 = 820.
    expect(buttonZoomAnchorX(240, FPS, 90, 100, START_LEFT, VIEWPORT)).toBeCloseTo(820, 10);
  });

  it('falls back to the viewport centre when the playhead is off to the right', () => {
    // Frame 2400 == 100s == 9000px: far past a 1200px viewport.
    expect(buttonZoomAnchorX(2400, FPS, 90, 0, START_LEFT, VIEWPORT)).toBe(VIEWPORT / 2);
  });

  it('falls back to the viewport centre when the playhead is scrolled off to the left', () => {
    expect(buttonZoomAnchorX(0, FPS, 90, 5000, START_LEFT, VIEWPORT)).toBe(VIEWPORT / 2);
  });

  it('counts the exact edges as on screen — a playhead at x=0 is still visible', () => {
    // scrollLeft chosen so the playhead lands exactly at x = 0.
    const scrollLeft = START_LEFT + (240 / FPS) * 90;
    expect(buttonZoomAnchorX(240, FPS, 90, scrollLeft, START_LEFT, VIEWPORT)).toBe(0);
  });
});

describe('pinchZoomFactor (B-375)', () => {
  it('is proportional: a bigger delta zooms more, the sign picks the direction', () => {
    expect(pinchZoomFactor(0)).toBe(1);
    expect(pinchZoomFactor(-2)).toBeGreaterThan(1);
    expect(pinchZoomFactor(2)).toBeLessThan(1);
    expect(pinchZoomFactor(-10)).toBeGreaterThan(pinchZoomFactor(-2));
    expect(pinchZoomFactor(10)).toBeLessThan(pinchZoomFactor(2));
  });
  it('is exponential: N small events equal one event of the summed delta, and in then out cancels', () => {
    const many = Array.from({ length: 10 }, () => pinchZoomFactor(-2)).reduce((a, b) => a * b, 1);
    expect(many).toBeCloseTo(pinchZoomFactor(-20), 9);
    expect(pinchZoomFactor(-7) * pinchZoomFactor(7)).toBeCloseTo(1, 12);
  });
  it('clamps a single event so a mouse-wheel notch is a step, not a jump', () => {
    expect(pinchZoomFactor(-120)).toBe(pinchZoomFactor(-PINCH_MAX_DELTA_PX));
    expect(pinchZoomFactor(1e6)).toBe(pinchZoomFactor(PINCH_MAX_DELTA_PX));
  });
  it('reads line and page delta modes in scaled units', () => {
    expect(pinchZoomFactor(-1, 1)).toBeCloseTo(pinchZoomFactor(-16), 12);
    expect(pinchZoomFactor(-1, 2)).toBe(pinchZoomFactor(-PINCH_MAX_DELTA_PX));
  });
});

describe('gestureZoomFactor (B-387)', () => {
  it('is the ratio to the previous scale, so a whole gesture multiplies to its own total', () => {
    // WebKit reports the scale cumulatively: 1 → 1.2 → 1.5 is a 1.5× pinch.
    const steps = [1.2, 1.5];
    let prev = 1;
    let total = 1;
    for (const scale of steps) {
      const factor = gestureZoomFactor(scale, prev);
      expect(factor).not.toBeNull();
      total *= factor as number;
      prev = scale;
    }
    expect(total).toBeCloseTo(1.5, 12);
  });
  it('a pinch in and a pinch back out cancel', () => {
    const inFactor = gestureZoomFactor(2, 1) as number;
    const outFactor = gestureZoomFactor(1, 2) as number;
    expect(inFactor * outFactor).toBeCloseTo(1, 12);
  });
  it('refuses a scale that would drive pxPerSec to zero, NaN or negative', () => {
    expect(gestureZoomFactor(0, 1)).toBeNull();
    expect(gestureZoomFactor(1, 0)).toBeNull();
    expect(gestureZoomFactor(-1, 1)).toBeNull();
    expect(gestureZoomFactor(Number.NaN, 1)).toBeNull();
    expect(gestureZoomFactor(1, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('createZoomCoalescer (B-375, D-437 S8)', () => {
  function fakeRaf() {
    const queue: Array<() => void> = [];
    return {
      raf: (cb: () => void) => queue.push(cb),
      caf: vi.fn(),
      frame: () => queue.splice(0).forEach((cb) => cb()),
      pending: () => queue.length,
    };
  }
  it('N events in a frame make ONE flush with the product of the factors and the last anchor', () => {
    const f = fakeRaf();
    const flush = vi.fn();
    const z = createZoomCoalescer(flush, f.raf, f.caf);
    for (let i = 0; i < 6; i++) z.push(pinchZoomFactor(-3), 100 + i);
    expect(flush).not.toHaveBeenCalled();
    expect(f.pending()).toBe(1);
    f.frame();
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush.mock.calls[0][0]).toBeCloseTo(pinchZoomFactor(-18), 9);
    expect(flush.mock.calls[0][1]).toBe(105);
    // The next frame starts fresh.
    z.push(pinchZoomFactor(3), 7);
    f.frame();
    expect(flush).toHaveBeenCalledTimes(2);
    expect(flush.mock.calls[1][1]).toBe(7);
  });
  it('does not flush when the frame\'s events cancel out', () => {
    const f = fakeRaf();
    const flush = vi.fn();
    const z = createZoomCoalescer(flush, f.raf, f.caf);
    z.push(pinchZoomFactor(-5), 1);
    z.push(pinchZoomFactor(5), 1);
    f.frame();
    expect(flush).not.toHaveBeenCalled();
  });
  it('the anchor survives the batch: the frame under the last pointer x holds still', () => {
    const f = fakeRaf();
    let pxPerSec = 100;
    let scroll = 400;
    const flush = vi.fn((factor: number, x: number) => {
      const frame = frameAtViewportX(x, 30, pxPerSec, scroll, 0);
      pxPerSec *= factor;
      scroll = scrollLeftForAnchor(frame, x, 30, pxPerSec, 0);
      expect(frameAtViewportX(x, 30, pxPerSec, scroll, 0)).toBeCloseTo(frame, 6);
    });
    const z = createZoomCoalescer(flush, f.raf, f.caf);
    z.push(pinchZoomFactor(-4), 200);
    z.push(pinchZoomFactor(-4), 260);
    f.frame();
    expect(flush).toHaveBeenCalledTimes(1);
  });
  it('cancel drops the pending batch', () => {
    const f = fakeRaf();
    const flush = vi.fn();
    const z = createZoomCoalescer(flush, f.raf, f.caf);
    z.push(2, 1);
    z.cancel();
    expect(f.caf).toHaveBeenCalled();
    z.push(1.5, 1);
    f.frame();
    expect(flush.mock.calls.at(-1)?.[0]).toBe(1.5);
  });
});

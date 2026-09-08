/**
 * @chroma/editor — unit coverage for anchored timeline zoom (B-116).
 *
 * The invariant this feature IS: after a zoom, the frame that was under the
 * anchor is still under the anchor. That is a round-trip through the two
 * functions, so it is asserted as one — at many zoom levels, many scroll
 * offsets and many anchor positions, rather than at one hand-picked example
 * that could pass by coincidence.
 */

import { describe, expect, it } from 'vitest';

import { buttonZoomAnchorX, frameAtViewportX, scrollLeftForAnchor } from './timelineZoom';
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

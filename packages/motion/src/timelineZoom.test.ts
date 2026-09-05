// @chroma/motion — unit tests for `KeyframeTimeline.tsx`'s own new zoom
// mechanism (D-162, Phase 5b part 2 — "independent zoom", §4 of the parent
// research doc). See `timelineZoom.ts`'s module doc comment for why these
// bounds are new/local rather than reused from `packages/editor/src/
// ruler.ts`'s own D-134 zoom system.
import { describe, expect, it } from 'vitest';
import {
  MIN_PX_PER_SEC,
  MAX_PX_PER_SEC,
  DEFAULT_PX_PER_SEC,
  clampPxPerSecond,
  zoomStep,
  trackWidthPx,
  pxDeltaToSeconds,
} from './timelineZoom';

describe('clampPxPerSecond', () => {
  it('passes a value already inside the bounds through unchanged', () => {
    expect(clampPxPerSecond(DEFAULT_PX_PER_SEC)).toBe(DEFAULT_PX_PER_SEC);
  });

  it('clamps below MIN_PX_PER_SEC up to it', () => {
    expect(clampPxPerSecond(0.5)).toBe(MIN_PX_PER_SEC);
  });

  it('clamps above MAX_PX_PER_SEC down to it', () => {
    expect(clampPxPerSecond(999999)).toBe(MAX_PX_PER_SEC);
  });

  it('treats a non-positive value as the minimum rather than NaN/negative', () => {
    expect(clampPxPerSecond(0)).toBe(MIN_PX_PER_SEC);
    expect(clampPxPerSecond(-10)).toBe(MIN_PX_PER_SEC);
  });
});

describe('zoomStep', () => {
  it('zooming in (direction 1) increases pxPerSecond', () => {
    expect(zoomStep(DEFAULT_PX_PER_SEC, 1)).toBeGreaterThan(DEFAULT_PX_PER_SEC);
  });

  it('zooming out (direction -1) decreases pxPerSecond', () => {
    expect(zoomStep(DEFAULT_PX_PER_SEC, -1)).toBeLessThan(DEFAULT_PX_PER_SEC);
  });

  it('never zooms in past MAX_PX_PER_SEC', () => {
    expect(zoomStep(MAX_PX_PER_SEC, 1)).toBe(MAX_PX_PER_SEC);
  });

  it('never zooms out past MIN_PX_PER_SEC', () => {
    expect(zoomStep(MIN_PX_PER_SEC, -1)).toBe(MIN_PX_PER_SEC);
  });

  it('zooming in then out by the same step returns close to the original value', () => {
    const zoomedIn = zoomStep(DEFAULT_PX_PER_SEC, 1);
    const backOut = zoomStep(zoomedIn, -1);
    expect(backOut).toBeCloseTo(DEFAULT_PX_PER_SEC, 10);
  });
});

describe('trackWidthPx', () => {
  it('computes (totalFrames / fps) * pxPerSecond', () => {
    // 300 frames at 30fps = 10s; at 70px/sec that is 700px.
    expect(trackWidthPx(300, 30, 70)).toBe(700);
  });

  it('scales linearly with pxPerSecond — doubling zoom doubles the width', () => {
    const base = trackWidthPx(300, 30, 70);
    expect(trackWidthPx(300, 30, 140)).toBeCloseTo(base * 2, 10);
  });

  it('is 0 for a non-positive totalFrames, fps, or pxPerSecond', () => {
    expect(trackWidthPx(0, 30, 70)).toBe(0);
    expect(trackWidthPx(300, 0, 70)).toBe(0);
    expect(trackWidthPx(300, 30, 0)).toBe(0);
    expect(trackWidthPx(-10, 30, 70)).toBe(0);
  });
});

// Phase 5b — box-select + nudge multiple keys: `pxDeltaToSeconds` is the
// nudge gesture's own "how far in TIME did the pointer move" arithmetic —
// see `KeyframeTimeline.tsx`'s module doc comment for why a shared
// `pxPerSecond` axis lets this be pure pixel math with no per-lane frame
// lookup at all.
describe('pxDeltaToSeconds', () => {
  it('converts a pixel distance to seconds at the given zoom', () => {
    // 70px at 70px/sec = 1 second exactly.
    expect(pxDeltaToSeconds(70, 70, 30)).toBe(1);
  });

  it('rounds to the nearest whole FRAME, not an arbitrary sub-frame float', () => {
    // 35px at 70px/sec = 0.5s = 15 frames at 30fps — exact, no rounding needed.
    expect(pxDeltaToSeconds(35, 70, 30)).toBe(0.5);
    // a tiny nudge under half a frame's worth of pixels rounds DOWN to 0.
    expect(pxDeltaToSeconds(1, 70, 30)).toBe(0);
  });

  it('a negative pixel delta produces a negative seconds delta', () => {
    expect(pxDeltaToSeconds(-70, 70, 30)).toBe(-1);
  });

  it('a zero pixel delta is exactly zero seconds', () => {
    expect(pxDeltaToSeconds(0, 70, 30)).toBe(0);
  });

  it('is 0 for a non-positive pxPerSecond or fps, never NaN/Infinity', () => {
    expect(pxDeltaToSeconds(100, 0, 30)).toBe(0);
    expect(pxDeltaToSeconds(100, -70, 30)).toBe(0);
    expect(pxDeltaToSeconds(100, 70, 0)).toBe(0);
  });

  it('scales inversely with zoom — the same pixel distance means less time at a higher pxPerSecond', () => {
    const atLowZoom = pxDeltaToSeconds(100, 50, 30);
    const atHighZoom = pxDeltaToSeconds(100, 200, 30);
    expect(atHighZoom).toBeLessThan(atLowZoom);
  });
});

/**
 * @chroma/editor — the filmstrip's windowing arithmetic (D-128).
 *
 * These pin the property the whole feature rests on and the one D-124 could
 * not deliver: **at every zoom the UI allows, a tile is a real distinct
 * picture, never one frame stretched to fill a gap.** D-124's own tests
 * pinned the opposite split (what is fetched depends only on the clip, what
 * is drawn only on the width), which is exactly what capped the strip at 64
 * pictures and produced the smeared tiles the owner screenshotted next to
 * Palmier Pro's.
 *
 * Both clips used below are the owner's own, verbatim from the real project
 * at `~/Movies/Chroma/New.chroma/project.json` (24fps timeline: 166 frames =
 * 6.9167s, 12414 frames = 517.25s).
 */

import { describe, it, expect } from 'vitest';

import {
  LEVEL_STEPS_SECONDS,
  desiredStepSecs,
  quantizeStepSecs,
  requestWindow,
} from './Filmstrip';
import { MIN_PX_PER_SEC, MAX_PX_PER_SEC, DEFAULT_PX_PER_SEC } from './ruler';

const SR_SECS = 166 / 24; // "Screen Recording 2026-08-10 at 9.21.13 PM.mov"
const A001_SECS = 12414 / 24; // "A001_08302215_C019.MOV"
/** `Filmstrip.tsx`'s own tile density. */
const PX_PER_FRAME = 50;
/** A realistic timeline viewport width in px. */
const VIEWPORT = 1400;

/** Every zoom a real 1.2x wheel step can land on across the full range. */
function everyRealZoom(): number[] {
  const zooms: number[] = [];
  for (let z = MIN_PX_PER_SEC; z <= MAX_PX_PER_SEC; z *= 1.2) zooms.push(z);
  zooms.push(MAX_PX_PER_SEC);
  return zooms;
}

describe('quantizeStepSecs', () => {
  it('never rounds up — a coarser spacing than asked for is what stretches a tile', () => {
    for (const want of [0.104, 0.2, 0.31, 0.9, 1.7, 5, 40, 50]) {
      expect(quantizeStepSecs(want)).toBeLessThanOrEqual(want);
    }
  });

  it('stays on the ladder and clamps at both ends', () => {
    expect(LEVEL_STEPS_SECONDS).toContain(quantizeStepSecs(3));
    expect(quantizeStepSecs(0.0001)).toBe(LEVEL_STEPS_SECONDS[0]);
    expect(quantizeStepSecs(1e6)).toBe(LEVEL_STEPS_SECONDS[LEVEL_STEPS_SECONDS.length - 1]);
  });

  it('is defined for degenerate input rather than returning NaN', () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(Number.isFinite(quantizeStepSecs(bad))).toBe(true);
    }
  });
});

describe('desiredStepSecs', () => {
  it('asks for one tile per ~PX_PER_FRAME px, at any zoom', () => {
    for (const pxPerSec of everyRealZoom()) {
      const width = A001_SECS * pxPerSec;
      expect(desiredStepSecs(A001_SECS, width) * pxPerSec).toBeCloseTo(PX_PER_FRAME, 6);
    }
  });

  it('is defined for a clip with no width or no duration', () => {
    expect(Number.isFinite(desiredStepSecs(0, 100))).toBe(true);
    expect(Number.isFinite(desiredStepSecs(10, 0))).toBe(true);
  });
});

describe('requestWindow — the anti-stretch property', () => {
  /** On-screen width of one tile, given the window the component requests. */
  function tileWidthPx(durationSecs: number, pxPerSec: number): number {
    const width = durationSecs * pxPerSec;
    const w = requestWindow(0, durationSecs, width, 0, Math.min(width, VIEWPORT));
    expect(w).not.toBeNull();
    return (w as { stepSecs: number }).stepSecs * pxPerSec;
  }

  it('keeps every tile at most one tile-slot wide, at every real zoom — the owner-reported defect', () => {
    // D-124 measured 81px/tile at 10px/s, 727px at 90px/s and 3879px at
    // 480px/s on this exact clip. Anything past PX_PER_FRAME is a frame drawn
    // wider than the slice of time it stands for — the visible smear.
    for (const pxPerSec of everyRealZoom()) {
      expect(tileWidthPx(A001_SECS, pxPerSec)).toBeLessThanOrEqual(PX_PER_FRAME + 1e-6);
    }
  });

  it('holds for the short clip too', () => {
    for (const pxPerSec of everyRealZoom()) {
      expect(tileWidthPx(SR_SECS, pxPerSec)).toBeLessThanOrEqual(PX_PER_FRAME + 1e-6);
    }
  });

  it('gives real tile density at the default zoom on the long clip', () => {
    // The screenshotted case: 517s at 90px/s. A tile must be a sane size, not
    // 727px of one smeared frame.
    const w = tileWidthPx(A001_SECS, DEFAULT_PX_PER_SEC);
    expect(w).toBeLessThanOrEqual(PX_PER_FRAME);
    expect(w).toBeGreaterThan(PX_PER_FRAME / 2);
  });
});

describe('requestWindow — what is actually fetched', () => {
  it('asks only for the visible range, not the whole clip', () => {
    const width = A001_SECS * DEFAULT_PX_PER_SEC;
    const w = requestWindow(0, A001_SECS, width, 0, VIEWPORT);
    expect(w).not.toBeNull();
    // Viewport + overscan, nowhere near the clip's full 517s.
    expect((w as { durationSecs: number }).durationSecs).toBeLessThan(A001_SECS / 4);
  });

  it('returns null for a clip scrolled entirely off screen', () => {
    // The property that stops a 40-clip timeline requesting 40 windows.
    const width = A001_SECS * DEFAULT_PX_PER_SEC;
    expect(requestWindow(0, A001_SECS, width, -5000, -100)).toBeNull();
    expect(requestWindow(0, A001_SECS, width, width + 100, width + 5000)).toBeNull();
  });

  it('is null rather than NaN for a clip with no width or duration', () => {
    expect(requestWindow(0, 0, 100, 0, 100)).toBeNull();
    expect(requestWindow(0, 10, 0, 0, 100)).toBeNull();
  });

  it('never asks past the clip’s own source range', () => {
    const width = SR_SECS * DEFAULT_PX_PER_SEC;
    const w = requestWindow(2.5, SR_SECS, width, 0, width);
    expect(w).not.toBeNull();
    const { startSecs, durationSecs } = w as { startSecs: number; durationSecs: number };
    expect(startSecs).toBeGreaterThanOrEqual(2.5);
    expect(startSecs + durationSecs).toBeLessThanOrEqual(2.5 + SR_SECS + 1e-9);
  });

  it('snaps outward, so scrolling a few px reuses the same request', () => {
    const width = A001_SECS * DEFAULT_PX_PER_SEC;
    const a = requestWindow(0, A001_SECS, width, 4000, 4000 + VIEWPORT);
    const b = requestWindow(0, A001_SECS, width, 4003, 4003 + VIEWPORT);
    expect(a).toEqual(b);
  });

  it('a sub-rung zoom nudge does not change the requested spacing', () => {
    // The real 1.2x wheel step used to cross a cache bucket every time
    // (D-124's measured 64 -> 41 -> 20 -> 10, four full decodes of one clip).
    // Every zoom across the whole range must now collapse onto the ladder.
    const steps = new Set<number>();
    for (const pxPerSec of everyRealZoom()) {
      const width = A001_SECS * pxPerSec;
      const w = requestWindow(0, A001_SECS, width, 0, Math.min(width, VIEWPORT));
      if (w) steps.add(w.stepSecs);
    }
    expect(steps.size).toBeLessThanOrEqual(LEVEL_STEPS_SECONDS.length);
    for (const s of steps) expect(LEVEL_STEPS_SECONDS).toContain(s);
  });

  it('zooming in asks for a finer spacing, never a coarser one', () => {
    let prev = Infinity;
    for (const pxPerSec of everyRealZoom()) {
      const width = A001_SECS * pxPerSec;
      const w = requestWindow(0, A001_SECS, width, 0, Math.min(width, VIEWPORT));
      if (!w) continue;
      expect(w.stepSecs).toBeLessThanOrEqual(prev);
      prev = w.stepSecs;
    }
  });

  it('two clips trimmed differently out of one source share a window', () => {
    // The property the shared, persistent chunk cache rests on: windows are
    // expressed in SOURCE time, so two clips showing the same source seconds
    // produce the same request regardless of where each one's trim starts.
    // The owner's own project has exactly this shape — the same 4K source on
    // two tracks.
    const pxPerSec = DEFAULT_PX_PER_SEC;
    // Both clips are showing source seconds 133.3 -> 148.9.
    const wantFrom = 133.3;
    const wantTo = 148.9;

    // Clip A: untrimmed, so source second t sits at t * pxPerSec from its edge.
    const a = requestWindow(
      0,
      A001_SECS,
      A001_SECS * pxPerSec,
      wantFrom * pxPerSec,
      wantTo * pxPerSec,
    );
    // Clip B: trimmed to start 100s into the same file, so the same source
    // second sits 100s * pxPerSec earlier relative to ITS left edge.
    const trimStart = 100;
    const trimmedDuration = A001_SECS - trimStart;
    const b = requestWindow(
      trimStart,
      trimmedDuration,
      trimmedDuration * pxPerSec,
      (wantFrom - trimStart) * pxPerSec,
      (wantTo - trimStart) * pxPerSec,
    );

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(b).toEqual(a);
  });
});

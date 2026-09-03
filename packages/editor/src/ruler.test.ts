// @chroma/editor — unit tests for the ruler's tick-interval + timecode
// formatting logic (D-058, item 4). Pure functions, real inputs/outputs —
// see `ruler.ts`'s module doc for why this exists as a separate,
// independently-testable file.
import { describe, expect, it } from 'vitest';
import { NICE_TICK_STEPS_SECONDS, formatTimecode, niceTickIntervalSeconds } from './ruler';

describe('niceTickIntervalSeconds', () => {
  it('only ever returns a value from the nice-steps list', () => {
    for (const pxPerSecond of [1, 5, 16, 40, 90, 200, 480, 5000]) {
      expect(NICE_TICK_STEPS_SECONDS).toContain(niceTickIntervalSeconds(pxPerSecond));
    }
  });

  it('widens the interval as pxPerSecond shrinks (zoomed out)', () => {
    const zoomedOut = niceTickIntervalSeconds(16, 70);
    const zoomedIn = niceTickIntervalSeconds(480, 70);
    expect(zoomedOut).toBeGreaterThan(zoomedIn);
  });

  it('matches the pre-fix default (1s ticks) at the timeline default zoom', () => {
    // TimelinePane's DEFAULT_SCALE_WIDTH was 90 px/sec pre-fix, with a
    // hardcoded scale=1 — confirms this function reproduces that behaviour
    // at the same zoom instead of a regression at the common case.
    expect(niceTickIntervalSeconds(90, 70)).toBe(1);
  });

  it('never returns an interval finer than minSeconds (one frame)', () => {
    const oneFrame = 1 / 24;
    // huge pxPerSecond would otherwise ask for a sub-frame interval
    const interval = niceTickIntervalSeconds(100000, 70, oneFrame);
    expect(interval).toBeGreaterThanOrEqual(oneFrame);
  });

  it('picks the smallest step that keeps adjacent labels >= targetPx apart', () => {
    // at 16 px/sec, a 1s interval would place labels 16px apart (cluttered,
    // the bug report's "1, 2, 3…49") — the chosen step's pixel spacing must
    // clear targetPx.
    const pxPerSecond = 16;
    const targetPx = 70;
    const step = niceTickIntervalSeconds(pxPerSecond, targetPx);
    expect(step * pxPerSecond).toBeGreaterThanOrEqual(targetPx);
  });

  it('falls back to a sane default for a non-positive zoom', () => {
    expect(niceTickIntervalSeconds(0)).toBeGreaterThan(0);
    expect(niceTickIntervalSeconds(-5)).toBeGreaterThan(0);
  });
});

describe('formatTimecode', () => {
  it('formats HH:MM:SS at a whole-second-or-coarser tick interval (no frames)', () => {
    expect(formatTimecode(0, 24, 1)).toBe('00:00:00');
    expect(formatTimecode(65, 24, 5)).toBe('00:01:05');
    expect(formatTimecode(3661, 24, 60)).toBe('01:01:01');
  });

  it('appends :FF only at a sub-second tick interval', () => {
    expect(formatTimecode(1.5, 24, 0.5)).toBe('00:00:01:12');
    expect(formatTimecode(0, 24, 0.1)).toBe('00:00:00:00');
  });

  it('computes frames from the real project fps, not a hardcoded 24', () => {
    // 1.5s at 30fps = frame 45 = 1s + 15 frames
    expect(formatTimecode(1.5, 30, 0.1)).toBe('00:00:01:15');
    // same 1.5s at 24fps = frame 36 = 1s + 12 frames
    expect(formatTimecode(1.5, 24, 0.1)).toBe('00:00:01:12');
  });

  it('rolls minutes and hours over correctly', () => {
    expect(formatTimecode(59.9, 24, 0.1)).not.toBe('00:00:60:00');
    expect(formatTimecode(3600, 24, 1)).toBe('01:00:00');
  });

  it('falls back to 24fps for a non-positive/unknown fps rather than dividing by zero', () => {
    expect(() => formatTimecode(10, 0, 1)).not.toThrow();
    expect(formatTimecode(10, 0, 1)).toBe('00:00:10');
  });
});

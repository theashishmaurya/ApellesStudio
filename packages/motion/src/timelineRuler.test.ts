// @chroma/motion — unit tests for the keyframe timeline's reimplemented
// tick-density algorithm (D-162, Phase 5b part 2). See `timelineRuler.ts`'s
// module doc comment for why this is a local reimplementation of
// `packages/editor/src/ruler.ts`'s algorithm, not an import of it — the
// first several `describe` blocks below deliberately mirror that file's own
// `ruler.test.ts` coverage (same algorithm, independently verified here)
// before `rulerTicks` gets its own, new coverage.
import { describe, expect, it } from 'vitest';
import { NICE_TICK_STEPS_SECONDS, formatTimecode, niceTickIntervalSeconds, rulerTicks } from './timelineRuler';

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

  it('never returns an interval finer than minSeconds (one frame)', () => {
    const oneFrame = 1 / 24;
    const interval = niceTickIntervalSeconds(100000, 70, oneFrame);
    expect(interval).toBeGreaterThanOrEqual(oneFrame);
  });

  it('picks the smallest step that keeps adjacent labels >= targetPx apart', () => {
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
  });

  it('appends :FF only at a sub-second tick interval', () => {
    expect(formatTimecode(1.5, 24, 0.5)).toBe('00:00:01:12');
    expect(formatTimecode(0, 24, 0.1)).toBe('00:00:00:00');
  });

  it('computes frames from the real project fps, not a hardcoded 24', () => {
    expect(formatTimecode(1.5, 30, 0.1)).toBe('00:00:01:15');
    expect(formatTimecode(1.5, 24, 0.1)).toBe('00:00:01:12');
  });

  it('falls back to 24fps for a non-positive/unknown fps rather than dividing by zero', () => {
    expect(() => formatTimecode(10, 0, 1)).not.toThrow();
    expect(formatTimecode(10, 0, 1)).toBe('00:00:10');
  });
});

describe('rulerTicks', () => {
  it('is empty for a non-positive total duration or zoom', () => {
    expect(rulerTicks(0, 30, 70)).toEqual([]);
    expect(rulerTicks(-5, 30, 70)).toEqual([]);
    expect(rulerTicks(10, 30, 0)).toEqual([]);
  });

  it('starts at frame/second 0 and ends exactly at totalSeconds, never past it', () => {
    const ticks = rulerTicks(4, 30, 70);
    expect(ticks[0]).toEqual({ seconds: 0, frame: 0, label: '00:00:00' });
    const last = ticks[ticks.length - 1];
    expect(last.seconds).toBe(4);
    expect(last.frame).toBe(120);
  });

  it('every interior tick is spaced by the SAME niceTickIntervalSeconds value', () => {
    const pxPerSecond = 70;
    const totalSeconds = 10;
    const ticks = rulerTicks(totalSeconds, 30, pxPerSecond);
    const interval = niceTickIntervalSeconds(pxPerSecond, 64, 1 / 30);
    for (let i = 1; i < ticks.length - 1; i++) {
      expect(ticks[i].seconds - ticks[i - 1].seconds).toBeCloseTo(interval, 10);
    }
  });

  it('produces fewer ticks at a coarser zoom (zoomed out) than a finer one (zoomed in)', () => {
    const zoomedOut = rulerTicks(60, 30, 10);
    const zoomedIn = rulerTicks(60, 30, 300);
    expect(zoomedOut.length).toBeLessThan(zoomedIn.length);
  });

  it('never produces a duplicate trailing tick when totalSeconds lands exactly on the interval', () => {
    // interval at pxPerSecond=70 is 1s (matches ruler.ts's own documented
    // default-zoom behaviour) — a 4s total should end with exactly one
    // tick at 4, not two.
    const ticks = rulerTicks(4, 30, 70);
    expect(ticks.filter((t) => t.seconds === 4)).toHaveLength(1);
  });

  it('every tick frame is Math.round(seconds * fps), matching every other conversion in this package', () => {
    const ticks = rulerTicks(4, 30, 70);
    for (const t of ticks) {
      expect(t.frame).toBe(Math.round(t.seconds * 30));
    }
  });
});

/** D-434 — the perf arithmetic shared by the input tool and the scenario runner. */
import { describe, expect, it } from 'vitest';

import { droppedFrames, FRAME_BUDGET_MS, intervals, percentile, splitFramePhases, summarize } from './stats';

describe('stats', () => {
  it('nearest-rank percentiles report values that really occurred', () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 50)).toBe(5);
    expect(percentile(sorted, 95)).toBe(10);
    expect(percentile(sorted, 0)).toBe(1);
    expect(Number.isNaN(percentile([], 50))).toBe(true);
  });

  it('summarize is null for no samples, not zeros', () => {
    expect(summarize([])).toBeNull();
    expect(summarize([Number.NaN])).toBeNull();
    expect(summarize([16, 17, 40])).toEqual({ samples: 3, minMs: 16, p50Ms: 17, p95Ms: 40, maxMs: 40, meanMs: 24.33 });
  });

  it('counts dropped frames as missed refreshes, tolerating vsync jitter', () => {
    expect(droppedFrames([16.7, 17.9, 16.1])).toBe(0);
    expect(droppedFrames([33.4])).toBe(1);
    expect(droppedFrames([100])).toBe(5);
    expect(FRAME_BUDGET_MS).toBeCloseTo(16.667, 3);
  });

  it('intervals are successive differences', () => {
    expect(intervals([0, 16, 40])).toEqual([16, 24]);
    expect(intervals([5])).toEqual([]);
  });
});

describe('splitFramePhases (B-347 F6)', () => {
  const frames = [0, 16, 33, 50, 66, 150, 166, 183];

  it('puts the interval that ends at or after the release, and everything later, in the release phase', () => {
    const { move, release } = splitFramePhases(frames, 100);
    expect(move).toEqual([16, 17, 17, 16]);
    expect(release).toEqual([84, 16, 17]);
  });

  it('a release before the first frame makes everything the release phase', () => {
    expect(splitFramePhases(frames, -5)).toEqual({ move: [], release: intervals(frames) });
  });

  it('no release time (a key press, a wheel) is all move', () => {
    expect(splitFramePhases(frames, null)).toEqual({ move: intervals(frames), release: null });
  });
});

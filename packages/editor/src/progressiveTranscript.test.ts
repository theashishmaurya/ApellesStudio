import { describe, expect, it } from 'vitest';

import { coreSegments, planWindows, stitchWindows, WINDOW_CORE_S, WINDOW_OVERLAP_S } from './progressiveTranscript';
import type { TranscriptSegment } from './mediaUnderstandingStore';

const seg = (words: Array<[string, number, number]>): TranscriptSegment => ({
  start: words[0][1],
  end: words[words.length - 1][2],
  text: words.map((w) => w[0]).join(' '),
  words: words.map(([word, start, end]) => ({ word, start, end })),
});

describe('progressive transcript', () => {
  it('plans 5-minute cores read with overlap, the last open-ended', () => {
    const w = planWindows(700);
    expect(w).toHaveLength(3);
    expect(w[0]).toEqual({ startSecs: 0, durationSecs: WINDOW_CORE_S + WINDOW_OVERLAP_S, coreStart: 0, coreEnd: 300 });
    expect(w[1].startSecs).toBe(300 - WINDOW_OVERLAP_S);
    expect(w[1].coreEnd).toBe(600);
    expect(w[2].coreEnd).toBe(Number.POSITIVE_INFINITY);
    expect(w[2].startSecs + w[2].durationSecs).toBe(700 + WINDOW_OVERLAP_S);
    expect(planWindows(0)).toEqual([]);
    expect(planWindows(120)).toHaveLength(1);
  });

  it('keeps each word in exactly one window by its midpoint', () => {
    // A word straddling 300 s (midpoint 300.1) is heard by both windows.
    const a = [seg([['one', 298, 298.5], ['edge', 299.9, 300.3]])];
    const b = [seg([['edge', 299.9, 300.3], ['two', 301, 301.4]])];
    const windows = planWindows(700).slice(0, 2);
    const stitched = stitchWindows([
      { window: windows[0], segments: a },
      { window: windows[1], segments: b },
    ]);
    const words = stitched.flatMap((s) => s.words.map((w) => w.word));
    expect(words).toEqual(['one', 'edge', 'two']);
    expect(stitched[0].end).toBe(298.5);
    expect(stitched[1].start).toBe(299.9);
    expect(coreSegments([seg([['x', 10, 11]])], { coreStart: 300, coreEnd: 600 })).toEqual([]);
  });
});

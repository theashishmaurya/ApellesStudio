/**
 * D-432 P5 — previous / next edit point: every clip start and end on any
 * track plus the first and last frame, ascending and unique.
 */
import { describe, expect, it } from 'vitest';

import { editPoints, nextEditPoint, prevEditPoint } from './editPoints';
import type { Timeline } from './timeline';

function clip(id: string, start: number, len: number) {
  return { id, name: id, source_path: `/m/${id}.mp4`, source_start: 0, duration: len, source_len: 1000, source_fps: 24, start_frame: start };
}

const tl = {
  id: 't',
  name: 'T',
  rate: { num: 24, den: 1 },
  tracks: [
    { kind: 'video', clips: [clip('a', 0, 48), clip('b', 48, 24)] },
    { kind: 'video', clips: [clip('c', 30, 10)] },
  ],
} as unknown as Timeline;

describe('editPoints', () => {
  it('collects every clip edge on every track, plus the first and last frame', () => {
    // b ends at 72, one past the last frame (71), so the last frame stands in for it.
    expect(editPoints(tl)).toEqual([0, 30, 40, 48, 71]);
  });

  it('is just the first frame without a timeline', () => {
    expect(editPoints(null)).toEqual([0]);
  });
});

describe('prevEditPoint / nextEditPoint', () => {
  const pts = [0, 30, 40, 48, 71];
  it('steps to the nearest point strictly before / after', () => {
    expect(prevEditPoint(pts, 45)).toBe(40);
    expect(prevEditPoint(pts, 40)).toBe(30);
    expect(nextEditPoint(pts, 30)).toBe(40);
    expect(nextEditPoint(pts, 31)).toBe(40);
  });

  it('stops at the ends', () => {
    expect(prevEditPoint(pts, 0)).toBe(0);
    expect(nextEditPoint(pts, 71)).toBe(71);
  });
});

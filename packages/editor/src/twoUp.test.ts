/**
 * D-432 P3 — the two-up trim viewer's frames (`twoUp.ts`) and a dragged
 * marker's landing frame (`TimelineMarkers.tsx` `draggedMarkerFrame`).
 */
import { describe, expect, it } from 'vitest';

import { previewEdit } from './editGesture';
import { draggedMarkerFrame } from './TimelineMarkers';
import { twoUpView } from './twoUp';
import type { Timeline } from './timeline';

const clip = (id: string, start: number) => ({
  id,
  name: id,
  source_path: `/${id}.mp4`,
  source_start: 100,
  duration: 48,
  source_len: 480,
  start_frame: start,
});
const tl: Timeline = {
  id: 't',
  name: 't',
  rate: { num: 24, den: 1 },
  tracks: [{ kind: 'video', clips: [clip('a', 0), clip('b', 48), clip('c', 96)] }],
};

describe('twoUpView', () => {
  it('roll: the outgoing clip’s new last frame | the incoming clip’s new first frame', () => {
    const target = { mode: 'roll' as const, track: 0, clip: 0, edge: 'end' as const };
    const after = previewEdit(tl, target, 6).after;
    expect(twoUpView(tl, target, after)).toEqual({
      left: { sourcePath: '/a.mp4', sourceFrame: 153, label: 'Out', timelineFrame: 53 },
      right: { sourcePath: '/b.mp4', sourceFrame: 106, label: 'In', timelineFrame: 54 },
    });
  });

  it('slip: the clip’s new first | last frame, at its unchanged timeline place', () => {
    const target = { mode: 'slip' as const, track: 0, clip: 1, edge: 'end' as const };
    const after = previewEdit(tl, target, 10).after;
    const v = twoUpView(tl, target, after)!;
    expect(v.left.label).toBe('Start');
    expect(v.right.label).toBe('End');
    expect(v.right.sourceFrame - v.left.sourceFrame).toBe(47);
    expect([v.left.timelineFrame, v.right.timelineFrame]).toEqual([48, 95]);
    expect(v.left.sourceFrame).not.toBe(100);
  });

  it('slide: the left neighbour’s last frame | the right neighbour’s first frame', () => {
    const target = { mode: 'slide' as const, track: 0, clip: 1, edge: 'end' as const };
    const v = twoUpView(tl, target, previewEdit(tl, target, 4).after)!;
    expect(v.left).toMatchObject({ sourcePath: '/a.mp4', label: 'Out', timelineFrame: 51 });
    expect(v.right).toMatchObject({ sourcePath: '/c.mp4', label: 'In', timelineFrame: 100 });
  });

  it('trim and ripple are one-up (null)', () => {
    for (const mode of ['trim', 'ripple'] as const) {
      expect(twoUpView(tl, { mode, track: 0, clip: 2, edge: 'end' }, tl)).toBeNull();
    }
  });
});

describe('draggedMarkerFrame', () => {
  it('follows the pointer in frames, never before 0, and snaps within 8 px', () => {
    expect(draggedMarkerFrame(24, 90, 24, 90, null)).toBe(48);
    expect(draggedMarkerFrame(24, -1000, 24, 90, null)).toBe(0);
    // 8 px at 90 px/s is 2 frames: 46 → 48
    expect(draggedMarkerFrame(24, 22 * 3.75, 24, 90, [48])).toBe(48);
    expect(draggedMarkerFrame(24, 18 * 3.75, 24, 90, [48])).toBe(42);
  });
});

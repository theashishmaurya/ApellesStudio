/**
 * B-357 — a transition badge must not block trimming the cut under it.
 * `clip-path` clips hit testing, so the badge's hit button carries a hole over the
 * cut's two trim zones; this pins the hole's geometry (the live hit test is in
 * `docs/notes/timeline-lanes.md`, S6).
 */
import { describe, expect, it } from 'vitest';

import { TRIM_ZONE_PX } from './lanes/laneLayout';
import { editPointHoleClip } from './TimelineTransitions';

const holeEdges = (clip: string) => {
  const px = [...clip.matchAll(/(-?[\d.]+)px/g)].map((m) => Number(m[1]));
  return { from: Math.min(...px), to: Math.max(...px) };
};

describe('editPointHoleClip (B-357)', () => {
  it('cuts one trim zone each side of a centred cut', () => {
    const clip = editPointHoleClip(60, 30);
    expect(clip).not.toBeNull();
    expect(holeEdges(clip!)).toEqual({ from: 30 - TRIM_ZONE_PX, to: 30 + TRIM_ZONE_PX });
    expect(clip).toMatch(/^polygon\(evenodd,/);
  });

  it('clamps the hole to the badge when the cut is at an edge (start/end-at-cut)', () => {
    expect(holeEdges(editPointHoleClip(60, 0)!)).toEqual({ from: 0, to: TRIM_ZONE_PX });
    expect(holeEdges(editPointHoleClip(60, 60)!)).toEqual({ from: 60 - TRIM_ZONE_PX, to: 60 });
  });

  it('leaves no hole when the badge would have no usable target beside it', () => {
    expect(editPointHoleClip(20, 10)).toBeNull();
    expect(editPointHoleClip(6, 3)).toBeNull();
  });
});

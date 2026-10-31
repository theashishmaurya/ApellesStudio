/** D-434 — state shaped for assertions, and the frame ↔ pixel arithmetic. */
import { describe, expect, it } from 'vitest';

import { TIMELINE_VIEW_ATTRS } from '@apelles/editor/src/timelineTestIds.ts';

import { framesToPx, pointAtFrame, timelineSnapshot, viewSnapshot } from './snapshot.ts';

describe('timelineSnapshot', () => {
  const dto = {
    id: 'tl',
    durationFrames: 270,
    tracks: [
      {
        index: 0,
        clips: [
          { id: 'id-c', index: 2, startFrame: 180, duration: 90, sourceStart: 30, linkGroup: null },
          { id: 'id-a', index: 0, startFrame: 0, duration: 90, sourceStart: 30 },
          { id: 'id-new', index: 1, startFrame: 90, duration: 45 },
        ],
      },
      { index: 1, clips: [] },
    ],
    markers: [{ id: 'm', name: 'probe', frame: 150 }],
  };
  const snap = timelineSnapshot(dto, { 'id-a': 'a', 'id-c': 'c' });

  it('keys clips by fixture name and by id, with end precomputed', () => {
    expect(snap.clips.a).toMatchObject({ id: 'id-a', track: 0, startFrame: 0, duration: 90, end: 90, sourceStart: 30, name: 'a' });
    expect(snap.clips['id-a']).toBe(snap.clips.a);
    expect(snap.clips['id-new']).toMatchObject({ name: null, sourceStart: 0, end: 135 });
  });

  it('orders each track by timeline position, counts clips, keeps markers', () => {
    expect(snap.tracks[0].map((c) => c.id)).toEqual(['id-a', 'id-new', 'id-c']);
    expect(snap.tracks[1]).toEqual([]);
    expect(snap.clipCount).toBe(3);
    expect(snap.markers).toEqual([{ id: 'm', name: 'probe', frame: 150 }]);
  });

  it('an empty answer is an empty timeline, not a crash', () => {
    expect(timelineSnapshot(null)).toMatchObject({ durationFrames: 0, clipCount: 0, tracks: [] });
  });
});

describe('viewSnapshot / pointAtFrame', () => {
  const attrs = {
    [TIMELINE_VIEW_ATTRS.pxPerSec]: '90',
    [TIMELINE_VIEW_ATTRS.scrollLeft]: '45',
    [TIMELINE_VIEW_ATTRS.scrollTop]: '0',
    [TIMELINE_VIEW_ATTRS.fps]: '30',
    [TIMELINE_VIEW_ATTRS.startLeft]: '32',
    [TIMELINE_VIEW_ATTRS.rowHeight]: '52',
    [TIMELINE_VIEW_ATTRS.rowsTop]: '50',
  };
  const tree = { root: { attrs, rect: { x: 200, y: 400, width: 1000, height: 300 } } };

  it('reads the readout off the edit area', () => {
    const v = viewSnapshot(tree);
    expect(v).toMatchObject({ pxPerSec: 90, scrollLeft: 45, fps: 30, rowHeight: 52, rect: { x: 200 } });
  });

  it('places a frame exactly where the pane draws it', () => {
    const v = viewSnapshot(tree);
    if ('error' in v) throw new Error(v.error);
    // 200 + 32 + (60/30)*90 - 45 = 367; row 1 centre: 400 + 50 + 1.5*52 = 528.
    expect(pointAtFrame(v, 60, 1)).toEqual({ x: 367, y: 528 });
    expect(pointAtFrame(v, 0, 0, 0)).toEqual({ x: 187, y: 450 });
    expect(framesToPx(v, 15)).toBe(45);
  });

  it('a missing edit area or an older build without the readout is an error that says so', () => {
    expect(viewSnapshot({ root: null })).toMatchObject({ error: expect.stringMatching(/not on screen/) });
    expect(viewSnapshot({ root: { attrs: {}, rect: tree.root.rect } })).toMatchObject({ error: expect.stringMatching(/lacks its view readout/) });
  });
});

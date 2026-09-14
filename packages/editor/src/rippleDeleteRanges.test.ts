// @apelles/editor — the D-318 batched ripple delete.
//
// Fixture-based: every test asserts the EXACT clip layout that comes out
// (count, `start_frame`, `source_start`, `duration`), not just "something was
// removed" — the same discipline the rest of this package's op tests hold.
//
// What is being proved here is specifically the BATCHING, since the cutting
// itself is `split`/`remove`/`remove_gap`, each already tested in
// `timeline.test.ts`: that N ranges come out as one timeline, that they are
// applied back-to-front so an earlier cut's ripple cannot move a later one, and
// that overlapping or degenerate input is normalised before any of that.
import { describe, expect, it } from 'vitest';

import { applyOp, endFrame, mergeFrameRanges, timelineFps, type Clip, type Timeline } from './timeline';

const FPS = 24;

function clip(id: string, startFrame: number, sourceStart: number, duration: number): Clip {
  return {
    id,
    name: id,
    source_path: '/fixtures/talk.mov',
    source_start: sourceStart,
    duration,
    source_len: 10_000,
    start_frame: startFrame,
  } as Clip;
}

/** One 480-frame (20s @24fps) talking-head clip on one video track. */
function oneLongClip(): Timeline {
  return {
    id: 'tl',
    name: 'recut fixture',
    rate: { num: 24, den: 1 },
    tracks: [{ kind: 'video', clips: [clip('a', 0, 0, 480)], gain: 1, sync_locked: false }],
    markers: [],
  } as unknown as Timeline;
}

function layout(tl: Timeline) {
  const fps = timelineFps(tl);
  return tl.tracks[0].clips.map((c) => ({
    start: c.start_frame,
    end: endFrame(c, fps),
    sourceStart: c.source_start,
    duration: c.duration,
  }));
}

describe('mergeFrameRanges', () => {
  it('sorts, and leaves disjoint ranges alone', () => {
    expect(mergeFrameRanges([{ start: 100, end: 120 }, { start: 10, end: 20 }])).toEqual([
      { start: 10, end: 20 },
      { start: 100, end: 120 },
    ]);
  });

  it('merges overlapping ranges', () => {
    expect(mergeFrameRanges([{ start: 10, end: 50 }, { start: 40, end: 80 }])).toEqual([
      { start: 10, end: 80 },
    ]);
  });

  it('merges ranges that merely touch — they are one continuous stretch', () => {
    expect(mergeFrameRanges([{ start: 10, end: 50 }, { start: 50, end: 80 }])).toEqual([
      { start: 10, end: 80 },
    ]);
  });

  it('drops empty and inverted ranges rather than cutting backwards', () => {
    expect(mergeFrameRanges([{ start: 10, end: 10 }, { start: 80, end: 20 }])).toEqual([]);
  });

  it('rounds to whole frames and clamps a negative start to zero', () => {
    expect(mergeFrameRanges([{ start: -5, end: 20.4 }])).toEqual([{ start: 0, end: 20 }]);
  });

  it('is empty for empty input', () => {
    expect(mergeFrameRanges([])).toEqual([]);
  });
});

describe('ripple_delete_ranges', () => {
  it('cuts one range out of the middle and closes the gap', () => {
    const tl = oneLongClip();
    const out = applyOp(tl, {
      kind: 'ripple_delete_ranges',
      track: 0,
      ranges: [{ start: 100, end: 160 }],
    });

    // 0..100 stays put; what was 160..480 becomes 100..420, and keeps its own
    // source material (source_start 160) — a ripple moves clips, not content.
    expect(layout(out)).toEqual([
      { start: 0, end: 100, sourceStart: 0, duration: 100 },
      { start: 100, end: 420, sourceStart: 160, duration: 320 },
    ]);
  });

  it('cuts several ranges as ONE edit, with every later range still landing on the right material', () => {
    const tl = oneLongClip();
    const out = applyOp(tl, {
      kind: 'ripple_delete_ranges',
      track: 0,
      ranges: [
        { start: 100, end: 160 }, // 60 frames
        { start: 300, end: 360 }, // 60 frames
      ],
    });

    // Total removed: 120 frames, so the timeline ends at 360.
    const rows = layout(out);
    expect(rows[rows.length - 1].end).toBe(360);
    // The surviving source material is exactly the three keepers, in order —
    // this is the assertion that back-to-front application works: if the first
    // cut had been applied first, the second would have taken 300..360 of the
    // ALREADY-SHIFTED timeline and removed the wrong 60 source frames.
    expect(rows.map((r) => [r.sourceStart, r.duration])).toEqual([
      [0, 100],
      [160, 140],
      [360, 120],
    ]);
  });

  it('is order-independent: the same ranges given backwards produce the same timeline', () => {
    const forwards = applyOp(oneLongClip(), {
      kind: 'ripple_delete_ranges',
      track: 0,
      ranges: [{ start: 100, end: 160 }, { start: 300, end: 360 }],
    });
    const backwards = applyOp(oneLongClip(), {
      kind: 'ripple_delete_ranges',
      track: 0,
      ranges: [{ start: 300, end: 360 }, { start: 100, end: 160 }],
    });
    expect(layout(backwards)).toEqual(layout(forwards));
  });

  it('normalises overlapping ranges instead of cutting the wrong material twice', () => {
    const merged = applyOp(oneLongClip(), {
      kind: 'ripple_delete_ranges',
      track: 0,
      ranges: [{ start: 100, end: 200 }, { start: 150, end: 250 }],
    });
    const single = applyOp(oneLongClip(), {
      kind: 'ripple_delete_ranges',
      track: 0,
      ranges: [{ start: 100, end: 250 }],
    });
    expect(layout(merged)).toEqual(layout(single));
  });

  it('cuts a range that starts at frame 0 (the speaker starting late)', () => {
    const out = applyOp(oneLongClip(), {
      kind: 'ripple_delete_ranges',
      track: 0,
      ranges: [{ start: 0, end: 72 }],
    });
    expect(layout(out)).toEqual([{ start: 0, end: 408, sourceStart: 72, duration: 408 }]);
  });

  it('is a no-op for an empty range list', () => {
    const tl = oneLongClip();
    expect(applyOp(tl, { kind: 'ripple_delete_ranges', track: 0, ranges: [] })).toBe(tl);
  });

  it('is a no-op for ranges that describe no real material', () => {
    const tl = oneLongClip();
    expect(
      applyOp(tl, { kind: 'ripple_delete_ranges', track: 0, ranges: [{ start: 50, end: 50 }] }),
    ).toBe(tl);
  });

  it('refuses on a locked track, leaving the timeline untouched', () => {
    const tl = oneLongClip();
    tl.tracks[0].locked = true;
    expect(
      applyOp(tl, { kind: 'ripple_delete_ranges', track: 0, ranges: [{ start: 100, end: 160 }] }),
    ).toBe(tl);
  });

  it('is a no-op for a track that does not exist', () => {
    const tl = oneLongClip();
    expect(
      applyOp(tl, { kind: 'ripple_delete_ranges', track: 7, ranges: [{ start: 10, end: 20 }] }),
    ).toBe(tl);
  });

  it('never leaves a clip with a non-positive duration', () => {
    const out = applyOp(oneLongClip(), {
      kind: 'ripple_delete_ranges',
      track: 0,
      ranges: [
        { start: 10, end: 20 },
        { start: 200, end: 300 },
        { start: 460, end: 480 },
      ],
    });
    for (const c of out.tracks[0].clips) {
      expect(c.duration).toBeGreaterThan(0);
      expect(c.start_frame).toBeGreaterThanOrEqual(0);
    }
  });

  it('leaves no gaps behind — every clip abuts the next', () => {
    const out = applyOp(oneLongClip(), {
      kind: 'ripple_delete_ranges',
      track: 0,
      ranges: [{ start: 100, end: 160 }, { start: 300, end: 360 }],
    });
    const rows = layout(out);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].start).toBe(rows[i - 1].end);
    }
    expect(rows[0].start).toBe(0);
  });
});

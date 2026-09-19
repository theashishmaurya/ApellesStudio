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

import {
  applyOp,
  applyRippleDeleteRanges,
  endFrame,
  mergeFrameRanges,
  timelineFps,
  type Clip,
  type Timeline,
} from './timeline';

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

// --------------------------------------------------------------------------- //
// B-197 — a batch that drops some of its ranges says so, per range.
//
// Both fixtures below are real, reproducible shapes of the live failure: a
// batch where MOST ranges cut cleanly and one cannot, which before this fix
// changed the timeline (so the handler's reference-equality backstop saw
// success) while quietly not doing what it was asked. The assertions are on
// two things at once, because both were wrong: the resulting TIMELINE (a
// refused range now leaves no trace at all, instead of a half-cut hole or a
// stray split boundary) and the reported RESULT (which range, and why).
// --------------------------------------------------------------------------- //

/** One long camera clip on track 0 and a sync-locked graphic on track 1,
 *  covering `[ovStart, ovStart + ovLen)` — the everyday overlay shape. */
function withSyncLockedOverlay(ovStart: number, ovLen: number): Timeline {
  return {
    id: 'tl',
    name: 'recut fixture',
    rate: { num: FPS, den: 1 },
    tracks: [
      { kind: 'video', clips: [clip('main', 0, 0, 1000)], gain: 1, sync_locked: true },
      { kind: 'video', clips: [clip('graphic', ovStart, 0, ovLen)], gain: 1, sync_locked: true },
    ],
    markers: [],
  } as unknown as Timeline;
}

/** A J-cut A/V pair: the audio half starts 600 frames after the video half,
 *  so a razor before frame 600 is inside the video clip and outside its link
 *  partner — D-129 refuses to split the group there. */
function jCutPair(): Timeline {
  const v = clip('v', 0, 0, 1000);
  const a = clip('a', 600, 0, 400);
  v.link_group = 'g';
  a.link_group = 'g';
  return {
    id: 'tl',
    name: 'recut fixture',
    rate: { num: FPS, den: 1 },
    tracks: [
      { kind: 'video', clips: [v], gain: 1, sync_locked: true },
      { kind: 'audio', clips: [a], gain: 1, sync_locked: true },
    ],
    markers: [],
  } as unknown as Timeline;
}

describe('ripple_delete_ranges — per-range outcome (B-197)', () => {
  it('reports the ONE range a straddling sync-locked clip refuses, and leaves that range untouched', () => {
    // The graphic on track 1 covers 380..600, so it straddles frame 500 — the
    // end of the middle range, and therefore the end of the gap that range's
    // own ripple would have to close. B-033 refuses that ripple by design.
    const tl = withSyncLockedOverlay(380, 220);
    const ranges = [
      { start: 100, end: 150 },
      { start: 450, end: 500 },
      { start: 700, end: 750 },
    ];

    const { timeline: out, results } = applyRippleDeleteRanges(tl, 0, ranges, FPS);

    expect(results.map((r) => [r.start, r.end, r.applied])).toEqual([
      [100, 150, true],
      [450, 500, false],
      [700, 750, true],
    ]);
    const refused = results[1];
    expect(refused.reason).toContain('could not be closed');
    // Names the real constraint — which track straddles, and at which frame.
    expect(refused.reason).toContain('B-033');
    expect(refused.reason).toContain('track 1');

    // …and the refused range left NO trace: its 50 frames of source are still
    // there (150..700 is one continuous run), there is no gap anywhere, and
    // the track is not carrying two orphan split boundaries around them.
    expect(layout(out)).toEqual([
      { start: 0, end: 100, sourceStart: 0, duration: 100 },
      { start: 100, end: 650, sourceStart: 150, duration: 550 },
      { start: 650, end: 900, sourceStart: 750, duration: 250 },
    ]);
    // The whole point: 900, not 950. Only the two applied ranges came out.
    expect(out.tracks[0].clips.reduce((n, c) => n + c.duration, 0)).toBe(900);
  });

  it('reports the range a link partner refuses to be razored for, and applies the rest', () => {
    const tl = jCutPair();
    const { timeline: out, results } = applyRippleDeleteRanges(
      tl,
      0,
      [{ start: 100, end: 150 }, { start: 700, end: 750 }],
      FPS,
    );

    expect(results.map((r) => [r.start, r.end, r.applied])).toEqual([
      [100, 150, false],
      [700, 750, true],
    ]);
    expect(results[0].reason).toContain('frame 150');
    expect(results[0].reason).toContain('A/V-linked');
    // The refused range's material is untouched; the other one really cut.
    expect(layout(out)).toEqual([
      { start: 0, end: 700, sourceStart: 0, duration: 700 },
      { start: 700, end: 950, sourceStart: 750, duration: 250 },
    ]);
  });

  it('reports every range as applied for a batch that really does apply, one entry per MERGED range', () => {
    const { results } = applyRippleDeleteRanges(
      oneLongClip(),
      0,
      // Two of these overlap, so they are ONE cut and ONE result.
      [{ start: 300, end: 360 }, { start: 100, end: 200 }, { start: 150, end: 250 }],
      FPS,
    );
    expect(results).toEqual([
      { start: 100, end: 250, applied: true },
      { start: 300, end: 360, applied: true },
    ]);
  });

  it('counts a cut that runs off the end of the track as applied — there is nothing to ripple, and that is fine', () => {
    const { timeline: out, results } = applyRippleDeleteRanges(
      oneLongClip(),
      0,
      [{ start: 440, end: 480 }],
      FPS,
    );
    expect(results).toEqual([{ start: 440, end: 480, applied: true }]);
    expect(layout(out)).toEqual([{ start: 0, end: 440, sourceStart: 0, duration: 440 }]);
  });

  it('reports a range that describes no real material, rather than counting it as a cut', () => {
    // 600..700 is past the end of a 480-frame track.
    const { timeline: out, results } = applyRippleDeleteRanges(
      oneLongClip(),
      0,
      [{ start: 100, end: 160 }, { start: 600, end: 700 }],
      FPS,
    );
    expect(results[0].applied).toBe(true);
    expect(results[1].applied).toBe(false);
    expect(results[1].reason).toContain('no real material');
    expect(layout(out)).toEqual([
      { start: 0, end: 100, sourceStart: 0, duration: 100 },
      { start: 100, end: 420, sourceStart: 160, duration: 320 },
    ]);
  });

  it('reports a locked track once per range instead of silently doing nothing', () => {
    const tl = oneLongClip();
    tl.tracks[0].locked = true;
    const { timeline: out, results } = applyRippleDeleteRanges(
      tl,
      0,
      [{ start: 100, end: 160 }, { start: 300, end: 360 }],
      FPS,
    );
    expect(out).toBe(tl);
    expect(results.every((r) => !r.applied && r.reason === 'track 0 is locked')).toBe(true);
  });

  it('is the same function `applyOp` runs — the reducer returns exactly this timeline', () => {
    const tl = withSyncLockedOverlay(380, 220);
    const ranges = [{ start: 100, end: 150 }, { start: 450, end: 500 }];
    expect(applyOp(tl, { kind: 'ripple_delete_ranges', track: 0, ranges })).toEqual(
      applyRippleDeleteRanges(tl, 0, ranges, FPS).timeline,
    );
  });
});

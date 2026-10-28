// @apelles/editor — B-307: timeline markers follow ripple edits.
//
// `rippleMarkers` is the one mapping; the reducer tests below prove each
// ripple op routes through it in the SAME op (so one undo step reverts the
// clips and the markers together), and that a non-ripple edit moves none.
import { describe, expect, it } from 'vitest';

import {
  applyOp,
  applyRippleDeleteRanges,
  rippleMarkers,
  type Clip,
  type Marker,
  type Timeline,
} from './timeline';

const mk = (id: string, frame: number, duration?: number): Marker =>
  ({ id, frame, color: '#3B8FE3', ...(duration ? { duration_frames: duration } : {}) }) as Marker;

const clip = (id: string, start: number, duration: number): Clip =>
  ({ id, name: id, source_path: `/f/${id}.mov`, source_start: 0, duration, source_len: 10_000, start_frame: start, source_fps: 24 }) as Clip;

function timeline(markers: Marker[], clips: Clip[] = [clip('a', 0, 100), clip('b', 100, 100), clip('c', 200, 100)]): Timeline {
  return {
    id: 'tl',
    name: 'markers',
    rate: { num: 24, den: 1 },
    tracks: [{ kind: 'video', clips, gain: 1, sync_locked: false }],
    markers,
  } as unknown as Timeline;
}
const frames = (tl: Timeline) => (tl.markers ?? []).map((m) => [m.id, m.frame, m.duration_frames ?? 0]);

describe('rippleMarkers', () => {
  it('delete: after shifts back, inside moves to the cut point, before stays', () => {
    const out = rippleMarkers([mk('before', 10), mk('inside', 55), mk('at-start', 50), mk('at-end', 60), mk('after', 90)], {
      kind: 'delete',
      start: 50,
      end: 60,
    });
    expect(out.map((m) => [m.id, m.frame])).toEqual([
      ['before', 10],
      ['inside', 50],
      ['at-start', 50],
      ['at-end', 50],
      ['after', 80],
    ]);
  });

  it('delete: a ranged marker keeps its surviving frames, and collapses to a point when all of it went', () => {
    const out = rippleMarkers(
      [mk('straddles-start', 40, 20), mk('straddles-end', 55, 15), mk('covers', 45, 20), mk('inside', 52, 4)],
      { kind: 'delete', start: 50, end: 60 },
    );
    expect(out.map((m) => [m.id, m.frame, m.duration_frames])).toEqual([
      ['straddles-start', 40, 10], // 40..60 (inclusive) → 40..50: frame 60 survives, at 50
      ['straddles-end', 50, 10], // 55..70 → 50..60
      ['covers', 45, 10], // 45..65 → 45..55
      ['inside', 50, undefined], // wholly cut: a point marker at the cut, kept
    ]);
  });

  it('insert: at/after shifts forward, a range spanning the point grows, before stays', () => {
    const out = rippleMarkers([mk('before', 10), mk('at', 50), mk('spans', 40, 20), mk('ends-before', 30, 19)], {
      kind: 'insert',
      at: 50,
      frames: 24,
    });
    expect(out.map((m) => [m.id, m.frame, m.duration_frames])).toEqual([
      ['before', 10, undefined],
      ['at', 74, undefined],
      ['spans', 40, 44],
      ['ends-before', 30, 19],
    ]);
  });

  it('returns the same array when nothing moved', () => {
    const ms = [mk('a', 10)];
    expect(rippleMarkers(ms, { kind: 'delete', start: 50, end: 60 })).toBe(ms);
  });
});

describe('the ripple ops carry the markers, in the same op', () => {
  it('ripple_delete_ranges (and editor_cut_words, which is this op)', () => {
    const tl = timeline([mk('m1', 20), mk('m2', 130), mk('m3', 250)]);
    const out = applyOp(tl, { kind: 'ripple_delete_ranges', track: 0, ranges: [{ start: 120, end: 140 }, { start: 240, end: 260 }] });
    expect(frames(out)).toEqual([
      ['m1', 20, 0],
      ['m2', 120, 0], // inside the first cut → its cut point
      ['m3', 220, 0], // inside the second cut → 240, then the first cut's ripple → 220
    ]);
  });

  it('a skipped range moves no marker', () => {
    const tl = timeline([mk('m', 400)]);
    const { timeline: out, results } = applyRippleDeleteRanges(tl, 0, [{ start: 400, end: 420 }], 24);
    expect(results[0].applied).toBe(false);
    expect(frames(out)).toEqual([['m', 400, 0]]);
  });

  it('remove_gap', () => {
    const tl = timeline([mk('in-gap', 110), mk('after', 230)], [clip('a', 0, 100), clip('b', 120, 100), clip('c', 220, 100)]);
    const out = applyOp(tl, { kind: 'remove_gap', track: 0, frame: 105 });
    expect(frames(out)).toEqual([
      ['in-gap', 100, 0],
      ['after', 210, 0],
    ]);
  });

  it('add_clip with ripple', () => {
    const tl = timeline([mk('m', 150)]);
    const { start_frame: _drop, ...fields } = clip('n', 0, 48);
    const out = applyOp(tl, { kind: 'add_clip', track: 0, clip: fields, startFrame: 100, ripple: true });
    expect(frames(out)).toEqual([['m', 198, 0]]);
  });

  it('move with ripple', () => {
    const tl = timeline([mk('m', 250)], [clip('a', 0, 100), clip('b', 100, 100), clip('c', 200, 100), clip('x', 400, 30)]);
    const out = applyOp(tl, { kind: 'move', fromTrack: 0, toTrack: 0, clip: 3, startFrame: 200, ripple: true });
    expect(out.tracks[0].clips.map((c) => [c.id, c.start_frame])).toEqual([
      ['a', 0],
      ['b', 100],
      ['x', 200],
      ['c', 230],
    ]);
    expect(frames(out)).toEqual([['m', 280, 0]]);
  });

  it('a ripple trim: the tail shorter pulls later markers back, the head longer pushes them on', () => {
    const tl = timeline([mk('in-tail', 95), mk('after', 150)], [clip('a', 0, 100), clip('b', 100, 100)]);
    const shorter = applyOp(tl, { kind: 'trim_end', track: 0, clip: 0, delta: -10, ripple: true });
    expect(frames(shorter)).toEqual([
      ['in-tail', 90, 0],
      ['after', 140, 0],
    ]);
    const src = timeline([mk('after', 150)], [{ ...clip('a', 0, 100), source_start: 50 }, clip('b', 100, 100)]);
    const longer = applyOp(src, { kind: 'trim_start', track: 0, clip: 0, delta: -20, ripple: true });
    expect(frames(longer)).toEqual([['after', 170, 0]]);
  });

  it('a plain (non-ripple) edit moves no marker', () => {
    const tl = timeline([mk('m', 150)]);
    expect(frames(applyOp(tl, { kind: 'remove', track: 0, clip: 1 }))).toEqual([['m', 150, 0]]);
    expect(frames(applyOp(tl, { kind: 'trim_end', track: 0, clip: 2, delta: -10 }))).toEqual([['m', 150, 0]]);
  });
});

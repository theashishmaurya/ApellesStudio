/**
 * Structural sharing of `applyOp` results (B-347 F4, D-434): an op that changes one
 * clip returns a timeline whose untouched clips, tracks and arrays are the SAME
 * objects as the input's, and the result equals what the deep-copying reducer
 * produced. Identity is what lets React skip unchanged `ClipBlock`s.
 */
import { describe, expect, it } from 'vitest';

import { applyOp, shareUnchanged, type Clip, type EditOp, type Timeline } from './timeline';

function clip(id: string, start: number, extra: Partial<Clip> = {}): Clip {
  return {
    id,
    name: id,
    source_path: `/media/${id}.mov`,
    source_start: 0,
    duration: 30,
    source_len: 120,
    start_frame: start,
    ...extra,
  };
}

/** V1: a b c d butted; A1: m; V2: empty. */
function fixture(): Timeline {
  return {
    id: 't',
    name: 'T',
    tracks: [
      { kind: 'video', clips: [clip('a', 0), clip('b', 30), clip('c', 60), clip('d', 90)] },
      { kind: 'audio', sync_locked: false, clips: [clip('m', 0, { duration: 120, source_len: 240 })] },
      { kind: 'video', clips: [] },
    ],
  };
}

const deepCopy = (tl: Timeline): Timeline => JSON.parse(JSON.stringify(tl)) as Timeline;

describe('applyOp keeps the identity of what it does not change', () => {
  it('a trim changes one clip; every other clip, and the other tracks, are the same objects', () => {
    const tl = fixture();
    const out = applyOp(tl, { kind: 'trim_end', track: 0, clip: 3, delta: -10 });
    expect(out).not.toBe(tl);
    expect(out.tracks[0].clips[3]).not.toBe(tl.tracks[0].clips[3]);
    expect(out.tracks[0].clips[3].duration).toBe(20);
    for (const i of [0, 1, 2]) expect(out.tracks[0].clips[i]).toBe(tl.tracks[0].clips[i]);
    expect(out.tracks[1]).toBe(tl.tracks[1]);
    expect(out.tracks[2]).toBe(tl.tracks[2]);
  });

  it('a ripple keeps the clips BEFORE the edit and moves the ones after', () => {
    const tl = fixture();
    const out = applyOp(tl, { kind: 'trim_end', track: 0, clip: 1, delta: -10, ripple: true });
    expect(out.tracks[0].clips[0]).toBe(tl.tracks[0].clips[0]);
    expect(out.tracks[0].clips.slice(1).map((c) => c.start_frame)).toEqual([30, 50, 80]);
    expect(out.tracks[1]).toBe(tl.tracks[1]);
  });

  it('a no-op op returns the input timeline itself', () => {
    const tl = fixture();
    expect(applyOp(tl, { kind: 'remove', track: 0, clip: 99 })).toBe(tl);
  });

  it('a split keeps the clips on both sides of it and the untouched track', () => {
    const tl = fixture();
    const out = applyOp(tl, { kind: 'split', track: 0, clip: 1, atFrame: 45 });
    expect(out.tracks[0].clips).toHaveLength(5);
    expect(out.tracks[0].clips[0]).toBe(tl.tracks[0].clips[0]);
    expect(out.tracks[0].clips[3]).toBe(tl.tracks[0].clips[2]);
    expect(out.tracks[0].clips[4]).toBe(tl.tracks[0].clips[3]);
    expect(out.tracks[1]).toBe(tl.tracks[1]);
  });

  it('never mutates the input and returns the same value a deep-copying reducer would', () => {
    const ops: EditOp[] = [
      { kind: 'trim_start', track: 0, clip: 2, delta: 5 },
      { kind: 'trim_end', track: 0, clip: 1, delta: -10, ripple: true },
      { kind: 'split', track: 0, clip: 0, atFrame: 10 },
      { kind: 'remove', track: 0, clip: 1 },
      { kind: 'slip', track: 0, clip: 1, delta: 4 },
      { kind: 'ripple_delete_ranges', track: 0, ranges: [{ start: 35, end: 50 }] },
    ];
    for (const op of ops) {
      const tl = fixture();
      const frozen = deepCopy(tl);
      const out = applyOp(tl, op);
      expect(tl).toEqual(frozen);
      // the output is a plain, fully-formed timeline (no stale shared half-edits)
      expect(out).toEqual(deepCopy(out));
    }
  });

  it('a batched ripple delete leaves the later mutation pass off the caller`s timeline', () => {
    const tl = fixture();
    const frozen = deepCopy(tl);
    const out = applyOp(tl, { kind: 'ripple_delete_ranges', track: 0, ranges: [{ start: 35, end: 50 }] });
    expect(tl).toEqual(frozen);
    expect(out.tracks[0].clips.map((c) => [c.start_frame, c.duration])).toEqual([
      [0, 30],
      [30, 5],
      [35, 10],
      [45, 30],
      [75, 30],
    ]);
  });
});

describe('shareUnchanged', () => {
  it('returns prev when next is deeply equal, and reuses unchanged subtrees otherwise', () => {
    const prev = { a: { x: [1, 2, { y: 3 }] }, b: { z: 1 } };
    expect(shareUnchanged(prev, JSON.parse(JSON.stringify(prev)))).toBe(prev);
    const next = JSON.parse(JSON.stringify(prev)) as typeof prev;
    next.b.z = 2;
    const out = shareUnchanged(prev, next);
    expect(out).toEqual({ a: { x: [1, 2, { y: 3 }] }, b: { z: 2 } });
    expect(out.a).toBe(prev.a);
    expect(out.b).not.toBe(prev.b);
  });

  it('notices added, removed and retyped keys and array length changes', () => {
    const prev: Record<string, unknown> = { a: 1, list: [1, 2] };
    expect(shareUnchanged(prev, { a: 1, list: [1, 2], extra: 1 })).toEqual({ a: 1, list: [1, 2], extra: 1 });
    expect(shareUnchanged(prev, { a: 1 })).toEqual({ a: 1 });
    expect(shareUnchanged(prev, { a: 1, list: [1] })).toEqual({ a: 1, list: [1] });
    expect(shareUnchanged(prev, { a: 1, list: { 0: 1, 1: 2 } })).toEqual({ a: 1, list: { 0: 1, 1: 2 } });
    expect(shareUnchanged({ a: undefined }, {})).toEqual({});
  });

  it('does not mutate either argument', () => {
    const prev = { k: { v: 1 }, n: { v: 1 } };
    const next = { k: { v: 1 }, n: { v: 2 } };
    const nextBefore = JSON.stringify(next);
    shareUnchanged(prev, next);
    expect(JSON.stringify(next)).toBe(nextBefore);
    expect(next.k).not.toBe(prev.k);
  });
});

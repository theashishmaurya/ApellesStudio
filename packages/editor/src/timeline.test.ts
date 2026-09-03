// @chroma/editor — unit tests for the pure edit-model helpers in
// `timeline.ts`: `labelForOp` (D-051) and, since D-056, the edit ops
// themselves — real inputs/outputs asserted against the same clamp/position
// rules `chroma-timeline::lib.rs`'s Rust ops use, per the D-056 fix (a
// frontend/backend model mismatch introduced by D-054 that nothing had
// re-verified until this pass — see D-056 in docs/08-decisions.md).
import { describe, expect, it } from 'vitest';
import { applyOp, endFrame, labelForOp, nextAppendFrame, type Clip, type Timeline, type Track } from './timeline';

function clip(id: string, name: string, overrides: Partial<Clip> = {}): Clip {
  return {
    id,
    name,
    source_path: `/media/${id}.mov`,
    source_start: 0,
    duration: 100,
    source_len: 100,
    start_frame: 0,
    ...overrides,
  };
}

/** Two clips back to back, matching what `from_shots`/a fresh project builds:
 *  `a` at [0,100), `b` at [100,200). */
function backToBack(): Clip[] {
  return [clip('a', 'Intro', { start_frame: 0 }), clip('b', 'B-roll 1', { start_frame: 100 })];
}

function tl(clips: Clip[]): Timeline {
  return { id: 't1', name: 'Timeline', tracks: [{ kind: 'video', clips }] };
}

describe('labelForOp', () => {
  const before = tl([clip('a', 'Intro'), clip('b', 'B-roll 1')]);

  it('names the clip for reorder', () => {
    expect(labelForOp({ kind: 'reorder', track: 0, from: 0, to: 1 }, before)).toBe('Reorder "Intro"');
  });

  it('names the clip and side for trim_start / trim_end', () => {
    expect(labelForOp({ kind: 'trim_start', track: 0, clip: 1, delta: 5 }, before)).toBe('Trim "B-roll 1" (start)');
    expect(labelForOp({ kind: 'trim_end', track: 0, clip: 1, delta: -5 }, before)).toBe('Trim "B-roll 1" (end)');
  });

  it('names the clip for split and remove', () => {
    expect(labelForOp({ kind: 'split', track: 0, clip: 0, atFrame: 50 }, before)).toBe('Split "Intro"');
    expect(labelForOp({ kind: 'remove', track: 0, clip: 0 }, before)).toBe('Remove "Intro"');
  });

  it('names the dropped media for add_clip', () => {
    const op = { kind: 'add_clip' as const, track: 0, clip: clip('c', 'New shot') };
    expect(labelForOp(op, before)).toBe('Add "New shot"');
  });

  it('falls back to a generic "clip" when the referenced clip is out of range', () => {
    expect(labelForOp({ kind: 'remove', track: 0, clip: 99 }, before)).toBe('Remove clip');
  });

  it('names the clip for move (D-056)', () => {
    expect(labelForOp({ kind: 'move', track: 0, clip: 1, startFrame: 250 }, before)).toBe('Move "B-roll 1"');
  });
});

// D-056 — every op below mirrors `chroma-timeline::lib.rs`'s Rust op of the
// same name; these are the ported equivalents of that crate's own unit
// tests (`trim_start`'s neighbor clamp, `trim_end`'s neighbor clamp,
// `split`'s new-half `start_frame`, `remove`'s "lift, not ripple", the
// append-at-track-end position `add_clip` computes) — real assertions on
// what actually gets computed, not a description of intended behaviour.
describe('add_clip (D-056)', () => {
  it('appends after the furthest clip already on the track', () => {
    const before = tl(backToBack()); // a:[0,100) b:[100,200)
    const after = applyOp(before, {
      kind: 'add_clip',
      track: 0,
      clip: clip('c', 'New shot', { duration: 50, source_len: 50 }),
    });
    const added = after.tracks[0].clips[2];
    expect(added.start_frame).toBe(200);
    expect(endFrame(added)).toBe(250);
  });

  it('starts at 0 on an empty track', () => {
    const before = tl([]);
    const after = applyOp(before, { kind: 'add_clip', track: 0, clip: clip('a', 'First') });
    expect(after.tracks[0].clips[0].start_frame).toBe(0);
  });

  it('appends after the furthest end even if a gap exists (not just the last Vec entry)', () => {
    // a:[0,100) then a gap, b:[300,400) — furthest end is b's 400, not a's 100
    const before = tl([clip('a', 'A', { start_frame: 0 }), clip('b', 'B', { start_frame: 300 })]);
    const after = applyOp(before, { kind: 'add_clip', track: 0, clip: clip('c', 'C', { duration: 10 }) });
    expect(after.tracks[0].clips[2].start_frame).toBe(400);
  });

  it('nextAppendFrame matches what add_clip actually computes', () => {
    const track: Track = { kind: 'video', clips: backToBack() };
    expect(nextAppendFrame(track)).toBe(200);
  });
});

describe('trim_start (D-056)', () => {
  it('shifts start_frame and source_start together, keeps end fixed, shrinks duration', () => {
    const before = tl(backToBack());
    const after = applyOp(before, { kind: 'trim_start', track: 0, clip: 1, delta: 15 });
    const b = after.tracks[0].clips[1];
    expect(b.start_frame).toBe(115); // moved right by delta
    expect(b.source_start).toBe(15);
    expect(b.duration).toBe(85);
    expect(endFrame(b)).toBe(200); // end unchanged — this is the actual fix
  });

  it('clamps so start_frame never moves before the preceding clip on the track', () => {
    // b starts exactly where a ends (100) and has source room to spare
    // (source_start 60, well clear of the [0, source_len) bound) — trying to
    // extend it left by 50 must still clamp at a's end (the *neighbor*
    // bound), not the source bound, which alone would have allowed it.
    const before = tl([
      clip('a', 'A', { start_frame: 0, duration: 100, source_len: 100 }),
      clip('b', 'B', { start_frame: 100, source_start: 60, duration: 100, source_len: 200 }),
    ]);
    const after = applyOp(before, { kind: 'trim_start', track: 0, clip: 1, delta: -50 });
    const b = after.tracks[0].clips[1];
    expect(b.start_frame).toBe(100); // clamped, not 50
    expect(b.source_start).toBe(60); // unchanged along with it
  });

  it('clamps to the source media bounds', () => {
    const before = tl([clip('a', 'A', { start_frame: 0, source_start: 0, duration: 100, source_len: 100 })]);
    const after = applyOp(before, { kind: 'trim_start', track: 0, clip: 0, delta: 500 });
    const a = after.tracks[0].clips[0];
    expect(a.duration).toBe(1); // can't go below 1 frame
    expect(a.source_start).toBe(99);
  });

  it('is a no-op (same reference) when the clip index is out of range', () => {
    const before = tl(backToBack());
    const after = applyOp(before, { kind: 'trim_start', track: 0, clip: 99, delta: 5 });
    expect(after).toBe(before);
  });
});

describe('trim_end (D-056)', () => {
  it('changes only duration, start_frame stays fixed', () => {
    const before = tl(backToBack());
    const after = applyOp(before, { kind: 'trim_end', track: 0, clip: 0, delta: -20 });
    const a = after.tracks[0].clips[0];
    expect(a.start_frame).toBe(0);
    expect(a.duration).toBe(80);
  });

  it('clamps so duration never grows past the next clip\'s start_frame', () => {
    // a is shorter than the gap to b so there's real room to grow into —
    // extending it a lot must still stop exactly at b's start, not overlap it.
    const before = tl([
      clip('a', 'A', { start_frame: 0, duration: 60, source_len: 1000 }),
      clip('b', 'B', { start_frame: 100 }),
    ]);
    const after = applyOp(before, { kind: 'trim_end', track: 0, clip: 0, delta: 1000 });
    const a = after.tracks[0].clips[0];
    expect(a.duration).toBe(100);
    expect(endFrame(a)).toBe(100); // clamped right at b's start, not overlapping
  });

  it('can grow freely past where a removed/gapped neighbor used to be', () => {
    const before = tl([clip('a', 'A', { start_frame: 0, duration: 50, source_len: 500 })]);
    const after = applyOp(before, { kind: 'trim_end', track: 0, clip: 0, delta: 200 });
    expect(after.tracks[0].clips[0].duration).toBe(250);
  });
});

describe('split (D-056)', () => {
  it('gives the right half its own correct start_frame, not a copy of the left half\'s', () => {
    const before = tl([clip('a', 'A', { start_frame: 50, duration: 100, source_len: 100 })]);
    const after = applyOp(before, { kind: 'split', track: 0, clip: 0, atFrame: 80 });
    const [left, right] = after.tracks[0].clips;
    expect(left.start_frame).toBe(50);
    expect(left.duration).toBe(30);
    expect(right.start_frame).toBe(80); // the D-056 bug: this used to equal left.start_frame (50)
    expect(right.duration).toBe(70);
    expect(right.source_start).toBe(30);
    // halves are exactly adjacent, no gap introduced by splitting itself
    expect(endFrame(left)).toBe(right.start_frame);
  });
});

describe('remove (D-056)', () => {
  it('lifts the clip without moving any other clip\'s start_frame (no ripple)', () => {
    const before = tl(backToBack());
    const after = applyOp(before, { kind: 'remove', track: 0, clip: 0 });
    expect(after.tracks[0].clips).toHaveLength(1);
    expect(after.tracks[0].clips[0].start_frame).toBe(100); // b never moved
  });
});

describe('move (D-056)', () => {
  it('repositions the clip to the requested start_frame', () => {
    const before = tl(backToBack());
    const after = applyOp(before, { kind: 'move', track: 0, clip: 1, startFrame: 500 });
    expect(after.tracks[0].clips[1].start_frame).toBe(500);
  });

  it('rejects (no-op) a move that would overlap another clip on the track', () => {
    const before = tl(backToBack()); // a:[0,100) b:[100,200)
    const after = applyOp(before, { kind: 'move', track: 0, clip: 1, startFrame: 50 }); // would overlap a
    expect(after).toBe(before);
  });

  it('rejects a negative position', () => {
    const before = tl(backToBack());
    const after = applyOp(before, { kind: 'move', track: 0, clip: 0, startFrame: -1 });
    expect(after).toBe(before);
  });
});

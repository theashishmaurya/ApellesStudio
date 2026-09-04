// @chroma/editor — unit tests for the pure edit-model helpers in
// `timeline.ts`: `labelForOp` (D-051) and, since D-058, the edit ops
// themselves — real inputs/outputs asserted against the same clamp/position
// rules `chroma-timeline::lib.rs`'s Rust ops use, per the D-058 fix (a
// frontend/backend model mismatch introduced by D-054 that nothing had
// re-verified until this pass — see D-058 in docs/08-decisions.md).
import { describe, expect, it } from 'vitest';
import {
  applyOp,
  audioTrackWithRoom,
  clipFromDraggedMedia,
  computeInsertion,
  endFrame,
  ensureAudioTrackWithRoom,
  findClip,
  gapAt,
  labelForOp,
  linkedClipIds,
  linkedClipsFromDraggedMedia,
  nextAppendFrame,
  resolveClipLanding,
  syncLinkedClipIds,
  syncLinkedClipIdsAtPosition,
  type Clip,
  type Timeline,
  type Track,
} from './timeline';

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

  it('names the track for remove_gap (D-105)', () => {
    expect(labelForOp({ kind: 'remove_gap', track: 0, frame: 120 }, before)).toBe('Close gap on track 1');
  });

  it('names the clip for move (D-058/D-080)', () => {
    expect(labelForOp({ kind: 'move', fromTrack: 0, toTrack: 0, clip: 1, startFrame: 250 }, before)).toBe(
      'Move "B-roll 1"',
    );
    expect(labelForOp({ kind: 'move', fromTrack: 0, toTrack: 1, clip: 1, startFrame: 250 }, before)).toBe(
      'Move "B-roll 1" to another track',
    );
  });

  it('names track ops (D-080)', () => {
    expect(labelForOp({ kind: 'add_track', trackKind: 'audio' }, before)).toBe('Add audio track');
    expect(labelForOp({ kind: 'remove_track', track: 1 }, before)).toBe('Remove track 2');
    expect(labelForOp({ kind: 'set_track_gain', track: 0, gain: 0 }, before)).toBe('Mute track 1');
    expect(labelForOp({ kind: 'set_track_gain', track: 0, gain: 1 }, before)).toBe('Unmute track 1');
  });

  it('names lock/hide/rearrange/transform ops (D-086/D-089)', () => {
    expect(labelForOp({ kind: 'set_track_locked', track: 0, locked: true }, before)).toBe('Lock track 1');
    expect(labelForOp({ kind: 'set_track_locked', track: 0, locked: false }, before)).toBe('Unlock track 1');
    expect(labelForOp({ kind: 'set_track_hidden', track: 0, hidden: true }, before)).toBe('Hide track 1');
    expect(labelForOp({ kind: 'set_track_hidden', track: 0, hidden: false }, before)).toBe('Show track 1');
    expect(labelForOp({ kind: 'move_track', from: 0, to: 1 }, before)).toBe('Reorder track 1');
    expect(
      labelForOp(
        { kind: 'set_clip_transform', track: 0, clip: 0, opacity: 1, position_x: 0, position_y: 0, scale: 1, rotation: 0 },
        before,
      ),
    ).toBe('Adjust "Intro"');
    expect(labelForOp({ kind: 'set_clip_keyframes', track: 0, clip: 0, keyframes: [] }, before)).toBe(
      'Keyframe "Intro"',
    );
  });
});

// D-058 — every op below mirrors `chroma-timeline::lib.rs`'s Rust op of the
// same name; these are the ported equivalents of that crate's own unit
// tests (`trim_start`'s neighbor clamp, `trim_end`'s neighbor clamp,
// `split`'s new-half `start_frame`, `remove`'s "lift, not ripple", the
// append-at-track-end position `add_clip` computes) — real assertions on
// what actually gets computed, not a description of intended behaviour.
describe('add_clip (D-058)', () => {
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

// D-095 — computeInsertion + add_clip's ripple-insert path (`startFrame`/
// `ripple`). Real drop-position math, not the plain-append default above —
// this is what fixes the live-reported "hovering a new clip between two
// existing ones doesn't snap/insert" gap (B-026).
describe('computeInsertion (D-095)', () => {
  it('snaps to the boundary between two touching clips and reports a ripple', () => {
    const track: Track = { kind: 'video', clips: backToBack() }; // a:[0,100) b:[100,200)
    const insertion = computeInsertion(track, 97, 30, 10); // dropped near frame 100, snap radius 10
    expect(insertion).toEqual({ startFrame: 100, ripple: true });
  });

  it('snaps to a clip edge but reports no ripple when the gap after it is big enough', () => {
    // a:[0,100) then open space — a 30-frame clip dropped right at a's end
    // fits with no need to move anything else.
    const track: Track = { kind: 'video', clips: [clip('a', 'A', { start_frame: 0 })] };
    const insertion = computeInsertion(track, 100, 30, 10);
    expect(insertion).toEqual({ startFrame: 100, ripple: false });
  });

  it('places a clip directly in an open gap with no snap and no ripple', () => {
    // a:[0,100) then a big gap, b:[500,600) — dropping at 250 (far from
    // either edge) with a 30-frame clip fits cleanly.
    const track: Track = { kind: 'video', clips: [clip('a', 'A', { start_frame: 0 }), clip('b', 'B', { start_frame: 500 })] };
    expect(computeInsertion(track, 250, 30, 10)).toEqual({ startFrame: 250, ripple: false });
  });

  it('snaps to 0 and ripples everything when dropped before the first clip', () => {
    const track: Track = { kind: 'video', clips: backToBack() };
    expect(computeInsertion(track, 3, 20, 10)).toEqual({ startFrame: 0, ripple: true });
  });

  // D-100 — the real "does not work" bug: hovering over the MIDDLE of an
  // existing clip (far from either of ITS edges, no snap) used to fall
  // through to `null` — a dead zone covering almost the whole clip's body
  // whenever two clips were already touching, since that's the ONLY case
  // where "far from any edge" is unavoidable (there's no open gap to fall
  // back into either). Now resolves to whichever half of the covering clip
  // is closer, so the clip's own full body is a real insertion target.
  it('resolves a mid-clip drop to the covering clip\'s nearer edge — first half inserts before it', () => {
    const track: Track = { kind: 'video', clips: [clip('a', 'A', { start_frame: 0, duration: 100 })] };
    // frame 20 is in A's first half (mid=50) — insert before A, rippling it forward.
    expect(computeInsertion(track, 20, 30, 10)).toEqual({ startFrame: 0, ripple: true });
  });

  it('resolves a mid-clip drop to the covering clip\'s nearer edge — second half inserts after it', () => {
    const track: Track = { kind: 'video', clips: [clip('a', 'A', { start_frame: 0, duration: 100 })] };
    // frame 80 is in A's second half — insert right after A; nothing else
    // on the track, so this is a clean append, no ripple needed.
    expect(computeInsertion(track, 80, 30, 10)).toEqual({ startFrame: 100, ripple: false });
  });

  it('the whole-clip-body fallback covers the entire span of two touching clips, not just their shared seam', () => {
    // a:[0,100) b:[100,200), zero gap — the actual live-reported scenario:
    // dropping ANYWHERE on either clip's body (not just within snapFrames
    // of the exact 100-frame seam) must resolve to a real ripple insert.
    const track: Track = { kind: 'video', clips: backToBack() };
    // deep inside A (first half) -> insert before A, ripple both A and B forward.
    expect(computeInsertion(track, 20, 15, 10)).toEqual({ startFrame: 0, ripple: true });
    // deep inside A (second half) -> insert after A / before B, ripple B forward.
    expect(computeInsertion(track, 80, 15, 10)).toEqual({ startFrame: 100, ripple: true });
    // deep inside B (second half, far from the track's own open end) -> insert after B.
    expect(computeInsertion(track, 180, 15, 10)).toEqual({ startFrame: 200, ripple: false });
  });

  it('still returns null for a drop in a genuinely empty region with no covering clip and no fitting gap', () => {
    // a:[0,50) then a real but too-small gap, b:[60,160) — frame 55 is in
    // the gap (not covering any clip) but a 30-frame clip there would
    // overlap b — genuinely ambiguous, out of this function's scope.
    const track: Track = { kind: 'video', clips: [clip('a', 'A', { start_frame: 0, duration: 50 }), clip('b', 'B', { start_frame: 60, duration: 100 })] };
    expect(computeInsertion(track, 55, 30, 3)).toBeNull();
  });

  it('always fits with no ripple on an empty track', () => {
    expect(computeInsertion({ kind: 'video', clips: [] }, 42, 30, 10)).toEqual({ startFrame: 42, ripple: false });
  });
});

describe('add_clip ripple insert (D-095)', () => {
  it('shifts every clip at/after the insertion point later by the new clip duration', () => {
    const before = tl(backToBack()); // a:[0,100) b:[100,200)
    const after = applyOp(before, {
      kind: 'add_clip',
      track: 0,
      clip: clip('c', 'Inserted', { duration: 30, source_len: 30 }),
      startFrame: 100,
      ripple: true,
    });
    const [a, c, b] = after.tracks[0].clips;
    expect(a.start_frame).toBe(0); // untouched — before the insertion point
    expect(c.start_frame).toBe(100); // the new clip lands exactly where dropped
    expect(endFrame(c)).toBe(130);
    expect(b.start_frame).toBe(130); // rippled forward by the new clip's 30 frames
  });

  it('does not move anything when ripple is false, even with an explicit startFrame', () => {
    const before = tl([clip('a', 'A', { start_frame: 0, duration: 100 }), clip('b', 'B', { start_frame: 500, duration: 100 })]);
    const after = applyOp(before, {
      kind: 'add_clip',
      track: 0,
      clip: clip('c', 'C', { duration: 30, source_len: 30 }),
      startFrame: 250,
      ripple: false,
    });
    expect(after.tracks[0].clips.find((c) => c.id === 'a')?.start_frame).toBe(0);
    expect(after.tracks[0].clips.find((c) => c.id === 'b')?.start_frame).toBe(500);
    expect(after.tracks[0].clips.find((c) => c.id === 'c')?.start_frame).toBe(250);
  });

  it('falls back to a plain append when startFrame is omitted, unchanged from before D-095', () => {
    const before = tl(backToBack());
    const after = applyOp(before, { kind: 'add_clip', track: 0, clip: clip('c', 'C', { duration: 30 }) });
    expect(after.tracks[0].clips[2].start_frame).toBe(200);
  });
});

describe('trim_start (D-058)', () => {
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

describe('trim_end (D-058)', () => {
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

describe('split (D-058)', () => {
  it('gives the right half its own correct start_frame, not a copy of the left half\'s', () => {
    const before = tl([clip('a', 'A', { start_frame: 50, duration: 100, source_len: 100 })]);
    const after = applyOp(before, { kind: 'split', track: 0, clip: 0, atFrame: 80 });
    const [left, right] = after.tracks[0].clips;
    expect(left.start_frame).toBe(50);
    expect(left.duration).toBe(30);
    expect(right.start_frame).toBe(80); // the D-058 bug: this used to equal left.start_frame (50)
    expect(right.duration).toBe(70);
    expect(right.source_start).toBe(30);
    // halves are exactly adjacent, no gap introduced by splitting itself
    expect(endFrame(left)).toBe(right.start_frame);
  });
});

describe('remove (D-058)', () => {
  it('lifts the clip without moving any other clip\'s start_frame (no ripple)', () => {
    const before = tl(backToBack());
    const after = applyOp(before, { kind: 'remove', track: 0, clip: 0 });
    expect(after.tracks[0].clips).toHaveLength(1);
    expect(after.tracks[0].clips[0].start_frame).toBe(100); // b never moved
  });
});

describe('auto-decommission empty tracks', () => {
  it('remove: prunes a track when its last clip is removed', () => {
    const before: Timeline = {
      id: 't1',
      name: 'Timeline',
      tracks: [{ kind: 'video', clips: [clip('a', 'A')] }, { kind: 'video', clips: [clip('b', 'B')] }],
    };
    const after = applyOp(before, { kind: 'remove', track: 0, clip: 0 });
    expect(after.tracks).toHaveLength(1);
    expect(after.tracks[0].clips[0].id).toBe('b'); // the survivor renumbers to index 0
  });

  it('remove: does NOT prune a track that still has another clip left', () => {
    const before = tl(backToBack()); // single track, 2 clips
    const after = applyOp(before, { kind: 'remove', track: 0, clip: 0 });
    expect(after.tracks).toHaveLength(1); // still there, just one clip lighter
  });

  it('remove: does NOT sweep an unrelated already-empty track (only the directly-edited one prunes)', () => {
    const before: Timeline = {
      id: 't1',
      name: 'Timeline',
      tracks: [
        { kind: 'video', clips: [clip('a', 'A'), clip('c', 'C', { start_frame: 200 })] },
        { kind: 'video', clips: [] }, // freshly added, deliberately empty — not this op's business
      ],
    };
    const after = applyOp(before, { kind: 'remove', track: 0, clip: 0 });
    expect(after.tracks).toHaveLength(2); // track 1 survives untouched
    expect(after.tracks[0].clips).toHaveLength(1); // track 0 just lost one clip, not pruned (still has 'c')
  });

  it('cross-track move: prunes the source track when it becomes empty', () => {
    const before: Timeline = {
      id: 't1',
      name: 'Timeline',
      tracks: [{ kind: 'video', clips: [clip('a', 'A')] }, { kind: 'video', clips: [] }],
    };
    const after = applyOp(before, { kind: 'move', fromTrack: 0, toTrack: 1, clip: 0, startFrame: 0 });
    expect(after.tracks).toHaveLength(1); // old track 0 pruned; old track 1 is now index 0
    expect(after.tracks[0].clips[0].id).toBe('a');
  });

  it('same-track move never prunes (clip count on the track is unchanged)', () => {
    const before = tl(backToBack());
    const after = applyOp(before, { kind: 'move', fromTrack: 0, toTrack: 0, clip: 1, startFrame: 500 });
    expect(after.tracks).toHaveLength(1);
  });
});

describe('gapAt / remove_gap (D-105)', () => {
  it('finds the gap between two clips that do not touch', () => {
    const t: Track = { kind: 'video', clips: [clip('a', 'A', { start_frame: 0 }), clip('b', 'B', { start_frame: 150 })] };
    // a is [0,100), b starts at 150 — a real 50-frame gap at [100,150).
    expect(gapAt(t, 120)).toEqual({ gapStart: 100, gapEnd: 150 });
  });

  it('returns null for a frame inside a clip', () => {
    const t: Track = { kind: 'video', clips: backToBack() };
    expect(gapAt(t, 50)).toBeNull();
  });

  it('returns null for trailing empty space past the last clip — nothing after it to ripple', () => {
    const t: Track = { kind: 'video', clips: backToBack() }; // ends at 200
    expect(gapAt(t, 500)).toBeNull();
  });

  it('finds a gap before the very first clip', () => {
    const t: Track = { kind: 'video', clips: [clip('a', 'A', { start_frame: 200 })] };
    expect(gapAt(t, 10)).toEqual({ gapStart: 0, gapEnd: 200 });
  });

  it('applyOp closes the gap and ripples every later clip earlier by its width', () => {
    const before = tl([clip('a', 'A', { start_frame: 0 }), clip('b', 'B', { start_frame: 150 })]); // 50-frame gap
    const after = applyOp(before, { kind: 'remove_gap', track: 0, frame: 120 });
    expect(after.tracks[0].clips[0].start_frame).toBe(0); // a untouched
    expect(after.tracks[0].clips[1].start_frame).toBe(100); // b shifted left by 50
  });

  it('is a no-op when frame is not inside a real, closeable gap', () => {
    const before = tl(backToBack());
    expect(applyOp(before, { kind: 'remove_gap', track: 0, frame: 50 })).toBe(before); // inside clip a
    expect(applyOp(before, { kind: 'remove_gap', track: 0, frame: 500 })).toBe(before); // trailing space
  });

  it('refuses on a locked track', () => {
    const before: Timeline = {
      id: 't1',
      name: 'Timeline',
      tracks: [{ kind: 'video', locked: true, clips: [clip('a', 'A', { start_frame: 0 }), clip('b', 'B', { start_frame: 150 })] }],
    };
    expect(applyOp(before, { kind: 'remove_gap', track: 0, frame: 120 })).toBe(before);
  });
});

describe('move (D-058/D-080)', () => {
  it('repositions the clip to the requested start_frame on the same track', () => {
    const before = tl(backToBack());
    const after = applyOp(before, { kind: 'move', fromTrack: 0, toTrack: 0, clip: 1, startFrame: 500 });
    expect(after.tracks[0].clips[1].start_frame).toBe(500);
  });

  it('rejects (no-op) a move that would overlap another clip on the destination track', () => {
    const before = tl(backToBack()); // a:[0,100) b:[100,200)
    const after = applyOp(before, { kind: 'move', fromTrack: 0, toTrack: 0, clip: 1, startFrame: 50 }); // would overlap a
    expect(after).toBe(before);
  });

  it('rejects a negative position', () => {
    const before = tl(backToBack());
    const after = applyOp(before, { kind: 'move', fromTrack: 0, toTrack: 0, clip: 0, startFrame: -1 });
    expect(after).toBe(before);
  });

  it('moves a clip onto a different track, preserving id/duration/source window', () => {
    const before: Timeline = {
      id: 't1',
      name: 'Timeline',
      tracks: [{ kind: 'video', clips: backToBack() }, { kind: 'video', clips: [] }],
    };
    const after = applyOp(before, { kind: 'move', fromTrack: 0, toTrack: 1, clip: 1, startFrame: 300 });
    expect(after.tracks[0].clips).toHaveLength(1);
    expect(after.tracks[0].clips[0].id).toBe('a');
    expect(after.tracks[1].clips).toHaveLength(1);
    const moved = after.tracks[1].clips[0];
    expect(moved.id).toBe('b');
    expect(moved.start_frame).toBe(300);
    expect(moved.duration).toBe(100);
    expect(moved.source_path).toBe('/media/b.mov');
  });

  // D-104: reverses D-096 — a cross-track move landing directly on top of
  // another clip's time range is now rejected too, same as a same-track
  // move (the test above). D-096 reasoned that since D-088's real
  // multi-layer compositor renders every visible track together, cross-track
  // overlap is a normal composited-layer stack, not an error — true in
  // principle, but live-tested and explicitly overridden by the owner:
  // overlap should never be a reachable outcome of a plain move.
  it('rejects (no-op) a cross-track move that would overlap a clip already on the destination track', () => {
    const before: Timeline = {
      id: 't1',
      name: 'Timeline',
      tracks: [
        { kind: 'video', clips: [clip('a', 'Intro', { start_frame: 0, duration: 100 })] },
        { kind: 'video', clips: [clip('x', 'Existing', { start_frame: 50, duration: 100 })] }, // [50,150)
      ],
    };
    // moving `a` (duration 100) to start at 100 on track 1 -> [100,200), overlaps [50,150)
    const after = applyOp(before, { kind: 'move', fromTrack: 0, toTrack: 1, clip: 0, startFrame: 100 });
    expect(after).toBe(before);
  });

  it('ripple: true shifts everything on the destination track at/after the landing point, same-track or cross-track', () => {
    const before: Timeline = {
      id: 't1',
      name: 'Timeline',
      tracks: [
        { kind: 'video', clips: [clip('a', 'Intro', { start_frame: 0, duration: 100 })] },
        { kind: 'video', clips: [clip('x', 'Existing', { start_frame: 100, duration: 100 })] }, // [100,200)
      ],
    };
    // landing exactly on x's own start (the real, edge-aligned case
    // `resolveClipLanding` always produces) — x shifts later to make room.
    const after = applyOp(before, { kind: 'move', fromTrack: 0, toTrack: 1, clip: 0, startFrame: 100, ripple: true });
    // Source track 0 is now empty and auto-decommissioned (owner, live) —
    // what was track 1 is the only track left, renumbered to index 0.
    expect(after.tracks).toHaveLength(1);
    expect(after.tracks[0].clips.map((c) => ({ id: c.id, start: c.start_frame }))).toEqual([
      { id: 'x', start: 200 }, // shifted later by a's duration (100) to make room
      { id: 'a', start: 100 },
    ]);
  });

  it('ripple: true still rejects a straddling clip it cannot cleanly shift out of the way', () => {
    // x starts BEFORE the landing point but extends past it — not a real
    // ripple-insert scenario any NLE supports without splitting x first
    // (and not a shape `resolveClipLanding` ever actually produces); ripple
    // can't rescue this, so it's rejected the same as a plain overlap.
    const before: Timeline = {
      id: 't1',
      name: 'Timeline',
      tracks: [
        { kind: 'video', clips: [clip('a', 'Intro', { start_frame: 0, duration: 100 })] },
        { kind: 'video', clips: [clip('x', 'Existing', { start_frame: 50, duration: 100 })] }, // [50,150)
      ],
    };
    const after = applyOp(before, { kind: 'move', fromTrack: 0, toTrack: 1, clip: 0, startFrame: 100, ripple: true });
    expect(after).toBe(before);
  });

  it('a same-track, same-position move is a real no-op', () => {
    const before = tl(backToBack());
    const after = applyOp(before, { kind: 'move', fromTrack: 0, toTrack: 0, clip: 0, startFrame: 0 });
    expect(after).toBe(before);
  });

  it('an out-of-range source or destination track is a no-op', () => {
    const before = tl(backToBack());
    expect(applyOp(before, { kind: 'move', fromTrack: 5, toTrack: 0, clip: 0, startFrame: 10 })).toBe(before);
    expect(applyOp(before, { kind: 'move', fromTrack: 0, toTrack: 5, clip: 0, startFrame: 10 })).toBe(before);
  });
});

// D-104 — the real bug fix: `TimelinePane`'s drag/"Move to" paths both go
// through this to decide where an EXISTING clip lands, so overlap is never a
// reachable outcome of a plain drag (owner, live-tested: "i should be able
// to drop it before any clip, between two clip or after two clip, not on top
// of the clip... that should not be possible").
describe('resolveClipLanding (D-104)', () => {
  const SNAP = 10;

  it('lands exactly where intended when that spot is genuinely open', () => {
    const dest: Track = { kind: 'video', clips: [clip('x', 'Existing', { start_frame: 0, duration: 100 })] };
    // moving clip "m" (not on this track) to an open spot at 500
    expect(resolveClipLanding(dest, 'm', 50, 500, SNAP)).toEqual({ startFrame: 500, ripple: false });
  });

  it('excludes the clip\'s own current slot on the destination track — a same-track no-op drop stays put', () => {
    const dest: Track = { kind: 'video', clips: backToBack() }; // a:[0,100) b:[100,200)
    // "b" dropped back onto its own current position must not collide with itself
    expect(resolveClipLanding(dest, 'b', 100, 100, SNAP)).toEqual({ startFrame: 100, ripple: false });
  });

  it('landing directly on top of another clip snaps to the nearest open edge instead', () => {
    const dest: Track = { kind: 'video', clips: [clip('x', 'Existing', { start_frame: 100, duration: 100 })] }; // [100,200)
    // dropped right in the middle of x's span, closer to its start than its end
    expect(resolveClipLanding(dest, 'm', 50, 130, SNAP)).toEqual({ startFrame: 100, ripple: true });
    // dropped closer to x's end
    expect(resolveClipLanding(dest, 'm', 50, 180, SNAP)).toEqual({ startFrame: 200, ripple: false });
  });

  it('drops right on the seam between two touching clips ripple-insert there, not overlap', () => {
    const dest: Track = { kind: 'video', clips: backToBack() }; // a:[0,100) b:[100,200), zero gap between them
    // a 30-frame clip dropped exactly on the seam snaps to it, but the seam
    // has zero width — b starts exactly where a ends — so fitting the new
    // clip there necessarily means shifting b later, not landing in an
    // already-open spot.
    expect(resolveClipLanding(dest, 'm', 30, 100, SNAP)).toEqual({ startFrame: 100, ripple: true });
  });

  it('a genuinely ambiguous drop (in a gap, but too big to fit, too far to snap) falls back to appending after the last clip', () => {
    // a:[0,100), a real gap [100,150), c:[150,250) — dropping at 120 (inside
    // the gap, not covered by any clip) with a 50-frame clip would still
    // overflow into c ([120,170) overlaps [150,250)), and 120 is too far
    // (>SNAP) from either the gap's start (100) or c's start (150) to snap —
    // computeInsertion's own contract returns null here (neither an open
    // fit, a clean snap, nor inside any clip's span to fall back to a half),
    // and resolveClipLanding's own fallback is exactly this: land after
    // everything else on the track instead of guessing.
    const dest: Track = {
      kind: 'video',
      clips: [clip('a', 'A', { start_frame: 0, duration: 100 }), clip('c', 'C', { start_frame: 150, duration: 100 })],
    };
    expect(computeInsertion(dest, 120, 50, SNAP)).toBeNull(); // confirms the premise, not just the wrapper's fallback
    expect(resolveClipLanding(dest, 'm', 50, 120, SNAP)).toEqual({ startFrame: 250, ripple: false });
  });

  it('an empty destination track always lands exactly at the intended frame', () => {
    const dest: Track = { kind: 'video', clips: [] };
    expect(resolveClipLanding(dest, 'm', 50, 42, SNAP)).toEqual({ startFrame: 42, ripple: false });
  });

  it('clamps a negative intended frame to 0', () => {
    const dest: Track = { kind: 'video', clips: [] };
    expect(resolveClipLanding(dest, 'm', 50, -20, SNAP)).toEqual({ startFrame: 0, ripple: false });
  });
});

describe('add_track / remove_track / set_track_gain (D-080)', () => {
  it('add_track appends an empty track of the requested kind with default gain', () => {
    const before = tl(backToBack());
    const after = applyOp(before, { kind: 'add_track', trackKind: 'audio' });
    expect(after.tracks).toHaveLength(2);
    expect(after.tracks[1]).toEqual({ kind: 'audio', clips: [], gain: 1.0, sync_locked: true });
  });

  it('remove_track drops the track and every clip on it', () => {
    const before: Timeline = {
      id: 't1',
      name: 'Timeline',
      tracks: [{ kind: 'video', clips: backToBack() }, { kind: 'audio', clips: [] }],
    };
    const after = applyOp(before, { kind: 'remove_track', track: 0 });
    expect(after.tracks).toHaveLength(1);
    expect(after.tracks[0].kind).toBe('audio');
  });

  it('remove_track is a no-op for an out-of-range index', () => {
    const before = tl(backToBack());
    expect(applyOp(before, { kind: 'remove_track', track: 5 })).toBe(before);
  });

  it('set_track_gain sets the gain field directly (mute is gain: 0)', () => {
    const before = tl(backToBack());
    const muted = applyOp(before, { kind: 'set_track_gain', track: 0, gain: 0 });
    expect(muted.tracks[0].gain).toBe(0);
    const restored = applyOp(muted, { kind: 'set_track_gain', track: 0, gain: 1 });
    expect(restored.tracks[0].gain).toBe(1);
  });

  it('set_track_gain is a no-op for an out-of-range index', () => {
    const before = tl(backToBack());
    expect(applyOp(before, { kind: 'set_track_gain', track: 5, gain: 0 })).toBe(before);
  });
});

describe('set_track_locked / set_track_hidden / move_track (D-086/D-089)', () => {
  it('set_track_locked sets the locked field directly', () => {
    const before = tl(backToBack());
    const locked = applyOp(before, { kind: 'set_track_locked', track: 0, locked: true });
    expect(locked.tracks[0].locked).toBe(true);
    const unlocked = applyOp(locked, { kind: 'set_track_locked', track: 0, locked: false });
    expect(unlocked.tracks[0].locked).toBe(false);
  });

  it('set_track_locked is a no-op for an out-of-range index', () => {
    const before = tl(backToBack());
    expect(applyOp(before, { kind: 'set_track_locked', track: 5, locked: true })).toBe(before);
  });

  it('set_track_hidden sets the hidden field directly', () => {
    const before = tl(backToBack());
    const after = applyOp(before, { kind: 'set_track_hidden', track: 0, hidden: true });
    expect(after.tracks[0].hidden).toBe(true);
  });

  it('set_track_hidden is a no-op for an out-of-range index', () => {
    const before = tl(backToBack());
    expect(applyOp(before, { kind: 'set_track_hidden', track: 5, hidden: true })).toBe(before);
  });

  it('move_track reorders the track list', () => {
    const before: Timeline = {
      id: 't1',
      name: 'Timeline',
      tracks: [
        { kind: 'video', clips: [], gain: 1 },
        { kind: 'audio', clips: [], gain: 1 },
        { kind: 'audio', clips: [], gain: 0.5 },
      ],
    };
    const after = applyOp(before, { kind: 'move_track', from: 2, to: 0 });
    expect(after.tracks.map((t) => t.gain)).toEqual([0.5, 1, 1]);
  });

  it('move_track same index is a real no-op', () => {
    const before = tl(backToBack());
    expect(applyOp(before, { kind: 'move_track', from: 0, to: 0 })).toBe(before);
  });

  it('move_track out of range is a no-op', () => {
    const before = tl(backToBack());
    expect(applyOp(before, { kind: 'move_track', from: 5, to: 0 })).toBe(before);
    expect(applyOp(before, { kind: 'move_track', from: 0, to: 5 })).toBe(before);
  });

  it('move_track is not blocked by a locked track (track-list structure, not per-clip editing)', () => {
    const before: Timeline = {
      id: 't1',
      name: 'Timeline',
      tracks: [
        { kind: 'video', clips: [], locked: true },
        { kind: 'audio', clips: [] },
      ],
    };
    const after = applyOp(before, { kind: 'move_track', from: 0, to: 1 });
    expect(after.tracks[0].kind).toBe('audio');
    expect(after.tracks[1]).toEqual({ kind: 'video', clips: [], locked: true });
  });
});

describe('set_clip_transform / set_clip_keyframes (D-088/D-089)', () => {
  it('set_clip_transform writes all five transform fields together', () => {
    const before = tl(backToBack());
    const after = applyOp(before, {
      kind: 'set_clip_transform',
      track: 0,
      clip: 0,
      opacity: 0.5,
      position_x: 10,
      position_y: -20,
      scale: 1.5,
      rotation: 90,
    });
    const c = after.tracks[0].clips[0];
    expect(c.opacity).toBe(0.5);
    expect(c.position_x).toBe(10);
    expect(c.position_y).toBe(-20);
    expect(c.scale).toBe(1.5);
    expect(c.rotation).toBe(90);
  });

  it('set_clip_transform is a no-op for an out-of-range clip', () => {
    const before = tl(backToBack());
    expect(applyOp(before, { kind: 'set_clip_transform', track: 0, clip: 99, opacity: 1, position_x: 0, position_y: 0, scale: 1, rotation: 0 })).toBe(before);
  });

  it('set_clip_keyframes writes the keyframe array', () => {
    const before = tl(backToBack());
    const keyframes = [{ frame: 0, params: { opacity: 0 } }, { frame: 30, params: { opacity: 1 } }];
    const after = applyOp(before, { kind: 'set_clip_keyframes', track: 0, clip: 0, keyframes });
    expect(after.tracks[0].clips[0].chroma_keyframes).toEqual(keyframes);
  });

  it('set_clip_keyframes normalizes an empty array to undefined, never round-tripping as keyframed', () => {
    const before = tl([clip('a', 'Intro', { chroma_keyframes: [{ frame: 0, params: { opacity: 1 } }] })]);
    const after = applyOp(before, { kind: 'set_clip_keyframes', track: 0, clip: 0, keyframes: [] });
    expect(after.tracks[0].clips[0].chroma_keyframes).toBeUndefined();
  });
});

describe('track lock enforcement (D-086/D-089) — mirrors chroma_timeline::TimelineError::TrackLocked', () => {
  function lockedTl(): Timeline {
    return { id: 't1', name: 'Timeline', tracks: [{ kind: 'video', clips: backToBack(), locked: true }] };
  }

  it('reorder is refused on a locked track', () => {
    const before = lockedTl();
    expect(applyOp(before, { kind: 'reorder', track: 0, from: 0, to: 1 })).toBe(before);
  });

  it('trim_start is refused on a locked track', () => {
    const before = lockedTl();
    expect(applyOp(before, { kind: 'trim_start', track: 0, clip: 1, delta: 5 })).toBe(before);
  });

  it('trim_end is refused on a locked track', () => {
    const before = lockedTl();
    expect(applyOp(before, { kind: 'trim_end', track: 0, clip: 0, delta: -5 })).toBe(before);
  });

  it('split is refused on a locked track', () => {
    const before = lockedTl();
    expect(applyOp(before, { kind: 'split', track: 0, clip: 0, atFrame: 50 })).toBe(before);
  });

  it('remove is refused on a locked track', () => {
    const before = lockedTl();
    expect(applyOp(before, { kind: 'remove', track: 0, clip: 0 })).toBe(before);
  });

  it('set_clip_transform is refused on a locked track', () => {
    const before = lockedTl();
    expect(
      applyOp(before, { kind: 'set_clip_transform', track: 0, clip: 0, opacity: 0.5, position_x: 0, position_y: 0, scale: 1, rotation: 0 }),
    ).toBe(before);
  });

  it('set_clip_keyframes is refused on a locked track', () => {
    const before = lockedTl();
    expect(applyOp(before, { kind: 'set_clip_keyframes', track: 0, clip: 0, keyframes: [{ frame: 0, params: {} }] })).toBe(
      before,
    );
  });

  it('move is refused when the source track is locked', () => {
    const before: Timeline = {
      id: 't1',
      name: 'Timeline',
      tracks: [
        { kind: 'video', clips: backToBack(), locked: true },
        { kind: 'video', clips: [] },
      ],
    };
    expect(applyOp(before, { kind: 'move', fromTrack: 0, toTrack: 1, clip: 0, startFrame: 500 })).toBe(before);
  });

  it('move is refused when the destination track is locked', () => {
    const before: Timeline = {
      id: 't1',
      name: 'Timeline',
      tracks: [
        { kind: 'video', clips: backToBack() },
        { kind: 'video', clips: [], locked: true },
      ],
    };
    expect(applyOp(before, { kind: 'move', fromTrack: 0, toTrack: 1, clip: 0, startFrame: 500 })).toBe(before);
  });

  it('locking a track does not block track-list ops (add_track/remove_track/move_track)', () => {
    const before: Timeline = {
      id: 't1',
      name: 'Timeline',
      tracks: [{ kind: 'video', clips: backToBack(), locked: true }],
    };
    expect(applyOp(before, { kind: 'add_track', trackKind: 'audio' }).tracks).toHaveLength(2);
    expect(applyOp(before, { kind: 'remove_track', track: 0 }).tracks).toHaveLength(0);
  });
});

describe('clipFromDraggedMedia (D-070)', () => {
  it('sets media_id from the dragged Sources-panel item, not shot_id', () => {
    const built = clipFromDraggedMedia({ id: 'media-1', sourcePath: '/a.mov', name: 'a.mov', frameCount: 240 });
    expect(built).not.toBeNull();
    expect(built!.media_id).toBe('media-1');
    expect(built!.shot_id).toBeNull();
    expect(built!.source_path).toBe('/a.mov');
    expect(built!.duration).toBe(240);
  });

  it('returns null for media with no known frame count (unprobed/offline)', () => {
    expect(clipFromDraggedMedia({ id: 'm', sourcePath: '/a.mov', name: 'a.mov', frameCount: null })).toBeNull();
    expect(clipFromDraggedMedia({ id: 'm', sourcePath: '/a.mov', name: 'a.mov' })).toBeNull();
  });
});

// -------------------------------------------------------------------------- //
// cross-track ripple sync (D-106) — mirrors crates/chroma-timeline's own
// sync-lock test suite field-for-field, same fixtures/assertions.
// -------------------------------------------------------------------------- //

function twoTrack(track0: Clip[], track1: Clip[]): Timeline {
  return {
    id: 't',
    name: 't',
    tracks: [
      { kind: 'video', clips: track0 },
      { kind: 'video', clips: track1 },
    ],
  };
}

describe('cross-track ripple sync (D-106)', () => {
  it('treats an absent sync_locked key as true (backward compat) — a pre-D-106 track still ripples', () => {
    // The fixture deliberately never sets `sync_locked` on track 1 — a real
    // pre-D-106 project's tracks have no such key at all. It must still
    // receive the ripple, matching a freshly-built track's own default.
    const before = twoTrack(
      [clip('a', 'A', { start_frame: 0, duration: 50 }), clip('b', 'B', { start_frame: 50, duration: 50 })],
      [clip('x', 'X', { start_frame: 200, duration: 50 })],
    );
    expect(before.tracks[1].sync_locked).toBeUndefined();
    before.tracks[0].clips.push(clip('new', 'New', { start_frame: 300, duration: 30 }));
    const after = applyOp(before, { kind: 'move', fromTrack: 0, toTrack: 0, clip: 2, startFrame: 50, ripple: true });
    expect(after.tracks[1].clips.find((c) => c.id === 'x')!.start_frame).toBe(230);
  });

  it('add_track produces a track with sync_locked: true', () => {
    const before = twoTrack([], []);
    const after = applyOp(before, { kind: 'add_track', trackKind: 'audio' });
    expect(after.tracks[2].sync_locked).toBe(true);
  });

  it('move ripple propagates to a sync-locked track', () => {
    const before = twoTrack(
      [clip('a', 'A', { start_frame: 0, duration: 50 }), clip('b', 'B', { start_frame: 50, duration: 50 })],
      [clip('x', 'X', { start_frame: 200, duration: 50 })],
    );
    before.tracks[0].clips.push(clip('new', 'New', { start_frame: 300, duration: 30 }));
    const after = applyOp(before, { kind: 'move', fromTrack: 0, toTrack: 0, clip: 2, startFrame: 50, ripple: true });
    expect(after.tracks[0].clips.find((c) => c.id === 'b')!.start_frame).toBe(80);
    expect(after.tracks[1].clips.find((c) => c.id === 'x')!.start_frame).toBe(230);
  });

  it('move ripple skips a track with sync_locked: false', () => {
    // Note the fixture MUST force a real ripple on track 0 (via clip `b`
    // overlapping the landing point) — otherwise this test would pass
    // vacuously (nothing ripples anywhere, track 1 "unaffected" for the
    // wrong reason). Asserting `b` DID shift proves the ripple genuinely
    // fired and track 1 was deliberately excluded, not just untouched.
    const before = twoTrack(
      [clip('a', 'A', { start_frame: 0, duration: 50 }), clip('b', 'B', { start_frame: 50, duration: 50 })],
      [clip('x', 'X', { start_frame: 200, duration: 50 })],
    );
    before.tracks[1].sync_locked = false;
    before.tracks[0].clips.push(clip('new', 'New', { start_frame: 300, duration: 30 }));
    const after = applyOp(before, { kind: 'move', fromTrack: 0, toTrack: 0, clip: 2, startFrame: 50, ripple: true });
    // ripple genuinely fired on track 0 — track 1's exclusion below is real, not vacuous
    expect(after.tracks[0].clips.find((c) => c.id === 'b')!.start_frame).toBe(80);
    expect(after.tracks[1].clips.find((c) => c.id === 'x')!.start_frame).toBe(200);
  });

  it('move ripple skips a locked track even if sync_locked', () => {
    const before = twoTrack(
      [clip('a', 'A', { start_frame: 0, duration: 50 }), clip('b', 'B', { start_frame: 50, duration: 50 })],
      [clip('x', 'X', { start_frame: 200, duration: 50 })],
    );
    before.tracks[1].locked = true;
    before.tracks[0].clips.push(clip('new', 'New', { start_frame: 300, duration: 30 }));
    const after = applyOp(before, { kind: 'move', fromTrack: 0, toTrack: 0, clip: 2, startFrame: 50, ripple: true });
    // ripple genuinely fired on track 0 — track 1's exclusion below is real, not vacuous
    expect(after.tracks[0].clips.find((c) => c.id === 'b')!.start_frame).toBe(80);
    expect(after.tracks[1].clips.find((c) => c.id === 'x')!.start_frame).toBe(200);
  });

  it('remove_gap rejects (B-033, reverted from auto-split) when a straddling clip sits on a synced track', () => {
    // B-033: auto-split let a repeated ripple keep re-splitting an already-
    // split fragment, confirmed to corrupt a real project. Reverted to
    // D-104's own reject-on-straddle contract, generalized to cross-track.
    const before = twoTrack(
      [clip('a', 'A', { start_frame: 0, duration: 50 }), clip('b', 'B', { start_frame: 80, duration: 50 })],
      [clip('x', 'X', { start_frame: 20, duration: 180, source_len: 10_000 })],
    );
    const after = applyOp(before, { kind: 'remove_gap', track: 0, frame: 60 });
    expect(after).toBe(before); // whole op rejected, nothing moves anywhere
  });

  it('remove_gap ripple propagates without a matching gap on the synced track', () => {
    const before = twoTrack(
      [clip('a', 'A', { start_frame: 0, duration: 50 }), clip('b', 'B', { start_frame: 80, duration: 50 })],
      [clip('y', 'Y', { start_frame: 90, duration: 20 })],
    );
    const after = applyOp(before, { kind: 'remove_gap', track: 0, frame: 60 });
    expect(after.tracks[1].clips.find((c) => c.id === 'y')!.start_frame).toBe(60);
  });

  it('B-033 regression: repeated remove_gap calls never fragment a straddling clip, no matter how many times applied', () => {
    // Reproduces the shape of the real corruption on the owner's project:
    // several tracks, one clip on the receiving track straddling the ripple
    // point. Before the fix this would auto-split further on every call
    // that still found a (new) straddle; now every call that would touch a
    // straddling clip is rejected outright, so applying it 5x in a row is
    // provably a no-op past the first successful shift, never a cascade of
    // ever-smaller fragments.
    let tl: Timeline = {
      id: 't',
      name: 'n',
      rate: { num: 30, den: 1 },
      tracks: [
        {
          kind: 'video',
          clips: [
            clip('a', 'A', { start_frame: 0, duration: 50 }),
            clip('b', 'B', { start_frame: 80, duration: 50 }),
          ],
          gain: 1,
          sync_locked: true,
        },
        {
          kind: 'video',
          clips: [clip('x', 'X', { start_frame: 20, duration: 180, source_len: 10_000 })],
          gain: 1,
          sync_locked: true,
        },
      ],
    };
    // A real, closeable gap on track 0 ([50,80)) whose close-point (80)
    // straddles track 1's clip 'x' ([20,200)) — the exact shape that used
    // to auto-split. Apply it 5x in a row: every single call must reject
    // (same reason each time — the straddle never goes away since nothing
    // ever moves), never partially apply, never fragment further.
    for (let i = 0; i < 5; i++) {
      tl = applyOp(tl, { kind: 'remove_gap', track: 0, frame: 60 });
    }
    expect(tl.tracks[0].clips.find((c) => c.id === 'b')!.start_frame).toBe(80); // never moved
    expect(tl.tracks[1].clips).toHaveLength(1);
    expect(tl.tracks[1].clips[0]).toMatchObject({ id: 'x', start_frame: 20, duration: 180 });
  });
});

describe('syncLinkedClipIds — the visual "sync-linked to this selection" set (owner, 2026-09-04)', () => {
  it('links a clip on another sync-locked track that starts at/after the selected clip (would shift together)', () => {
    const tl = twoTrack(
      [clip('a', 'A', { start_frame: 0, duration: 50 })],
      [clip('x', 'X', { start_frame: 50, duration: 20 }), clip('y', 'Y', { start_frame: 100, duration: 20 })],
    );
    const linked = syncLinkedClipIds(tl, [{ track: 0, id: 'a' }]);
    expect(linked).toEqual(new Set(['x', 'y']));
  });

  it('does not link a clip on another sync-locked track that ends before the selected clip starts', () => {
    const tl = twoTrack(
      [clip('a', 'A', { start_frame: 100, duration: 50 })],
      [clip('x', 'X', { start_frame: 0, duration: 20 })], // fully before threshold=100, no straddle
    );
    expect(syncLinkedClipIds(tl, [{ track: 0, id: 'a' }])).toEqual(new Set());
  });

  it('links a straddling clip too (the B-033 blocker case) — related to the selection whether it would shift or block', () => {
    const tl = twoTrack(
      [clip('a', 'A', { start_frame: 100, duration: 50 })],
      [clip('x', 'X', { start_frame: 50, duration: 100 })], // straddles threshold=100
    );
    expect(syncLinkedClipIds(tl, [{ track: 0, id: 'a' }])).toEqual(new Set(['x']));
  });

  it('never links a clip on the selected clip\'s own track', () => {
    const tl = twoTrack(
      [clip('a', 'A', { start_frame: 0, duration: 50 }), clip('b', 'B', { start_frame: 50, duration: 50 })],
      [],
    );
    expect(syncLinkedClipIds(tl, [{ track: 0, id: 'a' }])).toEqual(new Set());
  });

  it('excludes a track with sync_locked: false', () => {
    const tl = twoTrack(
      [clip('a', 'A', { start_frame: 0, duration: 50 })],
      [clip('x', 'X', { start_frame: 50, duration: 20 })],
    );
    tl.tracks[1].sync_locked = false;
    expect(syncLinkedClipIds(tl, [{ track: 0, id: 'a' }])).toEqual(new Set());
  });

  it('excludes a track that is individually locked, even if sync_locked', () => {
    const tl = twoTrack(
      [clip('a', 'A', { start_frame: 0, duration: 50 })],
      [clip('x', 'X', { start_frame: 50, duration: 20 })],
    );
    tl.tracks[1].locked = true;
    expect(syncLinkedClipIds(tl, [{ track: 0, id: 'a' }])).toEqual(new Set());
  });

  it('returns the union across a multi-clip selection', () => {
    const tl: Timeline = {
      id: 't',
      name: 't',
      tracks: [
        { kind: 'video', clips: [clip('a', 'A', { start_frame: 0, duration: 20 }), clip('b', 'B', { start_frame: 100, duration: 20 })] },
        { kind: 'video', clips: [clip('x', 'X', { start_frame: 10, duration: 20 })] },
        { kind: 'video', clips: [clip('y', 'Y', { start_frame: 105, duration: 20 })] },
      ],
    };
    const linked = syncLinkedClipIds(tl, [
      { track: 0, id: 'a' }, // threshold 0 -> links 'x' (starts 10 >= 0) and 'y' (105 >= 0)
      { track: 0, id: 'b' }, // threshold 100 -> 'x' (10) is not >= 100 and doesn't straddle; 'y' (105 >= 100) still links
    ]);
    expect(linked).toEqual(new Set(['x', 'y']));
  });

  it('returns an empty set for an empty selection', () => {
    const tl = twoTrack([clip('a', 'A')], [clip('x', 'X')]);
    expect(syncLinkedClipIds(tl, [])).toEqual(new Set());
  });

  it('is a no-op-safe empty set when the selected clip id does not exist on its track', () => {
    const tl = twoTrack([clip('a', 'A')], [clip('x', 'X')]);
    expect(syncLinkedClipIds(tl, [{ track: 0, id: 'does-not-exist' }])).toEqual(new Set());
  });
});

describe('syncLinkedClipIdsAtPosition — the live drag-preview variant (D-113)', () => {
  // Same predicate as syncLinkedClipIds, but from an explicit (track,
  // thresholdFrame) pair — the shape `TimelinePane.tsx`'s onDndDragMove
  // needs, since a clip mid-drag to a new track isn't a member of that
  // track's clips yet (there's no real clip to look up a start_frame from).

  it('links a clip on another sync-locked track at/after the given threshold, from a bare position (no real clip needed)', () => {
    const tl = twoTrack([], [clip('x', 'X', { start_frame: 50, duration: 20 }), clip('y', 'Y', { start_frame: 100, duration: 20 })]);
    expect(syncLinkedClipIdsAtPosition(tl, 0, 40)).toEqual(new Set(['x', 'y']));
  });

  it('does not link a clip fully before the threshold', () => {
    const tl = twoTrack([], [clip('x', 'X', { start_frame: 0, duration: 20 })]);
    expect(syncLinkedClipIdsAtPosition(tl, 0, 100)).toEqual(new Set());
  });

  it('links a straddling clip too, same as the selection-based variant', () => {
    const tl = twoTrack([], [clip('x', 'X', { start_frame: 50, duration: 100 })]);
    expect(syncLinkedClipIdsAtPosition(tl, 0, 100)).toEqual(new Set(['x']));
  });

  it('excludes the edited track itself and any sync_locked: false / individually locked track', () => {
    const tl: Timeline = {
      id: 't',
      name: 't',
      tracks: [
        { kind: 'video', clips: [clip('same', 'Same', { start_frame: 50, duration: 20 })] },
        { kind: 'video', clips: [clip('x', 'X', { start_frame: 50, duration: 20 })], sync_locked: false },
        { kind: 'video', clips: [clip('y', 'Y', { start_frame: 50, duration: 20 })], locked: true },
        { kind: 'video', clips: [clip('z', 'Z', { start_frame: 50, duration: 20 })] },
      ],
    };
    expect(syncLinkedClipIdsAtPosition(tl, 0, 0)).toEqual(new Set(['z']));
  });

  it('agrees with syncLinkedClipIds when given the same (track, threshold) a real selected clip would resolve to', () => {
    const tl = twoTrack(
      [clip('a', 'A', { start_frame: 30, duration: 40 })],
      [clip('x', 'X', { start_frame: 50, duration: 20 })],
    );
    const viaSelection = syncLinkedClipIds(tl, [{ track: 0, id: 'a' }]);
    const viaPosition = syncLinkedClipIdsAtPosition(tl, 0, 30);
    expect(viaPosition).toEqual(viaSelection);
  });
});

// D-118 — `findClip` is the lookup `EditorInspectorPanel` (a real sibling of
// `TimelinePane` now, not nested inside it) needs to resolve the store's
// lifted `selection` back to an actual `Clip`, without duplicating the
// `tracks[track]?.clips.findIndex(...)` logic in two files.
describe('findClip (D-118)', () => {
  it('finds a real clip by track + id, with its index', () => {
    const tl = twoTrack([clip('a', 'A')], [clip('x', 'X'), clip('y', 'Y')]);
    expect(findClip(tl, 1, 'y')).toEqual({ clip: expect.objectContaining({ id: 'y' }), index: 1 });
  });

  it('returns null for an id not on that track — a stale selection (removed clip), not a crash', () => {
    const tl = twoTrack([clip('a', 'A')], [clip('x', 'X')]);
    expect(findClip(tl, 1, 'gone')).toBeNull();
  });

  it('returns null for an out-of-range track index', () => {
    const tl = twoTrack([clip('a', 'A')], []);
    expect(findClip(tl, 5, 'a')).toBeNull();
  });

  it('returns null for a null timeline — the "nothing loaded yet" case', () => {
    expect(findClip(null, 0, 'a')).toBeNull();
  });
});

// --------------------------------------------------------------------------- //
// A/V link groups (D-129, `docs/notes/av-linking.md`) — mirrors the Rust
// crate's own link tests, plus the `add_clip` drop path the Rust crate has no
// equivalent of (it has no clip-creation op).
// --------------------------------------------------------------------------- //

/** A video track + an audio track holding one linked A/V pair — the exact
 *  shape dropping a clip with embedded audio now produces: V1 [0,100) and
 *  A1 [0,100), same source, same `link_group`. */
function linkedPair(): Timeline {
  return {
    id: 't',
    name: 't',
    tracks: [
      { kind: 'video', clips: [clip('v', 'Shot', { link_group: 'g1' })] },
      { kind: 'audio', clips: [clip('a', 'Shot', { link_group: 'g1' })] },
    ],
  };
}

const startOf = (t: Timeline, track: number, id: string) =>
  t.tracks[track].clips.find((c) => c.id === id)?.start_frame;

describe('linkedClipsFromDraggedMedia (D-129)', () => {
  const media = { id: 'm1', sourcePath: '/media/m1.mov', name: 'Shot', frameCount: 120 };

  it('builds a linked audio half for a source that really has audio', () => {
    const pair = linkedClipsFromDraggedMedia({ ...media, hasAudio: true });
    expect(pair).not.toBeNull();
    expect(pair!.audio).not.toBeNull();
    expect(pair!.video.link_group).toBeTruthy();
    expect(pair!.audio!.link_group).toBe(pair!.video.link_group);
    expect(pair!.audio!.id).not.toBe(pair!.video.id);
    // congruent by construction — same source window and length as the picture
    expect(pair!.audio!.source_path).toBe(pair!.video.source_path);
    expect(pair!.audio!.duration).toBe(pair!.video.duration);
    expect(pair!.audio!.source_start).toBe(pair!.video.source_start);
  });

  it('builds NO audio half, and leaves the video unlinked, for a silent source', () => {
    const pair = linkedClipsFromDraggedMedia({ ...media, hasAudio: false });
    expect(pair!.audio).toBeNull();
    expect(pair!.video.link_group).toBeNull();
  });

  it('treats an unknown hasAudio (a pre-D-129 pool item) as no audio half — never guesses', () => {
    const pair = linkedClipsFromDraggedMedia(media); // hasAudio absent entirely
    expect(pair!.audio).toBeNull();
    expect(pair!.video.link_group).toBeNull();
  });

  it('still rejects media with no usable frame count, exactly as before', () => {
    expect(linkedClipsFromDraggedMedia({ ...media, frameCount: 0, hasAudio: true })).toBeNull();
    expect(linkedClipsFromDraggedMedia({ ...media, frameCount: null, hasAudio: true })).toBeNull();
  });

  it('clipFromDraggedMedia keeps returning just the video half (unchanged callers)', () => {
    const v = clipFromDraggedMedia({ ...media, hasAudio: true });
    expect(v?.name).toBe('Shot');
    expect(v?.duration).toBe(120);
  });
});

describe('audio-track placement for a dropped pair (D-129)', () => {
  it('finds a free audio track, and never a video or locked one', () => {
    const t = linkedPair();
    expect(audioTrackWithRoom(t, 0, 100)).toBeNull(); // A1 busy over [0,100)
    expect(audioTrackWithRoom(t, 200, 100)).toBe(1); // past it — room
    t.tracks[1].locked = true;
    expect(audioTrackWithRoom(t, 200, 100)).toBeNull();
  });

  it('creates a new audio track only when no existing one has room', () => {
    const busy = linkedPair();
    expect(ensureAudioTrackWithRoom(busy, 0, 100)).toBe(2);
    expect(busy.tracks[2]).toMatchObject({ kind: 'audio', clips: [], gain: 1, sync_locked: true });

    const free = linkedPair();
    expect(ensureAudioTrackWithRoom(free, 500, 100)).toBe(1);
    expect(free.tracks).toHaveLength(2); // reused A1 — no pile-up of empty tracks
  });
});

describe('add_clip with a linked audio half (D-129)', () => {
  const pair = () => linkedClipsFromDraggedMedia({
    id: 'm1',
    sourcePath: '/media/m1.mov',
    name: 'Shot',
    frameCount: 100,
    hasAudio: true,
  })!;

  it('drops the picture on the video track and its audio on a NEW audio track', () => {
    const before: Timeline = { id: 't', name: 't', tracks: [{ kind: 'video', clips: [] }] };
    const p = pair();
    const after = applyOp(before, { kind: 'add_clip', track: 0, clip: p.video, linkedAudio: p.audio! });
    expect(after.tracks).toHaveLength(2);
    expect(after.tracks[1].kind).toBe('audio');
    expect(after.tracks[0].clips[0].start_frame).toBe(0);
    expect(after.tracks[1].clips[0].start_frame).toBe(0);
    expect(after.tracks[1].clips[0].link_group).toBe(after.tracks[0].clips[0].link_group);
  });

  it('reuses an existing audio track that has room rather than adding another', () => {
    const before: Timeline = {
      id: 't',
      name: 't',
      tracks: [
        { kind: 'video', clips: [clip('x', 'X', { start_frame: 0, duration: 50 })] },
        { kind: 'audio', clips: [clip('xa', 'X', { start_frame: 0, duration: 50 })] },
      ],
    };
    const p = pair();
    const after = applyOp(before, {
      kind: 'add_clip',
      track: 0,
      clip: p.video,
      startFrame: 50,
      linkedAudio: p.audio!,
    });
    expect(after.tracks).toHaveLength(2);
    expect(after.tracks[1].clips).toHaveLength(2);
    expect(after.tracks[1].clips.find((c) => c.id === p.audio!.id)?.start_frame).toBe(50);
  });

  it('is ONE atomic op — a ripple insert makes room on both tracks and lands the pair together', () => {
    const before: Timeline = {
      id: 't',
      name: 't',
      tracks: [
        { kind: 'video', clips: [clip('x', 'X', { duration: 50 }), clip('y', 'Y', { start_frame: 50, duration: 50 })] },
        { kind: 'audio', clips: [clip('xa', 'X', { duration: 50 }), clip('ya', 'Y', { start_frame: 50, duration: 50 })] },
      ],
    };
    const p = pair(); // 100 frames long
    const after = applyOp(before, {
      kind: 'add_clip',
      track: 0,
      clip: p.video,
      startFrame: 50,
      ripple: true,
      linkedAudio: p.audio!,
    });
    expect(after.tracks).toHaveLength(2); // no extra audio track needed
    expect(startOf(after, 0, 'y')).toBe(150); // video rippled by the pair's 100
    expect(startOf(after, 1, 'ya')).toBe(150); // sync-locked audio track too
    expect(startOf(after, 0, p.video.id)).toBe(50);
    expect(startOf(after, 1, p.audio!.id)).toBe(50);
  });

  it('without linkedAudio, behaves exactly as it did before D-129', () => {
    const before: Timeline = { id: 't', name: 't', tracks: [{ kind: 'video', clips: [] }] };
    const after = applyOp(before, { kind: 'add_clip', track: 0, clip: clipFromDraggedMedia({
      id: 'm2', sourcePath: '/m2.mov', name: 'Silent', frameCount: 40,
    })! });
    expect(after.tracks).toHaveLength(1);
    expect(after.tracks[0].clips[0].link_group).toBeNull();
  });
});

describe('link-aware edit ops (D-129)', () => {
  it('move drags the linked half along, from either side', () => {
    const fromVideo = applyOp(linkedPair(), { kind: 'move', fromTrack: 0, toTrack: 0, clip: 0, startFrame: 300 });
    expect(startOf(fromVideo, 0, 'v')).toBe(300);
    expect(startOf(fromVideo, 1, 'a')).toBe(300);

    const fromAudio = applyOp(linkedPair(), { kind: 'move', fromTrack: 1, toTrack: 1, clip: 0, startFrame: 250 });
    expect(startOf(fromAudio, 1, 'a')).toBe(250);
    expect(startOf(fromAudio, 0, 'v')).toBe(250);
  });

  it('rejects the whole move when the linked half has nowhere to land', () => {
    const t = linkedPair();
    t.tracks[1].clips.push(clip('blocker', 'Blocker', { start_frame: 300 }));
    const after = applyOp(t, { kind: 'move', fromTrack: 0, toTrack: 0, clip: 0, startFrame: 300 });
    expect(after).toBe(t); // exact same ref — a real no-op, nothing half-applied
  });

  it('ripples both tracks so a linked pair can be dropped between two touching clips', () => {
    const t = linkedPair();
    t.tracks[0].clips[0].start_frame = 1000;
    t.tracks[1].clips[0].start_frame = 1000;
    t.tracks[0].clips.push(clip('X', 'X', { duration: 50 }), clip('Y', 'Y', { start_frame: 50, duration: 50 }));
    t.tracks[1].clips.push(clip('x', 'x', { duration: 50 }), clip('y', 'y', { start_frame: 50, duration: 50 }));
    const after = applyOp(t, { kind: 'move', fromTrack: 0, toTrack: 0, clip: 0, startFrame: 50, ripple: true });
    expect(startOf(after, 0, 'v')).toBe(50);
    expect(startOf(after, 1, 'a')).toBe(50);
    expect(startOf(after, 0, 'Y')).toBe(150);
    expect(startOf(after, 1, 'y')).toBe(150);
    expect(startOf(after, 0, 'X')).toBe(0);
  });

  it('refuses a move when the linked half sits on a locked track', () => {
    const t = linkedPair();
    t.tracks[1].locked = true;
    expect(applyOp(t, { kind: 'move', fromTrack: 0, toTrack: 0, clip: 0, startFrame: 300 })).toBe(t);
  });

  it('trims both halves in lockstep, from either side', () => {
    const head = applyOp(linkedPair(), { kind: 'trim_start', track: 0, clip: 0, delta: 20 });
    for (const [ti, id] of [[0, 'v'], [1, 'a']] as const) {
      const c = head.tracks[ti].clips.find((x) => x.id === id)!;
      expect([c.source_start, c.start_frame, c.duration]).toEqual([20, 20, 80]);
    }
    const tail = applyOp(linkedPair(), { kind: 'trim_end', track: 1, clip: 0, delta: -30 });
    expect(tail.tracks[0].clips[0].duration).toBe(70);
    expect(tail.tracks[1].clips[0].duration).toBe(70);
  });

  it('rejects a trim that would clamp differently on the two halves', () => {
    const t = linkedPair();
    t.tracks[0].clips[0].source_len = 10000;
    t.tracks[1].clips[0].source_len = 10000;
    t.tracks[1].clips.push(clip('neighbour', 'N', { start_frame: 120, duration: 50 }));
    expect(applyOp(t, { kind: 'trim_end', track: 0, clip: 0, delta: 200 })).toBe(t);
  });

  it('splits both halves at the same frame, leaving two intact pairs', () => {
    const after = applyOp(linkedPair(), { kind: 'split', track: 0, clip: 0, atFrame: 40 });
    expect(after.tracks[0].clips).toHaveLength(2);
    expect(after.tracks[1].clips).toHaveLength(2);
    expect(after.tracks[0].clips.map((c) => [c.start_frame, c.duration])).toEqual([[0, 40], [40, 60]]);
    expect(after.tracks[1].clips.map((c) => [c.start_frame, c.duration])).toEqual([[0, 40], [40, 60]]);
    expect(after.tracks[0].clips[0].link_group).toBe('g1');
    expect(after.tracks[1].clips[0].link_group).toBe('g1');
    expect(after.tracks[0].clips[1].link_group).toBe('g1·40');
    expect(after.tracks[1].clips[1].link_group).toBe('g1·40');
  });

  it('rejects a split whose frame is not inside every member (an already-slipped L-cut)', () => {
    const t = linkedPair();
    t.tracks[1].clips[0].start_frame = 60;
    expect(applyOp(t, { kind: 'split', track: 0, clip: 0, atFrame: 40 })).toBe(t);
  });

  it('deletes every member of the group, and prunes each track it empties', () => {
    const kept = linkedPair();
    kept.tracks[0].clips.push(clip('keepV', 'K', { start_frame: 500, duration: 10 }));
    kept.tracks[1].clips.push(clip('keepA', 'K', { start_frame: 500, duration: 10 }));
    const after = applyOp(kept, { kind: 'remove', track: 0, clip: 0 });
    expect(after.tracks[0].clips.map((c) => c.id)).toEqual(['keepV']);
    expect(after.tracks[1].clips.map((c) => c.id)).toEqual(['keepA']);

    // both tracks emptied by the one delete → both auto-decommission
    expect(applyOp(linkedPair(), { kind: 'remove', track: 1, clip: 0 }).tracks).toHaveLength(0);
  });

  it('refuses a delete when a linked half is on a locked track', () => {
    const t = linkedPair();
    t.tracks[1].locked = true;
    expect(applyOp(t, { kind: 'remove', track: 0, clip: 0 })).toBe(t);
  });

  it('leaves every op on an UNLINKED clip byte-for-byte as it was (backward compat)', () => {
    const plain = tl(backToBack());
    expect(applyOp(plain, { kind: 'move', fromTrack: 0, toTrack: 0, clip: 0, startFrame: 500 })
      .tracks[0].clips.find((c) => c.id === 'a')!.start_frame).toBe(500);
    expect(applyOp(plain, { kind: 'trim_start', track: 0, clip: 0, delta: 20 })
      .tracks[0].clips[0]).toMatchObject({ source_start: 20, start_frame: 20, duration: 80 });
    expect(applyOp(plain, { kind: 'trim_end', track: 0, clip: 0, delta: -30 }).tracks[0].clips[0].duration).toBe(70);
    expect(applyOp(plain, { kind: 'split', track: 0, clip: 0, atFrame: 40 }).tracks[0].clips).toHaveLength(3);
    expect(applyOp(plain, { kind: 'remove', track: 0, clip: 0 }).tracks[0].clips.map((c) => c.id)).toEqual(['b']);
  });
});

describe('unlink (D-129)', () => {
  it('dissolves the COMPLETE group, not just the named clip', () => {
    const after = applyOp(linkedPair(), { kind: 'unlink', track: 0, clip: 0 });
    expect(after.tracks[0].clips[0].link_group).toBeNull();
    expect(after.tracks[1].clips[0].link_group).toBeNull();
  });

  it('is the L-cut escape hatch — after it, each half moves on its own', () => {
    const unlinked = applyOp(linkedPair(), { kind: 'unlink', track: 0, clip: 0 });
    const moved = applyOp(unlinked, { kind: 'move', fromTrack: 0, toTrack: 0, clip: 0, startFrame: 400 });
    expect(startOf(moved, 0, 'v')).toBe(400);
    expect(startOf(moved, 1, 'a')).toBe(0);
  });

  it('is a no-op on an already-unlinked clip, and on a locked track', () => {
    const plain = tl(backToBack());
    expect(applyOp(plain, { kind: 'unlink', track: 0, clip: 0 })).toBe(plain);
    const locked = linkedPair();
    locked.tracks[0].locked = true;
    expect(applyOp(locked, { kind: 'unlink', track: 0, clip: 0 })).toBe(locked);
  });

  it('labels itself in the history', () => {
    expect(labelForOp({ kind: 'unlink', track: 0, clip: 0 }, linkedPair())).toBe('Unlink "Shot"');
  });
});

describe('linkedClipIds (D-129)', () => {
  it('returns the other half of the selection’s link group, never the selection itself', () => {
    const t = linkedPair();
    expect([...linkedClipIds(t, [{ track: 0, id: 'v' }])]).toEqual(['a']);
    expect([...linkedClipIds(t, [{ track: 1, id: 'a' }])]).toEqual(['v']);
  });

  it('is empty for an unlinked selection', () => {
    expect(linkedClipIds(tl(backToBack()), [{ track: 0, id: 'a' }]).size).toBe(0);
  });
});

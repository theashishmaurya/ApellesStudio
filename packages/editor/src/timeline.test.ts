// @chroma/editor — unit tests for the pure edit-model helpers in
// `timeline.ts`: `labelForOp` (D-051) and, since D-058, the edit ops
// themselves — real inputs/outputs asserted against the same clamp/position
// rules `chroma-timeline::lib.rs`'s Rust ops use, per the D-058 fix (a
// frontend/backend model mismatch introduced by D-054 that nothing had
// re-verified until this pass — see D-058 in docs/08-decisions.md).
import { describe, expect, it } from 'vitest';
import {
  applyOp,
  clipFromDraggedMedia,
  computeInsertion,
  endFrame,
  labelForOp,
  nextAppendFrame,
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

  it('returns null for a genuinely mid-clip drop far from any edge', () => {
    const track: Track = { kind: 'video', clips: [clip('a', 'A', { start_frame: 0, duration: 100 })] };
    expect(computeInsertion(track, 50, 30, 10)).toBeNull();
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

  // D-096: a cross-track move is now ALLOWED to overlap another clip
  // already on the destination track — since D-088's real multi-layer
  // compositor, that's a normal composited-layer stack (the whole point of
  // V1/V2), not an error state. Only a SAME-track overlap is still rejected
  // (see the test above) — two clips can't occupy one track at once.
  it('allows a cross-track move to overlap a clip already on the destination track', () => {
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
    expect(after.tracks[0].clips).toHaveLength(0);
    expect(after.tracks[1].clips.map((c) => ({ id: c.id, start: c.start_frame }))).toEqual([
      { id: 'x', start: 50 },
      { id: 'a', start: 100 },
    ]);
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

describe('add_track / remove_track / set_track_gain (D-080)', () => {
  it('add_track appends an empty track of the requested kind with default gain', () => {
    const before = tl(backToBack());
    const after = applyOp(before, { kind: 'add_track', trackKind: 'audio' });
    expect(after.tracks).toHaveLength(2);
    expect(after.tracks[1]).toEqual({ kind: 'audio', clips: [], gain: 1.0 });
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

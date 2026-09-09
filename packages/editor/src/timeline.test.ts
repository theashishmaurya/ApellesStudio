// @apelles/editor — unit tests for the pure edit-model helpers in
// `timeline.ts`: `labelForOp` (D-051) and, since D-058, the edit ops
// themselves — real inputs/outputs asserted against the same clamp/position
// rules `apelles-timeline::lib.rs`'s Rust ops use, per the D-058 fix (a
// frontend/backend model mismatch introduced by D-054 that nothing had
// re-verified until this pass — see D-058 in docs/08-decisions.md).
import { describe, expect, it } from 'vitest';
import {
  applyOp,
  audioTrackWithRoom,
  defaultEqBands,
  eqBandsForDisplay,
  eqResponseDb,
  EQ_BAND_COUNT,
  EQ_MAX_FREQ_HZ,
  EQ_MAX_GAIN_DB,
  EQ_MIN_Q,
  hasActiveEq,
  isEqBandActive,
  checkLink,
  clipAt,
  clipFromDraggedMedia,
  computeInsertion,
  DEFAULT_MARKER_COLOR,
  endFrame,
  ensureAudioTrackWithRoom,
  EASE_PRESETS,
  easePresetName,
  findClip,
  gapAt,
  labelForOp,
  linkedClipIds,
  linkedClipsFromDraggedMedia,
  MARKER_COLORS,
  markersOf,
  newMarker,
  nextAppendFrame,
  resolveClipLanding,
  resolveMarkerColor,
  syncLinkedClipIds,
  syncLinkedClipIdsAtPosition,
  timelineDuration,
  trackDuration,
  trackIndexAfterMove,
  checkTransition,
  cutFrames,
  newTransition,
  transitionHandles,
  transitionWindow,
  transitionsOf,
  type Clip,
  type EqBand,
  type Marker,
  type Timeline,
  type Track,
  type Transition,
} from './timeline';
import { eqFilterChain } from './timelineExportAudio';

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

  it('names the clip for slip (D-195)', () => {
    expect(labelForOp({ kind: 'slip', track: 0, clip: 1, delta: 5 }, before)).toBe('Slip "B-roll 1"');
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
        { kind: 'set_clip_transform', track: 0, clip: 0, opacity: 1, position_x: 0, position_y: 0, scale: 1, rotation: 0, ...NO_CROP, ...NO_BOX_OVERRIDE },
        before,
      ),
    ).toBe('Adjust "Intro"');
    expect(labelForOp({ kind: 'set_clip_keyframes', track: 0, clip: 0, keyframes: [] }, before)).toBe(
      'Keyframe "Intro"',
    );
  });
});

// D-058 — every op below mirrors `apelles-timeline::lib.rs`'s Rust op of the
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
    expect(endFrame(added, 24)).toBe(250);
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
    expect(nextAppendFrame(track, 24)).toBe(200);
  });
});

// D-095 — computeInsertion + add_clip's ripple-insert path (`startFrame`/
// `ripple`). Real drop-position math, not the plain-append default above —
// this is what fixes the live-reported "hovering a new clip between two
// existing ones doesn't snap/insert" gap (B-026).
describe('computeInsertion (D-095)', () => {
  it('snaps to the boundary between two touching clips and reports a ripple', () => {
    const track: Track = { kind: 'video', clips: backToBack() }; // a:[0,100) b:[100,200)
    const insertion = computeInsertion(track, 97, { duration: 30 }, 10, 24); // dropped near frame 100, snap radius 10
    expect(insertion).toEqual({ startFrame: 100, ripple: true });
  });

  it('snaps to a clip edge but reports no ripple when the gap after it is big enough', () => {
    // a:[0,100) then open space — a 30-frame clip dropped right at a's end
    // fits with no need to move anything else.
    const track: Track = { kind: 'video', clips: [clip('a', 'A', { start_frame: 0 })] };
    const insertion = computeInsertion(track, 100, { duration: 30 }, 10, 24);
    expect(insertion).toEqual({ startFrame: 100, ripple: false });
  });

  it('places a clip directly in an open gap with no snap and no ripple', () => {
    // a:[0,100) then a big gap, b:[500,600) — dropping at 250 (far from
    // either edge) with a 30-frame clip fits cleanly.
    const track: Track = { kind: 'video', clips: [clip('a', 'A', { start_frame: 0 }), clip('b', 'B', { start_frame: 500 })] };
    expect(computeInsertion(track, 250, { duration: 30 }, 10, 24)).toEqual({ startFrame: 250, ripple: false });
  });

  it('snaps to 0 and ripples everything when dropped before the first clip', () => {
    const track: Track = { kind: 'video', clips: backToBack() };
    expect(computeInsertion(track, 3, { duration: 20 }, 10, 24)).toEqual({ startFrame: 0, ripple: true });
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
    expect(computeInsertion(track, 20, { duration: 30 }, 10, 24)).toEqual({ startFrame: 0, ripple: true });
  });

  it('resolves a mid-clip drop to the covering clip\'s nearer edge — second half inserts after it', () => {
    const track: Track = { kind: 'video', clips: [clip('a', 'A', { start_frame: 0, duration: 100 })] };
    // frame 80 is in A's second half — insert right after A; nothing else
    // on the track, so this is a clean append, no ripple needed.
    expect(computeInsertion(track, 80, { duration: 30 }, 10, 24)).toEqual({ startFrame: 100, ripple: false });
  });

  it('the whole-clip-body fallback covers the entire span of two touching clips, not just their shared seam', () => {
    // a:[0,100) b:[100,200), zero gap — the actual live-reported scenario:
    // dropping ANYWHERE on either clip's body (not just within snapFrames
    // of the exact 100-frame seam) must resolve to a real ripple insert.
    const track: Track = { kind: 'video', clips: backToBack() };
    // deep inside A (first half) -> insert before A, ripple both A and B forward.
    expect(computeInsertion(track, 20, { duration: 15 }, 10, 24)).toEqual({ startFrame: 0, ripple: true });
    // deep inside A (second half) -> insert after A / before B, ripple B forward.
    expect(computeInsertion(track, 80, { duration: 15 }, 10, 24)).toEqual({ startFrame: 100, ripple: true });
    // deep inside B (second half, far from the track's own open end) -> insert after B.
    expect(computeInsertion(track, 180, { duration: 15 }, 10, 24)).toEqual({ startFrame: 200, ripple: false });
  });

  it('still returns null for a drop in a genuinely empty region with no covering clip and no fitting gap', () => {
    // a:[0,50) then a real but too-small gap, b:[60,160) — frame 55 is in
    // the gap (not covering any clip) but a 30-frame clip there would
    // overlap b — genuinely ambiguous, out of this function's scope.
    const track: Track = { kind: 'video', clips: [clip('a', 'A', { start_frame: 0, duration: 50 }), clip('b', 'B', { start_frame: 60, duration: 100 })] };
    expect(computeInsertion(track, 55, { duration: 30 }, 3, 24)).toBeNull();
  });

  it('always fits with no ripple on an empty track', () => {
    expect(computeInsertion({ kind: 'video', clips: [] }, 42, { duration: 30 }, 10, 24)).toEqual({ startFrame: 42, ripple: false });
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
    expect(endFrame(c, 24)).toBe(130);
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
    expect(endFrame(b, 24)).toBe(200); // end unchanged — this is the actual fix
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
    expect(endFrame(a, 24)).toBe(100); // clamped right at b's start, not overlapping
  });

  it('can grow freely past where a removed/gapped neighbor used to be', () => {
    const before = tl([clip('a', 'A', { start_frame: 0, duration: 50, source_len: 500 })]);
    const after = applyOp(before, { kind: 'trim_end', track: 0, clip: 0, delta: 200 });
    expect(after.tracks[0].clips[0].duration).toBe(250);
  });
});

describe('slip (D-195)', () => {
  it('moves source_start only — start_frame and duration are both untouched', () => {
    const before = tl([clip('a', 'A', { start_frame: 10, source_start: 20, duration: 50, source_len: 100 })]);
    const after = applyOp(before, { kind: 'slip', track: 0, clip: 0, delta: 10 });
    const a = after.tracks[0].clips[0];
    expect(a.start_frame).toBe(10); // unchanged — the whole point of a slip
    expect(a.duration).toBe(50); // unchanged too
    expect(a.source_start).toBe(30); // moved by delta
  });

  it('slips backward (negative delta) into earlier source material', () => {
    const before = tl([clip('a', 'A', { start_frame: 10, source_start: 20, duration: 50, source_len: 100 })]);
    const after = applyOp(before, { kind: 'slip', track: 0, clip: 0, delta: -15 });
    expect(after.tracks[0].clips[0].source_start).toBe(5);
  });

  it('clamps at the source\'s tail — source_start+duration can never exceed source_len', () => {
    // window [50,70) of a 100-frame source, 30 frames of room to the end —
    // asking to slip forward by 100 must stop exactly at the source's tail.
    const before = tl([clip('a', 'A', { start_frame: 0, source_start: 50, duration: 20, source_len: 100 })]);
    const after = applyOp(before, { kind: 'slip', track: 0, clip: 0, delta: 100 });
    const a = after.tracks[0].clips[0];
    expect(a.source_start).toBe(80); // 100 - duration(20), the last legal position
    expect(a.duration).toBe(20); // still untouched
  });

  it('clamps at the source\'s head — source_start can never go below 0', () => {
    const before = tl([clip('a', 'A', { start_frame: 0, source_start: 10, duration: 50, source_len: 100 })]);
    const after = applyOp(before, { kind: 'slip', track: 0, clip: 0, delta: -100 });
    expect(after.tracks[0].clips[0].source_start).toBe(0);
  });

  it('is a real no-op (same reference) once already pinned at the bound it was asked to move past', () => {
    // Already sitting at the last legal source_start for its own duration —
    // asking to slip further forward has nowhere left to go.
    const before = tl([clip('a', 'A', { start_frame: 0, source_start: 80, duration: 20, source_len: 100 })]);
    expect(applyOp(before, { kind: 'slip', track: 0, clip: 0, delta: 10 })).toBe(before);
  });

  it('is a no-op (same reference) when the clip index is out of range', () => {
    const before = tl(backToBack());
    expect(applyOp(before, { kind: 'slip', track: 0, clip: 99, delta: 5 })).toBe(before);
  });

  it('is refused on a locked track', () => {
    const before: Timeline = {
      id: 't1',
      name: 'Timeline',
      tracks: [{ kind: 'video', clips: backToBack(), locked: true }],
    };
    expect(applyOp(before, { kind: 'slip', track: 0, clip: 0, delta: 5 })).toBe(before);
  });

  it('mirrors clampedTrimStartDelta\'s source-frame conversion for a mixed native-fps clip', () => {
    // 48fps source on a 24fps timeline: 10 TIMELINE frames of slip must
    // consume 20 SOURCE frames (10 * 48/24), same ratio B-077 pins for trim.
    const before = tl([
      clip('fast', 'Fast (48fps)', {
        start_frame: 0,
        source_start: 40,
        duration: 40,
        source_len: 200,
        source_fps: 48,
      }),
    ]);
    const after = applyOp(before, { kind: 'slip', track: 0, clip: 0, delta: 10 });
    const c = after.tracks[0].clips[0];
    expect(c.source_start).toBe(60); // 40 + 20 source frames
    expect(c.start_frame).toBe(0);
    expect(c.duration).toBe(40);
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
    expect(endFrame(left, 24)).toBe(right.start_frame);
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
    expect(gapAt(t, 120, 24)).toEqual({ gapStart: 100, gapEnd: 150 });
  });

  it('returns null for a frame inside a clip', () => {
    const t: Track = { kind: 'video', clips: backToBack() };
    expect(gapAt(t, 50, 24)).toBeNull();
  });

  it('returns null for trailing empty space past the last clip — nothing after it to ripple', () => {
    const t: Track = { kind: 'video', clips: backToBack() }; // ends at 200
    expect(gapAt(t, 500, 24)).toBeNull();
  });

  it('finds a gap before the very first clip', () => {
    const t: Track = { kind: 'video', clips: [clip('a', 'A', { start_frame: 200 })] };
    expect(gapAt(t, 10, 24)).toEqual({ gapStart: 0, gapEnd: 200 });
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
    expect(resolveClipLanding(dest, 'm', { duration: 50 }, 500, SNAP, 24)).toEqual({ startFrame: 500, ripple: false });
  });

  it('excludes the clip\'s own current slot on the destination track — a same-track no-op drop stays put', () => {
    const dest: Track = { kind: 'video', clips: backToBack() }; // a:[0,100) b:[100,200)
    // "b" dropped back onto its own current position must not collide with itself
    expect(resolveClipLanding(dest, 'b', { duration: 100 }, 100, SNAP, 24)).toEqual({ startFrame: 100, ripple: false });
  });

  it('landing directly on top of another clip snaps to the nearest open edge instead', () => {
    const dest: Track = { kind: 'video', clips: [clip('x', 'Existing', { start_frame: 100, duration: 100 })] }; // [100,200)
    // dropped right in the middle of x's span, closer to its start than its end
    expect(resolveClipLanding(dest, 'm', { duration: 50 }, 130, SNAP, 24)).toEqual({ startFrame: 100, ripple: true });
    // dropped closer to x's end
    expect(resolveClipLanding(dest, 'm', { duration: 50 }, 180, SNAP, 24)).toEqual({ startFrame: 200, ripple: false });
  });

  it('drops right on the seam between two touching clips ripple-insert there, not overlap', () => {
    const dest: Track = { kind: 'video', clips: backToBack() }; // a:[0,100) b:[100,200), zero gap between them
    // a 30-frame clip dropped exactly on the seam snaps to it, but the seam
    // has zero width — b starts exactly where a ends — so fitting the new
    // clip there necessarily means shifting b later, not landing in an
    // already-open spot.
    expect(resolveClipLanding(dest, 'm', { duration: 30 }, 100, SNAP, 24)).toEqual({ startFrame: 100, ripple: true });
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
    expect(computeInsertion(dest, 120, { duration: 50 }, SNAP, 24)).toBeNull(); // confirms the premise, not just the wrapper's fallback
    expect(resolveClipLanding(dest, 'm', { duration: 50 }, 120, SNAP, 24)).toEqual({ startFrame: 250, ripple: false });
  });

  it('an empty destination track always lands exactly at the intended frame', () => {
    const dest: Track = { kind: 'video', clips: [] };
    expect(resolveClipLanding(dest, 'm', { duration: 50 }, 42, SNAP, 24)).toEqual({ startFrame: 42, ripple: false });
  });

  it('clamps a negative intended frame to 0', () => {
    const dest: Track = { kind: 'video', clips: [] };
    expect(resolveClipLanding(dest, 'm', { duration: 50 }, -20, SNAP, 24)).toEqual({ startFrame: 0, ripple: false });
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

describe('set_track_duck (D-149)', () => {
  const duckOp = {
    kind: 'set_track_duck' as const,
    track: 0,
    duckFrom: 1,
    duckDb: -12,
    duckAttackMs: 10,
    duckReleaseMs: 300,
  };

  it('writes all four ducking fields', () => {
    const after = applyOp(tl(backToBack()), duckOp);
    expect(after.tracks[0].duck_from).toBe(1);
    expect(after.tracks[0].duck_db).toBe(-12);
    expect(after.tracks[0].duck_attack_ms).toBe(10);
    expect(after.tracks[0].duck_release_ms).toBe(300);
  });

  it('duckFrom: null turns ducking off without disturbing the numbers', () => {
    const on = applyOp(tl(backToBack()), duckOp);
    const off = applyOp(on, { ...duckOp, duckFrom: null });
    expect(off.tracks[0].duck_from).toBeNull();
    expect(off.tracks[0].duck_db).toBe(-12);
    expect(off.tracks[0].duck_attack_ms).toBe(10);
  });

  it('normalises NaN (a cleared numeric input) rather than storing it', () => {
    const after = applyOp(tl(backToBack()), {
      ...duckOp,
      duckDb: Number.NaN,
      duckAttackMs: Number.NaN,
      duckReleaseMs: Number.NaN,
    });
    expect(after.tracks[0].duck_db).toBe(0);
    expect(after.tracks[0].duck_attack_ms).toBe(10);
    expect(after.tracks[0].duck_release_ms).toBe(300);
  });

  it('floors the time constants at 0 but does NOT clamp the dB (a boost is legal)', () => {
    const after = applyOp(tl(backToBack()), {
      ...duckOp,
      duckDb: 3,
      duckAttackMs: -50,
      duckReleaseMs: -1,
    });
    expect(after.tracks[0].duck_db).toBe(3);
    expect(after.tracks[0].duck_attack_ms).toBe(0);
    expect(after.tracks[0].duck_release_ms).toBe(0);
  });

  it('is a no-op for an out-of-range index', () => {
    const before = tl(backToBack());
    expect(applyOp(before, { ...duckOp, track: 9 })).toBe(before);
  });

  it('is NOT gated by the track lock — a mix setting, not a clip edit', () => {
    const locked = applyOp(tl(backToBack()), {
      kind: 'set_track_locked',
      track: 0,
      locked: true,
    });
    expect(applyOp(locked, duckOp).tracks[0].duck_from).toBe(1);
  });

  it('labels the op for the undo stack', () => {
    const before = tl(backToBack());
    expect(labelForOp(duckOp, before)).toBe('Duck track 1 from track 2');
    expect(labelForOp({ ...duckOp, duckFrom: null }, before)).toBe('Stop ducking track 1');
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

  // D-214 — roadmap item 24(e): a newly `add_track`ed track always lands at
  // the highest index (bottom of the z-order stack), so getting it ABOVE
  // existing footage needs a real `move_track` afterward. This is the
  // reindexing-correctness coverage the fix promised: inserting a track
  // above one that already has real content (keyframes, a fade, a non-zero
  // `start_frame`) must move that content's Z-ORDER only — not touch a
  // single field of it, and not off-by-one it onto the wrong track.
  it('inserting a new track above an existing one (add_track + move_track) leaves that track\'s clip data byte-for-byte unchanged, only its index shifts', () => {
    const existingClip = clip('footage', 'Footage', {
      start_frame: 24,
      duration: 150,
      chroma_keyframes: [
        { frame: 0, params: { opacity: 0, scale: 1 } },
        { frame: 30, params: { opacity: 1, scale: 1.2 } },
      ],
      fade_in_frames: 12,
      fade_out_frames: 8,
      link_group: 'g1',
    });
    const before: Timeline = {
      id: 't1',
      name: 'Timeline',
      tracks: [{ kind: 'video', clips: [existingClip], gain: 1 }],
    };

    // Exactly the sequence `editor_add_track` + `editor_move_track` (and the
    // GUI's own drag-to-create-track path) run: append, then move the new
    // (now highest-index) track down to 0.
    const appended = applyOp(before, { kind: 'add_track', trackKind: 'video' });
    expect(appended.tracks).toHaveLength(2);
    const after = applyOp(appended, { kind: 'move_track', from: 1, to: 0 });

    // The new empty track is now on top (index 0); the original content is
    // pushed down to index 1 — z-order shifted, nothing else.
    expect(after.tracks[0].clips).toEqual([]);
    expect(after.tracks[1].clips).toEqual([existingClip]);
    // Explicit field-by-field sanity beyond the structural `toEqual` above —
    // the exact fields a data-corruption bug would most plausibly clobber.
    const moved = after.tracks[1].clips[0];
    expect(moved.start_frame).toBe(24);
    expect(moved.duration).toBe(150);
    expect(moved.chroma_keyframes).toEqual(existingClip.chroma_keyframes);
    expect(moved.fade_in_frames).toBe(12);
    expect(moved.fade_out_frames).toBe(8);
    expect(moved.link_group).toBe('g1');
  });

  describe('trackIndexAfterMove (D-094, promoted D-214)', () => {
    it('the moved track itself lands exactly at `to`', () => {
      expect(trackIndexAfterMove(2, 2, 0)).toBe(0);
      expect(trackIndexAfterMove(0, 0, 3)).toBe(3);
    });

    it('moving a track UP (from > to) shifts everything in [to, from) down by one', () => {
      // splice(2,1) then insert(0,_): old 0,1 -> new 1,2; old 2 (moved) -> 0.
      expect(trackIndexAfterMove(0, 2, 0)).toBe(1);
      expect(trackIndexAfterMove(1, 2, 0)).toBe(2);
      // Outside the [to, from) span — untouched.
      expect(trackIndexAfterMove(3, 2, 0)).toBe(3);
    });

    it('moving a track DOWN (from < to) shifts everything in (from, to] up by one', () => {
      // splice(0,1) then insert(2,_): old 1,2 -> new 0,1; old 0 (moved) -> 2.
      expect(trackIndexAfterMove(1, 0, 2)).toBe(0);
      expect(trackIndexAfterMove(2, 0, 2)).toBe(1);
      // Before the span — untouched.
      expect(trackIndexAfterMove(0, 1, 3)).toBe(0);
    });

    it('from === to is a real no-op for every index', () => {
      expect(trackIndexAfterMove(0, 1, 1)).toBe(0);
      expect(trackIndexAfterMove(1, 1, 1)).toBe(1);
      expect(trackIndexAfterMove(5, 1, 1)).toBe(5);
    });
  });
});

/** D-132 — the four crop insets the `set_clip_transform` op now requires,
 *  at their "uncropped" values. Spelled once here so a test that is about
 *  something else (a label, a lock refusal) doesn't have to restate them. */
const NO_CROP = { crop_left: 0, crop_top: 0, crop_right: 0, crop_bottom: 0 } as const;

/** D-193 — the two independent-axis box-size overrides `set_clip_transform`
 *  now also requires, at "no override" (`null`, see the op's own doc for
 *  why `null` and not omission). Same one-liner convenience `NO_CROP` gives. */
const NO_BOX_OVERRIDE = { box_width: null, box_height: null } as const;

describe('set_clip_transform / set_clip_keyframes (D-088/D-089/D-132)', () => {
  it('set_clip_transform writes all eleven transform fields together (D-088/D-132/D-193)', () => {
    const before = tl(backToBack());
    const after = applyOp(before, {
      kind: 'set_clip_transform',
      track: 0,
      clip: 0,
      opacity: 0.5,
      position_x: 10,
      position_y: -20,
      scale: 1.5,
      box_width: 0.6,
      box_height: 0.25,
      rotation: 90,
      crop_left: 0.1,
      crop_top: 0.2,
      crop_right: 0.3,
      crop_bottom: 0.4,
    });
    const c = after.tracks[0].clips[0];
    expect(c.opacity).toBe(0.5);
    expect(c.position_x).toBe(10);
    expect(c.position_y).toBe(-20);
    expect(c.scale).toBe(1.5);
    expect(c.box_width).toBe(0.6);
    expect(c.box_height).toBe(0.25);
    expect(c.rotation).toBe(90);
    expect(c.crop_left).toBe(0.1);
    expect(c.crop_top).toBe(0.2);
    expect(c.crop_right).toBe(0.3);
    expect(c.crop_bottom).toBe(0.4);
  });

  /** D-193 — an explicit `null` on either axis clears a previously-set
   *  override back to "derive from `scale`", and does so independently per
   *  axis (setting `box_width` doesn't force `box_height` to also change). */
  it('set_clip_transform clears a box-size override with an explicit null, independently per axis', () => {
    const before = tl(backToBack());
    const withOverride = applyOp(before, {
      kind: 'set_clip_transform',
      track: 0,
      clip: 0,
      opacity: 1,
      position_x: 0,
      position_y: 0,
      scale: 1,
      box_width: 0.6,
      box_height: 0.25,
      rotation: 0,
      ...NO_CROP,
    });
    const cleared = applyOp(withOverride, {
      kind: 'set_clip_transform',
      track: 0,
      clip: 0,
      opacity: 1,
      position_x: 0,
      position_y: 0,
      scale: 1,
      box_width: null,
      box_height: 0.25,
      rotation: 0,
      ...NO_CROP,
    });
    expect(cleared.tracks[0].clips[0].box_width).toBeNull();
    expect(cleared.tracks[0].clips[0].box_height).toBe(0.25);
  });

  /** D-132 — the op clamps its crop insets into 0–1 on the way in (mirroring
   *  the Rust compositor's own `crop_pixel_rect` clamp), so an out-of-range
   *  value can never reach `project.json` from this UI. A cleared numeric
   *  input arrives as `NaN`; that has to land on "no crop", not propagate. */
  it('set_clip_transform clamps crop insets into 0-1 and turns NaN into no crop', () => {
    const before = tl(backToBack());
    const after = applyOp(before, {
      kind: 'set_clip_transform',
      track: 0,
      clip: 0,
      opacity: 1,
      position_x: 0,
      position_y: 0,
      scale: 1,
      ...NO_BOX_OVERRIDE,
      rotation: 0,
      crop_left: -0.5,
      crop_top: 4,
      crop_right: Number.NaN,
      crop_bottom: 0.25,
    });
    const c = after.tracks[0].clips[0];
    expect(c.crop_left).toBe(0);
    expect(c.crop_top).toBe(1);
    expect(c.crop_right).toBe(0);
    expect(c.crop_bottom).toBe(0.25);
  });

  /** D-132 — a clip built before crop existed has none of the four keys;
   *  writing a transform must leave it with real zeros rather than
   *  `undefined`s, so what this file computes and what the Rust
   *  `#[serde(default)]` produces agree (this file is what actually lands on
   *  disk — see the module doc's verbatim-storage note). */
  it('set_clip_transform fills in crop on a pre-D-132 clip that has none', () => {
    const before = tl(backToBack());
    expect(before.tracks[0].clips[0].crop_left).toBeUndefined();
    const after = applyOp(before, {
      kind: 'set_clip_transform',
      track: 0,
      clip: 0,
      opacity: 1,
      position_x: 0,
      position_y: 0,
      scale: 1,
      ...NO_BOX_OVERRIDE,
      rotation: 0,
      ...NO_CROP,
    });
    const c = after.tracks[0].clips[0];
    expect([c.crop_left, c.crop_top, c.crop_right, c.crop_bottom]).toEqual([0, 0, 0, 0]);
  });

  it('set_clip_transform is a no-op for an out-of-range clip', () => {
    const before = tl(backToBack());
    expect(
      applyOp(before, {
        kind: 'set_clip_transform',
        track: 0,
        clip: 99,
        opacity: 1,
        position_x: 0,
        position_y: 0,
        scale: 1,
        ...NO_BOX_OVERRIDE,
        rotation: 0,
        ...NO_CROP,
      }),
    ).toBe(before);
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

describe('set_clip_fade (D-147)', () => {
  it('writes both durations and both curves together', () => {
    const before = tl(backToBack());
    const after = applyOp(before, {
      kind: 'set_clip_fade',
      track: 0,
      clip: 0,
      fade_in_frames: 12,
      fade_out_frames: 24,
      fade_in_curve: EASE_PRESETS[1].curve, // ease-in
      fade_out_curve: EASE_PRESETS[2].curve, // ease-out
    });
    const c = after.tracks[0].clips[0];
    expect(c.fade_in_frames).toBe(12);
    expect(c.fade_out_frames).toBe(24);
    expect(easePresetName(c.fade_in_curve)).toBe('ease-in');
    expect(easePresetName(c.fade_out_curve)).toBe('ease-out');
    // the OTHER clip is untouched
    expect(after.tracks[0].clips[1].fade_in_frames).toBeUndefined();
  });

  it('omitted curves default to linear, matching the Rust-side default', () => {
    const after = applyOp(tl(backToBack()), {
      kind: 'set_clip_fade',
      track: 0,
      clip: 0,
      fade_in_frames: 5,
      fade_out_frames: 0,
    });
    const c = after.tracks[0].clips[0];
    expect(easePresetName(c.fade_in_curve)).toBe('linear');
    expect(easePresetName(c.fade_out_curve)).toBe('linear');
  });

  /** Floored and integral on the way in, so a negative or fractional frame
   *  count can never reach `project.json` — the same discipline
   *  `set_clip_transform` applies to its crop insets. A cleared numeric input
   *  arrives as `NaN` and has to land on "no fade", not propagate. */
  it('floors durations to whole frames >= 0 and turns NaN into no fade', () => {
    const after = applyOp(tl(backToBack()), {
      kind: 'set_clip_fade',
      track: 0,
      clip: 0,
      fade_in_frames: -5,
      fade_out_frames: 7.9,
    });
    const c = after.tracks[0].clips[0];
    expect(c.fade_in_frames).toBe(0);
    expect(c.fade_out_frames).toBe(7);

    const nan = applyOp(tl(backToBack()), {
      kind: 'set_clip_fade',
      track: 0,
      clip: 0,
      fade_in_frames: Number.NaN,
      fade_out_frames: 3,
    });
    expect(nan.tracks[0].clips[0].fade_in_frames).toBe(0);
  });

  /** Deliberately NOT clamped to the clip's own `duration`: a fade longer
   *  than the clip is legitimate (the two windows overlap and their
   *  multipliers multiply — see `fade_gain`'s doc in `apelles-timeline`), and
   *  clamping would silently move a handle the user placed. */
  it('does not clamp a fade longer than the clip', () => {
    const after = applyOp(tl([clip('a', 'Short', { duration: 10 })]), {
      kind: 'set_clip_fade',
      track: 0,
      clip: 0,
      fade_in_frames: 40,
      fade_out_frames: 40,
    });
    expect(after.tracks[0].clips[0].fade_in_frames).toBe(40);
    expect(after.tracks[0].clips[0].fade_out_frames).toBe(40);
  });

  it('is a no-op for a track or clip that does not exist', () => {
    const before = tl(backToBack());
    const op = { fade_in_frames: 5, fade_out_frames: 5 } as const;
    expect(applyOp(before, { kind: 'set_clip_fade', track: 9, clip: 0, ...op })).toBe(before);
    expect(applyOp(before, { kind: 'set_clip_fade', track: 0, clip: 9, ...op })).toBe(before);
  });

  it('labels the history entry with the clip name', () => {
    const before = tl(backToBack());
    expect(
      labelForOp({ kind: 'set_clip_fade', track: 0, clip: 1, fade_in_frames: 5, fade_out_frames: 0 }, before),
    ).toBe('Fade "B-roll 1"');
  });
});

describe('easePresetName / EASE_PRESETS (D-147)', () => {
  it('every preset round-trips to its own name', () => {
    for (const p of EASE_PRESETS) expect(easePresetName(p.curve)).toBe(p.name);
  });

  it('an absent curve reads as linear, matching the server default', () => {
    expect(easePresetName(undefined)).toBe('linear');
  });

  /** A custom curve — which MCP can author today even though the Inspector
   *  has no curve editor — must report as custom rather than being silently
   *  misreported as `linear`. */
  it('a custom curve has no preset name', () => {
    expect(easePresetName({ x1: 0.1, y1: 0.9, x2: 0.9, y2: 0.1 })).toBeNull();
  });
});

describe('swap_media (D-195)', () => {
  /** A clip with a real transform/keyframes/fade/link set, so "everything
   *  else is preserved" has something non-default to actually check. */
  function richClip(overrides: Partial<Clip> = {}): Clip {
    return clip('a', 'A', {
      start_frame: 40,
      source_start: 10,
      duration: 50,
      source_len: 100,
      source_fps: 30,
      link_group: 'g1',
      opacity: 0.8,
      position_x: 0.25,
      position_y: 0.1,
      scale: 1.4,
      box_width: 0.5,
      box_height: null,
      rotation: 5,
      crop_left: 0.1,
      crop_top: 0,
      crop_right: 0,
      crop_bottom: 0.05,
      chroma_keyframes: [{ frame: 10, params: { scale: 1.5 } }],
      fade_in_frames: 8,
      fade_out_frames: 12,
      ...overrides,
    });
  }

  it('replaces source_path/media_id/source_len/source_fps, preserving every other field, when the new source is at least as long', () => {
    const before = tl([richClip()]);
    const after = applyOp(before, {
      kind: 'swap_media',
      track: 0,
      clip: 0,
      media_id: 'media-2',
      source_path: '/media/replacement.mov',
      source_len: 500,
      source_fps: 60,
    });
    const c = after.tracks[0].clips[0];
    expect(c.media_id).toBe('media-2');
    expect(c.source_path).toBe('/media/replacement.mov');
    expect(c.source_len).toBe(500);
    expect(c.source_fps).toBe(60); // the NEW source's own rate, not the old 30
    // everything else preserved exactly
    expect(c.start_frame).toBe(40);
    expect(c.source_start).toBe(10);
    expect(c.duration).toBe(50);
    expect(c.link_group).toBe('g1');
    expect(c.opacity).toBe(0.8);
    expect(c.position_x).toBe(0.25);
    expect(c.position_y).toBe(0.1);
    expect(c.scale).toBe(1.4);
    expect(c.box_width).toBe(0.5);
    expect(c.box_height).toBeNull();
    expect(c.rotation).toBe(5);
    expect(c.crop_left).toBe(0.1);
    expect(c.crop_bottom).toBe(0.05);
    expect(c.chroma_keyframes).toEqual([{ frame: 10, params: { scale: 1.5 } }]);
    expect(c.fade_in_frames).toBe(8);
    expect(c.fade_out_frames).toBe(12);
  });

  it('re-clamps source_start/duration when the new source is SHORTER than the current window — preserves source_start, shrinks duration', () => {
    // current window [10, 60) needs source_len >= 60; the new source is only
    // 45 frames long, so source_start (10) still fits but duration must
    // shrink to what remains (45 - 10 = 35).
    const before = tl([richClip({ source_start: 10, duration: 50, source_len: 100 })]);
    const after = applyOp(before, {
      kind: 'swap_media',
      track: 0,
      clip: 0,
      media_id: 'short',
      source_path: '/media/short.mov',
      source_len: 45,
    });
    const c = after.tracks[0].clips[0];
    expect(c.source_start).toBe(10); // preserved — still fits
    expect(c.duration).toBe(35); // shrunk to fit (45 - 10)
    expect(c.start_frame).toBe(40); // the timeline position never moves
  });

  it('pins source_start back to the new source\'s own last frame when even source_start no longer fits', () => {
    // current source_start is 10, but the new source is only 5 frames long —
    // source_start itself has to move, not just duration.
    const before = tl([richClip({ source_start: 10, duration: 50, source_len: 100 })]);
    const after = applyOp(before, {
      kind: 'swap_media',
      track: 0,
      clip: 0,
      media_id: 'tiny',
      source_path: '/media/tiny.mov',
      source_len: 5,
    });
    const c = after.tracks[0].clips[0];
    expect(c.source_start).toBe(4); // ceiling - 1
    expect(c.duration).toBe(1); // floored at 1 frame minimum
  });

  it('clears source_fps to undefined when the new source was never probed, rather than keeping the old rate', () => {
    const before = tl([richClip({ source_fps: 30 })]);
    const after = applyOp(before, {
      kind: 'swap_media',
      track: 0,
      clip: 0,
      media_id: 'unprobed',
      source_path: '/media/unprobed.mov',
      source_len: 200,
      // source_fps omitted — the caller couldn't probe the new file's rate
    });
    expect(after.tracks[0].clips[0].source_fps).toBeUndefined();
  });

  it('does NOT propagate to a linked clip — only the named clip is touched', () => {
    const before = linkedPair();
    const after = applyOp(before, {
      kind: 'swap_media',
      track: 0,
      clip: 0,
      media_id: 'new-video',
      source_path: '/media/new-video.mov',
      source_len: 300,
      source_fps: 25,
    });
    expect(after.tracks[0].clips[0].source_path).toBe('/media/new-video.mov');
    expect(after.tracks[1].clips[0].source_path).toBe(before.tracks[1].clips[0].source_path); // untouched
    // the link survives the swap — swap_media never touches link_group
    expect(after.tracks[0].clips[0].link_group).toBe('g1');
    expect(after.tracks[1].clips[0].link_group).toBe('g1');
  });

  it('is a no-op (same reference) when the clip index is out of range', () => {
    const before = tl(backToBack());
    expect(
      applyOp(before, {
        kind: 'swap_media',
        track: 0,
        clip: 99,
        media_id: 'x',
        source_path: '/x.mov',
        source_len: 10,
      }),
    ).toBe(before);
  });

  it('is refused on a locked track', () => {
    const before: Timeline = {
      id: 't1',
      name: 'Timeline',
      tracks: [{ kind: 'video', clips: backToBack(), locked: true }],
    };
    expect(
      applyOp(before, {
        kind: 'swap_media',
        track: 0,
        clip: 0,
        media_id: 'x',
        source_path: '/x.mov',
        source_len: 10,
      }),
    ).toBe(before);
  });

  it('labels the history entry with the clip name', () => {
    const before = tl(backToBack());
    expect(
      labelForOp(
        { kind: 'swap_media', track: 0, clip: 1, media_id: 'x', source_path: '/x.mov', source_len: 10 },
        before,
      ),
    ).toBe('Swap media on "B-roll 1"');
  });
});

describe('track lock enforcement (D-086/D-089) — mirrors apelles_timeline::TimelineError::TrackLocked', () => {
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
      applyOp(before, {
        kind: 'set_clip_transform',
        track: 0,
        clip: 0,
        opacity: 0.5,
        position_x: 0,
        position_y: 0,
        scale: 1,
        ...NO_BOX_OVERRIDE,
        rotation: 0,
        ...NO_CROP,
      }),
    ).toBe(before);
  });

  it('set_clip_fade is refused on a locked track', () => {
    const before = lockedTl();
    expect(
      applyOp(before, { kind: 'set_clip_fade', track: 0, clip: 0, fade_in_frames: 10, fade_out_frames: 10 }),
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
// cross-track ripple sync (D-106) — mirrors crates/apelles-timeline's own
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

  it('slips both halves in lockstep, from either side (D-195 — the exact "unlink, slip one half" escape hatch unlink\'s own doc names)', () => {
    const t = linkedPair();
    t.tracks[0].clips[0].source_len = 10000;
    t.tracks[1].clips[0].source_len = 10000;
    const fromVideo = applyOp(t, { kind: 'slip', track: 0, clip: 0, delta: 15 });
    expect(startOf(fromVideo, 0, 'v')).toBe(0); // start_frame never moves for a slip
    expect(fromVideo.tracks[0].clips.find((c) => c.id === 'v')!.source_start).toBe(15);
    expect(fromVideo.tracks[1].clips.find((c) => c.id === 'a')!.source_start).toBe(15);

    const fromAudio = applyOp(t, { kind: 'slip', track: 1, clip: 0, delta: -5 });
    expect(fromAudio.tracks[1].clips.find((c) => c.id === 'a')!.source_start).toBe(0);
    expect(fromAudio.tracks[0].clips.find((c) => c.id === 'v')!.source_start).toBe(0);
  });

  it('rejects a slip that would clamp differently on the two halves', () => {
    const t = linkedPair();
    // Give the video half plenty of room but pin the audio half already at
    // its tail — the same on-screen delta clamps to 0 on one half and a
    // real move on the other, so the whole op must be rejected.
    t.tracks[0].clips[0].source_len = 10000;
    t.tracks[1].clips[0].source_start = t.tracks[1].clips[0].source_len - t.tracks[1].clips[0].duration;
    expect(applyOp(t, { kind: 'slip', track: 0, clip: 0, delta: 50 })).toBe(t);
  });

  it('refuses a slip when the linked half sits on a locked track', () => {
    const t = linkedPair();
    t.tracks[1].locked = true;
    expect(applyOp(t, { kind: 'slip', track: 0, clip: 0, delta: 10 })).toBe(t);
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

/** Same shape as `linkedPair()`, minus the `link_group` — two genuinely
 *  independent clips, the starting point every `link` test starts from. */
function unlinkedPair(): Timeline {
  return {
    id: 't',
    name: 't',
    tracks: [
      { kind: 'video', clips: [clip('v', 'Shot')] },
      { kind: 'audio', clips: [clip('a', 'Shot')] },
    ],
  };
}

describe('checkLink / link op (D-138)', () => {
  it('checkLink accepts one video clip + one unlinked audio clip', () => {
    const t = unlinkedPair();
    expect(checkLink(t, { track: 0, clip: 0 }, { track: 1, clip: 0 })).toEqual({ ok: true });
    // order-independent
    expect(checkLink(t, { track: 1, clip: 0 }, { track: 0, clip: 0 })).toEqual({ ok: true });
  });

  it('checkLink rejects the same clip given twice, with a clear reason', () => {
    const t = unlinkedPair();
    expect(checkLink(t, { track: 0, clip: 0 }, { track: 0, clip: 0 }).ok).toBe(false);
    expect(checkLink(t, { track: 0, clip: 0 }, { track: 0, clip: 0 }).reason).toMatch(/different clips/i);
  });

  it('checkLink rejects two clips of the same track kind', () => {
    const t = unlinkedPair();
    t.tracks[0].clips.push(clip('v2', 'Shot 2'));
    const result = checkLink(t, { track: 0, clip: 0 }, { track: 0, clip: 1 });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/one video clip and one audio clip/i);
  });

  it('checkLink rejects an already-linked clip', () => {
    const t = linkedPair();
    t.tracks[1].clips.push(clip('a2', 'Other'));
    const result = checkLink(t, { track: 0, clip: 0 }, { track: 1, clip: 1 });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/already linked/i);
  });

  it('checkLink rejects a locked track', () => {
    const t = unlinkedPair();
    t.tracks[1].locked = true;
    const result = checkLink(t, { track: 0, clip: 0 }, { track: 1, clip: 0 });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/locked/i);
  });

  it('assigns a shared group id to both clips, order-independent', () => {
    const videoFirst = applyOp(unlinkedPair(), { kind: 'link', trackA: 0, clipA: 0, trackB: 1, clipB: 0 });
    const audioFirst = applyOp(unlinkedPair(), { kind: 'link', trackA: 1, clipA: 0, trackB: 0, clipB: 0 });
    expect(videoFirst.tracks[0].clips[0].link_group).toBeTruthy();
    expect(videoFirst.tracks[0].clips[0].link_group).toBe(videoFirst.tracks[1].clips[0].link_group);
    expect(videoFirst.tracks[0].clips[0].link_group).toBe(audioFirst.tracks[0].clips[0].link_group);
  });

  it('the resulting group behaves exactly like a drop-created one — every op treats it identically', () => {
    const linked = applyOp(unlinkedPair(), { kind: 'link', trackA: 0, clipA: 0, trackB: 1, clipB: 0 });
    const moved = applyOp(linked, { kind: 'move', fromTrack: 0, toTrack: 0, clip: 0, startFrame: 40 });
    expect(startOf(moved, 0, 'v')).toBe(40);
    expect(startOf(moved, 1, 'a')).toBe(40);
  });

  it('is a no-op (rejected whole) when checkLink fails, e.g. same clip or wrong kind', () => {
    const t = unlinkedPair();
    expect(applyOp(t, { kind: 'link', trackA: 0, clipA: 0, trackB: 0, clipB: 0 })).toBe(t);
    const alreadyLinked = linkedPair();
    alreadyLinked.tracks[1].clips.push(clip('a2', 'Other'));
    expect(applyOp(alreadyLinked, { kind: 'link', trackA: 0, clipA: 0, trackB: 1, clipB: 1 })).toBe(alreadyLinked);
  });

  it('link then unlink round-trips to fully independent clips', () => {
    const linked = applyOp(unlinkedPair(), { kind: 'link', trackA: 0, clipA: 0, trackB: 1, clipB: 0 });
    const unlinked = applyOp(linked, { kind: 'unlink', track: 0, clip: 0 });
    expect(unlinked.tracks[0].clips[0].link_group).toBeNull();
    expect(unlinked.tracks[1].clips[0].link_group).toBeNull();
  });

  it('labels itself in the history', () => {
    expect(labelForOp({ kind: 'link', trackA: 0, clipA: 0, trackB: 1, clipB: 0 }, unlinkedPair())).toBe(
      'Link "Shot" + "Shot"',
    );
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

// B-077 — `apelles-timeline::Clip`'s own doc is explicit that `source_start`/
// `duration` are in the clip's own SOURCE frames while `start_frame` is a
// TIMELINE frame (the project's own `timelineFps`) — genuinely two different
// frame-rate spaces whenever a clip's native rate differs from the project's.
// Every case below pins a mixed-fps scenario that the pre-fix code (plain
// `start_frame + duration`, no `source_fps` conversion) got wrong — live
// confirmed as a 47.86s clip displaying as 88s in a 24fps project
// (2113 source frames / 24 project-fps = 88, nothing to do with the clip's
// real ~47.86s length at its own 44.13fps).
describe('B-077 — mixed native-fps clips (source_fps vs. timelineFps)', () => {
  // A clean 2:1 ratio (48fps source on a 24fps timeline) keeps the expected
  // numbers exact (no rounding) so a wrong-by-a-rounding-error result can't
  // hide behind "close enough" — 100 source frames is exactly 50 timeline
  // frames (100 / 48 = 2.0833s of real time = 50 frames at 24fps).
  const fastClip = (overrides: Partial<Clip> = {}) =>
    clip('fast', 'Fast (48fps)', { duration: 100, source_len: 100, source_fps: 48, ...overrides });

  it('endFrame converts duration through source_fps, not the project fps directly', () => {
    const c = fastClip({ start_frame: 0 });
    // Pre-fix this was 0 + 100 = 100 — half again too long.
    expect(endFrame(c, 24)).toBe(50);
  });

  it('pins the exact live repro: 2113 source frames @ 44.128089105464674fps on an (unset-rate) 24fps timeline', () => {
    // The real numbers from the live bug report: a 2113-frame screen
    // recording at 44.128089105464674fps (real duration 47.8867s) on a
    // timeline whose `rate` was never set (DEFAULT_FPS = 24). The GUI
    // transport bar showed 00:01:28:00 (88s) — exactly 2113 / 24 — before
    // this fix; the correct timeline-frame length is round(47.8867 * 24).
    const c = clip('rec', 'Screen recording', {
      start_frame: 0,
      duration: 2113,
      source_len: 2113,
      source_fps: 44.128089105464674,
    });
    const realSeconds = 2113 / 44.128089105464674;
    expect(realSeconds).toBeCloseTo(47.883, 3);
    expect(endFrame(c, 24)).toBe(Math.round(realSeconds * 24)); // 1149, not 2113
    expect(endFrame(c, 24)).toBe(1149);
  });

  it('trackDuration / timelineDuration report the fps-corrected length, not the raw source-frame sum', () => {
    const track: Track = { kind: 'video', clips: [fastClip({ start_frame: 0 })] };
    expect(trackDuration(track, 24)).toBe(50);
    const timeline = tl([fastClip({ start_frame: 0 })]);
    expect(timelineDuration(timeline)).toBe(50);
  });

  it('a clip with no source_fps (pre-B-075, or same-rate) is unaffected — the identity path', () => {
    const c = clip('same', 'Same-rate', { start_frame: 10, duration: 40 }); // no source_fps
    expect(endFrame(c, 24)).toBe(50); // exactly the pre-B-077 formula
  });

  it('add_clip ripple shifts existing clips by the NEW clip\'s timeline footprint, not its raw duration', () => {
    // a:[0,100) b:[100,200) on a 24fps timeline; inserting the 48fps
    // `fastClip` (real timeline footprint 50 frames, not its raw duration
    // of 100) at frame 100 with ripple must shift b by 50, not 100.
    const before = tl(backToBack());
    const after = applyOp(before, {
      kind: 'add_clip',
      track: 0,
      clip: fastClip(),
      startFrame: 100,
      ripple: true,
    });
    const [a, inserted, b] = after.tracks[0].clips;
    expect(a.start_frame).toBe(0);
    expect(inserted.start_frame).toBe(100);
    expect(endFrame(inserted, 24)).toBe(150); // 100 + 50, not 100 + 100
    expect(b.start_frame).toBe(150); // rippled by 50 (the timeline footprint), not 100
  });

  it('computeInsertion sizes the incoming clip by its timeline footprint for overlap/edge checks', () => {
    // a:[0,100) with nothing after it. Dropping the 48fps fastClip (real
    // timeline footprint 50) at frame 100 must fit with NO ripple — it only
    // reaches [100,150), nowhere near anything else — whereas treating its
    // raw duration (100) as timeline frames would still fit here too, so
    // this case additionally checks the edge list is built from converted
    // (not raw) clip lengths via a snap check right at the real 150 boundary.
    const track: Track = { kind: 'video', clips: [clip('a', 'A', { start_frame: 0, duration: 100 })] };
    expect(computeInsertion(track, 100, fastClip(), 10, 24)).toEqual({ startFrame: 100, ripple: false });
    // Snapping to the inserted clip's own real end (50), not a phantom edge
    // at its raw-duration end (100) that only the unconverted formula would
    // add: dropping a 20-frame clip at frame 53 (within the 10-frame snap
    // radius of 50, nowhere near 100) must snap to 50.
    const withFast: Track = { kind: 'video', clips: [fastClip({ start_frame: 0 })] };
    expect(computeInsertion(withFast, 53, { duration: 20 }, 10, 24)).toEqual({ startFrame: 50, ripple: false });
  });

  it('gapAt/clipAt find a mixed-fps clip\'s real end, not its raw source-frame end', () => {
    // fastClip at [0,50) (its real timeline footprint), then a REAL gap
    // (a following clip at 200, so [50,200) is a real, closeable gap — not
    // just trailing space, which `gapAt` deliberately treats as "no gap").
    const track: Track = {
      kind: 'video',
      clips: [fastClip({ start_frame: 0 }), clip('after', 'After', { start_frame: 200, duration: 50 })],
    };
    // Frame 60 must read as inside the gap (past the clip's REAL end at 50)
    // — the pre-fix formula would have placed the clip's end at 100, making
    // 60 wrongly read as still inside it (gapAt returns null for a frame
    // inside a clip, and its gapStart would have come out as 100, not 50).
    expect(gapAt(track, 60, 24)).toEqual({ gapStart: 50, gapEnd: 200 });
    expect(clipAt(track, 60, 24)).toBeNull();
    expect(clipAt(track, 49, 24)?.clip.id).toBe('fast');
  });

  it('trim_start moves start_frame by the timeline delta but source_start/duration by the source-frame equivalent', () => {
    // fastClip (48fps) at start_frame 100 on a 24fps timeline; trimming its
    // head by 10 TIMELINE frames should move start_frame by 10 but consume
    // 20 SOURCE frames off the front (10 timeline frames * 48/24 ratio),
    // keeping the clip's real end fixed on the timeline.
    const before = tl([fastClip({ start_frame: 100 })]);
    const endBefore = endFrame(before.tracks[0].clips[0], 24);
    const after = applyOp(before, { kind: 'trim_start', track: 0, clip: 0, delta: 10 });
    const c = after.tracks[0].clips[0];
    expect(c.start_frame).toBe(110); // moved by the raw TIMELINE delta
    expect(c.source_start).toBe(20); // moved by the SOURCE-frame equivalent (10 * 48/24)
    expect(c.duration).toBe(80); // shrunk by the same source-frame amount
    expect(endFrame(c, 24)).toBe(endBefore); // the clip's real end on the timeline is unchanged
  });

  it('trim_end changes duration by the source-frame equivalent of a timeline-frame delta', () => {
    // Extending fastClip's tail by 10 TIMELINE frames should grow `duration`
    // by 20 SOURCE frames (10 * 48/24), extending its real end by exactly
    // 10 timeline frames.
    const before = tl([fastClip({ start_frame: 0, source_len: 1000 })]);
    const after = applyOp(before, { kind: 'trim_end', track: 0, clip: 0, delta: 10 });
    const c = after.tracks[0].clips[0];
    expect(c.duration).toBe(120); // 100 + 20 source frames
    expect(endFrame(c, 24)).toBe(60); // 50 + 10 timeline frames
  });

  it('split divides source_start/duration by the source-frame equivalent of the timeline split offset', () => {
    // fastClip at [0,50) in timeline frames; splitting at timeline frame 20
    // (40% through its real length) must give the right half 40% of its
    // SOURCE frames too (40 of 100), not 20 (a raw, unconverted offset).
    const before = tl([fastClip({ start_frame: 0 })]);
    const after = applyOp(before, { kind: 'split', track: 0, clip: 0, atFrame: 20 });
    const [left, right] = after.tracks[0].clips;
    expect(left.start_frame).toBe(0);
    expect(left.duration).toBe(40); // 20 timeline frames * 48/24 source-frame ratio
    expect(right.start_frame).toBe(20);
    expect(right.source_start).toBe(40);
    expect(right.duration).toBe(60); // 100 - 40
    expect(endFrame(left, 24)).toBe(right.start_frame); // still exactly adjacent
  });

  it('move ripple shifts by the moving clip\'s timeline footprint, not its raw duration', () => {
    // dest already has x:[100,200); dropping fastClip (real footprint 50)
    // exactly on x's start with ripple must shift x by 50, not 100.
    const before = tl([fastClip({ start_frame: 0 }), clip('x', 'X', { start_frame: 300, duration: 50 })]);
    const after = applyOp(before, {
      kind: 'move',
      fromTrack: 0,
      toTrack: 0,
      clip: 0,
      startFrame: 300,
      ripple: true,
    });
    const moved = after.tracks[0].clips.find((c) => c.id === 'fast');
    const x = after.tracks[0].clips.find((c) => c.id === 'x');
    expect(moved?.start_frame).toBe(300);
    expect(x?.start_frame).toBe(350); // rippled by 50 (the mover's real footprint), not 100
  });
});

// ---------------------------------------------------------------------------
// D-222 — timeline markers (roadmap item 27)
// ---------------------------------------------------------------------------

describe('newMarker / resolveMarkerColor (D-222)', () => {
  it('builds a marker with a generated id, the default colour and no name/note', () => {
    const m = newMarker(120);
    expect('error' in m).toBe(false);
    if ('error' in m) return;
    expect(m.frame).toBe(120);
    expect(m.color).toBe(DEFAULT_MARKER_COLOR);
    expect(m.id).toMatch(/^marker-/);
    expect(m.name).toBeUndefined();
    expect(m.note).toBeUndefined();
  });

  it('resolves a palette NAME and a raw hex to the same kind of #RRGGBB', () => {
    expect(resolveMarkerColor('red')).toBe(MARKER_COLORS.find((c) => c.name === 'red')?.hex);
    expect(resolveMarkerColor('RED')).toBe(MARKER_COLORS.find((c) => c.name === 'red')?.hex);
    expect(resolveMarkerColor('#abc')).toBe('#ABC');
    expect(resolveMarkerColor('a1b2c3')).toBe('#A1B2C3');
    expect(resolveMarkerColor(null)).toBe(DEFAULT_MARKER_COLOR);
  });

  it('rejects a colour that is neither a palette name nor a hex, naming the palette', () => {
    const r = resolveMarkerColor('chartreuse');
    expect(r).toHaveProperty('error');
    if (typeof r === 'string') return;
    expect(r.error).toContain('chartreuse');
    expect(r.error).toContain('lavender');
  });

  it('floors the frame at 0, rounds it, and drops a whitespace-only name/note', () => {
    const m = newMarker(-7.6, 'green', '   ', '\n');
    if ('error' in m) throw new Error(m.error);
    expect(m.frame).toBe(0);
    expect(m.name).toBeUndefined();
    expect(m.note).toBeUndefined();

    const m2 = newMarker(41.4, 'green', '  sync point  ', ' clap ');
    if ('error' in m2) throw new Error(m2.error);
    expect(m2.frame).toBe(41);
    expect(m2.name).toBe('sync point');
    expect(m2.note).toBe('clap');
  });

  it('rejects a non-finite frame rather than writing NaN into the document', () => {
    expect(newMarker(Number.NaN)).toHaveProperty('error');
  });
});

describe('add_marker / remove_marker / set_marker ops (D-222)', () => {
  const mk = (id: string, frame: number, over: Partial<Marker> = {}): Marker => ({
    id,
    frame,
    color: DEFAULT_MARKER_COLOR,
    ...over,
  });

  it('a pre-D-222 timeline (no `markers` key at all) takes a marker without error', () => {
    const before = tl(backToBack());
    expect(before.markers).toBeUndefined();
    const after = applyOp(before, { kind: 'add_marker', marker: mk('m1', 50) });
    expect(after.markers).toEqual([mk('m1', 50)]);
    // …and the original is untouched — `applyOp` clones, never mutates.
    expect(before.markers).toBeUndefined();
  });

  it('markersOf reads an absent list as empty and sorts an unsorted one', () => {
    expect(markersOf(tl(backToBack()))).toEqual([]);
    const unsorted: Timeline = { ...tl(backToBack()), markers: [mk('b', 90), mk('a', 10)] };
    expect(markersOf(unsorted).map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('keeps the list sorted by frame on insert, stably on a tie', () => {
    let t: Timeline = tl(backToBack());
    for (const [id, frame] of [
      ['c', 200],
      ['a', 10],
      ['b', 90],
      ['b2', 90],
    ] as const) {
      t = applyOp(t, { kind: 'add_marker', marker: mk(id, frame) });
    }
    expect(t.markers?.map((m) => m.id)).toEqual(['a', 'b', 'b2', 'c']);
  });

  it('remove_marker deletes exactly one, and an unknown id is a no-op (same object back)', () => {
    const before: Timeline = { ...tl(backToBack()), markers: [mk('a', 10), mk('b', 90)] };
    const after = applyOp(before, { kind: 'remove_marker', id: 'a' });
    expect(after.markers?.map((m) => m.id)).toEqual(['b']);
    expect(applyOp(before, { kind: 'remove_marker', id: 'nope' })).toBe(before);
  });

  it('set_marker patches only the named fields, re-sorting after a frame move', () => {
    const before: Timeline = {
      ...tl(backToBack()),
      markers: [mk('a', 10, { name: 'one', note: 'n' }), mk('b', 90)],
    };
    const after = applyOp(before, { kind: 'set_marker', id: 'a', patch: { frame: 150 } });
    expect(after.markers?.map((m) => m.id)).toEqual(['b', 'a']);
    const a = after.markers?.find((m) => m.id === 'a');
    expect(a?.frame).toBe(150);
    // untouched fields survive the patch
    expect(a?.name).toBe('one');
    expect(a?.note).toBe('n');
    expect(a?.color).toBe(DEFAULT_MARKER_COLOR);
  });

  it('set_marker clears a name/note on an explicit null (and on an empty string), but not on an absent key', () => {
    const before: Timeline = { ...tl(backToBack()), markers: [mk('a', 10, { name: 'one', note: 'n' })] };
    const cleared = applyOp(before, { kind: 'set_marker', id: 'a', patch: { name: null } });
    expect(cleared.markers?.[0].name).toBeUndefined();
    expect(cleared.markers?.[0].note).toBe('n'); // absent key left alone

    const clearedByEmpty = applyOp(before, { kind: 'set_marker', id: 'a', patch: { note: '  ' } });
    expect(clearedByEmpty.markers?.[0].note).toBeUndefined();
    expect(clearedByEmpty.markers?.[0].name).toBe('one');
  });

  it('set_marker resolves a colour NAME, and ignores an unresolvable one rather than storing it', () => {
    const before: Timeline = { ...tl(backToBack()), markers: [mk('a', 10)] };
    const named = applyOp(before, { kind: 'set_marker', id: 'a', patch: { color: 'red' } });
    expect(named.markers?.[0].color).toBe(MARKER_COLORS.find((c) => c.name === 'red')?.hex);
    const bad = applyOp(before, { kind: 'set_marker', id: 'a', patch: { color: 'chartreuse' } });
    expect(bad.markers?.[0].color).toBe(DEFAULT_MARKER_COLOR);
  });

  it('set_marker floors a negative frame at 0 and ignores a NaN one', () => {
    const before: Timeline = { ...tl(backToBack()), markers: [mk('a', 10)] };
    expect(applyOp(before, { kind: 'set_marker', id: 'a', patch: { frame: -5 } }).markers?.[0].frame).toBe(0);
    expect(applyOp(before, { kind: 'set_marker', id: 'a', patch: { frame: Number.NaN } }).markers?.[0].frame).toBe(10);
  });

  it('set_marker on an unknown id is a no-op (same object back)', () => {
    const before: Timeline = { ...tl(backToBack()), markers: [mk('a', 10)] };
    expect(applyOp(before, { kind: 'set_marker', id: 'nope', patch: { frame: 5 } })).toBe(before);
  });

  it('a marker survives the clip under it being trimmed, moved and removed — the whole point of living on the Timeline', () => {
    const before: Timeline = { ...tl(backToBack()), markers: [mk('a', 120, { name: 'cut here' })] };
    let t = applyOp(before, { kind: 'trim_start', track: 0, clip: 1, delta: 20 });
    t = applyOp(t, { kind: 'move', fromTrack: 0, toTrack: 0, clip: 1, startFrame: 400 });
    t = applyOp(t, { kind: 'remove', track: 0, clip: 1 });
    expect(t.markers).toEqual([mk('a', 120, { name: 'cut here' })]);
  });

  it('a marker is untouched by track-level ops, including removing the track it sat over', () => {
    const before: Timeline = { ...tl(backToBack()), markers: [mk('a', 50)] };
    const after = applyOp(applyOp(before, { kind: 'add_track', trackKind: 'audio' }), {
      kind: 'remove_track',
      track: 0,
    });
    expect(after.markers).toEqual([mk('a', 50)]);
  });

  it('labelForOp names the marker for all three ops', () => {
    const before: Timeline = { ...tl(backToBack()), markers: [mk('a', 10, { name: 'sync' }), mk('b', 90)] };
    expect(labelForOp({ kind: 'add_marker', marker: mk('c', 5, { name: 'new' }) }, before)).toBe('Add marker "new"');
    expect(labelForOp({ kind: 'add_marker', marker: mk('c', 5) }, before)).toBe('Add marker at 5');
    expect(labelForOp({ kind: 'remove_marker', id: 'a' }, before)).toBe('Remove marker "sync"');
    expect(labelForOp({ kind: 'set_marker', id: 'b', patch: { color: 'red' } }, before)).toBe('Edit marker at 90');
  });
});

// D-224 — per-clip parametric EQ: the model half (the band type, the clamps,
// the default strip and the `set_clip_eq` reducer). The DSP itself has its own
// real-measurement tests in `apelles_types::eq` and, through real ffmpeg, in
// `timelineExport.ffmpeg.test.ts` — what lives here is everything the EDIT
// MODEL adds on top: materialisation, partial writes, clamping, and the
// no-op/identity short-circuits that keep an untouched EQ free.
describe('per-clip parametric EQ — the model (D-224)', () => {
  const eqTl = () => tl([clip('a', 'Intro'), clip('b', 'B-roll 1')]);

  it('the default strip is Resolve’s four bands, and every one of them is inert', () => {
    const bands = defaultEqBands();
    expect(bands).toHaveLength(EQ_BAND_COUNT);
    expect(bands.map((b) => b.kind)).toEqual(['low_shelf', 'peak', 'peak', 'high_shelf']);
    // The property the whole "materialise on first edit" design rests on:
    // showing (and storing) the strip must change nothing about the sound.
    expect(bands.every((b) => b.gain_db === 0)).toBe(true);
    expect(bands.some(isEqBandActive)).toBe(false);
    expect(hasActiveEq(bands)).toBe(false);
    expect(eqFilterChain(bands)).toBeNull();
  });

  it('hands out a fresh copy each time, so one clip’s edit cannot rewrite another’s defaults', () => {
    const first = defaultEqBands();
    first[0].gain_db = 12;
    expect(defaultEqBands()[0].gain_db).toBe(0);
  });

  it('a clip with no EQ displays the default strip without storing it', () => {
    const before = eqTl();
    expect(eqBandsForDisplay(before.tracks[0].clips[0].eq_bands)).toHaveLength(EQ_BAND_COUNT);
    // …and the clip itself is untouched: opening the Inspector never dirties
    // the project.
    expect(before.tracks[0].clips[0].eq_bands).toBeUndefined();
  });

  it('the first edit MATERIALISES the whole strip, not a lone orphan band', () => {
    const after = applyOp(eqTl(), {
      kind: 'set_clip_eq',
      track: 0,
      clip: 0,
      band: 2,
      patch: { gain_db: -6 },
    });
    const bands = after.tracks[0].clips[0].eq_bands;
    expect(bands).toHaveLength(EQ_BAND_COUNT);
    expect(bands?.[2].gain_db).toBe(-6);
    // The band it edited kept its own default frequency and kind — a partial
    // write must not restate anything it was not given.
    expect(bands?.[2].kind).toBe('peak');
    expect(bands?.[2].freq_hz).toBe(2500);
    // …and the other three are still the untouched defaults.
    expect(bands?.filter((b) => b.gain_db !== 0)).toHaveLength(1);
    // The neighbouring clip is completely unaffected.
    expect(after.tracks[0].clips[1].eq_bands).toBeUndefined();
  });

  it('patches ONE field at a time, leaving every other field on that band alone', () => {
    let t = applyOp(eqTl(), { kind: 'set_clip_eq', track: 0, clip: 0, band: 0, patch: { kind: 'high_pass' } });
    t = applyOp(t, { kind: 'set_clip_eq', track: 0, clip: 0, band: 0, patch: { freq_hz: 85 } });
    t = applyOp(t, { kind: 'set_clip_eq', track: 0, clip: 0, band: 0, patch: { q: 1.2 } });
    const band = t.tracks[0].clips[0].eq_bands?.[0];
    expect(band).toEqual({ kind: 'high_pass', freq_hz: 85, gain_db: 0, q: 1.2, enabled: true });
    // A high-pass has no gain to zero, so it IS active at 0 dB — the whole
    // reason `is_active` asks the kind rather than just the gain.
    expect(isEqBandActive(band as EqBand)).toBe(true);
    expect(hasActiveEq(t.tracks[0].clips[0].eq_bands)).toBe(true);
  });

  it('clamps every field into its documented range on the way in', () => {
    const t = applyOp(eqTl(), {
      kind: 'set_clip_eq',
      track: 0,
      clip: 0,
      band: 1,
      patch: { freq_hz: 99_999, gain_db: 900, q: -3 },
    });
    const band = t.tracks[0].clips[0].eq_bands?.[1];
    expect(band?.freq_hz).toBe(EQ_MAX_FREQ_HZ);
    expect(band?.gain_db).toBe(EQ_MAX_GAIN_DB);
    expect(band?.q).toBe(EQ_MIN_Q);
    // NaN (a cleared numeric input) falls back to the field's default rather
    // than reaching a filter, where one NaN sample poisons every sample after.
    const nan = applyOp(t, {
      kind: 'set_clip_eq',
      track: 0,
      clip: 0,
      band: 1,
      patch: { freq_hz: Number.NaN },
    });
    expect(nan.tracks[0].clips[0].eq_bands?.[1].freq_hz).toBe(1000);
  });

  it('a disabled band keeps its settings and stops doing anything', () => {
    let t = applyOp(eqTl(), {
      kind: 'set_clip_eq',
      track: 0,
      clip: 0,
      band: 1,
      patch: { gain_db: 9, freq_hz: 700 },
    });
    expect(hasActiveEq(t.tracks[0].clips[0].eq_bands)).toBe(true);
    t = applyOp(t, { kind: 'set_clip_eq', track: 0, clip: 0, band: 1, patch: { enabled: false } });
    expect(hasActiveEq(t.tracks[0].clips[0].eq_bands)).toBe(false);
    expect(t.tracks[0].clips[0].eq_bands?.[1].gain_db).toBe(9);
    expect(t.tracks[0].clips[0].eq_bands?.[1].freq_hz).toBe(700);
  });

  it('clear removes the key entirely, so the clip serialises as it did pre-D-224', () => {
    const withEq = applyOp(eqTl(), {
      kind: 'set_clip_eq',
      track: 0,
      clip: 0,
      band: 0,
      patch: { gain_db: 6 },
    });
    const cleared = applyOp(withEq, { kind: 'set_clip_eq', track: 0, clip: 0, clear: true });
    // Not `[]` — an empty array would serialise as a real `"eq_bands": []`
    // where the Rust field's own `skip_serializing_if` writes nothing at all.
    expect('eq_bands' in cleared.tracks[0].clips[0]).toBe(false);
    expect(JSON.stringify(cleared)).not.toContain('eq_bands');
  });

  it('a no-op edit returns the SAME timeline, so it pushes no undo entry', () => {
    const withEq = applyOp(eqTl(), {
      kind: 'set_clip_eq',
      track: 0,
      clip: 0,
      band: 0,
      patch: { gain_db: 6 },
    });
    // Re-typing the value it already has.
    expect(applyOp(withEq, { kind: 'set_clip_eq', track: 0, clip: 0, band: 0, patch: { gain_db: 6 } })).toBe(
      withEq,
    );
    // …and clearing a clip that already has no EQ.
    const plain = eqTl();
    expect(applyOp(plain, { kind: 'set_clip_eq', track: 0, clip: 0, clear: true })).toBe(plain);
  });

  it('refuses an out-of-range band, a missing band, and a locked track', () => {
    const plain = eqTl();
    expect(applyOp(plain, { kind: 'set_clip_eq', track: 0, clip: 0, band: 9, patch: { gain_db: 3 } })).toBe(plain);
    expect(applyOp(plain, { kind: 'set_clip_eq', track: 0, clip: 0, band: -1, patch: { gain_db: 3 } })).toBe(plain);
    expect(applyOp(plain, { kind: 'set_clip_eq', track: 0, clip: 0, patch: { gain_db: 3 } })).toBe(plain);
    const locked: Timeline = { ...plain, tracks: [{ ...plain.tracks[0], locked: true }] };
    expect(applyOp(locked, { kind: 'set_clip_eq', track: 0, clip: 0, band: 0, patch: { gain_db: 3 } })).toBe(locked);
  });

  it('names the band (and the clear) in its undo label', () => {
    const before = eqTl();
    expect(labelForOp({ kind: 'set_clip_eq', track: 0, clip: 1, band: 2, patch: { gain_db: 3 } }, before)).toBe(
      'EQ band 3 on "B-roll 1"',
    );
    expect(labelForOp({ kind: 'set_clip_eq', track: 0, clip: 0, clear: true }, before)).toBe('Clear "Intro" EQ');
  });

  it('the response curve is the dB SUM of the active bands, and ignores the inactive ones', () => {
    const bands: EqBand[] = [
      { kind: 'peak', freq_hz: 1000, gain_db: 6, q: 1, enabled: true },
      { kind: 'peak', freq_hz: 1000, gain_db: -2, q: 1, enabled: true },
      // Loud, and switched off — must contribute exactly nothing.
      { kind: 'peak', freq_hz: 1000, gain_db: 18, q: 1, enabled: false },
    ];
    expect(eqResponseDb(bands, 1000)).toBeCloseTo(4, 9);
    // A bell IS its gain at its own centre, and flat far away — the cookbook's
    // own defining property, mirrored here from `apelles_types::eq`.
    expect(eqResponseDb([bands[0]], 1000)).toBeCloseTo(6, 9);
    expect(Math.abs(eqResponseDb([bands[0]], 20))).toBeLessThan(0.05);
    expect(eqResponseDb(undefined, 1000)).toBe(0);
  });
});

// --------------------------------------------------------------------------- //
// D-226 — transitions: the derived window/handle arithmetic, the placement
// preconditions, and the three ops. The PIXELS these produce are
// `timelineExportTransitions.ffmpeg.test.ts` (export) and `chroma::edit`'s own
// `preview_transition_tests` (preview); what is checked here is the model.
// --------------------------------------------------------------------------- //

describe('D-226 transitions — model', () => {
  /** Two abutting 48-frame clips cut at frame 48, each trimmed INSIDE its own
   *  144-frame source so real handle media exists on both sides — the shape a
   *  razor split produces, and the one a cross dissolve needs. */
  function cutTimeline(): Timeline {
    const mk = (id: string, start: number): Clip => ({
      id,
      name: id,
      source_path: `/media/${id}.mov`,
      source_start: 48,
      duration: 48,
      source_len: 144,
      start_frame: start,
    });
    return { id: 't1', name: 'T', tracks: [{ kind: 'video', clips: [mk('A', 0), mk('B', 48)] }] };
  }

  const tr = (over: Partial<Transition> = {}): Transition => ({
    id: 'x',
    kind: 'cross_dissolve',
    at_frame: 48,
    duration: 24,
    alignment: 'center_at_cut',
    ...over,
  });

  it('derives the window and the handle split from the alignment', () => {
    expect(transitionWindow(tr())).toEqual({ start: 36, end: 60 });
    expect(transitionHandles(tr())).toEqual({ head: 12, tail: 12 });
    expect(transitionWindow(tr({ alignment: 'start_at_cut' }))).toEqual({ start: 48, end: 72 });
    expect(transitionHandles(tr({ alignment: 'start_at_cut' }))).toEqual({ head: 0, tail: 24 });
    expect(transitionWindow(tr({ alignment: 'end_at_cut' }))).toEqual({ start: 24, end: 48 });
    expect(transitionHandles(tr({ alignment: 'end_at_cut' }))).toEqual({ head: 24, tail: 0 });
    // An odd duration puts the extra frame AFTER the cut — the same integer
    // halving `apelles_timeline::Transition::window` does, stated so the two
    // engines agree by construction rather than by luck.
    expect(transitionWindow(tr({ duration: 5 }))).toEqual({ start: 46, end: 51 });
  });

  it('cutFrames finds only real end-to-start touches, not every clip edge', () => {
    const t = cutTimeline();
    expect(cutFrames(t.tracks[0], 24)).toEqual([48]);
    // Open a gap: the cut is gone.
    t.tracks[0].clips[1].start_frame = 60;
    expect(cutFrames(t.tracks[0], 24)).toEqual([]);
  });

  it('checkTransition accepts a well-handled cross dissolve and adds it', () => {
    const before = cutTimeline();
    expect(checkTransition(before, 0, tr(), 24)).toEqual({ ok: true });
    const after = applyOp(before, { kind: 'add_transition', track: 0, transition: tr() });
    expect(after.tracks[0].transitions).toHaveLength(1);
    expect(after.tracks[0].clips).toEqual(before.tracks[0].clips); // no clip was re-trimmed
  });

  it('refuses a frame that is not a real cut, naming the cuts that ARE there', () => {
    const before = cutTimeline();
    const check = checkTransition(before, 0, tr({ at_frame: 30 }), 24);
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('cuts are at 48');
    expect(applyOp(before, { kind: 'add_transition', track: 0, transition: tr({ at_frame: 30 }) })).toBe(before);
  });

  it('refuses a cross dissolve with no handle media — and names the alignment that would fit', () => {
    // Two WHOLE files butted together: no head handle on B, no tail on A.
    const before: Timeline = {
      id: 't1',
      name: 'T',
      tracks: [
        {
          kind: 'video',
          clips: [
            { id: 'A', name: 'A', source_path: '/a.mov', source_start: 0, duration: 48, source_len: 48, start_frame: 0 },
            { id: 'B', name: 'B', source_path: '/b.mov', source_start: 0, duration: 48, source_len: 48, start_frame: 48 },
          ],
        },
      ],
    };
    const check = checkTransition(before, 0, tr(), 24);
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('insufficient media');
    expect(check.reason).toContain('Dip to Color');

    // Only the head is missing -> "Start at Cut" is the named fix.
    before.tracks[0].clips[0].source_len = 144; // A now has a real tail handle
    const headOnly = checkTransition(before, 0, tr(), 24);
    expect(headOnly.reason).toContain('Start at Cut');

    // …and a DIP needs no handles at all, so the same cut takes one.
    expect(checkTransition(before, 0, tr({ kind: 'dip_to_color' }), 24)).toEqual({ ok: true });
  });

  it('refuses a window that would swallow a neighbouring clip whole', () => {
    const before = cutTimeline(); // each clip is 48 frames long
    const check = checkTransition(before, 0, tr({ duration: 120 }), 24);
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('past the start of "A"');
  });

  it('refuses a second transition whose window overlaps the first', () => {
    const before = applyOp(cutTimeline(), { kind: 'add_transition', track: 0, transition: tr() });
    const check = checkTransition(before, 0, tr({ id: 'y' }), 24);
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('overlaps the transition already at frame 48');
  });

  it('refuses a locked track and a non-video track', () => {
    const locked = cutTimeline();
    locked.tracks[0].locked = true;
    expect(checkTransition(locked, 0, tr(), 24).reason).toContain('locked');
    const audio = cutTimeline();
    audio.tracks[0].kind = 'audio';
    expect(checkTransition(audio, 0, tr(), 24).reason).toContain('video tracks only');
  });

  it('set_transition patches, re-validates the MERGED shape, and clears a colour with null', () => {
    const withDip = applyOp(cutTimeline(), {
      kind: 'add_transition',
      track: 0,
      transition: tr({ kind: 'dip_to_color', color: '#123456' }),
    });
    // Shortening is always fine.
    const shorter = applyOp(withDip, { kind: 'set_transition', track: 0, id: 'x', patch: { duration: 8 } });
    expect(shorter.tracks[0].transitions?.[0].duration).toBe(8);
    expect(shorter.tracks[0].transitions?.[0].color).toBe('#123456'); // untouched by the patch
    // `null` clears the colour back to the default (black).
    const cleared = applyOp(shorter, { kind: 'set_transition', track: 0, id: 'x', patch: { color: null } });
    expect(cleared.tracks[0].transitions?.[0].color).toBeUndefined();
    // Lengthening past what the clips allow is refused — the merged shape is
    // what gets checked, not just the patch.
    expect(applyOp(shorter, { kind: 'set_transition', track: 0, id: 'x', patch: { duration: 500 } })).toBe(shorter);
  });

  it('remove_transition deletes it and touches no clip; an unknown id is a no-op', () => {
    const before = applyOp(cutTimeline(), { kind: 'add_transition', track: 0, transition: tr() });
    const after = applyOp(before, { kind: 'remove_transition', track: 0, id: 'x' });
    expect(after.tracks[0].transitions).toEqual([]);
    expect(after.tracks[0].clips).toEqual(before.tracks[0].clips);
    expect(applyOp(before, { kind: 'remove_transition', track: 0, id: 'nope' })).toBe(before);
  });

  it('newTransition owns id generation and colour resolution, and rejects a bad kind', () => {
    const t = newTransition('dip_to_color', 48, 24, 'center_at_cut', 'red');
    expect('error' in t).toBe(false);
    if ('error' in t) return;
    expect(t.id).toMatch(/^transition-/);
    expect(t.color).toBe('#D9434E'); // the shared MARKER_COLORS palette's own red
    expect(newTransition('wipe' as never, 48)).toEqual({
      error: expect.stringContaining('unknown transition kind'),
    });
  });

  it('labelForOp names the transition shape and its cut for all three ops', () => {
    const before = applyOp(cutTimeline(), { kind: 'add_transition', track: 0, transition: tr() });
    expect(labelForOp({ kind: 'add_transition', track: 0, transition: tr() }, before)).toBe(
      'Add Cross Dissolve at 48',
    );
    expect(labelForOp({ kind: 'remove_transition', track: 0, id: 'x' }, before)).toBe(
      'Remove transition Cross Dissolve at 48',
    );
    expect(labelForOp({ kind: 'set_transition', track: 0, id: 'x', patch: { duration: 8 } }, before)).toBe(
      'Edit transition Cross Dissolve at 48',
    );
  });

  it('a track written before transitions existed reads back as having none', () => {
    const legacy = cutTimeline();
    expect(legacy.tracks[0].transitions).toBeUndefined();
    expect(transitionsOf(legacy.tracks[0])).toEqual([]);
  });
});

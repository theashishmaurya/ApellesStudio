// @chroma/editor — D-239, roadmap item 27: the seven edit types on drop.
//
// Two things are under test:
//
//   1. `editTypes.ts` — the seven names, their order (which IS the overlay's
//      hit-test geometry) and `editTargetIndexAt`, the pure pointer→row
//      resolution the overlay's drag depends on.
//   2. The `edit_in` `EditOp` in `timeline.ts` — every one of the seven
//      asserted as a real before/after timeline, plus `checkEditIn`'s refusals,
//      the same way D-058/D-195/D-235 assert theirs.
//
// The real-DOM drag test that proves the overlay actually reaches these ops
// lives in `EditOverlay.dom.test.tsx`.
import { describe, expect, it } from 'vitest';
import {
  DROP_EDIT_TYPES,
  applyOp,
  checkEditIn,
  checkEditTarget,
  editTargetIndexAt,
  endFrame,
  isDropEditType,
  labelForOp,
  timelineFps,
  type Clip,
  type DropEditType,
  type EditOp,
  type NewClipFields,
  type Timeline,
  type Track,
} from './timeline';
import { resolveSpeedSegments, rampOutputSourceFrames } from './speedRamp';

function clip(id: string, overrides: Partial<Clip> = {}): Clip {
  return {
    id,
    name: id,
    source_path: `/media/${id}.mov`,
    source_start: 0,
    duration: 100,
    source_len: 100,
    start_frame: 0,
    ...overrides,
  };
}

/** The incoming source an edit places — a `Clip` minus its `start_frame`, which
 *  is exactly what a Sources-panel drag hands `edit_in`. 60 frames long out of
 *  a 600-frame file, so Replace/Fit-to-Fill have real room to re-cut/retime. */
function incoming(overrides: Partial<NewClipFields> = {}): NewClipFields {
  return {
    id: 'new',
    name: 'new',
    source_path: '/media/new.mov',
    source_start: 0,
    duration: 60,
    source_len: 600,
    ...overrides,
  };
}

function tl(tracks: Track[]): Timeline {
  return { id: 't1', name: 'Timeline', tracks };
}

function video(clips: Clip[]): Track {
  return { kind: 'video', clips };
}

/** Three 100-frame clips butted end to end on one video track: [0,100) [100,200)
 *  [200,300). The reference shape for every "what moved and what didn't". */
function threeUp(): Timeline {
  return tl([
    video([
      clip('a', { start_frame: 0 }),
      clip('b', { start_frame: 100 }),
      clip('c', { start_frame: 200 }),
    ]),
  ]);
}

/** Every clip on a track as `[id, start, end)`, ordered by position — the one
 *  readable assertion shape for "what did this edit do to the timeline". */
function layout(t: Timeline, track = 0): Array<[string, number, number]> {
  const fps = timelineFps(t);
  return [...t.tracks[track].clips]
    .sort((x, y) => x.start_frame - y.start_frame)
    .map((c) => [c.id, c.start_frame, endFrame(c, fps)]);
}

function editIn(editType: DropEditType, over: Partial<Extract<EditOp, { kind: 'edit_in' }>> = {}) {
  return {
    kind: 'edit_in' as const,
    editType,
    track: 0,
    clip: incoming(),
    atFrame: 150,
    ...over,
  };
}

describe('the seven edit types — names and overlay geometry', () => {
  it('lists exactly the seven, in Resolve’s own overlay order', () => {
    expect(DROP_EDIT_TYPES.map((t) => t.type)).toEqual([
      'insert',
      'overwrite',
      'replace',
      'fit_to_fill',
      'place_on_top',
      'append',
      'ripple_overwrite',
    ]);
  });

  it('marks exactly the three target-taking types as needing a target', () => {
    expect(DROP_EDIT_TYPES.filter((t) => t.needsTarget).map((t) => t.type)).toEqual([
      'replace',
      'fit_to_fill',
      'ripple_overwrite',
    ]);
  });

  it('validates a wire value against the seven', () => {
    expect(isDropEditType('fit_to_fill')).toBe(true);
    expect(isDropEditType('slip')).toBe(false);
    expect(isDropEditType(3)).toBe(false);
  });

  it('resolves a pointer to its row by equal bands of the list’s height', () => {
    const rect = { top: 100, height: 350 }; // 50px per row
    expect(editTargetIndexAt(rect, 100)).toBe(0); // very top → Insert
    expect(editTargetIndexAt(rect, 149)).toBe(0);
    expect(editTargetIndexAt(rect, 150)).toBe(1); // Overwrite
    expect(editTargetIndexAt(rect, 449)).toBe(6); // last row → Ripple Overwrite
  });

  it('clamps outside the strip to its nearest end rather than losing the drag', () => {
    const rect = { top: 100, height: 350 };
    expect(editTargetIndexAt(rect, -400)).toBe(0);
    expect(editTargetIndexAt(rect, 9999)).toBe(6);
    // A zero-height rect (never laid out) must not divide by zero.
    expect(editTargetIndexAt({ top: 0, height: 0 }, 42)).toBe(0);
  });
});

describe('edit_in — insert', () => {
  it('splits the clip under the playhead and pushes everything after it down', () => {
    const after = applyOp(threeUp(), editIn('insert', { atFrame: 150 }));
    expect(layout(after)).toEqual([
      ['a', 0, 100],
      ['b', 100, 150], // b's left half, cut at the playhead
      ['new', 150, 210], // the 60-frame source, in the hole it made
      ['b·150', 210, 260], // b's right half, pushed down by 60
      ['c', 260, 360],
    ]);
  });

  it('at a clip boundary inserts without splitting anything', () => {
    const after = applyOp(threeUp(), editIn('insert', { atFrame: 100 }));
    expect(layout(after)).toEqual([
      ['a', 0, 100],
      ['new', 100, 160],
      ['b', 160, 260],
      ['c', 260, 360],
    ]);
  });

  it('is the ONE type that lengthens the timeline by exactly the source', () => {
    const before = threeUp();
    const after = applyOp(before, editIn('insert', { atFrame: 150 }));
    const end = (t: Timeline) => Math.max(...layout(t).map(([, , e]) => e));
    expect(end(after) - end(before)).toBe(60);
  });
});

describe('edit_in — overwrite', () => {
  it('writes over what was there and moves nothing else', () => {
    const after = applyOp(threeUp(), editIn('overwrite', { atFrame: 150 }));
    expect(layout(after)).toEqual([
      ['a', 0, 100],
      ['b', 100, 150], // trimmed back to the window's start
      ['new', 150, 210],
      // c's tail survives, its head eaten. It keeps its own id: a clip merely
      // trimmed at one end is still itself, and renaming it would drop the
      // user's selection and the Inspector's target on the floor. Only a clip
      // cut on BOTH sides yields a genuinely new right half (below).
      ['c', 210, 300],
    ]);
    const trimmed = after.tracks[0].clips.find((c) => c.id === 'c');
    expect(trimmed?.source_start).toBe(10); // resumes 10 frames into its file
    expect(trimmed?.duration).toBe(90);
  });

  it('removes a clip it swallows whole', () => {
    const short = tl([video([clip('a', { start_frame: 0, duration: 20, source_len: 20 }), clip('b', { start_frame: 40 })])]);
    const after = applyOp(short, editIn('overwrite', { atFrame: 0 }));
    expect(layout(after)).toEqual([
      ['new', 0, 60],
      ['b', 60, 140],
    ]);
  });

  it('splits a clip it lands entirely inside, leaving both ends', () => {
    const one = tl([video([clip('a', { start_frame: 0, duration: 300, source_len: 300 })])]);
    const after = applyOp(one, editIn('overwrite', { atFrame: 100 }));
    expect(layout(after)).toEqual([
      ['a', 0, 100],
      ['new', 100, 160],
      ['a·160', 160, 300],
    ]);
    // The surviving right half must point at the right footage, not just the
    // right frames: it resumes 160 source frames into the file.
    const right = after.tracks[0].clips.find((c) => c.id === 'a·160');
    expect(right?.source_start).toBe(160);
    expect(right?.duration).toBe(140);
  });

  it('leaves the timeline exactly as long when it overwrites into the middle', () => {
    const before = threeUp();
    const after = applyOp(before, editIn('overwrite', { atFrame: 150 }));
    const end = (t: Timeline) => Math.max(...layout(t).map(([, , e]) => e));
    expect(end(after)).toBe(end(before));
  });
});

describe('edit_in — replace', () => {
  it('takes the target’s slot exactly, re-cutting the source to fit', () => {
    const after = applyOp(threeUp(), editIn('replace', { atFrame: 150 }));
    expect(layout(after)).toEqual([
      ['a', 0, 100],
      ['new', 100, 200], // b's own start and its own exact 100-frame length
      ['c', 200, 300],
    ]);
    const placed = after.tracks[0].clips.find((c) => c.id === 'new');
    expect(placed?.duration).toBe(100); // re-cut UP from its 60-frame in/out
    expect(placed?.speed_points).toBeUndefined(); // re-cut, never retimed
  });

  it('is refused when the source is too short to cover the slot', () => {
    const op = editIn('replace', { atFrame: 150, clip: incoming({ duration: 60, source_len: 60 }) });
    const check = checkEditIn(threeUp(), op);
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/too short/);
    expect(applyOp(threeUp(), op)).toEqual(threeUp()); // and applies as a no-op
  });

  it('is refused with nothing under the playhead', () => {
    const gapped = tl([video([clip('a', { start_frame: 0 })])]);
    const check = checkEditIn(gapped, editIn('replace', { atFrame: 500 }));
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/needs a clip under the playhead/);
  });
});

describe('edit_in — fit to fill', () => {
  it('keeps the source’s full length and retimes it into the slot', () => {
    const after = applyOp(threeUp(), editIn('fit_to_fill', { atFrame: 150 }));
    expect(layout(after)).toEqual([
      ['a', 0, 100],
      ['new', 100, 200],
      ['c', 200, 300],
    ]);
    const placed = after.tracks[0].clips.find((c) => c.id === 'new');
    // The whole point: `duration` is untouched, the fit comes from the ramp.
    expect(placed?.duration).toBe(60);
    expect(placed?.speed_points).toEqual([{ source_frame: 0, speed: 0.6 }]);
    // …and it really is one flat D-236 segment that outputs the slot's length.
    expect(rampOutputSourceFrames(resolveSpeedSegments(placed!))).toBeCloseTo(100, 6);
  });

  it('speeds a long source UP rather than only slowing short ones down', () => {
    const after = applyOp(threeUp(), editIn('fit_to_fill', { atFrame: 150, clip: incoming({ duration: 400 }) }));
    const placed = after.tracks[0].clips.find((c) => c.id === 'new');
    expect(placed?.speed_points).toEqual([{ source_frame: 0, speed: 4 }]);
    expect(layout(after)).toEqual([
      ['a', 0, 100],
      ['new', 100, 200],
      ['c', 200, 300],
    ]);
  });

  it('is refused when the fit would need a speed outside the ramp’s range', () => {
    // 3000 source frames into a 100-frame slot is 30x — past MAX_SPEED (20).
    const op = editIn('fit_to_fill', { atFrame: 150, clip: incoming({ duration: 3000, source_len: 3000 }) });
    const check = checkEditIn(threeUp(), op);
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/speed outside/);
    expect(applyOp(threeUp(), op)).toEqual(threeUp());
  });
});

describe('edit_in — place on top', () => {
  it('creates a new topmost video track when there is nothing above', () => {
    const after = applyOp(threeUp(), editIn('place_on_top', { atFrame: 150 }));
    expect(after.tracks).toHaveLength(2);
    expect(after.tracks[0].kind).toBe('video');
    expect(layout(after, 0)).toEqual([['new', 150, 210]]);
    // …and disturbs nothing on the track it came from.
    expect(layout(after, 1)).toEqual(layout(threeUp(), 0));
  });

  it('reuses an existing track above when that track has room there', () => {
    const stacked = tl([video([clip('top', { start_frame: 0, duration: 50, source_len: 50 })]), video([clip('a', { start_frame: 0 })])]);
    const after = applyOp(stacked, editIn('place_on_top', { track: 1, atFrame: 150 }));
    expect(after.tracks).toHaveLength(2);
    expect(layout(after, 0)).toEqual([
      ['top', 0, 50],
      ['new', 150, 210],
    ]);
  });

  it('on an EMPTY timeline leaves the clip on a new top track over an empty one', () => {
    // Deliberate, not an accident of the empty case: this is what Resolve does
    // too — Place on Top onto an empty timeline puts the clip on V2 and leaves
    // V1 empty beneath it. Pinned so a future "tidy up the leftover track"
    // impulse has to argue with the reference first.
    const after = applyOp(tl([]), editIn('place_on_top', { atFrame: 0 }));
    expect(after.tracks).toHaveLength(2);
    expect(layout(after, 0)).toEqual([['new', 0, 60]]);
    expect(after.tracks[1].clips).toEqual([]);
  });

  it('makes a new top track rather than overlapping an occupied one', () => {
    const stacked = tl([video([clip('top', { start_frame: 100, duration: 200, source_len: 200 })]), video([clip('a', { start_frame: 0 })])]);
    const after = applyOp(stacked, editIn('place_on_top', { track: 1, atFrame: 150 }));
    expect(after.tracks).toHaveLength(3);
    expect(layout(after, 0)).toEqual([['new', 150, 210]]);
    expect(layout(after, 1)).toEqual([['top', 100, 300]]);
  });
});

describe('edit_in — append at end', () => {
  it('lands after the last edit on the track, ignoring the playhead entirely', () => {
    const atZero = applyOp(threeUp(), editIn('append', { atFrame: 0 }));
    const atMiddle = applyOp(threeUp(), editIn('append', { atFrame: 150 }));
    expect(layout(atZero)).toEqual(layout(atMiddle));
    expect(layout(atZero)).toEqual([
      ['a', 0, 100],
      ['b', 100, 200],
      ['c', 200, 300],
      ['new', 300, 360],
    ]);
  });

  it('appends onto a brand-new timeline by making the video track for it', () => {
    const after = applyOp(tl([]), editIn('append'));
    expect(after.tracks).toHaveLength(1);
    expect(layout(after)).toEqual([['new', 0, 60]]);
  });
});

describe('edit_in — ripple overwrite', () => {
  it('pulls everything in when the new clip is SHORTER than the one it replaces', () => {
    const after = applyOp(threeUp(), editIn('ripple_overwrite', { atFrame: 150 }));
    expect(layout(after)).toEqual([
      ['a', 0, 100],
      ['new', 100, 160], // 60 frames where b's 100 were
      ['c', 160, 260], // pulled in by the 40-frame difference — no gap
    ]);
  });

  it('pushes everything down when the new clip is LONGER', () => {
    const after = applyOp(threeUp(), editIn('ripple_overwrite', { atFrame: 150, clip: incoming({ duration: 180 }) }));
    expect(layout(after)).toEqual([
      ['a', 0, 100],
      ['new', 100, 280],
      ['c', 280, 380],
    ]);
  });

  it('is exactly an overwrite when the lengths happen to match', () => {
    const same = editIn('ripple_overwrite', { atFrame: 150, clip: incoming({ duration: 100 }) });
    expect(layout(applyOp(threeUp(), same))).toEqual([
      ['a', 0, 100],
      ['new', 100, 200],
      ['c', 200, 300],
    ]);
  });

  it('is refused with nothing under the playhead', () => {
    const check = checkEditIn(tl([video([clip('a', { start_frame: 0 })])]), editIn('ripple_overwrite', { atFrame: 500 }));
    expect(check.ok).toBe(false);
  });
});

describe('edit_in — shared preconditions and bookkeeping', () => {
  it('refuses every type on a locked track, as a real no-op', () => {
    const locked = tl([{ kind: 'video', locked: true, clips: [clip('a', { start_frame: 0 })] }]);
    for (const { type } of DROP_EDIT_TYPES) {
      const check = checkEditIn(locked, editIn(type, { atFrame: 50 }));
      expect(check.ok, type).toBe(false);
      expect(check.reason, type).toMatch(/locked/);
      expect(applyOp(locked, editIn(type, { atFrame: 50 })), type).toEqual(locked);
    }
  });

  it('refuses a zero-length source for every type', () => {
    const empty = incoming({ duration: 0 });
    for (const { type } of DROP_EDIT_TYPES) {
      expect(checkEditIn(threeUp(), editIn(type, { clip: empty })).ok, type).toBe(false);
    }
  });

  it('refuses a ripple across a sync-locked track’s straddling clip (B-033)', () => {
    const two = tl([
      video([clip('a', { start_frame: 0, duration: 300, source_len: 300 })]),
      { kind: 'audio', sync_locked: true, clips: [clip('m', { start_frame: 0, duration: 300, source_len: 300 })] },
    ]);
    expect(checkEditIn(two, editIn('insert', { atFrame: 150 })).ok).toBe(false);
    // …but the non-rippling types over the same straddle are perfectly fine.
    expect(checkEditIn(two, editIn('overwrite', { atFrame: 150 })).ok).toBe(true);
    expect(checkEditIn(two, editIn('place_on_top', { atFrame: 150 })).ok).toBe(true);
  });

  it('ripples a sync-locked track along with the destination on an insert', () => {
    const two = tl([
      video([clip('a', { start_frame: 0 }), clip('b', { start_frame: 100 })]),
      { kind: 'audio', sync_locked: true, clips: [clip('m', { start_frame: 100 })] },
    ]);
    const after = applyOp(two, editIn('insert', { atFrame: 100 }));
    expect(layout(after, 0)).toEqual([
      ['a', 0, 100],
      ['new', 100, 160],
      ['b', 160, 260],
    ]);
    expect(layout(after, 1)).toEqual([['m', 160, 260]]);
  });

  it('places a dropped source’s linked audio half alongside, as add_clip does', () => {
    const after = applyOp(
      threeUp(),
      editIn('overwrite', {
        atFrame: 150,
        clip: incoming({ link_group: 'lg-1' }),
        linkedAudio: incoming({ id: 'new-a', link_group: 'lg-1' }),
      }),
    );
    expect(after.tracks).toHaveLength(2);
    expect(after.tracks[1].kind).toBe('audio');
    expect(layout(after, 1)).toEqual([['new-a', 150, 210]]);
  });

  it('names its history entry for the EDIT TYPE, not just the clip', () => {
    const before = threeUp();
    expect(labelForOp(editIn('insert'), before)).toBe('Insert "new"');
    expect(labelForOp(editIn('ripple_overwrite'), before)).toBe('Ripple Overwrite "new"');
  });

  it('splits the check so the GUI can ask what it can actually answer mid-drag', () => {
    // `checkEditTarget` is the half that needs no source. It must NOT apply the
    // two length-dependent refusals — the overlay calls it while the HTML5
    // payload is still unreadable, and a version that answered the fuller
    // question against a placeholder clip left Replace and Fit to Fill greyed
    // out permanently (see `EditOverlay.dom.test.tsx` test 14).
    for (const { type } of DROP_EDIT_TYPES) {
      expect(checkEditTarget(threeUp(), type, 0, 150).ok, type).toBe(true);
    }
    // …and it still catches everything that does not depend on the source.
    expect(checkEditTarget(threeUp(), 'replace', 0, 900).ok).toBe(false);
    expect(checkEditTarget(tl([{ kind: 'video', locked: true, clips: [] }]), 'append', 0, 0).ok).toBe(false);

    // The full check is the same answer PLUS the source-dependent ones: this
    // exact call is refused only because the 60-frame source cannot cover the
    // 100-frame slot that `checkEditTarget` just said was there.
    const tooShort = editIn('replace', { atFrame: 150, clip: incoming({ duration: 60, source_len: 60 }) });
    expect(checkEditTarget(threeUp(), 'replace', 0, 150).ok).toBe(true);
    expect(checkEditIn(threeUp(), tooShort).ok).toBe(false);
  });

  it('gives every one of the seven a real, distinct outcome on one fixture', () => {
    // The whole feature in one assertion: seven drops of the same source at the
    // same frame must produce seven different timelines. If two of these ever
    // collapse together, one of them has silently stopped being its own edit.
    //
    // The WHOLE timeline, not just `layout` — Replace and Fit to Fill land the
    // same clip in the same slot on purpose, and differ only in HOW (a re-cut
    // `duration` vs. a `speed_points` ramp), which is exactly the distinction a
    // positions-only comparison would miss.
    const shapes = DROP_EDIT_TYPES.map(({ type }) => JSON.stringify(applyOp(threeUp(), editIn(type, { atFrame: 150 }))));
    expect(new Set(shapes).size).toBe(7);
  });
});

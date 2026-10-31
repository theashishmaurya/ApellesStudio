// @apelles/editor — D-432 P2: the pure half of the edit gestures (`editGesture.ts`).
// Every assertion is against the real `applyOp`, so a preview that disagrees
// with what the drop commits is a failure here, not on screen.
import { describe, expect, it } from 'vitest';
import { applyOp, type Clip, type Timeline } from './timeline';
import {
  editBrackets,
  editOpFor,
  editReadout,
  movingEdgeFrame,
  previewEdit,
  signedTimecode,
  snapFrame,
  snapTargets,
  type EditTarget,
} from './editGesture';

function clip(id: string, overrides: Partial<Clip> = {}): Clip {
  return {
    id,
    name: id,
    source_path: `/media/${id}.mov`,
    source_start: 30,
    duration: 90,
    source_len: 300,
    source_fps: 30,
    start_frame: 0,
    ...overrides,
  };
}

/** The harness's THREE_CLIPS fixture: a | b | c butted, 90 frames each at 30 fps,
 *  each with 30 frames of head handle and plenty of tail. */
function threeUp(): Timeline {
  return {
    id: 't',
    name: 'T',
    rate: { num: 30, den: 1 },
    tracks: [{ kind: 'video', clips: [clip('a'), clip('b', { start_frame: 90 }), clip('c', { start_frame: 180 })] }],
  } as Timeline;
}

const t = (mode: EditTarget['mode'], clipIdx: number, edge: 'start' | 'end'): EditTarget => ({ mode, track: 0, clip: clipIdx, edge });
const shiftOf = (p: ReturnType<typeof previewEdit>, id: string) => p.shifts.find((s) => s.id === id);

describe('previewEdit — what moves while the hand moves (B-345)', () => {
  it('a plain out-trim moves only that edge, by exactly the requested frames (B-344)', () => {
    const p = previewEdit(threeUp(), t('trim', 1, 'end'), -15);
    expect(p).toMatchObject({ delta: -15, limited: false });
    expect(shiftOf(p, 'b')).toMatchObject({ dStart: 0, dEnd: -15 });
    expect(shiftOf(p, 'c')).toBeUndefined();
  });

  it('a ripple out-trim moves every clip after it by the same delta, in the same preview', () => {
    const p = previewEdit(threeUp(), t('ripple', 1, 'end'), -15);
    expect(shiftOf(p, 'b')).toMatchObject({ dEnd: -15 });
    expect(shiftOf(p, 'c')).toMatchObject({ dStart: -15, dEnd: -15 });
  });

  it('a roll moves both sides of the cut and nothing else', () => {
    const p = previewEdit(threeUp(), t('roll', 0, 'end'), 15);
    expect(shiftOf(p, 'a')).toMatchObject({ dStart: 0, dEnd: 15 });
    expect(shiftOf(p, 'b')).toMatchObject({ dStart: 15, dEnd: 0 });
    expect(shiftOf(p, 'c')).toBeUndefined();
  });

  it('a roll grabbed on the incoming clip`s head is the same edit point', () => {
    const p = previewEdit(threeUp(), t('roll', 1, 'start'), 15);
    expect(shiftOf(p, 'a')).toMatchObject({ dEnd: 15 });
    expect(shiftOf(p, 'b')).toMatchObject({ dStart: 15 });
  });

  it('a slip leaves the clip in place and slides its source window', () => {
    const p = previewEdit(threeUp(), t('slip', 1, 'end'), 15);
    const b = shiftOf(p, 'b');
    expect(b).toMatchObject({ dStart: 0, dEnd: 0 });
    expect(b?.dSourceSecs).toBeCloseTo(0.5);
  });

  it('a slide moves the clip and both neighbours absorb it', () => {
    const p = previewEdit(threeUp(), t('slide', 1, 'end'), 15);
    expect(shiftOf(p, 'a')).toMatchObject({ dEnd: 15 });
    expect(shiftOf(p, 'b')).toMatchObject({ dStart: 15, dEnd: 15 });
    expect(shiftOf(p, 'c')).toMatchObject({ dStart: 15, dEnd: 0 });
  });

  it('clamps at a limit and says so: a plain out-trim cannot grow into its neighbour', () => {
    const p = previewEdit(threeUp(), t('trim', 1, 'end'), 10);
    expect(p).toMatchObject({ limited: true, delta: 0, shifts: [] });
  });

  it('clamps a roll at the incoming clip`s head handle (30 frames) and reports the limit', () => {
    const p = previewEdit(threeUp(), t('roll', 0, 'end'), -40);
    expect(p.delta).toBe(-30);
    expect(p.limited).toBe(true);
  });

  it('clamps a head trim that refuses outright past its handle to the furthest legal frame', () => {
    const tl = threeUp();
    tl.tracks[0].clips = [clip('a', { start_frame: 100 })];
    const p = previewEdit(tl, t('trim', 0, 'start'), -45);
    expect(p.delta).toBe(-30);
    expect(p.limited).toBe(true);
    expect(shiftOf(p, 'a')).toMatchObject({ dStart: -30, dEnd: 0 });
  });

  it('commits exactly what it previewed', () => {
    const tl = threeUp();
    for (const [target, d] of [
      [t('ripple', 1, 'end'), -15],
      [t('roll', 0, 'end'), 15],
      [t('slip', 1, 'end'), 15],
      [t('slide', 1, 'end'), 15],
    ] as const) {
      const p = previewEdit(tl, target, d);
      const op = editOpFor(tl, target, p.delta);
      expect(op).not.toBeNull();
      expect(applyOp(tl, op!)).toEqual(p.after);
    }
  });
});

describe('editBrackets — what each tool highlights (§5.1)', () => {
  it('trim/ripple: the pressed edge only', () => {
    expect(editBrackets(threeUp(), t('ripple', 1, 'end'))).toEqual([{ track: 0, clipId: 'b', frame: 180, side: 'out' }]);
  });
  it('roll: ][ on both sides of the cut', () => {
    expect(editBrackets(threeUp(), t('roll', 1, 'start'))).toEqual([
      { track: 0, clipId: 'a', frame: 90, side: 'out' },
      { track: 0, clipId: 'b', frame: 90, side: 'in' },
    ]);
  });
  it('slip: both edges of the one clip', () => {
    expect(editBrackets(threeUp(), t('slip', 1, 'end')).map((b) => [b.clipId, b.side])).toEqual([
      ['b', 'in'],
      ['b', 'out'],
    ]);
  });
  it('slide: the neighbours` inner edges', () => {
    expect(editBrackets(threeUp(), t('slide', 1, 'end')).map((b) => [b.clipId, b.side, b.frame])).toEqual([
      ['a', 'out', 90],
      ['c', 'in', 180],
    ]);
  });
});

describe('snapping', () => {
  it('snaps within the threshold and holds a snapped target ×1.5 further out', () => {
    expect(snapFrame(87, [90, 200], 4, null)).toEqual({ frame: 90, target: 90 });
    expect(snapFrame(84, [90, 200], 4, null)).toEqual({ frame: 84, target: null });
    expect(snapFrame(85, [90, 200], 4, 90)).toEqual({ frame: 90, target: 90 });
    expect(snapFrame(83, [90, 200], 4, 90)).toEqual({ frame: 83, target: null });
  });
  it('collects every other clip`s edges, plus the extras', () => {
    expect(snapTargets(threeUp(), { track: 0, clipId: 'b' }, [123])).toEqual([0, 90, 123, 180, 270]);
  });
  it('slip moves no edge, so it never snaps', () => {
    expect(movingEdgeFrame(threeUp(), t('slip', 1, 'end'))).toBeNull();
    expect(movingEdgeFrame(threeUp(), t('slide', 1, 'end'))).toBe(90);
  });
});

describe('editReadout', () => {
  it('shows the delta and the new duration for a trim, frames for a short roll, Limit at a clamp', () => {
    const tl = threeUp();
    expect(editReadout(previewEdit(tl, t('trim', 1, 'end'), -15), t('trim', 1, 'end'), 30)).toBe('−00:00:15 → 00:02:15');
    expect(editReadout(previewEdit(tl, t('roll', 0, 'end'), 12), t('roll', 0, 'end'), 30)).toBe('+12f');
    expect(editReadout(previewEdit(tl, t('roll', 0, 'end'), -40), t('roll', 0, 'end'), 30)).toBe('−00:01:00 · Limit');
    expect(signedTimecode(45, 30)).toBe('+00:01:15');
  });
});

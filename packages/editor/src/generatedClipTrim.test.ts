// @apelles/editor — B-338 / B-303: a generated clip (caption, title, adjustment)
// has no media to run out of, so it extends in BOTH directions with the
// ordinary trim ops, bounded only by its neighbours.
import { describe, expect, it } from 'vitest';

import {
  applyOp,
  checkTrim,
  endFrame,
  newAdjustmentClipFields,
  newCaptionClipFields,
  newTextClipFields,
  newTextLayer,
  type Clip,
  type NewClipFields,
  type Timeline,
} from './timeline';

const FPS = 24;

function placed(fields: NewClipFields, start: number, id: string): Clip {
  return { ...fields, id, start_frame: start } as Clip;
}

function textLayer() {
  const layer = newTextLayer({ content: 'Hello' });
  if ('error' in layer) throw new Error(layer.error);
  return layer;
}

function timelineOf(kind: 'video' | 'subtitle', clips: Clip[]): Timeline {
  return {
    id: 'tl',
    name: 'generated',
    rate: { num: FPS, den: 1 },
    tracks: [{ kind, clips, gain: 1, sync_locked: false }],
    markers: [],
  } as unknown as Timeline;
}

const caption = (start: number, dur: number, id = 'cue') =>
  placed(newCaptionClipFields('most', dur, id), start, id);
const title = (start: number, dur: number, id = 'ttl') =>
  placed(newTextClipFields(textLayer(), dur, 'Title'), start, id);

describe('B-338 — a caption cue lengthens with the ordinary trim ops', () => {
  it('end + extends it (it used to be refused as "cannot grow")', () => {
    const tl = timelineOf('subtitle', [caption(10, 4)]);
    expect(checkTrim(tl, 0, 0, 'end', 4, false, FPS).ok).toBe(true);
    const out = applyOp(tl, { kind: 'trim_end', track: 0, clip: 0, delta: 4 });
    const c = out.tracks[0].clips[0];
    expect(c.duration).toBe(8);
    expect(c.source_len).toBeGreaterThanOrEqual(c.source_start + c.duration);
  });

  it('start - pulls the head earlier and keeps source_start at 0', () => {
    const tl = timelineOf('subtitle', [caption(10, 4)]);
    const out = applyOp(tl, { kind: 'trim_start', track: 0, clip: 0, delta: -6 });
    const c = out.tracks[0].clips[0];
    expect([c.start_frame, c.duration, c.source_start]).toEqual([4, 10, 0]);
  });

  it('is still stopped by the neighbour on either side (D-054)', () => {
    const tl = timelineOf('subtitle', [caption(0, 10, 'a'), caption(10, 4, 'b'), caption(16, 6, 'c')]);
    const grown = applyOp(tl, { kind: 'trim_end', track: 0, clip: 1, delta: 100 });
    expect(endFrame(grown.tracks[0].clips[1], FPS)).toBe(16);
    const headed = applyOp(tl, { kind: 'trim_start', track: 0, clip: 1, delta: -100 });
    expect(headed.tracks[0].clips[1].start_frame).toBe(10);
    expect(checkTrim(tl, 0, 1, 'start', -3, false, FPS).ok).toBe(false);
  });

  it('shortening then lengthening round-trips', () => {
    const tl = timelineOf('subtitle', [caption(10, 12)]);
    const short = applyOp(tl, { kind: 'trim_end', track: 0, clip: 0, delta: -8 });
    const long = applyOp(short, { kind: 'trim_end', track: 0, clip: 0, delta: 20 });
    expect(long.tracks[0].clips[0].duration).toBe(24);
  });
});

describe('B-303 — a title extends both ways ("no earlier material" is gone)', () => {
  it('trim_start earlier lengthens it from the head', () => {
    const tl = timelineOf('video', [title(48, 72)]);
    expect(checkTrim(tl, 0, 0, 'start', -24, false, FPS).ok).toBe(true);
    const out = applyOp(tl, { kind: 'trim_start', track: 0, clip: 0, delta: -24 });
    const c = out.tracks[0].clips[0];
    expect([c.start_frame, c.duration, c.source_start]).toEqual([24, 96, 0]);
  });

  it('a head can shorten and grow back past its original start', () => {
    const tl = timelineOf('video', [title(48, 72)]);
    const shorter = applyOp(tl, { kind: 'trim_start', track: 0, clip: 0, delta: 30 });
    const back = applyOp(shorter, { kind: 'trim_start', track: 0, clip: 0, delta: -78 });
    const c = back.tracks[0].clips[0];
    expect([c.start_frame, c.duration, c.source_start]).toEqual([0, 120, 0]);
  });

  it('the ripple head trim and a roll between two titles work too', () => {
    const tl = timelineOf('video', [title(0, 48, 'a'), title(48, 48, 'b')]);
    const rolled = applyOp(tl, { kind: 'roll', track: 0, clip: 0, delta: -12 });
    const [a, b] = rolled.tracks[0].clips;
    expect([endFrame(a, FPS), b.start_frame, b.duration]).toEqual([36, 36, 60]);
    const rippled = applyOp(tl, { kind: 'trim_end', track: 0, clip: 1, delta: 24, ripple: true });
    expect(rippled.tracks[0].clips[1].duration).toBe(72);
  });

  it('an adjustment clip extends the same way', () => {
    const adj = placed(newAdjustmentClipFields({ kind: 'grade' } as never, 24, 'Adj'), 24, 'adj');
    const tl = timelineOf('video', [adj]);
    const out = applyOp(tl, { kind: 'trim_start', track: 0, clip: 0, delta: -10 });
    expect(out.tracks[0].clips[0].duration).toBe(34);
  });

  it('a project saved before the fix (source_len == duration) is covered too', () => {
    const old = title(48, 72);
    expect(old.source_len).toBe(72);
    const out = applyOp(timelineOf('video', [old]), { kind: 'trim_end', track: 0, clip: 0, delta: 240 });
    expect(out.tracks[0].clips[0].duration).toBe(312);
  });
});

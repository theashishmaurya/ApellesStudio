/**
 * @apelles/editor — duplicating a clip (B-394).
 *
 * **The gap.** Apelles could duplicate a timeline, a Motion scene and a Motion
 * layer, but not a clip, so Cmd/Ctrl+D on the timeline landed on nothing and
 * the only way to copy a clip was to read its fields and re-place it by hand.
 *
 * **What is worth asserting.** Not "a second clip exists" — that is trivially
 * true of a bad implementation too. The things that make a duplicate usable:
 * it carries the per-clip work (transform, keyframes, fades, volume) that took
 * someone real time; it lands in real space rather than on top of a neighbour;
 * and an A/V pair duplicates as a PAIR, linked to each other rather than to the
 * originals, because duplicating one half of a link silently desynchronises it.
 */
import { describe, expect, it } from 'vitest';

import { applyOp, endFrame, type Clip, type Timeline } from './timeline';

const FPS = 25;

const clip = (over: Partial<Clip> = {}): Clip =>
  ({
    id: 'c1',
    name: 'shot.mp4',
    source_path: '/v/shot.mp4',
    source_start: 10,
    duration: 50,
    source_len: 2000,
    source_fps: 25,
    start_frame: 100,
    ...over,
  }) as Clip;

// An explicit rate, so the reducer's own fps and this file's assertions agree
// (without one, `timelineFps` falls back to DEFAULT_FPS and the two differ).
const tl = (clips: Clip[], extra: Partial<Timeline> = {}): Timeline => ({
  id: 't',
  name: 't',
  rate: { num: FPS, den: 1 },
  tracks: [{ kind: 'video', clips, gain: 1, sync_locked: true }],
  ...extra,
});

const dup = (t: Timeline, track = 0, c = 0) =>
  applyOp(t, { kind: 'duplicate_clip', track, clip: c } as never);

describe('duplicate_clip (B-394)', () => {
  it('puts the copy immediately after the original, with no gap and no overlap', () => {
    const after = dup(tl([clip()]));
    const [a, b] = after.tracks[0].clips;
    expect(after.tracks[0].clips).toHaveLength(2);
    expect(b.start_frame).toBe(endFrame(a, FPS));
    expect(endFrame(b, FPS) - b.start_frame).toBe(endFrame(a, FPS) - a.start_frame);
  });

  it('pushes a later neighbour out of the way rather than landing on top of it', () => {
    const later = clip({ id: 'c2', start_frame: 200, name: 'next.mp4' });
    const after = dup(tl([clip(), later]));
    const names = after.tracks[0].clips.map((c) => c.id);
    expect(names).toEqual(['c1', 'c1·copy·100', 'c2']);
    const copy = after.tracks[0].clips[1];
    const moved = after.tracks[0].clips[2];
    expect(moved.start_frame).toBeGreaterThanOrEqual(endFrame(copy, FPS));
  });

  it('carries the per-clip work across — the whole point of a duplicate', () => {
    const rich = clip({
      position_x: 0.2,
      scale: 1.4,
      volume: 0.6,
      fade_in_frames: 8,
      keyframes: [{ frame: 0, params: { scale: 1 } }],
    } as Partial<Clip>);
    const copy = dup(tl([rich])).tracks[0].clips[1] as unknown as Record<string, unknown>;
    expect(copy.position_x).toBe(0.2);
    expect(copy.scale).toBe(1.4);
    expect(copy.volume).toBe(0.6);
    expect(copy.fade_in_frames).toBe(8);
    expect(copy.keyframes).toEqual([{ frame: 0, params: { scale: 1 } }]);
  });

  it('gives the copy its own identity, so nothing addresses the two as one clip', () => {
    const after = dup(tl([clip()]));
    const [a, b] = after.tracks[0].clips;
    expect(b.id).not.toBe(a.id);
  });

  it('refuses on a locked track, leaving the timeline untouched', () => {
    const locked = tl([clip()]);
    locked.tracks[0].locked = true;
    const after = dup(locked);
    expect(after).toBe(locked);
    expect(after.tracks[0].clips).toHaveLength(1);
  });

  it('duplicates an A/V pair together, and the copies are linked to EACH OTHER', () => {
    const v = clip({ link_group: 'lg-1' });
    const a = clip({ id: 'c1a', link_group: 'lg-1', name: 'shot.mp4 (audio)' });
    const t: Timeline = {
      id: 't',
      name: 't',
      rate: { num: FPS, den: 1 },
      tracks: [
        { kind: 'video', clips: [v], gain: 1, sync_locked: true },
        { kind: 'audio', clips: [a], gain: 1, sync_locked: true },
      ],
    };
    const after = dup(t);
    expect(after.tracks[0].clips).toHaveLength(2);
    expect(after.tracks[1].clips).toHaveLength(2);
    const vCopy = after.tracks[0].clips[1];
    const aCopy = after.tracks[1].clips[1];
    expect(vCopy.link_group).toBe(aCopy.link_group);
    expect(vCopy.link_group).not.toBe('lg-1');
    expect(after.tracks[0].clips[0].link_group).toBe('lg-1');
    expect(vCopy.start_frame).toBe(aCopy.start_frame);
  });
});

/**
 * @apelles/editor — the target track (D-440): one flag on at most one track,
 * set and cleared by `set_target_track`, carried by its track through a
 * reorder, dropped with a removed track, and read by `destinationTrack` (where
 * an edit that names no track lands) when its kind fits the source.
 */
import { describe, expect, it } from 'vitest';

import { applyOp, destinationTrack, labelForOp, targetTrackIndex, type Timeline } from './timeline';
import { listTracks, targetTrackArgs } from './trackOps';

function tl(): Timeline {
  return {
    id: 't',
    name: 't',
    rate: { num: 24, den: 1 },
    tracks: [
      { kind: 'video', clips: [] },
      { kind: 'video', clips: [] },
      { kind: 'audio', clips: [] },
    ],
  } as unknown as Timeline;
}

describe('set_target_track (D-440)', () => {
  it('targets one track and clears every other', () => {
    const a = applyOp(tl(), { kind: 'set_target_track', track: 1 });
    expect(a.tracks.map((t) => !!t.target)).toEqual([false, true, false]);
    expect(targetTrackIndex(a)).toBe(1);
    const b = applyOp(a, { kind: 'set_target_track', track: 2 });
    expect(b.tracks.map((t) => !!t.target)).toEqual([false, false, true]);
  });

  it('never stores false: an untargeted track keeps no key', () => {
    const a = applyOp(applyOp(tl(), { kind: 'set_target_track', track: 0 }), { kind: 'set_target_track', track: 2 });
    expect('target' in a.tracks[0]).toBe(false);
    expect('target' in a.tracks[1]).toBe(false);
  });

  it('null clears the target', () => {
    const a = applyOp(applyOp(tl(), { kind: 'set_target_track', track: 1 }), { kind: 'set_target_track', track: null });
    expect(targetTrackIndex(a)).toBeNull();
    expect(a.tracks.every((t) => !('target' in t))).toBe(true);
  });

  it('is a no-op (same object) for an out-of-range track or no change', () => {
    const base = applyOp(tl(), { kind: 'set_target_track', track: 1 });
    expect(applyOp(base, { kind: 'set_target_track', track: 9 })).toBe(base);
    expect(applyOp(base, { kind: 'set_target_track', track: 1 })).toBe(base);
    const none = tl();
    expect(applyOp(none, { kind: 'set_target_track', track: null })).toBe(none);
  });

  it('the flag follows its track through a reorder and leaves with a removed track', () => {
    const a = applyOp(tl(), { kind: 'set_target_track', track: 0 });
    const moved = applyOp(a, { kind: 'move_track', from: 0, to: 1 });
    expect(targetTrackIndex(moved)).toBe(1);
    const removed = applyOp(moved, { kind: 'remove_track', track: 1 });
    expect(targetTrackIndex(removed)).toBeNull();
  });

  it('has an undo label', () => {
    expect(labelForOp({ kind: 'set_target_track', track: 0 }, tl())).toBe('Target track 1');
    expect(labelForOp({ kind: 'set_target_track', track: null }, tl())).toBe('Clear the target track');
  });
});

describe('destinationTrack (D-440)', () => {
  it('is the fallback with no target', () => {
    expect(destinationTrack(tl(), 'video', 0)).toBe(0);
  });

  it('is the target when its kind fits the source', () => {
    const v = applyOp(tl(), { kind: 'set_target_track', track: 1 });
    expect(destinationTrack(v, 'video', 0)).toBe(1);
    const a = applyOp(tl(), { kind: 'set_target_track', track: 2 });
    expect(destinationTrack(a, 'audio', 0)).toBe(2);
  });

  it('falls back when the target does not fit (picture onto an audio target, audio onto a video one)', () => {
    const a = applyOp(tl(), { kind: 'set_target_track', track: 2 });
    expect(destinationTrack(a, 'video', 0)).toBe(0);
    const v = applyOp(tl(), { kind: 'set_target_track', track: 1 });
    expect(destinationTrack(v, 'audio', 0)).toBe(0);
  });
});

describe('editor_set_target_track arguments and the track list', () => {
  it('accepts an in-range index or null, and refuses anything else', () => {
    expect(targetTrackArgs(tl(), { track: 2 })).toEqual({ track: 2 });
    expect(targetTrackArgs(tl(), { track: null })).toEqual({ track: null });
    expect(targetTrackArgs(tl(), { track: 3 })).toHaveProperty('error');
    expect(targetTrackArgs(tl(), { track: '1' })).toHaveProperty('error');
    expect(targetTrackArgs(tl(), {})).toHaveProperty('error');
  });

  it('editor_list_tracks marks only the target', () => {
    const a = applyOp(tl(), { kind: 'set_target_track', track: 1 });
    const rows = (listTracks(a) as { tracks: Array<{ target?: boolean }> }).tracks;
    expect(rows.map((r) => r.target ?? false)).toEqual([false, true, false]);
    expect('target' in rows[0]).toBe(false);
  });
});

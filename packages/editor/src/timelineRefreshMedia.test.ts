/**
 * timelineRefreshMedia.test.ts — D-260's `refresh_media` op.
 *
 * The Edit-side half of "auto re-render, auto-replace": a source file was
 * replaced in place (a Motion scene re-rendered to its fixed per-scene path),
 * so every clip already reading it re-reads the new file's real length and
 * rate. Its own file rather than a block inside `timeline.test.ts` because it
 * is one feature with several distinct properties to pin — most importantly the
 * one that is easy to lose in a refactor: **a same-length re-render must change
 * nothing at all**, so the common case pushes no undo entry.
 */
import { describe, it, expect } from 'vitest';

import { applyOp, labelForOp, type Clip, type Timeline } from './timeline';

const RENDER = '/p/.chroma/motion/renders/hook.mp4';

function clip(id: string, overrides: Partial<Clip> = {}): Clip {
  return {
    id,
    name: id,
    source_path: RENDER,
    media_id: 'm1',
    source_start: 0,
    duration: 100,
    source_len: 100,
    source_fps: 30,
    start_frame: 0,
    ...overrides,
  };
}

function tl(tracks: Clip[][]): Timeline {
  return {
    id: 't1',
    name: 'Timeline',
    tracks: tracks.map((clips) => ({ kind: 'video' as const, clips })),
  };
}

const refresh = (source_len: number, source_fps: number | undefined = 30) =>
  ({ kind: 'refresh_media', media_id: 'm1', source_path: RENDER, source_len, source_fps }) as const;

describe('refresh_media (D-260)', () => {
  it('is a no-op — same object reference — when the re-render is the same length', () => {
    // THE headline property. A Motion scene re-rendered without a duration
    // change must leave the timeline byte-identical and push no undo entry
    // (`timelineStore.applyOp` short-circuits on `after === before`). The
    // picture still updates: the file on disk changed, and both Edit engines
    // read the file.
    const before = tl([[clip('a'), clip('b', { start_frame: 100 })]]);
    expect(applyOp(before, refresh(100))).toBe(before);
  });

  it('pushes the new length and rate into every clip reading that file', () => {
    const before = tl([[clip('a'), clip('b', { start_frame: 200 })]]);
    const after = applyOp(before, refresh(240, 60));
    expect(after).not.toBe(before);
    for (const c of after.tracks[0].clips) {
      expect(c.source_len).toBe(240);
      expect(c.source_fps).toBe(60);
    }
  });

  it('reaches clips on every track, and leaves clips on other media alone', () => {
    const other = clip('x', { media_id: 'm2', source_path: '/footage.mov', source_len: 100 });
    const before = tl([[clip('a'), other], [clip('c')]]);
    const after = applyOp(before, refresh(240));
    expect(after.tracks[0].clips[0].source_len).toBe(240);
    expect(after.tracks[1].clips[0].source_len).toBe(240);
    expect(after.tracks[0].clips[1]).toEqual(other); // untouched
  });

  it('matches a pre-pool clip (no media_id) by source_path', () => {
    const before = tl([[clip('a', { media_id: undefined })]]);
    expect(applyOp(before, refresh(240)).tracks[0].clips[0].source_len).toBe(240);
  });

  it('does not touch a clip bound to a different pool item at the same path', () => {
    // `media_id` is the stronger link and wins when present — two pool items
    // can legitimately reference one file.
    const before = tl([[clip('a', { media_id: 'm2' })]]);
    expect(applyOp(before, refresh(240))).toBe(before);
  });

  it('never changes media_id or source_path — nothing is being swapped', () => {
    const before = tl([[clip('a')]]);
    const after = applyOp(before, refresh(240));
    expect(after.tracks[0].clips[0].media_id).toBe('m1');
    expect(after.tracks[0].clips[0].source_path).toBe(RENDER);
  });

  it('preserves every unrelated field — position, transform, keyframes, fades', () => {
    const rich = clip('a', {
      start_frame: 40,
      opacity: 0.8,
      position_x: 0.25,
      scale: 1.4,
      rotation: 5,
      crop_left: 0.1,
      chroma_keyframes: [{ frame: 10, params: { scale: 1.5 } }],
      fade_in_frames: 8,
      fade_out_frames: 12,
      link_group: 'g1',
    });
    const after = applyOp(tl([[rich]]), refresh(240)).tracks[0].clips[0];
    expect(after.start_frame).toBe(40);
    expect(after.opacity).toBe(0.8);
    expect(after.position_x).toBe(0.25);
    expect(after.scale).toBe(1.4);
    expect(after.rotation).toBe(5);
    expect(after.crop_left).toBe(0.1);
    expect(after.chroma_keyframes).toEqual([{ frame: 10, params: { scale: 1.5 } }]);
    expect(after.fade_in_frames).toBe(8);
    expect(after.fade_out_frames).toBe(12);
    expect(after.link_group).toBe('g1');
  });

  describe('a SHORTER re-render re-clamps exactly as swap_media does (D-195)', () => {
    it('preserves source_start and shrinks duration when the window overruns', () => {
      const before = tl([[clip('a', { source_start: 10, duration: 90, source_len: 100 })]]);
      const c = applyOp(before, refresh(60)).tracks[0].clips[0];
      expect(c.source_start).toBe(10); // still inside the new source — preserved
      expect(c.duration).toBe(50); // 60 - 10, shrunk to what remains
      expect(c.start_frame).toBe(0); // never moves; a gap after it is allowed
    });

    it('pins source_start back to the last frame when it no longer fits', () => {
      const before = tl([[clip('a', { source_start: 80, duration: 20, source_len: 100 })]]);
      const c = applyOp(before, refresh(24)).tracks[0].clips[0];
      expect(c.source_start).toBe(23);
      expect(c.duration).toBe(1);
    });

    it('a LONGER re-render never grows a clip — only its ceiling moves', () => {
      const before = tl([[clip('a', { source_start: 10, duration: 50, source_len: 100 })]]);
      const c = applyOp(before, refresh(500)).tracks[0].clips[0];
      expect(c.source_start).toBe(10);
      expect(c.duration).toBe(50);
      expect(c.source_len).toBe(500);
    });
  });

  it('overwrites source_fps even to undefined — an unprobed source has no rate', () => {
    // Keeping the old rate would be the B-075/B-077 class of silent wrongness:
    // the number would describe a render this clip no longer points at.
    const before = tl([[clip('a')]]);
    // Written out rather than via `refresh()` on purpose: that helper's own
    // default parameter would swallow an explicitly-passed `undefined`, which
    // is exactly the value under test.
    const after = applyOp(before, {
      kind: 'refresh_media',
      media_id: 'm1',
      source_path: RENDER,
      source_len: 100,
      source_fps: undefined,
    });
    expect(after.tracks[0].clips[0].source_fps).toBeUndefined();
  });

  it('skips a locked track entirely', () => {
    const before: Timeline = {
      id: 't1',
      name: 'T',
      tracks: [
        { kind: 'video', clips: [clip('a')], locked: true },
        { kind: 'video', clips: [clip('b')] },
      ],
    };
    const after = applyOp(before, refresh(240));
    expect(after.tracks[0].clips[0].source_len).toBe(100); // locked — untouched
    expect(after.tracks[1].clips[0].source_len).toBe(240);
  });

  it('refuses a non-positive length — that means "unprobed", not "zero frames"', () => {
    // Acting on it would clamp every affected clip to a single frame. Leaving
    // the trim ceiling stale is strictly better: the picture updates from the
    // file either way.
    const before = tl([[clip('a', { source_start: 10, duration: 50 })]]);
    expect(applyOp(before, refresh(0))).toBe(before);
    expect(applyOp(before, refresh(-1))).toBe(before);
  });

  it('is a no-op when nothing on the timeline reads that file', () => {
    const before = tl([[clip('a', { media_id: 'm9', source_path: '/other.mov' })]]);
    expect(applyOp(before, refresh(240))).toBe(before);
  });

  it('labels the undo entry with the FILE, since it has no single clip to name', () => {
    expect(labelForOp(refresh(240), tl([[clip('a')]]))).toBe('Refresh hook.mp4');
  });
});

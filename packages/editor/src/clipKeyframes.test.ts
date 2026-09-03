// @chroma/editor — unit tests for `clipKeyframes.ts` (D-090): the clip
// transform keyframe CRUD used by `TimelinePane.tsx`'s transform popover.
import { describe, expect, it } from 'vitest';
import { clearClipKeyframes, clipSourceFrame, removeClipKeyframe, upsertClipKeyframe } from './clipKeyframes';

describe('upsertClipKeyframe', () => {
  it('adds a new keyframe to an empty/undefined array', () => {
    const out = upsertClipKeyframe(undefined, 10, { opacity: 0.5 });
    expect(out).toEqual([{ frame: 10, params: { opacity: 0.5 } }]);
  });

  it('replaces an existing keyframe at the same frame rather than duplicating', () => {
    const existing = [{ frame: 10, params: { opacity: 0.5 } }];
    const out = upsertClipKeyframe(existing, 10, { opacity: 0.9 });
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ frame: 10, params: { opacity: 0.9 } });
  });

  it('keeps the array frame-sorted regardless of insertion order', () => {
    let kfs = upsertClipKeyframe(undefined, 30, { opacity: 1 });
    kfs = upsertClipKeyframe(kfs, 10, { opacity: 0 });
    kfs = upsertClipKeyframe(kfs, 20, { opacity: 0.5 });
    expect(kfs.map((k) => k.frame)).toEqual([10, 20, 30]);
  });

  it('rounds and clamps a negative frame to 0', () => {
    const out = upsertClipKeyframe(undefined, -5.4, { opacity: 1 });
    expect(out[0].frame).toBe(0);
  });
});

describe('removeClipKeyframe', () => {
  it('removes the keyframe at the given frame, leaving the rest', () => {
    const existing = [{ frame: 10, params: {} }, { frame: 20, params: {} }];
    const out = removeClipKeyframe(existing, 10);
    expect(out).toEqual([{ frame: 20, params: {} }]);
  });

  it('returns undefined (not an empty array) when the last keyframe is removed', () => {
    const existing = [{ frame: 10, params: {} }];
    expect(removeClipKeyframe(existing, 10)).toBeUndefined();
  });

  it('is a no-op shape-wise for a frame that has no keyframe', () => {
    const existing = [{ frame: 10, params: { opacity: 1 } }];
    expect(removeClipKeyframe(existing, 99)).toEqual(existing);
  });
});

describe('clearClipKeyframes', () => {
  it('always returns undefined', () => {
    expect(clearClipKeyframes()).toBeUndefined();
  });
});

describe('clipSourceFrame', () => {
  it('maps the timeline playhead into the clip\'s own source-frame space', () => {
    // clip starts at timeline frame 100, sourced from source_start 20
    const clip = { source_start: 20, start_frame: 100, source_len: 1000 };
    expect(clipSourceFrame(clip, 150)).toBe(70); // 20 + (150 - 100)
  });

  it('clamps to 0 when the playhead sits before the clip', () => {
    const clip = { source_start: 20, start_frame: 100, source_len: 1000 };
    expect(clipSourceFrame(clip, 0)).toBe(0);
  });

  it('clamps to source_len - 1 when the playhead sits past the clip', () => {
    const clip = { source_start: 0, start_frame: 0, source_len: 50 };
    expect(clipSourceFrame(clip, 10000)).toBe(49);
  });
});

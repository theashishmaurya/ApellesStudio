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
    expect(clipSourceFrame(clip, 150, 24)).toBe(70); // 20 + (150 - 100)
  });

  it('clamps to 0 when the playhead sits before the clip', () => {
    const clip = { source_start: 20, start_frame: 100, source_len: 1000 };
    expect(clipSourceFrame(clip, 0, 24)).toBe(0);
  });

  it('clamps to source_len - 1 when the playhead sits past the clip', () => {
    const clip = { source_start: 0, start_frame: 0, source_len: 50 };
    expect(clipSourceFrame(clip, 10000, 24)).toBe(49);
  });

  // B-079 — a clip whose native rate differs from the project's must convert
  // the TIMELINE-frame offset into the clip's own SOURCE frames via
  // `source_fps`, exactly like `Track::clip_at`'s now-fixed Rust formula
  // (fixed in the SAME change per that bug's own doc comment above, and per
  // `docs/BUGS.md`'s B-079 entry — this function must never be fixed alone).
  describe('B-079 — mixed native-fps clips', () => {
    it('converts the timeline-frame offset through source_fps, not a 1:1 subtraction', () => {
      // A 48fps clip on a 24fps timeline: every 1 timeline frame the
      // playhead advances is 2 of the clip's own source frames.
      const clip = { source_start: 0, start_frame: 0, source_len: 1000, source_fps: 48 };
      expect(clipSourceFrame(clip, 10, 24)).toBe(20); // 0 + (10 timeline frames * 48/24)
    });

    it('is the identity conversion when source_fps equals the timeline fps', () => {
      const clip = { source_start: 20, start_frame: 100, source_len: 1000, source_fps: 24 };
      expect(clipSourceFrame(clip, 150, 24)).toBe(70);
    });

    it('falls back to a 1:1 ratio when source_fps is absent (pre-B-075 clip)', () => {
      const clip = { source_start: 20, start_frame: 100, source_len: 1000 };
      expect(clipSourceFrame(clip, 150, 24)).toBe(70);
    });
  });
});

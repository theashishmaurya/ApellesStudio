// @chroma/editor — unit tests for `clipKeyframes.ts` (D-090): the clip
// transform keyframe CRUD used by the Inspector's transform rows, plus
// D-208's per-property helpers and D-209's on-canvas box resolution.
import { describe, expect, it } from 'vitest';
import {
  adjacentParamKeyframeFrame,
  clearClipKeyframes,
  clipSourceFrame,
  clipTimelineFrame,
  hasParamKeyframes,
  mergeClipKeyframeParams,
  paramKeyframeFrames,
  paramValueAt,
  removeClipKeyframe,
  removeClipKeyframeParam,
  resolveClipBoxTransform,
  type ClipKeyframe,
} from './clipKeyframes';

describe('mergeClipKeyframeParams', () => {
  it('adds a new keyframe to an empty/undefined array', () => {
    const out = mergeClipKeyframeParams(undefined, 10, { opacity: 0.5 });
    expect(out).toEqual([{ frame: 10, params: { opacity: 0.5 } }]);
  });

  it('updates a param in the existing keyframe at that frame rather than duplicating it', () => {
    const existing = [{ frame: 10, params: { opacity: 0.5 } }];
    const out = mergeClipKeyframeParams(existing, 10, { opacity: 0.9 });
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ frame: 10, params: { opacity: 0.9 } });
  });

  // D-208 — the whole reason this replaced `upsertClipKeyframe`: writing one
  // property must never delete another property's key at the same frame.
  it('MERGES into an existing keyframe, keeping params it does not name', () => {
    const existing = [{ frame: 10, params: { opacity: 0.5, scale: 2 } }];
    const out = mergeClipKeyframeParams(existing, 10, { scale: 3 });
    expect(out).toEqual([{ frame: 10, params: { opacity: 0.5, scale: 3 } }]);
  });

  it('never mutates the array or the params object it was given', () => {
    const existing: ClipKeyframe[] = [{ frame: 10, params: { opacity: 0.5 } }];
    mergeClipKeyframeParams(existing, 10, { scale: 3 });
    expect(existing).toEqual([{ frame: 10, params: { opacity: 0.5 } }]);
  });

  it('keeps the array frame-sorted regardless of insertion order', () => {
    let kfs = mergeClipKeyframeParams(undefined, 30, { opacity: 1 });
    kfs = mergeClipKeyframeParams(kfs, 10, { opacity: 0 });
    kfs = mergeClipKeyframeParams(kfs, 20, { opacity: 0.5 });
    expect(kfs.map((k) => k.frame)).toEqual([10, 20, 30]);
  });

  it('rounds and clamps a negative frame to 0', () => {
    const out = mergeClipKeyframeParams(undefined, -5.4, { opacity: 1 });
    expect(out[0].frame).toBe(0);
  });
});

// --------------------------------------------------------------------------- //
// D-208 — per-property keyframing
// --------------------------------------------------------------------------- //

/** Three keys naming three different param subsets — the shape per-property
 *  keyframing actually produces, and the one the pre-D-208 code could not
 *  represent. */
const MIXED: ClipKeyframe[] = [
  { frame: 0, params: { scale: 1 } },
  { frame: 50, params: { opacity: 0.5 } },
  { frame: 100, params: { scale: 2 } },
];

describe('hasParamKeyframes / paramKeyframeFrames', () => {
  it('reports only the params a key actually defines', () => {
    expect(hasParamKeyframes(MIXED, 'scale')).toBe(true);
    expect(hasParamKeyframes(MIXED, 'opacity')).toBe(true);
    expect(hasParamKeyframes(MIXED, 'rotation')).toBe(false);
    expect(hasParamKeyframes(undefined, 'scale')).toBe(false);
  });

  it('lists each param\'s own frames, ascending, ignoring the others', () => {
    expect(paramKeyframeFrames(MIXED, 'scale')).toEqual([0, 100]);
    expect(paramKeyframeFrames(MIXED, 'opacity')).toEqual([50]);
    expect(paramKeyframeFrames(MIXED, 'rotation')).toEqual([]);
  });
});

describe('adjacentParamKeyframeFrame', () => {
  it('walks only that param\'s own keys, skipping another param\'s', () => {
    // frame 50 holds an OPACITY key — invisible to scale's nav.
    expect(adjacentParamKeyframeFrame(MIXED, 'scale', 50, -1)).toBe(0);
    expect(adjacentParamKeyframeFrame(MIXED, 'scale', 50, 1)).toBe(100);
  });

  it('is strict, so repeated presses really move off the key under the playhead', () => {
    expect(adjacentParamKeyframeFrame(MIXED, 'scale', 0, -1)).toBeNull();
    expect(adjacentParamKeyframeFrame(MIXED, 'scale', 0, 1)).toBe(100);
    expect(adjacentParamKeyframeFrame(MIXED, 'scale', 100, 1)).toBeNull();
  });

  it('is null in both directions for a param with no keys at all', () => {
    expect(adjacentParamKeyframeFrame(MIXED, 'rotation', 50, -1)).toBeNull();
    expect(adjacentParamKeyframeFrame(MIXED, 'rotation', 50, 1)).toBeNull();
  });
});

describe('removeClipKeyframeParam', () => {
  it('drops that param everywhere and leaves every other param\'s keys intact', () => {
    expect(removeClipKeyframeParam(MIXED, 'scale')).toEqual([{ frame: 50, params: { opacity: 0.5 } }]);
  });

  it('keeps a shared key alive when only one of its params is removed', () => {
    const kfs = [{ frame: 10, params: { opacity: 1, scale: 2 } }];
    expect(removeClipKeyframeParam(kfs, 'scale')).toEqual([{ frame: 10, params: { opacity: 1 } }]);
  });

  it('returns undefined (fully static again) when the last param is removed', () => {
    const kfs = [{ frame: 10, params: { scale: 2 } }];
    expect(removeClipKeyframeParam(kfs, 'scale')).toBeUndefined();
  });

  it('is a no-op for a param that was never keyed', () => {
    expect(removeClipKeyframeParam(MIXED, 'rotation')).toEqual(MIXED);
  });
});

describe('paramValueAt', () => {
  // The TS mirror of the Rust `interpolate_param` test of the same name —
  // both must agree, or the Inspector reports a value the preview isn't
  // rendering (B-094's exact failure mode).
  it('interpolates across only that param\'s own keys, ignoring an unrelated one between them', () => {
    expect(paramValueAt(MIXED, 'scale', 25, 99)).toBe(1.25);
    expect(paramValueAt(MIXED, 'scale', 50, 99)).toBe(1.5);
    expect(paramValueAt(MIXED, 'scale', 75, 99)).toBe(1.75);
  });

  it('holds a single-key param flat everywhere', () => {
    for (const f of [0, 25, 50, 75, 100, 999]) {
      expect(paramValueAt(MIXED, 'opacity', f, 99)).toBe(0.5);
    }
  });

  it('clamps outside that param\'s own keyed range', () => {
    expect(paramValueAt(MIXED, 'scale', -10, 99)).toBe(1);
    expect(paramValueAt(MIXED, 'scale', 500, 99)).toBe(2);
  });

  it('falls back to the static value for a param no key defines', () => {
    expect(paramValueAt(MIXED, 'rotation', 50, 42)).toBe(42);
    expect(paramValueAt(undefined, 'scale', 50, 42)).toBe(42);
  });

  it('takes the shortest arc for rotation, matching the Rust lerp', () => {
    const kfs = [
      { frame: 0, params: { rotation: 350 } },
      { frame: 100, params: { rotation: 10 } },
    ];
    // 350 -> 10 is +20 the short way; halfway is 360 (i.e. 0), never 180.
    expect(paramValueAt(kfs, 'rotation', 50, 0)).toBe(360);
  });

  it('falls back to the static value rather than emitting NaN for a non-numeric key', () => {
    const kfs = [{ frame: 0, params: { scale: 'wat' } }];
    expect(paramValueAt(kfs, 'scale', 0, 1.5)).toBe(1.5);
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

describe('clipTimelineFrame (D-208)', () => {
  it('round-trips clipSourceFrame for a playhead inside the clip', () => {
    const clip = { source_start: 20, start_frame: 100, source_len: 1000, source_fps: 24 };
    const src = clipSourceFrame(clip, 150, 24);
    expect(clipTimelineFrame(clip, src, 24)).toBe(150);
  });

  it('converts through source_fps for a mixed-native-fps clip (B-079)', () => {
    // A 48fps clip on a 24fps timeline: 20 of its own source frames past its
    // in-point is 10 timeline frames past its start.
    const clip = { source_start: 0, start_frame: 0, source_fps: 48 };
    expect(clipTimelineFrame(clip, 20, 24)).toBe(10);
  });

  it('is a plain offset when source_fps is absent', () => {
    const clip = { source_start: 20, start_frame: 100 };
    expect(clipTimelineFrame(clip, 70, 24)).toBe(150);
  });
});

// --------------------------------------------------------------------------- //
// D-209 / B-093 — the on-canvas box's transform
// --------------------------------------------------------------------------- //

describe('resolveClipBoxTransform (D-209)', () => {
  it('is the static transform for a clip with no keyframes at all', () => {
    const t = resolveClipBoxTransform({ position_x: 0.25, scale: 0.5 }, 42);
    expect(t).toEqual({ position_x: 0.25, position_y: 0, scale: 0.5, box_width: null, box_height: null });
  });

  it('fills every field with the engine defaults for a bare clip', () => {
    expect(resolveClipBoxTransform({}, 0)).toEqual({
      position_x: 0,
      position_y: 0,
      scale: 1,
      box_width: null,
      box_height: null,
    });
  });

  it('B-093 — a keyframe OVERRIDES the static field, which is what the box was missing', () => {
    // The exact shape of the owner's own `perf-comparison-reel-v3.chroma`
    // track-0 clip: at the head of the clip the picture is full-frame and
    // centred, while the STATIC fields say a third-size box two thirds of the
    // canvas to the left. That disagreement is what the bug screenshots were
    // of — the box drawn from the static fields, the picture from these.
    const clip = {
      position_x: -0.6679127110558514,
      scale: 0.37641393662181566,
      chroma_keyframes: [
        { frame: 0, params: { position_x: 0, position_y: 0.13021, scale: 1 } },
        { frame: 17, params: { position_x: 0, position_y: 0.13021, scale: 1 } },
        { frame: 18, params: { position_x: -0.01662, position_y: 0.12428, scale: 1.01662 } },
      ],
    };
    const t = resolveClipBoxTransform(clip, 0);
    expect(t.position_x).toBe(0);
    expect(t.position_y).toBe(0.13021);
    expect(t.scale).toBe(1);
    expect(t.position_x).not.toBeCloseTo(clip.position_x);
    expect(t.scale).not.toBeCloseTo(clip.scale);
  });

  it('falls back per-field to the static value for a field no keyframe names', () => {
    const t = resolveClipBoxTransform({ position_y: 0.3, chroma_keyframes: [{ frame: 0, params: { scale: 2 } }] }, 0);
    expect(t.scale).toBe(2);
    expect(t.position_y).toBe(0.3);
  });

  it('resolves each property over only its OWN keys (D-208/B-094), never bracketing across all of them', () => {
    // The `opacity` key at frame 50 names no geometry. Under the pre-D-208
    // frame-bracketing rule it would have frozen `scale` at 1 for the whole
    // first half; per-property it ramps straight through.
    const t = resolveClipBoxTransform(
      {
        chroma_keyframes: [
          { frame: 0, params: { scale: 1 } },
          { frame: 50, params: { opacity: 0.5 } },
          { frame: 100, params: { scale: 2 } },
        ],
      },
      25,
    );
    expect(t.scale).toBe(1.25);
  });

  it('leaves box_width null on a clip with no static override, whatever the keyframes say (D-193)', () => {
    const t = resolveClipBoxTransform({ chroma_keyframes: [{ frame: 0, params: { box_width: 0.8 } }] }, 0);
    expect(t.box_width).toBeNull();
  });

  it('keyframes an override that DOES exist statically, on top of it', () => {
    const t = resolveClipBoxTransform({ box_width: 0.5, chroma_keyframes: [{ frame: 0, params: { box_width: 0.8 } }] }, 0);
    expect(t.box_width).toBe(0.8);
  });

  it('is evaluated at the SOURCE frame, so one clip resolves differently along its own length', () => {
    const clip = {
      chroma_keyframes: [
        { frame: 0, params: { scale: 1 } },
        { frame: 100, params: { scale: 2 } },
      ],
    };
    expect(resolveClipBoxTransform(clip, 0).scale).toBe(1);
    expect(resolveClipBoxTransform(clip, 50).scale).toBe(1.5);
    expect(resolveClipBoxTransform(clip, 100).scale).toBe(2);
  });
});

// The per-param index (D-209) is a pure memoization of reads that already have
// tests above; these are the properties a cache can break that those cannot
// see — that a DIFFERENT array with the same shape is not served a stale
// answer, and that an unsorted stored list is still read in frame order.
describe('the per-param index (D-209)', () => {
  it('does not serve one keyframe array’s answer for another', () => {
    const a: ClipKeyframe[] = [
      { frame: 0, params: { scale: 1 } },
      { frame: 100, params: { scale: 2 } },
    ];
    const b: ClipKeyframe[] = [
      { frame: 0, params: { scale: 5 } },
      { frame: 100, params: { scale: 6 } },
    ];
    expect(paramValueAt(a, 'scale', 50, 0)).toBe(1.5);
    expect(paramValueAt(b, 'scale', 50, 0)).toBe(5.5);
    expect(paramValueAt(a, 'scale', 50, 0)).toBe(1.5);
  });

  it('reads a stored list that is not already frame-sorted in frame order', () => {
    const kfs: ClipKeyframe[] = [
      { frame: 100, params: { scale: 2 } },
      { frame: 0, params: { scale: 1 } },
      { frame: 50, params: { scale: 1.5 } },
    ];
    expect(paramValueAt(kfs, 'scale', 25, 0)).toBe(1.25);
    expect(paramKeyframeFrames(kfs, 'scale')).toEqual([0, 50, 100]);
    expect(adjacentParamKeyframeFrame(kfs, 'scale', 25, -1)).toBe(0);
    expect(adjacentParamKeyframeFrame(kfs, 'scale', 25, 1)).toBe(50);
  });

  it('answers for a param no key names without inventing one', () => {
    const kfs: ClipKeyframe[] = [{ frame: 0, params: { scale: 1 } }];
    expect(hasParamKeyframes(kfs, 'rotation')).toBe(false);
    expect(paramKeyframeFrames(kfs, 'rotation')).toEqual([]);
    expect(paramValueAt(kfs, 'rotation', 0, 42)).toBe(42);
  });
});

/**
 * @chroma/editor — `dynamicZoom.ts`'s box→keyframe math (D-234).
 *
 * This is where a dynamic zoom can actually be wrong: the span it covers, the
 * keys it writes, what it does to keys that were already there, and whether
 * the eased bake really traces the curve it claims. The pointer wiring
 * (`DynamicZoomOverlay.tsx` / `TransformBox.tsx`) is not unit-tested here for
 * this package's usual reason — its vitest environment is bare `node` — and
 * the interpolation these keys are then read back through is already pinned by
 * `clipKeyframes.test.ts` against the Rust resolver it mirrors.
 */
import { describe, expect, it } from 'vitest';

import {
  DYNAMIC_ZOOM_DEFAULT_PUSH,
  DYNAMIC_ZOOM_EASE_SAMPLES,
  applyDynamicZoom,
  defaultDynamicZoomEnd,
  dynamicZoomFramings,
  dynamicZoomIsStatic,
  dynamicZoomKeyframes,
  dynamicZoomSpan,
  dynamicZoomWouldReplace,
  type DynamicZoomFraming,
} from './dynamicZoom';
import { paramValueAt, type ClipKeyframe } from './clipKeyframes';
import { keyframeExprAt } from './timelineExport';
import { FADE_PRESETS } from './timeline';

const LINEAR = FADE_PRESETS[0].curve;
const EASE_IN = FADE_PRESETS.find((p) => p.name === 'ease-in')!.curve;
const EASE_OUT = FADE_PRESETS.find((p) => p.name === 'ease-out')!.curve;

const AT_REST: DynamicZoomFraming = { position_x: 0, position_y: 0, scale: 1 };
const PUSHED: DynamicZoomFraming = { position_x: 0.1, position_y: -0.05, scale: 1.5 };

/** A clip with just the fields this module reads. */
function clip(over: Partial<Record<string, unknown>> = {}) {
  return {
    source_start: 0,
    duration: 100,
    position_x: 0,
    position_y: 0,
    scale: 1,
    ...over,
  } as Parameters<typeof dynamicZoomFramings>[0];
}

describe('dynamicZoomSpan', () => {
  it('is the clip source window, with an INCLUSIVE last frame', () => {
    // `source_start + duration` is the first frame PAST the clip; keying the
    // end framing there would put it beyond anything that renders.
    expect(dynamicZoomSpan({ source_start: 30, duration: 100 })).toEqual({ first: 30, last: 129 });
  });

  it('collapses a one-frame clip rather than producing a backwards span', () => {
    expect(dynamicZoomSpan({ source_start: 7, duration: 1 })).toEqual({ first: 7, last: 7 });
    expect(dynamicZoomSpan({ source_start: 7, duration: 0 })).toEqual({ first: 7, last: 7 });
  });
});

describe('defaultDynamicZoomEnd', () => {
  it('is a centred push-in: scale only, position untouched', () => {
    const end = defaultDynamicZoomEnd({ position_x: 0.2, position_y: -0.3, scale: 2 });
    expect(end).toEqual({ position_x: 0.2, position_y: -0.3, scale: 2 * DYNAMIC_ZOOM_DEFAULT_PUSH });
  });
});

describe('dynamicZoomKeyframes — linear', () => {
  it('writes exactly two keys, one per end of the span', () => {
    const kfs = dynamicZoomKeyframes(AT_REST, PUSHED, 0, 99, LINEAR);
    expect(kfs).toEqual([
      { frame: 0, params: { position_x: 0, position_y: 0, scale: 1 } },
      { frame: 99, params: { position_x: 0.1, position_y: -0.05, scale: 1.5 } },
    ]);
  });

  it('defaults to linear when no curve is given', () => {
    expect(dynamicZoomKeyframes(AT_REST, PUSHED, 0, 99)).toHaveLength(2);
  });

  it('keys are frame-ascending and start at the span start, not at 0', () => {
    const kfs = dynamicZoomKeyframes(AT_REST, PUSHED, 250, 400, LINEAR);
    expect(kfs.map((k) => k.frame)).toEqual([250, 400]);
  });

  it('a degenerate one-frame span holds the END framing in a single key', () => {
    const kfs = dynamicZoomKeyframes(AT_REST, PUSHED, 5, 5, LINEAR);
    expect(kfs).toEqual([{ frame: 5, params: { position_x: 0.1, position_y: -0.05, scale: 1.5 } }]);
  });
});

describe('dynamicZoomKeyframes — eased', () => {
  it('bakes a non-linear ease into DYNAMIC_ZOOM_EASE_SAMPLES segments', () => {
    const kfs = dynamicZoomKeyframes(AT_REST, PUSHED, 0, 200, EASE_IN);
    expect(kfs).toHaveLength(DYNAMIC_ZOOM_EASE_SAMPLES + 1);
  });

  it('pins both endpoints EXACTLY to the dragged framings, not to a sampled value', () => {
    const kfs = dynamicZoomKeyframes(AT_REST, PUSHED, 0, 200, EASE_IN);
    expect(kfs[0]).toEqual({ frame: 0, params: { position_x: 0, position_y: 0, scale: 1 } });
    expect(kfs[kfs.length - 1]).toEqual({
      frame: 200,
      params: { position_x: 0.1, position_y: -0.05, scale: 1.5 },
    });
  });

  it('ease-in really lags the linear ramp, ease-out really leads it', () => {
    // The whole point of the bake: read the animation back through the SAME
    // interpolator the renderers use and check the shape is actually there.
    const mid = 100;
    const read = (curve: typeof LINEAR) =>
      paramValueAt(dynamicZoomKeyframes(AT_REST, PUSHED, 0, 200, curve), 'scale', mid, 1);
    const linearMid = read(LINEAR);
    expect(linearMid).toBeCloseTo(1.25, 3);
    expect(read(EASE_IN)).toBeLessThan(linearMid);
    expect(read(EASE_OUT)).toBeGreaterThan(linearMid);
  });

  it('is monotonic across the span for a monotonic push-in', () => {
    const kfs = dynamicZoomKeyframes(AT_REST, PUSHED, 0, 200, EASE_IN);
    const scales = kfs.map((k) => k.params.scale as number);
    for (let i = 1; i < scales.length; i++) expect(scales[i]).toBeGreaterThanOrEqual(scales[i - 1]);
  });

  it('never emits two keys at the same frame on a clip shorter than the sample count', () => {
    // 6 frames, 20 samples — most samples round onto a frame another already
    // claimed, and two entries at one frame would be a malformed list.
    const kfs = dynamicZoomKeyframes(AT_REST, PUSHED, 0, 5, EASE_IN);
    const frames = kfs.map((k) => k.frame);
    expect(new Set(frames).size).toBe(frames.length);
    expect(frames).toEqual([...frames].sort((a, b) => a - b));
    // The endpoints survive the collapse.
    expect(kfs[0].frame).toBe(0);
    expect(kfs[kfs.length - 1]).toEqual({
      frame: 5,
      params: { position_x: 0.1, position_y: -0.05, scale: 1.5 },
    });
  });
});

describe('applyDynamicZoom', () => {
  it('writes the zoom onto a clip with no keyframes at all', () => {
    const out = applyDynamicZoom(undefined, AT_REST, PUSHED, 0, 99, LINEAR);
    expect(out.map((k) => k.frame)).toEqual([0, 99]);
  });

  it('REPLACES existing position/scale keys rather than interleaving with them', () => {
    const existing: ClipKeyframe[] = [
      { frame: 10, params: { position_x: 0.9, scale: 3 } },
      { frame: 40, params: { position_y: 0.4 } },
    ];
    const out = applyDynamicZoom(existing, AT_REST, PUSHED, 0, 99, LINEAR);
    expect(out.map((k) => k.frame)).toEqual([0, 99]);
    // Nothing of the old animation survives on the three params it owns.
    expect(paramValueAt(out, 'scale', 10, 1)).toBeCloseTo(1 + 0.5 * (10 / 99), 6);
  });

  it('leaves every OTHER animated property untouched', () => {
    const existing: ClipKeyframe[] = [
      { frame: 10, params: { opacity: 0.5, scale: 3 } },
      { frame: 60, params: { opacity: 1, rotation: 45, volume: 0.2, crop_left: 0.1 } },
    ];
    const out = applyDynamicZoom(existing, AT_REST, PUSHED, 0, 99, LINEAR);
    expect(paramValueAt(out, 'opacity', 10, 1)).toBe(0.5);
    expect(paramValueAt(out, 'opacity', 60, 1)).toBe(1);
    expect(paramValueAt(out, 'rotation', 60, 0)).toBe(45);
    expect(paramValueAt(out, 'volume', 60, 1)).toBe(0.2);
    expect(paramValueAt(out, 'crop_left', 60, 0)).toBe(0.1);
  });

  it('drops an entry left with nothing, and merges into one that keeps something', () => {
    const existing: ClipKeyframe[] = [
      { frame: 10, params: { scale: 3 } }, // nothing left → gone
      { frame: 99, params: { opacity: 0.25 } }, // survives, and the end key merges in
    ];
    const out = applyDynamicZoom(existing, AT_REST, PUSHED, 0, 99, LINEAR);
    expect(out.map((k) => k.frame)).toEqual([0, 99]);
    expect(out[1].params).toEqual({ opacity: 0.25, position_x: 0.1, position_y: -0.05, scale: 1.5 });
  });

  it('is idempotent — re-applying the same zoom does not accumulate keys', () => {
    const once = applyDynamicZoom(undefined, AT_REST, PUSHED, 0, 99, EASE_IN);
    const twice = applyDynamicZoom(once, AT_REST, PUSHED, 0, 99, EASE_IN);
    expect(twice).toEqual(once);
  });

  it('re-easing an existing zoom replaces its bake rather than layering on it', () => {
    const linear = applyDynamicZoom(undefined, AT_REST, PUSHED, 0, 200, LINEAR);
    const eased = applyDynamicZoom(linear, AT_REST, PUSHED, 0, 200, EASE_IN);
    expect(eased).toHaveLength(DYNAMIC_ZOOM_EASE_SAMPLES + 1);
    const backToLinear = applyDynamicZoom(eased, AT_REST, PUSHED, 0, 200, LINEAR);
    expect(backToLinear).toHaveLength(2);
  });
});

describe('dynamicZoomFramings — reading the boxes back off a clip', () => {
  it('a static clip reports two IDENTICAL framings (nothing authored yet)', () => {
    const { start, end } = dynamicZoomFramings(clip({ position_x: 0.2, scale: 1.5 }));
    expect(start).toEqual({ position_x: 0.2, position_y: 0, scale: 1.5 });
    expect(dynamicZoomIsStatic(start, end)).toBe(true);
  });

  it('round-trips a zoom this module itself wrote', () => {
    const c = clip({ source_start: 0, duration: 100 });
    const span = dynamicZoomSpan(c);
    const kfs = applyDynamicZoom(undefined, AT_REST, PUSHED, span.first, span.last, LINEAR);
    const { start, end } = dynamicZoomFramings({ ...c, chroma_keyframes: kfs });
    expect(start).toEqual(AT_REST);
    expect(end).toEqual(PUSHED);
    expect(dynamicZoomIsStatic(start, end)).toBe(false);
  });

  it('round-trips an EASED zoom too — the bake does not move either endpoint', () => {
    const c = clip({ source_start: 12, duration: 250 });
    const span = dynamicZoomSpan(c);
    const kfs = applyDynamicZoom(undefined, AT_REST, PUSHED, span.first, span.last, EASE_IN);
    const { start, end } = dynamicZoomFramings({ ...c, chroma_keyframes: kfs });
    expect(start).toEqual(AT_REST);
    expect(end).toEqual(PUSHED);
  });

  it('reads a HAND-authored animation as its own start/end framing', () => {
    // Arming the mode on a clip someone keyed by hand must show the right two
    // boxes, not the clip's stale static fields.
    const c = clip({
      source_start: 0,
      duration: 100,
      scale: 1,
      chroma_keyframes: [
        { frame: 0, params: { scale: 2 } },
        { frame: 99, params: { scale: 0.5, position_x: 0.3 } },
      ],
    });
    const { start, end } = dynamicZoomFramings(c);
    expect(start.scale).toBe(2);
    expect(end).toEqual({ position_x: 0.3, position_y: 0, scale: 0.5 });
  });
});

describe('preview and export agree — because there is nothing new to agree about', () => {
  // The claim D-234 rests on is that a dynamic zoom is not a new render
  // concept: it is ordinary keyframes, so both renderers were already correct
  // about it. That claim is checkable rather than assertable, and these two
  // tests check it from both sides.

  it('produces keyframes BYTE-IDENTICAL to the hand-authored equivalent', () => {
    const baked = applyDynamicZoom(undefined, AT_REST, PUSHED, 0, 99, LINEAR);
    // What a human would have typed into the Inspector, or an agent passed to
    // editor_set_clip_keyframes, for the same push-in.
    const handAuthored: ClipKeyframe[] = [
      { frame: 0, params: { position_x: 0, position_y: 0, scale: 1 } },
      { frame: 99, params: { position_x: 0.1, position_y: -0.05, scale: 1.5 } },
    ];
    expect(baked).toEqual(handAuthored);
  });

  it('compiles to the same ffmpeg expression the export builds for hand-authored keys', () => {
    // `keyframeExprAt` is the EXPORT side's own evaluator (the ffmpeg
    // piecewise-linear expression), and `paramValueAt` mirrors the PREVIEW
    // side's Rust `interpolate_param`. Running the baked keys through both and
    // getting the hand-authored answer is the end-to-end version of the claim.
    const baked = applyDynamicZoom(undefined, AT_REST, PUSHED, 0, 99, LINEAR);
    const handAuthored: ClipKeyframe[] = [
      { frame: 0, params: { scale: 1 } },
      { frame: 99, params: { scale: 1.5 } },
    ];
    const fps = 30;
    expect(keyframeExprAt(baked, 'scale', 1, fps)).toBe(keyframeExprAt(handAuthored, 'scale', 1, fps));
    for (const f of [0, 25, 50, 75, 99]) {
      expect(paramValueAt(baked, 'scale', f, 1)).toBe(paramValueAt(handAuthored, 'scale', f, 1));
    }
  });

  it('an EASED bake is still ordinary keys — no per-key easing field is invented', () => {
    // Nothing in a baked entry names a curve; every entry is the same
    // `{frame, params}` shape `set_clip_keyframes` has always accepted, which
    // is precisely why neither renderer needed a change.
    for (const k of applyDynamicZoom(undefined, AT_REST, PUSHED, 0, 200, EASE_IN)) {
      expect(Object.keys(k).sort()).toEqual(['frame', 'params']);
      expect(Object.keys(k.params).sort()).toEqual(['position_x', 'position_y', 'scale']);
      for (const v of Object.values(k.params)) expect(typeof v).toBe('number');
    }
  });
});

describe('dynamicZoomWouldReplace', () => {
  it('is false for no keys and for keys on other properties only', () => {
    expect(dynamicZoomWouldReplace(undefined)).toBe(false);
    expect(dynamicZoomWouldReplace([])).toBe(false);
    expect(dynamicZoomWouldReplace([{ frame: 0, params: { opacity: 0.5, rotation: 10 } }])).toBe(false);
  });

  it('is true as soon as any of the three params it owns is keyed', () => {
    expect(dynamicZoomWouldReplace([{ frame: 0, params: { scale: 2 } }])).toBe(true);
    expect(dynamicZoomWouldReplace([{ frame: 0, params: { position_y: 0.1 } }])).toBe(true);
  });
});

/**
 * D-232 — per-segment keyframe easing, on the authoring/preview-mirror side
 * (`clipKeyframes.ts`).
 *
 * `clipKeyframes.test.ts` continues to own the pre-D-232 behaviour; this file
 * is the easing half, kept separate so the "an un-eased clip resolves exactly
 * as it always did" guarantee has an obvious home and the older file stays
 * about what it was about.
 */
import { describe, expect, it } from 'vitest';

import {
  animatedParams,
  mergeClipKeyframeParams,
  paramSegments,
  paramValueAt,
  removeClipKeyframeParam,
  setClipKeyframeEase,
  type ClipKeyframe,
} from './clipKeyframes';
import { easeCurveEval } from './easeCurve';
import { EASE_PRESETS } from './timeline';

const LINEAR = EASE_PRESETS[0].curve;
const EASE_IN = EASE_PRESETS[1].curve;
const EASE_IN_OUT = EASE_PRESETS[3].curve;

/** Two opacity keys, 0 -> 1 over frames 0..100. */
function ramp(ease?: typeof EASE_IN): ClipKeyframe[] {
  return [
    ease ? { frame: 0, params: { opacity: 0 }, ease: { opacity: ease } } : { frame: 0, params: { opacity: 0 } },
    { frame: 100, params: { opacity: 1 } },
  ];
}

describe('paramValueAt — easing', () => {
  it('is bit-identical to the pre-D-232 linear ramp when nothing is eased', () => {
    // The backward-compatibility guarantee: every project that existed before
    // this feature must resolve to exactly the same numbers.
    const kfs = ramp();
    for (let f = 0; f <= 100; f += 5) {
      expect(paramValueAt(kfs, 'opacity', f, 0)).toBe(Math.round((f / 100) * 1_000_000) / 1_000_000);
    }
  });

  it('warps the RATE and nothing else — both keyframes still hit their values', () => {
    // The property that makes easing safe: a curve can never move a keyframe.
    const kfs = ramp(EASE_IN);
    expect(paramValueAt(kfs, 'opacity', 0, 0)).toBe(0);
    expect(paramValueAt(kfs, 'opacity', 100, 0)).toBe(1);
  });

  it('follows the curve between the keys', () => {
    const kfs = ramp(EASE_IN);
    for (const f of [10, 25, 50, 75, 90]) {
      const expected = easeCurveEval(EASE_IN, f / 100);
      expect(paramValueAt(kfs, 'opacity', f, 0)).toBeCloseTo(expected, 5);
    }
    // ...and an ease-in really is slower than linear at the start.
    expect(paramValueAt(kfs, 'opacity', 25, 0)).toBeLessThan(0.25);
  });

  it('takes the ease from the segment\'s START key, not its end', () => {
    // Two segments, only the FIRST eased. The second must stay dead straight.
    const kfs: ClipKeyframe[] = [
      { frame: 0, params: { scale: 0 }, ease: { scale: EASE_IN } },
      { frame: 100, params: { scale: 1 } },
      { frame: 200, params: { scale: 2 } },
    ];
    expect(paramValueAt(kfs, 'scale', 50, 0)).toBeLessThan(0.5);
    expect(paramValueAt(kfs, 'scale', 150, 0)).toBeCloseTo(1.5, 6);
  });

  it('eases each property independently at the same frame', () => {
    const kfs: ClipKeyframe[] = [
      { frame: 0, params: { opacity: 0, scale: 0 }, ease: { opacity: EASE_IN } },
      { frame: 100, params: { opacity: 1, scale: 1 } },
    ];
    expect(paramValueAt(kfs, 'opacity', 50, 0)).not.toBeCloseTo(0.5, 3);
    expect(paramValueAt(kfs, 'scale', 50, 0)).toBeCloseTo(0.5, 6);
  });

  it('treats a stored LINEAR curve exactly as no curve', () => {
    const eased = ramp(LINEAR);
    const plain = ramp();
    for (let f = 0; f <= 100; f += 10) {
      expect(paramValueAt(eased, 'opacity', f, 0)).toBe(paramValueAt(plain, 'opacity', f, 0));
    }
  });

  it('still holds flat outside the keyed range', () => {
    const kfs = ramp(EASE_IN);
    expect(paramValueAt(kfs, 'opacity', -50, 0.7)).toBe(0);
    expect(paramValueAt(kfs, 'opacity', 500, 0.7)).toBe(1);
  });

  it('composes with rotation\'s shortest arc', () => {
    // The arc is chosen from the two values, then traversed at the eased rate
    // — 350 -> 10 must still go through 0 (not 180), just non-linearly.
    const kfs: ClipKeyframe[] = [
      { frame: 0, params: { rotation: 350 }, ease: { rotation: EASE_IN } },
      { frame: 100, params: { rotation: 10 } },
    ];
    const mid = paramValueAt(kfs, 'rotation', 50, 0);
    // The short way is +20 degrees; eased, we are less than half way along it.
    expect(mid).toBeGreaterThan(350);
    expect(mid).toBeLessThan(360);
    expect(mid).toBeLessThan(360); // NOT swinging down through 180
  });

  it('carries overshoot through to the resolved value', () => {
    const anticipate = { x1: 0.4, y1: -0.6, x2: 0.6, y2: 1 };
    const kfs: ClipKeyframe[] = [
      { frame: 0, params: { position_x: 0 }, ease: { position_x: anticipate } },
      { frame: 100, params: { position_x: 1 } },
    ];
    // Real anticipation: the clip pulls BACK before moving forward.
    expect(paramValueAt(kfs, 'position_x', 25, 0)).toBeLessThan(0);
  });
});

describe('setClipKeyframeEase', () => {
  it('writes the curve onto the segment\'s start key', () => {
    const out = setClipKeyframeEase(ramp(), 0, 'opacity', EASE_IN);
    expect(out?.[0].ease).toEqual({ opacity: EASE_IN });
    expect(out?.[1].ease).toBeUndefined();
  });

  it('clears back to linear without leaving an empty husk', () => {
    // A fully un-eased timeline must serialise exactly as it did before D-232,
    // so a round trip through the backend cannot reintroduce a difference.
    const eased = setClipKeyframeEase(ramp(), 0, 'opacity', EASE_IN)!;
    const cleared = setClipKeyframeEase(eased, 0, 'opacity', null);
    expect(cleared?.[0]).not.toHaveProperty('ease');
  });

  it('leaves other params\' curves at the same key alone', () => {
    const kfs: ClipKeyframe[] = [
      { frame: 0, params: { opacity: 0, scale: 1 }, ease: { scale: EASE_IN_OUT } },
      { frame: 100, params: { opacity: 1, scale: 2 } },
    ];
    const out = setClipKeyframeEase(kfs, 0, 'opacity', EASE_IN);
    expect(out?.[0].ease).toEqual({ scale: EASE_IN_OUT, opacity: EASE_IN });
    const back = setClipKeyframeEase(out, 0, 'opacity', null);
    expect(back?.[0].ease).toEqual({ scale: EASE_IN_OUT });
  });

  it('is reference-equal — a real no-op — on a frame that is not a key', () => {
    // Reference equality is what stops `applyOp` pushing an undo entry for a
    // write that changed nothing.
    const kfs = ramp();
    expect(setClipKeyframeEase(kfs, 42, 'opacity', EASE_IN)).toBe(kfs);
  });

  it('is reference-equal on a key that does not name that param', () => {
    const kfs: ClipKeyframe[] = [{ frame: 0, params: { scale: 1 } }, { frame: 100, params: { scale: 2 } }];
    expect(setClipKeyframeEase(kfs, 0, 'opacity', EASE_IN)).toBe(kfs);
  });

  it('is reference-equal when clearing an already-linear segment', () => {
    const kfs = ramp();
    expect(setClipKeyframeEase(kfs, 0, 'opacity', null)).toBe(kfs);
  });

  it('stores what was authored, unclamped', () => {
    // `easeCurveEval` clamps x at the point of use; storage keeps the author's
    // own numbers, the same "the model stores what the UI wrote" rule the
    // crop/scale fields follow.
    const wild = { x1: -2, y1: 5, x2: 3, y2: -4 };
    const out = setClipKeyframeEase(ramp(), 0, 'opacity', wild);
    expect(out?.[0].ease?.opacity).toEqual(wild);
  });
});

describe('ease survives the other keyframe writers', () => {
  it('mergeClipKeyframeParams keeps an existing key\'s curves', () => {
    // Adding a `scale` key at a frame that already eases `opacity` must not
    // silently straighten the opacity curve.
    const eased = setClipKeyframeEase(ramp(), 0, 'opacity', EASE_IN)!;
    const out = mergeClipKeyframeParams(eased, 0, { scale: 1.5 });
    expect(out[0].ease).toEqual({ opacity: EASE_IN });
    expect(out[0].params).toEqual({ opacity: 0, scale: 1.5 });
  });

  it('a newly created key starts linear', () => {
    const out = mergeClipKeyframeParams(ramp(), 50, { opacity: 0.4 });
    expect(out[1].frame).toBe(50);
    expect(out[1]).not.toHaveProperty('ease');
  });

  it('removeClipKeyframeParam takes that param\'s curves with it', () => {
    // Otherwise stopwatch-off-then-on would surprisingly resurrect old curves.
    const kfs: ClipKeyframe[] = [
      { frame: 0, params: { opacity: 0, scale: 1 }, ease: { opacity: EASE_IN, scale: EASE_IN_OUT } },
      { frame: 100, params: { opacity: 1, scale: 2 } },
    ];
    const out = removeClipKeyframeParam(kfs, 'opacity');
    expect(out?.[0].ease).toEqual({ scale: EASE_IN_OUT });
  });

  it('drops the ease map entirely when its last curve goes', () => {
    const eased = setClipKeyframeEase(ramp(), 0, 'opacity', EASE_IN)!;
    const withScale = mergeClipKeyframeParams(eased, 0, { scale: 1 });
    const out = removeClipKeyframeParam(withScale, 'opacity');
    expect(out?.[0]).not.toHaveProperty('ease');
  });
});

describe('paramSegments', () => {
  it('pairs consecutive keys with the curve that shapes each gap', () => {
    const kfs: ClipKeyframe[] = [
      { frame: 0, params: { opacity: 0 }, ease: { opacity: EASE_IN } },
      { frame: 50, params: { opacity: 1 } },
      { frame: 90, params: { opacity: 0.2 } },
    ];
    expect(paramSegments(kfs, 'opacity')).toEqual([
      { fromFrame: 0, toFrame: 50, fromValue: 0, toValue: 1, ease: EASE_IN },
      { fromFrame: 50, toFrame: 90, fromValue: 1, toValue: 0.2, ease: null },
    ]);
  });

  it('normalises a stored linear curve to null', () => {
    const [s] = paramSegments(ramp(LINEAR), 'opacity');
    expect(s.ease).toBeNull();
  });

  it('is empty for a static property and for a single key', () => {
    expect(paramSegments(undefined, 'opacity')).toEqual([]);
    expect(paramSegments([{ frame: 0, params: { opacity: 1 } }], 'opacity')).toEqual([]);
  });

  it('considers only the named param\'s own keys', () => {
    const kfs: ClipKeyframe[] = [
      { frame: 0, params: { opacity: 0 } },
      { frame: 50, params: { scale: 2 } },
      { frame: 100, params: { opacity: 1 } },
    ];
    // The unrelated `scale` key at 50 must not split opacity's one segment.
    expect(paramSegments(kfs, 'opacity')).toEqual([
      { fromFrame: 0, toFrame: 100, fromValue: 0, toValue: 1, ease: null },
    ]);
  });
});

describe('animatedParams', () => {
  it('reports only properties that really are keyed, in declaration order', () => {
    const kfs: ClipKeyframe[] = [
      { frame: 0, params: { scale: 1, opacity: 0 } },
      { frame: 10, params: { scale: 2, opacity: 1 } },
    ];
    // `opacity` before `scale` regardless of the order they were authored in,
    // so the curve button's default lane is stable.
    expect(animatedParams(kfs)).toEqual(['opacity', 'scale']);
  });

  it('ignores names with no Inspector row or curve lane', () => {
    const kfs: ClipKeyframe[] = [
      { frame: 0, params: { box_width: 100 } },
      { frame: 10, params: { box_width: 200 } },
    ];
    expect(animatedParams(kfs)).toEqual([]);
  });

  it('is empty for a static clip', () => {
    expect(animatedParams(undefined)).toEqual([]);
    expect(animatedParams([])).toEqual([]);
  });
});

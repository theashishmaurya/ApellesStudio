/**
 * `easeCurve.ts` — the TS mirror of `apelles_types::ease` (D-233).
 *
 * The point of this file is not that the solver works (D-147's Rust tests
 * already pin that, and this is the same algorithm). It is that the TWO
 * implementations agree, because they are what the live preview and the
 * exporter respectively evaluate, and a drifted mirror is the B-090/B-094/
 * B-095 divergence class. So the fixture vectors below are computed
 * independently of BOTH — by plain bisection on the parametric cubic, written
 * out here — rather than by calling either implementation and asserting it
 * equals itself.
 */
import { describe, expect, it } from 'vitest';

import { bezier, easeCurveEval, isIdentityEase } from './easeCurve';
import { EASE_PRESETS, type EaseCurve } from './timeline';

const LINEAR = EASE_PRESETS[0].curve;
const EASE_IN = EASE_PRESETS[1].curve;
const EASE_OUT = EASE_PRESETS[2].curve;
const EASE_IN_OUT = EASE_PRESETS[3].curve;

/** `y` at `x`, solved by plain bisection on `x(t) = x` — deliberately NOT via
 *  `solveTForX`, so a test that reuses the implementation proves nothing.
 *  This is the exact same independent method `apelles_types::ease`'s own
 *  `ease_in_midpoint_matches_an_independently_computed_value` uses. */
function referenceEval(c: EaseCurve, x: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 200; i++) {
    const t = (lo + hi) / 2;
    if (bezier(t, c.x1, c.x2) < x) lo = t;
    else hi = t;
  }
  return bezier((lo + hi) / 2, c.y1, c.y2);
}

describe('easeCurveEval', () => {
  it('matches an independently bisected reference for every preset', () => {
    for (const p of EASE_PRESETS) {
      for (let i = 1; i < 20; i++) {
        const x = i / 20;
        expect(easeCurveEval(p.curve, x)).toBeCloseTo(referenceEval(p.curve, x), 6);
      }
    }
  });

  it('pins both endpoints exactly, whatever the handles say', () => {
    // This is the property that makes easing safe on a keyframe segment: no
    // curve can move the keyframes it runs between.
    const wild: EaseCurve[] = [
      LINEAR,
      EASE_IN_OUT,
      { x1: 0, y1: 1, x2: 1, y2: 0 },
      { x1: 0.3, y1: 4, x2: 0.7, y2: -3 },
      { x1: 0, y1: 0, x2: 0, y2: 1 },
    ];
    for (const c of wild) {
      expect(easeCurveEval(c, 0)).toBe(0);
      expect(easeCurveEval(c, 1)).toBe(1);
    }
  });

  it('is the exact identity for linear', () => {
    for (let i = 0; i <= 10; i++) {
      const x = i / 10;
      expect(easeCurveEval(LINEAR, x)).toBeCloseTo(x, 9);
    }
  });

  it('ease-in is below the diagonal and ease-out above it', () => {
    for (let i = 1; i < 10; i++) {
      const x = i / 10;
      expect(easeCurveEval(EASE_IN, x)).toBeLessThan(x);
      expect(easeCurveEval(EASE_OUT, x)).toBeGreaterThan(x);
    }
  });

  it('lets y overshoot — the whole point of a draggable handle', () => {
    // `y1`/`y2` are deliberately unclamped in the model. An anticipation ease
    // dips BELOW its start value before climbing, which is a real thing to
    // author and which a clamped evaluator would silently flatten.
    const anticipate: EaseCurve = { x1: 0.4, y1: -0.6, x2: 0.6, y2: 1 };
    expect(easeCurveEval(anticipate, 0.25)).toBeLessThan(0);
  });

  it('clamps x-handles rather than trusting a non-invertible curve', () => {
    const wild: EaseCurve = { x1: -5, y1: 0, x2: 9, y2: 1 };
    const clamped: EaseCurve = { x1: 0, y1: 0, x2: 1, y2: 1 };
    for (let i = 0; i <= 10; i++) {
      expect(easeCurveEval(wild, i / 10)).toBeCloseTo(easeCurveEval(clamped, i / 10), 9);
    }
  });

  it('survives degenerate handles via the bisection fallback', () => {
    // `x1 == x2 == 0` is a vertical start tangent, where Newton alone divides
    // by ~zero. Every control value is inside [0,1] here, so the bezier's
    // convex-hull property says the output must be too — a real assertion,
    // not merely "did not throw".
    for (const c of [
      { x1: 0, y1: 0, x2: 0, y2: 1 },
      { x1: 1, y1: 0, x2: 1, y2: 1 },
    ]) {
      for (let i = 0; i <= 20; i++) {
        const y = easeCurveEval(c, i / 20);
        expect(Number.isFinite(y)).toBe(true);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(1);
      }
    }
  });

  it('is bit-deterministic — a project invariant', () => {
    for (const c of [EASE_IN_OUT, { x1: 0, y1: 0, x2: 0, y2: 1 }]) {
      for (let i = 0; i <= 50; i++) {
        const x = i / 50;
        expect(easeCurveEval(c, x)).toBe(easeCurveEval(c, x));
      }
    }
  });
});

describe('isIdentityEase', () => {
  it('treats absent, linear, and CSS-linear alike', () => {
    // The three ways "no easing" can be spelled. All must collapse to the same
    // answer, or an explicitly-linear segment would be exported as 20 sampled
    // points while an un-eased one exported as 2.
    expect(isIdentityEase(undefined)).toBe(true);
    expect(isIdentityEase(null)).toBe(true);
    expect(isIdentityEase(LINEAR)).toBe(true);
    expect(isIdentityEase({ x1: 0, y1: 0, x2: 1, y2: 1 })).toBe(true);
    expect(isIdentityEase({ x1: 0.5, y1: 0.5, x2: 0.5, y2: 0.5 })).toBe(true);
  });

  it('is false for every real preset and for a custom curve', () => {
    expect(isIdentityEase(EASE_IN)).toBe(false);
    expect(isIdentityEase(EASE_OUT)).toBe(false);
    expect(isIdentityEase(EASE_IN_OUT)).toBe(false);
    expect(isIdentityEase({ x1: 0.1, y1: 0.9, x2: 0.9, y2: 0.1 })).toBe(false);
  });

  it('treats a malformed curve as no easing rather than propagating NaN', () => {
    expect(isIdentityEase({ x1: NaN, y1: 0, x2: 1, y2: 1 })).toBe(true);
  });

  it('agrees with easeCurveEval about what "identity" means', () => {
    // The two must not be able to disagree: anything this calls identity has
    // to actually evaluate as y = x, or the exporter's fast path would emit a
    // straight line for a curve the preview bends.
    for (const c of [LINEAR, { x1: 0, y1: 0, x2: 1, y2: 1 }, { x1: 0.5, y1: 0.5, x2: 0.5, y2: 0.5 }]) {
      expect(isIdentityEase(c)).toBe(true);
      for (let i = 1; i < 10; i++) {
        expect(easeCurveEval(c, i / 10)).toBeCloseTo(i / 10, 6);
      }
    }
  });
});

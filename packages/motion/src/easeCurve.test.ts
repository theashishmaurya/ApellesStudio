import { describe, expect, it } from 'vitest';
import { design } from '@apelles/motion-engine/src/design';
import {
  clamp,
  clampEaseCurve,
  curvePath,
  curveToPixel,
  DEFAULT_EASE,
  EASE_PRESETS,
  EASE_Y_MAX,
  EASE_Y_MIN,
  pixelToCurve,
  resolveEaseCurve,
} from './easeCurve';

describe('clamp', () => {
  it('passes a value already inside the range through unchanged', () => {
    expect(clamp(0.5, 0, 1)).toBe(0.5);
  });
  it('clamps below the minimum', () => {
    expect(clamp(-3, 0, 1)).toBe(0);
  });
  it('clamps above the maximum', () => {
    expect(clamp(3, 0, 1)).toBe(1);
  });
});

describe('curveToPixel / pixelToCurve — the real pointer<->value conversion', () => {
  const size = { w: 200, h: 200 };

  it('maps curve (0,0) to the bottom-left pixel corner', () => {
    const px = curveToPixel({ x: 0, y: 0 }, size);
    expect(px.x).toBeCloseTo(0, 6);
    // y:0 is EASE_Y_MIN..EASE_Y_MAX fraction (0 - EASE_Y_MIN) / range up from the
    // bottom, i.e. pixel y = h - fraction*h — NOT flush with the bottom edge,
    // since the viewport extends below y:0 (EASE_Y_MIN < 0).
    const fraction = (0 - EASE_Y_MIN) / (EASE_Y_MAX - EASE_Y_MIN);
    expect(px.y).toBeCloseTo(size.h - fraction * size.h, 6);
  });

  it('maps curve (1,1) to the top-right pixel corner', () => {
    const px = curveToPixel({ x: 1, y: 1 }, size);
    expect(px.x).toBeCloseTo(size.w, 6);
    const fraction = (1 - EASE_Y_MIN) / (EASE_Y_MAX - EASE_Y_MIN);
    expect(px.y).toBeCloseTo(size.h - fraction * size.h, 6);
  });

  it('is the exact inverse of pixelToCurve for a point inside both ranges', () => {
    const original = { x: 0.42, y: 0.73 };
    const px = curveToPixel(original, size);
    const back = pixelToCurve(px, size);
    expect(back.x).toBeCloseTo(original.x, 6);
    expect(back.y).toBeCloseTo(original.y, 6);
  });

  it('is the exact inverse for a negative-y (undershoot) point inside EASE_Y_MIN/MAX', () => {
    const original = { x: 0.1, y: -0.4 };
    const px = curveToPixel(original, size);
    const back = pixelToCurve(px, size);
    expect(back.x).toBeCloseTo(original.x, 6);
    expect(back.y).toBeCloseTo(original.y, 6);
  });

  it('clamps x to 0 for a pointer left of the widget', () => {
    const { x } = pixelToCurve({ x: -50, y: 100 }, size);
    expect(x).toBe(0);
  });

  it('clamps x to 1 for a pointer right of the widget', () => {
    const { x } = pixelToCurve({ x: 500, y: 100 }, size);
    expect(x).toBe(1);
  });

  it('clamps y to EASE_Y_MAX for a pointer above the widget (SVG y-up = negative pixel y)', () => {
    const { y } = pixelToCurve({ x: 100, y: -500 }, size);
    expect(y).toBe(EASE_Y_MAX);
  });

  it('clamps y to EASE_Y_MIN for a pointer below the widget', () => {
    const { y } = pixelToCurve({ x: 100, y: 5000 }, size);
    expect(y).toBe(EASE_Y_MIN);
  });

  it('never produces an out-of-[0,1]-range x regardless of pointer position (Easing.bezier would throw otherwise)', () => {
    for (const px of [-1000, -1, 0, 1, 201, 5000]) {
      const { x } = pixelToCurve({ x: px, y: 0 }, size);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1);
    }
  });

  it('degrades to the origin rather than dividing by zero when the widget has not been measured yet (size 0)', () => {
    const px = curveToPixel({ x: 0.5, y: 0.5 }, { w: 0, h: 0 });
    expect(px.x).toBe(0);
    expect(px.y).toBe(0);
    const value = pixelToCurve({ x: 10, y: 10 }, { w: 0, h: 0 });
    expect(value.x).toBe(0);
    expect(value.y).toBe(EASE_Y_MIN);
  });
});

describe('clampEaseCurve', () => {
  it('leaves an already-valid curve untouched', () => {
    expect(clampEaseCurve([0.4, 0, 0.2, 1])).toEqual([0.4, 0, 0.2, 1]);
  });

  it('clamps x1/x2 into [0,1] — the constraint Easing.bezier itself enforces by throwing', () => {
    expect(clampEaseCurve([-2, 0, 5, 1])).toEqual([0, 0, 1, 1]);
  });

  it('clamps y1/y2 into the widget viewport, leaving x1/x2 alone', () => {
    expect(clampEaseCurve([0.5, -100, 0.5, 100])).toEqual([0.5, EASE_Y_MIN, 0.5, EASE_Y_MAX]);
  });

  it('does not clamp design.ease.anticipate — its overshoot fits the viewport by design', () => {
    expect(clampEaseCurve(design.ease.anticipate)).toEqual(design.ease.anticipate);
  });
});

describe('resolveEaseCurve', () => {
  it('accepts a genuine 4-number-tuple-shaped array', () => {
    expect(resolveEaseCurve([0.4, 0, 0.2, 1])).toEqual([0.4, 0, 0.2, 1]);
  });
  it('rejects undefined (the "unset" case, not a malformed one)', () => {
    expect(resolveEaseCurve(undefined)).toBeNull();
  });
  it('rejects a non-array', () => {
    expect(resolveEaseCurve('not an array')).toBeNull();
  });
  it('rejects the wrong length', () => {
    expect(resolveEaseCurve([0, 0, 1])).toBeNull();
    expect(resolveEaseCurve([0, 0, 1, 1, 1])).toBeNull();
  });
  it('rejects a non-number element (e.g. a hand-typo\'d string)', () => {
    expect(resolveEaseCurve([0, 0, '1', 1])).toBeNull();
  });
  it('rejects NaN/Infinity elements', () => {
    expect(resolveEaseCurve([0, NaN, 1, 1])).toBeNull();
    expect(resolveEaseCurve([0, 0, Infinity, 1])).toBeNull();
  });
});

describe('curvePath', () => {
  it('starts at the pixel-mapped (0,0) and ends at the pixel-mapped (1,1), through the two control points, as one C command', () => {
    const size = { w: 100, h: 100 };
    const curve: [number, number, number, number] = [0.25, 0.1, 0.75, 0.9];
    const path = curvePath(curve, size);
    const p0 = curveToPixel({ x: 0, y: 0 }, size);
    const p3 = curveToPixel({ x: 1, y: 1 }, size);
    const c1 = curveToPixel({ x: curve[0], y: curve[1] }, size);
    const c2 = curveToPixel({ x: curve[2], y: curve[3] }, size);
    expect(path).toBe(`M ${p0.x} ${p0.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${p3.x} ${p3.y}`);
  });

  it('produces a different path string for a different curve at the same size (a real function of its input, not a constant)', () => {
    const size = { w: 100, h: 100 };
    const a = curvePath([0, 0, 1, 1], size);
    const b = curvePath(design.ease.anticipate, size);
    expect(a).not.toBe(b);
  });
});

describe('EASE_PRESETS / DEFAULT_EASE — sourced from design.ease.*, never a hardcoded duplicate', () => {
  it('includes Linear and a standard Ease In not defined by design.ease', () => {
    const linear = EASE_PRESETS.find((p) => p.label === 'Linear');
    const easeIn = EASE_PRESETS.find((p) => p.label === 'Ease In');
    expect(linear?.value).toEqual([0, 0, 1, 1]);
    expect(easeIn?.value).toEqual([0.42, 0, 1, 1]);
  });

  it('Ease Out / Ease In Out / Anticipate are the SAME reference as design.ease.*, not a retyped copy', () => {
    const out = EASE_PRESETS.find((p) => p.label === 'Ease Out');
    const inOut = EASE_PRESETS.find((p) => p.label === 'Ease In Out');
    const anticipate = EASE_PRESETS.find((p) => p.label === 'Anticipate');
    expect(out?.value).toBe(design.ease.out);
    expect(inOut?.value).toBe(design.ease.inOut);
    expect(anticipate?.value).toBe(design.ease.anticipate);
  });

  it('DEFAULT_EASE is design.ease.inOut — the exact fallbackEase interpolateKeys.ts already renders with when ease is absent', () => {
    expect(DEFAULT_EASE).toBe(design.ease.inOut);
  });
});

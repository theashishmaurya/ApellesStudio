/**
 * Tests for `motion-engine`'s shared `interpolateKeys` (D-159, Phase 4 —
 * extracted verbatim from `Camera.tsx`'s own pre-D-159 inline sort/clamp/
 * ease/interpolate logic, see that file's own doc comment). Lives in
 * `@apelles/motion`'s test suite, not `@apelles/motion-engine`'s, because the
 * engine package has no `test` script at all (confirmed pre-existing by
 * D-155/D-157's own decision entries) — the SAME cross-package import
 * pattern `canvasGeometry.test.ts`/`manifestEdit.test.ts` already use for
 * `@apelles/motion-engine`'s `sample`/`schema` types, applied here to a pure
 * function instead. This is the load-bearing test coverage for BOTH
 * consumers this phase gives the function (`Camera.tsx`'s x/y/zoom, and
 * `Video.tsx`'s per-layer transform-key x/y/scale/rot/opacity) — a bug here
 * would silently mis-animate every camera move AND every keyed layer.
 */
import { describe, it, expect } from 'vitest';
import { interpolateKeys, type KeyframeBase } from '@apelles/motion-engine/src/lib/interpolateKeys';

type ValKey = KeyframeBase & { val?: number };
const FIELDS = ['val'] as const;
const DEFAULTS = { val: 0 };
const LINEAR: readonly [number, number, number, number] = [0, 0, 1, 1]; // linear bezier — t stays t

describe('interpolateKeys', () => {
  it('returns the field defaults for an empty keys array', () => {
    expect(interpolateKeys<'val', ValKey>([], 10, FIELDS, { val: 42 }, LINEAR)).toEqual({ val: 42 });
  });

  it('returns the single key\'s own value at, before, and after its frame (one key = constant)', () => {
    const keys: ValKey[] = [{ at: 10, val: 5 }];
    expect(interpolateKeys(keys, 0, FIELDS, DEFAULTS, LINEAR)).toEqual({ val: 5 });
    expect(interpolateKeys(keys, 10, FIELDS, DEFAULTS, LINEAR)).toEqual({ val: 5 });
    expect(interpolateKeys(keys, 999, FIELDS, DEFAULTS, LINEAR)).toEqual({ val: 5 });
  });

  it('a key that omits the field falls back to the supplied default, not undefined/NaN', () => {
    const keys: ValKey[] = [{ at: 0 }];
    expect(interpolateKeys(keys, 0, FIELDS, { val: 7 }, LINEAR)).toEqual({ val: 7 });
  });

  it('clamps BEFORE the first key to that key\'s own value', () => {
    const keys: ValKey[] = [
      { at: 10, val: 100 },
      { at: 20, val: 200 },
    ];
    expect(interpolateKeys(keys, 0, FIELDS, DEFAULTS, LINEAR)).toEqual({ val: 100 });
    expect(interpolateKeys(keys, -50, FIELDS, DEFAULTS, LINEAR)).toEqual({ val: 100 });
  });

  it('clamps AFTER the last key to that key\'s own value', () => {
    const keys: ValKey[] = [
      { at: 10, val: 100 },
      { at: 20, val: 200 },
    ];
    expect(interpolateKeys(keys, 30, FIELDS, DEFAULTS, LINEAR)).toEqual({ val: 200 });
    expect(interpolateKeys(keys, 10_000, FIELDS, DEFAULTS, LINEAR)).toEqual({ val: 200 });
  });

  it('linearly interpolates between two keys at the midpoint, with a linear ease', () => {
    const keys: ValKey[] = [
      { at: 0, val: 0 },
      { at: 10, val: 100 },
    ];
    expect(interpolateKeys(keys, 5, FIELDS, DEFAULTS, LINEAR).val).toBeCloseTo(50, 5);
    expect(interpolateKeys(keys, 2.5, FIELDS, DEFAULTS, LINEAR).val).toBeCloseTo(25, 5);
  });

  it('resolves several keys, picking the correct surrounding pair for a middle key', () => {
    const keys: ValKey[] = [
      { at: 0, val: 0 },
      { at: 10, val: 100 },
      { at: 20, val: 0 },
    ];
    expect(interpolateKeys(keys, 5, FIELDS, DEFAULTS, LINEAR).val).toBeCloseTo(50, 5);
    expect(interpolateKeys(keys, 10, FIELDS, DEFAULTS, LINEAR).val).toBeCloseTo(100, 5);
    expect(interpolateKeys(keys, 15, FIELDS, DEFAULTS, LINEAR).val).toBeCloseTo(50, 5);
  });

  it('interpolates correctly regardless of input order (sorts by `at` itself)', () => {
    const sorted: ValKey[] = [
      { at: 0, val: 0 },
      { at: 10, val: 100 },
    ];
    const reversed: ValKey[] = [
      { at: 10, val: 100 },
      { at: 0, val: 0 },
    ];
    expect(interpolateKeys(reversed, 5, FIELDS, DEFAULTS, LINEAR)).toEqual(
      interpolateKeys(sorted, 5, FIELDS, DEFAULTS, LINEAR),
    );
  });

  it('an authored per-key `ease` is honoured over the fallback ease', () => {
    // `design.ease.anticipate` — an asymmetric curve (unlike `inOut`, which
    // is point-symmetric and happens to still land on 0.5 at t=0.5): at the
    // midpoint it resolves to ~0.597, not 0.5, so it's a real discriminator
    // between "used the per-key ease" and "used the fallback."
    const asymmetricFallback: readonly [number, number, number, number] = [0.68, -0.55, 0.27, 1.55];
    const linearKeys: ValKey[] = [
      { at: 0, val: 0 },
      { at: 10, val: 100, ease: [0, 0, 1, 1] },
    ];
    const plainKeys: ValKey[] = [
      { at: 0, val: 0 },
      { at: 10, val: 100 },
    ];
    const withOwnLinearEase = interpolateKeys(linearKeys, 5, FIELDS, DEFAULTS, asymmetricFallback).val;
    const withFallbackOnly = interpolateKeys(plainKeys, 5, FIELDS, DEFAULTS, asymmetricFallback).val;
    expect(withOwnLinearEase).toBeCloseTo(50, 5); // the key's own linear ease won, not the asymmetric fallback
    expect(withFallbackOnly).not.toBeCloseTo(50, 1); // confirms the fallback WOULD have differed if used
    expect(withFallbackOnly).toBeCloseTo(59.66, 1);
  });

  it('resolves multiple fields independently in one call (the camera\'s x/y/zoom shape)', () => {
    type XY = KeyframeBase & { x?: number; y?: number };
    const keys: XY[] = [
      { at: 0, x: 0, y: 0 },
      { at: 10, x: 100, y: -50 },
    ];
    const result = interpolateKeys(keys, 5, ['x', 'y'] as const, { x: 0, y: 0 }, LINEAR);
    expect(result.x).toBeCloseTo(50, 5);
    expect(result.y).toBeCloseTo(-25, 5);
  });
});

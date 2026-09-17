/**
 * D-341 — the `plot` primitive's per-annotation `dy`, and the one thing that
 * must not have changed: a label with no `dy` sits exactly where it always sat.
 *
 * Lives in `@apelles/motion`'s test suite for the same reason
 * `graphEdge.test.ts` / `ambientDrift.test.ts` / `theme.test.ts` do —
 * `@apelles/motion-engine` has no `test` script of its own — importing the pure
 * function across the package boundary the same established way.
 */
import { describe, it, expect } from 'vitest';
import { plotLabelY } from '@apelles/motion-engine/src/primitives/Plot';

/** The two lifts `Plot.tsx` applied to EVERY label before this field existed. */
const PRE_D341 = { lift: 26, troughLift: 82 };

describe('D-341 — an absent dy is the pre-existing placement', () => {
  it('undefined === the pre-D-341 lift, exactly, on a non-trough point', () => {
    expect(plotLabelY(400, false, undefined)).toBe(400 - PRE_D341.lift);
  });

  it('undefined === the pre-D-341 lift, exactly, on a trough', () => {
    expect(plotLabelY(400, true, undefined)).toBe(400 - PRE_D341.troughLift);
  });

  it('an explicit 0 is indistinguishable from absent', () => {
    expect(plotLabelY(400, true, 0)).toBe(plotLabelY(400, true, undefined));
    expect(plotLabelY(400, false, 0)).toBe(plotLabelY(400, false, undefined));
  });

  it('a trough still sits further from its point than a non-trough does', () => {
    expect(plotLabelY(400, true, undefined)).toBeLessThan(
      plotLabelY(400, false, undefined),
    );
  });
});

describe('D-341 — dy offsets the automatic placement, in screen px', () => {
  it('negative lifts the label further from the curve', () => {
    expect(plotLabelY(400, true, -60)).toBe(plotLabelY(400, true, undefined) - 60);
  });

  it('positive drops it back toward the curve', () => {
    expect(plotLabelY(400, false, 18)).toBe(plotLabelY(400, false, undefined) + 18);
  });

  it('composes additively, independent of which branch was taken', () => {
    const delta = -47.5;
    for (const isTrough of [true, false]) {
      expect(plotLabelY(400, isTrough, delta) - plotLabelY(400, isTrough, 0)).toBe(
        delta,
      );
    }
  });
});

describe('D-341 — a malformed dy is ignored, never propagated', () => {
  it('a hand-authored manifest cannot produce a NaN y', () => {
    // `layer` is `.passthrough()` in the manifest schema, so a `plot` layer's
    // `annotate` items are not validated field by field — a typo really does
    // arrive as a string (`"dy": "-60"`), and `NaN` in an SVG `y` attribute
    // silently drops the whole label. Same failure mode `graphEdgeStroke`
    // guards against for `weight` (D-340).
    for (const bad of [Number.NaN, Infinity, -Infinity, undefined]) {
      const y = plotLabelY(400, true, bad as number | undefined);
      expect(Number.isFinite(y)).toBe(true);
    }
    // and the fallback is the automatic placement, not a silently moved label
    expect(plotLabelY(400, true, Number.NaN)).toBe(plotLabelY(400, true, undefined));
  });
});

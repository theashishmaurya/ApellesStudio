/**
 * D-340 — the `graph` primitive's per-edge `weight`, and the one thing that
 * must not have changed: an edge with no `weight` draws exactly the stroke it
 * always drew.
 *
 * Lives in `@apelles/motion`'s test suite for the same reason
 * `ambientDrift.test.ts` / `interpolateKeys.test.ts` / `theme.test.ts` do —
 * `@apelles/motion-engine` has no `test` script of its own — importing the pure
 * function across the package boundary the same established way.
 */
import { describe, it, expect } from 'vitest';
import { graphEdgeStroke, resolvableEdges } from '@apelles/motion-engine/src/primitives/Graph';

/** The stroke `Graph.tsx` drew for EVERY edge before this field existed. */
const PRE_D331 = { strokeWidth: 2.5, opacity: 1 };

describe('D-340 — an absent weight is the pre-existing full-strength stroke', () => {
  it('undefined === the pre-D-340 constants, exactly', () => {
    expect(graphEdgeStroke(undefined)).toEqual(PRE_D331);
  });

  it('an explicit 1 is indistinguishable from absent', () => {
    expect(graphEdgeStroke(1)).toEqual(graphEdgeStroke(undefined));
  });
});

describe('D-340 — weight scales both channels, monotonically', () => {
  it('a weaker edge is both thinner AND dimmer, never one or the other', () => {
    const strong = graphEdgeStroke(1);
    const mid = graphEdgeStroke(0.5);
    const weak = graphEdgeStroke(0);
    expect(mid.strokeWidth).toBeLessThan(strong.strokeWidth);
    expect(weak.strokeWidth).toBeLessThan(mid.strokeWidth);
    expect(mid.opacity).toBeLessThan(strong.opacity);
    expect(weak.opacity).toBeLessThan(mid.opacity);
  });

  it('is strictly increasing across the whole range', () => {
    const steps = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1];
    for (let i = 1; i < steps.length; i++) {
      const a = graphEdgeStroke(steps[i - 1]);
      const b = graphEdgeStroke(steps[i]);
      expect(b.strokeWidth).toBeGreaterThan(a.strokeWidth);
      expect(b.opacity).toBeGreaterThan(a.opacity);
    }
  });

  it('weight 0 still DRAWS — a floor, not a disappearance', () => {
    // "these two barely relate" is a fact worth seeing; an edge that vanishes
    // entirely is indistinguishable from one the author forgot to write.
    const weak = graphEdgeStroke(0);
    expect(weak.strokeWidth).toBeGreaterThan(0);
    expect(weak.opacity).toBeGreaterThan(0);
  });
});

describe('D-340 — out-of-range and malformed weights are clamped, never thrown', () => {
  it('clamps above 1 and below 0 to the endpoints', () => {
    expect(graphEdgeStroke(4)).toEqual(graphEdgeStroke(1));
    expect(graphEdgeStroke(-3)).toEqual(graphEdgeStroke(0));
  });

  it('a hand-authored manifest cannot produce a NaN stroke', () => {
    // `layer` is `.passthrough()` in the schema, so a `graph` layer's `edges`
    // are not validated field by field — a typo really does arrive as a string
    // (`"weight": "0.4"`), and `Math.max(0, Math.min(1, NaN))` is `NaN`, which
    // in an SVG attribute silently drops the whole stroke. Caught by this test
    // on its first run, and fixed rather than asserted away.
    for (const bad of [Number.NaN, Infinity, -Infinity, undefined]) {
      const r = graphEdgeStroke(bad);
      expect(Number.isFinite(r.strokeWidth)).toBe(true);
      expect(Number.isFinite(r.opacity)).toBe(true);
    }
    // and the fallback is full strength, not a silently weakened edge
    expect(graphEdgeStroke(Number.NaN)).toEqual(PRE_D331);
  });
});

/**
 * B-211, second root cause (2026-09-17). The first half of that fix guarded the
 * render-side `layout[id]` dereference and shipped with no test — so it was not
 * noticed that d3-force throws FIRST, from inside the layout memo, and the
 * preview kept wedging. These pin the guard that actually stops it.
 */
describe('B-211 — edges naming a missing node never reach d3-force', () => {
  const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('keeps every edge whose endpoints both exist', () => {
    const edges = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ];
    expect(resolvableEdges(nodes, edges)).toEqual(edges);
  });

  it('drops an edge whose source, target, or both are missing', () => {
    expect(
      resolvableEdges(nodes, [
        { from: 'a', to: 'b' },
        { from: 'a', to: 'GONE' },
        { from: 'GONE', to: 'c' },
        { from: 'GONE', to: 'ALSO_GONE' },
      ]),
    ).toEqual([{ from: 'a', to: 'b' }]);
  });

  it('survives the real mid-edit state: nodes replaced wholesale, edges stale', () => {
    // Exactly what wedged the preview live — `motion_set_layer_field` writes
    // `nodes` and `edges` as two separate ops, so between them every edge
    // dangles. d3-force would throw on the first of these.
    const newNodes = [{ id: 'w_sum' }, { id: 'w_off' }];
    const staleEdges = [
      { from: 'n1', to: 'n2' },
      { from: 'n2', to: 'n3' },
    ];
    expect(resolvableEdges(newNodes, staleEdges)).toEqual([]);
  });

  it('carries each kept edge through untouched, weight included', () => {
    const weighted = [{ from: 'a', to: 'b', weight: 0.4, directed: true }];
    expect(resolvableEdges(nodes, weighted)[0]).toEqual(weighted[0]);
  });

  it('an empty node list drops everything rather than throwing', () => {
    expect(resolvableEdges([], [{ from: 'a', to: 'b' }])).toEqual([]);
  });
});

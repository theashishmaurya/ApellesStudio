/**
 * B-225 — a canvas reflow (D-347) moves a `graph` layer's node POSITIONS but
 * used to leave every label's FONT SIZE fixed at the primitive's constant, so
 * a comfortable label gap could become a collision after reflow. Fixed by
 * deriving the label size from the actual on-screen clearance between node
 * centres, inside `Graph.tsx`'s own frozen-layout memo — deliberately NOT a
 * new `propCatalog.ts` manifest field (that file's size-field registry is
 * mid-edit for the separate, unrelated B-213 in this session).
 *
 * Lives in `@apelles/motion`'s test suite for the same reason
 * `graphEdge.test.ts` / `plotLabel.test.ts` do — `@apelles/motion-engine` has
 * no `test` script of its own — importing the pure function across the
 * package boundary the same established way.
 */
import { describe, it, expect } from 'vitest';
import {
  graphLabelFontSize,
  GRAPH_LABEL_BASE_FONT_SIZE,
  GRAPH_LABEL_MIN_FONT_SIZE,
} from '@apelles/motion-engine/src/primitives/Graph';

/** `Graph.tsx`'s own private tuning constants for this formula, duplicated
 *  here the same way `graphEdge.test.ts` hardcodes the pre-D-340 stroke
 *  constants — these are the numbers the function's OUTPUT is checked
 *  against, not a re-export of implementation detail. */
const CHAR_WIDTH_RATIO = 0.42;
const SAFETY_MARGIN = 0.85;

describe('B-225 — nothing to collide with never shrinks anything', () => {
  it('no nodes at all', () => {
    expect(graphLabelFontSize([])).toBe(GRAPH_LABEL_BASE_FONT_SIZE);
  });

  it('one labelled node has no neighbour to collide with', () => {
    expect(graphLabelFontSize([{ label: 'solo', x: 0, y: 0 }])).toBe(GRAPH_LABEL_BASE_FONT_SIZE);
  });

  it('unlabelled nodes never constrain anything, however close', () => {
    expect(
      graphLabelFontSize([
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ]),
    ).toBe(GRAPH_LABEL_BASE_FONT_SIZE);
  });
});

/**
 * The actual repro from B-225's own finding: `c040-qkv`'s `graph` layer had
 * node `v` (label `the content of "anything"`, 25 chars) sitting 509px from
 * neighbour `k2` (label `anything`, 8 chars) — "comfortable clearance" at the
 * base font size, confirmed at two frames. `motion_set_project_settings
 * (reflow=True)` then scaled every node position by `sx 0.6521`, closing that
 * gap to ~332px and producing a real, confirmed label collision
 * (`"anythingthe content of \"anything\""`).
 */
describe('B-225 — the real reflow repro: comfortable pre-reflow, would-collide post-reflow', () => {
  const LONG = 'the content of "anything"'; // 25 chars, per the bug's own count
  const SHORT = 'anything'; // 8 chars
  const PRE_REFLOW_DIST = 509;
  const REFLOW_SX = 0.6521; // the exact factor D-347's reflow applied in the incident
  const POST_REFLOW_DIST = PRE_REFLOW_DIST * REFLOW_SX;

  const nodesAtDistance = (dist: number) => [
    { label: LONG, x: 0, y: 0 },
    { label: SHORT, x: dist, y: 0 },
  ];

  it('pre-reflow: 509px is comfortable clearance — no shrink from the base size', () => {
    expect(graphLabelFontSize(nodesAtDistance(PRE_REFLOW_DIST))).toBe(GRAPH_LABEL_BASE_FONT_SIZE);
  });

  it('post-reflow: the same pair, now ~332px apart, DOES shrink', () => {
    const size = graphLabelFontSize(nodesAtDistance(POST_REFLOW_DIST));
    expect(size).toBeLessThan(GRAPH_LABEL_BASE_FONT_SIZE);
    expect(size).toBeGreaterThanOrEqual(GRAPH_LABEL_MIN_FONT_SIZE);
  });

  it('the shrunk size no longer collides: estimated combined label width fits inside the new gap', () => {
    const size = graphLabelFontSize(nodesAtDistance(POST_REFLOW_DIST));
    const estimatedCombinedWidth = (LONG.length + SHORT.length) * CHAR_WIDTH_RATIO * size;
    // A real margin below the raw distance, not just short of overlap exactly
    // at the boundary — see `GRAPH_LABEL_SAFETY_MARGIN`.
    expect(estimatedCombinedWidth).toBeLessThanOrEqual(POST_REFLOW_DIST * SAFETY_MARGIN + 1e-6);
  });
});

describe('B-225 — general behaviour of the derived size', () => {
  it('is governed by the single tightest pair, not an average across all nodes', () => {
    const tight = graphLabelFontSize([
      { label: 'aaaaaaaaaa', x: 0, y: 0 },
      { label: 'bbbbbbbbbb', x: 180, y: 0 },
    ]);
    const looser = graphLabelFontSize([
      { label: 'aaaaaaaaaa', x: 0, y: 0 },
      { label: 'bbbbbbbbbb', x: 280, y: 0 },
    ]);
    // Neither hits the base cap or the floor at these distances/lengths, so
    // this is a real comparison of the derived value, not just clamping.
    expect(tight).toBeGreaterThan(GRAPH_LABEL_MIN_FONT_SIZE);
    expect(tight).toBeLessThan(GRAPH_LABEL_BASE_FONT_SIZE);
    expect(looser).toBeGreaterThan(GRAPH_LABEL_MIN_FONT_SIZE);
    expect(looser).toBeLessThan(GRAPH_LABEL_BASE_FONT_SIZE);
    expect(tight).toBeLessThan(looser);
  });

  it('a far-away unrelated node never pulls a tight local pair back up', () => {
    const withoutFarNode = graphLabelFontSize([
      { label: 'aaaaaaaaaa', x: 0, y: 0 },
      { label: 'bbbbbbbbbb', x: 180, y: 0 },
    ]);
    const withFarNode = graphLabelFontSize([
      { label: 'aaaaaaaaaa', x: 0, y: 0 },
      { label: 'bbbbbbbbbb', x: 180, y: 0 },
      { label: 'c', x: 100_000, y: 100_000 },
    ]);
    expect(withFarNode).toBe(withoutFarNode);
  });

  it('floors at GRAPH_LABEL_MIN_FONT_SIZE rather than shrinking toward zero for a true content collision', () => {
    // Two labels crammed one pixel apart is a content problem no shrink can
    // fully solve — see B-225's own "real fix" note on the floor's purpose.
    const size = graphLabelFontSize([
      { label: 'quite a long node label', x: 0, y: 0 },
      { label: 'another quite long label', x: 1, y: 0 },
    ]);
    expect(size).toBe(GRAPH_LABEL_MIN_FONT_SIZE);
  });

  it('never exceeds the base size, however far apart the nodes are', () => {
    const size = graphLabelFontSize([
      { label: 'a', x: 0, y: 0 },
      { label: 'b', x: 1_000_000, y: 0 },
    ]);
    expect(size).toBe(GRAPH_LABEL_BASE_FONT_SIZE);
  });

  it('uses real (Euclidean) on-screen distance, not just the x-axis separation', () => {
    const diagonal = graphLabelFontSize([
      { label: 'aaaaaaaaaa', x: 0, y: 0 },
      { label: 'bbbbbbbbbb', x: 30, y: 40 }, // 3-4-5 triangle: distance 50
    ]);
    const sameXOnly = graphLabelFontSize([
      { label: 'aaaaaaaaaa', x: 0, y: 0 },
      { label: 'bbbbbbbbbb', x: 50, y: 0 },
    ]);
    expect(diagonal).toBeCloseTo(sameXOnly, 6);
  });
});

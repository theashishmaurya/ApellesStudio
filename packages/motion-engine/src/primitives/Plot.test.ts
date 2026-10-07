/**
 * B-239 — `Plot` baked all five of its type sizes in as px literals, so
 * D-347's canvas reflow (which scales the plot's own `width`/`height`, and
 * an authored `text` layer's `size`, but cannot reach inside a primitive's
 * render) left the chart's own labels at their authored size inside a
 * shrunken chart. Fixed by `plotTypeScale` in `Plot.tsx`: one multiplier
 * derived from the plot's box against the box the sizes were authored for.
 *
 * Colocated with `Plot.tsx` in the plain `node` environment, the same shape
 * `Graph.test.ts` uses — this is a pure function and needs no DOM. (The
 * other `Plot` helper, `plotLabelY`, is still tested from `@apelles/motion`'s
 * `plotLabel.test.ts`, written before this package had a runner of its own;
 * not moved, out of scope for this fix.)
 */
import { describe, it, expect } from 'vitest';
import {
  plotTypeScale,
  PLOT_BASE_WIDTH,
  PLOT_BASE_HEIGHT,
  PLOT_TITLE_FONT_SIZE,
  PLOT_ANNOTATION_FONT_SIZE,
  PLOT_BASELINE_LABEL_FONT_SIZE,
  PLOT_AXIS_TITLE_FONT_SIZE,
  PLOT_TICK_FONT_SIZE,
  PLOT_TYPE_MIN_FONT_SIZE,
} from './Plot';

/** The five literals `Plot.tsx` carried before this fix, in the order the
 *  bug entry lists them (28 at :265, 24 at :285/:300/:317, 26 at :349/:404).
 *  Asserted here so the named constants cannot silently drift from the
 *  rendering the primitive was signed off at. */
const PRE_FIX_SIZES = {
  title: 28,
  yTitle: 24,
  xTitle: 24,
  tick: 24,
  baselineLabel: 26,
  annotation: 26,
} as const;

describe('B-239 — the authored box is unchanged', () => {
  it('the named constants are the six literals that were there', () => {
    expect(PLOT_TITLE_FONT_SIZE).toBe(PRE_FIX_SIZES.title);
    expect(PLOT_AXIS_TITLE_FONT_SIZE).toBe(PRE_FIX_SIZES.yTitle);
    expect(PLOT_AXIS_TITLE_FONT_SIZE).toBe(PRE_FIX_SIZES.xTitle);
    expect(PLOT_TICK_FONT_SIZE).toBe(PRE_FIX_SIZES.tick);
    expect(PLOT_BASELINE_LABEL_FONT_SIZE).toBe(PRE_FIX_SIZES.baselineLabel);
    expect(PLOT_ANNOTATION_FONT_SIZE).toBe(PRE_FIX_SIZES.annotation);
  });

  it('the scale is exactly 1 at the primitive’s default box', () => {
    expect(plotTypeScale(PLOT_BASE_WIDTH, PLOT_BASE_HEIGHT)).toBe(1);
  });

  it('so every role renders at exactly its pre-fix size there', () => {
    const s = plotTypeScale(PLOT_BASE_WIDTH, PLOT_BASE_HEIGHT);
    expect(PLOT_TITLE_FONT_SIZE * s).toBe(PRE_FIX_SIZES.title);
    expect(PLOT_AXIS_TITLE_FONT_SIZE * s).toBe(PRE_FIX_SIZES.yTitle);
    expect(PLOT_TICK_FONT_SIZE * s).toBe(PRE_FIX_SIZES.tick);
    expect(PLOT_BASELINE_LABEL_FONT_SIZE * s).toBe(PRE_FIX_SIZES.baselineLabel);
    expect(PLOT_ANNOTATION_FONT_SIZE * s).toBe(PRE_FIX_SIZES.annotation);
  });
});

/**
 * The real incident. c038's canvas went 1920×1080 → 1252×1016, so D-347's
 * reflow scaled a plot's `width` by `sx = 0.6521` and its `height` by
 * `sy = 0.9407`. Authored captions around it landed at 22–23 px while the
 * chart's own ticks stayed at 24 — the hierarchy inverted.
 */
describe('B-239 — the c038 reflow, with its own factors', () => {
  const SX = 1252 / 1920; // 0.6521
  const SY = 1016 / 1080; // 0.9407
  const W = PLOT_BASE_WIDTH * SX;
  const H = PLOT_BASE_HEIGHT * SY;

  it('the chart’s type shrinks with the chart', () => {
    expect(plotTypeScale(W, H)).toBeCloseTo(SX, 5);
  });

  it('a tick no longer outsizes a caption that reflowed to 22-23 px', () => {
    const tick = PLOT_TICK_FONT_SIZE * plotTypeScale(W, H);
    expect(PLOT_TICK_FONT_SIZE).toBeGreaterThan(23); // the pre-fix inversion
    expect(tick).toBeLessThan(22); // 15.65 px — back under the captions
  });

  it('and the hierarchy inside the chart is preserved exactly', () => {
    const s = plotTypeScale(W, H);
    expect(PLOT_TITLE_FONT_SIZE * s).toBeGreaterThan(PLOT_ANNOTATION_FONT_SIZE * s);
    expect(PLOT_ANNOTATION_FONT_SIZE * s).toBeGreaterThan(PLOT_TICK_FONT_SIZE * s);
    // the ratios are the authored ones, untouched
    expect((PLOT_TITLE_FONT_SIZE * s) / (PLOT_TICK_FONT_SIZE * s)).toBeCloseTo(28 / 24, 10);
  });
});

describe('B-239 — `min` of the two ratios, because type cannot stretch', () => {
  it('a box that only got narrower scales by the width ratio', () => {
    expect(plotTypeScale(PLOT_BASE_WIDTH * 0.8, PLOT_BASE_HEIGHT)).toBeCloseTo(0.8, 10);
  });

  it('a box that only got shorter scales by the height ratio', () => {
    expect(plotTypeScale(PLOT_BASE_WIDTH, PLOT_BASE_HEIGHT * 0.8)).toBeCloseTo(0.8, 10);
  });

  it('a wider-but-shorter box takes the axis that shrank, not an average', () => {
    const s = plotTypeScale(PLOT_BASE_WIDTH * 2, PLOT_BASE_HEIGHT * 0.7);
    expect(s).toBeCloseTo(0.7, 10);
  });

  it('a uniformly bigger chart gets proportionally bigger type — no cap', () => {
    expect(plotTypeScale(PLOT_BASE_WIDTH * 2, PLOT_BASE_HEIGHT * 2)).toBe(2);
    expect(plotTypeScale(PLOT_BASE_WIDTH * 10, PLOT_BASE_HEIGHT * 10)).toBe(10);
  });
});

describe('B-239 — the legibility floor', () => {
  it('does not bind at the c038 reflow, or anywhere near an ordinary one', () => {
    expect(plotTypeScale(PLOT_BASE_WIDTH * 0.6521, PLOT_BASE_HEIGHT * 0.9407)).toBeCloseTo(
      0.6521,
      10,
    );
    // it starts to bind only once the smallest role would drop under 14 px
    expect(PLOT_TYPE_MIN_FONT_SIZE / PLOT_TICK_FONT_SIZE).toBeCloseTo(0.5833, 4);
  });

  it('the smallest role never goes under the floor, however small the box', () => {
    for (const box of [
      [10, 10],
      [1, 520],
      [820, 1],
      [0.001, 0.001],
    ] as Array<[number, number]>) {
      const smallest = PLOT_TICK_FONT_SIZE * plotTypeScale(box[0], box[1]);
      expect(smallest).toBeGreaterThanOrEqual(PLOT_TYPE_MIN_FONT_SIZE);
    }
  });

  it('the floor lands exactly on the floor font size for the tick role', () => {
    expect(PLOT_TICK_FONT_SIZE * plotTypeScale(1, 1)).toBeCloseTo(PLOT_TYPE_MIN_FONT_SIZE, 10);
  });
});

/**
 * `width`/`height` reach this primitive through a `.passthrough()` schema
 * layer and are never validated item by item, so a hand-authored
 * `"width": "820"` really can arrive as a non-number — the same guard
 * `plotLabelY` needs for `dy` (D-341) and `graphEdgeStroke` for `weight`
 * (D-340), for the same reason: a `NaN` here would silently drop every
 * label in the chart.
 */
describe('B-239 — a non-numeric or degenerate box falls back to 1, never NaN', () => {
  const BAD: Array<[unknown, unknown]> = [
    [NaN, 520],
    [820, NaN],
    [Infinity, 520],
    [820, -Infinity],
    [0, 520],
    [820, 0],
    [-820, -520],
  ];
  for (const [w, h] of BAD) {
    it(`${String(w)} × ${String(h)}`, () => {
      const s = plotTypeScale(w as number, h as number);
      expect(Number.isFinite(s)).toBe(true);
      expect(s).toBe(1);
    });
  }
});

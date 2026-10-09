import { describe, it, expect } from 'vitest';
import type { Manifest } from '@apelles/motion-engine/src/engine/schema';
import { reflowManifest, reflowFactors } from './manifestReflow';

/** A manifest carrying one layer of every shape the reflow has a rule for,
 *  plus the values it must NOT touch. 1920x1080 so the ratios below are the
 *  real ones this feature was built for. */
function fixture(): Manifest {
  return {
    title: 'fixture',
    width: 1920,
    height: 1080,
    fps: 30,
    scenes: [
      {
        id: 's',
        dur: 5,
        layers: [
          { use: 'text', id: 't', at: 0, x: 200, y: 900, size: 46, maxWidth: 1650, weight: 600 },
          { use: 'emphasis', id: 'e', at: 0, box: [400, 200, 600, 120], seed: 7 },
          {
            use: 'graph',
            id: 'g',
            at: 0,
            width: 1920,
            height: 900,
            nodeR: 52,
            nodes: [
              { id: 'a', x: 960, y: 540 },
              { id: 'b', x: 1440, y: 270 },
            ],
            edges: [{ from: 'a', to: 'b', weight: 0.5 }],
          },
          { use: 'matrix', id: 'm', at: 0, x: 180, y: 400, rows: 4, cols: 7, cell: 62, gap: 12 },
          {
            use: 'plot',
            id: 'p',
            at: 0,
            x: 300,
            y: 190,
            width: 1340,
            height: 600,
            values: [72, 62, 56.8],
            baseline: 56.1,
            annotate: [{ i: 2, text: 'here', dy: -72 }],
          },
          { use: 'layers', id: 'l', at: 0, x: 860, y: 620, cardW: 760, cardH: 150, gap: 52, tilt: 6 },
          {
            use: 'text',
            id: 'k',
            at: 0,
            x: 100,
            y: 100,
            size: 40,
            transform: { keys: [{ at: 0, x: 240, y: -60, opacity: -1, scale: 0.5 }] },
          },
        ],
      },
    ],
  } as unknown as Manifest;
}

const layerById = (m: Manifest, id: string) =>
  (m.scenes[0].layers ?? []).find((l) => (l as unknown as Record<string, unknown>).id === id) as unknown as Record<
    string,
    unknown
  >;

describe('reflowFactors', () => {
  it('is one ratio per axis, and `min` for anything that cannot stretch', () => {
    expect(reflowFactors({ width: 1920, height: 1080 }, { width: 1252, height: 1016 })).toEqual({
      sx: 1252 / 1920,
      sy: 1016 / 1080,
      su: 1252 / 1920,
    });
  });

  it('is the identity when nothing changes', () => {
    expect(reflowFactors({ width: 800, height: 600 }, { width: 800, height: 600 })).toEqual({ sx: 1, sy: 1, su: 1 });
  });
});

describe('reflowManifest', () => {
  // The real case this was built for: the c040 explainer's graphics moving
  // from a full 16:9 frame to the 70%-wide right panel of a split screen.
  const TO = { width: 1252, height: 1016 };
  const sx = 1252 / 1920;
  const sy = 1016 / 1080;

  it('scales x-positions and widths by the WIDTH ratio, y and heights by the HEIGHT ratio', () => {
    const { manifest } = reflowManifest(fixture(), TO);
    const text = layerById(manifest, 't');
    expect(text.x).toBe(Math.round(200 * sx));
    expect(text.y).toBe(Math.round(900 * sy));
    expect(text.maxWidth).toBe(Math.round(1650 * sx));

    const graph = layerById(manifest, 'g');
    expect(graph.width).toBe(Math.round(1920 * sx));
    expect(graph.height).toBe(Math.round(900 * sy));

    const plot = layerById(manifest, 'p');
    expect(plot.x).toBe(Math.round(300 * sx));
    expect(plot.width).toBe(Math.round(1340 * sx));
    expect(plot.height).toBe(Math.round(600 * sy));
  });

  it("moves a graph's own node coordinates with its layout box", () => {
    const { manifest } = reflowManifest(fixture(), TO);
    const nodes = layerById(manifest, 'g').nodes as Array<Record<string, unknown>>;
    expect(nodes[0]).toEqual({ id: 'a', x: Math.round(960 * sx), y: Math.round(540 * sy) });
    expect(nodes[1]).toEqual({ id: 'b', x: Math.round(1440 * sx), y: Math.round(270 * sy) });
  });

  it("splits an emphasis box's [x,y,w,h] across the two ratios", () => {
    const { manifest } = reflowManifest(fixture(), TO);
    expect(layerById(manifest, 'e').box).toEqual([
      Math.round(400 * sx),
      Math.round(200 * sy),
      Math.round(600 * sx),
      Math.round(120 * sy),
    ]);
  });

  it('scales a font size, a gap, a cell and a radius UNIFORMLY, never per axis', () => {
    const { manifest, factors } = reflowManifest(fixture(), TO);
    expect(factors.su).toBe(sx); // the narrower ratio, here the width one
    expect(layerById(manifest, 't').size).toBe(Math.round(46 * factors.su));
    expect(layerById(manifest, 'm').cell).toBe(Math.round(62 * factors.su));
    expect(layerById(manifest, 'm').gap).toBe(Math.round(12 * factors.su));
    expect(layerById(manifest, 'g').nodeR).toBe(Math.round(52 * factors.su));
    expect(layerById(manifest, 'l').gap).toBe(Math.round(52 * factors.su));
  });

  it("moves a layer-transform key's pixel offsets and leaves its unitless ones alone", () => {
    const { manifest } = reflowManifest(fixture(), TO);
    const keys = (layerById(manifest, 'k').transform as Record<string, unknown>).keys as Array<Record<string, unknown>>;
    expect(keys[0].x).toBe(Math.round(240 * sx));
    expect(keys[0].y).toBe(Math.round(-60 * sy));
    expect(keys[0].opacity).toBe(-1);
    expect(keys[0].scale).toBe(0.5);
    expect(keys[0].at).toBe(0);
  });

  it("moves a plot annotation's offset but never its DATA", () => {
    const { manifest } = reflowManifest(fixture(), TO);
    const plot = layerById(manifest, 'p');
    expect((plot.annotate as Array<Record<string, unknown>>)[0]).toEqual({
      i: 2,
      text: 'here',
      dy: Math.round(-72 * sy),
    });
    // The series itself is content, not geometry, and must come back untouched.
    expect(plot.values).toEqual([72, 62, 56.8]);
    expect(plot.baseline).toBe(56.1);
  });

  it('leaves every unitless and content field exactly as it found it', () => {
    const { manifest } = reflowManifest(fixture(), TO);
    expect(layerById(manifest, 't').weight).toBe(600);
    expect(layerById(manifest, 'e').seed).toBe(7);
    expect(layerById(manifest, 'm').rows).toBe(4);
    expect(layerById(manifest, 'm').cols).toBe(7);
    expect(layerById(manifest, 'l').tilt).toBe(6);
    expect(layerById(manifest, 'g').edges).toEqual([{ from: 'a', to: 'b', weight: 0.5 }]);
  });

  it('is the identity for a no-op resize — the safety property', () => {
    const before = fixture();
    const { manifest } = reflowManifest(fixture(), { width: 1920, height: 1080 });
    expect(manifest).toEqual(before);
  });

  it('reports what it moved, and what it deliberately did not', () => {
    const m = fixture();
    (m.scenes[0] as unknown as Record<string, unknown>).scene3d = { children: [{ use: 'particleflow' }] };
    const r = reflowManifest(m, TO);
    expect(r.layersMoved).toBe(7);
    expect(r.fieldsMoved).toBeGreaterThan(20);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]).toContain('scene3d');
  });

  it('never collapses a real extent to zero, however hard the shrink', () => {
    const { manifest } = reflowManifest(fixture(), { width: 32, height: 18 });
    const text = layerById(manifest, 't');
    expect(text.size as number).toBeGreaterThanOrEqual(1);
    expect(text.maxWidth as number).toBeGreaterThanOrEqual(1);
    expect(layerById(manifest, 'g').nodeR as number).toBeGreaterThanOrEqual(1);
  });
});

/**
 * D-372 — which axis an AUTHORED `text.size` scales by: the second, open half
 * of B-239.
 *
 * B-239 measured c038's 1920×1080 → 1252×1016 reshape, where captions
 * reflowed by `su` (= `sx` = 0.6521) to 22–23 px while every primitive's own
 * internal type stayed at its hardcoded 24–40 px, and proposed scaling type
 * by `sy` (0.9407) instead so it "tracks height". D-372 keeps `su` and fixes
 * the primitives instead (`plotTypeScale`, `layersTypeScale`): the inversion
 * was the primitives not scaling at all, and `sy` buys its bigger type by
 * breaking the one layout guarantee this module can make.
 *
 * The property these cases pin is that guarantee: **a reflow never increases
 * a text block's line count.** A block's characters-per-line is
 * `maxWidth / size`, `maxWidth` scales by `sx`, and `su = min(sx, sy) <= sx`
 * — so the ratio can only grow. Any factor above `sx` (which `sy` is,
 * whenever the canvas lost relatively more width — exactly the c038 case)
 * can only re-wrap, and this module cannot measure text to know that it did.
 *
 * The guarantee is exact in the FACTORS; the values written are whole px, and
 * rounding can give half a pixel back in either direction. The cases below
 * state both bounds separately rather than pretending the rounded one is the
 * clean inequality.
 */
describe('D-372 — a type size tracks the binding axis, never a wider one', () => {
  /** Every shape of reshape, including the two extremes. */
  const RESHAPES: Array<[string, { width: number; height: number }]> = [
    ['c038, the real incident (lost width, kept height)', { width: 1252, height: 1016 }],
    ['the same shape, bigger', { width: 2560, height: 1440 }],
    ['16:9 -> 9:16, a vertical reel', { width: 1080, height: 1920 }],
    ['9:16 -> 16:9, back again', { width: 3413, height: 1920 }],
    ['4:3 -> 16:9, same height', { width: 1920, height: 810 }],
    ['taller, same width', { width: 1920, height: 1440 }],
    ['a hard uniform shrink', { width: 480, height: 270 }],
    ['no-op', { width: 1920, height: 1080 }],
  ];

  for (const [name, to] of RESHAPES) {
    it(`${name}: the type factor never exceeds the width factor`, () => {
      const { manifest, factors } = reflowManifest(fixture(), to);
      expect(factors.su).toBeLessThanOrEqual(factors.sx);
      expect(factors.su).toBeLessThanOrEqual(factors.sy);

      // …so in exact arithmetic the block holds at least as many characters
      // per line as it did before: `(maxWidth·sx) / (size·su) >=
      // maxWidth / size`, because `su <= sx`.
      const idealAfter = (1650 * factors.sx) / (46 * factors.su);
      expect(idealAfter).toBeGreaterThanOrEqual(1650 / 46 - 1e-9);

      // What is actually WRITTEN is whole px (`px()`), which can move each of
      // the two by up to half a pixel — so the realised ratio is bounded by
      // the ideal with that half-pixel taken off the numerator and added to
      // the denominator, not by the ideal itself. At ordinary factors this is
      // a fraction of a percent; at a 4x shrink it is a few percent, and it
      // is the only way a reflow can cost a text block a character per line.
      const text = layerById(manifest, 't');
      const charsPerLineAfter = (text.maxWidth as number) / (text.size as number);
      expect(charsPerLineAfter).toBeGreaterThanOrEqual(
        (1650 * factors.sx - 0.5) / (46 * factors.su + 0.5),
      );
    });
  }

  it('on the c038 reshape that is `sx`, the narrower ratio — NOT `sy`', () => {
    const { manifest, factors } = reflowManifest(fixture(), { width: 1252, height: 1016 });
    expect(factors.su).toBe(factors.sx);
    expect(factors.sy).toBeGreaterThan(factors.sx); // the tension B-239 found
    expect(layerById(manifest, 't').size).toBe(Math.round(46 * factors.sx));
    // what `sy` would have written, and what this must NOT be
    expect(layerById(manifest, 't').size).not.toBe(Math.round(46 * factors.sy));
  });

  it('a reflow into a vertical reel SHRINKS type — it must never grow it', () => {
    // The case that rules `sy` out on its own: 16:9 -> 9:16 has `sy` = 1.778,
    // so "type tracks height" would scale every caption UP by 78% on a canvas
    // that just lost 44% of its width — guaranteed overflow, B-240's class of
    // failure, on a reshape this project does routinely.
    const { manifest, factors } = reflowManifest(fixture(), { width: 1080, height: 1920 });
    expect(factors.sy).toBeCloseTo(1.7777, 3);
    expect(layerById(manifest, 't').size).toBe(Math.round(46 * factors.sx));
    expect(layerById(manifest, 't').size as number).toBeLessThan(46);
  });

  it('when HEIGHT is the axis that shrank more, the type does track height', () => {
    // The other side of `min`: this is why `su` is not merely "the width
    // ratio with extra steps".
    const { manifest, factors } = reflowManifest(fixture(), { width: 1920, height: 810 });
    expect(factors.su).toBe(factors.sy);
    expect(layerById(manifest, 't').size).toBe(Math.round(46 * 0.75));
  });

  it('and the axis table still scales nothing else by a text-only rule', () => {
    // Splitting the type axis out would have had to leave these alone; the
    // table is per-field for exactly that reason, so this is the regression
    // guard for a future caller-selectable axis landing in the wrong column.
    const to = { width: 1252, height: 1016 };
    const { manifest, factors } = reflowManifest(fixture(), to);
    expect(layerById(manifest, 'm').cell).toBe(Math.round(62 * factors.su));
    expect(layerById(manifest, 'm').gap).toBe(Math.round(12 * factors.su));
    expect(layerById(manifest, 'l').gap).toBe(Math.round(52 * factors.su));
    expect(layerById(manifest, 'g').nodeR).toBe(Math.round(52 * factors.su));
  });
});

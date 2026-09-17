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

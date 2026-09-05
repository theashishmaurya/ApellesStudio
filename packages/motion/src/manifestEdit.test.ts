import { describe, it, expect } from 'vitest';
import { sample } from '@chroma/motion-engine/src/engine/sample';
import {
  selectedScene,
  selectedLayer,
  selectedCamera2d,
  selectedCamera3d,
  setLayerField,
  setSceneField,
  setCamera2d,
  setCamera3d,
  layerWorldPosition,
  setLayerPosition,
  layerWorldSize,
  setLayerSize,
  snapEmphasisToRect,
  SNAP_TO_LAYER_PAD,
  setLayerTransformField,
  parseJsonField,
} from './manifestEdit';
import { measureWorldMap } from './canvasGeometry';
import type { Selection } from './LayerList';

describe('selectedScene / selectedLayer / selectedCamera2d / selectedCamera3d', () => {
  it('resolves a real scene by index', () => {
    expect(selectedScene(sample, 0)?.id).toBe('hook');
    expect(selectedScene(sample, 99)).toBeNull();
  });

  it('resolves a 2D layer selection with its use', () => {
    const sel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 0 } };
    const found = selectedLayer(sample, sel);
    expect(found?.use).toBe('text');
    expect(found?.raw.text).toBe('EVERY call re-sends the whole prompt');
  });

  it('resolves a scene3d child selection', () => {
    const sel: Selection = { sceneIndex: 2, target: { kind: 'scene3d-child', index: 1 } };
    const found = selectedLayer(sample, sel);
    expect(found?.use).toBe('particleflow');
    expect(found?.raw.color).toBe('#e5484d');
  });

  it('returns null for an out-of-range layer index (stale selection)', () => {
    const sel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 99 } };
    expect(selectedLayer(sample, sel)).toBeNull();
  });

  it('returns null for a scene/camera target (not a layer)', () => {
    const sel: Selection = { sceneIndex: 0, target: { kind: 'scene' } };
    expect(selectedLayer(sample, sel)).toBeNull();
  });

  it('resolves the 2D camera keyframe array', () => {
    expect(selectedCamera2d(sample, 0)).toHaveLength(3);
    expect(selectedCamera2d(sample, 1)).toBeNull(); // scene "stack" has no camera
  });

  it('resolves the 3D camera keyframe array', () => {
    expect(selectedCamera3d(sample, 2)).toHaveLength(2);
    expect(selectedCamera3d(sample, 0)).toBeNull(); // scene "hook" has no scene3d
  });
});

describe('setLayerField', () => {
  it('sets a field without mutating the original manifest', () => {
    const sel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 0 } };
    const next = setLayerField(sample, sel, 'size', 100);
    expect(selectedLayer(next, sel)?.raw.size).toBe(100);
    expect(selectedLayer(sample, sel)?.raw.size).toBe(78); // original untouched
  });

  it('deletes a field when value is undefined', () => {
    const sel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 0 } };
    const next = setLayerField(sample, sel, 'size', undefined);
    expect(selectedLayer(next, sel)?.raw.size).toBeUndefined();
  });

  it('is a no-op (same manifest back) for a selection that does not resolve', () => {
    const sel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 99 } };
    const next = setLayerField(sample, sel, 'size', 100);
    expect(next).toBe(sample);
  });

  it('edits a scene3d child field', () => {
    const sel: Selection = { sceneIndex: 2, target: { kind: 'scene3d-child', index: 0 } };
    const next = setLayerField(sample, sel, 'preset', 'converge');
    expect(selectedLayer(next, sel)?.raw.preset).toBe('converge');
  });
});

describe('setSceneField', () => {
  it('sets a scene-level field immutably', () => {
    const next = setSceneField(sample, 0, 'dur', 5);
    expect(next.scenes[0].dur).toBe(5);
    expect(sample.scenes[0].dur).toBe(4);
  });

  it('is a no-op for an out-of-range scene index', () => {
    const next = setSceneField(sample, 99, 'dur', 5);
    expect(next).toBe(sample);
  });
});

describe('setCamera2d / setCamera3d', () => {
  it('replaces the 2D camera keyframe array', () => {
    const next = setCamera2d(sample, 0, [{ at: 0, zoom: 2 }]);
    expect(next.scenes[0].camera).toEqual([{ at: 0, zoom: 2 }]);
    expect(sample.scenes[0].camera).toHaveLength(3); // original untouched
  });

  it('replaces the 3D camera keyframe array', () => {
    const next = setCamera3d(sample, 2, [{ at: 0, pos: [1, 1, 1] }]);
    expect(next.scenes[2].scene3d?.camera).toEqual([{ at: 0, pos: [1, 1, 1] }]);
  });

  it('is a no-op setting a 3D camera on a scene with no scene3d', () => {
    const next = setCamera3d(sample, 0, [{ at: 0, pos: [1, 1, 1] }]);
    expect(next).toBe(sample);
  });
});

describe('layerWorldPosition', () => {
  it('reads a text layer\'s explicit x/y', () => {
    const sel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 0 } };
    expect(layerWorldPosition(sample, sel)).toEqual({ x: 180, y: 300 });
  });

  it('reads an emphasis layer\'s box[0]/box[1] (D-155 box-xy)', () => {
    const sel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 1 } };
    expect(layerWorldPosition(sample, sel)).toEqual({ x: 980, y: 250 });
  });

  it('falls back to an approximate canvas centre for an unset xy axis', () => {
    // scene "stack" layer 1 (`layers`) sets only `y: 560`, no `x` at all.
    const sel: Selection = { sceneIndex: 1, target: { kind: 'layer', index: 1 } };
    expect(layerWorldPosition(sample, sel)).toEqual({ x: sample.width / 2, y: 560 });
  });

  it('returns null for a primitive with no position fields (graph/in3d)', () => {
    // scene "space" child 0 is a `particleflow` (in3d — never a `positionFields` hit)
    const sel: Selection = { sceneIndex: 2, target: { kind: 'scene3d-child', index: 0 } };
    expect(layerWorldPosition(sample, sel)).toBeNull();
  });

  it('returns null for a selection that does not resolve', () => {
    const sel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 99 } };
    expect(layerWorldPosition(sample, sel)).toBeNull();
  });

  it('returns null for an emphasis layer whose box is missing/malformed', () => {
    const noBox = structuredClone(sample);
    noBox.scenes[0].layers = [{ use: 'emphasis', preset: 'pulse', at: 0 }];
    const sel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 0 } };
    expect(layerWorldPosition(noBox, sel)).toBeNull();
  });
});

describe('setLayerPosition', () => {
  it('writes x/y on a text layer without mutating the original', () => {
    const sel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 0 } };
    const next = setLayerPosition(sample, sel, 400, 500);
    expect(layerWorldPosition(next, sel)).toEqual({ x: 400, y: 500 });
    expect(layerWorldPosition(sample, sel)).toEqual({ x: 180, y: 300 }); // original untouched
  });

  it('writes box[0]/box[1] on an emphasis layer and preserves box[2]/[3]', () => {
    const sel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 1 } };
    const next = setLayerPosition(sample, sel, 100, 200);
    const raw = selectedLayer(next, sel)?.raw as { box: number[] };
    expect(raw.box).toEqual([100, 200, 520, 130]); // w/h (520,130) untouched
  });

  it('invents a default box size for an emphasis layer with no box yet', () => {
    const noBox = structuredClone(sample);
    noBox.scenes[0].layers = [{ use: 'emphasis', preset: 'pulse', at: 0 }];
    const sel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 0 } };
    const next = setLayerPosition(noBox, sel, 10, 20);
    const raw = selectedLayer(next, sel)?.raw as { box: number[] };
    expect(raw.box).toEqual([10, 20, 400, 200]);
  });

  it('is a no-op for a primitive with no position fields (graph/in3d)', () => {
    const sel: Selection = { sceneIndex: 2, target: { kind: 'scene3d-child', index: 0 } };
    const next = setLayerPosition(sample, sel, 1, 1);
    expect(next).toBe(sample);
  });

  it('is a no-op for a selection that does not resolve', () => {
    const sel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 99 } };
    const next = setLayerPosition(sample, sel, 1, 1);
    expect(next).toBe(sample);
  });
});

describe('layerWorldSize', () => {
  it("reads an emphasis layer's box[2]/box[3] (D-157 box-wh)", () => {
    const sel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 1 } };
    expect(layerWorldSize(sample, sel)).toEqual({ w: 520, h: 130 });
  });

  it('falls back to the default emphasis box size when box is missing/malformed', () => {
    const noBox = structuredClone(sample);
    noBox.scenes[0].layers = [{ use: 'emphasis', preset: 'pulse', at: 0 }];
    const sel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 0 } };
    expect(layerWorldSize(noBox, sel)).toEqual({ w: 400, h: 200 });
  });

  it("reads a layers stack's explicit cardW/cardH", () => {
    const m = structuredClone(sample);
    (m.scenes[1].layers![1] as unknown as Record<string, unknown>).cardW = 500;
    (m.scenes[1].layers![1] as unknown as Record<string, unknown>).cardH = 90;
    const sel: Selection = { sceneIndex: 1, target: { kind: 'layer', index: 1 } };
    expect(layerWorldSize(m, sel)).toEqual({ w: 500, h: 90 });
  });

  it('falls back to Layers.tsx\'s own cardW/cardH defaults when unset', () => {
    // sample's own "stack" scene layers[1] sets neither cardW nor cardH.
    const sel: Selection = { sceneIndex: 1, target: { kind: 'layer', index: 1 } };
    expect(layerWorldSize(sample, sel)).toEqual({ w: 620, h: 110 });
  });

  it("reads a graph's explicit width/height", () => {
    const m = structuredClone(sample);
    m.scenes[0].layers!.push({ use: 'graph', nodes: [], edges: [], width: 800, height: 400 } as never);
    const sel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 2 } };
    expect(layerWorldSize(m, sel)).toEqual({ w: 800, h: 400 });
  });

  it('falls back to the canvas size for a graph with no explicit width/height', () => {
    const m = structuredClone(sample);
    m.scenes[0].layers!.push({ use: 'graph', nodes: [], edges: [] } as never);
    const sel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 2 } };
    expect(layerWorldSize(m, sel)).toEqual({ w: sample.width, h: sample.height });
  });

  it("derives a matrix's real footprint from rows/cols/cell/gap (D-157 scalar)", () => {
    const m = structuredClone(sample);
    m.scenes[0].layers!.push({ use: 'matrix', rows: 4, cols: 6, cell: 88, gap: 10 } as never);
    const sel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 2 } };
    // w = cols*(cell+gap)-gap = 6*98-10 = 578; h = rows*(cell+gap)-gap = 4*98-10 = 382
    expect(layerWorldSize(m, sel)).toEqual({ w: 578, h: 382 });
  });

  it('uses Matrix.tsx\'s own cell/gap defaults when unset', () => {
    const m = structuredClone(sample);
    m.scenes[0].layers!.push({ use: 'matrix', rows: 2, cols: 2 } as never);
    const sel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 2 } };
    // cell=88, gap=10 → step=98; w=h=2*98-10=186
    expect(layerWorldSize(m, sel)).toEqual({ w: 186, h: 186 });
  });

  it("reads text.maxWidth with h: null (D-157 w-only — text has no height field)", () => {
    const m = structuredClone(sample);
    (m.scenes[0].layers![0] as unknown as Record<string, unknown>).maxWidth = 900;
    const sel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 0 } };
    expect(layerWorldSize(m, sel)).toEqual({ w: 900, h: null });
  });

  it('seeds an approximate maxWidth for text with none set yet', () => {
    const sel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 0 } };
    expect(layerWorldSize(sample, sel)).toEqual({ w: 800, h: null });
  });

  it('returns null for a primitive with no size fields (particleflow/in3d)', () => {
    const sel: Selection = { sceneIndex: 2, target: { kind: 'scene3d-child', index: 0 } };
    expect(layerWorldSize(sample, sel)).toBeNull();
  });

  it('returns null for a selection that does not resolve', () => {
    const sel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 99 } };
    expect(layerWorldSize(sample, sel)).toBeNull();
  });
});

describe('setLayerSize', () => {
  it("writes box[2]/box[3] on an emphasis layer and preserves box[0]/[1]", () => {
    const sel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 1 } };
    const next = setLayerSize(sample, sel, 600, 250);
    const raw = selectedLayer(next, sel)?.raw as { box: number[] };
    expect(raw.box).toEqual([980, 250, 600, 250]); // x/y (980,250) untouched
    expect(selectedLayer(sample, sel)?.raw).toEqual({ use: 'emphasis', preset: 'scribble', at: 1.8, dur: 2, box: [980, 250, 520, 130] }); // original untouched
  });

  it('writes cardW/cardH on a layers stack independently', () => {
    const sel: Selection = { sceneIndex: 1, target: { kind: 'layer', index: 1 } };
    const next = setLayerSize(sample, sel, 700, 150);
    const raw = selectedLayer(next, sel)?.raw as Record<string, unknown>;
    expect(raw.cardW).toBe(700);
    expect(raw.cardH).toBe(150);
  });

  it('writes width/height on a graph', () => {
    const m = structuredClone(sample);
    m.scenes[0].layers!.push({ use: 'graph', nodes: [], edges: [] } as never);
    const sel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 2 } };
    const next = setLayerSize(m, sel, 1000, 600);
    const raw = selectedLayer(next, sel)?.raw as Record<string, unknown>;
    expect(raw.width).toBe(1000);
    expect(raw.height).toBe(600);
  });

  it('derives a single cell value from a target w/h on a matrix (both axes agree)', () => {
    const m = structuredClone(sample);
    m.scenes[0].layers!.push({ use: 'matrix', rows: 4, cols: 6, gap: 10 } as never);
    const sel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 2 } };
    // target w=578,h=382 → cellFromW=(578+10)/6-10=88; cellFromH=(382+10)/4-10=88
    const next = setLayerSize(m, sel, 578, 382);
    const raw = selectedLayer(next, sel)?.raw as Record<string, unknown>;
    expect(raw.cell).toBeCloseTo(88);
  });

  it('averages the two axes when a matrix resize target is inconsistent between them', () => {
    const m = structuredClone(sample);
    m.scenes[0].layers!.push({ use: 'matrix', rows: 1, cols: 1, gap: 0 } as never);
    const sel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 2 } };
    // rows=cols=1,gap=0 ⇒ w=cell, h=cell independently; target (100,200) → average 150
    const next = setLayerSize(m, sel, 100, 200);
    const raw = selectedLayer(next, sel)?.raw as Record<string, unknown>;
    expect(raw.cell).toBe(150);
  });

  it('writes maxWidth on text and ignores the h argument (w-only)', () => {
    const sel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 0 } };
    const next = setLayerSize(sample, sel, 900, 12345);
    const raw = selectedLayer(next, sel)?.raw as Record<string, unknown>;
    expect(raw.maxWidth).toBe(900);
  });

  it('floors every written value at the minimum resize size (never zero/negative)', () => {
    const sel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 1 } };
    const next = setLayerSize(sample, sel, -50, 0);
    const raw = selectedLayer(next, sel)?.raw as { box: number[] };
    expect(raw.box[2]).toBeGreaterThan(0);
    expect(raw.box[3]).toBeGreaterThan(0);
  });

  it('is a no-op for a primitive with no size fields (particleflow/in3d)', () => {
    const sel: Selection = { sceneIndex: 2, target: { kind: 'scene3d-child', index: 0 } };
    const next = setLayerSize(sample, sel, 10, 10);
    expect(next).toBe(sample);
  });

  it('is a no-op for a selection that does not resolve', () => {
    const sel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 99 } };
    const next = setLayerSize(sample, sel, 10, 10);
    expect(next).toBe(sample);
  });
});

describe('snapEmphasisToRect', () => {
  it("converts a target's screen rect to world px and writes box, padded by SNAP_TO_LAYER_PAD", () => {
    // identity map (k=1, origin 0,0) — screen px === world px.
    const map = measureWorldMap({ left: 0, top: 0, width: 1920, height: 1080 }, 1920);
    const sel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 1 } };
    const targetRect = { left: 200, top: 300, width: 400, height: 90 };
    const next = snapEmphasisToRect(sample, sel, targetRect, map);
    const raw = selectedLayer(next, sel)?.raw as { box: number[] };
    expect(raw.box).toEqual([
      200 - SNAP_TO_LAYER_PAD,
      300 - SNAP_TO_LAYER_PAD,
      400 + SNAP_TO_LAYER_PAD * 2,
      90 + SNAP_TO_LAYER_PAD * 2,
    ]);
  });

  it('converts through a scaled + offset world map, matching the doc\'s own worked example (§2c)', () => {
    // camera fully pushed in at zoom 1.5, T=(-765,-240) — the exact worked
    // example `canvasGeometry.test.ts` already proves `screenToWorld`
    // against; this test proves `snapEmphasisToRect` composes it correctly.
    const map = measureWorldMap({ left: -765, top: -240, width: 2880, height: 1620 }, 1920);
    const sel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 1 } };
    // the text layer's own screen rect at that frame, per the doc: world
    // (180,300) → screen (-495,210); a 100x50 WORLD box there is 150x75 on screen (×1.5)
    const targetRect = { left: -495, top: 210, width: 150, height: 75 };
    const next = snapEmphasisToRect(sample, sel, targetRect, map);
    const raw = selectedLayer(next, sel)?.raw as { box: number[] };
    expect(raw.box[0]).toBeCloseTo(180 - SNAP_TO_LAYER_PAD);
    expect(raw.box[1]).toBeCloseTo(300 - SNAP_TO_LAYER_PAD);
    expect(raw.box[2]).toBeCloseTo(100 + SNAP_TO_LAYER_PAD * 2);
    expect(raw.box[3]).toBeCloseTo(50 + SNAP_TO_LAYER_PAD * 2);
  });

  it('is a no-op (same manifest back) for a selection that is not an emphasis layer', () => {
    const map = measureWorldMap({ left: 0, top: 0, width: 1920, height: 1080 }, 1920);
    const sel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 0 } }; // text
    const next = snapEmphasisToRect(sample, sel, { left: 0, top: 0, width: 10, height: 10 }, map);
    expect(next).toBe(sample);
  });

  it('is a no-op for a selection that does not resolve', () => {
    const map = measureWorldMap({ left: 0, top: 0, width: 1920, height: 1080 }, 1920);
    const sel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 99 } };
    const next = snapEmphasisToRect(sample, sel, { left: 0, top: 0, width: 10, height: 10 }, map);
    expect(next).toBe(sample);
  });
});

describe('setLayerTransformField', () => {
  it('sets a field on a layer with no transform yet, creating the nested object', () => {
    const sel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 0 } };
    const next = setLayerTransformField(sample, sel, 'scale', 1.4);
    expect(selectedLayer(next, sel)?.raw.transform).toEqual({ scale: 1.4 });
    expect(selectedLayer(sample, sel)?.raw.transform).toBeUndefined(); // original untouched
  });

  it('merges a second field into an existing transform without disturbing the first', () => {
    const withTransform = structuredClone(sample);
    (withTransform.scenes[0].layers![0] as unknown as Record<string, unknown>).transform = { x: 10 };
    const sel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 0 } };
    const next = setLayerTransformField(withTransform, sel, 'opacity', 0.5);
    expect(selectedLayer(next, sel)?.raw.transform).toEqual({ x: 10, opacity: 0.5 });
  });

  it('deletes just the one field when set to undefined, keeping the rest', () => {
    const withTransform = structuredClone(sample);
    (withTransform.scenes[0].layers![0] as unknown as Record<string, unknown>).transform = { x: 10, y: 20 };
    const sel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 0 } };
    const next = setLayerTransformField(withTransform, sel, 'x', undefined);
    expect(selectedLayer(next, sel)?.raw.transform).toEqual({ y: 20 });
  });

  it('drops the transform object entirely once its last field is cleared', () => {
    const withTransform = structuredClone(sample);
    (withTransform.scenes[0].layers![0] as unknown as Record<string, unknown>).transform = { x: 10 };
    const sel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 0 } };
    const next = setLayerTransformField(withTransform, sel, 'x', undefined);
    expect(selectedLayer(next, sel)?.raw.transform).toBeUndefined();
  });

  it('is a no-op for a selection that does not resolve', () => {
    const sel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 99 } };
    const next = setLayerTransformField(sample, sel, 'scale', 2);
    expect(next).toBe(sample);
  });
});

describe('parseJsonField', () => {
  it('parses valid JSON', () => {
    const r = parseJsonField('[1,2,3]');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([1, 2, 3]);
  });

  it('reports an error for invalid JSON without throwing', () => {
    const r = parseJsonField('{not json');
    expect(r.ok).toBe(false);
  });
});

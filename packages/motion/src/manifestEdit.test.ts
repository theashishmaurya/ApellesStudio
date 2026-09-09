import { describe, it, expect } from 'vitest';
import { sample } from '@apelles/motion-engine/src/engine/sample';
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
  layerTransformKeys,
  setLayerTransformKeys,
  layerTransformKeyDelta,
  layerDragBase,
  upsertLayerTransformKeyXY,
  moveLayersByDeltaAutoKey,
  moveKeyAt,
  moveLayerTransformKeyAt,
  moveCamera2dKeyAt,
  moveCamera3dKeyAt,
  moveKeysAt,
  moveKeysByDelta,
  parseJsonField,
  reorderLayers,
  resolveSelection,
  resolveSelections,
  moveLayersByDelta,
  setFieldOnSelections,
  setTransformFieldOnSelections,
  alignSelections,
  distributeSelections,
  sceneIndexAtFrame,
  layerVisibleFrameRange,
  layerActiveSchedule,
  setLayerActiveSchedule,
  moveLayerActiveKeyAt,
  addScene,
  canDeleteScene,
  deleteLayer,
  deleteScene,
  duplicateLayer,
  duplicateScene,
  selectedLayerItem,
  setLayerItemOffset,
  setLayerItemField,
  resetLayerItemPosition,
} from './manifestEdit';
import { measureWorldMap } from './canvasGeometry';
import type { Selection } from './LayerList';
import type { Manifest } from '@apelles/motion-engine/src/engine/schema';

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

describe('layerTransformKeys / setLayerTransformKeys (D-159, Phase 4)', () => {
  const textSel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 0 } };

  it('reads [] for a layer with no transform at all', () => {
    expect(layerTransformKeys(sample, textSel)).toEqual([]);
  });

  it('reads [] for a layer with a transform but no keys field', () => {
    const withTransform = structuredClone(sample);
    (withTransform.scenes[0].layers![0] as unknown as Record<string, unknown>).transform = { x: 10 };
    expect(layerTransformKeys(withTransform, textSel)).toEqual([]);
  });

  it('reads back a real keys array', () => {
    const withKeys = structuredClone(sample);
    (withKeys.scenes[0].layers![0] as unknown as Record<string, unknown>).transform = {
      keys: [{ at: 0, x: 0 }, { at: 1, x: 50 }],
    };
    expect(layerTransformKeys(withKeys, textSel)).toEqual([{ at: 0, x: 0 }, { at: 1, x: 50 }]);
  });

  it('writes a non-empty keys array through setLayerTransformField', () => {
    const next = setLayerTransformKeys(sample, textSel, [{ at: 0, x: 5, y: 6 }]);
    expect(layerTransformKeys(next, textSel)).toEqual([{ at: 0, x: 5, y: 6 }]);
  });

  it('an empty array DELETES the keys field (and the whole transform, if keys was the only field)', () => {
    const withKeys = structuredClone(sample);
    (withKeys.scenes[0].layers![0] as unknown as Record<string, unknown>).transform = {
      keys: [{ at: 0, x: 0 }],
    };
    const next = setLayerTransformKeys(withKeys, textSel, []);
    expect(layerTransformKeys(next, textSel)).toEqual([]);
    expect(selectedLayer(next, textSel)?.raw.transform).toBeUndefined();
  });

  it('an empty array clears keys but preserves OTHER transform fields', () => {
    const withBoth = structuredClone(sample);
    (withBoth.scenes[0].layers![0] as unknown as Record<string, unknown>).transform = {
      x: 10,
      keys: [{ at: 0, x: 0 }],
    };
    const next = setLayerTransformKeys(withBoth, textSel, []);
    expect(selectedLayer(next, textSel)?.raw.transform).toEqual({ x: 10 });
  });

  it('is a no-op for a selection that does not resolve to a layer', () => {
    const sel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 99 } };
    expect(setLayerTransformKeys(sample, sel, [{ at: 0, x: 1 }])).toBe(sample);
    expect(layerTransformKeys(sample, sel)).toEqual([]);
  });
});

describe('layerActiveSchedule / setLayerActiveSchedule (D-178/B-067)', () => {
  // sample scene 1 "stack", layer 1 (the "layers" primitive) — the manifest's
  // own real active: [{at:2.5,i:2},{at:4,i:0}] step-schedule.
  const layersSel: Selection = { sceneIndex: 1, target: { kind: 'layer', index: 1 } };
  const textSel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 0 } };

  it('reads [] for a layer with no active field at all', () => {
    expect(layerActiveSchedule(sample, textSel)).toEqual([]);
  });

  it('reads [] for the plain-number (non-schedule) form — nothing to show/move on a timeline', () => {
    const m = structuredClone(sample);
    (m.scenes[0].layers![0] as unknown as Record<string, unknown>).active = 2;
    expect(layerActiveSchedule(m, textSel)).toEqual([]);
  });

  it("reads back sample's own real step-schedule", () => {
    expect(layerActiveSchedule(sample, layersSel)).toEqual([{ at: 2.5, i: 2 }, { at: 4, i: 0 }]);
  });

  it('writes a non-empty schedule through setLayerField', () => {
    const next = setLayerActiveSchedule(sample, layersSel, [{ at: 1, i: 1 }]);
    expect(layerActiveSchedule(next, layersSel)).toEqual([{ at: 1, i: 1 }]);
  });

  it('an empty array DELETES the active field entirely', () => {
    const next = setLayerActiveSchedule(sample, layersSel, []);
    expect(layerActiveSchedule(next, layersSel)).toEqual([]);
    expect(selectedLayer(next, layersSel)?.raw.active).toBeUndefined();
  });

  it('never disturbs the layer\'s OTHER fields (items, callout, x, y, …)', () => {
    const next = setLayerActiveSchedule(sample, layersSel, [{ at: 1, i: 0 }]);
    const raw = selectedLayer(next, layersSel)?.raw;
    expect(raw?.items).toEqual(['tools', 'system prompt', 'retrieved context', 'your question']);
    expect(raw?.callout).toBe('re-sent on every call');
  });

  it('is a no-op for a selection that does not resolve to a layer', () => {
    const sel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 99 } };
    expect(setLayerActiveSchedule(sample, sel, [{ at: 0, i: 1 }])).toBe(sample);
    expect(layerActiveSchedule(sample, sel)).toEqual([]);
  });
});

describe('moveLayerActiveKeyAt (D-178/B-067)', () => {
  const layersSel: Selection = { sceneIndex: 1, target: { kind: 'layer', index: 1 } }; // "stack", dur 6

  it("retimes sample's own real active-schedule entry, leaving its target index untouched", () => {
    const next = moveLayerActiveKeyAt(sample, layersSel, 0, 1);
    expect(layerActiveSchedule(next, layersSel)).toEqual([{ at: 1, i: 2 }, { at: 4, i: 0 }]);
  });

  it("clamps to the scene's own duration when dragged past the end", () => {
    const next = moveLayerActiveKeyAt(sample, layersSel, 1, 999);
    expect(layerActiveSchedule(next, layersSel)).toContainEqual({ at: 6, i: 0 });
  });

  it('reorders past a neighbor, same as the generic core', () => {
    const next = moveLayerActiveKeyAt(sample, layersSel, 1, 1); // drag the i:0 step before the i:2 step
    expect(layerActiveSchedule(next, layersSel)).toEqual([{ at: 1, i: 0 }, { at: 2.5, i: 2 }]);
  });

  it('is a no-op for a selection with no scene (out of range)', () => {
    const badSel: Selection = { sceneIndex: 99, target: { kind: 'layer', index: 1 } };
    expect(moveLayerActiveKeyAt(sample, badSel, 0, 1)).toBe(sample);
  });

  it('is a no-op for an out-of-range keyIndex', () => {
    const next = moveLayerActiveKeyAt(sample, layersSel, 99, 1);
    expect(layerActiveSchedule(next, layersSel)).toEqual([{ at: 2.5, i: 2 }, { at: 4, i: 0 }]);
  });
});

describe('moveKeyAt (Phase 5b — drag a key along time, the generic core)', () => {
  it('moves the key at `index` to the new `at`, leaving the others untouched', () => {
    const keys = [{ at: 0 }, { at: 1 }, { at: 2 }];
    expect(moveKeyAt(keys, 1, 1.5, 4)).toEqual([{ at: 0 }, { at: 1.5 }, { at: 2 }]);
  });

  it('reorders (does not clamp) when a drag crosses a neighbor — decision 1', () => {
    const keys = [{ at: 0, x: 10 }, { at: 1, x: 20 }, { at: 2, x: 30 }];
    // drag the middle key (x:20) past the LAST key
    const next = moveKeyAt(keys, 1, 2.5, 4);
    expect(next).toEqual([{ at: 0, x: 10 }, { at: 2, x: 30 }, { at: 2.5, x: 20 }]);
  });

  it('reorders past the FIRST key too, in either direction', () => {
    const keys = [{ at: 0, x: 10 }, { at: 1, x: 20 }, { at: 2, x: 30 }];
    // drag the LAST key (x:30) before the FIRST key
    const next = moveKeyAt(keys, 2, -1, 4);
    // clamped to 0 (boundary), then sorted — ties broken by original order,
    // so the dragged key (now also at 0) lands AFTER the original first key
    expect(next).toEqual([{ at: 0, x: 10 }, { at: 0, x: 30 }, { at: 1, x: 20 }]);
  });

  it('clamps to 0 when dragged before the scene start', () => {
    const keys = [{ at: 1 }];
    expect(moveKeyAt(keys, 0, -5, 4)).toEqual([{ at: 0 }]);
  });

  it('clamps to the scene duration when dragged past the end', () => {
    const keys = [{ at: 1 }];
    expect(moveKeyAt(keys, 0, 999, 4)).toEqual([{ at: 4 }]);
  });

  it('moves the FIRST key with no off-by-one', () => {
    const keys = [{ at: 0 }, { at: 1 }, { at: 2 }];
    expect(moveKeyAt(keys, 0, 0.5, 4)).toEqual([{ at: 0.5 }, { at: 1 }, { at: 2 }]);
  });

  it('moves the LAST key with no off-by-one', () => {
    const keys = [{ at: 0 }, { at: 1 }, { at: 2 }];
    expect(moveKeyAt(keys, 2, 3.5, 4)).toEqual([{ at: 0 }, { at: 1 }, { at: 3.5 }]);
  });

  it('is a no-op for an out-of-range index (negative or too large)', () => {
    const keys = [{ at: 0 }, { at: 1 }];
    expect(moveKeyAt(keys, -1, 0.5, 4)).toBe(keys);
    expect(moveKeyAt(keys, 2, 0.5, 4)).toBe(keys);
  });

  it('is a no-op on an empty array (nothing to move)', () => {
    const keys: { at: number }[] = [];
    expect(moveKeyAt(keys, 0, 1, 4)).toBe(keys);
  });

  it('a single-key array just clamps, with nothing to reorder against', () => {
    const keys = [{ at: 2 }];
    expect(moveKeyAt(keys, 0, 1.5, 4)).toEqual([{ at: 1.5 }]);
  });

  it('preserves every OTHER field on the moved key, only `at` changes', () => {
    const keys = [{ at: 0, x: 10, y: 20, ease: [0.1, 0, 0.9, 1] as [number, number, number, number] }];
    expect(moveKeyAt(keys, 0, 2, 4)).toEqual([{ at: 2, x: 10, y: 20, ease: [0.1, 0, 0.9, 1] }]);
  });

  it('stable-sorts genuine ties by their ARRAY POSITION, not by which one just moved', () => {
    const keys = [{ at: 0, tag: 'a' }, { at: 2, tag: 'b' }, { at: 2, tag: 'c' }];
    // drag key 0 (array position 0) to land exactly on the existing tie at
    // `at: 2` — a stable sort keeps ties in their PRE-SORT array order, and
    // the moved key's pre-sort position is still 0 (only its `at` value
    // changed), so it sorts to the FRONT of the tied group, not the back.
    expect(moveKeyAt(keys, 0, 2, 4)).toEqual([
      { at: 2, tag: 'a' },
      { at: 2, tag: 'b' },
      { at: 2, tag: 'c' },
    ]);
  });
});

describe('moveLayerTransformKeyAt (Phase 5b)', () => {
  const sel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 0 } }; // scene 0 "hook", dur 4

  it('moves a real transform.keys entry, clamped to the scene\'s own duration', () => {
    const withKeys = structuredClone(sample);
    (withKeys.scenes[0].layers![0] as unknown as Record<string, unknown>).transform = {
      keys: [{ at: 0, x: 0 }, { at: 2, x: 100 }],
    };
    const next = moveLayerTransformKeyAt(withKeys, sel, 1, 999);
    expect(layerTransformKeys(next, sel)).toEqual([{ at: 0, x: 0 }, { at: 4, x: 100 }]);
  });

  it('reorders a layer key past its neighbor, same as the generic core', () => {
    const withKeys = structuredClone(sample);
    (withKeys.scenes[0].layers![0] as unknown as Record<string, unknown>).transform = {
      keys: [{ at: 0, x: 0 }, { at: 1, x: 50 }, { at: 2, x: 100 }],
    };
    const next = moveLayerTransformKeyAt(withKeys, sel, 0, 1.5);
    expect(layerTransformKeys(next, sel)).toEqual([{ at: 1, x: 50 }, { at: 1.5, x: 0 }, { at: 2, x: 100 }]);
  });

  it('is a no-op for a selection with no scene (out of range)', () => {
    const badSel: Selection = { sceneIndex: 99, target: { kind: 'layer', index: 0 } };
    expect(moveLayerTransformKeyAt(sample, badSel, 0, 1)).toBe(sample);
  });

  it('is a no-op for an out-of-range keyIndex', () => {
    const withKeys = structuredClone(sample);
    (withKeys.scenes[0].layers![0] as unknown as Record<string, unknown>).transform = {
      keys: [{ at: 0, x: 0 }],
    };
    const next = moveLayerTransformKeyAt(withKeys, sel, 5, 2);
    expect(layerTransformKeys(next, sel)).toEqual([{ at: 0, x: 0 }]);
  });
});

describe('moveCamera2dKeyAt (Phase 5b)', () => {
  it('moves one of scene 0 "hook"\'s real camera keys (dur 4), clamped', () => {
    const next = moveCamera2dKeyAt(sample, 0, 2, -10); // key 2 is {at:1.6, x:1150,...}
    expect(selectedCamera2d(next, 0)?.[0]).toEqual({ at: 0, zoom: 1 });
    // the moved key clamps to 0 and sorts to the front, tying with the
    // existing at:0 key but AFTER it (stable sort preserves original order)
    expect(selectedCamera2d(next, 0)).toEqual([
      { at: 0, zoom: 1 },
      { at: 0, x: 1150, y: 520, zoom: 1.5 },
      { at: 0.4, zoom: 1 },
    ]);
  });

  it('clamps to the scene duration when dragged past the end', () => {
    const next = moveCamera2dKeyAt(sample, 0, 0, 999); // scene 0 dur is 4
    expect(selectedCamera2d(next, 0)?.[2]).toEqual({ at: 4, zoom: 1 });
  });

  it('is a no-op for a scene with no camera at all', () => {
    expect(moveCamera2dKeyAt(sample, 1, 0, 1)).toBe(sample); // scene 1 "stack" has no camera
  });

  it('is a no-op for an out-of-range scene index', () => {
    expect(moveCamera2dKeyAt(sample, 99, 0, 1)).toBe(sample);
  });
});

describe('moveCamera3dKeyAt (Phase 5b)', () => {
  it('moves the FIRST 3D camera key (scene 2 "space", dur 5) with no off-by-one', () => {
    const next = moveCamera3dKeyAt(sample, 2, 0, 2);
    expect(selectedCamera3d(next, 2)).toEqual([
      { at: 2, pos: [0, 0, 12], look: [0, 0, 0] },
      { at: 5, pos: [3, 2, 9], look: [0, 0, 0] },
    ]);
  });

  it('moves the LAST 3D camera key with no off-by-one, clamped to the scene end', () => {
    const next = moveCamera3dKeyAt(sample, 2, 1, 999);
    expect(selectedCamera3d(next, 2)?.[1]).toEqual({ at: 5, pos: [3, 2, 9], look: [0, 0, 0] });
  });

  it('is a no-op for a scene with no scene3d at all', () => {
    expect(moveCamera3dKeyAt(sample, 0, 0, 1)).toBe(sample); // scene 0 "hook" has no scene3d
  });
});

describe('moveKeysAt (Phase 5b — box-select + nudge, the multi-key generic core)', () => {
  it('moves every named key from its own remembered base, leaving untouched keys alone', () => {
    const keys = [{ at: 1 }, { at: 2 }, { at: 3 }];
    const next = moveKeysAt(
      keys,
      [
        { keyIndex: 0, baseAtSeconds: 1 },
        { keyIndex: 2, baseAtSeconds: 3 },
      ],
      5,
      100,
    );
    // the UNSELECTED middle key never moves; the two selected keys both
    // shift by the same +5 from their OWN base, then the whole array
    // re-sorts once
    expect(next).toEqual([{ at: 2 }, { at: 6 }, { at: 8 }]);
  });

  it('avoids the sequential-call correctness trap for two selected keys in the SAME array', () => {
    // if this were implemented as two sequential `moveKeyAt` calls, moving
    // index 0 first would re-sort the array and shift what "index 2" means
    // by the time the second call ran — `moveKeysAt` must not have that bug.
    const keys = [{ at: 1, tag: 'a' }, { at: 2, tag: 'b' }, { at: 3, tag: 'c' }];
    const next = moveKeysAt(
      keys,
      [
        { keyIndex: 0, baseAtSeconds: 1 },
        { keyIndex: 2, baseAtSeconds: 3 },
      ],
      5,
      100,
    );
    expect(next).toEqual([
      { at: 2, tag: 'b' },
      { at: 6, tag: 'a' },
      { at: 8, tag: 'c' },
    ]);
  });

  it('clamps EACH key independently — a nudge can become non-uniform at a boundary', () => {
    const keys = [{ at: 1 }, { at: 9 }];
    const next = moveKeysAt(
      keys,
      [
        { keyIndex: 0, baseAtSeconds: 1 },
        { keyIndex: 1, baseAtSeconds: 9 },
      ],
      5,
      10, // scene dur
    );
    // key 0 (1 -> 6) has room and moves the full +5; key 1 (9 -> 14) clips
    // to the scene's own end (10) — the SAME shared delta, two different
    // outcomes, exactly the documented decision.
    expect(next).toEqual([{ at: 6 }, { at: 10 }]);
  });

  it('clamps to 0 on a negative delta, same as the single-key core', () => {
    const keys = [{ at: 1 }, { at: 2 }];
    const next = moveKeysAt(keys, [{ keyIndex: 0, baseAtSeconds: 1 }], -5, 10);
    expect(next).toEqual([{ at: 0 }, { at: 2 }]);
  });

  it('an empty moves list touches nothing', () => {
    const keys = [{ at: 1 }, { at: 2 }];
    expect(moveKeysAt(keys, [], 5, 10)).toEqual(keys);
  });

  it('preserves every OTHER field on every moved key, only `at` changes', () => {
    const keys = [{ at: 0, x: 10, y: 20 }, { at: 1, x: 30, y: 40 }];
    const next = moveKeysAt(
      keys,
      [
        { keyIndex: 0, baseAtSeconds: 0 },
        { keyIndex: 1, baseAtSeconds: 1 },
      ],
      2,
      10,
    );
    expect(next).toEqual([{ at: 2, x: 10, y: 20 }, { at: 3, x: 30, y: 40 }]);
  });

  it('a move naming an index outside the array is silently ignored', () => {
    const keys = [{ at: 1 }];
    expect(moveKeysAt(keys, [{ keyIndex: 5, baseAtSeconds: 1 }], 5, 10)).toEqual([{ at: 1 }]);
  });
});

describe('moveKeysByDelta (Phase 5b — box-select + nudge, the multi-lane write path)', () => {
  it('nudges a real camera key (scene 0 "hook", dur 4) by a shared delta', () => {
    const next = moveKeysByDelta(sample, [{ sceneIndex: 0, kind: 'camera', keyIndex: 1, baseAtSeconds: 0.4 }], 0.2);
    const moved = selectedCamera2d(next, 0)?.find((k) => k.zoom === 1 && k.at > 0.5);
    expect(moved?.at).toBeCloseTo(0.6, 10);
  });

  it('spans MULTIPLE lanes in one call — a camera key AND a layer key, nudged together', () => {
    const withLayerKeys = structuredClone(sample);
    (withLayerKeys.scenes[0].layers![0] as unknown as Record<string, unknown>).transform = {
      keys: [{ at: 0, x: 0 }],
    };
    const next = moveKeysByDelta(
      withLayerKeys,
      [
        { sceneIndex: 0, kind: 'camera', keyIndex: 0, baseAtSeconds: 0 },
        { sceneIndex: 0, kind: 'layer', layerIndex: 0, keyIndex: 0, baseAtSeconds: 0 },
      ],
      1,
    );
    expect(selectedCamera2d(next, 0)).toContainEqual({ at: 1, zoom: 1 });
    const layerSel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 0 } };
    expect(layerTransformKeys(next, layerSel)).toEqual([{ at: 1, x: 0 }]);
  });

  it('spans MULTIPLE scenes, clamping each key to its OWN scene duration independently', () => {
    // scene 0 "hook" dur 4, scene 2 "space" dur 5 — the SAME +10 delta pushes
    // both past their own end, but each clamps to a DIFFERENT absolute value.
    const next = moveKeysByDelta(
      sample,
      [
        { sceneIndex: 0, kind: 'camera', keyIndex: 0, baseAtSeconds: 0 },
        { sceneIndex: 2, kind: 'scene3d-camera', keyIndex: 0, baseAtSeconds: 0 },
      ],
      10,
    );
    expect(selectedCamera2d(next, 0)).toContainEqual({ at: 4, zoom: 1 });
    expect(selectedCamera3d(next, 2)?.[0].at).toBe(5);
  });

  it('moves TWO keys in the SAME layer array together, safely (the grouping path)', () => {
    const withLayerKeys = structuredClone(sample);
    (withLayerKeys.scenes[0].layers![0] as unknown as Record<string, unknown>).transform = {
      keys: [{ at: 0, x: 0 }, { at: 1, x: 50 }, { at: 2, x: 100 }],
    };
    const next = moveKeysByDelta(
      withLayerKeys,
      [
        { sceneIndex: 0, kind: 'layer', layerIndex: 0, keyIndex: 0, baseAtSeconds: 0 },
        { sceneIndex: 0, kind: 'layer', layerIndex: 0, keyIndex: 2, baseAtSeconds: 2 },
      ],
      1.5,
    );
    const layerSel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 0 } };
    // the untouched middle key (x:50) never moves; the two selected keys
    // both land 1.5s later than their own base and the array re-sorts once
    expect(layerTransformKeys(next, layerSel)).toEqual([
      { at: 1, x: 50 },
      { at: 1.5, x: 0 },
      { at: 3.5, x: 100 },
    ]);
  });

  it('silently skips a target whose scene no longer exists', () => {
    const next = moveKeysByDelta(
      sample,
      [
        { sceneIndex: 99, kind: 'camera', keyIndex: 0, baseAtSeconds: 0 },
        { sceneIndex: 0, kind: 'camera', keyIndex: 0, baseAtSeconds: 0 },
      ],
      1,
    );
    expect(selectedCamera2d(next, 0)).toContainEqual({ at: 1, zoom: 1 });
  });

  it('an empty targets array is a true no-op — same manifest reference back', () => {
    expect(moveKeysByDelta(sample, [], 5)).toBe(sample);
  });

  it('does not mutate the manifest it was given', () => {
    moveKeysByDelta(sample, [{ sceneIndex: 0, kind: 'camera', keyIndex: 0, baseAtSeconds: 0 }], 1);
    expect(selectedCamera2d(sample, 0)).toContainEqual({ at: 0, zoom: 1 });
  });

  it('produces ONE resulting manifest for N moves across N different lanes', () => {
    const next = moveKeysByDelta(
      sample,
      [
        { sceneIndex: 0, kind: 'camera', keyIndex: 0, baseAtSeconds: 0 },
        { sceneIndex: 2, kind: 'scene3d-camera', keyIndex: 0, baseAtSeconds: 0 },
      ],
      1,
    );
    expect(selectedCamera2d(next, 0)).toContainEqual({ at: 1, zoom: 1 });
    expect(selectedCamera3d(next, 2)?.[0].at).toBe(1);
  });

  it("nudges an 'active'-schedule key (D-178/B-067), same as any other lane kind", () => {
    const next = moveKeysByDelta(
      sample,
      [{ sceneIndex: 1, kind: 'active', layerIndex: 1, keyIndex: 0, baseAtSeconds: 2.5 }],
      0.5,
    );
    const layersSel: Selection = { sceneIndex: 1, target: { kind: 'layer', index: 1 } };
    expect(layerActiveSchedule(next, layersSel)).toEqual([{ at: 3, i: 2 }, { at: 4, i: 0 }]);
  });

  it("spans a 'layer' (transform.keys) lane AND that SAME layer's own 'active' lane in one call, independently", () => {
    const m = structuredClone(sample);
    (m.scenes[1].layers![1] as unknown as Record<string, unknown>).transform = { keys: [{ at: 0, x: 0 }] };
    const next = moveKeysByDelta(
      m,
      [
        { sceneIndex: 1, kind: 'layer', layerIndex: 1, keyIndex: 0, baseAtSeconds: 0 },
        { sceneIndex: 1, kind: 'active', layerIndex: 1, keyIndex: 0, baseAtSeconds: 2.5 },
      ],
      1,
    );
    const layersSel: Selection = { sceneIndex: 1, target: { kind: 'layer', index: 1 } };
    expect(layerTransformKeys(next, layersSel)).toEqual([{ at: 1, x: 0 }]);
    expect(layerActiveSchedule(next, layersSel)).toEqual([{ at: 3.5, i: 2 }, { at: 4, i: 0 }]);
  });
});

describe('layerTransformKeyDelta (D-159 — reuses the shared interpolateKeys)', () => {
  const fps = 30;

  it('returns {x:0,y:0} for an empty keys array', () => {
    expect(layerTransformKeyDelta([], 15, fps)).toEqual({ x: 0, y: 0 });
  });

  it('a single key clamps to its own delta at every frame', () => {
    const keys = [{ at: 1, x: 40, y: -20 }]; // at 1s * 30fps = frame 30
    expect(layerTransformKeyDelta(keys, 0, fps)).toEqual({ x: 40, y: -20 });
    expect(layerTransformKeyDelta(keys, 30, fps)).toEqual({ x: 40, y: -20 });
    expect(layerTransformKeyDelta(keys, 999, fps)).toEqual({ x: 40, y: -20 });
  });

  it('interpolates between two keys, converting `at` from seconds to frames', () => {
    const keys = [
      { at: 0, x: 0, y: 0 },
      { at: 1, x: 100, y: 0 }, // frame 30
    ];
    // frame 15 == 0.5s == the midpoint
    expect(layerTransformKeyDelta(keys, 15, fps).x).toBeCloseTo(50, 0);
  });

  it('a field never specified on any key defaults to 0, independent of the other field', () => {
    const keys = [{ at: 0, x: 10 }]; // y never appears
    expect(layerTransformKeyDelta(keys, 0, fps)).toEqual({ x: 10, y: 0 });
  });
});

describe('layerDragBase (D-159 — the auto-keyframe drag decision)', () => {
  const textSel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 0 } }; // x:180, y:300
  const fps = 30;

  it('unkeyed layer (no transform at all): keyed=false, base = native world position', () => {
    const result = layerDragBase(sample, textSel, 0, fps);
    expect(result).toEqual({ base: { x: 180, y: 300 }, keyed: false });
  });

  it('a transform.keys array that never touches x/y: still keyed=false (per-PROPERTY, not per-layer)', () => {
    const withOpacityKeys = structuredClone(sample);
    (withOpacityKeys.scenes[0].layers![0] as unknown as Record<string, unknown>).transform = {
      keys: [{ at: 0, opacity: 0 }, { at: 1, opacity: 1 }],
    };
    const result = layerDragBase(withOpacityKeys, textSel, 0, fps);
    expect(result).toEqual({ base: { x: 180, y: 300 }, keyed: false });
  });

  it('a transform.keys array with an x (or y) entry: keyed=true, base = the INTERPOLATED delta at that frame', () => {
    const withXKeys = structuredClone(sample);
    (withXKeys.scenes[0].layers![0] as unknown as Record<string, unknown>).transform = {
      keys: [{ at: 0, x: 0 }, { at: 1, x: 100 }],
    };
    const atStart = layerDragBase(withXKeys, textSel, 0, fps);
    expect(atStart).toEqual({ base: { x: 0, y: 0 }, keyed: true });
    const atMid = layerDragBase(withXKeys, textSel, 15, fps); // frame 15 == 0.5s
    expect(atMid?.keyed).toBe(true);
    expect(atMid?.base.x).toBeCloseTo(50, 0);
  });

  it('keyed on y alone still counts as keyed for the whole position (x/y move together)', () => {
    const withYKeys = structuredClone(sample);
    (withYKeys.scenes[0].layers![0] as unknown as Record<string, unknown>).transform = {
      keys: [{ at: 0, y: 40 }],
    };
    expect(layerDragBase(withYKeys, textSel, 0, fps)).toEqual({ base: { x: 0, y: 40 }, keyed: true });
  });

  it('returns null for a selection with no draggable position at all', () => {
    const staleSel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 99 } };
    expect(layerDragBase(sample, staleSel, 0, fps)).toBeNull();
  });
});

describe('upsertLayerTransformKeyXY (D-159 — the auto-keyframe write path)', () => {
  const textSel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 0 } };
  const fps = 30;

  it('creates a new key at the target frame when none exists there', () => {
    const next = upsertLayerTransformKeyXY(sample, textSel, 0.5, fps, 12, -8);
    expect(layerTransformKeys(next, textSel)).toEqual([{ at: 0.5, x: 12, y: -8 }]);
  });

  it('overwrites an EXISTING key at that exact frame in place, preserving its other fields', () => {
    const withKey = structuredClone(sample);
    (withKey.scenes[0].layers![0] as unknown as Record<string, unknown>).transform = {
      keys: [{ at: 0.5, x: 1, y: 2, scale: 0.2, ease: [0, 0, 1, 1] }],
    };
    const next = upsertLayerTransformKeyXY(withKey, textSel, 0.5, fps, 99, 88);
    expect(layerTransformKeys(next, textSel)).toEqual([
      { at: 0.5, x: 99, y: 88, scale: 0.2, ease: [0, 0, 1, 1] },
    ]);
  });

  it('a target frame that rounds the same as an existing key updates it, not a duplicate', () => {
    const withKey = structuredClone(sample);
    (withKey.scenes[0].layers![0] as unknown as Record<string, unknown>).transform = {
      keys: [{ at: 0.501, x: 1, y: 1 }], // rounds to frame 15, same as 0.5s
    };
    const next = upsertLayerTransformKeyXY(withKey, textSel, 0.5, fps, 7, 7);
    const keys = layerTransformKeys(next, textSel);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toEqual({ at: 0.501, x: 7, y: 7 }); // `at` unchanged, only x/y overwritten
  });

  it('appends alongside an existing key at a DIFFERENT frame, rather than overwriting it', () => {
    const withKey = structuredClone(sample);
    (withKey.scenes[0].layers![0] as unknown as Record<string, unknown>).transform = {
      keys: [{ at: 0, x: 0, y: 0 }],
    };
    const next = upsertLayerTransformKeyXY(withKey, textSel, 1, fps, 40, 40);
    expect(layerTransformKeys(next, textSel)).toEqual([
      { at: 0, x: 0, y: 0 },
      { at: 1, x: 40, y: 40 },
    ]);
  });

  it('is a no-op for a selection that does not resolve to a layer', () => {
    const sel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 99 } };
    expect(upsertLayerTransformKeyXY(sample, sel, 0, fps, 1, 1)).toBe(sample);
  });
});

describe('moveLayersByDeltaAutoKey (D-159 — group move with per-entry auto-keyframe)', () => {
  const textSel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 0 } }; // unkeyed
  const emphasisSel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 1 } }; // will be keyed

  it('an unkeyed entry writes the native base position, exactly like moveLayersByDelta', () => {
    const moves = [{ selection: textSel, base: { x: 180, y: 300 }, keyed: false }];
    const next = moveLayersByDeltaAutoKey(sample, moves, 10, 10, 0, 30);
    expect(layerWorldPosition(next, textSel)).toEqual({ x: 190, y: 310 });
    expect(layerTransformKeys(next, textSel)).toEqual([]); // no key was written
  });

  it('a keyed entry writes/updates a transform.keys row at the given frame instead of the native field', () => {
    const moves = [{ selection: textSel, base: { x: 0, y: 0 }, keyed: true }];
    const next = moveLayersByDeltaAutoKey(sample, moves, 15, -5, 0.5, 30);
    expect(layerTransformKeys(next, textSel)).toEqual([{ at: 0.5, x: 15, y: -5 }]);
    // the native x/y field is UNTOUCHED — the drag went to the key instead
    expect((selectedLayer(next, textSel)?.raw as Record<string, unknown>).x).toBe(180);
  });

  it('a MIXED group (one keyed, one not) routes each entry independently in ONE resulting manifest', () => {
    const moves = [
      { selection: textSel, base: { x: 180, y: 300 }, keyed: false },
      { selection: emphasisSel, base: { x: 0, y: 0 }, keyed: true },
    ];
    const next = moveLayersByDeltaAutoKey(sample, moves, 20, 20, 1, 30);
    expect(layerWorldPosition(next, textSel)).toEqual({ x: 200, y: 320 });
    expect(layerTransformKeys(next, emphasisSel)).toEqual([{ at: 1, x: 20, y: 20 }]);
  });

  it('an empty moves array is a true no-op — same manifest reference back', () => {
    expect(moveLayersByDeltaAutoKey(sample, [], 5, 5, 0, 30)).toBe(sample);
  });
});

describe('resolveSelection / resolveSelections (D-158, stable layer identity)', () => {
  it('with no id, trusts the index as long as it still resolves', () => {
    const sel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 1 } };
    expect(resolveSelection(sample, sel)).toEqual(sel);
  });

  it('with no id, returns null once the index no longer resolves', () => {
    const sel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 99 } };
    expect(resolveSelection(sample, sel)).toBeNull();
  });

  it('returns null when the scene itself no longer exists', () => {
    const sel: Selection = { sceneIndex: 99, target: { kind: 'layer', index: 0 } };
    expect(resolveSelection(sample, sel)).toBeNull();
  });

  it('scene/camera/scene3d-camera targets resolve as long as the scene exists — positional by nature', () => {
    expect(resolveSelection(sample, { sceneIndex: 0, target: { kind: 'scene' } })).toEqual({
      sceneIndex: 0,
      target: { kind: 'scene' },
    });
    expect(resolveSelection(sample, { sceneIndex: 0, target: { kind: 'camera' } })).not.toBeNull();
    expect(resolveSelection(sample, { sceneIndex: 99, target: { kind: 'camera' } })).toBeNull();
  });

  it('with an id, corrects a stale index after a reorder', () => {
    const withIds: Manifest = structuredClone(sample);
    withIds.scenes[0].layers![0].id = 'text-a';
    withIds.scenes[0].layers![1].id = 'emphasis-b';
    // simulate a reorder: emphasis now sits at index 0, text at index 1
    withIds.scenes[0].layers!.reverse();

    const stale: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 0, id: 'text-a' } };
    const resolved = resolveSelection(withIds, stale);
    expect(resolved).toEqual({ sceneIndex: 0, target: { kind: 'layer', index: 1, id: 'text-a' } });
  });

  it('with an id, returns null once the layer it names is gone (deleted, not just moved)', () => {
    const withIds: Manifest = structuredClone(sample);
    withIds.scenes[0].layers![0].id = 'text-a';
    withIds.scenes[0].layers = withIds.scenes[0].layers!.filter((l) => l.id !== 'text-a');

    const stale: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 0, id: 'text-a' } };
    expect(resolveSelection(withIds, stale)).toBeNull();
  });

  it('resolves a scene3d-child by id the same way a 2D layer resolves', () => {
    const withIds: Manifest = structuredClone(sample);
    const s3 = withIds.scenes[2].scene3d!;
    s3.children[0].id = 'stream';
    s3.children[1].id = 'converge';
    s3.children.reverse();

    const stale: Selection = { sceneIndex: 2, target: { kind: 'scene3d-child', index: 0, id: 'stream' } };
    expect(resolveSelection(withIds, stale)).toEqual({
      sceneIndex: 2,
      target: { kind: 'scene3d-child', index: 1, id: 'stream' },
    });
  });

  it('resolveSelections drops unresolvable entries and keeps the rest, in order', () => {
    const withIds: Manifest = structuredClone(sample);
    withIds.scenes[0].layers![0].id = 'text-a';

    const selections: Selection[] = [
      { sceneIndex: 0, target: { kind: 'layer', index: 0, id: 'text-a' } },
      { sceneIndex: 0, target: { kind: 'layer', index: 99 } }, // stale, no id — drops
      { sceneIndex: 0, target: { kind: 'layer', index: 1 } }, // still resolves positionally
    ];
    expect(resolveSelections(withIds, selections)).toEqual([
      { sceneIndex: 0, target: { kind: 'layer', index: 0, id: 'text-a' } },
      { sceneIndex: 0, target: { kind: 'layer', index: 1 } },
    ]);
  });
});

describe('moveLayersByDelta', () => {
  const textSel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 0 } };
  const emphasisSel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 1 } };

  it('applies the SAME dx/dy to every entry, from each one\'s own captured base', () => {
    const moves = [
      { selection: textSel, base: { x: 180, y: 300 } },
      { selection: emphasisSel, base: { x: 980, y: 250 } },
    ];
    const next = moveLayersByDelta(sample, moves, 20, -10);
    expect(layerWorldPosition(next, textSel)).toEqual({ x: 200, y: 290 });
    expect(layerWorldPosition(next, emphasisSel)).toEqual({ x: 1000, y: 240 });
    // a position-only move never touches the emphasis box's own w/h
    expect(layerWorldSize(next, emphasisSel)).toEqual({ w: 520, h: 130 });
  });

  it('does not mutate the manifest it was given', () => {
    const moves = [{ selection: textSel, base: { x: 180, y: 300 } }];
    moveLayersByDelta(sample, moves, 50, 50);
    expect(layerWorldPosition(sample, textSel)).toEqual({ x: 180, y: 300 });
  });

  it('an empty moves array is a true no-op — same manifest reference back', () => {
    expect(moveLayersByDelta(sample, [], 100, 100)).toBe(sample);
  });

  it('produces ONE resulting manifest for N moves — a single object a caller commits once', () => {
    const moves = [
      { selection: textSel, base: { x: 180, y: 300 } },
      { selection: emphasisSel, base: { x: 980, y: 250 } },
    ];
    const next = moveLayersByDelta(sample, moves, 5, 5);
    // both edits landed in the SAME returned manifest, not two competing ones
    expect(layerWorldPosition(next, textSel)).toEqual({ x: 185, y: 305 });
    expect(layerWorldPosition(next, emphasisSel)).toEqual({ x: 985, y: 255 });
  });
});

describe('setFieldOnSelections / setTransformFieldOnSelections (Inspector lockstep edit)', () => {
  const textSel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 0 } };
  const emphasisSel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 1 } };

  it('writes the same top-level field to every selected layer', () => {
    const next = setFieldOnSelections(sample, [textSel, emphasisSel], 'dur', 5);
    expect(selectedLayer(next, textSel)?.raw.dur).toBe(5);
    expect(selectedLayer(next, emphasisSel)?.raw.dur).toBe(5);
  });

  it('does not mutate the original manifest', () => {
    setFieldOnSelections(sample, [textSel, emphasisSel], 'dur', 5);
    expect(selectedLayer(sample, textSel)?.raw.dur).toBeUndefined();
  });

  it('skips a selection that does not resolve rather than throwing', () => {
    const stale: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 99 } };
    const next = setFieldOnSelections(sample, [textSel, stale], 'dur', 3);
    expect(selectedLayer(next, textSel)?.raw.dur).toBe(3);
  });

  it('writes the same nested transform field to every selected layer', () => {
    const next = setTransformFieldOnSelections(sample, [textSel, emphasisSel], 'opacity', 0.5);
    expect(selectedLayer(next, textSel)?.raw.transform).toEqual({ opacity: 0.5 });
    expect(selectedLayer(next, emphasisSel)?.raw.transform).toEqual({ opacity: 0.5 });
  });
});

describe('alignSelections', () => {
  const textSel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 0 } }; // x:180,y:300, w:800(seed),h:null→0
  const emphasisSel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 1 } }; // box [980,250,520,130]

  it('is a no-op (same reference) with fewer than 2 resolvable boxes', () => {
    expect(alignSelections(sample, [textSel], 'left')).toBe(sample);
    expect(alignSelections(sample, [], 'left')).toBe(sample);
  });

  it('left: moves every box to the leftmost box\'s own left edge', () => {
    const next = alignSelections(sample, [textSel, emphasisSel], 'left');
    expect(layerWorldPosition(next, textSel)).toEqual({ x: 180, y: 300 }); // already leftmost
    expect(layerWorldPosition(next, emphasisSel)).toEqual({ x: 180, y: 250 });
  });

  it('right: moves every box so its right edge lands on the rightmost box\'s own right edge', () => {
    // text right edge = 180+800=980; emphasis right edge = 980+520=1500 (rightmost)
    const next = alignSelections(sample, [textSel, emphasisSel], 'right');
    expect(layerWorldPosition(next, textSel)).toEqual({ x: 700, y: 300 }); // 1500-800
    expect(layerWorldPosition(next, emphasisSel)).toEqual({ x: 980, y: 250 }); // unchanged, already rightmost
  });

  it('centerH: aligns every box\'s horizontal center to the midpoint of the group\'s extremes', () => {
    // extremes: min x=180, max right=1500 → mid=840
    const next = alignSelections(sample, [textSel, emphasisSel], 'centerH');
    expect(layerWorldPosition(next, textSel)).toEqual({ x: 440, y: 300 }); // 840-800/2
    expect(layerWorldPosition(next, emphasisSel)).toEqual({ x: 580, y: 250 }); // 840-520/2
  });

  it('top / bottom / centerV: same logic on the Y axis, treating text\'s null height as 0', () => {
    // tops: text=300, emphasis=250 → min=250. bottoms: text=300 (h=0), emphasis=380 → max=380.
    const top = alignSelections(sample, [textSel, emphasisSel], 'top');
    expect(layerWorldPosition(top, textSel)?.y).toBe(250);
    expect(layerWorldPosition(top, emphasisSel)?.y).toBe(250); // already topmost

    const bottom = alignSelections(sample, [textSel, emphasisSel], 'bottom');
    expect(layerWorldPosition(bottom, textSel)?.y).toBe(380); // 380-0
    expect(layerWorldPosition(bottom, emphasisSel)?.y).toBe(250); // 380-130, already bottommost

    const centerV = alignSelections(sample, [textSel, emphasisSel], 'centerV');
    expect(layerWorldPosition(centerV, textSel)?.y).toBe(315); // mid(250,380)=315, -0
    expect(layerWorldPosition(centerV, emphasisSel)?.y).toBe(250); // 315-130/2
  });

  it('never touches size — only setLayerPosition is used', () => {
    const next = alignSelections(sample, [textSel, emphasisSel], 'left');
    expect(layerWorldSize(next, emphasisSel)).toEqual({ w: 520, h: 130 });
  });

  it('a selection with no resolvable position (e.g. a stale index) is dropped, not given a 0,0 box', () => {
    const stale: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 99 } };
    // only 1 REAL box remains once the stale one is dropped — no-op, same reference
    expect(alignSelections(sample, [textSel, stale], 'left')).toBe(sample);
  });
});

describe('distributeSelections', () => {
  // Three `emphasis` boxes on one axis, unequally spaced, so the equal-gap
  // result is unambiguous and easy to hand-verify: A@x0 w100, B@x300 w100,
  // C@x1000 w100. span = (1000+100)-0 = 1100; totalSize = 300; gap = 400.
  function threeBoxManifest(): Manifest {
    const m: Manifest = structuredClone(sample);
    m.scenes[0].layers = [
      { use: 'emphasis', preset: 'scribble', box: [0, 0, 100, 50] },
      { use: 'emphasis', preset: 'scribble', box: [300, 0, 100, 50] },
      { use: 'emphasis', preset: 'scribble', box: [1000, 0, 100, 50] },
    ];
    return m;
  }
  const a: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 0 } };
  const b: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 1 } };
  const c: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 2 } };

  it('is a no-op (same reference) with fewer than 3 resolvable boxes', () => {
    const m = threeBoxManifest();
    expect(distributeSelections(m, [a, b], 'horizontal')).toBe(m);
    expect(distributeSelections(m, [], 'horizontal')).toBe(m);
  });

  it('spaces the middle box(es) so every gap between adjacent boxes is equal', () => {
    const m = threeBoxManifest();
    const next = distributeSelections(m, [a, b, c], 'horizontal');
    expect(layerWorldPosition(next, a)?.x).toBe(0); // first stays put
    expect(layerWorldPosition(next, b)?.x).toBe(500); // 0 + 100 + 400
    expect(layerWorldPosition(next, c)?.x).toBe(1000); // last stays put
  });

  it('is order-independent in the input array — sorts by position itself', () => {
    const m = threeBoxManifest();
    const next = distributeSelections(m, [c, a, b], 'horizontal');
    expect(layerWorldPosition(next, b)?.x).toBe(500);
  });

  it('vertical axis uses y/h the same way', () => {
    const m: Manifest = structuredClone(sample);
    m.scenes[0].layers = [
      { use: 'emphasis', preset: 'scribble', box: [0, 0, 50, 100] },
      { use: 'emphasis', preset: 'scribble', box: [0, 300, 50, 100] },
      { use: 'emphasis', preset: 'scribble', box: [0, 1000, 50, 100] },
    ];
    const next = distributeSelections(m, [a, b, c], 'vertical');
    expect(layerWorldPosition(next, a)?.y).toBe(0);
    expect(layerWorldPosition(next, b)?.y).toBe(500);
    expect(layerWorldPosition(next, c)?.y).toBe(1000);
  });

  it('never touches x/width when distributing vertically', () => {
    const m: Manifest = structuredClone(sample);
    m.scenes[0].layers = [
      { use: 'emphasis', preset: 'scribble', box: [42, 0, 50, 100] },
      { use: 'emphasis', preset: 'scribble', box: [42, 300, 50, 100] },
      { use: 'emphasis', preset: 'scribble', box: [42, 1000, 50, 100] },
    ];
    const next = distributeSelections(m, [a, b, c], 'vertical');
    expect(layerWorldPosition(next, b)?.x).toBe(42);
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

describe('sceneIndexAtFrame', () => {
  // sample: hook (dur 4s -> 120fr), stack (dur 6s -> 180fr), space (dur 5s -> 150fr), fps 30
  // scene starts: hook=0, stack=120, space=300; total=450
  it('resolves a frame inside the first scene', () => {
    expect(sceneIndexAtFrame(sample, 0)).toBe(0);
    expect(sceneIndexAtFrame(sample, 119)).toBe(0);
  });

  it('resolves exactly on a scene boundary to the NEXT scene', () => {
    expect(sceneIndexAtFrame(sample, 120)).toBe(1);
    expect(sceneIndexAtFrame(sample, 300)).toBe(2);
  });

  it('resolves a frame inside a middle/last scene', () => {
    expect(sceneIndexAtFrame(sample, 299)).toBe(1);
    expect(sceneIndexAtFrame(sample, 449)).toBe(2);
  });

  it('clamps a frame past the end to the last scene', () => {
    expect(sceneIndexAtFrame(sample, 450)).toBe(2);
    expect(sceneIndexAtFrame(sample, 100000)).toBe(2);
  });

  it('clamps a negative frame to the first scene', () => {
    expect(sceneIndexAtFrame(sample, -5)).toBe(0);
  });
});

describe('layerVisibleFrameRange', () => {
  // sample: hook (start=0, dur=4s=120fr) has text at=0.2 (no dur), emphasis
  // at=1.8/dur=2; stack (start=120, dur=6s=180fr) has layers at=0.4 (no dur);
  // space (start=300) has a particleflow scene3d-child at=1.5/dur=2.5.
  it('returns [start, start+dur] when the layer has a dur', () => {
    const sel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 1 } }; // emphasis
    expect(layerVisibleFrameRange(sample, sel)).toEqual({ start: 54, end: 114 });
  });

  it('ends at the scene end when the layer has no dur', () => {
    const sel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 0 } }; // text, at=0.2
    expect(layerVisibleFrameRange(sample, sel)).toEqual({ start: 6, end: 120 });
  });

  it('accounts for the scene not starting at frame 0', () => {
    const sel: Selection = { sceneIndex: 1, target: { kind: 'layer', index: 1 } }; // layers, at=0.4
    expect(layerVisibleFrameRange(sample, sel)).toEqual({ start: 132, end: 300 });
  });

  it('works for a scene3d-child, same as a 2D layer', () => {
    const sel: Selection = { sceneIndex: 2, target: { kind: 'scene3d-child', index: 1 } }; // particleflow at=1.5/dur=2.5
    expect(layerVisibleFrameRange(sample, sel)).toEqual({ start: 345, end: 420 });
  });

  it('returns null for a selection with no at/dur of its own', () => {
    expect(layerVisibleFrameRange(sample, { sceneIndex: 0, target: { kind: 'scene' } })).toBeNull();
    expect(layerVisibleFrameRange(sample, { sceneIndex: 0, target: { kind: 'camera' } })).toBeNull();
  });

  it('returns null for an unresolvable selection', () => {
    expect(layerVisibleFrameRange(sample, { sceneIndex: 0, target: { kind: 'layer', index: 99 } })).toBeNull();
  });
});

describe('reorderLayers (D-177 — drag-to-reorder, LayerList.tsx)', () => {
  /** A 3-`layers` scene, distinct from `sample`'s own 2-layer scenes — needed
   *  to tell "moved to last" apart from "swapped with its only neighbor,"
   *  and to give "move the first item to last (and vice versa)" a real
   *  middle item that must NOT move. */
  function threeLayerManifest(): Manifest {
    const m = structuredClone(sample);
    m.scenes[0].layers = [
      { use: 'text', text: 'first', id: 'a', x: 1, y: 1 },
      { use: 'text', text: 'second', id: 'b', x: 2, y: 2 },
      { use: 'text', text: 'third', id: 'c', x: 3, y: 3 },
    ];
    return m;
  }

  it('is a pure array move — every field of the moved layer survives untouched', () => {
    // scene 0 "hook": [text, emphasis] — move the emphasis layer (index 1,
    // with several of its own fields: preset/at/dur/box) to the front.
    const before = selectedLayer(sample, { sceneIndex: 0, target: { kind: 'layer', index: 1 } });
    const next = reorderLayers(sample, 0, 'layer', 1, 0);
    expect(next.scenes[0].layers![0]).toEqual(before?.raw);
    // the displaced layer (the original text layer) is still fully intact,
    // just shifted down — not dropped, not field-stripped.
    expect(next.scenes[0].layers![1]).toEqual(sample.scenes[0].layers![0]);
    // original untouched (immutability)
    expect(sample.scenes[0].layers![0].use).toBe('text');
  });

  it('reordering to the SAME index is a no-op — the identical manifest reference back', () => {
    const next = reorderLayers(sample, 0, 'layer', 1, 1);
    expect(next).toBe(sample);
  });

  it('an out-of-range fromIndex does nothing rather than throwing or corrupting the array', () => {
    const next = reorderLayers(sample, 0, 'layer', 99, 0);
    expect(next).toBe(sample);
    expect(next.scenes[0].layers).toHaveLength(2);
  });

  it('an out-of-range toIndex does nothing rather than throwing or corrupting the array', () => {
    const next = reorderLayers(sample, 0, 'layer', 0, 99);
    expect(next).toBe(sample);
    expect(next.scenes[0].layers).toHaveLength(2);
  });

  it('a negative index does nothing rather than throwing or corrupting the array', () => {
    expect(reorderLayers(sample, 0, 'layer', -1, 0)).toBe(sample);
    expect(reorderLayers(sample, 0, 'layer', 0, -1)).toBe(sample);
  });

  it('moves the first layer to the last position, leaving the middle one in place relative to the others', () => {
    const m = threeLayerManifest();
    const next = reorderLayers(m, 0, 'layer', 0, 2);
    expect(next.scenes[0].layers!.map((l) => l.id)).toEqual(['b', 'c', 'a']);
  });

  it('moves the last layer to the first position', () => {
    const m = threeLayerManifest();
    const next = reorderLayers(m, 0, 'layer', 2, 0);
    expect(next.scenes[0].layers!.map((l) => l.id)).toEqual(['c', 'a', 'b']);
  });

  it('moves a middle layer past a neighbor by one slot', () => {
    const m = threeLayerManifest();
    const next = reorderLayers(m, 0, 'layer', 1, 2);
    expect(next.scenes[0].layers!.map((l) => l.id)).toEqual(['a', 'c', 'b']);
  });

  it('is a no-op for a scene with no `layers` array at all', () => {
    // scene 2 "space" has scene3d but no top-level `layers`.
    const next = reorderLayers(sample, 2, 'layer', 0, 1);
    expect(next).toBe(sample);
  });

  it('is a no-op for a scene with no `scene3d` at all', () => {
    // scene 0 "hook" has no scene3d.
    const next = reorderLayers(sample, 0, 'scene3d-child', 0, 1);
    expect(next).toBe(sample);
  });

  it('is a no-op for an out-of-range scene index', () => {
    const next = reorderLayers(sample, 99, 'layer', 0, 1);
    expect(next).toBe(sample);
  });

  it('reorders scene3d.children the same way it reorders 2D layers', () => {
    // scene 2 "space": children = [particleflow "stream", particleflow "converge"]
    const next = reorderLayers(sample, 2, 'scene3d-child', 0, 1);
    expect(next.scenes[2].scene3d!.children.map((c) => c.preset)).toEqual(['converge', 'stream']);
    // untouched original
    expect(sample.scenes[2].scene3d!.children.map((c) => c.preset)).toEqual(['stream', 'converge']);
  });

  it('never touches a DIFFERENT scene\'s layers, or bridges `layers` and `scene3d.children`', () => {
    const next = reorderLayers(sample, 0, 'layer', 0, 1);
    // scene 1 and scene 2 are byte-for-byte identical (reference-equal even,
    // since `clone()` is a structuredClone of the whole manifest but nothing
    // downstream mutates scenes it doesn't touch) — the important assertion
    // is VALUE equality, not sharing scene 0's own change.
    expect(next.scenes[1]).toEqual(sample.scenes[1]);
    expect(next.scenes[2]).toEqual(sample.scenes[2]);
  });

  it('a moved layer whose id is tracked by a live Selection still resolves to it afterward (resolveSelection, D-158)', () => {
    const m = threeLayerManifest();
    // The selection was made while "first" (id: 'a') sat at index 0.
    const live: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 0, id: 'a' } };

    // Drag "first" to the very end.
    const next = reorderLayers(m, 0, 'layer', 0, 2);
    expect(next.scenes[0].layers!.map((l) => l.id)).toEqual(['b', 'c', 'a']);

    // Without id-based resolution this would silently resolve to whatever
    // now sits at index 0 ('b') instead of the layer the selection actually
    // names — the exact regression this test guards against.
    const resolved = resolveSelection(next, live);
    expect(resolved).toEqual({ sceneIndex: 0, target: { kind: 'layer', index: 2, id: 'a' } });
    expect(selectedLayer(next, resolved!)?.raw.text).toBe('first');
  });

  it('a multi-selection (resolveSelections) tracks every moved id-carrying layer after a reorder', () => {
    const m = threeLayerManifest();
    const live: Selection[] = [
      { sceneIndex: 0, target: { kind: 'layer', index: 0, id: 'a' } },
      { sceneIndex: 0, target: { kind: 'layer', index: 1, id: 'b' } },
    ];
    // Move "second" (b) to the front — a becomes index 1, b becomes index 0.
    const next = reorderLayers(m, 0, 'layer', 1, 0);
    expect(resolveSelections(next, live)).toEqual([
      { sceneIndex: 0, target: { kind: 'layer', index: 1, id: 'a' } },
      { sceneIndex: 0, target: { kind: 'layer', index: 0, id: 'b' } },
    ]);
  });
});

describe('addScene (D-179 — owner, live: "we need a way to create multiple scene… create a scene and edit it")', () => {
  it('appends a minimal, schema-valid scene at the end by default', () => {
    const before = sample;
    const { manifest, selection } = addScene(before);
    expect(manifest.scenes).toHaveLength(before.scenes.length + 1);
    const added = manifest.scenes[manifest.scenes.length - 1];
    expect(added.dur).toBe(4);
    expect(typeof added.id).toBe('string');
    expect(added.id.length).toBeGreaterThan(0);
    expect(added.layers).toBeUndefined();
    expect(added.camera).toBeUndefined();
    expect(added.scene3d).toBeUndefined();
    expect(selection).toEqual({ sceneIndex: manifest.scenes.length - 1, target: { kind: 'scene' } });
  });

  it('generates a fresh, non-empty, non-colliding id every call', () => {
    const { manifest: m1 } = addScene(sample);
    const { manifest: m2 } = addScene(sample);
    const id1 = m1.scenes[m1.scenes.length - 1].id;
    const id2 = m2.scenes[m2.scenes.length - 1].id;
    expect(id1).not.toBe(id2);
    expect(sample.scenes.some((s) => s.id === id1)).toBe(false);
  });

  it('inserts right AFTER afterSceneIndex when given, not at the end', () => {
    const { manifest, selection } = addScene(sample, 0);
    expect(manifest.scenes).toHaveLength(sample.scenes.length + 1);
    expect(manifest.scenes[0].id).toBe(sample.scenes[0].id); // scene before the insert is untouched
    expect(manifest.scenes[1].id).not.toBe(sample.scenes[1].id); // the new scene now sits here
    expect(manifest.scenes[2].id).toBe(sample.scenes[1].id); // the old scene 1 shifted down by one
    expect(selection).toEqual({ sceneIndex: 1, target: { kind: 'scene' } });
  });

  it('inserting after the LAST scene is the same as appending at the end', () => {
    const lastIndex = sample.scenes.length - 1;
    const { manifest, selection } = addScene(sample, lastIndex);
    expect(manifest.scenes).toHaveLength(sample.scenes.length + 1);
    expect(selection).toEqual({ sceneIndex: lastIndex + 1, target: { kind: 'scene' } });
  });

  it('an out-of-range afterSceneIndex falls back to appending at the end, never throws', () => {
    const { manifest, selection } = addScene(sample, 99);
    expect(manifest.scenes).toHaveLength(sample.scenes.length + 1);
    expect(selection).toEqual({ sceneIndex: sample.scenes.length, target: { kind: 'scene' } });
  });

  it('leaves every existing scene\'s OWN content byte-for-byte untouched', () => {
    const { manifest } = addScene(sample, 0);
    expect(manifest.scenes[0]).toEqual(sample.scenes[0]);
    expect(manifest.scenes[2]).toEqual(sample.scenes[1]);
    expect(manifest.scenes[3]).toEqual(sample.scenes[2]);
    expect(manifest.title).toBe(sample.title);
  });

  it('does not mutate the manifest it was given', () => {
    const snapshot = JSON.stringify(sample);
    addScene(sample);
    expect(JSON.stringify(sample)).toBe(snapshot);
  });
});

describe('selectedLayerItem / setLayerItemOffset / setLayerItemField / resetLayerItemPosition (D-182 — per-card drag-to-fix for `layers`, owner live: "layers are also build from composition… i would like to drag and correct it")', () => {
  // sample scene 1 "stack", layer 1 (the "layers" primitive) — its own real
  // items: ["tools","system prompt","retrieved context","your question"],
  // every one still a plain string (no dx/dy field exists anywhere in this
  // manifest — it didn't exist before this pass).
  const cardSel: Selection = { sceneIndex: 1, target: { kind: 'layer-item', index: 1, itemIndex: 0 } }; // "tools"

  it("reads a plain-string item as {label}, matching registry.ts's own read-time coercion", () => {
    expect(selectedLayerItem(sample, cardSel)).toEqual({ label: 'tools' });
  });

  it('is null for a selection that is not layer-item', () => {
    const notItem: Selection = { sceneIndex: 1, target: { kind: 'layer', index: 1 } };
    expect(selectedLayerItem(sample, notItem)).toBeNull();
  });

  it('is null for an out-of-range itemIndex', () => {
    const bad: Selection = { sceneIndex: 1, target: { kind: 'layer-item', index: 1, itemIndex: 99 } };
    expect(selectedLayerItem(sample, bad)).toBeNull();
  });

  it('is null when the parent layer does not resolve', () => {
    const bad: Selection = { sceneIndex: 1, target: { kind: 'layer-item', index: 99, itemIndex: 0 } };
    expect(selectedLayerItem(sample, bad)).toBeNull();
  });

  it('setLayerItemOffset promotes a plain string to {label, dx, dy}, writing both at once', () => {
    const next = setLayerItemOffset(sample, cardSel, 10, -20);
    expect(selectedLayerItem(next, cardSel)).toEqual({ label: 'tools', dx: 10, dy: -20 });
  });

  it('setLayerItemOffset never disturbs a SIBLING card', () => {
    const next = setLayerItemOffset(sample, cardSel, 10, -20);
    const sibling: Selection = { sceneIndex: 1, target: { kind: 'layer-item', index: 1, itemIndex: 1 } };
    expect(selectedLayerItem(next, sibling)).toEqual({ label: 'system prompt' });
  });

  it("setLayerItemOffset never disturbs the parent layer's OWN fields (items array aside)", () => {
    const next = setLayerItemOffset(sample, cardSel, 10, -20);
    const layer = next.scenes[1].layers![1] as unknown as Record<string, unknown>;
    expect(layer.callout).toBe('re-sent on every call');
    expect(layer.active).toEqual([
      { at: 2.5, i: 2 },
      { at: 4, i: 0 },
    ]);
  });

  it('setLayerItemOffset merges onto an ALREADY-object item, preserving/overwriting correctly', () => {
    const withObj = setLayerItemOffset(sample, cardSel, 5, 5); // promotes "tools" -> {label,dx:5,dy:5}
    const next = setLayerItemOffset(withObj, cardSel, 12, 34);
    expect(selectedLayerItem(next, cardSel)).toEqual({ label: 'tools', dx: 12, dy: 34 });
  });

  it('is a no-op for a selection that is not layer-item', () => {
    const notItem: Selection = { sceneIndex: 1, target: { kind: 'layer', index: 1 } };
    expect(setLayerItemOffset(sample, notItem, 1, 1)).toBe(sample);
  });

  it('is a no-op for an out-of-range itemIndex', () => {
    const bad: Selection = { sceneIndex: 1, target: { kind: 'layer-item', index: 1, itemIndex: 99 } };
    expect(setLayerItemOffset(sample, bad, 1, 1)).toBe(sample);
  });

  it('setLayerItemField writes a single field (label), leaving dx/dy alone', () => {
    const withOffset = setLayerItemOffset(sample, cardSel, 3, 4);
    const next = setLayerItemField(withOffset, cardSel, 'label', 'TOOLS');
    expect(selectedLayerItem(next, cardSel)).toEqual({ label: 'TOOLS', dx: 3, dy: 4 });
  });

  it('setLayerItemField(key, undefined) deletes that one key only', () => {
    const withOffset = setLayerItemOffset(sample, cardSel, 3, 4);
    const next = setLayerItemField(withOffset, cardSel, 'dx', undefined);
    expect(selectedLayerItem(next, cardSel)).toEqual({ label: 'tools', dy: 4 });
  });

  it('resetLayerItemPosition deletes BOTH dx and dy in one pass', () => {
    const withOffset = setLayerItemOffset(sample, cardSel, 3, 4);
    const next = resetLayerItemPosition(withOffset, cardSel);
    expect(selectedLayerItem(next, cardSel)).toEqual({ label: 'tools' });
  });

  it('does not mutate the manifest it was given', () => {
    const snapshot = JSON.stringify(sample);
    setLayerItemOffset(sample, cardSel, 1, 1);
    expect(JSON.stringify(sample)).toBe(snapshot);
  });
});

describe('resolveSelection — layer-item (D-182)', () => {
  const cardSel: Selection = { sceneIndex: 1, target: { kind: 'layer-item', index: 1, itemIndex: 0 } };

  it('resolves an existing card unchanged (no id on LayerItem — index-only, like every other un-id\'d target)', () => {
    expect(resolveSelection(sample, cardSel)).toEqual(cardSel);
  });

  it('is null when the itemIndex no longer exists', () => {
    const bad: Selection = { sceneIndex: 1, target: { kind: 'layer-item', index: 1, itemIndex: 99 } };
    expect(resolveSelection(sample, bad)).toBeNull();
  });

  it('is null when the parent layer no longer exists', () => {
    const bad: Selection = { sceneIndex: 1, target: { kind: 'layer-item', index: 99, itemIndex: 0 } };
    expect(resolveSelection(sample, bad)).toBeNull();
  });

  it('is null when the scene no longer exists', () => {
    const bad: Selection = { sceneIndex: 99, target: { kind: 'layer-item', index: 1, itemIndex: 0 } };
    expect(resolveSelection(sample, bad)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// D-259 — delete / duplicate
// ---------------------------------------------------------------------------

describe('deleteLayer (D-259)', () => {
  it('removes the addressed layer and leaves every other one untouched', () => {
    const sel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 0 } };
    const { manifest } = deleteLayer(sample, sel);
    expect(manifest.scenes[0].layers).toHaveLength(1);
    expect(manifest.scenes[0].layers?.[0]).toEqual(sample.scenes[0].layers?.[1]);
    // nothing else in the document moved
    expect(manifest.scenes[1]).toEqual(sample.scenes[1]);
    expect(manifest.scenes[2]).toEqual(sample.scenes[2]);
    expect(manifest.scenes[0].camera).toEqual(sample.scenes[0].camera);
  });

  it('selects the layer that slid into the deleted slot', () => {
    const sel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 0 } };
    const { selection } = deleteLayer(sample, sel);
    expect(selection).toEqual({ sceneIndex: 0, target: { kind: 'layer', index: 0, id: undefined } });
  });

  it('deleting the LAST layer selects the new last one, never an out-of-range index', () => {
    const sel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 1 } };
    const { manifest, selection } = deleteLayer(sample, sel);
    expect(manifest.scenes[0].layers).toHaveLength(1);
    expect(selection?.target).toMatchObject({ kind: 'layer', index: 0 });
    // and it really resolves against the manifest it came back with
    expect(resolveSelection(manifest, selection as Selection)).not.toBeNull();
  });

  it('emptying scene.layers removes the key entirely, and selection falls back to the scene', () => {
    const first = deleteLayer(sample, { sceneIndex: 0, target: { kind: 'layer', index: 0 } });
    const second = deleteLayer(first.manifest, { sceneIndex: 0, target: { kind: 'layer', index: 0 } });
    expect(second.manifest.scenes[0].layers).toBeUndefined();
    expect(second.selection).toEqual({ sceneIndex: 0, target: { kind: 'scene' } });
    expect(resolveSelection(second.manifest, second.selection as Selection)).not.toBeNull();
  });

  it('deletes a scene3d child, and KEEPS a childless scene3d block (its camera survives)', () => {
    const a = deleteLayer(sample, { sceneIndex: 2, target: { kind: 'scene3d-child', index: 0 } });
    expect(a.manifest.scenes[2].scene3d?.children).toHaveLength(1);
    const b = deleteLayer(a.manifest, { sceneIndex: 2, target: { kind: 'scene3d-child', index: 0 } });
    expect(b.manifest.scenes[2].scene3d).toBeDefined();
    expect(b.manifest.scenes[2].scene3d?.children).toEqual([]);
    expect(b.manifest.scenes[2].scene3d?.camera).toEqual(sample.scenes[2].scene3d?.camera);
    expect(b.selection).toEqual({ sceneIndex: 2, target: { kind: 'scene' } });
  });

  it('resolves by id first — a stale index with a live id deletes the id\'s layer', () => {
    // give the sample's two scene-0 layers real ids, then address the SECOND
    // one by id while carrying a wrong index (the exact drift D-158 exists for)
    const withIds: Manifest = JSON.parse(JSON.stringify(sample));
    withIds.scenes[0].layers![0].id = 'aaa';
    withIds.scenes[0].layers![1].id = 'bbb';
    const { manifest } = deleteLayer(withIds, { sceneIndex: 0, target: { kind: 'layer', index: 0, id: 'bbb' } });
    expect(manifest.scenes[0].layers).toHaveLength(1);
    expect(manifest.scenes[0].layers?.[0].id).toBe('aaa');
  });

  it('carries the surviving neighbour\'s own id into the next selection', () => {
    const withIds: Manifest = JSON.parse(JSON.stringify(sample));
    withIds.scenes[0].layers![0].id = 'aaa';
    withIds.scenes[0].layers![1].id = 'bbb';
    const { selection } = deleteLayer(withIds, { sceneIndex: 0, target: { kind: 'layer', index: 0 } });
    expect(selection).toEqual({ sceneIndex: 0, target: { kind: 'layer', index: 0, id: 'bbb' } });
  });

  it('is a no-op (SAME reference, null selection) for a non-layer target', () => {
    for (const target of [{ kind: 'scene' as const }, { kind: 'camera' as const }]) {
      const r = deleteLayer(sample, { sceneIndex: 0, target });
      expect(r.manifest).toBe(sample);
      expect(r.selection).toBeNull();
    }
  });

  it('is a no-op for an out-of-range index, a missing scene, and an unknown id', () => {
    expect(deleteLayer(sample, { sceneIndex: 0, target: { kind: 'layer', index: 99 } }).manifest).toBe(sample);
    expect(deleteLayer(sample, { sceneIndex: 99, target: { kind: 'layer', index: 0 } }).manifest).toBe(sample);
    expect(deleteLayer(sample, { sceneIndex: 0, target: { kind: 'layer', index: 0, id: 'nope' } }).manifest).toBe(sample);
    // a scene with no scene3d at all
    expect(deleteLayer(sample, { sceneIndex: 0, target: { kind: 'scene3d-child', index: 0 } }).manifest).toBe(sample);
  });

  it('does not mutate the manifest it was given', () => {
    const snapshot = JSON.stringify(sample);
    deleteLayer(sample, { sceneIndex: 0, target: { kind: 'layer', index: 0 } });
    expect(JSON.stringify(sample)).toBe(snapshot);
  });
});

describe('canDeleteScene / deleteScene (D-259)', () => {
  it('canDeleteScene is false for a one-scene manifest (schema.ts: scenes.min(1))', () => {
    expect(canDeleteScene(sample)).toBe(true);
    const one: Manifest = { ...sample, scenes: [sample.scenes[0]] };
    expect(canDeleteScene(one)).toBe(false);
  });

  it('removes the scene and shifts every later one down by one', () => {
    const { manifest } = deleteScene(sample, 0);
    expect(manifest.scenes).toHaveLength(2);
    expect(manifest.scenes[0]).toEqual(sample.scenes[1]);
    expect(manifest.scenes[1]).toEqual(sample.scenes[2]);
    expect(manifest.title).toBe(sample.title);
  });

  it('selects the scene that slid into the deleted index', () => {
    expect(deleteScene(sample, 0).selection).toEqual({ sceneIndex: 0, target: { kind: 'scene' } });
    expect(deleteScene(sample, 1).selection).toEqual({ sceneIndex: 1, target: { kind: 'scene' } });
  });

  it('deleting the LAST scene selects the new last one, not an out-of-range index', () => {
    const { manifest, selection } = deleteScene(sample, 2);
    expect(manifest.scenes).toHaveLength(2);
    expect(selection).toEqual({ sceneIndex: 1, target: { kind: 'scene' } });
    expect(resolveSelection(manifest, selection as Selection)).not.toBeNull();
  });

  it('REFUSES to delete the only remaining scene — same reference, null selection', () => {
    const one: Manifest = { ...sample, scenes: [sample.scenes[0]] };
    const r = deleteScene(one, 0);
    expect(r.manifest).toBe(one);
    expect(r.manifest.scenes).toHaveLength(1);
    expect(r.selection).toBeNull();
  });

  it('is a no-op for an out-of-range scene index', () => {
    expect(deleteScene(sample, 99).manifest).toBe(sample);
    expect(deleteScene(sample, -1).manifest).toBe(sample);
  });

  it('does not mutate the manifest it was given', () => {
    const snapshot = JSON.stringify(sample);
    deleteScene(sample, 1);
    expect(JSON.stringify(sample)).toBe(snapshot);
  });
});

describe('duplicateLayer (D-259)', () => {
  it('inserts the copy DIRECTLY AFTER the original, not at the end', () => {
    const { manifest, selection } = duplicateLayer(sample, { sceneIndex: 0, target: { kind: 'layer', index: 0 } });
    expect(manifest.scenes[0].layers).toHaveLength(3);
    expect(manifest.scenes[0].layers?.[0].use).toBe('text');
    expect(manifest.scenes[0].layers?.[1].use).toBe('text'); // the copy
    expect(manifest.scenes[0].layers?.[2].use).toBe('emphasis'); // the old neighbour, shifted
    expect(selection).toMatchObject({ sceneIndex: 0, target: { kind: 'layer', index: 1 } });
  });

  it('copies every field deeply, but never the id — and the copy is independent', () => {
    const withIds: Manifest = JSON.parse(JSON.stringify(sample));
    withIds.scenes[1].layers![1].id = 'orig';
    const { manifest, selection } = duplicateLayer(withIds, { sceneIndex: 1, target: { kind: 'layer', index: 1 } });
    const original = manifest.scenes[1].layers![1] as unknown as Record<string, unknown>;
    const copy = manifest.scenes[1].layers![2] as unknown as Record<string, unknown>;

    expect(copy.id).not.toBe('orig');
    expect(typeof copy.id).toBe('string');
    expect(selection?.target).toMatchObject({ kind: 'layer', index: 2, id: copy.id });
    // everything except the id is identical…
    expect({ ...copy, id: 'orig' }).toEqual(original);
    // …and the nested `items` array is a real clone, not a shared reference
    expect(copy.items).not.toBe(original.items);
    (copy.items as unknown[])[0] = 'changed';
    expect((original.items as unknown[])[0]).not.toBe('changed');
  });

  it('duplicates a scene3d child into scene3d.children', () => {
    const { manifest, selection } = duplicateLayer(sample, {
      sceneIndex: 2,
      target: { kind: 'scene3d-child', index: 0 },
    });
    expect(manifest.scenes[2].scene3d?.children).toHaveLength(3);
    expect(manifest.scenes[2].scene3d?.children[1].use).toBe('particleflow');
    expect(selection?.target).toMatchObject({ kind: 'scene3d-child', index: 1 });
    expect(manifest.scenes[2].layers).toBeUndefined(); // never leaked into the 2D array
  });

  it('resolves by id first, exactly as deleteLayer does', () => {
    const withIds: Manifest = JSON.parse(JSON.stringify(sample));
    withIds.scenes[0].layers![0].id = 'aaa';
    withIds.scenes[0].layers![1].id = 'bbb';
    const { manifest } = duplicateLayer(withIds, { sceneIndex: 0, target: { kind: 'layer', index: 0, id: 'bbb' } });
    // 'bbb' is at index 1, so its copy lands at index 2 — not next to 'aaa'
    expect(manifest.scenes[0].layers?.map((l) => l.use)).toEqual(['text', 'emphasis', 'emphasis']);
  });

  it('is a no-op for a non-layer target, a bad index and a missing scene', () => {
    expect(duplicateLayer(sample, { sceneIndex: 0, target: { kind: 'scene' } }).manifest).toBe(sample);
    expect(duplicateLayer(sample, { sceneIndex: 0, target: { kind: 'layer', index: 99 } }).manifest).toBe(sample);
    expect(duplicateLayer(sample, { sceneIndex: 99, target: { kind: 'layer', index: 0 } }).manifest).toBe(sample);
  });

  it('does not mutate the manifest it was given', () => {
    const snapshot = JSON.stringify(sample);
    duplicateLayer(sample, { sceneIndex: 0, target: { kind: 'layer', index: 0 } });
    expect(JSON.stringify(sample)).toBe(snapshot);
  });
});

describe('duplicateScene (D-259)', () => {
  it('inserts the copy directly after the original and selects it', () => {
    const { manifest, selection } = duplicateScene(sample, 0);
    expect(manifest.scenes).toHaveLength(4);
    expect(manifest.scenes[0].id).toBe('hook');
    expect(manifest.scenes[2].id).toBe('stack'); // the old scene 1, shifted
    expect(selection).toEqual({ sceneIndex: 1, target: { kind: 'scene' } });
  });

  it('gives the copy a fresh scene id and fresh ids for every layer inside it', () => {
    const withIds: Manifest = JSON.parse(JSON.stringify(sample));
    withIds.scenes[0].layers![0].id = 'aaa';
    withIds.scenes[0].layers![1].id = 'bbb';
    const { manifest } = duplicateScene(withIds, 0);
    const copy = manifest.scenes[1];

    expect(copy.id).not.toBe('hook');
    expect(copy.id.length).toBeGreaterThan(0);
    const ids = copy.layers!.map((l) => l.id);
    expect(ids).not.toContain('aaa');
    expect(ids).not.toContain('bbb');
    expect(new Set(ids).size).toBe(ids.length); // unique within the copy
    // everything else about the layers survived
    expect(copy.layers!.map((l) => l.use)).toEqual(['text', 'emphasis']);
    expect(copy.camera).toEqual(sample.scenes[0].camera);
    expect(copy.dur).toBe(sample.scenes[0].dur);
  });

  it('re-ids a 3D scene\'s children too, and keeps its camera', () => {
    const withIds: Manifest = JSON.parse(JSON.stringify(sample));
    withIds.scenes[2].scene3d!.children[0].id = 'ccc';
    const { manifest } = duplicateScene(withIds, 2);
    const copy = manifest.scenes[3];
    expect(copy.scene3d?.children.map((c) => c.id)).not.toContain('ccc');
    expect(copy.scene3d?.camera).toEqual(sample.scenes[2].scene3d?.camera);
  });

  it('the copy is fully independent of the original', () => {
    const { manifest } = duplicateScene(sample, 1);
    manifest.scenes[2].dur = 99;
    expect(manifest.scenes[1].dur).toBe(sample.scenes[1].dur);
  });

  it('is a no-op for an out-of-range scene index', () => {
    expect(duplicateScene(sample, 99).manifest).toBe(sample);
    expect(duplicateScene(sample, 99).selection).toBeNull();
  });

  it('does not mutate the manifest it was given', () => {
    const snapshot = JSON.stringify(sample);
    duplicateScene(sample, 0);
    expect(JSON.stringify(sample)).toBe(snapshot);
  });
});

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
  parseJsonField,
} from './manifestEdit';
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

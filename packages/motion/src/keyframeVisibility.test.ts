import { describe, it, expect } from 'vitest';
import { sample } from '@chroma/motion-engine/src/engine/sample';
import type { Manifest } from '@chroma/motion-engine/src/engine/schema';
import type { Selection } from './LayerList';
import {
  layerKeyCount,
  cameraKeyCount,
  scene3dCameraKeyCount,
  cameraKeyMarkers,
  selectedLayerKeyMarkers,
  sceneBoundaryFrames,
  frameToPercent,
} from './keyframeVisibility';

// `sample`'s own real shape (`packages/motion-engine/src/engine/sample.ts`),
// worked out by hand once here rather than re-derived in every test below:
// fps 30; scene 0 "hook" dur 4s -> 120 frames, camera keys at 0/0.4/1.6s ->
// frames 0/12/48; scene 1 "stack" dur 6s -> 180 frames, no camera; scene 2
// "space" dur 5s -> 150 frames, scene3d camera keys at 0/5s -> frames 0/150
// relative to its own start. Scene starts: 0, 120, 300. Total: 450.

function withLayerKeys(keys: { at: number; x?: number }[]): Manifest {
  const next = structuredClone(sample);
  (next.scenes[0].layers![0] as unknown as Record<string, unknown>).transform = { keys };
  return next;
}

describe('layerKeyCount', () => {
  it('is 0 for a layer with no transform at all', () => {
    expect(layerKeyCount(sample.scenes[0].layers![0])).toBe(0);
  });

  it('is 0 for a layer whose transform has no keys field', () => {
    const m = structuredClone(sample);
    (m.scenes[0].layers![0] as unknown as Record<string, unknown>).transform = { x: 10 };
    expect(layerKeyCount(m.scenes[0].layers![0])).toBe(0);
  });

  it('counts a real keys array', () => {
    const m = withLayerKeys([{ at: 0, x: 0 }, { at: 2, x: 300 }]);
    expect(layerKeyCount(m.scenes[0].layers![0])).toBe(2);
  });
});

describe('cameraKeyCount / scene3dCameraKeyCount', () => {
  it('counts scene 0 (hook)\'s 2D camera keys', () => {
    expect(cameraKeyCount(sample.scenes[0])).toBe(3);
  });

  it('is 0 for a camera-less scene', () => {
    expect(cameraKeyCount(sample.scenes[1])).toBe(0);
  });

  it('is 0 for a scene with no scene3d', () => {
    expect(scene3dCameraKeyCount(sample.scenes[0])).toBe(0);
  });

  it('counts scene 2 (space)\'s 3D camera keys', () => {
    expect(scene3dCameraKeyCount(sample.scenes[2])).toBe(2);
  });
});

describe('cameraKeyMarkers', () => {
  it('covers every 2D and 3D camera key across the whole manifest, in scene/kind/key order', () => {
    const markers = cameraKeyMarkers(sample);
    expect(markers).toEqual([
      { sceneIndex: 0, frame: 0, kind: 'camera' },
      { sceneIndex: 0, frame: 12, kind: 'camera' },
      { sceneIndex: 0, frame: 48, kind: 'camera' },
      { sceneIndex: 2, frame: 300, kind: 'scene3d-camera' },
      { sceneIndex: 2, frame: 450, kind: 'scene3d-camera' },
    ]);
  });

  it('is empty for a manifest with no cameras at all', () => {
    const m: Manifest = { ...sample, scenes: [sample.scenes[1]] };
    expect(cameraKeyMarkers(m)).toEqual([]);
  });

  it('is deterministic across repeated calls on the same manifest', () => {
    expect(cameraKeyMarkers(sample)).toEqual(cameraKeyMarkers(sample));
  });
});

describe('selectedLayerKeyMarkers', () => {
  it('is empty with no selection', () => {
    expect(selectedLayerKeyMarkers(sample, [])).toEqual([]);
  });

  it('is empty with 2+ selections (no lockstep meaning, matches TransformKeysSection\'s own scoping)', () => {
    const sels: Selection[] = [
      { sceneIndex: 0, target: { kind: 'layer', index: 0 } },
      { sceneIndex: 0, target: { kind: 'layer', index: 1 } },
    ];
    expect(selectedLayerKeyMarkers(sample, sels)).toEqual([]);
  });

  it('is empty for a non-layer single selection (scene/camera/3D-camera)', () => {
    expect(selectedLayerKeyMarkers(sample, [{ sceneIndex: 0, target: { kind: 'scene' } }])).toEqual([]);
    expect(selectedLayerKeyMarkers(sample, [{ sceneIndex: 0, target: { kind: 'camera' } }])).toEqual([]);
    expect(selectedLayerKeyMarkers(sample, [{ sceneIndex: 2, target: { kind: 'scene3d-camera' } }])).toEqual([]);
  });

  it('is empty for a scene3d-child selection (transform.keys only exists on 2D layers)', () => {
    const sel: Selection = { sceneIndex: 2, target: { kind: 'scene3d-child', index: 0 } };
    expect(selectedLayerKeyMarkers(sample, sel ? [sel] : [])).toEqual([]);
  });

  it('is empty for a real layer selection that has no transform.keys', () => {
    const sel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 0 } };
    expect(selectedLayerKeyMarkers(sample, [sel])).toEqual([]);
  });

  it('converts a real transform.keys array to absolute frames in its own scene', () => {
    const m = withLayerKeys([{ at: 0, x: 0 }, { at: 2, x: 300 }]);
    const sel: Selection = { sceneIndex: 0, target: { kind: 'layer', index: 0 } };
    expect(selectedLayerKeyMarkers(m, [sel])).toEqual([
      { sceneIndex: 0, frame: 0, kind: 'layer' },
      { sceneIndex: 0, frame: 60, kind: 'layer' }, // 2s * 30fps, scene 0 starts at frame 0
    ]);
  });

  it('offsets by the selected layer\'s own scene start frame, not scene 0\'s', () => {
    const m = structuredClone(sample);
    (m.scenes[1].layers![0] as unknown as Record<string, unknown>).transform = { keys: [{ at: 1, x: 0 }] };
    const sel: Selection = { sceneIndex: 1, target: { kind: 'layer', index: 0 } };
    // scene 1 ("stack") starts at frame 120; 1s * 30fps = 30 -> absolute 150
    expect(selectedLayerKeyMarkers(m, [sel])).toEqual([{ sceneIndex: 1, frame: 150, kind: 'layer' }]);
  });
});

describe('sceneBoundaryFrames', () => {
  it('lists every scene start except the first (frame 0 is not a boundary)', () => {
    expect(sceneBoundaryFrames(sample)).toEqual([120, 300]);
  });

  it('is empty for a single-scene manifest', () => {
    const m: Manifest = { ...sample, scenes: [sample.scenes[0]] };
    expect(sceneBoundaryFrames(m)).toEqual([]);
  });
});

describe('frameToPercent', () => {
  it('maps frame 0 to 0%', () => {
    expect(frameToPercent(0, 450)).toBe(0);
  });

  it('maps the last frame to 100%', () => {
    expect(frameToPercent(450, 450)).toBe(100);
  });

  it('maps a midpoint frame proportionally', () => {
    expect(frameToPercent(225, 450)).toBe(50);
  });

  it('clamps a frame past the end to 100%, never over', () => {
    expect(frameToPercent(9999, 450)).toBe(100);
  });

  it('clamps a negative frame to 0%, never under', () => {
    expect(frameToPercent(-10, 450)).toBe(0);
  });

  it('returns 0 rather than NaN/Infinity for a non-positive total', () => {
    expect(frameToPercent(10, 0)).toBe(0);
    expect(frameToPercent(10, -5)).toBe(0);
  });
});

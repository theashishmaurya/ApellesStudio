import { describe, it, expect } from 'vitest';
import { sample } from '@chroma/motion-engine/src/engine/sample';
import type { Manifest } from '@chroma/motion-engine/src/engine/schema';
import {
  layerKeyCount,
  cameraKeyCount,
  scene3dCameraKeyCount,
  keyframeLanes,
  laneKey,
  laneKeyMarkers,
  selectionForLane,
  sceneBoundaryFrames,
  frameToPercent,
  percentToFrame,
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

describe('keyframeLanes', () => {
  it('produces one lane per keyed camera/3D-camera, scene order then camera-before-layers-before-3D per scene', () => {
    // sample: scene 0 (hook) has a keyed 2D camera and NO keyed layers
    // (neither of its two layers carries transform.keys); scene 1 (stack)
    // has no camera and no keyed layers; scene 2 (space) has a keyed 3D
    // camera and no 2D layers at all.
    expect(keyframeLanes(sample)).toEqual([
      { sceneIndex: 0, kind: 'camera' },
      { sceneIndex: 2, kind: 'scene3d-camera' },
    ]);
  });

  it('adds a layer lane once that layer has >0 transform.keys, and not before', () => {
    const before = keyframeLanes(sample);
    const withKeys = withLayerKeys([{ at: 0, x: 0 }]);
    const after = keyframeLanes(withKeys);
    expect(before.some((l) => l.sceneIndex === 0 && l.kind === 'layer')).toBe(false);
    expect(after).toContainEqual({ sceneIndex: 0, kind: 'layer', layerIndex: 0 });
  });

  it('never produces a lane for a camera/3D-camera/layer with 0 keys', () => {
    const m: Manifest = { ...sample, scenes: [sample.scenes[1]] }; // "stack": no camera, no keyed layers
    expect(keyframeLanes(m)).toEqual([]);
  });

  it('never produces a lane for a scene row itself, or for scene3d children', () => {
    const lanes = keyframeLanes(sample);
    expect(lanes.every((l) => l.kind !== ('scene' as never))).toBe(true);
    expect(lanes.every((l) => l.kind !== ('scene3d-child' as never))).toBe(true);
  });

  it('is deterministic across repeated calls on the same manifest', () => {
    expect(keyframeLanes(sample)).toEqual(keyframeLanes(sample));
  });
});

describe('laneKey', () => {
  it('differs for two layer lanes in the same scene at different indices', () => {
    expect(laneKey({ sceneIndex: 0, kind: 'layer', layerIndex: 0 })).not.toBe(
      laneKey({ sceneIndex: 0, kind: 'layer', layerIndex: 1 }),
    );
  });

  it('differs for the same layerIndex in two different scenes', () => {
    expect(laneKey({ sceneIndex: 0, kind: 'layer', layerIndex: 0 })).not.toBe(
      laneKey({ sceneIndex: 1, kind: 'layer', layerIndex: 0 }),
    );
  });

  it('differs between a camera lane and a scene3d-camera lane in the same scene', () => {
    expect(laneKey({ sceneIndex: 0, kind: 'camera' })).not.toBe(laneKey({ sceneIndex: 0, kind: 'scene3d-camera' }));
  });
});

describe('laneKeyMarkers', () => {
  it("covers a 2D camera lane's own keys, in its own scene, unaffected by any other scene", () => {
    expect(laneKeyMarkers(sample, { sceneIndex: 0, kind: 'camera' })).toEqual([
      { sceneIndex: 0, keyIndex: 0, frame: 0, kind: 'camera' },
      { sceneIndex: 0, keyIndex: 1, frame: 12, kind: 'camera' },
      { sceneIndex: 0, keyIndex: 2, frame: 48, kind: 'camera' },
    ]);
  });

  it("covers a 3D camera lane's own keys, offset by ITS scene's own start frame", () => {
    expect(laneKeyMarkers(sample, { sceneIndex: 2, kind: 'scene3d-camera' })).toEqual([
      { sceneIndex: 2, keyIndex: 0, frame: 300, kind: 'scene3d-camera' },
      { sceneIndex: 2, keyIndex: 1, frame: 450, kind: 'scene3d-camera' },
    ]);
  });

  it('is empty for a camera lane on a scene with no camera at all', () => {
    expect(laneKeyMarkers(sample, { sceneIndex: 1, kind: 'camera' })).toEqual([]);
  });

  it("converts a layer lane's own transform.keys to absolute frames in its own scene", () => {
    const m = withLayerKeys([{ at: 0, x: 0 }, { at: 2, x: 300 }]);
    expect(laneKeyMarkers(m, { sceneIndex: 0, kind: 'layer', layerIndex: 0 })).toEqual([
      { sceneIndex: 0, keyIndex: 0, frame: 0, kind: 'layer' },
      { sceneIndex: 0, keyIndex: 1, frame: 60, kind: 'layer' }, // 2s * 30fps, scene 0 starts at frame 0
    ]);
  });

  it("offsets a layer lane by ITS OWN scene's start frame, not scene 0's", () => {
    const m = structuredClone(sample);
    (m.scenes[1].layers![0] as unknown as Record<string, unknown>).transform = { keys: [{ at: 1, x: 0 }] };
    // scene 1 ("stack") starts at frame 120; 1s * 30fps = 30 -> absolute 150
    expect(laneKeyMarkers(m, { sceneIndex: 1, kind: 'layer', layerIndex: 0 })).toEqual([
      { sceneIndex: 1, keyIndex: 0, frame: 150, kind: 'layer' },
    ]);
  });

  it('a layer lane only ever shows THAT layer\'s own keys, never a sibling layer\'s', () => {
    const m = structuredClone(sample);
    (m.scenes[0].layers![0] as unknown as Record<string, unknown>).transform = { keys: [{ at: 0, x: 0 }] };
    expect(laneKeyMarkers(m, { sceneIndex: 0, kind: 'layer', layerIndex: 1 })).toEqual([]);
  });

  it('is empty for a lane whose scene/layerIndex no longer resolves', () => {
    expect(laneKeyMarkers(sample, { sceneIndex: 99, kind: 'camera' })).toEqual([]);
    expect(laneKeyMarkers(sample, { sceneIndex: 0, kind: 'layer', layerIndex: 99 })).toEqual([]);
  });
});

describe('selectionForLane', () => {
  it('resolves a camera lane to a {kind: camera} selection in its own scene', () => {
    expect(selectionForLane(sample, { sceneIndex: 0, kind: 'camera' })).toEqual({
      sceneIndex: 0,
      target: { kind: 'camera' },
    });
  });

  it('resolves a scene3d-camera lane to a {kind: scene3d-camera} selection in its own scene', () => {
    expect(selectionForLane(sample, { sceneIndex: 2, kind: 'scene3d-camera' })).toEqual({
      sceneIndex: 2,
      target: { kind: 'scene3d-camera' },
    });
  });

  it('resolves a layer lane to a {kind: layer} selection carrying that layer\'s own id when it has one', () => {
    const m = structuredClone(sample);
    m.scenes[0].layers![0].id = 'headline';
    expect(selectionForLane(m, { sceneIndex: 0, kind: 'layer', layerIndex: 0 })).toEqual({
      sceneIndex: 0,
      target: { kind: 'layer', index: 0, id: 'headline' },
    });
  });

  it('resolves a layer lane to id: undefined when the layer has none, same as LayerList\'s own row click', () => {
    expect(selectionForLane(sample, { sceneIndex: 0, kind: 'layer', layerIndex: 0 })).toEqual({
      sceneIndex: 0,
      target: { kind: 'layer', index: 0, id: undefined },
    });
  });

  it('is null for a lane whose scene/layerIndex no longer resolves', () => {
    expect(selectionForLane(sample, { sceneIndex: 99, kind: 'camera' })).toBeNull();
    expect(selectionForLane(sample, { sceneIndex: 0, kind: 'layer', layerIndex: 99 })).toBeNull();
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

describe('percentToFrame (Phase 5b — the INVERSE of frameToPercent, for a drag)', () => {
  it('maps 0% to frame 0', () => {
    expect(percentToFrame(0, 450)).toBe(0);
  });

  it('maps 100% to the last frame', () => {
    expect(percentToFrame(100, 450)).toBe(450);
  });

  it('maps a midpoint percentage proportionally', () => {
    expect(percentToFrame(50, 450)).toBe(225);
  });

  it('rounds to the nearest frame, matching every other seconds/frame conversion in this package', () => {
    // 33% of 450 = 148.5 -> rounds up
    expect(percentToFrame(33, 450)).toBe(149);
    // 32.9% of 450 = 148.05 -> rounds down
    expect(percentToFrame(32.9, 450)).toBe(148);
  });

  it('clamps a percentage past 100% to the last frame, never over', () => {
    expect(percentToFrame(150, 450)).toBe(450);
  });

  it('clamps a negative percentage to frame 0, never under', () => {
    expect(percentToFrame(-10, 450)).toBe(0);
  });

  it('returns 0 rather than NaN/Infinity for a non-positive total', () => {
    expect(percentToFrame(50, 0)).toBe(0);
    expect(percentToFrame(50, -5)).toBe(0);
  });

  it('round-trips with frameToPercent at exact frame boundaries', () => {
    for (const frame of [0, 1, 100, 225, 449, 450]) {
      const percent = frameToPercent(frame, 450);
      expect(percentToFrame(percent, 450)).toBe(frame);
    }
  });
});

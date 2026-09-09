import { describe, it, expect } from 'vitest';
import { sample } from '@apelles/motion-engine/src/engine/sample';
import type { Manifest } from '@apelles/motion-engine/src/engine/schema';
import {
  layerKeyCount,
  layerActiveKeyCount,
  cameraKeyCount,
  scene3dCameraKeyCount,
  keyframeLanes,
  laneKey,
  laneKeyMarkers,
  laneKeyAtSeconds,
  selectionForLane,
  sceneBoundaryFrames,
  frameToPercent,
  percentToFrame,
  sameKeySelectionEntry,
  toggleKeySelectionEntry,
  unionKeySelectionEntries,
  keyMarkerContentRect,
  keysInMarqueeRect,
  KEY_MARKER_HIT_PX,
  type KeySelectionEntry,
  type KeyframeLane,
} from './keyframeVisibility';

// `sample`'s own real shape (`packages/motion-engine/src/engine/sample.ts`),
// worked out by hand once here rather than re-derived in every test below:
// fps 30; scene 0 "hook" dur 4s -> 120 frames, camera keys at 0/0.4/1.6s ->
// frames 0/12/48; scene 1 "stack" dur 6s -> 180 frames, no camera, layer 1
// (the "layers" primitive) has an `active` step-schedule [{at:2.5,i:2},
// {at:4,i:0}] -> absolute frames 195/240 (D-178/B-067); scene 2 "space" dur
// 5s -> 150 frames, scene3d camera keys at 0/5s -> frames 0/150 relative to
// its own start. Scene starts: 0, 120, 300. Total: 450.

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

describe('layerActiveKeyCount (D-178/B-067)', () => {
  it('is 0 for a layer with no active field at all', () => {
    expect(layerActiveKeyCount(sample.scenes[0].layers![0])).toBe(0);
  });

  it('is 0 for the plain-number form (nothing to show on a timeline)', () => {
    const m = structuredClone(sample);
    (m.scenes[0].layers![0] as unknown as Record<string, unknown>).active = 2;
    expect(layerActiveKeyCount(m.scenes[0].layers![0])).toBe(0);
  });

  it("counts sample's own real active step-schedule (stack scene, layers primitive)", () => {
    expect(layerActiveKeyCount(sample.scenes[1].layers![1])).toBe(2);
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
  it('produces one lane per keyed camera/3D-camera/active-schedule, scene order then camera-before-layers-before-3D per scene', () => {
    // sample: scene 0 (hook) has a keyed 2D camera and NO keyed layers
    // (neither of its two layers carries transform.keys); scene 1 (stack)
    // has no camera, no transform.keys, but layer 1 (the "layers"
    // primitive) has a real `active` step-schedule (D-178/B-067); scene 2
    // (space) has a keyed 3D camera and no 2D layers at all.
    expect(keyframeLanes(sample)).toEqual([
      { sceneIndex: 0, kind: 'camera' },
      { sceneIndex: 1, kind: 'active', layerIndex: 1 },
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

  it('a layer with BOTH transform.keys and an active schedule gets its own two adjacent lanes, never merged', () => {
    const withKeys = withLayerKeys([{ at: 0, x: 0 }]); // attaches to scene 0, layer 0 — no active field there
    const m = structuredClone(withKeys);
    (m.scenes[0].layers![0] as unknown as Record<string, unknown>).active = [{ at: 1, i: 0 }];
    const lanes = keyframeLanes(m);
    expect(lanes).toContainEqual({ sceneIndex: 0, kind: 'layer', layerIndex: 0 });
    expect(lanes).toContainEqual({ sceneIndex: 0, kind: 'active', layerIndex: 0 });
    // the 'layer' lane comes first, immediately followed by 'active' — this
    // exact layer's own two rows stay adjacent even though scene 0 also has
    // an unrelated camera lane and a second, un-keyed layer.
    const layerIdx = lanes.findIndex((l) => l.kind === 'layer' && l.layerIndex === 0);
    expect(lanes[layerIdx + 1]).toEqual({ sceneIndex: 0, kind: 'active', layerIndex: 0 });
  });

  it('never produces a lane for a camera/3D-camera/layer/active with 0 keys', () => {
    // scene 1 ("stack") stripped of its one real active schedule — no
    // camera, no transform.keys, and now no active schedule either.
    const scene = structuredClone(sample.scenes[1]);
    delete (scene.layers![1] as unknown as Record<string, unknown>).active;
    const m: Manifest = { ...sample, scenes: [scene] };
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

  it("converts an 'active' lane's own step-schedule to absolute frames, offset by its scene's start (D-178/B-067)", () => {
    // sample: scene 1 ("stack") starts at frame 120; active [{at:2.5},{at:4}]
    // -> 75/120 frames -> absolute 195/240.
    expect(laneKeyMarkers(sample, { sceneIndex: 1, kind: 'active', layerIndex: 1 })).toEqual([
      { sceneIndex: 1, keyIndex: 0, frame: 195, kind: 'active' },
      { sceneIndex: 1, keyIndex: 1, frame: 240, kind: 'active' },
    ]);
  });

  it("an 'active' lane never picks up a sibling layer's schedule, or that same layer's own transform.keys", () => {
    const m = withLayerKeys([{ at: 0, x: 0 }]); // scene 0, layer 0 — no active field
    expect(laneKeyMarkers(m, { sceneIndex: 0, kind: 'active', layerIndex: 0 })).toEqual([]);
    expect(laneKeyMarkers(sample, { sceneIndex: 1, kind: 'active', layerIndex: 0 })).toEqual([]); // layer 0 is the plain text layer
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

  it("resolves an 'active' lane to the SAME {kind: layer} selection a 'layer' lane on it would (D-178/B-067)", () => {
    expect(selectionForLane(sample, { sceneIndex: 1, kind: 'active', layerIndex: 1 })).toEqual({
      sceneIndex: 1,
      target: { kind: 'layer', index: 1, id: undefined },
    });
  });

  it('is null for an active lane whose layerIndex no longer resolves', () => {
    expect(selectionForLane(sample, { sceneIndex: 1, kind: 'active', layerIndex: 99 })).toBeNull();
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

describe('laneKeyAtSeconds (Phase 5b — box-select + nudge, a nudge\'s own drag-start snapshot)', () => {
  it("reads a 2D camera lane's own key at seconds, exactly (unrounded)", () => {
    expect(laneKeyAtSeconds(sample, { sceneIndex: 0, kind: 'camera' }, 1)).toBe(0.4);
  });

  it("reads a 3D camera lane's own key at seconds", () => {
    expect(laneKeyAtSeconds(sample, { sceneIndex: 2, kind: 'scene3d-camera' }, 0)).toBe(0);
  });

  it("reads a layer lane's own transform.keys entry at seconds", () => {
    const m = withLayerKeys([{ at: 0, x: 0 }, { at: 2.5, x: 300 }]);
    expect(laneKeyAtSeconds(m, { sceneIndex: 0, kind: 'layer', layerIndex: 0 }, 1)).toBe(2.5);
  });

  it('is null for a scene that no longer exists', () => {
    expect(laneKeyAtSeconds(sample, { sceneIndex: 99, kind: 'camera' }, 0)).toBeNull();
  });

  it('is null for an out-of-range keyIndex', () => {
    expect(laneKeyAtSeconds(sample, { sceneIndex: 0, kind: 'camera' }, 99)).toBeNull();
  });

  it('is null for a camera-less scene', () => {
    expect(laneKeyAtSeconds(sample, { sceneIndex: 1, kind: 'camera' }, 0)).toBeNull();
  });

  it('is null for a scene3d-camera lane on a scene with no scene3d at all', () => {
    expect(laneKeyAtSeconds(sample, { sceneIndex: 0, kind: 'scene3d-camera' }, 0)).toBeNull();
  });

  it("reads an 'active' lane's own step-schedule entry at seconds, exactly (D-178/B-067)", () => {
    expect(laneKeyAtSeconds(sample, { sceneIndex: 1, kind: 'active', layerIndex: 1 }, 0)).toBe(2.5);
    expect(laneKeyAtSeconds(sample, { sceneIndex: 1, kind: 'active', layerIndex: 1 }, 1)).toBe(4);
  });

  it('is null for an active lane with an out-of-range keyIndex or layerIndex', () => {
    expect(laneKeyAtSeconds(sample, { sceneIndex: 1, kind: 'active', layerIndex: 1 }, 99)).toBeNull();
    expect(laneKeyAtSeconds(sample, { sceneIndex: 1, kind: 'active', layerIndex: 99 }, 0)).toBeNull();
  });
});

describe('sameKeySelectionEntry / toggleKeySelectionEntry / unionKeySelectionEntries (Phase 5b — the key-selection model)', () => {
  const a: KeySelectionEntry = { lane: { sceneIndex: 0, kind: 'camera' }, keyIndex: 0 };
  const b: KeySelectionEntry = { lane: { sceneIndex: 0, kind: 'camera' }, keyIndex: 1 };
  const c: KeySelectionEntry = { lane: { sceneIndex: 0, kind: 'layer', layerIndex: 0 }, keyIndex: 0 };

  it('sameKeySelectionEntry compares by lane identity + keyIndex, not object identity', () => {
    expect(sameKeySelectionEntry(a, { lane: { sceneIndex: 0, kind: 'camera' }, keyIndex: 0 })).toBe(true);
    expect(sameKeySelectionEntry(a, b)).toBe(false);
  });

  it('sameKeySelectionEntry distinguishes two DIFFERENT layers sharing the same keyIndex', () => {
    // the exact scenario D-162's own `dragPreview` scoping had to account
    // for: two different lanes can each have their own `keyIndex === 0`.
    expect(sameKeySelectionEntry(a, c)).toBe(false);
  });

  it('toggleKeySelectionEntry adds an absent entry', () => {
    expect(toggleKeySelectionEntry([a], b)).toEqual([a, b]);
  });

  it('toggleKeySelectionEntry removes an already-present entry', () => {
    expect(toggleKeySelectionEntry([a, b], a)).toEqual([b]);
  });

  it('toggleKeySelectionEntry places no same-kind/same-scene restriction — unlike Selection[]', () => {
    // a camera key and a layer key, or keys in two different scenes, are
    // both fully valid together — see `manifestEdit.ts`'s `moveKeysByDelta`
    // doc comment for why a shared time delta is coherent across any mix.
    expect(toggleKeySelectionEntry([a], c)).toEqual([a, c]);
  });

  it('unionKeySelectionEntries merges hits onto base, skipping duplicates', () => {
    expect(unionKeySelectionEntries([a], [a, b])).toEqual([a, b]);
  });

  it('unionKeySelectionEntries with no overlap concatenates', () => {
    expect(unionKeySelectionEntries([a], [c])).toEqual([a, c]);
  });
});

describe('keyMarkerContentRect / keysInMarqueeRect (Phase 5b — box-select, pure geometry)', () => {
  const layout = { laneAreaTop: 20, laneHeight: 26, labelWidth: 148 };
  const total = 450; // sample's own total frames (see the file's own header comment)

  it("centers a marker's hit-box rect on its own row and frame position", () => {
    const rect = keyMarkerContentRect(0, 0, total, 450, layout);
    // row 0's vertical center: laneAreaTop + 0*laneHeight + laneHeight/2
    expect(rect.top + rect.height / 2).toBeCloseTo(20 + 13, 10);
    // frame 0 -> 0% of the track -> right at the label boundary
    expect(rect.left + rect.width / 2).toBeCloseTo(layout.labelWidth, 10);
    expect(rect.width).toBe(KEY_MARKER_HIT_PX);
    expect(rect.height).toBe(KEY_MARKER_HIT_PX);
  });

  it('row 1 sits exactly one laneHeight below row 0', () => {
    const row0 = keyMarkerContentRect(0, 0, total, 450, layout);
    const row1 = keyMarkerContentRect(1, 0, total, 450, layout);
    expect(row1.top - row0.top).toBeCloseTo(layout.laneHeight, 10);
  });

  it('keysInMarqueeRect finds a marker whose hit-box the rect fully contains', () => {
    const lanes = keyframeLanes(sample); // [{sceneIndex:0,kind:'camera'}, {sceneIndex:1,kind:'active'}, {sceneIndex:2,kind:'scene3d-camera'}]
    const trackW = 450; // 1px/frame, so frame 0's marker centers at x = labelWidth
    const markerCenter = keyMarkerContentRect(0, 0, total, trackW, layout);
    const rect = { left: markerCenter.left - 5, top: markerCenter.top - 5, width: 20, height: 20 };
    const hits = keysInMarqueeRect(sample, lanes, rect, total, trackW, layout);
    expect(hits).toContainEqual({ lane: { sceneIndex: 0, kind: 'camera' }, keyIndex: 0 });
  });

  it('keysInMarqueeRect never hits a marker the rect only grazes (zero overlap)', () => {
    const lanes = keyframeLanes(sample);
    const trackW = 450;
    // a rect entirely to the LEFT of every marker on row 0 (frame 0's own
    // marker sits at x = labelWidth; this rect ends well before it)
    const rect = { left: 0, top: layout.laneAreaTop, width: layout.labelWidth - 20, height: layout.laneHeight };
    const hits = keysInMarqueeRect(sample, lanes, rect, total, trackW, layout);
    expect(hits).toEqual([]);
  });

  it('keysInMarqueeRect scopes hits to the CORRECT row — a rect over row 0 never catches a LATER row\'s marker', () => {
    const lanes = keyframeLanes(sample); // row 0: scene0 camera; row 1: scene1 active; row 2: scene2 3D camera
    const trackW = 450;
    // scene 2's 3D camera key 0 is at absolute frame 300 (see laneKeyMarkers
    // tests above) — put a WIDE rect at that x position but only over row 0's
    // own vertical band.
    const x = layout.labelWidth + (300 / total) * trackW;
    const rect = { left: x - 10, top: layout.laneAreaTop, width: 20, height: layout.laneHeight };
    const hits = keysInMarqueeRect(sample, lanes, rect, total, trackW, layout);
    expect(hits).toEqual([]);
  });

  it('keysInMarqueeRect can select MULTIPLE keys across multiple rows in one rect', () => {
    const lanes = keyframeLanes(sample);
    const trackW = 450;
    // a rect spanning the FULL track width and every row's vertical extent
    // catches every key in the manifest (scene 0's 3 camera keys + scene 1's
    // 2 active-schedule keys + scene 2's 2 3D-camera keys).
    const rect = {
      left: layout.labelWidth,
      top: layout.laneAreaTop,
      width: trackW,
      height: layout.laneHeight * lanes.length,
    };
    const hits = keysInMarqueeRect(sample, lanes, rect, total, trackW, layout);
    expect(hits).toHaveLength(7);
  });

  it('is empty for zero lanes', () => {
    const rect = { left: 0, top: 0, width: 1000, height: 1000 };
    expect(keysInMarqueeRect(sample, [], rect, total, 450, layout)).toEqual([]);
  });

  it('D-181 — frameOffset re-bases an absolute marker frame before hit-testing, for a solo-scene local track', () => {
    // scene 1 "stack" starts at absolute frame 120; its own 'active' lane's
    // first key sits at absolute frame 195 (see laneKeyMarkers' own tests).
    // Solo'd to just that scene: a LOCAL track of width 180 (its own
    // duration, 1px/frame) with frameOffset=120 should place that marker at
    // LOCAL frame 75 — the exact spot a rect there would need to hit.
    const lane: KeyframeLane = { sceneIndex: 1, kind: 'active', layerIndex: 1 };
    const localTrackW = 180;
    const markerCenter = keyMarkerContentRect(0, 75, localTrackW, localTrackW, layout);
    const rect = { left: markerCenter.left - 5, top: markerCenter.top - 5, width: 20, height: 20 };
    const hits = keysInMarqueeRect(sample, [lane], rect, localTrackW, localTrackW, layout, 120);
    expect(hits).toContainEqual({ lane, keyIndex: 0 });
  });

  it('D-181 — frameOffset defaults to 0, matching every pre-D-181 call site exactly', () => {
    const lanes = keyframeLanes(sample);
    const trackW = 450;
    const rect = { left: layout.labelWidth, top: layout.laneAreaTop, width: trackW, height: layout.laneHeight * lanes.length };
    expect(keysInMarqueeRect(sample, lanes, rect, total, trackW, layout, 0)).toEqual(
      keysInMarqueeRect(sample, lanes, rect, total, trackW, layout),
    );
  });
});

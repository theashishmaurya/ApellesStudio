/**
 * @chroma/motion — Phase 5a (`docs/notes/motion-keyframe-timeline-research.md`,
 * D-160/D-161) and Phase 5b part 2 ("per-row lanes", D-162 — this pass).
 *
 * Pure read-only logic for three real UI pieces: `LayerList.tsx`'s per-row
 * key-count badges, and `KeyframeTimeline.tsx`'s row layout (which rows
 * exist, in what order — `keyframeLanes`) and marker positions
 * (`laneKeyMarkers`). Kept apart from both components (matching this
 * package's own established split — `canvasGeometry.ts`/`manifestEdit.ts`
 * are the pure halves of `MotionCanvasOverlay.tsx`/`InspectorPanel.tsx`) so
 * the "which frame does this key actually land on" and "which rows exist"
 * arithmetic is unit-tested directly rather than eyeballed off a rendered
 * timeline. Nothing here mutates a manifest or touches the DOM — every
 * function is a plain read.
 *
 * **D-162 (Phase 5b part 2, "per-row lanes") retires the flat, single-strip
 * model** (`cameraKeyMarkers`/`selectedLayerKeyMarkers`, D-160/D-161) in
 * favor of a per-ROW model: `keyframeLanes` is the "which rows exist, in
 * what order" pure function the research doc's own §4 named as the real
 * infrastructure piece ("a real row-layout problem… `LayerList`'s own row
 * order, always"), and `laneKeyMarkers`/`selectionForLane` are its
 * per-lane counterparts to the old whole-manifest/whole-selection
 * functions. See `KeyframeTimeline.tsx`'s own module doc comment for the
 * full layout decision and why the flat strip doesn't survive this pass
 * (rather than being kept alongside as a second, now-redundant read path).
 */
import type { Manifest, Layer, Scene } from '@chroma/motion-engine/src/engine/schema';
import { sceneStartFrame } from '@chroma/motion-engine/src/engine/build';
import type { Selection } from './LayerList';
import { layerTransformKeys } from './manifestEdit';

/** A layer is `.passthrough()` (`schema.ts`) — `transform` isn't statically
 *  typed on the inferred `Layer` type, so this reads through the same
 *  `Record<string, unknown>` cast every other per-primitive read in this
 *  package already uses (`layerLabel`, `manifestEdit.ts`'s own `Raw`). */
export function layerKeyCount(layer: Layer): number {
  const raw = layer as unknown as Record<string, unknown>;
  const transform = raw.transform as Record<string, unknown> | undefined;
  return Array.isArray(transform?.keys) ? transform.keys.length : 0;
}

/** `scene.camera`'s own key count — `0` for a camera-less scene, matching
 *  `LayerList.tsx`'s existing "only render the Camera row when `scene.camera`
 *  exists" convention rather than distinguishing "no camera" from "a camera
 *  with zero keys" (the schema doesn't allow the latter: `cam2dKey` arrays
 *  aren't `.min()`-constrained, but an empty array and an absent field mean
 *  the same "no camera authored" thing to every reader of this schema). */
export function cameraKeyCount(scene: Scene): number {
  return scene.camera?.length ?? 0;
}

/** `scene.scene3d.camera`'s own key count — schema-guaranteed `.min(1)` when
 *  `scene3d` exists at all (`schema.ts`), so this is `0` only when the scene
 *  has no 3D camera at all, never "a 3D camera with zero keys" (that shape
 *  can't be constructed). */
export function scene3dCameraKeyCount(scene: Scene): number {
  return scene.scene3d?.camera.length ?? 0;
}

/** One marker on a keyframe timeline lane — an absolute composition frame
 *  (`sceneStartFrame(manifest, sceneIndex) + Math.round(at * fps)`, the SAME
 *  conversion `Video.tsx`/`manifestEdit.ts` already use everywhere a key's
 *  `at` becomes a frame — never a second, independently-rounded copy of it)
 *  plus enough to label it and seek to the right scene.
 *
 *  `keyIndex` (Phase 5b part 1, "drag a key along time", D-161) is the
 *  position this key holds in its OWN source array — `scene.camera` for
 *  `kind:'camera'`, `scene.scene3d.camera` for `kind:'scene3d-camera'`, a
 *  layer's own `transform.keys` for `kind:'layer'` — the exact index
 *  `manifestEdit.ts`'s
 *  `moveCamera2dKeyAt`/`moveCamera3dKeyAt`/`moveLayerTransformKeyAt` take.
 *  `KeyframeTimeline.tsx`'s drag gesture reads it straight off the marker it
 *  hit rather than re-deriving "which key is this" from a frame number
 *  (fragile — two keys can share a frame). A marker on its own does not say
 *  WHICH lane it belongs to (`laneKeyMarkers` below is always called for one
 *  specific lane at a time, so the caller already knows) — see
 *  `KeyframeLane` for the per-row identity. */
export interface KeyMarker {
  sceneIndex: number;
  keyIndex: number;
  frame: number;
  kind: 'camera' | 'scene3d-camera' | 'layer';
}

function keySecondsToAbsoluteFrame(manifest: Manifest, sceneIndex: number, atSeconds: number): number {
  return sceneStartFrame(manifest, sceneIndex) + Math.round(atSeconds * manifest.fps);
}

/**
 * One ROW of `KeyframeTimeline.tsx`'s per-row lane layout (Phase 5b part 2,
 * D-162 — `docs/notes/motion-keyframe-timeline-research.md` §4's "a real
 * row-layout problem"). A lane is identified structurally — `sceneIndex` +
 * `kind`, plus `layerIndex` for `kind:'layer'` (which layer, within that
 * scene's own `layers[]`) — never by array position within `keyframeLanes`'
 * own returned array, since that position shifts whenever a key is added to
 * or removed from an earlier lane's layer (a `kind:'layer'` lane appears or
 * disappears entirely once its own key count crosses 0, per this function's
 * own doc comment below).
 */
export interface KeyframeLane {
  sceneIndex: number;
  kind: 'camera' | 'scene3d-camera' | 'layer';
  /** Only set for `kind: 'layer'` — the index into `scene.layers[]`. */
  layerIndex?: number;
}

/** A stable string key for one `KeyframeLane` — for React list keys and for
 *  matching a lane against another (e.g. `KeyframeTimeline.tsx`'s in-flight
 *  drag-preview override, scoped to exactly one lane's own marker). Not
 *  exported as "the" identity comparison (a plain object-shape compare would
 *  do just as well) — kept as one function so every caller builds the same
 *  string rather than each hand-rolling its own template. */
export function laneKey(lane: KeyframeLane): string {
  return `${lane.sceneIndex}:${lane.kind}:${lane.layerIndex ?? ''}`;
}

/**
 * Which rows a keyframe timeline shows, and in what order — the pure
 * function the research doc's own §4 named as the real infrastructure this
 * phase needed ("a real timeline needs N tracks… row order = `LayerList`'s
 * own order, always"). One lane per (scene, 2D camera) when that scene's
 * camera has `>0` keys, one per (scene, layer) when THAT layer has `>0`
 * `transform.keys`, one per (scene, 3D camera) when it has `>0` keys — never
 * one for an un-keyed layer/camera (nothing to show on a timeline; matches
 * `LayerList.tsx`'s own "badge only when count > 0" precedent, D-160) and
 * never one for a scene row itself (a scene can never carry keys of its
 * own). Order is scene order (manifest order, matching `LayerList`'s own
 * per-scene grouping), and within a scene: camera, then layers in
 * `scene.layers[]` order, then the 3D camera — the exact row order
 * `LayerList.tsx` itself renders in (scene → 2D camera row → layer rows →
 * 3D camera row → 3D children, the last of which never gets a lane, D-159's
 * own "3D on-canvas manipulation out of scope" carried forward here).
 * Deterministic — two calls against the same manifest always return the
 * same array (tests rely on this, same convention as the old
 * `cameraKeyMarkers`).
 */
export function keyframeLanes(manifest: Manifest): KeyframeLane[] {
  const lanes: KeyframeLane[] = [];
  manifest.scenes.forEach((scene, sceneIndex) => {
    if (cameraKeyCount(scene) > 0) lanes.push({ sceneIndex, kind: 'camera' });
    scene.layers?.forEach((layer, layerIndex) => {
      if (layerKeyCount(layer) > 0) lanes.push({ sceneIndex, kind: 'layer', layerIndex });
    });
    if (scene3dCameraKeyCount(scene) > 0) lanes.push({ sceneIndex, kind: 'scene3d-camera' });
  });
  return lanes;
}

/**
 * One lane's own markers, converted to absolute frames — the per-row
 * replacement for D-160's whole-manifest `cameraKeyMarkers` (which merged
 * every scene's camera keys into one row) and D-160/161's
 * selection-scoped `selectedLayerKeyMarkers` (which showed only the
 * CURRENTLY SELECTED layer's keys). Neither restriction applies to a lane:
 * a lane already names exactly one scene's one camera/layer, so this always
 * returns that lane's own keys regardless of what's selected in the rest of
 * the tab — a real capability improvement over the flat strip, not just a
 * reshuffling of the same data: any keyed layer's keys can now be seen (and
 * dragged, `KeyframeTimeline.tsx`) without first selecting that layer via
 * `LayerList`. `[]` for a lane that no longer resolves (an out-of-range
 * `sceneIndex`/`layerIndex` — the same defensive floor every read function
 * in this package holds for a manifest that changed under a stale lane).
 */
export function laneKeyMarkers(manifest: Manifest, lane: KeyframeLane): KeyMarker[] {
  const scene = manifest.scenes[lane.sceneIndex];
  if (!scene) return [];
  const toMarkers = (keys: { at: number }[], kind: KeyMarker['kind']): KeyMarker[] =>
    keys.map((key, keyIndex) => ({
      sceneIndex: lane.sceneIndex,
      keyIndex,
      frame: keySecondsToAbsoluteFrame(manifest, lane.sceneIndex, key.at),
      kind,
    }));
  if (lane.kind === 'camera') return toMarkers(scene.camera ?? [], 'camera');
  if (lane.kind === 'scene3d-camera') return toMarkers(scene.scene3d?.camera ?? [], 'scene3d-camera');
  if (lane.kind === 'layer' && lane.layerIndex !== undefined) {
    const selection: Selection = { sceneIndex: lane.sceneIndex, target: { kind: 'layer', index: lane.layerIndex } };
    return toMarkers(layerTransformKeys(manifest, selection), 'layer');
  }
  return [];
}

/**
 * The `Selection` a click on a lane's own row/label should produce —
 * `MotionTab.tsx`'s existing `onSelect` (the SAME callback `LayerList.tsx`'s
 * row clicks already use, per this phase's own task: "reuse `onSelect` —
 * don't invent a parallel selection mechanism") takes it from here. Mirrors
 * `LayerList.tsx`'s own row-selection shape exactly, including capturing the
 * layer's own `id` when it has one (D-158's "stable layer identity") rather
 * than a bare index — the same snapshot `LayerList.tsx`'s row click already
 * takes. `null` for a lane that no longer resolves (manifest changed under a
 * stale lane, the same defensive floor as `laneKeyMarkers` above).
 */
export function selectionForLane(manifest: Manifest, lane: KeyframeLane): Selection | null {
  const scene = manifest.scenes[lane.sceneIndex];
  if (!scene) return null;
  if (lane.kind === 'camera') return { sceneIndex: lane.sceneIndex, target: { kind: 'camera' } };
  if (lane.kind === 'scene3d-camera') return { sceneIndex: lane.sceneIndex, target: { kind: 'scene3d-camera' } };
  if (lane.kind === 'layer' && lane.layerIndex !== undefined) {
    const layer = scene.layers?.[lane.layerIndex];
    if (!layer) return null;
    return { sceneIndex: lane.sceneIndex, target: { kind: 'layer', index: lane.layerIndex, id: layer.id } };
  }
  return null;
}

/** Absolute frames where one scene ends and the next begins — every scene
 *  start EXCEPT the first (frame 0 is the composition's own start, not a
 *  boundary worth drawing a tick for). Mirrors exactly the same back-to-back
 *  layout `<Series>` (`Video.tsx`) and `sceneStartFrame` itself already
 *  define — a second, independent computation of scene boundaries here
 *  would risk drifting from it. */
export function sceneBoundaryFrames(manifest: Manifest): number[] {
  const boundaries: number[] = [];
  for (let i = 1; i < manifest.scenes.length; i++) {
    boundaries.push(sceneStartFrame(manifest, i));
  }
  return boundaries;
}

/** `frame` as a percentage (0-100) of `totalFrames` — the strip's own
 *  pixel-free positioning math (a CSS `left: N%`, so no ResizeObserver or
 *  measured container width is needed at all). Kept as a real, tested
 *  function rather than an inline one-liner in the component: turning a
 *  frame number into a screen position is exactly the class of arithmetic
 *  this package's own `canvasGeometry.ts` doc comment warns "getting this
 *  wrong is silent" about, even when the formula looks trivial. Clamped to
 *  `[0, 100]` so a stale marker frame (e.g. a selection that briefly points
 *  past the end of a manifest mid-edit) never renders off the strip's own
 *  bounds. `totalFrames <= 0` (impossible today — `scenes.min(1)` plus
 *  `totalFrames`'s own `Math.max(1, …)` per scene guarantee at least 1 — but
 *  defended anyway, the same "don't divide by a value the schema merely
 *  makes unlikely" discipline `canvasGeometry.ts` already follows) returns
 *  `0` rather than `NaN`/`Infinity`. */
export function frameToPercent(frame: number, totalFrames: number): number {
  if (!(totalFrames > 0)) return 0;
  return Math.min(100, Math.max(0, (frame / totalFrames) * 100));
}

/**
 * The INVERSE of `frameToPercent` above — Phase 5b's own need (`docs/notes/
 * motion-keyframe-timeline-research.md` §4): a drag reports the pointer's
 * position on the strip as a `[0, 100]` percentage of the strip's own
 * measured width (`(clientX - rect.left) / rect.width * 100`, computed by
 * the component — this function stays pixel-free, same as `frameToPercent`,
 * so it needs no DOM access of its own), and needs the ABSOLUTE composition
 * frame that position corresponds to, to know which scene it lands in and
 * what to feed `sceneStartFrame` to derive a scene-relative `at` from.
 *
 * Kept as a real, tested function rather than inline arithmetic in
 * `KeyframeTimeline.tsx`, for the identical reason `frameToPercent` itself
 * already is: this is exactly the class of "turns a screen position into a
 * frame number" arithmetic this package's `canvasGeometry.ts` doc comment
 * warns "getting this wrong is silent" about — a drag that's off by even
 * one frame due to a rounding mismatch between this function and
 * `frameToPercent` would silently write a key to the wrong `at`.
 *
 * Clamped to `[0, totalFrames]` (never negative, never past the
 * composition's own end) so an out-of-bounds pointer position (dragging off
 * either edge of the strip) still resolves to a valid frame rather than one
 * `moveKeyAt`'s own scene-duration clamp would have to additionally guard
 * against. `Math.round`, matching every other seconds/frame conversion in
 * this package (`Video.tsx`, `manifestEdit.ts`'s own `Math.round(at * fps)`
 * calls) — never `Math.floor`/`Math.ceil`, which would bias a drag toward
 * one end of its own frame. `totalFrames <= 0` (impossible today, same
 * schema guarantee `frameToPercent` already defends against) returns `0`
 * rather than `NaN`.
 */
export function percentToFrame(percent: number, totalFrames: number): number {
  if (!(totalFrames > 0)) return 0;
  const frame = Math.round((percent / 100) * totalFrames);
  return Math.min(totalFrames, Math.max(0, frame));
}

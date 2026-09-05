/**
 * @chroma/motion — Phase 5a of `docs/notes/motion-keyframe-timeline-research.md`
 * ("key visibility": the visual-builder research doc's own "deliberately
 * cheaper intermediate" for a keyframe timeline, taken seriously rather than
 * treated as a lesser fallback — see that doc's §4 "Phase 5a" for the full
 * scoping reasoning, and D-160's decision entry for what shipped).
 *
 * Pure read-only logic for two small, real UI pieces: `LayerList.tsx`'s
 * per-row key-count badges, and `KeyframeStrip.tsx`'s marker positions.
 * Kept apart from both components (matching this package's own established
 * split — `canvasGeometry.ts`/`manifestEdit.ts` are the pure halves of
 * `MotionCanvasOverlay.tsx`/`InspectorPanel.tsx`) so the "which frame does
 * this key actually land on" arithmetic is unit-tested directly rather than
 * eyeballed off a rendered strip. Nothing here mutates a manifest or touches
 * the DOM — every function is a plain read.
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

/** One marker on the keyframe strip — an absolute composition frame
 *  (`sceneStartFrame(manifest, sceneIndex) + Math.round(at * fps)`, the SAME
 *  conversion `Video.tsx`/`manifestEdit.ts` already use everywhere a key's
 *  `at` becomes a frame — never a second, independently-rounded copy of it)
 *  plus enough to label it and seek to the right scene. */
export interface KeyMarker {
  sceneIndex: number;
  frame: number;
  kind: 'camera' | 'scene3d-camera' | 'layer';
}

function keySecondsToAbsoluteFrame(manifest: Manifest, sceneIndex: number, atSeconds: number): number {
  return sceneStartFrame(manifest, sceneIndex) + Math.round(atSeconds * manifest.fps);
}

/** Every 2D and 3D camera key across the WHOLE manifest, not just the scene
 *  under the playhead — a real capability the strip has that a canvas drag
 *  gesture never could (§1 of the research doc's own note: reading a key's
 *  `at` needs no live DOM, unlike measuring where a layer is actually
 *  drawn), so there is no reason to restrict it to the current scene. Order
 *  is scene order, then camera keys before 3D-camera keys, then key order —
 *  deterministic, so two calls against the same manifest always produce the
 *  same array (tests rely on this rather than re-sorting). */
export function cameraKeyMarkers(manifest: Manifest): KeyMarker[] {
  const markers: KeyMarker[] = [];
  manifest.scenes.forEach((scene, sceneIndex) => {
    for (const key of scene.camera ?? []) {
      markers.push({ sceneIndex, frame: keySecondsToAbsoluteFrame(manifest, sceneIndex, key.at), kind: 'camera' });
    }
    for (const key of scene.scene3d?.camera ?? []) {
      markers.push({
        sceneIndex,
        frame: keySecondsToAbsoluteFrame(manifest, sceneIndex, key.at),
        kind: 'scene3d-camera',
      });
    }
  });
  return markers;
}

/**
 * The current selection's own `transform.keys`, converted to absolute
 * frames — `[]` whenever the selection isn't exactly one `{kind:'layer'}`
 * entry. Matches `InspectorPanel.tsx`'s own `TransformKeysSection` scoping
 * call (D-159 §5's doc comment): a per-layer keyframe list has no coherent
 * lockstep meaning across a multi-selection (different row counts, different
 * `at` values, different field coverage) — the identical reasoning applies
 * to a keyframe-strip's markers, so 0 or 2+ selections, or a non-layer
 * selection (a scene/camera/3D-child row), show no layer markers at all
 * rather than guessing at a combined view. Only 2D `{kind:'layer'}` targets
 * can carry `transform.keys` at all (`scene3d.children` render through a
 * completely different path that never reads it, per D-157) — a
 * `scene3d-child` selection is excluded for the same structural reason
 * `InspectorPanel.tsx`'s own `isLayer2d` check excludes it there.
 */
export function selectedLayerKeyMarkers(manifest: Manifest, selections: Selection[]): KeyMarker[] {
  if (selections.length !== 1) return [];
  const selection = selections[0];
  if (selection.target.kind !== 'layer') return [];
  return layerTransformKeys(manifest, selection).map((key) => ({
    sceneIndex: selection.sceneIndex,
    frame: keySecondsToAbsoluteFrame(manifest, selection.sceneIndex, key.at),
    kind: 'layer' as const,
  }));
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

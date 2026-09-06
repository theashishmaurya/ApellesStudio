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
import { layerTransformKeys, layerActiveSchedule } from './manifestEdit';
import { rectsIntersect, type RectLike } from './canvasGeometry';

/** A layer is `.passthrough()` (`schema.ts`) — `transform` isn't statically
 *  typed on the inferred `Layer` type, so this reads through the same
 *  `Record<string, unknown>` cast every other per-primitive read in this
 *  package already uses (`layerLabel`, `manifestEdit.ts`'s own `Raw`). */
export function layerKeyCount(layer: Layer): number {
  const raw = layer as unknown as Record<string, unknown>;
  const transform = raw.transform as Record<string, unknown> | undefined;
  return Array.isArray(transform?.keys) ? transform.keys.length : 0;
}

/** D-178/B-067 — a layer's own `active` STEP-SCHEDULE key count (the
 *  `[{at,i}]` array form only; a plain-number `active` has nothing to show
 *  on a timeline, matching `layerActiveSchedule`'s own floor). Distinct from
 *  `layerKeyCount` above (that one counts `transform.keys` — an unrelated
 *  animation system a layer can ALSO have at the same time, hence the two
 *  separate lane kinds rather than merging their counts). */
export function layerActiveKeyCount(layer: Layer): number {
  const raw = layer as unknown as Record<string, unknown>;
  return Array.isArray(raw.active) ? raw.active.length : 0;
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
  kind: 'camera' | 'scene3d-camera' | 'layer' | 'active';
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
  kind: 'camera' | 'scene3d-camera' | 'layer' | 'active';
  /** Only set for `kind: 'layer'`/`'active'` — the index into `scene.layers[]`. */
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
 *
 * **D-178/B-067 adds a SECOND lane kind per layer, `'active'`** — a
 * `layers`/`layerstack` primitive's own `active: [{at,i}]` step-schedule,
 * completely unrelated to `transform.keys` (a layer can have either, both,
 * or neither) and previously invisible to this timeline entirely: neither
 * `keyframeLanes` nor the Inspector had any way to show or retime it (only
 * a raw JSON textarea could touch it at all). Pushed right after that same
 * layer's `'layer'` lane (if it has one) so both of one layer's own
 * keyframe rows stay adjacent — never merged into one row, since they are
 * two independent key ARRAYS with independent `keyIndex` spaces.
 */
export function keyframeLanes(manifest: Manifest): KeyframeLane[] {
  const lanes: KeyframeLane[] = [];
  manifest.scenes.forEach((scene, sceneIndex) => {
    if (cameraKeyCount(scene) > 0) lanes.push({ sceneIndex, kind: 'camera' });
    scene.layers?.forEach((layer, layerIndex) => {
      if (layerKeyCount(layer) > 0) lanes.push({ sceneIndex, kind: 'layer', layerIndex });
      if (layerActiveKeyCount(layer) > 0) lanes.push({ sceneIndex, kind: 'active', layerIndex });
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
  if (lane.kind === 'active' && lane.layerIndex !== undefined) {
    const selection: Selection = { sceneIndex: lane.sceneIndex, target: { kind: 'layer', index: lane.layerIndex } };
    return toMarkers(layerActiveSchedule(manifest, selection), 'active');
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
  // 'active' selects the SAME underlying layer a 'layer' (transform.keys)
  // lane on it would — both are just different keyframe arrays belonging to
  // one layer, not two different selectable things (D-178/B-067).
  if ((lane.kind === 'layer' || lane.kind === 'active') && lane.layerIndex !== undefined) {
    const layer = scene.layers?.[lane.layerIndex];
    if (!layer) return null;
    return { sceneIndex: lane.sceneIndex, target: { kind: 'layer', index: lane.layerIndex, id: layer.id } };
  }
  return null;
}

/**
 * Phase 5b, "box-select + nudge multiple keys" — the EXACT, unrounded `at`
 * (seconds) a lane's own key at `keyIndex` currently holds. Distinct from
 * `KeyMarker.frame` (already rounded to a whole frame via
 * `keySecondsToAbsoluteFrame`, for DISPLAY): a nudge gesture needs to
 * capture each selected key's true starting value once at drag-start
 * (`KeyframeTimeline.tsx`'s own drag state, `manifestEdit.ts`'s
 * `KeyMoveTarget.baseAtSeconds`) so a shared delta is added to the REAL
 * value, not a frame-rounded approximation of it — the same "getting this
 * wrong is silent" concern `frameToPercent`/`percentToFrame` already carry,
 * here for the opposite direction (reading a value out, not converting a
 * position). `null` for a lane/keyIndex combination that doesn't resolve
 * (out-of-range scene/layer/keyIndex) — the same defensive floor every
 * other read function in this file already holds.
 */
export function laneKeyAtSeconds(manifest: Manifest, lane: KeyframeLane, keyIndex: number): number | null {
  const scene = manifest.scenes[lane.sceneIndex];
  if (!scene) return null;
  if (lane.kind === 'camera') return scene.camera?.[keyIndex]?.at ?? null;
  if (lane.kind === 'scene3d-camera') return scene.scene3d?.camera[keyIndex]?.at ?? null;
  if (lane.kind === 'layer' && lane.layerIndex !== undefined) {
    const selection: Selection = { sceneIndex: lane.sceneIndex, target: { kind: 'layer', index: lane.layerIndex } };
    return layerTransformKeys(manifest, selection)[keyIndex]?.at ?? null;
  }
  if (lane.kind === 'active' && lane.layerIndex !== undefined) {
    const selection: Selection = { sceneIndex: lane.sceneIndex, target: { kind: 'layer', index: lane.layerIndex } };
    return layerActiveSchedule(manifest, selection)[keyIndex]?.at ?? null;
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

/**
 * Phase 5b, "box-select + nudge multiple keys" (`docs/notes/
 * motion-keyframe-timeline-research.md` §4) — the SELECTION MODEL for
 * individual keys, kept deliberately distinct from `LayerList.tsx`'s
 * `Selection[]` (which points at whole LAYERS/cameras/scenes, never at one
 * key within one — the research doc's own §4 names this explicitly: "a
 * `{trackId, keyIndex}[]`-shaped selection distinct from `Selection[]`").
 * `trackId` becomes `lane: KeyframeLane` here — `KeyframeLane` (D-162) is
 * ALREADY this package's own lane-identity type (`sceneIndex` + `kind` +
 * `layerIndex`), so this reuses it rather than inventing a second lane-id
 * scheme the research doc explicitly warned against duplicating.
 *
 * **Where this state lives: local to `KeyframeTimeline.tsx`, not lifted to
 * `MotionTab.tsx`.** Decided by the same test `Selection[]` itself passes
 * for living in `MotionTab.tsx`: something OUTSIDE that component needs to
 * read it (`LayerList.tsx`'s row highlighting, `InspectorPanel.tsx`'s
 * field editors, `MotionCanvasOverlay.tsx`'s outline/drag). A key selection
 * has no such second consumer today — no Inspector view edits N keys'
 * VALUE fields in lockstep the way `Selection[]`'s multi-layer view does
 * (`manifestEdit.ts`'s `setFieldOnSelections`), so there is nothing to
 * coordinate with outside this one component. If a future feature (a
 * multi-key value editor, say) ever needs to read it from outside, that is
 * the point to lift it — not before, per this package's own "don't add
 * plumbing for a consumer that doesn't exist yet" practice.
 *
 * **Persistence across a manifest change: NOT cleared automatically.**
 * Considered clearing `keySelection` on every `manifest` reference change
 * (the STABLE prop, which changes on every commit including this
 * component's own nudge commits) — rejected as needlessly disruptive for
 * the common case. A nudge that doesn't cross a non-selected neighbor
 * leaves every selected key's `keyIndex` unchanged after the commit (a
 * uniform shift preserves relative array order among untouched entries),
 * so clearing on every commit would throw away a perfectly valid selection
 * far more often than it protects against a stale one. The rejected
 * alternative's failure mode (see `KeyframeTimeline.tsx`'s own module doc
 * comment for the full disclosure) is instead handled the way this
 * package already handles every other "the manifest changed under a live
 * reference" case: value-equality lookups (`sameKeySelectionEntry`) never
 * dereference a stale entry, so a `{lane, keyIndex}` that no longer names a
 * real key just silently stops highlighting/dragging anything — the same
 * "selectable but not draggable, never a crash" floor `layerWorldPosition`
 * already established for `Selection[]`.
 */
export interface KeySelectionEntry {
  lane: KeyframeLane;
  keyIndex: number;
}

/** Value equality for two `KeySelectionEntry` — used for membership tests
 *  (toggle, "is this marker part of the drag group") rather than object
 *  identity, since a `KeyframeLane`/`KeySelectionEntry` is freshly
 *  constructed on every render. */
export function sameKeySelectionEntry(a: KeySelectionEntry, b: KeySelectionEntry): boolean {
  return laneKey(a.lane) === laneKey(b.lane) && a.keyIndex === b.keyIndex;
}

/**
 * Shift-click membership toggle for key selection — the direct analog of
 * `LayerList.tsx`'s `toggleSelection`, mirroring D-158's own exact
 * modifier convention (read once at `pointerdown`, additive not
 * toggle-during-drag — `KeyframeTimeline.tsx`'s own pointer wiring reads
 * this at the moment a marker is clicked, never mid-drag). Unlike
 * `toggleSelection`, there is no same-kind/same-scene restriction here —
 * see `manifestEdit.ts`'s `moveKeysByDelta` doc comment for why a shared
 * time delta is coherent across ANY mix of lanes/scenes, so nothing about
 * this toggle needs to reject a cross-lane addition the way `toggleSelection`
 * rejects a cross-scene layer.
 */
export function toggleKeySelectionEntry(current: KeySelectionEntry[], entry: KeySelectionEntry): KeySelectionEntry[] {
  const idx = current.findIndex((e) => sameKeySelectionEntry(e, entry));
  if (idx !== -1) return current.filter((_, i) => i !== idx);
  return [...current, entry];
}

/** Union `hits` onto `base`, skipping anything already present — the
 *  additive-marquee merge `KeyframeTimeline.tsx` uses when a marquee drag
 *  started with shift/cmd/ctrl held (D-158's own "additive marquee unions,
 *  it does not toggle" rule, reused verbatim rather than reinventing a
 *  second merge convention). */
export function unionKeySelectionEntries(base: KeySelectionEntry[], hits: KeySelectionEntry[]): KeySelectionEntry[] {
  const merged = [...base];
  for (const h of hits) if (!merged.some((e) => sameKeySelectionEntry(e, h))) merged.push(h);
  return merged;
}

/** How wide/tall (px) a key marker's own hit box is for marquee-intersection
 *  purposes — matches the ~8px diamond `KeyframeTimeline.tsx` actually draws
 *  plus a little slop, the same "give a small target a real hit box, not
 *  just its drawn pixel footprint" reasoning `MotionCanvasOverlay.tsx`'s own
 *  `HANDLE_HIT_SLOP` already applies to a resize handle. */
export const KEY_MARKER_HIT_PX = 10;

/** Where a marquee (box-select) system needs to place layout constants for
 *  `keyMarkerContentRect`/`keysInMarqueeRect` below — the vertical offset
 *  before the first lane row starts (`KeyframeTimeline.tsx`'s own ruler
 *  height), each lane row's own height, and the label column's own width
 *  (rows start AFTER it, in the track area). Passed explicitly rather than
 *  imported as constants from `KeyframeTimeline.tsx` — that file is the
 *  DOM-touching half of this pair (this file stays framework/DOM-agnostic,
 *  same split as `canvasGeometry.ts`/`MotionCanvasOverlay.tsx`), so its own
 *  layout numbers are its own to own; this file just needs to be told them. */
export interface TimelineLayout {
  laneAreaTop: number;
  laneHeight: number;
  labelWidth: number;
}

/**
 * A key marker's own hit-testing rect, in the SAME "content-local" pixel
 * coordinate space `KeyframeTimeline.tsx`'s marquee band is drawn in (the
 * scrollable content div's own coordinate system — `left: 0` is the content
 * div's own left edge, unaffected by scroll position, since a marquee's
 * start/current points are captured the same way via `getBoundingClientRect`
 * on that SAME div, per that file's own module doc comment). `rowIndex` is
 * the marker's row's own position in `keyframeLanes`' returned array — the
 * exact order `KeyframeTimeline.tsx` renders rows in, so row `i` really is
 * at vertical slot `i` with no separate lookup needed. A marker's own
 * center is the SAME `frameToPercent`-derived pixel position the component
 * already draws the diamond at (`left: N% of trackWidthPx`, offset past the
 * label column) — this function does not re-derive a second, potentially
 * divergent formula for where a marker actually sits.
 */
export function keyMarkerContentRect(
  rowIndex: number,
  frame: number,
  totalFrames: number,
  trackWidthPx: number,
  layout: TimelineLayout,
): RectLike {
  const centerX = layout.labelWidth + (frameToPercent(frame, totalFrames) / 100) * trackWidthPx;
  const centerY = layout.laneAreaTop + rowIndex * layout.laneHeight + layout.laneHeight / 2;
  const half = KEY_MARKER_HIT_PX / 2;
  return { left: centerX - half, top: centerY - half, width: KEY_MARKER_HIT_PX, height: KEY_MARKER_HIT_PX };
}

/**
 * Every key whose marker falls inside `marqueeRect` (content-local px,
 * same space as `keyMarkerContentRect` above) — `KeyframeTimeline.tsx`'s
 * own marquee-release computation. Reuses `canvasGeometry.ts`'s
 * `rectsIntersect` DIRECTLY (D-158's own marquee-hit predicate, the
 * research doc's own §4 pointed at as "already proven portable once") —
 * confirmed to translate as-is: both call sites test "does an axis-aligned
 * screen/content rect overlap another axis-aligned rect," the coordinate
 * SPACE differs (client px there, content-local px here) but the predicate
 * itself doesn't care which space it's given, exactly as `canvasGeometry.
 * ts`'s own module doc comment already states ("neither one cares" which
 * space it's handed).
 *
 * **Deliberately NO DOM measurement inside this function** — a real,
 * considered choice over the alternative (query every rendered marker's
 * own `getBoundingClientRect()`, the way `MotionCanvasOverlay.tsx`'s own
 * marquee does for canvas layers). `KeyframeTimeline.tsx`'s per-row layout
 * is ALREADY fully known from pure numbers (`keyframeLanes`' own row
 * order, `laneKeyMarkers`' own frame, `trackWidthPx`'s own pixel width) —
 * D-162's "no virtualization needed" design means every lane/marker
 * genuinely exists in the DOM whenever it exists in the manifest, so there
 * is no "is this row actually rendered right now" question the way a
 * scrolled-off-screen virtualized row would raise. Computing the hit test
 * from the manifest directly (this function) rather than the DOM keeps it
 * pure and unit-testable — this package's own "getting this wrong is
 * silent" standard applied to a NEW class of arithmetic (screen rect →
 * which keys), matching `frameToPercent`/`percentToFrame`'s own precedent
 * rather than leaving it as untested DOM-measurement plumbing the way
 * `MotionCanvasOverlay.tsx`'s marquee necessarily is (that one genuinely
 * needs the DOM: a layer's on-screen box depends on the live camera
 * transform, which nothing in this package re-derives independently of the
 * DOM — see `canvasGeometry.ts`'s own module doc comment. A keyframe
 * marker's position has no such dependency; it's pure arithmetic over the
 * manifest and the current zoom).
 */
/**
 * D-181 (Phase 2 of 3, solo-scene preview) adds `frameOffset` — `laneKeyMarkers`
 * always returns ABSOLUTE composition frames, but `KeyframeTimeline.tsx`'s own
 * `trackWidthPx`/`totalFrames` (this function's own `totalFrames` param) go
 * LOCAL (scene-relative) while a scene is soloed, so a marker's absolute frame
 * needs the same re-basing before it means anything against a local track
 * width. Defaults to `0` — every pre-D-181 call site (including this file's
 * own tests) is unaffected, since subtracting 0 changes nothing.
 */
export function keysInMarqueeRect(
  manifest: Manifest,
  lanes: KeyframeLane[],
  marqueeRect: RectLike,
  totalFrames: number,
  trackWidthPx: number,
  layout: TimelineLayout,
  frameOffset = 0,
): KeySelectionEntry[] {
  const hits: KeySelectionEntry[] = [];
  lanes.forEach((lane, rowIndex) => {
    for (const marker of laneKeyMarkers(manifest, lane)) {
      const markerRect = keyMarkerContentRect(rowIndex, marker.frame - frameOffset, totalFrames, trackWidthPx, layout);
      if (rectsIntersect(marqueeRect, markerRect)) hits.push({ lane, keyIndex: marker.keyIndex });
    }
  });
  return hits;
}

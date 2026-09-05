/**
 * @chroma/motion — pure manifest read/write logic for the Inspector (D-099,
 * Phase 2 of `docs/notes/global-inspector.md`).
 *
 * D-151 adds `addLayer`, the first op here that *creates* rather than
 * reads-or-sets — the insert path behind the Catalog panel
 * (`CatalogPanel.tsx`), scoped off `docs/notes/motion-tab-audit.md`'s
 * finding that this package could edit everything and create nothing.
 *
 * Kept separate from `InspectorPanel.tsx` so the actual editing logic is
 * testable without rendering React. Every `set*` function returns a NEW
 * `Manifest` (immutable, `structuredClone`-based) — the caller
 * (`InspectorPanel`) serializes it back to JSON text and hands it to
 * `useMotionManifest`'s `setText`, the same single source of truth
 * `ManifestEditor.tsx`'s raw-JSON textarea already writes through. This file
 * never touches component state directly.
 *
 * A layer is `.passthrough()` in the zod schema (D-046) — per-primitive
 * fields aren't statically typed on `Layer`, so every read/write here goes
 * through `Record<string, unknown>`, the same cast `LayerList.tsx`'s
 * `layerLabel` already uses.
 */
import type { Manifest, Scene, Layer, Cam2dKey, Cam3dKey, TransformKey } from '@chroma/motion-engine/src/engine/schema';
import { interpolateKeys } from '@chroma/motion-engine/src/lib/interpolateKeys';
import { design } from '@chroma/motion-engine/src/design';
import type { Selection } from './LayerList';
import { catalogEntry, defaultLayerFor, DEFAULT_SCENE3D_CAMERA, type PrimitiveUse } from './catalog';
import { positionFields, sizeFields } from './propCatalog';
import { screenToWorld, worldDelta, type RectLike, type WorldMap } from './canvasGeometry';

type Raw = Record<string, unknown>;

function clone<T>(v: T): T {
  return structuredClone(v);
}

/** the scene a selection points into, or `null` for an out-of-range index —
 *  defensive, since a manifest can be edited concurrently via the raw-JSON
 *  textarea and shrink out from under a stale selection. */
export function selectedScene(manifest: Manifest, sceneIndex: number): Scene | null {
  return manifest.scenes[sceneIndex] ?? null;
}

/** the raw layer object (+ its `use`) a `{kind:'layer'}` or
 *  `{kind:'scene3d-child'}` selection points at, or `null` if the
 *  selection no longer resolves (index out of range, scene has no
 *  `layers`/`scene3d`, etc.) — every caller must handle `null` by not
 *  rendering fields, never by throwing. */
export function selectedLayer(manifest: Manifest, selection: Selection): { use: string; raw: Raw } | null {
  const scene = selectedScene(manifest, selection.sceneIndex);
  if (!scene) return null;
  const { target } = selection;
  if (target.kind === 'layer') {
    const layer = scene.layers?.[target.index];
    if (!layer) return null;
    return { use: layer.use, raw: layer as unknown as Raw };
  }
  if (target.kind === 'scene3d-child') {
    const child = scene.scene3d?.children[target.index];
    if (!child) return null;
    return { use: child.use, raw: child as unknown as Raw };
  }
  return null;
}

export function selectedCamera2d(manifest: Manifest, sceneIndex: number): Cam2dKey[] | null {
  return selectedScene(manifest, sceneIndex)?.camera ?? null;
}

export function selectedCamera3d(manifest: Manifest, sceneIndex: number): Cam3dKey[] | null {
  return selectedScene(manifest, sceneIndex)?.scene3d?.camera ?? null;
}

/**
 * D-158 (Phase 3, "stable layer identity" — the research doc's §1g finding,
 * carried over from D-155's own honest gap: "identity is positional... it
 * breaks the moment the builder can reorder, insert, or delete layers with
 * a selection live"). Re-resolves ONE `Selection` against `manifest`,
 * preferring `target.id` (`schema.ts`'s new optional `layer.id`) over the
 * `index` it was captured with, whenever an `id` is present:
 *
 * - No `id` on the target (a hand-written manifest's layer, or a
 *   scene/camera/scene3d-camera target, which have no identity concept
 *   beyond `sceneIndex` at all): falls back to exactly what this file did
 *   before `id` existed — trust `index`, confirm the thing it points at
 *   still exists, `null` if it doesn't (the manifest shrank under a stale
 *   selection — the raw-JSON textarea can do this at any time).
 * - An `id` present: search the SAME scene's layer list for a match. Found
 *   at a DIFFERENT index than recorded → return a corrected `Selection`
 *   pointing at the new index (this is the actual payoff: the selection
 *   survives a reorder/insert/delete elsewhere in the array). Not found at
 *   all → `null` (the layer was deleted, or the id belonged to a manifest
 *   this one no longer is).
 *
 * Deliberately scoped to the SAME `sceneIndex` the selection already
 * carried, not a search across every scene: nothing in this package moves
 * a layer between scenes (no such op exists), so widening the search would
 * only risk a false-positive match against an unrelated layer that happens
 * to share an id (ids are short and random, `manifestEdit.ts`'s own
 * `genLayerId`, not universally unique) — same-scene-only is both simpler
 * and safer.
 */
export function resolveSelection(manifest: Manifest, selection: Selection): Selection | null {
  const scene = manifest.scenes[selection.sceneIndex];
  if (!scene) return null;
  const { target } = selection;

  if (target.kind === 'layer') {
    const list = scene.layers;
    if (!list) return null;
    if (target.id) {
      const idx = list.findIndex((l) => l.id === target.id);
      return idx === -1 ? null : { sceneIndex: selection.sceneIndex, target: { kind: 'layer', index: idx, id: target.id } };
    }
    return list[target.index] ? selection : null;
  }

  if (target.kind === 'scene3d-child') {
    const list = scene.scene3d?.children;
    if (!list) return null;
    if (target.id) {
      const idx = list.findIndex((l) => l.id === target.id);
      return idx === -1
        ? null
        : { sceneIndex: selection.sceneIndex, target: { kind: 'scene3d-child', index: idx, id: target.id } };
    }
    return list[target.index] ? selection : null;
  }

  // scene / camera / scene3d-camera — positional by nature (there is
  // exactly one of each per scene, nothing to reorder), so the scene
  // existing (already checked above) is the whole check.
  return selection;
}

/** `resolveSelection` over a whole selection array — drops any entry that
 *  no longer resolves (deleted layer, id belonged to a manifest this one
 *  no longer is) rather than leaving a dangling `Selection` a consumer
 *  would have to null-check individually. Used by `MotionTab.tsx` whenever
 *  the STABLE manifest changes (a commit, a catalog insert, a hand-edit in
 *  the raw-JSON textarea) — the moment a reorder/insert/delete could have
 *  invalidated a live multi-selection's indices. */
export function resolveSelections(manifest: Manifest, selections: Selection[]): Selection[] {
  const out: Selection[] = [];
  for (const s of selections) {
    const r = resolveSelection(manifest, s);
    if (r) out.push(r);
  }
  return out;
}

/** Clones `manifest` and resolves a mutable reference to the raw layer
 *  object `selection` points at inside that SAME clone — the "clone, then
 *  find the identical spot inside the clone" step every `set*` function
 *  below that mutates a layer's own fields shares verbatim
 *  (`setLayerField`, `setLayerPosition`, `setLayerSize`,
 *  `setLayerTransformField`), factored out once four call sites needed it
 *  (CLAUDE.md's "if two places need it, extract it"). `null` for a
 *  selection that doesn't resolve to a layer at all (scene/camera target,
 *  out-of-range index, scene without `layers`/`scene3d`) — every caller
 *  treats `null` the same way it already treated its own inlined version of
 *  this check: return the ORIGINAL `manifest` unchanged. */
function cloneLayerRaw(manifest: Manifest, selection: Selection): { next: Manifest; raw: Raw } | null {
  const scene = selectedScene(manifest, selection.sceneIndex);
  if (!scene) return null;
  const { target } = selection;
  const next = clone(manifest);
  const nScene = next.scenes[selection.sceneIndex];
  let raw: Raw | undefined;
  if (target.kind === 'layer') raw = nScene.layers?.[target.index] as unknown as Raw;
  else if (target.kind === 'scene3d-child') raw = nScene.scene3d?.children[target.index] as unknown as Raw;
  if (!raw) return null;
  return { next, raw };
}

/** set (or, if `value === undefined`, delete) one field on the layer a
 *  selection points at. No-op (returns the same manifest reference) if the
 *  selection doesn't resolve to a layer — callers already hide the form in
 *  that case, this is a defensive floor, not the primary guard. */
export function setLayerField(manifest: Manifest, selection: Selection, key: string, value: unknown): Manifest {
  const found = cloneLayerRaw(manifest, selection);
  if (!found) return manifest;
  const { next, raw } = found;
  if (value === undefined) delete raw[key];
  else raw[key] = value;
  return next;
}

/** The `[x,y,w,h]` an `emphasis` layer starts with when a drag has to
 *  invent a width/height (`box` missing or malformed) — D-151's own
 *  `defaultLayerFor('emphasis')` starting box, so a drag never has to guess
 *  a size independently of what "insert an emphasis" already means here. */
const DEFAULT_EMPHASIS_BOX_SIZE = { w: 400, h: 200 };

/** `layers.cardW`/`cardH`'s own runtime defaults (`Layers.tsx`), read here
 *  so `layerWorldSize` can report a real seed size for a card stack that has
 *  never had an explicit size — the size-handle counterpart to
 *  `DEFAULT_EMPHASIS_BOX_SIZE` above. */
const DEFAULT_LAYERS_CARD_SIZE = { w: 620, h: 110 };

/** A layer's current position in WORLD px (D-155/D-156, §3a/§4 Phase 1 of
 *  `docs/notes/motion-visual-builder-research.md`) — resolved the way
 *  `propCatalog.ts`'s `positionFields` says THIS primitive's anchor is
 *  stored, never by re-deriving anything from the DOM (the DOM is only ever
 *  measured for the screen↔world SCALE/ORIGIN — `canvasGeometry.ts` — a
 *  layer's own authored position is already a world coordinate sitting
 *  right in the manifest, per the research doc's own §3a). `null` for a
 *  selection that doesn't resolve to a layer, an unrecognized `use`
 *  (`positionFields` returns `undefined`), or — `emphasis` only — a `box`
 *  that isn't a real `[x,y,w,h]` tuple (the `pulse`/`glow` presets don't use
 *  one at all, see `Emphasis.tsx`), all of which read as "not draggable"
 *  rather than a crash.
 *
 *  `x`/`y` fall back to an approximate canvas centre when unset, mirroring
 *  `Matrix.tsx`'s/`Layers.tsx`'s own "no x/y ⇒ centred" default — an
 *  approximation, not exact (their real default also depends on the
 *  grid/stack's own measured size, which this file deliberately does not
 *  reach into): good enough to seed a FIRST drag on a layer that has never
 *  had an explicit position, not a claim about where it's currently drawn. */
export function layerWorldPosition(manifest: Manifest, selection: Selection): { x: number; y: number } | null {
  const found = selectedLayer(manifest, selection);
  if (!found) return null;
  const kind = positionFields(found.use);
  if (kind === 'xy') {
    const x = typeof found.raw.x === 'number' ? found.raw.x : manifest.width / 2;
    const y = typeof found.raw.y === 'number' ? found.raw.y : manifest.height / 2;
    return { x, y };
  }
  if (kind === 'box-xy') {
    const box = found.raw.box;
    if (!Array.isArray(box) || typeof box[0] !== 'number' || typeof box[1] !== 'number') return null;
    return { x: box[0], y: box[1] };
  }
  return null;
}

/** Writes a new WORLD-px position back through whichever field(s)
 *  `positionFields` says this primitive uses — the ONE write path a canvas
 *  drag commits through (§4 Phase 1), so `text`/`matrix`/`layers` and
 *  `emphasis` never need their own bespoke drag-commit code, and adding a
 *  fifth draggable primitive later only ever means adding a case to
 *  `positionFields`, not to this function. `box-xy` preserves the existing
 *  `w`/`h` (or `DEFAULT_EMPHASIS_BOX_SIZE` if the box was missing/malformed)
 *  — a position drag never touches size. No-op (same manifest reference
 *  back) for a selection that doesn't resolve, or a `use` with no position
 *  fields at all (`graph`, an `in3d` primitive, or a future `use` this
 *  build doesn't recognize) — the same defensive floor every function in
 *  this file already holds. */
export function setLayerPosition(manifest: Manifest, selection: Selection, x: number, y: number): Manifest {
  const found = selectedLayer(manifest, selection);
  if (!found) return manifest;
  const kind = positionFields(found.use);
  if (!kind) return manifest;
  const cloned = cloneLayerRaw(manifest, selection);
  if (!cloned) return manifest;
  const { next, raw } = cloned;
  if (kind === 'xy') {
    raw.x = x;
    raw.y = y;
  } else {
    const existing = Array.isArray(raw.box) ? (raw.box as unknown[]) : [];
    const w = typeof existing[2] === 'number' ? existing[2] : DEFAULT_EMPHASIS_BOX_SIZE.w;
    const h = typeof existing[3] === 'number' ? existing[3] : DEFAULT_EMPHASIS_BOX_SIZE.h;
    raw.box = [x, y, w, h];
  }
  return next;
}

/**
 * D-158, Phase 3 — "drag moves every selected layer by one shared world
 * delta." The multi-layer counterpart to `setLayerPosition` above: given
 * each selected layer's OWN base position (captured once, at drag-start,
 * by the caller — `MotionCanvasOverlay.tsx` — via `layerWorldPosition`, the
 * exact same function a single-layer drag already used), applies the SAME
 * `dx`/`dy` to every one of them and returns ONE resulting `Manifest`.
 *
 * Implemented by threading the manifest through `setLayerPosition` once per
 * entry rather than mutating a single clone's raw layers directly — a
 * second, subtly different traversal of the same "find this selection's
 * raw layer" logic `cloneLayerRaw` already owns would be exactly the
 * duplication CLAUDE.md's "if two places need it, extract it" warns about,
 * and `setLayerPosition` already IS that logic, fully tested on its own.
 * The threading still produces a SINGLE final `Manifest` object — which is
 * the actual requirement ("one atomic manifest change, one undo step, not N
 * separate commits"), not an implementation detail: `MotionCanvasOverlay`
 * calls `onCommit` exactly once with whatever this function returns,
 * regardless of how many layers moved.
 *
 * A `moves` entry whose primitive has no position field at all is never
 * constructed by the caller in the first place (`layerWorldPosition`
 * already returned `null` for it and it was filtered out before this
 * function ever sees it) — this function has nothing defensive to do about
 * that case itself, `setLayerPosition`'s own no-op floor covers it anyway
 * if a caller ever did pass one through.
 */
export function moveLayersByDelta(
  manifest: Manifest,
  moves: { selection: Selection; base: { x: number; y: number } }[],
  dx: number,
  dy: number,
): Manifest {
  let next = manifest;
  for (const { selection, base } of moves) {
    next = setLayerPosition(next, selection, base.x + dx, base.y + dy);
  }
  return next;
}

/** The `[w,h]` a `matrix` layer's grid footprint measures at gap `gap` (the
 *  same `w = cols*(cell+gap)-gap` / `h = rows*(cell+gap)-gap` `Matrix.tsx`
 *  itself computes) — pulled out once `layerWorldSize`/`setLayerSize` both
 *  need to reason about it in opposite directions (size→cell and cell→size). */
const MATRIX_DEFAULT_CELL = 88; // `Matrix.tsx`'s own `cell = 88` default
const MATRIX_DEFAULT_GAP = 10; // `Matrix.tsx`'s own `gap = 10` default

/** Seed value for `text.maxWidth` when a drag has to invent one (`Text.tsx`
 *  has no real default — `maxWidth` unset means "no wrap constraint at
 *  all," so there is no true value to read back, only a starting point for
 *  a first resize) — an honest approximation in the same spirit as
 *  `layerWorldPosition`'s own "approximate canvas centre" fallback, not a
 *  claim about anything currently rendered. */
const TEXT_MAX_WIDTH_SEED = 800;

/** The floor a resize drag can never push a field below — guards every
 *  `setLayerSize` branch against a dragged-past-zero (or negative) width,
 *  height, or `matrix.cell`, all of which would otherwise render nothing
 *  (or, for `matrix`, divide-by-effectively-nothing on the next read). */
const MIN_RESIZE_PX = 8;

/** A layer's current size in WORLD px, per `propCatalog.ts`'s `sizeFields`
 *  (D-157, Phase 2 of `docs/notes/motion-visual-builder-research.md`) — the
 *  resize-handle counterpart to `layerWorldPosition` above, same shape and
 *  same honesty about approximated defaults. `h: null` means "this
 *  primitive has no independent height field" (`text.maxWidth` only wraps,
 *  it doesn't set a box height) — a caller's cue to offer only a
 *  width-changing handle, never a height or corner one, for that primitive.
 *  `null` (the whole return) for a selection that doesn't resolve to a
 *  layer, or a `use` with no resizable field at all (`sizeFields` returns
 *  `undefined` — every `in3d` primitive, and any future/unrecognized
 *  `use`). */
export function layerWorldSize(manifest: Manifest, selection: Selection): { w: number; h: number | null } | null {
  const found = selectedLayer(manifest, selection);
  if (!found) return null;
  const kind = sizeFields(found.use);
  if (!kind) return null;
  const raw = found.raw;

  if (kind.kind === 'box-wh') {
    const box = raw.box;
    const w = Array.isArray(box) && typeof box[2] === 'number' ? box[2] : DEFAULT_EMPHASIS_BOX_SIZE.w;
    const h = Array.isArray(box) && typeof box[3] === 'number' ? box[3] : DEFAULT_EMPHASIS_BOX_SIZE.h;
    return { w, h };
  }

  if (kind.kind === 'wh') {
    // `layers.cardW`/`cardH` default to `Layers.tsx`'s own 620/110; `graph`
    // (the only other `'wh'` primitive) defaults its layout box to the
    // canvas itself (`Graph.tsx`: `W = width ?? cw`) — genuinely different
    // per-primitive defaults, so this is keyed on `found.use`, not `kind`.
    const dW = found.use === 'graph' ? manifest.width : DEFAULT_LAYERS_CARD_SIZE.w;
    const dH = found.use === 'graph' ? manifest.height : DEFAULT_LAYERS_CARD_SIZE.h;
    const w = typeof raw[kind.w] === 'number' ? (raw[kind.w] as number) : dW;
    const h = typeof raw[kind.h] === 'number' ? (raw[kind.h] as number) : dH;
    return { w, h };
  }

  if (kind.kind === 'scalar') {
    // matrix: the grid's real footprint, derived from rows/cols/cell/gap —
    // `Matrix.tsx`'s own `w = cols*(cell+gap)-gap`, `h = rows*(cell+gap)-gap`.
    const rows = typeof raw.rows === 'number' ? raw.rows : 1;
    const cols = typeof raw.cols === 'number' ? raw.cols : 1;
    const cell = typeof raw.cell === 'number' ? raw.cell : MATRIX_DEFAULT_CELL;
    const gap = typeof raw.gap === 'number' ? raw.gap : MATRIX_DEFAULT_GAP;
    const step = cell + gap;
    return { w: cols * step - gap, h: rows * step - gap };
  }

  // w-only (text.maxWidth)
  const w = typeof raw[kind.key] === 'number' ? (raw[kind.key] as number) : TEXT_MAX_WIDTH_SEED;
  return { w, h: null };
}

/** Writes a new WORLD-px size back through whichever field(s) `sizeFields`
 *  says this primitive uses — the ONE write path a canvas resize handle
 *  commits through, mirroring `setLayerPosition`'s own role for drags.
 *  `h` is ignored for a `'w-only'` primitive (`text` — there is no height
 *  field to write; a caller offering only a width handle for `text` never
 *  has a real `h` to pass anyway, per `layerWorldSize`'s own `h: null`).
 *
 *  `'scalar'` (`matrix`) is the one case with fewer degrees of freedom than
 *  the two numbers a resize drag naturally produces: `cell` is a SINGLE
 *  field driving both `w` and `h` (`w = cols*(cell+gap)-gap`, `h =
 *  rows*(cell+gap)-gap`), so a target `(w,h)` is inverted independently
 *  through each axis (`cellFromW`, `cellFromH`) and the two results are
 *  averaged into the one `cell` actually written — an honest, documented
 *  collapse, not an attempt to satisfy both exactly (only a corner handle is
 *  ever offered for `matrix`, see `MotionCanvasOverlay.tsx`, so in practice
 *  both axes move together and agree closely).
 *
 *  Every branch floors its result at `MIN_RESIZE_PX` so a drag can never
 *  push a field to zero/negative. No-op (same manifest reference back) for
 *  a selection that doesn't resolve, or a `use` with no size fields at all —
 *  the same defensive floor every function in this file already holds. */
export function setLayerSize(manifest: Manifest, selection: Selection, w: number, h: number): Manifest {
  const found = selectedLayer(manifest, selection);
  if (!found) return manifest;
  const kind = sizeFields(found.use);
  if (!kind) return manifest;
  const cloned = cloneLayerRaw(manifest, selection);
  if (!cloned) return manifest;
  const { next, raw } = cloned;

  const W = Math.max(MIN_RESIZE_PX, w);
  const H = Math.max(MIN_RESIZE_PX, h);

  if (kind.kind === 'box-wh') {
    const existing = Array.isArray(raw.box) ? (raw.box as unknown[]) : [];
    const x = typeof existing[0] === 'number' ? existing[0] : 0;
    const y = typeof existing[1] === 'number' ? existing[1] : 0;
    raw.box = [x, y, W, H];
    return next;
  }

  if (kind.kind === 'wh') {
    raw[kind.w] = W;
    raw[kind.h] = H;
    return next;
  }

  if (kind.kind === 'scalar') {
    const rows = typeof raw.rows === 'number' ? (raw.rows as number) : 1;
    const cols = typeof raw.cols === 'number' ? (raw.cols as number) : 1;
    const gap = typeof raw.gap === 'number' ? (raw.gap as number) : MATRIX_DEFAULT_GAP;
    const cellFromW = (W + gap) / cols - gap;
    const cellFromH = (H + gap) / rows - gap;
    raw[kind.key] = Math.max(MIN_RESIZE_PX, (cellFromW + cellFromH) / 2);
    return next;
  }

  // w-only (text.maxWidth) — `h` has nowhere to go, deliberately dropped
  raw[kind.key] = W;
  return next;
}

/** Padding added on every side of a snapped `emphasis` box, in world px —
 *  the "snap to layer" action (below) circles/scribbles AROUND the target
 *  layer's measured rect, not flush against it (a box drawn exactly at the
 *  target's own edges reads as touching it, not calling it out — and
 *  `Emphasis.tsx`'s own `scribble`/`ring` presets already inflate their
 *  drawn shape past the `box` you give them, see that file's header
 *  comment, so a snug fit here would UNDERSHOOT visually anyway). A named
 *  constant per the house no-magic-numbers rule; not tuned against anything
 *  deeper than "reads as circling the sample manifest's own text layer." */
export const SNAP_TO_LAYER_PAD = 24;

/**
 * "Snap to layer" (D-157, Phase 2 of `docs/notes/motion-visual-builder-
 * research.md` §3d) — the direct fix for the owner's original screenshot
 * complaint (a `scribble` highlight box hand-authored to the wrong place).
 * The doc's own "cheaper, non-render-path variant": keep `box` as the
 * stored truth, and let an action measure the TARGET layer's real rect once
 * and write the four numbers — "a button, not a subsystem."
 *
 * Pure: given the target layer's ALREADY-MEASURED screen rect and the
 * screen↔world map at that instant (both DOM-derived by the caller — this
 * function never touches the DOM itself, the exact same split
 * `canvasGeometry.ts`'s own doc comment holds this package to), converts to
 * world px via `screenToWorld`/`worldDelta` and writes `box` on the
 * `emphasis` layer `selection` points at, expanded by `SNAP_TO_LAYER_PAD` on
 * every side. No-op (same manifest reference back) for a selection that
 * isn't an `emphasis` layer — the Inspector already hides this action for
 * anything else; this is the same defensive floor every function here holds.
 */
export function snapEmphasisToRect(
  manifest: Manifest,
  selection: Selection,
  targetScreenRect: RectLike,
  map: WorldMap,
): Manifest {
  const found = selectedLayer(manifest, selection);
  if (!found || found.use !== 'emphasis') return manifest;
  const origin = screenToWorld(map, { x: targetScreenRect.left, y: targetScreenRect.top });
  const size = worldDelta(map, { x: targetScreenRect.width, y: targetScreenRect.height });
  return setLayerField(manifest, selection, 'box', [
    origin.x - SNAP_TO_LAYER_PAD,
    origin.y - SNAP_TO_LAYER_PAD,
    size.x + SNAP_TO_LAYER_PAD * 2,
    size.y + SNAP_TO_LAYER_PAD * 2,
  ]);
}

/** Read/write for the D-157 layer-transform wrapper's NESTED
 *  `layer.transform.<key>` fields (`schema.ts`'s `layerTransform`) — kept
 *  separate from `setLayerField` because that function only ever writes a
 *  TOP-LEVEL layer key, never reaches inside a nested object. Setting the
 *  LAST remaining key to `undefined` deletes `transform` entirely rather
 *  than leaving `"transform": {}` behind — an all-absent transform object is
 *  already indistinguishable from no transform at all (every field in
 *  `layerTransform` is `.optional()`, so `{}` and "absent" parse to the
 *  exact same runtime meaning), and leaving the empty object around would
 *  just be textual noise in the saved manifest. No-op (same manifest
 *  reference back) for a selection that doesn't resolve to a layer — the
 *  same defensive floor every function in this file already holds. Used for
 *  BOTH `scene.layers` (2D — where `Video.tsx`'s `renderLayers` actually
 *  applies it) and `scene3d.children` (3D — harmless to store, `ThreeD` in
 *  `Video.tsx` never reads it; `InspectorPanel.tsx` only ever renders this
 *  control for a 2D `layer` selection, so a 3D child never reaches this
 *  path in practice today). */
export function setLayerTransformField(manifest: Manifest, selection: Selection, key: string, value: unknown): Manifest {
  const cloned = cloneLayerRaw(manifest, selection);
  if (!cloned) return manifest;
  const { next, raw } = cloned;
  const existing: Raw = raw.transform && typeof raw.transform === 'object' ? { ...(raw.transform as Raw) } : {};
  if (value === undefined) delete existing[key];
  else existing[key] = value;
  if (Object.keys(existing).length === 0) delete raw.transform;
  else raw.transform = existing;
  return next;
}

/** The D-157 layer-transform wrapper's `keys` array (D-159, Phase 4 — "the
 *  animation model: per-layer keyframes") a selection's layer currently
 *  carries, or `[]` for a selection that doesn't resolve to a layer, has no
 *  `transform` at all, or has a `transform` with no (or a malformed)
 *  `keys` — the same "reads as not-draggable/not-keyed rather than a crash"
 *  floor every other read function in this file already holds. The
 *  `InspectorPanel.tsx` keyframe-list editor (`KeyframeList`, generalized
 *  from D-155's camera-only `CameraKeyList`) reads through this rather than
 *  digging into `found.raw.transform` itself. */
export function layerTransformKeys(manifest: Manifest, selection: Selection): TransformKey[] {
  const found = selectedLayer(manifest, selection);
  const t = found?.raw.transform as Raw | undefined;
  return Array.isArray(t?.keys) ? (t.keys as TransformKey[]) : [];
}

/** Writes a whole new `keys` array back through `setLayerTransformField` —
 *  the write half of `layerTransformKeys` above, and the Inspector's
 *  keyframe-list editor's own `onChange`. An EMPTY array deletes the field
 *  entirely (`setLayerTransformField`'s own `value === undefined` branch),
 *  matching this file's existing "an empty/all-default nested object doesn't
 *  linger in the saved manifest" convention (`setLayerTransformField`'s own
 *  doc comment) — `keys: []` and "no `keys` field" already mean the exact
 *  same thing to every reader of this schema (`Video.tsx`'s `renderLayers`
 *  only takes the keyed branch when `keys.length > 0`). */
export function setLayerTransformKeys(manifest: Manifest, selection: Selection, keys: TransformKey[]): Manifest {
  return setLayerTransformField(manifest, selection, 'keys', keys.length > 0 ? keys : undefined);
}

/**
 * Phase 5b of `docs/notes/motion-keyframe-timeline-research.md` ("drag a key
 * along time") — the genuinely NEW write primitive the research doc's §4
 * flagged as not existing anywhere in this file: every writer above touches
 * a key's VALUE fields (`x`/`y`/`zoom`/`scale`/…), none of them touches
 * `at`. This is the one shared core, parameterized over the key ARRAY
 * (generic over the three shapes `cam2dKey`/`cam3dKey`/`transformKey` all
 * happen to share — `{at: number, ...}`) rather than three independently
 * hand-rolled reorder/clamp implementations, so the two real design
 * decisions below only have to be made and tested once.
 *
 * **Decision 1 — dragging a key past a NEIGHBOR: reorder, don't clamp.**
 * This function re-sorts the whole array by `at` after moving the one key
 * at `index`, allowing it to cross and swap places with any neighbor. The
 * alternative (clamp the drag so a key can never move past whichever
 * neighbor is currently adjacent to it) was rejected: `interpolateKeys`
 * (`motion-engine/src/lib/interpolateKeys.ts`, confirmed by reading it —
 * the research doc's §1) already re-sorts its OWN copy of `keys` by `at` on
 * every call, before array order is used for anything — so nothing
 * downstream ever treats this array's on-disk ORDER as meaningful, only
 * each key's `at` VALUE is. Clamping at a neighbor would therefore be a
 * purely cosmetic restriction with no correctness payoff, and would make
 * the ordinary "these two keys are close together, drag one past the
 * other to swap their order" edit impossible without a separate
 * value-editing step first. It also matches the default behaviour of every
 * mainstream keyframe editor this package's own research has cited
 * (Remotion Studio, After Effects, Premiere): dragging a key past its
 * neighbor freely reorders rather than stopping dead at the collision.
 *
 * **Decision 2 — boundary clamping.** `newAt` is clamped to
 * `[0, sceneDurSeconds]` — never before the scene's own start, never past
 * its own `dur` (seconds, matching `scene.dur`'s own unit) — regardless of
 * where the pointer that produced `newAt` actually was. This is what makes
 * dragging a key belonging to one scene, while the pointer strays into a
 * neighboring scene's region of a whole-composition strip, behave sanely:
 * the key simply pins to its own scene's start/end rather than jumping
 * into a scene it doesn't belong to (there is no manifest operation that
 * moves a key BETWEEN scenes — the research doc's own §4 explicitly rules
 * this out).
 *
 * **The FIRST/LAST key is not a special case.** Both are just `index === 0`
 * / `index === keys.length - 1` into an array this function clamps and
 * re-sorts identically for every index — there is no off-by-one boundary
 * logic that treats an edge key differently from a middle one.
 *
 * **Identified by INDEX INTO THE INPUT ARRAY, not by object identity or a
 * post-sort search.** Every caller (the three thin wrappers below) reads
 * `keys` fresh from the STABLE manifest and passes the SAME captured
 * `index` on every call during a live drag (never the index from a
 * PREVIOUS call's own re-sorted output) — the same "recompute from a
 * stable base + delta, never from the last frame's own transient result"
 * discipline every other drag primitive in this file already follows
 * (`layerDragBase`/`moveLayersByDeltaAutoKey`, `nextSize` in
 * `MotionCanvasOverlay.tsx`). This is safe specifically BECAUSE the
 * function is pure and re-sorts its OWN output rather than mutating in
 * place — two calls with the same `keys`/`index` always agree, even though
 * the returned array's position for that key can differ.
 */
export function moveKeyAt<T extends { at: number }>(
  keys: T[],
  index: number,
  newAt: number,
  sceneDurSeconds: number,
): T[] {
  if (index < 0 || index >= keys.length) return keys;
  const clamped = Math.min(sceneDurSeconds, Math.max(0, newAt));
  const next = keys.map((k, i) => (i === index ? { ...k, at: clamped } : k));
  // `Array.prototype.sort` has been a STABLE sort since ES2019 — two keys
  // that land on the exact same `at` (a valid, if unusual, authored or
  // dragged-to shape) keep their existing relative order rather than
  // swapping arbitrarily on every unrelated re-sort.
  next.sort((a, b) => a.at - b.at);
  return next;
}

/** The `layer.transform.keys` wrapper around `moveKeyAt` — reads the
 *  selection's own keys and its scene's `dur` (the clamp bound), writes the
 *  result back through `setLayerTransformKeys` above. No-op (same manifest
 *  reference back) for a selection that doesn't resolve to a scene — the
 *  same defensive floor every function in this file already holds; an
 *  out-of-range `keyIndex` is `moveKeyAt`'s own no-op, not re-checked here. */
export function moveLayerTransformKeyAt(
  manifest: Manifest,
  selection: Selection,
  keyIndex: number,
  newAtSeconds: number,
): Manifest {
  const scene = selectedScene(manifest, selection.sceneIndex);
  if (!scene) return manifest;
  const keys = layerTransformKeys(manifest, selection);
  return setLayerTransformKeys(manifest, selection, moveKeyAt(keys, keyIndex, newAtSeconds, scene.dur));
}

/** The `scene.camera` (2D) wrapper around `moveKeyAt` — same shape as
 *  `moveLayerTransformKeyAt` above, for the camera's own key array instead
 *  of a layer's. No-op for a scene that doesn't exist or has no camera at
 *  all (`selectedCamera2d`'s own `null` floor). */
export function moveCamera2dKeyAt(
  manifest: Manifest,
  sceneIndex: number,
  keyIndex: number,
  newAtSeconds: number,
): Manifest {
  const scene = selectedScene(manifest, sceneIndex);
  const keys = selectedCamera2d(manifest, sceneIndex);
  if (!scene || !keys) return manifest;
  return setCamera2d(manifest, sceneIndex, moveKeyAt(keys, keyIndex, newAtSeconds, scene.dur));
}

/** The `scene.scene3d.camera` (3D) wrapper around `moveKeyAt` — same shape
 *  again, for the 3D camera's own key array. No-op for a scene with no
 *  `scene3d` at all (`selectedCamera3d`'s own `null` floor). */
export function moveCamera3dKeyAt(
  manifest: Manifest,
  sceneIndex: number,
  keyIndex: number,
  newAtSeconds: number,
): Manifest {
  const scene = selectedScene(manifest, sceneIndex);
  const keys = selectedCamera3d(manifest, sceneIndex);
  if (!scene || !keys) return manifest;
  return setCamera3d(manifest, sceneIndex, moveKeyAt(keys, keyIndex, newAtSeconds, scene.dur));
}

/** A single key's location, structurally identical to `keyframeVisibility.
 *  ts`'s `KeyframeLane` (+ its own `keyIndex`) but NOT imported from there —
 *  `keyframeVisibility.ts` already imports `layerTransformKeys` FROM this
 *  file, so importing `KeyframeLane` back would create a cycle. TypeScript's
 *  structural typing means a real `KeyframeLane` value (plus `keyIndex`)
 *  satisfies this shape without either file needing to know about the
 *  other's own type declaration. */
export interface KeyMoveTarget {
  sceneIndex: number;
  kind: 'camera' | 'scene3d-camera' | 'layer';
  /** Only meaningful for `kind: 'layer'` — the index into `scene.layers[]`. */
  layerIndex?: number;
  /** The key's own index into ITS array, captured once at drag-start from
   *  the STABLE manifest — never re-derived mid-gesture (same discipline
   *  `moveKeyAt`'s own doc comment already states for the single-key case). */
  keyIndex: number;
  /** The key's own `at` (seconds), ALSO captured once at drag-start — the
   *  base this function adds `deltaSeconds` to. Carried per-target (not
   *  re-read from `manifest` inside this function) so a caller's drag
   *  preview and the eventual commit always agree on the same arithmetic,
   *  the same "recompute from a stable base + delta, never from a
   *  previous call's own transient result" rule every other drag
   *  primitive in this file follows. */
  baseAtSeconds: number;
}

/**
 * D-158's `moveLayersByDelta`, for keyframes — the shared-delta multi-key
 * nudge the research doc's §4 named as real, remaining work: "a
 * nudge-many-keys-by-one-shared-delta write path analogous to
 * `moveLayersByDelta`, but for `at` values instead of `x`/`y`." Composes N
 * pure single-array writes into ONE resulting `Manifest` — the same "one
 * atomic manifest change, one undo step, not N separate commits" shape
 * `moveLayersByDelta`/`setFieldOnSelections` already established, so a
 * caller (`KeyframeTimeline.tsx`) calls `onCommit` exactly once with
 * whatever this returns, regardless of how many keys moved or which arrays
 * they came from.
 *
 * **Cross-lane / cross-scene spanning: explicitly ALLOWED, unlike
 * `Selection[]`'s own same-kind/same-scene constraint (D-158).** That
 * constraint exists for LAYER selections because a canvas gesture only ever
 * has ONE scene's layers mounted in the DOM at a time (§1e of the research
 * doc) and a mixed scene/camera selection has no coherent world-space
 * meaning. Neither restriction applies to a shared TIME delta: reading or
 * writing a key's `at` needs no live DOM (§1 of the research doc — the same
 * fact that already lets `keyframeLanes`/`laneKeyMarkers` show every scene's
 * keys at once), and a delta in seconds means the identical thing to a
 * camera key, a layer key, a key in scene 0, or a key in scene 3 — there is
 * no "world space" for time the way there is for `x`/`y`. So a multi-key
 * selection spanning several lanes and/or several scenes is fully supported
 * and nudges all of them together by the same `deltaSeconds`.
 *
 * **Boundary clamping: EACH key clamps independently to its OWN scene's
 * `[0, dur]` — the nudge is never blocked as a whole, and can become
 * effectively non-uniform at the boundary.** Decided by consistency with
 * `moveKeyAt`'s own already-established philosophy (never block, only
 * clamp) rather than inventing a second, stricter rule just for the
 * multi-key case: if a nudge would push one selected key to a boundary
 * while another has room to spare, the first key stops at its own scene's
 * edge and the rest move the full `deltaSeconds` — the same "a member with
 * a problem is silently skipped/limited, it doesn't block the group"
 * precedent `moveLayersByDelta`'s own doc comment already sets for a
 * non-draggable layer swept into a marquee. The rejected alternative —
 * block the WHOLE nudge the instant ANY key would clip — was ruled out
 * because it would make a single-key drag and a multi-key nudge disagree
 * about what "hit the edge" means for no real benefit: a single-key drag
 * has NEVER blocked (it clamps), and a nudge is explicitly meant to
 * generalize that gesture, not add a new, stricter mode on top of it.
 */
export function moveKeysByDelta(manifest: Manifest, targets: KeyMoveTarget[], deltaSeconds: number): Manifest {
  // Group by the array a target actually shares with others — so keys
  // living in the SAME array move together through ONE `moveKeysAt` call
  // (one sort), never through N separate calls whose `keyIndex` values
  // could drift out from under each other (`moveKeysAt`'s own doc comment
  // has the full correctness-trap reasoning).
  const groups = new Map<string, KeyMoveTarget[]>();
  for (const t of targets) {
    const groupKey = `${t.sceneIndex}:${t.kind}:${t.layerIndex ?? ''}`;
    const existing = groups.get(groupKey);
    if (existing) existing.push(t);
    else groups.set(groupKey, [t]);
  }

  let next = manifest;
  for (const group of groups.values()) {
    const { sceneIndex, kind, layerIndex } = group[0];
    const scene = selectedScene(next, sceneIndex);
    if (!scene) continue; // a stale target whose scene no longer exists — silently skipped

    if (kind === 'camera') {
      const keys = selectedCamera2d(next, sceneIndex);
      if (!keys) continue;
      next = setCamera2d(next, sceneIndex, moveKeysAt(keys, group, deltaSeconds, scene.dur));
    } else if (kind === 'scene3d-camera') {
      const keys = selectedCamera3d(next, sceneIndex);
      if (!keys) continue;
      next = setCamera3d(next, sceneIndex, moveKeysAt(keys, group, deltaSeconds, scene.dur));
    } else if (kind === 'layer' && layerIndex !== undefined) {
      const selection: Selection = { sceneIndex, target: { kind: 'layer', index: layerIndex } };
      const keys = layerTransformKeys(next, selection);
      next = setLayerTransformKeys(next, selection, moveKeysAt(keys, group, deltaSeconds, scene.dur));
    }
  }
  return next;
}

/**
 * The multi-key analog of `moveKeyAt` above, and `moveKeysByDelta`'s own
 * per-array step — needed as its OWN primitive rather than N sequential
 * calls to `moveKeyAt`, for a real correctness trap found while designing
 * this rather than assumed away: `moveKeyAt` re-sorts its OWN output on
 * every call (Decision 1, above), so if TWO selected keys live in the SAME
 * array (e.g. two keys on the same layer's own `transform.keys`), calling
 * `moveKeyAt` once per key — each reading the array fresh off an
 * already-partially-moved manifest — lets the FIRST call's reorder shift
 * the SECOND call's captured `keyIndex` out from under it, silently
 * retiming the wrong key. Concretely: keys at `[{at:1},{at:2},{at:3}]`,
 * indices 0 and 2 both selected, dragged by `+5`. Moving index 0 first
 * re-sorts to `[{at:2},{at:3},{at:6}]` — index 2 in THAT array is now the
 * key that was originally at index 0 (already moved), not the original
 * `{at:3}` key the second call meant to move.
 *
 * This primitive avoids the trap entirely: every new `at` is computed from
 * each move's own REMEMBERED `baseAtSeconds` (captured once at drag-start,
 * `KeyMoveTarget`'s own doc comment — never from `keys`' CURRENT `at`,
 * which is exactly the value a sequential approach would have already
 * disturbed), applied in one pass over the ORIGINAL array, then sorted
 * ONCE — the same "recompute from a stable base + delta" discipline
 * `moveLayersByDelta`'s own `base: {x,y}` already established for layers.
 * A `keys[i]` with no corresponding `move.keyIndex === i` is left
 * untouched, so a `moves` list naming keys in OTHER, unrelated arrays
 * simply has nothing to do here (`moveKeysByDelta` never calls this with
 * such a mismatched pair, but the floor costs nothing).
 */
export function moveKeysAt<T extends { at: number }>(
  keys: T[],
  moves: { keyIndex: number; baseAtSeconds: number }[],
  deltaSeconds: number,
  sceneDurSeconds: number,
): T[] {
  const baseByIndex = new Map(moves.map((m) => [m.keyIndex, m.baseAtSeconds]));
  const next = keys.map((k, i) => {
    const base = baseByIndex.get(i);
    if (base === undefined) return k;
    const clamped = Math.min(sceneDurSeconds, Math.max(0, base + deltaSeconds));
    return { ...k, at: clamped };
  });
  // Same stable-sort tie-break `moveKeyAt` already documents.
  next.sort((a, b) => a.at - b.at);
  return next;
}

/** The interpolated `x`/`y` DELTA `transform.keys` produces at `frame`
 *  (frames; `fps` converts from the manifest's stored seconds) — reuses the
 *  SAME shared `interpolateKeys` `motion-engine`'s `Camera.tsx`/`Video.tsx`
 *  use to render a frame (D-159's own "reuse the camera's own key
 *  mechanics, don't invent a second interpolator" instruction, applied here
 *  to the EDITOR's drag math too, not just the render path — see
 *  `layerDragBase` below for why this matters: a drag's captured "current
 *  value" must agree with what the picture is actually showing at that
 *  instant, and re-deriving that with a second hand-rolled interpolator
 *  would be exactly the kind of drift this file's own `canvasGeometry.ts`
 *  doc comment warns "getting this wrong is silent" about). `{x:0,y:0}` for
 *  an empty `keys` array — `interpolateKeys` already returns the supplied
 *  defaults in that case; this function exists so callers never construct
 *  the `['x','y']`/defaults/`design.ease.inOut` call themselves. */
export function layerTransformKeyDelta(keys: TransformKey[], frame: number, fps: number): { x: number; y: number } {
  const frameKeys = keys.map((k) => ({ ...k, at: Math.round(k.at * fps) }));
  return interpolateKeys(frameKeys, frame, ['x', 'y'] as const, { x: 0, y: 0 }, design.ease.inOut);
}

/**
 * D-159, Phase 4's auto-keyframe decision (see this file's own module doc
 * comment cross-reference and D-159's decision entry for the FULL reasoning
 * — this is the load-bearing function behind it, not just a helper).
 * Decides, for ONE selection, what a MOVE drag should treat as its starting
 * "base" position and whether that drag should write a `transform.keys` row
 * (Remotion Studio's own cited rule: "drags create or update a keyframe at
 * the current frame" when the property is already keyframed) or the
 * primitive's own base position field exactly as Phase 1 always has (when
 * it is not).
 *
 * **Per-PROPERTY, not per-layer** — the research doc's own framing, applied
 * here as: position (`x`+`y` together, since ONE move-drag gesture always
 * changes both, the same way Remotion's own precedent groups
 * `style.translate` as one property) counts as "keyframed" only when
 * `transform.keys` has AT LEAST ONE entry that defines `x` OR `y` on THIS
 * layer specifically — `transform.keys` existing at all (say, for an
 * `opacity` fade authored some other way) does NOT flip a layer's position
 * into key-writing mode; that field's own key history is what's checked,
 * never merely "does this layer have a `keys` array." This directly answers
 * the task's own posed ambiguity ("does dragging an unkeyed layer with
 * keyframes elsewhere still just move the base — yes; per-property, not
 * per-layer, exactly as the research doc's phrasing implies).
 *
 * Returns `null` for a selection with no draggable position at all (the
 * same "not draggable" floor `layerWorldPosition` already holds — `graph`,
 * an `in3d` primitive, or a stale selection).
 */
export function layerDragBase(
  manifest: Manifest,
  selection: Selection,
  frame: number,
  fps: number,
): { base: { x: number; y: number }; keyed: boolean } | null {
  const keys = layerTransformKeys(manifest, selection);
  const keyed = keys.some((k) => typeof k.x === 'number' || typeof k.y === 'number');
  if (keyed) {
    return { base: layerTransformKeyDelta(keys, frame, fps), keyed: true };
  }
  const pos = layerWorldPosition(manifest, selection);
  return pos ? { base: pos, keyed: false } : null;
}

/** The auto-keyframe write path: upserts (creates, or overwrites in place)
 *  ONE `transform.keys` row's `x`/`y` at the frame closest to `atSeconds`
 *  (the SAME `Math.round(at * fps)` conversion `Video.tsx` uses to resolve a
 *  key to a frame, so "the same frame" here means the exact frame the
 *  picture would already resolve that key to). An existing key at that
 *  frame is overwritten IN PLACE — its own `at` and every OTHER field
 *  (`scale`/`rot`/`opacity`/`ease`) are preserved, only `x`/`y` change; no
 *  existing key at that frame appends a new one with exactly `{at: atSeconds,
 *  x, y}`. No-op (same manifest reference back) for a selection that
 *  doesn't resolve to a layer — the same defensive floor every function in
 *  this file already holds. */
export function upsertLayerTransformKeyXY(
  manifest: Manifest,
  selection: Selection,
  atSeconds: number,
  fps: number,
  x: number,
  y: number,
): Manifest {
  const found = selectedLayer(manifest, selection);
  if (!found) return manifest;
  const cloned = cloneLayerRaw(manifest, selection);
  if (!cloned) return manifest;
  const { next, raw } = cloned;
  const t: Raw = raw.transform && typeof raw.transform === 'object' ? { ...(raw.transform as Raw) } : {};
  const existingKeys: Raw[] = Array.isArray(t.keys) ? (t.keys as Raw[]) : [];
  const targetFrame = Math.round(atSeconds * fps);
  const idx = existingKeys.findIndex((k) => Math.round((typeof k.at === 'number' ? k.at : 0) * fps) === targetFrame);
  const nextKeys = [...existingKeys];
  if (idx === -1) nextKeys.push({ at: atSeconds, x, y });
  else nextKeys[idx] = { ...nextKeys[idx], x, y };
  t.keys = nextKeys;
  raw.transform = t;
  return next;
}

/**
 * D-159, Phase 4 — the group-move counterpart to D-158's `moveLayersByDelta`
 * that actually applies the auto-keyframe decision per entry, rather than
 * unconditionally writing every selected layer's native position field.
 * `moves` is captured ONCE at drag-start by the caller
 * (`MotionCanvasOverlay.tsx`) via `layerDragBase` above — each entry already
 * knows, individually, whether IT is keyed (a mixed group — some layers
 * keyed, some not — is fully supported, each entry routes independently).
 * `moveLayersByDelta` itself is left completely untouched (same export,
 * same behaviour, same passing tests) rather than widened to take a `keyed`
 * flag — this is a SEPARATE function for a SEPARATE caller (the drag path
 * once auto-keyframing exists), not a replacement for the simpler
 * unconditional-write function D-158 already shipped and tested.
 */
export function moveLayersByDeltaAutoKey(
  manifest: Manifest,
  moves: { selection: Selection; base: { x: number; y: number }; keyed: boolean }[],
  dx: number,
  dy: number,
  atSeconds: number,
  fps: number,
): Manifest {
  let next = manifest;
  for (const { selection, base, keyed } of moves) {
    next = keyed
      ? upsertLayerTransformKeyXY(next, selection, atSeconds, fps, base.x + dx, base.y + dy)
      : setLayerPosition(next, selection, base.x + dx, base.y + dy);
  }
  return next;
}

/**
 * D-158, Phase 3 — the Inspector's multi-layer "lockstep" edit path (see
 * `InspectorPanel.tsx`'s own doc comment for the fuller reasoning behind
 * this design and the alternatives it didn't take). Writes the SAME `key`/
 * `value` to every selection in `selections`, threading the manifest
 * through `setLayerField` once per entry — the identical "compose N pure
 * single-target writes into one final `Manifest`" shape `moveLayersByDelta`
 * above already established, reused here rather than re-invented for a
 * second multi-target case. A selection that doesn't resolve to a layer is
 * silently skipped (`setLayerField`'s own no-op floor), not an error — the
 * Inspector only ever offers this control for an all-`layer`-kind
 * selection, so in practice every entry resolves; this is the same
 * defensive floor every function in this file already holds, not a load-
 * bearing check here. */
export function setFieldOnSelections(manifest: Manifest, selections: Selection[], key: string, value: unknown): Manifest {
  let next = manifest;
  for (const selection of selections) next = setLayerField(next, selection, key, value);
  return next;
}

/** The lockstep counterpart to `setFieldOnSelections` for the NESTED
 *  `layer.transform.<key>` fields — the Transform group is generic across
 *  every primitive (D-157), so it's the one field group the Inspector's
 *  multi-select view offers in lockstep regardless of whether the selected
 *  layers share a `use`. Same composition shape as every other multi-target
 *  function in this file. */
export function setTransformFieldOnSelections(
  manifest: Manifest,
  selections: Selection[],
  key: string,
  value: unknown,
): Manifest {
  let next = manifest;
  for (const selection of selections) next = setLayerTransformField(next, selection, key, value);
  return next;
}

/** One selected layer's approximate world-space bounding box — the shared
 *  input `alignSelections`/`distributeSelections` (below) both reduce over.
 *  Built from `layerWorldPosition`/`layerWorldSize`, the SAME two functions
 *  the drag/resize handles already use, not a third way of reading a
 *  layer's geometry: `x`/`y` from `layerWorldPosition` (already an honest
 *  approximation for a never-positioned layer, see that function's own doc
 *  comment) and `w`/`h` from `layerWorldSize` — every primitive that
 *  resolves a position here (`text`/`matrix`/`layers`/`emphasis`) also
 *  resolves a size, EXCEPT `text`, whose `layerWorldSize` reports `h: null`
 *  (`'w-only'` — `text.maxWidth` only wraps, `Text.tsx` has no stored
 *  height field at all). That `null` is treated as `0` height here: "align
 *  tops/bottoms/centers vertically" then degenerates to "align by the
 *  layer's own `y` anchor," the most honest thing to do with a primitive
 *  whose vertical extent isn't a number this file has access to (the same
 *  spirit as `layerWorldSize`'s own documented approximations elsewhere in
 *  this file). A selection that doesn't resolve to a draggable position at
 *  all (`layerWorldPosition` returns `null` — `graph`, an `in3d` primitive,
 *  or a stale selection) is dropped from the collection entirely, not given
 *  a degenerate `0,0` box — it has nothing correct to contribute to an
 *  alignment computed from real positions. */
interface WorldBox {
  selection: Selection;
  x: number;
  y: number;
  w: number;
  h: number;
}

function collectWorldBoxes(manifest: Manifest, selections: Selection[]): WorldBox[] {
  const boxes: WorldBox[] = [];
  for (const selection of selections) {
    const pos = layerWorldPosition(manifest, selection);
    if (!pos) continue;
    const size = layerWorldSize(manifest, selection);
    boxes.push({ selection, x: pos.x, y: pos.y, w: size?.w ?? 0, h: size?.h ?? 0 });
  }
  return boxes;
}

/** Which edge (or center line) an align action lines every selected layer's
 *  box up against — D-158, Phase 3's "alignment/distribute actions...
 *  implement a reasonable minimal set for a 2+ layer selection." */
export type AlignEdge = 'left' | 'centerH' | 'right' | 'top' | 'centerV' | 'bottom';

/**
 * Aligns every selected layer's `WorldBox` (above) to a shared line —
 * `left`/`right`/`centerH` move `x`, `top`/`bottom`/`centerV` move `y`,
 * writing through `setLayerPosition` (never touching size). The target
 * line is the extreme (or midpoint of the extremes) across the WHOLE
 * selection's ORIGINAL boxes, computed once before any write, exactly the
 * way a real align tool works: aligning three layers "left" moves every one
 * of them to the leftmost layer's own left edge, not to some running
 * average that shifts as each write lands.
 *
 * No-op (same manifest reference back) for fewer than 2 resolvable boxes —
 * "align" has no meaning for zero or one layer, and this is the same
 * no-op-on-nothing-to-do convention every other function in this file
 * already holds, not a new kind of guard.
 */
export function alignSelections(manifest: Manifest, selections: Selection[], edge: AlignEdge): Manifest {
  const boxes = collectWorldBoxes(manifest, selections);
  if (boxes.length < 2) return manifest;

  let target: number;
  switch (edge) {
    case 'left':
      target = Math.min(...boxes.map((b) => b.x));
      break;
    case 'right':
      target = Math.max(...boxes.map((b) => b.x + b.w));
      break;
    case 'centerH':
      target = (Math.min(...boxes.map((b) => b.x)) + Math.max(...boxes.map((b) => b.x + b.w))) / 2;
      break;
    case 'top':
      target = Math.min(...boxes.map((b) => b.y));
      break;
    case 'bottom':
      target = Math.max(...boxes.map((b) => b.y + b.h));
      break;
    case 'centerV':
      target = (Math.min(...boxes.map((b) => b.y)) + Math.max(...boxes.map((b) => b.y + b.h))) / 2;
      break;
  }

  let next = manifest;
  for (const b of boxes) {
    let x = b.x;
    let y = b.y;
    if (edge === 'left') x = target;
    else if (edge === 'right') x = target - b.w;
    else if (edge === 'centerH') x = target - b.w / 2;
    else if (edge === 'top') y = target;
    else if (edge === 'bottom') y = target - b.h;
    else if (edge === 'centerV') y = target - b.h / 2;
    next = setLayerPosition(next, b.selection, x, y);
  }
  return next;
}

/**
 * Distributes 3+ selected layers with equal GAPS between their boxes along
 * one axis — the standard "distribute spacing" a design tool means by this
 * (not "equal center-to-center spacing," which double-counts differently
 * sized boxes): sorts by position along the axis, holds the first and last
 * box fixed as the span's own bounds, and spaces every box in between so
 * the gap between each pair of adjacent boxes is identical. D-158's own
 * scoping: "for 3+" — with exactly 2 boxes there is only one gap, and
 * "distribute" degenerates to a no-op with nothing to equalize, so this
 * returns the manifest unchanged (same reference) below that count, the
 * same no-op convention every other function here holds.
 */
export function distributeSelections(manifest: Manifest, selections: Selection[], axis: 'horizontal' | 'vertical'): Manifest {
  const boxes = collectWorldBoxes(manifest, selections);
  if (boxes.length < 3) return manifest;

  const sorted = [...boxes].sort((a, b) => (axis === 'horizontal' ? a.x - b.x : a.y - b.y));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const span =
    axis === 'horizontal' ? last.x + last.w - first.x : last.y + last.h - first.y;
  const totalSize = sorted.reduce((sum, b) => sum + (axis === 'horizontal' ? b.w : b.h), 0);
  const gap = (span - totalSize) / (sorted.length - 1);

  let next = manifest;
  let cursor = axis === 'horizontal' ? first.x : first.y;
  for (const b of sorted) {
    if (axis === 'horizontal') {
      next = setLayerPosition(next, b.selection, cursor, b.y);
      cursor += b.w + gap;
    } else {
      next = setLayerPosition(next, b.selection, b.x, cursor);
      cursor += b.h + gap;
    }
  }
  return next;
}

export function setSceneField(manifest: Manifest, sceneIndex: number, key: string, value: unknown): Manifest {
  if (!manifest.scenes[sceneIndex]) return manifest;
  const next = clone(manifest);
  const raw = next.scenes[sceneIndex] as unknown as Raw;
  if (value === undefined) delete raw[key];
  else raw[key] = value;
  return next;
}

export function setCamera2d(manifest: Manifest, sceneIndex: number, keys: Cam2dKey[]): Manifest {
  if (!manifest.scenes[sceneIndex]) return manifest;
  const next = clone(manifest);
  next.scenes[sceneIndex].camera = keys;
  return next;
}

export function setCamera3d(manifest: Manifest, sceneIndex: number, keys: Cam3dKey[]): Manifest {
  const scene = manifest.scenes[sceneIndex];
  if (!scene?.scene3d) return manifest;
  const next = clone(manifest);
  next.scenes[sceneIndex].scene3d!.camera = keys;
  return next;
}

/**
 * Insert a new primitive into a scene, and say where it landed (D-151).
 *
 * The one *creative* manifest op in this file — every other export above
 * either reads, or writes a field on something that already exists. Before
 * this, nothing in the whole package could make a layer exist except typing
 * JSON into `ManifestEditor.tsx`'s textarea; that was the biggest single gap
 * `docs/notes/motion-tab-audit.md` found.
 *
 * Placement is decided by the catalog, not the caller: a `in3d` primitive is
 * a three.js object and only means anything under `<Scene3D>`, so it goes
 * into `scene.scene3d.children` — creating the `scene3d` container (with the
 * minimum valid camera, since `cam3dKey[]` is `.min(1)`) if the scene has
 * none. A 2D primitive goes into `scene.layers`, likewise created if absent.
 * Appending, not inserting mid-array, because a manifest layer's paint order
 * IS its array order and appending is the only position with no opinion
 * about what should sit on top of what.
 *
 * Returns the new `Manifest` *and* the `Selection` pointing at what was just
 * added, so the caller can select it immediately — the Inspector then shows
 * its fields with no second click, which is the difference between "a layer
 * appeared somewhere" and "here is your new layer, edit it." Returning a
 * bare `Manifest` like the `set*` functions would throw that index away and
 * force the caller to re-derive it.
 *
 * Out-of-range `sceneIndex` is a no-op returning `selection: null` — the
 * same defensive floor every function above holds, since the raw-JSON
 * textarea can shrink the manifest under a stale selection at any time.
 */
/** A short, random layer id (D-158, Phase 3 — "stable layer identity").
 *  Generated ONLY for layers this package creates (`addLayer`, below); a
 *  hand-written or pre-existing manifest simply has no `id` on its layers,
 *  which is the documented, non-breaking fallback `resolveSelection` above
 *  already handles. Not cryptographic — there is no security property to
 *  uphold here, just enough entropy (8 base-36 characters, ~41 bits) that
 *  two layers in the same scene colliding is astronomically unlikely, the
 *  same bar `crates/chroma-timeline`'s own id-generation doc comment sets
 *  for a similar "this just needs to not collide in practice" case. */
function genLayerId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function addLayer(
  manifest: Manifest,
  sceneIndex: number,
  use: PrimitiveUse,
): { manifest: Manifest; selection: Selection | null } {
  if (!manifest.scenes[sceneIndex]) return { manifest, selection: null };

  const next = clone(manifest);
  const scene = next.scenes[sceneIndex];
  const id = genLayerId();
  const fragment = { ...defaultLayerFor(use), id } as unknown as Layer;

  if (catalogEntry(use).in3d) {
    if (!scene.scene3d) scene.scene3d = { camera: DEFAULT_SCENE3D_CAMERA(), children: [] };
    scene.scene3d.children.push(fragment);
    return {
      manifest: next,
      selection: { sceneIndex, target: { kind: 'scene3d-child', index: scene.scene3d.children.length - 1, id } },
    };
  }

  if (!scene.layers) scene.layers = [];
  scene.layers.push(fragment);
  return {
    manifest: next,
    selection: { sceneIndex, target: { kind: 'layer', index: scene.layers.length - 1, id } },
  };
}

/** parses a `kind:'json'` field's textarea content back into a value.
 *  `null` on invalid JSON — the caller keeps the last-good manifest and
 *  surfaces the parse error next to the field, same "never blink the
 *  preview away" contract `useMotionManifest`'s own `applyParse` uses for
 *  the whole document. */
export function parseJsonField(raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

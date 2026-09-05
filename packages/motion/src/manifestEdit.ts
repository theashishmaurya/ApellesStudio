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
import type { Manifest, Scene, Layer, Cam2dKey, Cam3dKey } from '@chroma/motion-engine/src/engine/schema';
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
export function addLayer(
  manifest: Manifest,
  sceneIndex: number,
  use: PrimitiveUse,
): { manifest: Manifest; selection: Selection | null } {
  if (!manifest.scenes[sceneIndex]) return { manifest, selection: null };

  const next = clone(manifest);
  const scene = next.scenes[sceneIndex];
  const fragment = defaultLayerFor(use) as unknown as Layer;

  if (catalogEntry(use).in3d) {
    if (!scene.scene3d) scene.scene3d = { camera: DEFAULT_SCENE3D_CAMERA(), children: [] };
    scene.scene3d.children.push(fragment);
    return {
      manifest: next,
      selection: { sceneIndex, target: { kind: 'scene3d-child', index: scene.scene3d.children.length - 1 } },
    };
  }

  if (!scene.layers) scene.layers = [];
  scene.layers.push(fragment);
  return {
    manifest: next,
    selection: { sceneIndex, target: { kind: 'layer', index: scene.layers.length - 1 } },
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

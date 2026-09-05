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
import { positionFields } from './propCatalog';

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

/** set (or, if `value === undefined`, delete) one field on the layer a
 *  selection points at. No-op (returns the same manifest reference) if the
 *  selection doesn't resolve to a layer — callers already hide the form in
 *  that case, this is a defensive floor, not the primary guard. */
export function setLayerField(manifest: Manifest, selection: Selection, key: string, value: unknown): Manifest {
  const scene = selectedScene(manifest, selection.sceneIndex);
  if (!scene) return manifest;
  const { target } = selection;
  const next = clone(manifest);
  const nScene = next.scenes[selection.sceneIndex];
  let raw: Raw | undefined;
  if (target.kind === 'layer') raw = nScene.layers?.[target.index] as unknown as Raw;
  else if (target.kind === 'scene3d-child') raw = nScene.scene3d?.children[target.index] as unknown as Raw;
  if (!raw) return manifest;
  if (value === undefined) delete raw[key];
  else raw[key] = value;
  return next;
}

/** The `[x,y,w,h]` an `emphasis` layer starts with when a drag has to
 *  invent a width/height (`box` missing or malformed) — D-151's own
 *  `defaultLayerFor('emphasis')` starting box, so a drag never has to guess
 *  a size independently of what "insert an emphasis" already means here. */
const DEFAULT_EMPHASIS_BOX_SIZE = { w: 400, h: 200 };

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
  const scene = selectedScene(manifest, selection.sceneIndex);
  if (!scene) return manifest;
  const { target } = selection;
  const next = clone(manifest);
  const nScene = next.scenes[selection.sceneIndex];
  let raw: Raw | undefined;
  if (target.kind === 'layer') raw = nScene.layers?.[target.index] as unknown as Raw;
  else if (target.kind === 'scene3d-child') raw = nScene.scene3d?.children[target.index] as unknown as Raw;
  if (!raw) return manifest;
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

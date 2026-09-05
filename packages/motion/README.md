# @chroma/motion

**The Motion tab** (D-039, MVP shipped D-046; layer list D-081, Inspector
D-099/D-103, Catalog D-151). A `@remotion/player` embed of
`@chroma/motion-engine`'s `Video` composition (the same component the
`Animation` composition registers), a scene/layer list, a typed property
Inspector, a browsable primitive Catalog that inserts new layers, and a JSON
scene-manifest editor — all validated against the engine's own `zod` schema.
Manifest persistence and rendering go through the `chroma_motion_*` Tauri
commands (`app/src-tauri/src/chroma/motion.rs`) → the `chroma-motion` crate.

## Layout

Four resizable panes (`resizable.tsx`): **preview** · **sidebar** (Layers /
Catalog, two tabs) · **Inspector** · **manifest editor**.

## Files

- `MotionTab.tsx` — the tab: gates on a project being open (same contract
  `@chroma/editor`'s `EditorTab` uses — manifest persistence is
  project-scoped), then lays out the four panes and owns `selections:
  Selection[]` (D-158, Phase 3 of `docs/notes/motion-visual-builder-
  research.md` — was a single `Selection | null`) plus the Phase 0b transient
  drag-preview override.
- `MotionCanvasOverlay.tsx` — on-canvas select/drag (D-156), resize (D-157),
  and marquee-select/shift-click/shared-delta group-move (D-158): a DOM
  sibling of `<Player>` handling four pointer gestures on one surface. See
  its own module doc comment for the full gesture-disambiguation reasoning
  (D-137's "mutually exclusive by DOM position" discipline, applied here).
- `canvasGeometry.ts` — pure screen↔world coordinate math (measure-the-DOM,
  not re-derive-the-camera) plus the marquee's rectangle math
  (`rectFromPoints`/`rectsIntersect`) — kept apart from any DOM-touching
  component so it gets a real unit-test floor.
- `layerMeasure.ts` — the shared "measure a layer's real screen rect from its
  `data-motion-box` descendants" helper, used by the canvas overlay's
  selection outline, "snap to layer," and the marquee's hit-test.
- `motionProjectStore.ts` — **readiness** (B-058/D-150): `projectOpen`, pushed in
  from the composition root (`app/src/main.tsx`), plus where the manifest read
  stands (`idle`/`loading`/`ready`/`error`). A store, not tab-local state,
  because the signal comes from outside this package and the tab is mounted from
  boot. Nothing here infers "no project is open" from a failed read — that
  inference *was* B-058, and is what B-034/D-112 removed from the Edit tab before
  it.
- `useMotionManifest.ts` — the *editing* state: seeds the editor from whatever
  `motionProjectStore` last read (or the engine's sample, for a project with no
  saved manifest yet), live-parses every edit (debounced) against
  `@chroma/motion-engine`'s `manifestSchema`, drives save/render. Component-local
  — nothing outside this tab needs it.
- `MotionPreview.tsx` — the `@remotion/player` embed. `durationInFrames` /
  `fps` / `compositionWidth` / `compositionHeight` come from the engine's own
  `totalFrames`/schema defaults (`build.ts`), not reimplemented here. A
  `flex flex-col` column since D-160: the player + canvas overlay on top,
  `<KeyframeStrip>` fixed-height beneath, always mounted.
- `KeyframeStrip.tsx` — Phase 5a of `docs/notes/motion-keyframe-timeline-
  research.md` (D-160): a small read-only bar under the player showing
  scene-boundary ticks, every camera key (2D + 3D, whole composition) and the
  currently-selected single layer's own `transform.keys`, plus a live
  playhead — click anywhere or a marker to seek. Pure navigation (no
  manifest mutation), so none of D-155's undo/commit plumbing applies. A
  separate strip alongside the untouched `<Player>`, not a modification of
  its own scrub bar — see the file's own doc comment for why (Remotion's
  bundled controls have no extension point, checked directly).
- `LayerList.tsx` — the scene → camera → layers → scene3d-children tree, and
  the `Selection`/`Selection[]` model everything else here binds to (D-081;
  `Selection[]` + `toggleSelection`/`sameSelection`/`resolveSelections`-
  adjacent helpers D-158, Phase 3 — see this file's own module doc comment
  for the same-kind/same-scene multi-select constraint). Since D-160, every
  row that can carry keyframes shows a small trailing key-count badge.
- `InspectorPanel.tsx` — the property form for whatever is selected: typed
  controls per `propCatalog.ts`, a live-validated JSON fallback for nested
  content props, and an add/remove keyframe list (`KeyframeList`, D-099,
  generalized D-159 to also drive the per-layer `TransformKeysSection`
  alongside the original camera-only call sites). Shares its empty state +
  section headings with the Edit tab via `@chroma/inspector` (D-103). For a
  2+ multi-selection (D-158), renders `MultiLayerInspector` instead —
  align/distribute + lockstep Transform/field editing; see its own module
  doc comment for the full design reasoning.
- `propCatalog.ts` — *what fields the Inspector shows* for each `use`,
  transcribed from each primitive's own prop type + `registry.ts`'s adapter.
- `CatalogPanel.tsx` — *what primitives exist and how to add one* (D-151):
  every primitive with a name, description, SVG glyph, and an Add button.
  Glyphs rather than live thumbnails on purpose — see the file header and
  D-151 (three of the eight need their own WebGL context).
- `catalog.ts` — the catalog's data + `defaultLayerFor`, the schema-valid
  default fragment per primitive. Pure, no JSX, so it is `node`-testable.
  Typed `Record<Layer['use'], …>` against the engine's own enum, so adding a
  primitive to the schema without catalogueing it is a `tsc` error.
- `manifestEdit.ts` — the pure manifest read/write layer both the Inspector
  and the Catalog go through. Immutable (`structuredClone`); every function
  degrades to a no-op rather than throwing on a stale selection. `addLayer`
  (D-151) is the only op here that *creates* (and, D-158, stamps a random
  `id` on what it creates). Also: `resolveSelection`/`resolveSelections`
  (id-preferred, index-fallback selection resolution), `moveLayersByDelta`/
  `setFieldOnSelections`/`setTransformFieldOnSelections` (multi-target
  writes composed into one `Manifest`), `alignSelections`/
  `distributeSelections` (D-158, Phase 3), and `layerTransformKeys`/
  `setLayerTransformKeys`/`layerTransformKeyDelta`/`layerDragBase`/
  `upsertLayerTransformKeyXY`/`moveLayersByDeltaAutoKey` (D-159, Phase 4 —
  per-layer keyframes + auto-keyframe-on-drag).
- `keyframeVisibility.ts` — Phase 5a of `docs/notes/
  motion-keyframe-timeline-research.md` (D-160): pure, read-only functions
  for `LayerList.tsx`'s key-count badges and `KeyframeStrip.tsx`'s marker
  positions — `layerKeyCount`/`cameraKeyCount`/`scene3dCameraKeyCount`,
  `cameraKeyMarkers`/`selectedLayerKeyMarkers` (absolute-frame conversion via
  the engine's own `sceneStartFrame`, never a second copy of that math), and
  `frameToPercent`. No manifest mutation, no DOM.
- `ManifestEditor.tsx` — the JSON `<textarea>` + inline parse/save/render
  error surfacing. Still the only way to delete a layer or add a scene.
- `manifestIO.ts` — thin wrappers around the three `chroma_motion_*` Tauri
  commands. Pure I/O, no validation (that's the schema, applied before ever
  calling save/render).
- `resizable.tsx` — a local `react-resizable-panels` wrapper, not
  `@chroma/ui`'s, for the same JSX-conflict reason as `Button.tsx` (D-099).
- `Button.tsx` — a small local button, not `@chroma/ui`'s. See the comment at
  the top of the file / B-008: `@chroma/ui`'s barrel also exports `Text`,
  whose polymorphic typing breaks once `@react-three/fiber`'s global JSX
  augmentation (pulled in transitively via `@chroma/motion-engine`) is in the
  same `tsc` program, and `@chroma/ui`'s `exports` map has no subpath for
  `Button` alone to deep-import around it. Two buttons didn't warrant a
  shared-package edit.

## Deep-importing `@chroma/motion-engine`

`@chroma/motion-engine`'s `package.json` has no `main`/`exports` field (it's
a Remotion CLI project, not built as a library, and is treated as read-only
here) — imports go straight at its source, e.g.
`@chroma/motion-engine/src/engine/Video`. This resolves fine because there's
no `exports` map to sandbox subpath imports; it needs zero changes on the
engine side.

## Tests

`npm test --workspace @chroma/motion` (vitest, `node` environment — the
testable logic here is deliberately kept out of the components, per the
`canvasGeometry.ts`/`layerMeasure.ts` split above). 224 tests across
`canvasGeometry.test.ts`, `manifestEdit.test.ts`, `catalog.test.ts`,
`motionProjectStore.test.ts`, `interpolateKeys.test.ts`, `schema.test.ts`,
and `keyframeVisibility.test.ts` (2026-09-05, D-160).

## Status

Real preview + layer list + Inspector + Catalog + editor + save + render, one
manifest per project — plus, as of D-155–D-159 (2026-09-05,
`docs/notes/motion-visual-builder-research.md`'s Phases 0–4), a real visual
builder: click-select and drag a layer or a multi-selection on the canvas
(world-space, camera-move-safe), resize handles, "snap to layer," a generic
per-layer transform (scale/rotate/opacity/clip), marquee-select +
shift-click, align/distribute actions, undo (`@chroma/history`) for every
Inspector edit and canvas gesture, and per-layer keyframes on the transform
wrapper (`layer.transform.keys`, additive deltas, the same shared
`interpolateKeys` the camera uses, auto-keyframed on a move-drag once a
layer's position is already keyed). Plus, as of D-160 (2026-09-05,
`docs/notes/motion-keyframe-timeline-research.md`'s Phase 5a), real
**key visibility**: a per-row key-count badge in `LayerList`, and a
read-only keyframe strip under the player showing every camera key and the
selected layer's own keys with a live playhead and click-to-seek.

**Known gaps**, most audited in full with citations in
`docs/notes/motion-tab-audit.md` (pre-D-155) and queued as roadmap item 16 —
re-checked against what D-155–D-160 actually closed rather than assumed
stale: no real KEYFRAME TIMELINE UI (Phase 5b of `docs/notes/
motion-keyframe-timeline-research.md` — drag a key along time, per-row
lanes, box-select + nudge multiple keys, a curve/easing editor; D-160's own
strip is read-only navigation, not that), no drag-and-drop from outside the
app, no delete/duplicate of a layer from the GUI, no multi-manifest per
project (D-046), no snapping GUIDES while dragging (D-158's own explicit
scope-down), no group RESIZE for a multi-selection (single-selection only),
and **no MCP tools at all** — Motion is the one tab an agent cannot drive.
The Catalog (D-151) closed the largest GUI-creation gap; D-155–D-159 closed
the largest on-canvas-manipulation gap; D-160 is the first step toward
actually SEEING the animation, not the whole of it.

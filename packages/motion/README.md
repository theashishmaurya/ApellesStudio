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
  project-scoped), then lays out the four panes and owns the `Selection`.
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
  `totalFrames`/schema defaults (`build.ts`), not reimplemented here.
- `LayerList.tsx` — the scene → camera → layers → scene3d-children tree, and
  the `Selection` model everything else here binds to (D-081).
- `InspectorPanel.tsx` — the property form for whatever is selected: typed
  controls per `propCatalog.ts`, a live-validated JSON fallback for nested
  content props, and an add/remove camera-keyframe list (D-099). Shares its
  empty state + section headings with the Edit tab via `@chroma/inspector`
  (D-103).
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
  (D-151) is the only op here that *creates*.
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
testable logic here is deliberately kept out of the components). 57 tests
across `manifestEdit.test.ts` and `catalog.test.ts`.

## Status

Real preview + layer list + Inspector + Catalog + editor + save + render, one
manifest per project.

**Known gaps**, audited in full with citations in
`docs/notes/motion-tab-audit.md` (2026-09-05) and queued as roadmap item 16:
no on-canvas manipulation (positions are typed, not dragged), no drag and
drop, no scene/layer timeline UI, no undo/redo (D-052 deferred Motion), no
delete/duplicate of a layer from the GUI, no multi-manifest per project
(D-046), and **no MCP tools at all** — Motion is the one tab an agent cannot
drive. The Catalog (D-151) closed the largest of these: before it, nothing in
this package could make a layer exist except hand-typed JSON.

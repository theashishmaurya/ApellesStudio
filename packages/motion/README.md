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
Catalog, two tabs) · **Inspector** · **manifest editor**. As of D-162, the
preview pane is itself a nested VERTICAL split — the `@remotion/player`
preview on top, the per-row **keyframe timeline** full-width beneath it,
independently resizable — mirroring `@chroma/editor`'s own
`PreviewPane`/`TimelinePane` stack (see `KeyframeTimeline.tsx`'s own module
doc comment for the full layout reasoning and why D-160's `KeyframeStrip`,
squeezed inside the preview component itself, didn't survive becoming a
per-row lane timeline).

## Files

- `MotionTab.tsx` — the tab: gates on a project being open (same contract
  `@chroma/editor`'s `EditorTab` uses — manifest persistence is
  project-scoped), then lays out the four panes and owns `selections:
  Selection[]` (D-158, Phase 3 of `docs/notes/motion-visual-builder-
  research.md` — was a single `Selection | null`) plus the Phase 0b transient
  drag-preview override. D-162 nests a vertical `PanelGroup` inside the
  preview pane (`<MotionPreview>` over `<KeyframeTimeline>`) — see the
  Layout section above.
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
  `totalFrames`/schema defaults (`build.ts`), not reimplemented here. Back to
  its pre-D-160 shape as of D-162 — just the player + `MotionCanvasOverlay`,
  no opinion about a keyframe timeline at all (moved out to
  `KeyframeTimeline.tsx`, now a `MotionTab.tsx`-level sibling panel — see the
  Layout section above and that file's own doc comment for why).
- `KeyframeTimeline.tsx` — Phase 5b of `docs/notes/
  motion-keyframe-timeline-research.md`: a real per-row keyframe timeline.
  As of D-162 ("per-row lanes"), one row per keyed 2D camera, keyed layer, or
  keyed 3D camera (`keyframeVisibility.ts`'s `keyframeLanes` — rows
  appear/disappear as keys are added/removed, `LayerList`'s own row order), a
  shared horizontal time ruler (`timelineRuler.ts`'s reimplemented "nice
  numbers" tick algorithm) with independent zoom (`timelineZoom.ts`, new
  bounds — not the Edit tab's own D-134 system), a combined
  vertical+horizontal scroll region (sticky row labels + a sticky ruler, the
  standard "frozen row/column" technique, no virtualization library needed
  at these row counts), per-row click-to-select (reuses `MotionTab.tsx`'s
  own `onSelect` — no parallel selection mechanism), and D-161's drag-a-key
  gesture generalized to work per-row. As of D-163 ("box-select + nudge
  multiple keys"), also: a NEW `KeySelectionEntry` model
  (`keyframeVisibility.ts`, `{lane, keyIndex}`, local to this component,
  distinct from `Selection[]`) — shift-click a marker to toggle it in/out,
  or drag a rubber-band over empty track space to box-select every marker
  the rectangle catches (`keysInMarqueeRect`, pure geometry, no per-marker
  DOM measurement); dragging any ONE selected key when 2+ are selected
  nudges the whole group by one shared `deltaSeconds`
  (`manifestEdit.ts`'s `moveKeysByDelta`, the keyframe analog of D-158's
  `moveLayersByDelta`). See the file's own module doc comment for the full
  layout decision (why this moved out of `MotionPreview.tsx`) and the
  gesture-disambiguation/drag-identity reasoning inherited from D-161/162,
  plus this pass's own box-select/nudge design calls.
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
  per-layer keyframes + auto-keyframe-on-drag), and `moveKeyAt`/
  `moveLayerTransformKeyAt`/`moveCamera2dKeyAt`/`moveCamera3dKeyAt` (D-161,
  Phase 5b part 1 — the write primitive that moves a key's `at`: one generic
  core over the three key-array shapes, reorders past a neighbor rather than
  clamping, boundary-clamps to `[0, scene.dur]`), and `moveKeysAt`/
  `moveKeysByDelta`/`KeyMoveTarget` (D-163, Phase 5b part 3 — the multi-key
  generalization: `moveKeysAt` moves N keys sharing ONE array by a shared
  delta from each one's own remembered base in a single pass, avoiding a
  real correctness trap N sequential `moveKeyAt` calls would hit;
  `moveKeysByDelta` groups a `KeyMoveTarget[]` by which array each key
  shares and threads the results into ONE `Manifest`, the keyframe analog of
  `moveLayersByDelta` — cross-lane/cross-scene spanning allowed, each key
  clamps to its own scene's duration independently).
- `keyframeVisibility.ts` — pure functions for `LayerList.tsx`'s key-count
  badges (`layerKeyCount`/`cameraKeyCount`/`scene3dCameraKeyCount`, D-160)
  and `KeyframeTimeline.tsx`'s row layout + marker positions. D-162 retired
  the flat-strip functions (`cameraKeyMarkers`/`selectedLayerKeyMarkers`) in
  favor of the per-row model: `keyframeLanes` (which rows exist, in what
  order — one per keyed camera/3D-camera/layer, `LayerList`'s own row
  order), `laneKey` (a lane's stable string identity), `laneKeyMarkers` (one
  lane's own keys as absolute frames — any keyed layer's, not just the
  selected one, a real capability improvement), and `selectionForLane` (a
  lane → the `Selection` `MotionTab.tsx`'s `onSelect` takes, including the
  layer's own `id` snapshot). `frameToPercent`/`percentToFrame` (D-161's
  pointer-position↔frame conversions, unchanged) and `sceneBoundaryFrames`
  (D-160) carry over as-is — zoom doesn't affect them since they're
  percent-of-track-width, and every lane's track renders at the same
  zoomed width (`timelineZoom.ts`'s `trackWidthPx`). D-163 (Phase 5b part
  3 — box-select + nudge) adds: `laneKeyAtSeconds` (a key's exact,
  unrounded `at`, a nudge's own drag-start snapshot), the `KeySelectionEntry`
  model (`{lane, keyIndex}`) with `sameKeySelectionEntry`/
  `toggleKeySelectionEntry`/`unionKeySelectionEntries`, and the marquee's own
  pure geometry — `keyMarkerContentRect`/`keysInMarqueeRect`, which reuse
  `canvasGeometry.ts`'s `rectsIntersect` directly and need NO per-marker DOM
  measurement at all (D-162's per-row layout is already fully known from
  pure numbers). No manifest mutation, no DOM (this file stays framework-
  agnostic; `KeyframeTimeline.tsx` owns the one DOM measurement the marquee
  needs — the scrollable content div's own rect).
- `timelineRuler.ts` — D-162: a REIMPLEMENTATION (not an import — `@chroma/
  motion` cannot depend on `@chroma/editor`) of `packages/editor/src/
  ruler.ts`'s "nice numbers" tick-density algorithm
  (`niceTickIntervalSeconds`/`formatTimecode`), plus `rulerTicks` (the
  ruler's own tick list for one render, given the total duration/fps/zoom).
- `timelineZoom.ts` — D-162: `KeyframeTimeline.tsx`'s own zoom mechanism —
  `pxPerSecond` bounds/stepping new to this file, deliberately NOT reused
  from `ruler.ts`'s D-134 system (that one's bounds bracket a Rust-side
  video-thumbnail decimation ladder with no equivalent here) — and
  `trackWidthPx`, the "how many frames map to how many pixels" math every
  lane's track and the ruler render at.
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
`canvasGeometry.ts`/`layerMeasure.ts` split above). 334 tests across
`canvasGeometry.test.ts`, `manifestEdit.test.ts` (D-161 adds `moveKeyAt`/
`moveLayerTransformKeyAt`/`moveCamera2dKeyAt`/`moveCamera3dKeyAt`; D-163
adds `moveKeysAt`/`moveKeysByDelta`, including a dedicated test proving the
sequential-call correctness trap doesn't happen and one proving each key
clamps to its own scene independently), `catalog.test.ts`,
`motionProjectStore.test.ts`, `interpolateKeys.test.ts`, `schema.test.ts`,
`keyframeVisibility.test.ts` (D-160/D-161/D-162 — the per-row `keyframeLanes`/
`laneKey`/`laneKeyMarkers`/`selectionForLane` tests replaced the old
flat-strip ones; D-163 adds `laneKeyAtSeconds`, the `KeySelectionEntry`
model's toggle/union helpers, and `keyMarkerContentRect`/`keysInMarqueeRect`),
`timelineRuler.test.ts` (D-162, the reimplemented tick algorithm — mirrors
`ruler.test.ts`'s own coverage, plus `rulerTicks` itself), and
`timelineZoom.test.ts` (the zoom mechanism's bounds/stepping/pixel-width
math; D-163 adds `pxDeltaToSeconds`, the nudge gesture's own pixel→time
conversion). `KeyframeTimeline.tsx`'s marquee/nudge pointer wiring is
DOM/pointer-event plumbing and deliberately untested, the same split every
canvas/timeline gesture in this package already follows — the pure geometry
and write logic it calls is what carries the coverage.

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
**key visibility**, and D-161 (same day, Phase 5b part 1), **drag a key to
retime it**. As of D-162 (Phase 5b part 2), the flat single-strip timeline
became a real **per-row lane timeline**: one row per keyed 2D camera,
layer, or 3D camera (`LayerList`'s own row order), a shared ruler with
independent zoom, per-row click-to-select, and D-161's drag gesture
generalized so any keyed layer's keys can be dragged without first
selecting that layer. As of D-163 (Phase 5b part 3, same day), the timeline
also has **box-select + nudge multiple keys**: a new per-key selection
model (`KeySelectionEntry`, distinct from `Selection[]`), shift-click to
extend it, a rubber-band drag over empty track space to box-select, and
dragging any one selected key when 2+ are selected nudges the whole group
by a shared time delta — cross-lane/cross-scene selections allowed, each
key clamping to its own scene's duration independently at a boundary.

**Known gaps**, most audited in full with citations in
`docs/notes/motion-tab-audit.md` (pre-D-155) and queued as roadmap item 16 —
re-checked against what D-155–D-163 actually closed rather than assumed
stale: Phase 5b's last piece still unbuilt (`docs/notes/
motion-keyframe-timeline-research.md` — a curve/easing editor; D-163 closed
"box-select + nudge multiple keys"), no drag-and-drop
from outside the app, no delete/duplicate of a layer from the GUI, no
multi-manifest per project (D-046), no snapping GUIDES while dragging
(D-158's own explicit scope-down), no group RESIZE for a multi-selection
(single-selection only), and **no MCP tools at all** — Motion is the one
tab an agent cannot drive. The Catalog (D-151) closed the largest
GUI-creation gap; D-155–D-159 closed the largest on-canvas-manipulation
gap; D-160/D-161/D-162/D-163 are four of four steps toward a real keyframe
timeline — the curve/easing editor remains, Phase 5b's own final piece.

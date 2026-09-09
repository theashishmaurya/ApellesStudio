# Global Inspector — Motion + NLE, one shared panel — scoping (2026-09-03)

Owner, 2026-09-03 (roadmap item 7): both the Motion tab and the Edit (NLE) tab need
real property controls — position/timing/text/camera keyframes for Motion's
primitives, position/scale/rotation/opacity/fades for Edit-tab clips — and the
explicit direction is **one shared Inspector component**, not a Motion-only build.
Remotion's official **Editor Starter** (remotion.dev/docs/editor-starter) is the
reference for section *shape* (Source/Layout/Fill/Video/Audio/Captions), checked and
rejected as a base to build *on* (paid, ~$600, a template to adopt/customize rather
than a component library — real rework either way). This note replaces the "scoped
inline in the roadmap, no dedicated doc yet" placeholder, same role
`multi-track-nle.md` played for Phase D before D-080 landed.

## Current state, verified against the actual code (not assumed)

- **Motion tab has no selection model at all.** `packages/motion/src/MotionTab.tsx`
  renders a `@remotion/player` preview (`MotionPreview.tsx`) next to a raw JSON
  `<textarea>` (`ManifestEditor.tsx`, D-046: "JSON-in, on purpose... the visual-editor
  question open"). There is no layer list, no click-a-layer-to-select-it, no per-scene
  navigation UI — an Inspector needs *something* to be selected before it can show
  properties for it, and nothing today produces a selection. This is the real
  prerequisite gap, bigger than "write property controls": a selection model + a way
  to see/pick a scene or layer has to exist first.
- **The manifest schema is deliberately `.passthrough()` for per-primitive props.**
  `packages/motion-engine/src/engine/schema.ts`'s `layer` schema only types `use` (an
  enum of the 8 registered primitive names), `at`, `dur`, `active` — every
  primitive-specific prop passes through untyped. Confirmed by reading every
  primitive's own inline `React.FC<{...}>` prop type (not exported as a named
  interface anywhere) — see the full extracted catalog below. No backend/schema
  blocker to building this — it's a real, mechanical, one-time transcription task, not
  new engineering.
- **`apelles_timeline::Clip` has zero transform fields.** Confirmed against
  `crates/apelles-timeline/src/lib.rs`'s `Clip` struct: `id`, `shot_id`, `media_id`,
  `name`, `source_path`, `source_start`, `duration`, `source_len`, `start_frame` — no
  `position`/`scale`/`rotation`/`opacity`/`fade_in`/`fade_out`. The NLE half of the
  Inspector needs these fields to exist before it can edit them, and *using* them
  (making a clip actually render scaled/rotated/faded) needs the same real
  pixel-compositing work as Phase B3 of `multi-track-nle.md` (still unbuilt, per
  D-080's own status note) — **not a separate track of work, the same one**. The Edit
  half of the Inspector is genuinely blocked on B3 landing; the Motion half is not.

## The real primitive prop catalog (verified against `packages/motion-engine/src/primitives/*.tsx`, 2026-09-03)

Every primitive's actual inline prop type, transcribed directly from the source (not
the manifest's terse/adapted form `registry.ts` maps from — see that file for the
`at`/`dur` (seconds) → `start`/`dur` (frames) and other manifest-shape adaptations).
This is the schema-extraction pass the roadmap called for.

- **Text** (`Text.tsx`): `children: string` (required — manifest's `text:` field, see
  `registry.ts`'s adapter), `preset?: 'fade-up'|'mask-up'|'type'|'stroke-on'`,
  `start?`, `dur?`, `size?`, `color?`, `weight?`, `font?`,
  `align?: 'left'|'center'|'right'`, `letterSpacing?: string`, `x?`, `y?`,
  `maxWidth?`, `caret?: boolean`.
- **Emphasis** (`Emphasis.tsx`): `preset?: EmphasisPreset` (see the file for the enum),
  `start?`, `dur?`, `color?`, `box?: {x,y,w,h}` (manifest's `box: [x,y,w,h]` tuple,
  adapted), `children?`, `seed?: number`.
- **Matrix** (`Matrix.tsx`): `rows: number`, `cols: number` (required), `cell?`,
  `gap?`, `preset?: MatrixPreset`, `start?`, `dur?`, `values?: number[][]`,
  `highlight?: {r,c,at,dur?}[]`, `fillDir?: 'row'|'col'`, `accent?`, `x?`, `y?`.
- **Graph** (`Graph.tsx`): `nodes: GraphNode[]` (`{id, label?, x?, y?}`),
  `edges: GraphEdge[]` (`{from, to, directed?}`) — both required, `pulses?:
  GraphPulse[]` (`{from,to,at,dur?,color?}`), `highlight?: GraphHighlight[]`
  (`{id,at,dur?}`), `enter?: {at,stagger}`, `nodeR?`, `seed?`, `width?`, `height?`.
- **Scene3D** (`Scene3D.tsx`, several exports, all real Inspector targets):
  - `Scene3D` (the R3F canvas root): `camera: CamKey[]` (required, `{at, pos:
    [x,y,z], look?: [x,y,z]}`), `children`, `fov?`.
  - `Glow`: `position?: [x,y,z]`, `radius?`, `color?`, `strength?`.
  - `LabelBox`: `position?: [x,y,z]`, `size?: [w,h,d]`, `color?`, `emissive?`,
    `emissiveIntensity?`.
  - `LayerStack`: `count?`, `gap?`, `size?: [w,h]`, `position?: [x,y,z]`, `active?:
    number`, `lift?`.
- **ParticleFlow** (`ParticleFlow.tsx`): `preset: 'stream'|'converge'|'disperse'`
  (required), `count?`, `start?`, `dur?`, `from?: Vec3`, `to?: Vec3`, `shape?:
  'sphere'|'ring'|'grid'`, `shapeSize?`, `center?: Vec3`, `scatter?`, `color?`,
  `size?`, `seed?`.
- **Layers** (`Layers.tsx`): `items: LayerItem[]` (`{label, sublabel?}`, required),
  `start?`, `stagger?`, `active?: number`, `callout?: string`, `x?`, `y?`, `cardW?`,
  `cardH?`, `gap?`, `tilt?`.
- **Camera** (`Camera.tsx`, the 2D scene camera, distinct from `Scene3D`'s 3D one):
  `keys: CameraKey[]` (required, `{at, x?, y?, zoom?, ease?: [n,n,n,n]}`), `children`,
  `drift?: boolean`.
- **postfx** (`postfx.tsx`, scene-level, not per-layer — applied via the top-level
  `grain`/`vignette` manifest fields, not a `use:` entry): `FilmGrain`
  (`opacity?`, `scale?`), `Vignette` (`strength?`).

8 primitives registered in `registry.ts` (`text`, `emphasis`, `matrix`, `graph`,
`layers`, `particleflow`, `labelbox`, `layerstack` — `labelbox`/`layerstack` are
`Scene3D.tsx`'s exports, registered as `scene3d` children) + the 2D `Camera`/`Glow` +
scene-level `postfx` — a real, complete list, not "7ish."

## The phased build

### Phase 1 — Selection model + layer list (Motion half's real prerequisite)

**Done, D-081 (2026-09-03).** A plain `Selection` type (`{sceneIndex, target}`, local
`useState` in `MotionTab.tsx` — the same "no dedicated store package" shape
`TimelinePane.tsx`'s own `Selection`, D-080, established as the right weight for this)
+ `LayerList.tsx`, a real expand-per-scene sidebar: scene → its 2D camera (if any) →
`layers[]`, or its `scene3d` camera + `children[]` for a 3D scene. Selecting a row
seeks the player (`@remotion/player`'s own `PlayerRef.seekTo`) to that scene's start
frame via new `sceneStartFrame`/`sceneDurationFrames` helpers in `build.ts` — the
exact math `<Series>` (`Video.tsx`) already uses to lay scenes back to back, not a
second guess at it. Real, standalone-useful scene/layer navigation even before Phase
2 exists. Click-to-select directly on the `MotionPreview` canvas (needs each
primitive to report its own screen-space bounds back to the player wrapper — Remotion
doesn't do this for you) stays a separate, unbuilt stretch.

### Phase 2 — Property panel bound to the selection, Motion half only

Once Phase 1 exists: a real form (not raw JSON) editing whatever's selected, built
against the verified prop catalog above — grouped roughly the way the rejected
Editor Starter's own section shape suggests as a *reference*, not copied
(Source-equivalent: preset/content; Layout: x/y/size; Fill: color/accent; Timing:
start/dur/active) — reading/writing directly into the manifest text `ManifestEditor`
already parses/holds, not a second source of truth. Independent of the NLE half and
of Phase B3 — this is the unblocked piece the roadmap flagged as having "no backend
blocker."

### Phase 3 — NLE half (Edit-tab clip properties)

**Blocked on Phase B3** (`multi-track-nle.md`) — needs `apelles_timeline::Clip` to
actually grow `position`/`scale`/`rotation`/`opacity`/`fade_in`/`fade_out` fields
*and* the real GPU compositing work to make them do anything when rendered, which is
B3's own job, not a separate one. Scoping the exact field set is cheap and could be
done ahead of B3 landing; building the Inspector UI for it before B3 exists would
mean editing fields nothing renders yet — not worth doing first.

### Phase 4 — Shared panel shell

Once both halves have real content to show, the actual "one shared component, not
two" framing (a tab-aware container swapping Motion-selection vs. NLE-clip-selection
content into the same panel chrome) is comparatively mechanical — deferred until
there's real content on both sides to unify, so it isn't designed against a guess.

## Sequencing

**Phase 1 is the right next increment** — genuinely unblocked, small, and exactly the
"selection model + layer list" gap nothing else in this codebase has built yet
(`TimelinePane.tsx`'s own `Selection` type, D-080, is the closest existing precedent:
`{track, id}`, a plain local `useState`, no dedicated store package — Motion's
equivalent is likely just as simple, scoped to whichever scene is currently visible in
the player). **Phase 2 rides directly on Phase 1** and is where the real prop-catalog
work above gets consumed. **Phase 3 stays blocked on B3** — don't start the NLE half's
UI before the fields it would edit exist and render. **Phase 4** (the actual "shared
panel" unification) is last on purpose, once there's real content on both sides.

## Status

Scoped 2026-09-03 (D-080's own session, after Phase D shipped). **Phase 1 done,
D-081 (2026-09-03)** — real selection model + layer list, wired to seek the player.
**Phase 2 done, D-099 (2026-09-04)** — `InspectorPanel.tsx` + `propCatalog.ts` +
`manifestEdit.ts`, a real typed form bound to the selection, verified against a
real manifest (backward-compat requirement) via a scratch harness.

**Phase 3 done, D-102 (2026-09-04)**, once `TimelinePane.tsx` freed up after the
concurrent D-094–D-100 drag-and-drop work committed — `ClipInspectorPanel.tsx`, a
real persistent panel for the selected clip's transform (opacity/position_x/
position_y/scale/rotation — this doc's original field list named `fade_in`/
`fade_out`, which turned out not to exist on the real, shipped `Clip`; corrected
here) and keyframes, added as a third pane in `TimelinePane.tsx`'s existing
`ResizablePanelGroup`. **D-090's popover was removed, not kept alongside** — same
fields/ops, a persistent panel is strictly better UX, two controls risking drift
for no benefit; this is the real call this doc's Phase 3 section always deferred
to whoever built it. `Selection` stayed local to `TimelinePane.tsx` (embedded, not
lifted) — the actual cross-tab-shared shell is still Phase 4's job, now unblocked
since both halves have real content. Backward compatibility verified three ways: a
scratch harness (missing fields / locked track / real keyframes), and the owner's
own real `~/Movies/Chroma/New.chroma/project.json`, confirming the panel's
`?? default` fallbacks match what a real save on disk actually looks like.

**Phase 4 done, D-103 (2026-09-04).** The real "how shared is shared" call, made
explicitly rather than left implicit: a genuinely merged, single polymorphic
Inspector component was rejected — Motion's selection (a `Manifest` +
scene/layer/camera target) and the NLE's (a `Clip` + track/id) differ enough in
shape and edit operations that forcing them through one component would mean
rewriting two already-working, already-tested panels for no real user-facing
benefit, exactly the risk this doc's own Phase 4 section flagged in advance
("don't force a deeper unification than is actually clean"). Instead: a new tiny
package, **`@apelles/inspector`** (`packages/inspector/`), holding only the pieces
`InspectorPanel.tsx` and `ClipInspectorPanel.tsx` had genuinely, independently
converged on byte-identical — the "nothing selected" empty state and the
section-heading typography — as `InspectorEmptyState`/`InspectorSection`. A
separate package, not `@apelles/ui`, because `@apelles/motion` cannot depend on
`@apelles/ui` at all (the `@react-three/fiber` JSX-typing conflict `Button.tsx`/
`resizable.tsx` already documented) — putting shared chrome there would have made
it unusable from Motion's side. The resizable-panel wrapping was deliberately
**not** unified: `@apelles/editor` correctly uses `@apelles/ui`'s real
`ResizablePanel` (no conflict on that side), `@apelles/motion` uses its own local
motion-safe wrapper; a third shared wrapper would have meant either downgrading
the editor away from the real component it already correctly uses, or
reintroducing the JSX conflict into Motion — neither is an improvement.
`Selection` was **not** lifted to a shared, tab-agnostic store either —
`Shell.tsx` (read directly, not assumed) already keeps every tab permanently
mounted and just hides inactive ones via CSS, so a per-tab-local selection
already behaves exactly like a cross-tab shared one from the user's side; there
was no real gap lifting state would have closed, and this project's own "don't
build for hypothetical future requirements" rule argued against doing it anyway.
Verified live: both panels re-rendered and interacted with side by side in a
scratch harness after the refactor — Motion layer selection and NLE clip
selection both still populate and edit correctly, now sharing visually
consistent section headings. `tsc` clean across `packages/inspector`/`motion`/
`editor`/`app`; 18/18 + 91/91 tests unchanged (a pure presentational extraction).

**Post-Phase-4 layout follow-up, D-118 (2026-09-04) — the NLE half's own panel
moved from a nested pane to a full-height sibling, within `@apelles/editor`
only.** Owner: "move the clip editor like source control full height instead
of being in the timeline." Not a Phase 4 revision — this doesn't touch
`@apelles/inspector`, the shared empty-state/heading pieces, or cross-tab
selection sharing (still correctly *not* lifted, per this doc's own Phase 4
finding above). It's a narrower, tab-internal move: `ClipInspectorPanel`
(unchanged) is now rendered by a new `EditorInspectorPanel.tsx` sibling of
`TimelinePane.tsx`, in `EditorTab.tsx`'s own top-level `ResizablePanel`
spanning the Edit tab's real full height, instead of a third pane nested
inside `TimelinePane`'s split (which was capped at the timeline row's 46%
height — the real cause of "in the timeline"). `Selection`/`selectedGap`
moved from `TimelinePane`'s local `useState` into `useEditorTimelineStore`
— still within `@apelles/editor`, still per-tab, just no longer trapped
inside one specific child component of that tab. See D-118's own decision
entry for the real "stayed tab-local, not shell-level" call.

**All 4 phases of the Global Inspector are now done.** This note stays as the
historical scoping + phase record.

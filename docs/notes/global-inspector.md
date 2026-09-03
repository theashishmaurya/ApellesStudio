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
- **`chroma_timeline::Clip` has zero transform fields.** Confirmed against
  `crates/chroma-timeline/src/lib.rs`'s `Clip` struct: `id`, `shot_id`, `media_id`,
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

**Blocked on Phase B3** (`multi-track-nle.md`) — needs `chroma_timeline::Clip` to
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
**Phase 2 (property panel) is the natural next increment** — the prop catalog above
is already extracted, Phase 1's selection is real and live. **Phase 3 (NLE half)
stays blocked on Phase B3** (`multi-track-nle.md`). **Phase 4 (shared panel shell)**
waits on both halves having real content. This note is the scoping record — update
it (or promote pieces into `D-NNN` entries) as each phase actually lands.

# @apelles/motion-engine

The Remotion motion engine for Apelles' **Motion tab** — data-driven motion
primitives + a JSON scene-manifest compiler, in the locked "dark Excalidraw"
look.

## Provenance

**Moved in from `videoAgent/engine/motion/` on 2026-09-02 (D-039).** This copy
is now canonical; **the `videoAgent` copy is stale — the user should delete
`~/my_projects/videoAgent/engine/motion/`.** The design reference still lives in
videoAgent: `engine/catalog.md`, `engine/DESIGN.md`, and the
`.claude/skills/motion-primitives/` + `.claude/skills/animate/` skills. Those
were not copied; port or re-point them if that knowledge is needed in Apelles.

## Layout

```
src/
  design.ts            ← locked design tokens (colours, stroke feel, type, easing)
  engine/
    build.ts           ← the JSON scene-manifest compiler
    schema.ts / registry.ts / Video.tsx / sample.ts
  primitives/          ← text, emphasis, matrix, graph, layers, scene3d, particleflow,
                         deviceframe, claudechat (D-258 — the phone chrome and the
                         Claude app UI, decoupled: they agree on a screen rect,
                         neither requires the other)
  compositions/        ← *Demo compositions (living primitive references)
  lib/  helpers/        ← deterministic roughjs + frame helpers, device geometry
                         (device.ts) and chat thread layout/scheduling (chatLayout.ts)
  Root.tsx             ← registers compositions
```

## Commands

```bash
npm run dev                                   # Remotion studio
npx remotion render Animation out.mp4 --props=manifest.json
npx tsc --noEmit                               # typecheck
```

## Status (D-039)

Moved in verbatim (minus `node_modules` / `out/` / `.git` / its own
`package-lock.json` — the workspace install uses the root lock). Not yet wired
to `@apelles/motion` or the Tauri app — that is a later migration step.

## Determinism rules

Remotion renders each frame independently — same frame must produce same pixels.

- roughjs: always pass a fixed `seed` (helpers default to one).
- Any layout solver (d3-force, etc.): freeze the result once, don't run per frame.
- No `Math.random()` / `Date.now()` in render paths — derive from `useCurrentFrame()`.

## DOM contract (D-155)

`@apelles/motion`'s canvas overlay (`MotionCanvasOverlay.tsx`, Phase 1 of
`docs/notes/motion-visual-builder-research.md`) is a real, documented
cross-package dependency on this engine's rendered DOM shape — not a lucky
selector some component happens to work against today. Three attributes,
all pure additions with **zero pixel/visual change**:

- **`data-motion-world`** — on the camera's transformed container
  (`primitives/Camera.tsx`, the inner `<AbsoluteFill>` that actually carries
  `transform: translate(...) scale(...)`), and on a camera-less 2D scene's
  own root (`engine/Video.tsx`'s `TwoD`, when `scene.camera` is empty/absent).
  `getBoundingClientRect()` on this element gives the exact, ALREADY-composed
  screen↔world scale + origin — the player's fit-scale times the camera's
  zoom, plus its translate and ambient drift — with no need for a consumer
  to re-read `scene.camera`, re-sort its keys, or re-run its easing. See the
  research doc §3a ("measure the live DOM, don't re-derive the camera") for
  the full reasoning; `@apelles/motion`'s `canvasGeometry.ts` is the pure math
  built on top of a measurement taken this way.
- **`data-motion-layer="<sceneIndex>.<layerIndex>"`** — on a wrapper `<div
  style={{display:"contents"}}>` around each 2D layer in `renderLayers`
  (`engine/Video.tsx`). `display: contents` makes the wrapper invisible to
  both layout and absolute positioning (a primitive's own `position:
  absolute` still resolves against the SAME ancestor it always did), so this
  costs nothing visually — but note `getBoundingClientRect()` on a `display:
  contents` element itself always returns a zero rect; a consumer walks UP
  from an actual hit (`Element.closest('[data-motion-layer]')`, which
  ignores `display` entirely) rather than querying this element's own rect.
  Only `scene.layers` (2D) gets this — `scene.scene3d.children` never does;
  3D on-canvas manipulation is out of scope for every phase of the research
  doc (§3b/§4), so there is deliberately nothing here to select via the DOM.
- **`data-motion-box`** — on each primitive's own genuinely tight, visible
  element(s), where one exists. A generic layer wrapper's rect (or even a
  primitive's own outermost element) is NOT always a usable selection box —
  several primitives render a full-canvas `inset:0` `<svg>` and the real
  shape is a descendant. Per primitive, verified against the source this
  pass (research doc §3b):

  | Primitive | Tight element(s) | Hook |
  |---|---|---|
  | `text` (`Text.tsx`) | the positioned wrapper `div` itself (real text metrics) | on that `div`, all 4 presets |
  | `matrix` (`Matrix.tsx`) | the outer `<svg>` — already sized `width={w} height={h}` to the grid's real footprint, not `inset:0` | on that `<svg>` |
  | `layers` (`Layers.tsx`) | the stack container has NO size of its own (only absolutely-positioned children) — each card `<div>` is the real box | on each card `<div>`; a consumer unions them |
  | `emphasis` (`Emphasis.tsx`), `ring`/`scribble` only | the `<svg>` is `inset:0` (the whole canvas); the `<path>` inside it is the drawn shape | on that `<path>` |
  | `emphasis`, `pulse`/`glow` | no `box` concept at all (wraps `children`) | none — falls back to "whole canvas" |
  | `graph` (`Graph.tsx`) | the outer `<svg>` defaults to spanning the full canvas/layout box, not the actual node cluster — no tight rect exists at this primitive's own level | none — an honest "whole canvas" fallback, not a gap to close casually |

  A consumer with none of these for a given layer falls back to the layer
  wrapper's first rendered child (`layerEl.firstElementChild`) — for `graph`
  and `emphasis`'s `pulse`/`glow`, that IS the whole-canvas `<svg>`/`div`, an
  intentional, documented degradation rather than a crash.

## Layer transform wrapper (D-157)

`schema.ts`'s `layer` object carries an optional `transform` field
(`{x?, y?, scale?, rot?, opacity?, clipWidth?, clipHeight?}`, additive —
`.optional()` on the field itself, so absent means identity). When present,
`Video.tsx`'s `renderLayers` inserts one real `position:absolute` `<div>`
between the (still `display:contents`) `data-motion-layer` wrapper and the
primitive itself, carrying a CSS `transform`/`opacity` — **on top of the
primitive's own positioning, never replacing it.** When `transform` is
absent (every manifest written before this pass, and most written after it),
`renderLayers` emits the exact same JSX it always did — verified
byte-for-byte identical via `remotion still` at three frames of the engine's
own sample manifest, before vs. after this schema change (D-157's own
decision entry has the shasum/`cmp` output).

Two things worth knowing before reaching for this:

- **`transformOrigin: "0 0"`**, matching `Camera.tsx`'s own convention on the
  same kind of transform — `scale`/`rot` pivot at the wrapper's own origin
  (world `(0,0)`, the canvas top-left for the common full-bleed case), NOT
  the layer's own authored position. Scaling or rotating a layer that sits
  away from `(0,0)` will make it appear to swing/fly rather than pivot in
  place unless you also set `x`/`y` to compensate — the same discipline a
  camera key already needs (`x`/`y` + `zoom` together to keep a target point
  fixed). Pivoting around a primitive's own reported anchor instead would
  need this ENGINE package to know per-primitive position semantics that
  belong to `@apelles/motion`'s `propCatalog.ts` (`positionFields`) — the
  wrong dependency direction (`@apelles/motion` depends on this package,
  never the reverse) — so it's a known, documented scope call, not an
  oversight.
- **`clipWidth`/`clipHeight`** are the research doc's own "crop, honestly"
  call (`docs/notes/motion-visual-builder-research.md` §4 Phase 2): NOT the
  Edit tab's four-inset crop model (most Motion primitives have nothing
  analogous to a decoded video rectangle to inset) — the one real, small
  equivalent, clip-to-box via `overflow: hidden` on this same wrapper. Both
  absent (the common case) ⇒ no clipping at all.
- **A drag/resize gap, disclosed rather than silently left:** `@apelles/
  motion`'s `MotionCanvasOverlay.tsx` measures its screen↔world map off
  `[data-motion-world]` alone (the camera's own transform). A layer that ALSO
  carries a non-identity `transform` sits behind an EXTRA transform this map
  doesn't account for, so dragging or resizing such a layer on-canvas will be
  slightly off. Nothing existing hits this yet (the wrapper and the
  Inspector fields to set it both land in this same pass); fixing it means
  measuring a per-layer world map instead of one shared map per drag, left
  for whichever future phase actually needs to drag a transformed layer.

## Stable layer identity (D-158)

`schema.ts`'s `layer` object carries an optional `id?: string` (Phase 3 of
`docs/notes/motion-visual-builder-research.md`, "the prerequisite that bites
here: stable layer identity," §1g). Purely additive and NOT read anywhere in
the render path (`Video.tsx` never looks at it) — its presence or absence has
zero effect on a rendered frame, verified with byte-for-byte `remotion still`
renders of the engine's own sample manifest before/after the schema change,
plus a smoke render with an id actually set on a real layer (all identical).

`@apelles/motion`'s `addLayer` (D-151) stamps a short random id on every layer
it creates from here on; a hand-written or pre-existing manifest simply has no
`id`, which `@apelles/motion`'s `resolveSelection`/`resolveSelections`
(`manifestEdit.ts`) treat as the fully-supported, non-breaking default —
falling back to positional identity (the array index) exactly as this package
did before `id` existed. When an `id` IS present, a selection built from it
survives a reorder/insert/delete elsewhere in the layer array (a hand-edit in
`ManifestEditor.tsx`'s raw-JSON textarea, most concretely) instead of silently
pointing at whatever now happens to sit at the old index.

## Per-layer transform keyframes + the shared `interpolateKeys` (D-159)

The [layer transform wrapper](#layer-transform-wrapper-d-157) above gains an
optional `keys: TransformKey[]` (`{at, x?, y?, scale?, rot?, opacity?, ease?}`,
`at` in SECONDS like `cam2dKey`) — the manifest's SECOND authored spatial
animation channel, after the camera. Purely additive: absent `keys` renders
byte-identically to before this pass (verified via `remotion still`, D-159's
own decision entry).

**Every field is a DELTA on top of the STATIC `layerTransform` field of the
same name**, uniformly across all five (not a per-field mix of additive/
multiplicative rules) — an unset delta always defaults to `0`, so an
all-default key and an absent `keys` array behave identically by
construction. See `schema.ts`'s own `layerTransform` doc comment for the full
reasoning, including the tradeoff this implies for authoring a `scale`
animation (deltas off the static scale, not absolute per-key factors).

**`src/lib/interpolateKeys.ts`** is the one shared keyframe interpolator —
sort by `at`, clamp outside the range, ease via `Easing.bezier` between the
two keys surrounding the current frame, linearly interpolate each named field
on that eased `t`. Extracted verbatim from `Camera.tsx`'s own pre-D-159
inline logic (verified byte-for-byte unchanged via `remotion still`) and now
used by BOTH `Camera.tsx` (`x`/`y`/`zoom`) and `Video.tsx`'s `renderLayers`
(`x`/`y`/`scale`/`rot`/`opacity`) — "reuse the camera's own key mechanics,
don't invent a second interpolator," per `docs/notes/motion-visual-builder-
research.md` §4 Phase 4. `@apelles/motion`'s `manifestEdit.ts` ALSO imports
this function directly (a real, sanctioned cross-package value import, the
same kind `MotionPreview.tsx` already makes for `Video`/`totalFrames`) to
compute a drag's "current value" for the auto-keyframe decision below — the
editor's own drag math must agree with what this file renders, or a keyed
layer would visibly jump the instant a drag starts.

**B-059 fixed as part of this phase** (`docs/BUGS.md`): `cam2dKey` and
`cam3dKey` (the SAME gap, found while checking — `Scene3D.tsx`'s `CameraRig`
reads `CamKey.ease` the identical way `Camera.tsx` does, so `cam3dKey`'s
plain `z.object` was silently stripping an authored `ease` there too, despite
that bug's own original text guessing it was harmless) both now declare a
real, typed `ease: easeCurve.optional()` instead of relying on a strict
`z.object`'s default key-stripping to (accidentally) reject typos. The new
`transformKey` uses the same `easeCurve` shape.

**The auto-keyframe drag decision** (Remotion Studio's own cited rule: a drag
writes a keyframe at the current frame when the property is already
keyframed, the static base when it is not) lives in `@apelles/motion`'s
`manifestEdit.ts` (`layerDragBase`/`upsertLayerTransformKeyXY`/
`moveLayersByDeltaAutoKey`), not in this engine package — this package only
needs to RENDER `transform.keys` correctly, which `renderLayers`'s use of
`interpolateKeys` above does regardless of how a key got there (a drag, or a
hand-typed value in the Inspector's keyframe-list editor). See D-159's own
decision entry (`docs/08-decisions.md`) for the full per-property (not
per-layer) reasoning behind that decision, including why it's scoped to the
move-drag's position pair and does not extend to resize.

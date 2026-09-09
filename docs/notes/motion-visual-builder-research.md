# Motion visual builder — on-canvas manipulation under an animated camera — research (2026-09-05)

**Where this came from.** Owner, live, in his own words: *"i would like to drag and drop
multiple elements and set position or change them size crop animation and all those things :)
a visual builder for me and animation as well. where it will animate, all those so we can build
crazy things :) and fix easily, with human in loop."* Then, pointing at a screenshot of a
rendered Motion frame where a red `scribble` emphasis ellipse is circling the wrong words:
*"like here i know the highlight is off, i can move it to right place directly but it should
follow the animation as well :/ so all those things we need a smart way to handle, do some
research."* And, separately, pointing at `ManifestEditor`'s raw JSON textarea: *"scene manifest
as a user i dont need that you will need only, put it behind this kinda button [a `</>` code
icon] I can see but it['s] collapsed."*

**This is a research + scoping pass. No feature code was written.** Two defects found on the
way are recorded as B-060/B-061 and are also not fixed here (§6).

The two closest precedents in this repo, both read in full before this was written, are
`docs/notes/on-canvas-transform.md` (the Edit tab's own on-canvas-manipulation scoping, D-127/
D-132/D-136) and `docs/notes/audio-fade-duck-crossfade-plan.md` (D-147/D-149). This note
follows their shape: verify the code first, answer the load-bearing question, then phase.

**The headline finding, up front, because it reshapes everything after it:** the Motion
engine's coordinate model is **already correct**. It is not the D-136 problem wearing a new
hat. §2 works out what the owner's bug actually is (it is not systemic drift), and §3 gives the
one real technique that makes a drag correct under a moving camera without duplicating a line
of the camera's math.

---

## 1. What exists today, verified by reading the code

Every claim in this section was confirmed by reading the real file this pass.

### 1a. The manifest: a keyframed camera, and layers that are not keyframed at all

`packages/motion-engine/src/engine/schema.ts`, read in full. Confirmed exactly as suspected:

- **`scene.camera` is a real keyframed array** — `z.array(cam2dKey)`, each key
  `{at: number, x?, y?, zoom?}`, `at` in **seconds** (the file's own header says "All times are
  in SECONDS"). Optional: a scene with no `camera` renders untransformed.
- **A layer has one static placement for its whole life.** The `layer` schema declares only
  `use`, `at`, `dur`, `active`, and is `.passthrough()` — every spatial field (`x`, `y`,
  `box`, `from`, `to`, `position`) arrives as an untyped passthrough key and is a single scalar
  or tuple. **There is no per-layer position keyframing anywhere in the schema.** The only
  time-varying things a layer can express are its own primitive-specific schedules: `active`
  (`[{at, i}]`), `Graph.pulses`/`highlight`/`enter`, `Matrix.highlight`. None of them move a
  layer; they change what it draws.
- `scene3d.camera` is a separate keyframed array of 3D `{at, pos, look}` keys.

So the manifest has exactly one authored spatial animation channel — the camera — and layers
sit still inside it. That asymmetry is the whole of Part A.

### 1b. The camera transform, written out, and it is invertible

`packages/motion-engine/src/primitives/Camera.tsx`, read in full. Confirmed: the keys really
are interpolated, and really are eased — `interpolate(frame, [a.at, b.at], [0,1], {easing:
Easing.bezier(...b.ease)})`, defaulting to `design.ease.inOut` (`[0.65, 0, 0.35, 1]`), with
`x`/`y`/`zoom` each interpolated on that eased `t`. Keys are sorted; before the first key and
after the last it clamps to that key.

The transform it emits, on an `AbsoluteFill` with `transformOrigin: "0 0"`:

```
transform: translate(cx - camX·zoom + dx,  cy - camY·zoom + dy) scale(zoom)
```

CSS applies that right-to-left (scale, then translate), so for any child at world point
`(wx, wy)`:

```
screen_x = wx·zoom + (cx − camX·zoom + dx)
screen_y = wy·zoom + (cy − camY·zoom + dy)
```

That is a **2D similarity transform: uniform scale plus translation. No rotation, no shear, no
perspective.** It is trivially invertible:

```
world = (screen − T) / zoom      where T = (cx − camX·zoom + dx, cy − camY·zoom + dy)
```

`dx`/`dy` are the always-on ambient drift (`design.ambientDriftPx * 2 * sin(frame/design.fps ·
k)`, ±3 px at the default token). It is deterministic, it is a pure translation, and — the
useful part — **it cancels out of any delta**, and out of any coordinate measured relative to
the transformed container itself (§3).

### 1c. Layers are rendered inside that transform — i.e. the model is world/scene space

`packages/motion-engine/src/engine/Video.tsx`: `TwoD` builds `nodes = renderLayers(...)` and,
**only if `scene.camera` is non-empty**, returns `<Camera keys={keys}>{nodes}</Camera>`;
otherwise it returns the bare nodes. So every layer in a camera'd scene is a descendant of the
camera's transformed `AbsoluteFill`, and its own `x`/`y` are consumed *inside* that box:

- `Text` (`primitives/Text.tsx`): `position:absolute; left:x; top:y`, with
  `translateX(-50%)`/`(-100%)` for `align: center`/`right`. Its own doc comment says "px, world
  coords" — and that is true.
- `Emphasis` (`primitives/Emphasis.tsx`): `ring`/`scribble` draw into an `<svg>` at
  `inset: 0, overflow: visible`, i.e. spanning the whole composition rect *in world space*, and
  `roughEllipse(cx, cy, …)` is called with `cx = box.x + box.w/2` in raw world px.
- `Matrix`: `left: ox, top: oy`, world px, defaulting to canvas-centred.
- `Layers`: `left: cx, top: cy`, world px, defaulting to canvas-centred.
- `Graph`: an `inset: 0` SVG with node coordinates in world px.

**Answer to design question 1 (a) vs (b): the current code is unambiguously (a) — scene/world
space, with the camera transform applied on top at render time.** Option (b) — screen space at
a reference frame — is not what the engine does anywhere.

### 1d. The Motion tab's preview is a live React DOM tree, not a server-rendered picture

This is the single largest difference from `on-canvas-transform.md`'s subject, and it makes
half of that note's Phase 0 unnecessary here.

`packages/motion/src/MotionPreview.tsx` embeds a real `@remotion/player` `<Player>` (4.0.519)
running `@apelles/motion-engine`'s own `Video` component with the manifest as `inputProps`. The
Edit tab's preview is an `<img src="data:image/jpeg;base64,…">` produced by a Rust CPU
compositor per frame (that note's "no cheap live re-render" finding). The Motion tab's preview
is **the actual composition, live in the DOM, re-rendering at frame rate**. Consequences:

1. **Live drag feedback is free.** Change a prop, React re-renders the real picture. No
   overlay-only ghost box that the picture catches up to on release.
2. **Every rendered element can be measured** with `getBoundingClientRect()`, which returns the
   post-transform on-screen rect — after the player's fit-scale *and* the camera's
   translate/scale *and* the drift. §3 turns this into the whole answer.
3. `PlayerRef` (`node_modules/@remotion/player/dist/cjs/player-methods.d.ts`, read directly)
   already exposes `getScale()`, `getContainerNode()`, `getCurrentFrame()`, `seekTo()`, plus
   `frameupdate` and `scalechange` events. The outer half of the screen↔composition mapping is
   **already supplied by the library** — nothing to build.

### 1e. Only the scene under the playhead exists in the DOM

Verified in Remotion's own build, not assumed
(`node_modules/remotion/dist/esm/index.mjs`, `RegularSequenceRefForwardingFunction`):

```js
const content2 = absoluteFrame < cumulatedFrom + from ? null
               : absoluteFrame > endThreshold ? null : children;
```

`Video.tsx` lays scenes out in a `<Series>` of `<Series.Sequence>`, so **a scene outside the
playhead renders `null`** — its layers are not in the document at all. A layer *within* the
active scene whose `at` is still in the future *is* mounted (every primitive renders with an
interpolated opacity/progress rather than returning `null`; the one exception is
`Emphasis` with `preset: ring|scribble` and **no** `box`, which returns `null` outright).

So any measure-the-DOM technique only works for the scene the playhead is inside. That is a
real constraint, and a cheap one: `LayerList` already seeks the player to a scene's start frame
when you select a row in it (D-081, `sceneStartFrame`).

### 1f. The tab's edit path: text is the source of truth, debounced, and there is no undo

`packages/motion/src/useMotionManifest.ts`: `text` (a JSON string) is the state; every edit goes
`setTextLive` → 300 ms debounce → `JSON.parse` → `manifestSchema.safeParse` → `setManifest`.
`InspectorPanel`'s edits go through `manifestEdit.ts` (pure, `structuredClone`-based) and then
back out via `MotionTab`'s `onInspectorChange` → `JSON.stringify(next, null, 2)` → `setText`.

Two facts that become Phase 0 items:

- **A round-trip through the text state costs a full re-serialize and a 300 ms debounce before
  the preview updates.** Fine for typing in a form field. Not fine as the per-pointermove path
  of a drag.
- **The Motion tab has no undo.** `@apelles/history` (D-051) is used by the Edit tab's
  `useEditorTimelineStore`; `useMotionManifest` holds the manifest text/parse/save/render state
  in plain component state with no history stack. So `on-canvas-transform.md`'s Phase 0b problem
  ("a drag must not push 60 undo entries per second") does not exist here — because there is
  nothing to push *to*. That is worse, not better: a visual builder whose gestures cannot be
  undone is not shippable.

> **Re-verified against `main` at `08e2d7b`**, after D-150 (B-058, the readiness state machine)
> landed from a sibling fork mid-pass. That change adds `motionProjectStore.ts` and moves the
> *readiness* signal out of this hook — it does **not** touch the edit path: `DEBOUNCE_MS = 300`,
> `setTextLive`'s debounce→parse chain, `MotionTab`'s panel layout and `ManifestEditor` are all
> unchanged, and the store's own doc comment is explicit that "no manifest text/parse/save/render
> state" moved with it. Every finding in §1f, §1d and §5 still holds on current `main`.

### 1g. Identity is positional

`LayerList.tsx`'s `Selection` is `{sceneIndex, target}` where `target` is
`{kind:'layer', index}` etc. — array indices. `Video.tsx`'s React key is `` `${l.use}-${i}` ``.
There is no `id` on a layer in the schema. Workable for select-and-edit; it breaks the moment
the builder can reorder, insert, or delete layers with a selection live (§4, Phase 3).

---

## 2. Part A — the coordinate-space question, answered

### 2a. It is **not** the D-136 problem. Stated plainly, because the phasing depends on it.

D-136's bug (B-043) was: `composite_video_frame` built its canvas from *the top layer's decoded
pixel dimensions*, and that decode size changed with the preview quality knob
(`SCRUB_LONG_EDGE = 960` paused, `PLAY_LONG_EDGE = 640` playing). `position_x: 200` therefore
meant 20.8 % of the frame at one quality and 31.25 % at another — **the same stored number
denoted a different place depending on a render setting that was not part of the document.**
The fix had to be a unit change plus a schema-minor migration, because the old values were not
merely unconverted, they were unrecoverable.

None of that is true here:

| | Edit tab, pre-D-136 | Motion engine, today |
|---|---|---|
| Reference frame for a stored coordinate | the *decoded canvas*, whose size depended on preview quality, which clip was on top, and that clip's source resolution | `manifest.width` × `manifest.height`, declared in the document itself |
| Does the reference frame change with a render setting? | **Yes** — that was the bug | **No.** `metadataFromManifest` feeds `width`/`height` straight from the manifest to the composition, and `<Player compositionWidth/compositionHeight>` does the same for the preview. The player's fit-scale is a viewport zoom outside the composition and touches nothing inside it. |
| Is the stored value's meaning recoverable? | No — hence a migration | Not applicable; nothing needs migrating |
| Shape of the transform between authored and displayed | preview-resolution *scaling* (an implicit, undocumented divide) | an **explicit, authored, keyframed** 2D similarity — the camera. It is content, not a setting. |

**So the honest answer to "is it analogous?" is no, and the difference is not cosmetic.** D-136
had to change what a number *means* on disk. Here the numbers mean the right thing already;
what is missing is a **tool that speaks the same space the author's eye is in**. That is a UI
problem with a small amount of real math in it, not a data-model migration. Anyone starting
this work from the assumption that it is D-136 again will write a migration nobody needs and
still not fix the owner's screenshot.

### 2b. Answering design question 1 properly: is world space still the right authoring space?

Yes, and the alternatives are worth ruling out explicitly rather than by default.

- **(a) World/scene space, camera on top — what the code does.** A layer's `{x,y}` is where it
  sits in the scene; what you see is that pushed through the camera at that frame. This is the
  only option under which a camera move *works at all*: the entire point of `camera: [{at:0,
  zoom:1}, {at:1.6, x:1150, y:520, zoom:1.5}]` is that the scene holds still and the view moves
  over it. It is also what After Effects means by World space, what a 3D scene graph means, and
  the only model in which a push-in is one edit rather than an edit to every layer.
- **(b) Screen space at a reference frame.** Breaks the instant the camera moves — and worse,
  it is *silently* broken: the manifest still validates, the render still succeeds, the picture
  is just wrong at every frame but one. This is exactly the D-136 failure mode, and it is worth
  naming precisely because **§2c shows this is the mistake the owner's manifest actually
  contains — committed by the author, not by the engine.**
- **(c) Layer-relative / parented space** (a layer positioned relative to another layer, e.g.
  an emphasis box declared as "around layer 3"). Genuinely attractive here, and §4's Phase 2
  proposes a narrow version of it — but as a *second, optional* way to express a position that
  resolves down to world space, never as a replacement for it.

**Recommendation: keep world space. Do not migrate anything.** The work is entirely in the
tooling.

### 2c. What the owner's bug actually is — derived from the real manifest, not guessed

The screenshot is the engine's own sample. `packages/motion-engine/src/engine/sample.ts`, scene
`hook`, contains verbatim:

```json
{ "id": "hook", "dur": 4,
  "camera": [ {"at":0,"zoom":1}, {"at":0.4,"zoom":1}, {"at":1.6,"x":1150,"y":520,"zoom":1.5} ],
  "layers": [
    {"use":"text","text":"EVERY call re-sends the whole prompt","preset":"stroke-on",
     "at":0.2,"x":180,"y":300,"size":78},
    {"use":"emphasis","preset":"scribble","at":1.8,"dur":2,"box":[980,250,520,130]} ]}
```

The owner's words — the highlight circling *"the whole prompt"* — match this string exactly.
Working it out at the frame the emphasis appears (`at: 1.8 s`, fps 30 → frame 54; the last
camera key is at frame 48, so the camera is fully at `x:1150, y:520, zoom:1.5`; `cx,cy =
960,540`):

```
T = (960 − 1150·1.5, 540 − 520·1.5) = (−765, −240)      (± ≤3 px drift)
screen = world·1.5 + T
```

**Finding 1 — the box is vertically miscentred against the text, in world space, before the
camera is involved.** The text's own layout box is `top: 300`, `fontSize: 78`,
`lineHeight: 1.15` → 89.7 px tall → world y `300 … 389.7`, centre **344.9**. The emphasis box
is `y: 250, h: 130` → centre **315**. The scribble is **~30 world px (≈45 screen px at
zoom 1.5) above the text's centre.** That is pure authoring error; no camera required.

**Finding 2 — the ellipse is not the box.** `Emphasis` draws
`roughEllipse(cx, cy, box.w * 1.18, box.h * 1.5)` — **18 % wider and 50 % taller than the
`box` the author typed.** So even a perfectly-measured box produces an ellipse that overshoots
it, here to world x `933 … 1547`, y `217 … 412`. An author reading the schema comment
(`"box":[x,y,w,h]`) has no way to know this from the manifest.

**Finding 3 — the box overshoots the end of the sentence.** The text runs from world x 180; at
Kalam 78 px the 35-character string is roughly 1200–1250 px wide (I cannot measure Kalam's real
metrics in this sandbox — this is an estimate and is flagged as one in §7). The ellipse's world
right edge is 1547, i.e. **~140 px past where the sentence ends** — about four characters of
empty space. On screen at that frame the sentence starts at `180·1.5 − 765 = −495`, off the
left edge, so what the owner sees is the tail of the line with a red ellipse hanging off its
end. That is the screenshot.

**Finding 4 — the camera is framed on neither of them.** The camera targets world y 520; the
text sits at y 300–390 and the box at 250–380. Everything is pushed into the upper third at
that frame. Also authoring, also invisible from the JSON.

**So the root cause is not drift and not a coordinate-space defect. It is this:** the
emphasis box is a **hand-authored, independent duplicate of a rectangle only the layout engine
actually knows.** The text's true extent is a function of the font file, the glyph metrics, the
weight, `letterSpacing`, `maxWidth` wrapping and the browser's line breaking — none of which is
in the manifest, none of which a model emitting a manifest can compute, and none of which the
author can do better than eyeball. Four hand-typed numbers are being asked to track a rectangle
that nothing in the authoring path can measure.

And there is a second, latent mechanism that the tool must not reproduce: **if you author those
four numbers by measuring pixels off a rendered screenshot, you have written screen
coordinates into a world-space field.** At `zoom 1.5, T=(−765,−240)` those are wrong by a
factor and an offset, and they are wrong differently at every other frame. That *is* the D-136
mistake — committed by a human with a ruler rather than by the compositor. A drag tool that
naively applied a raw pointer delta to `box[0]` would institutionalise it.

### 2d. Answering design question 2: what "drag it, and it follows the animation" needs

Mechanically, three things, and the current code already supplies two of them:

1. **A world-space store.** Already true (§1c). A layer dragged to a new world `{x,y}` keeps
   whatever camera motion is authored over it, automatically, at every frame, forever — because
   the camera transform is applied at render time to whatever the layer's coordinate is. **The
   owner's "it should follow the animation as well" is not a feature to build; it is a property
   the current model already has.** The only reason it currently *doesn't* feel that way is
   that there is no way to set the coordinate except by typing it.
2. **An invertible screen→world map at the current frame.** The camera is a similarity
   transform (§1b), so the inverse exists in closed form. But — see §3 — you should not write
   that inverse down.
3. **A way to know where the layer really is right now**, so the handle is drawn on the thing
   rather than near it. This is the part with no existing answer, and §3 is that answer.

---

## 3. The "smart way to handle" it: measure the live DOM, don't re-derive the camera

This is the load-bearing recommendation of this note.

### 3a. The technique

The naive design reimplements `Camera.tsx`'s math in the editor package: read `scene.camera`,
re-sort the keys, re-run `interpolate` with `Easing.bezier(design.ease.inOut)`, recompute
`T` and `zoom` at the current frame, invert. It works, and it is wrong to build. It is a second
copy of a transform that already exists, in a different package, that must be kept bit-identical
to the first one forever — and it would have to grow a copy of the drift sinusoid, and a copy
of `design.ease`, and a copy of the clamp-before-first-key behaviour, and would need updating
every time the camera gains a feature (rotation, a third key type, per-key easing overrides —
`CameraKey.ease` already exists in the component and is not even in the zod schema yet).

**The composition is live in the DOM. Ask the browser instead.**

`getBoundingClientRect()` on any element returns its border box in viewport coordinates *after
every ancestor CSS transform*. That single call already composes: the player's fit-scale, the
camera's `translate(...) scale(zoom)`, and the drift — plus anything ever added later, for
free.

Concretely, the mapping needs one measured reference. Mark the camera's inner transformed
`AbsoluteFill` (and, in a camera-less scene, the scene's own `AbsoluteFill`) with a
`data-motion-world` attribute. Then, at any instant:

```
worldRect  = document.querySelector('[data-motion-world]').getBoundingClientRect()
k          = worldRect.width / manifest.width      // = playerScale × cameraZoom, measured
world(p)   = ((p.x − worldRect.left) / k, (p.y − worldRect.top) / k)
worldDelta(d) = (d.x / k, d.y / k)
```

Why this is the right answer, point by point:

- **It is exact, not approximate.** `k` is the true composed scale; `worldRect.left/top` is the
  true composed origin. There is no modelling error to accumulate.
- **Drift cancels twice over.** In `worldDelta` it cancels because it is a translation and this
  is a difference. In `world(p)` it cancels because `worldRect` is measured *at the same
  instant* and carries the same drift. Neither path needs to know drift exists.
- **The camera's easing, key sorting, clamping and any future feature are all already
  included**, because the browser is applying the real transform, not a reconstruction of it.
- **It is uniform across primitives.** Every 2D primitive is a descendant of the same world
  container, so one measurement serves all of them.
- **It needs no new math in a package that shouldn't own it.** `@apelles/motion` never imports
  `Camera.tsx`'s internals and never duplicates `design.ease`.

The layer's own current position is then just: read `x`/`y` (or `box`) from the manifest — they
are already world coordinates. And the *screen* rect to draw a handle on is measured, not
computed.

**The one real cost: a small, deliberate engine change.** `motion-engine` must emit stable
hooks — `data-motion-world` on the world container, and `data-motion-layer="<sceneIdx>.<layerIdx>"`
on a per-layer wrapper in `renderLayers`. Both are attributes on elements that already exist or
on a wrapper that changes no layout. Neither affects a single rendered pixel, so the
determinism invariant is untouched. It is a real cross-package dependency, though — the editor
depends on the engine's DOM shape — and it should be documented as a contract in the engine's
own README rather than left as a lucky selector.

### 3b. Where measuring is *not* enough, stated honestly

**Drawing a tight selection box needs a per-primitive hint.** `getBoundingClientRect()` on a
generic wrapper is not a usable box for several primitives, checked individually:

| Primitive | What its outermost element's rect actually is | Usable as a box? |
|---|---|---|
| `Text` | the positioned `div`, `left:x/top:y`, real text metrics | **Yes**, tight and correct |
| `Matrix` | an `<svg>` at `left:ox/top:oy` with **no `width`/`height`** → CSS default 300×150 regardless of the grid | **No** |
| `Layers` | a `div` at `left:cx/top:cy` with no size; all cards are absolutely positioned off it | **No** — zero-area |
| `Graph` | an `<svg>` at `inset: 0` | **No** — the whole canvas |
| `Emphasis` (`ring`/`scribble`) | an `<svg>` at `inset: 0` | **No** — the whole canvas; the `<path>` inside it *is* tight |

So the engine change is slightly bigger than one attribute: each primitive's genuinely tight
visible element(s) should carry `data-motion-box`, and the editor takes the **union of those
descendants' rects** as the layer's box. For `Emphasis` that is the `<path>`; for `Layers` it is
the card divs; for `Matrix` the `<g>`/`<path>` set. That is a per-primitive pass — eight
primitives, mechanical, but it is real work and it is the honest price of a selection box that
sits on the thing rather than around the whole frame.

**Nothing here helps `scene3d`.** `Scene3D` runs a Three.js perspective camera through
`@react-three/fiber`. That is not a 2D similarity: it is a projective transform, it is not
invertible without choosing a depth, and a 3D child's `position`/`from`/`to` are in Three.js
world units on a canvas that `getBoundingClientRect()` sees as one opaque `<canvas>` element.
Dragging a 3D child correctly means unprojecting the pointer ray and intersecting it with a
chosen plane (or using drei's `TransformControls`, which is a real, different piece of work
with its own gizmo, its own hit-testing, and its own camera-relative semantics). **3D is
excluded from every phase in §4** and named as its own future effort.

### 3c. Real external precedent (checked this pass, with what could and could not be verified)

**Remotion's own Studio already does this, and its answer to the keyframe question is the one
to copy.** Remotion's docs describe canvas-side visual editing where dragging a selected
sequence's outline updates `style.translate`; Shift locks movement to one axis; and, critically,
you can *"Edit keyframed `style.translate`, `style.rotate` or `style.transformOrigin` values
from the canvas. **Drags create or update keyframes at the current frame.**"* There is also a
transform-origin handle that "compensates `style.translate` so the visual position stays
stable." **What the docs do not state** — I looked and did not find it — is how the pointer
delta is mapped back through a transformed ancestor. So: the *behavioural* precedent
("dragging authors a keyframe at the playhead") is verified and directly applicable; the
*implementation* precedent for the coordinate math is not, and §3a's measure-the-DOM approach
is this note's own recommendation, not something copied.

Also relevant, and already settled in this repo: Remotion's paid **Editor Starter** was checked
and rejected as a base to build on (D-080/D-099, `global-inspector.md` — ~$600, a template to
adopt rather than a component library). That call stands and this note does not reopen it; the
Starter's feature list is a useful target to *aim at*, not a codebase to take.

**After Effects — axis modes.** AE makes the space you drag in an explicit user-facing mode:
**World** axis mode fixes the axes to the composition's absolute coordinates regardless of
layer or view; **View** axis mode aligns them to whatever you are currently looking through;
**Local** aligns to the layer. The relevant lesson is not the gizmo, it is that a serious
motion tool treats "which space is my drag in?" as a **choice worth exposing**, rather than
picking one silently. §4's Phase 1 picks world-by-default (matching the store), and §7 records
"should the builder ever offer a screen-space nudge mode?" as a genuinely open question rather
than answering it by omission.

**What I could not verify and am not claiming:** how AE specifically back-solves a pointer
delta when you drag a 2D layer while looking through an animated camera at a non-key frame. The
search results covered axis modes and camera setup, not that mechanism. I am not going to
assert a behaviour for it.

Sources (fetched/searched 2026-09-05, not recalled):
[Remotion — Edit default props visually](https://www.remotion.dev/docs/visual-editing) ·
[Remotion — Studio interactivity](https://www.remotion.dev/docs/studio/interactivity) ·
[Remotion — Editor Starter features](https://www.remotion.dev/docs/editor-starter/features) ·
[Adobe — Use 3D layers in After Effects](https://helpx.adobe.com/after-effects/using/3d-layers.html) ·
[Adobe — Cameras, lights, and points of interest](https://helpx.adobe.com/after-effects/using/cameras-lights-points-interest.html) ·
[Angie Taylor — Understanding Axis Modes](https://angietaylor.co.uk/understanding-axis-modes/)

### 3d. The direct fix for the owner's actual screenshot, which is smaller than the builder

Worth separating out, because it is available long before a full visual builder and it fixes
the thing he pointed at:

**Let an emphasis attach to a layer instead of to four numbers.** A new optional field —
`{"use":"emphasis","preset":"scribble","of":"<layer ref>","pad":12}` — resolved at render time
by measuring the target layer's real DOM rect and converting it to world coordinates via §3a's
`data-motion-world` reference. The scribble then tracks the text through font changes, copy
edits, re-wrapping and re-positioning, because it is no longer a duplicate of the rectangle; it
*is* the rectangle.

Two things make this less trivial than it sounds and they should be said now rather than
discovered:

- **It makes a render frame-order-dependent unless handled carefully.** A measure-then-draw
  pass inside a render is a layout read followed by a paint, which in Remotion's
  deterministic-render contract is acceptable only if the measurement is a pure function of the
  frame (it is — same DOM, same frame, same metrics) and is done in a layout effect before the
  frame is captured. This needs a real spike against `remotion render`, not an assumption. The
  project invariant ("same doc + same frame ⇒ identical pixels") is the bar.
- **The `× 1.18 / × 1.5` inflation (§2c finding 2) has to be reconciled.** Either `of`/`pad`
  bypasses it and the padding is literal, or the inflation stays and `pad` is measured after
  it. Pick one, document it, and probably drop the magic multipliers into named constants in
  `design.ts` while touching this.

A cheaper, non-render-path variant that gets 80 % of it: keep `box` as the stored truth, and
add a **"snap to layer" action in the Inspector/overlay** that measures the target layer once,
converts, and writes the four numbers. The manifest stays dumb, nothing about the render path
changes, and the human/agent-in-the-loop still gets "put it in the right place" as one click.
**Recommend this variant first** (§4, Phase 2) and treat `of` as a follow-up once the
determinism spike is done.

---

## 4. Part B — the visual builder, phased

Phased the way `on-canvas-transform.md` phased the Edit tab: prerequisites that would otherwise
make the feature feel broken, then the smallest genuinely useful slice, then outward. Sizes are
stated honestly; one of these is a major feature and is labelled as such.

### Phase 0 — four prerequisites. None optional.

**0a. Stable DOM hooks in the engine (§3a/§3b).** `data-motion-world` on the camera's
transformed container and on a camera-less scene's root; `data-motion-layer="<s>.<l>"` on a
per-layer wrapper in `renderLayers`; `data-motion-box` on each primitive's tight visible
element(s). Zero pixel change. Documented as a contract in `packages/motion-engine/README.md`,
because `@apelles/motion` will depend on it.

**0b. A commit path that isn't the 300 ms text round-trip (§1f).** A drag needs the preview to
follow the pointer. Today every write is `JSON.stringify` → `setText` → debounce → `JSON.parse`
→ `safeParse`. Recommended split, mirroring `RelightPuckLayer`/D-136's discipline but adapted
to a live preview: during a gesture, hold a **transient manifest override** in tab state and
feed it straight to `<Player inputProps>` (no serialize, no parse, no debounce — the preview is
React, it just re-renders); on pointer-up, commit once through the existing
`manifestEdit.ts` → `setText` path so the JSON stays the one serialized source of truth. One
gesture, one text write.

**0c. Undo.** `@apelles/history` (D-051) exists and the Motion tab does not use it. A visual
builder without undo is not shippable, and adding it after the fact means retrofitting every
mutation site. Do it in Phase 0, with the Inspector's existing edits as the first customer —
which also makes it independently useful before any drag exists. Scope it to the same
before/after snapshot shape the Edit tab uses; the manifest is small.

**0d. Decide what a gesture writes when the layer is inside a camera move.** Nothing to build,
but a decision to record: a drag writes the layer's **world** `x`/`y` (§2b), not a
screen-space offset, and the overlay must therefore convert via §3a and never by adding the raw
pointer delta. Getting this wrong is silent — the manifest still validates.

### Phase 1 — select a layer on the canvas, drag it. Nothing else.

The smallest thing that is genuinely useful and needs no schema change at all.

- A `MotionCanvasOverlay` in `packages/motion/`, a DOM sibling of `<Player>` (same shape
  `TransformOverlay.tsx` uses next to `PreviewPane`'s `<img>`), positioned over it.
- **Click-to-select works here, unlike the Edit tab.** D-136 had to defer it because
  `chroma_timeline_frame` returns a JPEG and nothing about which layer is where. Here the
  layers are real DOM nodes — `document.elementsFromPoint()` inside the player, walk up to the
  nearest `[data-motion-layer]`, done. This is a genuine advantage of the Motion tab's
  substrate and it should be taken in Phase 1, not deferred.
- Selection stays the existing `Selection` type and stays two-way with `LayerList` and
  `InspectorPanel` — one selection, three editors, exactly the "panel and canvas edit the same
  values" rule `on-canvas-transform.md` took from Premiere and Resolve.
- **Drag writes `x`/`y`** for `text`/`matrix`/`layers`, and `box[0]`/`box[1]` for `emphasis`.
  These are the only per-primitive special cases; `propCatalog.ts` is already the place that
  knows which fields a primitive has and is the natural home for a `positionFields(use)` map.
- Live preview during the drag via 0b's transient override; one commit on pointer-up; Escape
  cancels. Shift locks to an axis (Remotion Studio's own modifier — §3c).
- **Not in Phase 1:** multi-select, resize, rotate, keyframes, 3D, snapping, alignment guides.

**Size: small.** No schema change, no engine change beyond Phase 0a, no new math beyond §3a's
four lines.

### Phase 2 — size, and "snap the highlight to that layer"

Two things the owner asked for that are cheap once Phase 1's substrate exists.

- **Resize handles for the primitives that have a real rectangle**: `emphasis.box[2]/[3]`,
  `layers.cardW`/`cardH`, `matrix.cell`, `text.maxWidth`, `graph.width`/`height`. These are
  per-primitive named fields, not a generic `scale` — the engine has no layer-level scale.
- **"Snap to layer"** (§3d): with two layers selected, or via a target picker on an emphasis
  layer, measure the target's real rect and write the four `box` numbers. **This is the direct
  fix for the screenshot** and it is a button, not a subsystem.
- **Recommended alongside, as the enabling structural change for Phase 4:** introduce an
  optional **layer transform wrapper** — a generic `{x, y, scale, rot, opacity}` applied by
  `renderLayers` as a CSS transform on the per-layer wrapper 0a already adds, *on top of* the
  primitive's own positioning. It gives every primitive a uniform scale/rotate/fade it does not
  have today without touching eight components, and — the real reason to do it here — **it is
  the exact channel Phase 4 keyframes.** Doing it in Phase 2 means Phase 4 animates something
  that already exists and is already visible in the Inspector.

**"Crop", honestly.** The owner listed crop. Motion has no crop concept and, unlike an Edit-tab
clip (a rectangle of decoded video), most motion primitives have no meaningful thing to crop —
a text run, a scribble, a force-laid graph. The nearest real equivalents are `text.maxWidth`
(wrap width) and clipping a layer to its wrapper box, and the latter is one CSS property on the
Phase 2 wrapper (`overflow: hidden` + an explicit size). **Recommend: implement clip-to-box as
a wrapper property if a real edit needs it, and do not port the Edit tab's four-inset crop
model into Motion.** Say this to the owner rather than silently dropping the word from his ask.

**Size: small-to-medium.** The wrapper is a real engine change with a schema addition, but a
purely additive one (`#[serde(default)]`-equivalent: absent means identity, every existing
manifest renders byte-identically).

> **Built as D-157 (2026-09-05).** Resize handles (per-primitive named fields, as scoped:
> `emphasis.box[2]/[3]`, `layers.cardW`/`cardH`, `matrix.cell`, `text.maxWidth`,
> `graph.width`/`height`), "snap to layer" (an Inspector target-picker + button on an `emphasis`
> selection — the §3d "cheaper, non-render-path variant," exactly as recommended), and the layer
> transform wrapper (`{x,y,scale,rot,opacity}`, plus `clipWidth`/`clipHeight` for the "crop,
> honestly" call below) all shipped together. One real deviation from this section's own wording:
> the wrapper's `scale`/`rot` pivot at the wrapper's own origin (`transformOrigin: "0 0"`,
> matching `Camera.tsx`'s own convention), not at "the layer's own position" — reaching the
> primitive's own anchor would need this engine package to depend on `@apelles/motion`'s
> `positionFields`, the wrong direction. One honest gap disclosed rather than fixed: a drag/resize
> on a layer that ALSO carries a non-identity `transform` will be slightly off, since
> `MotionCanvasOverlay.tsx`'s screen↔world map is still measured off `[data-motion-world]` alone.
> See `docs/08-decisions.md`'s D-157 entry and `packages/motion-engine/README.md`'s "Layer
> transform wrapper" section for the full writeup.

### Phase 3 — multiple elements

The owner said "multiple elements" first, so this is not optional polish.

- `Selection` becomes `Selection[]` (the Edit tab made the same move; D-137's marquee is the
  direct precedent for the gesture, including its "make the two pointer gestures mutually
  exclusive by DOM position, not by precedence" finding).
- Marquee-select over the canvas; shift-click to extend; drag moves every selected layer by one
  shared world delta.
- **Prerequisite that bites here: stable layer identity (§1g).** Index-based selection survives
  editing one layer; it does not survive reorder/insert/delete with a multi-selection live.
  Recommend an optional `id?: string` on the layer schema, generated when the builder creates a
  layer, absent on hand-written manifests, with positional identity as the documented fallback.
  Additive, no migration.
- Alignment/distribute actions and snapping guides belong here, not earlier.

**Size: medium.**

> **Built as D-158 (2026-09-05).** Every bullet above shipped except one, scoped down exactly as
> this pass's own instructions permitted: `Selection[]` (constrained to same-kind `layer`,
> same-scene, or a single entry of any kind — a real design call not spelled out above, documented
> in `LayerList.tsx`'s own module doc comment); marquee-select + shift-click-extend, D-137's
> discipline applied to a FOURTH gesture sharing `MotionCanvasOverlay.tsx`'s pointer surface
> (resize/move/click/marquee) — D-137's own CLASS-LIST exclusion technique doesn't transfer
> verbatim (Remotion's control bar carries no distinguishing class or attribute at all), so
> `[data-motion-world]` DOM containment plays the equivalent structural role instead; a
> shared-world-delta group move (`moveLayersByDelta`, one commit per gesture regardless of group
> size); stable layer identity, built exactly as recommended (`layer.id`, optional, additive,
> `addLayer`-generated, positional fallback when absent, `resolveSelection`/`resolveSelections`
> preferring it when present); and alignment/distribute (`alignSelections`/`distributeSelections`,
> real pure functions with real tests, a small toolbar in the Inspector's new multi-select view).
> **Snapping guides were the one item explicitly scoped down**, per this pass's own standing
> permission to do so provided align/distribute shipped — the open-ended, UI-heavy half (live
> nearest-edge computation on every pointermove, a threshold-snap, a drawn guide-line overlay) with
> no small version of it; the smallest real next step (the align functions' own target-line math is
> already most of what a snap-while-dragging feature would need) is recorded in D-158's own
> decision entry rather than attempted here. One additional design call this section didn't fully
> resolve, made and documented rather than left implicit: the Inspector's multi-select view is a
> COMBINATION of the options this doc's own owner-facing task later posed — align/distribute and a
> generic Transform group always show; a primitive's own fields show too, in lockstep, only when
> every selected layer shares a `use`; a live per-layer sub-picker was considered and rejected (see
> `InspectorPanel.tsx`'s own module doc comment for the full reasoning). See `docs/08-decisions.md`'s
> D-158 entry for the complete writeup, including a real worktree-infra gotcha (cross-package
> `tsc` types silently resolving to the MAIN repo's stale `schema.ts` through a symlink chain) found
> and worked around this pass.

### Phase 4 — the animation model: per-layer keyframes

This is where the manifest genuinely has to grow, and where "so we can build crazy things"
actually lives. Today the camera is the only animated spatial channel (§1a).

Recommended shape, and the reasoning:

```json
{"use":"text","text":"…","x":180,"y":300,
 "keys":[{"at":0.2,"x":0,"y":40,"opacity":0},{"at":0.8,"x":0,"y":0,"opacity":1}]}
```

- **Keys drive the Phase 2 wrapper, as a delta on top of the static `x`/`y`, not a replacement
  for them.** Three reasons, all real: an un-keyed manifest renders exactly as it does today; a
  layer's "home" position stays one number a human can read; and the drag tool has an
  unambiguous answer to "what did I just move?" — with no keys it moves the base, with keys it
  moves a key.
- **Reuse the camera's own key mechanics, don't invent a second interpolator.** `Camera.tsx`
  already sorts keys, clamps outside the range, and eases with `Easing.bezier(design.ease.*)`.
  Extract that into one shared `interpolateKeys` in `motion-engine` and have both the camera and
  layer keys use it. This is CLAUDE.md's "if two places need it, extract it," and it is the
  same call D-147 made for the fade curve.
- **Per-key easing must be in the schema this time.** `CameraKey.ease` exists in the component
  and is *not* in the zod schema — `cam2dKey` is a plain `z.object`, which strips unknown keys
  rather than rejecting them, so an authored `ease` is silently dropped and every camera move in
  every manifest is stuck on `design.ease.inOut`. (Note the contrast with `layer`, which is
  `.passthrough()` and therefore *does* carry per-primitive props through.) Found
  independently by the concurrent Motion audit pass and filed there as its own bug (that pass's
  B-059) while this note was being written; recorded here as a cross-reference rather than filed
  twice. Fix it as part of this phase, since layer keys will want the same field.
- **The auto-keyframe question has a verified answer to copy:** Remotion Studio's own rule
  (§3c) — *a drag creates or updates a keyframe at the current frame* when the property is
  keyframed, and moves the static base when it is not. That matches `on-canvas-transform.md`'s
  Phase 4 question, which the Edit tab left open; here there is a precedent to point at. It
  still needs an explicit `D-NNN` when built, because it is the single most surprising
  behaviour in any animation tool.

**Size: medium-to-large.** A schema addition, a shared interpolator extraction, a wrapper that
consumes it, Inspector support for a key list, and the auto-keyframe decision.

> **Built as D-159 (2026-09-05).** Every bullet above shipped: `layer.transform.keys`
> (`schema.ts`'s new `transformKey`, `{at, x?, y?, scale?, rot?, opacity?, ease?}`, seconds), the
> shared `interpolateKeys` extraction (`motion-engine/src/lib/interpolateKeys.ts`, used by BOTH
> `Camera.tsx` and `Video.tsx`'s `renderLayers`, verified byte-for-byte unchanged for the camera via
> `remotion still`), Inspector support (the camera-only `CameraKeyList` generalized to
> `KeyframeList`, now also driving a new per-layer `TransformKeysSection`), and B-059 fixed exactly
> as this section names it, PLUS a second instance of the identical gap found on `cam3dKey` (this
> note's own §6 write-up of B-059 asserted `cam3dKey` was harmless; it wasn't — `Scene3D.tsx`'s
> `CameraRig` reads `ease` the same way `Camera.tsx` does). One real deviation from this section's
> own wording, made and documented rather than silently assumed: "every field is a DELTA on top of
> the static x/y" is stated here only for x/y; D-159 extended the SAME additive rule, uniformly, to
> `scale`/`rot`/`opacity` too (rather than, say, a multiplicative delta for `scale`), specifically so
> "absent `keys`" and "a `keys` array whose one entry leaves every field unset" are guaranteed
> identical by construction — see `schema.ts`'s own `layerTransform` doc comment and D-159's decision
> entry for the full reasoning. The auto-keyframe decision — this section's own "single most
> surprising behaviour" — landed as: per-PROPERTY (not per-layer), scoped to the move-drag's own
> position pair (`x`+`y` together, since one gesture always changes both), and explicitly NOT
> extended to resize (`transformKey` has no size field, mirroring `cam2dKey`'s own x/y/zoom shape,
> not a size concept) — a real design call this section leaves as an open question, resolved and
> documented in D-159's own decision entry with a dedicated, clearly-labelled subsection per this
> note's own instruction. See `docs/08-decisions.md`'s D-159 entry and
> `packages/motion-engine/README.md`'s "Per-layer transform keyframes" section for the complete
> writeup, including the honest gaps (no on-canvas rotate/scale/opacity gesture exists to
> auto-keyframe those fields, resize stays untouched by this phase, and D-157's known transform/
> world-map drag gap is unchanged and now also applies to a keyed layer).

### Phase 5 — a real keyframe timeline. **This is a major feature. Name it as one.**

Everything above lets you set *values* at the playhead. It does not give you a place to *see*
the animation: a time ruler under the preview, one row per layer, keys drawn as diamonds you
can drag along time, box-select and nudge them, a curve/easing editor, and time-scrubbing that
is coupled to the player. That is what "visually edit the animation" ultimately means to
someone coming from After Effects, and there is no small version of it.

Honest comparison from inside this repo: the Edit tab's timeline is
`@xzdarcy/react-timeline-editor` plus a large amount of Apelles code — a track model, a drag
system (dnd-kit, `dnd-kit-migration.md`), a ruler (`ruler.ts`), zoom levels (D-134), marquee
(D-137), keyboard handling and a store — accumulated over many decisions. A keyframe timeline
is a different shape (keys on a continuous axis, not clips in lanes) so most of that is not
directly reusable, but the *cost* is comparable. Treat it as a project, phase it separately
when it is reached, and do not let it get quietly attached to the end of Phase 4.

**A deliberately cheaper intermediate, worth considering instead:** the existing `LayerList`
grows a per-layer key *count* and a "keys" sub-row, and the player's own scrubber gains key
markers for the selected layer. Not a timeline; enough to see that keys exist and to jump
between them. Costs days, not weeks.

> **Scoped further and its first slice built as Phase 5a, `docs/notes/
> motion-keyframe-timeline-research.md` (2026-09-05, D-160).** That doc independently
> re-verifies this section's own "most of the Edit tab's timeline isn't reusable, but the cost is
> comparable" claim against the real code (verdict: confirmed, piece by piece — nothing transfers
> as code, `ruler.ts`'s tick-algorithm and D-137's gesture-separation discipline transfer as
> technique only), phases the remaining work as Phase 5a (built: `LayerList` key-count badges +
> a read-only keyframe strip under the player, camera and selected-layer markers, click-to-seek)
> and Phase 5b (not built: drag-a-key, per-row lanes, box-select, a curve editor — still a major
> feature). One real, disclosed deviation from this section's own wording: "the player's own
> scrubber gains key markers" turned out not to be buildable as literally worded — Remotion's
> bundled player controls have no extension point (checked directly) — so Phase 5a builds a
> separate small strip alongside the untouched player instead. See that doc for the complete
> writeup.

### Explicitly out of scope for all phases above

`scene3d` on-canvas manipulation (§3b), crop as the Edit tab means it (§ Phase 2), and any
change to the world-space storage model (§2b).

---

## 5. Part C — collapse the raw JSON behind a `</>` toggle

**Built as D-153, in a deliberately smaller shape than scoped below.** This section originally
handed the work off with a `MotionTab`-level architecture (gate the whole `ResizablePanel` +
`ResizableHandle`, lift `Save`/`Render` up, add an error-state chip). D-153 shipped a
self-contained alternative instead — recorded here so the gap between "scoped" and "built" is
explicit rather than silently stale.

The owner's ask was exact: the raw manifest is an agent/power-user surface, not a creator
surface; it should be collapsed by default behind a small `</>` icon button.

**Originally scoped shape:** a `showManifest` boolean in `MotionTab`, defaulting `false`,
gating the last `<ResizablePanel>` **and its preceding `<ResizableHandle>`** (leaving the
handle renders a dangling divider) — so collapsing would also reclaim the pane's ~420px of
width for the preview/Inspector. The trap called out at the time: `Save`/`Render` and the
error/status strip live *inside* `ManifestEditor`'s own header, so naively hiding the panel
would hide the only place a validation error is ever surfaced — requiring lifting those
controls out to a `MotionTab`-owned row first.

**What D-153 actually built:** the collapse stays entirely local to `ManifestEditor.tsx` — an
internal `expanded` boolean (default `false`) gates only the textarea + the JSON-parse-error
line of the status strip. The header (name/dirty state, the `</>` toggle, Save, Render) and the
`saveError`/`renderError` lines stay mounted and visible regardless of collapse state, so
nothing the owner needs disappears. A `parseError` force-expands the body (`showBody = expanded
|| !!parseError`) rather than needing a separate chip error-indicator, since the one case that
matters (JSON currently invalid) auto-reveals the JSON that's invalid.

**Why the smaller shape, not the scoped one:** it satisfies the literal ask — raw JSON hidden
by default, real actions/errors never hidden — without touching `MotionTab.tsx` or its
`ResizablePanel` layout math, and without a new elevated-chip component. The tradeoff accepted
knowingly: the panel's ~420px of width stays allocated even when collapsed, so there's no
layout-space payoff the way the original scope had. That's a real, still-open gap — worth doing
as a fast-follow if the fixed width proves annoying in daily use, using the three-part shape
above unchanged (it was correct then and is still the right shape for it). Not done now because
the width cost affects one pane, and the bigger visual-builder asks (§4, plus the owner's
separate ask for per-axis x/y/w/h Inspector fields + a real keyframe timeline) are higher-value
uses of the same file.

---

## 6. Two real defects found while reading (not fixed here)

Both are recorded in `docs/BUGS.md`.

- **B-060 — the ambient drift's rate ignores the manifest's fps.** `Camera.tsx` and
  `lib/draw.ts`'s `ambientDrift` both compute their sinusoid from `design.fps` (a hardcoded
  `30` token) rather than `useVideoConfig().fps`. At `fps: 60` the drift oscillates at twice its
  intended wall-clock rate; at `fps: 24`, slower. Deterministic and small (±3 px), so it is a
  correctness/consistency defect rather than a visible break at the default fps — but it means
  the same manifest rendered at two frame rates is not the same motion.
- **B-061 — the Motion Inspector labels camera keyframe times in the wrong unit.**
  `propCatalog.ts`'s `CAM2D_KEY_FIELDS`/`CAM3D_KEY_FIELDS` label `at` as **"At (frame)"**. The
  manifest stores it in **seconds** (`schema.ts`: "All times are in SECONDS"; `Video.tsx`:
  `Math.round(k.at * fps)`). Every other timing field in the same Inspector is correctly
  labelled "(s)". A user typing `48` meaning frame 48 gets 48 seconds.

---

## 7. Honest gaps and open questions

1. **Nothing here was seen running.** This sandbox cannot launch the Tauri window — the same
   disclosed constraint every entry since D-125 carries. §2c's account of the owner's
   screenshot is derived from the manifest and the primitives' source, and the camera arithmetic
   is exact; **the text-width figure in finding 3 is an estimate**, because measuring Kalam's
   real glyph metrics needs a browser. Findings 1, 2 and 4 do not depend on it.
2. **§3a's measure-the-DOM technique is reasoned from the transform's shape and from
   `getBoundingClientRect`'s documented post-transform semantics — it has not been run against a
   live `<Player>` here.** It is the kind of claim that deserves a 30-minute spike (mount the
   player, log `worldRect.width / manifest.width` against a known `playerScale × zoom`, at two
   frames of a camera move) before Phase 1 is built on it. That spike is the first task, not a
   formality.
3. **§3d's `of`-attaches-to-a-layer variant has an unresolved determinism question** — a
   measure-then-draw pass inside `remotion render` must be proved pure per frame against the
   project's "same doc + same frame ⇒ identical pixels" invariant. Hence the recommendation to
   ship the Inspector "snap to layer" action first, which has no render-path exposure at all.
4. **Should the builder ever offer a screen-space drag mode?** After Effects exposes World /
   View / Local as an explicit choice (§3c). This note recommends world-only, because it is the
   store's own space and the only one that survives a camera move — but a "nudge it where it
   looks right at this frame" mode is exactly what a human eyeballing a frame wants, and it is a
   real product question for the owner, not a technical one.
5. **The `× 1.18 / × 1.5` scribble inflation is undocumented anywhere the author can see it**
   (§2c finding 2). Whether to keep it, name it in `design.ts`, or drop it in favour of an
   explicit `pad` is a small design call this note does not make.
6. **Multi-timeline / a Motion composition as an Edit-tab pool item** stays where
   `product-direction.md` §9 left it — flagged, deferred, not designed. Nothing here changes it.
7. **This note deliberately scopes the Motion tab only.** The Edit tab has its own overlay
   (`TransformOverlay.tsx`, D-136) and the Colorist tab has an older Konva stack; whether the
   three ever unify is the same question `on-canvas-transform.md` left open, and it is not
   answered by adding a fourth.

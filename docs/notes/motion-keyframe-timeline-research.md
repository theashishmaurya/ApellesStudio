# Motion keyframe timeline — scoping (2026-09-05)

**Where this came from.** Owner, live, in his own words, quoted in full at the top of
`docs/notes/motion-visual-builder-research.md` (this doc's own prerequisite reading): *"we
should have a timeline as well for everything, an animation timeline w[h]ich [shows] when [it]
start[s], when [it] ends etc. Right?"* That doc scoped and built Phases 0-4 of the resulting
visual-builder plan (D-155 through D-159, all merged to `main` before this pass started) — DOM
hooks, click-select/drag/resize/snap-to-layer, a layer transform wrapper, multi-select/marquee/
align-distribute, and per-layer keyframes on that wrapper. Its own **Phase 5** section is the
one part of the plan that was named but never built: *"a time ruler under the preview, one row
per layer, keys drawn as diamonds you can drag along time, box-select and nudge them, a curve/
easing editor, and time-scrubbing coupled to the player… there is no small version of it,"* filed
as **"a major feature. Name it as one."**

**This doc is that phase's own scoping pass, plus the first real slice built on top of it.**
Per the task that produced it: verify the existing scoping and the Edit tab's own timeline by
reading the real code (not trusting either doc's prose), form an independent reuse-vs-rebuild
verdict, phase the remaining work, and then build the smallest genuinely useful slice — not the
whole thing in one pass.

**The headline finding, up front:** the Phase 5 doc's own "deliberately cheaper intermediate" —
*"`LayerList` grows a per-layer key count + a keys sub-row, the player's scrubber gains key
markers for the selected layer… not a timeline; enough to see that keys exist and to jump
between them"* — is exactly right, and is what this pass builds, under a new name (**Phase 5a**,
continuing the existing numbering) rather than as an afterthought. One piece of it needed a real,
disclosed design deviation: **Remotion's own player scrubber has no attachment point for extra
markers** (verified this pass, §3below) — so "the player's scrubber gains key markers" is built
instead as a small, purpose-built strip alongside the player, not a modification to Remotion's
own control bar. The full drag-a-diamond-along-a-ruler timeline (Phase 5b) is scoped in §4 and
explicitly **not** attempted here — it is real, multi-week surgery for reasons this doc verifies
independently, not just repeats from the earlier note.

---

## 1. Re-verifying the existing keyframe foundation (D-155 through D-159)

Every claim below was confirmed by reading the real file this pass, not by trusting either the
research doc's own prose or the decision-log write-ups (which are themselves honest and match
the code, but "the doc says so" is not this codebase's evidentiary bar).

- **`schema.ts`'s `transformKey`** (`{at, x?, y?, scale?, rot?, opacity?, ease?}`, `at` in
  seconds) lives on `layer.transform.keys` — confirmed at `packages/motion-engine/src/engine/
  schema.ts:91-159`. Every field is an additive delta on the static `layerTransform` field of the
  same name (the doc comment's own "uniform additive rule" claim, confirmed against the object
  literal itself, not just the comment above it).
- **`cam2dKey`/`cam3dKey`** (`schema.ts:51-74`) carry the identical `{at, ease?, …}` shape —
  `ease` a `z.tuple([number,number,number,number])`, B-059's fix. So there are, today, **three**
  independent places in a manifest a `{at:number}[]` array can live: `scene.camera`,
  `scene.scene3d.camera`, and any 2D layer's `layer.transform.keys` — a real keyframe timeline
  has to show all three, not just layers, confirmed by re-reading the task's own framing against
  the schema rather than assuming "keyframes" means only layers.
- **`interpolateKeys`** (`packages/motion-engine/src/lib/interpolateKeys.ts`), read in full: one
  shared function, sorts keys by `at`, clamps outside the range, eases via `Easing.bezier`
  between the two keys surrounding the current frame. `Camera.tsx` and `Video.tsx`'s
  `renderLayers` both call it — confirmed by grep, not assumed from D-159's own write-up. This
  matters for §4: any real timeline's "what does dragging a key change" logic must interpolate
  through this SAME function, never a second copy, for the identical "getting this wrong is
  silent" reason `canvasGeometry.ts`'s own doc comment already states.
- **`manifestEdit.ts`** already has every read/write primitive a timeline needs: `layerTransformKeys`/
  `setLayerTransformKeys` (line 530/545), `selectedCamera2d`/`selectedCamera3d` (line 66/70),
  `setCamera2d`/`setCamera3d` (line 862/869), plus the auto-keyframe write path
  (`layerDragBase`/`upsertLayerTransformKeyXY`/`moveLayersByDeltaAutoKey`, D-159 §4). A real
  timeline's key-drag-along-time gesture would need a NEW write primitive (moving a key's `at`,
  not its `x`/`y`) that does not exist yet anywhere in this file — confirmed by grep: every
  existing writer touches a key's *value* fields, none touches `at`. That is real, net-new work
  for Phase 5b (§4), not something already sitting unused.
- **`build.ts`'s `sceneStartFrame`/`sceneDurationFrames`** (confirmed at
  `packages/motion-engine/src/engine/build.ts:19-34`) are the exact "scene start/duration in
  frames" math `<Series>` (`Video.tsx`) uses to lay scenes back to back. This pass's own strip
  (§2) uses them directly, and any future Phase 5b ruler must too — a second copy of this
  arithmetic would be exactly the class of drift D-159's own `interpolateKeys` extraction was
  written to prevent.
- **§1e of the visual-builder doc** ("only the scene under the playhead exists in the DOM") is
  re-confirmed still true and still load-bearing: a real per-layer *drag* gesture (Phase 5b) can
  only ever act on the current scene's layers, exactly like every canvas gesture D-156-158
  already built. A read-only marker display (this pass) has no such restriction — reading
  `scene.camera`/`layer.transform.keys` straight from the manifest needs no DOM at all, so this
  pass's markers can (and do) span the WHOLE composition, not just the current scene — a small,
  real capability improvement over "only what's currently mounted," worth stating explicitly
  since it is not true of every future Phase 5b gesture.

**Nothing in D-155-159 needs revisiting or was found stale.** This section is a confirmation
pass, not a correction one.

---

## 2. The Edit tab's own timeline — read directly, independent verdict

The task's own instruction was explicit: verify the "most of it isn't directly reusable, but the
cost is comparable" claim from `motion-visual-builder-research.md`'s Phase 5 section by reading
the real code, not by trusting that sentence. Files actually read this pass:
`packages/editor/src/TimelinePane.tsx` (2,948 lines), `packages/editor/src/timeline.ts` (1,740
lines), `packages/editor/src/timelineStore.ts` (408 lines), `packages/editor/src/ruler.ts` (85
lines, in full), `packages/editor/src/marquee.ts` (referenced via D-137's own decision entry, read
in full there), `docs/notes/dnd-kit-migration.md` (in full), and D-134/D-137's own decision-log
entries (in full, `docs/08-decisions.md`).

### 2a. What the Edit tab's timeline actually is, confirmed by import list

`TimelinePane.tsx`'s own imports (line 173-190):

```
import type { TimelineRow, TimelineAction } from '@xzdarcy/timeline-engine';
import { Timeline as TimelineEditor, type TimelineState } from '@xzdarcy/react-timeline-editor';
...
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
```

So the Edit tab's timeline is **two libraries wired together**: `@xzdarcy/react-timeline-editor`
(a `TimelineRow[]`, each holding `TimelineAction[]` — a clip with a `start`/`end` span and a
track index) drives clip lanes, same-track drag and edge-trim; `@dnd-kit/sortable` drives track
reorder and (per `dnd-kit-migration.md` and D-137's own decision entry) cross-track clip move.
`marquee.ts` layers a THIRD, hand-built gesture (box-select) on top of both, kept mutually
exclusive from the other two by DOM position (D-137's own load-bearing finding).

### 2b. The reuse verdict, per piece, with the evidence

| Piece | Verdict | Evidence checked this pass |
|---|---|---|
| `@xzdarcy/react-timeline-editor`'s `TimelineRow`/`TimelineAction` clip-lane model | **Not reusable.** | Its core unit is a `start`/`end` SPAN with trim handles and same-track drag built around resizing that span — the exact opposite of a keyframe, which is a durationless POINT on a continuous per-property axis. Forcing a key into a zero-or-epsilon-duration `TimelineAction` would fight the library's own drag/trim semantics (which assume two independent edges) at every turn, for a shape (a point, not a rectangle) the library was never built to represent. |
| `@dnd-kit/sortable`'s track-reorder (`SortableContext`/`useSortable`) | **Not reusable, and not needed.** | A keyframe timeline's rows are one-per-layer, in the SAME order `LayerList` already shows them (scene → camera → layers) — there is no "reorder the rows" operation a keyframe timeline needs; `LayerList`'s own order is already the source of truth for row order everywhere else in this tab. |
| `@dnd-kit/core`'s cross-track move (`useDraggable`/`useDroppable`/`DragOverlay`) | **Not reusable as-is, and arguably not the right tool even for Phase 5b.** | `@chroma/motion` has never taken a dependency on `dnd-kit` (confirmed: `packages/motion/package.json` has no `@dnd-kit/*` entry) — every drag gesture in this tab (D-156's move, D-157's resize, D-158's marquee) is built on native `pointerdown`/`pointermove`/`pointerup` listeners on `MotionCanvasOverlay.tsx`'s own `containerRef`, deliberately (its own doc comment explains why `@remotion/player`'s control bar makes a naive full-surface `pointer-events:auto` overlay unsafe, and native listeners on an ANCESTOR sidestep it). A Phase 5b key-drag-along-a-ruler gesture is the same CLASS of problem (drag a small handle within a bounded 1D track) `MotionCanvasOverlay.tsx` already solved for 2D — extending that established, already-verified native-listener pattern to a new 1D surface is a smaller, more consistent change than introducing `dnd-kit` into this package for the first time. Not a rejection of dnd-kit on principle (`dnd-kit-migration.md`'s own license/maintenance check still stands, MIT, active) — a call that THIS package's own established technique is the better fit for THIS gesture, made explicitly rather than defaulting to whatever the Edit tab happens to use. |
| `marquee.ts`'s box-select rectangle math (`rectFromPoints`-equivalent, `rectsIntersect`) | **Already independently reproduced, not reused verbatim — confirmed as the right call.** | `@chroma/motion`'s own `canvasGeometry.ts` already has `rectFromPoints`/`rectsIntersect` (D-158, for the 2D canvas marquee) — a SECOND independent instance of the identical technique, not an import from `@chroma/editor`. That's not an oversight: `@chroma/inspector`'s own package description states the house rule explicitly — *"no @chroma/ui dependency… neither tab package depends on the other"* — confirmed by reading `packages/motion/package.json` and `packages/editor/package.json` directly: `@chroma/motion` depends on `@chroma/motion-engine`/`@chroma/history`/`@chroma/inspector`, never `@chroma/editor`, and the reverse is equally true. A Phase 5b box-select-keys gesture should follow the SAME precedent: re-derive the (tiny, already-proven-portable) rectangle-intersection technique locally, never reach across the tab boundary. |
| `ruler.ts`'s `niceTickIntervalSeconds`/`formatTimecode` (pure, framework/DOM-agnostic, read in full — reproduced in §1) | **The one piece that is genuinely, algorithmically reusable — but not IMPORTABLE, for the same architectural reason above.** | Zero DOM, zero React, zero `@chroma/editor`-specific types — literally two pure functions over numbers. But the same house rule (`@chroma/motion` cannot depend on `@chroma/editor`) applies here too, confirmed against the same two `package.json`s. **Verdict: Phase 5b should copy the ALGORITHM (the "nice numbers" 1-2-5 progression + minimum-label-spacing technique), not the file** — a ~30-line, well-tested, single-purpose module is cheap enough to re-author locally, and inventing a THIRD shared low-level package for two small functions neither tab currently needs elsewhere would be over-engineering for what this phase actually requires. If a third consumer of this exact technique ever shows up, that is the point to reconsider a shared package — not before. |
| D-134 (thumbnail storage-level zoom decimation) | **Not applicable at all.** | Rust-side video-frame decode caching (`chroma::filmstrip`) for a completely different medium (video thumbnail tiles, not keyframe diamonds) and a completely different cost profile (an `ffmpeg` decode vs. a `.map()` over an in-memory array). Read in full to check for a transferable ZOOM-LEVEL-CHOICE technique (there might have been a generic "nice zoom step" idea under the caching); there isn't one — the zoom steps there are powers of two chosen for storage-decimation alignment, not for on-screen tick density, which is `ruler.ts`'s job, already covered above. |
| D-137 (marquee mutual exclusion by DOM position, not precedence) | **The TECHNIQUE is directly applicable and already reused twice — not the code.** | D-158's own decision entry (`docs/08-decisions.md`) already applied this exact discipline a second time, on a FOURTH pointer gesture sharing `MotionCanvasOverlay.tsx`'s surface, adapting D-137's class-list exclusion (which doesn't exist on `@remotion/player`'s control bar) to a DOM-containment check (`[data-motion-world]`) instead — confirmed by reading that file's own doc comment. Phase 5b's timeline strip would be a THIRD application of the same discipline (separating "drag a key," "box-select over empty track," and "click to seek/scrub" on one surface), following the same precedent, not reusing a line of code. |

### 2c. The honest bottom line

**The earlier doc's framing — "a different shape (keys on a continuous axis, not clips in
lanes) so most of that is not directly reusable, but the *cost* is comparable" — is confirmed,
independently, verdict by verdict, above.** Nothing in the Edit tab's timeline stack
(`@xzdarcy/react-timeline-editor`, `@dnd-kit/sortable`, `@dnd-kit/core`) transfers as CODE. Two
things transfer as TECHNIQUE, cheaply: `ruler.ts`'s tick-density algorithm (copy the ~15 lines of
logic, don't import the file) and D-137's DOM-position gesture-separation discipline (already
proven twice over in this exact package). The COST claim also holds up under this reading:
`TimelinePane.tsx` is 2,948 lines and four decisions deep (D-094 through D-137 alone); a Phase 5b
timeline strip starts from zero UI and would need its own ruler, its own row layout, its own
drag-a-point gesture, its own box-select-over-a-1D-axis, and its own curve/easing editor — a
comparable amount of net-new surface, just none of it inherited.

---

## 3. Phase 5's own literal wording, checked against what's actually buildable

The Phase 5 section says: *"the player's own scrubber gains key markers for the selected layer."*
Checked directly against `@remotion/player`'s bundled source this pass (the same file D-156's own
decision entry already read for a different reason): `PlayerControls.js` renders Remotion's own
play/pause/scrub/fullscreen chrome with **no distinguishing class, no data attribute, and no
documented extension point for injecting extra markup into its scrub bar** — the same finding
D-156 already made and D-158 re-confirmed for a different purpose (why `MotionCanvasOverlay`
can't safely sit `pointer-events:auto` across the whole player). `@remotion/player`'s public
`<Player>` props were also checked (`node_modules/@remotion/player/dist/cjs/*.d.ts`): `controls`
is a boolean toggle for the WHOLE built-in bar, not a slot system — there is no
`renderScrubber`/`renderTimeline`-style prop.

**So "the player's own scrubber gains markers" cannot be built as literally worded without either
forking Remotion's bundled controls or replacing them outright (`controls={false}` + a fully
custom play/pause/scrub bar built from `PlayerRef`'s own imperative API) — the second option is
real, buildable, and would ALSO be most of a real timeline's own transport bar, which is exactly
the kind of scope creep this phase is trying to avoid.**

**Resolution, made and documented rather than silently reinterpreted:** build a small, separate
strip ALONGSIDE the existing (untouched) Remotion player, not a modification to it — the same
"DOM sibling, positioned near it" shape `MotionCanvasOverlay.tsx` already uses for the canvas
overlay. It reads `PlayerRef.getCurrentFrame()`/subscribes to the SAME `frameupdate` event
`MotionCanvasOverlay.tsx` already uses (verified: identical `player.addEventListener('frameupdate',
…)` call, same file, `MotionCanvasOverlay.tsx:346`) to track the playhead, and calls
`PlayerRef.seekTo(frame)` (also already used, `MotionTab.tsx`'s own `onSelect`) to jump it. This
satisfies the doc's own INTENT — "see that keys exist, jump between them, time-scrubbing coupled
to the player" — through a genuinely simpler, lower-risk mechanism than the literal wording
implies, and is disclosed here as a real deviation rather than left for a reader to notice later.

---

## 4. Phased breakdown

Continuing the numbering `motion-visual-builder-research.md`'s own Phase 5 established, rather
than starting a fresh scheme — this is a subdivision of that phase, not a new one.

### Phase 5a — key visibility. **Built this pass.**

Exactly the earlier doc's own "deliberately cheaper intermediate," taken seriously rather than
treated as a lesser fallback:

- `LayerList.tsx`: every row that can carry keys (a layer with `transform.keys`, a scene's 2D
  camera, a scene's 3D camera) shows a small key-count badge when that count is `> 0`.
- A new **keyframe strip** rendered under the live player (`MotionPreview.tsx`): a single
  horizontal bar spanning the WHOLE composition's frames (not just the current scene — §1's own
  finding that reading keys needs no live DOM), showing: scene-boundary tick marks, a diamond
  marker for every camera key (2D or 3D, any scene — camera data is read straight off the
  manifest, no "is this scene mounted" restriction applies), a differently-styled diamond marker
  for the CURRENTLY SELECTED layer's own `transform.keys` (only ever one layer's keys at a time —
  see the single-selection scoping call below), and a live playhead line. Click anywhere to
  seek/scrub; click a marker to jump exactly to that key's frame.
- **No manifest mutation of any kind.** This phase is pure navigation/visibility — no drag, no
  write path, so D-155's commit/undo discipline does not apply to it (the same reason `LayerList`
  row clicks, which also only ever seek the player, have never needed it either).
- **Single-selection only, matching `TransformKeysSection`'s own existing scoping call
  (D-159 §5).** That section's own doc comment already establishes the precedent this phase
  reuses rather than re-deriving: a per-layer keyframe LIST has no well-defined lockstep meaning
  across a multi-selection (different row counts, different `at` values, different field
  coverage) — the identical reasoning applies to a keyframe-strip's markers, so the strip shows
  camera keys always, plus a single selected layer's keys when exactly one `{kind:'layer'}` is
  selected, and no layer markers at all otherwise (0 or 2+ selections, or a non-layer selection).
- **Size: matches the earlier doc's own estimate — days, not weeks.** No schema change, no
  engine change, no new dependency, no drag gesture, real pure logic with real tests
  (`keyframeVisibility.ts`, §5 below) plus DOM/pointer wiring for the strip and the click-to-seek
  handler (untested per this package's own established split — see `MotionCanvasOverlay.tsx`'s
  own precedent).

### Phase 5b — a real keyframe timeline. **Not built. Still "a major feature," confirmed independently in §2.**

What Phase 5a deliberately does not attempt, scoped honestly rather than left vague:

- **Drag a key along time.** Needs a genuinely new write primitive in `manifestEdit.ts` — moving
  a key's `at` field for `layer.transform.keys`, `scene.camera`, or `scene.scene3d.camera` — none
  of which exists today (§1's own grep confirms every current writer touches a key's VALUE
  fields, never `at`). This needs the same transient-preview/commit discipline D-155/D-156
  already established for a position drag, applied to a 1D time axis instead of a 2D canvas.
- **A per-row lane, one per layer/camera, with a shared time axis and independent zoom.** This is
  where `ruler.ts`'s ALGORITHM (not its code, §2b) gets reused, and where a real row-layout
  problem shows up that Phase 5a's single flat strip sidesteps entirely: Phase 5a has exactly one
  "track" (the whole strip); a real timeline needs N tracks (one per layer + one per camera),
  each independently scrollable/selectable, which is genuinely most of what makes
  `TimelinePane.tsx` 2,948 lines in the first place (row virtualization/height math, per-row
  selection state, a real vertical scroll region synced to `LayerList`'s own row order).
- **Box-select + nudge multiple keys at once.** The rectangle-intersection technique is cheap
  (§2b — already proven portable once at D-158); the SELECTION MODEL is the real work — a
  `{trackId, keyIndex}[]`-shaped selection distinct from `Selection[]` (which points at
  LAYERS/cameras, not individual keys within one), and a nudge-many-keys-by-one-shared-delta
  write path analogous to D-158's `moveLayersByDelta`, but for `at` values instead of `x`/`y`.
- **A curve/easing editor.** Every key already carries an optional `ease` (a raw 4-tuple,
  editable today only as JSON text via `LAYER_TRANSFORM_KEY_FIELDS`'/`CAM2D_KEY_FIELDS`' `ease`
  field, D-159 §5). A real bezier-curve-with-draggable-handles editor is a genuinely separate,
  self-contained UI component (closer to a color-picker than to the timeline strip itself) that
  could, honestly, ship independently of the rest of Phase 5b if it turns out to be higher value
  sooner — worth naming as a possible OWN sub-slice rather than assuming it must wait for the
  full timeline.
- **Time-scrubbing coupled to the player, for real (not just click-to-seek).** Phase 5a's strip
  already does click/marker-click-to-seek; a real timeline additionally wants continuous drag-
  scrub (mousedown-and-drag anywhere on the ruler updates the playhead live, not just on release)
  and likely a visible "current time" readout — small on top of Phase 5a's own plumbing, but real
  UI work, not free.

**Recommended order within 5b, if/when it is picked up:** the drag-a-key gesture first (the
single most direct payoff — "see it, drag it" — and the smallest of the four in isolation, since
Phase 5a's strip is already most of its visual chrome), then per-row lanes (the real
infrastructure investment), then box-select, then the curve editor last (genuinely independent,
lowest coupling to the rest). Not re-scoped further here — per the task's own instruction, this
is a phase to name and estimate honestly, not to fully design before it's picked up.

**Explicitly out of scope for 5a AND 5b, inherited unchanged from the parent doc:** `scene3d`
child on-canvas manipulation, any change to the world-space storage model, and — new to this
doc — moving a KEY between layers/cameras (nothing has asked for it, and there's no coherent
manifest operation "this camera's keyframe is now this layer's keyframe" would mean).

---

## 5. What was actually built this pass (Phase 5a)

- `packages/motion/src/keyframeVisibility.ts` (new) — pure functions, real tests
  (`keyframeVisibility.test.ts`): `layerKeyCount`/`cameraKeyCount`/`scene3dCameraKeyCount` (the
  `LayerList` badges), `cameraKeyMarkers` (every 2D+3D camera key across the whole manifest,
  converted to absolute frames via `sceneStartFrame`), `selectedLayerKeyMarkers` (the current
  single-layer selection's own `transform.keys`, same conversion), `sceneBoundaryFrames`, and
  `frameToPercent` (the strip's own pixel-free positioning math, kept as a real tested function
  rather than an inline one-liner per this package's own "getting this wrong is silent" standard
  for anything that turns a frame number into a screen position).
- `LayerList.tsx`: each row's label gets an optional trailing key-count badge, computed via the
  new module — scene rows unaffected, camera/3D-camera/layer rows show a badge when their own
  count is `> 0`.
- `packages/motion/src/KeyframeStrip.tsx` (new) — the DOM component: renders under the player
  inside `MotionPreview.tsx`, subscribes to the SAME `frameupdate` event
  `MotionCanvasOverlay.tsx` already uses, click-to-seek + per-marker click-to-jump via
  `PlayerRef.seekTo`. DOM/pointer wiring, deliberately untested per this package's own
  established split (`MotionCanvasOverlay.tsx`'s own precedent) — the pure math it calls is what
  carries the test coverage.
- `MotionPreview.tsx`: restructured to a column layout (player+overlay on top, the new strip
  fixed-height beneath) — no other prop/behavior changes.

See `docs/08-decisions.md`'s **D-160** entry for the full verification record (tsc, vitest counts,
`remotion still` — N/A this pass, no engine/schema touch — and the honest gaps).

---

## 6. Cross-reference

`docs/notes/motion-visual-builder-research.md`'s own Phase 5 section now points here for the
scoped breakdown and the built slice, rather than duplicating this doc's content — see that
section's own added pointer.

## 7. Phase 5b, part 1 — "drag a key along time" — built (D-161, 2026-09-05)

The first of §4's own four named pieces, built in its own pass on top of Phase 5a, in the order
that section itself recommended ("the drag-a-key gesture first... the smallest of the four in
isolation"). The new write primitive this section predicted would be needed —
`manifestEdit.ts`'s `moveKeyAt` (one generic core over `layer.transform.keys`/`scene.camera`/
`scene.scene3d.camera`, plus three thin wrappers) — reorders past a neighboring key rather than
clamping (`interpolateKeys` already re-sorts by `at`, so array position was never meaningful to
anything downstream) and boundary-clamps to `[0, scene.dur]`, the dragged key's own scene.
`keyframeVisibility.ts` gained `percentToFrame` (the pointer-position→frame inverse of
`frameToPercent`) and a `keyIndex` field on `KeyMarker`. `KeyframeStrip.tsx`'s drag reuses D-155's
transient-preview/commit discipline through the same `onTransientChange`/`onCommit`
`MotionCanvasOverlay.tsx` already uses, applied to the 1D time axis exactly as this section
anticipated — with one real design problem discovered while building it, not predicted here in
advance: re-deriving the strip's marker list from a live-reordering transient manifest mid-drag
would risk React remounting the dragged marker's own `<button>` (its `keyIndex` can shift once
the drag crosses a neighbor) and silently dropping its `setPointerCapture`. Solved with a small
local `dragPreview` overlay on top of a marker list that stays derived from the STABLE manifest
for the whole gesture. Full writeup, edge-case reasoning, and verification: `docs/08-decisions.md`'s
**D-161** entry.

**Still not built at the time this section was written: the other three pieces** — per-row lanes
(one track per layer/camera, the real row-layout infrastructure investment §4 named as the bulk
of the remaining work), box-select + nudge multiple keys, and a curve/easing editor. Recommended
order unchanged from §4's own original call: lanes next, then box-select, then the curve editor
last. **Per-row lanes are now built — see §8 below.**

---

## 8. Phase 5b, part 2 — "per-row lanes" — built (D-162, 2026-09-05)

The second of §4's own four named pieces, built in its own pass on top of Phase 5b part 1 (D-161),
in §4/§7's own recommended order. This is the piece §4 itself named as "genuinely most of what
makes `TimelinePane.tsx` 2,948 lines in the first place" — row virtualization/height math, per-row
selection state, a real vertical scroll region synced to `LayerList`'s own row order — and it is
built accordingly as a real restructuring, not a patch on top of the flat strip.

**The row model.** `keyframeVisibility.ts`'s new `keyframeLanes(manifest)` is the "which rows
exist, in what order" pure function §4 asked for: one row per (scene, 2D camera) with `>0` keys,
one per (scene, layer) with `>0` `transform.keys`, one per (scene, 3D camera) with `>0` keys —
never for an un-keyed layer/camera or for a scene row itself, mirroring `LayerList.tsx`'s own
"badge only when count > 0" precedent (D-160) applied to whether a ROW exists at all. Row order is
scene order, then camera → layers → 3D-camera within a scene — exactly `LayerList.tsx`'s own
render order. `laneKeyMarkers(manifest, lane)` and `selectionForLane(manifest, lane)` are the
per-lane replacements for D-160's whole-manifest `cameraKeyMarkers` and selection-scoped
`selectedLayerKeyMarkers`, both retired this pass (not kept alongside as a second, redundant read
path). A real capability improvement falls out of this for free: because a lane already names its
own exact (scene, layer), ANY keyed layer's keys can now be seen — and dragged — without first
selecting that layer via `LayerList`, unlike the flat strip, which only ever showed the CURRENTLY
SELECTED layer's markers.

**The layout call, made explicitly rather than left as an assumption.** D-160 put the flat strip
inside `MotionPreview.tsx`, squeezed under the player in a `flex flex-col` column — fine for a
fixed 24px bar, unworkable for N independently-scrollable rows needing their own resizable height.
Both real precedents were read before deciding (not just the reuse-verdict already in §2): the
Edit tab's own `EditorTab.tsx` puts `TimelinePane` in its own row below `PreviewPane`, inside the
SAME left `ResizablePanel` (`packages/editor/src/EditorTab.tsx:112-147` — a nested vertical split,
`h-[46%] min-h-[180px]`), NOT nested inside the preview component itself, with the Inspector as a
further sibling column outside that whole stack. `packages/editor/src/TimelinePane.tsx` was read
for its row/track layout and scroll handling as genuine precedent (not just the D-160 reuse
verdict) — its own scroll region is a single scrollable div per its `@xzdarcy/react-timeline-
editor` embed; nothing from it was imported (per §2's own verdict, unchanged), but it confirmed
that a real timeline needs its own dedicated scroll region, not a shared one squeezed into a
sibling's leftover space. **Decision: `KeyframeTimeline.tsx` moved OUT of `MotionPreview.tsx` into
a new full-width sibling panel in `MotionTab.tsx`'s own layout** — a nested VERTICAL `PanelGroup`
inside the tab's existing left `ResizablePanel` (`<MotionPreview>` over `<KeyframeTimeline>`, a
real `ResizableHandle` between them), the same relative shape `EditorTab.tsx` uses one nesting
level shallower (Motion's left panel is itself one of four sibling columns in the tab's outer
horizontal group, where Edit's left panel has no other siblings inside it — Motion's Inspector and
manifest-editor panes stay OUTSIDE this nested group entirely, matching how Edit's own Inspector
sits outside its preview+timeline stack). `MotionPreview.tsx` reverts to exactly its pre-D-160
shape — no opinion about a keyframe timeline at all.

**Shared time axis, independent zoom — a genuinely new mechanism, not the Edit tab's D-134
system.** `timelineZoom.ts`'s `trackWidthPx(totalFrames, fps, pxPerSecond)` sizes every lane's
track div and the ruler's own track div identically, so a frame's `left: N%` position
(`frameToPercent`, unchanged by zoom — percent-of-the-same-width stays correct at any zoom) lands
at the same pixel column in every row: one shared axis. Zoom is ONE `pxPerSecond` value for the
whole timeline, not per-row — a per-row zoom was considered and rejected explicitly: rows would
stop agreeing on where in time a pixel column sits, defeating the point of drawing a scene
boundary or the playhead once across all of them. D-134's own bounds (`MIN_PX_PER_SEC`/
`MAX_PX_PER_SEC`, `ruler.ts`) were confirmed (again, independently of the §2b reuse-verdict) to be
sized around `chroma::filmstrip`'s Rust-side video-thumbnail decimation ladder — no equivalent
exists in this package at all, so `timelineZoom.ts`'s bounds (`10`–`400` px/sec) are chosen fresh,
for what looks usable in a resizable panel a few hundred px tall.

**The ruler.** `timelineRuler.ts` re-authors (does not import) `ruler.ts`'s `niceTickIntervalSeconds`/
`formatTimecode` verbatim-in-behavior — confirmed against that file directly this pass, not from
memory — plus a new `rulerTicks(totalSeconds, fps, pxPerSecond)` that walks the chosen interval
from `0` to the total, real tested loop-bound handling (no dropped/duplicated trailing tick).
Scene-boundary lines (`sceneBoundaryFrames`, D-160, unchanged) render on the ruler and on every
lane's own track.

**Vertical + horizontal scroll, one region, no virtualization library.** The whole ruler+lanes
stack lives inside one `overflow-auto` div; each lane's own label column is `position: sticky;
left: 0`, the ruler row is `position: sticky; top: 0` with its own corner cell sticky on both axes
— the standard "frozen row + frozen column" CSS technique. Real and working at the row counts this
engine's manifests have (one row per keyed layer/camera, not per video frame) — a genuine
virtualization library was judged unnecessary for this phase, a call `TimelinePane.tsx`'s own much
larger, per-video-frame-timeline scale didn't have the luxury of making.

**Selection reuses `MotionTab.tsx`'s existing `onSelect` — no parallel mechanism**, per the task's
own explicit instruction: a click on a lane's label OR its own track background calls
`onSelect(selectionForLane(manifest, lane))`, the identical `Selection` shape `LayerList.tsx`'s row
click already produces (including the layer's own `id` snapshot, D-158). `onSelect` already seeks
the player to the scene's start frame (unchanged, `MotionTab.tsx`); a track-background click
additionally seeks to the exact clicked frame right after, so the more precise seek wins.

**D-161's drag gesture, generalized per row.** The write primitives
(`moveLayerTransformKeyAt`/`moveCamera2dKeyAt`/`moveCamera3dKeyAt`, `manifestEdit.ts`) are
unchanged; what changed is where they get their target from — the LANE the pointer landed in,
never the tab's live `selections`, which is what makes "drag any keyed layer's keys, not just the
selected one" possible. D-161's own "live visual feedback without touching marker identity
mid-drag" finding (re-deriving a marker list from a live-reordering transient manifest can remount
the dragged button and drop `setPointerCapture`) still applies WITHIN one row exactly as before;
the `dragPreview` override is now scoped by `{laneKey(lane), keyIndex}` rather than `{kind,
sceneIndex, keyIndex}`, since two DIFFERENT layers in the same scene can now each have their own
`keyIndex === 0` marker (each gets its own row).

Full writeup, verification, and honest gaps: `docs/08-decisions.md`'s **D-162** entry.

**Still not built: the other two pieces** — box-select + nudge multiple keys, and a curve/easing
editor. Recommended order unchanged from §4's own original call: box-select next, then the curve
editor last.

# On-canvas clip transform (PIP handles) — scoping (2026-09-04)

Owner, live, with a screenshot of the preview: *"the player is canvas — once I have another
video I can select, drag and make it smaller or larger, PIP etc."* Multi-layer stacking is
already real (D-088); what's missing is being able to **grab the overlaid clip in the
program monitor and move/resize it directly**, instead of typing numbers into the
Inspector.

This note is the scoping pass. **Nothing here was built when it was written** —
deliberately, because scoping turned up two real prerequisites (below) that would make
handles feel broken if they were built on top of today's model as-is. *(Phase 3 has since
been built — see **STATUS** immediately below for what is and isn't real as of the D-132
pass; the phase sections themselves are annotated in place.)*

Companion finding from the same pass: **crop** — see "Where crop actually stands" at the
end, plus B-042 / D-127.

---

## STATUS (updated 2026-09-04 night, D-136) — what is now built, what is not

The owner came back to this the same evening, live: *"no UI for crop"*, *"no canvas on
player to do it."* That is Phase 3 and Phase 1 of this note respectively. **D-132 built
Phase 3's data + compositor + Inspector half. D-136 built Phase 0a's code (closing B-043)
and Phase 1's actual on-canvas handles.** Phase 2, Phase 4, and crop's own on-canvas mode
remain exactly as scoped below — plans, not code. Precisely:

| Section below | Status after D-136 |
|---|---|
| **0a — composition-space units** | **Built.** The timeline has a real composition space (`ProjectSettings.width`/`height`, or the first clip's probed resolution as fallback); `composite_video_frame`'s canvas is that composition, not the top layer's decode; `Clip::position_x`/`position_y` are normalised fractions of it. Existing pixel-valued positions are migrated via a real schema-minor gate on `chroma.project` (`1.1`, `Timeline::normalise_legacy_positions`), not silently reinterpreted in place. **B-043 closed.** See D-136 in `docs/08-decisions.md` for the full reasoning, including why this could only ever be a stated reinterpretation of the old values, not a recoverable conversion. |
| 0b — one undo entry per drag | **Built**, as part of Phase 1: `TransformOverlay.tsx` keeps drag state local and uncommitted, applying exactly one `set_clip_transform` on pointer-up — the `RelightPuckLayer` pattern this section anticipated. |
| **1 — select / move / corner-scale handles** | **Built.** `packages/editor/src/TransformOverlay.tsx`, a DOM overlay sibling of `PreviewPane`'s `<img>`. Content-box math extracted into `@chroma/player`'s new `useContentBox` (the original `useImageRenderSize.ts` stays in place, still owning every Colorist-tab call site — migrating those is separate, deliberately deferred work). Reads the existing `selection`, writes the existing `set_clip_transform` op. Box/drag/corner-scale math lives in `packages/editor/src/transformGeometry.ts`, pure and unit-tested (16 tests) since this package's vitest has no DOM. A new `chroma_timeline_clip_geometry` Tauri command supplies the one thing the frontend can't derive itself — a clip's own source footprint against the composition. |
| **1b — click the picture to select** | **Built 2026-09-07 (D-204)**, fixing B-085 — the one thing that kept Phase 1's handles reachable only from the timeline. `useCanvasClipPick.ts` (a capture-phase decision on the preview surface, not a z-ordered hit layer — see Open Question 3 for why that distinction is the whole problem) + `canvasPick.ts` (pure hit-testing that mirrors `resolve_visible_video_layers_at`). No backend change needed; Open Question 3's own premise that one was required turned out to be wrong. |
| 2 — rotation, anchor point, non-uniform scale | Rotation, anchor point: not built. **Non-uniform scale: built, Inspector-only, 2026-09-07 (D-193, `docs/notes/independent-clip-size.md`)** — `Clip.box_width`/`box_height`, an independent-axis box-size override with its own Width/Height/ratio-lock Inspector control, correctly rendered by the Rust live-preview compositor and the export compiler. Deliberately NOT extended to on-canvas DRAGGING here: `TransformOverlay.tsx`'s corner handles stay uniform-only by design (this note's own original Phase 1 scope), and committing a corner drag explicitly re-uniforms the box (clears the override) rather than silently only-partially respecting it — see D-193's own decision entry for the full "why." A future pass could add non-uniform on-canvas handles on top of this same persisted field; not attempted this pass. |
| **3 — crop** | **Built, minus the on-canvas mode.** Real `crop_left`/`crop_top`/`crop_right`/`crop_bottom` on `Clip`, really applied by `composite_layer_onto`, a real Crop section in the Edit-tab Inspector, keyframeable through the existing engine. **Phase 1's overlay substrate now exists**, but crop still has no edge handles or Resolve-style mode toggle of its own — its bounding box happens to be unaffected by crop (`composite_layer_onto` crops a layer's pixels in place without shrinking its footprint), so Phase 1's box is correct for a cropped clip by accident, not because crop has any on-canvas affordance yet. |
| 4 — keyframes | Crop keyframes work exactly as the other five fields' do (explicit "Add key"). The auto-keyframe-on-drag question is still open — Phase 1's overlay writes the static/base transform, same as the Inspector's numeric fields always have. |

Also fixed on the way through D-132, because crop would have been invisible without it:
**B-053** — the single-layer preview path skipped compositing unconditionally, so a lone
clip's opacity/position/scale/rotation (and any crop) were silently discarded. See that
bug and D-132. D-136 additionally tightened that same fast path's guard: a lone clip now
also needs its own source resolution to equal the composition's before it can skip the
real compositor — a smaller source must still render at its true, smaller footprint.

---

## What exists today, verified

### The data + the numeric path — real, and the right thing to drive

`chroma_timeline::Clip` (`crates/chroma-timeline/src/lib.rs`) carries a real compositing
transform: `opacity`, `position_x`, `position_y`, `scale`, `rotation` (D-082), plus
D-034-shaped `chroma_keyframes` over those same fields. `app/src-tauri/src/chroma/edit.rs`'s
`composite_video_frame` / `composite_layer_onto` really consume them (scale → rotate →
alpha-multiply → `image::imageops::overlay` centred + offset). `ClipInspectorPanel.tsx`
edits them; `EditorInspectorPanel.tsx`'s `applyTransform` commits one
`{kind: 'set_clip_transform', …}` op through `useEditorTimelineStore.applyOp`.

**On-canvas handles must write that same op.** No parallel mechanism, no second source of
truth — a drag is just another producer of `set_clip_transform`, exactly as the numeric
inputs are.

### The preview surface — **not** a canvas

The owner's mental model ("the player is canvas") is the one thing that isn't true, and it
changes the design:

`packages/editor/src/PreviewPane.tsx` renders **a plain `<img>`** whose `src` is a
`data:image/jpeg;base64,…` string returned by the `chroma_timeline_frame` Tauri command.
The compositing happens **in Rust, on the CPU**, per frame, on demand. There is no
`<canvas>`, no WebGL context, no GPU surface, and no client-side scene graph in the Edit
tab at all. `<Player>` (`packages/player/src/Player.tsx`) is explicitly agnostic — it
renders whatever `surface` ReactNode the tab hands it, inside
`<div class="flex-1 min-h-0 flex items-center justify-center overflow-hidden">`.

Two consequences, both real:

1. **Handles are DOM/SVG, not canvas hit-testing.** This is *good news* — an
   absolutely-positioned overlay div over the `<img>` gives real hit-testing, real
   pointer capture, real focus/keyboard, and real theming from the token system for free.
   No picking buffer, no manual z-order, no re-implementing cursors.
2. **There is no cheap live re-render.** Every visual update of the *composited picture*
   costs one IPC round-trip → `ffmpeg` decode of every visible layer → CPU composite →
   JPEG encode → base64 → `<img>` decode. That is nowhere near interactive-drag rate. A
   drag therefore cannot "just re-fetch the frame on every pointermove."

### On-canvas precedent already in this repo (three of them, all real)

| Existing | Where | Model | Fit for this? |
|---|---|---|---|
| Relight light pucks | `app/src/components/panel/editor/RelightPuckLayer.tsx` (D-046) | `absolute inset-0 pointer-events-none` overlay holding `pointer-events-auto` markers; screen↔image space via `useImageRenderSize`; **live preview while dragging, commit on pointer-up** | **Closest match.** Same overlay + drag-state + commit-on-release shape. |
| Mask shape transformer | `ImageCanvas.tsx`, `react-konva` `<Transformer>` | Konva scene graph with a real bounding box + resize/rotate handles | Right *affordance*, wrong *substrate* — pulls a canvas library into a tab that has no canvas, for one box. |
| Crop rectangle | `CropPanel.tsx` + `react-image-crop` | Library-owned rect with edge/corner handles over an `<img>` | Correct substrate, but it is a **crop** rect (fixed frame, moving window), not a **transform** box (moving object). Different semantics; see Phase 3. |

`useImageRenderSize` (`app/src/hooks/useImageRenderSize.ts`) already does exactly the
letterbox math the overlay needs — `{scale, offsetX, offsetY, width, height}` for an
image drawn `object-contain` inside a container. **It cannot be imported as-is**: it lives
in `app/` and `packages/editor` may not reach into the app layer (D-039, one-way
`app → tabs → services → domain`). It has to be extracted first — recommend into
`@chroma/player`, which already owns the viewport and whose README already anticipates all
three tabs supplying their own `surface`.

---

## Real references checked (not designed from memory)

**Premiere Pro — Effect Controls ▸ Motion.** Selecting `Motion` in the Effect Controls
panel makes the handles and the clip's anchor point appear on the clip **in the Program
Monitor**. Drag a **corner** handle to scale freely; drag a **side** handle to scale that
one dimension only; **Shift**-drag a corner to scale proportionally. Changes made in the
Program Monitor and in the Effect Controls panel update each other both ways — one value,
two editors. Note the direction of the Shift modifier: Premiere's corner drag is *free*
by default and *constrained* with Shift.

**DaVinci Resolve — viewer onscreen controls.** A **mode selector at the bottom-left of
the viewer** switches the on-screen controls between **Transform** (pan / tilt / zoom /
rotate), **Crop** (top / bottom / left / right) and **Dynamic Zoom**, with a
white/grey enable button next to it. In Transform mode: drag a **diagonal corner** to
resize proportionally, drag a **side** to squeeze/stretch one axis, drag the **centre
handle** to rotate. In Crop mode each side has its own handle. Resolve also exposes a real
**Anchor Point X/Y** — the pivot rotation and scale act around — separately from Position.

**What both agree on, and what Chroma should take:**
- corner = scale, side = one-axis scale, centre/dedicated handle = rotate, body drag =
  reposition;
- **crop is a separate mode, not a modifier on the transform box** (Resolve makes this
  explicit with the mode dropdown; Premiere splits it into a separate Crop effect). That
  is a real argument for keeping crop out of Phase 1 rather than overloading edge handles;
- the panel and the canvas edit **the same values**, live, in both directions.

Sources (checked 2026-09-04, not recalled):
`https://helpx.adobe.com/premiere/desktop/add-video-effects/commonly-used-effects/apply-motion-effect.html`
· `https://helpx.adobe.com/be_nl/premiere-pro/using/motion-position-scale-rotate-clip.html`
· Blackmagic's DaVinci Resolve manual, "Onscreen Controls for Transform, Crop, and Dynamic
Zoom" and "Cropping" (mirrored at `steakunderwater.com/VFXPedia/__man/Resolve18-6/`;
the direct page 404'd on fetch, so the behaviour above is the cross-checked consensus of
several independent descriptions of the same documented control, not one source).

**Where they differ, and Chroma has to choose:** Premiere's corner drag is free and Shift
constrains it; Resolve's corner drag is proportional by default. Chroma's `Clip` has a
single uniform `scale` today (no `scale_x`/`scale_y`), so **proportional-by-default is the
only behaviour it can currently express** — which happens to match Resolve. Recommend
matching Resolve and deferring the modifier question to Phase 2, when non-uniform scale
becomes representable at all.

---

## Phase 0 — two real prerequisites found while scoping

Neither is optional. Handles built before these are fixed would be handles that visibly
lie about where the clip is.

### 0a. The composite's coordinate space is preview-resolution-dependent (B-043)

`composite_video_frame` builds its canvas from **the top layer's decoded pixel
dimensions** — and each layer is decoded through `decode_pipe::scale_target(w, h,
max_long_edge)`, where `max_long_edge` is whatever the *caller* asked for.
`PreviewPane.tsx` asks for `SCRUB_LONG_EDGE = 960` while paused and `PLAY_LONG_EDGE = 640`
while playing. So:

- `position_x`/`position_y` are **absolute pixels in that scaled canvas**. `position_x: 200`
  is 20.8 % of the width at 960 and 31.25 % at 640 — the overlay *moves* when you press
  play.
- `scale_target` returns `None` when a source already fits under the cap, so a 640×360
  overlay over a 4K background is 2/3 of the canvas at scrub and **exactly full-frame** at
  play — the overlay also *resizes* when you press play.
- The same offset means different things for a 4K source and a 720p source.

There is no timeline export path yet (`export_video` is Colorist's single-clip path only),
so nothing has yet had to answer "what resolution is the composition, really" — which is
exactly why this went unnoticed.

**Fix: give the timeline a real composition space.** `ProjectSettings.width`/`height`
(D-038) already exist and are already derived from the first clip, so the raw material is
there. Recommend: the composite canvas is the **project resolution**, every layer is
placed relative to it, and `position_x`/`position_y` become **normalised (fraction of
composition width/height) or composition-pixel** units — decided once, in a `D-NNN`,
because it's a `Clip` field-semantics change with a migration story (existing
pixel-valued positions in a saved `project.json` have to be reinterpreted or converted).
Preview scale then becomes a pure render-quality knob, as it should be.

Recommend **normalised** for `position_*`: it survives a project-resolution change, it's
the unit the drag math naturally produces (a pointer delta over a known content box is a
fraction), and it removes any need for the frontend to know the backend's decode scale.

#### DECIDED, 2026-09-04 (D-132): normalised, and this note's own recommendation stands — **BUILT, D-136 (same night)**

The recommendation above was re-read rather than re-derived, and it holds — the three
reasons it gives are each independently sufficient, and re-checking the code turned up
nothing that weakens them (`ProjectSettings.width`/`height` really do exist and really are
inferred from the first clip, D-038/`infer_settings_from_clip`; `scale_target`'s
`long <= long_edge → None` early return really does make a small layer full-frame at play
quality). The only thing the reasoning was missing is a name for what it buys:
**normalised units make the field correct at every preview scale by construction, rather
than correct once the canvas is fixed.** That distinction is why crop could ship today,
ahead of the canvas work — see below.

So, settled: **composition space is `ProjectSettings.width`/`height`, and geometry on a
`Clip` is normalised against it.**

Two consequences worth being explicit about, because they are what makes this a decision
rather than a preference:

- **`position_x`/`position_y` still have to be migrated, and that is the whole remaining
  cost of Phase 0a.** Existing values are absolute pixels in a canvas whose size depended
  on the preview quality *at the moment they were typed* — which is unrecoverable, not
  merely unconverted. There is no honest arithmetic that turns a stored `200` into the
  right fraction, so the migration is a judgment call (reinterpret against the project
  resolution, i.e. treat old values as composition pixels, and accept a one-time shift on
  projects that used PIP offsets) and it belongs in Phase 0a's own commit with its own
  before/after evidence — not smuggled into a crop change. **Built, D-136**: a real
  schema-minor gate (`chroma.project/1.1`) on `project.json`, so the reinterpretation runs
  exactly once per file rather than being detectable-or-not by chance.
- **D-132's crop does not wait for any of that.** Its four insets are normalised to the
  clip's **own source**, not to the composition, so they are already scale-invariant and
  already correct — the same reasoning, applied to a field whose natural reference frame
  is the layer rather than the canvas. That is not a shortcut around Phase 0a; it is the
  decision above being unit-correct from the first line of a new field instead of being
  retrofitted onto an old one.

### 0b. A drag must not push 60 undo entries per second

`useEditorTimelineStore.applyOp` pushes a whole-`Timeline` before/after snapshot onto
`@chroma/history` for **every non-no-op call** (D-051), and schedules a debounced
`chroma_timeline_set`. A naive `onPointerMove → applyOp` would flood the undo stack and
the save queue.

**Fix: the split `RelightPuckLayer` already uses** — local, un-committed drag state drives
the on-screen box live; exactly one `set_clip_transform` op is applied on `pointerup`. One
gesture, one undo entry. No store or history change needed; this is purely a discipline
the new component has to follow.

---

## The recommended build, phased

### Phase 1 — select, move, uniform corner-scale. Nothing else. — **BUILT (D-136)**

Smallest thing that is genuinely useful ("drag it, make it smaller") and stays inside what
the `Clip` model can already express.

- **A new `packages/editor/src/TransformOverlay.tsx`.** `PreviewPane` wraps its `<img>` in
  a `relative` div and renders the overlay as a sibling — no `@chroma/player` change
  needed (the `surface` prop is already "whatever ReactNode you like", by contract).
- **Content-box math extracted** from `app/src/hooks/useImageRenderSize.ts` into
  `@chroma/player` — a mechanical prerequisite of *this* phase, not one of Phase 0's two
  behavioural ones. Necessary because `packages/editor` may not import from `app/`
  (D-039's one-way dependency rule), and `@chroma/player` already owns the viewport all
  three tabs are meant to share. The `<img>` is `object-contain`, so the picture's real
  on-screen rect is not the element's rect.
- **Which clip?** (D-204 note: still true — canvas click-to-select sets that same
  selection rather than introducing a second one.) Reuse the existing selection —
  `useEditorTimelineStore.selection`, the
  same `Selection[]` the Inspector reads (D-107/D-118). The overlay draws a box for the
  one selected clip when `selection.length === 1`, and nothing otherwise (the same Phase-1
  multi-select fallback `EditorInspectorPanel` already applies). **Clicking on the picture
  to select is deliberately deferred**: it needs `chroma_timeline_frame` to also return
  *which layers are where*, which it doesn't today (it returns a JPEG string and nothing
  else). Selection stays a timeline-side action in Phase 1; the overlay only *reflects* it.
- **The box.** Position/size derived from: composition rect (Phase 0a) → the clip's
  natural size × `scale`, centred, offset by `position_*` → mapped to screen via the
  content box. Corner handles only.
- **Interactions.** Body drag = reposition (`position_x`/`position_y`). Corner drag =
  uniform `scale` about the composition centre (matching Resolve's proportional-by-default,
  and the only thing a single `scale` field can mean). Live overlay-only feedback during
  the drag; one op on release. `Escape` cancels the in-flight gesture. No-op when the
  clip's track is `locked` — same guard `ClipInspectorPanel` already applies.
- **Look.** Handles and box strokes come from the existing `--color-*` token set
  (`@chroma/ui`), never literal colours; handle size / hit-slop / minimum scale as named
  constants in the component, per the house no-magic-numbers rule.
- **Not in Phase 1:** rotation, non-uniform scale, crop, anchor point, click-to-select,
  snapping/guides, marquee, multi-clip transform. (Click-to-select has since been built
  on top of Phase 1, unchanged — D-204, 2026-09-07; see Open Question 3.)

### Phase 2 — rotation, and the anchor-point question

`rotation` already exists on `Clip` and is already applied by `composite_layer_onto`
(`imageproc::rotate_about_center`), so a rotate handle is mostly UI. But note the "about
center" — Chroma has **no anchor point**, while both references do. Adding one is a real
`Clip` field + compositor change; recommend shipping rotation about the centre first and
raising anchor point as its own decision only if a real edit needs it.

Non-uniform scale (side handles that squeeze/stretch) needs `scale_x`/`scale_y` on `Clip`
— a real model change with the same `#[serde(default = "default_scale")]` migration care
`scale`/`opacity` already document. Recommend `scale_x`/`scale_y` **replacing** `scale`
with a migration rather than a third field, so there is never a question of which wins.

### Phase 3 — crop, as its own mode — **BUILT (D-132), except the on-canvas mode**

Both references treat crop as a **separate mode**, not an extra behaviour on the transform
box. Chroma had **no crop on a timeline clip at all** (no field on `Clip`, nothing in the
compositor). This phase was scoped as: a `crop` rect field on `Clip`, `composite_layer_onto`
cropping the layer before scale/rotate, a `Crop` row in `ClipInspectorPanel`, and a
Resolve-style mode toggle on the overlay.

**Four of those five are done (D-132); the fifth is the overlay, which does not exist.**
What actually shipped, and where it differs from the sketch above:

- **Four flat normalised insets, not a rect.** `crop_left`/`crop_top`/`crop_right`/
  `crop_bottom` on `Clip`, each the 0–1 fraction of the clip's **own source** trimmed off
  that edge. Flat scalars because that is the only shape the D-034 keyframe engine can
  interpolate — a nested `CropRect` would have stored fine and animated never. Insets
  rather than x/y/w/h because that is what both references expose (Premiere's Crop effect
  is Left/Right/Top/Bottom percentages; Resolve's Crop mode is one handle per side).
- **`composite_layer_onto` crops first, and crops *in place*.** The cropped-away pixels
  lose their alpha while the layer keeps its full footprint, rather than the buffer being
  shrunk to the kept rect. Two real reasons, both reference-matching: the remaining
  picture stays where it is instead of re-centring as you drag an edge in, and
  `scale`/`rotation` keep acting about the layer's own full-frame centre (a shrunk buffer
  would silently move `rotate_about_center`'s pivot).
- **The Inspector gets its own `Crop` section**, four numeric fields in Resolve's own
  Left/Right/Top/Bottom order, in the stored unit (a 0–1 fraction, like the existing
  Opacity field) rather than a percentage.
- **Crop rides the existing `set_clip_transform` op**, not a `set_clip_crop` of its own —
  crop is a separate *mode* in a viewer, but not a separate *write path*: one clip's
  geometry, one form, one history entry, no ordering question between two ops.
- **Not built: the Resolve-style mode toggle and any on-canvas crop handle.** Those need
  Phase 1's overlay substrate, which is still unwritten. Numeric fields only, exactly the
  half of the owner's ask that could be landed correctly tonight.

### Phase 4 — keyframes

The overlay writes static fields today. Making a drag *set a keyframe* when the clip is
already keyframed (rather than silently overwriting the static base value under an
animation) is the same "auto-keyframe" question every NLE answers, and it deserves its own
decision. Until then, the existing explicit "Add key" button in the Inspector is the whole
story, and the overlay should be read as editing the base transform.

---

## Open questions for the owner

1. ~~**Phase 0a's unit choice** — normalised (recommended) vs composition pixels for
   `position_x`/`position_y`.~~ **Answered 2026-09-04 (D-132): normalised, against a
   composition space of `ProjectSettings.width`/`height`.** Taken as a standing call
   rather than another round trip, on this note's own already-researched recommendation —
   see the decision block under Phase 0a. ~~The *migration* of existing `position_*`
   values is still real, still unbuilt.~~ **Built the same night, D-136** — a real
   schema-minor gate on `project.json`, plus Phase 1's actual on-canvas handles.
2. **Proportional-by-default (Resolve) vs free-with-Shift-to-constrain (Premiere).**
   Phase 1 can only do proportional; the question is whether Phase 2 keeps that default.
3. ~~**Click-on-picture to select** — genuinely useful, but it needs the backend to report
   per-layer rects. Worth doing, but as its own slice, not smuggled into Phase 1.~~
   **Built 2026-09-07 (D-204), as its own slice, fixing B-085** — the owner hit the gap
   live ("not able to click on a clip in canvas to resize it, need to click from
   timeline"). **The premise above was wrong**: no backend report was needed.
   `chroma_timeline_clip_geometry` already gives a clip's natural footprint as a
   composition fraction and every placement field on `Clip` is already normalised
   (D-136/D-193), which is exactly why `TransformOverlay` can draw its box today — so the
   frontend can derive every visible layer's rect itself (`canvasPick.ts`, mirroring
   `Timeline::resolve_visible_video_layers_at`'s own filtering and topmost-first order).
   The real difficulty turned out to be elsewhere: a z-ordered hit layer under the
   overlay **cannot work**, because a full-frame clip's own transform box is full-bleed
   and swallows every press once selected. `useCanvasClipPick.ts` decides per press in
   the capture phase instead. Still not built, deliberately: select-and-move in ONE
   gesture (click, then drag, works today), modifier-extend selection on the canvas, and
   a hover cursor/highlight.
4. **Does the Colorist tab get the same overlay?** It has its own, older on-canvas stack
   (Konva + react-image-crop). Unifying them is a real question and a real cost; this note
   deliberately scopes the Edit tab only.

---

## Where crop actually stands (the other half of the same question)

Traced independently in both paths, because they share nothing but a word:

- **Colorist tab — real and working.** `CropPanel.tsx` is routed (`App.tsx` `Panel.Crop`),
  writes `adjustments.crop`, and the preview pipeline really applies it:
  `process_preview_job` → `compute_full_transformed_res` →
  `adjustment_utils::apply_all_transformations` → `image_processing::apply_crop`. That
  holds for a **video** frame too, since a decoded frame is installed as the editor's base
  image (`seek_and_install`). Still export applies it as well.
- **Colorist video export — applied for real since D-135 (B-042 closed).** It was
  silently dropped: `chroma::export::grade_frame` never called
  `apply_all_transformations`, going straight to `render_core::render` with an
  `AllAdjustments` that carries no geometry, so crop, straighten, 90° orientation, flips
  and the perspective/lens warp all vanished on a video export — the preview showed one
  thing, the file contained another. (The in-loop dimension check that claimed to catch
  this could never fire — nothing in that path could change the frame size.) **D-127**
  made it refuse up front; **D-135** made it work, and deleted the refusal.
  `grade_frame` → `prepare_frame` now runs the *same* `apply_all_transformations` the
  preview and the still export run, rasterises masks at the transformed size with the
  real crop offset (the preview's `scaled_crop_offset` at `effective_scale == 1.0`, not
  the old `(0.0, 0.0)`), and the encoder is spawned **lazily from the first graded
  frame's measured size** so a crop or a 90° step really changes the encoded dimensions.
  D-019's tracked mattes needed no change — their alignment code already un-does
  crop/rotation/flip against a full-resolution matte. `yuv420p`'s even-dimension
  requirement is a stated rule: round **down** to a multiple of 2 for every codec,
  trimming ≤1 row/column rather than padding or resampling. The only geometry a video
  export still refuses is a crop that rounds to zero in either axis.
- **Edit tab — did not exist at all** (true as written, 2026-09-04 afternoon): no `crop`
  field on `chroma_timeline::Clip`, no crop in `composite_layer_onto`, no Crop row in
  `ClipInspectorPanel`. Not a stub, not a dead control — the concept was simply absent.
  **Now built, that same evening — D-132**, see Phase 3 above for exactly what shipped and
  what didn't. Two things this earlier paragraph implied that turned out to matter: the
  Edit tab's crop shares **nothing** with Colorist's (per-layer, normalised, inside a
  multi-layer compositor vs. absolute-pixel geometry on one loaded still), and it is
  **preview-only** — there is still no timeline video export path of any kind, so "does
  Edit-tab crop survive an export" is not yet a question the code can be asked.

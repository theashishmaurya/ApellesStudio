# On-canvas clip transform (PIP handles) — scoping (2026-09-04)

Owner, live, with a screenshot of the preview: *"the player is canvas — once I have another
video I can select, drag and make it smaller or larger, PIP etc."* Multi-layer stacking is
already real (D-088); what's missing is being able to **grab the overlaid clip in the
program monitor and move/resize it directly**, instead of typing numbers into the
Inspector.

This note is the scoping pass. **Nothing here is built yet** — deliberately, because
scoping turned up two real prerequisites (below) that would make handles feel broken if
they were built on top of today's model as-is.

Companion finding from the same pass: **crop** — see "Where crop actually stands" at the
end, plus B-042 / D-127.

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

### 0a. The composite's coordinate space is preview-resolution-dependent (B-042TEMP)

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

### Phase 1 — select, move, uniform corner-scale. Nothing else.

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
- **Which clip?** Reuse the existing selection — `useEditorTimelineStore.selection`, the
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
  snapping/guides, marquee, multi-clip transform.

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

### Phase 3 — crop, as its own mode

Both references treat crop as a **separate mode**, not an extra behaviour on the transform
box. Chroma has **no crop on a timeline clip at all** (no field on `Clip`, nothing in the
compositor — see below). So Phase 3 is: a `crop` rect field on `Clip`, `composite_layer_onto`
cropping the layer before scale/rotate, a `Crop` row in `ClipInspectorPanel`, and a
Resolve-style mode toggle on the overlay. Sized as a real feature, not a handle variant.

### Phase 4 — keyframes

The overlay writes static fields today. Making a drag *set a keyframe* when the clip is
already keyframed (rather than silently overwriting the static base value under an
animation) is the same "auto-keyframe" question every NLE answers, and it deserves its own
decision. Until then, the existing explicit "Add key" button in the Inspector is the whole
story, and the overlay should be read as editing the base transform.

---

## Open questions for the owner

1. **Phase 0a's unit choice** — normalised (recommended) vs composition pixels for
   `position_x`/`position_y`. It changes saved-project migration, so it wants an explicit
   call.
2. **Proportional-by-default (Resolve) vs free-with-Shift-to-constrain (Premiere).**
   Phase 1 can only do proportional; the question is whether Phase 2 keeps that default.
3. **Click-on-picture to select** — genuinely useful, but it needs the backend to report
   per-layer rects. Worth doing, but as its own slice, not smuggled into Phase 1.
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
- **Colorist video export — silently dropped (B-042, fixed to fail loudly; D-127).**
  `chroma::export::grade_frame` never calls `apply_all_transformations` — it goes straight
  to `render_core::render`, and `AllAdjustments` carries no geometry at all. So crop,
  straighten, 90° orientation, flips and the perspective/lens warp were all silently
  discarded on a video export: the preview showed one thing, the file contained another.
  (The in-loop dimension check that claimed to catch this could never fire — nothing in
  that path can change the frame size.) Now guarded up front by
  `export::unsupported_geometry`, which refuses the export and names the offending
  controls. **Making video export actually honour crop is a real, separate piece of work**
  — the encoder is spawned with fixed dimensions before the loop, mask bitmaps are
  generated at full frame size with a zero crop offset (the preview path passes a real
  `scaled_crop_offset`; the export path passes `(0.0, 0.0)`), tracked D-019 mattes are
  baked at the un-cropped resolution by explicit assumption, and h.264's `yuv420p` needs
  even dimensions a free-form crop rect won't guarantee.
- **Edit tab — does not exist at all.** No `crop` field on `chroma_timeline::Clip`, no
  crop in `composite_layer_onto`, no Crop row in `ClipInspectorPanel`. Not a stub, not a
  dead control — the concept is simply absent. That's Phase 3 above.

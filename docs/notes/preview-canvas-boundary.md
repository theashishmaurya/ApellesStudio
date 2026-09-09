# Preview canvas boundary + settings, and the "AFTER full-bleed" root cause (D-199)

2026-09-07. Closes `docs/04-roadmap.md` item 18. Companion to D-200 (B-079's Rust
fix), item 19 of the same roadmap section — found and fixed in the same pass because
both sit in the exact live-preview subsystem this note investigates.

## The report

Owner, live, building a real two-clip stacked comparison video (the
`chroma-comparison-reel` workflow — "BEFORE"/"AFTER" clips, one per track,
positioned/scaled via `position_y`/`scale`/`box_width`/`box_height` to sit stacked
top/bottom): the exported file (`editor_export`) composited correctly — both clips,
full-width, properly stacked, letterboxed. The LIVE PREVIEW showed something
different: the AFTER clip full-bleed at its own native aspect ratio, filling the
whole preview, with no visible sign of BEFORE and no visible frame/boundary showing
what the actual output composition even looks like. Already partially captured in
`docs/04-roadmap.md` item 18 (the owner's own quote: *"in the UI also we have no
visual 9:16 ratio for the working canvas we want that — we should be able to change
the canvas and it should be in the preview"*) and `docs/CHANGELOG.md`'s D-188 entry.

## Root-cause investigation

Read `app/src-tauri/src/chroma/edit.rs` end to end: `chroma_timeline_frame` →
`Timeline::resolve_visible_video_layers_at` → `composite_video_frame` →
`composite_layer_onto`. This is a REAL, already-built, heavily-unit-tested (~30
`composite_tests`) multi-layer alpha-over compositor: every visible video track's
clip is decoded, placed at its own natural-footprint-times-`scale` (or the D-193
`box_width`/`box_height` override) box in **composition space** (D-136, closing
B-043 — the canvas is the project's own `ProjectSettings`/first-clip-derived size,
not whichever layer happens to be on top), and painted back-to-front (D-088's own
documented paint order — index 0 painted LAST/on top, matching `timelineExport.ts`).
Nothing in this code path looked structurally capable of producing "one clip visible,
full native aspect, nothing else" for two same-composited tracks.

**Verified directly, not just read.** Built two synthetic solid-color clips
(`ffmpeg -f lavfi -i color=red/blue`) and drove the REAL, unmodified
`chroma::edit::timeline_frame` production function (not a mock) through a throwaway
`#[test]` with a two-video-track timeline shaped exactly like the report — track 0
(`position_y: -0.25, box_width: 1.0, box_height: 0.5`), track 1
(`position_y: 0.25, box_width: 1.0, box_height: 0.5`) — decoded the returned JPEG,
and looked at it. Result: a clean red-top/blue-bottom split, no bleed, no missing
layer — the compositor is correct for exactly this stacking pattern. (Test removed
before commit — a spike, per the house rule, not committed scratch code; this note
is where the finding lives.)

**Conclusion: no compositor defect was found or reproduced.** Two real, independent,
already-reachable-from-the-report's-own-subsystem factors most plausibly explain
what the owner saw, and both are closed by this pass:

1. **B-079** (this session's own B-077 audit finding, `docs/BUGS.md`) — `Track::
   clip_at`, the function `chroma_timeline_frame`'s decode path calls to resolve
   which clip is at a timeline position and which SOURCE frame to decode, had the
   identical B-075/B-077 fps-unit conflation, unfixed until D-200 (this session).
   For a clip whose native fps is LOWER than the project's timebase, the pre-fix
   fps-naive `end_frame()` computes a timeline end BEFORE the clip's real intended
   end — so at a later (but still, in real terms, "inside the clip") timeline
   frame, `clip_at` would report "nothing here" (a gap), and
   `resolve_visible_video_layers_at` would silently drop that track from the
   composite entirely. A track dropped this way is indistinguishable, on screen,
   from "this clip was never stacked" — exactly the reported symptom. This
   session's own B-077 investigation confirms the comparison-reel project used
   real screen recordings at genuinely different native frame rates, which is
   exactly the condition this bug needs to fire. Not certain to be the exact
   mechanism the owner hit (the original two clips are gone), but real, reachable,
   in the right subsystem, and now fixed regardless (D-200).
2. **No persistent visual reference for the output frame, and no way to see/change
   it from the Edit tab** — a real, confirmed (not hypothesized) gap: a project
   built entirely in the Edit tab never visits the Colorist tab's
   `ProjectSettingsModal` (the only existing UI for `ProjectSettings.width`/
   `height`, D-038), so a human has no way to confirm what the composition
   actually is, or to notice when a clip's `box_width`/`box_height`/`position_*`
   don't produce the framing they expected. "The AFTER clip fills the screen and I
   can't tell if that's right" is the natural reading of a correct render with no
   boundary to judge it against. Closed below.

## The fix

**`packages/editor/src/CanvasBoundary.tsx`** — a third sibling in `PreviewPane.tsx`'s
`surfaceRef` stack (alongside the `<img>` and `TransformOverlay`), under
`TransformOverlay` in z-order. Unlike `TransformOverlay` (one selected clip only),
this draws whenever the timeline has a resolvable composition size AT ALL —
selection or none — so the frame is visible from the moment a project opens. Uses
the exact same `useContentBox` letterbox math `TransformOverlay` already does, fed
by a NEW size source (`useCompositionSize`/`chroma_timeline_composition_size`) that
needs no clip selected, unlike the existing `chroma_timeline_clip_geometry`
(`useClipGeometry`) which only reports `compWidth`/`compHeight` as a side effect of
resolving one clip's own box.

**`packages/editor/src/CanvasSettingsPopover.tsx`** — a small popover (not a full
`Dialog`; this is one quick numeric edit) reachable from `PreviewPane.tsx`'s own
toolbar, next to the D-118 Inspector toggle. Reads/writes `ProjectSettings.width`/
`height` via the EXISTING `chroma_project_set_settings` command and a NEW
`chroma_project_get_settings` (`app/src-tauri/src/chroma/project.rs` — a
read-only, symmetric counterpart; `chroma_project_set_settings` had no matching
getter because the Colorist modal never needed one, reading its current values
from `useSessionStore`'s own already-loaded manifest instead — `packages/editor`
has no such store and cannot reach across the `app -> packages` dependency
direction to use one). Resolution presets match `ProjectSettingsModal.tsx`'s own
(3840×2160 / 1920×1080 / 1280×720 / 1080×1920) for consistency between the two
surfaces; fps/colour-space stay Colorist-modal-only (neither affects the preview's
own boundary or the compositor's placement math).

**Why a second, lighter surface instead of exposing the Colorist modal to the Edit
tab:** `app/src/components/chroma/ProjectSettingsModal.tsx` reads
`useSessionStore` (`app/src/store`), which `packages/editor` cannot import — D-039's
dependency direction is `app -> packages`, never the reverse, and Colorist's own
session store is app-layer, not a `@apelles/editor` concern. Building a second UI for
the same two fields is a real, if small, duplication; the alternative (lifting
`ProjectSettingsModal`'s state into a shared package) is a genuinely bigger
refactor with no other driver behind it tonight — scoped out, not silently
skipped.

**New Rust command**: `chroma_timeline_composition_size` (`chroma::edit`) — thin
wrapper reusing `composition_size` (the same D-136 resolver `clip_geometry` calls),
returning `ClipGeometry`'s shape with `naturalWidth`/`naturalHeight` fixed at `1.0`
(undefined without a clip) rather than inventing a second, near-identical DTO.

## Drag-to-rearrange — verified working, not touched

The task's own framing flagged this as a thing to verify, not assumed fixed: with
the canvas boundary now visible, can a human still see and drag each clip's
uniform move/resize box? Yes — `TransformOverlay.tsx` (D-136) already implements
this, unaffected by the boundary (drawn UNDER it, `z-20` vs. `TransformOverlay`'s
`z-30`, so the handles remain on top and grabbable). Verified LIVE, not just read:
extended the D-142 isolated browser harness (`app/harness.html`/`harness-main.tsx`)
to mount `PreviewPane` (`?mode=preview`), stubbed `chroma_timeline_frame`/
`chroma_timeline_clip_geometry`/`chroma_timeline_composition_size`/
`chroma_project_get_settings`/`chroma_project_set_settings`/`chroma_audio_*`, and
drove real `PointerEvent`s via `evaluate_script` in a real Chromium tab (chrome-devtools
MCP): selected a clip, dragged its body (move) and its `se` corner handle (resize).
Both committed a real `set_clip_transform` op — `position_x`/`position_y` and
`scale` changed on the store's actual clip, matching a real drag delta, with the
`CanvasBoundary` and `TransformOverlay` both rendering correctly at the same time
with no z-index/interaction conflict. Also verified the settings popover's full
round trip live in the same harness: open → fetch current size → pick a preset
(1280×720, then 1080×1920) → Apply → the boundary's own rect and label updated
immediately, including the aspect ratio genuinely changing shape (16:9 → 9:16).

(Corner-drag note for anyone repeating this: Chromium's `setPointerCapture` throws
`NotFoundError` for a synthetic `PointerEvent` unless `pointerId: 1` — the reserved
id for the real system mouse pointer, which the browser DOES treat as "active"
even for a script-dispatched event. Any other id throws before the handler's state
updates run, which looks exactly like "the drag does nothing.")

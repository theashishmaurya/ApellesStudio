# BUGS

Real defects only — in our code or the engine. Not setup/housekeeping. Move to GitHub
Issues once public.

```
## B-NNN — title
status: open | fixed | wontfix   ·   severity: blocker | high | medium | low   ·   area: …
repro / expected / actual / cause / fix
```

## Known engine constraints (design around these — not bugs)

Refreshed 2026-09-02 (docs-reconciliation pass) — three items previously listed here are
solved and removed:
- ~~Render entry points are Tauri-coupled~~ — fixed by **D-014** (`render_core` extraction,
  done 2026-09-01); the grade path is callable headless (export, the eval harness).
- ~~Masks are static per image — no keyframe/tracking model~~ — SAM 2 video tracking shipped
  (**D-018**) and mask keyframes shipped (**D-034**, done 2026-09-02).
- ~~Depth Anything is wired for stills only; per-frame video flickers~~ — a real temporal
  depth track shipped (**D-036**, Video Depth Anything-vits, done 2026-09-02); the
  single-frame ONNX bake is still used for stills and pre-track, by design, not as a gap.

Still real:
- `process_and_get_dynamic_image` bypasses the GPU and returns the source unprocessed if
  `w|h > max_texture_dimension_2d` — watch at 8K.

## Open

## B-010 — `ExportPanel` (`Panel.Export`) is reachable and appears usable while a video clip is loaded, but silently attempts a still-image export against the video's own path
status: open · severity: low (a working, prominent alternative — `ExportDialog`, D-049 — now exists; this is dead-end UX, not data loss) · area: `app/src/components/panel/right/ExportPanel.tsx`, `app/src-tauri/src/export_processing.rs`
- **repro:** open a video clip in the Colorist tab, click the "Export" icon
  in the panel switcher (`Panel.Export`), pick any format, click Export.
- **expected:** either the panel is unavailable for video content, or it
  exports something sensible from the clip (a frame, or the graded video).
- **actual:** `selectedImage.path` for a loaded video shot is the clip's own
  file path (`useSessionStore`'s `applyLoaded` — no still/video branch), so
  `ExportPanel`'s `numImages`/`canExport` read as if a real image were
  selected. Clicking Export calls `Invokes.ExportImages` →
  `export_processing.rs`'s `export_images_impl`, which `image::open()`s the
  path as a still — this will error (or, worst case, silently mis-handle a
  path `image` happens to partially parse) on a video container.
- **cause:** `ExportPanel` is RapidRAW's unmodified still-image exporter; it
  was never taught about `useChromaStore.videoInfo`/video-ness, because
  nothing in the Colorist pivot (D-039/D-043) ever routed a real video
  export through it — that gap is exactly what D-049's `ExportDialog`
  fills, via the correct backend (`chroma_export_video`).
- **fix (not done — out of scope for D-049):** gate `Panel.Export`'s
  availability/rendering on `!videoInfo?.isVideo` (simplest), or teach
  `export_images_impl` to route a video path to the real video-export path
  instead of `image::open()`. D-049 deliberately left `ExportPanel` fully
  routed rather than partially unrouting it — see that decision for why.

## B-012 — Drag a Sources-panel clip onto the Edit-tab timeline: lands with no real timeline position, silently breaking playback/edits from that point on
status: fixed (2026-09-03, D-058 + D-064) · severity: high · area: `packages/editor/src/timeline.ts`, `TimelinePane.tsx`, `app/src-tauri/tauri.conf.json`
- **D-058 fixed the model, but D-064 found the drag still didn't fire at all in the real app — see D-064.** D-058's own live verification ran against a plain Chrome tab with Tauri mocked out (the documented workaround for this sandbox having no screen access to the real Tauri window); the owner's very next live retest in the actual app showed drag-and-drop still completely inert. Root cause, found by D-064: Tauri v2's window-level native drag-drop capture (`dragDropEnabled`, on by default, never set in `tauri.conf.json`) intercepts drag events before they reach the page's own HTML5 handlers — a bug the Chrome-tab method structurally could not have caught, since no Tauri runtime was present to intercept anything in that test. `dragDropEnabled: false` fixed it; confirmed by the owner's own live retest ("yeah drag and drop works").
- **found:** owner's own hands-on testing of the live app, 2026-09-03 — D-046 (2026-09-02) and D-054 (earlier the same day as this fix) had each been "verified" in isolation (D-046: code review only, flagged honestly as such; D-054: Rust-only, explicitly out of frontend scope) but never exercised together by a real drag.
- **repro:** open a project with at least one shot on the Edit tab's timeline, drag any item from the Sources panel onto the timeline strip.
- **expected:** the clip appears at the end of the track and plays back correctly at that position.
- **actual:** the clip's array entry appears (rendering happened to still look plausible, since `TimelinePane`'s own render — before this fix — derived on-screen position from summed preceding durations, not any stored position field), but the persisted `project.json` clip has no real timeline position; scrubbing to it in the preview (`chroma_timeline_frame`, which *does* read the real backend position) shows the wrong frame or nothing, and any further edit compounds the corruption.
- **cause:** D-054 (same day, landed after D-046) gave `chroma-timeline::Clip` a mandatory, timeline-absolute `start_frame: i64` field. `chroma_timeline_set` stores whatever the frontend sends **verbatim** — there is no server-side clamping — so `packages/editor/src/timeline.ts`'s pure-TS mirror of the edit ops, not the Rust ops in `lib.rs`, is what actually runs for every edit made through this UI. That TS file's `Clip` interface, and every op that builds a clip (`clipFromDraggedMedia` chief among them), was never updated for the new field — a dropped clip's JSON simply had no `start_frame` key. Rust's `#[serde(default = "legacy_missing_start")]` silently accepted that as the pre-D-054-migration sentinel (`i64::MIN`) rather than erroring, and `load_manifest`'s `backfill_legacy_positions` — a **migration** path, never intended to run on a live edit — reconstructed *some* position from Vec order on the next `chroma_timeline_get`, which happens to look right for a bare "append to an untouched track" but silently corrupts (duplicate/overlapping positions, no clamp) as soon as a split, reorder, or second drop is layered on top. Neither D-046 (code-review-only, explicitly flagged as its one unverified piece) nor D-054 (Rust-only by design, explicitly deferred "no frontend" — see that decision) individually missed anything they claimed to cover; the gap was structural, between the two.
- **fix:** `timeline.ts`'s `Clip` now carries `start_frame` for real (`NewClipFields = Omit<Clip, 'start_frame'>` for a not-yet-placed clip); `applyOp`'s `add_clip` case computes the real append position (`nextAppendFrame` — the end of whatever's already on the target track) at the moment the op is actually applied, the only point that has both the new clip and the real track state. Every other op (`trim_start`/`trim_end`/`split`/`remove`/the new `move`) was audited and fixed to maintain `start_frame` correctly too — see **B-013** and D-058. **Live confirmation, not just code review:** a real native HTML5 `dragstart`→`dragover`→`drop` sequence (a genuine `DataTransfer` carrying `application/x-chroma-media`, dispatched at the real `.timeline-editor-edit-row` DOM node the library renders) against the real `SourcesPanel`/`TimelinePane` components in a live Vite-served instance of the app — the resulting clip in the live `useEditorTimelineStore` landed at `start_frame = 240` (exactly the preceding clip's end, zero gap), confirmed both in the store and in the exact JSON payload that would be sent to `chroma_timeline_set`. See D-058's verification section for the full method.

## B-013 — Trimming a clip's edge on the Edit-tab timeline does nothing at all — the resize handle's hitbox was blocked, and the op behind it was broken too
status: fixed (2026-09-03, D-058) · severity: high · area: `packages/editor/src/TimelinePane.tsx`, `packages/editor/src/timeline.ts`
- **found:** owner's own hands-on testing of the live app, 2026-09-03, then reproduced and root-caused for real in this pass — a real pointer-event sequence dispatched at the resize handle's own coordinates against the live app (Vite dev server + a minimal `window.__TAURI_INTERNALS__` shim in a real Chrome tab, invoke() calls mocked, everything else real — see D-058's verification section), not just read from source. D-051 (2026-09-03, earlier the same day) verified edge-trim by reading `interact.js`'s bundled `resizable()` source and confirming `flexible`/`dragLine` were set — a real, honest form of confidence at the time, but about the *library's* resize mechanics in isolation, never an actual pointer landing on an actual handle in the actual rendered DOM. D-054 (later the same day) also changed `trim_start`'s real semantics; nobody re-verified either piece before this pass, exactly the risk flagged when this task was scoped.
- **repro:** drag the left (or right) edge of any clip on the Edit-tab timeline.
- **expected:** the clip's edge trims where dragged (non-ripple: the other edge and every other clip stay put).
- **actual (pre-fix):** nothing happens — no resize cursor affordance, no visible change, `onActionResizeEnd` never fires at all.
- **cause — two independent bugs, confirmed one at a time by dispatching real pointer/drag events at the exact live DOM coordinates and checking what actually received them:**
  1. **The resize handle's hitbox was unreachable — a genuine CSS stacking bug in `TimelinePane.tsx`'s `getActionRender`, found only by checking `document.elementFromPoint()` at the handle's own coordinates live, not by reading the library's source (which is correct and uninvolved).** The library renders each clip's absolutely-positioned `.timeline-editor-action-{left,right}-stretch` resize handles as siblings *after* the clip's custom content in the DOM, `z-index: auto`. That content's clip-name label has `z-10` (originally just to sit above the Waveform canvas) but its parent doesn't isolate a stacking context, so the label's `z-10` escapes to compete directly against the handle siblings — and, being an unconstrained block-level div, silently spans the clip's *entire* width, including both 10px edge zones. Confirmed live: a synthetic pointer event at a handle's exact coordinates hit-tested to the label div, not the handle — `interact.js`'s `resizable()` (correctly configured, per D-051) never received the `pointerdown` that would start a resize gesture. This is why the interaction did *nothing at all*, not why the resize computed something wrong — cursor:ew-resize/pointerdown-capture on the handle underneath was blocked before any op logic ran.
  2. **Once reachable, `trim_start`'s own op was independently broken — a D-054/D-041 model mismatch, confirmed by seeding a real timeline in the live store and reading the exact op payload after a synthetic resize.** `buildRow` rendered every clip's on-screen `start` as the *sum of every preceding clip's duration* ("always back to back," true when this code was written, D-041), never an independently stored position, and `trim_start` never touched `start_frame` (which didn't exist in this file's `Clip` type at all — same root gap as B-012). Under that position formula a clip's own on-screen start could only ever move if a *preceding* clip's duration changed; the only effect of shrinking its own duration was its end moving inward — the opposite edge from wherever the user actually dragged.
- **fix:** (1) `pointer-events-none` on the clip-name label (`TimelinePane.tsx`, see the inline comment at that line for the full stacking-context writeup) — verified live: `elementFromPoint` at the handle's coordinates now returns the handle itself, and a real pointer-down/move/up sequence there fires `onActionResizeEnd`. (2) `buildRow` now renders every clip's position from its own real `clip.start_frame`; `trim_start` rewritten field-for-field against `chroma-timeline::Timeline::trim_start` (shifts `source_start` **and** `start_frame` together by the clamped delta, end stays fixed, clamped so `start_frame` never passes the nearest preceding clip's end), `trim_end` gained the matching next-clip clamp. **Live confirmation of the full, real interaction** (not just unit tests): seeded a real two-clip timeline (`clipA`[0,240), `clipB`[240,336)) into the live `useEditorTimelineStore`, dispatched a real synthetic `PointerEvent` sequence at `clipB`'s left-edge handle's actual screen coordinates, and the resulting store state showed `clipB` at `start_frame=251, duration=85` — `end_frame` still exactly `336` (unchanged, confirmed), a visible gap opened before it on screen (screenshotted), and the exact JSON that would be sent to `chroma_timeline_set` carried `start_frame`/`source_start` shifted together by the same delta (11 frames). Real unit tests for the clamp/neighbor math generally: `packages/editor/src/timeline.test.ts`.

## Fixed

## B-031 — Opening a project silently aborted before the Edit tab ever saw it, whenever an earlier clip shared a source path with the active one — no error, no log, "No project open" forever
status: fixed (2026-09-04) · severity: blocker (opening a project is the app's entry point — this recurred across the night, reported fixed twice before the real cause was found) · area: `app/src-tauri/src/chroma/project.rs` (`open_manifest`)
- **found:** owner, live, repeatedly, across the night — same "No project open" / launcher-screen-doesn't-transition symptom kept recurring after two earlier passes (B-025/D-085's loading-spinner-and-retry fix, and this session's own initial project-open regression chase) each addressed a real but different contributing issue without landing the actual root cause. `app.log` showed the backend completing a normal-looking open (grade migration ran, warnings logged) with **zero errors anywhere** — the strongest clue the failure was silent, not crashing.
- **cause:** `open_manifest` resolved the active clip's session index by finding its source path's position in `online_paths`, a `Vec` pushed once per *clip* in manifest order — but the real decode session (`state::Session`) deduplicates by path, so whenever an earlier clip in the manifest shared a source path with the active clip, the two index spaces diverged. `session_set_active` then correctly rejected the now-wrong index, and that rejection aborted the whole open **before `state::set_project` ever ran** — with the error swallowed rather than surfaced to the UI, so the launcher screen just... never transitioned, silently.
- **fix:** resolve the active clip's index against the session's own deduplicated path list instead of the raw per-clip one. 161/161 Rust tests pass, `cargo clippy` clean.
- **process note, disclosed rather than smoothed over:** the fix's own commit message cited "B-030" — already claimed by the unrelated overlap bug directly below, a real numbering collision caught only when the owner asked "do we have this logged as open?" and it turned out not to be logged under any number at all. This B-031 entry is the correction; the fix itself (commit `373e725`) was real and already verified before this doc gap was found.

## B-030 — A clip dragged (same-track or cross-track) could land directly overlapping another clip already there, instead of resolving to a real open/rippled position
status: fixed (2026-09-04, D-104) · severity: high (a core, constant-use interaction — the whole point of D-100's unified clip-move mechanism — producing a silently broken, visually overlapping timeline state) · area: `packages/editor/src/TimelinePane.tsx`, `packages/editor/src/timeline.ts`, `crates/chroma-timeline/src/lib.rs`
- **found:** owner, live, right after D-100 shipped the unified drag mechanism: "see its overlapping and not able to move horizontally in the same v1... and proper drage above below, in the track also its not very quick and free" (a separate, already-fixed regression report bundled in the same message) plus a dedicated screenshot: dragging Video 2's clip onto Video 1 landed it stacked directly on top of the clip already there at the same time position. Sharper follow-up, unambiguous: "i should be able to drop it before any clip, between two clip or after two clip, not on top of the clip in the same track that should not be possible."
- **cause:** cross-track `move` reused the clip's own existing `start_frame` verbatim (D-094's original behaviour, unchanged through D-096/D-098/D-100) — never derived from where the drop actually happened, and D-096 had separately made cross-track overlap an explicitly *allowed* outcome (reasoning it was a legitimate composited layer stack post-D-088). Same-track move only ever silently rejected an overlapping drop (no ripple, no snap) rather than resolving it to somewhere useful. Neither path went through `computeInsertion` (D-095/D-100) — the exact "where does this actually fit" algorithm a brand-new clip from Sources already gets — so an existing clip being moved had a strictly worse placement experience than a new one being added.
- **fix — a real consolidation, not a second patch on top of the old model:** new `resolveClipLanding` (`timeline.ts`) wraps `computeInsertion` for an EXISTING clip (excluding its own current slot by id so it never collides with itself), used by both `onDndDragEnd`'s move branch and the "Move to ▾" dropdown — one placement algorithm for every way a clip lands on a track (new from Sources, moved same-track, moved cross-track). `EditOp`'s `move` case gains `ripple?: boolean`, mirrored field-for-field into `chroma-timeline::Timeline::move_clip`: overlap is now rejected for EVERY move, same-track or cross-track (reverses D-096's cross-track-overlap-allowed policy — real intentional layer-stacking via other means stays possible, just not as a side effect of where a drag happens to land), unless `ripple` shifts everything on the destination track at/after the landing point later by the moved clip's own duration to make room (mirrors `add_clip`'s existing ripple contract). Cross-track move now also uses `event.delta.x` (previously ignored entirely for cross-track, tracked only for same-track) to compute a real intended landing frame instead of always reusing the clip's pre-drag position. A genuine edge case caught in testing, not shipped blind: ripple only shifts clips starting at/after the landing point (the shape `resolveClipLanding` always produces) — a clip straddling the landing point (starting before it, extending past it) can't be cleared that way and isn't a real ripple-insert scenario any NLE supports without splitting the clip first, so that case is rejected rather than left silently still-overlapping. Full writeup: D-104 in `docs/08-decisions.md`.

## B-029 — D-098's dnd-kit migration shipped with a real bug that made a stuck ghost also BLOCK same-track drag entirely; two more live reports (ripple-insert dead zone, no click-to-deselect, unreadable selected-clip contrast) traced to the same drag cluster; root-caused by unifying same-track and cross-track clip move onto ONE mechanism instead of two competing ones
status: fixed (2026-09-04, D-100) · severity: high (a previously-solid, constant-use interaction — same-track drag, working since D-051 — regressed to completely blocked) · area: `packages/editor/src/TimelinePane.tsx`, `packages/editor/src/timeline.ts`
- **found:** owner, live, four reports in close succession right after D-098 shipped: (1) "track overlapping." with a screenshot of two copies of the same clip, one styled like a stuck ghost overlay; (2) escalation — "can't drag and drop in the same track to shuffle the position between clips," same stuck-ghost screenshot, now blocking a previously-solid D-051 feature; (3) "when i try to add a clip between two which was already added does not work" (ripple-insert); (4) "clicking outside does not make it undeselected" + "white selected color is not visible" (selection UX). Owner's own diagnosis, confirmed correct: "there are two drag sources, one is handle and one is clip itself... we should have the whole thing draggable and single drag point handling all the drag related work" — two independently-built move systems (the timeline library's native `interact.js` drag, still handling same-track reposition, and D-098's dnd-kit system for cross-track) racing for the same gesture on the same element was the real root cause of the whole cluster, not isolated bugs.
- **root cause, the actual blocking mechanism (not just a visual bug):** `TrackDropZone` (D-098's per-track droppable overlay) toggled `pointer-events-auto`/`none` based on `activeDrag` — but dnd-kit's own collision detection (`rectIntersection`) works purely off measured rects, never off native pointer-event hit-testing, so this was never actually needed. If `activeDrag` ever got stuck `{type:'clip',...}` (an interrupted drag whose `onDragEnd`/`onDragCancel` never fired), `pointer-events-auto` stayed on forever on a FULL-ROW, `z-20` overlay — silently intercepting every click/drag/resize on that entire track row, including the clip underneath. That's what "can't drag in the same track" actually was, not same-track drag itself breaking.
- **why `activeDrag` got stuck in the first place, verified live via real `PointerEvent` sequences against the real component, not assumed:** dnd-kit's own `AbstractPointerSensor` registers its `pointercancel`/`pointermove`/`pointerup` listeners on `document`, tracking a specific `pointerId` once a drag starts. A real desktop app can plausibly lose the pointer mid-drag (another app/dialog steals focus while the button is conceptually still down) without the webview ever seeing a completing event. Reproduced live: an interrupted drag left BOTH this app's own `activeDrag` state AND dnd-kit's own internal sensor state stuck — resetting only `activeDrag` (an earlier, insufficient version of this fix) left the UI looking idle, but the very NEXT real drag attempt on the SAME pointer silently failed to apply anything.
- **the ripple-insert "does not work" report, a separate but related finding:** `computeInsertion`/`nearestEdge` only ever resolved a drop within a tight snap radius of an existing clip EDGE or inside a genuinely open gap — when two clips are already touching (the ordinary state for a real edit, not an edge case), the only way into a real ripple-insert was a pixel-precise hit on their shared seam; everywhere else on either clip's own body silently fell back to a plain append at the track's end.
- **fix:** (1) unified same-track and cross-track clip move onto ONE mechanism — `ClipBody` (the whole clip, not a small strip) is now the single `useDraggable` source for both; `buildRows` sets `movable: false` on every library action (confirmed in the library's own bundled source that this fully disables its native move-drag while leaving `flexible`/edge-trim completely unaffected — a genuinely different gesture, correctly untouched); `onDndDragEnd`'s existing same-track-vs-cross-track branch (already built for D-096/B-027's own regression fix) needed no changes — it was already the right shape. (2) `TrackDropZone`'s `pointer-events` is now unconditionally `none` — removes the whole blocking bug class regardless of why `activeDrag` gets stuck, not just the one trigger found. (3) two real safety nets: `window.blur` dispatches a genuine synthetic `pointercancel` (verified this — not just resetting local state — is what actually releases dnd-kit's own internal sensor state) for the dnd-kit system; a `document`-level `dragend` listener (which per spec always fires exactly once when a native drag concludes, success or not) resets the native-HTML5 Sources-panel drag's own preview state. (4) `computeInsertion`/`nearestEdge` gained a third case: hovering over the middle of an existing clip now resolves to whichever half of that clip is closer, making its whole body a real insertion target instead of a razor-thin seam; `INSERT_SNAP_PX` widened 10→16 as a secondary precision improvement. (5) click on empty timeline space (not on a clip) now clears selection. (6) selected-clip contrast: no more background-colour swap to `var(--color-accent)` on selection (paired with the wrong text token, `text-text-primary` instead of this app's own `text-button-text` convention for accent surfaces) — a `ring-2 ring-accent` outline is now the only selection indicator, clip colour and text stay constant and readable. Full writeup: D-100 in `docs/08-decisions.md`.

## B-028 — Cross-track clip move (D-096's full-width strip) still didn't work live — native HTML5 drag/drop unreliable on Tauri's WKWebView a THIRD time in one session; fixed by moving track reorder + cross-track clip move onto `@dnd-kit/core`/`@dnd-kit/sortable`
status: fixed (2026-09-04, D-098) · severity: high (core, constant-use interaction reported completely non-functional live) · area: `packages/editor/src/TimelinePane.tsx`, `packages/editor/src/timeline.ts`, `packages/editor/package.json`
- **found:** owner, live: "not able to drag video 2 to video 1," screenshot showing a real drag in progress (ghost visible, clip highlighted) but the drop not landing the move. The SECOND interaction in this session (after D-095's track-reorder finding) to pass this session's own Chromium-browser-automation harness checks but fail in the owner's real Tauri/WKWebView window — a real recurring pattern, not a one-off.
- **sanity check first (ruled out, not assumed):** re-verified D-064's `dragDropEnabled: false` fix — `app/src-tauri/tauri.conf.json`, window-level (single-window app, so it covers every drag zone including this one) — is still globally set, not regressed, not scoped too narrowly. Confirmed not the cause.
- **root cause:** native HTML5 `draggable`/`dataTransfer` drag-and-drop's own real limitations (no first-class preview control, `dataTransfer.getData` unreadable until drop, no native cross-container primitives — full analysis in `docs/notes/dnd-kit-migration.md`), compounding across two separate interactions this session (D-095's track-reorder handle, then this cross-track clip-move handle) each independently reported broken live despite passing this session's Chromium-only automation checks — the real, likely explanation being Tauri's macOS WKWebView (a different, untestable-this-session rendering/DnD engine) handling native HTML5 drag less reliably than Chromium, though this could never be directly confirmed without a real WKWebView test surface.
- **fix — owner-directed, not a workaround:** implemented `docs/notes/dnd-kit-migration.md`'s phase 1 plan for real: track reorder (`SortableTrackHeader`, `@dnd-kit/sortable`'s `SortableContext`/`useSortable`) and cross-track clip move (`ClipMoveHandle`/`TrackDropZone`, `@dnd-kit/core`'s `useDraggable`/`useDroppable`/`DragOverlay`) both moved off native HTML5 drag onto dnd-kit's pointer-sensor model. Same-track drag/trim/resize stays on the timeline library's own native `flexible`/`dragLine` mechanism, unchanged (working since D-051, not what was broken). Full writeup, including two real implementation bugs found and fixed during this pass (a React-synthetic-event same-element-handler ordering issue, and a droppable-registration timing issue) and live StrictMode verification: D-098 in `docs/08-decisions.md`.

## B-027 — D-095's own auto-track-insert only handled "past the last row"; auto-created tracks were always `'video'`; cross-track clip move had no discoverable drag; a stale pre-D-088 rule silently blocked composited-layer overlap; the wider drag handle then broke same-track dragging
status: fixed (2026-09-04, D-096) · severity: medium (each a real friction point continuing the SAME drag-and-drop feature; one — the same-track regression — briefly severity-high before being caught and fixed within the same pass) · area: `packages/editor/src/TimelinePane.tsx`, `packages/editor/src/timeline.ts`, `crates/chroma-timeline/src/lib.rs`
- **found:** owner, live, continuing to test D-095 right after it landed: "how do i insert between video 1 and video 2" (a boundary between two EXISTING tracks did nothing special — only past-the-last-row auto-created a track); "it takes video if i drop to audio... we need to fix that as well" (an auto-created track was hardcoded `'video'` regardless of where/what was dropped); "i should be able to drag A001 to video_1 :o or vise versa" (trying to grab the clip BODY itself to move it cross-track, not hunting for the small D-095 grip icon); also asked for the same boundary-insert affordance to work above the very first track. Then, immediately after the resulting fix shipped (same pass, hot-reloaded into the owner's own live session): "its overlapping and not able to move horizontally in the same v1" — a real regression the wider drag handle caused.
- **cause (five related findings, one a regression this same pass introduced):**
  1. D-095's auto-track-on-drop only checked `y >= tracks.length * ROW_HEIGHT` (past the last row) — no equivalent check for an internal boundary between two existing tracks, or above the first one.
  2. Every auto-created track used a hardcoded `trackKind: 'video'` literal — never derived from anything real.
  3. Cross-track clip move was reachable only via a small (`size-3.5`, grown to `size-5` in D-095) corner grip icon — real, but not what a user instinctively reaches for.
  4. `move` (`timeline.ts`) and `move_clip` (`chroma-timeline`) rejected ANY destination-track overlap, cross-track included — correct back when only one video track's clip was ever visible per frame ("top wins"), stale since D-088 shipped a real multi-layer compositor without this rule being revisited.
  5. **Regression, caused by this same pass's own fix for #3**: widening the cross-track-move handle from a small corner icon to a full-width top strip made it an easy ACCIDENTAL grab for an ordinary same-track horizontal drag — and that handle's own `onDrop` explicitly no-op'd a same-track drop (correct when the handle was a near-impossible mis-grab; wrong once it was an easy one).
- **fix:** `trackInsertBoundary` (`TimelinePane.tsx`) generalizes the auto-track check to any `0..tracks.length` insertion boundary, each within a `TRACK_INSERT_BAND_PX` band of where two rows meet (past-the-last stays unconditional, unchanged from D-095); a mid-stack insert follows `add_track` with a `move_track`, reusing the exact `trackIndexAfterMove` selection-follow math the track-reorder drag already has. `inferNewTrackKind` derives the new track's kind from drop CONTEXT (the adjacent track) — verified first that `DraggedMedia`/`MediaItem` carry no real audio-vs-video signal on the dragged item itself today, so deriving from the item itself isn't possible without a real backend model change, out of scope here. The cross-track clip-move handle is now a full-width top strip (still a distinct hit target from the rest of the clip body, inset past the 10px edge-trim zones), deliberately NOT the whole clip body (would race the library's own same-track interact.js drag for the same mousedown with no reliable winner — the same class of risk D-074's relight-puck incident already taught this codebase to respect). `move`/`move_clip` now reject overlap only for a same-track move; a cross-track move landing on an occupied range composes as a real overlapping layer. **The regression**: a same-track drop via the strip's own mechanism now computes the drop frame and issues the same `move` op the library's own same-track drag would, instead of no-op'ing — so which mechanism actually caught the gesture no longer changes the outcome. Full writeup: D-096 in `docs/08-decisions.md`.

## B-026 — D-094's NLE drag-and-drop shipped with four real gaps, found live: no ripple-insert, track-reorder unreliable, no auto-track-on-drop, oversized drag ghost
status: fixed (2026-09-03, D-095) · severity: medium (each individually a real friction point in a core, constant-use interaction; none blocked the feature entirely) · area: `packages/editor/src/TimelinePane.tsx`, `packages/editor/src/timeline.ts`, `app/src/components/chroma/SourcesPanel.tsx`
- **found:** owner, live, four separate screenshots/messages in the same testing pass right after D-094 landed: (1) "so when i hover with new clip it goes not snap so i can add one in between two ones"; (2) "drag and resuffle does not works as well :/"; (3) "remove these tracks would with be.... added when we drop the clip" (the manual add-track buttons); (4) "after 18% we need to move...to 1 or two %" (the drag ghost image at low timeline zoom).
- **cause (four independent gaps):**
  1. `add_clip`'s `applyOp` case always computed `start_frame` via `nextAppendFrame` (append after everything on the track) — a drop's actual `clientX` was never converted to a timeline position at all, so hovering between two existing clips had no effect on where the new clip landed.
  2. D-094's track-reorder drag handle was shipped without live verification (its own report flagged this — no way to drive the real native Tauri/WKWebView window from this session's tooling). Verified this session via a real isolated-component browser harness that the drag/drop *logic* and DOM event wiring are correct (a real Chromium-driven drag correctly reordered tracks) — the gap is real mouse ergonomics on Tauri's macOS WKWebView specifically (a different, untestable-this-session engine): a bare 12px icon with no padding is a plausible real-mouse miss target, and WebKit is documented to sometimes need an explicit drag-source hint Chromium doesn't.
  3. Tracks could only be added via explicit toolbar buttons — dropping a clip past the last row silently landed on the last existing track instead of the standard NLE "drop below the last row creates a new track" affordance.
  4. `SourcesPanel.tsx`'s pool-item `onDragStart` never called `dataTransfer.setDragImage(...)`, so the browser's default drag image (a live snapshot of the full thumbnail+name+buttons card) was used — a fixed size, oblivious to the timeline's own zoom, absurdly large next to how small a clip actually renders at a low `pxPerSec`.
- **fix:** (1) `computeInsertion` (`timeline.ts`) resolves a drop's frame to either an open gap (no ripple) or a real ripple-insert snapped to the nearest clip edge — the one place this model intentionally gains ripple behaviour, still explicit-position-only everywhere else (`remove`/`trim`/`split`/`move`); a live insertion-line/new-track-ghost-row preview during drag-over. (2) grew both drag handles' real hit target (`size-3`/`size-3.5` → padded ~20px) and added `-webkit-user-drag: element`; the underlying logic was already confirmed correct. (3) the "+ 🎞"/"+ 🎵" toolbar buttons are gone; dropping past the last row now calls `add_track` then `add_clip` on the new track, with a dashed ghost-row preview during drag-over. (4) a small custom drag image (name only, `setDragImage` on a briefly-attached offscreen pill) replaces the default. Full writeup: D-095 in `docs/08-decisions.md`.

## B-025 — Edit tab stuck on "No project open" after opening a project; opening had no loading feedback
status: fixed (2026-09-03, D-085) · severity: high (blocks reaching the Edit tab at all after a fresh open) · area: `app/src/components/chroma/ProjectLauncher.tsx`, `app/src/main.tsx`
- **found:** owner, live, two screenshots: clicking a project "gets stuck in the click, it does not open," and the Edit tab shows "No project open" persistently once it lands, even though `app.log` confirms the project genuinely opened (grade migration ran, Colorist's own preview rendered).
- **cause:** two distinct gaps — (1) `handleOpen` had zero loading feedback during a real, sometimes multi-second open, inviting a second click that hit `openProject`'s own `busy` guard and surfaced a confusing "session busy" toast; (2) the existing B-007 fix (retry Edit's own `chroma_timeline_get` when a project opens) looked structurally correct on inspection but the owner's live report says it isn't landing reliably — root mechanism not fully proven, treated as a narrow timing race.
- **fix:** a real `opening` loading state + spinner on the clicked project card, disabling every card while any open is in flight (closes the double-click race at the UI level); the Edit tab's own load effect now retries once, 500ms later, if it lands on an error state. Full writeup: D-085 in `docs/08-decisions.md`.

## B-024 — Edit-tab timeline: dragging a clip froze the UI
status: fixed (2026-09-03, D-083) · severity: high (drag-and-drop is a core, constant-use interaction) · area: `packages/editor/src/TimelinePane.tsx`
- **found:** owner, live, screenshot: "when i drag and drop the UI freezes up this is not performant at all."
- **cause:** `getActionRender`/`onClickAction`/`onActionMoveEnd`/`onActionResizeEnd`/`onScroll` were inline arrow functions in the `<TimelineEditor>` JSX — a new identity every render. A native drag fires `dragover` continuously, and the unconditional `setDragOver(true)` on every tick meant `@xzdarcy/react-timeline-editor` got a brand-new copy of all five props on every tick, defeating whatever per-item skip-rendering it does and forcing a full re-render (including canvas recreation for every `Waveform`) across every track on every single tick. The same inline-function pattern predates D-080 (confirmed via `git show` against the pre-D-080 revision) but re-rendering one hardcoded row was cheap enough to never be felt — D-080's multi-row rewrite made the cost scale with track count, turning it into a real freeze.
- **fix:** the five props are now `useCallback`-wrapped with real dependency arrays instead of redefined every render; `setDragOver` is gated to only dispatch when the value would actually change. Full writeup: D-083 in `docs/08-decisions.md`.

## B-023 — Relight `distance` swept the lit side of the face instead of moving the light nearer/farther; some distance/radius combos silently zeroed the light entirely
status: fixed (2026-09-03, D-079) · severity: high (positional lights unreliable/confusing to use even after B-022/D-076 made them work at all) · area: `app/src-tauri/src/shaders/shader.wgsl`
- **found:** owner, live, sliding Distance through several values with screenshots at each: "see the distance right working weirdly instead of light coming closer and going in depth, we are getting like rounding angle changing."
- **cause (two, compounding):** (1) the depth delta driving the light's *direction* used the same full strength as the one driving falloff/brightness — since a real face has real depth variation (nose vs. ears), a single global `distance` value shifted every pixel's incidence angle non-uniformly as it changed, reading as the light rotating around the face. (2) fixing (1) surfaced a second, independent bug: D-078's 3D falloff compared the raw z-offset directly against `radius`, so a `distance` meaningfully different from a surface's depth (the entire point of the control) could make z alone exceed `radius` and zero the light out completely, even directly under the puck.
- **fix:** direction now uses a heavily damped copy of the depth delta (`× 0.15`) while falloff keeps the full-strength one; depth-based dimming is now a separate, gentle, never-fully-zeroing multiplier instead of being folded into the same radius-gated distance. Full writeup: D-079 in `docs/08-decisions.md`.

## B-022 — Relight positional lights rendered zero visible effect on real footage, even fully configured
status: fixed (2026-09-03, D-076) · severity: blocker (the entire key/fill/rim relight feature never worked, on any footage, at any point this session — see the B-018 note below) · area: `app/src-tauri/src/chroma/relight.rs`, `app/src-tauri/src/image_processing.rs`, `app/src-tauri/src/shaders/shader.wgsl`, `app/src/components/chroma/RelightPanel.tsx`
- **found:** owner, live, with a fully-configured positional light (color set,
  Power=200, Distance=55, puck positioned on the subject, depth bake
  confirmed ready): "just so you know nothing is getting applied at all."
- **cause:** the "Distance" slider on the panel was bound to `radius` (2D
  falloff size) — there was no real z/depth field anywhere in
  `RelightLight`. In the shader, a light's z was derived only by comparing
  the depth value at the light's *own* anchor pixel against each shaded
  pixel's depth — on real footage (relatively flat depth near wherever a
  light is actually dropped, e.g. a face) that delta is ~0 everywhere, so
  the shading term (`dot(normal, light_dir)`) collapsed to ~0 almost
  everywhere the light could matter. The light was always flush against
  whatever surface it was dropped on; nothing ever elevated it.
- **relationship to B-018:** B-018 (same session, fixed earlier) diagnosed a
  real, separate bug — a 2-day-stale sidecar silently 404ing "Track Depth" —
  and its own writeup claimed to be "the actual root cause behind every 'no
  light shows' report this session." That fix was real and necessary, but
  not sufficient: this bug was still present underneath it the entire time.
  No live confirmation of a visible relight effect had occurred at any point
  in this session, including after B-018 landed.
- **fix:** added a real `distance` field end-to-end (data model → Rust
  parsing → GPU uniform → shader z-computation → a correctly-labeled UI
  slider), defaulting to a nonzero value so a fresh light is immediately
  lit rather than needing the owner to discover a slider first. Full
  writeup, including the exact shader math and the new GPU-render
  regression test that reproduces the bug on a flat synthetic depth map:
  D-076 in `docs/08-decisions.md`.

## B-021 — Dragging a relight light puck on the Colorist canvas also scrubbed the video frame
status: fixed (2026-09-03, D-074) · severity: medium · area: `app/src/components/panel/Editor.tsx`, `app/src/components/panel/editor/RelightPuckLayer.tsx`
- **found:** owner, live, screenshot: "when i move this the frame is moving as well please fix it."
- **cause:** `Editor.tsx`'s pan/zoom handler is `onPointerDownCapture` on an
  ancestor of the puck — capture phase fires before the puck's own
  bubble-phase handler, so the puck's existing `stopPropagation()` couldn't
  undo it.
- **fix:** the puck carries `data-relight-puck="true"`; `Editor.tsx`'s
  capture-phase handler checks for it via `closest()` and returns
  immediately if found, before doing anything else. Full writeup: D-074 in
  `docs/08-decisions.md`.

## B-020 — Colorist never actually picked up Edit-tab timeline changes; a deleted clip lingered forever as a "ghost" shot
status: fixed (2026-09-03, D-071) · severity: high (undermines D-070's whole point — same session, immediate retest) · area: `app/src-tauri/src/chroma/project.rs`, `app/src-tauri/src/chroma/state.rs`, `app/src/store/useSessionStore.ts`, `app/src/main.tsx`
- **found:** owner's own live retest of D-070, immediately after it landed — dragged a clip onto the Edit tab's timeline, switched to Colorist, the clip wasn't there. Separately spotted a clip already deleted from the media pool still showing as a shot in the Colorist strip.
- **cause:** `chroma_timeline_set` (the Edit tab's own save path) never calls `open_manifest`, the one function that refreshes Colorist's clip list — nothing else was ever wired to do it either (`syncFromRust`, the function whose name suggests this exact job, was dead code, never called anywhere). Separately, `state::Session` (the in-memory decode session backing the shot strip) was never pruned by anything short of a full reset on a full project open — a removed clip just stayed forever.
- **fix:** new `chroma_project_resync_clips` command diffs the active timeline's real clips against the session, decodes new ones, prunes stale ones, and — the reason this isn't just "call `chroma_project_open` again" — only re-picks the active clip if it was one of the pruned ones, so a manual selection in the shot strip survives a resync that doesn't actually affect it. Triggered on Colorist tab focus. Full writeup: D-071 in `docs/08-decisions.md`.

## B-018 — Track Depth silently did nothing: a 2-day-stale AI sidecar process, 404ing, silently accepted as success
status: fixed (2026-09-03, D-069) · severity: high (the entire Relight key/fill/rim feature was unusable — this is the actual root cause behind every "no light shows" report this session) · area: `app/src-tauri/src/chroma/depth.rs`, the external `ai/` sidecar process, `chroma::sidecar::spawn_and_supervise`
- **found:** owner: "clicked track depth multiple time" — real logging (D-067, this same session) made it diagnosable immediately: `app.log` showed `chroma_depth_track: job started, response: {"detail":"Not Found"}` on every click.
- **cause:** the process answering `:8765` had been running since Tuesday, Sept 1, 21:19 — over two days, from before `/depth_track` was added to `ai/server.py`. `chroma::sidecar::spawn_and_supervise` (D-028) checks once, at app boot, whether anything already answers `/health`; if so it defers entirely, with no version/capability check beyond a bare 200. Every restart tonight found that same stale process alive and deferred to it, so the staleness was invisible to every one of tonight's actual app rebuilds. Separately: `chroma_depth_track` never checked HTTP status before parsing the body as success — a 404's `{"detail":"Not Found"}` parsed as "valid" JSON with neither `error` nor `dir`/`job_id`, so the command returned `Ok` with nothing useful, and the frontend's only visible symptom was silence.
- **fix:** killed the stale sidecar process, restarted via `ai/run.sh` — confirmed live via `curl /health` and a direct `curl -X POST /depth_track`. `chroma_depth_track`/`_status` now check `response.status()` before parsing anything, with a real error (including an inline hint about exactly this failure mode) on any non-2xx — closes the whole failure class, not just this instance.
- **deferred, now resolved:** should `spawn_and_supervise`'s health check verify the responding process actually has the expected routes/capabilities, rather than trusting a bare 200 forever? **Yes — done, D-101 (2026-09-04).** `/health` now reports a content hash of `ai/server.py`; a mismatch is detected and surfaced (`SidecarStatus.stale`, a real Settings UI card), refuse-and-warn policy (never auto-killed). Live-verified against this very session's own real sidecar, which had independently gone ~6 hours stale by the time D-101 landed — the same failure class as this bug, caught live rather than by chance.

## B-017 — Relight "Clear"/delete-last-keyframe never actually removes the light's keyframes
status: fixed (2026-09-03, D-066) · severity: medium (a real edit silently no-ops — clicking "Clear" looks like it worked, but the keyframes are still there) · area: `app/src/components/chroma/RelightPanel.tsx`
- **found:** owner's own hands-on testing, 2026-09-03.
- **cause:** `writeLightParams` (the callback backing the keyframe "Clear"/"X" buttons, separate from `updateActiveLight` which correctly does a partial-patch merge for the Color/Power/Distance sliders) applied its result via `{ ...l, ...next }`. `clearKeyframes`/`removeKeyframe` (`utils/maskKeyframes.ts`, shared with D-034's mask keyframes) signal "no keyframes left" by **deleting** the `chromaKeyframes` key from the object they return — but a spread merge can only *overwrite* a key present in the right-hand object, never un-set one absent from it. `next` (the result) has no `chromaKeyframes` key to overwrite `l`'s stale one with, so the old value silently survived every click. The shared mechanism itself is correct — `MaskKeyframeBar.tsx` (mask geometry keyframes, the original D-034 UI) replaces `sub.parameters` wholesale rather than spread-merging it, and doesn't have this bug; this was specific to how `RelightPanel.tsx` composed the reused pieces.
- **fix:** `writeLightParams` now replaces the light outright (`next` is always already a complete light object from the three keyframe functions, never a partial patch) instead of spread-merging.

## B-016 — Colorist fullscreen preview has no way back out: no close button, Escape didn't work either
status: fixed (2026-09-03, D-065) · severity: medium (not stuck forever — the app-level tab bar still switches tabs — but a real dead end inside the preview itself) · area: `app/src/components/panel/Editor.tsx`
- **found:** owner's own hands-on testing, 2026-09-03 — "after doing full screen on colorist no way to go back... no cross no esc etc."
- **cause:** the fullscreen-exit button lived only inside `EditorToolbar`, and the toolbar's own wrapping container is set to `max-h-0 opacity-0` exactly when `isFullScreen` is true — the one control that could exit fullscreen was hidden by fullscreen itself. Separately, `handleToggleFullScreen` exists as two independent, undeduplicated closures (`App.tsx`, wired to the Escape-key shortcut; `Editor.tsx`, wired to the toolbar button) with no prop threading connecting them — a real duplication smell, not fully root-caused for why Escape specifically didn't fire (both closures write the same `useUIStore.isFullScreen` flag, so they *should* be equivalent), left as a known follow-up rather than a risky untested refactor this pass.
- **fix:** a dedicated close (`X`) button, always rendered when `isFullScreen` (outside the toolbar's collapsing container, `z-50`, fixed position), calling `setUI({ isFullScreen: false })` directly — bypasses both `handleToggleFullScreen` closures entirely, so it's a guaranteed exit regardless of whatever's happening with either of them.
- **deferred:** consolidate the two `handleToggleFullScreen` closures into one (thread it as a prop `App.tsx` → `EditorView` → `Editor`, or lift the toggle into `useUIStore` as an action) and confirm live whether Escape's dead-end was a real bug in that duplication or something else entirely.

## B-019 — A clip dragged onto the Edit-tab timeline never showed up in Colorist at all — "add to grading" was a separate, silently-required second step
status: fixed (2026-09-03, D-070) · severity: high (reads as "the app lost my clip," not just missing polish) · area: `app/src-tauri/src/chroma/project.rs`, `app/src/store/useSessionStore.ts`, `app/src/components/chroma/ShotStrip.tsx`
- **found:** owner's own live repro, 2026-09-03 — "Colorist shows nothing even though I have a shot selected [on the Edit tab]," while looking at Resolve for comparison ("we have one clip we add ... not multiple").
- **repro:** open a project, drag any Sources-panel item onto the Edit tab's timeline.
- **expected:** the clip is immediately gradable in Colorist, same clip, same identity — no separate step.
- **actual (pre-fix):** nothing in Colorist changed at all. The shot strip (`ShotStrip.tsx`, via `useSessionStore`) read `ProjectManifest.shots` (`ProjectShot`, a separate persisted list keyed by pool-item id), which only `chroma_project_add_shot` ("+" in the Sources panel) ever appended to. A drag onto the Edit tab created a `chroma_timeline::Clip` on an entirely different list, with no structural link back to `ProjectShot` at all — the two "this clip exists in my project" actions never talked to each other.
- **cause:** not one bug in either list — both `ProjectShot` and `chroma_timeline::Clip` did exactly what they were each individually built to do (D-046, D-054). The gap was structural: **four** independent representations of "a clip" existed at once (`state::Shot`, `useSessionStore.shots`/`.grades`, `ProjectShot`, `chroma_timeline::Clip`), each with its own keying scheme, none aware of the others. Full trace in `docs/notes/unified-clip-model.md`.
- **fix:** `chroma_timeline::Clip` becomes the single source of truth (`Clip.media_id`, new); Colorist's shot strip now reads the active Edit-tab timeline's clips directly, so a dragged clip is immediately visible and gradable — no second "add to grading" step required (though the "+" button stays, now as a convenience that does the same append server-side). `ProjectShot` retired as the persisted grading list. Full writeup, matching/migration detail, and real numbers: D-070 in `docs/08-decisions.md`.

## B-015 — Colorist preview flashes to a blank/stale image on every shot switch, with no loading indication
status: fixed (2026-09-03, D-063) · severity: medium (no data loss; reads as broken, not just unpolished — this is what the owner reported as "a refresh/flicker") · area: `app/src/components/panel/Editor.tsx`, `app/src/store/useSessionStore.ts`
- **found:** owner's own hands-on testing, 2026-09-03 — clicking a different shot in the strip, or "add to grading" from Sources, showed a brief flash with nothing telling them whether it was loading or had actually failed.
- **cause:** a real loading-spinner overlay already existed in `Editor.tsx` (`showSpinner`, a full-screen `Loader2`) but was wired to `useLibraryStore.isViewLoading`, a flag with exactly one `true`-setting call site in the whole app — RapidRAW's original still-image `handleImageSelect` flow, unreachable from the video-only Colorist UI since D-043. The real "select a video" operations (`switchToShot`, `_hydrateOpenDto`) never touched it. Separately, `_hydrateOpenDto` itself never toggled `useSessionStore.busy` at all — four internal callers each separately remembered to wrap their own call in `busy: true`/`false`, but `SourcesPanel`'s "add to grading" (the most likely actual trigger) called it directly and didn't.
- **fix:** `isLoading` in `Editor.tsx` now also reads `useSessionStore.busy`; `busy` toggling moved inside `_hydrateOpenDto` itself (try/finally) so every caller gets it regardless of whether it remembers to wrap the call. See D-063 for the full writeup.

## B-014 — "Import" in the Sources panel is slow to open the native file-picker dialog
status: fixed (2026-09-03) · severity: medium (no data loss, but a real, reproducible perf regression on a primary action) · area: `app/src-tauri/src/chroma/project.rs` (`chroma_media_list`/`_import`/`_move`)
- **repro:** open a project with the Sources panel visible (mount alone
  triggers a `chroma_media_list` refresh), click "Import".
- **expected:** the native multi-select file dialog (`@tauri-apps/plugin-dialog`'s
  `open()`, via `ProjectLauncher.pickClips` — reused by `SourcesPanel.doImport`)
  appears immediately; nothing runs between the click and the `open()` IPC
  call.
- **actual:** a real, measurable delay before the dialog appears. Traced to
  `chroma_media_list`, `chroma_media_import`, and `chroma_media_move` all
  being plain (non-`async`) `#[tauri::command]` functions — confirmed against
  `tauri-macros` 2.6.3's `command::wrapper` source: a non-`async fn` command
  defaults to `ExecutionContext::Blocking`, whose generated body
  (`body_blocking`) calls the command directly (`let result = $path(...)`)
  inline wherever the IPC message is dispatched — the main UI thread on
  macOS — rather than going through `respond_async_serialized`/the async
  runtime the way every sibling `async fn` command in the same file
  (`chroma_project_open`/`_save`/`_add_shot`) already does. `chroma_media_import`
  compounds this: `probe_media_item` shells out to `ffprobe` (and, after
  D-059, `ffmpeg` for a thumbnail) per path — real, occasionally slow
  blocking work — synchronously on that same thread. Any of these three
  commands in flight (the panel's own mount-time `refresh()`, or a
  same-session import) directly delays the next IPC message the main thread
  processes, including the dialog-open call, which macOS requires be
  presented from the main thread.
- **fix:** all three converted to `async fn` (D-059) — no longer inline on
  the main thread. `chroma_media_import` additionally wraps its probing in
  `tokio::task::spawn_blocking`, matching the existing convention
  `chroma_frame_thumbnails`/`chroma_session_thumbnail` already use for their
  own `ffmpeg`/`ffprobe` subprocess calls, keeping it off the async
  runtime's shared worker threads too, not just off the main thread.
- **verified:** the root cause is a direct, source-level finding (read
  against `tauri-macros` 2.6.3 itself, not inferred), not a guess. Live
  click-to-dialog-appear timing via `osascript`/System Events (the same
  mechanism D-046's own verification used) showed no measurable difference
  before/after on an idle, low-media-count repro — an honest result, not
  proof there's nothing to fix; see D-059 for the full account of what that
  test could and couldn't show, and why the fix stands on the source-level
  finding regardless. `cargo test chroma::` covers the async conversion
  (existing `media_move_refiles_an_existing_item` now drives the command on
  a `tokio::runtime::Builder::new_current_thread()`, same pattern
  `chroma_project_save_attaches_a_new_shot_to_the_pool` already used for
  `chroma_project_save`).

## B-009 — duplicate `remotion` packages crash the app at runtime with "Multiple versions of Remotion detected"
status: fixed (2026-09-02) · severity: blocker (crashed frontend mount entirely, not just the Motion tab) · area: root `package.json` `overrides`, `packages/motion-engine/package.json`'s caret-pinned `@remotion/*` deps
- **repro:** boot the app (`npm run tauri:dev`) with `packages/motion-engine`'s
  `@remotion/animation-utils`, `@remotion/google-fonts`, `@remotion/motion-blur`,
  `@remotion/noise`, and `@remotion/transitions` (+ its own `@remotion/shapes`
  dependency) pinned with a caret range (`^4.0.519`) while every other
  `@remotion/*`/`remotion` dependency in the workspace is pinned exactly
  (`4.0.519`).
- **expected:** the app boots; the Motion tab (which imports
  `@remotion/google-fonts` via `Video.tsx`'s top-level `loadFont()` call —
  evaluated at module-load time, unconditionally, regardless of which tab
  is visually active, since `@chroma/shell` keeps every tab mounted) loads
  without error.
- **actual:** the whole frontend fails to mount. Vite's client logs an
  unhandled error — `TypeError: 🚨 Multiple versions of Remotion detected:
  4.0.520 and 4.0.519` — thrown by Remotion's own runtime version-check
  (`checkMultipleRemotionVersions`), and the Rust side times out waiting
  for `frontend_ready`, logging "Frontend failed to report ready within
  timeout. Forcing window visibility" and showing a blank window.
- **cause:** a caret range lets npm resolve to the newest *published*
  matching version at install time, not the version every other package in
  the tree is pinned to. `4.0.520` was published after `4.0.519`, so npm
  resolved the five caret-pinned `@remotion/*` packages (each an exact
  dependency on `remotion@4.0.520`, matching their own package version) to
  a nested `4.0.520` install, while the rest of the tree correctly deduped
  to the exactly-pinned `4.0.519`. Remotion's runtime hard-errors the
  instant two `remotion` module instances load in the same page — by
  design, since mixed-version Remotion internals aren't guaranteed
  compatible.
- **fix:** a root `package.json` `overrides` block pins `remotion` and all
  five caret-pinned `@remotion/*` packages to the exact `4.0.519` used
  everywhere else. **A newly-added/changed `overrides` key did not reliably
  take effect via an incremental `npm install`, even after `rm -rf
  node_modules`** — the existing `package-lock.json`'s already-resolved
  entries for those packages kept getting replayed. Only a genuinely fresh
  resolution — `rm -rf node_modules package-lock.json && npm install` —
  produced a lockfile with exactly one `remotion` install (root, `4.0.519`,
  confirmed via `find . -path "*/node_modules/remotion/package.json"`).
- **verification:** a real `npm run tauri:dev` boot, twice, with the dev
  server stdout and the app's own log file both staying clean for the
  whole session — no "Multiple versions of Remotion" error, no
  frontend-ready timeout — versus every prior boot attempt this session
  hitting the error within seconds of the frontend starting to evaluate.

## B-008 — `@react-three/fiber`'s global JSX augmentation breaks any `React.ElementType`-typed component sharing its `tsc` program
status: fixed (2026-09-02) · severity: medium · area: `packages/ui/src/Text.tsx`, `app/src/components/panel/BottomBar.tsx`
- **repro:** in a `tsc` program that includes any file importing
  `@react-three/fiber` (e.g. `@chroma/motion-engine`'s `Scene3D.tsx`/
  `ParticleFlow.tsx`, first pulled into `app`'s program by wiring the
  Motion tab, D-046) alongside a component that renders a
  `React.ElementType`-typed prop via JSX (`<Component {...props}>` where
  `Component`'s static type is `React.ElementType`, not a concrete tag).
- **expected:** unrelated files type-check independently of what else is in
  the program.
- **actual:** the unrelated component fails to type-check —
  `error TS2745: This JSX tag's 'children' prop expects type 'never'…` and
  similar `never`-typed prop errors — even though nothing about that
  component changed.
- **cause:** `@react-three/fiber` augments the **global** `JSX.IntrinsicElements`
  interface (that's how `<mesh>`, `<group>`, etc. type-check anywhere) — a
  program-wide effect, not scoped to files that import r3f. Once present,
  `React.ElementType` (`keyof JSX.IntrinsicElements | ComponentType<any>`)
  is a much larger union that now includes r3f's custom intrinsics, whose
  prop shapes don't share a compatible `children` type with DOM elements.
  TS computing the intersection of props across that whole union for a
  dynamic `<Component>` JSX call collapses `children` (and other props) to
  `never`. Two pre-existing components used this "dynamic tag via a
  `React.ElementType` prop, rendered with JSX" pattern and both broke the
  moment r3f entered the same program for the first time: `@chroma/ui`'s
  `Text.tsx` (`as` prop) and `app`'s `BottomBar.tsx`'s `PanelToggleButton`
  (`Icon` prop).
- **fix:** `React.createElement(Component, props, children)` /
  `createElement(Icon, { size: 18 })` in place of JSX for that one call in
  each file — behaviorally identical (JSX desugars to the same call at
  runtime; this changes nothing about what renders), but `createElement`'s
  generic signature doesn't distribute over `JSX.IntrinsicElements` the same
  way JSX's own type-checking does, so it type-checks correctly whether or
  not r3f's augmentation is present.
- **verification:** a strict `tsc --noEmit` diff of `app/` before vs. after
  the full Motion tab change (file list, not just count) came back
  byte-identical (64 errors either side) — used specifically to catch every
  instance of this pattern application-wide, not just the ones exercised by
  manually clicking through the UI. Any *other* `React.ElementType`-via-JSX
  component elsewhere in the codebase would show up the same way if r3f's
  augmentation reaches its program later.

## B-007 — Edit tab stuck on stale "no project open" after opening a project in Colorist
status: fixed (2026-09-02) · severity: medium · area: app/src/main.tsx, @chroma/shell tab persistence
- **repro:** open the app, open/create a project in the Colorist tab, switch to the Edit tab
  in the same window (no alt-tab away and back).
- **expected:** Edit shows the real timeline for the project that was just opened.
- **actual:** Edit kept showing "No project open" until either the user hit its "Retry"
  button, or the OS window happened to lose and regain focus (alt-tab) — a real fix
  eventually arrived, just not from opening the project itself. Owner correctly diagnosed
  this live as a "state mounted at the Colorist level, not global" question before the fix
  was found.
- **cause:** `@chroma/editor`'s `EditorTab` only calls its timeline store's `load()` on its
  own mount and on the browser `window`'s `focus` event (see its `useEffect`s) — neither
  fires when a project opens from the Colorist tab, since all 3 tabs stay mounted under
  `@chroma/shell` (D-039) and switching tabs is not a window focus event.
- **fix:** `app/src/main.tsx` (the composition root — the one place that legitimately knows
  about both `useSessionStore`'s real "project is open" signal and `@chroma/editor`'s
  timeline store, without either package importing the other) now calls
  `useEditorTimelineStore.getState().load()` in a `useEffect` keyed on the same
  `projectOpen` boolean that already drives the shell's launcher-vs-tabs routing.
- **also fixed alongside (same root cause family):** `@chroma/shell`'s `activeTab` was
  persisted to `localStorage`, which meant the owner's explicit "Edit opens by default, not
  Colorist" request (2026-09-02, `D-039`/earlier `B-004` commit) only held on a machine that
  had never clicked another tab — every real session immediately overrode it back to
  whatever tab was last open, reading as if the default fix never landed. `activeTab` is now
  session-only (`packages/shell/src/store.ts`); every launch starts on `DEFAULT_TAB` ('edit').

## B-006 — Colorist main preview stays black even once the wgpu transform is positioned correctly
status: fixed (2026-09-02) · severity: high · area: `@chroma/shell` root background (`packages/shell/src/Shell.tsx`) — not gpu_processing.rs
- **repro:** open a project with a video shot in the Colorist tab; the shot-strip thumbnail
  renders fine, the main preview viewport never shows anything (solid dark/black).
- **expected:** the main preview shows the decoded, graded frame — the native wgpu surface,
  drawn directly onto the window behind a transparent hole in the webview at the preview
  panel's on-screen position (see `update_wgpu_transform`, `WgpuDisplay::render`).
- **actual (pre-fix):** `apply_adjustments` logs confirmed a real WGPU render fired at the
  *correct* output resolution and the *correct* on-screen position — the panel was still
  visually black regardless.
- **cause:** the render pipeline itself was never the problem. D-039's `@chroma/shell`
  wraps the whole window in a new root `<div>` (`Shell.tsx`) that carried a hardcoded,
  unconditional `bg-bg-primary` (opaque). The Colorist app's own root (`App.tsx`) already
  punches a transparent "hole" through itself (`isWgpuActive ? 'bg-transparent' :
  'bg-bg-primary'`) so the OS-transparent window (and the wgpu surface drawn directly onto
  it) shows through — but that hole only reveals whatever sits *behind* it in the DOM, which
  after D-039 is the shell's own new, permanently-opaque background, not the real
  transparent window. Before D-039 the Colorist app's root *was* the window's content root,
  so there was no opaque ancestor in the way and the trick worked. The shell's own opaque
  background silently defeated it once introduced — a plain CSS stacking regression, not an
  NSView/CALayer ordering issue and not a scissor/DPI bug.
- **how this was actually isolated (not by reasoning alone):** with no screen-recording
  permission available in the session that found this (`screencapture` failed with
  "could not create image from display" from every invoking path tried), two proxies stood
  in for a real screenshot: (1) a temporary debug hook in `WgpuDisplay::render` re-ran the
  *exact same* clear/scissor/bind-group/draw call into an off-screen `COPY_SRC` texture
  (the swapchain texture itself doesn't support `COPY_SRC`) and dumped it to PNG — this
  showed the real graded frame, correctly positioned, proving the render pass, scissor math,
  and bound texture were all already correct, and pointing the remaining search at
  compositing/visibility rather than rendering; (2) after the fix, a live
  `getComputedStyle` read of the shell root in the running app confirmed its
  `background-color` actually flips to `rgba(0, 0, 0, 0)` exactly when the Colorist wgpu
  surface is active. Both were run against the real app with the real
  `~/Movies/Chroma/New.chroma` project open. A final from-cold-boot re-check hit an
  unrelated environment wedge (WebKit's `markLayersVolatile`/process-suspension throttling
  the webview after this session's own repeated hard `kill -9` cycles on the dev app — see
  `sample`/`log show` trace from that session; confirmed unrelated to this fix since
  `gpu_processing.rs` and `lib.rs` carry zero diff from before the investigation started)
  and was not retried further; the two proxies above are the verification this fix rests on,
  not a literal on-screen screenshot.
- **fix:** `packages/shell/src/store.ts` — add a session-only (not persisted)
  `wgpuSurfaceActive` flag to `useShellStore`. `app/src/App.tsx` mirrors its own
  `isWgpuActive` into that flag via a `useEffect` (app → shell is the correct dependency
  direction here; shell still never imports the Colorist app). `Shell.tsx`'s root class now
  reads it: `wgpuSurfaceActive ? 'bg-transparent' : 'bg-bg-primary'`, restoring the same
  "no opaque ancestor between the window and the app's own hole" invariant D-039 broke. The
  tab bar and the project-launcher overlay both paint their own explicit backgrounds so they
  stay opaque regardless.
- **not this bug, ruled out during investigation:** `WgpuDisplay::render`'s scissor/clip
  math and `self.config` sizing — a live debug log during investigation showed
  `config` tracking the real window size correctly (the existing `on_window_event`
  `Resized` handler does keep it in sync) and the scissor bounds landing well inside it with
  `will_draw=true` every time; the off-screen dump then confirmed the draw itself was
  correct. Not a DPI/physical-vs-logical-pixel mismatch either — both sides already agree on
  physical pixels.

## B-005 — Colorist wgpu-position sync loop permanently stuck hidden after one transient 0×0 layout read
status: fixed (2026-09-02) · severity: high · area: app/src/components/panel/Editor.tsx (syncWgpu)
- **repro:** open a project / switch tabs so the preview container's `getBoundingClientRect()`
  briefly reads `0×0` during a layout transition (e.g. a tab switch) at the same moment
  `hasRenderedFirstFrame` flips true.
- **expected:** once the container actually lays out to a real size, the native wgpu frame
  is positioned there and becomes visible.
- **actual:** the frame stayed hidden (positioned at `x:-999999,y:-999999`) forever, even
  after the container had a real, valid size — required an unrelated dependency-array change
  (e.g. toggling a setting) to ever recover, or never recovered at all.
- **cause:** `syncWgpu`'s `requestAnimationFrame` self-scheduling loop only reschedules itself
  when the outgoing "hidden transform" string changes (a dedup guard against redundant
  `invoke()` calls). A transient `0×0` read produces one specific hidden-transform string;
  once sent, the loop stops rescheduling — nothing re-measures the container after that,
  since real DOM layout changes aren't part of the effect's dependency array (only React
  state is). Confirmed via a temporary debug log: `hasRenderedFirstFrame: true` but
  `rectW: 0, rectH: 0` at the exact moment the loop went silent.
- **fix:** split the single hidden-condition check into `notLaidOutYet` (a DOM-measurement
  state, not covered by any dependency array — must keep polling every frame until it
  resolves) vs. `notReadyToRender` (real React-state conditions, correctly covered by the
  existing dependency-array effect). `notLaidOutYet` now unconditionally calls
  `scheduleSync()` even when the outgoing transform was deduped, so measurement keeps
  polling until the container genuinely has a size — without spamming `invoke()`, which
  stays deduped as before.

## B-004 — entry module double-executes on every cold boot → corrupted Tauri IPC → "No project open" in Edit, blank Colorist preview
status: fixed (2026-09-02) · severity: blocker · area: app/index.html, frontend↔backend IPC
- **repro:** fresh `npm run tauri:dev` (verified across independent cold boots, port + processes killed first). Within ~2s of "Logger initialized successfully": `ReactDOMClient.createRoot() on a container that has already been passed to createRoot()`, then a burst of `[TAURI] Couldn't find callback id N` warnings and `Unhandled promise rejection TypeError: undefined is not an object (evaluating 'listeners[eventId].handlerId')` in `@tauri-apps/api/event.js`'s `_unlisten`, repeated several times.
- **expected:** Edit tab shows a real timeline once a project with shots is open in Colorist; Colorist's main preview viewport shows the current frame (not just the shot-strip thumbnail).
- **actual:** Edit tab stuck on "No project open" even with a project open and a shot visible in Colorist's shot strip; Colorist's own main preview viewport blank, though its shot-strip thumbnail rendered fine and the Rust backend logged successful `[apply_adjustments] … native WGPU display updated` renders. After the corruption, no further `invoke`/`listen` round-trip reached React for the rest of the session.
- **cause:** `app/index.html`'s entry `<script>` still pointed at `/src/main.jsx`, a file that hasn't existed since the D-039 TS rename (`main.tsx` is the real entry) — a dead reference `git log` shows predates `main.tsx`. Confirmed via a temporary `import.meta.url` probe at the top of `main.tsx`: on cold boot the module body runs **twice**, once for each of two distinct URLs — `http://localhost:1420/src/main.jsx` (the browser's literal fetch of the stale `<script src>`, which Vite's dev-server extension-probing fallback resolves to `main.tsx`'s real source and serves under the wrong module id) and `http://localhost:1420/src/main.tsx` (a second, genuinely separate fetch/execution of the same file under its correct canonical URL). Two independent top-level module executions call `createRoot()` on the same `#root` DOM node and independently wire up `useTauriListeners`' `listen()` calls (including `wgpu-frame-ready`, which the Colorist preview depends on) against the same shared `@tauri-apps/api/event.js` singleton, racing on `listen`/`unlisten` bookkeeping and corrupting the callback-id map — after which further `invoke`/`listen` resolutions silently stop reaching React. `chroma_timeline_get`'s real error text (`"no project open — open one in the Colorist tab"`) matches exactly what Edit tab's empty-state renders, confirming the open-project `invoke` was one of the calls that never resolved correctly.
- **fix:** `app/index.html` — `<script type="module" src="/src/main.jsx">` → `/src/main.tsx`. Re-verified with the same `import.meta.url` probe on a fresh cold boot: the module executes exactly once, no `createRoot` warning, no `unlisten` TypeError, for the whole session. Re-verified the two user symptoms directly (via `osascript`/System Events driving the real app window, since WKWebView exposes real accessibility): opened the existing `~/Movies/Chroma/New.chroma` project (a genuine saved `.chroma` project, not an Untitled/loose-clip session) — Edit tab's "No project open" state was replaced by a real Timeline pane, and Colorist's main preview `<img>` (726×516, positioned as the main viewport, distinct from the 49-thumbnail shot strip) rendered, with matching `[apply_adjustments] … WGPU display updated` log lines tied to the same action.
- **note:** unrelated to this bug — that one test project's `project.json` already had a *persisted-empty* `timeline` field (0 clips despite 1 shot) predating this session, most likely written during an earlier session while this same corruption was active. `chroma_timeline_get` returns a project's persisted timeline as-is once one exists (by design, D-041) rather than rebuilding, so that project's Edit timeline still shows 0 duration until its `timeline` field is cleared or a shot is re-added — a stale-data artifact of the bug's *effects*, not a remaining defect in the fix.

## B-002 — AI sidecar climbs to ~12 GB after repeated "Re-track"
status: fixed (2026-09-01) · severity: high · area: ai/server.py
- **repro:** load a video, track a subject, hit "Re-track subject across clip" several times (or scrub a lot during a track).
- **expected:** sidecar RSS bounded — one predictor + models ≈ 1–1.5 GB.
- **actual:** ~12 GB (mostly compressed under memory pressure; `ps` RSS showed ~330 MB resident, Activity Monitor "Memory" 12 GB). Machine hit 20 GB swap.
- **cause:** each `/track` built a *fresh* `SAM2DynamicInteractivePredictor` (~1 GB into the MPS pool, which never returns to the OS); track + on-seek `/refine_track` + ViTMatte warm-up ran concurrently, stacking their MPS working sets. The propagation loop itself is flat (verified — `memory_bank` stays at 1).
- **fix:** `_GPU` lock serialises every model call (per-frame in the track loop so refine interleaves); `_get_video_predictor` reuses one instance with per-track state reset; `_free_gpu()` (`empty_cache` + `gc`) after every `/segment`, `/refine_track`, and track pass; `/track` cancels any still-running track. Measured after: plateaus ~1.3 GB across repeated tracks, refines pull it back toward ~800 MB (577 MB after an hour of heavy testing).

## B-003 — tracking seek: render storm, frozen timeline, offset overlay
status: fixed (2026-09-01) · severity: high · area: engine + frontend
- **repro:** track a subject, click/scrub the timeline.
- **actual:** timeline playhead frozen; canvas re-rendering continuously (`apply_adjustments` ~30×/s); red overlay a person-shaped blob offset from the actual subject.
- **cause:** (1) `useAiMasking` (with the per-seek matte-swap effect) is mounted in 3 components → 3× work per seek, and it fired on every intermediate drag frame — each a `setAdjustments` + full re-render. (2) frame vs matte desync: `frameNonce` bumps faster than `setAdjustments` settles → frame-N matte on frame-M image. (3) `ChromaTimeline` root `onPointerDownCapture={e=>e.stopPropagation()}` ate the strip's own `onPointerDown` — clicks did nothing.
- **fix:** **D-019** — matte read from disk at render time (`generate_ai_subject_bitmap` → `tracked_full_mask`), no per-seek `setAdjustments`; a seek just bumps `frameNonce`. Root capture-phase `stopPropagation` moved onto the strip handler.

## B-011 — `cargo test chroma::` cross-test pollution: an export test's leftover "loaded video" fails a later, unrelated relight test
status: open · severity: low · area: `app/src-tauri/src/chroma/{export,relight,state}.rs` test suite (test isolation only — no runtime/product impact)
- **found:** 2026-09-03, while verifying D-050 (editor audio playback) with `CHROMA_TEST_VIDEO` set to run this repo's env-var-gated integration tests. Reproduces with no D-050 code involved at all — isolated to `cargo test -p RapidRAW --lib -- --test-threads=1 chroma::export:: chroma::relight::` alone, confirmed unrelated to the audio work.
- **repro:** `CHROMA_TEST_VIDEO=<a real clip> cargo test -p RapidRAW --lib -- --test-threads=1 chroma::export:: chroma::relight::` (both modules must run in the same test binary process — the default `cargo test` invocation without `--test-threads=1` does not reliably reproduce it, since thread scheduling can luck into a different interleaving).
- **expected:** `chroma::relight::tests::keyframed_light_without_a_loaded_video_falls_back_to_raw_fields` asserts a keyframed light's raw (un-interpolated) `x` field is returned unchanged (`10.0`) when — per its own doc comment — "these pure-parsing tests run with no video loaded, so `interpolated_parameters` returns `None`."
- **actual:** fails with `left: 77.666664, right: 10.0` — the light's `x` came back *interpolated* against a real timestamp, meaning the test's "no video loaded" precondition was false.
- **cause:** `chroma::export`'s real-file-gated tests (`export_neutral_30_frames` etc., which only actually run when `CHROMA_TEST_VIDEO` is set — normally skipped) call `state::set_current_video(Some(CurrentVideo {..}))` and never reset it back to `None` afterward. `state::SESSION` is one process-global `Lazy<Mutex<Session>>` shared by the whole test binary (all `#[test]`s in `cargo test`'s single process), so whichever test runs next inherits that "a video is loaded" state — here, relight's `interpolated_parameters` hook (D-034) sees a loaded video + its current frame and genuinely interpolates against it, instead of hitting the `None` early-return its test assumes.
- **not a regression from D-050:** confirmed by reproducing with only `chroma::export::`/`chroma::relight::` selected, zero `chroma::audio::` tests in the run. D-050's own new tests (`chroma::audio::tests::*`) touch only `state::PROJECT` (via `state::set_project`, always paired with a `set_project(None)` cleanup) — never `state::SESSION`/`set_current_video` — so they neither cause nor are affected by this.
- **impact:** test-suite reliability only, order/CHROMA_TEST_VIDEO-dependent — not a product defect (`state::SESSION` behaving as "whatever was last loaded, loaded" is correct *runtime* behaviour for a single-session desktop app; the bug is the test's implicit unstated precondition plus the exporter test's missing teardown). Default `cargo test chroma::` (no `CHROMA_TEST_VIDEO`) does not hit this, since the export tests it would race against just skip.
- **fix (not done this pass — out of scope for D-050):** either have the export tests restore `state::set_current_video(None)` (and/or the prior value) in a guard/teardown, or have the relight test explicitly call `state::set_current_video(None)` itself before asserting instead of relying on ambient test-run state. Whoever picks up general test-isolation hardening for `app/src-tauri`'s growing set of shared-global-state tests should fix this alongside it — the same `SESSION`/`PROJECT`/`PIPE`/`THUMB_CACHE` pattern recurs across `state.rs`, `decode_pipe.rs`, `edit.rs`, `session.rs`, `project.rs`.

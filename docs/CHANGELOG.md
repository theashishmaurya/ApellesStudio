# CHANGELOG

One or two lines per session. Detail lives in the decision it references.

## [Unreleased]

- **2026-09-04** — **Cross-track sync-lock reverted from auto-split to
  reject-on-straddle after confirmed real data corruption (B-033/D-109).**
  D-106/D-107's auto-split let repeated real ripple operations keep
  re-splitting an already-split fragment — confirmed on the owner's actual
  `New.chroma` project (a clip id duplicated 3x on one track, another split
  into 4 slivers, total duration growing after closing a gap). Reverted to
  D-104's own proven-safe reject-on-straddle contract, generalized
  cross-track, checked upfront at all three ripple call sites before any
  mutation. New regression tests apply the rejected op 5x in a row and
  prove zero fragmentation. Real feature loss, deliberate: sync-lock now
  blocks a ripple when a straddling clip sits on a synced track — auto-split
  may return as its own separately-scoped, separately-verified follow-up.
  The owner's real project file is confirmed corrupted on disk with no
  clean automated recovery; manual rebuild through the UI is the
  recommended path — underlying media is untouched, only clip-position
  bookkeeping was corrupted.
- **2026-09-04** — **A third, distinct root cause behind "No project open"
  found and fixed (B-032/D-108).** Tauri listener cleanup (`unlisten.then((f)
  => f())`) could throw when Vite's dev-mode HMR reloaded mid-flight,
  corrupting the IPC bridge — Tauri's own console warning names the exact
  scenario. Dev-mode-only (no HMR in production), but frequent enough this
  session (many concurrent forks editing files against one shared dev
  instance) to repeatedly masquerade as the project-open bug already fixed
  twice under different real causes (B-004, B-031). Fixed with a shared
  `safeUnlisten()` helper across all 6 real call sites. Idle-window
  verified (150s+, zero recurrence); honestly flagged as not
  force-reproduced on demand.
- **2026-09-04** — **Multi-select Phase 1 + cross-track ripple/sync-lock,
  built (D-107).** `Selection` is a real array now (shift/cmd-click,
  generalized Remove/Split); `Track.sync_locked` (default on) makes a
  ripple on one track shift every other synced track too, auto-splitting a
  straddling clip rather than blocking the ripple (the owner's call,
  reversing D-106's own first-pass "reject" recommendation) with a real
  ripple-flash so it's never silent. 73/73 Rust + 115/115 TS tests;
  real-window interactive verification not achieved this pass, disclosed
  honestly. Roadmap items 11/12 marked done.

- **2026-09-04** — **Real scoping docs for the audit's top 3 gaps (D-106):
  multi-select, cross-track ripple/sync-lock, A/V linking.** No code —
  three real design docs (`docs/notes/multi-select.md`,
  `cross-track-ripple-sync-lock.md`, `av-linking.md`), each grounded in
  live-checked references (Resolve's Sync Lock, Premiere's Linked
  Selection, Palmier's own `manage_clip_links`/`manage_tracks` tools).
  Multi-select's "just extend the click handler" first read didn't survive
  tracing every real consumer — scoped with a phased plan instead of built
  blind, matching the judgment applied to the other two. Roadmap items
  11-13 updated to point at the docs.

- **2026-09-04** — **Gap select + delete (ripple close), and a real
  timeline-feature research audit (D-105).** Empty track space is now a
  real, selectable thing — click a gap to select it (a dashed overlay
  tracks the exact bounds), Delete/Backspace or a new "Close Gap" toolbar
  button closes it, rippling every later clip on that track earlier by the
  gap's width. The deliberate mirror image of `remove`'s existing Lift
  behavior. `Track::gap_at`/`Timeline::remove_gap` (Rust) mirror
  `gapAt`/`remove_gap` (TS) field-for-field. Verified against the real
  rendered component via a scratch Chrome-driven harness, not just unit
  tests (67/67 Rust, 108/108 TS). Also: `docs/notes/timeline-feature-
  audit.md` — the actual timeline code audited feature-by-feature against
  Premiere Pro's and DaVinci Resolve's own docs plus Palmier Pro's real MCP
  tool surface, with a prioritized recommendation (multi-select, then
  cross-track ripple/sync-lock, then real A/V linking).
- **2026-09-04** — **Unified clip-move placement, reversing D-096: overlap
  is never a reachable outcome of a plain drag (D-104, B-030).** Cross-track
  move used to reuse a clip's own `start_frame` verbatim (ignoring where it
  was actually dropped) and D-096 had made cross-track overlap an explicit
  allowance — together, dragging a clip onto another track could land it
  stacked directly on top of whatever was already there. New
  `resolveClipLanding` wraps `computeInsertion` (the same "where does this
  fit" algorithm a new clip from Sources already gets) for an EXISTING clip
  being moved, used by both the drag path and the "Move to ▾" dropdown.
  `move`/`move_clip` gain `ripple`, mirrored TS/Rust: overlap is now
  rejected for every move, same-track or cross-track, unless `ripple`
  shifts the way clear (same contract `add_clip` already has). A real edge
  case (a clip straddling the landing point) is explicitly rejected rather
  than left silently still-overlapping. `packages/editor` 91→100 tests,
  `chroma-timeline` 60→61, `cargo clippy -p chroma-timeline` clean. The
  `chroma_timeline_move_clip` Tauri command's signature update (a
  zero-caller command) could not be `cargo check`-verified — blocked by an
  unrelated, concurrent-session in-progress `tauri-plugin-wdio` permission
  mismatch, not anything touched here.
- **2026-09-04** — **Real sidecar ownership: content-hash staleness
  detection (D-101, roadmap item 9).** `ai/server.py` now reports a
  `content_sha256` of its own bytes in `/health`; `chroma::sidecar` computes
  the same hash and flags a mismatch (`SidecarStatus.stale`) instead of
  trusting any 200 forever — the actual D-069 gap. Policy: refuse-and-warn
  only, never auto-kill an external process. Re-checked live on the
  existing 10s poll, not just at boot. New "AI Sidecar" status card in
  Settings — `chroma_ai_status`'s first real consumer. Live-verified
  against the session's own genuinely ~6hr-stale sidecar (killed, restarted
  with the new code, watched the supervisor correctly report "no longer
  stale" with no false positive). One incident: a manual `cargo clippy` run
  collided with the dev server's own auto-rebuild watcher and corrupted
  `target/debug` — recovered via the documented `rm -rf target/debug` +
  rebuild.
- **2026-09-04** — **Global Inspector Phase 3: NLE clip properties
  (D-102).** `ClipInspectorPanel.tsx` — a persistent transform + keyframes
  panel for the selected Edit-tab clip, replacing D-090's popover outright
  (removed, not kept alongside — same fields/ops, no benefit to two
  controls). Added to `TimelinePane.tsx` only after the concurrent
  drag-and-drop work (D-100) finished. Backward-compat verified against a
  scratch harness and the owner's own real project file. Drafted as
  D-101, renumbered after the sidecar-ownership pass above claimed it
  first.
- **2026-09-04** — **Global Inspector Phase 4: the shared shell, closing out
  the whole effort (D-103).** New tiny package `@chroma/inspector` — just
  `InspectorEmptyState`/`InspectorSection`, the two pieces Motion's and the
  NLE's Inspector panels had genuinely converged on identically. Not a full
  merge: the two panels' selections/fields/ops stayed different enough that
  forcing one component would mean rewriting working code for no benefit;
  resizable-panel wrapping and `Selection` both stayed package-local for the
  same reason (`Shell.tsx` already keeps every tab mounted, so there was no
  real cross-tab gap to close). Verified live, both panels side by side,
  post-refactor — no regression in either. All 4 phases of the Global
  Inspector now done.
- **2026-09-04** — **Unified clip move onto ONE mechanism; fixed the real
  root cause of D-098's stuck-ghost/blocked-drag cluster (D-100, B-029).**
  A stuck `activeDrag` after an interrupted drag left `TrackDropZone`'s
  `pointer-events-auto` on forever, silently blocking every click/drag on
  that whole track row — that's what "can't drag in the same track"
  actually was, not same-track drag itself breaking. Fixed by making that
  overlay `pointer-events-none` unconditionally (never needed for dnd-kit's
  own rect-based collision detection) and unifying same-track + cross-track
  clip move onto ONE `useDraggable` covering the whole clip (`ClipBody`),
  with the library's native move-drag disabled (`movable: false`, edge-trim
  untouched) — no more two systems racing for one gesture. Also: a real
  dnd-kit-internal-state bug (an interrupted drag left the NEXT real drag
  on the same pointer silently inert; fixed with a genuine synthetic
  `pointercancel` dispatch on window blur, not just local state reset);
  `computeInsertion`/`nearestEdge` now resolve a drop anywhere on an
  existing clip's body (not just a pixel-precise seam), fixing
  ripple-insert between already-touching clips; click-outside-to-deselect;
  selected-clip contrast (a ring, not a background/text-colour swap that
  was using the wrong token). 91/91 tests, `tsc`/`vite build` clean.
- **2026-09-04** — **Track reorder + cross-track clip move moved onto
  `@dnd-kit/core`/`@dnd-kit/sortable` (D-098, B-028).** Native HTML5 drag
  failed live a second time (cross-track clip move, after track reorder)
  despite passing this session's Chromium-only checks — owner greenlit
  implementing the dnd-kit scoping doc's phase 1 plan for real. Same-track
  drag/trim/resize untouched (the timeline library's own native
  mechanism, never what was broken). Two real bugs found and fixed during
  implementation (a React-synthetic-event same-element-handler ordering
  issue; a droppable-registration timing issue); re-checked D-064's
  `dragDropEnabled` fix first and ruled it out. Verified against the real
  component under real `<StrictMode>` with real `PointerEvent` sequences
  (not just the Chromium harness alone this time) — dnd-kit issue #2116's
  StrictMode bug does not reproduce on the installed version. Still not a
  real Tauri/WKWebView window — flagged explicitly, not claimed closed.
  `tsc`/vitest/vite build clean (88/88 tests, 64-error app baseline
  unchanged, one new safe React-Compiler bailout accounted for).
- **2026-09-04** — **Global Inspector Phase 2: a real Motion property panel
  (D-099).** Typed form bound to the layer-list selection across all 8
  primitives, JSON fallback for content-shaped props, a real camera
  keyframe-list editor, a resizable right-hand panel cluster. Reads/writes
  the manifest immutably and degrades gracefully on a stale/unrecognized
  selection — verified against real, already-existing manifests (the
  owner's explicit backward-compat requirement) via a scratch Chrome-driven
  harness, not just unit tests. `packages/motion`'s first test harness
  (18/18). Phase 3 (NLE half) found to be newly unblocked (B3 shipped as
  D-088) but deliberately not started — would need `TimelinePane.tsx`,
  in active use by concurrent dnd-kit work all session.
- **2026-09-04** — **Mid-stack track insert, kind inference, a real
  cross-track clip-move handle, cross-track overlap allowed (D-096,
  B-027).** Continuing D-095's own live-testing session: a track can now
  be inserted at ANY boundary (above the first, between two, or past the
  last), not just past-the-last; an auto-created track infers its kind
  from the adjacent track instead of a hardcoded `'video'` literal
  (verified `DraggedMedia` carries no real audio/video signal to derive
  from directly); the cross-track clip-move handle is now a full-width
  top strip instead of a small corner icon; `move`/`move_clip` now allow
  cross-track overlap (a real composited layer since D-088), same-track
  overlap still rejected. **Caught and fixed a live regression in the same
  pass**: the wider handle made an ordinary same-track drag an easy
  accidental grab of the cross-track mechanism, which used to silently
  no-op on a same-track drop — now handles it as a real reposition
  instead. Also: `docs/notes/dnd-kit-migration.md`, a real scoping doc
  (not implemented) for the owner's `@dnd-kit` steer — MIT, active repo,
  but no npm release since 2024-12 and an open React-19-StrictMode issue
  against the in-progress rewrite, which this app's `<StrictMode>` root is
  actually exposed to. Rust `chroma-timeline` 59/59, `packages/editor`
  88/88, `tsc` + `vite build` clean.
- **2026-09-03** — **Four real gaps in D-094's drag-and-drop, found live
  (D-095, B-026).** Sources-panel drops now snap/ripple-insert between
  existing clips (`computeInsertion`, `timeline.ts` — the one place this
  model intentionally gains ripple behavior) with a live insertion-line/
  new-track-ghost preview; dropping a clip past the last track row auto-
  creates one (the manual "+ 🎞"/"+ 🎵" toolbar buttons are gone); both
  drag handles' hit targets grew + got an explicit `-webkit-user-drag`
  hint for Tauri's WKWebView (D-094's track-reorder logic was verified
  correct via a real Chromium drag against a new isolated-component
  harness, but couldn't be closed-loop-verified on WKWebView itself); the
  Sources-panel drag ghost is now a small name pill instead of the full
  media card. 88/88 tests (+9), `tsc` + `vite build` clean.
- **2026-09-03** — **Real drag-and-drop for the NLE timeline + resizable
  header sidebar (D-094).** `TimelinePane.tsx`: track reorder is now a
  `GripVertical` drag handle per header row (replacing D-090's up/down
  buttons; generalized `move_track` selection-follow math, not just
  adjacent swap); cross-track clip move is a real drag handle on each clip
  (`CHROMA_CLIP_MOVE_MIME`, same drop mechanism as the existing
  Sources-panel drop) — the old "Move to ▾" dropdown stays as a fallback
  since the live drag gesture couldn't be exercised against the native
  window this session. The track-header sidebar is now a real
  `@chroma/ui` `ResizablePanel` (was a fixed `width: 156px`) — the first
  live use of that component, applying the owner's new standing
  "resizable-by-nature panels" `CLAUDE.md` rule. 79/79 tests, `tsc` +
  `vite build` clean.

- **2026-09-03** — **Local-only user-action telemetry infrastructure
  (D-093).** New `trackEvent(event, props?)` in `@chroma/bridge`, reusing
  the existing `frontend_log` Tauri command (`[telemetry]` prefix, JSON
  payload, lands in `app.log` — no network call, no new storage). Wired
  into tab switches, project open/new/close, and relight actions (add/
  delete light, apply preset, bake depth/normals, track depth). NLE track/
  clip actions deliberately deferred — a concurrent fork is reworking
  `TimelinePane.tsx`'s drag-and-drop — tracked as a follow-up in
  `docs/notes/telemetry.md`, which also has the adoption checklist for
  wiring up a new surface.

- **2026-09-03** — **Sidecar memory: real observability + TTL auto-unload
  (D-087).** Diagnosed a reported 5.78 GB sidecar process — not a leak (the
  process itself was already gone; `_free_gpu()`, B-002, is correctly
  called everywhere), but a real gap: loaded models (SAM2/YOLO/ViTMatte/
  Video-Depth-Anything/MoGe-2) were never released. New `GET /memory`
  (RSS + per-model loaded/idle status) and a background TTL sweep that
  auto-unloads anything idle past 5 minutes, safe against the existing
  `_GPU` lock; `POST /unload` for a manual reclaim. Verified live end to
  end (load → idle → auto-unload, watched `/memory` and RSS the whole way).

- **2026-09-03** — **Fixed: Edit tab stuck on "No project open" after a
  real, successful open; opening a project had no loading feedback (D-085,
  B-025).** Project cards now show a real spinner while opening and disable
  during it (closes a confusing "session busy" double-click race); the Edit
  tab's own load now retries once if it lands on a stale error state.
- **2026-09-03** — **Fixed: dragging a clip in the Edit-tab timeline froze
  the UI (D-083, B-024).** Five callback props to the timeline library were
  inline arrow functions (new identity every render); a native drag fires
  `dragover` continuously, so every tick forced a full re-render of every
  clip across every track. `useCallback`-wrapped with real dependency
  arrays; a pre-existing pattern that only became a felt freeze once
  multi-track (D-080) made the cost scale with track count.
- **2026-09-03** — **Global Inspector, Phase 1: Motion tab gets a real
  scene/layer sidebar (D-081).** Wrote a real scoping doc first
  (`docs/notes/global-inspector.md` — a 4-phase build + the complete
  verified prop catalog for all 8 primitives), since unlike the multi-track
  UI this had none. Built the genuinely unblocked prerequisite: a
  `LayerList` sidebar + selection model, wired to seek the preview player to
  whatever scene/layer is selected — real navigation on its own, ahead of
  the actual property panel (Phase 2, next).

- **2026-09-03** — **Multi-track timeline UI (D-080, Phase D of the
  multi-track NLE effort).** The Edit tab now shows a real lane per track —
  custom header sidebar (kind icon, per-kind label, mute toggle, remove),
  add-video/add-audio-track buttons, and a "Move to ▾" dropdown to move a
  clip between tracks (the timeline library has no native drag-between-rows,
  confirmed before assuming otherwise). Confirmed N-track compositing
  actually works past 2 tracks first (was claimed, never tested) before
  building UI on top of it. Opaque compositing only for now — real blend
  modes/opacity (Phase B3) is still unbuilt, a separate later step.

- **2026-09-03** — **Relight shading overhaul (D-078/D-079): real light, not
  a coloured gel.** Falloff was 2D-screen-only and colour was flat additive
  — read as a translucent wash, live-confirmed fixed by switching to a
  screen blend (respects existing highlights/shadows) plus real 3D falloff.
  Then found `distance` was sweeping the lit side of the face instead of
  moving the light nearer/farther (a real face's own depth variation was
  feeding the light's *direction*, not just its brightness) — direction now
  uses a heavily damped copy of the depth delta. That same investigation
  caught a second real bug: a `distance` far from a surface's depth could
  silently zero the light out completely (folded into the same radius-gated
  falloff) — depth-based dimming is now a separate, non-zeroing multiplier.
- **2026-09-03** — **Relight uses one coherent AI geometry pass now, not
  two mismatched ones (D-077 addendum).** "Bake Normals" now also writes
  MoGe-2's own real depth (computed in the same inference call as the
  normal), instead of pairing the normal against a separate
  Depth-Anything-V2 bake — the two are guaranteed geometrically consistent.

- **2026-09-03** — **Relight: real AI surface normals instead of a depth
  finite-difference (D-077).** "Feels like a light blob, that's not light
  that's just color" was accurate — the old normal was a crude heightfield
  trick on the depth map, not real geometry. New "Bake Normals" action runs
  MoGe-2 (MIT-licensed, vendored, verified on MPS) for a real per-pixel
  surface normal; DSINE was evaluated first and rejected (academic-only
  licence). Depth-derived fallback unchanged when no bake exists.
- **2026-09-03** — **Relight `distance` correction (D-076 follow-up):** the
  first fix still failed live because a light's z was partly anchored to
  whatever the depth map showed *behind the puck's own position* — broken
  the moment the puck sat over open background instead of on the subject.
  `distance` is now a true absolute z-coordinate, independent of puck
  placement; default bumped 40 → 85.
- **2026-09-03** — **Relight positional lights actually shade footage now
  (D-076, B-022).** Root cause of "nothing is getting applied at all": there
  was no real z/depth control for a light, only screen-space x/y/radius — a
  light always sat flush on whatever surface it was dropped on, which
  collapses the shading math to ~zero on real (relatively flat) footage.
  Added a real `distance` field end-to-end (UI slider → Rust → GPU uniform →
  shader), defaulting nonzero so a fresh light is lit immediately. New
  GPU-render regression test proves it (renders through the real shader
  against a flat depth map, asserts distance=0 is byte-identical to no
  light at all).
- **2026-09-03** — **Relight panel: Bake Depth fires itself, Track Depth
  moved to a compact bottom "finalize" action (D-073).** No more picking
  between two equal-weight depth buttons — the cheap single-frame bake now
  fires automatically the moment a positional light needs it; the heavy
  whole-clip track (confirmed capable of crashing the AI sidecar) is a
  deliberate, tooltip-explained action at the bottom of the panel.
- **2026-09-03** — **Fixed: dragging a relight light puck also scrubbed the
  video frame (D-074, B-021).** A capture-phase pan handler on an ancestor
  fired before the puck's own drag handler could stop it; the puck now
  marks itself so the ancestor skips it entirely.
- **2026-09-03** — **Edit-tab timeline: plain trackpad scroll now pans,
  only a real pinch/Ctrl+scroll zooms (D-072).** D-051's scroll-wheel zoom
  treated every wheel tick as zoom, so a plain two-finger scroll (a
  different physical gesture from a pinch) couldn't scroll the timeline at
  all. Now gated on `ctrlKey` — the standard convention browsers already
  use to mark a real pinch gesture — everything else falls through to the
  library's own native scrollable container untouched.

- **2026-09-03** — **Colorist wasn't actually live-synced to the Edit tab —
  a real gap D-070 left behind (D-071, B-020).** Owner's immediate retest:
  a clip dragged onto the Edit tab's timeline never showed up in Colorist,
  and a deleted clip lingered there forever as a ghost shot.
  `chroma_timeline_set` never called `open_manifest`, and `syncFromRust`
  (dead code, never called) was the only thing that looked like it should
  have handled this. New `chroma_project_resync_clips`, triggered on
  Colorist tab focus: diffs the active timeline against the decode session,
  decodes new clips, prunes stale ones, but deliberately only re-picks the
  active clip if it was one of the pruned ones — a manual selection in the
  shot strip survives a resync that doesn't affect it, unlike just calling
  `chroma_project_open` again. `cargo test chroma::` 138/138 (+3), `tsc -p
  app` 64/64 unchanged.

- **2026-09-03** — **The real Track Depth root cause: a 2-day-stale AI
  sidecar (D-069, B-018).** D-067's new logging paid off immediately —
  `app.log` showed every click hitting a 404 (`{"detail":"Not Found"}`)
  from the process on `:8765`, which turned out to have been running
  since **Sept 1, 21:19** (`ps -p $(lsof -ti:8765)`), well before
  `/depth_track` existed in `ai/server.py`. `spawn_and_supervise` (D-028)
  only checks for something-already-answering once, at boot, and defers
  forever once found — so every restart tonight deferred to the same
  stale process, invisible to every actual app rebuild. Killed + restarted
  it (`ai/run.sh`), confirmed live via `curl`. Also hardened
  `chroma_depth_track`/`_status` to check HTTP status before parsing a
  response as success (they didn't — this is *why* the 404 silently
  looked like "nothing happened" instead of a real error).

- **2026-09-03** — **Relight diagnosability + visual consistency (D-067/
  D-068).** `chroma_depth_track`/`_status` had zero logging — "clicked
  Track Depth multiple times, nothing happened" couldn't be told apart
  from four very different real causes purely from `app.log`; every real
  exit path now logs. Separately, `RelightPanel.tsx` — flagged by the
  owner as visibly inconsistent with the rest of the app — is rebuilt on
  `@chroma/ui`'s real `Button`/`Slider` instead of the RapidRAW-era plain
  elements its own module doc had admitted using since D-048. Presentation
  only, no interaction-logic changes.

- **2026-09-03** — **Relight keyframe "Clear"/"X" never actually removed
  keyframes (D-066, B-017).** `writeLightParams` spread-merged its result
  onto the stale light (`{ ...l, ...next }`) — a spread can overwrite a
  key, never un-set one, and `clearKeyframes`/`removeKeyframe` signal
  "done" by deleting `chromaKeyframes` from their return value, which the
  merge silently discarded. Now replaces the light outright. Cross-checked
  the shared mechanism (`maskKeyframes.ts`, D-034) against its other real
  caller (`MaskKeyframeBar.tsx`) — not buggy there, this was specific to
  how `RelightPanel.tsx` composed it. Also confirmed a separate same-
  session report ("no light shows when I change color") is by design, not
  a bug — a positional light genuinely no-ops until Track/Bake Depth runs.

- **2026-09-03** — **Colorist fullscreen had no way back out (D-065,
  B-016).** The only exit button lived inside the toolbar, which itself
  hides (`max-h-0 opacity-0`) exactly when fullscreen turns on — the
  control that exits fullscreen was hidden by fullscreen. Added a
  dedicated close button, always rendered, independent of the toolbar and
  of two undeduplicated `handleToggleFullScreen` closures (`App.tsx`/
  `Editor.tsx`, real duplication flagged but not fully consolidated this
  pass — see D-065).

- **2026-09-03** — **Unified clip identity, Edit ↔ Colorist: `ProjectShot`
  retired, `chroma_timeline::Clip` is the single source of truth (D-070).**
  Colorist's shot strip now reads the active Edit-tab timeline's clips
  directly (`Clip.media_id`, new) instead of a separate persisted
  `ProjectShot` list, so a clip dragged onto the Edit tab shows up in
  Colorist immediately — no more "add to grading" as a second step.
  One-time grade-file migration renames `<gradeDir>/<shotId>.grade.json` →
  `<gradeDir>/<clipId>.grade.json`, warning (never dropping) any grade that
  can't be matched to exactly one clip. Colorist's active-clip resolution
  now shares D-056's `resolve_video_clip_at`, not a second copy. Verified
  against a scratch copy of the owner's real project: 3 shots, 0 renamed
  (already-migrated no-op), 2 warned (never dragged onto the Edit tab),
  nothing lost. `cargo test -p chroma-timeline` 37/37, `chroma::` 135/135
  (+10, 1 ignored real-project harness by design). `tsc -p app` 64 errors,
  unchanged baseline.

- **2026-09-03** — **Sources panel delete (single + batch), edge-trim
  cursor, timeline-switcher width fix (D-060/D-061).** New
  `chroma_media_remove(ids: Vec<String>)` — right-click "Remove from
  pool," a hover trash icon per card, and a header "Select" → "Select
  all" / "Delete (N)" bulk path, all wired to the same batch command
  (removes the pool ref + cached thumbnail, never the source file). The
  timeline's resize handles get a real `ew-resize` cursor + hover
  highlight (the library never styled this at all — `timeline-
  overrides.css`, new); the D-058 tab strip stops stretching to fill the
  row (`grow-0`, the shadcn base `flex-1` was never actually cancelled)
  and is capped to half-width. `cargo test chroma::` 126/126 (+1).
- **2026-09-03** — **The real B-012/B-013 fix: Tauri's own
  `dragDropEnabled` was eating drag-and-drop in the actual app (D-064).**
  D-058 fixed the frontend model and verified strongly — in a plain
  Chrome tab, since that's this sandbox's only way to drive real DOM
  events. The owner's live retest in the real Tauri window showed drag
  still completely dead: Tauri v2's window-level native drag capture
  (on by default, never set in `tauri.conf.json`) intercepts HTML5 drag
  events before the page ever sees them — a class of bug no proxy method
  could catch. `dragDropEnabled: false`. Confirmed by the owner dragging
  a real clip in the real window.
- **2026-09-03** — **Motion render now lands in Sources; Edit-tab preview
  gets a real loading state (D-062).** Rendering used to just write a
  file and print its path as plain text — nothing put it anywhere
  usable. `onRendered` (app-composition-root-owned, since `@chroma/
  motion` can't reach `@chroma/bridge`) now imports the result into the
  Sources pool. `PreviewPane`'s "no frame" placeholder — shown
  identically whether a frame was loading or genuinely absent — is now a
  real spinner during a first-load, and the plain text only for a
  genuinely empty timeline.
- **2026-09-03** — **Colorist shot-switch preview had a fully-built
  loading spinner wired to a dead flag (D-063, B-015).** `showSpinner`
  existed, styled and correct, keyed to `useLibraryStore.isViewLoading`
  — a RapidRAW still-image-library flag with exactly one call site,
  unreachable since the D-043 video pivot. The real switch paths
  (`switchToShot`, `_hydrateOpenDto`) never touched it, and
  `_hydrateOpenDto` itself never toggled `busy` either (4 callers each
  separately remembered to wrap it; Sources' "add to grading" didn't).
  `isLoading` now also reads `useSessionStore.busy`; the toggle moved
  inside `_hydrateOpenDto` so every caller gets it for free.

- **2026-09-03** — **Multi-track NLE Phase B1: opaque top-wins video-track
  resolution (D-056).** Real finding: opaque "top wins" compositing needed
  **no new rendering/GPU code** — with no alpha in play, the top-priority
  track's clip fully obscures whatever's below, so this was a track-
  **selection** problem, not a pixel-compositing one (confirms the phase
  brief's hypothesis rather than assuming it). Landed as
  `chroma_timeline::Timeline::resolve_video_clip_at` — pure model logic,
  video tracks walked in `Vec` index order (lower index = higher priority,
  "on top" — matches Palmier Pro's own track convention and every existing
  project's single-track behavior), first track with a clip (not a gap) at
  the position wins, falls through to the next only on a gap. `edit.rs`'s
  `resolve_video_position` (shared by `chroma_timeline_frame` and the audio
  path) is now a thin wrapper around it that probes the winning clip.
  `cargo test -p chroma-timeline` 30/30 (+7 new tests: both-tracks-have-
  content, only-top, only-bottom, neither, top-gap-falls-through, no-video-
  tracks, single-track-behavior-unchanged-regression); `cargo test
  --manifest-path app/src-tauri/Cargo.toml chroma::` 113/113 (+1 real-clip
  integration test exercising the Tauri command path end to end); `tsc
  --noEmit` 64/64, unaffected (no frontend file touched). GUI boot not
  performed this session — port 1420 was already held by the main
  checkout's own dev server — so the regression proof instead rests on the
  real-media integration test hitting the exact `chroma_timeline_frame`
  command plus a test proving the new resolution path is identical to the
  old one for every single-track position (see D-056). Phase B2 (N tracks)
  is now mostly "confirm it generalizes," since the same walk already has no
  hardcoded track count. Phase B3 (real blend modes/opacity, the genuinely
  new GPU work) is next for the compositor. See D-056,
  `docs/notes/multi-track-nle.md`.

- **2026-09-03** — **Multi-track NLE Phase C: real audio mixing (D-057).**
  `chroma::audio`'s `cpal` pipeline now sums N sources instead of playing
  exactly one — the baseline video-embedded audio (unchanged, unity gain)
  plus every genuine `TrackKind::Audio` clip overlapping the play position.
  New `chroma_timeline::Track::gain: f32` (default `1.0`) is per-track
  volume; a new `mix_sources`/`soft_limit` mixer sums active (nonzero-gain)
  sources through a `tanh` soft limiter (chosen over a hard clamp's real
  clipping or a `1/N` pre-scale's needless quietening), bypassing
  summation/limiting entirely with ≤1 active source — which keeps the
  pre-existing single-track case byte-identical and makes "mute via
  `gain: 0.0`" an exact property. Pan scoped out. `chroma-timeline` 25/25,
  `chroma::audio` 29/29 (new deterministic + live-`cpal` 2-track tests),
  `chroma:: ` wide 122/122, `tsc` 64/64 unchanged, real `cargo build`
  boot confirmed (live Tauri UI boot blocked by an unrelated port-1420
  process already running from the main checkout, not this task's to
  kill — see D-057).

- **2026-09-03** — **Timeline UI fixes from real hands-on testing (D-058,
  B-012/B-013).** Drag-from-Sources and edge-trim were both silently broken:
  `packages/editor/src/timeline.ts`'s frontend edit-op mirror (authoritative
  for real saves, since `chroma_timeline_set` stores verbatim) never picked
  up D-054's `Clip.start_frame` — a dropped clip had no real position, and a
  left-edge trim visibly moved the wrong edge. Ported D-054's model into
  `timeline.ts` field-for-field against the Rust ops (`trim_start`/
  `trim_end`'s neighbor clamps, `split`'s right-half position, `add_clip`'s
  append position, a new overlap-rejected `move` op replacing the now-inert
  `reorder`-as-position-change); `TimelinePane.tsx` renders from each clip's
  real `start_frame` instead of re-deriving it from summed durations. **A
  second, independent trim bug found via real live pointer testing** (not
  code reading): the clip-name label's `z-10` had no isolating stacking
  context, so it silently covered the resize handles' hitboxes across the
  library's own DOM, swallowing every edge-trim `pointerdown` before
  `interact.js` ever saw it — `pointer-events-none` on the label, one line,
  fixes it. `TimelineSwitcher` rebuilt as a `@chroma/ui` `Tabs` strip (tabs +
  a `+` tab) replacing the dropdown-plus-button. Timeline ruler: real
  `HH:MM:SS`/`HH:MM:SS:FF` timecode + an adaptive "nice numbers" tick
  interval (`ruler.ts`, new) instead of a hardcoded 1-tick-per-second scale.
  Real op + formatting unit tests (33, `timeline.test.ts`/`ruler.test.ts`);
  drag-and-drop and trim both additionally confirmed against the real
  running app — a real Chrome tab on the plain Vite dev server (Tauri
  mocked), real native drag events and real synthetic pointer events at the
  actual DOM coordinates, real resulting store/JSON state checked — see
  D-058 for the full method and honest caveats.

- **2026-09-03** — **Sources panel fixes: async media commands, real
  thumbnails, real "New Folder" (D-059, B-014).** Owner-reported, hands-on
  bugs D-046's own accessibility-driven verification missed.
  `chroma_media_list`/`_import`/`_move` converted to `async fn` — they were
  plain `fn`, which Tauri runs inline on the main UI thread, stalling the
  native Import file-picker behind them (`chroma_media_import` also moves
  its `ffprobe`/`ffmpeg` work into `spawn_blocking`). Every imported item now
  gets a real cached poster-frame thumbnail (`video::extract_thumb`, reused
  — not a new decode path — to `<video_dir>/.chroma/thumbs/<id>.jpg`).
  `ProjectManifest.folders: Vec<String>` + `chroma_media_create_folder` let a
  new, empty bin persist and list before anything is filed into it, via a
  "New Folder" button + right-click context menus (`@chroma/ui`'s shadcn
  `ContextMenu`, its first real consumer). `cargo test chroma::` 114/114
  (was 112 in this fresh worktree; +2 new tests), `tsc --noEmit` unchanged
  (app 64, bridge 0, editor 1 pre-existing/unrelated, ui 0). See D-059 for
  full verification detail, including an honest note on what the live
  click-to-dialog timing test could and couldn't show.

- **2026-09-03** — **Multi-track NLE Phase A: `Clip.start_frame` + gap-aware
  edit ops + track management (D-054).** `chroma-timeline::Clip` gained an
  explicit, timeline-absolute `start_frame: i64` (not a `Gap` item — see
  D-054's rationale) so clips stop being forced back-to-back.
  `reorder`/`trim_start`/`trim_end`/`split`/`remove` reworked for gaps + a
  no-overlap invariant (`remove`/`reorder`'s behavior changed — flagged in
  D-054). New `Timeline::add_track`/`remove_track`/`move_clip` ops +
  matching `chroma_timeline_add_track`/`_remove_track`/`_move_clip` Tauri
  commands in `edit.rs`. Legacy `project.json` migration
  (`backfill_legacy_positions`) verified against the real
  `~/Movies/Chroma/New.chroma/project.json`. `chroma-timeline` 23/23,
  `cargo test chroma::` 110/110 (was 107; caught and fixed one real
  compile-time bug along the way — a `chroma::audio` test helper built a
  `Clip` literal directly and needed the new field), `tsc --noEmit` 64/64
  unchanged, real boot confirmed the existing single-track Edit tab is
  unaffected. No frontend touched, no compositor/audio work (Phases B/C/D,
  still to come — see `docs/notes/multi-track-nle.md`).

- **2026-09-03** — **Interactive relight follow-ups (D-055)**, all four of
  D-048's deferred small items: a static single-frame depth-bake fallback
  ("Bake Depth", reusing the existing single-frame Depth-Anything-V2 command
  `generate_full_image_depth_map` — parity with D-024's AI-Depth mask, no
  second model); `relight_depth_layer` wired into `export.rs`'s `grade_frame`
  so a positional light survives a real export, not just live preview (+ a
  real GPU pixel-diff test, lit vs. unlit); a "Preset" tab on `RelightPanel`
  (3 starter looks: warm key + cool rim, soft ambient fill, dramatic
  single-source); MCP tool wrapping for the 4 control-server relight ops
  (`mcp/server.py`). Also fixed a pre-existing "D-046" mislabel for
  interactive relight in `docs/04-roadmap.md` and `docs/09-engine-notes.md`
  — the real decision is D-048; D-046 is "Media pool pass 3".
- **2026-09-03** — **`chroma-types` step 2: `Resolution`/`Rational` made real
  (D-053).** Audited `app/src-tauri/src/chroma/*` for real duplicates of the
  D-039-step-1 placeholders. Real find: `width`/`height` field pairs on
  `video::VideoInfo` and its DTOs (`VideoInfoDto`, `ShotDto`,
  `MediaVideoInfo`) — migrated to `chroma_types::Resolution` via
  `#[serde(flatten)]`, a verified zero-JSON-wire-change move (round-trip
  test in `chroma-types`). `Rational` gained a `Display` impl, now used by
  `export.rs`'s ffmpeg fps-arg string in place of a bare `format!`.
  **Deliberately not migrated:** `ChromaError` (no real call site in
  `app/src-tauri` — its Tauri commands correctly use `Result<T, String>`/
  `anyhow`, a different layer's convention); `ProjectSettings`/`ExportOpts`'s
  width/height (independently-optional patch/override fields, not the same
  concept as an atomic `Resolution` — this directly re-examines the task
  brief's own cited example and found it didn't hold up); `ColorSpace`/
  `TimeRange` (no real duplicate exists yet). `cargo build`: clean across
  the workspace. `cargo test -p chroma-types`: 4/4. `cargo test
  --manifest-path app/src-tauri/Cargo.toml chroma::`: 107/107, unchanged
  from the D-051 baseline. `tsc --noEmit` in `app/`: zero TS files touched
  (Rust-only change) → zero new errors; the pre-existing count read 32 in
  this fresh worktree vs. D-051's recorded 64 on `main` (dependency-version
  drift from a clean `npm install` here, not this change — see D-053).
  Booted the real app to confirm no runtime shape drift.

- **2026-09-03** — **Mature Editor timeline UI (D-051): closes the roadmap item.**
  Scoped against `@xzdarcy/react-timeline-editor`'s real API first — edge-drag trim
  and snap-to-clip-edge/playhead turned out to already be fully native (`flexible`/
  `dragLine`, both already set since D-041), zero new code for either. Built: native
  (non-passive) scroll-wheel zoom + toolbar zoom buttons on `TimelinePane.tsx`; a
  Rust-computed waveform (`chroma_audio_waveform`, `chroma::audio`, one-shot
  `symphonia` decode → mono → min/max bucket peaks) drawn as a plain `<canvas>` in
  new `Waveform.tsx`, no new dependency; ripple visual feedback (a clip-id→
  start-frame diff drives a brief `animate-pulse`); a truthful "Video 1" label
  instead of speculative multi-track colour-coding (deferred to a future
  multi-track-authoring feature). `cargo test chroma::` 107/107 (+12), plus 2 more
  real-file-gated waveform tests (real non-flat peaks from the D-050 audio fixture,
  empty `Ok` for the known-silent one). `tsc --noEmit` 64, unchanged baseline, zero
  in touched files. Booted the real app; honest gap noted in D-051 — no Screen
  Recording/Accessibility permission in this sandbox, same as D-050, so the pixel-
  level zoom/waveform/trim/ripple interactions weren't visually confirmed, only
  their backing command surface and the library's own native-support mechanism
  (read directly from its bundled source).

- **2026-09-03** — **Global undo/redo (D-052): shell-level Cmd/Ctrl+Z spanning all 3
  tabs.** New `@chroma/history` package (a generic `{tab, label, undo(), redo(), ts}`
  stack — a new leaf package, not folded into `@chroma/bridge`, see D-052). Colorist's
  existing `useEditorStore` grade history is bridged in unchanged
  (`useColoristHistoryBridge.ts`, reuses the D-032 `restoreEditorHistorySnapshot`
  helper — extracted from `AgentActivityDock.tsx` so both share one implementation).
  The Edit tab's timeline ops get real undo for the first time — `useEditorTimelineStore
  .applyOp` pushes before/after `Timeline` snapshots. `Shell.tsx` owns the only
  Cmd/Ctrl+Z / Cmd/Ctrl+Y (+ Cmd/Ctrl+Shift+Z) listener, pops the shared stack
  regardless of active tab, and **switches to the popped entry's tab** so the effect
  is always visible (the real UX call, reasoning in D-052). Colorist's own local
  Cmd/Ctrl+Z handler removed to avoid double-undo. Deferred: Motion tab (no natural
  edit-history unit), and the Colorist toolbar's Undo/Redo buttons still bypass the
  shared stack (documented, harmless). 16/16 new unit tests (`@chroma/history` +
  `labelForOp`) passing, `tsc --noEmit` 64/64 baseline unchanged, `cargo test
  chroma::` unaffected (no Rust touched).

- **2026-09-03** — **Export dialog, Colorist tab (D-049): a top-right button replaces
  the "buried `ExportPanel` toggle" roadmap item.** New `ExportDialog.tsx`
  (`@chroma/ui` `Dialog`/`Select`, D-042) in `EditorToolbar`'s top-right button group —
  codec, resolution (Project spec / Clip / Custom), frame range (full/custom), a
  `.cube` bake toggle, a native save-dialog output path, and a real progress bar
  polled from `chroma_export_progress`. Backed by the existing `chroma_export_video`/
  `chroma_bake_lut` (D-022) — the only backend change is two new optional params,
  `out_width`/`out_height`, plus a 4-test pure `resolve_export_resolution` helper
  encoding "explicit > D-038 project spec > clip-derived." `Panel.Export`/
  `ExportPanel` (RapidRAW's still-image exporter) stays routed — it's a different
  feature, not a duplicate (see D-049); the pre-existing bug where it's reachable but
  broken against a loaded video is now tracked as **B-010**. `cargo test chroma::`
  87/87 (+4). `tsc --noEmit`: 64 errors, unchanged baseline, zero in touched/new
  files. Booted the real app, opened `~/Movies/Chroma/New.chroma` (a real 4K/50fps
  clip) over the control-server bridge (no screen-recording access in this sandbox),
  and drove the exact same `chroma_export_video`/`chroma_export_progress`/
  `chroma_bake_lut` calls the dialog makes: a 16-frame H.264 export ran to completion
  with real incrementing progress (`done` climbing 1→16, `running` flipping to
  `false`), producing a genuine 3840×2160/50fps/16-frame MP4 (verified via `ffprobe`,
  not just "no error"); a `.cube` bake produced a valid 17³ LUT file with the correct
  "masks dropped" warning for the project's one mask. Not directly observed: the
  dialog's own on-screen rendering/click-through (no screen capture available) —
  covered instead by `tsc` type-checking the wiring and this identical backend path
  proven live.

- **2026-09-03** — **Editor timeline audio playback (D-050), closes the roadmap
  item.** The Edit tab's preview was completely silent (no pipeline at all); now
  Play produces real device audio via a new `chroma::audio` module: `symphonia`
  decode → `rubato` resample → `dasp_sample` bit-depth convert → `cpal` device
  output, reusing the video track's already-embedded audio stream (no separate
  audio `Track` populated this pass — see the D-050 "why not" note). Sync model:
  a persistent audio thread free-running against the device's own clock, started
  from the same playhead frame at the same moment the video `rAF` loop
  re-baselines — not tightly coupled per-frame; the real design tradeoff is
  written up in D-050. `video::VideoInfo` gained `has_audio`/`audio_sample_rate`/
  `audio_channels` (one extra small `ffprobe -select_streams a:0` call, cached).
  `PreviewPane.tsx` fires `chroma_audio_play`/`chroma_audio_stop` at the same
  `playing` transitions that drive the existing video loop. `cargo test
  -p RapidRAW chroma::`: 95/95 passed (was 83; +12: 9 pure-logic + 2 real-file
  end-to-end + 1 extended). `tsc --noEmit` baseline in this worktree: 64
  pre-existing errors, unchanged. Verified end-to-end with real files (not just
  a clean compile): `A001_08302215_C019.MOV` (HEVC+AAC 48kHz/2ch) played through
  the actual `chroma_audio_play`/`_level`/`_stop` commands produced genuinely
  non-silent PCM (`rms=0.0013 peak=0.0080`, logged + read back via
  `chroma_audio_level`) from a real, live `cpal` output stream; this repo's own
  real `New.chroma` project's one shot (`pexels_28808272.mp4`) was confirmed via
  `ffprobe` to have **no audio stream at all**, so its silence is correct, not a
  gap. Booted the real app for real — clean build + launch, no errors.
  **Honest gap:** did not click Play in the actual GUI on an audio-bearing
  project — both `screencapture` and `osascript`/System Events were tried and
  neither had the permission this sandbox needed to observe or drive the
  window — the command-level integration tests above are the substitute
  proof; whoever next drives the UI can cross-check against the `chroma
  audio: rms=… peak=…` log line. Found + logged (not fixed,
  out of scope) a pre-existing, unrelated test-isolation bug while verifying:
  `docs/BUGS.md` B-011.

- **2026-09-02** — **Media pool, pass 3 (D-046): `shots`/`media` unified, closes the
  roadmap item.** `ProjectShot` now references a `MediaItem` by id (`resolve_shot`,
  graceful fallback for a dangling reference) instead of duplicating `sourcePath`/
  `name`; wire DTOs unchanged, so the frontend session store needed no rewrite.
  `find_or_create_media` is the one choke point every shot-constructing path goes
  through; `chroma_project_add_shot` is the new explicit "add to grading" command. A
  docked Sources/Library panel (`app/src/components/chroma/SourcesPanel.tsx`, injected
  into `@chroma/shell` by prop) with import, client-side search, and a bin tree
  (drag-to-move via `chroma_media_move`); `TimelineSwitcher` in `@chroma/editor` for
  D-045's `chroma_timeline_list`/`_create`/`_set_active`; drag-to-track via plain HTML5
  `dataTransfer` (`CHROMA_MEDIA_DRAG_MIME`), scoped to the Edit tab by construction
  (inactive tabs are `display:none`, never a drop target). `cargo test chroma::`
  73/73 (+8). Booted the real app and drove it end-to-end via accessibility scripting
  (no screen-recording access): created a project, imported a clip, added it to
  grading, created + switched timelines, confirmed an empty timeline's drop zone no
  longer crashes (`buildRow` needed its own guard — found live, fixed) and the
  timeline-switcher's `SelectValue` needed a render-children fix to show names instead
  of raw ids (found live, fixed).

- **2026-09-02** — **Interactive relight (D-048): draggable depth-driven light
  pucks, real-time, deterministic.** A new "Relight" grade layer (`RelightLight[]`
  — key/fill/rim/ambient, keyframeable via D-034's mechanism reused verbatim) with
  a ClipDrop-style puck UI (`RelightPuckLayer`, the clone/heal-marker HTML-overlay
  pattern, not the Konva mask-shape tree) and a right-panel (`RelightPanel`:
  Ambient/Light-N tabs, Color/Power/Distance, "Track Depth"). Shading is a new
  `apply_relight` WGSL pass — per-pixel normal from a depth-texture finite
  difference, `max(0,dot(N,L))·falloff(radius)·colour·intensity` — riding the
  *same* mask-texture-array `mask_bitmaps`/`textureLoad` plumbing D-024's
  depth-haze mask already established (one more array layer, no new bind group).
  Covers both live-preview paths for free (`apply_adjustments` + D-031 playback
  share one `process_preview_job`); export/thumbnail/LUT-bake paths untouched
  (ambient still renders there, positional lights are inert — deferred to
  roadmap). Depth source reuses D-036's `chroma_depth_track` job verbatim.
  Control-server ops (`add_relight_light` etc., mirroring `add_mask`) added for
  agent access + verification. `cargo test chroma::relight` 10/10 new (incl. a
  real-GPU determinism test); `cargo clippy`/`fmt` clean on touched files; `tsc`
  unchanged at 64. **Verified against the real running app**: opened the real
  `~/Movies/Chroma/New.chroma` project, added an ambient light over the control
  server, decoded the returned preview — the frame washed a uniform colour tint
  exactly matching the shading math; a positional light with no depth track
  correctly produced zero change. Photoreal diffusion bake (v3, `ai/` sidecar)
  explicitly out of scope, untouched.

- **2026-09-02** — **Docs reconciliation pass** (roadmap "Next" item 7, the `CLAUDE.md`
  hard-rule debt owed since the D-039 pivot). `03-architecture.md` fully rewritten for the
  3-tab world (crate/package tables, per-tab current state, data model, AI sidecar, the
  agent bridge) off `docs/notes/architecture-lock.md` + every `D-039`-onward decision;
  `00-vision.md`/`01-prd.md`/`02-scope.md` corrected from "grading only, not an editor" to
  the real 3-tab product, keeping what was still true (local-first, grade-as-code, the
  colour-science wedge) rather than rewriting wholesale; `02-scope.md` keeps the Colorist
  v1 scope as still-accurate and adds the Edit/Motion tabs' own scope alongside it, and
  fixes its "Anti-scope" section, which had named editing/motion-graphics as explicitly
  out-of-scope ("that's Palmier's job") — exactly backwards post-pivot. `BUGS.md`'s "Known
  engine constraints" list had three stale entries (D-014/D-018+D-034/D-036, all since
  solved) removed, one still-real item (the `max_texture_dimension_2d` 8K bypass) kept.

- **2026-09-02** — **Motion tab MVP (D-047).** `@chroma/motion`'s `MotionTab`
  is real: a `@remotion/player` preview of `@chroma/motion-engine`'s `Video`
  composition, a live-validated JSON manifest editor (`zod`, JSON-in this
  pass — visual editor still open, see `product-direction.md` §9), Save
  (project-scoped sidecar `<project>.chroma/motion/manifest.json`) and
  Render (new `chroma-motion` crate → `npx remotion render`, Rust
  orchestrates the existing Node engine rather than reimplementing it). New
  Tauri commands `chroma_motion_get_manifest`/`_save_manifest`/`_render` in
  `app/src-tauri/src/chroma/motion.rs`. Found + fixed along the way: a
  latent `@react-three/fiber` × polymorphic-`React.ElementType` typing
  collision (`@chroma/ui`'s `Text.tsx`, `app`'s `BottomBar.tsx` — see
  B-008), a react/react-dom version-duplication bug (`motion-engine` pinned
  exact versions npm couldn't hoist, so two React copies would have landed
  in one component tree), and a live runtime crash from a duplicate
  `remotion` package (`@remotion/animation-utils`/`google-fonts`/
  `motion-blur`/`noise`/`transitions`/`shapes` all caret-pinned in
  `motion-engine`, so npm floated them to a newer `4.0.520` patch each
  carrying its own nested `remotion@4.0.520` — Remotion hard-errors on a
  version mismatch at runtime, which is what actually blocked the first
  several boot-verification attempts). Both fixed via a root `package.json`
  `overrides` block (not by touching motion-engine's pins) plus a genuinely
  clean `rm -rf node_modules package-lock.json && npm install` — an
  incremental install on top of the pre-override lockfile did not reliably
  apply a newly-added override. Verified with a real `npm run tauri:dev`
  boot: dev-server stdout and the app log stayed clean for the session, no
  "Multiple versions of Remotion" error, no frontend-ready timeout.
- **2026-09-02** — **Media pool, pass 2 (D-045): bins + multiple named
  timelines.** `MediaItem.folder` (a plain path-string bin, no separate
  entity — Palmier-MCP-folder convention) + `chroma_media_move`.
  `ProjectManifest.timeline: Option<Timeline>` (D-041) → `timelines:
  Vec<Timeline>` + `active_timeline: usize`, migrated losslessly from the old
  singular key on load; `Timeline` gained an `id`; new
  `chroma_timeline_list`/`_create`/`_set_active`, existing `_get`/`_set`/
  `_frame` now target the active timeline (unchanged behaviour for a
  single-timeline project). Model + commands only, still no UI. `cargo test
  chroma::` 65/65 (+7); `chroma-timeline` 10/10 (+1); the real
  `~/Movies/Chroma/New.chroma` project migrates cleanly, checked both via a
  throwaway fixture test and a live app boot.

- **2026-09-02** — **Edit tab stuck on stale "no project open" fixed (B-007);
  tab-default persistence removed.** Opening a project from Colorist never
  told the already-mounted Edit tab to re-check — its timeline store only
  refetches on its own mount and on OS window focus, neither of which fires
  on a same-window tab open. `main.tsx` (composition root) now triggers a
  reload when `useSessionStore`'s project-open signal changes. Also:
  `@chroma/shell`'s active-tab was persisted to localStorage, silently
  overriding the "Edit opens by default" fix the moment anyone clicked another
  tab once — now session-only, every launch starts on Edit.
- **2026-09-02** — **Media pool, pass 1 (D-044).** `ProjectManifest.media:
  Vec<MediaItem>` — additive alongside `shots`, unification deferred to
  pass 2/3. New `chroma_media_import`/`chroma_media_list` Tauri commands
  (probe via the existing `video::probe`, dedup by source path, live offline
  flagging). `useMediaPoolStore` scaffolding in `@chroma/bridge` (no panel UI
  yet). `cargo test chroma::` 58/58 (+4); the real `~/Movies/Chroma/New.chroma`
  project still loads.

- **2026-09-02** — **Colorist black preview fixed for real (B-006).** Root
  cause was never the wgpu render pipeline — a temporary off-screen-texture
  dump proved the render pass, scissor math, and bound frame texture were
  already correct — it was a plain CSS regression: D-039's `@chroma/shell`
  wraps the window in a new root `<div>` with a hardcoded opaque
  `bg-bg-primary`, silently blocking the transparent "hole" the Colorist app
  already punches through itself for the native wgpu surface to show
  through. Fixed by mirroring the app's `isWgpuActive` up into a new
  `wgpuSurfaceActive` flag on `@chroma/shell`'s store, which the shell root
  now reads to drop its own background too. No screen-recording permission
  was available to verify with a literal screenshot; verified instead via
  the texture dump (pre-fix) plus a live `getComputedStyle` read of the
  shell root in the running app (post-fix, shows `rgba(0,0,0,0)` exactly
  when the surface is active) — see B-006 in `BUGS.md` for the full trail.
- **2026-09-02** — **Colorist wgpu-sync stuck-hidden loop fixed (B-005); a
  second, separate black-preview bug found and logged open (B-006).** After
  B-004 fixed the IPC corruption, the Colorist preview was still black —
  traced to a real second bug: the wgpu-position sync effect could get
  permanently stuck sending an off-screen transform after one transient 0×0
  layout read (its retry loop only reschedules on a *changed* outgoing value,
  so a bad read that matches a prior one never gets re-tried). Fixed in
  `Editor.tsx`'s `syncWgpu` — DOM-layout-not-ready now polls continuously
  instead of relying on a dependency-array item that can't see pure layout
  changes. Confirmed via a temporary debug log, removed before commit. The
  render now genuinely fires at the correct on-screen resolution — but the
  panel is still visually black, a distinct, still-open native
  window/GPU-compositing issue, logged as B-006 (not yet root-caused).
- **2026-09-02** — **Entry module double-mount fixed (B-004) — "No project open" /
  blank Colorist preview.** `app/index.html`'s `<script>` still referenced the
  pre-D-039 `main.jsx` (renamed to `main.tsx`); Vite's dev-server extension
  fallback served `main.tsx`'s content under that stale URL *and* something
  separately fetched the correct `/src/main.tsx`, executing the entry twice —
  two `createRoot()` calls on `#root` and a corrupted `@tauri-apps/api/event.js`
  listener map (confirmed via a temporary `import.meta.url` probe: two
  executions → after the one-line fix, exactly one). This is what broke
  `invoke`/`listen` round-trips app-wide, producing the Edit tab's stuck "No
  project open" and Colorist's blank main preview despite successful backend
  WGPU renders. Fixed by pointing `index.html` at `main.tsx`; both symptoms
  re-verified against the real running app. Also: `packages/shell/src/store.ts`
  `DEFAULT_TAB` → `'edit'` (owner request — Edit opens first, not Colorist).
- **2026-09-02** — **`@chroma/player` — shared preview component, Editor tab
  migrated (roadmap "Next" item 1, built).** New package: `<Player>` (viewport +
  title strip + transport bar), fully controlled and presentational — no
  `@tauri-apps/api`, no zustand, no video/decode logic, built on `@chroma/ui`'s
  `Button`/`Slider`. `fmtTimecode` moved here from `@chroma/editor`'s
  `PreviewPane.tsx` (single source of truth). `PreviewPane.tsx` rewritten to use
  it: all frame-fetch (`chroma_timeline_frame`) and rAF play-loop logic stays
  put, only the hand-rolled transport JSX moved to `<Player>`. Colorist + Motion
  adoption is follow-on, not done here.

- **2026-09-02** — **Colorist tab is the grading editor only — RapidRAW's
  DAM/welcome/library/community shell removed (D-043, built).** The "Sources"
  folder-tree panel the owner flagged is gone, along with the whole photo-library
  grid, albums, culling, the welcome/"Continue Session" home screen, and the web
  Community presets page — Colorist now shows only the editor or a
  `ColoristEmptyState` message. ~7800 LOC deleted across 51 files (`docs/09` D-043
  entry has the full list); every RapidRAW branding string fixed to say Chroma,
  including the ones baked into exported files (EXIF `Software` tag, XMP
  `x:xmptk`), across all 13 i18n locales. `cargo test chroma::` 54/54 unchanged,
  `tsc` errors 74 → 64 (baseline files deleted, zero new).
- **2026-09-02** — **`@chroma/ui` → shadcn/ui + Base UI (D-042, built).** Canonical
  shadcn structure by hand (`components.json`, `src/lib/utils.ts`,
  `src/components/ui/*`, `src/index.ts`) — the CLI can't target a workspace library
  package. 18 structural components on Base UI (`@base-ui/react` 1.7.0): button,
  dialog, dropdown-menu, context-menu, tooltip, popover, tabs, select, command,
  resizable, sheet, slider, switch, scroll-area, separator, input, label, sonner.
  The 5 hand-extracted primitives rebuilt: `Button` (superset of the old API —
  `variant="primary"` alias, `className` still wins via tailwind-merge), `Input`
  (`bgClassName` kept), `Switch` → bare shadcn switch + new `LabeledSwitch` composite
  (Base UI restores the knob animation), `CollapsibleSection` on Base UI `Collapsible`,
  `Text` unchanged. Theme: one `@theme` source (`packages/ui/src/styles.css`,
  `@import`ed by `app/src/styles.css`), every shadcn token an alias of an existing
  `--app-*` var; the `--accent` collision resolved by keeping RapidRAW's brand
  `--color-accent` and editing shadcn's hover state to `bg-muted`;
  `--color-destructive` the one pinned value. Migrated: `@chroma/shell` "‹ Projects"
  button, `@chroma/editor` timeline toolbar → `Button` + `Tooltip`. Colorist panels
  untouched (later). `tsc` app = 74 (baseline unchanged), `vite build` green, `cargo
  check` untouched. Deferred: typography unification, Colorist `Dropdown` migration.

- **2026-09-02** — **Project launcher is the app entry screen (D-039 migration
  log).** The app opens on the D-037 launcher with no tab bar — just the chrome
  bar. Opening/creating a project sets `useSessionStore.projectPath` (or
  `projectName` for a loose-clip Untitled), flipping `<Shell>` into the 3-tab
  layout; a "‹ Projects" button in the chrome bar calls a new `closeProject()`
  action (flushes a final save for a dirty named project, then resets all
  session + project state) to return. `<Shell>` gains `projectOpen` / `launcher`
  / `onCloseProject` props — it never imports `ProjectLauncher` (app → shell
  only); `app/src/main.tsx` is now a small `Root` that reads the session store
  and routes. Tab panels stay mounted under the launcher so the Colorist MCP
  control bridge keeps running. Colorist (`<App/>`) drops its `activeView:
  'projects'` branch — `useUIStore` default `'projects'` → `'editor'`, `App.tsx`
  renders `<LibraryView/>` directly as the unrouted albums/culling fallback,
  `useAppNavigation` "back" → `'library'`. No Rust change (`state::ProjectRef` is
  left set on close — harmless; the next open overwrites it and every frontend
  save path guards on `projectPath`). `tsc` 74 baseline unchanged, `vite build`
  green. Follow-ups: reopen-last-project on launch; Untitled close = discard.

- **2026-09-02** — **UI consistency pass (D-039): window chrome in the shell,
  `@chroma/ui` kit, editor icons.** (1) The window title bar moved out of the
  Colorist tab into `@chroma/shell` — new `WindowChrome.tsx` (platform logic
  ported from RapidRAW's `TitleBar`: macOS traffic lights, Win/Linux controls,
  drag region), and `Shell.tsx`'s top bar is now the title bar (left = traffic
  lights + `CHROMA` wordmark, centre = tabs, right = window controls / mac
  spacer, `h-10`). `.macos-window-shell` (14px rounded corners) moved to the
  shell root. `app/src/App.tsx` stops rendering `<TitleBar/>` (import + render
  removed; the file stays unrouted for reference). `@chroma/shell` gains
  `@tauri-apps/api` + `@tauri-apps/plugin-os` + `lucide-react` — it's the app
  chrome now, so Tauri coupling is fine. (2) `@chroma/ui` is a real package:
  `Button`, `Input`, `Text`, `Switch`, `CollapsibleSection` extracted from
  `app/src/components/ui/`, the app-side files now `export { X as default } from
  '@chroma/ui'` re-export shims (all `import X from '../ui/X'` sites unchanged).
  Deps kept to react + clsx + lucide — `Switch` drops `framer-motion` (CSS
  transform transition), `CollapsibleSection` drops `react-i18next` (inlined
  strings); `typography.ts` copied into the package. `Slider` + the app-coupled
  components stay in `app/`. `@source "../../packages/ui/src"` added to
  `styles.css`. (3) `@chroma/editor` transport + toolbar rebuilt with
  `lucide-react` icons (`SkipBack` / `Play`–`Pause` / `SkipForward`, `Scissors`
  split, `Trash2` remove); empty-state action is a `@chroma/ui` `<Button>`.
  `npm install` clean, `tsc` 74 baseline unchanged, `vite build` green,
  `cargo check --no-default-features` unchanged (no Rust touched).

- **2026-09-02** — **Editor tab MVP (D-041)**. The Edit tab is a real, working
  single-video-track timeline of the open project's shots. `chroma-timeline` made
  real: `Timeline::from_shots`, `Track::clip_at` / `Timeline::duration`, and
  reorder / trim-start / trim-end / split / remove ops (each unit-tested, 9/9).
  New Rust bridge `chroma::edit` — `chroma_timeline_get` / `_set` / `_frame`
  commands; the timeline persists **in the `.chroma` project** (`ProjectManifest.timeline`,
  `#[serde(default)]`, schema major unchanged — same additive move as D-038's
  `settings`). The preview is a **standalone lightweight decode→jpeg**
  (`decode_pipe` → `image` q80 → `data:` URL), independent of the Colorist's
  wgpu / grade path. `@chroma/editor` is a real tab now: a
  `@xzdarcy/react-timeline-editor` strip (drag = reorder, edge-drag = trim,
  Split-at-playhead, select + Delete = remove) over a preview pane with a
  wall-clock rAF play loop, backed by `useEditorTimelineStore` (zustand, stays in
  `@chroma/editor` for now). Deferred: multi-track, audio, transitions,
  transcript cut, GPU compositing, grade-in-preview, OTIO export, MCP.
  `cargo build` + `chroma-timeline` 9/9 + `chroma::` 54/54 + `tsc` 74 baseline +
  `vite build` all green.

- **2026-09-02** — **3-tab shell (D-039 migration)**. `@chroma/shell` (react +
  zustand only): `<Shell tabs={registry}>` — an h-9 tab bar (Edit / Motion /
  Colorist) over the active tab, all tabs stay mounted, Cmd/Ctrl+1/2/3, active tab
  persisted to localStorage. `app/src/main.tsx` mounts it with the Colorist tab =
  the whole existing app untouched (root `h-screen` → `h-full`); Edit + Motion are
  placeholder tab components (`@chroma/editor` / `@chroma/motion`). `npm run build`
  (vite prod) green, tsc baseline 74 unchanged. The 3-tab layout is now live.

- **2026-09-02** — **Monorepo workspace skeleton (D-039 + D-040)**. The RapidRAW
  fork was de-submoduled into `app/` (D-040), then the workspace made real (D-039
  migration step 1): root `Cargo.toml [workspace]` (members `app/src-tauri` +
  `crates/*`, `Cargo.lock` moved to root, build profiles hoisted from the member);
  3 pure-leaf **stub** crates — `chroma-types` (`Resolution`/`Rational`/`ChromaError`),
  `chroma-timeline` (OTIO-shaped `Timeline`/`Track`/`Clip`), `chroma-grade-model`
  (`Grade` wrapper, mirrors `grade.json` D-025) — each `cargo check` clean with an
  `it_builds` test; root `package.json` npm workspaces + 6 stub packages
  `@chroma/{tokens,ui,bridge,editor,motion,shell}`; the Remotion motion engine moved
  in from `videoAgent/engine/motion/` as `packages/motion-engine/`
  (`@chroma/motion-engine`); `app` package renamed `rapidraw` → `@chroma/app`.
  Repo-wide `engine/…` → `app/…` path fixes (docs, `mcp/`, `ai/`, `eval/`, CLAUDE.md,
  README, sidecar comment). **No real code moved — the whole workspace builds
  (`cargo build --no-default-features` clean, `RapidRAW` crate + 3 stubs),
  `npm install` hoists, `tsc` baseline unchanged (74), `py_compile` clean.** Run the
  app: `npm run tauri:dev` from the repo root. Migration log in `D-039`
  ("### Migration log"); `crates/README.md` + `packages/README.md` carry the full
  planned lists.

- **2026-09-02** — **Per-project output spec (D-038)**. D-037's reserved,
  unused `settings` field on `project.json` gets a real typed shape:
  `ProjectSettings { width?, height?, fps?, color_space? }`, all optional. A
  multi-shot project now has **one** output spec instead of everything being
  derived from whichever clip is loaded. A fresh project seeds
  width/height/fps by probing the first shot's clip; a project with no settings
  behaves exactly as before (clip-derived, byte-identical exports). Export
  resizes the graded composite (Lanczos3) to the project resolution as the final
  step before the encoder and uses the project fps as the timebase. `color_space`
  (`rec709`/`rec2020`/`dci-p3`/`srgb`) is **stored + surfaced only** — a real
  colour-managed pipeline stays D-004. `chroma.project/1` schema major unchanged
  (additive; legacy `settings: {}` / `{fps:24}` still load). New
  `chroma_project_set_settings(path?, partial)` command (partial merge), a
  "Project settings" modal off the shot-strip gear, `get_state().project.settings`,
  MCP `set_project_settings` — **37 → 38** tools. All new logic in
  `chroma/project.rs` + `export.rs` + new frontend files; `lib.rs` +1 line.
  Verified: `cargo check` clean, `cargo test chroma::` **54/54** (49 + 5),
  `tsc --noEmit` baseline unchanged (74, none in new/touched files),
  `py_compile` + `import server` clean (38 tools). The settings modal + a
  resolution-override export + MCP round-trip are an open manual smoke test.
  Detail: `docs/notes/project-model.md`, `D-038`.

- **2026-09-02** — **Project launcher + `<name>.chroma` project model (D-037)**.
  The home screen was still RapidRAW's inherited Library view — a folder tree,
  photo grid, albums, culling. Replaced with a **project launcher**: a grid of
  saved Chroma projects, each a card with a cached thumbnail + name + relative
  timestamp, click to open. A project is a `<name>.chroma` **directory** (not a
  bundle) — `project.json` (versioned, `chroma.project/1` migration gate, shots
  referenced by **absolute source path** — media is never copied), `thumb.jpg`,
  and `grades/<shotId>.grade.json` (each shot's D-025 grade, inside the project
  so it travels with it). Default folder `~/Movies/Chroma/`, configurable. A
  missing source file → the shot shows **"media offline"** with a **relink**; its
  grade is untouched and reattaches. Completes D-033's deferred session
  persistence — D-033's in-memory `Session` is now the loaded form of a project.
  New `chroma/project.rs` (pure fs+json, like `grade.rs`; 8 tests) +
  `chroma_project_list/open/new/save/relink/current/settings_dir/set_dir`;
  `state.rs` += a `ProjectRef`. Frontend: `ProjectLauncher.tsx`,
  `useProjectAutosave.ts` (debounced save on any grade / shot / active-shot
  change), `useSessionStore` project thunks, one routing conditional in
  `App.tsx`, default `activeView` `'library'` → `'projects'`. **LibraryView /
  albums / culling not deleted** — folder navigation still routes to them, so
  upstream stays cherry-pick-able (D-003). Quick-open preserved: a loose clip via
  the picker or MCP `open(path)` → an in-memory "Untitled" session that still
  seeks / plays / exports / tracks. MCP: `list_projects` / `open_project` /
  `new_project` / `save_project`, `get_state().project` — **33 → 37** tools.
  Verified: `cargo check` clean, `cargo test chroma::` **49/49** (41 + 8),
  `tsc --noEmit` baseline unchanged (74, none in new/touched files),
  `py_compile` + `import server` clean (37 tools). Launcher / New-Project /
  autosave / reopen / relink are an open manual smoke test. Detail:
  `docs/notes/project-model.md`, `D-037`.

- **2026-09-02** — **Per-frame depth track (D-036)**. The depth-haze preset
  (D-024) baked ONE Depth Anything V2 map and reused it for every frame — it
  flickers / goes wrong on a moving camera. Replaced with a real **temporal
  video-depth track**, the same move DaVinci Resolve made: **Video Depth
  Anything — Small** (vits, **Apache-2.0** — vitb/vitl are non-commercial and
  must not be used), whose spatial-temporal head makes the depth stable
  frame-to-frame natively, not via a bolt-on filter. Runs in the `ai/` sidecar
  (new `/depth_track` job mirroring `/track`; VDA's cross-frame attention is
  exactly the "too fragile to ONNX-export" case behind D-009's sidecar
  precedent) — vendored (`ai/vendor/`, not pip-installable), checkpoint
  lazy-downloads (~112 MB), MPS fp32. Per-frame depth PNGs cache to
  `<clip>/.chroma/depth/<key>/` and are read at render time keyed by the current
  source frame via a new `chromaDepthDir` param + **one** hook in
  `mask_generation.rs::generate_ai_depth_bitmap` (mirrors D-019's tracked-matte
  read) — so scrub, playback and export all get per-frame depth for free. The
  Rust DA-V2 ONNX path is unchanged and stays the **static single-frame bake**
  for stills and for `apply_haze` before a track is run; absent `chromaDepthDir`
  → byte-identical to before. UI: a "Track depth over clip" button (mirrors the
  subject-track button). MCP: `depth_track` / `depth_track_status`, `apply_haze`
  gains `tracked` — **31 → 33** tools. Verified: `cargo test chroma::` 41/41
  (37 + 4), `cargo check` clean, `tsc` baseline unchanged (74), `py_compile` +
  `import server` clean. `ai/test_depth_track.py` on Tokyo-Walk: PNGs
  non-degenerate, VDA consec-frame |Δ| 0.0032 vs per-frame DA-V2 0.0050 (1.5×
  steadier). Detail: `docs/notes/depth-track.md`, `D-036`.

- **2026-09-02** — **Agent eval harness (D-035, round-3 tail item)**. New
  top-level `eval/` — a regression + capability test for the grading agent (does
  it *grade by the numbers* and converge on a target, or drift?). A 7-task data
  set (`eval/tasks.json`: neutralise a cast, match a shot to a reference, set
  black/white points, fix an exposure error, **don't over-grade** an
  already-correct frame, grade a masked region only, tame highlight clipping) +
  an **offline** scorer (`eval/score.mjs` — no app, no agent, no network). The
  scorer ports `computeScopes` / `computeGap` / `gapMagnitude` verbatim from
  `app/src/utils/scopes.ts` (`eval/lib/scopes.mjs`, drift-guarded by
  `scopes.check.mjs`) plus an **approximate** primary-grade operator
  (`eval/lib/apply.mjs`) that turns a `grade.json` (D-025) into a scoped result
  frame — so absolute scores are only comparable *within* the harness, and
  engine-fidelity is the `eval/run.md` closed-loop runbook's job. Score =
  normalised inverse residual scope gap to the goal, zeroed by hard-fail gates
  (clipping introduced, mask background moved, `knobEffort` over the cap).
  Committed `eval/baseline.json` = the setup grades left unfixed (mean **0.452**,
  2/7 pass); `eval/results/` (7 hand-authored good grades) score **0.975** (7/7,
  every task up vs baseline); `eval/bad_examples/` score **0.0** with gates
  firing — the scorer ranks good ≫ bad offline. Fixtures (`eval/fixtures/`,
  480×270, `_gen.mjs` to rebuild): a downscaled C019 still + synthesised wedge /
  patch frames. Dependency-free (Node `zlib` PNG codec). **Zero engine changes.**
  MCP: added the missing **adversarial** framing to the shared `SCOPE_DISCIPLINE`
  string, `inspect_color`, and `mcp/README.md` — tool count unchanged (**31**),
  `py_compile` + `import server` clean. Detail: `docs/notes/eval-harness.md`.

- **2026-09-02** — **Mask keyframes (D-034, round-3 item "mask keyframes")**. A
  shape sub-mask (radial / linear / brush) can now be **keyframed** — its
  geometry (centre / radii / rotation / feather, linear endpoints / range, brush
  points) is snapshotted at chosen source frames and **interpolated per frame**
  on scrub, playback and export, so a mask can hand-track a subject SAM can't or
  shouldn't follow (a hand, a product, a light, a reflection, a patch of sky).
  Geometry only — grade adjustments aren't keyframed. New **◆ Keyframe** button +
  a diamond track above the timeline (`components/chroma/MaskKeyframeBar.tsx`);
  the canvas overlay draws the **interpolated** shape at the current frame, and
  dragging the mask writes/updates the keyframe at that frame. Data model:
  `parameters.chromaKeyframes = [{frame, params}]`, round-trips through
  `grade.json` inline. Interpolation: linear scalars, **shortest-arc rotation**
  (350°→10° through 0°), brush points lerp when the stroke shape matches between
  keys else snap to the nearer key; clamp/hold outside the keyed range. Tracked
  (`chromaTrackDir`, D-019) and keyframed are mutually exclusive — tracked wins.
  Rust: new `chroma/keyframes.rs` (pure, 14 unit tests) + **one** hook call in
  `mask_generation.rs::generate_sub_mask_bitmap` (mirrors D-019). Frontend:
  `utils/maskKeyframes.ts` (Rust mirror), `MaskKeyframeBar.tsx`, `ImageCanvas.tsx`
  +~4, `useChromaControl.ts` +4 ops. MCP: `add_mask_keyframe` /
  `list_mask_keyframes` / `clear_mask_keyframe` / `clear_mask_keyframes`
  (27 → 31 tools). No `lib.rs` / Cargo / `AppState` change. `cargo check` clean,
  `cargo test chroma::` 37/37 (+14); `tsc --noEmit` baseline unchanged (74, none
  in a touched file); `py_compile` clean, 31 tools. Export + playback interpolate
  for free (both set `current_video().frame` before the grade). Manual app +
  canvas-drag smoke test open. Deferred: grade-adjustment keyframing (separate
  item), easing handles, a full dope sheet, brush strokes that change point
  count between keys (they snap). Detail: `docs/notes/mask-keyframes.md`.

- **2026-09-02** — **Multi-shot session model + shot strip (D-033, round-3 item 2)**.
  Chroma held one clip; now it holds a **session** — an ordered set of shots from
  one shoot, each with its own grade and its own agent-activity feed. New **shot
  strip** (`components/chroma/ShotStrip.tsx`, bottom bar): thumbnail + filename,
  an accent dot when the shot has a non-neutral grade, click to switch, `+` to
  add clips, `×` to remove, `→` to copy the active grade onto the next shot.
  Switching a shot stashes the live grade under the outgoing clip and restores
  the target's (the per-clip `grade.json` sidecar, D-025, is still the on-disk
  per-shot document). **Lightweight by decision** — no `.chroma` project bundle
  (D-033 weighs it against the project's minimal-fork / cheapest-thing bias).
  Rust: `chroma/state.rs`'s clip global becomes `Session { shots, active }`
  (`current_video()` unchanged — returns the active shot; `set_current_video`
  upserts by path); new `chroma/session.rs` (list / add / set-active / remove /
  thumbnail); `video.rs` +1 thumb helper. Upstream edits: `mod.rs` +2, `lib.rs`
  +5, `BottomBar.tsx` +4. Frontend: new `store/useSessionStore.ts`, `useAgentStore`
  per-shot feed scoping, `useChromaControl.ts` ops + `get_state.session`. MCP:
  `list_shots` / `set_active_shot` / `add_shots` (24 → 27 tools). Single-shot
  behaviour identical (one clip = a session of one shot). `cargo check` clean,
  `cargo test chroma::` 23/23 (+5); `tsc --noEmit` baseline unchanged (74, none
  in a touched file); `py_compile` clean. Deferred: `.chroma/session.json` reopen
  (path list, not a bundle), drag-drop reorder, copy-to-any-shot, per-shot
  `grade.json` auto-load. Manual app + MCP smoke test open. Detail:
  `docs/notes/multi-shot.md`.

- **2026-09-02** — **Agent activity feed + `request_human` (D-032, round-3 item 1)**.
  The GUI now shows every grade change the agent made through the MCP/control
  bridge: a fixed bottom-left "Agent activity" dock, newest-first, each entry a
  summary ("primary: exposure +0.35, temp −8" / "match to reference: 3 iters,
  gap 78→10") + an expandable per-field grade diff + a jump-to-here **Undo**.
  Recorded at the single `chroma://request` chokepoint in `useChromaControl.ts`
  (one entry per op — `debouncedSetHistory.flush()` collapses `match_reference`'s
  internal iterations; `seek`/`open` not logged). New `useAgentStore.ts` slice,
  `utils/agentActivity.ts` (`diffAdjustments` / `summarizeActivity`, pure),
  `components/chroma/AgentActivityDock.tsx` + `AgentRoiHighlight.tsx`. Undo is
  jump-to-here on RapidRAW's history stack (drops newer feed entries; documented
  fallback when the 50-slot stack has evicted the pre-op state). `request_human(
  reason, roi?)` — a new non-blocking op + MCP tool: posts a banner (+ an amber
  ROI rectangle on the canvas if `roi` given, normalized 0..1), the user clicks
  "Resume agent", the agent polls `get_state().pendingHumanRequest`. **No Rust
  change** (rides the generic `POST /op` path). Upstream edits: `App.tsx` +2,
  `ImageCanvas.tsx` +2. MCP 23 → 24 tools. `tsc --noEmit` baseline unchanged (74
  pre-existing unrelated errors, none in a touched file); `py_compile` clean.
  Manual running-app smoke test still open (bridge listener doesn't hot-reload).
  Detail: `docs/notes/agent-activity-feed.md`.

- **2026-09-02** — **Real-time playback ≥30 fps (D-031, round-2 item 5 tail)**.
  Closes the "frontend regrade + IPC per frame" ceiling D-030 named. New
  `app/src-tauri/src/chroma/playback.rs::chroma_play_frame` — one IPC call
  that decodes (scaled, via the D-030 pipe's new `-vf scale` path), swaps the
  base frame, and dispatches a single preview job at ~1280 px playback res,
  replacing per-frame `chroma_seek` + `bumpFrameNonce` + `apply_adjustments`
  (two IPC calls + a React round-trip + a full-4K grade + a ~40 ms CPU
  downscale). `ChromaTimeline.tsx` playback is now a `requestAnimationFrame`
  wall-clock loop (skips missed frames, no `setInterval` drift, no frame-drop
  mutex); pause settles full-res; scrub unchanged. `decode_pipe.rs` gained
  `scale_target` / `open_scaled` / `frame_scaled` / `playback_frame_scaled`
  (D-030's native fns are now `..._scaled(.., None)` wrappers, tests untouched);
  `chroma_seek`'s body extracted to `commands::seek_and_install`. Upstream
  edits: `chroma/mod.rs` +2, `lib.rs` +1. `cargo check --no-default-features`
  clean, `cargo test --no-default-features chroma::` 18/18. Headless timing
  harness (`playback_throughput_c019`) on C019 4K/24p, real WGSL grade via
  `render_core::render`: **27.4 ms/frame → 36.5 fps** at 1280 px (was
  68.8 ms → 14.5 fps at 4K), 19.6 ms → 50.9 fps at 960 px. Manual
  scrub/play/tracked-matte smoke test still open. Detail:
  `docs/notes/playback-30fps.md`.

- **2026-09-02** — **Smooth playback: persistent decode pipe (D-030, round-2 item 5)**.
  New `app/src-tauri/src/chroma/decode_pipe.rs` — one long-lived
  `ffmpeg -ss <(start-0.5)/fps> -i clip -f rawvideo -pix_fmt rgb24 -` per clip
  instead of a fresh spawn + keyframe seek + PNG round-trip per frame. `FramePipe`:
  a forward step is one raw `read_exact`, a ≤48-frame hop discards to target, a
  jump / backward kill+respawns. Process-global, dropped by `set_current_video` on
  a clip change, killed on `Drop`. `chroma_seek` decodes through it and falls back
  to `video::decode_frame` on any error; `load.rs` gained `install_frame` (the
  state-writing tail, so the transport doesn't re-probe). Export's `spawn_decoder`
  now seeks too — `-ss …-1s -copyts` + `select` by absolute timestamp `t` (not
  frame index `n`, which is why it stays tracked-matte-safe, the thing D-022
  avoided) — so a `from > 0` range no longer decodes from frame 0. Upstream edits:
  `chroma/mod.rs` +2 only; no `lib.rs` / Cargo change. `cargo check
  --no-default-features` clean, `cargo test chroma::` 14/14 (new pipe + seeked-
  decoder frame-alignment tests). Measured on C019 (4K/24p): 24 sequential frames
  **0.61 s (~39 fps)** vs **15.3 s (~1.6 fps)**; a mid-clip export frame **0.83 s**
  vs **2.9 s**. Open: the frontend per-frame regrade + IPC is now the fps ceiling.
  Detail: `docs/notes/smooth-playback.md`.

- **2026-09-02** — **Stripped `@clerk/react` (D-029, round-2 item 4)**. Removed the
  community-login dep RapidRAW ships for its hosted account — Chroma has no cloud
  (all AI is the local `ai/` sidecar + in-process ONNX). Gone: the `ClerkProvider`
  + hard-coded dev key in `App.tsx`, the `<TitleBar>` React error, the "loaded with
  development keys" console spam. `useUser`/`useAuth`/`useClerk` → local
  null-returning stubs at the 3 call sites; the Settings sign-in panel → a
  one-line "runs all AI locally" note. Frontend-only, no Rust change.

- **2026-09-01** — **Rust-managed AI sidecar (D-028, round-2 item 3)**. The app
  now starts and supervises the `ai/` FastAPI sidecar itself — no more `cd ai &&
  ./run.sh`. New `chroma/sidecar.rs`: resolves python (`CHROMA_AI_PYTHON` →
  `.venv/bin/python` → `python3` on PATH) + the `ai/` dir (`CHROMA_AI_DIR` →
  `CARGO_MANIFEST_DIR`-relative), spawns `uvicorn`, pipes its logs into
  `app.log` as `[sidecar] …`, polls `/health` (ready-in-Nms), restarts on crash
  with 2→30 s capped backoff (60 s slow-retry after 6 fast failures), and is
  killed on app exit via a `RunEvent::ExitRequested`/`Exit` hook. An already-
  running external sidecar is detected and only monitored, never killed or
  respawned. `CHROMA_AI_NO_SPAWN=1` opts out for manual `ai/run.sh` use.
  `chroma_ai_status` command for a future UI indicator. No new crate — the
  health check is a raw `TcpStream` HTTP GET, not blocking-`reqwest`. Known gap:
  packaged-app path resolution (`CARGO_MANIFEST_DIR` is a dev path) — flagged
  for Phase 4. Detail: `docs/notes/sidecar-lifecycle.md`.

- **2026-09-01** — **Per-mask blur (D-027, round-2 item 2)**. A `blur` field
  (0–100) on every mask's adjustments — defocus the masked region. Shader: renamed
  the dead `_pad_cg1` slot in `MaskAdjustments` → `blur` (Rust + WGSL, zero layout
  change) + a ~20-line loop in `shader.wgsl::main` that blends the masked region
  toward the shader's existing ~40 px `structure_blur` pre-pass, weighted by
  `mask · blur/100`, in linear light before tone-mapping (approach (a) — no new
  texture / pass). Frontend: a mask-only "Blur" slider in `Details.tsx`,
  `INITIAL_MASK_ADJUSTMENTS.blur = 0`, `set_mask_adjust` whitelist (`MASK_ONLY_KNOBS`,
  so `set_primary` still rejects it), a new `add_mask(type, geometry)` op for a
  plain radial/linear container, and `apply_haze` now dials in `blur` too (D-024's
  deferred background defocus — done). MCP `set_mask_adjust` gains a `blur` param.
  Verified on C019: `blur 70` under a radial mask drops masked local contrast
  ~25–35 % with unmasked patches at exactly 0, reversible at `blur 0`, blur present
  in an H.264 export, no wgsl compile error. Detail: `docs/notes/mask-blur.md`.

- **2026-09-01** — **`match_to_reference` — the automated grade-by-the-numbers loop
  (D-026, round-2 item 1)**. `match_reference` op in `useChromaControl.ts` + MCP
  `match_to_reference(reference, strength?, max_iters?, tolerance?)`. Loads a
  reference image (same neutral-preview path as `inspect_color`), measures the
  scope gap, and iterates a **damped** primary correction — exposure /
  temperature / tint / contrast / saturation — re-measuring each step until a
  combined gap magnitude drops below `tolerance` or `max_iters` (default 4) is
  hit. Gap→knob scalars: exposure ← mids-luma + common-mode black/white shift;
  temperature/tint back-derived from the app's WB-picker math; contrast ← spread
  difference; saturation ← raw HSV-sat difference (never a ratio). Machinery:
  near-constant damping (~0.78), per-knob per-step ceilings (contrast/saturation
  tight — they poison the next measurement), **roll-back any non-improving step** +
  halve strength, best-snapshot land, 2-stall / 16 s-budget stop. **Merges into
  `primary`** — a match is a balance; creative/curve/mask work is separate.
  Two-capture averaging on each measure to fight the 512-px-JPEG noise floor
  (D-021). Zero engine-Rust changes. Verified live on the 1080×1920 talking-head
  clip: a warm+bright reference vs a cool+dark subject → combined gap **78.3 → 10.0**
  over 5 iterations, monotone decreasing, `warmCool 12.7 → 56.6` (ref 58.1),
  `white 230 → 251` (ref 253), `sat 0.25 → 0.44` (ref 0.43); re-run is a no-op
  (0 accepted steps); an unrelated reference degrades gracefully (130.6 → 86.0
  then roll-back + stall-stop, all knobs finite + in range). Detail:
  `docs/notes/match-reference.md`.

- **2026-09-01** — **`grade.json` save/load + versioned schema (D-025)** — "the grade is
  code". New `app/src-tauri/src/chroma/grade.rs` (pure JSON+fs, no GPU/store):
  `chroma_save_grade` / `chroma_load_grade`. v1 `grade.json` is a **versioned wrapper**
  around RapidRAW's `adjustments` — `{schema:"chroma.grade/1", shot:{source,width,height,
  fps,frameCount,colorSpace,reference}, adjustments:{…}, notes}` — NOT `docs/06`'s ordered
  `stack` (that's the v2 node graph, D-005; `docs/06` rewritten, `stack` kept under "v2").
  Mask mattes externalized so the JSON stays diff-able: static `maskDataBase64` →
  `<name>.mattes/<subId>.png` + `{"$matte"}`, `chromaTrackDir` → `{"$trackDir"}`
  (referenced, not copied — moving a project needs `.chroma/mattes/` too). Load reverses
  it + a `chroma.grade/<major>` gate (v1 identity migration stub; rejects newer/unknown).
  Frontend `useChromaControl` ops `get_grade` / `save_grade` / `load_grade` (load →
  `setAdjustments(() => normalizeLoadedAdjustments(g.adjustments))` + `bumpFrameNonce`;
  **v1 does not auto-switch clips** — flags a `shot.source` mismatch, applies anyway).
  MCP: 3 tools. Engine edits: `chroma/mod.rs` +2, `lib.rs` +2; `cargo check` +
  `cargo test chroma::grade` (3/3) clean. Verified live against the 1080×1920 talking-head
  clip: `set_primary` + subject mask → `save_grade` → a 25 KB `grade.json` (schema tag,
  `{"$matte"}`/`{"$trackDir"}` refs, a `.mattes/` dir of 1080×1920 grayscale PNGs);
  one-knob change → one-line `git diff`; neutralize → `load_grade` → the grade + 3 masks
  (incl. a tracked one) come back, `inspect_color` deterministic across repeats; tracked
  `$trackDir` resolved to the clip's 527-frame matte folder. Detail: `docs/notes/grade-json.md`.
- **2026-09-01** — **Depth-haze preset (D-024)**. `apply_haze({amount?, protect_subject?})`
  / an "Add depth haze" button / `useAiMasking.handleAddDepthHaze` → a "Depth Haze" mask:
  a full-range `ai-depth` sub-mask **inverted** so the matte value tracks distance, graded
  with negative `dehaze` (adds haze) + `saturation -25` + `blacks +10` + `shadows +8`, all
  × `amount`. Depth is a **static** bake (per-frame / temporal smoothing deferred);
  `chroma_seek` now busts `ai_state.depth_map` so a re-apply on another frame is correct.
  No per-mask blur (no such field — deferred). Verified on the 1080×1920 talking-head clip:
  `inspect_color` blackPoint 17→33, saturation 0.33→0.24; background pixels lift ~10 luma +
  desaturate while the subject face is untouched; `amount` 0.4/1.0/1.6 scales monotonically.
  Also landed: `useChromaControl` **mounted at app level** (was `Editor`-only) + a new
  `open(path)` op/tool. Engine edit: `chroma_seek` +5 lines, `cargo check` clean. Detail:
  `docs/notes/depth-haze.md`.
- **2026-09-01** — **Video export + `.cube` bake (D-022)**. New
  `app/src-tauri/src/chroma/export.rs`: `export_video` (one `ffmpeg -f rawvideo`
  decode pipe → `render_core::render` per frame, one GPU ctx for the run → one `ffmpeg`
  encode pipe; ProRes 422 HQ / H.264) and `bake_primary_lut` (`size³` identity lattice
  through the primary grade only → `.cube`, warns on dropped masked layers). Per-frame
  tracked matte via new `chroma::state::set_current_frame` (D-019). Commands
  `chroma_export_video` (background + `chroma_export_progress`) / `chroma_bake_lut`;
  frontend `export` / `export_progress` bridge ops; MCP `export(kind, path?, from?, to?)`.
  Verified on the 1080×1920 test clip: neutral + `exposure` + tracked-subject exports
  (`ffprobe` + frame spot-checks) and a warm `.cube` that reddens a grey ramp in ffmpeg.
  Detail: `docs/notes/export.md`.
- **2026-09-01** — **Scopes + `inspect_color` (D-021)**. New `app/src/utils/scopes.ts`
  (pure JS, no deps): `computeScopes` (black/white points, luma + per-channel clip %,
  per-zone means, warm-cool + green-magenta cast, 12-bin saturation-weighted hue
  histogram, mean saturation), `renderParade` / `renderVectorscope` PNGs, `computeGap`
  (subject→reference hints that map onto knobs), `samplePoint` / `sampleRegion`.
  Wired into `useChromaControl` as read-only ops `inspect_color(frame?, reference?)` /
  `sample` / `sample_region`; every mutating op response now also carries the compact
  `scopes`. Reference images load via the existing `generate_preview_for_path` command
  — **zero engine Rust change**. `mcp/`: 3 new tools + scope-first discipline ("grade by
  the numbers; cite a scope value or a named region; defer the creative call") in the
  server instructions, the mutating tool docstrings, and `mcp/README.md`. Pure functions
  unit-checked on synthetic ImageData (grey / ramp / warm-cast / orange / clip / gap).
  Detail: `docs/notes/scopes.md`.
- **2026-09-01** — Repo scaffolded. `engine/` submodule = RapidRAW. Docs written (vision,
  PRD, scope, architecture, roadmap, research, grade-format, MCP surface, decisions).
  `CLAUDE.md` rules.
- **2026-09-01** — Engine code-read (`docs/09`). Rust 1.98, `cargo check` passes.
  Findings that shaped decisions: AI is ONNX-in-Rust not Python (**D-009**); `WgpuDisplay`
  is the native video-surface path (**D-006**); render core is Tauri-coupled → extract
  `render_core` (**D-014**). Added D-012 (SAM 1→2), D-013 (relight → v3).
- **2026-09-01** — ffmpeg → 4K Rec709 frame from the C019 test take works. Disk cleaned
  (3.6 → 38 GiB free).
- **2026-09-01** — D-003 decided (standalone hard fork; still keep changes clean for
  upstream cherry-picks), D-012 decided (SAM 2, no fallback).
- **2026-09-01** — App builds + launches (`tauri dev`, 7m18s). Phase 0 done.
  Phase 1 started: `src/chroma/video.rs` — ffmpeg probe + single-frame decode (D-015),
  first engine divergence (all under `src/chroma/`, +1 line in `lib.rs`). Tests pass
  against the real C019 4K take.

## Releases

_(none — pre-v1)_

- **2026-09-01** — Minimal video-open path built: a video loads as frame 0 through the
  existing grade pipeline (`src/chroma/{state,load}.rs` + 3 one-line hooks). Engine on
  branch `chroma`. App rebuilt + running.
- **2026-09-01** — Video transport bar + timeline view (filmstrip → 48-frame thumbnail
  strip when a video is loaded, click/drag to seek). Backend: `chroma_seek`,
  `chroma_video_info`, `chroma_frame_thumbnails` (cached).
- **2026-09-01** — SAM 2 subject mask working (D-012 → Python sidecar, `ai/`,
  `ultralytics` on MPS). Clean silhouette matte on the 4K test frame — the ellipse's
  hands problem is solved. `/segment` supports box + multi-point (+/−) prompts.
- **2026-09-01** — Matte edge refine (**D-016**): SAM 2's 256px decoder staircases at 4K;
  guided-filter finesse (the Resolve approach) failed on the low-contrast test shot; added
  a trimap → **ViTMatte** stage → clean edge. Worklog + before/after in
  `docs/notes/matte-edge-pipeline/`. `transformers` + `opencv-contrib-python` added.
- **2026-09-01** — Subject mask wired into the engine: `src/chroma/mask.rs` —
  `chroma_subject_mask` bridges the current frame → sidecar `/segment` → an `ai-subject`
  mask (RapidRAW's own type, so the grade UI + render are untouched). Box-drag on a loaded
  video now routes to SAM 2 + ViTMatte instead of ONNX SAM. `chroma_ai_health` for a UI
  hint. Engine + frontend both compile; app runs.
- **2026-09-01** — Per-frame subject **tracking**. Sidecar `/track` (background job,
  mattes cached to `<video>/.chroma/mattes/<key>/`), `/refine_track` (upgrade one frame to
  ViTMatte). Engine: `chroma_track_subject`, `chroma_track_status`,
  `chroma_subject_matte_for_frame`, `chroma_refine_tracked_frame`. Frontend: "Track subject
  across clip" + "Finalize matte" buttons + seek swaps the frame's matte. **fast/quality
  modes** — guided-filter edge on the pass, full ViTMatte on the visible frame.
- **2026-09-01** — Tracking rewritten to **SAM 2 memory propagation** (**D-018**):
  `SAM2DynamicInteractivePredictor` (in the installed ultralytics — no new dep), prompt
  once, ~180ms/frame, every frame gets a matte. Gotchas: `conf≈0`, `obj_ids` 0-indexed,
  refine the loose prompt box to a YOLO person box first.
- **2026-09-01** — **B-002 fixed**: sidecar climbed to ~12 GB after repeated Re-track
  (fresh predictor per pass never returned to the MPS pool + concurrent stacking). `_GPU`
  lock serialises model calls; one reused predictor; `_free_gpu()` after every op; `/track`
  cancels a running pass. Plateaus ~1.3 GB now.
- **2026-09-01** — **D-014 done**: `render_core.rs` seam — the render fn takes
  `RenderCaches` (the 2 GPU-cache mutexes) instead of `tauri::State<AppState>`; added
  `init_gpu_context()` (surface-free). GUI render path byte-identical. Unblocks headless
  render + the control/MCP server (next).
- **2026-09-01** — Tracking display reworked (**D-019**): matte is read from disk **at
  render time** (`params.chromaTrackDir` → `tracked_full_mask` → `<dir>/<frame>.png`) in
  `generate_ai_subject_bitmap`, not swapped into `adjustments` per seek. Fixes the
  overlay-regen storm, the frozen timeline, and the frame/matte desync (offset red blob).
  Persists with the project — no re-track on reopen. Also fixed: `ChromaTimeline` root
  capture-phase `stopPropagation` was eating strip clicks. **Mask follows the frame
  perfectly in-app now.**
- **2026-09-01** — **Control server + MCP bridge (D-020) — v1**. `src/chroma/control.rs`
  (`tiny_http`, port 19788, spawned in `.setup()`) ⇄ Tauri events ⇄ new
  `src/hooks/useChromaControl.ts` (mounted in `Editor.tsx`). One shared grade/mask state:
  every MCP op calls the same store action the GUI buttons do (`setAdjustments`, the
  `useAiMasking` handlers, `chroma_seek`) — sliders move, history/undo work, `get_state`
  reflects manual edits. New `mcp/` dir: Python stdio MCP server, 11 tools
  (`get_state, set_primary, set_curve, set_color_grade, seek, list_masks, add_subject_mask,
  track_subject, set_mask_adjust, invert_mask, delete_mask`). Mutating ops return the
  rendered frame (`generate_uncropped_preview`) + histogram + adjustments. Verified end to
  end with `curl` and an MCP client against the C019 take (exposure moves the slider + the
  canvas; subject mask created on the video). Engine edits: `Cargo.toml` +1, `mod.rs` +1,
  `lib.rs` +6. `cargo check` clean.
- **2026-09-01** — Mask refinement decided (**D-023**): use RapidRAW's existing
  Add/Subtract/Intersect composition (works with SAM Subject too), NOT a +/− point
  mechanism. No point UI built. MCP gains `add_subject_mask(mode)`,
  `add_component(mask_id, type, mode)`, `set_submask_mode` — all through the same
  `createSubMask`/`updateSubMask` a slider uses. `ai/` + engine `points` support left
  unused.
- **2026-09-03** — **Full NLE, Phase 1 (D-086): real data model for track
  lock/hide, clip transform, and rearrange.** `chroma_timeline::Track`
  gained `locked`/`hidden`; `Clip` gained `opacity`/`position_x`/
  `position_y`/`scale`/`rotation`/`chroma_keyframes` (reusing the existing
  D-034 keyframe engine, not a new one). New `Timeline::move_track` and
  `resolve_visible_video_layers_at` (the multi-layer generalization of the
  existing single-winner track resolver — the real query the Phase 2
  compositor needs). 58/58 chroma-timeline tests, 143/143 chroma:: tests
  unchanged. Phase 2 (the actual compositor) is next.
- **2026-09-03** — **Full NLE, Phase 2 (D-088): a real video track
  compositor exists now.** `chroma_timeline_frame` alpha-blends every
  visible video layer at a position (not just the top opaque winner) —
  real position/scale/rotation/opacity, keyframeable. CPU-based (real
  arbitrary-angle rotation, real alpha blending), no new dependencies. The
  single-track case is untouched, byte-identical. 7 new pure compositing
  tests, all passing on the first run.
- **2026-09-03** — **Full NLE, Phase 3 (D-089): TypeScript mirror of the
  lock/hide/rearrange/transform data model.** `packages/editor/src/
  timeline.ts` gains `Track.locked`/`hidden`, `Clip`'s transform fields, and
  new ops `set_track_locked`/`set_track_hidden`/`move_track`/
  `set_clip_transform`/`set_clip_keyframes` — `applyOp` mirrors Rust's
  `TrackLocked` refusal exactly (per-clip ops refused on a locked track,
  `move` checks both source and destination, track-list ops stay ungated).
  27 new vitest tests (68/68 across `packages/editor`), `tsc --noEmit`
  clean, `app`'s 64-error baseline unchanged. Phase 4 (UI) is next.
- **2026-09-03** — **Full NLE, Phase 4 (D-090): the UI — the P0 effort is
  done.** `TimelinePane.tsx` gains track header lock/hide toggles, up/down
  rearrange (native row-drag checked, buttons shipped instead — see D-090),
  a clip-transform popover (opacity/position/scale/rotation), and
  keyframing UI reusing `RelightPanel.tsx`'s Diamond-icon pattern via new
  `clipKeyframes.ts`. No new inline props into the timeline library's own
  render path (D-083 discipline held). 11 new tests (79/79 across
  `packages/editor`), `tsc --noEmit` clean both packages, clean app boot.
- **2026-09-03** — **React Compiler enabled (D-091).** `app/vite.config.mjs`
  now runs `babel-plugin-react-compiler` via `@rolldown/plugin-babel` +
  `reactCompilerPreset()` (the real v6 wiring, not the removed inline
  `react({ babel: {...} })` option) across every source package this build
  consumes. Verified via the compiler's own `logger.logEvent` API (bundle-
  grepping for its runtime import/function names is unreliable post-bundle/
  minify — chased that dead end first): 265 `CompileSuccess` events across
  110 unique files, 120 legitimate bailouts (mostly `try/finally`, a
  documented compiler limitation) across 45 files, no build errors. A quiet
  bailout-only `console.warn` logger stays wired in permanently for ongoing
  visibility.
- **2026-09-03** — **`app/bench` UI perf harness revived, retargeted at the
  Edit-tab timeline (D-092).** Its old `scroll`/`open`/`edit` phases
  targeted RapidRAW's library grid/editor sliders, removed by the D-043 DAM
  strip-out — replaced with `pan`/`dragover`/`move` phases against the
  multi-track timeline. `dragover` directly stress-tests the D-083 freeze
  scenario (sustained native `dragover` ticks over the timeline), the most
  relevant probe for whether the new React Compiler (D-091) helps. Also
  added `docs/notes/performance-instrumentation.md`, inventorying every
  other real timing mechanism already in the codebase (Rust
  `Instant::now()`/`log::info!`, sidecar `time.time()` + `GET /memory`).
  Honestly flagged, not faked: no tool this session can drive the native
  Tauri window, so no compiler-on/off numbers were captured — the script's
  ready, running it by hand is the next step.

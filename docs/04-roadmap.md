# 04 — Roadmap

Reorganized 2026-09-02 (was pure chronological append — unreadable after 40+ decisions).
**Now / Next / Later / Shipped**, not phases. Full rationale for any `D-NNN` lives in
`docs/08-decisions.md` — this file tracks *state*, not the reasoning; don't duplicate
prose here that already exists there. Timelines are rough solo-dev-with-Claude
estimates, not commitments (see `docs/notes/product-direction.md` §5 for how those
numbers are actually calibrated).

---

## In flight right now (2026-09-04 afternoon) — live-testing punch list

Owner asked to track this live so nothing found today gets lost — update as each lands
(move it to a real `D-NNN`/`B-NNN` + strike it here) rather than letting it go stale.
Two forks dispatched, both working in isolated git worktrees (`chroma-worktrees/`) so
the owner's live dev server isn't disturbed while they work — merged back and the app
restarted once each is done.

- ✅ **Filmstrip thumbnail generation was spawning unbounded concurrent `ffmpeg`
  processes** — done, D-121/B-037 (`86af5cc`). `Semaphore(3)` caps concurrency;
  also found and fixed a compounding cause — software decode alone was 393%
  CPU/~5s per clip on real 4K HEVC footage. `-hwaccel videotoolbox` (with a
  real tested software fallback) cut that to 38% CPU/~3.3s, measured directly
  against the owner's own file. This is very likely also the full explanation
  for the separately-reported scrub/playback lag, not a second bug.
- ✅ **Filmstrip thumbnails didn't render for every clip type** — done, same
  commit. Root cause: a silent `.catch(() => [])` was swallowing every real
  backend failure with zero logging — now logged, so a genuine codec failure
  is diagnosable instead of invisible.
- ✅ **Remove the dotted-line drag indicator** — done, D-122. The redundant
  `border-dashed` landing box (pre-dating D-119's real thumbnail ghost) is
  gone; the underlying state it shared with the sync-linked-clips preview
  was kept, only the extra box's own render was removed.
- ✅ **Auto-decommission empty tracks** — done, D-123. Checked live first:
  neither Premiere nor Resolve auto-removes by default — scoped narrowly
  (only the track a `remove`/cross-track `move` just emptied, never a
  sweep) to honor the owner's ask without the blast radius a blind
  implementation would have had. Fixed the real index-invalidation risk
  this raised for `Selection`/`SelectedGap` with dedicated remap tests.
- ✅ **Sources panel's open/close toggle is still on the right** — done, D-120
  (`fc87547`). Moved from `Shell.tsx`'s chrome-bar to `top-2 left-2` inside the
  panel area, mirroring D-118's Inspector toggle placement. Stayed shell-level
  (not per-tab) since Sources is genuinely shared across all three tabs.
- ✅ **"Do we support crop?"** — answered, D-127. **Yes in Colorist** (real
  routed panel, really applied to the preview — video frames included — and
  to a still export); **no in the Edit tab** (no field on `Clip`, nothing in
  the compositor — a real missing feature, not dead UI; queued as item 14's
  Phase 3); and it was **silently dropped on a video export**, along with
  straighten / flip / 90° steps / the lens warp — **B-042**, now a loud
  pre-flight refusal naming the offending controls. Actually *honouring* it
  on export is queue item 15.
- 🔜 **On-canvas PIP transform (drag/resize the overlaid clip in the
  preview)** — **scoped, not built**: `docs/notes/on-canvas-transform.md`,
  queue item 14. Two things worth knowing before anyone starts — the preview
  is a plain `<img>` fed a backend-composited JPEG, not a canvas (so handles
  are a DOM overlay, and there's no cheap live re-render of the picture
  mid-drag), and **B-043**: the composite's coordinate space is
  preview-resolution-dependent today, so a PIP overlay already moves *and*
  resizes when you press Play. That's Phase 0, and it needs the owner's call
  on units before any code.
- ✅ **"It takes so long to open a project" + "if you are loading 4k that might
  be wrong"** — done, D-128 (B-044/B-045/B-046). Both instincts were right and
  they were two different defects. Every cache in the codebase was a
  process-local static, so a relaunch re-ran every `ffprobe`, re-decoded every
  filmstrip and re-decoded every waveform — now a persistent, source-keyed disk
  cache (`chroma::media_cache`, `app_cache_dir()/chroma`). And project-open
  really was decoding a full 4K frame per clip, ~1.9s each, then throwing every
  one away unseen. Full critical-path catalogue in
  `docs/notes/media-cache.md`.
- ✅ **Filmstrip tiles look stretched/smeared at high zoom** (owner's screenshot
  vs. Palmier Pro's timeline) — done, D-128. This is the gap D-124 named and
  deferred: 64 frames can't fill 930 tiles. Now windowed level-of-detail
  extraction over the visible scroll range, which is also the shape the
  persistent cache wanted. **727px/tile → ≤50px** at the default zoom on the
  owner's 517s clip.

---

## Now — what's live, by tab

- **Colorist** — the full pre-pivot grade pipeline: primary/curves/wheels/LUT, masks
  (shape + AI subject, composable, keyframeable), scopes, `match_to_reference`,
  depth-haze, subject tracking (SAM2+ViTMatte) + temporal depth track (VDA),
  **interactive relight** (draggable depth-driven light pucks, deterministic,
  real-time — D-048, follow-ups D-054; the photoreal diffusion bake is still
  v3/Later), export +
  `.cube` bake, `grade.json`, the agent activity feed + `request_human`, an eval
  harness. MCP surface: 38+ tools. **RapidRAW's DAM/welcome/library shell is gone**
  (D-043) — it's the grading editor only now. **Shot-switch now shows a real
  loading spinner** (D-063/B-015) instead of a silent flash to blank — the
  spinner already existed, fully built, wired to a dead pre-pivot flag.
- **Editor** — MVP: single-video-track timeline (`chroma-timeline` + `react-timeline-editor`),
  scrub/play preview (independent of the Colorist render path) via the shared
  `@chroma/player` component, reorder/trim/split/remove/**add via drag-from-Sources**,
  persisted in the project. Multiple named timelines per project, switchable via
  a **tab-strip `TimelineSwitcher`** (D-046, rebuilt on `@chroma/ui` `Tabs`,
  D-058). **Real audio during playback** (D-050 —
  `symphonia`→`rubato`→`dasp_sample`→`cpal`, single video track's embedded
  audio stream, synced-at-start-not-tightly-coupled to the video playhead).
  **Mature single-track timeline UI** (D-051) — scroll-wheel + toolbar zoom,
  edge-drag trim + snap-to-clip-edge/playhead, a Rust-computed waveform on the
  clip **plus a real filmstrip of the clip's own picture content, shown in
  the drag preview too** (D-119, hardware-decoded + concurrency-capped after
  a real overload incident — D-121/B-037; the redundant dashed drag-landing
  box removed once the filmstrip ghost made it duplicate information —
  D-122), ripple-shift flash, an **adaptive-density
  real-timecode ruler**
  (D-058). **An emptied track auto-decommissions and the rest renumber**
  (D-123 — narrowly scoped to the track an edit just emptied, checked live
  against Premiere/Resolve's own manual-only default first). Clip **position is a real, explicit `start_frame` the frontend
  edit model now actually maintains** (D-058, closing a gap D-054's backend
  model had opened) — drag-from-Sources and edge-trim were both silently
  broken by that gap until the owner's live testing caught it and this pass
  fixed it (**B-012**/**B-013**) — though D-058's own fix alone still wasn't
  the whole story: drag-and-drop stayed dead in the *real* app until
  **D-064** found Tauri's own `dragDropEnabled` (on by default, intercepting
  HTML5 drag before the page saw it) — the actual last piece, confirmed by
  the owner dragging a real clip in the real window. Edge-trim now has a
  real `ew-resize` cursor + hover affordance (D-061; the library never
  styled this). **The clip-properties Inspector is now a real full-height
  side panel** (D-118 — was a third pane nested inside the timeline's own
  split, capped at the timeline row's height; now a sibling of the
  preview+timeline column, spanning the tab, with its own tab-local opener
  button). No multi-track or transcript cut yet.
- **Motion** — MVP (D-047): a `@remotion/player` live preview of
  `packages/motion-engine/`'s `Video` composition + a JSON-in manifest editor
  (validated against the engine's own `zod` schema — a visual editor is
  still an open question, now queued below as its own scoping task), Save
  (project-scoped sidecar `<project>.chroma/motion/manifest.json`) and
  Render (`chroma-motion` crate → `npx remotion render`) — **render now
  auto-imports its output into Sources** (D-062), ready to drag onto the
  Edit timeline like any other clip (deliberately not auto-placed on any
  timeline). No multi-manifest, render progress/cancel, or packaged-build
  story for the engine yet.
- **Shell** — 3-tab layout, window chrome, the project launcher as the app's entry
  screen (opens on the launcher, tabs appear once a project is open), a docked
  Sources/Library panel reachable from every tab (real poster-frame thumbnails,
  import, search, a bin tree with real "New Folder" creation — even an empty
  one persists and lists, drag-to-track — D-046, D-059; **real delete**, single
  via a hover trash icon/right-click or multi-select "Select all"/"Delete (N)"
  — D-060/D-061), `@chroma/ui` (shadcn/Base UI, 18 components, themed). **Sources
  docks on the left as a real resizable panel** (was a fixed-width right column —
  D-116, corrected here from an earlier mis-citation of D-114, which is
  actually the unrelated manifest-cache decision), matching the media-bin-left
  convention Premiere/Resolve/Final Cut/Palmier Pro all share; each tab's own
  properties/inspector panel already anchors to its own right edge
  independently — `Shell.tsx` stays deliberately tab-agnostic, so this is
  the one genuinely shell-level panel (see D-118 for why the Edit tab's own
  Inspector, by contrast, stayed a tab-local panel rather than also moving
  to shell level).
- **Monorepo** — de-submoduled (`app/` = vendored RapidRAW), Cargo + npm workspace
  (`crates/`, `packages/`), 3 stub crates real-but-thin. Full layer table:
  `docs/notes/architecture-lock.md`.

Run it: `npm run tauri:dev` from the repo root.

---

## Next — the active queue, in order

Each of these was scoped in a real conversation (owner-requested or -directed); detail
lives in the `D-NNN` / `docs/notes/*.md` referenced. Sequenced because they share hot
files (`App.tsx`, `Shell.tsx`, `useUIStore.ts`) — one subagent at a time until the
crate/package extraction phase makes true parallelism (isolated worktrees) safe.

1. ~~**Editor timeline audio playback**~~ — **done, D-050 (2026-09-03).** Real
   `cpal` device audio during Play: `symphonia` decode → `rubato` resample →
   `dasp_sample` format-convert → `cpal` output, reusing the video track's
   embedded audio stream (no separate audio `Track` populated — see D-050).
   A dedicated audio thread free-runs against the device clock, started from
   the same playhead frame the video `rAF` loop re-baselines from on every
   Play toggle — not a tight per-frame coupling (the real tradeoff, written
   up in D-050). **Deferred, tracked separately:** multi-track audio mixing
   (**now done — item 6's Phase C / D-057**), waveform-on-clip UI (item 2),
   mute/volume controls, audio scrubbing while
   paused, and long-play-session drift correction between the audio/video
   clocks (open-loop by design this pass — see D-050's sync-model note).
   - **Re-resolve the active sources at a clip boundary mid-session** — D-050's
     "a source's set is fixed at the moment `chroma_audio_play` is called" is
     still true, and since D-130 a source correctly falls **silent** at its
     clip's out-point instead of playing the rest of its file underneath the
     next clip's picture (B-048). Correct, but it means a multi-clip timeline
     goes quiet after the first clip until the next Play/seek. The real fix is
     for the audio thread to re-resolve as the playhead crosses a boundary.
   - ~~**A backend volume/mute primitive**~~ — **done, D-126.** Noted as
     missing while fixing D-130; landed independently by the concurrent
     player-controls pass as `chroma_audio_set_volume`, a lock-free
     `AtomicU32` gain read inside the live `cpal` callback.
2. ~~**A mature timeline UI**~~ — **done, D-051 (2026-09-03).** Scoped against
   `react-timeline-editor`'s actual API first, as directed: **edge-drag trim and
   snapping (to adjacent clip edges + the playhead) turned out to already be fully
   native** (`flexible: true` + `dragLine: true`, both already set since D-041) — zero
   new code for either, just verified by reading the library's bundled source.
   **Real-interaction gap found + closed, D-058 (2026-09-03, same day):** the
   owner's own hands-on testing found edge-trim actually broken live, plus
   drag-from-Sources — a genuine `D-054` regression (D-054 changed
   `trim_start`'s real semantics hours after D-051 verified the library's
   mechanics were native — D-051's own verification was and remains correct,
   what changed was what the frontend's op computed from it) compounded by a
   pre-existing position-derivation bug D-054 exposed, **plus a third,
   independent bug found only by real live pointer testing**: the clip-name
   label's `z-10` had no isolating stacking context and silently covered the
   resize handles, eating every trim `pointerdown` before `interact.js` ever
   saw it — so edge-trim's real pre-fix symptom was "nothing happens," not
   "the wrong edge moves." See D-058 / **B-012**/**B-013**.
   **Custom, built this pass:** scroll-wheel zoom over the timeline (native `wheel`
   listener + toolbar zoom buttons — the library has no wheel handling at all), a
   Rust-computed waveform (`chroma_audio_waveform`, `chroma::audio` — one-shot
   `symphonia` decode → mono → min/max bucket peaks, drawn as a plain `<canvas>` in
   the new `Waveform.tsx`, no new dependency), and ripple visual feedback (a
   clip-id→start-frame diff drives a brief `animate-pulse` on whatever shifted).
   **Per-track colour coding deliberately not built** — the Editor timeline is still
   genuinely single-video-track in practice (D-041/D-045); a "Video 1" label names
   the one real track honestly instead. Real multi-track visual polish stays gated on
   a future multi-track-*authoring* feature, not this UI pass.
3. **Export → a top-right button + an Export window** — done, 2026-09-03 (**D-049**):
   `ExportDialog`, the right-most button in the Colorist tab's `EditorToolbar`
   (top-right of the tab), backed by the existing `chroma_export_video`/
   `chroma_bake_lut` (D-022) via `@chroma/ui`'s `Dialog`/`Select` (D-042). Codec,
   resolution (Project spec / Clip / Custom — D-038 project spec is the default when
   set), frame range (full clip / custom), a `.cube` bake toggle, an output path via
   the native save dialog, and a real progress bar (polled `chroma_export_progress` —
   no new progress mechanism needed, it already existed and had no GUI caller). The
   old `Panel.Export`/`ExportPanel` toggle was **not** removed — it's RapidRAW's
   still-image exporter, a different and already-broken-for-video feature, not a
   duplicate (see D-049; the video-export brokenness itself is **B-010**, still open).
   **Deferred, unchanged:** shell-level export (the Edit tab's active timeline) and a
   push-based/percent-exact progress event (polling is coarse but real).
4. **Global undo/redo** — done, 2026-09-03 (**D-052**): shell-level Cmd/Ctrl+Z
   (undo) / Cmd/Ctrl+Y or Cmd/Ctrl+Shift+Z (redo) spanning all 3 tabs, owned by
   `Shell.tsx` — pops the new `@chroma/history` store (`{tab, label, undo(),
   redo(), ts}`) regardless of which tab is active and **switches to that tab**
   so the effect is always visible. The Colorist's existing 50-deep
   `useEditorStore` history was left untouched and bridged in via
   `useColoristHistoryBridge.ts` (an adapter, not a rewrite); the Editor's
   timeline ops (`useEditorTimelineStore.applyOp`) now push before/after
   `Timeline` snapshots for every reorder/trim/split/remove/add_clip — real
   Edit-tab undo for the first time. D-032 tie-in: explicitly out of scope,
   documented why. **Deferred:** the Motion tab (no natural edit-history unit
   this pass) and routing the Colorist toolbar's own Undo/Redo buttons through
   the shared stack (still call `useEditorStore` directly — a known, harmless,
   documented gap, see D-052).
5. **Docs reconciliation** — done, 2026-09-02: `03-architecture.md` fully rewritten for
   the 3-tab world, `00-vision.md`/`01-prd.md`/`02-scope.md` corrected off "grading
   only, not an editor," `BUGS.md`'s "Known engine constraints" cleaned of solved items
   (D-014/D-018/D-034/D-036).
6. **Multi-track NLE** — owner, 2026-09-03: "we use that, it's important, we need full
   editing" — the standard baseline every NLE has (N video tracks, N audio tracks
   mixed with per-track vol/mute/solo/pan, clips placeable anywhere not just
   back-to-back, drag between tracks, track headers, add/remove tracks, basic
   transitions, the composite actually renders in preview and export). Full scoping,
   verified against the actual current code (not assumed): `docs/notes/multi-track-nle.md`.
   Real finding: clips have no position field today — every track is forced
   back-to-back by construction, the actual blocker under "just add tracks." Phased:
   **A** (clip positions + gap item + add/remove-track ops, `chroma-timeline` — cheap,
   one pass) and **C** (audio mixing, extends D-050's `cpal` pipeline — moderate) are
   independent and approachable now. **B** (the actual compositor — render N video
   tracks together, feed both preview and export) is the real long pole, sub-phased
   B1 (2 tracks, opaque)→B2 (N tracks)→B3 (blend modes) rather than attempted whole.
   **D** (multi-track timeline UI), **E** (transitions), **F** (export through the
   real timeline) all sit downstream of B and shouldn't start earlier.
   - ~~**Phase A — data model foundation**~~ — **done, D-054 (2026-09-03).**
     `chroma-timeline::Clip` gained an explicit `start_frame: i64`
     (timeline-absolute), not the OTIO-style `Gap` item — see D-054 for the
     full rationale (it maps directly onto `@xzdarcy/react-timeline-editor`'s
     own start/end-time item model, which the Edit tab's UI already uses).
     Every existing op (`reorder`/`trim_start`/`trim_end`/`split`/`remove`)
     reworked for gaps + no-overlap invariants; `add_track`/`remove_track`/
     `move_clip` added; `chroma_timeline_add_track`/`_remove_track`/
     `_move_clip` Tauri commands wired in `edit.rs`. Legacy `project.json`
     migration (`Timeline::backfill_legacy_positions`) verified against the
     real `~/Movies/Chroma/New.chroma/project.json`. No frontend/UI, no
     compositor, no audio — those are Phases B/C/D, still not started. **Phase
     B is next** (the real long pole — see above); C is independent and can
     run in parallel.
   - ~~**Phase B1 — two video tracks, opaque compositing**~~ — **done, D-059
     (2026-09-03).** Real finding, worth flagging since it reshapes how big
     B2/B3 looked from the outside: opaque top-wins compositing needed **no
     new rendering/GPU code at all** — with no alpha to blend, showing the
     top track's content fully hides whatever's below, so this is a
     track-**selection** problem (which one source do we decode and show),
     not a pixel-compositing one. Landed as `Timeline::resolve_video_clip_at`
     in `chroma-timeline` (pure model logic — video tracks walked in index
     order, lower index = higher priority/"on top", first one with a clip,
     not a gap, at the position wins; falls through only on a gap), with
     `edit.rs`'s `resolve_video_position` (shared by `chroma_timeline_frame`
     and the audio path) as a thin wrapper that probes the winning clip.
     Real multi-texture GPU blending stays Phase B3's job, unstarted. Phase
     B2 (N tracks) is now essentially free — the same walk already
     generalizes past 2 tracks without more work, just untested at N>2 yet.
   - ~~**Phase C — real audio mixing**~~ — **done, D-057 (2026-09-03).**
     `chroma::audio`'s `cpal` pipeline now sums N sources — the baseline
     video-embedded audio (unchanged, unity gain, D-050's existing behaviour)
     plus every genuine `TrackKind::Audio` clip overlapping the play
     position — instead of playing exactly one stream. New
     `chroma_timeline::Track::gain: f32` (default `1.0`) is per-track volume,
     read (for genuine audio tracks; the video track's own embedded audio
     stays hardcoded at unity this pass) by a new `mix_sources` mixer: sum
     the active (nonzero-gain) sources, then a soft (`tanh`) limiter — chosen
     over a hard clamp (real clipping distortion) or a blanket `1/N`
     pre-scale (needlessly quiet when sources rarely peak together) — with
     the single- or all-zero-active-source case bypassing summation/limiting
     entirely, which is what keeps the pre-existing single-embedded-track
     case byte-identical and makes "mute via `gain: 0.0`" an exact,
     checkable property, not an approximation. Pan/stereo positioning
     deliberately scoped out (mono gain scaling covers this phase's actual
     goal). `chroma-timeline` 25/25, `chroma::audio` 29/29 (new: real,
     deterministic mixing-math tests against two distinct real decoded
     files, plus live-`cpal` end-to-end 2-track tests), `chroma::` wide
     122/122, `tsc` 64/64 unchanged (no frontend touched — Phase D still
     blocked on this + Phase B). See D-057 for the full mixing-architecture
     and headroom-choice writeup.
   - **Follow-up, same day (D-058):** Phase A's own "no frontend" scoping
     left the *existing* single-track Editor UI's local edit model
     (`packages/editor/src/timeline.ts`, which `chroma_timeline_set`'s
     verbatim-storage contract makes authoritative for what a real edit
     actually persists) silently out of sync with the new `start_frame`
     field — not a Phase D (multi-track UI) task, just the pre-existing
     single-track UI needing to speak the new model correctly. Fixed;
     see D-058 / **B-012**/**B-013**. Phase D (an actual multi-track UI —
     multiple visible lanes, track headers) is still not started.
   - **Follow-up, same day (D-064):** D-058's own fix was real but the
     drag still didn't work in the *actual app* — see D-064: Tauri's
     window-level `dragDropEnabled` (on by default) was intercepting
     HTML5 drag events before the page saw them. `dragDropEnabled: false`
     in `tauri.conf.json`; confirmed by the owner dragging a real clip in
     the real window, the project's first non-proxy drag-and-drop
     confirmation.
   - ~~**Phase D — multi-track UI**~~ — **done, D-080 (2026-09-03).** B2
     (N-track compositing) confirmed first (was claimed but never actually
     exercised past 2 tracks — new 3-track test in `chroma-timeline`
     proves the walk falls through *two* consecutive gaps correctly, not
     just one). `TimelinePane.tsx` now renders one row per track (was a
     single hardcoded video row), a real custom track-header sidebar
     (kind icon, per-kind label, mute toggle writing D-057's `Track.gain`,
     remove-track), add-video/add-audio-track toolbar buttons, and a
     "Move to another track ▾" dropdown (the library has no native
     cross-row drag — checked its types before assuming otherwise; this is
     the real, working substitute, not a live drag gesture). New
     `add_track`/`remove_track`/`set_track_gain` ops in `timeline.ts`;
     `move` generalized from one `track` field to `fromTrack`/`toTrack`.
     `cargo test -p chroma-timeline` 39/39, `chroma::` 143/143 unchanged,
     `vitest` 45/45, `tsc` both packages clean/unchanged. **No live
     click-through this pass** — built while the owner was away (their own
     instruction: "work on the composition UI, don't sit idle"), and this
     session has no tool that can drive the native Tauri window; real
     interactive verification is pending the owner's next session. See
     D-080 for the full writeup, including what's deliberately not built
     yet (live drag-between-tracks, lock/solo — no backing model field).
7. ~~**Global Inspector — Motion + NLE, one shared panel, not two**~~ — owner,
   2026-09-03: reframed from "Motion property-editor GUI" once scoping
   started. Both tabs need real property controls (position/timing/text/
   camera keyframes for Motion's 7 primitives; position/scale/rotation/
   opacity/fades for Edit-tab clips), and the owner's explicit direction is
   one shared Inspector component, not a Motion-only build — referencing
   Remotion's official **Editor Starter** (remotion.dev/docs/editor-starter)
   as the section-layout target (Source/Layout/Fill/Video/Audio/Captions),
   checked and rejected as a base to build *on* (paid, ~$600 per the
   owner's own price check, and a template to adopt/customize rather than
   a component library — real rework either way), but a real reference for
   this doc's own section shape. **Verified, not assumed:** Motion's per-
   primitive props already exist (scattered across each primitive's own TS,
   the manifest schema is `.passthrough()` so nothing declares them
   centrally yet) — an Inspector here is UI + a schema-extraction pass, no
   backend blocker. **NLE's clips have zero transform fields today**
   (`chroma-timeline::Clip` — no position/scale/rotation/opacity/fade) —
   the Inspector's NLE half needs new compositor work, which is the same
   work as Phase B (specifically B3) in item 6's multi-track effort, not a
   separate track. **Full scoping doc now exists:
   `docs/notes/global-inspector.md`** (written 2026-09-03, after item 6's
   Phase D shipped) — a real 4-phase build (1: selection model + layer
   list; 2: Motion property panel; 3: NLE half, blocked on B3; 4: shared
   panel shell), plus the complete verified prop catalog for all 8
   registered primitives (not "7ish" — `text`, `emphasis`, `matrix`,
   `graph`, `layers`, `particleflow`, `labelbox`, `layerstack`, transcribed
   straight from each primitive's own inline prop type, not guessed).
   **Phase 1 done, D-081 (2026-09-03)** — `LayerList.tsx`, a real
   scene/layer sidebar in the Motion tab wired to a `Selection` model and
   seeking the `@remotion/player` preview to whatever's selected via new
   `sceneStartFrame`/`sceneDurationFrames` helpers (`build.ts`) that mirror
   `<Series>`'s own back-to-back scene layout math exactly. Real,
   standalone-useful navigation even before Phase 2's property panel
   exists. `tsc` clean on `packages/motion`/`motion-engine`/`app`
   (unchanged baseline). No dedicated test harness exists yet for either
   package (neither had one before this pass) — not set up this pass,
   flagged rather than silently skipped.
   **Phase 2 done, D-099 (2026-09-04)** — `InspectorPanel.tsx`, a real form
   bound to the layer-list selection: typed controls for every scalar field
   across all 8 primitives (`propCatalog.ts`, the real schema-extraction
   pass), a live-validated JSON fallback for array/nested content props
   (`Matrix.values`, `Graph.nodes/edges`, `Emphasis.box`), and a real
   add/remove keyframe-list editor for both 2D and 3D scene cameras.
   `manifestEdit.ts` (pure, 18 tests — `packages/motion`'s first test
   harness) reads/writes the manifest immutably and degrades gracefully
   (never throws) for a stale selection or an unrecognized `use`, the real
   backward-compatibility mechanism the owner explicitly required ("should
   also work on our current videos as well") — verified live via a
   scratch harness against `sample.ts`'s real manifest (Chrome DevTools
   automation: read every field group renders correctly populated, a
   scalar edit and a JSON-field edit both round-trip into the manifest
   including the commit-before-unmount race when switching selection
   mid-edit). `MotionTab.tsx`'s right-hand cluster is now a real
   `react-resizable-panels`-backed `PanelGroup` (`resizable.tsx` — a local
   wrapper, not `@chroma/ui`'s, due to the same `@react-three/fiber`
   JSX-typing conflict `Button.tsx` already documented), honouring the
   new "every resizable-by-nature pane must actually be resizable" rule.
   **Phase 3 (NLE half) is actually now unblocked** — Phase B3 (real
   blend modes/opacity, the compositor prerequisite this doc originally
   named) shipped as D-088 during tonight's own Full NLE P0 pass, so the
   "blocked on B3" note above is stale (checked against
   `docs/notes/multi-track-nle.md`'s own current status, not assumed).
   **Not started this pass anyway** — it requires editing
   `packages/editor/src/TimelinePane.tsx`, which another concurrent agent
   was actively deep in (D-094–D-098's dnd-kit consolidation) for the
   entire duration of this dispatch; building Phase 3 there risked a real
   file collision, so it was deliberately deferred rather than raced.
   **Real next step once that other work settles**: Phase 3, now genuinely
   unblocked. **Phase 4 (shared panel shell)** waits on Phase 3.
   **Phase 3 done, D-102 (2026-09-04)**, once the drag-and-drop work
   finished (D-100) and cleared the file — `ClipInspectorPanel.tsx`, a real
   persistent panel for the selected clip's transform (opacity/position/
   scale/rotation — `fade_in`/`fade_out` don't actually exist on `Clip`,
   this doc's own earlier field list was wrong, corrected against the real
   D-086/D-088 fields) and keyframes, added as a third pane in
   `TimelinePane.tsx`'s existing `ResizablePanelGroup`. **Real call made**:
   D-090's clip-transform popover is REMOVED, not kept alongside this panel
   — same fields/ops, a persistent panel is strictly better UX, two
   controls editing the same clip would only risk drifting out of sync.
   `Selection` stays local to `TimelinePane.tsx` for this pass (embedded,
   not lifted to a shared store) — Phase 4's "one tab-agnostic shell" is
   still the right place to unify once both halves have real content, per
   this doc's own original sequencing. Backward compatibility verified
   three ways: a scratch harness (no transform fields / a locked track /
   keyframes present, all render correctly), and — the strongest check —
   read the owner's own real `~/Movies/Chroma/New.chroma/project.json`
   directly, confirming its 9 real clips' shape matches exactly what this
   panel expects.
   **Item done — Phase 4, D-103 (2026-09-04).** Real judgment call on "how
   shared is shared": a genuinely merged, single polymorphic Inspector
   component was rejected — Motion's selection (a `Manifest` + scene/layer/
   camera target) and the NLE's (a `Clip` + track/id) are different enough
   in shape and edit ops that forcing them together would mean rewriting
   two already-working, already-tested panels for no real user-facing
   benefit. Instead: a new tiny package, **`@chroma/inspector`**, holding
   only the pieces `InspectorPanel.tsx` and `ClipInspectorPanel.tsx` had
   genuinely, independently converged on byte-identical (the "nothing
   selected" empty state, the section-heading typography) — both panels now
   import `InspectorEmptyState`/`InspectorSection` from it instead of
   duplicating that JSX. A separate package because `@chroma/motion` cannot
   depend on `@chroma/ui` at all (the `@react-three/fiber` JSX conflict
   `Button.tsx`/`resizable.tsx` already document) — so shared chrome both
   tabs use has to live somewhere neither's existing constraints block, and
   putting it in `@chroma/ui` would have been unusable from Motion's side.
   The resizable-panel wrapping was deliberately NOT unified — `@chroma/
   editor` correctly uses `@chroma/ui`'s real `ResizablePanel` (no conflict
   there), `@chroma/motion` uses its own local motion-safe wrapper; routing
   both through a third shared one would either downgrade the editor away
   from the real component it already correctly uses, or reintroduce the
   JSX conflict into Motion. `Selection` was NOT lifted to a shared,
   tab-agnostic store either — `Shell.tsx`'s own design already keeps every
   tab mounted permanently and just hides inactive ones (confirmed by
   reading it, not assumed), so a per-tab-local selection already behaves
   exactly like a cross-tab shared one from the user's side; there was no
   real gap lifting state would have closed. Verified live: both panels
   re-rendered and interacted with side by side in a scratch harness after
   the refactor (Motion layer selection + NLE clip selection both still
   populate and edit correctly, now through visually consistent shared
   section headings) — no regression in either. `tsc` clean across
   `packages/inspector`/`motion`/`editor`/`app`; 18/18 + 91/91 tests
   unchanged (a pure presentational extraction, no logic moved).
   `docs/notes/global-inspector.md` — all 4 phases now done.
8. **Unify clip identity, Edit ↔ Colorist (Resolve-shaped)** — owner,
   2026-09-03: "we have one clip we add, we can move to LUTs and color and
   we have the same clip, not multiple" (Resolve comparison), triggered by
   the owner's own live repro (a clip dragged onto the Edit tab's timeline
   didn't show up in Colorist at all). **Full scoping doc:
   `docs/notes/unified-clip-model.md`; built as D-070 in
   `docs/08-decisions.md`.** Real finding: this was a *four*-way split
   (`state::Shot`, `useSessionStore.shots`/`.grades`, `ProjectShot`,
   `chroma-timeline::Clip` — each with its own keying scheme, verified
   against real code, not assumed), not the two-list gap it first looked
   like. **Done, 2026-09-03** — `chroma-timeline::Clip` gained `media_id`
   and is the single source of truth Colorist's shot strip reads;
   `ProjectShot` retired as the persisted grading list (kept read-only, for
   the one-time grade migration to read — see D-070 for why full removal
   wasn't the right call); grades key off `Clip.id`; Colorist's active-clip
   resolution now calls D-056's `resolve_video_clip_at` (a real second call
   site, not a duplicate — `top_wins_clip_index`). One outcome the scoping
   doc didn't predict: the matching rule for the grade migration needed
   `Clip.shot_id` as a third signal alongside `media_id`/`source_path` —
   the owner's real project had a shot with a dangling `media_id` that only
   `shot_id` could still resolve correctly (see D-070's own writeup for the
   detail). Verified against a scratch copy of the owner's real
   `~/Movies/Chroma/New.chroma`: 3 shots, 0 renamed (one was already a
   no-op), 2 warned (never dragged onto the Edit tab, correctly left
   alone), nothing lost. **State::Shot's own possible retirement stays
   explicitly deferred**, as scoped — the decode session is still path-
   keyed underneath; `useSessionStore.ts` attaches clip identity on top of
   it rather than the decode session carrying it natively (see D-070's
   "known limit" note on two clips sharing one source path). **Was
   sequenced before item 6's Phase D and item 7's Inspector** — both now
   build against the real model instead of the old split.
9. ~~**Real sidecar ownership — detect a stale external AI process instead of
   deferring to it forever**~~ — **done, D-101 (2026-09-04, overnight
   autonomous pass).** All four real design questions this item raised are
   resolved: (1) `ai/server.py`'s `/health` now reports `content_sha256` (a
   truncated SHA256 of its own file bytes — zero-maintenance, no version
   string to remember to bump), and `chroma::sidecar` computes the same
   hash over its own resolved `ai/server.py` to compare; (2) **policy
   decision: refuse-and-warn only** — a mismatch is logged loudly and
   surfaced via `chroma_ai_status.stale`, never auto-killed (killing a
   process this app didn't start stays a real UI moment, not a silent
   default — an "offer to take over" affordance was deliberately not built
   this pass, an explicit follow-up); (3) `monitor_external`'s existing 10s
   poll now re-checks the hash too, not just liveness, so an externally-
   restarted sidecar's staleness state is picked up live; (4)
   `chroma_ai_status` has a real first consumer — an "AI Sidecar" status
   card in Settings (health/managed/stale/restart-count/last-error). Live-
   verified against the actual ~6-hour-stale sidecar this session had been
   running against the whole time (the exact real scenario D-069
   described) — restarted it with the new code and watched the Rust
   supervisor's periodic re-poll correctly report "no longer stale, hashes
   match" with no false positive. Real regression tests for the hash/
   comparison logic. One incident during this pass: a manual `cargo
   clippy` run collided with the dev server's own auto-rebuild-on-save
   watcher and corrupted `target/debug` (the known failure mode this
   repo's own CLAUDE.md warns about) — recovered via the documented `rm
   -rf target/debug` + rebuild, app confirmed back to a clean boot before
   continuing. See D-101 for the full writeup.

10. ~~**Gap select + delete (ripple close)**~~ — **done, D-105
    (2026-09-04).** Owner: "we should be able to delete the gap as well
    select and delete." Click empty track space to select it, Delete/
    Backspace or a new "Close Gap" toolbar button ripples everything after
    it earlier — the deliberate mirror of `remove`'s existing Lift (leaves
    a gap, no ripple). `Track::gap_at`/`Timeline::remove_gap` (Rust)
    mirror `gapAt`/`remove_gap` (TS) field-for-field, single-track only
    (see item 11). Verified against the real rendered component via a
    scratch Chrome-driven harness. See D-105.
11. ~~**Cross-track ripple / sync-lock**~~ — **done, D-107 (2026-09-04).** The
    single most-cited gap against every reference checked (Premiere's
    "ripple trailing clips in all unlocked tracks," Resolve's Sync Lock,
    Palmier's `syncLocked` track field). `Track.sync_locked` (default
    `true`), shared shift + auto-split-with-ripple-flash helpers on both
    Rust and TS, wired into every real ripple call site. The scoping doc's
    own straddling-clip question was resolved the OWNER's way, not the
    doc's first-pass recommendation: **auto-split** (Resolve's real
    behavior), not reject — see D-107 for the reasoning (reject would
    block sync-lock's own headline use case). A track-header toggle
    (`Link2`/`Unlink2`) rounds it out. 73/73 Rust + 115/115 TS tests. Real,
    disclosed gap: not verified via live interactive clicking this pass (a
    Chrome-DevTools harness attempt against the dev server couldn't clear
    the full app's Tauri-IPC boot requirements in bounded time) — the
    algorithmic core is thoroughly unit-tested, the React wiring itself is
    reviewed but not click-tested. **Correction, same day (B-033/D-109):**
    the auto-split call above was reverted within the hour after it
    corrupted a real saved project — repeated real ripple operations kept
    re-splitting an already-split fragment, something the (thorough but
    single-operation-only) test suite above never exercised. Sync-lock now
    rejects a ripple on straddle again (D-104's original contract,
    generalized cross-track) — a real feature loss versus what's described
    above, deliberate given the stakes. Auto-split is a legitimate,
    separately-scoped future follow-up, not abandoned.
12. ~~**Multi-select**~~ — **Phase 1 done, D-107 (2026-09-04).** The audit's
    own FIRST priority. `Selection` is now `{track, id}[]`; shift-click
    range-extend + cmd/ctrl-click toggle wired into `onClickAction`;
    `Remove`/`Split at playhead` generalized across the whole selection
    (grouped per track, processed in descending Vec-index order — removing/
    splitting shifts later same-track indices, so ascending order would
    target the wrong clip the second time through); `ClipInspectorPanel`/
    transform/keyframes/"Move to ▾" correctly fall back to their existing
    single-clip path via a derived `primary` for any selection size ≠ 1,
    exactly as the doc recommended. Same live-interaction verification gap
    as item 11 above — disclosed, not claimed closed. **Phase 2
    (marquee-select) and Phase 3 (multi-clip cross-track move, richer batch
    Inspector editing) remain real, deliberately deferred** — a genuinely
    new pointer gesture with real dnd-kit coexistence risk, per this
    session's own six-round history stabilizing single-clip drag
    (D-094–D-100); wait for Phase 1's own real usage first.
13. **Real A/V linking (link/unlink, L-cut/J-cut)** — today's model is
    all-or-nothing (D-050 embedded / D-057 independent, no in-between).
    **Real scoping doc now exists: `docs/notes/av-linking.md` (D-106,
    2026-09-04)** — a group-based `link_group: Option<String>` on `Clip`
    (matching `media_id`'s existing back-link pattern), `link`/`unlink` ops
    mirroring Palmier's own `manage_clip_links` exactly, real references
    checked (Premiere's two-layer link+toggle system, Palmier's own tool
    description). Flags a real prerequisite gap: this phase's scope is
    linking two already-independent clips, not "any video clip to its own
    native audio" — D-050's embedded-audio model would need to change
    first for the fuller vision, out of scope here. Recommends the simpler
    permanent-link-only interaction model over Premiere's fuller toggle,
    since nothing in Palmier's own surface confirms the toggle is needed.
    **Scoped, not built.**
14. **On-canvas clip transform — PIP drag/resize handles on the preview.**
    Owner: "the player is canvas — once I have another video I can select,
    drag and make it smaller or larger, PIP etc." Multi-layer stacking is
    real (D-088) but only editable by typing numbers into the Inspector.
    **Real scoping doc: `docs/notes/on-canvas-transform.md` (D-127,
    2026-09-04)**, references checked live (Premiere's Effect Controls ▸
    Motion handles in the Program Monitor; Resolve's viewer Transform /
    Crop / Dynamic Zoom mode selector). Recommended phasing:
    - **Phase 0 — prerequisites, both real, neither optional.** (0a)
      **B-043**: the composite's coordinate space is preview-resolution-
      dependent, so `position_x`/`position_y` and effective layer size both
      change between scrub (960px) and play (640px) — give the timeline a
      real composition space from `ProjectSettings.width`/`height` (D-038)
      and redefine positions in resolution-independent units (normalised
      recommended). **Needs an owner call** — it's a `Clip` field-semantics
      change with a saved-project migration. (0b) A drag must commit
      exactly one `set_clip_transform` op on pointer-up, not one per
      pointermove — `applyOp` pushes an undo snapshot per call (D-051).
      Same live-preview/commit-on-release split `RelightPuckLayer` (D-046)
      already uses.
    - **Phase 1 — reposition + uniform corner-scale only.** A new
      `TransformOverlay.tsx` in `@chroma/editor`, rendered as a DOM/SVG
      sibling of `PreviewPane`'s `<img>` (the preview is **not** a canvas;
      `<Player>`'s `surface` prop already takes any ReactNode, so that
      package needs no change). Reads the existing
      `useEditorTimelineStore.selection`, writes the existing
      `set_clip_transform` op — one value, two editors, exactly what both
      references do. Needs `useImageRenderSize`'s letterbox math extracted
      out of `app/src/hooks/` (D-039 forbids `packages/editor` reaching
      into the app layer) — recommend into `@chroma/player`.
    - **Phase 2 — rotation** (already a `Clip` field, mostly UI; note
      Chroma has no anchor point and both references do) **and
      non-uniform scale** (needs `scale_x`/`scale_y` replacing `scale`,
      with a migration).
    - **Phase 3 — crop as its own mode** (Resolve's shape, not extra
      behaviour on the transform box): a `crop` rect on `Clip`, applied in
      `composite_layer_onto`, a Crop row in `ClipInspectorPanel`, a mode
      toggle on the overlay. **This is where the Edit tab's missing crop
      gets built** — see D-127's finding 3.
    - **Phase 4 — keyframe interaction** (does a drag set a key when the
      clip is already keyframed?). Its own decision.
    **Scoped, not built.**
15. **Video export must honour the Colorist's geometry (crop / straighten /
    flip / 90° / lens warp)** — **B-042**. Today it refuses (D-127), which
    is honest but not the destination. Four real pieces, none of them a
    tweak: the encoder is spawned with fixed `out_w`/`out_h` before the
    frame loop; `grade_frame` builds its mask bitmaps at full frame size
    with a `(0.0, 0.0)` crop offset where the live-preview path passes a
    real `scaled_crop_offset`; D-019's tracked mattes are baked at the
    un-cropped resolution *by documented assumption*, so a crop would
    misalign them; and h.264's `yuv420p` needs even dimensions a free-form
    crop rect doesn't guarantee. Related but separate: there is still **no
    timeline export path at all** (`export_video` is Colorist's single-clip
    exporter — item 3's deferred "shell-level export"), and that's the
    other consumer a real composition space (item 14 Phase 0a) would serve.
13. ✅ **Real A/V linking — dropping a clip creates a linked audio clip
    (D-129, 2026-09-04).** The owner's own ask ("in palmier and other
    anytime i drop a clip it… created a linked track in audio"), which
    required the exact model change `docs/notes/av-linking.md` had flagged
    as a blocking prerequisite and deferred: **a video clip's embedded
    audio is now a real, separate `Clip`.** Built: `Clip.link_group`
    (group-based, `media_id`'s back-link shape); a dropped source with
    audio produces a linked pair in **one atomic `add_clip` op**, with the
    audio track found-or-created through the existing `add_track`
    mechanism (D-095/096/117), never a second one; `MediaVideoInfo::
    has_audio` (the signal D-097 flagged as missing, with a one-time
    backfill for existing pool items); `move`/`trim_start`/`trim_end`/
    `split`/`remove` all propagate across a link group or reject whole
    (`LinkDesync` — B-033's reject-rather-than-corrupt discipline);
    `unlink` dissolving the complete group, per Palmier's own semantics.
    `chroma_audio_play` skips a linked video clip's embedded stream so the
    same audio is never summed with itself. Pre-D-129 clips are unlinked
    and unchanged, with **no retroactive migration on purpose** (it would
    rewrite the owner's timeline layout unasked). Interaction model is
    `av-linking.md`'s own recommended option (b). **Deferred and named**: a
    manual `link`/relink op, Premiere's global Linked-Selection toggle +
    Option/Alt override, a ripple-insert of a pair onto a non-sync-locked
    audio track, an MCP/Tauri `unlink` command.

### Then — the deeper migration (D-039 steps 2–7, `architecture-lock.md`)

Extract the leaf pure crates for real (`chroma-types`, `chroma-grade-model`,
`chroma-timeline` — currently stubs) → `chroma-gpu`/`chroma-media`/`chroma-project` →
`chroma-agent`/`chroma-ai` → `chroma-grade` wraps `app/`, `chroma-app` goes thin →
**`chroma-compositor`** (the real multi-track engine) + `@chroma/editor` greenfield.
This is where isolated-worktree parallel subagents start making sense — each crate is
self-contained by design (see the "worktrees" discussion, 2026-09-02: file-boundary
discipline is the actual lever, not the worktree flag itself).

- ~~**Step 2 — `chroma-types` real extraction**~~ — **done, partial-by-design,
  D-053 (2026-09-03).** Audited `app/src-tauri/src/chroma/*` for real duplicates
  of resolution/rational/colour-space/time-range/error types. Real find:
  `width`/`height` field pairs (no dedicated `Resolution` struct existed, but
  four structs derived from `video::VideoInfo` all used the identical field
  names) — migrated via `#[serde(flatten)]`, a verified zero-wire-change move
  (same JSON keys before/after). `Rational` gained a `Display` impl used by
  `export.rs`'s ffmpeg fps-arg string. **Deliberately not migrated:**
  `ChromaError` (no real call site in `app/src-tauri` — its Tauri commands
  correctly use `Result<T, String>`/`anyhow`, a different layer's
  convention, not a duplicate); `ColorSpace` (still a free `String` by
  design, D-038, pending real colour management, D-004); `TimeRange` (no
  such struct exists outside `chroma-timeline`, out of scope this step);
  `ProjectSettings`/`ExportOpts`'s width/height (independently-optional
  patch/override fields — a genuinely different concept from an atomic
  `Resolution`, not forced in). Full audit + reasoning in D-053. **Next:**
  steps 3–7 (`chroma-grade-model`, `chroma-timeline` real-per-type work is
  already done per D-041/045/046; `chroma-gpu`/`chroma-media`/`chroma-project`
  remain) — see `architecture-lock.md`'s migration strategy.

---

## Later — researched, designed, deliberately not built yet

No urgency — each needs an earlier item to land first, or is a bigger bet.

- **Proxy / optimized media** — whole downscaled transcodes of source clips for
  editing, the way Premiere ("proxies") and Resolve ("optimized media") do it:
  a generate step, progress tracking, and a relink model so the timeline plays
  the proxy but exports the original. Explicitly considered and rejected as
  part of D-128, which fixed the *actual* reported problem (decoding at full
  resolution for artefacts that are 104px tall, repeatedly) without smuggling
  in a whole subsystem. Worth doing on its own terms once playback is the
  bottleneck rather than derived-artefact generation.
- **Media-cache UX: a configurable location and a "clear cache" action** —
  D-128's disk cache lives at a fixed `app_cache_dir()/chroma` with a 1 GB
  self-pruning budget. Both Premiere and Resolve let you point the cache at a
  scratch volume and clear it from the UI; on a machine whose system drive is
  nearly full, that matters. Also the documented recourse for the one case
  D-128's mtime+size cache key can't detect.
- **Persist Colorist's poster-frame strip** (`state::THUMB_CACHE`, D-033) —
  the last remaining memory-only derived-artefact cache after D-128. A
  genuinely different artefact (a much larger poster image, scoped to one
  loaded shot, busted wholesale on every shot switch), and it wasn't on the
  reported slow path — but it is the obvious next `media_cache` namespace.
- **Believable AI background replacement** — matte the tracked subject over a
  still/plate/generated BG + the integration stack (light wrap, grade match via
  `match_to_reference`, relight-to-BG via the depth-driven puck relight, defocus +
  grain match). Needs `chroma-compositor` + the relight work. v1 = static-camera only.
  `docs/notes/background-replace.md`.
- **Photoreal relight bake** — RelightVid/IC-Light diffusion in the `ai/` sidecar,
  seeded from the same puck setup, preview-one-frame-then-commit UX. v3, not before.
  The **interactive** half (deterministic depth-driven light pucks) shipped — see
  "Now" above and D-048 (mislabeled "D-046" here and in `docs/09-engine-notes.md`
  until D-054 fixed it — D-046 is actually "Media pool pass 3").
  `docs/notes/relight-research.md`.
- ~~**Interactive relight follow-ups (D-048 deferred, small)**~~ — **done, D-054
  (2026-09-03):** static single-frame depth-bake fallback for a clip with no
  depth track (parity with D-024's AI-Depth mask); `relight_depth_layer` wired
  into `export.rs`'s `mask_bitmaps` build so a positional light (not just
  ambient) survives an export; a "Preset" tab on `RelightPanel`; MCP tool
  wrapping (`mcp/server.py`) for the 4 control-server relight ops. All four
  landed in one pass — see D-054.
- **Visual understanding for the Editor tab** — temporal (Qwen3-VL, local default) +
  spatial (SAM2/YOLO, already have, just under-exposed) → natural-language footage
  search, B-roll auto-tagging, shot classification, auto-reframe hints, highlight
  detection. Needs the media pool first. First concrete task: a real local throughput
  benchmark (current numbers are extrapolated, not measured). Molmo 2 stays
  excluded from shipping (licence). `docs/notes/video-search.md`.
- **Multi-subject batch tracking** (D-017) — independent per-subject tracking already
  works; batching N objects into one SAM propagation pass is a pure perf optimization,
  niche for a single-subject talking-head grade.
- **OTIO / Palmier session import** — land a cut into a `.chroma` project (D-037).
- ProRes export round-trip verified with Palmier's `swap_clip_media`.
- **Packaging** — signed macOS build, sidecar + its Python bundled, models
  auto-downloaded (not lazy-fetched at first use, for a shipped build).
- `docs/` cleaned for external readers, a real README, a 90-second demo.
- **The three open product decisions** — name (D-010), licence (D-002, leaning AGPL),
  v1 headline feature (D-007). All shift under the 3-tab framing; not re-decided since.
- Node graph, ACES/HDR (OpenColorIO); CoTracker planar tracking + bezier roto;
  film-emulation chain; Windows/Linux + batch/headless mode; OFX plugin export (the
  gyroflow model); a public MCP contract + web review viewer.

---

## Shipped — terse history (full rationale lives in `docs/08-decisions.md`)

Chronological, one line each. This replaces the old Phase-0-through-4 / Round-1-2-3
narrative sections — that detail wasn't wrong, it was just duplicated from the decision
log and made the file unscannable.

**Phase 0–3 (pre-pivot foundation, 2026-08-31 → 2026-09-01):** repo + fork decided
(D-003) · toolchain fixed (B-001) · `render_core` Tauri seam (D-014) · video I/O via
ffmpeg CLI (D-015) · SAM2 + ViTMatte matte pipeline (D-016) · SAM2 memory-propagation
tracking (D-018) · render-time tracked matte (D-019) · control server + MCP bridge
(D-020) · scopes + `inspect_color` (D-021) · export + `.cube` bake (D-022) · mask
composition ops, not +/− points (D-023) · depth-haze preset (D-024) · `grade.json` v1
(D-025).

**Round 2 (2026-09-01→02):** `match_to_reference` auto-apply (D-026) · per-mask blur
(D-027) · Rust-managed AI sidecar (D-028) · stripped `@clerk/react` (D-029) ·
persistent decode pipe (D-030) · real-time playback ≥30fps (D-031).

**Round 3 (2026-09-02):** agent activity feed + `request_human` (D-032) · multi-shot
session + shot strip (D-033) · mask keyframes (D-034) · agent eval harness (D-035) ·
temporal depth track, Video Depth Anything (D-036).

**The 3-tab pivot (2026-09-02, D-039):** Palmier closing triggered the decision — Edit
/ Motion / Colorist, Rust-native/small-binary constraint locked, architecture designed
(`architecture-lock.md`) · de-submoduled to a monorepo (D-040) · workspace skeleton +
3-tab shell · Editor tab MVP, `chroma-timeline` made real (D-041) · UI pass (window
chrome in the shell, `@chroma/ui` started) · project launcher promoted to the app's
entry screen · `@chroma/ui` rebuilt properly on shadcn/Base UI (D-042) · project
settings — typed output spec (D-038) · **RapidRAW's DAM/welcome/library/community
shell removed from the Colorist tab** (D-043, −7,836 LOC) · **`@chroma/player`**, the
shared presentational preview component (viewport + title strip + transport), Editor
tab migrated to it — Colorist + Motion adoption still open.

**Media pool + import + multiple timelines (2026-09-02, 3 passes):** the "Sources"
replacement, closed out. Pass 1 (D-044) `ProjectManifest.media: Vec<MediaItem>`,
additive; pass 2 (D-045) bins/folders + `timelines: Vec<Timeline>` + `active_timeline`,
model + commands only; pass 3 (D-046) the actual UI — `shots`/`media` unified
(`ProjectShot` references a `MediaItem` by id, wire DTOs unchanged), a docked
Sources/Library panel (import, search, bin tree, drag-to-track) reachable from every
tab, `TimelineSwitcher`.

**Motion tab MVP (2026-09-02, D-047):** the placeholder tab is real — `@remotion/player`
live preview of `packages/motion-engine/`'s `Video` composition, a `zod`-validated
JSON-in manifest editor, Save (project-scoped sidecar
`<project>.chroma/motion/manifest.json`) and Render (new `chroma-motion` crate, Rust
orchestrates `npx remotion render` rather than reimplementing the engine). Along the
way: fixed a latent `@react-three/fiber` × `React.ElementType` typing collision
(B-008) and a duplicate-Remotion-package runtime crash (B-009, an incomplete root
`package.json` `overrides` list plus a stale lockfile baking in the wrong resolution).
Still open: a visual manifest editor, multi-manifest/scene management, render
progress/cancel, a render-output save dialog, a packaged-build story for the engine.

**Export dialog + Editor timeline audio (2026-09-03, D-049/D-050):** Export moved to
a top-right `ExportDialog` in the Colorist tab (codec/resolution/frame-range/`.cube`
bake/output path/real progress bar), backed by the existing `chroma_export_video`/
`chroma_bake_lut` (D-022) — the old still-image `ExportPanel` stays routed as a
separate, unrelated feature (its pre-existing video-brokenness is **B-010**, still
open). Editor timeline playback gained real audio — `symphonia`→`rubato`→
`dasp_sample`→`cpal`, a dedicated thread synced from the video `rAF` loop's playhead
(open-loop, no drift correction yet). Found + fixed/logged along the way: B-008
(`@react-three/fiber` × `React.ElementType` typing collision), B-009 (duplicate
Remotion packages crashing the app), B-011 (a test-isolation gap between the export
and relight test suites, logged not fixed).

**Relight goes real (2026-09-03 evening, D-077/078/079):** real surface normals via
MoGe-2 replaced depth-finite-difference fakes, 3D falloff + screen-blend compositing
replaced flat 2D additive, `distance` decoupled from direction-sweep into a proper
non-zeroing depth-mismatch multiplier — three live-tested passes fixing "light doesn't
look like light."

**Full NLE, P0 (2026-09-03 night, D-086/088/089/090):** real alpha-over multi-layer
compositor (V1/V2 actually stacked, not opaque top-wins), track lock/hide/mute/
rearrange, clip transform (position/scale/rotation/opacity) + keyframes end to end,
`chroma-timeline` gains real fields for all of it. Alongside: the Edit tab's
stuck-on-open bug fixed (D-085/B-025), sidecar model memory gets a TTL auto-unload +
`GET /memory`/`POST /unload` (D-087), React Compiler enabled for real on the v6
Rolldown-Babel toolchain (D-091), the stale `app/bench` perf harness revived and
retargeted at the Edit-tab timeline (D-092), local-only user-action telemetry wired
into `@chroma/bridge` (D-093).

**The NLE drag-and-drop saga (2026-09-03 night → 2026-09-04, D-094 through D-104,
B-026/027/028/029/030):** seven live-tested rounds chasing the owner's real-time bug
reports on the timeline UI — cross-track clip move, track reorder, ripple-insert-on-drop,
mid-stack track insertion with kind inference, an oversized drag-ghost image — first
built on raw HTML5 drag-and-drop, then twice caught passing a Chromium test harness
while failing live in the real Tauri/WKWebView window. Root-caused and fixed for real
at D-100: a stuck `pointer-events` flag was silently blocking all interaction on a
track row after an interrupted drag, and two competing drag systems (the timeline
library's native same-track drag + a new dnd-kit cross-track mechanism) were racing
for one gesture — unified onto a single `ClipBody`/`useDraggable` covering same-track
and cross-track move alike, library's own move-drag disabled, edge-trim untouched.
`docs/notes/dnd-kit-migration.md` has the real license/maintenance/StrictMode-risk
evaluation behind the library choice. **One more round after that (D-104, B-030)**:
the unified mechanism still let a cross-track drop land directly overlapping another
clip — reused the source clip's own `start_frame` verbatim instead of deriving it from
the drop, compounded by D-096's own explicit cross-track-overlap-allowed policy.
Fixed by routing every way a clip lands on a track (new from Sources, moved same-track,
moved cross-track) through one placement algorithm (`resolveClipLanding`, wrapping the
existing `computeInsertion`) — overlap is no longer a reachable outcome of a plain
drag, `ripple: true` makes room instead when landing between two touching clips. This
reverses D-096's cross-track-overlap-allowed policy outright, per the owner's explicit,
absolute direction.

**Global Inspector, all 4 phases (2026-09-04 early morning, D-081/D-099/D-102/D-103):**
a real typed property panel for Motion's 8 primitives (`InspectorPanel.tsx`/
`propCatalog.ts`, bound to D-081's selection model) and a persistent NLE
clip-properties panel (`ClipInspectorPanel.tsx`, replacing D-090's transform popover
outright) — both verified against real backward-compat cases, the NLE half against the
owner's actual `~/Movies/Chroma/New.chroma/project.json`. **Phase 4** unified the two
panels' shared, genuinely-identical chrome (the empty-state message, section-heading
typography) into a new tiny package, `@chroma/inspector` — not a full merge: the two
panels' selections/fields/edit ops stayed different enough that forcing one polymorphic
component would have meant rewriting working code for no benefit, and the resizable-
panel wrapping stayed package-local since `@chroma/editor`'s real `@chroma/ui`
`ResizablePanel` and `@chroma/motion`'s motion-safe local one aren't interchangeable
(the `@react-three/fiber` JSX conflict). `Selection` stayed local per tab — `Shell.tsx`
already keeps every tab mounted and just hides inactive ones, so there was no real
cross-tab gap to close by lifting state.

**Gap select + delete, and a real timeline-feature research audit (2026-09-04 morning,
D-105):** owner pushback on the whole night's one-off-bug-report pattern — "can you not
do a Research and get all the cases for timeline instead of me telling you." Built the
concrete feature asked for (`Track::gap_at`/`Timeline::remove_gap`, TS-mirrored,
`selectedGap` a new parallel state alongside `Selection` — click empty track space,
Delete/Backspace or a "Close Gap" button ripples everything after it earlier, the
deliberate mirror of `remove`'s existing Lift), verified against the real rendered
component via a scratch Chrome-driven harness (not just the 67/108 new Rust/TS unit
tests). Also `docs/notes/timeline-feature-audit.md` — the real feature set audited
against Premiere Pro's and DaVinci Resolve's own official docs plus Palmier Pro's real
MCP tool surface (this repo's own stated feature bar), not memory. Real prioritized
recommendation: **multi-select first** (blocks the most, blocks nothing else), **cross-
track ripple/sync-lock second** (the single most-cited gap against every reference —
today's ripple, including this pass's own `remove_gap`, is single-track only), **real
A/V linking third**; speed/remap, transitions, native markers, a snap toggle,
volume/crop/blur keyframing, copy/paste, and an effects stack are real but independent
and lower-urgency; multicam flagged as out of scope for this product entirely.

**Real sidecar ownership (2026-09-04 early morning, D-101):** content-hash staleness
detection (`ai/server.py`'s own bytes, SHA256) replacing "trust the first `/health`
response forever" — refuse-and-warn policy, a live 10s re-poll, a real "AI Sidecar"
Settings card as `chroma_ai_status`'s first UI consumer. Live-verified against the
session's own genuinely ~6-hour-stale sidecar.

**Deliberately deferred, not abandoned:** the deeper crate-extraction migration
(`chroma-gpu`/`chroma-media`/`chroma-project`, eventually `chroma-compositor`) — the
roadmap's own "Then" section already flags it as a bigger, no-urgency structural bet
best done with isolated worktrees once underway, not rushed through in the same
overnight pass as everything above.

**Deferred, not abandoned:** multi-subject batch tracking (D-017, → Later).

---

## Risks & how we de-risk

| Risk | Mitigation |
|---|---|
| The multi-track compositor (the Editor's long pole) is harder than estimated | it's the first thing in "Then — the deeper migration"; scoped small first (2–3 layers + a dissolve) before generalizing |
| Solo-dev + session rate limits slow the pace | the docs discipline (this file + `08-decisions.md`) means no re-derivation cost across sessions; subagents checkpoint-commit rather than lose work on failure |
| Speed accrues cleanup debt | `CLAUDE.md`'s "Standards — no shortcuts" hard rule exists specifically for this; verify before reporting done, every time |
| AGPL blocks a direction wanted later | decide licence intent explicitly when D-002 is picked up; AGPL is fine for "open project," accept the SaaS limitation |
| The "open + local + agentic" window keeps narrowing (competitors emerging weekly) | the defensible wedge is colour-science depth + Rust-native perf, not the category label — see `product-direction.md` §7 |

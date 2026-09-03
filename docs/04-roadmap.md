# 04 — Roadmap

Reorganized 2026-09-02 (was pure chronological append — unreadable after 40+ decisions).
**Now / Next / Later / Shipped**, not phases. Full rationale for any `D-NNN` lives in
`docs/08-decisions.md` — this file tracks *state*, not the reasoning; don't duplicate
prose here that already exists there. Timelines are rough solo-dev-with-Claude
estimates, not commitments (see `docs/notes/product-direction.md` §5 for how those
numbers are actually calibrated).

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
  clip, ripple-shift flash, an **adaptive-density real-timecode ruler**
  (D-058). Clip **position is a real, explicit `start_frame` the frontend
  edit model now actually maintains** (D-058, closing a gap D-054's backend
  model had opened) — drag-from-Sources and edge-trim were both silently
  broken by that gap until the owner's live testing caught it and this pass
  fixed it (**B-012**/**B-013**) — though D-058's own fix alone still wasn't
  the whole story: drag-and-drop stayed dead in the *real* app until
  **D-064** found Tauri's own `dragDropEnabled` (on by default, intercepting
  HTML5 drag before the page saw it) — the actual last piece, confirmed by
  the owner dragging a real clip in the real window. Edge-trim now has a
  real `ew-resize` cursor + hover affordance (D-061; the library never
  styled this). No multi-track or transcript cut yet.
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
  — D-060/D-061), `@chroma/ui` (shadcn/Base UI, 18 components, themed).
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
7. **Global Inspector — Motion + NLE, one shared panel, not two** — owner,
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
   panel expects. **Phase 4 (shared panel shell) is next**, unblocked, both
   halves now have real content to unify.
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

**The NLE drag-and-drop saga (2026-09-03 night → 2026-09-04, D-094 through D-100,
B-026/027/028/029):** six live-tested rounds chasing the owner's real-time bug reports
on the timeline UI — cross-track clip move, track reorder, ripple-insert-on-drop,
mid-stack track insertion with kind inference, an oversized drag-ghost image — first
built on raw HTML5 drag-and-drop, then twice caught passing a Chromium test harness
while failing live in the real Tauri/WKWebView window. Root-caused and fixed for real
in the end (D-100): a stuck `pointer-events` flag was silently blocking all
interaction on a track row after an interrupted drag, and two competing drag systems
(the timeline library's native same-track drag + a new dnd-kit cross-track mechanism)
were racing for one gesture — unified onto a single `ClipBody`/`useDraggable` covering
same-track and cross-track move alike, library's own move-drag disabled, edge-trim
untouched. `docs/notes/dnd-kit-migration.md` has the real license/maintenance/
StrictMode-risk evaluation behind the library choice.

**Global Inspector, both halves (2026-09-04 early morning, D-099/D-102):** a real
typed property panel for Motion's 8 primitives (`InspectorPanel.tsx`/`propCatalog.ts`,
bound to D-081's selection model) and a persistent NLE clip-properties panel
(`ClipInspectorPanel.tsx`, replacing D-090's transform popover outright) — both
verified against real backward-compat cases, the NLE half against the owner's actual
`~/Movies/Chroma/New.chroma/project.json`. Phase 4 (one shared, tab-agnostic panel
shell) is the remaining piece, unblocked.

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

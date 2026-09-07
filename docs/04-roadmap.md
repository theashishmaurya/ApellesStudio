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
  on export is queue item 15. **Edit-tab crop itself now exists — D-132**, see
  the second-round bullet below.
- ✅ **On-canvas PIP transform (drag/resize the overlaid clip in the
  preview) — D-136, 2026-09-04.** `docs/notes/on-canvas-transform.md`,
  queue item 14. The preview is a plain `<img>` fed a backend-composited
  JPEG, not a canvas, so handles are a DOM overlay (`TransformOverlay.tsx`)
  with no cheap live re-render of the picture mid-drag — only the overlay's
  own box moves live, the composited picture catches up on commit. **B-043
  closed**: the composite's coordinate space is now the project's own
  composition (`ProjectSettings.width`/`height`), not the preview's decode
  scale, so a PIP overlay no longer moves or resizes when you press Play.
  Existing pixel-valued positions are migrated via a real schema-minor gate
  on `chroma.project`, not silently reinterpreted. Phases 0 and 1 (the
  handles themselves — select, drag, uniform corner-scale) are built; Phase
  2 (rotation, non-uniform scale) is untouched; Phase 3 (crop) is built,
  minus its own on-canvas mode. **Clicking the picture itself to select a
  clip — the note's own Open Question 3, and the one thing that made those
  handles reachable only via the timeline — is now built too: D-204,
  2026-09-07, fixing B-085.**
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

### Second round (2026-09-04 evening) — after D-124–D-130 landed and the app restarted

- ✅ **B-049 — filmstrip zoom in/out is slow to recompute**, even though load
  and scroll are now fast (confirmed by the owner: "very fast now" for
  everything except the zoom action itself) — done, **D-134**. The suspected
  cause was right and understated: a zoom-triggered `level` change is
  cache-cold for the *whole viewport at once*, and D-128 decoded those chunks
  one at a time. Since a fine chunk costs the same to decode at any fine
  spacing (measured — ~0.8s of ffmpeg spawn plus ~0.24s per second of source,
  independent of tile count), every fine level is now decoded once at the
  finest rung and decimated down; a request's chunks load concurrently; a
  coarse chunk derives free from cached finer ones. **A fine-band zoom sweep
  over an already-decoded range: 31.3s → 0.001s.** **B-055** (a window
  overrunning the source lost its *whole* filmstrip, not just the
  out-of-range tail) found and fixed alongside.
- ✅ **B-050 — Player's seek bar and volume slider are effectively invisible.**
  Not a token issue — `slider.tsx`'s Track/Indicator used the Tailwind
  shorthand `data-horizontal:`/`data-vertical:`, which checks for a literal
  `[data-horizontal]` attribute Base UI never sets (it stamps
  `data-orientation="horizontal"`); fixed to `data-[orientation=...]:`. D-131.
- ✅ **B-051 — Sources toggle still sits on top of "Timeline" title text.**
  D-126 fixed legibility (opaque chip) but not position; `Player.tsx`'s title
  strip now reserves `pl-10` to clear the toggle's real 32px footprint. D-131.
- ~~🔲 **B-052 — Play/Pause restarts just the audio**, even with a real D-129
  linked audio track on the timeline. Not yet clear if this is D-130
  incomplete or expected per-Play-session behavior being misread.~~ ✅ **D-133**
  — neither. Audio was starting at 0:00 of the source on *every* Play, because
  `symphonia`'s seek fails outright on the owner's camera original (a 0.042 s
  metadata track poisons the whole seek) and the failure was being thrown away.
  Sources now land on the requested time by packet timestamp.
- ✅ **No on-canvas crop/transform UI on the Edit-tab preview** — the owner
  asked live ("no UI for crop", "no canvas on player to do it").
  **Crop done, D-132; transform handles done, D-136.** The *crop* half is
  real: `Clip.crop_left`/`crop_top`/`crop_right`/`crop_bottom` (normalised
  0–1 insets into the clip's own source), really applied by the Edit-tab
  compositor, with a real Crop section in the Inspector alongside
  Transform, keyframeable through the existing engine. The *on-canvas
  transform* half — select, drag to reposition, drag a corner to
  uniform-scale — is now real too (`TransformOverlay.tsx`, D-136); the
  Resolve-style Transform/Crop mode toggle and on-canvas crop-edge handles
  specifically are still **not built** (crop rides the same bounding box
  Phase 1 draws, but has no edge handles of its own yet). Also fixed on the
  way: **B-053**, a lone clip's transform was silently discarded by the
  preview's single-layer fast path, which would have made crop look broken
  on the most obvious test case. Phase 0a's unit question is answered
  (D-132) and its code — the composition-space canvas and the
  `position_*` migration — is built (D-136); **B-043 closed**.
- ✅ **Video export must honour the Colorist's geometry** — done, **D-135**.
  All four pieces from the scoping above landed: `grade_frame` runs the same
  CPU geometry pre-pass the preview does, the encoder is sized lazily from
  the first graded frame instead of a stale pre-computed `out_w`/`out_h`,
  mask bitmaps build at the transformed size with the real crop offset
  (D-019's tracked-matte assumption needed no change, only a corrected
  parenthetical), and h.264's even-dimension requirement is a stated
  round-down-by-2 rule. **B-042 closed**; D-127's `unsupported_geometry`
  refusal is deleted — the only remaining refusal is a crop rounding to
  zero in either axis.

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
  button). **A clip's compositing box can now be sized independently per axis**
  (D-193 — Width/Height fields in pixels with a ratio-lock toggle, alongside the
  existing uniform `Scale`; persisted as `Clip.box_width`/`box_height`, a
  canvas-fraction override with no Rust/TS export-parity gap, unlike `scale`
  itself). No multi-track or transcript cut yet.
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
12. ~~**Multi-select**~~ — **Phases 1 and 2 done (D-107, 2026-09-04; D-137,
    2026-09-05). Phase 3 still deferred.** The audit's
    own FIRST priority. `Selection` is now `{track, id}[]`; shift-click
    range-extend + cmd/ctrl-click toggle wired into `onClickAction`;
    `Remove`/`Split at playhead` generalized across the whole selection
    (grouped per track, processed in descending Vec-index order — removing/
    splitting shifts later same-track indices, so ascending order would
    target the wrong clip the second time through); `ClipInspectorPanel`/
    transform/keyframes/"Move to ▾" correctly fall back to their existing
    single-clip path via a derived `primary` for any selection size ≠ 1,
    exactly as the doc recommended. Same live-interaction verification gap
    as item 11 above — disclosed, not claimed closed.
    - **Phase 2 — marquee-select — ✅ BUILT (D-137, 2026-09-05).** Click-drag
      on empty timeline canvas rubber-bands a selection; every clip whose
      bounding box the rect intersects is selected, and shift/cmd/ctrl held at
      press time unions onto the existing selection instead of replacing it.
      The deferral's own stated reason was the dnd-kit coexistence risk, and
      that is what the entry is mostly about: the marquee and the clip drag are
      mutually exclusive **by DOM position** — `ClipBody` (the one
      `useDraggable` node in the edit area) carries `data-chroma-clip-drag`,
      and the gesture refuses any `pointerdown` with that on its propagation
      path, which is the same condition dnd-kit's own `PointerSensor` uses to
      decide whether it runs. No precedence, no `stopPropagation`, no
      who-wins flag. The activation threshold reuses the `PointerSensor`'s own
      `distance: 4` rather than inventing a second one. All the decision logic
      is pure and unit-tested (`marquee.ts`, 36 tests); the gesture itself was
      driven with real `PointerEvent`s against the real component under real
      `<StrictMode>` in a browser (13 scenarios — including that same-track
      and cross-track clip drag AND track reorder all still work and never
      raise a band), which caught one real bug (Escape wiped the pre-existing
      selection via the terminating click) before it shipped. Still not the
      real Tauri/WKWebView window — disclosed in D-137, not claimed closed.
      **D-142 (2026-09-05) made that verification permanent**: a reusable
      `testUtils/pointerHarness.ts` plus a real-DOM jsdom regression test
      (`TimelinePane.marquee.dom.test.tsx`, 9 scenarios, runs on every `npm
      test`) replace the scratch-and-delete browser session this entry
      originally described, and `app/harness.html` (also now permanent) is
      the same real-Chromium tier for whatever this jsdom tier still can't
      check (dnd-kit's own rect-based drop-target resolution).
    - **Phase 3 — multi-clip cross-track move, richer batch Inspector
      editing — still real, still deliberately deferred.** Wait for Phases 1
      and 2's own real usage first.
13. ✅ **Real A/V linking (link/unlink, L-cut/J-cut)** — **stale duplicate
    entry, corrected in place (D-138) rather than left wrong**: this
    paragraph originally scoped the feature and ended "Scoped, not built,"
    but was never updated when the work actually shipped in two later
    passes and got its own, separately-numbered "13. ✅" entry further down
    this same list (now updated by D-138 too) — a real doc-drift bug this
    pass fixes rather than perpetuates. `docs/notes/av-linking.md` (D-106)
    is the scoping doc referenced here; **both halves it scoped are now
    built**: the auto-link-on-drop model (D-129) and the manual `link`/
    `unlink` toggle (D-138) — see the fuller "13. ✅" entry below for what
    actually shipped. The simpler permanent-link-only interaction model
    (over Premiere's fuller toggle) this paragraph recommended was the
    call D-129 made and D-138 re-confirmed, not reopened.
14. ✅ **On-canvas clip transform — PIP drag/resize handles on the preview
    (D-136, 2026-09-04).**
    Owner: "the player is canvas — once I have another video I can select,
    drag and make it smaller or larger, PIP etc." Multi-layer stacking is
    real (D-088); the owner's literal ask — select a clip, drag it, make it
    smaller or larger — is **now real too**. **Real scoping doc:
    `docs/notes/on-canvas-transform.md` (D-127, 2026-09-04)**, references
    checked live (Premiere's Effect Controls ▸ Motion handles in the Program
    Monitor; Resolve's viewer Transform / Crop / Dynamic Zoom mode
    selector). Phasing, and what actually landed:
    - **Phase 0 — prerequisites, both real, neither optional — ✅ BUILT.**
      (0a) **B-043 closed.** The composite's coordinate space *was*
      preview-resolution-dependent — `position_x`/`position_y` and
      effective layer size both changed between scrub (960px) and play
      (640px). The timeline now has a real composition space
      (`ProjectSettings.width`/`height`, D-038, or the first clip's probed
      resolution as fallback); `composite_video_frame`'s canvas IS that
      composition, not the top layer's decode; `position_x`/`position_y`
      are normalised fractions of it (D-132's unit call, now actually
      built). **Existing pixel-valued positions are migrated**, not
      silently reinterpreted — `chroma.project`'s schema gained a minor
      (`1.1`) gating a one-time, non-idempotent reinterpretation of old
      values as composition pixels, applied on load and restamped so it
      never runs twice on the same file. See D-136. (0b) A drag commits
      exactly one `set_clip_transform` op on pointer-up, not one per
      pointermove — the same live-preview/commit-on-release split
      `RelightPuckLayer` (D-046) already uses, now actually implemented in
      `TransformOverlay.tsx` (Phase 1, below).
    - **Phase 1 — reposition + uniform corner-scale only — ✅ BUILT
      (D-136).** `TransformOverlay.tsx` in `@chroma/editor`, a DOM overlay
      rendered as a sibling of `PreviewPane`'s `<img>` (the preview is
      **not** a canvas; `<Player>`'s `surface` prop took any ReactNode
      already, so that package needed no change beyond a new
      `useContentBox` export). Reads the existing
      `useEditorTimelineStore.selection`, writes the existing
      `set_clip_transform` op — one value, two editors, exactly what both
      references do. A new `chroma_timeline_clip_geometry` Tauri command
      reports the one thing the frontend genuinely couldn't derive (a
      clip's own source resolution against the composition); the actual
      box/drag/corner-scale math is pure and unit-tested
      (`transformGeometry.ts`, 16 tests). `useImageRenderSize`'s letterbox
      math was extracted into `@chroma/player` as `useContentBox` — the
      original stays in place, still owning every Colorist-tab call site;
      migrating those is separate, deliberately deferred work.
    - **Phase 2 — rotation** (already a `Clip` field, mostly UI; note
      Chroma has no anchor point and both references do) **and
      non-uniform scale** (needs `scale_x`/`scale_y` replacing `scale`,
      with a migration). **Still scoped, not built.**
    - **Phase 3 — crop — ✅ BUILT (D-132, 2026-09-04), except its
      on-canvas mode.** Four normalised (0–1) edge insets on `Clip`
      (`crop_left`/`crop_top`/`crop_right`/`crop_bottom`, relative to the
      clip's OWN source — flat scalars so the D-034 keyframe engine can
      interpolate them, insets because that is what both references
      expose), really applied by `composite_layer_onto` (crop first, and
      **in place** — alpha cleared, footprint kept, so the picture doesn't
      re-centre and rotation keeps its pivot), a real Crop section in
      `ClipInspectorPanel`, riding the existing `set_clip_transform` op.
      **The Resolve-style mode toggle and on-canvas crop handles are still
      NOT built** — Phase 1's overlay now exists, but crop rides the same
      bounding box (unaffected by crop, since `composite_layer_onto` crops
      a layer's pixels in place without shrinking its footprint) rather
      than getting its own edge handles yet.
      Fixed on the way: **B-053** (the single-layer preview path discarded
      a lone clip's whole transform).
    - **Phase 4 — keyframe interaction** (does a drag set a key when the
      clip is already keyframed?). **Half-answered by D-205 (2026-09-08),
      for the INSPECTOR only:** every Transform/Crop field now has its own
      per-property stopwatch diamond + `<`/`>` key nav + reset, and typing
      into an already-animated field keys that value at the playhead rather
      than writing the static field (the standard NLE auto-keyframe-on-edit).
      That settles the *semantics* question this phase was really about —
      "an edit to an animated property lands on its keyframe" — and leaves
      only the ON-CANVAS half open: whether a `TransformOverlay` drag should
      do the same. Fixed on the way: **B-092** (the Rust live-preview
      resolver could not actually interpolate per-property keyframes; it
      held them into a step function). **B-093 filed, not fixed** — the
      ffmpeg export compiler ignores `opacity`/`rotation` entirely, so those
      two of the nine now-keyframeable properties animate in the preview but
      not in an exported file.
    **Phases 0, 1 and 3 built; Phase 2 (rotation/non-uniform scale) still
    scoped, not built; Phase 4's Inspector half built (D-205), its
    auto-keyframe-on-canvas-drag half still open.**
15. ✅ **Video export honours the Colorist's geometry — crop / straighten /
    flip / 90° / lens warp (D-135, 2026-09-04).** **B-042 closed**;
    D-127's `unsupported_geometry` refusal is deleted. All four scoped
    pieces landed. (1) `grade_frame` runs
    `adjustment_utils::apply_all_transformations` — the *same* pre-pass the
    live preview and the still export run, not a second copy of it —
    still zero-copy at identity, including the full-frame crop rect the
    Crop panel writes on open. (2) Mask bitmaps are built at the
    **transformed** size with the **real** crop offset (and the two
    relight resolvers, which carried the same hardcoded `(0.0, 0.0)`);
    `EXPORT_MASK_SCALE = 1.0` is the preview's `effective_scale` collapsed
    for a full-res render, which is *why* the two paths now agree. (3) The
    encoder is spawned **lazily, from the first graded frame's measured
    size**, so a crop or a 90° step really changes the encoded dimensions
    and the number ffmpeg is told cannot drift from the pass that produced
    it; the dead in-loop dimension check becomes a live "every frame must
    transform to the same size" invariant. (4) D-019's tracked mattes
    needed **no** change — `generate_ai_bitmap_from_full_mask` already
    un-does crop/rotation/flip against a full-resolution matte, so passing
    the real offset *is* the fix (D-019's parenthetical corrected in
    place). (5) The `yuv420p` even-dimension requirement is a stated rule:
    round the encoder size **down** to a multiple of 2 for every codec,
    trimming ≤1 row/column with `crop_imm` rather than padding or
    resampling (ffmpeg's own `trunc(iw/2)*2`, HandBrake's modulus-2;
    Premiere/Resolve never hit the case because their crop is a filter
    inside a fixed sequence resolution). Also fixed on the way past: an
    odd custom export resolution reaching libx264 (D-049), the **lens
    blur**, and parametric **`color`/`luminance` masks**, all dropped by
    the same original omission. **Still refused, and only this:** a crop
    that rounds to zero in either axis. **Still separate and still open:**
    there is **no timeline export path at all** (`export_video` remains
    Colorist's single-clip exporter — item 3's deferred "shell-level
    export"), and that's the other consumer a real composition space
    (item 14 Phase 0a) would serve.
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
    `av-linking.md`'s own recommended option (b), re-confirmed rather than
    reopened by D-138 below.
    **Manual link/unlink toggle also shipped (D-138, 2026-09-05).** The
    owner's own follow-up ask, closing the two items D-129 named and dated:
    `Timeline::link` — a new op, deliberately narrower than Palmier's own
    group-merging `link` (requires both clips to currently be unlinked,
    one video-track + one audio-track, order-independent, deterministic
    `lg-{video_id}-{audio_id}` group id) — plus `Timeline::unlink` finally
    exposed as real Tauri commands (`chroma_timeline_link_clips`/
    `_unlink_clip`, `app/src-tauri/src/chroma/edit.rs`), and real toolbar
    UI in `TimelinePane.tsx` (a `Link` button, shown for a two-clip
    selection and disabled-with-reason when the pair isn't linkable; the
    existing `Unlink` button unchanged). The already-shipped `avLinkedIds`
    highlight needed no changes — it re-derives from `link_group` live.
    **Deferred and named, still**: relink-as-its-own-concept (covered by
    plain `link` on the now-independent pair, so never actually needed),
    Palmier's fuller group-merge `link`, Premiere's global Linked-Selection
    toggle + Option/Alt override (re-confirmed out of scope, not just
    carried forward unexamined), a ripple-insert of a pair onto a
    non-sync-locked audio track.

16. **Motion tab — a real authoring model** — owner, 2026-09-05: *"motion is not
    loaded lets now work on out motion thingy, [m]ap out where we lag, have a
    Catalog Section where all our built catalog is there which we can get on our
    current thing."* **A new item rather than an addendum to item 7**, argued:
    item 7 (Global Inspector) is finished and struck through, and burying a live
    workstream inside a closed item hides it; the Motion tab has never had a
    dedicated roadmap item the way Edit-tab multi-track has item 6, and that
    absence is itself part of what "where we lag" turned out to mean. Full audit
    against the Edit tab, every claim cited to a real file/line or a named grep:
    **`docs/notes/motion-tab-audit.md`** (2026-09-05).
    Real finding, and the reason the Catalog was asked for: **the tab could edit
    everything and create nothing** — no `addLayer`/`addScene` existed anywhere
    (grep: 0 hits), so every new layer meant hand-typing JSON, including `use`
    strings and per-primitive required props the UI never listed. Also confirmed
    **no dead primitives** (all 8 wired in schema + registry + a demo each) and
    turned up **B-059** (the engine supports per-camera-key bezier `ease`; the
    schema silently strips it) while fact-checking a wrong draft claim.
    The audit's own priority order, which is this item's queue:
    - ~~**1. A creation path — the Catalog + `addLayer`**~~ — **done, D-151
      (2026-09-05).** `catalog.ts` (exhaustive against the engine's zod enum via
      `Record<Layer['use'], …>`, so a new primitive is a `tsc` error until it is
      catalogued) + `addLayer` in `manifestEdit.ts` (immutable, 3D primitives
      routed into `scene3d.children` with the container created when absent,
      returns the `Selection` so the Inspector opens on the new layer) +
      `CatalogPanel.tsx`, a second tab in the sidebar pane. 18 → 57 tests,
      fragments validated against the real `manifestSchema` and mutation-checked.
      Glyphs rather than live thumbnails — argued in D-151, not conceded: three
      of the eight primitives need a live WebGL context each. **Not verified in
      the real Tauri window** (sandboxed worktree) — an honest gap.
    - **2. On-canvas manipulation** — the next thing a user reaches for once
      layers can be created; typing `x: 180` into a number field is the sharpest
      remaining friction. Needs a composition-coords ↔ screen-coords mapping over
      `MotionPreview`'s `<Player>`, then drag → `setLayerField('x'|'y')`. D-136
      solved the analogous Edit-tab problem and is the reference.
    - **3. A Motion MCP surface** — the AI-native gap, and the sharpest one:
      `mcp/server.py` has 45 tools and **zero** touch Motion, so it is the one tab
      an agent cannot use at all. Cheap now that D-151's ops exist —
      `get_manifest`/`add_layer`/`set_layer_field`/`render_manifest` wrap tested
      pure functions instead of reimplementing manifest surgery in Python.
    - **4. Undo/redo for Motion** — D-052 deferred it for a real reason ("no
      natural edit-history unit"); with `addLayer`/`setLayerField` as discrete
      named immutable ops that unit now exists. Push before/after `Manifest`
      snapshots into `@chroma/history`, as `useEditorTimelineStore.applyOp` does.
    - **5. A scene/layer timeline UI** — the biggest visible gap vs. both After
      Effects and this repo's own Edit tab, and the largest build. After #2, so it
      can reuse those drag mechanics rather than inventing a second set.
    - **6. Lower-urgency, mutually independent** — multi-select, delete/duplicate,
      multi-manifest per project (D-046's deliberate one-per-project limit; wait
      for a real need), and **B-059**'s camera easing, which is nearly free.
17. **Show the export's real start/end bound in the Edit-tab timeline UI** — owner,
    2026-09-07, live, after B-076 (D-187): `editor_export` renders the WHOLE
    timeline only up to the furthest clip's own end (`-t <that>` — the `color=[base]`
    backdrop has no natural end of its own, so before B-076 an export literally never
    stopped on its own). That real boundary — "this is where the render will actually
    end" — isn't shown anywhere in `TimelinePane.tsx` today; a human editing has no
    visual cue for it (an agent calling `editor_get_timeline` can compute it from
    `trackDuration`/`timelineDuration`, but the GUI shows nothing). Add a real
    start/end marker (at minimum the end — start is always 0 today, nothing trims the
    front of the whole timeline yet) to the timeline ruler, matching how a reference
    NLE marks its own sequence out-point. Not started.
18. ✅ **No visible output-canvas/aspect-ratio frame in the Edit-tab preview, and no way
    to set it from the UI** — done, **D-199** (`docs/notes/preview-canvas-boundary.md`).
    `CanvasBoundary.tsx` (a selection-independent third sibling in `PreviewPane.tsx`'s
    overlay stack) + `CanvasSettingsPopover.tsx` (reads/writes `ProjectSettings.width`/
    `height` via a new `chroma_project_get_settings` alongside the existing
    `chroma_project_set_settings`). Root-caused first, not assumed: the actual
    compositor was verified correct (a real two-track red/blue stacking test through
    the unmodified `timeline_frame` production path) — the report's real causes were
    (1) **B-079** (same session, fixed in D-200 — a mixed-native-fps clip could drop
    out of the live composite entirely) and (2) this item's own gap, no boundary/
    settings surface to notice or diagnose either. Live-verified in a real Chromium
    tab (D-142 harness, extended to mount `PreviewPane`): boundary renders, settings
    popover's full round trip works, aspect ratio genuinely reshapes on save.
    Drag-to-rearrange (uniform move/resize, D-136) verified still working alongside
    the new overlay, unmodified. Owner, 2026-09-07, live, after seeing the reel's own
    live preview render the AFTER clip full-bleed (native aspect, no visible 9:16
    frame boundary) instead of composited/stacked with BEFORE at all: *"in the UI
    also we have no visual 9:16 ratio for the working canvas we want that — we
    should be able to change the canvas and it should be in the preview."* Two real
    gaps: (1) nothing in the live preview draws the actual OUTPUT COMPOSITION's own
    frame/aspect boundary (the thing `position_x`/`position_y`/`scale` are fractions
    OF, per D-136) so a human has no visual reference for where clips will actually
    land; (2) there's no project/canvas settings control to CHOOSE that aspect ratio
    (9:16, 16:9, 1:1, custom) at all — `editor_export`'s `width`/`height` are
    export-call parameters today, not a project-level setting the GUI reads back for
    its own preview.
    **Checked against the D-193 independent-width/height ratio-lock work (now landed)
    — NOT the same root cause, and not a hard prerequisite for it, but a real,
    related gap D-193 does not close.** D-193's Inspector Width/Height fields
    correctly read the composition's REAL pixel size via the existing
    `chroma_timeline_clip_geometry` command (`ProjectSettings.width`/`height`, D-038 —
    the backend concept behind "the composition" already exists and is what D-193's
    math is built against), so the NUMBERS D-193 shows/writes are correct regardless
    of this item. What's still missing is purely presentational/UI: (1) needs a new
    `PreviewPane.tsx` overlay component drawing the composition's own boundary (a
    letterbox/pillarbox frame), independent of any single clip's transform — a
    sibling to `TransformOverlay.tsx`, not a change to it; (2) needs a real Edit-tab
    settings surface to read/write `ProjectSettings.width`/`height` after project
    creation (today's likely-only entry point), which is unrelated to `Clip`-level
    fields entirely. Neither touches `Clip.box_width`/`box_height`/`scale` or the
    Rust/TS export parity story D-193's own decision entry covers. **Done — see the
    ✅ line above.**
19. ✅ **B-079 — bring `crates/chroma-timeline`'s live playback/preview/audio-decode
    methods up to the same fps-aware standard B-077/D-194 gave the GUI/MCP edit
    model.** Done, **D-200** (same session as item 18, found to be a real,
    well-evidenced contributing cause of that item's own "AFTER full-bleed" report).
    `Track::clip_at` (the video-preview decode AND audio-clip-at-playhead
    lookup), `clip_spans_from` (duck-envelope triggers), `Track::duration` (the
    timeline-switcher display), and two inline reimplementations in
    `chroma::audio.rs` all still add `start_frame`/`pos` to `duration`/`source_start`
    with no `source_fps` conversion — found live during the B-077 audit, confirmed
    reachable (unlike the crate's own `trim_start`/`trim_end`/`split`/`move_clip`,
    which are dead code today). Fixed the same way B-077/D-194 fixed the TS side:
    `Timeline::fps()` + `source_frames_to_timeline`/`timeline_frames_to_source`,
    threaded into `Track::duration`/`clip_at`/`clip_spans_from` and every real
    caller; `packages/editor/src/clipKeyframes.ts::clipSourceFrame` fixed in the
    SAME change per its own doc comment. `cargo test -p chroma-timeline` 137/137
    (+8), `cargo test -p RapidRAW --lib` 146/146, `cargo test -p chroma-project`
    52/52, clippy/fmt clean on touched code. See `docs/BUGS.md`'s B-079 entry and D-200.
20. **Timeline-editing feature gaps vs. a comparable competitor** — owner, 2026-09-07,
    pointed at a competitor's own docs for comparison. Full writeup:
    `docs/notes/timeline-editing-feature-gap-analysis.md`. ~~Slip editing~~ and
    ~~media swapping~~ **done (D-195, 2026-09-07)** — new `slip`/`swap_media`
    `EditOp`s + `editor_slip_clip`/`editor_swap_clip_media` MCP tools. Remaining
    real, confirmed-missing primitives: blur as a keyframeable param, audio volume
    keyframes within a clip, markers (point & range), nested timelines (compound
    clips), a Timeline Index panel (transcript/caption text-navigation — the
    underlying data now exists via D-189/D-190, just merged), canvas guides
    (grid/safe-zone overlays, broader than the plain canvas-boundary work in item 18),
    frame capture (export the current composite as a still). ~~"Multiple
    timelines"~~ — the gap note's other open question — **verified WORKING**
    (D-195, 2026-09-07), live via the D-142 harness (extended to mount
    `TimelineSwitcher`); see the gap note's own section for the full writeup. One
    real bug found during that verification, filed as **B-080** (not fixed): an
    edit made within the 400ms debounced-save window of a timeline switch is
    silently lost. Not started as a build — that note is the comparison, not a
    build plan.
21. **UI performance: real findings, not a hand-wavy "webviews are slow"** — owner,
    2026-09-07, after a real discussion about React 19/Tauri performance ceilings.
    Three concrete, evidence-based items, not guesswork:
    1. ~~**B-081** (`docs/BUGS.md`) — Tauri's fast custom-protocol IPC transport
       intermittently fails at startup and silently falls back to the slower
       `postMessage` bridge~~ — **root-caused and fixed (D-201, 2026-09-07)**,
       and it was not an IPC bug at all: the warning burst fires once per IPC
       call that is in flight when the page navigates, and the navigation was a
       **Vite full page reload of the whole app**, triggered because
       `app/src/main.tsx` held the `Root` component while exporting nothing,
       making it an invalidating React Fast Refresh boundary that every edit
       behind a `@chroma/*` barrel propagated to. `Root` now lives in
       `app/src/Root.tsx` (exports only components); verified live that editing
       `timeline.ts` / `timelineStore.ts` / the editor barrel now hot-updates
       instead of full-reloading.
    2. ~~**React Compiler bailout coverage** — a real inventory of 55 unique
       bailouts across 45 files~~ — **the Edit-tab half is fixed (D-201,
       2026-09-07)**: all 22 source files in `@chroma/editor` now compile with
       ZERO bailouts (`TimelinePane`/`TransformOverlay`'s hand-written
       memoization was fighting the compiler and costing them ALL
       auto-memoization; `PreviewPane`, `Filmstrip`, `useEditorControl` and
       `app`'s `SourcesPanel` cleared too), pinned by a real regression test
       (`packages/editor/src/reactCompiler.test.ts`). `app/`'s modals/settings
       `finally` bucket, `useAiMasking.ts`, `ImageCanvas.tsx` and
       `packages/motion`'s own files are still open, each with its reason —
       `docs/notes/react-compiler-coverage.md` marks fixed vs. open and
       tabulates a per-item verdict for every "possibly a real bug" flag
       (one turned out to be real: **B-084**).
    3. ~~**`TimelinePane.tsx`'s drag-gesture performance** — unverified either
       way: does its drag code already bypass React state during the gesture
       itself, or does it re-render through React state every pointer-move
       frame?~~ — **verified (D-201, 2026-09-07): it already defers**, for every
       gesture in the pane. `onDndDragMove` writes only local, change-gated
       `clipDragPreview`/`insertPreview` state (a drag that doesn't change the
       resolved landing produces zero re-renders); `applyOp` is called exactly
       once, in `onDndDragEnd`. A trim reaches `applyOp` only in
       `onActionResizeEndCb` (resize END); a marquee commits `setSelection` on
       pointerup; `TransformOverlay` keeps a local `draft` and commits one
       `set_clip_transform` on release. **No change made** — the direct-DOM
       `style.transform` technique would buy nothing here and would mean pulling
       `@dnd-kit`'s own `DragOverlay` out of the drag's real machinery. See
       D-201 Part 3.
    Done (D-201) — all three root-caused; 1 and 2 fixed, 3 verified as already
    correct. Remaining open: the rest of the React Compiler bailout list
    (`docs/notes/react-compiler-coverage.md` marks what is fixed vs. still open).
22. **`editor_export` mixes real audio, and the Edit tab gets a real Export button/
    dialog/queue** — done, 2026-09-07 (**D-197**, **D-198**). Closes the "v1 scope:
    video-only, a documented follow-up" gap D-183 explicitly left open (see that
    entry's own updated note) — found live via the owner's own workaround (a
    stacked before/after reel needing SFX, hand-rolled outside the app via a
    separate manual ffmpeg pass). `editor_export` now replicates the LIVE playback
    mixer's exact semantics in the ffmpeg filtergraph: gain (D-057), one-pole
    ducking (D-149, exact via ffmpeg's own `exp()`), and cubic-bezier fades (D-147,
    sampled — ffmpeg has no bezier solver), plus a video clip's own embedded audio
    when known to have one and not A/V-linked (D-129). `docs/notes/audio-export-
    mixing.md` has the full filter-graph detail. Also: `TimelinePane.tsx`'s own
    toolbar gets a real Export button (`EditorExportDialog.tsx`) with per-clip
    `speedOverrides`/`fitOverrides`/`freezeOverrides` rows and a real SEQUENTIAL
    export queue (`exportQueueStore.ts`, D-198) — wired through the SAME
    `compileEditorExportArgs`/`runEditorExport` the MCP tool now also calls
    (`editorExport.ts`), not a parallel implementation. `docs/notes/export-dialog-
    queue.md` has the full design + the honest gaps (no cancel, no reordering, no
    real concurrent worker pool this pass — sequential only, stated plainly).
    `npm test --workspace @chroma/editor` 408/408 (was 357); real `ffprobe`/
    `volumedetect`-verified ffmpeg execution tests, not just argv string matches;
    the dialog/queue live-tested in a real Chromium tab via the D-142 harness.
23. **The media pool has no way to recover a stuck/wrong item — a real architectural
    gap, not a one-off bug** — owner, 2026-09-07, after hitting it TWICE live in one
    session and being asked directly to fix the shape of the problem, not patch the
    symptom again. `add_media`'s own dedup (`crates/chroma-project/src/manifest.rs`)
    treats "already known by this exact source path" as permanent and final — there
    is no expiry, no re-probe-on-demand, and (until today) no MCP-reachable way to
    even remove an item, only the GUI's Sources panel has `removeMedia` →
    `chroma_media_remove`. A pool entry whose probe failed once (transient race,
    B-073; or — closed today — a probe function with a real bug, B-089) is wrong
    for the rest of the project's life unless a human manually deletes and re-adds
    it from the GUI. This is the SAME root shape as B-073 (open since this session's
    early hours) and B-089 (`docs/BUGS.md`, fixed today) — two different SYMPTOMS of
    one real gap: **the pool has no correction mechanism at all**, video-only or not.
    Confirmed by re-deriving it live: this session hit a stuck-path variant of B-073
    THREE times while adding real SFX/music (mp3/flac files, no video stream) —
    every workaround was copying the file to a path Chroma had never seen, which
    works but is not a fix, is not available to a GUI user, and leaves an
    ever-growing trail of dead pool entries no one can see or clean up (the SAME
    `docs/notes/mcp-tool-coverage.md` gap: "no `chroma_media_list`/`_remove` MCP
    tool"). **The minimal real fix, not a new concept:** expose the command that
    ALREADY EXISTS (`chroma_media_remove`, used correctly by the GUI's own Sources
    panel today) as an `editor_remove_media` MCP tool — closing the gap with the
    primitive that's already proven correct, rather than inventing a parallel
    `reprobe` command that would duplicate remove-then-reimport's own effect. A
    genuine "why did this happen twice" root cause worth naming too: `chroma-media`'s
    own probing layer (`VideoInfo`, `is_video_file`, `video::probe`) was designed
    video-first and had audio-track support (D-057/D-149) layered on top of it
    without a pass back through the FOUNDATIONAL probe/pool layer to make it
    format-agnostic — `is_media_file` (added today, B-089) is the first step of that
    correction, used consistently now by both of the pool's own "is this online"
    call sites; auditing for any OTHER place still assuming "pool item" means
    "video" is worth a dedicated pass, not assumed done.

    **Minimal slice DONE, 2026-09-07 (later same day):** `editor_remove_media`
    now exists in `mcp/server.py`, wired through a new `editor_remove_media` op
    in `packages/editor/src/useEditorControl.ts` that calls the SAME
    `useMediaPoolStore.removeMedia` → `chroma_media_remove` path the GUI's
    Sources panel already used correctly — no new removal logic. Investigated
    (not assumed) what happens to a clip already placed on the timeline that
    references the removed item: nothing breaks. `Clip.source_path` is an
    independent copy resolved at drop time and is never re-read from the pool
    afterward, so playback/export is unaffected; only `Clip.media_id` (a
    back-link used solely for legacy shot-grade-migration bookkeeping, never
    for playback/rendering) goes stale/dangling. The tool reports any such
    still-referenced clips in its `stillReferencedBy` field rather than
    silently leaving that unobservable. `docs/notes/mcp-tool-coverage.md`
    updated to reflect the tool exists. **This is the tool-exposure slice
    only — the real architectural gap named above (no expiry, no
    re-probe-on-demand for a stuck/wrong item) is still OPEN**; the fix today
    is "remove the bad id, then re-import the same path," a two-call manual
    correction, not automatic detection/recovery. That remains future work.
24. **No text/title clip primitive in the Edit tab at all** — owner, 2026-09-07,
    asking for real "AFTER"/"BEFORE" labels on the comparison reel. Confirmed by
    grep: no `TrackKind::Text`, no title-clip concept anywhere in
    `packages/editor/src/timeline.ts`/`crates/chroma-timeline` — a video track holds
    only real decoded video, an audio track only real decoded/synthesized audio.
    Worked around THIS session with a real `ffmpeg drawtext` pass laid on top of
    Chroma's own correct export (not a Chroma feature — an external finishing
    step, disclosed as such), which is fine for a one-off but is not something a
    GUI user can do at all. A real text/title primitive needs, at minimum: a new
    `Clip`-like model (font/size/color/content/position, keyframeable position at
    least, matching the existing transform-keyframe convention), a Rust
    live-preview compositor path (a text-rendering layer, not a decoded-frame one),
    and an `editor_export` compiler path (most naturally `drawtext`/`ass` under the
    hood, given this session's own precedent). A real, standalone feature — not a
    quick add alongside anything else. Not started as a build — this entry is the
    scope, not the implementation.

### Then — the deeper migration (D-039 steps 2–7, `architecture-lock.md`)

**→ The execution map is `docs/notes/crate-extraction-plan.md` (D-141, 2026-09-05).**
Read it before starting any slice; it replaces the sketch below, which was written
before `app/src-tauri/src/chroma/` had been read for extractability. What it changes:
`#[tauri::command]` functions **stay in `app/src-tauri`** (a real `tauri-macros`
constraint plus an `AppState` dependency cycle, both traced in D-141), every
extraction leaves a `pub use` shim in the same commit so `lib.rs`'s handler list is
never contended, and **`chroma-agent` is rescoped out of this wave** — `control.rs`
has no Tauri-free core and its op registry lives in the frontend. Real order:

1. **wave 1, parallel — all three landed, 2026-09-05.**
   ~~`chroma-grade-model`~~ **done, D-143** — `save_grade`/`load_grade` +
   the schema migration gate move verbatim. ~~`chroma-ai`~~ **done, D-145** —
   `sidecar.rs` moves almost whole; `depth.rs`/`mask.rs` split cleanly at
   the crate boundary with zero call-site changes. ~~`chroma-gpu`~~ **done,
   partial, D-144** — `render_core::init_gpu_context()` moved to the new
   crate (headless device/queue/limits); `render_core::render()` stays
   app-side, it's `chroma-grade`'s. `GpuContext` really did split into two
   structs — see D-144 and `crates/README.md`.
2. ~~**wave 2, alone** — `chroma-media`, in three ordered commits (`probe_cached` must
   leave `edit.rs` first, or `chroma-media` would depend on the app)~~ — **done,
   D-146 (2026-09-05).** All three commits landed in order: (1) `video.rs` +
   `decode_pipe.rs` + `media_cache.rs` verbatim, (2) `probe_cached` out of
   `edit.rs` with **B-056** fixed on the way, (3) `filmstrip.rs` whole and
   `audio.rs` **split** — its engine moved, its timeline resolution
   (`edit::resolve_video_position` / `resolve_audio_track_positions`) stayed
   app-side because that is a layer above media, with **B-057** fixed while in
   `filmstrip.rs`. Both bug fixes carry regression tests confirmed to fail
   pre-fix.
3. ~~**wave 3** — `chroma-project` (needs `chroma-media`; an edge
   `architecture-lock.md`'s table is missing)~~ — **done, D-148 (2026-09-05).**
   The missing edge is now in the lock doc's table, along with a
   `chroma-grade-model` edge the table claimed and the real code never had.
   **Waves 1–3 are complete: the sequential part of the migration is finished.**
4. **wave 4 — next, and the only remaining migration step before the gated ones**
   — delete the shims (`chroma/{video,media_cache,decode_pipe}.rs` are pure
   re-export files; `chroma/project.rs`'s `pub use chroma_project::*;` and
   `chroma/edit.rs`'s `pub(crate) use chroma_project::timeline::ensure_timeline;`
   are the same thing inside a live file), retarget every call site at
   `chroma_media::` / `chroma_project::`, and fix the doc set —
   `docs/03-architecture.md` has been stale since Phase 0 and the crate graph is
   only now the real one. Mechanical, one commit, no behaviour.
5. **later, gated** — `chroma-grade` wraps `app/`, `chroma-app` goes thin, then
   **`chroma-compositor`** (the real multi-track engine) + `@chroma/editor` greenfield

This is where isolated-worktree parallel subagents start making sense — the plan says
which slices are genuinely disjoint and which must be sequential (see the "worktrees"
discussion, 2026-09-02: file-boundary discipline is the actual lever, not the worktree
flag itself).

- ~~**Wave 2 — `chroma-media`**~~ — **done, D-146 (2026-09-05).** The widest
  slice in the plan and the only sequential-within-itself one. ~3,900 lines
  now live in `crates/chroma-media/` across `video`, `decode_pipe`,
  `media_cache`, `probe`, `filmstrip` and `audio`. The two real judgement
  calls: `probe_cached` moved into a module of its own (it is the
  *composition* of `video::probe` with `media_cache`, not part of either), and
  `audio.rs` split rather than moved whole — `chroma_audio_play` became
  `begin_play` → *(app resolves the timeline)* → `start`, preserving the exact
  ordering the D-125 skew compensation depends on. Three `#[cfg(test)]` items
  became a `test-support` feature enabled only from `[dev-dependencies]`, so a
  release build links none of them. **Next:** wave 3 (`chroma-project`), then
  wave 4's shim sweep — `chroma/{video,media_cache,decode_pipe}.rs` are
  re-export files awaiting deletion.

- ~~**Wave 3 — `chroma-project`**~~ — **done, D-148 (2026-09-05); closes the
  Wave 1–3 sequence.** `chroma/project.rs` L1–1638 (the manifest, every schema
  migration, the media pool + bins, the D-070 unified clip identity and
  grade-file migration, `list_projects_in`/`new_project_in`) moved verbatim
  into `crates/chroma-project/`; `open_manifest` + the 20 commands stayed,
  because all 20 take `tauri::State<'_, AppState>`. The one piece of real
  relocation rather than a straight move: `ensure_timeline` /
  `load_and_ensure_timeline` / `resolve_timeline` /
  `resolve_timeline_and_settings` / `build_from_shots` left `chroma/edit.rs`
  for the new crate — project concerns wearing an Edit-tab name, as the plan
  called it — with the *process global* they read (`chroma::state`'s "which
  project is open") staying app-side as a parameter the wrapper supplies. The
  59-test suite split by what it exercises: 48 model tests moved, 11
  command-surface / process-state tests stayed, and the timeline lifecycle
  gained 5 unit tests it never had in `edit.rs`.

- ~~**Wave 1, slice A — `chroma-grade-model`**~~ — **done, D-143 (2026-09-05).**
  `save_grade`/`load_grade`/`migrate_v1`/`relativize`/`resolve`/`grade_name` +
  `SCHEMA`/`MATTE_KEYS`/`SaveResult` moved out of `chroma/grade.rs` verbatim;
  the plan's zero-dependency-edge claim for this slice held on contact. The 2
  command wrappers stayed in `app/src-tauri` per the "commands do not move"
  rule and now just call the crate.

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
  steps 3–7 — scoped for real in **D-141**,
  `docs/notes/crate-extraction-plan.md`. (Correcting this line's own stale
  premise: `chroma-timeline` is not a stub, it is 3,758 production lines;
  `chroma-grade-model` is a stub and is not even a dependency of
  `app/src-tauri` yet.) D-053's deferred `chroma-types` pickups —
  `VideoInfo.fps_num`/`fps_den` → `Rational`, `TimeRange`, `Frame` — are
  carried in that plan as flagged item **F-4**, to be decided when `video.rs`
  moves rather than left to drift.

- ~~**Practical sound control, Phase 1 — per-clip fade in / fade out**~~ — **done,
  D-147 (2026-09-05).** Owner: "sound engineer"-style control, "enough for
  transitions etc.", then concretely "build the fade in and fade out with bezier
  curve support." `Clip::fade_in_frames`/`fade_out_frames` plus a real cubic-bezier
  `FadeCurve` each, evaluated by the new `crates/chroma-types/src/fade.rs` (genuinely
  new math — D-034's keyframe engine was verified to be strictly linear and left
  alone; L0 because its two consumers straddle crate layers — see D-147's
  reconciliation section). One fade drives picture and sound together: `opacity` in
  the compositor, per-**sample-frame** gain in `chroma-media`'s mixer
  (`audio::FadeEnvelope`). Inspector section with the four presets, and
  the first two Edit-tab MCP tools (`get_timeline`, `set_clip_fade`). Scoping for the
  whole surface: `docs/notes/audio-fade-duck-crossfade-plan.md`.
  - **Custom-curve UI — deferred, not blocked.** The model, evaluator, wire format
    and MCP surface all take arbitrary control points today (an MCP-authored custom
    curve round-trips through the GUI and renders correctly, and the panel reports
    it honestly as "custom"). What is missing is a draggable two-handle widget so a
    *human* can author one.
  - **Crossfade — genuinely blocked on a model change, not scheduled.** D-104
    rejects clip overlap unconditionally, and a no-overlap "crossfade" is
    arithmetically a dip-to-silence, not a crossfade (plan doc §3 — no curve fixes
    it). The compositor and mixer are already N-source ready; only the model forbids
    the arrangement that would feed them. The tractable path is *cross-track*
    overlap behind an explicit `create_crossfade` op — reinstating D-096's policy
    that D-104 reversed for a UX reason — which needs the owner's call. Same-track
    overlap is much bigger: it changes what `Track::clip_at`'s `.find()` means
    everywhere in the app.
  - ~~**Ducking (music under dialogue)**~~ — **done, D-149 (2026-09-05).** Plan
    doc §4, built on exactly the seam D-147 left for it: it cannot ride D-057's
    static `Track::gain`, it needs time-varying gain, and the fade envelope
    already *was* time-varying gain. `Track` gains `duck_from`/`duck_db`/
    `duck_attack_ms`/`duck_release_ms`; the trigger is a pure timeline-model
    query (`Track::clip_spans_from` — does the nominated track have a clip
    here), smoothed by a real one-pole with separate attack/release time
    constants, evaluated in closed form so it is sample-rate independent, and
    multiplied into the same per-sample-frame pass the fade already runs in.
    Track-header popover + a `set_track_duck` MCP tool with the real numbers.
    **Phase 2 still open:** RMS sidechain detection, so a pause mid-sentence
    lets the bed back up — should reuse the `waveform` peaks `media_cache`
    already holds rather than decoding again (plan §4b, and D-140 §6b reached
    the same conclusion for `inspect_pacing`).

- **Steps 3–7 — scoped, not started (D-141, 2026-09-05).**
  `docs/notes/crate-extraction-plan.md` is the map: per-crate real contents with
  line ranges, real dependency edges in both directions (including the five
  places RapidRAW core calls *up* into `chroma/`), the extraction order and its
  three hard constraints, which slices are parallel-safe, and the Tauri
  command-macro constraints traced out of `tauri-macros-2.6.3`. No code moved
  in that pass by design.

---

## Later — researched, designed, deliberately not built yet

No urgency — each needs an earlier item to land first, or is a bigger bet.

- **XMEML/FCP7 XML interchange export (Premiere)** — D-196 shipped the
  FCPXML 1.7 half of "move a Chroma edit to another NLE" (DaVinci
  Resolve/Final Cut Pro), deliberately scoping XMEML out rather than guess at
  its shape by analogy — it's a genuinely different element vocabulary
  (`<sequence>`/`<track>`/`<clipitem>`/`<link>`) with no DTD published in the
  same machine-checkable form FCPXML 1.7's is. Needs its own spec research
  pass (Apple's old FCP7 interchange docs) before a line of `<clipitem>`-
  building code is written. Also flagged there: bumping the shipped FCPXML
  version past 1.7 once real 1.9+ schema material or an actual Resolve/FCP
  round-trip test is available, and exporting `chroma_keyframes`/clip-fade
  animation once the correct built-in `adjust-*` FCP parameter names are
  confirmed (not guessed).
- **Motion tab visual builder — on-canvas drag / size / animate** — owner asked for it live
  2026-09-05 ("drag and drop multiple elements… a visual builder for me and animation as well…
  fix easily, with human in loop"). **Researched and phased: D-152,
  `docs/notes/motion-visual-builder-research.md`.** The load-bearing finding is that the Motion
  engine's coordinate model is **already correct** — scene/world space, camera applied at render
  time, an invertible 2D similarity, reference frame declared in the manifest — so unlike D-136
  there is **no migration to write**; the work is tooling. The recommended screen↔world map is
  *measured* from the live `@remotion/player` DOM (`data-motion-world` +
  `getBoundingClientRect`), not a second copy of `Camera.tsx`'s math.
  **Phases 0–4 BUILT (D-155/D-156/D-157/D-158/D-159, 2026-09-05):** DOM hooks + transient-preview
  override + undo + world-space discipline (Phase 0); click-select + move-drag (Phase 1); resize
  handles + "snap to layer" + the layer transform wrapper (Phase 2); `Selection[]` + marquee-select
  + shift-click-extend + shared-delta group move + stable layer identity (`layer.id`) +
  align/distribute actions (Phase 3 — D-158); per-layer keyframes on the transform wrapper
  (`layer.transform.keys`, additive deltas), the shared `interpolateKeys` extraction (now used by
  BOTH the camera and layer keys), B-059 fixed (a camera keyframe's `ease` was silently stripped by
  the schema — also found and fixed on `cam3dKey`, the same gap that bug's own text wrongly called
  harmless), and auto-keyframe-on-drag (per-property, move-drag only — Phase 4, D-159). Part C's
  `</>` raw-JSON collapse shipped separately as D-153.
  **Phase 5 scoped further and its first slice (5a) BUILT — D-160, `docs/notes/
  motion-keyframe-timeline-research.md` (2026-09-05).** That doc independently re-verifies "the
  Edit tab's timeline stack isn't reusable, but the cost is comparable" against the real code
  (confirmed piece by piece: nothing transfers as code, `ruler.ts`'s tick algorithm and D-137's
  gesture-separation discipline transfer as technique only, per the standing `@chroma/motion`/
  `@chroma/editor` package-boundary rule). **Phase 5a (built): `LayerList` key-count badges +
  a read-only `KeyframeStrip` under the player** (camera + selected-layer key markers across the
  whole composition, live playhead, click/marker-click-to-seek — pure navigation, no manifest
  mutation). One disclosed deviation: "the player's own scrubber gains markers" wasn't buildable
  as literally worded (Remotion's bundled controls have no extension point) — a separate strip
  alongside the untouched player instead.
  **Phase 5b, part 1 (drag a key along time) BUILT — D-161, 2026-09-05.** `manifestEdit.ts`'s
  new `moveKeyAt` (one generic core, `layer.transform.keys`/`scene.camera`/`scene.scene3d.camera`
  all share it) plus three thin wrappers; two edge cases decided and tested — a drag past a
  neighbor REORDERS the array (`interpolateKeys` already re-sorts by `at`, so array order was
  never meaningful downstream) rather than clamping, boundary-clamped to `[0, scene.dur]`, the
  dragged key's own scene. `keyframeVisibility.ts` gains `percentToFrame` (the pointer-position→
  frame inverse of `frameToPercent`). `KeyframeStrip.tsx`'s marker drag reuses D-155's
  transient-preview/commit discipline via the SAME `onTransientChange`/`onCommit`
  `MotionCanvasOverlay.tsx` already uses, with its own local `dragPreview` overlay (rather than
  re-deriving markers from a live-mutating transient manifest) to avoid losing pointer capture
  when a drag-triggered reorder would otherwise change a marker's own React key mid-gesture.
  **Phase 5b, part 2 (per-row lanes) BUILT — D-162, 2026-09-05.** The flat single-strip
  `KeyframeStrip.tsx` (D-160/D-161) is retired, replaced by `KeyframeTimeline.tsx`: one row per
  keyed 2D camera/layer/3D camera (`keyframeVisibility.ts`'s new `keyframeLanes`, `LayerList`'s
  own row order — rows appear/disappear as keys are added/removed), a shared time ruler using a
  REIMPLEMENTATION of `ruler.ts`'s tick-density algorithm (`timelineRuler.ts`, not an import — the
  standing package-boundary rule), independent zoom (`timelineZoom.ts`, new bounds, not the Edit
  tab's D-134 system — that one bracket a Rust thumbnail-decimation ladder with no equivalent
  here), a combined vertical+horizontal scroll region (sticky row labels + sticky ruler, no
  virtualization library needed), per-row click-to-select reusing `MotionTab.tsx`'s own
  `onSelect`, and D-161's drag-a-key gesture generalized per row — any keyed layer's keys can now
  be dragged without first selecting that layer, a real capability improvement over the flat
  strip. Layout call: the timeline moved OUT of `MotionPreview.tsx` into a new full-width sibling
  panel in `MotionTab.tsx`'s own layout (a nested vertical `PanelGroup`, preview over timeline),
  mirroring the Edit tab's own `PreviewPane`/`TimelinePane` stack — a flat 24px strip could live
  squeezed under the player, but N independently-scrollable rows need real, resizable estate of
  their own.
  **Phase 5b, part 3 (box-select + nudge multiple keys) BUILT — D-163, 2026-09-05.** A NEW
  selection model for individual keys, `keyframeVisibility.ts`'s `KeySelectionEntry`
  (`{lane: KeyframeLane, keyIndex}`, the research doc's own suggested shape, `trackId` becoming
  D-162's own `KeyframeLane`) — kept local to `KeyframeTimeline.tsx` (nothing outside it needs to
  read a key-selection today, unlike `Selection[]`), no same-kind/same-scene restriction (a shared
  time delta means the same thing everywhere, unlike world-space `x`/`y`), and deliberately NOT
  cleared on every manifest commit (a disclosed, accepted edge case: a nudge that crosses a
  non-selected neighbor can leave a stale entry, handled by pure value-equality never
  dereferencing). A rubber-band drag over empty track space box-selects via `keysInMarqueeRect` —
  deliberately PURE geometry with no per-marker DOM measurement at all (D-162's per-row layout is
  already fully known from pure numbers; only ONE DOM read, the scrollable content div's own
  rect, is needed to place the marquee), reusing `canvasGeometry.ts`'s `rectFromPoints`/
  `rectsIntersect` verbatim. Shift-click toggles a key into the selection, mirroring D-158's exact
  modifier convention. Nudging generalizes D-158's `moveLayersByDelta` to keyframes:
  `manifestEdit.ts`'s new `moveKeysAt`/`moveKeysByDelta` avoid a real correctness trap found while
  designing them (N sequential `moveKeyAt` calls on keys sharing ONE array can silently retime the
  wrong key once an earlier call's reorder shifts what a later `keyIndex` points at — fixed by
  computing every new `at` from each key's own remembered base in one pass, then sorting once). Two
  real design questions decided: a key-selection MAY span multiple lanes/scenes (unlike
  `Selection[]`), and each key clamps to its OWN scene's `[0,dur]` independently — a nudge can
  become non-uniform at a boundary rather than blocking the whole gesture, for consistency with
  `moveKeyAt`'s own established never-block philosophy.
  **Phase 5b, part 4 (a real bezier curve/easing editor) BUILT — D-164, 2026-09-05. This closes
  Phase 5b and the whole Motion visual-builder/keyframe-timeline initiative (D-150 through
  D-164).** A genuinely separate, self-contained widget (per the research doc's own framing,
  "closer to a color-picker than to the timeline strip") — built on D-159's schema and
  `interpolateKeys`, not on D-161/162/163's timeline machinery at all. New `easeCurve.ts` (pure
  math: `curveToPixel`/`pixelToCurve`, `x` unconditionally clamped to `[0,1]` because `remotion`'s
  own `Easing.bezier`/`bezier()` throws outside that range — confirmed against its real bundled
  source, not assumed; `curvePath` needs no numerical bezier evaluation, an SVG `C` command already
  draws the identical parametric curve; presets sourced BY REFERENCE from `design.ease.*` plus
  `Linear`/`Ease In`, which that module doesn't define) and `EaseCurveEditor.tsx` (two draggable
  control-point handles, live-commits per pointermove — matching `color`/`number`'s own established
  live-commit convention, not inventing a new one). `propCatalog.ts` gains `FieldKind: 'ease'`,
  replacing `kind:'json'` for the three existing `ease` field entries — the ONLY change to those
  lists; no `manifestEdit.ts`/`schema.ts` change needed, `ease` was already fully plumbed. Unset
  `ease` shows `design.ease.inOut` (the literal fallback the engine already renders with) muted,
  not a blank widget or a misleading guess. Found and filed (not fixed, per this pass's own scope)
  **B-062**: the schema never validated `Easing.bezier`'s own hard `x∈[0,1]` constraint, so a
  hand-edited out-of-range `ease` validates fine and only crashes at render time — the new widget
  itself cannot produce this value by construction, but the manifest-text editor and external tools
  still can. **Closing status of the whole initiative, disclosed:** every entry since D-125's own
  sandbox-can't-launch-Tauri constraint still applies to all of it; B-061 (camera `at` mislabeled
  "frame," stores seconds) and B-062 remain open; D-157's screen↔world scale/rot approximation and
  D-159's rotate/scale/opacity-have-no-canvas-handle gap are unchanged; snapping/alignment guides
  (D-158) remain unbuilt pending a UI-effort spike; a live interpolated-value preview on the curve
  widget was judged genuinely optional (per the task's own framing) and not built.
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
- **Visual understanding for the Editor tab** — **first slice shipped, D-189
  (2026-09-07)**: the `ai-media/` sidecar plus 4 MCP tools give an agent
  "what was said, and when" (mlx-whisper large-v3, word-level) and "what changed
  on screen, and when" (ffmpeg scene-detect for exact timing + Qwen3-VL-4B for
  the description). Ported from a validated prototype, with the real throughput
  numbers this line used to ask for now MEASURED rather than extrapolated:
  ~12 s to transcribe an 18 s clip; ~38 s to analyse a 20 s cut-heavy clip at
  5 candidates (roughly 4x realtime, ~9 GB peak). `docs/notes/
  media-understanding-sidecar-scope.md`. Still open on this line: natural-language
  footage **search** across a pool (`search_footage`, per `video-search.md`),
  B-roll auto-tagging, shot classification, auto-reframe hints, highlight
  detection, and the spatial half (SAM2/YOLO, already have, still under-exposed)
  — all of which now have a real capability to build on rather than starting
  from nothing. Molmo 2 stays excluded from shipping (licence).
  `docs/notes/video-search.md`. The *audio/rhythm* half of "understanding the
  footage" is the separate item below — researched and scoped, deliberately not
  merged into this one.
- **Pacing & audio assistance for the Editor tab** — beat/onset detection on a clip's
  audio (librosa in the `ai/` sidecar, ffmpeg-decoded, cached in a new `media_cache`
  `"beats"` namespace) surfaced as timeline guides + snap targets, plus a read-only
  pacing inspector (cut frequency straight from the timeline model, loudness from the
  existing waveform cache, optional motion intensity) and full MCP parity
  (`get_timeline`, `detect_beats`, then `inspect_pacing` / `snap_clip_to_beat`).
  Researched: `docs/notes/pacing-audio-assistance-research.md` (D-139). Scoped:
  `docs/notes/pacing-audio-assistance-plan.md` (D-140). **First concrete task is
  Phase 0** — a real wall-clock benchmark (none exists; D-139 searched) *and* a run
  against the owner's own CassetteAI tension beds, which are the weak-pulse worst case
  for this class of tracker and can invalidate the premise before anything is built.
  Auto-cut-to-beat, downbeat/meter and "emotional arc" understanding are explicitly
  out, with reasons, not deferred.
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

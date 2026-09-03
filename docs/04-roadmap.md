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
  (D-043) — it's the grading editor only now.
- **Editor** — MVP: single-video-track timeline (`chroma-timeline` + `react-timeline-editor`),
  scrub/play preview (independent of the Colorist render path) via the shared
  `@chroma/player` component, reorder/trim/split/remove/**add via drag-from-Sources**,
  persisted in the project. Multiple named timelines per project, switchable via
  `TimelineSwitcher` (D-046). **Real audio during playback** (D-050 —
  `symphonia`→`rubato`→`dasp_sample`→`cpal`, single video track's embedded
  audio stream, synced-at-start-not-tightly-coupled to the video playhead).
  **Mature single-track timeline UI** (D-051) — scroll-wheel + toolbar zoom,
  native edge-drag trim + snap-to-clip-edge/playhead, a Rust-computed waveform
  on the clip, ripple-shift flash. No multi-track or transcript cut yet.
- **Motion** — MVP (D-047): a `@remotion/player` live preview of
  `packages/motion-engine/`'s `Video` composition + a JSON-in manifest editor
  (validated against the engine's own `zod` schema — a visual editor is
  still an open question), Save (project-scoped sidecar
  `<project>.chroma/motion/manifest.json`) and Render (`chroma-motion`
  crate → `npx remotion render`). No multi-manifest, render progress/cancel,
  or packaged-build story for the engine yet.
- **Shell** — 3-tab layout, window chrome, the project launcher as the app's entry
  screen (opens on the launcher, tabs appear once a project is open), a docked
  Sources/Library panel reachable from every tab (thumbnails-less grid, import,
  search, bin tree, drag-to-track — D-046), `@chroma/ui` (shadcn/Base UI, 18
  components, themed).
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
   (depends on real multi-track support generally — see item 2 below),
   waveform-on-clip UI (item 2), mute/volume controls, audio scrubbing while
   paused, and long-play-session drift correction between the audio/video
   clocks (open-loop by design this pass — see D-050's sync-model note).
2. ~~**A mature timeline UI**~~ — **done, D-051 (2026-09-03).** Scoped against
   `react-timeline-editor`'s actual API first, as directed: **edge-drag trim and
   snapping (to adjacent clip edges + the playhead) turned out to already be fully
   native** (`flexible: true` + `dragLine: true`, both already set since D-041) — zero
   new code for either, just verified by reading the library's bundled source.
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

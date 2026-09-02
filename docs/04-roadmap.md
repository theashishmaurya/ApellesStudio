# 04 — Roadmap

Phased. Each phase ends at a demoable checkpoint. Timelines are rough solo-dev estimates,
not commitments.

---

## D-039 — 3-tab restructure (Edit / Motion / Colorist) migration

The architecture lock (`docs/08-decisions.md` D-039, `docs/notes/architecture-lock.md`):
thin-shell/fat-core Cargo + npm monorepo workspace. Incremental, `cargo test` green each
commit.

- [x] **Migration step 1 — workspace skeleton** (D-040 + D-039 skeleton commit, 2026-09-02):
  de-submodule the fork into `app/` (D-040); root `Cargo.toml [workspace]` +
  `crates/{chroma-types,chroma-timeline,chroma-grade-model}` stubs (each `cargo check`
  clean, `it_builds` test); root `package.json` npm workspaces +
  `packages/{tokens,ui,bridge,editor,motion,shell}` stubs; the Remotion motion engine
  moved in as `packages/motion-engine/` (`@chroma/motion-engine`); `app` → `@chroma/app`.
  **No real code moved; the whole workspace builds (`cargo build`) + `npm install` hoists.**
- [x] **3-tab shell (`@chroma/shell`) + placeholder tabs** (2026-09-02): `@chroma/shell`
  is a real package — `<Shell tabs={...}/>` (tab bar + persisted `useShellStore` +
  Cmd/Ctrl+1/2/3), tab content injected via a registry prop so the shell stays
  react+zustand-only. `@chroma/editor` (`<EditorTab/>`) + `@chroma/motion` (`<MotionTab/>`)
  are placeholder tabs. `app/src/main.tsx` mounts `<Shell>` with the Colorist tab = the
  whole existing app, untouched (its root `h-screen` → `h-full`). tsc baseline 74
  unchanged; `vite build` green. Brought forward from step 6.
- [x] **Editor tab MVP** (D-041, 2026-09-02): `chroma-timeline` made real
  (`Timeline::from_shots`, `Track::clip_at`, `Timeline::duration`, reorder / trim /
  split / remove ops, 9 tests); `app/src-tauri/src/chroma/edit.rs` bridge — 3 commands
  (`chroma_timeline_get` / `_set` / `_frame`), timeline persisted in `ProjectManifest`
  (`#[serde(default)]`, additive), a standalone decode→jpeg preview independent of the
  Colorist render path; `@chroma/editor` real tab — single-video-track
  `@xzdarcy/react-timeline-editor` timeline + scrub/play preview + `useEditorTimelineStore`.
  Deferred: multi-track / audio / transitions / transcript / compositing / grade-in-preview
  / OTIO export / MCP.
- [x] **UI pass** (2026-09-02): window chrome → `@chroma/shell` (`WindowChrome.tsx` —
  traffic lights + Win/Linux controls + drag region), tabs centered, RapidRAW
  `<TitleBar/>` no longer rendered, `.macos-window-shell` on the shell root;
  `@chroma/ui` package started (Button / Switch / Input / Text / CollapsibleSection
  extracted with app-side re-export shims — `Slider` + app-coupled components deferred);
  Editor tab transport + toolbar rebuilt with `lucide-react` icons + a `@chroma/ui`
  `<Button>` instead of hand-crafted text buttons. See D-039 migration log step 6b.
- [x] **Project launcher = the app entry screen** (D-039 migration log step, 2026-09-02):
  the app now opens on the launcher with no tab bar (just the chrome bar); opening or
  creating a project flips `<Shell>` into the 3-tab layout, and a "‹ Projects" button in
  the chrome bar calls `closeProject()` to come back. `<Shell>` gained `projectOpen` /
  `launcher` / `onCloseProject` props (it never imports `ProjectLauncher` — app → shell
  only); the composition root (`app/src/main.tsx`) is a small `Root` that reads
  `useSessionStore` and does the routing. The Colorist tab (`<App/>`) dropped its
  `activeView: 'projects'` branch (`useUIStore` default → `'editor'`); tab panels stay
  mounted under the launcher so the MCP control bridge keeps running. Follow-ups: reopen
  the last project on launch (no persisted "last project" today); moving `ProjectLauncher`
  + the session store into `@chroma/bridge` / a `@chroma/project` fe package.
- [x] **`@chroma/ui` on shadcn/ui + Base UI** (D-042, built 2026-09-02) — canonical
  shadcn (`components.json`, `lib/utils`, `components/ui/*`), 18 structural components on
  Base UI (`@base-ui/react` 1.7.0), themed to the `--app-*` tokens (one `@theme` source,
  `--color-accent` kept as brand / shadcn hover → `bg-muted`). 5 hand-extracted rebuilt
  (shims stay; Switch shim → new `LabeledSwitch`). `@chroma/shell` + `@chroma/editor`
  toolbar migrated. RapidRAW's domain components (ColorWheel / LUT / DepthRangePicker /
  grading sliders) stay in `app/`. Deferred: typography unification, Colorist panel
  migration (`Dropdown` → `Select`/`DropdownMenu`).
- [ ] **D-043 — Colorist tab = grading editor only; strip RapidRAW's DAM/welcome/library
  shell** (owner directive 2026-09-02). RapidRAW's photo-manager shell still leaks
  through the Colorist tab: the "Welcome back / Continue Session / Add Folder" home
  screen (`MainLibrary.tsx`), the "Sources" folder-tree + "Library" photo grid
  (`LibraryView.tsx` + `panel/library/*`), albums, culling, the web "Community" presets
  page, a "Home" button, and RapidRAW branding (name / version 1.6.2 / "Images by Timon
  Käch" / Ko-Fi + GitHub links) — "a separate app inside our app." **Proper analysis
  first** → `docs/notes/colorist-strip.md` (every `activeView` branch, every entry into
  the DAM views, every branding string, every Rust command only the library uses), then
  remove it: Colorist renders only the editor; `useUIStore.activeView` collapses; media
  comes from the shared pool / a file picker, not the folder tree; Rust library commands
  removed. Overrides D-003 for the shell layer (the grading engine stays). **Next after
  `@chroma/ui` — heavy `App.tsx` overlap.**
- [ ] **`@chroma/player` — one shared preview component for all 3 tabs** (requested
  2026-09-02, Palmier-viewer-style). A **presentational** package: a canvas viewport +
  a title strip (`‹ ›` nav, name, `…` menu) + a transport bar — timecode
  `cur / total`, skip-start / step-back / play-pause / step-fwd / skip-end, and a right
  cluster: snapshot, fullscreen, playback-rate (`1×`), zoom (`Fit` / fill / %).
  Props: `{ frame, total, fps, playing, rate, zoom, onPlayPause, onStep, onSeek,
  onSkipStart/End, onRateChange, onZoomChange, onSnapshot, onFullscreen }` + a
  `surface` slot = whatever the tab renders inside (an `<img>` for the Editor's
  `chroma_timeline_frame`, the wgpu native-surface region for the Colorist grade
  preview, a `@remotion/player` for Motion). Each tab owns its frame source + wires the
  callbacks to its own transport logic. Editor tab adopts it first (its hand-rolled
  transport moves into the player), Colorist + Motion follow. **Queued after the launcher
  move.**
- [ ] **Media pool + import + multiple timelines** (requested 2026-09-02, Palmier/Resolve
  media-pool style). The Editor MVP (D-041) just uses the project's D-037 `shots` as the
  timeline clips directly — no import, no library, one timeline. Needed:
  - **`MediaItem` model** — `{ id, kind: video|audio|image|generated, source_path, name,
    duration, thumbnail, offline }`, project-level (`ProjectManifest.media`). **Unify
    with `shots`:** the media pool is *all* imported media; a Colorist "shot" is a
    media item being graded; an Editor "clip" is a windowed reference to a media item on
    a track. D-037 `shots` migrate into / become a view of the pool.
  - **Import** — file picker (video/audio/image, multi-select) → probe (duration,
    thumbnail via `chroma::video::extract_thumb`) → add to pool. Referenced in place,
    never copied (D-037 rule). Relink for offline items (extend D-037's shot relink).
  - **Bins / folders** — organise the pool (Palmier's `cards-v4`, `explainers`, `score`
    folders in the screenshot).
  - **Multiple timelines per project** — `ProjectManifest.timelines: Vec<{ id, name,
    timeline: chroma_timeline::Timeline }>` (was `timeline: Option<Timeline>`), one
    active; create / rename / duplicate / delete; a timeline itself can be a pool item
    ("Timeline 1" nested-sequence, deferred).
  - **Library / Sources panel UI** — a **global** media-pool panel shared by all tabs
    (mainly the Editor): thumbnail grid + Import button + folder tree + smart search +
    drag-a-pool-item-onto-a-track. `@chroma/ui` components. Lives in `@chroma/shell` or a
    `@chroma/media` fe package so every tab can dock it.
  - **Remove RapidRAW's "Sources" panel from the Colorist tab** (requested 2026-09-02):
    the left folder-browser / albums panel (`app/src/App.tsx` → `LibraryView` /
    `panel/library/*`) goes — the Colorist grades whatever media item is selected in the
    shared pool. Keep the components unrouted (D-003) but the Colorist layout drops the
    left panel.
  - MCP: `import_media` / `list_media` / `list_timelines` / `set_active_timeline` so the
    agent can build edits too.
  Schema: additive `chroma.project/1` (like D-038/D-041). **Big — its own decision
  (D-0xx) + likely 2–3 subagent passes (model+import, bins+multi-timeline, UI).**
- [ ] **Export → a top-right button + an Export window** (requested 2026-09-02). Today
  RapidRAW's `ExportPanel` is a right-side panel toggled by `isLibraryExportPanelVisible`.
  Wanted: an **Export** button top-right of the Colorist tab (near undo/redo/eye/
  fullscreen) that opens a proper **Export dialog/window** with all settings — codec
  (ProRes / H.264 …), resolution (+ the D-038 project output spec as the default), frame
  range, `.cube` LUT bake toggle, output path, progress. Backed by the existing
  `chroma_export_video` / `chroma_bake_lut` (D-022) + the `export` bridge op. Eventually
  the Export window is shell-level (export the active timeline from the Edit tab too), but
  Colorist-first. `@chroma/ui` (needs `Dropdown` — extract it, or a local one).
- [ ] **Global undo/redo** (requested 2026-09-02): a shell-level Cmd/Ctrl-Z / Cmd-Shift-Z
  history spanning all tabs. A `@chroma/history` store holding a unified stack of
  `{ tab, label, undo(), redo(), ts }`; the Colorist's existing 50-deep `useEditorStore`
  history feeds/delegates into it (don't rebuild it); Editor timeline ops push
  before/after snapshots; the shell owns the keyboard listener. Ties into D-032's activity
  feed. **Queued behind the UI pass (overlapping files).**
- [ ] Migration step 2 — extract leaf pure crates (`chroma-types`, `chroma-grade-model`,
  `chroma-timeline`) for real.
- [ ] Steps 3–7 — `chroma-gpu` / `chroma-media` / `chroma-project`; `chroma-agent` /
  `chroma-ai`; `chroma-grade` + thin `chroma-app`; frontend `@chroma/{tokens,ui,bridge}`;
  the project launcher (D-037) moves from inside the Colorist tab up to `@chroma/shell`
  (a project spans all 3 tabs); `chroma-compositor` + `@chroma/editor` greenfield.

---

## Working queue — round 2 (to v1)

Round 1 done (D-021…D-025): scopes/`inspect_color`, export + `.cube`, mask
composition ops, depth-haze, `grade.json`. Round 2, in order:

1. [x] **`match_to_reference` auto-apply** (D-026, 2026-09-01) — the gap already
   computes (D-021); this closes the loop: measure the scope gap to a reference
   image, apply a **damped** primary correction (exposure / temperature / tint /
   contrast / saturation) with per-step ceilings + roll-back-on-worse +
   best-snapshot, re-measure, iterate. `match_reference` op in
   `useChromaControl.ts`; MCP `match_to_reference(reference, strength?, max_iters?,
   tolerance?)`. Primary only (a match is a balance) — creative/curve/mask work is
   separate. Detail: `docs/notes/match-reference.md`.
2. [x] **Per-mask blur** (D-027, 2026-09-01) — `blur` (0–100) on every mask's
   adjustments; the grade shader blends the masked region toward its existing
   ~40 px `structure_blur` pre-pass, weighted by `mask · blur/100` (approach (a):
   one struct field, ~20 wgsl lines, no new pass). Completes depth-haze
   (`handleAddDepthHaze` += `blur`) and unblocks "blur the background" as a mask
   op. Slider in `Details.tsx`, `set_mask_adjust` whitelist, new `add_mask` op.
   Limit: fixed radius, ungraded blur sample. Detail: `docs/notes/mask-blur.md`.
3. [x] **Rust-managed sidecar spawn** (D-028, 2026-09-01) — the app starts/monitors
   `ai/` (venv-aware), no manual `ai/run.sh`. Resolve python/venv → spawn
   `uvicorn` → pipe logs into `app.log` → poll `/health` → restart on crash with
   capped backoff → `child.kill()` on app exit. Detects + leaves an already-
   running external sidecar alone. `chroma_ai_status` for a future UI
   indicator. Detail: `docs/notes/sidecar-lifecycle.md`.
4. [x] **Strip `@clerk/react`** (D-029, 2026-09-02) — removed the community-login
   dep from the frontend. `<ClerkProvider>` + the hard-coded dev publishable key
   gone from `App.tsx`; `useUser`/`useAuth`/`useClerk` replaced with local
   null-returning stubs at the 3 call sites (`useAiMasking.ts`, `AIPanel.tsx`,
   `SettingsPanel.tsx`); the `<SignIn>` / `<CloudDashboard>` block in Settings
   replaced with a one-line "Chroma runs all AI locally" note. Dep dropped from
   `package.json` + lockfile. Kills the `<TitleBar>` React error and the Clerk
   dev-key warnings.
5. [x] **Smooth playback / proxy** (D-030, 2026-09-02) — one persistent
   `ffmpeg -f rawvideo` sequential-decode pipe per clip (`src/chroma/decode_pipe.rs`):
   forward step / short scrub = a single raw-frame read, jump = a keyframe-seek
   respawn, no per-frame PNG round-trip. Decode throughput ~1.6 → ~39 fps on C019.
   `chroma_seek` uses it (falls back to `video::decode_frame` on error). Export's
   `spawn_decoder` also seeks now (`-ss`+`-copyts`+timestamp `select`) so a
   `from > 0` range no longer decodes from frame 0, matte-safe. Proxy files
   deferred. Detail: `docs/notes/smooth-playback.md`.
   - [x] **Frontend regrade ceiling closed** (D-031, 2026-09-02) — the "per-frame
     frontend regrade + IPC" D-030 left open. Fused `chroma_play_frame` command
     (scaled decode + swap + one preview job = one IPC call), ~1280 px playback
     grade res (ffmpeg does the downscale, not the CPU), rAF wall-clock loop in
     `ChromaTimeline`. Headless harness on C019: **36.5 fps** at 1280 px (was
     14.5 fps at 4K); 50.9 fps at 960 px. Full-res on pause; scrub unchanged.
     Detail: `docs/notes/playback-30fps.md`.

Round 3 (after): [x] **`request_human` + a GUI "agent activity" feed**
(per-change diff + undo) (D-032, 2026-09-02) — every mutating bridge op records
one entry (summary + per-field grade diff + jump-to-here undo) in a new
`useAgentStore`; `request_human(reason, roi?)` is a non-blocking op/tool that
posts a banner + optional canvas ROI, cleared by the user, polled via
`get_state().pendingHumanRequest`.

[x] **Multi-shot session model + shot strip** (D-033, 2026-09-02) — a
process-global `Session { shots: Vec<Shot>, active }` in `chroma/state.rs`
(`current_video()` unchanged, returns the active shot; `set_current_video`
upserts by path), `chroma/session.rs` commands (list / add / set-active / remove
/ thumbnail), a frontend `useSessionStore` (per-shot grade cache + switch/copy
thunks) + `components/chroma/ShotStrip.tsx`, per-shot D-032 activity feeds
(`useAgentStore.scopeToShot`), MCP `list_shots` / `set_active_shot` / `add_shots`
(24 → 27). **Lightweight by decision** — the per-clip `grade.json` sidecar
(D-025) is still the on-disk per-shot document; no `.chroma` project bundle.
Deferred follow-ups: `.chroma/session.json` reopen (shot-path list, not a
bundle); drag-drop reorder; copy-grade-to-any-shot picker (v1 = to the next
shot); auto-load each shot's `grade.json` on add; stills as shots. Detail:
`docs/notes/multi-shot.md`. **The `.chroma/session.json` reopen deferral landed
as D-037** — the project model + launcher (`docs/notes/project-model.md`).

Multi-subject batch tracking (D-017) — **deferred to Phase 4** (2026-09-02, user
call): independent per-subject tracking already works; the remaining bit is a
pure perf optimization (batch N objects into one SAM propagation pass instead of
one pass each) that only matters when tracking 2+ subjects at once — niche for a
talking-head grade. Tracked under Phase 4.

Then: ~~mask keyframes~~ **[x] mask
keyframes (D-034, 2026-09-02)** — a shape sub-mask carries
`parameters.chromaKeyframes` (`[{frame, params}]`); the engine interpolates its
geometry per source frame at render time (one hook in `generate_sub_mask_bitmap`,
mirroring D-019), so it glides on scrub / playback / export. Linear scalars,
shortest-arc rotation, brush points lerp-or-snap. New `chroma/keyframes.rs`
(14 tests) + `utils/maskKeyframes.ts` + `components/chroma/MaskKeyframeBar.tsx`
(◆ button + diamond track) + interpolated canvas overlay + drag-writes-key. MCP:
`add_mask_keyframe` / `list_mask_keyframes` / `clear_mask_keyframe` /
`clear_mask_keyframes` (27 → 31). Deferred: grade-adjustment keyframing (separate
item), easing handles, keyframing mode/invert, a full dope sheet. Detail:
`docs/notes/mask-keyframes.md`.

[x] **Agent eval harness (D-035, 2026-09-02)** — a new top-level `eval/`: a
7-task data set (`tasks.json`) + an **offline** scorer (`score.mjs` — ports
`computeScopes`/`computeGap` from `scopes.ts` + an *approximate* primary-grade
operator so a `grade.json` scores with no app/agent/network) + a committed
`baseline.json` floor. Score = normalised inverse residual scope gap to the goal
with hard-fail gates (clipping introduced, mask background moved, over-grade).
The unfixed floor scores mean 0.452 (2/7); 7 hand-authored good grades score
0.975 (7/7, all up vs baseline); `bad_examples/` score 0.0 with gates firing —
the scorer ranks good ≫ bad offline. The closed loop (drive the agent over MCP →
`save_grade` → score) is a runbook, `eval/run.md`. MCP: added the adversarial
"assume the grade is still flawed" framing to `SCOPE_DISCIPLINE` / `inspect_color`
(tool count unchanged, 31). Zero engine changes. Detail:
`docs/notes/eval-harness.md`.

Then Phase 4 release (packaging/signing, external-reader docs + README + demo,
decide name/license/headline — D-002/D-007/D-010).

---

## Round 1 — done (2026-09-01)

1. [x] **Scopes + `inspect_color`** (D-021, 2026-09-01) — `app/src/utils/scopes.ts`,
   pure JS off the captured preview (not WGSL — the agent path, separate from the
   UI's Rust waveform). `computeScopes` (black/white points, luma + per-channel
   clip %, per-zone means, warm-cool + green-magenta cast, 12-bin hue histogram,
   mean saturation), parade + vectorscope PNGs, `computeGap` (reference→knob
   hints). MCP `inspect_color(frame?, reference?)` + `sample` / `sample_region`;
   every mutating op response now also carries `scopes`. Scope-first discipline in
   the tool docstrings + `mcp/README.md`. Detail: `docs/notes/scopes.md`.
2. [x] **Export** (D-022, 2026-09-01) — `app/src-tauri/src/chroma/export.rs`:
   one `ffmpeg -f rawvideo` decode pipe → `render_core::render` per frame (one
   GPU ctx + `OwnedRenderCaches` for the run; `transform_hash = frame`) → one
   `ffmpeg` encode pipe. ProRes 422 HQ (`prores_ks -profile:v 3`) / H.264
   (`libx264 -crf 18`). Per-frame tracked matte via `state::set_current_frame`
   before each grade (D-019). `bake_primary_lut` — `size³` identity lattice
   through the primary grade only → `.cube` (warns on dropped masked layers).
   Commands `chroma_export_video` (bg + `chroma_export_progress` poll) /
   `chroma_bake_lut`; frontend `export` / `export_progress` bridge ops; MCP
   `export(kind, path?, from?, to?)`. Detail: `docs/notes/export.md`.
3. [x] **Mask refinement = RapidRAW's composition** (D-023, 2026-09-01) —
   NOT a +/− point mechanism. "Subtract from Mask → Subject" already does
   edge-aware SAM exclude. MCP exposes it: `add_subject_mask(mode)`,
   `add_component(mask_id, type, mode)` (add a Subject/Radial/Linear/Brush
   sub-mask to an existing container, default subtractive), `set_submask_mode`.
   No +/− point UI built; the sidecar/engine `points` support stays unused.
4. [x] **Depth-haze preset** (D-024, 2026-09-01) — one action → a "Depth Haze"
   mask: a full-range `ai-depth` sub-mask **inverted** (mask value == distance),
   graded with negative `dehaze` (adds haze) + `saturation -25` + `blacks +10` +
   `shadows +8`, all × `amount`. Depth is a **static** bake (per-frame /
   temporal smoothing deferred); `chroma_seek` busts `ai_state.depth_map` so a
   re-apply on a new frame is correct. `useAiMasking.handleAddDepthHaze`, an
   "Add depth haze" button, MCP `apply_haze({amount?, protect_subject?})`. Also
   landed: `useChromaControl` mounted app-level + `open(path)` op. Detail:
   `docs/notes/depth-haze.md`.
5. [x] **`grade.json` schema + load/save** (D-025, 2026-09-01) —
   `app/src-tauri/src/chroma/grade.rs`. v1 = a **versioned, documented wrapper**
   around RapidRAW's `adjustments` (`{schema:"chroma.grade/1", shot, adjustments,
   notes}`), NOT `docs/06`'s ordered `stack` (that's the v2 node graph, D-005).
   Mask mattes externalized: static → `<name>.mattes/<subId>.png` (`{"$matte"}`),
   tracked → `{"$trackDir"}` (referenced, not copied). `chroma_save_grade` /
   `chroma_load_grade` + a `chroma.grade/<major>` migration gate. Frontend
   `get_grade` / `save_grade` / `load_grade` ops; MCP 3 tools. One grade per open
   clip — full session/shot model still open. Detail: `docs/notes/grade-json.md`.

---

## Phase 0 — Scaffolding & spikes  ·  ~1 week

- [x] Repo, submodule (RapidRAW → `engine/`), docs
- [x] `CLAUDE.md` working rules
- [x] Read `app/src-tauri` — first pass (`docs/09-engine-notes.md`): grade path mapped,
      AI stack is ONNX/`ort` in-process (D-009 revised), toolchain gap found (B-001)
- [x] **`rustup update`** (B-001 fixed → rustc 1.98.0); `cargo check` on `engine` passes clean (4m24s, 682 deps)
- [x] Deeper read: `gpu_processing.rs` (WgpuDisplay = D-006 answered), `shader.wgsl` (32-mask array, apply_dehaze, AgX), `mask_generation.rs` (JSON masks, base64 matte hook), frontend map — all in doc 09
- [x] **Spike D-006** — *not needed*: `WgpuDisplay` already renders to a native wgpu surface. Decided.
- [x] App builds (7m18s) + launches — window opens, ONNX runtime loads, no GPU errors. Frontend throws a `<TitleBar>` React error + Clerk auth warnings (the `@clerk/react` community-login dep — strip it early, irrelevant to Chroma). *(Stripped: D-029, 2026-09-02.)*
- [x] ffmpeg decode → 4K Rec709 frame from `C019.MOV` works (`scratch/frame_c019_10s.png`). The frame→grade half is blocked on **D-014** (render core is Tauri-coupled) — moved to Phase 1 task 1.
- [x] **SAM 2 running** (D-012 revised → Python sidecar via `ultralytics`, MPS): `ai/server.py` `/segment` produces a subject matte on the 4K C019 frame. YOLO auto-person + box + multi-point (+/−) prompts. Solves the hands problem (single frame).
- [x] **Matte edge refine** (D-016): SAM 2 staircases at 4K → added trimap → **ViTMatte** stage in `/segment` (`refine: true` default). Clean edge, ~2.8s warm. Worklog: `docs/notes/matte-edge-pipeline/`.
- [x] Fork model decided (D-003): standalone project, hard fork, no upstream coordination.

**Checkpoint:** a graded video frame on screen, the architecture spikes answered.

---

## Phase 1 — Video grading core  ·  ~3–4 weeks

- [x] `src/chroma/video.rs` — ffmpeg probe + single-frame decode (D-015). Tests pass on the real 4K C019 take.
- [x] **Minimal video-open path** — video loads as frame 0 into the existing pipeline; filmstrip + import filter accept video. Built, tests pass. Needs a visual confirm (open C019 in the app).
- [x] **D-014: `render_core` seam** — `src-tauri/src/render_core.rs`: `render(ctx, caches, base, req, …) -> DynamicImage` + `init_gpu_context()` (device+queue, no surface). `process_and_get_dynamic_image_inner` now takes `RenderCaches` not `tauri::State`. GUI path unchanged. Headless API unused until the control/MCP server.
- [x] Video I/O: per-frame grade → ProRes/H.264 encode (D-022, 2026-09-01);
      export decoder now seeks instead of walking from frame 0 (D-030, 2026-09-02).
- [x] Transport bar (`ChromaTransport`) — play/step/scrub; `chroma_seek` decodes the frame + re-renders with the grade. Decode via the persistent pipe (D-030); frontend stepper + per-frame regrade unchanged.
- [x] Timeline view (`ChromaTimeline`) — replaces the filmstrip when a video is loaded: a 48-frame thumbnail strip (`chroma_frame_thumbnails`, cached), click/drag to seek, playhead marker.
- [x] Smooth playback — persistent sequential-decode pipe (D-030, 2026-09-02;
      `src/chroma/decode_pipe.rs`) + fused `chroma_play_frame` command / reduced
      playback res / rAF wall-clock loop (D-031, 2026-09-02) — **36.5 fps on C019
      4K** in the headless harness. Proxy files deferred.
- [x] Shot / session model + `grade.json` load/save/validate — `grade.json`
      (D-025); multi-shot `Session` + shot strip + per-shot grade/feed (D-033,
      2026-09-02); **project model + launcher (D-037, 2026-09-02)** — a
      `<name>.chroma` dir (`project.json` + `thumb.jpg` + `grades/`), a project
      launcher replacing RapidRAW's Library view as the home screen, media
      referenced in place + relink for offline media, debounced autosave. Clip
      in/out points still open. The reserved per-project `settings` field is now
      a typed output spec — resolution / fps / colour space (**D-038,
      2026-09-02**; colour space stored + surfaced only, colour management stays
      D-004). Deferred polish: project rename/delete/duplicate + search from the
      launcher, drag-to-import, a Settings-panel folder row, batched open-time
      decode.
- [ ] Video canvas + transport in the GUI (play/scrub/step, playhead, in/out)
- [x] Shot strip (selector) — `components/chroma/ShotStrip.tsx` (D-033, 2026-09-02)
- [ ] Scopes: waveform, RGB parade, vectorscope, histogram (WGSL compute)
- [x] `.cube` bake of the primary grade (D-022, 2026-09-01 — `bake_primary_lut`)
- [ ] All inherited adjustment/mask panels working against a video frame, not a still

**Checkpoint:** grade a talking-head clip by hand, scrub it, export a `.cube` that matches in Palmier.

---

## Phase 2 — AI sidecar  ·  ~3–4 weeks

- [x] Sidecar service (FastAPI, `ai/`), `/segment` = SAM 2 → trimap → ViTMatte (D-016). Lifecycle: Rust-managed spawn + supervise (D-028, 2026-09-01) — `ai/run.sh` still works standalone.
- [x] **Depth for video — a real temporal depth track** (D-036, 2026-09-02). Not
      per-frame Depth Anything V2 + a hand-rolled EMA — a **temporally-consistent
      video-depth model** (Video Depth Anything — Small, vits, Apache-2.0), the
      same thing DaVinci Resolve's z-depth moved to. Runs in the `ai/` sidecar
      (`/depth_track` job mirroring `/track`, cross-frame attention is the
      "too-fragile-to-ONNX" case, D-009 precedent); per-frame depth PNGs cached
      to `<clip>/.chroma/depth/<key>/`, read at render time via `chromaDepthDir`
      (mirrors D-019). Scrub / playback / export get per-frame depth for free.
      `apply_haze` prefers the track when present; the Rust DA-V2 ONNX path stays
      as the static single-frame bake for stills / un-tracked haze.
      `docs/notes/depth-track.md`.
- [x] Engine wiring: `chroma_subject_mask(box)` → sidecar → matte → stored as an `ai-subject` mask (reuses RapidRAW's `AiSubjectMaskParameters` + mask-bitmap path). Box-drag on a loaded video routes here instead of ONNX SAM. `src/chroma/mask.rs` + `chroma_ai_health`.
- [x] Mask include/exclude refinement — **via RapidRAW's Add/Subtract/Intersect composition, not +/− points** (**D-023**). "Subtract from Mask → Subject" already does edge-aware SAM exclude. MCP: `add_subject_mask(mode)`, `add_component`, `set_submask_mode`. No point UI; `ai/` + engine `points` support stays unused.
- [x] Matte refinement pass — ViTMatte, D-016 (was: guided filter / RVM).
- [x] Per-frame subject tracking via **SAM 2 memory propagation** (D-018): prompt once, feed frames, ~180ms/frame mask. Sidecar `/track` (bg job, disk cache) + `/refine_track`.
- [x] **In-app tracking works end to end** (D-019): "Track subject across clip" → scrub → the matte + red overlay + grade follow the frame in lockstep. Matte read from disk at render time; `chromaTrackDir` persists with the project (no re-track on reopen). "Finalize matte" for the full-quality pre-export pass. Sidecar memory bounded (B-002).
- [ ] Multi-subject: two `ai-subject` masks each with their own `chromaTrackDir` should already work (untested); batch N objects into one propagation pass (`max_obj_num > 1`) so they don't each cost a full pass (D-017)
- [ ] `color-matcher` → reference match returns a CDL/curve fragment
- [x] **Depth haze preset** (D-024, 2026-09-01) — one action, depth-weighted desat +
      black-lift + dehaze + background defocus (per-mask blur, D-027). `docs/notes/depth-haze.md`
- [x] Mask keyframes in the data model + GUI handles (D-034, 2026-09-02) —
      `parameters.chromaKeyframes`, interpolated at render time; `MaskKeyframeBar`
      (◆ button + diamond track) + interpolated overlay + drag-writes-key + 4 MCP
      tools. `docs/notes/mask-keyframes.md`

**Checkpoint:** click "isolate subject" → tracked matte that holds through hand gestures; "add haze" → depth-graded background separation.

---

## Phase 3 — MCP + the agent loop  ·  ~2–3 weeks

- [x] **Control server + MCP bridge (D-020)** — `src/chroma/control.rs` (in-app HTTP) ⇄ Tauri events ⇄ `useChromaControl` (frontend owns the state). `mcp/` Python stdio server. One shared grade/mask doc: MCP edits move the app's real sliders/history, `get_state` reflects manual edits. v1 ops: primary, curves, wheels, seek, subject mask + track, per-mask grade, invert, delete. Verified with real `curl` + an MCP client against the C019 take.
- [ ] Tools: shot ops, ~~primary, curves, wheels~~, LUT, masks (~~subject~~ / shape / ~~depth (via `apply_haze`)~~), ~~scopes~~, match_to_reference, ~~apply_haze~~ (D-024), ~~export~~ (D-022), ~~open~~
- [x] Every mutating op returns `{image_b64, histogram, adjustments}` (image is a best-effort `generate_uncropped_preview` re-render — the app renders to a native WGPU surface)
- [x] `request_human(reason, roi)` handoff + the GUI "agent activity" feed with per-change diff + undo
      (D-032, 2026-09-02) — `useAgentStore` slice + a recording hook in `useChromaControl.ts`'s
      chokepoint (one entry per mutating op, `debouncedSetHistory.flush()` collapses
      `match_reference`'s N iters to one), `diffAdjustments` / `summarizeActivity`
      (`app/src/utils/agentActivity.ts`), a fixed bottom-left `AgentActivityDock` (feed +
      `request_human` banner) + `AgentRoiHighlight` on the canvas. `request_human` op/tool is
      non-blocking; undo is jump-to-here (drops newer feed entries; documented history-cap
      fallback). Detail: `docs/notes/agent-activity-feed.md`.
- [x] Agent eval: a scripted brief → measure round-trips to an acceptable grade (G1, G2)
      (D-035, 2026-09-02) — `eval/` task set + offline scorer + committed baseline; closed
      loop is `eval/run.md`. See `docs/notes/eval-harness.md`.

**Checkpoint:** a full talking-head grade (primary + tracked subject + depth haze + shot match) done in one Claude Code conversation + <5 min human mask cleanup. **This is v1.**

---

## Phase 4 — Harden & release v1  ·  ~2 weeks

- [x] Strip the `@clerk/react` community-login dep from the frontend (D-029, 2026-09-02; pulled forward to round-2 item 4)
- [x] Rust-managed sidecar lifecycle — spawn/monitor `ai/` from the app, no manual `ai/run.sh` (D-028, 2026-09-01; pulled forward from round-2 item 3)
- [x] Control-server bridge: mount `useChromaControl` at app level (2026-09-01, D-024) —
      moved from `Editor` to `App`; `/op` now works before a file is open. Paired with a
      new `open(path)` op so a clip can be loaded headlessly.
- [x] **Project model + launcher (D-037, 2026-09-02)** — `<name>.chroma` dir
      (`project.json` + `thumb.jpg` + `grades/`), a launcher home screen
      replacing RapidRAW's Library view, media referenced in place + relink,
      debounced autosave, MCP `list_projects` / `open_project` / `new_project` /
      `save_project`. Completes D-033's deferred session persistence. The
      reserved `settings` field is now a typed per-project output spec
      (resolution / fps / colour space) — **D-038, 2026-09-02**. Deferred
      polish: launcher rename/delete/duplicate/search, drag-to-import, a
      SettingsPanel folder row, batched open-time per-shot decode.
- [ ] Multi-subject **batch** tracking (D-017) — one SAM propagation pass for N objects (`max_obj_num > 1`, `obj_ids` per mask) instead of one pass each; deferred from round 3 (2026-09-02) as a perf-only optimization
- [ ] OTIO or a simple session import from Palmier (grade the shots the editor cut) — now lands *into* a `<name>.chroma` project (D-037)
- [ ] ProRes export round-trip verified with `swap_clip_media`
- [ ] Packaging: signed macOS build, the sidecar + its Python bundled, models auto-downloaded
- [ ] `docs/` cleaned for external readers; a real README with a 90-second demo
- [ ] Decide: name (**D-010**), license (**D-002**), v1 headline feature (**D-007**)
- [ ] Ship. Get one external user. Open the issue tracker.

**v1 = done when:** the Phase 3 checkpoint (full talking-head grade in one Claude
conversation + <5 min human cleanup) passes on 3 real clips, export round-trips to
Palmier, and it's a signed installable build.

---

## Beyond v1 (see `docs/02-scope.md` v2/v3)

- Node graph, ACES/HDR (OpenColorIO)
- CoTracker planar tracking + tracker GUI, bezier roto
- Film-emulation chain (port ComfyUI-Darkroom science)
- Windows/Linux, batch/headless mode
- OFX plugin export (the gyroflow model — grade node in Resolve/Fusion/AE)
- Public MCP contract, web review viewer

---

## Risks & how we de-risk

| Risk | Mitigation |
|---|---|
| Tauri video presentation is too slow / too hard | Phase 0 spike D-006 *first*; fallback = separate native window for the canvas |
| SAM 2 matte quality poor on real footage | Phase 0 spike; fallback = SAM2 + heavy matte refinement, or interactive-segmenter click prompts |
| RapidRAW's still-centric architecture fights the video model | Phase 0 code-read; fallback = use its engine as a crate, new video-first shell (Path C) |
| AGPL blocks a direction we want later | decide license intent now (D-002); AGPL is fine for "open project", accept the SaaS limitation |
| Solo-dev bandwidth | v1 scope is deliberately tiny (one footage type, one platform); everything else is later |
| RapidRAW maintainer objects to a fork | it's AGPL, forking is allowed; but reach out first (D-003) — collaboration beats a fork |

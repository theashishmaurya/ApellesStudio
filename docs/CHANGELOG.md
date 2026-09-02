# CHANGELOG

One or two lines per session. Detail lives in the decision it references.

## [Unreleased]

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

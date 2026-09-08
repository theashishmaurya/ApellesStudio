# 03 — Architecture

Status: **current** (rewritten 2026-09-02; feature-status and crate-graph reconciliation
2026-09-08, **D-231**). Describes the system **as it actually is** today, per `CLAUDE.md`'s
hard rule — not the aspirational end state. Where something is planned but not built, it's
marked **future** and pointed at `docs/04-roadmap.md`, not described as live.

> **What the 2026-09-08 pass changed, and why you should trust the numbers below.** The
> 2026-09-02 version of this file was structurally right and factually six days out of
> date: it said only 3 crates existed (8 do), that the Editor was a single-track MVP (it's a
> multi-track NLE), that Motion was a placeholder tab with no UI (it's a real authoring tab
> with a keyframe timeline), and that there were 38 MCP tools (there are 95). Every count
> and status claim in this file was re-derived on 2026-09-08 from `crates/*/README.md`,
> `packages/*/README.md`, `mcp/server.py` and `docs/04-roadmap.md` — not carried forward.

The full reasoning behind this shape lives in `docs/08-decisions.md` **D-039** (the pivot
itself) and `docs/notes/architecture-lock.md` (the crate/package lock this file mirrors) —
this doc is the readable summary + current-state snapshot, not a duplicate of either.

## The pivot, in one paragraph

Chroma started (2026-09-01) as a grading-only tool: fork RapidRAW (a photo RAW editor,
Rust/wgpu/Tauri), add video + AI masking + an agent bridge, ship a colorist. The workflow
this project itself runs on — script → cut → motion graphics → grade → publish — leaned on
Palmier Pro for the cut. On 2026-09-02 Palmier announced it's going closed-source and
commercial. Rather than stay a grading sidecar to someone else's closing editor, the owner
decided (**D-039**) Chroma becomes the editor too: **one AI-native, local app, three
tabs — Edit / Motion / Colorist** — general-purpose, not talking-head-only. This
supersedes `docs/00-vision.md`'s old "not an NLE" clause.

## System shape

```
┌───────────────────────────────────────────────────────────────────────────────┐
│  Chroma (Tauri desktop app)                                                    │
│                                                                                │
│  ┌──────────────────────────── @chroma/shell ─────────────────────────────┐   │
│  │  window chrome (traffic lights / drag region) · tab switcher            │   │
│  │  no project open → the project launcher fills the window (D-037)        │   │
│  └──────┬───────────────────────┬───────────────────────────┬─────────────┘   │
│         │                       │                            │                │
│    ┌────▼─────┐          ┌──────▼──────┐              ┌──────▼───────┐        │
│    │  Edit    │          │   Motion    │              │   Colorist    │        │
│    │@chroma/  │          │ @chroma/    │              │  app/src/     │        │
│    │ editor   │          │  motion     │              │  (RapidRAW    │        │
│    │multi-trk │          │ authoring   │              │  fork, grade  │        │
│    │   NLE    │          │    tab      │              │  editor only, │        │
│    │          │          │             │              │  D-043)       │        │
│    └────┬─────┘          └──────┬──────┘              └──────┬────────┘        │
│         │                       │                            │                │
│  CPU compositor →          packages/motion-engine       wgpu native surface    │
│  binary IPC preview          (Remotion, 8 layer         (D-006) + the         │
│  (chroma-timeline +           primitives, multi-scene    grade renderer,      │
│   chroma-media)               JSON manifest compiler)    AI masks/tracking    │
│                                    │                                           │
│                              chroma-motion crate → npx remotion render         │
└──────────────────┬───────────────────────────────────────┬────────────────────┘
                    │                                       │ local HTTP :19788
                    │ subprocess (ffmpeg)                   │ (chroma/control.rs, D-020)
          ┌─────────▼─────────┐                    ┌────────▼──────────┐   ┌──────────────┐
          │  ffmpeg / ffprobe │                    │  mcp/server.py    │   │  ai/ sidecar │
          │  decode·probe·    │                    │  (Python stdio    │◄─►│  FastAPI     │
          │  encode, spawned  │                    │  MCP, 95 tools)   │   │  :8765, SAM2/│
          │  as a subprocess  │                    └────────┬───────────┘   │  ViTMatte/   │
          └───────────────────┘                             │               │  VDA depth,  │
                                                    ┌────────▼──────────┐    │  Rust-       │
                                                    │  Claude Code /    │    │  supervised  │
                                                    │  any MCP client   │    │  (D-028)     │
                                                    └───────────────────┘    └──────┬───────┘
                                                                                    │
                                                                        ┌───────────▼──────┐
                                                                        │ ai-media/ sidecar│
                                                                        │ transcript +     │
                                                                        │ video analysis   │
                                                                        │ (D-189, 2nd one) │
                                                                        └──────────────────┘

Per project: ~/Movies/Chroma/<name>.chroma/  (project.json + thumb.jpg + grades/*.grade.json)
```

## The monorepo (D-039 workspace skeleton, D-040 de-submodule)

`chroma/` is one repo, no submodule. The RapidRAW fork is **vendored at `app/`** (D-040:
de-submoduled 2026-09-02, working tree moved verbatim from the old `engine/` submodule;
pre-fold history lives in `engine-history.bundle`, gitignored; upstream RapidRAW is now
tracked **manually**, no live remote).

```
chroma/
  Cargo.toml            ← virtual [workspace] — members: app/src-tauri, crates/*
  Cargo.lock            ← the workspace lock (was app/src-tauri/Cargo.lock)
  package.json          ← npm workspaces — app, packages/*
  app/                  ← the vendored RapidRAW fork (AGPL-3.0), renamed npm pkg @chroma/app
    src/                ← React/TS frontend — where the Colorist tab's real UI still lives
    src-tauri/           ← the Tauri Rust crate (still `[package] name = "RapidRAW"` — rename
                            is a later step), src/chroma/ holds every Chroma-original module
  crates/               ← Chroma's own layered Rust crates — see table below
  packages/             ← Chroma's frontend workspace — see table below
  ai/                    ← the Python AI sidecar (SAM2, ViTMatte, Video Depth Anything, relight)
  ai-media/               ← the SECOND supervised sidecar (D-189) — transcript (mlx-whisper)
                             + video understanding (Qwen3-VL). A separate process on purpose:
                             D-189 rejected bolting these onto `ai/` (different model stack,
                             different failure modes, different memory profile)
  mcp/                    ← the Python MCP server — 95 tools across Colorist, Edit and debug
  eval/                   ← the agent grading eval harness (D-035) — offline, CI-able
  docs/  scratch/
```

Rules for the fork at `app/` (unchanged from D-003, narrowed by D-043):
- AGPL-3.0 (→ `CyberTimon/RapidRAW`). Cherry-pick upstream fixes by hand when wanted.
- New files/modules over scattered edits; every divergence logged in
  `docs/09-engine-notes.md`.
- **D-043 override, scoped to the DAM/shell layer only:** RapidRAW's photo-library shell
  (welcome screen, folder-tree "Sources" panel, album/culling UI, the web Community
  presets page, all RapidRAW branding) was deleted outright from the Colorist tab
  (−7,836 LOC) — it will never run again in a video-first, 3-tab app, and keeping it
  routed was actively misleading (RapidRAW's own "Home" screen was reachable from inside
  Chroma). The **grading engine itself** (wgpu shader, adjustment model, masks, curves,
  wheels, LUT, canvas/preview, scopes) is untouched and stays cherry-pick-able.

## Rust workspace — `crates/`

Thin-shell / fat-core (the Gyroflow model): the Tauri app is glue, every real capability is
a library, domain models are pure Rust (no `wgpu`, no `ffmpeg`). The dependency direction is
one-way and is the law (`CLAUDE.md`): **`app → tabs → services → domain → media/gpu →
types`**. No cycles, no cross-layer reaching.

**8 of the ~11 planned crates now exist, and 6 of those are real, load-bearing code**
(waves 1–3 of the extraction landed 2026-09-05, D-143 through D-148). `crates/README.md` is
the authoritative per-crate table with deps and module lists; this is the summary.

| layer | crate | exists? | responsibility |
|---|---|---|---|
| L0 | `chroma-types` | **yes, real** | `Resolution`, `Rational`, `ChromaError`, the `fade` bezier model (D-147), the `pan` law (D-223), the `eq` band model + cookbook biquads (D-224). `Frame`/`ColorSpace`/`TimeRange`/typed IDs stay undesigned — the audit found no real duplicate to unify. Zero heavy deps. |
| L0 | `chroma-gpu` | **yes, partial** (D-144) | headless wgpu device/queue/limits (`init_gpu_context`). **No display surface** — `WgpuDisplay` is a GUI concept and stays app-side; `GpuContext` really did split into two structs. No `render()` (that's `chroma-grade`'s). |
| L1 | `chroma-media` | **yes, real** (D-146) | ~3,900 lines: `conform` (the *single* definition of "source frame N", D-228), `video` (ffprobe + ffmpeg decode, D-015), `decode_pipe` (D-030/D-125), `media_cache` (persistent disk cache, D-128), `probe`, `filmstrip` (D-134), `audio` (symphonia→rubato→cpal engine + waveforms). Export encode still app-side. |
| L1 | `chroma-grade` | future | the grade **renderer** — wraps the `app/` shader + adjustments↔uniform bridge + masks + scopes (D-021) |
| L1 | `chroma-compositor` | future | multi-layer **wgpu** blend + transitions, then `chroma-grade` per output frame. **Not built — the Edit tab composites on the CPU today** (D-217). This is the single largest remaining architectural gap. |
| L2 | `chroma-timeline` | **yes, real** (D-041 → D-229) | the OTIO-*shaped* edit model: tracks / clips / gaps / markers / transitions, ripple / roll / slip / slide / split / trim, per-clip transform + crop + fades + volume/pan/EQ fields, fps conversion. **Pure** — no probing, no I/O; callers pass frame counts. |
| L2 | `chroma-grade-model` | **yes, real** (D-143) | the `grade.json` document (D-025) — save/load, the schema-migration gate, matte/track/depth-ref externalization. **Pure**, and deliberately untyped past the envelope (the canonical shape is the frontend store's). |
| L2 | `chroma-project` | **yes, real** (D-148) | the `.chroma` project (D-037) + settings (D-038): `ProjectManifest`/`MediaItem` (+ the legacy read-only `ProjectShot`, D-070), atomic save, every schema migration, the media pool + bins, timeline lifecycle. Depends on `chroma-media` (probe/thumbnail) — an edge the lock doc's table had been missing. |
| L2 | `chroma-motion` | **yes, real** (D-046) | manifest → Remotion render bridge: shells out to `npx remotion render` inside `packages/motion-engine/`. The one deliberate "the fat core is not Rust" exception in the whole architecture. |
| L3 | `chroma-ai` | **yes, real** (D-145) | the `ai/` sidecar client: `sidecar` (spawn/health/backoff/respawn + the D-101 content-hash staleness check), `mask` (SAM2/ViTMatte HTTP + per-frame matte lookup), `depth` (VDA track). Generalized by D-190 to supervise **N** sidecars, which is how `ai-media/` got supervised without a copy-paste. |
| L3 | `chroma-agent` | **rescoped out** (D-141) | *not* a future crate on the current plan: `control.rs` has no Tauri-free core and its op registry lives in the frontend. Left in `app/src-tauri` + `packages/*` deliberately. |
| L4 | `chroma-app` (`app/src-tauri`) | **yes** | the Tauri binary: every `#[tauri::command]` (a real `tauri-macros` constraint keeps them here, D-141), plus whatever isn't extracted yet. |

**Why commands stayed in the app** (D-141, and it is the rule that shapes every extraction):
a Tauri command's macros are exported at its *defining* crate's root, so a crate hosting one
needs a real `tauri` dependency — and any command taking `tauri::State<AppState>` would
create a crate → app cycle. So the pattern is always **the logic moves down, the
`#[tauri::command]` wrapper stays up**.

`app/src-tauri/src/chroma/` today — what has *not* been extracted, plus the command
wrappers over what has: `commands.rs`, `control.rs` (D-020), `debug_capture.rs` (D-210),
`edit.rs` (D-041, timeline resolution — a layer above media), `export.rs` (D-022),
`ffmpeg_run.rs`, `grade.rs`, `keyframes.rs` (D-034), `load.rs`, `media_understanding.rs`
(D-189), `mod.rs`, `motion.rs` (D-047), `playback.rs` (D-031), `relight.rs` (D-048),
`session.rs` (D-033), `state.rs`, `text.rs` (D-212), `write_text_file.rs`. Several files
Five more files here are now **pure re-export shims** over the crates and nothing else —
`video.rs`, `media_cache.rs`, `decode_pipe.rs`, `filmstrip.rs`, `sidecar.rs` (9–34 lines
each, verified 2026-09-08). Deleting them and retargeting every call site at
`chroma_media::` / `chroma_project::` is **"wave 4,"** the only remaining mechanical
migration step (`docs/04-roadmap.md`, "Then — the deeper migration"). Four others are
*partial*: `project.rs` (~1.7k lines) and `audio.rs` (~1.4k) keep a real app-side half each
(the Tauri command wrappers, and the timeline-resolution logic D-146 deliberately left
above the media layer), while `mask.rs` and `depth.rs` keep a thin app-side remainder over
`chroma-ai`.

## Frontend workspace — `packages/`

npm workspaces, mirroring the Rust split. `app/` (`@chroma/app`, the vendored RapidRAW
frontend) is also a workspace member — it's still where the Colorist tab's real UI lives.

**11 packages exist**, up from 6 on 2026-09-02 — `debug`, `history`, `inspector` and
`player` are all new since. Per-package detail is in each `packages/*/README.md`.

| package | exists? | what it holds today |
|---|---|---|
| `@chroma/tokens` | **stub** | still a placeholder export — theming really does still live in `app/src/styles.css`. The one package that has not moved since D-039 |
| `@chroma/ui` | **yes, real** (D-042) | shadcn/ui on Base UI — ~18 structural components (Button, Dialog, DropdownMenu, ContextMenu, Tooltip, Popover, Tabs, Select, Command, Resizable, Sheet, Slider, Switch, ScrollArea, Separator, Input, Label, Sonner) + 5 rebuilt RapidRAW primitives, themed onto the existing `--app-*`/`--color-*` vars. Craft-specific grading controls (ColorWheel, LUTControl, DepthRangePicker) stay in `app/` |
| `@chroma/bridge` | **partial** | the frontend↔backend seam. Real content: `useMediaPoolStore` (D-044/045/046) and local-only telemetry (D-093). `useChromaControl` (D-020) is *still* `app/src/hooks/useChromaControl.ts`, not extracted — the longest-standing item on this table |
| `@chroma/shell` | **yes, real** | window chrome (traffic lights / Win-Linux controls / drag region), the 3-tab switcher, the project-launcher entry-screen routing, and the docked Sources panel (D-046, moved left + made resizable by D-116) |
| `@chroma/editor` | **yes, real** (D-041 → D-228) | the whole Edit tab: `TimelinePane` (the `react-timeline-editor` strip + `@dnd-kit` drag layer, markers, transitions, fade handles, marquee), `PreviewPane` (+ transform overlay, canvas boundary, click-to-select, zoom), the Inspector panels, `useEditorTimelineStore`, the pure edit-op model (`timeline.ts`), the ffmpeg **export compiler** (`timelineExport*.ts`), the FCPXML compiler (`timelineInterchange.ts`), and `useEditorControl.ts` (the `editor_*` MCP op registry) |
| `@chroma/player` | **yes, real** | `<Player>` — the shared viewport + title strip + transport bar. **Presentational only**: no `invoke`, no zustand, no decode. Each tab supplies its own frame surface; Editor is still the main consumer |
| `@chroma/motion` | **yes, real** (D-047 → D-182) | the whole Motion tab: `@remotion/player` embed, `MotionCanvasOverlay` (select/drag/resize/marquee), `KeyframeTimeline` + `EaseCurveEditor`, `LayerList` (+ thumbnails, drag-reorder), `CatalogPanel`, `InspectorPanel`, the manifest editor, and `useMotionControl.ts` (the `motion_*` op registry) |
| `@chroma/motion-engine` | **yes, real** | the Remotion project, moved in from `videoAgent/engine/motion/` — **8 layer primitives** + the multi-scene JSON manifest compiler (`src/engine/build.ts`) + its `zod` schema, which is the single source of truth for manifest shape (the `chroma-motion` crate deliberately does not re-validate) |
| `@chroma/inspector` | **yes** (D-103) | *only* the two genuinely shared Inspector chrome components (`InspectorEmptyState`, `InspectorSection`). Deliberately **not** a unified Inspector — D-103 explains why forcing one polymorphic panel across tabs was rejected |
| `@chroma/history` | **yes** (D-052) | shell-level global undo/redo: a generic `{tab, label, undo, redo, ts}` stack shared by all 3 tabs. Knows nothing about grades or timelines. **Motion does not push to it yet** (roadmap item 16.4) |
| `@chroma/debug` | **yes** (D-219) | the `debug_*` control-server op registry — drive real UI state, dump the real DOM, time the preview. **Dev-only by construction**: `import.meta.env.DEV` + a dynamic import, so it is dropped from a production bundle |
| `@chroma/colorist` | future | the Colorist tab's adjustment panels / scopes / mask editor still live in `app/src/`, not extracted. The largest un-extracted frontend surface |
| `apps/desktop` | future | `app/` plays this role today (the Vite entry `src-tauri` serves) |

Run it: `npm run tauri:dev` from the repo root.

## The three tabs — what's actually live

### Colorist — the grading engine (most mature)

The full pre-pivot build, now scoped to grading only (D-043 removed the inherited
photo-DAM shell around it): primary/curves/wheels/LUT, masks (shape + AI subject,
composable via Add/Subtract/Intersect — D-023, keyframeable — D-034) — SAM 2 + ViTMatte
subject tracking (D-012/016/018), a per-frame temporal depth track via Video Depth
Anything-Small (D-036, Apache-2.0 checkpoint only), scopes + `match_to_reference`
(D-021/026), a depth-haze preset (D-024), a live scopes panel (luma/RGB/parade/vectorscope/
histogram, `ControlsPanel.tsx` → `Waveform.tsx`), **interactive depth-driven relight pucks**
(D-048, made physically real by D-077/D-078/D-079's MoGe-2 surface normals + 3D falloff),
export to ProRes/H.264 + a `.cube` bake (D-022), `grade.json` (D-025), an agent activity
feed with jump-to-here undo + `request_human` (D-032), and an eval harness scoring the
grading agent offline (D-035). MCP surface: **42 tools** (`mcp/server.py`).

**Video presentation.** wgpu renders straight to a native surface positioned under the
webview (D-006) — the webview only holds UI chrome, so a full-4K graded frame never
IPC-copies through React. Scrub uses `chroma_seek` + the persistent per-clip decode pipe
(D-030, ~39 fps sequential decode vs ~1.6 fps of per-frame spawns). Real-time playback
(≥30 fps) is a **fused decode+grade+scale command** (D-031, `chroma_play_frame`) driven by
a `requestAnimationFrame` wall-clock loop — one IPC call per frame, decoding straight to a
~1280 px playback resolution so the WGSL grade doesn't pay full-4K cost every frame; pause
re-settles full-res. Export re-uses `render_core` (D-014) headless, at full resolution,
through one persistent ffmpeg decode pipe → grade → one persistent ffmpeg encode pipe
(D-022) — no per-frame process spawns, no temp files.

**Tracked/keyframed reads are render-time, not per-seek state.** A SAM2 track
(`chromaTrackDir`), a VDA depth track (`chromaDepthDir`), and mask keyframes
(`chromaKeyframes`) are all read by the render path itself, keyed off
`chroma::state::current_video().frame` — one hook each in the mask-generation path
(D-019's pattern, reused verbatim by D-034 and D-036). This is deliberate: it keeps frame
and matte in lockstep through scrub, playback, and export for free, with zero per-frame
frontend state churn — the alternative (swapping matte data into `adjustments` on every
seek) was tried first and rejected for exactly the desync/render-storm bugs D-019
documents.

### Editor — a real multi-track NLE

`chroma-timeline` backs a **multi-track** timeline (video *and* audio tracks) that persists
inside the `.chroma` project (`ProjectManifest.timelines: Vec<Timeline>` + `active_timeline`,
D-045). The `@xzdarcy/react-timeline-editor` strip is still a pure control surface — no
video frames flow through it — with `@dnd-kit` layered over it for every drag (D-100
unified same-track, cross-track, track-reorder and transition-palette drags onto one
mechanism after two rounds of racing drag systems).

**The compositor is CPU, not GPU, and that is the defining architectural fact of this tab.**
Frames are composited in Rust (alpha-over, real z-ordered stacking — D-086/D-088), then
handed to the webview as a **binary IPC payload**, not base64 (D-217). `chroma-compositor`
(the wgpu engine in the crate table above) does not exist yet; when it does, this is the
path it replaces. The preview stays **independent of the Colorist's wgpu/grade path** — the
Edit tab needs "give me composited timeline frame N fast," not a graded frame, and the two
tabs remain two separate passes over two separate models.

Real, verified capabilities (see `docs/02-scope.md` for the itemised list with `D-NNN`s):
ripple/roll/slip/slide/split/trim, multi-select + marquee, cross-track ripple + sync-lock,
A/V linking, per-clip transform + crop + independent width/height, per-property keyframes,
on-canvas transform handles + click-to-select, fades with bezier curves, transitions
(bridging a cut, never overlapping — D-226), markers, text/title clips, a real audio path
(device playback, per-clip volume/pan, 4-band EQ, track gain, ducking), and export either to
a real video file (with its audio mixed in, D-197) or to FCPXML 1.7 for interchange (D-196).

**One model, two engines — the constraint that shapes most of this tab's bugs.** The live
preview is Rust; the export is a TypeScript compiler that emits an ffmpeg filtergraph
(`packages/editor/src/timelineExport*.ts`). Every visual or audible feature must therefore
be implemented *twice*, and the two must agree — which is why features here land with
measured cross-engine verification (D-224's shared EQ response table, D-226's mid-dissolve
pixel measurement, D-223's `volumedetect` on real exported files) rather than a unit test
alone. A drift between the two is a real defect class, not a theoretical one.

**Not built:** GPU compositing, grade-in-preview, OTIO export, a transcript-driven cut.
Roadmap item 27 tracks the list. (Subtitles/captions were on this list and landed as D-229
while this pass was being written — a fair illustration of why these docs drift. Adjustment
clips followed as D-230; **speed ramps** as D-236, and their reverse and live-audio-retime
follow-ups as D-240/D-241 — that entry is a good example of the drift being *specific*:
the list said "a flat export-time override exists", which was true of D-183 and stopped
being true the moment `Clip.speed_points` landed.)

### Motion — a real authoring tab

`packages/motion-engine/` (moved in from `videoAgent/engine/motion/`, D-039 step 1) is the
Remotion project: **8 layer primitives** (`text`, `emphasis`, `matrix`, `graph`, `layers`,
`particleflow`, `labelbox`, `layerstack`), a **multi-scene** JSON manifest + compiler, and a
`zod` schema that is the single source of truth for manifest shape.

`@chroma/motion` is now a full authoring surface over it, in four resizable panes (preview /
sidebar / Inspector / manifest editor), with the preview pane itself split vertically over a
per-row **keyframe timeline** — deliberately mirroring `@chroma/editor`'s own
preview-over-timeline stack. Built: scene management (add, preview one scene as its own
0:00-start clip, render each scene to its own file — D-179/D-180/D-181), a layer list with
drag-reorder + real thumbnails (D-177), a **Catalog** that creates layers (D-151 — before
it the tab could edit everything and create nothing), a typed Inspector, on-canvas
select/drag/resize/marquee in world coordinates (D-155–D-158), and a bezier ease-curve
editor (D-164). Rendering goes through the `chroma-motion` crate → `npx remotion render`,
and the output auto-imports into Sources (D-062).

**Why Rust wraps Node here, and nowhere else.** The Remotion engine *is* the fat core for
motion graphics — reimplementing it in Rust would throw away real, working, non-trivial code
to satisfy an architectural preference. `chroma-motion` is the one deliberate exception to
"the fat core is Rust" in this whole architecture (D-046).

**The gap: 0 MCP tools.** The 18 `motion_*` ops are real, live-verified, and sit in
`useMotionControl.ts` on the same control-server bridge everything else uses (D-167–D-171) —
but the Python `@mcp.tool()` wrappers in `mcp/server.py` were never written, so an MCP
client cannot call any of them. Motion is the one tab an agent cannot drive. Recorded in
D-170's own closing note and `docs/notes/mcp-tool-coverage.md`; it is the tab's sharpest
remaining gap and the one place the "every feature is for a human AND an AI" rule
(`CLAUDE.md`) is currently unmet on shipped functionality.

### Shell — the app chrome

`@chroma/shell`: 3-tab layout (Edit / Motion / Colorist, `edit` first per owner request),
the window title bar (traffic lights, drag region, Win/Linux controls), and routing. The
project launcher (D-037) is the app's **entry screen**, not a view inside a tab — the app
opens on a grid of saved `<name>.chroma` projects; opening/creating one flips the shell
into the 3-tab layout. All 3 tab panels stay mounted (hidden) under the launcher, so *every*
tab's MCP control bridge keeps running even before a project is opened from the GUI (B-007).
The shell also owns the **docked Sources/Library panel** — the one genuinely shell-level
panel, since it is shared by all three tabs (D-046; moved to the left edge and made a real
resizable panel by D-116, matching the media-bin-left convention Premiere/Resolve/Final Cut
all share). Each tab's own Inspector deliberately stays tab-local instead (D-118), so
`Shell.tsx` never learns what a clip or a layer is. Global undo/redo is shell-level too
(`@chroma/history`, D-052). `@chroma/ui` (D-042, shadcn/Base UI) is the shared component kit
new UI is built on.

## Data model

### The project — a `<name>.chroma` directory (D-037)

Not a bundle/zip/sqlite file — a plain directory of git-diffable JSON, matching the
project's existing bias toward inspectable, `rsync`-able files:

```
~/Movies/Chroma/<name>.chroma/
  project.json    schema "chroma.project/1" — { name, created, modified,
                  media: [{id, sourcePath, name, folder?, video?}],  ← the pool (D-044/045)
                  timelines: [{id, name, tracks: [...], markers, transitions}],
                  activeTimeline: usize,                             ← Edit (D-045)
                  activeClipId,                    ← which clip Colorist grades (D-070)
                  settings: {width?, height?, fps?, colorSpace?},    ← D-038
                  shots: [...], activeShot: usize } ← LEGACY, read-only since D-070;
                                   kept only so a pre-D-070 project still opens
  thumb.jpg       a frame from the active/first clip — the launcher card
  motion/manifest.json   the Motion tab's scene manifest (D-047, one per project)
  grades/
    <clipId>.grade.json    each clip's grade, chroma.grade/1 (D-025), verbatim
    <clipId>.mattes/       externalized static mask PNGs ($matte refs)
```

Media is **referenced in place** by absolute path, never copied — a missing file flags
that shot "media offline" (relink, not fatal) rather than breaking the project. Per-shot
grades live *inside* the project directory (they belong to this grading job, not the
source clip, which may be read-only or on a scratch disk); tracked-matte and depth-track
caches (`chromaTrackDir`/`chromaDepthDir`) stay *next to the source clip* at
`<clip>/.chroma/{mattes,depth}/` since they're per-clip precomputes, reusable across
projects.

**Clip identity is now unified — this is no longer the two-list gap the 2026-09-02 version
of this file described.** D-044 deferred it, D-046 then made `ProjectShot` reference a
`MediaItem` by id, and **D-070** finished the job: `chroma_timeline::Clip` replaced
`ProjectShot` outright, grades key off the clip, and the Colorist's "active clip" routes
through the same top-wins resolver (`resolve_active_clip_index` / `top_wins_clip_index` in
`chroma-project`). The trigger was a real repro — a clip dragged onto the Edit timeline
didn't appear in the Colorist at all — and the investigation found a **four**-way identity
split, not the two-list one it looked like (`docs/notes/unified-clip-model.md`).

What is still *not* unified is the **render path**, not the identity: Edit composites and
Colorist grades in two separate passes over two separate engines, and there is no
grade-in-preview on the Edit timeline. That is roadmap item 8, and it is a different problem
from the one this paragraph used to describe.

### `grade.json` (D-025)

A versioned wrapper around RapidRAW's flat `adjustments` document — `{schema:
"chroma.grade/1", shot: {...}, adjustments: {...}, notes}` — **not** the ordered
`stack[]` model `docs/06-grade-format.md`'s draft sketched (that's the v2 node-graph data
shape, D-005; deferred). This is the "grade is code" differentiator: one knob change is a
one-line git diff. Mask mattes are externalized to `.mattes/<subId>.png` +
`{"$matte": "..."}` refs so the JSON itself stays small and diffable; tracked/depth
directories are referenced the same way (`$trackDir`/`$depthDir`).

### Session vs. project

`chroma::state::Session { shots: Vec<Shot>, active }` (D-033) is the **in-memory, runtime**
form — what's actually loaded and being graded right now. A saved project (D-037) is what
a session persists to and reloads from. A loose clip opened without a project (file picker
or MCP `open(path)`) is a session with no project — an "Untitled" quick-open that seeks,
plays, exports, and tracks exactly like a saved one, just without autosave.

## The AI sidecar (`ai/`)

A local FastAPI service on `:8765`, Rust-supervised (D-028: spawned, health-polled, crash
-restarted with backoff, killed on app exit; an already-running external sidecar is
detected and left alone rather than fought). Runs:

- **SAM 2.1** (via `ultralytics`, not the raw Meta package) — image segmentation +
  **video memory propagation** for subject tracking (D-018), refined through a
  YOLO-box → SAM → trimap → **ViTMatte** pipeline for a clean 4K edge (D-016) — the "hands
  problem" this project started to solve.
- **Video Depth Anything — Small** (`vits`, Apache-2.0 only — `vitb`/`vitl` are
  non-commercial and must never be used) for a temporally-stable per-frame depth track
  (D-036), vendored (not pip-installable) since it isn't a plain ONNX export.

**Depth Anything V2 (single-frame) stays in-process ONNX in Rust** (via `ort`, D-009) —
that model *does* have a clean ONNX export and needs no sidecar; it's the static bake used
for stills and before a depth track exists. The sidecar is specifically for models whose
temporal/stateful path is too fragile to reproduce as a plain ONNX graph (SAM 2's memory
attention, VDA's cross-frame self-attention window) — the same reasoning both D-012 and
D-036 independently landed on.

## The agent bridge — control server + MCP (D-020)

The canonical grade document lives in the **frontend** (`useEditorStore`, a zustand
store) — not Rust `AppState` — because that's where RapidRAW's render pipeline already
reads it from, and moving it would be invasive. So AI grading works through an **in-app
control server**, not headless `render_core` (that stays reserved for export/batch):

```
mcp/server.py (Python stdio, 95 tools)
   │  HTTP POST /op {op, args}
   ▼
app/src-tauri/src/chroma/control.rs (tiny_http, :19788, spawned in .setup())
   │  a fully GENERIC dispatcher — zero op-name knowledge. Two ways out:
   │
   ├── native_op(...)  — answered in Rust itself (D-210's screenshot/pixel probe only)
   │
   └── emit("chroma://request", ...) → await response event
          ▼
       one of three frontend OPS registries, disambiguated by op PREFIX so two
       listeners never race for one response slot (D-183 / mcp-architecture.md):
         · app/src/hooks/useChromaControl.ts   — Colorist   (unprefixed)
         · @chroma/editor  useEditorControl.ts — Edit       (`editor_*`)
         · @chroma/motion  useMotionControl.ts — Motion     (`motion_*`)
         · @chroma/debug   registry            — debug      (`debug_*`, dev builds only)
          ▼
       each calls the SAME store action / Tauri command the GUI's own click calls
          ▼
       useEditorStore (grade doc) · useEditorTimelineStore (timeline) · the manifest
          → the canvas re-renders → undo/history/save all work
```

**Every registry is mounted from boot, on every tab, whether or not that tab is visible** —
`Shell.tsx` keeps all three tab bodies mounted and merely hides the inactive ones, so an
agent can drive a tab the human isn't looking at. `CHROMA_CONTROL_PORT` overrides the fixed
`19788` — required when two Chroma instances run at once, and its absence fails *silently*
(a bind error logs and the app keeps running with no control server at all), which has
produced at least one false-positive verification (D-167).

**Tool counts, by surface** (counted from `mcp/server.py`, 2026-09-08):

| surface | MCP tools | registry |
|---|---|---|
| Colorist + session/project | 42 | `useChromaControl.ts` |
| Edit — timeline/editing | 41 | `useEditorControl.ts` |
| Edit — media understanding | 4 | `useEditorControl.ts` → `ai-media/` (start-then-poll: the bridge's 20 s ceiling can't hold a minutes-long job) |
| Debug / UI verification | 8 | `@chroma/debug` + `native_op` — **dev builds only** |
| **Motion** | **0** | `useMotionControl.ts` has 18 real ops; no Python wrappers exist |
| **total** | **95** | |

One shared state, no divergence: `get_state` reads the live store, so it reflects manual
edits too, and every mutating tool returns `{rendered_frame, scopes}` so the agent can see
what it did (the D-021 scopes: black/white points, per-channel clip %, hue histogram,
warm/cool + green/magenta cast — computed in pure JS off a downsampled preview frame, not
a WGSL compute pass — D-021's choice). Every op funnels through one chokepoint, which is
also where the **agent activity feed** (D-032) records a before/after snapshot for a
jump-to-here undo, and where `request_human(reason, roi?)` posts a non-blocking banner +
highlighted region for the human to take over.

**The rule every op follows** (D-140): a mutating op goes through the *same store action a
human's click goes through*, so an agent's edit lands on the same undo stack. The
deliberate exceptions are named and reasoned, not accidental — `editor_set_selection` and
`editor_set_preview_zoom` push nothing (they write store-only view state that no human path
undoes either, D-216/D-218), and the media-understanding tools mutate nothing at all
(D-189).

## Render determinism & the project invariants

Unchanged from `CLAUDE.md`'s invariants, still true of every render path described above:
same `grade.json` + same frame ⇒ identical pixels (no `rand()`, no wall-clock, no
un-seeded anything); zero network calls in the grade/edit path (the AI sidecar is local,
MCP is local stdio); `grade.json` is the single source of truth the GUI and the MCP layer
both mutate and the renderer only reads.

## Tech stack (current choices, see the cited `D-NNN` for rationale)

| Layer | Choice | Notes |
|---|---|---|
| Shell | Tauri (Rust + native webview) | locked by the owner's perf/binary-size constraint (D-039) — rejects WebCodecs/browser editing engines |
| GPU | wgpu / WGSL | inherited from RapidRAW |
| Video I/O | ffmpeg CLI subprocess (not linked) | D-015; persistent rawvideo pipes for decode (D-030) and export (D-022), not per-frame spawns |
| Colour mgmt | display-referred Rec.709 only | v1 scope, D-004; OpenColorIO/ACES/HDR deferred to v2 |
| AI models | SAM 2.1 + ViTMatte + MoGe-2 normals (sidecar), Video Depth Anything-vits (sidecar), Depth Anything V2 (in-process ONNX), mlx-whisper + Qwen3-VL (`ai-media/` sidecar) | D-009/D-012/D-016/D-018/D-036/D-078/D-189 |
| Grade doc | JSON, git-tracked, versioned (`chroma.grade/1`) | D-025 |
| Project format | a `<name>.chroma` directory of plain JSON | D-037 |
| Agent bridge | in-app HTTP control server ⇄ 4 prefixed frontend op registries ⇄ Python MCP (stdio) | D-020/D-183, **95 tools** |
| Frontend UI kit | shadcn/ui on Base UI (`@base-ui/react`) | D-042 |
| Edit-tab timeline UI | `@xzdarcy/react-timeline-editor` (control surface only, no video through it) + `@dnd-kit` for every drag | D-041, D-100 |
| Edit-tab audio | `symphonia` → `rubato` → `dasp_sample` → `cpal`; cookbook biquads for EQ | D-050, D-224 |
| Edit-tab export | a TypeScript ffmpeg-filtergraph compiler, mirroring the Rust preview engine | D-183/D-197 |
| Motion engine | Remotion (`packages/motion-engine/`), orchestrated by the `chroma-motion` crate | moved in D-039 step 1; bridge D-046 |
| Undo/redo | one shell-level stack (`@chroma/history`) shared across tabs | D-052; Motion not yet wired in |
| Interchange out | `.cube` (primary bake) + ProRes/H.264 + **FCPXML 1.7** | D-022, D-196; OTIO + XMEML still open |

## What isn't built yet

Not duplicated here in full — `docs/04-roadmap.md`'s "Next"/"Later" sections are the live,
maintained list. **Every gap the 2026-09-02 version of this section named has since been
closed** (media-pool unification, Editor audio, the multi-track timeline UI, the Export
dialog, the Motion tab, shell-level undo/redo, and waves 1–3 of the crate extraction). The
real headline gaps as of 2026-09-08, in rough order of how much they shape the architecture:

1. **`chroma-compositor` — the GPU compositor.** The Edit tab composites on the CPU today.
   This is the biggest single piece of the architecture that is still drawn and not built.
2. **Motion's missing MCP wrappers.** 18 real ops, zero reachable tools — see above.
3. **`chroma-grade`** — the grade renderer is still `app/`-side, so `chroma-app` cannot go
   thin and the fork cannot shrink to "grade shader + mask raster" the way D-039 intends.
4. **Wave 4 of the migration** — delete the five re-export shims, retarget the call sites.
   Mechanical, one commit, no behaviour change.
5. **Edit ↔ Colorist are still two models** (roadmap item 8): no grade-in-preview, and a
   clip's identity in the Edit tab and a shot's in the Colorist are only partly unified.
6. **`@chroma/tokens` and `@chroma/colorist`** — the two frontend packages that have not
   moved: theming still lives in `app/src/styles.css`, and the entire Colorist UI is still
   un-extracted `app/src/`.

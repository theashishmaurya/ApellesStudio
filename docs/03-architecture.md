# 03 — Architecture

Status: **current** (rewritten 2026-09-02, docs-reconciliation pass, superseding the stale
Phase-0 4-component version). Describes the system **as it actually is** today, per
`CLAUDE.md`'s hard rule — not the aspirational end state. Where something is planned but not
built, it's marked **future** and pointed at `docs/04-roadmap.md`, not described as live.

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
│    │  MVP     │          │ placeholder │              │  fork, grade  │        │
│    │          │          │  tab —      │              │  editor only, │        │
│    │          │          │  engine     │              │  D-043)       │        │
│    │          │          │  ready,     │              │               │        │
│    │          │          │  not wired  │              │               │        │
│    └────┬─────┘          └──────┬──────┘              └──────┬────────┘        │
│         │                       │                            │                │
│  decode→jpeg               packages/motion-engine       wgpu native surface    │
│  preview, own                (Remotion, 7               (D-006) + the         │
│  timeline model               primitives, JSON           grade renderer,      │
│  (chroma-timeline)             manifest compiler)         AI masks/tracking    │
│                                                                                │
└──────────────────┬───────────────────────────────────────┬────────────────────┘
                    │                                       │ local HTTP :19788
                    │ subprocess (ffmpeg)                   │ (chroma/control.rs, D-020)
          ┌─────────▼─────────┐                    ┌────────▼──────────┐   ┌──────────────┐
          │  ffmpeg / ffprobe │                    │  mcp/server.py    │   │  ai/ sidecar │
          │  decode·probe·    │                    │  (Python stdio    │◄─►│  FastAPI     │
          │  encode, spawned  │                    │  MCP, 38 tools)   │   │  :8765, SAM2/│
          │  as a subprocess  │                    └────────┬───────────┘   │  ViTMatte/   │
          └───────────────────┘                             │               │  VDA depth,  │
                                                    ┌────────▼──────────┐    │  Rust-       │
                                                    │  Claude Code /    │    │  supervised  │
                                                    │  any MCP client   │    │  (D-028)     │
                                                    └───────────────────┘    └──────────────┘

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
  ai/                    ← the Python AI sidecar (SAM2, ViTMatte, Video Depth Anything)
  mcp/                    ← the Python MCP server exposing the Colorist's grade ops
  eval/                   ← the agent grading eval harness (D-035) — offline, CI-able
  docs/
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

| layer | crate | exists? | responsibility |
|---|---|---|---|
| L0 | `chroma-types` | **yes (stub)** | `Frame`/`Rational`/`Resolution`/`ColorSpace`/`TimeRange`, typed IDs, error enums. Zero heavy deps. |
| L0 | `chroma-gpu` | future | wgpu context (no surface), texture pool, `render_core` (D-014) extracted out of `app/` |
| L1 | `chroma-media` | future | decode/probe/encode — VideoToolbox→texture, ffmpeg-CLI fallback (D-015), decode pipe (D-030), export encode pipe (D-022) |
| L1 | `chroma-grade` | future | the grade **renderer** — wraps the `app/` shader + adjustments↔uniform bridge + masks + scopes (D-021) |
| L1 | `chroma-compositor` | future | multi-layer wgpu blend + transitions, then `chroma-grade` per output frame — the Edit tab's real engine, not yet built |
| L2 | `chroma-timeline` | **yes, real** (D-041) | OTIO-shaped edit model: tracks/clips/gaps, ripple/roll/split/trim ops. **Pure** — no probing, callers pass frame counts. |
| L2 | `chroma-grade-model` | **yes (stub)** | mirrors `grade.json` (D-025) — the real document still lives as JSON handled by `app/src-tauri/src/chroma/grade.rs`, not this crate, pending extraction |
| L2 | `chroma-project` | future | the `.chroma` project (D-037) + settings (D-038) — currently `app/src-tauri/src/chroma/project.rs` |
| L2 | `chroma-motion` | future | manifest → Remotion render bridge — **not built**; the Motion tab has no Rust side yet |
| L3 | `chroma-ai` | future | sidecar client — currently `app/src-tauri/src/chroma/{sidecar,mask,depth}.rs` |
| L3 | `chroma-agent` | future | control server + MCP op registry — currently `app/src-tauri/src/chroma/control.rs` + `mcp/` |
| L4 | `chroma-app` (`app/src-tauri`) | **yes** — the vendored fork, all Chroma logic currently lives here as a `chroma/` module tree | the Tauri binary; today, everything not yet extracted |

**Read this table literally: only 3 crates exist, and 2 of the 3 (`chroma-types`,
`chroma-grade-model`) are still stubs.** `chroma-timeline` is the one real extraction so
far (D-041 made it load-bearing for the Edit tab). Every other capability — the grade
renderer, media I/O, the project model, the AI sidecar client, the control/MCP bridge —
still lives as Rust modules under `app/src-tauri/src/chroma/` (see file list below), not
in its own crate. The migration is **incremental by design** (`architecture-lock.md`
"Migration strategy"): the workspace skeleton, the dependency law, and the pure-leaf
crates landed first; extracting the GPU/media/project/AI/agent layers out of `app/` is
the queued "Then — the deeper migration" work in `docs/04-roadmap.md`, not yet started.

`app/src-tauri/src/chroma/` today (all Chroma-original, none of it RapidRAW's):
`commands.rs`, `control.rs` (D-020), `decode_pipe.rs` (D-030), `depth.rs` (D-036),
`edit.rs` (D-041), `export.rs` (D-022), `grade.rs` (D-025), `keyframes.rs` (D-034),
`load.rs`, `mask.rs` (D-012/016/018), `mod.rs`, `playback.rs` (D-031), `project.rs`
(D-037/038/044/045), `session.rs` (D-033), `sidecar.rs` (D-028), `state.rs`, `video.rs`.

## Frontend workspace — `packages/`

npm workspaces, mirroring the Rust split. `app/` (`@chroma/app`, the vendored RapidRAW
frontend) is also a workspace member — it's still where the Colorist tab's real UI lives.

| package | exists? | what it holds today |
|---|---|---|
| `@chroma/tokens` | stub | not yet extracted — theming still lives in `app/src/styles.css` |
| `@chroma/ui` | **yes, real** (D-042) | shadcn/ui on Base UI — 18 structural components (Button, Dialog, DropdownMenu, ContextMenu, Tooltip, Popover, Tabs, Select, Command, Resizable, Sheet, Slider, Switch, ScrollArea, Separator, Input, Label, Sonner) + 5 rebuilt RapidRAW primitives (Text, LabeledSwitch, CollapsibleSection, Button, Input), themed onto RapidRAW's existing `--color-*` CSS vars |
| `@chroma/bridge` | stub, first real content (D-044) | `useMediaPoolStore` (media-pool zustand store). The control-bridge hook (`useChromaControl`, D-020) is still `app/src/hooks/useChromaControl.ts`, not extracted here yet |
| `@chroma/shell` | **yes, real** | window chrome (`WindowChrome.tsx` — traffic lights / Win-Linux controls / drag region), the 3-tab switcher, the project-launcher entry-screen routing (D-037 step 6c) |
| `@chroma/editor` | **yes, real** (D-041) | the Edit tab — `react-timeline-editor` strip, `useEditorTimelineStore`, the preview pane |
| `@chroma/player` | **yes, real** | `<Player>` — shared viewport + title strip + transport bar, presentational only. Each tab supplies its own frame surface; Editor is the only consumer so far, Colorist/Motion adoption is open |
| `@chroma/motion` | stub | the Motion tab is a placeholder component — no `@remotion/player` embed yet |
| `@chroma/motion-engine` | **yes** | the Remotion project itself, moved in from `videoAgent/engine/motion/` — 7 primitives + the JSON scene-manifest compiler (`src/engine/build.ts`). Fully functional standalone, **not wired to `@chroma/motion`'s tab UI yet** |
| `@chroma/colorist` | future | the Colorist tab's adjustment panels / scopes / mask editor still live in `app/src/`, not extracted |
| `apps/desktop` | future | `app/` plays this role today (the Vite entry `src-tauri` serves) |

Run it: `npm run tauri:dev` from the repo root.

## The three tabs — what's actually live

### Colorist — the grading engine (most mature)

The full pre-pivot build, now scoped to grading only (D-043 removed the inherited
photo-DAM shell around it): primary/curves/wheels/LUT, masks (shape + AI subject,
composable via Add/Subtract/Intersect — D-023, keyframeable — D-034) — SAM 2 + ViTMatte
subject tracking (D-012/016/018), a per-frame temporal depth track via Video Depth
Anything-Small (D-036, Apache-2.0 checkpoint only), scopes + `match_to_reference`
(D-021/026), a depth-haze preset (D-024), export to ProRes/H.264 + a `.cube` bake (D-022),
`grade.json` (D-025), an agent activity feed with jump-to-here undo + `request_human`
(D-032), and an eval harness scoring the grading agent offline (D-035). MCP surface: 38
tools (`mcp/server.py`).

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

### Editor — MVP, real but small

`chroma-timeline` (the one real crate extraction) backs a single-video-track timeline
built from the open project's shots. Scrub/play preview is **independent of the
Colorist's wgpu/grade path** — a standalone lightweight decode→jpeg pipeline
(`chroma::edit` + the D-030 decode pipe → `image` crate JPEG q80 → a `data:` URL),
because the Editor preview just needs "give me timeline frame N fast," not a graded
composite. Reorder, trim (head/tail), split, and remove are implemented and unit-tested;
the timeline persists inside the `.chroma` project (`ProjectManifest.timelines: Vec<Timeline>`
+ `active_timeline: usize`, D-045 — migrated losslessly from D-041's original singular
field). The `@xzdarcy/react-timeline-editor` strip is a pure control surface — no video
frames flow through it. **Not yet built:** multi-track, audio (silent preview — flagged
live by the owner as a real gap, roadmap Next item 2), transitions, transcript-driven
cutting, GPU compositing, grade-in-preview, OTIO export, MCP tools. The eventual
multi-track engine (`chroma-compositor`) doesn't exist yet — today's Editor is
single-track only.

### Motion — placeholder tab, engine ready and waiting

`packages/motion-engine/` (moved in from `videoAgent/engine/motion/`, D-039 step 1) is
complete and independently functional: 7 primitives (`text`, `emphasis`, `matrix`,
`graph`, `layers`, `scene3d`, `particleflow`), a JSON scene-manifest compiler, rendered via
`npx remotion render`. **None of that is wired to a tab UI yet** — `@chroma/motion` is
still a placeholder component, there's no `@remotion/player` embed, no manifest editor,
and no `chroma-motion` crate to bridge a render into the app. This is the largest gap
between "engine exists" and "tab works" of the three — tracked as roadmap Next item 5.

### Shell — the app chrome

`@chroma/shell`: 3-tab layout (Edit / Motion / Colorist, `edit` first per owner request),
the window title bar (traffic lights, drag region, Win/Linux controls), and routing. The
project launcher (D-037) is the app's **entry screen**, not a view inside a tab — the app
opens on a grid of saved `<name>.chroma` projects; opening/creating one flips the shell
into the 3-tab layout. All 3 tab panels stay mounted (hidden) under the launcher so the
Colorist's MCP control bridge keeps running even before a project is opened from the GUI.
`@chroma/ui` (D-042, shadcn/Base UI) is the shared component kit new UI is built on.

## Data model

### The project — a `<name>.chroma` directory (D-037)

Not a bundle/zip/sqlite file — a plain directory of git-diffable JSON, matching the
project's existing bias toward inspectable, `rsync`-able files:

```
~/Movies/Chroma/<name>.chroma/
  project.json    schema "chroma.project/1" — { name, created, modified,
                  shots: [{id, sourcePath, frame, name}],   ← Colorist shots
                  media: [{id, sourcePath, name, folder?, video?}],  ← pool (D-044/045, additive)
                  timelines: [{id, name, tracks: [...]}], activeTimeline: usize,  ← Edit (D-045)
                  activeShot, settings: {width?, height?, fps?, colorSpace?} }  ← D-038
  thumb.jpg       a frame from the active/first shot — the launcher card
  grades/
    <shotId>.grade.json    each shot's grade, chroma.grade/1 (D-025), verbatim
    <shotId>.mattes/       externalized static mask PNGs ($matte refs)
```

Media is **referenced in place** by absolute path, never copied — a missing file flags
that shot "media offline" (relink, not fatal) rather than breaking the project. Per-shot
grades live *inside* the project directory (they belong to this grading job, not the
source clip, which may be read-only or on a scratch disk); tracked-matte and depth-track
caches (`chromaTrackDir`/`chromaDepthDir`) stay *next to the source clip* at
`<clip>/.chroma/{mattes,depth}/` since they're per-clip precomputes, reusable across
projects.

**`shots` (Colorist) and `media` (the pool) are still two separate, un-unified lists**
(D-044 explicitly deferred this — "sprawling refactor" the pass-1/2 scope warned off). A
Colorist "shot" and an Editor timeline clip both currently reference source paths
independently; the roadmap's "Media pool" item (Next #1, pass 3) is where they become one
model.

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
mcp/server.py (Python stdio, 38 tools)
   │  HTTP POST /op {op, args}
   ▼
app/src-tauri/src/chroma/control.rs (tiny_http, :19788, spawned in .setup())
   │  emit("chroma://request", ...) → await response event
   ▼
app/src/hooks/useChromaControl.ts (mounted once, app-level)
   │  calls the SAME setter a slider drag calls (setAdjustments, useAiMasking handlers, chroma_seek)
   ▼
useEditorStore (the one grade doc) → the canvas re-renders → undo/history/save all work
```

One shared state, no divergence: `get_state` reads the live store, so it reflects manual
edits too, and every mutating tool returns `{rendered_frame, scopes}` so the agent can see
what it did (the D-021 scopes: black/white points, per-channel clip %, hue histogram,
warm/cool + green/magenta cast — computed in pure JS off a downsampled preview frame, not
a WGSL compute pass — D-021's choice). Every op funnels through one chokepoint, which is
also where the **agent activity feed** (D-032) records a before/after snapshot for a
jump-to-here undo, and where `request_human(reason, roi?)` posts a non-blocking banner +
highlighted region for the human to take over.

This bridge is Colorist-only today — the Editor tab has no MCP tools yet, and Motion has
neither a tab UI nor a bridge.

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
| AI models | SAM 2.1 + ViTMatte (sidecar), Video Depth Anything-vits (sidecar), Depth Anything V2 (in-process ONNX) | D-009/D-012/D-016/D-018/D-036 |
| Grade doc | JSON, git-tracked, versioned (`chroma.grade/1`) | D-025 |
| Project format | a `<name>.chroma` directory of plain JSON | D-037 |
| Agent bridge | in-app HTTP control server ⇄ frontend store ⇄ Python MCP (stdio) | D-020, 38 tools |
| Frontend UI kit | shadcn/ui on Base UI (`@base-ui/react`) | D-042 |
| Edit-tab timeline UI | `@xzdarcy/react-timeline-editor` (control surface only, no video through it) | D-041 |
| Motion engine | Remotion (`packages/motion-engine/`) | pre-existing, moved in D-039 step 1 |
| Editor round-trip | `.cube` (primary bake) + ProRes/H.264 export | D-022; OTIO export still open |

## What isn't built yet

Not duplicated here in full — `docs/04-roadmap.md`'s "Next"/"Later" sections are the
live, maintained list. The headline gaps as of this doc: the media-pool/`shots`-`media`
unification (pass 3), Editor audio, a mature multi-track timeline UI, a real Export
dialog, the Motion tab MVP, shell-level undo/redo, and the deeper crate extraction
(`chroma-gpu`/`chroma-media`/`chroma-project`/`chroma-ai`/`chroma-agent`/`chroma-grade`/
`chroma-compositor` — all still "future" in the crate table above).

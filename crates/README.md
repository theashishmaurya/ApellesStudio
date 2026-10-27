# crates/ — Apelles' Rust workspace

The **thin-shell / fat-core** structure locked in **D-039** (the Gyroflow model):
the Tauri app is glue; every capability is a library. Domain models are pure Rust
— no `wgpu`, no `ffmpeg` — with GPU + media I/O isolated below them. The
dependency graph is **one-directional and compiler-enforced**:

```
app  →  agent/ai  →  project/timeline/grade-model/motion  →  media/grade/compositor  →  gpu  →  types
```

## The planned crates (D-039)

| layer | crate | exists? | responsibility | deps |
|---|---|---|---|---|
| L0 | `apelles-types` | **yes, real** | `Rational` / `Resolution` / error enums, plus the pure shared maths both render engines consume rather than each re-deriving: `ease`, `fade`, `pan`, `eq`, `adjustment` (D-230's operator) and `lut3d` (D-256's baked 3D LUT — the form the Colorist's grade travels in to reach the Edit compositor and the ffmpeg exporter). Zero heavy deps | — |
| L0 | `apelles-gpu` | **yes, partial (D-144)** | headless wgpu device/queue/limits (`init_gpu_context`, D-014, extracted). No display surface, no texture pool yet, no `render()` — those stay app-side / gated on `apelles-grade` | `wgpu`, `pollster`, `log` |
| L1 | `apelles-media` | **yes, real (D-146)** | `video` (ffmpeg-CLI probe + decode, D-015), `decode_pipe` (D-030/D-125; D-360 keys the pool by `(lane, slot)` and releases its lock across the blocking read, so several timeline walkers — the preview plus N headless render segments — each own an independent set of pipes), `media_cache` (D-128), `probe` (the two-layer probe cache, lifted out of `chroma/edit.rs`), `filmstrip` (D-128/D-134), `audio` (symphonia→rubato→cpal engine + waveforms, D-049/D-051/D-057), `timestretch` (pitch-preserving WSOLA time-scaling of the mixed preview stream — the Edit transport's playback-RATE control, D-280), `still` (still images as timeline sources — extension gate, header-only dimension probe, memoised scaled decode, thumbnail; D-292), `ffmpeg_gate` (D-334 — the ONE process-wide bound on concurrent one-shot `ffmpeg` extractions; was a private semaphore inside `filmstrip` until a second, uncapped call site in `video::extract_thumb` re-created the B-037 load spike from its own direction, and two per-feature caps of 3 permit 6 processes). Export encode (D-022) is still in `chroma/export.rs`; VideoToolbox→texture is future | types (**no `gpu` edge yet** — nothing extracted so far needs one; the lock doc's table predicted one) |
| L1 | `apelles-grade` | future | the grade **renderer** — wraps the RapidRAW (`app/`) shader + adjustments↔uniform bridge + masks + scopes (D-021). D-256's `chroma::grade_lut` (the identity-lattice bake that carries a grade into the Edit tab as a `apelles_types::Lut3d`) is app-side precisely because it links that shader, and is written to move here whole when this crate exists | gpu, types, `app/` engine |
| L1 | `apelles-compositor` | future | multi-layer wgpu blend + transitions — new, for the Edit tab. Scoped as **D-363** (2026-09-19, not built) — see `docs/notes/export-gpu-compositor.md` §11 | gpu, types |
| L2 | `apelles-timeline` | **yes, real** (D-041/045/046/082/136/137/138/235) | OTIO-shaped edit model: tracks / clips / gaps / ripple / roll / slip / slide, plus the `speed_ramp` time remap the live preview decodes with (D-236, mirrored by `@apelles/editor`'s `speedRamp.ts`, which the exporter compiles from), and a timeline's own output size + build provenance (`Timeline.output` / `origin`, D-411). **Pure.** | types |
| L2 | `apelles-grade-model` | **yes, real** (D-143) | the `grade.json` document (D-025) — save/load, schema migration, matte/track/depth-ref externalization. **Pure** (model vs renderer). | — |
| L2 | `apelles-project` | **yes, real (D-148)** | the `.chroma` project (D-037) + settings (D-038): the `project.json` manifest and every schema migration, the media pool + bins (D-044/D-045/D-059), the D-070 unified clip identity + grade-file migration, `list_projects_in`/`new_project_in`, and the project's timeline lifecycle (lifted out of `chroma/edit.rs`) plus by-id timeline management — create / rename / set output / duplicate (grades copied) / delete (D-411). The 20 commands + `open_manifest` stay app-side — all 20 take `tauri::State<'_, AppState>` | types, timeline, **media** (**not** grade-model — the table's earlier guess; the D-070 migration renames grade files, never parses one) |
| L2 | `apelles-motion` | **yes** (D-046) | manifest → Remotion bridge: runs the engine's own renderer (`node scripts/render.mts`, `@remotion/renderer` over a prebuilt bundle, D-417) rather than reimplementing it; also the content-hash asset store (D-404), the per-file template library on disk (D-407) and the custom-component library, Node static check, certification proof, project install and proxy frames (D-409) | types, motion-runtime |
| L1 | `apelles-motion-runtime` | **yes, real (D-417)** | Motion's render runtime: the pinned Node.js / Chrome Headless Shell / Remotion compositor downloads (resumable, SHA-256-checked), the atomic install into app data with a cheap integrity check and upgrade by pin key, the disk-space check, removal, and the ONE resolver every Motion render path asks (developer override → installed runtime → not ready). Network only when an install is asked for | `reqwest` (blocking, rustls), `sha2`, `flate2`, `tar`, `zip`, `rustix`, `serde`, `thiserror`, `log` |
| L1 | `apelles-audio-library` | **yes, real (D-400)** | Openverse audio search + import: the licence policy (`cc0`/`by` by default, NC/ND always refused with a reason), the response parser, the `CREDITS.json` ledger + video-description text, and the HTTP client with a polite `429` policy. The only network code in the Edit path, reached only by an explicit tool call | `serde`, `serde_json`, `thiserror`, `reqwest` (rustls), `tokio` (time) |
| L2 | `apelles-speech` | **yes, real (D-318)** | silence + retake detection for a talking-head recut: `vad` (silero-vad v6.2.1 ONNX via `ort`, D-319 — PCM in, one speech probability per 512-sample hop out), `silence` (hysteresis over those probabilities → spans), `retake` (near-duplicate transcript utterances grouped by **two independent signals**, either of which is enough: normalised edit distance + containment for "the same LINE again", D-320, and `phrase`'s repeated content-bearing n-gram for "the same PHRASE again inside two different sentences", D-365). **Read-only — it returns candidates and never cuts.** Takes `&[f32]` and transcript text rather than paths, so it never decodes, never touches a timeline, and every threshold is testable against fixtures | types-free (`ort`, `ndarray`, `strsim`, `serde`, `thiserror`) — deliberately **no `apelles-media` edge**, since nothing here decodes |
| L3 | `apelles-ai` | **yes** (D-145) | sidecar client: lifecycle (spawn/health/hash, D-028/D-101), `/segment`+`/track`+`/refine_track` (D-016/D-018/D-019), `/depth_track` (D-036) wire plumbing. **Its `sidecar` module is no longer AI-specific (D-313):** a `Launch` enum made it a general local-service supervisor, and it now also drives `apelles-mcp --http` — whose spec lives in `app/src-tauri`, since the decision to run an MCP server is the app's. Extracting that supervisor into its own crate is a tracked follow-up (`docs/04-roadmap.md`). `understanding_cache` (D-385) persists transcripts + applied re-reads through `apelles-media`'s `media_cache` | **media** (D-385, for `media_cache`); no apelles-types dependency yet |
| L4 | `apelles-mcp` | **yes, real (D-312)** | the MCP server itself — the tool surface an assistant drives the app through. A thin shell over `POST /op`: transport behind a trait, the D-310 argument shapes, the three envelope renderers, and one tool module per tab. **Two ways in (D-313):** stdio, or MCP streamable HTTP on loopback `:19790/mcp` — identical tool surface, and the app supervises one of the latter so a client only needs a URL. **No grade/mask/timeline logic, and it does not touch the control-server contract.** Port complete — all 186 tools pass the golden-corpus parity harness against `mcp/server.py`'s real behaviour (`crates/apelles-mcp/tests/parity.rs` + `parity/capture.py`). The **migration** is a separate, not-yet-made call: `mcp/server.py` stays the live default (no real editing session has been driven through the Rust binary yet) — see `docs/notes/mcp-rust-port.md` for the cutover plan | (none in-workspace — `rmcp`, `axum`, `reqwest`, `schemars`) |
| L3 | `apelles-agent` | future | the app-side half D-020 named: the control server + scope exposure. The "MCP op registry" part of this row is now `apelles-mcp` above, on the other side of the HTTP boundary; what would land here is `control.rs` itself | project, grade-model, timeline, types |
| L4 | `apelles-app` (`app/src-tauri`) | **yes** — the vendored fork; its Cargo package is `apelles` since D-265 (was `RapidRAW`) | the Tauri binary — `#[tauri::command]` surface per tab, `RunEvent` hooks, sidecar spawn | all of the above |

`app/` (the vendored RapidRAW fork, D-040) stays the engine; over time these
crates absorb more and RapidRAW shrinks to "grade shader + mask raster". Only
`apelles-grade` will link it.

## Migration status (D-039)

- **Step 1 (this commit):** workspace skeleton — root `Cargo.toml [workspace]`,
  the 3 pure-leaf stub crates above (each `cargo check` clean, one placeholder
  item + `it_builds` test), the Remotion motion engine moved to
  `packages/motion-engine/`. **No real code moved; the app still builds.**
- **Step 2+:** extract per-crate, each its own commit, `cargo test` green,
  roadmap-tracked. Order: leaf pure crates → `apelles-gpu` / `apelles-media` /
  `apelles-project` → `apelles-agent` / `apelles-ai` → `apelles-grade` +
  `apelles-app` thin binary. `apelles-compositor` is greenfield from day one.
- **`apelles-gpu` (D-144, 2026-09-05):** `render_core::init_gpu_context()` moved
  verbatim (device + queue + limits, headless). `render_core::render()` did
  **not** move — it is a pass-through into
  `gpu_processing::process_and_get_dynamic_image_inner`, whose signature is
  entirely RapidRAW-core types (`GpuContext`'s `display` field,
  `RenderCaches`, `RenderRequest`), and moving it is `apelles-grade`, later.
  Resolved the one open question from D-141's scoping pass: `GpuContext`
  *does* split into two structs — this crate's headless one, and the app's
  own `image_processing::GpuContext` (unchanged) which wraps it plus a
  `display: Arc<Mutex<Option<WgpuDisplay>>>` for the on-screen present path.
  `render_core.rs` keeps its old `init_gpu_context()` signature as a thin
  wrapper, so the 6 `render_core::` call sites in `chroma/export.rs`,
  `chroma/playback.rs`, `chroma/relight.rs` need zero changes.
- **`apelles-media` (D-146, 2026-09-05):** the widest slice of the plan, in its
  three required ordered commits. `video.rs` + `decode_pipe.rs` +
  `media_cache.rs` moved verbatim; `probe_cached` was lifted out of
  `chroma/edit.rs` into a `probe` module of its own (it is the *composition* of
  `video::probe` with `media_cache`'s two layers, not part of either) — it had
  to move first, or this crate would depend on `app/src-tauri`, a cycle;
  `filmstrip.rs` moved whole minus its command wrapper. **`audio.rs` split
  rather than moved**: its symphonia→rubato→cpal engine, the D-130 session
  ordering protocol, the waveform path and `AudioSourceSpec` are media, but
  `chroma_audio_play`'s *timeline resolution*
  (`edit::resolve_video_position` / `resolve_audio_track_positions`) is a layer
  above media and stayed in `app/src-tauri` — the command is now
  `begin_play` → *(app resolves)* → `start`, which preserves the exact ordering
  D-125's skew compensation depends on. **B-056** (the in-memory probe cache
  never invalidated) and **B-057** (`CHUNK_LOCKS` leaked on a failed
  extraction) were fixed inside the commits already rewriting that code, each
  with a regression test confirmed to fail pre-fix. Correction to the table
  above: this crate has **no `apelles-gpu` edge** — everything extracted so far
  is CPU/subprocess work; the predicted edge becomes real only if
  VideoToolbox→texture lands. See its own `README.md` for the `test-support`
  feature and why it is a feature rather than a `#[doc(hidden)] pub`.
- **`apelles-project` (D-148, 2026-09-05) — closes the Wave 1–3 sequence.**
  `chroma/project.rs` L1–1638 moved verbatim into `crates/apelles-project/`
  (`manifest`), and the timeline lifecycle — `ensure_timeline`,
  `load_and_ensure_timeline`, `resolve_timeline`,
  `resolve_timeline_and_settings`, `build_from_shots` — moved out of
  `chroma/edit.rs` into the new crate's `timeline` module, because that is
  what it always was: it reads `manifest.shots`, calls
  `project::resolve_shot`/`save_manifest`, and four of its callers are
  `chroma::project`'s own commands. The *process global* those functions read
  (`chroma::state`'s "which project is open") stayed app-side and is now a
  parameter the app supplies, so `chroma::edit` keeps three-line wrappers at
  the original signatures and its ~20 call sites are unchanged.
  `open_manifest` + the 20 `#[tauri::command]`s stayed — every one takes
  `tauri::State<'_, AppState>`. Two corrections to the table above, made on
  contact: **`apelles-project → apelles-media` is real** (probe + thumbnail) and
  was missing from `architecture-lock.md`; the **`apelles-grade-model` edge is
  not** and never was. Test split: 48 model tests moved, 11 command-surface /
  process-state tests stayed in `app/src-tauri`, 5 new tests were written for
  the timeline lifecycle (which had none in `edit.rs`).

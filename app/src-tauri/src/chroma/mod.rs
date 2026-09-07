//! Chroma additions to the RapidRAW engine.
//!
//! Everything Chroma-specific lives under this module so the fork stays a clean,
//! separable diff against upstream RapidRAW (see chroma/docs/08-decisions.md D-003).
//! Ideal upstream footprint: `mod chroma;` in `lib.rs` + a couple of one-line hooks.
//!
//! - `video`    — ffmpeg-backed video probe + single-frame decode (D-015);
//!   a re-export shim since D-146 — the real code is `chroma-media`
//! - `media_cache` — persistent, source-keyed disk cache for derived media
//!   artefacts: filmstrip tiles, probes, waveform peaks (D-128); a re-export
//!   shim since D-146 — the real code is `chroma-media`
//! - `filmstrip` — windowed, level-of-detail Edit-tab filmstrip tiles on top
//!   of `media_cache` (D-128; supersedes D-119/D-121/D-124's whole-clip strip);
//!   since D-146 just the `chroma_clip_thumbnails` command — the real code is
//!   `chroma-media`
//! - `audio`    — Edit-tab audio playback: symphonia decode → rubato resample
//!   → dasp_sample format-convert → cpal device output (D-049); since D-146
//!   just the 5 commands **plus** the timeline resolution that turns a
//!   playhead frame into audio sources, which is deliberately *not* media —
//!   the engine is `chroma-media`
//! - `decode_pipe` — persistent sequential-decode pipe for smooth scrub/playback
//!   (D-030); a re-export shim since D-146 — the real code is `chroma-media`
//! - `state`    — Chroma's own process state (the multi-shot session, D-033)
//! - `load`     — load a video as one decoded frame into the existing image pipeline
//! - `commands` — tauri commands for the transport (`chroma_video_info`, `chroma_seek`)
//! - `session`  — multi-shot session: add / list / switch / remove shots (D-033)
//! - `project`  — the saved `<name>.chroma` project: list / open / new / save
//!   (D-037); since D-148 just `open_manifest` + the 20 commands (all of which
//!   take `tauri::State<AppState>`) — the model is `chroma-project`
//! - `edit`     — the Edit-tab bridge: `chroma-timeline` model ⇄ frontend + a
//!   lightweight decode→jpeg preview (D-041). Since D-148 the project's
//!   *timeline lifecycle* (`ensure_timeline`/`resolve_timeline`) is
//!   `chroma_project::timeline`, wrapped here to supply the open project's dir
//! - `playback` — fused decode+install+grade command for real-time playback (D-031)
//! - `mask`     — subject matte via the AI sidecar (SAM 2 → ViTMatte, D-016)
//! - `depth`    — per-frame temporally-consistent depth track (Video Depth Anything, D-036)
//! - `keyframes` — interpolate a shape sub-mask's geometry across source frames (D-034)
//! - `relight`  — interactive depth-driven light-puck relight: parse the "Relight"
//!                grade layer + resolve its depth source (D-046)
//! - `control`  — in-app HTTP control server bridging MCP ⇄ the frontend (D-020)
//! - `export`   — graded-clip render to ProRes/H.264 + `.cube` bake (D-022)
//! - `ffmpeg_run` — generic `ffmpeg <argv>` spawn/capture primitive (D-183),
//!   used by the Edit-tab timeline exporter (`packages/editor/src/
//!   timelineExport.ts` builds the argv; this just runs it — no ffmpeg-arg
//!   knowledge lives here, mirroring `chroma-motion`'s own render/exec split)
//! - `grade`    — the `grade.json` document command bridge: save / load
//!                (D-025); the model itself lives in `chroma-grade-model` (D-143)
//! - `motion`   — the Motion tab bridge: manifest sidecar + `chroma-motion` render (D-046)
//! - `media_understanding` — transcript + "what changed on screen, and when"
//!   via the `ai-media/` sidecar (mlx-whisper + Qwen3-VL, D-189); just the 4
//!   `#[tauri::command]`s — the wire client is `chroma_ai::media_understanding`
//! - `sidecar`  — spawn + supervise the `ai/` and `ai-media/` FastAPI sidecars,
//!   kill them on exit (D-028; second sidecar D-189, N-sidecar supervisor D-190)
//! - `write_text_file` — generic "write this UTF-8 text to this absolute path"
//!   primitive (D-195), used by the Edit-tab FCPXML interchange exporter
//!   (`packages/editor/src/timelineInterchange.ts` builds the XML string;
//!   this just writes it — no XML/interchange knowledge lives here, mirroring
//!   `ffmpeg_run`'s own "the caller owns the content" split)

pub mod audio;
pub mod commands;
pub mod control;
pub mod decode_pipe;
pub mod depth;
pub mod edit;
pub mod export;
pub mod ffmpeg_run;
pub mod filmstrip;
pub mod grade;
pub mod keyframes;
pub mod load;
pub mod mask;
pub mod media_cache;
pub mod media_understanding;
pub mod motion;
pub mod playback;
pub mod project;
pub mod relight;
pub mod session;
pub mod sidecar;
pub mod state;
pub mod video;
pub mod write_text_file;

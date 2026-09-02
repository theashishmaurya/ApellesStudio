//! Chroma additions to the RapidRAW engine.
//!
//! Everything Chroma-specific lives under this module so the fork stays a clean,
//! separable diff against upstream RapidRAW (see chroma/docs/08-decisions.md D-003).
//! Ideal upstream footprint: `mod chroma;` in `lib.rs` + a couple of one-line hooks.
//!
//! - `video`    — ffmpeg-backed video probe + single-frame decode (D-015)
//! - `decode_pipe` — persistent sequential-decode pipe for smooth scrub/playback (D-030)
//! - `state`    — Chroma's own process state (the multi-shot session, D-033)
//! - `load`     — load a video as one decoded frame into the existing image pipeline
//! - `commands` — tauri commands for the transport (`chroma_video_info`, `chroma_seek`)
//! - `session`  — multi-shot session: add / list / switch / remove shots (D-033)
//! - `project`  — the saved `<name>.chroma` project: list / open / new / save (D-037)
//! - `edit`     — the Edit-tab bridge: `chroma-timeline` model ⇄ frontend + a lightweight decode→jpeg preview (D-041)
//! - `playback` — fused decode+install+grade command for real-time playback (D-031)
//! - `mask`     — subject matte via the AI sidecar (SAM 2 → ViTMatte, D-016)
//! - `depth`    — per-frame temporally-consistent depth track (Video Depth Anything, D-036)
//! - `keyframes` — interpolate a shape sub-mask's geometry across source frames (D-034)
//! - `control`  — in-app HTTP control server bridging MCP ⇄ the frontend (D-020)
//! - `export`   — graded-clip render to ProRes/H.264 + `.cube` bake (D-022)
//! - `grade`    — the `grade.json` document: save / load / versioned schema (D-025)
//! - `sidecar`  — spawn + supervise the `ai/` FastAPI sidecar, kill it on exit (D-028)

pub mod commands;
pub mod control;
pub mod decode_pipe;
pub mod depth;
pub mod edit;
pub mod export;
pub mod grade;
pub mod keyframes;
pub mod load;
pub mod mask;
pub mod playback;
pub mod project;
pub mod session;
pub mod sidecar;
pub mod state;
pub mod video;

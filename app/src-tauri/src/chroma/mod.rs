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
//! - `debug_capture` — in-process WKWebView screenshot + PNG pixel probe
//!   (D-210): the app photographs its own webview via
//!   `-[WKWebView takeSnapshotWithConfiguration:completionHandler:]`, which
//!   needs no macOS Screen Recording permission (it is not screen capture),
//!   so an agent can actually SEE the UI it just changed.
//!   **`#[cfg(debug_assertions)]` — compiled out of a release build entirely**
//!   (B-100/D-219), along with its two Tauri commands and the two
//!   `control.rs` native ops that reach it. Internal debug tooling is never
//!   shipped (CLAUDE.md)
//! - `caption_render` — rasterise a subtitle cue into an RGBA layer the
//!   compositor draws OVER the finished frame (D-229). Multi-line, and
//!   line-for-line identical to what the ffmpeg export's `drawtext` draws;
//!   see `docs/notes/subtitles.md` for the measurement that makes that true
//! - `subtitles` — read a `.srt`/`.vtt` file into cues already on the
//!   project's own timebase, and write a subtitle track back out as one
//!   (D-229). The parsing itself is `chroma_timeline::subtitle_import`
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
//!   primitive (D-196), used by the Edit-tab FCPXML interchange exporter
//!   (`packages/editor/src/timelineInterchange.ts` builds the XML string;
//!   this just writes it — no XML/interchange knowledge lives here, mirroring
//!   `ffmpeg_run`'s own "the caller owns the content" split)

pub mod audio;
pub mod caption_render;
pub mod commands;
pub mod control;
/// B-100/D-219 — internal debug tooling, never shipped: the whole module,
/// its Tauri commands and its control-server ops exist only in a build with
/// debug assertions on (`tauri dev`, `cargo test`). A release build has no
/// code path to a webview screenshot at all.
#[cfg(debug_assertions)]
pub mod debug_capture;
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
pub mod subtitles;
pub mod text;
pub mod video;
pub mod write_text_file;

/// **The one lock every test that opens a project must hold** (D-211).
///
/// `state::set_project` and the decode-pipe pool are process-global
/// (D-033/D-037, D-125) and `cargo test` runs test fns on several threads by
/// default, so two such tests interleave — one measuring a frame the other has
/// just re-pointed the project state for. `chroma::project`'s own tests have
/// had a lock like this since D-054; it lived inside that module's private
/// `mod tests`, so when `chroma::edit`'s new text/title preview tests needed
/// the same guarantee they could not reach it, and a second module-local lock
/// would have serialised each module internally while still letting the two
/// modules race — the same defect with more code. Hoisted here, where every
/// `chroma::*` test module can see it, and used by all of them.
///
/// Hold it for the whole body (`let _guard = …`), and take it with
/// `unwrap_or_else(|e| e.into_inner())` rather than `expect`: a panic in one
/// test poisons the mutex, and a poisoned lock must not turn into a second,
/// misleading failure everywhere else.
#[cfg(test)]
pub(crate) static PROJECT_STATE_LOCK: once_cell::sync::Lazy<std::sync::Mutex<()>> =
    once_cell::sync::Lazy::new(|| std::sync::Mutex::new(()));

//! Tauri bridge for the Edit-tab filmstrip (D-128/D-134).
//!
//! What it is: the app-side half of the D-146 `apelles-media` extraction
//! (`docs/notes/crate-extraction-plan.md` §2.2) — the one thing here that
//! genuinely needs Tauri, the `#[tauri::command] chroma_clip_thumbnails`
//! wrapper.
//! What it does NOT do: any of the real work — the level-of-detail ladder,
//! chunking, the three-tier memory/disk/derive cache, the per-chunk locks and
//! the `ffmpeg` extraction are all `apelles_media::filmstrip` now. This file
//! used to be the whole 1,241-line implementation; see D-146 in
//! `docs/08-decisions.md` for what moved and why (and B-057, fixed in the same
//! move — a failed chunk extraction used to leak its lock-map entry).

/// `ClipThumbDto` is the command's return type, so it has to be nameable
/// here; the frontend contract (`camelCase` `dataUrl`/`secs`/`frame`) is
/// unchanged.
pub use apelles_media::filmstrip::ClipThumbDto;

/// Picture tiles roughly `step_secs` apart covering source seconds
/// `[start_secs, start_secs + duration_secs)` of `source_path` (D-128).
///
/// All four parameters are in the **source file's** own time base — the
/// caller converts from timeline frames. See
/// [`apelles_media::filmstrip::clip_thumbnails`] for the real contract.
#[tauri::command]
pub async fn chroma_clip_thumbnails(
    source_path: String,
    start_secs: f64,
    duration_secs: f64,
    step_secs: f64,
) -> Result<Vec<ClipThumbDto>, String> {
    apelles_media::filmstrip::clip_thumbnails(source_path, start_secs, duration_secs, step_secs).await
}

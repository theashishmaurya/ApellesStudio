//! loudness.rs — the Tauri command for the export loudness target (D-401).
//!
//! What it is: a thin `#[tauri::command]` wrapper over
//!   `apelles_media::loudness::normalise_in_place`, for the one export path
//!   that finishes OUTSIDE this process's own job tracking — the filter-graph
//!   renderer, whose single `ffmpeg` is run by `chroma_run_ffmpeg`. The
//!   compositor path normalises inside its own render job instead
//!   (`edit_render::TimelineRenderRequest::loudness`) so `editor_export_status`
//!   can report the phase; both reach the same Rust function.
//! What it does NOT do: choose a target (the preset table is
//!   `packages/editor/src/loudness.ts`), re-encode video, or touch a file it
//!   was not asked about.

use std::path::PathBuf;

use apelles_media::loudness::{self, LoudnessReport, LoudnessTarget};

/// Normalise the audio of the finished export at `path` to `target`, in place.
/// Blocks on a background thread — a long export's audio is a full decode.
#[tauri::command]
pub async fn chroma_normalize_loudness(
    path: String,
    target: LoudnessTarget,
) -> Result<LoudnessReport, String> {
    let path = PathBuf::from(path);
    tauri::async_runtime::spawn_blocking(move || loudness::normalise_in_place(&path, target))
        .await
        .map_err(|e| format!("loudness task panicked: {e}"))?
}

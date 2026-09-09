//! Tauri bridge for per-frame depth tracking via the Apelles AI sidecar (D-036).
//!
//! What it is: the app-side half of the D-142 `apelles-ai` extraction
//! (`docs/notes/crate-extraction-plan.md` §2.5) — the two
//! `#[tauri::command]`s, plus [`tracked_depth_map`], the one function
//! `mask_generation.rs` calls directly (not a command). What it does NOT do:
//! any of the actual `/depth_track` HTTP wire work or the tracked-PNG lookup
//! — both are `apelles_ai::depth` now. This file used to be the whole
//! 288-line implementation; see D-142 in `docs/08-decisions.md`.

use crate::chroma::state;

/// Kick off a per-frame depth pass over the loaded clip. Returns the sidecar job
/// (`job_id`, `dir`, `total`) immediately; poll [`chroma_depth_track_status`].
/// The frontend stores the returned `dir` in the depth sub-mask's
/// `chromaDepthDir` param and the renderer reads the current frame's PNG via
/// [`tracked_depth_map`].
#[tauri::command]
pub async fn chroma_depth_track(
    from_frame: Option<u64>,
    to_frame: Option<i64>,
    step: Option<u32>,
    input_size: Option<u32>,
    max_res: Option<u32>,
) -> Result<serde_json::Value, String> {
    let cv = match state::current_video() {
        Some(cv) => cv,
        None => {
            log::error!("[relight] chroma_depth_track: no video loaded");
            return Err("no video loaded".into());
        }
    };
    apelles_ai::depth::depth_track(
        &cv.path.to_string_lossy(),
        from_frame,
        to_frame,
        step,
        input_size,
        max_res,
    )
    .await
}

/// Poll a `/depth_track` job.
#[tauri::command]
pub async fn chroma_depth_track_status(job_id: String) -> Result<serde_json::Value, String> {
    apelles_ai::depth::depth_track_status(&job_id).await
}

/// The tracked depth map for the currently-decoded video frame, as a full-res
/// `GrayImage`. Reads `params.chromaDepthDir` + `chroma::state::current_video().frame`
/// and delegates the PNG lookup to `apelles_ai::depth::depth_map_at`. `None` when
/// the sub-mask has no `chromaDepthDir`, no video is loaded, or nothing is
/// cached at that point yet — the caller then falls back to the static
/// `mask_data_base64` bake.
///
/// D-142: unchanged signature (`&serde_json::Value`), so `mask_generation.rs`'s
/// two call sites (L932, L1366) needed no edits. Internally this now does the
/// two state/params lookups and calls `apelles_ai::depth::depth_map_at(dir,
/// frame)`, which takes the frame index as a plain argument since the crate
/// can't see `chroma::state` — the "strictly better signature" the extraction
/// plan calls out, kept at the crate boundary rather than pushed up into this
/// function's own callers.
pub fn tracked_depth_map(params: &serde_json::Value) -> Option<image::GrayImage> {
    let dir = params
        .get("chromaDepthDir")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())?;
    let frame = state::current_video()?.frame;
    apelles_ai::depth::depth_map_at(dir, frame)
}

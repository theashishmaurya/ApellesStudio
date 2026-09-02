//! Multi-shot session commands (roadmap round-3, D-033).
//!
//! What it is: the Tauri surface over [`super::state::Session`] — the ordered set
//!   of shots (clips) in a grading job + which one is active. `state.rs` holds
//!   the model + does the cache invalidation; this file is add / list /
//!   set-active / remove + a per-shot thumbnail for the strip.
//! What it does NOT do: per-shot *grade* or *activity-feed* state — that lives in
//!   the frontend stores keyed by shot path (D-020 / D-032). The `grade.json`
//!   sidecar (D-025) is still the per-shot serialisation; there is no `.chroma`
//!   project bundle (D-033). No session-file persistence yet (deferred).
//!
//! Fork hygiene (D-003): all new code; upstream footprint is `pub mod session;`
//! in `chroma/mod.rs` + the `generate_handler!` lines in `lib.rs`.

use crate::app_state::AppState;
use crate::image_loader::LoadImageResult;

use super::state::{self, Shot};
use super::{decode_pipe, load, video};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShotDto {
    pub path: String,
    /// filename, for the strip label
    pub name: String,
    /// `chroma_types::Resolution` (D-053) via `#[serde(flatten)]` — same
    /// `width`/`height` JSON keys the frontend already reads.
    #[serde(flatten)]
    pub resolution: chroma_types::Resolution,
    pub fps: f64,
    pub frame_count: u64,
    pub duration_secs: f64,
    /// the playhead this shot was last left on
    pub frame: u64,
    pub codec: String,
    pub color_space: String,
}

impl From<&Shot> for ShotDto {
    fn from(s: &Shot) -> Self {
        ShotDto {
            path: s.path.to_string_lossy().to_string(),
            name: s
                .path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| s.path.to_string_lossy().to_string()),
            resolution: s.info.resolution,
            fps: s.info.fps(),
            frame_count: s.info.frame_count,
            duration_secs: s.info.duration_secs,
            frame: s.frame,
            codec: s.info.codec.clone(),
            color_space: s.info.color_space.clone(),
        }
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDto {
    pub shots: Vec<ShotDto>,
    /// active index; equals `shots.len()` semantics only matter when non-empty
    pub active: usize,
    pub count: usize,
}

fn snapshot() -> SessionDto {
    let (shots, active) = state::session_shots();
    SessionDto {
        shots: shots.iter().map(ShotDto::from).collect(),
        active,
        count: shots.len(),
    }
}

/// The whole session: every shot + the active index. A still-image edit (no
/// video loaded) reports an empty session.
#[tauri::command]
pub fn chroma_session_list() -> SessionDto {
    snapshot()
}

/// Result of a command that also swapped the loaded frame (set-active / remove).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSwitchDto {
    pub session: SessionDto,
    /// the newly-active shot's decoded frame, or `null` if the session is now
    /// empty (the frontend then clears `selectedImage`)
    pub loaded: Option<LoadImageResult>,
}

/// Probe `paths` and append each as a shot; the last one becomes active and its
/// first frame is decoded into the editor. A path already in the session is
/// updated in place (same as re-opening it). This is what the file-picker /
/// `open` flow funnels into — opening one clip is just a session of one shot.
#[tauri::command]
pub async fn chroma_session_add(
    paths: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<SessionSwitchDto, String> {
    if paths.is_empty() {
        return Err("no paths given".into());
    }
    let mut last: Option<LoadImageResult> = None;
    let mut errors: Vec<String> = Vec::new();
    for p in &paths {
        let path = std::path::PathBuf::from(p);
        if !video::is_video_file(&path) {
            errors.push(format!("{p}: not a video file"));
            continue;
        }
        match load::load_video_frame(&path, p, 0, &state).await {
            Ok(res) => last = Some(res),
            Err(e) => errors.push(format!("{p}: {e}")),
        }
    }
    if last.is_none() {
        return Err(format!("no shots added: {}", errors.join("; ")));
    }
    Ok(SessionSwitchDto { session: snapshot(), loaded: last })
}

/// Make shot `index` active and decode its playhead frame into the editor.
/// Per-shot grade + activity restore happens on the frontend (D-020 / D-032);
/// this is the clip + pixels half.
#[tauri::command]
pub async fn chroma_session_set_active(
    index: usize,
    state: tauri::State<'_, AppState>,
) -> Result<SessionSwitchDto, String> {
    let shot = state::session_set_active(index)?;
    let loaded = decode_and_install(&shot, &state).await?;
    Ok(SessionSwitchDto { session: snapshot(), loaded: Some(loaded) })
}

/// Remove shot `index`. If it was the last shot the session goes empty and
/// `loaded` is `null`; otherwise the new active shot's frame is decoded.
#[tauri::command]
pub async fn chroma_session_remove(
    index: usize,
    state: tauri::State<'_, AppState>,
) -> Result<SessionSwitchDto, String> {
    let now_active = state::session_remove(index)?;
    let loaded = match now_active {
        Some(shot) => Some(decode_and_install(&shot, &state).await?),
        None => None,
    };
    Ok(SessionSwitchDto { session: snapshot(), loaded })
}

/// A small preview JPEG (data URL) of a shot's playhead frame, for the strip.
#[tauri::command]
pub async fn chroma_session_thumbnail(index: usize, height: Option<u32>) -> Result<String, String> {
    let (shots, _) = state::session_shots();
    let shot = shots.get(index).ok_or_else(|| format!("shot index {index} out of range"))?.clone();
    let h = height.unwrap_or(96);
    tokio::task::spawn_blocking(move || video::extract_thumb(&shot.path, &shot.info, shot.frame, h))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Decode `shot`'s frame (persistent pipe, D-030; falls back to a single-frame
/// decode) and swap it into `AppState.original_image`.
async fn decode_and_install(
    shot: &Shot,
    state: &tauri::State<'_, AppState>,
) -> Result<LoadImageResult, String> {
    // drop the per-frame pixel caches — same set `chroma_seek` clears
    if let Ok(mut c) = state.decoded_image_cache.lock() {
        c.clear();
    }
    if let Ok(mut c) = state.gpu_image_cache.lock() {
        *c = None;
    }
    if let Ok(mut c) = state.cached_preview.lock() {
        *c = None;
    }
    if let Ok(mut c) = state.full_warped_cache.lock() {
        *c = None;
    }
    if let Ok(mut c) = state.full_transformed_cache.lock() {
        *c = None;
    }
    if let Ok(mut s) = state.ai_state.lock() {
        if let Some(st) = s.as_mut() {
            st.depth_map = None;
        }
    }

    let path = shot.path.clone();
    let info = shot.info.clone();
    let frame = shot.frame.min(info.frame_count.saturating_sub(1));
    let decoded = tokio::task::spawn_blocking(move || {
        decode_pipe::playback_frame_scaled(&path, &info, frame, None).or_else(|e| {
            log::warn!("[chroma::session] decode pipe fell back to single-frame decode: {e}");
            video::decode_frame(&path, video::FramePos::Index(frame), &info)
        })
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;

    let virtual_path = shot.path.to_string_lossy().to_string();
    Ok(load::install_frame(
        &shot.path,
        &virtual_path,
        frame,
        shot.info.clone(),
        decoded,
        state,
    ))
}

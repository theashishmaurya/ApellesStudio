//! Tauri commands for the video transport. Kept here so `lib.rs` only gains the
//! two `generate_handler!` lines.

use crate::app_state::AppState;
use crate::image_loader::LoadImageResult;

use super::state::{cached_thumbs, current_video, store_thumbs};
use super::{decode_pipe, load, video};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoInfoDto {
    pub is_video: bool,
    pub path: String,
    /// `apelles_types::Resolution` (D-053) via `#[serde(flatten)]` — same
    /// `width`/`height` JSON keys the frontend already reads, zero wire change.
    #[serde(flatten)]
    pub resolution: apelles_types::Resolution,
    pub fps: f64,
    pub frame_count: u64,
    pub duration_secs: f64,
    /// frame index currently decoded into the editor
    pub frame: u64,
    pub codec: String,
    pub color_space: String,
    pub color_transfer: String,
}

/// `null` when the loaded item is not a video.
#[tauri::command]
pub fn chroma_video_info() -> Option<VideoInfoDto> {
    let cv = current_video()?;
    Some(VideoInfoDto {
        is_video: true,
        path: cv.path.to_string_lossy().to_string(),
        resolution: cv.info.resolution,
        fps: cv.info.fps(),
        frame_count: cv.info.frame_count,
        duration_secs: cv.info.duration_secs,
        frame: cv.frame,
        codec: cv.info.codec.clone(),
        color_space: cv.info.color_space.clone(),
        color_transfer: cv.info.color_transfer.clone(),
    })
}

/// Decode `frame` of the loaded video and make it the editor's base image.
/// The frontend re-runs `apply_adjustments` afterwards to redisplay with the grade.
#[tauri::command]
pub async fn chroma_seek(
    frame: u64,
    state: tauri::State<'_, AppState>,
) -> Result<LoadImageResult, String> {
    seek_and_install(frame, None, &state).await
}

/// The body of [`chroma_seek`], shared with the fused playback command
/// (`chroma::playback::chroma_play_frame`): clear the per-frame pixel caches,
/// decode `frame` via the persistent pipe (D-030), and swap it into
/// `AppState.original_image` + point `CurrentVideo.frame` at it (so tracked
/// mattes stay in lockstep, D-019). Does **not** trigger a re-grade — the caller
/// does (`bumpFrameNonce` for scrub, a preview job for playback).
///
/// `scale_long_edge`: `Some(px)` makes ffmpeg downscale each frame to that long
/// edge before it hits the pipe (D-031 playback — avoids a CPU downscale of a 4K
/// frame per frame). `None` = native size (scrub / single-frame seek).
pub async fn seek_and_install(
    frame: u64,
    scale_long_edge: Option<u32>,
    state: &tauri::State<'_, AppState>,
) -> Result<LoadImageResult, String> {
    let cv = current_video().ok_or("no video loaded")?;
    let clamped = frame.min(cv.info.frame_count.saturating_sub(1));

    // drop the per-frame pixel caches so the next render uses the new frame
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
    // Apelles: the AI depth map is cached keyed by `hash(path + geometry)`
    // (`ai_commands::generate_ai_depth_mask`). On a video the path + geometry are
    // constant across frames, so without this the depth-haze mask would keep
    // grading every seeked frame off frame 0's depth. Drop it so the next
    // `generate_ai_depth_mask` recomputes for the new frame. (roadmap 4 / D-024)
    if let Ok(mut s) = state.ai_state.lock() {
        if let Some(st) = s.as_mut() {
            st.depth_map = None;
        }
    }

    let virtual_path = cv.path.to_string_lossy().to_string();

    // Fast path: the persistent sequential-decode pipe (D-030). Cheap for a
    // forward step / short scrub, a keyframe-seek respawn for a jump — always at
    // least as fast as the old per-frame `ffmpeg` spawn. Any pipe error falls
    // back to `video::decode_frame` (unchanged behaviour).
    let path = cv.path.clone();
    let info = cv.info.clone();
    let scale = scale_long_edge
        .and_then(|le| decode_pipe::scale_target(cv.info.resolution.width, cv.info.resolution.height, le));
    let decoded = tokio::task::spawn_blocking(move || {
        decode_pipe::playback_frame_scaled(
            decode_pipe::PipeSlot::Current,
            &path,
            &info,
            clamped,
            scale,
        )
        .or_else(|e| {
            log::warn!("[chroma::seek] decode pipe fell back to single-frame decode: {e}");
            video::decode_frame(&path, video::FramePos::Index(clamped), &info)
        })
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;

    Ok(load::install_frame(
        &cv.path,
        &virtual_path,
        clamped,
        cv.info.clone(),
        decoded,
        state,
    ))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameThumbDto {
    pub frame: u64,
    /// data:image/jpeg;base64,...
    pub data_url: String,
}

/// `count` evenly-spaced frame thumbnails across the loaded clip, for the timeline.
/// Decoded once per (clip, count) then cached.
#[tauri::command]
pub async fn chroma_frame_thumbnails(count: u32) -> Result<Vec<FrameThumbDto>, String> {
    let cv = current_video().ok_or("no video loaded")?;
    let count = count.clamp(4, 200);

    if let Some(hit) = cached_thumbs(&cv.path, count) {
        return Ok(hit
            .into_iter()
            .map(|(frame, data_url)| FrameThumbDto { frame, data_url })
            .collect());
    }

    let path = cv.path.clone();
    let info = cv.info.clone();
    let thumbs = tokio::task::spawn_blocking(move || -> Result<Vec<(u64, String)>, String> {
        video::extract_thumb_strip(&path, &info, count).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;

    store_thumbs(cv.path.clone(), count, thumbs.clone());
    Ok(thumbs
        .into_iter()
        .map(|(frame, data_url)| FrameThumbDto { frame, data_url })
        .collect())
}

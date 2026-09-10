//! Tauri commands for the video transport. Kept here so `lib.rs` only gains the
//! two `generate_handler!` lines.

use crate::app_state::AppState;
use crate::image_loader::LoadImageResult;

use super::state::current_video;
use super::{colorist_view, decode_pipe, load, video};

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
///
/// **D-294 (B-147) — reported against the Edit-timeline CLIP when there is
/// one.** `frameCount`/`durationSecs` are the clip's own length and
/// `width`/`height` are the project's composition size, because those are what
/// the Colorist transport is actually scrubbing and what its canvas actually
/// shows after [`seek_and_install`] places the frame. Reporting the raw source
/// file's 2990 frames for a clip trimmed to 400 is precisely the half of B-147
/// that let the transport scrub past the clip's out-point into footage neither
/// the Edit tab nor the export ever shows. `fps` stays the SOURCE's: the
/// transport's wall-clock playback loop steps source frames at source rate,
/// and a clip is not resampled onto the timeline's rate by the Colorist.
///
/// An Untitled loose-clip session (no project, so no clip) reports the raw
/// source exactly as before — which was always right for that case.
#[tauri::command]
pub fn chroma_video_info() -> Option<VideoInfoDto> {
    let cv = current_video()?;
    let view = colorist_view::resolve(&cv.path);
    let (resolution, frame_count) = match &view {
        Some(v) => (
            apelles_types::Resolution {
                width: v.comp.0,
                height: v.comp.1,
            },
            v.frame_count(),
        ),
        None => (cv.info.resolution, cv.info.frame_count),
    };
    let fps = cv.info.fps();
    let duration_secs = if fps > 0.0 {
        frame_count as f64 / fps
    } else {
        cv.info.duration_secs
    };
    Some(VideoInfoDto {
        is_video: true,
        path: cv.path.to_string_lossy().to_string(),
        resolution,
        fps,
        frame_count,
        duration_secs,
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
///
/// **D-294 (B-147) — `frame` is CLIP-LOCAL, and the installed picture carries
/// the clip's geometry.** When the active shot is a clip on the open project's
/// Edit timeline ([`colorist_view::resolve`]), `frame` counts from that clip's
/// in-point, the source frame actually decoded comes from the clip's own trim
/// (and speed ramp) via `Clip::clamped_source_frame_at`, and the decoded
/// picture is placed into composition space with the clip's crop / scale /
/// rotation / position applied — so the Colorist grades the same picture the
/// Edit preview and the export show. Deliberately **not** the clip's grade
/// (that is what the Colorist is producing) and not its opacity/fade (there
/// are no layers beneath it here) — see `colorist_view`'s module doc.
///
/// An Untitled loose-clip session resolves no clip and takes exactly the
/// pre-D-294 raw-source path, which was always correct for it.
pub async fn seek_and_install(
    frame: u64,
    scale_long_edge: Option<u32>,
    state: &tauri::State<'_, AppState>,
) -> Result<LoadImageResult, String> {
    let cv = current_video().ok_or("no video loaded")?;
    let view = colorist_view::resolve(&cv.path);
    // `clamped` is what the session's playhead marker and every frame-keyed
    // Colorist artefact (tracked mattes D-019, mask keyframes D-034, the depth
    // track D-036) are indexed by, so it stays in the transport's own space —
    // clip-local when there is a clip. `decode_frame_index` is the source
    // frame that space maps to.
    let clamped = match &view {
        Some(v) => frame.min(v.frame_count().saturating_sub(1)),
        None => frame.min(cv.info.frame_count.saturating_sub(1)),
    };
    let decode_frame_index = match &view {
        Some(v) => v.source_frame(clamped),
        None => clamped,
    };

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
    let scale = scale_long_edge.and_then(|le| {
        decode_pipe::scale_target(cv.info.resolution.width, cv.info.resolution.height, le)
    });
    let view_for_task = view.clone();
    let decoded = tokio::task::spawn_blocking(move || -> Result<image::DynamicImage, String> {
        let img = decode_pipe::playback_frame_scaled(
            decode_pipe::PipeSlot::Current,
            &path,
            &info,
            decode_frame_index,
            scale,
        )
        .or_else(|e| {
            log::warn!("[chroma::seek] decode pipe fell back to single-frame decode: {e}");
            video::decode_frame(&path, video::FramePos::Index(decode_frame_index), &info)
        })
        .map_err(|e| e.to_string())?;
        // D-294 — the geometry pass, on the blocking thread with the decode it
        // belongs to (it is a CPU resize + rotate of a full frame). Free for an
        // untransformed clip: `apply_geometry` hands the buffer straight back.
        match view_for_task {
            Some(v) => v.apply_geometry(decode_frame_index, img, scale_long_edge),
            None => Ok(img),
        }
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(load::install_frame(
        &cv.path,
        &virtual_path,
        clamped,
        cv.info.clone(),
        decoded,
        state,
    ))
}

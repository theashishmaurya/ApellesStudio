//! Tauri bridge for subject matte via the Apelles AI sidecar (SAM 2 → trimap →
//! ViTMatte, D-016).
//!
//! What it is: the app-side half of the D-142 `apelles-ai` extraction
//! (`docs/notes/crate-extraction-plan.md` §2.5). `chroma_subject_mask` stays
//! whole here because it needs `crate::get_cached_full_warped_image(&state, …)`
//! and returns `crate::ai_processing::AiSubjectMaskParameters` — both real
//! fork types `apelles-ai` must not depend on — but its actual `/segment` wire
//! call is now `apelles_ai::mask::segment`. The other three commands
//! (`chroma_track_subject`, `chroma_refine_tracked_frame`, plus
//! `chroma_track_status`/`chroma_ai_health` with no state at all) are thin
//! wrappers that resolve `chroma::state::current_video()` and call into
//! `apelles_ai::mask`. [`tracked_full_mask`] gets the same treatment as
//! `depth::tracked_depth_map`. This file used to be the whole 322-line
//! implementation; see D-142 in `docs/08-decisions.md`.

use base64::{Engine as _, engine::general_purpose::STANDARD};
use image::ImageFormat;

use crate::AppState;
use crate::ai_processing::AiSubjectMaskParameters;
use crate::chroma::state;

pub use apelles_ai::mask::MaskPoint;

/// Segment the current frame's subject and return it as an AI-subject mask.
///
/// Prompt precedence: explicit `points` and/or `bbox` if given, else `auto_person`
/// (the sidecar runs a person detector and takes the most central one).
///
/// `bbox` / `points` are in the coordinate space of the full de-warped frame — the
/// same space RapidRAW's `generate_ai_subject_mask` uses.
#[tauri::command]
pub async fn chroma_subject_mask(
    js_adjustments: serde_json::Value,
    points: Option<Vec<MaskPoint>>,
    bbox: Option<(f64, f64, f64, f64)>,
    refine: Option<bool>,
    state: tauri::State<'_, AppState>,
) -> Result<AiSubjectMaskParameters, String> {
    let warped = crate::get_cached_full_warped_image(&state, &js_adjustments)?;
    let (frame_w, frame_h) = (warped.width(), warped.height());

    // encode the frame once, off the async runtime
    let image_b64 = tokio::task::spawn_blocking(move || -> Result<String, String> {
        let mut buf = std::io::Cursor::new(Vec::new());
        warped
            .write_to(&mut buf, ImageFormat::Png)
            .map_err(|e| e.to_string())?;
        Ok(STANDARD.encode(buf.get_ref()))
    })
    .await
    .map_err(|e| e.to_string())??;

    let points = points.unwrap_or_default();
    let seg = apelles_ai::mask::segment(&image_b64, &points, bbox, refine.unwrap_or(true)).await?;

    if seg.width != frame_w || seg.height != frame_h {
        // The downstream transform math (generate_ai_bitmap_from_full_mask) assumes the
        // matte is at full frame res. The sidecar echoes the input size, so this is a
        // "shouldn't happen" — warn rather than fail.
        eprintln!(
            "[chroma] subject matte {}x{} != frame {frame_w}x{frame_h}",
            seg.width, seg.height
        );
    }

    // NOTE (v1 limitation): rotation / flip / orientation are stored so a rotated clip
    // still composites, but click coords are not un-rotated before segmentation yet —
    // subject mask on a rotated/flipped video will be off. Talking-head footage isn't
    // rotated; port the coord math from generate_ai_subject_mask when needed.
    // `seg.send_box` is the *normalized* box `segment()` actually sent to the
    // sidecar (None if `bbox` was None, or was a tiny drag collapsed into an
    // include-point) — not the raw `bbox` parameter this command received.
    // Matches the pre-D-142 behaviour exactly.
    let (sx, sy, ex, ey) = seg.send_box.unwrap_or((0.0, 0.0, frame_w as f64, frame_h as f64));
    Ok(AiSubjectMaskParameters {
        start_x: sx,
        start_y: sy,
        end_x: ex,
        end_y: ey,
        mask_data_base64: Some(format!("data:image/png;base64,{}", seg.matte_b64)),
        rotation: Some(0.0),
        flip_horizontal: Some(false),
        flip_vertical: Some(false),
        orientation_steps: Some(0),
    })
}

/// Kick off a per-frame subject-matte pass over the loaded clip. Returns the
/// sidecar job (`job_id`, `dir`, `total`) immediately; poll [`chroma_track_status`].
/// Mattes are cached under `<video_dir>/.chroma/mattes/<key>/`; the frontend stores
/// that `dir` in the sub-mask's `chromaTrackDir` param and the renderer reads the
/// current frame's PNG via [`tracked_full_mask`].
#[tauri::command]
pub async fn chroma_track_subject(
    from_frame: Option<u64>,
    to_frame: Option<i64>,
    step: Option<u32>,
    bbox: Option<(f64, f64, f64, f64)>,
    points: Option<Vec<MaskPoint>>,
    mode: Option<String>,
) -> Result<serde_json::Value, String> {
    let cv = state::current_video().ok_or("no video loaded")?;
    apelles_ai::mask::track(
        &cv.path.to_string_lossy(),
        from_frame,
        to_frame,
        step,
        bbox,
        points.as_deref(),
        mode.as_deref(),
    )
    .await
}

/// Poll a `/track` job.
#[tauri::command]
pub async fn chroma_track_status(job_id: String) -> Result<serde_json::Value, String> {
    apelles_ai::mask::track_status(&job_id).await
}

/// Upgrade one cached tracked frame to a ViTMatte edge (the fast pass uses a
/// guided filter). Overwrites `<track_dir>/<frame>.png` in place. The frontend
/// calls this on seek-settle, then bumps the frame nonce to re-render — the
/// renderer picks the new PNG up via [`tracked_full_mask`].
#[tauri::command]
pub async fn chroma_refine_tracked_frame(track_dir: String, frame: u64) -> Result<bool, String> {
    let Some(cv) = state::current_video() else {
        return Ok(false);
    };
    apelles_ai::mask::refine_tracked_frame(&cv.path.to_string_lossy(), &track_dir, frame).await
}

/// The tracked subject matte for the currently-decoded video frame, as a
/// full-res `GrayImage` ready for `generate_ai_bitmap_from_full_mask`. Reads
/// `params.chromaTrackDir` + `chroma::state::current_video().frame` and
/// delegates the PNG lookup to `apelles_ai::mask::mask_at`. `None` when the
/// sub-mask isn't tracked, no video is loaded, or nothing is cached yet at
/// that point.
pub fn tracked_full_mask(params: &serde_json::Value) -> Option<image::GrayImage> {
    let dir = params.get("chromaTrackDir").and_then(|v| v.as_str())?;
    let frame = state::current_video()?.frame;
    apelles_ai::mask::mask_at(dir, frame)
}

/// Is the Apelles AI sidecar up? Drives the UI hint. Never errors.
#[tauri::command]
pub async fn chroma_ai_health() -> serde_json::Value {
    apelles_ai::mask::health().await
}

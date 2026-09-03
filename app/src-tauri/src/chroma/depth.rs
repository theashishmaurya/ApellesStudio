//! Per-frame depth **track** via the Chroma AI sidecar (Video Depth Anything —
//! Small, D-036).
//!
//! Mirrors the subject track (`chroma::mask`, D-018/D-019): a background job
//! precomputes a *temporally-consistent* depth map for every frame of the clip
//! and caches them as single-channel PNGs under
//! `<video_dir>/.chroma/depth/<key>/<frame:06d>.png`. The depth sub-mask stores
//! that directory once in `params.chromaDepthDir`; [`tracked_depth_map`] — called
//! from the one render-time hook in `mask_generation::generate_ai_depth_bitmap`
//! — loads the current source frame's PNG instead of the static
//! `mask_data_base64` bake. Matte and frame are the same render pass, always in
//! lockstep; scrub / playback / export all get per-frame depth for free because
//! they already set `chroma::state::current_video().frame`.
//!
//! Why the sidecar and not the in-process Rust ONNX Depth Anything V2: VDA's
//! temporal consistency comes from cross-frame self-attention threaded through
//! the whole window — the same "too fragile to ONNX-export" case D-009 used to
//! justify the Python sidecar for SAM 2's video memory. The Rust DA-V2 path is
//! unchanged and stays the **static single-frame bake** for stills and for
//! `apply_haze` when no track has been run.
//!
//! Fork hygiene (D-003): all new code; `chroma/mod.rs` +1 `pub mod depth;`,
//! `lib.rs` +2 `generate_handler!` lines, and the one hook in
//! `mask_generation.rs`. Divergence log: docs/09.

use std::path::PathBuf;

use serde_json::json;

fn sidecar_base_url() -> String {
    let port = std::env::var("CHROMA_AI_PORT").unwrap_or_else(|_| "8765".to_string());
    format!("http://127.0.0.1:{port}")
}

fn unreachable_hint(e: impl std::fmt::Display) -> String {
    format!(
        "Chroma AI sidecar unreachable ({e}). The app auto-starts it (D-028) — check \
         the app log for '[sidecar]' lines (CHROMA_AI_NO_SPAWN=1 disables the auto-start; \
         manual start: cd ai && ./run.sh). The first depth track also lazy-downloads the \
         VDA-Small checkpoint (~112 MB) into ai/models/."
    )
}

/// Kick off a per-frame depth pass over the loaded clip. Returns the sidecar job
/// (`job_id`, `dir`, `total`) immediately; poll [`chroma_depth_track_status`].
/// The frontend stores the returned `dir` in the depth sub-mask's
/// `chromaDepthDir` param and the renderer reads the current frame's PNG via
/// [`tracked_depth_map`].
///
/// `step` only controls save density — every frame is fed to the model so the
/// temporal head stays dense. `input_size` (default 518) trades detail for speed;
/// `max_res` (default 1280) caps the decode + stored PNG long edge.
#[tauri::command]
pub async fn chroma_depth_track(
    from_frame: Option<u64>,
    to_frame: Option<i64>,
    step: Option<u32>,
    input_size: Option<u32>,
    max_res: Option<u32>,
) -> Result<serde_json::Value, String> {
    // D-067: this command had zero logging — a real gap when an owner's
    // "clicked Track Depth multiple times, nothing happened" report can't
    // be told apart from "the click never reached this command," "no video
    // was loaded so it errored immediately," "the sidecar rejected it," and
    // "it genuinely worked and the render is what's broken," purely from
    // app.log. Every real exit path now logs.
    let cv = match crate::chroma::state::current_video() {
        Some(cv) => cv,
        None => {
            log::error!("[relight] chroma_depth_track: no video loaded");
            return Err("no video loaded".into());
        }
    };
    log::info!(
        "[relight] chroma_depth_track: starting for {} (from={:?} to={:?} step={:?})",
        cv.path.display(),
        from_frame,
        to_frame,
        step
    );

    let body = json!({
        "video_path": cv.path.to_string_lossy(),
        "from_frame": from_frame.unwrap_or(0),
        "to_frame": to_frame.unwrap_or(-1),
        "step": step.unwrap_or(1).max(1),
        "input_size": input_size.unwrap_or(518),
        "max_res": max_res.unwrap_or(1280),
    });

    let response = reqwest::Client::new()
        .post(format!("{}/depth_track", sidecar_base_url()))
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            let msg = unreachable_hint(e);
            log::error!("[relight] chroma_depth_track: sidecar unreachable: {msg}");
            msg
        })?;
    let v: serde_json::Value = response.json().await.map_err(|e| {
        log::error!("[relight] chroma_depth_track: bad sidecar response: {e}");
        e.to_string()
    })?;

    if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
        log::error!("[relight] chroma_depth_track: sidecar returned an error: {err}");
        return Err(err.to_string());
    }
    log::info!("[relight] chroma_depth_track: job started, response: {v}");
    Ok(v) // `dir` is in the response; the frontend stores it on the sub-mask
}

/// Poll a `/depth_track` job.
#[tauri::command]
pub async fn chroma_depth_track_status(job_id: String) -> Result<serde_json::Value, String> {
    let v: serde_json::Value = reqwest::Client::new()
        .get(format!("{}/depth_track/{job_id}", sidecar_base_url()))
        .send()
        .await
        .map_err(|e| {
            let msg = unreachable_hint(e);
            log::error!("[relight] chroma_depth_track_status({job_id}): sidecar unreachable: {msg}");
            msg
        })?
        .json()
        .await
        .map_err(|e| {
            log::error!("[relight] chroma_depth_track_status({job_id}): bad sidecar response: {e}");
            e.to_string()
        })?;
    // D-067: only the terminal states, not every 2s poll — this loop runs
    // for as long as the track takes, logging every tick would be noise.
    if let Some(state) = v.get("state").and_then(|s| s.as_str())
        && matches!(state, "done" | "error" | "cancelled" | "unknown")
    {
        log::info!("[relight] chroma_depth_track_status({job_id}): terminal state {state}, response: {v}");
    }
    Ok(v)
}

/// The tracked depth map for the currently-decoded video frame, as a full-res
/// `GrayImage` (bright = near — VDA's native disparity orientation, same as the
/// Rust DA-V2 bake, so `generate_ai_depth_bitmap`'s existing invert handling is
/// unchanged). Reads `params.chromaDepthDir` + `chroma::state::current_video().frame`
/// and loads the nearest `<frame:06d>.png` at or before it (so a `step > 1`
/// track holds each map until the next sample). `None` when the sub-mask has no
/// `chromaDepthDir`, no video is loaded, or nothing is cached at that point yet —
/// the caller then falls back to the static `mask_data_base64` bake.
pub fn tracked_depth_map(params: &serde_json::Value) -> Option<image::GrayImage> {
    let dir = params
        .get("chromaDepthDir")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())?;
    let frame = crate::chroma::state::current_video()?.frame;
    let path = nearest_frame_png(dir, frame)?;
    Some(image::open(path).ok()?.to_luma8())
}

/// The `<dir>/<n>.png` with the largest `n <= frame`. Filenames are the absolute
/// source-frame index (any zero-padding), non-numeric stems ignored.
fn nearest_frame_png(dir: &str, frame: u64) -> Option<PathBuf> {
    let mut best: Option<(u64, PathBuf)> = None;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("png") {
            continue;
        }
        let Some(n) = path
            .file_stem()
            .and_then(|s| s.to_str())
            .and_then(|s| s.parse::<u64>().ok())
        else {
            continue;
        };
        if n <= frame && best.as_ref().is_none_or(|(b, _)| n > *b) {
            best = Some((n, path));
        }
    }
    best.map(|(_, p)| p)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{GrayImage, Luma};

    fn write_png(dir: &std::path::Path, frame: u64, fill: u8) {
        let mut img = GrayImage::new(8, 8);
        for p in img.pixels_mut() {
            *p = Luma([fill]);
        }
        img.save(dir.join(format!("{frame:06}.png"))).unwrap();
    }

    #[test]
    fn nearest_is_the_largest_at_or_before_frame() {
        let tmp = std::env::temp_dir().join(format!("chroma_depth_nearest_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        for f in [0u64, 5, 10, 20] {
            write_png(&tmp, f, (f + 1) as u8);
        }
        let d = tmp.to_str().unwrap();

        // exact hit
        assert!(nearest_frame_png(d, 10).unwrap().ends_with("000010.png"));
        // between samples -> hold the earlier one (step > 1 behaviour)
        assert!(nearest_frame_png(d, 7).unwrap().ends_with("000005.png"));
        assert!(nearest_frame_png(d, 19).unwrap().ends_with("000010.png"));
        // past the last sample -> hold the last
        assert!(nearest_frame_png(d, 999).unwrap().ends_with("000020.png"));
        // before the first sample -> nothing
        assert!(nearest_frame_png(d, 0).unwrap().ends_with("000000.png"));

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn before_first_sample_is_none() {
        let tmp = std::env::temp_dir().join(format!("chroma_depth_before_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        write_png(&tmp, 100, 42);
        assert!(nearest_frame_png(tmp.to_str().unwrap(), 50).is_none());
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn missing_dir_and_absent_param_are_none() {
        assert!(nearest_frame_png("/no/such/chroma/depth/dir", 10).is_none());
        // no chromaDepthDir key -> None (the static-bake path is taken)
        assert!(tracked_depth_map(&json!({ "minDepth": 0.0, "maxDepth": 100.0 })).is_none());
        assert!(tracked_depth_map(&json!({ "chromaDepthDir": "" })).is_none());
    }

    /// Non-numeric PNG stems (e.g. a stray `_preview.png`) are skipped, not parsed.
    #[test]
    fn non_numeric_stems_ignored() {
        let tmp = std::env::temp_dir().join(format!("chroma_depth_stems_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        write_png(&tmp, 3, 10);
        GrayImage::new(4, 4).save(tmp.join("_preview.png")).unwrap();
        std::fs::write(tmp.join("_depth.json"), "{}").unwrap();
        assert!(nearest_frame_png(tmp.to_str().unwrap(), 100).unwrap().ends_with("000003.png"));
        std::fs::remove_dir_all(&tmp).ok();
    }
}

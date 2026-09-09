//! Per-frame depth **track** via the Apelles AI sidecar (Video Depth Anything —
//! Small, D-036). Extracted from `app/src-tauri/src/chroma/depth.rs` into
//! `apelles-ai` in D-145 (crate-extraction-plan.md §2.5).
//!
//! Mirrors the subject track ([`crate::mask`], D-018/D-019): a background job
//! precomputes a *temporally-consistent* depth map for every frame of the clip
//! and caches them as single-channel PNGs under
//! `<video_dir>/.chroma/depth/<key>/<frame:06d>.png`. The depth sub-mask stores
//! that directory once in `params.chromaDepthDir`; [`depth_map_at`] — called
//! from the app-side `tracked_depth_map` wrapper, itself called from the one
//! render-time hook in `mask_generation::generate_ai_depth_bitmap` — loads the
//! current source frame's PNG instead of the static `mask_data_base64` bake.
//! Matte and frame are the same render pass, always in lockstep; scrub /
//! playback / export all get per-frame depth for free because the app-side
//! wrapper already reads `chroma::state::current_video().frame` for them.
//!
//! Why the sidecar and not the in-process Rust ONNX Depth Anything V2: VDA's
//! temporal consistency comes from cross-frame self-attention threaded through
//! the whole window — the same "too fragile to ONNX-export" case D-009 used to
//! justify the Python sidecar for SAM 2's video memory. The Rust DA-V2 path is
//! unchanged and stays the **static single-frame bake** for stills and for
//! `apply_haze` when no track has been run.
//!
//! **D-145 signature change:** the original `tracked_depth_map(params: &Value)`
//! read `crate::chroma::state::current_video()?.frame` directly — a fork-side
//! global this crate cannot see. Split in two: [`depth_map_at`] here takes the
//! depth dir and frame index as plain arguments (a strictly better signature —
//! testable with no global, no fork dependency); the app-side
//! `chroma::depth::tracked_depth_map` keeps its old `(&Value)` signature
//! (so `mask_generation.rs`'s call sites are untouched), reads the dir out of
//! the sub-mask params and the frame out of `state::current_video()`
//! internally, then calls this.
//!
//! What moved: the `/depth_track` + `/depth_track/<id>` HTTP client bodies
//! (`depth_track`, `depth_track_status` — the `#[tauri::command]` attribute and
//! the `current_video()` lookup for the video path stayed behind; the app-side
//! command wrappers supply `video_path` explicitly) and `nearest_frame_png` /
//! `depth_map_at`, unchanged logic.

use std::path::PathBuf;

use serde_json::json;

fn unreachable_hint(e: impl std::fmt::Display) -> String {
    format!(
        "Apelles AI sidecar unreachable ({e}). The app auto-starts it (D-028) — check \
         the app log for '[sidecar]' lines (CHROMA_AI_NO_SPAWN=1 disables the auto-start; \
         manual start: cd ai && ./run.sh). The first depth track also lazy-downloads the \
         VDA-Small checkpoint (~112 MB) into ai/models/."
    )
}

/// Kick off a per-frame depth pass over `video_path`. Returns the sidecar job
/// (`job_id`, `dir`, `total`) immediately; poll [`depth_track_status`]. The
/// frontend stores the returned `dir` in the depth sub-mask's `chromaDepthDir`
/// param and the renderer reads the current frame's PNG via [`depth_map_at`].
///
/// `step` only controls save density — every frame is fed to the model so the
/// temporal head stays dense. `input_size` (default 518) trades detail for speed;
/// `max_res` (default 1280) caps the decode + stored PNG long edge.
///
/// D-145: takes `video_path` explicitly (was `crate::chroma::state::current_video()`
/// in the app-side original) — the app-side `chroma_depth_track` command resolves
/// the current video and logs "no video loaded" before ever calling this.
pub async fn depth_track(
    video_path: &str,
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
    log::info!(
        "[relight] chroma_depth_track: starting for {video_path} (from={:?} to={:?} step={:?})",
        from_frame,
        to_frame,
        step
    );

    let body = json!({
        "video_path": video_path,
        "from_frame": from_frame.unwrap_or(0),
        "to_frame": to_frame.unwrap_or(-1),
        "step": step.unwrap_or(1).max(1),
        "input_size": input_size.unwrap_or(518),
        "max_res": max_res.unwrap_or(1280),
    });

    let response = reqwest::Client::new()
        .post(format!("{}/depth_track", crate::sidecar_base_url()))
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            let msg = unreachable_hint(e);
            log::error!("[relight] chroma_depth_track: sidecar unreachable: {msg}");
            msg
        })?;
    // D-067 follow-up: the real bug that motivated this whole file's logging
    // pass in the first place — a stale, already-running sidecar process
    // (started days before this route existed, and never restarted because
    // `spawn_and_supervise` defers entirely to *anything* already answering
    // `/health`, D-028) 404'd every `/depth_track` call with a plain
    // `{"detail":"Not Found"}` body. Nothing here ever checked the HTTP
    // status — `.json()` happily parsed that body, `v.get("error")` found
    // nothing (the key is `"detail"`, not `"error"`), so this silently
    // returned `Ok` with no `dir`/`job_id` at all. The frontend then had
    // nothing to poll and nothing to store, `depthTrackProgress` cleared
    // almost instantly, and the owner's "I clicked it, nothing happened"
    // was the only visible symptom of what was actually an infrastructure
    // problem (a stale process), not a code bug in this command. Checking
    // status first closes this whole failure class, not just this one
    // instance of it — a differently-broken sidecar response in the future
    // fails loudly here instead of silently downstream.
    let status = response.status();
    let text = response.text().await.map_err(|e| {
        log::error!("[relight] chroma_depth_track: couldn't read sidecar response body: {e}");
        e.to_string()
    })?;
    if !status.is_success() {
        log::error!("[relight] chroma_depth_track: sidecar returned HTTP {status}: {text}");
        return Err(format!(
            "sidecar returned HTTP {status}: {text} — if this is \"Not Found\", the sidecar \
             is probably a stale process from before this route existed; restart it (kill \
             whatever's on :8765, then `cd ai && ./run.sh`, or just relaunch the app if \
             nothing was already running on that port)"
        ));
    }
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| {
        log::error!("[relight] chroma_depth_track: bad sidecar response JSON: {e} (body: {text})");
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
pub async fn depth_track_status(job_id: &str) -> Result<serde_json::Value, String> {
    let response = reqwest::Client::new()
        .get(format!("{}/depth_track/{job_id}", crate::sidecar_base_url()))
        .send()
        .await
        .map_err(|e| {
            let msg = unreachable_hint(e);
            log::error!("[relight] chroma_depth_track_status({job_id}): sidecar unreachable: {msg}");
            msg
        })?;
    // Same status-check discipline as `depth_track` above (D-067 follow-up) —
    // don't parse a non-2xx body as if it were a real status.
    let status = response.status();
    let text = response.text().await.map_err(|e| {
        log::error!("[relight] chroma_depth_track_status({job_id}): couldn't read response body: {e}");
        e.to_string()
    })?;
    if !status.is_success() {
        log::error!("[relight] chroma_depth_track_status({job_id}): sidecar returned HTTP {status}: {text}");
        return Err(format!("sidecar returned HTTP {status}: {text}"));
    }
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| {
        log::error!("[relight] chroma_depth_track_status({job_id}): bad response JSON: {e} (body: {text})");
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

/// The tracked depth map for source frame `frame` under `dir`, as a full-res
/// `GrayImage` (bright = near — VDA's native disparity orientation, same as the
/// Rust DA-V2 bake, so `generate_ai_depth_bitmap`'s existing invert handling is
/// unchanged). `None` when nothing is cached at or before `frame` yet — the
/// caller then falls back to the static `mask_data_base64` bake.
///
/// D-145: replaces the old `tracked_depth_map(params: &Value)`, which read
/// `chromaDepthDir` out of the params `Value` and the frame out of
/// `chroma::state::current_video()` itself — both fork/app concerns this crate
/// can't see. The app-side wrapper of the same old name does that lookup now
/// and calls this.
pub fn depth_map_at(dir: &str, frame: u64) -> Option<image::GrayImage> {
    let path = nearest_frame_png(dir, frame)?;
    Some(image::open(path).ok()?.to_luma8())
}

/// The `<dir>/<n>.png` with the largest `n <= frame`. Filenames are the absolute
/// source-frame index (any zero-padding), non-numeric stems ignored.
pub fn nearest_frame_png(dir: &str, frame: u64) -> Option<PathBuf> {
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
    fn missing_dir_and_empty_dir_are_none() {
        assert!(nearest_frame_png("/no/such/chroma/depth/dir", 10).is_none());
        assert!(depth_map_at("/no/such/chroma/depth/dir", 10).is_none());
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

    #[test]
    fn depth_map_at_loads_the_nearest_png_as_luma8() {
        let tmp = std::env::temp_dir().join(format!("chroma_depth_map_at_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        write_png(&tmp, 0, 77);
        write_png(&tmp, 10, 200);

        let img = depth_map_at(tmp.to_str().unwrap(), 12).expect("a PNG at or before frame 12");
        assert_eq!(img.get_pixel(0, 0).0[0], 200, "frame 12 should hold the frame-10 sample");

        std::fs::remove_dir_all(&tmp).ok();
    }
}

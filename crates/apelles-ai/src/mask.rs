//! Subject matte wire plumbing for the Apelles AI sidecar (SAM 2 → trimap →
//! ViTMatte, D-016). Extracted from `app/src-tauri/src/chroma/mask.rs` into
//! `apelles-ai` in D-145 (crate-extraction-plan.md §2.5).
//!
//! The sidecar (`ai/`, FastAPI on MPS) does the segmentation + matting. This
//! module is the request/response wire shapes and the actual HTTP calls to
//! `/segment`, `/track`, `/track/<id>`, `/refine_track`, `/health` — nothing
//! here knows about `AppState`, the warped-frame cache, or
//! `AiSubjectMaskParameters` (all real fork types in `app/src-tauri` that this
//! crate must not depend on or duplicate, per the extraction plan).
//!
//! **What stayed in `app/src-tauri/src/chroma/mask.rs` and why:**
//! - `chroma_subject_mask` (the `#[tauri::command]`) — needs
//!   `crate::get_cached_full_warped_image(&state, …)` for the frame to segment
//!   and returns `crate::ai_processing::AiSubjectMaskParameters` to the
//!   frontend; both are fork types. It now calls this module's [`segment`] for
//!   the actual wire call, then builds the `AiSubjectMaskParameters` itself.
//! - `chroma_track_subject` / `chroma_refine_tracked_frame` — thin wrappers
//!   that resolve `chroma::state::current_video()` for the video path (a
//!   fork-side global) and call [`track`] / [`refine_tracked_frame`] here.
//! - `tracked_full_mask` — see [`mask_at`] below; D-145 gave it the same
//!   treatment as `depth::tracked_depth_map`: unchanged `(&Value)` signature
//!   at the app boundary (so `mask_generation.rs` needed no edits), the frame
//!   index pushed down as a plain argument only at this crate's boundary.

use std::path::PathBuf;

use serde::Deserialize;
use serde_json::json;

/// One click prompt, in **warped-image pixel coords**. `label`: 1 = include, 0 = exclude.
#[derive(Debug, Clone, Deserialize)]
pub struct MaskPoint {
    pub x: f64,
    pub y: f64,
    pub label: i32,
}

/// The raw `/segment` response shape, before validation. Not exposed —
/// [`segment`] turns this into a [`SegmentResult`] or an `Err`.
#[derive(Debug, Deserialize)]
struct RawSegmentResponse {
    #[serde(default)]
    matte_b64: Option<String>,
    #[serde(default)]
    width: u32,
    #[serde(default)]
    height: u32,
    #[serde(default)]
    refined: bool,
    #[serde(default)]
    sam_ms: Option<u64>,
    #[serde(default)]
    refine_ms: Option<u64>,
    #[serde(default)]
    error: Option<String>,
}

/// A successful `/segment` call: always has a matte (a missing one with no
/// `error` field is itself turned into an `Err` by [`segment`], so callers
/// never have to re-check).
#[derive(Debug, Clone)]
pub struct SegmentResult {
    pub matte_b64: String,
    pub width: u32,
    pub height: u32,
    pub refined: bool,
    pub sam_ms: Option<u64>,
    pub refine_ms: Option<u64>,
    /// The normalized box actually sent to the sidecar as `"box"`, or `None`
    /// if the caller's `bbox` was `None`, or collapsed into an include-point
    /// because it was a tiny drag (see [`build_segment_prompt`]). Callers that
    /// need to record what was actually segmented (e.g. `AiSubjectMaskParameters`'s
    /// `start_x`/`start_y`/`end_x`/`end_y`) should use this, not their own raw
    /// `bbox` — the pre-D-145 code stored this same normalized-or-None value,
    /// never the raw caller bbox.
    pub send_box: Option<(f64, f64, f64, f64)>,
}

/// A tiny drag is a click — sent as an include-point, not a degenerate box
/// (SAM returns nothing for a zero-area box). `points`/`bbox` are in the
/// coordinate space of the full de-warped frame — the same space RapidRAW's
/// `generate_ai_subject_mask` uses.
fn build_segment_prompt(
    points: &[MaskPoint],
    bbox: Option<(f64, f64, f64, f64)>,
) -> (Vec<[f64; 3]>, Option<(f64, f64, f64, f64)>) {
    let mut pts: Vec<[f64; 3]> = points.iter().map(|p| [p.x, p.y, p.label as f64]).collect();
    let mut send_box: Option<(f64, f64, f64, f64)> = None;
    if let Some((x1, y1, x2, y2)) = bbox {
        if (x2 - x1).abs() < 8.0 && (y2 - y1).abs() < 8.0 {
            pts.push([(x1 + x2) / 2.0, (y1 + y2) / 2.0, 1.0]);
        } else {
            send_box = Some((x1.min(x2), y1.min(y2), x1.max(x2), y1.max(y2)));
        }
    }
    (pts, send_box)
}

/// Segment `image_b64` (a full de-warped frame, PNG-encoded, base64) and
/// return the matte. Prompt precedence: explicit `points` and/or `bbox` if
/// given, else auto-person (the sidecar runs a person detector and takes the
/// most central one).
pub async fn segment(
    image_b64: &str,
    points: &[MaskPoint],
    bbox: Option<(f64, f64, f64, f64)>,
    refine: bool,
) -> Result<SegmentResult, String> {
    let (pts, send_box) = build_segment_prompt(points, bbox);

    let mut body = json!({
        "image_b64": image_b64,
        "auto_person": pts.is_empty() && send_box.is_none(),
        "refine": refine,
    });
    if !pts.is_empty() {
        body["points"] = json!(pts);
    }
    if let Some((x1, y1, x2, y2)) = send_box {
        body["box"] = json!([x1, y1, x2, y2]);
    }

    let resp = reqwest::Client::new()
        .post(format!("{}/segment", crate::sidecar_base_url()))
        .json(&body)
        .timeout(std::time::Duration::from_secs(180))
        .send()
        .await
        .map_err(|e| {
            format!(
                "Apelles AI sidecar unreachable ({e}). The app auto-starts it (D-028) — \
                 check the app log for '[sidecar]' lines. If you run it yourself, set \
                 CHROMA_AI_NO_SPAWN=1; otherwise it will keep retrying. Manual start still \
                 works: cd ai && ./run.sh"
            )
        })?;

    let status = resp.status();
    let body = resp.bytes().await.map_err(|e| format!("read /segment body: {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "sidecar /segment: HTTP {status} — {}",
            String::from_utf8_lossy(&body).chars().take(300).collect::<String>()
        ));
    }
    let seg: RawSegmentResponse = serde_json::from_slice(&body).map_err(|e| {
        format!(
            "decode /segment ({e}) — {} bytes, starts: {}",
            body.len(),
            String::from_utf8_lossy(&body).chars().take(200).collect::<String>()
        )
    })?;
    if let Some(err) = seg.error {
        return Err(format!("sidecar: {err}"));
    }
    let matte_b64 = seg
        .matte_b64
        .ok_or("sidecar /segment returned no matte and no error")?;

    log::info!(
        "[chroma] subject mask: refined={} sam={:?}ms refine={:?}ms",
        seg.refined,
        seg.sam_ms,
        seg.refine_ms
    );

    Ok(SegmentResult {
        matte_b64,
        width: seg.width,
        height: seg.height,
        refined: seg.refined,
        sam_ms: seg.sam_ms,
        refine_ms: seg.refine_ms,
        send_box,
    })
}

/// Kick off a per-frame subject-matte pass over `video_path`. Returns the
/// sidecar job (`job_id`, `dir`, `total`) immediately; poll [`track_status`].
/// Mattes are cached under `<video_dir>/.chroma/mattes/<key>/`; the frontend
/// stores that `dir` in the sub-mask's `chromaTrackDir` param and the renderer
/// reads the current frame's PNG via [`mask_at`].
pub async fn track(
    video_path: &str,
    from_frame: Option<u64>,
    to_frame: Option<i64>,
    step: Option<u32>,
    bbox: Option<(f64, f64, f64, f64)>,
    points: Option<&[MaskPoint]>,
    mode: Option<&str>,
) -> Result<serde_json::Value, String> {
    let mut body = json!({
        "video_path": video_path,
        "from_frame": from_frame.unwrap_or(0),
        "to_frame": to_frame.unwrap_or(-1),
        "step": step.unwrap_or(1),
        "mode": mode.unwrap_or("fast"),
    });
    if let Some((x1, y1, x2, y2)) = bbox {
        if (x2 - x1).abs() >= 8.0 && (y2 - y1).abs() >= 8.0 {
            body["box"] = json!([x1.min(x2), y1.min(y2), x1.max(x2), y1.max(y2)]);
        }
    }
    if let Some(pts) = points {
        if !pts.is_empty() {
            body["points"] =
                json!(pts.iter().map(|p| [p.x, p.y, p.label as f64]).collect::<Vec<_>>());
        }
    }

    let v: serde_json::Value = reqwest::Client::new()
        .post(format!("{}/track", crate::sidecar_base_url()))
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            format!(
                "Apelles AI sidecar unreachable ({e}). The app auto-starts it (D-028) — check \
                 the app log for '[sidecar]' lines (CHROMA_AI_NO_SPAWN=1 disables the auto-start; \
                 manual start: cd ai && ./run.sh)."
            )
        })?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
        return Err(err.to_string());
    }
    Ok(v) // `dir` is in the response; the frontend stores it on the sub-mask
}

/// Poll a `/track` job.
pub async fn track_status(job_id: &str) -> Result<serde_json::Value, String> {
    reqwest::Client::new()
        .get(format!("{}/track/{job_id}", crate::sidecar_base_url()))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())
}

/// Upgrade one cached tracked frame of `video_path` to a ViTMatte edge (the
/// fast pass uses a guided filter). Overwrites `<track_dir>/<frame>.png` in
/// place. The frontend calls this on seek-settle, then bumps the frame nonce
/// to re-render — the renderer picks the new PNG up via [`mask_at`]. Returns
/// whether the sidecar actually returned a matte.
pub async fn refine_tracked_frame(
    video_path: &str,
    track_dir: &str,
    frame: u64,
) -> Result<bool, String> {
    let v: serde_json::Value = reqwest::Client::new()
        .post(format!("{}/refine_track", crate::sidecar_base_url()))
        .json(&json!({
            "video_path": video_path,
            "dir": track_dir,
            "frame": frame,
        }))
        .timeout(std::time::Duration::from_secs(60))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
        return Err(err.to_string());
    }
    Ok(v.get("matte_b64").is_some())
}

/// Is the Apelles AI sidecar up? Drives the UI hint. Never errors.
pub async fn health() -> serde_json::Value {
    match reqwest::Client::new()
        .get(format!("{}/health", crate::sidecar_base_url()))
        .timeout(std::time::Duration::from_secs(2))
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => {
            r.json().await.unwrap_or_else(|_| json!({ "ok": true }))
        }
        _ => json!({ "ok": false }),
    }
}

/// The tracked subject matte for source frame `frame` under `dir`, as a
/// full-res `GrayImage` ready for `generate_ai_bitmap_from_full_mask`. `None`
/// when nothing is cached at or before `frame` yet.
///
/// D-145: backs the app-side `tracked_full_mask(params: &Value)`, which kept
/// its old signature (so `mask_generation.rs`'s call site needed no edit) and
/// now just reads `chromaTrackDir` out of the params `Value` and the frame out
/// of `chroma::state::current_video()` internally, then calls this — same
/// split as `depth::depth_map_at`. The old code had that dir/frame lookup and
/// the PNG scan inlined into one function (unlike `depth.rs`'s
/// `nearest_frame_png`, already a named, tested helper); [`nearest_track_png`]
/// gives it the same treatment now.
pub fn mask_at(dir: &str, frame: u64) -> Option<image::GrayImage> {
    let path = nearest_track_png(dir, frame)?;
    Some(image::open(path).ok()?.to_luma8())
}

/// The `<dir>/<n>.png` with the largest `n <= frame`. Filenames are the
/// absolute source-frame index (any zero-padding), non-numeric stems ignored.
/// Extracted out of the old inlined scan in `tracked_full_mask` — mirrors
/// `depth::nearest_frame_png`, now equally unit-tested.
pub fn nearest_track_png(dir: &str, frame: u64) -> Option<PathBuf> {
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
        img.save(dir.join(format!("{frame}.png"))).unwrap();
    }

    #[test]
    fn build_segment_prompt_turns_a_tiny_drag_into_a_click() {
        let (pts, send_box) = build_segment_prompt(&[], Some((10.0, 10.0, 12.0, 11.0)));
        assert!(send_box.is_none(), "a <8px drag on either axis must not become a box");
        assert_eq!(pts.len(), 1);
        assert_eq!(pts[0], [11.0, 10.5, 1.0]);
    }

    #[test]
    fn build_segment_prompt_keeps_a_real_box_normalized() {
        let (pts, send_box) = build_segment_prompt(&[], Some((50.0, 40.0, 10.0, 20.0)));
        assert!(pts.is_empty());
        assert_eq!(send_box, Some((10.0, 20.0, 50.0, 40.0)), "min/max normalized regardless of drag direction");
    }

    #[test]
    fn build_segment_prompt_passes_explicit_points_through() {
        let points = vec![MaskPoint { x: 1.0, y: 2.0, label: 1 }, MaskPoint { x: 3.0, y: 4.0, label: 0 }];
        let (pts, send_box) = build_segment_prompt(&points, None);
        assert_eq!(pts, vec![[1.0, 2.0, 1.0], [3.0, 4.0, 0.0]]);
        assert!(send_box.is_none());
    }

    #[test]
    fn nearest_track_png_is_the_largest_at_or_before_frame() {
        let tmp = std::env::temp_dir().join(format!("chroma_mask_nearest_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        for f in [0u64, 5, 10, 20] {
            write_png(&tmp, f, (f + 1) as u8);
        }
        let d = tmp.to_str().unwrap();

        assert!(nearest_track_png(d, 10).unwrap().ends_with("10.png"));
        assert!(nearest_track_png(d, 7).unwrap().ends_with("5.png"));
        assert!(nearest_track_png(d, 999).unwrap().ends_with("20.png"));
        assert!(nearest_track_png(d, 0).unwrap().ends_with("0.png"));

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn nearest_track_png_before_first_sample_is_none() {
        let tmp = std::env::temp_dir().join(format!("chroma_mask_before_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        write_png(&tmp, 100, 42);
        assert!(nearest_track_png(tmp.to_str().unwrap(), 50).is_none());
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn mask_at_missing_dir_is_none() {
        assert!(mask_at("/no/such/chroma/track/dir", 10).is_none());
    }

    #[test]
    fn mask_at_loads_the_nearest_png_as_luma8() {
        let tmp = std::env::temp_dir().join(format!("chroma_mask_at_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        write_png(&tmp, 0, 77);
        write_png(&tmp, 10, 200);

        let img = mask_at(tmp.to_str().unwrap(), 12).expect("a PNG at or before frame 12");
        assert_eq!(img.get_pixel(0, 0).0[0], 200, "frame 12 should hold the frame-10 sample");

        std::fs::remove_dir_all(&tmp).ok();
    }
}

//! Subject matte via the Chroma AI sidecar (SAM 2 → trimap → ViTMatte, D-016).
//!
//! The sidecar (`chroma/ai/`, FastAPI on MPS) does the segmentation + matting. This
//! module is just the bridge: grab the current de-warped frame, POST it to `/segment`,
//! hand the returned matte back as an [`AiSubjectMaskParameters`] — the exact same shape
//! RapidRAW's in-process ONNX SAM path returns, so everything downstream (mask bitmap
//! decode, per-mask grade UI, render) is unchanged.

use std::path::PathBuf;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use image::ImageFormat;
use serde::Deserialize;
use serde_json::json;

use crate::AppState;
use crate::ai_processing::AiSubjectMaskParameters;

fn sidecar_base_url() -> String {
    let port = std::env::var("CHROMA_AI_PORT").unwrap_or_else(|_| "8765".to_string());
    format!("http://127.0.0.1:{port}")
}

/// One click prompt, in **warped-image pixel coords**. `label`: 1 = include, 0 = exclude.
#[derive(Debug, Clone, Deserialize)]
pub struct MaskPoint {
    pub x: f64,
    pub y: f64,
    pub label: i32,
}

#[derive(Debug, Deserialize)]
struct SegmentResponse {
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

    // A tiny drag is a click — send it as an include-point, not a degenerate box
    // (SAM returns nothing for a zero-area box).
    let mut pts: Vec<[f64; 3]> = points
        .unwrap_or_default()
        .iter()
        .map(|p| [p.x, p.y, p.label as f64])
        .collect();
    let mut send_box: Option<(f64, f64, f64, f64)> = None;
    if let Some((x1, y1, x2, y2)) = bbox {
        if (x2 - x1).abs() < 8.0 && (y2 - y1).abs() < 8.0 {
            pts.push([(x1 + x2) / 2.0, (y1 + y2) / 2.0, 1.0]);
        } else {
            send_box = Some((x1.min(x2), y1.min(y2), x1.max(x2), y1.max(y2)));
        }
    }

    let mut body = serde_json::json!({
        "image_b64": image_b64,
        "auto_person": pts.is_empty() && send_box.is_none(),
        "refine": refine.unwrap_or(true),
    });
    if !pts.is_empty() {
        body["points"] = serde_json::json!(pts);
    }
    if let Some((x1, y1, x2, y2)) = send_box {
        body["box"] = serde_json::json!([x1, y1, x2, y2]);
    }

    let resp = reqwest::Client::new()
        .post(format!("{}/segment", sidecar_base_url()))
        .json(&body)
        .timeout(std::time::Duration::from_secs(180))
        .send()
        .await
        .map_err(|e| {
            format!(
                "Chroma AI sidecar unreachable ({e}). The app auto-starts it (D-028) — \
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
    let seg: SegmentResponse = serde_json::from_slice(&body).map_err(|e| {
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
    if seg.width != frame_w || seg.height != frame_h {
        // The downstream transform math (generate_ai_bitmap_from_full_mask) assumes the
        // matte is at full frame res. The sidecar echoes the input size, so this is a
        // "shouldn't happen" — warn rather than fail.
        eprintln!(
            "[chroma] subject matte {}x{} != frame {frame_w}x{frame_h}",
            seg.width, seg.height
        );
    }
    eprintln!(
        "[chroma] subject mask: refined={} sam={:?}ms refine={:?}ms",
        seg.refined, seg.sam_ms, seg.refine_ms
    );

    // NOTE (v1 limitation): rotation / flip / orientation are stored so a rotated clip
    // still composites, but click coords are not un-rotated before segmentation yet —
    // subject mask on a rotated/flipped video will be off. Talking-head footage isn't
    // rotated; port the coord math from generate_ai_subject_mask when needed.
    let (sx, sy, ex, ey) = send_box.unwrap_or((0.0, 0.0, frame_w as f64, frame_h as f64));
    Ok(AiSubjectMaskParameters {
        start_x: sx,
        start_y: sy,
        end_x: ex,
        end_y: ey,
        mask_data_base64: Some(format!("data:image/png;base64,{}", matte_b64)),
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
    let cv = crate::chroma::state::current_video().ok_or("no video loaded")?;

    let mut body = json!({
        "video_path": cv.path.to_string_lossy(),
        "from_frame": from_frame.unwrap_or(0),
        "to_frame": to_frame.unwrap_or(-1),
        "step": step.unwrap_or(1),
        "mode": mode.unwrap_or_else(|| "fast".to_string()),
    });
    if let Some((x1, y1, x2, y2)) = bbox {
        if (x2 - x1).abs() >= 8.0 && (y2 - y1).abs() >= 8.0 {
            body["box"] = json!([x1.min(x2), y1.min(y2), x1.max(x2), y1.max(y2)]);
        }
    }
    if let Some(pts) = &points {
        if !pts.is_empty() {
            body["points"] =
                json!(pts.iter().map(|p| [p.x, p.y, p.label as f64]).collect::<Vec<_>>());
        }
    }

    let v: serde_json::Value = reqwest::Client::new()
        .post(format!("{}/track", sidecar_base_url()))
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            format!(
                "Chroma AI sidecar unreachable ({e}). The app auto-starts it (D-028) — check \
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
#[tauri::command]
pub async fn chroma_track_status(job_id: String) -> Result<serde_json::Value, String> {
    reqwest::Client::new()
        .get(format!("{}/track/{job_id}", sidecar_base_url()))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())
}

/// Upgrade one cached tracked frame to a ViTMatte edge (the fast pass uses a
/// guided filter). Overwrites `<track_dir>/<frame>.png` in place. The frontend
/// calls this on seek-settle, then bumps the frame nonce to re-render — the
/// renderer picks the new PNG up via [`tracked_full_mask`].
#[tauri::command]
pub async fn chroma_refine_tracked_frame(
    track_dir: String,
    frame: u64,
) -> Result<bool, String> {
    let Some(cv) = crate::chroma::state::current_video() else {
        return Ok(false);
    };
    let v: serde_json::Value = reqwest::Client::new()
        .post(format!("{}/refine_track", sidecar_base_url()))
        .json(&json!({
            "video_path": cv.path.to_string_lossy(),
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

/// The tracked subject matte for the currently-decoded video frame, as a full-res
/// `GrayImage` ready for `generate_ai_bitmap_from_full_mask`. Reads
/// `params.chromaTrackDir` + `chroma::state::current_video().frame` and loads the
/// nearest `<frame>.png` at or before it. `None` when the sub-mask isn't tracked,
/// no video is loaded, or nothing is cached yet at that point.
pub fn tracked_full_mask(params: &serde_json::Value) -> Option<image::GrayImage> {
    let dir = params.get("chromaTrackDir").and_then(|v| v.as_str())?;
    let frame = crate::chroma::state::current_video()?.frame;

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
    let (_, path) = best?;
    Some(image::open(path).ok()?.to_luma8())
}

/// Is the Chroma AI sidecar up? Drives the UI hint. Never errors.
#[tauri::command]
pub async fn chroma_ai_health() -> serde_json::Value {
    match reqwest::Client::new()
        .get(format!("{}/health", sidecar_base_url()))
        .timeout(std::time::Duration::from_secs(2))
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r.json().await.unwrap_or_else(|_| {
            serde_json::json!({ "ok": true })
        }),
        _ => serde_json::json!({ "ok": false }),
    }
}

//! Editor tab bridge (D-041) — the `chroma-timeline` model ⇄ the frontend.
//!
//! What it is: the Tauri command surface for the **Edit tab** MVP — get / set a
//!   single-video-track [`Timeline`] of the open project's shots, and decode one
//!   timeline frame to a JPEG data-URL for the preview pane.
//! What it does: `chroma_timeline_get` returns the project's persisted timeline
//!   or builds a fresh one from its shots (probing each source for a frame
//!   count here — `chroma-timeline` never touches media) and persists it;
//!   `chroma_timeline_set` replaces + persists it; `chroma_timeline_frame`
//!   resolves a timeline position to `(clip, source frame)` via
//!   [`chroma_timeline::Track::clip_at`] and decodes that source frame with the
//!   lightweight [`super::decode_pipe`] path (ffmpeg → rgb → JPEG).
//! What it does NOT do: no `wgpu`, no colour grade, no compositing — the editor
//!   preview is deliberately independent of the Colorist's `AppState` render
//!   path (grade-in-preview + multi-layer compositing are a later
//!   `chroma-compositor` step). No multi-track / audio / transitions /
//!   transcript cut / OTIO export / MCP — MVP only (D-041).
//!
//! The timeline is persisted **inside the `.chroma` project**:
//!   `ProjectManifest.timeline: Option<Timeline>` (additive, `#[serde(default)]`,
//!   schema major unchanged — same move D-038 made for `settings`). It travels
//!   through the existing `load_manifest` / `save_manifest`.
//!
//! Fork hygiene (D-003): all new code here + in `chroma-timeline`; the only
//!   `project.rs` edit is the `timeline` field. Upstream footprint is
//!   `pub mod edit;` in `chroma/mod.rs` + the `generate_handler!` lines in
//!   `lib.rs`. Divergence logged in `docs/09-engine-notes.md`.

use std::collections::HashMap;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use base64::Engine as _;
use image::codecs::jpeg::JpegEncoder;
use once_cell::sync::Lazy;

use chroma_timeline::{Timeline, TrackKind};

use super::state;
use super::video::{self, VideoInfo};
use super::{decode_pipe, project};

// --------------------------------------------------------------------------- //
// per-clip probe cache (edit-tab local — the preview decodes many frames of a
// handful of clip paths; a probe is a subprocess spawn we don't want per frame)
// --------------------------------------------------------------------------- //

static PROBE_CACHE: Lazy<Mutex<HashMap<PathBuf, VideoInfo>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn probe_cached(path: &Path) -> Result<VideoInfo, String> {
    {
        let cache = PROBE_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(info) = cache.get(path) {
            return Ok(info.clone());
        }
    }
    let info = video::probe(path).map_err(|e| format!("probe {}: {e}", path.display()))?;
    PROBE_CACHE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(path.to_path_buf(), info.clone());
    Ok(info)
}

// --------------------------------------------------------------------------- //
// timeline load / build / persist
// --------------------------------------------------------------------------- //

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn current_project_dir() -> Result<PathBuf, String> {
    state::current_project()
        .map(|p| p.path)
        .ok_or_else(|| "no project open — open one in the Colorist tab".to_string())
}

/// Build a single-video-track timeline from a manifest's shots, probing each
/// source for its frame count (0 when a source is offline / not probe-able).
fn build_from_shots(manifest: &project::ProjectManifest) -> Timeline {
    let tuples: Vec<(String, String, String, i64)> = manifest
        .shots
        .iter()
        .map(|shot| {
            let name = shot
                .name
                .clone()
                .or_else(|| {
                    Path::new(&shot.source_path)
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                })
                .unwrap_or_else(|| shot.source_path.clone());
            let frames = probe_cached(Path::new(&shot.source_path))
                .map(|i| i.frame_count as i64)
                .unwrap_or(0);
            (shot.id.clone(), shot.source_path.clone(), name, frames)
        })
        .collect();
    let mut tl = Timeline::from_shots(&tuples);
    tl.name = manifest.name.clone();
    tl
}

/// The open project's timeline: its persisted one, or a fresh build from its
/// shots. `persist` writes a freshly-built timeline back to `project.json` so a
/// later save keeps it (get does this; the per-frame decode does not).
fn resolve_timeline(persist: bool) -> Result<Timeline, String> {
    let dir = current_project_dir()?;
    let mut manifest = project::load_manifest(&dir)?;
    if let Some(tl) = manifest.timeline.clone() {
        return Ok(tl);
    }
    let tl = build_from_shots(&manifest);
    if persist {
        manifest.timeline = Some(tl.clone());
        manifest.modified = now_rfc3339();
        project::save_manifest(&dir, &manifest)?;
    }
    Ok(tl)
}

// --------------------------------------------------------------------------- //
// tauri commands
// --------------------------------------------------------------------------- //

/// The open project's edit timeline. Builds one from the project's shots (one
/// full-length video clip per shot, back to back) the first time, and persists
/// that so subsequent opens / saves keep it.
#[tauri::command]
pub fn chroma_timeline_get() -> Result<Timeline, String> {
    resolve_timeline(true)
}

/// Replace the open project's timeline and persist it to `project.json`.
#[tauri::command]
pub fn chroma_timeline_set(timeline: Timeline) -> Result<(), String> {
    let dir = current_project_dir()?;
    let mut manifest = project::load_manifest(&dir)?;
    manifest.timeline = Some(timeline);
    manifest.modified = now_rfc3339();
    project::save_manifest(&dir, &manifest)
}

/// A 1×1 transparent PNG data-URL — returned for a timeline position past the
/// end (or before the start), so the preview `<img>` clears instead of erroring.
fn blank_frame() -> String {
    // 1×1 transparent PNG, precomputed.
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==".to_string()
}

/// Decode the source frame under timeline position `pos` and return it as a
/// `data:image/jpeg;base64,…` string. `max_long_edge` (px) optionally caps the
/// decoded size — ffmpeg downscales, so a 4K source is never CPU-scaled here.
///
/// This is a plain decode → JPEG: no grade, no compositing, no `AppState`
/// (D-041). Out-of-range → a 1×1 transparent PNG; a decode / probe failure →
/// `Err`.
#[tauri::command]
pub fn chroma_timeline_frame(pos: u64, max_long_edge: Option<u32>) -> Result<String, String> {
    let timeline = resolve_timeline(false)?;
    let track = timeline
        .tracks
        .iter()
        .find(|t| t.kind == TrackKind::Video)
        .ok_or("timeline has no video track")?;

    let Some((clip, source_frame)) = track.clip_at(pos as i64) else {
        return Ok(blank_frame());
    };
    if clip.source_path.is_empty() {
        return Ok(blank_frame());
    }

    let path = PathBuf::from(&clip.source_path);
    let info = probe_cached(&path)?;
    let scale = max_long_edge.and_then(|le| decode_pipe::scale_target(info.width, info.height, le));

    let frame = source_frame.max(0) as u64;
    let img = decode_pipe::playback_frame_scaled(&path, &info, frame, scale)
        .map_err(|e| format!("decode {} @ src frame {frame}: {e}", path.display()))?;

    let mut buf = Cursor::new(Vec::with_capacity(64 * 1024));
    img.to_rgb8()
        .write_with_encoder(JpegEncoder::new_with_quality(&mut buf, 80))
        .map_err(|e| format!("jpeg encode: {e}"))?;
    Ok(format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(buf.get_ref())
    ))
}

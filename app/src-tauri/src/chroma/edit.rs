//! Editor tab bridge (D-041, multi-timeline D-045) — the `chroma-timeline`
//! model ⇄ the frontend.
//!
//! What it is: the Tauri command surface for the **Edit tab** — get / set the
//!   project's **active** [`Timeline`] (D-041 was single-video-track and
//!   singular; D-045 made a project hold several independently-editable named
//!   timelines, one active), list/create/switch timelines, and decode one
//!   timeline frame to a JPEG data-URL for the preview pane.
//! What it does: `chroma_timeline_get` returns the active timeline (building a
//!   fresh one from the project's shots the first time — probing each source
//!   for a frame count here, `chroma-timeline` never touches media — and
//!   persisting it) or `chroma_timeline_set` replaces it; `chroma_timeline_list`
//!   /`chroma_timeline_create`/`chroma_timeline_set_active` manage the
//!   `timelines` list itself; `chroma_timeline_frame` resolves a timeline
//!   position on the active timeline to `(clip, source frame)` via
//!   [`chroma_timeline::Track::clip_at`] and decodes that source frame with the
//!   lightweight [`super::decode_pipe`] path (ffmpeg → rgb → JPEG).
//! What it does NOT do: no `wgpu`, no colour grade, no compositing — the editor
//!   preview is deliberately independent of the Colorist's `AppState` render
//!   path (grade-in-preview + multi-layer compositing are a later
//!   `chroma-compositor` step). No multi-track / audio / transitions /
//!   transcript cut / OTIO export / MCP — MVP only (D-041). No
//!   timeline-switcher UI yet (D-045 pass 2 is model + commands only; "active
//!   timeline" is a Rust-side concept the frontend doesn't need to know about
//!   for the existing single-timeline Edit tab to keep working) — pass 3.
//!
//! The timelines are persisted **inside the `.chroma` project**:
//!   `ProjectManifest.timelines: Vec<Timeline>` + `active_timeline: usize`
//!   (additive, `#[serde(default)]`, schema major unchanged — same move D-038
//!   made for `settings`). `project::load_manifest` losslessly migrates a
//!   legacy singular `timeline` key (D-041's shape) into a one-element
//!   `timelines` list — see the D-045 decision.
//!
//! Fork hygiene (D-003): all new code here + in `chroma-timeline`; the only
//!   `project.rs` edit is the `timelines`/`active_timeline` fields. Upstream
//!   footprint is `pub mod edit;` in `chroma/mod.rs` + the `generate_handler!`
//!   lines in `lib.rs`. Divergence logged in `docs/09-engine-notes.md`.

use std::collections::HashMap;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use base64::Engine as _;
use image::codecs::jpeg::JpegEncoder;
use once_cell::sync::Lazy;
use serde::Serialize;

use chroma_timeline::{Clip, Timeline, TrackKind};

use super::state;
use super::video::{self, VideoInfo};
use super::{decode_pipe, project};

// --------------------------------------------------------------------------- //
// per-clip probe cache (edit-tab local — the preview decodes many frames of a
// handful of clip paths; a probe is a subprocess spawn we don't want per frame).
// `pub(crate)` (D-051): also the has-audio lookup `chroma::audio`'s waveform
// command reuses rather than probing a second time.
// --------------------------------------------------------------------------- //

static PROBE_CACHE: Lazy<Mutex<HashMap<PathBuf, VideoInfo>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

pub(crate) fn probe_cached(path: &Path) -> Result<VideoInfo, String> {
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

/// Build a single-video-track timeline from a manifest's shots, resolving
/// each shot's source path/name via its `media_id` (D-046 — see
/// `project::resolve_shot`) and probing that path for its frame count (0 when
/// offline / not probe-able / dangling). Assigns a fresh id (D-045) —
/// `chroma-timeline` itself never generates one.
fn build_from_shots(manifest: &project::ProjectManifest) -> Timeline {
    let tuples: Vec<(String, String, String, i64)> = manifest
        .shots
        .iter()
        .map(|shot| {
            let (source_path, name) = project::resolve_shot(manifest, shot);
            let frames = probe_cached(Path::new(&source_path))
                .map(|i| i.frame_count as i64)
                .unwrap_or(0);
            (shot.id.clone(), source_path, name, frames)
        })
        .collect();
    let mut tl = Timeline::from_shots(&tuples);
    tl.id = uuid::Uuid::new_v4().to_string();
    tl.name = manifest.name.clone();
    tl
}

/// Ensure `manifest.timelines` is non-empty (lazily building one from shots —
/// the same D-041 fallback `chroma_timeline_get` always had — if it's empty)
/// and that `active_timeline` points at a valid entry. `persist` controls
/// whether a freshly-built timeline is written back to `project.json` (get
/// does this; the per-frame decode does not, matching the old behaviour).
fn ensure_timeline(
    dir: &Path,
    mut manifest: project::ProjectManifest,
    persist: bool,
) -> Result<project::ProjectManifest, String> {
    if manifest.timelines.is_empty() {
        let tl = build_from_shots(&manifest);
        manifest.timelines.push(tl);
        manifest.active_timeline = 0;
        if persist {
            manifest.modified = now_rfc3339();
            project::save_manifest(dir, &manifest)?;
        }
    } else if manifest.active_timeline >= manifest.timelines.len() {
        manifest.active_timeline = 0;
    }
    Ok(manifest)
}

/// Load the open project's manifest with `timelines` guaranteed non-empty and
/// `active_timeline` valid.
fn load_and_ensure_timeline(persist: bool) -> Result<(PathBuf, project::ProjectManifest), String> {
    let dir = current_project_dir()?;
    let manifest = project::load_manifest(&dir)?;
    let manifest = ensure_timeline(&dir, manifest, persist)?;
    Ok((dir, manifest))
}

/// The open project's **active** timeline (D-045) — its persisted one, or a
/// fresh build from its shots the first time.
fn resolve_timeline(persist: bool) -> Result<Timeline, String> {
    let (_dir, manifest) = load_and_ensure_timeline(persist)?;
    Ok(manifest.timelines[manifest.active_timeline].clone())
}

/// Resolve timeline position `pos` on the **active** timeline's video track
/// to its clip, the corresponding **source** frame, and that clip's probed
/// [`VideoInfo`] (D-049) — the shared first half of both the video preview's
/// [`chroma_timeline_frame`] and the audio path's `audio::chroma_audio_play`:
/// both read from the same clip at the same position, one for pixels, one for
/// samples. `Ok(None)` when `pos` is past the end of the video track (or
/// before it) or the clip's source path is empty/offline — the same "just
/// show/play nothing" case both callers already handle, not an error.
pub(crate) fn resolve_video_position(pos: u64) -> Result<Option<(Clip, u64, VideoInfo)>, String> {
    let timeline = resolve_timeline(false)?;
    let track = timeline
        .tracks
        .iter()
        .find(|t| t.kind == TrackKind::Video)
        .ok_or("timeline has no video track")?;

    let Some((clip, source_frame)) = track.clip_at(pos as i64) else {
        return Ok(None);
    };
    if clip.source_path.is_empty() {
        return Ok(None);
    }
    let info = probe_cached(Path::new(&clip.source_path))?;
    Ok(Some((clip.clone(), source_frame.max(0) as u64, info)))
}

// --------------------------------------------------------------------------- //
// tauri commands
// --------------------------------------------------------------------------- //

/// The open project's **active** edit timeline. Builds one from the project's
/// shots (one full-length video clip per shot, back to back) the first time a
/// project has no timelines at all, and persists that so subsequent opens /
/// saves keep it. Unchanged signature/behaviour from D-041 for a
/// single-timeline project — "active timeline" is invisible here unless the
/// caller has made more than one (`chroma_timeline_create`).
#[tauri::command]
pub fn chroma_timeline_get() -> Result<Timeline, String> {
    resolve_timeline(true)
}

/// Replace the open project's **active** timeline and persist it to
/// `project.json`. Stores whatever is sent verbatim (no server-side
/// clamping) — same contract as D-041, now scoped to whichever timeline is
/// active rather than assuming there's only one.
#[tauri::command]
pub fn chroma_timeline_set(timeline: Timeline) -> Result<(), String> {
    let (dir, mut manifest) = load_and_ensure_timeline(false)?;
    let idx = manifest.active_timeline;
    manifest.timelines[idx] = timeline;
    manifest.modified = now_rfc3339();
    project::save_manifest(&dir, &manifest)
}

/// One timeline's id/name/duration + whether it's the active one — what
/// [`chroma_timeline_list`] returns. For a future timeline-switcher UI
/// (D-045 pass 3); no UI consumes this yet.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineSummary {
    pub id: String,
    pub name: String,
    pub duration: i64,
    pub active: bool,
}

/// All of the open project's timelines (D-045). Lazily builds the first one
/// from shots (same fallback [`chroma_timeline_get`] always had) if the
/// project has none yet, so this never returns an empty list for a project
/// with at least the implicit shots-derived timeline.
#[tauri::command]
pub fn chroma_timeline_list() -> Result<Vec<TimelineSummary>, String> {
    let (_dir, manifest) = load_and_ensure_timeline(true)?;
    Ok(manifest
        .timelines
        .iter()
        .enumerate()
        .map(|(i, tl)| TimelineSummary {
            id: tl.id.clone(),
            name: tl.name.clone(),
            duration: tl.duration(),
            active: i == manifest.active_timeline,
        })
        .collect())
}

/// Create a new, empty, named timeline, append it to the project, make it the
/// active timeline, and persist. Returns the full new [`Timeline`] so a
/// caller can use it immediately without a second `chroma_timeline_get`.
#[tauri::command]
pub fn chroma_timeline_create(name: String) -> Result<Timeline, String> {
    let (dir, mut manifest) = load_and_ensure_timeline(false)?;
    let tl = Timeline {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        rate: None,
        tracks: Vec::new(),
    };
    manifest.timelines.push(tl.clone());
    manifest.active_timeline = manifest.timelines.len() - 1;
    manifest.modified = now_rfc3339();
    project::save_manifest(&dir, &manifest)?;
    Ok(tl)
}

/// Make the timeline with `id` the active one — every `chroma_timeline_get`/
/// `_set`/`_frame` call after this targets it. Errors (leaving the active
/// timeline unchanged) if no timeline in the project has that id.
#[tauri::command]
pub fn chroma_timeline_set_active(id: String) -> Result<(), String> {
    let (dir, mut manifest) = load_and_ensure_timeline(false)?;
    let idx = manifest
        .timelines
        .iter()
        .position(|tl| tl.id == id)
        .ok_or_else(|| format!("no timeline with id {id}"))?;
    manifest.active_timeline = idx;
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
    let Some((clip, frame, info)) = resolve_video_position(pos)? else {
        return Ok(blank_frame());
    };

    let path = PathBuf::from(&clip.source_path);
    let scale = max_long_edge.and_then(|le| decode_pipe::scale_target(info.resolution.width, info.resolution.height, le));

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

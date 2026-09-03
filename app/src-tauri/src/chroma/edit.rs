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
//!   lightweight [`super::decode_pipe`] path (ffmpeg → rgb → JPEG);
//!   clips (including across tracks) on the active timeline;
//!   `resolve_audio_track_positions` (D-057, Phase C) is the audio-track
//!   counterpart of `resolve_video_position`, resolving every genuine
//!   `TrackKind::Audio` clip overlapping a position for `chroma::audio`'s
//!   mixer.
//! What it does NOT do: no `wgpu`, no colour grade, no pixel-level
//!   compositing — the editor preview is deliberately independent of the
//!   Colorist's `AppState` render path (grade-in-preview + real multi-texture
//!   blending are a later `chroma-compositor` step, Phase B3). Still no
//!   transitions / transcript cut / OTIO export / MCP.
//!   `resolve_video_position` (shared by `chroma_timeline_frame` and the
//!   audio path) now resolves **N video tracks under opaque, top-wins
//!   compositing** (D-056, Phase B1) — video tracks in index order, first one
//!   with a clip (not a gap) at the position wins, via
//!   `chroma_timeline::Timeline::resolve_video_clip_at`; this needed no new
//!   rendering code, since opaque top-wins is a track-**selection** problem,
//!   not a pixel-blending one. Audio mixing across `TrackKind::Audio` tracks
//!   is real now too (D-057, `chroma::audio`'s mixer) — this module just
//!   resolves *which* clips are active, the actual decode/mix/output lives in
//!   `chroma::audio`. No timeline-switcher UI yet (D-045 pass 2 is model +
//!   commands only; "active timeline" is a Rust-side concept the frontend
//!   doesn't need to know about for the existing single-timeline Edit tab to
//!   keep working) — pass 3. No multi-track UI either (Phase D, blocked on
//!   nothing further now that B1 and C have both landed, but not yet built).
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
///
/// `pub(crate)` (unify-clip-model doc): `chroma::project::open_manifest` also
/// calls this, before sourcing the Colorist shot strip from the active
/// timeline's clips — a project opened for the first time since ever (no
/// `timelines` key at all) must still get one built from its legacy `shots`,
/// exactly as `chroma_timeline_get` always lazily did, or the strip would
/// show nothing until the user happened to visit the Edit tab first.
pub(crate) fn ensure_timeline(
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
/// fresh build from its shots the first time. `pub(crate)` (D-056): also how
/// `chroma::audio`'s mixer enumerates every genuine `TrackKind::Audio` track
/// on the active timeline (`resolve_audio_track_positions`, below).
pub(crate) fn resolve_timeline(persist: bool) -> Result<Timeline, String> {
    let (_dir, manifest) = load_and_ensure_timeline(persist)?;
    Ok(manifest.timelines[manifest.active_timeline].clone())
}

/// Resolve timeline position `pos` on the **active** timeline to the single
/// winning clip under **opaque, top-track-wins** compositing (D-056, Phase B1
/// of `docs/notes/multi-track-nle.md`), the corresponding **source** frame,
/// and that clip's probed [`VideoInfo`] (D-049) — the shared first half of
/// both the video preview's [`chroma_timeline_frame`] and the audio path's
/// `audio::chroma_audio_play`: both read from the same clip at the same
/// position, one for pixels, one for samples.
///
/// The track-priority walk itself (video tracks in index order, first one
/// with a clip — not a gap — at `pos` wins) is
/// [`chroma_timeline::Timeline::resolve_video_clip_at`] — pure model logic,
/// no media involved, unit-tested at the `chroma-timeline` crate level. This
/// function is the thin media-layer wrapper around it: probe the winning
/// clip's source so the caller gets pixel dimensions/frame-rate too, which
/// `chroma-timeline` itself never touches.
///
/// `Ok(None)` when every video track has a gap at `pos` (or `pos` is
/// negative / past everything) or the winning clip's source path is
/// empty/offline — the same "just show/play nothing" case both callers
/// already handle, not an error. Still errors if the timeline has no video
/// track at all (distinct from "every video track has a gap here").
pub(crate) fn resolve_video_position(pos: u64) -> Result<Option<(Clip, u64, VideoInfo)>, String> {
    let timeline = resolve_timeline(false)?;
    if !timeline.tracks.iter().any(|t| t.kind == TrackKind::Video) {
        return Err("timeline has no video track".to_string());
    }

    let Some((_track_idx, clip, source_frame)) = timeline.resolve_video_clip_at(pos as i64) else {
        return Ok(None);
    };
    if clip.source_path.is_empty() {
        return Ok(None);
    }
    let info = probe_cached(Path::new(&clip.source_path))?;
    Ok(Some((clip.clone(), source_frame.max(0) as u64, info)))
}

/// Resolve every genuine `TrackKind::Audio` clip on the active timeline that
/// overlaps `pos` to `(source path, source start in seconds, that track's
/// gain)` — the Phase C (D-056) counterpart to [`resolve_video_position`]'s
/// single video-track lookup, feeding `chroma::audio`'s mixer the extra
/// sources to sum in alongside the baseline video-embedded audio. Uses
/// [`chroma_timeline::Track::clip_at`] exactly like the video path — a track
/// with nothing covering `pos` (a gap, or an empty track, which today is
/// every `Audio` track since nothing in the app populates one yet — see
/// `chroma::audio`'s module doc) contributes nothing, silently, same "not an
/// error" contract `resolve_video_position` already has. A clip whose source
/// turns out to have no audio stream is skipped the same way.
pub(crate) fn resolve_audio_track_positions(pos: u64) -> Result<Vec<(PathBuf, f64, f32)>, String> {
    let timeline = resolve_timeline(false)?;
    let mut out = Vec::new();
    for track in timeline
        .tracks
        .iter()
        .filter(|t| t.kind == TrackKind::Audio)
    {
        let Some((clip, source_frame)) = track.clip_at(pos as i64) else {
            continue;
        };
        if clip.source_path.is_empty() {
            continue;
        }
        let info = probe_cached(Path::new(&clip.source_path))?;
        if !info.has_audio {
            continue;
        }
        let start_secs = info.frame_to_secs(source_frame.max(0) as u64);
        out.push((PathBuf::from(&clip.source_path), start_secs, track.gain));
    }
    Ok(out)
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

// --------------------------------------------------------------------------- //
// track management + cross-track move (D-054, Phase A of the multi-track NLE
// note — model + commands only, no frontend consumer yet: see
// docs/notes/multi-track-nle.md).
// --------------------------------------------------------------------------- //

/// Add a new, empty track of `kind` to the **active** timeline and persist.
/// Returns the new track's index. No UI populates a second track yet (Phase
/// D) — this makes the capability reachable for a script/test/future UI.
#[tauri::command]
pub fn chroma_timeline_add_track(kind: TrackKind) -> Result<usize, String> {
    let (dir, mut manifest) = load_and_ensure_timeline(false)?;
    let idx = manifest.active_timeline;
    let track_idx = manifest.timelines[idx].add_track(kind);
    manifest.modified = now_rfc3339();
    project::save_manifest(&dir, &manifest)?;
    Ok(track_idx)
}

/// Remove `track` (and every clip on it — see
/// `chroma_timeline::Timeline::remove_track`'s doc) from the **active**
/// timeline and persist. Errors on an out-of-range index.
#[tauri::command]
pub fn chroma_timeline_remove_track(track: usize) -> Result<(), String> {
    let (dir, mut manifest) = load_and_ensure_timeline(false)?;
    let idx = manifest.active_timeline;
    manifest.timelines[idx]
        .remove_track(track)
        .map_err(|e| e.to_string())?;
    manifest.modified = now_rfc3339();
    project::save_manifest(&dir, &manifest)
}

/// Move the clip at `(from_track, from_idx)` on the **active** timeline onto
/// `to_track` at timeline-absolute `to_start_frame`, and persist. Works for a
/// same-track reposition too (`from_track == to_track`). Errors (leaving the
/// timeline unchanged) for an out-of-range track/clip index, a negative
/// position, or a destination that would overlap an existing clip.
#[tauri::command]
pub fn chroma_timeline_move_clip(
    from_track: usize,
    from_idx: usize,
    to_track: usize,
    to_start_frame: i64,
) -> Result<(), String> {
    let (dir, mut manifest) = load_and_ensure_timeline(false)?;
    let idx = manifest.active_timeline;
    manifest.timelines[idx]
        .move_clip(from_track, from_idx, to_track, to_start_frame)
        .map_err(|e| e.to_string())?;
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
    let scale = max_long_edge.and_then(|le| {
        decode_pipe::scale_target(info.resolution.width, info.resolution.height, le)
    });

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

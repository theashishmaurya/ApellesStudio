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
//! What it does NOT do: no `wgpu`, no colour grade — the editor preview is
//!   deliberately independent of the Colorist's `AppState`/GPU render path.
//!   Still no transitions / transcript cut / OTIO export / MCP.
//!   `resolve_video_position` (used by Colorist's active-clip resolution and
//!   the embedded-audio baseline, `chroma::audio` — genuinely single-clip
//!   concerns, unchanged) resolves **N video tracks under opaque, top-wins
//!   selection** (D-056, Phase B1) — video tracks in index order, first one
//!   with a clip (not a gap) at the position wins, via
//!   `chroma_timeline::Timeline::resolve_video_clip_at`. `chroma_timeline_frame`
//!   itself (D-088, Phase 2/B3) is a DIFFERENT, real story now: real CPU
//!   pixel-level compositing IS here, for the multi-track preview
//!   specifically — `Timeline::resolve_visible_video_layers_at` resolves
//!   every visible video layer at a position, and `composite_video_frame`
//!   alpha-blends them (opacity/position/scale/rotation, keyframeable via
//!   the existing D-034 engine) when there's more than one; the
//!   exactly-one-layer case still takes the old plain-decode fast path,
//!   byte-identical to before. Audio mixing across `TrackKind::Audio` tracks
//!   is real too (D-057, `chroma::audio`'s mixer) — this module just
//!   resolves *which* clips are active, the actual decode/mix/output lives in
//!   `chroma::audio`. No timeline-switcher UI yet (D-045 pass 2 is model +
//!   commands only; "active timeline" is a Rust-side concept the frontend
//!   doesn't need to know about for the existing single-timeline Edit tab to
//!   keep working) — pass 3.
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
use image::DynamicImage;
use image::codecs::jpeg::JpegEncoder;
use once_cell::sync::Lazy;
use serde::Serialize;

use chroma_timeline::{Clip, Timeline, TrackKind};

use super::state;
use super::video::{self, VideoInfo};
use super::{decode_pipe, media_cache, project};

// --------------------------------------------------------------------------- //
// per-clip probe cache (edit-tab local — the preview decodes many frames of a
// handful of clip paths; a probe is a subprocess spawn we don't want per
// frame). `pub(crate)` (D-051): also the has-audio lookup `chroma::audio`'s
// waveform command reuses rather than probing a second time.
//
// D-128 — now **persistent**. `video::probe` is two `ffprobe` subprocesses
// (one for the video stream, one for the audio stream); measured on the
// owner's own `A001_08302215_C019.MOV`, 0.62s + 0.13s. The in-memory half of
// this cache made that once-per-session, which sounds fine until you notice
// the session ends every time the app is quit — so opening the same project
// tomorrow paid it again, per clip, on the critical path between clicking a
// project card and seeing anything. `VideoInfo` is small, immutable for a
// given source file, and already `Serialize`; persisting it is the cheapest
// real win on that path.
// --------------------------------------------------------------------------- //

static PROBE_CACHE: Lazy<Mutex<HashMap<PathBuf, VideoInfo>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

const NS_PROBE: &str = "probe";

pub(crate) fn probe_cached(path: &Path) -> Result<VideoInfo, String> {
    {
        let cache = PROBE_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(info) = cache.get(path) {
            return Ok(info.clone());
        }
    }

    // The disk cache is keyed on the source file's identity (path + mtime +
    // size), so a re-encoded or replaced file never serves a stale probe —
    // see `media_cache::source_key`.
    let key = media_cache::source_key(path).ok();
    if let Some(key) = key.as_deref()
        && let Some(info) = media_cache::read_json::<VideoInfo>(NS_PROBE, key)
    {
        PROBE_CACHE
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(path.to_path_buf(), info.clone());
        return Ok(info);
    }

    let info = video::probe(path).map_err(|e| format!("probe {}: {e}", path.display()))?;
    if let Some(key) = key.as_deref() {
        media_cache::write_json(NS_PROBE, key, &info);
    }
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
    // D-114 — the read-only path (this is `resolve_timeline`'s hot call,
    // once per preview frame) uses the mtime-validated cache instead of a
    // full re-read + re-parse every time; `persist: true` callers (which may
    // go on to write) keep the plain, always-fresh-from-disk read.
    let manifest = if persist {
        project::load_manifest(&dir)?
    } else {
        project::load_manifest_cached(&dir)?
    };
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
/// overlaps `pos` to `(source path, source start in seconds, how many seconds
/// of that clip are still ahead of `pos`, that track's gain)` — the Phase C
/// (D-056) counterpart to [`resolve_video_position`]'s
/// single video-track lookup, feeding `chroma::audio`'s mixer the extra
/// sources to sum in alongside the baseline video-embedded audio. Uses
/// [`chroma_timeline::Track::clip_at`] exactly like the video path — a track
/// with nothing covering `pos` (a gap, or an empty track, which today is
/// every `Audio` track since nothing in the app populates one yet — see
/// `chroma::audio`'s module doc) contributes nothing, silently, same "not an
/// error" contract `resolve_video_position` already has. A clip whose source
/// turns out to have no audio stream is skipped the same way.
///
/// The third element is the clip's **out-point** measured forward from `pos`
/// (B-048): `chroma::audio` streams each source until it runs out, so it has to
/// be told where the clip actually ends or it keeps playing the rest of the
/// file underneath whatever the timeline cut to next.
pub(crate) fn resolve_audio_track_positions(
    pos: u64,
) -> Result<Vec<(PathBuf, f64, f64, f32)>, String> {
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
        let remaining_frames = (clip.end_frame() - pos as i64).max(0) as u64;
        out.push((
            PathBuf::from(&clip.source_path),
            start_secs,
            info.frame_to_secs(remaining_frames),
            track.gain,
        ));
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
/// position, or (unless `ripple` is true, D-104) a destination that would
/// overlap an existing clip.
#[tauri::command]
pub fn chroma_timeline_move_clip(
    from_track: usize,
    from_idx: usize,
    to_track: usize,
    to_start_frame: i64,
    ripple: bool,
) -> Result<(), String> {
    let (dir, mut manifest) = load_and_ensure_timeline(false)?;
    let idx = manifest.active_timeline;
    manifest.timelines[idx]
        .move_clip(from_track, from_idx, to_track, to_start_frame, ripple)
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

/// Decode the source frame(s) under timeline position `pos` and return the
/// result as a `data:image/jpeg;base64,…` string. `max_long_edge` (px)
/// optionally caps the decoded size — ffmpeg downscales, so a 4K source is
/// never CPU-scaled here (except inside [`composite_video_frame`]'s own
/// per-layer resize/rotate, unavoidable once more than one layer is real
/// compositing, not a plain decode).
///
/// D-088 (Phase 2 of the P0 full-NLE effort, `docs/notes/multi-track-nle.md`
/// Phase B3): this used to be a single-clip decode only
/// (`resolve_video_position`'s opaque top-wins winner) — now resolves EVERY
/// visible video track's clip at `pos`
/// (`Timeline::resolve_visible_video_layers_at`, D-086) and, when there's
/// more than one, real-composites them (`composite_video_frame`) instead of
/// showing only the top one. The exactly-one-layer case (still the
/// overwhelming common one) takes the same fast plain-decode path as
/// before — byte-identical output, no new cost — **unless that one layer
/// carries a real transform** (D-132/B-053: it used to take the fast path
/// even then, silently discarding that clip's own crop / opacity /
/// position / scale / rotation; see the guard in [`timeline_frame`]).
/// Deliberately does NOT call
/// `resolve_video_position` (that resolver stays single-winner, unchanged,
/// for its OTHER two callers — Colorist's active-clip resolution and the
/// embedded-audio baseline, both genuinely single-clip concerns this
/// change has no business touching).
///
/// Out-of-range / nothing visible → a 1×1 transparent PNG; a decode / probe
/// failure → `Err`.
///
/// **Runs off the Tauri main thread** (D-125). A plain `#[tauri::command] fn`
/// is `ExecutionContext::Blocking` — Tauri runs it on the main thread, so every
/// millisecond this spends decoding is a millisecond the whole window's event
/// loop and *every other* IPC command (notably `chroma_audio_play`, whose
/// start latency is what keeps audio in step with the video clock — D-050)
/// is stalled behind it. A cold pipe spawn is ~0.5 s even after D-125's other
/// fixes, which is far too long to hold the main thread. Same `async fn` +
/// `spawn_blocking` shape `chroma::commands`' and `chroma::session`'s decode
/// commands already use.
#[tauri::command]
pub async fn chroma_timeline_frame(pos: u64, max_long_edge: Option<u32>) -> Result<String, String> {
    tokio::task::spawn_blocking(move || timeline_frame(pos, max_long_edge))
        .await
        .map_err(|e| format!("timeline frame task: {e}"))?
}

/// The real body of [`chroma_timeline_frame`], synchronous — split out so the
/// command can hand it to `spawn_blocking` and so tests can call it directly
/// without a tokio runtime.
pub(crate) fn timeline_frame(pos: u64, max_long_edge: Option<u32>) -> Result<String, String> {
    let timeline = resolve_timeline(false)?;
    if !timeline.tracks.iter().any(|t| t.kind == TrackKind::Video) {
        return Err("timeline has no video track".to_string());
    }
    let layers: Vec<(usize, &Clip, i64)> = timeline
        .resolve_visible_video_layers_at(pos as i64)
        .into_iter()
        .filter(|(_, c, _)| !c.source_path.is_empty())
        .collect();

    // Release the decode pipe of any track that is no longer a visible layer
    // here (hidden, deleted, or just a gap under the playhead) before decoding
    // — D-125: pipes are per track index now, and each one owns a live ffmpeg
    // process, so the set has to track what's actually on screen.
    let visible_tracks: Vec<usize> = layers.iter().map(|(i, _, _)| *i).collect();
    decode_pipe::retain_track_slots(&visible_tracks);

    let img = match layers.as_slice() {
        [] => return Ok(blank_frame()),
        [(track, clip, source_frame)]
            if resolve_clip_transform(clip, *source_frame).is_identity() =>
        {
            // Fast path: exactly one visible layer, with nothing to apply to
            // it, needs no compositing at all.
            //
            // **The `is_identity()` guard is D-132/B-053.** Pre-D-132 this
            // arm matched *every* single-layer frame unconditionally, so a
            // lone clip's opacity / position / scale / rotation were silently
            // ignored in the preview — the Inspector wrote them, the file
            // stored them, and the picture never changed until a second video
            // track happened to exist. That was already wrong for the D-082
            // fields; shipping crop into it would have made it the first
            // thing the owner tried ("crop one clip") and the first thing
            // that appeared to do nothing. A clip that really has no
            // transform still takes this path, so the overwhelmingly common
            // case is byte-identical and no slower than before.
            let path = PathBuf::from(&clip.source_path);
            let info = probe_cached(&path)?;
            let frame = (*source_frame).max(0) as u64;
            let scale = max_long_edge.and_then(|le| {
                decode_pipe::scale_target(info.resolution.width, info.resolution.height, le)
            });
            decode_pipe::playback_frame_scaled(
                decode_pipe::PipeSlot::Track(*track),
                &path,
                &info,
                frame,
                scale,
            )
            .map_err(|e| format!("decode {} @ src frame {frame}: {e}", path.display()))?
        }
        _ => composite_video_frame(&layers, max_long_edge)?,
    };

    let mut buf = Cursor::new(Vec::with_capacity(64 * 1024));
    img.to_rgb8()
        .write_with_encoder(JpegEncoder::new_with_quality(&mut buf, 80))
        .map_err(|e| format!("jpeg encode: {e}"))?;
    Ok(format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(buf.get_ref())
    ))
}

// --------------------------------------------------------------------------- //
// D-088 (Phase 2, Phase B3 of docs/notes/multi-track-nle.md): the actual
// multi-layer compositor. Real CPU alpha-over compositing (`image` +
// `imageproc`, both already dependencies — no wgpu here, this is a
// per-frame-on-demand still decode, not a 60fps realtime path; a GPU
// version can follow if this proves too slow in practice, but a real,
// correct, working CPU compositor beats an unbuilt GPU one).
// --------------------------------------------------------------------------- //

/// A clip's transform, resolved for one specific `source_frame` — the
/// static fields, or their keyframe-interpolated values.
struct ClipTransform {
    opacity: f64,
    position_x: f64,
    position_y: f64,
    scale: f64,
    rotation: f64,
    /// D-132 — normalised (0.0–1.0) edge insets into the layer's own source
    /// frame, resolved for this frame exactly like every field above (static
    /// value, or its keyframe-interpolated one). See `Clip::crop_left`'s doc
    /// for why the unit is a fraction of the source and not pixels.
    crop_left: f64,
    crop_top: f64,
    crop_right: f64,
    crop_bottom: f64,
}

impl ClipTransform {
    /// D-132/B-053 — whether applying this transform to a layer would change
    /// nothing at all, so [`timeline_frame`]'s single-layer fast path may
    /// skip compositing entirely and return the plain decoded frame.
    ///
    /// Exact comparisons, not epsilons: these values come from the
    /// Inspector's own numeric inputs (or the keyframe interpolator over
    /// them), so "the user has not touched this field" really is the exact
    /// literal default, and a tolerance would only invent a second,
    /// silently different notion of identity from the one
    /// [`composite_layer_onto`] itself acts on. A **negative** crop inset
    /// counts as no crop, matching [`crop_pixel_rect`]'s own clamp — the
    /// predicate has to agree with what would actually be painted.
    fn is_identity(&self) -> bool {
        self.opacity >= 1.0
            && self.position_x == 0.0
            && self.position_y == 0.0
            && self.scale == 1.0
            && self.rotation == 0.0
            && self.crop_left <= 0.0
            && self.crop_top <= 0.0
            && self.crop_right <= 0.0
            && self.crop_bottom <= 0.0
    }
}

/// Resolve `clip`'s transform at `source_frame`. Deliberately does NOT call
/// `chroma::keyframes::interpolated_parameters` — that reads
/// `chroma::state::current_video()`'s global "currently loaded video" frame,
/// the Colorist grading session's own state, which has nothing to do with
/// (and would usually disagree with) the specific source frame a timeline
/// clip is being composited at here. Calls the lower-level, frame-explicit
/// `parse_keyframes`/`interpolate` directly instead — same D-034 engine,
/// just not routed through the global-state-coupled wrapper. Keyframes are
/// authored relative to the clip's own SOURCE frame (matching the
/// convention every other keyframeable thing in this codebase — masks,
/// relight lights — already uses: "the current frame" of whatever's loaded,
/// which for a single clip IS its source frame).
fn resolve_clip_transform(clip: &Clip, source_frame: i64) -> ClipTransform {
    let base = ClipTransform {
        opacity: clip.opacity,
        position_x: clip.position_x,
        position_y: clip.position_y,
        scale: clip.scale,
        rotation: clip.rotation,
        crop_left: clip.crop_left,
        crop_top: clip.crop_top,
        crop_right: clip.crop_right,
        crop_bottom: clip.crop_bottom,
    };
    let Some(kf_value) = &clip.chroma_keyframes else {
        return base;
    };
    // `parse_keyframes` expects the *containing* params object (it reads
    // `parameters.chromaKeyframes` off it) — `Clip::chroma_keyframes` stores
    // the array directly, so wrap it the one time this function needs to.
    let wrapped = serde_json::json!({ "chromaKeyframes": kf_value });
    let Some(keyframes) = super::keyframes::parse_keyframes(&wrapped) else {
        return base;
    };
    if keyframes.is_empty() {
        return base;
    }
    let interpolated = super::keyframes::interpolate(&keyframes, source_frame.max(0) as u64);
    let f64_or = |key: &str, fallback: f64| {
        interpolated.get(key).and_then(|v| v.as_f64()).unwrap_or(fallback)
    };
    ClipTransform {
        opacity: f64_or("opacity", base.opacity),
        position_x: f64_or("position_x", base.position_x),
        position_y: f64_or("position_y", base.position_y),
        scale: f64_or("scale", base.scale),
        rotation: f64_or("rotation", base.rotation),
        // D-132 — crop keyframes go through the same D-034 engine as every
        // other field here, which is the whole reason the crop insets are
        // four flat scalars on `Clip` rather than a nested rect (that
        // interpolator takes a flat `{name: number}` params object).
        crop_left: f64_or("crop_left", base.crop_left),
        crop_top: f64_or("crop_top", base.crop_top),
        crop_right: f64_or("crop_right", base.crop_right),
        crop_bottom: f64_or("crop_bottom", base.crop_bottom),
    }
}

/// Decode every layer (already visible + non-empty-source, see the caller)
/// and alpha-composite them onto one canvas. Paint order: `layers` arrives
/// in `resolve_visible_video_layers_at`'s index-ascending order (index 0 =
/// highest priority); this function decodes in that order but PAINTS in
/// reverse (lowest priority first, at the back; highest priority last, on
/// top) — matches `resolve_visible_video_layers_at`'s own documented paint
/// contract. The canvas is the TOP (highest-priority) layer's own scaled
/// dimensions — every other layer is transformed (scale/rotate/opacity)
/// then centered on that canvas plus its own `position_x`/`position_y`
/// offset, not scaled to fill the canvas by default (a lower-priority
/// layer showing through at its own native size, like a picture-in-picture,
/// is the more useful default than a silent full-bleed stretch).
fn composite_video_frame(
    layers: &[(usize, &Clip, i64)],
    max_long_edge: Option<u32>,
) -> Result<DynamicImage, String> {
    struct Decoded {
        img: image::RgbaImage,
        transform: ClipTransform,
    }

    let mut decoded: Vec<Decoded> = Vec::with_capacity(layers.len());
    for (track, clip, source_frame) in layers {
        let path = PathBuf::from(&clip.source_path);
        let info = probe_cached(&path)?;
        let frame = (*source_frame).max(0) as u64;
        let scale = max_long_edge
            .and_then(|le| decode_pipe::scale_target(info.resolution.width, info.resolution.height, le));
        // One decode pipe per track (D-125/B-040) — sharing a single global
        // pipe across layers made every layer after the first respawn ffmpeg
        // (different path, or the same path stepping backwards), which is what
        // reduced this whole path to ~0.85 fps.
        let img = decode_pipe::playback_frame_scaled(
            decode_pipe::PipeSlot::Track(*track),
            &path,
            &info,
            frame,
            scale,
        )
        .map_err(|e| format!("decode {} @ src frame {frame}: {e}", path.display()))?;
        decoded.push(Decoded {
            img: img.to_rgba8(),
            transform: resolve_clip_transform(clip, *source_frame),
        });
    }

    let (canvas_w, canvas_h) = decoded[0].img.dimensions();
    let mut canvas: image::RgbaImage =
        image::ImageBuffer::from_pixel(canvas_w, canvas_h, image::Rgba([0, 0, 0, 255]));

    for d in decoded.iter().rev() {
        composite_layer_onto(&mut canvas, &d.img, &d.transform);
    }

    Ok(DynamicImage::ImageRgba8(canvas))
}

/// The **kept** (un-cropped) region of a `w`×`h` layer under `t`'s normalised
/// insets, as an exclusive `(x0, y0, x1, y1)` pixel rect in the layer's own
/// space — D-132.
///
/// Returns `None` when the crop leaves nothing to paint (insets summing to
/// ≥ 1 on either axis, or rounding to an empty span on a small layer). The
/// clamp to `0.0..=1.0` lives here, at the point of use, for the reason
/// `Clip::crop_left`'s own doc gives: the model stores what the UI wrote and
/// the consumer decides what it means, exactly as `opacity` already does one
/// line below its own read.
///
/// **Normalised in, pixels out, per decoded layer** — which is what makes the
/// crop invariant under `PreviewPane`'s 960-while-scrubbing / 640-while-
/// playing decode scales (B-043's failure mode for `position_*`, avoided here
/// by construction rather than fixed after the fact).
fn crop_pixel_rect(w: u32, h: u32, t: &ClipTransform) -> Option<(u32, u32, u32, u32)> {
    let span = |size: u32, near: f64, far: f64| -> (u32, u32) {
        let s = size as f64;
        let lo = (s * near.clamp(0.0, 1.0)).round() as u32;
        let hi = size.saturating_sub((s * far.clamp(0.0, 1.0)).round() as u32);
        (lo, hi)
    };
    let (x0, x1) = span(w, t.crop_left, t.crop_right);
    let (y0, y1) = span(h, t.crop_top, t.crop_bottom);
    (x1 > x0 && y1 > y0).then_some((x0, y0, x1, y1))
}

/// Crop → scale → rotate → apply opacity (as an alpha multiply) → overlay
/// `layer` onto `canvas`, centered plus `transform`'s position offset. Real
/// arbitrary-angle rotation via `imageproc::geometric_transformations::
/// rotate_about_center` — the exact same function + transparent-border
/// pattern `image_processing.rs`'s own `apply_rotation` already uses for
/// the Colorist's rotate adjustment, not a second rotation implementation.
///
/// **Crop is first, and it does not move the picture** (D-132). The pixels
/// cropped away have their **alpha** zeroed while the layer keeps its full
/// footprint, rather than the buffer being physically shrunk to the kept
/// rect. Two real consequences, both matching Premiere's Crop effect and
/// Resolve's Crop mode: the remaining picture stays exactly where it was
/// instead of re-centring as you drag an edge in, and `scale`/`rotation`
/// keep acting about the layer's own full-frame centre (a shrunk buffer
/// would silently move `rotate_about_center`'s pivot to the crop's centre).
/// The cropped pixels keep their RGB and lose only alpha, so the resize
/// filter below feathers the crop edge over a pixel instead of bleeding
/// black into it.
fn composite_layer_onto(canvas: &mut image::RgbaImage, layer: &image::RgbaImage, t: &ClipTransform) {
    let opacity = t.opacity.clamp(0.0, 1.0) as f32;
    if opacity <= 0.0 {
        return; // fully transparent — nothing to paint, skip the work
    }

    let (lw, lh) = layer.dimensions();
    let Some((cx0, cy0, cx1, cy1)) = crop_pixel_rect(lw, lh, t) else {
        return; // cropped away entirely — nothing to paint
    };
    let cropped = (cx0, cy0, cx1, cy1) != (0, 0, lw, lh);
    let scale = t.scale.max(0.0);
    let (sw, sh) = (
        ((lw as f64) * scale).round().max(1.0) as u32,
        ((lh as f64) * scale).round().max(1.0) as u32,
    );
    // The un-cropped branch is byte-for-byte the pre-D-132 path — no extra
    // buffer, no per-pixel pass — so an uncropped clip (every clip in every
    // existing project) costs exactly what it did before.
    let mut work: image::RgbaImage = if cropped {
        let mut masked = layer.clone();
        for (x, y, px) in masked.enumerate_pixels_mut() {
            if x < cx0 || x >= cx1 || y < cy0 || y >= cy1 {
                px[3] = 0;
            }
        }
        if (sw, sh) != (lw, lh) {
            image::imageops::resize(&masked, sw, sh, image::imageops::FilterType::Triangle)
        } else {
            masked
        }
    } else if (sw, sh) != (lw, lh) {
        image::imageops::resize(layer, sw, sh, image::imageops::FilterType::Triangle)
    } else {
        layer.clone()
    };

    if t.rotation != 0.0 {
        let rgba32f = DynamicImage::ImageRgba8(work).to_rgba32f();
        let rotated = imageproc::geometric_transformations::rotate_about_center(
            &rgba32f,
            (t.rotation as f32) * std::f32::consts::PI / 180.0,
            imageproc::geometric_transformations::Interpolation::Bilinear,
            imageproc::geometric_transformations::Border::Constant(image::Rgba([
                0.0f32, 0.0, 0.0, 0.0,
            ])),
        );
        work = DynamicImage::ImageRgba32F(rotated).to_rgba8();
    }

    if opacity < 1.0 {
        for p in work.pixels_mut() {
            p[3] = (p[3] as f32 * opacity).round().clamp(0.0, 255.0) as u8;
        }
    }

    let (cw, ch) = canvas.dimensions();
    let (ww, wh) = work.dimensions();
    let x = (cw as f64) / 2.0 - (ww as f64) / 2.0 + t.position_x;
    let y = (ch as f64) / 2.0 - (wh as f64) / 2.0 + t.position_y;
    image::imageops::overlay(canvas, &work, x.round() as i64, y.round() as i64);
}

#[cfg(test)]
mod composite_tests {
    use super::*;
    use image::{ImageBuffer, Rgba};

    fn flat(w: u32, h: u32, px: [u8; 4]) -> image::RgbaImage {
        ImageBuffer::from_pixel(w, h, Rgba(px))
    }

    fn identity_transform() -> ClipTransform {
        ClipTransform {
            opacity: 1.0,
            position_x: 0.0,
            position_y: 0.0,
            scale: 1.0,
            rotation: 0.0,
            crop_left: 0.0,
            crop_top: 0.0,
            crop_right: 0.0,
            crop_bottom: 0.0,
        }
    }

    /// D-088: `resolve_clip_transform` with no `chroma_keyframes` returns the
    /// clip's own static fields, untouched.
    #[test]
    fn resolve_clip_transform_uses_static_fields_when_unkeyframed() {
        let clip = Clip {
            opacity: 0.5,
            position_x: 10.0,
            position_y: -5.0,
            scale: 2.0,
            rotation: 45.0,
            ..Default::default()
        };
        let t = resolve_clip_transform(&clip, 0);
        assert_eq!(t.opacity, 0.5);
        assert_eq!(t.position_x, 10.0);
        assert_eq!(t.position_y, -5.0);
        assert_eq!(t.scale, 2.0);
        assert_eq!(t.rotation, 45.0);
    }

    /// D-088: with real `chroma_keyframes`, the interpolated value wins over
    /// the static field at that source frame — same D-034 engine masks and
    /// relight lights already use, just called with an explicit frame
    /// instead of the global `current_video()` state (see
    /// `resolve_clip_transform`'s own doc for why).
    #[test]
    fn resolve_clip_transform_uses_interpolated_keyframe_values() {
        let clip = Clip {
            opacity: 1.0, // static field — should be overridden by the keyframes below
            chroma_keyframes: Some(serde_json::json!([
                { "frame": 0, "params": { "opacity": 0.0 } },
                { "frame": 100, "params": { "opacity": 1.0 } },
            ])),
            ..Default::default()
        };
        // halfway between the two keys -> linear interpolation -> ~0.5
        let t = resolve_clip_transform(&clip, 50);
        assert!((t.opacity - 0.5).abs() < 0.01, "expected ~0.5, got {}", t.opacity);
        // before the first key -> held at the first key's value (0.0)
        let t0 = resolve_clip_transform(&clip, 0);
        assert_eq!(t0.opacity, 0.0);
    }

    /// Opacity 0 must be a real no-op — the canvas is untouched, not just
    /// "very faint."
    #[test]
    fn composite_layer_onto_skips_entirely_at_zero_opacity() {
        let mut canvas = flat(4, 4, [10, 20, 30, 255]);
        let before = canvas.clone();
        let layer = flat(4, 4, [255, 255, 255, 255]);
        let t = ClipTransform { opacity: 0.0, ..identity_transform() };
        composite_layer_onto(&mut canvas, &layer, &t);
        assert_eq!(canvas, before);
    }

    /// Opacity 1 with an opaque layer exactly covering the canvas must
    /// produce the layer's own color, not a blend with whatever was there.
    #[test]
    fn composite_layer_onto_full_opacity_fully_replaces() {
        let mut canvas = flat(4, 4, [10, 20, 30, 255]);
        let layer = flat(4, 4, [200, 100, 50, 255]);
        composite_layer_onto(&mut canvas, &layer, &identity_transform());
        assert_eq!(*canvas.get_pixel(2, 2), Rgba([200, 100, 50, 255]));
    }

    /// D-088's real "not opaque top-wins" ask: a real alpha blend at
    /// fractional opacity must land STRICTLY between the two colors, not at
    /// either endpoint — proves real blending math ran, not a threshold
    /// on/off switch.
    #[test]
    fn composite_layer_onto_partial_opacity_blends_strictly_between() {
        let mut canvas = flat(4, 4, [0, 0, 0, 255]);
        let layer = flat(4, 4, [255, 255, 255, 255]);
        let t = ClipTransform { opacity: 0.5, ..identity_transform() };
        composite_layer_onto(&mut canvas, &layer, &t);
        let r = canvas.get_pixel(2, 2)[0];
        assert!(r > 20 && r < 235, "expected a real mid-blend, got {r}");
    }

    /// `position_x`/`position_y` offset from center — a layer smaller than
    /// the canvas, nudged, must land where expected and leave the
    /// untouched canvas area alone.
    #[test]
    fn composite_layer_onto_respects_position_offset() {
        let mut canvas = flat(10, 10, [0, 0, 0, 255]);
        let layer = flat(2, 2, [255, 0, 0, 255]);
        // centered would place the 2x2 layer at (4,4)-(5,5); shift +3,+0.
        let t = ClipTransform { position_x: 3.0, ..identity_transform() };
        composite_layer_onto(&mut canvas, &layer, &t);
        assert_eq!(*canvas.get_pixel(7, 4), Rgba([255, 0, 0, 255]));
        assert_eq!(*canvas.get_pixel(4, 4), Rgba([0, 0, 0, 255])); // the un-shifted spot is untouched
    }

    /// `scale` actually changes the painted footprint size, not just a
    /// cosmetic field nobody reads.
    #[test]
    fn composite_layer_onto_respects_scale() {
        let mut canvas = flat(20, 20, [0, 0, 0, 255]);
        let layer = flat(4, 4, [255, 0, 0, 255]);
        let t = ClipTransform { scale: 3.0, ..identity_transform() }; // -> 12x12, centered at (4,4)-(15,15)
        composite_layer_onto(&mut canvas, &layer, &t);
        assert_eq!(*canvas.get_pixel(10, 10), Rgba([255, 0, 0, 255]));
        assert_eq!(*canvas.get_pixel(1, 1), Rgba([0, 0, 0, 255]));
    }

    // ---------------------------------------------------------------- //
    // D-132 — per-clip crop.
    // ---------------------------------------------------------------- //

    /// The normalised-inset → pixel-rect conversion, on its own: a quarter
    /// off the left and a half off the bottom of a 100×100 layer keeps
    /// x ∈ [25, 100), y ∈ [0, 50).
    #[test]
    fn crop_pixel_rect_converts_normalised_insets_to_pixels() {
        let t = ClipTransform { crop_left: 0.25, crop_bottom: 0.5, ..identity_transform() };
        assert_eq!(crop_pixel_rect(100, 100, &t), Some((25, 0, 100, 50)));
    }

    /// **The reason the unit is a fraction and not pixels** (D-132, and the
    /// class of defect B-043 is): the SAME crop value keeps the same
    /// *fraction* of the picture at every decode scale `PreviewPane` asks
    /// for (960 scrubbing / 640 playing / full-res later), where a pixel
    /// rect would keep a different fraction at each one.
    #[test]
    fn crop_is_invariant_under_the_decode_scale() {
        let t = ClipTransform { crop_left: 0.5, ..identity_transform() };
        let big = crop_pixel_rect(960, 540, &t).unwrap();
        let small = crop_pixel_rect(640, 360, &t).unwrap();
        let frac = |(x0, _, x1, _): (u32, u32, u32, u32), w: u32| (x1 - x0) as f64 / w as f64;
        assert!((frac(big, 960) - frac(small, 640)).abs() < 1e-9);
        assert!((frac(big, 960) - 0.5).abs() < 1e-9);
    }

    /// A crop that leaves nothing (insets summing past the whole frame) is
    /// `None` — and the compositor must then paint nothing at all, rather
    /// than panicking on an empty rect or painting the un-cropped layer.
    #[test]
    fn a_degenerate_crop_paints_nothing() {
        let t = ClipTransform { crop_left: 0.7, crop_right: 0.7, ..identity_transform() };
        assert_eq!(crop_pixel_rect(100, 100, &t), None);
        let mut canvas = flat(4, 4, [10, 20, 30, 255]);
        let before = canvas.clone();
        composite_layer_onto(&mut canvas, &flat(4, 4, [255, 255, 255, 255]), &t);
        assert_eq!(canvas, before);
    }

    /// Out-of-range insets are clamped at the point of use, not rejected by
    /// the model (`Clip::crop_left`'s own doc) — a negative inset is no
    /// crop, `> 1.0` is the whole edge.
    #[test]
    fn crop_insets_are_clamped_by_the_consumer() {
        let neg = ClipTransform { crop_left: -0.5, ..identity_transform() };
        assert_eq!(crop_pixel_rect(100, 100, &neg), Some((0, 0, 100, 100)));
        let over = ClipTransform { crop_left: 4.0, ..identity_transform() };
        assert_eq!(crop_pixel_rect(100, 100, &over), None);
    }

    /// The real compositing behaviour: cropping the left half of a layer
    /// clears the left half of its footprint back to the canvas underneath
    /// and leaves the right half **exactly where it already was** — it does
    /// NOT re-centre the remaining picture (Premiere's Crop effect and
    /// Resolve's Crop mode both crop in place; see `composite_layer_onto`'s
    /// own doc).
    #[test]
    fn composite_layer_onto_crops_in_place_without_recentring() {
        let mut canvas = flat(10, 10, [0, 0, 0, 255]);
        let layer = flat(10, 10, [255, 0, 0, 255]);
        let t = ClipTransform { crop_left: 0.5, ..identity_transform() };
        composite_layer_onto(&mut canvas, &layer, &t);
        // cropped-away left half: the canvas shows through, untouched
        assert_eq!(*canvas.get_pixel(1, 5), Rgba([0, 0, 0, 255]));
        assert_eq!(*canvas.get_pixel(4, 5), Rgba([0, 0, 0, 255]));
        // kept right half: still the layer, still at its original x
        assert_eq!(*canvas.get_pixel(5, 5), Rgba([255, 0, 0, 255]));
        assert_eq!(*canvas.get_pixel(9, 5), Rgba([255, 0, 0, 255]));
    }

    /// Each edge crops its own side — a top crop must not take pixels off
    /// the bottom (the kind of thing an axis mix-up in `crop_pixel_rect`
    /// would produce and a single-edge test would miss).
    #[test]
    fn composite_layer_onto_crops_each_edge_independently() {
        let mut canvas = flat(10, 10, [0, 0, 0, 255]);
        let layer = flat(10, 10, [255, 0, 0, 255]);
        let t = ClipTransform { crop_top: 0.3, crop_right: 0.2, ..identity_transform() };
        composite_layer_onto(&mut canvas, &layer, &t);
        assert_eq!(*canvas.get_pixel(5, 1), Rgba([0, 0, 0, 255])); // cropped top
        assert_eq!(*canvas.get_pixel(9, 5), Rgba([0, 0, 0, 255])); // cropped right
        assert_eq!(*canvas.get_pixel(5, 9), Rgba([255, 0, 0, 255])); // bottom kept
        assert_eq!(*canvas.get_pixel(0, 5), Rgba([255, 0, 0, 255])); // left kept
    }

    /// Crop composes with the rest of the transform rather than replacing
    /// it: scaled ×2, the kept half of a 4×4 layer still lands on the
    /// scaled footprint's own right half, and the cropped side stays clear.
    #[test]
    fn crop_composes_with_scale() {
        let mut canvas = flat(20, 20, [0, 0, 0, 255]);
        let layer = flat(4, 4, [255, 0, 0, 255]);
        // scale 2 -> an 8x8 footprint centred at (6,6)-(13,13); left half cropped
        let t = ClipTransform { scale: 2.0, crop_left: 0.5, ..identity_transform() };
        composite_layer_onto(&mut canvas, &layer, &t);
        assert_eq!(*canvas.get_pixel(7, 10), Rgba([0, 0, 0, 255])); // cropped (left) half
        assert_eq!(*canvas.get_pixel(12, 10), Rgba([255, 0, 0, 255])); // kept (right) half
    }

    /// An uncropped layer takes the untouched pre-D-132 path — proved by
    /// output equality with the same composite run through the explicit
    /// zero-inset transform, so the "no crop costs nothing" claim in
    /// `composite_layer_onto`'s doc is a tested one.
    #[test]
    fn an_uncropped_layer_is_unchanged_by_the_crop_pass() {
        let layer = flat(6, 6, [3, 200, 40, 255]);
        let mut with_zero_insets = flat(10, 10, [0, 0, 0, 255]);
        composite_layer_onto(&mut with_zero_insets, &layer, &identity_transform());
        let mut with_negative_insets = flat(10, 10, [0, 0, 0, 255]);
        let t = ClipTransform { crop_left: -1.0, crop_bottom: -1.0, ..identity_transform() };
        composite_layer_onto(&mut with_negative_insets, &layer, &t);
        assert_eq!(with_zero_insets, with_negative_insets);
    }

    /// D-132 — crop rides the same D-034 keyframe engine as every other
    /// transform field (which is why the insets are four flat scalars and
    /// not a nested rect: that interpolator takes a flat params object).
    #[test]
    fn resolve_clip_transform_interpolates_crop_keyframes() {
        let clip = Clip {
            crop_left: 0.0,
            chroma_keyframes: Some(serde_json::json!([
                { "frame": 0, "params": { "crop_left": 0.0 } },
                { "frame": 100, "params": { "crop_left": 1.0 } },
            ])),
            ..Default::default()
        };
        let t = resolve_clip_transform(&clip, 50);
        assert!((t.crop_left - 0.5).abs() < 0.01, "expected ~0.5, got {}", t.crop_left);
    }

    /// D-132 — the static crop fields are read straight off the clip when
    /// it isn't keyframed, the same way the D-082 five already are.
    #[test]
    fn resolve_clip_transform_reads_static_crop_fields() {
        let clip = Clip { crop_left: 0.1, crop_top: 0.2, crop_right: 0.3, crop_bottom: 0.4, ..Default::default() };
        let t = resolve_clip_transform(&clip, 0);
        assert_eq!((t.crop_left, t.crop_top, t.crop_right, t.crop_bottom), (0.1, 0.2, 0.3, 0.4));
    }

    /// B-053 — the predicate `timeline_frame`'s single-layer fast path is
    /// gated on. A freshly-defaulted clip is identity (so the common case
    /// still skips compositing entirely and stays byte-identical); a clip
    /// with a crop — or with any of the D-082 fields set, which used to be
    /// silently ignored on that path — is not.
    #[test]
    fn only_a_genuinely_untransformed_clip_takes_the_fast_path() {
        assert!(resolve_clip_transform(&Clip::default(), 0).is_identity());
        for clip in [
            Clip { crop_left: 0.01, ..Default::default() },
            Clip { crop_bottom: 0.5, ..Default::default() },
            Clip { opacity: 0.5, ..Default::default() },
            Clip { position_x: 4.0, ..Default::default() },
            Clip { scale: 1.5, ..Default::default() },
            Clip { rotation: 90.0, ..Default::default() },
        ] {
            assert!(!resolve_clip_transform(&clip, 0).is_identity(), "{clip:?} should not be identity");
        }
        // a negative inset changes no pixel, so it must not force the slow
        // path either — the predicate has to agree with `crop_pixel_rect`.
        assert!(resolve_clip_transform(&Clip { crop_top: -0.2, ..Default::default() }, 0).is_identity());
    }
}

/// Real-file preview-throughput regression coverage for D-125 / B-040 — kept
/// out of the pure-logic `tests` module above because every one of these needs
/// a real video file on disk and a real `ffmpeg`.
#[cfg(test)]
mod preview_throughput_tests {
    use std::time::Instant;

    use chroma_timeline::{Clip, Timeline, Track, TrackKind};

    fn test_video() -> Option<String> {
        std::env::var("CHROMA_TEST_VIDEO")
            .ok()
            .filter(|p| std::path::Path::new(p).exists())
    }

    /// A project shaped exactly like the one this bug was found on: several
    /// **video** tracks all holding content under the same playhead, two of
    /// them the same source file. That is what makes the preview take
    /// `composite_video_frame`'s multi-layer path, which is where the
    /// single-shared-decode-pipe respawn storm lived.
    fn open_multi_track_project(video_path: &str, tracks_n: usize) -> tempfile::TempDir {
        let tmp = tempfile::tempdir().expect("tempdir");
        let project_dir = tmp.path().join("MultiTrack.chroma");
        std::fs::create_dir_all(&project_dir).expect("mkdir project dir");

        let tracks: Vec<Track> = (0..tracks_n)
            .map(|i| Track {
                kind: TrackKind::Video,
                clips: vec![Clip {
                    id: format!("clip{i}"),
                    name: format!("layer{i}"),
                    source_path: video_path.to_string(),
                    source_start: 0,
                    duration: 100_000,
                    source_len: 100_000,
                    start_frame: 0,
                    // Every layer must actually be composited — a fully
                    // opaque top layer is still decoded by the current
                    // resolver, but keeping them partly transparent makes
                    // the intent explicit and matches a real stacked edit.
                    opacity: if i == 0 { 1.0 } else { 0.5 },
                    ..Default::default()
                }],
                gain: 1.0,
                locked: false,
                hidden: false,
                sync_locked: true,
            })
            .collect();

        let manifest = super::project::ProjectManifest {
            schema: "chroma.project/1".into(),
            name: "MultiTrack".into(),
            created: String::new(),
            modified: String::new(),
            shots: Vec::new(),
            active_shot: 0,
            active_clip_id: None,
            settings: Default::default(),
            timelines: vec![Timeline {
                id: "tl1".into(),
                name: "MultiTrack".into(),
                rate: None,
                tracks,
            }],
            active_timeline: 0,
            media: Vec::new(),
            folders: Vec::new(),
        };
        super::project::save_manifest(&project_dir, &manifest).expect("save manifest");
        super::state::set_project(Some(super::state::ProjectRef {
            path: project_dir,
            name: "MultiTrack".into(),
        }));
        tmp
    }

    /// The B-040 regression guard. Before D-125 every composited layer past
    /// the first forced a full `ffmpeg` respawn + keyframe seek *per displayed
    /// frame* on a timeline shaped like the owner's real three-video-track
    /// project, which is what "play takes 2-3 s and then stutters" actually
    /// was. Measured through this exact code path, before and after,
    /// back-to-back under identical machine load: **618 ms/frame → 23-31
    /// ms/frame** (≈1.6 fps → ~34 fps against a 24 fps timeline). On an idle
    /// machine the same comparison was 660 ms → 17 ms. The "before" figure was
    /// produced by temporarily pointing every layer back at one shared pipe
    /// and re-running this test, not inferred.
    ///
    /// The budget is deliberately loose (200 ms/frame average, vs. ~618 ms
    /// before and 17-31 ms after) so this stays a guard against the *class* of
    /// bug — a per-frame process respawn — and never a flaky wall-clock
    /// assertion on a busy machine.
    #[test]
    fn sequential_preview_frames_do_not_respawn_a_decoder_per_layer() {
        let Some(vid) = test_video() else {
            eprintln!("skip: set CHROMA_TEST_VIDEO");
            return;
        };
        let _project = open_multi_track_project(&vid, 3);
        super::decode_pipe::reset();

        const FRAMES: u64 = 24;
        const BUDGET_MS: u128 = 200;

        // The first frame legitimately pays the pipe spawns + keyframe seeks;
        // it is not part of the steady-state measurement.
        super::timeline_frame(100, Some(960)).expect("warm frame");

        let start = Instant::now();
        for f in 101..101 + FRAMES {
            super::timeline_frame(f, Some(960)).expect("frame");
        }
        let per_frame = start.elapsed().as_millis() / FRAMES as u128;
        eprintln!(
            "3-layer preview: {per_frame} ms/frame over {FRAMES} sequential frames \
             (same path pre-D-125 measured 618-660 ms/frame)"
        );
        assert!(
            per_frame < BUDGET_MS,
            "{per_frame} ms/frame exceeds the {BUDGET_MS} ms budget — a decode pipe \
             is very likely respawning per layer again (B-040)"
        );
        super::decode_pipe::reset();
    }

    /// A track that stops being a visible layer must give its `ffmpeg`
    /// process back — the pool is per track index, so without this it would
    /// grow one live decoder per track ever seen (D-125).
    #[test]
    fn a_track_that_leaves_the_visible_set_releases_its_pipe() {
        let Some(vid) = test_video() else {
            eprintln!("skip: set CHROMA_TEST_VIDEO");
            return;
        };
        let _project = open_multi_track_project(&vid, 3);
        super::decode_pipe::reset();

        super::timeline_frame(100, Some(960)).expect("frame");
        assert_eq!(
            super::decode_pipe::open_pipe_count(),
            3,
            "one pipe per layer"
        );

        super::decode_pipe::retain_track_slots(&[0]);
        assert_eq!(
            super::decode_pipe::open_pipe_count(),
            1,
            "pipes for tracks no longer visible must be dropped"
        );
        super::decode_pipe::reset();
        assert_eq!(super::decode_pipe::open_pipe_count(), 0);
    }
}

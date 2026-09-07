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

use std::io::Cursor;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use image::DynamicImage;
use image::codecs::jpeg::JpegEncoder;
use serde::Serialize;

use chroma_timeline::{Clip, Timeline, TrackKind};

use super::state;
use super::video::VideoInfo;
use super::{decode_pipe, project, text};

// --------------------------------------------------------------------------- //
// per-clip probe cache — moved out of this file into `chroma-media` (D-146,
// `docs/notes/crate-extraction-plan.md` §2.2). It was never an Edit-tab
// concern: its consumers are `filmstrip`, `audio`, `project` and `load`, and
// leaving it here would have made `chroma-media` depend on `app/src-tauri`, a
// cycle. B-056 (the in-memory layer never invalidated, so a source file
// replaced in place served a stale `VideoInfo` for the rest of the session)
// was fixed in the same move — see `chroma_media::probe`'s module doc.
//
// Re-exported at the old path so the ~15 `probe_cached(..)` call sites in this
// file, and `super::edit::probe_cached` in `audio.rs`/`filmstrip.rs`/
// `load.rs`/`project.rs`, did not change.
// --------------------------------------------------------------------------- //

pub(crate) use chroma_media::probe::probe_cached;

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

// --------------------------------------------------------------------------- //
// timeline lifecycle — moved out of this file into `chroma-project` (D-148,
// `docs/notes/crate-extraction-plan.md` §2.3). `build_from_shots`,
// `ensure_timeline`, `load_and_ensure_timeline`, `resolve_timeline` and
// `resolve_timeline_and_settings` were never Edit-tab concerns: they read
// `manifest.shots`, call `project::resolve_shot` / `project::save_manifest`,
// and their non-Edit callers are `chroma::project`'s own `open_manifest`,
// `chroma_project_resync_clips`, `chroma_project_add_shot_paths` and
// `chroma_project_remove_clip`.
//
// What genuinely stays here is the *process global* — which project is
// currently open — because that is `chroma::state`, app-layer by design. So
// the crate's functions take the project directory as an argument and these
// wrappers supply it: the same "the crate takes the fact, the app looks it
// up" shape D-145 gave `tracked_depth_map`. Every call site below is
// unchanged.
// --------------------------------------------------------------------------- //

/// A pure pass-through, not a wrapper — the crate function already took the
/// project directory explicitly. `chroma::project` calls it at this path too;
/// see `chroma_project::timeline`'s module doc for why it is not an Edit-tab
/// concern despite having lived here since D-041.
pub(crate) use chroma_project::timeline::ensure_timeline;

/// Load the **open** project's manifest with `timelines` guaranteed non-empty
/// and `active_timeline` valid. Returns the directory alongside it because
/// most callers here go on to `project::save_manifest(&dir, ..)`.
fn load_and_ensure_timeline(persist: bool) -> Result<(PathBuf, project::ProjectManifest), String> {
    let dir = current_project_dir()?;
    let manifest = chroma_project::timeline::load_and_ensure_timeline(&dir, persist)?;
    Ok((dir, manifest))
}

/// The **open** project's active timeline (D-045) — its persisted one, or a
/// fresh build from its shots the first time. `pub(crate)` (D-056): also how
/// `chroma::audio`'s mixer enumerates every genuine `TrackKind::Audio` track
/// on the active timeline (`resolve_audio_track_positions`, below).
pub(crate) fn resolve_timeline(persist: bool) -> Result<Timeline, String> {
    chroma_project::timeline::resolve_timeline(&current_project_dir()?, persist)
}

/// [`resolve_timeline`] plus the project's output spec (D-038) — the pair
/// [`timeline_frame`] needs, since D-136 made the compositor's canvas the
/// **composition** rather than the top layer's decoded size.
pub(crate) fn resolve_timeline_and_settings(
    persist: bool,
) -> Result<(Timeline, project::ProjectSettings), String> {
    chroma_project::timeline::resolve_timeline_and_settings(&current_project_dir()?, persist)
}

/// The **composition space** every clip's geometry is measured against
/// (D-136, Phase 0a of `docs/notes/on-canvas-transform.md`): the project's
/// recorded output resolution (D-038), or — for a project that never recorded
/// one — the probed resolution of the timeline's first video clip, which is
/// exactly the clip [`project::infer_settings_from_clip`] would have derived
/// those settings from.
///
/// **Deliberately independent of the playhead.** The pre-D-136 canvas *was*
/// playhead-dependent (it was whichever layer happened to be on top at that
/// position, at whatever size it happened to decode to), and that is half of
/// B-043: a value that means one thing at frame 100 and another at frame 400 is
/// not a coordinate space. Taking the first clip in Vec order gives one answer
/// for the whole timeline, for the preview and for
/// [`chroma_timeline_clip_geometry`] alike, so the overlay and the picture
/// cannot disagree.
fn composition_size(
    settings: &project::ProjectSettings,
    timeline: &Timeline,
) -> Result<(u32, u32), String> {
    if let (Some(w), Some(h)) = (settings.width, settings.height)
        && w > 0
        && h > 0
    {
        return Ok((w, h));
    }
    let first = timeline
        .tracks
        .iter()
        .filter(|t| t.kind == TrackKind::Video)
        .find_map(|t| t.clips.iter().find(|c| !c.source_path.is_empty()))
        .ok_or_else(|| "no clip to derive a composition size from".to_string())?;
    let info = probe_cached(&PathBuf::from(&first.source_path))?;
    if info.resolution.width == 0 || info.resolution.height == 0 {
        return Err(format!("{} has no usable resolution", first.source_path));
    }
    Ok((info.resolution.width, info.resolution.height))
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
///
/// **D-149 — the winning track's own index comes back as the first element.**
/// `resolve_video_clip_at` has always computed it and this function threw it
/// away; the audio path now needs it to look up that track's ducking
/// configuration, and re-deriving "which video track won" at the call site
/// would mean a second copy of the top-wins walk that could drift from this
/// one. Same call as D-147 made for `resolve_audio_track_positions` below: hand
/// back what was already resolved rather than resolve it twice.
pub(crate) fn resolve_video_position(
    pos: u64,
) -> Result<Option<(usize, Clip, u64, VideoInfo)>, String> {
    let timeline = resolve_timeline(false)?;
    if !timeline.tracks.iter().any(|t| t.kind == TrackKind::Video) {
        return Err("timeline has no video track".to_string());
    }

    let Some((track_idx, clip, source_frame)) = timeline.resolve_video_clip_at(pos as i64) else {
        return Ok(None);
    };
    if clip.source_path.is_empty() {
        return Ok(None);
    }
    let info = probe_cached(Path::new(&clip.source_path))?;
    Ok(Some((
        track_idx,
        clip.clone(),
        source_frame.max(0) as u64,
        info,
    )))
}

/// Resolve every genuine `TrackKind::Audio` clip on the active timeline that
/// overlaps `pos` to `(the track index, the clip, its resolved SOURCE frame,
/// its probed VideoInfo, that track's gain)` — the Phase C (D-056) counterpart
/// of [`resolve_video_position`]'s single video-track lookup, feeding
/// `chroma::audio`'s mixer the extra sources to sum in alongside the baseline
/// video-embedded audio. Uses [`chroma_timeline::Track::clip_at`] exactly
/// like the video path — a track with nothing covering `pos` (a gap, or an
/// empty track) contributes nothing, silently, the same "not an error"
/// contract `resolve_video_position` already has. A clip whose source turns
/// out to have no audio stream is skipped the same way.
///
/// **D-147 — this returns the `Clip` + `VideoInfo` rather than D-057's
/// original `(path, start_secs, duration_secs, gain)` tuple**, and that is a
/// simplification, not an extension. The mixer needs the clip's fade fields
/// now, and it *already* derives `start_secs`/`duration_secs` from exactly
/// this pair for the embedded-audio baseline a few lines away in
/// `chroma_audio_play` — so returning the pair removes a duplicated piece of
/// seconds arithmetic instead of adding a fifth positional element to a tuple
/// that was already hard to read. It also keeps the module dependency
/// one-way: `chroma::audio` knows about `chroma::edit`, not the reverse, so
/// the mixer's own `FadeEnvelope` type stays in the mixer.
///
/// The clip's **out-point** (B-048) is the caller's `clip.end_frame_at(fps) -
/// pos`: `chroma::audio` streams each source until it runs out, so it has to
/// be told where the clip actually ends or it keeps playing the rest of the
/// file underneath whatever the timeline cut to next.
///
/// **D-149 — the track's own index comes back too**, as the first element. The
/// mixer needs it to look up that track's ducking configuration, and the index
/// is the only thing that identifies a track (there is no track id); deriving
/// it again at the call site would mean re-walking the same filtered list and
/// getting it subtly wrong the first time an empty audio track sits between
/// two populated ones. It is the *timeline* index, not the position within the
/// filtered audio-only subset — the same index `Track::duck_from` stores.
///
/// **B-079 — the resolved SOURCE frame is now returned too**, rather than
/// discarded (`let Some((clip, _source_frame))`, pre-fix). `Track::clip_at`
/// already computes this correctly, fps-converted via `Clip::source_fps` —
/// the caller (`chroma_audio_play`) used to silently re-derive it with a
/// second, fps-naive `clip.source_start + elapsed_frames` formula instead of
/// reusing this one, which is exactly the bug. Returning it removes that
/// duplicate (and previously wrong) arithmetic at the call site.
///
/// `(track index, clip, resolved source frame, probed VideoInfo, track gain)`
/// — named here (clippy's `type_complexity`) once B-079's fix added the
/// source-frame element on top of D-147/D-149's existing four.
pub(crate) type AudioTrackPosition = (usize, Clip, u64, VideoInfo, f32);

pub(crate) fn resolve_audio_track_positions(pos: u64) -> Result<Vec<AudioTrackPosition>, String> {
    let timeline = resolve_timeline(false)?;
    let fps = timeline.fps();
    let mut out = Vec::new();
    for (track_index, track) in timeline
        .tracks
        .iter()
        .enumerate()
        .filter(|(_, t)| t.kind == TrackKind::Audio)
    {
        let Some((clip, source_frame)) = track.clip_at(pos as i64, fps) else {
            continue;
        };
        if clip.source_path.is_empty() {
            continue;
        }
        let info = probe_cached(Path::new(&clip.source_path))?;
        if !info.has_audio {
            continue;
        }
        out.push((
            track_index,
            clip.clone(),
            source_frame.max(0) as u64,
            info,
            track.gain,
        ));
    }
    Ok(out)
}

/// B-079 — the active timeline's own timebase ([`chroma_timeline::Timeline::fps`]),
/// for `chroma::audio`'s fps-aware per-clip out-point arithmetic
/// (`chroma_audio_play`'s `end_frame_at(fps)` calls) — the one thing that
/// module needs from the timeline beyond what [`resolve_video_position`]/
/// [`resolve_audio_track_positions`] already hand it. A thin, cheap
/// (no media probing) re-read of the manifest rather than widening either of
/// those signatures for a single extra `f64`.
pub(crate) fn timeline_fps() -> Result<f64, String> {
    Ok(resolve_timeline(false)?.fps())
}

/// D-149 — one track's ducking configuration resolved against the active
/// timeline at `pos`: the dB/attack/release numbers off `track_index`'s own
/// `chroma_timeline::Track`, plus the **trigger** track's clip layout from
/// `pos` onward, in timeline frames.
///
/// `Ok(None)` — no ducking for this track — for every ordinary reason, none of
/// them an error: no `duck_from` set (the default and every pre-D-149 project),
/// a `duck_from` that no longer names a real track (a track was removed after
/// the duck was configured), or a track pointed at **itself**. That last one is
/// worth rejecting explicitly rather than letting it through: a track ducking
/// on its own clips would attenuate exactly the audio it is triggered by, which
/// is not a thing anyone means and is trivially reachable by removing a track
/// above the pair and shifting the indices.
///
/// This is the timeline half of D-149 and is why it lives here rather than in
/// `chroma-media`: "which frames does track N have clips on" is timeline
/// resolution, and a media crate reaching for it would be reaching *up* a layer
/// (D-039/D-146 — the same rule that kept `chroma_audio_play`'s body app-side).
pub(crate) fn resolve_track_duck(
    track_index: usize,
    pos: u64,
) -> Result<Option<(f32, f32, f32, Vec<(i64, i64)>)>, String> {
    let timeline = resolve_timeline(false)?;
    let Some(track) = timeline.tracks.get(track_index) else {
        return Ok(None);
    };
    let Some(from) = track.duck_from else {
        return Ok(None);
    };
    if from == track_index {
        return Ok(None);
    }
    let Some(trigger) = timeline.tracks.get(from) else {
        return Ok(None);
    };
    // B-079 — `clip_spans_from` is fps-aware now: a mixed-native-fps trigger
    // clip's duck-envelope span used to end at the wrong timeline frame.
    let fps = timeline.fps();
    Ok(Some((
        track.duck_db,
        track.duck_attack_ms,
        track.duck_release_ms,
        trigger.clip_spans_from(pos as i64, fps),
    )))
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

// --------------------------------------------------------------------------- //
// A/V link groups (D-129/D-138, `docs/notes/av-linking.md`) — exposing the
// timeline crate's own `link`/`unlink` as real commands. D-129 deliberately
// left this undone ("the frontend's `applyOp` + `chroma_timeline_set` is the
// real edit path… exposing it is a one-liner when the MCP surface wants it")
// — these two exist for that MCP/scripting surface, and as the real Tauri
// command each is, NOT as the app UI's own edit path: `TimelinePane.tsx`'s
// Link/Unlink toolbar actions go through `applyOp`'s mirrored `link`/`unlink`
// TypeScript logic in `packages/editor/src/timeline.ts` and
// `chroma_timeline_set`, the same as every other per-clip op on that surface
// (`move`/`trim`/`split`/`remove`), so the whole-timeline undo/redo history
// keeps working uniformly. Both commands below act on the active timeline
// directly and persist immediately, matching `chroma_timeline_add_track` /
// `_remove_track` / `_move_clip` above — real, scriptable surface a caller
// that isn't the editor's own React tree can use without round-tripping a
// whole `Timeline` through `chroma_timeline_set`.
// --------------------------------------------------------------------------- //

/// Dissolve the **complete** A/V link group the clip at `(track, clip)` on
/// the active timeline belongs to, and persist. A no-op for an already
/// unlinked clip; errors for an out-of-range index or a locked track — see
/// `chroma_timeline::Timeline::unlink`'s own doc for the full semantics
/// (Palmier's own `manage_clip_links` `unlink`, Premiere's `Clip > Unlink`,
/// Resolve's "Unlink Clips").
#[tauri::command]
pub fn chroma_timeline_unlink_clip(track: usize, clip: usize) -> Result<(), String> {
    let (dir, mut manifest) = load_and_ensure_timeline(false)?;
    let idx = manifest.active_timeline;
    manifest.timelines[idx]
        .unlink(track, clip)
        .map_err(|e| e.to_string())?;
    manifest.modified = now_rfc3339();
    project::save_manifest(&dir, &manifest)
}

/// Link two **already-independent** clips on the active timeline — one on a
/// video track, one on an audio track — into a new A/V link group, and
/// persist. Returns the new group id. Errors if either clip is already
/// linked, if the two clips are the same track kind (not one video + one
/// audio), if either clip's own track is locked, or for an out-of-range
/// track/clip index — see `chroma_timeline::Timeline::link`'s own doc for
/// the full validation and why this is deliberately narrower than Palmier's
/// own group-merging `link`.
#[tauri::command]
pub fn chroma_timeline_link_clips(
    track_a: usize,
    clip_a: usize,
    track_b: usize,
    clip_b: usize,
) -> Result<String, String> {
    let (dir, mut manifest) = load_and_ensure_timeline(false)?;
    let idx = manifest.active_timeline;
    let group = manifest.timelines[idx]
        .link((track_a, clip_a), (track_b, clip_b))
        .map_err(|e| e.to_string())?;
    manifest.modified = now_rfc3339();
    project::save_manifest(&dir, &manifest)?;
    Ok(group)
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
    let (timeline, settings) = resolve_timeline_and_settings(false)?;
    if !timeline.tracks.iter().any(|t| t.kind == TrackKind::Video) {
        return Err("timeline has no video track".to_string());
    }
    // D-209 — a TEXT clip is a real visible layer with no `source_path` at
    // all: its picture is generated, not decoded. So the "skip a clip with no
    // source" filter (which exists to drop an empty/offline media clip) has
    // to make an exception for it, or a title would resolve, be discarded
    // here, and silently never appear.
    let layers: Vec<(usize, &Clip, i64)> = timeline
        .resolve_visible_video_layers_at(pos as i64)
        .into_iter()
        .filter(|(_, c, _)| c.is_text() || !c.source_path.is_empty())
        .collect();

    // Release the decode pipe of any track that is no longer a visible layer
    // here (hidden, deleted, or just a gap under the playhead) before decoding
    // — D-125: pipes are per track index now, and each one owns a live ffmpeg
    // process, so the set has to track what's actually on screen.
    let visible_tracks: Vec<usize> = layers.iter().map(|(i, _, _)| *i).collect();
    decode_pipe::retain_track_slots(&visible_tracks);

    if layers.is_empty() {
        return Ok(blank_frame());
    }
    let comp = composition_size(&settings, &timeline)?;

    // D-136 — the fast path's second condition. A lone clip may be returned as
    // a plain decode only if it really *is* the whole composition: same pixel
    // dimensions as the composition space, so the picture a plain decode
    // produces and the picture the compositor would produce are the same
    // framing (the preview `<img>` is `object-contain`, so the two differing in
    // resolution alone is invisible — differing in framing is not). A 640×360
    // clip in a 1920×1080 project is a third of the frame wide with black
    // around it, and must go through the compositor to look like that; before
    // D-136 it filled the preview edge to edge, which is the same class of
    // defect as B-043's position drift and would have made the transform
    // overlay draw a box in a place the picture disagrees with.
    let single_plain = match layers.as_slice() {
        // D-209 — a lone TEXT clip never takes the plain-decode fast path:
        // there is no source to decode, and its whole picture comes from the
        // compositor's own rasterise-and-blend step.
        [(_, clip, _)] if clip.is_text() => false,
        [(_, clip, source_frame)] => {
            let info = probe_cached(&PathBuf::from(&clip.source_path))?;
            resolve_clip_transform(clip, *source_frame).is_identity()
                && (info.resolution.width, info.resolution.height) == comp
        }
        _ => false,
    };

    let img = match layers.as_slice() {
        [] => return Ok(blank_frame()),
        [(track, clip, source_frame)] if single_plain => {
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
        _ => composite_video_frame(&layers, max_long_edge, comp)?,
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

/// One clip's placement geometry in composition space — what an on-canvas
/// transform overlay needs and cannot work out for itself (D-136, Phase 1 of
/// `docs/notes/on-canvas-transform.md`).
///
/// The frontend can already read a clip's `position_*`/`scale`, and after
/// D-136 those are fractions of the composition, so the *offset* half of the
/// overlay's box needs no backend help at all. What it can't know is how big
/// the box is: that is the clip's source resolution measured against the
/// composition's, and neither number is in the timeline JSON.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipGeometry {
    /// The composition's own pixel size ([`composition_size`]) — reported so
    /// the overlay can show a real resolution and so a caller that wants
    /// composition pixels can convert, not because the box math needs it.
    pub comp_width: u32,
    pub comp_height: u32,
    /// The clip's full-frame footprint at `scale == 1.0`, as a fraction of
    /// the composition. `1.0`/`1.0` = its source exactly fills the frame.
    pub natural_width: f64,
    pub natural_height: f64,
}

/// [`ClipGeometry`] for the clip at `track`/`clip` on the active timeline.
///
/// Indices, not a clip id, to match every other per-clip command on this
/// surface (`chroma_timeline_move_clip`, and the `set_clip_transform` op the
/// overlay writes) — the caller resolving an id to an index once and using it
/// for both is strictly better than two conventions in one interaction.
///
/// Probes the source (cached, [`probe_cached`]), so it is `async` +
/// `spawn_blocking` for the same reason [`chroma_timeline_frame`] is: a cold
/// probe is two `ffprobe` spawns and must not sit on Tauri's main thread.
#[tauri::command]
pub async fn chroma_timeline_clip_geometry(
    track: usize,
    clip: usize,
) -> Result<ClipGeometry, String> {
    tokio::task::spawn_blocking(move || clip_geometry(track, clip))
        .await
        .map_err(|e| format!("clip geometry task: {e}"))?
}

/// The synchronous body of [`chroma_timeline_clip_geometry`] — split out for
/// the same reason [`timeline_frame`] is, so tests can call it without a
/// tokio runtime.
pub(crate) fn clip_geometry(track: usize, clip: usize) -> Result<ClipGeometry, String> {
    let (timeline, settings) = resolve_timeline_and_settings(false)?;
    let (comp_w, comp_h) = composition_size(&settings, &timeline)?;
    let c = timeline
        .tracks
        .get(track)
        .and_then(|t| t.clips.get(clip))
        .ok_or_else(|| format!("no clip {clip} on track {track}"))?;
    // D-209 — a text clip's layer is generated at exactly the composition's
    // size (see `composite_video_frame`), so its natural footprint IS the
    // whole frame. Answered here rather than erroring "clip has no source",
    // so the Inspector's own geometry fetch works for a title the same way it
    // does for a media clip.
    if c.is_text() {
        return Ok(ClipGeometry {
            comp_width: comp_w,
            comp_height: comp_h,
            natural_width: 1.0,
            natural_height: 1.0,
        });
    }
    if c.source_path.is_empty() {
        return Err("clip has no source".to_string());
    }
    let info = probe_cached(&PathBuf::from(&c.source_path))?;
    Ok(ClipGeometry {
        comp_width: comp_w,
        comp_height: comp_h,
        natural_width: info.resolution.width as f64 / comp_w as f64,
        natural_height: info.resolution.height as f64 / comp_h as f64,
    })
}

/// D-199 (canvas-boundary preview overlay) — the composition's own pixel size
/// ([`composition_size`]), with NO clip selection required.
///
/// [`ClipGeometry`]/[`chroma_timeline_clip_geometry`] already reports
/// `comp_width`/`comp_height`, but only as a side effect of resolving ONE
/// selected clip's box — `TransformOverlay.tsx` (the on-canvas transform
/// handles) has always had this for free because it never needs the frame
/// size without a clip also selected. A boundary overlay that must render
/// with NOTHING selected (so a human can see the real output frame before
/// touching anything) needs the composition size on its own — this is that,
/// a thin wrapper with no clip-probing at all.
#[tauri::command]
pub async fn chroma_timeline_composition_size() -> Result<ClipGeometry, String> {
    tokio::task::spawn_blocking(composition_size_only)
        .await
        .map_err(|e| format!("composition size task: {e}"))?
}

/// The synchronous body of [`chroma_timeline_composition_size`] — same
/// `spawn_blocking` split as [`timeline_frame`]/[`clip_geometry`]: this can
/// end up probing a clip too (`composition_size`'s no-explicit-settings
/// fallback), which is real disk I/O, so it stays off the async runtime's
/// caller and off Tauri's main thread the same way.
///
/// Reuses [`ClipGeometry`]'s shape with `natural_width`/`natural_height`
/// fixed at `1.0` (undefined without a clip — see that struct's own doc for
/// what they mean) rather than inventing a second, near-identical DTO the
/// frontend would need a second type for.
fn composition_size_only() -> Result<ClipGeometry, String> {
    let (timeline, settings) = resolve_timeline_and_settings(false)?;
    let (comp_w, comp_h) = composition_size(&settings, &timeline)?;
    Ok(ClipGeometry {
        comp_width: comp_w,
        comp_height: comp_h,
        natural_width: 1.0,
        natural_height: 1.0,
    })
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
    /// D-193 — resolved (static-or-keyframed) mirror of `Clip::box_width`/
    /// `box_height`: `Some` overrides `scale`'s natural-footprint box-size
    /// computation entirely for that axis (a fraction of the CANVAS, not
    /// the layer's own source), `None` means "no override, this axis is
    /// governed by `scale` as before D-193" — see [`Self::effective_size`]
    /// (the point of use) and `Clip::box_width`'s own doc for the full
    /// reasoning.
    box_width: Option<f64>,
    box_height: Option<f64>,
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
            // D-193 — conservative on purpose: proving a `box_width`/
            // `box_height` override happens to equal what `scale == 1.0`
            // would have produced anyway needs the canvas size, which this
            // method doesn't have. Treating "an override is present at
            // all" as "not identity" is always SAFE (worst case, an
            // override that happens to be a no-op still takes the real
            // compositor path instead of the fast one) and never wrong —
            // the same discipline `crop_left`'s own exact-comparison note
            // above already explains for this method.
            && self.box_width.is_none()
            && self.box_height.is_none()
            && self.rotation == 0.0
            && self.crop_left <= 0.0
            && self.crop_top <= 0.0
            && self.crop_right <= 0.0
            && self.crop_bottom <= 0.0
    }

    /// This layer's placement box size, in `canvas`-pixel space (D-193).
    /// `box_width`/`box_height`, when set, are a fraction of `canvas`
    /// directly — bypassing `natural`/`scale` entirely for that axis, which
    /// is what gives this override zero Rust/TS-export parity gap (see
    /// `Clip::box_width`'s own doc). An axis with no override falls back to
    /// exactly the pre-D-193 formula: `natural.{0,1} * scale`.
    fn effective_size(&self, natural: (f64, f64), canvas: (u32, u32)) -> (f64, f64) {
        let scale = self.scale.max(0.0);
        let (cw, ch) = canvas;
        let w = self
            .box_width
            .map(|bw| bw * cw as f64)
            .unwrap_or(natural.0 * scale);
        let h = self
            .box_height
            .map(|bh| bh * ch as f64)
            .unwrap_or(natural.1 * scale);
        (w, h)
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
///
/// **D-147 — the clip's fade multiplies into `opacity` last**, after the
/// static-or-keyframed value has been resolved, so a keyframed opacity
/// animation and the clip's own fade compose *multiplicatively* (clip opacity
/// keyframes × the fade handle — what a real NLE does, and the only order
/// under which neither silently overrides the other). The position within the
/// clip comes free and exactly: `source_frame - clip.source_start`, straight
/// out of `Track::clip_at`'s own definition (`source_start + (timeline_frame -
/// start_frame)`), so this needs no signature change. A clip with no fade
/// configured gets exactly `1.0` from `fade_multiplier_at` with no arithmetic
/// at all — the byte-identical-to-pre-D-147 guarantee.
///
/// Note this deliberately does NOT need a change to
/// [`ClipTransform::is_identity`]: the fade is already folded into `opacity`
/// by the time that runs, so a faded lone clip correctly fails the
/// `opacity >= 1.0` test and goes through the compositor instead of
/// [`timeline_frame`]'s plain-decode fast path — which is exactly the
/// D-132/B-053 lesson about a lone clip's transform being silently discarded.
fn resolve_clip_transform(clip: &Clip, source_frame: i64) -> ClipTransform {
    let mut t = resolve_clip_transform_unfaded(clip, source_frame);
    t.opacity *= clip.fade_multiplier_at(source_frame - clip.source_start);
    t
}

/// D-209 — [`resolve_clip_transform`] for a **text clip**: the same resolved
/// (static-or-keyframed, fade-multiplied) `opacity`/`position_x`/`position_y`,
/// with every other field pinned to its identity value.
///
/// **The pinning is the point, and it is not a shortcut.** The export half of
/// this feature compiles a text clip to ffmpeg's `drawtext`, which can place a
/// text box (`x`/`y` expressions), fade it (`alpha`), and nothing else — it
/// cannot scale, rotate or crop one. If the live preview honoured `scale` and
/// the export ignored it, the preview would be showing a picture the export
/// cannot produce: precisely the class of defect B-053 (a lone clip's
/// transform silently dropped in the preview), B-090 (a keyframed `scale`
/// silently dropped in the export) and B-094 each closed. Making the preview
/// deliberately match the narrower engine is what keeps "preview matches
/// export" a fact for Phase 1. Widening BOTH sides — by compiling a text clip
/// to a rasterised overlay input instead of `drawtext`, which then rides the
/// identical `overlay` chain a video layer does and gets every transform for
/// free — is the Phase 2 route, recorded in `docs/notes/text-title-clips.md`.
///
/// The GUI never offers those fields for a text clip and
/// `editor_set_clip_transform` refuses a non-default value for one, so this
/// is the third and last line of that defence, not the only one.
fn resolve_text_clip_transform(clip: &Clip, source_frame: i64) -> ClipTransform {
    let t = resolve_clip_transform(clip, source_frame);
    ClipTransform {
        opacity: t.opacity,
        position_x: t.position_x,
        position_y: t.position_y,
        scale: 1.0,
        box_width: None,
        box_height: None,
        rotation: 0.0,
        crop_left: 0.0,
        crop_top: 0.0,
        crop_right: 0.0,
        crop_bottom: 0.0,
    }
}

/// [`resolve_clip_transform`] without D-147's fade multiply — the D-088/D-132
/// static-or-keyframed resolution on its own. Split out purely so the fade can
/// be applied at one place after every one of this function's three return
/// paths, rather than repeated at each.
fn resolve_clip_transform_unfaded(clip: &Clip, source_frame: i64) -> ClipTransform {
    let base = ClipTransform {
        opacity: clip.opacity,
        position_x: clip.position_x,
        position_y: clip.position_y,
        scale: clip.scale,
        box_width: clip.box_width,
        box_height: clip.box_height,
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
    // D-208 (B-094) — resolve **one param at a time, over only the keys that
    // define it** (`interpolate_param`), not by frame-bracketing across every
    // key (`interpolate`). Per-property keyframing means a clip's keys really
    // do carry different param subsets at different frames, and the shared
    // mask resolver's "a field present in only one bracketing key is held
    // from that key" rule turns such a param's linear ramp into a step. This
    // is the same filter-then-interpolate order `timelineExport.ts`'s
    // `keyframeExprAt` already used, so preview and export agree by
    // construction. Byte-identical to the old call for any clip whose keys all
    // carry the same params — i.e. every pre-D-208 whole-clip key.
    let source_frame_u64 = source_frame.max(0) as u64;
    let f64_or = |key: &str, fallback: f64| {
        super::keyframes::interpolate_param(&keyframes, source_frame_u64, key)
            .and_then(|v| v.as_f64())
            .unwrap_or(fallback)
    };
    ClipTransform {
        opacity: f64_or("opacity", base.opacity),
        position_x: f64_or("position_x", base.position_x),
        position_y: f64_or("position_y", base.position_y),
        scale: f64_or("scale", base.scale),
        // D-193 — an override is itself independently keyframeable via its
        // own "box_width"/"box_height" params key (mirrors every field
        // above); a clip with NO override (`base.box_width`/`box_height`
        // both `None`) always stays `None` here too, regardless of the
        // keyframe data — there is nothing to interpolate FROM, and
        // inventing a value would silently turn an un-overridden clip into
        // an overridden one.
        box_width: base.box_width.map(|bw| f64_or("box_width", bw)),
        box_height: base.box_height.map(|bh| f64_or("box_height", bh)),
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
/// contract.
///
/// **The canvas is the COMPOSITION** (`comp`, in pixels — see
/// [`composition_size`]), downscaled to `max_long_edge` for the preview.
/// Each layer is placed at its own **natural footprint in composition
/// space** — its source pixel dimensions measured against the composition's
/// — times `scale`, centred, then offset by `position_x`/`position_y` as
/// fractions of the canvas. Not scaled to fill the canvas by default: a
/// lower-priority layer showing through at its own native size, like a
/// picture-in-picture, is the more useful default than a silent full-bleed
/// stretch, and that intent is unchanged from D-088 — what changed (D-136)
/// is that "native size" is now measured against a fixed composition
/// instead of against another layer's decode.
///
/// **Why that closes B-043.** The canvas used to be `decoded[0].img`'s
/// dimensions, i.e. the top layer decoded at whatever `max_long_edge` the
/// caller asked for, and `scale_target` returns `None` for a source already
/// under the cap. So the canvas changed size with the preview quality, with
/// the top layer's source resolution, and with which clip was on top at that
/// playhead — and `position_*`/`scale`, measured in that canvas's pixels,
/// changed meaning with it. Here `max_long_edge` only chooses how many
/// pixels the same composition is rendered into: every geometry field is a
/// ratio of the composition, so the picture is identical at every preview
/// quality up to resampling. Preview scale is a render-quality knob and
/// nothing else, which is what it always claimed to be.
fn composite_video_frame(
    layers: &[(usize, &Clip, i64)],
    max_long_edge: Option<u32>,
    comp: (u32, u32),
) -> Result<DynamicImage, String> {
    struct Decoded {
        /// `Arc` (D-209) purely so a **rasterised text layer** — which
        /// `chroma::text` hands back from its own cache, shared with whatever
        /// other frame is showing the same title — needs no per-frame clone
        /// of a full canvas-sized buffer. A decoded video frame is owned
        /// outright and just gets wrapped; the cost is one allocation per
        /// layer per frame, against a memcpy of the whole buffer.
        img: std::sync::Arc<image::RgbaImage>,
        transform: ClipTransform,
        /// This layer's full-frame footprint on the canvas at `scale == 1.0`,
        /// in canvas pixels — its source size mapped through the composition.
        natural: (f64, f64),
    }

    let (comp_w, comp_h) = comp;
    let (canvas_w, canvas_h) = max_long_edge
        .and_then(|le| decode_pipe::scale_target(comp_w, comp_h, le))
        .unwrap_or((comp_w, comp_h));
    // One uniform ratio for both axes (from the width): `scale_target`
    // preserves aspect apart from its even-dimension rounding, and deriving
    // x and y independently would let that ±1 px turn into a visible
    // anisotropic squash on every layer.
    let render_scale = canvas_w as f64 / comp_w as f64;

    let mut decoded: Vec<Decoded> = Vec::with_capacity(layers.len());
    for (track, clip, source_frame) in layers {
        // D-209 — a text clip's layer is GENERATED, not decoded: rasterise it
        // at the canvas's own size (so `natural` is the canvas and no resize
        // step runs) and let everything downstream — the paint order, the
        // position offset, the opacity/fade multiply — treat it exactly like
        // a decoded one. `resolve_text_clip_transform` is what keeps that
        // "exactly like" honest by zeroing the fields the export path cannot
        // reproduce; see its own doc.
        if let Some(layer) = &clip.text {
            decoded.push(Decoded {
                img: text::render_text_layer(layer, canvas_w, canvas_h)?,
                transform: resolve_text_clip_transform(clip, *source_frame),
                natural: (canvas_w as f64, canvas_h as f64),
            });
            continue;
        }
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
            img: std::sync::Arc::new(img.to_rgba8()),
            transform: resolve_clip_transform(clip, *source_frame),
            // The layer's **source** size, not its decoded size — that is the
            // whole point: the decoded size follows the preview quality, the
            // source size does not.
            natural: (
                info.resolution.width as f64 * render_scale,
                info.resolution.height as f64 * render_scale,
            ),
        });
    }

    let mut canvas: image::RgbaImage =
        image::ImageBuffer::from_pixel(canvas_w, canvas_h, image::Rgba([0, 0, 0, 255]));

    for d in decoded.iter().rev() {
        composite_layer_onto(&mut canvas, &d.img, &d.transform, d.natural);
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
///
/// `natural` (D-136) is this layer's full-frame footprint on `canvas` at
/// `scale == 1.0`, in canvas pixels — computed by the caller from the
/// layer's SOURCE resolution and the composition, never from `layer`'s own
/// decoded dimensions. That indirection is the fix for B-043's second half:
/// resizing the decoded buffer by a plain `scale` made a layer's on-screen
/// size follow the preview's decode quality (a 640×360 source under a
/// 960-px cap isn't downscaled at all, so it was two thirds of a 4K-derived
/// canvas at one quality and the entire canvas at another). The decoded
/// buffer's size now only affects sharpness.
fn composite_layer_onto(
    canvas: &mut image::RgbaImage,
    layer: &image::RgbaImage,
    t: &ClipTransform,
    natural: (f64, f64),
) {
    let opacity = t.opacity.clamp(0.0, 1.0) as f32;
    if opacity <= 0.0 {
        return; // fully transparent — nothing to paint, skip the work
    }

    let (lw, lh) = layer.dimensions();
    let Some((cx0, cy0, cx1, cy1)) = crop_pixel_rect(lw, lh, t) else {
        return; // cropped away entirely — nothing to paint
    };
    let cropped = (cx0, cy0, cx1, cy1) != (0, 0, lw, lh);
    // D-193 — `box_width`/`box_height` (canvas-fraction, when set) override
    // `natural * scale` per axis independently; see `ClipTransform::
    // effective_size`'s own doc for the full "why".
    let (raw_w, raw_h) = t.effective_size(natural, canvas.dimensions());
    let (sw, sh) = (raw_w.round().max(1.0) as u32, raw_h.round().max(1.0) as u32);
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
    // D-136 — `position_*` is a fraction of the composition, so it scales
    // with the canvas: the same stored value lands on the same part of the
    // picture at every preview quality. Per-axis (x against the width, y
    // against the height), matching the crop insets' own convention.
    let x = (cw as f64) / 2.0 - (ww as f64) / 2.0 + t.position_x * cw as f64;
    let y = (ch as f64) / 2.0 - (wh as f64) / 2.0 + t.position_y * ch as f64;
    image::imageops::overlay(canvas, &work, x.round() as i64, y.round() as i64);
}

#[cfg(test)]
mod composite_tests {
    use super::*;
    use image::{ImageBuffer, Rgba};

    fn flat(w: u32, h: u32, px: [u8; 4]) -> image::RgbaImage {
        ImageBuffer::from_pixel(w, h, Rgba(px))
    }

    /// D-136 — a layer whose natural composition footprint is exactly its own
    /// buffer size, i.e. "this layer's source fills the composition and the
    /// canvas is at full resolution." Keeps every pre-D-136 case in this
    /// module testing exactly what it tested before; the tests that exercise
    /// the new indirection pass a different `natural` deliberately.
    fn natural_of(layer: &image::RgbaImage) -> (f64, f64) {
        let (w, h) = layer.dimensions();
        (w as f64, h as f64)
    }

    fn identity_transform() -> ClipTransform {
        ClipTransform {
            opacity: 1.0,
            position_x: 0.0,
            position_y: 0.0,
            scale: 1.0,
            box_width: None,
            box_height: None,
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

    /// **B-094 / D-208 — per-property keyframes really are independent.**
    /// Three keys, each naming a DIFFERENT param subset: `scale` is keyed at
    /// 0 and 100 only, `opacity` at 50 only. `scale` must ramp linearly
    /// across the whole 0..100 span, completely unaffected by the unrelated
    /// `opacity` key sitting in the middle of it — the exact contract
    /// `timelineExport.ts`'s `keyframeExprAt` already had (it filters every
    /// key by `hasOwnProperty(param)` before interpolating) and that this
    /// live-preview path did NOT, because `keyframes::interpolate` brackets
    /// by frame across ALL keys and then *holds* a param that only one side
    /// of the bracket defines.
    #[test]
    fn each_param_interpolates_across_only_its_own_keyframes() {
        let clip = Clip {
            opacity: 1.0,
            scale: 1.0,
            chroma_keyframes: Some(serde_json::json!([
                { "frame": 0,   "params": { "scale": 1.0 } },
                { "frame": 50,  "params": { "opacity": 0.5 } },
                { "frame": 100, "params": { "scale": 2.0 } },
            ])),
            ..Default::default()
        };
        // scale ramps 1 -> 2 over 0..100, sampled either side of the
        // unrelated opacity key. Pre-fix this was a step function: flat 1.0
        // up to 50 (held from the low key), then flat 2.0 (held from the
        // high key).
        for (frame, want) in [(25u64, 1.25), (50, 1.5), (75, 1.75)] {
            let t = resolve_clip_transform(&clip, frame as i64);
            assert!(
                (t.scale - want).abs() < 1e-6,
                "scale at frame {frame}: expected {want}, got {}",
                t.scale
            );
        }
        // ...and opacity, keyed only once, holds flat at that one value
        // everywhere rather than being dragged around by the scale keys.
        for frame in [0i64, 25, 50, 75, 100] {
            let t = resolve_clip_transform(&clip, frame);
            assert!(
                (t.opacity - 0.5).abs() < 1e-6,
                "opacity at frame {frame}: expected 0.5, got {}",
                t.opacity
            );
        }
    }

    /// **The preview PIXELS, not just the resolved struct.** The same
    /// resolve-then-composite pair `composite_video_frame` runs per frame,
    /// driven by the shape per-property keyframing actually produces: `scale`
    /// keyed at 0 and 100, an unrelated `opacity` key at 50 sitting between
    /// them. This is the B-088-shaped check the per-property GUI is built on
    /// ("a preview that lies is worse than no feature").
    ///
    /// **Sampled at frame 25, deliberately** — the endpoints alone would pass
    /// either way (both resolvers land exactly on a key there), and so would
    /// a clip whose keys all named `scale`. Frame 25 is inside the bracket
    /// whose upper key does NOT name `scale`, which is precisely where the
    /// old union-bracket resolver *held* `scale` at 1.0 and painted a 4x4 box
    /// instead of the 8x8 the animation calls for.
    #[test]
    fn the_preview_really_animates_one_keyed_property_and_holds_the_rest() {
        let clip = Clip {
            scale: 1.0,
            position_x: 0.0,
            chroma_keyframes: Some(serde_json::json!([
                { "frame": 0,   "params": { "scale": 1.0 } },
                { "frame": 50,  "params": { "opacity": 1.0 } },
                { "frame": 100, "params": { "scale": 5.0 } },
            ])),
            ..Default::default()
        };
        let layer = flat(4, 4, [255, 0, 0, 255]);
        let paint = |frame: i64| {
            let mut canvas = flat(20, 20, [0, 0, 0, 255]);
            let t = resolve_clip_transform(&clip, frame);
            composite_layer_onto(&mut canvas, &layer, &t, natural_of(&layer));
            canvas
        };

        // Frame 0: scale 1 -> a 4x4 box centred in the 20x20 canvas.
        let first = paint(0);
        assert_eq!(*first.get_pixel(10, 10), Rgba([255, 0, 0, 255]));
        assert_eq!(*first.get_pixel(6, 6), Rgba([0, 0, 0, 255]));

        // Frame 25: scale interpolates 1 -> 5 across 0..100, so 2.0 here ->
        // an 8x8 box that now really covers (6,6). Held at 1.0 pre-fix, this
        // pixel stayed black and the "zoom" never happened on screen.
        let mid = paint(25);
        assert_eq!(*mid.get_pixel(10, 10), Rgba([255, 0, 0, 255]));
        assert_eq!(
            *mid.get_pixel(6, 6),
            Rgba([255, 0, 0, 255]),
            "scale must really animate between its own keys, across an unrelated key"
        );

        // Still centred throughout — `position_x` is keyed nowhere, so it
        // stayed at its static 0.0 while `scale` animated past it.
        for canvas in [&first, &mid] {
            assert_eq!(*canvas.get_pixel(0, 10), Rgba([0, 0, 0, 255]));
            assert_eq!(*canvas.get_pixel(19, 10), Rgba([0, 0, 0, 255]));
        }
    }

    /// The other half of B-094: a param that NO key defines falls back to the
    /// clip's own static field, rather than being invented from a neighbour.
    #[test]
    fn an_unkeyed_param_keeps_its_static_value_on_a_keyframed_clip() {
        let clip = Clip {
            rotation: 30.0,
            position_x: 0.25,
            chroma_keyframes: Some(serde_json::json!([
                { "frame": 0,   "params": { "scale": 1.0 } },
                { "frame": 100, "params": { "scale": 2.0 } },
            ])),
            ..Default::default()
        };
        let t = resolve_clip_transform(&clip, 50);
        assert_eq!(t.rotation, 30.0);
        assert_eq!(t.position_x, 0.25);
        assert!((t.scale - 1.5).abs() < 1e-6);
    }

    // --- D-147: clip fades in the compositor ----------------------------- //

    /// **The backward-compatibility case for the compositor.** A clip with no
    /// fade configured — every clip in every pre-D-147 project — resolves to
    /// exactly the opacity it did before, bit for bit, at every frame.
    #[test]
    fn a_clip_with_no_fade_resolves_to_exactly_the_old_opacity() {
        for opacity in [1.0, 0.5, 0.0] {
            let clip = Clip {
                opacity,
                duration: 100,
                ..Default::default()
            };
            for f in [0, 1, 50, 99, 100] {
                let t = resolve_clip_transform(&clip, f);
                assert_eq!(
                    t.opacity.to_bits(),
                    opacity.to_bits(),
                    "opacity {opacity} at frame {f} changed to {}",
                    t.opacity
                );
            }
        }
    }

    /// A fade really reaches zero opacity at both boundaries, and unity in the
    /// clear middle — the compositor half of the same property the audio
    /// envelope and the pure curve math are each tested for.
    #[test]
    fn a_faded_clip_reaches_zero_opacity_at_both_boundaries() {
        let clip = Clip {
            opacity: 1.0,
            duration: 100,
            fade_in_frames: 20,
            fade_out_frames: 20,
            ..Default::default()
        };
        assert_eq!(resolve_clip_transform(&clip, 0).opacity, 0.0);
        assert_eq!(resolve_clip_transform(&clip, 100).opacity, 0.0);
        assert!((resolve_clip_transform(&clip, 10).opacity - 0.5).abs() < 1e-6);
        assert!((resolve_clip_transform(&clip, 50).opacity - 1.0).abs() < 1e-6);
        assert!((resolve_clip_transform(&clip, 90).opacity - 0.5).abs() < 1e-6);
    }

    /// The fade is measured from the clip's own IN-POINT, not from source
    /// frame 0 — so a trimmed clip (`source_start > 0`) fades over its own
    /// first frames, not over frames it does not contain.
    #[test]
    fn the_fade_window_is_measured_from_the_clips_in_point() {
        let clip = Clip {
            opacity: 1.0,
            source_start: 500,
            duration: 100,
            fade_in_frames: 20,
            ..Default::default()
        };
        // source frame 500 IS this clip's first frame
        assert_eq!(resolve_clip_transform(&clip, 500).opacity, 0.0);
        assert!((resolve_clip_transform(&clip, 510).opacity - 0.5).abs() < 1e-6);
        assert!((resolve_clip_transform(&clip, 520).opacity - 1.0).abs() < 1e-6);
    }

    /// The fade multiplies into the KEYFRAMED opacity, not instead of it —
    /// clip opacity keyframes × the fade handle, which is what a real NLE
    /// does and the only order under which neither silently overrides the
    /// other.
    #[test]
    fn the_fade_multiplies_into_a_keyframed_opacity() {
        let clip = Clip {
            opacity: 1.0,
            duration: 100,
            fade_in_frames: 20,
            chroma_keyframes: Some(serde_json::json!([
                { "frame": 0, "params": { "opacity": 0.5 } },
                { "frame": 100, "params": { "opacity": 0.5 } },
            ])),
            ..Default::default()
        };
        // keyframed opacity is a flat 0.5; halfway through the fade-in the
        // multiplier is 0.5, so the result must be 0.25 — not 0.5 (fade
        // ignored) and not 0.5 (keyframe ignored).
        let t = resolve_clip_transform(&clip, 10);
        assert!(
            (t.opacity - 0.25).abs() < 1e-6,
            "expected 0.25, got {}",
            t.opacity
        );
    }

    /// A faded clip must NOT be treated as an identity transform — otherwise
    /// `timeline_frame`'s single-layer fast path would return a plain decode
    /// and the fade would silently do nothing in the preview. This is exactly
    /// the D-132/B-053 failure mode, checked for the new field.
    #[test]
    fn a_faded_lone_clip_is_not_identity_so_it_cannot_take_the_fast_path() {
        let clip = Clip {
            opacity: 1.0,
            duration: 100,
            fade_in_frames: 20,
            ..Default::default()
        };
        assert!(!resolve_clip_transform(&clip, 5).is_identity(), "mid-fade");
        // …and it IS identity again once clear of the fade window, so an
        // un-faded stretch of a faded clip still takes the cheap path.
        assert!(
            resolve_clip_transform(&clip, 50).is_identity(),
            "clear of the fade"
        );
    }

    /// Opacity 0 must be a real no-op — the canvas is untouched, not just
    /// "very faint."
    #[test]
    fn composite_layer_onto_skips_entirely_at_zero_opacity() {
        let mut canvas = flat(4, 4, [10, 20, 30, 255]);
        let before = canvas.clone();
        let layer = flat(4, 4, [255, 255, 255, 255]);
        let t = ClipTransform { opacity: 0.0, ..identity_transform() };
        composite_layer_onto(&mut canvas, &layer, &t, natural_of(&layer));
        assert_eq!(canvas, before);
    }

    /// Opacity 1 with an opaque layer exactly covering the canvas must
    /// produce the layer's own color, not a blend with whatever was there.
    #[test]
    fn composite_layer_onto_full_opacity_fully_replaces() {
        let mut canvas = flat(4, 4, [10, 20, 30, 255]);
        let layer = flat(4, 4, [200, 100, 50, 255]);
        composite_layer_onto(&mut canvas, &layer, &identity_transform(), natural_of(&layer));
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
        composite_layer_onto(&mut canvas, &layer, &t, natural_of(&layer));
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
        // centered would place the 2x2 layer at (4,4)-(5,5); shift +0.3 of
        // the canvas width = +3 px, +0 (D-136 — a FRACTION, not pixels).
        let t = ClipTransform { position_x: 0.3, ..identity_transform() };
        composite_layer_onto(&mut canvas, &layer, &t, natural_of(&layer));
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
        composite_layer_onto(&mut canvas, &layer, &t, natural_of(&layer));
        assert_eq!(*canvas.get_pixel(10, 10), Rgba([255, 0, 0, 255]));
        assert_eq!(*canvas.get_pixel(1, 1), Rgba([0, 0, 0, 255]));
    }

    // ---------------------------------------------------------------- //
    // D-193 — independent per-axis `box_width`/`box_height`
    // (`docs/notes/independent-clip-size.md`).
    // ---------------------------------------------------------------- //

    /// `box_width`/`box_height` size the box as a fraction of the CANVAS,
    /// independently per axis — the exact "full width, half height" layout
    /// a single uniform `scale` could never produce (B-074's own finding,
    /// generalised past export-only `fit`/`stretch` into a real persisted
    /// field).
    #[test]
    fn composite_layer_onto_respects_independent_box_width_and_box_height() {
        let mut canvas = flat(20, 10, [0, 0, 0, 255]);
        let layer = flat(4, 4, [255, 0, 0, 255]);
        // full canvas width, half its height -> 20x5, centered at (0,2.5)-(20,7.5)
        let t = ClipTransform {
            box_width: Some(1.0),
            box_height: Some(0.5),
            ..identity_transform()
        };
        composite_layer_onto(&mut canvas, &layer, &t, natural_of(&layer));
        assert_eq!(*canvas.get_pixel(10, 5), Rgba([255, 0, 0, 255]));
        assert_eq!(*canvas.get_pixel(0, 5), Rgba([255, 0, 0, 255]));
        assert_eq!(
            *canvas.get_pixel(10, 0),
            Rgba([0, 0, 0, 255]),
            "outside the half-height box"
        );
        assert_eq!(
            *canvas.get_pixel(10, 9),
            Rgba([0, 0, 0, 255]),
            "outside the half-height box"
        );
    }

    /// An axis with no override still falls back to exactly the pre-D-193
    /// `natural * scale` formula — `box_width`/`box_height` are additive,
    /// they never change what an existing clip (or a clip that only sets
    /// one of the two axes) already renders.
    #[test]
    fn box_size_override_on_one_axis_leaves_the_other_on_the_scale_formula() {
        let mut canvas = flat(20, 20, [0, 0, 0, 255]);
        let layer = flat(4, 4, [255, 0, 0, 255]);
        // width forced to the full canvas; height keeps scale's 1x4 = 4px.
        let t = ClipTransform {
            box_width: Some(1.0),
            scale: 1.0,
            ..identity_transform()
        };
        composite_layer_onto(&mut canvas, &layer, &t, natural_of(&layer));
        assert_eq!(
            *canvas.get_pixel(10, 9),
            Rgba([255, 0, 0, 255]),
            "18x4 box, y in [8,12)"
        );
        assert_eq!(
            *canvas.get_pixel(10, 5),
            Rgba([0, 0, 0, 255]),
            "above the 4px-tall box"
        );
    }

    /// D-193/B-053-style safety: a `box_width`/`box_height` override must
    /// not be treated as an identity transform just because it happens to
    /// visually coincide with `scale == 1.0` — see `ClipTransform::
    /// is_identity`'s own doc for why this is a deliberately conservative,
    /// always-safe rule rather than a canvas-aware exact check.
    #[test]
    fn a_clip_with_a_box_size_override_is_never_identity() {
        let t = ClipTransform {
            box_width: Some(1.0),
            ..identity_transform()
        };
        assert!(!t.is_identity());
        let t = ClipTransform {
            box_height: Some(1.0),
            ..identity_transform()
        };
        assert!(!t.is_identity());
    }

    /// D-193 — resolving a clip with NO `box_width`/`box_height` override
    /// must never invent one from keyframe data, even when the clip is
    /// otherwise keyframed (here, `opacity`) — there is nothing to
    /// interpolate FROM for an axis the clip never set.
    #[test]
    fn resolve_clip_transform_leaves_box_size_none_without_an_override() {
        let clip = Clip {
            chroma_keyframes: Some(serde_json::json!([
                { "frame": 0, "params": { "opacity": 0.0 } },
                { "frame": 100, "params": { "opacity": 1.0 } },
            ])),
            ..Default::default()
        };
        let t = resolve_clip_transform(&clip, 50);
        assert_eq!(t.box_width, None);
        assert_eq!(t.box_height, None);
    }

    /// D-193 — once a clip HAS an override, that override is itself
    /// keyframeable via its own `box_width`/`box_height` params key, same
    /// as every other transform field.
    #[test]
    fn resolve_clip_transform_resolves_a_keyframed_box_width() {
        let clip = Clip {
            box_width: Some(0.5), // static fallback before/after the keys
            chroma_keyframes: Some(serde_json::json!([
                { "frame": 0, "params": { "box_width": 0.2 } },
                { "frame": 100, "params": { "box_width": 1.0 } },
            ])),
            ..Default::default()
        };
        assert_eq!(resolve_clip_transform(&clip, 0).box_width, Some(0.2));
        assert!((resolve_clip_transform(&clip, 50).box_width.unwrap() - 0.6).abs() < 0.01);
        assert_eq!(resolve_clip_transform(&clip, 100).box_width, Some(1.0));
    }

    // ---------------------------------------------------------------- //
    // D-136 — composition space (Phase 0a of
    // `docs/notes/on-canvas-transform.md`, closes B-043).
    // ---------------------------------------------------------------- //

    /// The painted region of `canvas` in the flat `colour`, as
    /// `(x0, y0, x1, y1)` **fractions** of the canvas — the unit the geometry
    /// fields are now in, so two renders of the same transform at different
    /// canvas resolutions can be compared directly.
    fn painted_fraction(canvas: &image::RgbaImage, colour: Rgba<u8>) -> (f64, f64, f64, f64) {
        let (w, h) = canvas.dimensions();
        let (mut x0, mut y0, mut x1, mut y1) = (u32::MAX, u32::MAX, 0u32, 0u32);
        for (x, y, p) in canvas.enumerate_pixels() {
            if *p == colour {
                x0 = x0.min(x);
                y0 = y0.min(y);
                x1 = x1.max(x + 1);
                y1 = y1.max(y + 1);
            }
        }
        assert!(x0 != u32::MAX, "nothing was painted");
        (
            x0 as f64 / w as f64,
            y0 as f64 / h as f64,
            x1 as f64 / w as f64,
            y1 as f64 / h as f64,
        )
    }

    /// **B-043, closed.** The same clip transform rendered into two canvases
    /// of very different resolutions — from the *same* decoded layer buffer,
    /// exactly as one decode gets re-used across preview qualities — must put
    /// the picture on the same part of the frame. Before D-136 both halves of
    /// this failed: `position_*` were canvas pixels (so the layer moved) and
    /// `scale` multiplied the decoded buffer (so it resized).
    #[test]
    fn geometry_is_identical_at_every_render_scale() {
        let layer = flat(40, 40, [255, 0, 0, 255]);
        let red = Rgba([255, 0, 0, 255]);
        let t = ClipTransform {
            position_x: 0.1,
            position_y: -0.2,
            scale: 1.5,
            ..identity_transform()
        };

        // "scrub quality": the composition rendered into 100×100, so the
        // layer's natural footprint is 40 px.
        let mut small = flat(100, 100, [0, 0, 0, 255]);
        composite_layer_onto(&mut small, &layer, &t, (40.0, 40.0));

        // "full quality": the same composition into 300×300 — every canvas
        // length ×3, so the natural footprint is ×3 too, while the decoded
        // buffer handed in is byte-for-byte the same one.
        let mut large = flat(300, 300, [0, 0, 0, 255]);
        composite_layer_onto(&mut large, &layer, &t, (120.0, 120.0));

        let a = painted_fraction(&small, red);
        let b = painted_fraction(&large, red);
        let close = |x: f64, y: f64| (x - y).abs() < 0.01;
        assert!(
            close(a.0, b.0) && close(a.1, b.1) && close(a.2, b.2) && close(a.3, b.3),
            "same transform, different render scale: {a:?} vs {b:?}"
        );
        // and it's the right place, not just consistently the wrong one:
        // 1.5× of a 40 %-wide layer = 60 %, centred then nudged +10 % / −20 %.
        assert!(close(a.0, 0.30) && close(a.2, 0.90), "x span {a:?}");
        assert!(close(a.1, 0.00) && close(a.3, 0.60), "y span {a:?}");
    }

    /// A layer whose source is smaller than the composition sits in the frame
    /// at that ratio — `scale: 1.0` means "its own size in the composition",
    /// not "fill the canvas". The pre-D-136 compositor could not express this
    /// at all: it resized the *decoded* buffer, which `scale_target` leaves
    /// untouched whenever the source already fits under the preview cap, so a
    /// small source silently became full-frame.
    #[test]
    fn a_sub_composition_layer_keeps_its_relative_size() {
        let layer = flat(64, 36, [0, 200, 255, 255]);
        let mut canvas = flat(192, 108, [0, 0, 0, 255]);
        // a 64×36 source in a 192×108 composition, canvas at 1:1 → a third.
        composite_layer_onto(&mut canvas, &layer, &identity_transform(), (64.0, 36.0));
        let (x0, y0, x1, y1) = painted_fraction(&canvas, Rgba([0, 200, 255, 255]));
        assert!((x1 - x0 - 1.0 / 3.0).abs() < 0.01, "width {}", x1 - x0);
        assert!((y1 - y0 - 1.0 / 3.0).abs() < 0.01, "height {}", y1 - y0);
        // centred, since `position_*` are zero
        assert!((x0 - 1.0 / 3.0).abs() < 0.01 && (y0 - 1.0 / 3.0).abs() < 0.01);
    }

    /// `position_x` is a fraction of the **width** and `position_y` of the
    /// **height** — the same per-axis convention the crop insets use. On a
    /// deliberately non-square canvas the two must therefore land different
    /// pixel distances for the same numeric value.
    #[test]
    fn position_is_normalised_per_axis() {
        let layer = flat(2, 2, [255, 255, 255, 255]);
        let mut canvas = flat(200, 100, [0, 0, 0, 255]);
        let t = ClipTransform { position_x: 0.25, position_y: 0.25, ..identity_transform() };
        composite_layer_onto(&mut canvas, &layer, &t, (2.0, 2.0));
        // centre (100,50) → top-left (99,49), + 0.25 × 200 = +50 px in x,
        // + 0.25 × 100 = +25 px in y → the 2×2 covers (149,74)-(150,75).
        assert_eq!(*canvas.get_pixel(149, 74), Rgba([255, 255, 255, 255]));
        assert_eq!(*canvas.get_pixel(149, 99), Rgba([0, 0, 0, 255]));
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
        let layer = flat(4, 4, [255, 255, 255, 255]);
        composite_layer_onto(&mut canvas, &layer, &t, natural_of(&layer));
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
        composite_layer_onto(&mut canvas, &layer, &t, natural_of(&layer));
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
        composite_layer_onto(&mut canvas, &layer, &t, natural_of(&layer));
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
        composite_layer_onto(&mut canvas, &layer, &t, natural_of(&layer));
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
        composite_layer_onto(&mut with_zero_insets, &layer, &identity_transform(), natural_of(&layer));
        let mut with_negative_insets = flat(10, 10, [0, 0, 0, 255]);
        let t = ClipTransform { crop_left: -1.0, crop_bottom: -1.0, ..identity_transform() };
        composite_layer_onto(&mut with_negative_insets, &layer, &t, natural_of(&layer));
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

    // ----------------------------------------------------------------- //
    // D-209 — text/title clips
    // ----------------------------------------------------------------- //

    fn text_clip(content: &str) -> Clip {
        Clip {
            id: "t".into(),
            name: "Title".into(),
            duration: 48,
            source_len: 48,
            text: Some(chroma_timeline::TextLayer {
                content: content.into(),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    /// The Phase 1 boundary, enforced at the compositor: a text clip's
    /// opacity, fade and position are honoured; scale/rotation/crop/box are
    /// pinned to identity because `drawtext` (the export path) cannot
    /// reproduce them. See `resolve_text_clip_transform`'s own doc.
    #[test]
    fn a_text_clips_transform_keeps_position_and_opacity_and_drops_the_rest() {
        let clip = Clip {
            opacity: 0.4,
            position_x: 0.25,
            position_y: -0.1,
            scale: 3.0,
            rotation: 45.0,
            crop_left: 0.3,
            crop_bottom: 0.2,
            box_width: Some(0.5),
            box_height: Some(0.5),
            ..text_clip("AFTER")
        };
        let t = resolve_text_clip_transform(&clip, 0);
        assert_eq!(t.opacity, 0.4);
        assert_eq!(t.position_x, 0.25);
        assert_eq!(t.position_y, -0.1);
        assert_eq!(t.scale, 1.0);
        assert_eq!(t.rotation, 0.0);
        assert_eq!(t.crop_left, 0.0);
        assert_eq!(t.crop_bottom, 0.0);
        assert_eq!(t.box_width, None);
        assert_eq!(t.box_height, None);
    }

    /// A text clip's own keyframed position and its fade both still resolve —
    /// the two things Phase 1 promises are animatable — through exactly the
    /// same D-034 engine and D-147 multiply a media clip uses.
    #[test]
    fn a_text_clips_position_keyframes_and_fade_still_resolve() {
        let clip = Clip {
            chroma_keyframes: Some(serde_json::json!([
                { "frame": 0,  "params": { "position_x": 0.0 } },
                { "frame": 10, "params": { "position_x": 0.5 } },
            ])),
            fade_in_frames: 10,
            ..text_clip("AFTER")
        };
        assert!((resolve_text_clip_transform(&clip, 5).position_x - 0.25).abs() < 1e-9);
        assert!((resolve_text_clip_transform(&clip, 10).position_x - 0.5).abs() < 1e-9);
        // Fade-in: half opacity halfway through a 10-frame linear ramp.
        let faded = resolve_text_clip_transform(&clip, 5).opacity;
        assert!((faded - 0.5).abs() < 1e-6, "fade multiplier was {faded}");
        assert!((resolve_text_clip_transform(&clip, 0).opacity).abs() < 1e-9);
    }

    /// The lone-layer fast path decodes `source_path` — a text clip has none,
    /// so it must never be eligible for it (it would be a decode of "").
    #[test]
    fn a_lone_text_clip_never_takes_the_plain_decode_fast_path() {
        let clip = text_clip("AFTER");
        // Its transform IS identity — which is exactly why the fast-path
        // guard cannot be `is_identity()` alone for a text clip.
        assert!(resolve_clip_transform(&clip, 0).is_identity());
        assert!(clip.is_text());
        assert!(clip.source_path.is_empty());
    }

    /// A text layer really does composite onto a frame: white text over a
    /// black backdrop leaves lit pixels where the glyphs are and untouched
    /// black everywhere else. The same alpha-over path a video layer takes —
    /// `composite_layer_onto`, unchanged by D-209.
    #[test]
    fn a_rendered_text_layer_composites_over_the_frame_beneath_it() {
        const W: u32 = 320;
        const H: u32 = 180;
        let mut canvas: image::RgbaImage = ImageBuffer::from_pixel(W, H, Rgba([0, 0, 0, 255]));
        let layer = super::text::render_text_layer(
            &chroma_timeline::TextLayer {
                content: "III".into(),
                ..Default::default()
            },
            W,
            H,
        )
        .expect("rasterise");
        composite_layer_onto(
            &mut canvas,
            &layer,
            &identity_transform(),
            (W as f64, H as f64),
        );

        let lit = canvas.pixels().filter(|p| p[0] > 200).count();
        assert!(lit > 20, "expected real white glyph pixels, got {lit}");
        // The corners are nowhere near centred text — still pure black.
        for (x, y) in [(0, 0), (W - 1, 0), (0, H - 1), (W - 1, H - 1)] {
            assert_eq!(canvas.get_pixel(x, y).0, [0, 0, 0, 255]);
        }
    }
}

/// D-209 — the text/title clip's **live-preview path, end to end**: a real
/// `.chroma` project on disk, a real video source, and the actual
/// [`timeline_frame`] command the preview pane calls over IPC — resolve the
/// visible layers, rasterise the title, composite, JPEG-encode — with the
/// returned data-URL decoded back to pixels and checked.
///
/// Kept out of the pure `composite_tests` module above for the same reason
/// `preview_throughput_tests` is: it needs real `ffmpeg` on PATH and writes
/// real files. Skipped (not failed) without ffmpeg, matching the posture
/// `packages/editor/src/timelineExportText.ffmpeg.test.ts` takes on the
/// export side — the two files together are what make "the preview matches
/// the export" a checked claim rather than an assertion.
#[cfg(test)]
mod preview_text_tests {
    use base64::Engine as _;
    use chroma_timeline::{Clip, TextLayer, Timeline, Track, TrackKind};

    const W: u32 = 320;
    const H: u32 = 180;

    use super::super::PROJECT_STATE_LOCK;

    fn have_ffmpeg() -> bool {
        std::process::Command::new("ffmpeg")
            .arg("-version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    }

    /// A flat black clip, so any lit pixel in the composited frame is the
    /// title and nothing else.
    fn black_clip(path: &std::path::Path) {
        let ok = std::process::Command::new("ffmpeg")
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                &format!("color=black:size={W}x{H}:rate=24:duration=2"),
                "-pix_fmt",
                "yuv420p",
            ])
            .arg(path)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .expect("spawn ffmpeg");
        assert!(ok.success(), "generating the black fixture clip failed");
    }

    /// A project with a title on track 0 (topmost = drawn last, over
    /// everything) and the black source on track 1 — exactly the layout the
    /// Add-title button and `editor_add_text_clip` both produce.
    fn open_title_project(video: &std::path::Path) -> tempfile::TempDir {
        let tmp = tempfile::tempdir().expect("tempdir");
        let project_dir = tmp.path().join("Titles.chroma");
        std::fs::create_dir_all(&project_dir).expect("mkdir project dir");

        let title = Clip {
            id: "title".into(),
            name: "AFTER".into(),
            duration: 48,
            source_len: 48,
            start_frame: 0,
            text: Some(TextLayer {
                content: "AFTER".into(),
                ..Default::default()
            }),
            ..Default::default()
        };
        let under = Clip {
            id: "under".into(),
            name: "under".into(),
            source_path: video.to_string_lossy().into_owned(),
            source_start: 0,
            duration: 48,
            source_len: 48,
            start_frame: 0,
            ..Default::default()
        };

        // An explicit composition size, so `composition_size` never has to
        // fall back to probing a clip — the title has no source to probe.
        let settings = super::project::ProjectSettings {
            width: Some(W),
            height: Some(H),
            ..Default::default()
        };

        let manifest = super::project::ProjectManifest {
            schema: "chroma.project/1".into(),
            name: "Titles".into(),
            created: String::new(),
            modified: String::new(),
            shots: Vec::new(),
            active_shot: 0,
            active_clip_id: None,
            settings,
            timelines: vec![Timeline {
                id: "tl1".into(),
                name: "Titles".into(),
                rate: None,
                tracks: vec![
                    Track {
                        kind: TrackKind::Video,
                        clips: vec![title],
                        ..Default::default()
                    },
                    Track {
                        kind: TrackKind::Video,
                        clips: vec![under],
                        ..Default::default()
                    },
                ],
            }],
            active_timeline: 0,
            media: Vec::new(),
            folders: Vec::new(),
        };
        super::project::save_manifest(&project_dir, &manifest).expect("save manifest");
        super::state::set_project(Some(super::state::ProjectRef {
            path: project_dir,
            name: "Titles".into(),
        }));
        tmp
    }

    /// `timeline_frame`'s `data:image/jpeg;base64,…` return value, decoded
    /// back to real pixels — the same bytes the preview `<img>` would show.
    fn decode_preview(data_url: &str) -> image::RgbaImage {
        let b64 = data_url
            .strip_prefix("data:image/jpeg;base64,")
            .expect("a jpeg data URL");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .expect("base64");
        image::load_from_memory(&bytes).expect("decode jpeg").to_rgba8()
    }

    /// The whole point of D-209, checked through the real command: a title
    /// clip's text is actually painted into the preview frame, over the video
    /// beneath it, and nowhere it shouldn't be.
    #[test]
    fn a_title_clip_really_renders_text_into_the_preview_frame() {
        if !have_ffmpeg() {
            eprintln!("skip: ffmpeg not on PATH");
            return;
        }
        // Held for the whole body — see `PROJECT_STATE_LOCK`. `unwrap_or_else`
        // on the poison rather than `expect`: a panic in the sibling test must
        // not turn into a second, misleading failure here.
        let _guard = PROJECT_STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().expect("tempdir");
        let video = tmp.path().join("black.mp4");
        black_clip(&video);
        let _project = open_title_project(&video);
        super::decode_pipe::reset();

        let frame = decode_preview(&super::timeline_frame(12, Some(W)).expect("preview frame"));
        assert_eq!(frame.dimensions(), (W, H));

        // Real, bright glyph pixels — and the ink's bounding box centred, the
        // same rule `chroma::text`'s own rasteriser test and the export's
        // pixel test both check against.
        let (mut x0, mut y0, mut x1, mut y1, mut lit) = (W, H, 0u32, 0u32, 0usize);
        for (x, y, p) in frame.enumerate_pixels() {
            if p[0] > 180 && p[1] > 180 && p[2] > 180 {
                lit += 1;
                x0 = x0.min(x);
                y0 = y0.min(y);
                x1 = x1.max(x + 1);
                y1 = y1.max(y + 1);
            }
        }
        assert!(lit > 50, "expected real white glyph pixels in the preview, got {lit}");
        let cx = (x0 + x1) as f64 / 2.0;
        let cy = (y0 + y1) as f64 / 2.0;
        // Printed (visible under `--nocapture`) so a preview/export parity
        // check can be read as real numbers, not only as a shared tolerance —
        // the export side's equivalent is
        // `timelineExportText.ffmpeg.test.ts`'s own ink measurement.
        eprintln!(
            "preview ink=[{x0},{y0}..{x1},{y1}] w={} h={} centre=({cx:.1}, {cy:.1}) lit={lit}",
            x1 - x0,
            y1 - y0
        );
        assert!((cx - W as f64 / 2.0).abs() <= 4.0, "title not centred, cx={cx}");
        assert!((cy - H as f64 / 2.0).abs() <= 4.0, "title not centred, cy={cy}");

        // The corners are black video, untouched by the title. JPEG at q80 is
        // lossy, so this is "still dark", not "exactly 0".
        for (x, y) in [(2, 2), (W - 3, 2), (2, H - 3), (W - 3, H - 3)] {
            let p = frame.get_pixel(x, y);
            assert!(p[0] < 60, "corner ({x},{y}) should still be the black clip, got {p:?}");
        }
    }

    /// `position_x`/`position_y` really move the title in the preview — the
    /// half of the transform Phase 1 supports, through the same
    /// `composite_layer_onto` offset a video layer uses.
    #[test]
    fn a_titles_position_offset_really_moves_it_in_the_preview() {
        if !have_ffmpeg() {
            eprintln!("skip: ffmpeg not on PATH");
            return;
        }
        // Held for the whole body — see `PROJECT_STATE_LOCK`. `unwrap_or_else`
        // on the poison rather than `expect`: a panic in the sibling test must
        // not turn into a second, misleading failure here.
        let _guard = PROJECT_STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().expect("tempdir");
        let video = tmp.path().join("black.mp4");
        black_clip(&video);
        let project = open_title_project(&video);
        super::decode_pipe::reset();

        let centre_x = |frame: &image::RgbaImage| -> f64 {
            let (mut x0, mut x1) = (W, 0u32);
            for (x, _, p) in frame.enumerate_pixels() {
                if p[0] > 180 && p[1] > 180 && p[2] > 180 {
                    x0 = x0.min(x);
                    x1 = x1.max(x + 1);
                }
            }
            assert!(x1 > x0, "no ink found");
            (x0 + x1) as f64 / 2.0
        };

        let centred = centre_x(&decode_preview(
            &super::timeline_frame(12, Some(W)).expect("frame"),
        ));

        // Shift the title a quarter of the frame to the right and re-render
        // through the same command.
        let mut tl = super::resolve_timeline(false).expect("timeline");
        tl.tracks[0].clips[0].position_x = 0.25;
        super::chroma_timeline_set(tl).expect("persist");
        let _ = &project; // keep the project dir alive for the second render
        let shifted = centre_x(&decode_preview(
            &super::timeline_frame(12, Some(W)).expect("frame"),
        ));

        let moved = shifted - centred;
        assert!(
            (moved - 0.25 * W as f64).abs() <= 4.0,
            "expected the title to move ~{}px right, it moved {moved}px",
            0.25 * W as f64
        );
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
                ..Default::default()
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
        // Held for the whole body — see `PROJECT_STATE_LOCK`. These two tests
        // were already sharing process-global project state with each other
        // and, as of D-209, with `preview_text_tests` too.
        let _guard = super::super::PROJECT_STATE_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
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
        // Held for the whole body — see `PROJECT_STATE_LOCK`. These two tests
        // were already sharing process-global project state with each other
        // and, as of D-209, with `preview_text_tests` too.
        let _guard = super::super::PROJECT_STATE_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
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

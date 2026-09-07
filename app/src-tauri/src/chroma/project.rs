//! Tauri command bridge for the `.chroma` project (D-037/D-038) — the app-side
//! half of the D-148 `chroma-project` extraction
//! (`docs/notes/crate-extraction-plan.md` §2.3).
//!
//! What it is: `open_manifest` (manifest -> the D-033 `Session`) plus the 20
//!   `#[tauri::command]`s the launcher, the Colorist shot strip and the
//!   Sources panel call. These stay here for the hardest of the D-141 §1
//!   reasons: **every one of them takes `tauri::State<'_, AppState>`**, and
//!   `AppState` lives in `app/src-tauri/src/app_state.rs`. A crate hosting
//!   them would have to depend on the app crate — a cycle.
//! What it does: bind the crate's pure functions to the process globals a
//!   command has and a crate must not — `chroma::state` (which project /
//!   session / video is current) and `chroma::load` (push a decoded frame
//!   into RapidRAW's image pipeline) — and translate to/from the frontend
//!   DTOs (`ProjectOpenDto`, `ProjectShotDto`, `MediaItemDto`).
//! What it does NOT do: any of the model. The manifest, its schema
//!   migrations, the media pool + bins, the D-070 unified clip identity, the
//!   grade-file migration and the timeline lifecycle are all
//!   [`chroma_project`] now. The glob re-export below keeps every one of them
//!   nameable at this module's old path, so `chroma::edit`, `chroma::audio`,
//!   `chroma::export` and this file's own commands did not change.
//!
//! Fork hygiene (D-003): all new code; upstream footprint is `pub mod project;`
//!   in `chroma/mod.rs` + the 20 `generate_handler!` lines in `lib.rs`.

use std::path::{Path, PathBuf};

use base64::Engine as _;
use serde::Serialize;
use serde_json::Value;
use tauri::Emitter;

use crate::app_state::AppState;

use super::state::{self, ProjectRef};
use super::{load, video};

/// The whole project model, re-exported at its historical path (D-141 §1's
/// shim rule) so no call site outside this slice had to change. Deleted in
/// the wave-4 sweep, when every caller is retargeted at `chroma_project::`.
pub use chroma_project::*;

// --------------------------------------------------------------------------- //
// open  (manifest -> the D-033 Session)
// --------------------------------------------------------------------------- //

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectShotDto {
    pub id: String,
    pub source_path: String,
    pub name: String,
    pub frame: u64,
    /// the source path does not exist (or is not a video) — "media offline"
    pub offline: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectOpenDto {
    pub project_path: String,
    pub name: String,
    /// `<project_path>/grades` — where each shot's `<id>.grade.json` lives
    pub grade_dir: String,
    pub schema: String,
    /// every shot, in manifest order, with `offline` flagged
    pub shots: Vec<ProjectShotDto>,
    /// index into `shots` (manifest order) of the active shot
    pub active_shot: usize,
    /// per-project output spec (D-038); all fields optional, absent = clip-derived
    pub settings: ProjectSettings,
}

/// D-070: `manifest.shots` (legacy `ProjectShot`) is no longer where
/// Colorist's shot strip comes from — see the module doc's "Unified clip
/// identity" section. This function is the one integration point tying
/// together `chroma::edit::ensure_timeline` (build a timeline from legacy
/// shots on a project's very first open, same fallback `chroma_timeline_get`
/// always had), [`migrate_shot_grades_to_clips`] (one-time grade-file
/// rename), and [`active_timeline_video_clips`]/[`resolve_active_clip_index`]
/// (source the DTO from the active timeline's clips). Not unit-tested
/// directly (needs a real `tauri::State`, same as every other state-taking
/// command in this module) — its pieces each have real unit tests of their
/// own, and the whole path is verified against the owner's actual
/// `~/Movies/Chroma/New.chroma` project (see `docs/08-decisions.md`'s D-070).
async fn open_manifest(
    project_dir: PathBuf,
    manifest: ProjectManifest,
    state: &tauri::State<'_, AppState>,
) -> Result<ProjectOpenDto, String> {
    // start from a clean session — a project open replaces whatever was loaded
    state::set_current_video(None);

    let mut manifest = super::edit::ensure_timeline(&project_dir, manifest, true)?;

    let grade_dir = project_dir.join("grades");
    let migration = migrate_shot_grades_to_clips(&manifest, &grade_dir);
    for w in &migration.warnings {
        log::warn!("[chroma::project] grade migration: {w}");
    }
    if migration.migrated > 0 || !migration.warnings.is_empty() {
        log::info!(
            "[chroma::project] grade migration: {} file(s) migrated, {} warning(s)",
            migration.migrated,
            migration.warnings.len()
        );
    }

    let clips = active_timeline_video_clips(&manifest);
    // D-056/D-070: the candidate clip (persisted active_clip_id, or the
    // legacy active_shot fallback) is re-resolved through the same top-wins
    // function the preview path uses — see `top_wins_clip_index`'s doc.
    let candidate_shot = resolve_active_clip_index(&manifest, &clips);
    let active_shot = top_wins_clip_index(&manifest, &clips, candidate_shot);

    let mut online_paths: Vec<PathBuf> = Vec::new();
    let mut dtos: Vec<ProjectShotDto> = Vec::with_capacity(clips.len());

    for clip in &clips {
        let source_path = clip.source_path.clone();
        let name = if clip.name.trim().is_empty() {
            "(unnamed)".to_string()
        } else {
            clip.name.clone()
        };
        let online = !source_path.is_empty() && media_item_is_online(&source_path);
        let frame = clip.source_start.max(0) as u64;

        if online {
            let src = PathBuf::from(&source_path);
            // D-129 — probe-and-register, not decode. See
            // `load::register_video_shot` for why this loop never needed the
            // pixels it used to pay ~1.9s per 4K clip for.
            match load::register_video_shot(&src, frame) {
                Ok(()) => online_paths.push(src),
                Err(e) => {
                    log::warn!("[chroma::project] clip {source_path} failed to load: {e}");
                    dtos.push(ProjectShotDto {
                        id: clip.id.clone(),
                        source_path,
                        name,
                        frame,
                        offline: true,
                    });
                    continue;
                }
            }
        }

        dtos.push(ProjectShotDto {
            id: clip.id.clone(),
            source_path,
            name,
            frame,
            offline: !online,
        });
    }

    // put the active clip in front on the canvas (if it's online)
    if !online_paths.is_empty() {
        let want = clips
            .get(active_shot)
            .map(|c| PathBuf::from(&c.source_path));
        // B-030: `online_paths` is pushed once per *clip* (this loop, above) —
        // it is NOT deduplicated by path. The decode session (`state::
        // set_current_video` -> `Session::upsert`) IS deduplicated by path: two
        // clips referencing the same source file collapse into one session
        // shot. Looking up `want`'s position in `online_paths` (the raw,
        // non-deduped list) and feeding that straight into
        // `state::session_set_active` used to assume the two lists' index
        // spaces matched — true only when no two clips share a source path.
        // Now that clips can legitimately overlap/repeat a source across
        // tracks (D-088's real multi-layer compositor), a duplicate earlier in
        // `clips` inflates every later raw index past where that path's shot
        // actually lands in the deduped session, and `session_set_active`
        // rejects the out-of-range index — aborting the whole project open
        // *before* `state::set_project` ever runs, which is why the frontend
        // never saw a project open at all (found live, chasing a real "click
        // does nothing" report against the owner's own project, which had
        // picked up a repeated source path through tonight's NLE work).
        // Fixed by resolving the index in the session's own (deduped) space —
        // `state::resolve_session_index_for_path`, the same helper the resync
        // path below already used (this call site was the one that hadn't
        // caught up), now unit-tested directly in `state.rs`.
        let (session_shots, _) = state::session_shots();
        let active_online = want
            .and_then(|w| state::resolve_session_index_for_path(&session_shots, &w))
            .unwrap_or(0);
        state::session_set_active(active_online)?;
        let frame = state::current_video().map(|c| c.frame).unwrap_or(0);
        let _ = super::commands::seek_and_install(frame, None, state).await;
    }

    // persist the resolved active clip id so it's stable on the next open,
    // independent of the (now-frozen) legacy `active_shot` fallback.
    manifest.active_clip_id = clips.get(active_shot).map(|c| c.id.clone());
    manifest.modified = now_rfc3339();
    save_manifest(&project_dir, &manifest)?;

    state::set_project(Some(ProjectRef {
        path: project_dir.clone(),
        name: manifest.name.clone(),
    }));

    Ok(ProjectOpenDto {
        project_path: project_dir.to_string_lossy().to_string(),
        name: manifest.name.clone(),
        grade_dir: grade_dir.to_string_lossy().to_string(),
        schema: manifest.schema.clone(),
        shots: dtos,
        active_shot,
        settings: manifest.settings.clone(),
    })
}

/// D-071 — a lighter re-sync than a full [`chroma_project_open`], for
/// Colorist to call when its tab gains focus. The Edit tab's timeline
/// (`chroma_timeline_set`, `chroma::edit`) never calls [`open_manifest`], so
/// nothing told Colorist a clip was added or removed until a full project
/// reopen — confirmed live: a clip dragged onto the Edit tab's timeline
/// never appeared in the Colorist shot strip, and a clip removed from the
/// timeline kept showing there forever as a "ghost" shot, since nothing
/// ever pruned `state::Session` except a full reset on a full open.
///
/// This re-reads the manifest fresh (the Edit tab already persisted its
/// change there via `chroma_timeline_set`), diffs the active timeline's
/// clips against what's actually decoded in `state::Session`, and:
/// - decodes + upserts any clip that's genuinely new;
/// - prunes any session shot whose clip is no longer on the active
///   timeline at all — the ghost-shot fix;
/// - **leaves the currently-active session shot exactly as it is if it's
///   still on the timeline** — no re-pick, no re-seek, no thumb/decode-pipe
///   reset. This is the whole reason this isn't just "call
///   `chroma_project_open` again": that would re-run
///   `resolve_active_clip_index`/`top_wins_clip_index` unconditionally and
///   silently reset whichever clip the owner had manually selected in the
///   Colorist shot strip back to the top-wins/legacy default, discarding a
///   real in-progress grading choice.
///
/// Only re-resolves (and persists) a new `active_clip_id` if the
/// previously-active clip was one of the pruned ones.
#[tauri::command]
pub async fn chroma_project_resync_clips(
    state: tauri::State<'_, AppState>,
) -> Result<ProjectOpenDto, String> {
    let dir = require_open_project()?;
    let manifest = load_manifest(&dir)?;
    let mut manifest = super::edit::ensure_timeline(&dir, manifest, false)?;
    let grade_dir = dir.join("grades");

    let clips = active_timeline_video_clips(&manifest);
    let clip_paths: std::collections::HashSet<PathBuf> = clips
        .iter()
        .filter(|c| !c.source_path.is_empty())
        .map(|c| PathBuf::from(&c.source_path))
        .collect();

    let (session_shots_before, session_active_before) = state::session_shots();
    let active_path_before = session_shots_before
        .get(session_active_before)
        .map(|s| s.path.clone());

    let dropped = state::prune_session_except(&clip_paths);
    if !dropped.is_empty() {
        log::info!(
            "[chroma::project] resync: dropped {} stale session shot(s) no longer on the active timeline: {:?}",
            dropped.len(),
            dropped
        );
    }

    let (session_shots_after, _) = state::session_shots();
    let known_paths: std::collections::HashSet<PathBuf> =
        session_shots_after.iter().map(|s| s.path.clone()).collect();

    let mut dtos: Vec<ProjectShotDto> = Vec::with_capacity(clips.len());
    for clip in &clips {
        let source_path = clip.source_path.clone();
        let name = if clip.name.trim().is_empty() {
            "(unnamed)".to_string()
        } else {
            clip.name.clone()
        };
        let online = !source_path.is_empty() && media_item_is_online(&source_path);
        let frame = clip.source_start.max(0) as u64;

        if online {
            let src = PathBuf::from(&source_path);
            if !known_paths.contains(&src) {
                // genuinely new — probe it in (D-129: registration only,
                // no decode). Upserts into the session; does not disturb
                // whichever shot is currently active unless this path
                // happens to already be it (a re-add) — which is now true of
                // `AppState.original_image` too, where the old decoding
                // version silently overwrote the active clip's pixels.
                if let Err(e) = load::register_video_shot(&src, frame) {
                    log::warn!("[chroma::project] resync: clip {source_path} failed to load: {e}");
                    dtos.push(ProjectShotDto {
                        id: clip.id.clone(),
                        source_path,
                        name,
                        frame,
                        offline: true,
                    });
                    continue;
                }
            }
        }

        dtos.push(ProjectShotDto {
            id: clip.id.clone(),
            source_path,
            name,
            frame,
            offline: !online,
        });
    }

    // Only re-resolve the active clip if the one active *before* this
    // resync is no longer on the timeline at all — otherwise its own
    // position in `clips`/`dtos` is its index, untouched.
    let active_still_on_timeline = active_path_before
        .as_ref()
        .is_some_and(|p| clip_paths.contains(p));
    let active_shot = if active_still_on_timeline {
        let p = active_path_before.expect("checked Some above");
        clips
            .iter()
            .position(|c| PathBuf::from(&c.source_path) == p)
            .unwrap_or(0)
    } else {
        let candidate = resolve_active_clip_index(&manifest, &clips);
        let idx = top_wins_clip_index(&manifest, &clips, candidate);
        let want = clips.get(idx).map(|c| PathBuf::from(&c.source_path));
        let (shots_now, _) = state::session_shots();
        // B-030: same deduplicated-session lookup `open_manifest` now uses
        // too — this call site already had it right; extracted to
        // `state::resolve_session_index_for_path` so both share one
        // unit-tested implementation instead of two inline copies.
        if let Some(i) = want.and_then(|w| state::resolve_session_index_for_path(&shots_now, &w)) {
            let _ = state::session_set_active(i);
            let frame = state::current_video().map(|c| c.frame).unwrap_or(0);
            let _ = super::commands::seek_and_install(frame, None, &state).await;
        }
        manifest.active_clip_id = clips.get(idx).map(|c| c.id.clone());
        manifest.modified = now_rfc3339();
        save_manifest(&dir, &manifest)?;
        idx
    };

    Ok(ProjectOpenDto {
        project_path: dir.to_string_lossy().to_string(),
        name: manifest.name.clone(),
        grade_dir: grade_dir.to_string_lossy().to_string(),
        schema: manifest.schema.clone(),
        shots: dtos,
        active_shot,
        settings: manifest.settings.clone(),
    })
}

// --------------------------------------------------------------------------- //
// save  (the live session -> the manifest + thumb)
// --------------------------------------------------------------------------- //

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSaveDto {
    pub project_path: String,
    pub name: String,
    pub modified: String,
    pub thumb_regenerated: bool,
}

fn regen_thumb(project_dir: &Path) -> bool {
    let Some(cv) = state::current_video() else {
        return false;
    };
    match video::extract_thumb(&cv.path, &cv.info, cv.frame, 360) {
        Ok(data_url) => {
            let b64 = data_url
                .rsplit_once(',')
                .map(|(_, b)| b)
                .unwrap_or(&data_url);
            match base64::engine::general_purpose::STANDARD.decode(b64.trim()) {
                Ok(bytes) => std::fs::write(project_dir.join("thumb.jpg"), bytes).is_ok(),
                Err(_) => false,
            }
        }
        Err(e) => {
            log::warn!("[chroma::project] thumb regen failed: {e}");
            false
        }
    }
}

// --------------------------------------------------------------------------- //
// tauri commands
// --------------------------------------------------------------------------- //

#[tauri::command]
pub fn chroma_project_list() -> Vec<ProjectSummary> {
    list_projects_in(&projects_dir())
}

#[tauri::command]
pub fn chroma_project_settings_dir() -> String {
    projects_dir().to_string_lossy().to_string()
}

#[tauri::command]
pub fn chroma_project_set_dir(dir: String) -> Result<String, String> {
    let trimmed = dir.trim();
    if trimmed.is_empty() {
        return Err("projects folder path is empty".into());
    }
    set_projects_dir(trimmed)?;
    Ok(projects_dir().to_string_lossy().to_string())
}

/// The launcher's own delete button (a hover-revealed trash icon on a
/// project card) — irreversible, `chroma_project::manifest::delete_project_at`
/// does the actual `remove_dir_all` plus its own real-project validation.
/// Refuses to delete whichever project is CURRENTLY open (`state::current_
/// project()`) — the launcher itself is only ever shown with no project
/// open, so this should never actually trigger in normal use, but a stray
/// call (e.g. a second window, a future caller) must not be able to pull a
/// project's directory out from under a live session that still autosaves
/// to it.
#[tauri::command]
pub fn chroma_project_delete(path: String) -> Result<(), String> {
    let dir = PathBuf::from(&path);
    if let Some(current) = state::current_project() {
        if current.path == dir {
            return Err("cannot delete the currently open project".into());
        }
    }
    delete_project_at(&dir)
}

#[tauri::command]
pub async fn chroma_project_open(
    path: String,
    state: tauri::State<'_, AppState>,
) -> Result<ProjectOpenDto, String> {
    let dir = PathBuf::from(&path);
    let manifest = load_manifest(&dir)?;
    open_manifest(dir, manifest, &state).await
}

#[tauri::command]
pub async fn chroma_project_new(
    name: String,
    media_paths: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<ProjectOpenDto, String> {
    let (dir, manifest) = new_project_in(&projects_dir(), &name, &media_paths)?;
    open_manifest(dir, manifest, &state).await
}

/// D-070: no longer takes a `shots` list — `chroma_timeline::Clip`s are the
/// durable clip list now, persisted separately by `chroma::edit`'s
/// `chroma_timeline_set` (called whenever the Edit-tab timeline actually
/// changes). This command's job shrinks to what the frontend's
/// `saveProject()` genuinely still needs on every debounced autosave tick:
/// persist which clip Colorist is grading (`active_clip_id` — stable across
/// a reorder, unlike the old index-based `active_shot`), touch `modified`,
/// regenerate `thumb.jpg` from whatever frame is currently decoded. Grade
/// files themselves are written separately, straight from the frontend, via
/// `chroma_save_grade` (unchanged).
#[tauri::command]
pub async fn chroma_project_save(
    path: Option<String>,
    active_clip_id: Option<String>,
) -> Result<ProjectSaveDto, String> {
    let dir = path
        .map(PathBuf::from)
        .or_else(|| state::current_project().map(|p| p.path))
        .ok_or("no project loaded — create or open one first")?;

    let mut manifest = load_manifest(&dir).unwrap_or_else(|_| {
        ProjectManifest::fresh(
            &dir.file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default(),
        )
    });
    let now = now_rfc3339();
    if manifest.created.is_empty() {
        manifest.created = now.clone();
    }
    manifest.modified = now.clone();
    if let Some(stem) = dir.file_stem() {
        manifest.name = stem.to_string_lossy().to_string();
    }
    manifest.active_clip_id = active_clip_id;
    save_manifest(&dir, &manifest)?;

    state::set_project(Some(ProjectRef {
        path: dir.clone(),
        name: manifest.name.clone(),
    }));

    let dir2 = dir.clone();
    let thumb_regenerated = tokio::task::spawn_blocking(move || regen_thumb(&dir2))
        .await
        .unwrap_or(false);

    Ok(ProjectSaveDto {
        project_path: dir.to_string_lossy().to_string(),
        name: dir
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default(),
        modified: now,
        thumb_regenerated,
    })
}

/// `{ name, path }` for the loaded project, or `null` for an Untitled session.
/// Backs `get_state().project` so the agent can see where a save would land.
#[tauri::command]
pub fn chroma_project_current() -> Option<Value> {
    state::current_project()
        .map(|p| serde_json::json!({ "name": p.name, "path": p.path.to_string_lossy() }))
}

/// Re-point one clip at a new source path and reopen the project. D-070:
/// operates on the active timeline's `chroma_timeline::Clip` (by id) now,
/// not the retired `ProjectShot` — a clip's `source_path` is its own ground
/// truth (Colorist's shot strip reads it directly), not solely derived
/// through `media_id`/`MediaItem` the way `ProjectShot` used to be, so the
/// old shot-id-keyed version would silently find nothing for any clip that
/// isn't also backed by a legacy shot. If the clip has a `media_id`, the
/// underlying pool item is re-pointed too (so any other clip sharing that
/// `media_id` re-points as a side effect, by design — a relink is "this
/// same logical media now lives here"); a clip with no `media_id` (or a
/// dangling one) gets one via find-or-create at `new_path`. Does **not**
/// touch the clip's trim window (`source_start`/`duration`/`source_len`) —
/// the pre-D-070 version had the same limitation (a probe refresh never
/// reconciled a shot's remembered `frame` either); re-trimming to match a
/// differently-lengthed replacement file is a real, separate follow-up.
#[tauri::command]
pub async fn chroma_project_relink(
    path: Option<String>,
    clip_id: String,
    new_path: String,
    state: tauri::State<'_, AppState>,
) -> Result<ProjectOpenDto, String> {
    let dir = path
        .map(PathBuf::from)
        .or_else(|| state::current_project().map(|p| p.path))
        .ok_or("no project loaded")?;
    let mut manifest = load_manifest(&dir)?;
    let idx = manifest.active_timeline;

    let media_id = manifest
        .timelines
        .get(idx)
        .ok_or("no active timeline")?
        .tracks
        .iter()
        .flat_map(|t| t.clips.iter())
        .find(|c| c.id == clip_id)
        .ok_or_else(|| format!("clip {clip_id} is not on the active timeline"))?
        .media_id
        .clone();

    let resolved_media_id = match media_id
        .as_deref()
        .and_then(|mid| manifest.media.iter().position(|m| m.id == mid))
    {
        Some(pos) => {
            let m = &mut manifest.media[pos];
            m.source_path = new_path.clone();
            m.name = Path::new(&new_path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| new_path.clone());
            m.video = media_item_is_online(&new_path)
                .then(|| video::probe(Path::new(&new_path)).ok())
                .flatten()
                .as_ref()
                .map(MediaVideoInfo::from);
            manifest.media[pos].id.clone()
        }
        None => find_or_create_media(&mut manifest, &new_path, None),
    };

    let name = Path::new(&new_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| new_path.clone());
    let tl = manifest
        .timelines
        .get_mut(idx)
        .ok_or("no active timeline")?;
    for track in &mut tl.tracks {
        if let Some(clip) = track.clips.iter_mut().find(|c| c.id == clip_id) {
            clip.source_path = new_path.clone();
            clip.name = name;
            clip.media_id = Some(resolved_media_id);
            break;
        }
    }

    manifest.modified = now_rfc3339();
    save_manifest(&dir, &manifest)?;
    open_manifest(dir, manifest, &state).await
}

/// Merge a partial output spec (D-038) into the loaded (or given) project's
/// `settings`, save `project.json`, and return the merged [`ProjectSettings`].
///
/// `partial` is `{ width?, height?, fps?, colorSpace? }`: a **present** key is
/// applied, an explicit `null` clears that field (→ clip-derived again), an
/// **absent** key is left as-is. `color_space` is stored + surfaced only — a
/// colour-managed pipeline is D-004, not this.
///
/// B-086: emits `chroma://project-settings-changed` (the merged
/// [`ProjectSettings`] as payload) on every successful write, regardless of
/// caller — `CanvasSettingsPopover.tsx`'s own "Apply" handler used to be the
/// only path that told `useCompositionSize` to refetch (via a hand-bumped
/// `refreshToken`), so a write from anywhere else (the `set_project_settings`
/// MCP tool, any future caller) left `CanvasBoundary`'s displayed composition
/// size stale until an unrelated timeline edit happened to refresh it. A
/// broadcast closes the gap for every caller at once instead of relying on
/// each one to remember a token.
#[tauri::command]
pub fn chroma_project_set_settings(
    path: Option<String>,
    partial: Value,
    app_handle: tauri::AppHandle,
) -> Result<ProjectSettings, String> {
    let dir = path
        .map(PathBuf::from)
        .or_else(|| state::current_project().map(|p| p.path))
        .ok_or("no project loaded — open or create one first")?;
    let mut manifest = load_manifest(&dir)?;
    manifest.settings.merge_patch(&partial);
    manifest.modified = now_rfc3339();
    save_manifest(&dir, &manifest)?;
    let _ = app_handle.emit("chroma://project-settings-changed", &manifest.settings);
    Ok(manifest.settings)
}

/// D-199 (canvas-boundary preview overlay) — the loaded (or given) project's
/// current [`ProjectSettings`], with no mutation. Reads-only symmetric
/// counterpart to [`chroma_project_set_settings`]: `app/src`'s Colorist
/// `ProjectSettingsModal` gets its current values from `useSessionStore`'s
/// own already-loaded manifest state (it never needed a fresh read), but
/// `packages/editor` (the Edit tab) has no such store — a project-settings
/// surface reachable from that tab needs a real, explicit way to fetch the
/// CURRENT values before showing an editable form for them.
#[tauri::command]
pub fn chroma_project_get_settings(path: Option<String>) -> Result<ProjectSettings, String> {
    let dir = path
        .map(PathBuf::from)
        .or_else(|| state::current_project().map(|p| p.path))
        .ok_or("no project loaded — open or create one first")?;
    Ok(load_manifest(&dir)?.settings)
}

// --------------------------------------------------------------------------- //
// media pool tauri commands (D-044)
// --------------------------------------------------------------------------- //

fn require_open_project() -> Result<PathBuf, String> {
    state::current_project()
        .map(|p| p.path)
        .ok_or_else(|| "no project open — create or open one first".to_string())
}

/// Probe + append `paths` to the open project's media pool (referenced in
/// place, never copied), filed into `folder` (D-045 — a bin path such as
/// `"B-roll/Sunset"`, created implicitly; `None`/omitted = the pool root),
/// persist, and return just the newly-added items — a path already in the
/// pool is skipped, not duplicated (its folder is untouched even if a
/// different `folder` was passed this time; use `chroma_media_move` to
/// re-file it). The frontend wires this to a native multi-select file dialog
/// (`@tauri-apps/plugin-dialog`'s `open({ multiple: true })`, same pattern as
/// the project launcher's `pickClips`).
///
/// **`async` + `spawn_blocking` (D-059/B-014).** Probing each path shells out
/// to `ffprobe` (`video::probe`) and now also `ffmpeg` for a thumbnail
/// (`generate_media_thumb`) — real, potentially slow (many files, a network
/// or spinning-disk source) blocking work. A plain (non-`async`) `#[tauri::command]`
/// runs *inline on the main UI thread* (confirmed against `tauri-macros`'
/// `ExecutionContext::Blocking` — the default for a non-`async fn` — which
/// calls the command body directly rather than dispatching it through
/// `respond_async_serialized`/the async runtime); an `async fn` command does
/// not. Wrapping the actual probing in `spawn_blocking` additionally keeps it
/// off the async-runtime's own worker threads (same convention
/// `chroma_frame_thumbnails`/`chroma_session_thumbnail` already use for their
/// `ffmpeg` calls) rather than just moving the blocking off the main thread
/// and onto a runtime thread that other `async fn` commands share.
#[tauri::command]
pub async fn chroma_media_import(
    paths: Vec<String>,
    folder: Option<String>,
) -> Result<Vec<MediaItemDto>, String> {
    if paths.is_empty() {
        return Err("no paths given".into());
    }
    let dir = require_open_project()?;
    let added = tokio::task::spawn_blocking(move || -> Result<Vec<MediaItem>, String> {
        let mut manifest = load_manifest(&dir)?;
        let added = add_media(&mut manifest, &paths, folder.as_deref());
        if !added.is_empty() {
            manifest.modified = now_rfc3339();
            save_manifest(&dir, &manifest)?;
        }
        Ok(added)
    })
    .await
    .map_err(|e| format!("import task panicked: {e}"))??;
    Ok(added.iter().map(MediaItemDto::from).collect())
}

/// Re-file an existing pool item into a different bin path (D-045) — pass
/// `folder: None` (or an empty/blank string) to move it back to the pool
/// root. Naming a not-yet-used path here creates/registers it implicitly,
/// same as `chroma_media_import`'s `folder` arg (D-059: registers into
/// [`ProjectManifest::folders`] too, not just the item's own `folder`).
/// `async` (D-059/B-014) — see [`chroma_media_import`]'s doc for why a
/// manifest-touching command must not be a plain blocking `fn`.
#[tauri::command]
pub async fn chroma_media_move(id: String, folder: Option<String>) -> Result<MediaItemDto, String> {
    let dir = require_open_project()?;
    let mut manifest = load_manifest(&dir)?;
    let item = manifest
        .media
        .iter_mut()
        .find(|m| m.id == id)
        .ok_or_else(|| format!("no media item with id {id}"))?;
    item.folder = normalize_folder(folder.as_deref());
    register_folder(&mut manifest, folder.as_deref());
    let dto = manifest
        .media
        .iter()
        .find(|m| m.id == id)
        .map(MediaItemDto::from)
        .expect("just looked this item up above");
    manifest.modified = now_rfc3339();
    save_manifest(&dir, &manifest)?;
    Ok(dto)
}

/// Remove one or more items from the pool (D-060/D-061) — the Sources panel
/// had no delete action at all until this pass; every item added stayed
/// forever. Takes a batch (`Vec`) rather than a single id, matching
/// [`chroma_media_import`]'s "one round trip, one manifest save" shape,
/// since D-061 added a real multi-select "Delete N" action to the panel —
/// looping a single-id command per selected item would mean one disk write
/// per item instead of one for the whole selection. An id that isn't in the
/// pool (already removed by a concurrent action, a stale selection, etc.)
/// is silently skipped rather than failing the whole batch — unlike
/// [`chroma_media_move`]'s strict "unknown id errors," a bulk delete's ids
/// come from the frontend's own already-rendered list, not user-typed
/// input, so "it's already gone" isn't a real error condition worth
/// aborting a multi-item action over. A shot (`ProjectShot`) already
/// referencing a removed item is deliberately left alone rather than
/// cascade-deleted: [`resolve_shot`]'s existing "dangling reference →
/// offline, not fatal" discipline (the same path a hand-edited manifest
/// already had to handle) covers it, so this command doesn't need its own
/// referential-integrity story. Best-effort removes each cached thumbnail
/// file too (D-059's `thumb_cache_path`) so a re-import under the same path
/// doesn't need to overwrite stale bytes — failure there is silently
/// ignored, same as every other cache-cleanup path in this module (a
/// leftover `.jpg` beside the source is harmless).
#[tauri::command]
pub async fn chroma_media_remove(ids: Vec<String>) -> Result<(), String> {
    let dir = require_open_project()?;
    let mut manifest = load_manifest(&dir)?;
    for id in &ids {
        let Some(idx) = manifest.media.iter().position(|m| &m.id == id) else {
            continue;
        };
        let removed = manifest.media.remove(idx);
        if let Some(cache_path) = thumb_cache_path(&removed.source_path, &removed.id) {
            let _ = std::fs::remove_file(cache_path);
        }
    }
    manifest.modified = now_rfc3339();
    save_manifest(&dir, &manifest)?;
    Ok(())
}

/// Register a new, possibly-still-empty bin path (D-059) — the Sources
/// panel's explicit "New Folder" action. Idempotent (creating an
/// already-known folder is a no-op, not an error) and does not require the
/// folder to hold any items, unlike D-045's original "folders are implied by
/// items' `folder` strings" model (see the D-059 decision for why this small
/// additive list, not a full bin-hierarchy entity, was the right amount of
/// complexity). Returns the full, deduped, sorted folder list — union of
/// `manifest.folders` and every item's `folder` — so the frontend can just
/// replace its tree state, same "return the fresh state" convention
/// `chroma_media_import`/`_move` use.
#[tauri::command]
pub async fn chroma_media_create_folder(path: String) -> Result<Vec<String>, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("folder name is empty".into());
    }
    let dir = require_open_project()?;
    let mut manifest = load_manifest(&dir)?;
    register_folder(&mut manifest, Some(trimmed));
    manifest.modified = now_rfc3339();
    save_manifest(&dir, &manifest)?;
    Ok(all_folders(&manifest))
}

/// Union of [`ProjectManifest::folders`] and every media item's `folder`,
/// deduped + sorted — what the Sources panel's bin tree is actually built
/// from (D-059; items alone were D-045's whole story).
fn all_folders(manifest: &ProjectManifest) -> Vec<String> {
    let mut set: std::collections::BTreeSet<String> = manifest.folders.iter().cloned().collect();
    set.extend(manifest.media.iter().filter_map(|m| m.folder.clone()));
    set.into_iter().collect()
}

/// The open project's known bin paths (D-059) — see [`all_folders`]. A
/// separate command rather than folding into [`chroma_media_list`]'s response
/// so that DTO's wire shape stays untouched (same reasoning D-046 gave for
/// keeping `ProjectShotDto` stable through the shots/media unification).
#[tauri::command]
pub async fn chroma_media_folders() -> Result<Vec<String>, String> {
    let dir = require_open_project()?;
    let manifest = load_manifest(&dir)?;
    Ok(all_folders(&manifest))
}

/// The open project's full media pool, offline-checked live. Each item
/// carries its `folder` (D-045) and cached `thumb` if one exists (D-059); the
/// frontend derives the bin tree from the flat list of folder path strings
/// plus [`chroma_media_folders`] — no separate bin-hierarchy API. `async`
/// (D-059/B-014) — see [`chroma_media_import`]'s doc.
///
/// D-129 — also the one-time home of [`backfill_has_audio`]: any pool item
/// imported before `MediaVideoInfo::has_audio` existed gets probed once here
/// and the answer persisted, so an existing project's media starts producing
/// linked audio halves on drop without needing a manual re-import. Runs on
/// `spawn_blocking` (probing is a subprocess spawn) for the same reason
/// [`chroma_media_import`]'s own doc gives, and writes the manifest only when
/// something actually changed — a project whose items are all resolved
/// already does no I/O beyond the read it was doing anyway.
#[tauri::command]
pub async fn chroma_media_list() -> Result<Vec<MediaItemDto>, String> {
    let dir = require_open_project()?;
    let items = tokio::task::spawn_blocking(move || -> Result<Vec<MediaItem>, String> {
        let mut manifest = load_manifest(&dir)?;
        if backfill_has_audio(&mut manifest) {
            manifest.modified = now_rfc3339();
            save_manifest(&dir, &manifest)?;
        }
        Ok(manifest.media.clone())
    })
    .await
    .map_err(|e| format!("media list task panicked: {e}"))??;
    Ok(items.iter().map(MediaItemDto::from).collect())
}

/// D-070: repurposed — "add to grading" now means "append a clip to the
/// active timeline referencing this pool item," the Colorist-side
/// equivalent of dragging the same Sources-panel card onto the Edit tab's
/// timeline (`@chroma/editor`'s `clipFromDraggedMedia`); it no longer
/// pushes a `ProjectShot` (see the module doc). Ensures a timeline exists
/// first (same lazy-build fallback every other timeline-touching command
/// has). Errors if `media_id` isn't in the pool. The new clip becomes
/// `active_clip_id`; returns the same `ProjectOpenDto` shape
/// `chroma_project_open`/`_new`/`_relink` do, so the frontend hydrates it
/// through the exact same `_hydrateOpenDto` path — this command's own wire
/// signature (`{ mediaId }` in, `ProjectOpenDto` out) is unchanged, so
/// `SourcesPanel.tsx`'s call site needed no update, only its doc comment.
#[tauri::command]
pub async fn chroma_project_add_shot(
    media_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<ProjectOpenDto, String> {
    let dir = require_open_project()?;
    let manifest = load_manifest(&dir)?;
    let mut manifest = super::edit::ensure_timeline(&dir, manifest, false)?;
    let idx = manifest.active_timeline;
    append_media_clip(&mut manifest, idx, &media_id)?;
    manifest.modified = now_rfc3339();
    save_manifest(&dir, &manifest)?;
    open_manifest(dir, manifest, &state).await
}

/// D-070 — the ShotStrip "+" button's project-backed path: probe/pool each
/// of `paths` (find-or-create, same as `chroma_media_import`) and append a
/// full-length clip for each to the active timeline in one round trip,
/// mirroring `chroma_media_import`'s "one batch, one manifest save" shape.
/// The `useSessionStore.addShots` counterpart for an in-memory "Untitled"
/// session (no project) stays a plain `chroma_session_add` — see
/// `useSessionStore.ts`'s doc.
#[tauri::command]
pub async fn chroma_project_add_shot_paths(
    paths: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<ProjectOpenDto, String> {
    if paths.is_empty() {
        return Err("no paths given".into());
    }
    let dir = require_open_project()?;
    let manifest = load_manifest(&dir)?;
    let mut manifest = super::edit::ensure_timeline(&dir, manifest, false)?;
    let idx = manifest.active_timeline;
    for p in &paths {
        let media_id = find_or_create_media(&mut manifest, p, None);
        append_media_clip(&mut manifest, idx, &media_id)?;
    }
    manifest.modified = now_rfc3339();
    save_manifest(&dir, &manifest)?;
    open_manifest(dir, manifest, &state).await
}

/// D-070 — remove one clip (by id) from the active timeline; the ShotStrip
/// "×" button's project-backed path. Errors if no clip with that id is on
/// the active timeline. Does not delete its grade file (see
/// `remove_clip_by_id`'s doc). Returns the fresh `ProjectOpenDto`, same
/// `_hydrateOpenDto` path as every other project-mutating command here.
#[tauri::command]
pub async fn chroma_project_remove_clip(
    clip_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<ProjectOpenDto, String> {
    let dir = require_open_project()?;
    let mut manifest = load_manifest(&dir)?;
    let idx = manifest.active_timeline;
    remove_clip_by_id(&mut manifest, idx, &clip_id)?;
    manifest.modified = now_rfc3339();
    save_manifest(&dir, &manifest)?;
    open_manifest(dir, manifest, &state).await
}

// --------------------------------------------------------------------------- //
// tests — the command surface (state-taking commands end-to-end)
// --------------------------------------------------------------------------- //

#[cfg(test)]
mod tests {
    use super::*;
    // `chroma-timeline` types these tests build directly; the model names
    // them without re-exporting them, so the shim glob above does not.
    use chroma_timeline::{Clip, TrackKind};

    /// `state::set_project` is process-global (D-033/D-037); `cargo test`
    /// runs test fns on multiple threads by default, so any test that
    /// mutates it must hold this for its whole body or it can interleave
    /// with another such test (see `project_ref_set_and_clear`'s original
    /// comment, which this formalises rather than just shrugs at).
    static PROJECT_STATE_LOCK: once_cell::sync::Lazy<std::sync::Mutex<()>> =
        once_cell::sync::Lazy::new(|| std::sync::Mutex::new(()));

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "chroma_project_test_{tag}_{}_{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// synthesise a tiny `testsrc` clip with ffmpeg; `None` if ffmpeg is absent.
    /// `duration_s` (D-059): most callers just need *a* probe-able clip and
    /// pass `1`; the Phase B1 multi-track resolution test needs two clips of
    /// **different** lengths (so a query position can land past one track's
    /// clip but still inside the other's), hence the parameter.
    fn make_test_clip(tag: &str, w: u32, h: u32, rate: &str, duration_s: u32) -> Option<PathBuf> {
        let out =
            std::env::temp_dir().join(format!("chroma_infer_{tag}_{}.mp4", std::process::id()));
        let _ = std::fs::remove_file(&out);
        let status = std::process::Command::new("ffmpeg")
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
            ])
            .arg(format!(
                "testsrc=size={w}x{h}:rate={rate}:duration={duration_s}"
            ))
            .args(["-pix_fmt", "yuv420p"])
            .arg(&out)
            .status()
            .ok()?;
        (status.success() && out.exists()).then_some(out)
    }

    #[test]
    fn media_move_refiles_an_existing_item() {
        let _guard = PROJECT_STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let root = tmp("media_move");
        let (dir, mut manifest) = new_project_in(&root, "media-move", &[]).unwrap();
        let path = root.join("a.mov").to_string_lossy().to_string();
        add_media(&mut manifest, &[path], None);
        let id = manifest.media[0].id.clone();
        save_manifest(&dir, &manifest).unwrap();
        state::set_project(Some(ProjectRef {
            path: dir.clone(),
            name: "media-move".into(),
        }));

        // chroma_media_move is async (D-059/B-014); drive it on a tiny local
        // runtime, same convention `chroma_project_save_attaches_a_new_shot_to_the_pool`
        // uses for `chroma_project_save`.
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();

        let moved = rt
            .block_on(chroma_media_move(id.clone(), Some("Interviews".into())))
            .unwrap();
        assert_eq!(moved.folder.as_deref(), Some("Interviews"));
        let reloaded = load_manifest(&dir).unwrap();
        assert_eq!(reloaded.media[0].folder.as_deref(), Some("Interviews"));
        assert!(
            reloaded.folders.iter().any(|f| f == "Interviews"),
            "moving into a not-yet-known folder registers it (D-059)"
        );

        // moving back to the root clears the folder
        let back = rt.block_on(chroma_media_move(id, None)).unwrap();
        assert_eq!(back.folder, None);

        // an unknown id errors rather than silently no-op-ing
        assert!(
            rt.block_on(chroma_media_move("no-such-id".into(), Some("X".into())))
                .is_err()
        );

        state::set_project(None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn media_remove_deletes_a_batch_and_their_cached_thumbnails() {
        let _guard = PROJECT_STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let root = tmp("media_remove");
        let (dir, mut manifest) = new_project_in(&root, "media-remove", &[]).unwrap();
        let path_a = root.join("a.mov").to_string_lossy().to_string();
        let path_b = root.join("b.mov").to_string_lossy().to_string();
        let path_c = root.join("c.mov").to_string_lossy().to_string();
        add_media(
            &mut manifest,
            &[path_a.clone(), path_b.clone(), path_c.clone()],
            None,
        );
        let id_a = manifest.media[0].id.clone();
        let id_b = manifest.media[1].id.clone();
        let id_c = manifest.media[2].id.clone();
        save_manifest(&dir, &manifest).unwrap();
        state::set_project(Some(ProjectRef {
            path: dir.clone(),
            name: "media-remove".into(),
        }));

        // synthesize fake cached thumbnails for the two items actually being
        // removed, exactly where `thumb_cache_path` says one would live, to
        // prove removal actually cleans them up rather than just orphaning
        // them beside the source.
        let cache_a = thumb_cache_path(&path_a, &id_a).expect("real source path");
        let cache_b = thumb_cache_path(&path_b, &id_b).expect("real source path");
        std::fs::create_dir_all(cache_a.parent().unwrap()).unwrap();
        std::fs::write(&cache_a, b"fake jpeg bytes").unwrap();
        std::fs::write(&cache_b, b"fake jpeg bytes").unwrap();
        assert!(cache_a.exists());
        assert!(cache_b.exists());

        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();

        // a batch delete of [a, b, "no-such-id"] — the stale id must not
        // abort the whole batch (D-061's multi-select "Delete N" sends
        // whatever the panel's current selection is; a race with e.g. a
        // concurrent import/remove shouldn't fail the user's click).
        rt.block_on(chroma_media_remove(vec![
            id_a.clone(),
            id_b.clone(),
            "no-such-id".into(),
        ]))
        .expect("an unknown id in the batch should be skipped, not fail the whole call");

        let reloaded = load_manifest(&dir).unwrap();
        assert_eq!(
            reloaded.media.len(),
            1,
            "only the untouched item should remain"
        );
        assert_eq!(reloaded.media[0].id, id_c);
        assert!(
            !cache_a.exists(),
            "a's cached thumbnail should be cleaned up too"
        );
        assert!(
            !cache_b.exists(),
            "b's cached thumbnail should be cleaned up too"
        );

        state::set_project(None);
        let _ = std::fs::remove_dir_all(&root);
    }

    // --- Sources panel fixes (D-059/B-014) -----------------------------------

    #[test]
    fn chroma_media_create_folder_lists_even_with_zero_items() {
        let _guard = PROJECT_STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let root = tmp("create_folder");
        let (dir, manifest) = new_project_in(&root, "create-folder", &[]).unwrap();
        save_manifest(&dir, &manifest).unwrap();
        state::set_project(Some(ProjectRef {
            path: dir.clone(),
            name: "create-folder".into(),
        }));

        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();

        // create an empty folder — no items reference it yet
        let folders = rt
            .block_on(chroma_media_create_folder("B-roll".into()))
            .unwrap();
        assert_eq!(folders, vec!["B-roll".to_string()]);
        let listed = rt.block_on(chroma_media_folders()).unwrap();
        assert_eq!(
            listed,
            vec!["B-roll".to_string()],
            "an empty folder is listed even though nothing is filed in it"
        );

        // idempotent — creating it again is a no-op, not a duplicate/error
        let again = rt
            .block_on(chroma_media_create_folder("B-roll".into()))
            .unwrap();
        assert_eq!(again, vec!["B-roll".to_string()]);

        // blank/whitespace-only names are rejected
        assert!(
            rt.block_on(chroma_media_create_folder("   ".into()))
                .is_err()
        );

        // importing a real item into it associates it correctly, and the
        // folder is still exactly one entry (no duplicate from the item side)
        let clip = root.join("shot.mov").to_string_lossy().to_string();
        std::fs::write(root.join("shot.mov"), b"not a real video").unwrap();
        let added = rt
            .block_on(chroma_media_import(
                vec![clip.clone()],
                Some("B-roll".into()),
            ))
            .unwrap();
        assert_eq!(added.len(), 1);
        assert_eq!(added[0].folder.as_deref(), Some("B-roll"));
        let final_folders = rt.block_on(chroma_media_folders()).unwrap();
        assert_eq!(final_folders, vec!["B-roll".to_string()]);

        state::set_project(None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn media_import_generates_and_caches_a_real_thumbnail() {
        let _guard = PROJECT_STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let Some(clip) = make_test_clip("thumb", 64, 64, "10", 1) else {
            eprintln!("skipping media_import_generates_and_caches_a_real_thumbnail: no ffmpeg");
            return;
        };
        let root = tmp("media_thumb");
        let (dir, manifest) = new_project_in(&root, "media-thumb", &[]).unwrap();
        save_manifest(&dir, &manifest).unwrap();
        state::set_project(Some(ProjectRef {
            path: dir.clone(),
            name: "media-thumb".into(),
        }));

        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let added = rt
            .block_on(chroma_media_import(
                vec![clip.to_string_lossy().to_string()],
                None,
            ))
            .unwrap();
        assert_eq!(added.len(), 1);
        let item = &added[0];
        assert!(item.video.is_some(), "a real clip probes successfully");
        let thumb = item
            .thumb
            .as_deref()
            .expect("a cached thumbnail data URL is returned for a real, probed clip");
        assert!(
            thumb.starts_with("data:image/jpeg;base64,"),
            "thumb is a JPEG data URL, got: {}",
            &thumb[..thumb.len().min(40)]
        );

        // the cache file this data URL was read from is a real, decodable
        // JPEG — not just "a file exists" (per the ask: verify the bytes).
        let cache_path = thumb_cache_path(&item.source_path, &item.id).unwrap();
        assert!(cache_path.exists(), "thumbnail cached to {cache_path:?}");
        let bytes = std::fs::read(&cache_path).unwrap();
        assert!(!bytes.is_empty());
        let decoded = image::load_from_memory_with_format(&bytes, image::ImageFormat::Jpeg)
            .expect("cached thumbnail bytes decode as a real JPEG frame");
        assert!(
            decoded.width() > 0 && decoded.height() > 0,
            "decoded thumbnail has real dimensions: {}x{}",
            decoded.width(),
            decoded.height()
        );

        // and chroma_media_list re-reads the same cached file live
        let listed = rt.block_on(chroma_media_list()).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].thumb.as_deref(), Some(thumb));

        state::set_project(None);
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_file(&clip);
        if let Some(cache_dir) = cache_path.parent() {
            let _ = std::fs::remove_dir_all(cache_dir);
        }
    }

    #[test]
    fn multi_timeline_create_list_and_set_active_round_trip() {
        let _guard = PROJECT_STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let root = tmp("timeline_multi");
        let (dir, manifest) = new_project_in(&root, "multi-tl", &[]).unwrap();
        save_manifest(&dir, &manifest).unwrap();
        state::set_project(Some(ProjectRef {
            path: dir.clone(),
            name: "multi-tl".into(),
        }));

        // no timelines yet -> chroma_timeline_list lazily builds one from shots
        let listed = super::super::edit::chroma_timeline_list().unwrap();
        assert_eq!(listed.len(), 1);
        assert!(listed[0].active);
        let main_id = listed[0].id.clone();

        let alt = super::super::edit::chroma_timeline_create("Alt cut".into()).unwrap();
        assert_eq!(alt.name, "Alt cut");
        assert!(!alt.id.is_empty());
        assert_ne!(alt.id, main_id);

        // creating makes the new one active
        let listed2 = super::super::edit::chroma_timeline_list().unwrap();
        assert_eq!(listed2.len(), 2);
        let active_now: Vec<_> = listed2
            .iter()
            .filter(|t| t.active)
            .map(|t| t.id.clone())
            .collect();
        assert_eq!(active_now, vec![alt.id.clone()]);

        // chroma_timeline_get/_set operate on whichever is active
        let got = super::super::edit::chroma_timeline_get().unwrap();
        assert_eq!(got.id, alt.id);

        // switch back to the original by id
        super::super::edit::chroma_timeline_set_active(main_id.clone()).unwrap();
        let listed3 = super::super::edit::chroma_timeline_list().unwrap();
        let active_now2: Vec<_> = listed3
            .iter()
            .filter(|t| t.active)
            .map(|t| t.id.clone())
            .collect();
        assert_eq!(active_now2, vec![main_id.clone()]);
        assert_eq!(
            super::super::edit::chroma_timeline_get().unwrap().id,
            main_id
        );

        // an unknown id errors, active timeline unchanged
        assert!(super::super::edit::chroma_timeline_set_active("no-such-id".into()).is_err());
        assert_eq!(
            super::super::edit::chroma_timeline_get().unwrap().id,
            main_id
        );

        state::set_project(None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn single_timeline_project_round_trips_through_get_and_set_unchanged() {
        // The existing single-timeline Edit-tab UX (D-041) must not regress:
        // get -> mutate -> set -> get again returns exactly what was set.
        let _guard = PROJECT_STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let root = tmp("timeline_single_roundtrip");
        let (dir, manifest) = new_project_in(
            &root,
            "single-tl",
            &[root.join("a.mov").to_string_lossy().to_string()],
        )
        .unwrap();
        save_manifest(&dir, &manifest).unwrap();
        state::set_project(Some(ProjectRef {
            path: dir.clone(),
            name: "single-tl".into(),
        }));

        let tl = super::super::edit::chroma_timeline_get().unwrap();
        assert_eq!(
            tl.tracks[0].clips.len(),
            1,
            "lazily built from the project's one shot"
        );

        let mut edited = tl.clone();
        edited.name = "renamed".into();
        super::super::edit::chroma_timeline_set(edited.clone()).unwrap();

        let refetched = super::super::edit::chroma_timeline_get().unwrap();
        assert_eq!(refetched.id, edited.id, "id is preserved across set/get");
        assert_eq!(refetched.name, "renamed");
        assert_eq!(refetched.tracks[0].clips.len(), 1);

        // still exactly one timeline — chroma_timeline_set never appends
        let listed = super::super::edit::chroma_timeline_list().unwrap();
        assert_eq!(listed.len(), 1);

        state::set_project(None);
        let _ = std::fs::remove_dir_all(&root);
    }

    // --- track management + cross-track move (D-054) ------------------------

    #[test]
    fn track_commands_add_remove_and_move_clip_on_the_active_timeline() {
        let _guard = PROJECT_STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let root = tmp("d054_track_commands");
        let (dir, manifest) = new_project_in(
            &root,
            "track-cmds",
            &[root.join("a.mov").to_string_lossy().to_string()],
        )
        .unwrap();
        save_manifest(&dir, &manifest).unwrap();
        state::set_project(Some(ProjectRef {
            path: dir.clone(),
            name: "track-cmds".into(),
        }));

        // lazily builds the one-video-track timeline from the seed shot
        let tl = super::super::edit::chroma_timeline_get().unwrap();
        assert_eq!(tl.tracks.len(), 1);
        let clip_id = tl.tracks[0].clips[0].id.clone();

        // add_track
        let new_idx =
            super::super::edit::chroma_timeline_add_track(chroma_timeline::TrackKind::Audio)
                .unwrap();
        assert_eq!(new_idx, 1);
        let tl2 = super::super::edit::chroma_timeline_get().unwrap();
        assert_eq!(tl2.tracks.len(), 2);
        assert_eq!(tl2.tracks[1].kind, chroma_timeline::TrackKind::Audio);

        // move_clip: from the video track (0) onto the fresh audio track (1).
        // B-038 — this block used to expect track 0 to survive the move as an
        // empty track. D-123 changed that contract: a cross-track move that
        // empties its source track now prunes it, so the audio track shifts
        // down into index 0 and ONE track remains. D-123 updated
        // `timeline.ts`'s mirrored test for exactly this and missed the two
        // Rust-side ones, which have been red on `main` ever since. Stale
        // assertion brought up to the shipped contract, not a behaviour change.
        super::super::edit::chroma_timeline_move_clip(0, 0, 1, 500, false).unwrap();
        let tl3 = super::super::edit::chroma_timeline_get().unwrap();
        assert_eq!(tl3.tracks.len(), 1, "the emptied source track 0 was pruned");
        assert_eq!(tl3.tracks[0].kind, chroma_timeline::TrackKind::Audio);
        assert_eq!(tl3.tracks[0].clips.len(), 1, "landed on the audio track");
        assert_eq!(tl3.tracks[0].clips[0].id, clip_id, "identity preserved");
        assert_eq!(tl3.tracks[0].clips[0].start_frame, 500);

        // an out-of-range move errors and leaves the persisted timeline unchanged
        assert!(super::super::edit::chroma_timeline_move_clip(9, 0, 0, 0, false).is_err());
        let tl4 = super::super::edit::chroma_timeline_get().unwrap();
        assert_eq!(
            tl4.tracks[0].clips.len(),
            1,
            "unchanged after the failed move"
        );

        // remove_track (including the clip now sitting on it)
        super::super::edit::chroma_timeline_remove_track(0).unwrap();
        let tl5 = super::super::edit::chroma_timeline_get().unwrap();
        assert!(
            tl5.tracks.is_empty(),
            "the audio track (and its clip) is gone"
        );

        // an out-of-range remove_track errors
        assert!(super::super::edit::chroma_timeline_remove_track(9).is_err());

        state::set_project(None);
        let _ = std::fs::remove_dir_all(&root);
    }

    // --- A/V link groups: `chroma_timeline_link_clips`/`_unlink_clip` (D-138) --
    //
    // `chroma-timeline`'s own crate tests already cover `Timeline::link`'s
    // validation exhaustively (kind mismatch, already-linked, locked track,
    // same clip, out-of-range) and `Timeline::unlink`'s (D-129) — this test
    // is deliberately NOT re-proving that logic. What only a command-level
    // test can show: the command resolves against the **active** timeline
    // (not a bare in-memory one), the result actually PERSISTS to
    // `project.json` (a `chroma_timeline_get` after the call sees it, not
    // just the return value), and a rejected call leaves the persisted file
    // untouched — the same three things `track_commands_…` above proves for
    // `add_track`/`move_clip`/`remove_track`.
    #[test]
    fn link_and_unlink_commands_persist_on_the_active_timeline() {
        let _guard = PROJECT_STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let root = tmp("d138_link_commands");
        let (dir, manifest) = new_project_in(
            &root,
            "link-cmds",
            &[root.join("a.mov").to_string_lossy().to_string()],
        )
        .unwrap();
        save_manifest(&dir, &manifest).unwrap();
        state::set_project(Some(ProjectRef {
            path: dir.clone(),
            name: "link-cmds".into(),
        }));

        // Lazily builds the one-video-track timeline from the seed shot, then
        // hand-adds a second, audio-track clip — `chroma_timeline_set` stores
        // whatever is sent verbatim, the same "the frontend owns clip
        // creation" contract `add_clip`'s own doc names (this crate has no
        // clip-creation op of its own).
        let mut tl = super::super::edit::chroma_timeline_get().unwrap();
        assert_eq!(tl.tracks.len(), 1);
        let video_id = tl.tracks[0].clips[0].id.clone();
        tl.tracks.push(chroma_timeline::Track {
            kind: TrackKind::Audio,
            clips: vec![Clip {
                id: "a1".into(),
                name: "a1".into(),
                source_path: "/a.wav".into(),
                duration: 100,
                source_len: 100,
                start_frame: 0,
                ..Default::default()
            }],
            ..Default::default()
        });
        super::super::edit::chroma_timeline_set(tl).unwrap();

        // link — persists a shared group on both real clips, resolved
        // against whatever timeline is active, not a bare in-memory one.
        let group = super::super::edit::chroma_timeline_link_clips(0, 0, 1, 0).unwrap();
        let after_link = super::super::edit::chroma_timeline_get().unwrap();
        assert_eq!(after_link.tracks[0].clips[0].link_group.as_deref(), Some(group.as_str()));
        assert_eq!(after_link.tracks[1].clips[0].link_group.as_deref(), Some(group.as_str()));

        // a rejected link (already linked) leaves the persisted file
        // untouched — not merged, not partially applied.
        let err = super::super::edit::chroma_timeline_link_clips(0, 0, 1, 0).unwrap_err();
        assert!(err.contains("already linked"), "unexpected error: {err}");
        let unchanged = super::super::edit::chroma_timeline_get().unwrap();
        assert_eq!(unchanged.tracks[0].clips[0].link_group.as_deref(), Some(group.as_str()));

        // an out-of-range link errors and leaves the file untouched
        assert!(super::super::edit::chroma_timeline_link_clips(9, 0, 1, 0).is_err());

        // unlink — persists the dissolved group; restores D-050's embedded
        // playback path for the video clip (nothing here exercises audio
        // playback, just the `link_group` field `chroma_audio_play` reads).
        super::super::edit::chroma_timeline_unlink_clip(0, 0).unwrap();
        let after_unlink = super::super::edit::chroma_timeline_get().unwrap();
        assert_eq!(after_unlink.tracks[0].clips[0].link_group, None);
        assert_eq!(after_unlink.tracks[1].clips[0].link_group, None);
        assert_eq!(after_unlink.tracks[0].clips[0].id, video_id, "identity preserved");

        // unlink on an already-unlinked clip is a real no-op, not an error
        assert_eq!(super::super::edit::chroma_timeline_unlink_clip(0, 0), Ok(()));

        state::set_project(None);
        let _ = std::fs::remove_dir_all(&root);
    }

    // --- opaque top-wins video-track resolution (D-056, Phase B1) -----------

    /// End-to-end through the real Tauri command path (`resolve_video_position`
    /// / `chroma_timeline_frame`, not just the pure `chroma-timeline` crate
    /// logic already unit-tested there): two *real*, ffmpeg-probed clips of
    /// different lengths, laid onto two video tracks via the actual
    /// `add_track`/`move_clip` commands, then queried at positions covering
    /// every case from the brief — both tracks have content (top wins), only
    /// top has content, only bottom has content, neither, and top-has-a-gap
    /// fallthrough to bottom.
    #[test]
    fn track_resolution_opaque_top_wins_across_two_video_tracks() {
        let _guard = PROJECT_STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // needs ffmpeg to synthesise probe-able clips; skip cleanly without it.
        let (Some(clip_a), Some(clip_b)) = (
            make_test_clip("d056_a", 64, 64, "25", 1), // ~25 frames
            make_test_clip("d056_b", 64, 64, "25", 3), // ~75 frames — longer
        ) else {
            eprintln!("skip: ffmpeg not on PATH");
            return;
        };

        let root = tmp("d056_track_resolution");
        let (dir, manifest) = new_project_in(
            &root,
            "track-res",
            &[
                clip_a.to_string_lossy().to_string(),
                clip_b.to_string_lossy().to_string(),
            ],
        )
        .unwrap();
        save_manifest(&dir, &manifest).unwrap();
        state::set_project(Some(ProjectRef {
            path: dir.clone(),
            name: "track-res".into(),
        }));

        // lazily built: track 0 has A (short) at [0, durA) then B (long) at
        // [durA, durA+durB), back to back (from_shots' usual layout).
        let tl = super::super::edit::chroma_timeline_get().unwrap();
        assert_eq!(tl.tracks.len(), 1);
        assert_eq!(tl.tracks[0].clips.len(), 2);
        let dur_a = tl.tracks[0].clips[0].duration;
        let dur_b = tl.tracks[0].clips[1].duration;
        assert!(
            dur_b > dur_a,
            "the 3s clip must probe longer than the 1s clip \
             (dur_a={dur_a}, dur_b={dur_b}) for this test's positions to be meaningful"
        );

        // add a second video track and move B onto it at frame 0 — leaves
        // track 0 with just A at [0, dur_a), track 1 with B at [0, dur_b).
        let new_idx =
            super::super::edit::chroma_timeline_add_track(chroma_timeline::TrackKind::Video)
                .unwrap();
        assert_eq!(new_idx, 1);
        super::super::edit::chroma_timeline_move_clip(0, 1, 1, 0, false).unwrap();

        let tl2 = super::super::edit::chroma_timeline_get().unwrap();
        assert_eq!(tl2.tracks[0].clips.len(), 1, "only A left on track 0");
        assert_eq!(tl2.tracks[1].clips.len(), 1, "B landed on track 1");

        // both tracks have content at frame 0 — track 0 (higher priority) wins.
        let (_, clip, _, _) = super::super::edit::resolve_video_position(0)
            .unwrap()
            .expect("frame 0 has content on track 0");
        assert_eq!(clip.name, tl.tracks[0].clips[0].name, "top track wins");

        // top-gap fallthrough: past A's end (dur_a), still inside B's range
        // (dur_b > dur_a) — track 0 has nothing there, track 1 shows through.
        let (_, clip, source_frame, _) = super::super::edit::resolve_video_position(dur_a as u64)
            .unwrap()
            .expect("track 1 shows through track 0's gap");
        assert_eq!(clip.name, tl.tracks[0].clips[1].name, "bottom track B");
        assert_eq!(
            source_frame, dur_a as u64,
            "B's own source frame at this timeline position (it starts at 0)"
        );

        // neither track has content past B's end.
        assert!(
            super::super::edit::resolve_video_position(dur_b as u64)
                .unwrap()
                .is_none(),
            "past everything on both tracks"
        );

        // and the real preview command doesn't error and returns a real (not
        // blank) frame for the top-wins position, a blank one past the end.
        // `edit::timeline_frame` is `chroma_timeline_frame`'s whole body —
        // the command itself is now just a `spawn_blocking` wrapper (D-125),
        // so calling it here needs no tokio runtime.
        let jpeg = super::super::edit::timeline_frame(0, None).unwrap();
        assert!(jpeg.starts_with("data:image/jpeg;base64,"));
        let blank = super::super::edit::timeline_frame(dur_b as u64, None).unwrap();
        assert!(
            blank.starts_with("data:image/png;base64,"),
            "blank frame past the end"
        );

        state::set_project(None);
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_file(&clip_a);
        let _ = std::fs::remove_file(&clip_b);
    }

    #[test]
    fn chroma_project_save_persists_active_clip_id() {
        // D-070: chroma_project_save no longer takes a `shots` list — it
        // just persists `active_clip_id`, touches `modified`, and (best
        // effort) regenerates thumb.jpg. Clips themselves are the timeline's
        // job (`chroma_timeline_set`), not this command's.
        let _guard = PROJECT_STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let root = tmp("unify_save");
        let (dir, manifest) = new_project_in(&root, "unify-save", &[]).unwrap();
        save_manifest(&dir, &manifest).unwrap();
        state::set_project(Some(ProjectRef {
            path: dir.clone(),
            name: "unify-save".into(),
        }));

        // chroma_project_save is async; drive it on a tiny local runtime
        // rather than pulling tokio::test into this otherwise-sync module.
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        rt.block_on(chroma_project_save(
            Some(dir.to_string_lossy().to_string()),
            Some("clip-xyz".into()),
        ))
        .unwrap();

        let reloaded = load_manifest(&dir).unwrap();
        assert_eq!(reloaded.active_clip_id.as_deref(), Some("clip-xyz"));
        assert!(
            reloaded.shots.is_empty(),
            "save never creates a ProjectShot any more"
        );

        // saving again with a different (or no) active clip id updates it
        rt.block_on(chroma_project_save(
            Some(dir.to_string_lossy().to_string()),
            None,
        ))
        .unwrap();
        let reloaded2 = load_manifest(&dir).unwrap();
        assert_eq!(reloaded2.active_clip_id, None);

        state::set_project(None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn project_ref_set_and_clear() {
        let _guard = PROJECT_STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mine = ProjectRef {
            path: PathBuf::from("/tmp/project-ref-test-unique.chroma"),
            name: "project-ref-test-unique".into(),
        };
        state::set_project(Some(mine.clone()));
        let got = state::current_project().unwrap();
        assert_eq!(got.path, mine.path);
        assert_eq!(got.name, "project-ref-test-unique");
        state::set_project(None);
        // another parallel test may have set its own project; just assert ours
        // is not still the active one
        assert!(state::current_project().map(|p| p.path) != Some(mine.path));
    }
}

//! Timeline lifecycle for a `.chroma` project (D-041 / D-045 / D-114).
//!
//! What it is: the four functions that answer "what is this project's active
//!   timeline, and does it have one yet?" — lazily building one from a
//!   pre-D-046 manifest's legacy `shots` the first time, clamping a stale
//!   `active_timeline`, and optionally persisting the result.
//! What it does NOT do: decide *which* project. Every function here takes the
//!   project directory as an argument. The process-global "currently open
//!   project" (`chroma::state::current_project`) is an app concern and stays
//!   in `app/src-tauri`, which supplies the directory — the same
//!   pass-the-fact-in shape D-145 gave `tracked_depth_map`.
//!
//! **Where this came from (D-148, `docs/notes/crate-extraction-plan.md` §2.3).**
//! This code lived in `app/src-tauri/src/chroma/edit.rs` L108–197, i.e. in the
//! Edit-tab bridge, and the plan's scoping pass called it what it is: *project
//! concerns wearing an Edit-tab name*. The evidence is the call graph, not
//! taste — `chroma::project`'s own `open_manifest`, `chroma_project_resync_clips`,
//! `chroma_project_add_shot_paths` and `chroma_project_remove_clip` all called
//! `super::edit::ensure_timeline`, and `build_from_shots` reads
//! `manifest.shots` and calls `project::resolve_shot` + `project::save_manifest`
//! and nothing Edit-tab at all. `chroma::edit` keeps thin wrappers at the
//! original names and signatures, so its own ~20 call sites did not change.

use std::path::Path;

use apelles_timeline::{OutputSpec, Timeline};

use crate::{
    ProjectManifest, ProjectSettings, load_manifest, load_manifest_cached, now_rfc3339,
    resolve_shot, save_manifest,
};

/// Build a single-video-track timeline from a manifest's shots, resolving
/// each shot's source path/name via its `media_id` (D-046 — see
/// [`resolve_shot`]) and probing that path for its frame count (0 when
/// offline / not probe-able / dangling). Assigns a fresh id (D-045) —
/// `apelles-timeline` itself never generates one.
fn build_from_shots(manifest: &ProjectManifest) -> Timeline {
    let tuples: Vec<(String, String, String, i64)> = manifest
        .shots
        .iter()
        .map(|shot| {
            let (source_path, name) = resolve_shot(manifest, shot);
            let frames = apelles_media::probe::probe_cached(Path::new(&source_path))
                .map(|i| i.frame_count as i64)
                .unwrap_or(0);
            (shot.id.clone(), source_path, name, frames)
        })
        .collect();
    let mut tl = Timeline::from_shots(&tuples);
    tl.id = uuid::Uuid::new_v4().to_string();
    tl.name = manifest.name.clone();
    // B-097 — the other timeline-creation site, and it had the same gap
    // `new_project_in` had: `Timeline::from_shots` leaves `rate: None`, so a
    // lazily-built timeline resolved at `DEFAULT_FPS` (24) no matter what the
    // shots' own media actually is. Seeded from the first shot's source, the
    // same one `infer_settings_from_clip` derives the project's output spec
    // from — see `crate::infer_timeline_rate`.
    tl.rate = crate::infer_timeline_rate(tuples.first().map(|(_, path, _, _)| path.as_str()))
        // B-323 — media that gave no rate (none, or unprobeable): the project's
        // recorded one (D-038), so `set_project_settings(fps=30)` made before
        // the first timeline existed still reaches it.
        .or_else(|| crate::project_default_rate(&manifest.settings));
    tl
}

/// Ensure `manifest.timelines` is non-empty (lazily building one from shots —
/// the same D-041 fallback `chroma_timeline_get` always had — if it's empty)
/// and that `active_timeline` points at a valid entry. `persist` controls
/// whether a freshly-built timeline is written back to `project.json` (get
/// does this; the per-frame decode does not, matching the old behaviour).
///
/// Called from both tabs: `chroma::edit`'s timeline commands, and
/// `chroma::project`'s `open_manifest` before it sources the Colorist shot
/// strip from the active timeline's clips — a project opened for the first
/// time since ever (no `timelines` key at all) must still get one built from
/// its legacy `shots`, exactly as `chroma_timeline_get` always lazily did, or
/// the strip would show nothing until the user happened to visit the Edit tab
/// first.
pub fn ensure_timeline(
    dir: &Path,
    mut manifest: ProjectManifest,
    persist: bool,
) -> Result<ProjectManifest, String> {
    if manifest.timelines.is_empty() {
        let tl = build_from_shots(&manifest);
        manifest.timelines.push(tl);
        manifest.active_timeline = 0;
        if persist {
            manifest.modified = now_rfc3339();
            save_manifest(dir, &manifest)?;
        }
    } else if manifest.active_timeline >= manifest.timelines.len() {
        manifest.active_timeline = 0;
    }
    Ok(manifest)
}

/// Load `dir`'s manifest with `timelines` guaranteed non-empty and
/// `active_timeline` valid.
///
/// D-114 — the read-only path (this is [`resolve_timeline`]'s hot call, once
/// per preview frame) uses the mtime-validated cache instead of a full
/// re-read + re-parse every time; `persist: true` callers (which may go on to
/// write) keep the plain, always-fresh-from-disk read.
pub fn load_and_ensure_timeline(dir: &Path, persist: bool) -> Result<ProjectManifest, String> {
    let manifest = if persist {
        load_manifest(dir)?
    } else {
        load_manifest_cached(dir)?
    };
    ensure_timeline(dir, manifest, persist)
}

/// A project's **active** timeline (D-045) — its persisted one, or a fresh
/// build from its shots the first time.
pub fn resolve_timeline(dir: &Path, persist: bool) -> Result<Timeline, String> {
    let (timeline, _settings) = resolve_timeline_and_settings(dir, persist)?;
    Ok(timeline)
}

/// [`resolve_timeline`] plus the project's output spec (D-038) — the pair
/// `chroma::edit::timeline_frame` needs, since D-136 made the compositor's
/// canvas the **composition** rather than the top layer's decoded size. One
/// load, not two: [`load_and_ensure_timeline`] is the per-preview-frame hot
/// path (D-114 caches it, but a second call would still clone a whole
/// manifest).
pub fn resolve_timeline_and_settings(
    dir: &Path,
    persist: bool,
) -> Result<(Timeline, ProjectSettings), String> {
    let manifest = load_and_ensure_timeline(dir, persist)?;
    Ok((
        manifest.timelines[manifest.active_timeline].clone(),
        manifest.settings.clone(),
    ))
}

// --------------------------------------------------------------------------- //
// D-411 Phase 0 — timeline management: create / rename / duplicate / delete /
// set output, by id. Pure manifest edits (plus the grade-file copy a
// duplicate owes), so the Tauri commands in `chroma::edit` are thin
// load-edit-save wrappers and every rule here is unit-tested without an app.
// --------------------------------------------------------------------------- //

/// The index of the timeline with `id`, or an error naming the id (the
/// message every by-id command and MCP tool reports back verbatim).
pub fn timeline_index(manifest: &ProjectManifest, id: &str) -> Result<usize, String> {
    manifest
        .timelines
        .iter()
        .position(|tl| tl.id == id)
        .ok_or_else(|| format!("no timeline with id {id}"))
}

/// A timeline name as stored: trimmed, and refused when that leaves nothing —
/// the switcher tab and every MCP listing show the name, and an empty one is
/// indistinguishable from a broken entry.
fn clean_timeline_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("a timeline name must not be empty".to_string());
    }
    Ok(trimmed.to_string())
}

/// Append a new, empty timeline named `name` with an optional own output size
/// (D-411), make it active when `activate`, and return it.
///
/// **Its rate is the active timeline's rate.** A new timeline used to be
/// created with `rate: None`, which every reader resolves as
/// [`apelles_timeline::DEFAULT_FPS`] (24) — so a short started in a 30 fps
/// project silently ran at 24 fps (the B-097 class of defect, at the one
/// creation site B-097 did not reach; logged as B-284). The active timeline
/// is the right seed: it is what the person is working in, and for the
/// clipper it is the long-form the short is cut from.
pub fn create_timeline(
    manifest: &mut ProjectManifest,
    name: &str,
    output: Option<OutputSpec>,
    activate: bool,
) -> Result<Timeline, String> {
    let name = clean_timeline_name(name)?;
    let rate = manifest
        .timelines
        .get(manifest.active_timeline)
        .and_then(|tl| tl.rate);
    let tl = Timeline {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        rate,
        output,
        ..Default::default()
    };
    manifest.timelines.push(tl.clone());
    if activate {
        manifest.active_timeline = manifest.timelines.len() - 1;
    }
    manifest.modified = now_rfc3339();
    Ok(tl)
}

/// Rename the timeline with `id`.
pub fn rename_timeline(manifest: &mut ProjectManifest, id: &str, name: &str) -> Result<(), String> {
    let idx = timeline_index(manifest, id)?;
    manifest.timelines[idx].name = clean_timeline_name(name)?;
    manifest.modified = now_rfc3339();
    Ok(())
}

/// Set (`Some`) or clear (`None` — back to the project's size) the output
/// size of the timeline with `id`.
pub fn set_timeline_output(
    manifest: &mut ProjectManifest,
    id: &str,
    output: Option<OutputSpec>,
) -> Result<(), String> {
    let idx = timeline_index(manifest, id)?;
    manifest.timelines[idx].output = output;
    manifest.modified = now_rfc3339();
    Ok(())
}

/// Change the frame rate of the timeline with `id`, keeping every clip,
/// marker and transition at the same time in seconds
/// ([`apelles_timeline::Timeline::set_rate`]). `fps` is a float as the tools
/// and the GUI carry it; it becomes the exact rational (29.97 -> 30000/1001).
pub fn set_timeline_rate(manifest: &mut ProjectManifest, id: &str, fps: f64) -> Result<(), String> {
    let rate = apelles_timeline::fps_to_rational(fps).ok_or_else(|| {
        format!(
            "a frame rate must be positive and at most {} fps (got {fps})",
            apelles_timeline::MAX_TIMELINE_FPS
        )
    })?;
    let idx = timeline_index(manifest, id)?;
    manifest.timelines[idx].set_rate(rate)?;
    manifest.modified = now_rfc3339();
    Ok(())
}

/// The suffix [`duplicate_clip_id`] appends: `~` plus this many hex digits.
const DUPLICATE_ID_SUFFIX_HEX: usize = 8;

/// A duplicated clip's new id: the original's, with a short random suffix
/// (replacing an earlier duplicate's suffix rather than stacking a second).
///
/// The original id is kept as the stem, not thrown away for a bare uuid,
/// because ids carry meaning a reader relies on: `text-…`, `adjust-…`,
/// `<media-id>-<stamp>` and a split's `<left>·<frame>` all say what a clip is
/// and where it came from.
fn duplicate_clip_id(id: &str) -> String {
    let stem = match id.rsplit_once('~') {
        Some((stem, tail))
            if tail.len() == DUPLICATE_ID_SUFFIX_HEX
                && tail.chars().all(|c| c.is_ascii_hexdigit()) =>
        {
            stem
        }
        _ => id,
    };
    let fresh = uuid::Uuid::new_v4().simple().to_string();
    format!("{stem}~{}", &fresh[..DUPLICATE_ID_SUFFIX_HEX])
}

/// Duplicate the timeline with `id` (Premiere's "Duplicate Sequence",
/// Resolve's "Duplicate Timeline", FCP's "Duplicate Project"): a fresh id, the
/// name `name` (default "<original> copy"), placed right after the original,
/// active when `activate`. Returns the copy.
///
/// **The copy is independent, grades included.** Every clip gets a new id and
/// its Colorist grade file (`grades/<clip.id>.grade.json`, D-070/D-256 — the
/// grade is keyed by clip id) is copied to the new id, so grading a clip in
/// the copy does not regrade the original. That is what the reference NLEs do,
/// and it is the only reading under which "duplicate, then change the copy" is
/// safe. Link groups, transitions (anchored by frame), markers, `output` and
/// `origin` are copied as they are: none of them is identified across
/// timelines.
///
/// `dir` is the project directory (for the grade copy). A grade file that
/// fails to copy is an error, and nothing is added to the manifest: a
/// duplicate that silently dropped a grade would show different pictures.
pub fn duplicate_timeline(
    dir: &Path,
    manifest: &mut ProjectManifest,
    id: &str,
    name: Option<&str>,
    activate: bool,
) -> Result<Timeline, String> {
    let idx = timeline_index(manifest, id)?;
    let original = &manifest.timelines[idx];
    let name = match name {
        Some(n) => clean_timeline_name(n)?,
        None => format!("{} copy", original.name.trim()),
    };
    let mut copy = original.clone();
    copy.id = uuid::Uuid::new_v4().to_string();
    copy.name = name;

    let mut pairs: Vec<(String, String)> = Vec::new();
    for track in &mut copy.tracks {
        for clip in &mut track.clips {
            let new_id = duplicate_clip_id(&clip.id);
            pairs.push((clip.id.clone(), new_id.clone()));
            clip.id = new_id;
        }
    }
    copy_clip_grades(dir, &pairs)
        .map_err(|e| format!("could not copy a grade for the duplicate: {e}"))?;

    let at = idx + 1;
    manifest.timelines.insert(at, copy.clone());
    if activate {
        manifest.active_timeline = at;
    } else if manifest.active_timeline >= at {
        manifest.active_timeline += 1;
    }
    manifest.modified = now_rfc3339();
    Ok(copy)
}

/// Copy each `(from, to)` clip's Colorist grade file
/// (`grades/<from>.grade.json` to `grades/<to>.grade.json`) where `from` has
/// one, so a clip given a new id keeps its look. All or nothing: a failed copy
/// removes the copies already made and names the clip. Returns how many were
/// copied. Shared by [`duplicate_timeline`] and the clipper's shorts built
/// from a graded long-form timeline (D-411 section 5.1).
pub fn copy_clip_grades(dir: &Path, pairs: &[(String, String)]) -> Result<usize, String> {
    let grades = crate::grade_dir(dir);
    let mut copied: Vec<std::path::PathBuf> = Vec::new();
    for (from_id, to_id) in pairs {
        let from = grades.join(format!("{from_id}.grade.json"));
        if !from.is_file() {
            continue;
        }
        let to = grades.join(format!("{to_id}.grade.json"));
        if let Err(e) = std::fs::copy(&from, &to) {
            for done in &copied {
                let _ = std::fs::remove_file(done);
            }
            return Err(format!("clip {from_id}: {e}"));
        }
        copied.push(to);
    }
    Ok(copied.len())
}

/// Replace the whole content of the timeline with `id`: what the clipper
/// writes a built short with (D-411 section 5.3). The id is kept whatever
/// `timeline` says, the name is cleaned like any rename, and an `output` must
/// be a valid size. **Not for the active timeline while the Edit tab holds
/// it**: the store is its one writer (D-051); the app's command refuses that
/// case.
pub fn replace_timeline(
    manifest: &mut ProjectManifest,
    id: &str,
    mut timeline: Timeline,
) -> Result<(), String> {
    let idx = timeline_index(manifest, id)?;
    timeline.id = id.to_string();
    timeline.name = clean_timeline_name(&timeline.name)?;
    if let Some(o) = timeline.output {
        OutputSpec::new(o.width, o.height)?;
    }
    manifest.timelines[idx] = timeline;
    manifest.modified = now_rfc3339();
    Ok(())
}

/// Delete the timeline with `id`. Refused for a project's only timeline (a
/// project always has one — `ensure_timeline` would only rebuild it from the
/// legacy shots). Deleting the active timeline activates the one that slides
/// into its place (the next, or the previous when it was last), the way a
/// closed tab hands focus on; deleting one before the active keeps the same
/// timeline active.
///
/// Grade files of its clips are left on disk: a clip id may still be live in
/// another timeline (a copy made before D-411 duplicated by hand shares ids),
/// and an orphaned grade file costs a few KB while a deleted shared one loses
/// work.
pub fn delete_timeline(manifest: &mut ProjectManifest, id: &str) -> Result<Timeline, String> {
    let idx = timeline_index(manifest, id)?;
    if manifest.timelines.len() <= 1 {
        return Err("cannot delete the project's only timeline".to_string());
    }
    let removed = manifest.timelines.remove(idx);
    if manifest.active_timeline > idx {
        manifest.active_timeline -= 1;
    } else if manifest.active_timeline == idx {
        manifest.active_timeline = idx.min(manifest.timelines.len() - 1);
    }
    manifest.modified = now_rfc3339();
    Ok(removed)
}

/// The timeline with `id` plus the project's settings — what an export of a
/// timeline that is NOT the active one needs (D-411: export by id). Read
/// through the same cached load the active path uses.
pub fn resolve_timeline_by_id_and_settings(
    dir: &Path,
    id: &str,
) -> Result<(Timeline, ProjectSettings), String> {
    let manifest = load_and_ensure_timeline(dir, false)?;
    let idx = timeline_index(&manifest, id)?;
    Ok((manifest.timelines[idx].clone(), manifest.settings.clone()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::new_project_in;
    use apelles_timeline::{Clip, Track, TrackKind};

    fn tmp(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "chroma_project_timeline_test_{tag}_{}_{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// The D-041 lazy fallback, which is the whole reason this function
    /// exists: a manifest with legacy `shots` and no `timelines` at all gets
    /// one built from those shots — one video track, one clip per shot, in
    /// manifest order, named after the project.
    #[test]
    fn an_empty_timelines_list_is_built_from_the_legacy_shots() {
        let root = tmp("ensure_builds");
        let (dir, manifest) = new_project_in(&root, "Built", &[]).unwrap();
        // `new_project_in` with no clips leaves both lists empty; hand-build
        // the pre-D-046 shape (a shot + its pool item) the migration produces.
        let mut manifest = manifest;
        manifest.media.push(crate::MediaItem {
            id: "m1".into(),
            source_path: "/a.mov".into(),
            name: "a.mov".into(),
            added: String::new(),
            video: None,
            image: None,
            folder: None,
            motion_scene_id: None,
        });
        manifest.shots.push(crate::ProjectShot {
            id: "s1".into(),
            media_id: "m1".into(),
            frame: 0,
        });
        assert!(manifest.timelines.is_empty());

        let out = ensure_timeline(&dir, manifest, false).unwrap();
        assert_eq!(out.timelines.len(), 1, "one timeline is built");
        assert_eq!(out.active_timeline, 0);
        assert_eq!(out.timelines[0].name, "Built");
        assert!(!out.timelines[0].id.is_empty(), "a fresh id is assigned");
        let clips = &out.timelines[0].tracks[0].clips;
        assert_eq!(clips.len(), 1);
        assert_eq!(clips[0].source_path, "/a.mov");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// B-323: a project made without media (so nothing to infer a rate from)
    /// records the default rate in its settings instead of leaving an implicit
    /// fallback, and the first timeline built later takes whatever the
    /// project's rate is by then, not 24.
    #[test]
    fn a_new_project_records_a_rate_and_its_first_timeline_takes_it() {
        let root = tmp("b323_first_timeline");
        let (dir, mut manifest) = new_project_in(&root, "NoMedia", &[]).unwrap();
        assert_eq!(
            manifest.settings.fps,
            Some(apelles_timeline::DEFAULT_FPS),
            "a default is recorded, not left implicit"
        );
        manifest.settings.fps = Some(30.0);
        let out = ensure_timeline(&dir, manifest, false).unwrap();
        assert_eq!(
            out.timelines[0].rate,
            Some(apelles_types::Rational::new(30, 1))
        );
        assert_eq!(out.timelines[0].fps(), 30.0);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// B-323: retiming one timeline by id converts its timeline-frame fields
    /// by time and leaves the other timelines alone.
    #[test]
    fn set_rate_retimes_one_timeline_by_id() {
        let (root, _dir, mut m) = three_timelines("b323_set_rate");
        m.timelines[0].rate = Some(apelles_types::Rational::new(24, 1));
        m.timelines[0].tracks = vec![Track {
            clips: vec![Clip {
                id: "c".into(),
                start_frame: 48,
                duration: 24,
                source_len: 24,
                ..Clip::default()
            }],
            ..Track::default()
        }];
        set_timeline_rate(&mut m, "a", 30.0).unwrap();
        let c = &m.timelines[0].tracks[0].clips[0];
        assert_eq!((c.start_frame, c.duration), (60, 30), "seconds preserved");
        assert_eq!(
            m.timelines[0].rate,
            Some(apelles_types::Rational::new(30, 1))
        );
        assert_eq!(m.timelines[1].rate, None, "another timeline is untouched");
        assert!(set_timeline_rate(&mut m, "a", 0.0).is_err());
        assert_eq!(
            set_timeline_rate(&mut m, "zz", 30.0).unwrap_err(),
            "no timeline with id zz"
        );
        set_timeline_rate(&mut m, "b", 29.97).unwrap();
        assert_eq!(
            m.timelines[1].rate,
            Some(apelles_types::Rational::new(30000, 1001))
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// `persist: false` must not touch `project.json` — this is the
    /// per-preview-frame path, and writing the manifest once per frame is
    /// exactly what D-114 was about. `persist: true` writes it.
    #[test]
    fn persist_controls_whether_a_freshly_built_timeline_is_written_back() {
        let root = tmp("ensure_persist");
        let (dir, manifest) = new_project_in(&root, "Persist", &[]).unwrap();
        manifest_with_one_shot(&dir, manifest.clone(), false);
        let on_disk = load_manifest(&dir).unwrap();
        assert!(
            on_disk.timelines.is_empty(),
            "persist: false left project.json alone"
        );

        manifest_with_one_shot(&dir, manifest, true);
        let on_disk = load_manifest(&dir).unwrap();
        assert_eq!(
            on_disk.timelines.len(),
            1,
            "persist: true wrote the built timeline back"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    fn manifest_with_one_shot(dir: &Path, mut manifest: ProjectManifest, persist: bool) {
        manifest.media.push(crate::MediaItem {
            id: "m1".into(),
            source_path: "/a.mov".into(),
            name: "a.mov".into(),
            added: String::new(),
            video: None,
            image: None,
            folder: None,
            motion_scene_id: None,
        });
        manifest.shots.push(crate::ProjectShot {
            id: "s1".into(),
            media_id: "m1".into(),
            frame: 0,
        });
        ensure_timeline(dir, manifest, persist).unwrap();
    }

    /// A manifest that already has timelines is left completely alone —
    /// nothing rebuilt, nothing renamed, no fresh id.
    #[test]
    fn an_existing_timeline_is_not_rebuilt() {
        let root = tmp("ensure_noop");
        let (dir, mut manifest) = new_project_in(&root, "Existing", &[]).unwrap();
        manifest.timelines.push(Timeline {
            id: "keep-me".into(),
            name: "Hand Named".into(),
            rate: None,
            tracks: vec![Track {
                kind: TrackKind::Video,
                clips: vec![Clip {
                    id: "c1".into(),
                    name: "c".into(),
                    source_path: "/c.mov".into(),
                    duration: 10,
                    source_len: 10,
                    ..Default::default()
                }],
                ..Default::default()
            }],
            markers: Vec::new(),
            ..Default::default()
        });
        manifest.active_timeline = 0;

        let out = ensure_timeline(&dir, manifest, true).unwrap();
        assert_eq!(out.timelines.len(), 1);
        assert_eq!(out.timelines[0].id, "keep-me");
        assert_eq!(out.timelines[0].name, "Hand Named");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// An `active_timeline` past the end of the list clamps to 0 rather than
    /// panicking at `manifest.timelines[active]` — which is exactly what
    /// [`resolve_timeline_and_settings`] would do one line later.
    #[test]
    fn an_out_of_range_active_timeline_clamps_to_zero() {
        let root = tmp("ensure_clamp");
        let (dir, mut manifest) = new_project_in(&root, "Clamp", &[]).unwrap();
        manifest.timelines.push(Timeline {
            id: "t1".into(),
            name: "t1".into(),
            rate: None,
            tracks: Vec::new(),
            markers: Vec::new(),
            ..Default::default()
        });
        manifest.active_timeline = 7;

        let out = ensure_timeline(&dir, manifest, false).unwrap();
        assert_eq!(out.active_timeline, 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The full app-side path, minus the process-global the app supplies:
    /// save a project, then resolve its active timeline + settings straight
    /// off disk. Covers `load_and_ensure_timeline`'s cached (`persist: false`)
    /// read, which is the once-per-preview-frame call.
    #[test]
    fn resolve_timeline_and_settings_reads_the_active_timeline_off_disk() {
        let root = tmp("resolve_roundtrip");
        let (dir, mut manifest) = new_project_in(&root, "Resolve", &[]).unwrap();
        manifest.timelines.push(Timeline {
            id: "t1".into(),
            name: "first".into(),
            rate: None,
            tracks: Vec::new(),
            markers: Vec::new(),
            ..Default::default()
        });
        manifest.timelines.push(Timeline {
            id: "t2".into(),
            name: "second".into(),
            rate: None,
            tracks: Vec::new(),
            markers: Vec::new(),
            ..Default::default()
        });
        manifest.active_timeline = 1;
        manifest.settings.width = Some(1280);
        manifest.settings.height = Some(720);
        save_manifest(&dir, &manifest).unwrap();

        let (tl, settings) = resolve_timeline_and_settings(&dir, false).unwrap();
        assert_eq!(tl.id, "t2", "the *active* timeline, not the first");
        assert_eq!(settings.width, Some(1280));
        assert_eq!(settings.height, Some(720));

        let tl = resolve_timeline(&dir, false).unwrap();
        assert_eq!(tl.id, "t2");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// D-325's own measurement of lead (C) from the B-146 continuation
    /// investigation: `resolve_timeline_and_settings`'s unconditional
    /// `.clone()` of the active `Timeline` (this function's own doc already
    /// flagged it: "a second call would still clone a whole manifest") DOES
    /// scale with clip count, real and confirmed here — but the absolute cost
    /// stays microseconds even at 200 clips, three-plus orders of magnitude
    /// below D-290's own measured ~21.5ms/frame webview floor. Real, not the
    /// dominant cost, and deliberately NOT optimised further this pass — see
    /// D-325 for why (measuring first is what told the difference between
    /// "real" and "matters").
    ///
    /// A regression guard, not a benchmark left to bit-rot: if this clone
    /// path is ever made to do something that actually costs real
    /// milliseconds (a deep JSON clone inside `chroma_keyframes`, say), this
    /// fails loudly instead of quietly becoming the next per-frame surprise.
    #[test]
    fn resolve_timeline_and_settings_clone_cost_stays_microseconds_even_at_200_clips() {
        fn build(tag: &str, n: usize) -> std::path::PathBuf {
            let root = tmp(tag);
            let (dir, mut manifest) = new_project_in(&root, "Measure", &[]).unwrap();
            let mut clips = Vec::with_capacity(n);
            for i in 0..n {
                clips.push(Clip {
                    id: format!("clip-{i}"),
                    name: format!("clip number {i} with a reasonably long name"),
                    source_path: format!("/some/reasonably/long/media/path/clip_{i}.mov"),
                    duration: 48,
                    source_len: 48,
                    start_frame: (i as i64) * 48,
                    ..Default::default()
                });
            }
            manifest.timelines.push(Timeline {
                id: "t1".into(),
                name: "Measure".into(),
                rate: None,
                tracks: vec![Track {
                    kind: TrackKind::Video,
                    clips,
                    ..Default::default()
                }],
                markers: Vec::new(),
                ..Default::default()
            });
            manifest.active_timeline = 0;
            save_manifest(&dir, &manifest).unwrap();
            dir
        }

        const N: u32 = 2000;
        // D-290's own measured webview-side floor was ~21.5ms/frame. 200us —
        // two orders of magnitude below that — is a generous ceiling: real
        // enough to catch a genuine regression, nowhere close to tripping on
        // ordinary machine noise.
        const CEILING_PER_CALL: std::time::Duration = std::time::Duration::from_micros(200);

        for clip_count in [1usize, 96, 200] {
            let dir = build(&format!("clone_cost_{clip_count}"), clip_count);
            // Warm the D-114 cache — isolate the clone cost, not the read+parse.
            resolve_timeline_and_settings(&dir, false).unwrap();

            let start = std::time::Instant::now();
            for _ in 0..N {
                let _ = resolve_timeline_and_settings(&dir, false).unwrap();
            }
            let elapsed = start.elapsed();
            let per_call = elapsed / N;
            println!("clip_count={clip_count}: {N} calls, {elapsed:?} total, {per_call:?}/call");
            assert!(
                per_call < CEILING_PER_CALL,
                "resolve_timeline_and_settings got real-costly at clip_count={clip_count}: \
                 {per_call:?}/call >= {CEILING_PER_CALL:?} ceiling — this is the D-325 \
                 investigation's lead (C); re-measure against D-290's webview floor before \
                 assuming it is now the dominant per-frame cost"
            );
            let _ = std::fs::remove_dir_all(dir.parent().unwrap_or(&dir));
        }
    }

    // ----------------------------------------------------------------------- //
    // D-411 Phase 0 — timeline management
    // ----------------------------------------------------------------------- //

    fn named(id: &str, name: &str) -> Timeline {
        Timeline {
            id: id.into(),
            name: name.into(),
            ..Default::default()
        }
    }

    fn three_timelines(tag: &str) -> (std::path::PathBuf, std::path::PathBuf, ProjectManifest) {
        let root = tmp(tag);
        let (dir, mut manifest) = new_project_in(&root, "Manage", &[]).unwrap();
        manifest.timelines = vec![named("a", "A"), named("b", "B"), named("c", "C")];
        manifest.active_timeline = 1;
        (root, dir, manifest)
    }

    #[test]
    fn create_seeds_the_active_rate_and_the_output_and_activates_on_request() {
        let (root, _dir, mut m) = three_timelines("create");
        m.timelines[1].rate = Some(apelles_types::Rational::new(30, 1));
        let spec = OutputSpec::new(1080, 1920).unwrap();
        let tl = create_timeline(&mut m, "  Short 1 ", Some(spec), false).unwrap();
        assert_eq!(tl.name, "Short 1", "trimmed");
        assert_eq!(
            tl.rate,
            Some(apelles_types::Rational::new(30, 1)),
            "B-284: the active rate, not 24"
        );
        assert_eq!(tl.output, Some(spec));
        assert_eq!(
            m.active_timeline, 1,
            "activate: false leaves the active one alone"
        );
        let tl2 = create_timeline(&mut m, "Short 2", None, true).unwrap();
        assert_eq!(m.timelines[m.active_timeline].id, tl2.id);
        assert!(
            create_timeline(&mut m, "   ", None, true).is_err(),
            "an empty name is refused"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rename_and_set_output_address_a_timeline_by_id() {
        let (root, _dir, mut m) = three_timelines("rename");
        rename_timeline(&mut m, "c", "Trailer").unwrap();
        assert_eq!(m.timelines[2].name, "Trailer");
        assert!(rename_timeline(&mut m, "c", "").is_err());
        assert_eq!(
            rename_timeline(&mut m, "zz", "x").unwrap_err(),
            "no timeline with id zz"
        );

        let spec = OutputSpec::new(1080, 1080).unwrap();
        set_timeline_output(&mut m, "a", Some(spec)).unwrap();
        assert_eq!(m.timelines[0].output, Some(spec));
        set_timeline_output(&mut m, "a", None).unwrap();
        assert_eq!(
            m.timelines[0].output, None,
            "None clears back to the project size"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn duplicate_is_independent_grades_included_and_lands_after_the_original() {
        let (root, dir, mut m) = three_timelines("duplicate");
        m.timelines[0].tracks = vec![Track {
            kind: TrackKind::Video,
            clips: vec![
                Clip {
                    id: "text-1".into(),
                    name: "t".into(),
                    duration: 10,
                    ..Default::default()
                },
                Clip {
                    id: "graded".into(),
                    name: "g".into(),
                    source_path: "/g.mov".into(),
                    duration: 10,
                    start_frame: 10,
                    link_group: Some("lg".into()),
                    ..Default::default()
                },
            ],
            ..Default::default()
        }];
        m.timelines[0].output = Some(OutputSpec::new(1080, 1920).unwrap());
        let grades = crate::grade_dir(&dir);
        std::fs::write(grades.join("graded.grade.json"), br#"{"exposure":1}"#).unwrap();

        let copy = duplicate_timeline(&dir, &mut m, "a", None, false).unwrap();
        assert_eq!(copy.name, "A copy");
        assert_ne!(copy.id, "a");
        assert_eq!(
            m.timelines[1].id, copy.id,
            "placed right after the original"
        );
        assert_eq!(
            m.timelines[m.active_timeline].id, "b",
            "the active timeline is still B"
        );
        assert_eq!(
            copy.output, m.timelines[0].output,
            "the output size travels with it"
        );

        let ids: Vec<&str> = copy.tracks[0].clips.iter().map(|c| c.id.as_str()).collect();
        assert!(
            ids[0].starts_with("text-1~"),
            "the id stem is kept: {}",
            ids[0]
        );
        assert!(ids[1].starts_with("graded~"));
        assert_eq!(copy.tracks[0].clips[1].link_group.as_deref(), Some("lg"));
        let copied = std::fs::read(grades.join(format!("{}.grade.json", ids[1]))).unwrap();
        assert_eq!(
            copied, br#"{"exposure":1}"#,
            "the grade was copied to the new id"
        );
        assert!(
            grades.join("graded.grade.json").is_file(),
            "the original keeps its grade"
        );
        // The original timeline is untouched.
        assert_eq!(m.timelines[0].tracks[0].clips[1].id, "graded");

        // Duplicating a duplicate replaces the suffix rather than stacking one.
        let again = duplicate_timeline(&dir, &mut m, &copy.id, Some("v3"), true).unwrap();
        let id = &again.tracks[0].clips[1].id;
        assert_eq!(id.matches('~').count(), 1, "{id}");
        assert_eq!(
            m.timelines[m.active_timeline].id, again.id,
            "activate: true"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn delete_keeps_a_sensible_active_timeline_and_refuses_the_last_one() {
        let (root, _dir, mut m) = three_timelines("delete");
        // Delete one BEFORE the active: the same timeline stays active.
        delete_timeline(&mut m, "a").unwrap();
        assert_eq!(m.timelines[m.active_timeline].id, "b");
        // Delete the active one: the next slides into its place.
        delete_timeline(&mut m, "b").unwrap();
        assert_eq!(m.timelines[m.active_timeline].id, "c");
        assert_eq!(
            delete_timeline(&mut m, "c").unwrap_err(),
            "cannot delete the project's only timeline"
        );

        let (root2, _dir2, mut m2) = three_timelines("delete_last");
        m2.active_timeline = 2;
        delete_timeline(&mut m2, "c").unwrap();
        assert_eq!(
            m2.timelines[m2.active_timeline].id, "b",
            "deleting the last hands focus back"
        );
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&root2);
    }

    #[test]
    fn a_timeline_that_is_not_active_resolves_by_id_off_disk() {
        let (root, dir, mut m) = three_timelines("by_id");
        m.timelines[2].output = Some(OutputSpec::new(1080, 1350).unwrap());
        m.settings.width = Some(1920);
        m.settings.height = Some(1080);
        save_manifest(&dir, &m).unwrap();
        let (tl, settings) = resolve_timeline_by_id_and_settings(&dir, "c").unwrap();
        assert_eq!(tl.id, "c");
        assert_eq!(tl.output.map(OutputSpec::size), Some((1080, 1350)));
        assert_eq!(settings.width, Some(1920));
        assert!(resolve_timeline_by_id_and_settings(&dir, "nope").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// D-411 Phase 0's compatibility promise, against a real `project.json`
    /// written by the shipped app before `Timeline.output`/`origin` existed
    /// (`tests/fixtures/pre_d411_project.json`, a scratch project with its
    /// media paths anonymised): it loads with neither field set, and saving it
    /// back writes the timelines out unchanged — no new keys, no reordering of
    /// values, nothing an older build could trip on.
    #[test]
    fn a_pre_d411_project_loads_and_saves_its_timelines_unchanged() {
        const FIXTURE: &str = include_str!("../tests/fixtures/pre_d411_project.json");
        let root = tmp("pre_d411");
        let dir = root.join("Old.chroma");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("project.json"), FIXTURE).unwrap();

        let manifest = load_manifest(&dir).unwrap();
        assert_eq!(manifest.timelines.len(), 1);
        assert!(manifest.timelines[0].output.is_none());
        assert!(manifest.timelines[0].origin.is_none());

        save_manifest(&dir, &manifest).unwrap();
        let before: serde_json::Value = serde_json::from_str(FIXTURE).unwrap();
        let after: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("project.json")).unwrap())
                .unwrap();
        assert_eq!(
            after["timelines"], before["timelines"],
            "the timelines round-trip exactly"
        );
        assert!(after["timelines"][0].get("output").is_none());
        assert!(after["timelines"][0].get("origin").is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn replace_keeps_the_id_cleans_the_name_and_checks_the_size() {
        let (root, _dir, mut m) = three_timelines("replace");
        let mut body = named("ignored", "  Short 1 ");
        body.output = Some(OutputSpec::new(1080, 1920).unwrap());
        replace_timeline(&mut m, "c", body).unwrap();
        assert_eq!(
            m.timelines[2].id, "c",
            "the id is the target's, not the body's"
        );
        assert_eq!(m.timelines[2].name, "Short 1");
        assert_eq!(m.timelines[2].output, OutputSpec::new(1080, 1920).ok());
        let mut bad = named("x", "Bad");
        bad.output = Some(OutputSpec {
            width: 1081,
            height: 1920,
        });
        assert!(
            replace_timeline(&mut m, "c", bad)
                .unwrap_err()
                .contains("even")
        );
        assert!(replace_timeline(&mut m, "nope", named("x", "X")).is_err());
        assert!(replace_timeline(&mut m, "c", named("x", "   ")).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn grades_are_copied_to_new_clip_ids_all_or_nothing() {
        let (root, dir, _m) = three_timelines("grades");
        let grades = crate::grade_dir(&dir);
        std::fs::create_dir_all(&grades).unwrap();
        std::fs::write(grades.join("clip-1.grade.json"), "{}").unwrap();
        let pairs = vec![
            ("clip-1".to_string(), "short-1".to_string()),
            ("ungraded".to_string(), "short-2".to_string()),
        ];
        assert_eq!(copy_clip_grades(&dir, &pairs).unwrap(), 1);
        assert!(grades.join("short-1.grade.json").is_file());
        assert!(!grades.join("short-2.grade.json").exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}

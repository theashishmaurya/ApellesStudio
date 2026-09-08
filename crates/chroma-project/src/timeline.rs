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

use chroma_timeline::Timeline;

use crate::{
    ProjectManifest, ProjectSettings, load_manifest, load_manifest_cached, now_rfc3339,
    resolve_shot, save_manifest,
};

/// Build a single-video-track timeline from a manifest's shots, resolving
/// each shot's source path/name via its `media_id` (D-046 — see
/// [`resolve_shot`]) and probing that path for its frame count (0 when
/// offline / not probe-able / dangling). Assigns a fresh id (D-045) —
/// `chroma-timeline` itself never generates one.
fn build_from_shots(manifest: &ProjectManifest) -> Timeline {
    let tuples: Vec<(String, String, String, i64)> = manifest
        .shots
        .iter()
        .map(|shot| {
            let (source_path, name) = resolve_shot(manifest, shot);
            let frames = chroma_media::probe::probe_cached(Path::new(&source_path))
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::new_project_in;
    use chroma_timeline::{Clip, Track, TrackKind};

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
            folder: None,
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
            folder: None,
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
        });
        manifest.timelines.push(Timeline {
            id: "t2".into(),
            name: "second".into(),
            rate: None,
            tracks: Vec::new(),
            markers: Vec::new(),
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
}

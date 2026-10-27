//! Clip runs on disk: `<project>/clips/<run-id>.json` (D-411 §5.2).
//!
//! **What it is.** The Automatic Clipper's persisted review state — one file
//! per run, written whole and atomically (a staging file, `fsync`, renamed over
//! the old one, as [`crate::save_manifest`] does), read back and checked
//! against `apelles_clipper::ClipRun`'s schema on the way in and out.
//!
//! **Why beside `project.json` and not inside it.** A run with forty
//! proposals and their resolved ranges is tens of kilobytes; the manifest is
//! rewritten on every debounced Edit save, and every one of those writes would
//! carry it. A run changes only when someone reviews it.
//!
//! **What it does NOT do.** Interpret a run beyond its schema (the clipper
//! store in `@apelles/editor` owns every change), or keep anything in memory:
//! each call reads or writes the file.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use apelles_clipper::ClipRun;
use apelles_clipper::run::is_valid_id;
use serde::Serialize;

/// The directory runs live in, inside a `.chroma` project directory.
pub const CLIPS_DIR: &str = "clips";

/// A run's listing row: enough for the Clipper panel's run picker and
/// `editor_list_clip_proposals` without reading every proposal.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipRunSummary {
    pub id: String,
    pub created_at: String,
    pub source_name: String,
    pub proposals: usize,
    pub built: usize,
}

/// A run file that could not be read, by name, so one bad file never hides
/// the others.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ClipRunLoadError {
    pub file: String,
    pub error: String,
}

fn run_path(project_dir: &Path, id: &str) -> Result<PathBuf, String> {
    if !is_valid_id(id) {
        return Err(format!(
            "clip run id {id:?} must be 1-64 characters of a-z, 0-9 and -"
        ));
    }
    Ok(project_dir.join(CLIPS_DIR).join(format!("{id}.json")))
}

/// Write `run` atomically. Refused, writing nothing, when it fails its schema.
pub fn save_clip_run(project_dir: &Path, run: &ClipRun) -> Result<(), String> {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    run.validate()?;
    let path = run_path(project_dir, &run.id)?;
    let dir = project_dir.join(CLIPS_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let body = serde_json::to_string_pretty(run).map_err(|e| format!("encode clip run: {e}"))?;
    let tmp = dir.join(format!(
        ".{}.{}.{}.tmp",
        run.id,
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let write = |p: &Path| -> std::io::Result<()> {
        let mut f = std::fs::File::create(p)?;
        f.write_all(body.as_bytes())?;
        f.write_all(b"\n")?;
        f.sync_all()
    };
    write(&tmp).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("replace {}: {e}", path.display())
    })
}

/// Read one run, checked against its schema.
pub fn load_clip_run(project_dir: &Path, id: &str) -> Result<ClipRun, String> {
    let path = run_path(project_dir, id)?;
    let raw = std::fs::read_to_string(&path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => format!("no clip run {id} in this project"),
        _ => format!("read {}: {e}", path.display()),
    })?;
    let run: ClipRun =
        serde_json::from_str(&raw).map_err(|e| format!("clip run {id} is not valid: {e}"))?;
    run.validate()
        .map_err(|e| format!("clip run {id} is not valid: {e}"))?;
    if run.id != id {
        return Err(format!("clip run file {id}.json holds run {:?}", run.id));
    }
    Ok(run)
}

/// Every run, newest first, plus the files that could not be read.
pub fn list_clip_runs(project_dir: &Path) -> (Vec<ClipRunSummary>, Vec<ClipRunLoadError>) {
    let dir = project_dir.join(CLIPS_DIR);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return (Vec::new(), Vec::new());
    };
    let mut rows = Vec::new();
    let mut errors = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(id) = name.strip_suffix(".json") else {
            continue;
        };
        if name.starts_with('.') {
            continue;
        }
        match load_clip_run(project_dir, id) {
            Ok(run) => rows.push(ClipRunSummary {
                id: run.id.clone(),
                created_at: run.created_at.clone(),
                source_name: match &run.source {
                    apelles_clipper::RunSource::Media { name, .. }
                    | apelles_clipper::RunSource::Timeline { name, .. } => name.clone(),
                },
                proposals: run.proposals.len(),
                built: run
                    .proposals
                    .iter()
                    .filter(|p| p.timeline_id.is_some())
                    .count(),
            }),
            Err(error) => errors.push(ClipRunLoadError { file: name, error }),
        }
    }
    rows.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(a.id.cmp(&b.id)));
    (rows, errors)
}

/// Remove one run's file. The timelines it built are untouched.
pub fn delete_clip_run(project_dir: &Path, id: &str) -> Result<(), String> {
    let path = run_path(project_dir, id)?;
    std::fs::remove_file(&path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => format!("no clip run {id} in this project"),
        _ => format!("remove {}: {e}", path.display()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use apelles_clipper::{
        Aspect, CLIP_RUN_SCHEMA, ClipProposal, ClipShape, ClipVerdict, PickedBy, ProposalStatus,
        RunSettings, RunSource, SegmentRef, TightenOptions,
    };

    fn scratch(tag: &str) -> PathBuf {
        let d =
            std::env::temp_dir().join(format!("apelles_clip_runs_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).expect("scratch dir");
        d
    }

    fn run(id: &str, created: &str) -> ClipRun {
        ClipRun {
            schema: CLIP_RUN_SCHEMA,
            id: id.into(),
            created_at: created.into(),
            source: RunSource::Timeline {
                timeline_id: "t-1".into(),
                track: 0,
                name: "Episode 12".into(),
            },
            settings: RunSettings {
                durations: vec![30, 60],
                count: 5,
                aspect: Aspect::Portrait,
                captions: "brand".into(),
                hook_first: true,
                tighten: TightenOptions::default(),
                range: None,
                focus: None,
            },
            view_id: None,
            proposals: vec![ClipProposal {
                id: "p1".into(),
                shape: ClipShape {
                    hook: None,
                    segments: vec![SegmentRef {
                        first_word: 0,
                        last_word: 9,
                    }],
                },
                title: "t".into(),
                reason: "r".into(),
                hook_line: None,
                picked_by: PickedBy::Client,
                view_id: "v".into(),
                rules_version: 1,
                verdict: ClipVerdict::Refused {
                    reason: apelles_clipper::ClipRefusal::NoSegments,
                    offending: vec![],
                },
                gate_notes: vec!["the clip has no segments".into()],
                status: ProposalStatus::Built,
                timeline_id: Some("t-9".into()),
                built_at: None,
            }],
        }
    }

    #[test]
    fn runs_round_trip_list_newest_first_and_delete() {
        let dir = scratch("roundtrip");
        save_clip_run(&dir, &run("run-a", "2026-10-27T10:00:00Z")).expect("save a");
        save_clip_run(&dir, &run("run-b", "2026-10-27T11:00:00Z")).expect("save b");
        let back = load_clip_run(&dir, "run-a").expect("load");
        assert_eq!(back.proposals[0].timeline_id.as_deref(), Some("t-9"));
        let (rows, errors) = list_clip_runs(&dir);
        assert!(errors.is_empty());
        assert_eq!(
            rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            ["run-b", "run-a"]
        );
        assert_eq!(
            (
                rows[0].proposals,
                rows[0].built,
                rows[0].source_name.as_str()
            ),
            (1, 1, "Episode 12")
        );
        delete_clip_run(&dir, "run-a").expect("delete");
        assert!(
            load_clip_run(&dir, "run-a")
                .unwrap_err()
                .contains("no clip run run-a")
        );
        // No staging files are left behind.
        let leftovers = std::fs::read_dir(dir.join(CLIPS_DIR))
            .expect("dir")
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(leftovers, 0);
    }

    #[test]
    fn a_bad_run_is_refused_and_a_bad_file_is_named_not_fatal() {
        let dir = scratch("bad");
        let mut bad = run("run-c", "2026-10-27T10:00:00Z");
        bad.settings.durations = vec![7];
        assert!(
            save_clip_run(&dir, &bad)
                .unwrap_err()
                .contains("7 s is not a target length")
        );
        assert!(save_clip_run(&dir, &run("../evil", "x")).is_err());
        save_clip_run(&dir, &run("run-d", "2026-10-27T10:00:00Z")).expect("save d");
        std::fs::write(dir.join(CLIPS_DIR).join("run-e.json"), "{not json").expect("write junk");
        let (rows, errors) = list_clip_runs(&dir);
        assert_eq!(rows.len(), 1);
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].file, "run-e.json");
        assert!(load_clip_run(&dir, "UPPER").is_err());
    }
}

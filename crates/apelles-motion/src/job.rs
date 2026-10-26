//! # Render jobs — a Motion render that survives, reports and resumes (D-398)
//!
//! **What it is:** the pure state of one multi-scene Motion render: the exact
//! manifest it renders from (a snapshot, identified by a content hash), one
//! [`SceneEntry`] per scene with its frame window and outcome, and the
//! transitions between them. [`JobState::view`] turns that plus "is a worker
//! alive" into the [`JobView`] the GUI and `motion_get_state` show, including
//! the state the old webview-owned loop could not have: `interrupted`.
//!
//! **What it does NOT do:** no rendering and no threads (the app layer's
//! worker runs [`crate::run_render`] per scene and drives these transitions),
//! no manifest parsing (windows arrive already computed), no event emission.
//! The only I/O is [`JobState::save`] / [`JobState::load`], an atomic JSON
//! write beside the project so a restart can find an interrupted job.
//!
//! **Why this exists (B-265, B-264, B-263).** The render loop used to be a
//! JavaScript loop in the webview: a reload killed it silently and the app then
//! reported `idle`; its frame windows came from one document while each scene's
//! content was read from another file; and it could only render everything.
//! Owned by the backend, the job holds the exact manifest it was started with,
//! persists every transition, survives a webview reload, and can render a
//! chosen subset or resume what is left.
//!
//! No wall clock and no randomness anywhere in here (CLAUDE.md's render-path
//! determinism): a job is identified by its manifest hash and its scene list.

use std::path::Path;

use serde::{Deserialize, Serialize};

/// Bumped on any incompatible change to the persisted shape; a file with
/// another value is treated as no job at all rather than guessed at.
pub const JOB_SCHEMA: u32 = 1;

/// One scene's absolute frame window, inclusive at both ends (Remotion's own
/// `--frames=a-b`), as the frontend computed it from the manifest it hands over.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneWindow {
    pub scene_id: String,
    pub start_frame: u32,
    pub end_frame: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SceneStatus {
    Pending,
    Done,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneEntry {
    pub scene_id: String,
    pub start_frame: u32,
    pub end_frame: u32,
    pub status: SceneStatus,
    /// The finished file, once `Done`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Whether the app layer has taken this finished scene into Sources and
    /// refreshed the Edit clips reading it. A scene can finish while no webview
    /// is listening; this is what makes it get delivered when one returns.
    #[serde(default)]
    pub reconciled: bool,
}

/// The persisted job. `finished` is set when the worker stopped on its own
/// (every scene done, or one failed); a job that is not `finished` and has no
/// live worker was cut off, which is the `interrupted` state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobState {
    pub schema: u32,
    /// Content hash of the snapshot manifest this job renders from.
    pub manifest_hash: String,
    pub scenes: Vec<SceneEntry>,
    /// The scene being rendered right now, while a worker is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current: Option<String>,
    pub finished: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failed_scene_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Where a job is, as one word. `Idle` also covers "never started".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobPhase {
    Idle,
    Running,
    Error,
    Interrupted,
}

/// A finished scene's file, for delivery to the app layer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneOutput {
    pub scene_id: String,
    pub output_path: String,
}

/// What the GUI and `motion_get_state` show. Every field is always present;
/// `None` means "does not apply", never zero.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobView {
    pub state: JobPhase,
    pub scenes_total: Option<usize>,
    pub scenes_done: usize,
    pub scene_id: Option<String>,
    pub failed_scene_id: Option<String>,
    pub error: Option<String>,
    pub done_scene_ids: Vec<String>,
    /// Scenes still to render: what `resume` would do. Empty when finished OK.
    pub remaining_scene_ids: Vec<String>,
    /// Finished scenes the app layer has not yet taken into Sources.
    pub unreconciled: Vec<SceneOutput>,
    /// Every finished scene's file, in scene order.
    pub outputs: Vec<SceneOutput>,
    pub manifest_hash: Option<String>,
}

impl JobView {
    /// The view before any job has ever existed for the project.
    pub fn none() -> Self {
        Self {
            state: JobPhase::Idle,
            scenes_total: None,
            scenes_done: 0,
            scene_id: None,
            failed_scene_id: None,
            error: None,
            done_scene_ids: Vec::new(),
            remaining_scene_ids: Vec::new(),
            unreconciled: Vec::new(),
            outputs: Vec::new(),
            manifest_hash: None,
        }
    }
}

/// Content hash of a snapshot manifest's bytes (blake3, lowercase hex). Stable
/// across runs and machines, which is what makes "same document" checkable.
pub fn hash_manifest(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}

impl JobState {
    /// A fresh job over `windows`, all pending.
    pub fn new(manifest_hash: String, windows: &[SceneWindow]) -> Self {
        Self {
            schema: JOB_SCHEMA,
            manifest_hash,
            scenes: windows
                .iter()
                .map(|w| SceneEntry {
                    scene_id: w.scene_id.clone(),
                    start_frame: w.start_frame,
                    end_frame: w.end_frame,
                    status: SceneStatus::Pending,
                    output_path: None,
                    error: None,
                    reconciled: false,
                })
                .collect(),
            current: None,
            finished: windows.is_empty(),
            failed_scene_id: None,
            error: None,
        }
    }

    /// Index of the next scene to render, in order.
    pub fn next_pending(&self) -> Option<usize> {
        self.scenes
            .iter()
            .position(|s| s.status == SceneStatus::Pending)
    }

    pub fn begin(&mut self, index: usize) {
        self.current = self.scenes.get(index).map(|s| s.scene_id.clone());
    }

    pub fn complete(&mut self, index: usize, output_path: String) {
        if let Some(s) = self.scenes.get_mut(index) {
            s.status = SceneStatus::Done;
            s.output_path = Some(output_path);
            s.error = None;
            s.reconciled = false;
        }
        self.current = None;
    }

    /// A scene failed: the job stops here (a failure is never skipped past, so
    /// the person knows exactly which scene and why).
    pub fn fail(&mut self, index: usize, error: String) {
        if let Some(s) = self.scenes.get_mut(index) {
            s.status = SceneStatus::Failed;
            s.error = Some(error.clone());
            self.failed_scene_id = Some(s.scene_id.clone());
        }
        self.error = Some(error);
        self.current = None;
        self.finished = true;
    }

    /// The worker ran out of scenes.
    pub fn finish(&mut self) {
        self.current = None;
        self.finished = true;
    }

    pub fn mark_reconciled(&mut self, scene_id: &str) {
        if let Some(s) = self.scenes.iter_mut().find(|s| s.scene_id == scene_id) {
            s.reconciled = true;
        }
    }

    /// Prepare to continue: failed scenes go back to pending, and so does a
    /// done scene whose file `file_exists` says is gone. The error clears and
    /// the job is no longer finished. Returns how many scenes are now pending.
    pub fn prepare_resume(&mut self, file_exists: impl Fn(&str) -> bool) -> usize {
        for s in &mut self.scenes {
            let lost = s.status == SceneStatus::Done
                && s.output_path.as_deref().is_none_or(|p| !file_exists(p));
            if s.status == SceneStatus::Failed || lost {
                s.status = SceneStatus::Pending;
                s.output_path = None;
                s.error = None;
                s.reconciled = false;
            }
        }
        self.current = None;
        self.error = None;
        self.failed_scene_id = None;
        self.finished = false;
        self.scenes
            .iter()
            .filter(|s| s.status == SceneStatus::Pending)
            .count()
    }

    /// Whether `resume` has anything to do: cut off, or stopped on a failure.
    pub fn is_resumable(&self, worker_alive: bool) -> bool {
        !worker_alive && (!self.finished || self.failed_scene_id.is_some())
    }

    /// The view of this job. `worker_alive` is whether a worker thread in THIS
    /// process is currently driving it; a job that was mid-flight with no live
    /// worker (the app restarted, the webview's process died, the worker
    /// panicked) is `Interrupted`.
    pub fn view(&self, worker_alive: bool) -> JobView {
        let done: Vec<String> = self
            .scenes
            .iter()
            .filter(|s| s.status == SceneStatus::Done)
            .map(|s| s.scene_id.clone())
            .collect();
        let remaining: Vec<String> = self
            .scenes
            .iter()
            .filter(|s| s.status != SceneStatus::Done)
            .map(|s| s.scene_id.clone())
            .collect();
        let state = if self.failed_scene_id.is_some() {
            JobPhase::Error
        } else if !self.finished && worker_alive {
            JobPhase::Running
        } else if !self.finished {
            JobPhase::Interrupted
        } else {
            JobPhase::Idle
        };
        JobView {
            state,
            scenes_total: Some(self.scenes.len()),
            scenes_done: done.len(),
            scene_id: if state == JobPhase::Running {
                self.current.clone()
            } else {
                None
            },
            failed_scene_id: self.failed_scene_id.clone(),
            error: self.error.clone(),
            done_scene_ids: done,
            remaining_scene_ids: if state == JobPhase::Idle {
                Vec::new()
            } else {
                remaining
            },
            unreconciled: self.outputs_where(|s| !s.reconciled),
            outputs: self.outputs_where(|_| true),
            manifest_hash: Some(self.manifest_hash.clone()),
        }
    }

    fn outputs_where(&self, keep: impl Fn(&SceneEntry) -> bool) -> Vec<SceneOutput> {
        self.scenes
            .iter()
            .filter(|s| s.status == SceneStatus::Done && keep(s))
            .filter_map(|s| {
                s.output_path.clone().map(|output_path| SceneOutput {
                    scene_id: s.scene_id.clone(),
                    output_path,
                })
            })
            .collect()
    }

    /// Persist atomically: write a sibling, then rename over the target, so a
    /// crash mid-write leaves the previous complete file, never half of one.
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = path.with_extension("json.tmp");
        let text = serde_json::to_string_pretty(self).map_err(std::io::Error::other)?;
        std::fs::write(&tmp, format!("{text}\n"))?;
        std::fs::rename(&tmp, path)
    }

    /// The persisted job, or `None` when there is none, it is unreadable, or it
    /// is from another schema. Never an error: "no usable job" is a state.
    pub fn load(path: &Path) -> Option<Self> {
        let text = std::fs::read_to_string(path).ok()?;
        let state: Self = serde_json::from_str(&text).ok()?;
        (state.schema == JOB_SCHEMA).then_some(state)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn windows() -> Vec<SceneWindow> {
        ["a", "b", "c"]
            .iter()
            .enumerate()
            .map(|(i, id)| SceneWindow {
                scene_id: (*id).into(),
                start_frame: i as u32 * 100,
                end_frame: i as u32 * 100 + 99,
            })
            .collect()
    }

    fn job() -> JobState {
        JobState::new(hash_manifest(b"{}"), &windows())
    }

    #[test]
    fn a_fresh_job_is_interrupted_without_a_worker_and_running_with_one() {
        let j = job();
        assert_eq!(j.view(false).state, JobPhase::Interrupted);
        assert_eq!(j.view(true).state, JobPhase::Running);
        assert_eq!(j.view(true).scenes_total, Some(3));
        assert_eq!(j.view(true).remaining_scene_ids, ["a", "b", "c"]);
    }

    #[test]
    fn scenes_complete_in_order_and_the_job_ends_idle() {
        let mut j = job();
        while let Some(i) = j.next_pending() {
            j.begin(i);
            assert_eq!(
                j.view(true).scene_id.as_deref(),
                Some(j.scenes[i].scene_id.as_str())
            );
            j.complete(i, format!("/r/{}.mp4", j.scenes[i].scene_id));
        }
        j.finish();
        let v = j.view(false);
        assert_eq!(v.state, JobPhase::Idle);
        assert_eq!((v.scenes_done, v.scenes_total), (3, Some(3)));
        assert!(v.remaining_scene_ids.is_empty());
        assert_eq!(v.done_scene_ids, ["a", "b", "c"]);
    }

    #[test]
    fn a_failure_stops_the_job_names_the_scene_and_is_error_not_idle() {
        let mut j = job();
        j.begin(0);
        j.complete(0, "/r/a.mp4".into());
        j.begin(1);
        j.fail(1, "remotion exited 1".into());
        let v = j.view(false);
        assert_eq!(v.state, JobPhase::Error);
        assert_eq!(v.failed_scene_id.as_deref(), Some("b"));
        assert_eq!(v.error.as_deref(), Some("remotion exited 1"));
        assert_eq!(v.remaining_scene_ids, ["b", "c"]);
        assert!(j.is_resumable(false));
    }

    #[test]
    fn resume_renders_only_what_is_left_and_redoes_a_lost_file() {
        let mut j = job();
        j.complete(0, "/r/a.mp4".into());
        j.complete(1, "/r/b.mp4".into());
        // cut off while c was rendering
        j.begin(2);
        assert!(j.is_resumable(false));
        assert!(!j.is_resumable(true), "a live worker is not resumable");
        // b's file has been deleted since
        let pending = j.prepare_resume(|p| p == "/r/a.mp4");
        assert_eq!(pending, 2);
        assert_eq!(j.next_pending(), Some(1));
        assert_eq!(j.scenes[0].status, SceneStatus::Done);
        assert!(!j.finished && j.error.is_none() && j.current.is_none());
    }

    #[test]
    fn delivery_is_tracked_per_scene_until_acknowledged() {
        let mut j = job();
        j.complete(0, "/r/a.mp4".into());
        j.complete(1, "/r/b.mp4".into());
        assert_eq!(
            j.view(true).unreconciled,
            vec![
                SceneOutput {
                    scene_id: "a".into(),
                    output_path: "/r/a.mp4".into()
                },
                SceneOutput {
                    scene_id: "b".into(),
                    output_path: "/r/b.mp4".into()
                },
            ]
        );
        j.mark_reconciled("a");
        assert_eq!(j.view(true).unreconciled.len(), 1);
        // a re-render of a scene needs delivering again
        j.complete(0, "/r/a.mp4".into());
        assert_eq!(j.view(true).unreconciled.len(), 2);
    }

    #[test]
    fn an_empty_job_is_idle_at_once() {
        let j = JobState::new(hash_manifest(b"{}"), &[]);
        assert_eq!(j.view(false).state, JobPhase::Idle);
    }

    #[test]
    fn persistence_round_trips_atomically_and_rejects_a_foreign_schema() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("motion").join("render-job.json");
        let mut j = job();
        j.complete(0, "/r/a.mp4".into());
        j.save(&path).expect("save");
        assert!(
            !path.with_extension("json.tmp").exists(),
            "no temp file left behind"
        );
        assert_eq!(JobState::load(&path), Some(j.clone()));

        let mut foreign = j;
        foreign.schema = JOB_SCHEMA + 1;
        foreign.save(&path).expect("save");
        assert_eq!(JobState::load(&path), None);
        assert_eq!(JobState::load(&dir.path().join("missing.json")), None);
    }

    #[test]
    fn the_manifest_hash_is_stable_and_content_addressed() {
        assert_eq!(hash_manifest(b"abc"), hash_manifest(b"abc"));
        assert_ne!(hash_manifest(b"abc"), hash_manifest(b"abd"));
        assert_eq!(hash_manifest(b"abc").len(), 64);
    }
}

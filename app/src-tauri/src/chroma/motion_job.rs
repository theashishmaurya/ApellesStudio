//! motion_job.rs — the backend-owned Motion render job (D-398).
//!
//! What it is: the Tauri commands that start, watch, acknowledge and resume a
//! multi-scene Motion render, and the worker thread that runs it.
//! What it does: `chroma_motion_job_start` snapshots the exact manifest the
//!   caller computed its frame windows from into
//!   `<project>/motion/render-job/manifest.json` (B-264), persists the job
//!   (`render-job/job.json`, B-265), and renders the chosen scenes (B-263) one
//!   after another on a worker thread of this process, so a webview reload does
//!   not touch it. Every transition is persisted and emitted as the
//!   `chroma://motion-render` event carrying the job's [`JobView`].
//!   `chroma_motion_job_status` answers from memory while a worker is alive and
//!   from the persisted file otherwise, which is how a restarted app learns the
//!   job was `interrupted` and what is left. `resume` continues a cut-off or
//!   failed job from its own snapshot. `chroma_motion_job_ack` records that the
//!   app layer has taken a finished scene into Sources (D-062/D-260), so a scene
//!   that finished while no webview was listening is delivered when one returns.
//! What it does NOT do: compute frame windows or read the manifest's shape (the
//!   frontend owns `sceneStartFrame`/`sceneDurationFrames`; this side is shape
//!   agnostic, as `motion.rs` always was), import into the media pool, or run
//!   two jobs at once: one render at a time (D-046).
//!
//! The pure state machine and its persistence are `apelles_motion::job`; the
//! per-scene render, atomic replace and decode-pipe invalidation are
//! `motion::render_scene_file`.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use apelles_motion::job::{JobState, JobView, SceneWindow, hash_manifest};
use serde_json::Value;
use tauri::Emitter;

use super::motion::{default_output_path, render_scene_file};
use super::state;

/// The event every job transition is emitted on, with a [`JobView`] payload.
pub const RENDER_EVENT: &str = "chroma://motion-render";

/// A job a worker thread in this process is driving right now.
struct ActiveJob {
    project_dir: PathBuf,
    state: Arc<Mutex<JobState>>,
}

static ACTIVE: Mutex<Option<ActiveJob>> = Mutex::new(None);

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    // A panicked worker poisons the lock; the data is still the last complete
    // state, and refusing to read it would hide exactly the failure to report.
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn current_project_dir() -> Result<PathBuf, String> {
    state::current_project()
        .map(|p| p.path)
        .ok_or_else(|| "no project open — open one in the Colorist tab".to_string())
}

fn job_dir(project_dir: &Path) -> PathBuf {
    project_dir.join("motion").join("render-job")
}

fn snapshot_path(project_dir: &Path) -> PathBuf {
    job_dir(project_dir).join("manifest.json")
}

fn job_path(project_dir: &Path) -> PathBuf {
    job_dir(project_dir).join("job.json")
}

/// The live state when a worker is driving a job for `project_dir`.
fn active_state(project_dir: &Path) -> Option<Arc<Mutex<JobState>>> {
    lock(&ACTIVE)
        .as_ref()
        .filter(|a| a.project_dir == project_dir)
        .map(|a| Arc::clone(&a.state))
}

/// The job's view for `project_dir`: live if a worker is running it, else the
/// persisted file, else "nothing has ever run".
fn view_for(project_dir: &Path) -> JobView {
    if let Some(state) = active_state(project_dir) {
        return lock(&state).view(true);
    }
    JobState::load(&job_path(project_dir))
        .map(|j| j.view(false))
        .unwrap_or_else(JobView::none)
}

/// Clears the in-process registration when the worker ends for ANY reason,
/// including a panic, so a dead worker can never read as a running one.
struct WorkerGuard;

impl Drop for WorkerGuard {
    fn drop(&mut self) {
        *lock(&ACTIVE) = None;
    }
}

fn persist_and_emit(app: &tauri::AppHandle, project_dir: &Path, state: &Mutex<JobState>) {
    let snapshot = lock(state).clone();
    if let Err(e) = snapshot.save(&job_path(project_dir)) {
        // Not fatal to the render, but it is exactly what makes a restart see
        // `interrupted`, so it must be loud.
        log::error!("[chroma::motion] could not persist the render job: {e}");
    }
    if let Err(e) = app.emit(RENDER_EVENT, snapshot.view(true)) {
        log::warn!("[chroma::motion] could not emit the render event: {e}");
    }
}

/// The worker: render every pending scene in order from the job's snapshot.
fn run_worker(app: tauri::AppHandle, project_dir: PathBuf, state: Arc<Mutex<JobState>>) {
    let _guard = WorkerGuard;
    let snapshot = snapshot_path(&project_dir);
    loop {
        let (index, window) = {
            let mut s = lock(&state);
            match s.next_pending() {
                Some(i) => {
                    s.begin(i);
                    (i, s.scenes[i].clone())
                }
                None => {
                    s.finish();
                    break;
                }
            }
        };
        persist_and_emit(&app, &project_dir, &state);

        let out = default_output_path(&project_dir, Some(&window.scene_id));
        let result = render_scene_file(
            &snapshot,
            &out,
            (window.start_frame, window.end_frame),
            &window.scene_id,
        );
        let mut s = lock(&state);
        match result {
            Ok(done) => s.complete(index, done.output_path),
            Err(error) => {
                s.fail(index, error);
                drop(s);
                persist_and_emit(&app, &project_dir, &state);
                return;
            }
        }
        drop(s);
        persist_and_emit(&app, &project_dir, &state);
    }
    persist_and_emit(&app, &project_dir, &state);
}

/// Start (or, with `resume`, continue) a render job.
///
/// Fresh: `manifest` is the exact document `windows` were computed from; it is
/// written as the job's snapshot and every scene in `windows` is rendered, in
/// that order (the caller passes a subset to render only those scenes).
/// Resume: `manifest` and `windows` are ignored; the stored job's own snapshot
/// and scene list continue, with failed scenes and finished scenes whose file
/// has gone back to pending.
///
/// Refuses while a worker is running, and refuses a resume when there is
/// nothing to resume.
#[tauri::command]
pub async fn chroma_motion_job_start(
    app: tauri::AppHandle,
    manifest: Option<Value>,
    windows: Vec<SceneWindow>,
    resume: bool,
) -> Result<JobView, String> {
    let project_dir = current_project_dir()?;
    {
        let active = lock(&ACTIVE);
        if active.is_some() {
            return Err(
                "a Motion render is already running — wait for it, or poll its status".into(),
            );
        }
    }
    // D-417 — refuse before writing a snapshot or a job, so "the runtime is still
    // downloading" is the answer, not a scene that failed.
    super::motion_runtime::require()?;

    let state = if resume {
        let mut job = JobState::load(&job_path(&project_dir))
            .ok_or_else(|| "there is no interrupted render to resume".to_string())?;
        if !job.is_resumable(false) {
            return Err("the last render finished; there is nothing to resume".into());
        }
        if !snapshot_path(&project_dir).is_file() {
            return Err(
                "the interrupted render's manifest snapshot is missing; start a new render".into(),
            );
        }
        job.prepare_resume(|p| Path::new(p).is_file());
        job
    } else {
        let manifest = manifest
            .ok_or_else(|| "a new render needs the manifest it was planned from".to_string())?;
        if windows.is_empty() {
            return Err("no scenes to render".into());
        }
        let text = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
        let snapshot = snapshot_path(&project_dir);
        if let Some(parent) = snapshot.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("create {}: {e}", parent.display()))?;
        }
        std::fs::write(&snapshot, format!("{text}\n"))
            .map_err(|e| format!("write {}: {e}", snapshot.display()))?;
        JobState::new(hash_manifest(text.as_bytes()), &windows)
    };

    let view = state.view(true);
    let state = Arc::new(Mutex::new(state));
    {
        let mut active = lock(&ACTIVE);
        if active.is_some() {
            return Err(
                "a Motion render is already running — wait for it, or poll its status".into(),
            );
        }
        *active = Some(ActiveJob {
            project_dir: project_dir.clone(),
            state: Arc::clone(&state),
        });
    }
    persist_and_emit(&app, &project_dir, &state);
    tauri::async_runtime::spawn_blocking(move || run_worker(app, project_dir, state));
    Ok(view)
}

/// The job's current view; `state: "idle"` with null counts when none has run.
#[tauri::command]
pub fn chroma_motion_job_status() -> Result<JobView, String> {
    Ok(view_for(&current_project_dir()?))
}

/// Record that the app layer has taken `scene_id`'s finished file into Sources.
#[tauri::command]
pub fn chroma_motion_job_ack(scene_id: String) -> Result<(), String> {
    let project_dir = current_project_dir()?;
    if let Some(state) = active_state(&project_dir) {
        let snapshot = {
            let mut s = lock(&state);
            s.mark_reconciled(&scene_id);
            s.clone()
        };
        return snapshot
            .save(&job_path(&project_dir))
            .map_err(|e| format!("could not persist the render job: {e}"));
    }
    if let Some(mut job) = JobState::load(&job_path(&project_dir)) {
        job.mark_reconciled(&scene_id);
        job.save(&job_path(&project_dir))
            .map_err(|e| format!("could not persist the render job: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use apelles_motion::job::JobPhase;

    fn windows() -> Vec<SceneWindow> {
        vec![
            SceneWindow {
                scene_id: "a".into(),
                start_frame: 0,
                end_frame: 9,
            },
            SceneWindow {
                scene_id: "b".into(),
                start_frame: 10,
                end_frame: 19,
            },
        ]
    }

    /// A job file left behind by a process that was cut off reads as
    /// `interrupted` to the next one, with what is left to do — the B-265
    /// "never a blank idle" guarantee, through the same path the status command
    /// takes (no worker registered, persisted file only).
    #[test]
    fn a_persisted_unfinished_job_reads_as_interrupted_after_a_restart() {
        let dir = tempfile::tempdir().expect("tempdir");
        let project = dir.path().join("P.chroma");
        let mut job = JobState::new(hash_manifest(b"{}"), &windows());
        job.begin(0);
        job.complete(0, "/r/a.mp4".into());
        job.begin(1);
        job.save(&job_path(&project)).expect("save");

        let view = view_for(&project);
        assert_eq!(view.state, JobPhase::Interrupted);
        assert_eq!(view.done_scene_ids, ["a"]);
        assert_eq!(view.remaining_scene_ids, ["b"]);
        assert_eq!(view.scenes_total, Some(2));
    }

    #[test]
    fn a_project_that_never_rendered_reads_as_idle_with_no_counts() {
        let dir = tempfile::tempdir().expect("tempdir");
        let view = view_for(&dir.path().join("Never.chroma"));
        assert_eq!(view.state, JobPhase::Idle);
        assert_eq!(view.scenes_total, None);
    }

    #[test]
    fn the_job_files_live_under_the_projects_motion_directory() {
        let p = PathBuf::from("/p/X.chroma");
        assert_eq!(
            snapshot_path(&p),
            PathBuf::from("/p/X.chroma/motion/render-job/manifest.json")
        );
        assert_eq!(
            job_path(&p),
            PathBuf::from("/p/X.chroma/motion/render-job/job.json")
        );
    }
}

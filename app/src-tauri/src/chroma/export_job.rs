//! **The Edit tab export's job lifecycle around its encoders: the output folder,
//! a real Cancel, and the partial-file cleanup a cancel owes (D-441, B-367).**
//!
//! What it is: the small piece of process-global state that lets the Export
//! panel's Cancel (and `editor_cancel_export`) stop an export that is already
//! running — on either renderer — and leave nothing half-written behind.
//!
//! - [`register`] opens a [`CancelGuard`] under the export queue's job id (the
//!   caller's `cancelToken`). Every ffmpeg the export spawns is [`attach`]ed to
//!   it.
//! - [`cancel`] marks that token cancelled and kills every attached child at
//!   once. A token that is not running yet is remembered, so an export whose
//!   job was cancelled in the instant between the queue starting it and its
//!   first ffmpeg spawning is refused at [`register`] instead of running anyway.
//! - [`discard_partial_output`] removes the output file and the loudness pass's
//!   scratch siblings once a cancelled run has unwound.
//!
//! The runner consults it: `edit_render::render_timeline` (N segment encoders
//! and a concat step; D-448 deleted the filter-graph runner). The compositor's own
//! segment temp directory is a `tempfile::TempDir` and removes itself when the
//! render unwinds.
//!
//! What it does NOT do:
//! - **Schedule or queue.** The queue is `exportQueueStore.ts` (D-198). A job
//!   that is still `queued` is cancelled there and never reaches this module.
//! - **Kill the loudness pass's own ffmpeg.** `apelles_media::loudness` runs
//!   its measure / re-mux attempts as short blocking calls with no handle to
//!   hold. A cancel during that phase is honoured when it returns (seconds:
//!   audio only, the picture is copied) and the file is discarded then.
//! - **Know about argv.** It holds children, not command lines.
//!
//! [`attach`]: CancelGuard::attach

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

use shared_child::SharedChild;

/// The reason a cancelled run returns, so both runners word it the same way.
pub const CANCELLED_MESSAGE: &str = "the export was cancelled; its partial file was removed";

/// One running export's cancel state.
pub struct CancelHandle {
    cancelled: AtomicBool,
    children: Mutex<Vec<Arc<SharedChild>>>,
}

impl CancelHandle {
    fn new() -> Self {
        Self {
            cancelled: AtomicBool::new(false),
            children: Mutex::new(Vec::new()),
        }
    }

    /// Has this export been cancelled? The compositor's per-frame loop checks
    /// it next to its own abort flag.
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }

    /// Hold `child` so a cancel can kill it. A child attached after the cancel
    /// already happened is killed straight away: there is no window in which a
    /// late spawn outlives the cancel that should have stopped it.
    pub fn attach(&self, child: &Arc<SharedChild>) {
        let mut held = self.children.lock().unwrap_or_else(|e| e.into_inner());
        if self.is_cancelled() {
            drop(held);
            if let Err(e) = child.kill() {
                log::warn!("[chroma::export_job] killing a child spawned after cancel: {e}");
            }
            return;
        }
        held.push(child.clone());
    }

    fn cancel(&self) {
        // The flag first, under the lock `attach` takes, so a concurrent
        // attach either lands in the list killed below or sees the flag.
        let held = {
            let mut held = self.children.lock().unwrap_or_else(|e| e.into_inner());
            self.cancelled.store(true, Ordering::Relaxed);
            std::mem::take(&mut *held)
        };
        for child in held {
            // Already exited is the common, harmless case.
            if let Err(e) = child.kill() {
                log::debug!("[chroma::export_job] kill on cancel: {e}");
            }
        }
    }
}

/// The registration for one run. Unregisters when dropped, however the run
/// ends.
pub struct CancelGuard {
    token: String,
    handle: Arc<CancelHandle>,
}

impl CancelGuard {
    pub fn handle(&self) -> &Arc<CancelHandle> {
        &self.handle
    }

    pub fn is_cancelled(&self) -> bool {
        self.handle.is_cancelled()
    }

    pub fn attach(&self, child: &Arc<SharedChild>) {
        self.handle.attach(child);
    }
}

impl Drop for CancelGuard {
    fn drop(&mut self) {
        let mut reg = registry();
        reg.live.remove(&self.token);
        reg.cancelled.remove(&self.token);
    }
}

#[derive(Default)]
struct Registry {
    live: HashMap<String, Arc<CancelHandle>>,
    /// Tokens cancelled before (or without) a live run. Bounded by
    /// [`MAX_EARLY_CANCELS`] so a caller cancelling ids that never run cannot
    /// grow it without limit.
    cancelled: HashSet<String>,
}

static REGISTRY: LazyLock<Mutex<Registry>> = LazyLock::new(|| Mutex::new(Registry::default()));

/// Ids that only ever exist inside the registry, for a run with no token.
static ANON: AtomicU64 = AtomicU64::new(1);

/// How many early cancels are remembered at once. The queue runs one export at
/// a time (D-198), so in practice this holds zero or one.
const MAX_EARLY_CANCELS: usize = 64;

fn registry() -> std::sync::MutexGuard<'static, Registry> {
    REGISTRY.lock().unwrap_or_else(|e| e.into_inner())
}

/// Open a cancel registration for one run under `token` (the export queue's job
/// id). `None` gets a private token nobody can cancel — a direct caller such as
/// a test or a legacy request.
///
/// Refused when `token` was cancelled before the run got here: the job was
/// cancelled while it was being started, and starting it anyway would write the
/// file the person just said they did not want.
pub fn register(token: Option<&str>) -> Result<CancelGuard, String> {
    let token = match token {
        Some(t) if !t.is_empty() => t.to_string(),
        _ => format!("anon-{}", ANON.fetch_add(1, Ordering::Relaxed)),
    };
    let mut reg = registry();
    if reg.cancelled.remove(&token) {
        return Err(CANCELLED_MESSAGE.to_string());
    }
    if reg.live.contains_key(&token) {
        return Err(format!("an export with job id {token} is already running"));
    }
    let handle = Arc::new(CancelHandle::new());
    reg.live.insert(token.clone(), handle.clone());
    Ok(CancelGuard { token, handle })
}

/// What [`cancel`] did.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelOutcome {
    /// `true` when a running export with this id was stopped now; `false` when
    /// none was running (it is then refused if it starts).
    pub was_running: bool,
}

/// Cancel the export running under `token`, or the one about to start under it.
pub fn cancel(token: &str) -> CancelOutcome {
    let handle = {
        let mut reg = registry();
        match reg.live.get(token).cloned() {
            Some(h) => Some(h),
            None => {
                if reg.cancelled.len() >= MAX_EARLY_CANCELS {
                    reg.cancelled.clear();
                }
                reg.cancelled.insert(token.to_string());
                None
            }
        }
    };
    match handle {
        Some(h) => {
            h.cancel();
            CancelOutcome { was_running: true }
        }
        None => CancelOutcome { was_running: false },
    }
}

/// Remove what a cancelled run left behind: the output file and the loudness
/// pass's scratch siblings. Each is removed only if it exists; a missing file is
/// the expected case for most of them.
pub fn discard_partial_output(output: &Path) {
    let mut paths: Vec<PathBuf> = vec![output.to_path_buf()];
    paths.extend(apelles_media::loudness::scratch_paths(output));
    for p in paths {
        match std::fs::remove_file(&p) {
            Ok(()) => log::info!("[chroma::export_job] removed partial {}", p.display()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => log::warn!("[chroma::export_job] could not remove {}: {e}", p.display()),
        }
    }
}

/// Create the folder an export writes into. The Export panel's default is
/// `~/Movies/<project>/`, which does not exist until the first export, and
/// ffmpeg does not create folders.
pub fn ensure_output_dir(output: &Path) -> Result<(), String> {
    match output.parent() {
        Some(dir) if !dir.as_os_str().is_empty() => std::fs::create_dir_all(dir)
            .map_err(|e| format!("could not create the export folder {}: {e}", dir.display())),
        _ => Ok(()),
    }
}

/// The first `<dir>/<stem>.<ext>`, `<dir>/<stem> 2.<ext>`, … that does not
/// exist yet: the Export panel's pre-filled "Save as", so a second export of the
/// same timeline never silently overwrites the first (ffmpeg runs with `-y`).
/// Characters macOS and ffmpeg both dislike in a file name (`/`, `:`) are
/// replaced; an empty stem becomes "Export".
pub fn unused_export_path(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let clean: String = stem
        .chars()
        .map(|c| {
            if matches!(c, '/' | ':' | '\0') {
                '-'
            } else {
                c
            }
        })
        .collect();
    let clean = clean.trim();
    let stem = if clean.is_empty() { "Export" } else { clean };
    let first = dir.join(format!("{stem}.{ext}"));
    if !first.exists() {
        return first;
    }
    (2..)
        .map(|n| dir.join(format!("{stem} {n}.{ext}")))
        .find(|p| !p.exists())
        .unwrap_or(first)
}

/// [`unused_export_path`] for the Export panel and `editor_export`'s default
/// `out_path`.
#[tauri::command]
pub fn chroma_unused_export_path(dir: String, stem: String, ext: String) -> String {
    unused_export_path(Path::new(&dir), &stem, &ext)
        .to_string_lossy()
        .into_owned()
}

/// The Export panel's Cancel and `editor_cancel_export`: stop the export
/// running under the queue job id `token` (or refuse it when it starts).
#[tauri::command]
pub fn chroma_cancel_editor_export(token: String) -> CancelOutcome {
    cancel(&token)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};

    /// A real child that would run for a long time unless killed.
    fn sleeper() -> Arc<SharedChild> {
        let mut cmd = Command::new("sleep");
        cmd.arg("30").stdout(Stdio::null()).stderr(Stdio::null());
        Arc::new(SharedChild::spawn(&mut cmd).expect("spawn sleep"))
    }

    #[test]
    fn cancel_kills_every_attached_child_and_marks_the_run() {
        let guard = register(Some("job-kill")).expect("register");
        let a = sleeper();
        let b = sleeper();
        guard.attach(&a);
        guard.attach(&b);
        let out = cancel("job-kill");
        assert!(out.was_running);
        assert!(guard.is_cancelled());
        for child in [a, b] {
            let status = child
                .wait_timeout(std::time::Duration::from_secs(5))
                .expect("wait")
                .expect("the child must have exited after the cancel");
            assert!(!status.success(), "a killed child does not exit 0");
        }
    }

    #[test]
    fn a_child_attached_after_the_cancel_is_killed_at_once() {
        let guard = register(Some("job-late")).expect("register");
        cancel("job-late");
        let late = sleeper();
        guard.attach(&late);
        assert!(
            late.wait_timeout(std::time::Duration::from_secs(5))
                .expect("wait")
                .is_some(),
            "a spawn after the cancel must not outlive it"
        );
    }

    #[test]
    fn a_job_cancelled_before_it_starts_is_refused_when_it_does() {
        let out = cancel("job-early");
        assert!(!out.was_running);
        let refused = register(Some("job-early"));
        assert!(refused.is_err(), "the run must not start");
        // The early cancel is consumed: a later run under a new id is fine,
        // and so is a re-run under the same id.
        assert!(register(Some("job-early")).is_ok());
    }

    #[test]
    fn dropping_the_guard_unregisters_the_run() {
        {
            let _g = register(Some("job-drop")).expect("register");
            assert!(register(Some("job-drop")).is_err(), "one run per id");
        }
        assert!(register(Some("job-drop")).is_ok());
    }

    #[test]
    fn discard_removes_the_output_and_the_loudness_scratch_files() {
        let dir = tempfile::tempdir().expect("tempdir");
        let out = dir.path().join("Short 1.mov");
        std::fs::write(&out, b"partial").expect("write");
        let scratch = apelles_media::loudness::scratch_paths(&out);
        for p in &scratch {
            std::fs::write(p, b"tmp").expect("write scratch");
        }
        let keep = dir.path().join("other.mov");
        std::fs::write(&keep, b"keep").expect("write");
        discard_partial_output(&out);
        assert!(!out.exists());
        for p in &scratch {
            assert!(!p.exists(), "{} must be removed", p.display());
        }
        assert!(keep.exists(), "nothing else in the folder is touched");
    }

    #[test]
    fn the_default_name_never_overwrites_an_earlier_export() {
        let dir = tempfile::tempdir().expect("tempdir");
        let first = unused_export_path(dir.path(), "Voiceover v2", "mp4");
        assert_eq!(first, dir.path().join("Voiceover v2.mp4"));
        std::fs::write(&first, b"x").expect("write");
        assert_eq!(
            unused_export_path(dir.path(), "Voiceover v2", "mp4"),
            dir.path().join("Voiceover v2 2.mp4")
        );
        assert_eq!(
            unused_export_path(dir.path(), "a/b: c", "mov"),
            dir.path().join("a-b- c.mov")
        );
        assert_eq!(
            unused_export_path(dir.path(), "  ", "mp4"),
            dir.path().join("Export.mp4")
        );
    }

    #[test]
    fn the_output_folder_is_created_when_missing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let out = dir.path().join("Movies").join("My project").join("v1.mp4");
        ensure_output_dir(&out).expect("create");
        assert!(out.parent().is_some_and(Path::is_dir));
    }
}

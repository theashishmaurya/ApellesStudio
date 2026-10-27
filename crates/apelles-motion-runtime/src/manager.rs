//! The process-wide runtime manager: the configured layout, the one install
//! job, and the status every surface reads (D-417).
//!
//! **What it is:** [`configure`] once at app start (the layout comes from the
//! app, which alone knows whether it is a dev run and where Resources / app data
//! are); [`status`] for the GUI banner, `motion_runtime_status` and the launch
//! log; [`start_install`] to download in the background (at most one install at
//! a time); [`remove`] for "Remove Motion runtime"; [`require`] for every render
//! path, which answers either a [`MotionRuntime`] or an error whose first word
//! is [`NOT_READY_CODE`] — the same machine signal shape as
//! `apelles_ai::ai_env::NOT_READY_CODE`.
//!
//! **What it does NOT do:** decide WHEN to install. The Motion tab asks the
//! first time it opens (the owner's decision, D-391/D-417) and an agent can ask
//! with `motion_install_runtime`; nothing installs at launch, and a failure is
//! not retried on a timer — Retry is a click or a call.
//!
//! The pure part — turning a job snapshot and a resolution into a
//! [`RuntimeStatus`] — is [`compose`], unit-tested; the globals are a thin shell.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock};

use serde::Serialize;

use crate::error::RuntimeError;
use crate::locate::{self, Env, Layout, MotionRuntime, NotReady, RuntimeSource};
use crate::pins;
use crate::store::{self, InstallState, Progress, Source, Step};

/// The first word of every "the runtime is not there yet" render error.
pub const NOT_READY_CODE: &str = "motion_runtime_not_ready";
/// A progress notification is sent at most once per this many downloaded bytes
/// (and on every step change), so a 160 MB download is ~160 events, not 2,500.
const NOTIFY_EVERY_BYTES: u64 = 1024 * 1024;

/// The wire state (`camelCase`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum State {
    /// `configure` has not run (the first instant of a launch).
    Unconfigured,
    /// Renders work now.
    Ready,
    /// Nothing installed yet.
    Missing,
    /// A runtime for older pins is installed; an install replaces it.
    Outdated,
    /// The current runtime failed the integrity check; an install repairs it.
    Broken,
    /// Downloading / unpacking.
    Installing,
    /// The last install failed (see `errorKind` / `error`); nothing is retried
    /// until someone asks.
    Failed,
    /// "Remove Motion runtime" is deleting it.
    Removing,
}

/// Every pinned version, for display and for the notices.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Versions {
    pub node: &'static str,
    pub chrome: &'static str,
    pub remotion: &'static str,
}

/// What `motion_runtime_status` and the Motion tab show.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub state: State,
    /// One sentence a person can read.
    pub detail: String,
    /// Which rung answered, when `ready`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<RuntimeSource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step: Option<Step>,
    /// What is downloading / unpacking now.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub bytes_done: u64,
    pub bytes_total: u64,
    /// The whole download, for "Download (160 MB)".
    pub download_bytes: u64,
    /// Bytes the managed runtime takes on disk (0 when none is installed).
    pub installed_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// The Node renders run with, when `ready`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node: Option<String>,
    /// Where the managed runtime lives.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_dir: Option<String>,
    pub versions: Versions,
    /// An install would do something (not ready from the managed runtime, not busy).
    pub can_install: bool,
    /// There is a managed runtime (or leftovers) to remove, and nothing is busy.
    pub can_remove: bool,
}

/// The install job, as `compose` needs it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum Job {
    #[default]
    Idle,
    Installing(Option<Progress>),
    Removing,
    Failed {
        kind: String,
        message: String,
    },
}

/// Turn the job and what the resolver found into the status (pure).
pub fn compose(
    job: &Job,
    resolved: &Result<MotionRuntime, NotReady>,
    root: &Path,
    installed_bytes: u64,
) -> RuntimeStatus {
    let mut s = RuntimeStatus {
        state: State::Missing,
        detail: String::new(),
        source: None,
        step: None,
        label: None,
        bytes_done: 0,
        bytes_total: pins::total_download_bytes(),
        download_bytes: pins::total_download_bytes(),
        installed_bytes,
        error_kind: None,
        error: None,
        node: None,
        runtime_dir: None,
        versions: Versions {
            node: pins::NODE_VERSION,
            chrome: pins::CHROME_VERSION,
            remotion: pins::REMOTION_VERSION,
        },
        can_install: false,
        can_remove: false,
    };
    let managed_ready = matches!(resolved, Ok(rt) if rt.source == RuntimeSource::Managed);
    if let Ok(rt) = resolved {
        s.source = Some(rt.source);
        s.node = Some(rt.node.display().to_string());
    }
    if managed_ready || installed_bytes > 0 {
        s.runtime_dir = Some(root.display().to_string());
    }
    let busy = matches!(job, Job::Installing(_) | Job::Removing);
    s.can_install = !busy && !managed_ready;
    s.can_remove = !busy && installed_bytes > 0;
    match job {
        Job::Installing(p) => {
            s.state = State::Installing;
            if let Some(p) = p {
                s.step = Some(p.step);
                s.label = Some(p.label.clone());
                s.bytes_done = p.bytes_done;
                s.bytes_total = p.bytes_total;
            }
            s.detail = match s.step {
                Some(Step::Unpacking) => format!("Unpacking {}", s.label.as_deref().unwrap_or("")),
                Some(Step::Finishing) => "Finishing the Motion runtime install".to_string(),
                _ => format!(
                    "Downloading Motion's render runtime ({} of {} MB)",
                    s.bytes_done / MB,
                    s.bytes_total.div_ceil(MB)
                ),
            };
            return s;
        }
        Job::Removing => {
            s.state = State::Removing;
            s.detail = "Removing the Motion runtime".to_string();
            return s;
        }
        Job::Failed { kind, message } if resolved.is_err() => {
            s.state = State::Failed;
            s.error_kind = Some(kind.clone());
            s.error = Some(message.clone());
            s.detail = format!("The Motion runtime could not be installed: {message}");
            return s;
        }
        _ => {}
    }
    match resolved {
        Ok(rt) => {
            s.state = State::Ready;
            s.detail = match rt.source {
                RuntimeSource::Developer => {
                    format!("Ready (development build, using {})", rt.node.display())
                }
                RuntimeSource::Managed => "Ready".to_string(),
            };
        }
        Err(NotReady { state, developer }) => {
            let note = developer
                .as_ref()
                .map(|d| format!(" (development build: {d})"))
                .unwrap_or_default();
            let (state, detail) = match state {
                InstallState::Missing => (
                    State::Missing,
                    format!(
                        "Motion's render runtime is not installed: Node.js, Chrome Headless Shell and the Remotion compositor, a one-time {} MB download",
                        pins::total_download_bytes().div_ceil(MB)
                    ),
                ),
                InstallState::Outdated { found_key } => (
                    State::Outdated,
                    format!(
                        "The installed Motion runtime ({found_key}) is for an older version of the app; an update is needed"
                    ),
                ),
                InstallState::Broken { reason } => (
                    State::Broken,
                    format!("The Motion runtime is damaged ({reason}); reinstall it"),
                ),
                InstallState::Ready { .. } => (State::Ready, "Ready".to_string()),
            };
            s.state = state;
            s.detail = format!("{detail}{note}");
        }
    }
    s
}

const MB: u64 = 1024 * 1024;

static LAYOUT: RwLock<Option<Layout>> = RwLock::new(None);
static JOB: Mutex<Job> = Mutex::new(Job::Idle);

/// Set where this build's engine and runtime live. Call once, before anything
/// reads [`status`] (a later call replaces it; tests rely on that).
pub fn configure(layout: Layout) {
    *LAYOUT.write().unwrap_or_else(|e| e.into_inner()) = Some(layout);
}

/// The configured layout.
pub fn layout() -> Option<Layout> {
    LAYOUT.read().unwrap_or_else(|e| e.into_inner()).clone()
}

fn job() -> Job {
    JOB.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

fn set_job(j: Job) {
    *JOB.lock().unwrap_or_else(|e| e.into_inner()) = j;
}

fn resolve_now(layout: &Layout) -> Result<MotionRuntime, NotReady> {
    locate::resolve(layout, &Env::from_process(), &|p| locate::probe_node(p))
}

/// The current status (cheap: a few `stat`s, and one `node --version` per
/// process for a development build).
pub fn status() -> RuntimeStatus {
    let Some(layout) = layout() else {
        let mut s = compose(
            &Job::Idle,
            &Err(NotReady {
                state: InstallState::Missing,
                developer: None,
            }),
            Path::new(""),
            0,
        );
        s.state = State::Unconfigured;
        s.detail = "The app is still starting".to_string();
        s.can_install = false;
        return s;
    };
    let root = layout.runtime_root();
    compose(&job(), &resolve_now(&layout), root, store::dir_size(root))
}

/// The runtime every render path uses, or an error starting with
/// [`NOT_READY_CODE`] that says why and what to do.
pub fn require() -> Result<MotionRuntime, String> {
    let Some(layout) = layout() else {
        return Err(format!("{NOT_READY_CODE}: the app is still starting"));
    };
    resolve_now(&layout).map_err(|_| {
        let s = status();
        let progress = match s.state {
            State::Installing => " It is downloading now; motion_runtime_status shows the progress.",
            _ => " It downloads in the background when the Motion tab opens, or with motion_install_runtime.",
        };
        format!("{NOT_READY_CODE}: {}.{progress}", s.detail)
    })
}

/// Where this build's engine files are, without needing a runtime (the
/// component library lists the built-ins from here).
pub fn engine_dir() -> Option<PathBuf> {
    layout().map(|l| l.engine_dir().to_path_buf())
}

/// Start an install on a background thread. `notify` is called with the
/// status as it moves (throttled) and once at the end. Returns `false` when
/// there is nothing to do: already ready from the managed runtime, already
/// installing or removing, or not configured.
pub fn start_install(notify: impl Fn(&RuntimeStatus) + Send + 'static) -> bool {
    let Some(layout) = layout() else {
        return false;
    };
    {
        let mut j = JOB.lock().unwrap_or_else(|e| e.into_inner());
        if matches!(*j, Job::Installing(_) | Job::Removing) {
            return false;
        }
        if matches!(resolve_now(&layout), Ok(rt) if rt.source == RuntimeSource::Managed) {
            return false;
        }
        *j = Job::Installing(None);
    }
    notify(&status());
    std::thread::spawn(move || {
        let root = layout.runtime_root().to_path_buf();
        let key = pins::runtime_key();
        let mut last_sent: Option<(Step, u64)> = None;
        let result = store::install(
            &store::InstallRequest {
                root: &root,
                key: &key,
                artifacts: &pins::ARTIFACTS,
                source: Source::Pinned,
                free_space: &store::free_bytes,
            },
            |p: Progress| {
                let due = match last_sent {
                    None => true,
                    Some((step, bytes)) => {
                        step != p.step || p.bytes_done >= bytes + NOTIFY_EVERY_BYTES
                    }
                };
                let marker = (p.step, p.bytes_done);
                set_job(Job::Installing(Some(p)));
                if due {
                    last_sent = Some(marker);
                    notify(&status());
                }
            },
        );
        match result {
            Ok(dir) => {
                set_job(Job::Idle);
                log::info!("[motion-runtime] installed at {}", dir.display());
            }
            Err(e) => {
                log::warn!("[motion-runtime] install failed ({}): {e}", e.kind());
                set_job(Job::Failed {
                    kind: e.kind().to_string(),
                    message: e.to_string(),
                });
            }
        }
        notify(&status());
    });
    true
}

/// Delete the managed runtime (and any partial download). Refused while an
/// install or another removal is running.
pub fn remove() -> Result<RuntimeStatus, RuntimeError> {
    let Some(layout) = layout() else {
        return Err(RuntimeError::Busy("the app is still starting".into()));
    };
    {
        let mut j = JOB.lock().unwrap_or_else(|e| e.into_inner());
        if matches!(*j, Job::Installing(_) | Job::Removing) {
            return Err(RuntimeError::Busy(
                "the Motion runtime is being installed; wait for it to finish".into(),
            ));
        }
        *j = Job::Removing;
    }
    let result = store::remove_all(layout.runtime_root());
    set_job(Job::Idle);
    result.map(|()| status())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rt(source: RuntimeSource) -> MotionRuntime {
        MotionRuntime {
            source,
            node: PathBuf::from("/n/node"),
            engine_dir: PathBuf::from("/e"),
            prebuilt_bundle: None,
            browser_executable: None,
            binaries_dir: None,
        }
    }

    fn missing() -> Result<MotionRuntime, NotReady> {
        Err(NotReady {
            state: InstallState::Missing,
            developer: None,
        })
    }

    #[test]
    fn missing_offers_the_download_with_its_size() {
        let s = compose(&Job::Idle, &missing(), Path::new("/rt"), 0);
        assert_eq!(s.state, State::Missing);
        assert!(s.can_install && !s.can_remove);
        assert!(s.detail.contains("MB download"), "{}", s.detail);
        assert_eq!(s.download_bytes, pins::total_download_bytes());
    }

    #[test]
    fn installing_reports_the_bytes() {
        let p = Progress {
            step: Step::Downloading,
            artifact: Some(pins::ArtifactId::Chrome),
            label: "Chrome".into(),
            bytes_done: 50 * MB,
            bytes_total: 150 * MB,
        };
        let s = compose(&Job::Installing(Some(p)), &missing(), Path::new("/rt"), 10);
        assert_eq!(s.state, State::Installing);
        assert_eq!((s.bytes_done, s.bytes_total), (50 * MB, 150 * MB));
        assert!(!s.can_install && !s.can_remove, "busy");
        assert!(s.detail.contains("50 of 150 MB"), "{}", s.detail);
    }

    #[test]
    fn a_failure_is_reported_until_something_is_ready() {
        let failed = Job::Failed {
            kind: "offline".into(),
            message: "cannot reach nodejs.org".into(),
        };
        let s = compose(&failed, &missing(), Path::new("/rt"), 0);
        assert_eq!(s.state, State::Failed);
        assert_eq!(s.error_kind.as_deref(), Some("offline"));
        assert!(s.can_install, "Retry is allowed");
        // A developer's node makes it ready regardless of an old failure.
        let s = compose(
            &failed,
            &Ok(rt(RuntimeSource::Developer)),
            Path::new("/rt"),
            0,
        );
        assert_eq!(s.state, State::Ready);
    }

    #[test]
    fn ready_from_the_managed_runtime_can_be_removed_not_reinstalled() {
        let s = compose(
            &Job::Idle,
            &Ok(rt(RuntimeSource::Managed)),
            Path::new("/rt"),
            300 * MB,
        );
        assert_eq!(s.state, State::Ready);
        assert!(!s.can_install && s.can_remove);
        assert_eq!(s.runtime_dir.as_deref(), Some("/rt"));
    }

    #[test]
    fn a_developer_build_may_still_install_the_managed_runtime() {
        let s = compose(
            &Job::Idle,
            &Ok(rt(RuntimeSource::Developer)),
            Path::new("/rt"),
            0,
        );
        assert_eq!(s.source, Some(RuntimeSource::Developer));
        assert!(s.can_install, "to test the managed path");
        assert!(s.detail.contains("development build"), "{}", s.detail);
    }

    #[test]
    fn outdated_and_broken_say_what_to_do() {
        let outdated = Err(NotReady {
            state: InstallState::Outdated {
                found_key: "node-1".into(),
            },
            developer: None,
        });
        let s = compose(&Job::Idle, &outdated, Path::new("/rt"), 5);
        assert_eq!(s.state, State::Outdated);
        assert!(s.can_install && s.can_remove);
        let broken = Err(NotReady {
            state: InstallState::Broken {
                reason: "Node.js is missing".into(),
            },
            developer: None,
        });
        let s = compose(&Job::Idle, &broken, Path::new("/rt"), 5);
        assert_eq!(s.state, State::Broken);
        assert!(s.detail.contains("reinstall"), "{}", s.detail);
    }

    #[test]
    fn the_status_is_camel_case_on_the_wire() -> Result<(), serde_json::Error> {
        let v = serde_json::to_value(compose(&Job::Idle, &missing(), Path::new("/rt"), 0))?;
        assert_eq!(v["state"], "missing");
        assert!(v.get("bytesTotal").is_some() && v.get("canInstall").is_some());
        assert!(v.get("error").is_none(), "absent, not null");
        Ok(())
    }
}

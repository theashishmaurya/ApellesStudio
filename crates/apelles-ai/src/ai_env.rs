//! Build and repair the shared Python environment both AI sidecars run from,
//! without a human running `ai-env/setup.sh` and without assuming the machine has
//! Python at all (D-315; Phase 4 of `docs/notes/sidecar-lifecycle.md`).
//!
//! **What it is.** A supervisor thread, started at app launch beside the sidecar
//! supervisors, that answers one question over and over: *is `ai-env/.venv` present
//! and genuinely usable?* If yes it goes [`Phase::Ready`] and parks. If no it builds
//! it — fetching a self-contained CPython, creating the venv, installing the pinned
//! lock file — reporting progress the whole way, retrying with backoff on failure,
//! and never blocking anything else in the app.
//!
//! **Why `uv` and not `python3 -m venv`** (D-315). The environment is 1.6 GB, which is
//! why it is deliberately *not* in the installer — bundling it would re-create the
//! "nobody downloads a 2 GB app" problem D-314 just spent 1.7 GB fixing. So it has to
//! be built on the user's machine, and the naive way to do that (shell out to
//! `python3 -m venv`) assumes a system Python that a clean macOS install does not
//! have and that we would then be silently at the mercy of the version of.
//! [`uv`](https://github.com/astral-sh/uv) is one static binary, bundled via Tauri's
//! `externalBin` (staged by `app/src-tauri/build.rs`), that fetches its **own**
//! `python-build-standalone` CPython. `UV_PYTHON_PREFERENCE=only-managed` is what
//! makes that a guarantee rather than a hope: without it, `--python 3.11` on a
//! developer machine happily resolves to whatever `/Library/Frameworks` holds, which
//! is exactly the "running on unpinned system packages and nobody can tell" failure
//! D-314 already caught once in `resolve_shared_python`.
//!
//! **What it does NOT do.** Download models (they still pull from the HF cache on
//! first use — unchanged), install ffmpeg (a hard `ai-media/` requirement that is not
//! pip-installable), start or stop a sidecar, or block app startup. A machine that
//! never finishes this bootstrap has a fully working Edit/Motion/Colorist app whose
//! AI features report [`Phase::Failed`] with a retry, which is the whole point of it
//! being a background thread with its own state rather than a step in `.setup()`.
//!
//! **The three real failure modes, and what each does** — all three are handled
//! because a bootstrap that only works on a fast, uninterrupted first run is not a
//! feature, it is a demo:
//!
//! 1. *Transient failure* (network drops mid-download). The attempt fails, the state
//!    machine backs off ([`BACKOFF`]) and tries again. Nothing is lost, because —
//! 2. *Resume.* Re-running the same `uv pip install` **is** the resume mechanism: uv's
//!    global wheel cache survives the kill, so already-downloaded wheels are not
//!    fetched twice. Measured, not assumed (D-315): a `SIGKILL` 45 s into a cold
//!    install left 1.6 GB in the cache and only three packages unpacked; the identical
//!    command re-run completed in **25 s**. See `docs/notes/ai-env-bootstrap.md`.
//! 3. *A torn venv.* A process killed mid-install leaves an interpreter that starts
//!    fine over a `site-packages` that is missing things. [`health`] catches that by
//!    actually importing what each sidecar needs (via the shared `ai-env/verify.py`,
//!    the same file `setup.sh` runs), and [`attempt`] then heals in two stages —
//!    re-install over the top first, and only if that still does not verify, wipe the
//!    venv and rebuild. Two stages because stage one is the 25 s path and stage two is
//!    the several-minute one; going straight to the wipe would be correct but wasteful.
//!    The wipe fires only on a real *verdict* from `verify.py`, never on a health check
//!    that failed to produce one — see [`Unhealthy`] and B-179.
//!    The wipe fires only on a real *verdict* from `verify.py`, never on a health check
//!    that failed to produce one — see [`Unhealthy`] and B-179.
//!
//! **Boundary.** This is in `apelles-ai` because that crate already owns the sidecar
//! lifecycle, including the interpreter ladder ([`sidecar::resolve_shared_python`])
//! whose fourth rung is the very venv built here — putting the builder anywhere else
//! would split "where the venv is" across two crates. It holds no `tauri` dependency
//! (D-039 §1, D-145): the app owns the `#[tauri::command]` wrappers and the event
//! emission, and passes in the resolved paths via [`configure`] because only the app
//! can ask Tauri where its resource and app-data directories are.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::sidecar;

/// The CPython the shared venv is built on.
///
/// Pinned exactly, for the same reason every version in `ai-env/requirements.lock.txt`
/// is pinned exactly (D-314): nothing here benefits from picking up a new interpreter
/// on a random Tuesday. What actually has to match the lock is the **ABI tag** — the
/// wheels in it are `cp311`, so any 3.11.x would install — but "any 3.11.x" is a range,
/// and this repo's stated position on ranges in this stack is that they have a real
/// downside and no upside.
///
/// Deliberately not 3.11.4, the version `setup.sh --relock` happened to compile the
/// lock on: uv's `python-build-standalone` catalogue starts at 3.11.5, so 3.11.4 is
/// not a thing it can install. Same ABI, so the lock is unaffected.
pub const PYTHON_VERSION: &str = "3.11.15";

/// Backoff between bootstrap attempts, in seconds, holding at the last value.
///
/// Much longer than the sidecar supervisor's ladder (2 s → 30 s) on purpose: a sidecar
/// that will not start is usually a code or environment problem that a fast retry
/// surfaces quickly, whereas the overwhelmingly likely reason *this* fails is no
/// internet. Hammering a download that cannot succeed helps nobody, and the user has a
/// "Retry now" button ([`retry_now`]) for the case where they just reconnected.
const BACKOFF: [u64; 6] = [5, 15, 45, 120, 300, 900];

/// How long `uv` may go **without producing a single line of output** before it is
/// killed as wedged.
///
/// A stall timeout, deliberately, not a cap on total runtime: the honest worst case here
/// is a multi-gigabyte download on a bad connection, which can legitimately run for a
/// very long time but emits a line every few seconds while it does. A total-runtime cap
/// would kill a slow-but-working install and turn it into an infinite retry loop. This
/// only catches the thing that is genuinely stuck — a dead TCP connection that never
/// times out — and keeps it from parking the state machine in `installingPackages`
/// forever.
const UV_STALL_TIMEOUT: Duration = Duration::from_secs(15 * 60);

// ---- where everything is -----------------------------------------------------------

/// The filesystem facts the bootstrap needs, resolved by whoever can resolve them.
///
/// A struct set once at startup rather than a pile of `std::env::var` calls, because
/// the packaged case genuinely cannot be expressed as a path relative to anything this
/// crate can see: the lock file ships read-only *inside* the `.app` bundle, while the
/// venv must be built somewhere writable *outside* it (writing into a signed bundle
/// invalidates its signature). Only the app can ask Tauri for those two directories,
/// so only the app can fill this in — see `chroma::ai_env` in `app/src-tauri`.
#[derive(Debug, Clone)]
pub struct AiEnvPaths {
    /// Writable directory that will contain `.venv`. In a dev checkout this is the
    /// workspace's `ai-env/`; in a bundle it is under the app's data directory.
    pub root: PathBuf,
    /// `requirements.lock.txt` — read-only, and in a bundle it lives in the resource
    /// directory, not next to [`Self::root`].
    pub lock: PathBuf,
    /// `verify.py` — the shared health check, likewise read-only and bundled.
    pub verify: PathBuf,
}

impl AiEnvPaths {
    /// `<root>/.venv`.
    pub fn venv(&self) -> PathBuf {
        self.root.join(".venv")
    }

    /// `<root>/.venv/bin/python`.
    pub fn python(&self) -> PathBuf {
        sidecar::venv_python(&self.venv())
    }

    /// Everything present that has to be present before a bootstrap can even start.
    fn missing(&self) -> Option<String> {
        for (what, p) in [
            ("requirements.lock.txt", &self.lock),
            ("verify.py", &self.verify),
        ] {
            if !p.is_file() {
                return Some(format!("{what} is missing at {}", p.display()));
            }
        }
        None
    }
}

static PATHS: OnceLock<AiEnvPaths> = OnceLock::new();

/// Tell this module where things are. Called once, from the app's `.setup()`, before
/// the bootstrap thread starts. Later calls are ignored — the paths cannot meaningfully
/// change while the process is running, and silently swapping them mid-bootstrap would
/// be worse than ignoring the second call.
pub fn configure(paths: AiEnvPaths) {
    let _ = PATHS.set(paths);
}

/// The configured paths, or the dev-checkout layout if nothing configured them.
///
/// The fallback is what makes `cargo test`, `cargo run` and a bare `ai-env/setup.sh`
/// checkout all work without the app having to be involved, and it is the same
/// `CARGO_MANIFEST_DIR`-relative sweep [`sidecar::resolve_shared_python`] uses so the
/// two can never disagree about which `ai-env/` is *the* one.
pub fn paths() -> Option<AiEnvPaths> {
    if let Some(p) = PATHS.get() {
        return Some(p.clone());
    }
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    for prefix in sidecar::DEV_LAYOUT_PREFIXES {
        let root = manifest.join(prefix).join(sidecar::SHARED_ENV_DIR);
        if root.join("requirements.lock.txt").is_file() {
            let root = root.canonicalize().unwrap_or(root);
            return Some(AiEnvPaths {
                lock: root.join("requirements.lock.txt"),
                verify: root.join("verify.py"),
                root,
            });
        }
    }
    None
}

/// The bundled `uv`, found the same way every other bundled binary is (D-313):
/// beside our own executable first, which is `target/<profile>/` in a dev run and the
/// bundle's binary directory in a packaged one, then a workspace-target sweep.
///
/// `CHROMA_UV_BIN` overrides it, mainly so a developer can point at a newer uv without
/// rebuilding, and so the tests below can run against the machine's own uv when the
/// app has never been built in this checkout.
fn uv_bin() -> Option<PathBuf> {
    sidecar::resolve_bin("uv", "CHROMA_UV_BIN").or_else(|| sidecar::which("uv"))
}

// ---- the state a UI can render -----------------------------------------------------

/// Where the bootstrap is. A flat enum rather than a data-carrying one so the wire
/// shape stays as simple as [`sidecar::SidecarStatus`]'s — the numbers and strings that
/// go with a phase are siblings on [`AiEnvStatus`], not payloads, which keeps the
/// TypeScript side a plain discriminated check instead of a tagged-union decode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    /// Nothing has happened yet — the thread has not had its first look.
    #[default]
    Unknown,
    /// Running `verify.py` against an existing venv to see if it is usable.
    Checking,
    /// `uv python install` — fetching a self-contained CPython.
    InstallingPython,
    /// `uv venv` — creating the environment.
    CreatingVenv,
    /// `uv pip install -r requirements.lock.txt`. [`AiEnvStatus::packages_done`] /
    /// [`AiEnvStatus::packages_total`] are real counts parsed from uv's own output.
    InstallingPackages,
    /// The venv did not verify after a re-install, so it is being wiped and rebuilt.
    Repairing,
    /// Built, and both sidecars' imports actually load from it.
    Ready,
    /// An attempt failed. [`AiEnvStatus::retry_in_secs`] says when the next one is.
    Failed,
    /// Cannot even be attempted here — no bundled `uv`, or no lock file. Not retried
    /// on a timer, because nothing about waiting would change it; distinct from
    /// [`Self::Failed`] precisely so a UI does not promise a retry that cannot help.
    Unavailable,
}

impl Phase {
    /// Is this a state a user is expected to wait out, rather than act on? Drives the
    /// "still setting up" wording at every AI-feature entry point.
    pub fn is_working(self) -> bool {
        matches!(
            self,
            Phase::Checking
                | Phase::InstallingPython
                | Phase::CreatingVenv
                | Phase::InstallingPackages
                | Phase::Repairing
        )
    }

    /// The wire spelling, identical to what `serde` emits. Written out rather than
    /// round-tripped through `serde_json` because it is used inside error messages, on
    /// a path that must not itself be able to fail, and because a name a machine
    /// matches on should be a `match` a compiler checks rather than a serializer's
    /// incidental output.
    pub fn as_str(self) -> &'static str {
        match self {
            Phase::Unknown => "unknown",
            Phase::Checking => "checking",
            Phase::InstallingPython => "installingPython",
            Phase::CreatingVenv => "creatingVenv",
            Phase::InstallingPackages => "installingPackages",
            Phase::Repairing => "repairing",
            Phase::Ready => "ready",
            Phase::Failed => "failed",
            Phase::Unavailable => "unavailable",
        }
    }
}

/// The whole bootstrap state, as one snapshot. `camelCase` on the wire to match every
/// other Apelles command struct (D-101's `SidecarStatus` set that convention).
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiEnvStatus {
    pub phase: Phase,
    /// One human sentence for the current phase — safe to render verbatim.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Packages installed so far / in the lock, during [`Phase::InstallingPackages`].
    /// Both zero when uv has not said yet.
    pub packages_done: u32,
    pub packages_total: u32,
    /// How many attempts have been made. 0 before the first one finishes.
    pub attempt: u32,
    /// Seconds until the next automatic retry, when [`Phase::Failed`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_in_secs: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    /// Absolute path of the venv, once known — so the Settings card can say *which*
    /// environment it is talking about, which matters as soon as an override is in play.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub venv: Option<String>,
    /// Wall-clock seconds spent in the current attempt. The only honest input a
    /// "~N min left" estimate could have; the UI uses it as elapsed, not remaining.
    pub elapsed_secs: u64,
}

/// The stable token every "the AI environment is not built yet" message starts with.
///
/// **This is the machine-readable half of the contract** (D-315). An AI feature that
/// cannot run because the environment is still being built fails the way every other
/// refusal in this stack fails — a normal `{ok: false, error}` envelope with the reason
/// in it, never an exception (the precedent `control.rs`'s 503/504 and
/// `mcp::transport::OpError` both set deliberately, because raising is what once
/// reduced a real explanation to a bare "Error executing tool `<name>`"). What makes it
/// *distinguishable* rather than merely readable is this prefix: a caller matching on
/// it knows the difference between "wait, this will work later", "the sidecar crashed"
/// and "your arguments were wrong" without parsing prose, and the `ai_env_status` MCP
/// tool is the structured read it can then poll.
///
/// Compiled into no client, so it is asserted by a test on both sides rather than
/// trusted: `crates/apelles-mcp` and `mcp/server.py` both document it in the tools that
/// can return it.
pub const NOT_READY_CODE: &str = "ai_env_not_ready";

impl AiEnvStatus {
    /// One line saying why an AI feature cannot run yet, or `None` once the environment
    /// is [`Phase::Ready`] and the failure must therefore be something else.
    ///
    /// Deliberately carries the phase, the package counts and the retry schedule inline:
    /// the decision the caller has to make is "wait and retry, or give up", and those
    /// three facts are exactly what decides it. `unavailable` says so explicitly,
    /// because it is the one state where waiting is pointless.
    pub fn not_ready_message(&self) -> Option<String> {
        let phase = self.phase.as_str();
        let what = match self.phase {
            // The one phase with nothing to explain. A `return` rather than a
            // placeholder string so there is no unreachable arm to panic in.
            Phase::Ready => return None,
            Phase::Unknown => "the bootstrap has not reported in yet".to_string(),
            Phase::Checking => "checking the existing environment".to_string(),
            Phase::InstallingPython => format!("fetching Python {PYTHON_VERSION}"),
            Phase::CreatingVenv => "creating the virtual environment".to_string(),
            Phase::InstallingPackages => {
                if self.packages_total > 0 {
                    format!(
                        "installing packages ({} of {})",
                        self.packages_done, self.packages_total
                    )
                } else {
                    "installing packages (uv has not reported a count yet)".to_string()
                }
            }
            Phase::Repairing => "repairing a damaged environment".to_string(),
            Phase::Failed => format!(
                "the last attempt failed ({}); the next automatic retry is in {}s",
                self.last_error.as_deref().unwrap_or("no reason recorded"),
                self.retry_in_secs.unwrap_or(0)
            ),
            Phase::Unavailable => format!(
                "it CANNOT be built on this machine ({}) — this is not retried on a \
                 timer, so waiting will not help",
                self.detail.as_deref().unwrap_or("no reason recorded")
            ),
        };
        Some(format!(
            "{NOT_READY_CODE}: the shared Python environment both AI sidecars run from \
             is not ready — phase '{phase}', {what} (attempt {}, {}s elapsed). This is \
             the one-time environment build (D-315), not a crash and not a bad request. \
             Call `ai_env_status` for the live state, or `ai_env_retry` to force an \
             attempt now.",
            self.attempt, self.elapsed_secs
        ))
    }
}

/// The message an AI feature fails with when it could not reach its sidecar.
///
/// `hint` is the caller's own "sidecar unreachable" diagnosis, which stays in the
/// message verbatim: this only ever *prepends* the more specific reason, because the
/// environment being unbuilt is a very likely explanation for a refused connection but
/// never a certain one, and throwing the underlying error away to assert a guess would
/// trade one unexplained failure for another.
///
/// Checked here, at the one place the app decides to talk to a sidecar, rather than in
/// either MCP server or in `control.rs`. That is the only spot that is both exhaustive
/// and correct: exhaustive because every AI feature — present and future, GUI click or
/// MCP call — funnels through it, and correct because it fires exactly when a Python
/// sidecar was genuinely needed and missing. An op-name list in `control.rs` would fail
/// both tests — it would break that server's "knows no op list" boundary (D-020) and it
/// would wrongly gate `add_subject_mask` on a still image, which runs ONNX SAM
/// in-process and needs no Python at all.
pub fn explain_unreachable(hint: impl Into<String>) -> String {
    let hint = hint.into();
    match status_snapshot().not_ready_message() {
        Some(why) => format!("{why} Underlying error: {hint}"),
        None => hint,
    }
}

/// Shared state: the snapshot, plus the two flags the supervisor's interruptible sleep
/// watches. A `Condvar` rather than a polling sleep so "Retry now" is instant even when
/// the next scheduled attempt is fifteen minutes out.
struct Shared {
    status: Mutex<AiEnvStatus>,
    wake: Condvar,
    /// Set by [`retry_now`], cleared when the supervisor acts on it.
    retry_requested: Mutex<bool>,
    /// Set by [`shutdown`]; every sleep and every child-wait checks it.
    stopping: Mutex<bool>,
    /// The running `uv`, so [`shutdown`] can kill it instead of waiting out a 1.6 GB
    /// download while the user is trying to quit.
    child: Mutex<Option<Child>>,
}

fn shared() -> &'static Shared {
    static S: OnceLock<Shared> = OnceLock::new();
    S.get_or_init(|| Shared {
        status: Mutex::new(AiEnvStatus::default()),
        wake: Condvar::new(),
        retry_requested: Mutex::new(false),
        stopping: Mutex::new(false),
        child: Mutex::new(None),
    })
}

/// The current bootstrap state. Backs the `chroma_ai_env_status` command and the
/// `ai-env-status` event's payload.
pub fn status_snapshot() -> AiEnvStatus {
    shared()
        .status
        .lock()
        .map(|s| s.clone())
        .unwrap_or_default()
}

/// Ask for an immediate re-check, interrupting whatever backoff is in progress.
///
/// Refused (returns `false`) only while an attempt is genuinely **in flight**, or when
/// the environment is [`Phase::Unavailable`], so the caller can say so instead of
/// pretending a second attempt was queued. The "Retry now" button and the
/// `ai_env_retry` MCP tool both come through here.
///
/// **Accepted when already [`Phase::Ready`]**, deliberately, where it means "re-verify".
/// The first version refused there too, on the reasoning that there is nothing to retry —
/// which was wrong twice over. It left [`supervise`]'s post-ready park loop waiting on a
/// signal nothing could ever send (dead code wearing a comment claiming otherwise), and
/// it meant a venv deleted or broken *after* the app reached `ready` would be reported
/// healthy forever, with no way for a user or an agent to make the app look again. Ready
/// is a cached answer, and a cached answer needs an invalidation.
///
/// **B-180 — `unavailable` is the one phase that really is refused.** [`supervise`]
/// *returns* when it reaches it (no bundled `uv`, no lock file,
/// `CHROMA_AI_ENV_NO_BOOTSTRAP`): there is no thread left to wake, so setting the flag
/// and reporting success would promise an attempt that can never happen. That is the
/// same lie D-315 refused to tell with an automatic timer, told manually instead —
/// `unavailable` means *nothing about trying again changes the answer*, and that has to
/// hold for both kinds of retry. Note this is the opposite call from `ready` above and
/// for the opposite reason: `ready` is a cached answer worth invalidating, `unavailable`
/// is a standing fact about the machine with nothing listening for the request.
pub fn retry_now() -> bool {
    let phase = status_snapshot().phase;
    if phase == Phase::Unavailable || phase.is_working() {
        return false;
    }
    if let Ok(mut r) = shared().retry_requested.lock() {
        *r = true;
    }
    shared().wake.notify_all();
    true
}

/// Stop the bootstrap and kill any running `uv`. Called from the app-exit hook next to
/// [`sidecar::shutdown`] — a 1.6 GB download is exactly the kind of child that must not
/// outlive the app that started it.
pub fn shutdown() {
    if let Ok(mut s) = shared().stopping.lock() {
        *s = true;
    }
    shared().wake.notify_all();
    if let Ok(mut c) = shared().child.lock()
        && let Some(child) = c.as_mut()
    {
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn stopping() -> bool {
    shared().stopping.lock().map(|s| *s).unwrap_or(false)
}

/// Publish a new snapshot and notify the app so it can emit the Tauri event.
fn set(f: impl FnOnce(&mut AiEnvStatus), notify: &dyn Fn(&AiEnvStatus)) {
    let snapshot = {
        let Ok(mut s) = shared().status.lock() else {
            return;
        };
        f(&mut s);
        s.clone()
    };
    notify(&snapshot);
}

// ---- running uv --------------------------------------------------------------------

/// Run one `uv` command to completion, streaming every output line to `on_line`.
///
/// uv writes progress to stderr and results to stdout; both are logged under
/// `[ai-env]` and both are fed to `on_line`, because which stream a given line lands on
/// is uv's business and the progress parser should not depend on it.
fn run_uv(uv: &Path, args: &[&str], mut on_line: impl FnMut(&str)) -> Result<(), String> {
    log::info!("[ai-env] uv {}", args.join(" "));

    let mut cmd = Command::new(uv);
    cmd.args(args)
        // The guarantee that we are on a self-contained interpreter and never the
        // machine's own — see this module's header. Without it `--python 3.11.15`
        // can match a system install that merely reports that version.
        .env("UV_PYTHON_PREFERENCE", "only-managed")
        // uv colours its output when it thinks a terminal is attached; these lines go
        // to a log file and a progress parser, and escape codes help neither.
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("could not run {}: {e}", uv.display()))?;

    // Take the pipes before publishing the child, so `shutdown()` can only ever see a
    // child whose output is already being drained.
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let (tx, rx) = std::sync::mpsc::channel::<String>();
    for pipe in [
        stdout.map(|p| Box::new(p) as Box<dyn std::io::Read + Send>),
        stderr.map(|p| Box::new(p) as Box<dyn std::io::Read + Send>),
    ]
    .into_iter()
    .flatten()
    {
        let tx = tx.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
    }
    drop(tx);

    if let Ok(mut slot) = shared().child.lock() {
        *slot = Some(child);
    }

    // Interleave draining the output with polling for exit, rather than draining to EOF
    // first and only then waiting.
    //
    // Draining first is the obvious shape and it is wrong: `for line in rx` blocks until
    // both reader threads end, which happens when the child closes its pipes, which for
    // a genuinely wedged child never happens. The stall timeout below would then be
    // unreachable — the exact case it exists for. So: poll the channel with a short
    // timeout, and between polls check for exit and for a stall.
    let mut last_activity = Instant::now();
    let status = loop {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(line) => {
                log::info!("[ai-env] {line}");
                on_line(&line);
                last_activity = Instant::now();
                continue;
            }
            // Timeout: no output right now. Disconnected: both readers finished, so the
            // pipes are closed and the child is on its way out. Either way, fall through
            // to the exit/stall checks below.
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
            | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {}
        }

        if stopping() {
            let _ = kill_child();
            return Err("cancelled".to_string());
        }

        let Ok(mut slot) = shared().child.lock() else {
            return Err("bootstrap state is poisoned".to_string());
        };
        let Some(child) = slot.as_mut() else {
            // `shutdown()` already reaped it.
            return Err("cancelled".to_string());
        };
        match child.try_wait() {
            Ok(Some(status)) => {
                *slot = None;
                break status;
            }
            Ok(None) => {
                drop(slot);
                // A *stall* timeout, not a total-runtime one. The honest worst case here
                // is a multi-gigabyte download on a bad connection, which can legitimately
                // run for a very long time — but it emits a line every few seconds while
                // it does. Killing on total elapsed time would murder a slow-but-working
                // install and turn it into an infinite retry loop; killing on silence
                // only catches the thing that is actually stuck.
                if last_activity.elapsed() > UV_STALL_TIMEOUT {
                    let _ = kill_child();
                    return Err(format!(
                        "`uv {}` produced no output for {} minutes and was stopped",
                        args.first().unwrap_or(&""),
                        UV_STALL_TIMEOUT.as_secs() / 60
                    ));
                }
            }
            Err(e) => {
                *slot = None;
                return Err(format!("could not wait for uv: {e}"));
            }
        }
    };

    // The child is gone, so both pipes are closed and the reader threads have ended or
    // are ending. Take whatever they already queued: the last few lines — including the
    // `Installed N packages` that snaps the progress count to its total — are usually
    // written immediately before exit and would otherwise be dropped on the floor.
    while let Ok(line) = rx.recv_timeout(Duration::from_millis(50)) {
        log::info!("[ai-env] {line}");
        on_line(&line);
    }

    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "`uv {}` failed ({status}) — see the [ai-env] lines in the app log",
            args.first().unwrap_or(&"")
        ))
    }
}

fn kill_child() -> Option<()> {
    let mut slot = shared().child.lock().ok()?;
    let mut child = slot.take()?;
    let _ = child.kill();
    let _ = child.wait();
    Some(())
}

/// Pull real progress out of uv's own output.
///
/// uv's line formats, as actually observed (D-315's probe, `uv` 0.12.x) rather than
/// guessed at:
///
/// ```text
/// Resolved 91 packages in 4.36s
/// Downloading torch (121.4MiB)
///  Downloaded torch
/// Prepared 91 packages in 1m 12s
/// Installed 91 packages in 402ms
/// ```
///
/// So the total comes from `Resolved`, and progress from counting `Downloaded` lines —
/// with `Prepared`/`Installed` snapping the count to its true value at the end, since a
/// package already in the wheel cache is *never* announced as downloaded and would
/// otherwise leave the bar short of its total on a fast re-run.
///
/// Returns `true` if the status changed and is worth publishing.
fn parse_progress(line: &str, status: &mut AiEnvStatus) -> bool {
    let trimmed = line.trim();

    let count_after = |kw: &str| -> Option<u32> {
        let rest = trimmed.strip_prefix(kw)?.trim_start();
        rest.split_whitespace().next()?.parse().ok()
    };

    if let Some(n) = count_after("Resolved") {
        status.packages_total = n;
        return true;
    }
    if let Some(n) = count_after("Prepared").or_else(|| count_after("Installed")) {
        status.packages_done = n.max(status.packages_done);
        if status.packages_total == 0 {
            status.packages_total = n;
        }
        return true;
    }
    if let Some(rest) = trimmed.strip_prefix("Downloaded ") {
        status.packages_done += 1;
        status.detail = Some(format!("downloaded {rest}"));
        return true;
    }
    if let Some(rest) = trimmed.strip_prefix("Downloading ") {
        status.detail = Some(format!("downloading {rest}"));
        return true;
    }
    false
}

// ---- the health check --------------------------------------------------------------

/// Can both sidecars actually import what they need from this interpreter?
///
/// Runs the shared `ai-env/verify.py` — the same file `ai-env/setup.sh` runs at the end
/// of a human install — through the venv's own Python. That it is the *same file* is
/// the point (`CLAUDE.md`: shared logic is never copy-pasted): a Rust-side list of
/// module names would drift from the bash-side one, and drift here means the app
/// reporting `ready` for an environment a sidecar then dies importing from.
///
/// Deliberately not "does `.venv/bin/python` exist". The failure this exists for is a
/// half-finished install, which passes every cheaper check there is.
/// Why [`health`] said no — and, crucially, whether it actually *knows*.
///
/// The distinction exists because the remedy for one of these is destructive. A
/// [`Self::Broken`] environment has told us, through `verify.py`'s own verdict, that a
/// package it needs will not import; wiping and rebuilding is the right answer. An
/// [`Self::Inconclusive`] result means we never got a verdict — `verify.py` was killed,
/// or could not be run at all — and the environment may be completely fine.
///
/// Found the hard way (B-179): the D-315 end-to-end run killed processes by a path
/// pattern that also matched `verify.py` running through the venv, and the bootstrap
/// dutifully deleted a perfectly good, fully-installed 1.6 GB environment and rebuilt it
/// from scratch. Treating "I could not ask" as "the answer was no" is how a health check
/// becomes the thing that destroys the health it is checking.
#[derive(Debug)]
enum Unhealthy {
    /// `verify.py` ran and returned a verdict: something genuinely will not import.
    Broken(String),
    /// No verdict was obtained. May well be fine; retry, do not destroy.
    Inconclusive(String),
}

impl Unhealthy {
    fn message(&self) -> &str {
        match self {
            Unhealthy::Broken(m) | Unhealthy::Inconclusive(m) => m,
        }
    }
}

impl std::fmt::Display for Unhealthy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}

fn health(python: &Path, verify: &Path) -> Result<(), Unhealthy> {
    if !python.is_file() {
        // Definitive, and the commonest one: no venv yet at all.
        return Err(Unhealthy::Broken(format!(
            "no interpreter at {}",
            python.display()
        )));
    }
    let out = Command::new(python)
        .arg(verify)
        .arg("--json")
        .stdin(Stdio::null())
        .output()
        .map_err(|e| Unhealthy::Inconclusive(format!("could not run {}: {e}", verify.display())))?;

    if out.status.success() {
        return Ok(());
    }

    // `verify.py` prints one JSON object with a `checks` array. Its presence is what makes
    // a failure *definitive*: the script ran, decided, and named what it could not import.
    let parsed: Option<serde_json::Value> = serde_json::from_slice(&out.stdout).ok();
    if let Some(v) = parsed
        && let Some(checks) = v.get("checks").and_then(|c| c.as_array())
    {
        let failed: Vec<String> = checks
            .iter()
            .filter(|c| c.get("ok").and_then(|o| o.as_bool()) == Some(false))
            .filter_map(|c| c.get("label").and_then(|l| l.as_str()).map(str::to_string))
            .collect();
        if !failed.is_empty() {
            return Err(Unhealthy::Broken(format!(
                "cannot import: {}",
                failed.join(", ")
            )));
        }
    }

    // No verdict: the script died before it could produce one. `code() == None` is a
    // signal kill on Unix; anything else here means it exited without the JSON it always
    // writes when it actually runs. Either way we do not know that the environment is
    // bad — only that we failed to ask it.
    let detail = String::from_utf8_lossy(&out.stderr).trim().to_string();
    let how = match out.status.code() {
        None => "was killed by a signal".to_string(),
        Some(c) => format!("exited {c} without a verdict"),
    };
    Err(Unhealthy::Inconclusive(format!(
        "{} {how}{}",
        verify.display(),
        if detail.is_empty() {
            String::new()
        } else {
            format!(": {detail}")
        }
    )))
}

// ---- one attempt ---------------------------------------------------------------------

/// Build (or repair, or simply confirm) the environment once.
///
/// The staged self-heal is the whole shape of this function:
///
/// 1. If the venv already verifies, stop — this is the overwhelmingly common path on
///    every launch after the first, and it costs one Python start.
/// 2. Otherwise ensure an interpreter and a venv exist, and run the install. On a torn
///    venv this is the cheap repair: uv re-installs only what is missing, out of a
///    wheel cache that survived whatever killed the last attempt (25 s, measured).
/// 3. Verify again. If `verify.py` returns a *verdict* that something still will not
///    import, the venv is not merely incomplete but broken, so wipe it and build from
///    scratch — the expensive path, taken only once the cheap one has been proven
///    insufficient.
///
/// A health check that produced **no verdict** (killed, or unrunnable) is never grounds
/// for the wipe — see [`Unhealthy`] and B-179. The attempt fails and the ordinary
/// backoff re-asks the question.
fn attempt(p: &AiEnvPaths, uv: &Path, notify: &dyn Fn(&AiEnvStatus)) -> Result<(), String> {
    let python = p.python();

    set(
        |s| {
            s.phase = Phase::Checking;
            s.detail = Some("checking the AI environment".into());
            s.venv = Some(p.venv().display().to_string());
        },
        notify,
    );

    match health(&python, &p.verify) {
        Ok(()) => return Ok(()),
        // We could not get a verdict at all. Do not build, and above all do not wipe:
        // the environment is quite possibly fine and we simply failed to ask it. Fail
        // the attempt so the ordinary backoff retries the *question* (B-179).
        Err(e @ Unhealthy::Inconclusive(_)) => {
            return Err(format!("could not check the AI environment: {e}"));
        }
        Err(Unhealthy::Broken(_)) => {}
    }

    build(p, uv, notify)?;

    match health(&python, &p.verify) {
        Ok(()) => Ok(()),
        Err(e @ Unhealthy::Inconclusive(_)) => {
            // Same rule after the re-install. The packages are very likely in place now;
            // one unanswered question is not grounds for deleting 1.6 GB.
            Err(format!("could not check the AI environment: {e}"))
        }
        Err(why @ Unhealthy::Broken(_)) => {
            log::warn!(
                "[ai-env] the environment still does not verify after re-installing ({why}) — wiping {} and rebuilding from scratch",
                p.venv().display()
            );
            set(
                |s| {
                    s.phase = Phase::Repairing;
                    s.detail = Some(format!("repairing a damaged environment ({why})"));
                    s.packages_done = 0;
                    s.packages_total = 0;
                },
                notify,
            );
            std::fs::remove_dir_all(p.venv())
                .map_err(|e| format!("could not remove the damaged venv: {e}"))?;
            build(p, uv, notify)?;
            health(&python, &p.verify).map_err(|e| e.message().to_string())
        }
    }
}

/// The three uv steps: interpreter, environment, packages.
fn build(p: &AiEnvPaths, uv: &Path, notify: &dyn Fn(&AiEnvStatus)) -> Result<(), String> {
    set(
        |s| {
            s.phase = Phase::InstallingPython;
            s.detail = Some(format!("fetching Python {PYTHON_VERSION}"));
        },
        notify,
    );
    // A no-op costing well under a second once the interpreter is already there, so it
    // is run unconditionally rather than guarded by a "do we have it" check that would
    // just be a worse copy of uv's own.
    run_uv(uv, &["python", "install", PYTHON_VERSION], |_| {})?;

    if !p.python().is_file() {
        std::fs::create_dir_all(&p.root)
            .map_err(|e| format!("could not create {}: {e}", p.root.display()))?;
        set(
            |s| {
                s.phase = Phase::CreatingVenv;
                s.detail = Some("creating the environment".into());
            },
            notify,
        );
        let venv = p.venv();
        let venv = venv.to_string_lossy();
        // `--clear` is required, not defensive: `uv venv` **refuses** an existing
        // directory it recognises as a venv ("A virtual environment already exists at
        // `…`. Use `--clear` to replace it", exit 2), and the case that lands here is
        // precisely a venv whose tree survived but whose interpreter did not. Without
        // this flag a torn environment could never be rebuilt and the bootstrap would
        // retry the same failing command until the end of time — found by
        // `a_damaged_environment_is_healed_rather_than_reported_ready`, which is the
        // reason that test runs a real `uv` instead of a mock.
        //
        // Safe to pass unconditionally *here* because this branch is only reached when
        // `.venv/bin/python` is absent, i.e. there is no working environment to lose.
        // The packages it clears come straight back out of uv's wheel cache on the
        // install below.
        run_uv(
            uv,
            &["venv", "--clear", "--python", PYTHON_VERSION, &venv],
            |_| {},
        )?;
    }

    set(
        |s| {
            s.phase = Phase::InstallingPackages;
            s.detail = Some("installing dependencies".into());
            s.packages_done = 0;
            s.packages_total = 0;
        },
        notify,
    );

    let python = p.python();
    let python = python.to_string_lossy();
    let lock = p.lock.to_string_lossy();
    run_uv(
        uv,
        &["pip", "install", "--python", &python, "-r", &lock],
        |line| {
            let changed = {
                let Ok(mut s) = shared().status.lock() else {
                    return;
                };
                parse_progress(line, &mut s)
            };
            if changed {
                set(|_| {}, notify);
            }
        },
    )
}

// ---- the supervisor thread -----------------------------------------------------------

/// Sleep up to `total`, waking early on shutdown or a retry request. Returns `true` if
/// the caller should stop entirely.
fn nap(total: Duration) -> bool {
    let deadline = Instant::now() + total;
    let mut guard = shared()
        .retry_requested
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    loop {
        if stopping() {
            return true;
        }
        if *guard {
            return false;
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return false;
        }
        // Capped so `stopping()` is re-checked promptly: `shutdown()` does notify, but
        // a notification that lands between the check above and the wait below would
        // otherwise park this thread for the rest of a fifteen-minute backoff, and the
        // app would appear to hang on quit.
        let (g, _) = shared()
            .wake
            .wait_timeout(guard, left.min(Duration::from_millis(250)))
            .unwrap_or_else(|p| p.into_inner());
        guard = g;
    }
}

/// Run the bootstrap for as long as the app lives. Started on its own thread from the
/// app's `.setup()`, right beside the sidecar supervisors — the point being that the
/// environment starts building the moment the app opens rather than the moment someone
/// first clicks an AI feature, so it is usually already there when they do.
///
/// `notify` is called on every state change; the app passes a closure that emits the
/// Tauri event. It is a parameter rather than a `tauri::AppHandle` for the same reason
/// [`sidecar::supervise`] takes none — this crate cannot depend on `tauri` (D-145).
pub fn supervise(notify: impl Fn(&AiEnvStatus) + Send + 'static) {
    let notify: &dyn Fn(&AiEnvStatus) = &notify;

    if std::env::var_os("CHROMA_AI_ENV_NO_BOOTSTRAP").is_some() {
        log::info!(
            "[ai-env] bootstrap disabled (CHROMA_AI_ENV_NO_BOOTSTRAP set) — build it yourself: ./ai-env/setup.sh"
        );
        set(
            |s| {
                s.phase = Phase::Unavailable;
                s.detail = Some(
                    "Automatic setup is disabled (CHROMA_AI_ENV_NO_BOOTSTRAP). Run ./ai-env/setup.sh."
                        .into(),
                );
            },
            notify,
        );
        return;
    }

    let unavailable = |why: String| {
        log::warn!("[ai-env] cannot bootstrap: {why}");
        set(
            |s| {
                s.phase = Phase::Unavailable;
                s.detail = Some(why.clone());
                s.last_error = Some(why.clone());
            },
            notify,
        );
    };

    let Some(p) = paths() else {
        unavailable(
            "no ai-env directory found — this build cannot locate requirements.lock.txt".into(),
        );
        return;
    };
    if let Some(why) = p.missing() {
        unavailable(why);
        return;
    }
    let Some(uv) = uv_bin() else {
        unavailable(
            "the bundled `uv` binary is missing — reinstall the app, or set CHROMA_UV_BIN".into(),
        );
        return;
    };

    log::info!(
        "[ai-env] venv {} | lock {} | uv {}",
        p.venv().display(),
        p.lock.display(),
        uv.display()
    );

    let mut attempts = 0u32;
    loop {
        if stopping() {
            return;
        }
        if let Ok(mut r) = shared().retry_requested.lock() {
            *r = false;
        }

        attempts += 1;
        let started = Instant::now();
        set(
            |s| {
                s.attempt = attempts;
                s.retry_in_secs = None;
                s.elapsed_secs = 0;
            },
            notify,
        );

        // Keep `elapsed_secs` honest while an attempt runs, so a UI can show "3m so
        // far" instead of a frozen number during a long download.
        //
        // Stopped by its own flag rather than by watching the phase: the phase is still
        // a working one at the moment `attempt` returns (the terminal phase is set
        // below, after the join), so a phase-watching ticker would never exit and the
        // join would deadlock.
        let tick_stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let ticker = {
            let tick_stop = std::sync::Arc::clone(&tick_stop);
            std::thread::spawn(move || {
                while !tick_stop.load(std::sync::atomic::Ordering::Relaxed) && !stopping() {
                    std::thread::sleep(Duration::from_millis(250));
                    if let Ok(mut s) = shared().status.lock()
                        && s.phase.is_working()
                    {
                        s.elapsed_secs = started.elapsed().as_secs();
                    }
                }
            })
        };

        let result = attempt(&p, &uv, notify);
        tick_stop.store(true, std::sync::atomic::Ordering::Relaxed);
        let _ = ticker.join();

        match result {
            Ok(()) => {
                let secs = started.elapsed().as_secs();
                log::info!("[ai-env] ready in {secs}s: {}", p.venv().display());
                set(
                    |s| {
                        s.phase = Phase::Ready;
                        s.detail = Some("AI environment ready".into());
                        s.last_error = None;
                        s.retry_in_secs = None;
                        s.elapsed_secs = secs;
                        if s.packages_total > 0 {
                            s.packages_done = s.packages_total;
                        }
                    },
                    notify,
                );
                // Nothing left to do — but stay alive so "Retry now" can force a
                // re-check (e.g. after someone deletes the venv by hand).
                loop {
                    if nap(Duration::from_secs(3600)) {
                        return;
                    }
                    if shared().retry_requested.lock().map(|r| *r).unwrap_or(false) {
                        break;
                    }
                }
                continue;
            }
            Err(e) if e == "cancelled" => return,
            Err(e) => {
                let wait = BACKOFF[(attempts as usize - 1).min(BACKOFF.len() - 1)];
                log::warn!("[ai-env] attempt {attempts} failed: {e} — retrying in {wait}s");
                set(
                    |s| {
                        s.phase = Phase::Failed;
                        s.detail = Some(format!("Setup failed: {e}"));
                        s.last_error = Some(e.clone());
                        s.retry_in_secs = Some(wait);
                        s.elapsed_secs = started.elapsed().as_secs();
                    },
                    notify,
                );
                if nap(Duration::from_secs(wait)) {
                    return;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests;

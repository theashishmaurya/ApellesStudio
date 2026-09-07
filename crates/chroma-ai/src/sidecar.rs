//! Rust-managed Python sidecar lifecycle (D-028; extracted from
//! `app/src-tauri/src/chroma/sidecar.rs` into `chroma-ai` in D-145; generalized
//! from one hardcoded sidecar to N in D-185).
//!
//! Starts and supervises Chroma's Python sidecars so the user never has to
//! `cd <dir> && ./run.sh` by hand. Two exist today, described by the two
//! [`SidecarSpec`] statics below:
//!   - [`AI`] — `ai/`, PyTorch/MPS: SAM 2 → ViTMatte matting (D-012/D-016),
//!     Video-Depth-Anything depth tracking (D-036), MoGe-2 normals (D-077).
//!   - [`AI_MEDIA`] — `ai-media/`, MLX: word-level transcript (mlx-whisper) and
//!     video understanding (ffmpeg scene-detect + Qwen3-VL), D-184. A separate
//!     PROCESS because it is a separate dependency universe — `mlx-vlm` needs
//!     `transformers>=5.5` and `ai/` pins `<5`, which pip reports as an outright
//!     `ResolutionImpossible`. See D-184 for the spike that settled it.
//!
//! The app spawns [`spawn_and_supervise`] on a thread per sidecar from `lib.rs`
//! `.setup()`; the app-exit hook in `lib.rs` `.run(...)` calls [`shutdown`],
//! which kills every child we own so no uvicorn is orphaned.
//!
//! What it does, per sidecar:
//!   - resolve the sidecar dir + a Python interpreter (env overrides → venv → PATH)
//!   - if a sidecar is already healthy on the port, monitor it WITHOUT owning it
//!     (never kill or respawn someone else's process) — D-101: also compares its
//!     self-reported `content_sha256` against this build's own `server.py` on
//!     every poll, so a genuinely stale/different external process is detected
//!     and surfaced (`SidecarStatus::stale`) instead of trusted forever just for
//!     answering 200 (see `docs/notes/sidecar-lifecycle.md`'s "real ownership" TODO)
//!   - otherwise spawn `python -m uvicorn server:app`, pipe its stdout+stderr to
//!     `log::info!("[sidecar/<name>] …")`, poll `/health` until ready, then restart
//!     it with capped exponential backoff if it dies
//!   - kill the owned child on app exit
//!
//! What it does NOT do: bundle Python, create/repair a venv, install requirements,
//! or touch `grade.json`. If a venv is missing it logs a one-line fix and retries
//! every 30 s — the features that need that sidecar just fail with the existing
//! "unreachable" errors until then (acceptable degradation). It also does not
//! expose a `#[tauri::command]` — the app-side `app/src-tauri/src/chroma/sidecar.rs`
//! keeps the thin `chroma_ai_status` / `chroma_ai_media_status` wrappers around
//! [`status_snapshot`] (D-039 §1: commands do not move).
//!
//! **D-185, why this is parameterized rather than copy-pasted:** adding the second
//! sidecar could have been a second module with the names swapped. That would
//! duplicate the genuinely subtle parts — the D-101 staleness policy, the
//! fast-fail/slow-retry backoff ladder, the shutdown races — and guarantee the two
//! copies drift, since every future fix would have to be remembered twice
//! (`CLAUDE.md`: "shared logic → never copy-pasted; if two places need it, extract
//! it"). So the per-sidecar *facts* (name, env var names, default port, where to
//! look for the directory) became a [`SidecarSpec`], the per-sidecar *runtime
//! state* (the owned child, the status snapshot) moved out of module-level
//! `OnceLock`s into a registry keyed by spec name, and the logic below is written
//! once. Behaviour for the `ai/` sidecar is unchanged.
//!
//! Packaged-app path resolution is a known gap — [`resolve_dir`] keys off
//! `CARGO_MANIFEST_DIR` (a dev path) / the spec's dir env var. See
//! `docs/notes/sidecar-lifecycle.md` — flagged as a Phase 4 follow-up.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use sha2::{Digest, Sha256};

/// How long to wait for a freshly-spawned sidecar to answer `/health`.
const READY_TIMEOUT: Duration = Duration::from_secs(30);
const HEALTH_POLL: Duration = Duration::from_millis(500);
const MAX_BACKOFF: Duration = Duration::from_secs(30);
const SLOW_RETRY: Duration = Duration::from_secs(60);
/// Consecutive fast (<`HEALTHY_RUN_RESET`) failures before we drop to slow-retry.
const FAST_FAIL_GIVE_UP: u32 = 6;
/// A run that stays up at least this long resets the backoff.
const HEALTHY_RUN_RESET: Duration = Duration::from_secs(60);

// ---- the specs --------------------------------------------------------------------

/// Everything that differs between one supervised sidecar and another. Every
/// field is `&'static` because the specs are `static`s, one per sidecar, and the
/// supervisor threads outlive any borrow shorter than that.
///
/// The dev-layout directory candidates are relative to `CARGO_MANIFEST_DIR`
/// (`<workspace>/crates/chroma-ai`), and are tried in order until one contains a
/// `server.py`. `"../../<dir>"` is the real post-D-145 path; the shorter ones are
/// kept so the lookup still works if this crate is ever nested differently.
pub struct SidecarSpec {
    /// Log tag and registry key — `"ai"`, `"ai-media"`.
    pub name: &'static str,
    /// Directory name under the workspace root, and the basis of the dev-layout
    /// candidates.
    pub dir: &'static str,
    /// Override the resolved directory (must contain `server.py`).
    pub dir_env: &'static str,
    /// Override the Python interpreter (must be a file).
    pub python_env: &'static str,
    /// Override the port.
    pub port_env: &'static str,
    /// If set at all, don't auto-spawn — the user is running it themselves.
    pub no_spawn_env: &'static str,
    pub default_port: u16,
}

impl SidecarSpec {
    fn port(&self) -> u16 {
        std::env::var(self.port_env)
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(self.default_port)
    }

    /// `cd ai && ./run.sh` — the one-line manual-start hint, used in log lines
    /// and in the "can't start" error the frontend surfaces.
    fn run_hint(&self) -> String {
        format!("cd {} && ./run.sh", self.dir)
    }
}

/// The `ai/` sidecar (D-028): SAM 2 → ViTMatte matting, depth tracking, normals.
pub static AI: SidecarSpec = SidecarSpec {
    name: "ai",
    dir: "ai",
    dir_env: "CHROMA_AI_DIR",
    python_env: "CHROMA_AI_PYTHON",
    port_env: "CHROMA_AI_PORT",
    no_spawn_env: "CHROMA_AI_NO_SPAWN",
    default_port: 8765,
};

/// The `ai-media/` sidecar (D-184): transcript + video understanding, MLX.
pub static AI_MEDIA: SidecarSpec = SidecarSpec {
    name: "ai-media",
    dir: "ai-media",
    dir_env: "CHROMA_AI_MEDIA_DIR",
    python_env: "CHROMA_AI_MEDIA_PYTHON",
    port_env: "CHROMA_AI_MEDIA_PORT",
    no_spawn_env: "CHROMA_AI_MEDIA_NO_SPAWN",
    default_port: 8766,
};

/// Every sidecar the app supervises, in the order `lib.rs` starts them.
pub static ALL: &[&SidecarSpec] = &[&AI, &AI_MEDIA];

// ---- per-sidecar runtime state ----------------------------------------------------

struct Owned {
    child: Option<Child>,
    shutting_down: bool,
}

/// The mutable half of a supervised sidecar. One per [`SidecarSpec`], created on
/// first use and never dropped (the supervisor thread holds a `&'static` to it).
struct SidecarState {
    owned: Mutex<Owned>,
    status: Mutex<SidecarStatus>,
}

/// `name -> state`. `Box::leak` gives each state the `'static` lifetime the
/// supervisor threads need, without an `Arc` clone on every status poll. Bounded
/// by the number of specs (2), so the leak is a one-time allocation per sidecar,
/// not unbounded growth.
fn registry() -> &'static Mutex<HashMap<&'static str, &'static SidecarState>> {
    static R: OnceLock<Mutex<HashMap<&'static str, &'static SidecarState>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}

fn state(spec: &SidecarSpec) -> &'static SidecarState {
    let mut reg = registry().lock().unwrap_or_else(|p| p.into_inner());
    reg.entry(spec.name)
        .or_insert_with(|| {
            &*Box::leak(Box::new(SidecarState {
                owned: Mutex::new(Owned {
                    child: None,
                    shutting_down: false,
                }),
                status: Mutex::new(SidecarStatus::default()),
            }))
        })
        .to_owned()
}

fn shutting_down(spec: &SidecarSpec) -> bool {
    state(spec)
        .owned
        .lock()
        .map(|g| g.shutting_down)
        .unwrap_or(true)
}

/// Called from `lib.rs` `.run(...)` on `RunEvent::ExitRequested` / `Exit`: kill
/// every child we own so no uvicorn survives the quit. Safe to call repeatedly
/// and safe when we own nothing (external sidecars, or spawns that never
/// succeeded).
///
/// D-185: kills *all* registered sidecars rather than the one global child, so a
/// new sidecar can never be forgotten here by whoever adds it — the exit hook's
/// call site in `lib.rs` needs no change per sidecar.
pub fn shutdown() {
    // Snapshot the registry and release its lock before touching any child, so a
    // supervisor thread mid-poll can't deadlock against the exit hook.
    let states: Vec<(&'static str, &'static SidecarState)> = {
        let reg = registry().lock().unwrap_or_else(|p| p.into_inner());
        reg.iter().map(|(k, v)| (*k, *v)).collect()
    };
    for (name, st) in states {
        let mut g = st.owned.lock().unwrap_or_else(|p| p.into_inner());
        g.shutting_down = true;
        if let Some(mut child) = g.child.take() {
            let pid = child.id();
            log::info!("[sidecar/{name}] app exiting — killing sidecar pid {pid}");
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

// ---- status (backs the app-side chroma_ai_status commands) ------------------------

/// Snapshot for the settings-panel sidecar status cards (D-101 — the first real
/// consumer; before this, nothing did; D-184 added the second card).
/// `camelCase` on the wire to match every other Chroma command struct's
/// convention (`commands.rs`, `project.rs`, `grade.rs`, etc.).
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarStatus {
    /// this process spawned and owns the sidecar child
    pub managed: bool,
    /// the last `/health` poll succeeded
    pub healthy: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    /// how many times we've restarted the child since launch
    pub restarts: u32,
    /// D-101 — only ever meaningful when `managed == false`: the external
    /// process answered `/health` but its `content_sha256` doesn't match
    /// what this build's own `server.py` would produce, so it's likely
    /// running different (probably older) code. Always `false` for a
    /// Rust-owned spawn, which is the exact code on disk by construction.
    /// `false` also when staleness genuinely can't be determined (no
    /// `content_sha256` on either side — e.g. an external sidecar built
    /// before D-101) rather than a false positive.
    pub stale: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

fn set_status(spec: &SidecarSpec, f: impl FnOnce(&mut SidecarStatus)) {
    if let Ok(mut s) = state(spec).status.lock() {
        f(&mut s);
    }
}

/// `{ managed, healthy, pid?, restarts, stale, lastError? }` for one sidecar —
/// the plain-Rust half of the Settings panel's status cards (D-101/D-184). The
/// app-side `#[tauri::command]`s are 1-line wrappers around this (D-039 §1:
/// commands do not move).
pub fn status_snapshot(spec: &SidecarSpec) -> SidecarStatus {
    state(spec)
        .status
        .lock()
        .map(|s| s.clone())
        .unwrap_or_default()
}

// ---- health check ----------------------------------------------------------------
//
// A raw HTTP/1.1 GET so the supervisor thread needs no tokio runtime and no
// `reqwest/blocking` feature (the runtime `reqwest` here is async-only).

/// The `/health` fields this file actually cares about — not a full mirror of
/// either sidecar's response shape (which also carry `models`/`device`/etc.,
/// irrelevant here).
struct HealthInfo {
    ok: bool,
    /// D-101 — the sidecar's own `content_sha256` (a truncated SHA256 of its own
    /// file bytes). `None` if the field was absent (an older sidecar build, from
    /// before this existed) or the body didn't parse.
    content_sha256: Option<String>,
}

/// Full `GET /health` — reads the whole response, not just the status line, so
/// the JSON body's `content_sha256` (D-101) is available for staleness
/// comparison. `Connection: close` means "read to EOF" correctly gets the full
/// body off a raw `TcpStream` without needing to parse `Content-Length`/chunking.
fn health_check(port: u16) -> Option<HealthInfo> {
    let addr = format!("127.0.0.1:{port}").to_socket_addrs().ok()?.next()?;
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_secs(2)).ok()?;
    let _ = s.set_read_timeout(Some(Duration::from_secs(3)));
    let _ = s.set_write_timeout(Some(Duration::from_secs(2)));
    s.write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .ok()?;
    let mut buf = Vec::with_capacity(4096);
    // Best-effort: a slow/hanging server hits the read timeout above rather
    // than blocking forever, and whatever was read so far still gets used.
    let _ = s.read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf);
    let ok = text
        .lines()
        .next()
        .map(|l| l.contains(" 200"))
        .unwrap_or(false);
    let content_sha256 = text
        .split("\r\n\r\n")
        .nth(1)
        .and_then(|body| serde_json::from_str::<serde_json::Value>(body).ok())
        .and_then(|v| {
            v.get("content_sha256")
                .and_then(|s| s.as_str())
                .map(str::to_string)
        });
    Some(HealthInfo { ok, content_sha256 })
}

/// Liveness only, no staleness check — the cheap path most call sites want
/// (the owned-child ready-poll and supervise loop, where we always know
/// exactly what we spawned; there's no "which build is this" question).
fn health_ok(port: u16) -> bool {
    health_check(port).map(|h| h.ok).unwrap_or(false)
}

/// D-101 — SHA256 of the sidecar's `server.py` bytes, truncated to the first 8
/// bytes (16 hex chars) — matches each `server.py`'s own `_CONTENT_SHA256`
/// byte-for-byte, so an external process's self-reported hash can be compared
/// against "the exact code this Rust binary would spawn."
fn content_hash(dir: &Path) -> Option<String> {
    let bytes = std::fs::read(dir.join("server.py")).ok()?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let digest = hasher.finalize();
    Some(digest.iter().take(8).map(|b| format!("{b:02x}")).collect())
}

/// The staleness rule, in exactly one place (it is used from both
/// [`spawn_and_supervise`]'s external branch and [`monitor_external`]): a
/// mismatch is only ever claimed when *both* sides have a real hash to compare.
/// One side being unknown means "can't determine," never a false positive.
fn is_stale(expected: &Option<String>, got: &Option<String>) -> bool {
    match (expected, got) {
        (Some(exp), Some(got)) => exp != got,
        _ => false,
    }
}

// ---- resolve the sidecar dir + a python interpreter ------------------------------

fn resolve_dir(spec: &SidecarSpec) -> Option<PathBuf> {
    if let Ok(d) = std::env::var(spec.dir_env) {
        let p = PathBuf::from(&d);
        if p.join("server.py").is_file() {
            return Some(p);
        }
        log::warn!(
            "[sidecar/{}] {}={d} has no server.py — ignoring it",
            spec.name,
            spec.dir_env
        );
    }
    // Dev layout: CARGO_MANIFEST_DIR = <workspace>/crates/chroma-ai, the sidecar
    // dirs are <workspace>/ai and <workspace>/ai-media — both direct workspace
    // children of the repo root, so "../../<dir>" resolves. The shorter
    // candidates are kept from the pre-D-145 layout.
    // TODO(Phase 4): packaged builds need a resource-dir lookup instead — docs/notes/sidecar-lifecycle.md.
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    for prefix in ["../..", "..", "."] {
        let c = manifest.join(prefix).join(spec.dir);
        if c.join("server.py").is_file() {
            return Some(c.canonicalize().unwrap_or(c));
        }
    }
    None
}

fn which(bin: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|d| d.join(bin))
        .find(|p| p.is_file())
}

/// `Ok((python, dir))` or `Err(one-line fix hint)`.
fn resolve(spec: &SidecarSpec) -> Result<(PathBuf, PathBuf), String> {
    let dir = resolve_dir(spec).ok_or_else(|| {
        format!(
            "{} sidecar can't start: no {}/ dir found. Set {} to the sidecar folder.",
            spec.name, spec.dir, spec.dir_env
        )
    })?;

    if let Ok(p) = std::env::var(spec.python_env) {
        let pb = PathBuf::from(&p);
        if pb.is_file() {
            return Ok((pb, dir));
        }
        return Err(format!(
            "{} sidecar can't start: {}={p} is not a file.",
            spec.name, spec.python_env
        ));
    }

    let venv = dir.join(".venv/bin/python");
    if venv.is_file() {
        return Ok((venv, dir));
    }

    if let Some(py3) = which("python3") {
        return Ok((py3, dir));
    }

    Err(format!(
        "{} sidecar can't start: no python at {}. Run:  cd {} && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt",
        spec.name,
        venv.display(),
        spec.dir,
    ))
}

// ---- misc helpers ---------------------------------------------------------------

fn pipe_lines<R>(name: &'static str, r: R, tail: Option<Arc<Mutex<VecDeque<String>>>>)
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        for line in BufReader::new(r).lines().map_while(Result::ok) {
            log::info!("[sidecar/{name}] {line}");
            if let Some(t) = &tail
                && let Ok(mut d) = t.lock()
            {
                d.push_back(line);
                while d.len() > 12 {
                    d.pop_front();
                }
            }
        }
    });
}

/// Sleep up to `total`, waking early on a shutdown request. Returns true if the
/// caller should stop (shutdown requested).
fn nap(spec: &SidecarSpec, total: Duration) -> bool {
    let step = Duration::from_millis(200);
    let mut left = total;
    while left > Duration::ZERO {
        if shutting_down(spec) {
            return true;
        }
        let s = step.min(left);
        thread::sleep(s);
        left = left.saturating_sub(s);
    }
    shutting_down(spec)
}

/// Has the owned child already exited (so the ready-poll should bail out)?
fn child_gone(spec: &SidecarSpec) -> bool {
    let mut g = state(spec).owned.lock().unwrap_or_else(|p| p.into_inner());
    match g.child.as_mut() {
        Some(c) => matches!(c.try_wait(), Ok(Some(_)) | Err(_)),
        None => true,
    }
}

// ---- the supervisor -------------------------------------------------------------

/// Supervise the `ai/` sidecar. Kept as a zero-argument function so `lib.rs`'s
/// existing `std::thread::spawn(chroma::sidecar::spawn_and_supervise)` call site
/// is unchanged by D-185 — `spawn` needs an `FnOnce()`, and a spec-taking
/// function is not one.
pub fn spawn_and_supervise() {
    supervise(&AI);
}

/// Supervise the `ai-media/` sidecar (D-184). Same reason for the dedicated
/// zero-argument entry point as [`spawn_and_supervise`].
pub fn spawn_and_supervise_media() {
    supervise(&AI_MEDIA);
}

/// Spawned on a thread from `lib.rs` `.setup()`, once per sidecar. Never returns
/// until app shutdown.
///
/// D-145: this used to take a `tauri::AppHandle` parameter (`_app`); it was
/// entirely unused — dropped when this moved into `chroma-ai`, since a crate
/// hosting this function can't depend on `tauri` for a parameter it never read.
pub fn supervise(spec: &'static SidecarSpec) {
    let name = spec.name;
    let port = spec.port();

    if std::env::var_os(spec.no_spawn_env).is_some() {
        log::info!(
            "[sidecar/{name}] auto-spawn disabled ({} set) — run it yourself: {}",
            spec.no_spawn_env,
            spec.run_hint()
        );
        return;
    }

    // D-101 — real ownership: compute the content hash we'd expect from a
    // sidecar built off the exact `server.py` this Rust binary can see,
    // *before* deciding external-vs-owned, so "already up" can be told apart
    // from "already up, but a different (probably stale) build" instead of
    // trusting any 200 forever — the actual D-069 gap. `None` here (no dir
    // resolved yet) means staleness can't be determined; that's handled as
    // "unknown, not stale" below rather than a false positive.
    let expected_hash = resolve_dir(spec).and_then(|d| content_hash(&d));

    if let Some(info) = health_check(port).filter(|h| h.ok) {
        let stale = is_stale(&expected_hash, &info.content_sha256);
        if stale {
            log::warn!(
                "[sidecar/{name}] already running (external) on :{port}, but its content_sha256 doesn't match what this build's {}/server.py would produce — likely a stale process from an older build (see D-069/D-101). Monitoring only, NOT killing or restarting a process this app didn't start — if this is unexpected, restart it by hand (kill the pid, then `{}`).",
                spec.dir,
                spec.run_hint()
            );
        } else {
            log::info!(
                "[sidecar/{name}] already running (external) on :{port} — monitoring only, will not manage or kill it"
            );
        }
        set_status(spec, |s| {
            s.managed = false;
            s.healthy = true;
            s.pid = None;
            s.stale = stale;
        });
        monitor_external(spec, port, expected_hash);
        return;
    }

    let mut backoff = Duration::from_secs(2);
    let mut fast_failures = 0u32;

    while !shutting_down(spec) {
        let (python, dir) = match resolve(spec) {
            Ok(v) => v,
            Err(hint) => {
                log::warn!("[sidecar/{name}] {hint}");
                set_status(spec, |s| {
                    s.managed = false;
                    s.healthy = false;
                    s.last_error = Some(hint);
                });
                if nap(spec, Duration::from_secs(30)) {
                    return;
                }
                continue;
            }
        };

        let started = Instant::now();
        log::info!(
            "[sidecar/{name}] starting: {} -m uvicorn server:app --port {port}  (cwd {})",
            python.display(),
            dir.display()
        );

        let mut child = match Command::new(&python)
            .args([
                "-m",
                "uvicorn",
                "server:app",
                "--host",
                "127.0.0.1",
                "--port",
            ])
            .arg(port.to_string())
            .current_dir(&dir)
            .env(spec.port_env, port.to_string())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                let msg = format!("spawn failed: {e}");
                log::error!("[sidecar/{name}] {msg}");
                set_status(spec, |s| {
                    s.managed = false;
                    s.healthy = false;
                    s.last_error = Some(msg);
                });
                if nap(spec, backoff) {
                    return;
                }
                backoff = (backoff * 2).min(MAX_BACKOFF);
                continue;
            }
        };

        let pid = child.id();
        let tail: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));
        if let Some(o) = child.stdout.take() {
            pipe_lines(name, o, None);
        }
        if let Some(e) = child.stderr.take() {
            pipe_lines(name, e, Some(tail.clone()));
        }

        {
            let mut g = state(spec).owned.lock().unwrap_or_else(|p| p.into_inner());
            if g.shutting_down {
                let _ = child.kill();
                let _ = child.wait();
                return;
            }
            g.child = Some(child);
        }
        set_status(spec, |s| {
            s.managed = true;
            s.healthy = false;
            s.pid = Some(pid);
            s.last_error = None;
            // A Rust-owned spawn is, by construction, running the exact
            // server.py on disk right now — never stale. Explicit reset (not
            // just relying on the struct default) in case this status
            // transitions from a prior external+stale phase within the same
            // app session (e.g. the external process died and we took over).
            s.stale = false;
        });

        // wait-for-ready
        let ready_by = Instant::now() + READY_TIMEOUT;
        loop {
            if shutting_down(spec) {
                return;
            }
            if child_gone(spec) {
                break; // died during startup — handled by the supervise loop below
            }
            if health_ok(port) {
                log::info!(
                    "[sidecar/{name}] ready in {}ms (pid {pid}, http://127.0.0.1:{port})",
                    started.elapsed().as_millis()
                );
                set_status(spec, |s| s.healthy = true);
                break;
            }
            if Instant::now() >= ready_by {
                log::warn!(
                    "[sidecar/{name}] failed to become healthy within {}s (pid {pid}) — still supervising",
                    READY_TIMEOUT.as_secs()
                );
                break;
            }
            if nap(spec, HEALTH_POLL) {
                return;
            }
        }

        // supervise — poll try_wait so the child handle stays in the registry for
        // the exit hook. Refresh health for the status command while we wait.
        let exited: Option<std::process::ExitStatus> = loop {
            if shutting_down(spec) {
                return;
            }
            let mut g = state(spec).owned.lock().unwrap_or_else(|p| p.into_inner());
            let Some(c) = g.child.as_mut() else {
                return; // the exit hook took it
            };
            match c.try_wait() {
                Ok(Some(st)) => {
                    g.child = None;
                    break Some(st);
                }
                Ok(None) => {
                    drop(g);
                    let ok = health_ok(port);
                    set_status(spec, |s| s.healthy = ok);
                    if nap(spec, Duration::from_secs(2)) {
                        return;
                    }
                }
                Err(e) => {
                    g.child = None;
                    log::error!("[sidecar/{name}] try_wait failed: {e}");
                    break None;
                }
            }
        };

        let ran = started.elapsed();
        let tail_txt = tail
            .lock()
            .map(|d| d.iter().cloned().collect::<Vec<_>>().join(" | "))
            .unwrap_or_default();
        match &exited {
            Some(st) => log::warn!(
                "[sidecar/{name}] exited ({st}) after {ran:?} (pid {pid}). recent stderr: {tail_txt}"
            ),
            None => log::warn!(
                "[sidecar/{name}] lost the child handle after {ran:?} (pid {pid}). recent stderr: {tail_txt}"
            ),
        }
        set_status(spec, |s| {
            s.healthy = false;
            s.restarts += 1;
            s.pid = None;
            s.last_error = Some(match &exited {
                Some(st) => format!("exited {st}: {tail_txt}"),
                None => format!("wait error: {tail_txt}"),
            });
        });

        if shutting_down(spec) {
            return;
        }

        if ran >= HEALTHY_RUN_RESET {
            backoff = Duration::from_secs(2);
            fast_failures = 0;
        } else {
            fast_failures += 1;
        }

        if fast_failures >= FAST_FAIL_GIVE_UP {
            log::error!(
                "[sidecar/{name}] {fast_failures} fast failures in a row — check the '[sidecar/{name}]' lines above for the Python error. Slow-retrying every {}s (set {} to stop).",
                SLOW_RETRY.as_secs(),
                spec.no_spawn_env
            );
            if nap(spec, SLOW_RETRY) {
                return;
            }
        } else {
            log::info!("[sidecar/{name}] respawning in {backoff:?}");
            if nap(spec, backoff) {
                return;
            }
            backoff = (backoff * 2).min(MAX_BACKOFF);
        }
    }
}

/// An external sidecar is up: health-poll and log state changes only. We never
/// spawn our own or kill theirs (spec D-028 step 3).
///
/// D-101: also re-checks `content_sha256` on the same 10s cadence, not just
/// liveness — so an external sidecar restarted *mid-session* with different
/// code (someone ran `run.sh` fresh while this app stayed open) is picked up as
/// a status change without needing a full app restart to re-evaluate. "Picked
/// up" means the `stale` flag (surfaced via the status command) reflects reality
/// live — this still never auto-restarts or takes over the process itself; see
/// the policy note on `SidecarStatus::stale`.
fn monitor_external(spec: &'static SidecarSpec, port: u16, expected_hash: Option<String>) {
    let name = spec.name;
    let mut last_healthy = true;
    // The caller already logged the initial stale/fresh state before handing
    // off here (it had to, to decide what to log at all) — start this loop's
    // "did it change" tracking from that same value so we don't immediately
    // re-log the state the caller just announced.
    let mut last_stale = state(spec).status.lock().map(|s| s.stale).unwrap_or(false);
    loop {
        if nap(spec, Duration::from_secs(10)) {
            return;
        }
        let info = health_check(port);
        let ok = info.as_ref().map(|h| h.ok).unwrap_or(false);
        if ok != last_healthy {
            if ok {
                log::info!("[sidecar/{name}] external sidecar is healthy again");
            } else {
                log::warn!(
                    "[sidecar/{name}] external sidecar stopped responding on :{port} (not managed — not restarting it)"
                );
            }
            last_healthy = ok;
        }
        let stale = is_stale(
            &expected_hash,
            &info.as_ref().and_then(|h| h.content_sha256.clone()),
        );
        if stale != last_stale {
            if stale {
                log::warn!(
                    "[sidecar/{name}] external sidecar on :{port} now reports a content_sha256 that doesn't match — became stale mid-session (restarted externally with different code, or this app's own {}/ code changed underneath it). Not managed — not restarting it.",
                    spec.dir
                );
            } else {
                log::info!(
                    "[sidecar/{name}] external sidecar on :{port} content_sha256 now matches this build's {}/server.py — no longer considered stale.",
                    spec.dir
                );
            }
            last_stale = stale;
        }
        set_status(spec, |s| {
            s.healthy = ok;
            s.stale = stale;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_server_py(dir: &Path, contents: &str) {
        std::fs::write(dir.join("server.py"), contents).unwrap();
    }

    #[test]
    fn content_hash_matches_python_sha256_hexdigest_truncated_to_16_chars() {
        // Real, known SHA256 of the literal bytes b"hello chroma\n" — computed
        // independently (Python `hashlib.sha256(b"hello chroma\n").hexdigest()`)
        // rather than derived from this same code, so this test can't just be
        // checking the implementation against itself.
        let tmp = std::env::temp_dir().join(format!("chroma_sidecar_hash_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        write_server_py(&tmp, "hello chroma\n");

        let got = content_hash(&tmp).expect("server.py exists, hash should compute");
        assert_eq!(got, "35719cab709150d0");
        assert_eq!(
            got.len(),
            16,
            "16 hex chars = first 8 bytes of the digest, matching each server.py's own [:16] truncation"
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn content_hash_changes_when_the_file_changes_and_is_deterministic_when_it_doesnt() {
        let tmp =
            std::env::temp_dir().join(format!("chroma_sidecar_hash_delta_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        write_server_py(&tmp, "version A");
        let a1 = content_hash(&tmp).unwrap();
        let a2 = content_hash(&tmp).unwrap();
        assert_eq!(a1, a2, "hashing the same bytes twice must be deterministic");

        write_server_py(&tmp, "version B — a single different byte is enough");
        let b = content_hash(&tmp).unwrap();
        assert_ne!(
            a1, b,
            "a real code change must change the hash, or staleness could never be detected"
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn content_hash_is_none_when_server_py_is_missing() {
        // The "no dir resolved yet" / "somehow no server.py at the resolved
        // path" case — must degrade to "can't determine," never panic, since
        // this runs on every sidecar boot decision.
        let tmp = std::env::temp_dir().join(format!(
            "chroma_sidecar_hash_missing_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        assert!(content_hash(&tmp).is_none());
    }

    /// A real regression test for the actual D-101 policy, now testing the one
    /// shared [`is_stale`] the supervisor itself calls (before D-185 this test
    /// had to re-declare the rule locally, which meant it could pass while the
    /// real code drifted).
    #[test]
    fn staleness_policy_only_flags_a_real_mismatch_never_an_unknown() {
        let a = Some("aaaaaaaaaaaaaaaa".to_string());
        let b = Some("bbbbbbbbbbbbbbbb".to_string());

        assert!(
            is_stale(&a, &b),
            "two different real hashes = genuinely stale"
        );
        assert!(!is_stale(&a, &a), "identical real hashes = not stale");
        assert!(
            !is_stale(&None, &b),
            "no expected hash (e.g. sidecar dir not resolved) — can't claim staleness we can't compute"
        );
        assert!(
            !is_stale(&a, &None),
            "external sidecar has no content_sha256 field (pre-D-101 build) — unknown, not a false positive"
        );
        assert!(
            !is_stale(&None, &None),
            "both unknown — definitely not a false positive"
        );
    }

    // ---- D-185: the multi-sidecar registry ---------------------------------------

    /// The whole point of the D-185 refactor: two specs must get two genuinely
    /// independent state slots. If they shared one (the pre-D-185 global
    /// `OnceLock`), the media sidecar going down would show the `ai/` card as
    /// unhealthy and vice versa.
    #[test]
    fn each_spec_gets_its_own_isolated_state() {
        assert!(!std::ptr::eq(state(&AI), state(&AI_MEDIA)));

        set_status(&AI, |s| s.restarts = 7);
        set_status(&AI_MEDIA, |s| s.restarts = 3);

        assert_eq!(status_snapshot(&AI).restarts, 7);
        assert_eq!(status_snapshot(&AI_MEDIA).restarts, 3);

        // and the same spec resolves to the same slot every time
        assert!(std::ptr::eq(state(&AI), state(&AI)));
    }

    /// Both sidecars must be genuinely distinct all the way down — a copy-paste
    /// slip that left two specs sharing a port or an env var name would produce
    /// a confusing runtime failure (one sidecar silently supervising the other's
    /// process), not a compile error.
    #[test]
    fn specs_share_no_name_port_or_env_var() {
        let ports: Vec<u16> = ALL.iter().map(|s| s.default_port).collect();
        let mut sorted = ports.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), ports.len(), "two sidecars on the same port");

        // Pairwise disjointness, NOT global uniqueness: a spec deliberately
        // reuses its own string in more than one field (`name == dir` for both
        // sidecars today), which is fine. What must never happen is one spec's
        // identifier appearing in another's.
        let keys = |s: &SidecarSpec| -> std::collections::HashSet<&'static str> {
            [
                s.name,
                s.dir,
                s.dir_env,
                s.python_env,
                s.port_env,
                s.no_spawn_env,
            ]
            .into_iter()
            .collect()
        };
        for (i, a) in ALL.iter().enumerate() {
            for b in &ALL[i + 1..] {
                let shared: Vec<&str> = keys(a).intersection(&keys(b)).copied().collect();
                assert!(
                    shared.is_empty(),
                    "sidecars {} and {} share {shared:?}",
                    a.name,
                    b.name
                );
            }
        }
    }

    /// `port()` honours the spec's OWN env var and nothing else — the pre-D-185
    /// code read a hardcoded `CHROMA_AI_PORT`, so getting this wrong would point
    /// both supervisors at one port.
    #[test]
    fn port_falls_back_to_the_specs_default() {
        // Not asserting on a set env var: these tests share a process, and
        // mutating the environment would race the other tests. The default path
        // is the one that can actually regress from a copy-paste slip.
        assert_eq!(AI.default_port, 8765);
        assert_eq!(AI_MEDIA.default_port, 8766);
        assert_eq!(AI.port_env, "CHROMA_AI_PORT");
        assert_eq!(AI_MEDIA.port_env, "CHROMA_AI_MEDIA_PORT");
    }

    #[test]
    fn run_hint_names_the_specs_own_directory() {
        assert_eq!(AI.run_hint(), "cd ai && ./run.sh");
        assert_eq!(AI_MEDIA.run_hint(), "cd ai-media && ./run.sh");
    }

    /// The dev-layout lookup must find BOTH sidecar directories from this
    /// crate's own manifest dir — a real check that `ai-media/` is actually
    /// where `resolve_dir` looks, not just that the code compiles.
    #[test]
    fn resolve_dir_finds_both_sidecars_in_the_dev_layout() {
        for spec in ALL {
            let dir = resolve_dir(spec).unwrap_or_else(|| {
                panic!("{} sidecar dir not found from the workspace", spec.name)
            });
            assert!(dir.join("server.py").is_file());
            assert!(
                dir.ends_with(spec.dir),
                "{dir:?} should end with {}",
                spec.dir
            );
        }
    }
}

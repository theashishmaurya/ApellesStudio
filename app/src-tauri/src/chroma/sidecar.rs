//! Rust-managed AI sidecar lifecycle (D-028).
//!
//! Starts and supervises the `ai/` FastAPI sidecar (SAM 2 → ViTMatte, D-012 / D-016)
//! so the user never has to `cd ai && ./run.sh` by hand. Spawned on a thread from
//! `lib.rs` `.setup()`; the app-exit hook in `lib.rs` `.run(...)` calls [`shutdown`]
//! to kill the child so no uvicorn is orphaned.
//!
//! What it does:
//!   - resolve the sidecar dir + a Python interpreter (env overrides → venv → PATH)
//!   - if a sidecar is already healthy on the port, monitor it WITHOUT owning it
//!     (never kill or respawn someone else's process)
//!   - otherwise spawn `python -m uvicorn server:app`, pipe its stdout+stderr to
//!     `log::info!("[sidecar] …")`, poll `/health` until ready, then restart it
//!     with capped exponential backoff if it dies
//!   - kill the owned child on app exit
//!
//! What it does NOT do: bundle Python, create/repair the venv, install requirements,
//! or touch `grade.json`. If the venv is missing it logs a one-line fix and retries
//! every 30 s — subject mask / tracking just fail with the existing "unreachable"
//! errors until then (acceptable degradation).
//!
//! Packaged-app path resolution is a known gap — `resolve_ai_dir` keys off
//! `CARGO_MANIFEST_DIR` (a dev path) / `CHROMA_AI_DIR`. See
//! `docs/notes/sidecar-lifecycle.md` — flagged as a Phase 4 follow-up.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;

/// How long to wait for the freshly-spawned sidecar to answer `/health`.
const READY_TIMEOUT: Duration = Duration::from_secs(30);
const HEALTH_POLL: Duration = Duration::from_millis(500);
const MAX_BACKOFF: Duration = Duration::from_secs(30);
const SLOW_RETRY: Duration = Duration::from_secs(60);
/// Consecutive fast (<`HEALTHY_RUN_RESET`) failures before we drop to slow-retry.
const FAST_FAIL_GIVE_UP: u32 = 6;
/// A run that stays up at least this long resets the backoff.
const HEALTHY_RUN_RESET: Duration = Duration::from_secs(60);

/// The sidecar port. Matches `chroma::mask::sidecar_base_url()` (default 8765).
fn port() -> u16 {
    std::env::var("CHROMA_AI_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(8765)
}

// ---- child handle shared with the exit hook ---------------------------------------

struct Owned {
    child: Option<Child>,
    shutting_down: bool,
}

fn owned() -> &'static Mutex<Owned> {
    static O: OnceLock<Mutex<Owned>> = OnceLock::new();
    O.get_or_init(|| {
        Mutex::new(Owned {
            child: None,
            shutting_down: false,
        })
    })
}

fn shutting_down() -> bool {
    owned().lock().map(|g| g.shutting_down).unwrap_or(true)
}

/// Called from `lib.rs` `.run(...)` on `RunEvent::ExitRequested` / `Exit`: kill the
/// child we own so no uvicorn survives the quit. Safe to call repeatedly and safe
/// when we own nothing (external sidecar, or a spawn that never succeeded).
pub fn shutdown() {
    let mut g = owned().lock().unwrap_or_else(|p| p.into_inner());
    g.shutting_down = true;
    if let Some(mut child) = g.child.take() {
        let pid = child.id();
        log::info!("[sidecar] app exiting — killing sidecar pid {pid}");
        let _ = child.kill();
        let _ = child.wait();
    }
}

// ---- status (chroma_ai_status command) -------------------------------------------

/// Snapshot for a future UI indicator. Not required by any current view.
#[derive(Debug, Clone, Default, Serialize)]
pub struct SidecarStatus {
    /// this process spawned and owns the sidecar child
    pub managed: bool,
    /// the last `/health` poll succeeded
    pub healthy: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    /// how many times we've restarted the child since launch
    pub restarts: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

fn status() -> &'static Mutex<SidecarStatus> {
    static S: OnceLock<Mutex<SidecarStatus>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(SidecarStatus::default()))
}

fn set_status(f: impl FnOnce(&mut SidecarStatus)) {
    if let Ok(mut s) = status().lock() {
        f(&mut s);
    }
}

/// `{ managed, healthy, pid?, restarts, lastError? }` — for a future "AI: ●" pill.
#[tauri::command]
pub fn chroma_ai_status() -> SidecarStatus {
    status().lock().map(|s| s.clone()).unwrap_or_default()
}

// ---- health check ----------------------------------------------------------------
//
// A raw HTTP/1.1 GET so the supervisor thread needs no tokio runtime and no
// `reqwest/blocking` feature (the runtime `reqwest` here is async-only).

fn health_ok(port: u16) -> bool {
    let Some(addr) = format!("127.0.0.1:{port}")
        .to_socket_addrs()
        .ok()
        .and_then(|mut a| a.next())
    else {
        return false;
    };
    let Ok(mut s) = TcpStream::connect_timeout(&addr, Duration::from_secs(2)) else {
        return false;
    };
    let _ = s.set_read_timeout(Some(Duration::from_secs(3)));
    let _ = s.set_write_timeout(Some(Duration::from_secs(2)));
    if s.write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut buf = Vec::with_capacity(256);
    let _ = s.take(512).read_to_end(&mut buf);
    String::from_utf8_lossy(&buf)
        .lines()
        .next()
        .map(|l| l.contains(" 200"))
        .unwrap_or(false)
}

// ---- resolve the sidecar dir + a python interpreter ------------------------------

fn resolve_ai_dir() -> Option<PathBuf> {
    if let Ok(d) = std::env::var("CHROMA_AI_DIR") {
        let p = PathBuf::from(&d);
        if p.join("server.py").is_file() {
            return Some(p);
        }
        log::warn!("[sidecar] CHROMA_AI_DIR={d} has no server.py — ignoring it");
    }
    // Dev layout: CARGO_MANIFEST_DIR = <workspace>/engine/src-tauri, ai/ = <workspace>/ai.
    // TODO(Phase 4): packaged builds need a resource-dir lookup instead — docs/notes/sidecar-lifecycle.md.
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    for rel in ["../../ai", "../ai", "ai"] {
        let c = manifest.join(rel);
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

/// `Ok((python, ai_dir))` or `Err(one-line fix hint)`.
fn resolve() -> Result<(PathBuf, PathBuf), String> {
    let ai_dir = resolve_ai_dir().ok_or_else(|| {
        "AI sidecar can't start: no ai/ dir found. Set CHROMA_AI_DIR to the sidecar folder."
            .to_string()
    })?;

    if let Ok(p) = std::env::var("CHROMA_AI_PYTHON") {
        let pb = PathBuf::from(&p);
        if pb.is_file() {
            return Ok((pb, ai_dir));
        }
        return Err(format!(
            "AI sidecar can't start: CHROMA_AI_PYTHON={p} is not a file."
        ));
    }

    let venv = ai_dir.join(".venv/bin/python");
    if venv.is_file() {
        return Ok((venv, ai_dir));
    }

    if let Some(py3) = which("python3") {
        return Ok((py3, ai_dir));
    }

    Err(format!(
        "AI sidecar can't start: no python at {}. Run:  cd ai && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt",
        venv.display()
    ))
}

// ---- misc helpers ---------------------------------------------------------------

fn pipe_lines<R>(r: R, tail: Option<Arc<Mutex<VecDeque<String>>>>)
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        for line in BufReader::new(r).lines().map_while(Result::ok) {
            log::info!("[sidecar] {line}");
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
fn nap(total: Duration) -> bool {
    let step = Duration::from_millis(200);
    let mut left = total;
    while left > Duration::ZERO {
        if shutting_down() {
            return true;
        }
        let s = step.min(left);
        thread::sleep(s);
        left = left.saturating_sub(s);
    }
    shutting_down()
}

/// Has the owned child already exited (so the ready-poll should bail out)?
fn child_gone() -> bool {
    let mut g = owned().lock().unwrap_or_else(|p| p.into_inner());
    match g.child.as_mut() {
        Some(c) => matches!(c.try_wait(), Ok(Some(_)) | Err(_)),
        None => true,
    }
}

// ---- the supervisor -------------------------------------------------------------

/// Spawned on a thread from `lib.rs` `.setup()`. Never returns until app shutdown.
pub fn spawn_and_supervise(_app: tauri::AppHandle) {
    let port = port();

    if std::env::var_os("CHROMA_AI_NO_SPAWN").is_some() {
        log::info!(
            "[sidecar] auto-spawn disabled (CHROMA_AI_NO_SPAWN set) — run it yourself: cd ai && ./run.sh"
        );
        return;
    }

    if health_ok(port) {
        log::info!(
            "[sidecar] already running (external) on :{port} — monitoring only, will not manage or kill it"
        );
        set_status(|s| {
            s.managed = false;
            s.healthy = true;
            s.pid = None;
        });
        monitor_external(port);
        return;
    }

    let mut backoff = Duration::from_secs(2);
    let mut fast_failures = 0u32;

    while !shutting_down() {
        let (python, ai_dir) = match resolve() {
            Ok(v) => v,
            Err(hint) => {
                log::warn!("[sidecar] {hint}");
                set_status(|s| {
                    s.managed = false;
                    s.healthy = false;
                    s.last_error = Some(hint);
                });
                if nap(Duration::from_secs(30)) {
                    return;
                }
                continue;
            }
        };

        let started = Instant::now();
        log::info!(
            "[sidecar] starting: {} -m uvicorn server:app --port {port}  (cwd {})",
            python.display(),
            ai_dir.display()
        );

        let mut child = match Command::new(&python)
            .args(["-m", "uvicorn", "server:app", "--host", "127.0.0.1", "--port"])
            .arg(port.to_string())
            .current_dir(&ai_dir)
            .env("CHROMA_AI_PORT", port.to_string())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                let msg = format!("spawn failed: {e}");
                log::error!("[sidecar] {msg}");
                set_status(|s| {
                    s.managed = false;
                    s.healthy = false;
                    s.last_error = Some(msg);
                });
                if nap(backoff) {
                    return;
                }
                backoff = (backoff * 2).min(MAX_BACKOFF);
                continue;
            }
        };

        let pid = child.id();
        let tail: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));
        if let Some(o) = child.stdout.take() {
            pipe_lines(o, None);
        }
        if let Some(e) = child.stderr.take() {
            pipe_lines(e, Some(tail.clone()));
        }

        {
            let mut g = owned().lock().unwrap_or_else(|p| p.into_inner());
            if g.shutting_down {
                let _ = child.kill();
                let _ = child.wait();
                return;
            }
            g.child = Some(child);
        }
        set_status(|s| {
            s.managed = true;
            s.healthy = false;
            s.pid = Some(pid);
            s.last_error = None;
        });

        // wait-for-ready
        let ready_by = Instant::now() + READY_TIMEOUT;
        loop {
            if shutting_down() {
                return;
            }
            if child_gone() {
                break; // died during startup — handled by the supervise loop below
            }
            if health_ok(port) {
                log::info!(
                    "[sidecar] ready in {}ms (pid {pid}, http://127.0.0.1:{port})",
                    started.elapsed().as_millis()
                );
                set_status(|s| s.healthy = true);
                break;
            }
            if Instant::now() >= ready_by {
                log::warn!(
                    "[sidecar] failed to become healthy within {}s (pid {pid}) — still supervising",
                    READY_TIMEOUT.as_secs()
                );
                break;
            }
            if nap(HEALTH_POLL) {
                return;
            }
        }

        // supervise — poll try_wait so the child handle stays in owned() for the
        // exit hook. Refresh health for the status command while we wait.
        let exited: Option<std::process::ExitStatus> = loop {
            if shutting_down() {
                return;
            }
            let mut g = owned().lock().unwrap_or_else(|p| p.into_inner());
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
                    set_status(|s| s.healthy = ok);
                    if nap(Duration::from_secs(2)) {
                        return;
                    }
                }
                Err(e) => {
                    g.child = None;
                    log::error!("[sidecar] try_wait failed: {e}");
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
                "[sidecar] exited ({st}) after {ran:?} (pid {pid}). recent stderr: {tail_txt}"
            ),
            None => log::warn!(
                "[sidecar] lost the child handle after {ran:?} (pid {pid}). recent stderr: {tail_txt}"
            ),
        }
        set_status(|s| {
            s.healthy = false;
            s.restarts += 1;
            s.pid = None;
            s.last_error = Some(match &exited {
                Some(st) => format!("exited {st}: {tail_txt}"),
                None => format!("wait error: {tail_txt}"),
            });
        });

        if shutting_down() {
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
                "[sidecar] {fast_failures} fast failures in a row — check the '[sidecar]' lines above for the Python error. Slow-retrying every {}s (set CHROMA_AI_NO_SPAWN=1 to stop).",
                SLOW_RETRY.as_secs()
            );
            if nap(SLOW_RETRY) {
                return;
            }
        } else {
            log::info!("[sidecar] respawning in {backoff:?}");
            if nap(backoff) {
                return;
            }
            backoff = (backoff * 2).min(MAX_BACKOFF);
        }
    }
}

/// An external sidecar is up: health-poll and log state changes only. We never
/// spawn our own or kill theirs (spec D-028 step 3).
fn monitor_external(port: u16) {
    let mut last = true;
    loop {
        if nap(Duration::from_secs(10)) {
            return;
        }
        let ok = health_ok(port);
        if ok != last {
            if ok {
                log::info!("[sidecar] external sidecar is healthy again");
            } else {
                log::warn!(
                    "[sidecar] external sidecar stopped responding on :{port} (not managed — not restarting it)"
                );
            }
            last = ok;
            set_status(|s| s.healthy = ok);
        }
    }
}

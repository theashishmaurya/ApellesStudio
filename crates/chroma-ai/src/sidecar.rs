//! Rust-managed AI sidecar lifecycle (D-028; extracted from
//! `app/src-tauri/src/chroma/sidecar.rs` into `chroma-ai` in D-145).
//!
//! Starts and supervises the `ai/` FastAPI sidecar (SAM 2 → ViTMatte, D-012 / D-016)
//! so the user never has to `cd ai && ./run.sh` by hand. The app spawns
//! [`spawn_and_supervise`] on a thread from `lib.rs` `.setup()`; the app-exit hook in
//! `lib.rs` `.run(...)` calls [`shutdown`] to kill the child so no uvicorn is orphaned.
//!
//! What it does:
//!   - resolve the sidecar dir + a Python interpreter (env overrides → venv → PATH)
//!   - if a sidecar is already healthy on the port, monitor it WITHOUT owning it
//!     (never kill or respawn someone else's process) — D-101: also compares its
//!     self-reported `content_sha256` against this build's own `ai/server.py` on
//!     every poll, so a genuinely stale/different external process is detected
//!     and surfaced (`SidecarStatus::stale`) instead of trusted forever just for
//!     answering 200 (see `docs/notes/sidecar-lifecycle.md`'s "real ownership" TODO)
//!   - otherwise spawn `python -m uvicorn server:app`, pipe its stdout+stderr to
//!     `log::info!("[sidecar] …")`, poll `/health` until ready, then restart it
//!     with capped exponential backoff if it dies
//!   - kill the owned child on app exit
//!
//! What it does NOT do: bundle Python, create/repair the venv, install requirements,
//! or touch `grade.json`. If the venv is missing it logs a one-line fix and retries
//! every 30 s — subject mask / tracking just fail with the existing "unreachable"
//! errors until then (acceptable degradation). It also does not expose a
//! `#[tauri::command]` — the app-side `app/src-tauri/src/chroma/sidecar.rs` keeps
//! the 2-line `chroma_ai_status` wrapper around [`status_snapshot`] (D-039 §1:
//! commands do not move).
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
use sha2::{Digest, Sha256};

/// How long to wait for the freshly-spawned sidecar to answer `/health`.
const READY_TIMEOUT: Duration = Duration::from_secs(30);
const HEALTH_POLL: Duration = Duration::from_millis(500);
const MAX_BACKOFF: Duration = Duration::from_secs(30);
const SLOW_RETRY: Duration = Duration::from_secs(60);
/// Consecutive fast (<`HEALTHY_RUN_RESET`) failures before we drop to slow-retry.
const FAST_FAIL_GIVE_UP: u32 = 6;
/// A run that stays up at least this long resets the backoff.
const HEALTHY_RUN_RESET: Duration = Duration::from_secs(60);

/// The sidecar port. Matches `crate::sidecar_base_url()` (default 8765).
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

// ---- status (backs the app-side chroma_ai_status command) ------------------------

/// Snapshot for the settings-panel "AI Sidecar" status card (D-101 — the
/// first real consumer; before this, nothing did). `camelCase` on the wire
/// to match every other Chroma command struct's convention (`commands.rs`,
/// `project.rs`, `grade.rs`, etc.) — this struct predates D-101 and had
/// drifted from that convention since it had no real frontend consumer yet
/// to notice the mismatch; fixed here rather than left inconsistent now that
/// one exists.
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
    /// what this build's own `ai/server.py` would produce, so it's likely
    /// running different (probably older) code. Always `false` for a
    /// Rust-owned spawn, which is the exact code on disk by construction.
    /// `false` also when staleness genuinely can't be determined (no
    /// `content_sha256` on either side — e.g. an external sidecar built
    /// before D-101) rather than a false positive.
    pub stale: bool,
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

/// `{ managed, healthy, pid?, restarts, stale, lastError? }` — the plain-Rust
/// half of the Settings panel's "AI Sidecar" status card (D-101). The
/// app-side `#[tauri::command] chroma_ai_status` is a 1-line wrapper around
/// this (D-039 §1: commands do not move).
pub fn status_snapshot() -> SidecarStatus {
    status().lock().map(|s| s.clone()).unwrap_or_default()
}

// ---- health check ----------------------------------------------------------------
//
// A raw HTTP/1.1 GET so the supervisor thread needs no tokio runtime and no
// `reqwest/blocking` feature (the runtime `reqwest` here is async-only).

/// The `/health` fields this file actually cares about — not a full mirror
/// of `ai/server.py`'s response shape (which also carries `models`/`device`/
/// etc., irrelevant here).
struct HealthInfo {
    ok: bool,
    /// D-101 — `ai/server.py`'s own `content_sha256` (a truncated SHA256 of
    /// its own file bytes). `None` if the field was absent (an older
    /// sidecar build, from before this existed) or the body didn't parse.
    content_sha256: Option<String>,
}

/// Full `GET /health` — reads the whole response, not just the status line
/// (unlike the old `health_ok` this replaces), so the JSON body's
/// `content_sha256` (D-101) is available for staleness comparison.
/// `Connection: close` means "read to EOF" correctly gets the full body off
/// a raw `TcpStream` without needing to parse `Content-Length`/chunking.
fn health_check(port: u16) -> Option<HealthInfo> {
    let addr = format!("127.0.0.1:{port}")
        .to_socket_addrs()
        .ok()?
        .next()?;
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
        .and_then(|v| v.get("content_sha256").and_then(|s| s.as_str()).map(str::to_string));
    Some(HealthInfo { ok, content_sha256 })
}

/// Liveness only, no staleness check — the cheap path most call sites want
/// (the owned-child ready-poll and supervise loop, where we always know
/// exactly what we spawned; there's no "which build is this" question).
fn health_ok(port: u16) -> bool {
    health_check(port).map(|h| h.ok).unwrap_or(false)
}

/// D-101 — SHA256 of `ai/server.py`'s own bytes, truncated to the first 8
/// bytes (16 hex chars) — matches `ai/server.py`'s own `_CONTENT_SHA256`
/// byte-for-byte, so an external process's self-reported hash can be
/// compared against "the exact code this Rust binary would spawn."
fn content_hash(ai_dir: &Path) -> Option<String> {
    let bytes = std::fs::read(ai_dir.join("server.py")).ok()?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let digest = hasher.finalize();
    Some(digest.iter().take(8).map(|b| format!("{b:02x}")).collect())
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
    // Dev layout: CARGO_MANIFEST_DIR = <workspace>/crates/chroma-ai, ai/ = <workspace>/ai
    // (so "../../ai" still resolves — one level up from `app/src-tauri` before the
    // move, one level up from `crates/chroma-ai` after it; both are direct workspace
    // children of the repo root).
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
///
/// D-145: this used to take a `tauri::AppHandle` parameter (`_app`); it was
/// entirely unused (verified: `grep -n '_app\b'` found exactly the one hit at
/// the signature itself) — dropped when this moved into `chroma-ai`, since a
/// crate hosting this function can't depend on `tauri` for a parameter it
/// never read anyway.
pub fn spawn_and_supervise() {
    let port = port();

    if std::env::var_os("CHROMA_AI_NO_SPAWN").is_some() {
        log::info!(
            "[sidecar] auto-spawn disabled (CHROMA_AI_NO_SPAWN set) — run it yourself: cd ai && ./run.sh"
        );
        return;
    }

    // D-101 — real ownership: compute the content hash we'd expect from a
    // sidecar built off the exact `ai/server.py` this Rust binary can see,
    // *before* deciding external-vs-owned, so "already up" can be told apart
    // from "already up, but a different (probably stale) build" instead of
    // trusting any 200 forever — the actual D-069 gap. `None` here (no ai/
    // dir resolved yet) means staleness can't be determined; that's handled
    // as "unknown, not stale" below rather than a false positive.
    let expected_hash = resolve_ai_dir().and_then(|d| content_hash(&d));

    if let Some(info) = health_check(port).filter(|h| h.ok) {
        let stale = match (&expected_hash, &info.content_sha256) {
            (Some(exp), Some(got)) => exp != got,
            _ => false,
        };
        if stale {
            log::warn!(
                "[sidecar] already running (external) on :{port}, but its content_sha256 doesn't match what this build's ai/server.py would produce — likely a stale process from an older build (see D-069/D-101). Monitoring only, NOT killing or restarting a process this app didn't start — if this is unexpected, restart it by hand (kill the pid, then `cd ai && ./run.sh`)."
            );
        } else {
            log::info!(
                "[sidecar] already running (external) on :{port} — monitoring only, will not manage or kill it"
            );
        }
        set_status(|s| {
            s.managed = false;
            s.healthy = true;
            s.pid = None;
            s.stale = stale;
        });
        monitor_external(port, expected_hash);
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
            // A Rust-owned spawn is, by construction, running the exact
            // ai/server.py on disk right now — never stale. Explicit reset
            // (not just relying on the struct default) in case this status
            // transitions from a prior external+stale phase within the same
            // app session (e.g. the external process died and we took over).
            s.stale = false;
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
///
/// D-101: also re-checks `content_sha256` on the same 10s cadence, not just
/// liveness — so an external sidecar restarted *mid-session* with different
/// code (someone ran `ai/run.sh` fresh while this app stayed open) is picked
/// up as a status change without needing a full app restart to re-evaluate.
/// "Picked up" means the `stale` flag (surfaced via `chroma_ai_status`)
/// reflects reality live — this still never auto-restarts or takes over the
/// process itself; see the policy note on `SidecarStatus::stale`.
fn monitor_external(port: u16, expected_hash: Option<String>) {
    let mut last_healthy = true;
    // The caller already logged the initial stale/fresh state before handing
    // off here (it had to, to decide what to log at all) — start this loop's
    // "did it change" tracking from that same value so we don't immediately
    // re-log the state the caller just announced.
    let mut last_stale = status().lock().map(|s| s.stale).unwrap_or(false);
    loop {
        if nap(Duration::from_secs(10)) {
            return;
        }
        let info = health_check(port);
        let ok = info.as_ref().map(|h| h.ok).unwrap_or(false);
        if ok != last_healthy {
            if ok {
                log::info!("[sidecar] external sidecar is healthy again");
            } else {
                log::warn!(
                    "[sidecar] external sidecar stopped responding on :{port} (not managed — not restarting it)"
                );
            }
            last_healthy = ok;
        }
        let stale = match (&expected_hash, info.as_ref().and_then(|h| h.content_sha256.as_ref())) {
            (Some(exp), Some(got)) => exp != got,
            _ => false,
        };
        if stale != last_stale {
            if stale {
                log::warn!(
                    "[sidecar] external sidecar on :{port} now reports a content_sha256 that doesn't match — became stale mid-session (restarted externally with different code, or this app's own ai/ code changed underneath it). Not managed — not restarting it."
                );
            } else {
                log::info!(
                    "[sidecar] external sidecar on :{port} content_sha256 now matches this build's ai/server.py — no longer considered stale."
                );
            }
            last_stale = stale;
        }
        set_status(|s| {
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
        assert_eq!(got.len(), 16, "16 hex chars = first 8 bytes of the digest, matching ai/server.py's own [:16] truncation");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn content_hash_changes_when_the_file_changes_and_is_deterministic_when_it_doesnt() {
        let tmp = std::env::temp_dir().join(format!("chroma_sidecar_hash_delta_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        write_server_py(&tmp, "version A");
        let a1 = content_hash(&tmp).unwrap();
        let a2 = content_hash(&tmp).unwrap();
        assert_eq!(a1, a2, "hashing the same bytes twice must be deterministic");

        write_server_py(&tmp, "version B — a single different byte is enough");
        let b = content_hash(&tmp).unwrap();
        assert_ne!(a1, b, "a real code change must change the hash, or staleness could never be detected");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn content_hash_is_none_when_server_py_is_missing() {
        // The "no ai/ dir resolved yet" / "somehow no server.py at the
        // resolved path" case — must degrade to "can't determine," never
        // panic, since this runs on every sidecar boot decision.
        let tmp = std::env::temp_dir().join(format!("chroma_sidecar_hash_missing_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        assert!(content_hash(&tmp).is_none());
    }

    /// Mirrors the exact `match (&expected_hash, &got_hash) { ... }` staleness
    /// rule used in both `spawn_and_supervise`'s external branch and
    /// `monitor_external` — a real regression test for the actual policy
    /// (D-101): mismatch is only ever claimed when *both* sides have a real
    /// hash to compare, never inferred from one side being unknown.
    fn is_stale(expected: &Option<String>, got: &Option<String>) -> bool {
        match (expected, got) {
            (Some(exp), Some(got)) => exp != got,
            _ => false,
        }
    }

    #[test]
    fn staleness_policy_only_flags_a_real_mismatch_never_an_unknown() {
        let a = Some("aaaaaaaaaaaaaaaa".to_string());
        let b = Some("bbbbbbbbbbbbbbbb".to_string());

        assert!(is_stale(&a, &b), "two different real hashes = genuinely stale");
        assert!(!is_stale(&a, &a), "identical real hashes = not stale");
        assert!(
            !is_stale(&None, &b),
            "no expected hash (e.g. ai/ dir not resolved) — can't claim staleness we can't compute"
        );
        assert!(
            !is_stale(&a, &None),
            "external sidecar has no content_sha256 field (pre-D-101 build) — unknown, not a false positive"
        );
        assert!(!is_stale(&None, &None), "both unknown — definitely not a false positive");
    }
}

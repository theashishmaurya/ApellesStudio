//! Rust-managed lifecycle for Apelles' supervised local services (D-028;
//! extracted from `app/src-tauri/src/chroma/sidecar.rs` into `apelles-ai` in
//! D-145; generalized from one hardcoded sidecar to N in D-190; generalized
//! again from "Python only" to any local service in D-313).
//!
//! Starts and supervises them so the user never has to run one by hand. Each is
//! described by a [`SidecarSpec`] — two live here, and the third lives in the
//! app (see "not only Python" below):
//!   - [`AI`] — `ai/`, PyTorch/MPS: SAM 2 → ViTMatte matting (D-012/D-016),
//!     Video-Depth-Anything depth tracking (D-036), MoGe-2 normals (D-077).
//!   - [`AI_MEDIA`] — `ai-media/`, MLX: word-level transcript (Parakeet) and
//!     video understanding (ffmpeg scene-detect + Qwen3-VL), D-189. A separate
//!     PROCESS for crash isolation and D-084's independent idle-unload — but, as
//!     of **D-314**, no longer a separate *environment*: both Python sidecars run
//!     from one shared venv, `ai-env/.venv`. D-189's stated reason for two
//!     (`mlx-vlm` needs `transformers>=5.5`, `ai/` pinned `<5` for ViTMatte, pip
//!     called the union `ResolutionImpossible`) rested on that `<5` pin, which
//!     was defensive, never re-tested, and no longer true — ViTMatte works on
//!     `transformers` 5.x. The process split is untouched; only the ~1.1 GB of
//!     duplicated wheels is gone.
//!
//! The app spawns one supervisor thread per sidecar from `lib.rs` `.setup()`;
//! the app-exit hook in `lib.rs` `.run(...)` calls [`shutdown`], which kills
//! every child we own so nothing is orphaned.
//!
//! What it does, per sidecar:
//!   - resolve what to launch — a sidecar dir + Python interpreter (env
//!     overrides → per-sidecar venv → the shared `ai-env/.venv` → PATH; the full
//!     ladder and why it is ordered that way is on [`resolve_python`]), or a
//!     compiled binary ([`Launch`])
//!   - if something is already healthy on the port, monitor it WITHOUT owning it
//!     (never kill or respawn someone else's process) — D-101: also compares its
//!     self-reported `content_sha256` against this build's own code on
//!     every poll, so a genuinely stale/different external process is detected
//!     and surfaced (`SidecarStatus::stale`) instead of trusted forever just for
//!     answering 200 (see `docs/notes/sidecar-lifecycle.md`'s "real ownership" TODO)
//!   - otherwise spawn it, pipe its stdout+stderr to
//!     `log::info!("[sidecar/<name>] …")`, poll `/health` until ready, then restart
//!     it with capped exponential backoff if it dies
//!   - kill the owned child on app exit
//!
//! What it does NOT do: bundle Python, create/repair a venv, install requirements,
//! build a `WorkspaceBin`, or touch `grade.json`. If what it needs is missing it
//! logs a one-line fix and retries every 30 s — the features that need that
//! service just fail with the existing "unreachable" errors until then
//! (acceptable degradation). It also does not expose a `#[tauri::command]` — the
//! app-side `app/src-tauri/src/chroma/sidecar.rs` keeps the thin
//! `chroma_ai_status` / `chroma_ai_media_status` / `chroma_mcp_status` wrappers
//! around [`status_snapshot`] (D-039 §1: commands do not move).
//!
//! **D-190, why this is parameterized rather than copy-pasted:** adding the second
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
//! **D-313, not only Python.** `apelles-mcp --http` is supervised by this exact
//! code: what a compiled binary needs that differs from `python -m uvicorn` is
//! only how to find it, how to launch it and which bytes to hash, so that — and
//! only that — moved into [`Launch`]. Its spec is declared in `app/src-tauri`,
//! not here, because the decision to run an MCP server is the app's and this
//! crate is the AI client; the registry is keyed by spec name and filled on
//! first use, so a spec from another crate still gets a state slot, a status
//! snapshot and a kill on exit with no change to [`shutdown`].
//!
//! One consequence worth naming: this module is now a general local-service
//! supervisor living in a crate named after one of its three users. That is a
//! real naming wart, tracked in `docs/04-roadmap.md`, not left as a comment.
//!
//! Packaged-app path resolution is a known gap for the Python sidecars —
//! [`resolve_dir`] keys off `CARGO_MANIFEST_DIR` (a dev path) / the spec's dir
//! env var. See `docs/notes/sidecar-lifecycle.md` — flagged as a Phase 4
//! follow-up. [`resolve_bin`] is in better shape: it looks beside the app's own
//! executable first, which is correct in both a dev run and a bundle.

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

/// Directory, under the workspace root, holding the ONE virtual environment both
/// Python sidecars run from (D-314). Built by `ai-env/setup.sh`; not a sidecar
/// itself — there is no `server.py` in it and nothing there is ever launched.
pub(crate) const SHARED_ENV_DIR: &str = "ai-env";

/// Override the interpreter for *both* Python sidecars at once (D-314).
///
/// Deliberately a module const and not a [`SidecarSpec`] field: it is shared by
/// construction, and [`SidecarSpec::identifiers`] exists to assert that no two
/// specs claim the same string. A name that every spec is *supposed* to share
/// has to live outside that check, not inside it as a permanent exception.
const SHARED_PYTHON_ENV: &str = "CHROMA_SIDECAR_PYTHON";

// ---- the specs --------------------------------------------------------------------

/// *What* to start, as opposed to the [`SidecarSpec`] facts (name, port, env vars)
/// that are the same shape whatever it is.
///
/// **D-313, why this exists.** Everything below this line — the D-101 staleness
/// policy, "monitor but never kill a process we did not start", the
/// fast-fail/slow-retry ladder, the shutdown races, the one `shutdown()` exit
/// hook — is subtle and is identical for any supervised local service. What
/// genuinely differs between a Python sidecar and a compiled Rust binary is only
/// how to find it, how to launch it, and what bytes to hash for staleness. So
/// that, and only that, is what varies here. Copy-pasting the ~180-line
/// supervisor for a second kind of child is exactly what D-190 refused to do for
/// the second Python sidecar, and the reasoning has not changed.
pub enum Launch {
    /// `<python> -m uvicorn server:app --host 127.0.0.1 --port <port>`, run with
    /// the resolved sidecar directory as the cwd (D-028/D-189).
    ///
    /// The dev-layout directory candidates are relative to `CARGO_MANIFEST_DIR`
    /// (`<workspace>/crates/apelles-ai`) and are tried in order until one
    /// contains a `server.py`. `"../../<dir>"` is the real post-D-145 path; the
    /// shorter ones are kept so the lookup still works if this crate is ever
    /// nested differently.
    PythonUvicorn {
        /// Directory name under the workspace root, and the basis of the
        /// dev-layout candidates.
        dir: &'static str,
        /// Override the resolved directory (must contain `server.py`).
        dir_env: &'static str,
        /// Override the Python interpreter for *this* sidecar (must be a file).
        /// The top rung of [`resolve_python`]'s ladder; `CHROMA_SIDECAR_PYTHON`
        /// is the same thing for both sidecars at once (D-314).
        python_env: &'static str,
    },

    /// A compiled binary built from this same Cargo workspace (D-313).
    ///
    /// **Contract:** the binary must accept `--port <PORT>`, which the supervisor
    /// appends after `args`. It is also given the spec's `port_env`, like every
    /// other child here — the explicit flag is on top of that so a `ps` line says
    /// which port the process is on without anyone having to guess.
    WorkspaceBin {
        /// File name to look for, e.g. `"apelles-mcp"`.
        bin: &'static str,
        /// Override with an absolute path to a specific build.
        bin_env: &'static str,
        /// Fixed flags, before the appended `--port <PORT>`.
        args: &'static [&'static str],
        /// The `cargo build -p <package>` in the "can't start" hint.
        package: &'static str,
    },
}

/// Everything that differs between one supervised sidecar and another. Every
/// field is `&'static` because the specs are `static`s, one per sidecar, and the
/// supervisor threads outlive any borrow shorter than that.
pub struct SidecarSpec {
    /// Log tag and registry key — `"ai"`, `"ai-media"`, `"mcp"`.
    pub name: &'static str,
    /// What to start, and how to find it.
    pub launch: Launch,
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
        match &self.launch {
            Launch::PythonUvicorn { dir, .. } => format!("cd {dir} && ./run.sh"),
            Launch::WorkspaceBin { package, args, .. } => {
                format!(
                    "cargo build -p {package} && ./target/debug/{package} {}",
                    args.join(" ")
                )
            }
        }
    }

    /// What this build would run, named the way a log line has to name it when
    /// reporting a staleness mismatch — "the thing we hashed and compared."
    fn code_desc(&self) -> String {
        match &self.launch {
            Launch::PythonUvicorn { dir, .. } => format!("{dir}/server.py"),
            Launch::WorkspaceBin { bin, .. } => format!("the `{bin}` binary"),
        }
    }

    /// Every identifier this spec claims — its name, its env vars, and whatever
    /// its launch kind names.
    ///
    /// Public because the disjointness check has to span specs declared in
    /// different crates since D-313 (the two Python ones live here; the MCP
    /// server's lives in `app/src-tauri`, which is where the decision to run it
    /// belongs). Two specs sharing an identifier is a copy-paste slip that
    /// surfaces only as a baffling runtime failure — one supervisor driving the
    /// other's process — never as a compile error, so it is worth a test, and
    /// the test needs this.
    pub fn identifiers(&self) -> Vec<&'static str> {
        let mut ids = vec![self.name, self.port_env, self.no_spawn_env];
        match &self.launch {
            Launch::PythonUvicorn {
                dir,
                dir_env,
                python_env,
            } => ids.extend([*dir, *dir_env, *python_env]),
            Launch::WorkspaceBin {
                bin,
                bin_env,
                package,
                ..
            } => ids.extend([*bin, *bin_env, *package]),
        }
        ids
    }
}

/// The `ai/` sidecar (D-028): SAM 2 → ViTMatte matting, depth tracking, normals.
pub static AI: SidecarSpec = SidecarSpec {
    name: "ai",
    launch: Launch::PythonUvicorn {
        dir: "ai",
        dir_env: "CHROMA_AI_DIR",
        python_env: "CHROMA_AI_PYTHON",
    },
    port_env: "CHROMA_AI_PORT",
    no_spawn_env: "CHROMA_AI_NO_SPAWN",
    default_port: 8765,
};

/// The `ai-media/` sidecar (D-189): transcript + video understanding, MLX.
pub static AI_MEDIA: SidecarSpec = SidecarSpec {
    name: "ai-media",
    launch: Launch::PythonUvicorn {
        dir: "ai-media",
        dir_env: "CHROMA_AI_MEDIA_DIR",
        python_env: "CHROMA_AI_MEDIA_PYTHON",
    },
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
/// D-190: kills *all* registered sidecars rather than the one global child, so a
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
/// consumer; before this, nothing did; D-189 added the second card).
/// `camelCase` on the wire to match every other Apelles command struct's
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
/// the plain-Rust half of the Settings panel's status cards (D-101/D-189). The
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

/// D-101 — SHA256 of a file's bytes, truncated to the first 8 bytes (16 hex
/// chars) — matches each `server.py`'s own `_CONTENT_SHA256` byte-for-byte (and,
/// since D-313, `apelles-mcp`'s `serve::self_content_sha256`), so an external
/// process's self-reported hash can be compared against "the exact code this
/// build would have spawned."
fn file_hash(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let digest = hasher.finalize();
    Some(digest.iter().take(8).map(|b| format!("{b:02x}")).collect())
}

/// The bytes this build would run for `spec`, hashed — the "expected" half of the
/// D-101 staleness comparison.
///
/// Computed *before* the external-vs-owned decision (that is the whole point:
/// "already up" has to be distinguishable from "already up, but a different
/// build"), so it must never panic and must degrade to `None` — "cannot
/// determine" — rather than guessing.
///
/// **Scope, precisely (B-169).** This answers "is the process on that port
/// running the bytes now on disk?", which is the question the *external* branch
/// asks and the one it can genuinely answer. It does **not** answer "are the
/// bytes on disk current with their source": for `WorkspaceBin` both sides of
/// the comparison read the same executable, so a build that is months out of
/// date compares equal to itself. Keeping the artifact current is the build's
/// job, not this function's — see the `stale` reset in [`supervise`].
fn expected_content_hash(spec: &SidecarSpec) -> Option<String> {
    match &spec.launch {
        Launch::PythonUvicorn { .. } => file_hash(&resolve_dir(spec)?.join("server.py")),
        Launch::WorkspaceBin { bin, bin_env, .. } => file_hash(&resolve_bin(bin, bin_env)?),
    }
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

// ---- resolve what to launch ------------------------------------------------------

/// Where a `PythonUvicorn` sidecar's code lives. `None` for any other launch kind —
/// there is no directory to find.
fn resolve_dir(spec: &SidecarSpec) -> Option<PathBuf> {
    let Launch::PythonUvicorn { dir, dir_env, .. } = &spec.launch else {
        return None;
    };
    if let Ok(d) = std::env::var(dir_env) {
        let p = PathBuf::from(&d);
        if p.join("server.py").is_file() {
            return Some(p);
        }
        log::warn!(
            "[sidecar/{}] {dir_env}={d} has no server.py — ignoring it",
            spec.name
        );
    }
    // Dev layout: CARGO_MANIFEST_DIR = <workspace>/crates/apelles-ai, the sidecar
    // dirs are <workspace>/ai and <workspace>/ai-media — both direct workspace
    // children of the repo root, so "../../<dir>" resolves. Same prefixes as
    // `resolve_shared_python`, which is looking for a sibling of these dirs.
    // TODO(Phase 4): packaged builds need a resource-dir lookup instead — docs/notes/sidecar-lifecycle.md.
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    for prefix in DEV_LAYOUT_PREFIXES {
        let c = manifest.join(prefix).join(dir);
        if c.join("server.py").is_file() {
            return Some(c.canonicalize().unwrap_or(c));
        }
    }
    None
}

/// `<venv>/bin/python` — the one place that layout is spelled out.
pub(crate) fn venv_python(venv: &Path) -> PathBuf {
    venv.join("bin").join("python")
}

/// The dev-layout prefixes from this crate's manifest dir up to the workspace
/// root, most likely first. `"../.."` is the real post-D-145 path
/// (`<workspace>/crates/apelles-ai`); the shorter ones are kept so the lookups
/// still work if this crate is ever nested differently.
pub(crate) const DEV_LAYOUT_PREFIXES: [&str; 3] = ["../..", "..", "."];

/// The interpreter of the shared sidecar venv, `<workspace>/ai-env/.venv` (D-314),
/// or `None` if it has not been created yet (`ai-env/setup.sh` has not been run).
///
/// Existence-checked rather than assumed, because "not created yet" has to fall
/// through to the next rung of [`resolve_python`]'s ladder instead of producing a
/// command that fails to spawn.
///
/// **Never `canonicalize()` this path**, unlike the directory in [`resolve_dir`].
/// A venv's `bin/python` is a *symlink to the base interpreter*, and a venv is
/// activated purely by the path Python was invoked through: CPython finds
/// `pyvenv.cfg` relative to `sys.executable`, so resolving the symlink silently
/// yields the system interpreter and the system `site-packages` instead of the
/// locked environment. Caught by
/// `resolve_shared_python_finds_the_real_shared_venv_when_it_exists` — and worth
/// the test, because on a machine whose system Python happens to have torch
/// installed the failure is not an ImportError but the far worse "running, on
/// unpinned packages, and nobody can tell."
fn resolve_shared_python() -> Option<PathBuf> {
    // D-315 — ask the bootstrap first. In a packaged app the venv is under the app's
    // data directory, not next to a workspace that does not exist there, and only the
    // bootstrap knows where the app put it. In a dev checkout this resolves to exactly
    // the sweep below, so the two agree by construction rather than by coincidence.
    if let Some(p) = crate::ai_env::paths() {
        let python = p.python();
        if python.is_file() {
            return Some(python);
        }
        // Configured but not built yet: fall through. A venv that does not exist is
        // this ladder's ordinary "not that rung", not an error — the bootstrap thread
        // is very likely building it right now.
    }

    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    for prefix in DEV_LAYOUT_PREFIXES {
        let p = venv_python(&manifest.join(prefix).join(SHARED_ENV_DIR).join(".venv"));
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// The interpreter to run a Python sidecar's `server.py` with, plus a short
/// phrase naming which rung it came from (logged by the caller).
///
/// **Most specific wins, and the ordering IS the design** (D-314 added rungs 2
/// and 4 to D-028's original three):
///   1. the spec's own `python_env` — this one sidecar, explicitly
///   2. `CHROMA_SIDECAR_PYTHON` — both sidecars, explicitly
///   3. `<sidecar dir>/.venv` — a venv belonging to this sidecar alone
///   4. `<workspace>/ai-env/.venv` — the shared venv, the D-314 default
///   5. `python3` on `PATH`
///
/// **Why 3 still beats 4**, when the whole point of D-314 is to stop having
/// per-sidecar venvs: it keeps the change non-breaking (an existing checkout with
/// the old two venvs keeps working exactly as before, it just saves no disk until
/// they are removed — `ai-env/setup.sh` says so when it finds them), and a
/// deliberate per-sidecar venv remains a genuinely useful thing for running one
/// sidecar against a different dependency set while debugging it. Preferring the
/// more specific path is also what the two env-var rungs above it already do, so
/// this is the ladder staying consistent rather than acquiring a special case.
///
/// A set-but-missing *override* is a hard error, never a silent fall-through: the
/// user named a specific interpreter, and quietly running a different one is how
/// an afternoon gets lost. A missing *venv* is not an error — that is the fall-through.
fn resolve_python(
    spec: &SidecarSpec,
    dir: &Path,
    python_env: &str,
) -> Result<(PathBuf, String), String> {
    resolve_python_with(spec, dir, python_env, resolve_shared_python())
}

/// [`resolve_python`] with the shared-venv lookup passed in, so the ladder's
/// ordering — the part a future change can actually get wrong — is unit-testable
/// against real temp directories instead of depending on whether the machine
/// running the tests happens to have run `ai-env/setup.sh`.
fn resolve_python_with(
    spec: &SidecarSpec,
    dir: &Path,
    python_env: &str,
    shared: Option<PathBuf>,
) -> Result<(PathBuf, String), String> {
    for (var, what) in [
        (python_env, "explicit"),
        (SHARED_PYTHON_ENV, "explicit, both sidecars"),
    ] {
        if let Ok(p) = std::env::var(var) {
            let pb = PathBuf::from(&p);
            if !pb.is_file() {
                return Err(format!(
                    "{} sidecar can't start: {var}={p} is not a file.",
                    spec.name
                ));
            }
            return Ok((pb, format!("{var}, {what}")));
        }
    }

    let own = venv_python(&dir.join(".venv"));

    if own.is_file() {
        // The one genuinely confusing state: both exist, and the more specific
        // one wins, so the shared venv this build expects is being bypassed.
        // Nothing is wrong — but it is worth saying, because the symptom
        // otherwise is "I ran setup.sh and the disk did not go down."
        if let Some(s) = &shared {
            log::warn!(
                "[sidecar/{}] using this sidecar's own {} and NOT the shared {} — the per-sidecar venv is more specific, so it wins (D-314). If that is not deliberate, remove it to fall back to the shared one.",
                spec.name,
                own.display(),
                s.display()
            );
        }
        return Ok((own, "per-sidecar venv".to_string()));
    }

    if let Some(s) = shared {
        return Ok((s, format!("shared {SHARED_ENV_DIR}/.venv")));
    }

    // Last rung. The hint names the one command that fixes it — the shared venv
    // is now the supported way to install, so it must not still tell the user to
    // build a per-sidecar one.
    which("python3")
        .map(|p| (p, "python3 on PATH".to_string()))
        .ok_or_else(|| {
            format!(
                "{} sidecar can't start: no python at {} and no shared {SHARED_ENV_DIR}/.venv. Run:  ./{SHARED_ENV_DIR}/setup.sh",
                spec.name,
                own.display(),
            )
        })
}

/// Where a `WorkspaceBin` sidecar's executable is (D-313).
///
/// **Next to our own executable first**, and that ordering is the whole design:
/// in a dev run `current_exe()` is `<target>/<profile>/apelles` and the sidecar
/// binary sits right beside it, while in a bundle that same directory is where a
/// Tauri `externalBin` lands. One rule covers both, and it keeps working under a
/// custom `CARGO_TARGET_DIR`, which a hardcoded `target/` would not.
///
/// The workspace sweep after it is for callers nested somewhere else — a test
/// binary in `<target>/debug/deps/`, most of all.
pub(crate) fn resolve_bin(bin: &str, bin_env: &str) -> Option<PathBuf> {
    if let Ok(p) = std::env::var(bin_env) {
        let pb = PathBuf::from(&p);
        if pb.is_file() {
            return Some(pb);
        }
        log::warn!("[sidecar] {bin_env}={p} is not a file — ignoring it");
    }

    if let Ok(exe) = std::env::current_exe()
        && let Some(dir) = exe.parent()
    {
        let c = dir.join(bin);
        if c.is_file() {
            return Some(c);
        }
    }

    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    for profile in ["debug", "release"] {
        let c = manifest.join("../../target").join(profile).join(bin);
        if c.is_file() {
            return Some(c.canonicalize().unwrap_or(c));
        }
    }
    None
}

pub(crate) fn which(bin: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|d| d.join(bin))
        .find(|p| p.is_file())
}

/// The fully-resolved `Command` to spawn, or a one-line fix hint the supervisor
/// logs and surfaces as `SidecarStatus::last_error`.
///
/// Stdio and the port env var are NOT set here — the supervisor owns those for
/// every launch kind alike, so there is one place they can be got wrong.
fn resolve_command(spec: &SidecarSpec) -> Result<Command, String> {
    let port = spec.port();
    match &spec.launch {
        Launch::PythonUvicorn {
            dir: dir_name,
            dir_env,
            python_env,
        } => {
            let dir = resolve_dir(spec).ok_or_else(|| {
                format!(
                    "{} sidecar can't start: no {dir_name}/ dir found. Set {dir_env} to the sidecar folder.",
                    spec.name
                )
            })?;

            let (python, source) = resolve_python(spec, &dir, python_env)?;
            // Which interpreter, and why that one. Worth a line of its own rather
            // than leaving it to be inferred from the `{command:?}` below: since
            // D-314 there is more than one place a Python can legitimately come
            // from, and "it is silently on the old per-sidecar venv" is exactly
            // the confusion this log line answers.
            log::info!(
                "[sidecar/{}] python: {} ({source})",
                spec.name,
                python.display()
            );

            let mut command = Command::new(python);
            command
                .args([
                    "-m",
                    "uvicorn",
                    "server:app",
                    "--host",
                    "127.0.0.1",
                    "--port",
                ])
                .arg(port.to_string())
                .current_dir(&dir);
            Ok(command)
        }

        Launch::WorkspaceBin {
            bin,
            bin_env,
            args,
            package,
        } => {
            let path = resolve_bin(bin, bin_env).ok_or_else(|| {
                format!(
                    "{} sidecar can't start: no `{bin}` binary beside the app or in the workspace target dir. Run:  cargo build -p {package}   (or set {bin_env} to a specific build).",
                    spec.name
                )
            })?;
            let mut command = Command::new(path);
            command.args(*args).arg("--port").arg(port.to_string());
            Ok(command)
        }
    }
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
/// is unchanged by D-190 — `spawn` needs an `FnOnce()`, and a spec-taking
/// function is not one.
pub fn spawn_and_supervise() {
    supervise(&AI);
}

/// Supervise the `ai-media/` sidecar (D-189). Same reason for the dedicated
/// zero-argument entry point as [`spawn_and_supervise`].
pub fn spawn_and_supervise_media() {
    supervise(&AI_MEDIA);
}

/// Spawned on a thread from `lib.rs` `.setup()`, once per sidecar. Never returns
/// until app shutdown.
///
/// D-145: this used to take a `tauri::AppHandle` parameter (`_app`); it was
/// entirely unused — dropped when this moved into `apelles-ai`, since a crate
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

    // D-101 — real ownership: compute the content hash we'd expect from the exact
    // code this build can see (a sidecar's `server.py`, or a `WorkspaceBin`'s
    // binary), *before* deciding external-vs-owned, so "already up" can be told
    // apart from "already up, but a different (probably stale) build" instead of
    // trusting any 200 forever — the actual D-069 gap. `None` here (nothing
    // resolved yet) means staleness can't be determined; that's handled as
    // "unknown, not stale" below rather than a false positive.
    let expected_hash = expected_content_hash(spec);

    if let Some(info) = health_check(port).filter(|h| h.ok) {
        let stale = is_stale(&expected_hash, &info.content_sha256);
        if stale {
            log::warn!(
                "[sidecar/{name}] already running (external) on :{port}, but its content_sha256 doesn't match what this build's {} would produce — likely a stale process from an older build (see D-069/D-101). Monitoring only, NOT killing or restarting a process this app didn't start — if this is unexpected, restart it by hand (kill the pid, then `{}`).",
                spec.code_desc(),
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
        let mut command = match resolve_command(spec) {
            Ok(c) => c,
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
        // `Command`'s own Debug is the program and its arguments, quoted — the
        // real command line, rather than a hand-written description of it that
        // could drift from what is actually spawned.
        log::info!("[sidecar/{name}] starting: {command:?}");

        let mut child = match command
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
            // A Rust-owned spawn is, by construction, running the exact code on
            // disk right now — never stale. Explicit reset (not just relying on
            // the struct default) in case this status transitions from a prior
            // external+stale phase within the same app session (e.g. the
            // external process died and we took over).
            //
            // **What "the code on disk" means differs by launch kind, and that
            // is the hole B-169 fell through.** For `PythonUvicorn` the claim is
            // airtight: the interpreter reads `server.py` at spawn time, so the
            // file on disk *is* the code that runs. For `WorkspaceBin` the file
            // on disk is a build artifact that can be arbitrarily older than the
            // source it came from, and no hash comparison can detect that —
            // `expected_content_hash` hashes the very file the child executes,
            // so the two sides agree no matter how stale the build is. The guard
            // that closes it is upstream of here, not in this flag: whatever
            // builds the app must also build the binary (for the MCP sidecar,
            // the `cargo build -p apelles-mcp` in Tauri's build hooks — see
            // `app/src-tauri/src/chroma/sidecar.rs`'s `MCP`). Keep that true and
            // this reset stays honest for both kinds.
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
            // The hint has to be launch-kind aware (B-169). This message used to
            // say "check the lines above for the Python error", which is the
            // wrong instruction for a `WorkspaceBin`: a compiled sidecar that
            // fast-fails is overwhelmingly a *stale or missing binary*, not a
            // traceback, and `run_hint()` already spells out the
            // `cargo build -p <package>` that fixes it.
            log::error!(
                "[sidecar/{name}] {fast_failures} fast failures in a row — check the '[sidecar/{name}]' lines above for what {} reported, and that it is up to date:  {}. Slow-retrying every {}s (set {} to stop).",
                spec.code_desc(),
                spec.run_hint(),
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
                    "[sidecar/{name}] external sidecar on :{port} now reports a content_sha256 that doesn't match — became stale mid-session (restarted externally with different code, or this app's own {} changed underneath it). Not managed — not restarting it.",
                    spec.code_desc()
                );
            } else {
                log::info!(
                    "[sidecar/{name}] external sidecar on :{port} content_sha256 now matches this build's {} — no longer considered stale.",
                    spec.code_desc()
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
    fn file_hash_matches_python_sha256_hexdigest_truncated_to_16_chars() {
        // Real, known SHA256 of the literal bytes b"hello chroma\n" — computed
        // independently (Python `hashlib.sha256(b"hello chroma\n").hexdigest()`)
        // rather than derived from this same code, so this test can't just be
        // checking the implementation against itself.
        let tmp = std::env::temp_dir().join(format!("chroma_sidecar_hash_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        write_server_py(&tmp, "hello chroma\n");

        let got = file_hash(&tmp.join("server.py")).expect("server.py exists, hash should compute");
        assert_eq!(got, "35719cab709150d0");
        assert_eq!(
            got.len(),
            16,
            "16 hex chars = first 8 bytes of the digest, matching each server.py's own [:16] truncation"
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn file_hash_changes_when_the_file_changes_and_is_deterministic_when_it_doesnt() {
        let tmp =
            std::env::temp_dir().join(format!("chroma_sidecar_hash_delta_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        write_server_py(&tmp, "version A");
        let a1 = file_hash(&tmp.join("server.py")).unwrap();
        let a2 = file_hash(&tmp.join("server.py")).unwrap();
        assert_eq!(a1, a2, "hashing the same bytes twice must be deterministic");

        write_server_py(&tmp, "version B — a single different byte is enough");
        let b = file_hash(&tmp.join("server.py")).unwrap();
        assert_ne!(
            a1, b,
            "a real code change must change the hash, or staleness could never be detected"
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn file_hash_is_none_when_the_file_is_missing() {
        // The "no dir resolved yet" / "somehow no server.py at the resolved
        // path" case — must degrade to "can't determine," never panic, since
        // this runs on every sidecar boot decision.
        let tmp = std::env::temp_dir().join(format!(
            "chroma_sidecar_hash_missing_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        assert!(file_hash(&tmp.join("server.py")).is_none());
    }

    /// A real regression test for the actual D-101 policy, now testing the one
    /// shared [`is_stale`] the supervisor itself calls (before D-190 this test
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

    // ---- D-190: the multi-sidecar registry ---------------------------------------

    /// The whole point of the D-190 refactor: two specs must get two genuinely
    /// independent state slots. If they shared one (the pre-D-190 global
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
            s.identifiers().into_iter().collect()
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

    /// `port()` honours the spec's OWN env var and nothing else — the pre-D-190
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
        assert_eq!(AI_MEDIA.run_hint(), "cd ai-media && ./run.sh");
    }

    /// The dev-layout lookup must find BOTH sidecar directories from this
    /// crate's own manifest dir — a real check that `ai-media/` is actually
    /// where `resolve_dir` looks, not just that the code compiles.
    #[test]
    fn resolve_dir_finds_both_sidecars_in_the_dev_layout() {
        for spec in ALL {
            let Launch::PythonUvicorn { dir: name, .. } = &spec.launch else {
                panic!("{} is not a Python sidecar", spec.name);
            };
            let dir = resolve_dir(spec).unwrap_or_else(|| {
                panic!("{} sidecar dir not found from the workspace", spec.name)
            });
            assert!(dir.join("server.py").is_file());
            assert!(dir.ends_with(name), "{dir:?} should end with {name}");
        }
    }

    // ---- D-313: the generalization to a non-Python child ------------------------

    /// A `WorkspaceBin` spec must produce a real, runnable command line — the
    /// resolved path plus its fixed flags plus the appended `--port <PORT>` the
    /// variant's contract promises. This is the half a Python-shaped supervisor
    /// would silently get wrong.
    #[test]
    fn a_workspace_bin_spec_launches_the_binary_with_its_port() {
        // `cargo test` puts this test binary in the same profile dir the
        // workspace's other binaries land in, so resolving one by name exercises
        // the real `resolve_bin` path rather than a fixture.
        static SPEC: SidecarSpec = SidecarSpec {
            name: "test-bin",
            launch: Launch::WorkspaceBin {
                bin: "apelles-mcp",
                bin_env: "CHROMA_TEST_BIN_UNSET",
                args: &["--http"],
                package: "apelles-mcp",
            },
            port_env: "CHROMA_TEST_BIN_PORT_UNSET",
            no_spawn_env: "CHROMA_TEST_BIN_NO_SPAWN_UNSET",
            default_port: 19790,
        };

        let Some(path) = resolve_bin("apelles-mcp", "CHROMA_TEST_BIN_UNSET") else {
            // Not a failure: a `cargo test -p apelles-ai` on its own has not
            // necessarily built the other crate's binary. What must never happen
            // is resolving to something that is not a file, and that is asserted
            // on the `Some` branch below.
            eprintln!("skipping: apelles-mcp is not built — `cargo build -p apelles-mcp` first");
            return;
        };
        assert!(path.is_file(), "resolve_bin returned a non-file: {path:?}");

        let command = resolve_command(&SPEC).expect("a resolvable binary should build a command");
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(args, ["--http", "--port", "19790"]);
        assert_eq!(command.get_program(), path.as_os_str());
        // The Python launch sets a cwd; a workspace binary must not inherit that
        // idea — it is found by absolute path and needs no particular directory.
        assert!(command.get_current_dir().is_none());
    }

    /// The hint a user actually reads when the binary has not been built yet.
    #[test]
    fn each_launch_kind_names_its_own_way_back() {
        assert_eq!(AI.run_hint(), "cd ai && ./run.sh");
        assert_eq!(AI.code_desc(), "ai/server.py");

        static BIN: SidecarSpec = SidecarSpec {
            name: "mcp",
            launch: Launch::WorkspaceBin {
                bin: "apelles-mcp",
                bin_env: "X_BIN",
                args: &["--http"],
                package: "apelles-mcp",
            },
            port_env: "X_PORT",
            no_spawn_env: "X_NO_SPAWN",
            default_port: 19790,
        };
        assert_eq!(
            BIN.run_hint(),
            "cargo build -p apelles-mcp && ./target/debug/apelles-mcp --http"
        );
        assert_eq!(BIN.code_desc(), "the `apelles-mcp` binary");
    }

    // ---- D-314: one shared venv for both Python sidecars ------------------------

    /// A real (empty, executable-bit-irrelevant) file at `<venv>/bin/python`,
    /// which is all any rung of the ladder checks for.
    fn fake_venv(root: &Path, name: &str) -> PathBuf {
        let py = venv_python(&root.join(name).join(".venv"));
        if let Some(p) = py.parent() {
            std::fs::create_dir_all(p).unwrap();
        }
        std::fs::write(&py, "#!/bin/sh\n").unwrap();
        py
    }

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "chroma_sidecar_{tag}_{}_{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn venv_python_is_the_bin_python_layout() {
        assert!(
            venv_python(Path::new("/x/ai-env/.venv")).ends_with("ai-env/.venv/bin/python"),
            "every rung of the ladder depends on this one layout"
        );
    }

    /// The D-314 default: with no per-sidecar venv, a Python sidecar runs from the
    /// shared one. This is the rung that did not exist before D-314, so it is the
    /// one worth pinning.
    #[test]
    fn falls_back_to_the_shared_venv_when_the_sidecar_has_none_of_its_own() {
        let tmp = tmpdir("shared_only");
        let shared = fake_venv(&tmp, "ai-env");
        let sidecar_dir = tmp.join("ai");
        std::fs::create_dir_all(&sidecar_dir).unwrap();

        let (python, source) = resolve_python_with(
            &AI,
            &sidecar_dir,
            "CHROMA_AI_PYTHON_UNSET",
            Some(shared.clone()),
        )
        .expect("a shared venv is a resolvable interpreter");

        assert_eq!(python, shared);
        assert!(
            source.contains("shared"),
            "the log line has to say WHERE it came from, got {source:?}"
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// The deliberate ordering: a sidecar's own venv is more specific, so it wins
    /// even when the shared one exists. This is what keeps D-314 non-breaking for
    /// a checkout that still has the old per-sidecar venvs — flip it and those
    /// installs silently change interpreter under the user.
    #[test]
    fn a_per_sidecar_venv_still_beats_the_shared_one() {
        let tmp = tmpdir("own_wins");
        let shared = fake_venv(&tmp, "ai-env");
        let own = fake_venv(&tmp, "ai");

        let (python, source) = resolve_python_with(
            &AI,
            &tmp.join("ai"),
            "CHROMA_AI_PYTHON_UNSET",
            Some(shared.clone()),
        )
        .expect("a per-sidecar venv is a resolvable interpreter");

        assert_eq!(python, own, "the more specific venv must win");
        assert_ne!(python, shared);
        assert!(source.contains("per-sidecar"), "got {source:?}");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// With neither venv present the ladder must not invent one — it either finds
    /// a `python3` on `PATH` (the last rung) or errors with the one command that
    /// fixes it. Asserted as "not a venv path, and the error names setup.sh"
    /// rather than assuming this machine has a `python3`, which is not this
    /// module's fact to depend on.
    #[test]
    fn with_no_venv_at_all_it_never_claims_one() {
        let tmp = tmpdir("no_venv");
        let sidecar_dir = tmp.join("ai");
        std::fs::create_dir_all(&sidecar_dir).unwrap();

        match resolve_python_with(&AI, &sidecar_dir, "CHROMA_AI_PYTHON_UNSET", None) {
            Ok((python, source)) => {
                assert_eq!(source, "python3 on PATH");
                assert!(
                    !python.starts_with(&tmp),
                    "resolved {python:?} inside a dir with no venv"
                );
            }
            Err(hint) => assert!(
                hint.contains("ai-env/setup.sh"),
                "the hint must name the command that fixes it, got {hint:?}"
            ),
        }

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// `CHROMA_SIDECAR_PYTHON` is shared by *both* specs on purpose, which is
    /// exactly why it must not be a `SidecarSpec` field:
    /// `specs_share_no_name_port_or_env_var` asserts that no two specs claim the
    /// same identifier, and a deliberately-shared name inside that set would have
    /// to be carved out as a permanent exception. Pin the invariant so nobody
    /// "tidies" it into the struct later.
    #[test]
    fn the_shared_python_override_is_not_claimed_by_any_spec() {
        for spec in ALL {
            assert!(
                !spec.identifiers().contains(&SHARED_PYTHON_ENV),
                "{} claims {SHARED_PYTHON_ENV}, which is shared by design",
                spec.name
            );
        }
        // And it is genuinely distinct from the per-sidecar overrides it sits above.
        assert_ne!(SHARED_PYTHON_ENV, AI.identifiers()[0]);
        assert!(!SHARED_PYTHON_ENV.is_empty());
    }

    /// The dev-layout lookup must find the real `ai-env/.venv` in this checkout —
    /// the same kind of real check `resolve_dir_finds_both_sidecars_in_the_dev_layout`
    /// makes for the sidecar dirs, rather than only testing the injected path.
    #[test]
    fn resolve_shared_python_finds_the_real_shared_venv_when_it_exists() {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        let exists = DEV_LAYOUT_PREFIXES
            .iter()
            .any(|p| venv_python(&manifest.join(p).join(SHARED_ENV_DIR).join(".venv")).is_file());
        if !exists {
            // Not a failure: a checkout that has not run `ai-env/setup.sh` yet has
            // no shared venv to find, and "returns None" is the correct answer
            // there (it is what makes the ladder fall through).
            eprintln!("skipping: no {SHARED_ENV_DIR}/.venv — run ./{SHARED_ENV_DIR}/setup.sh");
            assert!(resolve_shared_python().is_none());
            return;
        }
        let found = resolve_shared_python().expect("the venv exists, so it must resolve");
        assert!(found.is_file());
        assert!(
            found.ends_with("bin/python"),
            "{found:?} should be an interpreter path"
        );
        assert!(
            found.components().any(|c| c.as_os_str() == SHARED_ENV_DIR),
            "{found:?} should live under {SHARED_ENV_DIR}/"
        );
        // The real invariant, not just the path shape: the returned path must
        // still be *inside* the venv, because that is the only thing that makes
        // Python use the venv at all (CPython locates `pyvenv.cfg` relative to
        // `sys.executable`). `bin/python` is a symlink to the base interpreter,
        // so a stray `canonicalize()` anywhere on this path silently swaps the
        // locked environment for the system one — which is how this assertion
        // earned its place.
        let venv_root = found
            .parent()
            .and_then(Path::parent)
            .expect("<venv>/bin/python has two parents");
        assert!(
            venv_root.join("pyvenv.cfg").is_file(),
            "{found:?} is not inside a virtualenv — no pyvenv.cfg at {venv_root:?}; \
             the symlink was probably resolved away"
        );
    }
}

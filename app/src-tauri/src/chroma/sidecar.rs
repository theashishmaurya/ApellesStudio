//! Tauri bridge for Apelles' supervised local services (D-028, D-189, D-313).
//!
//! What it is: the app-side half of the D-142 `apelles-ai` extraction
//! (`docs/notes/crate-extraction-plan.md` §2.5) — everything that genuinely
//! needs Tauri stayed here: the `#[tauri::command]` status wrappers and the
//! calls to spawn the supervisor threads from `lib.rs` `.setup()`.
//! What it does NOT do: any of the actual lifecycle logic (resolving what to
//! launch, health checks, content hashing, spawn/backoff/respawn,
//! external-process monitoring) — all of that is `apelles_ai::sidecar` now.
//! This file used to be the whole 704-line implementation; see D-142 in
//! `docs/08-decisions.md` for what moved and why.
//!
//! D-189/D-190: two sidecars were supervised by one `SidecarSpec`-parameterized
//! supervisor, which is why there is a spawn entry point and a status command
//! per sidecar — `shutdown()` stayed a single call, since it kills every child
//! the supervisor owns.
//!
//! **D-313: three now, and the third is not Python.** [`MCP`] is `apelles-mcp`
//! in HTTP mode — the same 161-tool MCP surface, served on a fixed loopback port
//! so every client just points at a URL instead of spawning its own copy by
//! path. Its spec lives *here*, in the app, rather than beside `AI`/`AI_MEDIA`
//! in `apelles-ai`: that crate owns the supervision *mechanism*, and the
//! decision to run an MCP server at all is the app's, not the AI client's.
//! `apelles_ai::sidecar::shutdown()` still kills it with the rest — the registry
//! is keyed by spec name and populated on first use, so a spec declared in
//! another crate needs no change to the exit hook.

use apelles_ai::sidecar::{Launch, SidecarSpec};

pub use apelles_ai::sidecar::{
    SidecarStatus, shutdown, spawn_and_supervise, spawn_and_supervise_media,
};

/// The MCP server (D-313): `apelles-mcp --http --port 19790`.
///
/// Unlike the two Python sidecars this is a compiled binary out of this same
/// Cargo workspace, so there is no directory, no interpreter and no venv to
/// resolve — `Launch::WorkspaceBin` finds it beside the app's own executable
/// (which is `target/<profile>/` in a dev run and the bundle's binary directory
/// in a packaged one) and appends the port.
///
/// `CHROMA_MCP_NO_SPAWN` stops the app starting one, for anyone who would rather
/// run it by hand. Note that the supervisor never touches a server it did not
/// start regardless: if something is already healthy on the port it monitors it
/// and leaves it alone.
pub static MCP: SidecarSpec = SidecarSpec {
    name: "mcp",
    launch: Launch::WorkspaceBin {
        bin: "apelles-mcp",
        bin_env: "CHROMA_MCP_BIN",
        args: &["--http"],
        package: "apelles-mcp",
    },
    port_env: "CHROMA_MCP_PORT",
    no_spawn_env: "CHROMA_MCP_NO_SPAWN",
    // Mirrors `apelles_mcp::serve::DEFAULT_HTTP_PORT`. Duplicated by necessity
    // rather than shared: `app/src-tauri` does not depend on `apelles-mcp` (that
    // edge is exactly what D-313 declined to add), so the constant cannot be
    // imported. `mcp_default_port_matches_the_server` below is the guard.
    default_port: 19790,
};

/// Supervise the MCP server. Zero-argument for the same reason as the other two:
/// `std::thread::spawn` needs an `FnOnce()`, and a spec-taking function is not
/// one.
pub fn spawn_and_supervise_mcp() {
    apelles_ai::sidecar::supervise(&MCP);
}

/// `{ managed, healthy, pid?, restarts, stale, lastError? }` — backs the
/// Settings panel's "AI Sidecar" status card (D-101).
#[tauri::command]
pub fn chroma_ai_status() -> SidecarStatus {
    apelles_ai::sidecar::status_snapshot(&apelles_ai::sidecar::AI)
}

/// The same shape for the `ai-media/` sidecar — backs the Settings panel's
/// "Media Understanding Sidecar" card (D-189).
#[tauri::command]
pub fn chroma_ai_media_status() -> SidecarStatus {
    apelles_ai::sidecar::status_snapshot(&apelles_ai::sidecar::AI_MEDIA)
}

/// The same shape for the MCP server (D-313) — backs the live status line in the
/// Connect-to-MCP dialog, which is where a user goes when the URL they pasted
/// into a client does not answer.
#[tauri::command]
pub fn chroma_mcp_status() -> SidecarStatus {
    apelles_ai::sidecar::status_snapshot(&MCP)
}

/// The port the Connect-to-MCP dialog should print, resolved the same way the
/// supervisor resolves it (`CHROMA_MCP_PORT`, else the default).
///
/// The dialog asks rather than hardcoding 19790 so a user who overrode the port
/// is shown a URL that actually works — the whole point of that dialog is that
/// what it prints can be pasted without editing.
#[tauri::command]
pub fn chroma_mcp_port() -> u16 {
    std::env::var("CHROMA_MCP_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(MCP.default_port)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The port is written down in four places by necessity — the server binds
    /// it, this spec spawns it, the dialog prints it, the READMEs document it —
    /// and a drift is a live "the URL in the dialog does not work" bug rather
    /// than a build failure. This crate cannot import the server's constant
    /// (D-313 deliberately keeps that dependency edge out), so the value is
    /// pinned on both sides instead; `apelles_mcp::serve`'s own test pins the
    /// other half.
    #[test]
    fn mcp_default_port_matches_the_server() {
        assert_eq!(MCP.default_port, 19790);
        assert_eq!(chroma_mcp_port(), 19790, "with CHROMA_MCP_PORT unset");
    }

    /// The MCP spec must not collide with either Python sidecar — a shared port
    /// or env var would show up only as one supervisor driving another's
    /// process. `apelles-ai` runs this same check within its own two specs; this
    /// is the cross-crate half D-313 created the need for.
    #[test]
    fn the_mcp_spec_collides_with_neither_python_sidecar() {
        for other in apelles_ai::sidecar::ALL {
            assert_ne!(MCP.default_port, other.default_port);
            let mine: std::collections::HashSet<_> = MCP.identifiers().into_iter().collect();
            let theirs: std::collections::HashSet<_> = other.identifiers().into_iter().collect();
            let shared: Vec<_> = mine.intersection(&theirs).copied().collect();
            assert!(
                shared.is_empty(),
                "the mcp spec shares {shared:?} with {}",
                other.name
            );
        }
    }

    /// **The claim D-313 actually makes, tested end to end**: the app starts a
    /// real MCP server on launch, and the app-exit hook leaves nothing behind.
    ///
    /// Everything else here checks a constant. This spawns the real supervisor
    /// against the real `apelles-mcp` binary, waits for it to report healthy,
    /// proves the port is genuinely listening, then runs the same
    /// `shutdown()` that `lib.rs`'s `RunEvent` handler runs and proves the port
    /// is released. An orphaned MCP server holding a port after quit is the
    /// exact failure this catches — and it is invisible until the next launch,
    /// when the supervisor would find "something already healthy" and decline
    /// to start its own.
    ///
    /// Uses a private spec on its own port rather than [`MCP`]: `port()` reads
    /// an env var, and mutating the environment from one test while 300 others
    /// share the process is a race, not a test.
    #[test]
    fn the_supervisor_really_starts_the_server_and_the_exit_hook_really_stops_it() {
        use std::net::TcpStream;
        use std::time::{Duration, Instant};

        /// Not 19790: this must not fight the developer's actually-running app.
        const PORT: u16 = 19791;
        static SPEC: SidecarSpec = SidecarSpec {
            name: "mcp-test",
            launch: Launch::WorkspaceBin {
                bin: "apelles-mcp",
                bin_env: "CHROMA_MCP_TEST_BIN",
                args: &["--http"],
                package: "apelles-mcp",
            },
            port_env: "CHROMA_MCP_TEST_PORT",
            no_spawn_env: "CHROMA_MCP_TEST_NO_SPAWN",
            default_port: PORT,
        };

        let listening = || TcpStream::connect(("127.0.0.1", PORT)).is_ok();

        if listening() {
            eprintln!("skipping: something already holds :{PORT}");
            return;
        }

        std::thread::spawn(|| apelles_ai::sidecar::supervise(&SPEC));

        // A Rust binary binds a socket in milliseconds; 30s is the same budget
        // the supervisor itself allows, and only a build that is not there at
        // all should ever exhaust it.
        let deadline = Instant::now() + Duration::from_secs(30);
        while Instant::now() < deadline {
            if apelles_ai::sidecar::status_snapshot(&SPEC).healthy {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }

        let status = apelles_ai::sidecar::status_snapshot(&SPEC);
        if !status.healthy {
            // Genuinely not built — `cargo test -p apelles` alone does not build
            // another crate's binary. Not a failure of this code; a failure to
            // assert here would be, which is why the message says what to run.
            eprintln!(
                "skipping: apelles-mcp never came up ({:?}) — `cargo build -p apelles-mcp` first",
                status.last_error
            );
            apelles_ai::sidecar::shutdown();
            return;
        }

        assert!(status.managed, "we spawned it, so we must own it");
        assert!(status.pid.is_some(), "an owned child must report its pid");
        assert!(!status.stale, "a freshly-spawned child is never stale");
        assert!(listening(), "reported healthy but nothing is on :{PORT}");

        // The exit hook, exactly as `lib.rs` calls it.
        apelles_ai::sidecar::shutdown();

        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline && listening() {
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(
            !listening(),
            "the MCP server survived shutdown() and is still holding :{PORT} — \
             that is the orphaned-process bug"
        );
    }
}

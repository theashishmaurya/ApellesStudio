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

/// The MCP server (D-313): `apelles-mcp --http --port 19789`.
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
    default_port: 19789,
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
/// The dialog asks rather than hardcoding 19789 so a user who overrode the port
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
        assert_eq!(MCP.default_port, 19789);
        assert_eq!(chroma_mcp_port(), 19789, "with CHROMA_MCP_PORT unset");
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
}

//! Serving the tool surface *to an MCP client* — stdio, or streamable HTTP (D-313).
//!
//! WHAT THIS IS
//!  The two ways a client can reach [`ApellesMcp`]. [`stdio`] is what D-312 shipped:
//!  the client spawns this binary and talks over its stdin/stdout. [`http`] binds
//!  `127.0.0.1:<port>` and serves the MCP streamable-HTTP transport at `/mcp`, so a
//!  client needs only a URL — no path to a binary, no subprocess of its own to manage
//!  — which is what lets the desktop app start one shared server for every client.
//!
//!  **Both serve the identical tool surface.** It is the same [`ApellesMcp`] value,
//!  the same 161 tools, the same control-server contract; only the rmcp transport
//!  under it differs. Nothing in [`crate::tools`] knows which one it is running on.
//!
//! NOT TO BE CONFUSED WITH [`crate::transport`]
//!  That module is the *other* direction — how a tool reaches the app (`POST /op` to
//!  the control server on 19788). This one is how a client reaches us (19790). Two
//!  HTTP hops, opposite directions, and a request crosses both:
//!
//! ```text
//!  Claude Code ──HTTP :19790/mcp──▶ apelles-mcp ──HTTP :19788/op──▶ Apelles app
//!    (client)      this module                    crate::transport      (frontend)
//! ```
//!
//! WHAT IT DOES NOT DO
//!  No tools, no ops, no auth. There is deliberately no authentication: the socket is
//!  bound to loopback only and never to `0.0.0.0`, which is the same trust boundary
//!  the app's own control server already relies on (D-020) — anything that can reach
//!  19790 can already reach 19788 directly. It does not serve anything but `/mcp` and
//!  `/health`, and it never becomes a general HTTP server for the app.

use std::io;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::OnceLock;

use axum::Router;
use axum::routing::get;
use rmcp::ServiceExt;
use rmcp::transport::streamable_http_server::{
    StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::ApellesMcp;

/// The loopback port the desktop app runs this server on.
///
/// One above the control server's 19788 (`app/src-tauri/src/chroma/control.rs`), so the
/// two halves of the same bridge sit together and are obvious in an `lsof`. Deliberately
/// nowhere near the Python sidecars' 8765/8766, which are in the range a random dev
/// server grabs.
pub const DEFAULT_HTTP_PORT: u16 = 19790;

/// Overrides [`DEFAULT_HTTP_PORT`]. Mirrors `CHROMA_CONTROL_PORT`'s convention exactly,
/// and is the variable the app's supervisor sets on the child it spawns.
pub const PORT_ENV: &str = "CHROMA_MCP_PORT";

/// Where the streamable-HTTP transport lives. A client's URL is
/// `http://127.0.0.1:<port>/mcp`.
pub const MCP_PATH: &str = "/mcp";

/// Liveness + identity, for the app's sidecar supervisor. Same shape and same job as
/// each Python sidecar's `/health` (`ai/server.py`), so the supervisor's existing
/// health-poll and staleness comparison work here unchanged.
pub const HEALTH_PATH: &str = "/health";

/// `$CHROMA_MCP_PORT`, else [`DEFAULT_HTTP_PORT`]. An unparseable value falls back to
/// the default rather than failing to start — a typo in an env var should not leave the
/// user with no MCP server and no obvious reason why.
pub fn port_from_env() -> u16 {
    std::env::var(PORT_ENV)
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_HTTP_PORT)
}

/// A truncated SHA-256 of this binary's own bytes — the compiled-Rust analogue of each
/// Python sidecar's `_CONTENT_SHA256` (D-101).
///
/// Its whole job is answering "is the server on this port the one this build would have
/// started, or a stale one from an earlier `cargo build`?" The supervisor hashes the
/// binary it resolved, this reports the binary that is actually running, and a mismatch
/// is surfaced rather than trusted forever just for answering 200. Truncated to 8 bytes
/// / 16 hex chars to match the Python side's format byte-for-byte.
///
/// `None` when the executable cannot be located or read, which the comparison treats as
/// "cannot determine" — never as a mismatch.
pub fn self_content_sha256() -> Option<&'static str> {
    // The binary is tens of megabytes; hash it once, not on every health poll.
    static HASH: OnceLock<Option<String>> = OnceLock::new();
    HASH.get_or_init(|| {
        let exe = std::env::current_exe().ok()?;
        let bytes = std::fs::read(exe).ok()?;
        let digest = Sha256::digest(&bytes);
        Some(digest.iter().take(8).map(|b| format!("{b:02x}")).collect())
    })
    .as_deref()
}

/// Serve over stdin/stdout until the client disconnects — the D-312 behaviour,
/// unchanged, and still what bare `apelles-mcp` does.
///
/// stdout *is* the protocol here: anything written to it corrupts the session, which is
/// why every diagnostic in this crate goes to stderr.
pub async fn stdio(service: ApellesMcp) -> Result<(), Box<dyn std::error::Error>> {
    let running = service.serve(rmcp::transport::stdio()).await?;
    running.waiting().await?;
    Ok(())
}

/// The `/mcp` + `/health` router, without binding anything.
///
/// Split out from [`http`] so a test can drive the real router over an ephemeral port
/// (`tests/http_transport.rs`) instead of having to take 19790 from a running app.
///
/// `control_url` is passed in rather than re-read from the environment so `/health`
/// reports the control server this process is *actually* talking to — a second
/// `from_env()` here would be a second source of truth that could disagree with
/// [`crate::transport::HttpControlTransport`]'s.
pub fn router(service: ApellesMcp, control_url: String) -> Router {
    // rmcp hands out a Tower `Service`; the factory is per-session and `ApellesMcp` is
    // cheap to clone (an `Arc` to the transport plus the shared tool router), so every
    // session gets the same tool surface over the same connection to the app.
    let mcp = StreamableHttpService::new(
        move || Ok(service.clone()),
        LocalSessionManager::default().into(),
        // The stock config is what we want, and that is a decision rather than an
        // omission: its `allowed_hosts` already restricts `Host` to loopback, which is
        // rmcp's own DNS-rebinding guard for exactly this "local server, browser on
        // the same machine" shape, and its session mode is the one every current
        // client negotiates.
        StreamableHttpServerConfig::default(),
    );

    Router::new()
        .route(HEALTH_PATH, get(health))
        .nest_service(MCP_PATH, mcp)
        .with_state(control_url)
}

/// Bind `127.0.0.1:<port>` and serve until the process is killed.
///
/// Loopback only, never `0.0.0.0`: this server can drive every destructive tool in the
/// app, so it must not be reachable from the network.
pub async fn http(service: ApellesMcp, port: u16, control_url: String) -> io::Result<()> {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    eprintln!("[apelles-mcp] serving MCP over HTTP at http://{addr}{MCP_PATH}");
    axum::serve(listener, router(service, control_url)).await
}

/// `GET /health` — is this server up, and which build is it?
async fn health(
    axum::extract::State(control_url): axum::extract::State<String>,
) -> axum::Json<Value> {
    axum::Json(json!({
        "ok": true,
        "service": "apelles-mcp",
        "version": env!("CARGO_PKG_VERSION"),
        // The field name is the Python sidecars' (D-101), because the app's supervisor
        // reads exactly this key on both.
        "content_sha256": self_content_sha256(),
        // Not a health claim about the app — just which control server this process
        // would post to, which is the first thing to check when tools fail but the
        // server is up.
        "control": control_url,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_port_sits_one_above_the_control_server() {
        // Same reasoning as `transport.rs`'s port test: this constant is duplicated by
        // necessity (the supervisor spawns it, the Connect-to-MCP dialog prints it, the
        // READMEs document it), so drift here is a real "the URL in the dialog does not
        // work" bug.
        assert_eq!(DEFAULT_HTTP_PORT, 19790);
    }

    #[test]
    fn the_binary_hashes_itself_to_the_python_sidecars_format() {
        // The test binary is a real executable, so this exercises the real path. The
        // format is the contract: `apelles-ai`'s `is_stale` compares this string
        // against its own 16-hex-char truncation and any other width never matches.
        let Some(hash) = self_content_sha256() else {
            panic!("the test binary should be readable at its own current_exe() path");
        };
        assert_eq!(hash.len(), 16, "16 hex chars = the truncation D-101 fixed");
        assert!(hash.chars().all(|c| c.is_ascii_hexdigit()));
        // Cached, not recomputed — the binary is tens of megabytes.
        assert_eq!(Some(hash), self_content_sha256());
    }
}

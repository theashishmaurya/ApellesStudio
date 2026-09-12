//! Apelles' MCP server — the AI-facing tool surface for the running desktop app (D-312).
//!
//! WHAT THIS IS
//!  The Rust reimplementation of `mcp/server.py` (D-020). One MCP tool per capability
//!  the app exposes; each tool is a thin wrapper that POSTs `{op, args, timeout_ms}`
//!  to the app's control server (`app/src-tauri/src/chroma/control.rs`, port 19788)
//!  and renders the envelope that comes back as MCP content.
//!
//! WHAT IT DOES *NOT* DO
//!  - **No grade, mask, timeline or motion logic.** Not one line. Every op is applied
//!    by the frontend through the same store actions the GUI buttons call, which is
//!    what keeps an MCP edit and a slider drag from ever diverging (D-020). A default
//!    value, a clamp or a rename implemented here would be a second source of truth
//!    and is a bug, not a convenience.
//!  - **It does not change the control-server contract.** `control.rs` still knows no
//!    op names and no schemas; the op registry still lives in the frontend. This layer
//!    owns the tool list, which is why it — and only it — declares each op's timeout
//!    budget (B-153).
//!
//! LAYERING
//!  Top of the stack, beside `app/src-tauri`: a shell that talks to the app over its
//!  own HTTP boundary. Nothing in `crates/*` may depend on it.
//!
//! TWO TRANSPORTS, BOTH DIRECTIONS
//!  Do not confuse the two HTTP hops a request crosses. [`transport`] is how a *tool
//!  reaches the app* (`POST /op` on 19788). [`serve`] is how a *client reaches us* —
//!  either stdio (D-312, still the default for a client that spawns this binary
//!  itself) or streamable HTTP on 19789 (D-313, which is how the desktop app runs it,
//!  so a client needs only a URL). Both expose the identical 161 tools off the same
//!  [`ApellesMcp`]; nothing in [`tools`] knows which is in use.
//!
//! TRANSPORT-AGNOSTIC BY CONSTRUCTION
//!  The tool surface talks to an [`OpTransport`], not to HTTP. The shipped binary uses
//!  [`transport::HttpControlTransport`] and is a drop-in replacement for the Python
//!  server. Serving the same surface from inside the Tauri process later — no HTTP
//!  hop, an in-process dispatch — is then a new `OpTransport`, not a rewrite. See
//!  D-312 for why that was preferred over embedding straight away, and D-313 for why
//!  the app supervises this as a child process rather than embedding it even now.
//!
//! VERIFYING IT
//!  `tests/parity.rs` replays a golden corpus captured from the Python server against
//!  this one — every tool's name, description and schema, and for each of 237 calls
//!  the exact ops emitted and content rendered. See `README.md`.

pub mod args;
pub mod cli;
pub mod render;
pub mod schemas;
pub mod serve;
pub mod server;
pub mod tools;
pub mod transport;

pub use server::ApellesMcp;
pub use transport::{HttpControlTransport, OpError, OpTransport};

/// How long the app's frontend is given to apply + render + reply, per op (B-153).
///
/// The control server's own default is 20s, which is right for the ops that are a store
/// write plus a render — and wrong for the handful that run a real model. This layer
/// sends the budget because it is the one that knows which tool is which; `control.rs`
/// has no op list by design.
pub const DEFAULT_OP_TIMEOUT_MS: u64 = 20_000;

/// SAM 2 + ViTMatte over a full 4K frame through the AI sidecar. Measured in tens of
/// seconds on a cold model, which is exactly how a *successful* `add_subject_mask` came
/// back to the caller as a bare tool error (B-153).
pub const AI_MASK_TIMEOUT_MS: u64 = 180_000;

/// B-071 — extra client-side slack covering the control server's own cold-start
/// readiness wait (`control.rs`'s `BRIDGE_READY_TIMEOUT`), which sits on TOP of the
/// per-op budget rather than eating into it. The two are a pair: if this is smaller, a
/// real cold start comes back as a bare read timeout instead of the server's own "still
/// starting up, nothing was applied" answer, which is the whole point of having it.
pub const READY_GRACE_SECS: u64 = 30;

/// Slack on top of the app-side budget and the readiness grace, so a real frontend
/// timeout arrives as the control server's own explanatory 504 envelope rather than as a
/// client-side read timeout with nothing in it.
pub const TRANSPORT_SLACK_SECS: u64 = 15;

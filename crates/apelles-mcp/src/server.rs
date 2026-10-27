//! The MCP server itself: what it advertises, and how a tool reaches the app (D-312).
//!
//! WHAT THIS IS
//!  [`ApellesMcp`] — the one handler type every `#[tool]` in [`crate::tools`] hangs
//!  off. It holds the transport, assembles the per-tab tool routers into a single
//!  router, and carries the server instructions an MCP client reads before its first
//!  call.
//!
//! WHAT IT DOES NOT DO
//!  No dispatch logic of its own, no per-op special cases, no op names. Adding a
//!  capability is still one entry in the owning tab's frontend `OPS` registry plus
//!  one tool here — nothing in this file changes.

use std::sync::Arc;

use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::model::{Implementation, ServerCapabilities, ServerInfo};
use rmcp::{ErrorData, ServerHandler, tool_handler};
use serde_json::Value;

use crate::transport::{Envelope, OpTransport};

// What a client is told about this server before its first call ([`INSTRUCTIONS`]).
//
// Ported verbatim from `mcp/server.py`'s `instructions`. It is prose a model reads, so
// it is held byte-for-byte and checked that way by `tests/parity.rs` — the scope
// discipline in the second paragraph is the part that actually changes how an agent
// grades, and paraphrasing it would quietly change behaviour. A macro rather than a
// `const` because `concat!` only takes literals, and the Motion paragraph is appended
// only when this server is built with Motion (D-391).
macro_rules! base_instructions {
    () => {
        r#"Drive the running Apelles color-grading app. Edits move the app's real UI and re-render its canvas; reads reflect the user's manual edits. The Apelles desktop app must be open. Call get_state first to see the current image/video, adjustments and masks.

Grade by the numbers. Call `inspect_color` before and after a change and reason from the scope values (black/white points, per-zone means, warm-cool and green-magenta cast, clip %, hue histogram) or a named full-res region from `sample` / `sample_region`. Never claim a result ('looks balanced', 'skin is natural', 'the cast is gone') without citing a scope value or a sampled region. Approach each result adversarially: assume the grade is still flawed and hunt for the cast, clipping, or crushed detail you have not ruled out. Defer genuinely creative calls to the human.

Mutating tools return the rendered frame, its histogram, and the compact scope summary (the new measurement, for free) after the change.

The Edit tab (multi-track NLE: import/place/trim/composite/export, `editor_*`-prefixed tools) is a separate surface from grading above. Call `editor_get_capabilities` once before your first `editor_set_clip_transform`/`editor_set_clip_keyframes`/`editor_export` in a session — it is static reference data (no app round trip) covering non-obvious compositing rules and known rough edges an agent would otherwise only find by reading source or hitting them live."#
    };
}

/// Built with Motion (the default): the full text, byte-for-byte the Python server's.
#[cfg(feature = "motion")]
pub const INSTRUCTIONS: &str = concat!(
    base_instructions!(),
    "\n\n",
    r#"The Motion tab (`motion_*`-prefixed tools, D-257) is the third surface: a scene-based motion-graphics builder — scenes, layers built from a primitive catalog, per-layer keyframes with real bezier easing, 2D/3D cameras, and a Remotion render to one video file PER SCENE. Its single source of truth is the scene manifest, the way `grade.json` is for grading. Call `motion_get_state` first (what is open, what is selected, one row per scene) and `motion_list_primitives` once before your first `motion_add_layer` — that one is static reference data listing every primitive and the fields each accepts. Note that times in Motion are SECONDS within a scene, not absolute frames."#
);

/// Built without Motion (`--no-default-features`, as the v0.2.0 beta was, D-391): the
/// Motion paragraph is dropped so a client is not told to call tools this build does
/// not have.
#[cfg(not(feature = "motion"))]
pub const INSTRUCTIONS: &str = base_instructions!();

/// The MCP server. One per process; cheap to clone (the transport is shared).
#[derive(Clone)]
pub struct ApellesMcp {
    transport: Arc<dyn OpTransport>,
    tool_router: ToolRouter<Self>,
}

impl ApellesMcp {
    pub fn new(transport: Arc<dyn OpTransport>) -> Self {
        Self {
            transport,
            // One router per tab, merged — the same split the frontend uses for its op
            // registries, and the same split `docs/notes/mcp-tool-coverage.md` inventories.
            // `ai_env` is the one that is not a tab: it is answered natively by
            // `control.rs` and serves AI features in two of them (D-315).
            tool_router: crate::tools::colorist::router()
                + crate::tools::edit::router()
                + crate::tools::motion::router()
                + crate::tools::ai_env::router()
                + crate::tools::debug::router(),
        }
    }

    /// Send one op at the default budget.
    pub(crate) async fn op(&self, op: &str, args: impl Into<Value>) -> Result<Envelope, ErrorData> {
        self.op_with(op, crate::DEFAULT_OP_TIMEOUT_MS, args).await
    }

    /// Send one op with an explicit frontend budget — for the handful of tools that
    /// drive a real model rather than a slider (B-153).
    pub(crate) async fn op_with(
        &self,
        op: &str,
        timeout_ms: u64,
        args: impl Into<Value>,
    ) -> Result<Envelope, ErrorData> {
        self.transport
            .call(op, args.into(), timeout_ms)
            .await
            // A transport failure is the app being unreachable, which is a fact about
            // the setup rather than about the op. Its message is the useful part and is
            // surfaced in full — unlike the Python server, where the equivalent
            // `RuntimeError` was masked down to "Error executing tool <name>".
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for ApellesMcp {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("apelles", env!("CARGO_PKG_VERSION")))
            .with_instructions(INSTRUCTIONS)
    }
}

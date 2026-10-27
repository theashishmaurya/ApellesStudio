//! Motion's render runtime — is it installed, install it, remove it (D-417).
//!
//! Answered by `control.rs` itself in Rust (`apelles_motion_runtime::manager`), with no
//! frontend round trip, like the AI-env pair: the moment an agent most needs the answer
//! is right after a Motion render failed with `motion_runtime_not_ready`, possibly before
//! the Motion tab has ever been opened. They sit with the `motion_*` tools (and behind the
//! same `motion` feature) because the runtime exists only for Motion's renders.
//!
//! Every description is the Python tool's docstring, byte-for-byte; `tests/parity.rs`
//! compares them character by character (D-312).

use rmcp::model::CallToolResult;
use rmcp::{ErrorData, tool, tool_router};

use crate::args::WireArgs;
use crate::render;
use crate::server::ApellesMcp;

#[tool_router(router = motion_runtime_router, vis = "pub")]
impl ApellesMcp {
    #[tool(
        name = "motion_runtime_status",
        description = r#"Is Motion's render runtime installed — and if not, how far along is
    its download (D-417)?

    Every Motion render (`motion_render`, `motion_preview_frame`, the custom
    component check and certification, and their live-preview frames) runs
    Remotion, which needs Node.js, Chrome Headless Shell and the Remotion
    compositor. An installed app downloads them (~152 MB, ~330 MB on disk)
    the first time the Motion tab opens. Until then those tools fail with an
    error whose first word is `motion_runtime_not_ready`: not a bad request,
    and the same call works once this reports "ready". Editing (scenes,
    layers, keyframes, the live player) never needs the runtime.

    Returns {state, detail, source, step, label, bytesDone, bytesTotal,
    downloadBytes, installedBytes, errorKind, error, node, runtimeDir,
    versions, canInstall, canRemove}. Branch on `state`:

      "ready"        renders work now. `source` is "managed" (the downloaded
                     runtime) or "developer" (a development build's own Node)
      "missing" | "outdated" | "broken"
                     not installed / installed for an older app version /
                     damaged. `motion_install_runtime` fixes all three
      "installing"   downloading or unpacking: `bytesDone` of `bytesTotal`.
                     Poll this; do not start another install
      "failed"       the last install stopped (`errorKind`: "offline",
                     "diskSpace", "checksum", "http", ...). Nothing retries
                     on a timer: fix the cause (usually the network), then
                     call `motion_install_runtime` again
      "removing" | "unconfigured"
                     wait a moment and ask again"#
    )]
    pub async fn motion_runtime_status(&self) -> Result<CallToolResult, ErrorData> {
        let env = self.op("motion_runtime_status", WireArgs::new()).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_install_runtime",
        description = r#"Download and install Motion's render runtime now, in the background
    (D-417): Node.js, Chrome Headless Shell and the Remotion compositor, each
    pinned by version and SHA-256, about 152 MB. The Motion tab starts this by
    itself the first time it opens; call this when `motion_runtime_status`
    says "missing", "outdated", "broken" or "failed". A retry resumes an
    interrupted download rather than starting over.

    Returns the same fields as `motion_runtime_status` plus `started`: true
    if a download began, false if there was nothing to start (already
    "ready", or already "installing"), which is a normal answer, not a
    failure. It returns at once; poll `motion_runtime_status` for progress.
    Too little disk space is refused before anything downloads (state
    "failed", errorKind "diskSpace")."#
    )]
    pub async fn motion_install_runtime(&self) -> Result<CallToolResult, ErrorData> {
        let env = self.op("motion_install_runtime", WireArgs::new()).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_remove_runtime",
        description = r#"Delete the downloaded Motion runtime (D-417), the person's "Remove
    Motion runtime", freeing about 330 MB. Motion editing keeps working;
    renders, stills and component checks need `motion_install_runtime` again
    afterwards, so only do this when the person asks for it. Refused while an
    install is running. A development build that uses its own Node stays
    "ready" afterwards.

    Returns the same fields as `motion_runtime_status`."#
    )]
    pub async fn motion_remove_runtime(&self) -> Result<CallToolResult, ErrorData> {
        let env = self.op("motion_remove_runtime", WireArgs::new()).await?;
        Ok(render::json_text(&env))
    }
}

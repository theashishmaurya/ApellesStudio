//! Internal debug tooling — never shipped (D-312, and CLAUDE.md's standing rule).
//!
//! WHAT THIS IS
//!  The `debug_*` tools: screenshots, UI state, DOM tree, frame timing, pixel probes.
//!  They exist so an agent can inspect and drive the running app directly instead of
//!  relying on the owner's own eyes and manual screenshots.
//!
//! WHY THE WHOLE MODULE IS `cfg(debug_assertions)`
//!  Internal debug tooling must be compiled OUT of a production build through a real
//!  compile-time gate — never a runtime flag, never "just don't call it in prod."
//!  That is the same gate `control.rs`'s `native_op` uses on its own side (B-100 /
//!  D-219), and it is why a release build of this server publishes 152 tools where a
//!  debug build publishes 161. The Python server had no equivalent gate at all: it
//!  defined all nine unconditionally and relied on the app-side half being absent,
//!  which advertised tools a release build could never answer. Closing that is a
//!  deliberate, documented improvement of the port, not an accident of it — see the
//!  divergence list in `docs/notes/mcp-rust-port.md`.

#[cfg(debug_assertions)]
mod enabled {
    use rmcp::model::CallToolResult;
    use rmcp::{ErrorData, tool, tool_router};

    use crate::args::WireArgs;
    use crate::render;
    use crate::server::ApellesMcp;

    #[tool_router(router = debug_router, vis = "pub")]
    impl ApellesMcp {
        #[tool(
            name = "debug_ui_state",
            description = r#"Read the running app's real UI state: which tab is showing, which panels
    are open, what is selected, and every dialog currently on screen.

    Call this FIRST when you are about to drive the UI — it tells you what is
    already open, so you do not toggle a panel closed thinking you are opening
    it. Call it again after a `debug_set_*` to confirm the change landed
    (each setter also echoes its own field back, so a second call is only
    needed when you want the whole picture).

    Open dialogs are read off the DOM (`role="dialog"`/`alertdialog`), not off
    a store flag, so the list stays correct as modals are added to the app.

    Returns {shell:{activeTab,tabs,sourcesPanelOpen,wgpuSurfaceActive},
             editor:{inspectorOpen,inspectorTab,inspectorTabs,projectOpen,
                     timelineStatus,selection,selectedGap,playing,playhead},
             openDialogs:[{tag,role,label,rect}]}."#
        )]
        pub async fn debug_ui_state(&self) -> Result<CallToolResult, ErrorData> {
            // Tool name and op name differ here too — the op is `debug_get_ui_state`.
            let env = self.op("debug_get_ui_state", WireArgs::new()).await?;
            Ok(render::json_text(&env))
        }
    }
}

/// This tab's contribution to the merged router — empty in a release build, where none
/// of these tools exist at all.
#[cfg(debug_assertions)]
pub fn router() -> rmcp::handler::server::router::tool::ToolRouter<crate::ApellesMcp> {
    crate::ApellesMcp::debug_router()
}

/// Release twin of [`router`]. A real function rather than a `cfg` at the one call site,
/// so [`crate::server`] reads the same in both configurations — the same shape
/// `control.rs` uses for its own `native_op` twin.
#[cfg(not(debug_assertions))]
pub fn router() -> rmcp::handler::server::router::tool::ToolRouter<crate::ApellesMcp> {
    rmcp::handler::server::router::tool::ToolRouter::new()
}

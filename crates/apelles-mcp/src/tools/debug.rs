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
//!  D-219), and it is why a release build of this server publishes 160 tools where a
//!  debug build publishes 171 (D-330 added the eleventh and tenth debug tools,
//!  `debug_record_video` and `debug_set_fps_overlay`; both counts re-measured, not
//!  adjusted by arithmetic — see `docs/notes/debug-tooling.md`'s gate verification).
//!  The Python server had no equivalent gate at all: it
//!  defined them all unconditionally and relied on the app-side half being absent,
//!  which advertised tools a release build could never answer. Closing that is a
//!  deliberate, documented improvement of the port, not an accident of it — see the
//!  divergence list in `docs/notes/mcp-rust-port.md`.

// One gate, on the module declaration. Gating the individual `use` lines instead
// does NOT work: the imports vanish before the `#[tool]`/`#[tool_router]`
// attributes on the impl are resolved, and a release build fails to compile with
// "cannot find attribute `tool`". One cfg over the whole module is the shape that
// actually strips cleanly.
#[cfg(debug_assertions)]
mod tools;

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

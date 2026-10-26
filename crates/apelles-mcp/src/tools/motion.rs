//! Motion-tab tools — the scene-based motion-graphics surface (D-312), behind the
//! `motion` Cargo feature (D-391).
//!
//! WHY THE WHOLE MODULE IS BEHIND `feature = "motion"`
//!  A Motion export runs `npx remotion render` (`apelles-motion`), which needs Node.js,
//!  a headless Chrome and the Motion engine's `node_modules` — none of which the
//!  release bundle carries yet. Until the on-demand toolchain download lands, the beta
//!  build hides the Motion tab, and this server is built `--no-default-features` so it
//!  does not advertise 44 tools no tab is mounted to answer. Same shape as `debug.rs`:
//!  one gate on the module declaration (gating the `use` lines instead breaks the
//!  `#[tool]` attributes), and a real empty twin of [`router`] so `server.rs` reads the
//!  same either way. The feature is on by default, so dev builds and the test suite
//!  see the full surface.

#[cfg(feature = "motion")]
mod tools;

/// This tab's contribution to the merged router.
#[cfg(feature = "motion")]
pub fn router() -> rmcp::handler::server::router::tool::ToolRouter<crate::ApellesMcp> {
    crate::ApellesMcp::motion_router()
}

/// Built without Motion: no `motion_*` tools exist at all.
#[cfg(not(feature = "motion"))]
pub fn router() -> rmcp::handler::server::router::tool::ToolRouter<crate::ApellesMcp> {
    rmcp::handler::server::router::tool::ToolRouter::new()
}

#[cfg(test)]
mod tests {
    /// The gate is the whole tab: with Motion every tool here is a `motion_*` tool (and
    /// there are 44 of them), without it the router is empty and nothing else in the
    /// server advertises a `motion_*` name either.
    #[test]
    fn the_motion_feature_gates_exactly_the_motion_tools() {
        let mine = super::router().list_all();
        assert!(mine.iter().all(|t| t.name.starts_with("motion_")));
        let expected = if cfg!(feature = "motion") { 44 } else { 0 };
        assert_eq!(mine.len(), expected);

        let others = crate::tools::colorist::router()
            + crate::tools::edit::router()
            + crate::tools::ai_env::router()
            + crate::tools::debug::router();
        assert!(
            others
                .list_all()
                .iter()
                .all(|t| !t.name.starts_with("motion_"))
        );
    }

    #[test]
    fn the_instructions_mention_motion_only_when_built_with_it() {
        assert_eq!(
            crate::server::INSTRUCTIONS.contains("motion_"),
            cfg!(feature = "motion")
        );
    }
}

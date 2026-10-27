//! Motion-tab tools — the scene-based motion-graphics surface (D-312), behind the
//! `motion` Cargo feature (D-391), plus the three render-runtime tools (D-417).
//!
//! WHY THE WHOLE MODULE IS BEHIND `feature = "motion"`
//!  D-391 held Motion back from the first beta, when a release bundle could not render
//!  it: this server was built `--no-default-features` so it did not advertise tools no
//!  tab was mounted to answer. D-417 ships Motion again (its render runtime downloads on
//!  demand) and the release builds with default features, but the gate stays as the one
//!  switch that would hold Motion back again. Same shape as `debug.rs`: one gate on the
//!  module declaration (gating the `use` lines instead breaks the `#[tool]` attributes),
//!  and a real empty twin of [`router`] so `server.rs` reads the same either way. The
//!  feature is on by default, so dev builds, release builds and the test suite see the
//!  full surface.

#[cfg(feature = "motion")]
mod runtime;
#[cfg(feature = "motion")]
mod tools;

/// This tab's contribution to the merged router: the `motion_*` editing tools (answered
/// by `@apelles/motion`) and the runtime tools (answered by the app itself).
#[cfg(feature = "motion")]
pub fn router() -> rmcp::handler::server::router::tool::ToolRouter<crate::ApellesMcp> {
    crate::ApellesMcp::motion_router() + crate::ApellesMcp::motion_runtime_router()
}

/// Built without Motion: no `motion_*` tools exist at all.
#[cfg(not(feature = "motion"))]
pub fn router() -> rmcp::handler::server::router::tool::ToolRouter<crate::ApellesMcp> {
    rmcp::handler::server::router::tool::ToolRouter::new()
}

#[cfg(test)]
mod tests {
    /// The gate is the whole tab: with Motion every tool here is a `motion_*` tool (69
    /// editing tools and the 3 runtime tools of D-417), without it the router is empty
    /// and nothing else in the server advertises a `motion_*` name either.
    #[test]
    fn the_motion_feature_gates_exactly_the_motion_tools() {
        let mine = super::router().list_all();
        assert!(mine.iter().all(|t| t.name.starts_with("motion_")));
        let expected = if cfg!(feature = "motion") { 72 } else { 0 };
        assert_eq!(mine.len(), expected);

        let others = crate::tools::colorist::router()
            + crate::tools::edit::router()
            + crate::tools::ai_env::router()
            + crate::tools::brand::router()
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

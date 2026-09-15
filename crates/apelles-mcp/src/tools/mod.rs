//! The tool surface, split the way the app is (D-312).
//!
//! One module per tab, matching the frontend's own op registries and
//! `docs/notes/mcp-tool-coverage.md`'s per-tab inventory — Colorist ops are answered by
//! `useChromaControl.ts`, `editor_*` by `@apelles/editor`'s `useEditorControl.ts`,
//! `motion_*` by `@apelles/motion`'s `useMotionControl.ts`, `debug_*` by `@apelles/debug`
//! and (for the two native ones) by `control.rs` itself. Each module contributes one
//! `ToolRouter`; [`crate::ApellesMcp`] merges them.
//!
//! Plus one module that is deliberately NOT a tab: [`ai_env`] (D-315). Its two tools are
//! answered by `control.rs` in Rust with no frontend registry behind them at all, and
//! the environment they report on backs AI features in two different tabs — filing them
//! under either one would misdescribe both.
//!
//! **All 175 of `mcp/server.py`'s tools are ported (D-312, +2 in D-315, +2 in D-330, +4 in D-332)** and passing
//! the parity harness. `tests/golden/ported.json` lists them, and `tests/parity.rs`
//! checks that ledger against both the running server and the golden corpus in both
//! directions — so a tool cannot be quietly dropped, quietly added, or listed under a
//! name that never existed.

pub mod ai_env;
pub mod colorist;
pub mod debug;
pub mod edit;
pub mod motion;

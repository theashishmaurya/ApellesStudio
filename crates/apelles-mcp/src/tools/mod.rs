//! The tool surface, split the way the app is (D-312).
//!
//! One module per tab, matching the frontend's own op registries and
//! `docs/notes/mcp-tool-coverage.md`'s per-tab inventory — Colorist ops are answered by
//! `useChromaControl.ts`, `editor_*` by `@apelles/editor`'s `useEditorControl.ts`,
//! `motion_*` by `@apelles/motion`'s `useMotionControl.ts`, `debug_*` by `@apelles/debug`
//! and (for the two native ones) by `control.rs` itself. Each module contributes one
//! `ToolRouter`; [`crate::ApellesMcp`] merges them.
//!
//! **All 161 of `mcp/server.py`'s tools are ported (D-312)** and passing the parity
//! harness. `tests/golden/ported.json` lists them, and `tests/parity.rs` checks that
//! ledger against both the running server and the golden corpus in both directions — so
//! a tool cannot be quietly dropped, quietly added, or listed under a name that never
//! existed.

pub mod colorist;
pub mod debug;
pub mod edit;
pub mod motion;

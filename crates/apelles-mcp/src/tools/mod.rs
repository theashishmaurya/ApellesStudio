//! The tool surface, split the way the app is (D-312).
//!
//! One module per tab, matching the frontend's own op registries and
//! `docs/notes/mcp-tool-coverage.md`'s per-tab inventory — Colorist ops are answered by
//! `useChromaControl.ts`, `editor_*` by `@apelles/editor`'s `useEditorControl.ts`,
//! `motion_*` by `@apelles/motion`'s `useMotionControl.ts`, `debug_*` by `@apelles/debug`
//! and (for the two native ones) by `control.rs` itself. Each module contributes one
//! `ToolRouter`; [`crate::ApellesMcp`] merges them.
//!
//! **Porting status.** This surface is mid-migration from `mcp/server.py` (D-312). What
//! is here is ported and passing the parity harness; what is not is listed, by name, in
//! `tests/golden/ported.json` — which `tests/parity.rs` checks against the golden corpus
//! in both directions, so a tool cannot be quietly dropped or quietly half-added.

pub mod colorist;
pub mod debug;
pub mod edit;
pub mod motion;

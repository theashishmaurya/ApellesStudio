//! # apelles-project — L2 the `.chroma` project document (D-148, `docs/notes/crate-extraction-plan.md` §2.3)
//!
//! **What it is:** the saved project the launcher opens —
//! `~/Movies/Chroma/<name>.chroma/`, its versioned `project.json` manifest,
//! the media pool + bins behind the Sources panel, the schema migrations that
//! keep every `project.json` ever written loadable, and the timeline
//! lifecycle that turns a manifest into an active [`apelles_timeline::Timeline`].
//!
//! Modules:
//! - [`manifest`] — the model itself, moved verbatim from
//!   `app/src-tauri/src/chroma/project.rs` L1–1638. Re-exported at the crate
//!   root (`apelles_project::ProjectManifest`, …) because it *is* the crate;
//!   the module path exists so its history is legible, not to be typed.
//! - [`timeline`] — `ensure_timeline` / `load_and_ensure_timeline` /
//!   `resolve_timeline` / `resolve_timeline_and_settings`, lifted out of
//!   `chroma/edit.rs` where they had been living under an Edit-tab name.
//!   See that module's doc for the call-graph evidence.
//!
//! **What it does NOT do:**
//! - **No `#[tauri::command]`.** A hard `tauri-macros` constraint, not a
//!   preference: the attribute emits `#[macro_export]`ed macros at the
//!   *defining crate's* root, so `generate_handler![chroma::project::foo]`
//!   would look for them at a path they are not at; and the wrapper body
//!   expands `::tauri::ipc::private::*`, so a crate hosting a command needs a
//!   real `tauri` dependency. Traced against `tauri-macros-2.6.3` — see
//!   `docs/notes/crate-extraction-plan.md` §1. Here it is doubly settled:
//!   all 20 of this module's commands take `tauri::State<'_, AppState>`, and
//!   `AppState` lives in `app/src-tauri`. They stay in
//!   `app/src-tauri/src/chroma/project.rs` as the app-side half.
//! - **No process globals.** "Which project is open" (`chroma::state`) and
//!   "load this video into the Colorist pipeline" (`chroma::load`) are app
//!   concerns; every function here is handed the project directory.
//! - **No grade math, no decode, no GPU.** Thumbnail regeneration and clip
//!   probing go through [`apelles_media`]; grade *files* are moved around by
//!   name during migration but never parsed here (that is
//!   `apelles-grade-model`).

pub mod manifest;
pub mod timeline;

pub use manifest::*;

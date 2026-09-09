//! grade.rs — the Tauri command bridge for the `grade.json` document
//! (roadmap "Now" item 5, D-025; the model extracted to `apelles-grade-model`
//! in D-143).
//!
//! What it is: the 2 `#[tauri::command]` wrappers for save/load, per the
//!   "commands do not move" rule (D-141) — `#[tauri::command]`'s macro
//!   expansion + `generate_handler!`'s path-matching only work with the
//!   function at its original module path, so the real logic moved to
//!   `apelles-grade-model` but these thin wrappers stay here.
//! What it does: `chroma_save_grade` / `chroma_load_grade` call straight
//!   into `apelles_grade_model::save_grade` / `load_grade` and translate the
//!   crate's plain `Result<_, String>` into the command's own — i.e. no
//!   translation at all, they're already the same shape.
//! What it does NOT do: any grade math, GPU work, store mutation, matte I/O,
//!   or schema migration — all of that is `apelles-grade-model` now. See that
//!   crate's doc comment / README for the full behaviour.
//!
//! Fork hygiene (D-003): all new code. Upstream footprint is `pub mod grade;` in
//! `chroma/mod.rs` + two `generate_handler!` lines in `lib.rs`.

use serde_json::Value;

pub use apelles_grade_model::SaveResult;

/// Write `grade` (the v1 wrapper the frontend assembled, carrying the live
/// `adjustments`) to `path`, externalising every mask matte to a sidecar file.
#[tauri::command]
pub async fn chroma_save_grade(path: String, grade: Value) -> Result<SaveResult, String> {
    apelles_grade_model::save_grade(&path, grade)
}

/// Read + parse `grade.json`, migrate its schema to the current version, inline
/// the `$matte` sidecars back to base64 and resolve `$trackDir` to an absolute
/// path. Returns the grade JSON with a plain `adjustments` object ready to apply.
#[tauri::command]
pub async fn chroma_load_grade(path: String) -> Result<Value, String> {
    apelles_grade_model::load_grade(&path)
}

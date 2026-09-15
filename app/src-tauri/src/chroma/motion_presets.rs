//! motion_presets.rs — the saved-layer-preset ("component") library (D-332).
//!
//! What it is: two Tauri commands that read and write the user's library of
//!   saved Motion layer presets, as one JSON file in the app data directory
//!   (`<app_data_dir>/motion/layer-presets.json`).
//! What it does: `chroma_motion_load_layer_presets` returns the list (an
//!   ABSENT file is an empty list, not an error — a user who has never saved
//!   one is the normal case, not a failure); `chroma_motion_save_layer_presets`
//!   replaces it wholesale.
//! What it does NOT do: no validation of a preset's `layer` fragment beyond
//!   "it is JSON" — the frontend's `sanitizeLoadedPresets`
//!   (`packages/motion/src/layerPresets.ts`) owns that, because knowing which
//!   `use` values are real means knowing the engine's zod enum, which lives in
//!   TypeScript. No per-item add/delete: the frontend owns the list and sends
//!   the whole thing back, exactly as `file_management.rs`'s
//!   `load_presets`/`save_presets` do for grading presets. No merge, no
//!   import/export, no folders.
//!
//! **Why app data and not the project.** A preset exists to be reused across
//! projects — reuse WITHIN one manifest is already `duplicateLayer`. So this
//! is deliberately NOT a `<project>.chroma/` sidecar the way
//! `motion.rs`'s manifest is; it is user-level state, and the in-repo
//! precedent for user-level state is `app_data_dir()` (`app_settings.rs`'s
//! `settings.json`, `file_management.rs`'s `presets/presets.json`).
//!
//! **Why its own file rather than a field on `AppSettings`.** `settings.json`
//! is re-serialised and rewritten on every settings change; a library that
//! grows with use does not belong in that write path. The grading presets made
//! the same call for the same reason and are the pattern followed here.
//!
//! **Why whole-list save rather than append.** Concurrency is not a concern
//! (one desktop app, one window) and a whole-list write makes delete and
//! rename fall out for free with no second code path. It is also what makes
//! the pure TypeScript half testable without a backend at all.
//!
//! Fork hygiene (D-003): all new code. Upstream footprint is `pub mod
//! motion_presets;` in `chroma/mod.rs` + two `generate_handler!` lines in
//! `lib.rs`.

use std::path::PathBuf;

use serde_json::Value;
use tauri::{AppHandle, Manager};

/// `<app_data_dir>/motion/layer-presets.json`, creating the directory if it
/// is not there yet. Mirrors `file_management.rs`'s `get_presets_path`,
/// including that it is the PATH helper's job to make the parent exist so
/// neither caller has to.
fn library_path(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("motion");

    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    }

    Ok(dir.join("layer-presets.json"))
}

/// The saved library, or an empty list when nothing has been saved yet.
///
/// A file that fails to PARSE is a real error rather than a silent empty
/// list: that is a corrupt library the user may want to recover by hand, and
/// quietly reporting "you have no presets" would invite them to overwrite it
/// with the next save. A file that does not EXIST is not an error at all.
#[tauri::command]
pub fn chroma_motion_load_layer_presets(app_handle: AppHandle) -> Result<Vec<Value>, String> {
    let path = library_path(&app_handle)?;
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let text =
        std::fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(&text).map_err(|e| format!("parse {}: {e}", path.display()))
}

/// Replace the library with `presets`. Returns the file path, matching
/// `chroma_motion_save_manifest`'s own convention so a caller can show the
/// user where the library actually lives.
#[tauri::command]
pub fn chroma_motion_save_layer_presets(
    presets: Vec<Value>,
    app_handle: AppHandle,
) -> Result<String, String> {
    let path = library_path(&app_handle)?;
    let pretty = serde_json::to_string_pretty(&presets).map_err(|e| e.to_string())?;
    std::fs::write(&path, format!("{pretty}\n"))
        .map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(path.to_string_lossy().to_string())
}

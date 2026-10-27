//! The Motion tab's unsaved-edit recovery copy: the command surface (D-415).
//!
//! **What it is:** three commands over `apelles_motion::recovery`, the file
//! `<project>.chroma/motion/manifest.recovery.json`. The Motion tab writes its
//! unsaved manifest text there (debounced, and on `pagehide`), reads it back
//! once when a page first loads a project, and clears it when the text is saved
//! or discarded.
//!
//! **What it does NOT do:** touch `manifest.json` (only the person's explicit
//! Save does), or feed a render: the render job takes the manifest it is handed.
//! `chroma_motion_save_manifest` clears the copy itself, in `motion.rs`.

use std::path::PathBuf;

use apelles_motion::recovery::{self, Recovery};

use super::state;

fn motion_dir() -> Result<PathBuf, String> {
    state::current_project()
        .map(|p| p.path.join("motion"))
        .ok_or_else(|| "no project open — open one in the Colorist tab".to_string())
}

/// Replace the recovery copy with the Motion tab's current unsaved text.
#[tauri::command]
pub async fn chroma_motion_recovery_write(text: String) -> Result<(), String> {
    let dir = motion_dir()?;
    tokio::task::spawn_blocking(move || recovery::write(&dir, &text))
        .await
        .map_err(|e| format!("recovery write task: {e}"))?
}

/// The recovery copy for the open project, or `null`.
#[tauri::command]
pub async fn chroma_motion_recovery_read() -> Result<Option<Recovery>, String> {
    let dir = motion_dir()?;
    tokio::task::spawn_blocking(move || recovery::read(&dir))
        .await
        .map_err(|e| format!("recovery read task: {e}"))?
}

/// Remove the recovery copy (the text was saved, undone back to the saved
/// document, or discarded).
#[tauri::command]
pub async fn chroma_motion_recovery_clear() -> Result<(), String> {
    let dir = motion_dir()?;
    tokio::task::spawn_blocking(move || recovery::clear(&dir))
        .await
        .map_err(|e| format!("recovery clear task: {e}"))?
}

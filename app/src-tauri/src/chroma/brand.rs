//! brand.rs — the Tauri commands behind brand kits (D-416).
//!
//! What it is: thin wrappers over `apelles_brand`: the user's kit library
//! (`<app data>/brand/kits/<id>.json`, per-file errors, atomic writes), the
//! brand asset store (`<app data>/brand/assets/`, content-addressed), and the
//! open project's snapshot of its active kit (`<project>.chroma/brand/`).
//!
//! What it does NOT do: validate a kit (zod in `@apelles/brand` is the one
//! schema), bump versions (the frontend's `versionForSave`), or apply a kit to
//! any tab (each tab's own apply, through `@apelles/brand`'s applier registry).

use std::path::{Path, PathBuf};

use apelles_brand::{assets, library, project};
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::chroma::state;

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

fn current_project_dir() -> Result<PathBuf, String> {
    state::current_project()
        .map(|p| p.path)
        .ok_or_else(|| "no project open — a brand kit is set per project".to_string())
}

/// Make `dir` readable by the webview (logo and reference thumbnails through
/// `convertFileSrc`), for this folder only, the `chroma_motion_assets_dir` rule.
fn allow_dir(app: &AppHandle, dir: &Path) -> Result<String, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    app.asset_protocol_scope()
        .allow_directory(dir, false)
        .map_err(|e| format!("allow {}: {e}", dir.display()))?;
    Ok(dir.to_string_lossy().to_string())
}

/// Every kit file that parses, plus one `{file, error}` per file that does not.
#[tauri::command]
pub fn chroma_brand_load_kits(app: AppHandle) -> Result<library::Library, String> {
    library::load_library(&library::kits_dir(&app_data_dir(&app)?)).map_err(|e| e.to_string())
}

/// Write one kit atomically; returns the path.
#[tauri::command]
pub fn chroma_brand_save_kit(kit: Value, app: AppHandle) -> Result<String, String> {
    library::save_kit(&library::kits_dir(&app_data_dir(&app)?), &kit)
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

/// Remove one kit from the library; `false` when there was none. Projects keep
/// their own copies.
#[tauri::command]
pub fn chroma_brand_delete_kit(id: String, app: AppHandle) -> Result<bool, String> {
    library::delete_kit(&library::kits_dir(&app_data_dir(&app)?), &id).map_err(|e| e.to_string())
}

/// Import a file into the brand asset store (a logo, font, LUT, reference,
/// sonic logo); the same file twice is the same id.
#[tauri::command]
pub async fn chroma_brand_import_asset(
    path: String,
    app: AppHandle,
) -> Result<assets::BrandAsset, String> {
    let dir = assets::library_assets_dir(&app_data_dir(&app)?);
    tokio::task::spawn_blocking(move || {
        assets::import_asset(Path::new(&path), &dir).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("import task: {e}"))?
}

/// The brand asset store's folder, readable by the webview.
#[tauri::command]
pub fn chroma_brand_assets_dir(app: AppHandle) -> Result<String, String> {
    allow_dir(&app, &assets::library_assets_dir(&app_data_dir(&app)?))
}

/// The open project's kit snapshot, or `null` when it has none.
#[tauri::command]
pub fn chroma_brand_project_get() -> Result<Option<Value>, String> {
    project::read(&current_project_dir()?).map_err(|e| e.to_string())
}

/// Set (copy the kit and its assets into the project) or clear (`null`) the
/// open project's active kit.
#[tauri::command]
pub async fn chroma_brand_project_set(
    kit: Option<Value>,
    app: AppHandle,
) -> Result<Option<project::InstallReport>, String> {
    let dir = current_project_dir()?;
    let library_assets = assets::library_assets_dir(&app_data_dir(&app)?);
    tokio::task::spawn_blocking(move || match kit {
        Some(kit) => project::install(&kit, &library_assets, &dir)
            .map(Some)
            .map_err(|e| e.to_string()),
        None => project::clear(&dir)
            .map(|_| None)
            .map_err(|e| e.to_string()),
    })
    .await
    .map_err(|e| format!("brand task: {e}"))?
}

/// The open project's brand asset folder, readable by the webview.
#[tauri::command]
pub fn chroma_brand_project_assets_dir(app: AppHandle) -> Result<String, String> {
    allow_dir(&app, &project::project_assets_dir(&current_project_dir()?))
}

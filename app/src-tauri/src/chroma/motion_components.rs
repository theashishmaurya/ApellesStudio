//! motion_components.rs — the custom-component commands (D-409).
//!
//! What it is: thin Tauri wrappers over `apelles_motion::components` — load the
//!   library (built-ins beside the engine plus `<app data>/motion/components/`),
//!   read one version, write a draft (after the Node static check passes), run
//!   the certification proof, certify, delete, install a certified version into
//!   the open project's assets, render a custom layer's proxy frames for the
//!   live player, and allow the library folders in the asset-protocol scope so
//!   the Catalog can show contact sheets.
//! What it does NOT do: validate a component's declaration (the frontend's zod
//!   schema does, `customComponents.ts`), build the proof manifest (also the
//!   frontend), or run component code: every render here spawns the Remotion
//!   renderer process (`scripts/render.mts`, D-417), which is where custom code
//!   runs, never this process or the webview (D-409's security boundary). The
//!   check and every render need the Motion runtime (`motion_runtime::require`);
//!   the library itself is listed from the engine files without it.
//!
//! Every slow command (check: Node + the TypeScript compiler; prove: three
//! render passes; proxy: one render) runs on a blocking thread.

use std::path::{Path, PathBuf};

use serde_json::Value;
use tauri::{AppHandle, Manager};

use apelles_motion::components::{self as comps, ProofPlan};

use super::state;

fn app_data(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

fn user_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(comps::components_dir(&app_data(app)?))
}

/// The built-ins ship with the engine files (the checkout's, or the engine pack's
/// in an installed app — D-417).
fn builtin_root() -> PathBuf {
    comps::builtin_components_dir(&super::motion_runtime::engine_dir())
}

fn current_project_dir() -> Result<PathBuf, String> {
    state::current_project()
        .map(|p| p.path)
        .ok_or_else(|| "no project open — open one in the Colorist tab".to_string())
}

/// The folder of `id`@`version` in either root, or a named error.
fn version_dir(app: &AppHandle, id: &str, version: u32) -> Result<PathBuf, String> {
    comps::find_version(Some(&builtin_root()), &user_root(app)?, id, version)
        .ok_or_else(|| format!("{id}@{version} is not in the component library"))
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("component task: {e}"))?
}

/// D-409 — the whole library: every loadable version and one error per bad
/// folder.
#[tauri::command]
pub fn chroma_motion_load_components(app: AppHandle) -> Result<comps::Library, String> {
    Ok(comps::load_library(
        Some(&builtin_root()),
        &user_root(&app)?,
    ))
}

/// D-409 — one version's meta and source.
#[tauri::command]
pub fn chroma_motion_read_component(
    id: String,
    version: u32,
    app: AppHandle,
) -> Result<comps::VersionFiles, String> {
    comps::read_version(&version_dir(&app, &id, version)?).map_err(|e| e.to_string())
}

/// D-409 — `chroma_motion_write_component`'s answer: the static check (without
/// the compiled module, which stays in the backend) and, when it passed and
/// this was not a dry run, the stored draft.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub check: comps::CheckReport,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub draft: Option<comps::DraftOutcome>,
}

/// D-409 — run the static check on `source` and, when it passes, store it as
/// the id's open draft (`dry_run` checks only).
#[tauri::command]
pub async fn chroma_motion_write_component(
    spec: Value,
    source: String,
    dry_run: bool,
    app: AppHandle,
) -> Result<WriteResult, String> {
    let user = user_root(&app)?;
    let runtime = super::motion_runtime::require()?;
    blocking(move || {
        let report = comps::check_source(&runtime, &source).map_err(|e| e.to_string())?;
        let draft = if report.ok && !dry_run {
            Some(
                comps::write_draft(Some(&builtin_root()), &user, &spec, &source, &report)
                    .map_err(|e| e.to_string())?,
            )
        } else {
            None
        };
        Ok(WriteResult {
            check: comps::CheckReport {
                code: None,
                ..report
            },
            draft,
        })
    })
    .await
}

/// D-409 — render the certification proof for one version (recorded on a
/// draft). Scratch renders and bundles live under
/// `<app data>/motion/cache/components/`.
#[tauri::command]
pub async fn chroma_motion_prove_component(
    id: String,
    version: u32,
    plan: ProofPlan,
    app: AppHandle,
) -> Result<comps::ProofOutcome, String> {
    let dir = version_dir(&app, &id, version)?;
    let cache = app_data(&app)?
        .join("motion")
        .join("cache")
        .join("components");
    let runtime = super::motion_runtime::require()?;
    blocking(move || comps::prove(&runtime, &cache, &dir, &plan).map_err(|e| e.to_string())).await
}

/// D-409 — certify a proven draft in the user library (built-ins ship
/// certified).
#[tauri::command]
pub fn chroma_motion_certify_component(
    id: String,
    version: u32,
    app: AppHandle,
) -> Result<Value, String> {
    let dir = user_root(&app)?.join(&id).join(version.to_string());
    if !comps::is_component_id(&id) || !dir.is_dir() {
        return Err(format!("{id}@{version} is not in your component library"));
    }
    comps::certify(&dir).map_err(|e| e.to_string())
}

/// D-409 — delete one version (or all, `version: null`) from the user library.
#[tauri::command]
pub fn chroma_motion_delete_component(
    id: String,
    version: Option<u32>,
    app: AppHandle,
) -> Result<usize, String> {
    comps::delete(&user_root(&app)?, &id, version).map_err(|e| e.to_string())
}

/// D-409 — copy a certified version's module and source into the open
/// project's asset folder (content-addressed), for the manifest to embed.
#[tauri::command]
pub async fn chroma_motion_install_component(
    id: String,
    version: u32,
    app: AppHandle,
) -> Result<comps::Installed, String> {
    let dir = version_dir(&app, &id, version)?;
    let assets = apelles_motion::assets::assets_dir(&current_project_dir()?);
    blocking(move || comps::install_into_project(&dir, &assets).map_err(|e| e.to_string())).await
}

/// D-409 — render one custom layer's frames (a one-layer manifest the
/// frontend built) for the live player, into `<project>/motion/cache/proxy/`,
/// which is allowed in the asset-protocol scope so the player can show them.
#[tauri::command]
pub async fn chroma_motion_component_proxy(
    manifest: Value,
    scale: f64,
    app: AppHandle,
) -> Result<comps::ProxyOutcome, String> {
    let project = current_project_dir()?;
    let runtime = super::motion_runtime::require()?;
    let out_root = project.join("motion").join("cache").join("proxy");
    std::fs::create_dir_all(&out_root)
        .map_err(|e| format!("create {}: {e}", out_root.display()))?;
    app.asset_protocol_scope()
        .allow_directory(&out_root, true)
        .map_err(|e| format!("allow {}: {e}", out_root.display()))?;
    let assets = apelles_motion::assets::assets_dir(&project);
    let req = comps::ProxyRequest {
        runtime,
        bundle_cache: project.join("motion").join("cache").join("preview"),
        out_root,
        manifest,
        public_dir: Some(assets).filter(|d| d.is_dir()),
        scale,
    };
    blocking(move || comps::render_proxy(&req).map_err(|e| e.to_string())).await
}

/// D-409 — allow both library roots in the asset-protocol scope (recursively:
/// contact sheets sit two levels down), so the Catalog can show them.
#[tauri::command]
pub fn chroma_motion_components_dirs(app: AppHandle) -> Result<Vec<String>, String> {
    let user = user_root(&app)?;
    std::fs::create_dir_all(&user).map_err(|e| format!("create {}: {e}", user.display()))?;
    let mut out = Vec::new();
    for dir in [user, builtin_root()] {
        if Path::new(&dir).is_dir() {
            app.asset_protocol_scope()
                .allow_directory(&dir, true)
                .map_err(|e| format!("allow {}: {e}", dir.display()))?;
            out.push(dir.to_string_lossy().to_string());
        }
    }
    Ok(out)
}

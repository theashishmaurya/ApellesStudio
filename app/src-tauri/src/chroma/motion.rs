//! motion.rs — the Motion tab bridge (D-039 roadmap "Motion tab MVP", D-046).
//!
//! What it is: Tauri commands for the Motion tab — persist the current
//!   project's one scene manifest to a sidecar file
//!   (`<project>.chroma/motion/manifest.json`, the same "path-addressed
//!   sidecar" convention `grade.rs` uses for each shot's `grade.json`) and
//!   drive a real render through the `chroma-motion` crate
//!   (→ `npx remotion render` in `packages/motion-engine`).
//! What it does: `chroma_motion_get_manifest` / `chroma_motion_save_manifest`
//!   read/write that sidecar for the currently open project, resolved via
//!   `state::current_project()` — the same source `edit.rs`'s
//!   `current_project_dir()` reads. `chroma_motion_render` resolves
//!   `packages/motion-engine` relative to this crate's own source location
//!   and calls `chroma_motion::run_render` on a blocking thread, returning
//!   once the render finishes (no progress reporting this pass).
//! What it does NOT do: no manifest schema validation — the frontend
//!   validates against the `zod` schema in
//!   `packages/motion-engine/src/engine/schema.ts` before ever calling
//!   save/render (see D-046). No `ProjectManifest` field: a sidecar file, not
//!   a `project.json` field, specifically to avoid touching the
//!   heavily-in-flight `project.rs` — see the D-046 decision. No multi-manifest
//!   / scene management — one manifest per project, this pass's scope.
//!
//! Fork hygiene (D-003): all new code. Upstream footprint is `pub mod motion;`
//! in `chroma/mod.rs` + the `generate_handler!` lines in `lib.rs`.

use std::path::{Path, PathBuf};

use serde_json::Value;

use chroma_motion::{RenderOutcome, RenderRequest};

use super::state;

fn current_project_dir() -> Result<PathBuf, String> {
    state::current_project()
        .map(|p| p.path)
        .ok_or_else(|| "no project open — open one in the Colorist tab".to_string())
}

/// `<project>.chroma/motion/manifest.json` — the one scene manifest the
/// Motion tab edits for this project (D-046: singular, "one manifest per
/// project" per this pass's scope; multi-manifest is deferred).
fn manifest_path(project_dir: &Path) -> PathBuf {
    project_dir.join("motion").join("manifest.json")
}

/// `packages/motion-engine`, resolved from this crate's own compile-time
/// location (`app/src-tauri` → `../../packages/motion-engine`) rather than a
/// runtime guess. Correct for `npm run tauri:dev`; a packaged build bundling
/// (or downloading) the engine separately is a later step — the engine is a
/// dev-time Node project today, not shipped in the app bundle (D-046).
fn engine_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("packages")
        .join("motion-engine")
}

/// The current project's saved motion manifest, or `null` if none has been
/// saved yet (a fresh project — the tab falls back to the engine's own
/// sample manifest in that case).
#[tauri::command]
pub fn chroma_motion_get_manifest() -> Result<Option<Value>, String> {
    let dir = current_project_dir()?;
    let path = manifest_path(&dir);
    if !path.is_file() {
        return Ok(None);
    }
    let text =
        std::fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("parse {}: {e}", path.display()))
}

/// Persist `manifest` as the current project's motion manifest. The caller
/// (the Motion tab) has already validated it against the engine's `zod`
/// schema — this only pretty-prints and writes.
#[tauri::command]
pub fn chroma_motion_save_manifest(manifest: Value) -> Result<String, String> {
    let dir = current_project_dir()?;
    let path = manifest_path(&dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let pretty = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    std::fs::write(&path, format!("{pretty}\n"))
        .map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(path.to_string_lossy().to_string())
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MotionRenderResult {
    pub output_path: String,
    pub stdout_tail: String,
}

impl From<RenderOutcome> for MotionRenderResult {
    fn from(o: RenderOutcome) -> Self {
        Self {
            output_path: o.output_path.to_string_lossy().to_string(),
            stdout_tail: o.stdout_tail,
        }
    }
}

/// `<project>.chroma/motion/render.mp4` — the default whole-manifest render
/// destination when the caller doesn't name one AND doesn't name a scene
/// (`scene_id: None`). A single fixed name (not timestamped): this pass is
/// "one manifest per project", so a render at a well-known path
/// re-render/overwrites is the right default; a save-dialog / render history
/// is a later step.
///
/// D-180 — with a `scene_id`, the default instead becomes
/// `<project>.chroma/motion/renders/<scene_id>.mp4`: the frontend's own
/// per-scene export loop (`packages/motion/src/useMotionManifest.ts`'s
/// `render()`) passes the scene id but never a full path, so this is the ONE
/// place project-relative render paths get computed — kept here (not the
/// frontend) since only this side actually knows where the project lives
/// (`current_project_dir`/`state::current_project`).
fn default_output_path(project_dir: &Path, scene_id: Option<&str>) -> PathBuf {
    match scene_id {
        Some(id) => project_dir.join("motion").join("renders").join(format!("{id}.mp4")),
        None => project_dir.join("motion").join("render.mp4"),
    }
}

/// Render the current project's saved manifest via `npx remotion render`
/// (the `chroma-motion` crate), to `output_path` or, if `None`,
/// [`default_output_path`]. The manifest must already be saved
/// (`chroma_motion_save_manifest`) before calling this. Blocks on a
/// background thread until the render finishes — no progress reporting, one
/// render at a time (D-046).
///
/// D-180 — `frame_range`, an inclusive `(start, end)` ABSOLUTE composition
/// frame range, renders only that sub-range (`RenderRequest::with_frame_range`
/// → Remotion's own `--frames=start-end`) instead of the whole manifest.
/// `scene_id`, when given (and `output_path` is `None`), picks
/// [`default_output_path`]'s per-scene naming. This command stays
/// manifest-shape agnostic exactly as its own module doc comment already
/// promises — it never computes a scene's own frame range itself; the
/// frontend (`packages/motion/src/useMotionManifest.ts`'s `render()`, which
/// already owns `sceneStartFrame`/`sceneDurationFrames`) works it out and
/// passes the two numbers straight through. Both `None` renders every frame
/// to the single whole-manifest default path, unchanged from this command's
/// pre-D-180 behavior.
#[tauri::command]
pub async fn chroma_motion_render(
    output_path: Option<String>,
    frame_range: Option<(u32, u32)>,
    scene_id: Option<String>,
) -> Result<MotionRenderResult, String> {
    let dir = current_project_dir()?;
    let manifest = manifest_path(&dir);
    if !manifest.is_file() {
        return Err("no motion manifest saved for this project yet".to_string());
    }
    let out = output_path
        .map(PathBuf::from)
        .unwrap_or_else(|| default_output_path(&dir, scene_id.as_deref()));
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let mut req = RenderRequest::new(engine_dir(), manifest, out);
    if let Some((start, end)) = frame_range {
        req = req.with_frame_range(start, end);
    }
    tauri::async_runtime::spawn_blocking(move || chroma_motion::run_render(&req))
        .await
        .map_err(|e| format!("render task panicked: {e}"))?
        .map(MotionRenderResult::from)
        .map_err(|e| e.to_string())
}

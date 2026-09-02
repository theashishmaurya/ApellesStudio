//! Chroma project model (D-037) — the saved project the launcher opens.
//!
//! What it is: `~/Movies/Chroma/<name>.chroma/` — a directory holding
//!   `project.json` (a versioned manifest: name, shots keyed by **absolute
//!   source path**, active shot, free-form settings), `thumb.jpg` (the launcher
//!   card frame, regenerated on save), and `grades/<shotId>.grade.json` (each
//!   shot's grade in the D-025 format, so the grade travels with the project
//!   even though the media does not).
//! What it does: scan / load / save / create projects — pure `serde_json` +
//!   `std::fs`, no GPU, no store mutation (same discipline as `grade.rs`).
//!   Media is **referenced in place** by absolute path and never copied
//!   (D-037); a source path that no longer exists is "media offline" — flagged,
//!   not fatal, and re-pointable via [`chroma_project_relink`].
//! What it does NOT do: any grade math, decode, or GPU work. Thumb regen shells
//!   out to `chroma::video::extract_thumb`. The D-032 activity feed is
//!   session-only and never persisted.
//!
//! Fork hygiene (D-003): all new code; upstream footprint is `pub mod project;`
//!   in `chroma/mod.rs` + the `generate_handler!` lines in `lib.rs`.
//!
//! Supersedes D-033's deferred `.chroma/session.json` — the multi-shot
//! `Session` (D-033) is now the *loaded form* of a saved project.
//!
//! **Media pool (D-044, pass 1 of the roadmap's "media pool + import +
//! multiple timelines" item):** [`ProjectManifest::media`] is a project-wide
//! `Vec<MediaItem>` — every file the project references, whether or not it is
//! currently a graded shot or cut into the Edit-tab timeline. This pass is
//! **additive only**: `media` and `shots` are two independent lists for now
//! (`shots` unchanged, only [`chroma_media_import`] writes to `media`); a shot
//! does not yet carry a `media_id` back-reference. See the D-044 decision for
//! why, and what pass 2/3 still owe (bins/folders, multiple named timelines,
//! the docked Sources panel, and true `shots`/`media` unification).

use std::path::{Path, PathBuf};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::app_state::AppState;

use super::state::{self, ProjectRef};
use super::{load, video};

/// Current manifest schema. `chroma.project/<major>` — bump the major only on a
/// breaking change; [`load_manifest`] rejects a file with a newer major.
pub const SCHEMA: &str = "chroma.project/1";
const CURRENT_MAJOR: u64 = 1;

// --------------------------------------------------------------------------- //
// the manifest
// --------------------------------------------------------------------------- //

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectShot {
    pub id: String,
    /// absolute path to the source clip — referenced, never copied
    pub source_path: String,
    #[serde(default)]
    pub frame: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// Per-project output spec (D-038). Every field is **optional** — a project with
/// no explicit settings behaves exactly as before this decision (output is
/// derived from whichever clip is loaded). Set fields give a multi-shot project
/// one output spec instead of N clip-derived ones.
///
/// `color_space` is **stored and surfaced only** — a real colour-managed
/// pipeline (working-space transforms, output display transform) is D-004, not
/// this. Today it round-trips through `project.json`, shows in the UI, and is
/// available to the encoder as metadata; it does not change grade math.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSettings {
    /// output width in pixels; `None` → the loaded clip's width
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    /// output height in pixels; `None` → the loaded clip's height
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    /// project timebase; `None` → the loaded clip's frame rate
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fps: Option<f64>,
    /// `"rec709"` (default when `None`) / `"rec2020"` / `"dci-p3"` / `"srgb"`.
    /// Store + surface only — see the struct doc.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color_space: Option<String>,
}

impl ProjectSettings {
    /// Merge a JSON `patch` into `self`: a **present** key is applied (a `null`
    /// value clears the field), an **absent** key is left untouched. This is the
    /// partial-merge contract of [`chroma_project_set_settings`].
    pub fn merge_patch(&mut self, patch: &Value) {
        let Some(obj) = patch.as_object() else { return };
        if obj.contains_key("width") {
            self.width = obj["width"].as_u64().map(|v| v as u32);
        }
        if obj.contains_key("height") {
            self.height = obj["height"].as_u64().map(|v| v as u32);
        }
        if obj.contains_key("fps") {
            self.fps = obj["fps"].as_f64().filter(|f| *f > 0.0);
        }
        // accept camelCase (frontend) and snake_case (MCP kwarg) alike
        for key in ["colorSpace", "color_space"] {
            if obj.contains_key(key) {
                self.color_space = obj[key]
                    .as_str()
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty());
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectManifest {
    #[serde(default)]
    pub schema: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub created: String,
    #[serde(default)]
    pub modified: String,
    #[serde(default)]
    pub shots: Vec<ProjectShot>,
    #[serde(default)]
    pub active_shot: usize,
    /// Per-project output spec (D-038). Deserializes leniently: a legacy
    /// `settings: {}` or `settings: { "fps": 24 }` still loads (unknown keys
    /// ignored, missing keys → `None`); an absent `settings` key → all `None`.
    #[serde(default)]
    pub settings: ProjectSettings,
    /// The Edit-tab timeline (D-041) — a single-video-track assembly of the
    /// project's shots plus any edits made in the Edit tab. Additive and
    /// optional (schema major unchanged, same as D-038's `settings`): an
    /// absent key → `None`, and the project behaves as it did pre-D-041.
    /// Built + persisted lazily by `chroma::edit::chroma_timeline_get`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeline: Option<chroma_timeline::Timeline>,
    /// The project's media pool (D-044, pass 1) — every file imported via
    /// [`chroma_media_import`], independent of `shots`/`timeline`. Additive,
    /// optional (schema major unchanged, same move as D-038/D-041): an absent
    /// `media` key → an empty pool, and the project behaves exactly as it did
    /// pre-D-044.
    #[serde(default)]
    pub media: Vec<MediaItem>,
}

impl ProjectManifest {
    fn fresh(name: &str) -> Self {
        let now = now_rfc3339();
        ProjectManifest {
            schema: SCHEMA.to_string(),
            name: name.to_string(),
            created: now.clone(),
            modified: now,
            shots: Vec::new(),
            active_shot: 0,
            settings: ProjectSettings::default(),
            timeline: None,
            media: Vec::new(),
        }
    }
}

// --------------------------------------------------------------------------- //
// media pool (D-044) — MediaItem: media referenced by the project, whether or
// not it is currently a graded shot or cut into a timeline. See the module
// doc + the D-044 decision for how this relates to `shots` in this pass.
// --------------------------------------------------------------------------- //

/// Probed video facts cheap to keep on a [`MediaItem`] up front — a subset of
/// `video::VideoInfo` (no codec / pix_fmt / colour tags; add them if a later
/// pass needs them). Reuses the existing `video::probe` path — no new prober.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaVideoInfo {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub frame_count: u64,
    pub duration_secs: f64,
}

impl From<&video::VideoInfo> for MediaVideoInfo {
    fn from(info: &video::VideoInfo) -> Self {
        MediaVideoInfo {
            width: info.width,
            height: info.height,
            fps: info.fps(),
            frame_count: info.frame_count,
            duration_secs: info.duration_secs,
        }
    }
}

/// One item in the project's media pool — referenced in place by absolute
/// path, **never copied** (the same invariant [`ProjectShot`] already keeps).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaItem {
    pub id: String,
    pub source_path: String,
    pub name: String,
    /// RFC-3339 import time.
    #[serde(default)]
    pub added: String,
    /// Probed at import time; `None` when the source failed to probe (not a
    /// video / unreadable at that moment) — the item is still added rather
    /// than dropped, same "offline is flagged, not fatal" discipline
    /// `ProjectShot` uses. Live online/offline status is re-checked at
    /// list/import time, not stored here — see [`MediaItemDto`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video: Option<MediaVideoInfo>,
}

/// [`MediaItem`] + a live-checked `offline` flag — what `chroma_media_import`
/// / `chroma_media_list` actually return. Mirrors the `ProjectShot` /
/// `ProjectShotDto` split.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaItemDto {
    pub id: String,
    pub source_path: String,
    pub name: String,
    pub added: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video: Option<MediaVideoInfo>,
    /// the source path does not exist right now (or is not a video file)
    pub offline: bool,
}

/// `true` if `path` is a readable video file right now — the same cheap check
/// [`shot_is_online`] uses for shots.
fn media_item_is_online(path: &str) -> bool {
    let p = Path::new(path);
    p.is_file() && video::is_video_file(p)
}

impl From<&MediaItem> for MediaItemDto {
    fn from(m: &MediaItem) -> Self {
        MediaItemDto {
            id: m.id.clone(),
            source_path: m.source_path.clone(),
            name: m.name.clone(),
            added: m.added.clone(),
            video: m.video.clone(),
            offline: !media_item_is_online(&m.source_path),
        }
    }
}

/// Probe `path` and build a [`MediaItem`] for it. Never fails outright — a
/// probe failure (offline / not decodable) just leaves `video: None`.
fn probe_media_item(path: &str) -> MediaItem {
    let name = Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string());
    let video = media_item_is_online(path)
        .then(|| video::probe(Path::new(path)).ok())
        .flatten()
        .as_ref()
        .map(MediaVideoInfo::from);
    MediaItem {
        id: uuid::Uuid::new_v4().to_string(),
        source_path: path.to_string(),
        name,
        added: now_rfc3339(),
        video,
    }
}

/// Probe + append the entries of `paths` not already in `manifest.media`
/// (matched by source path — re-importing the same file is a no-op, not a
/// duplicate) and return just the items that were added. Pure model logic —
/// no persistence; callers `save_manifest` themselves.
fn add_media(manifest: &mut ProjectManifest, paths: &[String]) -> Vec<MediaItem> {
    let existing: std::collections::HashSet<&str> =
        manifest.media.iter().map(|m| m.source_path.as_str()).collect();
    let added: Vec<MediaItem> = paths
        .iter()
        .filter(|p| !existing.contains(p.as_str()))
        .map(|p| probe_media_item(p))
        .collect();
    manifest.media.extend(added.iter().cloned());
    added
}

// --------------------------------------------------------------------------- //
// where projects live
// --------------------------------------------------------------------------- //

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// `~/Movies/Chroma` — the default project folder.
pub fn default_projects_dir() -> PathBuf {
    home().join("Movies").join("Chroma")
}

fn config_path() -> PathBuf {
    home().join(".chroma").join("config.json")
}

/// The project folder the launcher scans: the Settings override if set, else
/// [`default_projects_dir`].
pub fn projects_dir() -> PathBuf {
    if let Ok(txt) = std::fs::read_to_string(config_path()) {
        if let Ok(v) = serde_json::from_str::<Value>(&txt) {
            if let Some(s) = v.get("projectsDir").and_then(|x| x.as_str()) {
                if !s.trim().is_empty() {
                    return PathBuf::from(s);
                }
            }
        }
    }
    default_projects_dir()
}

fn set_projects_dir(dir: &str) -> Result<(), String> {
    let cp = config_path();
    if let Some(parent) = cp.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let v = serde_json::json!({ "projectsDir": dir });
    std::fs::write(&cp, format!("{}\n", serde_json::to_string_pretty(&v).unwrap()))
        .map_err(|e| format!("write {}: {e}", cp.display()))
}

// --------------------------------------------------------------------------- //
// load / save the manifest (pure fs + json)
// --------------------------------------------------------------------------- //

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Read + parse `<project_dir>/project.json`, gate the schema major, and clamp
/// `active_shot` into range. Untagged files are treated as v1.
pub fn load_manifest(project_dir: &Path) -> Result<ProjectManifest, String> {
    let mp = project_dir.join("project.json");
    let txt = std::fs::read_to_string(&mp).map_err(|e| format!("read {}: {e}", mp.display()))?;
    let raw: Value =
        serde_json::from_str(&txt).map_err(|e| format!("parse {}: {e}", mp.display()))?;

    let schema = raw.get("schema").and_then(|s| s.as_str()).unwrap_or("");
    let major = schema
        .strip_prefix("chroma.project/")
        .and_then(|m| m.split('.').next())
        .and_then(|m| m.parse::<u64>().ok());
    match major {
        None | Some(1) => {}
        Some(m) if m > CURRENT_MAJOR => {
            return Err(format!(
                "project.json is schema '{schema}' — newer than this build supports \
                 (chroma.project/{CURRENT_MAJOR}). Upgrade Chroma."
            ));
        }
        Some(m) => return Err(format!("unknown project.json schema major: {m}")),
    }

    let mut manifest: ProjectManifest =
        serde_json::from_value(raw).map_err(|e| format!("project.json shape: {e}"))?;
    if manifest.schema.is_empty() {
        manifest.schema = SCHEMA.to_string();
    }
    if !manifest.shots.is_empty() && manifest.active_shot >= manifest.shots.len() {
        manifest.active_shot = 0;
    }
    Ok(manifest)
}

/// Pretty-print `manifest` to `<project_dir>/project.json` (creating the dir).
pub fn save_manifest(project_dir: &Path, manifest: &ProjectManifest) -> Result<(), String> {
    std::fs::create_dir_all(project_dir)
        .map_err(|e| format!("create {}: {e}", project_dir.display()))?;
    let pretty = serde_json::to_string_pretty(manifest).map_err(|e| e.to_string())?;
    std::fs::write(project_dir.join("project.json"), format!("{pretty}\n"))
        .map_err(|e| format!("write project.json: {e}"))
}

/// Sanitise a user-typed project name into a directory-safe stem.
fn sanitize_name(name: &str) -> String {
    let trimmed = name.trim().strip_suffix(".chroma").unwrap_or(name.trim());
    trimmed
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            c => c,
        })
        .collect::<String>()
        .trim_matches(['.', ' '])
        .to_string()
}

/// Probe `clip` and derive a [`ProjectSettings`] from it — `width` / `height` /
/// `fps` filled from the clip, `color_space` left `None` (→ treated as rec709).
/// Any failure (no path, offline, not a video, zero dimensions) → all-`None`
/// settings, i.e. clip-derived behaviour.
pub fn infer_settings_from_clip(clip: Option<&str>) -> ProjectSettings {
    let mut s = ProjectSettings::default();
    let Some(path) = clip else { return s };
    let Ok(info) = video::probe(Path::new(path)) else {
        return s;
    };
    if info.width > 0 && info.height > 0 {
        s.width = Some(info.width);
        s.height = Some(info.height);
    }
    let fps = info.fps();
    if fps > 0.0 && fps.is_finite() {
        s.fps = Some(fps);
    }
    s
}

/// Create `<dir>/<name>.chroma/` + `grades/` + `project.json` with one shot per
/// media path. Errors if a project of that name already exists.
pub fn new_project_in(
    dir: &Path,
    name: &str,
    media_paths: &[String],
) -> Result<(PathBuf, ProjectManifest), String> {
    let clean = sanitize_name(name);
    if clean.is_empty() {
        return Err("project name is empty".into());
    }
    let project_dir = dir.join(format!("{clean}.chroma"));
    if project_dir.exists() {
        return Err(format!(
            "a project named '{clean}' already exists at {}",
            project_dir.display()
        ));
    }
    std::fs::create_dir_all(project_dir.join("grades"))
        .map_err(|e| format!("create {}: {e}", project_dir.display()))?;

    let mut manifest = ProjectManifest::fresh(&clean);
    manifest.shots = media_paths
        .iter()
        .map(|p| ProjectShot {
            id: uuid::Uuid::new_v4().to_string(),
            source_path: p.clone(),
            frame: 0,
            name: Path::new(p)
                .file_name()
                .map(|n| n.to_string_lossy().to_string()),
        })
        .collect();

    // D-038: seed the project's output spec from the first shot's clip so a
    // fresh project has a sensible resolution + timebase (editable later). A
    // clip that won't probe (offline / not a video) just leaves settings unset —
    // the project then behaves clip-derived, exactly as a no-settings project.
    manifest.settings = infer_settings_from_clip(media_paths.first().map(String::as_str));

    save_manifest(&project_dir, &manifest)?;
    Ok((project_dir, manifest))
}

// --------------------------------------------------------------------------- //
// listing
// --------------------------------------------------------------------------- //

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub name: String,
    /// absolute path to the `<name>.chroma` directory
    pub path: String,
    /// RFC-3339 last-modified (manifest `modified`, else the dir mtime)
    pub modified: String,
    /// unix milliseconds — for sorting + relative-time on the frontend
    pub modified_epoch: i64,
    pub shot_count: usize,
    /// `data:image/jpeg;base64,…` of `thumb.jpg`, if present. Inlined so the
    /// launcher needs no asset-protocol scope change.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumb: Option<String>,
}

fn scan_projects(dir: &Path) -> Vec<(PathBuf, Option<ProjectManifest>, i64, String)> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in rd.flatten() {
        let p = entry.path();
        if !p.is_dir() || p.extension().and_then(|e| e.to_str()) != Some("chroma") {
            continue;
        }
        if !p.join("project.json").is_file() {
            continue;
        }
        let manifest = load_manifest(&p).ok();
        let (epoch, iso) = manifest
            .as_ref()
            .and_then(|m| chrono::DateTime::parse_from_rfc3339(&m.modified).ok())
            .map(|dt| (dt.timestamp_millis(), dt.to_rfc3339()))
            .unwrap_or_else(|| {
                entry
                    .metadata()
                    .and_then(|md| md.modified())
                    .ok()
                    .map(|t| {
                        let dt: chrono::DateTime<chrono::Utc> = t.into();
                        (dt.timestamp_millis(), dt.to_rfc3339())
                    })
                    .unwrap_or((0, String::new()))
            });
        out.push((p, manifest, epoch, iso));
    }
    out.sort_by(|a, b| b.2.cmp(&a.2));
    out
}

/// Every `*.chroma` project in `dir`, newest first. Pure — no decode.
pub fn list_projects_in(dir: &Path) -> Vec<ProjectSummary> {
    scan_projects(dir)
        .into_iter()
        .map(|(p, manifest, epoch, iso)| {
            let name = manifest
                .as_ref()
                .map(|m| m.name.clone())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| {
                    p.file_stem()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_default()
                });
            let thumb_file = p.join("thumb.jpg");
            let thumb = std::fs::read(&thumb_file).ok().map(|bytes| {
                format!(
                    "data:image/jpeg;base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(bytes)
                )
            });
            ProjectSummary {
                name,
                path: p.to_string_lossy().to_string(),
                modified: iso,
                modified_epoch: epoch,
                shot_count: manifest.as_ref().map(|m| m.shots.len()).unwrap_or(0),
                thumb,
            }
        })
        .collect()
}

// --------------------------------------------------------------------------- //
// open  (manifest -> the D-033 Session)
// --------------------------------------------------------------------------- //

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectShotDto {
    pub id: String,
    pub source_path: String,
    pub name: String,
    pub frame: u64,
    /// the source path does not exist (or is not a video) — "media offline"
    pub offline: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectOpenDto {
    pub project_path: String,
    pub name: String,
    /// `<project_path>/grades` — where each shot's `<id>.grade.json` lives
    pub grade_dir: String,
    pub schema: String,
    /// every shot, in manifest order, with `offline` flagged
    pub shots: Vec<ProjectShotDto>,
    /// index into `shots` (manifest order) of the active shot
    pub active_shot: usize,
    /// per-project output spec (D-038); all fields optional, absent = clip-derived
    pub settings: ProjectSettings,
}

/// `true` if the shot's source is a readable video file right now.
fn shot_is_online(shot: &ProjectShot) -> bool {
    let p = Path::new(&shot.source_path);
    p.is_file() && video::is_video_file(p)
}

async fn open_manifest(
    project_dir: PathBuf,
    manifest: ProjectManifest,
    state: &tauri::State<'_, AppState>,
) -> Result<ProjectOpenDto, String> {
    // start from a clean session — a project open replaces whatever was loaded
    state::set_current_video(None);

    let shot_count = manifest.shots.len();
    let active_shot = manifest.active_shot.min(shot_count.saturating_sub(1));

    let mut online_paths: Vec<PathBuf> = Vec::new();
    let mut dtos: Vec<ProjectShotDto> = Vec::with_capacity(manifest.shots.len());

    for shot in &manifest.shots {
        let online = shot_is_online(shot);
        let name = shot
            .name
            .clone()
            .or_else(|| {
                Path::new(&shot.source_path)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
            })
            .unwrap_or_else(|| shot.source_path.clone());

        if online {
            let src = PathBuf::from(&shot.source_path);
            match load::load_video_frame(&src, &shot.source_path, shot.frame, state).await {
                Ok(_) => online_paths.push(src),
                Err(e) => {
                    log::warn!("[chroma::project] shot {} failed to load: {e}", shot.source_path);
                    dtos.push(ProjectShotDto {
                        id: shot.id.clone(),
                        source_path: shot.source_path.clone(),
                        name,
                        frame: shot.frame,
                        offline: true,
                    });
                    continue;
                }
            }
        }

        dtos.push(ProjectShotDto {
            id: shot.id.clone(),
            source_path: shot.source_path.clone(),
            name,
            frame: shot.frame,
            offline: !online,
        });
    }

    // put the active shot in front on the canvas (if it's online)
    if !online_paths.is_empty() {
        let want = manifest
            .shots
            .get(manifest.active_shot)
            .map(|s| PathBuf::from(&s.source_path));
        let active_online = want
            .and_then(|w| online_paths.iter().position(|p| p == &w))
            .unwrap_or(0);
        state::session_set_active(active_online)?;
        let frame = state::current_video().map(|c| c.frame).unwrap_or(0);
        let _ = super::commands::seek_and_install(frame, None, state).await;
    }

    state::set_project(Some(ProjectRef {
        path: project_dir.clone(),
        name: manifest.name.clone(),
    }));

    Ok(ProjectOpenDto {
        project_path: project_dir.to_string_lossy().to_string(),
        name: manifest.name,
        grade_dir: project_dir.join("grades").to_string_lossy().to_string(),
        schema: manifest.schema,
        shots: dtos,
        active_shot,
        settings: manifest.settings,
    })
}

// --------------------------------------------------------------------------- //
// save  (the live session -> the manifest + thumb)
// --------------------------------------------------------------------------- //

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectShotInput {
    pub id: String,
    pub source_path: String,
    #[serde(default)]
    pub frame: u64,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSaveDto {
    pub project_path: String,
    pub name: String,
    pub modified: String,
    pub thumb_regenerated: bool,
}

fn regen_thumb(project_dir: &Path) -> bool {
    let Some(cv) = state::current_video() else {
        return false;
    };
    match video::extract_thumb(&cv.path, &cv.info, cv.frame, 360) {
        Ok(data_url) => {
            let b64 = data_url.rsplit_once(',').map(|(_, b)| b).unwrap_or(&data_url);
            match base64::engine::general_purpose::STANDARD.decode(b64.trim()) {
                Ok(bytes) => std::fs::write(project_dir.join("thumb.jpg"), bytes).is_ok(),
                Err(_) => false,
            }
        }
        Err(e) => {
            log::warn!("[chroma::project] thumb regen failed: {e}");
            false
        }
    }
}

// --------------------------------------------------------------------------- //
// tauri commands
// --------------------------------------------------------------------------- //

#[tauri::command]
pub fn chroma_project_list() -> Vec<ProjectSummary> {
    list_projects_in(&projects_dir())
}

#[tauri::command]
pub fn chroma_project_settings_dir() -> String {
    projects_dir().to_string_lossy().to_string()
}

#[tauri::command]
pub fn chroma_project_set_dir(dir: String) -> Result<String, String> {
    let trimmed = dir.trim();
    if trimmed.is_empty() {
        return Err("projects folder path is empty".into());
    }
    set_projects_dir(trimmed)?;
    Ok(projects_dir().to_string_lossy().to_string())
}

#[tauri::command]
pub async fn chroma_project_open(
    path: String,
    state: tauri::State<'_, AppState>,
) -> Result<ProjectOpenDto, String> {
    let dir = PathBuf::from(&path);
    let manifest = load_manifest(&dir)?;
    open_manifest(dir, manifest, &state).await
}

#[tauri::command]
pub async fn chroma_project_new(
    name: String,
    media_paths: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<ProjectOpenDto, String> {
    let (dir, manifest) = new_project_in(&projects_dir(), &name, &media_paths)?;
    open_manifest(dir, manifest, &state).await
}

#[tauri::command]
pub async fn chroma_project_save(
    path: Option<String>,
    shots: Vec<ProjectShotInput>,
    active_shot: usize,
) -> Result<ProjectSaveDto, String> {
    let dir = path
        .map(PathBuf::from)
        .or_else(|| state::current_project().map(|p| p.path))
        .ok_or("no project loaded — create or open one first")?;

    let mut manifest = load_manifest(&dir).unwrap_or_else(|_| {
        ProjectManifest::fresh(
            &dir.file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default(),
        )
    });
    let now = now_rfc3339();
    if manifest.created.is_empty() {
        manifest.created = now.clone();
    }
    manifest.modified = now.clone();
    if let Some(stem) = dir.file_stem() {
        manifest.name = stem.to_string_lossy().to_string();
    }
    manifest.shots = shots
        .into_iter()
        .map(|s| ProjectShot {
            id: s.id,
            source_path: s.source_path,
            frame: s.frame,
            name: s.name,
        })
        .collect();
    manifest.active_shot = active_shot.min(manifest.shots.len().saturating_sub(1));
    save_manifest(&dir, &manifest)?;

    state::set_project(Some(ProjectRef {
        path: dir.clone(),
        name: manifest.name.clone(),
    }));

    let dir2 = dir.clone();
    let thumb_regenerated = tokio::task::spawn_blocking(move || regen_thumb(&dir2))
        .await
        .unwrap_or(false);

    Ok(ProjectSaveDto {
        project_path: dir.to_string_lossy().to_string(),
        name: dir
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default(),
        modified: now,
        thumb_regenerated,
    })
}

/// `{ name, path }` for the loaded project, or `null` for an Untitled session.
/// Backs `get_state().project` so the agent can see where a save would land.
#[tauri::command]
pub fn chroma_project_current() -> Option<Value> {
    state::current_project().map(|p| {
        serde_json::json!({ "name": p.name, "path": p.path.to_string_lossy() })
    })
}

/// Re-point one shot at a new source path and reopen the project.
#[tauri::command]
pub async fn chroma_project_relink(
    path: Option<String>,
    shot_id: String,
    new_path: String,
    state: tauri::State<'_, AppState>,
) -> Result<ProjectOpenDto, String> {
    let dir = path
        .map(PathBuf::from)
        .or_else(|| state::current_project().map(|p| p.path))
        .ok_or("no project loaded")?;
    let mut manifest = load_manifest(&dir)?;
    let shot = manifest
        .shots
        .iter_mut()
        .find(|s| s.id == shot_id)
        .ok_or_else(|| format!("shot {shot_id} is not in this project"))?;
    shot.source_path = new_path.clone();
    shot.name = Path::new(&new_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string());
    manifest.modified = now_rfc3339();
    save_manifest(&dir, &manifest)?;
    open_manifest(dir, manifest, &state).await
}

/// Merge a partial output spec (D-038) into the loaded (or given) project's
/// `settings`, save `project.json`, and return the merged [`ProjectSettings`].
///
/// `partial` is `{ width?, height?, fps?, colorSpace? }`: a **present** key is
/// applied, an explicit `null` clears that field (→ clip-derived again), an
/// **absent** key is left as-is. `color_space` is stored + surfaced only — a
/// colour-managed pipeline is D-004, not this.
#[tauri::command]
pub fn chroma_project_set_settings(
    path: Option<String>,
    partial: Value,
) -> Result<ProjectSettings, String> {
    let dir = path
        .map(PathBuf::from)
        .or_else(|| state::current_project().map(|p| p.path))
        .ok_or("no project loaded — open or create one first")?;
    let mut manifest = load_manifest(&dir)?;
    manifest.settings.merge_patch(&partial);
    manifest.modified = now_rfc3339();
    save_manifest(&dir, &manifest)?;
    Ok(manifest.settings)
}

// --------------------------------------------------------------------------- //
// media pool tauri commands (D-044)
// --------------------------------------------------------------------------- //

fn require_open_project() -> Result<PathBuf, String> {
    state::current_project()
        .map(|p| p.path)
        .ok_or_else(|| "no project open — create or open one first".to_string())
}

/// Probe + append `paths` to the open project's media pool (referenced in
/// place, never copied), persist, and return just the newly-added items — a
/// path already in the pool is skipped, not duplicated. The frontend wires
/// this to a native multi-select file dialog (`@tauri-apps/plugin-dialog`'s
/// `open({ multiple: true })`, same pattern as the project launcher's
/// `pickClips`).
#[tauri::command]
pub fn chroma_media_import(paths: Vec<String>) -> Result<Vec<MediaItemDto>, String> {
    if paths.is_empty() {
        return Err("no paths given".into());
    }
    let dir = require_open_project()?;
    let mut manifest = load_manifest(&dir)?;
    let added = add_media(&mut manifest, &paths);
    if !added.is_empty() {
        manifest.modified = now_rfc3339();
        save_manifest(&dir, &manifest)?;
    }
    Ok(added.iter().map(MediaItemDto::from).collect())
}

/// The open project's full media pool, offline-checked live. For a future
/// pass's Sources panel to consume — no UI built against it yet (D-044).
#[tauri::command]
pub fn chroma_media_list() -> Result<Vec<MediaItemDto>, String> {
    let dir = require_open_project()?;
    let manifest = load_manifest(&dir)?;
    Ok(manifest.media.iter().map(MediaItemDto::from).collect())
}

// --------------------------------------------------------------------------- //
// tests — pure model (no decode, no tauri State)
// --------------------------------------------------------------------------- //

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "chroma_project_test_{tag}_{}_{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn new_project_creates_dir_and_manifest() {
        let root = tmp("new");
        let (dir, manifest) =
            new_project_in(&root, "My Shoot", &["/a.mov".into(), "/b.mov".into()]).unwrap();
        assert!(dir.ends_with("My Shoot.chroma"));
        assert!(dir.join("project.json").is_file());
        assert!(dir.join("grades").is_dir());
        assert_eq!(manifest.schema, SCHEMA);
        assert_eq!(manifest.shots.len(), 2);
        assert_eq!(manifest.active_shot, 0);
        assert_ne!(manifest.shots[0].id, manifest.shots[1].id);
        assert_eq!(manifest.shots[0].name.as_deref(), Some("a.mov"));

        // creating it again is refused
        assert!(new_project_in(&root, "My Shoot", &[]).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn manifest_round_trips() {
        let root = tmp("roundtrip");
        let (dir, mut manifest) =
            new_project_in(&root, "grade-job", &["/shoot/A001.mov".into()]).unwrap();
        manifest.shots[0].frame = 120;
        manifest.active_shot = 0;
        // D-038: typed per-project output spec round-trips
        manifest.settings = ProjectSettings {
            width: Some(1920),
            height: Some(1080),
            fps: Some(24.0),
            color_space: Some("rec709".into()),
        };
        save_manifest(&dir, &manifest).unwrap();

        let reloaded = load_manifest(&dir).unwrap();
        assert_eq!(reloaded.name, "grade-job");
        assert_eq!(reloaded.shots.len(), 1);
        assert_eq!(reloaded.shots[0].frame, 120);
        assert_eq!(reloaded.shots[0].source_path, "/shoot/A001.mov");
        assert_eq!(reloaded.settings.width, Some(1920));
        assert_eq!(reloaded.settings.height, Some(1080));
        assert_eq!(reloaded.settings.fps, Some(24.0));
        assert_eq!(reloaded.settings.color_space.as_deref(), Some("rec709"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn legacy_settings_object_still_loads() {
        // D-038 backward-compat: a project.json written before the typed
        // `settings` shape carried a free-form object — `{ "fps": 24 }` in the
        // wild. It must still deserialize (fps picked up, unknown keys ignored).
        let root = tmp("legacy_settings");
        let dir = root.join("old.chroma");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("project.json"),
            r#"{"schema":"chroma.project/1","name":"old","shots":[],"settings":{"fps":24,"somethingWeDroppedLater":true}}"#,
        )
        .unwrap();
        let m = load_manifest(&dir).unwrap();
        assert_eq!(m.settings.fps, Some(24.0));
        assert_eq!(m.settings.width, None);
        assert_eq!(m.settings.color_space, None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn empty_or_absent_settings_is_all_none() {
        let root = tmp("empty_settings");
        // legacy `settings: {}`
        let a = root.join("a.chroma");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::write(a.join("project.json"), r#"{"name":"a","shots":[],"settings":{}}"#).unwrap();
        // no `settings` key at all
        let b = root.join("b.chroma");
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(b.join("project.json"), r#"{"name":"b","shots":[]}"#).unwrap();

        for dir in [&a, &b] {
            let m = load_manifest(dir).unwrap();
            assert_eq!(m.settings, ProjectSettings::default());
            assert!(m.settings.width.is_none() && m.settings.fps.is_none());
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn settings_merge_patch_only_touches_present_keys() {
        let mut s = ProjectSettings {
            width: Some(3840),
            height: Some(2160),
            fps: Some(30.0),
            color_space: None,
        };
        // present key applied, absent keys untouched
        s.merge_patch(&serde_json::json!({ "fps": 24.0, "colorSpace": "rec2020" }));
        assert_eq!(s.width, Some(3840));
        assert_eq!(s.fps, Some(24.0));
        assert_eq!(s.color_space.as_deref(), Some("rec2020"));
        // explicit null clears; snake_case key accepted; bad fps rejected
        s.merge_patch(&serde_json::json!({ "width": null, "height": null, "color_space": null, "fps": 0 }));
        assert_eq!(s.width, None);
        assert_eq!(s.height, None);
        assert_eq!(s.color_space, None);
        assert_eq!(s.fps, None, "fps <= 0 is rejected");
        // a non-object patch is a no-op
        s.fps = Some(25.0);
        s.merge_patch(&serde_json::json!("nonsense"));
        assert_eq!(s.fps, Some(25.0));
    }

    #[test]
    fn new_project_infers_settings_from_first_clip() {
        // needs ffmpeg to synthesise a probe-able clip; skip cleanly without it.
        let Some(clip) = make_test_clip("infer", 176, 144, "25") else {
            eprintln!("skip: ffmpeg not on PATH");
            return;
        };
        let root = tmp("infer_settings");
        let (dir, manifest) =
            new_project_in(&root, "inferred", &[clip.to_string_lossy().to_string()]).unwrap();
        assert_eq!(manifest.settings.width, Some(176));
        assert_eq!(manifest.settings.height, Some(144));
        assert_eq!(manifest.settings.fps, Some(25.0));
        assert_eq!(manifest.settings.color_space, None, "color space is not inferred");

        // and it persisted
        let reloaded = load_manifest(&dir).unwrap();
        assert_eq!(reloaded.settings.width, Some(176));
        assert_eq!(reloaded.settings.fps, Some(25.0));

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_file(&clip);
    }

    /// synthesise a tiny `testsrc` clip with ffmpeg; `None` if ffmpeg is absent.
    fn make_test_clip(tag: &str, w: u32, h: u32, rate: &str) -> Option<PathBuf> {
        let out = std::env::temp_dir().join(format!("chroma_infer_{tag}_{}.mp4", std::process::id()));
        let _ = std::fs::remove_file(&out);
        let status = std::process::Command::new("ffmpeg")
            .args(["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i"])
            .arg(format!("testsrc=size={w}x{h}:rate={rate}:duration=1"))
            .args(["-pix_fmt", "yuv420p"])
            .arg(&out)
            .status()
            .ok()?;
        (status.success() && out.exists()).then_some(out)
    }

    #[test]
    fn migration_gate_rejects_newer_major() {
        let root = tmp("gate");
        let dir = root.join("x.chroma");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("project.json"),
            r#"{"schema":"chroma.project/2","name":"x","shots":[]}"#,
        )
        .unwrap();
        let err = load_manifest(&dir).unwrap_err();
        assert!(err.contains("newer than this build"), "{err}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn untagged_manifest_is_v1_and_active_clamps() {
        let root = tmp("untagged");
        let dir = root.join("y.chroma");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("project.json"),
            r#"{"name":"y","shots":[{"id":"s1","sourcePath":"/a.mov"},{"id":"s2","sourcePath":"/b.mov"}],"activeShot":9}"#,
        )
        .unwrap();
        let m = load_manifest(&dir).unwrap();
        assert_eq!(m.schema, SCHEMA);
        assert_eq!(m.active_shot, 0, "out-of-range active_shot clamps to 0");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn list_is_newest_first_and_ignores_non_projects() {
        let root = tmp("list");
        let (dir_a, _) = new_project_in(&root, "alpha", &[]).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let (_dir_b, _) = new_project_in(&root, "beta", &[]).unwrap();

        // noise the scanner must skip
        std::fs::create_dir_all(root.join("loose-folder")).unwrap();
        std::fs::create_dir_all(root.join("half.chroma")).unwrap(); // no project.json

        // bump alpha so it becomes newest
        std::thread::sleep(std::time::Duration::from_millis(5));
        let mut ma = load_manifest(&dir_a).unwrap();
        ma.modified = now_rfc3339();
        save_manifest(&dir_a, &ma).unwrap();

        let listed = list_projects_in(&root);
        assert_eq!(listed.len(), 2, "only well-formed *.chroma dirs are listed");
        assert_eq!(listed[0].name, "alpha", "newest first");
        assert_eq!(listed[1].name, "beta");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn media_offline_is_flagged_not_fatal() {
        let root = tmp("offline");
        // a real (non-video) file that exists, and a path that does not
        let present = root.join("present.mov");
        std::fs::write(&present, b"not really a video").unwrap();
        let missing = root.join("gone.mov");

        let online = ProjectShot {
            id: "a".into(),
            source_path: present.to_string_lossy().to_string(),
            frame: 0,
            name: None,
        };
        let offline = ProjectShot {
            id: "b".into(),
            source_path: missing.to_string_lossy().to_string(),
            frame: 0,
            name: None,
        };
        // extension is a real video ext + the file exists -> "online" by the
        // cheap check (probe/decode failure is handled at open time, not here)
        assert!(shot_is_online(&online));
        assert!(!shot_is_online(&offline), "a missing path is offline, not an error");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn sanitize_name_is_dir_safe() {
        assert_eq!(sanitize_name("  a/b:c  "), "a-b-c");
        assert_eq!(sanitize_name("Trip.chroma"), "Trip");
        assert_eq!(sanitize_name("...hidden..."), "hidden");
        assert_eq!(sanitize_name("north<>shoot"), "north--shoot");
    }

    // --- media pool (D-044) ------------------------------------------------

    #[test]
    fn add_media_probes_new_paths_and_dedupes_existing() {
        let root = tmp("add_media");
        let (_dir, mut manifest) = new_project_in(&root, "media-test", &[]).unwrap();
        assert!(manifest.media.is_empty());

        let missing = root.join("gone.mov").to_string_lossy().to_string();
        let added_first = add_media(&mut manifest, &[missing.clone()]);
        assert_eq!(added_first.len(), 1, "a new path is added");
        assert_eq!(manifest.media.len(), 1);
        assert_eq!(manifest.media[0].source_path, missing);
        assert!(manifest.media[0].video.is_none(), "an offline path probes to no video info");
        assert!(!manifest.media[0].id.is_empty());

        // re-importing the same path is a no-op, not a duplicate
        let added_second = add_media(&mut manifest, &[missing.clone()]);
        assert!(added_second.is_empty(), "an already-pooled path is skipped");
        assert_eq!(manifest.media.len(), 1);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn add_media_probes_a_real_clip() {
        // needs ffmpeg to synthesise a probe-able clip; skip cleanly without it.
        let Some(clip) = make_test_clip("media_probe", 320, 240, "30") else {
            eprintln!("skip: ffmpeg not on PATH");
            return;
        };
        let root = tmp("add_media_real");
        let (_dir, mut manifest) = new_project_in(&root, "media-real", &[]).unwrap();
        let path = clip.to_string_lossy().to_string();
        let added = add_media(&mut manifest, &[path.clone()]);
        assert_eq!(added.len(), 1);
        let info = added[0].video.as_ref().expect("a real clip probes video info");
        assert_eq!(info.width, 320);
        assert_eq!(info.height, 240);
        assert_eq!(info.fps, 30.0);
        assert_eq!(added[0].name, clip.file_name().unwrap().to_string_lossy());

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_file(&clip);
    }

    #[test]
    fn media_item_dto_flags_offline_live() {
        let root = tmp("media_offline_dto");
        let present = root.join("present.mov");
        std::fs::write(&present, b"not really a video").unwrap();
        let missing = root.join("gone.mov");

        let online = MediaItem {
            id: "a".into(),
            source_path: present.to_string_lossy().to_string(),
            name: "present.mov".into(),
            added: now_rfc3339(),
            video: None,
        };
        let offline = MediaItem {
            id: "b".into(),
            source_path: missing.to_string_lossy().to_string(),
            name: "gone.mov".into(),
            added: now_rfc3339(),
            video: None,
        };
        assert!(!MediaItemDto::from(&online).offline);
        assert!(MediaItemDto::from(&offline).offline, "a missing path is offline, not an error");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn manifest_media_round_trips_and_legacy_project_still_loads() {
        // D-044: `media` round-trips through save/load...
        let root = tmp("media_roundtrip");
        let (dir, mut manifest) = new_project_in(&root, "media-roundtrip", &[]).unwrap();
        add_media(&mut manifest, &[root.join("a.mov").to_string_lossy().to_string()]);
        save_manifest(&dir, &manifest).unwrap();
        let reloaded = load_manifest(&dir).unwrap();
        assert_eq!(reloaded.media.len(), 1);
        assert_eq!(reloaded.media[0].source_path, manifest.media[0].source_path);

        // ...and a pre-D-044 project.json with no `media` key at all (the real
        // shape on disk before this change, e.g. `~/Movies/Chroma/*.chroma`)
        // still loads, with an empty pool.
        let legacy = root.join("legacy.chroma");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(
            legacy.join("project.json"),
            r#"{"schema":"chroma.project/1","name":"legacy","shots":[{"id":"s1","sourcePath":"/a.mov"}],"activeShot":0,"settings":{}}"#,
        )
        .unwrap();
        let m = load_manifest(&legacy).unwrap();
        assert!(m.media.is_empty(), "an absent `media` key loads as an empty pool");
        assert_eq!(m.shots.len(), 1, "pre-existing `shots` are untouched");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn project_ref_set_and_clear() {
        let mine = ProjectRef {
            path: PathBuf::from("/tmp/project-ref-test-unique.chroma"),
            name: "project-ref-test-unique".into(),
        };
        state::set_project(Some(mine.clone()));
        let got = state::current_project().unwrap();
        assert_eq!(got.path, mine.path);
        assert_eq!(got.name, "project-ref-test-unique");
        state::set_project(None);
        // another parallel test may have set its own project; just assert ours
        // is not still the active one
        assert!(state::current_project().map(|p| p.path) != Some(mine.path));
    }
}


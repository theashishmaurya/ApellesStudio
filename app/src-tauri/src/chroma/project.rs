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
//!
//! **Bins + multiple timelines (D-045, pass 2):** [`MediaItem::folder`] files
//! a pool item into a bin — a plain path string ("B-roll/Sunset"), created
//! implicitly the first time an item lands there, same no-entity convention
//! Palmier Pro's MCP folders use. [`ProjectManifest::timeline`] (D-041,
//! singular) became [`ProjectManifest::timelines`] + `active_timeline`
//! (D-045) — multiple independently-editable named timelines, one active,
//! migrated losslessly from the old singular key by [`load_manifest`]. Still
//! no bin-tree UI, no timeline-switcher UI, and `shots`/`media` are still
//! unified — pass 3.
//!
//! **`shots`/`media` unification (D-046, pass 3):** [`ProjectShot`] no longer
//! duplicates `source_path`/`name` — it holds a [`MediaItem::id`] reference
//! (`media_id`) instead, so the pool is the single source of truth for what a
//! shot's path/name/probed-facts actually are. [`resolve_shot`] does the
//! lookup (with a graceful "dangling reference" fallback — see its doc);
//! [`find_or_create_media`] is the one choke point that attaches a shot to
//! the pool (`new_project_in`, `chroma_project_save`, `chroma_project_relink`
//! all go through it rather than duplicating the find-or-create). A brand new
//! [`chroma_project_add_shot`] command is the Sources panel's explicit
//! "add to grading" action on an existing pool item. [`load_manifest`]
//! losslessly migrates a legacy `shot.sourcePath`/`shot.name` shape (every
//! `project.json` before this decision) into a pool entry + `mediaId`, the
//! same raw-JSON-before-typed-deserialize move [`migrate_legacy_timeline`]
//! already made for timelines — see [`migrate_legacy_shots`] and the D-046
//! decision for why the wire-level DTOs (`ProjectShotDto`, `ProjectShotInput`,
//! `ProjectOpenDto`) didn't need to change shape at all, keeping this pass's
//! frontend cost to just the new UI rather than a `useSessionStore` rewrite.
//!
//! **Multi-track NLE, Phase A (D-054):** `chroma_timeline::Clip` gained an
//! explicit `start_frame`. [`load_manifest`] calls
//! `Timeline::backfill_legacy_positions` on every loaded timeline (a typed
//! post-deserialize step, not a raw-JSON rewrite — see [`load_manifest`]'s
//! doc for why this migration didn't need the `migrate_legacy_*` pattern)
//! to reconstruct real positions for clips from pre-D-054 `project.json`
//! files. See the D-054 decision and `docs/notes/multi-track-nle.md`.
//!
//! **Sources panel fixes (D-056):** [`chroma_media_list`], [`chroma_media_import`],
//! and [`chroma_media_move`] are now `async fn` (B-012 — they used to be plain
//! `fn`, which Tauri runs *inline on the main UI thread*; that's fine for a
//! sub-millisecond call but stalls the native file-picker dialog behind
//! whichever one is in flight the moment "Import" is clicked). `chroma_media_import`
//! additionally moves its per-path `ffprobe` probing onto Tokio's blocking pool
//! (`spawn_blocking`), matching `chroma_frame_thumbnails`/`chroma_session_thumbnail`'s
//! existing convention for `ffmpeg`/`ffprobe` subprocess work. [`probe_media_item`]
//! also generates + caches a poster-frame thumbnail per item (reusing
//! `video::extract_thumb`, the same extractor the Colorist shot-strip uses) to
//! `<video_dir>/.chroma/thumbs/<mediaId>.jpg` — the same "cache lives beside the
//! source, keyed and referenced not copied" convention `mask.rs`/`depth.rs` use
//! for mattes/depth. [`ProjectManifest::folders`] is a small additive list of
//! explicitly-created, possibly-still-empty bin paths (new: [`chroma_media_create_folder`])
//! alongside the existing "folders are implied by items' `folder` strings" model —
//! see the D-056 decision for why a full bin-hierarchy entity wasn't needed.

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

/// A pool item currently being graded (D-046: references a [`MediaItem`] by
/// id rather than duplicating its `source_path`/`name` — see the module doc).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectShot {
    pub id: String,
    /// the pool item this shot grades — [`resolve_shot`] does the lookup.
    pub media_id: String,
    #[serde(default)]
    pub frame: u64,
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
    /// The Edit-tab timelines (D-041 singular → D-045 plural) — each an
    /// independently-editable assembly of clips; [`ProjectManifest::active_timeline`]
    /// picks which one every `chroma_timeline_*` command reads/writes. Additive
    /// and defaulted (schema major unchanged, same move D-038 made for
    /// `settings`): an absent key → an empty list, and the project behaves as
    /// it did pre-D-041. [`load_manifest`] losslessly migrates a legacy
    /// singular `timeline` key (D-041's shape) into a one-element list here —
    /// see [`migrate_legacy_timeline`] and the D-045 decision. Built +
    /// persisted lazily by `chroma::edit::chroma_timeline_get`. **Never
    /// serialize a `timeline` (singular) key again** — the struct has no such
    /// field, so a save can't reintroduce it.
    #[serde(default)]
    pub timelines: Vec<chroma_timeline::Timeline>,
    /// Index into `timelines` of the timeline every `chroma_timeline_*`
    /// command targets (D-045) — same `usize`-index convention as
    /// [`ProjectManifest::active_shot`]. Clamped into range by
    /// [`load_manifest`]; `chroma_timeline_set_active` resolves a stable
    /// timeline **id** to this index rather than taking an index directly, so
    /// the caller never has to track order.
    #[serde(default)]
    pub active_timeline: usize,
    /// The project's media pool (D-044, pass 1) — every file imported via
    /// [`chroma_media_import`], independent of `shots`/`timeline`. Additive,
    /// optional (schema major unchanged, same move as D-038/D-041): an absent
    /// `media` key → an empty pool, and the project behaves exactly as it did
    /// pre-D-044.
    #[serde(default)]
    pub media: Vec<MediaItem>,
    /// Explicitly-created bin paths (D-056), independent of whether any
    /// [`MediaItem::folder`] currently names them — the one piece of state
    /// that lets a just-created, still-empty folder show up in the Sources
    /// panel's tree (a folder implied only by items' `folder` strings, D-045's
    /// original model, disappears the moment its last item is moved out or
    /// removed; this list is what keeps a deliberately-created one around).
    /// Additive/optional, same defaulting convention as `media`/`timelines`.
    /// [`chroma_media_create_folder`] appends to it; [`chroma_media_import`]/
    /// [`chroma_media_move`] also register whatever `folder` they're given, so
    /// an implicitly-created folder (naming a not-yet-used path on import/move,
    /// D-045's original behaviour) is remembered too, not just an explicit one.
    #[serde(default)]
    pub folders: Vec<String>,
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
            timelines: Vec::new(),
            active_timeline: 0,
            media: Vec::new(),
            folders: Vec::new(),
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
    /// `chroma_types::Resolution` (D-053) via `#[serde(flatten)]` — same
    /// `width`/`height` keys `project.json` already persists, zero wire
    /// change (verified by a round-trip test, see the `project` test module).
    #[serde(flatten)]
    pub resolution: chroma_types::Resolution,
    pub fps: f64,
    pub frame_count: u64,
    pub duration_secs: f64,
}

impl From<&video::VideoInfo> for MediaVideoInfo {
    fn from(info: &video::VideoInfo) -> Self {
        MediaVideoInfo {
            resolution: info.resolution,
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
    /// The bin this item is filed in (D-045 pass 2) — a plain path string
    /// ("B-roll/Sunset"), `None`/empty = the pool root. No separate bin
    /// entity: a folder exists exactly when some item's `folder` names it,
    /// same convention Palmier Pro's MCP folders use. Set at import time
    /// (`chroma_media_import`'s optional `folder` arg) or later via
    /// `chroma_media_move`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
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
    /// the bin path this item is filed in; `None` = pool root (D-045)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    /// `data:image/jpeg;base64,…` poster-frame thumbnail (D-056), read live
    /// from `<video_dir>/.chroma/thumbs/<id>.jpg` — same "computed live, not
    /// stored on the model" discipline `offline` uses. `None` when nothing has
    /// been cached yet (thumbnail generation failed at import time, or the
    /// item predates D-056 and hasn't been re-imported).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumb: Option<String>,
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
            folder: m.folder.clone(),
            thumb: read_cached_thumb(&m.source_path, &m.id),
        }
    }
}

/// Trim `folder` and turn an empty/blank string into the pool-root `None` —
/// the one normalisation point for the "no separate bin entity" model, used
/// on both import and move.
fn normalize_folder(folder: Option<&str>) -> Option<String> {
    folder
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

// --------------------------------------------------------------------------- //
// media thumbnails (D-056/B-012) — a poster-frame JPEG per MediaItem, cached
// beside the source video, same `<video_dir>/.chroma/<kind>/<key>/…` layout
// `mask.rs`'s mattes and `depth.rs`'s per-frame depth already use (keyed by
// the item's own id instead of a params hash — a media item only ever needs
// one thumbnail, not one per set of track parameters). Reuses
// `video::extract_thumb` — the same extractor the Colorist shot-strip / the
// project launcher's card thumbnail (`regen_thumb`, above) already call —
// rather than a second decode path.
// --------------------------------------------------------------------------- //

/// `None` when `source_path` has no parent directory (a bare filename) — an
/// edge case that just means "don't cache," not an error.
fn thumb_cache_path(source_path: &str, media_id: &str) -> Option<PathBuf> {
    let parent = Path::new(source_path).parent()?;
    Some(
        parent
            .join(".chroma")
            .join("thumbs")
            .join(format!("{media_id}.jpg")),
    )
}

/// Extract a mid-clip frame (not frame 0 — often a black/fade-in frame) via
/// `video::extract_thumb`, decode its data-URL payload back to raw bytes (same
/// `rsplit_once(',')` + base64-decode `regen_thumb` uses), and cache it.
/// Best-effort: a probe/decode failure just leaves the item without a cached
/// thumbnail, same "offline is flagged, not fatal" discipline as the rest of
/// this module — the Sources panel falls back to its placeholder icon.
fn generate_media_thumb(source_path: &str, info: &video::VideoInfo, media_id: &str) {
    let Some(cache_path) = thumb_cache_path(source_path, media_id) else {
        return;
    };
    let frame = info.frame_count / 2;
    match video::extract_thumb(Path::new(source_path), info, frame, 150) {
        Ok(data_url) => {
            let b64 = data_url
                .rsplit_once(',')
                .map(|(_, b)| b)
                .unwrap_or(&data_url);
            match base64::engine::general_purpose::STANDARD.decode(b64.trim()) {
                Ok(bytes) => {
                    if let Some(dir) = cache_path.parent() {
                        let _ = std::fs::create_dir_all(dir);
                    }
                    if let Err(e) = std::fs::write(&cache_path, bytes) {
                        log::warn!("[chroma::project] writing media thumb for {source_path}: {e}");
                    }
                }
                Err(e) => {
                    log::warn!("[chroma::project] decoding media thumb for {source_path}: {e}")
                }
            }
        }
        Err(e) => {
            log::warn!("[chroma::project] media thumb generation failed for {source_path}: {e}")
        }
    }
}

/// Read `<video_dir>/.chroma/thumbs/<id>.jpg` back as a `data:` URL, if cached.
fn read_cached_thumb(source_path: &str, media_id: &str) -> Option<String> {
    let path = thumb_cache_path(source_path, media_id)?;
    let bytes = std::fs::read(path).ok()?;
    Some(format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

/// Probe `path` and build a [`MediaItem`] for it, filed into `folder` (a bin
/// path, created implicitly by being named here — D-045). Never fails
/// outright — a probe failure (offline / not decodable) just leaves
/// `video: None` and no cached thumbnail.
fn probe_media_item(path: &str, folder: Option<&str>) -> MediaItem {
    let name = Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string());
    let id = uuid::Uuid::new_v4().to_string();
    let probed = media_item_is_online(path)
        .then(|| video::probe(Path::new(path)).ok())
        .flatten();
    if let Some(info) = &probed {
        generate_media_thumb(path, info, &id);
    }
    let video = probed.as_ref().map(MediaVideoInfo::from);
    MediaItem {
        id,
        source_path: path.to_string(),
        name,
        added: now_rfc3339(),
        video,
        folder: normalize_folder(folder),
    }
}

/// Probe + append the entries of `paths` not already in `manifest.media`
/// (matched by source path — re-importing the same file is a no-op, not a
/// duplicate, regardless of `folder`; use `chroma_media_move` to re-file an
/// existing item) and return just the items that were added, all filed into
/// `folder`. Pure model logic — no persistence; callers `save_manifest`
/// themselves.
fn add_media(
    manifest: &mut ProjectManifest,
    paths: &[String],
    folder: Option<&str>,
) -> Vec<MediaItem> {
    let existing: std::collections::HashSet<&str> = manifest
        .media
        .iter()
        .map(|m| m.source_path.as_str())
        .collect();
    let added: Vec<MediaItem> = paths
        .iter()
        .filter(|p| !existing.contains(p.as_str()))
        .map(|p| probe_media_item(p, folder))
        .collect();
    manifest.media.extend(added.iter().cloned());
    if !added.is_empty() {
        register_folder(manifest, folder);
    }
    added
}

/// Add `folder` to [`ProjectManifest::folders`] if it isn't already known
/// (dedup — `manifest.folders` is a set in spirit, a `Vec` on the wire for a
/// stable/simple JSON shape). A no-op for `None`/blank (the pool root isn't a
/// folder). Shared by [`add_media`]/[`chroma_media_move`] (which register a
/// folder implicitly, D-045's original behaviour) and
/// [`chroma_media_create_folder`] (which registers one explicitly, D-056).
fn register_folder(manifest: &mut ProjectManifest, folder: Option<&str>) {
    let Some(f) = normalize_folder(folder) else {
        return;
    };
    if !manifest.folders.iter().any(|existing| existing == &f) {
        manifest.folders.push(f);
    }
}

// --------------------------------------------------------------------------- //
// shots/media unification (D-046) — a ProjectShot references a MediaItem by
// id; these are the choke points every shot-constructing/-reading path goes
// through instead of duplicating the find-or-create / resolve logic.
// --------------------------------------------------------------------------- //

impl ProjectManifest {
    /// Look up a pool item by id.
    pub fn media_for(&self, media_id: &str) -> Option<&MediaItem> {
        self.media.iter().find(|m| m.id == media_id)
    }
}

/// Resolve a shot's display `(source_path, name)` via its `media_id`. A shot
/// whose media item no longer exists in the pool — a **dangling
/// reference** (the item was removed after the shot was created; there is no
/// `chroma_media_remove` command yet, but a hand-edited or future-removed
/// pool can produce this) — resolves to `("", "(missing media)")` rather than
/// erroring, the same "offline is flagged, not fatal" discipline the rest of
/// this module uses; callers treat an empty `source_path` as offline.
pub fn resolve_shot(manifest: &ProjectManifest, shot: &ProjectShot) -> (String, String) {
    match manifest.media_for(&shot.media_id) {
        Some(m) => (m.source_path.clone(), m.name.clone()),
        None => (String::new(), "(missing media)".to_string()),
    }
}

/// Find an existing pool item by `source_path`, or probe + create one (filed
/// at the pool root) named `name_hint` (falls back to the file name) — the
/// single choke point through which a shot gets attached to the pool.
/// `new_project_in`, `chroma_project_save`, and `chroma_project_relink` all
/// go through this rather than duplicating find-or-create. Returns the
/// item's id either way.
fn find_or_create_media(
    manifest: &mut ProjectManifest,
    source_path: &str,
    name_hint: Option<&str>,
) -> String {
    if let Some(existing) = manifest.media.iter().find(|m| m.source_path == source_path) {
        return existing.id.clone();
    }
    let mut item = probe_media_item(source_path, None);
    if let Some(n) = name_hint.map(str::trim).filter(|s| !s.is_empty()) {
        item.name = n.to_string();
    }
    let id = item.id.clone();
    manifest.media.push(item);
    id
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
    std::fs::write(
        &cp,
        format!("{}\n", serde_json::to_string_pretty(&v).unwrap()),
    )
    .map_err(|e| format!("write {}: {e}", cp.display()))
}

// --------------------------------------------------------------------------- //
// load / save the manifest (pure fs + json)
// --------------------------------------------------------------------------- //

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// D-045: pre-migration `project.json` carried a singular `timeline: Timeline
/// | null` field (D-041). Migrate the **raw** JSON, before typed deserialize,
/// into `timelines: [Timeline]` — losslessly (every existing field kept) and
/// backfilling a fresh id (the legacy shape never had one — see
/// `chroma_timeline::Timeline::id`'s doc). A project saved after this change
/// never round-trips the old key again: `ProjectManifest` has no `timeline`
/// field left to serialize. Safe to call on an already-migrated (or fresh)
/// manifest — a present `timelines` key is left untouched (a stray legacy
/// `timeline` key alongside it, which a hand-edited file could in principle
/// have, is just dropped rather than guessed at).
fn migrate_legacy_timeline(raw: &mut Value) {
    let Some(obj) = raw.as_object_mut() else {
        return;
    };
    if obj.contains_key("timelines") {
        obj.remove("timeline");
        return;
    }
    let Some(mut legacy) = obj.remove("timeline") else {
        return;
    };
    if legacy.is_null() {
        return;
    }
    if let Some(tl_obj) = legacy.as_object_mut() {
        let has_id = tl_obj
            .get("id")
            .and_then(|v| v.as_str())
            .is_some_and(|s| !s.is_empty());
        if !has_id {
            tl_obj.insert(
                "id".to_string(),
                Value::String(uuid::Uuid::new_v4().to_string()),
            );
        }
    }
    obj.insert("timelines".to_string(), Value::Array(vec![legacy]));
}

/// D-046: pre-migration `project.json` shots carried `sourcePath`/`name`
/// directly (D-037) — the shot *was* the media reference, with no pool at
/// all. Migrate the **raw** JSON, before typed deserialize: every shot
/// lacking a (non-empty) `mediaId` gets one, pointing at a `media` entry with
/// that `sourcePath` — reusing one already in the pool with the same path
/// (matched by string, same dedup rule [`add_media`] uses) or synthesizing a
/// fresh one (unprobed — `MediaItem::video` stays `None` until the next
/// `chroma_media_list`/import re-checks it; cheap and correct, no need to
/// shell out to ffprobe during every project load). Safe to call on an
/// already-migrated (or fresh) manifest: a shot that already carries a
/// non-empty `mediaId` is left untouched, and a project with no `shots` at
/// all is a no-op.
fn migrate_legacy_shots(raw: &mut Value) {
    let Some(obj) = raw.as_object_mut() else {
        return;
    };
    let Some(Value::Array(shots)) = obj.get("shots").cloned() else {
        return;
    };
    if shots.is_empty() {
        return;
    }

    // Owned copy of `media` to mutate alongside `shots` — can't hold two
    // mutable borrows into `obj` at once.
    let mut media = match obj.remove("media") {
        Some(Value::Array(a)) => a,
        _ => Vec::new(),
    };

    let mut new_shots = Vec::with_capacity(shots.len());
    for shot in shots {
        let Value::Object(mut shot_obj) = shot else {
            new_shots.push(shot);
            continue;
        };
        let has_media_id = shot_obj
            .get("mediaId")
            .and_then(|v| v.as_str())
            .is_some_and(|s| !s.is_empty());
        if !has_media_id {
            let source_path = shot_obj
                .get("sourcePath")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let name = shot_obj
                .get("name")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let existing_id = media.iter().find_map(|m| {
                let o = m.as_object()?;
                if o.get("sourcePath").and_then(|v| v.as_str()) == Some(source_path.as_str()) {
                    o.get("id").and_then(|v| v.as_str()).map(|s| s.to_string())
                } else {
                    None
                }
            });
            let media_id = existing_id.unwrap_or_else(|| {
                let id = uuid::Uuid::new_v4().to_string();
                let item_name = name.clone().unwrap_or_else(|| {
                    Path::new(&source_path)
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| source_path.clone())
                });
                media.push(serde_json::json!({
                    "id": id,
                    "sourcePath": source_path,
                    "name": item_name,
                    "added": now_rfc3339(),
                }));
                id
            });
            shot_obj.insert("mediaId".to_string(), Value::String(media_id));
        }
        new_shots.push(Value::Object(shot_obj));
    }
    obj.insert("media".to_string(), Value::Array(media));
    obj.insert("shots".to_string(), Value::Array(new_shots));
}

/// Read + parse `<project_dir>/project.json`, gate the schema major, migrate
/// a legacy singular `timeline` key (D-045) and legacy `shot.sourcePath`/
/// `shot.name` into pool references (D-046), backfill legacy clip positions
/// (D-054 — see below), and clamp `active_shot` / `active_timeline` into
/// range. Untagged files are treated as v1.
///
/// **D-054's clip-position migration** doesn't need a raw-JSON rewrite like
/// `migrate_legacy_timeline`/`migrate_legacy_shots` — `Clip::start_frame`'s
/// `#[serde(default = ...)]` already gets every legacy clip to a typed,
/// detectable sentinel on its own. What's left, and what genuinely can't be
/// a plain per-field default, is *reconstructing the right value* (the old
/// implicit back-to-back position, not `0` for every clip) — that's
/// `Timeline::backfill_legacy_positions`, called here once per timeline,
/// right after the typed deserialize.
pub fn load_manifest(project_dir: &Path) -> Result<ProjectManifest, String> {
    let mp = project_dir.join("project.json");
    let txt = std::fs::read_to_string(&mp).map_err(|e| format!("read {}: {e}", mp.display()))?;
    let mut raw: Value =
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

    migrate_legacy_timeline(&mut raw);
    migrate_legacy_shots(&mut raw);

    let mut manifest: ProjectManifest =
        serde_json::from_value(raw).map_err(|e| format!("project.json shape: {e}"))?;
    if manifest.schema.is_empty() {
        manifest.schema = SCHEMA.to_string();
    }
    if !manifest.shots.is_empty() && manifest.active_shot >= manifest.shots.len() {
        manifest.active_shot = 0;
    }
    if !manifest.timelines.is_empty() && manifest.active_timeline >= manifest.timelines.len() {
        manifest.active_timeline = 0;
    }
    for tl in &mut manifest.timelines {
        tl.backfill_legacy_positions();
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
    if info.resolution.width > 0 && info.resolution.height > 0 {
        s.width = Some(info.resolution.width);
        s.height = Some(info.resolution.height);
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
    // D-046: every seed path lands in the pool first (find-or-create, probed),
    // then a shot referencing it — this is the "add to grading" flow's entry
    // point, same choke point `chroma_project_save`/`_relink` use.
    for p in media_paths {
        let media_id = find_or_create_media(&mut manifest, p, None);
        manifest.shots.push(ProjectShot {
            id: uuid::Uuid::new_v4().to_string(),
            media_id,
            frame: 0,
        });
    }

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
        let (source_path, name) = resolve_shot(&manifest, shot);
        let online = !source_path.is_empty() && media_item_is_online(&source_path);

        if online {
            let src = PathBuf::from(&source_path);
            match load::load_video_frame(&src, &source_path, shot.frame, state).await {
                Ok(_) => online_paths.push(src),
                Err(e) => {
                    log::warn!("[chroma::project] shot {source_path} failed to load: {e}");
                    dtos.push(ProjectShotDto {
                        id: shot.id.clone(),
                        source_path,
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
            source_path,
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
            .map(|s| PathBuf::from(resolve_shot(&manifest, s).0));
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
            let b64 = data_url
                .rsplit_once(',')
                .map(|(_, b)| b)
                .unwrap_or(&data_url);
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
    // D-046: the wire shape (`ProjectShotInput`) is unchanged — still
    // id/sourcePath/frame/name — so the frontend session store didn't need to
    // change for this pass. Each incoming shot resolves (find-or-create) a
    // pool item via `find_or_create_media` before becoming a `ProjectShot`.
    let mut new_shots = Vec::with_capacity(shots.len());
    for s in shots {
        let media_id = find_or_create_media(&mut manifest, &s.source_path, s.name.as_deref());
        new_shots.push(ProjectShot {
            id: s.id,
            media_id,
            frame: s.frame,
        });
    }
    manifest.shots = new_shots;
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
    state::current_project()
        .map(|p| serde_json::json!({ "name": p.name, "path": p.path.to_string_lossy() }))
}

/// Re-point one shot at a new source path and reopen the project. D-046:
/// updates the shot's underlying pool item in place (so any other shot/timeline
/// clip sharing that `media_id` re-points too, by design — a relink is "this
/// same logical media now lives here"); if the shot's `media_id` is dangling
/// (its pool item was removed), find-or-creates one at `new_path` instead and
/// repoints the shot to it.
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
    let media_id = manifest
        .shots
        .iter()
        .find(|s| s.id == shot_id)
        .ok_or_else(|| format!("shot {shot_id} is not in this project"))?
        .media_id
        .clone();

    match manifest.media.iter_mut().find(|m| m.id == media_id) {
        Some(m) => {
            m.source_path = new_path.clone();
            m.name = Path::new(&new_path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| new_path.clone());
            m.video = media_item_is_online(&new_path)
                .then(|| video::probe(Path::new(&new_path)).ok())
                .flatten()
                .as_ref()
                .map(MediaVideoInfo::from);
        }
        None => {
            let new_media_id = find_or_create_media(&mut manifest, &new_path, None);
            if let Some(s) = manifest.shots.iter_mut().find(|s| s.id == shot_id) {
                s.media_id = new_media_id;
            }
        }
    }
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
/// place, never copied), filed into `folder` (D-045 — a bin path such as
/// `"B-roll/Sunset"`, created implicitly; `None`/omitted = the pool root),
/// persist, and return just the newly-added items — a path already in the
/// pool is skipped, not duplicated (its folder is untouched even if a
/// different `folder` was passed this time; use `chroma_media_move` to
/// re-file it). The frontend wires this to a native multi-select file dialog
/// (`@tauri-apps/plugin-dialog`'s `open({ multiple: true })`, same pattern as
/// the project launcher's `pickClips`).
///
/// **`async` + `spawn_blocking` (D-056/B-012).** Probing each path shells out
/// to `ffprobe` (`video::probe`) and now also `ffmpeg` for a thumbnail
/// (`generate_media_thumb`) — real, potentially slow (many files, a network
/// or spinning-disk source) blocking work. A plain (non-`async`) `#[tauri::command]`
/// runs *inline on the main UI thread* (confirmed against `tauri-macros`'
/// `ExecutionContext::Blocking` — the default for a non-`async fn` — which
/// calls the command body directly rather than dispatching it through
/// `respond_async_serialized`/the async runtime); an `async fn` command does
/// not. Wrapping the actual probing in `spawn_blocking` additionally keeps it
/// off the async-runtime's own worker threads (same convention
/// `chroma_frame_thumbnails`/`chroma_session_thumbnail` already use for their
/// `ffmpeg` calls) rather than just moving the blocking off the main thread
/// and onto a runtime thread that other `async fn` commands share.
#[tauri::command]
pub async fn chroma_media_import(
    paths: Vec<String>,
    folder: Option<String>,
) -> Result<Vec<MediaItemDto>, String> {
    if paths.is_empty() {
        return Err("no paths given".into());
    }
    let dir = require_open_project()?;
    let added = tokio::task::spawn_blocking(move || -> Result<Vec<MediaItem>, String> {
        let mut manifest = load_manifest(&dir)?;
        let added = add_media(&mut manifest, &paths, folder.as_deref());
        if !added.is_empty() {
            manifest.modified = now_rfc3339();
            save_manifest(&dir, &manifest)?;
        }
        Ok(added)
    })
    .await
    .map_err(|e| format!("import task panicked: {e}"))??;
    Ok(added.iter().map(MediaItemDto::from).collect())
}

/// Re-file an existing pool item into a different bin path (D-045) — pass
/// `folder: None` (or an empty/blank string) to move it back to the pool
/// root. Naming a not-yet-used path here creates/registers it implicitly,
/// same as `chroma_media_import`'s `folder` arg (D-056: registers into
/// [`ProjectManifest::folders`] too, not just the item's own `folder`).
/// `async` (D-056/B-012) — see [`chroma_media_import`]'s doc for why a
/// manifest-touching command must not be a plain blocking `fn`.
#[tauri::command]
pub async fn chroma_media_move(id: String, folder: Option<String>) -> Result<MediaItemDto, String> {
    let dir = require_open_project()?;
    let mut manifest = load_manifest(&dir)?;
    let item = manifest
        .media
        .iter_mut()
        .find(|m| m.id == id)
        .ok_or_else(|| format!("no media item with id {id}"))?;
    item.folder = normalize_folder(folder.as_deref());
    register_folder(&mut manifest, folder.as_deref());
    let dto = manifest
        .media
        .iter()
        .find(|m| m.id == id)
        .map(MediaItemDto::from)
        .expect("just looked this item up above");
    manifest.modified = now_rfc3339();
    save_manifest(&dir, &manifest)?;
    Ok(dto)
}

/// Register a new, possibly-still-empty bin path (D-056) — the Sources
/// panel's explicit "New Folder" action. Idempotent (creating an
/// already-known folder is a no-op, not an error) and does not require the
/// folder to hold any items, unlike D-045's original "folders are implied by
/// items' `folder` strings" model (see the D-056 decision for why this small
/// additive list, not a full bin-hierarchy entity, was the right amount of
/// complexity). Returns the full, deduped, sorted folder list — union of
/// `manifest.folders` and every item's `folder` — so the frontend can just
/// replace its tree state, same "return the fresh state" convention
/// `chroma_media_import`/`_move` use.
#[tauri::command]
pub async fn chroma_media_create_folder(path: String) -> Result<Vec<String>, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("folder name is empty".into());
    }
    let dir = require_open_project()?;
    let mut manifest = load_manifest(&dir)?;
    register_folder(&mut manifest, Some(trimmed));
    manifest.modified = now_rfc3339();
    save_manifest(&dir, &manifest)?;
    Ok(all_folders(&manifest))
}

/// Union of [`ProjectManifest::folders`] and every media item's `folder`,
/// deduped + sorted — what the Sources panel's bin tree is actually built
/// from (D-056; items alone were D-045's whole story).
fn all_folders(manifest: &ProjectManifest) -> Vec<String> {
    let mut set: std::collections::BTreeSet<String> = manifest.folders.iter().cloned().collect();
    set.extend(manifest.media.iter().filter_map(|m| m.folder.clone()));
    set.into_iter().collect()
}

/// The open project's known bin paths (D-056) — see [`all_folders`]. A
/// separate command rather than folding into [`chroma_media_list`]'s response
/// so that DTO's wire shape stays untouched (same reasoning D-046 gave for
/// keeping `ProjectShotDto` stable through the shots/media unification).
#[tauri::command]
pub async fn chroma_media_folders() -> Result<Vec<String>, String> {
    let dir = require_open_project()?;
    let manifest = load_manifest(&dir)?;
    Ok(all_folders(&manifest))
}

/// The open project's full media pool, offline-checked live. Each item
/// carries its `folder` (D-045) and cached `thumb` if one exists (D-056); the
/// frontend derives the bin tree from the flat list of folder path strings
/// plus [`chroma_media_folders`] — no separate bin-hierarchy API. `async`
/// (D-056/B-012) — see [`chroma_media_import`]'s doc.
#[tauri::command]
pub async fn chroma_media_list() -> Result<Vec<MediaItemDto>, String> {
    let dir = require_open_project()?;
    let manifest = load_manifest(&dir)?;
    Ok(manifest.media.iter().map(MediaItemDto::from).collect())
}

/// Pure model half of [`chroma_project_add_shot`] — push a new shot
/// referencing `media_id` and make it active, or error if the id isn't in
/// the pool. Split out so it's testable without a `tauri::State` (no other
/// test in this module drives the state-taking commands directly — see
/// `open_manifest`'s callers — this keeps that convention).
fn add_shot_for_media(manifest: &mut ProjectManifest, media_id: &str) -> Result<(), String> {
    if manifest.media_for(media_id).is_none() {
        return Err(format!("no media item with id {media_id}"));
    }
    manifest.shots.push(ProjectShot {
        id: uuid::Uuid::new_v4().to_string(),
        media_id: media_id.to_string(),
        frame: 0,
    });
    manifest.active_shot = manifest.shots.len() - 1;
    Ok(())
}

/// Create a graded shot referencing an existing pool item (D-046) — the
/// Sources panel's explicit "add to grading" action, distinct from a plain
/// `chroma_media_import` (pool-only, no shot). Errors if `media_id` isn't in
/// the pool. The new shot becomes active; returns the same `ProjectOpenDto`
/// shape `chroma_project_open`/`_new`/`_relink` do, so the frontend hydrates
/// it through the exact same `_hydrateOpenDto` path.
#[tauri::command]
pub async fn chroma_project_add_shot(
    media_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<ProjectOpenDto, String> {
    let dir = require_open_project()?;
    let mut manifest = load_manifest(&dir)?;
    add_shot_for_media(&mut manifest, &media_id)?;
    manifest.modified = now_rfc3339();
    save_manifest(&dir, &manifest)?;
    open_manifest(dir, manifest, &state).await
}

// --------------------------------------------------------------------------- //
// tests — pure model (no decode, no tauri State)
// --------------------------------------------------------------------------- //

#[cfg(test)]
mod tests {
    use super::*;

    /// `state::set_project` is process-global (D-033/D-037); `cargo test`
    /// runs test fns on multiple threads by default, so any test that
    /// mutates it must hold this for its whole body or it can interleave
    /// with another such test (see `project_ref_set_and_clear`'s original
    /// comment, which this formalises rather than just shrugs at).
    static PROJECT_STATE_LOCK: once_cell::sync::Lazy<std::sync::Mutex<()>> =
        once_cell::sync::Lazy::new(|| std::sync::Mutex::new(()));

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
        assert_eq!(resolve_shot(&manifest, &manifest.shots[0]).1, "a.mov");

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
        assert_eq!(
            resolve_shot(&reloaded, &reloaded.shots[0]).0,
            "/shoot/A001.mov"
        );
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
        std::fs::write(
            a.join("project.json"),
            r#"{"name":"a","shots":[],"settings":{}}"#,
        )
        .unwrap();
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
        s.merge_patch(
            &serde_json::json!({ "width": null, "height": null, "color_space": null, "fps": 0 }),
        );
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
        assert_eq!(
            manifest.settings.color_space, None,
            "color space is not inferred"
        );

        // and it persisted
        let reloaded = load_manifest(&dir).unwrap();
        assert_eq!(reloaded.settings.width, Some(176));
        assert_eq!(reloaded.settings.fps, Some(25.0));

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_file(&clip);
    }

    /// synthesise a tiny `testsrc` clip with ffmpeg; `None` if ffmpeg is absent.
    fn make_test_clip(tag: &str, w: u32, h: u32, rate: &str) -> Option<PathBuf> {
        let out =
            std::env::temp_dir().join(format!("chroma_infer_{tag}_{}.mp4", std::process::id()));
        let _ = std::fs::remove_file(&out);
        let status = std::process::Command::new("ffmpeg")
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
            ])
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

        // extension is a real video ext + the file exists -> "online" by the
        // cheap check (probe/decode failure is handled at open time, not here)
        assert!(media_item_is_online(&present.to_string_lossy()));
        assert!(
            !media_item_is_online(&missing.to_string_lossy()),
            "a missing path is offline, not an error"
        );
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
        let added_first = add_media(&mut manifest, &[missing.clone()], None);
        assert_eq!(added_first.len(), 1, "a new path is added");
        assert_eq!(manifest.media.len(), 1);
        assert_eq!(manifest.media[0].source_path, missing);
        assert!(
            manifest.media[0].video.is_none(),
            "an offline path probes to no video info"
        );
        assert!(!manifest.media[0].id.is_empty());
        assert_eq!(
            manifest.media[0].folder, None,
            "no folder given -> pool root"
        );

        // re-importing the same path is a no-op, not a duplicate
        let added_second = add_media(&mut manifest, &[missing.clone()], None);
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
        let added = add_media(&mut manifest, &[path.clone()], None);
        assert_eq!(added.len(), 1);
        let info = added[0]
            .video
            .as_ref()
            .expect("a real clip probes video info");
        assert_eq!(info.resolution.width, 320);
        assert_eq!(info.resolution.height, 240);
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
            folder: None,
        };
        let offline = MediaItem {
            id: "b".into(),
            source_path: missing.to_string_lossy().to_string(),
            name: "gone.mov".into(),
            added: now_rfc3339(),
            video: None,
            folder: Some("B-roll/Sunset".into()),
        };
        assert!(!MediaItemDto::from(&online).offline);
        assert!(
            MediaItemDto::from(&offline).offline,
            "a missing path is offline, not an error"
        );
        assert_eq!(MediaItemDto::from(&online).folder, None);
        assert_eq!(
            MediaItemDto::from(&offline).folder.as_deref(),
            Some("B-roll/Sunset")
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn manifest_media_round_trips_and_legacy_project_still_loads() {
        // D-044: `media` round-trips through save/load...
        let root = tmp("media_roundtrip");
        let (dir, mut manifest) = new_project_in(&root, "media-roundtrip", &[]).unwrap();
        add_media(
            &mut manifest,
            &[root.join("a.mov").to_string_lossy().to_string()],
            None,
        );
        save_manifest(&dir, &manifest).unwrap();
        let reloaded = load_manifest(&dir).unwrap();
        assert_eq!(reloaded.media.len(), 1);
        assert_eq!(reloaded.media[0].source_path, manifest.media[0].source_path);

        // ...and a pre-D-044 project.json with no `media` key and no shots at
        // all still loads, with an empty pool (an absent `shots` key is a
        // no-op for `migrate_legacy_shots` too — nothing to backfill).
        let legacy = root.join("legacy.chroma");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(
            legacy.join("project.json"),
            r#"{"schema":"chroma.project/1","name":"legacy","shots":[],"activeShot":0,"settings":{}}"#,
        )
        .unwrap();
        let m = load_manifest(&legacy).unwrap();
        assert!(
            m.media.is_empty(),
            "an absent `media` key with no shots loads as an empty pool"
        );
        assert!(m.shots.is_empty());

        // a pre-D-044 project.json *with* a shot but no `media` key (the real
        // shape every `~/Movies/Chroma/*.chroma` had before D-046 — see
        // `legacy_shot_shape_migrates_to_media_id_and_backfills_the_pool` for
        // the full migration behaviour) backfills a pool entry for it rather
        // than staying empty — that's the D-046 unification, not a regression
        // of this D-044-era expectation.
        let legacy2 = root.join("legacy2.chroma");
        std::fs::create_dir_all(&legacy2).unwrap();
        std::fs::write(
            legacy2.join("project.json"),
            r#"{"schema":"chroma.project/1","name":"legacy2","shots":[{"id":"s1","sourcePath":"/a.mov"}],"activeShot":0,"settings":{}}"#,
        )
        .unwrap();
        let m2 = load_manifest(&legacy2).unwrap();
        assert_eq!(
            m2.shots.len(),
            1,
            "pre-existing shots are untouched in count/order"
        );
        assert_eq!(
            m2.media.len(),
            1,
            "D-046: the shot's path is backfilled into the pool"
        );
        assert_eq!(resolve_shot(&m2, &m2.shots[0]).0, "/a.mov");

        let _ = std::fs::remove_dir_all(&root);
    }

    // --- bins / folders (D-045) --------------------------------------------

    #[test]
    fn add_media_files_new_items_into_the_given_folder() {
        let root = tmp("media_folder_import");
        let (_dir, mut manifest) = new_project_in(&root, "media-folder", &[]).unwrap();

        let a = root.join("a.mov").to_string_lossy().to_string();
        let added = add_media(
            &mut manifest,
            std::slice::from_ref(&a),
            Some("B-roll/Sunset"),
        );
        assert_eq!(added[0].folder.as_deref(), Some("B-roll/Sunset"));
        assert_eq!(manifest.media[0].folder.as_deref(), Some("B-roll/Sunset"));

        // blank/whitespace folder normalises to the pool root, not a literal
        // empty-string bin
        let b = root.join("b.mov").to_string_lossy().to_string();
        add_media(&mut manifest, &[b], Some("   "));
        assert_eq!(manifest.media[1].folder, None);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn media_move_refiles_an_existing_item() {
        let _guard = PROJECT_STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let root = tmp("media_move");
        let (dir, mut manifest) = new_project_in(&root, "media-move", &[]).unwrap();
        let path = root.join("a.mov").to_string_lossy().to_string();
        add_media(&mut manifest, &[path], None);
        let id = manifest.media[0].id.clone();
        save_manifest(&dir, &manifest).unwrap();
        state::set_project(Some(ProjectRef {
            path: dir.clone(),
            name: "media-move".into(),
        }));

        // chroma_media_move is async (D-056/B-012); drive it on a tiny local
        // runtime, same convention `chroma_project_save_attaches_a_new_shot_to_the_pool`
        // uses for `chroma_project_save`.
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();

        let moved = rt
            .block_on(chroma_media_move(id.clone(), Some("Interviews".into())))
            .unwrap();
        assert_eq!(moved.folder.as_deref(), Some("Interviews"));
        let reloaded = load_manifest(&dir).unwrap();
        assert_eq!(reloaded.media[0].folder.as_deref(), Some("Interviews"));
        assert!(
            reloaded.folders.iter().any(|f| f == "Interviews"),
            "moving into a not-yet-known folder registers it (D-056)"
        );

        // moving back to the root clears the folder
        let back = rt.block_on(chroma_media_move(id, None)).unwrap();
        assert_eq!(back.folder, None);

        // an unknown id errors rather than silently no-op-ing
        assert!(
            rt.block_on(chroma_media_move("no-such-id".into(), Some("X".into())))
                .is_err()
        );

        state::set_project(None);
        let _ = std::fs::remove_dir_all(&root);
    }

    // --- Sources panel fixes (D-056/B-012) -----------------------------------

    #[test]
    fn chroma_media_create_folder_lists_even_with_zero_items() {
        let _guard = PROJECT_STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let root = tmp("create_folder");
        let (dir, manifest) = new_project_in(&root, "create-folder", &[]).unwrap();
        save_manifest(&dir, &manifest).unwrap();
        state::set_project(Some(ProjectRef {
            path: dir.clone(),
            name: "create-folder".into(),
        }));

        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();

        // create an empty folder — no items reference it yet
        let folders = rt
            .block_on(chroma_media_create_folder("B-roll".into()))
            .unwrap();
        assert_eq!(folders, vec!["B-roll".to_string()]);
        let listed = rt.block_on(chroma_media_folders()).unwrap();
        assert_eq!(
            listed,
            vec!["B-roll".to_string()],
            "an empty folder is listed even though nothing is filed in it"
        );

        // idempotent — creating it again is a no-op, not a duplicate/error
        let again = rt
            .block_on(chroma_media_create_folder("B-roll".into()))
            .unwrap();
        assert_eq!(again, vec!["B-roll".to_string()]);

        // blank/whitespace-only names are rejected
        assert!(
            rt.block_on(chroma_media_create_folder("   ".into()))
                .is_err()
        );

        // importing a real item into it associates it correctly, and the
        // folder is still exactly one entry (no duplicate from the item side)
        let clip = root.join("shot.mov").to_string_lossy().to_string();
        std::fs::write(root.join("shot.mov"), b"not a real video").unwrap();
        let added = rt
            .block_on(chroma_media_import(
                vec![clip.clone()],
                Some("B-roll".into()),
            ))
            .unwrap();
        assert_eq!(added.len(), 1);
        assert_eq!(added[0].folder.as_deref(), Some("B-roll"));
        let final_folders = rt.block_on(chroma_media_folders()).unwrap();
        assert_eq!(final_folders, vec!["B-roll".to_string()]);

        state::set_project(None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn media_import_generates_and_caches_a_real_thumbnail() {
        let _guard = PROJECT_STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let Some(clip) = make_test_clip("thumb", 64, 64, "10") else {
            eprintln!("skipping media_import_generates_and_caches_a_real_thumbnail: no ffmpeg");
            return;
        };
        let root = tmp("media_thumb");
        let (dir, manifest) = new_project_in(&root, "media-thumb", &[]).unwrap();
        save_manifest(&dir, &manifest).unwrap();
        state::set_project(Some(ProjectRef {
            path: dir.clone(),
            name: "media-thumb".into(),
        }));

        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let added = rt
            .block_on(chroma_media_import(
                vec![clip.to_string_lossy().to_string()],
                None,
            ))
            .unwrap();
        assert_eq!(added.len(), 1);
        let item = &added[0];
        assert!(item.video.is_some(), "a real clip probes successfully");
        let thumb = item
            .thumb
            .as_deref()
            .expect("a cached thumbnail data URL is returned for a real, probed clip");
        assert!(
            thumb.starts_with("data:image/jpeg;base64,"),
            "thumb is a JPEG data URL, got: {}",
            &thumb[..thumb.len().min(40)]
        );

        // the cache file this data URL was read from is a real, decodable
        // JPEG — not just "a file exists" (per the ask: verify the bytes).
        let cache_path = thumb_cache_path(&item.source_path, &item.id).unwrap();
        assert!(cache_path.exists(), "thumbnail cached to {cache_path:?}");
        let bytes = std::fs::read(&cache_path).unwrap();
        assert!(!bytes.is_empty());
        let decoded = image::load_from_memory_with_format(&bytes, image::ImageFormat::Jpeg)
            .expect("cached thumbnail bytes decode as a real JPEG frame");
        assert!(
            decoded.width() > 0 && decoded.height() > 0,
            "decoded thumbnail has real dimensions: {}x{}",
            decoded.width(),
            decoded.height()
        );

        // and chroma_media_list re-reads the same cached file live
        let listed = rt.block_on(chroma_media_list()).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].thumb.as_deref(), Some(thumb));

        state::set_project(None);
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_file(&clip);
        if let Some(cache_dir) = cache_path.parent() {
            let _ = std::fs::remove_dir_all(cache_dir);
        }
    }

    // --- multiple timelines (D-045) -----------------------------------------

    #[test]
    fn legacy_singular_timeline_migrates_to_a_one_element_list() {
        // The exact shape every project.json had under D-041, before D-045 —
        // including the real `~/Movies/Chroma/New.chroma/project.json` this
        // was checked against by hand.
        let root = tmp("timeline_migration");
        let dir = root.join("legacy.chroma");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("project.json"),
            r#"{"schema":"chroma.project/1","name":"New","shots":[
                {"id":"s1","sourcePath":"/a.mov","frame":0,"name":"a.mov"}],
                "activeShot":0,"settings":{},
                "timeline":{"name":"New","rate":null,"tracks":[{"kind":"video","clips":[
                    {"id":"s1","shot_id":"s1","name":"a.mov","source_path":"/a.mov",
                     "source_start":0,"duration":1078,"source_len":1078}]}]}}"#,
        )
        .unwrap();

        let m = load_manifest(&dir).unwrap();
        assert_eq!(
            m.timelines.len(),
            1,
            "the singular timeline becomes a one-element list"
        );
        assert_eq!(m.active_timeline, 0);
        let tl = &m.timelines[0];
        assert_eq!(tl.name, "New", "existing fields carry over losslessly");
        assert_eq!(tl.tracks[0].clips[0].duration, 1078);
        assert!(
            !tl.id.is_empty(),
            "a fresh id is backfilled — the legacy shape had none"
        );
        assert_eq!(
            tl.tracks[0].clips[0].start_frame, 0,
            "D-054: the clip's position (missing from this legacy shape) is \
             backfilled to 0 — the only clip on the track, so its \
             reconstructed back-to-back position is the very start"
        );

        // saving never reintroduces the old singular key
        save_manifest(&dir, &m).unwrap();
        let raw: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("project.json")).unwrap())
                .unwrap();
        assert!(
            raw.get("timeline").is_none(),
            "the legacy key is never written back"
        );
        assert!(raw.get("timelines").is_some());

        // loading the now-migrated file again is idempotent and keeps the id
        // and the D-054-backfilled position (the saved JSON now has a real
        // start_frame, so this second load doesn't touch it again).
        let reloaded = load_manifest(&dir).unwrap();
        assert_eq!(reloaded.timelines.len(), 1);
        assert_eq!(reloaded.timelines[0].id, tl.id);
        assert_eq!(reloaded.timelines[0].tracks[0].clips[0].start_frame, 0);

        let _ = std::fs::remove_dir_all(&root);
    }

    // --- multi-track NLE, Phase A: clip positions (D-054) -------------------

    /// The real `~/Movies/Chroma/New.chroma/project.json` shape (checked by
    /// hand against that file): already-migrated `timelines` (D-045 shape),
    /// one clip with no `start_frame` key at all. Loading through the real
    /// path must reconstruct the same position the pre-D-054 code rendered
    /// it at (0 — the only clip on the track).
    #[test]
    fn real_project_json_shape_backfills_clip_position() {
        let root = tmp("d054_real_shape");
        let dir = root.join("real.chroma");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("project.json"),
            r#"{"schema":"chroma.project/1","name":"New",
                "created":"2026-09-02T06:14:35.182646+00:00",
                "modified":"2026-09-02T18:59:08.794685+00:00",
                "shots":[{"id":"8022aef1-78db-491e-aeb4-03a78b785af7",
                          "mediaId":"787cf906-62ee-4a05-84cb-b4688c41aa8c","frame":0}],
                "activeShot":0,"settings":{},
                "timelines":[{"id":"abd97cef-22b4-4e5f-a7cc-ffbfa8fe39c3","name":"New","rate":null,
                    "tracks":[{"kind":"video","clips":[
                        {"id":"8022aef1-78db-491e-aeb4-03a78b785af7",
                         "shot_id":"8022aef1-78db-491e-aeb4-03a78b785af7",
                         "name":"pexels_28808272.mp4",
                         "source_path":"/Users/ashishmaurya/Downloads/pexels_28808272.mp4",
                         "source_start":0,"duration":1078,"source_len":1078}]}]}],
                "activeTimeline":0,
                "media":[{"id":"787cf906-62ee-4a05-84cb-b4688c41aa8c",
                          "sourcePath":"/Users/ashishmaurya/Downloads/pexels_28808272.mp4",
                          "name":"pexels_28808272.mp4","added":"2026-09-02T18:59:07.057154+00:00"}]}"#,
        )
        .unwrap();

        let m = load_manifest(&dir).unwrap();
        let clip = &m.timelines[0].tracks[0].clips[0];
        assert_eq!(clip.start_frame, 0, "reconstructed back-to-back position");
        assert_eq!(clip.duration, 1078);
        assert_eq!(m.timelines[0].duration(), 1078);

        // round-trips through save/reload with the real position persisted
        save_manifest(&dir, &m).unwrap();
        let raw: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("project.json")).unwrap())
                .unwrap();
        let saved_clip = &raw["timelines"][0]["tracks"][0]["clips"][0];
        assert_eq!(
            saved_clip.get("start_frame").and_then(|v| v.as_i64()),
            Some(0),
            "the migrated position is now written back explicitly"
        );
        let reloaded = load_manifest(&dir).unwrap();
        assert_eq!(reloaded.timelines[0].tracks[0].clips[0].start_frame, 0);

        let _ = std::fs::remove_dir_all(&root);
    }

    /// A legacy track with several clips (every one missing `start_frame`)
    /// reconstructs the exact back-to-back layout they rendered at before
    /// D-054 — not every clip collapsing to `0`.
    #[test]
    fn multi_clip_legacy_track_backfills_back_to_back_positions() {
        let root = tmp("d054_multi_clip");
        let dir = root.join("legacy.chroma");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("project.json"),
            r#"{"schema":"chroma.project/1","name":"multi","shots":[],"activeShot":0,"settings":{},
                "timelines":[{"id":"t1","name":"Main","rate":null,"tracks":[{"kind":"video","clips":[
                    {"id":"a","name":"A","source_path":"/a.mov","source_start":0,"duration":100,"source_len":100},
                    {"id":"b","name":"B","source_path":"/b.mov","source_start":0,"duration":50,"source_len":50},
                    {"id":"c","name":"C","source_path":"/c.mov","source_start":0,"duration":200,"source_len":200}
                ]}]}],"activeTimeline":0}"#,
        )
        .unwrap();

        let m = load_manifest(&dir).unwrap();
        let starts: Vec<i64> = m.timelines[0].tracks[0]
            .clips
            .iter()
            .map(|c| c.start_frame)
            .collect();
        assert_eq!(starts, vec![0, 100, 150]);
        assert_eq!(m.timelines[0].duration(), 350);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn absent_timeline_key_and_null_legacy_timeline_both_load_empty() {
        let root = tmp("timeline_absent");
        // no `timeline` key at all (a pre-D-041 project, or one that never
        // opened the Edit tab)
        let a = root.join("a.chroma");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::write(a.join("project.json"), r#"{"name":"a","shots":[]}"#).unwrap();
        // an explicit `"timeline": null`
        let b = root.join("b.chroma");
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(
            b.join("project.json"),
            r#"{"name":"b","shots":[],"timeline":null}"#,
        )
        .unwrap();

        for dir in [&a, &b] {
            let m = load_manifest(dir).unwrap();
            assert!(m.timelines.is_empty());
            assert_eq!(m.active_timeline, 0);
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn active_timeline_out_of_range_clamps_to_zero() {
        let root = tmp("timeline_clamp");
        let dir = root.join("x.chroma");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("project.json"),
            r#"{"name":"x","shots":[],"timelines":[{"id":"t1","name":"Main","rate":null,"tracks":[]}],"activeTimeline":9}"#,
        )
        .unwrap();
        let m = load_manifest(&dir).unwrap();
        assert_eq!(m.timelines.len(), 1);
        assert_eq!(
            m.active_timeline, 0,
            "out-of-range active_timeline clamps to 0"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn multi_timeline_create_list_and_set_active_round_trip() {
        let _guard = PROJECT_STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let root = tmp("timeline_multi");
        let (dir, manifest) = new_project_in(&root, "multi-tl", &[]).unwrap();
        save_manifest(&dir, &manifest).unwrap();
        state::set_project(Some(ProjectRef {
            path: dir.clone(),
            name: "multi-tl".into(),
        }));

        // no timelines yet -> chroma_timeline_list lazily builds one from shots
        let listed = super::super::edit::chroma_timeline_list().unwrap();
        assert_eq!(listed.len(), 1);
        assert!(listed[0].active);
        let main_id = listed[0].id.clone();

        let alt = super::super::edit::chroma_timeline_create("Alt cut".into()).unwrap();
        assert_eq!(alt.name, "Alt cut");
        assert!(!alt.id.is_empty());
        assert_ne!(alt.id, main_id);

        // creating makes the new one active
        let listed2 = super::super::edit::chroma_timeline_list().unwrap();
        assert_eq!(listed2.len(), 2);
        let active_now: Vec<_> = listed2
            .iter()
            .filter(|t| t.active)
            .map(|t| t.id.clone())
            .collect();
        assert_eq!(active_now, vec![alt.id.clone()]);

        // chroma_timeline_get/_set operate on whichever is active
        let got = super::super::edit::chroma_timeline_get().unwrap();
        assert_eq!(got.id, alt.id);

        // switch back to the original by id
        super::super::edit::chroma_timeline_set_active(main_id.clone()).unwrap();
        let listed3 = super::super::edit::chroma_timeline_list().unwrap();
        let active_now2: Vec<_> = listed3
            .iter()
            .filter(|t| t.active)
            .map(|t| t.id.clone())
            .collect();
        assert_eq!(active_now2, vec![main_id.clone()]);
        assert_eq!(
            super::super::edit::chroma_timeline_get().unwrap().id,
            main_id
        );

        // an unknown id errors, active timeline unchanged
        assert!(super::super::edit::chroma_timeline_set_active("no-such-id".into()).is_err());
        assert_eq!(
            super::super::edit::chroma_timeline_get().unwrap().id,
            main_id
        );

        state::set_project(None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn single_timeline_project_round_trips_through_get_and_set_unchanged() {
        // The existing single-timeline Edit-tab UX (D-041) must not regress:
        // get -> mutate -> set -> get again returns exactly what was set.
        let _guard = PROJECT_STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let root = tmp("timeline_single_roundtrip");
        let (dir, manifest) = new_project_in(
            &root,
            "single-tl",
            &[root.join("a.mov").to_string_lossy().to_string()],
        )
        .unwrap();
        save_manifest(&dir, &manifest).unwrap();
        state::set_project(Some(ProjectRef {
            path: dir.clone(),
            name: "single-tl".into(),
        }));

        let tl = super::super::edit::chroma_timeline_get().unwrap();
        assert_eq!(
            tl.tracks[0].clips.len(),
            1,
            "lazily built from the project's one shot"
        );

        let mut edited = tl.clone();
        edited.name = "renamed".into();
        super::super::edit::chroma_timeline_set(edited.clone()).unwrap();

        let refetched = super::super::edit::chroma_timeline_get().unwrap();
        assert_eq!(refetched.id, edited.id, "id is preserved across set/get");
        assert_eq!(refetched.name, "renamed");
        assert_eq!(refetched.tracks[0].clips.len(), 1);

        // still exactly one timeline — chroma_timeline_set never appends
        let listed = super::super::edit::chroma_timeline_list().unwrap();
        assert_eq!(listed.len(), 1);

        state::set_project(None);
        let _ = std::fs::remove_dir_all(&root);
    }

    // --- track management + cross-track move (D-054) ------------------------

    #[test]
    fn track_commands_add_remove_and_move_clip_on_the_active_timeline() {
        let _guard = PROJECT_STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let root = tmp("d054_track_commands");
        let (dir, manifest) = new_project_in(
            &root,
            "track-cmds",
            &[root.join("a.mov").to_string_lossy().to_string()],
        )
        .unwrap();
        save_manifest(&dir, &manifest).unwrap();
        state::set_project(Some(ProjectRef {
            path: dir.clone(),
            name: "track-cmds".into(),
        }));

        // lazily builds the one-video-track timeline from the seed shot
        let tl = super::super::edit::chroma_timeline_get().unwrap();
        assert_eq!(tl.tracks.len(), 1);
        let clip_id = tl.tracks[0].clips[0].id.clone();

        // add_track
        let new_idx =
            super::super::edit::chroma_timeline_add_track(chroma_timeline::TrackKind::Audio)
                .unwrap();
        assert_eq!(new_idx, 1);
        let tl2 = super::super::edit::chroma_timeline_get().unwrap();
        assert_eq!(tl2.tracks.len(), 2);
        assert_eq!(tl2.tracks[1].kind, chroma_timeline::TrackKind::Audio);

        // move_clip: from the video track (0) onto the fresh audio track (1)
        super::super::edit::chroma_timeline_move_clip(0, 0, 1, 500).unwrap();
        let tl3 = super::super::edit::chroma_timeline_get().unwrap();
        assert!(tl3.tracks[0].clips.is_empty(), "removed from track 0");
        assert_eq!(tl3.tracks[1].clips.len(), 1, "landed on track 1");
        assert_eq!(tl3.tracks[1].clips[0].id, clip_id, "identity preserved");
        assert_eq!(tl3.tracks[1].clips[0].start_frame, 500);

        // an out-of-range move errors and leaves the persisted timeline unchanged
        assert!(super::super::edit::chroma_timeline_move_clip(9, 0, 0, 0).is_err());
        let tl4 = super::super::edit::chroma_timeline_get().unwrap();
        assert_eq!(
            tl4.tracks[1].clips.len(),
            1,
            "unchanged after the failed move"
        );

        // remove_track (including the clip now sitting on it)
        super::super::edit::chroma_timeline_remove_track(1).unwrap();
        let tl5 = super::super::edit::chroma_timeline_get().unwrap();
        assert_eq!(
            tl5.tracks.len(),
            1,
            "the audio track (and its clip) is gone"
        );

        // an out-of-range remove_track errors
        assert!(super::super::edit::chroma_timeline_remove_track(9).is_err());

        state::set_project(None);
        let _ = std::fs::remove_dir_all(&root);
    }

    // --- shots/media unification (D-046) ------------------------------------

    #[test]
    fn new_project_shots_reference_pool_items_not_paths() {
        let root = tmp("unify_new_project");
        let a = root.join("a.mov").to_string_lossy().to_string();
        let (_dir, manifest) = new_project_in(&root, "unify", &[a.clone()]).unwrap();
        assert_eq!(manifest.media.len(), 1, "the seed path lands in the pool");
        assert_eq!(manifest.shots.len(), 1);
        assert_eq!(
            manifest.shots[0].media_id, manifest.media[0].id,
            "the shot references the pool item, not the path directly"
        );
        let (path, name) = resolve_shot(&manifest, &manifest.shots[0]);
        assert_eq!(path, a);
        assert_eq!(name, "a.mov");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn shot_survives_its_media_item_being_renamed_and_moved() {
        // renaming/re-filing the pool item (not the shot) is exactly what
        // "the pool is the source of truth" buys — the shot still resolves
        // correctly with zero shot-side changes.
        let root = tmp("unify_rename");
        let a = root.join("a.mov").to_string_lossy().to_string();
        let (_dir, mut manifest) = new_project_in(&root, "unify-rename", &[a]).unwrap();
        let shot = manifest.shots[0].clone();
        assert_eq!(resolve_shot(&manifest, &shot).1, "a.mov");

        manifest.media[0].name = "Hero take".into();
        manifest.media[0].folder = Some("Interviews".into());
        assert_eq!(resolve_shot(&manifest, &shot).1, "Hero take");
        assert_eq!(
            manifest
                .media_for(&shot.media_id)
                .unwrap()
                .folder
                .as_deref(),
            Some("Interviews")
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn shot_with_dangling_media_id_resolves_gracefully() {
        // no `chroma_media_remove` command exists yet, but the reference can
        // still go dangling (hand-edited project.json, a future removal
        // feature) — resolve_shot must not panic or error, just flag it.
        let shot = ProjectShot {
            id: "s1".into(),
            media_id: "does-not-exist".into(),
            frame: 0,
        };
        let manifest = ProjectManifest::fresh("dangling");
        let (path, name) = resolve_shot(&manifest, &shot);
        assert_eq!(path, "");
        assert_eq!(name, "(missing media)");
        assert!(manifest.media_for(&shot.media_id).is_none());
    }

    #[test]
    fn open_manifest_flags_a_dangling_shot_offline_without_erroring() {
        let _guard = PROJECT_STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let root = tmp("unify_dangling_open");
        let dir = root.join("x.chroma");
        std::fs::create_dir_all(&dir).unwrap();
        // a shot whose mediaId matches nothing in `media` at all — the
        // shape a hand-edited or corrupted project.json could have.
        std::fs::write(
            dir.join("project.json"),
            r#"{"schema":"chroma.project/1","name":"x",
                "shots":[{"id":"s1","mediaId":"ghost","frame":0}],
                "activeShot":0,"settings":{},"media":[]}"#,
        )
        .unwrap();

        let m = load_manifest(&dir).unwrap();
        assert_eq!(m.shots.len(), 1, "the dangling shot is not dropped on load");
        let (path, name) = resolve_shot(&m, &m.shots[0]);
        assert_eq!(path, "");
        assert_eq!(name, "(missing media)");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn legacy_shot_shape_migrates_to_media_id_and_backfills_the_pool() {
        // the exact shape every project.json had before D-046 (and the real
        // ~/Movies/Chroma/New.chroma/project.json as of this decision):
        // shots carry sourcePath/name directly, media is empty.
        let root = tmp("unify_legacy_migration");
        let dir = root.join("legacy.chroma");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("project.json"),
            r#"{"schema":"chroma.project/1","name":"New",
                "shots":[{"id":"8022aef1","sourcePath":"/a/pexels.mp4","frame":0,"name":"pexels.mp4"}],
                "activeShot":0,"settings":{},
                "timelines":[{"id":"t1","name":"New","rate":null,"tracks":[]}],
                "activeTimeline":0,"media":[]}"#,
        )
        .unwrap();

        let m = load_manifest(&dir).unwrap();
        assert_eq!(m.shots.len(), 1);
        assert!(!m.shots[0].media_id.is_empty(), "a mediaId is backfilled");
        assert_eq!(m.media.len(), 1, "a matching pool item is synthesized");
        assert_eq!(m.media[0].source_path, "/a/pexels.mp4");
        assert_eq!(m.media[0].id, m.shots[0].media_id);
        let (path, name) = resolve_shot(&m, &m.shots[0]);
        assert_eq!(path, "/a/pexels.mp4");
        assert_eq!(name, "pexels.mp4");

        // saving never reintroduces sourcePath/name on the shot (the struct
        // has no such fields) — a re-load stays migrated and idempotent.
        save_manifest(&dir, &m).unwrap();
        let raw: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("project.json")).unwrap())
                .unwrap();
        let shot_raw = &raw["shots"][0];
        assert!(shot_raw.get("sourcePath").is_none());
        assert!(shot_raw.get("name").is_none());
        assert_eq!(
            shot_raw["mediaId"],
            Value::String(m.shots[0].media_id.clone())
        );

        let reloaded = load_manifest(&dir).unwrap();
        assert_eq!(
            reloaded.media.len(),
            1,
            "migration doesn't duplicate on re-load"
        );
        assert_eq!(reloaded.shots[0].media_id, m.shots[0].media_id);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn legacy_shot_sharing_a_source_path_with_an_existing_pool_item_reuses_it() {
        let root = tmp("unify_legacy_dedup");
        let dir = root.join("legacy2.chroma");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("project.json"),
            r#"{"schema":"chroma.project/1","name":"y",
                "shots":[{"id":"s1","sourcePath":"/shared.mov","frame":0,"name":"shared.mov"}],
                "activeShot":0,"settings":{},
                "media":[{"id":"m-existing","sourcePath":"/shared.mov","name":"shared.mov","added":"2026-01-01T00:00:00Z"}]}"#,
        )
        .unwrap();
        let m = load_manifest(&dir).unwrap();
        assert_eq!(m.media.len(), 1, "no duplicate pool item is created");
        assert_eq!(m.shots[0].media_id, "m-existing");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn chroma_project_save_attaches_a_new_shot_to_the_pool() {
        let _guard = PROJECT_STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let root = tmp("unify_save");
        let (dir, manifest) = new_project_in(&root, "unify-save", &[]).unwrap();
        save_manifest(&dir, &manifest).unwrap();
        state::set_project(Some(ProjectRef {
            path: dir.clone(),
            name: "unify-save".into(),
        }));

        let clip_path = root.join("clip.mov").to_string_lossy().to_string();
        let shots = vec![ProjectShotInput {
            id: "shot-1".into(),
            source_path: clip_path.clone(),
            frame: 12,
            name: Some("clip.mov".into()),
        }];
        // chroma_project_save is async; drive it on a tiny local runtime
        // rather than pulling tokio::test into this otherwise-sync module.
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        rt.block_on(chroma_project_save(
            Some(dir.to_string_lossy().to_string()),
            shots,
            0,
        ))
        .unwrap();

        let reloaded = load_manifest(&dir).unwrap();
        assert_eq!(reloaded.shots.len(), 1);
        assert_eq!(reloaded.media.len(), 1, "the new shot's path is pooled");
        assert_eq!(reloaded.media[0].source_path, clip_path);
        assert_eq!(reloaded.shots[0].media_id, reloaded.media[0].id);
        assert_eq!(reloaded.shots[0].frame, 12);

        // saving the same source path again does not duplicate the pool item
        let shots2 = vec![ProjectShotInput {
            id: "shot-1".into(),
            source_path: clip_path.clone(),
            frame: 30,
            name: Some("clip.mov".into()),
        }];
        rt.block_on(chroma_project_save(
            Some(dir.to_string_lossy().to_string()),
            shots2,
            0,
        ))
        .unwrap();
        let reloaded2 = load_manifest(&dir).unwrap();
        assert_eq!(reloaded2.media.len(), 1, "re-saving the same path dedupes");
        assert_eq!(reloaded2.shots[0].frame, 30);

        state::set_project(None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn add_shot_for_media_references_an_existing_pool_item() {
        // the sync model half of `chroma_project_add_shot` — the Sources
        // panel's "add to grading" action on a pool-only item. The
        // state-taking command wrapper itself (open_manifest integration) is
        // verified live against the real project, same as the other
        // state-taking commands in this module (none are unit-tested
        // directly — see `open_manifest`'s doc).
        let root = tmp("unify_add_shot");
        let (_dir, mut manifest) = new_project_in(&root, "unify-add-shot", &[]).unwrap();
        let path = root.join("pool-only.mov").to_string_lossy().to_string();
        add_media(&mut manifest, &[path.clone()], None);
        assert!(
            manifest.shots.is_empty(),
            "a plain pool import creates no shot"
        );
        let media_id = manifest.media[0].id.clone();

        add_shot_for_media(&mut manifest, &media_id).unwrap();
        assert_eq!(manifest.shots.len(), 1);
        assert_eq!(manifest.shots[0].media_id, media_id);
        assert_eq!(manifest.active_shot, 0);
        assert_eq!(resolve_shot(&manifest, &manifest.shots[0]).0, path);

        // an unknown media id errors rather than creating a dangling shot
        assert!(add_shot_for_media(&mut manifest, "no-such-media").is_err());
        assert_eq!(
            manifest.shots.len(),
            1,
            "the failed add did not append a shot"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn project_ref_set_and_clear() {
        let _guard = PROJECT_STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
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

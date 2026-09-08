//! Chroma project model (D-037) — the saved project the launcher opens.
//!
//! **Home:** `chroma-project` since D-148 (`docs/notes/crate-extraction-plan.md`
//!   §2.3). This file is `app/src-tauri/src/chroma/project.rs` L1–1638 moved
//!   verbatim; what stayed behind is `open_manifest` + the 20
//!   `#[tauri::command]`s, every one of which takes
//!   `tauri::State<'_, AppState>` and therefore cannot live in a crate
//!   (D-141 §1). `chroma::project` is a `pub use chroma_project::*;` shim at
//!   the old path, so no call site outside this slice changed.
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
//!   not fatal, and re-pointable via `chroma_project_relink`.
//! What it does NOT do: any grade math, decode, or GPU work. Thumb regen shells
//!   out to `chroma::video::extract_thumb`. The D-032 activity feed is
//!   session-only and never persisted.
//!
//! Fork hygiene (D-003): all new code, and since D-148 not in the fork at all —
//!   the remaining upstream footprint is `pub mod project;` in `chroma/mod.rs`
//!   + the 20 `generate_handler!` lines in `lib.rs`.
//!
//! Supersedes D-033's deferred `.chroma/session.json` — the multi-shot
//! `Session` (D-033) is now the *loaded form* of a saved project.
//!
//! **Media pool (D-044, pass 1 of the roadmap's "media pool + import +
//! multiple timelines" item):** [`ProjectManifest::media`] is a project-wide
//! `Vec<MediaItem>` — every file the project references, whether or not it is
//! currently a graded shot or cut into the Edit-tab timeline. This pass is
//! **additive only**: `media` and `shots` are two independent lists for now
//! (`shots` unchanged, only `chroma_media_import` writes to `media`); a shot
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
//! `chroma_project_add_shot` command is the Sources panel's explicit
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
//! **Sources panel fixes (D-059):** `chroma_media_list`, `chroma_media_import`,
//! and `chroma_media_move` are now `async fn` (B-014 — they used to be plain
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
//! explicitly-created, possibly-still-empty bin paths (new: `chroma_media_create_folder`)
//! alongside the existing "folders are implied by items' `folder` strings" model —
//! see the D-059 decision for why a full bin-hierarchy entity wasn't needed.
//!
//! **Unified clip identity, Edit ↔ Colorist (D-070, `docs/notes/unified-clip-model.md`).**
//! [`ProjectShot`] **retires as the persisted grading list** — Colorist's
//! shot strip now reads the active `chroma_timeline::Timeline`'s clips
//! directly (see `open_manifest`), the same clips the Edit tab drags onto
//! the timeline. The struct itself, and [`ProjectManifest::shots`]/
//! [`ProjectManifest::active_shot`], are kept **read-only** — still
//! deserialized (so an old `project.json` still parses and its legacy
//! migration still runs), never written by anything new — purely so
//! [`migrate_shot_grades_to_clips`] has a legacy list to migrate grade files
//! *from* on a project's first open after this decision. Nothing pushes a
//! `ProjectShot` any more: [`new_project_in`], the repurposed
//! `chroma_project_add_shot` (now "append a clip to the active timeline
//! referencing this pool item," the Colorist-side counterpart of a
//! Sources-panel drag onto the Edit tab), and the new
//! `chroma_project_add_shot_paths`/`chroma_project_remove_clip` all
//! operate on `chroma_timeline::Clip` via [`append_media_clip`] instead.
//! [`ProjectManifest::active_clip_id`] replaces `active_shot` as the
//! persisted "which clip is Colorist grading" pointer — stable across
//! reorders (a clip id, not an index); [`resolve_active_clip_index`] falls
//! back to the legacy `active_shot`/`shots` pair exactly once, the first
//! time a pre-migration project is opened. `chroma_project_save` no
//! longer takes a `shots` list at all (the timeline, persisted separately by
//! `chroma::edit`'s `chroma_timeline_set`, is the only durable clip list
//! now) — it just persists `active_clip_id` + regenerates `thumb.jpg`.
//! `Clip::media_id` (the crate-side half of this decision) is the new
//! pool-item back-link `ProjectShot::media_id` used to be; a clip built
//! before this decision (via `Timeline::from_shots`, i.e. every clip in
//! every project.json saved before today) never has it, so matching falls
//! back to `Clip::shot_id` (an exact backlink, when the clip was built from
//! a legacy shot) and then `source_path` — see [`shot_matches_clip`]'s own
//! doc for why `shot_id` is used even though the scoping doc only named
//! `media_id`/`source_path`: the real `~/Movies/Chroma/New.chroma` project
//! has a shot whose `media_id` is dangling but whose one true timeline clip
//! still carries the exact `shot_id` backlink, which would otherwise
//! misclassify a real, currently-graded shot as "no matching clip."

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use base64::Engine as _;
use chroma_media::video;
use chroma_timeline::{Clip, Timeline, TrackKind};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Current manifest schema. `chroma.project/<major>[.<minor>]` — bump the
/// **major** only on a breaking change ([`load_manifest`] rejects a file with a
/// newer major); bump the **minor** for a change that a newer build can migrate
/// an older file through, which is what the minor exists to make detectable.
///
/// D-136 raised this to `1.1` for the first such migration: `Clip::position_x`/
/// `position_y` changed *unit* (absolute canvas pixels → a fraction of the
/// composition) without changing shape, so no serde default and no sentinel can
/// tell a migrated file from an un-migrated one — the key is a plain number
/// either way. The file's own recorded minor is the only thing that can, so
/// [`load_manifest`] reads it and [`chroma_timeline::Timeline::normalise_legacy_positions`]
/// runs exactly once per file. The major is unchanged because an older build
/// loading a `1.1` file still parses every field it knows: it would read the
/// new positions in the old unit — a wrong PIP offset, not a load failure — and
/// that is precisely the "the major is the compatibility gate" contract above.
pub const SCHEMA: &str = "chroma.project/1.1";
const CURRENT_MAJOR: u64 = 1;
/// The schema minor at which `Clip::position_x`/`position_y` became normalised
/// (D-136). A file recording anything less — including an untagged one, and
/// every `chroma.project/1` file written before this decision — carries
/// pre-D-136 pixel positions and is migrated on load.
const NORMALISED_GEOMETRY_MINOR: u64 = 1;

/// Composition size assumed by D-136's position migration for a project that
/// records no `settings.width`/`height` (D-038) **and** has no probed pool
/// resolution to fall back on either — a pre-D-038 project whose media was
/// never successfully probed. 1080p, stated rather than inferred: the migration
/// is a reinterpretation of unrecoverable data in the first place (see
/// `normalise_legacy_positions`' own doc), and a project in this state that
/// also used a PIP offset is a set this codebase can enumerate as "none
/// observed." Every clip still at `0.0` — i.e. every clip nobody ever offset —
/// migrates to exactly `0.0` under any divisor, so this constant only ever
/// affects a project that is already accepting a one-time shift.
const NOMINAL_COMPOSITION: (u32, u32) = (1920, 1080);

/// Split a `chroma.project/<major>[.<minor>]` tag into its numbers. An untagged
/// or unparseable file is `(None, 0)` — treated as v1.0, which is what every
/// pre-schema file effectively is.
fn parse_schema(schema: &str) -> (Option<u64>, u64) {
    let Some(rest) = schema.strip_prefix("chroma.project/") else {
        return (None, 0);
    };
    let mut parts = rest.split('.');
    let major = parts.next().and_then(|m| m.parse::<u64>().ok());
    let minor = parts
        .next()
        .and_then(|m| m.parse::<u64>().ok())
        .unwrap_or(0);
    (major, minor)
}

// --------------------------------------------------------------------------- //
// the manifest
// --------------------------------------------------------------------------- //

/// A pool item currently being graded (D-046: references a [`MediaItem`] by
/// id rather than duplicating its `source_path`/`name` — see the module doc).
///
/// **Legacy / read-only as of D-070.** No longer the persisted grading list
/// — `chroma_timeline::Clip` (+ its new `media_id`) is now the single source
/// of truth for what's gradable, see the module doc's "Unified clip
/// identity" section. This struct, and [`ProjectManifest::shots`]/
/// [`ProjectManifest::active_shot`], still deserialize (so an old
/// `project.json` keeps loading and [`migrate_legacy_shots`] keeps running)
/// but nothing constructs a new one any more — kept only as the input to
/// [`migrate_shot_grades_to_clips`]'s one-time grade-file migration.
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
    /// partial-merge contract of `chroma_project_set_settings`.
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
    /// Legacy / read-only as of D-070 — see [`ProjectShot`]'s doc.
    #[serde(default)]
    pub shots: Vec<ProjectShot>,
    /// Legacy / read-only as of D-070 — superseded by
    /// [`ProjectManifest::active_clip_id`]. Frozen at whatever value a
    /// pre-D-070 build last wrote (or `0` for a project created after);
    /// [`resolve_active_clip_index`] reads it exactly once, as a fallback,
    /// on a project's first open after this decision.
    #[serde(default)]
    pub active_shot: usize,
    /// D-070 — the persisted "which clip is Colorist grading" pointer,
    /// replacing `active_shot`. A clip id (stable across a reorder/move),
    /// not an index. `None` on a project never opened since this decision
    /// landed; [`resolve_active_clip_index`] falls back to `active_shot`/
    /// `shots` for that one-time case, then to the first clip.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_clip_id: Option<String>,
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
    /// `chroma_media_import`, independent of `shots`/`timeline`. Additive,
    /// optional (schema major unchanged, same move as D-038/D-041): an absent
    /// `media` key → an empty pool, and the project behaves exactly as it did
    /// pre-D-044.
    #[serde(default)]
    pub media: Vec<MediaItem>,
    /// Explicitly-created bin paths (D-059), independent of whether any
    /// [`MediaItem::folder`] currently names them — the one piece of state
    /// that lets a just-created, still-empty folder show up in the Sources
    /// panel's tree (a folder implied only by items' `folder` strings, D-045's
    /// original model, disappears the moment its last item is moved out or
    /// removed; this list is what keeps a deliberately-created one around).
    /// Additive/optional, same defaulting convention as `media`/`timelines`.
    /// `chroma_media_create_folder` appends to it; `chroma_media_import`/
    /// `chroma_media_move` also register whatever `folder` they're given, so
    /// an implicitly-created folder (naming a not-yet-used path on import/move,
    /// D-045's original behaviour) is remembered too, not just an explicit one.
    #[serde(default)]
    pub folders: Vec<String>,
}

impl ProjectManifest {
    pub fn fresh(name: &str) -> Self {
        let now = now_rfc3339();
        ProjectManifest {
            schema: SCHEMA.to_string(),
            name: name.to_string(),
            created: now.clone(),
            modified: now,
            shots: Vec::new(),
            active_shot: 0,
            active_clip_id: None,
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
    /// D-129 — whether this source has a decodeable audio stream
    /// (`video::VideoInfo::has_audio`). The Edit tab reads it at drop time to
    /// decide whether a dropped clip gets a linked audio half at all; before
    /// this field, `MediaItem` carried **no** audio-vs-video signal at all,
    /// which is exactly the gap D-097's `inferNewTrackKind` had to work
    /// around ("without a real backend model change").
    ///
    /// `Option<bool>`, not a bare `bool`, with `#[serde(default)]` — `None`
    /// is a real **"never probed for this"** sentinel, not "no audio". A pool
    /// item imported before D-129 has no key here, and a bare `bool` would
    /// deserialize it to `false`: indistinguishable from a genuinely silent
    /// source, and permanently wrong for every existing project (no linked
    /// audio would ever be created for its media again).
    /// [`backfill_has_audio`] resolves the sentinel once, on the next media
    /// list, and persists the real answer. The same "an absent value is not
    /// the value" discipline `Clip::start_frame`'s own migration sentinel
    /// already keeps.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_audio: Option<bool>,
}

impl From<&video::VideoInfo> for MediaVideoInfo {
    fn from(info: &video::VideoInfo) -> Self {
        MediaVideoInfo {
            resolution: info.resolution,
            fps: info.fps(),
            frame_count: info.frame_count,
            duration_secs: info.duration_secs,
            has_audio: Some(info.has_audio),
        }
    }
}

/// D-129 — resolve the `has_audio: None` migration sentinel for every pool
/// item that predates the field, by re-probing its source once. Returns
/// `true` if anything changed, so the caller can persist the manifest — which
/// makes this a genuinely **one-time** pass per project, not a re-probe on
/// every media list.
///
/// Deliberately cheap and forgiving: [`chroma_media::probe::probe_cached`] is the same
/// memoised probe the preview and waveform paths already share, so a source
/// touched anywhere else this session costs nothing here; an offline or
/// unprobeable source is left as `None` (still *unknown*, never falsely
/// recorded as silent) rather than failing the whole list, matching this
/// module's standing "offline is flagged, not fatal" discipline.
pub fn backfill_has_audio(manifest: &mut ProjectManifest) -> bool {
    let mut changed = false;
    for item in manifest.media.iter_mut() {
        let Some(video) = item.video.as_mut() else {
            continue;
        };
        if video.has_audio.is_some() {
            continue;
        }
        if let Ok(info) = chroma_media::probe::probe_cached(Path::new(&item.source_path)) {
            video.has_audio = Some(info.has_audio);
            changed = true;
        }
    }
    changed
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
    /// `data:image/jpeg;base64,…` poster-frame thumbnail (D-059), read live
    /// from `<video_dir>/.chroma/thumbs/<id>.jpg` — same "computed live, not
    /// stored on the model" discipline `offline` uses. `None` when nothing has
    /// been cached yet (thumbnail generation failed at import time, or the
    /// item predates D-059 and hasn't been re-imported).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumb: Option<String>,
}

/// `true` if `path` is a readable video OR audio file right now (B-089 — the
/// media POOL, unlike a Colorist `shot_is_online`'s own video-only check,
/// also holds real SFX/music sources with no video track at all).
pub fn media_item_is_online(path: &str) -> bool {
    let p = Path::new(path);
    p.is_file() && video::is_media_file(p)
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
pub fn normalize_folder(folder: Option<&str>) -> Option<String> {
    folder
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

// --------------------------------------------------------------------------- //
// media thumbnails (D-059/B-014) — a poster-frame JPEG per MediaItem, cached
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
pub fn thumb_cache_path(source_path: &str, media_id: &str) -> Option<PathBuf> {
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
pub fn add_media(
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
/// folder). Shared by [`add_media`]/`chroma_media_move` (which register a
/// folder implicitly, D-045's original behaviour) and
/// `chroma_media_create_folder` (which registers one explicitly, D-059).
pub fn register_folder(manifest: &mut ProjectManifest, folder: Option<&str>) {
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
pub fn find_or_create_media(
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
// unified clip identity (D-070, docs/notes/unified-clip-model.md) — the
// `ProjectShot` -> `chroma_timeline::Clip` migration: appending a new
// gradable clip, and matching a legacy shot to the clip that continues it.
// --------------------------------------------------------------------------- //

/// Append a full-length clip referencing pool item `media_id` to the end of
/// `timeline`'s first video track (creating one if the timeline has none),
/// and make it `manifest.active_clip_id`. The pure-model half of the
/// repurposed `chroma_project_add_shot` — split out so it's testable
/// without a `tauri::State` (same convention `add_media` already uses; see
/// `open_manifest`'s doc for why the state-taking commands themselves stay
/// integration-tested against the real project instead). Errors (leaving
/// `manifest` unchanged) if `media_id` isn't in the pool, or `timeline_idx`
/// is out of range.
///
/// **D-129 — if the source has an audio stream, this also appends its own
/// audio as a second, linked `Clip` on an audio track** (found or created via
/// `Timeline::ensure_audio_track_with_room`), both halves sharing one
/// `link_group`. That is the same "drop a clip, get V1 + a linked A1"
/// behaviour `@chroma/editor`'s `add_clip` op gives the Edit-tab drag — kept
/// in step deliberately, so which entry point created a clip never changes
/// whether it has a linked audio half. Returns the **video** clip (the one
/// that becomes `active_clip_id`); the audio half is reachable through its
/// `link_group` like any other member.
pub fn append_media_clip(
    manifest: &mut ProjectManifest,
    timeline_idx: usize,
    media_id: &str,
) -> Result<Clip, String> {
    let item = manifest
        .media_for(media_id)
        .ok_or_else(|| format!("no media item with id {media_id}"))?
        .clone();
    if timeline_idx >= manifest.timelines.len() {
        return Err(format!("timeline index {timeline_idx} out of range"));
    }
    let probed = chroma_media::probe::probe_cached(Path::new(&item.source_path)).ok();
    let frames = probed.as_ref().map(|i| i.frame_count as i64).unwrap_or(0);
    let duration = frames.max(1);
    let has_audio = probed.as_ref().is_some_and(|i| i.has_audio);

    let tl = &mut manifest.timelines[timeline_idx];
    // B-079 — `Track::duration` is fps-aware now; `Timeline::fps` before the
    // mutable borrow below, same as every other live consumer.
    let fps = tl.fps();
    let track_idx = tl
        .tracks
        .iter()
        .position(|t| t.kind == TrackKind::Video)
        .unwrap_or_else(|| tl.add_track(TrackKind::Video));
    let start_frame = tl.tracks[track_idx].duration(fps);
    // `None` for a silent (or unprobeable) source — that clip keeps D-050's
    // embedded-audio playback and gains no audio half, exactly as before.
    let link_group = has_audio.then(|| format!("lg-{}", uuid::Uuid::new_v4()));

    // B-082 — `..Default::default()` left `source_fps` at `None` here, the
    // one real `Clip`-construction site `probed: Option<VideoInfo>` was
    // already sitting right above and simply never got read for it. Every
    // fps-aware consumer (B-075/B-077/D-194's `source_fps ?? fps` pattern)
    // then silently fell back to the TIMELINE's fps for a clip whose native
    // rate differs — exactly the bug those passes fixed at every
    // CONSUMPTION site, reappearing at this CREATION site.
    let source_fps = probed.as_ref().map(|i| i.fps()).filter(|f| *f > 0.0);
    let clip = Clip {
        id: uuid::Uuid::new_v4().to_string(),
        shot_id: None,
        media_id: Some(media_id.to_string()),
        link_group: link_group.clone(),
        name: item.name.clone(),
        source_path: item.source_path.clone(),
        source_start: 0,
        duration,
        source_len: frames.max(0),
        start_frame,
        source_fps,
        ..Default::default()
    };
    tl.tracks[track_idx].clips.push(clip.clone());
    if link_group.is_some() {
        let audio_track = tl.ensure_audio_track_with_room(start_frame, duration);
        let audio = Clip {
            id: uuid::Uuid::new_v4().to_string(),
            ..clip.clone()
        };
        tl.tracks[audio_track].clips.push(audio);
    }
    manifest.active_clip_id = Some(clip.id.clone());
    Ok(clip)
}

/// Remove the clip with `clip_id` from wherever it sits on `timeline_idx`
/// (any track). Errors (leaving `manifest` unchanged) if no clip on that
/// timeline has that id. Clears `active_clip_id` if it pointed at the
/// removed clip (the caller/`open_manifest` picks a fresh one on the next
/// open); does not touch its grade file — same "offline is flagged, not
/// deleted" discipline the rest of this module uses, a removed clip's grade
/// simply stops being reachable through the strip, it isn't destroyed.
pub fn remove_clip_by_id(
    manifest: &mut ProjectManifest,
    timeline_idx: usize,
    clip_id: &str,
) -> Result<(), String> {
    if timeline_idx >= manifest.timelines.len() {
        return Err(format!("timeline index {timeline_idx} out of range"));
    }
    let tl = &mut manifest.timelines[timeline_idx];
    for ti in 0..tl.tracks.len() {
        if let Some(ci) = tl.tracks[ti].clips.iter().position(|c| c.id == clip_id) {
            tl.remove(ti, ci).map_err(|e| e.to_string())?;
            if manifest.active_clip_id.as_deref() == Some(clip_id) {
                manifest.active_clip_id = None;
            }
            return Ok(());
        }
    }
    Err(format!("no clip with id {clip_id} on the active timeline"))
}

/// Does `clip` continue `shot` — i.e. is it the clip whose grade file the
/// shot's `<shot.id>.grade.json` should migrate to? Three signals, in
/// priority order:
///
/// 1. **`clip.shot_id == Some(shot.id)`** — an exact backlink, set by
///    `Timeline::from_shots` for every clip built from a project's legacy
///    `shots` list (the common case: a project opened for the first time
///    since ever, or one that was never touched on the Edit tab).
/// 2. **`clip.media_id == Some(shot.media_id)`** — the new pool-item link,
///    for a clip built after D-070 (drag-from-Sources, or the repurposed
///    `chroma_project_add_shot`) that happens to reference the same pool
///    item a legacy shot graded.
/// 3. **`resolve_shot(shot).0 == clip.source_path`** (non-empty only) — the
///    scoping doc's documented fallback, for a clip that predates both
///    `shot_id` and `media_id` (neither set) but demonstrably points at the
///    same file.
///
/// `shot_id` is checked first even though the scoping doc only names
/// `media_id`/`source_path`: the real `~/Movies/Chroma/New.chroma` project
/// has a shot (`8022aef1…`) whose `media_id` is dangling (its pool item's
/// `sourcePath` was cleared) but whose one true timeline clip still carries
/// the exact `shot_id` backlink — matching on `media_id`/`source_path` alone
/// would misclassify a real, currently-graded shot as "no matching clip" and
/// warn instead of recognizing it. See D-070.
fn shot_matches_clip(manifest: &ProjectManifest, shot: &ProjectShot, clip: &Clip) -> bool {
    if clip.shot_id.as_deref() == Some(shot.id.as_str()) {
        return true;
    }
    if let Some(cm) = &clip.media_id {
        if cm == &shot.media_id {
            return true;
        }
    }
    let (source_path, _) = resolve_shot(manifest, shot);
    !source_path.is_empty() && source_path == clip.source_path
}

/// Every video-track clip on `manifest`'s active timeline, flattened across
/// tracks and ordered by `start_frame` — what `open_manifest` sources the
/// Colorist shot strip from, and what [`migrate_shot_grades_to_clips`]
/// matches legacy shots against. `None` active timeline (an empty
/// `timelines` list — should not happen after `chroma::edit::ensure_timeline`
/// has run, but this function doesn't assume that) yields an empty `Vec`.
pub fn active_timeline_video_clips(manifest: &ProjectManifest) -> Vec<Clip> {
    let Some(tl) = manifest.timelines.get(manifest.active_timeline) else {
        return Vec::new();
    };
    let mut clips: Vec<Clip> = tl
        .tracks
        .iter()
        .filter(|t| t.kind == TrackKind::Video)
        .flat_map(|t| t.clips.iter().cloned())
        .collect();
    clips.sort_by_key(|c| c.start_frame);
    clips
}

/// Outcome of [`migrate_shot_grades_to_clips`] — nothing is ever silently
/// dropped: `migrated` counts a real rename, everything else that couldn't
/// be migrated unambiguously shows up in `warnings` with the original file
/// path still in place.
#[derive(Debug, Default, PartialEq)]
pub struct GradeMigrationReport {
    /// grade files actually renamed this call (excludes the "already at the
    /// right name" no-op case, since nothing was renamed there either).
    pub migrated: usize,
    /// one human-readable line per shot that couldn't be migrated
    /// unambiguously (0 or 2+ matching clips) or whose rename itself failed.
    pub warnings: Vec<String>,
}

/// D-070, one-time migration: for each legacy [`ProjectShot`], rename
/// `<grade_dir>/<shot.id>.grade.json` to `<grade_dir>/<clip.id>.grade.json`
/// for the one active-timeline video clip [`shot_matches_clip`] says
/// continues it. Zero or several matches ⇒ the grade file (a real, possibly
/// irreplaceable piece of graded work) is left exactly where it is and a
/// warning is added — never guessed, never dropped.
///
/// **Mask mattes / tracked-matte dirs need no rename.** A grade's static
/// mask mattes live in a sibling `<name>.mattes/` dir named after the
/// *file's own stem* at save time (`grade::grade_name`), and the JSON's
/// `$matte`/`$trackDir`/`$depthDir` references are relative paths **stored
/// literally in the file**, resolved by `grade::load_grade` against the
/// grade file's *parent directory*, never re-derived from its current
/// filename. Renaming only the `.grade.json` file (not its `.mattes`
/// sibling) is therefore correct on its own — verified by reading
/// `grade.rs`'s `save_grade`/`load_grade` before writing this, not assumed.
///
/// Idempotent — safe to call on every project open, not just the first:
/// - A shot with no grade file at all (`old_path` doesn't exist — never
///   graded, or already migrated by a previous call) is silently skipped:
///   not a warning, not counted in `migrated`.
/// - A shot whose one matching clip's id happens to equal the shot's own id
///   (the common case for a clip built by `Timeline::from_shots`, which
///   copies the shot id verbatim) has `old_path == new_path` — a true
///   no-op, not renamed, not warned, not counted (there is nothing to do).
/// - A shot whose `new_path` already exists but differs from `old_path`
///   (both files present — a previous migration that didn't finish, or a
///   hand-copied file) is left alone with a warning rather than overwritten.
///
/// Pure I/O against `grade_dir`; does not mutate `manifest` (nothing about a
/// grade *file's name* is part of the manifest) — `open_manifest` calls this
/// and just logs `warnings`.
pub fn migrate_shot_grades_to_clips(
    manifest: &ProjectManifest,
    grade_dir: &Path,
) -> GradeMigrationReport {
    let mut report = GradeMigrationReport::default();
    if manifest.shots.is_empty() {
        return report;
    }
    let clips = active_timeline_video_clips(manifest);

    for shot in &manifest.shots {
        let old_path = grade_dir.join(format!("{}.grade.json", shot.id));
        if !old_path.is_file() {
            continue; // nothing graded for this shot, or already migrated
        }
        let matches: Vec<&Clip> = clips
            .iter()
            .filter(|c| shot_matches_clip(manifest, shot, c))
            .collect();
        match matches.as_slice() {
            [clip] => {
                let new_path = grade_dir.join(format!("{}.grade.json", clip.id));
                if new_path == old_path {
                    continue; // already at the right name — nothing to do
                }
                if new_path.exists() {
                    report.warnings.push(format!(
                        "shot {} ({}): both {} and {} already exist — left the legacy file in \
                         place rather than overwrite {}",
                        shot.id,
                        shot.media_id,
                        old_path.display(),
                        new_path.display(),
                        new_path.display()
                    ));
                    continue;
                }
                match std::fs::rename(&old_path, &new_path) {
                    Ok(()) => report.migrated += 1,
                    // rename can fail across filesystems/devices — fall back
                    // to copy + remove so a real filesystem boundary can't
                    // silently lose the grade.
                    Err(_) => match std::fs::copy(&old_path, &new_path) {
                        Ok(_) => {
                            let _ = std::fs::remove_file(&old_path);
                            report.migrated += 1;
                        }
                        Err(e) => report.warnings.push(format!(
                            "shot {} ({}): failed to migrate grade file {} -> {}: {e}",
                            shot.id,
                            shot.media_id,
                            old_path.display(),
                            new_path.display()
                        )),
                    },
                }
            }
            [] => report.warnings.push(format!(
                "shot {} ({}) has no matching clip on the active timeline — its grade file \
                 at {} was left untouched",
                shot.id,
                shot.media_id,
                old_path.display()
            )),
            many => report.warnings.push(format!(
                "shot {} ({}) matches {} clips on the active timeline — ambiguous, its grade \
                 file at {} was left untouched",
                shot.id,
                shot.media_id,
                many.len(),
                old_path.display()
            )),
        }
    }
    report
}

/// Resolve which clip Colorist should open, in priority order: the
/// persisted [`ProjectManifest::active_clip_id`]; else the legacy
/// `active_shot`/`shots` pair resolved to whichever clip continues it (a
/// one-time fallback — the first open of a pre-D-070 project, before
/// `active_clip_id` has ever been written); else the first clip; `0` if
/// `clips` is empty (the caller must itself handle "no clips at all").
/// Returns an **index into `clips`**, matching `ProjectOpenDto::active_shot`'s
/// existing "index into the returned `shots` array" contract.
pub fn resolve_active_clip_index(manifest: &ProjectManifest, clips: &[Clip]) -> usize {
    if clips.is_empty() {
        return 0;
    }
    if let Some(id) = &manifest.active_clip_id {
        if let Some(i) = clips.iter().position(|c| &c.id == id) {
            return i;
        }
    }
    if let Some(shot) = manifest.shots.get(manifest.active_shot) {
        if let Some(i) = clips
            .iter()
            .position(|c| shot_matches_clip(manifest, shot, c))
        {
            return i;
        }
    }
    0
}

/// D-070/D-056: re-resolve a candidate active-clip index (from
/// [`resolve_active_clip_index`] — "which clip the user/legacy state
/// picked") through `chroma_timeline::Timeline::resolve_video_clip_at` at
/// that clip's own `start_frame` — the **same** opaque-top-wins function the
/// Edit-tab preview and `chroma::audio`'s mixer already call
/// (`edit::resolve_video_position`, D-056), not a second copy of the
/// selection logic. For every project shape that exists today (one video
/// track) this is a pure no-op: `resolve_video_clip_at` on a single video
/// track is proven equivalent to a plain position lookup — see
/// `chroma-timeline`'s own `resolve_video_clip_at_matches_single_track_behavior`
/// test. It starts mattering once Phase D lands a second video track: if a
/// higher-priority track has a clip covering the same position, Colorist
/// grades **that** clip — "whichever clip you'd actually see," matching
/// what the Edit-tab preview shows at the same frame, never a clip a
/// lower-priority track's gap happens to leave selected underneath it.
/// Falls back to `candidate` unchanged if there's no active timeline, no
/// clip at `candidate`, or (shouldn't happen — the winner came from `clips`
/// itself) the winning clip's id isn't found in `clips`.
pub fn top_wins_clip_index(manifest: &ProjectManifest, clips: &[Clip], candidate: usize) -> usize {
    let Some(candidate_clip) = clips.get(candidate) else {
        return candidate;
    };
    let Some(tl) = manifest.timelines.get(manifest.active_timeline) else {
        return candidate;
    };
    match tl.resolve_video_clip_at(candidate_clip.start_frame) {
        Some((_, winner, _)) => clips
            .iter()
            .position(|c| c.id == winner.id)
            .unwrap_or(candidate),
        None => candidate,
    }
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

pub fn set_projects_dir(dir: &str) -> Result<(), String> {
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

pub fn now_rfc3339() -> String {
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
/// D-114 — in-process cache for [`load_manifest`], keyed by `project_dir` and
/// validated against `project.json`'s own mtime.
///
/// `chroma::edit::resolve_timeline` (via [`load_manifest`]) is a genuinely
/// hot path — it runs on **every single preview frame** while scrubbing or
/// playing back (once per `chroma_timeline_frame`/`chroma_audio_play` call),
/// yet `project.json` only actually changes on an explicit save (D-105's
/// debounced ~400ms during a drag, or a real structural op). Re-reading and
/// re-parsing the whole manifest from disk on every frame — file I/O, JSON
/// parse, schema/legacy migration, `backfill_legacy_positions` per timeline —
/// was real, measured, wasted work on a purely local app that should feel
/// instant. See `docs/notes/performance-instrumentation.md` for before/after
/// numbers.
///
/// Validated by mtime rather than trusted blindly: a plain `fs::metadata`
/// stat is orders of magnitude cheaper than a full read+parse, so every call
/// still does *some* real disk I/O (correctness first), just not the
/// expensive part when nothing has actually changed. This also means an
/// external write to `project.json` (a hand edit, a stale/second process —
/// see B-034's own sidecar-ownership-style caveat) is picked up on the very
/// next call, not stuck stale for the process lifetime.
static MANIFEST_CACHE: Lazy<Mutex<Option<(PathBuf, std::time::SystemTime, ProjectManifest)>>> =
    Lazy::new(|| Mutex::new(None));

/// Cached equivalent of [`load_manifest`] for read-only hot-path callers
/// (`chroma::edit::resolve_timeline`'s `persist: false` case). Callers that
/// need to mutate-then-persist should keep using plain `load_manifest` +
/// [`save_manifest`], which already keeps this cache in sync on every write.
pub fn load_manifest_cached(project_dir: &Path) -> Result<ProjectManifest, String> {
    let mp = project_dir.join("project.json");
    let mtime = std::fs::metadata(&mp)
        .and_then(|m| m.modified())
        .map_err(|e| format!("stat {}: {e}", mp.display()))?;

    {
        let cache = MANIFEST_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((dir, cached_mtime, manifest)) = cache.as_ref() {
            if dir == project_dir && *cached_mtime == mtime {
                return Ok(manifest.clone());
            }
        }
    }

    let manifest = load_manifest(project_dir)?;
    *MANIFEST_CACHE.lock().unwrap_or_else(|e| e.into_inner()) =
        Some((project_dir.to_path_buf(), mtime, manifest.clone()));
    Ok(manifest)
}

pub fn load_manifest(project_dir: &Path) -> Result<ProjectManifest, String> {
    let mp = project_dir.join("project.json");
    let txt = std::fs::read_to_string(&mp).map_err(|e| format!("read {}: {e}", mp.display()))?;
    let mut raw: Value =
        serde_json::from_str(&txt).map_err(|e| format!("parse {}: {e}", mp.display()))?;

    let schema = raw.get("schema").and_then(|s| s.as_str()).unwrap_or("");
    let (major, minor) = parse_schema(schema);
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
    // D-136 — **unconditionally** the current schema, not "only if empty."
    // The position migration below is version-gated and NOT idempotent
    // (dividing twice is silently wrong, not a no-op), so a file that was
    // migrated in memory and then saved back under its own older tag would be
    // migrated again on the next load. Restamping here is what makes the gate
    // hold across a save. A file that is loaded but never saved keeps its old
    // tag on disk and is re-migrated from the same original bytes on the next
    // load — the same answer every time, since the migration is a pure
    // function of the file.
    manifest.schema = SCHEMA.to_string();
    if !manifest.shots.is_empty() && manifest.active_shot >= manifest.shots.len() {
        manifest.active_shot = 0;
    }
    if !manifest.timelines.is_empty() && manifest.active_timeline >= manifest.timelines.len() {
        manifest.active_timeline = 0;
    }
    for tl in &mut manifest.timelines {
        tl.backfill_legacy_positions();
    }
    // D-136 — the one-shot, version-gated unit change on `Clip::position_x`/
    // `position_y`. Runs after `backfill_legacy_positions` purely so all of a
    // legacy file's migrations are in one place and in a fixed order; the two
    // touch different fields and don't interact.
    if minor < NORMALISED_GEOMETRY_MINOR {
        let (cw, ch) = migration_composition_size(&manifest);
        for tl in &mut manifest.timelines {
            tl.normalise_legacy_positions(cw as f64, ch as f64);
        }
    }
    Ok(manifest)
}

/// The composition size D-136's position migration divides by, best-effort and
/// **without probing** — [`load_manifest`] is on the per-preview-frame hot path
/// and a legacy file is re-read (and so re-migrated) until something saves it,
/// so shelling out to `ffprobe` here would be a real cost for a one-line
/// reinterpretation.
///
/// In order: the project's own recorded output spec (D-038 —
/// [`ProjectSettings::width`]/`height`, which every project created since then
/// has); else the resolution already stored on the pool item behind the first
/// clip of the active timeline, which is exactly the clip
/// [`infer_settings_from_clip`] would have derived those settings from and is
/// already on disk; else [`NOMINAL_COMPOSITION`].
fn migration_composition_size(manifest: &ProjectManifest) -> (u32, u32) {
    if let (Some(w), Some(h)) = (manifest.settings.width, manifest.settings.height)
        && w > 0
        && h > 0
    {
        return (w, h);
    }
    let first_clip = manifest
        .timelines
        .get(manifest.active_timeline)
        .and_then(|tl| tl.tracks.iter().find(|t| !t.clips.is_empty()))
        .and_then(|t| t.clips.first());
    let pooled = first_clip.and_then(|c| {
        manifest
            .media
            .iter()
            .find(|m| {
                c.media_id.as_deref() == Some(m.id.as_str()) || m.source_path == c.source_path
            })
            .and_then(|m| m.video.as_ref())
    });
    match pooled {
        Some(v) if v.resolution.width > 0 && v.resolution.height > 0 => {
            (v.resolution.width, v.resolution.height)
        }
        _ => NOMINAL_COMPOSITION,
    }
}

/// Pretty-print `manifest` to `<project_dir>/project.json` (creating the dir),
/// **atomically** — write a uniquely-named temp file in the same directory,
/// then `rename` it over `project.json`.
///
/// B-034/D-112: this used to be a plain `std::fs::write`, which truncates the
/// destination to zero and then streams the new bytes in — so for the whole
/// duration of the write there is a real window where a concurrent reader sees
/// an empty or half-written file. That is not a theoretical race here:
/// [`load_manifest`] is called on a genuinely hot path — `chroma::edit`'s
/// `resolve_timeline` re-reads and re-parses `project.json` from disk on
/// **every single preview frame** (`chroma_timeline_frame`, so once per frame
/// while scrubbing or playing back), while `chroma_timeline_set` writes it
/// every 400ms (the Edit tab's debounced save) throughout a drag or trim. A
/// torn read surfaces as `parse project.json: EOF while parsing…` out of
/// `chroma_timeline_get`, which the Edit tab then rendered as "No project
/// open" — one of the several distinct faults that all presented as that same
/// screen (see B-034's cross-reference list in `docs/BUGS.md`).
///
/// `rename(2)` within a directory is atomic on every filesystem we target, so
/// a reader now always observes either the complete previous manifest or the
/// complete new one, never a partial file. The temp name carries the process
/// id and a counter so two concurrent savers can't clobber each other's
/// staging file.
pub fn save_manifest(project_dir: &Path, manifest: &ProjectManifest) -> Result<(), String> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);

    std::fs::create_dir_all(project_dir)
        .map_err(|e| format!("create {}: {e}", project_dir.display()))?;
    let pretty = serde_json::to_string_pretty(manifest).map_err(|e| e.to_string())?;

    let final_path = project_dir.join("project.json");
    let tmp_path = project_dir.join(format!(
        ".project.json.{}.{}.tmp",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));

    std::fs::write(&tmp_path, format!("{pretty}\n"))
        .map_err(|e| format!("write {}: {e}", tmp_path.display()))?;
    if let Err(e) = std::fs::rename(&tmp_path, &final_path) {
        // Don't leave the staging file behind if the swap itself failed.
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!("replace project.json: {e}"));
    }

    // D-114 — keep `MANIFEST_CACHE` in sync with what we just wrote, rather
    // than relying solely on the next cached read's mtime check to notice.
    // Real, not theoretical: two writes landing within the same filesystem
    // mtime tick (coarse on some platforms/filesystems) could otherwise let
    // a cached read serve the FIRST write's content after the second one
    // already landed. Re-stat the file we just renamed into place rather
    // than trusting `SystemTime::now()`, so the cached mtime always matches
    // what a fresh stat of the real file would report.
    if let Ok(mtime) = std::fs::metadata(&final_path).and_then(|m| m.modified()) {
        *MANIFEST_CACHE.lock().unwrap_or_else(|e| e.into_inner()) =
            Some((project_dir.to_path_buf(), mtime, manifest.clone()));
    }
    Ok(())
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
    // D-070: every seed path lands in the pool first (find-or-create, probed),
    // then a `chroma_timeline::Clip` referencing it on a fresh timeline — the
    // Edit tab's timeline is the single source of truth for what's gradable
    // now, not a separate `ProjectShot` list (see the module doc).
    if !media_paths.is_empty() {
        let timeline = Timeline {
            id: uuid::Uuid::new_v4().to_string(),
            name: clean.clone(),
            rate: None,
            tracks: Vec::new(),
            markers: Vec::new(),
        };
        manifest.timelines.push(timeline);
        manifest.active_timeline = manifest.timelines.len() - 1;
        let idx = manifest.active_timeline;
        for p in media_paths {
            let media_id = find_or_create_media(&mut manifest, p, None);
            append_media_clip(&mut manifest, idx, &media_id)?;
        }
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

/// Permanently delete a `.chroma` project directory and everything in it —
/// `project.json`, cached thumbnail, grade files, timeline data. Irreversible:
/// plain `std::fs::remove_dir_all`, no trash/recycle-bin semantics.
///
/// Validated the same way [`scan_projects`] already validates a CANDIDATE
/// project before ever listing it (a real directory, `.chroma` extension,
/// `project.json` present) — refuses anything that doesn't look like a real
/// project rather than blindly removing whatever path a caller hands in, so a
/// stray/mistaken path errors instead of silently deleting something else.
pub fn delete_project_at(project_dir: &Path) -> Result<(), String> {
    if !project_dir.is_dir() {
        return Err(format!("{} is not a directory", project_dir.display()));
    }
    if project_dir.extension().and_then(|e| e.to_str()) != Some("chroma") {
        return Err(format!(
            "{} is not a .chroma project",
            project_dir.display()
        ));
    }
    if !project_dir.join("project.json").is_file() {
        return Err(format!(
            "{} has no project.json — refusing to delete",
            project_dir.display()
        ));
    }
    std::fs::remove_dir_all(project_dir)
        .map_err(|e| format!("delete {}: {e}", project_dir.display()))?;

    // Drop a stale `MANIFEST_CACHE` entry for the now-deleted directory
    // rather than leaving `load_manifest_cached` able to serve a phantom
    // read for a path that no longer exists on disk.
    let mut cache = MANIFEST_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if matches!(cache.as_ref(), Some((dir, _, _)) if dir == project_dir) {
        *cache = None;
    }
    Ok(())
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

    /// synthesise a tiny `testsrc` clip with ffmpeg; `None` if ffmpeg is absent.
    /// `duration_s` (D-059): most callers just need *a* probe-able clip and
    /// pass `1`; the Phase B1 multi-track resolution test needs two clips of
    /// **different** lengths (so a query position can land past one track's
    /// clip but still inside the other's), hence the parameter.
    fn make_test_clip(tag: &str, w: u32, h: u32, rate: &str, duration_s: u32) -> Option<PathBuf> {
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
            .arg(format!(
                "testsrc=size={w}x{h}:rate={rate}:duration={duration_s}"
            ))
            .args(["-pix_fmt", "yuv420p"])
            .arg(&out)
            .status()
            .ok()?;
        (status.success() && out.exists()).then_some(out)
    }

    // ------------------------------------------------------------------ //
    // D-136 — the schema-minor gate on the normalised-position migration.
    // ------------------------------------------------------------------ //

    fn write_project(dir: &Path, json: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("project.json"), json).unwrap();
    }

    // --- unified clip identity (D-070) — grade-file migration ---------------

    fn write_grade_stub(grade_dir: &Path, id: &str) {
        std::fs::create_dir_all(grade_dir).unwrap();
        std::fs::write(
            grade_dir.join(format!("{id}.grade.json")),
            format!(r#"{{"schema":"chroma.grade/1","shot":{{"source":"{id}"}},"adjustments":{{"exposure":0.4}},"notes":""}}"#),
        )
        .unwrap();
    }

    // --- the mandatory real-project verification (D-070) ---------------------
    //
    // Not run by default `cargo test` (machine-specific: needs the owner's
    // real `~/Movies/Chroma/New.chroma`, which won't exist on another
    // checkout or in CI) — run explicitly with
    // `cargo test -p chroma --lib chroma::project::tests::migration_against_the_real_owner_project -- --ignored --nocapture`.
    // Operates on a scratch **copy**; never touches the live project.

    fn copy_dir_recursive(src: &Path, dst: &Path) {
        std::fs::create_dir_all(dst).unwrap();
        for entry in std::fs::read_dir(src).unwrap() {
            let entry = entry.unwrap();
            let from = entry.path();
            let to = dst.join(entry.file_name());
            if entry.file_type().unwrap().is_dir() {
                copy_dir_recursive(&from, &to);
            } else {
                std::fs::copy(&from, &to).unwrap();
            }
        }
    }

    /// B-034/D-112 — the real regression test for the torn-manifest race: one
    /// thread saves the manifest in a tight loop while another `load_manifest`s
    /// it in a tight loop, exactly the shape the live app produces (the Edit
    /// tab's debounced `chroma_timeline_set` writing while
    /// `chroma_timeline_frame` re-reads the manifest once per preview frame).
    ///
    /// Before the atomic-rename fix this failed reliably — the reader observed
    /// an empty or half-written file and `load_manifest` came back
    /// `Err("parse …: EOF while parsing…")`, which is precisely what the Edit
    /// tab was rendering as "No project open". Every read must now succeed.
    #[test]
    fn concurrent_saves_never_expose_a_torn_manifest() {
        let root = tmp("atomic_save");
        let (dir, mut manifest) = new_project_in(
            &root,
            "Torn Read",
            &["/a.mov".into(), "/b.mov".into(), "/c.mov".into()],
        )
        .unwrap();

        // Pad the manifest out so a non-atomic write takes long enough for a
        // reader to land inside it — a real project is this size and larger.
        for i in 0..400 {
            let seed = manifest.timelines[0].tracks[0].clips[0].clone();
            manifest.timelines[0].tracks[0].clips.push(Clip {
                id: format!("padding-clip-{i}"),
                name: format!("padding clip number {i} with a reasonably long name"),
                source_path: format!("/some/reasonably/long/media/path/clip_{i}.mov"),
                ..seed
            });
        }

        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let writer_dir = dir.clone();
        let writer_stop = stop.clone();
        let writer = std::thread::spawn(move || {
            while !writer_stop.load(std::sync::atomic::Ordering::Relaxed) {
                save_manifest(&writer_dir, &manifest).expect("save");
            }
        });

        let mut reads = 0usize;
        let mut failures = Vec::new();
        for _ in 0..600 {
            match load_manifest(&dir) {
                Ok(_) => reads += 1,
                Err(e) => failures.push(e),
            }
        }
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        writer.join().expect("writer thread");

        assert_eq!(reads, 600, "some reads failed: {failures:?}");
        assert!(
            failures.is_empty(),
            "load_manifest saw a torn write ({} of 600): {failures:?}",
            failures.len()
        );

        // No staging files left lying around next to the real manifest.
        let strays: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(strays.is_empty(), "temp files left behind: {strays:?}");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// D-114 — real before/after numbers for the manifest-cache fix, not a
    /// vague "feels faster" claim. Simulates `resolve_timeline`'s real call
    /// pattern: `chroma_timeline_frame` calls this once per preview frame
    /// while scrubbing/playing, with `project.json` untouched between calls
    /// (the common case — most frames aren't also a save tick). Padded to a
    /// realistic size (same padding shape as the torn-read test above; the
    /// owner's own real `New.chroma/project.json` is ~8.9KB, this lands in
    /// the same range).
    #[test]
    fn manifest_cache_is_real_measured_faster_than_a_reread_per_frame() {
        let root = tmp("cache_perf");
        let (dir, mut manifest) = new_project_in(
            &root,
            "Cache Perf",
            &["/a.mov".into(), "/b.mov".into(), "/c.mov".into()],
        )
        .unwrap();
        for i in 0..400 {
            let seed = manifest.timelines[0].tracks[0].clips[0].clone();
            manifest.timelines[0].tracks[0].clips.push(Clip {
                id: format!("padding-clip-{i}"),
                name: format!("padding clip number {i} with a reasonably long name"),
                source_path: format!("/some/reasonably/long/media/path/clip_{i}.mov"),
                ..seed
            });
        }
        save_manifest(&dir, &manifest).unwrap();

        const N: u32 = 600; // ~10-20s of playback at 30-60fps — one real scrub/play session

        // Warm the cache once, matching real usage (the very first frame is
        // always a real read either way — this isolates the steady-state
        // "nothing changed between frames" cost the fix actually targets).
        load_manifest_cached(&dir).unwrap();

        let uncached_start = std::time::Instant::now();
        for _ in 0..N {
            load_manifest(&dir).unwrap();
        }
        let uncached_elapsed = uncached_start.elapsed();

        let cached_start = std::time::Instant::now();
        for _ in 0..N {
            load_manifest_cached(&dir).unwrap();
        }
        let cached_elapsed = cached_start.elapsed();

        println!(
            "D-114 manifest read, {N} calls, {} bytes: uncached (old) {:?} total, {:?}/call — cached (new) {:?} total, {:?}/call — {:.1}x faster",
            std::fs::metadata(dir.join("project.json")).unwrap().len(),
            uncached_elapsed,
            uncached_elapsed / N,
            cached_elapsed,
            cached_elapsed / N,
            uncached_elapsed.as_secs_f64() / cached_elapsed.as_secs_f64().max(1e-9),
        );

        // Real assertion, not just a printout: the cache must be
        // meaningfully faster in the steady state, not marginally.
        assert!(
            cached_elapsed.as_secs_f64() * 3.0 < uncached_elapsed.as_secs_f64(),
            "expected the cache to be at least 3x faster in the steady state; \
             uncached={uncached_elapsed:?} cached={cached_elapsed:?}"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn new_project_creates_dir_and_manifest() {
        // D-070: a fresh project's seed media lands on the new timeline as
        // clips, not `ProjectShot`s — see the module doc.
        let root = tmp("new");
        let (dir, manifest) =
            new_project_in(&root, "My Shoot", &["/a.mov".into(), "/b.mov".into()]).unwrap();
        assert!(dir.ends_with("My Shoot.chroma"));
        assert!(dir.join("project.json").is_file());
        assert!(dir.join("grades").is_dir());
        assert_eq!(manifest.schema, SCHEMA);
        assert!(
            manifest.shots.is_empty(),
            "no ProjectShot is created any more"
        );
        assert_eq!(manifest.timelines.len(), 1);
        let clips = &manifest.timelines[0].tracks[0].clips;
        assert_eq!(clips.len(), 2);
        assert_ne!(clips[0].id, clips[1].id);
        assert_eq!(clips[0].name, "a.mov");
        assert_eq!(
            manifest.active_clip_id.as_deref(),
            Some(clips[1].id.as_str()),
            "the most recently appended clip is active — matches the old \
             add_shot_for_media semantics (last added = active)"
        );

        // creating it again is refused
        assert!(new_project_in(&root, "My Shoot", &[]).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn manifest_round_trips() {
        let root = tmp("roundtrip");
        let (dir, mut manifest) =
            new_project_in(&root, "grade-job", &["/shoot/A001.mov".into()]).unwrap();
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
        assert!(reloaded.shots.is_empty());
        let clip = &reloaded.timelines[0].tracks[0].clips[0];
        assert_eq!(clip.source_path, "/shoot/A001.mov");
        assert_eq!(reloaded.active_clip_id.as_deref(), Some(clip.id.as_str()));
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
    fn delete_project_at_removes_a_real_project_directory() {
        let root = tmp("delete_ok");
        let (dir, _manifest) = new_project_in(&root, "throwaway", &[]).unwrap();
        assert!(dir.is_dir());
        assert!(dir.join("project.json").is_file());

        delete_project_at(&dir).unwrap();
        assert!(!dir.exists());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn delete_project_at_refuses_a_directory_with_no_project_json() {
        let root = tmp("delete_no_manifest");
        let fake = root.join("not-a-project.chroma");
        std::fs::create_dir_all(&fake).unwrap();

        let err = delete_project_at(&fake).unwrap_err();
        assert!(err.contains("no project.json"), "unexpected error: {err}");
        assert!(
            fake.exists(),
            "must not delete a directory with no project.json"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn delete_project_at_refuses_a_non_chroma_extension() {
        let root = tmp("delete_wrong_ext");
        let fake = root.join("some-other-folder");
        std::fs::create_dir_all(&fake).unwrap();
        std::fs::write(fake.join("project.json"), "{}").unwrap();

        let err = delete_project_at(&fake).unwrap_err();
        assert!(
            err.contains("not a .chroma project"),
            "unexpected error: {err}"
        );
        assert!(fake.exists(), "must not delete a non-.chroma directory");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn new_project_infers_settings_from_first_clip() {
        // needs ffmpeg to synthesise a probe-able clip; skip cleanly without it.
        let Some(clip) = make_test_clip("infer", 176, 144, "25", 1) else {
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

    #[test]
    fn new_project_seeds_source_fps_from_the_real_probe_b082() {
        // B-082: `append_media_clip`'s `..Default::default()` silently left
        // `source_fps` at `None` even though the probe sitting right above it
        // already had the real rate — every fps-aware consumer then fell back
        // to the timeline's own fps for a clip whose native rate differs.
        // 25fps here vs. the project's default 24fps timeline is exactly that
        // mismatch: pre-fix, a null `source_fps` and a false-agreement with
        // 24fps would have been indistinguishable, so it has to differ.
        let Some(clip) = make_test_clip("b082", 176, 144, "25", 1) else {
            eprintln!("skip: ffmpeg not on PATH");
            return;
        };
        let root = tmp("b082_source_fps");
        let (dir, manifest) =
            new_project_in(&root, "b082", &[clip.to_string_lossy().to_string()]).unwrap();
        let placed = &manifest.timelines[manifest.active_timeline].tracks[0].clips[0];
        assert_eq!(
            placed.source_fps,
            Some(25.0),
            "a freshly created clip must carry its own probed fps, not None"
        );

        // and it survives the save/reload round trip (B-078's own regression)
        let reloaded = load_manifest(&dir).unwrap();
        let reloaded_clip = &reloaded.timelines[reloaded.active_timeline].tracks[0].clips[0];
        assert_eq!(reloaded_clip.source_fps, Some(25.0));

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_file(&clip);
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

    /// A `chroma.project/1` file's pixel positions are reinterpreted against
    /// the project's own recorded composition (D-038 `settings`), and the
    /// loaded manifest is restamped to the current schema so the same file,
    /// once saved, is never migrated a second time. That restamp is the whole
    /// gate: this migration divides, so running it twice is silently wrong,
    /// not a no-op.
    #[test]
    fn legacy_positions_are_normalised_once_and_the_schema_restamped() {
        let root = tmp("d136-gate");
        let dir = root.join("pip.chroma");
        write_project(
            &dir,
            r#"{"schema":"chroma.project/1","name":"pip","shots":[],
                "settings":{"width":1920,"height":1080},
                "timelines":[{"id":"t","name":"t","tracks":[{"kind":"video","clips":[
                  {"id":"a","name":"A","source_path":"/a.mov","source_start":0,"duration":10,
                   "source_len":10,"start_frame":0,"position_x":480.0,"position_y":270.0}
                ],"gain":1.0,"locked":false,"hidden":false,"sync_locked":true}]}],
                "activeTimeline":0}"#,
        );

        let m = load_manifest(&dir).unwrap();
        let c = &m.timelines[0].tracks[0].clips[0];
        assert_eq!((c.position_x, c.position_y), (0.25, 0.25));
        assert_eq!(m.schema, SCHEMA, "the load must restamp the schema");

        // save it back (what any edit does) and reload: the gate holds, the
        // value is not divided a second time.
        save_manifest(&dir, &m).unwrap();
        let again = load_manifest(&dir).unwrap();
        let c2 = &again.timelines[0].tracks[0].clips[0];
        assert_eq!(
            (c2.position_x, c2.position_y),
            (0.25, 0.25),
            "migrated twice"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A project with no `settings` falls back to the resolution already
    /// stored on the pool item behind its first clip — no probe, no
    /// `NOMINAL_COMPOSITION` guess, for the case where the real answer is
    /// sitting in the same file.
    #[test]
    fn the_migration_falls_back_to_the_pool_resolution() {
        let root = tmp("d136-pool");
        let dir = root.join("nosettings.chroma");
        write_project(
            &dir,
            r#"{"schema":"chroma.project/1","name":"n","shots":[],
                "media":[{"id":"m1","sourcePath":"/a.mov","name":"A","added":"",
                          "video":{"width":1280,"height":720,"fps":24.0,
                                   "frameCount":10,"durationSecs":0.4}}],
                "timelines":[{"id":"t","name":"t","tracks":[{"kind":"video","clips":[
                  {"id":"a","media_id":"m1","name":"A","source_path":"/a.mov","source_start":0,
                   "duration":10,"source_len":10,"start_frame":0,"position_x":320.0,"position_y":180.0}
                ],"gain":1.0,"locked":false,"hidden":false,"sync_locked":true}]}],
                "activeTimeline":0}"#,
        );
        let m = load_manifest(&dir).unwrap();
        let c = &m.timelines[0].tracks[0].clips[0];
        assert_eq!((c.position_x, c.position_y), (0.25, 0.25));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A file already tagged at the current schema is left alone — the gate
    /// reads the file's own minor, not just its major.
    #[test]
    fn a_current_schema_file_is_not_migrated() {
        let root = tmp("d136-current");
        let dir = root.join("new.chroma");
        write_project(
            &dir,
            &format!(
                r#"{{"schema":"{SCHEMA}","name":"n","shots":[],
                    "settings":{{"width":1920,"height":1080}},
                    "timelines":[{{"id":"t","name":"t","tracks":[{{"kind":"video","clips":[
                      {{"id":"a","name":"A","source_path":"/a.mov","source_start":0,"duration":10,
                       "source_len":10,"start_frame":0,"position_x":0.25,"position_y":0.25}}
                    ],"gain":1.0,"locked":false,"hidden":false,"sync_locked":true}}]}}],
                    "activeTimeline":0}}"#
            ),
        );
        let m = load_manifest(&dir).unwrap();
        let c = &m.timelines[0].tracks[0].clips[0];
        assert_eq!((c.position_x, c.position_y), (0.25, 0.25));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn schema_tag_parses_into_major_and_minor() {
        assert_eq!(parse_schema("chroma.project/1"), (Some(1), 0));
        assert_eq!(parse_schema("chroma.project/1.1"), (Some(1), 1));
        assert_eq!(parse_schema("chroma.project/2.7"), (Some(2), 7));
        assert_eq!(parse_schema(""), (None, 0));
        assert_eq!(parse_schema("something-else"), (None, 0));
        // the constant this file ships must itself be at (or past) the minor
        // the migration gate keys on, or every load would re-migrate.
        assert!(parse_schema(SCHEMA).1 >= NORMALISED_GEOMETRY_MINOR);
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
        let Some(clip) = make_test_clip("media_probe", 320, 240, "30", 1) else {
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

    // --- has_audio, the A/V-link signal (D-129) ----------------------------

    /// The whole backward-compat story for `MediaVideoInfo::has_audio`: a
    /// pool item saved before D-129 has no key at all, and must load as the
    /// **unknown** sentinel (`None`) — NOT as `false`, which a bare `bool`
    /// would have given and which is indistinguishable from a genuinely
    /// silent source. Everything downstream keys off that distinction.
    #[test]
    fn legacy_media_json_without_has_audio_loads_as_unknown_not_silent() {
        let legacy = r#"{"id":"m1","sourcePath":"/a.mov","name":"a.mov","added":"2026-01-01T00:00:00Z",
            "video":{"width":1920,"height":1080,"fps":24.0,"frameCount":100,"durationSecs":4.16}}"#;
        let item: MediaItem = serde_json::from_str(legacy).unwrap();
        let v = item.video.expect("video facts present");
        assert_eq!(v.frame_count, 100, "the pre-D-129 fields are unaffected");
        assert_eq!(
            v.has_audio, None,
            "absent means never probed, not 'no audio' — the migration sentinel"
        );
    }

    /// A known value round-trips, and `None` stays off the wire entirely
    /// (`skip_serializing_if`), so an unresolved item's JSON is byte-identical
    /// to what a pre-D-129 build wrote.
    #[test]
    fn has_audio_round_trips_and_none_omits_the_key() {
        let mut v = MediaVideoInfo {
            resolution: chroma_types::Resolution {
                width: 1920,
                height: 1080,
            },
            fps: 24.0,
            frame_count: 100,
            duration_secs: 4.16,
            has_audio: Some(true),
        };
        let json = serde_json::to_string(&v).unwrap();
        assert!(json.contains("\"hasAudio\":true"), "{json}");
        let back: MediaVideoInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(back.has_audio, Some(true));

        v.has_audio = None;
        let json2 = serde_json::to_string(&v).unwrap();
        assert!(!json2.contains("hasAudio"), "None omits the key: {json2}");
    }

    /// `backfill_has_audio` is the one-time migration that resolves the
    /// sentinel. Three real properties: an already-resolved item is left
    /// alone (so the pass is idempotent and does no I/O on a settled
    /// project), an item whose source can't be probed stays **unknown**
    /// rather than being falsely recorded as silent, and "nothing changed"
    /// is reported as `false` so the caller skips the manifest write.
    #[test]
    fn backfill_has_audio_is_idempotent_and_never_guesses_silent() {
        let root = tmp("has_audio_backfill");
        let (_dir, mut manifest) = new_project_in(&root, "has-audio", &[]).unwrap();

        let info = |has: Option<bool>| MediaVideoInfo {
            resolution: chroma_types::Resolution {
                width: 640,
                height: 360,
            },
            fps: 24.0,
            frame_count: 10,
            duration_secs: 0.41,
            has_audio: has,
        };
        manifest.media.push(MediaItem {
            id: "resolved".into(),
            source_path: "/nonexistent-resolved.mov".into(),
            name: "resolved".into(),
            added: now_rfc3339(),
            video: Some(info(Some(true))),
            folder: None,
        });
        manifest.media.push(MediaItem {
            id: "unprobeable".into(),
            source_path: root
                .join("definitely-not-a-real-file.mov")
                .to_string_lossy()
                .to_string(),
            name: "unprobeable".into(),
            added: now_rfc3339(),
            video: Some(info(None)),
            folder: None,
        });
        // An item that never probed at all (`video: None`) is skipped
        // outright — there are no video facts to attach an answer to.
        manifest.media.push(MediaItem {
            id: "no-video-facts".into(),
            source_path: "/nonexistent-offline.mov".into(),
            name: "offline".into(),
            added: now_rfc3339(),
            video: None,
            folder: None,
        });

        assert!(
            !backfill_has_audio(&mut manifest),
            "nothing resolvable changed, so the caller must not rewrite the manifest"
        );
        assert_eq!(
            manifest.media[0].video.as_ref().unwrap().has_audio,
            Some(true),
            "an already-resolved item is untouched"
        );
        assert_eq!(
            manifest.media[1].video.as_ref().unwrap().has_audio,
            None,
            "an unprobeable source stays UNKNOWN — never falsely recorded as silent"
        );
        assert!(manifest.media[2].video.is_none());

        let _ = std::fs::remove_dir_all(&root);
    }

    /// The end-to-end shape the Edit tab depends on: importing a real clip
    /// records a **definite** answer, so a freshly-imported item can decide
    /// about a linked audio half on drop without waiting for any backfill.
    /// (The synthesised fixture is silent, so the answer here is `Some(false)`
    /// — the point being that it is `Some`, not the unknown sentinel.)
    #[test]
    fn add_media_records_a_definite_has_audio_for_a_real_clip() {
        let Some(clip) = make_test_clip("has_audio_probe", 320, 240, "30", 1) else {
            eprintln!("skip: ffmpeg not on PATH");
            return;
        };
        let root = tmp("has_audio_import");
        let (_dir, mut manifest) = new_project_in(&root, "has-audio-import", &[]).unwrap();
        let added = add_media(&mut manifest, &[clip.to_string_lossy().to_string()], None);
        let v = added[0]
            .video
            .as_ref()
            .expect("a real clip probes successfully");
        assert!(
            v.has_audio.is_some(),
            "a real probe always yields a definite answer, never the unknown sentinel"
        );
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_file(&clip);
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

    // --- shots/media unification (D-046) ------------------------------------

    #[test]
    fn new_project_clips_reference_pool_items_not_paths() {
        // D-070: a fresh project no longer creates a `ProjectShot` — the
        // seed media lands directly on the new timeline as a `Clip`
        // referencing the pool item via `media_id`.
        let root = tmp("unify_new_project");
        let a = root.join("a.mov").to_string_lossy().to_string();
        let (_dir, manifest) = new_project_in(&root, "unify", &[a.clone()]).unwrap();
        assert_eq!(manifest.media.len(), 1, "the seed path lands in the pool");
        assert!(
            manifest.shots.is_empty(),
            "no ProjectShot is created any more"
        );
        assert_eq!(manifest.timelines.len(), 1);
        let clip = &manifest.timelines[0].tracks[0].clips[0];
        assert_eq!(
            clip.media_id.as_deref(),
            Some(manifest.media[0].id.as_str()),
            "the clip references the pool item, not the path directly"
        );
        assert_eq!(clip.source_path, a);
        assert_eq!(clip.name, "a.mov");
        assert_eq!(
            manifest.active_clip_id.as_deref(),
            Some(clip.id.as_str()),
            "the seeded clip becomes active"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn shot_survives_its_media_item_being_renamed_and_moved() {
        // renaming/re-filing the pool item (not the shot) is exactly what
        // "the pool is the source of truth" buys — a (legacy, hand-built)
        // shot still resolves correctly with zero shot-side changes.
        // `ProjectShot` is read-only/legacy as of D-070 (see the module
        // doc), so this test builds one directly rather than via
        // `new_project_in` (which no longer produces any).
        let root = tmp("unify_rename");
        let a = root.join("a.mov").to_string_lossy().to_string();
        let mut manifest = ProjectManifest::fresh("unify-rename");
        let media_id = find_or_create_media(&mut manifest, &a, None);
        let shot = ProjectShot {
            id: "s1".into(),
            media_id: media_id.clone(),
            frame: 0,
        };
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
        // (no process-state guard: despite the name, this test only
        // exercises `load_manifest` + `resolve_shot` — the guard it used to
        // take was for `chroma::state`, which stayed in `app/src-tauri`.)
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
    fn append_media_clip_references_an_existing_pool_item() {
        // the sync model half of the repurposed `chroma_project_add_shot` —
        // the Sources panel's "add to grading" action on a pool-only item.
        // The state-taking command wrapper itself (open_manifest
        // integration) is verified live against the real project, same as
        // the other state-taking commands in this module (none are
        // unit-tested directly — see `open_manifest`'s doc).
        let root = tmp("unify_add_shot");
        let (_dir, mut manifest) = new_project_in(&root, "unify-add-shot", &[]).unwrap();
        assert!(manifest.timelines.is_empty(), "no media seeded yet");
        manifest.timelines.push(Timeline {
            id: "t1".into(),
            name: "unify-add-shot".into(),
            rate: None,
            tracks: Vec::new(),
            markers: Vec::new(),
        });
        manifest.active_timeline = 0;

        let path = root.join("pool-only.mov").to_string_lossy().to_string();
        add_media(&mut manifest, &[path.clone()], None);
        assert!(
            manifest.timelines[0].tracks.is_empty(),
            "a plain pool import creates no clip"
        );
        let media_id = manifest.media[0].id.clone();

        let clip = append_media_clip(&mut manifest, 0, &media_id).unwrap();
        assert_eq!(
            manifest.timelines[0].tracks.len(),
            1,
            "a video track is created"
        );
        assert_eq!(manifest.timelines[0].tracks[0].clips.len(), 1);
        assert_eq!(clip.media_id.as_deref(), Some(media_id.as_str()));
        assert_eq!(clip.start_frame, 0);
        assert_eq!(
            manifest.active_clip_id.as_deref(),
            Some(clip.id.as_str()),
            "the appended clip becomes active"
        );
        assert_eq!(manifest.media_for(&media_id).unwrap().source_path, path);

        // a second append lands back-to-back after the first, not on top of it
        let clip2 = append_media_clip(&mut manifest, 0, &media_id).unwrap();
        assert_eq!(
            clip2.start_frame, clip.duration,
            "appended after the first clip"
        );
        assert_eq!(manifest.timelines[0].tracks[0].clips.len(), 2);

        // an unknown media id errors rather than creating a dangling clip
        assert!(append_media_clip(&mut manifest, 0, "no-such-media").is_err());
        assert_eq!(
            manifest.timelines[0].tracks[0].clips.len(),
            2,
            "the failed append did not add a clip"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn remove_clip_by_id_lifts_it_and_clears_active_clip() {
        let root = tmp("unify_remove_clip");
        let (_dir, mut manifest) = new_project_in(&root, "unify-remove-clip", &[]).unwrap();
        manifest.timelines.push(Timeline {
            id: "t1".into(),
            name: "x".into(),
            rate: None,
            tracks: Vec::new(),
            markers: Vec::new(),
        });
        manifest.active_timeline = 0;
        let path = root.join("a.mov").to_string_lossy().to_string();
        let media_id = find_or_create_media(&mut manifest, &path, None);
        let clip = append_media_clip(&mut manifest, 0, &media_id).unwrap();
        assert_eq!(manifest.active_clip_id.as_deref(), Some(clip.id.as_str()));

        remove_clip_by_id(&mut manifest, 0, &clip.id).unwrap();
        // B-038 — the clip was the track's only one, so D-123 prunes the track
        // itself rather than leaving it behind empty. The old assertion indexed
        // `tracks[0]` unconditionally and panicked outright ("len is 0 but the
        // index is 0") once that shipped; what it was really checking is that
        // the clip is gone, which is now true by the track being gone.
        assert!(
            manifest.timelines[0].tracks.is_empty(),
            "the track the last clip was lifted from is pruned"
        );
        assert_eq!(
            manifest.active_clip_id, None,
            "removing the active clip clears the pointer"
        );

        assert!(
            remove_clip_by_id(&mut manifest, 0, &clip.id).is_err(),
            "already gone"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn migrate_shot_grades_to_clips_migrates_the_clean_1to1_case() {
        let root = tmp("unify_migrate_clean");
        let grade_dir = root.join("grades");
        write_grade_stub(&grade_dir, "shot-1");

        let mut manifest = ProjectManifest::fresh("x");
        manifest.shots.push(ProjectShot {
            id: "shot-1".into(),
            media_id: "m1".into(),
            frame: 0,
        });
        manifest.media.push(MediaItem {
            id: "m1".into(),
            source_path: "/a.mov".into(),
            name: "a.mov".into(),
            added: String::new(),
            video: None,
            folder: None,
        });
        // a clip built after D-070 (drag-from-Sources): its own fresh id,
        // linked to the same pool item via media_id — not shot_id.
        manifest.timelines.push(Timeline {
            id: "t1".into(),
            name: "x".into(),
            rate: None,
            tracks: vec![chroma_timeline::Track {
                kind: TrackKind::Video,
                clips: vec![Clip {
                    id: "clip-xyz".into(),
                    media_id: Some("m1".into()),
                    name: "a.mov".into(),
                    source_path: "/a.mov".into(),
                    duration: 10,
                    source_len: 10,
                    start_frame: 0,
                    ..Default::default()
                }],
                ..Default::default()
            }],
            markers: Vec::new(),
        });

        let report = migrate_shot_grades_to_clips(&manifest, &grade_dir);
        assert_eq!(report.migrated, 1);
        assert!(report.warnings.is_empty(), "{:?}", report.warnings);
        assert!(!grade_dir.join("shot-1.grade.json").exists());
        assert!(grade_dir.join("clip-xyz.grade.json").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn migrate_shot_grades_to_clips_warns_and_keeps_the_file_when_no_clip_matches() {
        // the real-world case: a shot was graded but never dragged onto the
        // Edit tab's timeline — zero matching clips. Must warn, not error,
        // not drop the grade file.
        let root = tmp("unify_migrate_unmatched");
        let grade_dir = root.join("grades");
        write_grade_stub(&grade_dir, "shot-1");

        let mut manifest = ProjectManifest::fresh("x");
        manifest.shots.push(ProjectShot {
            id: "shot-1".into(),
            media_id: "m1".into(),
            frame: 0,
        });
        manifest.media.push(MediaItem {
            id: "m1".into(),
            source_path: "/a.mov".into(),
            name: "a.mov".into(),
            added: String::new(),
            video: None,
            folder: None,
        });
        manifest.timelines.push(Timeline {
            id: "t1".into(),
            name: "x".into(),
            rate: None,
            tracks: Vec::new(),
            markers: Vec::new(),
        });

        let report = migrate_shot_grades_to_clips(&manifest, &grade_dir);
        assert_eq!(report.migrated, 0);
        assert_eq!(report.warnings.len(), 1);
        assert!(
            report.warnings[0].contains("shot-1"),
            "{:?}",
            report.warnings
        );
        assert!(
            grade_dir.join("shot-1.grade.json").exists(),
            "the grade file is left exactly where it was — nothing dropped"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn migrate_shot_grades_to_clips_warns_on_ambiguous_multiple_matches() {
        let root = tmp("unify_migrate_ambiguous");
        let grade_dir = root.join("grades");
        write_grade_stub(&grade_dir, "shot-1");

        let mut manifest = ProjectManifest::fresh("x");
        manifest.shots.push(ProjectShot {
            id: "shot-1".into(),
            media_id: "m1".into(),
            frame: 0,
        });
        manifest.media.push(MediaItem {
            id: "m1".into(),
            source_path: "/a.mov".into(),
            name: "a.mov".into(),
            added: String::new(),
            video: None,
            folder: None,
        });
        let clip = |id: &str| Clip {
            id: id.into(),
            media_id: Some("m1".into()),
            name: "a.mov".into(),
            source_path: "/a.mov".into(),
            duration: 10,
            source_len: 10,
            start_frame: 0,
            ..Default::default()
        };
        manifest.timelines.push(Timeline {
            id: "t1".into(),
            name: "x".into(),
            rate: None,
            tracks: vec![chroma_timeline::Track {
                kind: TrackKind::Video,
                clips: vec![clip("clip-a"), clip("clip-b")],
                ..Default::default()
            }],
            markers: Vec::new(),
        });

        let report = migrate_shot_grades_to_clips(&manifest, &grade_dir);
        assert_eq!(report.migrated, 0);
        assert_eq!(report.warnings.len(), 1);
        assert!(
            report.warnings[0].contains("2 clips"),
            "{:?}",
            report.warnings
        );
        assert!(grade_dir.join("shot-1.grade.json").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn migrate_shot_grades_to_clips_is_idempotent() {
        let root = tmp("unify_migrate_idempotent");
        let grade_dir = root.join("grades");
        write_grade_stub(&grade_dir, "shot-1");

        let mut manifest = ProjectManifest::fresh("x");
        manifest.shots.push(ProjectShot {
            id: "shot-1".into(),
            media_id: "m1".into(),
            frame: 0,
        });
        manifest.media.push(MediaItem {
            id: "m1".into(),
            source_path: "/a.mov".into(),
            name: "a.mov".into(),
            added: String::new(),
            video: None,
            folder: None,
        });
        manifest.timelines.push(Timeline {
            id: "t1".into(),
            name: "x".into(),
            rate: None,
            tracks: vec![chroma_timeline::Track {
                kind: TrackKind::Video,
                clips: vec![Clip {
                    id: "clip-xyz".into(),
                    media_id: Some("m1".into()),
                    name: "a.mov".into(),
                    source_path: "/a.mov".into(),
                    duration: 10,
                    source_len: 10,
                    start_frame: 0,
                    ..Default::default()
                }],
                ..Default::default()
            }],
            markers: Vec::new(),
        });

        let first = migrate_shot_grades_to_clips(&manifest, &grade_dir);
        assert_eq!(first.migrated, 1);

        // running it again: the shot's old grade file no longer exists —
        // real no-op, no warning, nothing (re-)migrated.
        let second = migrate_shot_grades_to_clips(&manifest, &grade_dir);
        assert_eq!(second.migrated, 0);
        assert!(second.warnings.is_empty(), "{:?}", second.warnings);
        assert!(grade_dir.join("clip-xyz.grade.json").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A clip built by `Timeline::from_shots` (the common "project opened
    /// for the first time" case) copies the shot id verbatim as the clip
    /// id — the grade file is already at the right name, a true no-op, not
    /// a warning.
    #[test]
    fn migrate_shot_grades_to_clips_noop_when_clip_id_already_equals_shot_id() {
        let root = tmp("unify_migrate_same_id");
        let grade_dir = root.join("grades");
        write_grade_stub(&grade_dir, "shot-1");

        let mut manifest = ProjectManifest::fresh("x");
        manifest.shots.push(ProjectShot {
            id: "shot-1".into(),
            media_id: "m1".into(),
            frame: 0,
        });
        manifest.media.push(MediaItem {
            id: "m1".into(),
            source_path: "/a.mov".into(),
            name: "a.mov".into(),
            added: String::new(),
            video: None,
            folder: None,
        });
        let tuples = vec![(
            "shot-1".to_string(),
            "/a.mov".to_string(),
            "a.mov".to_string(),
            10i64,
        )];
        manifest.timelines.push(Timeline::from_shots(&tuples));

        let report = migrate_shot_grades_to_clips(&manifest, &grade_dir);
        assert_eq!(report.migrated, 0, "nothing was actually renamed");
        assert!(report.warnings.is_empty(), "{:?}", report.warnings);
        assert!(grade_dir.join("shot-1.grade.json").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_active_clip_index_prefers_active_clip_id_then_legacy_active_shot_then_first() {
        let clips = vec![
            Clip {
                id: "c1".into(),
                media_id: Some("m1".into()),
                name: "A".into(),
                source_path: "/a.mov".into(),
                duration: 5,
                source_len: 5,
                start_frame: 0,
                ..Default::default()
            },
            Clip {
                id: "c2".into(),
                media_id: Some("m2".into()),
                name: "B".into(),
                source_path: "/b.mov".into(),
                duration: 5,
                source_len: 5,
                start_frame: 5,
                ..Default::default()
            },
        ];

        // active_clip_id wins outright when it matches a clip
        let mut m = ProjectManifest::fresh("x");
        m.active_clip_id = Some("c2".into());
        assert_eq!(resolve_active_clip_index(&m, &clips), 1);

        // a stale active_clip_id (matches nothing) falls through to the
        // legacy active_shot/shots fallback
        let mut m2 = ProjectManifest::fresh("x");
        m2.active_clip_id = Some("no-such-clip".into());
        m2.shots.push(ProjectShot {
            id: "s1".into(),
            media_id: "m2".into(),
            frame: 0,
        });
        m2.active_shot = 0;
        assert_eq!(
            resolve_active_clip_index(&m2, &clips),
            1,
            "resolved via media_id match"
        );

        // neither present -> the first clip
        let m3 = ProjectManifest::fresh("x");
        assert_eq!(resolve_active_clip_index(&m3, &clips), 0);

        // no clips at all -> 0 (caller handles the empty case)
        assert_eq!(resolve_active_clip_index(&m3, &[]), 0);
    }

    /// D-056/D-070: `top_wins_clip_index` re-resolves a candidate through
    /// `Timeline::resolve_video_clip_at` — the same real function requirement
    /// #6 of the D-070 dispatch calls for, not a second copy of top-wins
    /// logic. A candidate that's obscured at its own position by a
    /// higher-priority video track's clip is remapped to the clip that
    /// actually wins there.
    #[test]
    fn top_wins_clip_index_prefers_the_real_compositing_winner() {
        let bottom = Clip {
            id: "bottom".into(),
            name: "Bottom".into(),
            source_path: "/b.mov".into(),
            duration: 100,
            source_len: 100,
            start_frame: 0,
            ..Default::default()
        };
        let top = Clip {
            id: "top".into(),
            name: "Top".into(),
            source_path: "/t.mov".into(),
            duration: 100,
            source_len: 100,
            start_frame: 0,
            ..Default::default()
        };
        let mut m = ProjectManifest::fresh("x");
        m.timelines.push(Timeline {
            id: "tl1".into(),
            name: "x".into(),
            rate: None,
            tracks: vec![
                // track 0 (higher priority) fully covers track 1's clip
                chroma_timeline::Track {
                    kind: TrackKind::Video,
                    clips: vec![top.clone()],
                    ..Default::default()
                },
                chroma_timeline::Track {
                    kind: TrackKind::Video,
                    clips: vec![bottom.clone()],
                    ..Default::default()
                },
            ],
            markers: Vec::new(),
        });
        m.active_timeline = 0;

        // the flattened `clips` list (what open_manifest builds) — order
        // depends only on start_frame, both are at 0, so either order is
        // possible; find each by id rather than assuming index.
        let clips = active_timeline_video_clips(&m);
        let bottom_idx = clips.iter().position(|c| c.id == "bottom").unwrap();
        let top_idx = clips.iter().position(|c| c.id == "top").unwrap();

        // candidate = the bottom (obscured) clip -> re-resolves to top
        assert_eq!(top_wins_clip_index(&m, &clips, bottom_idx), top_idx);
        // candidate = the top (winning) clip -> stays put
        assert_eq!(top_wins_clip_index(&m, &clips, top_idx), top_idx);
    }

    /// The common, only-real-shape-today case (one video track):
    /// `top_wins_clip_index` is a pure no-op, matching
    /// `chroma-timeline`'s own single-track-behavior guarantee.
    #[test]
    fn top_wins_clip_index_is_a_noop_on_a_single_video_track() {
        let root = tmp("unify_top_wins_single");
        let (_dir, manifest) = new_project_in(&root, "x", &["/a.mov".into()]).unwrap();
        let clips = active_timeline_video_clips(&manifest);
        assert_eq!(top_wins_clip_index(&manifest, &clips, 0), 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    #[ignore = "machine-specific: needs the owner's real ~/Movies/Chroma/New.chroma"]
    fn migration_against_the_real_owner_project() {
        let home = std::env::var("HOME").expect("HOME");
        let real_dir = PathBuf::from(&home).join("Movies/Chroma/New.chroma");
        assert!(
            real_dir.join("project.json").is_file(),
            "expected {} to exist — this test is a manual, one-off verification, \
             see the D-070 decision writeup for its recorded output",
            real_dir.display()
        );

        // copy into a fresh scratch dir — never touch the live project.
        let scratch = tmp("unify_real_project_migration");
        copy_dir_recursive(&real_dir, &scratch);

        let original_grade_files: std::collections::BTreeSet<String> =
            std::fs::read_dir(scratch.join("grades"))
                .unwrap()
                .filter_map(|e| e.ok())
                .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("json"))
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect();
        let original_total_bytes: u64 = original_grade_files
            .iter()
            .map(|f| {
                std::fs::metadata(scratch.join("grades").join(f))
                    .unwrap()
                    .len()
            })
            .sum();

        let manifest = load_manifest(&scratch).expect("load the real project.json");
        eprintln!(
            "[D-070 real-project migration] {} ProjectShot(s), {} timeline(s), active_timeline={}",
            manifest.shots.len(),
            manifest.timelines.len(),
            manifest.active_timeline
        );

        let manifest =
            crate::timeline::ensure_timeline(&scratch, manifest, false).expect("ensure_timeline");
        let clips = active_timeline_video_clips(&manifest);
        eprintln!(
            "[D-070 real-project migration] active timeline has {} video clip(s)",
            clips.len()
        );

        let grade_dir = scratch.join("grades");
        let report = migrate_shot_grades_to_clips(&manifest, &grade_dir);
        eprintln!(
            "[D-070 real-project migration] migrated={} warnings={}",
            report.migrated,
            report.warnings.len()
        );
        for w in &report.warnings {
            eprintln!("[D-070 real-project migration] WARNING: {w}");
        }

        // nothing lost: every original grade file's bytes are still present
        // *somewhere* under grades/ (either at its old name — untouched, a
        // warned/no-clip case — or renamed to a clip id, or unchanged
        // because old_path == new_path).
        let final_total_bytes: u64 = std::fs::read_dir(&grade_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("json"))
            .map(|e| e.metadata().unwrap().len())
            .sum();
        assert_eq!(
            final_total_bytes, original_total_bytes,
            "total grade-file bytes under grades/ must be unchanged — nothing lost"
        );
        let final_grade_files: std::collections::BTreeSet<String> = std::fs::read_dir(&grade_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("json"))
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(
            final_grade_files.len(),
            original_grade_files.len(),
            "same number of grade files before and after — none deleted, none duplicated"
        );

        // every warned shot's original grade file must still exist untouched
        for shot in &manifest.shots {
            let old_name = format!("{}.grade.json", shot.id);
            if original_grade_files.contains(&old_name) {
                let still_has_a_grade_file = final_grade_files.contains(&old_name)
                    || active_timeline_video_clips(&manifest)
                        .iter()
                        .any(|c| final_grade_files.contains(&format!("{}.grade.json", c.id)));
                assert!(
                    still_has_a_grade_file,
                    "shot {} had a grade file before migration but it's unaccounted for after",
                    shot.id
                );
            }
        }

        eprintln!(
            "[D-070 real-project migration] verified: {} grade file(s), {} byte(s) total, \
             none lost across migration",
            final_grade_files.len(),
            final_total_bytes
        );

        let _ = std::fs::remove_dir_all(&scratch);
    }
}

//! # chroma-timeline — L2 domain model (D-039)
//!
//! **What it is:** the edit model for the Editing tab — an ordered set of
//! tracks, each a sequence of clips, plus the edit operations (reorder, trim,
//! split, remove, plus track management and cross-track moves) and a builder
//! that assembles a timeline from a project's shots.
//!
//! **Shape:** OTIO-*shaped* (OpenTimelineIO's data model — tracks of clips,
//! each clip a windowed reference into a source), but serialised as our own
//! plain `serde` JSON for v1. A real OTIO-compatible `.otio` exporter is a
//! **later, tracked step** (see D-041); the C bindings are deliberately not
//! used (D-039).
//!
//! **What it does NOT do:** no `wgpu`, no `ffmpeg`, no rendering, no
//! compositing, no media probing. It only depends on `chroma-types`. Callers
//! supply source frame counts (from a probe); this crate never reaches media.
//! **Multi-track / multi-position status (D-054, Phase A of
//! `docs/notes/multi-track-nle.md`):** the model itself can now represent
//! more than one track and gaps between clips (`Clip::start_frame`,
//! `add_track`/`remove_track`/`move_clip`) — but nothing in the app populates
//! a second track or a gap yet (`Timeline::from_shots` still lays one video
//! track's clips back to back). N-track compositing/rendering, audio mixing,
//! and the multi-track UI are separate, later phases (B/C/D) — see that note.
//!
//! **Opaque top-wins video-track resolution (D-056, Phase B1):**
//! `Timeline::resolve_video_clip_at` picks which single video track/clip is
//! showing at a position — video tracks in index order (lower index = higher
//! priority), first one with a clip (not a gap) there wins, falling through
//! to a lower-priority track only on a gap. This crate still does no
//! rendering/compositing of its own (that stays media-layer work in
//! `app/src-tauri`); this method only adds the **selection** logic, which
//! turned out to be all "opaque, top wins" needs — there's no pixel blending
//! to compute when the winner fully obscures everything below it. Real
//! multi-texture GPU blending is Phase B3.
//!
//! **Status:** D-041 — the MVP edit model: `Timeline::from_shots`, position
//! helpers (`Track::clip_at`, `Timeline::duration`) and the edit ops
//! (`reorder` / `trim_start` / `trim_end` / `split` / `remove`), each
//! unit-tested. D-045 (pass 2 of the media-pool/timelines roadmap item) added
//! `Timeline::id` so a project can hold several independently-editable named
//! timelines (`ProjectManifest.timelines: Vec<Timeline>`) with one active —
//! this crate itself stays single-timeline-shaped; multi-timeline is purely
//! a `Vec<Timeline>` one layer up, in `chroma::project` / `chroma::edit`
//! (`app/src-tauri`). No id generation here (would need a dependency this
//! pure crate doesn't have, e.g. `uuid`) — callers set `id` on creation, the
//! same way `build_from_shots` already sets `name`. D-054 (Phase A) gave
//! `Clip` an explicit `start_frame`, added `add_track` / `remove_track` /
//! `move_clip`, and a `backfill_legacy_positions` migration for pre-D-054
//! `project.json` files whose clips have no position field. D-057 (Phase C,
//! `docs/notes/multi-track-nle.md`) added `Track.gain: f32` (default `1.0`)
//! — a plain numeric multiplier, still no media/rendering reached from this
//! crate; `chroma::audio` (`app/src-tauri`) is what actually reads it to
//! scale a track's contribution to the mixed output. See D-057 for why it
//! lives on `Track` here rather than in `chroma::audio` itself.
//!
//! **A/V link groups (D-129, `docs/notes/av-linking.md`):** `Clip.link_group`
//! makes a video clip and its own audio two real, separately-addressable
//! `Clip`s that behave as one — the model change D-050's embedded-audio
//! playback was blocking. Every per-clip op here is link-aware: `move_clip`,
//! `trim_start`, `trim_end`, `split` and `remove` apply to **every** member
//! of a clip's group or to none of it (`TimelineError::LinkDesync`), matching
//! Resolve's own documented "any change made to one — moving, trimming, or
//! deleting — automatically applies to the other" and Premiere's Razor
//! cutting both halves at once. `unlink` dissolves a complete group (both
//! references' own escape hatch, and the way to make an L-cut). Placement of
//! a *new* linked pair (the drop path) is `audio_track_with_room` /
//! `ensure_audio_track_with_room` here plus `@chroma/editor`'s `add_clip`
//! op — this crate still has no clip-*creation* op of its own.
//!
//! **Per-clip crop (D-132, Phase 3 of `docs/notes/on-canvas-transform.md`):**
//! `Clip::crop_left`/`crop_top`/`crop_right`/`crop_bottom` — four normalised
//! (0.0–1.0) edge insets into the clip's own **source** frame, the Edit
//! tab's first real crop (D-127 Finding 3 traced that the concept was
//! absent here entirely, while Colorist had its own unrelated one). Same
//! division of labour as every other compositing field on `Clip`: this
//! crate carries the values and their migration defaults, and
//! `app/src-tauri`'s `chroma::edit::composite_layer_onto` is what actually
//! applies them to pixels (no `crop_is_identity`-style predicate here for
//! the same reason there is no `is_opaque` for `opacity` — the consumer
//! that clamps is the consumer that decides). See the fields' own docs for
//! why they are normalised to the source rather than pixels, and flat
//! scalars rather than a nested rect.

use serde::{Deserialize, Serialize};

use chroma_types::Rational;

/// The whole edit — every track, top to bottom.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Timeline {
    /// Stable id — how a project's `timelines` list and `active_timeline`
    /// selection (D-045) reference a specific timeline. Empty string on a
    /// `Timeline` built directly (e.g. in a test) or deserialized from
    /// pre-D-045 JSON that never had this field; callers that persist a
    /// timeline are expected to assign a real one (see
    /// `chroma::edit::build_from_shots` / `chroma_timeline_create`).
    #[serde(default)]
    pub id: String,
    pub name: String,
    /// Output timebase (frame rate) for the assembled edit.
    pub rate: Option<Rational>,
    pub tracks: Vec<Track>,
}

/// One track: a typed, ordered lane of clips.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Track {
    pub kind: TrackKind,
    pub clips: Vec<Clip>,
    /// Linear volume multiplier applied to this track's contribution to the
    /// mixed audio output (D-057, Phase C of `docs/notes/multi-track-nle.md`)
    /// — `1.0` is unity (no change), `0.0` is a full mute, `> 1.0` boosts.
    /// This crate never reads it (no media/rendering here — see the module
    /// doc); `chroma::audio`'s mixer is the actual consumer. `#[serde(default
    /// = "default_track_gain")]` so a pre-D-057 `project.json` track with no
    /// `gain` key deserializes to unity rather than `0.0` (a real
    /// `#[serde(default)]` would silently mute every track in every existing
    /// project on load, since `f32::default() == 0.0` — this is a deliberate
    /// non-zero migration default, not laziness). No pan/stereo-positioning
    /// field — deliberately scoped out of Phase C, see D-057.
    #[serde(default = "default_track_gain")]
    pub gain: f32,
    /// D-082 (Phase B3, `docs/notes/multi-track-nle.md`). Prevents edits to
    /// this track's clips through the normal ops (`trim_start`/`trim_end`/
    /// `split`/`remove`/`move_clip` all refuse — return
    /// `TimelineError::TrackLocked` — when the *source* track is locked;
    /// `add_clip`-equivalent placement onto a locked track is likewise
    /// refused by the same check). Purely an editing-safety guard, not a
    /// rendering concern — a locked track still composites/plays normally.
    /// `#[serde(default)]` is correct here (unlike `gain`): `bool::default()
    /// == false`, and "not locked" is the only sane meaning for a pre-D-082
    /// track with no `locked` key.
    #[serde(default)]
    pub locked: bool,
    /// D-082. Excludes this track from compositing (video) — a hidden video
    /// track's clips are skipped by [`Timeline::resolve_visible_video_layers_at`]
    /// entirely, same as if the track didn't exist for that call, though its
    /// clips/positions are untouched (unlike `remove_track`). For an audio
    /// track, "hidden" and `gain: 0.0` (mute) are deliberately two different
    /// concepts kept separate rather than folded together: mute is a mix
    /// level (still selectable/audible if un-muted later, and the mixer only
    /// ever reads `gain`), hidden is "this track isn't part of the edit right
    /// now" (a visibility/scratch concept, matching the "eye" icon
    /// convention every reference NLE uses, kept for consistency across
    /// track kinds even though nothing reads it for audio yet).
    /// `#[serde(default)]` — a pre-D-082 track with no `hidden` key is
    /// visible, correctly.
    #[serde(default)]
    pub hidden: bool,
    /// Cross-track ripple sync (D-106/roadmap item 11). Whether this track
    /// RECEIVES a ripple shift triggered by an edit on a DIFFERENT track —
    /// independent of whether THIS track's own edits ripple (they always do,
    /// unconditionally, same as before this field existed). Matches DaVinci
    /// Resolve's and Palmier Pro's real Sync Lock semantics exactly (checked
    /// live against both, not assumed — see `docs/notes/
    /// cross-track-ripple-sync-lock.md`): per-track, default ON, a distinct
    /// concept from `locked` (which protects a track's own clips from being
    /// edited at all, not whether it receives someone ELSE's ripple — the
    /// same "don't fold two different concepts into one flag" discipline
    /// `hidden` vs. `gain == 0.0` already keeps separate on this struct).
    /// `#[serde(default = "default_sync_locked")]`, not a bare
    /// `#[serde(default)]`, for the identical reason `gain` isn't: `bool::
    /// default() == false` would silently turn sync-lock OFF for every
    /// track in every existing project on load — the opposite of matching
    /// Resolve/Palmier's real default and a real, visible behavior change
    /// for existing projects, not a silent one (see that doc's own
    /// "Backward compatibility" section for why `true` is still the right
    /// call despite that).
    #[serde(default = "default_sync_locked")]
    pub sync_locked: bool,
}

fn default_track_gain() -> f32 {
    1.0
}

fn default_sync_locked() -> bool {
    true
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrackKind {
    #[default]
    Video,
    Audio,
}

/// Sentinel `start_frame` value observed only transiently, right after
/// deserializing a pre-D-054 `project.json` clip that never had the field —
/// never a real position. Not part of the public API; callers detect "needs
/// migration" by calling `backfill_legacy_positions`, not by comparing
/// against this constant themselves.
const LEGACY_MISSING_START: i64 = i64::MIN;

fn legacy_missing_start() -> i64 {
    LEGACY_MISSING_START
}

/// A single clip — a windowed reference into a source media file, placed on a
/// track at an explicit timeline position (D-054). `source_start` /
/// `duration` are in **source frames**; `start_frame` is in **timeline**
/// frames, absolute within its timeline (not track-relative — a clip's
/// position doesn't depend on which track it's on, which is what makes
/// `move_clip` a plain field write rather than a coordinate conversion).
/// `source_len` is the source's total frame count so a trim can never run
/// past the media.
///
/// **Position model (D-054):** clips on a track are no longer forced back to
/// back — `start_frame` can leave a gap before a clip (`Track::clip_at`
/// returns `None` for a query landing in one) and clips on the same track
/// must never overlap (`trim_start`/`trim_end`/`move_clip` all enforce this).
/// `Track.clips`' Vec order is *not* required to match position order — it's
/// bookkeeping order only (see `Timeline::reorder`'s doc); every op that
/// needs "the clip before/after this one in time" scans by `start_frame`,
/// never by Vec index.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Clip {
    /// Stable id — survives reorder / trim; a `split` gives the new half a
    /// derived id. Lets the UI key a clip across a `get`→edit→`get` cycle.
    #[serde(default)]
    pub id: String,
    /// Back-link to the `ProjectShot` this clip came from (`from_shots`), if any.
    /// Legacy (pre-unify-clip-model) — a clip built directly (drag-from-
    /// Sources, or `chroma::project::append_media_clip`) never sets this.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shot_id: Option<String>,
    /// Back-link to the `MediaItem` (pool item) this clip's `source_path`
    /// comes from, if known (unify-clip-model doc,
    /// `docs/notes/unified-clip-model.md`). Additive/nullable — a clip can
    /// exist before its source has round-tripped through
    /// `chroma_media_import` at all (`source_path` stays the ground truth,
    /// this is an index/link only), same "reference, don't require"
    /// discipline `MediaItem::folder`/D-045 already uses. `#[serde(default)]`
    /// so legacy JSON with no `media_id` key deserializes to `None`, not an
    /// error — no migration needed for existing `project.json`. Set by
    /// whatever op creates a clip that *does* know its pool item: dragging a
    /// Sources-panel item onto the Edit-tab timeline
    /// (`@chroma/editor`'s `clipFromDraggedMedia`), or the Colorist "add to
    /// grading" convenience (`chroma::project::append_media_clip`). A clip
    /// built by `Timeline::from_shots`/legacy migration never sets this
    /// (`None`) — `chroma::project`'s grade-file migration falls back to
    /// `shot_id`/`source_path` matching for those.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_id: Option<String>,
    /// A/V link group (D-129, `docs/notes/av-linking.md` Phase 1) — the id of
    /// the group of clips this one is linked to; `None` = unlinked.
    /// **Group-based, not pairwise**, matching Palmier Pro's own
    /// `manage_clip_links` shape ("merges the complete existing groups touched
    /// by clipIds"), and the same `Option<String>` back-link shape `media_id`
    /// above already uses. `#[serde(default, skip_serializing_if =
    /// "Option::is_none")]` — a pre-D-129 clip has no key, deserializes to
    /// `None` (unlinked), zero migration needed, exactly `media_id`'s own
    /// precedent.
    ///
    /// **On a VIDEO clip this field additionally means "this clip's audio has
    /// been externalized to a linked audio clip — do NOT play its embedded
    /// audio stream."** That is not two concepts folded into one flag (the
    /// discipline `hidden` vs. `gain == 0.0` keeps separate on `Track`): it is
    /// the single fact "this video clip's sound lives in a separate, linked
    /// clip," which is precisely what Premiere/Resolve mean by a linked A/V
    /// pair. `chroma::audio::chroma_audio_play` reads it for exactly that
    /// (D-129) — a linked video clip contributes no embedded-audio source; its
    /// linked audio clip supplies the sound instead, wherever on the timeline
    /// that half currently sits (an L-cut), and silence if the user deleted
    /// that half (matching both references, where deleting the audio half
    /// really does leave the picture silent). A pre-D-129 clip is `None` here
    /// and keeps D-050's embedded-audio playback byte-for-byte unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link_group: Option<String>,
    pub name: String,
    pub source_path: String,
    pub source_start: i64,
    pub duration: i64,
    /// Total frame count of the source media — the ceiling for trims / extends.
    #[serde(default)]
    pub source_len: i64,
    /// Timeline-absolute start frame (D-054). The `#[serde(default = ...)]`
    /// here is a **migration sentinel**, not a real default: legacy JSON with
    /// no `start_frame` key deserializes to `i64::MIN`, which
    /// `Track::backfill_legacy_positions` / `Timeline::backfill_legacy_positions`
    /// then replace with a reconstructed back-to-back position — the exact
    /// layout that clip rendered at before D-054, since every pre-D-054
    /// track was strictly back to back by construction. A freshly-authored
    /// or already-migrated project always serializes a real value here (the
    /// field isn't `Option`/`skip_serializing_if`), so the sentinel is only
    /// ever observed transiently, right after `serde_json::from_*`, before a
    /// caller runs the backfill.
    #[serde(default = "legacy_missing_start")]
    pub start_frame: i64,

    // --- Compositing transform (D-082, Phase B3) --------------------------
    // Only meaningful on a video clip sitting on a track *below* the topmost
    // one with content at a given position — a lone top-track clip still
    // renders exactly as before regardless of these (opacity 1, no offset,
    // no scale/rotation change *is* "draw it plain"). `app/src-tauri`'s
    // compositor (not this crate — see the module doc's "no rendering" line)
    // is the actual consumer; this crate only carries the values and their
    // migration defaults.
    /// 0.0–1.0. `#[serde(default = "default_opacity")]`, not a bare
    /// `#[serde(default)]`: `f64::default() == 0.0`, which would render a
    /// pre-D-082 clip (and any clip a caller builds without setting this)
    /// fully transparent — a real, silent regression, not "the sane default
    /// for an unset field." `1.0` (fully opaque) is the only default under
    /// which every existing single/opaque-track render stays pixel-identical.
    #[serde(default = "default_opacity")]
    pub opacity: f64,
    /// Composition-space pixel offset from this clip's natural (centred,
    /// unscaled) position. `#[serde(default)]` is correct (`0.0` = no
    /// offset, the only sane unset-field meaning).
    #[serde(default)]
    pub position_x: f64,
    #[serde(default)]
    pub position_y: f64,
    /// Uniform scale multiplier. `#[serde(default = "default_scale")]` for
    /// the same reason `opacity` isn't a bare `#[serde(default)]`:
    /// `f64::default() == 0.0` would render every existing clip as a single
    /// point.
    #[serde(default = "default_scale")]
    pub scale: f64,
    /// Degrees, clockwise. `#[serde(default)]` is correct (`0.0` = upright).
    #[serde(default)]
    pub rotation: f64,

    // --- Crop (D-132, Phase 3 of `docs/notes/on-canvas-transform.md`) -----
    // Four **normalised edge insets** — the fraction of this clip's own
    // SOURCE width/height trimmed off each edge. All four `0.0` = no crop;
    // `crop_left: 0.25` hides the leftmost quarter of the picture.
    //
    // **Why normalised to the source, not pixels** (D-132): the Edit-tab
    // compositor decodes each layer at whatever `max_long_edge` the caller
    // asked for — 960 while scrubbing, 640 while playing (`PreviewPane.tsx`)
    // — so a crop expressed in decoded pixels would cover a different
    // fraction of the picture at each preview quality. That is exactly
    // B-043's defect, in a second field. A fraction of the source is
    // invariant under every decode scale by construction, so this field is
    // correct at any preview resolution *today*, before Phase 0a's
    // composition-space work lands. It also deliberately differs from
    // Colorist's `adjustments.crop`, an absolute-pixel `{x, y, width,
    // height}` on one loaded still — that path has a single fixed source
    // image and no decode-scale knob, so pixels are fine there and wrong
    // here (D-127 Finding 3: the two crops share a word, not a code path).
    //
    // **Why four flat scalars, not a nested `crop: CropRect`:** these ride
    // the D-034 keyframe engine (`chroma_keyframes` below), which
    // interpolates a flat `{name: number}` params object — a nested rect
    // could be stored but never animated, and a second, parallel
    // interpolation path for one field is exactly the "don't invent a new
    // mechanism" this repo refuses. Insets (rather than an x/y/w/h rect)
    // are also what both references expose: Premiere's Crop effect is
    // Left/Right/Top/Bottom percentages, Resolve's Crop mode is one handle
    // per side.
    //
    // `#[serde(default)]` is correct here (unlike `opacity`/`scale`):
    // `f64::default() == 0.0` and zero inset genuinely IS "no crop", so a
    // pre-D-132 `project.json` clip with none of these keys loads uncropped
    // and renders pixel-identically. No migration sentinel, no backfill
    // pass — the same reasoning `position_x`/`rotation` already use.
    //
    // Stored verbatim, **clamped by the consumer**: this crate does no
    // rendering (see the module doc), and the compositor already clamps
    // `opacity` at the point of use for the same reason. A degenerate crop
    // (insets summing to ≥ 1 on an axis) means "nothing left of this layer"
    // and the compositor paints nothing.
    /// Fraction of the source width cropped off the LEFT edge (0.0–1.0).
    #[serde(default)]
    pub crop_left: f64,
    /// Fraction of the source height cropped off the TOP edge (0.0–1.0).
    #[serde(default)]
    pub crop_top: f64,
    /// Fraction of the source width cropped off the RIGHT edge (0.0–1.0).
    #[serde(default)]
    pub crop_right: f64,
    /// Fraction of the source height cropped off the BOTTOM edge (0.0–1.0).
    #[serde(default)]
    pub crop_bottom: f64,
    /// D-034-shaped keyframes for the nine fields above — `[{frame, params:
    /// {opacity?, position_x?, position_y?, scale?, rotation?, crop_left?,
    /// crop_top?, crop_right?, crop_bottom?}}, …]`, the
    /// *exact* `[{frame, params}]` shape `chroma::keyframes::
    /// interpolated_parameters` (already generic over any params `Value`,
    /// already used by a mask's shape geometry AND by `RelightLight`,
    /// D-034/D-048) already interpolates — reused verbatim rather than a
    /// second keyframe engine. Lives as untyped `Value` here (not a typed
    /// Rust struct) because this crate has no `chroma::keyframes` dependency
    /// (`chroma-timeline` is a pure L2 domain crate — see the module doc;
    /// `chroma::keyframes` is `app/src-tauri` layer) and because every other
    /// keyframeable thing in this codebase (masks, relight lights) already
    /// stores its keyframes as opaque JSON for the exact same reason — the
    /// compositor (`app/src-tauri`) is what actually calls
    /// `interpolated_parameters` on this field at render time, this crate
    /// only carries it. `None`/absent = not keyframed, use the plain fields
    /// above as-is (also `interpolated_parameters`'s own existing
    /// "no keyframes → None → caller uses the raw fields" contract).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chroma_keyframes: Option<serde_json::Value>,
}

fn default_opacity() -> f64 {
    1.0
}

fn default_scale() -> f64 {
    1.0
}

/// Manual, not `#[derive(Default)]` (D-082): a derived `Default` would give
/// `opacity`/`scale` their TYPE's zero value (`0.0`), not the `1.0` these
/// fields actually need to mean "render this clip plainly" — `#[serde(
/// default = "default_opacity")]` only ever governs *deserializing* a
/// missing JSON key, a completely separate mechanism from `Default::
/// default()`, which every `Clip { ..Default::default() }` construction
/// site (this crate has several) would otherwise silently pick up as
/// "fully transparent, zero scale."
impl Default for Clip {
    fn default() -> Self {
        Self {
            id: String::new(),
            shot_id: None,
            media_id: None,
            link_group: None,
            name: String::new(),
            source_path: String::new(),
            source_start: 0,
            duration: 0,
            source_len: 0,
            start_frame: 0,
            opacity: default_opacity(),
            position_x: 0.0,
            position_y: 0.0,
            scale: default_scale(),
            rotation: 0.0,
            crop_left: 0.0,
            crop_top: 0.0,
            crop_right: 0.0,
            crop_bottom: 0.0,
            chroma_keyframes: None,
        }
    }
}

impl Clip {
    /// The exclusive upper bound for `source_start + duration`.
    fn source_ceiling(&self) -> i64 {
        self.source_len.max(0)
    }

    /// The exclusive upper bound of this clip's occupied timeline range.
    ///
    /// `pub` (D-130): `chroma::audio` needs a clip's out-point to know where a
    /// source must stop contributing to the mix, and `chroma::edit` needs it to
    /// report that out-point. Both would otherwise re-spell
    /// `start_frame + duration` at the call site, which is exactly the
    /// arithmetic this type exists to own.
    pub fn end_frame(&self) -> i64 {
        self.start_frame + self.duration
    }
}

/// Edit-op failures. All are caller errors (bad index, a trim that would empty
/// a clip, a split outside a clip, a move that would overlap) — none are I/O.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum TimelineError {
    #[error("track index {0} out of range")]
    NoSuchTrack(usize),
    #[error("clip index {0} out of range on track {1}")]
    NoSuchClip(usize, usize),
    #[error("index {0} out of range")]
    BadIndex(usize),
    #[error("a clip must keep at least one frame")]
    EmptyClip,
    #[error("timeline frame {0} is not inside clip {1}")]
    SplitOutsideClip(i64, usize),
    #[error("timeline position {0} is negative")]
    NegativePosition(i64),
    #[error("moving this clip to track {0} at frame {1} would overlap an existing clip there")]
    Overlap(usize, i64),
    /// D-082. Refused by `trim_start`/`trim_end`/`split`/`remove`/`reorder`
    /// when the clip's OWN track is locked, and by `move_clip` when EITHER
    /// `from_track` or `to_track` is locked — a locked track is "don't let
    /// me accidentally edit this," which reads most naturally as protecting
    /// it from BOTH losing a clip to elsewhere and gaining one dropped onto
    /// it, not just one direction. `add_track`/`remove_track`/`move_track`
    /// (track-list-level ops, not per-clip edits) are deliberately NOT
    /// gated by this — locking a track doesn't lock the whole timeline's
    /// track list.
    #[error("track {0} is locked")]
    TrackLocked(usize),
    /// D-105. `at_frame` is either inside a real clip (nothing to close) or
    /// past every clip on the track (trailing empty space, not a real
    /// "gap" — there's nothing after it to ripple earlier).
    #[error("no closeable gap at frame {1} on track {0}")]
    NoGapAt(usize, i64),
    /// B-033. A sync-locked OTHER track has a clip straddling the ripple
    /// point this op would shift — rejected rather than auto-split (see
    /// `has_straddling_sync_locked_clip`'s own doc for why).
    #[error("a sync-locked track has a clip straddling the ripple point at frame {0}")]
    SyncLockedStraddle(i64),
    /// D-129. An op on one member of an A/V link group could not be applied
    /// identically to every other member — the linked halves would have ended
    /// up out of sync (a different trim delta because a member hit its own
    /// source/neighbour clamp first, a member landing on top of another clip
    /// on its own track, or a split frame that isn't inside every member).
    /// **Rejected whole rather than partially applied**, the exact
    /// reject-rather-than-corrupt discipline B-033 established for the
    /// sync-lock straddle case. `unlink` first if the halves really are meant
    /// to diverge (an L-cut) — that is what it exists for, and it matches
    /// both references' own "unlink, edit independently, relink" workflow.
    #[error("this edit cannot be applied identically to every clip in link group {0}")]
    LinkDesync(String),
}

/// Shift every clip on `track` starting at/after `threshold` by `delta`
/// frames (positive = later, negative = earlier) — the one real ripple-shift
/// primitive shared by `move_clip`'s ripple and `remove_gap` (D-106; a real,
/// pre-existing duplication between those two this pass cleans up rather
/// than adding a third copy — see `docs/notes/cross-track-ripple-sync-lock.md`).
fn shift_clips_at_or_after(track: &mut Track, threshold: i64, delta: i64) {
    for c in track.clips.iter_mut() {
        if c.start_frame >= threshold {
            c.start_frame += delta;
        }
    }
}

/// B-033 — REVERTED from auto-split to reject-on-straddle, a deliberate
/// safety rollback, not a redesign. The auto-split version (D-106/D-107)
/// let a REPEATED ripple (several real remove_gap/move/add_clip ops in the
/// same session, each individually correct in isolation) keep re-splitting
/// a fragment created by a PREVIOUS ripple — confirmed on the owner's real
/// `New.chroma` project: the same source clip ended up split into a chain
/// of ever-smaller slivers (four consecutive 166-frame fragments of one
/// clip) and the same clip id appearing three times on one track at wildly
/// different positions, with the project's total duration growing instead
/// of shrinking after closing a gap. This reverts to exactly D-104's own
/// already-proven-safe same-track contract, generalized cross-track: a
/// straddling clip on a sync-locked track REJECTS the whole op, never
/// splits. Auto-split may come back as a real, separately-scoped,
/// separately-verified follow-up — see B-033.
fn has_straddling_sync_locked_clip(tracks: &[Track], edited_track: usize, threshold: i64) -> bool {
    tracks.iter().enumerate().any(|(i, t)| {
        if i == edited_track || !t.sync_locked || t.locked {
            return false;
        }
        t.clips
            .iter()
            .any(|c| c.start_frame < threshold && c.end_frame() > threshold)
    })
}

/// Propagate a ripple from `edited_track` (already shifted by the caller) to
/// every OTHER track whose `sync_locked` is on — D-106, question 1's
/// resolved "applies uniformly to every ripple call site" answer, one real
/// shared implementation rather than duplicated per call site. A track that
/// is BOTH sync-locked AND individually `locked` is skipped — a real
/// judgment call, not explicitly resolved in the scoping doc: `Track.locked`
/// already means "protect this track's clips from edits through the normal
/// ops" (D-082's own doc), and a foreign ripple shifting this track's clips
/// is exactly that kind of edit, so the same protection applies rather than
/// a `locked` track being silently modified by someone else's ripple. Plain
/// shift only (B-033) — callers MUST call `has_straddling_sync_locked_clip`
/// first and reject the whole op if it returns `true`; this never splits.
fn propagate_sync_lock_ripple(tracks: &mut [Track], edited_track: usize, threshold: i64, delta: i64) {
    for (i, t) in tracks.iter_mut().enumerate() {
        if i != edited_track && t.sync_locked && !t.locked {
            shift_clips_at_or_after(t, threshold, delta);
        }
    }
}

// --------------------------------------------------------------------------- //
// A/V link groups (D-129, `docs/notes/av-linking.md`)
// --------------------------------------------------------------------------- //

/// Where `start_frame` will be once a pending ripple has been applied — the
/// pure prediction D-129's link validation needs so a linked move can be
/// accepted or rejected **before** any mutation, without cloning the whole
/// timeline or unwinding a half-applied op. `rippled` is whether this clip's
/// own track receives the shift at all (the edited track always does; every
/// other track only if it's `sync_locked` and not `locked` — the exact
/// predicate [`propagate_sync_lock_ripple`] itself uses, kept in agreement by
/// callers passing the same answer to both).
fn start_after_ripple(start_frame: i64, rippled: bool, threshold: i64, delta: i64) -> i64 {
    if rippled && start_frame >= threshold {
        start_frame + delta
    } else {
        start_frame
    }
}

/// The clamped head-trim delta `trim_start` would really apply to
/// `track.clips[clip_idx]` for a requested `delta` — factored out of
/// `trim_start` itself (D-129) so the same clamp can be asked of every OTHER
/// member of a link group *before* anything is mutated, rather than
/// duplicated or approximated. Caller guarantees `clip_idx` is in range.
fn clamped_trim_start_delta(track: &Track, clip_idx: usize, delta: i64) -> i64 {
    let c = &track.clips[clip_idx];
    let ceiling = c.source_ceiling();
    let prev_end = track
        .clips
        .iter()
        .enumerate()
        .filter(|(i, o)| *i != clip_idx && o.end_frame() <= c.start_frame)
        .map(|(_, o)| o.end_frame())
        .max()
        .unwrap_or(0);
    let d = delta.clamp(-c.source_start, (ceiling - 1).max(0) - c.source_start);
    d.max(prev_end - c.start_frame)
}

/// The clamped new `duration` `trim_end` would really apply — the tail-trim
/// counterpart of [`clamped_trim_start_delta`], factored out for the same
/// D-129 reason. Caller guarantees `clip_idx` is in range.
fn clamped_trim_end_duration(track: &Track, clip_idx: usize, delta: i64) -> i64 {
    let c = &track.clips[clip_idx];
    let max_dur_source = (c.source_ceiling() - c.source_start).max(1);
    let next_start = track
        .clips
        .iter()
        .enumerate()
        .filter(|(i, o)| *i != clip_idx && o.start_frame >= c.start_frame)
        .map(|(_, o)| o.start_frame)
        .min();
    let max_dur_position = next_start
        .map(|s| (s - c.start_frame).max(1))
        .unwrap_or(i64::MAX);
    let max_dur = max_dur_source.min(max_dur_position).max(1);
    (c.duration + delta).clamp(1, max_dur)
}

impl Timeline {
    /// Build a single-video-track timeline from a project's shots, each shot a
    /// full-length clip laid back to back in order. `shots` is
    /// `(shot_id, source_path, name, source_frame_count)` — the caller probes
    /// each source for its frame count (this crate never touches media).
    pub fn from_shots(shots: &[(String, String, String, i64)]) -> Timeline {
        let mut acc = 0i64;
        let clips = shots
            .iter()
            .map(|(id, path, name, frames)| {
                let len = (*frames).max(0);
                let duration = len.max(1);
                let start_frame = acc;
                acc += duration;
                Clip {
                    id: id.clone(),
                    shot_id: Some(id.clone()),
                    media_id: None,
                    link_group: None,
                    name: name.clone(),
                    source_path: path.clone(),
                    source_start: 0,
                    duration,
                    source_len: len,
                    start_frame,
                    ..Default::default()
                }
            })
            .collect();
        Timeline {
            id: String::new(),
            name: String::new(),
            rate: None,
            tracks: vec![Track {
                kind: TrackKind::Video,
                clips,
                gain: default_track_gain(),
                locked: false,
                hidden: false,
                sync_locked: default_sync_locked(),
            }],
        }
    }

    /// Total timeline length in frames — the longest track.
    pub fn duration(&self) -> i64 {
        self.tracks.iter().map(Track::duration).max().unwrap_or(0)
    }

    /// Resolve timeline position `pos` under **opaque, top-track-wins**
    /// compositing (D-056, Phase B1 of `docs/notes/multi-track-nle.md`):
    /// video tracks are checked in priority order — **`tracks` index order,
    /// lower index = higher priority** ("on top") — and the first one whose
    /// `Track::clip_at(pos)` returns `Some` (a real clip there, not a gap)
    /// wins outright. For purely opaque compositing there is no pixel-level
    /// blend to compute: this is a track-**selection** problem, not a
    /// rendering one, so the result is just "which single track/clip is
    /// showing," never a merge of two. Falls through to the next
    /// lower-priority video track only when a higher one has a gap at this
    /// exact position; returns `None` once every video track has a gap (or
    /// there are no video tracks at all) at `pos`.
    ///
    /// Deterministic by construction: iterates `self.tracks` (a `Vec`, not a
    /// `HashMap`) in its stored order every time — no hidden
    /// iteration-order dependency.
    ///
    /// Returns `(track_index, clip, source_frame)` — the track index lets a
    /// caller report/log which track actually won, though nothing in this
    /// crate needs it for the resolution itself.
    pub fn resolve_video_clip_at(&self, pos: i64) -> Option<(usize, &Clip, i64)> {
        self.tracks
            .iter()
            .enumerate()
            .filter(|(_, t)| t.kind == TrackKind::Video)
            .find_map(|(i, t)| t.clip_at(pos).map(|(c, sf)| (i, c, sf)))
    }

    /// D-082 (Phase B3) — the multi-layer generalization of
    /// [`Self::resolve_video_clip_at`]'s single-winner lookup: EVERY visible
    /// (`!t.hidden`) video track with a real clip (not a gap) at `pos`, not
    /// just the first one. Same track-index-order walk `resolve_video_clip_at`
    /// already uses, so the two never disagree about *which* clips are
    /// candidates — this just doesn't stop at the first hit. Returned in
    /// track-index order (ascending) — **index order is compositing paint
    /// order, lowest index painted LAST (on top)**, matching
    /// `resolve_video_clip_at`'s own "lower index = higher priority"
    /// convention exactly, so a caller doing real alpha-over compositing
    /// should iterate this list in REVERSE (paint the last/lowest-priority
    /// entry first, the first/highest-priority entry last, on top) — see
    /// the compositor in `app/src-tauri/src/chroma/edit.rs` for the actual
    /// consumer. A hidden track contributes nothing, silently, same
    /// "gap = nothing here, not an error" contract every other resolver in
    /// this crate already has.
    pub fn resolve_visible_video_layers_at(&self, pos: i64) -> Vec<(usize, &Clip, i64)> {
        self.tracks
            .iter()
            .enumerate()
            .filter(|(_, t)| t.kind == TrackKind::Video && !t.hidden)
            .filter_map(|(i, t)| t.clip_at(pos).map(|(c, sf)| (i, c, sf)))
            .collect()
    }

    /// Reconstruct real positions for any clip loaded from pre-D-054 JSON
    /// that had no `start_frame` field at all (see `Clip::start_frame`'s
    /// doc). Safe — and a no-op — to call on an already-migrated or
    /// freshly-built timeline: only clips still carrying the migration
    /// sentinel are touched. Callers that deserialize a `Timeline` from
    /// persisted JSON (`chroma::project::load_manifest`) are expected to
    /// call this once, right after `serde_json::from_*`.
    pub fn backfill_legacy_positions(&mut self) {
        for track in &mut self.tracks {
            track.backfill_legacy_positions();
        }
    }

    /// The single choke point every per-clip edit op (`reorder`/`trim_start`/
    /// `trim_end`/`split`/`remove`) routes through — D-082's `TrackLocked`
    /// check lives here once, rather than duplicated per op, so a future op
    /// added the normal way (calling this) is locked-safe automatically.
    /// `move_clip` does NOT go through this (it touches two tracks, source
    /// and destination) — its own lock check is separate, see that fn.
    /// `remove_track`/`add_track`/`move_track` (track-*list* ops) also don't
    /// — see `TrackLocked`'s own doc for why.
    fn track_mut(&mut self, track: usize) -> Result<&mut Track, TimelineError> {
        let t = self
            .tracks
            .get_mut(track)
            .ok_or(TimelineError::NoSuchTrack(track))?;
        if t.locked {
            return Err(TimelineError::TrackLocked(track));
        }
        Ok(t)
    }

    /// Add a new, empty track of `kind`, appended after the last existing
    /// track, at unity gain (D-057). Returns its index.
    pub fn add_track(&mut self, kind: TrackKind) -> usize {
        self.tracks.push(Track {
            kind,
            clips: Vec::new(),
            gain: default_track_gain(),
            locked: false,
            hidden: false,
            sync_locked: default_sync_locked(),
        });
        self.tracks.len() - 1
    }

    // --- A/V link groups (D-129) -----------------------------------------

    /// Every `(track index, clip index)` whose clip belongs to `group`, in
    /// ascending track-then-clip order. Empty for an unknown group.
    /// Index-based, so it is only valid until the next mutation — every
    /// caller here either uses it purely for validation before mutating, or
    /// re-resolves members by their stable `Clip::id` afterwards.
    pub fn link_group_members(&self, group: &str) -> Vec<(usize, usize)> {
        let mut out = Vec::new();
        for (ti, t) in self.tracks.iter().enumerate() {
            for (ci, c) in t.clips.iter().enumerate() {
                if c.link_group.as_deref() == Some(group) {
                    out.push((ti, ci));
                }
            }
        }
        out
    }

    /// The member locations of the link group the clip at `(track,
    /// clip_idx)` belongs to, plus that group's id — `None` when the clip is
    /// unlinked. The one lookup every link-aware op starts from.
    fn link_targets(&self, track: usize, clip_idx: usize) -> Option<(String, Vec<(usize, usize)>)> {
        let group = self
            .tracks
            .get(track)?
            .clips
            .get(clip_idx)?
            .link_group
            .clone()?;
        let members = self.link_group_members(&group);
        Some((group, members))
    }

    /// The first audio track (lowest index — the same "index order is the
    /// order" convention every other resolver in this crate uses) with room
    /// for a clip occupying `[start_frame, start_frame + duration)`, or
    /// `None` if every audio track is occupied there (or there are none).
    /// A `locked` audio track never counts — placing a clip on it would be
    /// refused by every op anyway (D-082's `TrackLocked`), so offering it as
    /// a landing spot would only produce a guaranteed failure.
    pub fn audio_track_with_room(&self, start_frame: i64, duration: i64) -> Option<usize> {
        let end = start_frame + duration;
        self.tracks.iter().position(|t| {
            t.kind == TrackKind::Audio
                && !t.locked
                && !t
                    .clips
                    .iter()
                    .any(|c| start_frame < c.end_frame() && end > c.start_frame)
        })
    }

    /// [`Self::audio_track_with_room`], creating a new audio track (via
    /// [`Self::add_track`] — the one real track-creation mechanism, D-095/
    /// D-096/D-117, not a second one) when no existing one has room. A
    /// brand-new track is empty, so the returned track is always genuinely
    /// free at `[start_frame, start_frame + duration)` — which is what makes
    /// D-129's "dropping a video clip always gets its linked audio half
    /// somewhere valid" guarantee hold without a failure path.
    pub fn ensure_audio_track_with_room(&mut self, start_frame: i64, duration: i64) -> usize {
        match self.audio_track_with_room(start_frame, duration) {
            Some(i) => i,
            None => self.add_track(TrackKind::Audio),
        }
    }

    /// Dissolve the **complete** link group the clip at `(track, clip_idx)`
    /// belongs to — every member's `link_group` becomes `None`, not just this
    /// one clip's. That is Palmier Pro's own documented `manage_clip_links`
    /// `unlink` semantics ("dissolves each member's complete link group")
    /// and matches Premiere's `Clip > Unlink` / Resolve's "Unlink Clips",
    /// both of which break the pair rather than peel one clip out of it.
    ///
    /// A no-op (`Ok`) for an already-unlinked clip. **Not** gated on the
    /// track's `locked` flag for any member other than the clip's own track:
    /// unlinking changes no clip's position, duration or source window, so it
    /// is a relationship edit rather than the kind of content edit
    /// `Track::locked` exists to protect against — the same distinction
    /// `add_track`/`remove_track`/`move_track` already draw.
    ///
    /// Unlinking a video clip restores D-050's embedded-audio playback for it
    /// (its `link_group` is what suppressed that — see `Clip::link_group`),
    /// so the ex-linked audio clip left behind on its own track will then
    /// play *alongside* the video's own embedded audio. That is the honest
    /// consequence of unlinking a pair built from one source file, not a bug:
    /// the audio clip is now an independent clip the user is free to delete,
    /// move, or keep as a doubled layer, exactly as in either reference NLE.
    pub fn unlink(&mut self, track: usize, clip_idx: usize) -> Result<(), TimelineError> {
        let t = self
            .tracks
            .get(track)
            .ok_or(TimelineError::NoSuchTrack(track))?;
        if t.locked {
            return Err(TimelineError::TrackLocked(track));
        }
        let clip = t
            .clips
            .get(clip_idx)
            .ok_or(TimelineError::NoSuchClip(clip_idx, track))?;
        let Some(group) = clip.link_group.clone() else {
            return Ok(());
        };
        for t in self.tracks.iter_mut() {
            for c in t.clips.iter_mut() {
                if c.link_group.as_deref() == Some(group.as_str()) {
                    c.link_group = None;
                }
            }
        }
        Ok(())
    }

    /// Remove the track at `track`, **including every clip on it** — a track
    /// with clips is not protected or emptied-then-kept, it's just gone
    /// (recovery is the caller's job, e.g. undo — D-052 — not a special case
    /// here). Errors (leaving `tracks` unchanged) for an out-of-range index.
    pub fn remove_track(&mut self, track: usize) -> Result<(), TimelineError> {
        if track >= self.tracks.len() {
            return Err(TimelineError::NoSuchTrack(track));
        }
        self.tracks.remove(track);
        Ok(())
    }

    /// D-082 ("rearrange" from the owner's full-NLE ask). Reorders `tracks`
    /// itself — a plain Vec move, `from` spliced out and re-inserted at
    /// `to`. Not cosmetic: track index order IS compositing z-order (lower
    /// index = higher priority, see `resolve_video_clip_at`'s and
    /// `resolve_visible_video_layers_at`'s own docs), so this changes what
    /// paints on top of what. Deliberately NOT gated by either track's
    /// `locked` (see `TrackLocked`'s doc — a locked track protects its own
    /// clips from edits, not the track list's order; the same distinction
    /// `remove_track`/`add_track` already have from `track_mut`-routed ops).
    pub fn move_track(&mut self, from: usize, to: usize) -> Result<(), TimelineError> {
        if from >= self.tracks.len() {
            return Err(TimelineError::NoSuchTrack(from));
        }
        if to >= self.tracks.len() {
            return Err(TimelineError::NoSuchTrack(to));
        }
        if from == to {
            return Ok(());
        }
        let t = self.tracks.remove(from);
        self.tracks.insert(to, t);
        Ok(())
    }

    /// Move the clip at `(from_track, from_idx)` onto `to_track` at
    /// timeline-absolute `to_start_frame`, keeping its id / duration /
    /// source window unchanged (only `start_frame`, and implicitly which
    /// track it's on, change). Works for a same-track reposition too
    /// (`from_track == to_track`) — this is the general "place this clip
    /// here" primitive; `reorder` (Vec-order only) does not move clips in
    /// time.
    ///
    /// D-104 — **overlap is rejected for every move now, same-track or
    /// cross-track**, unless `ripple` is true. This reverses D-096's
    /// "cross-track overlap allowed" policy: D-096 reasoned that since
    /// `resolve_visible_video_layers_at` composites every visible track
    /// together, two clips overlapping in time on different tracks is a
    /// normal layered edit, not an error — true in principle, but
    /// live-tested and explicitly overridden: landing directly on top of
    /// another clip should never be a reachable outcome of a plain move. If
    /// `ripple` is true and the destination range overlaps something, every
    /// clip on `to_track` at/after `to_start_frame` shifts later by this
    /// clip's own `duration` to make room instead (mirrors the ripple-insert
    /// contract the frontend's `add_clip`/`computeInsertion` already has for
    /// a brand-new clip from Sources — same "make room" semantics, now
    /// available to an existing clip being moved too).
    ///
    /// Errors, none of which mutate the timeline: `NoSuchTrack`/`NoSuchClip`
    /// for an out-of-range source or destination track/clip index,
    /// `NegativePosition` for `to_start_frame < 0`, `Overlap` if the
    /// destination range intersects any *other* clip already on `to_track`
    /// (the clip being moved never counts as overlapping itself) and
    /// `ripple` isn't set.
    pub fn move_clip(
        &mut self,
        from_track: usize,
        from_idx: usize,
        to_track: usize,
        to_start_frame: i64,
        ripple: bool,
    ) -> Result<(), TimelineError> {
        if to_start_frame < 0 {
            return Err(TimelineError::NegativePosition(to_start_frame));
        }
        let src = self
            .tracks
            .get(from_track)
            .ok_or(TimelineError::NoSuchTrack(from_track))?;
        if src.locked {
            return Err(TimelineError::TrackLocked(from_track));
        }
        let clip = src
            .clips
            .get(from_idx)
            .ok_or(TimelineError::NoSuchClip(from_idx, from_track))?;
        let duration = clip.duration;
        let clip_start_frame = clip.start_frame;
        let new_end = to_start_frame + duration;

        let dest = self
            .tracks
            .get(to_track)
            .ok_or(TimelineError::NoSuchTrack(to_track))?;
        if dest.locked {
            return Err(TimelineError::TrackLocked(to_track));
        }
        // D-104 — overlap is rejected for EVERY move now, same-track or
        // cross-track alike (see this fn's own doc for why this reverses
        // D-096). `i == from_idx` excludes the clip's own current slot —
        // only meaningful for a same-track move, a no-op filter for
        // cross-track since the clip isn't in `dest.clips` yet.
        let overlaps = dest.clips.iter().enumerate().any(|(i, c)| {
            if from_track == to_track && i == from_idx {
                return false; // the clip being moved never overlaps itself
            }
            to_start_frame < c.end_frame() && new_end > c.start_frame
        });
        // D-104 — ripple only ever shifts clips starting AT/AFTER the
        // landing point (the real, edge-aligned case the frontend's
        // `resolveClipLanding`/`computeInsertion` always produces). A clip
        // that starts BEFORE the landing point but extends past it
        // (straddling — not a real ripple-insert scenario any NLE supports
        // without splitting the clip first) can't be cleared by this shift,
        // so ripple can't rescue that case either.
        let straddles = dest.clips.iter().enumerate().any(|(i, c)| {
            if from_track == to_track && i == from_idx {
                return false;
            }
            c.start_frame < to_start_frame && c.end_frame() > to_start_frame
        });
        // B-033 — same reject-on-straddle now also covers every OTHER
        // sync-locked track this move's ripple would touch, checked before
        // any mutation.
        let sync_straddles =
            overlaps && ripple && has_straddling_sync_locked_clip(&self.tracks, to_track, to_start_frame);
        if overlaps && (!ripple || straddles || sync_straddles) {
            return Err(TimelineError::Overlap(to_track, to_start_frame));
        }

        // D-129 — every OTHER member of this clip's A/V link group moves by
        // the SAME delta, staying on its own track (Resolve's own documented
        // "any change made to one — moving, trimming, deleting — automatically
        // applies to the other"; a linked pair keeps sync, it does not follow
        // the video half onto the video half's new track). Validated in full
        // here, BEFORE any mutation, so a move that can't be applied to every
        // member is rejected whole rather than leaving the halves desynced —
        // the reject-rather-than-corrupt discipline B-033 established.
        let ripple_fires = overlaps && ripple;
        let delta = to_start_frame - clip_start_frame;
        // `(track, clip id, where it must end up)` for every sibling —
        // captured by stable id here, before anything moves, because the
        // mutation below invalidates every clip index it was validated with.
        let mut sibling_targets: Vec<(usize, String, i64)> = Vec::new();
        let link = self.link_targets(from_track, from_idx);
        if let Some((group, members)) = &link {
            for &(ti, ci) in members {
                if (ti, ci) == (from_track, from_idx) {
                    continue;
                }
                let ot = &self.tracks[ti];
                if ot.locked {
                    return Err(TimelineError::TrackLocked(ti));
                }
                let sib = &ot.clips[ci];
                let target = sib.start_frame + delta;
                if target < 0 {
                    return Err(TimelineError::NegativePosition(target));
                }
                sibling_targets.push((ti, sib.id.clone(), target));
                // Whether THIS member's own track receives the pending
                // ripple — same predicate `propagate_sync_lock_ripple` uses,
                // so the prediction below and the real shift agree.
                let rippled = ripple_fires && (ti == to_track || (ot.sync_locked && !ot.locked));
                let sib_end = target + sib.duration;
                let clash = ot.clips.iter().enumerate().any(|(i, o)| {
                    // Other members of the same group shift by the same delta
                    // from a non-overlapping start, so they can never collide
                    // with each other — and the member itself obviously
                    // doesn't collide with itself.
                    if i == ci || members.contains(&(ti, i)) {
                        return false;
                    }
                    let os = start_after_ripple(o.start_frame, rippled, to_start_frame, duration);
                    target < os + o.duration && sib_end > os
                });
                if clash {
                    return Err(TimelineError::LinkDesync(group.clone()));
                }
            }
        }

        let mut clip = self.tracks[from_track].clips.remove(from_idx);
        if ripple_fires {
            shift_clips_at_or_after(&mut self.tracks[to_track], to_start_frame, duration);
        }
        clip.start_frame = to_start_frame;
        let moved_id = clip.id.clone();
        self.tracks[to_track].clips.push(clip);
        // D-106 — propagate to every OTHER sync-locked track, same
        // `to_start_frame`/`duration` shift, only when this move's own
        // ripple actually fired (no shift on `to_track` means nothing to
        // keep in sync elsewhere either).
        if ripple_fires {
            propagate_sync_lock_ripple(&mut self.tracks, to_track, to_start_frame, duration);
        }
        // D-129 — now place each linked sibling at the target computed (and
        // fully validated) above. Resolved by its stable `Clip::id`, never by
        // the index it was validated with: removing the primary from
        // `from_track` shifted every later index on that track down by one,
        // and the ripple/sync shifts above may have moved siblings too. The
        // absolute target already accounts for both, so this is a plain
        // assignment, never a second relative shift. Runs BEFORE the prune
        // below, while every track index is still the one validated against.
        for (ti, sib_id, target) in &sibling_targets {
            if let Some(sib) = self.tracks.get_mut(*ti).and_then(|t| {
                t.clips
                    .iter_mut()
                    .find(|c| &c.id == sib_id && c.id != moved_id)
            }) {
                sib.start_frame = *target;
            }
        }
        // Only the source track can have been emptied by a cross-track move
        // — a same-track move never changes either track's clip count.
        if from_track != to_track {
            self.prune_if_empty(from_track);
        }
        Ok(())
    }

    /// Change the **Vec storage order** of the two clips at `from_idx`/
    /// `to_idx` on `track` — a list splice, exactly the same operation this
    /// had before D-054. **Does not move either clip in time**
    /// (`start_frame` is untouched): before D-054, a clip's timeline position
    /// was *implicit* from Vec order (clips summed strictly back to back), so
    /// splicing the Vec was how you moved a clip in time. Now that position
    /// is an explicit field owned by the clip, Vec order is just bookkeeping
    /// (e.g. UI list/display order) — `move_clip` is the op that actually
    /// repositions a clip.
    pub fn reorder(
        &mut self,
        track: usize,
        from_idx: usize,
        to_idx: usize,
    ) -> Result<(), TimelineError> {
        let t = self.track_mut(track)?;
        let n = t.clips.len();
        if from_idx >= n {
            return Err(TimelineError::BadIndex(from_idx));
        }
        if to_idx >= n {
            return Err(TimelineError::BadIndex(to_idx));
        }
        if from_idx == to_idx {
            return Ok(());
        }
        let clip = t.clips.remove(from_idx);
        t.clips.insert(to_idx, clip);
        Ok(())
    }

    /// Trim (`delta > 0`) or extend (`delta < 0`) the head of a clip: shift
    /// `source_start` **and** `start_frame` by `delta` and shorten `duration`
    /// by the same — the clip's *end* stays fixed on the timeline, its start
    /// (both source in-point and timeline position) slides, matching a
    /// normal NLE left-edge trim. Clamped so the source window stays inside
    /// `[0, source_len]`, keeps ≥ 1 frame, and (D-054) `start_frame` never
    /// moves earlier than the end of the nearest preceding clip on the same
    /// track (extending left can shrink a gap before it, never overlap it) —
    /// trimming right (`delta > 0`) only ever opens a gap before the clip,
    /// which can't violate that bound.
    ///
    /// **D-129 — a linked clip trims in lockstep with every other member of
    /// its A/V link group**, matching Resolve's own documented "any change
    /// made to one (moving, trimming, or deleting) automatically applies to
    /// the other." Every member must accept the *identical* clamped delta; if
    /// any one of them would clamp differently (its own source runs out
    /// first, a neighbouring clip on its track blocks it) the whole op is
    /// rejected with [`TimelineError::LinkDesync`] rather than silently
    /// leaving the halves out of sync — `unlink` first if divergence is
    /// actually what's wanted (an L-cut), which is exactly what both
    /// references' unlink action exists for.
    pub fn trim_start(
        &mut self,
        track: usize,
        clip_idx: usize,
        delta: i64,
    ) -> Result<(), TimelineError> {
        let t = self
            .tracks
            .get(track)
            .ok_or(TimelineError::NoSuchTrack(track))?;
        if t.locked {
            return Err(TimelineError::TrackLocked(track));
        }
        if clip_idx >= t.clips.len() {
            return Err(TimelineError::NoSuchClip(clip_idx, track));
        }
        let d = clamped_trim_start_delta(t, clip_idx, delta);
        if t.clips[clip_idx].duration - d < 1 {
            return Err(TimelineError::EmptyClip);
        }

        let link = self.link_targets(track, clip_idx);
        if let Some((group, members)) = &link {
            for &(ti, ci) in members {
                if (ti, ci) == (track, clip_idx) {
                    continue;
                }
                let ot = &self.tracks[ti];
                if ot.locked {
                    return Err(TimelineError::TrackLocked(ti));
                }
                if clamped_trim_start_delta(ot, ci, delta) != d || ot.clips[ci].duration - d < 1 {
                    return Err(TimelineError::LinkDesync(group.clone()));
                }
            }
        }

        let targets = link
            .map(|(_, m)| m)
            .unwrap_or_else(|| vec![(track, clip_idx)]);
        for (ti, ci) in targets {
            let clip = &mut self.tracks[ti].clips[ci];
            clip.source_start += d;
            clip.start_frame += d;
            clip.duration -= d;
        }
        Ok(())
    }

    /// Trim (`delta < 0`) or extend (`delta > 0`) the tail of a clip: change
    /// `duration` by `delta` — `start_frame` is untouched (the clip's *start*
    /// stays fixed, its end slides), clamped so the clip keeps ≥ 1 frame,
    /// does not run past `source_len`, and (D-054) never grows past the
    /// `start_frame` of the nearest following clip on the same track (no
    /// overlap) — shrinking only ever opens/grows a gap after the clip.
    ///
    /// **D-129 — trims in lockstep with every other member of the clip's A/V
    /// link group**, on the same "identical applied delta or reject the whole
    /// op" contract as [`Self::trim_start`] — see that method's doc.
    pub fn trim_end(
        &mut self,
        track: usize,
        clip_idx: usize,
        delta: i64,
    ) -> Result<(), TimelineError> {
        let t = self
            .tracks
            .get(track)
            .ok_or(TimelineError::NoSuchTrack(track))?;
        if t.locked {
            return Err(TimelineError::TrackLocked(track));
        }
        if clip_idx >= t.clips.len() {
            return Err(TimelineError::NoSuchClip(clip_idx, track));
        }
        let new_dur = clamped_trim_end_duration(t, clip_idx, delta);
        let applied = new_dur - t.clips[clip_idx].duration;

        let link = self.link_targets(track, clip_idx);
        if let Some((group, members)) = &link {
            for &(ti, ci) in members {
                if (ti, ci) == (track, clip_idx) {
                    continue;
                }
                let ot = &self.tracks[ti];
                if ot.locked {
                    return Err(TimelineError::TrackLocked(ti));
                }
                if clamped_trim_end_duration(ot, ci, delta) - ot.clips[ci].duration != applied {
                    return Err(TimelineError::LinkDesync(group.clone()));
                }
            }
        }

        let targets = link
            .map(|(_, m)| m)
            .unwrap_or_else(|| vec![(track, clip_idx)]);
        for (ti, ci) in targets {
            let clip = &mut self.tracks[ti].clips[ci];
            clip.duration += applied;
        }
        Ok(())
    }

    /// Split the clip that spans `at_timeline_frame` into two back-to-back
    /// clips (the right half starts exactly where the left half now ends —
    /// splitting never introduces a gap). `at_timeline_frame` must land
    /// strictly inside `clip_idx` (not on either edge).
    ///
    /// **D-129 — a razor through one member of an A/V link group cuts every
    /// member at the same frame**, matching both references exactly ("clicking
    /// a linked clip with the Razor Tool cuts both tracks at once"). The two
    /// resulting halves are two intact pairs, not one four-way group: the left
    /// halves keep the original group id, the right halves all move to a
    /// derived one (`{group}·{frame}`, the same derivation this method already
    /// uses for the right half's clip id). If `at_timeline_frame` isn't
    /// strictly inside *every* member (the halves have been slipped apart into
    /// an L-cut), the whole op is rejected with
    /// [`TimelineError::LinkDesync`] rather than cutting some members and not
    /// others.
    pub fn split(
        &mut self,
        track: usize,
        clip_idx: usize,
        at_timeline_frame: i64,
    ) -> Result<(), TimelineError> {
        let t = self
            .tracks
            .get(track)
            .ok_or(TimelineError::NoSuchTrack(track))?;
        if t.locked {
            return Err(TimelineError::TrackLocked(track));
        }
        if clip_idx >= t.clips.len() {
            return Err(TimelineError::NoSuchClip(clip_idx, track));
        }
        let clip = &t.clips[clip_idx];
        let offset = at_timeline_frame - clip.start_frame;
        if offset <= 0 || offset >= clip.duration {
            return Err(TimelineError::SplitOutsideClip(at_timeline_frame, clip_idx));
        }

        let link = self.link_targets(track, clip_idx);
        if let Some((group, members)) = &link {
            for &(ti, ci) in members {
                if (ti, ci) == (track, clip_idx) {
                    continue;
                }
                let ot = &self.tracks[ti];
                if ot.locked {
                    return Err(TimelineError::TrackLocked(ti));
                }
                let o = &ot.clips[ci];
                let off = at_timeline_frame - o.start_frame;
                if off <= 0 || off >= o.duration {
                    return Err(TimelineError::LinkDesync(group.clone()));
                }
            }
        }

        let right_group = link
            .as_ref()
            .map(|(g, _)| format!("{g}·{at_timeline_frame}"));
        // Descending, so inserting each right half at `ci + 1` never shifts
        // an index still to be processed (only matters when two members share
        // a track — possible for a richer group, harmless for a plain pair).
        let mut targets = link
            .map(|(_, m)| m)
            .unwrap_or_else(|| vec![(track, clip_idx)]);
        targets.sort_unstable();
        targets.reverse();
        for (ti, ci) in targets {
            let t = &mut self.tracks[ti];
            let src = &t.clips[ci];
            let off = at_timeline_frame - src.start_frame;
            let mut right = src.clone();
            right.id = format!("{}·{}", src.id, at_timeline_frame);
            right.start_frame = src.start_frame + off;
            right.source_start = src.source_start + off;
            right.duration = src.duration - off;
            right.link_group = right_group.clone();
            t.clips[ci].duration = off;
            t.clips.insert(ci + 1, right);
        }
        Ok(())
    }

    /// Remove the clip at `clip_idx` on `track`. Unlike a "ripple delete",
    /// nothing else on the track moves (D-054: positions are explicit now) —
    /// this simply opens (or grows) a gap where the clip used to be.
    ///
    /// **D-129 — deleting one member of an A/V link group deletes every
    /// member**, matching both references ("any change made to one — moving,
    /// trimming, or deleting — automatically applies to the other"). Refused
    /// whole if any member's own track is locked. Each emptied track is
    /// pruned, highest index first so the lower ones stay valid.
    pub fn remove(&mut self, track: usize, clip_idx: usize) -> Result<(), TimelineError> {
        let t = self
            .tracks
            .get(track)
            .ok_or(TimelineError::NoSuchTrack(track))?;
        if t.locked {
            return Err(TimelineError::TrackLocked(track));
        }
        if clip_idx >= t.clips.len() {
            return Err(TimelineError::NoSuchClip(clip_idx, track));
        }

        let link = self.link_targets(track, clip_idx);
        if let Some((_, members)) = &link {
            for &(ti, _) in members {
                if self.tracks[ti].locked {
                    return Err(TimelineError::TrackLocked(ti));
                }
            }
        }
        let mut targets = link
            .map(|(_, m)| m)
            .unwrap_or_else(|| vec![(track, clip_idx)]);
        targets.sort_unstable();
        targets.reverse();
        let mut touched: Vec<usize> = targets.iter().map(|(ti, _)| *ti).collect();
        for (ti, ci) in targets {
            self.tracks[ti].clips.remove(ci);
        }
        touched.sort_unstable();
        touched.dedup();
        for ti in touched.into_iter().rev() {
            self.prune_if_empty(ti);
        }
        Ok(())
    }

    /// Auto-decommission an empty track (owner, live: "if we have an empty
    /// track we auto decommission it and renumber the tracks"). Mirrors
    /// `timeline.ts::pruneIfEmptyTrack` field-for-field — see that function's
    /// own doc for the full reasoning (deliberately narrow, only the track a
    /// `remove`/cross-track `move_clip` call just emptied, not a blanket
    /// sweep; a real, checked-live deviation from Premiere/Resolve's own
    /// "manual Delete Empty Tracks only" default). `Vec::remove` renumbers
    /// every later track by construction.
    fn prune_if_empty(&mut self, track: usize) {
        if self.tracks.get(track).is_some_and(|t| t.clips.is_empty()) {
            self.tracks.remove(track);
        }
    }

    /// D-105 — the ONE ripple op besides `add_clip`'s own insertion ripple
    /// (see that fn's doc): close the gap on `track` containing `at_frame` by
    /// shifting every clip at/after the gap's end earlier by the gap's own
    /// width. `remove` deliberately leaves a gap (D-054's "positions are
    /// explicit, ops stay explicit-position-only" contract) — this is the
    /// mirror-image op a real NLE always pairs with that: select the empty
    /// space itself, delete IT, and have the timeline actually close up
    /// around it, rather than leaving every later clip to be dragged left by
    /// hand one at a time. `Track::gap_at` does the actual "is `at_frame`
    /// inside a real, closeable gap" work — see its own doc for why trailing
    /// empty space past the last clip does NOT count (nothing to ripple).
    pub fn remove_gap(&mut self, track: usize, at_frame: i64) -> Result<(), TimelineError> {
        let (gap_start, gap_end) = {
            let t = self.track_mut(track)?;
            t.gap_at(at_frame)
                .ok_or(TimelineError::NoGapAt(track, at_frame))?
        };
        let shift = gap_end - gap_start;
        // B-033 — reject upfront if a sync-locked track has a straddling
        // clip, checked before any mutation.
        if has_straddling_sync_locked_clip(&self.tracks, track, gap_end) {
            return Err(TimelineError::SyncLockedStraddle(gap_end));
        }
        shift_clips_at_or_after(&mut self.tracks[track], gap_end, -shift);
        // D-106 — every OTHER sync-locked track ripples too, unconditionally
        // (not gated on THAT track having a matching gap at `gap_end` —
        // Resolve's own real behavior, confirmed live: the whole point of
        // sync-lock is that another track may have a long, unrelated clip
        // spanning straight through the edit point, handled by the
        // straddle-auto-split in `ripple_shift_with_auto_split` rather than
        // requiring a matching gap to exist there too). The gap-*finding*
        // requirement above stays exactly as-is for `track` itself only.
        propagate_sync_lock_ripple(&mut self.tracks, track, gap_end, -shift);
        Ok(())
    }
}

impl Track {
    /// Length of this track in frames — the furthest clip end, since clips
    /// may now (D-054) leave a trailing gap before the track's nominal end,
    /// and there's nothing to render past the last clip either way.
    pub fn duration(&self) -> i64 {
        self.clips.iter().map(Clip::end_frame).max().unwrap_or(0)
    }

    /// The clip covering `timeline_frame` and the matching **source** frame
    /// inside it. `None` if the position is negative, past every clip's end,
    /// or (D-054) lands inside a gap between clips — the same "nothing here"
    /// result for all three, which is what every caller (the preview decode
    /// path) already treats identically.
    pub fn clip_at(&self, timeline_frame: i64) -> Option<(&Clip, i64)> {
        if timeline_frame < 0 {
            return None;
        }
        self.clips
            .iter()
            .find(|c| timeline_frame >= c.start_frame && timeline_frame < c.end_frame())
            .map(|c| (c, c.source_start + (timeline_frame - c.start_frame)))
    }

    /// D-105 — the exclusive `[gap_start, gap_end)` bounds of the **real,
    /// closeable** gap containing `timeline_frame`, or `None` if there isn't
    /// one. Two ways there isn't one: `timeline_frame` is inside a clip (use
    /// `clip_at` for that), or it's past the last clip on the track — that's
    /// trailing empty space, not a gap a ripple-close can do anything with
    /// (there's nothing after it to shift earlier). `gap_start` is the
    /// furthest clip-end at or before `timeline_frame` (0 if none — a gap
    /// before the very first clip counts), `gap_end` the nearest clip-start
    /// at or after it. Clips are walked in **value**, not Vec order (D-054:
    /// Vec order is bookkeeping only) — this is correct regardless of
    /// storage order, same discipline `clip_at` already follows.
    pub fn gap_at(&self, timeline_frame: i64) -> Option<(i64, i64)> {
        if timeline_frame < 0 || self.clip_at(timeline_frame).is_some() {
            return None;
        }
        let gap_start = self
            .clips
            .iter()
            .map(Clip::end_frame)
            .filter(|&e| e <= timeline_frame)
            .max()
            .unwrap_or(0);
        let gap_end = self
            .clips
            .iter()
            .map(|c| c.start_frame)
            .filter(|&s| s > gap_start)
            .min()?;
        Some((gap_start, gap_end))
    }

    /// See `Timeline::backfill_legacy_positions` — the per-track half of
    /// that migration. Walks clips in **Vec order**, which for any wholly
    /// pre-D-054 track is the same order `clip_at`'s old cumulative-duration
    /// walk used, so accumulating durations here reconstructs the exact
    /// positions that track rendered at before D-054. A clip that already
    /// carries a real `start_frame` (any already-migrated or freshly-built
    /// track) is left untouched, and the running accumulator continues from
    /// its real value — so a mix of real and legacy-sentinel clips (not a
    /// shape this codebase ever produces, but not unsafe either) still ends
    /// up gap-consistent rather than corrupted.
    fn backfill_legacy_positions(&mut self) {
        let mut acc = 0i64;
        for clip in &mut self.clips {
            if clip.start_frame == LEGACY_MISSING_START {
                clip.start_frame = acc;
            }
            acc = clip.start_frame + clip.duration;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shots() -> Vec<(String, String, String, i64)> {
        vec![
            ("s1".into(), "/a.mov".into(), "A".into(), 100),
            ("s2".into(), "/b.mov".into(), "B".into(), 50),
            ("s3".into(), "/c.mov".into(), "C".into(), 200),
        ]
    }

    #[test]
    fn it_builds() {
        let t = Timeline::from_shots(&shots());
        assert_eq!(t.tracks.len(), 1);
        assert_eq!(t.tracks[0].clips.len(), 3);
        assert_eq!(t.tracks[0].clips[0].duration, 100);
        assert_eq!(t.tracks[0].clips[1].shot_id.as_deref(), Some("s2"));
        assert_eq!(t.duration(), 350);
    }

    #[test]
    fn from_shots_lays_clips_back_to_back() {
        let t = Timeline::from_shots(&shots());
        let starts: Vec<i64> = t.tracks[0].clips.iter().map(|c| c.start_frame).collect();
        assert_eq!(starts, vec![0, 100, 150]);
    }

    #[test]
    fn serde_round_trips() {
        let t = Timeline::from_shots(&shots());
        let json = serde_json::to_string(&t).unwrap();
        let back: Timeline = serde_json::from_str(&json).unwrap();
        assert_eq!(back.tracks[0].clips[2].name, "C");
        assert_eq!(back.tracks[0].clips[2].source_len, 200);
        assert_eq!(back.tracks[0].clips[2].start_frame, 150);
        assert_eq!(back.duration(), 350);
    }

    #[test]
    fn legacy_clip_json_without_new_fields_loads() {
        let j = r#"{"name":"x","tracks":[{"kind":"video","clips":[
            {"name":"old","source_path":"/o.mov","source_start":10,"duration":40}]}]}"#;
        let t: Timeline = serde_json::from_str(j).unwrap();
        let c = &t.tracks[0].clips[0];
        assert_eq!(c.id, "");
        assert_eq!(c.source_len, 0);
        assert_eq!(c.duration, 40);
        assert_eq!(
            c.start_frame, LEGACY_MISSING_START,
            "raw deserialize alone leaves the migration sentinel — a caller \
             must run backfill_legacy_positions"
        );
    }

    /// D-054: a whole pre-migration track (every clip missing `start_frame`)
    /// backfills to the exact back-to-back layout the old `clip_at`
    /// cumulative walk produced.
    #[test]
    fn backfill_reconstructs_back_to_back_positions_for_a_legacy_track() {
        let j = r#"{"name":"x","tracks":[{"kind":"video","clips":[
            {"id":"a","name":"A","source_path":"/a.mov","source_start":0,"duration":100,"source_len":100},
            {"id":"b","name":"B","source_path":"/b.mov","source_start":0,"duration":50,"source_len":50},
            {"id":"c","name":"C","source_path":"/c.mov","source_start":0,"duration":200,"source_len":200}
        ]}]}"#;
        let mut t: Timeline = serde_json::from_str(j).unwrap();
        t.backfill_legacy_positions();
        let starts: Vec<i64> = t.tracks[0].clips.iter().map(|c| c.start_frame).collect();
        assert_eq!(
            starts,
            vec![0, 100, 150],
            "matches the pre-D-054 implicit layout"
        );
        assert_eq!(t.duration(), 350);

        // idempotent: running it again changes nothing
        t.backfill_legacy_positions();
        let starts2: Vec<i64> = t.tracks[0].clips.iter().map(|c| c.start_frame).collect();
        assert_eq!(starts2, vec![0, 100, 150]);
    }

    /// The exact single-clip shape found in the real
    /// `~/Movies/Chroma/New.chroma/project.json` (checked by hand against
    /// that file, D-045-style) — one clip, no `start_frame` key at all.
    #[test]
    fn backfill_matches_the_real_project_json_single_clip_shape() {
        let j = r#"{"name":"New","tracks":[{"kind":"video","clips":[
            {"id":"8022aef1-78db-491e-aeb4-03a78b785af7",
             "shot_id":"8022aef1-78db-491e-aeb4-03a78b785af7",
             "name":"pexels_28808272.mp4",
             "source_path":"/Users/ashishmaurya/Downloads/pexels_28808272.mp4",
             "source_start":0,"duration":1078,"source_len":1078}]}]}"#;
        let mut t: Timeline = serde_json::from_str(j).unwrap();
        t.backfill_legacy_positions();
        assert_eq!(t.tracks[0].clips[0].start_frame, 0);
        assert_eq!(t.duration(), 1078);
    }

    /// D-045: a pre-D-045 `Timeline` JSON blob (the shape every project.json
    /// had under the old singular `timeline` key) never had an `id` field —
    /// it must still deserialize, defaulting to `""`. `chroma::project`'s
    /// migration backfills a real id on the raw JSON before this runs; this
    /// test only pins the crate-level fallback the migration relies on.
    #[test]
    fn legacy_timeline_json_without_id_defaults_empty() {
        let j = r#"{"name":"New","rate":null,"tracks":[{"kind":"video","clips":[]}]}"#;
        let t: Timeline = serde_json::from_str(j).unwrap();
        assert_eq!(t.id, "");
        assert_eq!(t.name, "New");
    }

    #[test]
    fn clip_at_walks_positions() {
        let t = Timeline::from_shots(&shots());
        let tr = &t.tracks[0];
        assert_eq!(
            tr.clip_at(0).map(|(c, f)| (c.name.as_str(), f)),
            Some(("A", 0))
        );
        assert_eq!(
            tr.clip_at(99).map(|(c, f)| (c.name.as_str(), f)),
            Some(("A", 99))
        );
        assert_eq!(
            tr.clip_at(100).map(|(c, f)| (c.name.as_str(), f)),
            Some(("B", 0))
        );
        assert_eq!(
            tr.clip_at(149).map(|(c, f)| (c.name.as_str(), f)),
            Some(("B", 49))
        );
        assert_eq!(
            tr.clip_at(150).map(|(c, f)| (c.name.as_str(), f)),
            Some(("C", 0))
        );
        assert_eq!(
            tr.clip_at(349).map(|(c, f)| (c.name.as_str(), f)),
            Some(("C", 199))
        );
        assert!(tr.clip_at(350).is_none());
        assert!(tr.clip_at(-1).is_none());
    }

    /// D-054: a query landing inside a gap between two clips returns `None`,
    /// same as past-the-end — never panics, never returns the wrong clip.
    #[test]
    fn clip_at_inside_a_gap_is_none() {
        let mut t = Timeline::default();
        t.tracks.push(Track {
            kind: TrackKind::Video,
            gain: default_track_gain(),
            locked: false,
            hidden: false,
            sync_locked: default_sync_locked(),
            clips: vec![
                Clip {
                    id: "a".into(),
                    name: "A".into(),
                    source_path: "/a.mov".into(),
                    duration: 50,
                    source_len: 50,
                    start_frame: 0,
                    ..Default::default()
                },
                // gap [50, 100)
                Clip {
                    id: "b".into(),
                    name: "B".into(),
                    source_path: "/b.mov".into(),
                    duration: 50,
                    source_len: 50,
                    start_frame: 100,
                    ..Default::default()
                },
            ],
        });
        let tr = &t.tracks[0];
        assert_eq!(tr.clip_at(49).map(|(c, _)| c.name.as_str()), Some("A"));
        assert!(tr.clip_at(50).is_none(), "right at the gap's start");
        assert!(tr.clip_at(75).is_none(), "middle of the gap");
        assert!(tr.clip_at(99).is_none(), "right before the gap ends");
        assert_eq!(tr.clip_at(100).map(|(c, _)| c.name.as_str()), Some("B"));
        assert_eq!(
            t.duration(),
            150,
            "duration is the furthest clip end, gap included"
        );
    }

    #[test]
    fn reorder_changes_vec_order_but_not_positions() {
        let mut t = Timeline::from_shots(&shots());
        let mut before: Vec<(i64, i64)> = t.tracks[0]
            .clips
            .iter()
            .map(|c| (c.start_frame, c.duration))
            .collect();
        t.reorder(0, 0, 2).unwrap();
        let names: Vec<_> = t.tracks[0].clips.iter().map(|c| c.name.clone()).collect();
        assert_eq!(names, vec!["B", "C", "A"], "Vec order does change");
        let mut after: Vec<(i64, i64)> = t.tracks[0]
            .clips
            .iter()
            .map(|c| (c.start_frame, c.duration))
            .collect();
        // each clip individually kept its own (start_frame, duration) — only
        // which Vec slot holds it changed.
        before.sort();
        after.sort();
        assert_eq!(before, after, "no clip moved in time");
        // clip_at results are therefore unchanged too
        let tr = &t.tracks[0];
        assert_eq!(tr.clip_at(0).map(|(c, _)| c.name.clone()), Some("A".into()));
        assert_eq!(
            tr.clip_at(150).map(|(c, _)| c.name.clone()),
            Some("C".into())
        );
        assert_eq!(t.reorder(0, 5, 0), Err(TimelineError::BadIndex(5)));
        assert_eq!(t.reorder(9, 0, 0), Err(TimelineError::NoSuchTrack(9)));
    }

    #[test]
    fn trim_start_clamps_and_shortens() {
        let mut t = Timeline::from_shots(&shots());
        t.trim_start(0, 0, 20).unwrap();
        let c = &t.tracks[0].clips[0];
        assert_eq!((c.source_start, c.start_frame, c.duration), (20, 20, 80));
        // extend back past 0 clamps
        t.trim_start(0, 0, -100).unwrap();
        let c = &t.tracks[0].clips[0];
        assert_eq!((c.source_start, c.start_frame, c.duration), (0, 0, 100));
        // a head trim that would push past the clip's own (already shortened)
        // tail empties it → error
        t.trim_end(0, 1, -40).unwrap(); // clip B: dur 50 -> 10
        assert_eq!(t.trim_start(0, 1, 10), Err(TimelineError::EmptyClip));
        assert_eq!(t.trim_start(0, 1, 25), Err(TimelineError::EmptyClip));
        // a head trim within the shortened clip still works
        t.trim_start(0, 1, 5).unwrap();
        let b = &t.tracks[0].clips[1];
        assert_eq!((b.source_start, b.start_frame, b.duration), (5, 105, 5));
    }

    /// D-054: trimming the head to the right opens a gap before the clip
    /// (nothing ripples to close it); the clip's *end* stays fixed.
    #[test]
    fn trim_start_opens_a_gap_before_the_clip() {
        let mut t = Timeline::from_shots(&shots());
        let b_end_before = t.tracks[0].clips[1].end_frame();
        t.trim_start(0, 1, 20).unwrap(); // clip B: start 100 -> 120, dur 50 -> 30
        let b = &t.tracks[0].clips[1];
        assert_eq!((b.start_frame, b.duration), (120, 30));
        assert_eq!(
            b.end_frame(),
            b_end_before,
            "end frame unaffected by a head trim"
        );
        assert!(
            t.tracks[0].clip_at(110).is_none(),
            "the new gap between A's end (100) and B's new start (120)"
        );
    }

    /// D-054: extending the head left is clamped so it can't eat into the
    /// preceding clip on the same track.
    #[test]
    fn trim_start_extend_clamps_to_the_previous_clip() {
        let mut t = Timeline::from_shots(&shots());
        // clip B starts at 100, right after A ends at 100 — no room to extend left at all
        t.trim_start(0, 1, -10).unwrap();
        let b = &t.tracks[0].clips[1];
        assert_eq!(
            (b.start_frame, b.duration),
            (100, 50),
            "clamped to A's end — no overlap introduced"
        );
    }

    #[test]
    fn trim_end_clamps_to_media() {
        let mut t = Timeline::from_shots(&shots());
        t.trim_end(0, 0, -30).unwrap();
        assert_eq!(t.tracks[0].clips[0].duration, 70);
        // can't extend past source_len (100) — and (D-054) B starts at 100
        // anyway, so both bounds agree here
        t.trim_end(0, 0, 999).unwrap();
        assert_eq!(t.tracks[0].clips[0].duration, 100);
        assert_eq!(t.trim_end(0, 9, 1), Err(TimelineError::NoSuchClip(9, 0)));
    }

    /// D-054: trim_end can never grow a clip into the next clip on the same
    /// track, even when the source media has room to extend further.
    #[test]
    fn trim_end_clamps_to_the_next_clip() {
        let mut t = Timeline::from_shots(&shots());
        // A: start 0, dur 100, source_len 100 — B starts right at 100.
        t.trim_start(0, 1, 20).unwrap(); // move B's start to 120 (gap [100,120))
        t.trim_end(0, 0, 999).unwrap(); // try to grow A way past both bounds
        let a = &t.tracks[0].clips[0];
        assert_eq!(
            a.duration, 100,
            "clamped by source_len (100), tighter here than the 120 position bound"
        );

        // now prove the *position* bound independently: shrink A first so
        // source_len (100) is no longer the tighter constraint, then grow
        // back — it must stop at B's start (120), not source_len (100)... but
        // it can't exceed source_len either, so use a fresh clip with a very
        // long source to isolate the position clamp.
        let mut t2 = Timeline::default();
        t2.tracks.push(Track {
            kind: TrackKind::Video,
            gain: default_track_gain(),
            locked: false,
            hidden: false,
            sync_locked: default_sync_locked(),
            clips: vec![
                Clip {
                    id: "x".into(),
                    name: "X".into(),
                    source_path: "/x.mov".into(),
                    source_start: 0,
                    duration: 10,
                    source_len: 10_000, // plenty of source headroom
                    start_frame: 0,
                    ..Default::default()
                },
                Clip {
                    id: "y".into(),
                    name: "Y".into(),
                    source_path: "/y.mov".into(),
                    source_start: 0,
                    duration: 10,
                    source_len: 10,
                    start_frame: 50, // gap [10, 50)
                    ..Default::default()
                },
            ],
        });
        t2.trim_end(0, 0, 999).unwrap();
        assert_eq!(
            t2.tracks[0].clips[0].duration, 50,
            "grew right up to Y's start (50), not further, despite ample source_len"
        );
    }

    #[test]
    fn split_makes_two_clips() {
        let mut t = Timeline::from_shots(&shots());
        // clip B spans timeline [100, 150); split at 120
        t.split(0, 1, 120).unwrap();
        assert_eq!(t.tracks[0].clips.len(), 4);
        let b1 = &t.tracks[0].clips[1];
        let b2 = &t.tracks[0].clips[2];
        assert_eq!((b1.start_frame, b1.source_start, b1.duration), (100, 0, 20));
        assert_eq!(
            (b2.start_frame, b2.source_start, b2.duration),
            (120, 20, 30)
        );
        assert_eq!(b2.name, "B");
        assert_ne!(b1.id, b2.id);
        assert_eq!(t.duration(), 350, "split preserves total length");
        assert_eq!(
            b1.end_frame(),
            b2.start_frame,
            "the two halves are still back to back — split never opens a gap"
        );
        // on an edge → error
        assert!(matches!(
            t.split(0, 0, 0),
            Err(TimelineError::SplitOutsideClip(0, 0))
        ));
    }

    #[test]
    fn remove_leaves_a_gap() {
        let mut t = Timeline::from_shots(&shots());
        t.remove(0, 1).unwrap();
        let names: Vec<_> = t.tracks[0].clips.iter().map(|c| c.name.clone()).collect();
        assert_eq!(names, vec!["A", "C"]);
        // D-054: C never moves — it's still at 150, so total duration is
        // still 350 (unlike the pre-D-054 ripple-close behaviour, which
        // would have collapsed this to 300; flagged in D-054).
        assert_eq!(t.duration(), 350);
        assert!(
            t.tracks[0].clip_at(120).is_none(),
            "B's old slot [100,150) is now a gap"
        );
        assert_eq!(t.remove(0, 9), Err(TimelineError::NoSuchClip(9, 0)));
    }

    // --- gap select + delete (D-105) -----------------------------------------

    #[test]
    fn remove_gap_closes_the_gap_and_ripples_everything_after_it() {
        let mut t = Timeline::from_shots(&shots()); // A[0,100) B[100,150) C[150,350)
        t.remove(0, 1).unwrap(); // opens B's old slot: A[0,100) gap[100,150) C@150
        assert_eq!(t.tracks[0].gap_at(120), Some((100, 150)));

        t.remove_gap(0, 120).unwrap();
        let names_and_starts: Vec<_> = t.tracks[0]
            .clips
            .iter()
            .map(|c| (c.name.clone(), c.start_frame))
            .collect();
        assert_eq!(names_and_starts, vec![("A".into(), 0), ("C".into(), 100)]);
        assert_eq!(t.duration(), 300, "the whole gap's 50 frames are gone");
        assert!(t.tracks[0].clip_at(50).is_some(), "A untouched");
        assert!(
            t.tracks[0].clip_at(120).is_some(),
            "what used to be inside the gap is now inside C, shifted left"
        );
    }

    #[test]
    fn remove_gap_before_the_first_clip() {
        let mut t = Timeline::from_shots(&shots());
        t.remove(0, 2).unwrap(); // drop C
        t.remove(0, 1).unwrap(); // drop B — only A[0,100) left
        t.move_clip(0, 0, 0, 200, false).unwrap(); // A -> [200,300), opens [0,200) before it
        assert_eq!(t.tracks[0].gap_at(10), Some((0, 200)));
        t.remove_gap(0, 10).unwrap();
        let a = t.tracks[0].clips.iter().find(|c| c.name == "A").unwrap();
        assert_eq!(a.start_frame, 0, "everything shifts left by the gap's 200 frames");
    }

    #[test]
    fn remove_gap_rejects_a_frame_inside_a_clip() {
        let mut t = Timeline::from_shots(&shots()); // no gaps at all — back to back
        assert_eq!(t.tracks[0].gap_at(50), None);
        assert_eq!(t.remove_gap(0, 50), Err(TimelineError::NoGapAt(0, 50)));
    }

    #[test]
    fn remove_gap_rejects_trailing_empty_space_past_the_last_clip() {
        let mut t = Timeline::from_shots(&shots()); // C ends at 350
        assert_eq!(
            t.tracks[0].gap_at(500),
            None,
            "past the last clip isn't a real, closeable gap — nothing after it to ripple"
        );
        assert_eq!(t.remove_gap(0, 500), Err(TimelineError::NoGapAt(0, 500)));
    }

    #[test]
    fn remove_gap_refuses_on_a_locked_track() {
        let mut t = Timeline::from_shots(&shots());
        t.remove(0, 1).unwrap(); // open a real gap first
        t.tracks[0].locked = true;
        assert_eq!(t.remove_gap(0, 120), Err(TimelineError::TrackLocked(0)));
    }

    #[test]
    fn remove_gap_rejects_out_of_range_track() {
        let mut t = Timeline::from_shots(&shots());
        assert_eq!(t.remove_gap(9, 0), Err(TimelineError::NoSuchTrack(9)));
    }

    // --- track management (D-054) -------------------------------------------

    #[test]
    fn add_and_remove_track_round_trip() {
        let mut t = Timeline::from_shots(&shots());
        assert_eq!(t.tracks.len(), 1);
        let idx = t.add_track(TrackKind::Audio);
        assert_eq!(idx, 1);
        assert_eq!(t.tracks.len(), 2);
        assert_eq!(t.tracks[1].kind, TrackKind::Audio);
        assert!(t.tracks[1].clips.is_empty());
        assert_eq!(
            t.tracks[1].gain, 1.0,
            "D-057: a new track starts at unity gain"
        );

        t.remove_track(0).unwrap();
        assert_eq!(t.tracks.len(), 1);
        assert_eq!(
            t.tracks[0].kind,
            TrackKind::Audio,
            "the video track was the one removed"
        );

        assert_eq!(t.remove_track(9), Err(TimelineError::NoSuchTrack(9)));
    }

    #[test]
    fn remove_track_drops_its_clips_too() {
        let mut t = Timeline::from_shots(&shots());
        assert!(!t.tracks[0].clips.is_empty());
        t.remove_track(0).unwrap();
        assert!(
            t.tracks.is_empty(),
            "the track and everything on it is gone"
        );
    }

    #[test]
    fn move_clip_across_tracks_preserves_identity() {
        let mut t = Timeline::from_shots(&shots());
        t.add_track(TrackKind::Video);
        let moved_id = t.tracks[0].clips[1].id.clone(); // "s2" / clip B
        t.move_clip(0, 1, 1, 500, false).unwrap();

        assert_eq!(t.tracks[0].clips.len(), 2, "removed from the source track");
        assert_eq!(
            t.tracks[1].clips.len(),
            1,
            "landed on the destination track"
        );
        let moved = &t.tracks[1].clips[0];
        assert_eq!(moved.id, moved_id, "identity preserved across the move");
        assert_eq!(moved.start_frame, 500);
        assert_eq!(moved.duration, 50, "duration/source window untouched");
    }

    #[test]
    fn move_clip_rejects_overlap_across_tracks_too() {
        // D-104 — reverses D-096: a cross-track move landing directly on top
        // of another clip's time range is now rejected, same as a same-track
        // move (`move_clip_rejects_overlap`). Live-tested and explicitly
        // overridden by the owner: overlap should never be a reachable
        // outcome of a plain drag.
        let mut t = Timeline::from_shots(&shots()); // track 0: A[0,100) B[100,150) C[150,350)
        t.add_track(TrackKind::Video);
        t.move_clip(0, 1, 1, 0, false).unwrap(); // B -> track 1 at [0,50)
        // C is now track 0's clip index 1 (A stayed at 0); try to move it
        // onto track 1 at frame 0 too — directly overlapping B's [0,50).
        let err = t.move_clip(0, 1, 1, 0, false).unwrap_err();
        assert_eq!(err, TimelineError::Overlap(1, 0));
        assert_eq!(t.tracks[1].clips.len(), 1, "the overlapping move was rejected");
    }

    #[test]
    fn move_clip_ripple_makes_room_same_track_and_cross_track() {
        // D-104 — `ripple: true` shifts everything at/after the landing
        // point later by the moved clip's own duration to make room, instead
        // of overlapping — the same "make room" contract `add_clip`'s
        // `computeInsertion` already gives a brand-new clip from Sources, now
        // available to an EXISTING clip being moved too.
        let mut t = Timeline::from_shots(&shots()); // track 0: A[0,100) B[100,150) C[150,350)

        // Cross-track: move B onto a fresh track 1 at frame 0, then ripple C
        // (now index 1 on track 0) onto the SAME spot on track 1 — B should
        // shift later by C's duration (200) instead of being overlapped.
        t.add_track(TrackKind::Video);
        t.move_clip(0, 1, 1, 0, false).unwrap(); // B -> track 1 @ [0,50)
        t.move_clip(0, 1, 1, 0, true).unwrap(); // C -> track 1 @ [0,200), ripples B later
        let starts: Vec<i64> = t.tracks[1].clips.iter().map(|c| c.start_frame).collect();
        assert_eq!(starts, vec![200, 0], "B shifted to make room for C, not overlapped");
        let durations: Vec<i64> = t.tracks[1].clips.iter().map(|c| c.duration).collect();
        assert_eq!(durations, vec![50, 200], "only start_frame moved, durations untouched");

        // Same-track: a fresh timeline has A[0,100) B[100,150) C[150,350) on
        // track 0. Rippling A onto B's exact start (100) should shift BOTH
        // B and C later by A's duration (100), not just the nearest one.
        let mut t2 = Timeline::from_shots(&shots());
        t2.move_clip(0, 0, 0, 100, true).unwrap(); // A -> [100,200), ripples B and C
        let by_name: std::collections::HashMap<&str, i64> = t2.tracks[0]
            .clips
            .iter()
            .map(|c| (c.name.as_str(), c.start_frame))
            .collect();
        assert_eq!(by_name["A"], 100, "A landed at the requested frame");
        assert_eq!(by_name["B"], 200, "B rippled later by A's duration");
        assert_eq!(by_name["C"], 250, "C rippled later too, still after B's new start");
    }

    #[test]
    fn move_clip_ripple_rejects_a_straddling_clip_it_cannot_cleanly_shift() {
        // D-104 — ripple only ever shifts clips starting AT/AFTER the
        // landing point (the real, edge-aligned case the frontend's
        // `resolveClipLanding` always produces). B here starts BEFORE the
        // landing point (50 < 70) but extends past it (100 > 70) — not a
        // real ripple-insert scenario any NLE supports without splitting B
        // first — so ripple can't rescue it; this must reject the same as a
        // plain overlap.
        let mut t = Timeline::from_shots(&shots());
        t.add_track(TrackKind::Video);
        t.move_clip(0, 1, 1, 50, false).unwrap(); // B -> track 1 @ [50,100)
        // A (duration 100) dropped onto track 1 at frame 70 -> [70,170),
        // straddling B's [50,100) span.
        let err = t.move_clip(0, 0, 1, 70, true).unwrap_err();
        assert_eq!(err, TimelineError::Overlap(1, 70));
        assert_eq!(t.tracks[1].clips.len(), 1, "the straddling ripple attempt was rejected, nothing moved");
    }

    #[test]
    fn move_clip_within_the_same_track_repositions_it() {
        let mut t = Timeline::from_shots(&shots());
        t.move_clip(0, 0, 0, 1000, false).unwrap(); // move A far to the right
        assert_eq!(
            t.tracks[0].clips.len(),
            3,
            "still 3 clips, just repositioned"
        );
        assert!(
            t.tracks[0].clip_at(0).is_none(),
            "A's old slot is now a gap"
        );
        let a = t.tracks[0].clips.iter().find(|c| c.name == "A").unwrap();
        assert_eq!(a.start_frame, 1000);
    }

    #[test]
    fn move_clip_rejects_overlap() {
        let mut t = Timeline::from_shots(&shots());
        // try to move C (start 150, dur 200) onto A's slot (start 0, dur 100)
        let err = t.move_clip(0, 2, 0, 0, false).unwrap_err();
        assert_eq!(err, TimelineError::Overlap(0, 0));
        // a partial overlap is rejected too
        let err2 = t.move_clip(0, 2, 0, 50, false).unwrap_err();
        assert_eq!(err2, TimelineError::Overlap(0, 50));
        // landing exactly back-to-back (no overlap) is fine
        t.move_clip(0, 2, 0, 100 + 50, false).unwrap(); // right after B ends
        assert_eq!(t.tracks[0].clips.len(), 3);
    }

    #[test]
    fn move_clip_rejects_out_of_range_and_negative_position() {
        let mut t = Timeline::from_shots(&shots());
        assert_eq!(t.move_clip(9, 0, 0, 0, false), Err(TimelineError::NoSuchTrack(9)));
        assert_eq!(
            t.move_clip(0, 9, 0, 0, false),
            Err(TimelineError::NoSuchClip(9, 0))
        );
        assert_eq!(t.move_clip(0, 0, 9, 0, false), Err(TimelineError::NoSuchTrack(9)));
        assert_eq!(
            t.move_clip(0, 0, 0, -1, false),
            Err(TimelineError::NegativePosition(-1))
        );
    }

    // --- auto-decommission empty tracks (owner, live) -----------------------
    // Mirrors `timeline.ts`'s own `pruneIfEmptyTrack` test coverage
    // field-for-field — see that function's doc comment for the real
    // Premiere/Resolve reference check behind the "only the directly-edited
    // track, never a blanket sweep" scoping.

    #[test]
    fn remove_prunes_a_track_left_with_zero_clips() {
        let mut t = Timeline::from_shots(&shots()); // track 0: A, B, C
        t.add_track(TrackKind::Video); // track 1, empty
        t.move_clip(0, 0, 1, 0, false).unwrap(); // A -> track 1; track 0 still has B, C
        assert_eq!(t.tracks.len(), 2, "moving one of three clips off does not prune");
        t.remove(0, 0).unwrap(); // remove B (now index 0 on track 0)
        t.remove(0, 0).unwrap(); // remove C — track 0 now has zero clips
        assert_eq!(t.tracks.len(), 1, "the now-empty track 0 was pruned");
        assert_eq!(t.tracks[0].clips[0].name, "A", "surviving track renumbers to index 0");
    }

    #[test]
    fn remove_does_not_prune_a_track_that_still_has_a_clip_left() {
        let mut t = Timeline::from_shots(&shots()); // 3 clips, one track
        t.remove(0, 0).unwrap(); // drop A, B and C remain
        assert_eq!(t.tracks.len(), 1, "still has 2 clips left — not pruned");
        assert_eq!(t.tracks[0].clips.len(), 2);
    }

    #[test]
    fn remove_never_sweeps_an_unrelated_already_empty_track() {
        let mut t = Timeline::from_shots(&shots());
        t.add_track(TrackKind::Video); // track 1, deliberately empty, untouched by this op
        t.remove(0, 0).unwrap(); // track 0 still has B, C left — not pruned either
        assert_eq!(t.tracks.len(), 2, "the unrelated empty track survives — only the directly-edited track prunes");
    }

    #[test]
    fn move_clip_prunes_the_source_track_when_it_becomes_empty() {
        let mut t = Timeline::from_shots(&shots());
        t.add_track(TrackKind::Video); // track 1
        // Move A, then B, then C off track 0 one at a time — indices shift
        // as clips leave, so always take index 0.
        t.move_clip(0, 0, 1, 0, false).unwrap();
        t.move_clip(0, 0, 1, 200, false).unwrap();
        assert_eq!(t.tracks.len(), 2, "still one clip left on track 0");
        t.move_clip(0, 0, 1, 500, false).unwrap(); // the last one — track 0 is now empty
        assert_eq!(t.tracks.len(), 1, "source track pruned once it lost its last clip");
        assert_eq!(t.tracks[0].clips.len(), 3, "all three landed on the surviving track");
    }

    #[test]
    fn move_clip_same_track_never_prunes() {
        let mut t = Timeline::from_shots(&shots());
        t.move_clip(0, 0, 0, 1000, false).unwrap(); // reposition within the same track
        assert_eq!(t.tracks.len(), 1, "clip count on the track is unchanged by a same-track move");
    }

    // --- opaque top-wins video-track resolution (D-056, Phase B1) -----------

    /// Build a 2-video-track timeline the same way the app would: start from
    /// `from_shots` (real op) then `add_track` + `move_clip` (both real,
    /// tested Phase-A ops) to get a second video track with its own clip,
    /// rather than hand-rolling a `Timeline` struct literal.
    ///
    /// Layout after setup:
    /// - track 0 (top / higher priority): "A" at `[0, 100)` only — clip "C"
    ///   (originally at `[150, 350)`) is moved off to make room for the gap
    ///   cases below, so track 0 is `[0,100)` clip, then a gap to infinity.
    /// - track 1 (bottom / lower priority): "B" at `[0, 50)`, "C" at
    ///   `[100, 300)` — chosen so track 1 has content both where track 0 has
    ///   a clip (`[0,50)`, fully shadowed) and where track 0 has a gap
    ///   (`[100,300)`, shows through).
    fn two_video_track_timeline() -> Timeline {
        let mut t = Timeline::from_shots(&shots()); // track 0: A[0,100) B[100,150) C[150,350)
        t.add_track(TrackKind::Video); // track 1, empty
        t.move_clip(0, 1, 1, 0, false).unwrap(); // B: track0 -> track1 @ [0,50)
        t.move_clip(0, 1, 1, 100, false).unwrap(); // C: track0 -> track1 @ [100,300)
        t
    }

    #[test]
    fn resolve_video_clip_at_top_track_wins_when_both_have_content() {
        let t = two_video_track_timeline();
        // frame 10: track 0 has A [0,100), track 1 has B [0,50) — top wins.
        let (track_idx, clip, source_frame) = t.resolve_video_clip_at(10).unwrap();
        assert_eq!(track_idx, 0);
        assert_eq!(clip.name, "A");
        assert_eq!(source_frame, 10);
    }

    #[test]
    fn resolve_video_clip_at_only_top_has_content() {
        let t = two_video_track_timeline();
        // frame 60: track 0 still has A [0,100); track 1's B ended at 50, C
        // doesn't start until 100 — track 1 has a gap too, but it doesn't
        // matter, track 0 alone already resolves it.
        let (track_idx, clip, _) = t.resolve_video_clip_at(60).unwrap();
        assert_eq!(track_idx, 0);
        assert_eq!(clip.name, "A");
    }

    #[test]
    fn resolve_video_clip_at_only_bottom_has_content() {
        let t = two_video_track_timeline();
        // frame 150: track 0's A ended at 100 (nothing after — no clip was
        // left there), track 1 has C [100,300) — bottom shows through.
        let (track_idx, clip, source_frame) = t.resolve_video_clip_at(150).unwrap();
        assert_eq!(track_idx, 1);
        assert_eq!(clip.name, "C");
        assert_eq!(source_frame, 50, "150 - C's start_frame (100)");
    }

    #[test]
    fn resolve_video_clip_at_top_gap_falls_through_to_bottom() {
        let t = two_video_track_timeline();
        // frame 100: track 0 has nothing (A ended at 100, exclusive), track 1
        // has C starting exactly at 100 — this is the literal gap-fallthrough
        // case: a higher-priority track's gap yields to the track below it.
        let (track_idx, clip, source_frame) = t.resolve_video_clip_at(100).unwrap();
        assert_eq!(track_idx, 1);
        assert_eq!(clip.name, "C");
        assert_eq!(source_frame, 0);
    }

    #[test]
    fn resolve_video_clip_at_neither_track_has_content() {
        let t = two_video_track_timeline();
        // frame 400 is past everything on both tracks (A ends at 100, C ends
        // at 300) — a real dead zone, not just a gap on one side.
        assert!(t.resolve_video_clip_at(400).is_none());
        // and a negative position is never resolvable on any track.
        assert!(t.resolve_video_clip_at(-1).is_none());
    }

    /// D-080 (Phase B2 confirmation, `docs/notes/multi-track-nle.md`):
    /// `resolve_video_clip_at`'s walk was claimed to already generalize past
    /// two tracks (a plain filtered iteration, nothing hardcoded to "top or
    /// bottom") but nothing had actually exercised three-plus video tracks
    /// until this test. Three disjoint single-clip tracks: track 0 covers
    /// only `[0,50)`, track 1 only `[0,30)`, track 2 `[0,200)` — a query
    /// frame past BOTH track 0 and track 1's content can only resolve
    /// correctly if the walk keeps going past track 1's own gap too, not
    /// just falls through once.
    fn three_video_track_timeline() -> Timeline {
        let mut t = Timeline::from_shots(&shots()); // track 0: A[0,100) B[100,150) C[150,350)
        t.add_track(TrackKind::Video); // track 1, empty
        t.add_track(TrackKind::Video); // track 2, empty
        // Shrink track 0 to a short clip so it genuinely runs out early.
        t.trim_end(0, 0, -50).unwrap(); // A: 100 -> 50 frames, now [0,50)
        t.move_clip(0, 1, 1, 0, false).unwrap(); // B -> track 1 @ [0,50), then trimmed below
        t.trim_end(1, 0, -20).unwrap(); // track 1's clip: 50 -> 30 frames, now [0,30)
        t.move_clip(0, 1, 2, 0, false).unwrap(); // C -> track 2 @ [0, its own length)
        t
    }

    #[test]
    fn resolve_video_clip_at_three_tracks_top_wins_when_all_have_content() {
        let t = three_video_track_timeline();
        // frame 10: all three tracks have content — index 0 (highest
        // priority) wins, same rule as the two-track case, just confirmed
        // with a third track also present and also matching.
        let (track_idx, clip, _) = t.resolve_video_clip_at(10).unwrap();
        assert_eq!(track_idx, 0);
        assert_eq!(clip.name, "A");
    }

    #[test]
    fn resolve_video_clip_at_three_tracks_falls_through_two_gaps_to_the_third() {
        let t = three_video_track_timeline();
        // frame 100: track 0's clip ended at 50, track 1's ended at 30 —
        // both genuinely exhausted, not just lower priority. Only track 2
        // (index 2, third in line) has anything here. A walk that only
        // checked "top, then one fallback" would incorrectly return None.
        let (track_idx, clip, source_frame) = t.resolve_video_clip_at(100).unwrap();
        assert_eq!(track_idx, 2);
        assert_eq!(clip.name, "C");
        assert_eq!(source_frame, 100);
    }

    #[test]
    fn resolve_video_clip_at_no_video_tracks_is_none() {
        let t = Timeline::default();
        assert!(t.resolve_video_clip_at(0).is_none());
    }

    /// A single-video-track timeline (today's only real shape, D-054's
    /// baseline) behaves exactly as `Track::clip_at` alone always did —
    /// resolution through the new multi-track path is a strict superset,
    /// not a behavior change, for the case every existing project is in.
    #[test]
    fn resolve_video_clip_at_matches_single_track_behavior() {
        let t = Timeline::from_shots(&shots());
        for pos in [0i64, 99, 100, 149, 150, 349, 350, -1] {
            let via_track = t.tracks[0].clip_at(pos).map(|(c, sf)| (c.name.clone(), sf));
            let via_resolve = t
                .resolve_video_clip_at(pos)
                .map(|(idx, c, sf)| (idx, c.name.clone(), sf));
            match via_track {
                Some((name, sf)) => assert_eq!(via_resolve, Some((0, name, sf))),
                None => assert_eq!(via_resolve, None),
            }
        }
    }

    // --- per-track gain (D-057, Phase C) -------------------------------------

    /// A track built before D-057 (`project.json` on disk with no `gain` key
    /// at all — the shape of every real project saved to date) must load at
    /// unity gain, not `0.0` — a real `#[serde(default)]` would silently mute
    /// every existing project's audio the first time it's opened after this
    /// change.
    #[test]
    fn legacy_track_json_without_gain_defaults_to_unity() {
        let j = r#"{"name":"x","tracks":[{"kind":"video","clips":[]}]}"#;
        let t: Timeline = serde_json::from_str(j).unwrap();
        assert_eq!(t.tracks[0].gain, 1.0);
    }

    #[test]
    fn track_gain_round_trips_through_serde() {
        let mut t = Timeline::from_shots(&shots());
        t.tracks[0].gain = 0.5;
        let json = serde_json::to_string(&t).unwrap();
        let back: Timeline = serde_json::from_str(&json).unwrap();
        assert_eq!(back.tracks[0].gain, 0.5);
    }

    // --- Clip::media_id (unify-clip-model doc) -------------------------------

    /// A clip built directly (not through `from_shots`) can set `media_id`
    /// and get it back unchanged — the "settable/gettable via whatever op
    /// creates a clip" requirement.
    #[test]
    fn clip_media_id_is_settable_and_gettable() {
        let clip = Clip {
            id: "c1".into(),
            media_id: Some("m1".into()),
            name: "A".into(),
            source_path: "/a.mov".into(),
            duration: 10,
            source_len: 10,
            start_frame: 0,
            ..Default::default()
        };
        assert_eq!(clip.media_id.as_deref(), Some("m1"));
    }

    /// `media_id` round-trips through serde (present -> present, `None` ->
    /// omitted from the wire rather than serialized as `null`, matching
    /// `shot_id`'s existing `skip_serializing_if` convention).
    #[test]
    fn clip_media_id_round_trips_through_serde() {
        let with_media = Clip {
            id: "c1".into(),
            media_id: Some("m1".into()),
            name: "A".into(),
            source_path: "/a.mov".into(),
            duration: 10,
            source_len: 10,
            start_frame: 0,
            ..Default::default()
        };
        let json = serde_json::to_string(&with_media).unwrap();
        assert!(json.contains("\"media_id\":\"m1\""), "{json}");
        let back: Clip = serde_json::from_str(&json).unwrap();
        assert_eq!(back.media_id.as_deref(), Some("m1"));

        let without_media = Clip {
            media_id: None,
            ..with_media
        };
        let json2 = serde_json::to_string(&without_media).unwrap();
        assert!(
            !json2.contains("media_id"),
            "None omits the key entirely (skip_serializing_if): {json2}"
        );
    }

    /// Legacy JSON (every pre-unify-clip-model `project.json` clip, and every
    /// clip `Timeline::from_shots` builds) has no `media_id` key at all —
    /// must deserialize to `None`, not error, and no migration is needed.
    #[test]
    fn clip_media_id_defaults_to_none_on_legacy_json() {
        let j = r#"{"id":"c1","name":"old","source_path":"/o.mov","source_start":0,"duration":40,"start_frame":0}"#;
        let c: Clip = serde_json::from_str(j).unwrap();
        assert_eq!(c.media_id, None);
    }

    /// `Timeline::from_shots` (the legacy shots -> timeline builder) never
    /// sets `media_id` — it predates the pool-item link and only knows the
    /// shot id (see `shot_id`); `chroma::project`'s grade migration falls
    /// back to `shot_id`/`source_path` matching for these clips.
    #[test]
    fn from_shots_leaves_media_id_unset() {
        let t = Timeline::from_shots(&shots());
        assert!(t.tracks[0].clips.iter().all(|c| c.media_id.is_none()));
    }

    /// `split` clones the left clip's `media_id` onto the right half — a
    /// trim never changes which pool item a clip references.
    #[test]
    fn split_preserves_media_id() {
        let mut t = Timeline::from_shots(&shots());
        t.tracks[0].clips[1].media_id = Some("m-b".into());
        t.split(0, 1, 120).unwrap();
        assert_eq!(t.tracks[0].clips[1].media_id.as_deref(), Some("m-b"));
        assert_eq!(t.tracks[0].clips[2].media_id.as_deref(), Some("m-b"));
    }

    // -----------------------------------------------------------------
    // D-082 (Phase B3): Clip transform defaults, track lock/hide,
    // move_track, resolve_visible_video_layers_at.
    // -----------------------------------------------------------------

    /// The whole reason `Clip` moved off `#[derive(Default)]` to a manual
    /// `impl Default` — confirms `opacity`/`scale` land on `1.0`, not the
    /// derive's `0.0`, for a freshly-built `Clip::default()` (not just a
    /// deserialized one, which `serde(default = ...)` already covered).
    #[test]
    fn clip_default_is_fully_opaque_and_unscaled() {
        let c = Clip::default();
        assert_eq!(c.opacity, 1.0);
        assert_eq!(c.scale, 1.0);
        assert_eq!(c.position_x, 0.0);
        assert_eq!(c.position_y, 0.0);
        assert_eq!(c.rotation, 0.0);
        assert!(c.chroma_keyframes.is_none());
    }

    /// A `from_shots` clip (the common "just probed some media" path) also
    /// gets real defaults, not the zeroed ones — `from_shots` builds `Clip`
    /// via `..Default::default()` for exactly these fields.
    #[test]
    fn from_shots_clips_are_fully_opaque() {
        let t = Timeline::from_shots(&shots());
        assert!(t.tracks[0].clips.iter().all(|c| c.opacity == 1.0 && c.scale == 1.0));
    }

    #[test]
    fn track_json_without_locked_or_hidden_defaults_to_both_false() {
        let json = r#"{"kind":"video","clips":[]}"#;
        let t: Track = serde_json::from_str(json).unwrap();
        assert!(!t.locked);
        assert!(!t.hidden);
    }

    #[test]
    fn clip_json_without_transform_fields_defaults_correctly() {
        let json = r#"{"id":"a","name":"A","source_path":"/a.mov","source_start":0,"duration":10,"source_len":10,"start_frame":0}"#;
        let c: Clip = serde_json::from_str(json).unwrap();
        assert_eq!(c.opacity, 1.0);
        assert_eq!(c.scale, 1.0);
        assert_eq!(c.position_x, 0.0);
        assert_eq!(c.rotation, 0.0);
    }

    // -----------------------------------------------------------------
    // D-132: per-clip crop (four normalised source-space edge insets).
    // -----------------------------------------------------------------

    /// The migration case, and the whole reason these are a bare
    /// `#[serde(default)]` rather than `opacity`/`scale`'s named-default
    /// treatment: a pre-D-132 `project.json` clip has none of the four keys
    /// and must load **uncropped**, so every existing project renders
    /// exactly as it did before this field existed.
    #[test]
    fn clip_json_without_crop_fields_loads_uncropped() {
        let json = r#"{"id":"a","name":"A","source_path":"/a.mov","source_start":0,"duration":10,"source_len":10,"start_frame":0,"opacity":1.0,"position_x":0.0,"position_y":0.0,"scale":1.0,"rotation":0.0}"#;
        let c: Clip = serde_json::from_str(json).unwrap();
        assert_eq!((c.crop_left, c.crop_top, c.crop_right, c.crop_bottom), (0.0, 0.0, 0.0, 0.0));
    }

    /// `Clip::default()` (the `..Default::default()` every construction site
    /// in this crate uses) is uncropped too — the same "a manual `Default`
    /// impl must be checked separately from serde's" point
    /// `clip_default_is_fully_opaque_and_unscaled` makes for `opacity`/
    /// `scale`, which is exactly how those two were nearly shipped wrong.
    #[test]
    fn clip_default_is_uncropped() {
        let c = Clip::default();
        assert_eq!((c.crop_left, c.crop_top, c.crop_right, c.crop_bottom), (0.0, 0.0, 0.0, 0.0));
        assert!(Timeline::from_shots(&shots()).tracks[0]
            .clips
            .iter()
            .all(|c| c.crop_left == 0.0 && c.crop_bottom == 0.0));
    }

    /// A real crop survives a full `Timeline` → JSON → `Timeline` round trip
    /// with its four values intact — this is what `chroma_timeline_set`
    /// (verbatim storage) then `chroma_timeline_get` actually does to every
    /// edit the Inspector makes.
    #[test]
    fn crop_round_trips_through_a_whole_timeline() {
        let mut t = Timeline::from_shots(&shots());
        t.tracks[0].clips[0].crop_left = 0.25;
        t.tracks[0].clips[0].crop_top = 0.1;
        t.tracks[0].clips[0].crop_right = 0.5;
        t.tracks[0].clips[0].crop_bottom = 0.0;
        let json = serde_json::to_string(&t).unwrap();
        let back: Timeline = serde_json::from_str(&json).unwrap();
        let c = &back.tracks[0].clips[0];
        assert_eq!((c.crop_left, c.crop_top, c.crop_right, c.crop_bottom), (0.25, 0.1, 0.5, 0.0));
        // and the untouched clip beside it is still uncropped
        assert!(back.tracks[0].clips[1].crop_left == 0.0);
    }

    /// Crop is a per-clip *appearance* value, not a timing one: a `split`
    /// hands both halves the same crop, the same way `media_id` and every
    /// other non-positional field already propagate. Guards against a future
    /// op that rebuilds a `Clip` field-by-field and quietly drops the crop.
    #[test]
    fn split_preserves_crop_on_both_halves() {
        let mut t = Timeline::from_shots(&shots());
        t.tracks[0].clips[1].crop_left = 0.3;
        t.tracks[0].clips[1].crop_bottom = 0.2;
        t.split(0, 1, 120).unwrap();
        for i in [1usize, 2] {
            assert_eq!(t.tracks[0].clips[i].crop_left, 0.3);
            assert_eq!(t.tracks[0].clips[i].crop_bottom, 0.2);
        }
    }

    #[test]
    fn move_track_reorders_the_track_list() {
        let mut t = two_video_track_timeline();
        let track0_kind_before = t.tracks[0].clips[0].name.clone(); // "A"
        t.move_track(0, 1).unwrap();
        // track that was at index 1 (its first clip named "B") is now at 0
        assert_eq!(t.tracks[0].clips[0].name, "B");
        assert_eq!(t.tracks[1].clips[0].name, track0_kind_before); // "A", now at 1
    }

    #[test]
    fn move_track_out_of_range_is_an_error() {
        let mut t = two_video_track_timeline();
        assert_eq!(t.move_track(5, 0), Err(TimelineError::NoSuchTrack(5)));
        assert_eq!(t.move_track(0, 5), Err(TimelineError::NoSuchTrack(5)));
    }

    #[test]
    fn move_track_same_index_is_a_real_no_op() {
        let mut t = two_video_track_timeline();
        assert_eq!(t.move_track(0, 0), Ok(()));
    }

    #[test]
    fn resolve_visible_video_layers_at_returns_every_track_with_content_not_just_the_top() {
        let t = two_video_track_timeline(); // track0: A[0,100); track1: B[0,50) C[100,300)
        // frame 10: both tracks have content.
        let layers = t.resolve_visible_video_layers_at(10);
        assert_eq!(layers.len(), 2);
        assert_eq!(layers[0].0, 0);
        assert_eq!(layers[0].1.name, "A");
        assert_eq!(layers[1].0, 1);
        assert_eq!(layers[1].1.name, "B");
    }

    #[test]
    fn resolve_visible_video_layers_at_omits_a_track_with_a_gap_there() {
        let t = two_video_track_timeline();
        // frame 60: track0 has A still; track1's B ended at 50, C starts at 100 — a gap.
        let layers = t.resolve_visible_video_layers_at(60);
        assert_eq!(layers.len(), 1);
        assert_eq!(layers[0].0, 0);
    }

    #[test]
    fn resolve_visible_video_layers_at_excludes_a_hidden_track_even_with_content() {
        let mut t = two_video_track_timeline();
        t.tracks[1].hidden = true;
        let layers = t.resolve_visible_video_layers_at(10);
        assert_eq!(layers.len(), 1);
        assert_eq!(layers[0].0, 0);
    }

    #[test]
    fn resolve_visible_video_layers_at_three_tracks_returns_all_that_overlap() {
        let t = three_video_track_timeline(); // track0[0,50) track1[0,30) track2[0,200+)
        let layers = t.resolve_visible_video_layers_at(10);
        assert_eq!(layers.len(), 3);
        assert_eq!(layers.iter().map(|(i, ..)| *i).collect::<Vec<_>>(), vec![0, 1, 2]);
    }

    fn locked_two_track_timeline() -> Timeline {
        let mut t = two_video_track_timeline();
        t.tracks[0].locked = true;
        t
    }

    #[test]
    fn trim_start_refuses_on_a_locked_track() {
        let mut t = locked_two_track_timeline();
        assert_eq!(t.trim_start(0, 0, 5), Err(TimelineError::TrackLocked(0)));
    }

    #[test]
    fn trim_end_refuses_on_a_locked_track() {
        let mut t = locked_two_track_timeline();
        assert_eq!(t.trim_end(0, 0, -5), Err(TimelineError::TrackLocked(0)));
    }

    #[test]
    fn split_refuses_on_a_locked_track() {
        let mut t = locked_two_track_timeline();
        assert_eq!(t.split(0, 0, 50), Err(TimelineError::TrackLocked(0)));
    }

    #[test]
    fn remove_refuses_on_a_locked_track() {
        let mut t = locked_two_track_timeline();
        assert_eq!(t.remove(0, 0), Err(TimelineError::TrackLocked(0)));
    }

    #[test]
    fn reorder_refuses_on_a_locked_track() {
        let mut t = locked_two_track_timeline();
        assert_eq!(t.reorder(0, 0, 0), Err(TimelineError::TrackLocked(0)));
    }

    #[test]
    fn move_clip_refuses_when_the_source_track_is_locked() {
        let mut t = locked_two_track_timeline();
        assert_eq!(t.move_clip(0, 0, 1, 200, false), Err(TimelineError::TrackLocked(0)));
    }

    #[test]
    fn move_clip_refuses_when_the_destination_track_is_locked() {
        let mut t = two_video_track_timeline();
        t.tracks[1].locked = true;
        assert_eq!(t.move_clip(0, 0, 1, 200, false), Err(TimelineError::TrackLocked(1)));
    }

    /// A locked track's clips can't be edited, but the track LIST itself —
    /// add/remove/reorder-of-tracks — is a different concern, not gated by
    /// per-track lock (see `TrackLocked`'s own doc for the reasoning).
    #[test]
    fn locking_a_track_does_not_block_track_list_ops() {
        let mut t = locked_two_track_timeline();
        assert!(t.move_track(0, 1).is_ok());
        assert_eq!(t.add_track(TrackKind::Audio), 2);
        assert!(t.remove_track(2).is_ok());
    }

    // -------------------------------------------------------------------- //
    // cross-track ripple sync (D-106)
    // -------------------------------------------------------------------- //

    fn two_track(track0: Vec<Clip>, track1: Vec<Clip>) -> Timeline {
        let mk = |clips: Vec<Clip>| Track {
            kind: TrackKind::Video,
            clips,
            gain: default_track_gain(),
            locked: false,
            hidden: false,
            sync_locked: default_sync_locked(),
        };
        Timeline {
            id: "t".into(),
            name: "t".into(),
            rate: None,
            tracks: vec![mk(track0), mk(track1)],
        }
    }

    fn c(id: &str, start: i64, dur: i64) -> Clip {
        Clip {
            id: id.into(),
            name: id.into(),
            source_path: format!("/{id}.mov"),
            duration: dur,
            source_len: 10_000,
            start_frame: start,
            ..Default::default()
        }
    }

    #[test]
    fn sync_locked_defaults_true_on_a_pre_d106_track() {
        let j = r#"{"kind":"video","clips":[]}"#;
        let t: Track = serde_json::from_str(j).unwrap();
        assert!(t.sync_locked, "a track with no sync_locked key defaults ON, matching Resolve/Palmier");
    }

    /// A move ripple on track 0 shifts an unrelated clip on sync-locked
    /// track 1 by the same amount — the headline behavior this whole
    /// feature is for.
    #[test]
    fn move_clip_ripple_propagates_to_a_sync_locked_track() {
        // track0: A[0,50) B[50,100) — moving a new clip in at 50 with ripple
        // pushes B to [50+30, 100+30). track1: X[0,200) — clear of the
        // shift point, unaffected in position, only shifted if >= threshold.
        let mut t = two_track(vec![c("a", 0, 50), c("b", 50, 50)], vec![c("x", 200, 50)]);
        // Move a same-track clip (b) is awkward to use as the ripple driver
        // here (it IS the clip moving) — use a fresh clip via a helper move
        // from a third track instead: simplest is to ripple-insert via
        // move_clip itself, landing at frame 50 with ripple=true, moving a
        // clip that starts past everything (append target) into that slot.
        // Simpler: directly assert via remove_gap instead, which has a
        // cleaner "ripple driven by track 0 alone" shape — see the dedicated
        // remove_gap tests below for the primary coverage of the propagation
        // path; this test specifically exercises move_clip's own call site.
        t.tracks[0].clips.push(c("new", 300, 30)); // parked clip to move
        t.move_clip(0, 2, 0, 50, true).unwrap(); // land at 50, ripple b and x
        let track0_b = t.tracks[0].clips.iter().find(|c| c.id == "b").unwrap();
        assert_eq!(track0_b.start_frame, 80, "b shifted by the new clip's own 30-frame duration");
        let track1_x = t.tracks[1].clips.iter().find(|c| c.id == "x").unwrap();
        assert_eq!(track1_x.start_frame, 230, "sync-locked track 1's clip shifted by the same 30 frames");
    }

    #[test]
    fn move_clip_ripple_skips_a_track_with_sync_locked_false() {
        // `b` at [50,100) is required so the move genuinely overlaps and
        // ripples on track 0 itself — without it (a single, non-overlapping
        // `a`) this test would pass vacuously (nothing ripples anywhere,
        // track 1 "untouched" for the wrong reason). Asserting `b` DID shift
        // proves track 1's exclusion below is real.
        let mut t = two_track(vec![c("a", 0, 50), c("b", 50, 50)], vec![c("x", 200, 50)]);
        t.tracks[1].sync_locked = false;
        t.tracks[0].clips.push(c("new", 300, 30));
        t.move_clip(0, 2, 0, 50, true).unwrap();
        let track0_b = t.tracks[0].clips.iter().find(|c| c.id == "b").unwrap();
        assert_eq!(track0_b.start_frame, 80, "ripple genuinely fired on track 0");
        let track1_x = t.tracks[1].clips.iter().find(|c| c.id == "x").unwrap();
        assert_eq!(track1_x.start_frame, 200, "sync_locked: false — untouched by the other track's ripple");
    }

    #[test]
    fn move_clip_ripple_skips_a_locked_track_even_if_sync_locked() {
        let mut t = two_track(vec![c("a", 0, 50), c("b", 50, 50)], vec![c("x", 200, 50)]);
        t.tracks[1].locked = true; // sync_locked stays true (the default)
        t.tracks[0].clips.push(c("new", 300, 30));
        t.move_clip(0, 2, 0, 50, true).unwrap();
        let track0_b = t.tracks[0].clips.iter().find(|c| c.id == "b").unwrap();
        assert_eq!(track0_b.start_frame, 80, "ripple genuinely fired on track 0");
        let track1_x = t.tracks[1].clips.iter().find(|c| c.id == "x").unwrap();
        assert_eq!(track1_x.start_frame, 200, "locked overrides sync_locked — protected from a foreign ripple too");
    }

    /// B-033 — REVERTED from auto-split to reject-on-straddle. Auto-split
    /// let a repeated ripple keep re-splitting an already-split fragment,
    /// confirmed to corrupt a real project (the owner's `New.chroma`: the
    /// same clip split into a chain of ever-smaller slivers, and the same
    /// clip id appearing three times on one track). Now generalizes D-104's
    /// own same-track reject-on-straddle contract to sync-locked tracks.
    #[test]
    fn remove_gap_rejects_a_straddling_clip_on_a_synced_track() {
        // track0: A[0,50) gap[50,80) B[80,130) — closing the gap would shift
        // everything at/after 80 earlier by 30. track1: a single long clip
        // X[20,200) that straddles frame 80 (starts at 20, ends at 200) —
        // the whole op must reject, nothing on either track moves.
        let mut t = two_track(vec![c("a", 0, 50), c("b", 80, 50)], vec![c("x", 20, 180)]);
        let err = t.remove_gap(0, 60).unwrap_err();
        assert!(matches!(err, TimelineError::SyncLockedStraddle(80)));

        let track0_b = t.tracks[0].clips.iter().find(|c| c.id == "b").unwrap();
        assert_eq!(track0_b.start_frame, 80, "rejected: edited track untouched");
        let track1 = &t.tracks[1];
        assert_eq!(track1.clips.len(), 1, "rejected: no split, no fragment, x untouched");
        assert_eq!((track1.clips[0].start_frame, track1.clips[0].duration), (20, 180));
    }

    /// Real regression for B-033: applying the same rejected op repeatedly
    /// must never partially apply or fragment further — every call rejects
    /// identically, since the straddle never goes away when nothing moves.
    #[test]
    fn remove_gap_repeated_calls_on_a_straddle_never_fragment() {
        let mut t = two_track(vec![c("a", 0, 50), c("b", 80, 50)], vec![c("x", 20, 180)]);
        for _ in 0..5 {
            assert!(t.remove_gap(0, 60).is_err());
        }
        assert_eq!(t.tracks[1].clips.len(), 1, "still exactly one clip, no cascade of fragments");
        assert_eq!(t.tracks[1].clips[0].id, "x");
    }

    #[test]
    fn remove_gap_ripple_propagates_without_a_matching_gap_on_the_synced_track() {
        // Real Resolve behavior (D-106, question 3): the OTHER track doesn't
        // need a gap of its own at the same point — a single clip spanning
        // straight through still ripples (via the straddle-split above), and
        // a clip entirely AFTER the ripple point on an otherwise-untouched
        // synced track shifts too, with no gap requirement at all.
        let mut t = two_track(vec![c("a", 0, 50), c("b", 80, 50)], vec![c("y", 90, 20)]);
        t.remove_gap(0, 60).unwrap();
        let track1_y = t.tracks[1].clips.iter().find(|c| c.id == "y").unwrap();
        assert_eq!(track1_y.start_frame, 60, "y (start 90, at/after the gap's own end 80) shifted -30, no gap needed on track 1");
    }

    // -------------------------------------------------------------------- //
    // A/V link groups (D-129, `docs/notes/av-linking.md`)
    // -------------------------------------------------------------------- //

    /// A video track + an audio track holding one linked A/V pair — the exact
    /// shape dropping a clip with embedded audio now produces (D-129):
    /// V1 `[0, 100)` and A1 `[0, 100)`, same source, same `link_group`.
    fn linked_pair() -> Timeline {
        let mk = |kind, clips| Track {
            kind,
            clips,
            gain: default_track_gain(),
            locked: false,
            hidden: false,
            sync_locked: default_sync_locked(),
        };
        let mut v = c("v", 0, 100);
        v.link_group = Some("g1".into());
        v.source_len = 100;
        let mut a = c("a", 0, 100);
        a.link_group = Some("g1".into());
        a.source_path = "/v.mov".into();
        a.source_len = 100;
        Timeline {
            id: "t".into(),
            name: "t".into(),
            rate: None,
            tracks: vec![mk(TrackKind::Video, vec![v]), mk(TrackKind::Audio, vec![a])],
        }
    }

    fn start_of(t: &Timeline, track: usize, id: &str) -> Option<i64> {
        t.tracks[track]
            .clips
            .iter()
            .find(|c| c.id == id)
            .map(|c| c.start_frame)
    }

    /// Real backward-compat evidence, not just a hand-written fixture: parse
    /// the owner's actual `~/Movies/Chroma/New.chroma/project.json` (the same
    /// file `backfill_matches_the_real_project_json_single_clip_shape` was
    /// written against) and assert every clip in every timeline loads with
    /// the defaults a *newly added* field is supposed to give an existing
    /// project. Skipped cleanly when the file isn't there — this crate must
    /// stay runnable on any machine.
    ///
    /// **B-053/D-132 — this test used to assert `link_group == None` on
    /// every clip, and that assertion has expired.** It was true when D-129
    /// shipped (the file predated linking), but its premise was "the owner
    /// has not used the feature yet," which stopped holding the moment they
    /// dropped a clip and got a real linked audio half — the file now
    /// genuinely contains `lg-…` groups and the test failed on `main`, on
    /// correct data, for a correct reason. A test pinned to live user data
    /// can only assert things that stay true as the user works; "the
    /// migration default for a field this file predates" is exactly that
    /// shape of claim, so it now covers D-132's crop insets (which this
    /// file genuinely predates) instead of D-129's link groups (which it no
    /// longer does).
    #[test]
    fn the_owners_real_project_json_loads_with_migration_defaults() {
        let Some(home) = std::env::var_os("HOME") else {
            return;
        };
        let path = std::path::Path::new(&home).join("Movies/Chroma/New.chroma/project.json");
        let Ok(raw) = std::fs::read_to_string(&path) else {
            eprintln!("skip: {} not present on this machine", path.display());
            return;
        };
        let doc: serde_json::Value = serde_json::from_str(&raw).expect("real project.json parses");
        let timelines = doc
            .get("timelines")
            .and_then(|t| t.as_array())
            .expect("the real project has a `timelines` array");
        assert!(!timelines.is_empty(), "the real project has timelines");
        let mut clips_seen = 0usize;
        for value in timelines {
            let mut tl: Timeline =
                serde_json::from_value(value.clone()).expect("a real timeline deserializes");
            tl.backfill_legacy_positions();
            for track in &tl.tracks {
                for clip in &track.clips {
                    clips_seen += 1;
                    assert_eq!(
                        (clip.crop_left, clip.crop_top, clip.crop_right, clip.crop_bottom),
                        (0.0, 0.0, 0.0, 0.0),
                        "every pre-D-132 clip loads uncropped — no picture change for this project"
                    );
                    assert_ne!(
                        clip.start_frame, LEGACY_MISSING_START,
                        "the backfill above resolved every position"
                    );
                }
            }
        }
        assert!(clips_seen > 0, "the real project has at least one clip");
    }

    #[test]
    fn legacy_clip_json_without_link_group_is_unlinked() {
        let j = r#"{"id":"c1","name":"old","source_path":"/o.mov","source_start":0,"duration":40,"start_frame":0}"#;
        let c: Clip = serde_json::from_str(j).unwrap();
        assert_eq!(
            c.link_group, None,
            "every pre-D-129 project.json clip loads unlinked — the whole backward-compat story"
        );
    }

    #[test]
    fn link_group_round_trips_and_none_omits_the_key() {
        let t = linked_pair();
        let json = serde_json::to_string(&t).unwrap();
        assert!(json.contains("\"link_group\":\"g1\""), "{json}");
        let back: Timeline = serde_json::from_str(&json).unwrap();
        assert_eq!(back.tracks[1].clips[0].link_group.as_deref(), Some("g1"));

        let plain = Timeline::from_shots(&shots());
        let json2 = serde_json::to_string(&plain).unwrap();
        assert!(
            !json2.contains("link_group"),
            "None omits the key entirely, matching media_id: {json2}"
        );
    }

    #[test]
    fn link_group_members_finds_every_member_across_tracks() {
        let t = linked_pair();
        assert_eq!(t.link_group_members("g1"), vec![(0, 0), (1, 0)]);
        assert!(t.link_group_members("nope").is_empty());
    }

    // --- track auto-creation for the audio half ------------------------------

    #[test]
    fn audio_track_with_room_finds_a_free_audio_track() {
        let t = linked_pair(); // A1 is occupied over [0,100)
        assert_eq!(t.audio_track_with_room(0, 100), None, "A1 is busy there");
        assert_eq!(
            t.audio_track_with_room(200, 100),
            Some(1),
            "same track, past the existing clip — room"
        );
    }

    #[test]
    fn audio_track_with_room_ignores_video_and_locked_tracks() {
        let mut t = linked_pair();
        assert_eq!(
            t.audio_track_with_room(500, 10),
            Some(1),
            "never track 0 — that's the video track"
        );
        t.tracks[1].locked = true;
        assert_eq!(
            t.audio_track_with_room(500, 10),
            None,
            "a locked track is never offered — every op would refuse it anyway"
        );
    }

    #[test]
    fn ensure_audio_track_with_room_creates_one_when_every_existing_track_is_busy() {
        let mut t = linked_pair();
        let idx = t.ensure_audio_track_with_room(0, 100);
        assert_eq!(idx, 2, "a brand-new audio track, appended via add_track");
        assert_eq!(t.tracks[2].kind, TrackKind::Audio);
        assert!(t.tracks[2].clips.is_empty());
        assert_eq!(t.tracks[2].gain, 1.0, "unity, same as any other new track");
        assert!(
            t.tracks[2].sync_locked,
            "sync-locked by default, same as any other new track"
        );
    }

    #[test]
    fn ensure_audio_track_with_room_reuses_a_free_one_rather_than_piling_up_tracks() {
        let mut t = linked_pair();
        assert_eq!(t.ensure_audio_track_with_room(200, 50), 1);
        assert_eq!(t.tracks.len(), 2, "no new track created — A1 had room");
    }

    // --- move ----------------------------------------------------------------

    #[test]
    fn move_clip_drags_the_linked_audio_half_along() {
        let mut t = linked_pair();
        t.move_clip(0, 0, 0, 300, false).unwrap();
        assert_eq!(start_of(&t, 0, "v"), Some(300));
        assert_eq!(
            start_of(&t, 1, "a"),
            Some(300),
            "the audio half moved by the same delta, staying on its own track"
        );
    }

    #[test]
    fn move_clip_from_the_audio_half_drags_the_video_half_too() {
        // Symmetry: grabbing either half moves the pair — neither is "the"
        // primary, matching both references' linked selection.
        let mut t = linked_pair();
        t.move_clip(1, 0, 1, 250, false).unwrap();
        assert_eq!(start_of(&t, 1, "a"), Some(250));
        assert_eq!(start_of(&t, 0, "v"), Some(250));
    }

    #[test]
    fn move_clip_cross_track_keeps_the_audio_half_on_its_own_track() {
        let mut t = linked_pair();
        t.add_track(TrackKind::Video); // track 2
        t.move_clip(0, 0, 2, 400, false).unwrap();
        // The old V1 was emptied by the move and auto-decommissioned, so the
        // remaining tracks renumber: audio at 0, the new video track at 1.
        assert_eq!(t.tracks.len(), 2, "the emptied V1 was pruned");
        let audio = t
            .tracks
            .iter()
            .find(|tr| tr.kind == TrackKind::Audio)
            .expect("the audio track survives — it still holds the audio half");
        assert_eq!(audio.clips.len(), 1);
        assert_eq!(audio.clips[0].id, "a");
        assert_eq!(
            audio.clips[0].start_frame, 400,
            "the audio half followed in TIME but stayed on an audio track — it does \
             NOT follow the video half onto the video half's new track"
        );
        let video = t
            .tracks
            .iter()
            .find(|tr| tr.kind == TrackKind::Video)
            .expect("the destination video track");
        assert_eq!(video.clips[0].id, "v");
        assert_eq!(video.clips[0].start_frame, 400);
    }

    #[test]
    fn move_clip_rejects_whole_when_the_audio_half_has_nowhere_to_land() {
        let mut t = linked_pair();
        // Park an unrelated audio clip exactly where the pair would land.
        t.tracks[1].clips.push(c("blocker", 300, 100));
        let err = t.move_clip(0, 0, 0, 300, false).unwrap_err();
        assert_eq!(err, TimelineError::LinkDesync("g1".into()));
        assert_eq!(
            start_of(&t, 0, "v"),
            Some(0),
            "rejected whole — nothing moved"
        );
        assert_eq!(start_of(&t, 1, "a"), Some(0));
    }

    #[test]
    fn move_clip_ripple_makes_room_on_both_tracks_for_a_linked_pair() {
        // The everyday NLE gesture: drop a linked pair between two already-
        // touching clips. The video track ripples for the video half, and
        // the sync-locked audio track ripples for the audio half — so the
        // pair lands intact, one delta, no desync.
        let mut t = linked_pair();
        // V1: existing X[0,50) Y[50,50); A1: x[0,50) y[50,50); the pair
        // parked far to the right at 1000.
        t.tracks[0].clips[0].start_frame = 1000;
        t.tracks[1].clips[0].start_frame = 1000;
        t.tracks[0].clips.push(c("X", 0, 50));
        t.tracks[0].clips.push(c("Y", 50, 50));
        t.tracks[1].clips.push(c("x", 0, 50));
        t.tracks[1].clips.push(c("y", 50, 50));

        t.move_clip(0, 0, 0, 50, true).unwrap();
        assert_eq!(
            start_of(&t, 0, "v"),
            Some(50),
            "video half landed at the seam"
        );
        assert_eq!(
            start_of(&t, 1, "a"),
            Some(50),
            "audio half landed at the same frame"
        );
        assert_eq!(
            start_of(&t, 0, "Y"),
            Some(150),
            "video's Y rippled by the pair's 100 frames"
        );
        assert_eq!(
            start_of(&t, 1, "y"),
            Some(150),
            "the sync-locked audio track rippled by the same 100 — room for the audio half"
        );
        assert_eq!(
            start_of(&t, 0, "X"),
            Some(0),
            "before the insert point, untouched"
        );
        assert_eq!(start_of(&t, 1, "x"), Some(0));
    }

    #[test]
    fn move_clip_refuses_when_the_linked_half_sits_on_a_locked_track() {
        let mut t = linked_pair();
        t.tracks[1].locked = true;
        assert_eq!(
            t.move_clip(0, 0, 0, 300, false),
            Err(TimelineError::TrackLocked(1))
        );
        assert_eq!(start_of(&t, 0, "v"), Some(0), "nothing moved");
    }

    #[test]
    fn move_clip_on_an_unlinked_clip_is_unchanged_by_d125() {
        // The whole backward-compat guarantee in one test: a clip with no
        // link_group behaves exactly as it did before this feature.
        let mut t = Timeline::from_shots(&shots());
        t.move_clip(0, 0, 0, 1000, false).unwrap();
        let a = t.tracks[0].clips.iter().find(|c| c.name == "A").unwrap();
        assert_eq!(a.start_frame, 1000);
        assert_eq!(t.tracks[0].clips.len(), 3);
    }

    // --- trim ----------------------------------------------------------------

    #[test]
    fn trim_start_applies_to_both_halves() {
        let mut t = linked_pair();
        t.trim_start(0, 0, 20).unwrap();
        for (ti, id) in [(0, "v"), (1, "a")] {
            let c = t.tracks[ti].clips.iter().find(|c| c.id == id).unwrap();
            assert_eq!(
                (c.source_start, c.start_frame, c.duration),
                (20, 20, 80),
                "{id} half"
            );
        }
    }

    #[test]
    fn trim_end_applies_to_both_halves() {
        let mut t = linked_pair();
        t.trim_end(1, 0, -30).unwrap(); // grab the AUDIO half's tail
        assert_eq!(t.tracks[0].clips[0].duration, 70, "video half followed");
        assert_eq!(t.tracks[1].clips[0].duration, 70);
    }

    #[test]
    fn trim_rejects_whole_when_one_half_would_clamp_differently() {
        // The audio half has a neighbour immediately after it, so a tail
        // EXTEND clamps there while the video half has room — the two would
        // end up different lengths. Reject, don't desync.
        let mut t = linked_pair();
        t.tracks[0].clips[0].source_len = 10_000;
        t.tracks[1].clips[0].source_len = 10_000;
        t.tracks[1].clips.push(c("neighbour", 120, 50));
        let err = t.trim_end(0, 0, 200).unwrap_err();
        assert_eq!(err, TimelineError::LinkDesync("g1".into()));
        assert_eq!(t.tracks[0].clips[0].duration, 100, "rejected whole");
        assert_eq!(t.tracks[1].clips[0].duration, 100);
    }

    #[test]
    fn trim_start_still_clamps_and_errors_exactly_as_before_for_an_unlinked_clip() {
        // The pre-D-129 trim_start test's own assertions, re-run against the
        // refactored (clamp extracted into a free fn) implementation.
        let mut t = Timeline::from_shots(&shots());
        t.trim_start(0, 0, 20).unwrap();
        let c = &t.tracks[0].clips[0];
        assert_eq!((c.source_start, c.start_frame, c.duration), (20, 20, 80));
        t.trim_start(0, 0, -100).unwrap();
        let c = &t.tracks[0].clips[0];
        assert_eq!((c.source_start, c.start_frame, c.duration), (0, 0, 100));
        t.trim_end(0, 1, -40).unwrap();
        assert_eq!(t.trim_start(0, 1, 10), Err(TimelineError::EmptyClip));
    }

    // --- split ---------------------------------------------------------------

    #[test]
    fn split_cuts_both_halves_and_leaves_two_intact_pairs() {
        let mut t = linked_pair();
        t.split(0, 0, 40).unwrap();
        assert_eq!(t.tracks[0].clips.len(), 2, "video half cut");
        assert_eq!(
            t.tracks[1].clips.len(),
            2,
            "audio half cut at the same frame"
        );

        let v_left = &t.tracks[0].clips[0];
        let v_right = &t.tracks[0].clips[1];
        let a_left = &t.tracks[1].clips[0];
        let a_right = &t.tracks[1].clips[1];
        assert_eq!((v_left.start_frame, v_left.duration), (0, 40));
        assert_eq!((v_right.start_frame, v_right.duration), (40, 60));
        assert_eq!((a_left.start_frame, a_left.duration), (0, 40));
        assert_eq!((a_right.start_frame, a_right.duration), (40, 60));

        assert_eq!(v_left.link_group.as_deref(), Some("g1"));
        assert_eq!(a_left.link_group.as_deref(), Some("g1"));
        assert_eq!(v_right.link_group.as_deref(), Some("g1·40"));
        assert_eq!(
            a_right.link_group.as_deref(),
            Some("g1·40"),
            "the two right halves are their own intact pair, not still in the left pair's group"
        );
        assert_eq!(t.link_group_members("g1"), vec![(0, 0), (1, 0)]);
        assert_eq!(t.link_group_members("g1·40"), vec![(0, 1), (1, 1)]);
    }

    #[test]
    fn split_rejects_whole_when_the_frame_is_not_inside_every_member() {
        let mut t = linked_pair();
        // Slip the audio half right so frame 40 is no longer inside it.
        t.tracks[1].clips[0].start_frame = 60;
        let err = t.split(0, 0, 40).unwrap_err();
        assert_eq!(err, TimelineError::LinkDesync("g1".into()));
        assert_eq!(
            t.tracks[0].clips.len(),
            1,
            "rejected whole — nothing was cut"
        );
        assert_eq!(t.tracks[1].clips.len(), 1);
    }

    // --- remove --------------------------------------------------------------

    #[test]
    fn remove_deletes_every_member_of_the_link_group() {
        let mut t = linked_pair();
        // Keep another clip on each track so neither is pruned away, which
        // would make "did both go?" ambiguous.
        t.tracks[0].clips.push(c("keep_v", 500, 10));
        t.tracks[1].clips.push(c("keep_a", 500, 10));
        t.remove(0, 0).unwrap();
        assert_eq!(t.tracks[0].clips.len(), 1);
        assert_eq!(t.tracks[1].clips.len(), 1, "the audio half went too");
        assert_eq!(t.tracks[0].clips[0].id, "keep_v");
        assert_eq!(t.tracks[1].clips[0].id, "keep_a");
    }

    #[test]
    fn remove_of_a_linked_pair_prunes_every_track_it_empties() {
        let mut t = linked_pair(); // one clip on each of two tracks
        t.remove(1, 0).unwrap(); // grab the audio half
        assert!(
            t.tracks.is_empty(),
            "both tracks were emptied by the one delete, so both auto-decommission"
        );
    }

    #[test]
    fn remove_refuses_when_a_linked_half_is_on_a_locked_track() {
        let mut t = linked_pair();
        t.tracks[1].locked = true;
        assert_eq!(t.remove(0, 0), Err(TimelineError::TrackLocked(1)));
        assert_eq!(t.tracks[0].clips.len(), 1, "nothing deleted");
        assert_eq!(t.tracks[1].clips.len(), 1);
    }

    // --- unlink --------------------------------------------------------------

    #[test]
    fn unlink_dissolves_the_complete_group_not_just_the_named_clip() {
        let mut t = linked_pair();
        t.unlink(0, 0).unwrap();
        assert_eq!(t.tracks[0].clips[0].link_group, None);
        assert_eq!(
            t.tracks[1].clips[0].link_group, None,
            "Palmier's own 'dissolves each member's complete link group' semantics"
        );
        assert!(t.link_group_members("g1").is_empty());
    }

    #[test]
    fn unlink_then_edit_moves_only_the_clip_you_grabbed() {
        let mut t = linked_pair();
        t.unlink(0, 0).unwrap();
        t.move_clip(0, 0, 0, 400, false).unwrap();
        assert_eq!(start_of(&t, 0, "v"), Some(400));
        assert_eq!(
            start_of(&t, 1, "a"),
            Some(0),
            "the L-cut workflow: unlink, then slip one half independently"
        );
    }

    #[test]
    fn unlink_on_an_already_unlinked_clip_is_a_no_op() {
        let mut t = Timeline::from_shots(&shots());
        assert_eq!(t.unlink(0, 0), Ok(()));
        assert_eq!(t.tracks[0].clips[0].link_group, None);
    }

    #[test]
    fn unlink_rejects_out_of_range_and_a_locked_track() {
        let mut t = linked_pair();
        assert_eq!(t.unlink(9, 0), Err(TimelineError::NoSuchTrack(9)));
        assert_eq!(t.unlink(0, 9), Err(TimelineError::NoSuchClip(9, 0)));
        t.tracks[0].locked = true;
        assert_eq!(t.unlink(0, 0), Err(TimelineError::TrackLocked(0)));
    }
}

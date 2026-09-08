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
//! **Text / title clips (D-211, `docs/notes/text-title-clips.md`):**
//! [`Clip::text`] — `Some(TextLayer)` makes a clip a **generated** layer whose
//! picture is rasterised text rather than decoded from `source_path` (which
//! stays empty on such a clip). It is a `Clip` *variant*, not a new
//! [`TrackKind`]: a title in Resolve/Premiere is a generator clip placed on
//! an ordinary video track above the picture ("drag it into the timeline
//! above your video tracks" — Blackmagic's own Edit-page copy), and this
//! crate's existing track-index z-order
//! ([`Timeline::resolve_visible_video_layers_at`]) already IS that ordering
//! — see D-211 for the full comparison of the two shapes. Every other field
//! on `Clip` (`start_frame`, `duration`, the transform, `chroma_keyframes`,
//! the fades) keeps its exact meaning; the consumers that render pixels
//! (`chroma::edit`'s compositor, `@chroma/editor`'s ffmpeg export compiler)
//! are what actually rasterise it, this crate only carries the values — the
//! same division of labour every other compositing field here already has.
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

//! **Transitions (D-226, roadmap item 27, `docs/notes/transitions.md`):**
//! [`Track::transitions`] — a [`Transition`] per edit point, naming the cut it
//! straddles ([`Transition::at_frame`]), a shape ([`TransitionKind`]), a
//! duration and an alignment. **The clips it joins stay abutting and
//! non-overlapping**: this crate's "one clip per track per frame" invariant
//! (`Track::clip_at`'s single-winner `find`, and every op that refuses an
//! overlap — D-104) is completely unchanged, which is the whole point of
//! D-226's choice. What a transition costs instead is **handle media** — for
//! its own duration one of the two clips is shown at a position outside its own
//! trimmed window ([`Clip::source_frame_at`] / [`Clip::clamped_source_frame_at`]).
//!
//! [`Timeline::resolve_visible_video_layers_at`] is where that surfaces: it now
//! returns [`VisibleLayer`]s rather than bare tuples, because a track can
//! contribute two of them (a cross dissolve's two clips) or a generated colour
//! plate with no clip at all (a dip to colour). This crate still renders
//! nothing — it carries the values and resolves *which* layers, at what alpha,
//! from what source frame; `chroma::edit`'s compositor (`app/src-tauri`) and
//! `@chroma/editor`'s ffmpeg compiler are the two consumers that turn that into
//! pixels, exactly the division of labour every other compositing field here
//! already has.
//!
//! **Timeline markers (D-222, roadmap item 27):** [`Timeline::markers`] — a
//! flat list of [`Marker`]s, each an id + a TIMELINE frame + a colour + an
//! optional name/note. They hang off the *timeline*, not off a [`Clip`],
//! because a marker names a position in the edit and must survive the clip
//! beneath it being trimmed, moved to another track or deleted (see the
//! field's own doc). This crate carries and round-trips them and nothing
//! more: a marker is an annotation, never a render input, so no compositor,
//! mixer or exporter consults one. The edit ops that add/remove/patch them
//! live in `@chroma/editor`'s `timeline.ts` alongside every other op that
//! actually runs (`chroma_timeline_set` stores what the frontend sends
//! verbatim — D-058's own note above).

//! **Subtitles / captions (D-228, roadmap item 27):** [`TrackKind::Subtitle`]
//! — captions get their own track kind, and one caption is an ordinary
//! [`Clip`] on such a track carrying a [`caption::CaptionCue`]. This is the
//! **opposite** call from D-211's text/title clip, deliberately and on
//! evidence: a title really is a generator clip on a video track (both
//! reference NLEs put it there, and this crate's track-index z-order is
//! already exactly right for it), whereas a caption has a *different
//! compositing rule* — it is drawn over the finished picture regardless of
//! which track index it sits at, it never occludes video the way an opaque
//! video clip does, and several subtitle tracks are shown at once (a
//! reference frame with an English and a French track burnt in together is
//! what `scratch/resolve-reference/captioning.jpg` shows). Putting captions
//! in the video z-order would have made "which track index" mean something it
//! must not mean. [`Timeline::resolve_visible_captions_at`] is their own
//! resolver, deliberately separate from
//! [`Timeline::resolve_visible_video_layers_at`]; the style they draw with
//! hangs off the *track* ([`Track::caption_style`]) with a per-cue override,
//! mirroring the reference Inspector's "Track Style" tab and its per-caption
//! "Use Track Style" checkbox. See D-228 for the full comparison, and
//! [`caption`]'s own module doc for the layout spec that makes a **multi-line**
//! cue render identically in the live preview and the export.

use serde::{Deserialize, Serialize};

use chroma_types::Rational;

pub mod caption;
pub mod subtitle_import;

use caption::{CaptionCue, CaptionStyle};

// D-147 — the fade curve math itself lives in `chroma-types` (L0), not here.
// It is pure, unit-agnostic bezier arithmetic with two consumers on two
// different layers: this crate's `Clip::fade_multiplier_at` (L2, video frames,
// for the compositor's opacity) and `chroma_media::audio::FadeEnvelope` (L1,
// output sample-frames, for the mixer's gain). L1 cannot depend on L2 — D-039's
// dependency graph is one-way — so the shared half sits below both. Re-exported
// here because `Clip`'s own fade fields are typed by it, and a caller working
// in the timeline model should not have to know which crate the type came from.
pub use chroma_types::fade::{self, FadeCurve, fade_gain};

// D-224 — same shape, same reason, one layer further: a clip's EQ band type
// and the Audio EQ Cookbook biquad math behind it live in `chroma-types` (L0)
// because the mixer that runs the filters is `chroma_media` (L1) and cannot
// depend on this crate. Re-exported here because `Clip::eq_bands` is typed by
// it. (The ffmpeg exporter consumes the same module's COEFFICIENTS rather than
// naming an ffmpeg filter — see `chroma_types::eq`'s own doc for the
// measurement behind that.)
pub use chroma_types::eq::{self, EqBand, EqBandKind};

/// B-079 — mirrors `@chroma/editor/timeline.ts`'s `DEFAULT_FPS`: the project
/// timebase assumed when [`Timeline::rate`] is unset (or malformed — zero or
/// negative `num`/`den`). Every pre-D-045 timeline, and every `Timeline`
/// built directly (a test, [`Timeline::from_shots`]) with no explicit rate,
/// has silently meant this number on both sides of the app since D-041; the
/// constant just gives the fact a name instead of leaving `24.0` (or `24`)
/// spelled out separately at each of the two implementations.
pub const DEFAULT_FPS: f64 = 24.0;

/// B-079/B-077 — `source_frames` (a quantity in a clip's own **source**
/// frames — `Clip::duration`/`source_start`) converted to **timeline**
/// frames at the project's `fps`, via `source_fps` (falling back to `fps`
/// itself — a 1:1 ratio — when absent or non-positive: the same
/// conservative "don't invent a number" reading `Clip::source_fps`'s own doc
/// already commits to). Exact mirror of `@chroma/editor/timeline.ts`'s
/// `sourceFramesToTimeline` — same formula, same `round()` — so this crate's
/// live playback/preview path and the TS GUI/MCP edit-model path can never
/// resolve a mixed-native-fps clip's real timeline footprint differently.
pub fn source_frames_to_timeline(source_fps: Option<f64>, source_frames: i64, fps: f64) -> i64 {
    let src_fps = source_fps.filter(|f| *f > 0.0).unwrap_or(fps);
    ((source_frames as f64 * fps) / src_fps).round() as i64
}

/// The reverse of [`source_frames_to_timeline`] — how many of a clip's own
/// native **source** frames a span of `timeline_frames` timeline frames
/// corresponds to. Mirrors `@chroma/editor/timeline.ts`'s
/// `timelineFramesToSource`.
pub fn timeline_frames_to_source(source_fps: Option<f64>, timeline_frames: i64, fps: f64) -> i64 {
    let src_fps = source_fps.filter(|f| *f > 0.0).unwrap_or(fps);
    ((timeline_frames as f64 * src_fps) / fps).round() as i64
}

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
    /// **Timeline-anchored annotations (D-222, roadmap item 27).** Colour-coded
    /// flags at a frame position — "client wants a cut here", "sync point",
    /// "VFX shot start" — drawn on their own strip beside the ruler.
    ///
    /// **On the `Timeline`, not on a `Clip`, and that is the whole point.** A
    /// marker names a position in the *edit*, not a moment in some piece of
    /// media: it has to survive the clip underneath it being trimmed, moved to
    /// another track, or deleted outright, which a `Clip`-owned field could not.
    /// Same reasoning that put `gain`/`duck_from` on [`Track`] rather than on
    /// its clips — the owner is whichever level the thing is actually a
    /// property of. (DaVinci Resolve does have per-clip markers as well as
    /// timeline ones; only the timeline kind is in scope here — see D-222.)
    ///
    /// **`#[serde(default)]`, and a bare one is correct here** (unlike
    /// [`Track::gain`]'s `default = "default_track_gain"`): `Vec::default()` is
    /// the empty vec, and "a project saved before markers existed has no
    /// markers" is exactly right — no silent behaviour change, no migration.
    ///
    /// This crate never reads it: a marker is an annotation, not a render
    /// input, so nothing in the compositor, the mixer or the exporter consults
    /// it. It is stored, round-tripped and shown.
    #[serde(default)]
    pub markers: Vec<Marker>,
}

/// One timeline marker (D-222) — see [`Timeline::markers`] for why these hang
/// off the timeline rather than off a clip.
///
/// Deliberately **flat and dumb**: an id, a frame, a colour string, and two
/// optional strings. There is no duration (Resolve's own marker dialog has one,
/// for a range marker; out of scope for this pass — see D-222) and no keyword
/// field. `color` is a plain string rather than an enum so the palette can grow
/// without a schema migration, and so an MCP caller can pass a raw hex; the
/// GUI's own swatch row is `@chroma/editor/timeline.ts`'s `MARKER_COLORS`, the
/// one place the named palette is defined.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Marker {
    /// Stable id — how the `remove_marker`/`set_marker` edit ops name one.
    pub id: String,
    /// TIMELINE frame this marker is pinned to (the same space as
    /// [`Clip::start_frame`], never a clip's own source frames).
    pub frame: i64,
    /// The flag's colour, as a CSS colour string (the GUI writes a `#RRGGBB`
    /// from its own named palette). Not a `--color-*` theme token: this is
    /// document content the user chose and that must mean the same thing in
    /// every theme, not app chrome — see D-222.
    pub color: String,
    /// Short title, shown next to the flag. `None`/absent is a perfectly
    /// ordinary unnamed marker (`skip_serializing_if`, matching
    /// [`Clip::shot_id`]'s own convention for an absent optional).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Longer free-text note, shown only in the marker's own popover.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// One track: a typed, ordered lane of clips.
///
/// [`Default`] is **manual** (see below the struct), for the same reason
/// `Clip`'s is: several fields' meaningful default is not their type's zero
/// value (`gain` is `1.0`, `sync_locked` is `true`), and a `#[derive(Default)]`
/// would hand out a silently-muted, sync-unlocked track. It mirrors the
/// `#[serde(default = …)]` functions field for field, so a `Track` built in
/// code and one deserialized from a project with none of those keys are the
/// same track.
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
    /// **Ducking (D-149): which OTHER track's clips duck this one.** `None`
    /// (the default, and every pre-D-149 project) is no ducking at all — this
    /// track mixes exactly as it did before the field existed.
    ///
    /// On the *track*, not the clip, because ducking is a relationship between
    /// two tracks ("lower the music while the dialogue plays"), not a property
    /// of one clip — the same reasoning that put `gain` here rather than on
    /// `Clip`. The index names the **trigger** track: wherever that track has a
    /// clip, this track is ducked by [`Self::duck_db`].
    ///
    /// This crate never reads it (no media/rendering here — see the module
    /// doc); `chroma_media::audio`'s `DuckEnvelope` is the consumer, built
    /// app-side from [`Self::duck_spans_from`] on the trigger track.
    ///
    /// A self-reference (`duck_from == this track's own index`) and an
    /// out-of-range index are both *ignored* at the point of use rather than
    /// rejected here, the same posture `Clip`'s fade fields take for a nonsense
    /// value — `chroma_timeline_set` stores whatever it is handed, so the
    /// consumer has to degrade safely regardless.
    #[serde(default)]
    pub duck_from: Option<usize>,
    /// **How much to duck, in dB** (D-149) — a signed offset applied while the
    /// trigger track is sounding. `-12.0` is "12 dB down", the usual
    /// dialogue-over-music amount; `0.0` (the default) is unity, i.e. no
    /// change even with a `duck_from` set.
    ///
    /// **dB here, linear in [`Self::gain`], deliberately.** `gain` is a mix
    /// *level* a slider sets and the mixer multiplies by directly — linear is
    /// the natural storage. A duck *amount* is the one audio number editors
    /// genuinely think and speak in decibels ("duck the bed 12 dB"), and it is
    /// set by typing a number rather than dragging a fader, so storing the
    /// number the user actually said avoids a round-trip through a unit nobody
    /// names. The conversion (`10^(db/20)`) happens once, at the point of use in
    /// `chroma_media::audio`, exactly where the linear/dB boundary belongs.
    ///
    /// A bare `#[serde(default)]` is genuinely correct here, unlike `gain`'s
    /// `default = "default_track_gain"`: `f32::default() == 0.0` and **0 dB is
    /// unity**, so a pre-D-149 project loads with no duck rather than a silent
    /// one. Not clamped — a positive value boosts, which is unusual but
    /// well-defined, the same latitude `gain > 1.0` already has.
    #[serde(default)]
    pub duck_db: f32,
    /// **One-pole attack time constant, milliseconds** (D-149) — how fast the
    /// duck engages once the trigger track's clip starts. Default 10 ms: the
    /// duck is already down by the time the first syllable is audible.
    ///
    /// A real DSP time constant, not a "strength" dial: it is the τ in
    /// `y(t) = target + (y₀ - target)·e^(-t/τ)`, i.e. the time to cover 63.2%
    /// of the distance to the new level. Attack and release are the whole feel
    /// of a ducker, which is why they are two real numbers here (and in the MCP
    /// surface) rather than one abstract knob.
    ///
    /// Named-default, not bare `#[serde(default)]`, for `gain`'s exact reason:
    /// `f32::default() == 0.0` is instantaneous, which is a step function, and
    /// a step on a gain envelope is an audible click at every clip boundary.
    #[serde(default = "default_duck_attack_ms")]
    pub duck_attack_ms: f32,
    /// **One-pole release time constant, milliseconds** (D-149) — how fast the
    /// gain comes back once the trigger track's clip ends. Default 300 ms,
    /// deliberately far slower than the attack: a fast release pumps the music
    /// up between words. See [`Self::duck_attack_ms`] for the τ definition and
    /// why this is a named default.
    #[serde(default = "default_duck_release_ms")]
    pub duck_release_ms: f32,
    /// **Transitions at this track's edit points (D-226, roadmap item 27).**
    /// Each [`Transition`] names one cut — the frame where one clip on THIS
    /// track ends and the next begins — plus a shape, a duration and an
    /// alignment. See [`Transition`] for the whole model and D-226 for why a
    /// transition is its own object bridging two still-abutting clips rather
    /// than a real overlap of the two.
    ///
    /// **On `Track`, not on `Clip` and not on `Timeline`.** A transition is a
    /// property of an edit *point*, which is a track-level thing: it belongs to
    /// neither clip alone (deleting either side leaves nothing to blend), and
    /// two different tracks' cuts at the same frame are unrelated events. Same
    /// "the owner is whichever level the thing is actually a property of"
    /// reasoning [`Timeline::markers`] and [`Self::gain`] already record.
    ///
    /// **`#[serde(default)]`, bare, and that is correct** (like
    /// [`Timeline::markers`], unlike [`Self::gain`]): `Vec::default()` is the
    /// empty vec and "a project saved before transitions existed has none" is
    /// exactly right — no migration, no behaviour change.
    #[serde(default)]
    pub transitions: Vec<Transition>,
    /// **The style every caption on this track draws with (D-228).** Only
    /// meaningful on a [`TrackKind::Subtitle`] track; `None` everywhere else,
    /// and `None` on a subtitle track means
    /// [`caption::CaptionStyle::default()`].
    ///
    /// **On the track, because that is where the job wants it.** A whole
    /// imported `.srt` is styled once — pick the font, the size, the colour,
    /// where it sits — not cue by cue; the reference Inspector has a "Track
    /// Style" tab for exactly this, with a per-caption "Use Track Style"
    /// checkbox as the escape hatch, which is [`caption::CaptionCue::style`].
    /// Same "the owner is whichever level the thing is actually a property
    /// of" reasoning as [`Self::transitions`] above.
    ///
    /// An `Option` rather than a materialised default so a project saved
    /// before captions existed round-trips byte-identically, and so
    /// "untouched" stays distinguishable from "explicitly set to the
    /// defaults".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caption_style: Option<CaptionStyle>,
}

/// Which blend a [`Transition`] performs (D-226).
///
/// Deliberately **two shapes in v1**, not a library. They are the two that
/// exercise the two genuinely different mechanisms this feature needed to
/// prove — [`Self::CrossDissolve`] blends TWO real clips at once (the
/// two-clips-visible resolution plus handle media), [`Self::DipToColor`] blends
/// ONE clip against a generated plate (no handles at all, so it is always
/// available). Everything a bigger library would add — wipes, slides, pushes —
/// is another generated matte over the same two mechanisms, which is why more
/// types are additive later rather than a redesign. See D-226.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransitionKind {
    /// The universal one: the incoming clip fades up over the still-opaque
    /// outgoing clip, so the picture is `p·incoming + (1-p)·outgoing` at
    /// progress `p`. Needs **handle media** on both sides (see
    /// [`Transition::head_handle`] / [`Transition::tail_handle`]).
    CrossDissolve,
    /// Dip to a colour (black by default): a full-frame plate of
    /// [`Transition::color`] fades up over the outgoing clip, peaks fully
    /// opaque at the cut, and fades back down over the incoming clip. Needs
    /// **no handle media at all** — each clip only ever shows its own real
    /// frames, the plate does all the work.
    DipToColor,
}

/// Where a [`Transition`]'s own window sits relative to the cut it is applied
/// to (D-226) — Premiere Pro's own three, under its own names ("Center at
/// Cut" / "Start at Cut" / "End at Cut", Adobe's *Align and reposition
/// transitions* help page).
///
/// This is not cosmetic: it decides **which clip has to supply handle media**.
/// A centered dissolve needs half its length of handle from each side; a
/// `StartAtCut` one needs its whole length from the outgoing clip's tail and
/// nothing from the incoming; `EndAtCut` is the mirror. So a cut where only
/// one side has been trimmed still supports a dissolve, in the one alignment
/// that asks for media that actually exists.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransitionAlignment {
    /// Straddles the cut, half on each side. The default, and every reference
    /// NLE's own.
    #[default]
    CenterAtCut,
    /// Begins at the cut and runs entirely into the incoming clip — so only
    /// the OUTGOING clip's tail handle is consumed.
    StartAtCut,
    /// Ends at the cut, running entirely inside the outgoing clip — so only
    /// the INCOMING clip's head handle is consumed.
    EndAtCut,
}

/// One transition at one edit point (D-226, `docs/notes/transitions.md`).
///
/// **The clips it joins stay abutting and non-overlapping.** This object
/// bridges the cut rather than the two clips overlapping in the stored model:
/// [`Self::at_frame`] IS the cut (the outgoing clip's exclusive end and the
/// incoming clip's `start_frame`, the same number), and the transition's own
/// window is derived from that plus [`Self::duration`] and
/// [`Self::alignment`]. Nothing about the timeline's "one clip per track per
/// frame" invariant changes — see D-226 for the two real options that were
/// weighed and why this one composes with this codebase's existing
/// resolution / decode / export machinery while the other fights it.
///
/// **What it costs instead: handle media.** A cross dissolve shows both clips
/// at once for [`Self::duration`] frames, so one of them must supply frames
/// from outside its own trimmed window — the outgoing clip past its out-point
/// ([`Self::tail_handle`]) and/or the incoming clip before its in-point
/// ([`Self::head_handle`]). That is the same trade every real NLE makes, and
/// the reason Premiere warns "Insufficient Media" on a cut with no handles.
/// This crate only carries and derives the numbers; the callers that need real
/// media (`chroma::edit`'s compositor, the ffmpeg export compiler, and
/// `@chroma/editor`'s `checkTransition` precondition) are what verify the
/// source actually has them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Transition {
    /// Stable id — how the `remove_transition` / `set_transition` edit ops name
    /// one.
    pub id: String,
    pub kind: TransitionKind,
    /// The TIMELINE frame of the cut: the outgoing clip's exclusive end and the
    /// incoming clip's [`Clip::start_frame`], which for two abutting clips are
    /// the same number. Not a range — the window is *derived* (see
    /// [`Self::window`]) so that changing the duration or the alignment can
    /// never leave the transition attached to a different cut than the one it
    /// was dropped on.
    pub at_frame: i64,
    /// Length in TIMELINE frames. Always ≥ 1 for a transition that renders; a
    /// stored 0 or negative simply resolves to an empty window and paints
    /// nothing — the "the model stores what the UI wrote, the consumer decides
    /// what it means" rule every other field here follows.
    pub duration: i64,
    #[serde(default)]
    pub alignment: TransitionAlignment,
    /// [`TransitionKind::DipToColor`] only — the plate's colour as `#RRGGBB`
    /// (or `#RGB`). `None`/absent is black, by far the common case ("dip to
    /// black"). A plain string rather than an enum for [`Marker::color`]'s own
    /// reason: it is document content the user chose, an MCP caller may pass a
    /// raw hex, and the palette can grow with no schema migration.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

impl Transition {
    /// The `[start, end)` TIMELINE-frame window this transition actually paints
    /// over, derived from its cut, duration and alignment. Empty (`start ==
    /// end`) for a non-positive duration.
    pub fn window(&self) -> (i64, i64) {
        let d = self.duration.max(0);
        match self.alignment {
            // Integer halving floors, so an odd duration puts the extra frame
            // AFTER the cut. Deterministic and stated rather than left to a
            // rounding accident — every engine derives the window from this one
            // piece of arithmetic (the TS mirror in `timeline.ts` included), so
            // there is one answer, not two that agree by luck.
            TransitionAlignment::CenterAtCut => {
                let start = self.at_frame - d / 2;
                (start, start + d)
            }
            TransitionAlignment::StartAtCut => (self.at_frame, self.at_frame + d),
            TransitionAlignment::EndAtCut => (self.at_frame - d, self.at_frame),
        }
    }

    /// Whether `pos` (a TIMELINE frame) falls inside this transition's window.
    pub fn covers(&self, pos: i64) -> bool {
        let (start, end) = self.window();
        pos >= start && pos < end
    }

    /// Linear progress through the window at `pos`, in `0.0..1.0` — `0.0` on the
    /// window's first frame, `(d-1)/d` on its last.
    ///
    /// **Exactly `(pos - start) / duration`, and that is a parity decision.**
    /// ffmpeg's own time-based ramp expressions (the export path builds one per
    /// transition) evaluate to precisely this at frame time `pos / fps`, so the
    /// live preview and the exported file compute the same number for the same
    /// frame by construction rather than by two implementations happening to
    /// agree. A "nicer" centred sampling (`(pos - start + 0.5)/d`) would have
    /// had to be mirrored into every ffmpeg expression as a fudge term.
    pub fn progress_at(&self, pos: i64) -> f64 {
        let (start, end) = self.window();
        let d = end - start;
        if d <= 0 {
            return 0.0;
        }
        (((pos - start) as f64) / (d as f64)).clamp(0.0, 1.0)
    }

    /// How many TIMELINE frames of the INCOMING clip's **head handle** (media
    /// before its own in-point) this transition needs — the part of the window
    /// falling before the cut.
    pub fn head_handle(&self) -> i64 {
        let (start, _) = self.window();
        (self.at_frame - start).max(0)
    }

    /// How many TIMELINE frames of the OUTGOING clip's **tail handle** (media
    /// past its own out-point) this transition needs — the part of the window
    /// falling at or after the cut.
    pub fn tail_handle(&self) -> i64 {
        let (_, end) = self.window();
        (end - self.at_frame).max(0)
    }

    /// The dip plate's colour, `(r, g, b)`, defaulting to black for an absent or
    /// unparseable value. Same degrade-don't-fail contract [`TextLayer::rgb`]
    /// documents.
    pub fn rgb(&self) -> (u8, u8, u8) {
        self.color
            .as_deref()
            .and_then(parse_hex_rgb)
            .unwrap_or((0, 0, 0))
    }

    /// The plate's alpha at `pos` for a [`TransitionKind::DipToColor`] — a
    /// triangle peaking fully opaque in the middle of the window:
    /// `1 - |2p - 1|`.
    ///
    /// This is what makes a dip need no handle media: the clip underneath is
    /// simply whichever one [`Track::clip_at`] already resolves there (the
    /// outgoing before the cut, the incoming after), each showing only its own
    /// real frames, with the plate fully covering the swap at the moment it
    /// happens.
    pub fn dip_alpha_at(&self, pos: i64) -> f64 {
        let p = self.progress_at(pos);
        1.0 - (2.0 * p - 1.0).abs()
    }
}

fn default_track_gain() -> f32 {
    1.0
}

fn default_sync_locked() -> bool {
    true
}

/// D-149 — see [`Track::duck_attack_ms`]. Fast, so the duck is down before the
/// first word lands.
pub const DEFAULT_DUCK_ATTACK_MS: f32 = 10.0;
/// D-149 — see [`Track::duck_release_ms`]. Slow, so the bed does not pump
/// between words.
pub const DEFAULT_DUCK_RELEASE_MS: f32 = 300.0;

fn default_duck_attack_ms() -> f32 {
    DEFAULT_DUCK_ATTACK_MS
}

fn default_duck_release_ms() -> f32 {
    DEFAULT_DUCK_RELEASE_MS
}

impl Default for Track {
    /// Mirrors the `#[serde(default = …)]` functions above exactly — see the
    /// struct's own doc for why this is manual rather than derived.
    fn default() -> Self {
        Self {
            kind: TrackKind::default(),
            clips: Vec::new(),
            gain: default_track_gain(),
            locked: false,
            hidden: false,
            sync_locked: default_sync_locked(),
            duck_from: None,
            duck_db: 0.0,
            duck_attack_ms: default_duck_attack_ms(),
            duck_release_ms: default_duck_release_ms(),
            transitions: Vec::new(),
            // D-228 — `None` is genuinely "this track has no caption style of
            // its own", which is right for every video and audio track and
            // means "the defaults" on a subtitle track. No migration value
            // needed, exactly `Clip::caption`'s own reasoning.
            caption_style: None,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrackKind {
    #[default]
    Video,
    Audio,
    /// D-228 — a subtitle/caption lane. Its clips carry a
    /// [`caption::CaptionCue`] and are drawn over the finished picture by
    /// [`Timeline::resolve_visible_captions_at`], never through the video
    /// z-order; it contributes nothing to the audio mix. See the crate doc
    /// for why this is a track kind while D-211's title is not.
    ///
    /// **Every existing `kind == TrackKind::Video` / `== TrackKind::Audio`
    /// filter in the codebase keeps its exact meaning** — a subtitle track
    /// matches neither, so the compositor and the mixer skip it without
    /// needing to learn about it. That property is why this variant could be
    /// added without touching either of them.
    Subtitle,
}

/// D-211 — the font family key a [`TextLayer`] with no explicit `font`
/// resolves to. A *key* into `chroma::text`'s own font catalogue
/// (`app/src-tauri`), not a file path or a system family name: this crate is
/// pure L2 and never touches the filesystem, so it can only carry the name of
/// the choice, exactly as it carries `source_path` without ever opening it.
pub const DEFAULT_TEXT_FONT: &str = "sans-bold";

/// D-211 — default cap height, as a fraction of the COMPOSITION's own height.
/// 0.12 is a real title size (roughly 130 px in a 1080p frame), not a
/// placeholder.
///
/// **A fraction, not pixels**, for exactly the reason `Clip::position_x` is
/// (B-043): the live compositor rasterises the preview at whatever
/// `max_long_edge` the caller asked for (960 scrubbing / 640 playing) while
/// the export renders at full composition resolution, so a pixel size would
/// mean a different fraction of the picture in each. A fraction of the
/// composition height is invariant under every render scale by construction.
pub const DEFAULT_TEXT_SIZE: f64 = 0.12;

/// D-211 — default fill colour, `#RRGGBB`. White: the only colour that reads
/// on the widest range of footage, and what every reference NLE's own basic
/// title generator starts at.
pub const DEFAULT_TEXT_COLOR: &str = "#FFFFFF";

fn default_text_font() -> String {
    DEFAULT_TEXT_FONT.to_string()
}

fn default_text_size() -> f64 {
    DEFAULT_TEXT_SIZE
}

fn default_text_color() -> String {
    DEFAULT_TEXT_COLOR.to_string()
}

/// A generated **text/title layer** (D-211, `docs/notes/text-title-clips.md`)
/// — what makes a [`Clip`] draw rasterised text instead of decoding
/// `source_path`.
///
/// **Phase 1 is deliberately the "basic title generator", not the template
/// library.** Resolve's own titles feature is two things: a basic text
/// generator (type your text, set font/size/colour) and 100+ prebuilt Fusion
/// animated title templates. This is the first one, and only that. What is
/// deliberately NOT here, and why, is in `docs/notes/text-title-clips.md`'s
/// "Deferred" section — the short list: multi-line text, a background/box,
/// outline/stroke/shadow, per-character animation, and keyframeable
/// `size`/`color`.
///
/// **Single-line only, enforced at the write path** (`@chroma/editor`'s
/// `newTextLayer`/`set_text_clip` reject a `\n`). Not a shortcut: the live
/// preview rasterises with `ab_glyph` and the export rasterises with ffmpeg's
/// `drawtext`/libfreetype, and the ONE thing those two genuinely disagree
/// about is inter-line layout (line height, per-line alignment). Restricting
/// Phase 1 to the case where they provably agree is what makes "preview
/// matches export" a fact rather than a hope — the exact discipline B-088/
/// B-090/B-094 all established. See D-213.
///
/// **No `opacity` field.** A text layer's transparency is `Clip::opacity`,
/// which is already keyframeable and already multiplied by the clip's fade —
/// a second alpha here would be two sources of truth for one number.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TextLayer {
    /// The text to draw. Single line — see the type's own doc.
    pub content: String,
    /// A font-family **key** into `chroma::text`'s catalogue (`sans`,
    /// `sans-bold`, `serif`, …), NOT a path or a system family name. The
    /// catalogue is what maps a key to a real font FILE, and both renderers
    /// read that same file: the live compositor loads it with `ab_glyph`, the
    /// export passes the identical path to `drawtext`'s `fontfile=`. That
    /// shared file is the whole reason preview and export produce the same
    /// glyphs at all (D-212).
    #[serde(default = "default_text_font")]
    pub font: String,
    /// Font size as a fraction of the COMPOSITION's height — see
    /// [`DEFAULT_TEXT_SIZE`] for why a fraction rather than pixels.
    #[serde(default = "default_text_size")]
    pub size: f64,
    /// Fill colour, `#RGB` or `#RRGGBB`. A string rather than a packed
    /// integer or three floats because it is what both consumers actually
    /// want: the GUI's colour input and ffmpeg's `fontcolor=` both speak hex,
    /// and [`Self::rgb`] is the one place it is parsed for the Rust
    /// rasteriser.
    #[serde(default = "default_text_color")]
    pub color: String,
}

impl Default for TextLayer {
    /// Manual for the same reason [`Clip`]'s is: `size`'s meaningful default
    /// is not `0.0` (which would render nothing) and `font`/`color`'s are not
    /// the empty string. Mirrors the `#[serde(default = …)]` functions above
    /// field for field.
    fn default() -> Self {
        Self {
            content: String::new(),
            font: default_text_font(),
            size: default_text_size(),
            color: default_text_color(),
        }
    }
}

impl TextLayer {
    /// [`Self::color`] parsed to `(r, g, b)`, falling back to opaque white for
    /// anything unparseable.
    ///
    /// **Falls back rather than erroring** — the same "the model stores what
    /// the UI wrote, the consumer decides what it means" rule `Clip::opacity`
    /// and the crop insets already follow (`chroma_timeline_set` stores
    /// whatever it is handed, so every consumer has to degrade safely). A
    /// title that renders white because its colour string was malformed is
    /// visible and fixable; one that fails the whole frame decode is not.
    ///
    /// Accepts `#RGB` and `#RRGGBB`, with or without the leading `#`.
    pub fn rgb(&self) -> (u8, u8, u8) {
        parse_hex_rgb(&self.color).unwrap_or((255, 255, 255))
    }
}

/// `#RGB` / `#RRGGBB` → `(r, g, b)`. `None` for anything else — see
/// [`TextLayer::rgb`] for who decides what that means.
pub(crate) fn parse_hex_rgb(s: &str) -> Option<(u8, u8, u8)> {
    let hex = s.trim().strip_prefix('#').unwrap_or(s.trim());
    let byte = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).ok();
    match hex.len() {
        3 => {
            // `#abc` is `#aabbcc` — each nibble doubled, the standard CSS
            // shorthand expansion (`0xa` → `0xaa`, i.e. `n * 17`).
            let n = |i: usize| u8::from_str_radix(&hex[i..i + 1], 16).ok().map(|v| v * 17);
            Some((n(0)?, n(1)?, n(2)?))
        }
        6 => Some((byte(0)?, byte(2)?, byte(4)?)),
        _ => None,
    }
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
///
/// **B-077/`source_fps`.** `source_start`/`duration` being in a clip's own
/// SOURCE frames only equals `start_frame`'s TIMELINE frames when a clip's
/// native rate happens to equal the project's — true for ordinary same-fps
/// footage, false the moment two sources at two different native rates share
/// one timeline. `source_fps` (below) is the fact that closes that gap.
///
/// **B-079 — fixed.** This crate's own LIVE frame-resolution methods
/// (`Clip::end_frame_at`, `Track::clip_at`/`clip_spans_from`/`duration`, and
/// by extension `Timeline::duration`/`resolve_video_clip_at`/
/// `resolve_visible_video_layers_at`) now convert through `source_fps` via
/// [`source_frames_to_timeline`]/[`timeline_frames_to_source`] before
/// combining a `start_frame`-space position with a `duration`/`source_start`-
/// space quantity — the same "convert at every consumption site" fix B-077/
/// D-194 already gave `@chroma/editor`'s `timeline.ts`, chosen again here for
/// the identical reasoning (see D-194 in `docs/08-decisions.md`, and the new
/// D-NNN this fix adds). **The plain, fps-naive `Clip::end_frame`/
/// `Track::gap_at`(without an `fps` arg) pairing is deliberately UNCHANGED**
/// and stays that way: this crate's own `trim_start`/`trim_end`/`split`/
/// `move_clip` editing ops are confirmed unreachable from the running app
/// (every real edit, GUI or MCP, goes through `@chroma/editor`'s `applyOp` +
/// `chroma_timeline_set` instead) — see `Clip::end_frame`'s own doc for the
/// exact boundary. The field is declared here so it **persists** through a
/// `chroma_timeline_set`/`_get` round trip (Tauri's IPC deserializes a
/// command's JSON argument straight into this struct — an undeclared field
/// would be silently dropped, re-breaking B-075/B-077 on the very first save)
/// and is available to Rust code that DOES already need it
/// (`chroma::edit`/`chroma::audio`'s real-time playback/decode path — now
/// fixed to use it, see this doc's own "B-079 — fixed" section above).
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
    /// B-077/B-075 — the source media's own real frame rate, populated by
    /// `@chroma/editor`'s `editor_add_clip`/`linkedClipsFromDraggedMedia` from
    /// the probed media pool item's `video.fps` at the moment this clip was
    /// created. `None` for a clip built before this field existed, or one
    /// whose source was never successfully probed — the conservative "don't
    /// invent a number" reading `chroma_keyframes` and the transform fields
    /// above already use. See the `Clip` doc's own "B-077/`source_fps`"
    /// section for exactly what this field does and does NOT fix by itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_fps: Option<f64>,
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
    /// **Normalised** offset from this clip's natural (centred, unscaled)
    /// position — a fraction of the COMPOSITION's own width/height (D-136,
    /// Phase 0a of `docs/notes/on-canvas-transform.md`). `0.5` on
    /// `position_x` moves the layer right by half a frame width, whatever
    /// the composition's pixel resolution and whatever resolution the
    /// preview happens to be decoding at.
    ///
    /// **Why normalised, and what it fixes (B-043):** these used to be
    /// absolute pixels in the compositor's canvas, and that canvas was the
    /// *top layer's decoded* size — i.e. it followed whatever
    /// `max_long_edge` the preview asked for. `position_x: 200` therefore
    /// meant 20.8 % of the frame on a 960-wide canvas and 31.25 % on a
    /// 640-wide one, so an overlay moved when the preview quality changed,
    /// and the same offset meant different things for a 4K source and a
    /// 720p one. A fraction of the composition is invariant under every
    /// decode scale by construction — the exact reasoning D-132's crop
    /// insets were built with from their first line (see `crop_left`), now
    /// retrofitted onto the field that predates it.
    ///
    /// The composition is `ProjectSettings::width`/`height` (D-038), with
    /// the top layer's own probed source resolution as the fallback for a
    /// project that never recorded one; `chroma::edit`'s compositor owns
    /// that resolution (this crate does no rendering — see the module doc).
    ///
    /// Per-axis: `position_x` is a fraction of the composition WIDTH,
    /// `position_y` of its HEIGHT. Same per-axis convention `crop_left` /
    /// `crop_top` already use.
    ///
    /// `#[serde(default)]` is correct (`0.0` = no offset, the only sane
    /// unset-field meaning) — but note that unlike every other migration on
    /// this struct, an ABSENT key is not what identifies a legacy value
    /// here: a pre-D-136 clip has the key, with a number in the old unit.
    /// That is why the migration is version-gated in
    /// `chroma::project::load_manifest` and applied by
    /// [`Timeline::normalise_legacy_positions`], rather than detected by a
    /// serde default or a sentinel the way `start_frame`'s is.
    #[serde(default)]
    pub position_x: f64,
    #[serde(default)]
    pub position_y: f64,
    /// Uniform scale multiplier, applied to the layer's **natural footprint
    /// in composition space** — its own source pixel dimensions measured
    /// against the composition's (D-136). `1.0` on a clip whose source
    /// matches the project resolution is exactly full-frame; `1.0` on a
    /// 640×360 clip in a 1920×1080 project is a third of the frame wide, and
    /// stays a third at every preview quality. Before D-136 this multiplied
    /// the layer's *decoded* size against a canvas that was some other
    /// layer's decoded size, so it too changed meaning with the preview
    /// scale (the second half of B-043).
    ///
    /// `#[serde(default = "default_scale")]` for the same reason `opacity`
    /// isn't a bare `#[serde(default)]`: `f64::default() == 0.0` would
    /// render every existing clip as a single point.
    #[serde(default = "default_scale")]
    pub scale: f64,
    /// Independent per-axis box-size override (D-193,
    /// `docs/notes/independent-clip-size.md`) — a fraction of the OUTPUT
    /// COMPOSITION's own width, the SAME per-axis convention `position_x`
    /// already uses (D-136), not a multiplier of the layer's natural
    /// footprint the way `scale` is. `None` (every pre-D-193 clip, and any
    /// clip this crate builds without setting it) means "derive this axis
    /// from `scale`'s own natural-footprint formula instead" — the
    /// byte-identical-to-pre-D-193 fallback; see `chroma::edit::
    /// composite_layer_onto`'s own doc for exactly where that fallback is
    /// applied.
    ///
    /// **Why a second pair of fields rather than reinterpreting `scale`
    /// as two numbers:** `scale`'s meaning (a multiplier of the clip's own
    /// SOURCE resolution mapped into composition space) is exactly what
    /// makes a plain picture-in-picture bubble "the clip's own native
    /// size, scaled" with zero extra data — genuinely the more useful
    /// default for that case, and every existing project already depends
    /// on it meaning that. `box_width`/`box_height` are for the OTHER real
    /// case this model could not express at all before D-193: an
    /// arbitrary, independently-sized box (e.g. exactly half a 9:16
    /// canvas's width, full height) that has nothing to do with the
    /// clip's own source resolution. Two concepts, not one field
    /// overloaded to mean either depending on how many numbers you passed.
    ///
    /// **Why this, unlike `scale`, has NO Rust/TS-export parity gap
    /// (D-193):** both engines already know the OUTPUT canvas's own pixel
    /// size (it's a render parameter on both sides), so a canvas-fraction
    /// box needs no source-resolution probing anywhere — `scale` needs the
    /// clip's SOURCE resolution to place it correctly (`chroma::edit`'s
    /// live-preview compositor probes it; `timelineExport.ts`'s pure,
    /// no-I/O ffmpeg-argv compiler cannot, which is exactly B-074/D-184's
    /// own documented gap, kept as-is for `scale`, not reopened here).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub box_width: Option<f64>,
    /// Fraction of the OUTPUT COMPOSITION's own height — see `box_width`'s
    /// doc for the full reasoning, identical per-axis.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub box_height: Option<f64>,
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

    // --- Fade in / out (D-147) -------------------------------------------- //
    // How many frames at the head / tail of this clip its output ramps up /
    // down over, and the curve each ramp is shaped by. The evaluation is
    // `fade::fade_gain`; the consumers are `chroma::edit`'s compositor (which
    // multiplies the result into `opacity`) and `chroma::audio`'s mixer (which
    // multiplies it into this clip's samples).
    //
    // **One pair, driving both picture and sound** — not separate video/audio
    // fades. That is what Premiere and Resolve actually do: one fade handle
    // per clip, whose meaning follows what the clip contributes (opacity on a
    // video clip, volume on an audio one; both on a video clip that still
    // carries its own embedded audio). A user who genuinely wants them to
    // differ unlinks the A/V pair (D-129) and gets two clips with two
    // independent fades — the workflow both references push you toward.
    // Full reasoning in `docs/notes/audio-fade-duck-crossfade-plan.md` §2.
    //
    // **`i64`, not `u32`**, despite these being non-negative by nature: every
    // frame count on this struct (`duration`, `source_len`, `source_start`,
    // `start_frame`) is `i64`, and a `u32` here would need a cast at every
    // comparison against `duration` — including inside the audio mixer's
    // sample arithmetic. A negative or nonsense value is treated as "no fade"
    // at the point of use (`fade_gain`), the same "the model stores what the
    // UI wrote, the consumer decides what it means" rule `crop_left` states.
    //
    // `#[serde(default)]` is correct here (unlike `opacity`/`scale`, and like
    // the crop insets): `i64::default() == 0`, and zero frames genuinely IS
    // "no fade", so a pre-D-147 `project.json` clip with none of these keys
    // loads un-faded and renders and mixes byte-identically. No migration
    // sentinel, no backfill pass. `fade_gain` short-circuits to exactly `1.0`
    // for that case, so it also costs nothing.
    /// Frames at the head of the clip over which its output ramps up from
    /// silence/transparency. `0` = no fade in.
    #[serde(default)]
    pub fade_in_frames: i64,
    /// Frames at the tail of the clip over which its output ramps down to
    /// silence/transparency. `0` = no fade out.
    #[serde(default)]
    pub fade_out_frames: i64,
    /// The shape of the fade-in ramp — a `cubic-bezier(x1,y1,x2,y2)` curve
    /// (see [`FadeCurve`]). Defaults to [`FadeCurve::LINEAR`], the exact
    /// identity, for a missing key AND for `Clip::default()`.
    #[serde(default)]
    pub fade_in_curve: FadeCurve,
    /// The shape of the fade-out ramp. Separate from `fade_in_curve` because
    /// both references let you shape each handle independently, and it costs
    /// one field. Note the ramp is evaluated on *distance from the
    /// out-point*, so this curve's `x = 0` is the very end of the clip — an
    /// `ease-in` fade-out is slow near silence, matching an `ease-in` fade-in.
    #[serde(default)]
    pub fade_out_curve: FadeCurve,

    // --- Per-clip audio level (D-223) ------------------------------------- //
    // This clip's OWN contribution to the mix, independent of the track it
    // sits on. `Track::gain` (D-057) is a fader for a whole track and cannot
    // express "this one line of dialogue is too loud"; these two can, and are
    // what Resolve's Inspector calls Clip Volume / Clip Pan
    // (`scratch/resolve-reference/soundtrack.jpg`, feature 9).
    //
    // **They compose by MULTIPLICATION with everything else**, in the one
    // order both the live mixer and the exporter implement:
    // `track.gain × clip.volume × fade × duck`, then the pan law splits that
    // per channel. Multiplication is the only composition under which no stage
    // silently overrides another — the same argument `SourceEnvelopes::apply`
    // already makes for a fade against a duck, and `resolve_clip_transform`
    // for a fade against keyframed opacity.
    //
    // Both are **keyframeable** through the same `chroma_keyframes` array
    // below, under the names `"volume"` and `"pan"` — the D-034 interpolator is
    // generic over the param name, so an automation ramp on either is the same
    // per-property keyframing every transform field already has (D-208), not a
    // second mechanism.
    /// This clip's own **linear** volume multiplier. `1.0` = unity.
    ///
    /// Linear, not decibels, and deliberately the same unit as
    /// [`Track::gain`]: two level controls in the same signal chain that
    /// disagree about their unit is a trap ("is 0.5 half or is it −0.5 dB?"),
    /// and `gain` was here first. (`Track::duck_db` is the one dB number in
    /// the audio path, for its own stated reason — a duck *amount* is what
    /// editors state in dB; a fader level is not.)
    ///
    /// `#[serde(default = "default_volume")]`, NOT a bare `#[serde(default)]`:
    /// `f64::default() == 0.0`, which would render every pre-D-223 clip
    /// **silent** — precisely the migration hazard `opacity` documents above,
    /// and the reason both use a named default rather than the type's zero.
    /// Negative/non-finite values are floored at the point of use
    /// (`chroma_types::clip_volume`); there is deliberately no ceiling, exactly
    /// as `Track::gain` has none.
    #[serde(default = "default_volume")]
    pub volume: f64,
    /// This clip's own stereo position: `-1.0` hard left · `0.0` centre ·
    /// `1.0` hard right. The **first** pan-like field in the model — there was
    /// no prior convention on `Track` or anywhere else to match, so this
    /// establishes the one a track-level or master pan should later follow.
    ///
    /// A bare `#[serde(default)]` is correct here (and, unlike `volume` above,
    /// genuinely rather than lazily): `f64::default() == 0.0` and **0.0 is
    /// centre**, which the pan law returns exactly `(1.0, 1.0)` for — so a
    /// pre-D-223 clip mixes bit-identically. Same reasoning `Track::duck_db`'s
    /// own bare default records for 0 dB being unity.
    ///
    /// The law itself is `chroma_types::pan_gains` (constant power, 0 dB
    /// centre) — see that module for what the choice costs at the extremes.
    /// Out-of-range values are clamped there, not here, following `crop_left`'s
    /// "the model stores what the UI wrote, the consumer decides what it
    /// means" rule.
    #[serde(default)]
    pub pan: f64,

    // --- Per-clip parametric EQ (D-224) ----------------------------------- //
    /// This clip's own multi-band parametric equaliser — the next stage in the
    /// same per-clip audio chain `volume`/`pan` opened (D-223), and what
    /// Resolve's Inspector calls the Clip Equalizer
    /// (`scratch/resolve-reference/soundtrack.jpg`, feature 9).
    ///
    /// **A `Vec`, and empty means no EQ.** Deliberately not a fixed-length
    /// array of four, even though the Inspector authors exactly Resolve's
    /// four-band strip (`DEFAULT_EQ_BANDS` in `@chroma/editor`'s `eq.ts`):
    /// - every band already carries its own [`EqBandKind`], so a fixed
    ///   index → role mapping would be a second source of truth for the same
    ///   fact, free to disagree with the band it describes;
    /// - `Vec::default()` is empty, which really IS "no EQ" — no named serde
    ///   default and none of `volume`'s own migration hazard, and a pre-D-224
    ///   clip carries no key at all and mixes byte-identically;
    /// - a fixed `[EqBand; 4]` makes any future change to the band count a
    ///   hard deserialisation wall for every existing project, whereas a list
    ///   just gets longer.
    ///
    /// **Every consumer is length-agnostic and filters on
    /// [`EqBand::is_active`]** — the mixer builds one biquad per active band
    /// per channel, the exporter one `biquad` filter node per active band — so
    /// a band set of any length, from any build, works. A clip whose bands are
    /// all inactive (a materialised strip nobody has touched: gain-using kinds
    /// at exactly 0 dB) gets no filter and no filtergraph node at all.
    ///
    /// **Static, not keyframeable** — unlike `volume`/`pan` above, and that is
    /// a decision rather than an omission: ffmpeg's biquad filters take their
    /// parameters as numbers parsed once, so an animated EQ is not expressible
    /// in the export path at all, and a preview that did what the export
    /// cannot is the defect class this repo keeps closing. See D-224.
    ///
    /// Sound only, exactly like `volume`/`pan`: the whole clip on an audio
    /// track, the embedded audio on a video clip (and nothing once that audio
    /// is unlinked — D-129), nothing on a title.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub eq_bands: Vec<EqBand>,

    // --- Text / title layer (D-211) --------------------------------------- //
    /// `Some` = this clip is a **generated text layer**, not a windowed
    /// reference into a media file: its picture is rasterised from
    /// [`TextLayer`] and its `source_path` is empty. `None` (every clip in
    /// every pre-D-211 project, and every clip built from real media) is an
    /// ordinary media clip, byte-identical to before this field existed.
    ///
    /// **A `Clip` variant rather than a `TrackKind::Text` (D-211).** Both
    /// references put a title on an ordinary video track above the picture,
    /// and the z-order that makes a title composite over the video is
    /// [`Timeline::resolve_visible_video_layers_at`]'s existing track-index
    /// order — already exactly right, with nothing to add. A new track kind
    /// would have needed its own resolver, its own compositing-order rule,
    /// its own audio/video split in every walk, and its own export pass, all
    /// re-deriving what track index order already gives — and would have made
    /// "a title on the same track as the shot it labels" unrepresentable,
    /// which every reference NLE allows. See D-211 for the full comparison.
    ///
    /// `#[serde(default, skip_serializing_if = "Option::is_none")]` — a
    /// pre-D-211 clip has no key and deserialises to `None`, no migration and
    /// no sentinel needed, exactly `media_id`/`link_group`'s own precedent.
    ///
    /// **Which of this clip's other fields actually apply** is deliberately
    /// narrower than for a media clip in Phase 1 — `opacity` (with its fade)
    /// and `position_x`/`position_y` do, `scale`/`rotation`/`box_*`/the crop
    /// insets do NOT, in EITHER renderer. See `docs/notes/text-title-clips.md`
    /// §"What applies to a text clip" for why (short version: the export path
    /// is `drawtext`, which can place and fade a text box but cannot scale,
    /// rotate or crop one, and a preview that did what the export cannot is
    /// the B-053 class of defect this repo keeps closing).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<TextLayer>,

    // --- Caption cue (D-228) ------------------------------------------------ //
    /// `Some` = this clip is one **caption** on a [`TrackKind::Subtitle`]
    /// track: its picture is the cue's text, drawn over the finished frame,
    /// and its `source_path` is empty. `None` (every clip in every pre-D-228
    /// project) is unchanged in every way.
    ///
    /// **The cue's timing IS the clip's timing** — `start_frame` and
    /// `duration`, like any other clip. That is the whole reason a caption is
    /// a `Clip` at all rather than an entry in a list hanging off the
    /// timeline: every existing edit op (move, trim, split, remove, the
    /// ripple ops, the marquee, the undo stack) then works on a caption for
    /// free, which is what Blackmagic's own copy promises captions do — "can
    /// be moved and trimmed like any other media".
    ///
    /// **Which of this clip's other fields apply: none of the geometry
    /// ones.** A caption is positioned, sized and coloured entirely by its
    /// resolved [`caption::CaptionStyle`] — `position_x`/`position_y`,
    /// `scale`, `rotation`, the crop insets, `opacity` and the fades are all
    /// ignored by both renderers. That is a deliberate line, drawn for
    /// D-211's reason one step further: the export draws a caption with
    /// `drawtext`, which cannot scale, rotate or crop a text box, and a
    /// preview offering controls the export silently ignores is the B-053
    /// class of defect this repo keeps closing. See D-228.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caption: Option<CaptionCue>,
}

fn default_opacity() -> f64 {
    1.0
}

fn default_scale() -> f64 {
    1.0
}

/// D-223 — unity, for exactly [`default_opacity`]'s reason: a bare
/// `#[serde(default)]` would deserialise a pre-D-223 clip to `0.0`, i.e.
/// silence, which is a silent regression rather than "the sane default for an
/// unset field."
fn default_volume() -> f64 {
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
            source_fps: None,
            start_frame: 0,
            opacity: default_opacity(),
            position_x: 0.0,
            position_y: 0.0,
            scale: default_scale(),
            box_width: None,
            box_height: None,
            rotation: 0.0,
            crop_left: 0.0,
            crop_top: 0.0,
            crop_right: 0.0,
            crop_bottom: 0.0,
            chroma_keyframes: None,
            // D-147 — zero frames really is "no fade", so unlike
            // `opacity`/`scale` these two need no non-zero migration default.
            fade_in_frames: 0,
            fade_out_frames: 0,
            // …but the curves DO: `FadeCurve`'s own `Default` is `LINEAR`,
            // not the type's zero value, which is a real, badly-behaved curve
            // (see that impl). Spelled out here rather than relying on it
            // implicitly, since this whole `impl Default` exists because a
            // derived one got exactly this class of thing wrong.
            fade_in_curve: FadeCurve::LINEAR,
            fade_out_curve: FadeCurve::LINEAR,
            // D-223 — `volume` needs the non-zero default for `opacity`'s own
            // reason (the type's zero is silence); `pan`'s zero really IS
            // centre, so it takes the type's own.
            volume: default_volume(),
            pan: 0.0,
            // D-224 — empty genuinely IS "no EQ" (see the field's own doc), so
            // unlike `volume` this one needs no non-zero migration default.
            eq_bands: Vec::new(),
            // D-211 — `None` is genuinely "an ordinary media clip", the only
            // sane default, so this one needs no non-zero migration value.
            text: None,
            // D-228 — same reasoning again: `None` is "not a caption".
            caption: None,
        }
    }
}

impl Clip {
    /// D-211 — whether this clip is a generated [`TextLayer`] rather than a
    /// windowed reference into a media file. The one predicate every consumer
    /// branches on, so "is it a text clip" is asked one way everywhere rather
    /// than as an `is_some()` at each site.
    pub fn is_text(&self) -> bool {
        self.text.is_some()
    }

    /// D-228 — whether this clip is a caption cue rather than a windowed
    /// reference into a media file. The caption counterpart of
    /// [`Self::is_text`], and asked the same way everywhere for the same
    /// reason.
    pub fn is_caption(&self) -> bool {
        self.caption.is_some()
    }

    /// D-228 — whether this clip's picture is **generated** rather than
    /// decoded from `source_path`: a title or a caption.
    ///
    /// The predicate every "do I need to open a media file for this clip"
    /// site wants. Before captions there was exactly one kind of generated
    /// clip and `is_text()` doubled as this question; naming it separately is
    /// what stops the next generated-layer kind from having to find every
    /// `is_text()` that actually meant "generated".
    pub fn is_generated(&self) -> bool {
        self.is_text() || self.is_caption()
    }

    /// D-224 — does this clip's EQ actually change its sound? The one
    /// predicate both audio consumers branch on, so "is the EQ doing
    /// anything" is asked the same way in the mixer and the exporter rather
    /// than each re-spelling the filter.
    ///
    /// `false` for a clip with no bands at all AND for one whose bands are
    /// all inactive — a materialised four-band strip nobody has touched is
    /// the second case, and it must cost the mix exactly nothing (see
    /// [`EqBand::is_active`]).
    pub fn has_active_eq(&self) -> bool {
        self.eq_bands.iter().any(|b| b.is_active())
    }

    /// The exclusive upper bound for `source_start + duration`.
    fn source_ceiling(&self) -> i64 {
        self.source_len.max(0)
    }

    /// The exclusive upper bound of this clip's occupied timeline range —
    /// **fps-naive**: plain `start_frame + duration`, correct only when this
    /// clip's native rate equals the project's (`source_fps` absent, or
    /// equal to the timeline's own `fps`) — the B-077/B-079 conflation.
    ///
    /// **Kept only for this crate's own `trim_start`/`trim_end`/`split`/
    /// `move_clip`/`remove_gap` editing ops** (D-130's original reason: both
    /// would otherwise re-spell `start_frame + duration` at the call site),
    /// **confirmed unreachable from the running app** (B-079 — every real
    /// edit, GUI or MCP, goes through `@chroma/editor`'s `applyOp` +
    /// `chroma_timeline_set` instead, never these ops directly). Changing
    /// dead code's arithmetic would be unverifiable churn, so it stays
    /// exactly as it always has.
    ///
    /// **Every LIVE consumer must use [`Self::end_frame_at`] instead** —
    /// `chroma::edit`'s compositor/preview-decode path and `chroma::audio`'s
    /// mixer both do, as of B-079's fix.
    pub fn end_frame(&self) -> i64 {
        self.start_frame + self.duration
    }

    /// B-079 — the fps-aware equivalent of [`Self::end_frame`]: converts
    /// `duration` (this clip's own SOURCE frames) into TIMELINE frames via
    /// [`source_frames_to_timeline`] before adding it to `start_frame`,
    /// exactly `@chroma/editor/timeline.ts`'s `endFrame` (B-077/D-194).
    /// Identical to `end_frame()` whenever `source_fps` is absent or equals
    /// `fps` — every existing same-native-fps project computes the same
    /// number either way, so this is a strict widening, not a behavior
    /// change for the common case.
    pub fn end_frame_at(&self, fps: f64) -> i64 {
        self.start_frame + source_frames_to_timeline(self.source_fps, self.duration, fps)
    }

    /// D-226 — the SOURCE frame this clip shows at TIMELINE frame
    /// `timeline_frame`, **without** [`Track::clip_at`]'s "is it inside this
    /// clip's window" check: the identical arithmetic, extrapolated.
    ///
    /// Extracted and made `pub` because a transition genuinely needs the
    /// extrapolation — for the length of a cross dissolve, one of the two clips
    /// is being shown at a position OUTSIDE its own `[start_frame,
    /// end_frame_at)` window and must display its **handle** media there (the
    /// outgoing clip past its out-point, the incoming clip before its in-point).
    /// `clip_at` cannot answer that by construction, and re-spelling its formula
    /// at the transition call site is exactly the duplication this method
    /// exists to prevent — `clip_at` now calls this too, so the in-window and
    /// handle cases can never drift apart.
    ///
    /// The result may fall outside `[0, source_len)`; deciding what to do about
    /// that is the consumer's (see [`Self::clamped_source_frame_at`]).
    pub fn source_frame_at(&self, timeline_frame: i64, fps: f64) -> i64 {
        self.source_start
            + timeline_frames_to_source(self.source_fps, timeline_frame - self.start_frame, fps)
    }

    /// D-226 — [`Self::source_frame_at`] pinned into the source's own real
    /// extent, `[0, source_len)`.
    ///
    /// **The freeze-frame fallback, and it is deliberately the LAST line of
    /// defence, not the feature.** `@chroma/editor`'s `checkTransition` refuses
    /// a cross dissolve whose handles do not exist before one is ever written,
    /// so a well-formed document never reaches this clamp. It exists because
    /// `chroma_timeline_set` stores whatever it is handed (D-058) — a document
    /// hand-edited, written by an older build, or left dangling by a later trim
    /// can still ask for a frame that is not in the file, and holding the
    /// nearest real frame is the only degrade that keeps rendering (it is also
    /// exactly what Premiere Pro does on "Insufficient Media": "repeating the
    /// end frames to form a freeze frame"). `source_len <= 0` (an unprobed
    /// source) means "no known extent", so only the lower bound applies.
    pub fn clamped_source_frame_at(&self, timeline_frame: i64, fps: f64) -> i64 {
        let raw = self.source_frame_at(timeline_frame, fps).max(0);
        if self.source_len > 0 {
            raw.min(self.source_len - 1)
        } else {
            raw
        }
    }

    /// D-147 — this clip's fade multiplier `frames_into_clip` frames after its
    /// own in-point, in `0.0..=1.0`. Exactly `1.0`, with no arithmetic, for a
    /// clip with no fade configured — which is every clip in every pre-D-147
    /// project, so the render/mix paths stay byte-identical.
    ///
    /// `pub` for the same reason [`Self::end_frame`] is: two `app/src-tauri`
    /// consumers need it (`chroma::edit`'s compositor, in *video* frames, and
    /// `chroma::audio`'s mixer, which uses the unit-agnostic [`fade_gain`]
    /// directly at *sample*-frame resolution instead — a per-video-frame step
    /// would be audible zipper noise). Both would otherwise re-spell this
    /// against `duration` at the call site, which is the arithmetic this type
    /// exists to own.
    pub fn fade_multiplier_at(&self, frames_into_clip: i64) -> f64 {
        fade_gain(
            frames_into_clip as f64,
            self.duration as f64,
            self.fade_in_frames as f64,
            self.fade_out_frames as f64,
            &self.fade_in_curve,
            &self.fade_out_curve,
        )
    }

    /// The per-clip half of [`Timeline::normalise_legacy_positions`] — see
    /// that method for the whole reasoning. Migrates the static fields AND
    /// the `position_x`/`position_y` keys inside every `chroma_keyframes`
    /// entry: an animated position was stored in the same old unit, so
    /// leaving the keys behind would migrate a clip's base transform and
    /// then have the interpolator immediately override it with un-migrated
    /// values — a keyframed PIP would be the one case the migration made
    /// *worse*. Keys this clip doesn't animate are left exactly as they are;
    /// a keyframes payload that isn't the expected `[{frame, params}]` array
    /// is skipped rather than guessed at.
    fn normalise_legacy_position(&mut self, comp_w: f64, comp_h: f64) {
        self.position_x /= comp_w;
        self.position_y /= comp_h;
        let Some(serde_json::Value::Array(keys)) = self.chroma_keyframes.as_mut() else {
            return;
        };
        for key in keys {
            let Some(params) = key.get_mut("params").and_then(|p| p.as_object_mut()) else {
                continue;
            };
            for (field, size) in [("position_x", comp_w), ("position_y", comp_h)] {
                let Some(px) = params.get(field).and_then(serde_json::Value::as_f64) else {
                    continue;
                };
                // `from_f64` is `None` only for NaN/±inf, which a params
                // object should never carry — leave such a value untouched
                // rather than dropping the key and silently un-animating it.
                if let Some(n) = serde_json::Number::from_f64(px / size) {
                    params.insert(field.to_string(), serde_json::Value::Number(n));
                }
            }
        }
    }
}

/// One thing the compositor has to paint for one timeline position (D-226) —
/// what [`Timeline::resolve_visible_video_layers_at`] hands back.
///
/// Was a bare `(track, &Clip, source_frame)` tuple before transitions existed.
/// It had to grow because a transition adds two facts a tuple cannot carry: a
/// layer may be a **generated colour plate** with no clip behind it at all, and
/// a layer may be drawn at a **blend alpha** that is a property of the
/// transition rather than of the clip (so it must not be written into the
/// clip's own `opacity`, which is real, persisted, user-authored document
/// content).
#[derive(Debug, Clone)]
pub struct VisibleLayer<'a> {
    /// The video track this layer came from — its index in [`Timeline::tracks`],
    /// i.e. its compositing priority (lower = nearer the top).
    pub track: usize,
    pub source: LayerSource<'a>,
    /// Extra alpha multiplier contributed by a [`Transition`], in `0.0..=1.0`;
    /// exactly `1.0` for every layer outside one, which is every layer in every
    /// pre-D-226 project. The consumer multiplies it into the layer's resolved
    /// opacity **after** the clip's own static/keyframed opacity and its fade —
    /// the same multiplicative composition D-147 established for fade × opacity,
    /// so no one of the three silently overrides another.
    pub alpha: f64,
}

/// One caption showing at a position (D-228) — what
/// [`Timeline::resolve_visible_captions_at`] returns.
///
/// Carries its **resolved** style rather than a reference to the track's, so
/// the per-cue-override → track-style → defaults chain is walked in exactly
/// one place. Both renderers consume this; neither re-derives the style.
#[derive(Debug, Clone)]
pub struct VisibleCaption<'a> {
    /// The subtitle track this caption came from — its index in
    /// [`Timeline::tracks`].
    pub track: usize,
    /// The clip carrying the cue. Its `start_frame`/`duration` are the cue's
    /// timing; the export compiler reads them to build its `enable=` window.
    pub clip: &'a Clip,
    /// The cue itself — its text, and its per-cue style override if it has one.
    pub cue: &'a caption::CaptionCue,
    /// The style to actually draw with, already resolved.
    pub style: caption::CaptionStyle,
}

/// What a [`VisibleLayer`]'s picture comes from (D-226).
#[derive(Debug, Clone)]
pub enum LayerSource<'a> {
    /// A real clip on the track, at a resolved SOURCE frame.
    Clip {
        clip: &'a Clip,
        source_frame: i64,
        role: LayerRole,
    },
    /// A generated full-frame plate of a solid colour — a
    /// [`TransitionKind::DipToColor`]'s dip. Carries no clip and no source
    /// frame because it has neither: nothing is decoded for it.
    Color { rgb: (u8, u8, u8) },
}

/// Which decode stream a [`LayerSource::Clip`] belongs to within its track
/// (D-226).
///
/// **This exists for the decode pipe, and it is a real performance constraint,
/// not bookkeeping.** `chroma_media::decode_pipe` keys one live `ffmpeg` process
/// per slot, and two callers interleaving different sources or positions through
/// one slot make each call restart the other's process (B-040 — it is what once
/// reduced the multi-layer preview to ~0.85 fps). A cross dissolve is exactly
/// that situation *within a single track*, which had never happened before, so
/// the two clips need two slots.
///
/// The **outgoing** clip keeps the track's own primary slot and the **incoming**
/// clip takes the partner slot, deliberately: at the moment a transition starts,
/// the outgoing clip's pipe is already warm and mid-stream (that is the normal
/// playback direction), so leaving it where it is means the transition does not
/// stall the stream that is already playing. The incoming clip's pipe is a cold
/// spawn either way, and migrates to the primary slot once at the window's end.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LayerRole {
    /// The track's ordinary layer — whatever [`Track::clip_at`] resolves there,
    /// and the only role any layer has outside a transition.
    Primary,
    /// The second clip a [`TransitionKind::CrossDissolve`] needs visible at the
    /// same time. Always the INCOMING clip; see the enum's own doc for why.
    TransitionPartner,
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
    /// D-138. `link`'s own two-clip identity check — linking a clip to
    /// itself would set `link_group` on one `Clip` and immediately call
    /// [`Timeline::link_group_members`] back with exactly one member, a
    /// degenerate "group" no other op (`unlink`, `move_clip`, …) is written
    /// to expect.
    #[error("cannot link a clip to itself")]
    LinkSameClip,
    /// D-138. `link` requires BOTH clips to currently be unlinked
    /// (`link_group: None`) — see `Timeline::link`'s own doc for why this
    /// pass deliberately does not implement Palmier's fuller "merges the
    /// complete existing groups touched by clipIds" behaviour. The `String`
    /// names the clip id that was already linked.
    #[error("clip {0} is already linked — unlink it first")]
    AlreadyLinked(String),
    /// D-138. `link` requires one video-track clip and one audio-track clip
    /// — the only shape `Clip::link_group`'s own doc gives a meaning to (a
    /// video clip's audio "externalized" to a linked clip). Linking two
    /// clips of the same track kind would set the suppression flag with
    /// nothing on the other side for it to mean.
    #[error("a link needs one video clip and one audio clip, not two of the same kind")]
    LinkKindMismatch,
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
fn propagate_sync_lock_ripple(
    tracks: &mut [Track],
    edited_track: usize,
    threshold: i64,
    delta: i64,
) {
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
                ..Default::default()
            }],
            markers: Vec::new(),
        }
    }

    /// B-079 — the project's own timebase, in frames/second:
    /// `rate.num/rate.den` when both are positive, else [`DEFAULT_FPS`].
    /// Exact mirror of `@chroma/editor/timeline.ts`'s `timelineFps` — the one
    /// place a Rust-side consumer that needs a clip's real (fps-converted)
    /// timeline footprint gets the project's own rate from.
    pub fn fps(&self) -> f64 {
        match &self.rate {
            Some(r) if r.num > 0 && r.den > 0 => r.num as f64 / r.den as f64,
            _ => DEFAULT_FPS,
        }
    }

    /// Total timeline length in frames — the longest track.
    pub fn duration(&self) -> i64 {
        let fps = self.fps();
        self.tracks
            .iter()
            .map(|t| t.duration(fps))
            .max()
            .unwrap_or(0)
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
        let fps = self.fps();
        self.tracks
            .iter()
            .enumerate()
            .filter(|(_, t)| t.kind == TrackKind::Video)
            .find_map(|(i, t)| t.clip_at(pos, fps).map(|(c, sf)| (i, c, sf)))
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
    ///
    /// **D-226 — a track may now contribute TWO entries, not at most one**, and
    /// an entry may be a generated colour plate rather than a clip: that is what
    /// a [`Transition`] is. The per-track ordering follows the same
    /// topmost-first rule as the across-track one, so a caller that already
    /// painted this list in reverse needs no new ordering rule — see
    /// [`Track::push_layers_at`], which owns the whole per-track decision. The
    /// return type changed from a bare `(usize, &Clip, i64)` tuple to
    /// [`VisibleLayer`] for exactly this: a plate has no clip and no source
    /// frame, and a transition partner carries a real blend alpha and its own
    /// decode-pipe role, none of which a three-tuple can say.
    pub fn resolve_visible_video_layers_at(&self, pos: i64) -> Vec<VisibleLayer<'_>> {
        let fps = self.fps();
        let mut out: Vec<VisibleLayer<'_>> = Vec::new();
        for (i, track) in self.tracks.iter().enumerate() {
            if track.kind != TrackKind::Video || track.hidden {
                continue;
            }
            track.push_layers_at(i, pos, fps, &mut out);
        }
        out
    }

    /// D-228 — every caption showing at timeline position `pos`, in paint
    /// order (**index-ascending, painted in the order returned**: the
    /// lowest-index subtitle track is drawn first, so a higher-index one lands
    /// on top of it).
    ///
    /// **Deliberately its own resolver, not a case inside
    /// [`Self::resolve_visible_video_layers_at`].** Captions do not take part
    /// in the video z-order at all: they are drawn over the finished picture
    /// whatever track index they sit at, and — unlike a video clip — a caption
    /// never occludes what is beneath it. Folding them into the video walk
    /// would have made a subtitle track's index mean "compositing priority
    /// against the picture", which it must not mean; keeping them separate is
    /// what lets the compositor and the mixer keep their existing
    /// `kind == Video` / `kind == Audio` filters unchanged.
    ///
    /// **Note the paint order is the OPPOSITE of the video one**, and that is
    /// not an inconsistency: video tracks are "lower index = nearer the top"
    /// because the top video track wins the picture, whereas subtitle tracks
    /// stack downward like the lanes they are — Subtitle 1 above Subtitle 2 in
    /// the track list draws first. Both are documented at their own call site
    /// so no consumer has to infer either.
    ///
    /// A hidden track contributes nothing, exactly as a hidden video track
    /// does. Each entry pairs the cue with the style it must actually be drawn
    /// with, already resolved through the per-cue override → track style →
    /// defaults chain, so no consumer re-derives it.
    pub fn resolve_visible_captions_at(&self, pos: i64) -> Vec<VisibleCaption<'_>> {
        let fps = self.fps();
        let mut out = Vec::new();
        for (i, track) in self.tracks.iter().enumerate() {
            if track.kind != TrackKind::Subtitle || track.hidden {
                continue;
            }
            for clip in &track.clips {
                let Some(cue) = &clip.caption else { continue };
                if pos < clip.start_frame || pos >= clip.end_frame_at(fps) {
                    continue;
                }
                out.push(VisibleCaption {
                    track: i,
                    clip,
                    cue,
                    style: cue
                        .style
                        .clone()
                        .or_else(|| track.caption_style.clone())
                        .unwrap_or_default(),
                });
            }
        }
        out
    }

    /// D-228 — the indices of every [`TrackKind::Subtitle`] track, in track
    /// order. What the export compiler and the `.srt` writer walk.
    pub fn subtitle_track_indices(&self) -> Vec<usize> {
        self.tracks
            .iter()
            .enumerate()
            .filter(|(_, t)| t.kind == TrackKind::Subtitle)
            .map(|(i, _)| i)
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

    /// Reinterpret every clip's pre-D-136 `position_x`/`position_y` — and the
    /// same two keys inside its `chroma_keyframes` — as **composition
    /// pixels**, dividing them into the normalised fractions those fields
    /// mean now. `comp_w`/`comp_h` are the project's composition size (see
    /// `Clip::position_x`'s doc).
    ///
    /// **This is a stated reinterpretation, not a conversion, and it cannot
    /// be anything else.** A stored `200` was pixels in the compositor's
    /// canvas, and that canvas was the top layer's *decoded* size at the
    /// preview quality in force when the number was typed — 960 long edge
    /// while scrubbing, 640 while playing, per source resolution. That
    /// context was never persisted, so the fraction the user actually saw is
    /// unrecoverable, and no arithmetic here can recover it. Treating the
    /// value as composition pixels is the reading that is exactly right for
    /// the most common real case (a single-source project whose composition
    /// was inferred from that same clip, previewed at full resolution) and
    /// wrong by a bounded factor everywhere else. Any project that actually
    /// used a PIP offset takes a one-time visual shift; every project that
    /// did not — i.e. every clip still at `0.0`, which is all of them until
    /// someone touches Position — migrates to exactly `0.0` and is
    /// pixel-identical. See D-136 for the options weighed.
    ///
    /// **Not idempotent, by nature** — running it twice divides twice. It is
    /// version-gated by `chroma::project::load_manifest` on the
    /// `project.json` schema minor, which is the only place that can tell an
    /// old value from a new one (the key is present either way, so no serde
    /// default or sentinel can, unlike `backfill_legacy_positions` above).
    /// A non-finite or non-positive composition size is a no-op rather than
    /// a panic or an infinity written into the project file.
    pub fn normalise_legacy_positions(&mut self, comp_w: f64, comp_h: f64) {
        if !comp_w.is_finite() || !comp_h.is_finite() || comp_w <= 0.0 || comp_h <= 0.0 {
            return;
        }
        for track in &mut self.tracks {
            for clip in &mut track.clips {
                clip.normalise_legacy_position(comp_w, comp_h);
            }
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
            ..Default::default()
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

    /// D-138, `docs/notes/av-linking.md`. Link two **already-independent**
    /// clips — one on a video track, one on an audio track — into a new A/V
    /// link group, indistinguishable afterwards from a group the drop path
    /// (D-129's `add_clip` + `linkedClipsFromDraggedMedia`) would have
    /// created: same field (`Clip::link_group`), same group-based shape, so
    /// every existing link-aware op (`move_clip`/`trim_start`/`trim_end`/
    /// `split`/`remove`/`unlink`) treats it identically without knowing or
    /// caring how the group came to exist. Returns the new group id.
    ///
    /// **Deliberately narrower than Palmier's own `manage_clip_links` `link`**
    /// ("merges the complete existing groups touched by clipIds," i.e. a
    /// general union-of-groups op that can also re-link an already-linked
    /// clip into a bigger group). D-129 named exactly this gap — "a manual
    /// `link` op … deferred" — for linking two clips that were never linked
    /// at all; nothing in the owner's ask for a "manual A/V link toggle"
    /// needs group-merging, and building it now would be speculative
    /// generality on a shape (N-way group merge) no caller exercises. Both
    /// clips must currently be unlinked ([`TimelineError::AlreadyLinked`]
    /// otherwise) — `unlink` first is the same "diverge, then re-associate"
    /// workflow `unlink` itself already exists for, not a new one.
    ///
    /// **Requires one video-track clip and one audio-track clip**
    /// ([`TimelineError::LinkKindMismatch`] otherwise) — order-independent
    /// (`(track_a, clip_a)` and `(track_b, clip_b)` may be given either way
    /// round). This is not Palmier's own validation (its tool description
    /// only says "different media types," which this crate reads as track
    /// kind, the only media-type signal a `Clip` carries) so much as what
    /// `Clip::link_group`'s own meaning on a video clip — "this clip's audio
    /// has been externalized to a linked clip" — requires to be a coherent
    /// fact: linking two video clips (or two audio clips) together would set
    /// that suppression flag with no linked audio clip on the other end of it
    /// for a video half, or would link two audio clips together for no
    /// operation here to give a real meaning to.
    ///
    /// Refused ([`TimelineError::TrackLocked`]) if either clip's own track is
    /// locked, and ([`TimelineError::LinkSameClip`]) for the same `(track,
    /// clip)` location given twice. **Not** gated by the same-position check
    /// `unlink` skips for a group's OTHER members — both locations here are
    /// directly named by the caller, unlike unlink's incidentally-swept-up
    /// siblings, so both are checked, matching `move_clip`'s own "either
    /// `from_track` or `to_track` locked" reasoning for a two-track op.
    ///
    /// The new group id is derived from both clips' own stable ids
    /// (`format!("lg-{video_id}-{audio_id}")`) rather than a random or
    /// wall-clock-derived one — this crate has no id-generation dependency
    /// (see the module doc: callers set `Clip::id` themselves) and a value
    /// derived purely from its own inputs keeps `link` a plain, deterministic
    /// function like every other op here, trivially testable without a clock
    /// or an injected RNG.
    pub fn link(&mut self, a: (usize, usize), b: (usize, usize)) -> Result<String, TimelineError> {
        if a == b {
            return Err(TimelineError::LinkSameClip);
        }
        for (track, clip) in [a, b] {
            let t = self
                .tracks
                .get(track)
                .ok_or(TimelineError::NoSuchTrack(track))?;
            if t.locked {
                return Err(TimelineError::TrackLocked(track));
            }
            let c = t
                .clips
                .get(clip)
                .ok_or(TimelineError::NoSuchClip(clip, track))?;
            if c.link_group.is_some() {
                return Err(TimelineError::AlreadyLinked(c.id.clone()));
            }
        }
        let (a_track, a_clip) = a;
        let (b_track, b_clip) = b;
        let a_kind = self.tracks[a_track].kind;
        let b_kind = self.tracks[b_track].kind;
        if a_kind == b_kind {
            return Err(TimelineError::LinkKindMismatch);
        }
        // Order the id components video-then-audio regardless of which of
        // `a`/`b` the caller passed as which, so `link(x, y)` and `link(y,
        // x)` produce the same group id — the op is genuinely
        // order-independent, and a group id shouldn't silently depend on
        // argument order.
        let (video_track, video_clip, audio_track, audio_clip) = if a_kind == TrackKind::Video {
            (a_track, a_clip, b_track, b_clip)
        } else {
            (b_track, b_clip, a_track, a_clip)
        };
        let video_id = self.tracks[video_track].clips[video_clip].id.clone();
        let audio_id = self.tracks[audio_track].clips[audio_clip].id.clone();
        let group = format!("lg-{video_id}-{audio_id}");
        self.tracks[video_track].clips[video_clip].link_group = Some(group.clone());
        self.tracks[audio_track].clips[audio_clip].link_group = Some(group.clone());
        Ok(group)
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
        let sync_straddles = overlaps
            && ripple
            && has_straddling_sync_locked_clip(&self.tracks, to_track, to_start_frame);
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
    ///
    /// B-079 — `fps` is the project's own [`Timeline::fps`]: a clip's real
    /// timeline footprint depends on its own `source_fps` against that rate
    /// ([`Clip::end_frame_at`]), not the fps-naive [`Clip::end_frame`] this
    /// used before the fix (identical result whenever every clip's native
    /// rate matches the project's — the common case — so this is a strict
    /// widening).
    pub fn duration(&self, fps: f64) -> i64 {
        self.clips
            .iter()
            .map(|c| c.end_frame_at(fps))
            .max()
            .unwrap_or(0)
    }

    /// The clip covering `timeline_frame` and the matching **source** frame
    /// inside it. `None` if the position is negative, past every clip's end,
    /// or (D-054) lands inside a gap between clips — the same "nothing here"
    /// result for all three, which is what every caller (the preview decode
    /// path) already treats identically.
    ///
    /// B-079 — `fps` (the project's own [`Timeline::fps`]) makes both halves
    /// of this fps-aware: the boundary check uses [`Clip::end_frame_at`], and
    /// the returned source frame converts the TIMELINE-frame offset into the
    /// clip's own SOURCE frames via [`timeline_frames_to_source`], instead of
    /// the pre-fix `source_start + (timeline_frame - start_frame)` raw
    /// addition (only correct when a clip's native rate equals the
    /// project's). Every real call site (`chroma::edit`'s video decode,
    /// `chroma::audio`'s audio-clip lookup) already has a `Timeline` in
    /// scope to read `fps` from.
    pub fn clip_at(&self, timeline_frame: i64, fps: f64) -> Option<(&Clip, i64)> {
        if timeline_frame < 0 {
            return None;
        }
        self.clips
            .iter()
            .find(|c| timeline_frame >= c.start_frame && timeline_frame < c.end_frame_at(fps))
            // D-226 — the arithmetic moved to `Clip::source_frame_at`, which a
            // transition's handle lookup also needs (unbounded by this
            // method's own window check). Byte-identical result here.
            .map(|c| (c, c.source_frame_at(timeline_frame, fps)))
    }

    /// D-226 — append everything this track contributes at TIMELINE frame
    /// `pos` to `out`, **topmost first** (the same ordering
    /// [`Timeline::resolve_visible_video_layers_at`] uses across tracks, so a
    /// caller painting the flat list in reverse needs no per-track special
    /// case).
    ///
    /// Three cases, and only the first one existed before transitions:
    ///
    /// 1. **No transition covering `pos`** — at most one layer, exactly
    ///    [`Self::clip_at`]'s answer at full alpha. Byte-identical to the
    ///    pre-D-226 behaviour for every project that has no transitions.
    /// 2. **[`TransitionKind::DipToColor`]** — the plate on top (alpha
    ///    [`Transition::dip_alpha_at`]) and, underneath it, the ordinary
    ///    `clip_at` layer. Needs no handle media and no second decode: the clip
    ///    below is simply whichever one is naturally there, and the plate is
    ///    fully opaque at the instant the two swap.
    /// 3. **[`TransitionKind::CrossDissolve`]** — the INCOMING clip on top at
    ///    alpha `p` over the still-opaque OUTGOING clip, so the picture is
    ///    `p·incoming + (1-p)·outgoing` under ordinary source-over compositing.
    ///    Whichever of the two is outside its own window at `pos` is read at its
    ///    **handle** frame via [`Clip::clamped_source_frame_at`].
    ///
    /// A transition missing one of its two clips (dangling after a trim or a
    /// delete) degrades to case 1 rather than erroring — same "gap = nothing
    /// here, not an error" contract every resolver in this crate has.
    pub fn push_layers_at<'a>(
        &'a self,
        track: usize,
        pos: i64,
        fps: f64,
        out: &mut Vec<VisibleLayer<'a>>,
    ) {
        let primary = self.clip_at(pos, fps);
        let plain = |c: &'a Clip, sf: i64| VisibleLayer {
            track,
            source: LayerSource::Clip {
                clip: c,
                source_frame: sf,
                role: LayerRole::Primary,
            },
            alpha: 1.0,
        };

        let Some(transition) = self.transition_at(pos) else {
            if let Some((c, sf)) = primary {
                out.push(plain(c, sf));
            }
            return;
        };

        match transition.kind {
            TransitionKind::DipToColor => {
                out.push(VisibleLayer {
                    track,
                    source: LayerSource::Color {
                        rgb: transition.rgb(),
                    },
                    alpha: transition.dip_alpha_at(pos),
                });
                if let Some((c, sf)) = primary {
                    out.push(plain(c, sf));
                }
            }
            TransitionKind::CrossDissolve => {
                let (outgoing, incoming) = self.transition_clips(transition.at_frame, fps);
                let (Some(outgoing), Some(incoming)) = (outgoing, incoming) else {
                    // Dangling — one side was trimmed or deleted out from under
                    // it. Nothing to blend against, so render the cut plainly.
                    if let Some((c, sf)) = primary {
                        out.push(plain(c, sf));
                    }
                    return;
                };
                out.push(VisibleLayer {
                    track,
                    source: LayerSource::Clip {
                        clip: incoming,
                        source_frame: incoming.clamped_source_frame_at(pos, fps),
                        role: LayerRole::TransitionPartner,
                    },
                    alpha: transition.progress_at(pos),
                });
                out.push(VisibleLayer {
                    track,
                    source: LayerSource::Clip {
                        clip: outgoing,
                        source_frame: outgoing.clamped_source_frame_at(pos, fps),
                        role: LayerRole::Primary,
                    },
                    alpha: 1.0,
                });
            }
        }
    }

    /// D-226 — the [`Transition`] on this track whose window covers
    /// `timeline_frame`, if any.
    ///
    /// First match in stored order, not "the best" one: `checkTransition`
    /// (`@chroma/editor`) refuses to write two transitions whose windows
    /// overlap, so at most one can legitimately cover a frame. Picking the
    /// first deterministically is the safe degrade for a document that got
    /// there anyway — the same "walk a `Vec` in its stored order every time, no
    /// hidden iteration-order dependency" discipline
    /// [`Timeline::resolve_video_clip_at`] already states.
    pub fn transition_at(&self, timeline_frame: i64) -> Option<&Transition> {
        self.transitions.iter().find(|t| t.covers(timeline_frame))
    }

    /// D-226 — the two clips a transition at `at_frame` joins: the one whose
    /// exclusive end IS that frame (outgoing) and the one whose `start_frame`
    /// is (incoming). Either may be absent — a transition left dangling by a
    /// later trim/delete is a real, reachable state, and every consumer degrades
    /// rather than erroring on it.
    ///
    /// Matched on **exact** frame equality, which is the same fact `at_frame`'s
    /// own doc states the field means. A cut that has drifted (one side
    /// trimmed) therefore stops resolving that side, which is the correct
    /// outcome: there is no longer an edit point there to blend across.
    pub fn transition_clips(&self, at_frame: i64, fps: f64) -> (Option<&Clip>, Option<&Clip>) {
        (
            self.clips.iter().find(|c| c.end_frame_at(fps) == at_frame),
            self.clips.iter().find(|c| c.start_frame == at_frame),
        )
    }

    /// D-149 — the `[start, end)` timeline-frame spans this track's clips
    /// cover from `from_frame` onward, **sorted and merged**, each clipped so
    /// it starts no earlier than `from_frame`.
    ///
    /// This is the ducking trigger signal in its model form: "when does this
    /// track have something on it." [`Self::clip_at`] answers that for one
    /// frame; a duck envelope needs the whole layout ahead of the playhead in
    /// one query, because it is computed up front at play time (see
    /// `docs/notes/audio-fade-duck-crossfade-plan.md` §4b) rather than sampled
    /// frame by frame during the session.
    ///
    /// **Merging abutting spans is the load-bearing part, not tidiness.** Two
    /// dialogue clips butted end to start are one continuous stretch of speech;
    /// leaving them as two spans would put a zero-length hole between them, and
    /// a ducker reading that hole starts releasing and re-attacking at every
    /// cut — an audible pump exactly where an editor most expects the duck to
    /// hold. D-104 forbids overlap, so merging is only ever about abutment, but
    /// the `>=` below handles a stored overlap safely too rather than assuming
    /// the invariant.
    ///
    /// Clips are walked in **value** order, not `Vec` order (D-054: `Vec` order
    /// is bookkeeping only) — same discipline [`Self::clip_at`] and
    /// [`Self::gap_at`] already follow. Zero-or-negative-length clips are
    /// skipped: they cover no frame, so they trigger nothing.
    ///
    /// B-079 — `fps` (the project's own [`Timeline::fps`]) routes the end
    /// bound through [`Clip::end_frame_at`] rather than the fps-naive
    /// [`Clip::end_frame`]: a duck trigger span for a mixed-native-fps clip
    /// used to end at the wrong timeline frame, early or late depending on
    /// whether its native rate is faster or slower than the project's.
    pub fn clip_spans_from(&self, from_frame: i64, fps: f64) -> Vec<(i64, i64)> {
        let mut spans: Vec<(i64, i64)> = self
            .clips
            .iter()
            .map(|c| (c.start_frame.max(from_frame), c.end_frame_at(fps)))
            .filter(|(s, e)| e > s)
            .collect();
        spans.sort_unstable();
        let mut merged: Vec<(i64, i64)> = Vec::with_capacity(spans.len());
        for (s, e) in spans {
            match merged.last_mut() {
                Some(last) if s <= last.1 => last.1 = last.1.max(e),
                _ => merged.push((s, e)),
            }
        }
        merged
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
        // B-079 — deliberately fps-naive, paired with the plain
        // `Clip::end_frame` this function already uses below (not
        // `self.clip_at`, which takes an `fps` argument as of B-079's fix):
        // `remove_gap` (this method's only caller) is one of this crate's
        // confirmed-unreachable-from-the-running-app editing ops, so it stays
        // exactly as it always has rather than inventing an `fps` value
        // nothing real can supply it. See `Clip::end_frame`'s own doc.
        let in_a_clip = self
            .clips
            .iter()
            .any(|c| timeline_frame >= c.start_frame && timeline_frame < c.end_frame());
        if timeline_frame < 0 || in_a_clip {
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

    /// B-077 — `source_fps` must survive a real `chroma_timeline_set`/`_get`
    /// round trip (Tauri deserializes a command's JSON argument straight into
    /// `Timeline`/`Clip` — an undeclared field is silently dropped by serde's
    /// default "ignore unknown keys" behavior, which would have re-broken
    /// B-075/B-077 on the very first save after this pass: `@chroma/editor`
    /// sets `source_fps` at clip-creation time, but every edit afterwards
    /// goes through `chroma_timeline_set` before the next `chroma_timeline_
    /// get` — if the field vanished there, the fix would only ever hold for
    /// the single in-memory session before the first save/reload). Also
    /// confirms `None` (absent — a pre-B-075 clip, or one whose source was
    /// never probed) round-trips as an absent JSON key, not a literal `null`.
    #[test]
    fn source_fps_round_trips_through_serde() {
        let mut t = Timeline::from_shots(&shots());
        t.tracks[0].clips[0].source_fps = Some(44.128089105464674);
        let json = serde_json::to_string(&t).unwrap();
        assert!(
            json.contains("44.128089105464674"),
            "source_fps must actually be serialized, not skipped: {json}"
        );
        let back: Timeline = serde_json::from_str(&json).unwrap();
        assert_eq!(back.tracks[0].clips[0].source_fps, Some(44.128089105464674));
        // The clip after it never had `source_fps` set — stays `None`, and
        // (unlike `start_frame`'s migration sentinel) is never even written
        // to the JSON in the first place (`skip_serializing_if`).
        assert_eq!(back.tracks[0].clips[1].source_fps, None);
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
            tr.clip_at(0, 24.0).map(|(c, f)| (c.name.as_str(), f)),
            Some(("A", 0))
        );
        assert_eq!(
            tr.clip_at(99, 24.0).map(|(c, f)| (c.name.as_str(), f)),
            Some(("A", 99))
        );
        assert_eq!(
            tr.clip_at(100, 24.0).map(|(c, f)| (c.name.as_str(), f)),
            Some(("B", 0))
        );
        assert_eq!(
            tr.clip_at(149, 24.0).map(|(c, f)| (c.name.as_str(), f)),
            Some(("B", 49))
        );
        assert_eq!(
            tr.clip_at(150, 24.0).map(|(c, f)| (c.name.as_str(), f)),
            Some(("C", 0))
        );
        assert_eq!(
            tr.clip_at(349, 24.0).map(|(c, f)| (c.name.as_str(), f)),
            Some(("C", 199))
        );
        assert!(tr.clip_at(350, 24.0).is_none());
        assert!(tr.clip_at(-1, 24.0).is_none());
    }

    /// D-054: a query landing inside a gap between two clips returns `None`,
    /// same as past-the-end — never panics, never returns the wrong clip.
    #[test]
    fn clip_at_inside_a_gap_is_none() {
        let mut t = Timeline::default();
        t.tracks.push(Track {
            kind: TrackKind::Video,
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
            ..Default::default()
        });
        let tr = &t.tracks[0];
        assert_eq!(
            tr.clip_at(49, 24.0).map(|(c, _)| c.name.as_str()),
            Some("A")
        );
        assert!(tr.clip_at(50, 24.0).is_none(), "right at the gap's start");
        assert!(tr.clip_at(75, 24.0).is_none(), "middle of the gap");
        assert!(tr.clip_at(99, 24.0).is_none(), "right before the gap ends");
        assert_eq!(
            tr.clip_at(100, 24.0).map(|(c, _)| c.name.as_str()),
            Some("B")
        );
        assert_eq!(
            t.duration(),
            150,
            "duration is the furthest clip end, gap included"
        );
    }

    // --- D-149: the ducking trigger signal, in its model form -------------- //

    /// A track holding clips at the given `(start, len)` positions —
    /// deliberately pushed in **reverse** `Vec` order, since D-054 makes `Vec`
    /// order bookkeeping only and `clip_spans_from` has to be correct
    /// regardless of it.
    fn track_with_clips(spans: &[(i64, i64)]) -> Track {
        Track {
            kind: TrackKind::Audio,
            clips: spans
                .iter()
                .rev()
                .enumerate()
                .map(|(i, &(start, len))| Clip {
                    id: format!("c{i}"),
                    name: format!("C{i}"),
                    source_path: "/c.wav".into(),
                    duration: len,
                    source_len: len,
                    start_frame: start,
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        }
    }

    #[test]
    fn clip_spans_from_returns_sorted_spans_regardless_of_vec_order() {
        let tr = track_with_clips(&[(0, 50), (100, 50), (200, 25)]);
        assert_eq!(
            tr.clip_spans_from(0, 24.0),
            vec![(0, 50), (100, 150), (200, 225)],
            "sorted by position, not by Vec order"
        );
    }

    /// **Abutting clips merge into one span**, which is what stops a ducker
    /// releasing and re-attacking at every cut inside a continuous take. Clips
    /// with a real gap between them stay separate, because that gap is real
    /// silence and the bed genuinely should come back up.
    #[test]
    fn clip_spans_from_merges_abutting_clips_but_not_gapped_ones() {
        let abutting = track_with_clips(&[(0, 50), (50, 50), (100, 50)]);
        assert_eq!(
            abutting.clip_spans_from(0, 24.0),
            vec![(0, 150)],
            "three back-to-back clips are one continuous stretch of sound"
        );
        let gapped = track_with_clips(&[(0, 50), (60, 50)]);
        assert_eq!(gapped.clip_spans_from(0, 24.0), vec![(0, 50), (60, 110)]);
    }

    #[test]
    fn clip_spans_from_clips_to_the_playhead_and_drops_what_is_behind_it() {
        let tr = track_with_clips(&[(0, 50), (100, 50)]);
        // Mid-clip: the span reaching back before the playhead is truncated,
        // which is what tells the envelope "already triggered when Play was
        // pressed" rather than "triggers at frame 25".
        assert_eq!(tr.clip_spans_from(25, 24.0), vec![(25, 50), (100, 150)]);
        // Entirely past the first clip: it contributes nothing.
        assert_eq!(tr.clip_spans_from(60, 24.0), vec![(100, 150)]);
        // Past everything.
        assert_eq!(tr.clip_spans_from(500, 24.0), Vec::new());
    }

    #[test]
    fn clip_spans_from_ignores_zero_length_clips_and_an_empty_track() {
        assert_eq!(track_with_clips(&[]).clip_spans_from(0, 24.0), Vec::new());
        assert_eq!(
            track_with_clips(&[(0, 0), (10, 20)]).clip_spans_from(0, 24.0),
            vec![(10, 30)],
            "a clip covering no frame triggers nothing"
        );
    }

    /// **The migration property, at the model.** A track deserialized from a
    /// project written before D-149 has no ducking at all — and the fields that
    /// were already there are untouched, including D-106's own non-zero
    /// migration default.
    #[test]
    fn a_pre_d148_track_deserializes_with_no_ducking() {
        let json = r#"{"kind":"audio","clips":[],"gain":0.5,"locked":false,"hidden":false}"#;
        let tr: Track = serde_json::from_str(json).expect("pre-D-149 track");
        assert_eq!(tr.duck_from, None, "absent means no ducking at all");
        assert_eq!(
            tr.duck_db, 0.0,
            "0 dB is unity — a bare serde default is genuinely right here"
        );
        assert_eq!(tr.duck_attack_ms, DEFAULT_DUCK_ATTACK_MS);
        assert_eq!(tr.duck_release_ms, DEFAULT_DUCK_RELEASE_MS);
        assert_eq!(tr.gain, 0.5, "the fields that were there are untouched");
        assert!(tr.sync_locked, "and D-106's migration default still holds");
    }

    /// `Track::default()` and a `Track` deserialized with none of the optional
    /// keys must agree field for field — the manual `Default` exists to mirror
    /// the serde defaults, so a drift between them is exactly the bug it is
    /// there to prevent.
    #[test]
    fn track_default_matches_the_serde_defaults() {
        let from_json: Track =
            serde_json::from_str(r#"{"kind":"video","clips":[]}"#).expect("bare track");
        let built = Track::default();
        assert_eq!(from_json.gain, built.gain);
        assert_eq!(from_json.locked, built.locked);
        assert_eq!(from_json.hidden, built.hidden);
        assert_eq!(from_json.sync_locked, built.sync_locked);
        assert_eq!(from_json.duck_from, built.duck_from);
        assert_eq!(from_json.duck_db, built.duck_db);
        assert_eq!(from_json.duck_attack_ms, built.duck_attack_ms);
        assert_eq!(from_json.duck_release_ms, built.duck_release_ms);
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
        assert_eq!(
            tr.clip_at(0, 24.0).map(|(c, _)| c.name.clone()),
            Some("A".into())
        );
        assert_eq!(
            tr.clip_at(150, 24.0).map(|(c, _)| c.name.clone()),
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
            t.tracks[0].clip_at(110, 24.0).is_none(),
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
            ..Default::default()
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
            t.tracks[0].clip_at(120, 24.0).is_none(),
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
        assert!(t.tracks[0].clip_at(50, 24.0).is_some(), "A untouched");
        assert!(
            t.tracks[0].clip_at(120, 24.0).is_some(),
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
        assert_eq!(
            a.start_frame, 0,
            "everything shifts left by the gap's 200 frames"
        );
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
        assert_eq!(
            t.tracks[1].clips.len(),
            1,
            "the overlapping move was rejected"
        );
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
        assert_eq!(
            starts,
            vec![200, 0],
            "B shifted to make room for C, not overlapped"
        );
        let durations: Vec<i64> = t.tracks[1].clips.iter().map(|c| c.duration).collect();
        assert_eq!(
            durations,
            vec![50, 200],
            "only start_frame moved, durations untouched"
        );

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
        assert_eq!(
            by_name["C"], 250,
            "C rippled later too, still after B's new start"
        );
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
        assert_eq!(
            t.tracks[1].clips.len(),
            1,
            "the straddling ripple attempt was rejected, nothing moved"
        );
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
            t.tracks[0].clip_at(0, 24.0).is_none(),
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
        assert_eq!(
            t.move_clip(9, 0, 0, 0, false),
            Err(TimelineError::NoSuchTrack(9))
        );
        assert_eq!(
            t.move_clip(0, 9, 0, 0, false),
            Err(TimelineError::NoSuchClip(9, 0))
        );
        assert_eq!(
            t.move_clip(0, 0, 9, 0, false),
            Err(TimelineError::NoSuchTrack(9))
        );
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
        assert_eq!(
            t.tracks.len(),
            2,
            "moving one of three clips off does not prune"
        );
        t.remove(0, 0).unwrap(); // remove B (now index 0 on track 0)
        t.remove(0, 0).unwrap(); // remove C — track 0 now has zero clips
        assert_eq!(t.tracks.len(), 1, "the now-empty track 0 was pruned");
        assert_eq!(
            t.tracks[0].clips[0].name, "A",
            "surviving track renumbers to index 0"
        );
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
        assert_eq!(
            t.tracks.len(),
            2,
            "the unrelated empty track survives — only the directly-edited track prunes"
        );
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
        assert_eq!(
            t.tracks.len(),
            1,
            "source track pruned once it lost its last clip"
        );
        assert_eq!(
            t.tracks[0].clips.len(),
            3,
            "all three landed on the surviving track"
        );
    }

    #[test]
    fn move_clip_same_track_never_prunes() {
        let mut t = Timeline::from_shots(&shots());
        t.move_clip(0, 0, 0, 1000, false).unwrap(); // reposition within the same track
        assert_eq!(
            t.tracks.len(),
            1,
            "clip count on the track is unchanged by a same-track move"
        );
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
            let via_track = t.tracks[0]
                .clip_at(pos, 24.0)
                .map(|(c, sf)| (c.name.clone(), sf));
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

    // ---- D-222: timeline markers -----------------------------------------

    /// The backward-compatibility guarantee `Timeline::markers`'s
    /// `#[serde(default)]` exists for: a `project.json` written before D-222
    /// has no `markers` key at all, and must load as a timeline with NO
    /// markers rather than as a hard deserialization error.
    #[test]
    fn timeline_markers_default_to_empty_on_pre_d222_json() {
        let j = r#"{"id":"t1","name":"Timeline 1","rate":null,"tracks":[]}"#;
        let tl: Timeline = serde_json::from_str(j).expect("pre-D-222 JSON must still load");
        assert!(tl.markers.is_empty());
        assert_eq!(tl.id, "t1");
    }

    /// …including a pre-D-222 timeline that has real content on it, so the
    /// default cannot be passing only because everything else was empty too.
    #[test]
    fn timeline_markers_default_to_empty_alongside_real_tracks() {
        let j = r#"{"id":"t1","name":"T","rate":{"num":24,"den":1},"tracks":[
            {"kind":"video","clips":[{"id":"c1","name":"A","source_path":"/a.mov",
             "source_start":0,"duration":40,"source_len":40,"start_frame":0}]}]}"#;
        let tl: Timeline = serde_json::from_str(j).expect("pre-D-222 JSON must still load");
        assert!(tl.markers.is_empty());
        assert_eq!(tl.tracks.len(), 1);
        assert_eq!(tl.tracks[0].clips.len(), 1);
    }

    /// A marker round-trips verbatim, and an absent `name`/`note` is omitted
    /// from the wire rather than written as `null` — `Clip::shot_id`'s own
    /// `skip_serializing_if` convention, applied to the same shape of field.
    #[test]
    fn timeline_markers_round_trip_through_serde() {
        let tl = Timeline {
            id: "t1".into(),
            name: "T".into(),
            rate: None,
            tracks: Vec::new(),
            markers: vec![
                Marker {
                    id: "m1".into(),
                    frame: 120,
                    color: "#D9434E".into(),
                    name: Some("cut here".into()),
                    note: Some("client note".into()),
                },
                Marker {
                    id: "m2".into(),
                    frame: 5,
                    color: "#3B8FE3".into(),
                    name: None,
                    note: None,
                },
            ],
        };
        let json = serde_json::to_string(&tl).unwrap();
        assert!(json.contains("\"frame\":120"), "{json}");
        assert!(json.contains("\"name\":\"cut here\""), "{json}");
        let back: Timeline = serde_json::from_str(&json).unwrap();
        assert_eq!(back.markers, tl.markers);

        let m2_json = serde_json::to_string(&tl.markers[1]).unwrap();
        assert!(
            !m2_json.contains("name") && !m2_json.contains("note"),
            "an unnamed marker omits both optional keys entirely: {m2_json}"
        );
    }

    /// The list is stored in whatever order it is handed — this crate does no
    /// sorting of its own (`chroma_timeline_set` stores verbatim; the ordering
    /// contract lives in `@chroma/editor`'s `applyOp`, see `markersOf`). Pinned
    /// so a future "helpfully sort on load" change has to be a deliberate one.
    #[test]
    fn timeline_markers_preserve_wire_order() {
        // `r##"…"##`, not `r#"…"#` — a `#RRGGBB` colour followed by a quote
        // would otherwise close a single-hash raw string early.
        let j = r##"{"id":"t","name":"T","rate":null,"tracks":[],"markers":[
            {"id":"b","frame":90,"color":"#111111"},
            {"id":"a","frame":10,"color":"#222222"}]}"##;
        let tl: Timeline = serde_json::from_str(j).unwrap();
        assert_eq!(
            tl.markers.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["b", "a"]
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
        assert!(
            t.tracks[0]
                .clips
                .iter()
                .all(|c| c.opacity == 1.0 && c.scale == 1.0)
        );
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
        assert_eq!(
            (c.crop_left, c.crop_top, c.crop_right, c.crop_bottom),
            (0.0, 0.0, 0.0, 0.0)
        );
    }

    /// `Clip::default()` (the `..Default::default()` every construction site
    /// in this crate uses) is uncropped too — the same "a manual `Default`
    /// impl must be checked separately from serde's" point
    /// `clip_default_is_fully_opaque_and_unscaled` makes for `opacity`/
    /// `scale`, which is exactly how those two were nearly shipped wrong.
    #[test]
    fn clip_default_is_uncropped() {
        let c = Clip::default();
        assert_eq!(
            (c.crop_left, c.crop_top, c.crop_right, c.crop_bottom),
            (0.0, 0.0, 0.0, 0.0)
        );
        assert!(
            Timeline::from_shots(&shots()).tracks[0]
                .clips
                .iter()
                .all(|c| c.crop_left == 0.0 && c.crop_bottom == 0.0)
        );
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
        assert_eq!(
            (c.crop_left, c.crop_top, c.crop_right, c.crop_bottom),
            (0.25, 0.1, 0.5, 0.0)
        );
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

    // -----------------------------------------------------------------
    // D-223: per-clip audio level (`volume` linear, `pan` normalised).
    // -----------------------------------------------------------------

    /// The migration case, and the reason `volume` gets a NAMED serde default
    /// while `pan` gets the bare one: a pre-D-223 `project.json` clip has
    /// neither key, and must load at **unity, centred** — `f64::default()` for
    /// `volume` would be `0.0`, i.e. every existing project silently muted.
    #[test]
    fn clip_json_without_audio_fields_loads_at_unity_centre() {
        let json = r#"{"id":"a","name":"A","source_path":"/a.mov","source_start":0,"duration":10,"source_len":10,"start_frame":0,"opacity":1.0,"position_x":0.0,"position_y":0.0,"scale":1.0,"rotation":0.0}"#;
        let c: Clip = serde_json::from_str(json).unwrap();
        assert_eq!((c.volume, c.pan), (1.0, 0.0));
        // …and that pair really is the audible identity, not merely the
        // documented one (the property the whole migration rests on).
        assert_eq!(chroma_types::pan_gains(c.pan), (1.0, 1.0));
        assert_eq!(chroma_types::clip_volume(c.volume), 1.0);
    }

    /// `Clip::default()` — the manual impl, which serde's own defaults do NOT
    /// cover (the same separate-mechanism point `clip_default_is_uncropped`
    /// makes, and the exact way `opacity`/`scale` were nearly shipped at 0).
    #[test]
    fn clip_default_is_unity_volume_and_centred() {
        let c = Clip::default();
        assert_eq!((c.volume, c.pan), (1.0, 0.0));
        assert!(
            Timeline::from_shots(&shots()).tracks[0]
                .clips
                .iter()
                .all(|c| c.volume == 1.0 && c.pan == 0.0)
        );
    }

    /// A real level survives a full `Timeline` → JSON → `Timeline` round trip
    /// — what `chroma_timeline_set` (verbatim storage) then
    /// `chroma_timeline_get` does to every Inspector edit.
    #[test]
    fn clip_volume_and_pan_round_trip_through_a_whole_timeline() {
        let mut t = Timeline::from_shots(&shots());
        t.tracks[0].clips[0].volume = 0.5;
        t.tracks[0].clips[0].pan = -1.0;
        let json = serde_json::to_string(&t).unwrap();
        let back: Timeline = serde_json::from_str(&json).unwrap();
        let c = &back.tracks[0].clips[0];
        assert_eq!((c.volume, c.pan), (0.5, -1.0));
        let untouched = &back.tracks[0].clips[1];
        assert_eq!((untouched.volume, untouched.pan), (1.0, 0.0));
    }

    /// Per-clip level is an *appearance*-class value like crop, not a timing
    /// one: `split` hands both halves the same volume and pan. Guards against
    /// a future op that rebuilds a `Clip` field-by-field and quietly drops it.
    #[test]
    fn split_preserves_clip_volume_and_pan_on_both_halves() {
        let mut t = Timeline::from_shots(&shots());
        t.tracks[0].clips[1].volume = 0.25;
        t.tracks[0].clips[1].pan = 0.75;
        t.split(0, 1, 120).unwrap();
        for i in [1usize, 2] {
            assert_eq!(t.tracks[0].clips[i].volume, 0.25);
            assert_eq!(t.tracks[0].clips[i].pan, 0.75);
        }
    }

    // -----------------------------------------------------------------
    // D-224: per-clip parametric EQ (`eq_bands`).
    // -----------------------------------------------------------------

    /// The migration case, and the reason `eq_bands` needs no named default at
    /// all where `volume` did: a pre-D-224 `project.json` clip has no key, and
    /// `Vec::default()` — empty — genuinely IS "no EQ".
    #[test]
    fn clip_json_without_eq_loads_with_no_bands_and_no_filtering() {
        let json = r#"{"id":"a","name":"A","source_path":"/a.mov","source_start":0,"duration":10,"source_len":10,"start_frame":0,"opacity":1.0,"position_x":0.0,"position_y":0.0,"scale":1.0,"rotation":0.0}"#;
        let c: Clip = serde_json::from_str(json).unwrap();
        assert!(c.eq_bands.is_empty());
        assert!(!c.has_active_eq());
        assert!(Clip::default().eq_bands.is_empty());
    }

    /// The other half of "free when unused": a clip carrying the Inspector's
    /// materialised four-band strip, untouched, is still exactly as silent a
    /// change as no EQ at all — because every band of that strip is a
    /// gain-using kind sitting at 0 dB.
    #[test]
    fn a_materialised_but_untouched_band_strip_is_not_active_eq() {
        let mut c = Clip {
            eq_bands: vec![
                EqBand {
                    kind: EqBandKind::LowShelf,
                    freq_hz: 120.0,
                    gain_db: 0.0,
                    q: 0.707,
                    enabled: true,
                },
                EqBand {
                    kind: EqBandKind::Peak,
                    freq_hz: 2_500.0,
                    gain_db: 0.0,
                    q: 1.0,
                    enabled: true,
                },
            ],
            ..Clip::default()
        };
        assert!(!c.has_active_eq());
        c.eq_bands[1].gain_db = -3.0;
        assert!(c.has_active_eq());
    }

    /// A real band set survives a full `Timeline` → JSON → `Timeline` round
    /// trip, and an EQ-less clip beside it still serialises no key at all
    /// (`skip_serializing_if`), which is what keeps existing projects
    /// byte-identical on the next save.
    #[test]
    fn clip_eq_bands_round_trip_and_an_empty_set_writes_no_key() {
        let mut t = Timeline::from_shots(&shots());
        t.tracks[0].clips[0].eq_bands = vec![EqBand {
            kind: EqBandKind::HighPass,
            freq_hz: 85.0,
            gain_db: 0.0,
            q: 0.9,
            enabled: true,
        }];
        let json = serde_json::to_string(&t).unwrap();
        assert_eq!(json.matches("eq_bands").count(), 1, "only the one clip");
        let back: Timeline = serde_json::from_str(&json).unwrap();
        assert_eq!(back.tracks[0].clips[0].eq_bands.len(), 1);
        assert_eq!(
            back.tracks[0].clips[0].eq_bands[0].kind,
            EqBandKind::HighPass
        );
        assert_eq!(back.tracks[0].clips[0].eq_bands[0].freq_hz, 85.0);
        assert!(back.tracks[0].clips[1].eq_bands.is_empty());
    }

    /// An EQ is an *appearance*-class value like crop and volume, not a timing
    /// one: `split` hands both halves the same bands. Same guard
    /// `split_preserves_clip_volume_and_pan_on_both_halves` sets, against a
    /// future op that rebuilds a `Clip` field-by-field and drops this one.
    #[test]
    fn split_preserves_clip_eq_on_both_halves() {
        let mut t = Timeline::from_shots(&shots());
        let band = EqBand {
            kind: EqBandKind::Peak,
            freq_hz: 350.0,
            gain_db: -4.5,
            q: 2.2,
            enabled: true,
        };
        t.tracks[0].clips[1].eq_bands = vec![band];
        t.split(0, 1, 120).unwrap();
        for i in [1usize, 2] {
            assert_eq!(t.tracks[0].clips[i].eq_bands, vec![band]);
        }
    }

    // -----------------------------------------------------------------
    // D-136: `position_x`/`position_y` become normalised (Phase 0a of
    // `docs/notes/on-canvas-transform.md`, closes B-043).
    // -----------------------------------------------------------------

    /// The real migration case: a `project.json` clip written before D-136
    /// carries absolute pixel positions, is loaded by serde exactly as it
    /// always was (nothing about the *shape* changed — which is precisely why
    /// this needs a version gate rather than a serde default), and comes out
    /// of `normalise_legacy_positions` as the documented reinterpretation —
    /// the stored number read as composition pixels. Then it round-trips back
    /// through JSON in the new unit.
    #[test]
    fn a_pre_migration_clip_loads_and_normalises_against_the_composition() {
        let json = r#"{"id":"tl","name":"T","tracks":[{"kind":"video","clips":[
            {"id":"a","name":"A","source_path":"/a.mov","source_start":0,"duration":10,
             "source_len":10,"start_frame":0,"opacity":1.0,
             "position_x":480.0,"position_y":-270.0,"scale":0.5,"rotation":0.0}
        ],"gain":1.0,"locked":false,"hidden":false,"sync_locked":true}]}"#;
        let mut tl: Timeline = serde_json::from_str(json).unwrap();
        // loaded verbatim first — the old unit, untouched
        assert_eq!(tl.tracks[0].clips[0].position_x, 480.0);

        tl.normalise_legacy_positions(1920.0, 1080.0);
        let c = &tl.tracks[0].clips[0];
        assert_eq!(c.position_x, 0.25); // 480 px of 1920 → a quarter frame right
        assert_eq!(c.position_y, -0.25); // 270 px of 1080 → a quarter frame up
        assert_eq!(c.scale, 0.5, "scale is not touched by this migration");

        // and the new value is what persists
        let back: Timeline = serde_json::from_str(&serde_json::to_string(&tl).unwrap()).unwrap();
        assert_eq!(back.tracks[0].clips[0].position_x, 0.25);
        assert_eq!(back.tracks[0].clips[0].position_y, -0.25);
    }

    /// The overwhelmingly common case, and the reason this migration is safe
    /// to run across every existing project: a clip nobody ever offset is at
    /// `0.0`, and `0.0` divided by any composition is still exactly `0.0`. No
    /// project that never used a PIP offset shifts by a pixel.
    #[test]
    fn migrating_an_unoffset_clip_changes_nothing() {
        let mut tl = Timeline::from_shots(&shots());
        tl.normalise_legacy_positions(3840.0, 2160.0);
        assert!(
            tl.tracks[0]
                .clips
                .iter()
                .all(|c| c.position_x == 0.0 && c.position_y == 0.0)
        );
    }

    /// Keyframed positions are in the same old unit and must migrate with the
    /// static fields — otherwise the interpolator would immediately override
    /// a migrated base value with un-migrated keys, making a keyframed PIP the
    /// one case the migration made worse. Params this clip doesn't animate are
    /// left exactly as they are.
    #[test]
    fn migration_normalises_position_keyframes_too() {
        let mut tl = Timeline::from_shots(&shots());
        tl.tracks[0].clips[0].position_x = 192.0;
        tl.tracks[0].clips[0].chroma_keyframes = Some(serde_json::json!([
            { "frame": 0, "params": { "position_x": 0.0, "position_y": 108.0, "opacity": 1.0 } },
            { "frame": 24, "params": { "position_x": 960.0, "scale": 2.0 } },
        ]));
        tl.normalise_legacy_positions(1920.0, 1080.0);

        let c = &tl.tracks[0].clips[0];
        assert_eq!(c.position_x, 0.1);
        let keys = c.chroma_keyframes.as_ref().unwrap().as_array().unwrap();
        assert_eq!(keys[0]["params"]["position_x"].as_f64().unwrap(), 0.0);
        assert_eq!(keys[0]["params"]["position_y"].as_f64().unwrap(), 0.1);
        assert_eq!(keys[0]["params"]["opacity"].as_f64().unwrap(), 1.0);
        assert_eq!(keys[1]["params"]["position_x"].as_f64().unwrap(), 0.5);
        assert_eq!(keys[1]["params"]["scale"].as_f64().unwrap(), 2.0);
    }

    /// A degenerate composition size is a no-op, not an infinity written into
    /// the project file — the migration runs on load, before anything has
    /// validated the settings it was handed.
    #[test]
    fn migration_refuses_a_degenerate_composition() {
        let mut tl = Timeline::from_shots(&shots());
        tl.tracks[0].clips[0].position_x = 200.0;
        for (w, h) in [
            (0.0, 1080.0),
            (1920.0, 0.0),
            (-1.0, -1.0),
            (f64::NAN, 1080.0),
        ] {
            tl.normalise_legacy_positions(w, h);
            assert_eq!(tl.tracks[0].clips[0].position_x, 200.0);
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

    /// D-226 — the clip behind a [`VisibleLayer`], for tests that only care
    /// about which clip resolved. Panics for a generated colour plate, which is
    /// the right failure for a test that did not expect one.
    fn layer_clip<'a>(l: &VisibleLayer<'a>) -> &'a Clip {
        match l.source {
            LayerSource::Clip { clip, .. } => clip,
            LayerSource::Color { .. } => panic!("expected a clip layer, got a colour plate"),
        }
    }

    /// D-226 — the resolved SOURCE frame behind a [`VisibleLayer`]. Same
    /// panic-on-a-plate contract as [`layer_clip`].
    fn layer_source_frame(l: &VisibleLayer<'_>) -> i64 {
        match l.source {
            LayerSource::Clip { source_frame, .. } => source_frame,
            LayerSource::Color { .. } => panic!("expected a clip layer, got a colour plate"),
        }
    }

    #[test]
    fn resolve_visible_video_layers_at_returns_every_track_with_content_not_just_the_top() {
        let t = two_video_track_timeline(); // track0: A[0,100); track1: B[0,50) C[100,300)
        // frame 10: both tracks have content.
        let layers = t.resolve_visible_video_layers_at(10);
        assert_eq!(layers.len(), 2);
        assert_eq!(layers[0].track, 0);
        assert_eq!(layer_clip(&layers[0]).name, "A");
        assert_eq!(layers[1].track, 1);
        assert_eq!(layer_clip(&layers[1]).name, "B");
        assert!(
            layers.iter().all(|l| l.alpha == 1.0),
            "no transition — every layer is fully opaque, exactly as before D-226"
        );
    }

    #[test]
    fn resolve_visible_video_layers_at_omits_a_track_with_a_gap_there() {
        let t = two_video_track_timeline();
        // frame 60: track0 has A still; track1's B ended at 50, C starts at 100 — a gap.
        let layers = t.resolve_visible_video_layers_at(60);
        assert_eq!(layers.len(), 1);
        assert_eq!(layers[0].track, 0);
    }

    #[test]
    fn resolve_visible_video_layers_at_excludes_a_hidden_track_even_with_content() {
        let mut t = two_video_track_timeline();
        t.tracks[1].hidden = true;
        let layers = t.resolve_visible_video_layers_at(10);
        assert_eq!(layers.len(), 1);
        assert_eq!(layers[0].track, 0);
    }

    #[test]
    fn resolve_visible_video_layers_at_three_tracks_returns_all_that_overlap() {
        let t = three_video_track_timeline(); // track0[0,50) track1[0,30) track2[0,200+)
        let layers = t.resolve_visible_video_layers_at(10);
        assert_eq!(layers.len(), 3);
        assert_eq!(
            layers.iter().map(|l| l.track).collect::<Vec<_>>(),
            vec![0, 1, 2]
        );
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
        assert_eq!(
            t.move_clip(0, 0, 1, 200, false),
            Err(TimelineError::TrackLocked(0))
        );
    }

    #[test]
    fn move_clip_refuses_when_the_destination_track_is_locked() {
        let mut t = two_video_track_timeline();
        t.tracks[1].locked = true;
        assert_eq!(
            t.move_clip(0, 0, 1, 200, false),
            Err(TimelineError::TrackLocked(1))
        );
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
            ..Default::default()
        };
        Timeline {
            id: "t".into(),
            name: "t".into(),
            rate: None,
            tracks: vec![mk(track0), mk(track1)],
            markers: Vec::new(),
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
        assert!(
            t.sync_locked,
            "a track with no sync_locked key defaults ON, matching Resolve/Palmier"
        );
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
        assert_eq!(
            track0_b.start_frame, 80,
            "b shifted by the new clip's own 30-frame duration"
        );
        let track1_x = t.tracks[1].clips.iter().find(|c| c.id == "x").unwrap();
        assert_eq!(
            track1_x.start_frame, 230,
            "sync-locked track 1's clip shifted by the same 30 frames"
        );
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
        assert_eq!(
            track0_b.start_frame, 80,
            "ripple genuinely fired on track 0"
        );
        let track1_x = t.tracks[1].clips.iter().find(|c| c.id == "x").unwrap();
        assert_eq!(
            track1_x.start_frame, 200,
            "sync_locked: false — untouched by the other track's ripple"
        );
    }

    #[test]
    fn move_clip_ripple_skips_a_locked_track_even_if_sync_locked() {
        let mut t = two_track(vec![c("a", 0, 50), c("b", 50, 50)], vec![c("x", 200, 50)]);
        t.tracks[1].locked = true; // sync_locked stays true (the default)
        t.tracks[0].clips.push(c("new", 300, 30));
        t.move_clip(0, 2, 0, 50, true).unwrap();
        let track0_b = t.tracks[0].clips.iter().find(|c| c.id == "b").unwrap();
        assert_eq!(
            track0_b.start_frame, 80,
            "ripple genuinely fired on track 0"
        );
        let track1_x = t.tracks[1].clips.iter().find(|c| c.id == "x").unwrap();
        assert_eq!(
            track1_x.start_frame, 200,
            "locked overrides sync_locked — protected from a foreign ripple too"
        );
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
        assert_eq!(
            track1.clips.len(),
            1,
            "rejected: no split, no fragment, x untouched"
        );
        assert_eq!(
            (track1.clips[0].start_frame, track1.clips[0].duration),
            (20, 180)
        );
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
        assert_eq!(
            t.tracks[1].clips.len(),
            1,
            "still exactly one clip, no cascade of fragments"
        );
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
        assert_eq!(
            track1_y.start_frame, 60,
            "y (start 90, at/after the gap's own end 80) shifted -30, no gap needed on track 1"
        );
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
            ..Default::default()
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
            markers: Vec::new(),
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
                        (
                            clip.crop_left,
                            clip.crop_top,
                            clip.crop_right,
                            clip.crop_bottom
                        ),
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

    // -------------------------------------------------------------------- //
    // Manual `link` (D-138, `docs/notes/av-linking.md` "Deferred" list)
    // -------------------------------------------------------------------- //

    /// A video track + an audio track holding two genuinely independent
    /// clips — same shape [`linked_pair`] builds, minus the `link_group` —
    /// the starting point every `link` test links from.
    fn unlinked_pair() -> Timeline {
        let mk = |kind, clips| Track {
            kind,
            clips,
            ..Default::default()
        };
        let v = c("v", 0, 100);
        let mut a = c("a", 0, 100);
        a.source_path = "/v.mov".into();
        a.source_len = 100;
        Timeline {
            id: "t".into(),
            name: "t".into(),
            rate: None,
            tracks: vec![mk(TrackKind::Video, vec![v]), mk(TrackKind::Audio, vec![a])],
            markers: Vec::new(),
        }
    }

    #[test]
    fn link_assigns_a_shared_group_indistinguishable_from_the_drop_paths_own() {
        let mut t = unlinked_pair();
        let group = t.link((0, 0), (1, 0)).unwrap();
        assert_eq!(
            t.tracks[0].clips[0].link_group.as_deref(),
            Some(group.as_str())
        );
        assert_eq!(
            t.tracks[1].clips[0].link_group.as_deref(),
            Some(group.as_str())
        );
        assert_eq!(t.link_group_members(&group), vec![(0, 0), (1, 0)]);
        // Every existing link-aware op treats it exactly like a drop-created
        // group — no parallel mechanism, no special-casing by origin.
        t.move_clip(0, 0, 0, 40, false).unwrap();
        assert_eq!(start_of(&t, 0, "v"), Some(40));
        assert_eq!(
            start_of(&t, 1, "a"),
            Some(40),
            "linked sibling followed the move in lockstep"
        );
    }

    #[test]
    fn link_is_order_independent_and_uses_stable_clip_ids() {
        let mut t = unlinked_pair();
        let group_video_first = t.link((0, 0), (1, 0)).unwrap();
        t.unlink(0, 0).unwrap();
        let group_audio_first = t.link((1, 0), (0, 0)).unwrap();
        assert_eq!(
            group_video_first, group_audio_first,
            "the group id must not depend on argument order"
        );
        assert_eq!(group_video_first, "lg-v-a");
    }

    #[test]
    fn link_rejects_two_clips_of_the_same_kind() {
        let mut t = unlinked_pair();
        t.tracks[0].clips.push(c("v2", 200, 50));
        assert_eq!(t.link((0, 0), (0, 1)), Err(TimelineError::LinkKindMismatch));
        assert_eq!(
            t.tracks[0].clips[0].link_group, None,
            "rejected — nothing mutated"
        );
    }

    #[test]
    fn link_rejects_the_same_clip_given_twice() {
        let mut t = unlinked_pair();
        assert_eq!(t.link((0, 0), (0, 0)), Err(TimelineError::LinkSameClip));
    }

    #[test]
    fn link_rejects_a_clip_thats_already_linked() {
        let mut t = unlinked_pair();
        t.tracks[1].clips.push(c("a2", 0, 100));
        t.link((0, 0), (1, 0)).unwrap();
        let err = t.link((0, 0), (1, 1)).unwrap_err();
        assert_eq!(err, TimelineError::AlreadyLinked("v".into()));
        assert_eq!(
            t.tracks[1].clips[1].link_group, None,
            "rejected whole — the second clip was never touched"
        );
    }

    #[test]
    fn link_rejects_out_of_range_and_a_locked_track() {
        let mut t = unlinked_pair();
        assert_eq!(t.link((9, 0), (1, 0)), Err(TimelineError::NoSuchTrack(9)));
        assert_eq!(t.link((0, 9), (1, 0)), Err(TimelineError::NoSuchClip(9, 0)));
        t.tracks[1].locked = true;
        assert_eq!(t.link((0, 0), (1, 0)), Err(TimelineError::TrackLocked(1)));
        assert_eq!(
            t.tracks[0].clips[0].link_group, None,
            "rejected — nothing mutated"
        );
    }

    #[test]
    fn link_then_unlink_round_trips_to_fully_independent_clips() {
        let mut t = unlinked_pair();
        let group = t.link((0, 0), (1, 0)).unwrap();
        t.unlink(0, 0).unwrap();
        assert_eq!(t.tracks[0].clips[0].link_group, None);
        assert_eq!(t.tracks[1].clips[0].link_group, None);
        assert!(t.link_group_members(&group).is_empty());
    }

    // ----------------------------------------------------------------- //
    // B-079 — mixed native-fps clips on the LIVE playback path
    // (`Track::clip_at`/`clip_spans_from`/`duration`, `Clip::end_frame_at`).
    // Same repro numbers/style as `@chroma/editor/timeline.test.ts`'s own
    // "B-077 — mixed native-fps clips" block (B-077/D-194): a clip at
    // 48fps on a 24fps timeline — every 1 timeline frame is 2 of the
    // clip's own source frames, and every 1 source frame is 0.5 timeline
    // frames — chosen for exact, non-rounded expected numbers.
    // ----------------------------------------------------------------- //
    /// D-226 — the transition model itself: window arithmetic per alignment,
    /// the handle split that arithmetic implies, and what
    /// [`Timeline::resolve_visible_video_layers_at`] hands the compositor
    /// inside a transition window. The pixels those layers turn into are
    /// `chroma::edit`'s own tests (`app/src-tauri`) — this crate does no
    /// rendering, so what it owns is exactly the numbers below.
    mod d224_transitions {
        use super::*;

        /// Two 48-frame clips, cut at frame 48, each with 48 frames of handle
        /// on both sides (`source_len` 144, in-point 48) — the shape a razor
        /// split of a long source produces, which is the common case for a
        /// transition and the one that has handles by construction.
        fn cut_timeline() -> Timeline {
            let clip = |name: &str, start: i64| Clip {
                id: name.into(),
                name: name.into(),
                source_path: format!("/{name}.mov"),
                source_start: 48,
                duration: 48,
                source_len: 144,
                start_frame: start,
                ..Default::default()
            };
            Timeline {
                rate: Some(Rational { num: 24, den: 1 }),
                tracks: vec![Track {
                    kind: TrackKind::Video,
                    clips: vec![clip("A", 0), clip("B", 48)],
                    ..Default::default()
                }],
                ..Default::default()
            }
        }

        fn transition(kind: TransitionKind, alignment: TransitionAlignment) -> Transition {
            Transition {
                id: "tr1".into(),
                kind,
                at_frame: 48,
                duration: 12,
                alignment,
                color: None,
            }
        }

        #[test]
        fn window_and_handles_per_alignment() {
            let center = transition(
                TransitionKind::CrossDissolve,
                TransitionAlignment::CenterAtCut,
            );
            assert_eq!(center.window(), (42, 54));
            assert_eq!((center.head_handle(), center.tail_handle()), (6, 6));

            let start = transition(
                TransitionKind::CrossDissolve,
                TransitionAlignment::StartAtCut,
            );
            assert_eq!(start.window(), (48, 60));
            assert_eq!(
                (start.head_handle(), start.tail_handle()),
                (0, 12),
                "start-at-cut consumes only the OUTGOING clip's tail"
            );

            let end = transition(TransitionKind::CrossDissolve, TransitionAlignment::EndAtCut);
            assert_eq!(end.window(), (36, 48));
            assert_eq!(
                (end.head_handle(), end.tail_handle()),
                (12, 0),
                "end-at-cut consumes only the INCOMING clip's head"
            );
        }

        #[test]
        fn progress_is_zero_on_the_first_window_frame_and_never_reaches_one() {
            let t = transition(
                TransitionKind::CrossDissolve,
                TransitionAlignment::CenterAtCut,
            );
            assert_eq!(t.progress_at(42), 0.0);
            assert_eq!(t.progress_at(48), 0.5, "the cut is the midpoint");
            assert_eq!(t.progress_at(53), 11.0 / 12.0);
            assert!(!t.covers(54), "the window is half-open");
        }

        #[test]
        fn a_cross_dissolve_resolves_both_clips_with_the_incoming_one_on_top() {
            let mut tl = cut_timeline();
            tl.tracks[0].transitions.push(transition(
                TransitionKind::CrossDissolve,
                TransitionAlignment::CenterAtCut,
            ));

            // Before the cut: A is inside its own window, B is reading HEAD
            // handle media (frames before its own in-point).
            let layers = tl.resolve_visible_video_layers_at(45);
            assert_eq!(layers.len(), 2);
            assert_eq!(layer_clip(&layers[0]).name, "B", "incoming paints on top");
            assert_eq!(layers[0].alpha, 3.0 / 12.0);
            assert_eq!(
                layer_source_frame(&layers[0]),
                45,
                "B's in-point is source 48 at timeline 48, so timeline 45 is source 45 — a real head-handle frame"
            );
            assert_eq!(layer_clip(&layers[1]).name, "A");
            assert_eq!(layers[1].alpha, 1.0, "the outgoing clip stays opaque");
            assert_eq!(layer_source_frame(&layers[1]), 93);

            // After the cut: the mirror — A is now reading TAIL handle media.
            let layers = tl.resolve_visible_video_layers_at(51);
            assert_eq!(layer_clip(&layers[0]).name, "B");
            assert_eq!(layers[0].alpha, 9.0 / 12.0);
            assert_eq!(layer_clip(&layers[1]).name, "A");
            assert_eq!(
                layer_source_frame(&layers[1]),
                99,
                "A's out-point is source 96; timeline 51 is source 99 — three frames of tail handle"
            );
        }

        #[test]
        fn a_cross_dissolve_role_gives_the_two_clips_separate_decode_slots() {
            let mut tl = cut_timeline();
            tl.tracks[0].transitions.push(transition(
                TransitionKind::CrossDissolve,
                TransitionAlignment::CenterAtCut,
            ));
            let layers = tl.resolve_visible_video_layers_at(45);
            let roles: Vec<LayerRole> = layers
                .iter()
                .map(|l| match l.source {
                    LayerSource::Clip { role, .. } => role,
                    LayerSource::Color { .. } => panic!("no plate in a cross dissolve"),
                })
                .collect();
            assert_eq!(
                roles,
                vec![LayerRole::TransitionPartner, LayerRole::Primary],
                "the INCOMING clip is the partner — see LayerRole's own doc for why"
            );
        }

        #[test]
        fn a_handle_beyond_the_source_is_held_on_the_nearest_real_frame() {
            // Two clips with NO handles at all (whole source, in-point 0).
            let clip = |name: &str, start: i64| Clip {
                id: name.into(),
                name: name.into(),
                source_path: format!("/{name}.mov"),
                source_start: 0,
                duration: 48,
                source_len: 48,
                start_frame: start,
                ..Default::default()
            };
            let mut tl = Timeline {
                rate: Some(Rational { num: 24, den: 1 }),
                tracks: vec![Track {
                    kind: TrackKind::Video,
                    clips: vec![clip("A", 0), clip("B", 48)],
                    ..Default::default()
                }],
                ..Default::default()
            };
            tl.tracks[0].transitions.push(transition(
                TransitionKind::CrossDissolve,
                TransitionAlignment::CenterAtCut,
            ));
            // `checkTransition` refuses to WRITE this, but a document that got
            // here anyway must still render — freezing on the nearest real
            // frame, exactly Premiere's own "Insufficient Media" degrade.
            let layers = tl.resolve_visible_video_layers_at(45);
            assert_eq!(
                layer_source_frame(&layers[0]),
                0,
                "B has no head handle — held on its own first frame"
            );
            let layers = tl.resolve_visible_video_layers_at(51);
            assert_eq!(
                layer_source_frame(&layers[1]),
                47,
                "A has no tail handle — held on its own last frame"
            );
        }

        #[test]
        fn a_dip_to_color_needs_no_second_clip_and_peaks_opaque_at_the_cut() {
            let mut tl = cut_timeline();
            let mut t = transition(TransitionKind::DipToColor, TransitionAlignment::CenterAtCut);
            t.color = Some("#204080".into());
            tl.tracks[0].transitions.push(t);

            let at_cut = tl.resolve_visible_video_layers_at(48);
            assert_eq!(at_cut.len(), 2);
            assert!(
                matches!(at_cut[0].source, LayerSource::Color { rgb } if rgb == (0x20, 0x40, 0x80)),
                "the plate paints on top, in the stored colour"
            );
            assert_eq!(at_cut[0].alpha, 1.0, "fully opaque exactly at the cut");
            assert_eq!(
                layer_clip(&at_cut[1]).name,
                "B",
                "underneath is simply whatever clip_at already resolves — no handle media"
            );
            assert_eq!(
                layer_source_frame(&at_cut[1]),
                48,
                "B's own first real frame, not a handle"
            );

            let edge = tl.resolve_visible_video_layers_at(42);
            assert_eq!(
                edge[0].alpha, 0.0,
                "no dip at all on the window's first frame"
            );
            assert_eq!(layer_clip(&edge[1]).name, "A");
        }

        #[test]
        fn an_absent_color_dips_to_black() {
            let t = transition(TransitionKind::DipToColor, TransitionAlignment::CenterAtCut);
            assert_eq!(t.rgb(), (0, 0, 0));
        }

        #[test]
        fn a_dangling_transition_renders_the_cut_plainly_rather_than_erroring() {
            let mut tl = cut_timeline();
            tl.tracks[0].transitions.push(transition(
                TransitionKind::CrossDissolve,
                TransitionAlignment::CenterAtCut,
            ));
            // The incoming clip is moved away — the cut no longer exists.
            tl.tracks[0].clips[1].start_frame = 200;
            let layers = tl.resolve_visible_video_layers_at(45);
            assert_eq!(layers.len(), 1);
            assert_eq!(layer_clip(&layers[0]).name, "A");
            assert_eq!(layers[0].alpha, 1.0);
        }

        #[test]
        fn a_frame_outside_every_window_is_untouched_by_transitions() {
            let mut tl = cut_timeline();
            tl.tracks[0].transitions.push(transition(
                TransitionKind::CrossDissolve,
                TransitionAlignment::CenterAtCut,
            ));
            let layers = tl.resolve_visible_video_layers_at(20);
            assert_eq!(layers.len(), 1);
            assert_eq!(layer_clip(&layers[0]).name, "A");
            assert_eq!(layers[0].alpha, 1.0);
        }

        #[test]
        fn transitions_round_trip_through_serde_and_a_legacy_track_has_none() {
            let mut tl = cut_timeline();
            tl.tracks[0].transitions.push(transition(
                TransitionKind::DipToColor,
                TransitionAlignment::EndAtCut,
            ));
            let json = serde_json::to_string(&tl).unwrap();
            assert!(
                json.contains("\"dip_to_color\""),
                "snake_case on the wire: {json}"
            );
            assert!(json.contains("\"end_at_cut\""));
            let back: Timeline = serde_json::from_str(&json).unwrap();
            assert_eq!(back.tracks[0].transitions, tl.tracks[0].transitions);

            // A pre-D-226 track has no `transitions` key at all.
            let legacy: Track = serde_json::from_str(r#"{"kind":"video","clips":[]}"#).unwrap();
            assert!(legacy.transitions.is_empty());
            // …and an alignment-less transition defaults to centre-at-cut.
            let t: Transition = serde_json::from_str(
                r#"{"id":"x","kind":"cross_dissolve","at_frame":10,"duration":4}"#,
            )
            .unwrap();
            assert_eq!(t.alignment, TransitionAlignment::CenterAtCut);
            assert_eq!(t.window(), (8, 12));
        }
    }

    mod b079_mixed_native_fps {
        use super::*;

        fn mixed_fps_clip(id: &str, start_frame: i64, duration_source_frames: i64) -> Clip {
            Clip {
                id: id.into(),
                name: id.into(),
                source_path: format!("/{id}.mp4"),
                source_start: 0,
                duration: duration_source_frames,
                source_len: duration_source_frames,
                source_fps: Some(48.0),
                start_frame,
                ..Default::default()
            }
        }

        #[test]
        fn end_frame_at_converts_source_duration_through_source_fps() {
            // 96 source frames at 48fps = 2s = 48 timeline frames at 24fps.
            let c = mixed_fps_clip("a", 0, 96);
            assert_eq!(c.end_frame_at(24.0), 48);
            // The plain, fps-naive accessor is UNCHANGED (dead-ops-only) —
            // it must still add the two numbers raw, on purpose.
            assert_eq!(c.end_frame(), 96);
        }

        #[test]
        fn end_frame_at_is_the_identity_when_source_fps_equals_the_timeline_fps() {
            let mut c = mixed_fps_clip("a", 10, 100);
            c.source_fps = Some(24.0);
            assert_eq!(c.end_frame_at(24.0), c.end_frame());
        }

        #[test]
        fn end_frame_at_falls_back_to_a_1to1_ratio_when_source_fps_is_absent() {
            let mut c = mixed_fps_clip("a", 10, 100);
            c.source_fps = None;
            assert_eq!(c.end_frame_at(24.0), c.end_frame());
        }

        #[test]
        fn track_clip_at_resolves_the_correct_source_frame_for_a_48fps_clip_on_a_24fps_timeline() {
            let tr = Track {
                kind: TrackKind::Video,
                clips: vec![mixed_fps_clip("a", 0, 96)],
                ..Default::default()
            };
            // 10 timeline frames in = 20 of the clip's own 48fps source frames.
            assert_eq!(
                tr.clip_at(10, 24.0).map(|(c, sf)| (c.name.as_str(), sf)),
                Some(("a", 20))
            );
            // Still covers the position right up to (but not past) its
            // fps-converted 48-timeline-frame end.
            assert!(tr.clip_at(47, 24.0).is_some());
            assert!(
                tr.clip_at(48, 24.0).is_none(),
                "past the fps-converted end — the pre-fix plain end_frame() \
                 (96) would have wrongly kept this clip \"active\" until \
                 timeline frame 96"
            );
        }

        #[test]
        fn track_duration_uses_the_fps_converted_end_not_the_raw_source_frame_count() {
            let tr = Track {
                kind: TrackKind::Video,
                clips: vec![mixed_fps_clip("a", 0, 96)],
                ..Default::default()
            };
            assert_eq!(
                tr.duration(24.0),
                48,
                "96 native-fps source frames at 48fps is 48 timeline frames at 24fps"
            );
        }

        #[test]
        fn clip_spans_from_reports_the_fps_converted_span() {
            let tr = Track {
                kind: TrackKind::Video,
                clips: vec![mixed_fps_clip("a", 10, 96)],
                ..Default::default()
            };
            assert_eq!(tr.clip_spans_from(0, 24.0), vec![(10, 58)]);
        }

        #[test]
        fn timeline_fps_reads_the_rate_field_and_falls_back_to_default() {
            let mut t = Timeline::default();
            assert_eq!(t.fps(), DEFAULT_FPS, "no rate set — the project default");
            t.rate = Some(chroma_types::Rational { num: 30, den: 1 });
            assert_eq!(t.fps(), 30.0);
            t.rate = Some(chroma_types::Rational { num: 0, den: 1 });
            assert_eq!(
                t.fps(),
                DEFAULT_FPS,
                "a malformed rate (zero num) falls back rather than dividing by/into zero"
            );
        }

        #[test]
        fn resolve_visible_video_layers_at_resolves_a_mixed_fps_layer_at_the_correct_source_frame()
        {
            let mut t = Timeline {
                rate: Some(chroma_types::Rational { num: 24, den: 1 }),
                ..Default::default()
            };
            t.tracks.push(Track {
                kind: TrackKind::Video,
                clips: vec![mixed_fps_clip("a", 0, 96)],
                ..Default::default()
            });
            let layers = t.resolve_visible_video_layers_at(10);
            assert_eq!(layers.len(), 1);
            assert_eq!(
                layer_source_frame(&layers[0]),
                20,
                "same fps-converted source frame clip_at gives directly"
            );
        }
    }
}

/// D-211 — the text/title clip model. The rasterisation itself lives in
/// `app/src-tauri`'s `chroma::text` (this crate renders nothing — see the
/// module doc); what is testable *here* is the model: the migration default,
/// the round trip, and the colour parse both renderers rely on.
#[cfg(test)]
mod text_layer_tests {
    use super::*;

    #[test]
    fn a_pre_d209_clip_has_no_text_layer() {
        // No `text` key at all — the pre-D-211 shape. Must deserialise to a
        // plain media clip: not an error, and not an empty title.
        let c: Clip = serde_json::from_str(
            r#"{"id":"a","name":"A","source_path":"/a.mp4","source_start":0,"duration":10}"#,
        )
        .expect("legacy clip JSON should still deserialize");
        assert!(!c.is_text());
        assert!(c.text.is_none());
    }

    #[test]
    fn a_media_clip_serialises_no_text_key_at_all() {
        // `skip_serializing_if` — an ordinary clip's JSON stays what it was
        // before this field existed, so no existing `project.json` grows a
        // `"text": null` on its next save.
        let json = serde_json::to_string(&Clip::default()).expect("serialize");
        assert!(!json.contains("\"text\""), "unexpected text key in {json}");
    }

    #[test]
    fn a_text_clip_round_trips_with_its_defaults() {
        // Only `content` given — the other three come from the named serde
        // defaults, which must be the real values, not their types' zeroes.
        let c: Clip = serde_json::from_str(
            r#"{"id":"t","name":"Title","source_path":"","source_start":0,"duration":48,
                "text":{"content":"AFTER"}}"#,
        )
        .expect("text clip JSON should deserialize");
        assert!(c.is_text());
        let t = c.text.as_ref().expect("text layer");
        assert_eq!(t.content, "AFTER");
        assert_eq!(t.font, DEFAULT_TEXT_FONT);
        assert_eq!(t.size, DEFAULT_TEXT_SIZE);
        assert_eq!(t.color, DEFAULT_TEXT_COLOR);

        let again: Clip =
            serde_json::from_str(&serde_json::to_string(&c).expect("serialize")).expect("reparse");
        assert_eq!(again.text, c.text);
    }

    #[test]
    fn text_layer_default_is_not_the_types_zero_values() {
        let t = TextLayer::default();
        assert_eq!(t.font, DEFAULT_TEXT_FONT);
        assert_eq!(t.size, DEFAULT_TEXT_SIZE);
        assert_eq!(t.color, DEFAULT_TEXT_COLOR);
        assert!(t.size > 0.0, "a zero-size title would render nothing");
    }

    #[test]
    fn colour_parses_both_hex_forms_and_falls_back_on_junk() {
        let with = |color: &str| {
            TextLayer {
                color: color.to_string(),
                ..Default::default()
            }
            .rgb()
        };
        assert_eq!(with("#FF8800"), (255, 136, 0));
        assert_eq!(with("ff8800"), (255, 136, 0), "the leading # is optional");
        assert_eq!(
            with("#f80"),
            (255, 136, 0),
            "3-digit shorthand expands per CSS"
        );
        assert_eq!(with("#FFFFFF"), (255, 255, 255));
        assert_eq!(with("#000000"), (0, 0, 0));
        // Unparseable → opaque white, never a panic and never an error: see
        // `TextLayer::rgb`'s own doc for why the consumer degrades instead.
        assert_eq!(with("rebeccapurple"), (255, 255, 255));
        assert_eq!(with("#12345"), (255, 255, 255));
        assert_eq!(with(""), (255, 255, 255));
        assert_eq!(with("#gggggg"), (255, 255, 255));
    }

    #[test]
    fn a_text_clip_occupies_real_timeline_space_like_any_other_clip() {
        // The whole point of the Clip-variant shape (D-211): every existing
        // position/resolution op works on a text clip with no new code here.
        let mut tl = Timeline {
            tracks: vec![Track {
                kind: TrackKind::Video,
                ..Default::default()
            }],
            ..Default::default()
        };
        tl.tracks[0].clips.push(Clip {
            id: "t".into(),
            name: "Title".into(),
            duration: 48,
            source_len: 48,
            start_frame: 24,
            text: Some(TextLayer {
                content: "AFTER".into(),
                ..Default::default()
            }),
            ..Default::default()
        });
        let layers = tl.resolve_visible_video_layers_at(30);
        assert_eq!(layers.len(), 1, "a text clip is a real visible video layer");
        assert!(matches!(layers[0].source, LayerSource::Clip { clip, .. } if clip.is_text()));
        assert_eq!(tl.duration(), 72, "24 + 48");
        assert!(tl.resolve_visible_video_layers_at(100).is_empty());
    }
}

/// D-228 — the subtitle track kind and its own resolver.
///
/// These assert the two properties that made a track kind the right call over
/// D-211's clip-variant shape: a subtitle track takes **no part in the video
/// z-order**, and several subtitle tracks resolve **together**.
#[cfg(test)]
mod caption_tests {
    use super::caption::{CaptionAlign, CaptionCue, CaptionStyle};
    use super::*;

    fn caption_clip(id: &str, start: i64, dur: i64, text: &str) -> Clip {
        Clip {
            id: id.to_string(),
            start_frame: start,
            duration: dur,
            source_len: dur,
            caption: Some(CaptionCue::new(text)),
            ..Clip::default()
        }
    }

    fn media_clip(id: &str, start: i64, dur: i64) -> Clip {
        Clip {
            id: id.to_string(),
            start_frame: start,
            duration: dur,
            source_len: dur,
            source_path: "/tmp/x.mp4".into(),
            ..Clip::default()
        }
    }

    fn track(kind: TrackKind, clips: Vec<Clip>) -> Track {
        Track {
            kind,
            clips,
            ..Track::default()
        }
    }

    #[test]
    fn a_subtitle_track_takes_no_part_in_the_video_z_order() {
        // THE property that made this a track kind rather than a `Clip`
        // variant (D-228). A subtitle track between two video tracks must not
        // shift, occlude or otherwise appear in the video compositing stack.
        let tl = Timeline {
            tracks: vec![
                track(TrackKind::Video, vec![media_clip("v0", 0, 48)]),
                track(TrackKind::Subtitle, vec![caption_clip("c", 0, 48, "hi")]),
                track(TrackKind::Video, vec![media_clip("v1", 0, 48)]),
            ],
            ..Timeline::default()
        };
        let layers = tl.resolve_visible_video_layers_at(10);
        assert_eq!(layers.len(), 2, "only the two VIDEO tracks composite");
        for l in &layers {
            match &l.source {
                LayerSource::Clip { clip, .. } => assert!(
                    !clip.is_caption(),
                    "a caption must never reach the video compositor"
                ),
                LayerSource::Color { .. } => {}
            }
        }
        // …and the video tracks keep their own indices, so their z-order is
        // unchanged by the subtitle lane sitting between them.
        assert_eq!(layers[0].track, 0);
        assert_eq!(layers[1].track, 2);
    }

    #[test]
    fn a_subtitle_track_matches_neither_the_video_nor_the_audio_filter() {
        // The compositor's and the mixer's own `kind ==` filters, asserted
        // from this side so the invariant is pinned rather than assumed.
        let tl = Timeline {
            tracks: vec![track(
                TrackKind::Subtitle,
                vec![caption_clip("c", 0, 48, "hi")],
            )],
            ..Timeline::default()
        };
        assert!(!tl.tracks.iter().any(|t| t.kind == TrackKind::Audio));
        assert!(!tl.tracks.iter().any(|t| t.kind == TrackKind::Video));
    }

    #[test]
    fn several_subtitle_tracks_resolve_together_in_track_order() {
        // The reference frame's own case: an English and a French track burnt
        // in at once, neither occluding the other.
        let tl = Timeline {
            tracks: vec![
                track(TrackKind::Video, vec![media_clip("v", 0, 48)]),
                track(
                    TrackKind::Subtitle,
                    vec![caption_clip("en", 0, 48, "beach")],
                ),
                track(
                    TrackKind::Subtitle,
                    vec![caption_clip("fr", 0, 48, "plage")],
                ),
            ],
            ..Timeline::default()
        };
        let caps = tl.resolve_visible_captions_at(10);
        assert_eq!(caps.len(), 2);
        assert_eq!(caps[0].cue.text, "beach");
        assert_eq!(caps[1].cue.text, "plage");
        // Paint order is index-ascending — documented on the resolver, pinned
        // here because it is the OPPOSITE of the video one.
        assert!(caps[0].track < caps[1].track);
    }

    #[test]
    fn a_caption_resolves_only_inside_its_own_window() {
        let tl = Timeline {
            tracks: vec![track(
                TrackKind::Subtitle,
                vec![caption_clip("c", 24, 24, "middle")],
            )],
            ..Timeline::default()
        };
        assert!(tl.resolve_visible_captions_at(23).is_empty(), "before");
        assert_eq!(tl.resolve_visible_captions_at(24).len(), 1, "first frame");
        assert_eq!(tl.resolve_visible_captions_at(47).len(), 1, "last frame");
        // End-exclusive, exactly like every other clip in this model.
        assert!(tl.resolve_visible_captions_at(48).is_empty(), "after");
    }

    #[test]
    fn a_hidden_subtitle_track_resolves_nothing() {
        let mut tr = track(TrackKind::Subtitle, vec![caption_clip("c", 0, 48, "hi")]);
        tr.hidden = true;
        let tl = Timeline {
            tracks: vec![tr],
            ..Timeline::default()
        };
        assert!(tl.resolve_visible_captions_at(10).is_empty());
    }

    #[test]
    fn the_style_chain_is_cue_override_then_track_then_defaults() {
        let mut cue_with_override = caption_clip("o", 0, 48, "override");
        cue_with_override.caption.as_mut().expect("caption").style = Some(CaptionStyle {
            color: "#00FF00".into(),
            ..CaptionStyle::default()
        });
        let mut tr = track(
            TrackKind::Subtitle,
            vec![caption_clip("t", 0, 48, "track"), cue_with_override],
        );
        tr.caption_style = Some(CaptionStyle {
            color: "#FF0000".into(),
            align: CaptionAlign::Left,
            ..CaptionStyle::default()
        });
        let tl = Timeline {
            tracks: vec![tr],
            ..Timeline::default()
        };
        let caps = tl.resolve_visible_captions_at(10);
        assert_eq!(caps.len(), 2);
        // The cue with no override takes the TRACK's style, whole.
        assert_eq!(caps[0].style.color, "#FF0000");
        assert_eq!(caps[0].style.align, CaptionAlign::Left);
        // The overriding cue takes its OWN style whole — it does not merge
        // field-by-field with the track's, so it cannot silently drift when
        // the track style changes. ("Use Track Style" is a checkbox, not a
        // per-field cascade.)
        assert_eq!(caps[1].style.color, "#00FF00");
        assert_eq!(caps[1].style.align, CaptionAlign::Center);
    }

    #[test]
    fn a_track_with_no_style_falls_back_to_the_defaults() {
        let tl = Timeline {
            tracks: vec![track(
                TrackKind::Subtitle,
                vec![caption_clip("c", 0, 48, "hi")],
            )],
            ..Timeline::default()
        };
        assert_eq!(
            tl.resolve_visible_captions_at(10)[0].style,
            CaptionStyle::default()
        );
    }

    #[test]
    fn a_clip_with_no_cue_on_a_subtitle_track_is_skipped() {
        // Defensive: a media clip that somehow landed on a subtitle track must
        // not become a caption with empty text, it must be ignored.
        let tl = Timeline {
            tracks: vec![track(TrackKind::Subtitle, vec![media_clip("v", 0, 48)])],
            ..Timeline::default()
        };
        assert!(tl.resolve_visible_captions_at(10).is_empty());
    }

    #[test]
    fn subtitle_track_indices_lists_only_subtitle_tracks() {
        let tl = Timeline {
            tracks: vec![
                track(TrackKind::Video, vec![]),
                track(TrackKind::Subtitle, vec![]),
                track(TrackKind::Audio, vec![]),
                track(TrackKind::Subtitle, vec![]),
            ],
            ..Timeline::default()
        };
        assert_eq!(tl.subtitle_track_indices(), vec![1, 3]);
    }

    #[test]
    fn a_pre_d228_clip_and_track_round_trip_with_no_caption_keys() {
        // A project saved before captions existed must deserialize unchanged
        // AND re-serialize without gaining keys — the same migration contract
        // `Clip::text` (D-211) holds to.
        let clip: Clip = serde_json::from_str(
            r#"{"id":"a","name":"a","start_frame":0,"duration":10,"source_len":10,"source_start":0,"source_path":"/x.mp4"}"#,
        )
        .expect("pre-D-228 clip");
        assert!(!clip.is_caption());
        assert!(!clip.is_generated());
        let json = serde_json::to_string(&clip).expect("serialize");
        assert!(!json.contains("caption"), "no caption key should appear");

        let tr: Track =
            serde_json::from_str(r#"{"kind":"video","clips":[]}"#).expect("pre-D-228 track");
        assert!(tr.caption_style.is_none());
        assert!(
            !serde_json::to_string(&tr)
                .expect("serialize")
                .contains("caption_style")
        );
    }

    #[test]
    fn the_subtitle_track_kind_serialises_lowercase() {
        // The TS mirror and `editor_add_track` both speak this string.
        assert_eq!(
            serde_json::to_string(&TrackKind::Subtitle).expect("ser"),
            "\"subtitle\""
        );
        assert_eq!(
            serde_json::from_str::<TrackKind>("\"subtitle\"").expect("de"),
            TrackKind::Subtitle
        );
    }

    #[test]
    fn a_caption_clip_is_generated_and_moves_like_any_other_clip() {
        // The whole reason a caption is a `Clip`: every existing edit op works
        // on it. `move_clip` is the representative one.
        let mut tl = Timeline {
            tracks: vec![track(
                TrackKind::Subtitle,
                vec![caption_clip("c", 0, 24, "hi")],
            )],
            ..Timeline::default()
        };
        assert!(tl.tracks[0].clips[0].is_generated());
        tl.move_clip(0, 0, 0, 100, false).expect("a caption moves");
        assert_eq!(tl.tracks[0].clips[0].start_frame, 100);
        assert_eq!(tl.resolve_visible_captions_at(100).len(), 1);
        assert!(tl.resolve_visible_captions_at(0).is_empty());
    }
}

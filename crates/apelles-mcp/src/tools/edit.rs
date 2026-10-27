//! Edit-tab tools — the multi-track NLE surface (D-312).
//!
//! Answered by `@apelles/editor`'s `useEditorControl.ts`. Almost every op here is
//! `editor_`-prefixed; the four that are not (`get_timeline`, `set_clip_fade`,
//! `set_clip_speed`, `set_track_duck`) are older names kept for compatibility and still
//! dispatch to an `editor_`-prefixed op — the tool name and the op name genuinely differ
//! for those, which is the sort of thing a port gets wrong silently and the parity
//! harness catches loudly.
//!
//! Wire keys here are camelCase (`sourceStart`, `startFrame`) while the tool parameters
//! are snake_case, so every mapping is spelled out at its call site rather than derived.

use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::CallToolResult;
use rmcp::{ErrorData, tool, tool_router};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use serde_json::Value;

use crate::args::WireArgs;
use crate::render;
use crate::schemas::{
    ClipHighlightSpec, ClipKeyframe, ClipSelector, CurveSpec, DynamicZoomFraming, ExportRenderer,
    FitMode, GapSelector, LoudnessPreset, SpeedRampPoint,
};
use crate::server::ApellesMcp;

mod capabilities;

// Argument defaults — the Python signature's own, so an omitted argument reaches the
// frontend with the value it always did.
fn default_editor_add_adjustment_clip_ripple() -> bool {
    false
}

fn default_editor_add_caption_preset_place_caption() -> bool {
    true
}

fn default_editor_add_text_clip_ripple() -> bool {
    false
}

fn default_editor_add_track_track_kind() -> String {
    "video".to_string()
}

fn default_editor_add_transition_alignment() -> String {
    "center_at_cut".to_string()
}

fn default_editor_add_transition_kind() -> String {
    "cross_dissolve".to_string()
}

fn default_editor_analyze_video_force() -> bool {
    false
}

fn default_editor_generate_captions_from_transcript_force() -> bool {
    false
}

fn default_editor_detect_retakes_force() -> bool {
    false
}

fn default_editor_detect_silences_force() -> bool {
    false
}

fn default_editor_detect_dark_regions_force() -> bool {
    false
}

/// D-349 — dark-region recovery is ON by default on the retake tools.
///
/// Not a taste call: the ASR's silently dropped speech was measured (on
/// Whisper) biased towards near-duplicate repeated material, so grouping the
/// raw transcript is blind in exactly the place retake detection is looking
/// (B-216).
fn default_editor_recover_dark_regions() -> bool {
    true
}

fn default_editor_get_transcript_force() -> bool {
    false
}

fn default_editor_get_word_transcript_start() -> bool {
    false
}

fn default_editor_retranscribe_words_apply() -> bool {
    false
}

fn default_editor_retranscribe_words_force() -> bool {
    false
}

fn default_editor_apply_music_edits_include_pending() -> bool {
    false
}

fn default_editor_get_timeline_transcript_start() -> bool {
    false
}

fn default_editor_get_transcript_word_timestamps() -> bool {
    true
}

fn default_editor_move_clip_ripple() -> bool {
    false
}

fn default_editor_set_clip_eq_clear() -> bool {
    false
}

fn default_editor_set_clip_transform_clear_box_height() -> bool {
    false
}

fn default_editor_set_clip_transform_clear_box_width() -> bool {
    false
}

fn default_editor_trim_clip_ripple() -> bool {
    false
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorAddClipArgs {
    #[serde(default)]
    pub track: Option<i64>,
    #[serde(default)]
    pub media_id: Option<String>,
    #[serde(default)]
    pub source_path: Option<String>,
    #[serde(default)]
    pub source_start: Option<i64>,
    #[serde(default)]
    pub duration: Option<i64>,
    #[serde(default)]
    pub start_frame: Option<i64>,
    #[serde(default)]
    pub at_index: Option<i64>,
    #[serde(default)]
    pub ripple: bool,
    #[serde(default)]
    pub name: Option<String>,
}

fn default_editor_search_audio_kind() -> String {
    "any".to_owned()
}

fn default_editor_search_audio_page() -> i64 {
    1
}

fn default_editor_search_audio_page_size() -> i64 {
    10
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorSearchAudioArgs {
    pub query: String,
    #[serde(default = "default_editor_search_audio_kind")]
    pub kind: String,
    #[serde(default)]
    pub min_secs: Option<f64>,
    #[serde(default)]
    pub max_secs: Option<f64>,
    #[serde(default)]
    pub licenses: Option<Vec<String>>,
    #[serde(default = "default_editor_search_audio_page")]
    pub page: i64,
    #[serde(default = "default_editor_search_audio_page_size")]
    pub page_size: i64,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorImportAudioArgs {
    pub openverse_id: String,
    #[serde(default)]
    pub track: Option<i64>,
    #[serde(default)]
    pub start_frame: Option<i64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SetClipFadeArgs {
    pub track: i64,
    pub clip: i64,
    #[serde(default)]
    pub fade_in_frames: Option<i64>,
    #[serde(default)]
    pub fade_out_frames: Option<i64>,
    #[serde(default)]
    pub fade_in_curve: Option<CurveSpec>,
    #[serde(default)]
    pub fade_out_curve: Option<CurveSpec>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SetClipSpeedArgs {
    pub track: i64,
    pub clip: i64,
    #[serde(default)]
    pub speed: Option<f64>,
    #[serde(default)]
    pub points: Option<Vec<SpeedRampPoint>>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SetTrackDuckArgs {
    pub track: i64,
    #[serde(default)]
    pub duck_from: Option<i64>,
    #[serde(default)]
    pub duck_db: Option<f64>,
    #[serde(default)]
    pub attack_ms: Option<f64>,
    #[serde(default)]
    pub release_ms: Option<f64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorSetPlayheadArgs {
    pub frame: i64,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorSetPlayingArgs {
    pub playing: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorSetPlaybackRateArgs {
    pub rate: f64,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorSetAudioMonitorArgs {
    #[serde(default)]
    pub volume: Option<f64>,
    #[serde(default)]
    pub muted: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorSetWaveformViewArgs {
    pub open: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorGetWaveformArgs {
    #[serde(default)]
    pub frame: Option<i64>,
    #[serde(default)]
    pub window_secs: Option<f64>,
    #[serde(default)]
    pub buckets: Option<i64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorSetSelectionArgs {
    #[serde(default)]
    pub clips: Option<Vec<ClipSelector>>,
    #[serde(default)]
    pub gap: Option<GapSelector>,
}

/// `editor_set_preview_zoom`'s `zoom`: a multiplier, or the string `"fit"`.
///
/// A real two-branch union rather than a free-form value, so the published schema says
/// which two forms are accepted. Number first, matching the Python annotation's order.
#[derive(Debug, Deserialize, Serialize, JsonSchema)]
#[serde(untagged)]
pub enum ZoomSpec {
    Multiplier(f64),
    Named(String),
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorSetPreviewZoomArgs {
    pub zoom: ZoomSpec,
    #[serde(default)]
    pub pan_x: Option<f64>,
    #[serde(default)]
    pub pan_y: Option<f64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorImportMediaArgs {
    pub paths: Vec<String>,
    #[serde(default)]
    pub folder: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorRemoveMediaArgs {
    pub ids: Vec<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorReprobeMediaArgs {
    pub ids: Vec<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorCreateMediaFolderArgs {
    pub path: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
// `folder` is required AND nullable. schemars reports every `Option` as optional, and
// its per-field `required` attribute drops the nullability on the way — so the required
// list is set here instead, which keeps both halves true.
#[schemars(extend("required" = ["id", "folder"]))]
pub struct EditorMoveMediaArgs {
    pub id: String,
    /// REQUIRED, and nullable: null means "move it to the pool root". No `#[serde(default)]`
    /// here on purpose — the Python annotates it `str | None` with no default, so the key
    /// must be present even when its value is null, and omitting it is an error rather
    /// than a no-op move.
    pub folder: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorEditInArgs {
    pub edit_type: String,
    #[serde(default)]
    pub media_id: Option<String>,
    #[serde(default)]
    pub source_path: Option<String>,
    #[serde(default)]
    pub track: Option<i64>,
    #[serde(default)]
    pub at_frame: Option<i64>,
    #[serde(default)]
    pub source_start: Option<i64>,
    #[serde(default)]
    pub duration: Option<i64>,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorAddTextClipArgs {
    pub content: String,
    #[serde(default)]
    pub track: Option<i64>,
    #[serde(default)]
    pub start_frame: Option<i64>,
    #[serde(default)]
    pub duration: Option<i64>,
    #[serde(default)]
    pub font: Option<String>,
    #[serde(default)]
    pub bold: Option<bool>,
    #[serde(default)]
    pub italic: Option<bool>,
    #[serde(default)]
    pub size: Option<f64>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default = "default_editor_add_text_clip_ripple")]
    pub ripple: bool,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorSetTextClipArgs {
    pub track: i64,
    pub clip: i64,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub font: Option<String>,
    #[serde(default)]
    pub bold: Option<bool>,
    #[serde(default)]
    pub italic: Option<bool>,
    #[serde(default)]
    pub size: Option<f64>,
    #[serde(default)]
    pub color: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorImportSubtitlesArgs {
    pub path: String,
    #[serde(default)]
    pub offset_frames: Option<i64>,
    #[serde(default)]
    pub font: Option<String>,
    #[serde(default)]
    pub bold: Option<bool>,
    #[serde(default)]
    pub italic: Option<bool>,
    #[serde(default)]
    pub size: Option<f64>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub box_enabled: Option<bool>,
    #[serde(default)]
    pub box_color: Option<String>,
    #[serde(default)]
    pub box_opacity: Option<f64>,
    #[serde(default)]
    pub align: Option<String>,
    #[serde(default)]
    pub position_x: Option<f64>,
    #[serde(default)]
    pub position_y: Option<f64>,
    #[serde(default)]
    pub animation: Option<String>,
    #[serde(default)]
    pub active_color: Option<String>,
    #[serde(default)]
    pub spoken_color: Option<String>,
    #[serde(default)]
    pub upcoming_color: Option<String>,
    #[serde(default)]
    pub highlight_color: Option<String>,
    #[serde(default)]
    pub highlight_opacity: Option<f64>,
    #[serde(default)]
    pub highlight_pad_x: Option<f64>,
    #[serde(default)]
    pub highlight_pad_y: Option<f64>,
    #[serde(default)]
    pub enter_secs: Option<f64>,
    #[serde(default)]
    pub enter_rise: Option<f64>,
    #[serde(default)]
    pub word_gap: Option<f64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorExportSubtitlesArgs {
    pub track: i64,
    pub path: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorGenerateCaptionsFromTranscriptArgs {
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub media_id: Option<String>,
    #[serde(default)]
    pub source_path: Option<String>,
    #[serde(default)]
    pub offset_frames: Option<i64>,
    #[serde(default)]
    pub max_words: Option<i64>,
    #[serde(default)]
    pub max_duration_s: Option<f64>,
    #[serde(default)]
    pub max_pause_gap_s: Option<f64>,
    #[serde(default = "default_editor_generate_captions_from_transcript_force")]
    pub force: bool,
    #[serde(default)]
    pub font: Option<String>,
    #[serde(default)]
    pub size: Option<f64>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub box_enabled: Option<bool>,
    #[serde(default)]
    pub box_color: Option<String>,
    #[serde(default)]
    pub box_opacity: Option<f64>,
    #[serde(default)]
    pub align: Option<String>,
    #[serde(default)]
    pub position_x: Option<f64>,
    #[serde(default)]
    pub position_y: Option<f64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorAddCaptionArgs {
    pub track: i64,
    pub text: String,
    #[serde(default)]
    pub start_frame: Option<i64>,
    #[serde(default)]
    pub duration: Option<i64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorSetCaptionArgs {
    pub track: i64,
    pub clip: i64,
    pub text: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorAddCaptionPresetArgs {
    pub preset: String,
    #[serde(default)]
    pub track: Option<i64>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub start_frame: Option<i64>,
    #[serde(default)]
    pub duration: Option<i64>,
    #[serde(default = "default_editor_add_caption_preset_place_caption")]
    pub place_caption: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorSetCaptionStyleArgs {
    pub track: i64,
    #[serde(default)]
    pub clip: Option<i64>,
    #[serde(default)]
    pub use_track_style: Option<bool>,
    #[serde(default)]
    pub font: Option<String>,
    #[serde(default)]
    pub bold: Option<bool>,
    #[serde(default)]
    pub italic: Option<bool>,
    #[serde(default)]
    pub size: Option<f64>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub box_enabled: Option<bool>,
    #[serde(default)]
    pub box_color: Option<String>,
    #[serde(default)]
    pub box_opacity: Option<f64>,
    #[serde(default)]
    pub box_padding: Option<f64>,
    #[serde(default)]
    pub line_spacing: Option<f64>,
    #[serde(default)]
    pub align: Option<String>,
    #[serde(default)]
    pub position_x: Option<f64>,
    #[serde(default)]
    pub position_y: Option<f64>,
    #[serde(default)]
    pub animation: Option<String>,
    #[serde(default)]
    pub active_color: Option<String>,
    #[serde(default)]
    pub spoken_color: Option<String>,
    #[serde(default)]
    pub upcoming_color: Option<String>,
    #[serde(default)]
    pub highlight_color: Option<String>,
    #[serde(default)]
    pub highlight_opacity: Option<f64>,
    #[serde(default)]
    pub highlight_pad_x: Option<f64>,
    #[serde(default)]
    pub highlight_pad_y: Option<f64>,
    #[serde(default)]
    pub enter_secs: Option<f64>,
    #[serde(default)]
    pub enter_rise: Option<f64>,
    #[serde(default)]
    pub word_gap: Option<f64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorAddAdjustmentClipArgs {
    #[serde(default)]
    pub track: Option<i64>,
    #[serde(default)]
    pub start_frame: Option<i64>,
    #[serde(default)]
    pub duration: Option<i64>,
    #[serde(default)]
    pub exposure: Option<f64>,
    #[serde(default)]
    pub contrast: Option<f64>,
    #[serde(default)]
    pub saturation: Option<f64>,
    #[serde(default)]
    pub temperature: Option<f64>,
    #[serde(default)]
    pub tint: Option<f64>,
    #[serde(default = "default_editor_add_adjustment_clip_ripple")]
    pub ripple: bool,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorSetAdjustmentClipArgs {
    pub track: i64,
    pub clip: i64,
    #[serde(default)]
    pub exposure: Option<f64>,
    #[serde(default)]
    pub contrast: Option<f64>,
    #[serde(default)]
    pub saturation: Option<f64>,
    #[serde(default)]
    pub temperature: Option<f64>,
    #[serde(default)]
    pub tint: Option<f64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorSplitClipArgs {
    pub track: i64,
    pub clip: i64,
    pub at_frame: i64,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorRemoveClipArgs {
    pub track: i64,
    pub clip: i64,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorRemoveGapArgs {
    pub track: i64,
    pub frame: i64,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorTrimClipArgs {
    pub track: i64,
    pub clip: i64,
    pub edge: String,
    pub delta: i64,
    #[serde(default = "default_editor_trim_clip_ripple")]
    pub ripple: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorRollEditArgs {
    pub track: i64,
    pub clip: i64,
    pub delta: i64,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorSlideClipArgs {
    pub track: i64,
    pub clip: i64,
    pub delta: i64,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorSlipClipArgs {
    pub track: i64,
    pub clip: i64,
    pub delta: i64,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorSwapClipMediaArgs {
    pub track: i64,
    pub clip: i64,
    #[serde(default)]
    pub media_id: Option<String>,
    #[serde(default)]
    pub source_path: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorMoveClipArgs {
    pub from_track: i64,
    pub clip: i64,
    pub start_frame: i64,
    #[serde(default)]
    pub to_track: Option<i64>,
    #[serde(default = "default_editor_move_clip_ripple")]
    pub ripple: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorAddTrackArgs {
    #[serde(default = "default_editor_add_track_track_kind")]
    pub track_kind: String,
    #[serde(default)]
    pub index: Option<i64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorMoveTrackArgs {
    pub from_index: i64,
    pub to_index: i64,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorSetTrackGainArgs {
    pub track: i64,
    pub gain: f64,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorSetTrackLockedArgs {
    pub track: i64,
    pub locked: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorSetTrackHiddenArgs {
    pub track: i64,
    pub hidden: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorAddMarkerArgs {
    #[serde(default)]
    pub frame: Option<i64>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
    /// D-328 — the optional span. Named `duration_frames` to match the Python
    /// parameter (the published schema's property name comes from it, and the
    /// parity harness compares the two schemas); the WIRE arg the app's own op
    /// takes is `durationFrames`, camelCase like every other multi-word op arg.
    #[serde(default)]
    pub duration_frames: Option<i64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorSetMarkerArgs {
    pub id: String,
    #[serde(default)]
    pub frame: Option<i64>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
    /// D-328 — the optional span, patched with the same three-way convention
    /// as `name`/`note`: absent leaves it alone, a positive number sets it, `0`
    /// clears it back to a point marker. See [`EditorAddMarkerArgs`] on why the
    /// field is snake_case here but `durationFrames` on the wire.
    #[serde(default)]
    pub duration_frames: Option<i64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorRemoveMarkerArgs {
    pub id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorListTransitionsArgs {
    #[serde(default)]
    pub track: Option<i64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorAddTransitionArgs {
    pub track: i64,
    #[serde(default = "default_editor_add_transition_kind")]
    pub kind: String,
    #[serde(default)]
    pub at_frame: Option<i64>,
    #[serde(default)]
    pub duration_frames: Option<i64>,
    #[serde(default = "default_editor_add_transition_alignment")]
    pub alignment: String,
    #[serde(default)]
    pub color: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorSetTransitionArgs {
    pub track: i64,
    pub id: String,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub duration_frames: Option<i64>,
    #[serde(default)]
    pub alignment: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorRemoveTransitionArgs {
    pub track: i64,
    pub id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorSetClipTransformArgs {
    pub track: i64,
    pub clip: i64,
    #[serde(default)]
    pub opacity: Option<f64>,
    #[serde(default)]
    pub position_x: Option<f64>,
    #[serde(default)]
    pub position_y: Option<f64>,
    #[serde(default)]
    pub scale: Option<f64>,
    #[serde(default)]
    pub box_width: Option<f64>,
    #[serde(default)]
    pub box_height: Option<f64>,
    #[serde(default = "default_editor_set_clip_transform_clear_box_width")]
    pub clear_box_width: bool,
    #[serde(default = "default_editor_set_clip_transform_clear_box_height")]
    pub clear_box_height: bool,
    #[serde(default)]
    pub rotation: Option<f64>,
    #[serde(default)]
    pub crop_left: Option<f64>,
    #[serde(default)]
    pub crop_top: Option<f64>,
    #[serde(default)]
    pub crop_right: Option<f64>,
    #[serde(default)]
    pub crop_bottom: Option<f64>,
    #[serde(default)]
    pub corner_radius: Option<f64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorSetClipAudioArgs {
    pub track: i64,
    pub clip: i64,
    #[serde(default)]
    pub volume: Option<f64>,
    #[serde(default)]
    pub pan: Option<f64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorSetClipEqArgs {
    pub track: i64,
    pub clip: i64,
    #[serde(default)]
    pub band: Option<i64>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub freq_hz: Option<f64>,
    #[serde(default)]
    pub gain_db: Option<f64>,
    #[serde(default)]
    pub q: Option<f64>,
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default = "default_editor_set_clip_eq_clear")]
    pub clear: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorSetClipHighlightsArgs {
    pub track: i64,
    pub clip: i64,
    pub highlights: Vec<ClipHighlightSpec>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorSuggestClipHighlightsArgs {
    pub track: i64,
    pub clip: i64,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorSetClipKeyframesArgs {
    pub track: i64,
    pub clip: i64,
    pub keyframes: Vec<ClipKeyframe>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorSetKeyframeEaseArgs {
    pub track: i64,
    pub clip: i64,
    pub param: String,
    pub frame: i64,
    #[serde(default)]
    pub curve: Option<CurveSpec>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorSetCurveEditorArgs {
    #[serde(default)]
    pub track: Option<i64>,
    #[serde(default)]
    pub clip: Option<i64>,
    #[serde(default)]
    pub param: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorSetDynamicZoomArgs {
    pub track: i64,
    pub clip: i64,
    #[serde(default)]
    pub start: Option<DynamicZoomFraming>,
    #[serde(default)]
    pub end: Option<DynamicZoomFraming>,
    #[serde(default)]
    pub ease: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorExportArgs {
    pub out_path: String,
    pub width: i64,
    pub height: i64,
    #[serde(default)]
    pub fps: Option<f64>,
    #[serde(default)]
    pub speed_overrides: Option<BTreeMap<String, f64>>,
    #[serde(default)]
    pub fit_overrides: Option<BTreeMap<String, FitMode>>,
    #[serde(default)]
    pub freeze_overrides: Option<BTreeMap<String, bool>>,
    /// D-350 — which engine composites the PICTURE: `"compositor"` (the app's
    /// own live-preview compositor, rendered headlessly and piped into one
    /// ffmpeg process) or `"filter"` (the original one-`-i`-per-clip
    /// `-filter_complex` graph). Omitted = `"filter"` while the render path is
    /// phase 1. See the tool doc.
    #[serde(default)]
    pub renderer: Option<ExportRenderer>,
    /// D-401 — the delivery spec the finished mix is normalised to. See the
    /// tool doc. Omitted = `"off"`.
    #[serde(default)]
    pub loudness_preset: Option<LoudnessPreset>,
    /// D-401 — custom integrated-loudness target, LUFS (instead of a preset).
    #[serde(default)]
    pub loudness_lufs: Option<f64>,
    /// D-401 — true-peak ceiling for a custom target, dBTP (default -1).
    #[serde(default)]
    pub true_peak_dbtp: Option<f64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorExportFcpxmlArgs {
    pub out_path: String,
    pub width: i64,
    pub height: i64,
    #[serde(default)]
    pub fps: Option<f64>,
    #[serde(default)]
    pub project_name: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorGetTranscriptArgs {
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub media_id: Option<String>,
    #[serde(default)]
    pub source_path: Option<String>,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default = "default_editor_get_transcript_word_timestamps")]
    pub word_timestamps: bool,
    #[serde(default = "default_editor_get_transcript_force")]
    pub force: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorGetTranscriptStatusArgs {
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub media_id: Option<String>,
    #[serde(default)]
    pub source_path: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorGetTimelineTranscriptArgs {
    #[serde(default = "default_editor_get_timeline_transcript_start")]
    pub start: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorAnalyzeVideoArgs {
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub media_id: Option<String>,
    #[serde(default)]
    pub source_path: Option<String>,
    #[serde(default)]
    pub question: Option<String>,
    #[serde(default)]
    pub scene_threshold: Option<f64>,
    #[serde(default)]
    pub min_gap_s: Option<f64>,
    #[serde(default)]
    pub max_candidates: Option<i64>,
    #[serde(default = "default_editor_analyze_video_force")]
    pub force: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorAnalyzeVideoStatusArgs {
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub media_id: Option<String>,
    #[serde(default)]
    pub source_path: Option<String>,
}

/// The three interchangeable ways the media-understanding tools name a file.
///
/// Each is sent only if given; which one identifies the file is the caller's choice and
/// the frontend's to resolve, so nothing is defaulted or preferred here.
fn media_args(
    path: Option<String>,
    media_id: Option<String>,
    source_path: Option<String>,
) -> WireArgs {
    WireArgs::new()
        .put("path", path)
        .put("mediaId", media_id)
        .put("sourcePath", source_path)
}

/// D-318 — the recut detectors and the batched cut they feed.
///
/// `clip` is `Option` since D-342 (fixes B-216): omitting it sweeps every
/// analysable clip on `track` in ONE dispatch. It is deliberately an optional
/// argument on the existing tool rather than a second `*_all` tool — an agent
/// that already knows this tool gets the sweep by leaving an argument out.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorDetectSilencesArgs {
    pub track: i64,
    #[serde(default)]
    pub clip: Option<i64>,
    #[serde(default)]
    pub min_silence_ms: Option<f64>,
    #[serde(default = "default_editor_detect_silences_force")]
    pub force: bool,
}

/// D-321 — the poll half. No `force`: a status read starts nothing.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorDetectSilencesStatusArgs {
    pub track: i64,
    #[serde(default)]
    pub clip: Option<i64>,
    #[serde(default)]
    pub min_silence_ms: Option<f64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorDetectRetakesArgs {
    pub track: i64,
    #[serde(default)]
    pub clip: Option<i64>,
    #[serde(default)]
    pub similarity: Option<f64>,
    #[serde(default)]
    pub window_secs: Option<f64>,
    #[serde(default)]
    pub min_words: Option<i64>,
    #[serde(default)]
    pub max_span_utterances: Option<i64>,
    #[serde(default)]
    pub phrase_min_words: Option<i64>,
    #[serde(default = "default_editor_recover_dark_regions")]
    pub recover_dark_regions: bool,
    #[serde(default = "default_editor_detect_retakes_force")]
    pub force: bool,
}

/// D-321 — the poll half. No `force`: a status read starts nothing.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorDetectRetakesStatusArgs {
    pub track: i64,
    #[serde(default)]
    pub clip: Option<i64>,
    #[serde(default)]
    pub similarity: Option<f64>,
    #[serde(default)]
    pub window_secs: Option<f64>,
    #[serde(default)]
    pub min_words: Option<i64>,
    #[serde(default)]
    pub max_span_utterances: Option<i64>,
    #[serde(default)]
    pub phrase_min_words: Option<i64>,
    #[serde(default = "default_editor_recover_dark_regions")]
    pub recover_dark_regions: bool,
}

/// D-349 — the dark-region scan: where the VAD hears a voice and the transcript
/// has no words.
///
/// `clip` is REQUIRED here, unlike the other two detectors. There is no
/// whole-track sweep because the normal consumer of this answer is
/// `editor_detect_retakes`, which runs the scan itself over every clip it
/// groups; the standalone tool is for auditing one clip deliberately.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorDetectDarkRegionsArgs {
    pub track: i64,
    pub clip: i64,
    #[serde(default)]
    pub min_dark_secs: Option<f64>,
    #[serde(default)]
    pub max_word_secs: Option<f64>,
    #[serde(default)]
    pub rms_floor_scale: Option<f64>,
    #[serde(default = "default_editor_detect_dark_regions_force")]
    pub force: bool,
}

/// D-349 — the poll half. No `force`: a status read starts nothing.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorDetectDarkRegionsStatusArgs {
    pub track: i64,
    pub clip: i64,
    #[serde(default)]
    pub min_dark_secs: Option<f64>,
    #[serde(default)]
    pub max_word_secs: Option<f64>,
    #[serde(default)]
    pub rms_floor_scale: Option<f64>,
}

/// D-380 step 2 — one page of a track's word-indexed view.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorGetWordTranscriptArgs {
    pub track: i64,
    #[serde(default)]
    pub offset: Option<i64>,
    #[serde(default)]
    pub max_words: Option<i64>,
    #[serde(default = "default_editor_get_word_transcript_start")]
    pub start: bool,
}

/// D-380 step 2 — the client's retake groups for the coverage gate.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorProposeRetakesArgs {
    pub track: i64,
    #[schemars(schema_with = "untyped_array_schema")]
    pub groups: Vec<serde_json::Value>,
    #[serde(default)]
    pub view_id: Option<String>,
}

/// D-380 step 2 — an isolated ASR re-read of a word range.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorRetranscribeWordsArgs {
    pub track: i64,
    pub view_id: String,
    pub first: i64,
    pub last: i64,
    #[serde(default = "default_editor_retranscribe_words_apply")]
    pub apply: bool,
    #[serde(default = "default_editor_retranscribe_words_force")]
    pub force: bool,
}

/// D-408 — one music edit (dropout / breath / dry section), applied now.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorMusicEditArgs {
    pub track: i64,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub start_frame: Option<i64>,
    #[serde(default)]
    pub end_frame: Option<i64>,
    #[serde(default)]
    pub first_word: Option<i64>,
    #[serde(default)]
    pub last_word: Option<i64>,
    #[serde(default)]
    pub before_word: Option<i64>,
    #[serde(default)]
    pub length_frames: Option<i64>,
    #[serde(default)]
    pub word_track: Option<i64>,
    #[serde(default)]
    pub view_id: Option<String>,
    #[serde(default)]
    pub fade_out_frames: Option<i64>,
    #[serde(default)]
    pub fade_in_frames: Option<i64>,
    #[serde(default)]
    pub mode: Option<String>,
}

/// D-408 — a batch of music edits stored for the person's review.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorProposeMusicEditsArgs {
    pub track: i64,
    #[schemars(schema_with = "untyped_array_schema")]
    pub edits: Vec<serde_json::Value>,
    #[serde(default)]
    pub word_track: Option<i64>,
    #[serde(default)]
    pub view_id: Option<String>,
}

/// D-408 — the music-edit review list, optionally for one bed.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorListMusicEditsArgs {
    #[serde(default)]
    pub track: Option<i64>,
}

/// D-408 — apply one bed's reviewed music edits as one undo step.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorApplyMusicEditsArgs {
    pub track: i64,
    #[serde(default = "default_editor_apply_music_edits_include_pending")]
    pub include_pending: bool,
}

/// The schema for a parameter the Python tool declares as a bare `list`.
///
/// `Vec<serde_json::Value>` would publish `items: {"any": …}`, which is a
/// NARROWER contract than the Python server's `items: {}` — and the parity
/// harness rightly rejects it. The port's job is to reproduce the published
/// contract exactly, not to improve it, so the schema is written out by hand
/// and the Rust side keeps its `Vec<Value>` for deserialising.
fn untyped_array_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({ "type": "array", "items": {} })
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorRippleDeleteRangesArgs {
    pub track: i64,
    #[schemars(schema_with = "untyped_array_schema")]
    pub ranges: Vec<serde_json::Value>,
}

#[tool_router(router = edit_router, vis = "pub")]
impl ApellesMcp {
    #[tool(
        name = "get_timeline",
        description = r#"The active edit timeline: every track and every clip on it, with the
    indices the mutating Edit-tab tools address clips by.

    Returns {id, name, durationFrames, tracks: [{index, kind: "video"|"audio",
    gain, locked, hidden, duckFrom, duckDb, duckAttackMs, duckReleaseMs,
    clips: [{index, id, name, sourcePath, startFrame, duration, sourceStart,
    sourceLen, sourceFps, linkGroup, fadeInFrames, fadeOutFrames, fadeInCurve,
    fadeOutCurve, fadeInCurveName, fadeOutCurveName, volume, pan, eqBands,
    eqActive, highlights}]}]}.

    `volume`/`pan` (D-223) are the CLIP's own level and stereo position, which
    MULTIPLY with the track's own `gain` rather than replacing it — see
    editor_set_clip_audio.

    `eqBands` (D-224) is that clip's own parametric EQ, `[]` when it has none;
    `eqActive` says whether ANY of those bands actually changes the sound. Read
    it: a four-band strip whose gains are all 0 dB is completely inert, and
    `eqBands` being non-empty is NOT the same as the clip being filtered. See
    editor_set_clip_eq.

    `highlights` (D-396, B-270) is that clip's phrase highlights, `[]` when it
    has none, each `{box: [x0, y0, x1, y1], at, dur, color?, opacity?}` -- the
    same shape editor_set_clip_highlights takes and returns.

    All positions and durations are in FRAMES, not seconds — the unit every
    Edit-tab number is in. `index` is what set_clip_fade and set_track_duck
    address; `id` is the stable identity that survives a reorder, for re-finding
    a clip after an edit. `duckFrom` is null on a track that is not ducked.

    B-077 — `startFrame` (and `durationFrames`) are TIMELINE frames (this
    timeline's own rate); `duration`/`sourceStart`/`sourceLen` are a CLIP'S
    OWN native frames, which only match the timeline's rate when `sourceFps`
    equals it. A clip's real length in seconds is `duration / (sourceFps or
    the timeline's own rate)`, NOT `duration / durationFrames`'s implied rate
    — dividing a clip's native frame count by the wrong rate is exactly the
    bug that once showed a 47.86s clip as 88s. `sourceFps` is null for a clip
    probed before this field existed, or genuinely same-rate as the timeline.

    Read-only, cheap, no side effects."#
    )]
    pub async fn get_timeline(&self) -> Result<CallToolResult, ErrorData> {
        // Tool name and op name deliberately differ — see this module's header.
        let env = self.op("editor_get_timeline", WireArgs::new()).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_add_clip",
        description = r#"Place a clip from an already-imported media-pool item (`editor_import_media`)
    onto a track, trimmed to `[source_start, source_start+duration)` of the
    source's own frames. Pass either `media_id` or `source_path` to identify
    the pool item.

    Calling this once per KEPT segment, with back-to-back `start_frame`
    values, is how a gap or an unwanted section (a retake, a silence) is cut
    out of a raw recording — you don't place the whole clip and then remove
    a gap; you place only the parts you want, already sitting where they
    should land. `source_start` defaults to 0 and `duration` to the rest of
    the source if omitted. `at_index` inserts at a specific position on the
    track instead of appending; `ripple=True` shifts later clips to make
    room rather than overlapping them.

    OMIT `track` to put the clip on a NEW track of the kind the source needs, in
    one call and one undo (B-273): an audio-only source gets a new audio track
    appended at the bottom; footage or a still gets a new video track at the
    top (index 0, which renumbers every existing track by one). The response's
    `track` is where the clip really landed, `createdTrack` says whether this
    call made it, and `trackCount` is the new total. A `track` that is given is
    validated: one that does not exist is refused, never redirected.

    STILL IMAGES (D-292). A pool item that is a still (PNG/JPEG/TIFF/WebP/BMP —
    `editor_list_media` reports it with an `image` key instead of `video`) is
    placed exactly like footage, on a VIDEO track. A still has no length of its
    own, so two things differ:

    * `duration` defaults to **3 seconds at the project's rate**, not "the rest
      of the source" — pass `duration` explicitly for any other length, in
      timeline frames. It is the same default a title gets, for the same reason.
    * `source_start` is meaningless on a still (every frame is the same
      picture); leave it at 0. Its reported `sourceLen` is a synthesized ONE
      HOUR of trim headroom, not a real length — so a still can be extended
      about as far as you like, and a `duration` up to that ceiling is accepted.

    A still is refused on an audio track: it is picture with no audio stream."#
    )]
    pub async fn editor_add_clip(
        &self,
        Parameters(p): Parameters<EditorAddClipArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            // Omitted = a new track of the kind the source needs (B-273).
            .put("track", p.track)
            // `ripple` is always sent, unlike every other optional here: the handler
            // reads it as a plain boolean, so omitting it and sending false differ.
            .set("ripple", p.ripple)
            .put("mediaId", p.media_id)
            .put("sourcePath", p.source_path)
            .put("sourceStart", p.source_start)
            .put("duration", p.duration)
            .put("startFrame", p.start_frame)
            .put("atIndex", p.at_index)
            .put("name", p.name);
        let env = self.op("editor_add_clip", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_search_audio",
        description = r#"Search Openverse (openverse.org) for CC-licensed sound effects and music. A
    NETWORK call to api.openverse.org, made only because you called this tool;
    nothing else in the app reaches the internet for audio.

    `kind` is "sfx", "music" or "any". `min_secs`/`max_secs` bound the length.
    `licenses` defaults to ["cc0", "by"] (public-domain dedication and plain
    attribution); "by-sa" and "pdm" are accepted when named. NonCommercial
    (`nc`) and NoDerivatives (`nd`) licences are ALWAYS refused, with the reason:
    a published video can be monetised and cutting/mixing sound is an
    adaptation, so neither can go in one. `page_size` is 1..20.

    Returns {total, page, pageCount, hits: [{id, title, creator, creatorUrl,
    license, licenseVersion, licenseUrl, source, category, durationSecs,
    previewUrl, filetype, landingUrl, attribution}], skipped: {...counts of
    results left out and why}}. Filtering happens after the search, so a page
    can hold fewer hits than `page_size`: raise `page` for more. Take a hit's
    `id` to editor_import_audio. CC BY sounds REQUIRE a credit: importing one
    records it, and editor_get_credits returns the text to paste."#
    )]
    pub async fn editor_search_audio(
        &self,
        Parameters(p): Parameters<EditorSearchAudioArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("query", p.query)
            .set("kind", p.kind)
            .set("page", p.page)
            .set("pageSize", p.page_size)
            .put("minSecs", p.min_secs)
            .put("maxSecs", p.max_secs)
            .put("licenses", p.licenses);
        let env = self
            .op_with("editor_search_audio", crate::AUDIO_LIBRARY_TIMEOUT_MS, args)
            .await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_import_audio",
        description = r#"Download one Openverse sound (an `id` from editor_search_audio) into the
    project's `assets/audio/`, import it into the media pool, and optionally
    place it. A NETWORK call, made only because you called this tool.

    The licence is re-checked on Openverse's own record for that id: an NC or ND
    sound is refused with the reason whatever found it. The credit is appended
    to `assets/audio/CREDITS.json` in the same step (a re-import of the same id
    replaces its entry, and does not download the file twice).

    Pass `track` to also place it, at `start_frame` (timeline frames; omit to
    let editor_add_clip choose) with the sound's full length: an audio file
    goes on an audio track. Without `track` it is imported only; place it later
    with editor_add_clip.

    Returns {ok, saved: {path, projectFile, title, creator, license,
    durationSecs, credit, downloaded}, media, placed?}. If the download worked
    but the import or placement failed, the error says so and still carries
    `saved`."#
    )]
    pub async fn editor_import_audio(
        &self,
        Parameters(p): Parameters<EditorImportAudioArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("openverseId", p.openverse_id)
            .put("track", p.track)
            .put("startFrame", p.start_frame);
        let env = self
            .op_with("editor_import_audio", crate::AUDIO_LIBRARY_TIMEOUT_MS, args)
            .await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_get_credits",
        description = r#"The project's audio credits as ready-to-paste video-description text.

    Reads `assets/audio/CREDITS.json`, which editor_import_audio appends to.
    Returns {count, text, entries, ledger}: `text` lists the CC BY credits (the
    ones that are required) first, then the public-domain ones, each with title,
    creator, landing page and licence link. Empty `text` means nothing has been
    imported. Reads a local file; no network.

    Read-only, cheap, no side effects."#
    )]
    pub async fn editor_get_credits(&self) -> Result<CallToolResult, ErrorData> {
        let env = self.op("editor_get_credits", WireArgs::new()).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "set_clip_fade",
        description = r#"Set a clip's fade in / fade out. `track` and `clip` are the 0-based
    indices from get_timeline.

    Durations are in FRAMES (not seconds, not percent). Negative or fractional
    values are floored to whole frames >= 0; the returned values are what was
    actually stored, so check them rather than assuming. A fade LONGER than the
    clip is allowed and is deliberately not clamped: the two windows then
    overlap and their multipliers multiply, so a clip fully fading in and out
    sits at 0.25 in the middle. Omitting a duration leaves that one as it is.

    A curve is either a preset NAME -- exactly "linear" | "ease-in" |
    "ease-out" | "ease-in-out", no others (B-165: CSS's own "ease" is NOT one
    of them and is rejected, not silently substituted) -- or four cubic-bezier
    control points [x1, y1, x2, y2], the same model CSS cubic-bezier() and
    After Effects keyframe easing use (P0=(0,0) and P3=(1,1) implicit; x is
    progress through the fade window, y the multiplier at that progress). An
    unknown preset name is rejected, not silently substituted. Curves always come back
    as four control points plus the matching preset name if there is one, so a
    curve read and written back is exactly what was read.

    Two real properties to set this with, rather than guess at:

    1. A fade on a VIDEO clip fades its picture (opacity) AND its own embedded
       audio (gain) together -- one handle, as Premiere's and Resolve's fade
       handle does. To fade them differently, unlink the clip's audio; it
       becomes its own clip with its own fade. A clip on an audio track fades
       gain only.
    2. The curve is a straight multiplier on amplitude / alpha, NOT a
       perceptual one. Perceived loudness is roughly logarithmic in amplitude,
       so a perceptually even AUDIO fade-in is nearer "ease-in" than "linear"
       ("linear" is the exact straight ramp, and is the default). Picture has
       no equivalent skew. Pick with that stated rather than assuming one curve
       suits both.

    Undoable: this goes through the same store action and the same undo stack
    the GUI's own Inspector writes to, so a human can Cmd+Z it."#
    )]
    pub async fn set_clip_fade(
        &self,
        Parameters(p): Parameters<SetClipFadeArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("track", p.track)
            .set("clip", p.clip)
            .put("fade_in_frames", p.fade_in_frames)
            .put("fade_out_frames", p.fade_out_frames)
            .put("fade_in_curve", p.fade_in_curve)
            .put("fade_out_curve", p.fade_out_curve);
        let env = self.op("editor_set_clip_fade", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "set_clip_speed",
        description = r#"Retime a clip -- a flat speed change, or a real SPEED RAMP that varies
    over the clip (D-236). `track` and `clip` are the 0-based indices from
    get_timeline.

    Pass exactly one of:

    * `speed` -- one multiplier for the whole clip. `2.0` plays it twice as
      fast in half the timeline space, `0.5` half as fast in twice the space,
      `1.0` clears any ramp back to normal. NEGATIVE plays it BACKWARDS at that
      rate: `-1.0` is the plain "reverse this clip", `-2.0` is backwards at
      double speed. Magnitude 0.05-20, either sign; a value outside that is
      REFUSED, not clamped, so a typo cannot silently retime to something else.
      `0` is refused too -- that is not slow, it is a clip that never advances.
    * `points` -- a ramp, as a list of `{"source_frame": int, "speed": float}`.
      Each point means "from this SOURCE frame onward, play at this speed", so
      the clip becomes a run of constant-speed segments. Source frames are
      absolute in the file (the same space as a clip's `source_start` and a
      keyframe's `frame`), NOT clip-relative and NOT timeline frames -- which
      is what makes a ramp survive a later trim: the speed stays on the moment
      in the footage you put it on. Points are sorted on the way in and only
      ONE is kept per source frame (last wins), so the stored list may be
      shorter than what you sent. A point that merely restates the speed
      already in force is deliberately KEPT, not tidied away -- it is a real
      split you can then give its own speed, which is the normal authoring
      order. `[]` clears the ramp.

    Five things worth knowing before you use it:

    1. **A flat speed IS a one-segment ramp.** `speed=2` and
       `points=[{"source_frame": <in-point>, "speed": 2}]` are the same edit and
       store identically. There is no separate flat mechanism to keep in step.
    2. **It changes the clip's LENGTH on the timeline, not its start.** A
       retimed clip still begins at its own `start_frame`; the clips after it
       do NOT move, so speeding a clip up opens a gap and slowing it down
       overlaps its neighbour. Close it yourself (editor_remove_gap, or
       editor_move_clip). This matches Resolve with ripple off.
    3. **Picture and sound are retimed together.** In the EXPORT the audio
       pitch is preserved (an `atempo` chain per segment); in the live PREVIEW
       it is not -- the mixer varispeeds, so a sped-up clip previews
       chipmunked and a reversed one previews backwards, like tape (D-242).
       Timing matches either way, which is the thing you are editing to.
       A clip's own fades, volume and pan automation follow the retime too --
       a key stays on the source moment you authored it against, and a fade is
       measured in PLAYBACK order, so a reversed clip's fade-in is still at the
       start of what the viewer sees.
    4. **The preview and the export agree frame for frame.** Both read the same
       remap; `editor_get_state` and the exported file will show the same
       source frame at the same timeline position.
    5. **Reverse is per RUN, not per clip** (D-241). A ramp may mix forward and
       reversed segments -- `[{0, 1.0}, {48, -2.0}, {96, 1.0}]` plays forwards,
       then whips backwards at 2x, then forwards again. Reversing does not
       change how long a run occupies: `-2.0` and `2.0` take exactly the same
       timeline space, so flipping a sign never moves the clip's out-point.
       Reverse costs REAL MEMORY at export (ffmpeg buffers the reversed run's
       frames), bounded to that run rather than the whole source file.
    6. **Smoothed S-curve speed transitions are still not supported** -- a
       speed change is a step. A gradual ramp can be approximated by adding
       more points.

    Returns the stored points, the RESOLVED segments (which is what actually
    plays -- after a trim, some of your points may no longer bite), and the
    clip's source vs. output length in frames.

    Undoable: this goes through the same store action and the same undo stack
    the GUI's own Inspector Speed section writes to, so a human can Cmd+Z it."#
    )]
    pub async fn set_clip_speed(
        &self,
        Parameters(p): Parameters<SetClipSpeedArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("track", p.track)
            .set("clip", p.clip)
            .put("speed", p.speed)
            .put("points", p.points);
        let env = self.op("editor_set_clip_speed", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "set_track_duck",
        description = r#"Duck one track under another: lower `track` whenever the track named by
    `duck_from` has a clip playing. The music-under-dialogue move. `track` and
    `duck_from` are the 0-based track indices from get_timeline.

    `duck_from=None` turns ducking OFF for this track. A track cannot duck from
    itself, and an index that is not a real track is rejected rather than stored
    — both would be silently ignored by the mixer, which would look like the
    tool worked and the feature didn't.

    THE THREE NUMBERS, which are real DSP parameters and not a "strength" dial:

    - `duck_db` -- how far down, in DECIBELS, while the trigger track sounds.
      -12 is the usual dialogue-over-music amount; -6 is gentle, -18 is heavy.
      0 dB is unity, i.e. no duck at all. (Note this is dB while `gain` on the
      same track is a LINEAR multiplier -- a fader level is naturally linear, a
      duck amount is the number editors actually state in dB.)
    - `attack_ms` -- how fast the duck engages, as a one-pole TIME CONSTANT:
      the time to cover 63.2% of the way down. Default 10 ms. Short, so the
      duck is already down before the first syllable is audible; long enough
      and the first word rides over the bed.
    - `release_ms` -- how fast the gain comes back, same definition. Default
      300 ms. Deliberately much slower than the attack: a fast release makes
      the bed pump audibly between words. 300-500 ms is the usual range.

    Two properties worth setting this with rather than guessing at:

    1. The trigger is the trigger track's CLIP LAYOUT, not its loudness. A pause
       mid-sentence does NOT let the bed back up -- only a real gap between
       clips does, and two clips butted end to start read as one continuous
       stretch. If you want the bed rising in every breath, cut the dialogue
       track into the phrases you want.
    2. Ducking is a TRACK relationship, so it applies to every clip on the
       track, for the whole timeline -- there is no per-clip duck.

    Undoable: this goes through the same store action and the same undo stack
    the GUI's own track header writes to, so a human can Cmd+Z it.

    Returns what was actually STORED (the values are normalised on the way in --
    a negative time constant becomes 0), so read the response rather than
    assuming the request landed verbatim."#
    )]
    pub async fn set_track_duck(
        &self,
        Parameters(p): Parameters<SetTrackDuckArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("track", p.track)
            .set("duck_from", p.duck_from)
            .put("duck_db", p.duck_db)
            .put("attack_ms", p.attack_ms)
            .put("release_ms", p.release_ms);
        let env = self.op("editor_set_track_duck", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_get_capabilities",
        description = r#"Hard-won, non-obvious facts about the Edit tab's compositing/export
    model and its rough edges — the things reading `mcp/server.py`'s other
    docstrings alone will NOT tell you, because they were only discovered by
    reading Apelles' own source or hitting them live. Call this ONCE per
    session, before your first `editor_set_clip_transform` /
    `editor_set_clip_keyframes` / `editor_export`, not per-op.

    Static reference data: answered entirely in this process, no round trip
    to the running app — the only `editor_*`-prefixed tool that works with no
    Apelles window running and no project open at all.

    Covers: what `scale`/`fit_overrides` actually control in the live preview
    vs. export (a stacking/picture-in-picture primitive, not a "fill this
    exact box" primitive — plus the recipe for landing a clip in an exact
    half-canvas slot anyway), track paint order, why keyframes are per-clip,
    why a keyframe silently beats `editor_set_clip_transform` per property,
    export's real v1 scope (video only), how a STILL IMAGE differs from
    footage (D-292 — it has no length, so one is synthesized), and known rough
    edges worth testing
    for before trusting a real edit (a stuck media-pool entry, a one-time
    flake right after an app restart, a macOS screen-recording filename trap
    that will silently break ANY tool given a hand-typed path, an animated
    caption's two non-guessable rules, and a now-fixed control-server wedge
    worth knowing the shape of).

    Returns a structured dict, not prose to scan — read the `known_gaps_and_
    landmines` and `compositing` keys first."#
    )]
    pub async fn editor_get_capabilities(&self) -> Result<CallToolResult, ErrorData> {
        // The one tool in this whole surface that never touches the app: static
        // reference data, answered here, so an agent can read it without a round trip.
        Ok(render::json_text(capabilities::document()))
    }

    #[tool(
        name = "editor_get_state",
        description = r#"The Edit tab's own top-level state: whether a project is open AND
    which one (`openProject`, its `.chroma` path — B-083), load status,
    playhead position, whether it is playing, whether a timeline exists at
    all, and the current `selection` (a list of `{track, id}`) plus
    `selectedGap`. Cheap, read-only — call before anything else if you don't
    already know a project is open, to confirm which project the Edit tab is
    actually on after an `open_project`/`new_project` switch, or to see what
    the user currently has selected.

    Also reports `previewZoom` (D-218) — the preview VIEWPORT's own zoom/pan
    (`zoom`, `pct`, `panX`, `panY`, `fit`). Read it before interpreting a
    `debug_screenshot` of the preview: at a non-fit view the picture on screen
    is a magnified crop of the frame, so a clip that looks off-centre may
    simply be being looked at from off-centre. `editor_set_preview_zoom` is
    the write half.

    Also reports `waveformView` (D-232) — whether the viewer is showing its
    audio waveform strip under the picture. `editor_set_waveform_view` is that
    one's write half; `editor_get_waveform` reads the envelope itself."#
    )]
    pub async fn editor_get_state(&self) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new();
        let env = self.op("editor_get_state", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_get_grade_status",
        description = r#"Which clips on the Edit timeline carry a real **Colorist grade** — and
    what, if anything, that grade loses on the way there (D-256).

    Returns `clips` (`{clipId, name, graded}` per video clip), `gradedCount`,
    and `warnings`. `graded: true` means this clip previews AND exports with
    its Colorist grade applied — automatically, with no toggle; see
    `editor_get_capabilities`' `colorist_grade` key for the model. `graded:
    false` covers both "never graded" and "graded, then reset to nothing":
    either way no LUT is applied at all, and the pixels are identical to a
    build without the feature.

    **Read `warnings` before trusting an export to match the Colorist tab.**
    The grade crosses into the Edit tab as a baked 3D LUT, which carries the
    whole global grade exactly but *cannot* carry anything spatial — a mask /
    local layer, the Colorist crop, depth relight. Each such drop is listed
    here, named by clip. An empty `warnings` list means the exported file is
    the grade, in full.

    Use it to confirm a grade actually landed on the clip you meant (the link
    is the CLIP id, not the source file — two clips cut from one file grade
    independently, and splitting a graded clip does not copy the grade onto
    the new half), and to check a timeline before `editor_export`.

    Cheap to call repeatedly: each clip's lattice is memoised on its grade
    file's own mtime, so asking twice costs nothing."#
    )]
    pub async fn editor_get_grade_status(&self) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new();
        let env = self.op("editor_get_grade_status", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_set_playhead",
        description = r#"Move the Edit tab's playhead to an exact frame (0-based, absolute
    timeline frame)."#
    )]
    pub async fn editor_set_playhead(
        &self,
        Parameters(p): Parameters<EditorSetPlayheadArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new().set("frame", p.frame);
        let env = self.op("editor_set_playhead", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_set_playing",
        description = r#"Start (`True`) or stop (`False`) Edit-tab playback.

    **This is the whole transport — picture AND sound.** There is not a
    separate audio play/stop: the viewer keys `chroma_audio_play`/
    `chroma_audio_stop` off this same flag, so starting playback here starts
    the real mixed audio session too. Whether anything is audible also depends
    on the monitor (`editor_set_audio_monitor`); `editor_get_audio_level` is
    how you check that sound actually reached the output device.

    How far the playhead travels per second of real time depends on
    `editor_set_playback_rate` — the response repeats it for that reason."#
    )]
    pub async fn editor_set_playing(
        &self,
        Parameters(p): Parameters<EditorSetPlayingArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new().set("playing", p.playing);
        let env = self.op("editor_set_playing", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_set_playback_rate",
        description = r#"Set the Edit tab's **preview playback rate** — how many timeline seconds
    the transport plays per real second. The same control the human uses next
    to play/pause in the viewer's transport bar (D-280).

    **This is NOT a clip's speed.** It changes how fast you WATCH and nothing
    else: no clip is touched, nothing is persisted, nothing is undoable, and an
    export taken while the preview is at 4x renders *exactly* what an export at
    1x renders. If what you actually want is to make a clip play fast in the
    finished video, that is `editor_set_clip_speed` (D-236) — a different tool
    that edits the cut. "Make this faster" is genuinely ambiguous between the
    two; pick deliberately.

    `1` is normal. `2` / `3` / `4` are the review speeds the viewer offers as
    one-click presets; anything from `0.25` to `8` is accepted and anything
    outside that is CLAMPED rather than rejected (the response says so when it
    clamped). `0.5` and below play slower than real time.

    **Audio keeps up and stays intelligible.** Fast playback is not muted and
    not chipmunked: the mixer time-stretches the mixed output with pitch
    preserved (WSOLA), so dialogue at 3x is still dialogue. That is deliberately
    different from a *clip's* speed ramp, which varispeeds like tape (D-242).

    Safe to set while playing — the transport re-baselines picture and sound
    together from wherever the playhead is, so you continue rather than jump.

    `editor_get_state` reports the current value as `playbackRate`."#
    )]
    pub async fn editor_set_playback_rate(
        &self,
        Parameters(p): Parameters<EditorSetPlaybackRateArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new().set("rate", p.rate);
        let env = self.op("editor_set_playback_rate", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_set_audio_monitor",
        description = r#"Set the Edit tab's **master monitoring volume** (`0..1`) and/or its mute
    flag — the same speaker button and volume slider in the viewer's transport
    bar the human uses, driving the same `chroma_audio_set_volume` multiplier
    applied in the real audio output callback.

    **Monitoring only.** This is what the room hears while previewing. It is
    not a track's `gain` (`editor_set_track_gain`), not a clip's `volume`
    (`editor_set_clip_audio`), and it changes NOTHING about what
    `editor_export` renders — an export at monitor-muted comes out with
    exactly the audio it would have anyway.

    Pass either argument alone to leave the other as it is. `volume` is
    clamped to `0..1` rather than rejected (the backend clamps too), and the
    response says so when it clamped. Volume and mute are independent: muting
    remembers where the slider was, so unmuting restores it.

    `editor_get_state` reports the current pair as `monitor`. (D-266.)"#
    )]
    pub async fn editor_set_audio_monitor(
        &self,
        Parameters(p): Parameters<EditorSetAudioMonitorArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .put("volume", p.volume)
            .put("muted", p.muted);
        let env = self.op("editor_set_audio_monitor", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_get_audio_level",
        description = r#"Read the **last measured RMS and peak of the audio actually written to
    the output device** — the concrete answer to "is sound really coming out
    right now", which you have no ears for and a human does not need a tool
    for.

    Use it to verify a playback claim rather than asserting one: start
    playback (`editor_set_playing`), wait about a second, then read this. A
    non-zero `rms`/`peak` is real, non-silent PCM having reached the real
    device through the whole mixer.

    **Read the window before trusting a zero.** The measurement refreshes only
    once per ~1 second of playback, so it lags a change by up to that long and
    stays STALE (not zeroed) after a stop — the response carries `windowSecs`,
    the current `playing`/`muted`/`volume`, and a `note` naming which of those
    explains what you are seeing. Zeroes right after pressing play usually mean
    the first window has not completed yet.

    This is not a meter and cannot be polled as one; a level for a FILE, at any
    resolution you like, is `editor_get_waveform` instead. (D-266.)"#
    )]
    pub async fn editor_get_audio_level(&self) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new();
        let env = self.op("editor_get_audio_level", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_set_waveform_view",
        description = r#"Show (`True`) or hide (`False`) the Edit-tab viewer's **audio waveform
    strip** (D-232, roadmap item 27) — the band drawn between the picture and
    the position bar, showing a 4-second window of the audio around the
    playhead with a line at the playhead itself.

    The same flag the human's waveform-toggle button in the transport bar
    drives, not a parallel one. Useful before a `debug_screenshot` of the
    preview (the strip changes what the transport area contains), and to leave
    the user looking at the audio you have been reasoning about.

    To read the envelope as NUMBERS rather than pixels, use
    `editor_get_waveform` — that is the tool for actually inspecting audio;
    this one only changes what is on screen."#
    )]
    pub async fn editor_set_waveform_view(
        &self,
        Parameters(p): Parameters<EditorSetWaveformViewArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new().set("open", p.open);
        let env = self.op("editor_set_waveform_view", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_get_waveform",
        description = r#"The audio amplitude envelope around a timeline frame — **the same window
    the viewer's waveform strip draws, as numbers** (D-232, roadmap item 27).

    This is the agent-side half of Apelles' audio scrubbing feature. Tape-style
    scrub (dragging the playhead and hearing the audio under it) is a live
    pointer gesture and has, deliberately, no MCP tool of its own — you cannot
    hear it, and `editor_set_playhead` already moves the playhead observably.
    What a scrub actually tells a human is *where the sound is*, and this
    returns exactly that.

    Use it to answer questions you would otherwise have to ask the user to
    listen for: where a sentence starts or ends, whether a cut lands in silence
    or mid-word, whether a clip is silent at all, how loud one stretch is
    against another. Pair it with `editor_get_transcript` (D-189) when you need
    words as well as levels.

    - `frame` — the timeline frame to centre on. Defaults to the current
      playhead.
    - `window_secs` — how much source audio to cover, centred on that frame
      (default 4, matching the strip). Clamped forward at the head of a file.
    - `buckets` — how many `[min, max]` amplitude pairs to reduce it to
      (default 64, max 2000). More buckets = finer time resolution.

    Returns the resolved `source` (`path`, `sourceSecs`, `track`, `clipId`,
    `gain`), the `window` it covered (including `clipStartFraction`/
    `clipEndFraction` — the part of the window that is actually this clip's own
    trimmed material, outside which the source exists but is not on your
    timeline), and `peaks`: one `[min, max]` pair per bucket, each in `-1..1`.
    An all-zero pair is silence.

    `gain` (B-110) is the linear level this source is actually heard at —
    `track.gain × clip.volume`. The `peaks` are the SOURCE's own and are NOT
    scaled by it, so multiply if you want what reaches the speakers: a bed at
    `gain: 0.4` whose peaks read `0.8` is heard at `0.32`. Compare two clips'
    loudness by their peaks AND their gains, never by peaks alone.

    `source: null` is a normal answer, not an error: a gap, a title/adjustment
    clip, a muted audio track, or past the end of the timeline. It resolves the
    one audible source the way playback does — a real audio track first
    (topmost wins), otherwise the video clip's own embedded audio unless that
    clip is A/V-linked (D-129). **One source, not the mix** — where several
    clips overlap this frame, playback sums all of them and this reports only
    the winner (see D-232; the mix is a roadmap follow-up)."#
    )]
    pub async fn editor_get_waveform(
        &self,
        Parameters(p): Parameters<EditorGetWaveformArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .put("frame", p.frame)
            .put("windowSecs", p.window_secs)
            .put("buckets", p.buckets);
        let env = self.op("editor_get_waveform", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_set_selection",
        description = r#"Set what the Edit tab has SELECTED — the write half of
    `editor_get_state`'s `selection`/`selectedGap` (D-216, roadmap item 26).
    Until this existed, selection was readable and not writable, so nothing
    but a human's mouse click could put a clip into the selected state.

    **Why you would call this at all**, given that every editing capability
    already takes an explicit `track`/`clip` and needs no selection: the Edit
    tab has real surfaces that only exist FOR a selection, and this is the
    only way to reach them.

    - The **on-canvas transform box** (`TransformOverlay` — the box + corner
      handles drawn over the preview) renders only when EXACTLY ONE clip is
      selected. Without this tool, that whole surface is undrivable and, more
      to the point, uncheckable: pair this with `debug_screenshot` to actually
      SEE the box land on the picture (that is what this tool was built for —
      B-093/D-209 shipped with its on-canvas tier unverified because there was
      no way to select anything).
    - The **Inspector** shows a clip's own form under the same
      exactly-one-clip rule, so a screenshot of it is only meaningful once
      something is selected.
    - It also lets you leave the app in the state a human expects to find:
      select the clip you just added/moved so the user sees it highlighted.

    **Arguments — pass exactly one of `clips` or `gap`.**

    `clips`: a list of `{"track": N, "clip": I}` or `{"track": N, "clipId":
    "..."}` entries. Both address forms are accepted because the two halves of
    this surface speak different dialects — `editor_get_state`/
    `editor_get_timeline` hand you ids, every mutating `editor_*` tool takes
    an index — and converting between them would otherwise cost you a round
    trip. `clipId` wins if you pass both. An index is only meaningful against
    the track's current Vec order, so prefer `clipId` if anything may have
    been reordered since you read the timeline.

    - Select one clip: `clips=[{"track": 0, "clip": 2}]`
    - Multi-select (the same thing cmd-click does in the GUI):
      `clips=[{"track": 0, "clip": 0}, {"track": 1, "clip": 3}]`
    - **Clear everything**: `clips=[]`

    `gap`: `{"track": N, "frame": F}` selects a GAP (empty space between two
    clips) instead — mutually exclusive with a clip selection, exactly as in
    the GUI. `frame` must fall inside a real gap (one with a clip after it);
    trailing empty space past the last clip is not a gap and is refused
    rather than silently selecting nothing. The response reports the gap's
    real `gapStart`/`gapEnd` bounds, so you can hand `gapStart` straight to
    `editor_remove_gap`, plus `closeable` (B-236): a real gap can still be
    one `editor_remove_gap` refuses — on a sync-locked timeline, when another
    sync-locked track has a clip straddling the gap's end (B-033) — and when
    it is `false`, `closeRefusedReason` is the reason, the same text the
    GUI's disabled Close Gap button shows.

    **Not undoable, by design** (D-216): selection is UI state, not document
    content — it is not part of the `Timeline` that gets persisted, so the
    undo stack has never carried it and neither does this. A human's click
    pushes nothing either; this behaves identically. Re-select with another
    call rather than looking for an undo.

    Every entry is validated against the live timeline — a bad track index,
    a bad clip index, or an unknown clip id is a real error, not a silently
    stored selection of something that does not exist.

    The response reads the selection straight back off the store, plus
    `singleClipSelected` (whether the on-canvas transform box / Inspector clip
    form will now draw) and, per selected clip, `trackLocked` (a locked
    track's clip still gets a box but no draggable corner handles) and
    `trackHidden`."#
    )]
    pub async fn editor_set_selection(
        &self,
        Parameters(p): Parameters<EditorSetSelectionArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new().put("clips", p.clips).put("gap", p.gap);
        let env = self.op("editor_set_selection", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_set_preview_zoom",
        description = r#"Zoom and pan the Edit tab's PREVIEW VIEWPORT — how big the composited
    frame is drawn on screen (D-218, roadmap item 25). The GUI half is the
    `−  100%  +` cluster at the right of the preview's transport bar, and
    ctrl/pinch-scroll over the picture.

    **This is display-only. It is NOT a clip's transform.** It changes nothing
    about what renders or exports — no `Clip.scale`, no `position_x`/
    `position_y`, no composition size. If you want the PICTURE to be bigger in
    the finished video, that is `editor_set_clip_transform`. This tool only
    magnifies your own view of the frame, exactly like zooming a photo viewer.

    **Why you would call it**: to inspect detail in a `debug_screenshot`. At
    fit, the preview is a ~960px-long-edge proxy of the whole frame, so a thin
    edge, a small title, or a colour boundary is a handful of pixels. Zoom to
    200-400% and pan to the area first and the same screenshot shows it
    legibly. Also worth setting back to `"fit"` when you are done, so the user
    does not find their viewer left magnified into a corner.

    `zoom`: a multiplier where **1 = fit** (the whole frame visible, the
    default), 2 = twice that size, 0.5 = half. Range 0.25-8; outside it the
    value is clamped and the response says so in `note`. Pass the string
    `"fit"` to reset zoom AND pan in one call — the same thing clicking the
    percentage readout does.

    `pan_x` / `pan_y`: which part of the picture the viewport looks at, as a
    fraction of the FITTED picture's width/height offset from centre —
    `0` is centred, positive moves the picture right/down (i.e. reveals what
    is to its left/top). Omitted → the current pan is kept. The legal range is
    `±(zoom - 1) / 2`, which is `0` at or below fit (there is nothing
    off-screen to pan to) and is reported back as `panLimit`.

    Not undoable, by design (same reasoning as `editor_set_selection`, D-216):
    a viewport zoom is UI state, not part of the `Timeline` document, so it is
    never persisted and never sits between the user and their last real edit
    on an undo. `editor_get_state` reports the current view as
    `previewZoom`."#
    )]
    pub async fn editor_set_preview_zoom(
        &self,
        Parameters(p): Parameters<EditorSetPreviewZoomArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("zoom", p.zoom)
            .put("panX", p.pan_x)
            .put("panY", p.pan_y);
        let env = self.op("editor_set_preview_zoom", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_import_media",
        description = r#"Import one or more absolute file paths into the project's shared media
    pool. Required before `editor_add_clip` can place them — that tool looks
    an item up by the `id`/`sourcePath` this one returns.

    A macOS screen recording's filename has a NARROW NO-BREAK SPACE (U+202F),
    not a regular space, before AM/PM — a hand-typed path with an ordinary
    space silently matches nothing. Resolve the real path via a shell glob or
    directory listing first; see `editor_get_capabilities` for the full story
    (docs/BUGS.md B-070). If this reports success but a later `editor_add_clip`
    on the same path still can't find the pool item, see B-073 there too —
    don't just retry.

    A path already in the pool is skipped, not duplicated — with one
    exception (B-073): an entry whose own first probe failed and therefore
    has no probed metadata is re-probed here and returned if it now succeeds,
    so re-importing really is a valid repair for that case. To repair such an
    item by id instead — keeping its id and every reference to it — use
    `editor_reprobe_media`.

    STILL IMAGES are importable too (D-292): `.png`, `.jpg`/`.jpeg`, `.webp`,
    `.tif`/`.tiff`, `.bmp`. They come back with an `image` key (width/height)
    where footage has `video`, and are placed by `editor_add_clip` on a video
    track with a synthesized duration — see that tool. Animated GIF and camera
    RAW are deliberately NOT importable: a GIF is not one frame, and RAW cannot
    be opened by the export engine."#
    )]
    pub async fn editor_import_media(
        &self,
        Parameters(p): Parameters<EditorImportMediaArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("paths", p.paths)
            .put("folder", p.folder);
        let env = self.op("editor_import_media", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_remove_media",
        description = r#"Remove one or more items from the project's shared media pool by id
    (`editor_import_media`'s/a pool item's own `id`, not a source path).
    Wraps the SAME `chroma_media_remove` Tauri command the GUI's own Sources
    panel delete action already calls — no separate/new removal logic.

    **For a pool item that is merely STALE or UNPROBED, reach for
    `editor_reprobe_media` first, not this** (B-073, fixed): that re-probes
    the item in place, keeping its id and every reference to it, which is
    almost always what you want for a source whose probe failed once or whose
    file has since been fixed. Remove is for an item you genuinely want gone
    from the pool — a wrong file, a duplicate, a path that will never come
    back.

    An id already gone from the pool (already removed, a stale id) is
    silently skipped, not an error — same "the caller's own already-rendered
    list can be stale" reasoning `chroma_media_remove` itself documents.
    Does not touch the file on disk (media is always referenced in place,
    never owned by the project) — only the pool's reference to it and its
    cached thumbnail.

    **A clip already placed on the timeline that references a removed item
    does NOT go offline, error, or get cascade-removed — investigated, not
    assumed.** A `Clip` copies its `source_path` from the pool item at the
    moment it's placed and never re-reads the pool afterward; only
    `Clip.media_id` — a back-link used for legacy grade-file migration
    bookkeeping, never for playback/rendering/export — goes stale. So a clip
    built from a removed pool item keeps playing/exporting fine as long as
    its source file is still on disk; it simply becomes invisible/unmanaged
    in the Sources panel and its `media_id` no longer resolves to any pool
    item. The response's `stillReferencedBy` array lists every timeline
    clip (by `track`/`clip` index and `clipId`) whose `media_id` matched one
    of the ids you just removed, so you can tell whether you just orphaned
    a live clip's pool entry before deciding whether that's what you
    wanted."#
    )]
    pub async fn editor_remove_media(
        &self,
        Parameters(p): Parameters<EditorRemoveMediaArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new().set("ids", p.ids);
        let env = self.op("editor_remove_media", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_list_media",
        description = r#"List everything in the project's shared media pool — every item's `id`,
    `name`, `sourcePath`, the bin it is filed in, its probed video metadata,
    and whether its source file is on disk right now.

    Call this before `editor_add_clip` whenever you did not import the item
    yourself in this session: `editor_add_clip` resolves a pool item by `id` or
    `sourcePath`, and this is the only way to learn either for media a human
    imported, a `new_project` seeded, or a Motion render produced.

    Reads through to disk (the same `chroma_media_list` the GUI's Sources panel
    lists from), not off a cached array — so it is also the way to check what
    an import actually did.

    **Every row carries `usable`, and an unusable one explains itself in
    `problem`.** `editor_add_clip` refuses any item that never probed
    successfully, and that refusal — not the pool state itself — is the symptom
    you would otherwise hit (see `docs/BUGS.md` B-073). The response's
    `unusable` array is the ids of exactly those items, so "which one is the
    broken one" is one call rather than a hand-read of `project.json`.
    `video.hasAudio: null` means "never probed for that", NOT "silent".

    **`video` vs `image` (D-292).** A row has exactly one of them. `video` is
    moving footage (or an audio-only source). `image` is a STILL — width and
    height only, because a still genuinely has no rate, duration or frame
    count; a still is usable with no frame count at all, and `editor_add_clip`
    synthesizes its length. Neither key present means the probe failed.

    `hasThumb` is a boolean, deliberately: the real thumbnail is a base64 JPEG
    data URL that would swamp this response and means nothing to you anyway.

    (D-266.)"#
    )]
    pub async fn editor_list_media(&self) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new();
        let env = self.op("editor_list_media", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_reprobe_media",
        description = r#"Re-probe media-pool items by id — the repair action for an item
    `editor_list_media` reports as `usable: false` (B-073, fixed).

    A pool item whose FIRST probe failed (an offline drive, a file still
    being written, a transient ffprobe error) is stored with no video
    metadata at all, so `editor_add_clip` refuses it: there is no frame count
    to place a clip with. Before this tool the item was also unrepairable —
    re-importing the identical path deduped to a no-op and nothing ever
    re-read it.

    **The sequence:** fix the underlying file problem (remount the drive,
    restore the file, wait for the write to finish), then call this with the
    ids `editor_list_media` listed in `unusable`. The item is re-probed in
    place and keeps its id, so every clip and reference that already points
    at it stays valid — unlike remove-and-re-import, which mints a new id.

    **Check `stillUnusable` in the response, don't assume it worked.** A
    source that is still unavailable comes back unchanged and honestly
    unusable rather than as a false success you would only discover at the
    next `editor_add_clip`. `unknownIds` lists any id that is not in the pool
    at all (skipped, not an error). Ids you did not name are never touched.

    On demand only, by design: a re-probe is a real ffprobe (plus a thumbnail
    regeneration if the source actually changed), so `editor_list_media` does
    not fire one for every row behind your back. Wraps the same
    `chroma_media_reprobe` command as the Sources panel's own "Re-probe" row
    action."#
    )]
    pub async fn editor_reprobe_media(
        &self,
        Parameters(p): Parameters<EditorReprobeMediaArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new().set("ids", p.ids);
        let env = self.op("editor_reprobe_media", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_list_media_folders",
        description = r#"List the media pool's bins (D-045/D-059) with how many items each one
    holds, plus the count sitting at the pool `root`.

    A bin is a plain path string on an item (`"b-roll"`, `"b-roll/day1"`), not
    a separate entity — `folders` is the union of explicitly-created bins and
    bins implied by an item's own `folder`. The pool root is not a folder and
    never appears in the list; it is what `folder: null` means, and its item
    count is reported separately.

    `editor_list_media` returns the same `folders` list alongside the items, so
    this tool is for when you want the shape of the pool without its
    contents."#
    )]
    pub async fn editor_list_media_folders(&self) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new();
        let env = self.op("editor_list_media_folders", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_create_media_folder",
        description = r#"Create a bin in the media pool — the same "New folder" action the GUI's
    Sources panel offers, wrapping the same `chroma_media_create_folder`
    command.

    `path` is the whole bin path, `/`-separated for a nested bin
    (`"b-roll/day1"`), and the bin may stay empty: that is exactly what this
    command exists for, since a bin implied only by an item's `folder` string
    needs no creating at all (pass `folder` to `editor_import_media` or
    `editor_move_media` instead, and it is registered for you).

    Idempotent — creating a bin that already exists is a no-op, not an error.
    The response's `created` says which of the two happened, and `folders` is
    the full refreshed list."#
    )]
    pub async fn editor_create_media_folder(
        &self,
        Parameters(p): Parameters<EditorCreateMediaFolderArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new().set("path", p.path);
        let env = self.op("editor_create_media_folder", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_move_media",
        description = r#"Re-file one media-pool item into a different bin — the same move the
    GUI's Sources panel performs when a human drags an item onto a bin.

    `id` is a pool item's own id (`editor_list_media` reports them, as does
    `editor_import_media`'s result); a source path is not accepted, since the
    same path can only ever be in the pool once but the id is what the backend
    keys on.

    `folder` is REQUIRED and may be `None`, which means the pool root — the
    argument has no "leave it alone" value on purpose, because `None` already
    means something specific and a caller who omitted it would silently root
    the item. A bin named here that does not exist yet is registered on the
    way, so `editor_create_media_folder` first is optional.

    Filing is pure organisation: it changes nothing about the item's source
    path, its probe, any clip already placed from it, or any render."#
    )]
    pub async fn editor_move_media(
        &self,
        Parameters(p): Parameters<EditorMoveMediaArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new().set("id", p.id).set("folder", p.folder);
        let env = self.op("editor_move_media", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_edit_in",
        description = r#"Edit a media-pool source into the timeline using one of the SEVEN real
    edit types, rather than just placing it at a position (`editor_add_clip`).
    This is the same operation the app's own edit overlay performs when a clip
    is dragged onto the preview, so a human and you produce identical results.

    `edit_type` is one of, and every one of them acts at `at_frame` (the
    playhead by default) on `track` (the first video track by default):

    - `insert` — pushes everything at/after the playhead down to make room,
      splitting whatever clip the playhead is inside. The only type that
      lengthens the timeline by exactly the source's own length.
    - `overwrite` — writes over whatever is there for the new clip's length.
      Clips it lands inside are trimmed or split; clips it swallows whole are
      removed. Nothing's position changes: the timeline stays the same length.
    - `replace` — swaps the clip UNDER THE PLAYHEAD for this source, kept to
      that clip's exact start and exact length (the source is re-cut, not
      retimed). Refused if the source is too short to cover the slot — use
      `fit_to_fill` for that. Note this is NOT `editor_swap_clip_media`, which
      keeps the existing clip and only changes which file it points at,
      preserving its transform/keyframes/grade; `replace` is a new edit.
    - `fit_to_fill` — the same slot as `replace`, but the source keeps its full
      marked length and gets a flat speed ramp calculated to fill the slot
      exactly (see `editor_set_clip_speed`). Refused if that speed would fall
      outside 0.05x–20x.
    - `place_on_top` — puts the clip on the next video track ABOVE the
      destination that has room at the playhead, creating a new topmost video
      track if none has any. For titles, graphics, picture-in-picture. Nothing
      on the track below is disturbed. **The response's `track` is where it
      really landed, which may be a track that did not exist before, and every
      other track's index will have shifted down by one when that happens —
      re-read `editor_get_state` before addressing tracks by index again.**
    - `append` — after the last edit on the destination track, ignoring the
      playhead entirely.
    - `ripple_overwrite` — replaces the clip under the playhead even at a
      different length: a longer source pushes everything after it down, a
      shorter one pulls everything in, so no gap is ever left.

    Identify the source with `media_id` or `source_path` (import it first with
    `editor_import_media`), optionally trimmed to `[source_start,
    source_start+duration)` of its own frames exactly as `editor_add_clip`
    takes them.

    Every one of the seven is ONE undo entry, named for the edit type. A
    refused edit returns a real `error` sentence saying why and changes
    nothing — it is never a silent no-op. `insert` and `ripple_overwrite` are
    additionally refused when a sync-locked track has a clip straddling the
    frame they would ripple from (docs/BUGS.md B-033)."#
    )]
    pub async fn editor_edit_in(
        &self,
        Parameters(p): Parameters<EditorEditInArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("editType", p.edit_type)
            .put("mediaId", p.media_id)
            .put("sourcePath", p.source_path)
            .put("track", p.track)
            .put("atFrame", p.at_frame)
            .put("sourceStart", p.source_start)
            .put("duration", p.duration)
            .put("name", p.name);
        let env = self.op("editor_edit_in", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_text_fonts",
        description = r#"List the font families a text/title clip can use, and which of them
    this machine actually has a font file for.

    Call this once before your first `editor_add_text_clip` in a session. The
    `key` of each entry is what `font` takes on `editor_add_text_clip` /
    `editor_set_text_clip` — a catalogue key like "sans-bold", NOT a system
    font name like "Helvetica" and NOT a file path. A family whose
    `available` is false has no font file on this machine and will be
    refused: the live preview and the export both read the SAME file, so
    substituting a different face would make the exported title silently
    disagree with the one you previewed.

    Also returns `defaultTitle`, the exact text layer a title gets when you
    omit `font`/`size`/`color`.

    You normally do NOT need to read `group`/`bold`/`italic` off individual
    entries yourself (D-240): `editor_add_text_clip`/`editor_set_text_clip`/
    `editor_import_subtitles`/`editor_set_caption_style` all take `bold`/
    `italic` booleans directly and resolve the right catalogue key for you.
    They are here for the rare case you want to enumerate exactly which keys
    are siblings of which."#
    )]
    pub async fn editor_text_fonts(&self) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new();
        let env = self.op("editor_text_fonts", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_add_text_clip",
        description = r#"Add a TEXT / TITLE clip — real rendered text burned into the picture,
    in both the live preview and `editor_export`. This is what to use for a
    label, a lower third, an intro card or a "BEFORE"/"AFTER" tag; you never
    need to drop to raw `ffmpeg drawtext` for it.

    **Leave `track` out.** Omitted (the recommended call), the title lands on
    a BRAND-NEW video track inserted at index 0 — the top of the compositing
    stack, above everything you already have — in one atomic operation, which
    is exactly what the Edit tab's own Titles button does. A title is an
    OVERLAY: it has to sit on its own layer over the picture, not share a
    track with it. Sharing a track puts the title in a GAP in your footage,
    where it renders over BLACK instead of over the shot (B-129 — this is a
    real bug that shipped in a real project, caused by this parameter having
    been mandatory and this docstring having taught the dance below).

    Pass an explicit `track` only when you specifically want the title on an
    existing video track. It MUST be a video track: a title is picture, and
    putting one on an audio or subtitle track composites into nothing. That
    is now refused with a real message rather than silently accepted.

    **A title is otherwise an ordinary clip on an ordinary VIDEO track**, not
    a special track type — the same shape Resolve and Premiere use. Track
    index order is compositing z-order (lower index = on top). Every ordinary
    clip tool works on the title unchanged — `editor_move_clip`,
    `editor_trim_clip`, `editor_split_clip`, `editor_remove_clip`,
    `editor_set_clip_fade`.

    **The result reports the track it really landed on, `createdTrack` (did
    this call make a new one) and the new `trackCount`.** A new track at index
    0 renumbers every existing track by one, so re-read indices from the
    result — or from `editor_get_state` — before your next call rather than
    reusing indices you held from before.

    `content` is a SINGLE line — multi-line titles are not supported yet and
    a `\n` is refused rather than silently flattened. Add a second title
    clip on a second track for a second line.

    `duration` is in TIMELINE frames (default: 3 seconds at the project's own
    rate). `start_frame` places it at an exact timeline frame (default:
    appended after whatever is already on that track); `ripple=True` shifts
    later clips on that track out of the way instead of refusing to overlap.

    `font` is a catalogue KEY from `editor_text_fonts` (default "sans-bold").
    `size` is a fraction of the OUTPUT FRAME'S HEIGHT, not pixels — 0.12 (the
    default) is a big title, 0.05 is a modest caption. Deliberately a
    fraction, so the same title renders identically at every preview quality
    and at full export resolution. `color` is `#RGB` or `#RRGGBB`.

    `bold`/`italic` toggle weight/slant WITHOUT you having to know which raw
    catalogue key is which (D-240) — pass either on top of any `font`
    ("sans", "serif", "condensed", "mono" all have real bold/italic/bold-italic
    faces; omitting `font` composes against the current/default family). A
    family with no such face on this machine (`impact`, `sans-black` — neither
    ships an italic, and both are already at their own maximum weight) just
    ignores whichever toggle it cannot honour rather than erroring.

    **What else you can do to a title:** its OPACITY and POSITION are
    ordinary clip properties — `editor_set_clip_transform` with
    `position_x`/`position_y` (fractions of the frame, 0,0 = centred) and
    `opacity`, and `editor_set_clip_keyframes` animates either of them, the
    same way it animates a video clip's. `editor_set_clip_fade` fades it in
    and out.

    **What you cannot do (it is refused, not ignored):** `scale`, `rotation`,
    `crop_*` and `box_width`/`box_height` do NOT apply to a title in either
    the preview or the export. Use this tool's own `size` to make the text
    bigger — `editor_set_clip_transform` will return an error rather than
    store a value that would render nothing."#
    )]
    pub async fn editor_add_text_clip(
        &self,
        Parameters(p): Parameters<EditorAddTextClipArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("content", p.content)
            .set("ripple", p.ripple)
            .put("track", p.track)
            .put("startFrame", p.start_frame)
            .put("duration", p.duration)
            .put("font", p.font)
            .put("bold", p.bold)
            .put("italic", p.italic)
            .put("size", p.size)
            .put("color", p.color)
            .put("name", p.name);
        let env = self.op("editor_add_text_clip", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_set_text_clip",
        description = r#"Change an existing TEXT clip's own text properties. Omitted fields keep
    their current value — this reads the clip back first and merges, so
    changing the colour never resets the text.

    Refused if `track`/`clip` names a media clip rather than a title (a media
    clip has no text layer to patch), if the track is locked, if `content`
    contains a newline (single-line only for now), or if `font` names a
    family this machine has no font file for (see `editor_text_fonts`).

    `bold`/`italic` (D-240) toggle weight/slant against whatever `font` ends
    up being — pass `font` in the SAME call to change family and weight/slant
    together, or omit `font` to toggle bold/italic on the clip's CURRENT
    family without restating it (a bold-only call never resets the family).

    `size` is a fraction of the output frame's HEIGHT, `color` is
    `#RGB`/`#RRGGBB`. For a title's POSITION, OPACITY, fade or keyframes use
    the ordinary clip tools (`editor_set_clip_transform`,
    `editor_set_clip_keyframes`, `editor_set_clip_fade`) — a title is a real
    clip and those all work on it."#
    )]
    pub async fn editor_set_text_clip(
        &self,
        Parameters(p): Parameters<EditorSetTextClipArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("track", p.track)
            .set("clip", p.clip)
            .put("content", p.content)
            .put("font", p.font)
            .put("bold", p.bold)
            .put("italic", p.italic)
            .put("size", p.size)
            .put("color", p.color);
        let env = self.op("editor_set_text_clip", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_import_subtitles",
        description = r#"Import a SubRip (.srt) or WebVTT (.vtt) subtitle file as a new SUBTITLE
    track, with every cue placed and timed from the file.

    Adds ONE new track at the bottom of the track list and fills it with one
    caption clip per cue — a single undoable step, not one per cue. Returns the
    new track's index and how many cues landed.

    **TTML/XML/embedded-MXF subtitles are NOT supported** (D-228). That is a
    deliberate refusal, not an oversight: TTML cue times only resolve correctly
    once `ttp:timeBase`/`ttp:frameRate` are honoured, and a subset parser would
    import real broadcast files with silently wrong timings. Convert to .srt
    first.

    Timings come from the file and are converted to this project's own frame
    rate by the backend, so they cannot drift from what the GUI importer would
    produce. `offset_frames` shifts every cue — pass the playhead frame to drop
    a file in mid-timeline rather than at 00:00.

    The style arguments set the whole TRACK's style (the reference NLE's "Track
    Style"), which is how a whole imported file is styled in one action; every
    one of them is optional and defaults sensibly. Use
    `editor_set_caption_style` afterwards to change it, or to override one
    single cue.

    `bold`/`italic` (D-240) toggle weight/slant against `font` (or the
    catalogue default if `font` is omitted) — the same composition
    `editor_set_caption_style`'s own `bold`/`italic` use.

    `animation` and the per-word arguments (`active_color`, `spoken_color`,
    `upcoming_color`, `highlight_color`, `highlight_opacity`,
    `highlight_pad_x`, `highlight_pad_y`, `enter_secs`, `enter_rise`,
    `word_gap`) mean exactly what they mean on `editor_set_caption_style` — see
    that tool for each one. They are here so an imported file can land already
    animated in one call. Pass the literal string "default" to a per-word
    colour to CLEAR it rather than set it.

    A caption is positioned entirely by its style — `position_x`/`position_y`
    are normalised 0–1 anchors, `size` is a fraction of the frame HEIGHT.
    `editor_set_clip_transform` does NOT apply to captions."#
    )]
    pub async fn editor_import_subtitles(
        &self,
        Parameters(p): Parameters<EditorImportSubtitlesArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("path", p.path)
            .put("offsetFrames", p.offset_frames)
            .put("font", p.font)
            .put("bold", p.bold)
            .put("italic", p.italic)
            .put("size", p.size)
            .put("color", p.color)
            .put("boxEnabled", p.box_enabled)
            .put("boxColor", p.box_color)
            .put("boxOpacity", p.box_opacity)
            .put("align", p.align)
            .put("positionX", p.position_x)
            .put("positionY", p.position_y)
            .put("animation", p.animation)
            .put("highlightOpacity", p.highlight_opacity)
            .put("highlightPadX", p.highlight_pad_x)
            .put("highlightPadY", p.highlight_pad_y)
            .put("enterSecs", p.enter_secs)
            .put("enterRise", p.enter_rise)
            .put("wordGap", p.word_gap)
            .put(
                "activeColor",
                p.active_color.map(|v| {
                    if v == "default" {
                        Value::Null
                    } else {
                        Value::String(v)
                    }
                }),
            )
            .put(
                "spokenColor",
                p.spoken_color.map(|v| {
                    if v == "default" {
                        Value::Null
                    } else {
                        Value::String(v)
                    }
                }),
            )
            .put(
                "upcomingColor",
                p.upcoming_color.map(|v| {
                    if v == "default" {
                        Value::Null
                    } else {
                        Value::String(v)
                    }
                }),
            )
            .put(
                "highlightColor",
                p.highlight_color.map(|v| {
                    if v == "default" {
                        Value::Null
                    } else {
                        Value::String(v)
                    }
                }),
            );
        let env = self.op("editor_import_subtitles", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_export_subtitles",
        description = r#"Write one subtitle track's captions out as a standalone .srt or .vtt
    file (the format is chosen by `path`'s extension; anything else writes
    SubRip).

    This is the SIDECAR half of delivering subtitles. It is not needed to get
    captions into the video — `editor_export` already burns every visible
    subtitle track into the rendered picture. Use this when a platform wants
    the caption file separately.

    Cues are written in timeline order regardless of the order they were added
    in. Refused if `track` is not a subtitle track."#
    )]
    pub async fn editor_export_subtitles(
        &self,
        Parameters(p): Parameters<EditorExportSubtitlesArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new().set("track", p.track).set("path", p.path);
        let env = self.op("editor_export_subtitles", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_generate_captions_from_transcript",
        description = r#"Auto-caption a file straight from its D-189 transcript — the timed-word
    follow-up to `editor_import_subtitles` (D-229/D-238). Same result (a new
    SUBTITLE track, one caption clip per cue, one undoable step) with no
    hand-authored `.srt` required: this transcribes the file itself and groups
    the timed words into cues.

    **Auto-starts the transcript job and returns its `state`** — the same
    start-then-poll shape `editor_get_transcript` uses (`chroma::control`'s
    bridge caps at 20 s; a transcript takes tens of seconds). `state:
    "running"` or `"idle"` means: wait a few seconds and call this tool again
    with the SAME file — results are cached by path, so a repeat call costs
    nothing once done and captions are generated on that same call. `force`
    re-transcribes even if a result is cached (the file changed on disk).

    Identify the file with `path` (any absolute path, does not need to be
    imported first), or `media_id`/`source_path` for a project media-pool
    item — same resolution rule as `editor_get_transcript`.

    **Cue grouping** (see `packages/editor/src/captionsFromTranscript.ts` for
    the full reasoning): a transcript SEGMENT is always a cue boundary
    (the transcript's own segment breaks are reused as sentence/clause
    boundaries); within one segment a cue breaks at `max_words` words
    (default 8), `max_duration_s` seconds of source span (default 3.0), or a
    pause to the next word of at least `max_pause_gap_s` (default 0.7) —
    whichever comes first. Override any of the three for unusually fast/slow
    or unusually pause-heavy speech.

    Refused (with a real explanation) if the transcript came back with no
    word-level timestamps at all (silent/music-only footage, or a prior
    `editor_get_transcript` call that passed `word_timestamps=False`).

    `offset_frames` shifts every cue — pass the playhead frame to drop the
    track in mid-timeline rather than at 00:00. The style arguments are
    identical to `editor_import_subtitles`'s own (they set the whole new
    TRACK's style); use `editor_set_caption_style` afterwards to change it."#
    )]
    pub async fn editor_generate_captions_from_transcript(
        &self,
        Parameters(p): Parameters<EditorGenerateCaptionsFromTranscriptArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = media_args(p.path, p.media_id, p.source_path)
            .put_if("force", p.force)
            .put("offsetFrames", p.offset_frames)
            .put("maxWords", p.max_words)
            .put("maxDurationS", p.max_duration_s)
            .put("maxPauseGapS", p.max_pause_gap_s)
            .put("font", p.font)
            .put("size", p.size)
            .put("color", p.color)
            .put("boxEnabled", p.box_enabled)
            .put("boxColor", p.box_color)
            .put("boxOpacity", p.box_opacity)
            .put("align", p.align)
            .put("positionX", p.position_x)
            .put("positionY", p.position_y);
        let env = self
            .op("editor_generate_captions_from_transcript", args)
            .await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_add_caption",
        description = r#"Add ONE caption to an existing subtitle track — for writing captions by
    hand rather than importing a file.

    `track` must already be a subtitle track (`editor_add_track` with
    kind="subtitle"); adding a caption to a video or audio track is refused,
    because the compositor only ever looks for captions on subtitle tracks and
    it would be an invisible clip.

    Unlike a TITLE (`editor_add_text_clip`), `text` MAY contain newlines — a
    two-line cue is normal and renders identically in the preview and the
    export. `duration` defaults to 2 seconds' worth of frames.

    The caption's look comes from its track's style, not from this call — see
    `editor_set_caption_style`."#
    )]
    pub async fn editor_add_caption(
        &self,
        Parameters(p): Parameters<EditorAddCaptionArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("track", p.track)
            .set("text", p.text)
            .put("startFrame", p.start_frame)
            .put("duration", p.duration);
        let env = self.op("editor_add_caption", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_set_caption",
        description = r#"Change one existing caption's text. Newlines are allowed (that is what
    makes it a caption rather than a title).

    Refused if `track`/`clip` names something that is not a caption, or if the
    track is locked. A caption's TIMING is its clip's own timing — move or trim
    it with the ordinary clip tools (`editor_move_clip`, `editor_trim_clip`,
    `editor_split_clip`), which all work on a caption exactly as on any other
    clip."#
    )]
    pub async fn editor_set_caption(
        &self,
        Parameters(p): Parameters<EditorSetCaptionArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("track", p.track)
            .set("clip", p.clip)
            .set("text", p.text);
        let env = self.op("editor_set_caption", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_list_caption_presets",
        description = r#"List the styled caption looks the Styles library offers (D-243).

    Each entry carries its `id` (what `editor_add_caption_preset` takes), a
    label and group, a one-line description, the animation kind it uses, its
    provenance `note`, and the full `style` it would apply.

    This is the SAME list the Edit tab's Captions panel shows, read from the
    same place — an agent can reach every look a human can.

    Static data, but read through the app so it can never drift from what the
    panel is actually offering in this build."#
    )]
    pub async fn editor_list_caption_presets(&self) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new();
        let env = self.op("editor_list_caption_presets", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_add_caption_preset",
        description = r#"Apply a styled caption preset, creating what it needs (D-243).

    The one-call way to get a good-looking caption onto the timeline: it styles
    a subtitle track with the preset and, by default, drops a caption on it so
    the look is immediately visible.

    - `preset` — an id from `editor_list_caption_presets`. An unknown id is
      refused with the valid ids listed.
    - `track` — an existing SUBTITLE track to style. Omitted: the first
      subtitle track is reused, or a new one is created if there is none.
    - `text` — the caption to place. Omitted, a readable sample line is used,
      chosen so a per-word animation actually reads as animated.
    - `start_frame` — where to place it. Omitted: the playhead.
    - `duration` — TIMELINE frames. Omitted: 3 seconds, which is long enough
      that an animated preset resolves rather than flickering.
    - `place_caption` — pass False to restyle a track that already has cues on
      it without adding another.

    A preset is nothing but a style: everything it sets stays editable
    afterwards with `editor_set_caption_style`, and the whole thing is one
    undo step.

    Presets adapted from HyperFrames' caption catalogue (Apache-2.0,
    github.com/heygen-com/hyperframes) are reimplemented natively — see each
    preset's `note` for what differs and why (D-244)."#
    )]
    pub async fn editor_add_caption_preset(
        &self,
        Parameters(p): Parameters<EditorAddCaptionPresetArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("preset", p.preset)
            .set("placeCaption", p.place_caption)
            .put("track", p.track)
            .put("text", p.text)
            .put("startFrame", p.start_frame)
            .put("duration", p.duration);
        let env = self.op("editor_add_caption_preset", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_set_caption_style",
        description = r#"Style a subtitle track — font, size, colour, background box, position
    and ANIMATION — or override the style of ONE caption on it.

    With `clip` omitted this sets the TRACK's style, which every caption on it
    uses. That is almost always what you want: a whole imported file is styled
    once. With `clip` given it sets that one cue's own override; pass
    `use_track_style=True` with a `clip` to drop the override and go back to
    the track's style.

    Omitted fields keep their current value.

    - `font` — a catalogue key from `editor_text_fonts` ("sans-bold", …), not a
      system font name. A family this machine has no file for is refused here
      rather than failing the export, because the preview and the export must
      read the same file.
    - `bold` / `italic` (D-240) — toggle weight/slant against whatever `font`
      ends up being: pass `font` in the SAME call to change family and
      weight/slant together, or omit `font` to toggle bold/italic on the
      CURRENT style's family (the cue's own if it has an override, else the
      track's) without restating it. A family with no such face on this
      machine (`impact`, `sans-black`) ignores whichever toggle it cannot
      honour rather than erroring.
    - `size` — fraction of the frame HEIGHT (0.055 ≈ a normal subtitle).
    - `color` / `box_color` — `#RGB` or `#RRGGBB`.
    - `box_opacity` — 0–1. `box_enabled=False` removes the background entirely.
    - `box_padding` / `line_spacing` — fractions of the resolved font size.
    - `align` — "left" | "center" | "right"; each LINE of a cue is aligned
      independently, which is the subtitle convention.
    - `position_x` / `position_y` — normalised 0–1 anchors. `position_y` is
      where the LAST line sits; extra lines of a multi-line cue stack UPWARD
      from it, so a cue growing to two lines keeps its bottom line put.

    These are the only geometry a caption has: `editor_set_clip_transform`,
    fades and opacity keyframes do NOT apply to a caption (D-228 — the export
    draws it with ffmpeg's `drawtext`, which cannot scale, rotate or crop a
    text box, so offering those would let the preview show something the export
    cannot reproduce).

    ## Animation (D-243)

    An animated caption is drawn WORD BY WORD. Word timings are derived from
    each word's length across the cue — a `.srt` carries no word timings — so
    they need no extra input.

    - `animation` — "none" (D-229's static caption, the default) | "highlight"
      (line stays up, the live word gets a filled box) | "karaoke" (line stays
      up, words recolour as they are spoken) | "slam" (one word at a time,
      sliding in from alternating sides) | "build" (the line assembles word by
      word). An unknown value is ignored rather than stored.
    - `active_color` / `spoken_color` / `upcoming_color` — per-word fills.
      Pass the literal string "default" to clear one back to the caption's own
      `color` (omitting it leaves it alone, which is a different thing).
    - `highlight_color` — the box behind the live word; "default" removes the
      box entirely, which is what separates a plain karaoke recolour from a
      highlight.
      `highlight_opacity` 0–1, `highlight_pad_x`/`highlight_pad_y` as fractions
      of the font size.
    - `enter_secs` — how long one word's entrance takes.
    - `enter_rise` — how far a word rises into place ("build" only), as a
      fraction of the font size.
    - `word_gap` — tracking between words, as a fraction of the font size. An
      animated caption positions each word itself, so this stands in for a
      space.

    **Deliberately absent: per-word SCALE.** ffmpeg's `fontsize` is the input
    to the very measurement that makes the preview and the export agree
    (D-212), so animating it would re-open a divergence D-229 closed. The
    highlight box is square and switches on/off per word for the same class of
    reason — `drawbox` has neither a corner radius nor an alpha expression.

    Every one of these is a plain style field, so a preset applied with
    `editor_add_caption_preset` can be adjusted afterwards with this tool."#
    )]
    pub async fn editor_set_caption_style(
        &self,
        Parameters(p): Parameters<EditorSetCaptionStyleArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("track", p.track)
            .put("clip", p.clip)
            .put("useTrackStyle", p.use_track_style)
            .put("font", p.font)
            .put("bold", p.bold)
            .put("italic", p.italic)
            .put("size", p.size)
            .put("color", p.color)
            .put("boxEnabled", p.box_enabled)
            .put("boxColor", p.box_color)
            .put("boxOpacity", p.box_opacity)
            .put("boxPadding", p.box_padding)
            .put("lineSpacing", p.line_spacing)
            .put("align", p.align)
            .put("positionX", p.position_x)
            .put("positionY", p.position_y)
            .put("animation", p.animation)
            .put("highlightOpacity", p.highlight_opacity)
            .put("highlightPadX", p.highlight_pad_x)
            .put("highlightPadY", p.highlight_pad_y)
            .put("enterSecs", p.enter_secs)
            .put("enterRise", p.enter_rise)
            .put("wordGap", p.word_gap)
            .put(
                "activeColor",
                p.active_color.map(|v| {
                    if v == "default" {
                        Value::Null
                    } else {
                        Value::String(v)
                    }
                }),
            )
            .put(
                "spokenColor",
                p.spoken_color.map(|v| {
                    if v == "default" {
                        Value::Null
                    } else {
                        Value::String(v)
                    }
                }),
            )
            .put(
                "upcomingColor",
                p.upcoming_color.map(|v| {
                    if v == "default" {
                        Value::Null
                    } else {
                        Value::String(v)
                    }
                }),
            )
            .put(
                "highlightColor",
                p.highlight_color.map(|v| {
                    if v == "default" {
                        Value::Null
                    } else {
                        Value::String(v)
                    }
                }),
            );
        let env = self.op("editor_set_caption_style", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_add_adjustment_clip",
        description = r#"Add an ADJUSTMENT CLIP — one colour correction applied top-down to
    EVERY clip beneath it on lower-priority tracks, for the span it covers.
    This is the tool for "warm the whole second half up", "desaturate this
    section", "lift the contrast across these three shots" — one clip
    instead of grading each shot individually (D-229).

    **It contributes no picture of its own.** It is an operator on whatever
    is composited under it, so the frame you see is your footage, corrected.
    Adding one changes nothing at all until you set a parameter.

    **Which clips it reaches is decided ENTIRELY by track index, and this is
    the one thing to get right.** Track index order is z-order: lower index =
    higher priority = on top. An adjustment clip affects every visible video
    track with a HIGHER index than its own — i.e. everything below it. So
    the topmost track grades the whole edit; an adjustment clip on the bottom
    track affects nothing and is the single most common way to be surprised by
    this tool.

    **So leave `track` out.** Omitted (the recommended call), the clip lands
    on a BRAND-NEW video track inserted at index 0 — the top of the stack, so
    it grades everything — in one atomic operation, which is what the Edit
    tab's own Effects button does. Pass an explicit `track` only to target an
    existing video track; it MUST be a video track, and an audio or subtitle
    one is now refused with a real message rather than silently accepted
    (B-129). The result reports the track it really landed on, `createdTrack`
    and the new `trackCount` — a new track at index 0 renumbers every existing
    track, so re-read indices from the result before your next call.

    **The five parameters**, each `-1.0..1.0` and `0` = no change. They are
    the Edit tab's own primary correction, not the Colorist's full grading
    stack (that is a separate surface with its own `set_*` tools, and it
    applies to ONE clip; this applies to a whole region of the timeline):
      `exposure`     — stops; a gain of 2^value. +0.5 is half a stop up.
      `contrast`     — about the mid-grey pivot. +1 doubles it, -1 goes flat.
      `saturation`   — -1 is greyscale, +1 is double.
      `temperature`  — positive is WARMER (red up, blue down), negative cooler.
      `tint`         — positive is MAGENTA (green down), negative greener.

    `duration` is in TIMELINE frames (default: 3 seconds at the project's own
    rate) — this is the span of the edit the correction covers.
    `start_frame` places it at an exact timeline frame (default: appended
    after whatever is already on that track); `ripple=True` shifts later
    clips on that track out of the way instead of refusing to overlap.

    **Stacking works**: two adjustment clips on two tracks compose, the lower
    one applying first. Every ordinary clip tool works on it unchanged —
    `editor_move_clip`, `editor_trim_clip`, `editor_split_clip`,
    `editor_remove_clip`.

    **Its OPACITY is how strongly the correction is mixed in** (`1.0` = full,
    `0.5` = half), via the ordinary `editor_set_clip_transform`. It is read
    STATICALLY: keyframing it or fading the clip will NOT animate the
    correction, in either the preview or the export, because ffmpeg fixes
    these filter coefficients when the filter starts. Position, scale,
    rotation and crop do not apply at all — the correction is full-frame.

    The preview and `editor_export` run the same maths, verified against real
    ffmpeg to within 1/255."#
    )]
    pub async fn editor_add_adjustment_clip(
        &self,
        Parameters(p): Parameters<EditorAddAdjustmentClipArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("ripple", p.ripple)
            .put("track", p.track)
            .put("startFrame", p.start_frame)
            .put("duration", p.duration)
            .put("exposure", p.exposure)
            .put("contrast", p.contrast)
            .put("saturation", p.saturation)
            .put("temperature", p.temperature)
            .put("tint", p.tint)
            .put("name", p.name);
        let env = self.op("editor_add_adjustment_clip", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_set_adjustment_clip",
        description = r#"Change an existing ADJUSTMENT CLIP's colour correction. Omitted
    parameters keep their current value — this merges against the clip's
    existing correction, so changing saturation never resets exposure.

    Each parameter is `-1.0..1.0`, `0` = no change; see
    `editor_add_adjustment_clip` for what each one does. Values outside the
    range are clamped rather than refused.

    Refused if `track`/`clip` names a clip that is not an adjustment clip, or
    if the track is locked.

    To change WHICH clips the correction reaches, move the adjustment clip to
    a different track (`editor_move_clip`) — it affects every visible video
    track with a higher index than its own. To change the SPAN it covers,
    trim or move it like any other clip. To change how strongly it is mixed
    in, set its `opacity` with `editor_set_clip_transform`."#
    )]
    pub async fn editor_set_adjustment_clip(
        &self,
        Parameters(p): Parameters<EditorSetAdjustmentClipArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("track", p.track)
            .set("clip", p.clip)
            .put("exposure", p.exposure)
            .put("contrast", p.contrast)
            .put("saturation", p.saturation)
            .put("temperature", p.temperature)
            .put("tint", p.tint);
        let env = self.op("editor_set_adjustment_clip", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_split_clip",
        description = r#"Split one clip on the timeline into two, at an exact TIMELINE frame.
    `track`/`clip` are the 0-based indices from `get_timeline`."#
    )]
    pub async fn editor_split_clip(
        &self,
        Parameters(p): Parameters<EditorSplitClipArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("track", p.track)
            .set("clip", p.clip)
            .set("atFrame", p.at_frame);
        let env = self.op("editor_split_clip", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_remove_clip",
        description = r#"Remove one clip from the timeline, leaving a gap in its place. Follow
    with `editor_remove_gap` to ripple-close the gap, or leave it if the gap
    is wanted (e.g. to hold a still frame of nothing).

    If the clip is one half of an A/V link group, removing it removes its
    linked partner too (the same as `editor_swap_clip_media`'s own A/V link
    but the OPPOSITE of that tool's behavior — that one deliberately does
    NOT propagate; this one deliberately does, matching the GUI's own
    delete). The response's `removed` list names every clip actually taken
    out, `{track, clip, id}` each, so a second deletion shows up here
    instead of only in a later `get_timeline` read (B-221)."#
    )]
    pub async fn editor_remove_clip(
        &self,
        Parameters(p): Parameters<EditorRemoveClipArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new().set("track", p.track).set("clip", p.clip);
        let env = self.op("editor_remove_clip", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_remove_gap",
        description = r#"Ripple-delete the empty gap on `track` at `frame` (any frame inside
    the gap works), shifting every later clip on that track earlier to close
    it. Does nothing to other tracks."#
    )]
    pub async fn editor_remove_gap(
        &self,
        Parameters(p): Parameters<EditorRemoveGapArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new().set("track", p.track).set("frame", p.frame);
        let env = self.op("editor_remove_gap", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_trim_clip",
        description = r#"Trim a clip's `edge` ("start" or "end") by `delta` frames — positive
    shortens the clip, negative extends it back into previously-trimmed
    source material (up to the source's own bounds).

    `ripple=False` (the default, and the behaviour this tool has always had):
    only this clip changes. Shortening leaves a real gap; extending is refused
    outright if the neighbour is in the way.

    `ripple=True` (D-235): everything after this clip on the SAME track shifts
    to follow the new out point, so no gap is opened and a neighbour no longer
    blocks the trim — it gets pushed instead. A head ripple leaves the clip's
    `start_frame` where it is and pulls the rest of the track in behind it.
    Sync-locked tracks ripple with it; a clip straddling the ripple point on
    one of them refuses the whole op rather than being split (B-033).

    This is the same edit the GUI's Alt/Option-drag on a clip edge performs
    (D-235's context-sensitive trim tool)."#
    )]
    pub async fn editor_trim_clip(
        &self,
        Parameters(p): Parameters<EditorTrimClipArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("track", p.track)
            .set("clip", p.clip)
            .set("edge", p.edge)
            .set("delta", p.delta)
            .set("ripple", p.ripple);
        let env = self.op("editor_trim_clip", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_roll_edit",
        description = r#"Roll the edit point at the END of `clip`: move the outgoing clip's out
    point and the incoming clip's in point together by `delta` TIMELINE frames
    (positive = later), so one side lengthens by exactly what the other loses
    and the sequence's total duration does not change (D-235).

    `clip` is the OUTGOING side — the clip BEFORE the cut. There must be a clip
    butted exactly against its end; across a gap there is no edit point to roll
    and the call does nothing. Clamped to whichever side runs out of source
    media first, and refused whole if neither side can absorb the delta.

    A/V link groups on either side roll in lockstep. This is the same edit the
    GUI performs when you Alt/Option-drag an edge that IS an edit point."#
    )]
    pub async fn editor_roll_edit(
        &self,
        Parameters(p): Parameters<EditorRollEditArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("track", p.track)
            .set("clip", p.clip)
            .set("delta", p.delta);
        let env = self.op("editor_roll_edit", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_slide_clip",
        description = r#"Slide a clip along the timeline by `delta` TIMELINE frames WITHOUT
    changing its own duration or its source window — its neighbours absorb the
    movement instead: the clip before it lengthens/shortens at its out point,
    the clip after it at its in point (D-235). "A slide is a roll between 3
    clips."

    Contrast the two neighbouring tools: `editor_move_clip` changes where the
    clip is and leaves the neighbours alone (opening or closing real gaps);
    `editor_slip_clip` changes what the clip SHOWS and moves nothing. A slide
    changes only where it sits between untouched cuts on either side.

    A side with no touching neighbour is clamped by the real free space there
    instead, so a slide still works at the head or tail of a track. Refused if
    there is neither a neighbour nor an obstacle on either side — that is a
    plain move, so use `editor_move_clip`. This is the same edit the GUI
    performs when you Alt/Option-drag the LOWER half of a clip's body."#
    )]
    pub async fn editor_slide_clip(
        &self,
        Parameters(p): Parameters<EditorSlideClipArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("track", p.track)
            .set("clip", p.clip)
            .set("delta", p.delta);
        let env = self.op("editor_slide_clip", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_slip_clip",
        description = r#"Slip a clip's SOURCE window WITHOUT moving it on the timeline: unlike
    `editor_trim_clip`, `start_frame` and `duration` both stay exactly fixed
    — only which part of the source media plays changes. `delta` shifts
    `source_start` by that many TIMELINE frames (positive = later source
    material, negative = earlier), clamped to the source's own `[0,
    source_len)` bounds.

    A clip that is part of an A/V link group slips in lockstep with the rest
    of the group (same reason `editor_trim_clip` does) — unlink it in the
    GUI's Unlink button first for an independent slip of just one half."#
    )]
    pub async fn editor_slip_clip(
        &self,
        Parameters(p): Parameters<EditorSlipClipArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("track", p.track)
            .set("clip", p.clip)
            .set("delta", p.delta);
        let env = self.op("editor_slip_clip", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_swap_clip_media",
        description = r#"Replace a clip's underlying source media in place — pass either
    `media_id` or `source_path` to identify the NEW already-imported
    (`editor_import_media`) pool item. Everything else about the clip is
    preserved exactly: `start_frame`, its full compositing transform
    (position/scale/box size/rotation/crop/opacity), keyframes, fades, and
    its A/V link group (the swap does NOT propagate to a linked clip — the
    two halves no longer necessarily share anything once one's file is
    replaced).

    If the new source is SHORTER than the clip's current source window,
    `source_start` is kept exactly where it was (if it still fits) and
    `duration` is shrunk to fit what remains — the clip's timeline footprint
    can shrink as a result (never `start_frame` itself), rather than this
    call being refused. `source_fps` is always re-read from the NEW source's
    own real probed rate, never carried over from the old one — before
    calling this on a clip whose length matters, consider whether you also
    want to re-trim/re-check it afterward with `get_timeline`.

    The new source may be a STILL IMAGE (D-292), and swapping TO one never
    shortens the clip: a still's synthesized extent is an hour. Swapping AWAY
    from one to real footage can, by the shrink rule above."#
    )]
    pub async fn editor_swap_clip_media(
        &self,
        Parameters(p): Parameters<EditorSwapClipMediaArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("track", p.track)
            .set("clip", p.clip)
            .put("mediaId", p.media_id)
            .put("sourcePath", p.source_path);
        let env = self.op("editor_swap_clip_media", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_move_clip",
        description = r#"Move a clip to `start_frame`, optionally onto a different track
    (`to_track`; default: stays on `from_track`). `ripple=True` shifts later
    clips out of the way rather than overlapping them."#
    )]
    pub async fn editor_move_clip(
        &self,
        Parameters(p): Parameters<EditorMoveClipArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("fromTrack", p.from_track)
            .set("clip", p.clip)
            .set("startFrame", p.start_frame)
            .set("ripple", p.ripple)
            .put("toTrack", p.to_track);
        let env = self.op("editor_move_clip", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_add_track",
        description = r#"Add a new, empty track to the timeline. `track_kind` is "video",
    "audio" or "subtitle". Returns the new track's index.

    A "subtitle" track is what `editor_add_caption` needs (D-228); it takes no
    part in the video z-order and nothing in the audio mix, so the paragraph
    below about compositing order does not apply to one. To bring in a whole
    `.srt`/`.vtt` file instead, use `editor_import_subtitles`, which creates
    its own track.

    **Track index order IS compositing z-order — lower index paints on top
    (D-086).** With `index` omitted this APPENDS at the highest index, i.e.
    the BOTTOM of the stack, which is NOT where a title/overlay wants to be.

    `index` (B-115) puts the new track at an exact position instead: `0` is
    the top of the compositing stack (above all existing footage — what you
    want for a title, an overlay or an adjustment clip), and `len(tracks)` is
    the same append you get by omitting it. Anything outside `0..len(tracks)`
    is refused with an error rather than silently appending. It is a
    convenience, not a new primitive — it runs exactly the `editor_add_track`
    + `editor_move_track` pair this docstring used to tell you to run
    yourself, which is also the pair the human GUI runs when a clip is dragged
    above the top track. Two undo entries either way; `editor_move_track`
    remains the tool for reordering tracks that already exist."#
    )]
    pub async fn editor_add_track(
        &self,
        Parameters(p): Parameters<EditorAddTrackArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("trackKind", p.track_kind)
            .put("index", p.index);
        let env = self.op("editor_add_track", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_move_track",
        description = r#"Reorder the track LIST itself — move the track currently at
    `from_index` so it ends up at `to_index`, shifting every track between
    the two by one to close the gap (exactly `Vec::remove(from)` then
    `insert(to, _)` — the identical primitive the GUI's own drag-to-reorder
    track headers already use, `apelles_timeline::Timeline::move_track`).

    **Track index order IS compositing z-order — lower index paints on
    top (D-086).** `editor_add_track` only ever appends at the highest index
    (the bottom of the stack), so this is the tool that gets a newly-added
    track compositing ABOVE existing footage: the normal real-world sequence
    for adding a title/overlay to a project that already has content is
    `editor_add_track()` (lands at, say, index 2 on a 2-track project) then
    `editor_move_track(from_index=2, to_index=0)` to bring it to the top,
    BEFORE placing a clip on it — see `editor_add_text_clip`'s own docstring
    for the full recipe.

    Both indices must name an EXISTING track (refused with an error
    otherwise, not a silent no-op) — this only reorders, it never creates or
    deletes a track. `from_index == to_index` is accepted and is a real
    no-op. Every clip on the moved track keeps its own position/trim/
    keyframes/fades exactly as they were — only its track's position in the
    list (hence its z-order) changes. Any clip selection the human GUI
    currently holds is remapped to follow its track through the reorder, the
    same way the GUI's own drag does, so an agent-driven reorder can never
    leave the human's on-screen selection silently pointing at the wrong
    track."#
    )]
    pub async fn editor_move_track(
        &self,
        Parameters(p): Parameters<EditorMoveTrackArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        // The wire keys are `from`/`to` — both Rust keywords and, on the Python side,
        // why that tool builds its arguments as a dict rather than as kwargs.
        let args = WireArgs::new()
            .set("from", p.from_index)
            .set("to", p.to_index);
        let env = self.op("editor_move_track", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_set_track_gain",
        description = r#"Set an audio track's linear gain multiplier (1.0 = unity, 0.0 = muted)."#
    )]
    pub async fn editor_set_track_gain(
        &self,
        Parameters(p): Parameters<EditorSetTrackGainArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new().set("track", p.track).set("gain", p.gain);
        let env = self.op("editor_set_track_gain", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_set_track_locked",
        description = r#"Lock or unlock a track. A locked track refuses per-clip edits
    (trim/split/remove/move/transform/keyframes) until unlocked."#
    )]
    pub async fn editor_set_track_locked(
        &self,
        Parameters(p): Parameters<EditorSetTrackLockedArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("track", p.track)
            .set("locked", p.locked);
        let env = self.op("editor_set_track_locked", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_set_track_hidden",
        description = r#"Show or hide a video track. A hidden track is skipped by both the
    live preview compositor and `editor_export`."#
    )]
    pub async fn editor_set_track_hidden(
        &self,
        Parameters(p): Parameters<EditorSetTrackHiddenArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("track", p.track)
            .set("hidden", p.hidden);
        let env = self.op("editor_set_track_hidden", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_list_markers",
        description = r#"Every marker on the current timeline, in frame order — a marker is a
    colour-coded, optionally titled flag pinned to a TIMELINE frame ("client
    wants a cut here", "sync point", "VFX shot start").

    Markers belong to the TIMELINE, not to any clip or track: there is no
    `track` argument on any of the four marker tools, and a marker survives
    the clip beneath it being trimmed, moved to another track, or deleted.
    They are pure annotation — nothing in the live preview or in
    `editor_export`'s output is affected by one.

    Each entry is `{id, frame, color, durationFrames, endFrame, name, note}`;
    `name`/`note` are `null` when unset. A marker may span a RANGE rather than
    flag one frame: `durationFrames` is 0 for a point marker (the default, and
    what every marker made before ranges existed is) and `endFrame` is the
    derived last frame it covers, inclusive — equal to `frame` for a point
    marker. `id` is what `editor_set_marker`/`editor_remove_marker` take.
    Also returns `palette`, the marker colour names `editor_add_marker` and
    `editor_set_marker` accept. `editor_get_timeline` reports the same list
    under its own `markers` key, so this tool is the cheap way to re-read just
    the markers after writing one."#
    )]
    pub async fn editor_list_markers(&self) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new();
        let env = self.op("editor_list_markers", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_add_marker",
        description = r#"Pin a marker to a timeline frame — the same action the GUI's Marker
    button and its `M` shortcut perform.

    `frame` omitted means "at the playhead", exactly like the GUI's own
    button, so `editor_set_playhead(...)` then `editor_add_marker()` is the
    natural pair. `color` is a palette NAME (blue, cyan, green, yellow, red,
    pink, purple, fuchsia, rose, lavender, sky, mint, lemon, sand, cocoa,
    cream — `editor_list_markers` returns the live list) or a raw `#RGB` /
    `#RRGGBB` hex; omitted gives blue, the same default DaVinci Resolve uses.
    `name` is the short title shown next to the flag on the ruler; `note` is
    longer free text visible only in the marker's own popover.

    `duration_frames` makes the marker span a RANGE rather than flag a single
    frame: omitted (or 0) is a point marker, the default and what every marker
    made before this parameter existed is. A ranged marker covers
    `frame` through `frame + duration_frames` inclusive and draws as a bar on
    the ruler instead of a pin. The response reports `durationFrames` and the
    derived `endFrame` for both kinds, so a point marker reads back as
    `durationFrames: 0` with `endFrame` equal to `frame`.

    A marker is real document content: it is written into `project.json` and
    a GUI undo (⌘Z) removes it, unlike `editor_set_selection` /
    `editor_set_preview_zoom`, which change only what the user is looking at.
    Any frame is legal, including one past the last clip. Returns the created
    marker including its generated `id`."#
    )]
    pub async fn editor_add_marker(
        &self,
        Parameters(p): Parameters<EditorAddMarkerArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .put("frame", p.frame)
            .put("color", p.color)
            .put("name", p.name)
            .put("note", p.note)
            .put("durationFrames", p.duration_frames);
        let env = self.op("editor_add_marker", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_set_marker",
        description = r#"Change an existing marker's frame, colour, span, title or note. `id`
    comes from `editor_list_markers` (or from `editor_add_marker`'s response).

    A PATCH, not a full replace: every argument you omit keeps its current
    value, so recolouring a marker needs no restating of its note. To CLEAR a
    title or a note, pass the empty string `""` for it — omitting it leaves it
    alone. `color` takes the same palette name or hex `editor_add_marker`
    does, and an unrecognised one is an error rather than a silent no-change.

    `duration_frames` follows the same convention: omitted leaves the span
    untouched, a positive number makes the marker span `frame` through
    `frame + duration_frames` inclusive, and **0 clears it back to a point
    marker** — the span's equivalent of passing `""` to clear a title.

    Moving a marker's `frame` re-sorts it into place; the list this and
    `editor_list_markers` report is always in frame order. Returns the marker
    as it now stands."#
    )]
    pub async fn editor_set_marker(
        &self,
        Parameters(p): Parameters<EditorSetMarkerArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("id", p.id)
            .put("frame", p.frame)
            .put("color", p.color)
            .put("name", p.name)
            .put("note", p.note)
            .put("durationFrames", p.duration_frames);
        let env = self.op("editor_set_marker", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_remove_marker",
        description = r#"Delete one marker. `id` comes from `editor_list_markers`. An unknown
    id is an error naming the ids that DO exist, not a silent no-op. Removing
    a marker touches nothing else on the timeline — no clip, no track, no
    ripple — and is undoable in the GUI like any other edit. Returns the
    marker that was removed."#
    )]
    pub async fn editor_remove_marker(
        &self,
        Parameters(p): Parameters<EditorRemoveMarkerArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new().set("id", p.id);
        let env = self.op("editor_remove_marker", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_list_transitions",
        description = r#"Every transition on the timeline — and, just as usefully, every real
    CUT a new one could go on.

    A transition sits at an EDIT POINT: the timeline frame where one clip ends
    and the next begins on the SAME video track (D-224). The clips themselves
    never overlap; the transition bridges the cut and reads each clip's handle
    media (see `editor_get_capabilities`'s `transitions` key). So this returns,
    per video track: `cuts` (the frames a transition may be added at) and
    `transitions` (what is already there).

    Each transition reports its stored `kind`/`atFrame`/`duration`/`alignment`/
    `color` AND its derived `windowStartFrame`/`windowEndFrame` (the frames it
    actually covers) plus `headHandleFrames`/`tailHandleFrames` (how much media
    outside its own trim each clip has to supply). Read the derived numbers
    rather than recomputing them — the centre alignment's integer halving is
    easy to get wrong by a frame.

    Pass `track` to narrow to one; omit it for all. Also returns the `kinds`
    this build supports, the legal `alignments`, and the default duration.
    `editor_get_timeline` reports the same per-track list under its own
    `transitions` key."#
    )]
    pub async fn editor_list_transitions(
        &self,
        Parameters(p): Parameters<EditorListTransitionsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new().put("track", p.track);
        let env = self.op("editor_list_transitions", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_add_transition",
        description = r#"Put a transition on a cut — the same action as dragging one out of the
    timeline's Transitions palette onto that cut.

    `kind` is `cross_dissolve` (the incoming clip fades up over the outgoing
    one — needs handle media on both) or `dip_to_color` (both clips dip through
    a solid colour — needs NO handle media, so it always works). `color` is a
    palette name or `#RRGGBB` hex and applies to `dip_to_color` only; omitted
    means black.

    `at_frame` omitted means "the cut nearest the playhead", so
    `editor_set_playhead(...)` then `editor_add_transition(track=0)` is the
    natural pair — the response says which cut it actually landed on.
    `at_frame` given must be an EXACT cut frame; `editor_list_transitions`
    reports the real ones and an inexact frame is an error listing them.

    `alignment` decides which clip pays for the transition, and it is not
    cosmetic: `center_at_cut` (the default) takes half its length of handle
    from each side, `start_at_cut` takes it all from the outgoing clip's tail
    and none from the incoming clip's head, `end_at_cut` is the mirror.

    Refused, with a real reason, rather than silently mangled: no cut there, a
    locked or non-video track, a window that would swallow a neighbouring clip,
    an overlap with another transition, or — for a cross dissolve —
    insufficient handle media, in which case the message names how many frames
    are missing and which alignment would fit. Returns the created transition
    including its generated `id` and its derived window."#
    )]
    pub async fn editor_add_transition(
        &self,
        Parameters(p): Parameters<EditorAddTransitionArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("track", p.track)
            .set("kind", p.kind)
            .set("alignment", p.alignment)
            .put("atFrame", p.at_frame)
            .put("durationFrames", p.duration_frames)
            .put("color", p.color);
        let env = self.op("editor_add_transition", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_set_transition",
        description = r#"Change a placed transition's type, length, alignment or dip colour.
    `id` comes from `editor_list_transitions` (or from
    `editor_add_transition`'s own response).

    A PATCH: every argument you omit keeps its current value. `at_frame` is
    deliberately NOT changeable — moving a transition to a different cut is
    removing it from one and adding it to another, and a patch that silently
    re-homed it would skip the placement checks the add path runs.

    The MERGED result must still be legal, so shortening a dissolve always
    works and lengthening one past its handle media is refused with the same
    message `editor_add_transition` would have given. Pass `color=""` to clear
    a dip back to black. Returns the transition as it now stands."#
    )]
    pub async fn editor_set_transition(
        &self,
        Parameters(p): Parameters<EditorSetTransitionArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("track", p.track)
            .set("id", p.id)
            .put("kind", p.kind)
            .put("durationFrames", p.duration_frames)
            .put("alignment", p.alignment)
            .put("color", p.color);
        let env = self.op("editor_set_transition", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_remove_transition",
        description = r#"Delete one transition, restoring the plain cut. `id` comes from
    `editor_list_transitions`. An unknown id is an error naming the ids that DO
    exist, not a silent no-op.

    Touches no clip: the two clips never moved to make room for the transition
    (they stay abutting and non-overlapping — D-224), so removing it re-trims
    nothing and ripples nothing. Undoable in the GUI like any other edit.
    Returns the transition that was removed."#
    )]
    pub async fn editor_remove_transition(
        &self,
        Parameters(p): Parameters<EditorRemoveTransitionArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new().set("track", p.track).set("id", p.id);
        let env = self.op("editor_remove_transition", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_set_clip_transform",
        description = r#"Set a clip's BASE (unkeyframed) compositing transform — e.g. to place
    it in one half of a stacked before/after comparison layout.
    (0..1), applied before `scale`. Omitted fields keep the clip's current
    value — this tool reads the clip back first, it never silently resets a
    field you didn't mention.

    **BASE means "the fallback for a property no keyframe names."** Per
    property, a keyframe overrides this value at every frame (D-208), so on
    an animated clip a field you set here can be a real, persisted write that
    changes no rendered frame. Check `chroma_keyframes` in
    `editor_get_state` first; to move a property that IS keyed, write a
    keyframe for it with `editor_set_clip_keyframes` instead — the same thing
    the GUI's on-canvas drag does (B-093/D-209).

    `scale` is a stacking/picture-in-picture primitive: it ties the
    overlay's width to the canvas, but its HEIGHT follows the CLIP'S OWN
    aspect ratio in the live preview (there is no 'stretch' option here —
    that only exists as `editor_export`'s `fit_overrides`, D-184). It does
    NOT alone produce an exact-height box like a full-width/half-canvas
    slot. Call `editor_get_capabilities` once before your first use of this
    tool for the full explanation and the crop-then-scale recipe for hitting
    an exact target box.

    `box_width`/`box_height` (D-193) are an INDEPENDENT-AXIS override —
    a fraction of the OUTPUT composition, same convention as
    `position_x`/`position_y` — that replaces `scale`'s natural-footprint
    sizing for that axis, making the crop-then-scale recipe above
    unnecessary for the common case. `scale` alone can only ever produce a
    box with the clip's own SOURCE aspect ratio (B-074's own finding,
    generalised past just fixing `editor_export`); `box_width`/`box_height`
    are how you place a clip into an arbitrary, differently-shaped region —
    e.g. `box_width=1.0, box_height=0.5` fills the full canvas width at
    exactly half its height, regardless of the clip's own resolution.
    Setting only one axis leaves the other on `scale`'s formula. Omit both
    to leave whatever override already exists (or its absence) untouched;
    pass `clear_box_width=True` / `clear_box_height=True` to explicitly
    remove a previously-set override and go back to `scale`-derived sizing
    on that axis (a bare `float | None` can't distinguish "not mentioned"
    from "clear it", since `None` is already this tool's own "not
    mentioned" convention for every other field — these two flags are the
    escape hatch for the one field pair where "explicitly go back to
    scale" is itself a real, distinct thing you might want to say).

    `corner_radius` (D-344) rounds the clip's placement box, in OUTPUT-CANVAS
    PIXELS — not a fraction, unlike every geometry field above it. `0` (the
    default) is square corners and renders byte-identically to a build without
    this feature. It is applied AFTER crop and scale and BEFORE rotation, so a
    rotated clip's rounded corners rotate with it, and it multiplies the
    existing alpha rather than replacing it, so it composes with crop, opacity,
    fades and dissolves. A radius larger than half the box's shorter side
    clamps to that, giving a pill or a circle rather than a degenerate shape.
    Keyframeable via `editor_set_clip_keyframes` under the same
    `corner_radius` name. Does NOT apply to a text/title clip or an adjustment
    clip — both are refused rather than silently ignored, for the same reason
    `scale` is."#
    )]
    pub async fn editor_set_clip_transform(
        &self,
        Parameters(p): Parameters<EditorSetClipTransformArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("track", p.track)
            .set("clip", p.clip)
            .put("opacity", p.opacity)
            .put("position_x", p.position_x)
            .put("position_y", p.position_y)
            .put("scale", p.scale)
            .put("rotation", p.rotation)
            .put("crop_left", p.crop_left)
            .put("crop_top", p.crop_top)
            .put("crop_right", p.crop_right)
            .put("crop_bottom", p.crop_bottom)
            .put("corner_radius", p.corner_radius);
        // The box size is the one pair with a CLEAR that outranks the value: the flag
        // sends an explicit null ("no box"), which an omitted argument cannot express,
        // and it wins over a value given in the same call.
        let args = match (p.clear_box_width, p.box_width) {
            (true, _) => args.set("box_width", Value::Null),
            (false, Some(w)) => args.set("box_width", w),
            (false, None) => args,
        };
        let args = match (p.clear_box_height, p.box_height) {
            (true, _) => args.set("box_height", Value::Null),
            (false, Some(h)) => args.set("box_height", h),
            (false, None) => args,
        };
        let env = self.op("editor_set_clip_transform", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_set_clip_audio",
        description = r#"Set ONE CLIP's own audio level and stereo position (D-223). `track` and
    `clip` are the 0-based indices from get_timeline.

    This is NOT `editor_set_track_gain`, and neither replaces the other: that
    one is the whole track's fader, this is one clip on it, and the mixer
    MULTIPLIES them. Turning down a track quietens every clip on it; this is
    how you quieten one line of dialogue, or place one clip in the stereo
    field, without touching its neighbours.

    - `volume` -- a LINEAR multiplier, 1.0 = unity, 0.5 ~= -6 dB, 0.0 = silent.
      Linear (not dB) deliberately, to match `editor_set_track_gain`'s own unit
      in the same signal chain. Floored at 0; NO ceiling -- values above 1
      really do boost, which the mixer's limiter then has to deal with.
    - `pan` -- -1.0 hard left, 0.0 centre, 1.0 hard right. Clamped to that
      range. The law is CONSTANT POWER with a 0 dB CENTRE, so a hard pan
      BOOSTS the destination channel by 3.01 dB rather than attenuating the
      other one: lower `volume` on the same call if the source is already near
      full scale. A mono source panned becomes stereo-positioned mono.

    Omitting a field leaves it exactly as it was -- unlike
    editor_set_clip_transform, whose omitted fields reset. Both are stored per
    CLIP and survive trim/split (a split gives both halves the same level).

    HOW IT COMPOSES, which is the thing to reason with rather than guess at:
    `track gain x clip volume x clip fade x track duck`, then the pan law
    splits that per channel. Every stage multiplies; none overrides another.
    So a clip already fading out is quieter still if you halve its volume, and
    a ducked track ducks a boosted clip too.

    WHAT IT AFFECTS: sound only. On an audio-track clip that is the whole clip.
    On a video clip it is that clip's own EMBEDDED audio -- and nothing at all
    once that audio has been unlinked into its own clip (D-129), which is where
    the level then lives. A title/text clip has no audio and ignores both.

    Both are KEYFRAMEABLE under the names "volume" and "pan" via
    editor_set_clip_keyframes -- that is how you write an automation ramp (a
    fade under dialogue, a pan sweep). Keyed values are interpolated linearly
    and applied per output sample, in the live mixer and in `editor_export`
    alike.

    Returns what was actually STORED, plus the two per-channel gains the pan
    resolves to and the track's own gain, so a caller can reason about the
    real level without re-deriving the law.

    Undoable: same store action and same undo stack the GUI's own Inspector
    Audio rows write to, so a human can Cmd+Z it."#
    )]
    pub async fn editor_set_clip_audio(
        &self,
        Parameters(p): Parameters<EditorSetClipAudioArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("track", p.track)
            .set("clip", p.clip)
            .put("volume", p.volume)
            .put("pan", p.pan);
        let env = self.op("editor_set_clip_audio", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_set_clip_eq",
        description = r#"Set ONE BAND of one clip's parametric EQ (D-224). `track` and `clip` are
    the 0-based indices from get_timeline; `band` is 0..3.

    This is the tool for shaping a clip's TONE, as distinct from its LEVEL
    (editor_set_clip_audio) and its track's fader (editor_set_track_gain). The
    real moves it exists for: cut rumble and handling noise out of dialogue
    (`kind="high_pass", freq_hz=80`), take the boxiness out of a room recording
    (`kind="peak", freq_hz=300, gain_db=-4, q=1.5`), add air to a voice
    (`kind="high_shelf", freq_hz=8000, gain_db=3`), or notch a hum
    (`kind="peak", freq_hz=60, gain_db=-18, q=8`).

    FOUR BANDS, matching DaVinci Resolve's own Clip Equalizer. A clip with no
    EQ yet gets the default strip on the first call -- low shelf 120 Hz, bell
    500 Hz, bell 2.5 kHz, high shelf 8 kHz, ALL AT 0 dB, i.e. completely inert
    until you give one a real gain or switch it to a pass filter.

    `kind` -- one of:
      - "peak"       a bell centred on freq_hz. The default, and how you make a
                     notch too (deep negative gain_db at a high q).
      - "low_shelf"  boost/cut everything BELOW freq_hz, flat above.
      - "high_shelf" boost/cut everything ABOVE freq_hz, flat below.
      - "high_pass"  2-pole roll-off below freq_hz. IGNORES gain_db.
      - "low_pass"   2-pole roll-off above freq_hz. IGNORES gain_db.
    `freq_hz` -- 20 .. 20000, clamped. Centre frequency for a bell, corner for
      a shelf or a pass filter (a shelf reaches HALF its gain at its corner and
      the full gain well past it; a Butterworth pass filter is -3 dB there).
    `gain_db` -- -24 .. +24, clamped. Ignored by the two pass kinds.
    `q` -- 0.1 .. 20, clamped. Higher is narrower. 0.707 (Butterworth) is the
      right default for a shelf or a pass filter; 1-2 is a musical bell, 6+ is
      a surgical notch.
    `enabled` -- per-band bypass. False keeps the band's settings but takes it
      out of the chain -- the only way to bypass a pass filter, which has no
      gain to zero.
    `clear=True` -- remove the clip's EQ entirely, back to unfiltered. Ignores
      every other field.

    Omitting a field leaves it exactly as it was, like editor_set_clip_audio
    and unlike editor_set_clip_transform. Set up a full EQ with one call per
    band.

    HOW IT COMPOSES: the EQ runs FIRST, on the clip's own audio as decoded,
    BEFORE `track gain x clip volume x clip fade x track duck` and before the
    pan. So a boost here really does make the clip louder, and the way to
    compensate is editor_set_clip_audio's `volume`.

    STATIC, NOT KEYFRAMEABLE -- deliberately, and this is the one real
    limitation to know about. ffmpeg's biquad filters parse their parameters
    once, as numbers, so a swept/animated EQ cannot be rendered at all; rather
    than offer a preview the export cannot reproduce, an EQ here is one setting
    for the whole clip. Split the clip if you need it to change part-way.
    (`volume` and `pan` ARE keyframeable -- see editor_set_clip_keyframes.)

    WHAT IT AFFECTS: sound only, exactly like editor_set_clip_audio. On an
    audio-track clip that is the whole clip; on a video clip it is that clip's
    EMBEDDED audio, and nothing at all once that audio has been unlinked into
    its own clip (D-129). A title/text clip has no audio and ignores it.

    Returns what was actually STORED (every field is clamped on the way in),
    a one-line summary of each band, `eqActive` (whether the EQ does anything
    at all -- an all-flat strip does not), and `responseDb`: the resulting
    curve in dB at nine standard frequencies, so you can check the move landed
    without re-deriving a biquad. Reason from `responseDb`, not from what you
    asked for.

    Undoable: same store action and same undo stack the GUI's own Inspector EQ
    section writes to, so a human can Cmd+Z it -- including a human dragging a
    band's own point on the Inspector's response graph (D-237), which writes
    through this exact op. `responseDb` is the same curve that graph draws
    (both read `eqResponseDb`), so it's the fastest way to check a drag or a
    call landed the same shape without a screenshot."#
    )]
    pub async fn editor_set_clip_eq(
        &self,
        Parameters(p): Parameters<EditorSetClipEqArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new().set("track", p.track).set("clip", p.clip);
        // `clear` is not one flag among the others: it wipes the strip, so it is sent
        // ALONE and every band argument in the same call is deliberately ignored.
        if p.clear {
            let env = self
                .op("editor_set_clip_eq", args.set("clear", true))
                .await?;
            return Ok(render::json_text(&env));
        }
        let args = args
            .put("band", p.band)
            .put("kind", p.kind)
            .put("freq_hz", p.freq_hz)
            .put("gain_db", p.gain_db)
            .put("q", p.q)
            .put("enabled", p.enabled);
        let env = self.op("editor_set_clip_eq", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_set_clip_highlights",
        description = r##"Draw HIGHLIGHTER-PEN sweeps on one clip's own picture (D-396): each box
    sweeps left to right like a marker while a phrase is spoken -- the effect
    newspaper and blog explainers use over a screenshot of the article. `track`
    and `clip` are the 0-based indices from get_timeline.

    `highlights` REPLACES the clip's whole list -- pass all of them every time,
    and pass [] to clear. Each entry is
    `{"box": [x0, y0, x1, y1], "at": <int>, "dur": <int>, "color": "#F2B63A",
    "opacity": 0.45}`; `color` and `opacity` are optional.
      - `box` -- fractions (0..1, top-left origin) of the clip's SOURCE
        image, NOT of the canvas. So a box stays on the words it was drawn over
        however the clip is later scaled, panned or keyframed: it is painted on
        the picture BEFORE the clip's crop, scale, rotation and keyframes.
      - `at` -- the clip SOURCE frame the sweep starts on, the same axis
        editor_set_clip_keyframes' `frame` uses. For a clip placed at timeline
        frame S with source_start B (1x speed), timeline frame F is source
        frame B + (F - S).
      - `dur` -- frames the sweep takes (0 reveals the whole box at `at`). The
        pen eases out (fast start, soft landing), hard square at its left edge,
        rounded at the leading tip.
    Once a box is swept it STAYS for the rest of the clip.

    The default stroke is a yellow-ochre at 0.45 opacity blended normally (not
    multiplied), chosen to read on a white article page AND on a dark one while
    keeping the text under it legible (measured contrast: 4.8:1 dark text on
    white, 4.1:1 light text on dark).

    Works on a video or still clip on a video track; a title, caption or
    adjustment clip has no picture of its own and is refused. Unlocked tracks
    only. A clip with no highlights renders byte-identically to before.

    Preview and export agree: the live preview, the compositor export and the
    ffmpeg filter-graph export all draw the same stroke (measured against real
    ffmpeg output). The ffmpeg path costs one per-pixel `geq` node per
    highlight, so prefer the compositor renderer for large frames.

    Don't know where the words are? editor_suggest_clip_highlights reads the
    picture's text and the narration over it and returns ready-to-apply entries.

    Returns what was actually STORED (frames are rounded to whole numbers and
    boxes are ordered and clamped), so read that back rather than assuming your
    request landed verbatim. Undoable: same store action and same undo stack the
    GUI's Highlights section writes to."##
    )]
    pub async fn editor_set_clip_highlights(
        &self,
        Parameters(p): Parameters<EditorSetClipHighlightsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("track", p.track)
            .set("clip", p.clip)
            .set("highlights", p.highlights);
        let env = self.op("editor_set_clip_highlights", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_suggest_clip_highlights",
        description = r#"Suggest highlighter-pen sweeps for one clip's picture, READ-ONLY (D-396/D-397).
    `track` and `clip` are the 0-based indices from get_timeline. Nothing is
    written: review the result, then apply it with editor_set_clip_highlights.

    What it does, all on-device: reads the text in the clip's picture with the
    macOS Vision framework (a still is read as it is; a video is read at the
    clip's first frame), reads the words being SPOKEN while the clip is on screen
    (narration on any track whose source has a finished transcript, so a
    voice-over on its own audio track counts), and matches the two. Each matched
    run of the spoken phrase (at least two content words, trimmed of leading and
    trailing filler like "the") becomes one box over those words in the picture,
    swept over exactly the frames the phrase is spoken. A phrase that wraps onto
    a second line becomes two boxes swept in order. Longer matches win, a word is
    claimed once, and a one-letter slip in a long word (OCR or ASR) is forgiven.

    If nothing matches -- nothing is spoken over the clip, or the narration is
    about something the picture does not say -- it falls back to the largest line
    of text in the picture, swept once at the clip's start, and says so
    (`basis: "headline"`). A picture with no text gives `basis: "none"` and no
    highlights.

    Returns `status: "ready"` with `highlights` (pass them straight to
    editor_set_clip_highlights), `basis` ("transcript" | "headline" | "none"),
    `phrases` (each matched phrase and the TIMELINE frames it is spoken over),
    `ocrWords` / `spokenWords` counts, and `notes` for anything worth knowing
    (a source that was not transcribed and was ignored, a failed transcript).
    Or `status: "transcribing"` while a source playing over the clip is still
    being transcribed (call again shortly), or `status: "needs_transcript"` when
    nothing playing over the clip has a transcript yet (run editor_get_transcript
    on the narration source, then call again). This tool never starts a
    transcription itself.

    Video or still clips on a video track only; a title, caption or adjustment
    clip has no picture to read. Boxes are fractions of the clip's SOURCE image
    and `at`/`dur` are clip source frames, exactly the units
    editor_set_clip_highlights takes."#
    )]
    pub async fn editor_suggest_clip_highlights(
        &self,
        Parameters(p): Parameters<EditorSuggestClipHighlightsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new().set("track", p.track).set("clip", p.clip);
        let env = self.op("editor_suggest_clip_highlights", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_set_clip_keyframes",
        description = r#"Animate a SINGLE clip's own transform over time — e.g. a zoom-in at
    the moment of a click. Keyframes are scoped to this one clip only (its
    own local timeline), never the whole track or timeline, so two clips on
    two different tracks can each zoom at their own moment while both stay
    visible throughout.

    `keyframes` REPLACES the clip's entire keyframe list — pass all of them
    every time, not just the one you're adding. Each entry is
    `{"frame": <source-frame-absolute int>, "params": {<subset of
    opacity/position_x/position_y/scale/rotation/corner_radius/crop_left/
    crop_top/crop_right/crop_bottom/volume/pan>: <number>}}`. Values are
    piecewise-linearly interpolated between keyframes, held constant before
    the first and after the last.

    `volume` and `pan` (D-223) are this clip's own AUDIO level and stereo
    position — the same two properties `editor_set_clip_audio` sets
    statically, keyed here for a real automation ramp. (A clip's EQ is NOT in
    that list and cannot be keyed — see editor_set_clip_eq for why.) They are applied per
    output SAMPLE (not per video frame) in both the live mixer and
    `editor_export`, so a ramp is smooth rather than stepped.

    Interpolation is PER PROPERTY (D-208): each param is resolved over only
    the keys that name it, so an entry naming a `params` SUBSET animates just
    those and leaves the rest alone rather than freezing them. A property
    with at least one key ignores its static `editor_set_clip_transform`
    value entirely — see `editor_get_capabilities`."#
    )]
    pub async fn editor_set_clip_keyframes(
        &self,
        Parameters(p): Parameters<EditorSetClipKeyframesArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("track", p.track)
            .set("clip", p.clip)
            .set("keyframes", p.keyframes);
        let env = self.op("editor_set_clip_keyframes", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_set_keyframe_ease",
        description = r#"Shape HOW one animated property moves between two of its keyframes —
    a real cubic-bezier ease, not just a named preset.

    By default every keyframe segment is LINEAR: the property changes at a
    constant rate and stops dead at the next key, which is what makes a
    machine-authored move read as machine-authored. This is the fix. It sets
    the ease on the segment that STARTS at `frame` and runs to `param`'s next
    keyframe.

    `param` is one of opacity / position_x / position_y / scale / rotation /
    corner_radius / crop_left / crop_top / crop_right / crop_bottom / volume /
    pan — the same names `editor_set_clip_keyframes` writes.

    `frame` is a clip SOURCE-frame-absolute number and must be an EXISTING
    keyframe of that property; if it is not, this reports the frames that do
    exist rather than silently doing nothing. Easing is per property, so the
    same frame can carry a different curve for `scale` than for `opacity`.

    `curve` is either a preset NAME -- exactly "linear" | "ease-in" |
    "ease-out" | "ease-in-out", no others (B-165: CSS's own "ease" is NOT one
    of them and is rejected) -- or four cubic-bezier control points
    [x1, y1, x2, y2]: the same model, and the same parser, as
    `editor_set_clip_fade`'s curves. `x` is progress from this keyframe to the
    next, `y` is how far through the value change you are at that progress.
    P0=(0,0)/P3=(1,1) are implicit, so an ease can never move a keyframe — both
    ends still hit their authored values exactly.

    `y` may go outside 0..1 on purpose: that is OVERSHOOT (anticipation, a
    bounce past the target and back). `x` is clamped to 0..1, because a control
    point outside the segment horizontally makes the curve non-invertible and
    meaningless. `curve=None` clears the ease back to linear.

    A typical natural move is "ease-in-out" on the middle segments and
    "ease-out" on the last one. Set it and then look: `editor_set_curve_editor`
    opens this exact curve in the GUI so a human can see and redrag it.

    The live preview and `editor_export` interpret the curve identically (the
    export approximates it as 20 linear steps per segment, well under one
    output quantisation step, because ffmpeg has no bezier solver).

    Undoable: same store action and same undo stack as the GUI's own curve
    editor, so a human can Cmd+Z it."#
    )]
    pub async fn editor_set_keyframe_ease(
        &self,
        Parameters(p): Parameters<EditorSetKeyframeEaseArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("track", p.track)
            .set("clip", p.clip)
            .set("param", p.param)
            .set("frame", p.frame)
            .put("curve", p.curve);
        let env = self.op("editor_set_keyframe_ease", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_set_curve_editor",
        description = r#"Open the GUI's timeline curve editor on one clip property's animation
    curve, or close it (`param=None`).

    This changes what is ON SCREEN, not the project — nothing here is saved or
    undoable. Use it to SHOW a human the curve you just set with
    `editor_set_keyframe_ease`: the lane opens under the timeline, time-aligned
    with the clip, with that property's keyframes on a real bezier curve whose
    control points they can drag.

    `param` must be a property the clip actually animates; if it is not, this
    reports which properties are animated rather than opening an empty lane."#
    )]
    pub async fn editor_set_curve_editor(
        &self,
        Parameters(p): Parameters<EditorSetCurveEditorArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .put("track", p.track)
            .put("clip", p.clip)
            .put("param", p.param);
        let env = self.op("editor_set_curve_editor", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_set_dynamic_zoom",
        description = r#"Animate a push-in or pull-out across a clip's WHOLE length by naming
    where it is framed at the start and where at the end — the shortcut for
    "slowly zoom into this shot", instead of computing keyframes by hand.

    This is the agent half of the Edit tab's Dynamic Zoom (D-234), the same
    feature a human drives by dragging a green (start) and a red (end) box in
    the viewer. Both interfaces run the identical box→keyframe math and write
    the identical op, so what you author here is what the boxes show, and vice
    versa. Calling this also turns those boxes on for the clip, so a human
    watching sees exactly what you did.

    `start` and `end` are `{"position_x": …, "position_y": …, "scale": …}` —
    the SAME three fields (and the same units) as editor_set_clip_transform:
    `position_*` are composition fractions offset from centre, `scale` is a
    multiplier where bigger = more zoomed IN. Everything is optional and the
    defaults are the useful ones:

    - omit `start` → the clip's CURRENT framing at its first frame;
    - omit `end` → that framing pushed in 1.2x (a gentle punch-in), or the
      clip's existing end framing if it already has a dynamic zoom;
    - omit a single FIELD inside either → the value that end already has, so
      `end={"scale": 1.4}` zooms without recentring the shot.

    `ease` is one of `linear` (default), `ease-in`, `ease-out`,
    `ease-in-out` — the same four curves editor_set_clip_fade offers.

    WHAT IT WRITES, exactly: ordinary `position_x`/`position_y`/`scale`
    keyframes on this one clip, spanning its whole source window. There is no
    separate 'dynamic zoom' object -- once written it is indistinguishable
    from keys you could have authored with editor_set_clip_keyframes, which
    means editor_get_state shows it, both the preview and editor_export
    already render it, and a human can Cmd+Z it. `linear` writes exactly two
    keys; any other ease is baked into ~21, because the keyframe model
    interpolates linearly between keys on both sides of the wire and sampling
    the curve is the only ease BOTH renderers reproduce.

    REPLACES, does not append: any existing `position_x`/`position_y`/`scale`
    keys on this clip are dropped first (a dynamic zoom spans the whole clip,
    so two overlapping animations of the same properties would be
    meaningless). Every OTHER animated property is left untouched -- opacity,
    rotation, the crop insets, volume, pan.

    REFUSED on a title/text clip (its scale is pinned to 1 by both renderers)
    and on an adjustment clip (its correction is full-frame, it has no
    geometry) rather than silently animating nothing.

    Returns the two framings actually used, the ease, the clip's source-frame
    span, how many keyframes were written, and `animates` -- false when the
    two framings came out identical, i.e. you wrote a hold rather than a
    zoom."#
    )]
    pub async fn editor_set_dynamic_zoom(
        &self,
        Parameters(p): Parameters<EditorSetDynamicZoomArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("track", p.track)
            .set("clip", p.clip)
            .put("start", p.start)
            .put("end", p.end)
            .put("ease", p.ease);
        let env = self.op("editor_set_dynamic_zoom", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_export",
        description = r#"Render the open project's ENTIRE multi-track timeline — every visible
    video track/clip, composited in z-order (track 0 on top), cropped,
    keyframed and speed-adjusted — to a single output file via ffmpeg. This
    is the only Edit-tab tool that produces a real output file;
    `editor_get_timeline` and every `editor_set_*`/`editor_add_*` tool above
    only change in-memory state.

    `width`/`height` are the output composition's pixel size (every clip's
    `position_x`/`position_y`/`scale` from `editor_set_clip_transform` are
    fractions of this). `fps` defaults to the timeline's own rate.
    `speed_overrides` is `{clip_id: multiplier}` (e.g. `{"clip-abc": 1.2}`)
    — an EXPORT-TIME-ONLY speed change; it does not touch the clip's stored
    trim/duration, so scrubbing it in the GUI still plays at 1x.

    **`scale` is a WIDTH fraction of the output composition, not a box
    shape (B-074)** — read this before compositing more than one clip onto
    a track/canvas. `overlay_width = width * clip.scale` always; the
    overlay's HEIGHT depends on `fit_overrides` (`{clip_id: "fit" |
    "stretch"}`, EXPORT-TIME-ONLY, mirrors `speed_overrides`'s own shape):
    `"fit"` (the default for any clip with no entry here) lets ffmpeg
    compute height from the clip's own real, post-crop aspect ratio — the
    overlay is correctly proportioned, undistorted, and generally will NOT
    exactly fill a target box unless you chose `width`/`height`/`scale` to
    make it so. `"stretch"` forces height to `height * clip.scale` too —
    i.e. the overlay ALWAYS has exactly the OUTPUT canvas's own aspect
    ratio, at any `scale`, regardless of the source's real shape (correct
    for a same-aspect picture-in-picture bubble, or a deliberate distort
    effect; wrong for fitting arbitrary footage into a differently-shaped
    region). Concretely: a full-width/half-height stacked layout (two clips,
    one per half of a 9:16 canvas) is mathematically impossible to get
    undistorted via `"stretch"` for ANY canvas size, because that box's
    aspect ratio necessarily differs from the canvas's own — use `"fit"`
    (the default) for that layout, and compute `position_y` yourself from
    the clip's own known resolution (`editor_import_media`'s probe result)
    to center or top-align the resulting box within its slot; ffmpeg
    round-trips height to the nearest even pixel count under `"fit"`, so
    treat the exact rendered height as approximate when computing that
    offset.

    **`source_start`/`duration`/a keyframe's `frame` are all in the CLIP's
    OWN native source frame rate (B-075), not this export's `fps`** —
    handled automatically as long as the clip has `source_fps` set (true for
    any clip placed via `editor_add_clip`), never something you need to
    convert yourself.

    `freeze_overrides` (`{clip_id: true}`, EXPORT-TIME-ONLY, D-188, mirrors
    `speed_overrides`'s own shape) holds a clip's own real LAST FRAME, frozen,
    for the rest of the export's total runtime instead of it simply
    disappearing once its own content ends — e.g. a shorter/sped-up clip
    stacked next to a longer one that keeps playing. A clip already at or
    past the overall total runtime is unaffected (no-op, never a
    negative-duration hold).

    D-197: real audio now mixes into the output automatically — every
    visible audio-track clip (gain/D-057, ducking/D-149, fade/D-147) plus a
    video clip's own embedded audio (unless A/V-linked, D-129, or its
    source isn't known to have audio), summed and soft-limited. No new
    parameter needed; read `editor_get_capabilities`'s `export.v1_scope`
    entry for the one real caveat (an unprobed video source's embedded audio
    conservatively defaults to silent).

    **This call blocks, and on a real project it WILL exceed the 20s frontend
    round trip — which is expected, and is not the export failing** (D-362,
    fixes B-231). A minutes-long export outlives that budget, so the bridge
    answers `ok: false` with a "no reply from the frontend" error while the
    render carries on and succeeds. On the `"compositor"` renderer this tool
    handles that for you: it then polls `editor_export_status` until the
    render really settles, and returns THAT outcome, so what you get back is
    the export's own answer rather than the timeout's. Call
    `editor_export_status` yourself at any point to watch progress, or to pick
    a render back up if this call is interrupted. The `"filter"` renderer
    reports no progress at all — nothing outside ffmpeg knows where it is — so
    there a timeout really does leave the output file as your only signal.

    **Loudness target (D-401) — `loudness_preset` / `loudness_lufs` /
    `true_peak_dbtp`.** By default the mix is written at whatever level the
    tracks sum to (often far too quiet for a platform: a real 15-minute export
    measured -21.6 LUFS). Pass `loudness_preset` `"youtube"` (-14 LUFS /
    -1 dBTP), `"broadcast"` (EBU R128, -23 LUFS / -1 dBTP) or `"podcast"`
    (-16 LUFS / -1 dBTP) to have the finished file measured (EBU R128) and
    corrected with one linear gain plus an oversampled true-peak limiter, then
    re-measured; `"off"` (the default) does nothing and leaves the output
    byte-identical to before. For a custom spec give `loudness_lufs` (-40 to
    -5) and optionally `true_peak_dbtp` (-9 to 0, default -1) INSTEAD of a
    preset — giving both is refused. The video stream is copied, never
    re-encoded; only the audio is rewritten (AAC 192k). The result's
    `loudness` object reports `before` and `after` (`integratedLufs`,
    `truePeakDbtp`, `loudnessRangeLu`), `gainDb`, `attempts` and `targetMet`;
    on the `"compositor"` renderer `editor_export_status` shows a
    `normalising` phase and carries the same `loudness` report. A silent or
    audio-less export is left untouched and says so in `loudness.skipped`.

    **`renderer` (D-350) — which engine composites the picture.**
    `"compositor"` renders every frame through the app's OWN live-preview
    compositor and pipes it into one ffmpeg process that only compresses and
    muxes; `"filter"` (the default, and everything described above) compiles
    the whole composite into an ffmpeg `-filter_complex` graph with one `-i`
    per clip. Prefer `"compositor"` for a HEAVILY CUT timeline — the filter
    path's memory and thread use both scale with the clip count
    (B-228/B-229/B-230: a real ~79-clip 4K project reached 56 GB and 3,065
    threads on one process), while the render path opens exactly one input
    whatever the clip count, and it is by construction the same picture the
    Edit tab previews. It is opt-in while it is phase 1: it does NOT yet
    support `speed_overrides`, `fit_overrides` or `freeze_overrides` (all
    EXPORT-TIME-ONLY knobs the live compositor has no notion of) and REFUSES
    rather than silently ignoring one."#
    )]
    pub async fn editor_export(
        &self,
        Parameters(p): Parameters<EditorExportArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let out_path = p.out_path.clone();
        let args = WireArgs::new()
            .set("outPath", p.out_path)
            .set("width", p.width)
            .set("height", p.height)
            .put("fps", p.fps)
            .put("speedOverrides", p.speed_overrides)
            .put("fitOverrides", p.fit_overrides)
            .put("freezeOverrides", p.freeze_overrides)
            .put("renderer", p.renderer)
            .put("loudnessPreset", p.loudness_preset)
            .put("loudnessLufs", p.loudness_lufs)
            .put("truePeakDbtp", p.true_peak_dbtp);
        let mut env = self.op("editor_export", args).await?;
        // D-362 (fixes B-231 facet 1) — the bridge's 20s budget is shorter than
        // a real export, so a healthy one reliably comes back as a transport
        // failure (`ok: false`) while the render is still going and will
        // succeed. That is the false negative B-231 is half made of. The render
        // publishes real progress on the compositor path, so rather than hand
        // the caller a verdict that is simply wrong, poll for the true one.
        if matches!(p.renderer, Some(ExportRenderer::Compositor))
            && !env.get("ok").and_then(Value::as_bool).unwrap_or(false)
        {
            env = self.await_compositor_export(env, &out_path).await;
        }
        // The result carries the whole ffmpeg argv, which is long, noisy and of no use
        // to a caller deciding what to do next — so it is dropped from the answer.
        if let Some(Value::Object(result)) = env.get_mut("result")
            && result.contains_key("args")
        {
            result.remove("args");
        }
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_export_status",
        description = r#"Poll the running — or most recently finished — `editor_export` render
    (D-362, fixes B-231). Takes no arguments, starts nothing, and is free to
    call as often as you like.

    **Read `state` first.** `running` (still going; poll again), `done` (the
    file is written and finalised), `failed` (`error` says why), `stalled`
    (see below), or `idle` (no export has run in this session).

    **`stalled` is a real, named failure and it matters.** It means a render
    worker wrote no frame at all for `stallTimeoutSecs`, so the export was
    declared hung, its encoder killed, and the render abandoned. **The output
    file is incomplete and was never finalised — it will not play, and it must
    not be used or shipped.** Re-run the export. Before D-362 this state
    reported nothing whatsoever: the file simply stopped growing and every
    other signal continued to look healthy, which is the whole of B-231's
    second half.

    **Progress.** `percent` (0-100) is the real fraction of the render —
    `framesWritten / framesTotal` summed across every concurrent segment, not
    an elapsed-time guess. `segmentsDone`/`segmentsTotal` and the per-segment
    `segments` rows report the shape of it, which the percentage alone cannot:
    four segments evenly at 78% and three finished with one wedged read the
    same overall and are very different situations. `etaMs` is a rough
    estimate taken from the slowest unfinished segment (a render ends when its
    last worker does). While `phase` is `concatenating` every frame is already
    rendered and the segments are being joined and the audio muxed.

    **Only the `"compositor"` renderer reports progress.** The `"filter"`
    renderer hands the whole job to one ffmpeg and learns nothing until it
    exits, so an export run that way is invisible here."#
    )]
    pub async fn editor_export_status(&self) -> Result<CallToolResult, ErrorData> {
        let env = self.op("editor_export_status", WireArgs::new()).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_export_fcpxml",
        description = r#"Export the open project's ENTIRE multi-track timeline as a real,
    standard **FCPXML 1.7** document — the Final Cut Pro X XML Interchange
    Format DaVinci Resolve and Final Cut Pro both import natively (D-196).
    Unlike `editor_export`, this produces no picture/audio at all — a text
    file describing the EDIT itself, so the same cuts/composite/trims can be
    finished in another NLE instead of (or in addition to) Apelles' own
    render.

    Verified against Apple's own real, published FCPXML 1.7 DTD (a real DTD
    validator, not a guess at the XML shape) — see
    `packages/editor/src/timelineInterchange.ts`'s own header doc and D-196
    in `docs/08-decisions.md` for the full field-mapping table. Real, honest
    scope, not a stub:

    MAPS: clip placement/trims (`start_frame`/`source_start`/`duration`),
    track z-order (Apelles' own "track 0 = topmost" convention becomes the
    HIGHEST fcpxml `lane` number), the compositing transform
    (`position_x`/`position_y`/`scale`/`box_width`/`box_height`/`rotation`),
    crop, static opacity, A/V `link_group` (exported as one shared FCPXML
    `<asset>` with the video half `srcEnable="video"` and the audio half
    `srcEnable="audio"` — the real FCP mechanism for "same file, video-only
    vs audio-only"), and audio track gain (`Track.gain`, as `adjust-volume`
    dB on every clip on that track).

    DOES NOT MAP, on purpose (each surfaces in this call's own `warnings`
    array when it actually applies to this timeline, never a silent drop):
    per-clip animated transform (`chroma_keyframes`), clip fades
    (`fade_in_frames`/`fade_out_frames`), audio ducking
    (`Track.duck_from`/`duck_db`/...) — FCPXML itself has no static
    equivalent for ducking, matching the format's own documented exclusion
    of audio volume automation — and `editor_export`'s own ffmpeg-only,
    non-persisted export-time parameters (`speed_overrides`/
    `fit_overrides`/`freeze_overrides`), which have no `Clip` field to read
    here at all.

    A clip's exact scale/crop conversion needs its SOURCE's real pixel
    resolution; this tool passes through whatever the media pool already has
    probed (`editor_import_media`'s result) automatically. A clip with no
    probed resolution (an offline source, or one added before probing)
    falls back to assuming the OUTPUT canvas's own aspect ratio — exact for
    a plain full-canvas clip, approximate for a scaled/cropped/PIP one, and
    always called out by name in `warnings` when it's actually load-bearing.

    `width`/`height` are the output composition's pixel size, the same
    convention `editor_export` already uses. `fps` defaults to the
    timeline's own exact rate. Does NOT export XMEML/FCP7 XML (the
    Premiere-targeted sibling interchange format) — a precise, scoped,
    not-yet-built follow-up, see D-196."#
    )]
    pub async fn editor_export_fcpxml(
        &self,
        Parameters(p): Parameters<EditorExportFcpxmlArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("outPath", p.out_path)
            .set("width", p.width)
            .set("height", p.height)
            .put("fps", p.fps)
            .put("projectName", p.project_name);
        let env = self.op("editor_export_fcpxml", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_get_transcript",
        description = r#"Start a word-level transcript of an audio/video file — "what was SAID,
    and when." Use this to find a moment by its SPOKEN content: a talking-head
    take where nothing changes visually but every content move is in the
    speech. Returns immediately with `state`; poll
    `editor_get_transcript_status` until `state` is `"done"`, then read
    `words` / `segments` / `text` off that response.

    **`state: "done"` can come back on this very first call** — results are
    cached per file, so a repeat ask costs nothing. `force=True` re-runs anyway
    (use it when the file on disk changed).

    Identify the file with `path` (any absolute path — it does NOT have to
    be imported first, since "what's in this file?" is usually the question you
    want answered BEFORE importing), or with `media_id`/`source_path` for an
    item already in the project's media pool.

    `language` is an ISO code ("en", "de", ...) for one of Parakeet's 25
    European languages, or omitted — Parakeet then picks the language itself and
    does not report which it chose. Languages outside that set (Hindi, for one,
    and so Hinglish) are unsupported: a named one is refused, and an omitted one
    comes back as fluent wrong English. `word_timestamps=True` (the default)
    gives per-word start/end times — the format you need to cut to an exact
    word; `False` is faster but segment-level only.

    Complements `editor_analyze_video`, does not overlap it: this finds NOTHING
    in silent or music-only footage. Roughly 12 s for a short clip, longer for
    a long one (Parakeet, local)."#
    )]
    pub async fn editor_get_transcript(
        &self,
        Parameters(p): Parameters<EditorGetTranscriptArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = media_args(p.path, p.media_id, p.source_path)
            // Always sent, unlike the rest: the handler reads it as a plain boolean.
            .set("wordTimestamps", p.word_timestamps)
            .put("language", p.language)
            .put_if("force", p.force);
        let env = self.op("editor_get_transcript", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_get_transcript_status",
        description = r#"Poll a transcript started by `editor_get_transcript`, identified by the
    same file. `state` is `"running"` (keep polling), `"done"` (the result is
    on this response: `text`, `segments`, and `words` with per-word
    `start`/`end` in source seconds), or `"idle"` (nothing was ever started for
    this file — call `editor_get_transcript` first). A failure comes back as an
    `error` instead."#
    )]
    pub async fn editor_get_transcript_status(
        &self,
        Parameters(p): Parameters<EditorGetTranscriptStatusArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = media_args(p.path, p.media_id, p.source_path);
        let env = self.op("editor_get_transcript_status", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_get_timeline_transcript",
        description = r#"Read what the WHOLE TIMELINE says, in timeline order and in TIMELINE
    frames — "what does this sequence say?" (D-329).

    **Use this, not `editor_get_transcript`, for any question about the
    sequence.** `editor_get_transcript` answers per FILE, in that file's own
    source seconds. A timeline is a set of trimmed, reordered windows onto one
    or more files, so a file's transcript contains speech you CUT OUT and gives
    times that are not where the words land in the edit. This tool does that
    mapping for you: it walks the clips in timeline order, keeps only the
    speech each clip actually shows, and converts every row to the timeline
    frame it plays at — at the clip's own `source_fps`, which is the step that
    is easy to get wrong by hand (a clip's `duration`/`source_start` are its
    OWN native frames while `start_frame` is a timeline frame; see B-077).

    It is the same stitch the Edit tab's Index panel renders, so what you read
    here is exactly what the user is looking at.

    Returns `rows`, in timeline order, each `{clipId, track, sourcePath,
    startFrame, endFrame, sourceStart, sourceEnd, text}`. `startFrame` is what
    to pass to `editor_set_playhead` to jump to that line. Also `fps`, and
    `sources`: one entry per distinct source FILE with `{path, clipCount,
    state}` — `clipCount` is how many clips play from it, and `state` is
    `"done"` / `"running"` / `"idle"` / `"error"`.

    **Transcription is per FILE, and a timeline usually reuses one file many
    times** (a silence cut makes dozens of clips from one `.MOV`), so a
    sequence of 40 clips typically needs one or two jobs, not 40. Pass
    `start=True` to kick off the missing ones — one per file, cached files
    skipped, and a previous failure retried. Then poll this same tool until
    `pending` is `0`. Each job is a full Parakeet run: seconds to
    tens of seconds per file.

    **`rows` is always usable, even while `pending > 0`** — it covers every
    file that IS transcribed, so a partly-transcribed timeline gives you real
    rows now rather than nothing. Finds nothing in silent or music-only
    footage, which is normal and not an error.

    Reads video tracks only (hidden tracks, title/adjustment clips and still
    images are skipped, and a still has no audio to transcribe)."#
    )]
    pub async fn editor_get_timeline_transcript(
        &self,
        Parameters(p): Parameters<EditorGetTimelineTranscriptArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new().put_if("start", p.start);
        let env = self.op("editor_get_timeline_transcript", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_detect_silences",
        description = r#"Find the stretches of a timeline clip — or of a WHOLE TRACK — where
    **nobody is speaking**: "where is the dead air." Uses a real on-device
    voice-activity model (Silero VAD, D-319) over the audio, so it needs no
    transcript.

    - `track` — required.
    - `clip` — **optional**. Name a clip index (`editor_get_timeline` lists
      them) to ask about that one clip. **Omit it to sweep every analysable
      clip on the track in a single call** (D-342, fixes B-216) — do this for
      any cleanup pass, because asking one clip at a time is how whole stretches
      of a long timeline get skipped. A sweep is one request no matter how many
      clips it covers; calling this per clip is one request each.
    - `min_silence_ms` — the shortest gap worth reporting (default 600). Below
      about 400 you start getting the pauses *inside* sentences, which are not
      cut points.
    - `force` — re-run even though this exact clip range and threshold has
      already been analysed (the answer is cached per range+threshold).

    Either way only each clip's OWN trimmed range is analysed, so a source
    trimmed to its second half never reports silence from material nobody sees.

    **Reading the answer: check `state` first** (D-321). A normal clip finishes
    inside this call and comes back `state: "done"` with `silences`. A long one
    comes back `state: "running"` — the detection is still going, so poll
    `editor_detect_silences_status` with the same arguments until it says
    `done`. The answer is held for you either way; it is never computed and
    thrown away.

    Each entry of `silences` carries `startSecs`/`endSecs` (source seconds, what
    was measured), `sourceStartFrame`/`sourceEndFrame` (the clip's own source
    frames) and `startFrame`/`endFrame` — **timeline** frames, which is what
    `editor_ripple_delete_ranges` takes. An empty list is a normal answer, not
    an error: that clip has no gap that long.

    **A SWEEP (no `clip`) answers in a different, aggregate shape**, built so
    the clips that need a decision are readable without scanning the rest:
    `flagged` is the clips that found something, in full, each with its own
    `clip` index and `silences`; `clean` is a bare list of clip indices that
    came back with nothing; `running` / `notStarted` / `failed` / `skipped` say
    what has not answered and why; `totals` counts all of it. Act on `flagged`.

    **Nothing is cut**, by either form. This proposes; you decide. Pass the
    ranges you accept to `editor_ripple_delete_ranges`."#
    )]
    pub async fn editor_detect_silences(
        &self,
        Parameters(p): Parameters<EditorDetectSilencesArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let mut args = WireArgs::new()
            .set("track", p.track)
            .put("clip", p.clip)
            .put("minSilenceMs", p.min_silence_ms);
        if p.force {
            args = args.set("force", true);
        }
        // D-321 — back on the default budget: the op now answers within its own
        // grace window or hands back a pollable `state: "running"`, so there is
        // nothing left for a 180s ceiling to protect against.
        let env = self.op("editor_detect_silences", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_detect_silences_status",
        description = r#"Poll a silence detection started by `editor_detect_silences` (D-321).

    Pass the SAME `track` / `clip` / `min_silence_ms` you started it with — a
    detection is cached per clip range and threshold, so different arguments are
    a different question and will read as `state: "idle"`.

    `clip` is optional here for the same reason it is on the start tool (D-342):
    **omit it to poll a whole-track sweep**, and the answer comes back in the
    same aggregate shape the sweep returned, one request for the whole track.

    `state` is `running` (still going — poll again), `done` (with `silences`,
    exactly as `editor_detect_silences` returns them) or `idle` (nothing was
    ever started at this threshold). Starting nothing itself, this is a pure
    read and free to call."#
    )]
    pub async fn editor_detect_silences_status(
        &self,
        Parameters(p): Parameters<EditorDetectSilencesStatusArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("track", p.track)
            .put("clip", p.clip)
            .put("minSilenceMs", p.min_silence_ms);
        let env = self.op("editor_detect_silences_status", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_detect_retakes",
        description = r#"Group the places in a timeline clip — or across a WHOLE TRACK — where the
    speaker **said the same line more than once**: the flubbed take, the
    stumble, the third attempt.

    Unlike `editor_detect_silences` this needs the transcript, because a retake
    is a fact about words. If one has not been made yet this starts it and
    returns `state: "running"` with a `note` — poll
    `editor_get_transcript_status`, then call this again. A transcript is made
    once per SOURCE FILE, so a sweep of fifty clips cut from one recording
    costs one transcription, not fifty.

    Once the words exist, the grouping itself follows the same start-then-poll
    contract as `editor_detect_silences` (D-321): `state: "done"` with `groups`
    if it finished inside this call, otherwise `state: "running"` — poll
    `editor_detect_retakes_status` with the same arguments. `force` re-runs a
    grouping that is already cached for this range and these thresholds.

    - `track` — required.
    - `clip` — **optional**. Name a clip index to ask about that one clip.
      **Omit it to sweep every analysable clip on the track in a single call**
      (D-342, fixes B-216) — do this for any cleanup pass. Asking one clip at a
      time is exactly how real retakes survived to a final cut. Either way the
      words are read across the whole continuous TAKE a clip belongs to rather
      than that clip alone (D-364, below); a named clip is still answered about
      on its own.
    - `similarity` — how alike two utterances must be to count as the same line
      (0..1, default 0.82).
    - `window_secs` — how far apart two takes may be (default 30). A line
      repeated half an hour later is a callback, not a retake.
    - `min_words` — a take with fewer than this many DISTINCT words is never
      grouped (default 3), which is what stops every "Yeah." pairing with every
      other one.
    - `max_span_utterances` — how many adjacent transcript utterances may be
      joined into one take (default 3). This is what finds a restart the ASR cut
      on segment boundaries of its own, which do not line up with the
      speaker's (D-327): a take is a SPAN of utterances, so one delivery can
      cover several. 1 restores the old utterance-to-utterance behaviour.
    - `phrase_min_words` — the detector's SECOND, independent signal (D-365):
      the shortest repeated PHRASE, in words, that marks two spans as one
      self-correction even when `similarity` says they are different sentences
      (default 3; **0 turns it off**). `similarity` asks "is this the same LINE
      again" and misses the equally common disfluency where a speaker repairs
      one phrase inside two otherwise-different sentences — measured on real
      footage, "and the third one called speculative speculating and the third
      one's called speculating speculative" against "speculative decoding okay
      and the third one call is speculative decoding and it's kind of clever"
      scores 0.495 against the 0.82 bar. A pair matched by EITHER signal is a
      group. The tradeoff is real and measured: across two whole real
      transcripts (698 utterance pairs) this arm newly admits 22 pairs, 21 of
      them genuine missed retakes and 1 a false positive — a deliberate
      parallel construction ("Every word turns itself into a question." /
      "Every other word turns itself into a kind of answer key..."), which text
      alone cannot tell from a repair. Groups found this way report a LOW
      `similarity`, so they sort to the top of anything ranked by it.
    - `recover_dark_regions` — **default true, and leave it that way** (D-349,
      B-216). The ASR's whole-file pass silently declines to transcribe some
      utterances inside windows it otherwise reads confidently: Parakeet
      dropped 19 stretches (about 93 s) across the three measured sources, with
      no error and no low-confidence score to filter on. Measured on Whisper,
      which this was first built against, the loss was **biased towards
      near-duplicate repeated material** — i.e. towards retakes — so grouping the raw transcript is
      blind in exactly the place this tool is looking. With this on, each clip's
      range is scanned for stretches where the VAD hears a voice and the
      transcript has no words, those windows are re-transcribed on their own,
      and the recovered lines are spliced in before grouping. The answer then
      carries `darkRegions` (how many holes were found),
      `recoveredUtterances` (how many grouped lines exist only because of it)
      and `unreadDarkRegions` (each located region no re-read could put words
      to, in source seconds — speech-like sound the transcript is still blind
      to; listen there before cutting across it, D-387).
      Set it false only when you already know the source is clean and want the
      answer in one round trip: the scan and each re-read are extra passes, so a
      first call typically returns `state: "transcribing"` once or twice more
      than it would otherwise.

    **Detection reads a continuous TAKE, not a clip** (D-364, fixes B-237).
    Consecutive clips cut from one uninterrupted stretch of one source file —
    what an earlier fine-grained silence pass leaves behind — are merged back
    into one run and grouped once. They have to be: a clip is routinely shorter
    than the sentence it is part of (the project this was measured on has clips
    of 0.25s and 0.58s), so a restart's two halves land in different clips and a
    view scoped to one clip can never hold both. Six of seven real retakes on
    that project spanned 2-5 clips each and were invisible for exactly that
    reason. A run stops at a change of source file, a jump backwards through the
    source, or more removed material than `window_secs` — nothing is compared
    that was never one take — and only material still ON the timeline is read,
    so a removed stretch between two clips of a run contributes nothing.

    Each group has `takes`, a `similarity` score, and `keep` — the index of the
    take this **suggests** keeping, which is the last one, normally what the
    speaker settled on. `keep` is a suggestion and nothing more: text alone
    cannot always tell a retake from a later line that merely extends an earlier
    one, so read the `text` before cutting.

    Each take carries its `text`, its `startSecs`/`endSecs`, the `clips` it
    lands in, and one `segments` entry per clip with the same three frame spaces
    `editor_detect_silences` returns. **A take inside one clip also carries the
    flat `startFrame`/`endFrame` it always did; a take that spans several does
    NOT** — no single range describes it, and a clamped one would quietly
    under-cut. Pass every entry of `segments` to `editor_ripple_delete_ranges`.

    A single-clip answer also carries `readAcrossClips` when the clip was read
    as part of a longer run: the clip indices that run covered.

    **A SWEEP (no `clip`) answers in a different, aggregate shape**: `flagged`
    is the clips that found something, in full, each with its own `clip` index
    and `groups`; `clean` is a bare list of clip indices with nothing in them;
    `running` / `transcribing` / `notStarted` / `failed` / `skipped` say what
    has not answered and why (`transcribing` is waiting on the words, not on
    the grouping); `totals` counts all of it, and `runs` says how many
    continuous takes the track's clips were read as. A group that spans several
    clips is reported ONCE, under the earliest clip it touches, with every clip
    it covers named inside its takes. Act on `flagged`.

    **Every group carries `status`** (D-382): the detector's groups go through
    the same deterministic coverage gate an `editor_propose_retakes` group
    does, mapped onto the track's words by word midpoint. `"verified"` means
    every word a cut would remove survives in the kept take; `"refused"` comes
    with `reason`, `reasonText` and `offending` — the words the cut would lose.
    This detector over-cuts (B-246), so do not cut a refused group unless the
    person has listened and asks for it. For your own judgement of the track
    instead, read it with `editor_get_word_transcript` and propose with
    `editor_propose_retakes`; this tool is the deterministic fallback.

    **Nothing is cut**, by either form. Pass the takes you want gone to
    `editor_ripple_delete_ranges`."#
    )]
    pub async fn editor_detect_retakes(
        &self,
        Parameters(p): Parameters<EditorDetectRetakesArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let mut args = WireArgs::new()
            .set("track", p.track)
            .put("clip", p.clip)
            .put("similarity", p.similarity)
            .put("windowSecs", p.window_secs)
            .put("minWords", p.min_words)
            .put("maxSpanUtterances", p.max_span_utterances)
            .put("phraseMinWords", p.phrase_min_words);
        if !p.recover_dark_regions {
            args = args.set("recoverDarkRegions", false);
        }
        if p.force {
            args = args.set("force", true);
        }
        let env = self.op("editor_detect_retakes", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_detect_retakes_status",
        description = r#"Poll a retake grouping started by `editor_detect_retakes` (D-321).

    Pass the SAME arguments you started it with — a grouping is cached per
    range and per threshold set, so different arguments read as `state: "idle"`.

    `clip` is optional here for the same reason it is on the start tool (D-342):
    **omit it to poll a whole-track sweep**, and the answer comes back in the
    same aggregate shape the sweep returned, one request for the whole track.

    Naming a clip polls the whole continuous take that clip belongs to (D-364,
    B-237) and reports the groups that actually touch the clip you named, so a
    poll and a sweep can never disagree about the same material.

    `state` is `running`, `done` (with `groups`, exactly as
    `editor_detect_retakes` returns them) or `idle`. If the transcript itself is
    still being made this reports that instead, with a `note` pointing at
    `editor_get_transcript_status` — the same answer the start tool gives, since
    there is nothing to group until there are words. `state: "transcribing"` can
    also mean the D-349 dark-region scan or one of its re-reads is still going;
    the `note` says which. Keep `recover_dark_regions` the same as you started
    with, for the same reason the thresholds must match. Polling carries a job
    the start tool began on to its answer (the scan's re-reads, then the
    grouping), so keep polling this rather than calling the start tool again
    (B-249). For arguments no start call used it is a pure read that starts
    nothing, and says so with `state: "idle"`."#
    )]
    pub async fn editor_detect_retakes_status(
        &self,
        Parameters(p): Parameters<EditorDetectRetakesStatusArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let mut args = WireArgs::new()
            .set("track", p.track)
            .put("clip", p.clip)
            .put("similarity", p.similarity)
            .put("windowSecs", p.window_secs)
            .put("minWords", p.min_words)
            .put("maxSpanUtterances", p.max_span_utterances)
            .put("phraseMinWords", p.phrase_min_words);
        if !p.recover_dark_regions {
            args = args.set("recoverDarkRegions", false);
        }
        let env = self.op("editor_detect_retakes_status", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_get_word_transcript",
        description = r#"Read one timeline track as numbered words, to find its RETAKES yourself
    (D-380). The app runs no model for this: you judge, it checks.

    Returns `text` — one word per line, `index<TAB>start-end<TAB>word`, times in
    the source file's seconds, with `--- segment` hint lines (a new segment also
    starts at every clip boundary) — plus `viewId`, `totalWords`, `offset`,
    `returned` and `nextOffset`. **The first page (offset 0) also carries
    `instructions`: the rules to judge by and how to answer. Read them before
    proposing anything.** They are the rules a blind evaluation measured at
    0.00 s of unique speech lost across nine runs.

    - `track` — required. The view is every clip on it that has audio, in play
      order, showing only the words those clips still show (a word belongs to
      the clip holding its midpoint).
    - `offset` / `max_words` — paging (default 2500 words a page, at most 4000).
      Indices are GLOBAL: page two starts at `nextOffset`, not at 0. Keep
      calling until `nextOffset` is null.
    - `start` — transcribe any source on the track that has no transcript yet
      (once per file). Until every source has one this answers
      `state: "transcribing"` and serves no words, because the indices would
      shift when the rest lands.

    **`viewId` is what your indices mean.** It changes whenever the track's
    words change — an edit, a newly finished transcript, an applied re-read —
    and `editor_propose_retakes` / `editor_retranscribe_words` refuse a stale
    one. Re-read and re-derive when that happens.

    `editor_detect_retakes` is the deterministic fallback detector; it does not
    read this view's judgement and is gated the same way (D-382). Nothing is
    cut by this tool."#
    )]
    pub async fn editor_get_word_transcript(
        &self,
        Parameters(p): Parameters<EditorGetWordTranscriptArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("track", p.track)
            .put("offset", p.offset)
            .put("maxWords", p.max_words)
            .put_if("start", p.start);
        let env = self.op("editor_get_word_transcript", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_propose_retakes",
        description = r#"Hand the app YOUR retake groups for one track, as word-index ranges from
    `editor_get_word_transcript` (D-380). Each group goes through a
    deterministic coverage gate and is stored for the person to review in the
    Recut panel. **Nothing is cut.**

    - `track` — required.
    - `view_id` — the `viewId` your indices were read under. A stale one is
      refused outright and nothing changes: re-read, re-derive, resubmit.
    - `groups` — `[{"line": str, "takes": [{"first": int, "last": int}, ...],
      "keep": int, "note": str, "confirm": {"<word index>": "<reason>"}}]`.
      Takes are inclusive word ranges in spoken order, non-overlapping; `keep`
      indexes `takes`. `line`, `note` and `confirm` are optional. **Each call
      REPLACES the track's whole set**, so send every group you still stand by.
      An empty list clears it (no `view_id` needed).

    The gate accepts a group only if every word a deleted take holds also
    survives in the kept take (stopwords, fillers, false starts and stutters
    forgiven; near-identical spellings of long words match). It cannot hear,
    and does not judge which take is better. Each group comes back as:

    - `verified` — the gate proved the deletions lose no word;
    - `ai_confirmed` — the gate refused on content, and you vouched for every
      word it named via `confirm`; shown to the person with your reasons;
    - `refused` — with `reason`, `reasonText` and `offending` (word indices and
      words). `notConfirmable: true` means the group is malformed or fights
      another group, so it must be fixed, not confirmed.

    **Resolving a refusal is your loop:** (1) narrow the take so unique words
    fall outside it; (2) if a word looks misheard, `editor_retranscribe_words`
    over that stretch and apply a better reading (the `viewId` then changes);
    (3) if the content truly survives (an inflection, a mishearing the re-read
    kept, a word only in the abandoned attempt), resubmit with `confirm` giving
    a reason for EVERY offending word; (4) otherwise drop it. An unresolved
    group stays `refused` and is still shown to the person, untickable.

    Each take carries its `text` and `segments` — the same timeline-frame
    entries `editor_detect_retakes` returns — so if the person asks you to cut,
    pass every segment of every non-kept take to `editor_ripple_delete_ranges`.
    Do not cut unless asked."#
    )]
    pub async fn editor_propose_retakes(
        &self,
        Parameters(p): Parameters<EditorProposeRetakesArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("track", p.track)
            .set("groups", p.groups)
            .put("viewId", p.view_id);
        let env = self.op("editor_propose_retakes", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_retranscribe_words",
        description = r#"Re-run the speech recogniser over a stretch of words, to check whether
    a word the coverage gate refused was misheard (D-380). ASR only — the app
    makes no judgement; deciding whether the new reading is better is yours.

    - `track`, `view_id` — as in `editor_propose_retakes`; a stale `view_id`
      is refused.
    - `first` / `last` — the inclusive word range to check (one source file,
      at most about a minute with context). The app re-reads that audio in
      isolation with ~2 s of context either side, never cutting a word in half.
    - `apply` — false (default): a PREVIEW. Returns `current` (the view's words
      in that window, with their indices) beside `reread` (the fresh reading)
      and `identical`; nothing changes. true: splice the reading into the
      file's transcript — for every consumer, the Transcript panel and the
      detectors included — and return the new `viewId`, the words now in the
      window with their new indices, and `indexShift` (how far every later
      index moved). Re-derive your groups, then resubmit with the new `viewId`.
    - `force` — re-run a re-read already cached for this window.

    A re-read takes a few seconds; one that outlasts this call answers
    `state: "running"` — call again with the same arguments to collect it.
    Nothing is cut."#
    )]
    pub async fn editor_retranscribe_words(
        &self,
        Parameters(p): Parameters<EditorRetranscribeWordsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("track", p.track)
            .set("viewId", p.view_id)
            .set("first", p.first)
            .set("last", p.last)
            .put_if("apply", p.apply)
            .put_if("force", p.force);
        let env = self.op("editor_retranscribe_words", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_music_edit",
        description = r#"Cut ONE music edit into a music bed now — a dropout, a stop-time
    breath, a dry section — as one undo step (D-408). The bed is razored at
    both edges, the middle is lifted (nothing ripples: the voice and picture
    never move), and the music fades out into the silence and back in after.

    - `track` — required: the AUDIO track holding the bed (several beds:
      name the one). An A/V-linked clip (a picture's own sound) is refused.
    - `kind` — `dropout` (default), `breath`, `dry_open`, `dry_cta` or
      `section_out`. A label for the reviewer; every kind is the same cut.
    - Exactly ONE anchor:
      - `start_frame` + `end_frame` — half-open timeline frames; or
      - `first_word` + `last_word` — inclusive word indices of the VOICE
        track's view from `editor_get_word_transcript`: music out from the
        first word's start to the last word's end (the punchline, the big
        number, the call to action plays dry); or
      - `before_word` (+ `length_frames`, default one second) — the stretch
        just before that word, music back ON the word (a stop-time breath
        before the product's name).
    - `word_track` + `view_id` — required with a word anchor: the voice track
      you read and the `viewId` it answered. A stale `view_id` is refused.
    - `fade_out_frames` (default 6) / `fade_in_frames` (default 8) —
      timeline frames, clamped to the piece they land on.
    - `mode` — `continuous` (default): the music re-enters where it would
      have been had it kept playing underneath. `pause`: it resumes from
      where it stopped (the re-entry slips earlier; only inside one bed clip).

    Refused with a reason when no music is under the range, the track is
    locked or not audio, or the range would remove the whole bed. For a set
    of story beats the person should review first, use
    `editor_propose_music_edits` instead."#
    )]
    pub async fn editor_music_edit(
        &self,
        Parameters(p): Parameters<EditorMusicEditArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("track", p.track)
            .put("kind", p.kind)
            .put("startFrame", p.start_frame)
            .put("endFrame", p.end_frame)
            .put("firstWord", p.first_word)
            .put("lastWord", p.last_word)
            .put("beforeWord", p.before_word)
            .put("lengthFrames", p.length_frames)
            .put("wordTrack", p.word_track)
            .put("viewId", p.view_id)
            .put("fadeOutFrames", p.fade_out_frames)
            .put("fadeInFrames", p.fade_in_frames)
            .put("mode", p.mode);
        let env = self.op("editor_music_edit", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_propose_music_edits",
        description = r#"Propose music edits on story beats for the person to review in the
    Music edits panel (D-408). **Nothing is cut.** Edit the music, don't just
    lay it under: a dry cold open, a dropout for the punchline or the big
    reveal, a one-second stop-time breath before the product's name, dry
    calls to action, section closers.

    - `track` — required: the AUDIO track holding the bed.
    - `edits` — `[{"kind": str, "reason": str, <one anchor>,
      "fade_out_frames": int, "fade_in_frames": int, "mode": str}]`. The
      anchor is `start_frame` + `end_frame`, `first_word` + `last_word`, or
      `before_word` (+ `length_frames`) — exactly as in `editor_music_edit`,
      which documents each field. `kind` and `reason` are what the person
      reads; give a reason for every edit. **Each call REPLACES the track's
      whole set**; an empty list clears it.
    - `word_track` + `view_id` — required when any edit uses a word anchor:
      the voice track read with `editor_get_word_transcript` and its `viewId`.
      A stale one refuses the whole call: re-read, re-derive, resubmit.

    A malformed edit refuses the call. An edit that is well-formed but cannot
    land on the timeline as it stands (no music there, the whole bed) is
    stored with its `problem` so the person sees it; fix and resubmit. Each
    edit comes back with its frames, words and an `id`.

    The person accepts, rejects or adjusts each, auditions it, and applies.
    Read their review with `editor_list_music_edits`; apply with
    `editor_apply_music_edits` only when they ask you to."#
    )]
    pub async fn editor_propose_music_edits(
        &self,
        Parameters(p): Parameters<EditorProposeMusicEditsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("track", p.track)
            .set("edits", p.edits)
            .put("wordTrack", p.word_track)
            .put("viewId", p.view_id);
        let env = self.op("editor_propose_music_edits", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_list_music_edits",
        description = r#"The music edits waiting for review, as the person has left them
    (D-408): per music track, every edit's `status` (`pending`, `accepted`,
    `rejected`), its kind, words, reason and frames (which the person may
    have adjusted), and a `problem` if it cannot land on the timeline as it
    stands now. `track` limits it to one bed. Read-only."#
    )]
    pub async fn editor_list_music_edits(
        &self,
        Parameters(p): Parameters<EditorListMusicEditsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new().put("track", p.track);
        let env = self.op("editor_list_music_edits", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_apply_music_edits",
        description = r#"Apply the reviewed music edits on one bed as ONE undo step (D-408) —
    the same as the Music edits panel's Apply button.

    - `track` — required: the AUDIO track holding the bed.
    - `include_pending` — false (default): only the edits the person
      ACCEPTED. true: also the ones still pending — only when the person has
      told you to apply your proposals. Rejected edits never apply.

    Each edit reports `applied` or its `reason`. Applied edits leave the
    review list; the rest stay there with their reason. Read the bed back
    with `editor_get_timeline` before reporting it done."#
    )]
    pub async fn editor_apply_music_edits(
        &self,
        Parameters(p): Parameters<EditorApplyMusicEditsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("track", p.track)
            .put_if("includePending", p.include_pending);
        let env = self.op("editor_apply_music_edits", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_detect_dark_regions",
        description = r#"Find the stretches of a clip where **there is speech nobody transcribed**
    (D-349, fixes the transcription half of B-216).

    The ASR's whole-file pass does not merely mis-hear some utterances — it can
    emit no words for them, inside a window it is otherwise reading
    confidently. There is no error, no warning and no low-confidence score to
    filter on, so the transcript reads plausibly and is missing a sentence.
    Measured on real footage with Parakeet: 19 dropped stretches (about 93 s)
    across three sources.

    This tool crosses the two signals the app already has — the acoustic VAD
    ("is anyone talking") and the transcript ("what was read") — and reports
    where they disagree.

    - `track` / `clip` — required. Only the clip's own trimmed source range is
      scanned. (No whole-track sweep: unlike the other two detectors, the
      answer here is normally consumed by `editor_detect_retakes`, which runs
      this automatically over every clip it groups.)
    - `min_dark_secs` — how much unaccounted-for speech a stretch must hold
      before it is flagged (default 1.2). Measured on a plateau: 1.0 to 1.5 give
      the same answer on both test files.
    - `max_word_secs` — a transcript word LONGER than this contributes no
      coverage. The default is NO bound: Parakeet cannot stretch a word across
      a hole, so there is nothing for a bound to catch. Pass a real value (e.g.
      2.0) only for a transcript from an aligner that can smear one word over
      a silent stretch.
    - `rms_floor_scale` — multiplier on the amplitude floor (default 1.0). The
      floor is calibrated **per file** from the quietest speech this recording's
      own transcript read correctly, never a constant — mic, gain and room
      differ per shoot. Below 1.0 trades precision for recall.

    `state: "done"` carries `regions`, each in the same three frame spaces
    `editor_detect_silences` returns, plus the `stretch…` bounds it was found in
    and its `rmsPeak`. It also carries `rmsFloor` / `calibrationSpans` /
    `gatedOut`: **`rmsFloor: null` means the range held too few
    well-transcribed utterances to calibrate a gate, so the answer is ungated**
    and "no regions" is weaker evidence than usual. Otherwise start-then-poll
    like the other two — `editor_detect_dark_regions_status` with the same
    arguments.

    **Nothing is cut and nothing is re-transcribed by this tool** — it reports.
    `editor_detect_retakes` is what re-reads these windows in isolation and
    splices the recovered words into the transcript it groups."#
    )]
    pub async fn editor_detect_dark_regions(
        &self,
        Parameters(p): Parameters<EditorDetectDarkRegionsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let mut args = WireArgs::new()
            .set("track", p.track)
            .set("clip", p.clip)
            .put("minDarkSecs", p.min_dark_secs)
            .put("maxWordSecs", p.max_word_secs)
            .put("rmsFloorScale", p.rms_floor_scale);
        if p.force {
            args = args.set("force", true);
        }
        let env = self.op("editor_detect_dark_regions", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_detect_dark_regions_status",
        description = r#"Poll a dark-region scan started by `editor_detect_dark_regions` (D-349).

    Pass the SAME arguments you started it with — a scan is cached per clip
    range and per threshold set, so different arguments read as `state: "idle"`.
    `state` is `running`, `done` (with `regions`, exactly as the start tool
    returns them) or `idle`. If the transcript itself is still being made this
    reports that instead, with a `note` pointing at
    `editor_get_transcript_status`: a dark region is defined against the
    transcript's own words, so there is nothing to compare the audio to until
    they exist. A pure read."#
    )]
    pub async fn editor_detect_dark_regions_status(
        &self,
        Parameters(p): Parameters<EditorDetectDarkRegionsStatusArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("track", p.track)
            .set("clip", p.clip)
            .put("minDarkSecs", p.min_dark_secs)
            .put("maxWordSecs", p.max_word_secs)
            .put("rmsFloorScale", p.rms_floor_scale);
        let env = self.op("editor_detect_dark_regions_status", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_ripple_delete_ranges",
        description = r#"Cut N stretches out of one track and close every gap behind them, **as a
    single edit** — the apply half of `editor_detect_silences` /
    `editor_detect_retakes`, and the same thing the Recut panel's Cut button
    does.

    - `track` — the track index to cut on.
    - `ranges` — a list of `{"startFrame": int, "endFrame": int}` in **TIMELINE**
      frames, half-open. The `startFrame`/`endFrame` of a detected silence or
      retake take are already in exactly this form.

    Ranges are sorted, merged and applied back-to-front for you, so overlapping
    or out-of-order input is safe and you never have to compensate for an
    earlier cut having moved a later one.

    One call is **one undo entry**, however many ranges it removes — which is
    the reason this exists rather than looping `editor_split_clip` +
    `editor_remove_clip` + `editor_remove_gap` yourself. The `undo` tool
    reverses the whole call as that one entry.

    **Read the answer; do not assume it (B-197).** `ok: true` means every range
    really was cut. A range that CANNOT be — a sync-locked track has a clip
    straddling the point its ripple would have to close (B-033), an A/V-linked
    partner cannot be razored there (D-129), the range describes no real
    material — is left ENTIRELY alone (its material stays, no half-cut hole),
    and the call answers `ok: false` with `applied` (how many ranges did land,
    still as one undo entry), `requested`, and `skipped`: each un-cut range's
    `startFrame`/`endFrame` and the `reason` it was refused. Re-read the
    timeline before trusting any frame number you were holding, or undo.
    Refused outright with an `error`, nothing applied, if the track is locked
    or not one range could be cut."#
    )]
    pub async fn editor_ripple_delete_ranges(
        &self,
        Parameters(p): Parameters<EditorRippleDeleteRangesArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("track", p.track)
            .set("ranges", p.ranges);
        let env = self.op("editor_ripple_delete_ranges", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_analyze_video",
        description = r#"Start a visual analysis of a video — "what CHANGED on screen, and when,"
    with EXACT timestamps. Returns immediately with `state`; poll
    `editor_analyze_video_status` until `"done"`, then read `events`
    (`[{time_s, event}]`) off that response.

    Timing comes from ffmpeg's own scene-change detection (deterministic,
    frame-accurate) and never from the model — the model only DESCRIBES a
    before/after frame pair at each detected moment, since a single static
    frame cannot show a click, a cut, or a spinner appearing; only the delta
    can. So `time_s` is trustworthy in a way a model-reported timestamp is not.

    Works well on anything with real visual change: screen recordings (clicks,
    spinners, toasts), ads, edited multi-shot footage. Finds NOTHING in a
    single continuous uncut shot (a talking head) — there is no scene change to
    key off; use `editor_get_transcript` for that content instead. The two are
    complementary, not alternatives.

    Identify the file with `path` (any absolute path — it does NOT have to
    be imported first, since "what's in this file?" is usually the question you
    want answered BEFORE importing), or with `media_id`/`source_path` for an
    item already in the project's media pool.

    `question` steers what each moment is described AS — "What UI event does
    this show?" for a screen recording, "What product or shot is this?" for an
    ad. The default is deliberately generic.

    `scene_threshold` (default 0.12, lower = more candidates), `min_gap_s`
    (1.0) and `max_candidates` (15) are CONTENT-DEPENDENT: the defaults were
    tuned against a slow screen recording, and a fast-cut ad or trailer has far
    more real cuts per second. **If the response has `truncated: true`,
    candidates were silently dropped at the cap — raise `max_candidates` and
    re-run.** For action-heavy footage raise `min_gap_s` too: sustained motion
    produces genuinely similar frames, which the model then describes
    similarly, a known and documented limit rather than a bug.

    Runs at roughly 4x realtime. Results are cached per file, so `state:
    "done"` can come back on this first call; `force=True` re-runs anyway."#
    )]
    pub async fn editor_analyze_video(
        &self,
        Parameters(p): Parameters<EditorAnalyzeVideoArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = media_args(p.path, p.media_id, p.source_path)
            .put("question", p.question)
            .put("sceneThreshold", p.scene_threshold)
            .put("minGapS", p.min_gap_s)
            .put("maxCandidates", p.max_candidates)
            .put_if("force", p.force);
        let env = self.op("editor_analyze_video", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "editor_analyze_video_status",
        description = r#"Poll an analysis started by `editor_analyze_video`, identified by the
    same file. `state` is `"running"` (keep polling), `"done"` (the result is
    on this response: `events` as `[{time_s, event}]`, plus `truncated` and
    `meta`), or `"idle"` (nothing was ever started for this file). A failure
    comes back as an `error` instead."#
    )]
    pub async fn editor_analyze_video_status(
        &self,
        Parameters(p): Parameters<EditorAnalyzeVideoStatusArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = media_args(p.path, p.media_id, p.source_path);
        let env = self.op("editor_analyze_video_status", args).await?;
        Ok(render::json_text(&env))
    }
}

/// **D-362 (fixes B-231) — how often, and for how long, `editor_export` waits
/// out a render whose own call already timed out on the bridge.**
///
/// Two seconds because an export is measured in minutes: second-by-second
/// resolution buys a poller nothing and each poll is a real HTTP round trip.
/// The ceiling is deliberately generous — the renderer's own stall watchdog is
/// what guarantees a HUNG export stops being `running` (within its own
/// timeout), so this one exists only to stop the tool blocking forever on a
/// render that is genuinely, honestly still going. Past it the last real status
/// is returned rather than an invented failure, and `editor_export_status`
/// picks up where this left off.
///
/// Twinned with `mcp/server.py`'s `EXPORT_POLL_INTERVAL_S`/`EXPORT_POLL_MAX_S`.
const EXPORT_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(2);
const EXPORT_POLL_MAX: std::time::Duration = std::time::Duration::from_secs(2 * 60 * 60);

impl ApellesMcp {
    /// Poll `editor_export_status` until the render really settles (D-362).
    ///
    /// Called only when `editor_export`'s own call came back as a transport
    /// failure — which, on a real export, is the expected outcome rather than a
    /// real one. Returns an envelope shaped like the one it replaces, so a
    /// caller cannot tell whether its export happened to fit inside the
    /// bridge's budget.
    async fn await_compositor_export(&self, env: Value, out_path: &str) -> Value {
        let deadline = std::time::Instant::now() + EXPORT_POLL_MAX;
        let mut status = Value::Null;
        while std::time::Instant::now() < deadline {
            // The app being genuinely unreachable IS the real failure, and it
            // is the one already in `env`.
            let Ok(polled) = self.op("editor_export_status", WireArgs::new()).await else {
                return env;
            };
            status = polled.get("result").cloned().unwrap_or(Value::Null);
            match status.get("state").and_then(Value::as_str) {
                // Nothing is running and nothing ever ran: the render never
                // started, so the original transport error is the honest answer.
                None | Some("idle") => return env,
                Some("running") => {}
                Some(state) => {
                    return settled_export(state == "done", &status, out_path);
                }
            }
            tokio::time::sleep(EXPORT_POLL_INTERVAL).await;
        }
        let mut late = settled_export(false, &status, out_path);
        if let Some(obj) = late.as_object_mut() {
            obj.insert(
                "error".into(),
                Value::String(format!(
                    "the export was still rendering after {}h — it has NOT failed and has not \
                     been stopped; poll editor_export_status to follow it",
                    EXPORT_POLL_MAX.as_secs() / 3600
                )),
            );
        }
        late
    }
}

/// The settled envelope [`ApellesMcp::await_compositor_export`] hands back:
/// the status as the `result`, with the output path the caller asked for
/// alongside it, since the status names the file the RENDERER was given.
fn settled_export(ok: bool, status: &Value, out_path: &str) -> Value {
    let mut result = serde_json::Map::new();
    result.insert("outPath".into(), Value::String(out_path.to_string()));
    if let Some(obj) = status.as_object() {
        for (k, v) in obj {
            result.insert(k.clone(), v.clone());
        }
    }
    serde_json::json!({
        "ok": ok,
        "error": status.get("error").cloned().unwrap_or(Value::Null),
        "result": Value::Object(result),
    })
}

/// This tab's contribution to the merged router.
pub fn router() -> rmcp::handler::server::router::tool::ToolRouter<ApellesMcp> {
    ApellesMcp::edit_router()
}

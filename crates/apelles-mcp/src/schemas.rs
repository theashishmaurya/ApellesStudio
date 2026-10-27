//! Every structured (nested-object) MCP tool parameter, as a real typed shape (D-312).
//!
//! WHAT THIS IS
//!  The Rust port of `mcp/schemas.py` (D-310): one reusable type per distinct *wire
//!  shape* the tools accept as a nested argument — mask geometry, colour-wheel
//!  channels, keyframes, Motion layer targets. Deriving `JsonSchema` on them is what
//!  gives each tool a real, introspectable `inputSchema` instead of a bare
//!  `{"type": "object"}`.
//!
//! WHAT IT DOES *NOT* DO
//!  - It does NOT normalise, rename, reorder or defaults-fill anything. Every
//!    optional field is `skip_serializing_if`-omitted, so the object posted to the
//!    control server carries exactly the keys the caller sent. Every default in this
//!    system stays where it already lives — in the frontend handler — and is
//!    deliberately not duplicated here.
//!  - It does NOT re-implement validation the frontend already does, and it is not a
//!    second source of truth for these shapes. The handlers remain authoritative;
//!    these types describe them.
//!
//! THE ONE RULE THESE TYPES ARE BUILT ON (inherited verbatim from D-310)
//!  **A type describes what the handler ACTUALLY accepts, not what its docstring
//!  claims.** Where two spellings are both genuinely accepted — `cx` and `centerX`,
//!  `item_index` and `itemIndex` — BOTH appear as explicit optional fields, because a
//!  shape written from the docstring alone would reject a call that works today.
//!
//! ABSENT vs. EXPLICITLY NULL
//!  Optional fields are `Option<Option<T>>`, which is the standard serde spelling for
//!  the distinction Pydantic's `exclude_unset=True` preserves: the outer `None` means
//!  the caller never mentioned the key (and it is not sent), the inner `None` means
//!  they sent `null` on purpose (and that null is forwarded). Collapsing the two
//!  would quietly change what the frontend receives, which is the one thing this
//!  module exists not to do.
//!
//! EXTRA-KEY POLICY (why some shapes forbid unknown keys and others keep them)
//!  `deny_unknown_fields` for small closed shapes whose handler reads a FIXED key
//!  whitelist and silently ignores everything else (colour wheels, mask geometry).
//!  There an unknown key is already a silent no-op, so rejecting it turns a silent
//!  failure into a clear boundary error — and it is what lets a union discriminate
//!  structurally: a `{startX: …}` object cannot validate as [`RadialGeometry`].
//!
//!  A flattened `extra` map where the handler stores the object verbatim into the
//!  document, or where a hand-authored manifest may legitimately carry fields the
//!  Inspector does not know about ([`MotionTarget`]). Forbidding there would reject
//!  data the system deliberately round-trips.

use schemars::JsonSchema;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};

/// A field the caller may omit entirely, may set to `null` on purpose, or may give a
/// value — see this module's "absent vs. explicitly null" note.
pub type Maybe<T> = Option<Option<T>>;

/// Deserialiser for a [`Maybe`] field, and the reason one is needed.
///
/// `Option`'s own `Deserialize` maps a JSON `null` to `None`, which for `Option<Option<T>>`
/// collapses "sent null" into "never mentioned" — the exact distinction the type exists
/// to keep. Reading the inner `Option` and wrapping it in `Some` is serde's documented
/// idiom for this: paired with `#[serde(default)]`, an absent key is the outer `None` and
/// an explicit null is `Some(None)`.
fn maybe<'de, T, D>(deserializer: D) -> Result<Maybe<T>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    Option::deserialize(deserializer).map(Some)
}

// --------------------------------------------------------------------------- #
// Colorist — tone curve, colour wheels
// --------------------------------------------------------------------------- #

/// One point on a tone curve (`set_curve`).
///
/// Only the first 16 points of a channel are used — `convert_points_to_aligned` in
/// app/src-tauri/src/image_processing.rs takes 16 and silently drops the rest. Points
/// are not sorted or de-duplicated for you.
// That 16-point limit is deliberately documented rather than enforced: rejecting a
// 20-point curve here would refuse a call the app accepts today (D-310). Kept as a plain
// comment, not a doc comment — a doc comment reaches the published schema, and this note
// is for whoever edits this type, not for the model reading the tool.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CurvePoint {
    /// Input level, 0..255.
    pub x: f64,
    /// Output level, 0..255.
    pub y: f64,
}

/// One colour-grading wheel — shadows / midtones / highlights / global.
///
/// These three keys are the entire accepted set: `useChromaControl.ts` keeps a value
/// only `if (['hue','saturation','luminance'].includes(zk) && typeof zv === 'number')`.
/// There is no r/g/b, lift/gamma/gain or sat/lum spelling. Each wheel is merged one
/// level deep, so passing only `hue` leaves the wheel's saturation and luminance alone.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ColorWheelChannel {
    /// 0..360.
    #[serde(
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub hue: Maybe<f64>,
    /// Roughly -100..100.
    #[serde(
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub saturation: Maybe<f64>,
    /// Roughly -100..100.
    #[serde(
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub luminance: Maybe<f64>,
}

// --------------------------------------------------------------------------- #
// Colorist — mask geometry
// --------------------------------------------------------------------------- #

/// Radial sub-mask geometry, in SOURCE PIXELS (`add_component`).
///
/// Every field is optional: the handler falls back to the sub-mask's own default for
/// each one independently (centre = frame centre, radii = width/4, feather = 0.5), so a
/// partial geometry is a legitimate call and is NOT rejected here.
///
/// **Two accepted spellings.** `useChromaControl.ts` reads `centerX: g.cx ?? g.centerX`,
/// `centerY: g.cy ?? g.centerY`, `radiusX: g.rx ?? g.radiusX`, `radiusY: g.ry ??
/// g.radiusY` — so the short form and the long form are equally valid, with the short
/// form winning if both are given. Only the short form was ever documented; both are
/// modelled here so the published schema finally shows the alternative (see this
/// module's header, and D-310).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RadialGeometry {
    /// Centre x. Wins over centerX. Default: width/2.
    #[serde(
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub cx: Maybe<f64>,
    /// Centre y. Wins over centerY. Default: height/2.
    #[serde(
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub cy: Maybe<f64>,
    /// Radius x. Wins over radiusX. Default: width/4.
    #[serde(
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub rx: Maybe<f64>,
    /// Radius y. Wins over radiusY. Default: width/4 (width, not height).
    #[serde(
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub ry: Maybe<f64>,
    /// Alias for cx.
    #[serde(
        rename = "centerX",
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub center_x: Maybe<f64>,
    /// Alias for cy.
    #[serde(
        rename = "centerY",
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub center_y: Maybe<f64>,
    /// Alias for rx.
    #[serde(
        rename = "radiusX",
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub radius_x: Maybe<f64>,
    /// Alias for ry.
    #[serde(
        rename = "radiusY",
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub radius_y: Maybe<f64>,
    /// Degrees. Default 0.
    #[serde(
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub rotation: Maybe<f64>,
    /// 0..1. Default 0.5.
    #[serde(
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub feather: Maybe<f64>,
}

/// Linear (gradient) sub-mask geometry, in SOURCE PIXELS (`add_component`).
///
/// Unlike radial geometry this shape has NO alias spellings — the handler reads
/// `startX`/`startY`/`endX`/`endY`/`range` and nothing else (no x1/y1/x2/y2, no
/// sx/sy/ex/ey). Every field is optional and independently defaulted by the handler.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LinearGeometry {
    /// Default: width * 0.25.
    #[serde(
        rename = "startX",
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub start_x: Maybe<f64>,
    /// Default: height / 2.
    #[serde(
        rename = "startY",
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub start_y: Maybe<f64>,
    /// Default: width * 0.75.
    #[serde(
        rename = "endX",
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub end_x: Maybe<f64>,
    /// Default: height / 2.
    #[serde(
        rename = "endY",
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub end_y: Maybe<f64>,
    /// Gradient falloff. Default 50.
    #[serde(
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub range: Maybe<f64>,
}

/// A region of interest drawn on the canvas for the user (`request_human`).
///
/// Normalized 0..1 with a top-left origin. All four fields are required — the handler
/// errors unless every one is a finite number — and each is clamped to 0..1
/// independently, so `x + w` may exceed 1.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Roi {
    pub x: f64,
    pub y: f64,
    /// Width. Not `width`.
    pub w: f64,
    /// Height. Not `height`.
    pub h: f64,
}

/// `add_component`'s geometry, discriminated by its sibling `type` argument rather than
/// by a key inside the object, so this is a plain union. The two members have disjoint
/// key sets and both forbid extras, which is what lets an object resolve unambiguously.
/// Types "subject" and "brush" ignore geometry entirely.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum MaskGeometry {
    Radial(RadialGeometry),
    Linear(LinearGeometry),
}

// --------------------------------------------------------------------------- #
// Edit tab
// --------------------------------------------------------------------------- #

/// A cubic-bezier ease given as an object rather than a 4-array.
///
/// Undocumented but fully accepted by `parseCurve` (useEditorControl.ts), which reads
/// `Array.isArray(v) ? v : [v?.x1, v?.y1, v?.x2, v?.y2]`. Modelled so that typing the
/// parameter does not silently drop a form that works today.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BezierPoints {
    pub x1: f64,
    pub y1: f64,
    pub x2: f64,
    pub y2: f64,
}

/// The four presets in `EASE_PRESETS` (packages/editor/src/timeline.ts).
//
// NOTE: CSS's "ease" is NOT among them — several docstrings claimed it was, and it is
// rejected at runtime (B-165).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
pub enum EasePresetName {
    #[serde(rename = "linear")]
    Linear,
    #[serde(rename = "ease-in")]
    EaseIn,
    #[serde(rename = "ease-out")]
    EaseOut,
    #[serde(rename = "ease-in-out")]
    EaseInOut,
}

/// The three interchangeable forms `parseCurve` accepts for an Edit-tab easing argument.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum CurveSpec {
    Preset(EasePresetName),
    Points(EaseCurve),
    Object(BezierPoints),
}

/// `fit_overrides` values — the handler accepts exactly these two strings.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
pub enum FitMode {
    #[serde(rename = "fit")]
    Fit,
    #[serde(rename = "stretch")]
    Stretch,
}

/// `editor_export`'s `renderer` — which engine composites the PICTURE (D-350).
/// A real enum rather than a bare `String` so this surface publishes the same
/// two-value contract `mcp/server.py`'s own `ExportRenderer` literal does; the
/// parity gate compares the published `inputSchema`, and a plain string here
/// silently dropped the `enum` from it.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
pub enum ExportRenderer {
    #[serde(rename = "filter")]
    Filter,
    #[serde(rename = "compositor")]
    Compositor,
}

/// `editor_export`'s `loudness_preset` — the delivery spec the finished mix is
/// normalised to (D-401). Mirrors `mcp/schemas.py`'s `LoudnessPreset`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
pub enum LoudnessPreset {
    #[serde(rename = "youtube")]
    Youtube,
    #[serde(rename = "broadcast")]
    Broadcast,
    #[serde(rename = "podcast")]
    Podcast,
    #[serde(rename = "off")]
    Off,
}

/// `editor_generate_captions_from_transcript`'s `scope` (D-411 Phase 0): one
/// source `"file"`, or the whole `"timeline"` from its stitched transcript.
/// Mirrors `mcp/schemas.py`'s `CaptionScope`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
pub enum CaptionScope {
    #[serde(rename = "file")]
    File,
    #[serde(rename = "timeline")]
    Timeline,
}

/// One segment boundary in a clip speed ramp (`set_clip_speed`).
///
/// "From this SOURCE frame onward, play at this speed." Source frames are absolute in
/// the file, not clip-relative and not timeline frames.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SpeedRampPoint {
    /// Absolute source frame. Not `frame`/`sourceFrame`.
    pub source_frame: i64,
    /// Multiplier. Magnitude must be 0.05..20, either sign; negative plays backwards. 0
    /// and out-of-range values are refused, not clamped.
    pub speed: f64,
}

/// A gap between two clips (`editor_set_selection`).
///
/// `frame` must land inside a real, closeable gap — trailing space past the last clip is
/// not a gap and is refused.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct GapSelector {
    pub track: i64,
    /// A TIMELINE frame inside the gap.
    pub frame: i64,
}

/// One clip in a selection (`editor_set_selection`).
///
/// `track` is always required, even when addressing by `clipId` — the id is searched
/// only within that track. `clipId` wins when both it and `clip` are given.
//
// The published description comes from THIS type's doc (schemars reads the outer type's
// even for a `try_from`), while the property shapes come from `ClipSelectorFields`. Both
// halves have to be right; the parity gate checks each separately.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(try_from = "ClipSelectorFields")]
pub struct ClipSelector {
    pub track: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clip: Maybe<i64>,
    #[serde(rename = "clipId", skip_serializing_if = "Option::is_none")]
    pub clip_id: Maybe<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

// The wire shape `ClipSelector` is parsed and validated from — a separate type only
// because serde's `try_from` needs one, and the type schemars reads the PROPERTIES from.
// What it buys is the check below: "neither `clip` nor `clipId`" becomes a field-level error at
// the tool boundary, naming the entry, instead of an entry the app cannot resolve
// reaching the frontend and failing there.
#[derive(Debug, Deserialize, JsonSchema)]
#[schemars(rename = "ClipSelector")]
pub struct ClipSelectorFields {
    /// 0-based track index. Always required.
    pub track: i64,
    /// 0-based clip index within the track.
    #[serde(default, deserialize_with = "maybe")]
    pub clip: Maybe<i64>,
    /// Clip id. Wins over `clip`. Prefer this if anything may have moved.
    #[serde(rename = "clipId", default, deserialize_with = "maybe")]
    pub clip_id: Maybe<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl TryFrom<ClipSelectorFields> for ClipSelector {
    type Error = String;

    fn try_from(f: ClipSelectorFields) -> Result<Self, Self::Error> {
        if f.clip.is_none() && f.clip_id.is_none() {
            return Err("each clip entry needs `clip` (an index) or `clipId`".to_string());
        }
        Ok(Self {
            track: f.track,
            clip: f.clip,
            clip_id: f.clip_id,
            extra: f.extra,
        })
    }
}

/// One keyframe on a clip's own transform/audio timeline (`editor_set_clip_keyframes`).
///
/// `extra="allow"` because the array is stored verbatim — unknown keys survive into
/// `project.json` rather than being dropped.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ClipKeyframe {
    /// Clip SOURCE-frame-absolute. Strictly numeric: unlike most numeric arguments in
    /// the Edit tab this one is not string-coerced.
    pub frame: f64,
    /// Subset of opacity / position_x / position_y / scale / rotation / corner_radius /
    /// crop_left / crop_top / crop_right / crop_bottom / volume / pan. Names outside that
    /// set are stored but have no effect.
    pub params: Map<String, Value>,
    /// Per-param easing for the segment STARTING at this key, keyed by param name. Real
    /// and load-bearing — this is how `editor_set_keyframe_ease` persists — though no
    /// docstring documented it before D-310.
    #[serde(
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub ease: Maybe<Map<String, Value>>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// [x0, y0, x1, y1] as fractions of the SOURCE image (0..1, top-left origin). Corners may
/// come in any order; values are clamped to 0..1; the box must have area.
//
// A newtype for `EaseCurve`'s reason: it carries its own length bound and description into
// the schema, which a bare `Vec<f64>` alias would drop. Plain comments here, because a doc
// comment reaches the published description.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(transparent)]
pub struct HighlightBox(#[schemars(length(min = 4, max = 4))] pub Vec<f64>);

/// One highlighter-pen sweep on a clip (`editor_set_clip_highlights`).
///
/// Drawn on the clip's own picture, left to right, starting at source frame `at`; once
/// swept it stays for the rest of the clip.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ClipHighlightSpec {
    #[serde(rename = "box")]
    pub rect: HighlightBox,
    /// Clip SOURCE frame the sweep starts on (the same axis as a keyframe's `frame`), >= 0.
    pub at: i64,
    /// Frames the sweep takes, >= 0. 0 reveals the whole box at `at`.
    pub dur: i64,
    /// Hex colour, #RGB or #RRGGBB. Default #F2B63A (a highlighter yellow-ochre).
    #[serde(
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub color: Maybe<String>,
    /// 0..1. Default 0.45.
    #[serde(
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub opacity: Maybe<f64>,
}

/// One Google Fonts family a theme downloads (`motion_define_theme`).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ThemeFontSpec {
    /// Google Fonts family name exactly as Google spells it ("Newsreader", "IBM Plex Mono").
    pub family: String,
    /// CSS weights to load, e.g. ["400", "600"]. Omitted loads the regular weight.
    #[serde(
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub weights: Maybe<Vec<String>>,
    /// Load the italic face instead of the upright one.
    #[serde(
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub italic: Maybe<bool>,
}

/// Theme fields for `motion_define_theme`: every one optional, applied over the base.
///
/// Colours are opaque #rrggbb (three.js discards alpha, so a translucent colour would render
/// differently in 3D than in 2D).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ThemeFields {
    /// One line describing the look (optional).
    #[serde(
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub description: Maybe<String>,
    /// Scene ground. Opaque #rrggbb colour.
    #[serde(
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub bg: Maybe<String>,
    /// Second ground: panels, cards, 3D faces, the vignette edge. Opaque #rrggbb colour.
    #[serde(
        rename = "bgDeep",
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub bg_deep: Maybe<String>,
    /// Primary stroke: graph rings, roughjs default. Opaque #rrggbb colour.
    #[serde(
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub stroke: Maybe<String>,
    /// Secondary lines: borders, graph edges. Opaque #rrggbb colour.
    #[serde(
        rename = "strokeSoft",
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub stroke_soft: Maybe<String>,
    /// Primary text. Opaque #rrggbb colour.
    #[serde(
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub text: Maybe<String>,
    /// Secondary text: captions, labels. Opaque #rrggbb colour.
    #[serde(
        rename = "textDim",
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub text_dim: Maybe<String>,
    /// Emphasis / active-state colour. Opaque #rrggbb colour.
    #[serde(
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub accent: Maybe<String>,
    /// Signal / energy colour: fills, pulses, glows. Opaque #rrggbb colour.
    #[serde(
        rename = "accentSignal",
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub accent_signal: Maybe<String>,
    /// Stroke width in px at 1080p, 0.5..20.
    #[serde(
        rename = "strokeWidth",
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub stroke_width: Maybe<f64>,
    /// roughjs roughness, 0..10. 0 draws exact geometry.
    #[serde(
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub roughness: Maybe<f64>,
    /// roughjs bowing, 0..10. 0 keeps straight lines straight.
    #[serde(
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub bowing: Maybe<f64>,
    /// CSS font-family stack for headlines (no ; { } < > or backslash).
    #[serde(
        rename = "fontDisplay",
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub font_display: Maybe<String>,
    /// CSS font-family stack for labels and body.
    #[serde(
        rename = "fontUi",
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub font_ui: Maybe<String>,
    /// CSS font-family stack for numbers and data.
    #[serde(
        rename = "fontMono",
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub font_mono: Maybe<String>,
    /// Amplitude of the always-on drift in px, 0..20. 0 = nothing drifts.
    #[serde(
        rename = "ambientDriftPx",
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub ambient_drift_px: Maybe<f64>,
    /// Google Fonts families to download for the stacks above (at most 8).
    #[serde(
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub fonts: Maybe<Vec<ThemeFontSpec>>,
}

/// A start or end framing for a dynamic zoom (`editor_set_dynamic_zoom`).
///
/// snake_case only — there is no x/y/zoom/positionX alias. Every field is optional and
/// falls back to the framing it replaces, so `{"scale": 1.4}` zooms without recentring.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DynamicZoomFraming {
    /// Composition fraction offset from centre.
    #[serde(
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub position_x: Maybe<f64>,
    /// Composition fraction offset from centre.
    #[serde(
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub position_y: Maybe<f64>,
    /// Multiplier; bigger is more zoomed in. Must be > 0.
    #[serde(
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub scale: Maybe<f64>,
}

// --------------------------------------------------------------------------- #
// Motion tab
// --------------------------------------------------------------------------- #

/// Cubic-bezier control points [x1, y1, x2, y2]; P0=(0,0) and P3=(1,1) are
/// implicit. Exactly four finite numbers.
//
// A newtype rather than a `Vec<f64>` alias so it carries its own length bound and its
// own description into every schema that uses it — an alias would publish a bare array
// and quietly drop both. Both of these paragraphs are plain comments, not doc comments,
// precisely because a doc comment here reaches the published description.
//
// The handler clamps x1/x2 to 0..1 and y1/y2 to -0.75..1.75 with a warning (B-166); that
// is deliberately not enforced here, since rejecting an overshoot the app accepts would
// make the tool stricter than the thing it describes.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(transparent)]
pub struct EaseCurve(#[schemars(length(min = 4, max = 4))] pub Vec<f64>);

/// One entry in a Motion multi-select (`selections`).
///
/// Entries carry their own `scene_index`, so a selection may span scenes. Both the
/// snake_case and camelCase spellings reach the handler through its `arg()` helper.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct MotionSelection {
    pub target: MotionTarget,
    /// Which scene this entry's target is in.
    #[serde(
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub scene_index: Maybe<i64>,
    /// Alias for scene_index.
    #[serde(
        rename = "sceneIndex",
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub scene_index_camel: Maybe<i64>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

// Which lane a keyframe lives in, for `motion_move_keys_by_delta`. A plain comment, not
// a doc comment: a doc comment here becomes the referenced type's `description` and would
// shadow the per-field one `MotionKeyTarget.kind` publishes.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
pub enum MotionKeyLane {
    #[serde(rename = "layer")]
    Layer,
    #[serde(rename = "camera")]
    Camera,
    #[serde(rename = "scene3d-camera")]
    Scene3dCamera,
    #[serde(rename = "active")]
    Active,
}

/// One keyframe to shift (`motion_move_keys_by_delta`).
///
/// A FLAT shape — `kind` sits on the entry itself, not inside a nested `target`, so this
/// is deliberately not `MotionSelection`. Targets may mix lanes and scenes.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct MotionKeyTarget {
    /// Which lane the key lives in. 'layer' and 'active' also need a layer index.
    pub kind: MotionKeyLane,
    /// Which scene.
    #[serde(
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub scene_index: Maybe<i64>,
    /// Alias for scene_index.
    #[serde(
        rename = "sceneIndex",
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub scene_index_camel: Maybe<i64>,
    /// Which key in that lane's array.
    #[serde(
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub key_index: Maybe<i64>,
    /// Alias for key_index.
    #[serde(
        rename = "keyIndex",
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub key_index_camel: Maybe<i64>,
    /// Required when kind is 'layer' or 'active'.
    #[serde(
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub layer_index: Maybe<i64>,
    /// Alias for layer_index.
    #[serde(
        rename = "layerIndex",
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub layer_index_camel: Maybe<i64>,
    /// Optional start time to replay a captured drag from. Omit (or null) and the key's
    /// current time is read off the live manifest.
    #[serde(
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub base_at: Maybe<f64>,
    /// Alias for base_at.
    #[serde(
        rename = "baseAt",
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub base_at_camel: Maybe<f64>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// One 2D camera keyframe (`motion_set_camera_2d`).
///
/// Genuinely different from the 3D shape: x/y/zoom here, pos/look there.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Camera2DKey {
    /// SECONDS from the scene's start. Strictly numeric.
    pub at: f64,
    /// World x the camera centres on.
    #[serde(
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub x: Maybe<f64>,
    /// World y the camera centres on.
    #[serde(
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub y: Maybe<f64>,
    /// Multiplier; 1 = fit.
    #[serde(
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub zoom: Maybe<f64>,
    /// Shapes the segment starting at this key.
    #[serde(
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub ease: Maybe<EaseCurve>,
}

/// One 3D camera keyframe (`motion_set_camera_3d`).
///
/// `pos` is required — a 3D camera key with no position is meaningless.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Camera3DKey {
    /// SECONDS from the scene's start. Strictly numeric.
    pub at: f64,
    /// Camera position [x, y, z].
    #[schemars(length(min = 3, max = 3))]
    pub pos: Vec<f64>,
    /// Look-at point [x, y, z].
    #[serde(
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(length(min = 3, max = 3))]
    pub look: Maybe<Vec<f64>>,
    /// Shapes the segment starting at this key.
    #[serde(
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub ease: Maybe<EaseCurve>,
}

/// One keyframe in a layer's animation (`motion_set_layer_transform_keys`).
///
/// These values are additive DELTAS on top of the layer's static `transform.*` values,
/// not absolute replacements (motion-engine/src/engine/schema.ts). A property absent
/// from a key is simply not animated by it.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LayerTransformKey {
    /// SECONDS from the layer's SCENE start. Strictly numeric.
    pub at: f64,
    /// World-pixel x delta.
    #[serde(
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub x: Maybe<f64>,
    /// World-pixel y delta.
    #[serde(
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub y: Maybe<f64>,
    #[serde(
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub scale: Maybe<f64>,
    /// Rotation. Named `rot`, not `rotation`.
    #[serde(
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub rot: Maybe<f64>,
    #[serde(
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub opacity: Maybe<f64>,
    /// Shapes the segment starting at this key. x1/x2 are clamped to 0..1 and y1/y2 to
    /// -0.75..1.75, each with a warning rather than an error.
    #[serde(
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub ease: Maybe<EaseCurve>,
}

/// One step in a `layers`/`layerstack` primitive's active schedule.
///
/// A STEP, not an interpolation: "from `at` seconds onward, show child `i`", holding
/// until the next entry. Hence there is no `ease` on it.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ActiveScheduleEntry {
    /// SECONDS from the scene's start. Strictly numeric.
    pub at: f64,
    /// Which child to highlight.
    pub i: i64,
}

/// What kind of thing a Motion op acts on.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
pub enum MotionTargetKind {
    #[serde(rename = "scene")]
    Scene,
    #[serde(rename = "camera")]
    Camera,
    #[serde(rename = "scene3d-camera")]
    Scene3dCamera,
    #[serde(rename = "layer")]
    Layer,
    #[serde(rename = "scene3d-child")]
    Scene3dChild,
    #[serde(rename = "layer-item")]
    LayerItem,
}

/// What a Motion op acts on — a layer, a card, a scene or a camera.
///
/// One shape parses every `target` argument (`parseSelectionArg`, motionOps.ts); what
/// differs per tool is which `kind` values are meaningful afterwards, which the handler
/// reports by name. All six are modelled so this never rejects a target a tool actually
/// resolves.
///
/// - kind "scene" / "camera" / "scene3d-camera": `kind` alone; index/id are ignored.
/// - kind "layer" / "scene3d-child": needs `index` or `id` (id wins, and keeps naming
///   the same layer after something moves).
/// - kind "layer-item": needs `index` (the parent layer) AND `item_index` (the card).
///
/// `scene_index` is a SIBLING of `target`, never a key inside it.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct MotionTarget {
    pub kind: MotionTargetKind,
    /// Position in the layer list.
    #[serde(
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub index: Maybe<i64>,
    /// Stable layer id. Wins over `index`.
    #[serde(
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub id: Maybe<String>,
    /// Card index, for kind 'layer-item'.
    #[serde(
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub item_index: Maybe<i64>,
    /// Alias for item_index — accepted by the handler (`target.item_index ??
    /// target.itemIndex`) but undocumented before D-310.
    #[serde(
        rename = "itemIndex",
        default,
        deserialize_with = "maybe",
        skip_serializing_if = "Option::is_none"
    )]
    pub item_index_camel: Maybe<i64>,
    /// A hand-authored manifest may legitimately carry fields the Inspector does not
    /// know about, and the handler stores what it is given — so unknown keys are kept
    /// and forwarded rather than rejected.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn roundtrip<T: for<'de> Deserialize<'de> + Serialize>(value: Value) -> Value {
        let parsed: T = serde_json::from_value(value).expect("shape parses");
        serde_json::to_value(parsed).expect("shape re-serialises")
    }

    #[test]
    fn a_partial_geometry_survives_with_exactly_the_keys_it_arrived_with() {
        // The safety property the whole module is built on: what reaches the control
        // server is the caller's own object. A defaults-filling port would send
        // `{cx, cy, rx, ry, rotation, feather}` here and silently move the mask.
        let sent = json!({ "cx": 100.0, "feather": 0.25 });
        assert_eq!(roundtrip::<RadialGeometry>(sent.clone()), sent);
    }

    #[test]
    fn an_explicit_null_is_forwarded_while_an_absent_key_stays_absent() {
        // `Option<Option<T>>` is the only reason these two are distinguishable at all,
        // and Pydantic's `exclude_unset=True` distinguished them on the Python side.
        assert_eq!(
            roundtrip::<RadialGeometry>(json!({ "cx": null })),
            json!({ "cx": null })
        );
        assert_eq!(roundtrip::<RadialGeometry>(json!({})), json!({}));
    }

    #[test]
    fn both_documented_and_undocumented_radial_spellings_are_accepted() {
        // D-310's founding case: a shape written from the docstring would have rejected
        // `centerX`, which `useChromaControl.ts` has always accepted.
        let long_form = json!({ "centerX": 10.0, "centerY": 20.0, "radiusX": 5.0 });
        assert_eq!(roundtrip::<RadialGeometry>(long_form.clone()), long_form);
    }

    #[test]
    fn a_key_the_handler_would_silently_ignore_is_refused_at_the_boundary() {
        // `deny_unknown_fields` earns its place here: the handler reads a fixed
        // whitelist, so `radius` would have been a silent no-op, not a smaller mask.
        let err = serde_json::from_value::<RadialGeometry>(json!({ "radius": 4.0 }));
        assert!(err.is_err());
    }

    #[test]
    fn the_geometry_union_discriminates_on_its_disjoint_key_sets() {
        let radial: MaskGeometry = serde_json::from_value(json!({ "cx": 1.0 })).expect("radial");
        assert!(matches!(radial, MaskGeometry::Radial(_)));
        let linear: MaskGeometry =
            serde_json::from_value(json!({ "startX": 1.0 })).expect("linear");
        assert!(matches!(linear, MaskGeometry::Linear(_)));
    }

    #[test]
    fn a_motion_target_keeps_manifest_fields_it_does_not_model() {
        // `extra="allow"` on the Python side. The Inspector round-trips hand-authored
        // manifests, so dropping an unmodelled key here would lose real data.
        let sent = json!({ "kind": "layer", "id": "L1", "authoredBy": "hand" });
        assert_eq!(roundtrip::<MotionTarget>(sent.clone()), sent);
    }
}

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

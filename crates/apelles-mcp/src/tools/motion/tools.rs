//! The `motion_*` tools themselves — see `motion.rs` for why they live behind a gate.
//!
//! Answered by `@apelles/motion`'s `useMotionControl.ts`. Times in this tab are SECONDS
//! within a scene, not absolute frames — the single most common way to get a Motion call
//! wrong, which is why every relevant description repeats it.
//!
//! A separate file rather than an inline `mod { … }` for the same reason as
//! `debug/tools.rs`: every description is a raw string whose bytes the parity gate pins,
//! and an indent pass would break them.

use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::CallToolResult;
use rmcp::{ErrorData, tool, tool_router};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;

use crate::args::WireArgs;
use crate::render;
use crate::schemas::{
    ActiveScheduleEntry, Camera2DKey, Camera3DKey, EaseCurve, LayerTransformKey, MotionKeyTarget,
    MotionSelection, MotionTarget, ThemeFields,
};
use crate::server::ApellesMcp;

// Argument defaults — the Python signature's own, so an omitted argument reaches the
// frontend with the value it always did. A `value` that defaults to null is how these
// tools express "clear this field", so null is a real default here, not a missing one.
fn default_motion_set_soundtrack_clear() -> bool {
    false
}

fn default_motion_time_to_music_dry_run() -> bool {
    false
}

fn default_motion_snap_to_beats_include_camera() -> bool {
    false
}

fn default_motion_snap_to_beats_dry_run() -> bool {
    false
}

fn default_motion_set_project_settings_reflow() -> bool {
    true
}

fn default_motion_set_scene_field_value() -> Value {
    Value::Null
}

fn default_motion_set_field_on_layers_value() -> Value {
    Value::Null
}

fn default_motion_set_field_on_layers_transform() -> bool {
    false
}

fn default_motion_set_layer_item_value() -> Value {
    Value::Null
}

fn default_motion_set_layer_item_reset() -> bool {
    false
}

fn default_motion_set_layer_transform_field_value() -> Value {
    Value::Null
}

fn default_motion_reorder_layers_kind() -> String {
    "layer".to_string()
}

fn default_motion_move_layers_by_delta_auto_key() -> bool {
    false
}

fn default_motion_move_layer_keyframe_lane() -> String {
    "transform".to_string()
}

fn default_motion_move_camera_keyframe_camera() -> String {
    "2d".to_string()
}

fn default_motion_set_keyframe_ease_lane() -> String {
    "layer".to_string()
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionSetLayerFieldArgs {
    pub scene_index: i64,
    pub target: MotionTarget,
    pub key: String,
    /// Any JSON value the primitive's field accepts — and `null` on purpose, which is
    /// how a field is DELETED rather than left alone. It is therefore always sent,
    /// unlike the optional arguments elsewhere in this surface.
    #[serde(default)]
    pub value: Value,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionListLayersArgs {
    #[serde(default)]
    pub scene_index: Option<i64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionAddSceneArgs {
    #[serde(default)]
    pub after_scene_index: Option<i64>,
    /// B-242/D-371 — the new scene's DISPLAY NAME. Published as `id`, which is
    /// what the manifest calls it. Omit for a generated `scene-xxxxxx`.
    #[serde(default)]
    pub id: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionSetProjectThemeArgs {
    /// `None` is a real value here, not a missing one: it CLEARS the field.
    #[serde(default)]
    pub theme: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionSetProjectSettingsArgs {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub width: Option<i64>,
    #[serde(default)]
    pub height: Option<i64>,
    #[serde(default)]
    pub fps: Option<f64>,
    /// D-346 — remap every layer onto the new canvas. Defaults TRUE; see the
    /// tool's own description for why that is the safe default rather than the
    /// surprising one.
    #[serde(default = "default_motion_set_project_settings_reflow")]
    pub reflow: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionDeleteSceneArgs {
    pub scene_index: i64,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionDuplicateSceneArgs {
    pub scene_index: i64,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionSetSceneFieldArgs {
    pub scene_index: i64,
    pub key: String,
    #[serde(default = "default_motion_set_scene_field_value")]
    pub value: Value,
    /// B-242/D-371 — for `key: "id"` only: rename even though it orphans a
    /// render already linked into the Edit tab. See the tool's description.
    #[serde(default)]
    pub force: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionSetCamera2DArgs {
    pub scene_index: i64,
    pub keys: Vec<Camera2DKey>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionSetCamera3DArgs {
    pub scene_index: i64,
    pub keys: Vec<Camera3DKey>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionAddLayerArgs {
    pub scene_index: i64,
    /// The primitive to build the layer from. Published as `use` — a Rust keyword, hence
    /// the serde rename; the wire key and the parameter name a caller sends are `use`.
    #[serde(rename = "use")]
    pub primitive: String,
    /// D-403 — fields laid over the default instance, validated as one layer.
    #[serde(default)]
    pub props: Option<serde_json::Map<String, Value>>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionDeleteLayerArgs {
    pub scene_index: i64,
    pub target: MotionTarget,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionSaveLayerPresetArgs {
    pub scene_index: i64,
    pub target: MotionTarget,
    pub name: String,
}
#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionAddLayerFromPresetArgs {
    pub scene_index: i64,
    pub preset_id: String,
}
#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionDeleteLayerPresetArgs {
    pub preset_id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionDuplicateLayerArgs {
    pub scene_index: i64,
    pub target: MotionTarget,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionReorderLayersArgs {
    pub scene_index: i64,
    pub from_index: i64,
    pub to_index: i64,
    #[serde(default = "default_motion_reorder_layers_kind")]
    pub kind: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionSetFieldOnLayersArgs {
    pub selections: Vec<MotionSelection>,
    pub key: String,
    #[serde(default = "default_motion_set_field_on_layers_value")]
    pub value: Value,
    #[serde(default = "default_motion_set_field_on_layers_transform")]
    pub transform: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionSetLayerItemArgs {
    pub scene_index: i64,
    pub target: MotionTarget,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default = "default_motion_set_layer_item_value")]
    pub value: Value,
    #[serde(default)]
    pub dx: Option<f64>,
    #[serde(default)]
    pub dy: Option<f64>,
    #[serde(default = "default_motion_set_layer_item_reset")]
    pub reset: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionSelectArgs {
    pub scene_index: i64,
    pub target: MotionTarget,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionSetSelectionArgs {
    pub selections: Vec<MotionSelection>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionSetLayerPositionArgs {
    pub scene_index: i64,
    pub target: MotionTarget,
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionSetLayerSizeArgs {
    pub scene_index: i64,
    pub target: MotionTarget,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionSetLayerTransformFieldArgs {
    pub scene_index: i64,
    pub target: MotionTarget,
    pub key: String,
    #[serde(default = "default_motion_set_layer_transform_field_value")]
    pub value: Value,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionMoveLayersByDeltaArgs {
    pub selections: Vec<MotionSelection>,
    pub dx: f64,
    pub dy: f64,
    #[serde(default = "default_motion_move_layers_by_delta_auto_key")]
    pub auto_key: bool,
    #[serde(default)]
    pub at: Option<f64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionAlignLayersArgs {
    pub selections: Vec<MotionSelection>,
    pub edge: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionDistributeLayersArgs {
    pub selections: Vec<MotionSelection>,
    pub axis: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionSetLayerTransformKeysArgs {
    pub scene_index: i64,
    pub target: MotionTarget,
    pub keys: Vec<LayerTransformKey>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionAddLayerKeyframeArgs {
    pub scene_index: i64,
    pub target: MotionTarget,
    pub at: f64,
    #[serde(default)]
    pub x: Option<f64>,
    #[serde(default)]
    pub y: Option<f64>,
    #[serde(default)]
    pub ease: Option<EaseCurve>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionMoveLayerKeyframeArgs {
    pub scene_index: i64,
    pub target: MotionTarget,
    pub key_index: i64,
    pub new_at: f64,
    #[serde(default = "default_motion_move_layer_keyframe_lane")]
    pub lane: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionDeleteLayerKeyframeArgs {
    pub scene_index: i64,
    pub target: MotionTarget,
    pub key_index: i64,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionMoveCameraKeyframeArgs {
    pub scene_index: i64,
    pub key_index: i64,
    pub new_at: f64,
    #[serde(default = "default_motion_move_camera_keyframe_camera")]
    pub camera: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionMoveKeysByDeltaArgs {
    pub targets: Vec<MotionKeyTarget>,
    pub delta_seconds: f64,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionSetKeyframeEaseArgs {
    pub scene_index: i64,
    pub key_index: i64,
    #[serde(default)]
    pub ease: Option<EaseCurve>,
    #[serde(default = "default_motion_set_keyframe_ease_lane")]
    pub lane: String,
    #[serde(default)]
    pub target: Option<MotionTarget>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionSetLayerActiveScheduleArgs {
    pub scene_index: i64,
    pub target: MotionTarget,
    pub schedule: Vec<ActiveScheduleEntry>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionSeekArgs {
    #[serde(default)]
    pub frame: Option<i64>,
    #[serde(default)]
    pub scene_index: Option<i64>,
    #[serde(default)]
    pub at: Option<f64>,
}

fn default_motion_render_resume() -> bool {
    false
}

fn default_motion_reload_manifest_force() -> bool {
    false
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionRenderArgs {
    #[serde(default)]
    pub scene_ids: Option<Vec<String>>,
    #[serde(default = "default_motion_render_resume")]
    pub resume: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionReloadManifestArgs {
    #[serde(default = "default_motion_reload_manifest_force")]
    pub force: bool,
}

fn default_motion_define_theme_to_library() -> bool {
    false
}

fn default_motion_define_theme_apply() -> bool {
    true
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionDefineThemeArgs {
    pub name: String,
    #[serde(default)]
    pub base: Option<String>,
    #[serde(default)]
    pub theme: Option<ThemeFields>,
    #[serde(default)]
    pub tokens_css: Option<String>,
    #[serde(default = "default_motion_define_theme_to_library")]
    pub to_library: bool,
    #[serde(default = "default_motion_define_theme_apply")]
    pub apply: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionDeleteThemeArgs {
    pub name: String,
}

// D-407 — templates as data. Slot sources, values and the template itself are
// open JSON objects (the Python server's `dict[str, Any]`); their schema is
// the frontend's zod one (`templateDef.ts`), which validates every call.

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionListTemplatesArgs {
    #[serde(default)]
    pub tag: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionGetTemplateArgs {
    pub id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionDefineTemplateArgs {
    pub template: serde_json::Map<String, Value>,
    #[serde(default)]
    pub dry_run: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionSaveTemplateArgs {
    pub scene_index: i64,
    pub name: String,
    pub slots: Vec<serde_json::Map<String, Value>>,
    #[serde(default)]
    pub layers: Option<Vec<String>>,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub dry_run: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionInstantiateTemplateArgs {
    pub id: String,
    #[serde(default)]
    pub values: Option<serde_json::Map<String, Value>>,
    #[serde(default)]
    pub after_scene_index: Option<i64>,
    #[serde(default)]
    pub into_scene_index: Option<i64>,
    #[serde(default)]
    pub scene_id: Option<String>,
    #[serde(default)]
    pub apply_theme: bool,
    #[serde(default)]
    pub dry_run: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionRefillTemplateArgs {
    pub scene_index: i64,
    #[serde(default)]
    pub values: Option<serde_json::Map<String, Value>>,
    #[serde(default)]
    pub layer_id: Option<String>,
    #[serde(default)]
    pub upgrade: bool,
    #[serde(default)]
    pub dry_run: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionDeleteTemplateArgs {
    pub id: String,
}

// D-409 — custom components.

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionListComponentsArgs {
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub tag: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionComponentVersionArgs {
    pub id: String,
    #[serde(default)]
    pub version: Option<i64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionWriteComponentArgs {
    pub id: String,
    pub source: String,
    #[serde(default)]
    pub props: Option<Vec<serde_json::Map<String, Value>>>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub size: Option<serde_json::Map<String, Value>>,
    #[serde(default)]
    pub duration: Option<f64>,
    #[serde(default)]
    pub dry_run: bool,
}

// D-403 — authoring as data. `serde_json::Map` publishes `{type: object,
// additionalProperties: true}`, which is the Python server's `dict[str, Any]`.

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionValidateArgs {
    #[serde(default)]
    pub manifest: Option<serde_json::Map<String, Value>>,
    #[serde(default)]
    pub scene: Option<serde_json::Map<String, Value>>,
    #[serde(default)]
    pub layers: Option<Vec<serde_json::Map<String, Value>>>,
    #[serde(default)]
    pub scene_index: Option<i64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionImportAssetArgs {
    pub path: String,
}

/// D-413 — the document's soundtrack.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionSetSoundtrackArgs {
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub asset: Option<String>,
    #[serde(default)]
    pub offset: Option<f64>,
    #[serde(default)]
    pub volume: Option<f64>,
    #[serde(default)]
    pub render: Option<bool>,
    #[serde(default)]
    pub meter: Option<i64>,
    #[serde(default)]
    pub tempo_hint: Option<f64>,
    #[serde(default = "default_motion_set_soundtrack_clear")]
    pub clear: bool,
}

/// D-413 — one scene's soundtrack beats.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionGetBeatsArgs {
    pub scene_index: i64,
    #[serde(default)]
    pub kind: Option<String>,
}

/// D-413 — named moves timed to the soundtrack's beats.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionTimeToMusicArgs {
    pub scene_index: i64,
    #[schemars(schema_with = "untyped_list_schema")]
    pub moves: Vec<Value>,
    #[serde(default = "default_motion_time_to_music_dry_run")]
    pub dry_run: bool,
}

/// D-413 — keys snapped to the soundtrack's beats.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionSnapToBeatsArgs {
    pub scene_index: i64,
    #[serde(default)]
    pub layers: Option<Vec<String>>,
    #[serde(default)]
    pub track: Option<String>,
    #[serde(default)]
    pub to: Option<String>,
    #[serde(default)]
    pub tolerance_s: Option<f64>,
    #[serde(default = "default_motion_snap_to_beats_include_camera")]
    pub include_camera: bool,
    #[serde(default = "default_motion_snap_to_beats_dry_run")]
    pub dry_run: bool,
}

/// The schema of a parameter the Python tool declares as a bare `list`
/// (`items: {}`), which `Vec<Value>` alone would publish more narrowly.
fn untyped_list_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({ "type": "array", "items": {} })
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionInsertLayersArgs {
    pub scene_index: i64,
    pub layers: Vec<serde_json::Map<String, Value>>,
    #[serde(default)]
    pub at: Option<i64>,
    #[serde(default)]
    pub dry_run: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionSetSceneArgs {
    pub scene_index: i64,
    pub scene: serde_json::Map<String, Value>,
    #[serde(default)]
    pub dry_run: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionPreviewFrameArgs {
    pub scene_index: i64,
    #[serde(default)]
    pub at_seconds: Option<Vec<f64>>,
    #[serde(default)]
    pub frames: Option<Vec<i64>>,
    #[serde(default)]
    pub scale: Option<f64>,
    #[serde(default)]
    pub manifest: Option<serde_json::Map<String, Value>>,
}

#[tool_router(router = motion_router, vis = "pub")]
impl ApellesMcp {
    #[tool(
        name = "motion_get_state",
        description = r#"Orientation for the Motion tab — call this FIRST. The Motion analogue of
    `editor_get_state`, and the read half of `motion_select`/
    `motion_set_selection`.

    Returns:
      * `loadState` / `dirty` / `parseError` / `saveError` — is this tab usable
        at all. A Motion manifest lives inside a project, so `"no-project"`
        means open one in the Colorist tab first. This tool ANSWERS in that
        case rather than erroring, which is how you find it out.
      * `recovered` — `null`, or `{stale}` when a page reload put the previous
        page's UNSAVED edits back from the project's recovery copy (they are
        still unsaved: `motion_save_manifest` keeps them, `motion_reload_manifest`
        with `force=true` discards them). `stale: true` means the saved manifest
        changed after those edits were made, so saving replaces it.
      * `selection` — what is selected right now, as `[{sceneIndex, target}]`,
        the exact shape `motion_set_selection` takes back.
      * `playheadFrame` / `playerMounted` — where the preview is parked.
      * `fps`, `totalFrames`, `width`, `height`, `title` — the document's own
        output spec, all four of them written by
        `motion_set_project_settings`.
      * `render` — where a `motion_render` is: `state` (`idle`/`running`/
        `error`/`interrupted`), `scenesTotal` / `scenesDone` / `doneSceneIds`
        (real progress), `remainingSceneIds` (what is left), `sceneId` (the one
        rendering right now), and `failedSceneId` + `error` when one failed.
        `interrupted` is a render the app lost (a restart); `motion_render` with
        `resume=true` continues it. **This is how you find out
        a render failed.** A multi-scene render always outlives the 20s
        control-bridge timeout, so `motion_render`'s own reply is gone before
        a mid-loop failure happens; poll here instead of counting files on
        disk, which cannot tell "still rendering" from "stopped on a failure".
        A failed render stops at the failing scene, so `doneSceneIds` is
        exactly what is on disk and `failedSceneId` is what to fix.
      * `scenes` — one row per scene: `index`, `id`, `dur` (SECONDS), its
        absolute `startFrame` in the combined timeline, `layerCount`,
        `scene3dChildCount`, `camera2dKeys`, `camera3dKeys`.

    **Times in this tab are SECONDS, per scene, not absolute frames.** A
    keyframe's `at` is seconds from its own scene's start; `startFrame` here is
    what converts between the two (`frame = startFrame + at * fps`), and
    `motion_seek` accepts either form so you rarely have to do it yourself."#
    )]
    pub async fn motion_get_state(&self) -> Result<CallToolResult, ErrorData> {
        let env = self.op("motion_get_state", WireArgs::new()).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_set_layer_field",
        description = r#"Set one of a layer's OWN fields — its content and look: a text layer's
    `text`/`size`/`align`, a preset name, a colour, a `layers` primitive's
    `items`, and so on. The workhorse for shaping a layer after
    `motion_add_layer` creates it.

    Call `motion_list_primitives` for the legal keys per `use`. An unknown key
    is still WRITTEN (a hand-authored manifest may carry fields the Inspector
    does not know about) but returns a `warning` — check it if your change had
    no visible effect.

    This is NOT the tool for geometry: position/size have their own
    (`motion_set_layer_position` / `_size`), and scale/rotation/opacity live
    on the transform wrapper (`motion_set_layer_transform_field`).

    Args:
        scene_index: which scene.
        target: which layer — `{"kind": "layer", "index": N}` or
            `{"kind": "layer", "id": "..."}` (id preferred; see this section's
            header). Must resolve to a layer or scene3d-child.
        key: the field name.
        value: the new value. Pass null to DELETE the field."#
    )]
    pub async fn motion_set_layer_field(
        &self,
        Parameters(p): Parameters<MotionSetLayerFieldArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("scene_index", p.scene_index)
            .set("target", p.target)
            .set("key", p.key)
            .set("value", p.value);
        let env = self.op("motion_set_layer_field", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_get_manifest",
        description = r#"Read the Motion tab's LIVE scene manifest — the whole document, exactly
    as the preview is rendering it right now (parsed, not necessarily saved).

    The manifest is this tab's single source of truth, the way `grade.json` is
    for Colorist: `{title, width, height, fps, scenes: [{id, dur, camera?,
    layers?, scene3d?}]}`. Every other `motion_*` tool edits some part of it.

    Returns it alongside `loadState` ("ready" / "loading" / "no-project" /
    "error"), `parseError` (non-null when the raw-JSON editor currently holds
    something that does not parse — the preview keeps showing the last good
    value), `dirty` (unsaved changes) and `saveError`.

    For orientation prefer `motion_get_state` (scene summary + selection +
    playhead) and `motion_list_layers` (the addressing index) — this returns
    the entire document, which is a lot to read when you only need to know
    what is there."#
    )]
    pub async fn motion_get_manifest(&self) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new();
        let env = self.op("motion_get_manifest", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_list_layers",
        description = r#"Every addressable layer in the manifest, flattened, with the exact
    `target` every mutating tool wants — the Motion analogue of
    `editor_get_timeline`'s clip list.

    Per row: `sceneIndex`, `target` (ready to paste), `use` (which primitive),
    `label` (the same one-line name the GUI's own layer list shows),
    `position` and `size` in world px (null when that primitive has none —
    e.g. a `graph` or a 3D child is not draggable), `transformKeyCount`,
    `activeKeyCount`, and `itemCount` for a `layers` primitive.

    Use it to turn "the headline text in the second scene" into a real
    address, and to see which layers carry an `id` — prefer id-addressing, it
    survives a reorder; a bare index does not.

    Args:
        scene_index: only list this scene. Omit for every scene."#
    )]
    pub async fn motion_list_layers(
        &self,
        Parameters(p): Parameters<MotionListLayersArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new().put("scene_index", p.scene_index);
        let env = self.op("motion_list_layers", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_list_primitives",
        description = r#"Static reference: every primitive the motion engine can render, and the
    fields each one accepts. The Motion counterpart of
    `editor_get_capabilities` — call it once before your first
    `motion_add_layer` / `motion_set_layer_field`.

    Per primitive: the `use` string `motion_add_layer` requires, a one-line
    description of what it is for, `in3d` (whether it is a three.js object
    that must live in `scene.scene3d.children` rather than `scene.layers` —
    `motion_add_layer` places it correctly for you either way, and
    `container` states which target kind addresses it), the editable `fields`
    (key, label, kind) `motion_set_layer_field` accepts, and whether it has a
    draggable `position` / resizable `size` at all.

    Also returns `themes` (the registered looks, for
    `motion_set_project_theme`) and the `defaultTheme` a manifest with no
    `theme` key renders in, `projectFields` (the manifest's own top-level
    fields, for `motion_set_project_settings`), `sceneFields` (for
    `motion_set_scene_field`),
    `layerTransformFields` (for `motion_set_layer_transform_field`),
    `layerTransformKeyFields`, and the 2D/3D camera key fields.

    Several `fields` are `kind: "json"` — the primitive's own CONTENT, an array
    of objects rather than a scalar knob. Their labels spell out the item shape,
    because that shape is not otherwise discoverable: `graph`'s `edges`, for
    one, take `{from, to, directed?, weight?}`, where `weight` (0-1, default 1)
    scales how bright and how thick that edge draws — which is what lets a full
    mesh show WHICH connections matter rather than drawing every one the same.

    Without this, a legal `use` value or a field key is only discoverable by
    reading the app's source. `motion_set_layer_field` will still WRITE an
    unknown key (a hand-authored manifest may legitimately carry one) but
    warns — so check here first if something you set has no visible effect."#
    )]
    pub async fn motion_list_primitives(&self) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new();
        let env = self.op("motion_list_primitives", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_set_project_theme",
        description = r#"Set the DOCUMENT's theme — which registered look the whole manifest renders
    in (`manifest.theme`). A project-level setting: not per scene, not per
    layer. The document's other project-level fields (`title`/`width`/
    `height`/`fps`) are `motion_set_project_settings`; this one is separate
    because it is an enum that CLEARS to a default rather than a value.

    `motion_list_primitives` lists the registered `themes` and names the
    `defaultTheme`. Today there are three:

      - `dark-excalidraw` (the default) — flat dark slate, off-white
        hand-drawn roughjs strokes, Kalam lettering, one red and one blue
        accent, everything drifting very slightly.
      - `apelles-studio` — apelles.studio's own editorial look: warm-black
        basalt ground, marble ink, ONE ochre working colour, Newsreader /
        Instrument Sans / IBM Plex Mono, exact (non-sketch) geometry and no
        ambient drift.
      - `apelles-studio-light` — the same site's light page look: warm
        marble ground, basalt ink, terracotta emphasis with ochre marks, the
        same three faces and clean geometry.

    A theme supplies DEFAULTS only. A scene's own `bg`, and a layer's own
    `color` / `font` / `accent`, still win over it — so re-theming never
    silently discards a colour that was set deliberately, and a layer pinned
    to a literal colour will NOT follow the new palette.

    Pass null to clear the field back to the default look. That DELETES the
    key rather than writing the default's name into it, which is the shape
    every manifest authored before themes existed already has.

    A name nothing defines is rejected outright, unlike `motion_set_scene_field`
    (which warns and writes anyway): the manifest schema refuses a theme name
    that is neither a built-in nor the document's own embedded definition.
    A theme from the user LIBRARY is also a legal name (`motion_list_themes`):
    its definition is copied INTO the document, so the render stays
    deterministic on any machine. Define new themes with `motion_define_theme`.

    Undoable in the app (Cmd/Ctrl+Z), like any other Motion edit.

    Args:
        theme: the theme name, or null to clear it back to the default."#
    )]
    pub async fn motion_set_project_theme(
        &self,
        Parameters(p): Parameters<MotionSetProjectThemeArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new().set("theme", p.theme);
        let env = self.op("motion_set_project_theme", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_list_themes",
        description = r#"List every theme a Motion project can use (B-268): the compiled
    built-ins, the user's saved library, and what THIS document uses. Read-only;
    needs no project open for the first two.

    Returns `builtin` (name, description, `default`), `library` (each with its
    full `definition`, so you can copy or adapt one), `project` (`theme` name,
    `source` = `builtin` | `embedded` | `default`, and the `definition` when the
    document carries its own) or null when no manifest is loaded, and
    `defaultTheme`. Define a new one with `motion_define_theme`."#
    )]
    pub async fn motion_list_themes(&self) -> Result<CallToolResult, ErrorData> {
        let env = self.op("motion_list_themes", WireArgs::new()).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_define_theme",
        description = r#"Define a theme as DATA and give it to the document (B-268): a look that is not
    one of the compiled built-ins, with no engine change, commit or rebuild.

    A theme is a validated document: eight opaque `#rrggbb` colours (ground,
    deep ground, stroke, soft stroke, text, dim text, accent, signal accent),
    the stroke feel (`strokeWidth`, `roughness`, `bowing`, `ambientDriftPx`),
    three CSS font stacks (`fontDisplay`, `fontUi`, `fontMono`) and the Google
    Fonts families to download for them (`fonts`). It is built in this order, then
    validated as a whole, and nothing partial is ever stored:
      1. `base` -- a built-in, library or embedded theme to start from (default:
         the engine default, `dark-excalidraw`), so a few overrides are enough;
      2. `tokens_css` -- an optional CSS token file whose `--apelles-theme-*`
         custom properties override the base: `--apelles-theme-bg: #1c1a17;`,
         `--apelles-theme-stroke-width: 2;`, `--apelles-theme-font-display:
         'Newsreader', serif;`, `--apelles-theme-fonts: Newsreader:400,600 |
         Instrument Sans:400` (families separated by `|`). Values must be literal
         (no `var()`), which keeps the derivation deterministic;
      3. `theme` -- explicit fields, which win over both.
    `name` is the new theme's id (lowercase letters, digits, hyphens; never a
    built-in's name). Errors name the field (`bg: an opaque #rrggbb colour`).

    Where it goes -- `apply` (default true) EMBEDS the definition in this
    document's manifest (`themeDef`), which is what makes a render deterministic:
    the same manifest renders the same pixels on any machine, whatever that
    machine's library holds. `to_library` also saves it to the user library so
    other projects can pick it (`motion_set_project_theme`). `apply: false` with
    `to_library: false` is a dry run that returns the validated definition.

    A scene's own `bg` and a layer's own `color` / `font` still win over any
    theme. Fonts load from Google Fonts by family name at render time; a family
    Google does not have is skipped (the stack's fallbacks render) rather than
    failing the render.

    Undoable in the app when applied, like any other Motion edit. The library is
    user-level state, not part of the project, and is not in the undo stack."#
    )]
    pub async fn motion_define_theme(
        &self,
        Parameters(p): Parameters<MotionDefineThemeArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("name", p.name)
            .put("base", p.base)
            .put("theme", p.theme)
            .put("tokens_css", p.tokens_css)
            .put_if("to_library", p.to_library);
        // `apply` defaults TRUE, so only a `false` is sent.
        let args = if p.apply {
            args
        } else {
            args.set("apply", false)
        };
        let env = self.op("motion_define_theme", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_delete_theme",
        description = r#"Remove a theme from the user's theme library (B-268). Projects that already
    embed it keep their own copy by design: that copy is what makes their renders
    deterministic. Does not touch the compiled built-ins. Needs no project open."#
    )]
    pub async fn motion_delete_theme(
        &self,
        Parameters(p): Parameters<MotionDeleteThemeArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let env = self
            .op("motion_delete_theme", WireArgs::new().set("name", p.name))
            .await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_list_templates",
        description = r#"List the Motion TEMPLATES you can fill (D-407): saved designs with named
    slots (headline, logo, brand colour, a number...) that become a finished,
    on-brand scene -- or a group of layers -- in one call. Read-only; needs no
    project open.

    Two sources: the BUILT-IN starters for founder/brand videos (`logo-reveal`,
    `feature-callout`, `stat-counter`, `testimonial`, `pricing-card`,
    `cta-end-card`) and the user's own library (`motion_save_template`,
    `motion_define_template`).

    Returns `templates`, each `{id, name, version, kind, source, description,
    tags, authoredAt, slots, valuesSchema, hasTheme}`: `kind` is `scene` (becomes
    a new scene) or `group` (becomes one group layer inside a scene); `slots`
    are `{id, type, label, description?, default?, required?, constraints?}`
    with `type` one of text | number | color | image | icon | enum | list;
    `valuesSchema` is the same as one JSON Schema object, ready to fill. Also
    `tags` (every tag in use) and `loadErrors` (library files that could not be
    loaded, each named) when there are any.

    Args:
        tag: only templates carrying this tag (e.g. "pricing")."#
    )]
    pub async fn motion_list_templates(
        &self,
        Parameters(p): Parameters<MotionListTemplatesArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new().put("tag", p.tag);
        let env = self.op("motion_list_templates", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_get_template",
        description = r#"Read one Motion template in full (D-407), its `body` included, to see how
    it is built or to adapt it into a new one for `motion_define_template`.
    Returns `{template, source, valuesSchema}`. Needs no project open."#
    )]
    pub async fn motion_get_template(
        &self,
        Parameters(p): Parameters<MotionGetTemplateArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new().set("id", p.id);
        let env = self.op("motion_get_template", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_define_template",
        description = r#"Save a Motion template written as JSON into the user's library (D-407).

    Shape: `{schemaVersion: 1, id, name, version, description?, tags?,
    kind: "scene" | "group", authoredAt: {width, height, fps}, slots, body,
    themeDef?}`.
      * `slots`: `[{id, type, label, description?, default?, required?,
        constraints?}]`; `type` is text | number | color | image | icon | enum |
        list; `constraints` may hold `maxLen`, `minLen`, `min`, `max`,
        `integer`, `options` (enum), `minItems`, `maxItems`, `itemType`
        ("text" | "number", list). Slot ids are identifiers (letters, digits,
        `_`). An image value is an asset id from `motion_import_asset`
        (`sha256:<hex>.<ext>`), an icon a Phosphor name (`rocket-launch`), a
        colour `#rrggbb`.
      * `body`: for `kind: "scene"` a scene WITHOUT `id` (`{dur, layers, ...}`);
        for `kind: "group"` a list of 2D layers (instantiated as one group
        layer). Bind any value to a slot with `{"$slot": "<id>"}`; interpolate
        into text with `"{price}/mo"` (`{{` / `}}` are literal braces; a list
        slot interpolates one item per line); keep an array element (a layer)
        only when a slot has a value with `"$when": "<id>"`. That is ALL: there
        is no expression language. An unset optional slot REMOVES the key it is
        bound to, so the primitive's theme default applies -- leave colour slots
        optional to keep a template theme-aware.
      * pixel values are authored for `authoredAt` and reflowed to each
        project's canvas when instantiated.

    The template must parse AND expand with its defaults (a sample value is
    used for a required slot without one) into a valid scene, icon names
    included; otherwise nothing is saved and the answer carries `issues`
    `[{path, code, message, expected, hint}]`. Saving under an id the library
    already has makes it the next `version`; built-in ids are reserved.
    `dry_run=true` checks only. Returns `{saved, id, name, kind, version,
    previousVersion, slots, valuesSchema}`. Needs no project open; the library
    is user-level and not in the undo stack.

    Args:
        template: the template object.
        dry_run: check only, save nothing."#
    )]
    pub async fn motion_define_template(
        &self,
        Parameters(p): Parameters<MotionDefineTemplateArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("template", p.template)
            .put_if("dry_run", p.dry_run);
        let env = self.op("motion_define_template", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_save_template",
        description = r#"Capture a scene you built as a reusable Motion template (D-407) -- the way
    to turn a finished design into something an agent or a person can refill.

    Without `layers` the WHOLE scene becomes a scene template; with `layers`
    (layer ids in that scene) just those layers become a group template.

    Each slot names the field it replaces: `{id, path, type, label?,
    description?, required?, constraints?, default?}`. `path` is a field path
    inside the scene -- `layers[2].text`, `layers[headline].text` (a bracket
    that is not a number picks a layer by id), `layers[0].children[1].fill` --
    or, for a group template, inside the selected layers (`[headline].text`); a
    list of paths binds one slot to several fields (one brand colour used by
    three layers). `type` is text | number | color | image | icon | enum |
    list. The field's CURRENT value becomes the slot's default unless you give
    one; a field that is unset (reading the theme) stays optional and
    theme-aware.

    The canvas (`authoredAt`) and the document's own theme (`themeDef`, if it
    has one) are recorded. The template is checked to expand with its defaults
    before anything is saved; refusals carry `issues` with paths like
    `slots[1].path`. Saving under an existing id makes the next `version`.
    `dry_run=true` returns the template without saving it.

    Args:
        scene_index: the scene to capture.
        name: the template's name; the id defaults to its slug.
        slots: the slots, e.g. `[{"id": "headline", "type": "text", "path":
            "layers[headline].text", "label": "Headline"}]`.
        layers: layer ids for a group template (omit for the whole scene).
        id: the template id (lowercase letters, digits, hyphens).
        description: one line on what it is for.
        tags: e.g. ["brand", "intro"].
        dry_run: build and check, save nothing."#
    )]
    pub async fn motion_save_template(
        &self,
        Parameters(p): Parameters<MotionSaveTemplateArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("scene_index", p.scene_index)
            .set("name", p.name)
            .set("slots", p.slots)
            .put("layers", p.layers)
            .put("id", p.id)
            .put("description", p.description)
            .put("tags", p.tags)
            .put_if("dry_run", p.dry_run);
        let env = self.op("motion_save_template", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_instantiate_template",
        description = r#"Fill a Motion template's slots and put the result in the document, in ONE
    undoable step (D-407) -- a new on-brand scene with no layer-by-layer work.

    `values` is `{slotId: value}` (see `motion_list_templates`' `valuesSchema`);
    an omitted slot takes its default, and `null` clears an optional one (an
    optional icon or logo then disappears). Each value is checked against its
    slot's type and constraints; on any problem nothing changes and the answer
    carries `issues` `[{path, code, message, expected, hint}]` with paths like
    `values.headline` or `values.features[2]`. An image value is an asset id
    from `motion_import_asset`.

    Where it goes: a `scene` template becomes a NEW scene right after
    `after_scene_index` (default: at the end), named after the template
    (`stat-counter`, `stat-counter-2`, ...) unless you pass `scene_id`; a `group`
    template becomes one group layer on top of scene `into_scene_index`
    (required). The design is reflowed from the canvas it was authored on to
    this project's canvas.

    The document gets PLAIN layers (a copy: a render never depends on the
    library) plus provenance `template: {id, version, values}` on the scene (or
    group layer), which is what `motion_refill_template` re-expands from.
    `apply_theme=true` also embeds the template's own theme in the document
    (only if it carries one). Returns `{template, sceneIndex, sceneId, layerId?,
    values, reflowed, themeApplied, selection}`; `dry_run=true` checks without
    changing anything.

    Args:
        id: the template id.
        values: the slot values.
        after_scene_index: a scene template goes after this scene.
        into_scene_index: a group template goes into this scene.
        scene_id: the new scene's name (scene templates).
        apply_theme: also use the template's theme for the document.
        dry_run: check only."#
    )]
    pub async fn motion_instantiate_template(
        &self,
        Parameters(p): Parameters<MotionInstantiateTemplateArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("id", p.id)
            .put("values", p.values)
            .put("after_scene_index", p.after_scene_index)
            .put("into_scene_index", p.into_scene_index)
            .put("scene_id", p.scene_id)
            .put_if("apply_theme", p.apply_theme)
            .put_if("dry_run", p.dry_run);
        let env = self.op("motion_instantiate_template", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_refill_template",
        description = r#"Re-expand a template instance with new slot values (D-407): change the
    headline, the number or the logo of a scene made from a template without
    rebuilding it.

    The instance is scene `scene_index` (a scene template), or the group layer
    `layer_id` in it (a group template). `values` are merged over the ones it
    was made with (`null` clears an optional slot). The scene keeps its id and
    place; a group keeps its id, place, start time and transform. Copy
    semantics: everything else in the instance is regenerated from the
    template, so hand edits made to those layers since are replaced.

    Refused when the library's template is a different `version` from the one
    the instance was made with, unless `upgrade=true` (re-expand with the new
    version), and when the template is no longer in the library. Value
    problems come back as `issues` (`values.<slot>`). One undoable step.
    Returns `{template: {id, version, previousVersion}, sceneIndex, sceneId,
    layerId?, values}`; `dry_run=true` checks only.

    Args:
        scene_index: the scene (or the scene holding the group).
        values: the slots to change.
        layer_id: the group layer, for a group template instance.
        upgrade: allow re-expanding with a newer template version.
        dry_run: check only."#
    )]
    pub async fn motion_refill_template(
        &self,
        Parameters(p): Parameters<MotionRefillTemplateArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("scene_index", p.scene_index)
            .put("values", p.values)
            .put("layer_id", p.layer_id)
            .put_if("upgrade", p.upgrade)
            .put_if("dry_run", p.dry_run);
        let env = self.op("motion_refill_template", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_delete_template",
        description = r#"Remove a template from the user's library (D-407). Scenes already made
    from it keep their layers (they are copies) but can no longer be refilled.
    Built-in templates cannot be deleted. Needs no project open."#
    )]
    pub async fn motion_delete_template(
        &self,
        Parameters(p): Parameters<MotionDeleteTemplateArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new().set("id", p.id);
        let env = self.op("motion_delete_template", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_list_components",
        description = r#"List the custom Remotion components (D-409): the built-ins plus the
    user's library, one row per component id with every version and its status
    (`draft` or `certified`).

    A certified version is plain catalog data: put it in a scene with
    `motion_add_layer(use="custom:<id>")` (the newest certified version) or
    `use="custom:<id>@<version>"`, or as a `{"use": "custom", "component":
    "<id>@<version>", "props": {...}}` layer in `motion_insert_layers`,
    `motion_set_scene` or a template body. Each row carries `use` (the newest
    certified version, or null), `props` (the declared props, the same slot
    shape templates use), `propsSchema` (the JSON Schema of a whole layer of
    it), `size`, `duration` and per-version check results. Drafts cannot be
    used until certified. Needs no project open.

    Args:
        status: "draft", "certified" or "all" (default all).
        tag: only components with this tag."#
    )]
    pub async fn motion_list_components(
        &self,
        Parameters(p): Parameters<MotionListComponentsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new().put("status", p.status).put("tag", p.tag);
        let env = self.op("motion_list_components", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_get_component",
        description = r#"One custom component version in full (D-409): its declaration (props,
    size, duration), status, static-check warnings, certification proof, the
    contact sheet's path, and its SOURCE (`code`). The source is read-only:
    to change it, write the id again with `motion_write_component`, which
    makes a new draft. Needs no project open.

    Args:
        id: the component id.
        version: which version (default: the newest)."#
    )]
    pub async fn motion_get_component(
        &self,
        Parameters(p): Parameters<MotionComponentVersionArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new().set("id", p.id).put("version", p.version);
        let env = self.op("motion_get_component", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_write_component",
        description = r#"Write a custom Remotion component as a DRAFT (D-409) -- for what the
    primitives cannot build (a particle logo, a 3D product spin, a bespoke
    chart or transition). Lifecycle: write (draft) -> `motion_check_component`
    (certification renders) -> `motion_certify_component` -> use it as data.

    `source` is one TSX module whose DEFAULT export is a React component
    called with `{props, theme, width, height, durationInFrames}` (type it with
    `import type { ComponentProps } from "@apelles/component"`). Draw inside
    the `width` x `height` box; `useCurrentFrame()` counts from the layer's
    start. Read colours and fonts from `theme` (`theme.accent`, `theme.text`,
    `theme.bg`, `theme.fontDisplay`, ...) unless a colour prop is set.

    The static check refuses, with `issues` `[{path: "source:<line>:<col>",
    code, message, hint}]`: imports outside the allowlist (react, remotion,
    @remotion/shapes, @remotion/paths, @remotion/noise,
    @remotion/animation-utils, @remotion/three, three, @react-three/fiber,
    d3-force, d3-scale, d3-shape, d3-array, d3-interpolate, d3-format, roughjs
    (seeded: every drawing call needs a non-zero `seed`), @apelles/component);
    `Math.random` (use `random(seed)` from
    remotion); `Date`, `performance`, timers, `requestAnimationFrame` (use
    `useCurrentFrame()` / fps); `fetch`, `XMLHttpRequest`, `WebSocket`;
    `eval` / `Function`; dynamic `import()` / `require`; `window`,
    `globalThis`, `document`, `process`, `__TAURI__*`, storage, `constructor`
    / `__proto__`; a missing default export; and any TypeScript error (strict,
    against the real remotion/React types). Hard-coded colours come back as
    `warnings`.

    `props` declares the props, as template slots: `[{id, type: text |
    number | color | enum | list, label, description?, default?, required?,
    constraints?: {min, max, integer, maxLen, minLen, options, minItems,
    maxItems, itemType}}]`. A colour prop has NO default (unset, the
    component reads the theme). Numbers and colours are keyframeable on a
    layer (`anim: {"props.<id>": [...]}`).

    Nothing is saved unless the declaration and the source both pass. If the
    id's newest version is an uncertified draft it is replaced; after a
    certified version the next version number starts. Certified versions
    never change. Returns `{id, version, status, sourceHash, codeHash,
    warnings}`; `dry_run=true` checks only. Needs no project open.

    Args:
        id: lowercase letters, digits, hyphens (e.g. "particle-burst").
        source: the component's TSX.
        props: the declared props (default none).
        name: a display name (default: the id).
        description: one line on what it is for.
        tags: e.g. ["data", "intro"].
        size: its design box `{"w": 1920, "h": 1080}` (default: the project
            canvas); a layer's w/h default to it.
        duration: seconds it is meant to play (default 3); what the check
            renders.
        dry_run: check only, save nothing."#
    )]
    pub async fn motion_write_component(
        &self,
        Parameters(p): Parameters<MotionWriteComponentArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("id", p.id)
            .set("source", p.source)
            .put("props", p.props)
            .put("name", p.name)
            .put("description", p.description)
            .put("tags", p.tags)
            .put("size", p.size)
            .put("duration", p.duration)
            .put_if("dry_run", p.dry_run);
        let env = self
            .op_with(
                "motion_write_component",
                crate::MOTION_COMPONENT_TIMEOUT_MS,
                args,
            )
            .await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_check_component",
        description = r#"Run a custom component's CERTIFICATION CHECK and see it (D-409).

    Renders sample frames (start, a third, two thirds, end) of three variants
    -- the declared defaults, every prop at the LOW edge of its constraints,
    every prop at the HIGH edge (colour props set) -- three ways at once: every
    frame in order in one browser tab, and two passes of fresh stills seeking
    backwards and out of order. Every frame's pixels must be identical across
    the three, which proves the component is a pure function of (props,
    frame). Renders run in the Remotion renderer process, never in the app.

    Returns the contact sheet (one row per variant) as an image, then `{ok,
    id, version, path, frames: [{variant, frame, hashes, same}], passes,
    mismatched?, hint?, error?}`. The result is recorded on a draft; it
    certifies nothing by itself -- look at the sheet, then
    `motion_certify_component`. The first check after an engine change
    bundles it (~20 s), then about a minute. Needs no project open.

    Args:
        id: the component id.
        version: which version (default: the newest)."#
    )]
    pub async fn motion_check_component(
        &self,
        Parameters(p): Parameters<MotionComponentVersionArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new().set("id", p.id).put("version", p.version);
        let env = self
            .op_with(
                "motion_check_component",
                crate::MOTION_COMPONENT_TIMEOUT_MS,
                args,
            )
            .await?;
        Ok(render::file_png_result(&env, true, "rendered"))
    }

    #[tool(
        name = "motion_certify_component",
        description = r#"Certify a custom component version (D-409): refused unless its
    certification check (`motion_check_component`) passed for exactly the
    source and module it has now. From then on the version is immutable and
    usable as data: `motion_add_layer(use="custom:<id>@<version>")`. Projects
    that use it get their own copy (a render never depends on the library).
    Certification is always this explicit call; passing the check never
    certifies on its own. Returns `{certified, id, version, use, component,
    sourceHash, codeHash, propsSchema}`. Needs no project open.

    Args:
        id: the component id.
        version: which version (default: the newest)."#
    )]
    pub async fn motion_certify_component(
        &self,
        Parameters(p): Parameters<MotionComponentVersionArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new().set("id", p.id).put("version", p.version);
        let env = self.op("motion_certify_component", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_delete_component",
        description = r#"Delete a custom component from the user's library (D-409): one version,
    or every version when `version` is omitted. Documents that use it keep
    their own copies and still render. Built-in components cannot be deleted.
    Needs no project open.

    Args:
        id: the component id.
        version: the version to delete (default: all of them)."#
    )]
    pub async fn motion_delete_component(
        &self,
        Parameters(p): Parameters<MotionComponentVersionArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new().set("id", p.id).put("version", p.version);
        let env = self.op("motion_delete_component", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_set_project_settings",
        description = r#"Set the manifest's OWN top-level fields — the document's name and its
    output spec. The Motion twin of `set_project_settings` (Colorist), and
    until this existed these four were reachable only by hand-editing the
    raw-JSON manifest (B-222).

    `width`/`height` are the pixel size EVERY scene renders at; `fps` is the
    timebase every `at`/`dur` in SECONDS is converted against; `title` is the
    document's own label. Read them back from `motion_get_state`.

    Partial merge — only the arguments you pass are changed — and ONE commit
    (one Cmd/Ctrl+Z) for all of them, which is why `width` and `height` are
    arguments of the same tool rather than two calls: a resize sent in two
    steps passes through a wrong aspect ratio on the way.

    **Validation is a refusal, not a clamp.** Remotion validates these itself
    and throws: `width`/`height` must be positive INTEGERS, `fps` a positive
    number (fractional is fine — 23.976/29.97 are real). A bad value does not
    render badly, it takes down the live preview, so it is rejected here and
    the manifest is left alone. An ODD width/height is legal and returns a
    `warning`: the h264 render silently rounds it DOWN to even.

    **Changing `width`/`height`/`fps` makes every EXISTING scene render stale**
    — those files were produced at the old spec, and any Edit-tab clip reading
    one is now the wrong size (or the wrong length). The reply says so in
    `renders`: `stale`, how many `scenes` have a render and how many `clips`
    read them, and `sceneIds`. It does NOT re-render — a render is explicit,
    `motion_render`, never a side effect. `linkDataAvailable: false` means no
    link data reached the tab at all, which is not the same answer as
    "nothing has been rendered yet" (see `motion_get_edit_links`).

    **`reflow` (D-346, DEFAULT TRUE) moves the LAYERS with the canvas**, and
    is the thing to understand before resizing anything. A layer's `x`/`y`/
    `size` are RAW WORLD PIXELS — there is no design-space normalisation
    anywhere between the manifest and the rendered DOM — so changing
    `width`/`height` on its own leaves every layer at its old coordinates in a
    differently-shaped frame: the composition sits in one corner with dead
    space around it, at the wrong relative size. Doubling a 1920x1080 manifest
    to 4K that way does NOT give you a 4K graphic, it gives you a broken one
    (which is why `Config.setScale(2)` renders at 4K instead, D-342).

    With `reflow` on, the whole layout is remapped onto the new canvas in the
    same commit: x-positions and widths by `newW/oldW`, y-positions and
    heights by `newH/oldH`, and anything that cannot stretch per axis without
    distorting (a font `size`, a `nodeR`, a `matrix` `cell`/`gap`, a
    `deviceframe` `scale`) by `min` of the two. A `graph`'s own node
    coordinates, an `emphasis` box's `[x,y,w,h]`, a plot annotation's `dy` and
    every `transform` key's pixel offset move with it. The reply reports
    `scaleX`/`scaleY`/`scaleUniform` and how many `layersMoved`.

    It is a proportional remap, NOT a layout engine: it does not know that
    text wraps. A reflow that changes the ASPECT RATIO puts everything in the
    right place at the right relative size and can still leave a caption that
    was one line sitting on three — expect to fix the overflows afterwards,
    not to re-place every layer. Timing (`at`/`dur`/`stagger`), content (a
    `plot`'s `values`/`baseline`, an edge's `weight`, `rows`/`cols`, any
    `seed`) and `scene3d` children (3D world units, not canvas pixels) are
    deliberately untouched; skipped 3D scenes are named in `warning`.

    Pass `reflow=False` for the raw behaviour — write the dimensions, move
    nothing — e.g. when the layers were already authored for the new canvas.

    `theme` is NOT set here — it is an enum with its own clear-to-default
    semantics: `motion_set_project_theme`.

    Args:
        title: the document's name. Trimmed; an empty one is refused.
        width: output width in px — a positive integer.
        height: output height in px — a positive integer.
        fps: frames per second — positive, fractional allowed.
        reflow: remap every layer onto the new canvas (default True). Ignored,
            with a `warning`, when neither width nor height changes."#
    )]
    pub async fn motion_set_project_settings(
        &self,
        Parameters(p): Parameters<MotionSetProjectSettingsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .put("title", p.title)
            .put("width", p.width)
            .put("height", p.height)
            .put("fps", p.fps);
        if args.is_empty() {
            // Same shape as `set_project_settings` (Colorist): a partial merge of
            // nothing is refused here rather than sent, with a bare `{error}` and no
            // `ok` key — what the Python answers.
            return Ok(render::json_text(&serde_json::json!({
                "error": "pass at least one of title, width, height, fps",
            })));
        }
        let args = args.set("reflow", p.reflow);
        let env = self.op("motion_set_project_settings", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_add_scene",
        description = r#"Add a new empty 4-second scene — the same action the layer panel's own
    "+ Scene" button performs.

    Scenes play back to back in array order, and each renders to its OWN
    separate video file (see `motion_render`), so a scene is the unit of "one
    shot" here, not a track. The new scene is inserted directly AFTER
    `after_scene_index` (matching the GUI, which inserts after whatever is
    selected) or appended at the end when omitted. Every later scene's index
    shifts by one — re-read `motion_get_state` afterwards.

    **Name it here.** A scene's `id` is its DISPLAY NAME — the layer panel's
    section header, the scene selector, and the filename `motion_render` writes
    (`motion/renders/<id>.mp4`). Pass `id` and the scene is created under that
    name; omit it and you get a generated `scene-xxxxxx` you would then have to
    rename, which is harder once the scene has been rendered and placed (see
    `motion_set_scene_field`). An id must be non-empty, free of "/", "\" and
    control characters (it becomes a filename), and not already taken by
    another scene — any of those is refused with a reason, and nothing is
    created.

    Returns the new scene's `sceneIndex`/`sceneId` and a `selection` addressing
    it. Set its length with
    `motion_set_scene_field(key="dur", value=<seconds>)`.

    Args:
        after_scene_index: insert after this scene. Omit to append.
        id: the new scene's name. Omit for a generated one."#
    )]
    pub async fn motion_add_scene(
        &self,
        Parameters(p): Parameters<MotionAddSceneArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .put("after_scene_index", p.after_scene_index)
            .put("id", p.id);
        let env = self.op("motion_add_scene", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_delete_scene",
        description = r#"Delete a whole scene — every layer in it, its camera and its 3D block go
    with it. The same action the layer panel's own per-scene delete button
    performs (which asks for a confirming second click; this tool does not).

    **Refused for the last remaining scene**: a manifest must have at least one
    (the schema enforces it), so there is no "empty composition" state to reach
    this way. Delete the layers instead, or add another scene first.

    Every LATER scene's index shifts down by one, so any `scene_index` you were
    holding is stale afterwards — re-read `motion_get_state`. The live GUI
    selection is moved to the scene that took the deleted one's place, since the
    old one no longer exists.

    Undoable in the app (Cmd/Ctrl+Z), like any other Motion edit.

    Args:
        scene_index: which scene to delete."#
    )]
    pub async fn motion_delete_scene(
        &self,
        Parameters(p): Parameters<MotionDeleteSceneArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new().set("scene_index", p.scene_index);
        let env = self.op("motion_delete_scene", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_duplicate_scene",
        description = r#"Copy a whole scene — layers, camera, 3D block — in directly after itself.
    The layer panel's own per-scene duplicate button.

    This is the tool for "the same shot again, with one thing changed": each
    scene renders to its OWN video file (`motion_render`), so duplicating one is
    how you get a variant without rebuilding it layer by layer.

    The copy gets a NEW scene id and a new `id` on every layer inside it, so
    nothing you address by `id` afterwards is ambiguous. Every later scene's
    index shifts up by one — re-read `motion_get_state`.

    Returns the copy's `sceneIndex`/`sceneId` and a `selection` addressing it.

    Args:
        scene_index: the scene to copy."#
    )]
    pub async fn motion_duplicate_scene(
        &self,
        Parameters(p): Parameters<MotionDuplicateSceneArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new().set("scene_index", p.scene_index);
        let env = self.op("motion_duplicate_scene", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_set_scene_field",
        description = r#"Set one field on a SCENE itself (not on a layer) — most often `dur`, the
    scene's length in SECONDS, which decides how long its shot runs and is the
    clamp every keyframe time in it is bound to.

    `motion_list_primitives`' `sceneFields` lists the known keys; an
    unrecognised one is still written (a hand-authored manifest may carry
    fields the Inspector does not know) but comes back with a `warning`.

    **`key="id"` is a RENAME and is checked, not just written.** A scene's id
    is its display name AND the name of the file it renders to
    (`motion/renders/<id>.mp4`) AND the key the Motion→Edit link is made of —
    the `motionSceneId` stamp put on the media-pool item at render time. A
    rename does NOT follow that stamp, so renaming a scene whose render is
    already in Sources (or placed on the Edit timeline) would leave those clips
    reading the old file while a re-render writes a new one under the new name,
    refreshing nothing. That case is refused with a reason naming the clips it
    would orphan; pass `force=true` to do it anyway and accept the broken link.
    An id that is empty, has leading/trailing whitespace, contains "/", "\" or
    a control character, or collides with another scene is refused outright —
    `force` does not lift those. To rename a scene cleanly: rename it, then
    re-render it and re-place (or re-link) its clips.

    Args:
        scene_index: which scene.
        key: the field, e.g. "dur" or "id".
        value: the new value. Pass null to DELETE the field.
        force: for key="id" only — rename even though it orphans a render."#
    )]
    pub async fn motion_set_scene_field(
        &self,
        Parameters(p): Parameters<MotionSetSceneFieldArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("scene_index", p.scene_index)
            .set("key", p.key)
            .set("value", p.value)
            .set("force", p.force);
        let env = self.op("motion_set_scene_field", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_set_camera_2d",
        description = r#"Replace a scene's 2D camera animation — the push-ins and pans over the
    flat layers, `[{at, x?, y?, zoom?, ease?}]`.

    `at` is SECONDS from this scene's start. `x`/`y` are the world point the
    camera centres on and `zoom` is a multiplier (`1` = fit). One key alone is
    a static framing; two or more animate between them.

    **This REPLACES the whole array** — it is the only way to change a camera
    key's VALUES, because the app has no granular per-key camera write. To
    tweak one key: read the array from `motion_get_manifest`, edit it, send it
    all back. (`motion_move_camera_keyframe` retimes ONE key without a
    resend, but cannot change its values.)

    `ease` is a 4-number cubic bezier `[x1, y1, x2, y2]`. `x1`/`x2` outside
    `0..1` are clamped with a warning (the runtime throws on them); `y`
    outside `0..1` is legal and means real overshoot -- but not unbounded
    (B-166): `y1`/`y2` are silently clamped to `-0.75..1.75`, with a warning
    if that changed anything. A malformed ease is a hard error, never
    silently dropped.

    Args:
        scene_index: which scene.
        keys: the complete new key list, in any order (sorted by `at`)."#
    )]
    pub async fn motion_set_camera_2d(
        &self,
        Parameters(p): Parameters<MotionSetCamera2DArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("scene_index", p.scene_index)
            .set("keys", p.keys);
        let env = self.op("motion_set_camera_2d", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_set_camera_3d",
        description = r#"Replace a scene's 3D camera animation — `[{at, pos: [x,y,z], look?:
    [x,y,z], ease?}]`, needing at least one key.

    Only meaningful for a scene that HAS a `scene3d` block. A scene without
    one is refused by name, and the only way to create one today is to add a
    3D primitive (`motion_add_layer` with a `use` whose `in3d` is true — see
    `motion_list_primitives`), which brings a default camera with it.

    Same wholesale-replace rule and same `ease` validation as
    `motion_set_camera_2d`; see that tool for both.

    Args:
        scene_index: which scene.
        keys: the complete new key list (non-empty)."#
    )]
    pub async fn motion_set_camera_3d(
        &self,
        Parameters(p): Parameters<MotionSetCamera3DArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("scene_index", p.scene_index)
            .set("keys", p.keys);
        let env = self.op("motion_set_camera_3d", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_add_layer",
        description = r#"Create a layer — the same action the Catalog panel's own primitive rows
    perform. This is how anything gets onto a Motion scene.

    `use` names the primitive (`motion_list_primitives` lists them all with
    what each is for). A schema-valid DEFAULT instance is inserted, so the
    result renders immediately; shape it afterwards with
    `motion_set_layer_field` (its own content/preset fields),
    `motion_set_layer_position` / `_size` (where and how big) and
    `motion_set_layer_transform_field` (scale/rotation/opacity).

    Placement is automatic and not yours to choose: a 2D primitive goes into
    `scene.layers`, a 3D one into `scene.scene3d.children` (creating that
    block, with a default camera, if the scene had none). Layers paint in
    array order — a later layer draws ON TOP — so use `motion_reorder_layers`
    to change what covers what.

    Returns the `selection` addressing the new layer; hand it straight to the
    next call.

    `props` (D-403) creates a FINISHED layer in this one call: the fields you
    name are laid over the default instance (the rest keep their defaults),
    and the merged layer is validated against the primitive's `propsSchema`
    (`motion_list_primitives`) before anything changes. A wrong type or an
    unknown key (a typo such as `colour`) is refused with `issues`
    `[{path, code, message, expected, hint}]` and nothing is added. `use` and
    `id` cannot be set through `props`. To insert several finished layers in
    one undo step, use `motion_insert_layers`.

    `use="custom:<id>"` (D-409) inserts a CERTIFIED custom component instead
    (`motion_list_components`): the newest certified version, or
    `custom:<id>@<version>` to pin one. It is installed into the project and
    embedded in the document, placed centred at its own size; `props` are its
    declared props, checked against their constraints.

    Args:
        scene_index: which scene to add to.
        use: the primitive, e.g. "text", or "custom:<id>" for a certified
            custom component. An unknown value is refused with the full legal
            list.
        props: optional fields of the new layer, e.g.
            `{"text": "Ship it", "size": 96, "x": 200, "y": 300}`."#
    )]
    pub async fn motion_add_layer(
        &self,
        Parameters(p): Parameters<MotionAddLayerArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("scene_index", p.scene_index)
            .set("use", p.primitive)
            .put("props", p.props);
        let env = self.op("motion_add_layer", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_validate",
        description = r#"Dry-run the Motion schema (D-403): check a whole `manifest`, one
    `scene`, or a list of `layers` WITHOUT changing anything. Pass at most one
    of the three; pass none to check the live document in the app.

    Returns `{checked, ok, loads, issues}`:
      * `ok` -- no issue at all, unknown keys included. This is what
        `motion_insert_layers` / `motion_set_scene` / `motion_add_layer(props)`
        require, so a fragment that is `ok` here will be accepted there.
      * `loads` -- the app would accept it as-is (types of known fields are
        right). Existing project files may load with unknown keys; authoring
        refuses them because an unknown key is almost always a typo that
        renders as nothing.
      * `issues` -- `[{path, code, message, expected, hint}]`. `path` reads
        like `scenes[0].layers[2].size`; `code` is stable (`invalid_type`,
        `missing_field`, `invalid_value`, `unrecognized_key`, `unknown_use`,
        `unknown_icon`, `too_small`, ...); `expected` is what would have been accepted (a type,
        the enum's options, the known keys); `hint` is a concrete fix such as
        `did you mean "color"?`.

    Every mutating `motion_*` tool returns this same `issues` list when it
    refuses, so you can fix a call from its answer alone.

    Args:
        manifest: a whole manifest `{title, width?, height?, fps?, scenes}`.
        scene: one scene `{id?, dur, layers?, camera?, scene3d?, bg?, ...}`.
        layers: a list of layers, each `{use, ...props}` (see each primitive's
            `propsSchema` in `motion_list_primitives`).
        scene_index: with `scene`, report paths under `scenes[scene_index]`."#
    )]
    pub async fn motion_validate(
        &self,
        Parameters(p): Parameters<MotionValidateArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .put("manifest", p.manifest)
            .put("scene", p.scene)
            .put("layers", p.layers)
            .put("scene_index", p.scene_index);
        let env = self.op("motion_validate", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_import_asset",
        description = r#"Bring an image (a logo, a screenshot, a product shot) into the project so
    an `image` layer can show it (D-404).

    The file is copied into the project's own asset folder
    (`<project>.chroma/motion/assets/`) and named by the SHA-256 of its bytes.
    The answer's `id` -- `sha256:<64 hex>.<ext>` -- is what an `image` layer's
    `src` takes; a manifest NEVER holds a file path, so the document renders
    the same on any machine and a later change to the original file cannot
    change a render. Importing the same bytes again returns the same `id` and
    writes nothing (`copied: false`).

    Accepted: png, jpg/jpeg, webp, gif, svg. Returns `{id, fileName, path,
    bytes, copied, width, height, layerExample}` (`width`/`height` are null
    for an svg); `layerExample` is a minimal layer using it.

    Args:
        path: absolute path to the image file."#
    )]
    pub async fn motion_import_asset(
        &self,
        Parameters(p): Parameters<MotionImportAssetArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new().set("path", p.path);
        let env = self.op("motion_import_asset", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_set_soundtrack",
        description = r#"Set the document's soundtrack — the music its moves are timed to — and
    analyse its beats (D-413). One undo step. ONE track for the whole document:
    music time at composition second t is `offset + t`, in every scene.

    - `path` — an audio file to import (mp3, wav, m4a, aac, flac, ogg); it is
      copied into the project by content hash, like an image. Or `asset` — an
      audio asset id already imported. Omit both to change the other fields
      of the current soundtrack.
    - `offset` — seconds INTO the song at which the video starts.
    - `volume` — 0..1, for the player and a render.
    - `render` — mux the music into the rendered scene files (default false:
      it is a timing reference, and scenes are usually cut together under one
      bed on the Edit timeline). The live player always plays it.
    - `meter` (2..7, default 4) and `tempo_hint` (30..300 BPM) — the beat
      analysis parameters, stored in the document.
    - `clear` — remove the soundtrack.

    Answers the soundtrack, `tempoBpm`, and per scene its beat and downbeat
    counts and first downbeat (scene seconds) — read `motion_get_beats` next.
    Audio never changes a rendered pixel."#
    )]
    pub async fn motion_set_soundtrack(
        &self,
        Parameters(p): Parameters<MotionSetSoundtrackArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .put("path", p.path)
            .put("asset", p.asset)
            .put("offset", p.offset)
            .put("volume", p.volume)
            .put("render", p.render)
            .put("meter", p.meter)
            .put("tempo_hint", p.tempo_hint)
            .put_if("clear", p.clear);
        let env = self
            .op_with(
                "motion_set_soundtrack",
                crate::BEAT_ANALYSIS_TIMEOUT_MS,
                args,
            )
            .await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_get_beats",
        description = r#"The soundtrack's beats inside one scene, in SCENE seconds (D-413):
    `[{n, at, bar, beat, downbeat, strong, strength}]`, `n` counting from 1
    within the scene — the numbers the cues of `motion_time_to_music` use.
    `kind`: `beat` (default), `downbeat` or `strong`. Refused when the
    document has no soundtrack (`motion_set_soundtrack`)."#
    )]
    pub async fn motion_get_beats(
        &self,
        Parameters(p): Parameters<MotionGetBeatsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("scene_index", p.scene_index)
            .put("kind", p.kind);
        let env = self
            .op_with("motion_get_beats", crate::BEAT_ANALYSIS_TIMEOUT_MS, args)
            .await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_time_to_music",
        description = r#"Time named moves to the soundtrack's beats in one scene, as ONE undo
    step (D-413). E.g. "time the hero reveal to the first downbeat, land the
    scale-up on the next strong beat, smaller accents on the beats between":

        moves = [
          {"name": "reveal",  "cue": "downbeat 1",       "layer": "hero", "track": "enter"},
          {"name": "scale",   "cue": "next strong beat", "layer": "hero", "track": "transform", "anchor": "end"},
          {"name": "accents", "cue": "every beat between", "layers": ["dot1", "dot2"], "track": "enter"},
        ]

    Each move: `name`; `cue`; `layer` (id or index; a group, a template
    instance or a custom component is one layer) or `layers` (several, each
    one item); `track` — which keys: `all` (transform + anim, default),
    `transform`, `anim`, `anim:<prop>` (e.g. `anim:props.count`), `enter`
    (the layer's start, `at`) or `camera` (the scene's 2D camera, no layer);
    `keys` — `all` (default), `first`, `last` or indices in time order;
    `anchor` — `start` (default: the move's first key goes on the beat) or
    `end` (its last key LANDS on the beat). The move's other keys shift with
    its anchor, so a move keeps its own timing.

    Cues (1-based, counted within the scene; kind = beat | downbeat | strong
    beat): `beat N`, `downbeat N`, `strong beat N`, `bar N`, `bar N beat M`,
    `first <kind>`, `last <kind>`, `next <kind>` (after the previous
    single-beat move), `next <kind> after <move>`, `every <kind> between`
    (strictly between the two single-beat moves listed before it; items are
    spread evenly over those beats), `every <kind> between <a> and <b>`.

    Refused, naming the move, when a cue has no such beat, a key would leave
    the scene or pass another key, or two moves claim one key. `dry_run`
    answers the plan without changing anything. Read `motion_get_beats` first."#
    )]
    pub async fn motion_time_to_music(
        &self,
        Parameters(p): Parameters<MotionTimeToMusicArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("scene_index", p.scene_index)
            .set("moves", p.moves)
            .put_if("dry_run", p.dry_run);
        let env = self
            .op_with(
                "motion_time_to_music",
                crate::BEAT_ANALYSIS_TIMEOUT_MS,
                args,
            )
            .await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_snap_to_beats",
        description = r#"Move every key of the chosen layers onto its nearest soundtrack beat
    within `tolerance_s` (default 0.1 s), as ONE undo step (D-413) — the
    keyframe timeline's magnet, in bulk.

    - `layers` — layer ids; default every layer in the scene.
    - `track` — `all` (default), `transform`, `anim`, `anim:<prop>`, `enter`.
    - `to` — `beat` (default), `downbeat` or `strong`.
    - `include_camera` — the scene's 2D camera keys too.
    - `dry_run` — report, change nothing.

    A key with no beat close enough, or whose beat is taken by its neighbour,
    stays where it is and says why."#
    )]
    pub async fn motion_snap_to_beats(
        &self,
        Parameters(p): Parameters<MotionSnapToBeatsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("scene_index", p.scene_index)
            .put("layers", p.layers)
            .put("track", p.track)
            .put("to", p.to)
            .put("tolerance_s", p.tolerance_s)
            .put_if("include_camera", p.include_camera)
            .put_if("dry_run", p.dry_run);
        let env = self
            .op_with(
                "motion_snap_to_beats",
                crate::BEAT_ANALYSIS_TIMEOUT_MS,
                args,
            )
            .await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_insert_layers",
        description = r#"Insert WHOLE layers into one scene in ONE undoable step (D-403) -- the
    way to build a graphic as data instead of `motion_add_layer` plus a field
    call per property.

    Each layer is a full manifest fragment `{use, ...props}` validated against
    its primitive's `propsSchema` (`motion_list_primitives`); unknown keys are
    refused. If ANY layer has an issue, nothing is inserted and the answer
    carries `issues` `[{path, code, message, expected, hint}]` (paths like
    `layers[1].size`) -- the same list `motion_validate` gives.

    Placement follows the primitive: 2D layers go into `scene.layers` (at
    index `at`, default on top = the end; later layers paint over earlier
    ones), 3D primitives into `scene.scene3d.children` (created with a
    default camera when absent). A layer keeps the `id` you give it when that
    id is free in the scene, so you can address your own layers by name
    afterwards; otherwise one is minted. Times are SECONDS within the scene.

    Returns `{sceneIndex, count, selections}` -- one selection per inserted
    layer, in order. `dry_run=true` validates and reports without changing
    anything.

    Args:
        scene_index: which scene.
        layers: the layers, e.g. `[{"use": "text", "id": "headline", "text":
            "Ship it", "size": 96, "x": 200, "y": 300}]`.
        at: index in `scene.layers` for the 2D layers (default: the end).
        dry_run: validate only."#
    )]
    pub async fn motion_insert_layers(
        &self,
        Parameters(p): Parameters<MotionInsertLayersArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("scene_index", p.scene_index)
            .set("layers", p.layers)
            .put("at", p.at)
            .put_if("dry_run", p.dry_run);
        let env = self.op("motion_insert_layers", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_set_scene",
        description = r#"Replace one WHOLE scene, or append a new one, in ONE undoable step
    (D-403).

    `scene` is a full scene fragment `{id?, dur, bg?, grain?, vignette?,
    transition?, camera?, layers?, scene3d?}`, validated strictly (unknown keys
    refused) with every layer checked against its primitive's `propsSchema`.
    On any issue nothing changes and the answer carries `issues`
    `[{path, code, message, expected, hint}]` (paths like
    `scenes[2].layers[0].text`).

    `scene_index` = an existing index REPLACES that scene entirely (its old
    layers and camera are gone unless the fragment repeats them);
    `scene_index` = the scene count APPENDS. Omit `id` to keep the scene's
    current name (or get a generated one when appending); a different `id` is
    a rename and is refused when it would collide with another scene or orphan
    a render already placed on the Edit timeline (the same rules as
    `motion_set_scene_field`). Layer ids are kept when unique within the scene.
    Times are SECONDS within the scene.

    Returns `{sceneIndex, sceneId, appended, layerCount, scene3dChildCount}`;
    `dry_run=true` validates without changing anything.

    Args:
        scene_index: the scene to replace, or the scene count to append.
        scene: the scene object.
        dry_run: validate only."#
    )]
    pub async fn motion_set_scene(
        &self,
        Parameters(p): Parameters<MotionSetSceneArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("scene_index", p.scene_index)
            .set("scene", p.scene)
            .put_if("dry_run", p.dry_run);
        let env = self.op("motion_set_scene", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_preview_frame",
        description = r#"SEE a Motion scene: render still frames through the real engine (the
    same Remotion renderer `motion_render` uses) and get the picture back in
    this call (D-403).

    One frame comes back as one PNG; several come back as ONE contact sheet,
    tiled left to right then down (at most 4 per row, at most 12 frames), so
    you can read a motion -- its start, middle and settle -- in one image.
    Choose frames by `at_seconds` (SECONDS within the scene) or `frames`
    (frame numbers within the scene), not both; neither renders the scene's
    midpoint. Out-of-range times are clamped to the scene (with a `warning`).

    What is rendered: the app's LIVE document, unsaved edits included -- or,
    when you pass `manifest`, that document INSTEAD (validated to load
    first), so you can look at a change before committing it.

    `scale` is the render scale, 0.1-1 (default 0.5 = half resolution). The
    first preview after the engine changes bundles it (~20 s); later ones take
    about 1-2 s per frame.

    Returns the image, then `{path, width, height, columns, rows, sceneIndex,
    sceneId, scale, frames: [{frame, seconds, absoluteFrame}],
    previewedUncommitted, warning?}`.

    Args:
        scene_index: which scene.
        at_seconds: times within the scene, e.g. `[0.2, 1.0, 2.5]`.
        frames: frame numbers within the scene, e.g. `[0, 15, 30]`.
        scale: render scale in (0, 1].
        manifest: a whole manifest to preview instead of the live one."#
    )]
    pub async fn motion_preview_frame(
        &self,
        Parameters(p): Parameters<MotionPreviewFrameArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("scene_index", p.scene_index)
            .put("at_seconds", p.at_seconds)
            .put("frames", p.frames)
            .put("scale", p.scale)
            .put("manifest", p.manifest);
        let env = self
            .op_with(
                "motion_preview_frame",
                crate::MOTION_PREVIEW_TIMEOUT_MS,
                args,
            )
            .await?;
        Ok(render::file_png_result(&env, true, "rendered"))
    }

    #[tool(
        name = "motion_delete_layer",
        description = r#"Remove one layer (or one 3D scene child) — the delete button on that row
    in the layer list.

    **Address it by `id` when you can.** Deleting a layer shifts every index
    after it, so a plan that deletes several layers by bare `index` deletes the
    wrong ones after the first. `motion_list_layers` gives you each layer's
    `target` including its `id`, and an `id` keeps naming the same layer no
    matter what moves. (A hand-authored manifest's layers may have no `id` at
    all — then delete from the HIGHEST index downwards.)

    The GUI selection moves to the layer that slid into the deleted slot, or to
    the parent scene when that was the last one. Emptying `scene.layers`
    removes the key rather than leaving an empty array; an emptied
    `scene3d.children` stays, because the 3D camera lives in that same block.

    Undoable in the app (Cmd/Ctrl+Z). Returns what was removed and how many
    layers remain.

    Args:
        scene_index: which scene the layer is in.
        target: {kind, index?, id?} — kind is "layer" or "scene3d-child"."#
    )]
    pub async fn motion_delete_layer(
        &self,
        Parameters(p): Parameters<MotionDeleteLayerArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("scene_index", p.scene_index)
            .set("target", p.target);
        let env = self.op("motion_delete_layer", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_duplicate_layer",
        description = r#"Copy one layer (or 3D scene child) in directly ABOVE itself in paint
    order — the duplicate button on that row in the layer list.

    Every field is deep-copied — position, size, transform, keyframes, a
    `layers` primitive's cards — except the `id`, which is regenerated. The
    copy lands at `index + 1`, so it draws on top of the original; everything
    above it shifts up one.

    Returns the `selection` addressing the copy — hand it straight to
    `motion_set_layer_position` / `motion_set_layer_field` to make it differ
    from what it was copied from. This is usually two calls instead of the five
    or six that rebuilding a similar layer from `motion_add_layer` would take.

    Args:
        scene_index: which scene the layer is in.
        target: {kind, index?, id?} — kind is "layer" or "scene3d-child"."#
    )]
    pub async fn motion_duplicate_layer(
        &self,
        Parameters(p): Parameters<MotionDuplicateLayerArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("scene_index", p.scene_index)
            .set("target", p.target);
        let env = self.op("motion_duplicate_layer", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_reorder_layers",
        description = r#"Move a layer within its scene's array — the drag-to-reorder gesture in
    the layer list.

    **Array order IS paint order**: a later index draws on top of an earlier
    one. This is the tool for "put the title above the background" and it is
    the only one that changes occlusion.

    Both indices must already exist, `from_index` must differ from `to_index`,
    and `to_index` is the moved layer's FINAL resting index (0..count-1), not
    an "insert before" slot. Reordering across scenes is not supported — a
    layer belongs to its scene.

    Any layer addressed by bare `index` elsewhere in your plan moves with
    this; re-read `motion_list_layers`, or address by `id`, which follows the
    layer automatically.

    Args:
        scene_index: which scene.
        from_index: the layer's current index.
        to_index: where it should end up.
        kind: "layer" (2D, default) or "scene3d-child" (3D children)."#
    )]
    pub async fn motion_reorder_layers(
        &self,
        Parameters(p): Parameters<MotionReorderLayersArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("scene_index", p.scene_index)
            .set("from_index", p.from_index)
            .set("to_index", p.to_index)
            .set("kind", p.kind);
        let env = self.op("motion_reorder_layers", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_set_field_on_layers",
        description = r#"Set the SAME field across several layers at once — the Inspector's own
    multi-select lockstep edit.

    **Not the same as calling `motion_set_layer_field` N times**: this is ONE
    undo entry, exactly as a human's multi-select edit is, instead of N the
    user would have to press Cmd+Z through one at a time.

    Args:
        selections: `[{"scene_index": N, "target": {...}}, ...]`. They may span
            different scenes. Entries that no longer resolve are dropped and
            reported as `droppedCount` rather than failing the call.
        key: the field name.
        value: the new value; null DELETES the field.
        transform: False (default) writes the layer's own top-level field, as
            `motion_set_layer_field` does. True writes the nested
            `transform.<key>` instead — the generic scale/rot/opacity group
            every primitive shares, which is what you want when the selected
            layers are of different `use` types and share no other fields."#
    )]
    pub async fn motion_set_field_on_layers(
        &self,
        Parameters(p): Parameters<MotionSetFieldOnLayersArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("selections", p.selections)
            .set("key", p.key)
            .set("value", p.value)
            .set("transform", p.transform);
        let env = self.op("motion_set_field_on_layers", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_set_layer_item",
        description = r#"Edit ONE CARD inside a `layers`-primitive layer (the stacked-cards
    primitive) — its label, or where it sits relative to its computed spot.

    `target` must be `{"kind": "layer-item", "index": L, "item_index": C}`
    where `index` is the parent layer's own index and `item_index` the card's
    position in its `items` array. Cards carry no id, so this is index-only;
    re-read `motion_list_layers` (`itemCount`) if the list may have changed.

    Pass EXACTLY ONE of:
      * `dx` + `dy` — the card's pixel offset from where the layout would
        otherwise put it (the per-card drag gesture).
      * `key` (+ `value`) — any other field on the card, e.g. "label" or
        "sublabel". A card stored as a plain string is promoted to an object
        automatically, preserving its text as `label`.
      * `reset=True` — drop both offsets in ONE undo step, back to the
        computed default position.

    Args:
        scene_index: which scene.
        target: the card (see above).
        key: the field to set, when editing a field.
        value: its new value; null deletes the field.
        dx: horizontal pixel offset (requires dy).
        dy: vertical pixel offset (requires dx).
        reset: True to clear both offsets."#
    )]
    pub async fn motion_set_layer_item(
        &self,
        Parameters(p): Parameters<MotionSetLayerItemArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("scene_index", p.scene_index)
            .set("target", p.target)
            // `reset` is presence-signalled: sent only when true, never as `false`.
            .put_if("reset", p.reset)
            .put("dx", p.dx)
            .put("dy", p.dy);
        // `value` rides with `key` and only with it — a value on its own has nothing to
        // set, and `key` with a null value is how a field is cleared, so the pair has to
        // travel together rather than each being omitted on its own emptiness.
        let args = match p.key {
            Some(key) => args.set("key", key).set("value", p.value),
            None => args,
        };
        let env = self.op("motion_set_layer_item", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_select",
        description = r#"Select exactly ONE thing and move the preview to it — the layer-list row
    click, precisely: it replaces the selection and seeks the player so what
    you selected is actually on screen.

    The seek is conditional, matching the GUI exactly: it jumps to the layer's
    own visible start only when the playhead is not ALREADY inside that
    layer's window, so "scrub to a moment, then select what is there" does not
    throw your position away. For a scene/camera target the same rule applies
    at the scene boundary. `seekedTo` reports the frame it moved to, or null
    if it deliberately stayed put.

    Use `motion_set_selection` for multi-select or to select WITHOUT seeking.

    **Not undoable** — selection is UI state, not document content, exactly as
    with `editor_set_selection`. A human's click pushes nothing onto the undo
    stack either.

    Args:
        scene_index: which scene.
        target: what to select — a layer, scene3d-child, layer-item, or one of
            `{"kind": "scene"}` / `{"kind": "camera"}` /
            `{"kind": "scene3d-camera"}`."#
    )]
    pub async fn motion_select(
        &self,
        Parameters(p): Parameters<MotionSelectArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("scene_index", p.scene_index)
            .set("target", p.target);
        let env = self.op("motion_select", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_set_selection",
        description = r#"Set the WHOLE selection — the marquee / shift-click half of the canvas
    selection model, and the write half of `motion_get_state`'s `selection`.
    Unlike `motion_select` it takes any number of targets and never seeks.

    **Why this matters even though every editing tool takes an explicit
    target** (the same reasoning as `editor_set_selection`): the Motion tab has
    real surfaces that render ONLY for a selection — the Inspector's property
    form, the on-canvas transform box and its resize handles, the
    align/distribute controls, the keyframe timeline's per-row lanes. Until
    this existed nothing but a mouse could put the app into the state those
    surfaces need, so none of them could be driven or screenshot-verified.
    Pair it with `debug_screenshot` to actually see what you selected.

    It is also how you leave the app where a human expects to find it: select
    the layer you just created so the user sees it highlighted.

    Every entry is validated against the live manifest — an unresolvable
    target is a real error and the selection is left untouched, never
    partially applied. `selections=[]` clears.

    **Not undoable**, for the same reason as `motion_select`.

    Args:
        selections: `[{"scene_index": N, "target": {...}}, ...]`; `[]` clears."#
    )]
    pub async fn motion_set_selection(
        &self,
        Parameters(p): Parameters<MotionSetSelectionArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new().set("selections", p.selections);
        let env = self.op("motion_set_selection", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_set_layer_position",
        description = r#"Move a layer to an absolute WORLD-pixel position — the canvas drag.

    World pixels are the manifest's own coordinate space (`width`/`height`
    from `motion_get_state`, typically 1920x1080), NOT screen pixels and not
    fractions — so `x=960, y=540` is the centre of a 1080p composition.

    Writes the primitive's OWN position field, so it is refused (naming the
    `use`) for a primitive that has none — a `graph` or a 3D child. Check
    `motion_list_layers`' `position`: null there means not positionable this
    way.

    **A keyframe beats this.** If the layer has `transform.keys` carrying
    `x`/`y`, the animation wins at render time and this static write will not
    be visible — animate with `motion_set_layer_transform_keys` /
    `motion_add_layer_keyframe` instead, or clear the keys first.

    Args:
        scene_index: which scene.
        target: which layer.
        x: world-pixel x.
        y: world-pixel y."#
    )]
    pub async fn motion_set_layer_position(
        &self,
        Parameters(p): Parameters<MotionSetLayerPositionArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("scene_index", p.scene_index)
            .set("target", p.target)
            .set("x", p.x)
            .set("y", p.y);
        let env = self.op("motion_set_layer_position", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_set_layer_size",
        description = r#"Resize a layer in WORLD pixels — the canvas resize handles.

    Same world-pixel space as `motion_set_layer_position`. Which field this
    actually writes depends on the primitive (a box, a width, a font size); a
    primitive with no resizable field refuses, naming its `use`. Check
    `motion_list_layers`' `size` — null means not resizable this way, and a
    null `h` there means only the width is settable (text, whose height
    follows its own size).

    Args:
        scene_index: which scene.
        target: which layer.
        w: world-pixel width.
        h: world-pixel height."#
    )]
    pub async fn motion_set_layer_size(
        &self,
        Parameters(p): Parameters<MotionSetLayerSizeArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("scene_index", p.scene_index)
            .set("target", p.target)
            .set("w", p.w)
            .set("h", p.h);
        let env = self.op("motion_set_layer_size", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_set_layer_transform_field",
        description = r#"Set one field of a layer's generic TRANSFORM wrapper — this is the tool
    for **scale, rotation and opacity**.

    It is genuinely different from `motion_set_layer_position` / `_size`:
    those write the primitive's own native geometry (a text layer's own x/y,
    an emphasis layer's own box), whereas this writes the post-transform every
    primitive shares regardless of type. `motion_list_primitives`'
    `layerTransformFields` lists the real keys.

    **A keyframe silently beats a static transform value.** The response says
    so explicitly when the layer already has `transform.keys` — that is the
    single easiest way to set something here and see nothing change. Animate
    via `motion_set_layer_transform_keys` instead in that case.

    Setting the LAST remaining transform field to null removes the whole
    `transform` object rather than leaving an empty one behind.

    Args:
        scene_index: which scene.
        target: which layer.
        key: "scale", "rot", "opacity", ... (see layerTransformFields).
        value: the new value; null DELETES the field."#
    )]
    pub async fn motion_set_layer_transform_field(
        &self,
        Parameters(p): Parameters<MotionSetLayerTransformFieldArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("scene_index", p.scene_index)
            .set("target", p.target)
            .set("key", p.key)
            .set("value", p.value);
        let env = self.op("motion_set_layer_transform_field", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_move_layers_by_delta",
        description = r#"Nudge one or more layers by a shared (dx, dy) in world pixels, relative
    to where they are NOW — the multi-select canvas drag.

    Each layer's base is read fresh off the current manifest, so this composes
    predictably; layers with no draggable position are skipped and reported as
    `droppedCount` rather than failing the call.

    **`auto_key` is the important half.** With `auto_key=False` (default) this
    writes each layer's STATIC position — which is invisible on a layer that
    is already animated, since keyframes win. With `auto_key=True` (plus `at`,
    the time in seconds within the layer's scene) it does exactly what the
    real canvas drag does: a layer that is already keyframed gets a keyframe
    UPSERTED at that moment instead, so the move becomes part of the
    animation; a layer that is not keyframed still gets its static position
    moved. A mixed selection routes per layer, and `keyedCount` reports how
    many took the keyframe path.

    Args:
        selections: `[{"scene_index": N, "target": {...}}, ...]`.
        dx: horizontal world-pixel delta.
        dy: vertical world-pixel delta.
        auto_key: True to keyframe already-animated layers (requires `at`).
        at: seconds within the scene, required when auto_key is True."#
    )]
    pub async fn motion_move_layers_by_delta(
        &self,
        Parameters(p): Parameters<MotionMoveLayersByDeltaArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("selections", p.selections)
            .set("dx", p.dx)
            .set("dy", p.dy)
            .put("at", p.at)
            // Presence-signalled: sent only when true, never as `false`.
            .put_if("auto_key", p.auto_key);
        let env = self.op("motion_move_layers_by_delta", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_align_layers",
        description = r#"Align 2+ layers to a shared edge or centre line — the align buttons.

    `edge` is one of `left`, `centerH`, `right` (horizontal) or `top`,
    `centerV`, `bottom` (vertical). Layers align to the bounding box of the
    whole selection, exactly as in any design tool.

    Needs at least 2 selections that actually resolve to a draggable position;
    unresolvable or non-positionable ones are dropped (`droppedCount`) and the
    call is refused if fewer than 2 remain.

    Args:
        selections: `[{"scene_index": N, "target": {...}}, ...]`.
        edge: left | centerH | right | top | centerV | bottom."#
    )]
    pub async fn motion_align_layers(
        &self,
        Parameters(p): Parameters<MotionAlignLayersArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("selections", p.selections)
            .set("edge", p.edge);
        let env = self.op("motion_align_layers", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_distribute_layers",
        description = r#"Space 3+ layers with equal gaps along one axis — the distribute buttons.

    The outermost two stay put and everything between them is redistributed
    evenly. Needs at least 3 resolvable, positionable selections (fewer is
    refused — with 2 there is nothing to distribute).

    Args:
        selections: `[{"scene_index": N, "target": {...}}, ...]`.
        axis: "horizontal" or "vertical"."#
    )]
    pub async fn motion_distribute_layers(
        &self,
        Parameters(p): Parameters<MotionDistributeLayersArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("selections", p.selections)
            .set("axis", p.axis);
        let env = self.op("motion_distribute_layers", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_set_layer_transform_keys",
        description = r#"Replace a layer's whole animation — `[{at, x?, y?, scale?, rot?,
    opacity?, ease?}]`. This is the main way to animate anything in Motion.

    `at` is SECONDS from the layer's own SCENE start (not absolute frames, and
    not from the layer's own `at`). Values interpolate between consecutive
    keys; a property absent from a key is simply not animated by it. One key
    alone is a static hold.

    **Keyframes override static values** for the properties they carry — a
    keyed `scale` beats anything `motion_set_layer_transform_field` wrote, and
    keyed `x`/`y` beat `motion_set_layer_position`. That precedence is the
    usual reason a static write appears to do nothing.

    `ease` per key is a cubic bezier `[x1, y1, x2, y2]` shaping the segment
    that STARTS at that key. `x1`/`x2` outside `0..1` are clamped with a
    warning; `y` outside `0..1` is legal and means overshoot (anticipation, a
    bounce) -- but not unbounded (B-166): `y1`/`y2` are silently clamped to
    `-0.75..1.75`, with a warning if that changed anything. A malformed ease
    is a hard error. Unknown fields in a key are dropped rather than stored.

    Passing `keys=[]` REMOVES the animation entirely, back to the layer's
    static values.

    Args:
        scene_index: which scene.
        target: which layer.
        keys: the complete new key list."#
    )]
    pub async fn motion_set_layer_transform_keys(
        &self,
        Parameters(p): Parameters<MotionSetLayerTransformKeysArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("scene_index", p.scene_index)
            .set("target", p.target)
            .set("keys", p.keys);
        let env = self.op("motion_set_layer_transform_keys", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_add_layer_keyframe",
        description = r#"Add (or overwrite) ONE position keyframe at a moment — the auto-keyframe
    a canvas drag performs, without replacing the rest of the animation the
    way `motion_set_layer_transform_keys` does.

    With `x`/`y` omitted it keys the layer WHERE IT ALREADY IS at `at` —
    interpolating its current animation if it has one. That is how you author
    a hold: key the current position at two times, then move only the later
    one. With `x`/`y` given they are used verbatim.

    An existing key at the same frame is overwritten IN PLACE, preserving its
    other properties (`scale`/`rot`/`opacity`) and only changing `x`/`y`.

    `ease` is applied to the same key in the SAME undo step (a bezier
    `[x1,y1,x2,y2]`; same clamping rules as
    `motion_set_layer_transform_keys`).

    Refused for a primitive with no draggable position unless you pass
    explicit `x` and `y`.

    Args:
        scene_index: which scene.
        target: which layer.
        at: SECONDS from the scene's start.
        x: optional explicit world-pixel x.
        y: optional explicit world-pixel y.
        ease: optional [x1, y1, x2, y2]."#
    )]
    pub async fn motion_add_layer_keyframe(
        &self,
        Parameters(p): Parameters<MotionAddLayerKeyframeArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("scene_index", p.scene_index)
            .set("target", p.target)
            .set("at", p.at)
            .put("x", p.x)
            .put("y", p.y)
            .put("ease", p.ease);
        let env = self.op("motion_add_layer_keyframe", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_move_layer_keyframe",
        description = r#"Retime ONE existing keyframe — drag it along the keyframe timeline —
    without touching its values.

    `key_index` indexes the layer's key array as `motion_get_manifest` /
    `motion_list_layers` report it. A key moved past a neighbour re-sorts, so
    indices after this call may differ: re-read before retiming another.

    `new_at` is clamped to the scene's own `[0, dur]` and never refused for
    being out of range — the response's `warning` says when it was clamped.

    Args:
        scene_index: which scene.
        target: which layer.
        key_index: which key in that lane's array.
        new_at: its new time, SECONDS from the scene's start.
        lane: "transform" (default — the animation keys) or "active" (a
            `layers`/`layerstack` primitive's step schedule, which the
            keyframe timeline draws as its own row)."#
    )]
    pub async fn motion_move_layer_keyframe(
        &self,
        Parameters(p): Parameters<MotionMoveLayerKeyframeArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("scene_index", p.scene_index)
            .set("target", p.target)
            .set("key_index", p.key_index)
            .set("new_at", p.new_at)
            .set("lane", p.lane);
        let env = self.op("motion_move_layer_keyframe", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_delete_layer_keyframe",
        description = r#"Remove ONE keyframe from a layer's `transform.keys`.

    Deleting the LAST remaining key removes the animation entirely (reported
    as `clearedAnimation`), at which point the layer's static position/
    transform values take over again — which is usually what you want, but is
    a visible change, not a no-op.

    Indices shift after a delete; `remainingKeyCount` is returned so you can
    re-plan without a round trip.

    Args:
        scene_index: which scene.
        target: which layer.
        key_index: which key to remove."#
    )]
    pub async fn motion_delete_layer_keyframe(
        &self,
        Parameters(p): Parameters<MotionDeleteLayerKeyframeArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("scene_index", p.scene_index)
            .set("target", p.target)
            .set("key_index", p.key_index);
        let env = self.op("motion_delete_layer_keyframe", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_move_camera_keyframe",
        description = r#"Retime ONE camera keyframe — the camera's own half of the keyframe
    timeline's drag gesture.

    Changes only WHEN the key fires, never its values; use
    `motion_set_camera_2d` / `_3d` for values (they replace the whole array).
    Clamped to the scene's `[0, dur]` with a warning, never refused for range.
    A key moved past a neighbour re-sorts, so re-read before retiming another.

    Args:
        scene_index: which scene.
        key_index: which key in that camera's array.
        new_at: its new time, SECONDS from the scene's start.
        camera: "2d" (default) or "3d"."#
    )]
    pub async fn motion_move_camera_keyframe(
        &self,
        Parameters(p): Parameters<MotionMoveCameraKeyframeArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("scene_index", p.scene_index)
            .set("key_index", p.key_index)
            .set("new_at", p.new_at)
            .set("camera", p.camera);
        let env = self.op("motion_move_camera_keyframe", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_move_keys_by_delta",
        description = r#"Shift MANY keyframes by one shared time delta — the keyframe timeline's
    box-select-then-nudge gesture. The tool for "start this whole animation
    half a second later" without recomputing every `at` yourself.

    Targets may mix lanes and scenes freely. Each is
    `{"scene_index": N, "kind": ..., "key_index": K}` where `kind` is:
      * `"layer"`  — a layer's `transform.keys` (needs `layer_index`)
      * `"active"` — a `layers` primitive's step schedule (needs `layer_index`)
      * `"camera"` / `"scene3d-camera"` — that scene's camera keys

    Each key's base time is read off the current manifest, so you only supply
    the delta. (`base_at` may be given per target to replay a real drag from a
    captured start; normally omit it.)

    Clamping is PER KEY, never a group veto: a key that hits its scene's edge
    stops there while the others move the full delta. Every target is
    validated BEFORE anything is written, so a bad one fails the whole call
    rather than half-applying it. Keys re-sort, so re-read indices afterwards.

    Args:
        targets: the keys to move (see above).
        delta_seconds: how far to shift them; negative moves earlier."#
    )]
    pub async fn motion_move_keys_by_delta(
        &self,
        Parameters(p): Parameters<MotionMoveKeysByDeltaArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("targets", p.targets)
            .set("delta_seconds", p.delta_seconds);
        let env = self.op("motion_move_keys_by_delta", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_set_keyframe_ease",
        description = r#"Set (or clear) ONE keyframe's easing curve — the bezier curve editor,
    reachable in a single call instead of resending a whole key array.

    **This is the difference between motion that reads as authored and motion
    that reads as generated.** Every segment is LINEAR by default: a constant
    rate with a dead stop at the next key. An ease shapes the RATE only — both
    endpoints still hit their authored values at their authored times, so
    easing can never move a keyframe.

    `ease` is `[x1, y1, x2, y2]`, a cubic bezier's two control points.
    Familiar shapes: `[0.4, 0, 0.2, 1]` ease-in-out, `[0, 0, 0.2, 1]` ease-out
    (fast start, gentle landing), `[0.4, 0, 1, 1]` ease-in. `x1`/`x2` outside
    `0..1` are CLAMPED with a warning (the runtime throws on them); `y`
    outside `0..1` is legal and is real overshoot — `[0.3, 0, 0.3, 1.4]`
    overshoots and settles back — but not unbounded (B-166): `y1`/`y2` are
    silently clamped to `-0.75..1.75`, with a warning if that changed
    anything.

    Pass `ease=null` to CLEAR it back to linear. Omitting `ease` entirely is
    an error, since there would be nothing to do.

    Args:
        scene_index: which scene.
        key_index: which key in that lane's array.
        ease: [x1, y1, x2, y2], or null to clear.
        lane: "layer" (default, needs `target`), "camera", or
            "scene3d-camera". An "active" step schedule has no ease — it does
            not interpolate — and is refused by name.
        target: which layer, required when lane is "layer"."#
    )]
    pub async fn motion_set_keyframe_ease(
        &self,
        Parameters(p): Parameters<MotionSetKeyframeEaseArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("scene_index", p.scene_index)
            .set("key_index", p.key_index)
            .set("lane", p.lane)
            .set("ease", p.ease)
            .put("target", p.target);
        let env = self.op("motion_set_keyframe_ease", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_set_layer_active_schedule",
        description = r#"Set which child of a `layers`/`layerstack` primitive is highlighted, and
    from when — its `active` STEP schedule.

    `schedule` is `[{"at": seconds, "i": childIndex}, ...]`. It is a STEP, not
    an interpolation: `{"at": 2, "i": 1}` means "from 2s onward show child 1",
    holding until the next entry. Hence there is no `ease` anywhere on it.

    This is how a stacked-cards explainer walks down its list over time.
    `motion_move_layer_keyframe(lane="active")` retimes one step;
    `motion_move_keys_by_delta` with `kind="active"` shifts several.

    Passing `schedule=[]` removes the field entirely, back to whatever static
    `active` value the layer had.

    Args:
        scene_index: which scene.
        target: the `layers`/`layerstack` layer.
        schedule: the complete new step list."#
    )]
    pub async fn motion_set_layer_active_schedule(
        &self,
        Parameters(p): Parameters<MotionSetLayerActiveScheduleArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("scene_index", p.scene_index)
            .set("target", p.target)
            .set("schedule", p.schedule);
        let env = self.op("motion_set_layer_active_schedule", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_seek",
        description = r#"Move the Motion preview's playhead — the equivalent of clicking the
    timeline ruler. Do this before `debug_screenshot` to photograph a specific
    moment of the animation.

    Two ways to say where, whichever is easier:
      * `frame` — an absolute frame in the whole combined timeline.
      * `scene_index` + `at` — SECONDS within that scene, which is the same
        space every keyframe `at` is in, so you can seek straight to a key you
        just wrote without converting anything.

    `frame` wins if both are given. Out-of-range values are CLAMPED to the
    real timeline with a warning rather than refused.

    Args:
        frame: absolute frame.
        scene_index: which scene, when seeking scene-relative.
        at: seconds within that scene (default 0)."#
    )]
    pub async fn motion_seek(
        &self,
        Parameters(p): Parameters<MotionSeekArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .put("frame", p.frame)
            .put("scene_index", p.scene_index)
            .put("at", p.at);
        let env = self.op("motion_seek", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_save_manifest",
        description = r#"Write the manifest to its sidecar file inside the project now — the Save
    button.

    Edits made by every other `motion_*` tool live in the app's in-memory
    document (and are fully undoable there) until this is called.
    `motion_render` saves first automatically if the document is dirty, so an
    explicit save is only needed when you want the file on disk WITHOUT
    rendering.

    Returns the real sidecar `path` on success, or the real failure message —
    never a silent success.

    Does not create a project: a Motion manifest lives inside one, so a
    project must already be open."#
    )]
    pub async fn motion_save_manifest(&self) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new();
        let env = self.op("motion_save_manifest", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_get_edit_links",
        description = r#"What each Motion scene feeds in the Edit tab: its rendered file, and
    every clip on the open Edit timeline reading it (D-260).

    This is the read half of "re-render, auto-replace" — call it to see what a
    `motion_render` will refresh before you run one, or to confirm what it
    refreshed after. The Motion tab shows a human the identical fact as an
    "N in Edit" badge on the scene row, off the identical value.

    Per scene: `index`, `sceneId`, `rendered` (has this scene ever been
    rendered into this project's Sources?), `mediaId` / `sourcePath` (its pool
    item and file, null when not), `clipCount`, and `clips` — each with the
    `track`/`clip` indices `editor_*` tools address by, plus the clip's id and
    name.

    `rendered: false` and a top-level `available: false` are different
    answers. The first means that scene has no render in the pool yet. The
    second means no link data reached the tab at all (no project open) — do
    not read the per-scene rows as "nothing is linked" in that case.

    A scene that is `rendered: true` with `clipCount: 0` has been rendered and
    is sitting in Sources, but has never been placed — re-rendering it changes
    nothing on the timeline. Use `editor_add_clip` with its `mediaId` to place
    it.

    **`rendered` and `clipCount` are answered against the file a re-render
    will actually WRITE (B-219).** A project copied on the filesystem (Finder,
    `cp -R`) keeps the ORIGINAL project's absolute media paths, so its Motion
    pool items point at files no render of this project can reach. Such a
    scene reads `rendered: false`, `clipCount: 0`, `refreshedByRender: false`,
    with the whole inherited link reported separately as `staleLink`
    (`mediaId` / `sourcePath` / `clipCount` / `clips` / `reason`), and the
    response carries a top-level `warning`. Those clips are really on the
    timeline and really play — they just will not be refreshed by a render.
    Fix: `motion_render` the scene to produce this project's own file, then
    `editor_swap_clip_media` those clips onto it.

    `refreshedByRender` is three-valued: `true` (the render lands on this
    file), `false` (the copied-project case above), `null` (no project root
    reached the tab — the question was not asked, which is not a "no")."#
    )]
    pub async fn motion_get_edit_links(&self) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new();
        let env = self.op("motion_get_edit_links", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_list_layer_presets",
        description = r#"List the user's saved COMPONENTS — layers they tuned once and kept for
    reuse. The Catalog tab's "Components" section, as data.

    A component is a named, frozen copy of one layer fragment: every field it
    had when it was saved, INCLUDING its `transform` and its keyframes. It is
    not a new kind of object — inserting one produces an ordinary layer, and
    nothing links the two afterwards.

    These are USER-level and shared across projects, unlike the manifest. This
    tool needs no project open, so it is a safe thing to call while deciding
    what to build.

    Each entry carries `id` (pass it to `motion_add_layer_from_preset`),
    `name`, `use`, `createdAt`, and the full `layer` fragment so you can see
    what you would be inserting before you insert it. Newest first.

    Distinct from `motion_list_primitives`, which lists the ten BUILT-IN
    primitives and their fields. That one is what the engine can draw; this one
    is what this user has already made."#
    )]
    pub async fn motion_list_layer_presets(&self) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new();
        let env = self.op("motion_list_layer_presets", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_save_layer_preset",
        description = r#"Save one existing layer to the component library under `name` — the
    Inspector's "Save as component" box.

    The whole fragment is captured as it stands, keyframes and all, minus the
    layer's `id`. Use this when a layer has been tuned into something worth
    having again: a `matrix` set up as a real attention heatmap, a `graph`
    wired to a specific architecture, a `text` with the exact size and entrance
    you want. Rebuilding one of those from `motion_add_layer` is five or ten
    `motion_set_layer_field` calls; inserting the saved one is a single call.

    The library is user-level and shared across projects, so a component saved
    while working on one project is available in every other one.

    Editing the layer afterwards does NOT change the component, and editing the
    component does not change layers already inserted from it. It is a copy,
    deliberately — see `motion_add_layer_from_preset`.

    Args:
        scene_index: which scene the layer is in.
        target: {kind, index?, id?} — kind is "layer" or "scene3d-child".
        name: what to call it in the library. Leading/trailing whitespace is
            trimmed and interior runs collapsed; an empty name is refused."#
    )]
    pub async fn motion_save_layer_preset(
        &self,
        Parameters(p): Parameters<MotionSaveLayerPresetArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("scene_index", p.scene_index)
            .set("target", p.target)
            .set("name", p.name);
        let env = self.op("motion_save_layer_preset", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_add_layer_from_preset",
        description = r#"Insert a saved component into a scene — the "+ Add to scene" button on a
    row of the Catalog tab's Components section.

    Get `preset_id` from `motion_list_layer_presets`. The new layer reproduces
    the component exactly, keyframes included, with a fresh `id`.

    Placement is decided by the PRIMITIVE, not by you: a `particleflow`,
    `labelbox` or `layerstack` component goes into `scene3d.children` (creating
    that container, with a default camera, if the scene has none); every other
    kind is appended to `scene.layers`. This is the same rule
    `motion_add_layer` follows.

    The insert is a COPY. Nothing links the new layer back to the component:
    changing the component later does not restyle this layer, and deleting the
    component does not remove it. Edit the result with
    `motion_set_layer_field` / `motion_set_layer_position` like any other
    layer.

    Returns the `selection` addressing the new layer.

    Args:
        scene_index: which scene to add it to.
        preset_id: the component's `id` from `motion_list_layer_presets`."#
    )]
    pub async fn motion_add_layer_from_preset(
        &self,
        Parameters(p): Parameters<MotionAddLayerFromPresetArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("scene_index", p.scene_index)
            .set("preset_id", p.preset_id);
        let env = self.op("motion_add_layer_from_preset", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_delete_layer_preset",
        description = r#"Remove one saved component from the library — the trash button on its
    Catalog row.

    This is safe in a way that deleting a component in a design tool is not:
    layers already inserted from it are ordinary layers and are left completely
    alone, in this project and every other one. Only the library entry goes.

    Needs no project open, for the same reason `motion_list_layer_presets`
    does not: the library is user-level state, not part of any manifest.

    Args:
        preset_id: the component's `id` from `motion_list_layer_presets`."#
    )]
    pub async fn motion_delete_layer_preset(
        &self,
        Parameters(p): Parameters<MotionDeleteLayerPresetArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new().set("preset_id", p.preset_id);
        let env = self.op("motion_delete_layer_preset", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_render",
        description = r#"Render the Motion manifest to REAL video files, via Remotion — the one
    Motion tool that produces something outside the app. Saves first if dirty.

    **One video file PER SCENE**, never one combined video: a manifest with
    three scenes produces three MP4s, and the response's `results` array
    carries each one's `sceneId` and `outputPath`. That is deliberate — a
    scene is the unit of "one shot" here, and separate files are what an edit
    can actually cut between.

    **How a rendered scene reaches the Edit tab — NOT what you might assume.**
    Every rendered file is imported into the Edit tab's Sources media pool
    AUTOMATICALLY, at the pool root, as each scene finishes. You do NOT need
    to call `editor_import_media` on these paths; it has already happened.
    What is NOT automatic is PLACEMENT: nothing is put on the Edit timeline,
    deliberately, because the app cannot know which track or position you
    want. So the real chain is:

        motion_render  ->  (files auto-appear in Sources)
                       ->  editor_add_clip / editor_edit_in to place one

    **Re-rendering a scene REFRESHES the Edit clips already placed from it
    (D-260).** This replaced the old "there is no live link" rule. A scene
    always renders to the same per-scene file, so a re-render replaces that
    file atomically and every Edit clip reading it picks the new content up by
    itself — in the preview and in the export — with its length and frame rate
    re-read from the new render. You do NOT re-import, and you do NOT call
    `editor_swap_clip_media`. Call `motion_get_edit_links` to see what a
    re-render will refresh (or did). The one case where it does NOT hold is a
    project copied on the filesystem, whose pool still names the ORIGINAL
    project's files — `motion_get_edit_links` reports that as `staleLink` and
    says what to do about it (B-219).

    It is still not a live embed, and the difference matters: nothing
    re-renders on its own. Editing the manifest changes nothing downstream
    until you call this tool again — the render is the explicit trigger, by
    design, because a render is expensive and a surprise one mid-edit is
    worse than an out-of-date clip you chose not to refresh yet.

    **Targeted and resumable renders (D-398).** `scene_ids` renders ONLY those
    scenes: each keeps its place in the whole manifest, so its frames are exactly
    what a full render writes for it, and an unknown id is an error naming it.
    Use it after changing one scene instead of re-rendering everything.
    `resume=true` continues the render that was INTERRUPTED (the app restarted or
    its worker died) or stopped on a failed scene, rendering only the scenes not
    yet written, from the manifest that render STARTED with; it takes no
    `scene_ids`. The render runs in the app's backend, not the page: a window
    reload does not stop it, and it renders from a snapshot of the manifest taken
    at the start, so editing or rewriting the manifest while it runs cannot
    misalign later scenes.

    **A slow render can look like a failure and is not.** The control bridge
    gives up after 20 seconds while the render keeps running to completion on
    disk. If this returns a timeout error, treat it as INCONCLUSIVE rather
    than failed, and poll `motion_get_state`'s `render` block instead of
    re-rendering (which would just start a second render). That block is the
    definitive answer: `running` with a scene counter means wait, `idle` with
    `scenesDone == scenesTotal` means it finished, `error` names the scene
    that failed and why (B-202), and `interrupted` means the render was cut off
    with scenes left (`remainingSceneIds`): call this tool again with
    `resume=true`. Counting files in Sources cannot tell those apart."#
    )]
    pub async fn motion_render(
        &self,
        Parameters(p): Parameters<MotionRenderArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .put("scene_ids", p.scene_ids)
            .put_if("resume", p.resume);
        let env = self.op("motion_render", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "motion_reload_manifest",
        description = r#"Re-read the Motion manifest from its sidecar file on disk, replacing the
    app's in-memory document (B-262).

    Use this after changing `<project>.chroma/motion/manifest.json` OUTSIDE the
    app (hand-authored, or written by a script): nothing else makes the app
    notice, and without it `motion_get_manifest` and `motion_render` keep
    working from the old in-app copy.

    The file replaces the in-app document entirely. If the in-app document has
    UNSAVED edits this refuses (they would be lost) unless `force=true`. Earlier
    undo history refers to the previous document; do not undo across a reload.

    Returns `reloaded`, the number of `scenes` in the document now loaded
    (`null` if the file does not validate -- `motion_get_state`'s `parseError`
    says why) and `hadSavedManifest` (false when the project has none yet and the
    engine's sample is showing)."#
    )]
    pub async fn motion_reload_manifest(
        &self,
        Parameters(p): Parameters<MotionReloadManifestArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new().put_if("force", p.force);
        let env = self.op("motion_reload_manifest", args).await?;
        Ok(render::json_text(&env))
    }
}

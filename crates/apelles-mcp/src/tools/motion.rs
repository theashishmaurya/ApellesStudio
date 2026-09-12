//! Motion-tab tools — the scene-based motion-graphics surface (D-312).
//!
//! Answered by `@apelles/motion`'s `useMotionControl.ts`. Times in this tab are SECONDS
//! within a scene, not absolute frames — the single most common way to get a Motion call
//! wrong, which is why every relevant description repeats it.

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
    MotionSelection, MotionTarget,
};
use crate::server::ApellesMcp;

// Argument defaults — the Python signature's own, so an omitted argument reaches the
// frontend with the value it always did. A `value` that defaults to null is how these
// tools express "clear this field", so null is a real default here, not a missing one.
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
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MotionDeleteLayerArgs {
    pub scene_index: i64,
    pub target: MotionTarget,
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
      * `selection` — what is selected right now, as `[{sceneIndex, target}]`,
        the exact shape `motion_set_selection` takes back.
      * `playheadFrame` / `playerMounted` — where the preview is parked.
      * `fps`, `totalFrames`, `width`, `height`.
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

    Also returns `sceneFields` (for `motion_set_scene_field`),
    `layerTransformFields` (for `motion_set_layer_transform_field`),
    `layerTransformKeyFields`, and the 2D/3D camera key fields.

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
        name = "motion_add_scene",
        description = r#"Add a new empty 4-second scene — the same action the layer panel's own
    "+ Scene" button performs.

    Scenes play back to back in array order, and each renders to its OWN
    separate video file (see `motion_render`), so a scene is the unit of "one
    shot" here, not a track. The new scene is inserted directly AFTER
    `after_scene_index` (matching the GUI, which inserts after whatever is
    selected) or appended at the end when omitted. Every later scene's index
    shifts by one — re-read `motion_get_state` afterwards.

    Returns the new scene's `sceneIndex` and a `selection` addressing it. Set
    its length with `motion_set_scene_field(key="dur", value=<seconds>)`.

    Args:
        after_scene_index: insert after this scene. Omit to append."#
    )]
    pub async fn motion_add_scene(
        &self,
        Parameters(p): Parameters<MotionAddSceneArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new().put("after_scene_index", p.after_scene_index);
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

    Args:
        scene_index: which scene.
        key: the field, e.g. "dur" or "id".
        value: the new value. Pass null to DELETE the field."#
    )]
    pub async fn motion_set_scene_field(
        &self,
        Parameters(p): Parameters<MotionSetSceneFieldArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("scene_index", p.scene_index)
            .set("key", p.key)
            .set("value", p.value);
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

    Args:
        scene_index: which scene to add to.
        use: the primitive, e.g. "text". An unknown value is refused with the
            full legal list."#
    )]
    pub async fn motion_add_layer(
        &self,
        Parameters(p): Parameters<MotionAddLayerArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("scene_index", p.scene_index)
            .set("use", p.primitive);
        let env = self.op("motion_add_layer", args).await?;
        Ok(render::json_text(&env))
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
    it."#
    )]
    pub async fn motion_get_edit_links(&self) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new();
        let env = self.op("motion_get_edit_links", args).await?;
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
    re-render will refresh (or did).

    It is still not a live embed, and the difference matters: nothing
    re-renders on its own. Editing the manifest changes nothing downstream
    until you call this tool again — the render is the explicit trigger, by
    design, because a render is expensive and a surprise one mid-edit is
    worse than an out-of-date clip you chose not to refresh yet.

    **A slow render can look like a failure and is not.** The control bridge
    gives up after 20 seconds while the render keeps running to completion on
    disk. If this returns a timeout error, treat it as INCONCLUSIVE rather
    than failed: wait, then check the Sources pool for the new files instead
    of re-rendering (which would just start a second render)."#
    )]
    pub async fn motion_render(&self) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new();
        let env = self.op("motion_render", args).await?;
        Ok(render::json_text(&env))
    }
}

/// This tab's contribution to the merged router.
pub fn router() -> rmcp::handler::server::router::tool::ToolRouter<ApellesMcp> {
    ApellesMcp::motion_router()
}

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
use crate::schemas::MotionTarget;
use crate::server::ApellesMcp;

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
}

/// This tab's contribution to the merged router.
pub fn router() -> rmcp::handler::server::router::tool::ToolRouter<ApellesMcp> {
    ApellesMcp::motion_router()
}

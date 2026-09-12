//! Colorist tools — grading, masks, relight, scopes, export (D-312).
//!
//! These are the ops `useChromaControl.ts` answers: the catch-all frontend registry that
//! serves every op without an `editor_` / `motion_` / `debug_` prefix.
//!
//! Every description here is the Python tool's docstring, byte-for-byte. That is not
//! ceremony — several of them encode behaviour found the hard way, live (which frame
//! numbers are clip-local, which argument is silently ignored for which mask type), and
//! `tests/parity.rs` compares them character by character for that reason.

use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::CallToolResult;
use rmcp::{ErrorData, tool, tool_router};
use schemars::JsonSchema;
use serde::Deserialize;

use crate::args::WireArgs;
use crate::render;
use crate::schemas::{ColorWheelChannel, MaskGeometry};
use crate::server::ApellesMcp;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct InspectColorArgs {
    #[serde(default)]
    pub frame: Option<i64>,
    #[serde(default)]
    pub reference: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SetColorGradeArgs {
    #[serde(default)]
    pub shadows: Option<ColorWheelChannel>,
    #[serde(default)]
    pub midtones: Option<ColorWheelChannel>,
    #[serde(default)]
    pub highlights: Option<ColorWheelChannel>,
    /// Named with the trailing underscore Python needed to avoid the `global` keyword.
    /// It goes onto the wire as plain `global`, and the published parameter name has to
    /// keep the underscore because that is what every existing caller sends.
    #[serde(rename = "global_", default)]
    pub global_: Option<ColorWheelChannel>,
    #[serde(default)]
    pub blending: Option<f64>,
    #[serde(default)]
    pub balance: Option<f64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct AddComponentArgs {
    pub mask_id: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default = "subtractive")]
    pub mode: String,
    #[serde(default)]
    pub bbox: Option<Vec<f64>>,
    #[serde(default)]
    pub geometry: Option<MaskGeometry>,
}

fn subtractive() -> String {
    "subtractive".to_string()
}

#[tool_router(router = colorist_router, vis = "pub")]
impl ApellesMcp {
    #[tool(
        name = "get_state",
        description = r#"Full current state: the loaded image/video, primary adjustments, and a
    summary of every mask (ids, types, per-mask adjustments). Reflects the
    user's manual edits in the app. Call this before editing."#
    )]
    pub async fn get_state(&self) -> Result<CallToolResult, ErrorData> {
        let env = self.op("get_state", WireArgs::new()).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "inspect_color",
        description = r#"Measure the current frame. Returns the RGB parade and vectorscope as
    images, plus a numeric summary: black/white points (1st/99th-pct luma),
    luma + per-channel clip %, mean RGB, per-zone (shadow/mid/highlight) means,
    the measured colour cast (warmCool = mid R-B, greenMagenta = mid G-(R+B)/2),
    mean saturation, and a 12-bin saturation-weighted hue histogram (an orange
    cluster ~ skin, cyan/blue ~ sky). The histogram is passed through from the app.

    Pass `reference` (an absolute image path) to also get that image's scopes and
    a `gap` object of HINTS that map onto knobs (not commands): an EV-ish
    exposure delta, temperature/tint direction + magnitude, contrast spread, and
    a saturation ratio, with a one-line reading.

    Grade by the numbers. Call this before and after a change and reason from the
    scope values. Never claim a result ('looks balanced', 'skin is natural', 'the
    cast is gone') without citing a scope value or a sampled region. Read the
    result adversarially — assume a cast, clip or crushed channel is still there
    and look for the one you have not ruled out. Defer genuinely creative calls
    to the human.
    "#
    )]
    pub async fn inspect_color(
        &self,
        Parameters(p): Parameters<InspectColorArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .put("frame", p.frame)
            .put("reference", p.reference);
        let env = self.op("inspect_color", args).await?;
        Ok(render::inspect_result(&env))
    }

    #[tool(
        name = "set_color_grade",
        description = r#"Color-grading wheels. shadows/midtones/highlights/global_ are each
    {hue, saturation, luminance} (hue 0..360, sat/lum ~ -100..100); pass only
    the wheel(s) you want to move. blending and balance are 0..100 / -100..100.
    Grade by the numbers: check the per-zone means and the cast on `inspect_color`
    before and after; don't judge the wheels from the thumbnail."#
    )]
    pub async fn set_color_grade(
        &self,
        Parameters(p): Parameters<SetColorGradeArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        // One `patch` object, merged one level deep by the handler — which is what makes
        // "move only the midtones" a real call rather than a full-wheel replacement.
        let patch = WireArgs::new()
            .put("shadows", p.shadows)
            .put("midtones", p.midtones)
            .put("highlights", p.highlights)
            // `global_` on the way in, `global` on the wire.
            .put("global", p.global_)
            .put("blending", p.blending)
            .put("balance", p.balance);
        let env = self
            .op(
                "set_color_grade",
                WireArgs::new().set("patch", patch.into_value()),
            )
            .await?;
        Ok(render::result(&env))
    }

    #[tool(
        name = "add_component",
        description = r#"Add a sub-mask (a "component") to an EXISTING mask container — the agent's
    equivalent of the app's "Add to / Subtract from / Intersect with Mask" menu.

    Use it to refine a mask by composition: a `subtractive` Subject component
    carves a SAM-segmented region out of the container's matte (edge-aware);
    a `subtractive` Radial or Linear carves a geometric region. An `additive`
    component grows the mask.

    type: "subject" | "radial" | "linear" | "brush".
    mode: "subtractive" (default — the usual reason to add a component),
          "additive", or "intersect".
    bbox: [x0,y0,x1,y1] source px — for type "subject" (the SAM prompt box).
    geometry: for "radial" {cx,cy,rx,ry,rotation?,feather?};
              for "linear" {startX,startY,endX,endY,range?}.  (source px)

    Returns {maskId, subMaskId, type, mode} and the rendered frame. To change a
    component's mode later use `set_submask_mode`."#
    )]
    pub async fn add_component(
        &self,
        Parameters(p): Parameters<AddComponentArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("mask_id", p.mask_id)
            .set("type", p.kind)
            .set("mode", p.mode)
            .put("bbox", p.bbox)
            .put("geometry", p.geometry);
        // A Subject component runs SAM 2 + ViTMatte, which routinely outlives the
        // control server's own 20s default — the exact shape of B-153.
        let env = self
            .op_with("add_component", crate::AI_MASK_TIMEOUT_MS, args)
            .await?;
        Ok(render::result(&env))
    }
}

/// This tab's contribution to the merged router.
pub fn router() -> rmcp::handler::server::router::tool::ToolRouter<ApellesMcp> {
    ApellesMcp::colorist_router()
}

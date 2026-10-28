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
use serde_json::{Value, json};

use crate::args::WireArgs;
use crate::render;
use crate::schemas::{ColorWheelChannel, CurvePoint, MaskGeometry, Roi};
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

/// How long between `export_progress` polls while a video export runs.
const EXPORT_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);

/// `{ok, error, ...result}` — the envelope with its `result` object lifted up a level.
///
/// Two tools answer this way (`save_grade`, and `export`'s LUT bake) because what the
/// caller wants is the resolved path, and burying it one level down under `result` makes
/// the answer read like a status report rather than the filename it actually is.
fn flatten_result(env: &Value) -> Value {
    let mut out = serde_json::Map::new();
    out.insert("ok".into(), env.get("ok").cloned().unwrap_or(Value::Null));
    out.insert(
        "error".into(),
        env.get("error").cloned().unwrap_or(Value::Null),
    );
    if let Some(Value::Object(result)) = env.get("result") {
        for (k, v) in result {
            out.insert(k.clone(), v.clone());
        }
    }
    Value::Object(out)
}

// Argument defaults. These are the Python signature's own defaults, reproduced so an
// omitted argument reaches the frontend with the same value it always did — the one kind
// of default that legitimately lives on this side: the caller's, not the app's.
fn subtractive() -> String {
    "subtractive".to_string()
}

fn default_add_subject_mask_mode() -> String {
    "additive".to_string()
}

fn default_track_subject_mode() -> String {
    "fast".to_string()
}

fn default_depth_track_step() -> i64 {
    1
}

/// Video Depth Anything's own inference resolution.
fn default_depth_track_input_size() -> i64 {
    518
}

fn default_apply_haze_amount() -> f64 {
    1.0
}

fn default_apply_haze_protect_subject() -> bool {
    true
}

fn default_apply_haze_tracked() -> bool {
    false
}

fn default_add_relight_light_kind() -> String {
    "key".to_string()
}

fn default_match_to_reference_strength() -> f64 {
    1.0
}

fn default_match_to_reference_max_iters() -> i64 {
    4
}

fn default_match_to_reference_tolerance() -> f64 {
    3.0
}

fn default_export_kind() -> String {
    "prores".to_string()
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct OpenArgs {
    pub path: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct LoadGradeArgs {
    pub path: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SetCurveArgs {
    pub channel: String,
    pub points: Vec<CurvePoint>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SeekArgs {
    pub frame: i64,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct AddShotsArgs {
    pub paths: Vec<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct OpenProjectArgs {
    pub name_or_path: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct NewProjectArgs {
    pub name: String,
    #[serde(default)]
    pub media_paths: Option<Vec<String>>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SetSubmaskModeArgs {
    pub sub_mask_id: String,
    pub mode: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct AddMaskKeyframeArgs {
    pub mask_id: String,
    pub sub_mask_id: String,
    #[serde(default)]
    pub frame: Option<i64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ListMaskKeyframesArgs {
    pub mask_id: String,
    pub sub_mask_id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ClearMaskKeyframeArgs {
    pub mask_id: String,
    pub sub_mask_id: String,
    pub frame: i64,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ClearMaskKeyframesArgs {
    pub mask_id: String,
    pub sub_mask_id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct TrackSubjectArgs {
    pub sub_mask_id: String,
    #[serde(default = "default_track_subject_mode")]
    pub mode: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DepthTrackArgs {
    #[serde(default)]
    pub from_frame: Option<i64>,
    #[serde(default)]
    pub to_frame: Option<i64>,
    #[serde(default = "default_depth_track_step")]
    pub step: i64,
    #[serde(default = "default_depth_track_input_size")]
    pub input_size: i64,
    #[serde(default)]
    pub sub_mask_id: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct InvertMaskArgs {
    pub sub_mask_id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DeleteMaskArgs {
    pub mask_id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DeleteRelightLightArgs {
    pub id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SampleArgs {
    pub x: i64,
    pub y: i64,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SampleRegionArgs {
    pub x: i64,
    pub y: i64,
    pub w: i64,
    pub h: i64,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct AddSubjectMaskArgs {
    #[serde(default)]
    pub bbox: Option<Vec<f64>>,
    #[serde(default = "default_add_subject_mask_mode")]
    pub mode: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SetPrimaryArgs {
    #[serde(default)]
    pub exposure: Option<f64>,
    #[serde(default)]
    pub contrast: Option<f64>,
    #[serde(default)]
    pub highlights: Option<f64>,
    #[serde(default)]
    pub shadows: Option<f64>,
    #[serde(default)]
    pub whites: Option<f64>,
    #[serde(default)]
    pub blacks: Option<f64>,
    #[serde(default)]
    pub temperature: Option<f64>,
    #[serde(default)]
    pub tint: Option<f64>,
    #[serde(default)]
    pub saturation: Option<f64>,
    #[serde(default)]
    pub vibrance: Option<f64>,
    #[serde(default)]
    pub dehaze: Option<f64>,
    #[serde(default)]
    pub clarity: Option<f64>,
    #[serde(default)]
    pub structure: Option<f64>,
    #[serde(default)]
    pub sharpness: Option<f64>,
    /// camelCase in the published parameter list too, not a Rust-side rename: this is
    /// the name every existing caller sends, and the wire key is the same.
    #[serde(rename = "vignetteAmount", default)]
    pub vignette_amount: Option<f64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SaveGradeArgs {
    #[serde(default)]
    pub path: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SetActiveShotArgs {
    #[serde(default)]
    pub index: Option<i64>,
    #[serde(default)]
    pub path: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SetProjectSettingsArgs {
    #[serde(default)]
    pub width: Option<i64>,
    #[serde(default)]
    pub height: Option<i64>,
    #[serde(default)]
    pub fps: Option<f64>,
    #[serde(default)]
    pub color_space: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SetMaskAdjustArgs {
    pub mask_id: String,
    #[serde(default)]
    pub exposure: Option<f64>,
    #[serde(default)]
    pub contrast: Option<f64>,
    #[serde(default)]
    pub highlights: Option<f64>,
    #[serde(default)]
    pub shadows: Option<f64>,
    #[serde(default)]
    pub whites: Option<f64>,
    #[serde(default)]
    pub blacks: Option<f64>,
    #[serde(default)]
    pub temperature: Option<f64>,
    #[serde(default)]
    pub tint: Option<f64>,
    #[serde(default)]
    pub saturation: Option<f64>,
    #[serde(default)]
    pub vibrance: Option<f64>,
    #[serde(default)]
    pub dehaze: Option<f64>,
    #[serde(default)]
    pub clarity: Option<f64>,
    #[serde(default)]
    pub structure: Option<f64>,
    #[serde(default)]
    pub sharpness: Option<f64>,
    #[serde(default)]
    pub blur: Option<f64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ApplyHazeArgs {
    #[serde(default = "default_apply_haze_amount")]
    pub amount: f64,
    #[serde(default = "default_apply_haze_protect_subject")]
    pub protect_subject: bool,
    #[serde(default = "default_apply_haze_tracked")]
    pub tracked: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct AddRelightLightArgs {
    #[serde(default = "default_add_relight_light_kind")]
    pub kind: String,
    #[serde(default)]
    pub x: Option<f64>,
    #[serde(default)]
    pub y: Option<f64>,
    #[serde(default)]
    pub radius: Option<f64>,
    #[serde(default)]
    pub intensity: Option<f64>,
    #[serde(default)]
    pub color: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SetRelightLightArgs {
    pub id: String,
    #[serde(default)]
    pub x: Option<f64>,
    #[serde(default)]
    pub y: Option<f64>,
    #[serde(default)]
    pub radius: Option<f64>,
    #[serde(default)]
    pub intensity: Option<f64>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub visible: Option<bool>,
    #[serde(default)]
    pub kind: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MatchToReferenceArgs {
    pub reference: String,
    #[serde(default = "default_match_to_reference_strength")]
    pub strength: f64,
    #[serde(default = "default_match_to_reference_max_iters")]
    pub max_iters: i64,
    #[serde(default = "default_match_to_reference_tolerance")]
    pub tolerance: f64,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct RequestHumanArgs {
    pub reason: String,
    #[serde(default)]
    pub roi: Option<Roi>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ExportArgs {
    #[serde(default = "default_export_kind")]
    pub kind: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub from_frame: Option<i64>,
    #[serde(default)]
    pub to_frame: Option<i64>,
    #[serde(default)]
    pub quality: Option<i64>,
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

    #[tool(
        name = "open",
        description = r#"Load a still or video into the editor by ABSOLUTE path — the headless
    equivalent of picking it in the library. Returns {path, ready, size, video}.
    Follow with get_state / inspect_color."#
    )]
    pub async fn open(
        &self,
        Parameters(p): Parameters<OpenArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new().set("path", p.path);
        let env = self.op("open", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "get_grade",
        description = r#"The full grade.json document — the git-committable grade ("the grade is
    code", D-025). A versioned wrapper: {schema: "chroma.grade/1", shot: {source,
    width, height, fps, frameCount, colorSpace, reference}, adjustments: {...the
    live RapidRAW grade + masks...}, notes}. Reflects the user's manual edits.
    Use `save_grade` to write it to disk, `load_grade` to apply one."#
    )]
    pub async fn get_grade(&self) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new();
        let env = self.op("get_grade", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "load_grade",
        description = r#"Apply a grade.json (ABSOLUTE path) — externalised mattes are inlined and a
    tracked-matte folder is resolved. Runs a schema migration; a grade.json from
    a newer major version is rejected with a clear error.

    v1 does NOT auto-switch clips: if the doc's `shot.source` differs from the
    open clip you get a `sourceMismatch` warning in the result — open the right
    clip first (`open`) for the grade to land on the intended footage.

    Returns the rendered frame + scopes + {applied, shot, sourceMismatch}."#
    )]
    pub async fn load_grade(
        &self,
        Parameters(p): Parameters<LoadGradeArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new().set("path", p.path);
        let env = self.op("load_grade", args).await?;
        Ok(render::result(&env))
    }

    #[tool(
        name = "list_masks",
        description = r#"Every mask container and its sub-masks: ids, type, mode, visible/invert,
    per-mask adjustments, and whether a sub-mask is tracked across the clip."#
    )]
    pub async fn list_masks(&self) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new();
        let env = self.op("list_masks", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "set_curve",
        description = r#"Replace a tone-curve channel. channel is one of luma|red|green|blue.
    points is an ordered list of {x, y} in 0..255 (both axes), e.g.
    [{"x":0,"y":0},{"x":128,"y":140},{"x":255,"y":255}].
    Grade by the numbers: verify the move on `inspect_color` (parade / black-white
    points / per-zone means), not the thumbnail."#
    )]
    pub async fn set_curve(
        &self,
        Parameters(p): Parameters<SetCurveArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("channel", p.channel)
            .set("points", p.points);
        let env = self.op("set_curve", args).await?;
        Ok(render::result(&env))
    }

    #[tool(
        name = "seek",
        description = r#"Move the video playhead to `frame` and re-render it with the current
    grade. No-op if the loaded item is a still.

    **`frame` is CLIP-LOCAL (D-294).** 0 is the active clip's own in-point on
    the Edit timeline, not frame 0 of the source file, and the last valid frame
    is `get_state().shot.frameCount - 1` — the CLIP's length, not the file's.
    The picture you get back also carries that clip's real transform (crop,
    scale, rotation, position), so what you measure with `inspect_color` /
    `sample` is what the Edit preview and the export actually show. A loose clip
    opened outside a project (an "Untitled" session) has no clip, so there
    `frame` is just the source frame, as before."#
    )]
    pub async fn seek(
        &self,
        Parameters(p): Parameters<SeekArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new().set("frame", p.frame);
        let env = self.op("seek", args).await?;
        Ok(render::result(&env))
    }

    #[tool(
        name = "list_shots",
        description = r#"Every shot in the session and which one is active. A grading job is N
    shots from one shoot; each shot keeps its own grade (grade.json sidecar,
    D-025) and its own agent-activity feed. Returns {shots: [{path, name,
    frameCount, frame, width, height, fps, ...}], active, count}. An empty
    `shots` means a single still / nothing loaded."#
    )]
    pub async fn list_shots(&self) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new();
        let env = self.op("list_shots", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "undo",
        description = r#"Undo the most recent undoable action, on ANY tab — exactly what Cmd/Ctrl+Z
    does (D-383). The history is one stack shared by Edit, Motion and Colorist,
    so this reverses the latest thing done anywhere, whether a person or an
    agent did it, and the app switches to the tab that action belonged to, the
    way the keyboard shortcut does. A multi-step tool such as
    `editor_ripple_delete_ranges` is one entry, so one `undo` reverses all of it.

    An empty stack is not an error: you get `ok: true` and `undone: null`
    with a `note`. Read `undone` before acting on the result — it names what was
    reversed — and `undoLabel` to see what the NEXT `undo` would reverse.

    Returns {ok, undone: {tab, label} | null, activeTab, canUndo, canRedo,
    undoLabel, redoLabel, note?}."#
    )]
    pub async fn undo(&self) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new();
        let env = self.op("undo", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "redo",
        description = r#"Redo the action `undo` last reversed, on any tab — exactly what Cmd/Ctrl+Y
    does (D-383). A fresh edit after an undo discards the redo branch, so redo
    only works until you do something else. The app switches to the tab the
    redone action belongs to. An empty redo stack is `ok: true` with
    `redone: null` and a `note`, not an error.

    Returns {ok, redone: {tab, label} | null, activeTab, canUndo, canRedo,
    undoLabel, redoLabel, note?}."#
    )]
    pub async fn redo(&self) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new();
        let env = self.op("redo", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "add_shots",
        description = r#"Add one or more clips to the session by ABSOLUTE path and switch to the
    last one. A clip already in the session is updated in place. Use this to load
    a whole shoot, then grade shot by shot with set_active_shot. Returns the
    newly-active shot's frame + the shot list."#
    )]
    pub async fn add_shots(
        &self,
        Parameters(p): Parameters<AddShotsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new().set("paths", p.paths);
        let env = self.op("add_shots", args).await?;
        Ok(render::result(&env))
    }

    #[tool(
        name = "list_projects",
        description = r#"Every saved Apelles project in the projects folder (`~/Movies/Chroma` by
    default), newest first. A project is a `<name>.chroma` directory holding
    project.json (shots referenced by absolute source path — media is never
    copied), thumb.jpg, and grades/<shotId>.grade.json per shot. Returns
    {projects: [{name, path, modified, shotCount}], folder}. Open one with
    open_project."#
    )]
    pub async fn list_projects(&self) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new();
        let env = self.op("list_projects", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "open_project",
        description = r#"Open a saved project by name (see list_projects) or absolute `.chroma`
    path. Loads its shots into the session, restores each shot's grade, and puts
    the app in the editor. A shot whose source file is missing is flagged "media
    offline" — not fatal; relink it in the app. Returns {opened: {name, path},
    shots}.

    Switches the WHOLE app, every tab: the Edit tab reloads this project's own
    timeline and media pool, and the Motion tab its manifest (B-083). Their
    reload is a beat behind this call's return — if an `editor_*` op right
    after this says the timeline is still loading, retry it once."#
    )]
    pub async fn open_project(
        &self,
        Parameters(p): Parameters<OpenProjectArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        // One argument, two wire keys: the handler takes either `name` or `path`, and
        // which one this is is decided here, from the shape of the string. A separator
        // or a `.chroma` suffix means the caller gave a path; anything else is a name to
        // look up in the projects folder.
        let arg = p.name_or_path;
        let key = if arg.contains('/') || arg.ends_with(".chroma") {
            "path"
        } else {
            "name"
        };
        let env = self
            .op("open_project", WireArgs::new().set(key, arg))
            .await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "new_project",
        description = r#"Create a new `<name>.chroma` project in the projects folder from the given
    media (absolute paths; may be empty and added later), then open it in the
    editor. Media is referenced in place, never copied. Returns {created:
    {name, path}}.

    B-171: `media_paths` lands in the Edit tab's media pool only — NOT placed
    on the timeline. Follow with editor_add_clip (per path, in whatever order
    you actually want them) to place any of them.

    Like open_project, this switches every tab onto the new project — the Edit
    tab's timeline/media pool and the Motion tab's manifest all reload for it
    (B-083), a beat behind this call's return."#
    )]
    pub async fn new_project(
        &self,
        Parameters(p): Parameters<NewProjectArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("name", p.name)
            // An omitted media list is sent as an empty one, not left out: "create it
            // with nothing in it yet" is a documented call, and the handler reads the
            // key rather than defaulting it.
            .set("media_paths", p.media_paths.unwrap_or_default());
        let env = self.op("new_project", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "save_project",
        description = r#"Save the open project: rewrite project.json (shots + active shot),
    persist the active shot's grade.json, and regenerate the launcher thumb.
    Autosave already does this on a debounce while editing — call this to force
    an immediate write. Errors if no project is loaded or the session is an
    unsaved "Untitled" (save it as a project in the app first).

    Returns {ok, error, result: {saved, path, thumbRegenerated}} -- nothing
    else (B-296: it used to attach the whole grade and histogram). Read the
    grade with `get_state` / `get_grade`."#
    )]
    pub async fn save_project(&self) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new();
        let env = self.op("save_project", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "set_submask_mode",
        description = r#"Set a sub-mask's composition mode: "additive", "subtractive", or
    "intersect" (same as the app's Add / Subtract from / Intersect with Mask).
    sub_mask_id is from get_state / list_masks. Flipping a component to
    "subtractive" carves it out of the rest of its mask container."#
    )]
    pub async fn set_submask_mode(
        &self,
        Parameters(p): Parameters<SetSubmaskModeArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("sub_mask_id", p.sub_mask_id)
            .set("mode", p.mode);
        let env = self.op("set_submask_mode", args).await?;
        Ok(render::result(&env))
    }

    #[tool(
        name = "add_mask_keyframe",
        description = r#"Keyframe a SHAPE sub-mask's geometry (D-034). Snapshots the sub-mask's
    current geometry — radial: centre / radii / rotation / feather; linear:
    endpoints / range; brush: stroke points — as a keyframe at `frame` (default:
    the current frame). The engine interpolates the geometry per source frame on
    scrub / playback / export, so a mask that can't be SAM-tracked (a hand, a
    product, a light, a reflection, a patch of sky) follows the subject by hand.

    Workflow: seek(0) -> add_mask (radial over the face) -> add_mask_keyframe;
    seek(90) -> move the mask (add_mask again with new geometry, or the app's
    controls) -> add_mask_keyframe. The mask now glides between the keys.

    Geometry ONLY — grade adjustments, mode, invert, opacity are not keyframed.
    Re-calling at a frame that already has a key updates it. A sub-mask can't be
    both AI-tracked (chromaTrackDir) and keyframed — tracked wins. mask_id /
    sub_mask_id are from list_masks / get_state."#
    )]
    pub async fn add_mask_keyframe(
        &self,
        Parameters(p): Parameters<AddMaskKeyframeArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("mask_id", p.mask_id)
            .set("sub_mask_id", p.sub_mask_id)
            .put("frame", p.frame);
        let env = self.op("add_mask_keyframe", args).await?;
        Ok(render::result(&env))
    }

    #[tool(
        name = "list_mask_keyframes",
        description = r#"List a shape sub-mask's geometry keyframes (D-034): the frame index and
    the snapshotted geometry params for each. Returns {maskId, subMaskId, type,
    tracked, keyframes: [{frame, params}]}. Empty `keyframes` = a static mask."#
    )]
    pub async fn list_mask_keyframes(
        &self,
        Parameters(p): Parameters<ListMaskKeyframesArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("mask_id", p.mask_id)
            .set("sub_mask_id", p.sub_mask_id);
        let env = self.op("list_mask_keyframes", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "clear_mask_keyframe",
        description = r#"Remove ONE geometry keyframe (D-034), the one at `frame` (a frame from
    list_mask_keyframes). When the last keyframe is removed the sub-mask becomes
    fully static again."#
    )]
    pub async fn clear_mask_keyframe(
        &self,
        Parameters(p): Parameters<ClearMaskKeyframeArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("mask_id", p.mask_id)
            .set("sub_mask_id", p.sub_mask_id)
            .set("frame", p.frame);
        let env = self.op("clear_mask_keyframe", args).await?;
        Ok(render::result(&env))
    }

    #[tool(
        name = "clear_mask_keyframes",
        description = r#"Remove ALL geometry keyframes from a shape sub-mask (D-034) — it goes back
    to a single static geometry (whatever it currently interpolates to is NOT
    baked; the sub-mask keeps its base parameters)."#
    )]
    pub async fn clear_mask_keyframes(
        &self,
        Parameters(p): Parameters<ClearMaskKeyframesArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("mask_id", p.mask_id)
            .set("sub_mask_id", p.sub_mask_id);
        let env = self.op("clear_mask_keyframes", args).await?;
        Ok(render::result(&env))
    }

    #[tool(
        name = "track_subject",
        description = r#"Propagate a subject sub-mask across the whole clip (SAM 2 memory
    propagation). mode: "fast" (guided-filter edge, upgrades to ViTMatte on
    seek-settle) or "quality" (ViTMatte every frame — the pre-export pass).
    The matte is read from disk per frame at render time."#
    )]
    pub async fn track_subject(
        &self,
        Parameters(p): Parameters<TrackSubjectArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("sub_mask_id", p.sub_mask_id)
            .set("mode", p.mode);
        let env = self
            .op_with("track_subject", crate::AI_MASK_TIMEOUT_MS, args)
            .await?;
        Ok(render::result(&env))
    }

    #[tool(
        name = "depth_track",
        description = r#"Precompute a **temporally-consistent depth map for every frame** of the
    clip (Video Depth Anything — Small, in the AI sidecar) and point a depth
    sub-mask at the cache. This is what makes `apply_haze` track a MOVING CAMERA
    without the depth flickering — a per-frame model can't, a video-depth model
    (temporal attention across frames, like DaVinci Resolve's z-depth) can.

    Run `apply_haze` first (it creates the depth sub-mask); then call this to
    upgrade that mask from the static single-frame bake to the per-frame track.
    `sub_mask_id` defaults to the "Depth Haze" depth sub-mask.

    from_frame / to_frame: default the whole clip (a 4K clip — narrow the range).
    step: save density (every frame is still fed to the model). input_size: 518
      default; lower = faster, coarser.

    NON-blocking — the first run also downloads the ~112 MB checkpoint, and a
    long clip is minutes. Returns {started, jobId, dir, total} immediately; poll
    `depth_track_status`. Once done, scrub/playback/export read the per-frame
    depth automatically."#
    )]
    pub async fn depth_track(
        &self,
        Parameters(p): Parameters<DepthTrackArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("from_frame", p.from_frame)
            .set("to_frame", p.to_frame)
            .set("step", p.step)
            .set("input_size", p.input_size)
            .set("sub_mask_id", p.sub_mask_id);
        let env = self.op("depth_track", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "depth_track_status",
        description = r#"Poll the depth track started by `depth_track`. Returns
    {running, done, total, tracked} — `tracked: true` once a depth sub-mask
    carries the per-frame cache dir (the pass finished and the render now uses
    it). `running: false` with `tracked: false` means it errored or was
    cancelled — check the app log for '[depth]' / '[sidecar]' lines."#
    )]
    pub async fn depth_track_status(&self) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new();
        let env = self.op("depth_track_status", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "invert_mask",
        description = r#"Invert a sub-mask (grade the outside instead of the inside)."#
    )]
    pub async fn invert_mask(
        &self,
        Parameters(p): Parameters<InvertMaskArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new().set("sub_mask_id", p.sub_mask_id);
        let env = self.op("invert_mask", args).await?;
        Ok(render::result(&env))
    }

    #[tool(
        name = "delete_mask",
        description = r#"Delete a whole mask container (mask_id from list_masks)."#
    )]
    pub async fn delete_mask(
        &self,
        Parameters(p): Parameters<DeleteMaskArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new().set("mask_id", p.mask_id);
        let env = self.op("delete_mask", args).await?;
        Ok(render::result(&env))
    }

    #[tool(
        name = "list_relight_lights",
        description = r#"List every light in the "Relight" grade layer (D-048) plus its depth
    source. Returns {lights: [{id, kind, x, y, radius, intensity, color,
    visible, chromaKeyframes?}], depthDir}. kind is "key" | "fill" | "rim" |
    "ambient" — only "ambient" changes the shading math (uniform tint, no
    position/falloff); the other three are UI presets sharing one math path.
    x/y/radius are 0-100 percentages of frame size. depthDir is the tracked
    Video-Depth-Anything directory (depth_track / "Track Depth" in the
    Relight panel) key/fill/rim lights shade against — null means those
    positional lights currently render as a no-op UNLESS a static depth bake
    exists (see the Relight panel's "Bake Depth" button, D-054); ambient
    lights need no depth source at all."#
    )]
    pub async fn list_relight_lights(&self) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new();
        let env = self.op("list_relight_lights", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "delete_relight_light",
        description = r#"Delete one light from the "Relight" grade layer (id from
    list_relight_lights). Does not touch the depth track/bake or any other
    light."#
    )]
    pub async fn delete_relight_light(
        &self,
        Parameters(p): Parameters<DeleteRelightLightArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new().set("id", p.id);
        let env = self.op("delete_relight_light", args).await?;
        Ok(render::result(&env))
    }

    #[tool(
        name = "sample",
        description = r#"Read the RGB (and hex + luma) of one pixel of the current rendered frame.
    x, y are in the returned frame's pixel space (see `frameSize` from
    inspect_color). Use it to check a known-neutral wall actually reads neutral."#
    )]
    pub async fn sample(
        &self,
        Parameters(p): Parameters<SampleArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new().set("x", p.x).set("y", p.y);
        let env = self.op("sample", args).await?;
        Ok(render::result(&env))
    }

    #[tool(
        name = "sample_region",
        description = r#"Mean / min / max RGB over a rectangle of the current rendered frame
    (x, y, w, h in the frame's pixel space). Use it to measure skin on a cheek,
    a grey card, the darkest / brightest patch."#
    )]
    pub async fn sample_region(
        &self,
        Parameters(p): Parameters<SampleRegionArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("x", p.x)
            .set("y", p.y)
            .set("w", p.w)
            .set("h", p.h);
        let env = self.op("sample_region", args).await?;
        Ok(render::result(&env))
    }

    #[tool(
        name = "add_subject_mask",
        description = r#"Add a new mask container with an AI subject sub-mask and generate the
    matte. bbox is [x0, y0, x1, y1] in source pixels around the subject; omit
    for a near-full-frame prompt. On a video this routes through SAM 2 (sidecar);
    on a still, ONNX SAM.

    mode is the sub-mask's composition mode: "additive" (default), "subtractive",
    or "intersect" — the same Add / Subtract / Intersect the app's mask menu uses.
    Returns {maskId, subMaskId, mode} and the rendered frame."#
    )]
    pub async fn add_subject_mask(
        &self,
        Parameters(p): Parameters<AddSubjectMaskArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new().set("mode", p.mode).put("bbox", p.bbox);
        let env = self
            .op_with("add_subject_mask", crate::AI_MASK_TIMEOUT_MS, args)
            .await?;
        Ok(render::result(&env))
    }

    #[tool(
        name = "set_primary",
        description = r#"Set primary (whole-image) grade knobs. Only the args you pass change;
    the rest are left as-is. Ranges roughly match the app's sliders
    (exposure ~ -5..5 stops, most others -100..100). Returns the rendered frame
    plus the new scope summary. Grade by the numbers: call `inspect_color` before
    and after and reason from the scope values, not the thumbnail. Never claim a
    result without citing a scope value or a sampled region."#
    )]
    pub async fn set_primary(
        &self,
        Parameters(p): Parameters<SetPrimaryArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        // Every knob the caller supplied, and only those, as one `patch` the handler
        // merges into the primary grade — which is what makes "nudge exposure and leave
        // the other fourteen alone" a single call. `vignetteAmount` is camelCase in the
        // published parameter list too, not a rename: that is the name callers send.
        let patch = WireArgs::new()
            .put("exposure", p.exposure)
            .put("contrast", p.contrast)
            .put("highlights", p.highlights)
            .put("shadows", p.shadows)
            .put("whites", p.whites)
            .put("blacks", p.blacks)
            .put("temperature", p.temperature)
            .put("tint", p.tint)
            .put("saturation", p.saturation)
            .put("vibrance", p.vibrance)
            .put("dehaze", p.dehaze)
            .put("clarity", p.clarity)
            .put("structure", p.structure)
            .put("sharpness", p.sharpness)
            .put("vignetteAmount", p.vignette_amount);
        let env = self
            .op(
                "set_primary",
                WireArgs::new().set("patch", patch.into_value()),
            )
            .await?;
        Ok(render::result(&env))
    }

    #[tool(
        name = "save_grade",
        description = r#"Write the current grade to a grade.json file on disk. Omit `path` to save
    beside the source clip as <name>.grade.json.

    Static mask mattes are externalised to a sibling <name>.mattes/ folder (the
    JSON keeps a {"$matte": ...} reference), and a tracked-matte folder is
    referenced, not copied — so moving the project needs its .chroma/mattes/ dir
    too. The result is small and diff-able: commit grade.json + its .mattes/ dir
    to the project repo. A one-knob change is a one-line diff.

    Returns {path, matteFiles, trackDirs}. It is a local file the user asked for
    — no confirm-before-write; the resolved path is always returned."#
    )]
    pub async fn save_grade(
        &self,
        Parameters(p): Parameters<SaveGradeArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        // An empty `path` is omitted, not sent: the handler's own "beside the source
        // clip" default is what an absent key selects.
        let args = WireArgs::new().put("path", p.path.filter(|s| !s.is_empty()));
        let env = self.op("save_grade", args).await?;
        Ok(render::json_text(&flatten_result(&env)))
    }

    #[tool(
        name = "set_active_shot",
        description = r#"Switch the active shot by 0-based `index` (from list_shots) or by `path`
    / filename. Saves the current shot's grade, loads the target, restores its
    grade (neutral if it has none), and scopes the activity feed to it. Grade
    each shot in turn: set_active_shot(1) -> grade -> set_active_shot(2) -> grade.
    Returns the target shot's rendered frame + the updated shot list."#
    )]
    pub async fn set_active_shot(
        &self,
        Parameters(p): Parameters<SetActiveShotArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new().put("index", p.index).put("path", p.path);
        if args.is_empty() {
            // Answered here rather than sent: with neither argument there is no shot to
            // switch to, and the app would have to invent one. Rendered through the same
            // renderer as a real answer so the caller parses one shape, not two.
            return Ok(render::result(&json!({
                "ok": false,
                "error": "pass index or path",
                "result": null,
            })));
        }
        let env = self.op("set_active_shot", args).await?;
        Ok(render::result(&env))
    }

    #[tool(
        name = "set_project_settings",
        description = r#"Set the open project's output spec (D-038): one resolution / frame rate /
    colour space for the whole (possibly multi-shot) project instead of deriving
    everything from whichever clip is loaded.

    Partial merge — only the arguments you pass are changed; the rest are left
    as-is. A project with no settings behaves exactly as clip-derived (the
    default). Export uses width+height (the graded composite is resized to it as
    the final step) and fps (encoder timebase). `color_space` (`rec709` /
    `rec2020` / `dci-p3` / `srgb`) is **stored + surfaced only** — a real
    colour-managed pipeline is D-004, not this. Returns the merged settings.

    Needs a saved project loaded (open_project / new_project first)."#
    )]
    pub async fn set_project_settings(
        &self,
        Parameters(p): Parameters<SetProjectSettingsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .put("width", p.width)
            .put("height", p.height)
            .put("fps", p.fps)
            .put("colorSpace", p.color_space);
        if args.is_empty() {
            // A partial merge of nothing would be a no-op the caller could not tell from
            // a successful change, so it is refused here rather than sent. Note this one
            // answers with a bare `{error}` — no `ok` key — which is what the Python did.
            return Ok(render::json_text(&json!({
                "error": "pass at least one of width, height, fps, color_space",
            })));
        }
        let env = self.op("set_project_settings", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "set_mask_adjust",
        description = r#"Grade *through* a mask — same knobs as set_primary, applied only where
    the mask (mask_id, from list_masks) is. Only passed args change.

    `blur` (0–100, mask-only) defocuses the masked region: the shader blends it
    toward a pre-blurred (~40px) copy of the frame, weighted by mask * blur/100.
    Use it to soften a background behind a subtractive-subject / depth mask
    ("blur the background"); `apply_haze` already dials it in.

    Grade by the numbers: sample the masked region (`sample_region`) before and
    after and cite the values; don't eyeball the matted area. For blur, a
    high-frequency edge under the mask should lose local contrast."#
    )]
    pub async fn set_mask_adjust(
        &self,
        Parameters(p): Parameters<SetMaskAdjustArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        // `set_primary`'s knobs, minus `vignetteAmount` and plus `blur`, which only
        // means anything through a mask. `mask_id` names the target and is NOT part of
        // the patch.
        let patch = WireArgs::new()
            .put("exposure", p.exposure)
            .put("contrast", p.contrast)
            .put("highlights", p.highlights)
            .put("shadows", p.shadows)
            .put("whites", p.whites)
            .put("blacks", p.blacks)
            .put("temperature", p.temperature)
            .put("tint", p.tint)
            .put("saturation", p.saturation)
            .put("vibrance", p.vibrance)
            .put("dehaze", p.dehaze)
            .put("clarity", p.clarity)
            .put("structure", p.structure)
            .put("sharpness", p.sharpness)
            .put("blur", p.blur);
        let args = WireArgs::new()
            .set("mask_id", p.mask_id)
            .set("patch", patch.into_value());
        let env = self.op("set_mask_adjust", args).await?;
        Ok(render::result(&env))
    }

    #[tool(
        name = "apply_haze",
        description = r#"Depth-weighted atmospheric haze on the background — one action, pushes the
    subject forward.

    Adds a "Depth Haze" mask: the matte is a full-range depth mask, inverted, so
    its weight tracks distance (the subject ~0, the far wall ~max); the grade is
    negative dehaze (adds haze in-shader) + desaturation + a lifted black point
    and shadows + a background defocus (per-mask blur, D-027), all scaled by
    `amount` (1.0 = default, 0.4 subtle, 1.6 heavy).

    protect_subject (default true): a tracked ai-subject mask's own grade
    composites on top and keeps the subject punchy, so nothing extra is needed.
    Caveat: a subject physically in the far-depth band still picks up some haze.

    Depth: by default a single-frame Depth Anything V2 bake (static — fine for a
    locked-off shot; flickers on a moving camera). `tracked=true` (video only)
    also kicks off a `depth_track` — a per-frame temporally-consistent depth map
    (Video Depth Anything) that the render then follows frame-by-frame. That runs
    in the background (minutes on a long clip); poll `depth_track_status`. You
    can also call `depth_track` later to upgrade an existing haze mask.

    Grade by the numbers: `inspect_color` before and after — whole-frame
    saturation should drop and the black point lift; `sample` a background pixel
    vs a subject pixel and confirm the background moved more.
    Returns {maskId, subMaskId, amount, tracked} and the rendered frame."#
    )]
    pub async fn apply_haze(
        &self,
        Parameters(p): Parameters<ApplyHazeArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("amount", p.amount)
            .set("protect_subject", p.protect_subject)
            .set("tracked", p.tracked);
        let env = self
            .op_with("apply_haze", crate::AI_MASK_TIMEOUT_MS, args)
            .await?;
        Ok(render::result(&env))
    }

    #[tool(
        name = "add_relight_light",
        description = r##"Add a light to the "Relight" grade layer (D-048) — a deterministic,
    depth-driven virtual light, the agent's path to relight without driving
    the canvas puck (RelightPuckLayer) directly.

    kind: "key" | "fill" | "rim" | "ambient". Each has a sensible preset
    default (e.g. "key" = warm, screen-left, tight falloff) applied first;
    only the args you pass override it. "ambient" ignores x/y/radius (it
    tints the whole frame uniformly, no position/falloff).

    x/y: 0-100, percentage of frame width/height. radius: 0-100, percentage
    of the longer frame dimension — falloff distance, ignored for ambient.
    intensity: 0-200 (100 = the shader's baseline light strength). color:
    "#rrggbb".

    A positional (key/fill/rim) light needs a depth source to actually shade
    anything — run depth_track first (temporal, video only), or use the
    Relight panel's "Bake Depth" button (static single-frame fallback,
    D-054, also works on a still). Returns {light} and the rendered frame."##
    )]
    pub async fn add_relight_light(
        &self,
        Parameters(p): Parameters<AddRelightLightArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("kind", p.kind)
            .put("x", p.x)
            .put("y", p.y)
            .put("radius", p.radius)
            .put("intensity", p.intensity)
            .put("color", p.color);
        let env = self.op("add_relight_light", args).await?;
        Ok(render::result(&env))
    }

    #[tool(
        name = "set_relight_light",
        description = r#"Update an existing relight light (id from list_relight_lights /
    add_relight_light). Only passed args change. Same field meanings as
    add_relight_light. Set visible=false to temporarily disable a light
    without deleting it. Returns {id, patch} and the rendered frame."#
    )]
    pub async fn set_relight_light(
        &self,
        Parameters(p): Parameters<SetRelightLightArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        // Unlike set_primary and set_mask_adjust, the supplied fields go at the TOP
        // level beside `id` rather than nested under a `patch` key.
        let args = WireArgs::new()
            .set("id", p.id)
            .put("x", p.x)
            .put("y", p.y)
            .put("radius", p.radius)
            .put("intensity", p.intensity)
            .put("color", p.color)
            .put("visible", p.visible)
            .put("kind", p.kind);
        let env = self.op("set_relight_light", args).await?;
        Ok(render::result(&env))
    }

    #[tool(
        name = "match_to_reference",
        description = r#"Auto-grade the current shot toward a reference image.

    Measures the scope gap to `reference` (an ABSOLUTE image path) and
    iteratively applies a DAMPED primary correction — exposure, temperature,
    tint, contrast, saturation — re-measuring after each step until the combined
    gap is below `tolerance` or `max_iters` is reached. This automates the
    measure -> adjust -> re-measure discipline.

    - strength: overall scale on each correction (1.0 default; lower = gentler).
    - max_iters: cap on iterations (default 4; 1..12).
    - tolerance: combined-gap magnitude to stop at (default 3.0). The magnitude
      weights |EV| x8, warm-cool + green-magenta cast (channel-code units),
      |saturation| x20, and black/white-point deltas.

    Merges into the PRIMARY grade, not a new layer — a reference match is a
    balance. Creative look, curves, and mask work are separate and untouched.

    Returns {converged, iterations, gap_before, gap_after, applied (cumulative
    primary delta), trace: [{iter, damp, gapMag_before, gapMag_after, patch,
    cumulative}]} plus the final rendered frame + scope summary. Scope-first:
    inspect the result and confirm the cast / black point moved toward the
    reference; don't declare a match from the thumbnail. Defer the creative call.
    "#
    )]
    pub async fn match_to_reference(
        &self,
        Parameters(p): Parameters<MatchToReferenceArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("reference", p.reference)
            .set("strength", p.strength)
            .set("max_iters", p.max_iters)
            .set("tolerance", p.tolerance);
        let env = self.op("match_reference", args).await?;
        Ok(render::result(&env))
    }

    #[tool(
        name = "request_human",
        description = r#"Hand back to the user — call this when you are genuinely unsure, when a
    call is creative rather than technical, or when you are done and want them to
    review.

    This is NOT a routine step. Use it for: "the skin tone is a judgement call I
    shouldn't make", "the matte edge on the hair needs manual cleanup here",
    "I've balanced the shot to the reference — does this look right to you?".
    Don't use it to narrate ordinary progress.

    reason: a short, specific sentence shown to the user in a banner.
    roi: optional {x, y, w, h} normalized to 0..1 (top-left origin) — a region
      drawn as a rectangle on the canvas so the user knows where to look
      (e.g. a face crop, a matte-edge artifact, the darkest patch).

    Non-blocking: this posts the request and returns immediately with
    {posted: true, reason, roi}. It does NOT wait for the user. To find out
    whether they have acted, call `get_state` and read `pendingHumanRequest`:
    it becomes null / `cleared: true` once they click "Resume agent". Keep going
    once it's cleared.

    Every change you made is already visible to the user in the GUI "Agent
    activity" feed, with a per-field diff and an undo button — you don't need to
    summarise your edits here, just say what you need from them."#
    )]
    pub async fn request_human(
        &self,
        Parameters(p): Parameters<RequestHumanArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new().set("reason", p.reason).put("roi", p.roi);
        let env = self.op("request_human", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "export",
        description = r#"Render the ACTIVE CLIP's grade to a file — the Colorist single-clip
    render, not the timeline. `editor_export` is the timeline exporter; use that
    one for a cut, and this one when you want one clip's grade rendered at full
    fidelity.

    **What this does that `editor_export` cannot (D-297):** it renders through
    the real wgpu grading pipeline, so the SPATIAL half of a grade — mask layers
    / local adjustments, relight, the Colorist crop — reaches the file.
    `editor_export` carries only the global grade, baked to a 3D LUT (D-256),
    and warns when it drops the rest.

    **`from_frame`/`to_frame` are CLIP-LOCAL (D-294)**, like `seek`: 0 is the
    clip's in-point on the Edit timeline and the range is bounded by
    `get_state().shot.frameCount`. The rendered picture carries the clip's own
    transform, so it matches what the Colorist preview shows. A clip with a
    SPEED RAMP is refused — this render does one linear decode pass; export it
    from the Edit tab, whose exporter honours ramps.

    kind:
      - "prores" (default) — ProRes 422 HQ .mov (prores_ks -profile:v 3, 10-bit 422)
      - "h264"             — .mp4 (libx264 -crf 18)
      - "cube"             — bake the PRIMARY grade (global only, no masks) to a
                             33³ .cube 3D LUT for use in another app

    path: output file. Omit to write next to the source clip as
      <name>.graded.mov / .mp4 / .cube.
    from_frame / to_frame: video only; default = the whole clip.
    quality: h264 → -crf (0-51, lower = better); prores → -profile:v (0-5).

    Video export runs in the background; this polls to completion and returns the
    resolved path, frame count, elapsed time, and any warning (e.g. masked layers
    dropped from a .cube). It is a local file the user asked for — no confirm.
    "#
    )]
    pub async fn export(
        &self,
        Parameters(p): Parameters<ExportArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        // A LUT bake is synchronous — one call, one answer, with `result` flattened up
        // beside ok/error the way `save_grade` does it.
        if p.kind == "cube" {
            let env = self
                .op(
                    "export",
                    WireArgs::new().set("kind", "cube").set("path", p.path),
                )
                .await?;
            return Ok(render::json_text(&flatten_result(&env)));
        }

        // A video export runs in the background, so this kicks it off and then polls to
        // completion — the tool returns when the file is written, not when the render
        // starts, because "it is exporting" is not an answer a caller can act on.
        let start = self
            .op(
                "export",
                WireArgs::new()
                    .set("kind", p.kind)
                    .set("path", p.path)
                    // Note the wire keys: `from`/`to`, not `from_frame`/`to_frame`.
                    .put("from", p.from_frame)
                    .put("to", p.to_frame)
                    .put("quality", p.quality),
            )
            .await?;
        if !start.get("ok").and_then(Value::as_bool).unwrap_or(false) {
            // Refused before it began (a speed-ramped clip, a bad range) — hand back the
            // refusal itself; there is nothing to poll.
            return Ok(render::json_text(&start));
        }

        let kicked = start.get("result").cloned().unwrap_or(Value::Null);
        let last = loop {
            tokio::time::sleep(EXPORT_POLL_INTERVAL).await;
            let env = self.op("export_progress", WireArgs::new()).await?;
            let progress = env.get("result").cloned().unwrap_or(Value::Null);
            if !progress
                .get("running")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                break progress;
            }
        };

        let field = |v: &Value, k: &str| v.get(k).cloned().unwrap_or(Value::Null);
        let out_path = match field(&last, "out_path") {
            Value::Null => field(&kicked, "out_path"),
            found => found,
        };
        Ok(render::json_text(&json!({
            // The progress feed reports failure by carrying an `error`, so that — not a
            // separate flag — is what decides whether this succeeded.
            "ok": field(&last, "error").is_null(),
            "out_path": out_path,
            "frames": field(&last, "done"),
            "total": field(&last, "total"),
            "error": field(&last, "error"),
            "kickoff": kicked,
        })))
    }
}

/// This tab's contribution to the merged router.
pub fn router() -> rmcp::handler::server::router::tool::ToolRouter<ApellesMcp> {
    ApellesMcp::colorist_router()
}

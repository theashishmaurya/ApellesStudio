//! Brand-kit tools — one brand definition for every tab (D-416).
//!
//! **Why their own module and not a tab's.** A brand kit belongs to no single tab:
//! it is applied to Edit, Motion and the Colorist alike, and the ops are answered by
//! `@apelles/brand`'s own registry (`useBrandControl`, the `brand_` prefix, mounted
//! from the app), not by any tab's. Filing them under one tab would misdescribe them,
//! the reasoning that gave `ai_env` its own module (D-315). Not behind the `motion`
//! feature: in a build without the Motion tab the kit still applies to Edit and the
//! Colorist, and `brand_apply_kit` reports Motion as unavailable.
//!
//! Every description below is the Python tool's docstring, byte-for-byte, and
//! `tests/parity.rs` compares them character by character (D-312).

use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::CallToolResult;
use rmcp::{ErrorData, tool, tool_router};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;

use crate::args::WireArgs;
use crate::render;
use crate::server::ApellesMcp;

/// This module's contribution to the merged router.
pub fn router() -> rmcp::handler::server::router::tool::ToolRouter<ApellesMcp> {
    ApellesMcp::brand_router()
}

fn default_true() -> bool {
    true
}

fn default_reference_kind() -> String {
    "reference".to_string()
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct BrandGetKitArgs {
    #[serde(default)]
    pub id: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct BrandCreateKitArgs {
    pub kit: serde_json::Map<String, Value>,
    #[serde(default)]
    pub dry_run: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct BrandUpdateKitArgs {
    pub id: String,
    pub patch: serde_json::Map<String, Value>,
    #[serde(default)]
    pub dry_run: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct BrandDeleteKitArgs {
    pub id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct BrandImportAssetArgs {
    pub path: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
// Required AND nullable: schemars's per-field `required` drops the nullability, so
// the required list is set at the struct level (`EditorMoveMediaArgs`'s fix).
#[schemars(extend("required" = ["id"]))]
pub struct BrandSetActiveKitArgs {
    /// REQUIRED, and nullable: null CLEARS the project's kit. No `#[serde(default)]`
    /// on purpose (the `editor_move_media` `folder` rule): the Python annotates it
    /// `str | None` with no default, so leaving the argument out is an error, never
    /// a silent clear of the project's brand.
    pub id: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct BrandApplyKitArgs {
    #[serde(default)]
    pub tabs: Option<Vec<String>>,
    #[serde(default)]
    pub restyle_existing: bool,
    #[serde(default = "default_true")]
    pub titles: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct BrandAddReferenceArgs {
    pub path: String,
    pub note: String,
    #[serde(default = "default_reference_kind")]
    pub kind: String,
    #[serde(default)]
    pub kit_id: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct BrandGetReferencesArgs {
    #[serde(default)]
    pub kit_id: Option<String>,
}

#[tool_router(router = brand_router, vis = "pub")]
impl ApellesMcp {
    #[tool(
        name = "brand_list_kits",
        description = r#"List the user's brand kits and the one THIS project uses (D-416). Start here
    before designing anything for a person: read the project's kit, then
    `brand_get_references`.

    A brand kit is the one brand definition every tab reads: colours (primary,
    secondary, accent, background, text + an extended palette), typography
    (display/body/mono, each a Google, system or licensed font file), logos
    (light/dark/mark), a motion style (ease, speed, stagger, entrance), a caption
    style (an Edit caption preset), an optional grade look (a LUT for the
    Colorist), sound (sonic logo, music mood) and references (images/videos with
    a note on what to take from each).

    Returns `kits` (a summary each), `loadErrors` (library files that did not
    load, each named with why), `project` (the project's own copy, with
    `libraryVersion` and `newerInLibrary`) or null, and `tabs` (which tabs can
    apply a kit in this build)."#
    )]
    pub async fn brand_list_kits(&self) -> Result<CallToolResult, ErrorData> {
        let env = self.op("brand_list_kits", WireArgs::new()).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "brand_get_kit",
        description = r#"Read one brand kit in full (D-416): `id` from the library, or omit it for the
    project's own copy (what `brand_apply_kit` applies).

    Returns `source` (library | project), the whole `kit`, its WCAG `contrast`
    (every colour pair that ends up on top of another: ratio, AA/AAA level, what
    it is used for) and `warnings` for the pairs too low for their use, and
    `files` (each asset id the kit names → its absolute file, so you can look at
    a logo)."#
    )]
    pub async fn brand_get_kit(
        &self,
        Parameters(p): Parameters<BrandGetKitArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let env = self
            .op("brand_get_kit", WireArgs::new().put("id", p.id))
            .await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "brand_create_kit",
        description = r#"Create a brand kit in the user's library (D-416).

    `kit` needs `id` (lowercase letters, digits, hyphens, at most 40) and `name`;
    everything else you leave out comes from a neutral starter, so a few fields
    are enough. Shape: `{id, name, description?, colors: {primary, secondary,
    accent, background, text, palette?: [{name, hex}]}, typography: {display,
    body, mono?: {family, source: "google"|"system"|"file", file?, licence?,
    weights?, editFallback?}, scale?: {base, ratio, displayWeight, bodyWeight}},
    logos?: {light?, dark?, mark?}, motion?: {ease: "out"|"inOut"|"anticipate"|
    "linear"|[x1,y1,x2,y2], speed, stagger, entrance: "none"|"fade"|"pop"|"rise"|
    "draw"}, captions?: {preset, font?: "display"|"body", color?, boxColor?
    (colour roles)}, look?: {lut, intensity, name?}, sound?: {sonicLogo?, music?:
    {mood?, bpm?: [low, high], tracks?}}, references?}`. Colours are `#rrggbb`.
    Files (logos, a font file, a LUT, references, audio) are asset ids from
    `brand_import_asset`, never paths. A `file` font needs its `licence` (what it
    allows, in the person's words). `editFallback` is the Edit tab's font key
    for a face that is not a .ttf/.otf file.

    Refused with `issues` `[{path, message}]` naming every problem; nothing is
    saved. `dry_run` validates and reports contrast without saving. Returns the
    saved kit (version 1), `contrast` and `warnings`."#
    )]
    pub async fn brand_create_kit(
        &self,
        Parameters(p): Parameters<BrandCreateKitArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("kit", p.kit)
            .put_if("dry_run", p.dry_run);
        let env = self.op("brand_create_kit", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "brand_update_kit",
        description = r##"Change a brand kit in the library (D-416). `patch` merges into the kit: objects
    key by key (`{"colors": {"accent": "#ff5a1f"}}` changes one colour), lists and
    values replace, and `null` removes an optional section (`{"look": null}`).
    `id`, `version` and `schemaVersion` are not yours to change.

    Every save is the next `version`. A project that uses this kit keeps its own
    copy until `brand_set_active_kit` is called again; the answer says so
    (`projectOutOfDate`). Refused with `issues` when the result would not be a
    valid kit; `dry_run` checks without saving."##
    )]
    pub async fn brand_update_kit(
        &self,
        Parameters(p): Parameters<BrandUpdateKitArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("id", p.id)
            .set("patch", p.patch)
            .put_if("dry_run", p.dry_run);
        let env = self.op("brand_update_kit", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "brand_delete_kit",
        description = r#"Delete a brand kit from the user's library (D-416). Projects that use it keep
    their own copy, so nothing already branded changes."#
    )]
    pub async fn brand_delete_kit(
        &self,
        Parameters(p): Parameters<BrandDeleteKitArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let env = self
            .op("brand_delete_kit", WireArgs::new().set("id", p.id))
            .await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "brand_import_asset",
        description = r#"Import a file into the brand asset store (D-416): a logo (png, jpg, webp,
    gif, svg), a font file (ttf, otf, woff, woff2), a LUT (cube), a reference video
    (mp4, mov, m4v, webm) or audio (mp3, wav, m4a, aac, flac, ogg). The file is
    copied and named by the SHA-256 of its bytes; the same file twice is the same
    id. Returns `asset.id` (`sha256:<hex>.<ext>`) to put in a kit field with
    `brand_update_kit`. For a reference with a note, use `brand_add_reference`."#
    )]
    pub async fn brand_import_asset(
        &self,
        Parameters(p): Parameters<BrandImportAssetArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let env = self
            .op_with(
                "brand_import_asset",
                crate::BRAND_TIMEOUT_MS,
                WireArgs::new().set("path", p.path),
            )
            .await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "brand_set_active_kit",
        description = r#"Make a library kit this project's brand kit, or clear it with null (D-416).

    The kit and every file it names are COPIED into the project
    (`<project>.chroma/brand/`), so the project never depends on the library:
    editing or deleting the library kit later changes nothing here until this is
    called again. Setting a kit does not restyle anything yet; `brand_apply_kit`
    does, one undo step per tab. Clearing leaves looks already applied in place
    (undo them in their tab)."#
    )]
    pub async fn brand_set_active_kit(
        &self,
        Parameters(p): Parameters<BrandSetActiveKitArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let env = self
            .op("brand_set_active_kit", WireArgs::new().set("id", p.id))
            .await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "brand_apply_kit",
        description = r#"Apply the project's brand kit to the tabs (D-416): ONE undo step in each tab.

    `tabs` is any of "edit", "motion", "colorist" (default all):
      * motion: the kit becomes the document's theme (`brand-<kit id>`, embedded,
        so renders never read the kit); its font files and logos are copied into
        the Motion asset folder under the same ids. Templates and custom
        components pick colours and fonts up from the theme. From then on new
        layers take the kit's entrance and new keyframes its ease as DEFAULTS.
        `restyle_existing` also rewrites EXISTING entrances and keyframe eases
        with the kit's motion style; off by default.
      * edit: every unlocked subtitle track gets the kit's caption preset with
        its font and colour roles, and (unless `titles` is false) every title its
        display font and text colour. Fonts reach Edit only as .ttf/.otf files
        or through a font's `editFallback`; the answer says when one did not.
      * colorist: the open shot gets the kit's LUT at its intensity.
    Returns per tab `{ok, changed, summary, details}` or `{ok: false, error}` (a
    tab not in this build is reported, not skipped silently)."#
    )]
    pub async fn brand_apply_kit(
        &self,
        Parameters(p): Parameters<BrandApplyKitArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .put("tabs", p.tabs)
            .put_if("restyle_existing", p.restyle_existing);
        // `titles` defaults TRUE, so only a `false` is sent.
        let args = if p.titles {
            args
        } else {
            args.set("titles", false)
        };
        let env = self
            .op_with("brand_apply_kit", crate::BRAND_TIMEOUT_MS, args)
            .await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "brand_add_reference",
        description = r#"Add a reference to a brand kit (D-416): an image or video the person wants
    the work to learn from, with a `note` saying WHAT to take from it ("use my
    work for materials and framing"; "use the reference for type and
    hierarchy"). `kind` is "own-work" (the person's own) or "reference" (someone
    else's). The file is imported into the brand asset store; the kit is the
    project's kit unless `kit_id` names another. When the project uses that kit,
    its copy is updated too, so `brand_get_references` shows it at once."#
    )]
    pub async fn brand_add_reference(
        &self,
        Parameters(p): Parameters<BrandAddReferenceArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("path", p.path)
            .set("note", p.note)
            .set("kind", p.kind)
            .put("kit_id", p.kit_id);
        let env = self
            .op_with("brand_add_reference", crate::BRAND_TIMEOUT_MS, args)
            .await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "brand_get_references",
        description = r#"Everything an agent should read BEFORE designing for this brand (D-416): the
    kit's direction (colours, typography, motion style, captions, logos as
    absolute files, sound) and its references, each with its note, kind, media
    (image | video) and absolute `path` to open and look at. The project's kit by
    default; `kit_id` reads a library kit instead."#
    )]
    pub async fn brand_get_references(
        &self,
        Parameters(p): Parameters<BrandGetReferencesArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let env = self
            .op(
                "brand_get_references",
                WireArgs::new().put("kit_id", p.kit_id),
            )
            .await?;
        Ok(render::json_text(&env))
    }
}

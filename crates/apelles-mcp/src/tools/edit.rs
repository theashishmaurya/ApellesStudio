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
use serde::Deserialize;

use crate::args::WireArgs;
use crate::render;
use crate::server::ApellesMcp;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditorAddClipArgs {
    pub track: i64,
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
    eqActive}]}]}.

    `volume`/`pan` (D-223) are the CLIP's own level and stereo position, which
    MULTIPLY with the track's own `gain` rather than replacing it — see
    editor_set_clip_audio.

    `eqBands` (D-224) is that clip's own parametric EQ, `[]` when it has none;
    `eqActive` says whether ANY of those bands actually changes the sound. Read
    it: a four-band strip whose gains are all 0 dB is completely inert, and
    `eqBands` being non-empty is NOT the same as the clip being filtered. See
    editor_set_clip_eq.

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
            .set("track", p.track)
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
}

/// This tab's contribution to the merged router.
pub fn router() -> rmcp::handler::server::router::tool::ToolRouter<ApellesMcp> {
    ApellesMcp::edit_router()
}

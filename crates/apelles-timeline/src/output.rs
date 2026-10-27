//! Per-timeline output size and provenance (D-411 Phase 0,
//! `docs/notes/automatic-clipper.md` §5.1).
//!
//! **What it is.** Two optional, data-only facts a [`crate::Timeline`] can
//! carry about itself:
//!
//! - [`OutputSpec`] — the timeline's own composition size, overriding the
//!   project's D-038 `ProjectSettings {width, height}`. It is what lets a 9:16
//!   short and the 16:9 long-form it was cut from live in one project: every
//!   consumer that asks "how big is this timeline's frame" (the preview
//!   compositor, the canvas boundary, both export renderers, the FCPXML
//!   writer) reads the timeline's override first and the project's setting
//!   only when it is unset.
//! - [`TimelineOrigin`] — where a timeline came from when a tool built it
//!   (the Automatic Clipper's shorts and trailers): the run and proposal, the
//!   source, the source segments in order, and two hashes a later rebuild uses
//!   to refuse overwriting a person's edits.
//!
//! **What it does NOT do.** It resolves nothing on its own: this crate never
//! sees `ProjectSettings` (that type lives one layer up, in `apelles-project`)
//! and never probes media, so "override, else project, else the first clip"
//! is assembled by the caller (`chroma::edit::derived_composition_size`).
//! Nothing in this crate reads [`TimelineOrigin`]; in Phase 0 it is stored,
//! round-tripped and reported, and the clipper (Phase 1) is its first writer.
//!
//! **Backward compatibility is structural.** Both fields on `Timeline` are
//! `#[serde(default, skip_serializing_if = "Option::is_none")]`: a project
//! saved before D-411 has neither key, loads with both `None`, behaves exactly
//! as before, and is written back without either key — byte-for-byte the same
//! timeline object.

use serde::{Deserialize, Serialize};

/// The smallest output edge a timeline may declare, in pixels. Below this the
/// compositor's text and caption layout (sized as fractions of the frame
/// height) has nothing to lay out into, and no delivery format is this small.
pub const OUTPUT_MIN_EDGE: u32 = 16;

/// The largest output edge a timeline may declare, in pixels: 8K (DCI 8192).
/// The compositor allocates a full RGBA canvas at the composition size, so an
/// unbounded value is a request to allocate an unbounded buffer.
pub const OUTPUT_MAX_EDGE: u32 = 8192;

/// A timeline's own composition (output) size, in pixels.
///
/// **Even on both axes, always.** Every export encodes 4:2:0 H.264/HEVC, which
/// cannot represent an odd width or height; an odd size would compile and then
/// fail inside ffmpeg. [`OutputSpec::new`] is the one constructor that checks,
/// and every writer (the `set_timeline_output` op, the Tauri commands, the MCP
/// tools) goes through it or through its TypeScript mirror
/// (`checkTimelineOutput` in `@apelles/editor`'s `timeline.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutputSpec {
    pub width: u32,
    pub height: u32,
}

impl OutputSpec {
    /// A checked size: both edges inside
    /// [`OUTPUT_MIN_EDGE`]..=[`OUTPUT_MAX_EDGE`] and even. The error names the
    /// rule that failed, so a caller (an MCP agent above all) can fix it.
    pub fn new(width: u32, height: u32) -> Result<Self, String> {
        for (axis, v) in [("width", width), ("height", height)] {
            if !(OUTPUT_MIN_EDGE..=OUTPUT_MAX_EDGE).contains(&v) {
                return Err(format!(
                    "output {axis} must be between {OUTPUT_MIN_EDGE} and {OUTPUT_MAX_EDGE} pixels, got {v}"
                ));
            }
            if v % 2 != 0 {
                return Err(format!(
                    "output {axis} must be even (4:2:0 video cannot encode an odd {axis}), got {v}"
                ));
            }
        }
        Ok(Self { width, height })
    }

    /// `(width, height)` — the tuple every composition-size consumer takes.
    pub fn size(self) -> (u32, u32) {
        (self.width, self.height)
    }
}

/// What kind of tool built a timeline (D-411 §5.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TimelineOriginKind {
    /// One short built from a clip proposal.
    ClipShort,
    /// The trailer built from a clip run's beats.
    ClipTrailer,
}

/// What a built timeline was cut from: one media-pool item, or another
/// timeline of the same project. Serialised externally tagged —
/// `{"media_id": "…"}` or `{"timeline_id": "…"}` — the shape the design note
/// writes as `{media_id | timeline_id}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TimelineOriginSource {
    MediaId(String),
    TimelineId(String),
}

/// The role a source segment plays in a built timeline.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OriginSegmentRole {
    /// The opening hook (a short's flash-forward, a trailer's cold open).
    Hook,
    /// The body of a short.
    Body,
    /// One trailer beat.
    Beat,
}

/// One source range a built timeline plays, in build order. Source SECONDS of
/// the media file — not frames — because the design's transcript, sentence
/// and gate units are all in seconds, and a seconds range survives a change of
/// timeline frame rate.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OriginSegment {
    pub source_path: String,
    pub start_s: f64,
    pub end_s: f64,
    pub role: OriginSegmentRole,
}

/// Provenance of a tool-built timeline (D-411 §5.1). Data only in Phase 0.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TimelineOrigin {
    pub kind: TimelineOriginKind,
    /// The clip run (`clips/<run-id>.json`) that produced it.
    pub run_id: String,
    /// The proposal inside that run (empty for a trailer, which is built from
    /// several).
    #[serde(default)]
    pub proposal_id: String,
    pub source: TimelineOriginSource,
    #[serde(default)]
    pub segments: Vec<OriginSegment>,
    /// The moment view's `viewId` the proposal was judged against.
    #[serde(default)]
    pub built_at_view: String,
    /// Hash of the build settings (aspect, layout, captions preset, …), so a
    /// rebuild can tell "same settings" from "changed settings".
    #[serde(default)]
    pub settings_hash: String,
    /// Hash of the timeline's content right after the build. A rebuild whose
    /// current content no longer hashes to this refuses to overwrite it
    /// without an explicit choice (design §5.3).
    #[serde(default)]
    pub built_content_hash: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_spec_accepts_common_delivery_sizes() {
        for (w, h) in [
            (1080, 1920),
            (1920, 1080),
            (1080, 1080),
            (1080, 1350),
            (3840, 2160),
        ] {
            assert_eq!(OutputSpec::new(w, h).map(OutputSpec::size), Ok((w, h)));
        }
    }

    #[test]
    fn output_spec_refuses_odd_tiny_and_huge_edges_by_name() {
        let odd = OutputSpec::new(1081, 1920).expect_err("odd width");
        assert!(odd.contains("width") && odd.contains("even"), "{odd}");
        let odd_h = OutputSpec::new(1080, 1919).expect_err("odd height");
        assert!(odd_h.contains("height"), "{odd_h}");
        assert!(OutputSpec::new(8, 1920).is_err());
        assert!(OutputSpec::new(1920, OUTPUT_MAX_EDGE + 2).is_err());
        assert!(OutputSpec::new(OUTPUT_MIN_EDGE, OUTPUT_MAX_EDGE).is_ok());
    }

    #[test]
    fn origin_round_trips_in_the_designed_wire_shape() {
        let origin = TimelineOrigin {
            kind: TimelineOriginKind::ClipShort,
            run_id: "run-1".into(),
            proposal_id: "p-3".into(),
            source: TimelineOriginSource::MediaId("m-9".into()),
            segments: vec![OriginSegment {
                source_path: "/a.mov".into(),
                start_s: 12.5,
                end_s: 40.25,
                role: OriginSegmentRole::Hook,
            }],
            built_at_view: "view-abc".into(),
            settings_hash: "s".into(),
            built_content_hash: "c".into(),
        };
        let json = serde_json::to_value(&origin).expect("serialise");
        assert_eq!(json["kind"], "clip_short");
        assert_eq!(json["source"]["media_id"], "m-9");
        assert_eq!(json["segments"][0]["role"], "hook");
        let back: TimelineOrigin = serde_json::from_value(json).expect("deserialise");
        assert_eq!(back, origin);

        let trailer: TimelineOrigin = serde_json::from_str(
            r#"{"kind":"clip_trailer","run_id":"r","source":{"timeline_id":"t-1"}}"#,
        )
        .expect("minimal trailer origin");
        assert_eq!(trailer.kind, TimelineOriginKind::ClipTrailer);
        assert_eq!(
            trailer.source,
            TimelineOriginSource::TimelineId("t-1".into())
        );
        assert!(trailer.segments.is_empty());
    }
}

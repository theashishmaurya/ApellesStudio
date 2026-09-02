//! # chroma-grade-model — L2 domain model (D-039)
//!
//! **What it is:** the on-disk `grade.json` document (D-025) as typed Rust —
//! the versioned wrapper around `adjustments`, plus mask geometry, keyframes
//! (D-034), and the externalised matte references (`$matte` / `$trackDir` /
//! `$depthDir`, D-025).
//!
//! **Model, not renderer.** This crate is the *document*: parse, validate,
//! migrate, serialise. The crate that turns it into pixels is `chroma-grade`
//! (a future L1 crate that links the RapidRAW shader). The split mirrors
//! `chroma-timeline` (model) vs `chroma-compositor` (renderer).
//!
//! **What it does NOT do:** no `wgpu`, no `ffmpeg`, no GPU, no store. Pure
//! `serde` + `serde_json` over `chroma-types`.
//!
//! **Status:** D-039 migration step 1 skeleton — a `Grade` wrapper that mirrors
//! `grade.json` (D-025). The real document (adjustments schema, mask geometry,
//! keyframe tracks, the migration gate) is extracted from
//! `app/src-tauri/src/chroma/grade.rs` in a later, tracked step.

use serde::{Deserialize, Serialize};

/// The current `grade.json` schema tag. `chroma.grade/<major>`; a load migrates
/// `major == 1 | missing` and hard-errors a newer/unknown major (D-025).
pub const SCHEMA: &str = "chroma.grade/1";

/// The `grade.json` document. A versioned wrapper that embeds the RapidRAW
/// `adjustments` blob verbatim (D-025) and adds a schema tag, shot context, and
/// matte externalisation — it is deliberately **not** the ordered `stack`
/// model (that is the v2 node graph, D-005).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Grade {
    /// Schema tag — see [`SCHEMA`].
    pub schema: String,
    /// Shot context (source path, in/out) — advisory in v1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shot: Option<ShotRef>,
    /// The RapidRAW adjustments document, embedded verbatim.
    pub adjustments: serde_json::Value,
    /// Free-form grading notes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

impl Default for Grade {
    fn default() -> Self {
        Self {
            schema: SCHEMA.to_string(),
            shot: None,
            adjustments: serde_json::Value::Null,
            notes: None,
        }
    }
}

/// Which clip a grade was authored against.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ShotRef {
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub in_frame: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub out_frame: Option<i64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_builds() {
        let g = Grade::default();
        let json = serde_json::to_string(&g).unwrap();
        let back: Grade = serde_json::from_str(&json).unwrap();
        assert_eq!(back.schema, SCHEMA);
    }
}

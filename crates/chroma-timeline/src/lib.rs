//! # chroma-timeline — L2 domain model (D-039)
//!
//! **What it is:** the edit model for the Editing tab — an ordered set of
//! tracks, each a sequence of clips and gaps, plus the edit operations
//! (ripple / roll / slip / slide, trim, split) and the transcript→EDL builder.
//!
//! **Shape:** OTIO-shaped (OpenTimelineIO's data model), serialised with
//! `serde` to/from OTIO-compatible JSON — the C bindings are deliberately *not*
//! used (D-039).
//!
//! **What it does NOT do:** no `wgpu`, no `ffmpeg`, no rendering, no
//! compositing. It only depends on `chroma-types`. The compositor
//! (`chroma-compositor`, a future crate) reads this model to produce frames;
//! this crate never reaches down to pixels.
//!
//! **Status:** D-039 migration step 1 skeleton — a minimal
//! `Timeline` / `Track` / `Clip` shape. Edit ops + transcript→EDL land in a
//! later, tracked step.

use serde::{Deserialize, Serialize};

use chroma_types::Rational;

/// The whole edit — every track, top to bottom.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Timeline {
    pub name: String,
    /// Output timebase (frame rate) for the assembled edit.
    pub rate: Option<Rational>,
    pub tracks: Vec<Track>,
}

/// One track: a typed, ordered lane of clips.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Track {
    pub kind: TrackKind,
    pub clips: Vec<Clip>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrackKind {
    #[default]
    Video,
    Audio,
}

/// A single clip — a windowed reference into a source media file, placed on a
/// track. Timeline position is implicit from clip order + `Gap`s (OTIO-shaped);
/// `source_start` / `duration` are in source frames.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Clip {
    pub name: String,
    pub source_path: String,
    pub source_start: i64,
    pub duration: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_builds() {
        let t = Timeline {
            name: "demo".into(),
            rate: Some(Rational::new(24, 1)),
            tracks: vec![Track {
                kind: TrackKind::Video,
                clips: vec![Clip {
                    name: "A001".into(),
                    source_path: "/tmp/a001.mov".into(),
                    source_start: 0,
                    duration: 240,
                }],
            }],
        };
        let json = serde_json::to_string(&t).unwrap();
        let back: Timeline = serde_json::from_str(&json).unwrap();
        assert_eq!(back.tracks.len(), 1);
        assert_eq!(back.tracks[0].clips[0].duration, 240);
    }
}

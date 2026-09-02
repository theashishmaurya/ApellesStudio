//! # chroma-timeline — L2 domain model (D-039)
//!
//! **What it is:** the edit model for the Editing tab — an ordered set of
//! tracks, each a sequence of clips, plus the edit operations (reorder, trim,
//! split, remove) and a builder that assembles a timeline from a project's
//! shots.
//!
//! **Shape:** OTIO-*shaped* (OpenTimelineIO's data model — tracks of clips,
//! each clip a windowed reference into a source), but serialised as our own
//! plain `serde` JSON for v1. A real OTIO-compatible `.otio` exporter is a
//! **later, tracked step** (see D-041); the C bindings are deliberately not
//! used (D-039).
//!
//! **What it does NOT do:** no `wgpu`, no `ffmpeg`, no rendering, no
//! compositing, no media probing. It only depends on `chroma-types`. Callers
//! supply source frame counts (from a probe); this crate never reaches media.
//! The MVP (D-041) is single-video-track; multi-track / audio / transitions /
//! ripple-roll-slip-slide / transcript→EDL land in later steps.
//!
//! **Status:** D-041 — the MVP edit model: `Timeline::from_shots`, position
//! helpers (`Track::clip_at`, `Timeline::duration`) and the edit ops
//! (`reorder` / `trim_start` / `trim_end` / `split` / `remove`), each
//! unit-tested.

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
/// track. Timeline position is implicit from clip order (clips are back to
/// back — the MVP has no gaps); `source_start` / `duration` are in **source
/// frames**, and `source_len` is the source's total frame count so a trim can
/// never run past the media.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Clip {
    /// Stable id — survives reorder / trim; a `split` gives the new half a
    /// derived id. Lets the UI key a clip across a `get`→edit→`get` cycle.
    #[serde(default)]
    pub id: String,
    /// Back-link to the `ProjectShot` this clip came from (`from_shots`), if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shot_id: Option<String>,
    pub name: String,
    pub source_path: String,
    pub source_start: i64,
    pub duration: i64,
    /// Total frame count of the source media — the ceiling for trims / extends.
    #[serde(default)]
    pub source_len: i64,
}

impl Clip {
    /// The exclusive upper bound for `source_start + duration`.
    fn source_ceiling(&self) -> i64 {
        self.source_len.max(0)
    }
}

/// Edit-op failures. All are caller errors (bad index, a trim that would empty
/// a clip, a split outside a clip) — none are I/O.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum TimelineError {
    #[error("track index {0} out of range")]
    NoSuchTrack(usize),
    #[error("clip index {0} out of range on track {1}")]
    NoSuchClip(usize, usize),
    #[error("index {0} out of range")]
    BadIndex(usize),
    #[error("a clip must keep at least one frame")]
    EmptyClip,
    #[error("timeline frame {0} is not inside clip {1}")]
    SplitOutsideClip(i64, usize),
}

impl Timeline {
    /// Build a single-video-track timeline from a project's shots, each shot a
    /// full-length clip laid back to back in order. `shots` is
    /// `(shot_id, source_path, name, source_frame_count)` — the caller probes
    /// each source for its frame count (this crate never touches media).
    pub fn from_shots(shots: &[(String, String, String, i64)]) -> Timeline {
        let clips = shots
            .iter()
            .map(|(id, path, name, frames)| {
                let len = (*frames).max(0);
                Clip {
                    id: id.clone(),
                    shot_id: Some(id.clone()),
                    name: name.clone(),
                    source_path: path.clone(),
                    source_start: 0,
                    duration: len.max(1),
                    source_len: len,
                }
            })
            .collect();
        Timeline {
            name: String::new(),
            rate: None,
            tracks: vec![Track {
                kind: TrackKind::Video,
                clips,
            }],
        }
    }

    /// Total timeline length in frames — the longest track.
    pub fn duration(&self) -> i64 {
        self.tracks.iter().map(Track::duration).max().unwrap_or(0)
    }

    fn track_mut(&mut self, track: usize) -> Result<&mut Track, TimelineError> {
        self.tracks
            .get_mut(track)
            .ok_or(TimelineError::NoSuchTrack(track))
    }

    /// Move the clip at `from_idx` to `to_idx` on `track` (both are positions in
    /// the current clip order).
    pub fn reorder(
        &mut self,
        track: usize,
        from_idx: usize,
        to_idx: usize,
    ) -> Result<(), TimelineError> {
        let t = self.track_mut(track)?;
        let n = t.clips.len();
        if from_idx >= n {
            return Err(TimelineError::BadIndex(from_idx));
        }
        if to_idx >= n {
            return Err(TimelineError::BadIndex(to_idx));
        }
        if from_idx == to_idx {
            return Ok(());
        }
        let clip = t.clips.remove(from_idx);
        t.clips.insert(to_idx, clip);
        Ok(())
    }

    /// Trim (`delta > 0`) or extend (`delta < 0`) the head of a clip: shift
    /// `source_start` by `delta` and shorten `duration` by the same, clamped so
    /// the clip stays inside `[0, source_len]` and keeps ≥ 1 frame.
    pub fn trim_start(
        &mut self,
        track: usize,
        clip_idx: usize,
        delta: i64,
    ) -> Result<(), TimelineError> {
        let t = self.track_mut(track)?;
        let clip = t
            .clips
            .get_mut(clip_idx)
            .ok_or(TimelineError::NoSuchClip(clip_idx, track))?;
        let ceiling = clip.source_ceiling();
        // clamp the new head to the media bounds; a delta that would push it
        // onto or past the clip's own tail empties the clip → error.
        let new_start = (clip.source_start + delta).clamp(0, (ceiling - 1).max(0));
        let new_dur = clip.duration - (new_start - clip.source_start);
        if new_dur < 1 {
            return Err(TimelineError::EmptyClip);
        }
        clip.source_start = new_start;
        clip.duration = new_dur;
        Ok(())
    }

    /// Trim (`delta < 0`) or extend (`delta > 0`) the tail of a clip: change
    /// `duration` by `delta`, clamped so the clip keeps ≥ 1 frame and does not
    /// run past `source_len`.
    pub fn trim_end(
        &mut self,
        track: usize,
        clip_idx: usize,
        delta: i64,
    ) -> Result<(), TimelineError> {
        let t = self.track_mut(track)?;
        let clip = t
            .clips
            .get_mut(clip_idx)
            .ok_or(TimelineError::NoSuchClip(clip_idx, track))?;
        let max_dur = (clip.source_ceiling() - clip.source_start).max(1);
        let new_dur = (clip.duration + delta).clamp(1, max_dur);
        clip.duration = new_dur;
        Ok(())
    }

    /// Split the clip that spans `at_timeline_frame` into two back-to-back
    /// clips. `at_timeline_frame` must land strictly inside `clip_idx` (not on
    /// either edge).
    pub fn split(
        &mut self,
        track: usize,
        clip_idx: usize,
        at_timeline_frame: i64,
    ) -> Result<(), TimelineError> {
        let t = self.track_mut(track)?;
        if clip_idx >= t.clips.len() {
            return Err(TimelineError::NoSuchClip(clip_idx, track));
        }
        let clip_start = t.clips[..clip_idx].iter().map(|c| c.duration).sum::<i64>();
        let offset = at_timeline_frame - clip_start;
        let clip = &t.clips[clip_idx];
        if offset <= 0 || offset >= clip.duration {
            return Err(TimelineError::SplitOutsideClip(at_timeline_frame, clip_idx));
        }
        let mut right = clip.clone();
        right.id = format!("{}·{}", clip.id, at_timeline_frame);
        right.source_start = clip.source_start + offset;
        right.duration = clip.duration - offset;

        let left = &mut t.clips[clip_idx];
        left.duration = offset;
        t.clips.insert(clip_idx + 1, right);
        Ok(())
    }

    /// Remove the clip at `clip_idx` on `track`.
    pub fn remove(&mut self, track: usize, clip_idx: usize) -> Result<(), TimelineError> {
        let t = self.track_mut(track)?;
        if clip_idx >= t.clips.len() {
            return Err(TimelineError::NoSuchClip(clip_idx, track));
        }
        t.clips.remove(clip_idx);
        Ok(())
    }
}

impl Track {
    /// Length of this track in frames (clips are back to back).
    pub fn duration(&self) -> i64 {
        self.clips.iter().map(|c| c.duration).sum()
    }

    /// The clip covering `timeline_frame` and the matching **source** frame
    /// inside it, walking clips and accumulating durations. `None` if the
    /// position is past the end (or negative).
    pub fn clip_at(&self, timeline_frame: i64) -> Option<(&Clip, i64)> {
        if timeline_frame < 0 {
            return None;
        }
        let mut acc = 0i64;
        for clip in &self.clips {
            if timeline_frame < acc + clip.duration {
                let into = timeline_frame - acc;
                return Some((clip, clip.source_start + into));
            }
            acc += clip.duration;
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shots() -> Vec<(String, String, String, i64)> {
        vec![
            ("s1".into(), "/a.mov".into(), "A".into(), 100),
            ("s2".into(), "/b.mov".into(), "B".into(), 50),
            ("s3".into(), "/c.mov".into(), "C".into(), 200),
        ]
    }

    #[test]
    fn it_builds() {
        let t = Timeline::from_shots(&shots());
        assert_eq!(t.tracks.len(), 1);
        assert_eq!(t.tracks[0].clips.len(), 3);
        assert_eq!(t.tracks[0].clips[0].duration, 100);
        assert_eq!(t.tracks[0].clips[1].shot_id.as_deref(), Some("s2"));
        assert_eq!(t.duration(), 350);
    }

    #[test]
    fn serde_round_trips() {
        let t = Timeline::from_shots(&shots());
        let json = serde_json::to_string(&t).unwrap();
        let back: Timeline = serde_json::from_str(&json).unwrap();
        assert_eq!(back.tracks[0].clips[2].name, "C");
        assert_eq!(back.tracks[0].clips[2].source_len, 200);
        assert_eq!(back.duration(), 350);
    }

    #[test]
    fn legacy_clip_json_without_new_fields_loads() {
        let j = r#"{"name":"x","tracks":[{"kind":"video","clips":[
            {"name":"old","source_path":"/o.mov","source_start":10,"duration":40}]}]}"#;
        let t: Timeline = serde_json::from_str(j).unwrap();
        let c = &t.tracks[0].clips[0];
        assert_eq!(c.id, "");
        assert_eq!(c.source_len, 0);
        assert_eq!(c.duration, 40);
    }

    #[test]
    fn clip_at_walks_durations() {
        let t = Timeline::from_shots(&shots());
        let tr = &t.tracks[0];
        assert_eq!(
            tr.clip_at(0).map(|(c, f)| (c.name.as_str(), f)),
            Some(("A", 0))
        );
        assert_eq!(
            tr.clip_at(99).map(|(c, f)| (c.name.as_str(), f)),
            Some(("A", 99))
        );
        assert_eq!(
            tr.clip_at(100).map(|(c, f)| (c.name.as_str(), f)),
            Some(("B", 0))
        );
        assert_eq!(
            tr.clip_at(149).map(|(c, f)| (c.name.as_str(), f)),
            Some(("B", 49))
        );
        assert_eq!(
            tr.clip_at(150).map(|(c, f)| (c.name.as_str(), f)),
            Some(("C", 0))
        );
        assert_eq!(
            tr.clip_at(349).map(|(c, f)| (c.name.as_str(), f)),
            Some(("C", 199))
        );
        assert!(tr.clip_at(350).is_none());
        assert!(tr.clip_at(-1).is_none());
    }

    #[test]
    fn reorder_moves_a_clip() {
        let mut t = Timeline::from_shots(&shots());
        t.reorder(0, 0, 2).unwrap();
        let names: Vec<_> = t.tracks[0].clips.iter().map(|c| c.name.clone()).collect();
        assert_eq!(names, vec!["B", "C", "A"]);
        assert_eq!(t.reorder(0, 5, 0), Err(TimelineError::BadIndex(5)));
        assert_eq!(t.reorder(9, 0, 0), Err(TimelineError::NoSuchTrack(9)));
    }

    #[test]
    fn trim_start_clamps_and_shortens() {
        let mut t = Timeline::from_shots(&shots());
        t.trim_start(0, 0, 20).unwrap();
        let c = &t.tracks[0].clips[0];
        assert_eq!((c.source_start, c.duration), (20, 80));
        // extend back past 0 clamps
        t.trim_start(0, 0, -100).unwrap();
        let c = &t.tracks[0].clips[0];
        assert_eq!((c.source_start, c.duration), (0, 100));
        // a head trim that would push past the clip's own (already shortened)
        // tail empties it → error
        t.trim_end(0, 1, -40).unwrap(); // clip B: dur 50 -> 10
        assert_eq!(t.trim_start(0, 1, 10), Err(TimelineError::EmptyClip));
        assert_eq!(t.trim_start(0, 1, 25), Err(TimelineError::EmptyClip));
        // a head trim within the shortened clip still works
        t.trim_start(0, 1, 5).unwrap();
        assert_eq!(
            (
                t.tracks[0].clips[1].source_start,
                t.tracks[0].clips[1].duration
            ),
            (5, 5)
        );
    }

    #[test]
    fn trim_end_clamps_to_media() {
        let mut t = Timeline::from_shots(&shots());
        t.trim_end(0, 0, -30).unwrap();
        assert_eq!(t.tracks[0].clips[0].duration, 70);
        // can't extend past source_len (100)
        t.trim_end(0, 0, 999).unwrap();
        assert_eq!(t.tracks[0].clips[0].duration, 100);
        assert_eq!(t.trim_end(0, 9, 1), Err(TimelineError::NoSuchClip(9, 0)));
    }

    #[test]
    fn split_makes_two_clips() {
        let mut t = Timeline::from_shots(&shots());
        // clip B spans timeline [100, 150); split at 120
        t.split(0, 1, 120).unwrap();
        assert_eq!(t.tracks[0].clips.len(), 4);
        let b1 = &t.tracks[0].clips[1];
        let b2 = &t.tracks[0].clips[2];
        assert_eq!((b1.source_start, b1.duration), (0, 20));
        assert_eq!((b2.source_start, b2.duration), (20, 30));
        assert_eq!(b2.name, "B");
        assert_ne!(b1.id, b2.id);
        assert_eq!(t.duration(), 350, "split preserves total length");
        // on an edge → error
        assert!(matches!(
            t.split(0, 0, 0),
            Err(TimelineError::SplitOutsideClip(0, 0))
        ));
    }

    #[test]
    fn remove_drops_a_clip() {
        let mut t = Timeline::from_shots(&shots());
        t.remove(0, 1).unwrap();
        let names: Vec<_> = t.tracks[0].clips.iter().map(|c| c.name.clone()).collect();
        assert_eq!(names, vec!["A", "C"]);
        assert_eq!(t.duration(), 300);
        assert_eq!(t.remove(0, 9), Err(TimelineError::NoSuchClip(9, 0)));
    }
}

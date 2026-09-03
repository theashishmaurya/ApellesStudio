//! # chroma-timeline — L2 domain model (D-039)
//!
//! **What it is:** the edit model for the Editing tab — an ordered set of
//! tracks, each a sequence of clips, plus the edit operations (reorder, trim,
//! split, remove, plus track management and cross-track moves) and a builder
//! that assembles a timeline from a project's shots.
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
//! **Multi-track / multi-position status (D-054, Phase A of
//! `docs/notes/multi-track-nle.md`):** the model itself can now represent
//! more than one track and gaps between clips (`Clip::start_frame`,
//! `add_track`/`remove_track`/`move_clip`) — but nothing in the app populates
//! a second track or a gap yet (`Timeline::from_shots` still lays one video
//! track's clips back to back). N-track compositing/rendering, audio mixing,
//! and the multi-track UI are separate, later phases (B/C/D) — see that note.
//!
//! **Opaque top-wins video-track resolution (D-056, Phase B1):**
//! `Timeline::resolve_video_clip_at` picks which single video track/clip is
//! showing at a position — video tracks in index order (lower index = higher
//! priority), first one with a clip (not a gap) there wins, falling through
//! to a lower-priority track only on a gap. This crate still does no
//! rendering/compositing of its own (that stays media-layer work in
//! `app/src-tauri`); this method only adds the **selection** logic, which
//! turned out to be all "opaque, top wins" needs — there's no pixel blending
//! to compute when the winner fully obscures everything below it. Real
//! multi-texture GPU blending is Phase B3.
//!
//! **Status:** D-041 — the MVP edit model: `Timeline::from_shots`, position
//! helpers (`Track::clip_at`, `Timeline::duration`) and the edit ops
//! (`reorder` / `trim_start` / `trim_end` / `split` / `remove`), each
//! unit-tested. D-045 (pass 2 of the media-pool/timelines roadmap item) added
//! `Timeline::id` so a project can hold several independently-editable named
//! timelines (`ProjectManifest.timelines: Vec<Timeline>`) with one active —
//! this crate itself stays single-timeline-shaped; multi-timeline is purely
//! a `Vec<Timeline>` one layer up, in `chroma::project` / `chroma::edit`
//! (`app/src-tauri`). No id generation here (would need a dependency this
//! pure crate doesn't have, e.g. `uuid`) — callers set `id` on creation, the
//! same way `build_from_shots` already sets `name`. D-054 (Phase A) gave
//! `Clip` an explicit `start_frame`, added `add_track` / `remove_track` /
//! `move_clip`, and a `backfill_legacy_positions` migration for pre-D-054
//! `project.json` files whose clips have no position field.

use serde::{Deserialize, Serialize};

use chroma_types::Rational;

/// The whole edit — every track, top to bottom.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Timeline {
    /// Stable id — how a project's `timelines` list and `active_timeline`
    /// selection (D-045) reference a specific timeline. Empty string on a
    /// `Timeline` built directly (e.g. in a test) or deserialized from
    /// pre-D-045 JSON that never had this field; callers that persist a
    /// timeline are expected to assign a real one (see
    /// `chroma::edit::build_from_shots` / `chroma_timeline_create`).
    #[serde(default)]
    pub id: String,
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

/// Sentinel `start_frame` value observed only transiently, right after
/// deserializing a pre-D-054 `project.json` clip that never had the field —
/// never a real position. Not part of the public API; callers detect "needs
/// migration" by calling `backfill_legacy_positions`, not by comparing
/// against this constant themselves.
const LEGACY_MISSING_START: i64 = i64::MIN;

fn legacy_missing_start() -> i64 {
    LEGACY_MISSING_START
}

/// A single clip — a windowed reference into a source media file, placed on a
/// track at an explicit timeline position (D-054). `source_start` /
/// `duration` are in **source frames**; `start_frame` is in **timeline**
/// frames, absolute within its timeline (not track-relative — a clip's
/// position doesn't depend on which track it's on, which is what makes
/// `move_clip` a plain field write rather than a coordinate conversion).
/// `source_len` is the source's total frame count so a trim can never run
/// past the media.
///
/// **Position model (D-054):** clips on a track are no longer forced back to
/// back — `start_frame` can leave a gap before a clip (`Track::clip_at`
/// returns `None` for a query landing in one) and clips on the same track
/// must never overlap (`trim_start`/`trim_end`/`move_clip` all enforce this).
/// `Track.clips`' Vec order is *not* required to match position order — it's
/// bookkeeping order only (see `Timeline::reorder`'s doc); every op that
/// needs "the clip before/after this one in time" scans by `start_frame`,
/// never by Vec index.
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
    /// Timeline-absolute start frame (D-054). The `#[serde(default = ...)]`
    /// here is a **migration sentinel**, not a real default: legacy JSON with
    /// no `start_frame` key deserializes to `i64::MIN`, which
    /// `Track::backfill_legacy_positions` / `Timeline::backfill_legacy_positions`
    /// then replace with a reconstructed back-to-back position — the exact
    /// layout that clip rendered at before D-054, since every pre-D-054
    /// track was strictly back to back by construction. A freshly-authored
    /// or already-migrated project always serializes a real value here (the
    /// field isn't `Option`/`skip_serializing_if`), so the sentinel is only
    /// ever observed transiently, right after `serde_json::from_*`, before a
    /// caller runs the backfill.
    #[serde(default = "legacy_missing_start")]
    pub start_frame: i64,
}

impl Clip {
    /// The exclusive upper bound for `source_start + duration`.
    fn source_ceiling(&self) -> i64 {
        self.source_len.max(0)
    }

    /// The exclusive upper bound of this clip's occupied timeline range.
    fn end_frame(&self) -> i64 {
        self.start_frame + self.duration
    }
}

/// Edit-op failures. All are caller errors (bad index, a trim that would empty
/// a clip, a split outside a clip, a move that would overlap) — none are I/O.
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
    #[error("timeline position {0} is negative")]
    NegativePosition(i64),
    #[error("moving this clip to track {0} at frame {1} would overlap an existing clip there")]
    Overlap(usize, i64),
}

impl Timeline {
    /// Build a single-video-track timeline from a project's shots, each shot a
    /// full-length clip laid back to back in order. `shots` is
    /// `(shot_id, source_path, name, source_frame_count)` — the caller probes
    /// each source for its frame count (this crate never touches media).
    pub fn from_shots(shots: &[(String, String, String, i64)]) -> Timeline {
        let mut acc = 0i64;
        let clips = shots
            .iter()
            .map(|(id, path, name, frames)| {
                let len = (*frames).max(0);
                let duration = len.max(1);
                let start_frame = acc;
                acc += duration;
                Clip {
                    id: id.clone(),
                    shot_id: Some(id.clone()),
                    name: name.clone(),
                    source_path: path.clone(),
                    source_start: 0,
                    duration,
                    source_len: len,
                    start_frame,
                }
            })
            .collect();
        Timeline {
            id: String::new(),
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

    /// Resolve timeline position `pos` under **opaque, top-track-wins**
    /// compositing (D-056, Phase B1 of `docs/notes/multi-track-nle.md`):
    /// video tracks are checked in priority order — **`tracks` index order,
    /// lower index = higher priority** ("on top") — and the first one whose
    /// `Track::clip_at(pos)` returns `Some` (a real clip there, not a gap)
    /// wins outright. For purely opaque compositing there is no pixel-level
    /// blend to compute: this is a track-**selection** problem, not a
    /// rendering one, so the result is just "which single track/clip is
    /// showing," never a merge of two. Falls through to the next
    /// lower-priority video track only when a higher one has a gap at this
    /// exact position; returns `None` once every video track has a gap (or
    /// there are no video tracks at all) at `pos`.
    ///
    /// Deterministic by construction: iterates `self.tracks` (a `Vec`, not a
    /// `HashMap`) in its stored order every time — no hidden
    /// iteration-order dependency.
    ///
    /// Returns `(track_index, clip, source_frame)` — the track index lets a
    /// caller report/log which track actually won, though nothing in this
    /// crate needs it for the resolution itself.
    pub fn resolve_video_clip_at(&self, pos: i64) -> Option<(usize, &Clip, i64)> {
        self.tracks
            .iter()
            .enumerate()
            .filter(|(_, t)| t.kind == TrackKind::Video)
            .find_map(|(i, t)| t.clip_at(pos).map(|(c, sf)| (i, c, sf)))
    }

    /// Reconstruct real positions for any clip loaded from pre-D-054 JSON
    /// that had no `start_frame` field at all (see `Clip::start_frame`'s
    /// doc). Safe — and a no-op — to call on an already-migrated or
    /// freshly-built timeline: only clips still carrying the migration
    /// sentinel are touched. Callers that deserialize a `Timeline` from
    /// persisted JSON (`chroma::project::load_manifest`) are expected to
    /// call this once, right after `serde_json::from_*`.
    pub fn backfill_legacy_positions(&mut self) {
        for track in &mut self.tracks {
            track.backfill_legacy_positions();
        }
    }

    fn track_mut(&mut self, track: usize) -> Result<&mut Track, TimelineError> {
        self.tracks
            .get_mut(track)
            .ok_or(TimelineError::NoSuchTrack(track))
    }

    /// Add a new, empty track of `kind`, appended after the last existing
    /// track. Returns its index.
    pub fn add_track(&mut self, kind: TrackKind) -> usize {
        self.tracks.push(Track {
            kind,
            clips: Vec::new(),
        });
        self.tracks.len() - 1
    }

    /// Remove the track at `track`, **including every clip on it** — a track
    /// with clips is not protected or emptied-then-kept, it's just gone
    /// (recovery is the caller's job, e.g. undo — D-052 — not a special case
    /// here). Errors (leaving `tracks` unchanged) for an out-of-range index.
    pub fn remove_track(&mut self, track: usize) -> Result<(), TimelineError> {
        if track >= self.tracks.len() {
            return Err(TimelineError::NoSuchTrack(track));
        }
        self.tracks.remove(track);
        Ok(())
    }

    /// Move the clip at `(from_track, from_idx)` onto `to_track` at
    /// timeline-absolute `to_start_frame`, keeping its id / duration /
    /// source window unchanged (only `start_frame`, and implicitly which
    /// track it's on, change). Works for a same-track reposition too
    /// (`from_track == to_track`) — this is the general "place this clip
    /// here" primitive; `reorder` (Vec-order only) does not move clips in
    /// time.
    ///
    /// Errors, none of which mutate the timeline: `NoSuchTrack`/`NoSuchClip`
    /// for an out-of-range source or destination track/clip index,
    /// `NegativePosition` for `to_start_frame < 0`, `Overlap` if the
    /// destination range would intersect any *other* clip already on
    /// `to_track` (the clip being moved never counts as overlapping itself).
    pub fn move_clip(
        &mut self,
        from_track: usize,
        from_idx: usize,
        to_track: usize,
        to_start_frame: i64,
    ) -> Result<(), TimelineError> {
        if to_start_frame < 0 {
            return Err(TimelineError::NegativePosition(to_start_frame));
        }
        let src = self
            .tracks
            .get(from_track)
            .ok_or(TimelineError::NoSuchTrack(from_track))?;
        let clip = src
            .clips
            .get(from_idx)
            .ok_or(TimelineError::NoSuchClip(from_idx, from_track))?;
        let duration = clip.duration;
        let new_end = to_start_frame + duration;

        let dest = self
            .tracks
            .get(to_track)
            .ok_or(TimelineError::NoSuchTrack(to_track))?;
        let overlaps = dest.clips.iter().enumerate().any(|(i, c)| {
            if from_track == to_track && i == from_idx {
                return false; // the clip being moved never overlaps itself
            }
            to_start_frame < c.end_frame() && new_end > c.start_frame
        });
        if overlaps {
            return Err(TimelineError::Overlap(to_track, to_start_frame));
        }

        let mut clip = self.tracks[from_track].clips.remove(from_idx);
        clip.start_frame = to_start_frame;
        self.tracks[to_track].clips.push(clip);
        Ok(())
    }

    /// Change the **Vec storage order** of the two clips at `from_idx`/
    /// `to_idx` on `track` — a list splice, exactly the same operation this
    /// had before D-054. **Does not move either clip in time**
    /// (`start_frame` is untouched): before D-054, a clip's timeline position
    /// was *implicit* from Vec order (clips summed strictly back to back), so
    /// splicing the Vec was how you moved a clip in time. Now that position
    /// is an explicit field owned by the clip, Vec order is just bookkeeping
    /// (e.g. UI list/display order) — `move_clip` is the op that actually
    /// repositions a clip.
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
    /// `source_start` **and** `start_frame` by `delta` and shorten `duration`
    /// by the same — the clip's *end* stays fixed on the timeline, its start
    /// (both source in-point and timeline position) slides, matching a
    /// normal NLE left-edge trim. Clamped so the source window stays inside
    /// `[0, source_len]`, keeps ≥ 1 frame, and (D-054) `start_frame` never
    /// moves earlier than the end of the nearest preceding clip on the same
    /// track (extending left can shrink a gap before it, never overlap it) —
    /// trimming right (`delta > 0`) only ever opens a gap before the clip,
    /// which can't violate that bound.
    pub fn trim_start(
        &mut self,
        track: usize,
        clip_idx: usize,
        delta: i64,
    ) -> Result<(), TimelineError> {
        let t = self.track_mut(track)?;
        if clip_idx >= t.clips.len() {
            return Err(TimelineError::NoSuchClip(clip_idx, track));
        }
        let (ceiling, cur_source_start, cur_start_frame, cur_duration) = {
            let c = &t.clips[clip_idx];
            (
                c.source_ceiling(),
                c.source_start,
                c.start_frame,
                c.duration,
            )
        };
        // nearest preceding clip's end on this track (0 if none)
        let prev_end = t
            .clips
            .iter()
            .enumerate()
            .filter(|(i, c)| *i != clip_idx && c.end_frame() <= cur_start_frame)
            .map(|(_, c)| c.end_frame())
            .max()
            .unwrap_or(0);

        // clamp delta so the new source_start stays in [0, ceiling-1]...
        let mut d = delta.clamp(-cur_source_start, (ceiling - 1).max(0) - cur_source_start);
        // ...and so the new start_frame never moves before the preceding clip's end.
        d = d.max(prev_end - cur_start_frame);

        let new_source_start = cur_source_start + d;
        let new_start_frame = cur_start_frame + d;
        let new_dur = cur_duration - d;
        if new_dur < 1 {
            return Err(TimelineError::EmptyClip);
        }
        let clip = &mut t.clips[clip_idx];
        clip.source_start = new_source_start;
        clip.start_frame = new_start_frame;
        clip.duration = new_dur;
        Ok(())
    }

    /// Trim (`delta < 0`) or extend (`delta > 0`) the tail of a clip: change
    /// `duration` by `delta` — `start_frame` is untouched (the clip's *start*
    /// stays fixed, its end slides), clamped so the clip keeps ≥ 1 frame,
    /// does not run past `source_len`, and (D-054) never grows past the
    /// `start_frame` of the nearest following clip on the same track (no
    /// overlap) — shrinking only ever opens/grows a gap after the clip.
    pub fn trim_end(
        &mut self,
        track: usize,
        clip_idx: usize,
        delta: i64,
    ) -> Result<(), TimelineError> {
        let t = self.track_mut(track)?;
        if clip_idx >= t.clips.len() {
            return Err(TimelineError::NoSuchClip(clip_idx, track));
        }
        let (ceiling, source_start, start_frame, duration) = {
            let c = &t.clips[clip_idx];
            (
                c.source_ceiling(),
                c.source_start,
                c.start_frame,
                c.duration,
            )
        };
        let max_dur_source = (ceiling - source_start).max(1);
        // nearest following clip's start on this track, if any
        let next_start = t
            .clips
            .iter()
            .enumerate()
            .filter(|(i, c)| *i != clip_idx && c.start_frame >= start_frame)
            .map(|(_, c)| c.start_frame)
            .min();
        let max_dur_position = next_start
            .map(|s| (s - start_frame).max(1))
            .unwrap_or(i64::MAX);
        let max_dur = max_dur_source.min(max_dur_position).max(1);

        let new_dur = (duration + delta).clamp(1, max_dur);
        t.clips[clip_idx].duration = new_dur;
        Ok(())
    }

    /// Split the clip that spans `at_timeline_frame` into two back-to-back
    /// clips (the right half starts exactly where the left half now ends —
    /// splitting never introduces a gap). `at_timeline_frame` must land
    /// strictly inside `clip_idx` (not on either edge).
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
        let clip = &t.clips[clip_idx];
        let offset = at_timeline_frame - clip.start_frame;
        if offset <= 0 || offset >= clip.duration {
            return Err(TimelineError::SplitOutsideClip(at_timeline_frame, clip_idx));
        }
        let mut right = clip.clone();
        right.id = format!("{}·{}", clip.id, at_timeline_frame);
        right.start_frame = clip.start_frame + offset;
        right.source_start = clip.source_start + offset;
        right.duration = clip.duration - offset;

        let left = &mut t.clips[clip_idx];
        left.duration = offset;
        t.clips.insert(clip_idx + 1, right);
        Ok(())
    }

    /// Remove the clip at `clip_idx` on `track`. Unlike a "ripple delete",
    /// nothing else on the track moves (D-054: positions are explicit now) —
    /// this simply opens (or grows) a gap where the clip used to be.
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
    /// Length of this track in frames — the furthest clip end, since clips
    /// may now (D-054) leave a trailing gap before the track's nominal end,
    /// and there's nothing to render past the last clip either way.
    pub fn duration(&self) -> i64 {
        self.clips.iter().map(Clip::end_frame).max().unwrap_or(0)
    }

    /// The clip covering `timeline_frame` and the matching **source** frame
    /// inside it. `None` if the position is negative, past every clip's end,
    /// or (D-054) lands inside a gap between clips — the same "nothing here"
    /// result for all three, which is what every caller (the preview decode
    /// path) already treats identically.
    pub fn clip_at(&self, timeline_frame: i64) -> Option<(&Clip, i64)> {
        if timeline_frame < 0 {
            return None;
        }
        self.clips
            .iter()
            .find(|c| timeline_frame >= c.start_frame && timeline_frame < c.end_frame())
            .map(|c| (c, c.source_start + (timeline_frame - c.start_frame)))
    }

    /// See `Timeline::backfill_legacy_positions` — the per-track half of
    /// that migration. Walks clips in **Vec order**, which for any wholly
    /// pre-D-054 track is the same order `clip_at`'s old cumulative-duration
    /// walk used, so accumulating durations here reconstructs the exact
    /// positions that track rendered at before D-054. A clip that already
    /// carries a real `start_frame` (any already-migrated or freshly-built
    /// track) is left untouched, and the running accumulator continues from
    /// its real value — so a mix of real and legacy-sentinel clips (not a
    /// shape this codebase ever produces, but not unsafe either) still ends
    /// up gap-consistent rather than corrupted.
    fn backfill_legacy_positions(&mut self) {
        let mut acc = 0i64;
        for clip in &mut self.clips {
            if clip.start_frame == LEGACY_MISSING_START {
                clip.start_frame = acc;
            }
            acc = clip.start_frame + clip.duration;
        }
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
    fn from_shots_lays_clips_back_to_back() {
        let t = Timeline::from_shots(&shots());
        let starts: Vec<i64> = t.tracks[0].clips.iter().map(|c| c.start_frame).collect();
        assert_eq!(starts, vec![0, 100, 150]);
    }

    #[test]
    fn serde_round_trips() {
        let t = Timeline::from_shots(&shots());
        let json = serde_json::to_string(&t).unwrap();
        let back: Timeline = serde_json::from_str(&json).unwrap();
        assert_eq!(back.tracks[0].clips[2].name, "C");
        assert_eq!(back.tracks[0].clips[2].source_len, 200);
        assert_eq!(back.tracks[0].clips[2].start_frame, 150);
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
        assert_eq!(
            c.start_frame, LEGACY_MISSING_START,
            "raw deserialize alone leaves the migration sentinel — a caller \
             must run backfill_legacy_positions"
        );
    }

    /// D-054: a whole pre-migration track (every clip missing `start_frame`)
    /// backfills to the exact back-to-back layout the old `clip_at`
    /// cumulative walk produced.
    #[test]
    fn backfill_reconstructs_back_to_back_positions_for_a_legacy_track() {
        let j = r#"{"name":"x","tracks":[{"kind":"video","clips":[
            {"id":"a","name":"A","source_path":"/a.mov","source_start":0,"duration":100,"source_len":100},
            {"id":"b","name":"B","source_path":"/b.mov","source_start":0,"duration":50,"source_len":50},
            {"id":"c","name":"C","source_path":"/c.mov","source_start":0,"duration":200,"source_len":200}
        ]}]}"#;
        let mut t: Timeline = serde_json::from_str(j).unwrap();
        t.backfill_legacy_positions();
        let starts: Vec<i64> = t.tracks[0].clips.iter().map(|c| c.start_frame).collect();
        assert_eq!(
            starts,
            vec![0, 100, 150],
            "matches the pre-D-054 implicit layout"
        );
        assert_eq!(t.duration(), 350);

        // idempotent: running it again changes nothing
        t.backfill_legacy_positions();
        let starts2: Vec<i64> = t.tracks[0].clips.iter().map(|c| c.start_frame).collect();
        assert_eq!(starts2, vec![0, 100, 150]);
    }

    /// The exact single-clip shape found in the real
    /// `~/Movies/Chroma/New.chroma/project.json` (checked by hand against
    /// that file, D-045-style) — one clip, no `start_frame` key at all.
    #[test]
    fn backfill_matches_the_real_project_json_single_clip_shape() {
        let j = r#"{"name":"New","tracks":[{"kind":"video","clips":[
            {"id":"8022aef1-78db-491e-aeb4-03a78b785af7",
             "shot_id":"8022aef1-78db-491e-aeb4-03a78b785af7",
             "name":"pexels_28808272.mp4",
             "source_path":"/Users/ashishmaurya/Downloads/pexels_28808272.mp4",
             "source_start":0,"duration":1078,"source_len":1078}]}]}"#;
        let mut t: Timeline = serde_json::from_str(j).unwrap();
        t.backfill_legacy_positions();
        assert_eq!(t.tracks[0].clips[0].start_frame, 0);
        assert_eq!(t.duration(), 1078);
    }

    /// D-045: a pre-D-045 `Timeline` JSON blob (the shape every project.json
    /// had under the old singular `timeline` key) never had an `id` field —
    /// it must still deserialize, defaulting to `""`. `chroma::project`'s
    /// migration backfills a real id on the raw JSON before this runs; this
    /// test only pins the crate-level fallback the migration relies on.
    #[test]
    fn legacy_timeline_json_without_id_defaults_empty() {
        let j = r#"{"name":"New","rate":null,"tracks":[{"kind":"video","clips":[]}]}"#;
        let t: Timeline = serde_json::from_str(j).unwrap();
        assert_eq!(t.id, "");
        assert_eq!(t.name, "New");
    }

    #[test]
    fn clip_at_walks_positions() {
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

    /// D-054: a query landing inside a gap between two clips returns `None`,
    /// same as past-the-end — never panics, never returns the wrong clip.
    #[test]
    fn clip_at_inside_a_gap_is_none() {
        let mut t = Timeline::default();
        t.tracks.push(Track {
            kind: TrackKind::Video,
            clips: vec![
                Clip {
                    id: "a".into(),
                    name: "A".into(),
                    source_path: "/a.mov".into(),
                    duration: 50,
                    source_len: 50,
                    start_frame: 0,
                    ..Default::default()
                },
                // gap [50, 100)
                Clip {
                    id: "b".into(),
                    name: "B".into(),
                    source_path: "/b.mov".into(),
                    duration: 50,
                    source_len: 50,
                    start_frame: 100,
                    ..Default::default()
                },
            ],
        });
        let tr = &t.tracks[0];
        assert_eq!(tr.clip_at(49).map(|(c, _)| c.name.as_str()), Some("A"));
        assert!(tr.clip_at(50).is_none(), "right at the gap's start");
        assert!(tr.clip_at(75).is_none(), "middle of the gap");
        assert!(tr.clip_at(99).is_none(), "right before the gap ends");
        assert_eq!(tr.clip_at(100).map(|(c, _)| c.name.as_str()), Some("B"));
        assert_eq!(
            t.duration(),
            150,
            "duration is the furthest clip end, gap included"
        );
    }

    #[test]
    fn reorder_changes_vec_order_but_not_positions() {
        let mut t = Timeline::from_shots(&shots());
        let mut before: Vec<(i64, i64)> = t.tracks[0]
            .clips
            .iter()
            .map(|c| (c.start_frame, c.duration))
            .collect();
        t.reorder(0, 0, 2).unwrap();
        let names: Vec<_> = t.tracks[0].clips.iter().map(|c| c.name.clone()).collect();
        assert_eq!(names, vec!["B", "C", "A"], "Vec order does change");
        let mut after: Vec<(i64, i64)> = t.tracks[0]
            .clips
            .iter()
            .map(|c| (c.start_frame, c.duration))
            .collect();
        // each clip individually kept its own (start_frame, duration) — only
        // which Vec slot holds it changed.
        before.sort();
        after.sort();
        assert_eq!(before, after, "no clip moved in time");
        // clip_at results are therefore unchanged too
        let tr = &t.tracks[0];
        assert_eq!(tr.clip_at(0).map(|(c, _)| c.name.clone()), Some("A".into()));
        assert_eq!(
            tr.clip_at(150).map(|(c, _)| c.name.clone()),
            Some("C".into())
        );
        assert_eq!(t.reorder(0, 5, 0), Err(TimelineError::BadIndex(5)));
        assert_eq!(t.reorder(9, 0, 0), Err(TimelineError::NoSuchTrack(9)));
    }

    #[test]
    fn trim_start_clamps_and_shortens() {
        let mut t = Timeline::from_shots(&shots());
        t.trim_start(0, 0, 20).unwrap();
        let c = &t.tracks[0].clips[0];
        assert_eq!((c.source_start, c.start_frame, c.duration), (20, 20, 80));
        // extend back past 0 clamps
        t.trim_start(0, 0, -100).unwrap();
        let c = &t.tracks[0].clips[0];
        assert_eq!((c.source_start, c.start_frame, c.duration), (0, 0, 100));
        // a head trim that would push past the clip's own (already shortened)
        // tail empties it → error
        t.trim_end(0, 1, -40).unwrap(); // clip B: dur 50 -> 10
        assert_eq!(t.trim_start(0, 1, 10), Err(TimelineError::EmptyClip));
        assert_eq!(t.trim_start(0, 1, 25), Err(TimelineError::EmptyClip));
        // a head trim within the shortened clip still works
        t.trim_start(0, 1, 5).unwrap();
        let b = &t.tracks[0].clips[1];
        assert_eq!((b.source_start, b.start_frame, b.duration), (5, 105, 5));
    }

    /// D-054: trimming the head to the right opens a gap before the clip
    /// (nothing ripples to close it); the clip's *end* stays fixed.
    #[test]
    fn trim_start_opens_a_gap_before_the_clip() {
        let mut t = Timeline::from_shots(&shots());
        let b_end_before = t.tracks[0].clips[1].end_frame();
        t.trim_start(0, 1, 20).unwrap(); // clip B: start 100 -> 120, dur 50 -> 30
        let b = &t.tracks[0].clips[1];
        assert_eq!((b.start_frame, b.duration), (120, 30));
        assert_eq!(
            b.end_frame(),
            b_end_before,
            "end frame unaffected by a head trim"
        );
        assert!(
            t.tracks[0].clip_at(110).is_none(),
            "the new gap between A's end (100) and B's new start (120)"
        );
    }

    /// D-054: extending the head left is clamped so it can't eat into the
    /// preceding clip on the same track.
    #[test]
    fn trim_start_extend_clamps_to_the_previous_clip() {
        let mut t = Timeline::from_shots(&shots());
        // clip B starts at 100, right after A ends at 100 — no room to extend left at all
        t.trim_start(0, 1, -10).unwrap();
        let b = &t.tracks[0].clips[1];
        assert_eq!(
            (b.start_frame, b.duration),
            (100, 50),
            "clamped to A's end — no overlap introduced"
        );
    }

    #[test]
    fn trim_end_clamps_to_media() {
        let mut t = Timeline::from_shots(&shots());
        t.trim_end(0, 0, -30).unwrap();
        assert_eq!(t.tracks[0].clips[0].duration, 70);
        // can't extend past source_len (100) — and (D-054) B starts at 100
        // anyway, so both bounds agree here
        t.trim_end(0, 0, 999).unwrap();
        assert_eq!(t.tracks[0].clips[0].duration, 100);
        assert_eq!(t.trim_end(0, 9, 1), Err(TimelineError::NoSuchClip(9, 0)));
    }

    /// D-054: trim_end can never grow a clip into the next clip on the same
    /// track, even when the source media has room to extend further.
    #[test]
    fn trim_end_clamps_to_the_next_clip() {
        let mut t = Timeline::from_shots(&shots());
        // A: start 0, dur 100, source_len 100 — B starts right at 100.
        t.trim_start(0, 1, 20).unwrap(); // move B's start to 120 (gap [100,120))
        t.trim_end(0, 0, 999).unwrap(); // try to grow A way past both bounds
        let a = &t.tracks[0].clips[0];
        assert_eq!(
            a.duration, 100,
            "clamped by source_len (100), tighter here than the 120 position bound"
        );

        // now prove the *position* bound independently: shrink A first so
        // source_len (100) is no longer the tighter constraint, then grow
        // back — it must stop at B's start (120), not source_len (100)... but
        // it can't exceed source_len either, so use a fresh clip with a very
        // long source to isolate the position clamp.
        let mut t2 = Timeline::default();
        t2.tracks.push(Track {
            kind: TrackKind::Video,
            clips: vec![
                Clip {
                    id: "x".into(),
                    name: "X".into(),
                    source_path: "/x.mov".into(),
                    source_start: 0,
                    duration: 10,
                    source_len: 10_000, // plenty of source headroom
                    start_frame: 0,
                    ..Default::default()
                },
                Clip {
                    id: "y".into(),
                    name: "Y".into(),
                    source_path: "/y.mov".into(),
                    source_start: 0,
                    duration: 10,
                    source_len: 10,
                    start_frame: 50, // gap [10, 50)
                    ..Default::default()
                },
            ],
        });
        t2.trim_end(0, 0, 999).unwrap();
        assert_eq!(
            t2.tracks[0].clips[0].duration, 50,
            "grew right up to Y's start (50), not further, despite ample source_len"
        );
    }

    #[test]
    fn split_makes_two_clips() {
        let mut t = Timeline::from_shots(&shots());
        // clip B spans timeline [100, 150); split at 120
        t.split(0, 1, 120).unwrap();
        assert_eq!(t.tracks[0].clips.len(), 4);
        let b1 = &t.tracks[0].clips[1];
        let b2 = &t.tracks[0].clips[2];
        assert_eq!((b1.start_frame, b1.source_start, b1.duration), (100, 0, 20));
        assert_eq!(
            (b2.start_frame, b2.source_start, b2.duration),
            (120, 20, 30)
        );
        assert_eq!(b2.name, "B");
        assert_ne!(b1.id, b2.id);
        assert_eq!(t.duration(), 350, "split preserves total length");
        assert_eq!(
            b1.end_frame(),
            b2.start_frame,
            "the two halves are still back to back — split never opens a gap"
        );
        // on an edge → error
        assert!(matches!(
            t.split(0, 0, 0),
            Err(TimelineError::SplitOutsideClip(0, 0))
        ));
    }

    #[test]
    fn remove_leaves_a_gap() {
        let mut t = Timeline::from_shots(&shots());
        t.remove(0, 1).unwrap();
        let names: Vec<_> = t.tracks[0].clips.iter().map(|c| c.name.clone()).collect();
        assert_eq!(names, vec!["A", "C"]);
        // D-054: C never moves — it's still at 150, so total duration is
        // still 350 (unlike the pre-D-054 ripple-close behaviour, which
        // would have collapsed this to 300; flagged in D-054).
        assert_eq!(t.duration(), 350);
        assert!(
            t.tracks[0].clip_at(120).is_none(),
            "B's old slot [100,150) is now a gap"
        );
        assert_eq!(t.remove(0, 9), Err(TimelineError::NoSuchClip(9, 0)));
    }

    // --- track management (D-054) -------------------------------------------

    #[test]
    fn add_and_remove_track_round_trip() {
        let mut t = Timeline::from_shots(&shots());
        assert_eq!(t.tracks.len(), 1);
        let idx = t.add_track(TrackKind::Audio);
        assert_eq!(idx, 1);
        assert_eq!(t.tracks.len(), 2);
        assert_eq!(t.tracks[1].kind, TrackKind::Audio);
        assert!(t.tracks[1].clips.is_empty());

        t.remove_track(0).unwrap();
        assert_eq!(t.tracks.len(), 1);
        assert_eq!(
            t.tracks[0].kind,
            TrackKind::Audio,
            "the video track was the one removed"
        );

        assert_eq!(t.remove_track(9), Err(TimelineError::NoSuchTrack(9)));
    }

    #[test]
    fn remove_track_drops_its_clips_too() {
        let mut t = Timeline::from_shots(&shots());
        assert!(!t.tracks[0].clips.is_empty());
        t.remove_track(0).unwrap();
        assert!(
            t.tracks.is_empty(),
            "the track and everything on it is gone"
        );
    }

    #[test]
    fn move_clip_across_tracks_preserves_identity() {
        let mut t = Timeline::from_shots(&shots());
        t.add_track(TrackKind::Video);
        let moved_id = t.tracks[0].clips[1].id.clone(); // "s2" / clip B
        t.move_clip(0, 1, 1, 500).unwrap();

        assert_eq!(t.tracks[0].clips.len(), 2, "removed from the source track");
        assert_eq!(
            t.tracks[1].clips.len(),
            1,
            "landed on the destination track"
        );
        let moved = &t.tracks[1].clips[0];
        assert_eq!(moved.id, moved_id, "identity preserved across the move");
        assert_eq!(moved.start_frame, 500);
        assert_eq!(moved.duration, 50, "duration/source window untouched");
    }

    #[test]
    fn move_clip_within_the_same_track_repositions_it() {
        let mut t = Timeline::from_shots(&shots());
        t.move_clip(0, 0, 0, 1000).unwrap(); // move A far to the right
        assert_eq!(
            t.tracks[0].clips.len(),
            3,
            "still 3 clips, just repositioned"
        );
        assert!(
            t.tracks[0].clip_at(0).is_none(),
            "A's old slot is now a gap"
        );
        let a = t.tracks[0].clips.iter().find(|c| c.name == "A").unwrap();
        assert_eq!(a.start_frame, 1000);
    }

    #[test]
    fn move_clip_rejects_overlap() {
        let mut t = Timeline::from_shots(&shots());
        // try to move C (start 150, dur 200) onto A's slot (start 0, dur 100)
        let err = t.move_clip(0, 2, 0, 0).unwrap_err();
        assert_eq!(err, TimelineError::Overlap(0, 0));
        // a partial overlap is rejected too
        let err2 = t.move_clip(0, 2, 0, 50).unwrap_err();
        assert_eq!(err2, TimelineError::Overlap(0, 50));
        // landing exactly back-to-back (no overlap) is fine
        t.move_clip(0, 2, 0, 100 + 50).unwrap(); // right after B ends
        assert_eq!(t.tracks[0].clips.len(), 3);
    }

    #[test]
    fn move_clip_rejects_out_of_range_and_negative_position() {
        let mut t = Timeline::from_shots(&shots());
        assert_eq!(t.move_clip(9, 0, 0, 0), Err(TimelineError::NoSuchTrack(9)));
        assert_eq!(
            t.move_clip(0, 9, 0, 0),
            Err(TimelineError::NoSuchClip(9, 0))
        );
        assert_eq!(t.move_clip(0, 0, 9, 0), Err(TimelineError::NoSuchTrack(9)));
        assert_eq!(
            t.move_clip(0, 0, 0, -1),
            Err(TimelineError::NegativePosition(-1))
        );
    }

    // --- opaque top-wins video-track resolution (D-056, Phase B1) -----------

    /// Build a 2-video-track timeline the same way the app would: start from
    /// `from_shots` (real op) then `add_track` + `move_clip` (both real,
    /// tested Phase-A ops) to get a second video track with its own clip,
    /// rather than hand-rolling a `Timeline` struct literal.
    ///
    /// Layout after setup:
    /// - track 0 (top / higher priority): "A" at `[0, 100)` only — clip "C"
    ///   (originally at `[150, 350)`) is moved off to make room for the gap
    ///   cases below, so track 0 is `[0,100)` clip, then a gap to infinity.
    /// - track 1 (bottom / lower priority): "B" at `[0, 50)`, "C" at
    ///   `[100, 300)` — chosen so track 1 has content both where track 0 has
    ///   a clip (`[0,50)`, fully shadowed) and where track 0 has a gap
    ///   (`[100,300)`, shows through).
    fn two_video_track_timeline() -> Timeline {
        let mut t = Timeline::from_shots(&shots()); // track 0: A[0,100) B[100,150) C[150,350)
        t.add_track(TrackKind::Video); // track 1, empty
        t.move_clip(0, 1, 1, 0).unwrap(); // B: track0 -> track1 @ [0,50)
        t.move_clip(0, 1, 1, 100).unwrap(); // C: track0 -> track1 @ [100,300)
        t
    }

    #[test]
    fn resolve_video_clip_at_top_track_wins_when_both_have_content() {
        let t = two_video_track_timeline();
        // frame 10: track 0 has A [0,100), track 1 has B [0,50) — top wins.
        let (track_idx, clip, source_frame) = t.resolve_video_clip_at(10).unwrap();
        assert_eq!(track_idx, 0);
        assert_eq!(clip.name, "A");
        assert_eq!(source_frame, 10);
    }

    #[test]
    fn resolve_video_clip_at_only_top_has_content() {
        let t = two_video_track_timeline();
        // frame 60: track 0 still has A [0,100); track 1's B ended at 50, C
        // doesn't start until 100 — track 1 has a gap too, but it doesn't
        // matter, track 0 alone already resolves it.
        let (track_idx, clip, _) = t.resolve_video_clip_at(60).unwrap();
        assert_eq!(track_idx, 0);
        assert_eq!(clip.name, "A");
    }

    #[test]
    fn resolve_video_clip_at_only_bottom_has_content() {
        let t = two_video_track_timeline();
        // frame 150: track 0's A ended at 100 (nothing after — no clip was
        // left there), track 1 has C [100,300) — bottom shows through.
        let (track_idx, clip, source_frame) = t.resolve_video_clip_at(150).unwrap();
        assert_eq!(track_idx, 1);
        assert_eq!(clip.name, "C");
        assert_eq!(source_frame, 50, "150 - C's start_frame (100)");
    }

    #[test]
    fn resolve_video_clip_at_top_gap_falls_through_to_bottom() {
        let t = two_video_track_timeline();
        // frame 100: track 0 has nothing (A ended at 100, exclusive), track 1
        // has C starting exactly at 100 — this is the literal gap-fallthrough
        // case: a higher-priority track's gap yields to the track below it.
        let (track_idx, clip, source_frame) = t.resolve_video_clip_at(100).unwrap();
        assert_eq!(track_idx, 1);
        assert_eq!(clip.name, "C");
        assert_eq!(source_frame, 0);
    }

    #[test]
    fn resolve_video_clip_at_neither_track_has_content() {
        let t = two_video_track_timeline();
        // frame 400 is past everything on both tracks (A ends at 100, C ends
        // at 300) — a real dead zone, not just a gap on one side.
        assert!(t.resolve_video_clip_at(400).is_none());
        // and a negative position is never resolvable on any track.
        assert!(t.resolve_video_clip_at(-1).is_none());
    }

    #[test]
    fn resolve_video_clip_at_no_video_tracks_is_none() {
        let t = Timeline::default();
        assert!(t.resolve_video_clip_at(0).is_none());
    }

    /// A single-video-track timeline (today's only real shape, D-054's
    /// baseline) behaves exactly as `Track::clip_at` alone always did —
    /// resolution through the new multi-track path is a strict superset,
    /// not a behavior change, for the case every existing project is in.
    #[test]
    fn resolve_video_clip_at_matches_single_track_behavior() {
        let t = Timeline::from_shots(&shots());
        for pos in [0i64, 99, 100, 149, 150, 349, 350, -1] {
            let via_track = t.tracks[0].clip_at(pos).map(|(c, sf)| (c.name.clone(), sf));
            let via_resolve = t
                .resolve_video_clip_at(pos)
                .map(|(idx, c, sf)| (idx, c.name.clone(), sf));
            match via_track {
                Some((name, sf)) => assert_eq!(via_resolve, Some((0, name, sf))),
                None => assert_eq!(via_resolve, None),
            }
        }
    }
}

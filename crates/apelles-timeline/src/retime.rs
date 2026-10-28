//! Changing a timeline's frame rate without changing what it plays (B-323).
//!
//! **What it is.** [`Timeline::set_rate`]: stamp a new `rate` on a timeline and
//! convert every quantity that is counted in *timeline frames* so it names the
//! same instant in seconds, rounded to the nearest new frame. A 10 s clip at
//! frame 240 of a 24 fps timeline is a 10 s clip at frame 300 of a 30 fps one.
//!
//! **What it converts.** `Clip::start_frame`, `Clip::fade_in_frames` /
//! `fade_out_frames`, `Marker::frame` / `duration_frames`, and
//! `Transition::at_frame` / `duration`. For a clip with **no** `source_fps` the
//! source axis *is* the timeline axis (1:1, `source_frames_to_timeline`'s
//! fallback), so its `source_start` / `duration` / `source_len`, speed points,
//! highlight sweeps and keyframe frames are converted too.
//!
//! **What it does NOT touch.** A clip that carries a `source_fps` keeps its
//! source-native fields exactly (`source_start`, `duration`, `source_len`, speed
//! points, keyframes, highlights): they are counted in the media's own frames,
//! and `source_frames_to_timeline` already re-expresses that footprint at the
//! new rate, so the clip keeps its length in seconds by construction. Nothing
//! here probes media, writes a file or knows about project settings.
//!
//! Also here: [`fps_to_rational`], the one place a float frame rate becomes the
//! exact `num/den` a timeline stores (29.97 -> 30000/1001, never 2997/100).

use apelles_types::Rational;

use crate::{Clip, Timeline};

/// The fastest frame rate a timeline may be set to. Far above any delivery
/// format; it exists so a typo (`fps=2400`) is refused instead of stored.
pub const MAX_TIMELINE_FPS: f64 = 240.0;

/// The exact rational for a frame rate given as a float: an integer rate stays
/// `n/1`, the NTSC family (23.976, 29.97, 47.952, 59.94, ...) becomes
/// `n*1000/1001`, anything else is held to three decimals. `None` for a rate
/// that is not finite, not positive or above [`MAX_TIMELINE_FPS`].
pub fn fps_to_rational(fps: f64) -> Option<Rational> {
    if !fps.is_finite() || fps <= 0.0 || fps > MAX_TIMELINE_FPS {
        return None;
    }
    let whole = fps.round();
    if (fps - whole).abs() < 1e-6 {
        return Some(Rational::new(whole as i64, 1));
    }
    let ntsc_base = (fps * 1.001).round();
    if (fps - ntsc_base * 1000.0 / 1001.0).abs() < 0.005 {
        return Some(Rational::new(ntsc_base as i64 * 1000, 1001));
    }
    Some(Rational::new((fps * 1000.0).round() as i64, 1000))
}

/// `frames` scaled by `ratio`, rounded; a non-zero span never collapses to zero.
fn scale(frames: i64, ratio: f64) -> i64 {
    let scaled = (frames as f64 * ratio).round() as i64;
    if frames != 0 && scaled == 0 {
        frames.signum()
    } else {
        scaled
    }
}

/// Scale every `frame` key of a keyframe array (`[{frame, params}, ...]`).
fn scale_keyframes(keyframes: &mut serde_json::Value, ratio: f64) {
    let Some(list) = keyframes.as_array_mut() else {
        return;
    };
    for kf in list {
        if let Some(frame) = kf.get("frame").and_then(serde_json::Value::as_f64) {
            kf["frame"] = serde_json::Value::from(scale(frame.round() as i64, ratio));
        }
    }
}

fn retime_clip(c: &mut Clip, ratio: f64) {
    c.start_frame = scale(c.start_frame, ratio);
    c.fade_in_frames = scale(c.fade_in_frames, ratio);
    c.fade_out_frames = scale(c.fade_out_frames, ratio);
    if c.source_fps.is_some_and(|f| f > 0.0) {
        return;
    }
    c.source_start = scale(c.source_start, ratio);
    c.duration = scale(c.duration, ratio);
    c.source_len = scale(c.source_len, ratio);
    for p in &mut c.speed_points {
        p.source_frame = scale(p.source_frame, ratio);
    }
    for h in &mut c.highlights {
        h.at = scale(h.at, ratio);
        h.dur = scale(h.dur, ratio);
    }
    if let Some(kf) = c.chroma_keyframes.as_mut() {
        scale_keyframes(kf, ratio);
    }
}

impl Timeline {
    /// Change this timeline's frame rate to `new`, keeping every clip, marker
    /// and transition at the same time in seconds (see the module doc for
    /// exactly which fields move). Nothing but the rate is stamped when the
    /// effective rate is unchanged. `Err` for a rate that is not positive and
    /// finite or above [`MAX_TIMELINE_FPS`]; the timeline is then untouched.
    pub fn set_rate(&mut self, new: Rational) -> Result<(), String> {
        if new.num <= 0 || new.den <= 0 || new.as_f64() > MAX_TIMELINE_FPS {
            return Err(format!(
                "a frame rate must be positive and at most {MAX_TIMELINE_FPS} fps (got {}/{})",
                new.num, new.den
            ));
        }
        let ratio = new.as_f64() / self.fps();
        self.rate = Some(new);
        if (ratio - 1.0).abs() < 1e-12 {
            return Ok(());
        }
        for track in &mut self.tracks {
            for clip in &mut track.clips {
                retime_clip(clip, ratio);
            }
            for t in &mut track.transitions {
                t.at_frame = scale(t.at_frame, ratio);
                t.duration = scale(t.duration, ratio);
            }
        }
        for m in &mut self.markers {
            m.frame = scale(m.frame, ratio);
            m.duration_frames = m.duration_frames.map(|d| scale(d, ratio));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Marker, Track, Transition};

    fn clip(start: i64, duration: i64, source_fps: Option<f64>) -> Clip {
        Clip {
            id: "c".into(),
            start_frame: start,
            duration,
            source_len: duration,
            source_fps,
            ..Default::default()
        }
    }

    fn timeline(rate: Option<Rational>, clips: Vec<Clip>) -> Timeline {
        let track = Track {
            clips,
            ..Track::default()
        };
        Timeline {
            rate,
            tracks: vec![track],
            ..Default::default()
        }
    }

    #[test]
    fn fps_becomes_the_exact_rational() {
        assert_eq!(fps_to_rational(30.0), Some(Rational::new(30, 1)));
        assert_eq!(fps_to_rational(29.97), Some(Rational::new(30000, 1001)));
        assert_eq!(fps_to_rational(23.976), Some(Rational::new(24000, 1001)));
        assert_eq!(fps_to_rational(59.94), Some(Rational::new(60000, 1001)));
        assert_eq!(fps_to_rational(12.5), Some(Rational::new(12500, 1000)));
        assert_eq!(fps_to_rational(0.0), None);
        assert_eq!(fps_to_rational(f64::NAN), None);
        assert_eq!(fps_to_rational(1000.0), None);
    }

    #[test]
    fn an_unrated_timeline_is_24_and_retimes_from_there() {
        let mut tl = timeline(None, vec![clip(240, 120, None)]);
        tl.set_rate(Rational::new(30, 1)).unwrap();
        let c = &tl.tracks[0].clips[0];
        assert_eq!((c.start_frame, c.duration, c.source_len), (300, 150, 150));
        assert_eq!(tl.fps(), 30.0);
    }

    #[test]
    fn seconds_are_preserved_for_timeline_frame_fields() {
        let mut tl = timeline(Some(Rational::new(24, 1)), vec![clip(48, 72, None)]);
        tl.tracks[0].clips[0].fade_in_frames = 12;
        tl.tracks[0].transitions.push(Transition {
            id: "t".into(),
            kind: crate::TransitionKind::CrossDissolve,
            at_frame: 120,
            duration: 24,
            alignment: crate::TransitionAlignment::default(),
            color: None,
        });
        tl.markers.push(Marker {
            id: "m".into(),
            frame: 96,
            color: "#3B8FE3".into(),
            duration_frames: Some(48),
            name: None,
            note: None,
        });
        tl.set_rate(Rational::new(30, 1)).unwrap();
        let c = &tl.tracks[0].clips[0];
        assert_eq!((c.start_frame, c.duration, c.fade_in_frames), (60, 90, 15));
        assert_eq!(tl.tracks[0].transitions[0].at_frame, 150);
        assert_eq!(tl.tracks[0].transitions[0].duration, 30);
        assert_eq!(
            (tl.markers[0].frame, tl.markers[0].duration_frames),
            (120, Some(60))
        );
    }

    #[test]
    fn source_native_fields_are_untouched_when_the_clip_has_a_source_rate() {
        // A 25 fps recording: 100 source frames = 4 s, on a 24 fps timeline
        // that is 96 timeline frames; at 30 fps it must be 120, with the
        // source fields exactly as they were.
        let mut tl = timeline(Some(Rational::new(24, 1)), vec![clip(24, 100, Some(25.0))]);
        tl.tracks[0].clips[0].source_start = 10;
        assert_eq!(tl.tracks[0].clips[0].end_frame_at(24.0) - 24, 96);
        tl.set_rate(Rational::new(30, 1)).unwrap();
        let c = &tl.tracks[0].clips[0];
        assert_eq!((c.source_start, c.duration, c.source_len), (10, 100, 100));
        assert_eq!(c.start_frame, 30);
        assert_eq!(c.end_frame_at(30.0) - c.start_frame, 120);
    }

    #[test]
    fn a_no_op_changes_nothing_and_a_bad_rate_is_refused() {
        let mut tl = timeline(Some(Rational::new(30, 1)), vec![clip(7, 13, None)]);
        tl.set_rate(Rational::new(30, 1)).unwrap();
        assert_eq!(tl.tracks[0].clips[0].start_frame, 7);
        assert!(tl.set_rate(Rational::new(0, 1)).is_err());
        assert!(tl.set_rate(Rational::new(1000, 1)).is_err());
        assert_eq!(
            tl.rate,
            Some(Rational::new(30, 1)),
            "a refused rate leaves the rate"
        );
    }

    #[test]
    fn a_short_span_never_collapses_to_nothing() {
        let mut tl = timeline(Some(Rational::new(60, 1)), vec![clip(0, 1, None)]);
        tl.set_rate(Rational::new(24, 1)).unwrap();
        assert_eq!(tl.tracks[0].clips[0].duration, 1);
    }

    #[test]
    fn keyframes_and_speed_points_follow_a_source_rateless_clip() {
        let mut c = clip(0, 60, None);
        c.chroma_keyframes =
            Some(serde_json::json!([{"frame": 0, "params": {}}, {"frame": 24, "params": {}}]));
        c.speed_points = vec![crate::SpeedPoint {
            source_frame: 24,
            speed: 2.0,
        }];
        let mut tl = timeline(Some(Rational::new(24, 1)), vec![c]);
        tl.set_rate(Rational::new(48, 1)).unwrap();
        let c = &tl.tracks[0].clips[0];
        assert_eq!(c.chroma_keyframes.as_ref().unwrap()[1]["frame"], 48);
        assert_eq!(c.speed_points[0].source_frame, 48);
    }
}

//! The speed ramp: variable playback speed over one clip's own length
//! (D-235, roadmap item 27).
//!
//! **What it is.** The Rust half of the single, canonical time remap — the
//! function that answers "which SOURCE frame does this clip show at this
//! OUTPUT position, and how long does the clip therefore occupy on the
//! timeline". This half is what the LIVE PREVIEW decodes with
//! ([`Clip::source_frame_at`] / [`Clip::end_frame_at`] both route through it);
//! its exact twin is `@chroma/editor`'s `speedRamp.ts`, which the EXPORT
//! compiles its `setpts` expression and its `atempo` chain from. The two files
//! are kept deliberately line-for-line comparable, because their agreement IS
//! the feature's preview/export parity.
//!
//! **What it does.** A ramp is a list of [`SpeedPoint`]s on the clip
//! (`Clip::speed_points`). Each says "from this SOURCE frame onward, play at
//! this speed", so the speed profile is a **step function over the source
//! axis** and the remap is exactly **piecewise linear** in both directions —
//! the one shape expressible identically as closed-form arithmetic here, as a
//! nested `if(lt(T,..))` `setpts` expression in ffmpeg, and as an
//! `atrim`/`atempo`/`concat` chain for the audio (which can only ever be
//! piecewise constant: ffmpeg's `atempo` takes a number, not an expression).
//!
//! **A flat speed is a one-segment ramp.** The pre-D-235 export-time-only
//! `speedOverrides` multiplier (D-183) is not a rival concept — it resolves
//! into a single segment, and every consumer sees only segments.
//!
//! **What it does NOT do.** Reverse (negative) speed, smoothed S-curve speed
//! transitions, or frame interpolation for slow motion. See `speedRamp.ts`'s
//! own module doc and D-235 for why each is deliberately out, and
//! `docs/04-roadmap.md` for where they are tracked.

use serde::{Deserialize, Serialize};

/// The speed range a ramp point is clamped into. Mirrors `speedRamp.ts`'s
/// `MIN_SPEED`/`MAX_SPEED` exactly — a different clamp on either side would be
/// a preview/export divergence of precisely the kind this feature is most at
/// risk from.
pub const MIN_SPEED: f64 = 0.05;
/// See [`MIN_SPEED`].
pub const MAX_SPEED: f64 = 20.0;

/// A speed point: from `source_frame` onward (in the clip's own SOURCE frame
/// space — the same space as `Clip::source_start`, absolute in the file, NOT
/// clip-relative), this clip plays at `speed`.
///
/// Absolute source frames rather than clip-relative ones is what makes a ramp
/// survive a trim: trimming the head moves `source_start`, but the moment in
/// the footage the speed was authored against stays put. It matches DaVinci
/// Resolve's own Retime Controls, whose speed points anchor to source frames
/// and change the OUTPUT duration when dragged.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SpeedPoint {
    /// Absolute SOURCE frame, at the clip's own native rate (`source_fps`).
    pub source_frame: i64,
    /// Source frames consumed per output frame from here on: `2.0` is double
    /// speed, `0.5` half. Always `> 0` — see [`clamp_speed`].
    pub speed: f64,
}

/// One resolved, concrete constant-speed run over a clip's own trim window.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SpeedSegment {
    /// Inclusive, absolute SOURCE frame.
    pub start_source_frame: i64,
    /// Exclusive, absolute SOURCE frame.
    pub end_source_frame: i64,
    pub speed: f64,
}

impl SpeedSegment {
    fn len_source_frames(&self) -> f64 {
        (self.end_source_frame - self.start_source_frame).max(0) as f64
    }
}

/// `speed` pinned into `[MIN_SPEED, MAX_SPEED]`. Every non-finite or
/// non-positive input (`0.0`, `NaN`, a negative "reverse" request the module
/// doc rules out) resolves to `1.0` — never to a value that would make the
/// remap non-monotonic or infinite.
pub fn clamp_speed(speed: f64) -> f64 {
    if !speed.is_finite() || speed <= 0.0 {
        return 1.0;
    }
    speed.clamp(MIN_SPEED, MAX_SPEED)
}

/// Normalise an authored point list: clamp every speed, sort by source frame,
/// and keep one point per frame (last write wins).
///
/// **It deliberately does NOT drop a point whose speed equals the one already
/// in force.** That looks like tidying and is actually destructive: splitting
/// a clip at the playhead and *then* choosing a speed for the new run is the
/// normal authoring order, and a redundant-point filter deletes that split
/// before the editor can use it. Flatness is decided from the SPEEDS instead
/// (see [`segments_are_flat`]), so a clip carrying only 1x points still takes
/// the byte-identical pre-D-235 flat path everywhere downstream.
///
/// Applied at READ time (not only on write) because `chroma_timeline_set`
/// stores whatever it is handed (D-058) — a hand-edited, older, or
/// MCP-written document has to resolve sanely too. Exact mirror of
/// `speedRamp.ts`'s `normalizeSpeedPoints`.
pub fn normalize_speed_points(points: &[SpeedPoint]) -> Vec<SpeedPoint> {
    if points.is_empty() {
        return Vec::new();
    }
    let mut sorted: Vec<SpeedPoint> = points
        .iter()
        .map(|p| SpeedPoint {
            source_frame: p.source_frame,
            speed: clamp_speed(p.speed),
        })
        .collect();
    sorted.sort_by_key(|p| p.source_frame);

    let mut by_frame: Vec<SpeedPoint> = Vec::with_capacity(sorted.len());
    for p in sorted {
        match by_frame.last_mut() {
            Some(prev) if prev.source_frame == p.source_frame => *prev = p,
            _ => by_frame.push(p),
        }
    }

    by_frame
}

/// Is this clip's playback speed CONSTANT — i.e. something a pre-D-235
/// consumer could already express? Equal speeds, not one segment: a clip split
/// by a speed point whose runs all play at the same rate is flat in every way
/// a renderer cares about. Mirrors `speedRamp.ts`'s `isFlatSegments`.
pub fn segments_are_flat(segments: &[SpeedSegment]) -> bool {
    segments.len() <= 1 || segments.iter().all(|s| s.speed == segments[0].speed)
}

/// The concrete constant-speed segments covering exactly the trim window
/// `[source_start, source_start + duration)`.
///
/// `flat_override` is an export-time `speedOverrides` entry (D-183) and is
/// used ONLY when the clip carries no points of its own — an explicit,
/// persisted, previewable ramp beats a per-export knob that has no GUI, and
/// multiplying the two would make the export match neither the preview nor the
/// dialog's own number.
///
/// Always returns at least one segment, so every consumer can index `[0]`.
/// Exact mirror of `speedRamp.ts`'s `resolveSpeedSegments`.
pub fn resolve_speed_segments(
    source_start: i64,
    duration: i64,
    points: &[SpeedPoint],
    flat_override: Option<f64>,
) -> Vec<SpeedSegment> {
    let start = source_start;
    let end = source_start + duration.max(0);
    let points = normalize_speed_points(points);

    if points.is_empty() {
        return vec![SpeedSegment {
            start_source_frame: start,
            end_source_frame: end,
            speed: clamp_speed(flat_override.unwrap_or(1.0)),
        }];
    }

    // The speed in force AT `start` is the last point at or before it — a
    // point authored before the clip's current in-point still governs the head
    // of the trimmed window, which is what keeps a ramp stable under a trim.
    let mut head_speed = 1.0_f64;
    let mut boundaries: Vec<i64> = vec![start];
    for p in &points {
        if p.source_frame <= start {
            head_speed = p.speed;
        } else if p.source_frame < end {
            boundaries.push(p.source_frame);
        }
    }
    boundaries.push(end);

    let speed_at = |frame: i64| -> f64 {
        let mut s = head_speed;
        for p in &points {
            if p.source_frame <= frame {
                s = p.speed;
            } else {
                break;
            }
        }
        s
    };

    boundaries
        .windows(2)
        .map(|w| SpeedSegment {
            start_source_frame: w[0],
            end_source_frame: w[1],
            speed: speed_at(w[0]),
        })
        .collect()
}

/// How long this ramp's OUTPUT is, in the clip's own source-frame units —
/// `Σ len_i / speed_i`. For a flat ramp this is exactly `duration / speed`,
/// and for an un-ramped clip exactly `duration`.
pub fn ramp_output_source_frames(segments: &[SpeedSegment]) -> f64 {
    segments
        .iter()
        .map(|s| s.len_source_frames() / s.speed)
        .sum()
}

/// Forward map: the OUTPUT position (in source-frame units from the clip's own
/// start) at which this ramp reaches absolute SOURCE frame `source_frame`.
///
/// This is the direction ffmpeg's `setpts` needs;
/// [`source_frame_at_output`] is the direction the preview needs. Both are
/// written against the same segments, and their round trip is what
/// `speedRamp.ffmpeg.test.ts` proves against real decoded pixels.
///
/// Extrapolates outside the ramp at the first/last segment's own speed rather
/// than clamping — matching [`crate::Clip::source_frame_at`]'s own documented
/// handle-media behaviour.
pub fn output_at_source_frame(segments: &[SpeedSegment], source_frame: f64) -> f64 {
    let Some(first) = segments.first() else {
        return 0.0;
    };
    if source_frame <= first.start_source_frame as f64 {
        return (source_frame - first.start_source_frame as f64) / first.speed;
    }
    let mut acc = 0.0;
    for s in segments {
        if source_frame < s.end_source_frame as f64 {
            return acc + (source_frame - s.start_source_frame as f64) / s.speed;
        }
        acc += s.len_source_frames() / s.speed;
    }
    let last = &segments[segments.len() - 1];
    acc + (source_frame - last.end_source_frame as f64) / last.speed
}

/// Inverse map: the absolute SOURCE frame this ramp shows at OUTPUT position
/// `output_pos` (in source-frame units from the clip's own start). The
/// direction the live preview asks in — "the playhead is here, which frame do
/// I decode".
pub fn source_frame_at_output(segments: &[SpeedSegment], output_pos: f64) -> f64 {
    let Some(first) = segments.first() else {
        return 0.0;
    };
    if output_pos <= 0.0 {
        return first.start_source_frame as f64 + output_pos * first.speed;
    }
    let mut acc = 0.0;
    for s in segments {
        let out_len = s.len_source_frames() / s.speed;
        if output_pos < acc + out_len {
            return s.start_source_frame as f64 + (output_pos - acc) * s.speed;
        }
        acc += out_len;
    }
    let last = &segments[segments.len() - 1];
    last.end_source_frame as f64 + (output_pos - acc) * last.speed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(a: i64, b: i64, s: f64) -> SpeedSegment {
        SpeedSegment {
            start_source_frame: a,
            end_source_frame: b,
            speed: s,
        }
    }

    #[test]
    fn no_points_is_one_identity_segment() {
        assert_eq!(
            resolve_speed_segments(0, 100, &[], None),
            vec![seg(0, 100, 1.0)]
        );
    }

    #[test]
    fn a_flat_override_is_a_one_segment_ramp() {
        let segs = resolve_speed_segments(0, 100, &[], Some(2.0));
        assert_eq!(segs, vec![seg(0, 100, 2.0)]);
        // ...and its output length is exactly `duration / speed`, the number
        // every pre-D-235 call site computed inline.
        assert_eq!(ramp_output_source_frames(&segs), 50.0);
    }

    #[test]
    fn a_clips_own_points_beat_a_flat_override() {
        let pts = [SpeedPoint {
            source_frame: 0,
            speed: 4.0,
        }];
        let segs = resolve_speed_segments(0, 100, &pts, Some(2.0));
        assert_eq!(segs, vec![seg(0, 100, 4.0)]);
    }

    #[test]
    fn a_split_at_1x_is_kept_as_a_split_but_still_reads_as_flat() {
        // Splitting a clip and only THEN choosing a speed is the normal
        // authoring order, so the point must survive normalisation — while the
        // clip still compiles down the flat path, because nothing about how it
        // plays has changed yet.
        let pts = [
            SpeedPoint {
                source_frame: 0,
                speed: 1.0,
            },
            SpeedPoint {
                source_frame: 40,
                speed: 1.0,
            },
        ];
        assert_eq!(normalize_speed_points(&pts).len(), 2);
        let segs = resolve_speed_segments(0, 100, &pts, None);
        assert_eq!(segs, vec![seg(0, 40, 1.0), seg(40, 100, 1.0)]);
        assert!(segments_are_flat(&segs));
        // ...and it occupies exactly the frames it always did.
        assert_eq!(ramp_output_source_frames(&segs), 100.0);
    }

    #[test]
    fn a_real_ramp_is_not_flat() {
        let segs = resolve_speed_segments(
            0,
            100,
            &[SpeedPoint {
                source_frame: 40,
                speed: 2.0,
            }],
            None,
        );
        assert!(!segments_are_flat(&segs));
    }

    #[test]
    fn points_split_the_window_and_the_last_one_before_the_in_point_governs_the_head() {
        let pts = [
            SpeedPoint {
                source_frame: 10,
                speed: 0.5,
            },
            SpeedPoint {
                source_frame: 60,
                speed: 2.0,
            },
        ];
        // Trimmed to start at 30, i.e. inside the 0.5x run: the head keeps
        // that speed even though its own point is now outside the window.
        let segs = resolve_speed_segments(30, 60, &pts, None);
        assert_eq!(segs, vec![seg(30, 60, 0.5), seg(60, 90, 2.0)]);
        // 30 source frames at 0.5x = 60 out, 30 at 2x = 15 out.
        assert_eq!(ramp_output_source_frames(&segs), 75.0);
    }

    #[test]
    fn the_two_directions_are_exact_inverses() {
        let pts = [
            SpeedPoint {
                source_frame: 0,
                speed: 0.5,
            },
            SpeedPoint {
                source_frame: 40,
                speed: 3.0,
            },
            SpeedPoint {
                source_frame: 70,
                speed: 1.25,
            },
        ];
        let segs = resolve_speed_segments(0, 100, &pts, None);
        // Including positions outside the clip, where both extrapolate.
        for i in -20..140 {
            let x = i as f64 * 0.7;
            let round_trip = output_at_source_frame(&segs, source_frame_at_output(&segs, x));
            assert!(
                (round_trip - x).abs() < 1e-9,
                "output {x} round-tripped to {round_trip}"
            );
        }
    }

    #[test]
    fn a_nonsense_speed_never_produces_a_non_monotonic_remap() {
        for bad in [0.0, -2.0, f64::NAN, f64::INFINITY] {
            assert!(clamp_speed(bad) > 0.0, "clamp_speed({bad}) must stay > 0");
        }
        assert_eq!(clamp_speed(1000.0), MAX_SPEED);
        assert_eq!(clamp_speed(0.0001), MIN_SPEED);
    }
}

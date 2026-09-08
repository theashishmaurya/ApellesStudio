//! The speed ramp: variable playback speed over one clip's own length
//! (D-236, roadmap item 27).
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
//! **A flat speed is a one-segment ramp.** The pre-D-236 export-time-only
//! `speedOverrides` multiplier (D-183) is not a rival concept — it resolves
//! into a single segment, and every consumer sees only segments.
//!
//! **Reverse (negative) speed — D-241.** A speed may be NEGATIVE, meaning that
//! run plays its own source range backwards. It is not a second model: a
//! segment `[a, b)` at speed `-s` occupies exactly the same `(b-a)/s` of
//! output a `+s` segment would, it just walks the source from `b` down to `a`.
//! The whole generalisation is one `anchor` term in the two maps below (the
//! segment's END rather than its start is the source position at its output
//! start) plus `abs()` wherever an output LENGTH is computed. The remap stays
//! piecewise linear and stays a bijection — it simply stops being monotonic,
//! which nothing here ever needed.
//!
//! **What it does NOT do.** Smoothed S-curve speed transitions, or frame
//! interpolation for slow motion. See `speedRamp.ts`'s own module doc and
//! D-236 for why each is deliberately out, and `docs/04-roadmap.md` for where
//! they are tracked.

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
    /// speed, `0.5` half. **Negative is REVERSE** (D-241): `-1.0` plays this
    /// run backwards at its recorded rate. Never `0.0` — see [`clamp_speed`].
    pub speed: f64,
}

/// One resolved, concrete constant-speed run over a clip's own trim window.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SpeedSegment {
    /// Inclusive, absolute SOURCE frame.
    pub start_source_frame: i64,
    /// Exclusive, absolute SOURCE frame.
    pub end_source_frame: i64,
    /// Negative = this run plays `[start_source_frame, end_source_frame)`
    /// BACKWARDS (D-241). Its output length is unchanged: `len / |speed|`.
    pub speed: f64,
}

impl SpeedSegment {
    fn len_source_frames(&self) -> f64 {
        (self.end_source_frame - self.start_source_frame).max(0) as f64
    }

    /// The SOURCE position this segment sits at when its own OUTPUT run
    /// begins: its start when it plays forwards, its **end** when it plays in
    /// reverse.
    ///
    /// This one term is the entire negative-speed generalisation (D-241). With
    /// it, `output = acc + (source - anchor) / speed` and `source = anchor +
    /// (output - acc) * speed` are each other's exact inverse for either sign,
    /// so both maps below are written once and branch nowhere.
    fn anchor_source_frame(&self) -> f64 {
        if self.speed > 0.0 {
            self.start_source_frame as f64
        } else {
            self.end_source_frame as f64
        }
    }

    /// This segment's OUTPUT length, in the same source-frame units its
    /// endpoints are in — `len / |speed|`. The absolute value is the only
    /// place a reversed run's sign is discarded: playing a range backwards
    /// takes exactly as long as playing it forwards, which is why reverse
    /// needed no schema change — a clip's timeline footprint never depends on
    /// the DIRECTION it plays.
    fn output_len(&self) -> f64 {
        self.len_source_frames() / self.speed.abs()
    }
}

/// Does any run of this ramp play backwards (D-241)? The branch every compiler
/// takes: a reversed run cannot be expressed as a `setpts` slope or an
/// `atempo` factor at all — it needs ffmpeg's frame-buffering
/// `reverse`/`areverse`, which is a different filtergraph shape entirely.
pub fn has_reverse_segments(segments: &[SpeedSegment]) -> bool {
    segments.iter().any(|s| s.speed < 0.0)
}

/// `speed` with its MAGNITUDE pinned into `[MIN_SPEED, MAX_SPEED]` and its
/// SIGN preserved (D-241: a negative speed is a real, supported reverse run).
/// Every non-finite input and exact `0.0` resolves to `1.0` — the two values
/// that would make the remap infinite or collapse the clip to a single
/// instant.
///
/// Note what is deliberately NOT clamped away: `-0.5` stays `-0.5`. Before
/// D-241 this function's whole job was to erase a negative, and the one-line
/// change here is what unlocks reverse everywhere downstream, because every
/// authored point in both languages goes through it. Exact mirror of
/// `speedRamp.ts`'s `clampSpeed`.
pub fn clamp_speed(speed: f64) -> f64 {
    if !speed.is_finite() || speed == 0.0 {
        return 1.0;
    }
    let magnitude = speed.abs().clamp(MIN_SPEED, MAX_SPEED);
    if speed < 0.0 { -magnitude } else { magnitude }
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
/// the byte-identical pre-D-236 flat path everywhere downstream.
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

/// Is this clip's playback speed CONSTANT **and FORWARD** — i.e. something a
/// pre-D-236 consumer could already express as one `PTS/<speed>` and one
/// `atempo` factor? Equal speeds, not one segment: a clip split by a speed
/// point whose runs all play at the same rate is flat in every way a renderer
/// cares about.
///
/// **D-241 — a reversed run is never "flat", even alone.** A single segment at
/// `-2.0` is perfectly constant, but `setpts=PTS/-2` and `atempo=-2` are not
/// what plays it backwards, so it must not take the constant path. "Flat" here
/// has always meant *expressible by the pre-D-236 compiler*, and that is the
/// meaning kept. Mirrors `speedRamp.ts`'s `isFlatSegments`.
pub fn segments_are_flat(segments: &[SpeedSegment]) -> bool {
    if has_reverse_segments(segments) {
        return false;
    }
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
/// `Σ len_i / |speed_i|`. For a flat ramp this is exactly `duration / speed`,
/// and for an un-ramped clip exactly `duration`. The magnitude (D-241) is what
/// makes a reversed run take exactly as long as the same range forwards.
pub fn ramp_output_source_frames(segments: &[SpeedSegment]) -> f64 {
    segments.iter().map(SpeedSegment::output_len).sum()
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
    let mut acc = 0.0;
    for (i, s) in segments.iter().enumerate() {
        // The last segment also absorbs everything past the ramp — that IS the
        // documented "extrapolate at the last segment's own speed" rule, and
        // writing it as a fall-through rather than a separate head/tail case
        // is what makes all three one formula. (Before D-241 the head and tail
        // were spelled out separately; they are algebraically the same
        // expression, which is why collapsing them changed no forward-ramp
        // result — pinned by the untouched D-236 tests below.)
        if source_frame < s.end_source_frame as f64 || i + 1 == segments.len() {
            return acc + (source_frame - s.anchor_source_frame()) / s.speed;
        }
        acc += s.output_len();
    }
    acc
}

/// Inverse map: the absolute SOURCE frame this ramp shows at OUTPUT position
/// `output_pos` (in source-frame units from the clip's own start). The
/// direction the live preview asks in — "the playhead is here, which frame do
/// I decode".
pub fn source_frame_at_output(segments: &[SpeedSegment], output_pos: f64) -> f64 {
    let mut acc = 0.0;
    for (i, s) in segments.iter().enumerate() {
        let out_len = s.output_len();
        // Same fall-through as `output_at_source_frame`: the first segment
        // covers everything before the ramp and the last everything after it.
        if output_pos < acc + out_len || i + 1 == segments.len() {
            return s.anchor_source_frame() + (output_pos - acc) * s.speed;
        }
        acc += out_len;
    }
    0.0
}

/// The runs still AHEAD of OUTPUT position `output_pos`, in playback order,
/// with the one being played through truncated to the part not yet played.
///
/// D-242 — the live audio mixer's own question. A play starts wherever the
/// playhead is, mid-clip and often mid-run, and the mixer needs the ramp from
/// *there*: it has no notion of a clip and cannot re-derive which runs are
/// behind it.
///
/// **The truncation is sign-aware, and that is the whole subtlety.** A forward
/// run is entered at its start and left at its end, so what remains of it is
/// `[current, end)` — its START moves. A REVERSED run is entered at its end and
/// left at its start, so what remains is `[start, current)` — its END moves.
/// Both are "drop the part already played", written once for each direction of
/// travel; getting this backwards would make a half-played reversed run replay
/// the half it had just finished.
///
/// A position at or past the ramp's end yields an empty list (nothing left to
/// play); a position at or before its start yields the whole ramp.
pub fn segments_from_output(segments: &[SpeedSegment], output_pos: f64) -> Vec<SpeedSegment> {
    let mut acc = 0.0;
    let mut out: Vec<SpeedSegment> = Vec::new();
    for s in segments {
        let out_len = s.output_len();
        if output_pos >= acc + out_len {
            acc += out_len;
            continue;
        }
        if out.is_empty() && output_pos > acc {
            // The run in progress: cut it at where playback has actually got
            // to, on whichever side that run is travelling away from.
            let current = s.anchor_source_frame() + (output_pos - acc) * s.speed;
            let mut partial = *s;
            if s.speed > 0.0 {
                partial.start_source_frame = current.floor() as i64;
            } else {
                partial.end_source_frame = current.ceil() as i64;
            }
            out.push(partial);
        } else {
            out.push(*s);
        }
        acc += out_len;
    }
    out
}

/// Which segment's (signed) speed governs OUTPUT position `output_pos` — the
/// sign [`quantized_source_frame_at_output`] needs. Outside the ramp the
/// first/last segment governs, for the same reason both maps extrapolate
/// there.
fn segment_speed_at_output(segments: &[SpeedSegment], output_pos: f64) -> f64 {
    let mut acc = 0.0;
    for (i, s) in segments.iter().enumerate() {
        let out_len = s.output_len();
        if output_pos < acc + out_len || i + 1 == segments.len() {
            return s.speed;
        }
        acc += out_len;
    }
    1.0
}

/// [`source_frame_at_output`] quantised to the integer SOURCE FRAME actually
/// shown — the form the live preview decodes with ([`crate::Clip::source_frame_at`]
/// is exactly this).
///
/// **The rounding rule depends on the direction of travel, and that is not a
/// detail.** A frame owns the half-open source interval `[n, n+1)`:
///
/// - Playing FORWARD, output sweeps that interval upward, so `floor` is the
///   frame on screen — and `setpts` floors by construction, which is why D-236
///   pinned this rule after a test failure rather than by reasoning.
/// - Playing in REVERSE (D-241), a segment `[a, b)` is entered at source `b`
///   and swept DOWN to `a`, so the continuous position ranges over `(a, b]` —
///   the mirror interval. `floor` there would show frame `b` (one past the
///   segment's own end) at the very first output frame and frame `a-1` at the
///   last. The mirror of `floor` is **`ceil - 1`**, which maps `(a, b]` onto
///   exactly `[a, b-1]` — the same frames, in the opposite order.
///
/// That is also precisely what the export produces: ffmpeg's `reverse` emits
/// the trimmed window's real decoded frames last-to-first, i.e. `b-1 … a`. The
/// two agree by construction, and `speedRamp.ffmpeg.test.ts` proves it against
/// decoded pixels. Exact mirror of `speedRamp.ts`'s
/// `quantizedSourceFrameAtOutput`.
pub fn quantized_source_frame_at_output(segments: &[SpeedSegment], output_pos: f64) -> f64 {
    let raw = source_frame_at_output(segments, output_pos);
    if segment_speed_at_output(segments, output_pos) < 0.0 {
        raw.ceil() - 1.0
    } else {
        raw.floor()
    }
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
        // every pre-D-236 call site computed inline.
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
    fn a_nonsense_speed_never_produces_an_infinite_or_frozen_remap() {
        // Zero and non-finite are the two that would break the remap outright
        // — an infinite output length, or a clip that never advances.
        for bad in [0.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert_eq!(clamp_speed(bad), 1.0, "clamp_speed({bad}) must be 1.0");
        }
        assert_eq!(clamp_speed(1000.0), MAX_SPEED);
        assert_eq!(clamp_speed(0.0001), MIN_SPEED);
    }

    // ---------------------------------------------------------------------- //
    // D-241 — reverse (negative) speed
    // ---------------------------------------------------------------------- //

    /// The same mixed ramp `speedRampReverse.ffmpeg.test.ts` proves against
    /// real decoded pixels: forward, backwards at 2x, forward.
    fn mixed_reverse() -> Vec<SpeedPoint> {
        vec![
            SpeedPoint {
                source_frame: 0,
                speed: 1.0,
            },
            SpeedPoint {
                source_frame: 24,
                speed: -2.0,
            },
            SpeedPoint {
                source_frame: 72,
                speed: 1.0,
            },
        ]
    }

    #[test]
    fn a_negative_speed_keeps_its_sign_and_clamps_only_its_magnitude() {
        assert_eq!(clamp_speed(-2.0), -2.0);
        assert_eq!(clamp_speed(-0.5), -0.5);
        assert_eq!(clamp_speed(-1000.0), -MAX_SPEED);
        assert_eq!(clamp_speed(-0.0001), -MIN_SPEED);
    }

    #[test]
    fn a_reversed_run_occupies_exactly_the_output_its_forward_twin_would() {
        let back = resolve_speed_segments(
            0,
            96,
            &[SpeedPoint {
                source_frame: 0,
                speed: -2.0,
            }],
            None,
        );
        let fwd = resolve_speed_segments(
            0,
            96,
            &[SpeedPoint {
                source_frame: 0,
                speed: 2.0,
            }],
            None,
        );
        assert_eq!(back[0].speed, -2.0);
        // The invariant that lets a sign flip never move a neighbouring clip.
        assert_eq!(
            ramp_output_source_frames(&back),
            ramp_output_source_frames(&fwd)
        );
        assert_eq!(ramp_output_source_frames(&back), 48.0);
    }

    #[test]
    fn a_reversed_run_is_never_flat_even_alone() {
        let back = resolve_speed_segments(
            0,
            96,
            &[SpeedPoint {
                source_frame: 0,
                speed: -2.0,
            }],
            None,
        );
        assert!(has_reverse_segments(&back));
        // Perfectly constant, and still not "flat": `PTS/-2` and `atempo=-2`
        // do not play a clip backwards, so it must not take the constant path.
        assert!(!segments_are_flat(&back));
    }

    #[test]
    fn a_reversed_run_enters_at_its_end_and_walks_down() {
        let segs = resolve_speed_segments(
            0,
            96,
            &[SpeedPoint {
                source_frame: 0,
                speed: -1.0,
            }],
            None,
        );
        assert_eq!(source_frame_at_output(&segs, 0.0), 96.0);
        assert_eq!(source_frame_at_output(&segs, 96.0), 0.0);
        // The `ceil - 1` mirror of `floor`: the first FRAME shown is 95 (96 is
        // not in the clip at all) and the last is 0 (not -1).
        assert_eq!(quantized_source_frame_at_output(&segs, 0.0), 95.0);
        assert_eq!(quantized_source_frame_at_output(&segs, 0.5), 95.0);
        assert_eq!(quantized_source_frame_at_output(&segs, 1.0), 94.0);
        assert_eq!(quantized_source_frame_at_output(&segs, 95.0), 0.0);
    }

    #[test]
    fn a_forward_run_still_quantises_by_plain_floor() {
        let segs = resolve_speed_segments(
            0,
            100,
            &[
                SpeedPoint {
                    source_frame: 0,
                    speed: 0.5,
                },
                SpeedPoint {
                    source_frame: 40,
                    speed: 3.0,
                },
            ],
            None,
        );
        for i in 0..120 {
            let x = i as f64 * 0.7;
            assert_eq!(
                quantized_source_frame_at_output(&segs, x),
                source_frame_at_output(&segs, x).floor(),
                "forward quantisation must stay exactly `floor` at output {x}"
            );
        }
    }

    #[test]
    fn the_two_directions_stay_exact_inverses_across_a_mixed_reverse_ramp() {
        let segs = resolve_speed_segments(0, 96, &mixed_reverse(), None);
        assert_eq!(ramp_output_source_frames(&segs), 72.0);
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
    fn segments_from_output_truncates_a_forward_run_at_its_start() {
        let segs = resolve_speed_segments(
            0,
            96,
            &[SpeedPoint {
                source_frame: 0,
                speed: 2.0,
            }],
            None,
        );
        // 10 output frames in at 2x = 20 source frames consumed.
        let left = segments_from_output(&segs, 10.0);
        assert_eq!(left, vec![seg(20, 96, 2.0)]);
        assert_eq!(ramp_output_source_frames(&left), 38.0);
    }

    #[test]
    fn segments_from_output_truncates_a_reversed_run_at_its_end_instead() {
        let segs = resolve_speed_segments(
            0,
            96,
            &[SpeedPoint {
                source_frame: 0,
                speed: -2.0,
            }],
            None,
        );
        // Entered at 96, 10 output frames in at 2x = down to source 76. What is
        // LEFT is `[0, 76)`, still reversed — the END moved, not the start.
        // Getting this backwards would replay the half just finished.
        let left = segments_from_output(&segs, 10.0);
        assert_eq!(left, vec![seg(0, 76, -2.0)]);
        assert_eq!(ramp_output_source_frames(&left), 38.0);
    }

    #[test]
    fn segments_from_output_drops_whole_runs_already_played_and_ends_empty() {
        let segs = resolve_speed_segments(0, 96, &mixed_reverse(), None);
        // Nothing played yet: the whole ramp.
        assert_eq!(segments_from_output(&segs, 0.0), segs);
        // 24 output frames in: the forward head is done, the reversed run is
        // untouched and entered at its own end.
        let left = segments_from_output(&segs, 24.0);
        assert_eq!(left, vec![seg(24, 72, -2.0), seg(72, 96, 1.0)]);
        // Mid-way through the reversed run (12 of its 24 output frames): it is
        // now `[24, 48)`, and the forward tail is still whole.
        let mid = segments_from_output(&segs, 36.0);
        assert_eq!(mid, vec![seg(24, 48, -2.0), seg(72, 96, 1.0)]);
        assert_eq!(ramp_output_source_frames(&mid), 36.0);
        // Past the end: nothing left to play.
        assert!(segments_from_output(&segs, 72.0).is_empty());
        assert!(segments_from_output(&segs, 1000.0).is_empty());
    }

    #[test]
    fn the_clip_helper_agrees_with_the_raw_segment_walk() {
        // `Clip::remaining_speed_segments` is what `chroma::audio` calls, and
        // it must be the same answer — it exists to stop that arithmetic being
        // re-spelled app-side, not to be a second definition of it.
        let c = crate::Clip {
            source_start: 0,
            duration: 96,
            source_fps: Some(24.0),
            start_frame: 100,
            speed_points: mixed_reverse(),
            ..Default::default()
        };
        let (runs, out_frames) = c.remaining_speed_segments(124, 24.0);
        assert_eq!(runs, segments_from_output(&c.speed_segments(), 24.0));
        assert_eq!(out_frames, 48.0);
        // Before the clip starts, the whole ramp is still ahead.
        let (all, total) = c.remaining_speed_segments(100, 24.0);
        assert_eq!(all, c.speed_segments());
        assert_eq!(total, 72.0);
    }
}

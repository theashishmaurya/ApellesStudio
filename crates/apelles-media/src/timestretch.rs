//! Pitch-preserving time-scaling of an already-mixed audio stream (D-278).
//!
//! **What it is:** one WSOLA (Waveform-Similarity Overlap-Add) stage that reads
//! `rate` seconds of input per second of output while leaving every sample's
//! *pitch* alone — the DSP behind the Edit tab's preview PLAYBACK-RATE control.
//! At 2x it plays the timeline twice as fast and a voice still sounds like that
//! voice, an octave lower than a plain resample would make it.
//!
//! **What it is NOT.** Not a clip property, not part of any render, not
//! reachable from the exporter: the only caller is [`crate::audio::run_session`],
//! which is the live preview mixer. A clip's own Speed/Retime ramp is a
//! completely different feature ([`crate::audio::AudioSpeedSegment`] →
//! `Retime`), it lives *per source* rather than post-mix, and it deliberately
//! VARISPEEDS (D-242). The two compose exactly as you would expect: a 2x clip
//! previewed at 2x playback advances through the file at 4x, pitched up one
//! octave by the clip's own ramp and not pitched at all by this stage.
//!
//! **Why WSOLA and not a resampler here, when D-242 chose the resampler
//! there.** D-242's varispeed argument is about a clip whose *recorded speed*
//! has been changed — tape behaviour is the semantically right answer there, and
//! it is what Premiere and Resolve do for a retimed clip by default. A transport
//! shuttle is the opposite case: nothing about the media changed, the editor is
//! just reviewing it faster, and the whole point is to still understand the
//! dialogue. That is also what the reference tools do — Premiere Pro's Audio
//! preferences carry a "Maintain pitch while Shuttling" option precisely for
//! JKL shuttling, with plain pitch-shifting described as the legacy behaviour
//! you opt back into. See D-278 for the full reference trail.
//!
//! **Why hand-written and not a crate.** The alternatives are C/C++ FFI
//! (SoundTouch, Signalsmith Stretch) — a build-system dependency and a licence
//! to carry for one algorithm that is ~120 lines and has an exactly testable
//! definition. See D-278.
//!
//! **Determinism.** Pure arithmetic over the input samples: no wall clock, no
//! randomness, no reduction whose order depends on anything but the input
//! length. The same input at the same rate produces identical output, which is
//! what lets [`TimeStretch`] be unit-tested against real correct answers
//! (output length, and a sine wave's frequency surviving) rather than eyeballed.

use std::collections::VecDeque;

/// Synthesis window, in milliseconds. The overlap-add hop is half of it.
///
/// 24 ms is the usual WSOLA operating point for speech and music: long enough
/// that one hop spans a pitch period down to ~85 Hz (a low male fundamental),
/// short enough that a transient is smeared over well under a video frame.
const WINDOW_MS: f64 = 24.0;

/// How far, in milliseconds, the similarity search may shift a segment from its
/// nominal position to find the best waveform alignment. 10 ms covers one full
/// period down to 100 Hz, which is what keeps periodic material (a vowel, a
/// bass note) from developing the periodic warble a fixed-hop OLA has.
const SEARCH_MS: f64 = 10.0;

/// Every Nth sample-frame is used in the similarity score. Decimating the
/// *search* (never the output) is standard: the score only has to rank lags, and
/// at 48 kHz consecutive frames are near-identical anyway. Cuts the search cost
/// by this factor with no audible change to the lag it picks.
const CORRELATION_STRIDE: usize = 2;

/// Rates at or inside this distance from 1.0 are the identity and get no stage
/// at all — see [`TimeStretch::new`].
const IDENTITY_EPSILON: f64 = 1e-6;

/// A constant-rate, pitch-preserving time-scaler over one interleaved
/// `f32` stream.
///
/// Push interleaved input, take interleaved output; the stage buffers whatever
/// it cannot yet turn into a whole synthesis hop. Output sample-frame 0
/// corresponds to input sample-frame 0 — the stage adds **no latency to the
/// stream**, only a start-up buffering requirement of about one window, which
/// the caller's own prefill already absorbs.
///
/// What it does NOT do: change channel count, change sample rate, apply any
/// gain (a crossfade of two samples each `<= 1` in magnitude is itself `<= 1`,
/// so it can introduce no clipping), or vary the rate over time. A rate change
/// is a new stage, which for the preview means a new play session — the same
/// re-baselining every other transport change already does.
pub struct TimeStretch {
    channels: usize,
    /// Synthesis hop, in sample-frames: how many frames each step emits.
    hop_out: usize,
    /// Analysis hop, in sample-frames: how many frames of input each step
    /// consumes, `hop_out * rate`. Fractional, so it is carried in
    /// [`Self::next_in`] rather than rounded per step (rounding per step would
    /// accumulate into real drift over a long session).
    hop_in: f64,
    /// Similarity-search half-width, in sample-frames.
    search: usize,
    /// Interleaved input not yet consumed.
    input: VecDeque<f32>,
    /// Absolute input sample-frame index of `input`'s first frame — what lets
    /// the window slide without renumbering [`Self::next_in`].
    base: u64,
    /// The next step's NOMINAL analysis position, in absolute input frames.
    /// Advances by exactly `hop_in` per step regardless of where the similarity
    /// search actually landed, which is what bounds WSOLA's drift.
    next_in: f64,
    /// The `hop_out` frames (interleaved) that the previous step's chosen
    /// segment continues into — the tail this step crossfades out of.
    carry: Vec<f32>,
    /// Whether the first segment has been emitted and `carry` is meaningful.
    primed: bool,
}

impl TimeStretch {
    /// Build a stage that consumes `rate` input seconds per output second at
    /// `sample_rate`, or `None` when there is nothing to do — a non-finite or
    /// non-positive rate, or 1.0, which is the identity and must not cost a
    /// crossfade. Deliberately the same "flat is not a second concept" exit
    /// `Retime::new` takes for an unramped clip.
    pub fn new(rate: f64, sample_rate: u32, channels: usize) -> Option<Self> {
        if !rate.is_finite() || rate <= 0.0 || (rate - 1.0).abs() < IDENTITY_EPSILON {
            return None;
        }
        if sample_rate == 0 || channels == 0 {
            return None;
        }
        let frames_in = |ms: f64| ((ms / 1000.0) * sample_rate as f64).round() as usize;
        let hop_out = frames_in(WINDOW_MS / 2.0).max(1);
        // Never search further than one hop: a lag beyond that would let a step
        // pick a segment the NEXT step has already passed, which reads as a
        // stutter rather than as a better alignment.
        let search = frames_in(SEARCH_MS).min(hop_out);
        Some(Self {
            channels,
            hop_out,
            hop_in: hop_out as f64 * rate,
            search,
            input: VecDeque::new(),
            base: 0,
            next_in: 0.0,
            carry: Vec::new(),
            primed: false,
        })
    }

    /// Feed interleaved input; get back however much interleaved output that
    /// made available. Returns an empty `Vec` while the stage is still filling
    /// its first window — normal, and not an error.
    pub fn push(&mut self, samples: &[f32]) -> Vec<f32> {
        self.input.extend(samples.iter().copied());
        // `rate` output frames' worth of input yields ~1/rate of it back, and
        // the hop is fixed, so this is the exact count for a slow rate and an
        // over-estimate that never reallocates for a fast one.
        let mut out = Vec::with_capacity(samples.len().max(self.hop_out * self.channels));
        while self.step(&mut out) {}
        self.trim();
        out
    }

    /// End of stream: emit the crossfade tail still held in `carry` so the last
    /// segment is not simply cut off mid-fade.
    ///
    /// Up to about one window (`WINDOW_MS`) of trailing *input* is deliberately
    /// dropped — there is not enough of it left to align a segment against, and
    /// the alternative (emitting an unaligned final hop) is the one place WSOLA
    /// audibly clicks. 24 ms, at the moment the transport is stopping anyway.
    ///
    /// Leaves the stage re-primeable rather than poisoned: a later [`Self::push`]
    /// starts a fresh first segment from whatever input arrives next. Nothing in
    /// the preview does that today (a session flushes once, at its end), but a
    /// stage that panicked on a push after a flush would be a trap for the next
    /// caller.
    pub fn flush(&mut self) -> Vec<f32> {
        self.primed = false;
        std::mem::take(&mut self.carry)
    }

    /// Emit one synthesis hop if there is enough input for it; `false` means
    /// "need more input", which is the only reason [`Self::push`] ever stops.
    fn step(&mut self, out: &mut Vec<f32>) -> bool {
        let ch = self.channels;
        if !self.primed {
            // The first segment has nothing to align against: emit it from
            // input frame 0 verbatim and seed `carry` with what it runs into.
            if self.available_from(self.base) < 2 * self.hop_out {
                return false;
            }
            out.extend(self.frames(self.base, self.hop_out));
            self.carry = self
                .frames(self.base + self.hop_out as u64, self.hop_out)
                .collect();
            self.next_in = self.base as f64 + self.hop_in;
            self.primed = true;
            return true;
        }

        // The window this step may pick from: the nominal position, plus or
        // minus the search width, plus the two hops a chosen segment spans (the
        // head that is crossfaded in and the tail that becomes the next
        // `carry`).
        let nominal = self.next_in.floor().max(0.0) as u64;
        let lo = nominal.saturating_sub(self.search as u64).max(self.base);
        let span = (nominal + self.search as u64 + 2 * self.hop_out as u64).saturating_sub(lo);
        if self.available_from(lo) < span as usize {
            return false;
        }

        let chosen = self.best_lag(lo, nominal);
        let head: Vec<f32> = self.frames(chosen, self.hop_out).collect();
        debug_assert_eq!(head.len(), self.hop_out * ch);
        // Linear equal-gain crossfade from the previous segment's continuation
        // into the newly-aligned one. Convex, so `|out| <= max(|carry|, |head|)`
        // and no limiter is needed after this stage.
        for i in 0..self.hop_out {
            let w = i as f32 / self.hop_out as f32;
            for c in 0..ch {
                let k = i * ch + c;
                out.push(self.carry[k] * (1.0 - w) + head[k] * w);
            }
        }
        self.carry = self
            .frames(chosen + self.hop_out as u64, self.hop_out)
            .collect();
        self.next_in += self.hop_in;
        true
    }

    /// The absolute input frame, within `+/- search` of `nominal`, whose next
    /// `hop_out` frames best continue [`Self::carry`].
    ///
    /// Scored by normalised cross-correlation — `sum(a*b) / sqrt(sum(a*a))`,
    /// the standard WSOLA criterion. The normalisation matters: an unnormalised
    /// score just picks whichever candidate is LOUDEST, which on a fade or an
    /// onset is systematically the wrong lag.
    fn best_lag(&self, lo: u64, nominal: u64) -> u64 {
        let ch = self.channels;
        let hi = nominal + self.search as u64;
        let mut best = nominal;
        let mut best_score = f32::NEG_INFINITY;
        for cand in lo..=hi {
            let start = ((cand - self.base) as usize) * ch;
            let mut dot = 0.0f32;
            let mut energy = 0.0f32;
            let mut i = 0;
            while i < self.hop_out {
                let k = i * ch;
                // Mono-summed for the score, but the lag it picks is applied to
                // every channel alike — a per-channel lag would smear the
                // stereo image.
                let mut a = 0.0f32;
                let mut b = 0.0f32;
                for c in 0..ch {
                    a += self.input[start + k + c];
                    b += self.carry[k + c];
                }
                dot += a * b;
                energy += a * a;
                i += CORRELATION_STRIDE;
            }
            let score = dot / (energy.sqrt() + 1e-9);
            if score > best_score {
                best_score = score;
                best = cand;
            }
        }
        best
    }

    /// Interleaved samples for `count` frames starting at absolute frame `from`.
    /// Callers have already checked availability via [`Self::available_from`].
    fn frames(&self, from: u64, count: usize) -> impl Iterator<Item = f32> + '_ {
        let start = ((from - self.base) as usize) * self.channels;
        (start..start + count * self.channels).map(|i| self.input[i])
    }

    /// How many whole sample-frames of buffered input sit at or after absolute
    /// frame `from`. Zero once `from` is past the end.
    fn available_from(&self, from: u64) -> usize {
        let held = self.input.len() / self.channels;
        let offset = from.saturating_sub(self.base) as usize;
        held.saturating_sub(offset)
    }

    /// Drop input no future step can read: everything before the earliest frame
    /// the next similarity search may reach.
    fn trim(&mut self) {
        if !self.primed {
            return; // nothing consumed yet; the priming step still reads frame `base`
        }
        let keep_from = (self.next_in.floor().max(0.0) as u64).saturating_sub(self.search as u64);
        if keep_from <= self.base {
            return;
        }
        let drop_frames = (keep_from - self.base) as usize;
        let drop_samples = (drop_frames * self.channels).min(self.input.len());
        self.input.drain(..drop_samples);
        self.base += (drop_samples / self.channels) as u64;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: u32 = 48_000;

    fn sine(freq: f64, frames: usize, channels: usize) -> Vec<f32> {
        let mut out = Vec::with_capacity(frames * channels);
        for i in 0..frames {
            let v = (2.0 * std::f64::consts::PI * freq * i as f64 / RATE as f64).sin() as f32;
            for _ in 0..channels {
                out.push(v);
            }
        }
        out
    }

    /// Fundamental frequency by counting positive-going zero crossings — enough
    /// to tell 440 Hz from 880 Hz, which is the whole point of the test.
    fn zero_crossing_hz(samples: &[f32], channels: usize) -> f64 {
        let frames: Vec<f32> = samples.chunks(channels).map(|f| f[0]).collect();
        // Skip the head and tail: the priming segment and the flush tail are
        // real output but are not steady state.
        let skip = RATE as usize / 50;
        if frames.len() < 2 * skip + 100 {
            return 0.0;
        }
        let body = &frames[skip..frames.len() - skip];
        let crossings = body
            .windows(2)
            .filter(|w| w[0] <= 0.0 && w[1] > 0.0)
            .count();
        crossings as f64 * RATE as f64 / body.len() as f64
    }

    #[test]
    fn identity_and_nonsense_rates_get_no_stage() {
        assert!(TimeStretch::new(1.0, RATE, 2).is_none());
        assert!(TimeStretch::new(f64::NAN, RATE, 2).is_none());
        assert!(TimeStretch::new(0.0, RATE, 2).is_none());
        assert!(TimeStretch::new(-2.0, RATE, 2).is_none());
        assert!(TimeStretch::new(2.0, 0, 2).is_none());
        assert!(TimeStretch::new(2.0, RATE, 0).is_none());
        assert!(TimeStretch::new(2.0, RATE, 2).is_some());
    }

    /// The contract: `rate` seconds in, one second out.
    #[test]
    fn output_length_is_input_over_rate() {
        for (rate, channels) in [(2.0, 2), (3.0, 2), (4.0, 1), (0.5, 2)] {
            let mut st = TimeStretch::new(rate, RATE, channels).expect("stage");
            let in_frames = RATE as usize * 4; // 4 seconds
            let input = sine(440.0, in_frames, channels);
            let mut out = st.push(&input);
            out.extend(st.flush());
            let out_frames = out.len() / channels;
            let want = in_frames as f64 / rate;
            let err = (out_frames as f64 - want).abs() / want;
            assert!(
                err < 0.02,
                "rate {rate}, {channels}ch: {out_frames} output frames, wanted ~{want:.0} ({:.1}% off)",
                err * 100.0
            );
        }
    }

    /// The whole reason this module exists rather than a resampler: the pitch
    /// does NOT move with the rate. A plain resample at 2x would read 880 Hz
    /// here; WSOLA reads 440 Hz.
    #[test]
    fn pitch_is_preserved_at_every_rate() {
        for rate in [0.5, 2.0, 3.0, 4.0] {
            let mut st = TimeStretch::new(rate, RATE, 2).expect("stage");
            let input = sine(440.0, RATE as usize * 3, 2);
            let mut out = st.push(&input);
            out.extend(st.flush());
            let hz = zero_crossing_hz(&out, 2);
            assert!(
                (hz - 440.0).abs() < 20.0,
                "rate {rate}: measured {hz:.1} Hz, wanted 440 Hz (a resampler would give {:.0})",
                440.0 * rate
            );
        }
    }

    /// Chunked feeding must produce exactly what one big push does — the mixer
    /// hands this stage 1024-frame chunks, not whole seconds.
    #[test]
    fn chunked_push_matches_one_big_push() {
        let input = sine(300.0, RATE as usize, 2);
        let mut whole = TimeStretch::new(2.0, RATE, 2).expect("stage");
        let mut a = whole.push(&input);
        a.extend(whole.flush());

        let mut chunked = TimeStretch::new(2.0, RATE, 2).expect("stage");
        let mut b = Vec::new();
        for chunk in input.chunks(1024 * 2) {
            b.extend(chunked.push(chunk));
        }
        b.extend(chunked.flush());

        assert_eq!(a.len(), b.len());
        assert_eq!(a, b, "the stage must be chunk-size independent");
    }

    /// Determinism, spelled out as a test because the render/preview rule
    /// demands it: same input, same rate, identical output.
    #[test]
    fn is_deterministic() {
        let input = sine(220.0, RATE as usize, 2);
        let run = || {
            let mut st = TimeStretch::new(3.0, RATE, 2).expect("stage");
            let mut o = st.push(&input);
            o.extend(st.flush());
            o
        };
        assert_eq!(run(), run());
    }

    /// A crossfade of two samples each within `[-1, 1]` cannot leave it, so the
    /// stage can neither clip nor need a limiter after it.
    #[test]
    fn never_exceeds_its_input_range() {
        let mut st = TimeStretch::new(2.5, RATE, 2).expect("stage");
        let input = sine(1000.0, RATE as usize, 2);
        let mut out = st.push(&input);
        out.extend(st.flush());
        assert!(out.iter().all(|s| s.abs() <= 1.0 + 1e-6));
    }

    /// Silence in, silence out — and no panic on a stream far shorter than one
    /// window, which is what a clip ending right under the playhead looks like.
    #[test]
    fn handles_short_and_silent_input() {
        let mut st = TimeStretch::new(4.0, RATE, 2).expect("stage");
        assert!(
            st.push(&[0.0; 64]).is_empty(),
            "under one window: no output yet"
        );
        let out = st.push(&vec![0.0f32; RATE as usize]);
        assert!(!out.is_empty());
        assert!(out.iter().all(|s| *s == 0.0));
    }

    /// Buffered input must not grow without bound over a long session — the
    /// stage is fed for as long as playback runs.
    #[test]
    fn buffered_input_stays_bounded() {
        let mut st = TimeStretch::new(2.0, RATE, 2).expect("stage");
        let chunk = sine(440.0, 1024, 2);
        for _ in 0..600 {
            // ~13 seconds of input
            let _ = st.push(&chunk);
        }
        let held = st.input.len() / 2;
        assert!(
            held < 4 * st.hop_out + st.search + 2048,
            "held {held} frames — the trim is not keeping up"
        );
    }
}

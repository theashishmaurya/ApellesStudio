//! Speech-probability frames → silence spans (D-318).
//!
//! **What this is.** The pure half of silence detection: a hysteresis state
//! machine that turns a per-frame speech-probability sequence (whatever
//! produced it) into the spans of a clip where nobody is talking.
//!
//! **What it does NOT do.** It never loads a model, never touches audio, never
//! reads a file and never looks at a timeline. It takes `&[f32]` in and returns
//! spans in seconds, which is exactly why the interesting behaviour here — the
//! two-threshold hysteresis, the minimum-speech and minimum-silence rules, the
//! padding and the merge — is unit-testable against known-correct answers with
//! no ONNX Runtime in the loop. [`crate::vad`] is the half that needs the model.
//!
//! **Why hysteresis and not a single threshold.** A single `p >= 0.5` test
//! chatters: real speech dips below it inside a word (a stop consonant, a
//! breath) and a single dipped frame would split one sentence into two spans
//! and invent a "silence" that no human would cut on. Entering speech on a high
//! threshold and only leaving it on a lower one — and then only after the low
//! run has itself lasted `min_silence` — is the shape silero-vad's own
//! `get_speech_timestamps` uses, and this is a deliberate port of that
//! behaviour rather than a fresh invention (D-319 records the version pin and
//! why the defaults are what they are).
//!
//! Spans come back in **seconds**, not frames: this crate has no business
//! knowing a timeline's fps. The op layer converts (D-318).

use serde::{Deserialize, Serialize};

/// A half-open span of time within the analysed audio, in seconds from the
/// start of the analysed range.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Span {
    pub start_secs: f64,
    pub end_secs: f64,
}

impl Span {
    pub fn duration_secs(&self) -> f64 {
        (self.end_secs - self.start_secs).max(0.0)
    }
}

/// Tuning for [`silence_spans`].
///
/// Every default here is silero-vad's own published default except
/// `min_silence_ms`, which is deliberately longer — see its field doc.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SilenceParams {
    /// Probability at or above which a frame *starts* a speech run.
    pub threshold: f32,
    /// Probability below which a frame may *end* one. Strictly below
    /// [`Self::threshold`]; the gap between them is the hysteresis band.
    pub neg_threshold: f32,
    /// A speech run shorter than this is discarded as a click/thump rather than
    /// treated as a real utterance — which means the silence either side of it
    /// merges into one span instead of being split in two by a non-word.
    pub min_speech_ms: f64,
    /// A silence shorter than this is not reported at all.
    ///
    /// silero's own default is 100 ms, which is a *pause inside a sentence* and
    /// useless as a cut point. 600 ms is the brief's default and roughly the
    /// shortest gap a person reads as "they stopped talking" rather than "they
    /// took a breath".
    pub min_silence_ms: f64,
    /// Speech runs are grown by this much at each end before the silences are
    /// taken as the complement, so a cut never clips the attack of the first
    /// word or the decay of the last one.
    pub speech_pad_ms: f64,
}

impl Default for SilenceParams {
    fn default() -> Self {
        Self {
            threshold: 0.5,
            neg_threshold: 0.35,
            min_speech_ms: 250.0,
            min_silence_ms: 600.0,
            speech_pad_ms: 30.0,
        }
    }
}

/// The speech runs found in `probs`, in seconds, after hysteresis, the
/// minimum-speech rule, padding and merging.
///
/// `frame_secs` is the hop between consecutive probabilities (for Silero at
/// 16 kHz with a 512-sample hop, 0.032 s). `total_secs` is the duration of the
/// analysed range, used to clamp the padded tail — it is passed in rather than
/// derived as `probs.len() * frame_secs` because a trailing partial frame is
/// real audio that produced no probability.
pub fn speech_spans(
    probs: &[f32],
    frame_secs: f64,
    total_secs: f64,
    p: &SilenceParams,
) -> Vec<Span> {
    if probs.is_empty() || frame_secs <= 0.0 {
        return Vec::new();
    }

    // 1. Hysteresis: walk the frames, tracking whether we are inside a speech
    //    run and, if so, where the current below-neg_threshold run began.
    let min_silence_frames = (p.min_silence_ms / (frame_secs * 1000.0)).ceil().max(1.0) as usize;
    let mut runs: Vec<(usize, usize)> = Vec::new();
    let mut start: Option<usize> = None;
    let mut tentative_end: Option<usize> = None;

    for (i, &prob) in probs.iter().enumerate() {
        match start {
            None => {
                if prob >= p.threshold {
                    start = Some(i);
                    tentative_end = None;
                }
            }
            Some(s) => {
                if prob < p.neg_threshold {
                    match tentative_end {
                        None => tentative_end = Some(i),
                        Some(t) => {
                            if i - t + 1 >= min_silence_frames {
                                runs.push((s, t));
                                start = None;
                                tentative_end = None;
                            }
                        }
                    }
                } else {
                    // Climbed back above the floor — the pause was not long
                    // enough to end the run, so forget it.
                    tentative_end = None;
                }
            }
        }
    }
    if let Some(s) = start {
        runs.push((s, probs.len()));
    }

    // 2. Drop runs too short to be a real utterance, and convert to seconds.
    let min_speech_secs = p.min_speech_ms / 1000.0;
    let pad_secs = p.speech_pad_ms / 1000.0;
    let mut spans: Vec<Span> = runs
        .into_iter()
        .map(|(a, b)| (a as f64 * frame_secs, b as f64 * frame_secs))
        .filter(|(a, b)| b - a >= min_speech_secs)
        // 3. Pad, clamped to the analysed range.
        .map(|(a, b)| Span {
            start_secs: (a - pad_secs).max(0.0),
            end_secs: (b + pad_secs).min(total_secs),
        })
        .collect();

    // 4. Padding can make neighbours touch or overlap; merge them so the
    //    complement below can never emit a negative-length span.
    let mut merged: Vec<Span> = Vec::with_capacity(spans.len());
    for span in spans.drain(..) {
        match merged.last_mut() {
            Some(last) if span.start_secs <= last.end_secs => {
                last.end_secs = last.end_secs.max(span.end_secs);
            }
            _ => merged.push(span),
        }
    }
    merged
}

/// The silences in `probs` — the complement of [`speech_spans`] within
/// `[0, total_secs]`, keeping only spans at least `min_silence_ms` long.
///
/// A clip with no speech at all yields one span covering the whole range; a
/// clip that is speech throughout yields none.
pub fn silence_spans(
    probs: &[f32],
    frame_secs: f64,
    total_secs: f64,
    p: &SilenceParams,
) -> Vec<Span> {
    // No probabilities means the audio was never scored — not that it was
    // quiet. Returning "the whole range is silent" here would be a guess
    // dressed as a measurement, and the caller's next move is to offer that
    // span for deletion, so the safe answer is the empty one.
    if probs.is_empty() {
        return Vec::new();
    }

    let min_silence_secs = p.min_silence_ms / 1000.0;
    let speech = speech_spans(probs, frame_secs, total_secs, p);

    let mut out = Vec::new();
    let mut cursor = 0.0_f64;
    for s in &speech {
        if s.start_secs > cursor {
            out.push(Span {
                start_secs: cursor,
                end_secs: s.start_secs,
            });
        }
        cursor = cursor.max(s.end_secs);
    }
    if total_secs > cursor {
        out.push(Span {
            start_secs: cursor,
            end_secs: total_secs,
        });
    }

    out.retain(|s| s.duration_secs() >= min_silence_secs);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 32 ms/frame is the real Silero-at-16 kHz hop; using it here keeps the
    /// hand-computed expectations below in the same units as the real thing.
    const FRAME: f64 = 0.032;

    fn params() -> SilenceParams {
        SilenceParams::default()
    }

    /// Build a probability track from (value, repeat) runs.
    fn track(runs: &[(f32, usize)]) -> Vec<f32> {
        runs.iter()
            .flat_map(|&(v, n)| std::iter::repeat_n(v, n))
            .collect()
    }

    #[test]
    fn all_speech_has_no_silence() {
        let p = track(&[(0.99, 100)]);
        assert!(silence_spans(&p, FRAME, 100.0 * FRAME, &params()).is_empty());
    }

    #[test]
    fn all_quiet_is_one_silence_covering_everything() {
        let p = track(&[(0.01, 100)]);
        let total = 100.0 * FRAME;
        let sil = silence_spans(&p, FRAME, total, &params());
        assert_eq!(sil.len(), 1);
        assert_eq!(sil[0].start_secs, 0.0);
        assert_eq!(sil[0].end_secs, total);
    }

    #[test]
    fn empty_input_yields_nothing() {
        assert!(silence_spans(&[], FRAME, 1.0, &params()).is_empty());
    }

    /// The headline case: speech, a long gap, speech. The gap must come back as
    /// exactly one span, shrunk at both ends by `speech_pad_ms`.
    #[test]
    fn one_long_gap_between_two_utterances() {
        // 30 frames speech (0.96s), 40 frames quiet (1.28s), 30 frames speech.
        let p = track(&[(0.99, 30), (0.01, 40), (0.99, 30)]);
        let total = 100.0 * FRAME;
        let sil = silence_spans(&p, FRAME, total, &params());
        assert_eq!(sil.len(), 1, "expected exactly one silence, got {sil:?}");
        // Speech run 1 ends at frame 30 → 0.96s, padded out by 0.03 → 0.99s.
        assert!((sil[0].start_secs - 0.99).abs() < 1e-9, "{:?}", sil[0]);
        // Speech run 2 starts at frame 70 → 2.24s, padded back by 0.03 → 2.21s.
        assert!((sil[0].end_secs - 2.21).abs() < 1e-9, "{:?}", sil[0]);
    }

    /// A gap shorter than `min_silence_ms` is a breath, not a cut point. It must
    /// not end the speech run, so nothing is reported at all.
    #[test]
    fn short_gap_is_not_a_silence() {
        // 10 frames quiet = 320ms, well under the 600ms default.
        let p = track(&[(0.99, 30), (0.01, 10), (0.99, 30)]);
        let sil = silence_spans(&p, FRAME, 70.0 * FRAME, &params());
        assert!(
            sil.is_empty(),
            "a 320ms breath should not be a silence: {sil:?}"
        );
    }

    /// The hysteresis band itself: a frame that dips between `neg_threshold`
    /// and `threshold` is still speech and must not even start a pause.
    #[test]
    fn dip_inside_the_hysteresis_band_does_not_break_speech() {
        let p = track(&[(0.99, 20), (0.40, 30), (0.99, 20)]);
        let sil = silence_spans(&p, FRAME, 70.0 * FRAME, &params());
        assert!(
            sil.is_empty(),
            "0.40 is above neg_threshold, still speech: {sil:?}"
        );
    }

    /// A blip of "speech" too short to be a word must not split one long
    /// silence into two — the min-speech rule drops it and the silences merge.
    #[test]
    fn sub_minimum_speech_blip_does_not_split_a_silence() {
        // 3 frames = 96ms of "speech", under the 250ms floor.
        let p = track(&[(0.01, 40), (0.99, 3), (0.01, 40)]);
        let total = 83.0 * FRAME;
        let sil = silence_spans(&p, FRAME, total, &params());
        assert_eq!(
            sil.len(),
            1,
            "the blip should not split the silence: {sil:?}"
        );
        assert_eq!(sil[0].start_secs, 0.0);
        assert_eq!(sil[0].end_secs, total);
    }

    /// Leading and trailing silence are real and must be reported — the speaker
    /// starting late and the camera rolling on after they finish is exactly the
    /// dead air this feature exists to find.
    #[test]
    fn leading_and_trailing_silence_are_reported() {
        let p = track(&[(0.01, 30), (0.99, 30), (0.01, 30)]);
        let total = 90.0 * FRAME;
        let sil = silence_spans(&p, FRAME, total, &params());
        assert_eq!(sil.len(), 2, "{sil:?}");
        assert_eq!(sil[0].start_secs, 0.0);
        assert!(
            (sil[0].end_secs - (0.96 - 0.03)).abs() < 1e-9,
            "{:?}",
            sil[0]
        );
        assert!(
            (sil[1].start_secs - (1.92 + 0.03)).abs() < 1e-9,
            "{:?}",
            sil[1]
        );
        assert_eq!(sil[1].end_secs, total);
    }

    /// Padding must never push a span past the analysed range.
    #[test]
    fn padding_is_clamped_to_the_analysed_range() {
        let p = track(&[(0.99, 50)]);
        let total = 50.0 * FRAME;
        let speech = speech_spans(&p, FRAME, total, &params());
        assert_eq!(speech.len(), 1);
        assert_eq!(speech[0].start_secs, 0.0, "cannot pad below zero");
        assert_eq!(speech[0].end_secs, total, "cannot pad past the end");
    }

    /// `min_silence_ms` is a real knob, not decoration: the same track yields a
    /// gap at a low setting and nothing at a high one.
    #[test]
    fn min_silence_threshold_is_honoured() {
        let p = track(&[(0.99, 30), (0.01, 25), (0.99, 30)]);
        let total = 85.0 * FRAME;

        let lenient = SilenceParams {
            min_silence_ms: 400.0,
            ..params()
        };
        assert_eq!(silence_spans(&p, FRAME, total, &lenient).len(), 1);

        let strict = SilenceParams {
            min_silence_ms: 1500.0,
            ..params()
        };
        assert!(silence_spans(&p, FRAME, total, &strict).is_empty());
    }
}

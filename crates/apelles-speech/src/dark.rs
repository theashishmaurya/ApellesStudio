//! Dark regions — "there is speech here that nobody transcribed" (D-349, B-216).
//!
//! **What this is.** The cross-check between two signals the app already has
//! and has never compared: the **transcript** (what Whisper read) and the
//! **VAD** (where there is actually a voice). Where the second says *speech* and
//! the first says *nothing*, a multi-second region of real, audible dialogue has
//! been silently dropped. This module finds those regions.
//!
//! **Why it has to exist at all.** Whisper's whole-file pass does not merely
//! mis-hear such regions, it emits no tokens for them, inside a 30 s window it
//! is otherwise decoding confidently — measured at temperature 0.0, with
//! `no_speech_prob` 0.043-0.171 against a 0.6 threshold and `avg_logprob`
//! -0.249 to -0.460 against a -1.0 threshold. Nothing in whisper's own
//! machinery notices, so there is no error, no warning and no low-confidence
//! score to filter on. Worse, the loss is **biased towards near-duplicate
//! repeated material** — i.e. towards retakes, which is precisely what
//! [`crate::retake`] exists to find. Rate on real footage: roughly one dropped
//! multi-second region per three minutes of raw source, across two independent
//! camera originals. The full trail, with every measurement:
//! `docs/notes/whisper-dark-region-research.md`.
//!
//! **The stretched word is the trap, and it is load-bearing here.** B-216's
//! first formulation was "a stretch of ≥1.2 s with *no transcript word in it*".
//! Taken literally that misses more than half the real cases, because the DTW
//! alignment spreads the few tokens that *were* emitted across the hole — so the
//! gap does contain a word, one word, 3-5 s long. A word longer than
//! [`DarkParams::max_word_secs`] therefore contributes **no coverage**. That
//! bound is whisper's own anomaly threshold for a too-long word
//! (`mlx_whisper/transcribe.py`'s `if duration > 2.0`), not a number picked to
//! fit: it took the candidate count from 2 to 4 on one real file and 4 to 9 on
//! another.
//!
//! **What it does NOT do.** It does not transcribe, decode, read a file or load
//! a model — it is handed word times, speech probabilities and an amplitude
//! envelope, and returns spans in seconds, which is what makes every decision in
//! here testable against known-correct answers. It does not cut anything and it
//! does not repair the transcript either: recovering the words is an isolated
//! re-transcription of the located window, which is the app's job (the sidecar's
//! `start_secs`/`duration_secs`) and not this crate's.
//!
//! ## The algorithm, and why each part of it is here
//!
//! Every threshold below was scored over **111 labelled windows** — every
//! uncovered stretch ≥1.2 s in two real sources, each one cut out,
//! re-transcribed in isolation and RMS-profiled to make ground truth rather than
//! assume it.
//!
//! 1. **Coverage.** Merge the transcript's words into intervals, excluding any
//!    word longer than [`DarkParams::max_word_secs`] (above).
//! 2. **Uncovered stretches.** The complement of that coverage inside the
//!    analysed range.
//! 3. **Sum, do not require contiguity.** For each stretch, add up the VAD
//!    speech overlapping it and flag at [`DarkParams::min_dark_secs`]. Requiring
//!    one *contiguous* ≥1.2 s speech span instead misses a real case measured on
//!    c040: 3.4 s covered only by a 3.40 s stretched ` itself`, holding 0.47 s of
//!    speech, a 1.96 s pause, then 0.97 s — 1.44 s of unread speech, no single
//!    piece of it ≥1.2 s, and an isolated pass recovers a real retake from it.
//!    1.2 s itself sits on a plateau (identical candidate counts from 1.0 s to
//!    1.5 s on both files), so it is not a knife edge.
//! 4. **The RMS gate, calibrated per file.** Every false positive in both files
//!    is a quiet artefact — peaks of 113-605 against true positives at
//!    1407-2879. Requiring the stretch's own RMS peak to reach the floor the
//!    file's *correctly transcribed* speech already sits at removes all of them
//!    at zero cost to recall: 72.7 % → 100 % precision on the simpler variant,
//!    90 % on this one. **Per file, never a constant** — mic, gain and room
//!    differ per shoot, which is exactly why the floor is derived from the
//!    recording itself ([`DarkReport::rms_floor`]).
//! 5. **Locate with the intersections.** A flagged stretch can be coarse (one
//!    real case merges into a 15.16 s stretch), so the *regions* reported are
//!    the VAD∩stretch intersections — gate with the sum, locate with the pieces.
//!
//! Measured on that corpus: **90 % precision**, and against a Silero-independent
//! energy criterion (≥1.2 s of speech-level RMS, which shares no input with the
//! detector) **no region was missed** in 1676 s of real footage.
//!
//! **Determinism.** Pure, total, and free of any iteration over a hash
//! container — the same inputs give byte-identical output, which is this repo's
//! standing invariant and is pinned by a test.

use serde::{Deserialize, Serialize};

use crate::silence::{SilenceParams, Span, speech_spans};

/// One transcript word, reduced to the only thing coverage cares about.
///
/// Deliberately not the word's text: a dark region is defined by *where nobody
/// read anything*, and carrying the text would invite a caller to filter on it
/// (a word that is punctuation, say) and make the answer depend on the model's
/// tokenisation.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct WordSpan {
    pub start_secs: f64,
    pub end_secs: f64,
}

impl WordSpan {
    fn duration_secs(&self) -> f64 {
        self.end_secs - self.start_secs
    }
}

/// Tuning for [`detect_dark_regions`]. Every default is the measured
/// recommendation from the 111-window scoring described in the module doc.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct DarkParams {
    /// A transcript word longer than this contributes **no coverage**.
    ///
    /// 2.0 s is whisper's own anomaly bound for a too-long word, and the rule is
    /// load-bearing rather than a refinement — see the module doc. Only 5 of 925
    /// words in one real file and 16 of 1320 in another exceed it, so this is
    /// not a blunt instrument.
    pub max_word_secs: f64,
    /// Flag an uncovered stretch once the VAD speech inside it **sums** to at
    /// least this. 1.2 s, on a measured plateau from 1.0 s to 1.5 s.
    pub min_dark_secs: f64,
    /// A located region shorter than this is not reported.
    ///
    /// This filters the OUTPUT, never the threshold above: an uncovered stretch
    /// is bounded by transcript words, so the speech span at either edge is
    /// usually the *neighbouring* utterance clipped to a sliver — a 30 ms tail
    /// of speech the transcript did read, not a region anybody can re-transcribe
    /// or act on. Those slivers still count towards
    /// [`Self::min_dark_secs`] (they are genuinely unaccounted-for speech);
    /// they just do not become findings. The default matches
    /// [`SilenceParams::min_speech_ms`] — the crate's existing answer to "how
    /// short is too short to be an utterance".
    pub min_region_secs: f64,
    /// Multiplier on the calibrated RMS floor. 1.0 uses the file's own floor as
    /// measured; below 1.0 trades precision for recall.
    pub rms_floor_scale: f64,
    /// Fraction of a VAD speech span that must be covered by transcript words
    /// before that span counts as "whisper read this one correctly" and can
    /// calibrate the floor.
    pub calibration_coverage: f64,
    /// A calibration span shorter than this is a fragment, not an utterance, and
    /// its peak is not evidence about the file's speech level.
    pub min_calibration_span_secs: f64,
    /// How many calibration spans are needed before the gate is applied at all.
    ///
    /// Below this the report comes back with [`DarkReport::rms_floor`] `None`
    /// and **no gate** — an ungated answer that says so is honest, where a floor
    /// derived from one span would be a guess dressed as a measurement.
    pub min_calibration_spans: usize,
    /// Which calibration peak becomes the floor, as a fraction in `[0, 1]`
    /// (nearest-rank). **0.0 — the quietest speech the pass read correctly — is
    /// what was measured** (p0 = 1062 and 797 on the two real files); the knob
    /// exists so a caller can trade recall for precision without re-deriving the
    /// calibration.
    pub calibration_percentile: f64,
    /// How the VAD probability track is turned into speech spans. The crate's
    /// own defaults, so a dark region and a silence are measured against
    /// literally the same speech model rather than two that can drift.
    pub silence: SilenceParams,
}

impl Default for DarkParams {
    fn default() -> Self {
        Self {
            max_word_secs: 2.0,
            min_dark_secs: 1.2,
            min_region_secs: SilenceParams::default().min_speech_ms / 1000.0,
            rms_floor_scale: 1.0,
            calibration_coverage: 0.8,
            min_calibration_span_secs: 0.5,
            min_calibration_spans: 3,
            calibration_percentile: 0.0,
            silence: SilenceParams::default(),
        }
    }
}

/// One located region of speech that the transcript does not account for, in
/// **absolute source seconds**.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct DarkRegion {
    /// The region itself: one VAD speech span, clipped to the uncovered stretch
    /// it sits in. This is the window to re-transcribe.
    pub start_secs: f64,
    pub end_secs: f64,
    /// The uncovered stretch this region was found in. Reported because it is
    /// what actually cleared [`DarkParams::min_dark_secs`], and because it is
    /// usually wider than the region — a caller re-transcribing with context
    /// wants to know how much room it has.
    pub stretch_start_secs: f64,
    pub stretch_end_secs: f64,
    /// Total VAD speech across the whole stretch — the number that cleared the
    /// threshold, not this region's own duration.
    pub stretch_speech_secs: f64,
    /// Peak RMS over the stretch, in the same units as
    /// [`DarkReport::rms_floor`].
    pub rms_peak: f32,
}

impl DarkRegion {
    pub fn duration_secs(&self) -> f64 {
        (self.end_secs - self.start_secs).max(0.0)
    }
}

/// What [`detect_dark_regions`] found, and enough about *how* for a caller to
/// judge it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DarkReport {
    /// The located regions, in time order.
    pub regions: Vec<DarkRegion>,
    /// The per-file speech floor the gate used, or `None` when the analysed
    /// range held too few well-transcribed spans to calibrate one — in which
    /// case **no gate was applied** and the regions are the ungated candidates.
    pub rms_floor: Option<f32>,
    /// How many speech spans the floor was derived from.
    pub calibration_spans: usize,
    /// Stretches that summed past [`DarkParams::min_dark_secs`] and were then
    /// rejected by the RMS gate as too quiet to be speech. Reported as a count
    /// rather than as spans: this is the number that says whether the gate is
    /// doing its job on this file, and every one of them is by construction not
    /// a finding.
    pub gated_out: usize,
    /// Total VAD speech in the analysed range, and total transcript coverage —
    /// the two headline numbers behind every decision above, so a caller can
    /// tell "this file is fine" from "the VAD found nothing at all".
    pub speech_secs: f64,
    pub covered_secs: f64,
}

/// Everything [`detect_dark_regions`] reads.
///
/// A struct rather than eight positional arguments, and the reason is not
/// style: four of them are bare `f64` seconds and two are `&[f32]` tracks with
/// different hop rates, which is exactly the shape a caller silently swaps two
/// of. Named fields make a wrong call a compile error.
///
/// **Coordinates.** `words` are in **absolute source seconds** (that is how a
/// transcript arrives); `speech_probs` and `rms` are tracks over the **analysed
/// range**, starting at `range_start_secs`. The conversion between the two
/// happens once, inside [`detect_dark_regions`], which is the whole reason the
/// VAD composition lives in here rather than at the call site.
#[derive(Debug, Clone, Copy)]
pub struct DarkInput<'a> {
    /// Absolute source seconds at which the analysed range begins.
    pub range_start_secs: f64,
    /// Duration of the analysed range. The true decoded duration, not
    /// `speech_probs.len() * frame_secs` — a trailing partial frame is real
    /// audio that produced no probability.
    pub range_secs: f64,
    /// The transcript's words, in absolute source seconds. Need not be sorted,
    /// and need not be confined to the range — anything outside it is clipped.
    pub words: &'a [WordSpan],
    /// Per-frame speech probabilities over the analysed range
    /// ([`crate::vad::SileroVad::speech_probabilities`]).
    pub speech_probs: &'a [f32],
    /// Seconds per entry of `speech_probs` ([`crate::vad::FRAME_SECS`]).
    pub frame_secs: f64,
    /// Per-hop RMS over the analysed range ([`rms_envelope`]).
    pub rms: &'a [f32],
    /// Seconds per entry of `rms` ([`RMS_HOP_SECS`]).
    pub rms_hop_secs: f64,
}

/// Seconds per RMS hop. 50 ms is fine enough to catch the attack of a single
/// word and coarse enough that a peak over a multi-second stretch is a handful
/// of comparisons.
pub const RMS_HOP_SECS: f64 = 0.05;

/// Per-hop root-mean-square amplitude of `samples`.
///
/// The amplitude half of the gate. It is deliberately a *different measurement
/// from a different pipeline* than the VAD: the gate exists to reject spans the
/// VAD called speech that are too quiet to be any, so scoring them with the VAD
/// again would be circular.
///
/// A trailing partial hop is scored from the samples it has rather than
/// discarded — the last 40 ms of a clip is real audio, and an RMS over a short
/// window is still an RMS.
pub fn rms_envelope(samples: &[f32], sample_rate: u32, hop_secs: f64) -> Vec<f32> {
    // `is_finite` first, so a NaN hop is rejected here rather than by the
    // subtleties of a comparison that is false either way.
    if samples.is_empty() || sample_rate == 0 || !hop_secs.is_finite() || hop_secs <= 0.0 {
        return Vec::new();
    }
    let hop = ((hop_secs * sample_rate as f64).round() as usize).max(1);
    samples
        .chunks(hop)
        .map(|c| {
            let sum: f64 = c.iter().map(|&s| (s as f64) * (s as f64)).sum();
            (sum / c.len() as f64).sqrt() as f32
        })
        .collect()
}

/// The dark regions of one analysed range. See the module doc for the algorithm
/// and for where every default in `p` comes from.
pub fn detect_dark_regions(input: &DarkInput<'_>, p: &DarkParams) -> DarkReport {
    let range_start = input.range_start_secs;
    let range_end = range_start + input.range_secs.max(0.0);

    // 1. Coverage — words short enough to be believed, clipped to the range.
    let coverage = merge(
        input
            .words
            .iter()
            .filter(|w| {
                w.start_secs.is_finite()
                    && w.end_secs.is_finite()
                    && w.duration_secs() > 0.0
                    && w.duration_secs() <= p.max_word_secs
            })
            .filter_map(|w| clip(w.start_secs, w.end_secs, range_start, range_end))
            .collect(),
    );

    // 2. Uncovered stretches — the complement, inside the range.
    let uncovered = complement(&coverage, range_start, range_end);

    // 3. VAD speech, shifted from the analysed range's own clock to absolute
    //    source seconds. This is the ONE place the two coordinate systems meet.
    let speech: Vec<Span> = speech_spans(
        input.speech_probs,
        input.frame_secs,
        input.range_secs.max(0.0),
        &p.silence,
    )
    .into_iter()
    .map(|s| Span {
        start_secs: s.start_secs + range_start,
        end_secs: s.end_secs + range_start,
    })
    .collect();

    // 4. Calibrate the floor from the speech the transcript DID read.
    let mut peaks: Vec<f32> = speech
        .iter()
        .filter(|s| s.duration_secs() >= p.min_calibration_span_secs)
        .filter(|s| {
            let covered = overlap_total(&coverage, s.start_secs, s.end_secs);
            covered >= p.calibration_coverage * s.duration_secs()
        })
        .map(|s| peak_rms(input, s.start_secs, s.end_secs))
        .collect();
    let calibration_spans = peaks.len();
    let rms_floor = if calibration_spans >= p.min_calibration_spans {
        peaks.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let rank = (p.calibration_percentile.clamp(0.0, 1.0) * (calibration_spans - 1) as f64)
            .round() as usize;
        Some(peaks[rank.min(calibration_spans - 1)] * p.rms_floor_scale as f32)
    } else {
        None
    };

    // 5. Flag on the summed speech, gate on the stretch's peak, locate with the
    //    intersections.
    let mut regions = Vec::new();
    let mut gated_out = 0usize;
    for stretch in &uncovered {
        let pieces: Vec<Span> = speech
            .iter()
            .filter_map(|s| {
                clip(
                    s.start_secs,
                    s.end_secs,
                    stretch.start_secs,
                    stretch.end_secs,
                )
            })
            .collect();
        let stretch_speech_secs: f64 = pieces.iter().map(|s| s.duration_secs()).sum();
        if stretch_speech_secs < p.min_dark_secs {
            continue;
        }
        let rms_peak = peak_rms(input, stretch.start_secs, stretch.end_secs);
        if rms_floor.is_some_and(|floor| rms_peak < floor) {
            gated_out += 1;
            continue;
        }
        for piece in pieces
            .into_iter()
            .filter(|p_| p_.duration_secs() >= p.min_region_secs)
        {
            regions.push(DarkRegion {
                start_secs: piece.start_secs,
                end_secs: piece.end_secs,
                stretch_start_secs: stretch.start_secs,
                stretch_end_secs: stretch.end_secs,
                stretch_speech_secs,
                rms_peak,
            });
        }
    }

    DarkReport {
        regions,
        rms_floor,
        calibration_spans,
        gated_out,
        speech_secs: speech.iter().map(|s| s.duration_secs()).sum(),
        covered_secs: coverage.iter().map(|s| s.duration_secs()).sum(),
    }
}

/// `[a, b)` intersected with `[lo, hi)`, or `None` when they do not overlap.
fn clip(a: f64, b: f64, lo: f64, hi: f64) -> Option<Span> {
    let start = a.max(lo);
    let end = b.min(hi);
    (end > start).then_some(Span {
        start_secs: start,
        end_secs: end,
    })
}

/// Sort and merge touching/overlapping spans into a disjoint, ordered cover.
fn merge(mut spans: Vec<Span>) -> Vec<Span> {
    spans.sort_by(|a, b| {
        a.start_secs
            .partial_cmp(&b.start_secs)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut out: Vec<Span> = Vec::with_capacity(spans.len());
    for s in spans {
        match out.last_mut() {
            Some(last) if s.start_secs <= last.end_secs => {
                last.end_secs = last.end_secs.max(s.end_secs);
            }
            _ => out.push(s),
        }
    }
    out
}

/// The gaps between `spans` inside `[lo, hi)`. `spans` must already be merged.
fn complement(spans: &[Span], lo: f64, hi: f64) -> Vec<Span> {
    let mut out = Vec::new();
    let mut cursor = lo;
    for s in spans {
        if s.start_secs > cursor {
            out.push(Span {
                start_secs: cursor,
                end_secs: s.start_secs.min(hi),
            });
        }
        cursor = cursor.max(s.end_secs);
        if cursor >= hi {
            break;
        }
    }
    if hi > cursor {
        out.push(Span {
            start_secs: cursor,
            end_secs: hi,
        });
    }
    out.retain(|s| s.end_secs > s.start_secs);
    out
}

/// How much of `[a, b)` is inside `spans`.
fn overlap_total(spans: &[Span], a: f64, b: f64) -> f64 {
    spans
        .iter()
        .filter_map(|s| clip(s.start_secs, s.end_secs, a, b))
        .map(|s| s.duration_secs())
        .sum()
}

/// The largest RMS hop overlapping `[a, b)` of the analysed range, or 0 when the
/// envelope does not reach it.
///
/// Half-open on both sides, and a range shorter than one hop still reads the hop
/// it falls inside rather than returning zero — a 0.3 s region against a 50 ms
/// hop must not silently score as silence.
fn peak_rms(input: &DarkInput<'_>, a: f64, b: f64) -> f32 {
    if input.rms.is_empty() || !input.rms_hop_secs.is_finite() || input.rms_hop_secs <= 0.0 {
        return 0.0;
    }
    let local_a = (a - input.range_start_secs).max(0.0);
    let local_b = (b - input.range_start_secs).max(0.0);
    let first = (local_a / input.rms_hop_secs).floor().max(0.0) as usize;
    // `ceil` so a range ending mid-hop still includes that hop.
    let last = (local_b / input.rms_hop_secs).ceil().max(0.0) as usize;
    let last = last.max(first + 1).min(input.rms.len());
    if first >= input.rms.len() {
        return 0.0;
    }
    input.rms[first..last]
        .iter()
        .copied()
        .fold(0.0_f32, f32::max)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The real Silero-at-16 kHz hop, so the probability tracks below are in the
    /// same units as the production one.
    const FRAME: f64 = 0.032;

    /// Where the VOICE is, in the fixtures below. Five utterances separated by
    /// real pauses — the shape of actual speech, and load-bearing: a fixture
    /// that is one continuous span has no *other* utterance to calibrate the
    /// amplitude floor against, which is the case the detector deliberately
    /// refuses to gate on.
    const UTTERANCES: [(f64, f64); 5] = [
        (0.0, 3.0),
        (4.0, 7.0),
        (8.0, 11.0),
        (12.0, 15.0),
        (16.0, 19.0),
    ];
    const TOTAL: f64 = 19.5;
    /// `UTTERANCES[1]` is the one the transcript never read — the dark region.
    const DARK: (f64, f64) = UTTERANCES[1];

    /// Typical speech amplitude and room tone in the fixtures, in the `f32`
    /// sample units [`rms_envelope`] returns.
    const SPEECH_RMS: f32 = 0.2;
    const ROOM_RMS: f32 = 0.005;

    fn frames(secs: f64) -> usize {
        (secs / FRAME).round() as usize
    }

    /// A Silero-shaped probability track: confident speech inside `spans`, room
    /// tone everywhere else, over `TOTAL` seconds.
    fn voice(spans: &[(f64, f64)]) -> Vec<f32> {
        let mut p = vec![0.01_f32; frames(TOTAL)];
        for &(a, b) in spans {
            for f in frames(a)..frames(b).min(p.len()) {
                p[f] = 0.99;
            }
        }
        p
    }

    /// An amplitude envelope that agrees with a voice track: speech level inside
    /// `spans`, room tone between them. Built from the same list on purpose, so
    /// the two signals describe one recording rather than contradicting each
    /// other.
    fn envelope(spans: &[(f64, f64)]) -> Vec<f32> {
        let mut e = vec![ROOM_RMS; (TOTAL / RMS_HOP_SECS).ceil() as usize];
        for &(a, b) in spans {
            let lo = (a / RMS_HOP_SECS) as usize;
            let hi = ((b / RMS_HOP_SECS) as usize).min(e.len());
            for v in &mut e[lo..hi] {
                *v = SPEECH_RMS;
            }
        }
        e
    }

    fn word(start: f64, end: f64) -> WordSpan {
        WordSpan {
            start_secs: start,
            end_secs: end,
        }
    }

    /// Ordinary 0.4 s transcript words filling each of `spans` — what whisper
    /// emits for an utterance it read correctly. Built from an integer index
    /// rather than an accumulating `+= 0.4` so the last word of a run ends
    /// exactly on the boundary instead of 4e-16 past it.
    fn words_over(spans: &[(f64, f64)]) -> Vec<WordSpan> {
        let mut out = Vec::new();
        for &(a, b) in spans {
            let n = ((b - a) / 0.4).round() as usize;
            for i in 0..n {
                out.push(word(a + i as f64 * 0.4, a + (i + 1) as f64 * 0.4));
            }
        }
        out
    }

    /// Every utterance except [`DARK`] — i.e. the transcript as whisper's
    /// whole-file pass actually returns it on this material.
    fn transcribed() -> Vec<(f64, f64)> {
        UTTERANCES.iter().copied().filter(|&u| u != DARK).collect()
    }

    fn input<'a>(
        p: &'a [f32],
        words: &'a [WordSpan],
        rms: &'a [f32],
        range_start: f64,
    ) -> DarkInput<'a> {
        DarkInput {
            range_start_secs: range_start,
            range_secs: TOTAL,
            words,
            speech_probs: p,
            frame_secs: FRAME,
            rms,
            rms_hop_secs: RMS_HOP_SECS,
        }
    }

    /// Equal to within a frame, so an expectation reads as the time it means
    /// rather than as a hand-rounded frame count.
    fn near(got: f64, want: f64) -> bool {
        (got - want).abs() < 0.1
    }

    /// The headline, and the whole bug in one assertion: five utterances, the
    /// transcript read four of them, and the one it dropped comes back located
    /// where it actually is.
    #[test]
    fn a_dropped_utterance_is_found_and_located() {
        let p = voice(&UTTERANCES);
        let words = words_over(&transcribed());
        let rms = envelope(&UTTERANCES);

        let r = detect_dark_regions(&input(&p, &words, &rms, 0.0), &DarkParams::default());
        assert_eq!(r.regions.len(), 1, "{:?}", r.regions);
        let d = r.regions[0];
        assert!(
            near(d.start_secs, DARK.0) && near(d.end_secs, DARK.1),
            "expected roughly {DARK:?}, got {d:?}"
        );
        assert!(d.stretch_speech_secs >= 1.2, "{d:?}");
        // The stretch is WIDER than the region — it runs between the transcript
        // words either side. A caller re-transcribing with context needs that.
        assert!(d.stretch_start_secs <= d.start_secs && d.stretch_end_secs >= d.end_secs);
    }

    /// **The test that would have caught B-216's own wording being wrong.**
    ///
    /// Same audio, same hole — except the DTW alignment has stretched one word
    /// across it, which is what actually happens on real footage (c038's
    /// ` down.` at 217.26-222.74 is 5.48 s for a single word). A detector that
    /// asks "is there a transcript word in this gap" sees one and reports
    /// nothing. The >2.0 s non-covering rule is the only thing keeping this a
    /// finding, and it is worth more than half the real cases on both files.
    #[test]
    fn a_word_stretched_across_the_hole_does_not_hide_it() {
        let p = voice(&UTTERANCES);
        let mut words = words_over(&transcribed());
        words.push(word(DARK.0, DARK.1)); // one 3.0s "word"
        let rms = envelope(&UTTERANCES);

        let r = detect_dark_regions(&input(&p, &words, &rms, 0.0), &DarkParams::default());
        assert_eq!(
            r.regions.len(),
            1,
            "a 3.0s word must contribute no coverage: {:?}",
            r.regions
        );

        // And it is a real threshold, not a blanket "ignore long words": raise
        // the bound past the stretched word and the finding vanishes — which is
        // precisely the failure being guarded against.
        let lenient = DarkParams {
            max_word_secs: 4.0,
            ..DarkParams::default()
        };
        assert!(
            detect_dark_regions(&input(&p, &words, &rms, 0.0), &lenient)
                .regions
                .is_empty()
        );
    }

    /// Speech the transcript DID read is not a finding — the boring case, and
    /// the one that would make the detector useless if it ever failed.
    #[test]
    fn fully_transcribed_speech_yields_nothing() {
        let p = voice(&UTTERANCES);
        let words = words_over(&UTTERANCES);
        let rms = envelope(&UTTERANCES);
        let r = detect_dark_regions(&input(&p, &words, &rms, 0.0), &DarkParams::default());
        assert!(r.regions.is_empty(), "{:?}", r.regions);
        assert!(r.covered_secs > 14.0, "{r:?}");
    }

    /// A hole with no VOICE in it is dead air, which is [`crate::silence`]'s
    /// business and not this module's. Reporting it here would flood every
    /// talking-head file with one "dark region" per pause.
    #[test]
    fn an_untranscribed_silence_is_not_a_dark_region() {
        // The audio simply has no utterance where the transcript has no words.
        let spans = transcribed();
        let p = voice(&spans);
        let words = words_over(&spans);
        let rms = envelope(&spans);
        let r = detect_dark_regions(&input(&p, &words, &rms, 0.0), &DarkParams::default());
        assert!(r.regions.is_empty(), "{:?}", r.regions);
    }

    /// The RMS gate, which took precision from 72.7 % to 100 % on the measured
    /// corpus: a stretch the VAD calls speech but whose amplitude never reaches
    /// the level of the speech this file's transcript DID read is an artefact,
    /// not a dropped take. Every false positive across both real sources was
    /// exactly this shape (peaks of 113-605 against true positives at
    /// 1407-2879).
    #[test]
    fn a_quiet_stretch_is_gated_out_against_the_files_own_speech_floor() {
        let p = voice(&UTTERANCES);
        let words = words_over(&transcribed());
        // Everything as before, except the dark utterance sits a tenth of speech
        // level — audible to the VAD, far below anything this speaker says.
        let mut rms = envelope(&UTTERANCES);
        let dark_hops = (DARK.0 / RMS_HOP_SECS) as usize..(DARK.1 / RMS_HOP_SECS) as usize;
        for v in &mut rms[dark_hops] {
            *v = SPEECH_RMS * 0.1;
        }

        let r = detect_dark_regions(&input(&p, &words, &rms, 0.0), &DarkParams::default());
        assert!(r.regions.is_empty(), "{:?}", r.regions);
        assert_eq!(r.gated_out, 1, "the report must SAY the gate rejected one");
        assert_eq!(r.rms_floor, Some(SPEECH_RMS), "{r:?}");
        assert_eq!(r.calibration_spans, 4, "{r:?}");

        // Loosening the floor lets it back through, so it is the GATE that
        // rejected it — not the coverage rule and not the summed-speech
        // threshold.
        let loose = DarkParams {
            rms_floor_scale: 0.05,
            ..DarkParams::default()
        };
        assert_eq!(
            detect_dark_regions(&input(&p, &words, &rms, 0.0), &loose)
                .regions
                .len(),
            1
        );
    }

    /// The floor is **per recording**, and a fixed constant would be wrong: mic,
    /// gain and room differ per shoot, so the same take recorded much quieter
    /// throughout must give the same answer.
    #[test]
    fn the_floor_is_relative_to_the_recording_not_absolute() {
        let p = voice(&UTTERANCES);
        let words = words_over(&transcribed());
        let rms = envelope(&UTTERANCES);
        let loud = detect_dark_regions(&input(&p, &words, &rms, 0.0), &DarkParams::default());

        let quiet_rms: Vec<f32> = rms.iter().map(|v| v * 0.1).collect();
        let quiet =
            detect_dark_regions(&input(&p, &words, &quiet_rms, 0.0), &DarkParams::default());

        assert_eq!(loud.regions.len(), 1);
        assert_eq!(loud.regions.len(), quiet.regions.len());
        assert_eq!(loud.regions[0].start_secs, quiet.regions[0].start_secs);
        assert!(quiet.rms_floor.unwrap() < loud.rms_floor.unwrap());
    }

    /// Too few well-transcribed utterances to calibrate ⇒ **no gate**, and the
    /// report says so. A floor derived from one span would be a guess dressed as
    /// a measurement, and silently gating on it could hide every real finding on
    /// a short clip.
    #[test]
    fn an_uncalibratable_range_reports_no_floor_and_does_not_gate() {
        let p = voice(&UTTERANCES);
        let words = words_over(&transcribed());
        let rms = envelope(&UTTERANCES);
        let strict = DarkParams {
            min_calibration_spans: 50,
            ..DarkParams::default()
        };
        let r = detect_dark_regions(&input(&p, &words, &rms, 0.0), &strict);
        assert_eq!(r.rms_floor, None);
        assert_eq!(r.gated_out, 0);
        assert_eq!(r.regions.len(), 1, "an ungated answer is still an answer");
    }

    /// Summing beats requiring one contiguous span. The measured c040 case at
    /// 297.96-301.36: 0.47 s of speech, a 1.96 s pause, then 0.97 s — 1.44 s of
    /// unread speech, no single piece of it reaching 1.2 s, and an isolated
    /// re-transcription recovers a real retake from it.
    #[test]
    fn speech_split_by_a_pause_is_summed_across_the_stretch() {
        // Two short untranscribed bursts where the dark utterance was.
        let bursts = [(4.0, 4.7), (6.0, 6.8)];
        let mut spans = transcribed();
        spans.extend_from_slice(&bursts);
        let p = voice(&spans);
        let words = words_over(&transcribed());
        let rms = envelope(&spans);

        // Neither burst reaches the threshold on its own, including its padding.
        for (a, b) in bursts {
            assert!(b - a + 0.06 < 1.2, "fixture: {a}-{b} must be under 1.2s");
        }

        let r = detect_dark_regions(&input(&p, &words, &rms, 0.0), &DarkParams::default());
        assert_eq!(r.regions.len(), 2, "two bursts, summed then located: {r:?}");
        assert!(r.regions[0].stretch_speech_secs >= 1.2, "{r:?}");
        assert!(near(r.regions[0].start_secs, 4.0), "{:?}", r.regions[0]);
        assert!(near(r.regions[1].start_secs, 6.0), "{:?}", r.regions[1]);
        // Located as the two bursts, NOT as one 2.8 s span that is mostly pause —
        // gate with the sum, locate with the pieces.
        assert!(r.regions[0].end_secs < r.regions[1].start_secs);
    }

    /// The range's offset is real: a clip trimmed to start at 600 s must report
    /// absolute source seconds, not seconds-into-the-decoded-buffer. Getting
    /// this wrong points every recovery at the wrong part of the file, silently.
    #[test]
    fn regions_come_back_in_absolute_source_seconds() {
        let p = voice(&UTTERANCES);
        let rms = envelope(&UTTERANCES);
        let words: Vec<WordSpan> = words_over(&transcribed())
            .iter()
            .map(|w| word(w.start_secs + 600.0, w.end_secs + 600.0))
            .collect();

        let r = detect_dark_regions(&input(&p, &words, &rms, 600.0), &DarkParams::default());
        assert_eq!(r.regions.len(), 1, "{:?}", r.regions);
        assert!(
            near(r.regions[0].start_secs, 600.0 + DARK.0),
            "{:?}",
            r.regions[0]
        );
    }

    /// Words from OUTSIDE the analysed range must not cover anything inside it.
    /// A transcript is per FILE and a range is one clip's trim, so this is the
    /// normal case rather than an edge one.
    #[test]
    fn words_outside_the_range_do_not_cover_it() {
        let p = voice(&UTTERANCES);
        let rms = envelope(&UTTERANCES);
        let words: Vec<WordSpan> = words_over(&UTTERANCES)
            .iter()
            .map(|w| word(w.start_secs - 100.0, w.end_secs - 100.0))
            .collect();

        let r = detect_dark_regions(&input(&p, &words, &rms, 0.0), &DarkParams::default());
        assert_eq!(r.covered_secs, 0.0);
        // Nothing is covered, so nothing can calibrate a floor — and the answer
        // is ungated rather than absent.
        assert_eq!(r.rms_floor, None);
        assert_eq!(r.regions.len(), UTTERANCES.len(), "{:?}", r.regions);
    }

    /// No probabilities means the audio was never scored, not that it was
    /// silent — the same refusal-to-guess [`crate::silence::silence_spans`]
    /// makes, and for the same reason: the caller acts on the answer.
    #[test]
    fn no_probabilities_yields_no_findings() {
        let rms = envelope(&UTTERANCES);
        let r = detect_dark_regions(&input(&[], &[], &rms, 0.0), &DarkParams::default());
        assert!(r.regions.is_empty());
        assert_eq!(r.speech_secs, 0.0);
    }

    /// Determinism, this repo's standing invariant: identical inputs give
    /// identical output, and nothing in the middle depends on input order.
    /// Pinned because the calibration sorts and the coverage merges — both
    /// places where a careless change could make the answer order-dependent.
    #[test]
    fn the_detector_is_deterministic_and_order_independent() {
        let p = voice(&UTTERANCES);
        let words = words_over(&transcribed());
        let rms = envelope(&UTTERANCES);

        let a = detect_dark_regions(&input(&p, &words, &rms, 0.0), &DarkParams::default());
        let b = detect_dark_regions(&input(&p, &words, &rms, 0.0), &DarkParams::default());
        assert_eq!(a, b);

        let mut reversed = words.clone();
        reversed.reverse();
        let c = detect_dark_regions(&input(&p, &reversed, &rms, 0.0), &DarkParams::default());
        assert_eq!(a, c, "word order must not change the answer");
    }

    /// `min_dark_secs` is a real knob, not decoration — and 1.2 s sits on a
    /// measured plateau rather than a knife edge.
    #[test]
    fn the_threshold_is_honoured_in_both_directions() {
        let p = voice(&UTTERANCES);
        let words = words_over(&transcribed());
        let rms = envelope(&UTTERANCES);

        let strict = DarkParams {
            min_dark_secs: 5.0,
            ..DarkParams::default()
        };
        assert!(
            detect_dark_regions(&input(&p, &words, &rms, 0.0), &strict)
                .regions
                .is_empty(),
            "a 3 s region cannot clear a 5 s threshold"
        );

        // The plateau: every value from 1.0 to 1.5 gives the same answer, which
        // is what the 111-window scoring measured on both real files.
        for min_dark in [1.0, 1.2, 1.5] {
            let tuned = DarkParams {
                min_dark_secs: min_dark,
                ..DarkParams::default()
            };
            assert_eq!(
                detect_dark_regions(&input(&p, &words, &rms, 0.0), &tuned)
                    .regions
                    .len(),
                1,
                "min_dark_secs {min_dark} should be on the plateau"
            );
        }
    }

    #[test]
    fn rms_envelope_measures_what_it_says() {
        // A constant +0.5 signal has RMS 0.5 in every hop.
        let samples = vec![0.5_f32; 16_000];
        let env = rms_envelope(&samples, 16_000, RMS_HOP_SECS);
        assert_eq!(env.len(), 20, "1 s at a 50 ms hop");
        for v in &env {
            assert!((v - 0.5).abs() < 1e-6, "{v}");
        }
        assert!(rms_envelope(&[], 16_000, RMS_HOP_SECS).is_empty());
        assert!(rms_envelope(&samples, 16_000, 0.0).is_empty());
    }

    /// A trailing partial hop is real audio, scored from the samples it has —
    /// not dropped, and not divided by a full hop's worth of zeroes.
    #[test]
    fn a_trailing_partial_hop_is_still_measured() {
        let samples = vec![0.5_f32; 16_000 + 100];
        let env = rms_envelope(&samples, 16_000, RMS_HOP_SECS);
        assert_eq!(env.len(), 21);
        assert!((env[20] - 0.5).abs() < 1e-6, "{}", env[20]);
    }
}

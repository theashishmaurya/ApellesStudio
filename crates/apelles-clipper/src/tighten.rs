//! Tightening inside a clip: the dead air and the reviewed retakes a build
//! cuts out of each source range (D-411 §3.4).
//!
//! **What it is.** A plan, never an effect: [`tighten_range`] lists the
//! stretches of one source range a build should remove, each with its kind,
//! so the build can hand them to the existing ripple delete (one reported,
//! undoable list on the timeline) and the client and the person can see them.
//!
//! - **Dead air:** a pause of at least [`TIGHT_MIN_GAP_S`] between two words is
//!   shortened to [`TIGHT_GAP_S`] — the tail of the earlier word keeps
//!   [`TIGHT_KEEP_TAIL_S`] (the breath finishes), the head of the next keeps
//!   [`TIGHT_KEEP_HEAD_S`]. **Not where the VAD hears speech in the pause**:
//!   more than [`TIGHT_SPEECH_GUARD_S`] of voice in a word gap is speech the
//!   recogniser missed (D-349's dark regions), and cutting it would delete
//!   unheard words. Without a VAD pass the transcript is trusted.
//! - **Retakes:** the deleted takes of reviewed retake groups (`verified` /
//!   `ai_confirmed`, D-380/D-382) that fall inside the range. A refused group
//!   is never cut here.
//!
//! **What it does NOT do.** It never cuts fillers (a later option, as in Opus
//! Clip's checklist) and never touches a range's outer edges.

use apelles_speech::IndexedWord;
use serde::{Deserialize, Serialize};

use crate::evidence::{RetakeCut, SourceEvidence, Span};
use crate::sentence::gap;

/// A pause at least this long is dead air — the "they stopped talking"
/// threshold sentences use too.
pub const TIGHT_MIN_GAP_S: f64 = 0.6;
/// What a tightened pause keeps of the earlier word's tail.
pub const TIGHT_KEEP_TAIL_S: f64 = 0.15;
/// What a tightened pause keeps before the next word.
pub const TIGHT_KEEP_HEAD_S: f64 = 0.10;
/// The pause a tightened gap is left with: the reference teardown's
/// "jump-cut tight" (`docs/notes/reference-teardown-lewis-jackson-polymarket.md`).
pub const TIGHT_GAP_S: f64 = TIGHT_KEEP_TAIL_S + TIGHT_KEEP_HEAD_S;
/// More VAD speech than this inside a word gap means words the recogniser
/// missed; that gap is left alone.
pub const TIGHT_SPEECH_GUARD_S: f64 = 0.1;

/// Why a stretch is cut.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CutKind {
    DeadAir,
    Retake,
}

/// One stretch of a source range to remove, in the source's seconds.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct TightCut {
    pub kind: CutKind,
    pub start_secs: f64,
    pub end_secs: f64,
}

impl TightCut {
    pub fn secs(&self) -> f64 {
        self.end_secs - self.start_secs
    }
}

/// Which tightening a build applies.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TightenOptions {
    pub dead_air: bool,
    pub retakes: bool,
}

impl Default for TightenOptions {
    fn default() -> Self {
        Self {
            dead_air: true,
            retakes: true,
        }
    }
}

/// The plan for one source range.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TightenPlan {
    /// In order, non-overlapping, inside the range.
    pub cuts: Vec<TightCut>,
    /// Pauses left alone because the VAD hears speech in them.
    pub kept_for_speech: Vec<Span>,
}

impl TightenPlan {
    pub fn removed_secs(&self) -> f64 {
        self.cuts.iter().map(TightCut::secs).sum()
    }
}

/// The cuts for words `first..=last` (one piece, in order) played over
/// `[start_secs, end_secs)` of `source`.
#[allow(clippy::too_many_arguments)]
pub fn tighten_range(
    words: &[IndexedWord],
    first: usize,
    last: usize,
    start_secs: f64,
    end_secs: f64,
    source: usize,
    evidence: Option<&SourceEvidence>,
    retake_cuts: &[RetakeCut],
    opts: TightenOptions,
) -> TightenPlan {
    let mut cuts: Vec<TightCut> = Vec::new();
    let mut kept_for_speech = Vec::new();
    if opts.dead_air {
        for k in first..last.min(words.len().saturating_sub(1)) {
            if gap(words, k, k + 1) < TIGHT_MIN_GAP_S {
                continue;
            }
            let a = words[k].end_secs + TIGHT_KEEP_TAIL_S;
            let b = words[k + 1].start_secs - TIGHT_KEEP_HEAD_S;
            if b <= a {
                continue;
            }
            let heard = evidence.and_then(|e| e.speech_secs(a, b)).unwrap_or(0.0);
            if heard > TIGHT_SPEECH_GUARD_S {
                kept_for_speech.push(Span {
                    start_secs: a,
                    end_secs: b,
                });
                continue;
            }
            cuts.push(TightCut {
                kind: CutKind::DeadAir,
                start_secs: a,
                end_secs: b,
            });
        }
    }
    if opts.retakes {
        for c in retake_cuts.iter().filter(|c| c.source == source) {
            let a = c.start_secs.max(start_secs);
            let b = c.end_secs.min(end_secs);
            if b > a {
                cuts.push(TightCut {
                    kind: CutKind::Retake,
                    start_secs: a,
                    end_secs: b,
                });
            }
        }
    }
    cuts.retain(|c| c.start_secs >= start_secs && c.end_secs <= end_secs);
    cuts.sort_by(|a, b| a.start_secs.total_cmp(&b.start_secs));
    let mut merged: Vec<TightCut> = Vec::with_capacity(cuts.len());
    for c in cuts {
        match merged.last_mut() {
            Some(prev) if c.start_secs <= prev.end_secs => {
                prev.end_secs = prev.end_secs.max(c.end_secs);
                if c.kind == CutKind::Retake {
                    prev.kind = CutKind::Retake;
                }
            }
            _ => merged.push(c),
        }
    }
    TightenPlan {
        cuts: merged,
        kept_for_speech,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(start: f64, end: f64) -> IndexedWord {
        IndexedWord {
            text: "w".into(),
            start_secs: start,
            end_secs: end,
            run: 0,
        }
    }

    #[test]
    fn a_long_pause_is_shortened_to_the_tight_gap() {
        let words = vec![w(0.0, 0.5), w(2.0, 2.5), w(2.6, 3.0)];
        let plan = tighten_range(
            &words,
            0,
            2,
            0.0,
            3.2,
            0,
            None,
            &[],
            TightenOptions::default(),
        );
        assert_eq!(plan.cuts.len(), 1);
        let c = plan.cuts[0];
        assert_eq!(c.kind, CutKind::DeadAir);
        assert!((c.start_secs - 0.65).abs() < 1e-9 && (c.end_secs - 1.9).abs() < 1e-9);
        // What is left of the 1.5 s pause is exactly the tight gap.
        assert!((1.5 - c.secs() - TIGHT_GAP_S).abs() < 1e-9);
    }

    #[test]
    fn a_pause_the_vad_hears_speech_in_is_kept() {
        let words = vec![w(0.0, 0.5), w(3.0, 3.5)];
        let ev = SourceEvidence {
            speech: Some(vec![Span {
                start_secs: 1.0,
                end_secs: 2.0,
            }]),
            ..SourceEvidence::default()
        };
        let plan = tighten_range(
            &words,
            0,
            1,
            0.0,
            3.6,
            0,
            Some(&ev),
            &[],
            TightenOptions::default(),
        );
        assert!(plan.cuts.is_empty());
        assert_eq!(plan.kept_for_speech.len(), 1);
    }

    #[test]
    fn retake_cuts_inside_are_merged_with_dead_air_and_others_ignored() {
        let words = vec![w(0.0, 0.5), w(1.5, 2.0), w(2.1, 4.0), w(4.1, 4.5)];
        let cuts = [
            RetakeCut {
                source: 0,
                start_secs: 1.2,
                end_secs: 2.05,
            },
            RetakeCut {
                source: 1,
                start_secs: 0.0,
                end_secs: 9.0,
            },
        ];
        let plan = tighten_range(
            &words,
            0,
            3,
            0.0,
            4.6,
            0,
            None,
            &cuts,
            TightenOptions::default(),
        );
        assert_eq!(plan.cuts.len(), 1, "{plan:?}");
        assert_eq!(plan.cuts[0].kind, CutKind::Retake);
        assert!((plan.cuts[0].start_secs - 0.65).abs() < 1e-9);
        assert!((plan.cuts[0].end_secs - 2.05).abs() < 1e-9);
        let off = tighten_range(
            &words,
            0,
            3,
            0.0,
            4.6,
            0,
            None,
            &cuts,
            TightenOptions {
                dead_air: false,
                retakes: false,
            },
        );
        assert!(off.cuts.is_empty());
    }
}

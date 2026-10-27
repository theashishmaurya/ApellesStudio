//! Candidates: every clean, in-length window the source holds, one per
//! (starting sentence, target length) — evidence for the judge, not picks
//! (D-411 §3.2, owner decision 2026-10-27).
//!
//! **What it is.** For each target `T` and each sentence `i`, the window from
//! `i` to the sentence `j` (same topic) whose duration after tightening is
//! closest to `T` while inside `T`'s tolerance, where `j` lands (a final mark,
//! then a stop) and the whole window passes the clean-cut gate. Every
//! candidate therefore already satisfies every mechanical rule; what it lacks
//! is a judgement.
//!
//! **What it does NOT do: rank.** There is no score here and no order but the
//! source's: candidates are listed by start sentence, then target. Which of
//! them is interesting is the MCP client's call (and a person's); the tags are
//! the evidence it reads.

use serde::{Deserialize, Serialize};

use crate::evidence::SourceEvidence;
use crate::features::{SpeakerStats, Tag, completes, delivery_tags, ending_tags, opener_tags};
use crate::gate::{
    ClipRefusal, ClipShape, ClipVerdict, ClipWarning, GateContext, SegmentRef, check,
};
use crate::tighten::{CutKind, TightCut};

/// Dead air plus retakes below this many seconds is not worth a tag.
pub const TIGHTEN_TAG_MIN_S: f64 = 0.5;

/// One clean window.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Candidate {
    /// `c<first sentence>-<last sentence>`; stable while the view is.
    pub id: String,
    pub target_secs: u32,
    pub first_sentence: usize,
    pub last_sentence: usize,
    pub topic: usize,
    pub raw_secs: f64,
    pub tight_secs: f64,
    pub tags: Vec<Tag>,
    pub warnings: Vec<ClipWarning>,
}

/// Every candidate for `targets`, in source order.
pub fn find_candidates(
    ctx: &GateContext<'_>,
    targets: &[u32],
    evidence: &[SourceEvidence],
    source_of_piece: &[usize],
    stats: &SpeakerStats,
    focus: &[String],
) -> Vec<Candidate> {
    let sentences = ctx.sentences;
    let n = sentences.len();
    let mut out: Vec<Candidate> = Vec::new();
    for i in 0..n {
        for &target in targets {
            let (lo, hi) = GateContext::band(target);
            let mut best: Option<(usize, ClipVerdict, f64)> = None;
            for j in i..n {
                if ctx.topic_of_sentence.get(j) != ctx.topic_of_sentence.get(i) {
                    break;
                }
                if !completes(&sentences[j]) {
                    continue;
                }
                let shape = ClipShape {
                    hook: None,
                    segments: vec![SegmentRef {
                        first_word: sentences[i].first_word,
                        last_word: sentences[j].last_word,
                    }],
                };
                let verdict = check(ctx, &shape);
                let Some(tight) = verdict.resolved().map(|r| r.tight_secs) else {
                    // Too long already: every later end is longer still (a
                    // longer window only adds material). Anything else — too
                    // short, an edge in a retake — a later end may fix.
                    if let ClipVerdict::Refused {
                        reason: ClipRefusal::DurationOutOfRange { secs, .. },
                        ..
                    } = &verdict
                        && *secs > hi
                    {
                        break;
                    }
                    continue;
                };
                if tight > hi {
                    break;
                }
                if tight < lo {
                    continue;
                }
                let off = (tight - f64::from(target)).abs();
                if best.as_ref().is_none_or(|(_, _, b)| off < *b) {
                    best = Some((j, verdict, off));
                }
            }
            let Some((j, verdict, _)) = best else {
                continue;
            };
            let id = format!("c{i}-{j}");
            if out.iter().any(|c| c.id == id) {
                continue;
            }
            let Some(resolved) = verdict.resolved() else {
                continue;
            };
            let warnings = match &verdict {
                ClipVerdict::Warned { warnings, .. } => warnings.clone(),
                _ => Vec::new(),
            };
            let window: Vec<_> = sentences[i..=j].iter().collect();
            let mut tags = opener_tags(ctx.words, &sentences[i]);
            tags.extend(ending_tags(&sentences[j]));
            tags.extend(delivery_tags(
                ctx.words,
                &window,
                evidence,
                source_of_piece,
                stats,
                focus,
            ));
            let cuts: Vec<&TightCut> = resolved.ranges.iter().flat_map(|r| r.cuts.iter()).collect();
            if cuts.iter().any(|c| c.kind == CutKind::Retake) {
                tags.push(Tag::Retake);
            }
            let removed: f64 = cuts.iter().map(|c| c.secs()).sum();
            if removed >= TIGHTEN_TAG_MIN_S {
                tags.push(Tag::Tightened {
                    secs: (removed * 10.0).round() / 10.0,
                });
            }
            out.push(Candidate {
                id,
                target_secs: target,
                first_sentence: i,
                last_sentence: j,
                topic: ctx.topic_of_sentence.get(i).copied().unwrap_or(0),
                raw_secs: resolved.raw_secs,
                tight_secs: resolved.tight_secs,
                tags,
                warnings,
            });
        }
    }
    out
}

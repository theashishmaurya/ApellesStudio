//! The clean-cut gate: one deterministic check every clip proposal passes,
//! whoever made it (D-411 §3.3).
//!
//! **What it is.** The research's loudest complaint about AI clippers is the
//! cut, not the pick: clips that "start mid-thought, cut mid-sentence, miss
//! the punchline". So every proposal — the MCP client's, a person's nudge, a
//! deterministic candidate — is held to the same mechanical standard before
//! anything is built, exactly as D-380's coverage gate holds retake groups.
//!
//! A proposal is a [`ClipShape`]: body segments in play order (word-index
//! ranges of the view) and an optional hook segment played first. The gate
//! answers [`ClipVerdict::Verified`], [`ClipVerdict::Warned`] (passes, with
//! the issues named, never silently fixed) or [`ClipVerdict::Refused`] (with a
//! [`ClipRefusal`] and the offending word indices, so a client can fix it and
//! resubmit). Refused when:
//!
//! - a segment edge is not a sentence boundary — except an INNER edge (where
//!   two segments are stitched) on a clause boundary: a `,` `;` `:` or dash
//!   followed by at least [`CLAUSE_PAUSE_S`] of silence;
//! - an edge falls inside a word: the word on the other side of the edge
//!   overlaps it in time, so no cut point exists between them;
//! - a segment starts or ends inside a reviewed retake's deleted take (it
//!   would replay the flub);
//! - the hook is not one to [`HOOK_MAX_SENTENCES`] whole sentences, or runs
//!   longer than [`HOOK_MAX_S`];
//! - the duration after tightening is outside every requested target's
//!   tolerance (−[`TOLERANCE_UNDER`] / +[`TOLERANCE_OVER`]);
//! - it is malformed: no segment, an index past the view, `first > last`, two
//!   body segments sharing words.
//!
//! A stale `viewId` is refused one level up, by the op layer that knows it.
//!
//! **Padding** (D-380's rule): each outer edge is padded toward the
//! neighbouring word by at most [`EDGE_HEAD_PAD_S`] (start: the first
//! syllable lands on frame one) or [`EDGE_TAIL_PAD_S`] (end: the breath
//! finishes), never past half the gap, never outside the piece's window. A
//! segment that runs across two pieces (a cut in a long source timeline) uses
//! the pieces' own window edges there: that cut is the long edit's.
//!
//! **What it does NOT do.** It judges no content: whether a moment is worth a
//! short is the client's call. It proves only that the cut is clean.

use std::fmt;

use apelles_speech::{IndexedWord, ViewPiece};
use serde::{Deserialize, Serialize};

use crate::evidence::{RetakeCut, SourceEvidence};
use crate::features::{Tag, completes, opener_tags};
use crate::sentence::{Ending, Sentence};
use crate::text::{WordEnd, word_end};
use crate::tighten::{TightCut, TightenOptions, tighten_range};

/// The shortest pause after a clause mark that makes an inner stitch edge
/// acceptable (D-411 §3.3).
pub const CLAUSE_PAUSE_S: f64 = 0.4;
/// The longest hook, in seconds after padding.
pub const HOOK_MAX_S: f64 = 8.0;
/// The most sentences a hook may hold.
pub const HOOK_MAX_SENTENCES: usize = 3;
/// How far under a target a short may come in, as a fraction of it.
pub const TOLERANCE_UNDER: f64 = 0.30;
/// How far over a target a short may run, as a fraction of it.
pub const TOLERANCE_OVER: f64 = 0.25;
/// The padding before a start edge, at most.
pub const EDGE_HEAD_PAD_S: f64 = 0.12;
/// The padding after an end edge, at most: one maximum-length Parakeet token,
/// the same bound D-380's retake cuts pad by.
pub const EDGE_TAIL_PAD_S: f64 = apelles_speech::proposal::EDGE_PAD_MAX_SECS;
/// The target lengths a short may be asked for, in seconds (the design's
/// chips: Opus Clip's bands mapped onto reel lengths).
pub const ALLOWED_DURATIONS: [u32; 4] = [15, 30, 60, 90];
/// An overlap with another proposal above this share of the clip warns.
pub const OVERLAP_WARN_SHARE: f64 = 0.5;

/// Two times this close are the same instant (transcript times are
/// two-decimal model output).
const TIME_EPS: f64 = 1e-6;

/// An inclusive word-index range of the view.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SegmentRef {
    pub first_word: usize,
    pub last_word: usize,
}

/// What a proposal asks to build: the body in play order, and an optional
/// hook played first (a flash-forward; it may repeat inside the body).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClipShape {
    pub hook: Option<SegmentRef>,
    pub segments: Vec<SegmentRef>,
}

/// What a resolved range plays.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Hook,
    Body,
}

/// One stretch of one source a built clip plays, in play order, with the
/// tightening cuts inside it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResolvedRange {
    pub role: Role,
    pub piece: usize,
    pub source: usize,
    pub first_word: usize,
    pub last_word: usize,
    pub start_secs: f64,
    pub end_secs: f64,
    pub cuts: Vec<TightCut>,
}

/// A proposal turned into source ranges.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Resolved {
    pub ranges: Vec<ResolvedRange>,
    /// Seconds played before tightening.
    pub raw_secs: f64,
    /// Seconds played after tightening — what the gate measures.
    pub tight_secs: f64,
    /// The body's first and last sentence.
    pub first_sentence: usize,
    pub last_sentence: usize,
}

/// Why a proposal was refused.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ClipRefusal {
    NoSegments,
    WordOutOfRange,
    InvertedSegment,
    OverlappingSegments,
    /// A segment starts on a word that does not begin a sentence.
    StartNotAtSentence,
    /// A segment ends on a word that does not end a sentence.
    EndNotAtSentence,
    /// An edge falls where two words overlap in time.
    EdgeInsideWord,
    StartsInRetake,
    EndsInRetake,
    HookNotWholeSentences,
    HookTooLong {
        secs: f64,
    },
    /// `secs` after tightening, outside every target's tolerance; the closest
    /// target and its accepted range.
    DurationOutOfRange {
        secs: f64,
        target: u32,
        min_secs: f64,
        max_secs: f64,
    },
}

impl fmt::Display for ClipRefusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NoSegments => write!(f, "the clip has no segments"),
            Self::WordOutOfRange => write!(f, "a segment names an index past the view"),
            Self::InvertedSegment => write!(f, "a segment's first index is after its last"),
            Self::OverlappingSegments => write!(f, "two segments of the clip share words"),
            Self::StartNotAtSentence => write!(
                f,
                "a segment starts mid-sentence (only a stitched inner edge may fall on a clause boundary: a comma, colon or dash then a {CLAUSE_PAUSE_S} s pause)"
            ),
            Self::EndNotAtSentence => write!(
                f,
                "a segment ends mid-sentence (only a stitched inner edge may fall on a clause boundary: a comma, colon or dash then a {CLAUSE_PAUSE_S} s pause)"
            ),
            Self::EdgeInsideWord => write!(
                f,
                "an edge falls inside a word: the words either side overlap in time, so there is no clean cut point"
            ),
            Self::StartsInRetake => {
                write!(
                    f,
                    "a segment starts inside a reviewed retake's deleted take (it would replay the flub)"
                )
            }
            Self::EndsInRetake => {
                write!(
                    f,
                    "a segment ends inside a reviewed retake's deleted take (it would replay the flub)"
                )
            }
            Self::HookNotWholeSentences => write!(
                f,
                "the hook must be one to {HOOK_MAX_SENTENCES} whole sentences"
            ),
            Self::HookTooLong { secs } => {
                write!(f, "the hook runs {secs:.1} s; at most {HOOK_MAX_S} s")
            }
            Self::DurationOutOfRange {
                secs,
                target,
                min_secs,
                max_secs,
            } => write!(
                f,
                "the clip runs {secs:.1} s after tightening; the closest target, {target} s, accepts {min_secs:.1}-{max_secs:.1} s"
            ),
        }
    }
}

/// An issue that does not refuse a proposal, shown with it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ClipWarning {
    /// The first sentence leans on context the clip does not carry.
    ContextOpen { word: String },
    /// The last sentence is a question the clip does not answer.
    EndsOnQuestion,
    /// The last sentence does not end on a sentence-final mark.
    RunsOn,
    /// The body crosses topic breaks.
    SpansTopics { topics: usize },
    /// More than half of it is also in another proposal (by index in the
    /// batch).
    OverlapsProposal { other: usize, share: f64 },
}

impl fmt::Display for ClipWarning {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ContextOpen { word } => {
                write!(
                    f,
                    "opens on \"{word}\", which leans on something said before the clip"
                )
            }
            Self::EndsOnQuestion => write!(f, "ends on a question it does not answer"),
            Self::RunsOn => write!(
                f,
                "the last sentence has no full stop: the thought may run on"
            ),
            Self::SpansTopics { topics } => write!(f, "spans {topics} topics"),
            Self::OverlapsProposal { other, share } => {
                write!(f, "{:.0}% of it is also in proposal {other}", share * 100.0)
            }
        }
    }
}

/// The gate's answer for one proposal.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "verdict", rename_all = "snake_case")]
pub enum ClipVerdict {
    Verified {
        resolved: Resolved,
    },
    Warned {
        resolved: Resolved,
        warnings: Vec<ClipWarning>,
    },
    Refused {
        reason: ClipRefusal,
        /// Sorted, unique word indices to fix.
        offending: Vec<usize>,
    },
}

impl ClipVerdict {
    pub fn resolved(&self) -> Option<&Resolved> {
        match self {
            Self::Verified { resolved } | Self::Warned { resolved, .. } => Some(resolved),
            Self::Refused { .. } => None,
        }
    }
}

/// Everything the gate reads: the analysed view and the evidence.
pub struct GateContext<'a> {
    pub words: &'a [IndexedWord],
    pub piece_of_word: &'a [usize],
    pub pieces: &'a [ViewPiece],
    pub sentences: &'a [Sentence],
    pub sentence_of_word: &'a [usize],
    pub topic_of_sentence: &'a [usize],
    pub evidence: &'a [SourceEvidence],
    pub retake_cuts: &'a [RetakeCut],
    /// Targets the run asked for (seconds; each one of [`ALLOWED_DURATIONS`]).
    pub durations: &'a [u32],
    pub tighten: TightenOptions,
}

impl GateContext<'_> {
    fn piece(&self, word: usize) -> usize {
        self.piece_of_word.get(word).copied().unwrap_or(0)
    }

    fn source_of(&self, piece: usize) -> usize {
        self.pieces.get(piece).map_or(0, |p| p.source)
    }

    fn sentence_starts_at(&self, word: usize) -> bool {
        self.sentence_of_word
            .get(word)
            .and_then(|&s| self.sentences.get(s))
            .is_some_and(|s| s.first_word == word)
    }

    fn sentence_ends_at(&self, word: usize) -> bool {
        self.sentence_of_word
            .get(word)
            .and_then(|&s| self.sentences.get(s))
            .is_some_and(|s| s.last_word == word)
    }

    /// The boundary between `a` and `a + 1` is a clause boundary: same piece,
    /// a clause mark on `a`, and a pause of at least [`CLAUSE_PAUSE_S`].
    fn clause_edge(&self, a: usize) -> bool {
        let b = a + 1;
        b < self.words.len()
            && self.piece(a) == self.piece(b)
            && word_end(&self.words[a].text) == WordEnd::Clause
            && self.words[b].start_secs - self.words[a].end_secs >= CLAUSE_PAUSE_S
    }

    /// The words either side of the boundary between `a` and `a + 1` overlap
    /// in time (same piece only: across pieces the window edge is the cut).
    fn overlapping(&self, a: usize) -> bool {
        let b = a + 1;
        b < self.words.len()
            && self.piece(a) == self.piece(b)
            && self.words[a].end_secs > self.words[b].start_secs + TIME_EPS
    }

    /// The sentence word `word` is in (0 for an index the analysis did not
    /// cover — `check` has already refused any index past the view).
    fn sentence(&self, word: usize) -> usize {
        self.sentence_of_word.get(word).copied().unwrap_or(0)
    }

    fn in_retake(&self, word: usize) -> bool {
        let w = &self.words[word];
        let mid = (w.start_secs + w.end_secs) / 2.0;
        let source = self.source_of(self.piece(word));
        self.retake_cuts
            .iter()
            .any(|c| c.source == source && mid >= c.start_secs && mid < c.end_secs)
    }

    /// Split a segment into per-piece ranges, padded at its outer edges.
    fn resolve_segment(&self, seg: SegmentRef, role: Role) -> Vec<ResolvedRange> {
        let mut out = Vec::new();
        let mut a = seg.first_word;
        while a <= seg.last_word {
            let p = self.piece(a);
            let mut b = a;
            while b < seg.last_word && self.piece(b + 1) == p {
                b += 1;
            }
            let window = self.pieces.get(p).copied().unwrap_or(ViewPiece {
                source: 0,
                start_secs: f64::NEG_INFINITY,
                end_secs: f64::INFINITY,
            });
            let start = if a == seg.first_word {
                let room = if a > 0 && self.piece(a - 1) == p {
                    (self.words[a].start_secs - self.words[a - 1].end_secs).max(0.0) / 2.0
                } else {
                    (self.words[a].start_secs - window.start_secs).max(0.0)
                };
                (self.words[a].start_secs - EDGE_HEAD_PAD_S.min(room)).max(window.start_secs)
            } else {
                window.start_secs.max(0.0)
            };
            let end = if b == seg.last_word {
                let room = if b + 1 < self.words.len() && self.piece(b + 1) == p {
                    (self.words[b + 1].start_secs - self.words[b].end_secs).max(0.0) / 2.0
                } else {
                    (window.end_secs - self.words[b].end_secs).max(0.0)
                };
                (self.words[b].end_secs + EDGE_TAIL_PAD_S.min(room)).min(window.end_secs)
            } else {
                window.end_secs
            };
            let source = window.source;
            let plan = tighten_range(
                self.words,
                a,
                b,
                start,
                end,
                source,
                self.evidence.get(source),
                self.retake_cuts,
                self.tighten,
            );
            out.push(ResolvedRange {
                role,
                piece: p,
                source,
                first_word: a,
                last_word: b,
                start_secs: start,
                end_secs: end,
                cuts: plan.cuts,
            });
            a = b + 1;
        }
        out
    }

    /// The tolerance band of one target.
    pub fn band(target: u32) -> (f64, f64) {
        let t = f64::from(target);
        (t * (1.0 - TOLERANCE_UNDER), t * (1.0 + TOLERANCE_OVER))
    }

    fn duration_refusal(&self, secs: f64) -> Option<ClipRefusal> {
        let targets: &[u32] = if self.durations.is_empty() {
            &ALLOWED_DURATIONS
        } else {
            self.durations
        };
        if targets.iter().any(|&t| {
            let (lo, hi) = Self::band(t);
            secs >= lo - TIME_EPS && secs <= hi + TIME_EPS
        }) {
            return None;
        }
        let closest = targets
            .iter()
            .copied()
            .min_by(|&a, &b| {
                (f64::from(a) - secs)
                    .abs()
                    .total_cmp(&(f64::from(b) - secs).abs())
            })
            .unwrap_or(ALLOWED_DURATIONS[1]);
        let (lo, hi) = Self::band(closest);
        Some(ClipRefusal::DurationOutOfRange {
            secs,
            target: closest,
            min_secs: lo,
            max_secs: hi,
        })
    }
}

fn refuse(reason: ClipRefusal, mut offending: Vec<usize>) -> ClipVerdict {
    offending.sort_unstable();
    offending.dedup();
    ClipVerdict::Refused { reason, offending }
}

/// Resolve and judge one proposal, without overlap warnings (those need the
/// rest of the batch — see [`check_proposals`]).
pub fn check(ctx: &GateContext<'_>, shape: &ClipShape) -> ClipVerdict {
    if shape.segments.is_empty() {
        return refuse(ClipRefusal::NoSegments, Vec::new());
    }
    let n = ctx.words.len();
    let all: Vec<SegmentRef> = shape
        .hook
        .iter()
        .chain(shape.segments.iter())
        .copied()
        .collect();
    for s in &all {
        let past: Vec<usize> = [s.first_word, s.last_word]
            .into_iter()
            .filter(|&i| i >= n)
            .collect();
        if !past.is_empty() {
            return refuse(ClipRefusal::WordOutOfRange, past);
        }
        if s.first_word > s.last_word {
            return refuse(
                ClipRefusal::InvertedSegment,
                vec![s.first_word, s.last_word],
            );
        }
    }
    for (i, a) in shape.segments.iter().enumerate() {
        for b in &shape.segments[i + 1..] {
            let lo = a.first_word.max(b.first_word);
            let hi = a.last_word.min(b.last_word);
            if lo <= hi {
                return refuse(ClipRefusal::OverlappingSegments, (lo..=hi).collect());
            }
        }
    }

    // Edges. Inner edges (where two body segments are stitched) may fall on a
    // clause boundary; outer edges and the hook's must be sentence edges.
    let last = shape.segments.len() - 1;
    for (i, s) in shape.segments.iter().enumerate() {
        let start_ok = ctx.sentence_starts_at(s.first_word)
            || (i > 0 && s.first_word > 0 && ctx.clause_edge(s.first_word - 1));
        if !start_ok {
            return refuse(ClipRefusal::StartNotAtSentence, vec![s.first_word]);
        }
        let end_ok =
            ctx.sentence_ends_at(s.last_word) || (i < last && ctx.clause_edge(s.last_word));
        if !end_ok {
            return refuse(ClipRefusal::EndNotAtSentence, vec![s.last_word]);
        }
    }
    if let Some(h) = shape.hook {
        let whole = ctx.sentence_starts_at(h.first_word) && ctx.sentence_ends_at(h.last_word);
        let count = (ctx.sentence(h.last_word) + 1).saturating_sub(ctx.sentence(h.first_word));
        if !whole || count > HOOK_MAX_SENTENCES {
            return refuse(
                ClipRefusal::HookNotWholeSentences,
                vec![h.first_word, h.last_word],
            );
        }
    }
    for s in &all {
        if s.first_word > 0 && ctx.overlapping(s.first_word - 1) {
            return refuse(
                ClipRefusal::EdgeInsideWord,
                vec![s.first_word - 1, s.first_word],
            );
        }
        if ctx.overlapping(s.last_word) {
            return refuse(
                ClipRefusal::EdgeInsideWord,
                vec![s.last_word, s.last_word + 1],
            );
        }
    }
    for s in &all {
        if ctx.in_retake(s.first_word) {
            return refuse(ClipRefusal::StartsInRetake, vec![s.first_word]);
        }
        if ctx.in_retake(s.last_word) {
            return refuse(ClipRefusal::EndsInRetake, vec![s.last_word]);
        }
    }

    let mut ranges = Vec::new();
    if let Some(h) = shape.hook {
        let hook = ctx.resolve_segment(h, Role::Hook);
        let secs: f64 = hook
            .iter()
            .map(|r| r.end_secs - r.start_secs - r.cuts.iter().map(TightCut::secs).sum::<f64>())
            .sum();
        if secs > HOOK_MAX_S + TIME_EPS {
            return refuse(
                ClipRefusal::HookTooLong { secs },
                vec![h.first_word, h.last_word],
            );
        }
        ranges.extend(hook);
    }
    for s in &shape.segments {
        ranges.extend(ctx.resolve_segment(*s, Role::Body));
    }
    let raw_secs: f64 = ranges.iter().map(|r| r.end_secs - r.start_secs).sum();
    let cut_secs: f64 = ranges
        .iter()
        .flat_map(|r| r.cuts.iter())
        .map(TightCut::secs)
        .sum();
    let tight_secs = raw_secs - cut_secs;
    let first = shape.segments[0];
    let final_seg = shape.segments[last];
    if let Some(reason) = ctx.duration_refusal(tight_secs) {
        return refuse(reason, vec![first.first_word, final_seg.last_word]);
    }

    let first_sentence = ctx.sentence(first.first_word);
    let last_sentence = ctx.sentence(final_seg.last_word);
    let mut warnings = Vec::new();
    if let Some(s) = ctx.sentences.get(first_sentence)
        && let Some(Tag::ContextOpen { word }) = opener_tags(ctx.words, s)
            .into_iter()
            .find(|t| matches!(t, Tag::ContextOpen { .. }))
    {
        warnings.push(ClipWarning::ContextOpen { word });
    }
    if let Some(s) = ctx.sentences.get(last_sentence) {
        if s.ending == Ending::Question {
            warnings.push(ClipWarning::EndsOnQuestion);
        } else if !completes(s) {
            warnings.push(ClipWarning::RunsOn);
        }
    }
    let mut topics: Vec<usize> = shape
        .segments
        .iter()
        .flat_map(|s| ctx.sentence(s.first_word)..=ctx.sentence(s.last_word))
        .filter_map(|s| ctx.topic_of_sentence.get(s).copied())
        .collect();
    topics.sort_unstable();
    topics.dedup();
    if topics.len() > 1 {
        warnings.push(ClipWarning::SpansTopics {
            topics: topics.len(),
        });
    }

    let resolved = Resolved {
        ranges,
        raw_secs,
        tight_secs,
        first_sentence,
        last_sentence,
    };
    if warnings.is_empty() {
        ClipVerdict::Verified { resolved }
    } else {
        ClipVerdict::Warned { resolved, warnings }
    }
}

/// Seconds of `a`'s body that `b`'s body also plays (same source, overlapping
/// source time).
fn overlap_secs(a: &Resolved, b: &Resolved) -> f64 {
    let mut total = 0.0;
    for x in a.ranges.iter().filter(|r| r.role == Role::Body) {
        for y in b
            .ranges
            .iter()
            .filter(|r| r.role == Role::Body && r.source == x.source)
        {
            total += (x.end_secs.min(y.end_secs) - x.start_secs.max(y.start_secs)).max(0.0);
        }
    }
    total
}

/// [`check`] every proposal of a batch, then warn where one's body is more
/// than [`OVERLAP_WARN_SHARE`] inside another's. Verdicts in the order given.
pub fn check_proposals(ctx: &GateContext<'_>, shapes: &[ClipShape]) -> Vec<ClipVerdict> {
    let mut verdicts: Vec<ClipVerdict> = shapes.iter().map(|s| check(ctx, s)).collect();
    let resolved: Vec<Option<Resolved>> = verdicts.iter().map(|v| v.resolved().cloned()).collect();
    for (i, verdict) in verdicts.iter_mut().enumerate() {
        let Some(mine) = resolved[i].as_ref() else {
            continue;
        };
        let body: f64 = mine
            .ranges
            .iter()
            .filter(|r| r.role == Role::Body)
            .map(|r| r.end_secs - r.start_secs)
            .sum();
        if body <= 0.0 {
            continue;
        }
        let worst = resolved
            .iter()
            .enumerate()
            .filter(|(j, _)| *j != i)
            .filter_map(|(j, r)| r.as_ref().map(|r| (j, overlap_secs(mine, r) / body)))
            .filter(|&(_, share)| share > OVERLAP_WARN_SHARE)
            .max_by(|a, b| a.1.total_cmp(&b.1));
        if let Some((other, share)) = worst {
            let warning = ClipWarning::OverlapsProposal {
                other,
                share: (share * 100.0).round() / 100.0,
            };
            match verdict {
                ClipVerdict::Verified { resolved } => {
                    let resolved = resolved.clone();
                    *verdict = ClipVerdict::Warned {
                        resolved,
                        warnings: vec![warning],
                    };
                }
                ClipVerdict::Warned { warnings, .. } => warnings.push(warning),
                ClipVerdict::Refused { .. } => {}
            }
        }
    }
    verdicts
}

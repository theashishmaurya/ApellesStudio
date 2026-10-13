//! Retake proposals made OUTSIDE the app — the word-indexed transcript a client
//! reads, and the deterministic coverage gate its answer must pass (D-380).
//!
//! **What this is.** Since D-380 the retake *judgement* — which stretches of a
//! raw recording are the same line said again, and which delivery to keep — is
//! made by the MCP client (the LLM the user already connects), not by
//! [`crate::retake`]'s string rules. D-379's proof of concept had nine blind
//! client runs lose 0.00 s of unique speech where the detector lost 40.24 s.
//! The app runs no model for this. It does three mechanical things, all here:
//!
//! 1. **Renders the input** — [`render_indexed`] turns transcript words into the
//!    exact numbered-word view the POC's clients read (`index<TAB>start-end<TAB>
//!    word`, with `--- segment` separators), so what the app hands a client is
//!    byte-for-byte what was measured.
//! 2. **Converts the answer** — a client proposes groups as word-index ranges
//!    ([`ProposedGroup`]); [`check_and_resolve`] turns each accepted one into
//!    source-second [`CutRange`]s, padded by at most [`EDGE_PAD_MAX_SECS`].
//! 3. **Refuses what would lose words** — the coverage gate. A group is refused
//!    when a take it would delete carries a content word the kept take does not
//!    ([`Refusal::ContentAbsentFromKeptTake`]), when its kept take only holds the
//!    deleted words out of order ([`Refusal::UnalignedContentRun`]), when it is
//!    malformed, or when it fights another group. A refusal names the offending
//!    word indices, so a client can narrow the take and resubmit.
//!
//! **What it does NOT do.** It does not find retakes and does not judge take
//! quality: the gate is **necessary, not sufficient**. It proves that the
//! words a cut removes survive in the kept take; it cannot tell a fluent take
//! from a flubbed one, cannot hear a mis-read word the transcript got right,
//! and forgives every [`crate::phrase`] stopword unconditionally — so a cut
//! whose only difference from the keeper is a "not", a "no" or a spoken number
//! passes (those are stopwords there, for D-365's reasons). It reads no file,
//! no audio and no timeline, and it never cuts: an accepted verdict is a
//! proposal the timeline applies, as everywhere in this crate (D-318).
//!
//! ## Why not `retake::word_overlap`
//!
//! [`crate::retake::word_overlap`] is the guard D-366 built and B-246 / D-378
//! showed to be blind: it scores a cut by the *fraction* of its vocabulary the
//! keeper shares, so shared function words or a shared tail lift an utterance
//! with a unique head over its 0.5 bar (C019's `"about an 80% cut from one
//! structural change"` rode through on `"one more thing to know the notes"`).
//! A fraction always forgives *some* unique words. This gate forgives none: it
//! aligns the two token sequences (LCS) and then accounts for every content
//! token of the cut that did not align, one by one, against a closed list of
//! reasons a word may be absent from the keeper and still not be lost
//! (`content_shortfall`): a stopword, a filler, a false start, a stutter, or
//! a near-spelling of a keeper word (ASR variance between two readings).
//!
//! ## Nested stutters
//!
//! A kept delivery can itself contain a stutter that another group cuts — C038's
//! outro keeps `"... and mechanics and mechanics ..."` while a second group cuts
//! one `"and mechanics"`. A group may therefore cut *inside* another group's
//! kept take, but only when it is **nested** there (all of its takes lie inside
//! that kept take), and only when the outer group's deleted takes still pass the
//! content rule against what is left of its keeper once the stutter is gone.
//! Any other overlap between one group's cut and another's keeper is refused.
//! Groups are judged in the order given; the rule is symmetric, so a nested
//! group proposed before its container is handled the same way.
//!
//! The constants are measured, not picked: `crates/apelles-speech/tests/
//! retake_eval.rs` runs the gate against oracle proposals built from the
//! hand labels (must accept), against the old detector's over-cutting groups
//! (must refuse), and against the nine POC runs; the sweep and the numbers are
//! in D-380 and `docs/notes/retake-detection.md` §11.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use strsim::normalized_levenshtein;

use crate::phrase::is_stopword;
use crate::retake::normalise;

/// How far a cut edge may be pushed out past its word's own timestamp, into the
/// gap to the neighbouring word — and never further than that gap's midpoint.
///
/// Parakeet word times are model output, not measurements: D-376 found ends
/// that are seconds late (fixed at the source) and one real sub-word word that
/// now ends early, and the model's time unit is one TDT token of up to
/// **0.32 s** (5 frames × 0.08 s — the same unit `SEGMENT_GAP_S` was set to in
/// D-376). So a word edge is only trustworthy to within one maximum-length
/// token; padding by that much keeps an early-stamped word's tail out of the
/// result, and the midpoint cap means a pad can never reach a word that stays.
pub const EDGE_PAD_MAX_SECS: f64 = 0.32;

/// Normalised Levenshtein similarity at or above which two tokens of at least
/// [`FUZZY_MIN_CHARS`] characters count as the same word — the ASR spelling one
/// long word two ways across two deliveries.
///
/// **0.9, measured, and deliberately strict.** Lowering it does buy accepted
/// correct cuts (oracle refusals 17 → 14 at 0.8, → 10 at 0.6), but every
/// setting that changes a verdict also makes distinct real words "the same":
/// among the 617 distinct ≥ 4-character tokens of the three labelled
/// transcripts, 103 pairs match at 0.8 — `ever`/`never`, `changing`/
/// `unchanging`, `difference`/`inference` — and 30 still at 0.85
/// (`content`/`context`, `billions`/`millions`). The most similar distinct pair
/// is 0.889 (`generated`/`generates`), so 0.9 is the loosest bar at which no
/// two different words of this corpus match. A refusal costs recall and is
/// recoverable; a false match is the over-cut D-318 forbids. Sweep:
/// `docs/notes/retake-detection.md` §11.3.
pub const FUZZY_MATCH: f64 = 0.9;

/// Shortest token, in characters, that may match another by spelling rather
/// than exactly. Below it, one edit is most of the word: `"cat"`/`"car"`.
pub const FUZZY_MIN_CHARS: usize = 4;

/// How many consecutive content tokens of a deleted take may fail to align with
/// the kept take — each present *somewhere* in it, but not in order — before
/// the group is refused anyway. A sentence assembled from the keeper's
/// vocabulary in a different order says something the keeper does not.
///
/// 3, measured: at every fuzzy setting swept, 3, 4 and unlimited give the same
/// oracle refusals, detector misses and client-run results, while 2 (at every
/// fuzzy bar up to 0.8) refuses two more of the POC clients' groups. So 3 is
/// the strictest value that costs nothing at any setting — and at the chosen
/// [`FUZZY_MATCH`] the rule decides no verdict on this corpus at all; it
/// stands for the shape the unit tests build, not for a measured case.
/// Sweep: `docs/notes/retake-detection.md` §11.3.
pub const MAX_UNALIGNED_CONTENT_RUN: usize = 3;

/// Hesitation sounds a deleted take may carry that the kept take need not: they
/// carry no content. A closed list on purpose — anything else must be
/// accounted for by the content rule.
const FILLERS: &[&str] = &["ah", "er", "erm", "hmm", "mm", "uh", "um"];

/// The legend [`render_indexed`] prints above the words: what each line is.
/// Three lines (the third blank), so a reader can strip it by line count.
pub const INDEXED_VIEW_LEGEND: &str = "# One word per line: index, start-end seconds, word. Cite words by index.\n\
# A line starting with '--- segment' marks where the speech recogniser began a new segment (a pause or sentence break); it is a hint only.\n\
\n";

/// Two float times this close are the same instant. Transcript times are
/// two-decimal model output.
const TIME_EPS: f64 = 1e-6;

/// One transcript word, as the gate and the renderer see it.
///
/// `run` is a key the caller assigns: words in different runs are never padded
/// towards each other and never fall in one [`CutRange`]. A run is one
/// transcript segment inside one clip — across a run boundary the next word
/// may be in another clip, where a gap in source seconds means nothing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IndexedWord {
    pub text: String,
    pub start_secs: f64,
    pub end_secs: f64,
    pub run: u32,
}

/// The time span a run's `--- segment` separator line shows: the transcript
/// segment's own `start`/`end`, which is not always its words' extent (a word
/// stamped at zero length on the boundary belongs to the next run by start
/// time). Indexed by [`IndexedWord::run`].
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct RunSpan {
    pub start_secs: f64,
    pub end_secs: f64,
}

/// One word in `ai-media/transcribe.py`'s contract (D-374): `{word, start, end}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TranscriptWord {
    pub word: String,
    pub start: f64,
    pub end: f64,
}

/// One segment in `ai-media/transcribe.py`'s contract (D-374). Only the fields
/// indexing needs; the contract's `text` is the words joined.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TranscriptSegment {
    pub start: f64,
    pub end: f64,
    pub words: Vec<TranscriptWord>,
}

/// A client's retake group: two or more takes, each an inclusive word-index
/// range `(first, last)`, and which of them to keep (an index into `takes`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProposedGroup {
    pub takes: Vec<(usize, usize)>,
    pub keep: usize,
}

/// One stretch of source audio an accepted group deletes: a maximal sub-range
/// `first..=last` of one deleted take that stays inside one run, with its edges
/// padded per [`EDGE_PAD_MAX_SECS`].
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct CutRange {
    pub first: usize,
    pub last: usize,
    pub start_secs: f64,
    pub end_secs: f64,
}

/// Why a group was refused. Every variant names its offending word indices in
/// [`GroupVerdict::Refused::offending`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Refusal {
    /// A take names a word index past the transcript (offending: those indices).
    WordOutOfRange,
    /// A take's `first` is after its `last` (offending: both).
    InvertedTake,
    /// Fewer than two takes: one delivery is not a retake.
    TooFewTakes,
    /// `keep` does not index a take.
    KeepOutOfRange,
    /// Two takes of the group share words (offending: the shared words).
    OverlappingTakes,
    /// A deleted take overlaps the kept take of `group`, an earlier-accepted
    /// group this one is not nested inside (offending: the shared words).
    CutsKeptTakeOf { group: usize },
    /// This group's kept take overlaps a take `group` deletes, and `group` is
    /// not nested inside it (offending: the shared words).
    KeepsCutOf { group: usize },
    /// This group is nested in `group`'s kept take, and cutting it would leave
    /// `group`'s deleted takes with words that kept take no longer holds
    /// (offending: those words, in `group`'s deleted takes).
    StarvesContainer { group: usize },
    /// A deleted take holds content words the kept take does not (offending:
    /// those words).
    ContentAbsentFromKeptTake,
    /// A deleted take's content words are all in the kept take, but at least
    /// [`MAX_UNALIGNED_CONTENT_RUN`] in a row do not align with it in order
    /// (offending: those words).
    UnalignedContentRun,
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::WordOutOfRange => write!(f, "a take names a word index past the transcript"),
            Self::InvertedTake => write!(f, "a take's first word is after its last"),
            Self::TooFewTakes => write!(f, "a group needs at least two takes"),
            Self::KeepOutOfRange => write!(f, "keep does not index a take"),
            Self::OverlappingTakes => write!(f, "two takes of the group share words"),
            Self::CutsKeptTakeOf { group } => {
                write!(f, "a deleted take overlaps the kept take of group {group}")
            }
            Self::KeepsCutOf { group } => {
                write!(f, "the kept take overlaps a take group {group} deletes")
            }
            Self::StarvesContainer { group } => write!(
                f,
                "cutting this inside group {group}'s kept take leaves group {group}'s deleted words with no surviving copy"
            ),
            Self::ContentAbsentFromKeptTake => {
                write!(f, "a deleted take has words the kept take does not")
            }
            Self::UnalignedContentRun => write!(
                f,
                "a deleted take reorders the kept take's words into something it does not say"
            ),
        }
    }
}

/// The gate's answer for one [`ProposedGroup`], in the order given.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "verdict", rename_all = "snake_case")]
pub enum GroupVerdict {
    Accepted {
        cuts: Vec<CutRange>,
    },
    Refused {
        reason: Refusal,
        /// Word indices, sorted and unique — what to narrow before resubmitting.
        offending: Vec<usize>,
    },
}

/// The gate's two thresholds. [`Default`] is the measured setting
/// ([`FUZZY_MATCH`], [`MAX_UNALIGNED_CONTENT_RUN`]); the struct exists so the
/// eval can sweep them, the way [`crate::RetakeParams`] does for the detector.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct GateParams {
    pub fuzzy_match: f64,
    pub max_unaligned_content_run: usize,
}

impl Default for GateParams {
    fn default() -> Self {
        Self {
            fuzzy_match: FUZZY_MATCH,
            max_unaligned_content_run: MAX_UNALIGNED_CONTENT_RUN,
        }
    }
}

/// Index a `transcribe.py` transcript: every word in spoken order, its run the
/// index of the segment it falls in **by start time** — a word belongs to the
/// first segment, scanning in order, whose `end` it starts before. That is the
/// segment's own word list except for a word stamped at zero length exactly on
/// a segment's end (Parakeet does this to a repeated phrase, C019 326.60 s),
/// which goes with the speech that follows it. It is the rule D-379's POC input
/// was built with, so this reproduces that input exactly.
///
/// One source, one clip: run `i` is segment `i`, and the [`RunSpan`]s are the
/// segments' own spans. A caller indexing several clips offsets the runs.
pub fn index_transcript(segments: &[TranscriptSegment]) -> (Vec<IndexedWord>, Vec<RunSpan>) {
    let spans: Vec<RunSpan> = segments
        .iter()
        .map(|s| RunSpan {
            start_secs: s.start,
            end_secs: s.end,
        })
        .collect();
    let mut words = Vec::new();
    let mut seg = 0usize;
    for w in segments.iter().flat_map(|s| s.words.iter()) {
        while seg + 1 < segments.len() && w.start >= segments[seg].end - TIME_EPS {
            seg += 1;
        }
        words.push(IndexedWord {
            text: w.word.trim().to_string(),
            start_secs: w.start,
            end_secs: w.end,
            // A transcript with more than u32::MAX segments is not a recording.
            run: u32::try_from(seg).unwrap_or(u32::MAX),
        });
    }
    (words, spans)
}

/// A word whose run has no [`RunSpan`] to print.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("word {word} is in run {run}, which has no RunSpan")]
pub struct UnknownRun {
    pub word: usize,
    pub run: u32,
}

/// The word-indexed view a client reads: [`INDEXED_VIEW_LEGEND`], then one
/// `--- segment N  S-E` line wherever the run changes and one
/// `index<TAB>S-E<TAB>word` line per word, times to two decimals, the word
/// trimmed. Below the legend this is byte-identical to the input D-379's POC
/// was measured on (pinned by the eval's golden test).
pub fn render_indexed(words: &[IndexedWord], runs: &[RunSpan]) -> Result<String, UnknownRun> {
    let mut out = String::from(INDEXED_VIEW_LEGEND);
    let mut current: Option<u32> = None;
    for (i, w) in words.iter().enumerate() {
        if current != Some(w.run) {
            let span = usize::try_from(w.run)
                .ok()
                .and_then(|r| runs.get(r))
                .ok_or(UnknownRun {
                    word: i,
                    run: w.run,
                })?;
            out.push_str(&format!(
                "--- segment {}  {:.2}-{:.2}\n",
                w.run, span.start_secs, span.end_secs
            ));
            current = Some(w.run);
        }
        out.push_str(&format!(
            "{i}\t{:.2}-{:.2}\t{}\n",
            w.start_secs,
            w.end_secs,
            w.text.trim()
        ));
    }
    Ok(out)
}

/// Judge every group at the measured thresholds — see [`check_and_resolve_with`].
pub fn check_and_resolve(words: &[IndexedWord], groups: &[ProposedGroup]) -> Vec<GroupVerdict> {
    check_and_resolve_with(words, groups, &GateParams::default())
}

/// An accepted group, as later groups are checked against it.
struct Held {
    index: usize,
    keep: (usize, usize),
    cuts: Vec<(usize, usize)>,
    /// Words inside `keep` that groups nested in it delete.
    nested_cut: BTreeSet<usize>,
}

/// One normalised token and the word it came from (a word like `"it's"`
/// normalises to two tokens, `"it s"`).
struct Tok {
    text: String,
    word: usize,
}

/// Judge every group in the order given and resolve each accepted one to
/// source-second cut ranges. Pure and deterministic: same input, same verdicts.
pub fn check_and_resolve_with(
    words: &[IndexedWord],
    groups: &[ProposedGroup],
    p: &GateParams,
) -> Vec<GroupVerdict> {
    let mut held: Vec<Held> = Vec::new();
    let mut verdicts = Vec::with_capacity(groups.len());
    for (gi, g) in groups.iter().enumerate() {
        match judge(words, g, &held, p) {
            Ok((keep, cuts)) => {
                let cut_words: BTreeSet<usize> = cuts.iter().flat_map(|&(a, b)| a..=b).collect();
                for h in held.iter_mut() {
                    if nested_in(g, h.keep) {
                        h.nested_cut.extend(cut_words.iter().copied());
                    }
                }
                let nested_cut = held
                    .iter()
                    .filter(|h| nested_in_takes(&h.cuts, h.keep, keep))
                    .flat_map(|h| h.cuts.iter().flat_map(|&(a, b)| a..=b))
                    .collect();
                verdicts.push(GroupVerdict::Accepted {
                    cuts: cuts
                        .iter()
                        .flat_map(|&(a, b)| resolve(words, a, b))
                        .collect(),
                });
                held.push(Held {
                    index: gi,
                    keep,
                    cuts,
                    nested_cut,
                });
            }
            Err((reason, offending)) => {
                let offending: BTreeSet<usize> = offending.into_iter().collect();
                verdicts.push(GroupVerdict::Refused {
                    reason,
                    offending: offending.into_iter().collect(),
                });
            }
        }
    }
    verdicts
}

type Judged = Result<((usize, usize), Vec<(usize, usize)>), (Refusal, Vec<usize>)>;

/// One group against the transcript and the groups already accepted.
fn judge(words: &[IndexedWord], g: &ProposedGroup, held: &[Held], p: &GateParams) -> Judged {
    // Structure first: nothing below is meaningful on a malformed group.
    let past: Vec<usize> = g
        .takes
        .iter()
        .flat_map(|&(a, b)| [a, b])
        .filter(|&i| i >= words.len())
        .collect();
    if !past.is_empty() {
        return Err((Refusal::WordOutOfRange, past));
    }
    if let Some(&(a, b)) = g.takes.iter().find(|&&(a, b)| a > b) {
        return Err((Refusal::InvertedTake, vec![a, b]));
    }
    if g.takes.len() < 2 {
        return Err((Refusal::TooFewTakes, Vec::new()));
    }
    let Some(&keep) = g.takes.get(g.keep) else {
        return Err((Refusal::KeepOutOfRange, Vec::new()));
    };
    for (i, &x) in g.takes.iter().enumerate() {
        for &y in &g.takes[i + 1..] {
            let shared = shared_words(x, y);
            if !shared.is_empty() {
                return Err((Refusal::OverlappingTakes, shared));
            }
        }
    }
    let cuts: Vec<(usize, usize)> = g
        .takes
        .iter()
        .enumerate()
        .filter(|&(i, _)| i != g.keep)
        .map(|(_, &t)| t)
        .collect();

    // Against the groups already accepted. Overlap between one group's cut and
    // another's keeper is allowed only for a group nested in that keeper.
    for h in held {
        let into_keep: Vec<usize> = cuts.iter().flat_map(|&c| shared_words(c, h.keep)).collect();
        if !into_keep.is_empty() && !nested_in(g, h.keep) {
            return Err((Refusal::CutsKeptTakeOf { group: h.index }, into_keep));
        }
        let into_cut: Vec<usize> = h.cuts.iter().flat_map(|&c| shared_words(c, keep)).collect();
        if !into_cut.is_empty() && !nested_in_takes(&h.cuts, h.keep, keep) {
            return Err((Refusal::KeepsCutOf { group: h.index }, into_cut));
        }
    }

    // The content rule, against this keeper less whatever earlier groups nested
    // inside it delete.
    let nested: BTreeSet<usize> = held
        .iter()
        .filter(|h| nested_in_takes(&h.cuts, h.keep, keep))
        .flat_map(|h| h.cuts.iter().flat_map(|&(a, b)| a..=b))
        .collect();
    let kept = tokens(words, keep, &nested);
    let mut first_failure: Option<(Refusal, Vec<usize>)> = None;
    for &c in &cuts {
        if let Some(f) = content_shortfall(&tokens(words, c, &BTreeSet::new()), &kept, p) {
            first_failure = Some(match first_failure {
                Some((r, mut w)) if r == f.0 => {
                    w.extend(f.1);
                    (r, w)
                }
                Some(earlier) => earlier,
                None => f,
            });
        }
    }
    if let Some(f) = first_failure {
        return Err(f);
    }

    // A nested group must not starve the group whose keeper it cuts into.
    let own_cut: BTreeSet<usize> = cuts.iter().flat_map(|&(a, b)| a..=b).collect();
    for h in held.iter().filter(|h| nested_in(g, h.keep)) {
        let gone: BTreeSet<usize> = h.nested_cut.union(&own_cut).copied().collect();
        let container_kept = tokens(words, h.keep, &gone);
        let starved: Vec<usize> = h
            .cuts
            .iter()
            .filter_map(|&c| {
                content_shortfall(&tokens(words, c, &BTreeSet::new()), &container_kept, p)
            })
            .flat_map(|(_, w)| w)
            .collect();
        if !starved.is_empty() {
            return Err((Refusal::StarvesContainer { group: h.index }, starved));
        }
    }
    Ok((keep, cuts))
}

/// Every take of `g` lies inside `range`.
fn nested_in(g: &ProposedGroup, range: (usize, usize)) -> bool {
    g.takes.iter().all(|&(a, b)| a >= range.0 && b <= range.1)
}

/// A held group (its `cuts` plus its `keep`) lies wholly inside `range`.
fn nested_in_takes(cuts: &[(usize, usize)], keep: (usize, usize), range: (usize, usize)) -> bool {
    cuts.iter()
        .chain(std::iter::once(&keep))
        .all(|&(a, b)| a >= range.0 && b <= range.1)
}

/// The word indices two inclusive ranges share.
fn shared_words(x: (usize, usize), y: (usize, usize)) -> Vec<usize> {
    (x.0.max(y.0)..=x.1.min(y.1)).collect()
}

/// A take's normalised tokens, skipping the words in `except`.
fn tokens(words: &[IndexedWord], (a, b): (usize, usize), except: &BTreeSet<usize>) -> Vec<Tok> {
    (a..=b)
        .filter(|i| !except.contains(i))
        .flat_map(|i| {
            normalise(&words[i].text)
                .split(' ')
                .filter(|t| !t.is_empty())
                .map(|t| Tok {
                    text: t.to_string(),
                    word: i,
                })
                .collect::<Vec<_>>()
        })
        .collect()
}

/// Are two tokens the same word: equal, or both long enough and spelled within
/// [`GateParams::fuzzy_match`] of each other.
fn same_word(a: &str, b: &str, p: &GateParams) -> bool {
    a == b
        || (a.chars().count() >= FUZZY_MIN_CHARS
            && b.chars().count() >= FUZZY_MIN_CHARS
            && normalized_levenshtein(a, b) >= p.fuzzy_match)
}

fn is_filler(t: &str) -> bool {
    FILLERS.contains(&t)
}

/// `short` is a strict prefix of `long` — a word cut off and restarted.
fn is_false_start_of(short: &str, long: &str) -> bool {
    long.len() > short.len() && long.starts_with(short)
}

/// Which tokens of `cut` a longest common subsequence aligns with `kept`.
/// Ties resolve the same way every time (prefer skipping a `cut` token), so the
/// alignment — and so every verdict — is deterministic.
fn lcs_aligned(cut: &[Tok], kept: &[Tok], p: &GateParams) -> Vec<bool> {
    let (n, m) = (cut.len(), kept.len());
    // dp[i][j]: LCS length of cut[i..] and kept[j..].
    let mut dp = vec![vec![0u32; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            dp[i][j] = if same_word(&cut[i].text, &kept[j].text, p) {
                dp[i + 1][j + 1] + 1
            } else {
                dp[i + 1][j].max(dp[i][j + 1])
            };
        }
    }
    let mut aligned = vec![false; n];
    let (mut i, mut j) = (0, 0);
    while i < n && j < m {
        if same_word(&cut[i].text, &kept[j].text, p) && dp[i][j] == dp[i + 1][j + 1] + 1 {
            aligned[i] = true;
            i += 1;
            j += 1;
        } else if dp[i + 1][j] >= dp[i][j + 1] {
            i += 1;
        } else {
            j += 1;
        }
    }
    aligned
}

/// **The content rule.** Does deleting `cut` lose a word `kept` does not hold?
/// `None` when every content token is accounted for; otherwise the reason and
/// the offending words.
///
/// Every `cut` token the LCS does not align with `kept` must be forgiven by one
/// of five reasons, or the take is refused:
///
/// - **F1** a stopword ([`crate::phrase`]'s list) — no content of its own;
/// - **F2** a filler ([`FILLERS`]);
/// - **F3** a proper prefix of the next `cut` token or of some `kept` token —
///   a false start, `"the str"` before `"the structure"`;
/// - **F4** equal to a `cut` token the alignment *did* use — a stutter or a
///   looped phrase, `"the the"`, `"inference is everything, inference is
///   everything"`: the content is already accounted for by its aligned copy.
///   (The D-380 brief said "equal to the *previous* token"; measured, that
///   refused correct cuts of looped phrases — C038's `inference`, C040's
///   `every word turns` and `encoder builds` — as out-of-order content, and
///   the LCS may align either copy, so "previous" was also order-dependent.)
/// - **F5** the same word ([`same_word`]) as some `kept` token — present, but
///   not where the alignment could use it.
///
/// F1-F4 tokens are neutral for the second check; an F5 token is not, because
/// it is the one that is present only out of order: at least
/// [`GateParams::max_unaligned_content_run`] consecutive unaligned content
/// tokens refuse the take even when each is forgiven alone.
fn content_shortfall(cut: &[Tok], kept: &[Tok], p: &GateParams) -> Option<(Refusal, Vec<usize>)> {
    let aligned = lcs_aligned(cut, kept, p);
    let mut absent = Vec::new();
    let mut runs: Vec<usize> = Vec::new();
    let mut run: Vec<usize> = Vec::new();
    let close_run = |run: &mut Vec<usize>, runs: &mut Vec<usize>| {
        if run.len() >= p.max_unaligned_content_run {
            runs.append(run);
        }
        run.clear();
    };
    for (i, t) in cut.iter().enumerate() {
        let neutral = is_stopword(&t.text) || is_filler(&t.text);
        if aligned[i] {
            if !neutral {
                close_run(&mut run, &mut runs);
            }
            continue;
        }
        if neutral {
            continue;
        }
        let false_start = cut
            .get(i + 1)
            .is_some_and(|next| is_false_start_of(&t.text, &next.text))
            || kept.iter().any(|k| is_false_start_of(&t.text, &k.text));
        let stutter = cut
            .iter()
            .zip(&aligned)
            .any(|(other, &a)| a && other.text == t.text);
        if false_start || stutter {
            continue;
        }
        if !kept.iter().any(|k| same_word(&t.text, &k.text, p)) {
            absent.push(t.word);
        }
        run.push(t.word);
    }
    close_run(&mut run, &mut runs);
    if !absent.is_empty() {
        Some((Refusal::ContentAbsentFromKeptTake, absent))
    } else if !runs.is_empty() {
        Some((Refusal::UnalignedContentRun, runs))
    } else {
        None
    }
}

/// Split one deleted take `a..=b` at run boundaries and pad each piece's outer
/// edges by [`EDGE_PAD_MAX_SECS`], never past the midpoint of the gap to the
/// neighbouring word and never towards a word in another run.
fn resolve(words: &[IndexedWord], a: usize, b: usize) -> Vec<CutRange> {
    let mut out = Vec::new();
    let mut first = a;
    while first <= b {
        let run = words[first].run;
        let mut last = first;
        while last < b && words[last + 1].run == run {
            last += 1;
        }
        let piece = &words[first..=last];
        let start = piece
            .iter()
            .map(|w| w.start_secs)
            .fold(f64::INFINITY, f64::min);
        let end = piece
            .iter()
            .map(|w| w.end_secs)
            .fold(f64::NEG_INFINITY, f64::max);
        let before = first
            .checked_sub(1)
            .map(|i| &words[i])
            .filter(|w| w.run == run)
            .map_or(0.0, |w| pad(start - w.end_secs));
        let after = words
            .get(last + 1)
            .filter(|w| w.run == run)
            .map_or(0.0, |w| pad(w.start_secs - end));
        out.push(CutRange {
            first,
            last,
            start_secs: start - before,
            end_secs: end + after,
        });
        first = last + 1;
    }
    out
}

/// How far to push an edge into a gap of `gap` seconds.
fn pad(gap: f64) -> f64 {
    (gap / 2.0).clamp(0.0, EDGE_PAD_MAX_SECS)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Words from a sentence, one run, 0.4 s each with 0.1 s gaps.
    fn words(text: &str) -> Vec<IndexedWord> {
        words_in_runs(&[text])
    }

    /// Words from several sentences, one run each, laid end to end with the
    /// same spacing, plus a 1 s pause between runs.
    fn words_in_runs(runs: &[&str]) -> Vec<IndexedWord> {
        let mut out = Vec::new();
        let mut t = 0.0;
        for (r, text) in runs.iter().enumerate() {
            for w in text.split_whitespace() {
                out.push(IndexedWord {
                    text: w.to_string(),
                    start_secs: t,
                    end_secs: t + 0.4,
                    run: r as u32,
                });
                t += 0.5;
            }
            t += 1.0;
        }
        out
    }

    fn group(takes: &[(usize, usize)], keep: usize) -> ProposedGroup {
        ProposedGroup {
            takes: takes.to_vec(),
            keep,
        }
    }

    fn refusal(v: &GroupVerdict) -> Option<(Refusal, Vec<usize>)> {
        match v {
            GroupVerdict::Refused { reason, offending } => Some((*reason, offending.clone())),
            GroupVerdict::Accepted { .. } => None,
        }
    }

    fn one(w: &[IndexedWord], g: ProposedGroup) -> GroupVerdict {
        check_and_resolve(w, &[g])
            .pop()
            .unwrap_or_else(|| panic!("one group in, one verdict out"))
    }

    fn accepted(v: &GroupVerdict) -> bool {
        matches!(v, GroupVerdict::Accepted { .. })
    }

    #[test]
    fn the_render_format_is_the_pocs() {
        let segs = vec![
            TranscriptSegment {
                start: 2.72,
                end: 4.08,
                words: vec![
                    TranscriptWord {
                        word: " And".into(),
                        start: 2.72,
                        end: 3.04,
                    },
                    TranscriptWord {
                        word: " them.".into(),
                        start: 3.76,
                        end: 4.08,
                    },
                    // Zero length, stamped on the segment's end: goes with the
                    // next segment by start time.
                    TranscriptWord {
                        word: " There's".into(),
                        start: 4.08,
                        end: 4.08,
                    },
                ],
            },
            TranscriptSegment {
                start: 6.48,
                end: 8.0,
                words: vec![TranscriptWord {
                    word: " on.".into(),
                    start: 6.48,
                    end: 8.0,
                }],
            },
        ];
        let (w, runs) = index_transcript(&segs);
        assert_eq!(
            w.iter().map(|w| w.run).collect::<Vec<_>>(),
            vec![0, 0, 1, 1]
        );
        let text = render_indexed(&w, &runs).unwrap_or_else(|e| panic!("{e}"));
        let body = text.strip_prefix(INDEXED_VIEW_LEGEND).unwrap_or_default();
        assert_eq!(
            body,
            "--- segment 0  2.72-4.08\n0\t2.72-3.04\tAnd\n1\t3.76-4.08\tthem.\n\
             --- segment 1  6.48-8.00\n2\t4.08-4.08\tThere's\n3\t6.48-8.00\ton.\n"
        );
        assert_eq!(INDEXED_VIEW_LEGEND.lines().count(), 3);
    }

    #[test]
    fn rendering_a_word_in_an_unknown_run_is_an_error() {
        let w = words("hello there");
        assert_eq!(render_indexed(&w, &[]), Err(UnknownRun { word: 0, run: 0 }));
    }

    #[test]
    fn a_verbatim_retake_is_accepted_and_resolved_to_padded_seconds() {
        // 0-3 and 4-7: the same line twice.
        let w = words("the cache costs money the cache costs money");
        let v = one(&w, group(&[(0, 3), (4, 7)], 1));
        let GroupVerdict::Accepted { cuts } = v else {
            panic!("refused: {v:?}")
        };
        assert_eq!(cuts.len(), 1);
        let c = cuts[0];
        assert_eq!((c.first, c.last), (0, 3));
        // No word before: the start stays put. Gap after is 0.1 s: pad half.
        assert!((c.start_secs - 0.0).abs() < 1e-9);
        assert!((c.end_secs - (1.9 + 0.05)).abs() < 1e-9, "{}", c.end_secs);
    }

    #[test]
    fn padding_stops_at_the_cap_the_midpoint_and_the_run() {
        let mut w = words_in_runs(&["alpha beta gamma", "beta gamma"]);
        // Open a 2 s gap before "beta" (index 1) so the cap binds there.
        w[0].end_secs = w[1].start_secs - 2.0;
        let cuts = resolve(&w, 1, 3);
        assert_eq!(cuts.len(), 2, "split at the run boundary: {cuts:?}");
        assert!((cuts[0].start_secs - (w[1].start_secs - EDGE_PAD_MAX_SECS)).abs() < 1e-9);
        // The edge at the run boundary is not padded at all.
        assert!((cuts[0].end_secs - w[2].end_secs).abs() < 1e-9);
        assert!((cuts[1].start_secs - w[3].start_secs).abs() < 1e-9);
        assert_eq!((cuts[1].first, cuts[1].last), (3, 3));
        // A neighbour 0.1 s away: half the gap, so the pad never reaches it.
        let w = words("a b c");
        let c = resolve(&w, 1, 1)[0];
        assert!((c.start_secs - 0.45).abs() < 1e-9 && (c.end_secs - 0.95).abs() < 1e-9);
        // Overlapping neighbours (non-monotone stamps) pad nothing.
        let mut w = words("a b c");
        w[0].end_secs = 0.6;
        assert!((resolve(&w, 1, 1)[0].start_secs - 0.5).abs() < 1e-9);
    }

    #[test]
    fn every_structural_refusal() {
        let w = words("one two three four five six");
        let cases = [
            (
                group(&[(0, 1), (2, 9)], 1),
                Refusal::WordOutOfRange,
                vec![9],
            ),
            (
                group(&[(1, 0), (2, 3)], 1),
                Refusal::InvertedTake,
                vec![0, 1],
            ),
            (group(&[(0, 1)], 0), Refusal::TooFewTakes, vec![]),
            (group(&[(0, 1), (2, 3)], 2), Refusal::KeepOutOfRange, vec![]),
            (
                group(&[(0, 2), (2, 3)], 1),
                Refusal::OverlappingTakes,
                vec![2],
            ),
        ];
        for (g, reason, offending) in cases {
            assert_eq!(
                refusal(&one(&w, g.clone())),
                Some((reason, offending)),
                "{g:?}"
            );
        }
    }

    #[test]
    fn a_cut_into_another_groups_keeper_is_refused_and_so_is_the_reverse() {
        // "red apple red apple green pear green pear"
        let w = words("red apple red apple green pear green pear");
        // Group 0 keeps 2-3; group 1 then cuts 2-5, straddling it.
        let v = check_and_resolve(
            &w,
            &[group(&[(0, 1), (2, 3)], 1), group(&[(2, 5), (6, 7)], 1)],
        );
        assert!(accepted(&v[0]));
        assert_eq!(
            refusal(&v[1]),
            Some((Refusal::CutsKeptTakeOf { group: 0 }, vec![2, 3]))
        );
        // Group 0 cuts 2-3; group 1 then keeps 2-5.
        let v = check_and_resolve(
            &w,
            &[group(&[(2, 3), (0, 1)], 1), group(&[(6, 7), (2, 5)], 1)],
        );
        assert!(accepted(&v[0]));
        assert_eq!(
            refusal(&v[1]),
            Some((Refusal::KeepsCutOf { group: 0 }, vec![2, 3]))
        );
    }

    #[test]
    fn f1_stopwords_are_forgiven() {
        // Cut "and so the cache" vs keep "the cache".
        let w = words("and so the cache the cache");
        assert!(accepted(&one(&w, group(&[(0, 3), (4, 5)], 1))));
    }

    #[test]
    fn f2_fillers_are_forgiven() {
        let w = words("um the uh cache the cache");
        assert!(accepted(&one(&w, group(&[(0, 3), (4, 5)], 1))));
    }

    #[test]
    fn f3_false_starts_are_forgiven() {
        // "the str" before "the structure" (POC C019), and a prefix of the
        // next token inside the cut: "spec speculative decoding".
        let w = words("the str the structure");
        assert!(accepted(&one(&w, group(&[(0, 1), (2, 3)], 1))));
        let w = words("spec speculative decoding speculative decoding");
        assert!(accepted(&one(&w, group(&[(0, 2), (3, 4)], 1))));
    }

    #[test]
    fn f4_stutters_are_forgiven() {
        // The repeated "cache" is in the keeper anyway (F5 would forgive it);
        // what F4 adds is that a stutter does not count towards the run limit.
        // At a limit of 1, the same unaligned word without the stutter is
        // refused and with it is not.
        let w = words("cache cache costs cache costs");
        let tight = GateParams {
            max_unaligned_content_run: 1,
            ..GateParams::default()
        };
        let v = check_and_resolve_with(&w, &[group(&[(0, 2), (3, 4)], 1)], &tight);
        assert!(accepted(&v[0]), "{v:?}");
        let w = words("cache money costs cache costs");
        let v = check_and_resolve_with(&w, &[group(&[(0, 2), (3, 4)], 1)], &tight);
        assert_eq!(
            refusal(&v[0]).map(|r| r.0),
            Some(Refusal::ContentAbsentFromKeptTake)
        );
    }

    #[test]
    fn f5_near_spellings_of_a_keeper_word_are_forgiven() {
        // Two ASR spellings of one long word: one edit in twelve (0.917).
        let w = words("like a economically like a economicaly");
        assert!(accepted(&one(&w, group(&[(0, 2), (3, 5)], 1))));
        // ...but not a short word one edit away: "bin" is not "bill".
        let w = words("final bin final bill");
        assert_eq!(
            refusal(&one(&w, group(&[(0, 1), (2, 3)], 1))),
            Some((Refusal::ContentAbsentFromKeptTake, vec![1]))
        );
    }

    #[test]
    fn a_take_repeating_nothing_is_refused() {
        // B-246 shape 1: C019 parakeet's "This is the mistake." cut against an
        // unrelated keeper.
        let w = words("this is the mistake writing the notes costs more");
        assert_eq!(
            refusal(&one(&w, group(&[(0, 3), (4, 8)], 1))),
            Some((Refusal::ContentAbsentFromKeptTake, vec![3]))
        );
    }

    #[test]
    fn a_fragment_keeper_cannot_take_the_full_delivery_with_it() {
        // B-246 shape 2: C040's recap keeps the fragment and cuts the line.
        let w = words(
            "quick recap attention is the model deciding how much to focus \
             by matching each word's query",
        );
        let v = one(&w, group(&[(0, 10), (11, 15)], 1));
        let (reason, offending) = refusal(&v).unwrap_or_else(|| panic!("accepted"));
        assert_eq!(reason, Refusal::ContentAbsentFromKeptTake);
        assert!(
            offending.contains(&2) && offending.contains(&6),
            "{offending:?}"
        );
    }

    #[test]
    fn a_unique_head_on_a_shared_tail_is_refused() {
        // B-246 shape 3: C019's "Let's actually go to the maths. Writing the
        // notes into the" against "Writing the notes, writing those notes into
        // the cache" — word_overlap waves the tail through, the gate does not.
        let w = words(
            "let's actually go to the maths writing the notes into the \
             writing the notes writing those notes into the cache",
        );
        let v = one(&w, group(&[(0, 10), (11, 19)], 1));
        assert_eq!(
            refusal(&v),
            Some((Refusal::ContentAbsentFromKeptTake, vec![1, 5]))
        );
    }

    #[test]
    fn content_present_only_out_of_order_is_refused_past_the_run_limit() {
        // Every content word of the cut is in the keeper, in reverse order.
        let w = words("alpha beta gamma delta delta gamma beta alpha");
        let v = one(&w, group(&[(0, 3), (4, 7)], 1));
        assert_eq!(
            refusal(&v),
            Some((Refusal::UnalignedContentRun, vec![0, 1, 2]))
        );
    }

    #[test]
    fn a_nested_stutter_inside_a_kept_take_is_accepted_in_either_order() {
        // C038's outro, reduced: delivery A "the economics and mechanics"; the
        // keeper B "the economics and mechanics and mechanics" carries a
        // stutter, cut by a group nested inside B.
        let w = words("the economics and mechanics the economics and mechanics and mechanics");
        let outer = group(&[(0, 3), (4, 9)], 1);
        let stutter = group(&[(6, 7), (8, 9)], 1);
        for order in [vec![outer.clone(), stutter.clone()], vec![stutter, outer]] {
            let v = check_and_resolve(&w, &order);
            assert!(v.iter().all(accepted), "{order:?}: {v:?}");
        }
    }

    #[test]
    fn two_nested_groups_cannot_cut_both_copies_of_a_stutter() {
        // Outer: cut 0-1 "red cache", keep 2-5 "red cache red cache". Nested A
        // cuts 2-3 keeping 4-5; nested B would then cut 4-5 — A's keeper.
        let w = words("red cache red cache red cache");
        let v = check_and_resolve(
            &w,
            &[
                group(&[(0, 1), (2, 5)], 1),
                group(&[(2, 3), (4, 5)], 1),
                group(&[(4, 5), (2, 3)], 1),
            ],
        );
        assert!(accepted(&v[0]) && accepted(&v[1]), "{v:?}");
        assert_eq!(
            refusal(&v[2]),
            Some((Refusal::CutsKeptTakeOf { group: 1 }, vec![4, 5]))
        );
        // B alone with the outer group is fine: one copy survives in 2-3.
        let v = check_and_resolve(
            &w,
            &[group(&[(0, 1), (2, 5)], 1), group(&[(4, 5), (2, 3)], 1)],
        );
        assert!(v.iter().all(accepted), "{v:?}");
    }

    #[test]
    fn a_nested_group_that_starves_its_container_is_refused() {
        // Fuzzy matching is not transitive. At a 0.85 bar: A~B (0.9), B~C
        // (0.9), A!~C (0.8). The outer group cuts A and keeps "B C"; a group
        // nested in that keeper cuts B (its own rule: B~C, fine) — and leaves
        // the outer cut's A with nothing it matches.
        let w = words("abcdefghij abcdefghiX abcdefghYX");
        let p = GateParams {
            fuzzy_match: 0.85,
            ..GateParams::default()
        };
        let v = check_and_resolve_with(
            &w,
            &[group(&[(0, 0), (1, 2)], 1), group(&[(1, 1), (2, 2)], 1)],
            &p,
        );
        assert!(accepted(&v[0]), "{v:?}");
        assert_eq!(
            refusal(&v[1]),
            Some((Refusal::StarvesContainer { group: 0 }, vec![0]))
        );
    }

    #[test]
    fn a_take_spanning_runs_resolves_to_one_range_per_run() {
        let w = words_in_runs(&["the cache is warm"; 3]);
        // Cut 2-5 ("is warm" | "the cache") spans run 0 and run 1.
        let v = one(&w, group(&[(2, 5), (8, 11)], 1));
        let GroupVerdict::Accepted { cuts } = v else {
            panic!("{v:?}")
        };
        assert_eq!(
            cuts.iter().map(|c| (c.first, c.last)).collect::<Vec<_>>(),
            vec![(2, 3), (4, 5)]
        );
    }

    #[test]
    fn the_gate_is_deterministic() {
        let w = words(
            "so quick recap so quick recap attention is the model deciding \
             attention is the model deciding how much",
        );
        let gs = vec![
            group(&[(0, 2), (3, 5)], 1),
            group(&[(6, 10), (11, 17)], 1),
            group(&[(0, 5), (6, 17)], 0),
        ];
        let a = check_and_resolve(&w, &gs);
        for _ in 0..5 {
            assert_eq!(check_and_resolve(&w, &gs), a);
        }
    }
}

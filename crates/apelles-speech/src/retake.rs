//! Transcript utterances → near-duplicate "retake" groups (D-318, D-320, D-327).
//!
//! **What this is.** The pure half of retake detection: given what was said and
//! when, find the runs where a speaker restarted the same line — the flubbed
//! take, the stumble, the third attempt at a tongue-twister — and group them so
//! a human (or an agent) can keep one and cut the rest.
//!
//! **What it does NOT do.** It does not decide anything. Every group carries a
//! *recommended* keep index and nothing else; choosing is the caller's, and
//! applying the cut is the timeline's (D-318 keeps both detectors strictly
//! read-only, which is why neither one can ever eat a take you wanted).
//! It also never reads audio — a retake is a fact about *words*, and the
//! acoustic side of this feature is [`crate::vad`]'s job, not this module's.
//!
//! **Why text similarity and not audio similarity.** Two takes of one line are
//! acoustically quite different (different pace, pitch, room tone) and textually
//! near-identical. That makes normalised edit distance over the transcript the
//! signal with the actual separation in it — and `strsim` is a real, maintained
//! implementation of it rather than one we own and debug forever (D-320).
//!
//! ## A take is a SPAN of utterances, not an utterance (D-327, fixes B-198)
//!
//! This is the whole shape of the module and the reason it was rewritten.
//!
//! Whisper segments a recording on its own acoustic/length heuristics. It has no
//! idea a speaker restarted, so **its segment boundaries do not line up with the
//! restart boundaries**. On the owner's own footage a line said three times in a
//! row came back cut like this (142–180 s, timings elided):
//!
//! ```text
//!   #0  "...gets less of that glancing bag than others, the model"
//!   #1  "just under waves it."
//!   #2  "it. If the one part of your message gets ... than the others, the"
//!   #3  "model just waves it. The model just under waves it. If one part..."
//!   #4  "less of that glancing back than the others, the model just under waves it..."
//! ```
//!
//! Every repeat straddles a boundary. Segment #3 alone holds the *tail* of one
//! delivery concatenated with the *start* of the next. Comparing utterance to
//! utterance — which is all this module used to do — no pair of these is a
//! duplicate of any other: measured, the best score among all fifteen pairs was
//! 0.857 (#0 vs #2) and every pair involving #3 or #4 scored 0.18–0.28. The
//! detector found one group of two and missed roughly 22 seconds of duplicated
//! speech sitting in plain sight (B-198).
//!
//! So the unit of comparison here is a **span**: a run of up to
//! [`RetakeParams::max_span_utterances`] adjacent utterances, joined back into
//! one string. Sliding that window puts the repeat boundaries back inside a
//! comparable string even though the utterance boundaries never did — the same
//! pair above scores 0.905 as spans. A [`RetakeGroup`] therefore reports
//! [`TakeSpan`]s, not bare members: "these three utterances were one delivery"
//! is information the caller needs before it can cut anything, and inventing it
//! at the call site would be inventing it wrong.
//!
//! ## Why there is no embedding model here
//!
//! The obvious reading of B-198 is "edit distance is lexical, use meaning
//! instead" — an on-device sentence-embedding model (all-MiniLM-L6-v2 via the
//! same `ort` path as [`crate::vad`]) scoring cosine similarity. That was built
//! and measured before this rewrite, and **rejected on the numbers**: cosine
//! ranked pairs that must NOT be grouped *above* real retakes, because sentence
//! embeddings are famously weak on exactly the distinction that matters here —
//! negation and antonymy. "the model gives that part less weight" against "…
//! *more* weight" scored **0.981**, and "the model weighs every part equally"
//! against "the model does **not** weigh every part equally" scored 0.946, while
//! genuine restarts from the real footage above scored 0.59–0.77. No threshold
//! separates those distributions, and a detector that proposes cutting the
//! sentence that carried the "not" is worse than one that proposes nothing.
//! The full table, and how it was verified against upstream's own reference
//! implementation, is in `docs/notes/retake-detection.md` (D-327).

use serde::{Deserialize, Serialize};

/// One thing the speaker said, as the transcript segments it.
///
/// `index` is the utterance's position in the input list and is carried through
/// to the output so a caller can map a group member back to its own record
/// without matching on text.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Utterance {
    pub index: usize,
    pub start_secs: f64,
    pub end_secs: f64,
    pub text: String,
}

/// One delivery of the line, as a range over a [`RetakeGroup`]'s `members`.
///
/// Both ends are **inclusive**, and a take of one utterance has
/// `first == last` — the historical shape, and still the common one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TakeSpan {
    pub first: usize,
    pub last: usize,
}

impl TakeSpan {
    /// How many members this delivery covers.
    pub fn len(&self) -> usize {
        self.last + 1 - self.first
    }

    /// Never true for a take this module emits; present so `len()` does not
    /// trip clippy's `len_without_is_empty`.
    pub fn is_empty(&self) -> bool {
        false
    }
}

/// A run of utterances that all say substantially the same thing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RetakeGroup {
    /// Every utterance that belongs to some take, in the order they were
    /// spoken. Utterances the detector skipped over — an aside between two
    /// attempts — are deliberately **not** here, because they are not part of
    /// any delivery and must not be swept into a cut.
    pub members: Vec<Utterance>,
    /// Which members form each delivery, in order. Always two or more: one
    /// delivery is not a retake.
    pub takes: Vec<TakeSpan>,
    /// The delivery this module *suggests* keeping, as an index into
    /// [`Self::takes`] — the last one, because that is normally the take the
    /// speaker settled on before moving to the next line. A suggestion, not a
    /// decision: see the module doc.
    ///
    /// Whenever every take is a single utterance — the only shape that existed
    /// before D-327 — this is also its index into [`Self::members`], which is
    /// what that field meant historically.
    pub keep: usize,
    /// The lowest similarity between the group's first take and any other, in
    /// `0.0..=1.0` — how confident the grouping is, so a reviewer can sort the
    /// marginal ones to the top.
    pub similarity: f64,
}

/// Tuning for [`detect_retakes`].
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RetakeParams {
    /// Normalised similarity at or above which two spans are "the same line".
    /// 0.82 keeps real restarts together while holding apart two different
    /// sentences that merely share a subject.
    pub similarity: f64,
    /// How far apart two takes may be and still be retakes of each other.
    /// A line repeated half an hour later is a callback, not a flubbed take.
    pub window_secs: f64,
    /// Spans with fewer than this many **distinct** words are never grouped.
    ///
    /// Distinct, not total, and that is load-bearing now that a span can be
    /// several utterances (D-327): "Yeah." three times in a row is three words
    /// and would clear a total-word bar, which is true and completely useless.
    /// Counting distinct words suppresses filler at any span length while
    /// leaving every real line — "the cat sat on the mat" has five — untouched.
    pub min_words: usize,
    /// How many adjacent utterances may be joined into one span.
    ///
    /// Measured on the live case in the module doc, 2 is already enough to
    /// find all three deliveries and 3 and 4 return exactly the same groups;
    /// the default is 3 so a delivery Whisper happened to cut into three still
    /// fits, at a cost that is linear in this number per position. 1
    /// reproduces the pre-D-327 utterance-to-utterance detector exactly, which
    /// is how that old behaviour stays testable.
    pub max_span_utterances: usize,
}

impl Default for RetakeParams {
    fn default() -> Self {
        Self {
            similarity: 0.82,
            window_secs: 30.0,
            min_words: 3,
            max_span_utterances: 3,
        }
    }
}

/// Lowercase, drop everything that is not a letter, digit or space, and
/// collapse runs of whitespace.
///
/// This is what makes "The cat sat on the mat." and "the cat sat on the mat"
/// compare as identical rather than as 2 edits apart, and it is also what
/// neutralises mlx-whisper's leading-space word tokens and its inconsistent
/// sentence-final punctuation between takes.
pub fn normalise(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut pending_space = false;
    for ch in text.chars() {
        if ch.is_alphanumeric() {
            if pending_space && !out.is_empty() {
                out.push(' ');
            }
            pending_space = false;
            for lower in ch.to_lowercase() {
                out.push(lower);
            }
        } else {
            // Punctuation and whitespace alike collapse to a single separator —
            // an em-dash mid-restart ("the cat sat— the cat sat") must not glue
            // two words into one token.
            pending_space = true;
        }
    }
    out
}

/// Number of distinct words in an already-[`normalise`]d string.
///
/// See [`RetakeParams::min_words`] for why distinct rather than total.
fn distinct_word_count(normalised: &str) -> usize {
    let mut seen: Vec<&str> = normalised.split(' ').filter(|w| !w.is_empty()).collect();
    seen.sort_unstable();
    seen.dedup();
    seen.len()
}

/// Largest token-count ratio between two spans that may still be a retake.
///
/// Containment alone would group a sentence with any paragraph that happens to
/// quote it. A real retake is *the same line again*, so the two sides stay
/// comparable in length even when one carries a false start. 3x is loose enough
/// for "The cat sat— the cat sat on the mat" (9 tokens) against "The cat sat on
/// the mat" (6) and tight enough to reject a clause inside a monologue.
const MAX_CONTAINMENT_LENGTH_RATIO: f64 = 3.0;

/// Best score for the shorter span against any equal-length window of the
/// longer one — "does one of these contain the other, give or take a word".
///
/// Composed from [`strsim::normalized_levenshtein`] rather than reimplementing
/// edit distance (D-320); the only thing added here is the window sweep.
/// Returns 0.0 when either side is empty or the length ratio is implausible.
fn containment(a_words: &[&str], b_words: &[&str]) -> f64 {
    let (short, long) = if a_words.len() <= b_words.len() {
        (a_words, b_words)
    } else {
        (b_words, a_words)
    };
    if short.is_empty() {
        return 0.0;
    }
    if long.len() as f64 > short.len() as f64 * MAX_CONTAINMENT_LENGTH_RATIO {
        return 0.0;
    }

    let needle = short.join(" ");
    let mut best = 0.0_f64;
    for start in 0..=(long.len() - short.len()) {
        let window = long[start..start + short.len()].join(" ");
        best = best.max(strsim::normalized_levenshtein(&needle, &window));
        if best >= 1.0 {
            break;
        }
    }
    best
}

/// How alike two spans are, in `0.0..=1.0`.
///
/// The **larger** of two views of the same pair, because a retake shows up as
/// one or the other but rarely both (D-318):
///
/// - **Whole-string** [`strsim::normalized_levenshtein`] catches the ordinary
///   case — the same line delivered twice, differing by a word or some
///   punctuation.
/// - **[`containment`]** catches the *false start*: "The cat sat— the cat sat
///   on the mat" against "The cat sat on the mat" scores only 0.65 on the whole
///   string, because the stumble makes one side half again as long, but 1.00 on
///   containment. Measured while building this — the whole-string view alone
///   missed the exact case this feature was asked for.
///
/// **The honest false positive.** Containment also fires when a later span
/// genuinely extends an earlier one ("look at the waveform" → "look at the
/// waveform and the vectorscope"). That is a real retake about as often as it
/// is a build-up, and nothing here can tell them apart from text alone — which
/// is the reason this crate only ever proposes (D-318). The length-ratio guard
/// keeps it from reaching past a sentence or so.
pub fn similarity(a: &str, b: &str) -> f64 {
    let whole = strsim::normalized_levenshtein(a, b);
    let a_words: Vec<&str> = a.split(' ').filter(|w| !w.is_empty()).collect();
    let b_words: Vec<&str> = b.split(' ').filter(|w| !w.is_empty()).collect();
    whole.max(containment(&a_words, &b_words))
}

/// Fraction of `part`'s distinct words that also occur in `whole`, in
/// `0.0..=1.0`. An empty `part` scores 0.0.
fn word_overlap(part: &str, whole: &str) -> f64 {
    let haystack: Vec<&str> = whole.split(' ').filter(|w| !w.is_empty()).collect();
    let mut words: Vec<&str> = part.split(' ').filter(|w| !w.is_empty()).collect();
    words.sort_unstable();
    words.dedup();
    if words.is_empty() {
        return 0.0;
    }
    let hits = words.iter().filter(|w| haystack.contains(w)).count();
    hits as f64 / words.len() as f64
}

/// How much of its own vocabulary an utterance must share with the anchor
/// before it may be *joined* to its neighbours to form one take.
///
/// This guard exists because [`containment`] scores a span by its best matching
/// window and ignores whatever else is in it: without this, "The cat sat on the
/// mat" matches the two-utterance span "Sorry, let me start that again." + "The
/// cat sat on the mat" at a perfect 1.00, and the aside gets swept into the
/// take — and therefore into whatever the reviewer cuts. Measured on the real
/// footage in the module doc, every utterance that genuinely belongs to a
/// delivery scores 0.93-1.00 here and an unrelated aside scores 0.00, so the
/// bar sits in the middle of an enormous gap rather than on a knife edge.
///
/// Single-utterance takes are judged by [`similarity`] alone, as they always
/// were: this is about what may be glued together, not about what counts as a
/// match.
const MIN_UTTERANCE_OVERLAP: f64 = 0.5;

/// A candidate delivery: `len` utterances starting at `start`.
#[derive(Debug, Clone, Copy)]
struct Span {
    start: usize,
    len: usize,
}

impl Span {
    /// One past the last utterance.
    fn end(&self) -> usize {
        self.start + self.len
    }
}

/// A whole chain built from one anchor, before it is turned into a group.
struct Chain {
    takes: Vec<Span>,
    worst: f64,
}

impl Chain {
    /// Utterances actually claimed by a delivery — NOT the same as
    /// `last.end() - first.start` when the chain stepped over an aside.
    fn covered(&self) -> usize {
        self.takes.iter().map(|t| t.len).sum()
    }

    /// How many utterances were glued to form the anchor. Lower is better: see
    /// [`better`].
    fn anchor_len(&self) -> usize {
        self.takes[0].len
    }
}

/// Group near-duplicate utterances into retakes.
///
/// Greedy and single-pass over anchors. Each still-ungrouped utterance opens a
/// candidate chain for every anchor length up to
/// [`RetakeParams::max_span_utterances`]; the chain then walks forward, and at
/// each step takes the **earliest** following span that scores at or above
/// `similarity` against the anchor (best span length at that position wins).
///
/// Comparing every take against the *anchor* rather than against the previous
/// take is deliberate and inherited from D-318: chaining off the latest member
/// lets a long run of small drifts walk a group away from what it started as.
///
/// Stepping *over* a non-matching utterance rather than stopping at it is also
/// deliberate — "the cat sat— hang on — the cat sat on the mat" is one retake
/// with an aside in the middle, and the aside is not made a member.
///
/// At each position the chain takes the **shortest** span that clears the bar
/// rather than the best-scoring one, because [`containment`] can only score a
/// longer candidate the same or higher and "best wins" therefore grows every
/// take until it swallows its neighbours.
///
/// Among the candidate chains for one starting utterance, [`better`] picks the
/// winner. Chains of one take are not retakes and are not returned.
///
/// Input is expected in spoken order; the output preserves it.
pub fn detect_retakes(utterances: &[Utterance], p: &RetakeParams) -> Vec<RetakeGroup> {
    let n = utterances.len();
    let normalised: Vec<String> = utterances.iter().map(|u| normalise(&u.text)).collect();
    let max_span = p.max_span_utterances.max(1);

    // `spans[start][len - 1]` is the joined text of that span, or None when it
    // runs off the end. Built once: the chain search revisits the same spans
    // across several anchor lengths, and re-joining them each time is pure
    // waste on a 120-utterance transcript.
    let span_text =
        |start: usize, len: usize| -> String { normalised[start..start + len].join(" ") };
    let mut spans: Vec<Vec<Option<String>>> = Vec::with_capacity(n);
    for start in 0..n {
        let mut row = Vec::with_capacity(max_span);
        for len in 1..=max_span {
            row.push(if start + len <= n {
                let text = span_text(start, len);
                // Eligibility is a property of the span, checked once here so
                // neither the anchor loop nor the chain walk can forget it.
                (distinct_word_count(&text) >= p.min_words).then_some(text)
            } else {
                None
            });
        }
        spans.push(row);
    }

    let mut taken = vec![false; n];
    let mut groups = Vec::new();

    for i in 0..n {
        if taken[i] {
            continue;
        }

        let mut best: Option<Chain> = None;
        for anchor_len in 1..=max_span {
            let Some(anchor) = span_at(&spans, &taken, i, anchor_len) else {
                continue;
            };
            // No overlap guard on the anchor: gluing adjacent utterances into
            // one anchor is the entire point (a sentence Whisper cut in half —
            // "…the model" + "just under waves it" — has zero word overlap
            // between its halves and is still one line). A junk anchor is
            // self-limiting instead, because nothing later will match it and a
            // chain of one take is discarded.
            let chain = extend_chain(
                utterances,
                &normalised,
                &spans,
                &taken,
                anchor,
                i,
                anchor_len,
                p,
            );
            if let Some(chain) = chain
                && better(&chain, best.as_ref())
            {
                best = Some(chain);
            }
        }

        let Some(chain) = best else { continue };

        let mut members = Vec::new();
        let mut takes = Vec::with_capacity(chain.takes.len());
        for span in &chain.takes {
            let first = members.len();
            for k in span.start..span.end() {
                taken[k] = true;
                members.push(utterances[k].clone());
            }
            takes.push(TakeSpan {
                first,
                last: members.len() - 1,
            });
        }

        groups.push(RetakeGroup {
            keep: takes.len() - 1,
            members,
            takes,
            similarity: chain.worst,
        });
    }

    groups
}

/// The joined text of the span at `start`, or `None` if it runs off the end, is
/// ineligible, or overlaps something already claimed by an earlier group.
fn span_at<'a>(
    spans: &'a [Vec<Option<String>>],
    taken: &[bool],
    start: usize,
    len: usize,
) -> Option<&'a str> {
    if taken[start..(start + len).min(taken.len())]
        .iter()
        .any(|t| *t)
        || start + len > taken.len()
    {
        return None;
    }
    spans[start][len - 1].as_deref()
}

/// Walk forward from an anchor, collecting every following span that matches it.
#[allow(clippy::too_many_arguments)]
fn extend_chain(
    utterances: &[Utterance],
    normalised: &[String],
    spans: &[Vec<Option<String>>],
    taken: &[bool],
    anchor: &str,
    start: usize,
    anchor_len: usize,
    p: &RetakeParams,
) -> Option<Chain> {
    let mut takes = vec![Span {
        start,
        len: anchor_len,
    }];
    let mut worst = 1.0_f64;
    let mut cursor = start + anchor_len;
    let mut latest_end = utterances[cursor - 1].end_secs;

    // Each pass finds at most one more take and then restarts from just past
    // it. `next_take` is a separate function rather than a nested loop so that
    // `cursor` is only ever assigned here, between passes — mutating it inside
    // the scan would read as if it moved that scan's own bound, which it does
    // not.
    while let Some((j, len, score)) = next_take(
        utterances, normalised, spans, taken, anchor, cursor, latest_end, p,
    ) {
        takes.push(Span { start: j, len });
        worst = worst.min(score);
        latest_end = utterances[j + len - 1].end_secs;
        cursor = j + len;
    }

    (takes.len() >= 2).then_some(Chain { takes, worst })
}

/// The next delivery at or after `cursor` that matches `anchor`, as
/// `(start, len, score)`.
///
/// The **earliest** position wins, and at that position the **shortest** span
/// that clears the bar wins — not the best-scoring one. `containment` sweeps
/// every window of the longer side, so a longer candidate can only ever score
/// the same or higher; "best score wins" therefore grows every take until it
/// swallows whatever happens to sit next to the line. The minimal span that
/// says the line is the take.
#[allow(clippy::too_many_arguments)]
fn next_take(
    utterances: &[Utterance],
    normalised: &[String],
    spans: &[Vec<Option<String>>],
    taken: &[bool],
    anchor: &str,
    cursor: usize,
    latest_end: f64,
    p: &RetakeParams,
) -> Option<(usize, usize, f64)> {
    let max_span = p.max_span_utterances.max(1);

    for j in cursor..utterances.len() {
        // A take half an hour later is a callback, not a flubbed take — and
        // nothing further along can be nearer, so stop rather than skip.
        if utterances[j].start_secs - latest_end > p.window_secs {
            return None;
        }
        if taken[j] {
            continue;
        }

        for len in 1..=max_span {
            let Some(text) = span_at(spans, taken, j, len) else {
                continue;
            };
            // Only a span being GLUED needs the overlap guard; a lone utterance
            // is judged by `similarity`, as it always was.
            if len > 1
                && (j..j + len)
                    .any(|k| word_overlap(&normalised[k], anchor) < MIN_UTTERANCE_OVERLAP)
            {
                continue;
            }
            let score = similarity(anchor, text);
            if score >= p.similarity {
                return Some((j, len, score));
            }
        }
    }
    None
}

/// Is `candidate` a better chain than the best so far?
///
/// In order: **most takes** (each one independently cleared the bar, so more of
/// them means more real deliveries found), then the **shortest anchor**, then
/// most utterances covered, then the strongest weakest-pair.
///
/// The anchor length ranks above coverage on purpose, and that ordering is a
/// bug fix rather than a preference. `covered()` counts the anchor's own
/// utterances, so a longer anchor inflates it mechanically: measured while
/// building this, "The cat sat on the mat" / "Sorry, let me start that again."
/// / "The cat sat on the mat" was won by the two-utterance anchor — which glued
/// the aside onto the line and offered it up to be cut — purely because gluing
/// it scored one more "covered" utterance than the correct answer. Preferring
/// the least speculative anchor that explains the same number of deliveries is
/// also just the right default for a detector that only ever proposes (D-318).
fn better(candidate: &Chain, best: Option<&Chain>) -> bool {
    let Some(best) = best else { return true };
    let key = |c: &Chain| {
        (
            c.takes.len(),
            std::cmp::Reverse(c.anchor_len()),
            c.covered(),
            c.worst,
        )
    };
    key(candidate) > key(best)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utt(index: usize, start: f64, end: f64, text: &str) -> Utterance {
        Utterance {
            index,
            start_secs: start,
            end_secs: end,
            text: text.to_string(),
        }
    }

    /// Member indices of every group, for terse assertions.
    fn indices(groups: &[RetakeGroup]) -> Vec<Vec<usize>> {
        groups
            .iter()
            .map(|g| g.members.iter().map(|m| m.index).collect())
            .collect()
    }

    #[test]
    fn normalise_strips_case_and_punctuation() {
        assert_eq!(
            normalise("The Cat sat on the mat."),
            "the cat sat on the mat"
        );
        assert_eq!(normalise("  hello,   world!  "), "hello world");
        assert_eq!(normalise(""), "");
    }

    /// The em-dash of a restart must separate words, not fuse them — otherwise
    /// "sat— the" becomes one token and the similarity score is wrong.
    #[test]
    fn normalise_treats_a_restart_dash_as_a_separator() {
        assert_eq!(
            normalise("the cat sat— the cat sat on the mat"),
            "the cat sat the cat sat on the mat"
        );
    }

    #[test]
    fn identical_text_scores_one() {
        assert!(
            (similarity("the cat sat on the mat", "the cat sat on the mat") - 1.0).abs() < 1e-12
        );
    }

    /// The measured case that forced [`containment`] to exist: on the whole
    /// string alone this pair scores ~0.65 and would be missed entirely.
    #[test]
    fn a_false_start_scores_high_only_because_of_containment() {
        let stumble = normalise("The cat sat— the cat sat on the mat.");
        let clean = normalise("The cat sat on the mat.");

        let whole = strsim::normalized_levenshtein(&stumble, &clean);
        assert!(
            whole < 0.7,
            "whole-string similarity is genuinely low here: {whole}"
        );
        assert!(
            similarity(&stumble, &clean) > 0.99,
            "containment should recognise the clean take inside the stumble"
        );
    }

    /// A short false start that is its own utterance, followed by the real
    /// take — the other shape a stumble arrives in.
    #[test]
    fn a_clipped_false_start_matches_the_full_line() {
        let s = similarity(
            &normalise("The cat sat—"),
            &normalise("The cat sat on the mat."),
        );
        assert!(s >= RetakeParams::default().similarity, "got {s}");
    }

    /// The length guard: a sentence quoted inside a much longer passage is not
    /// a retake of it, however perfectly it is contained.
    #[test]
    fn containment_does_not_reach_across_a_length_gap() {
        let short = normalise("the cat sat on the mat");
        let long = normalise(
            "the cat sat on the mat and then it got up and wandered over to the window \
             where it stayed for the rest of the afternoon watching the birds outside",
        );
        let s = similarity(&short, &long);
        assert!(
            s < RetakeParams::default().similarity,
            "should not group, got {s}"
        );
    }

    #[test]
    fn unrelated_text_scores_low() {
        let s = similarity(
            "the cat sat on the mat",
            "quarterly revenue grew by twelve percent",
        );
        assert!(
            s < 0.5,
            "unrelated lines should not look like retakes, got {s}"
        );
    }

    /// The headline case from the brief: the same line delivered twice.
    #[test]
    fn two_takes_of_one_line_group_together() {
        let u = vec![
            utt(0, 0.0, 2.0, "The cat sat on the mat."),
            utt(1, 3.0, 5.0, "The cat sat on the mat."),
        ];
        let g = detect_retakes(&u, &RetakeParams::default());
        assert_eq!(g.len(), 1, "{g:?}");
        assert_eq!(g[0].members.len(), 2);
        assert_eq!(g[0].takes.len(), 2);
        assert_eq!(g[0].keep, 1, "the LAST take is the recommended keep");
        assert_eq!(g[0].members[g[0].takes[g[0].keep].first].index, 1);
    }

    /// A stumble-then-restart is not textually identical, and must still group.
    #[test]
    fn a_stumble_then_restart_groups() {
        let u = vec![
            utt(0, 0.0, 1.4, "The cat sat— the cat sat on the mat."),
            utt(1, 2.0, 4.0, "The cat sat on the mat."),
        ];
        let g = detect_retakes(&u, &RetakeParams::default());
        assert_eq!(
            g.len(),
            1,
            "a stumble and its clean retake should group: {g:?}"
        );
        assert_eq!(g[0].keep, 1);
    }

    /// Three attempts at one line are ONE group of three, not two pairs.
    #[test]
    fn three_takes_form_one_group_of_three() {
        let u = vec![
            utt(0, 0.0, 2.0, "Apelles is a local first video tool."),
            utt(1, 3.0, 5.0, "Apelles is a local-first video tool!"),
            utt(2, 6.0, 8.0, "Apelles is a local first video tool"),
        ];
        let g = detect_retakes(&u, &RetakeParams::default());
        assert_eq!(g.len(), 1, "{g:?}");
        assert_eq!(g[0].members.len(), 3);
        assert_eq!(g[0].takes.len(), 3);
        assert_eq!(g[0].keep, 2);
        assert_eq!(g[0].members[2].index, 2);
    }

    /// Different sentences must never be grouped, however close together.
    #[test]
    fn distinct_lines_are_not_a_retake() {
        let u = vec![
            utt(0, 0.0, 2.0, "Today we are going to talk about colour."),
            utt(1, 2.1, 4.0, "First, let us look at the waveform."),
        ];
        assert!(detect_retakes(&u, &RetakeParams::default()).is_empty());
    }

    /// The measurement that killed the embedding idea (D-327), pinned as a
    /// test so it cannot quietly stop being true.
    ///
    /// A sentence and its own negation are the pair a retake detector most
    /// needs to rank *below* a real retake: proposing a cut that removes the
    /// clause carrying the "not" inverts what the video says. Edit distance
    /// ranks it correctly — 0.843, under every real span-level retake from the
    /// live footage. Cosine similarity from all-MiniLM-L6-v2 ranks it
    /// **0.946**, far *above* those same real retakes (0.59-0.77), which is why
    /// no threshold on that signal is safe and why it is not in this crate.
    /// Full table and method: `docs/notes/retake-detection.md`.
    #[test]
    fn a_negation_ranks_below_a_real_retake_on_edit_distance() {
        let negation = similarity(
            &normalise("The model weighs every part of your message equally."),
            &normalise("The model does not weigh every part of your message equally."),
        );

        let n: Vec<String> = REAL_TRIPLE_REPEAT
            .utterances()
            .iter()
            .map(|u| normalise(&u.text))
            .collect();
        let real_retake = similarity(&n[0..2].join(" "), &n[2..5].join(" "));

        assert!(
            negation < real_retake,
            "a negation ({negation:.3}) must rank below a genuine retake \
             ({real_retake:.3}) — the ordering an embedding gets backwards"
        );
    }

    /// Same subject, different sentence — the other topical false positive an
    /// embedding scores 0.76 and edit distance correctly scores low.
    #[test]
    fn two_sentences_about_one_concept_are_not_a_retake() {
        let u = vec![
            utt(
                0,
                0.0,
                4.0,
                "Attention is how a transformer decides what matters in a sentence.",
            ),
            utt(
                1,
                4.5,
                9.0,
                "Attention is the mechanism that makes transformers work so well on language.",
            ),
        ];
        assert!(
            detect_retakes(&u, &RetakeParams::default()).is_empty(),
            "topical overlap is not repetition"
        );
    }

    /// The same line an hour apart is a callback, not a flubbed take.
    #[test]
    fn the_time_window_is_honoured() {
        let u = vec![
            utt(0, 0.0, 2.0, "The cat sat on the mat."),
            utt(1, 3600.0, 3602.0, "The cat sat on the mat."),
        ];
        assert!(detect_retakes(&u, &RetakeParams::default()).is_empty());
    }

    /// Short filler repeats identically all day long and is not a retake.
    #[test]
    fn short_filler_is_not_grouped() {
        let u = vec![
            utt(0, 0.0, 0.4, "Yeah."),
            utt(1, 1.0, 1.4, "Yeah."),
            utt(2, 2.0, 2.4, "Okay."),
        ];
        assert!(
            detect_retakes(&u, &RetakeParams::default()).is_empty(),
            "min_words must suppress filler"
        );
    }

    /// The span window must not smuggle filler past `min_words` by joining
    /// several one-word utterances into a three-word span (D-327) — which is
    /// exactly why that bar counts DISTINCT words.
    #[test]
    fn a_span_of_filler_is_still_filler() {
        let u: Vec<Utterance> = (0..8)
            .map(|i| utt(i, i as f64, i as f64 + 0.4, "Yeah."))
            .collect();
        assert!(
            detect_retakes(&u, &RetakeParams::default()).is_empty(),
            "joining filler into spans must not clear min_words"
        );
    }

    /// …but the caller can opt into it, so the knob is real.
    #[test]
    fn lowering_min_words_lets_filler_group() {
        let u = vec![utt(0, 0.0, 0.4, "Yeah."), utt(1, 1.0, 1.4, "Yeah.")];
        let p = RetakeParams {
            min_words: 1,
            ..RetakeParams::default()
        };
        assert_eq!(detect_retakes(&u, &p).len(), 1);
    }

    #[test]
    fn empty_input_yields_no_groups() {
        assert!(detect_retakes(&[], &RetakeParams::default()).is_empty());
    }

    /// Two separate retake groups in one recording stay separate.
    #[test]
    fn two_independent_retakes_are_two_groups() {
        let u = vec![
            utt(0, 0.0, 2.0, "The cat sat on the mat."),
            utt(1, 2.5, 4.5, "The cat sat on the mat."),
            utt(2, 5.0, 7.0, "Welcome to the show everybody."),
            utt(3, 7.5, 9.5, "Welcome to the show, everybody!"),
        ];
        let g = detect_retakes(&u, &RetakeParams::default());
        assert_eq!(g.len(), 2, "{g:?}");
        assert_eq!(indices(&g), vec![vec![0, 1], vec![2, 3]]);
    }

    /// An aside between two attempts is stepped over, not swallowed: it is not
    /// part of either delivery and must not end up in a cut.
    #[test]
    fn an_aside_between_takes_is_not_made_a_member() {
        let u = vec![
            utt(0, 0.0, 2.0, "The cat sat on the mat."),
            utt(1, 2.2, 3.4, "Sorry, let me start that again."),
            utt(2, 3.6, 5.6, "The cat sat on the mat."),
        ];
        let g = detect_retakes(&u, &RetakeParams::default());
        assert_eq!(g.len(), 1, "{g:?}");
        assert_eq!(indices(&g), vec![vec![0, 2]]);
        assert_eq!(g[0].takes.len(), 2);
    }

    /// The reported similarity is the WORST pair in the group, so a reviewer
    /// can sort the shakiest groupings to the top. The third take here swaps a
    /// word rather than extending the line — a substitution is the case that is
    /// genuinely imperfect, since an extension scores 1.0 by containment.
    #[test]
    fn similarity_reports_the_weakest_match_in_the_group() {
        let u = vec![
            utt(0, 0.0, 2.0, "The cat sat on the mat."),
            utt(1, 2.5, 4.5, "The cat sat on the mat."),
            utt(2, 5.0, 7.0, "The cat sat on the rug."),
        ];
        let g = detect_retakes(&u, &RetakeParams::default());
        assert_eq!(g.len(), 1, "{g:?}");
        assert_eq!(g[0].members.len(), 3);
        assert!(
            g[0].similarity < 1.0,
            "a substituted word makes the group imperfect, got {}",
            g[0].similarity
        );
        assert!(g[0].similarity >= RetakeParams::default().similarity);
    }

    /// Every take must be a contiguous, non-overlapping range of members, in
    /// order — the panel and the MCP op both slice `members` with these.
    #[test]
    fn takes_tile_the_members_in_order() {
        let u = vec![
            utt(0, 0.0, 2.0, "The cat sat on the mat."),
            utt(1, 2.5, 4.5, "The cat sat on the mat."),
            utt(2, 5.0, 7.0, "The cat sat on the mat."),
        ];
        for g in detect_retakes(&u, &RetakeParams::default()) {
            let mut next = 0;
            for t in &g.takes {
                assert_eq!(t.first, next, "takes must tile without gaps: {g:?}");
                assert!(t.last >= t.first);
                next = t.last + 1;
            }
            assert_eq!(next, g.members.len(), "takes must cover every member");
            assert!(g.keep < g.takes.len());
        }
    }

    /// `max_span_utterances: 1` is the pre-D-327 detector, kept as a knob so
    /// the behaviour change is opt-out-able and testable.
    #[test]
    fn a_max_span_of_one_is_the_old_utterance_to_utterance_detector() {
        let p = RetakeParams {
            max_span_utterances: 1,
            ..RetakeParams::default()
        };
        let g = detect_retakes(&REAL_TRIPLE_REPEAT.utterances(), &p);
        assert_eq!(
            indices(&g),
            vec![vec![0, 2]],
            "the old detector found exactly one pair and missed the rest"
        );
    }

    /// ---------------------------------------------------------------------
    /// B-198: the real, live-reported miss (D-327).
    /// ---------------------------------------------------------------------
    ///
    /// Verbatim transcript segments 142–180 s of the owner's own footage
    /// (`A001_09122356_C040.MOV`), via `editor_get_transcript`. The speaker
    /// stumbles and restarts one line three times; Whisper cuts the repeats on
    /// boundaries of its own that do not line up with the restarts, so segment
    /// #3 holds the tail of one delivery and the head of the next.
    ///
    /// **This is the regression test for this whole pass.** Against the
    /// pre-D-327 utterance-to-utterance detector it finds one group of two
    /// (indices 0 and 2) and misses ~22 s of duplicated speech — see
    /// `a_max_span_of_one_is_the_old_utterance_to_utterance_detector`, which
    /// pins that old behaviour so the two can be read side by side.
    struct RealTranscript(&'static [(f64, f64, &'static str)]);

    impl RealTranscript {
        fn utterances(&self) -> Vec<Utterance> {
            self.0
                .iter()
                .enumerate()
                .map(|(i, (s, e, t))| utt(i, *s, *e, t))
                .collect()
        }
    }

    const REAL_TRIPLE_REPEAT: RealTranscript = RealTranscript(&[
        (
            142.38,
            148.06,
            "If the one part of your message gets less of that glancing bag than others, the model",
        ),
        (148.06, 149.94, "just under waves it."),
        (
            149.94,
            157.48,
            "it. If the one part of your message gets less of that glancing back than the others, the",
        ),
        (
            157.48,
            169.12,
            "model just waves it. The model just under waves it. If one part of your message gets",
        ),
        (
            169.12,
            179.92,
            "less of that glancing back than the others, the model just under waves it. If the one",
        ),
        (
            179.92,
            194.72,
            "it. The specific version of this used inside these models is called self-attention and",
        ),
    ]);

    #[test]
    fn the_real_triple_repeat_is_found() {
        let u = REAL_TRIPLE_REPEAT.utterances();
        let g = detect_retakes(&u, &RetakeParams::default());

        assert_eq!(g.len(), 1, "expected one run of restarts, got {g:?}");
        let group = &g[0];

        // The speaker delivered the line three times. The old detector found
        // two members in one pair; this must find three deliveries.
        assert_eq!(
            group.takes.len(),
            3,
            "the speaker delivered this line three times, got {:?}",
            group.takes
        );

        assert_eq!(
            group.members.iter().map(|m| m.index).collect::<Vec<_>>(),
            vec![0, 2, 3, 4],
            "the run is #0 through #4; #1 is a fragment no delivery claims \
             (see below) and #5 has moved on to self-attention"
        );

        // The headline number: the old detector's group stopped at 157.48 s and
        // left everything after it uncut. This one reaches the end of the run.
        let covered_to = group.members[group.takes[2].last].end_secs;
        assert!(
            (covered_to - 179.92).abs() < 1e-9,
            "the group must reach the end of the restart run, got {covered_to}"
        );

        // The recommended keeper is the last delivery.
        assert_eq!(group.keep, 2);
        assert_eq!(group.members[group.takes[group.keep].last].index, 4);

        assert!(
            group.similarity >= RetakeParams::default().similarity,
            "every take cleared the bar, so the reported worst must too: {}",
            group.similarity
        );
    }

    /// The honest limit of utterance granularity, pinned so nobody reads the
    /// test above as claiming more than it does (D-327).
    ///
    /// Segment #1 ("just under waves it.") really is the tail of delivery one,
    /// but delivery two *begins inside* segment #2 and delivery three begins
    /// *inside* segment #3 — the restart boundaries fall mid-utterance, and a
    /// take expressed as a range of whole utterances cannot put #1 in one
    /// delivery without also claiming material that belongs to the next. The
    /// detector leaves it out rather than over-claiming, which under-cuts
    /// instead of over-cutting: the safe direction for something that only
    /// proposes (D-318). Word-accurate take boundaries would need per-word
    /// timings plumbed through the bridge — `docs/04-roadmap.md`.
    #[test]
    fn a_take_boundary_falling_mid_utterance_is_left_out_not_over_claimed() {
        let u = REAL_TRIPLE_REPEAT.utterances();
        let g = detect_retakes(&u, &RetakeParams::default());
        let claimed: Vec<usize> = g[0].members.iter().map(|m| m.index).collect();

        assert!(
            !claimed.contains(&1),
            "#1 straddles two deliveries and must not be claimed by either"
        );
        assert!(
            !claimed.contains(&5),
            "#5 is the next sentence and must never be proposed for a cut"
        );
    }

    /// The span window is what finds it: the pair that carries the run scores
    /// 0.18–0.28 as bare utterances and clears the bar only when adjacent
    /// utterances are joined first. Measured, not asserted in the abstract.
    #[test]
    fn the_triple_repeat_is_invisible_to_utterance_to_utterance_comparison() {
        let u = REAL_TRIPLE_REPEAT.utterances();
        let n: Vec<String> = u.iter().map(|x| normalise(&x.text)).collect();
        let p = RetakeParams::default();

        // Nothing involving #3 or #4 — the two segments carrying repeats two
        // and three — comes anywhere near the threshold on its own.
        for i in 0..n.len() {
            for j in (i + 1)..n.len() {
                if i == 3 || i == 4 || j == 3 || j == 4 {
                    let s = similarity(&n[i], &n[j]);
                    assert!(
                        s < 0.5,
                        "({i},{j}) scores {s} as bare utterances — the premise of \
                         this test is that it does not"
                    );
                }
            }
        }

        // Joined into spans, the same material clears the bar comfortably.
        let first = n[0..2].join(" ");
        let second = n[2..5].join(" ");
        let s = similarity(&first, &second);
        assert!(
            s >= p.similarity,
            "spans #0..#1 vs #2..#4 should match, got {s}"
        );
    }
}

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
//!
//! ## The SECOND signal: a repeated phrase, not a repeated line (D-365)
//!
//! Everything above asks one question — *is this the same line again?* There is
//! a second, equally common disfluency that question cannot reach: the speaker
//! repairs **one phrase** inside two otherwise-different sentences. Measured on
//! the owner's own footage, "and the third one called speculative speculating
//! and the third one's called speculating speculative" against "speculative
//! decoding okay and the third one call is speculative decoding and it's kind of
//! clever" scores whole-string **0.303** / containment **0.495** against the
//! 0.82 bar, because the two sentences genuinely diverge outside the repeat.
//!
//! So [`crate::phrase`] adds a second, independent predicate — *do these two
//! share a repeated, content-bearing phrase?* — and [`next_take`] accepts a
//! candidate that clears **either** bar. It is an OR, not a replacement:
//! `similarity`'s contract and default are untouched, and
//! [`RetakeParams::phrase_min_words`] turns the new arm off entirely.
//!
//! **Why an OR inside the existing chain rather than a separate second pass.**
//! Measured on the same transcript, utterances #41/#42/#44 are one restart in
//! which the first link ("Inference is everything that it's…" → "Inference is
//! everything after that.") scores 0.794 and only the phrase signal sees it,
//! while the second link scores 1.000 and only the similarity signal is needed.
//! A two-pass design groups #42 and #44 in pass one, marks them taken, and can
//! never then reach back for #41 — it loses the false start that is the whole
//! reason to cut. Interleaving the two predicates in one walk is what makes a
//! mixed chain like that expressible.
//!
//! A group found through the phrase arm reports a genuinely low
//! [`RetakeGroup::similarity`], and that is correct rather than a wart: that
//! field exists so a reviewer can sort the marginal groupings to the top, and
//! these are exactly the ones a human should look at first.
//!
//! ## A glued take may not carry material that repeats nothing (D-366, B-238)
//!
//! Everything above is about **detection** — which utterances belong together.
//! This is about the claim that follows from it: a group discards each non-kept
//! take *whole*, so every utterance inside one is being proposed for deletion.
//!
//! Gluing (D-327) and the phrase arm (D-365) both match a span on *part* of
//! itself — [`containment`] sweeps for its best window, and
//! [`crate::phrase::is_phrase_repeat`] needs one shared run anywhere. So a span
//! can match on one of its utterances while the rest contribute nothing, and
//! before D-366 those passengers went into the proposed cut with it. Measured on
//! the owner's own footage: 17 of 22 real groups had a glued anchor, 16 of the 17
//! were carrying unique content, and across two real transcripts the detector
//! proposed deleting **259.8 seconds of speech that repeated nothing** — one
//! video's opening hook included — with every test green.
//!
//! [`anchor_is_justified`] closes it by applying [`MIN_UTTERANCE_OVERLAP`] to the
//! anchor, the side D-327 had deliberately exempted on the since-disproved
//! theory that a junk anchor is self-limiting. **The two claims a change here has
//! to check are separate: "is this group real?" and "is the range it offers to
//! delete right?"** Only the first was ever measured, twice, and both times the
//! second was wrong. `docs/notes/retake-detection.md` §6.
//!
//! ## A group cuts only what its keeper holds (D-386, B-246)
//!
//! D-366's guard still left three ways to cut speech the keeper does not say: a
//! single-utterance take matched on its tail, a keeper that is a fragment of
//! the line, and unique words a 0.5 overlap fraction forgave. So once a chain
//! is complete, `keep_only_covered_takes` keeps a non-kept take only if the
//! coverage gate's own content rule ([`crate::proposal`]) finds its every
//! content word in the keeper, and drops a group left with one take. **The
//! contract is now: every group this module emits is one the gate would not
//! refuse on content.** It costs recall where the ASR mis-heard a word in one
//! take; it cannot hear. `docs/notes/retake-detection.md` §14.

use serde::{Deserialize, Serialize};

use crate::phrase::{PhraseParams, is_phrase_repeat};

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
    /// Shortest **repeated phrase**, in words, that marks two spans as one
    /// self-correction even when [`Self::similarity`] says they are different
    /// sentences (D-365) — the second, independent signal described in the
    /// module doc. **0 turns that signal off**, giving exactly the pre-D-365
    /// detector.
    ///
    /// This is a separate knob from `similarity` on purpose: `similarity`'s
    /// 0.82 still means precisely what it always meant, so nothing relying on
    /// that number changed behaviour underneath it. The tradeoff this one buys
    /// is stated plainly in D-365 — it catches a class of real retakes the
    /// line-level signal cannot see, at the cost of a different, measured
    /// false-positive risk. Default 3; see [`crate::phrase`] for the rule and
    /// `docs/notes/retake-detection.md` §5 for the measurement behind it.
    pub phrase_min_words: usize,
}

impl RetakeParams {
    /// The phrase signal's own tuning, as [`crate::phrase`] wants it.
    fn phrase(&self) -> PhraseParams {
        PhraseParams {
            min_words: self.phrase_min_words,
        }
    }
}

impl Default for RetakeParams {
    fn default() -> Self {
        Self {
            similarity: 0.82,
            window_secs: 30.0,
            min_words: 3,
            max_span_utterances: 3,
            phrase_min_words: PhraseParams::DEFAULT_MIN_WORDS,
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
///
/// `pub` for the same reason [`normalise`] and [`similarity`] are: it is the
/// scale D-366's "does this repeat anything?" question is asked on, and the
/// integration tests read the *finished* detector output back against it
/// ([`MIN_UTTERANCE_OVERLAP`] is the bar) rather than re-deriving a second
/// overlap measure of their own. D-377 widened that audit to every raw source
/// in the corpus, which put it in an integration test and therefore outside
/// this module's private scope.
pub fn word_overlap(part: &str, whole: &str) -> f64 {
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

/// How much of its own vocabulary an utterance must share with the rest of the
/// group before it may be *joined* to its neighbours to form one take.
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
/// **The same bar guards both sides of a comparison** (B-238 / D-366): a
/// candidate span is checked against the anchor in [`next_take`], and the
/// anchor is checked against the deliveries that matched it in
/// [`anchor_is_justified`]. It is deliberately one constant and not two,
/// because it is one question asked twice — *does this utterance's own
/// vocabulary show up in the line this take is supposed to be a delivery of?* —
/// on one scale, and a second nearly-identical bar for it would be an arbitrary
/// choice with nothing to measure it against. Re-measured for the anchor side
/// over both real transcripts: genuinely redundant anchor members score
/// 0.600-1.000 and non-redundant ones 0.000-0.500
/// (`docs/notes/retake-detection.md` §6).
///
/// Single-utterance takes are not judged by this bar: it is about what may be
/// glued together, not about what counts as a match. What a *finished* group may
/// cut — single utterances included — is a stricter question, answered by the
/// coverage gate's content rule against the keeper (`keep_only_covered_takes`,
/// D-386).
pub const MIN_UTTERANCE_OVERLAP: f64 = 0.5;

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
            // The anchor's own overlap guard cannot run here — it is a
            // question about the deliveries that end up matching this anchor,
            // and none are known yet. `extend_chain` applies it once the chain
            // exists; see `anchor_is_justified` (B-238 / D-366).
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
    let mut cursor = start + anchor_len;
    let mut latest_end = utterances[cursor - 1].end_secs;

    // Each pass finds at most one more take and then restarts from just past
    // it. `next_take` is a separate function rather than a nested loop so that
    // `cursor` is only ever assigned here, between passes — mutating it inside
    // the scan would read as if it moved that scan's own bound, which it does
    // not.
    while let Some((j, len)) = next_take(
        utterances, normalised, spans, taken, anchor, cursor, latest_end, p,
    ) {
        takes.push(Span { start: j, len });
        latest_end = utterances[j + len - 1].end_secs;
        cursor = j + len;
    }

    if takes.len() < 2 {
        return None;
    }
    // `worst` is settled by `keep_only_covered_takes`, once the takes that
    // survive it are known.
    let chain = Chain { takes, worst: 1.0 };
    // The anchor's half of the overlap guard, which can only be asked now that
    // the deliveries are known (B-238 / D-366).
    if !anchor_is_justified(&chain, normalised, p) {
        return None;
    }
    keep_only_covered_takes(chain, normalised)
}

/// Drop every non-kept take whose content the keeper does not hold (B-246,
/// D-386). `None` when fewer than two takes are left.
///
/// **Why this exists.** A group discards each non-kept take *whole*, so the
/// claim it makes is "everything in these takes is said again in the keeper".
/// Nothing before this asked that question of the finished group:
/// [`similarity`]'s [`containment`] arm admits a long single utterance on a
/// matching *tail* (B-246's six, all single-utterance takes D-366's guard
/// exempted), the anchor and the candidates are matched against the *anchor*
/// and not against the take that survives (the "straddled" class, where a
/// group keeps a fragment and cuts every complete delivery), and
/// [`word_overlap`] at 0.5 forgives half an utterance's vocabulary by
/// construction. Measured on `eval/retake/`, those three shapes were the whole
/// of the detector's over-cut: 3.20-24.40 s per task.
///
/// **The test is the coverage gate's own content rule**
/// ([`crate::proposal::text_is_covered`]), the same function `proposal.rs`
/// judges every proposal with — not a second, looser bar here. With it, a group
/// this module emits is one the gate does not refuse on content; measured, the
/// over-cut is 0.00 s on every eval task (`docs/notes/retake-detection.md`
/// §14). Applying [`MIN_UTTERANCE_OVERLAP`] to single-utterance takes instead
/// (B-246's first proposed fix) clears the Parakeet tasks except 1.44 s of
/// C019 and leaves every Whisper task over-cutting 3-24 s: it reads a
/// fraction, and a fraction is what forgives the unique head.
///
/// **Drop the take, don't reject the chain.** The keeper is only known once the
/// chain is complete, and a take it does not cover is evidence about *that
/// take*, not about the others, which each cleared the same rule. Dropped
/// utterances stay unclaimed, so a later anchor can still use them. Measured
/// against rejecting the whole chain: identical on every task but C040's two
/// (retake recall 0.259 → 0.296 Parakeet, 0.249 → 0.365 Whisper re-derived),
/// over-cut 0.00 s either way.
fn keep_only_covered_takes(chain: Chain, normalised: &[String]) -> Option<Chain> {
    let text = |t: &Span| normalised[t.start..t.end()].join(" ");
    let (&keeper, rest) = chain.takes.split_last()?;
    let kept = text(&keeper);
    let mut takes: Vec<Span> = rest
        .iter()
        .copied()
        .filter(|t| crate::proposal::text_is_covered(&text(t), &kept))
        .collect();
    if takes.is_empty() {
        return None;
    }
    takes.push(keeper);
    // The group's reported confidence is over the takes it actually carries:
    // the lowest similarity of its first take to any other.
    let first = text(&takes[0]);
    let worst = takes[1..]
        .iter()
        .map(|t| similarity(&first, &text(t)))
        .fold(1.0_f64, f64::min);
    Some(Chain { takes, worst })
}

/// Is every utterance glued into this chain's anchor actually justified by the
/// deliveries that matched it — or did it ride along on a neighbour's repeat?
///
/// **Why this exists (B-238 / D-366).** The anchor is built speculatively:
/// [`detect_retakes`] glues up to [`RetakeParams::max_span_utterances`] adjacent
/// utterances together *before* it knows what will match, because that gluing is
/// what puts a restart boundary back inside a comparable string (D-327). But
/// [`similarity`]'s [`containment`] arm scores a span by its best matching
/// window and ignores everything else in it, and the phrase arm matches on a
/// single shared run — so a glued anchor can match on one of its utterances
/// while the others contribute nothing. D-327 exempted the anchor from
/// [`MIN_UTTERANCE_OVERLAP`] on the theory that a junk anchor is self-limiting
/// because nothing would match it. **That was wrong**, and wrong in the
/// dangerous direction: the group discards every non-kept take whole, so the
/// unrelated material glued in front of a genuine repeat was being proposed for
/// deletion along with it. On the owner's own footage that silently offered up
/// the video's opening hook and a 21-second setup line — see
/// `docs/notes/retake-detection.md` §6 and `docs/BUGS.md` B-238.
///
/// **The reference is the union of the other takes, not each one separately.**
/// Measured: Whisper distributes a repeated line across its own boundaries, so a
/// tail fragment of delivery one ("just under waves it.") is absent from the
/// *first* matching delivery and present in the third. Checking each take
/// separately would reject that genuine glue; the union accepts it at 1.000
/// while still scoring the D-366 cases 0.000-0.500.
///
/// An unjustified chain is **rejected, not repaired**. Trimming the anchor in
/// place would commit a chain from a start position the anchor loop has not
/// reached yet and would therefore skip [`better`]'s comparison of the anchor
/// lengths available there. Dropping it instead lets the outer loop arrive at the
/// justified utterance on its own and explore it properly — measured on both
/// real transcripts, every genuine group is still found that way, with its
/// anchor now starting at the utterance that actually repeats.
///
/// **A member too short to judge is not justified either.** An overlap
/// *fraction* over two distinct words can only be 0, 0.5 or 1, and 0.5 means one
/// incidental word in common — measured, that is exactly how C038's "one
/// response" (0.96 s, the tail of the previous sentence) landed on the bar and
/// rode into a cut. So a member also has to carry
/// [`RetakeParams::min_words`] distinct words before its fraction is believed at
/// all, which is the same bar and the same reasoning the module already applies
/// to a whole span. Every sub-bar utterance in both real transcripts is a
/// Whisper sentence-tail fragment ("about.", "place.", "change", "the middle.")
/// that no delivery should claim; the shortest genuinely-repeated one, "So quick
/// recap," has exactly three. Where this costs something it costs a fragment
/// left out of a take that keeps it — under-cutting, the safe direction
/// (D-318, and D-327's own honest-limit note).
fn anchor_is_justified(chain: &Chain, normalised: &[String], p: &RetakeParams) -> bool {
    let anchor = chain.takes[0];
    // Nothing was glued, so there is nothing to justify — the same carve-out
    // the candidate side makes in `next_take`.
    if anchor.len == 1 {
        return true;
    }
    let rest = chain.takes[1..]
        .iter()
        .flat_map(|t| normalised[t.start..t.end()].iter().map(String::as_str))
        .collect::<Vec<_>>()
        .join(" ");
    (anchor.start..anchor.end()).all(|k| {
        distinct_word_count(&normalised[k]) >= p.min_words
            && word_overlap(&normalised[k], &rest) >= MIN_UTTERANCE_OVERLAP
    })
}

/// The next delivery at or after `cursor` that matches `anchor`, as
/// `(start, len)`.
///
/// The **earliest** position wins, and at that position the **shortest** span
/// that clears the bar wins — not the best-scoring one. `containment` sweeps
/// every window of the longer side, so a longer candidate can only ever score
/// the same or higher; "best score wins" therefore grows every take until it
/// swallows whatever happens to sit next to the line. The minimal span that
/// says the line is the take.
///
/// **The similarity arm is tried at every span length before the phrase arm is
/// tried at any** (D-365), and that ordering is load-bearing rather than a
/// preference. "Shortest span wins" assumes every candidate length is judged by
/// the same yardstick; the phrase arm is the looser of the two, so mixing them
/// into one length sweep lets a *shorter* span squeak through on the loose
/// signal and pre-empt the longer span that the strict signal would have
/// matched. Measured on the D-327 fixture, that regressed the third delivery
/// from one take of `#3..#4` into two takes of `#3` and `#4` — and since the
/// recommended keep is the LAST take, that quietly offered the first half of a
/// delivery up to be cut. Trying similarity at all lengths first keeps the
/// phrase arm strictly *additive*: wherever the old detector matched something,
/// it still matches exactly that, and the new arm only speaks where the old one
/// was silent. Pinned by
/// `the_phrase_signal_does_not_re_cut_a_take_the_similarity_signal_already_found`.
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
) -> Option<(usize, usize)> {
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

        for arm in [MatchArm::Similarity, MatchArm::Phrase] {
            for len in 1..=max_span {
                let Some(text) = span_at(spans, taken, j, len) else {
                    continue;
                };
                // Only a span being GLUED needs the overlap guard; a lone
                // utterance is judged by the arm alone, as it always was.
                if len > 1
                    && (j..j + len)
                        .any(|k| word_overlap(&normalised[k], anchor) < MIN_UTTERANCE_OVERLAP)
                {
                    continue;
                }
                let score = similarity(anchor, text);
                let matched = match arm {
                    MatchArm::Similarity => score >= p.similarity,
                    MatchArm::Phrase => is_phrase_repeat(anchor, text, &p.phrase()),
                };
                if matched {
                    return Some((j, len));
                }
            }
        }
    }
    None
}

/// Which of the two independent signals is being asked (D-365).
///
/// Ordered: [`MatchArm::Similarity`] is the stricter, older arm and is always
/// tried first — see [`next_take`] for why that matters.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MatchArm {
    /// "The same line again" — [`similarity`] against [`RetakeParams::similarity`].
    Similarity,
    /// "The same phrase again, inside two different sentences" —
    /// [`crate::phrase::is_phrase_repeat`].
    Phrase,
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
    ///
    /// The swapped word is a stopword ("on" → "upon"), so the keeper still holds
    /// every content word of the takes it cuts. Before D-386 this fixture
    /// swapped "mat" for "rug" — and the group then proposed cutting the only
    /// two deliveries that say "mat", which is B-246's over-cut in miniature.
    /// With the keeper-coverage rule that group is no longer formed.
    #[test]
    fn similarity_reports_the_weakest_match_in_the_group() {
        let u = vec![
            utt(0, 0.0, 2.0, "The cat sat on the mat."),
            utt(1, 2.5, 4.5, "The cat sat on the mat."),
            utt(2, 5.0, 7.0, "The cat sat upon the mat."),
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

    /// The pre-D-327 detector, kept reachable by its knobs so the behaviour
    /// change stays opt-out-able and testable.
    ///
    /// Reproducing it now takes **both** knobs at their pre-existing settings:
    /// `max_span_utterances: 1` (D-327's span window off) and
    /// `phrase_min_words: 0` (D-365's second signal off). That is the point of
    /// having them as knobs rather than as a rewrite — each added signal can be
    /// switched back off independently, and "the old detector" remains a thing
    /// this suite can actually run.
    #[test]
    fn a_max_span_of_one_is_the_old_utterance_to_utterance_detector() {
        let p = RetakeParams {
            max_span_utterances: 1,
            phrase_min_words: 0,
            ..RetakeParams::default()
        };
        let g = detect_retakes(&REAL_TRIPLE_REPEAT.utterances(), &p);
        // Before D-386 this found one pair, [0, 2]. #2 ends mid-line ("…than
        // the others, the") and so does not hold #0's "model", and the ASR
        // heard #0's "glancing bag" where #2 has "glancing back": the keeper
        // does not cover the cut, so the pair is no longer proposed.
        assert!(
            g.is_empty(),
            "the old knobs over this run now propose nothing: {g:?}"
        );
    }

    /// The phrase signal alone — span window off — still reaches further into
    /// the D-327 run than edit distance alone ever did, because the repeats
    /// share verbatim phrases even where the whole strings diverge.
    ///
    /// Recorded as a measurement, not as a recommendation: `max_span_utterances`
    /// stays at its default of 3 precisely because whole spans are the better
    /// unit here, and these takes are single utterances that each straddle a
    /// delivery boundary.
    #[test]
    fn the_phrase_signal_alone_reaches_past_the_old_detectors_single_pair() {
        let p = RetakeParams {
            max_span_utterances: 1,
            ..RetakeParams::default()
        };
        let g = detect_retakes(&REAL_TRIPLE_REPEAT.utterances(), &p);
        // [0, 2, 3, 4] before D-386; #0 ("glancing bag") and #2 (ends before
        // "model") are not covered by the keeper #4 and are dropped from it.
        assert_eq!(indices(&g), vec![vec![1, 4]]);
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

        // The speaker delivered the line three times. D-327 found all three
        // ([0], [2], [3..4]); since D-386 the first is dropped, because the
        // keeper does not hold everything it says — the ASR heard "glancing
        // bag" in #0 and "glancing back" in the keeper, and the gate's content
        // rule cannot hear that they are one word. Cutting #0 is still right
        // to a listener; the detector no longer claims what it cannot check
        // (D-318's direction). The two deliveries it keeps are still the run
        // the pre-D-327 detector missed entirely.
        assert_eq!(
            group.takes.len(),
            2,
            "two deliveries the keeper covers, got {:?}",
            group.takes
        );

        assert_eq!(
            group.members.iter().map(|m| m.index).collect::<Vec<_>>(),
            vec![2, 3, 4],
            "#0 is uncovered (above), #1 is a fragment no delivery claims \
             (see below) and #5 has moved on to self-attention"
        );

        // The headline number: the old detector's group stopped at 157.48 s and
        // left everything after it uncut. This one reaches the end of the run.
        let covered_to = group.members[group.takes[1].last].end_secs;
        assert!(
            (covered_to - 179.92).abs() < 1e-9,
            "the group must reach the end of the restart run, got {covered_to}"
        );

        // The recommended keeper is the last delivery.
        assert_eq!(group.keep, 1);
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

    /// ---------------------------------------------------------------------
    /// D-365: the phrase-repair misses, from the owner's own second file.
    /// ---------------------------------------------------------------------
    ///
    /// Verbatim segments of `A001_09122319_C038.MOV` (the 16-minute talking
    /// head behind the `2026-09-12-c038-mgfx` project), read back through
    /// `editor_get_transcript` — the same whole-file, segment-level transcript
    /// B-237's investigation used, and the same footage whose hand re-cut
    /// produced that bug. Indices are this fixture's own, with each segment's
    /// real index in the 121-segment transcript in the comment beside it.
    ///
    /// Every pair here is a **self-correction of one phrase inside two
    /// otherwise-different sentences** — the shape §1-4's toolkit cannot reach,
    /// recorded as an open limit by B-237 and closed by the phrase signal.
    const REAL_PHRASE_REPAIRS: &[(&str, &str, &str)] = &[
        (
            "the technical term stumbled three times (transcript #94/#95, 717-736 s) \
             — B-237's own eighth case, measured there at whole=0.303 / containment=0.495",
            "and the third one called speculative speculating and the third one's called speculating speculative",
            "speculative decoding okay and the third one call is speculative decoding and it's kind of clever",
        ),
        (
            "the restart of 'an enormous amount of work' (transcript #67/#68, 528-541 s)",
            "that's an enormous amount of repetitive work happening constant that's an",
            "an enormous amount of work happening for every single response for every single",
        ),
        (
            "…and its second repair (transcript #68/#69, 535-547 s)",
            "an enormous amount of work happening for every single response for every single",
            "risk for every single response for every single user at the same time",
        ),
        (
            "'the real reason it's this expensive' (transcript #56/#57, 426-439 s)",
            "but the real reason is this expensive is something else entirely but the real",
            "reason it's this expensive the real reason of this being this expensive is",
        ),
        (
            "the outro's 'and subscribe if you want more of this' (transcript #117/#118, 954-970 s)",
            "corner and subscribe if you want more of this the actual economy and mechanism",
            "behind AI not just what it can do and subscribe if you want more of this the",
        ),
    ];

    /// **The decisive proof, run both ways** — the same pattern B-237's fix
    /// used. For every real case above: the existing edit-distance arm alone
    /// does NOT reach it, and the phrase arm does.
    ///
    /// Asserting both directions is the whole point. "The new signal finds it"
    /// is worth nothing on its own unless the old code demonstrably did not,
    /// and these pairs sit at 0.299-0.495 against a 0.82 bar — not near misses
    /// that a looser threshold would have swept up, but material the line-level
    /// question was never asking about.
    #[test]
    fn the_real_phrase_repairs_are_found_and_were_not_found_before() {
        let default = RetakeParams::default();
        let old = RetakeParams {
            phrase_min_words: 0,
            ..default
        };

        for (what, a, b) in REAL_PHRASE_REPAIRS {
            let u = vec![utt(0, 0.0, 6.0, a), utt(1, 6.1, 12.0, b)];

            let before = detect_retakes(&u, &old);
            let score = similarity(&normalise(a), &normalise(b));
            assert!(
                before.is_empty(),
                "{what}: the pre-D-365 detector must NOT have found this \
                 (it scored {score:.3}) — otherwise this case proves nothing"
            );
            assert!(
                score < default.similarity,
                "{what}: scored {score:.3}, which is already over the bar"
            );

            // The phrase arm admits every pair: this is the D-365 signal
            // seeing what edit distance cannot.
            assert!(
                is_phrase_repeat(&normalise(a), &normalise(b), &default.phrase()),
                "{what}: the phrase signal must admit this pair"
            );

            // Whether a GROUP follows is a second question (D-386): the first
            // segment is cut whole, so it may be proposed only if the second
            // holds every content word of it. Each of these segments carries
            // speech around the repaired phrase that is said once — "is
            // something else entirely", "repetitive … constant", "the actual
            // economy and mechanism" — so none is proposed. That is B-246 shape
            // 1 exactly; before D-386 all five were grouped, and every one
            // would have deleted speech the keeper does not hold.
            let after = detect_retakes(&u, &default);
            assert!(
                after.is_empty(),
                "{what}: the keeper does not cover the first segment, so no \
                 whole-segment cut of it is proposed, got {after:?}"
            );
        }
    }

    /// A phrase-matched group reports its **real**, low line-level similarity
    /// rather than a flattering stand-in (D-365).
    ///
    /// This is deliberate and load-bearing for the human half of the feature:
    /// `similarity` exists so a reviewer can sort the shakiest groupings to the
    /// top, and a group found only by the phrase arm is exactly one a person
    /// should eyeball before cutting.
    ///
    /// Since D-386 none of [`REAL_PHRASE_REPAIRS`] is grouped (their first
    /// segments carry speech the second does not), so this uses a synthetic
    /// phrase repair the keeper covers: a clipped restart of the line, then
    /// the whole line.
    #[test]
    fn a_phrase_matched_group_reports_its_genuinely_low_similarity() {
        // More than three times the clipped start's length, so `containment`
        // does not score it (MAX_CONTAINMENT_LENGTH_RATIO) and only the phrase
        // arm can match.
        let (a, b) = (
            "the third one is called speculative",
            "and the third one is called speculative decoding and it is kind of clever \
             because it guesses ahead and then checks",
        );
        let g = detect_retakes(
            &[utt(0, 0.0, 6.0, a), utt(1, 6.1, 12.0, b)],
            &RetakeParams::default(),
        );
        assert_eq!(g.len(), 1);
        assert!(
            g[0].similarity < RetakeParams::default().similarity,
            "a phrase-only match must not claim a line-level score it does not \
             have, got {}",
            g[0].similarity
        );
    }

    /// The new arm is **additive, never subtractive**: where the similarity arm
    /// already explained a delivery, the phrase arm must not re-cut it into
    /// smaller pieces (D-365).
    ///
    /// This is a real regression that was hit while building this, not a
    /// hypothetical. The chain takes the shortest span that clears the bar at
    /// the earliest position; with both signals in one length sweep, `#3` alone
    /// matched on the loose phrase signal and pre-empted the `#3..#4` span the
    /// strict signal matched — splitting the third delivery in two. Because the
    /// recommended keep is the LAST take, that offered the first half of a real
    /// delivery up to be cut. `next_take` now runs the similarity arm at every
    /// span length before the phrase arm at any, which is what makes this hold.
    #[test]
    fn the_phrase_signal_does_not_re_cut_a_take_the_similarity_signal_already_found() {
        let u = REAL_TRIPLE_REPEAT.utterances();
        let with = detect_retakes(&u, &RetakeParams::default());
        let without = detect_retakes(
            &u,
            &RetakeParams {
                phrase_min_words: 0,
                ..RetakeParams::default()
            },
        );
        assert_eq!(
            with, without,
            "the phrase arm must change nothing about a run the similarity arm \
             already grouped"
        );
        // Two since D-386 (the first delivery is not covered by the keeper —
        // see `the_real_triple_repeat_is_found`); the point is that it is not
        // three, which is what the phrase arm splitting `#3..#4` produced.
        assert_eq!(with[0].takes.len(), 2, "the [3..4] delivery is not split");
    }

    /// Ordinary spoken English that merely shares a topic must stay ungrouped
    /// even with the looser arm on — the negative half of D-365.
    ///
    /// These are real consecutive segments from the same C038 transcript,
    /// chosen because they are dense with the repeated topic vocabulary a
    /// 16-minute video about inference costs is full of ("model", "inference",
    /// "training", "cost"). The full sweep behind this — 7,260 real pairs, of
    /// which the phrase arm admits 20 inside the time window and all 20 are
    /// genuine retakes — is in `docs/notes/retake-detection.md` §5.
    #[test]
    fn real_topical_repetition_is_not_a_phrase_repair() {
        let u = vec![
            utt(
                0,
                0.0,
                6.0,
                "Training is when a lab takes a model and teaches it, feeding it a giant pile of",
            ),
            utt(
                1,
                6.1,
                12.0,
                "text and letting it adjust billions of internal numbers until it gets good at",
            ),
            utt(
                2,
                12.1,
                18.0,
                "The whole business is building the chips for only one thing, running an already finished",
            ),
            utt(3, 18.1, 22.0, "model as fast and as cheap as possible."),
            utt(
                4,
                22.1,
                28.0,
                "Which already tells you why it can end up costing more than training.",
            ),
        ];
        let g = detect_retakes(&u, &RetakeParams::default());
        assert!(
            g.is_empty(),
            "sharing a subject is not repeating a phrase: {g:?}"
        );
    }

    /// The time window still bounds the new arm, and that is what keeps a
    /// deliberate callback from being read as a stumble (D-365).
    ///
    /// Real: C038 says "Every time you send a message to chat GPT or cloud" at
    /// 350 s and "So next time you send a message to chatgpd or clod" at 919 s
    /// — a verbatim 6-word shared run, and an intentional bookend rather than a
    /// retake. It is 565 s apart, so the existing `window_secs` rejects it with
    /// an enormous margin; the nearest incidental match anywhere in that
    /// transcript is 248 s out, which is why the phrase arm needs no tighter
    /// bound of its own.
    #[test]
    fn a_deliberate_callback_is_outside_the_window() {
        let a = "Every time you send a message to chat GPT or cloud, that's 1 in 5.";
        let b = "So next time you send a message to chatgpd or clod and get an instant answer back, that's";

        let far = vec![utt(0, 350.2, 354.5, a), utt(1, 919.78, 927.88, b)];
        assert!(
            detect_retakes(&far, &RetakeParams::default()).is_empty(),
            "565 s apart is a callback, not a flubbed take"
        );

        // …and the pair really does share the phrase — the window rejects it
        // before the phrase arm is asked, not a failure to notice.
        let p = RetakeParams::default();
        assert!(is_phrase_repeat(&normalise(a), &normalise(b), &p.phrase()));
        // Brought within the window it is still not grouped since D-386, for a
        // second, independent reason: the first line says "every" and "1 in
        // 5", which the second does not, so cutting it would lose them.
        let near = vec![utt(0, 0.0, 5.0, a), utt(1, 5.5, 12.0, b)];
        assert!(detect_retakes(&near, &p).is_empty());
    }

    /// ---------------------------------------------------------------------
    /// B-238 / D-366: a glued anchor proposing unique content for deletion.
    /// ---------------------------------------------------------------------
    ///
    /// Verbatim segments of `A001_09122319_C038.MOV`, the same file and the same
    /// `editor_get_transcript` read as §5's fixture above, with each segment's
    /// real index in the 121-segment transcript beside it.
    ///
    /// **These two runs were both reported as fixed and correct** — the first by
    /// B-237/D-364 (its "decisive proof" case) and the second by D-365 — and in
    /// both the *detection* was right and the *proposed cut* was not. The
    /// detector glued three adjacent utterances into one anchor so it would have
    /// a comparable string, matched on the last of them, and then offered all
    /// three for deletion. See `docs/notes/retake-detection.md` §6.
    ///
    /// Pre-fix, measured, with default params:
    ///
    /// ```text
    ///   case 1: take 0 = #28 "place." + #29 "Today I actually want to show
    ///           you why that's true…" + #30 "it so expensive and the trick
    ///           behind used to bring that cost back down."   190.52-222.74 s
    ///   case 2: take 0 = #0 "In December of last year, Nvidia made the single
    ///           biggest deal in its entire history." + #1 "$20 billion in cash
    ///           to license technology from a company called Grok." + #2 "and
    ///           here's the actually interesting part"          2.04-32.74 s
    /// ```
    ///
    /// Only #30 and #2 respectively repeat anything. The rest is the video's
    /// own opening hook and a 21-second setup line, and every second of it was
    /// inside the range the tool proposed to ripple-delete.
    const REAL_GLUED_ANCHORS: &[(&str, f64, f64, &str)] = &[
        // Case 1 — B-237's own proof case. #28-#31.
        ("unique/setup", 190.52, 190.80, "place."),
        (
            "unique/setup",
            204.28,
            210.26,
            "Today I actually want to show you why that's true, what's happening technically that makes",
        ),
        // Labelled "redundant" until D-386. D-378's ground truth
        // (`eval/retake/labels/A001_09122319_C038.json`) shows its head, "it so
        // expensive", finishes #29's said-once setup line: it is welded, not
        // redundant, and no whole-utterance cut of it is safe.
        (
            "welded",
            210.26,
            222.74,
            "it so expensive and the trick behind used to bring that cost back down.",
        ),
        (
            "keep",
            222.74,
            229.86,
            "down. And the trick being used to bring that cost back down.",
        ),
    ];

    /// Case 2 — the D-365 phrase-arm equivalent: the video's own intro. #0-#4.
    const REAL_GLUED_ANCHOR_INTRO: &[(&str, f64, f64, &str)] = &[
        (
            "unique/hook",
            2.04,
            8.52,
            "In December of last year, Nvidia made the single biggest deal in its entire history.",
        ),
        (
            "unique/hook",
            14.58,
            21.02,
            "$20 billion in cash to license technology from a company called Grok.",
        ),
        (
            "redundant",
            28.82,
            32.74,
            "and here's the actually interesting part",
        ),
        // Whisper's own 0.66 s fragment sitting between the two deliveries.
        ("fragment", 33.34, 34.0, "grog doesn't build"),
        (
            "keep",
            39.50,
            44.70,
            "and here's the actually interesting part grog doesn't build chips for training ai models",
        ),
    ];

    fn from_rows(rows: &[(&str, f64, f64, &str)]) -> Vec<Utterance> {
        rows.iter()
            .enumerate()
            .map(|(i, (_, s, e, t))| utt(i, *s, *e, t))
            .collect()
    }

    /// The `(start, end)` of every row carrying `label`.
    ///
    /// The labels in the two fixtures above are the expected answer, not a
    /// comment: `"redundant"` is exactly what may be cut, `"keep"` is the
    /// delivery to keep, and everything else must not be claimed at all. Reading
    /// them back here is what stops the fixture's own annotation drifting away
    /// from what the test actually asserts.
    fn rows_labelled(rows: &[(&str, f64, f64, &str)], label: &str) -> Vec<(f64, f64)> {
        rows.iter()
            .filter(|(l, ..)| *l == label)
            .map(|(_, s, e, _)| (*s, *e))
            .collect()
    }

    /// Every second this group proposes for deletion, as `(start, end)` per
    /// non-kept member — the thing a reviewer's ripple-delete actually removes.
    fn proposed_cut(group: &RetakeGroup) -> Vec<(f64, f64)> {
        group
            .takes
            .iter()
            .enumerate()
            .filter(|(ti, _)| *ti != group.keep)
            .flat_map(|(_, t)| {
                (t.first..=t.last).map(|m| (group.members[m].start_secs, group.members[m].end_secs))
            })
            .collect()
    }

    /// **Case 1, the full correct outcome** (B-238 / D-366, D-386).
    ///
    /// Pre-D-366 the proposed cut covered 190.52-222.74 s, including the whole
    /// "Today I actually want to show you why that's true" setup line. D-366
    /// narrowed it to #30 alone — but #30 opens with "it so expensive", the end
    /// of that same said-once line (the welded row above), and the keeper does
    /// not hold "expensive" or "behind". So since D-386 nothing here is
    /// proposed: there is no whole-utterance cut of this run that loses nothing.
    /// Under-cutting, D-318's safe direction; a word-level proposer (the MCP
    /// client, D-380) can still cut "and the trick behind used to bring that
    /// cost" alone.
    #[test]
    fn a_glued_anchor_does_not_propose_the_unique_setup_line_for_deletion() {
        let u = from_rows(REAL_GLUED_ANCHORS);
        let g = detect_retakes(&u, &RetakeParams::default());
        assert!(
            g.is_empty(),
            "no utterance of this run may be proposed for deletion: {g:?}"
        );
        assert!(rows_labelled(REAL_GLUED_ANCHORS, "redundant").is_empty());
    }

    /// **Case 2, the full correct outcome** — the same defect reached through
    /// the phrase arm, and the one that took out the video's opening hook.
    ///
    /// Pre-fix the non-kept take ran 2.04-32.74 s: the Nvidia sentence, the
    /// $20-billion sentence, and only then the actually-repeated "and here's the
    /// actually interesting part". The first two share no content with the
    /// keeper; cutting them deletes the video's cold open.
    #[test]
    fn a_glued_anchor_does_not_propose_the_videos_own_intro_for_deletion() {
        let u = from_rows(REAL_GLUED_ANCHOR_INTRO);
        let g = detect_retakes(&u, &RetakeParams::default());

        assert_eq!(g.len(), 1, "the retake must still be detected: {g:?}");
        let group = &g[0];
        assert_eq!(group.takes.len(), 2);

        assert_eq!(
            proposed_cut(group),
            rows_labelled(REAL_GLUED_ANCHOR_INTRO, "redundant"),
            "only the repeated phrase's own utterance may be cut"
        );
        assert_eq!(
            indices(&g),
            vec![vec![2, 4]],
            "the fragment #3 is claimed by neither delivery"
        );
        let keeper = &group.members[group.takes[group.keep].first];
        assert_eq!(
            vec![(keeper.start_secs, keeper.end_secs)],
            rows_labelled(REAL_GLUED_ANCHOR_INTRO, "keep"),
            "the full, later delivery is the keeper"
        );

        for (i, label) in [(0, "the Nvidia hook"), (1, "the $20 billion line")] {
            assert!(
                !group.members.iter().any(|m| m.index == i),
                "{label} is unique content and must never be swept into a cut"
            );
        }
    }

    /// The direct statement of the invariant the two tests above are instances
    /// of: **no utterance a group proposes to cut may be unique content.**
    ///
    /// Expressed as the property rather than as a fixture, over both real cases:
    /// every member of every non-kept take has to share at least
    /// [`MIN_UTTERANCE_OVERLAP`] of its own vocabulary with the take the group
    /// recommends keeping. That is the check `anchor_is_justified` performs, read
    /// back off the finished output — so it also catches a future change that
    /// builds an over-claiming take by some other route.
    #[test]
    fn nothing_proposed_for_deletion_is_unique_content() {
        for rows in [REAL_GLUED_ANCHORS, REAL_GLUED_ANCHOR_INTRO] {
            let u = from_rows(rows);
            for g in detect_retakes(&u, &RetakeParams::default()) {
                let keeper = g.takes[g.keep];
                let kept: String = (keeper.first..=keeper.last)
                    .map(|m| normalise(&g.members[m].text))
                    .collect::<Vec<_>>()
                    .join(" ");
                for (ti, t) in g.takes.iter().enumerate() {
                    if ti == g.keep {
                        continue;
                    }
                    for m in t.first..=t.last {
                        let text = normalise(&g.members[m].text);
                        let ov = word_overlap(&text, &kept);
                        assert!(
                            ov >= MIN_UTTERANCE_OVERLAP,
                            "take {ti} proposes cutting #{} at overlap {ov:.3} \
                             against the keeper — that is unique content: {:?}",
                            g.members[m].index,
                            g.members[m].text
                        );
                    }
                }
            }
        }
    }

    /// **The non-regression half** (B-238 / D-366): a glued anchor whose members
    /// are *all* genuinely redundant must still be proposed whole.
    ///
    /// The fix must not become "never glue an anchor." Real C040 #8-#11: the
    /// speaker delivers the definition of attention, trails off, and delivers it
    /// again — and Whisper cut *both* deliveries across its own boundary, so the
    /// anchor is genuinely two utterances and **both** of them repeat.
    ///
    /// **What D-386 changed here.** The chain this run forms is `[#8..#9]`,
    /// `[#10]`, `[#11]` — the shortest span wins at each position — so its
    /// recommended keeper is `#11` alone, "to write, how much to focus on each
    /// word you gave it.": a *fragment* of the line. Until D-386 the group cut
    /// both complete deliveries against it (D-378's eval charges 79.28-85.00 s
    /// of `c040-attention-in-simple-terms` as lost: B-246's "straddled" shape).
    /// The fragment does not hold "attention … deciding for every word", so
    /// neither earlier take is covered and no group is proposed. The anchor
    /// guard's union measurement below is unchanged and still the reason that
    /// guard is referenced to the union.
    ///
    /// This case is also the proof that the guard's reference has to be the
    /// **union** of the other deliveries and not the first matching one: "much to
    /// focus on each word you give." scores 0.125 against delivery two (#10) and
    /// 0.875 against the union, because Whisper put its repeat in #11. Checked
    /// take by take, this genuine glue would be wrongly rejected.
    #[test]
    fn a_glued_anchor_whose_every_member_repeats_is_not_cut_against_a_fragment() {
        let u = vec![
            utt(
                0,
                44.60,
                60.28,
                "Attention! In simple term, it's just the model deciding for every word it's about to write.",
            ),
            utt(1, 60.28, 65.46, "much to focus on each word you give."),
            utt(
                2,
                79.28,
                85.00,
                "Attention! In simple term, it's just the model deciding for every word it's about",
            ),
            utt(
                3,
                85.00,
                95.46,
                "to write, how much to focus on each word you gave it.",
            ),
        ];
        let g = detect_retakes(&u, &RetakeParams::default());
        assert!(
            g.is_empty(),
            "no complete delivery may be cut against the fragment #11: {g:?}"
        );

        // And the reason the second one survives, measured rather than asserted.
        let n: Vec<String> = u.iter().map(|x| normalise(&x.text)).collect();
        let union = n[2..4].join(" ");
        assert!(
            word_overlap(&n[1], &union) >= MIN_UTTERANCE_OVERLAP,
            "against the union of the other deliveries: {:.3}",
            word_overlap(&n[1], &union)
        );
        assert!(
            word_overlap(&n[1], &n[2]) < MIN_UTTERANCE_OVERLAP,
            "…but not against delivery two alone ({:.3}) — which is why the \
             union, not the first take, is the reference",
            word_overlap(&n[1], &n[2])
        );
    }

    /// D-327's own run is unchanged by the anchor guard (B-238 / D-366).
    ///
    /// Stated separately from `the_real_triple_repeat_is_found` because that test
    /// predates the guard and it matters that its result did not move: the
    /// winning chain there has a **single-utterance** anchor (`better` prefers the
    /// shortest anchor that explains the same deliveries), so the guard has
    /// nothing to check and cannot have changed the answer. (The keeper-coverage
    /// rule did change it — #0 is dropped since D-386, see that test.)
    #[test]
    fn the_d327_run_is_untouched_by_the_anchor_guard() {
        let g = detect_retakes(&REAL_TRIPLE_REPEAT.utterances(), &RetakeParams::default());
        assert_eq!(indices(&g), vec![vec![2, 3, 4]]);
        assert_eq!(g[0].takes.len(), 2);
        assert_eq!(g[0].takes[0].len(), 1, "a single-utterance first take");
    }

    /// The other non-regression shape: a run of short single-utterance restarts
    /// with nothing unique glued into any of them (B-238 / D-366).
    ///
    /// Real C038 segments #41-#45, two interleaved restarts the detector
    /// resolves into two groups. Every take here is one utterance, so
    /// `anchor_is_justified` has nothing to check and these must come through
    /// byte-identical to their pre-fix output.
    #[test]
    fn single_utterance_restart_clusters_are_untouched() {
        let u = vec![
            utt(0, 321.76, 327.36, "Inference is everything that it's..."),
            utt(1, 333.68, 336.00, "Inference is everything after that."),
            utt(2, 336.12, 338.36, "It's the model actually being used."),
            utt(3, 339.52, 341.90, "Inference is everything after that."),
            utt(4, 342.04, 344.00, "It's the model being actually used."),
        ];
        let g = detect_retakes(&u, &RetakeParams::default());
        assert_eq!(
            indices(&g),
            vec![vec![0, 1, 3], vec![2, 4]],
            "both clusters, unchanged: {g:?}"
        );
        assert_eq!(g[0].takes.len(), 3);
        assert_eq!(g[1].takes.len(), 2);
        for group in &g {
            for t in &group.takes {
                assert_eq!(t.len(), 1, "every take here is a single utterance");
            }
        }
    }

    /// **B-246's shape, fixed (D-386):** a single-utterance take whose *tail*
    /// repeats the next delivery while its head is said once is not proposed.
    ///
    /// `similarity`'s containment arm scores the pair 1.0 on the shared tail,
    /// and D-366's overlap guard never looked at a single-utterance take, so
    /// until D-386 the whole 12-second utterance — the invoice line with it —
    /// was offered for deletion. The keeper does not hold "per-token price …
    /// monthly invoice", so the take is dropped and no group remains. The same
    /// transcript is `eval/retake/bad_examples/b246_tail_repeat`.
    #[test]
    fn a_single_utterance_take_whose_tail_repeats_is_not_proposed() {
        let u = vec![
            utt(0, 0.0, 4.0, "Right, let's get into it."),
            utt(
                1,
                5.0,
                17.0,
                "The per-token price goes down and the monthly invoice still goes up, and there is actually a name for this.",
            ),
            utt(2, 18.0, 22.0, "There is actually a name for this."),
            utt(
                3,
                23.0,
                29.0,
                "It comes from economics, and it is called the Jevons paradox.",
            ),
        ];
        let n: Vec<String> = u.iter().map(|x| normalise(&x.text)).collect();
        assert!(
            similarity(&n[1], &n[2]) >= RetakeParams::default().similarity,
            "the pair still matches — detection is not what changed"
        );
        let g = detect_retakes(&u, &RetakeParams::default());
        assert!(g.is_empty(), "nothing here can be cut whole: {g:?}");
    }

    /// An utterance too short for its overlap *fraction* to mean anything is not
    /// glued in either (B-238 / D-366).
    ///
    /// Real C038 #66-#68. "one response" is 0.96 s and two distinct words, one
    /// of which ("response") happens to recur in the repair — so it scores
    /// exactly 0.500 and cleared the bar on a single incidental word. It is the
    /// tail of the *previous* sentence ("200 full rereads just to write one
    /// response"), not part of the repeated line, which is why
    /// `anchor_is_justified` also requires `min_words` distinct words before it
    /// believes a fraction at all.
    ///
    /// Since D-386 the run proposes no group at all — #67 carries "repetitive
    /// … constant", which the keeper #68 does not hold — so the guard is also
    /// asked directly, on the chain it used to reject, to keep it exercised.
    #[test]
    fn an_utterance_too_short_to_judge_is_not_glued_into_an_anchor() {
        let u = vec![
            utt(0, 519.68, 520.64, "one response"),
            utt(
                1,
                528.50,
                535.66,
                "that's an enormous amount of repetitive work happening constant that's an",
            ),
            utt(
                2,
                535.66,
                541.14,
                "an enormous amount of work happening for every single response for every single",
            ),
        ];
        let p = RetakeParams::default();
        let g = detect_retakes(&u, &p);
        assert!(
            g.is_empty(),
            "the keeper does not cover #67's \"repetitive … constant\": {g:?}"
        );

        // The guard itself: gluing "one response" into the anchor is refused,
        // the same anchor without it is not.
        let n: Vec<String> = u.iter().map(|x| normalise(&x.text)).collect();
        let chain = |start: usize, len: usize| Chain {
            takes: vec![Span { start, len }, Span { start: 2, len: 1 }],
            worst: 1.0,
        };
        assert!(
            !anchor_is_justified(&chain(0, 2), &n, &p),
            "\"one response\" belongs to the previous sentence, not this take"
        );
        assert!(anchor_is_justified(&chain(1, 1), &n, &p));

        // The measurement behind the rule: the fraction alone would have let it
        // in on one word in common.
        let short = normalise("one response");
        let rest = normalise(
            "an enormous amount of work happening for every single response for every single",
        );
        assert!(
            word_overlap(&short, &rest) >= MIN_UTTERANCE_OVERLAP,
            "the overlap fraction alone does not reject it: {:.3}",
            word_overlap(&short, &rest)
        );
        assert!(
            distinct_word_count(&short) < RetakeParams::default().min_words,
            "it is the distinct-word bar that does"
        );
    }
}

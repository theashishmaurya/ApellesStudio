//! Repeated-phrase ("rough copy") detection — the second retake signal (D-365).
//!
//! **What this is.** One predicate: *do these two stretches of speech share a
//! repeated, content-bearing phrase?* It is the second, independent arm of
//! retake detection, sitting beside [`crate::retake::similarity`] rather than
//! replacing it — a pair matched by **either** is a retake ([`crate::retake`]
//! ORs them together, and that module owns everything else: anchors, chains,
//! the time window, which take to keep).
//!
//! **What it does NOT do.** It does not score, rank or group anything — it
//! answers yes/no and nothing else. It reads no audio, no timings and no
//! timeline. It is not a similarity measure and must never be used as one: two
//! spans can share a strong repeated phrase and still be mostly different
//! sentences, which is the entire point of it.
//!
//! ## The gap it closes
//!
//! [`crate::retake`]'s existing signal asks "is this **the same line** again",
//! measured by normalised edit distance over the whole string (plus a
//! containment sweep). That is the right question for a restart — and the wrong
//! question for the other, equally common disfluency, where the speaker
//! repairs *one phrase* inside two otherwise-different sentences:
//!
//! ```text
//!   "and the third one called speculative speculating and the
//!    third one's called speculating speculative"
//!   "speculative decoding okay and the third one call is speculative
//!    decoding and it's kind of clever"
//! ```
//!
//! Measured with the real logic: whole-string **0.303**, containment **0.495**,
//! against a 0.82 bar. A human hears one continuous self-correction of a
//! two-word technical term; edit distance sees two sentences that diverge
//! everywhere outside the repeat. Recorded as a known limit by B-237 and left
//! unsolved there, because nothing in the existing toolkit reaches it.
//!
//! ## Why a repeated n-gram, and why this is not the embedding idea again
//!
//! This is the classic **reparandum / repair** pattern from the disfluency
//! literature (Shriberg 1994 onward), and its established non-ML signal is the
//! **"rough copy" property**: a repair is a near-verbatim repeat of a *phrase*
//! from the botched attempt, even when the surrounding sentence differs
//! completely. So the unit to look for is a repeated **word n-gram**, not a
//! repeated sentence.
//!
//! Crucially this is **not** a quiet re-run of the sentence-embedding model
//! D-327 measured and threw out. That model was rejected because it scores
//! *meaning*, so a sentence and its own negation came out at 0.946 — above
//! every genuine retake (0.59–0.77) — and no threshold could separate them.
//! This predicate never infers meaning at all: it only reports literal,
//! verbatim repetition, so it cannot invent an equivalence the words do not
//! show.
//!
//! **It does not, however, make negation safe — and that claim would be false
//! if it were made.** Measured, not assumed: "the model gives that part of your
//! message **less** weight" and "… **more** weight" share the verbatim 8-word
//! run "the model gives that part of your message", so this predicate says yes.
//! What saves that particular pair is that the existing arm already scores it
//! **0.925**, well over its own 0.82 bar — the lexical detector has grouped
//! minimal pairs like it since long before this module existed, and nothing
//! here changed that either way. See
//! `a_negation_minimal_pair_is_not_a_new_admission`, and §5 of
//! `docs/notes/retake-detection.md` for the two probes where this arm *is* a
//! genuinely new admission and why they are accepted.
//!
//! ## What stops it firing on ordinary English
//!
//! Two guards, both tuned against a real 121-segment, 16-minute transcript
//! rather than guessed (`docs/notes/retake-detection.md` §5):
//!
//! - **A stopword filter.** "and the", "of the", "it's" repeat between adjacent
//!   sentences all day long in normal speech and mean nothing.
//! - **A minimum run length**, and — at exactly that length — a minimum count of
//!   **content** words in the run. A run *longer* than the bar is admitted on
//!   its own length even with no content words at all, because a purely
//!   functional phrase repeated verbatim at that length ("and the third one",
//!   "not just what it can do") is itself a repair marker, not a coincidence.
//!
//! Measured over every pair of that transcript's 121 real utterances — 7,260
//! pairs of genuine, same-topic spoken English — this predicate admits 26, of
//! which **20 fall inside the detector's 30 s window and every one of those 20
//! is a real retake**. The other 6 are 248–565 s apart (a deliberate callback:
//! "every time you send a message to ChatGPT" early, "next time you send a
//! message to ChatGPT" in the outro) and the caller's existing time window
//! rejects them with an enormous margin. That measurement is why this module
//! needs no time bound of its own.

/// Words that carry no topical content, and whose repetition between two
/// nearby sentences is therefore ordinary English rather than evidence of a
/// self-correction.
///
/// **Hardcoded on purpose.** A stopword list is a small, stable,
/// language-specific constant, not an algorithm — the standard practice in this
/// literature is a fixed list, and pulling an NLP dependency (and its model
/// data, and its licence, and its updates) in to hold ~150 English words would
/// fail this repo's own "a 20-line pure function has no business pulling in a
/// dependency" bar (`CLAUDE.md`).
///
/// It is deliberately **generous** — ordinals ("first", "third"), vague
/// quantifiers ("lot", "many"), hedges ("basically", "actually") and the
/// bleached verbs ("get", "go", "thing") are all in it. Every word listed here
/// is one whose repetition proves nothing; a word wrongly listed costs recall
/// on the content-bearing tier only, and the length tier still catches the run.
/// The bare letters at the end are what `normalise` leaves behind from
/// contractions: "it's" becomes "it s".
const STOPWORDS: &[&str] = &[
    "a",
    "about",
    "again",
    "all",
    "also",
    "although",
    "am",
    "an",
    "and",
    "another",
    "any",
    "are",
    "as",
    "at",
    "back",
    "basically",
    "be",
    "because",
    "been",
    "being",
    "but",
    "by",
    "can",
    "could",
    "d",
    "did",
    "do",
    "does",
    "doing",
    "done",
    "down",
    "each",
    "even",
    "every",
    "first",
    "for",
    "from",
    "get",
    "gets",
    "go",
    "goes",
    "going",
    "got",
    "had",
    "has",
    "have",
    "having",
    "he",
    "her",
    "here",
    "him",
    "his",
    "how",
    "i",
    "if",
    "in",
    "into",
    "is",
    "it",
    "its",
    "just",
    "kind",
    "knew",
    "know",
    "knows",
    "last",
    "let",
    "lets",
    "like",
    "ll",
    "lot",
    "lots",
    "m",
    "many",
    "may",
    "me",
    "mean",
    "means",
    "meant",
    "might",
    "more",
    "most",
    "much",
    "must",
    "my",
    "next",
    "no",
    "nor",
    "not",
    "now",
    "of",
    "off",
    "ok",
    "okay",
    "on",
    "once",
    "one",
    "only",
    "onto",
    "or",
    "other",
    "others",
    "our",
    "out",
    "over",
    "re",
    "really",
    "s",
    "said",
    "same",
    "saw",
    "say",
    "says",
    "second",
    "see",
    "sees",
    "shall",
    "she",
    "should",
    "since",
    "so",
    "some",
    "sort",
    "still",
    "stuff",
    "t",
    "than",
    "that",
    "the",
    "their",
    "them",
    "then",
    "there",
    "these",
    "they",
    "thing",
    "things",
    "think",
    "thinks",
    "third",
    "this",
    "those",
    "though",
    "thought",
    "three",
    "to",
    "too",
    "two",
    "under",
    "up",
    "us",
    "ve",
    "very",
    "was",
    "way",
    "ways",
    "we",
    "well",
    "were",
    "what",
    "when",
    "where",
    "which",
    "while",
    "who",
    "whom",
    "why",
    "will",
    "with",
    "without",
    "would",
    "yeah",
    "yes",
    "you",
    "your",
];

/// Is this word one whose repetition proves nothing?
fn is_stopword(word: &str) -> bool {
    STOPWORDS.binary_search(&word).is_ok()
}

/// How many content (non-[`STOPWORDS`]) words a run carries.
fn content_word_count(run: &[&str]) -> usize {
    run.iter().filter(|w| !is_stopword(w)).count()
}

/// How many content words a repeated phrase must carry when it is **exactly**
/// [`PhraseParams::min_words`] long.
///
/// Two, measured. On the real transcript this is the single number that
/// separates a repair from a coincidence at the shortest admissible length:
/// every three-word run with two content words in that footage is a genuine
/// self-correction ("the real reason", "inference is everything", "so quick
/// recap", "something else entirely", "actual economy and"), and the only
/// three-word runs with *one* content word are the incidental "if you want"
/// pairs, which this correctly rejects. A run longer than the bar does not have
/// to clear this — see [`is_phrase_repeat`].
const MIN_CONTENT_WORDS: usize = 2;

/// Tuning for [`is_phrase_repeat`].
///
/// Its own struct rather than loose arguments so [`crate::retake::RetakeParams`]
/// can embed it flat and this module stays independently testable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PhraseParams {
    /// Shortest repeated run, in words, that may mark two spans as one
    /// self-correction. **0 disables the phrase signal entirely**, which is the
    /// supported way to get exactly the pre-D-365 detector back.
    ///
    /// 3 is the measured default: see [`MIN_CONTENT_WORDS`] for what a run of
    /// exactly this length additionally has to clear, and `is_phrase_repeat`
    /// for why a longer one does not.
    pub min_words: usize,
}

impl PhraseParams {
    /// The measured default for [`Self::min_words`], named so
    /// [`crate::retake::RetakeParams`]'s own default can cite this one rather
    /// than repeating the literal and letting the two drift apart.
    pub const DEFAULT_MIN_WORDS: usize = 3;
}

impl Default for PhraseParams {
    fn default() -> Self {
        Self {
            min_words: Self::DEFAULT_MIN_WORDS,
        }
    }
}

/// The longest run of words appearing contiguously in **both** `a` and `b`.
///
/// Plain dynamic programming over the two word slices — the word-level
/// "longest common substring". `O(|a| · |b|)` in time and `O(|b|)` in space,
/// on strings that are at most a few dozen words: this runs inside the
/// detector's inner loop, so the rolling single row is deliberate.
///
/// Hand-rolled rather than pulled from a crate because it genuinely is a small
/// stable pure function (`CLAUDE.md`'s own carve-out from "reach for the
/// library"), and every string-similarity crate in this workspace's tree —
/// `strsim` included, which `retake` already uses for edit distance — measures
/// *distance*, not the shared substring itself.
fn longest_shared_run<'a>(a: &'a [&'a str], b: &[&str]) -> &'a [&'a str] {
    let mut best_len = 0usize;
    let mut best_end = 0usize;
    let mut prev = vec![0usize; b.len() + 1];
    let mut cur = vec![0usize; b.len() + 1];

    for (i, aw) in a.iter().enumerate() {
        cur[0] = 0;
        for (j, bw) in b.iter().enumerate() {
            cur[j + 1] = if aw == bw { prev[j] + 1 } else { 0 };
            if cur[j + 1] > best_len {
                best_len = cur[j + 1];
                best_end = i + 1;
            }
        }
        std::mem::swap(&mut prev, &mut cur);
    }

    &a[best_end - best_len..best_end]
}

/// Do these two already-[`crate::retake::normalise`]d strings share a repeated,
/// content-bearing phrase — the "rough copy" of a self-correction?
///
/// The rule, in full: the longest run of words occurring contiguously in both
/// sides must be at least [`PhraseParams::min_words`] long, **and** either
///
/// - carry at least [`MIN_CONTENT_WORDS`] content words, **or**
/// - be *longer* than the bar, in which case its length is the evidence and it
///   needs no content words at all.
///
/// That second tier is not a loosening for its own sake; it is the measured
/// difference between catching and missing two real cases. "and the third one"
/// (the technical-term stumble in the module doc) and "not just what it can do"
/// (a three-times-repeated outro line) are repeated verbatim and are pure
/// function words — the repair marker *is* the functional phrase. Meanwhile the
/// incidental three-word run this must reject, "if you want", is rejected by
/// the first tier and never reaches the second.
///
/// Symmetric in its arguments, and cheap: no allocation beyond the DP rows.
pub fn is_phrase_repeat(a: &str, b: &str, p: &PhraseParams) -> bool {
    if p.min_words == 0 {
        return false;
    }
    let aw: Vec<&str> = a.split(' ').filter(|w| !w.is_empty()).collect();
    let bw: Vec<&str> = b.split(' ').filter(|w| !w.is_empty()).collect();

    let run = longest_shared_run(&aw, &bw);
    if run.len() < p.min_words {
        return false;
    }
    run.len() > p.min_words || content_word_count(run) >= MIN_CONTENT_WORDS
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::retake::normalise;

    /// [`is_stopword`] binary-searches, so the list has to be sorted. A test
    /// rather than a comment because the failure mode — a word silently not
    /// found — is invisible at the call site.
    #[test]
    fn the_stopword_list_is_sorted_and_deduplicated() {
        let mut sorted = STOPWORDS.to_vec();
        sorted.sort_unstable();
        assert_eq!(sorted, STOPWORDS, "STOPWORDS must be in sorted order");
        let mut deduped = sorted.clone();
        deduped.dedup();
        assert_eq!(deduped, sorted, "STOPWORDS must not repeat a word");
        for w in STOPWORDS {
            assert!(is_stopword(w), "{w} must be findable by binary search");
        }
        assert!(!is_stopword("speculative"));
        assert!(!is_stopword("inference"));
    }

    #[test]
    fn the_longest_shared_run_is_the_contiguous_one() {
        let a: Vec<&str> = "the cat sat on the mat today".split(' ').collect();
        let b: Vec<&str> = "yesterday the cat sat on the rug".split(' ').collect();
        assert_eq!(
            longest_shared_run(&a, &b),
            ["the", "cat", "sat", "on", "the"]
        );
    }

    #[test]
    fn no_shared_words_is_an_empty_run() {
        let a: Vec<&str> = "alpha beta gamma".split(' ').collect();
        let b: Vec<&str> = "delta epsilon".split(' ').collect();
        assert!(longest_shared_run(&a, &b).is_empty());
    }

    fn repeats(a: &str, b: &str) -> bool {
        is_phrase_repeat(&normalise(a), &normalise(b), &PhraseParams::default())
    }

    /// Function words repeating between two neighbouring sentences is what
    /// ordinary English *does*, and must never be evidence of anything.
    #[test]
    fn a_run_of_pure_function_words_at_the_bar_is_not_a_repeat() {
        assert!(!repeats(
            "replies if you want the deep dive on quantization",
            "corner and subscribe if you want more of this",
        ));
        assert!(!repeats(
            "it's the same as before",
            "it's a different thing"
        ));
    }

    /// …but the same length of run carrying real content words is.
    #[test]
    fn a_content_bearing_run_at_the_bar_is_a_repeat() {
        assert!(repeats(
            "but the real reason is this expensive is something else entirely",
            "reason it's this expensive the real reason of this being this expensive is",
        ));
    }

    /// The second tier: a verbatim functional phrase one word over the bar is
    /// admitted on its length alone. This is the technical-term stumble.
    #[test]
    fn a_longer_functional_run_is_admitted_on_length_alone() {
        assert!(repeats(
            "and the third one called speculative speculating and the third one's called speculating speculative",
            "speculative decoding okay and the third one call is speculative decoding and it's kind of clever",
        ));
    }

    /// **The honest version of the negation story** (D-365).
    ///
    /// It would be comfortable to claim this signal "solves" the negation
    /// problem that killed the embedding model in D-327. It does not, and this
    /// test exists so nobody can believe it does. A minimal pair differing in
    /// one word shares a long verbatim run *by construction*, so the predicate
    /// says yes to both probes below.
    ///
    /// What is actually true — and what this asserts — is that the phrase arm
    /// is not what groups them. The existing edit-distance arm already scores
    /// both **above its own 0.82 bar**, so these pairs were grouped before this
    /// module existed and are grouped identically after it. The phrase arm adds
    /// no new admission here, which is the only claim the design rests on.
    #[test]
    fn a_negation_minimal_pair_is_not_a_new_admission() {
        for (a, b) in [
            (
                "the model gives that part of your message less weight",
                "the model gives that part of your message more weight",
            ),
            (
                "the model weighs every part of your message equally",
                "the model does not weigh every part of your message equally",
            ),
        ] {
            let s = crate::retake::similarity(&normalise(a), &normalise(b));
            assert!(
                s >= crate::retake::RetakeParams::default().similarity,
                "the premise of this test is that the EXISTING arm already \
                 groups this pair; it scored {s:.3}"
            );
            assert!(
                repeats(a, b),
                "and this one says yes too — stated plainly rather than claimed away"
            );
        }
    }

    /// An antonym pair that shares no long verbatim frame is left alone by both
    /// arms — the case where "literal repetition only" genuinely does help.
    #[test]
    fn an_antonym_pair_with_no_shared_frame_is_not_a_repeat() {
        assert!(!repeats(
            "self-attention lets every token look at every other token",
            "cross-attention lets the decoder look at the encoder's tokens",
        ));
        assert!(!repeats(
            "attention is how a transformer decides what matters",
            "attention is the mechanism that makes transformers work so well",
        ));
    }

    /// **The measured cost of this signal, pinned so it stays visible** (D-365).
    ///
    /// This is the one probe from D-327's "must NOT group" set that the phrase
    /// arm admits and the similarity arm does not — a *deliberate parallel
    /// construction*, where a speaker frames two contrasting sentences with the
    /// same words on purpose. Text alone cannot tell that apart from a repair:
    /// both are "a long verbatim frame around a changed pivot", and no
    /// threshold on run length or content-word count separated them across
    /// every combination tried (§5 of `docs/notes/retake-detection.md`).
    ///
    /// It is pinned as an accepted limit rather than hidden because the
    /// detector only ever *proposes* (D-318), because a phrase-matched group
    /// reports a low `similarity` and so sorts to the top of a reviewer's list,
    /// and because `phrase_min_words: 0` turns the arm off outright. If a
    /// future change makes this pair pass, that is a genuine improvement and
    /// this test should be updated deliberately — not a silent behaviour drift.
    #[test]
    fn a_deliberate_parallel_construction_is_a_known_false_positive() {
        let a = "first we will look at what attention does";
        let b = "then we will look at what attention cannot do";
        let s = crate::retake::similarity(&normalise(a), &normalise(b));
        assert!(
            s < crate::retake::RetakeParams::default().similarity,
            "the similarity arm rejects this pair ({s:.3})"
        );
        assert!(
            repeats(a, b),
            "…and the phrase arm accepts it. A known, accepted cost."
        );
    }

    #[test]
    fn unrelated_sentences_are_not_a_repeat() {
        assert!(!repeats(
            "today we are going to talk about colour",
            "first let us look at the waveform",
        ));
    }

    /// The knob is real in both directions.
    #[test]
    fn zero_min_words_disables_the_signal() {
        let off = PhraseParams { min_words: 0 };
        assert!(!is_phrase_repeat(
            &normalise("for every single response for every single user"),
            &normalise("an enormous amount for every single response for every single"),
            &off,
        ));
    }

    #[test]
    fn raising_min_words_makes_it_stricter() {
        let a = normalise("but the real reason is this expensive is something else entirely");
        let b =
            normalise("reason it's this expensive the real reason of this being this expensive is");
        assert!(is_phrase_repeat(&a, &b, &PhraseParams { min_words: 3 }));
        assert!(!is_phrase_repeat(&a, &b, &PhraseParams { min_words: 5 }));
    }

    #[test]
    fn it_is_symmetric() {
        let a =
            normalise("that's an enormous amount of repetitive work happening constant that's an");
        let b = normalise(
            "an enormous amount of work happening for every single response for every single",
        );
        let p = PhraseParams::default();
        assert_eq!(is_phrase_repeat(&a, &b, &p), is_phrase_repeat(&b, &a, &p));
        assert!(is_phrase_repeat(&a, &b, &p));
    }

    #[test]
    fn empty_input_is_not_a_repeat() {
        let p = PhraseParams::default();
        assert!(!is_phrase_repeat("", "", &p));
        assert!(!is_phrase_repeat("", "the cat sat on the mat", &p));
    }
}

//! Transcript utterances → near-duplicate "retake" groups (D-318).
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

/// A run of utterances that all say substantially the same thing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RetakeGroup {
    /// Two or more utterances, in the order they were spoken.
    pub members: Vec<Utterance>,
    /// The member this module *suggests* keeping, as an index into
    /// [`Self::members`] — the last one, because that is normally the take the
    /// speaker settled on before moving to the next line. A suggestion, not a
    /// decision: see the module doc.
    pub keep: usize,
    /// The lowest pairwise similarity between the group's first member and any
    /// other, in `0.0..=1.0` — how confident the grouping is, so a reviewer can
    /// sort the marginal ones to the top.
    pub similarity: f64,
}

/// Tuning for [`detect_retakes`].
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RetakeParams {
    /// Normalised similarity at or above which two utterances are "the same
    /// line". 0.82 keeps real restarts together while holding apart two
    /// different sentences that merely share a subject.
    pub similarity: f64,
    /// How far apart two utterances may be and still be a retake of each other.
    /// A line repeated half an hour later is a callback, not a flubbed take.
    pub window_secs: f64,
    /// Utterances with fewer real words than this are never grouped. Without
    /// it, every "Yeah." and "Okay, so—" in a recording pairs with every other
    /// one at similarity 1.0, which is true and completely useless.
    pub min_words: usize,
}

impl Default for RetakeParams {
    fn default() -> Self {
        Self {
            similarity: 0.82,
            window_secs: 30.0,
            min_words: 3,
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

/// Word count of an already-[`normalise`]d string.
fn word_count(normalised: &str) -> usize {
    if normalised.is_empty() {
        0
    } else {
        normalised.split(' ').filter(|w| !w.is_empty()).count()
    }
}

/// Largest token-count ratio between two utterances that may still be a retake.
///
/// Containment alone would group a sentence with any paragraph that happens to
/// quote it. A real retake is *the same line again*, so the two sides stay
/// comparable in length even when one carries a false start. 3x is loose enough
/// for "The cat sat— the cat sat on the mat" (9 tokens) against "The cat sat on
/// the mat" (6) and tight enough to reject a clause inside a monologue.
const MAX_CONTAINMENT_LENGTH_RATIO: f64 = 3.0;

/// Best score for the shorter utterance against any equal-length window of the
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

/// How alike two utterances are, in `0.0..=1.0`.
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
/// **The honest false positive.** Containment also fires when a later utterance
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

/// Group near-duplicate utterances into retakes.
///
/// Greedy and single-pass: each ungrouped utterance opens a group, then every
/// later utterance still inside `window_secs` of the group's *latest* member is
/// tested against the group's *first* member and joins if it is similar enough.
/// Comparing against the first member (rather than chaining off the latest)
/// stops a long run of small drifts from walking a group away from what it
/// started as. Groups of one are not retakes and are not returned.
///
/// Input is expected in spoken order; the output preserves it.
pub fn detect_retakes(utterances: &[Utterance], p: &RetakeParams) -> Vec<RetakeGroup> {
    let normalised: Vec<String> = utterances.iter().map(|u| normalise(&u.text)).collect();
    let eligible: Vec<bool> = normalised
        .iter()
        .map(|n| word_count(n) >= p.min_words)
        .collect();

    let mut taken = vec![false; utterances.len()];
    let mut groups = Vec::new();

    for i in 0..utterances.len() {
        if taken[i] || !eligible[i] {
            continue;
        }
        let mut members = vec![i];
        let mut worst = 1.0_f64;
        let mut latest_end = utterances[i].end_secs;

        for j in (i + 1)..utterances.len() {
            if taken[j] || !eligible[j] {
                continue;
            }
            if utterances[j].start_secs - latest_end > p.window_secs {
                break;
            }
            let score = similarity(&normalised[i], &normalised[j]);
            if score >= p.similarity {
                taken[j] = true;
                members.push(j);
                worst = worst.min(score);
                latest_end = utterances[j].end_secs;
            }
        }

        if members.len() < 2 {
            continue;
        }
        taken[i] = true;
        let members: Vec<Utterance> = members.into_iter().map(|k| utterances[k].clone()).collect();
        groups.push(RetakeGroup {
            keep: members.len() - 1,
            members,
            similarity: worst,
        });
    }

    groups
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
        assert_eq!(g[0].keep, 1, "the LAST take is the recommended keep");
        assert_eq!(g[0].members[g[0].keep].index, 1);
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
        assert_eq!(
            g[0].members.iter().map(|m| m.index).collect::<Vec<_>>(),
            vec![0, 1]
        );
        assert_eq!(
            g[1].members.iter().map(|m| m.index).collect::<Vec<_>>(),
            vec![2, 3]
        );
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
}

//! Sentences: the unit every clip edge snaps to (D-411 §3.1).
//!
//! **What it is.** [`segment_sentences`] cuts the word view into sentences
//! from the transcript alone: a sentence ends after a sentence-final mark
//! (Parakeet punctuates), after a pause of at least [`SENTENCE_PAUSE_S`] where
//! no mark arrived, and at the end of a piece (one clip window of the source —
//! a sentence never spans two). A run-on longer than [`MAX_SENTENCE_S`] is split
//! at its longest internal pause, a clause mark (comma, colon) counting extra.
//!
//! **Why the transcript and not the VAD.** The sentence list is what a client
//! cites by number, so its numbering must not move when audio evidence arrives
//! later in the analysis: it is built from words only, and the moment view's
//! id covers it (the evidence tags do not).
//!
//! **What it does NOT do.** No meaning, no topic, no quality. A sentence is a
//! mechanical unit; whether it is a good place to start a short is the
//! client's call.

use apelles_speech::IndexedWord;
use serde::{Deserialize, Serialize};

use crate::text::{WordEnd, word_end};

/// A pause, in seconds, after which an unpunctuated stretch counts as a
/// finished sentence: the existing `min_silence_ms` "they stopped talking"
/// default (D-319), so the clipper and the silence detector agree about what a
/// stop is.
pub const SENTENCE_PAUSE_S: f64 = 0.6;

/// The longest a sentence may run before it is split at its longest internal
/// pause. A clip edge can only fall between sentences, so one 40 s run-on
/// would make every short around it 40 s coarse.
pub const MAX_SENTENCE_S: f64 = 15.0;

/// How much a clause mark (`,` `;` `:` a dash) adds to an internal pause when
/// choosing where to split a run-on: a comma is where a speaker would breathe.
const CLAUSE_SPLIT_BONUS_S: f64 = 0.3;

/// Why a sentence ended where it did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Ending {
    Period,
    Question,
    Exclamation,
    /// No mark; a pause of at least [`SENTENCE_PAUSE_S`] followed.
    Pause,
    /// A run-on split at an internal pause or clause mark.
    Split,
    /// The last words of a piece (a clip window or the end of the source).
    PieceEnd,
}

impl Ending {
    /// Ends on a sentence-final mark.
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Period | Self::Question | Self::Exclamation)
    }
}

/// One sentence of the view, in source seconds of its piece's source.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Sentence {
    /// Inclusive word indices into the view.
    pub first_word: usize,
    pub last_word: usize,
    /// The piece (clip window) every word of this sentence is in.
    pub piece: usize,
    pub start_secs: f64,
    pub end_secs: f64,
    pub text: String,
    pub ending: Ending,
    /// Silence from the last word to the next word of the same piece, or
    /// `None` when this sentence ends its piece.
    pub pause_after_secs: Option<f64>,
    /// Silence from the previous word of the same piece, or `None` when this
    /// sentence opens its piece.
    pub pause_before_secs: Option<f64>,
}

impl Sentence {
    pub fn duration_secs(&self) -> f64 {
        self.end_secs - self.start_secs
    }

    pub fn word_count(&self) -> usize {
        self.last_word + 1 - self.first_word
    }
}

/// The silence between two words, never negative (overlapping timestamps
/// count as no pause).
pub(crate) fn gap(words: &[IndexedWord], a: usize, b: usize) -> f64 {
    (words[b].start_secs - words[a].end_secs).max(0.0)
}

/// Cut the view's words into sentences, in order. `piece_of_word[i]` is word
/// `i`'s piece (`IndexedView::piece_of_word`); a shorter slice treats the
/// missing words as piece 0.
pub fn segment_sentences(words: &[IndexedWord], piece_of_word: &[usize]) -> Vec<Sentence> {
    let piece = |i: usize| piece_of_word.get(i).copied().unwrap_or(0);
    let mut spans: Vec<(usize, usize, Ending)> = Vec::new();
    let mut first = 0usize;
    for i in 0..words.len() {
        let last_in_piece = i + 1 == words.len() || piece(i + 1) != piece(i);
        let end = word_end(&words[i].text);
        let ending = match end {
            WordEnd::Period => Some(Ending::Period),
            WordEnd::Question => Some(Ending::Question),
            WordEnd::Exclamation => Some(Ending::Exclamation),
            _ if last_in_piece => Some(Ending::PieceEnd),
            _ if gap(words, i, i + 1) >= SENTENCE_PAUSE_S => Some(Ending::Pause),
            _ => None,
        };
        if let Some(ending) = ending {
            spans.push((first, i, ending));
            first = i + 1;
        }
    }

    let mut split: Vec<(usize, usize, Ending)> = Vec::with_capacity(spans.len());
    for (a, b, ending) in spans {
        split_run_on(words, a, b, ending, &mut split);
    }

    split
        .into_iter()
        .map(|(a, b, ending)| {
            let p = piece(a);
            let pause_after =
                (b + 1 < words.len() && piece(b + 1) == p).then(|| gap(words, b, b + 1));
            let pause_before = (a > 0 && piece(a - 1) == p).then(|| gap(words, a - 1, a));
            Sentence {
                first_word: a,
                last_word: b,
                piece: p,
                start_secs: words[a].start_secs,
                end_secs: words[b].end_secs,
                text: words[a..=b]
                    .iter()
                    .map(|w| w.text.trim())
                    .filter(|t| !t.is_empty())
                    .collect::<Vec<_>>()
                    .join(" "),
                ending,
                pause_after_secs: pause_after,
                pause_before_secs: pause_before,
            }
        })
        .collect()
}

/// Split `a..=b` at its best internal break while it is longer than
/// [`MAX_SENTENCE_S`], pushing the pieces in order. The first half of a split
/// ends `Split`; the last keeps the original ending.
fn split_run_on(
    words: &[IndexedWord],
    a: usize,
    b: usize,
    ending: Ending,
    out: &mut Vec<(usize, usize, Ending)>,
) {
    let duration = words[b].end_secs - words[a].start_secs;
    if duration <= MAX_SENTENCE_S || b == a {
        out.push((a, b, ending));
        return;
    }
    let mid = (words[a].start_secs + words[b].end_secs) / 2.0;
    let mut best: Option<(usize, f64, f64)> = None;
    for k in a..b {
        let bonus = if word_end(&words[k].text) == WordEnd::Clause {
            CLAUSE_SPLIT_BONUS_S
        } else {
            0.0
        };
        let score = gap(words, k, k + 1) + bonus;
        let off_centre = (words[k].end_secs - mid).abs();
        let better = match best {
            None => true,
            Some((_, s, c)) => score > s || (score == s && off_centre < c),
        };
        if better {
            best = Some((k, score, off_centre));
        }
    }
    match best {
        Some((k, _, _)) => {
            split_run_on(words, a, k, Ending::Split, out);
            split_run_on(words, k + 1, b, ending, out);
        }
        None => out.push((a, b, ending)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn w(text: &str, start: f64, end: f64) -> IndexedWord {
        IndexedWord {
            text: text.into(),
            start_secs: start,
            end_secs: end,
            run: 0,
        }
    }

    #[test]
    fn splits_at_marks_and_at_a_long_unpunctuated_pause() {
        let words = vec![
            w("Hello", 0.0, 0.4),
            w("there.", 0.45, 0.8),
            w("This", 1.0, 1.2),
            w("is", 1.25, 1.4),
            w("it", 1.45, 1.6),
            // 0.7 s pause, no mark: a sentence end.
            w("Next", 2.3, 2.6),
            w("one?", 2.65, 3.0),
        ];
        let s = segment_sentences(&words, &[0; 7]);
        assert_eq!(s.len(), 3);
        assert_eq!(
            (s[0].first_word, s[0].last_word, s[0].ending),
            (0, 1, Ending::Period)
        );
        assert_eq!(
            (s[1].first_word, s[1].last_word, s[1].ending),
            (2, 4, Ending::Pause)
        );
        assert_eq!(
            (s[2].first_word, s[2].last_word, s[2].ending),
            (5, 6, Ending::Question)
        );
        assert_eq!(s[1].text, "This is it");
        assert!((s[0].pause_after_secs.unwrap_or(0.0) - 0.2).abs() < 1e-9);
        assert_eq!(s[0].pause_before_secs, None);
        assert_eq!(s[2].pause_after_secs, None);
    }

    #[test]
    fn a_short_pause_without_a_mark_does_not_end_a_sentence() {
        let words = vec![
            w("one", 0.0, 0.3),
            w("two", 0.8, 1.0),
            w("three.", 1.1, 1.4),
        ];
        let s = segment_sentences(&words, &[0; 3]);
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].ending, Ending::Period);
    }

    #[test]
    fn a_piece_boundary_always_ends_a_sentence() {
        let words = vec![
            w("mid", 0.0, 0.3),
            w("sentence", 0.35, 0.7),
            w("cut", 50.0, 50.3),
        ];
        let s = segment_sentences(&words, &[0, 0, 1]);
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].ending, Ending::PieceEnd);
        assert_eq!(s[0].pause_after_secs, None);
        assert_eq!(s[1].piece, 1);
        assert_eq!(s[1].pause_before_secs, None);
    }

    #[test]
    fn a_run_on_is_split_at_its_longest_pause_with_commas_favoured() {
        // 20 s with no sentence mark: words every 0.5 s, one 0.5 s gap at
        // word 9, and a comma (smaller gap, but the bonus wins) at word 19.
        let mut words = Vec::new();
        let mut t = 0.0;
        for i in 0..40 {
            let text = if i == 19 { "pause," } else { "word" };
            words.push(w(text, t, t + 0.45));
            t += if i == 9 {
                0.95
            } else if i == 19 {
                0.85
            } else {
                0.5
            };
        }
        let n = words.len();
        let s = segment_sentences(&words, &vec![0; n]);
        assert!(s.len() >= 2, "{s:?}");
        assert_eq!(s[0].last_word, 19, "split after the comma: {s:?}");
        assert_eq!(s[0].ending, Ending::Split);
        assert!(s.iter().all(|x| x.duration_secs() <= MAX_SENTENCE_S));
        // Every word is in exactly one sentence, in order.
        let mut next = 0;
        for x in &s {
            assert_eq!(x.first_word, next);
            next = x.last_word + 1;
        }
        assert_eq!(next, n);
    }
}

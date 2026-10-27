//! Evidence tags: the explainable facts about a sentence or a candidate that
//! the moment view shows a client and the Clipper panel shows a person (D-411
//! §3.2).
//!
//! **What they are.** Each [`Tag`] is one mechanical, checkable fact — "opens
//! with a question", "has a number", "ends on a full stop then a 1.2 s pause",
//! "spoken 1.3x faster than this speaker's median", "a picture cut inside".
//! Every list a tag is matched against is a closed list written out below.
//!
//! **What they are NOT: a score.** Owner decision (D-411, 2026-10-27): the MCP
//! client is the only judge. Nothing here adds tags up, weighs them or ranks
//! anything by them; they are evidence for whoever judges, and a person can
//! read every one of them back to the words that produced it.

use std::fmt;

use apelles_speech::{IndexedWord, is_stopword};
use serde::{Deserialize, Serialize};

use crate::evidence::{RetakeCut, SourceEvidence};
use crate::sentence::{Ending, SENTENCE_PAUSE_S, Sentence};
use crate::text::{has_number, is_number_word, token};

/// At most this many words, and a sentence is "short" — a hook a viewer takes
/// in at once (the design's `<= 12 words`).
pub const SHORT_SENTENCE_WORDS: usize = 12;

/// A pace this far from the speaker's median (as a ratio) is worth a tag.
pub const PACE_TAG_RATIO: f64 = 0.2;

/// The fewest words a pace is measured over: a one-word "Okay." has no pace.
pub const PACE_MIN_WORDS: usize = 5;

/// A loudness this far from the speaker's median, in dB, is worth a tag.
pub const LOUDNESS_TAG_DB: f64 = 3.0;

/// Second-person words: a line that speaks to the viewer.
const SECOND_PERSON: &[&str] = &[
    "you",
    "you'd",
    "you'll",
    "you're",
    "you've",
    "your",
    "yours",
    "yourself",
    "yourselves",
];

/// Contrast and stakes words: a line that sets up a turn or raises the stakes.
const CONTRAST: &[&str] = &[
    "actually",
    "best",
    "but",
    "except",
    "however",
    "instead",
    "mistake",
    "mistakes",
    "myth",
    "never",
    "nobody",
    "problem",
    "secret",
    "stop",
    "surprising",
    "truth",
    "worst",
    "wrong",
];

/// Openers that make a line an instruction to the viewer.
const IMPERATIVE_OPENERS: &[&str] = &[
    "consider", "don't", "forget", "here's", "imagine", "let's", "listen", "look", "notice",
    "picture", "remember", "stop", "think", "try", "watch",
];

/// Openers that lean on something said before the clip starts — a
/// conjunction, or a pronoun whose referent is outside the window.
const CONTEXT_OPENERS: &[&str] = &[
    "also", "and", "as", "because", "but", "he", "her", "him", "it", "it's", "its", "like", "or",
    "plus", "she", "so", "that", "that's", "them", "then", "there", "these", "they", "this",
    "those", "which",
];

/// One explainable fact.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Tag {
    /// Ends with a question mark.
    Question,
    /// Holds a number (digits, `%`, a currency sign or a spoken magnitude).
    Number { text: String },
    /// Speaks to the viewer ("you", "your", …).
    SecondPerson,
    /// A contrast or stakes word ("but", "never", "mistake", …).
    Contrast { word: String },
    /// Opens on an instruction ("imagine", "stop", "here's", …).
    Imperative { word: String },
    /// At most [`SHORT_SENTENCE_WORDS`] words.
    Short { words: usize },
    /// Opens on a word that leans on earlier context ("and", "so", "they", …).
    ContextOpen { word: String },
    /// Ends on a sentence-final mark followed by at least
    /// [`SENTENCE_PAUSE_S`] of silence (or the end of the piece).
    Lands { pause_secs: Option<f64> },
    /// Ends on a sentence-final mark, but the next sentence follows within
    /// [`SENTENCE_PAUSE_S`] — common in tightly edited or read voice-over.
    EndsTight { pause_secs: f64 },
    /// Does not end on a sentence-final mark: the thought runs on.
    RunsOn,
    /// Spoken at this ratio of the speaker's median words per second.
    Pace { ratio: f64 },
    /// This many dB above (or below) the speaker's median loudness.
    Loud { db: f64 },
    /// Picture cuts inside it.
    Scene { cuts: usize },
    /// Words shared with the person's focus prompt.
    Focus { hits: Vec<String> },
    /// Overlaps a reviewed retake's deleted take.
    Retake,
    /// Seconds of dead air and retakes a build would cut from it.
    Tightened { secs: f64 },
}

impl fmt::Display for Tag {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Question => write!(f, "question"),
            Self::Number { text } => write!(f, "number {text}"),
            Self::SecondPerson => write!(f, "you"),
            Self::Contrast { word } => write!(f, "contrast \"{word}\""),
            Self::Imperative { word } => write!(f, "imperative \"{word}\""),
            Self::Short { words } => write!(f, "short ({words}w)"),
            Self::ContextOpen { word } => write!(f, "needs context \"{word}\""),
            Self::Lands {
                pause_secs: Some(p),
            } => write!(f, "lands ({p:.1}s pause)"),
            Self::Lands { pause_secs: None } => write!(f, "lands (end)"),
            Self::EndsTight { pause_secs } => write!(f, "ends tight ({pause_secs:.1}s)"),
            Self::RunsOn => write!(f, "runs on"),
            Self::Pace { ratio } if *ratio >= 1.0 => write!(f, "fast {ratio:.1}x"),
            Self::Pace { ratio } => write!(f, "slow {ratio:.1}x"),
            Self::Loud { db } if *db >= 0.0 => write!(f, "loud +{db:.0}dB"),
            Self::Loud { db } => write!(f, "quiet {db:.0}dB"),
            Self::Scene { cuts } => write!(f, "picture cut x{cuts}"),
            Self::Focus { hits } => write!(f, "focus {}", hits.join("/")),
            Self::Retake => write!(f, "retake"),
            Self::Tightened { secs } => write!(f, "tightens {secs:.1}s"),
        }
    }
}

/// The speaker's medians the pace and loudness tags compare against.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SpeakerStats {
    /// Median words per second over sentences of at least a second.
    pub median_wps: f64,
    /// Median sentence loudness, dBFS, when a loudness pass exists.
    pub median_db: Option<f64>,
}

fn median(mut v: Vec<f64>) -> Option<f64> {
    if v.is_empty() {
        return None;
    }
    v.sort_by(f64::total_cmp);
    let m = v.len() / 2;
    Some(if v.len().is_multiple_of(2) {
        (v[m - 1] + v[m]) / 2.0
    } else {
        v[m]
    })
}

/// Words per second of a sentence (its words over its span).
pub fn words_per_second(s: &Sentence) -> Option<f64> {
    let d = s.duration_secs();
    (d >= 1.0).then(|| s.word_count() as f64 / d)
}

/// The medians over every sentence. `source_of_piece[p]` is piece `p`'s source.
pub fn speaker_stats(
    sentences: &[Sentence],
    evidence: &[SourceEvidence],
    source_of_piece: &[usize],
) -> SpeakerStats {
    let wps = median(sentences.iter().filter_map(words_per_second).collect()).unwrap_or(0.0);
    let db = median(
        sentences
            .iter()
            .filter_map(|s| sentence_db(s, evidence, source_of_piece))
            .collect(),
    );
    SpeakerStats {
        median_wps: wps,
        median_db: db,
    }
}

fn evidence_of<'a>(
    piece: usize,
    evidence: &'a [SourceEvidence],
    source_of_piece: &[usize],
) -> Option<&'a SourceEvidence> {
    source_of_piece.get(piece).and_then(|&s| evidence.get(s))
}

fn sentence_db(
    s: &Sentence,
    evidence: &[SourceEvidence],
    source_of_piece: &[usize],
) -> Option<f64> {
    evidence_of(s.piece, evidence, source_of_piece)?
        .loudness
        .as_ref()?
        .mean_db(s.start_secs, s.end_secs)
}

/// The content tokens of a focus prompt (lower-case, no stopwords, at least
/// three characters).
pub fn focus_terms(focus: &str) -> Vec<String> {
    let mut terms: Vec<String> = focus
        .split_whitespace()
        .map(token)
        .filter(|t| t.chars().count() >= 3 && !is_stopword(t))
        .collect();
    terms.sort();
    terms.dedup();
    terms
}

/// How a sentence opens: the opener facts a hook is judged on.
pub fn opener_tags(words: &[IndexedWord], s: &Sentence) -> Vec<Tag> {
    let toks: Vec<String> = words[s.first_word..=s.last_word]
        .iter()
        .map(|w| token(&w.text))
        .collect();
    let mut tags = Vec::new();
    if s.ending == Ending::Question {
        tags.push(Tag::Question);
    }
    if let Some(w) = words[s.first_word..=s.last_word]
        .iter()
        .find(|w| has_number(&w.text) || is_number_word(&token(&w.text)))
    {
        tags.push(Tag::Number {
            text: w
                .text
                .trim()
                .trim_end_matches(['.', ',', '?', '!'])
                .to_string(),
        });
    }
    if toks.iter().any(|t| SECOND_PERSON.contains(&t.as_str())) {
        tags.push(Tag::SecondPerson);
    }
    if let Some(t) = toks.iter().find(|t| CONTRAST.contains(&t.as_str())) {
        tags.push(Tag::Contrast { word: t.clone() });
    }
    if let Some(first) = toks.first() {
        if IMPERATIVE_OPENERS.contains(&first.as_str()) {
            tags.push(Tag::Imperative {
                word: first.clone(),
            });
        }
        if CONTEXT_OPENERS.contains(&first.as_str()) {
            tags.push(Tag::ContextOpen {
                word: first.clone(),
            });
        }
    }
    if s.word_count() <= SHORT_SENTENCE_WORDS {
        tags.push(Tag::Short {
            words: s.word_count(),
        });
    }
    tags
}

/// How a sentence ends: lands, ends tight, or runs on.
pub fn ending_tags(s: &Sentence) -> Vec<Tag> {
    if lands(s) {
        vec![Tag::Lands {
            pause_secs: s.pause_after_secs,
        }]
    } else if completes(s) {
        vec![Tag::EndsTight {
            pause_secs: s.pause_after_secs.unwrap_or(0.0),
        }]
    } else {
        vec![Tag::RunsOn]
    }
}

/// A sentence completes when it ends on a sentence-final mark (or ends its
/// piece) — a clean place for a clip to end, pause or not.
pub fn completes(s: &Sentence) -> bool {
    s.ending.is_terminal() || s.ending == Ending::PieceEnd
}

/// A sentence lands when it ends on a final mark (or ends its piece) and the
/// speaker then stops for at least [`SENTENCE_PAUSE_S`].
pub fn lands(s: &Sentence) -> bool {
    completes(s) && s.pause_after_secs.is_none_or(|p| p >= SENTENCE_PAUSE_S)
}

/// Does `[a, b)` of `source` overlap a reviewed retake cut.
pub fn overlaps_retake(cuts: &[RetakeCut], source: usize, a: f64, b: f64) -> bool {
    cuts.iter()
        .any(|c| c.source == source && c.start_secs < b && c.end_secs > a)
}

/// Every tag of one sentence.
#[allow(clippy::too_many_arguments)]
pub fn sentence_tags(
    words: &[IndexedWord],
    s: &Sentence,
    evidence: &[SourceEvidence],
    source_of_piece: &[usize],
    stats: &SpeakerStats,
    focus: &[String],
    retake_cuts: &[RetakeCut],
) -> Vec<Tag> {
    let mut tags = opener_tags(words, s);
    tags.extend(ending_tags(s));
    tags.extend(delivery_tags(
        words,
        &[s],
        evidence,
        source_of_piece,
        stats,
        focus,
    ));
    let source = source_of_piece.get(s.piece).copied().unwrap_or(0);
    if overlaps_retake(retake_cuts, source, s.start_secs, s.end_secs) {
        tags.push(Tag::Retake);
    }
    tags
}

/// Pace, loudness, picture cuts and focus hits over a run of sentences.
pub fn delivery_tags(
    words: &[IndexedWord],
    run: &[&Sentence],
    evidence: &[SourceEvidence],
    source_of_piece: &[usize],
    stats: &SpeakerStats,
    focus: &[String],
) -> Vec<Tag> {
    let mut tags = Vec::new();
    let spoken: f64 = run.iter().map(|s| s.duration_secs()).sum();
    let count: usize = run.iter().map(|s| s.word_count()).sum();
    if spoken >= 1.0 && count >= PACE_MIN_WORDS && stats.median_wps > 0.0 {
        let ratio = (count as f64 / spoken) / stats.median_wps;
        if (ratio - 1.0).abs() >= PACE_TAG_RATIO {
            tags.push(Tag::Pace {
                ratio: (ratio * 10.0).round() / 10.0,
            });
        }
    }
    if let Some(median_db) = stats.median_db {
        let dbs: Vec<f64> = run
            .iter()
            .filter_map(|s| sentence_db(s, evidence, source_of_piece))
            .collect();
        if !dbs.is_empty() {
            let mean = dbs.iter().sum::<f64>() / dbs.len() as f64;
            let delta = mean - median_db;
            if delta.abs() >= LOUDNESS_TAG_DB {
                tags.push(Tag::Loud { db: delta.round() });
            }
        }
    }
    let cuts: usize = run
        .iter()
        .filter_map(|s| {
            evidence_of(s.piece, evidence, source_of_piece)?.scene_cuts_in(s.start_secs, s.end_secs)
        })
        .sum();
    if cuts > 0 {
        tags.push(Tag::Scene { cuts });
    }
    if !focus.is_empty() {
        let mut hits: Vec<String> = run
            .iter()
            .flat_map(|s| words[s.first_word..=s.last_word].iter())
            .map(|w| token(&w.text))
            .filter(|t| focus.iter().any(|f| f == t))
            .collect();
        hits.sort();
        hits.dedup();
        if !hits.is_empty() {
            tags.push(Tag::Focus { hits });
        }
    }
    tags
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::evidence::Loudness;
    use crate::sentence::segment_sentences;

    fn words(line: &str, start: f64, step: f64) -> Vec<IndexedWord> {
        line.split_whitespace()
            .enumerate()
            .map(|(i, t)| IndexedWord {
                text: t.into(),
                start_secs: start + i as f64 * step,
                end_secs: start + i as f64 * step + step * 0.8,
                run: 0,
            })
            .collect()
    }

    #[test]
    fn a_hooky_opener_is_described_fact_by_fact() {
        let w = words(
            "Have you ever lost 80% of your customers in a month?",
            0.0,
            0.3,
        );
        let s = &segment_sentences(&w, &vec![0; w.len()])[0];
        let tags = opener_tags(&w, s);
        assert!(tags.contains(&Tag::Question));
        assert!(tags.contains(&Tag::SecondPerson));
        assert!(tags.contains(&Tag::Number { text: "80%".into() }));
        assert!(tags.contains(&Tag::Short { words: 11 }));
        assert!(!tags.iter().any(|t| matches!(t, Tag::ContextOpen { .. })));
    }

    #[test]
    fn a_context_dependent_opener_is_named() {
        let w = words("And that is why they left.", 0.0, 0.3);
        let s = &segment_sentences(&w, &vec![0; w.len()])[0];
        let tags = opener_tags(&w, s);
        assert!(tags.contains(&Tag::ContextOpen { word: "and".into() }));
        let w = words("Imagine never paying rent again.", 0.0, 0.3);
        let s = &segment_sentences(&w, &vec![0; w.len()])[0];
        let tags = opener_tags(&w, s);
        assert!(tags.contains(&Tag::Imperative {
            word: "imagine".into()
        }));
        assert!(tags.contains(&Tag::Contrast {
            word: "never".into()
        }));
    }

    #[test]
    fn landing_needs_a_mark_and_a_stop() {
        let mut w = words("That is the whole point.", 0.0, 0.3);
        w.extend(words("Next.", 3.0, 0.3));
        let s = segment_sentences(&w, &vec![0; w.len()]);
        assert!(lands(&s[0]));
        assert_eq!(
            ending_tags(&s[0]),
            vec![Tag::Lands {
                pause_secs: s[0].pause_after_secs
            }]
        );
        let mut w = words("That is the point.", 0.0, 0.3);
        w.extend(words("And more.", 1.25, 0.3));
        let s = segment_sentences(&w, &vec![0; w.len()]);
        assert!(!lands(&s[0]), "a 0.1 s gap is tight: {:?}", s[0]);
        assert!(completes(&s[0]));
        assert!(matches!(ending_tags(&s[0])[0], Tag::EndsTight { .. }));
        let w = words("and then we went", 0.0, 0.3);
        let mut more = w.clone();
        more.extend(words("on and on.", 1.3, 0.3));
        let s = segment_sentences(&more, &vec![0; more.len()]);
        assert_eq!(s.len(), 1, "no mark, no long pause: one sentence");
        let s = segment_sentences(&w, &vec![0; w.len()]);
        assert!(completes(&s[0]), "the end of a piece completes");
    }

    #[test]
    fn pace_loudness_scenes_and_focus_are_relative_and_optional() {
        let w = words("pricing pricing pricing pricing pricing pricing.", 0.0, 0.2);
        let s = segment_sentences(&w, &vec![0; w.len()]);
        let stats = SpeakerStats {
            median_wps: 2.5,
            median_db: Some(-30.0),
        };
        let ev = vec![SourceEvidence {
            speech: None,
            loudness: Some(Loudness {
                start_secs: 0.0,
                hop_secs: 0.1,
                db: vec![-24.0; 20],
            }),
            scene_cuts: Some(vec![0.5]),
        }];
        let tags = delivery_tags(
            &w,
            &[&s[0]],
            &ev,
            &[0],
            &stats,
            &focus_terms("the Pricing page"),
        );
        assert!(
            tags.iter()
                .any(|t| matches!(t, Tag::Pace { ratio } if *ratio > 1.0)),
            "{tags:?}"
        );
        assert!(tags.contains(&Tag::Loud { db: 6.0 }), "{tags:?}");
        assert!(tags.contains(&Tag::Scene { cuts: 1 }));
        assert!(tags.contains(&Tag::Focus {
            hits: vec!["pricing".into()]
        }));
        let none = delivery_tags(
            &w,
            &[&s[0]],
            &[SourceEvidence::default()],
            &[0],
            &stats,
            &[],
        );
        assert!(
            none.iter().all(|t| matches!(t, Tag::Pace { .. })),
            "{none:?}"
        );
    }

    #[test]
    fn tags_print_as_short_readable_facts() {
        assert_eq!(Tag::Pace { ratio: 1.3 }.to_string(), "fast 1.3x");
        assert_eq!(Tag::Loud { db: -4.0 }.to_string(), "quiet -4dB");
        assert_eq!(
            Tag::Lands {
                pause_secs: Some(1.24)
            }
            .to_string(),
            "lands (1.2s pause)"
        );
        assert_eq!(
            Tag::ContextOpen { word: "so".into() }.to_string(),
            "needs context \"so\""
        );
    }
}

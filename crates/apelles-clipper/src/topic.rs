//! Topics: where the subject changes, by TextTiling (Hearst 1997; D-411 §3.1).
//!
//! **What it is.** Lexical cohesion between the [`TILING_BLOCK`] sentences
//! either side of every sentence boundary (cosine of their content-word
//! counts), each boundary's *depth* — how far it sits below the peaks either
//! side — and the deepest boundaries kept as topic breaks, at least
//! [`MIN_TOPIC_SENTENCES`] apart. A long pause, a cut between pieces and a
//! picture cut at a boundary deepen it (`boundary_bonus`, computed by the
//! caller from the evidence it has).
//!
//! **What it is for.** Topics are evidence for the client ("this short spans
//! two subjects") and bound the deterministic candidate list: a candidate
//! never crosses a topic break. They are a hint, never a refusal — a client may
//! propose across one, and the gate only warns.
//!
//! **What it does NOT do.** No embeddings, no model, no meaning beyond shared
//! words; no dependency (the algorithm is a page of arithmetic).

use std::collections::BTreeMap;

use apelles_speech::{IndexedWord, is_stopword};
use serde::{Deserialize, Serialize};

use crate::sentence::Sentence;
use crate::text::token;

/// Sentences per side of each compared block (Hearst's block size, in
/// sentences rather than token windows: a sentence is already our unit).
pub const TILING_BLOCK: usize = 3;

/// The fewest sentences a topic may hold — about 30 s of talk, so a topic is
/// never shorter than the shortest short it bounds.
pub const MIN_TOPIC_SENTENCES: usize = 5;

/// A pause at least this long at a boundary deepens it by
/// [`PAUSE_DEPTH_BONUS`]: speakers stop between subjects.
pub const TOPIC_PAUSE_S: f64 = 1.5;
pub const PAUSE_DEPTH_BONUS: f64 = 0.1;
/// A picture cut within [`SCENE_NEAR_S`] of a boundary deepens it.
pub const SCENE_DEPTH_BONUS: f64 = 0.1;
pub const SCENE_NEAR_S: f64 = 1.0;
/// A boundary between two pieces (a cut in the long timeline) deepens it.
pub const PIECE_DEPTH_BONUS: f64 = 0.05;

/// The shallowest depth that can be a topic break at all, however the
/// distribution falls: uniform talk has small depths everywhere, and Hearst's
/// relative cutoff alone would still split it.
pub const MIN_TOPIC_DEPTH: f64 = 0.15;

/// How many keywords name a topic.
pub const TOPIC_KEYWORDS: usize = 3;

/// One topic: a run of sentences.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Topic {
    pub first_sentence: usize,
    pub last_sentence: usize,
    /// The most frequent content words (stemmed), most frequent first.
    pub keywords: Vec<String>,
    /// The depth of the boundary that opens it; 0 for the first topic.
    pub depth: f64,
}

/// A sentence's content words: tokens that are not stopwords, at least three
/// characters, not bare numbers, lightly stemmed (plural `s`/`ies`).
pub fn content_tokens(words: &[IndexedWord], s: &Sentence) -> Vec<String> {
    words[s.first_word..=s.last_word]
        .iter()
        .map(|w| stem(&token(&w.text)))
        .filter(|t| t.chars().count() >= 3 && !t.chars().all(|c| c.is_ascii_digit()))
        .filter(|t| !is_stopword(t))
        .collect()
}

fn stem(t: &str) -> String {
    if t.len() > 4 && t.ends_with("ies") {
        format!("{}y", &t[..t.len() - 3])
    } else if t.len() > 3 && t.ends_with('s') && !t.ends_with("ss") && !t.ends_with("'s") {
        t[..t.len() - 1].to_string()
    } else {
        t.trim_end_matches("'s").to_string()
    }
}

fn counts<'a>(sentences: impl Iterator<Item = &'a Vec<String>>) -> BTreeMap<&'a str, f64> {
    let mut m = BTreeMap::new();
    for toks in sentences {
        for t in toks {
            *m.entry(t.as_str()).or_insert(0.0) += 1.0;
        }
    }
    m
}

fn cosine(a: &BTreeMap<&str, f64>, b: &BTreeMap<&str, f64>) -> f64 {
    let dot: f64 = a.iter().filter_map(|(k, v)| b.get(k).map(|w| v * w)).sum();
    let na: f64 = a.values().map(|v| v * v).sum::<f64>().sqrt();
    let nb: f64 = b.values().map(|v| v * v).sum::<f64>().sqrt();
    if na == 0.0 || nb == 0.0 {
        0.0
    } else {
        dot / (na * nb)
    }
}

/// The cohesion depth at every boundary `b` (between sentence `b - 1` and
/// `b`), index `b - 1` in the result, including `boundary_bonus(b)`.
pub fn boundary_depths(tokens: &[Vec<String>], boundary_bonus: impl Fn(usize) -> f64) -> Vec<f64> {
    let n = tokens.len();
    if n < 2 {
        return Vec::new();
    }
    let scores: Vec<f64> = (1..n)
        .map(|b| {
            let left = counts(tokens[b.saturating_sub(TILING_BLOCK)..b].iter());
            let right = counts(tokens[b..(b + TILING_BLOCK).min(n)].iter());
            cosine(&left, &right)
        })
        .collect();
    (0..scores.len())
        .map(|g| {
            let s = scores[g];
            let mut l = g;
            while l > 0 && scores[l - 1] >= scores[l] {
                l -= 1;
            }
            let mut r = g;
            while r + 1 < scores.len() && scores[r + 1] >= scores[r] {
                r += 1;
            }
            (scores[l] - s) + (scores[r] - s) + boundary_bonus(g + 1)
        })
        .collect()
}

/// Topics over `sentences`. `boundary_bonus(b)` is the extra depth the
/// evidence gives the boundary before sentence `b`.
pub fn segment_topics(
    words: &[IndexedWord],
    sentences: &[Sentence],
    boundary_bonus: impl Fn(usize) -> f64,
) -> Vec<Topic> {
    let n = sentences.len();
    if n == 0 {
        return Vec::new();
    }
    let tokens: Vec<Vec<String>> = sentences.iter().map(|s| content_tokens(words, s)).collect();
    let mut breaks: Vec<(usize, f64)> = Vec::new();
    if n >= 2 * MIN_TOPIC_SENTENCES {
        let depths = boundary_depths(&tokens, boundary_bonus);
        let mean = depths.iter().sum::<f64>() / depths.len() as f64;
        let var = depths.iter().map(|d| (d - mean).powi(2)).sum::<f64>() / depths.len() as f64;
        let cutoff = (mean - var.sqrt() / 2.0).max(MIN_TOPIC_DEPTH);
        let mut ranked: Vec<(usize, f64)> = depths
            .iter()
            .enumerate()
            .map(|(g, &d)| (g + 1, d))
            .filter(|&(_, d)| d >= cutoff)
            .collect();
        ranked.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
        for (b, d) in ranked {
            let far_from_ends = b >= MIN_TOPIC_SENTENCES && n - b >= MIN_TOPIC_SENTENCES;
            let far_from_breaks = breaks
                .iter()
                .all(|&(k, _)| k.abs_diff(b) >= MIN_TOPIC_SENTENCES);
            if far_from_ends && far_from_breaks {
                breaks.push((b, d));
            }
        }
        breaks.sort_by_key(|&(b, _)| b);
    }

    let mut starts: Vec<(usize, f64)> = vec![(0, 0.0)];
    starts.extend(breaks);
    starts
        .iter()
        .enumerate()
        .map(|(i, &(first, depth))| {
            let last = starts.get(i + 1).map_or(n - 1, |&(next, _)| next - 1);
            let c = counts(tokens[first..=last].iter());
            let mut ranked: Vec<(&str, f64)> = c.into_iter().collect();
            ranked.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(b.0)));
            Topic {
                first_sentence: first,
                last_sentence: last,
                keywords: ranked
                    .into_iter()
                    .take(TOPIC_KEYWORDS)
                    .map(|(k, _)| k.to_string())
                    .collect(),
                depth,
            }
        })
        .collect()
}

/// `topic_of[s]`: the topic each sentence is in.
pub fn topic_of_sentence(topics: &[Topic], sentence_count: usize) -> Vec<usize> {
    let mut out = vec![0; sentence_count];
    for (t, topic) in topics.iter().enumerate() {
        for slot in out
            .iter_mut()
            .take(topic.last_sentence + 1)
            .skip(topic.first_sentence)
        {
            *slot = t;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sentence::segment_sentences;

    fn words_of(lines: &[&str]) -> Vec<IndexedWord> {
        let mut out = Vec::new();
        let mut t = 0.0;
        for line in lines {
            for word in line.split_whitespace() {
                out.push(IndexedWord {
                    text: word.into(),
                    start_secs: t,
                    end_secs: t + 0.3,
                    run: 0,
                });
                t += 0.35;
            }
            t += 0.3;
        }
        out
    }

    #[test]
    fn two_subjects_split_where_the_vocabulary_changes() {
        let a = [
            "Pricing decides churn for every customer.",
            "Customers churn when pricing feels unfair.",
            "Fair pricing keeps customers and stops churn.",
            "Annual pricing lowers churn for customers.",
            "Discounted pricing brings customers who churn.",
            "Pricing pages explain churn to customers.",
        ];
        let b = [
            "Hiring engineers takes patience and interviews.",
            "Interviews show which engineers can ship.",
            "Good engineers ask questions in interviews.",
            "Hiring slowly makes engineers stay longer.",
            "Interviews with engineers should be paid.",
            "Hiring engineers early shapes the culture.",
        ];
        let lines: Vec<&str> = a.iter().chain(b.iter()).copied().collect();
        let words = words_of(&lines);
        let sentences = segment_sentences(&words, &vec![0; words.len()]);
        assert_eq!(sentences.len(), 12);
        let topics = segment_topics(&words, &sentences, |_| 0.0);
        assert_eq!(topics.len(), 2, "{topics:?}");
        assert_eq!(topics[1].first_sentence, 6);
        assert_eq!(topics[0].keywords[0], "churn");
        assert!(
            topics[1].keywords.contains(&"engineer".to_string()),
            "{:?}",
            topics[1].keywords
        );
        let of = topic_of_sentence(&topics, 12);
        assert_eq!(of[5], 0);
        assert_eq!(of[6], 1);
    }

    #[test]
    fn short_or_uniform_talk_is_one_topic() {
        let lines = ["Pricing decides churn.", "Pricing again.", "Churn again."];
        let words = words_of(&lines);
        let sentences = segment_sentences(&words, &vec![0; words.len()]);
        let topics = segment_topics(&words, &sentences, |_| 0.0);
        assert_eq!(topics.len(), 1);
        assert_eq!((topics[0].first_sentence, topics[0].last_sentence), (0, 2));
        assert!(segment_topics(&[], &[], |_| 0.0).is_empty());
    }

    #[test]
    fn a_bonus_deepens_a_boundary() {
        let tokens: Vec<Vec<String>> = (0..8).map(|_| vec!["same".to_string()]).collect();
        let flat = boundary_depths(&tokens, |_| 0.0);
        assert!(flat.iter().all(|&d| d.abs() < 1e-9));
        let bumped = boundary_depths(&tokens, |b| if b == 4 { PAUSE_DEPTH_BONUS } else { 0.0 });
        assert!((bumped[3] - PAUSE_DEPTH_BONUS).abs() < 1e-9);
    }

    #[test]
    fn stemming_folds_plurals_only() {
        assert_eq!(stem("customers"), "customer");
        assert_eq!(stem("companies"), "company");
        assert_eq!(stem("class"), "class");
        assert_eq!(stem("bus"), "bus");
    }
}

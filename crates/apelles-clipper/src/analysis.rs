//! One analysis of a source: the word view in, sentences, topics, evidence
//! tags and candidates out, plus the gate context every proposal against it
//! is judged in.
//!
//! **What it is.** [`analyse`] is pure and fast (milliseconds for an hour of
//! talk: no model, no I/O), so the app re-runs it whenever an input moves — a
//! transcript window lands, the VAD finishes, a retake is reviewed — instead
//! of caching it. What a client cites (sentence numbers) depends only on the
//! words; everything the evidence adds is tags.
//!
//! **What it does NOT do.** Judge. See the crate doc.

use apelles_speech::{IndexedView, ViewPiece};

use crate::candidate::{Candidate, find_candidates};
use crate::evidence::{RetakeCut, SourceEvidence};
use crate::features::{SpeakerStats, Tag, focus_terms, sentence_tags, speaker_stats};
use crate::gate::{ALLOWED_DURATIONS, GateContext};
use crate::sentence::{Sentence, segment_sentences};
use crate::tighten::TightenOptions;
use crate::topic::{
    PAUSE_DEPTH_BONUS, PIECE_DEPTH_BONUS, SCENE_DEPTH_BONUS, SCENE_NEAR_S, TOPIC_PAUSE_S, Topic,
    segment_topics, topic_of_sentence,
};

/// What one analysis reads.
#[derive(Debug, Clone, Copy)]
pub struct AnalysisInput<'a> {
    /// The word view (`apelles_speech::index_pieces` over the source's clip
    /// windows).
    pub view: &'a IndexedView,
    /// The windows the view was indexed over, in play order.
    pub pieces: &'a [ViewPiece],
    /// Per source (the `source` a piece names); shorter = not measured.
    pub evidence: &'a [SourceEvidence],
    pub retake_cuts: &'a [RetakeCut],
    /// Target lengths, seconds — validated by [`check_durations`].
    pub durations: &'a [u32],
    pub focus: Option<&'a str>,
    pub tighten: TightenOptions,
}

/// Everything one analysis produced.
#[derive(Debug, Clone)]
pub struct Analysis {
    pub sentences: Vec<Sentence>,
    /// `sentence_of_word[w]`: the sentence word `w` is in.
    pub sentence_of_word: Vec<usize>,
    pub topics: Vec<Topic>,
    pub topic_of_sentence: Vec<usize>,
    /// One list per sentence.
    pub sentence_tags: Vec<Vec<Tag>>,
    pub candidates: Vec<Candidate>,
    pub stats: SpeakerStats,
    /// `source_of_piece[p]`: piece `p`'s source.
    pub source_of_piece: Vec<usize>,
    pub focus_terms: Vec<String>,
}

/// Validate a run's target lengths: at least one, each one of
/// [`ALLOWED_DURATIONS`]. Returned sorted and unique.
pub fn check_durations(durations: &[u32]) -> Result<Vec<u32>, String> {
    if durations.is_empty() {
        return Err(format!(
            "give at least one target length in seconds: {ALLOWED_DURATIONS:?}"
        ));
    }
    if let Some(bad) = durations.iter().find(|d| !ALLOWED_DURATIONS.contains(d)) {
        return Err(format!(
            "{bad} s is not a target length; choose from {ALLOWED_DURATIONS:?}"
        ));
    }
    let mut out = durations.to_vec();
    out.sort_unstable();
    out.dedup();
    Ok(out)
}

impl Analysis {
    /// The gate context for proposals against this analysis.
    pub fn gate<'a>(&'a self, input: &AnalysisInput<'a>) -> GateContext<'a> {
        GateContext {
            words: &input.view.words,
            piece_of_word: &input.view.piece_of_word,
            pieces: input.pieces,
            sentences: &self.sentences,
            sentence_of_word: &self.sentence_of_word,
            topic_of_sentence: &self.topic_of_sentence,
            evidence: input.evidence,
            retake_cuts: input.retake_cuts,
            durations: input.durations,
            tighten: input.tighten,
        }
    }

    /// Candidates starting at sentence `s`, in target order.
    pub fn candidates_from(&self, s: usize) -> impl Iterator<Item = &Candidate> {
        self.candidates
            .iter()
            .filter(move |c| c.first_sentence == s)
    }
}

/// Analyse a source.
pub fn analyse(input: &AnalysisInput<'_>) -> Analysis {
    let words = &input.view.words;
    let sentences = segment_sentences(words, &input.view.piece_of_word);
    let mut sentence_of_word = vec![0; words.len()];
    for (i, s) in sentences.iter().enumerate() {
        for slot in sentence_of_word
            .iter_mut()
            .take(s.last_word + 1)
            .skip(s.first_word)
        {
            *slot = i;
        }
    }
    let source_of_piece: Vec<usize> = input.pieces.iter().map(|p| p.source).collect();

    let bonus = |b: usize| -> f64 {
        let (Some(prev), Some(cur)) = (sentences.get(b.wrapping_sub(1)), sentences.get(b)) else {
            return 0.0;
        };
        let mut extra = 0.0;
        if cur.pause_before_secs.is_some_and(|p| p >= TOPIC_PAUSE_S) {
            extra += PAUSE_DEPTH_BONUS;
        }
        if prev.piece != cur.piece {
            extra += PIECE_DEPTH_BONUS;
        }
        let near_cut = source_of_piece
            .get(cur.piece)
            .and_then(|&s| input.evidence.get(s))
            .and_then(|e| e.scene_cuts.as_ref())
            .is_some_and(|cuts| {
                cuts.iter()
                    .any(|&t| (t - cur.start_secs).abs() <= SCENE_NEAR_S)
            });
        if near_cut {
            extra += SCENE_DEPTH_BONUS;
        }
        extra
    };
    let topics = segment_topics(words, &sentences, bonus);
    let topic_of_sentence = topic_of_sentence(&topics, sentences.len());
    let stats = speaker_stats(&sentences, input.evidence, &source_of_piece);
    let focus = input.focus.map(focus_terms).unwrap_or_default();
    let sentence_tags = sentences
        .iter()
        .map(|s| {
            sentence_tags(
                words,
                s,
                input.evidence,
                &source_of_piece,
                &stats,
                &focus,
                input.retake_cuts,
            )
        })
        .collect();

    let mut analysis = Analysis {
        sentences,
        sentence_of_word,
        topics,
        topic_of_sentence,
        sentence_tags,
        candidates: Vec::new(),
        stats,
        source_of_piece,
        focus_terms: focus,
    };
    let candidates = {
        let ctx = analysis.gate(input);
        find_candidates(
            &ctx,
            input.durations,
            input.evidence,
            &analysis.source_of_piece,
            &analysis.stats,
            &analysis.focus_terms,
        )
    };
    analysis.candidates = candidates;
    analysis
}

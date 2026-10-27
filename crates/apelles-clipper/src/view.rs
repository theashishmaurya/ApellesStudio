//! The moment view: what an MCP client reads to judge a source, and the
//! judging rules served with it (D-411 §3.5, Phase 2).
//!
//! **What it is.** One numbered line per sentence — `S<n>`, its start-end
//! seconds, its evidence tags, its text — with `=== topic` lines where the
//! subject changes and, under a sentence, the clean endings a short starting
//! there can have for each target length (the candidates, as hints). Served in
//! pages of sentences ([`render_page`]); indices are global, so a client that
//! reads it in pages cites the same numbers as one that reads it whole.
//!
//! **The served rules.** [`JUDGING_RULES`] is the prompt the client judges
//! by, served by the app on page 0 — one place, versioned
//! ([`JUDGING_RULES_VERSION`]), never copied into the skill — the way D-380
//! serves the retake rules. Unlike those, these are **not yet measured**
//! against owner labels (D-411 §11 "blind client runs scored against owner
//! labels" is the follow-up); the version moves whenever the text does.
//!
//! **Identity.** [`render_identity`] is the text the app hashes into the
//! view id: sentence numbers, times, pieces and words — what a citation
//! means. Tags, topics and candidates are evidence that may sharpen as audio
//! passes finish, so they are deliberately outside it: a client's proposal
//! stays valid while the VAD lands.

use std::fmt::Write as _;

use crate::analysis::Analysis;

/// Sentences per page when the caller does not say: an hour of talk is ~700
/// sentences, and a line with tags and its endings is ~40-60 tokens, so 300 is
/// ~15k tokens — inside an MCP client's tool-output cap with headroom.
pub const DEFAULT_PAGE_SENTENCES: usize = 300;
/// The most sentences one page may hold, whatever is asked.
pub const MAX_PAGE_SENTENCES: usize = 600;

/// Bumped whenever [`JUDGING_RULES`] changes, so a stored proposal records
/// which rules it was judged under.
pub const JUDGING_RULES_VERSION: u32 = 1;

/// The legend printed above page 0.
pub const MOMENT_VIEW_LEGEND: &str = "# Moment view: one line per sentence of the source. Cite sentences by number (S12 = 12).\n\
# Line: S<n>  start-end seconds of its source  [evidence tags]  the words. 'clip <k>' names the clip window of a timeline source.\n\
# '=== topic' lines mark where the subject changes (lexical cohesion; a hint). 'ends:' under a sentence lists clean endings for a short starting there, per target length, with its length after dead air is removed.\n\
# Tags are measured facts, not a score: read the words.\n\
\n";

/// How the client judges. Served on page 0 as `instructions`.
pub const JUDGING_RULES: &str = "You are choosing short vertical clips (Reels, Shorts, TikTok) from one long recording, for a person who will review them before anything is published. The moment view numbers every sentence; the app has measured evidence tags for each, but which moments are worth a short is your judgement.\n\
\n\
A good short:\n\
1. Opens on a hook in its first sentence or two: a question, a surprising number, a bold or contrarian claim, stakes, or a line spoken straight to the viewer. If the strongest line sits later in the same moment, you may play it first as a hook (whole sentences, at most 3 and 8 seconds); the body then plays from its own start.\n\
2. Stands alone: a viewer who has seen nothing else understands it. Do not open on a sentence that leans on earlier context (\"And...\", \"So that's why...\", \"He said...\") unless the clip itself supplies that context.\n\
3. Is one idea that pays off: it ends on the answer, the punchline, the conclusion or the lesson. Never end mid-thought or on a question the clip does not answer.\n\
4. Fits one of the requested target lengths after dead air is removed. The 'ends:' hints list clean endings per target; you may choose any sentence range, and the app checks it.\n\
5. Has substance: a story, a specific example, a number, a strong opinion. Skip introductions, housekeeping, sponsor reads and sign-offs.\n\
\n\
Across the set: spread the picks over the recording and its topics, and do not propose two shorts of the same moment. When unsure, leave a moment out; fewer strong shorts beat many weak ones.\n\
\n\
For each short give: its segments as sentence ranges {first, last} (inclusive, in play order; usually one range), an optional hook range, a title of at most 60 characters that the clip delivers (no clickbait), a one-line reason a person can check against the words, and the hook line quoted from the transcript. Never write words the speaker did not say.\n";

/// The text the view id hashes: one line per sentence — number, piece,
/// times, words. See the module doc for what is left out and why.
pub fn render_identity(a: &Analysis) -> String {
    let mut out = String::new();
    for (i, s) in a.sentences.iter().enumerate() {
        let _ = writeln!(
            out,
            "{i}\t{}\t{:.2}-{:.2}\t{}",
            s.piece, s.start_secs, s.end_secs, s.text
        );
    }
    out
}

/// One sentence's line (and its endings line, when it has candidates).
fn render_sentence(a: &Analysis, i: usize, pieces: usize, out: &mut String) {
    let Some(s) = a.sentences.get(i) else {
        return;
    };
    let tags = a
        .sentence_tags
        .get(i)
        .map(|t| {
            t.iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join(" · ")
        })
        .unwrap_or_default();
    let clip = if pieces > 1 {
        format!("  clip {}", s.piece)
    } else {
        String::new()
    };
    let _ = writeln!(
        out,
        "S{i}  {:.2}-{:.2}{clip}  [{tags}]  {}",
        s.start_secs, s.end_secs, s.text
    );
    let ends: Vec<String> = a
        .candidates_from(i)
        .map(|c| {
            format!(
                "{}s→S{} ({:.1}s)",
                c.target_secs, c.last_sentence, c.tight_secs
            )
        })
        .collect();
    if !ends.is_empty() {
        let _ = writeln!(out, "    ends: {}", ends.join(" · "));
    }
}

fn render_topic(a: &Analysis, t: usize, out: &mut String) {
    let Some(topic) = a.topics.get(t) else {
        return;
    };
    let span = match (
        a.sentences.get(topic.first_sentence),
        a.sentences.get(topic.last_sentence),
    ) {
        (Some(f), Some(l)) => {
            format!("S{}-S{}", topic.first_sentence, topic.last_sentence)
                + &format!("  {:.2}-{:.2}", f.start_secs, l.end_secs)
        }
        _ => String::new(),
    };
    let _ = writeln!(out, "=== topic {t}  {span}  {}", topic.keywords.join(", "));
}

/// A page of the view: sentences `from..to` (clamped). The legend is printed
/// only on a page starting at sentence 0; a page always opens with the topic
/// line of its first sentence, so a page starting mid-topic repeats it once.
/// `pieces` is how many clip windows the source has (a clip label is shown
/// only when there are several).
pub fn render_page(a: &Analysis, from: usize, to: usize, pieces: usize) -> String {
    let to = to.min(a.sentences.len());
    let mut out = if from == 0 {
        String::from(MOMENT_VIEW_LEGEND)
    } else {
        String::new()
    };
    let mut current: Option<usize> = None;
    for i in from..to {
        let t = a.topic_of_sentence.get(i).copied().unwrap_or(0);
        if current != Some(t) {
            render_topic(a, t, &mut out);
            current = Some(t);
        }
        render_sentence(a, i, pieces, &mut out);
    }
    out
}

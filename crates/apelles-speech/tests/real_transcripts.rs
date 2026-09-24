//! The retake detector over WHOLE real transcripts — the false-positive
//! measurement that justifies the phrase signal's default (D-365).
//!
//! **Why this tier exists, and why it is not `#[ignore]`d.** `retake.rs`'s own
//! unit tests prove the algorithm does what it says on fixtures with
//! known-correct answers, and they pin each real retake case individually.
//! Neither can answer the question that actually decides whether a *looser*
//! second signal may ship on by default: **how often does it fire on ordinary
//! spoken English that nobody would want cut?**
//!
//! Answering that needs real transcripts at full length — a curated handful of
//! utterances proves nothing about a signal whose whole risk is incidental
//! repetition across hundreds of pairs. So both fixtures here are the real,
//! verbatim, whole-file output of `ai-media/transcribe.py` (mlx-whisper
//! large-v3) on two of the owner's own camera originals, read back through
//! `editor_get_transcript`. They need no model, no audio and no network — they
//! are plain JSON — so unlike [`dark_live`] and [`silero_live`] this one runs
//! in an ordinary `cargo test`.
//!
//! | fixture | segments | duration | what it is |
//! |---|---|---|---|
//! | `A001_09122319_C038.json` | 121 | 987 s | the inference-cost explainer; the footage behind B-237 and D-365 |
//! | `A001_09122356_C040.json` | 66 | 684 s | the attention/self-attention explainer; the footage behind B-198 and D-327 |
//!
//! Both are single-speaker talking heads on one technical subject each —
//! deliberately the hardest possible negative material for a repetition
//! signal, because a 16-minute video *about* inference says "inference",
//! "model", "training" and "cost" constantly, and a repetition detector that
//! cannot tell topic vocabulary from a stumble would light up on every pair.
//!
//! **What these tests assert is a measurement, not a preference.** The counts
//! below are exact and will move if the signal's tuning moves — that is the
//! point. A change that makes them move is a change to the detector's real
//! false-positive rate on real speech, and should be looked at rather than
//! re-baselined reflexively.
//!
//! [`dark_live`]: ../dark_live.rs
//! [`silero_live`]: ../silero_live.rs

use apelles_speech::retake::{RetakeParams, Utterance, detect_retakes, normalise, similarity};
use apelles_speech::{PhraseParams, is_phrase_repeat};

/// One fixture transcript: `[start_secs, end_secs, text]` per segment, exactly
/// as whisper segmented it.
fn load(name: &str) -> Vec<Utterance> {
    let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("reading {path}: {e}"));
    let rows: Vec<(f64, f64, String)> =
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parsing {path}: {e}"));
    rows.into_iter()
        .enumerate()
        .map(|(index, (start_secs, end_secs, text))| Utterance {
            index,
            start_secs,
            end_secs,
            text,
        })
        .collect()
}

/// Every pair of utterances the phrase signal admits **and** the existing
/// edit-distance signal does not, inside the detector's own time window.
///
/// This is the set that matters for the decision in D-365: pairs the old
/// detector was silent about and the new arm speaks up for. Everything it
/// contains is either a real retake the tool previously missed, or a false
/// positive — there is no third category, which is what makes the list short
/// enough to classify by hand and pin.
fn new_admissions(u: &[Utterance], p: &RetakeParams) -> Vec<(usize, usize)> {
    let n: Vec<String> = u.iter().map(|x| normalise(&x.text)).collect();
    let phrase = PhraseParams {
        min_words: p.phrase_min_words,
    };
    let mut out = Vec::new();
    for i in 0..u.len() {
        for j in (i + 1)..u.len() {
            if u[j].start_secs - u[i].end_secs > p.window_secs {
                break;
            }
            if similarity(&n[i], &n[j]) < p.similarity && is_phrase_repeat(&n[i], &n[j], &phrase) {
                out.push((i, j));
            }
        }
    }
    out
}

/// How many utterance pairs fall inside the time window at all — the
/// denominator the counts below are a rate over.
fn pairs_in_window(u: &[Utterance], window_secs: f64) -> usize {
    let mut n = 0;
    for i in 0..u.len() {
        for j in (i + 1)..u.len() {
            if u[j].start_secs - u[i].end_secs > window_secs {
                break;
            }
            n += 1;
        }
    }
    n
}

/// **C038 — 121 real segments, 987 s, and not one false positive.**
///
/// Every pair the phrase arm newly admits here was checked by hand against the
/// transcript text and is a genuine self-correction the tool used to miss:
/// the technical-term stumble at #94/#95 that B-237 recorded as an open limit,
/// the "enormous amount of work" restart, "the real reason it's this
/// expensive", "grog doesn't build", "inference is everything", "so quick
/// recap", the outro's triple "not just what it can do", and the rest.
///
/// The exact pair list is pinned rather than just the count, because a count
/// alone would let one real catch be silently swapped for one false positive.
#[test]
fn the_phrase_signal_finds_only_real_retakes_in_c038() {
    let u = load("A001_09122319_C038.json");
    let p = RetakeParams::default();
    assert_eq!(u.len(), 121, "the fixture is the whole file");

    let got = new_admissions(&u, &p);

    // Hand-classified against the transcript. Every entry is a real retake.
    let expected: &[(usize, usize)] = &[
        (3, 4),     // "grog doesn't build" — a clipped false start
        (41, 42),   // "Inference is everything that it's…" → "…after that."
        (41, 44),   // …and its third delivery
        (43, 45),   // "the model actually being used" / "the model being actually used"
        (56, 57),   // "the real reason it's this expensive"
        (56, 58),   // …and the delivery that finally lands
        (67, 68),   // "an enormous amount of … work happening"
        (68, 69),   // …and its second repair
        (94, 95),   // the speculative-decoding stumble — B-237's eighth case
        (105, 106), // "So quick recap," restarted
        (117, 118), // the outro: "and subscribe if you want more of this"
        (117, 119), // "the actual economy and mechanics"
        (118, 119), // "not just what it can do", second delivery
        (118, 120), // …third
        (119, 120), // …fourth
    ];
    assert_eq!(
        got, expected,
        "the phrase arm's new admissions on C038 must be exactly the \
         hand-classified real retakes"
    );

    let total = pairs_in_window(&u, p.window_secs);
    assert_eq!(total, 483, "the denominator these 15 are a rate over");
}

/// **C040 — 66 real segments, 684 s, and the one measured false positive.**
///
/// This is the honest half of D-365 and the reason the decision records a
/// tradeoff rather than a win. Pair **(30, 32)** is *not* a retake:
///
/// ```text
///   #30  "Every word turns itself into a question."
///   #32  "Every other word turns itself into a kind of answer key
///         advertising what it's about."
/// ```
///
/// Two deliberate, contrasting sentences — the query/key metaphor, built on
/// purpose out of parallel phrasing — sharing the verbatim run "word turns
/// itself into a". Structurally that is indistinguishable from a repair: a
/// long verbatim frame around a changed pivot. No threshold on run length or
/// content-word count separated it from the real repairs without also losing
/// several of them (`docs/notes/retake-detection.md` §5 has the combinations
/// tried), so it is accepted, pinned here, and disclosed in D-365 rather than
/// tuned away by shrinking the signal until it stopped being useful.
///
/// It is survivable because the detector only ever **proposes** (D-318): a
/// human or agent sees this group, reads two sentences that are plainly not
/// the same line, and leaves it. `phrase_min_words: 0` turns the arm off for
/// anyone who would rather not see it at all.
#[test]
fn the_one_measured_false_positive_is_this_one() {
    let u = load("A001_09122356_C040.json");
    let p = RetakeParams::default();
    assert_eq!(u.len(), 66);

    let got = new_admissions(&u, &p);

    let expected: &[(usize, usize)] = &[
        (24, 25), // "you're not just looking at the last message" restarted
        (25, 26), // …again
        (25, 27), // "the last 10 to figure out who's actually being asked"
        (27, 28), // "Self-attention is the model doing that for…"
        (30, 32), // ← THE FALSE POSITIVE. See this test's doc comment.
        (35, 36), // "that's the real computation underneath checking in"
        (55, 57), // "So, quick recap." restarted
    ];
    assert_eq!(got, expected);

    assert!(
        got.contains(&(30, 32)),
        "the known false positive must stay visible in this list — if a future \
         change removes it, that is a real improvement and this test should be \
         updated deliberately"
    );

    let total = pairs_in_window(&u, p.window_secs);
    assert_eq!(total, 215);
}

/// The headline rate, stated in one place so it can be quoted without being
/// re-derived: **across both real transcripts — 698 pairs of genuine spoken
/// English, 1,671 seconds, two videos — the phrase arm newly admits 22 pairs,
/// of which 21 are real retakes the tool previously missed and 1 is a false
/// positive.**
#[test]
fn the_combined_false_positive_rate_across_both_real_transcripts() {
    let p = RetakeParams::default();
    let c038 = load("A001_09122319_C038.json");
    let c040 = load("A001_09122356_C040.json");

    let pairs = pairs_in_window(&c038, p.window_secs) + pairs_in_window(&c040, p.window_secs);
    let admitted = new_admissions(&c038, &p).len() + new_admissions(&c040, &p).len();

    assert_eq!(pairs, 698);
    assert_eq!(admitted, 22);
    // 21 real, 1 false positive — itemised by the two tests above.
}

/// Turning the arm off returns **exactly** the pre-D-365 detector on both real
/// transcripts — the property that makes this change safe to land on by
/// default, and the escape hatch real.
#[test]
fn disabling_the_phrase_signal_restores_the_old_detector_exactly() {
    let off = RetakeParams {
        phrase_min_words: 0,
        ..RetakeParams::default()
    };
    for name in ["A001_09122319_C038.json", "A001_09122356_C040.json"] {
        let u = load(name);
        assert!(
            new_admissions(&u, &off).is_empty(),
            "{name}: phrase_min_words 0 must admit nothing"
        );
    }
}

/// The whole-transcript run, end to end — the shape the app actually calls
/// since D-364 merged a clip run back into one utterance list.
///
/// Asserts the properties every consumer depends on hold over real data at
/// full length, not just on the crafted unit fixtures: takes tile their
/// members, the recommended keep is in range, and no group is a single
/// delivery. Also records the real before/after group counts.
#[test]
fn whole_transcript_runs_stay_well_formed_with_the_phrase_signal_on() {
    let p = RetakeParams::default();
    let off = RetakeParams {
        phrase_min_words: 0,
        ..p
    };

    for (name, before, after) in [
        ("A001_09122319_C038.json", 5, 11),
        ("A001_09122356_C040.json", 7, 11),
    ] {
        let u = load(name);
        assert_eq!(
            detect_retakes(&u, &off).len(),
            before,
            "{name}: groups found by the pre-D-365 detector"
        );

        let groups = detect_retakes(&u, &p);
        assert_eq!(
            groups.len(),
            after,
            "{name}: groups found with both signals"
        );

        for g in &groups {
            assert!(g.takes.len() >= 2, "{name}: one delivery is not a retake");
            assert!(g.keep < g.takes.len(), "{name}: keep must index a take");
            let mut next = 0;
            for t in &g.takes {
                assert_eq!(t.first, next, "{name}: takes must tile without gaps");
                assert!(t.last >= t.first);
                next = t.last + 1;
            }
            assert_eq!(
                next,
                g.members.len(),
                "{name}: takes must cover every member"
            );
        }
    }
}

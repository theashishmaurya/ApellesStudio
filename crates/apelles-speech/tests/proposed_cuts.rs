//! **The B-238 audit, over every raw source that actually contains speech, on
//! both ASR backends** (D-377). The question is not "does the detector find the
//! retakes?" — `real_transcripts.rs` and `retake.rs`'s own unit tests answer
//! that. It is the one B-238 survived two rounds of being declared fixed by
//! dodging: **does `detect_retakes` ever propose cutting speech that repeats
//! nothing?**
//!
//! **It does, and this file is where that is measured** (B-246). The method is
//! D-366's own, reused rather than reinvented
//! (`docs/notes/retake-detection.md` §6): for every member of every non-kept
//! take, score [`word_overlap`] of its own vocabulary against the union of the
//! take the group recommends keeping. Below [`MIN_UTTERANCE_OVERLAP`] the
//! material being cut is absent from what survives. D-366 verified exactly this
//! property — `retake::tests::nothing_proposed_for_deletion_is_unique_content`
//! — but only over two hand-picked excerpt fixtures. Run over whole real
//! transcripts it fails, on **both** backends.
//!
//! Two classes, told apart because they need different fixes:
//!
//! | | `word_overlap` vs the keeper | vs the union of the other takes | what it is |
//! |---|---|---|---|
//! | **straddled** | < 0.5 | ≥ 0.5 | the speech repeats *another discarded take*, not the keeper: the ASR's segment boundary fell mid-repetition. Accepting the group still loses it |
//! | **unique content** | < 0.5 | < 0.5 | **B-238 itself, unfixed.** The speech repeats nothing in its own group |
//!
//! Every "unique content" case measured is a **single-utterance take**, which is
//! the hole: `anchor_is_justified`'s guard applies to *glued* spans only, and
//! `MIN_UTTERANCE_OVERLAP`'s own doc says single-utterance takes are "judged by
//! [`similarity`] alone, as they always were". `similarity` is
//! containment-maximising, so an utterance whose tail matches is admitted whole,
//! and the longer the utterance the more unrelated speech rides along.
//!
//! [`similarity`]: apelles_speech::retake::similarity
//!
//! **Three speech sources, not twelve, and that distinction is the point.** All
//! twelve of the owner's raw camera originals were transcribed with both
//! backends. Nine are silent B-roll — room tone at −47 to −65 dBFS mean with the
//! camera rolling — and a source with no speech cannot have a cut proposed
//! against it, so it passes this audit vacuously. A green number that measured
//! nothing is exactly how B-238 kept surviving, so those nine are kept separate,
//! in [`the_silent_sources_are_not_a_test_of_the_cut`], which asserts the one
//! non-vacuous thing they do say.
//!
//! | source | duration | mean dBFS | in the corpus before? |
//! |---|---|---|---|
//! | `A001_08302215_C019` | 517 s | −18.4 | **no — new in D-377** |
//! | `A001_09122319_C038` | 989 s | −25.1 | yes (D-365, B-237) |
//! | `A001_09122356_C040` | 686 s | −25.5 | yes (D-327, B-198, B-238) |
//!
//! **C019 is the whole value of the widening**: 517 s of real speech, the
//! loudest of all twelve, which the detector had never been pointed at — four
//! sessions of tuning (B-237, B-238, D-365, D-366) were fitted to the other two,
//! and it is the only source where *Whisper* over-claims too.
//!
//! Both backends run over all three so the comparison is like-for-like:
//! `.whisper.json` is `mlx-whisper large-v3`, `.parakeet.json` is
//! `parakeet-tdt-0.6b-v3` through `transcribe(..., backend="parakeet")`
//! (D-374). For the two corpus sources the Whisper half of the headline is the
//! *already committed* fixtures `real_transcripts.rs` pins — deliberately not
//! replaced, so Whisper's measured behaviour cannot move under this pass — and
//! a re-derived-today transcript of each is committed beside them and audited
//! separately, by
//! [`whisper_re_derived_today_also_proposes_nothing_that_repeats_nothing`].
//!
//! No model, no audio, no network: every fixture is plain JSON.

mod common;

use apelles_speech::retake::{MIN_UTTERANCE_OVERLAP, normalise, word_overlap};
use apelles_speech::{RetakeParams, Utterance, detect_retakes};
use common::load;

/// One raw source with speech on it, and where each backend's transcript lives.
struct Source {
    name: &'static str,
    /// Source duration in seconds, from `ffprobe`. Context for the cut seconds.
    duration_secs: f64,
    /// The two corpus sources point at the fixtures `real_transcripts.rs`
    /// already pins, at their original paths.
    whisper: &'static str,
    parakeet: &'static str,
}

const SPEECH: &[Source] = &[
    Source {
        name: "C019",
        duration_secs: 517.1,
        whisper: "transcripts/A001_08302215_C019.whisper.json",
        parakeet: "transcripts/A001_08302215_C019.parakeet.json",
    },
    Source {
        name: "C038",
        duration_secs: 989.5,
        whisper: "A001_09122319_C038.json",
        parakeet: "transcripts/A001_09122319_C038.parakeet.json",
    },
    Source {
        name: "C040",
        duration_secs: 686.0,
        whisper: "A001_09122356_C040.json",
        parakeet: "transcripts/A001_09122356_C040.parakeet.json",
    },
];

/// The nine silent B-roll sources. Committed because of what the *Whisper* half
/// of them says, not because they test the cut.
const SILENT: &[&str] = &[
    "A001_09091122_C023",
    "A001_09091123_C024",
    "A001_09091128_C025",
    "A001_09091129_C026",
    "A001_09091135_C027",
    "A001_09091139_C028",
    "A001_09091140_C029",
    "A001_09091143_C030",
    "A001_09091146_C031",
];

/// One utterance a group proposes to cut, scored both ways.
struct Cut {
    index: usize,
    secs: f64,
    /// Overlap against the take the group recommends keeping.
    vs_keeper: f64,
    /// Overlap against the union of the *other* takes — what
    /// `anchor_is_justified` itself compares against.
    vs_others: f64,
    text: String,
}

/// Every utterance a group proposes to cut. One place, so the table and the
/// pinned defect list are measuring the same thing and cannot drift.
fn proposed_cuts(u: &[Utterance], p: &RetakeParams) -> Vec<Cut> {
    let mut out = Vec::new();
    for g in detect_retakes(u, p) {
        let union = |span: &[usize]| -> String {
            span.iter()
                .map(|&m| normalise(&g.members[m].text))
                .collect::<Vec<_>>()
                .join(" ")
        };
        let keeper = g.takes[g.keep];
        let kept = union(&(keeper.first..=keeper.last).collect::<Vec<_>>());
        for (ti, t) in g.takes.iter().enumerate() {
            if ti == g.keep {
                continue;
            }
            let others = union(
                &g.takes
                    .iter()
                    .enumerate()
                    .filter(|(oi, _)| *oi != ti)
                    .flat_map(|(_, o)| o.first..=o.last)
                    .collect::<Vec<_>>(),
            );
            for m in t.first..=t.last {
                let member = &g.members[m];
                let text = normalise(&member.text);
                out.push(Cut {
                    index: member.index,
                    secs: member.end_secs - member.start_secs,
                    vs_keeper: word_overlap(&text, &kept),
                    vs_others: word_overlap(&text, &others),
                    text: member.text.clone(),
                });
            }
        }
    }
    out
}

/// What one whole-transcript run proposes, and how much of it repeats nothing.
#[derive(Debug, Default, PartialEq)]
struct Audit {
    segments: usize,
    groups: usize,
    /// Utterances inside a non-kept take — what a reviewer is offered for
    /// deletion.
    cut_utterances: usize,
    cut_secs: f64,
    /// Of those, absent from the keeper: the straddled class plus the unique
    /// one.
    absent_utterances: usize,
    absent_secs: f64,
    /// Of *those*, absent from every other take too. **This is the verdict
    /// column** — B-238's own defect, in seconds.
    unique_utterances: usize,
    unique_secs: f64,
}

fn audit(u: &[Utterance], p: &RetakeParams) -> Audit {
    let mut a = Audit {
        segments: u.len(),
        groups: detect_retakes(u, p).len(),
        ..Audit::default()
    };
    for c in proposed_cuts(u, p) {
        a.cut_utterances += 1;
        a.cut_secs += c.secs;
        if c.vs_keeper < MIN_UTTERANCE_OVERLAP {
            a.absent_utterances += 1;
            a.absent_secs += c.secs;
            if c.vs_others < MIN_UTTERANCE_OVERLAP {
                a.unique_utterances += 1;
                a.unique_secs += c.secs;
            }
        }
    }
    a
}

/// One pinned row of the audit: `(source, backend, segments, groups, cut
/// utterances, cut secs, absent utterances, absent secs, unique utterances,
/// unique secs)`.
type Row = (
    &'static str,
    &'static str,
    usize,
    usize,
    usize,
    f64,
    usize,
    f64,
    usize,
    f64,
);

/// Measured 2026-10-10 (D-377) at `RetakeParams::default()`.
const PINNED: &[Row] = &[
    ("C019", "whisper", 83, 7, 9, 56.32, 3, 18.14, 1, 5.42),
    ("C019", "parakeet", 45, 7, 9, 44.24, 2, 27.20, 2, 27.20),
    ("C038", "whisper", 121, 11, 14, 82.78, 4, 27.44, 0, 0.00),
    ("C038", "parakeet", 87, 10, 14, 82.28, 2, 25.88, 2, 25.88),
    ("C040", "whisper", 66, 7, 15, 98.78, 7, 43.82, 0, 0.00),
    ("C040", "parakeet", 58, 10, 16, 91.84, 1, 3.84, 1, 3.84),
];

/// **The per-source audit, pinned — and the number the backend decision turned
/// on.**
///
/// Summed over the three speech sources (2,192.6 s of footage):
///
/// | | groups | proposed | absent from the keeper | **repeats nothing** |
/// |---|---|---|---|---|
/// | mlx-whisper large-v3 | 25 | 237.88 s | 89.40 s | **5.42 s** (1 utterance) |
/// | parakeet-tdt-0.6b-v3 | 27 | 218.36 s | 56.92 s | **56.92 s** (5 utterances) |
///
/// Parakeet proposes *less* in total and straddles *less*, and it is still
/// **10.5× worse on the one column that matters** — 26 % of everything it
/// offers for deletion repeats nothing at all, against Whisper's 2.3 %. The
/// cause is segment length, not transcription quality: a take is a range of
/// whole utterances (`docs/notes/retake-detection.md` §2), and Parakeet's mean
/// segment is 11.4-11.8 s against Whisper's 6.2-10.4 s, so each over-claimed cut
/// carries proportionally more unrelated speech. **That is why Whisper stays the
/// default (D-377).**
///
/// Exact, as `real_transcripts.rs`'s numbers are and for the same reason: a
/// count alone would let one real catch be silently swapped for one false
/// positive. These move only when the detector's real behaviour on real speech
/// moves, which is a thing to look at rather than re-baseline.
#[test]
fn the_per_source_audit_is_this() {
    let p = RetakeParams::default();
    let mut i = 0;
    let mut totals = [Audit::default(), Audit::default()];
    for s in SPEECH {
        for (bi, (backend, path)) in [("whisper", s.whisper), ("parakeet", s.parakeet)]
            .into_iter()
            .enumerate()
        {
            let a = audit(&load(path), &p);
            println!(
                "{:<5} {:>7.1}s {backend:<9} {:>4} seg {:>3} grp {:>3} cut {:>7.2}s proposed, \
                 {:>6.2}s absent from keeper, {:>6.2}s repeats nothing",
                s.name,
                s.duration_secs,
                a.segments,
                a.groups,
                a.cut_utterances,
                a.cut_secs,
                a.absent_secs,
                a.unique_secs,
            );

            let (name, b, segments, groups, cuts, secs, absent_n, absent_s, uniq_n, uniq_s) =
                PINNED[i];
            assert_eq!(
                (name, b),
                (s.name, backend),
                "pinned row {i} is out of order"
            );
            assert_eq!(
                (
                    a.segments,
                    a.groups,
                    a.cut_utterances,
                    a.absent_utterances,
                    a.unique_utterances
                ),
                (segments, groups, cuts, absent_n, uniq_n),
                "{}/{backend}: segments, groups, and the three cut counts",
                s.name
            );
            for (got, want, what) in [
                (a.cut_secs, secs, "proposed"),
                (a.absent_secs, absent_s, "absent from the keeper"),
                (a.unique_secs, uniq_s, "repeating nothing"),
            ] {
                assert!(
                    (got - want).abs() < 0.005,
                    "{}/{backend}: {got:.2}s {what}, pinned {want:.2}s",
                    s.name
                );
            }

            let t = &mut totals[bi];
            t.groups += a.groups;
            t.cut_utterances += a.cut_utterances;
            t.cut_secs += a.cut_secs;
            t.absent_secs += a.absent_secs;
            t.unique_utterances += a.unique_utterances;
            t.unique_secs += a.unique_secs;
            i += 1;
        }
    }
    assert_eq!(i, PINNED.len());

    for (backend, t) in ["whisper", "parakeet"].iter().zip(&totals) {
        println!(
            "TOTAL {backend:<9} {} groups, {:.2}s proposed, {:.2}s absent from the keeper, \
             {:.2}s ({} utterances) repeating nothing",
            t.groups, t.cut_secs, t.absent_secs, t.unique_secs, t.unique_utterances
        );
    }

    // The headline of D-377's recommendation, asserted so it cannot be quoted
    // after it stops being true.
    assert_eq!(
        (totals[0].unique_utterances, totals[1].unique_utterances),
        (1, 5)
    );
    assert!((totals[0].unique_secs - 5.42).abs() < 0.005);
    assert!((totals[1].unique_secs - 56.92).abs() < 0.005);
}

/// **B-246 itemised: every proposed cut, on either backend, whose speech
/// repeats nothing in its own group.** Six of them, each a single-utterance
/// take admitted by [`similarity`]'s containment arm on a matching tail.
///
/// [`similarity`]: apelles_speech::retake::similarity
///
/// Pinned by index, duration and overlap rather than counted, because the fix
/// has to remove *these* and nothing else: the two columns above show the
/// detector already proposes 237.88 s / 218.36 s, and a change that zeroed this
/// list by finding fewer retakes would be a recall loss wearing the fix's
/// clothes. A deliberate fix makes this test fail with the list it emptied.
#[test]
fn b246_the_cuts_that_repeat_nothing_are_exactly_these() {
    let p = RetakeParams::default();
    // (source, backend, utterance index, secs, overlap vs keeper)
    let expected: &[(&str, &str, usize, f64, f64)] = &[
        // "monthly invoice still goes up there's actually a name for this
        // there's" — the Jevons-paradox setup. Only "there's actually a name for
        // this" repeats; the invoice line is said once and cut.
        ("C019", "whisper", 50, 5.42, 0.417),
        // 14.96 s, of which only the trailing "Writing the notes into the"
        // repeats: the cache-ordering explanation and "Let's actually go to the
        // maths" are each said once.
        ("C019", "parakeet", 14, 14.96, 0.156),
        // 12.24 s; only "One more thing to know the notes never" repeats.
        ("C019", "parakeet", 23, 12.24, 0.381),
        // 11.36 s; only "and the trick behind use to bring that cost" repeats.
        ("C038", "parakeet", 17, 11.36, 0.280),
        // 14.52 s; only "But the real reason it's this expensive" repeats.
        ("C038", "parakeet", 40, 14.52, 0.240),
        // 3.84 s; "It's less, it's less read than write, and more" against
        // "read than write while constantly rechecking."
        ("C040", "parakeet", 36, 3.84, 0.375),
    ];

    let mut got = Vec::new();
    for s in SPEECH {
        for (backend, path) in [("whisper", s.whisper), ("parakeet", s.parakeet)] {
            for c in proposed_cuts(&load(path), &p) {
                if c.vs_keeper < MIN_UTTERANCE_OVERLAP && c.vs_others < MIN_UTTERANCE_OVERLAP {
                    println!(
                        "{}/{backend} #{} {:.2}s vs_keeper={:.3} vs_others={:.3} {:?}",
                        s.name, c.index, c.secs, c.vs_keeper, c.vs_others, c.text
                    );
                    got.push((s.name, backend, c.index, c.secs, c.vs_keeper));
                }
            }
        }
    }

    assert_eq!(
        got.len(),
        expected.len(),
        "the set of cuts that repeat nothing changed — see this test's doc comment"
    );
    for (g, e) in got.iter().zip(expected) {
        assert_eq!((g.0, g.1, g.2), (e.0, e.1, e.2));
        assert!((g.3 - e.3).abs() < 0.005, "{g:?} vs {e:?}");
        assert!((g.4 - e.4).abs() < 0.0005, "{g:?} vs {e:?}");
    }
}

/// **The cross-check that Whisper's zero is not an artifact of the committed
/// fixtures' vintage.**
///
/// Re-transcribing C038 and C040 with `mlx-whisper large-v3` today does not
/// reproduce the committed fixtures — 126 segments against 121, and 83 against
/// 66. That divergence is unexplained (see D-377; the fixtures predate D-349's
/// MLX seeding, so they may simply be from an unseeded run, and nothing records
/// the `language` they were captured with) and it is deliberately **not**
/// resolved by replacing them: `real_transcripts.rs` pins four hand-classified
/// measurements against those exact files.
///
/// It does mean the headline above rests on one particular Whisper
/// segmentation, so both re-derived transcripts are committed alongside and
/// audited here. They propose *more* — 19 and 22 cuts against 14 and 15 — and
/// still **0.00 s that repeats nothing**. Whisper's zero holds across two
/// different segmentations of the same two sources; Parakeet's 56.92 s does not
/// have a reading that makes it go away. That is what makes the recommendation
/// a measurement rather than a coin toss.
#[test]
fn whisper_re_derived_today_also_proposes_nothing_that_repeats_nothing() {
    let p = RetakeParams::default();
    // (fixture, segments, groups, cut utterances, cut secs, absent secs)
    let fresh: &[(&str, usize, usize, usize, f64, f64)] = &[
        (
            "transcripts/A001_09122319_C038.whisper.json",
            126,
            11,
            19,
            87.80,
            27.62,
        ),
        (
            "transcripts/A001_09122356_C040.whisper.json",
            83,
            9,
            22,
            123.00,
            47.40,
        ),
    ];
    for &(path, segments, groups, cuts, secs, absent) in fresh {
        let a = audit(&load(path), &p);
        assert_eq!(
            (a.segments, a.groups, a.cut_utterances, a.unique_utterances),
            (segments, groups, cuts, 0),
            "{path}"
        );
        assert!(
            (a.cut_secs - secs).abs() < 0.005,
            "{path}: {:.2}s",
            a.cut_secs
        );
        assert!(
            (a.absent_secs - absent).abs() < 0.005,
            "{path}: {:.2}s absent",
            a.absent_secs
        );
        assert_eq!(a.unique_secs, 0.0, "{path}");
    }
}

/// **The nine silent sources, and the one real thing they say.** They cannot
/// test the proposed cut — no speech, no cut possible — so this is not a pass to
/// quote. What they do measure is a **difference between the two backends on
/// dead air**, which bears directly on the thresholds:
///
/// - **Parakeet emits nothing.** All nine `.parakeet.json` fixtures are empty.
/// - **Whisper hallucinates.** It returns `"Thank you."` (and one `"All
///   right."`) on room tone — five of the nine sources, nine phantom utterances,
///   the well-known Whisper-on-silence artifact.
///
/// Two of those phantoms are a **verbatim** repeat inside `window_secs`:
/// C030's `"Thank you."` at 0.00-2.70 s and 30.00-30.76 s, 27.3 s apart,
/// scoring a perfect 1.000 similarity. The only thing keeping the detector from
/// proposing a cut of a phantom is [`RetakeParams::min_words`] — `"thank you"`
/// normalises to two distinct words and the floor is three. **That is a measured
/// reason not to lower `min_words`**, recorded here so the next sweep sees it.
#[test]
fn the_silent_sources_are_not_a_test_of_the_cut() {
    let p = RetakeParams::default();
    let mut phantoms = 0;
    for name in SILENT {
        let parakeet = load(&format!("transcripts/{name}.parakeet.json"));
        assert!(
            parakeet.is_empty(),
            "{name}: parakeet transcribed silent B-roll as {parakeet:?}"
        );

        let whisper = load(&format!("transcripts/{name}.whisper.json"));
        phantoms += whisper.len();
        for u in &whisper {
            let n = normalise(&u.text);
            let distinct: std::collections::BTreeSet<&str> =
                n.split(' ').filter(|w| !w.is_empty()).collect();
            assert!(
                distinct.len() < p.min_words,
                "{name}: the phantom {:?} has {} distinct words — at or above \
                 min_words {}, so it can now reach the detector",
                u.text,
                distinct.len(),
                p.min_words
            );
        }

        for u in [&parakeet, &whisper] {
            assert!(
                detect_retakes(u, &p).is_empty(),
                "{name}: a silent source must never yield a retake group"
            );
        }
    }
    assert_eq!(phantoms, 9, "Whisper's phantom utterances across the nine");
}

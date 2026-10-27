//! The clean-cut gate, refusal by refusal, with the exact reasons a client
//! reads (D-411 §3.3).

use apelles_clipper::gate::{CLAUSE_PAUSE_S, EDGE_HEAD_PAD_S, EDGE_TAIL_PAD_S, HOOK_MAX_S};
use apelles_clipper::{
    AnalysisInput, ClipRefusal, ClipShape, ClipVerdict, ClipWarning, RetakeCut, Role, SegmentRef,
    SourceEvidence, TightenOptions, analyse, check, check_proposals,
};
use apelles_speech::{IndexedView, IndexedWord, ViewPiece};

/// Words from sentences: each word 0.3 s, 0.05 s apart, `gap_after[i]`
/// seconds of silence after sentence `i` (default 0.8 s).
fn view_of(sentences: &[&str], gaps: &[f64]) -> IndexedView {
    let mut words = Vec::new();
    let mut t = 0.0;
    for (i, s) in sentences.iter().enumerate() {
        let toks: Vec<&str> = s.split_whitespace().collect();
        for (k, tok) in toks.iter().enumerate() {
            words.push(IndexedWord {
                text: (*tok).into(),
                start_secs: t,
                end_secs: t + 0.3,
                run: 0,
            });
            t += 0.3;
            if k + 1 < toks.len() {
                t += 0.05;
            }
        }
        t += gaps.get(i).copied().unwrap_or(0.8);
    }
    let n = words.len();
    IndexedView {
        words,
        runs: Vec::new(),
        piece_of_word: vec![0; n],
    }
}

fn whole(view: &IndexedView) -> Vec<ViewPiece> {
    vec![ViewPiece {
        source: 0,
        start_secs: 0.0,
        end_secs: view.words.last().map_or(0.0, |w| w.end_secs + 5.0),
    }]
}

fn seg(a: usize, b: usize) -> SegmentRef {
    SegmentRef {
        first_word: a,
        last_word: b,
    }
}

fn shape(segments: Vec<SegmentRef>) -> ClipShape {
    ClipShape {
        hook: None,
        segments,
    }
}

/// Twelve sentences of six words each (2.05 s spoken + 0.8 s gap) — 34.2 s
/// in all, so a 15 s target spans about five sentences.
fn six_word_sentences() -> Vec<String> {
    (0..12)
        .map(|i| format!("Here is sentence number {i} done."))
        .collect()
}

fn refusal(v: &ClipVerdict) -> (&ClipRefusal, &[usize]) {
    match v {
        ClipVerdict::Refused { reason, offending } => (reason, offending.as_slice()),
        other => panic!("expected a refusal, got {other:?}"),
    }
}

macro_rules! fixture {
    ($view:ident, $pieces:ident, $input:ident, $analysis:ident, $ctx:ident, $sentences:expr, $gaps:expr, $retakes:expr, $durations:expr) => {
        let lines: Vec<String> = $sentences;
        let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
        let $view = view_of(&refs, $gaps);
        let $pieces = whole(&$view);
        let evidence = vec![SourceEvidence::default()];
        let retakes: Vec<RetakeCut> = $retakes;
        let durations: Vec<u32> = $durations;
        let $input = AnalysisInput {
            view: &$view,
            pieces: &$pieces,
            evidence: &evidence,
            retake_cuts: &retakes,
            durations: &durations,
            focus: None,
            tighten: TightenOptions::default(),
        };
        let $analysis = analyse(&$input);
        let $ctx = $analysis.gate(&$input);
    };
}

#[test]
fn a_clean_sentence_aligned_clip_is_verified_with_padded_edges() {
    fixture!(
        view,
        pieces,
        input,
        a,
        ctx,
        six_word_sentences(),
        &[],
        vec![],
        vec![15]
    );
    assert_eq!(a.sentences.len(), 12);
    // Sentences 1..=5: five sentences, about 14 s after the 0.8 s gaps tighten.
    let v = check(&ctx, &shape(vec![seg(6, 35)]));
    let resolved = v.resolved().unwrap_or_else(|| panic!("{v:?}"));
    assert!(matches!(v, ClipVerdict::Verified { .. }), "{v:?}");
    let r = &resolved.ranges[0];
    assert_eq!(r.role, Role::Body);
    assert!((view.words[6].start_secs - r.start_secs - EDGE_HEAD_PAD_S).abs() < 1e-9);
    // The tail pad is capped at half the 0.8 s gap.
    assert!((r.end_secs - view.words[35].end_secs - EDGE_TAIL_PAD_S.min(0.4)).abs() < 1e-9);
    assert!(
        resolved.tight_secs < resolved.raw_secs,
        "the four inner gaps tighten"
    );
    assert_eq!(r.cuts.len(), 4);
    assert_eq!((resolved.first_sentence, resolved.last_sentence), (1, 5));
}

#[test]
fn malformed_shapes_are_refused_by_name() {
    fixture!(
        view,
        pieces,
        input,
        a,
        ctx,
        six_word_sentences(),
        &[],
        vec![],
        vec![15]
    );
    let n = view.words.len();
    assert_eq!(
        refusal(&check(&ctx, &shape(vec![]))).0,
        &ClipRefusal::NoSegments
    );
    let v = check(&ctx, &shape(vec![seg(6, n + 3)]));
    assert_eq!(refusal(&v), (&ClipRefusal::WordOutOfRange, &[n + 3][..]));
    let v = check(&ctx, &shape(vec![seg(35, 6)]));
    assert_eq!(refusal(&v).0, &ClipRefusal::InvertedSegment);
    let v = check(&ctx, &shape(vec![seg(6, 17), seg(12, 23)]));
    assert_eq!(
        refusal(&v),
        (
            &ClipRefusal::OverlappingSegments,
            &[12, 13, 14, 15, 16, 17][..]
        )
    );
}

#[test]
fn an_edge_off_a_sentence_boundary_is_refused_with_the_word() {
    fixture!(
        view,
        pieces,
        input,
        a,
        ctx,
        six_word_sentences(),
        &[],
        vec![],
        vec![15]
    );
    let v = check(&ctx, &shape(vec![seg(7, 35)]));
    assert_eq!(refusal(&v), (&ClipRefusal::StartNotAtSentence, &[7][..]));
    let v = check(&ctx, &shape(vec![seg(6, 34)]));
    assert_eq!(refusal(&v), (&ClipRefusal::EndNotAtSentence, &[34][..]));
    assert!(
        ClipRefusal::StartNotAtSentence
            .to_string()
            .contains("mid-sentence")
    );
}

#[test]
fn an_inner_stitch_may_fall_on_a_clause_but_an_outer_edge_may_not() {
    // Sentence 1 has a comma after its third word, then a 0.5 s pause.
    let mut lines = six_word_sentences();
    lines[1] = "Well here it, comes the point.".into();
    let lines2 = lines.clone();
    fixture!(view, pieces, input, a, ctx, lines2, &[], vec![], vec![15]);
    // Make the clause pause real: shift words 9.. later by 0.45 s.
    let mut v2 = view.clone();
    for w in v2.words.iter_mut().skip(9) {
        w.start_secs += 0.45;
        w.end_secs += 0.45;
    }
    let pieces2 = whole(&v2);
    let evidence = vec![SourceEvidence::default()];
    let input2 = AnalysisInput {
        view: &v2,
        pieces: &pieces2,
        ..input
    };
    let input2 = AnalysisInput {
        evidence: &evidence,
        ..input2
    };
    let a2 = analyse(&input2);
    let ctx2 = a2.gate(&input2);
    assert!(v2.words[9].start_secs - v2.words[8].end_secs >= CLAUSE_PAUSE_S);
    // Stitch: sentences 2..=6, then the clause "comes the point." of sentence
    // 1 — an inner start edge on the comma.
    let stitched = check(&ctx2, &shape(vec![seg(12, 41), seg(9, 11)]));
    assert!(stitched.resolved().is_some(), "{stitched:?}");
    // The same clause as the OUTER start is refused.
    let outer = check(&ctx2, &shape(vec![seg(9, 35)]));
    assert_eq!(
        refusal(&outer),
        (&ClipRefusal::StartNotAtSentence, &[9][..])
    );
    let _ = (&a, &ctx, &lines);
}

#[test]
fn an_edge_between_overlapping_words_is_inside_a_word() {
    fixture!(
        view,
        pieces,
        input,
        a,
        ctx,
        six_word_sentences(),
        &[],
        vec![],
        vec![15]
    );
    let mut v2 = view.clone();
    // The last word of sentence 0 runs into the first of sentence 1.
    v2.words[5].end_secs = v2.words[6].start_secs + 0.2;
    let input2 = AnalysisInput { view: &v2, ..input };
    let a2 = analyse(&input2);
    let ctx2 = a2.gate(&input2);
    let v = check(&ctx2, &shape(vec![seg(6, 35)]));
    assert_eq!(refusal(&v), (&ClipRefusal::EdgeInsideWord, &[5, 6][..]));
    let _ = (&a, &ctx, &pieces);
}

#[test]
fn a_segment_starting_or_ending_in_a_reviewed_retake_is_refused() {
    let cut_over_word_6 = vec![RetakeCut {
        source: 0,
        start_secs: 2.8,
        end_secs: 3.5,
    }];
    fixture!(
        view,
        pieces,
        input,
        a,
        ctx,
        six_word_sentences(),
        &[],
        cut_over_word_6,
        vec![15]
    );
    assert!(view.words[6].start_secs >= 2.8 && view.words[6].end_secs <= 3.5);
    let v = check(&ctx, &shape(vec![seg(6, 35)]));
    assert_eq!(refusal(&v), (&ClipRefusal::StartsInRetake, &[6][..]));
    let end_cut = vec![RetakeCut {
        source: 0,
        start_secs: view.words[35].start_secs,
        end_secs: view.words[35].end_secs,
    }];
    let input2 = AnalysisInput {
        retake_cuts: &end_cut,
        ..input
    };
    let a2 = analyse(&input2);
    let ctx2 = a2.gate(&input2);
    let v = check(&ctx2, &shape(vec![seg(6, 35)]));
    assert_eq!(refusal(&v), (&ClipRefusal::EndsInRetake, &[35][..]));
    let _ = (&a, &ctx);
}

#[test]
fn a_retake_wholly_inside_is_cut_by_the_build_not_refused() {
    let inside = vec![RetakeCut {
        source: 0,
        start_secs: 8.6,
        end_secs: 11.4,
    }];
    fixture!(
        view,
        pieces,
        input,
        a,
        ctx,
        six_word_sentences(),
        &[],
        inside,
        vec![15]
    );
    let v = check(&ctx, &shape(vec![seg(6, 41)]));
    let r = v.resolved().unwrap_or_else(|| panic!("{v:?}"));
    assert!(
        r.ranges[0]
            .cuts
            .iter()
            .any(|c| c.kind == apelles_clipper::CutKind::Retake)
    );
}

#[test]
fn a_hook_must_be_one_to_three_whole_sentences_within_eight_seconds() {
    fixture!(
        view,
        pieces,
        input,
        a,
        ctx,
        six_word_sentences(),
        &[],
        vec![],
        vec![15]
    );
    let mut s = shape(vec![seg(6, 35)]);
    s.hook = Some(seg(31, 35));
    let v = check(&ctx, &s);
    assert_eq!(
        refusal(&v),
        (&ClipRefusal::HookNotWholeSentences, &[31, 35][..])
    );
    // Four whole sentences.
    s.hook = Some(seg(6, 29));
    let v = check(&ctx, &s);
    assert_eq!(refusal(&v).0, &ClipRefusal::HookNotWholeSentences);
    // One whole sentence: accepted, played first.
    s.hook = Some(seg(30, 35));
    let v = check(&ctx, &s);
    let r = v.resolved().unwrap_or_else(|| panic!("{v:?}"));
    assert_eq!(r.ranges[0].role, Role::Hook);
    assert_eq!(r.ranges[1].role, Role::Body);
    // A long single sentence is too long a hook.
    let long: Vec<String> = vec![
        "Short one.".into(),
        (0..30)
            .map(|i| format!("w{i}"))
            .collect::<Vec<_>>()
            .join(" ")
            + ".",
        "Tail here.".into(),
    ];
    fixture!(v3, p3, i3, a3, c3, long, &[], vec![], vec![15]);
    let mut s3 = shape(vec![seg(0, 1)]);
    s3.hook = Some(seg(2, 31));
    let v = check(&c3, &s3);
    match refusal(&v).0 {
        ClipRefusal::HookTooLong { secs } => assert!(*secs > HOOK_MAX_S),
        other => panic!("{other:?}"),
    }
    let _ = (&a, &a3, &v3, &p3, &i3);
}

#[test]
fn a_length_outside_every_target_is_refused_with_the_closest_band() {
    fixture!(
        view,
        pieces,
        input,
        a,
        ctx,
        six_word_sentences(),
        &[],
        vec![],
        vec![15, 30]
    );
    // One sentence, about 2.4 s.
    let v = check(&ctx, &shape(vec![seg(6, 11)]));
    match refusal(&v) {
        (
            ClipRefusal::DurationOutOfRange {
                secs,
                target,
                min_secs,
                max_secs,
            },
            offending,
        ) => {
            assert!(*secs < 3.0);
            assert_eq!(*target, 15);
            assert!((min_secs - 10.5).abs() < 1e-9 && (max_secs - 18.75).abs() < 1e-9);
            assert_eq!(offending, &[6, 11]);
        }
        other => panic!("{other:?}"),
    }
    assert!(
        refusal(&v)
            .0
            .to_string()
            .contains("the closest target, 15 s, accepts 10.5-18.8 s"),
        "{}",
        refusal(&v).0
    );
}

#[test]
fn warnings_name_a_context_opener_a_question_ending_and_overlap() {
    let mut lines = six_word_sentences();
    lines[1] = "And so this is sentence one.".into();
    lines[5] = "But why does this even matter?".into();
    fixture!(view, pieces, input, a, ctx, lines, &[], vec![], vec![15]);
    let v = check(&ctx, &shape(vec![seg(6, 35)]));
    match &v {
        ClipVerdict::Warned { warnings, .. } => {
            assert!(warnings.contains(&ClipWarning::ContextOpen { word: "and".into() }));
            assert!(warnings.contains(&ClipWarning::EndsOnQuestion));
        }
        other => panic!("{other:?}"),
    }
    let batch = check_proposals(&ctx, &[shape(vec![seg(12, 41)]), shape(vec![seg(18, 47)])]);
    for (i, v) in batch.iter().enumerate() {
        match v {
            ClipVerdict::Warned { warnings, .. } => assert!(
                warnings.iter().any(
                    |w| matches!(w, ClipWarning::OverlapsProposal { other, .. } if *other == 1 - i)
                ),
                "{warnings:?}"
            ),
            other => panic!("{other:?}"),
        }
    }
    let _ = (&a, &view);
}

#[test]
fn a_segment_across_two_pieces_uses_the_pieces_window_edges() {
    // Two clip windows of two sources (a cut in a long timeline): the
    // segment runs across the cut, so each side ends at its window's edge.
    let mut view = view_of(
        &[
            "One two three four five six.",
            "Seven eight nine ten eleven twelve.",
            "Thirteen fourteen fifteen sixteen seventeen.",
        ],
        &[],
    );
    view.piece_of_word = (0..view.words.len()).map(|i| usize::from(i >= 6)).collect();
    let pieces = vec![
        ViewPiece {
            source: 0,
            start_secs: 0.0,
            end_secs: 4.0,
        },
        ViewPiece {
            source: 1,
            start_secs: 0.0,
            end_secs: 60.0,
        },
    ];
    let evidence = vec![SourceEvidence::default(), SourceEvidence::default()];
    let durations = vec![15];
    let input = AnalysisInput {
        view: &view,
        pieces: &pieces,
        evidence: &evidence,
        retake_cuts: &[],
        durations: &durations,
        focus: None,
        tighten: TightenOptions::default(),
    };
    let a = analyse(&input);
    let ctx = a.gate(&input);
    let v = check(&ctx, &shape(vec![seg(0, 16)]));
    let r = v.resolved().unwrap_or_else(|| panic!("{v:?}"));
    assert_eq!(r.ranges.len(), 2);
    let (x, y) = (&r.ranges[0], &r.ranges[1]);
    assert_eq!((x.piece, x.source, x.first_word, x.last_word), (0, 0, 0, 5));
    assert!(
        (x.start_secs - 0.0).abs() < 1e-9 && (x.end_secs - 4.0).abs() < 1e-9,
        "{x:?}"
    );
    assert_eq!(
        (y.piece, y.source, y.first_word, y.last_word),
        (1, 1, 6, 16)
    );
    assert!(
        (y.start_secs - 0.0).abs() < 1e-9,
        "the window start, not a padded word: {y:?}"
    );
    let last = view.words[16].end_secs;
    assert!(
        (y.end_secs - (last + EDGE_TAIL_PAD_S)).abs() < 1e-9,
        "{y:?}"
    );
}

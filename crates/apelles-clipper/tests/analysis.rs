//! Candidates, the moment view's paging and identity, and the run schema.

use apelles_clipper::gate::GateContext;
use apelles_clipper::run::is_valid_id;
use apelles_clipper::view::{JUDGING_RULES, MOMENT_VIEW_LEGEND};
use apelles_clipper::{
    AnalysisInput, Aspect, CLIP_RUN_SCHEMA, ClipProposal, ClipRun, ClipShape, ClipVerdict,
    Loudness, PickedBy, ProposalStatus, RunSettings, RunSource, SegmentRef, SourceEvidence, Span,
    TightenOptions, analyse, check, render_identity, render_page,
};
use apelles_speech::{IndexedView, IndexedWord, ViewPiece};

/// `n` sentences of `len` words, two subjects (the vocabulary switches at the
/// half), 0.3 s words 0.05 s apart, a 0.8 s pause after each sentence.
fn talk(n: usize, len: usize) -> IndexedView {
    let mut words = Vec::new();
    let mut t = 0.0;
    for i in 0..n {
        let topic = if i < n / 2 {
            ["pricing", "churn", "customers"]
        } else {
            ["hiring", "engineers", "interviews"]
        };
        for k in 0..len {
            let mut text = topic[(i + k) % 3].to_string();
            if k + 1 == len {
                text.push('.');
            }
            words.push(IndexedWord {
                text,
                start_secs: t,
                end_secs: t + 0.3,
                run: 0,
            });
            t += 0.35;
        }
        t += 0.75;
    }
    let count = words.len();
    IndexedView {
        words,
        runs: Vec::new(),
        piece_of_word: vec![0; count],
    }
}

fn piece_for(view: &IndexedView) -> Vec<ViewPiece> {
    vec![ViewPiece {
        source: 0,
        start_secs: 0.0,
        end_secs: view.words.last().map_or(0.0, |w| w.end_secs) + 2.0,
    }]
}

#[test]
fn candidates_are_clean_in_band_and_listed_in_source_order() {
    let view = talk(40, 8);
    let pieces = piece_for(&view);
    let evidence = vec![SourceEvidence::default()];
    let durations = vec![15, 30];
    let input = AnalysisInput {
        view: &view,
        pieces: &pieces,
        evidence: &evidence,
        retake_cuts: &[],
        durations: &durations,
        focus: Some("customers churn"),
        tighten: TightenOptions::default(),
    };
    let a = analyse(&input);
    assert_eq!(a.sentences.len(), 40);
    assert_eq!(a.topics.len(), 2, "{:?}", a.topics);
    assert!(!a.candidates.is_empty());
    let ctx = a.gate(&input);
    let mut last_first = 0;
    for c in &a.candidates {
        assert!(c.first_sentence >= last_first, "source order");
        last_first = c.first_sentence;
        let (lo, hi) = GateContext::band(c.target_secs);
        assert!(c.tight_secs >= lo && c.tight_secs <= hi, "{c:?}");
        assert_eq!(
            a.topic_of_sentence[c.first_sentence],
            a.topic_of_sentence[c.last_sentence]
        );
        let v = check(
            &ctx,
            &ClipShape {
                hook: None,
                segments: vec![SegmentRef {
                    first_word: a.sentences[c.first_sentence].first_word,
                    last_word: a.sentences[c.last_sentence].last_word,
                }],
            },
        );
        assert!(
            !matches!(v, ClipVerdict::Refused { .. }),
            "a candidate passes the gate: {v:?}"
        );
    }
    let ids: std::collections::BTreeSet<&str> =
        a.candidates.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(ids.len(), a.candidates.len(), "ids are unique");
    // Focus words are matched as evidence on the pricing half only.
    assert!(
        a.sentence_tags[0]
            .iter()
            .any(|t| matches!(t, apelles_clipper::Tag::Focus { .. }))
    );
    assert!(
        !a.sentence_tags[39]
            .iter()
            .any(|t| matches!(t, apelles_clipper::Tag::Focus { .. }))
    );
}

#[test]
fn the_view_pages_by_sentence_with_global_numbers_and_topic_lines() {
    let view = talk(40, 8);
    let pieces = piece_for(&view);
    let evidence = vec![SourceEvidence::default()];
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
    let whole = render_page(&a, 0, a.sentences.len(), 1);
    assert!(whole.starts_with(MOMENT_VIEW_LEGEND));
    let p0 = render_page(&a, 0, 25, 1);
    let p1 = render_page(&a, 25, 50, 1);
    assert!(p0.starts_with(MOMENT_VIEW_LEGEND));
    assert!(!p1.starts_with('#'), "the legend is on page 0 only");
    assert!(
        p1.starts_with("=== topic 1"),
        "a page opens with its topic line: {p1}"
    );
    assert!(p1.contains("\nS25 ") || p1.contains("S25 "));
    assert!(!p1.contains("\nS24 "));
    // The pages hold every sentence line of the whole view, in order.
    let lines = |s: &str| {
        s.lines()
            .filter(|l| l.starts_with('S'))
            .map(String::from)
            .collect::<Vec<_>>()
    };
    let mut paged = lines(&p0);
    paged.extend(lines(&p1));
    assert_eq!(paged, lines(&whole));
    assert!(
        whole.contains("ends: 15s→S"),
        "candidate endings are hinted: {whole}"
    );
    assert!(!JUDGING_RULES.is_empty());
}

#[test]
fn evidence_changes_tags_but_never_the_views_identity() {
    let view = talk(20, 8);
    let pieces = piece_for(&view);
    let durations = vec![15];
    let bare = vec![SourceEvidence::default()];
    let measured = vec![SourceEvidence {
        speech: Some(vec![Span {
            start_secs: 0.0,
            end_secs: 1000.0,
        }]),
        loudness: Some(Loudness {
            start_secs: 0.0,
            hop_secs: 0.5,
            db: (0..400)
                .map(|i| if i < 20 { -10.0 } else { -30.0 })
                .collect(),
        }),
        scene_cuts: Some(vec![3.0, 40.0]),
    }];
    let base = AnalysisInput {
        view: &view,
        pieces: &pieces,
        evidence: &bare,
        retake_cuts: &[],
        durations: &durations,
        focus: None,
        tighten: TightenOptions::default(),
    };
    let a = analyse(&base);
    let b = analyse(&AnalysisInput {
        evidence: &measured,
        ..base
    });
    assert_eq!(render_identity(&a), render_identity(&b));
    assert_ne!(a.sentence_tags, b.sentence_tags);
    assert!(
        b.sentence_tags[0]
            .iter()
            .any(|t| matches!(t, apelles_clipper::Tag::Loud { .. }))
    );
}

fn sample_run() -> ClipRun {
    let view = talk(12, 6);
    let pieces = piece_for(&view);
    let evidence = vec![SourceEvidence::default()];
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
    let shape = ClipShape {
        hook: None,
        segments: vec![SegmentRef {
            first_word: 0,
            last_word: 35,
        }],
    };
    let verdict = check(&ctx, &shape);
    ClipRun {
        schema: CLIP_RUN_SCHEMA,
        id: "run-1a2b".into(),
        created_at: "2026-10-27T12:00:00Z".into(),
        source: RunSource::Media {
            media_id: "m-1".into(),
            path: "/a.mov".into(),
            name: "a.mov".into(),
        },
        settings: RunSettings {
            durations: vec![15, 30],
            count: 3,
            aspect: Aspect::Portrait,
            captions: "brand".into(),
            hook_first: true,
            tighten: TightenOptions::default(),
            range: None,
            focus: Some("pricing".into()),
        },
        view_id: Some("abc".into()),
        proposals: vec![ClipProposal {
            id: "p1".into(),
            shape,
            title: "Why churn follows price".into(),
            reason: "a self-contained pricing story".into(),
            hook_line: None,
            picked_by: PickedBy::Client,
            view_id: "abc".into(),
            rules_version: 1,
            verdict,
            gate_notes: Vec::new(),
            status: ProposalStatus::Pending,
            timeline_id: None,
            built_at: None,
        }],
    }
}

#[test]
fn a_run_round_trips_and_its_schema_is_checked_by_name() {
    let run = sample_run();
    run.validate().expect("valid");
    let json = serde_json::to_string(&run).expect("encode");
    assert!(json.contains("\"aspect\":\"9:16\""));
    assert!(json.contains("\"kind\":\"media\""));
    let back: ClipRun = serde_json::from_str(&json).expect("decode");
    // Equal up to float parsing (serde_json reads the last digit of a long
    // decimal to within one ulp): the same document when written again.
    assert_eq!(back.id, run.id);
    assert_eq!(back.proposals[0].shape, run.proposals[0].shape);
    let again = serde_json::to_value(&back).expect("re-encode");
    let first = serde_json::to_value(&run).expect("encode value");
    assert_eq!(again["settings"], first["settings"]);
    assert_eq!(again["proposals"][0]["verdict"]["verdict"], "verified");

    let mut bad = run.clone();
    bad.schema = 9;
    assert!(bad.validate().unwrap_err().contains("schema 9"));
    let mut bad = run.clone();
    bad.id = "../x".into();
    assert!(bad.validate().unwrap_err().contains("clip run id"));
    let mut bad = run.clone();
    bad.settings.durations = vec![45];
    assert!(
        bad.validate()
            .unwrap_err()
            .contains("45 s is not a target length")
    );
    let mut bad = run.clone();
    bad.proposals[0].status = ProposalStatus::Built;
    assert!(bad.validate().unwrap_err().contains("names no timeline"));
    let mut bad = run.clone();
    bad.proposals.push(bad.proposals[0].clone());
    assert!(bad.validate().unwrap_err().contains("appears twice"));
    let mut bad = run;
    bad.settings.count = 0;
    assert!(bad.validate().unwrap_err().contains("count"));

    assert!(is_valid_id("run-20261027-a1"));
    assert!(!is_valid_id("Run"));
    assert!(!is_valid_id(""));
    assert_eq!(Aspect::Portrait.output(), (1080, 1920));
}

//! The clipper eval's mechanical half (D-411 §11; data and README in
//! `eval/clipper/`): on real Parakeet transcripts, **no proposal that passes
//! the gate ever cuts mid-sentence or mid-word, misses its length or replays a
//! retake** — across every deterministic candidate and thousands of fuzzed
//! proposals, most of them deliberately bad — and the analysis of an hour of
//! talk fits the design's budget (< 1 s, §8).
//!
//! Inputs: `eval/retake/transcripts/*.parakeet.words.json` (three real
//! talking-head recordings) and, as the "reviewed retakes", every non-kept
//! delivery of `eval/retake/labels/*.json`'s hand-labelled groups.
//!
//! ```sh
//! cargo test -p apelles-clipper --test clipper_eval -- --nocapture   # the table
//! ```
//!
//! What it does NOT measure: whether the picks are good. That is the judge's
//! (the MCP client's), scored against owner labels — the eval's other half,
//! not built yet (`eval/clipper/README.md`).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Instant;

use apelles_clipper::gate::{CLAUSE_PAUSE_S, GateContext};
use apelles_clipper::text::{WordEnd, word_end};
use apelles_clipper::{
    AnalysisInput, ClipRefusal, ClipShape, ClipVerdict, RetakeCut, Role, SegmentRef,
    SourceEvidence, TightenOptions, analyse, check_proposals,
};
use apelles_speech::{IndexedView, TranscriptSegment, ViewPiece, index_pieces};
use serde::Deserialize;

const SOURCES: [&str; 3] = [
    "A001_08302215_C019",
    "A001_09122319_C038",
    "A001_09122356_C040",
];
const DURATIONS: [u32; 4] = [15, 30, 60, 90];
/// Extra transcripts (comma-separated paths of `transcribe.py` JSON) to run
/// through the same checks.
const EXTRA_ENV: &str = "APELLES_CLIPPER_EVAL_EXTRA";
/// Fuzzed proposals per source.
const FUZZ: usize = 4000;
/// The design's budget for candidates + features over an hour (§8).
const HOUR_BUDGET_SECS: f64 = 1.0;

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

#[derive(Deserialize)]
struct Transcript {
    segments: Vec<TranscriptSegment>,
}

#[derive(Deserialize)]
struct Delivery {
    start: f64,
    end: f64,
}

#[derive(Deserialize)]
struct LabelGroup {
    keeper: usize,
    deliveries: Vec<Delivery>,
}

#[derive(Deserialize)]
struct Labels {
    retakes: Vec<LabelGroup>,
}

fn load(name: &str) -> (Vec<TranscriptSegment>, Vec<RetakeCut>) {
    let t = repo().join(format!(
        "eval/retake/transcripts/{name}.parakeet.words.json"
    ));
    let raw = std::fs::read_to_string(&t).unwrap_or_else(|e| panic!("{}: {e}", t.display()));
    let tr: Transcript = serde_json::from_str(&raw).unwrap_or_else(|e| panic!("{name}: {e}"));
    let l = repo().join(format!("eval/retake/labels/{name}.json"));
    let raw = std::fs::read_to_string(&l).unwrap_or_else(|e| panic!("{}: {e}", l.display()));
    let labels: Labels =
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("{name} labels: {e}"));
    let cuts = labels
        .retakes
        .iter()
        .flat_map(|g| {
            g.deliveries
                .iter()
                .enumerate()
                .filter(move |(i, _)| *i != g.keeper)
                .map(|(_, d)| RetakeCut {
                    source: 0,
                    start_secs: d.start,
                    end_secs: d.end,
                })
        })
        .collect();
    (tr.segments, cuts)
}

/// A deterministic generator (an LCG), so the fuzz is the same every run.
struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.0 >> 33
    }
    fn below(&mut self, n: usize) -> usize {
        if n == 0 {
            0
        } else {
            (self.next() % n as u64) as usize
        }
    }
}

/// Every mechanical promise of a passing verdict, checked from the outside.
fn violations(
    view: &IndexedView,
    a: &apelles_clipper::Analysis,
    shape: &ClipShape,
    v: &ClipVerdict,
    cuts: &[RetakeCut],
) -> Vec<String> {
    let mut out = Vec::new();
    let Some(r) = v.resolved() else {
        return out;
    };
    let words = &view.words;
    let starts: Vec<usize> = a.sentences.iter().map(|s| s.first_word).collect();
    let ends: Vec<usize> = a.sentences.iter().map(|s| s.last_word).collect();
    let clause = |k: usize| {
        k + 1 < words.len()
            && word_end(&words[k].text) == WordEnd::Clause
            && words[k + 1].start_secs - words[k].end_secs >= CLAUSE_PAUSE_S
    };
    let last = shape.segments.len() - 1;
    for (i, s) in shape.segments.iter().enumerate() {
        let start_ok = starts.contains(&s.first_word)
            || (i > 0 && s.first_word > 0 && clause(s.first_word - 1));
        let end_ok = ends.contains(&s.last_word) || (i < last && clause(s.last_word));
        if !start_ok {
            out.push(format!("mid-sentence start at word {}", s.first_word));
        }
        if !end_ok {
            out.push(format!("mid-sentence end at word {}", s.last_word));
        }
    }
    if let Some(h) = shape.hook
        && (!starts.contains(&h.first_word) || !ends.contains(&h.last_word))
    {
        out.push("hook is not whole sentences".into());
    }
    for range in &r.ranges {
        let (f, l) = (range.first_word, range.last_word);
        if range.start_secs > words[f].start_secs + 1e-9 {
            out.push(format!("range starts after its first word {f}"));
        }
        if range.end_secs < words[l].end_secs - 1e-9 {
            out.push(format!("range ends before its last word {l}"));
        }
        if f > 0
            && view.piece_of_word[f - 1] == range.piece
            && range.start_secs < words[f - 1].end_secs - 1e-9
        {
            out.push(format!("range start reaches into word {}", f - 1));
        }
        if l + 1 < words.len()
            && view.piece_of_word[l + 1] == range.piece
            && range.end_secs > words[l + 1].start_secs + 1e-9
        {
            out.push(format!("range end reaches into word {}", l + 1));
        }
        for c in &range.cuts {
            if words[f..=l]
                .iter()
                .any(|w| w.start_secs < c.end_secs - 1e-9 && w.end_secs > c.start_secs + 1e-9)
                && c.kind == apelles_clipper::CutKind::DeadAir
            {
                out.push("a dead-air cut overlaps a word".into());
            }
        }
        let first_mid = (words[f].start_secs + words[f].end_secs) / 2.0;
        let last_mid = (words[l].start_secs + words[l].end_secs) / 2.0;
        let opens_segment = shape
            .segments
            .iter()
            .chain(shape.hook.iter())
            .any(|s| s.first_word == f);
        let closes_segment = shape
            .segments
            .iter()
            .chain(shape.hook.iter())
            .any(|s| s.last_word == l);
        for c in cuts {
            if opens_segment && first_mid >= c.start_secs && first_mid < c.end_secs {
                out.push(format!("starts inside a retake at word {f}"));
            }
            if closes_segment && last_mid >= c.start_secs && last_mid < c.end_secs {
                out.push(format!("ends inside a retake at word {l}"));
            }
        }
    }
    let in_band = DURATIONS.iter().any(|&t| {
        let (lo, hi) = GateContext::band(t);
        r.tight_secs >= lo - 1e-9 && r.tight_secs <= hi + 1e-9
    });
    if !in_band {
        out.push(format!("length {:.2} s outside every band", r.tight_secs));
    }
    if r.ranges.iter().any(|x| x.role == Role::Hook) && shape.hook.is_none() {
        out.push("a hook range without a hook".into());
    }
    out
}

#[test]
fn no_passing_proposal_cuts_mid_sentence_or_mid_word_and_an_hour_analyses_in_budget() {
    println!(
        "\n| source | words | sentences | topics | candidates | analyse | fuzzed | passed | refused | violations |"
    );
    println!("|---|---|---|---|---|---|---|---|---|---|");
    let mut total_violations = 0usize;
    let mut reasons: BTreeMap<String, usize> = BTreeMap::new();
    let mut all_segments: Vec<Vec<TranscriptSegment>> = Vec::new();
    let mut inputs: Vec<(String, Vec<TranscriptSegment>, Vec<RetakeCut>)> = SOURCES
        .iter()
        .map(|name| {
            let (segments, cuts) = load(name);
            (name.to_string(), segments, cuts)
        })
        .collect();
    // A long real source measured outside the repo (an owner's recording is
    // theirs, not a fixture): `eval/clipper/measure_transcribe.py` writes it.
    if let Ok(extra) = std::env::var(EXTRA_ENV) {
        for path in extra.split(',').filter(|p| !p.is_empty()) {
            let raw = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{path}: {e}"));
            let tr: Transcript =
                serde_json::from_str(&raw).unwrap_or_else(|e| panic!("{path}: {e}"));
            let name = Path::new(path)
                .parent()
                .and_then(|d| d.file_name())
                .map_or_else(|| path.to_string(), |n| n.to_string_lossy().to_string());
            inputs.push((name, tr.segments, Vec::new()));
        }
    }
    for (name, segments, cuts) in inputs {
        let name = name.as_str();
        let end = segments.last().map_or(0.0, |s| s.end) + 1.0;
        let pieces = vec![ViewPiece {
            source: 0,
            start_secs: 0.0,
            end_secs: end,
        }];
        let view = index_pieces(std::slice::from_ref(&segments), &pieces).expect("index");
        let evidence = vec![SourceEvidence::default()];
        let input = AnalysisInput {
            view: &view,
            pieces: &pieces,
            evidence: &evidence,
            retake_cuts: &cuts,
            durations: &DURATIONS,
            focus: None,
            tighten: TightenOptions::default(),
        };
        let t0 = Instant::now();
        let a = analyse(&input);
        let took = t0.elapsed().as_secs_f64();
        let ctx = a.gate(&input);

        // Every candidate, then the fuzz: segment edges on sentence edges,
        // one word off, on random words; hooks; stitched pairs.
        let mut shapes: Vec<ClipShape> = a
            .candidates
            .iter()
            .map(|c| ClipShape {
                hook: None,
                segments: vec![SegmentRef {
                    first_word: a.sentences[c.first_sentence].first_word,
                    last_word: a.sentences[c.last_sentence].last_word,
                }],
            })
            .collect();
        let mut rng = Lcg(0xC11_99E5 ^ name.len() as u64);
        let n = view.words.len();
        let ns = a.sentences.len();
        for _ in 0..FUZZ {
            let s0 = rng.below(ns);
            let s1 = (s0 + rng.below(30)).min(ns - 1);
            let mut first = a.sentences[s0].first_word;
            let mut last = a.sentences[s1].last_word;
            match rng.below(4) {
                0 => first = (first + rng.below(3)).min(n - 1),
                1 => last = last.saturating_sub(rng.below(3)).max(first),
                2 => {
                    first = rng.below(n);
                    last = (first + rng.below(300)).min(n - 1);
                }
                _ => {}
            }
            let mut segments = vec![SegmentRef {
                first_word: first,
                last_word: last,
            }];
            if rng.below(5) == 0 {
                let t0 = rng.below(ns);
                let t1 = (t0 + rng.below(10)).min(ns - 1);
                segments.push(SegmentRef {
                    first_word: a.sentences[t0].first_word,
                    last_word: a.sentences[t1].last_word,
                });
            }
            let hook = (rng.below(4) == 0).then(|| {
                let h = rng.below(ns);
                SegmentRef {
                    first_word: a.sentences[h].first_word,
                    last_word: a.sentences[(h + rng.below(3)).min(ns - 1)].last_word,
                }
            });
            shapes.push(ClipShape { hook, segments });
        }
        let verdicts = check_proposals(&ctx, &shapes);
        let mut passed = 0;
        let mut refused = 0;
        let mut bad = 0;
        for (shape, v) in shapes.iter().zip(&verdicts) {
            match v {
                ClipVerdict::Refused { reason, .. } => {
                    refused += 1;
                    let key = match reason {
                        ClipRefusal::DurationOutOfRange { .. } => {
                            "duration_out_of_range".to_string()
                        }
                        ClipRefusal::HookTooLong { .. } => "hook_too_long".to_string(),
                        other => serde_json::to_value(other)
                            .ok()
                            .and_then(|j| j["kind"].as_str().map(String::from))
                            .unwrap_or_default(),
                    };
                    *reasons.entry(key).or_insert(0) += 1;
                }
                _ => {
                    passed += 1;
                    let found = violations(&view, &a, shape, v, &cuts);
                    if !found.is_empty() {
                        bad += 1;
                        eprintln!("{name}: {shape:?} -> {found:?}");
                    }
                }
            }
        }
        total_violations += bad;
        println!(
            "| {name} | {n} | {ns} | {} | {} | {:.1} ms | {} | {passed} | {refused} | {bad} |",
            a.topics.len(),
            a.candidates.len(),
            took * 1000.0,
            shapes.len(),
        );
        all_segments.push(segments);
    }
    println!("\nrefusals by reason: {reasons:?}");
    assert_eq!(
        total_violations, 0,
        "a passing proposal broke a mechanical promise"
    );

    // An hour: the three sources back to back, as pieces of one view.
    let mut pieces = Vec::new();
    let mut sources = Vec::new();
    let mut covered = 0.0;
    let mut k = 0;
    while covered < 3600.0 {
        let i = k % all_segments.len();
        let end = all_segments[i].last().map_or(0.0, |s| s.end) + 1.0;
        sources.push(all_segments[i].clone());
        pieces.push(ViewPiece {
            source: k,
            start_secs: 0.0,
            end_secs: end,
        });
        covered += end;
        k += 1;
    }
    let view = index_pieces(&sources, &pieces).expect("index the hour");
    let evidence = vec![SourceEvidence::default(); sources.len()];
    let input = AnalysisInput {
        view: &view,
        pieces: &pieces,
        evidence: &evidence,
        retake_cuts: &[],
        durations: &DURATIONS,
        focus: None,
        tighten: TightenOptions::default(),
    };
    let t0 = Instant::now();
    let a = analyse(&input);
    let took = t0.elapsed().as_secs_f64();
    println!(
        "\nan hour ({covered:.0} s, {} words, {} sentences, {} candidates): analysed in {:.0} ms (budget {:.0} ms)",
        view.words.len(),
        a.sentences.len(),
        a.candidates.len(),
        took * 1000.0,
        HOUR_BUDGET_SECS * 1000.0
    );
    assert!(took < HOUR_BUDGET_SECS, "{took} s");
}

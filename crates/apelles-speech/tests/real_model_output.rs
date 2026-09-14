//! The span extractor against REAL Silero output (D-318).
//!
//! **Why this tier exists.** `silence.rs`'s own unit tests use hand-built
//! probability tracks with hand-computed answers — they prove the state machine
//! is the state machine we meant. They cannot prove it survives a real model's
//! output, which is noisy in ways a clean fixture never is: probabilities that
//! flicker across a threshold mid-word, a ramp rather than a step at each edge
//! of a pause, and a first frame that is already mid-utterance.
//!
//! So this replays a probability track **captured from the real
//! `silero_vad_v6.2.1.onnx`** (`fixtures/silero_v6_say_fixture.json`) over a
//! real 5.27 s speech clip containing one deliberate ~1.6 s pause, and asserts
//! the extractor finds that pause and nothing else.
//!
//! **What it deliberately does not do: run the model.** Doing that here would
//! make this suite depend on a 2 MB download and a correctly located ONNX
//! Runtime shared library, which would make `cargo test` fail on a clean
//! checkout for reasons that have nothing to do with this crate. The model is
//! exercised end-to-end by the app's own command instead; what is captured here
//! is its *output*, which is the input to everything this crate decides.

use apelles_speech::silence::{SilenceParams, silence_spans};

#[derive(serde::Deserialize)]
struct Fixture {
    window: usize,
    sample_rate: usize,
    samples: usize,
    probs: Vec<f32>,
}

fn fixture() -> Fixture {
    let raw = include_str!("fixtures/silero_v6_say_fixture.json");
    serde_json::from_str(raw).expect("the captured VAD fixture parses")
}

#[test]
fn the_capture_matches_the_runners_own_constants() {
    let f = fixture();
    assert_eq!(f.window, apelles_speech::vad::WINDOW_SAMPLES);
    assert_eq!(f.sample_rate, apelles_speech::SAMPLE_RATE as usize);
    // Whole windows only — the runner does not score a trailing partial one.
    assert_eq!(f.probs.len(), f.samples / f.window);
}

#[test]
fn the_deliberate_pause_is_found_and_nothing_else_is() {
    let f = fixture();
    let frame_secs = f.window as f64 / f.sample_rate as f64;
    let total_secs = f.samples as f64 / f.sample_rate as f64;

    let spans = silence_spans(&f.probs, frame_secs, total_secs, &SilenceParams::default());

    assert_eq!(
        spans.len(),
        1,
        "expected exactly the one scripted pause, got {spans:?}"
    );
    let gap = spans[0];

    // The clip is "The cat sat on the mat. <1.6s pause> The cat sat— the cat
    // sat on the mat." The pause sits between the two sentences, and its
    // measured length includes the natural sentence-boundary silence either
    // side of the scripted 1.6 s.
    assert!(
        gap.start_secs > 1.0 && gap.start_secs < 1.6,
        "the gap should open just after the first sentence, got {gap:?}"
    );
    assert!(
        gap.duration_secs() > 1.5 && gap.duration_secs() < 2.1,
        "the gap should be about the scripted 1.6s, got {:.3}s",
        gap.duration_secs()
    );
    assert!(
        gap.end_secs < total_secs,
        "speech resumes before the clip ends: {gap:?}"
    );
}

#[test]
fn a_stricter_minimum_rejects_the_same_pause() {
    let f = fixture();
    let frame_secs = f.window as f64 / f.sample_rate as f64;
    let total_secs = f.samples as f64 / f.sample_rate as f64;

    let strict = SilenceParams {
        min_silence_ms: 4000.0,
        ..SilenceParams::default()
    };
    assert!(
        silence_spans(&f.probs, frame_secs, total_secs, &strict).is_empty(),
        "a 1.7s pause must not survive a 4s minimum"
    );
}

/// Real model output must not produce a degenerate or out-of-range span —
/// the property every consumer of this crate relies on when it converts a span
/// to frames and hands it to a ripple delete.
#[test]
fn every_span_is_well_formed_and_inside_the_clip() {
    let f = fixture();
    let frame_secs = f.window as f64 / f.sample_rate as f64;
    let total_secs = f.samples as f64 / f.sample_rate as f64;

    for min_ms in [200.0, 400.0, 600.0, 1000.0] {
        let p = SilenceParams {
            min_silence_ms: min_ms,
            ..SilenceParams::default()
        };
        let spans = silence_spans(&f.probs, frame_secs, total_secs, &p);
        for s in &spans {
            assert!(s.start_secs >= 0.0, "{s:?} at min_ms={min_ms}");
            assert!(s.end_secs <= total_secs + 1e-9, "{s:?} at min_ms={min_ms}");
            assert!(s.duration_secs() > 0.0, "{s:?} at min_ms={min_ms}");
            assert!(
                s.duration_secs() >= min_ms / 1000.0 - 1e-9,
                "{s:?} is shorter than the {min_ms}ms minimum it was filtered by"
            );
        }
        // Spans must be disjoint and ordered.
        for pair in spans.windows(2) {
            assert!(
                pair[0].end_secs <= pair[1].start_secs,
                "overlapping spans: {pair:?}"
            );
        }
    }
}

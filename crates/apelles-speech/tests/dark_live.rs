//! The dark-region detector, run against a REAL recording and a REAL transcript
//! (D-349, B-216).
//!
//! **Why this is `#[ignore]`d, and why it exists anyway.** [`apelles_speech::dark`]'s
//! own unit tests cover the algorithm against fixtures with known-correct
//! answers, which is where the correctness lives. What they cannot cover is the
//! thing this detector is actually for: whether, on a real camera original and
//! the real whisper transcript of it, the findings are the utterances a human
//! can hear and the transcript does not contain. That needs a multi-GB source
//! file, a downloaded ONNX model and a located ONNX Runtime — none of which a
//! clean checkout has — so it is opt-in, exactly like [`silero_live`].
//!
//! **Running it**, on a source and a transcript you already have:
//!
//! ```text
//! ffmpeg -i source.MOV -f f32le -ac 1 -ar 16000 source.f32
//! ai-env/.venv/bin/python ai-media/transcribe.py --audio source.MOV --output source.json
//!
//! ORT_DYLIB_PATH=app/src-tauri/resources/libonnxruntime.dylib \
//! APELLES_SILERO_MODEL="$HOME/Library/Application Support/studio.apelles.app/models/silero_vad_v6.2.1.onnx" \
//! APELLES_DARK_PCM=source.f32 \
//! APELLES_DARK_TRANSCRIPT=source.json \
//!   cargo test -p apelles-speech --test dark_live -- --ignored --nocapture
//! ```
//!
//! Each reported region is a window to re-transcribe in isolation — which is
//! what `ai-media/transcribe.py --start-secs/--duration-secs` is for, and what
//! the app does automatically for a clip's own source range.
//!
//! **Three optional env vars, all there for the transcript harness** (D-374
//! step 3 / D-375). The harness is a pipeline of checks over the transcript
//! contract, in Python, and its VAD cross-check is *this* detector — not a
//! second copy of it. So it needs three things of a standalone run: to supply
//! the too-long-word bound that belongs to the backend rather than to the
//! algorithm, to get the report back as data rather than as printed lines, and
//! to be told which clock a windowed PCM dump is on.
//!
//! - `APELLES_DARK_MAX_WORD_SECS` overrides [`DarkParams::max_word_secs`],
//!   which is what `harness.vad.dark_params_for(profile)` emits. Omitted, the
//!   measured Whisper default stands.
//! - `APELLES_DARK_REPORT_JSON` writes the whole [`DarkReport`] to that path as
//!   JSON — the same `serde` shape `chroma_detect_dark_regions` already returns
//!   to the app — which `harness.vad.fold_dark_report` consumes directly.
//! - `APELLES_DARK_RANGE_START` is the absolute source second the PCM dump
//!   begins at, for a run over a WINDOW of a source rather than the whole of
//!   it (D-349). Transcript words are always in absolute source seconds, so
//!   without it a windowed PCM and its transcript are in two different clocks
//!   and every second before the window reads as dark. Defaults to 0.0, which
//!   is the whole-file case every existing caller is.
//!
//! [`silero_live`]: ../silero_live.rs

use std::path::{Path, PathBuf};

use apelles_speech::dark::{
    DarkInput, DarkParams, RMS_HOP_SECS, WordSpan, detect_dark_regions, rms_envelope,
};
use apelles_speech::vad::{FRAME_SECS, SAMPLE_RATE, SileroVad};

/// An optional `f64` from the environment, or `fallback`.
fn env_f64(key: &str, fallback: f64) -> f64 {
    match std::env::var(key) {
        Ok(raw) => raw
            .parse::<f64>()
            .unwrap_or_else(|e| panic!("{key}={raw:?} is not a number: {e}")),
        Err(_) => fallback,
    }
}

fn env_path(key: &str) -> PathBuf {
    PathBuf::from(
        std::env::var(key).unwrap_or_else(|_| {
            panic!("set {key} — see this file's module doc for the full command")
        }),
    )
}

fn read_f32le(path: &Path) -> Vec<f32> {
    let bytes = std::fs::read(path).expect("the PCM dump is readable");
    let (quads, rest) = bytes.as_chunks::<4>();
    assert!(
        rest.is_empty(),
        "a raw f32le dump is a multiple of 4 bytes long"
    );
    quads.iter().copied().map(f32::from_le_bytes).collect()
}

/// The flattened word list out of `ai-media/transcribe.py`'s own JSON — the
/// exact artefact the app caches, not a re-derived approximation of it.
fn read_words(path: &Path) -> Vec<WordSpan> {
    let text = std::fs::read_to_string(path).expect("the transcript is readable");
    let v: serde_json::Value = serde_json::from_str(&text).expect("the transcript is JSON");
    v["words"]
        .as_array()
        .expect("the transcript has word timings (--word-timestamps is the default)")
        .iter()
        .filter_map(|w| {
            Some(WordSpan {
                start_secs: w["start"].as_f64()?,
                end_secs: w["end"].as_f64()?,
            })
        })
        .collect()
}

#[test]
#[ignore = "needs the ONNX model + runtime + a real source and transcript; see the module doc"]
fn dark_regions_on_real_footage() {
    let mut vad = SileroVad::open(&env_path("APELLES_SILERO_MODEL")).expect("the model loads");
    let samples = read_f32le(&env_path("APELLES_DARK_PCM"));
    let words = read_words(&env_path("APELLES_DARK_TRANSCRIPT"));
    let total_secs = samples.len() as f64 / SAMPLE_RATE as f64;
    // Absolute source seconds the PCM begins at — 0.0 for a whole-file run.
    let range_start = env_f64("APELLES_DARK_RANGE_START", 0.0);

    let probs = vad
        .speech_probabilities(&samples)
        .expect("inference succeeds");
    let rms = rms_envelope(&samples, SAMPLE_RATE, RMS_HOP_SECS);

    let input = DarkInput {
        range_start_secs: range_start,
        range_secs: total_secs,
        words: &words,
        speech_probs: &probs,
        frame_secs: FRAME_SECS,
        rms: &rms,
        rms_hop_secs: RMS_HOP_SECS,
    };
    // The one parameter that is the BACKEND's rather than the algorithm's
    // (D-375). The harness supplies it per backend; a bare run keeps the
    // measured Whisper default, which is what every existing caller gets.
    let params = DarkParams {
        max_word_secs: env_f64(
            "APELLES_DARK_MAX_WORD_SECS",
            DarkParams::default().max_word_secs,
        ),
        ..DarkParams::default()
    };
    let report = detect_dark_regions(&input, &params);

    if let Ok(path) = std::env::var("APELLES_DARK_REPORT_JSON") {
        let json = serde_json::to_string_pretty(&report).expect("a DarkReport serialises");
        std::fs::write(&path, json).expect("the report path is writable");
        println!("report written to {path}");
    }

    println!(
        "source: {total_secs:.2}s from {range_start:.2}s, {} words, {} VAD frames",
        words.len(),
        probs.len()
    );
    println!(
        "speech {:.1}s, transcript coverage {:.1}s, floor {:?} from {} spans, {} gated out",
        report.speech_secs,
        report.covered_secs,
        report.rms_floor,
        report.calibration_spans,
        report.gated_out
    );
    for r in &report.regions {
        println!(
            "  {:8.2}-{:8.2}  ({:.2}s)  stretch {:.2}-{:.2} holding {:.2}s of speech, peak rms {:.4}",
            r.start_secs,
            r.end_secs,
            r.duration_secs(),
            r.stretch_start_secs,
            r.stretch_end_secs,
            r.stretch_speech_secs,
            r.rms_peak
        );
    }

    // Invariants that must hold of ANY real file, whatever it contains. They are
    // the ones a wrong coordinate conversion or a wrong clamp would break, and
    // every one of them is silent in production: a region outside the range
    // points a recovery at the wrong part of the file, and an out-of-order list
    // makes a splice interleave wrongly.
    let mut previous = f64::NEG_INFINITY;
    for r in &report.regions {
        assert!(
            r.start_secs >= range_start - 1e-6 && r.end_secs <= range_start + total_secs + 1e-6,
            "{r:?} escapes the analysed range"
        );
        assert!(r.end_secs > r.start_secs, "{r:?} is empty");
        assert!(
            r.duration_secs() >= params.min_region_secs - 1e-9,
            "{r:?} is under the minimum reportable region"
        );
        assert!(
            r.stretch_speech_secs >= params.min_dark_secs,
            "{r:?} did not clear the threshold it was flagged on"
        );
        assert!(
            r.stretch_start_secs <= r.start_secs && r.stretch_end_secs >= r.end_secs,
            "{r:?} is not inside its own stretch"
        );
        assert!(
            r.start_secs >= previous,
            "regions must be in time order: {r:?}"
        );
        previous = r.start_secs;
    }

    // Determinism on real data, not only on fixtures — the crate-wide invariant.
    assert_eq!(
        report,
        detect_dark_regions(&input, &params),
        "the same audio and the same transcript must give the same regions"
    );
}

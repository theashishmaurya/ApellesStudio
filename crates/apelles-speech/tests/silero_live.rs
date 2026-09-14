//! The real Silero model, really run (D-318/D-319).
//!
//! **Why this is `#[ignore]`d.** It needs two things a clean checkout does not
//! have: the 2 MB ONNX artifact (the app downloads it lazily on first use) and
//! a located ONNX Runtime shared library. A `cargo test` that failed for either
//! reason would be failing for something other than this crate's correctness,
//! so the default run covers the maths — `real_model_output.rs` replays a
//! probability track captured *from* this model — and this test covers the one
//! thing that cannot: that [`SileroVad`] drives the graph correctly.
//!
//! **Running it.** Point it at a verified model, a raw mono `f32le` @16 kHz
//! dump, and the runtime library:
//!
//! ```text
//! ORT_DYLIB_PATH=app/src-tauri/resources/libonnxruntime.dylib \
//! APELLES_SILERO_MODEL=/path/to/silero_vad_v6.2.1.onnx \
//! APELLES_SILERO_PCM=/path/to/clip.f32 \
//!   cargo test -p apelles-speech --test silero_live -- --ignored --nocapture
//! ```
//!
//! Produce the PCM from any clip with
//! `ffmpeg -i clip.wav -f f32le -ac 1 -ar 16000 clip.f32`.

use std::path::{Path, PathBuf};

use apelles_speech::silence::SilenceParams;
use apelles_speech::vad::{FRAME_SECS, SAMPLE_RATE, SileroVad};

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

#[test]
#[ignore = "needs the ONNX model + runtime; see the module doc"]
fn the_real_model_finds_the_pause_in_a_real_clip() {
    let mut vad = SileroVad::open(&env_path("APELLES_SILERO_MODEL")).expect("the model loads");
    let samples = read_f32le(&env_path("APELLES_SILERO_PCM"));
    let total_secs = samples.len() as f64 / SAMPLE_RATE as f64;

    let probs = vad
        .speech_probabilities(&samples)
        .expect("inference succeeds");
    let speech = probs.iter().filter(|p| **p >= 0.5).count();

    println!(
        "clip: {:.3}s, {} frames @ {:.3}s",
        total_secs,
        probs.len(),
        FRAME_SECS
    );
    println!("frames scored as speech: {speech}/{}", probs.len());

    // The catastrophic-and-silent failure mode this guards (see `vad.rs`'s
    // module doc): feeding v6 a bare 512-sample window pins every probability
    // near 0.001, so the whole clip reads as silence.
    assert!(
        speech > 0,
        "no frame scored as speech — the context window is almost certainly wrong"
    );
    assert!(
        speech < probs.len(),
        "every frame scored as speech — expected a real pause"
    );

    let spans = vad
        .silences(&samples, &SilenceParams::default())
        .expect("span extraction");
    for s in &spans {
        println!(
            "silence {:.3}s -> {:.3}s ({:.3}s)",
            s.start_secs,
            s.end_secs,
            s.duration_secs()
        );
    }

    for s in &spans {
        assert!(
            s.start_secs >= 0.0 && s.end_secs <= total_secs + 1e-9,
            "{s:?} escapes the clip"
        );
        assert!(
            s.duration_secs() >= 0.6,
            "{s:?} is under the default minimum"
        );
    }

    // Determinism: the recurrent state is per-call, so a second run of the same
    // samples through the same session must agree exactly (a project invariant
    // — CLAUDE.md's deterministic-render rule applied to analysis).
    let again = vad
        .speech_probabilities(&samples)
        .expect("second inference succeeds");
    assert_eq!(probs, again, "the same audio must score identically twice");
}

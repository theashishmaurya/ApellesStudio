//! What the corpus-tier integration tests share: one way to read a committed
//! transcript fixture off disk.
//!
//! **What it is.** A fixture is the verbatim whole-file output of
//! `ai-media/transcribe.py` on one of the owner's own camera originals, reduced
//! to `[start_secs, end_secs, text]` per segment — exactly the three fields
//! [`Utterance`] carries, and exactly what `editor_get_transcript` hands the
//! detector. No model, no audio, no network: plain JSON.
//!
//! **What it does NOT do.** It does not know which ASR backend produced a file,
//! or what any test asserts about it. Both corpus tiers — `real_transcripts.rs`
//! (the Whisper false-positive measurement, D-365) and `proposed_cuts.rs` (the
//! B-238 cut audit over every raw source, both backends, D-377) — call this and
//! then ask their own question, as does `retake_eval.rs` (the D-378 eval,
//! through [`load_path`]). Extracted here when the second caller appeared
//! rather than copied (`CLAUDE.md`: if two places need it, extract it).

use apelles_speech::retake::Utterance;

/// One fixture transcript, read from `tests/fixtures/<name>`.
///
/// `name` may contain a subdirectory — `transcripts/A001_….parakeet.json` — so
/// the per-source corpus added by D-377 sits in its own folder without needing a
/// second loader.
// Each integration-test binary compiles this module separately and uses a
// subset of it: `retake_eval.rs` reads by path only, so this is unused there.
#[allow(dead_code)]
pub fn load(name: &str) -> Vec<Utterance> {
    load_path(&format!(
        "{}/tests/fixtures/{name}",
        env!("CARGO_MANIFEST_DIR")
    ))
}

/// One transcript in the fixture format, read from any `path`.
///
/// What [`load`] reads with; also called directly by `retake_eval.rs` (D-378),
/// whose task set names transcripts by repo-relative path because its synthetic
/// control set lives under `eval/retake/`, not here.
pub fn load_path(path: &str) -> Vec<Utterance> {
    let raw = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("reading {path}: {e}"));
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

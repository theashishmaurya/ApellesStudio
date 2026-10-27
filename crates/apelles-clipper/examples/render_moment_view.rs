//! Print the moment view an MCP client reads to propose shorts (D-411).
//!
//! **What it is.** A thin command-line wrapper over [`apelles_clipper::analyse`] and
//! [`apelles_clipper::render_page`]: given one `ai-media/transcribe.py` JSON
//! output (with word timestamps), it prints the whole view the app serves —
//! from the transcript alone, so without the audio evidence tags (pace is
//! still measured; loudness, VAD and picture cuts are the app's passes). It is
//! how the clipper eval's judging half reproduces the client's input without
//! running the app, the way `render_word_transcript` does for retakes.
//!
//! **What it does NOT do.** It judges nothing.
//!
//! ```sh
//! cargo run -p apelles-clipper --example render_moment_view -- \
//!   eval/retake/transcripts/A001_09122356_C040.parakeet.words.json 30 60
//! ```

use std::error::Error;

use apelles_clipper::{
    AnalysisInput, SourceEvidence, TightenOptions, analyse, check_durations, render_page,
};
use apelles_speech::{TranscriptSegment, ViewPiece, index_pieces};
use serde::Deserialize;

/// The part of `transcribe.py`'s output this needs.
#[derive(Deserialize)]
struct Transcript {
    segments: Vec<TranscriptSegment>,
}

fn main() -> Result<(), Box<dyn Error>> {
    let mut args = std::env::args().skip(1);
    let path = args
        .next()
        .ok_or("usage: render_moment_view <transcribe.py output .json> [target seconds...]")?;
    let targets: Vec<u32> = args.map(|a| a.parse::<u32>()).collect::<Result<_, _>>()?;
    let durations = check_durations(if targets.is_empty() {
        &[30, 60]
    } else {
        &targets
    })?;
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("reading {path}: {e}"))?;
    let transcript: Transcript =
        serde_json::from_str(&raw).map_err(|e| format!("parsing {path}: {e}"))?;
    let end = transcript.segments.last().map_or(0.0, |s| s.end) + 1.0;
    let pieces = [ViewPiece {
        source: 0,
        start_secs: 0.0,
        end_secs: end,
    }];
    let view = index_pieces(std::slice::from_ref(&transcript.segments), &pieces)?;
    let evidence = [SourceEvidence::default()];
    let input = AnalysisInput {
        view: &view,
        pieces: &pieces,
        evidence: &evidence,
        retake_cuts: &[],
        durations: &durations,
        focus: None,
        tighten: TightenOptions::default(),
    };
    let analysis = analyse(&input);
    print!(
        "{}",
        render_page(&analysis, 0, analysis.sentences.len(), pieces.len())
    );
    Ok(())
}

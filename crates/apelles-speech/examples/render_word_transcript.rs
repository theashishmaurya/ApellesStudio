//! Print the word-indexed transcript view an MCP client reads (D-380).
//!
//! **What it is.** A thin command-line wrapper over
//! [`apelles_speech::index_transcript`] + [`apelles_speech::render_indexed`]:
//! given one `ai-media/transcribe.py` JSON output (the D-374 contract, with
//! word timestamps), it prints exactly the text the app hands a client to
//! propose retakes against. That is how a skill's eval loop reproduces the
//! app's input without running the app — the committed
//! `eval/retake/transcripts/*.parakeet.words.json` are such files.
//!
//! **What it does NOT do.** It judges nothing and resolves nothing; the gate
//! (`check_and_resolve`) is the app's side of the exchange.
//!
//! ```sh
//! cargo run -p apelles-speech --example render_word_transcript -- \
//!   eval/retake/transcripts/A001_09122356_C040.parakeet.words.json
//! ```

use std::error::Error;

use apelles_speech::{TranscriptSegment, index_transcript, render_indexed};
use serde::Deserialize;

/// The part of `transcribe.py`'s output this needs.
#[derive(Deserialize)]
struct Transcript {
    segments: Vec<TranscriptSegment>,
}

fn main() -> Result<(), Box<dyn Error>> {
    let path = std::env::args()
        .nth(1)
        .ok_or("usage: render_word_transcript <transcribe.py output .json>")?;
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("reading {path}: {e}"))?;
    let transcript: Transcript =
        serde_json::from_str(&raw).map_err(|e| format!("parsing {path}: {e}"))?;
    let (words, runs) = index_transcript(&transcript.segments);
    print!("{}", render_indexed(&words, &runs)?);
    Ok(())
}

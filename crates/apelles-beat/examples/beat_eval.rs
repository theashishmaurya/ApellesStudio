//! Print this crate's beat analysis of each file as one JSON line (D-413).
//!
//! The Rust half of the accuracy check in `eval/beats/`: the Python half runs
//! librosa on the same files and compares the two grids. Uncached (no
//! `media_cache` root is bound), so every run really analyses.
//!
//! ```sh
//! cargo run --release -p apelles-beat --example beat_eval -- [--meter N] [--hint BPM] FILE...
//! ```

use std::path::PathBuf;
use std::time::Instant;

use apelles_beat::BeatParams;
use apelles_beat::source::analyze_file;

fn main() -> Result<(), String> {
    let mut params = BeatParams::default();
    let mut files: Vec<PathBuf> = Vec::new();
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--meter" => {
                let v = args.next().ok_or("--meter needs a value")?;
                params.meter = v.parse().map_err(|e| format!("--meter {v}: {e}"))?;
            }
            "--hint" => {
                let v = args.next().ok_or("--hint needs a value")?;
                params.tempo_hint_bpm = Some(v.parse().map_err(|e| format!("--hint {v}: {e}"))?);
            }
            _ => files.push(PathBuf::from(a)),
        }
    }
    if files.is_empty() {
        return Err("usage: beat_eval [--meter N] [--hint BPM] FILE...".to_string());
    }
    for f in files {
        let started = Instant::now();
        let result = analyze_file(&f, &params, true).map_err(|e| e.to_string())?;
        let line = serde_json::json!({
            "file": f.display().to_string(),
            "seconds": started.elapsed().as_secs_f64(),
            "result": result.beats,
        });
        println!("{line}");
    }
    Ok(())
}

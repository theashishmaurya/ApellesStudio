//! Tauri bridge for musical beat analysis (D-413).
//!
//! **What it is.** One `#[tauri::command]`, `chroma_detect_beats`, that both
//! the Edit tab (the beat lane, beat snapping, `editor_detect_beats`,
//! `editor_snap_cuts_to_beats`) and the Motion tab (the soundtrack's beats on
//! the keyframe timeline, `motion_time_to_music`, `motion_snap_to_beats`)
//! call, so a person and an agent read literally the same grid.
//!
//! **What it does NOT do.** No analysis and no caching of its own: both are
//! `apelles_beat::source::analyze_file` (decode → analyse → cache by content
//! hash in `media_cache`). No timeline or manifest knowledge: it answers "where
//! are the beats in this FILE, in seconds from its start"; mapping that onto a
//! clip or a scene is the frontend op layer's job. Nothing destructive.

use apelles_beat::BeatParams;

/// Analyse `path`'s audio for tempo, beats, downbeats and accents.
///
/// `meter` is beats per bar (default 4); `tempo_hint_bpm` centres the tempo
/// prior when the music is far from 120 BPM; `force` re-analyses even when a
/// cached answer for these exact bytes and params exists.
///
/// Answers `{path, contentHash, params, truncated, cached, analysis}`, where
/// `analysis` is `apelles_beat::BeatAnalysis` (camelCase).
#[tauri::command]
pub async fn chroma_detect_beats(
    path: String,
    meter: Option<u32>,
    tempo_hint_bpm: Option<f64>,
    force: Option<bool>,
) -> Result<serde_json::Value, String> {
    let params = BeatParams {
        meter: meter.unwrap_or(apelles_beat::DEFAULT_METER),
        tempo_hint_bpm,
    };
    params.validate().map_err(|e| e.to_string())?;
    let file = std::path::PathBuf::from(&path);
    if !file.is_file() {
        return Err(format!("no such audio file: {path}"));
    }
    let force = force.unwrap_or(false);
    // Hashing, decoding and the FFTs are all CPU/IO-bound; keep them off the
    // async runtime's worker threads, like every other analysis command.
    let result = tokio::task::spawn_blocking(move || {
        apelles_beat::source::analyze_file(&file, &params, force)
    })
    .await
    .map_err(|e| format!("beat analysis task: {e}"))?
    .map_err(|e| e.to_string())?;
    log::info!(
        "[beats] {path}: {} BPM, {} beats ({})",
        result.beats.analysis.tempo_bpm,
        result.beats.analysis.beats.len(),
        if result.cached { "cached" } else { "analysed" }
    );
    let mut out =
        serde_json::to_value(&result.beats).map_err(|e| format!("serialising beats: {e}"))?;
    if let Some(obj) = out.as_object_mut() {
        obj.insert("path".to_string(), serde_json::Value::String(path));
        obj.insert("cached".to_string(), serde_json::Value::Bool(result.cached));
    }
    Ok(out)
}

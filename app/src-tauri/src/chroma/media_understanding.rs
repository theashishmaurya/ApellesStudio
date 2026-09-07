//! Tauri bridge for media understanding via the `ai-media/` sidecar (D-184).
//!
//! What it is: the app-side half of the media-understanding capability — four
//! `#[tauri::command]`s that start and poll the two background jobs the
//! `ai-media/` sidecar runs. Everything they wrap lives in
//! `chroma_ai::media_understanding` (D-039 §1 / D-145's rule: the wire work is
//! crate-side, only the `#[tauri::command]` attribute stays in the fork). Same
//! shape as `chroma/depth.rs`, which wraps `chroma_ai::depth` the same way.
//!
//! What it does NOT do: no caching (the `@chroma/editor` store owns that, so a
//! repeated ask for the same file is free and a future UI has one place to read
//! from), no polling loop of its own (the frontend drives it), no
//! interpretation of the results, and nothing at all with the timeline — these
//! commands answer questions about a file on disk and return the sidecar's JSON
//! verbatim.
//!
//! Unlike `chroma/depth.rs`, these take an explicit `path` instead of reading
//! `chroma::state::current_video()`: the Edit tab analyses media-pool items,
//! which are not necessarily the Colorist's currently-loaded clip.

/// Start a word-level transcript of `path` (audio or video). Returns the sidecar
/// job (`job_id`, `state`) immediately; poll [`chroma_transcribe_status`].
///
/// `language` is an ISO code ("en", "hi") or `None` to auto-detect.
/// `word_timestamps` defaults to true — false is faster but returns
/// segment-level timings only, which is not enough to cut to an exact word.
#[tauri::command]
pub async fn chroma_transcribe(
    path: String,
    language: Option<String>,
    word_timestamps: Option<bool>,
) -> Result<serde_json::Value, String> {
    chroma_ai::media_understanding::transcribe(&path, language, word_timestamps).await
}

/// Poll a transcript job started by [`chroma_transcribe`].
#[tauri::command]
pub async fn chroma_transcribe_status(job_id: String) -> Result<serde_json::Value, String> {
    chroma_ai::media_understanding::transcribe_status(&job_id).await
}

/// Start a video-understanding pass over `path` — "what changed on screen, and
/// when." Returns the sidecar job (`job_id`, `state`) immediately; poll
/// [`chroma_analyze_video_status`].
///
/// `scene_threshold` / `min_gap_s` / `max_candidates` are content-dependent
/// tuning knobs (a fast-cut ad needs different values than a slow screen
/// recording); `None` leaves the sidecar's own defaults in place.
#[tauri::command]
pub async fn chroma_analyze_video(
    path: String,
    question: Option<String>,
    scene_threshold: Option<f64>,
    min_gap_s: Option<f64>,
    max_candidates: Option<u32>,
) -> Result<serde_json::Value, String> {
    chroma_ai::media_understanding::understand_video(
        &path,
        question,
        scene_threshold,
        min_gap_s,
        max_candidates,
    )
    .await
}

/// Poll a video-understanding job started by [`chroma_analyze_video`].
#[tauri::command]
pub async fn chroma_analyze_video_status(job_id: String) -> Result<serde_json::Value, String> {
    chroma_ai::media_understanding::understand_video_status(&job_id).await
}

//! Tauri bridge for media understanding via the `ai-media/` sidecar (D-189).
//!
//! What it is: the app-side half of the media-understanding capability — four
//! `#[tauri::command]`s that start and poll the two background jobs the
//! `ai-media/` sidecar runs. Everything they wrap lives in
//! `apelles_ai::media_understanding` (D-039 §1 / D-145's rule: the wire work is
//! crate-side, only the `#[tauri::command]` attribute stays in the fork). Same
//! shape as `chroma/depth.rs`, which wraps `apelles_ai::depth` the same way.
//!
//! What it does NOT do: no caching (the `@apelles/editor` store owns that, so a
//! repeated ask for the same file is free and a future UI has one place to read
//! from), no polling loop of its own (the frontend drives it), no
//! interpretation of the results, and nothing at all with the timeline — these
//! commands answer questions about a file on disk and return the sidecar's JSON
//! verbatim.
//!
//! Unlike `chroma/depth.rs`, these take an explicit `path` instead of reading
//! `chroma::state::current_video()`: the Edit tab analyses media-pool items,
//! which are not necessarily the Colorist's currently-loaded clip.
//!
//! The ONE piece of judgement that is not pass-through is [`no_audio_message`]
//! — B-119's pre-flight refusal for a source that has no audio stream at all.
//! See its own doc for why the check belongs here and not in the sidecar.

use std::path::Path;

/// `Some(a message written for a human)` when `path` definitely has NO audio
/// stream, `None` when it has one **or when we could not tell** (B-119).
///
/// **What this is for.** `ai-media/transcribe.py` extracts a 16 kHz mono WAV
/// with `ffmpeg` before it hands anything to whisper. On a source with no audio
/// stream — a screen recording captured without audio, say — that `ffmpeg` call
/// correctly fails ("Output file #0 does not contain any stream"), and before
/// this the resulting `CalledProcessError` travelled all the way to the Edit
/// tab's own error line as a raw, 200-character subprocess dump naming a temp
/// path the user has never heard of.
///
/// **Why the check is here rather than only in the sidecar.** It reuses the
/// probe the rest of the app already trusts for exactly this question —
/// `apelles_media::VideoInfo::has_audio`, which is what `chroma_audio_play` gates
/// embedded-audio playback on and what `waveform_peaks` returns an empty
/// envelope for — through the same disk-backed `probe_cached` (D-128), so there
/// is one answer to "does this file have sound", not two that can disagree. It
/// also refuses *before* the job starts, so the user gets the message
/// immediately instead of after the sidecar has spun up a ~3 GB whisper
/// subprocess to fail. `transcribe.py` keeps its own translation of the same
/// ffmpeg failure (`errors.UserFacingError`) — that is the sidecar being correct
/// on its own for callers that are not this app, not a second source of truth.
///
/// **`None` when we could not tell is deliberate.** An unprobeable path is not
/// evidence of silence, and turning a failed probe into a refusal would break
/// transcription of any container `ffprobe` cannot read but `symphonia`/whisper
/// can. The sidecar remains the backstop for that case.
pub(crate) fn no_audio_message(path: &str) -> Option<String> {
    let info = super::edit::probe_cached(Path::new(path)).ok()?;
    if info.has_audio {
        return None;
    }
    let name = Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(path);
    Some(format!(
        "“{name}” has no audio to transcribe — this file has no audio stream at all, \
         so there is nothing to turn into words. Use a clip that was recorded with sound."
    ))
}

/// Start a word-level transcript of `path` (audio or video). Returns the sidecar
/// job (`job_id`, `state`) immediately; poll [`chroma_transcribe_status`].
///
/// `language` is an ISO code ("en", "hi") or `None` to auto-detect.
/// `word_timestamps` defaults to true — false is faster but returns
/// segment-level timings only, which is not enough to cut to an exact word.
///
/// Refuses up front, with a readable message, when the source has no audio
/// stream at all — see [`no_audio_message`] (B-119).
#[tauri::command]
pub async fn chroma_transcribe(
    path: String,
    language: Option<String>,
    word_timestamps: Option<bool>,
) -> Result<serde_json::Value, String> {
    // `spawn_blocking` for the same reason every other `probe_cached` caller on
    // this surface uses it: a cold probe is two `ffprobe` spawns and must not
    // sit on Tauri's main thread.
    let probe_path = path.clone();
    let refusal = tokio::task::spawn_blocking(move || no_audio_message(&probe_path))
        .await
        .map_err(|e| format!("probing {path} for an audio stream: {e}"))?;
    if let Some(message) = refusal {
        log::info!("[media] transcribe: refusing {path} — no audio stream");
        return Err(message);
    }
    apelles_ai::media_understanding::transcribe(&path, language, word_timestamps).await
}

/// Poll a transcript job started by [`chroma_transcribe`].
#[tauri::command]
pub async fn chroma_transcribe_status(job_id: String) -> Result<serde_json::Value, String> {
    apelles_ai::media_understanding::transcribe_status(&job_id).await
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
    apelles_ai::media_understanding::understand_video(
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
    apelles_ai::media_understanding::understand_video_status(&job_id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// Synthesize a real, probeable media file with `ffmpeg`; `None` when
    /// `ffmpeg` is absent. Same "generate the fixture at test time rather than
    /// commit a binary" convention as `chroma::project`'s own `make_test_clip`
    /// and `apelles_media::audio`'s `synth_test_tone` — `lavfi` sources only, so
    /// the two files below differ in exactly the one property under test.
    fn synth(tag: &str, args: &[&str]) -> Option<PathBuf> {
        let out = std::env::temp_dir().join(format!(
            "chroma_b114_{tag}_{}_{:?}.mp4",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_file(&out);
        let status = std::process::Command::new("ffmpeg")
            .args(["-hide_banner", "-loglevel", "error", "-y"])
            .args(args)
            .arg(&out)
            .status()
            .ok()?;
        (status.success() && out.exists()).then_some(out)
    }

    /// B-119 — the whole point: a real file with a real video stream and NO
    /// audio stream must be refused with a sentence, not with the sidecar's
    /// `CalledProcessError: Command ['ffmpeg', …] returned non-zero exit status
    /// 234.` that the owner actually saw in the Edit tab.
    #[test]
    fn a_video_only_source_is_refused_with_a_readable_message() {
        let Some(silent) = synth(
            "silent",
            &[
                "-f",
                "lavfi",
                "-i",
                "color=black:size=64x64:duration=1:rate=24",
                "-pix_fmt",
                "yuv420p",
                "-an",
            ],
        ) else {
            eprintln!("skip: ffmpeg not on PATH");
            return;
        };

        let message = no_audio_message(silent.to_str().unwrap())
            .expect("a video-only source must be refused, not passed to the sidecar");
        assert!(
            message.contains("no audio to transcribe"),
            "the refusal must say what is wrong in words: {message}"
        );
        assert!(
            message.contains(silent.file_name().unwrap().to_str().unwrap()),
            "the refusal must name the file the user picked: {message}"
        );
        // The exact failure mode this exists to prevent: no subprocess dump, no
        // temp path, no exception class name.
        for leak in ["CalledProcessError", "exit status", "ffmpeg", "/tmp"] {
            assert!(
                !message.contains(leak),
                "the refusal leaks {leak:?} from the failing subprocess: {message}"
            );
        }
        let _ = std::fs::remove_file(&silent);
    }

    /// The other half of the same rule, and the reason this is a probe rather
    /// than a filename check: a source that DOES carry audio must not be
    /// refused. Same synthesis, one `sine` input added.
    #[test]
    fn a_source_with_a_real_audio_stream_is_not_refused() {
        let Some(sounded) = synth(
            "sounded",
            &[
                "-f",
                "lavfi",
                "-i",
                "color=black:size=64x64:duration=1:rate=24",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=1:sample_rate=48000",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-shortest",
            ],
        ) else {
            eprintln!("skip: ffmpeg not on PATH");
            return;
        };

        assert_eq!(
            no_audio_message(sounded.to_str().unwrap()),
            None,
            "a source with a real audio stream must reach the sidecar"
        );
        let _ = std::fs::remove_file(&sounded);
    }

    /// An unprobeable path is NOT evidence of silence — see
    /// [`no_audio_message`]'s doc. Refusing here would break transcription of
    /// any container `ffprobe` cannot read but whisper can.
    #[test]
    fn a_path_that_cannot_be_probed_is_not_refused() {
        let missing = std::env::temp_dir().join("chroma_b114_does_not_exist.mov");
        let _ = std::fs::remove_file(&missing);
        assert_eq!(no_audio_message(missing.to_str().unwrap()), None);
    }
}

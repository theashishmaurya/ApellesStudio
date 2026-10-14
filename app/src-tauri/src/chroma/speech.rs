//! Tauri bridge for silence + retake + dark-region detection (D-318, D-349).
//!
//! **What it is.** The app-side half of `apelles-speech`: three
//! `#[tauri::command]`s that both the Edit tab's Recut panel and the
//! `editor_detect_*` MCP ops go through, so the human and the agent are
//! running literally the same detector rather than two that can drift.
//!
//! The division of labour is the crate's boundary, not this file's invention:
//!
//! - this module does the **I/O** — locating and verifying the ONNX model,
//!   decoding the clip's audio to the 16 kHz mono the model needs, and holding
//!   the loaded session;
//! - `apelles_speech` does the **thinking** — probabilities, hysteresis,
//!   grouping — over data it is handed, with no idea where any of it came from.
//!
//! **What it does NOT do.** No caching (the `@apelles/editor` store owns that,
//! exactly as it does for transcripts — see `media_understanding.rs`), no
//! timeline knowledge (these commands answer questions about a *range of a file
//! on disk*; mapping a clip to that range, and the resulting seconds back to
//! source frames, is the op layer's job), and **nothing destructive**. Both
//! commands are pure reads that propose spans. Applying one is the timeline's
//! business, through ops that already existed (D-318).
//!
//! The model is fetched lazily on first use rather than bundled — it is 2.3 MB
//! and most sessions never ask for a recut. That is the same call
//! `ai_processing.rs` makes for its seven models, and this reuses that module's
//! own download-and-verify helper rather than growing a second one.

use std::sync::Mutex;

use apelles_speech::dark::{
    DarkInput, DarkParams, RMS_HOP_SECS, WordSpan, detect_dark_regions, rms_envelope,
};
use apelles_speech::retake::{RetakeParams, Utterance};
use apelles_speech::silence::SilenceParams;
use apelles_speech::vad::{
    FRAME_SECS, MODEL_FILENAME, MODEL_SHA256, MODEL_URL, SAMPLE_RATE, SileroVad,
};
use serde::Deserialize;

/// The one loaded VAD session, initialised on first use.
///
/// `tokio::sync::OnceCell` rather than `std::sync::OnceLock` because
/// initialisation is genuinely `async` (it may download the model) and
/// fallible — a failed first attempt must leave the cell empty so the next call
/// retries, which `get_or_try_init` gives us and `OnceLock` cannot express.
/// The inner `std::sync::Mutex` serialises inference: `ort::Session::run` needs
/// `&mut`, and one talking-head recut at a time is the real usage.
static VAD: tokio::sync::OnceCell<Mutex<SileroVad>> = tokio::sync::OnceCell::const_new();

/// Human-facing name for the download progress events `ai_processing` emits.
const MODEL_LABEL: &str = "Silero VAD";

/// The loaded session, downloading and verifying the model if this is the first
/// ask in this installation.
async fn vad_session(app: &tauri::AppHandle) -> Result<&'static Mutex<SileroVad>, String> {
    VAD.get_or_try_init(|| async {
        let models_dir = crate::ai_processing::get_models_dir(app)
            .map_err(|e| format!("locating the models directory: {e}"))?;

        crate::ai_processing::download_and_verify_model(
            app,
            &models_dir,
            MODEL_FILENAME,
            MODEL_URL,
            MODEL_SHA256,
            MODEL_LABEL,
        )
        .await
        .map_err(|e| format!("fetching the {MODEL_LABEL} model: {e}"))?;

        let path = models_dir.join(MODEL_FILENAME);
        // Loading parses a few MB of graph — off the main thread, like every
        // other model load on this surface.
        let loaded = tokio::task::spawn_blocking(move || SileroVad::open(&path))
            .await
            .map_err(|e| format!("loading the {MODEL_LABEL} model: {e}"))?
            .map_err(|e| e.to_string())?;
        Ok(Mutex::new(loaded))
    })
    .await
}

/// Find the stretches of `path` between `start_secs` and
/// `start_secs + duration_secs` where nobody is speaking.
///
/// Returns spans in **absolute source seconds** — the analysed range's offset is
/// already added back, so a caller never has to remember to. Converting those to
/// a clip's source frames needs an fps and is deliberately left to the op layer
/// (D-318).
///
/// `min_silence_ms` defaults to 600: roughly the shortest gap a person reads as
/// "they stopped talking" rather than "they took a breath".
///
/// Refuses up front, with a readable message, when the source has no audio
/// stream at all — the same `no_audio_message` pre-flight transcription uses
/// (B-119), so "this file has no sound" reads identically whichever capability
/// you asked for.
#[tauri::command]
pub async fn chroma_detect_silences(
    app: tauri::AppHandle,
    path: String,
    start_secs: f64,
    duration_secs: f64,
    min_silence_ms: Option<f64>,
) -> Result<serde_json::Value, String> {
    // `<=` rather than `!(> 0.0)` so a NaN is rejected by the `is_finite`
    // half rather than by the subtleties of negated float comparison.
    if !duration_secs.is_finite() || duration_secs <= 0.0 {
        return Err("duration_secs must be a finite number greater than zero".to_string());
    }
    let start = start_secs.max(0.0);

    let probe_path = path.clone();
    let refusal = tokio::task::spawn_blocking(move || {
        super::media_understanding::no_audio_message(&probe_path)
    })
    .await
    .map_err(|e| format!("probing {path} for an audio stream: {e}"))?;
    if let Some(message) = refusal {
        log::info!("[speech] detect_silences: refusing {path} — no audio stream");
        return Err(message);
    }

    let session = vad_session(&app).await?;

    let decode_path = path.clone();
    let samples = tokio::task::spawn_blocking(move || {
        apelles_media::audio::decode_mono_at_rate(
            std::path::Path::new(&decode_path),
            start,
            duration_secs,
            SAMPLE_RATE,
        )
    })
    .await
    .map_err(|e| format!("decoding audio for VAD: {e}"))??;

    let params = SilenceParams {
        min_silence_ms: min_silence_ms.unwrap_or(SilenceParams::default().min_silence_ms),
        ..SilenceParams::default()
    };

    // Inference is CPU-bound and holds a `std::sync::Mutex`; both belong off the
    // async runtime's worker threads.
    let analysed_secs = samples.len() as f64 / SAMPLE_RATE as f64;
    let spans = tokio::task::spawn_blocking(move || {
        let mut vad = session
            .lock()
            .map_err(|_| "the VAD session mutex was poisoned by an earlier panic".to_string())?;
        vad.silences(&samples, &params).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("running the VAD: {e}"))??;

    let spans: Vec<serde_json::Value> = spans
        .iter()
        .map(|s| {
            serde_json::json!({
                "start_secs": start + s.start_secs,
                "end_secs": start + s.end_secs,
                "duration_secs": s.duration_secs(),
            })
        })
        .collect();

    Ok(serde_json::json!({
        "source": path,
        "start_secs": start,
        "duration_secs": duration_secs,
        "analysed_secs": analysed_secs,
        "min_silence_ms": params.min_silence_ms,
        "model": MODEL_FILENAME,
        "silences": spans,
    }))
}

/// One transcript word, as the frontend store holds it. Times are absolute
/// SOURCE seconds — the same clock the transcript itself uses.
#[derive(Debug, Deserialize)]
pub struct TranscriptWordTime {
    pub start: f64,
    pub end: f64,
}

/// Find the stretches of `path` between `start_secs` and
/// `start_secs + duration_secs` where the VAD hears a voice and `words` has
/// nothing — the regions the ASR's whole-file pass silently dropped (D-349,
/// B-216).
///
/// **Takes the words rather than a path to them** for the same reason
/// [`chroma_detect_retakes`] does: the transcript is cached in the
/// `@apelles/editor` store, and asking for a path here would mean a second cache
/// or a second transcription pass. It takes the AUDIO as a path because
/// that is not cached anywhere and is cheap to decode.
///
/// Returns spans in **absolute source seconds**, offset already added back, the
/// same convention [`chroma_detect_silences`] keeps. Nothing is cut and nothing
/// is transcribed — recovering a region's words is an isolated re-transcription
/// of it (`ai-media/transcribe.py`'s `--start-secs`/`--duration-secs`), which
/// the op layer drives.
///
/// Refuses up front, with a readable message, when the source has no audio
/// stream at all — the same `no_audio_message` pre-flight (B-119).
// A Tauri command's arguments ARE its wire contract — they arrive as a flat JSON
// object from the frontend — so the usual "group them into a struct" remedy
// would change the contract rather than simplify it. Same allowance every other
// wide command in this fork carries (`ai_commands.rs`, `lens_blur.rs`, …).
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn chroma_detect_dark_regions(
    app: tauri::AppHandle,
    path: String,
    start_secs: f64,
    duration_secs: f64,
    words: Vec<TranscriptWordTime>,
    min_dark_secs: Option<f64>,
    max_word_secs: Option<f64>,
    rms_floor_scale: Option<f64>,
) -> Result<serde_json::Value, String> {
    if !duration_secs.is_finite() || duration_secs <= 0.0 {
        return Err("duration_secs must be a finite number greater than zero".to_string());
    }
    for (name, v) in [
        ("min_dark_secs", min_dark_secs),
        ("max_word_secs", max_word_secs),
        ("rms_floor_scale", rms_floor_scale),
    ] {
        if v.is_some_and(|v| !v.is_finite() || v <= 0.0) {
            return Err(format!("{name} must be a positive, finite number"));
        }
    }
    let start = start_secs.max(0.0);

    let probe_path = path.clone();
    let refusal = tokio::task::spawn_blocking(move || {
        super::media_understanding::no_audio_message(&probe_path)
    })
    .await
    .map_err(|e| format!("probing {path} for an audio stream: {e}"))?;
    if let Some(message) = refusal {
        log::info!("[speech] detect_dark_regions: refusing {path} — no audio stream");
        return Err(message);
    }

    let session = vad_session(&app).await?;

    let decode_path = path.clone();
    let samples = tokio::task::spawn_blocking(move || {
        apelles_media::audio::decode_mono_at_rate(
            std::path::Path::new(&decode_path),
            start,
            duration_secs,
            SAMPLE_RATE,
        )
    })
    .await
    .map_err(|e| format!("decoding audio for the dark-region scan: {e}"))??;

    let defaults = DarkParams::default();
    let params = DarkParams {
        min_dark_secs: min_dark_secs.unwrap_or(defaults.min_dark_secs),
        max_word_secs: max_word_secs.unwrap_or(defaults.max_word_secs),
        rms_floor_scale: rms_floor_scale.unwrap_or(defaults.rms_floor_scale),
        ..defaults
    };
    let words: Vec<WordSpan> = words
        .into_iter()
        .map(|w| WordSpan {
            start_secs: w.start,
            end_secs: w.end,
        })
        .collect();

    // The two knobs the response echoes back, read before `params` moves into
    // the blocking closure below.
    let (min_dark_secs, max_word_secs) = (params.min_dark_secs, params.max_word_secs);

    // Inference and the envelope are both CPU-bound, and the first holds a
    // `std::sync::Mutex` — neither belongs on the async runtime's workers.
    let analysed_secs = samples.len() as f64 / SAMPLE_RATE as f64;
    let report = tokio::task::spawn_blocking(move || -> Result<_, String> {
        let probs = {
            let mut vad = session.lock().map_err(|_| {
                "the VAD session mutex was poisoned by an earlier panic".to_string()
            })?;
            vad.speech_probabilities(&samples)
                .map_err(|e| e.to_string())?
        };
        let rms = rms_envelope(&samples, SAMPLE_RATE, RMS_HOP_SECS);
        Ok(detect_dark_regions(
            &DarkInput {
                range_start_secs: start,
                range_secs: analysed_secs,
                words: &words,
                speech_probs: &probs,
                frame_secs: FRAME_SECS,
                rms: &rms,
                rms_hop_secs: RMS_HOP_SECS,
            },
            &params,
        ))
    })
    .await
    .map_err(|e| format!("running the dark-region scan: {e}"))??;

    let regions: Vec<serde_json::Value> = report
        .regions
        .iter()
        .map(|r| {
            serde_json::json!({
                "start_secs": r.start_secs,
                "end_secs": r.end_secs,
                "duration_secs": r.duration_secs(),
                "stretch_start_secs": r.stretch_start_secs,
                "stretch_end_secs": r.stretch_end_secs,
                "stretch_speech_secs": r.stretch_speech_secs,
                "rms_peak": r.rms_peak,
            })
        })
        .collect();

    Ok(serde_json::json!({
        "source": path,
        "start_secs": start,
        "duration_secs": duration_secs,
        "analysed_secs": analysed_secs,
        "min_dark_secs": min_dark_secs,
        "max_word_secs": max_word_secs,
        "model": MODEL_FILENAME,
        "regions": regions,
        // The gate's own workings, so a caller can tell "this file is clean"
        // from "nothing here could be calibrated, so nothing was gated".
        "rms_floor": report.rms_floor,
        "calibration_spans": report.calibration_spans,
        "gated_out": report.gated_out,
        "speech_secs": report.speech_secs,
        "covered_secs": report.covered_secs,
    }))
}

/// One transcript segment as the frontend store holds it.
///
/// Deliberately a *subset* of `TranscriptSegment`: this detector needs when a
/// thing was said and what it was, and has no use for the per-word timings, so
/// it does not ask for them and cannot be broken by their shape changing.
#[derive(Debug, Deserialize)]
pub struct TranscriptUtterance {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

/// Group near-duplicate utterances — the takes where a speaker restarted a line.
///
/// Takes the transcript rather than a path on purpose: the transcript is cached
/// in the `@apelles/editor` store (there is no Rust-side cache — see
/// `media_understanding.rs`), so asking for a path here would mean either a
/// second cache or a second transcription pass. The caller already has
/// the words; this command turns them into groups.
///
/// Every group carries a recommended `keep` index — the **last** take, normally
/// the one the speaker settled on — as a *suggestion*. Nothing is cut (D-318).
///
/// A take is a **span** of adjacent utterances, not a single one, because
/// the ASR's segment boundaries do not line up with a speaker's restarts
/// (D-327, fixes B-198). Each group's `takes` say which of its `members` form
/// each delivery, and `keep` indexes `takes` — a caller that cuts "every member
/// except `keep`" rather than "every take except `keep`" will eat words the
/// speaker meant to keep.
///
/// Two independent signals decide whether two spans are the same take (D-365):
/// `similarity` ("the same line again") and `phrase_min_words` ("the same
/// *phrase* again, inside two otherwise-different sentences"). A pair matched by
/// either is a group. `phrase_min_words: 0` turns the second one off.
#[tauri::command]
pub async fn chroma_detect_retakes(
    utterances: Vec<TranscriptUtterance>,
    similarity: Option<f64>,
    window_secs: Option<f64>,
    min_words: Option<usize>,
    max_span_utterances: Option<usize>,
    phrase_min_words: Option<usize>,
) -> Result<serde_json::Value, String> {
    let defaults = RetakeParams::default();
    let params = RetakeParams {
        similarity: similarity.unwrap_or(defaults.similarity),
        window_secs: window_secs.unwrap_or(defaults.window_secs),
        min_words: min_words.unwrap_or(defaults.min_words),
        max_span_utterances: max_span_utterances
            .unwrap_or(defaults.max_span_utterances)
            .max(1),
        phrase_min_words: phrase_min_words.unwrap_or(defaults.phrase_min_words),
    };

    let utterances: Vec<Utterance> = utterances
        .into_iter()
        .enumerate()
        .map(|(index, u)| Utterance {
            index,
            start_secs: u.start,
            end_secs: u.end,
            text: u.text,
        })
        .collect();

    let groups = apelles_speech::retake::detect_retakes(&utterances, &params);

    Ok(serde_json::json!({
        "similarity": params.similarity,
        "window_secs": params.window_secs,
        "min_words": params.min_words,
        "max_span_utterances": params.max_span_utterances,
        "phrase_min_words": params.phrase_min_words,
        "utterances": utterances.len(),
        "groups": groups,
    }))
}

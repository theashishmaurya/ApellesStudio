//! HTTP client for the `ai-media/` sidecar — transcript + video understanding
//! (D-189).
//!
//! **What it is:** the wire half of Apelles' media-understanding capability.
//! Four thin async functions, one per `ai-media/server.py` endpoint: start a
//! transcript job, poll it, start a video-analysis job, poll it. Same shape and
//! the same error discipline as [`crate::depth`]'s `/depth_track` client
//! (D-036/D-067) — check the HTTP status *before* parsing the body, then check
//! the parsed body for an `error` key, so a differently-broken sidecar fails
//! loudly here instead of silently downstream.
//!
//! **What it does NOT do:** no `#[tauri::command]` (D-039 §1 — commands do not
//! move; the wrappers live in `app/src-tauri/src/chroma/media_understanding.rs`),
//! no knowledge of the timeline or the media pool, no caching (the frontend
//! store owns the in-memory cache; its on-disk half is
//! [`crate::understanding_cache`], D-385), and no interpretation of the
//! results — it hands the sidecar's JSON back verbatim.
//!
//! **Why both capabilities are start-then-poll rather than one blocking call**
//! (D-189): `chroma::control`'s `BRIDGE_TIMEOUT` is 20 s, and these jobs run for
//! tens of seconds (transcript) to minutes (video analysis, roughly 4x
//! realtime). Blocking would put the result permanently out of an agent's reach.
//! Identical reasoning, and identical `{job_id}` → `{state, result?}` shape, to
//! `/track` and `/depth_track`.

use serde_json::json;

/// The ASR model every transcript this app asks for comes from — pinned on
/// every `/transcribe` request rather than left to the sidecar's default
/// (D-385). The persisted transcripts in [`crate::understanding_cache`] are
/// keyed by it, so the model a record claims and the model a request runs are
/// one value: a model change here is a clean cache miss, and a sidecar whose
/// default drifted can never hand back words from a model the key does not
/// name (it validates `model` against its published list and refuses an
/// unknown one). Must name a model in `ai-media/asr/parakeet_mlx.py`'s
/// descriptor — the only ASR backend since D-381.
pub const ASR_MODEL: &str = "parakeet-tdt-0.6b-v3";

/// The `ai-media/` sidecar's base URL — `http://127.0.0.1:<CHROMA_AI_MEDIA_PORT
/// or 8766>`. Deliberately separate from [`crate::sidecar_base_url`]: this is a
/// different process on a different port (D-189), and conflating them would send
/// transcript requests to the matting sidecar.
pub fn media_base_url() -> String {
    let port = std::env::var(crate::sidecar::AI_MEDIA.port_env)
        .unwrap_or_else(|_| crate::sidecar::AI_MEDIA.default_port.to_string());
    format!("http://127.0.0.1:{port}")
}

fn unreachable_hint(e: impl std::fmt::Display) -> String {
    // D-315 — prefixed with the `ai_env_not_ready` explanation when the shared Python
    // environment is still being built, so "we have not finished installing yet" is
    // distinguishable from "the sidecar died".
    crate::ai_env::explain_unreachable(format!(
        "Apelles media sidecar unreachable ({e}). The app auto-starts it (D-189) — check \
         the app log for '[sidecar/ai-media]' lines (CHROMA_AI_MEDIA_NO_SPAWN=1 disables the \
         auto-start; manual start: cd ai-media && ./run.sh). Both Python sidecars share one \
         environment, `ai-env/.venv` (D-314), which the app builds itself on first launch \
         (D-315) — `./ai-env/setup.sh` builds the same one by hand."
    ))
}

/// POST/GET plumbing shared by all four calls. Kept in one place so the
/// status-then-body error discipline (D-067's lesson: a stale sidecar 404s with
/// `{"detail":"Not Found"}`, which parses fine and has no `error` key, so an
/// unchecked caller silently returns `Ok` with nothing in it) cannot be
/// forgotten by one of them.
async fn call(what: &str, request: reqwest::RequestBuilder) -> Result<serde_json::Value, String> {
    let response = request.send().await.map_err(|e| {
        let msg = unreachable_hint(e);
        log::error!("[media] {what}: sidecar unreachable: {msg}");
        msg
    })?;

    let status = response.status();
    let text = response.text().await.map_err(|e| {
        log::error!("[media] {what}: couldn't read sidecar response body: {e}");
        e.to_string()
    })?;
    if !status.is_success() {
        log::error!("[media] {what}: sidecar returned HTTP {status}: {text}");
        return Err(format!(
            "media sidecar returned HTTP {status}: {text} — if this is \"Not Found\", the \
             sidecar is probably a stale process from before this route existed; restart it \
             (kill whatever's on :8766, then `cd ai-media && ./run.sh`, or relaunch the app \
             if nothing was already running on that port)"
        ));
    }

    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| {
        log::error!("[media] {what}: bad sidecar response JSON: {e} (body: {text})");
        e.to_string()
    })?;
    if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
        log::error!("[media] {what}: sidecar returned an error: {err}");
        return Err(err.to_string());
    }
    Ok(v)
}

/// Start a transcript job over `path` (audio or video). Returns `{job_id, state,
/// ...}` immediately; poll [`transcribe_status`].
///
/// `language` is an ISO code for one of Parakeet's 25 European languages, or
/// `None` to let the model pick (it does not report which it chose). A language
/// outside that set (Hindi, D-381) is refused by the sidecar. `word_timestamps` defaults to true;
/// false is faster but returns segment-level timings only, which is not enough to
/// cut to a word.
///
/// `window` is `Some((start_secs, duration_secs))` to transcribe **one window**
/// of the source rather than all of it (D-349). Timestamps come back in absolute
/// source seconds either way, so a windowed result splices straight into a
/// whole-file one — which is the point: an isolated pass reads the multi-second
/// regions the ASR's whole-file pass silently declines to transcribe (B-216).
pub async fn transcribe(
    path: &str,
    language: Option<String>,
    word_timestamps: Option<bool>,
    window: Option<(f64, f64)>,
) -> Result<serde_json::Value, String> {
    log::info!(
        "[media] transcribe: starting for {path} (language={language:?}, window={window:?})"
    );
    let body = json!({
        "path": path,
        "model": ASR_MODEL,
        "language": language,
        "word_timestamps": word_timestamps.unwrap_or(true),
        "start_secs": window.map(|(start, _)| start),
        "duration_secs": window.map(|(_, duration)| duration),
    });
    let v = call(
        "transcribe",
        reqwest::Client::new()
            .post(format!("{}/transcribe", media_base_url()))
            .json(&body),
    )
    .await?;
    log::info!("[media] transcribe: job started, response: {v}");
    Ok(v)
}

/// Poll a `/transcribe` job. `{state: "running"|"done"|"error"|"unknown",
/// elapsed_s, result?, error?}`.
pub async fn transcribe_status(job_id: &str) -> Result<serde_json::Value, String> {
    let v = call(
        "transcribe_status",
        reqwest::Client::new().get(format!("{}/transcribe/{job_id}", media_base_url())),
    )
    .await?;
    log_terminal_state("transcribe_status", job_id, &v);
    Ok(v)
}

/// Start a video-understanding job over `path`. Returns `{job_id, state, ...}`
/// immediately; poll [`understand_video_status`].
///
/// `scene_threshold` / `min_gap_s` / `max_candidates` are content-dependent
/// tuning knobs, deliberately passed through rather than fixed here — a fast-cut
/// ad has far more real cuts per second than the slow screen recording the
/// defaults were tuned against. `None` leaves the sidecar's own default in place
/// rather than this layer inventing a second set.
pub async fn understand_video(
    path: &str,
    question: Option<String>,
    scene_threshold: Option<f64>,
    min_gap_s: Option<f64>,
    max_candidates: Option<u32>,
) -> Result<serde_json::Value, String> {
    log::info!("[media] understand_video: starting for {path} (question={question:?})");

    // Only send what the caller actually specified — the sidecar's pydantic model
    // supplies every default, and sending an explicit `null` for one would fail
    // its type validation rather than fall back.
    let mut body = serde_json::Map::new();
    body.insert("path".into(), json!(path));
    if let Some(q) = question {
        body.insert("question".into(), json!(q));
    }
    if let Some(t) = scene_threshold {
        body.insert("scene_threshold".into(), json!(t));
    }
    if let Some(g) = min_gap_s {
        body.insert("min_gap_s".into(), json!(g));
    }
    if let Some(m) = max_candidates {
        body.insert("max_candidates".into(), json!(m));
    }

    let v = call(
        "understand_video",
        reqwest::Client::new()
            .post(format!("{}/understand_video", media_base_url()))
            .json(&serde_json::Value::Object(body)),
    )
    .await?;
    log::info!("[media] understand_video: job started, response: {v}");
    Ok(v)
}

/// Poll an `/understand_video` job.
pub async fn understand_video_status(job_id: &str) -> Result<serde_json::Value, String> {
    let v = call(
        "understand_video_status",
        reqwest::Client::new().get(format!("{}/understand_video/{job_id}", media_base_url())),
    )
    .await?;
    log_terminal_state("understand_video_status", job_id, &v);
    Ok(v)
}

/// Log only the terminal states, not every poll — these loops run for as long as
/// the job takes and logging each tick would be noise. Same policy `depth.rs`
/// settled on in D-067.
fn log_terminal_state(what: &str, job_id: &str, v: &serde_json::Value) {
    if let Some(state) = v.get("state").and_then(|s| s.as_str())
        && matches!(state, "done" | "error" | "unknown")
    {
        // The full result can be a whole transcript — log the outcome, not the
        // payload, or app.log becomes unreadable after one call.
        log::info!(
            "[media] {what}({job_id}): terminal state {state}{}",
            v.get("error")
                .and_then(|e| e.as_str())
                .map(|e| format!(", error: {e}"))
                .unwrap_or_default()
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_base_url_uses_the_media_sidecars_own_port_not_the_ai_sidecars() {
        // The single most damaging copy-paste slip available in this file:
        // pointing transcript requests at :8765 (the matting sidecar), which
        // would 404 in a way D-067 already showed is easy to misread as "the
        // feature is broken."
        let url = media_base_url();
        assert!(
            url.ends_with(&format!(":{}", crate::sidecar::AI_MEDIA.default_port))
                || std::env::var(crate::sidecar::AI_MEDIA.port_env).is_ok(),
            "unexpected media base url: {url}"
        );
        assert_ne!(url, crate::sidecar_base_url());
    }
}

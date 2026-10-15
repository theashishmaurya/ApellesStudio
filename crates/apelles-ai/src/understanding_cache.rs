//! The on-disk half of the Edit tab's media understanding (D-385).
//!
//! **What it is:** one persisted record per *(source file, ASR model)* that
//! holds what the `@apelles/editor` media-understanding store would otherwise
//! have to re-derive on every launch: the file's whole-file transcript, its
//! D-349 dark-region recoveries, and the re-reads an MCP client APPLIED to it
//! (`editor_retranscribe_words apply: true`, D-380 step 2). Stored through
//! [`apelles_media::media_cache`] (D-128) — the same `app_cache_dir()/chroma`
//! store filmstrip tiles, probes and waveform peaks already live in — under its
//! own [`NAMESPACE`], not in a second cache.
//!
//! **What it does:** derives the record's key, and loads / saves it.
//! - The key is `blake3(media_cache::source_key(path) ‖ model ‖ schema)`.
//!   `source_key` is the file's identity (absolute path + mtime + size, see its
//!   own doc for why not a content hash), so a changed file misses. The model is
//!   [`ASR_MODEL`] — the one `transcribe` pins on every request — so a model
//!   change misses too instead of serving one model's words as another's.
//!   [`RECORD_SCHEMA`] is in the key so a shape change is a clean miss.
//! - The stored envelope repeats all three (plus the source path) and [`load`]
//!   re-checks them, so a record is only ever served to the exact question it
//!   answers — the key is how it is found, the envelope is how it is trusted.
//! - [`save`] refuses a transcript whose own `model` field names a different
//!   model than the key: a record must never claim words a model did not
//!   produce.
//!
//! **What it does NOT do:** no interpretation of the payloads — the transcript,
//! each recovery and each applied re-read travel as the sidecar's / the store's
//! JSON verbatim (the frontend owns their shape, exactly as it owns the live
//! one). It does not decide WHAT persists or WHEN — the store does (D-385:
//! dark scans, re-read previews, retake detections and retake proposals are
//! deliberately left out). No eviction of its own: `media_cache`'s LRU budget
//! covers this namespace like every other. No `#[tauri::command]` (D-039 §1) —
//! `app/src-tauri/src/chroma/media_understanding.rs` wraps these two calls.
//!
//! **Persistence is an optimisation here as everywhere in `media_cache`, with
//! one exception that is the reason this module exists:** an applied re-read is
//! the client's judgement, not something a re-run can recover, and losing it on
//! restart silently changed the word indices everyone reads (932 → 892 words on
//! C040, 2026-10-14). So a failed save is reported to the caller (`Err`), not
//! only logged.

use std::path::Path;

use apelles_media::media_cache;
use serde::{Deserialize, Serialize};

use crate::media_understanding::ASR_MODEL;

/// The `media_cache` namespace records live under.
pub const NAMESPACE: &str = "understanding";

/// The record shape's version. Bump it whenever [`UnderstandingRecord`] — or
/// what the store puts in its payloads — changes incompatibly: it is part of the
/// key, so every old record becomes a clean miss rather than a misread.
pub const RECORD_SCHEMA: u32 = 1;

/// What the store persists for one source file. Field names are the store's
/// own (`camelCase`), so the record crosses the Tauri boundary unchanged.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnderstandingRecord {
    /// The whole-file transcript — `ai-media/transcribe.py`'s result verbatim —
    /// or `None` when only recoveries / applied re-reads are held (a re-read can
    /// be applied before the whole-file transcript is first asked for).
    #[serde(default)]
    pub transcript: Option<serde_json::Value>,
    /// The D-349 dark-region recoveries, each a `RecoveredWindow`.
    #[serde(default)]
    pub recoveries: Vec<serde_json::Value>,
    /// The client re-reads APPLIED to this file, each a `RecoveredWindow`, **in
    /// the order applied** — the order is the splice order (a later one wins
    /// where two overlap), so it is part of the data, not an accident of it.
    #[serde(default)]
    pub applied_rereads: Vec<serde_json::Value>,
}

impl UnderstandingRecord {
    /// Nothing worth a disk write.
    pub fn is_empty(&self) -> bool {
        self.transcript.is_none() && self.recoveries.is_empty() && self.applied_rereads.is_empty()
    }
}

/// What is actually written: the record plus everything [`load`] re-checks.
#[derive(Debug, Serialize, Deserialize)]
struct StoredRecord {
    schema: u32,
    model: String,
    source: String,
    record: UnderstandingRecord,
}

/// The record's cache key for `path` under `model`. `Err` when the file cannot
/// be stat'ed — there is no identity to key on.
fn entry_key(path: &Path, model: &str) -> Result<String, String> {
    let source = media_cache::source_key(path)?;
    let mut hasher = blake3::Hasher::new();
    hasher.update(source.as_bytes());
    hasher.update(b"|");
    hasher.update(model.as_bytes());
    hasher.update(b"|");
    hasher.update(&RECORD_SCHEMA.to_le_bytes());
    Ok(hasher.finalize().to_hex().to_string())
}

/// The persisted record for `path`, or `None` on any miss: a file that cannot
/// be stat'ed, a changed file, a different model, an older schema, or no cache
/// at all. Never an error — a miss means "compute it", exactly as for every
/// other `media_cache` read.
pub fn load(path: &Path) -> Option<UnderstandingRecord> {
    load_for_model(path, ASR_MODEL)
}

/// Persist `record` for `path`, replacing whatever was there. A no-op for an
/// empty record.
pub fn save(path: &Path, record: &UnderstandingRecord) -> Result<(), String> {
    save_for_model(path, ASR_MODEL, record)
}

fn load_for_model(path: &Path, model: &str) -> Option<UnderstandingRecord> {
    let key = entry_key(path, model).ok()?;
    let stored: StoredRecord = media_cache::read_json(NAMESPACE, &key)?;
    let source = path.to_string_lossy();
    if stored.schema != RECORD_SCHEMA || stored.model != model || stored.source != source {
        log::warn!(
            "[understanding_cache] {} — stored envelope does not match the question \
             (schema {} / model {} / source {}); treating as a miss",
            path.display(),
            stored.schema,
            stored.model,
            stored.source
        );
        return None;
    }
    Some(stored.record)
}

fn save_for_model(path: &Path, model: &str, record: &UnderstandingRecord) -> Result<(), String> {
    if record.is_empty() {
        return Ok(());
    }
    if let Some(produced_by) = record
        .transcript
        .as_ref()
        .and_then(|t| t.get("model"))
        .and_then(|m| m.as_str())
        .filter(|m| *m != model)
    {
        return Err(format!(
            "not persisting {}: its transcript came from {produced_by}, but records are keyed \
             by {model}",
            path.display()
        ));
    }
    if media_cache::root().is_none() {
        return Err("the media cache is not initialised — nothing can be persisted".to_string());
    }
    let key = entry_key(path, model)?;
    let stored = StoredRecord {
        schema: RECORD_SCHEMA,
        model: model.to_string(),
        source: path.to_string_lossy().into_owned(),
        record: record.clone(),
    };
    media_cache::write_json(NAMESPACE, &key, &stored);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    fn ensure_root() {
        let dir = std::env::temp_dir().join(format!(
            "apelles_understanding_cache_test_{}",
            std::process::id()
        ));
        media_cache::init_for_tests(dir);
    }

    /// A real file per test, so each test owns its identity.
    fn source(tag: &str, bytes: &[u8]) -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "apelles_understanding_src_{tag}_{}.wav",
            std::process::id()
        ));
        std::fs::write(&p, bytes).expect("write fixture source");
        p
    }

    fn record() -> UnderstandingRecord {
        let window = json!({ "startSecs": 1.0, "durationSecs": 4.0 });
        UnderstandingRecord {
            transcript: Some(json!({
                "text": "hello there",
                "language": "en",
                "model": ASR_MODEL,
                "source": "x",
                "segments": [{ "start": 0.0, "end": 1.0, "text": "hello there", "words": [] }],
            })),
            recoveries: vec![json!({ "window": window, "segments": [] })],
            applied_rereads: vec![
                json!({ "window": { "startSecs": 9.0, "durationSecs": 2.0 }, "segments": [] }),
                json!({ "window": window, "segments": [] }),
            ],
        }
    }

    #[test]
    fn a_record_round_trips_through_disk_in_order() {
        ensure_root();
        let src = source("roundtrip", b"audio");
        let rec = record();
        save(&src, &rec).expect("save");
        let back = load(&src).expect("a saved record must load back");
        assert_eq!(back, rec);
        // The applied order IS the splice order — it must survive verbatim.
        assert_eq!(back.applied_rereads[0]["window"]["startSecs"], json!(9.0));
        let _ = std::fs::remove_file(&src);
    }

    #[test]
    fn saving_again_overwrites_the_record() {
        ensure_root();
        let src = source("overwrite", b"audio");
        save(&src, &record()).expect("first save");
        let mut forced = record();
        forced.transcript = Some(json!({ "text": "re-run", "model": ASR_MODEL, "segments": [] }));
        forced.applied_rereads.clear();
        save(&src, &forced).expect("second save");
        assert_eq!(load(&src), Some(forced));
        let _ = std::fs::remove_file(&src);
    }

    #[test]
    fn a_changed_file_misses() {
        ensure_root();
        let src = source("changed", b"audio");
        save(&src, &record()).expect("save");
        // A different length is a different identity on its own.
        std::fs::write(&src, b"audio, re-exported longer").expect("rewrite");
        assert_eq!(
            load(&src),
            None,
            "a changed file must not be served its old words"
        );
        let _ = std::fs::remove_file(&src);
    }

    #[test]
    fn a_different_model_misses() {
        ensure_root();
        let src = source("model", b"audio");
        let mut rec = record();
        rec.transcript = Some(json!({ "text": "x", "model": "some-older-asr", "segments": [] }));
        save_for_model(&src, "some-older-asr", &rec).expect("save under the old model");
        assert!(load_for_model(&src, "some-older-asr").is_some());
        assert_eq!(
            load(&src),
            None,
            "a record written for another model must not be served as {ASR_MODEL}'s"
        );
        let _ = std::fs::remove_file(&src);
    }

    #[test]
    fn a_transcript_from_another_model_is_refused_not_mislabelled() {
        ensure_root();
        let src = source("mislabel", b"audio");
        let mut rec = record();
        rec.transcript = Some(json!({ "text": "x", "model": "some-older-asr", "segments": [] }));
        let err = save(&src, &rec).expect_err("must refuse");
        assert!(err.contains("some-older-asr"), "{err}");
        assert_eq!(load(&src), None);
        let _ = std::fs::remove_file(&src);
    }

    #[test]
    fn a_missing_file_is_a_miss_and_an_unsaveable_one_is_an_error() {
        ensure_root();
        let missing = Path::new("/definitely/not/here.wav");
        assert_eq!(load(missing), None);
        assert!(save(missing, &record()).is_err());
    }

    #[test]
    fn an_empty_record_writes_nothing() {
        ensure_root();
        let src = source("empty", b"audio");
        save(&src, &UnderstandingRecord::default()).expect("empty save is a no-op");
        assert_eq!(load(&src), None);
        let _ = std::fs::remove_file(&src);
    }

    #[test]
    fn an_envelope_for_another_source_is_a_miss() {
        ensure_root();
        let src = source("envelope", b"audio");
        let key = entry_key(&src, ASR_MODEL).expect("key");
        let forged = StoredRecord {
            schema: RECORD_SCHEMA,
            model: ASR_MODEL.to_string(),
            source: "/some/other/file.wav".to_string(),
            record: record(),
        };
        media_cache::write_json(NAMESPACE, &key, &forged);
        assert_eq!(load(&src), None);
        let _ = std::fs::remove_file(&src);
    }
}

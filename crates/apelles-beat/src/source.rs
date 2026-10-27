//! A file's beats, decoded, analysed once and cached by content (D-413).
//!
//! **What it is.** The I/O shell around [`crate::analyze`]: decode a file's
//! default audio track to mono [`SAMPLE_RATE`] through `apelles-media` (the
//! same symphonia + rubato path the VAD and the waveforms use), analyse it,
//! and keep the answer in `apelles-media`'s disk cache (`media_cache`, D-128)
//! under the [`NAMESPACE`] namespace.
//!
//! **Keyed by content, not by path.** The key is
//! `blake3(content hash ‖ ALGORITHM_VERSION ‖ params)`, where the content hash
//! is the BLAKE3 of the file's bytes. The same song imported into a Motion
//! project (a content-addressed copy, D-404), sitting in the Edit media pool
//! and on a USB stick is analysed once. Hashing a file costs a full read,
//! which `media_cache::source_key`'s own doc rightly refuses for multi-GB
//! video on every lookup; so the content hash itself is memoised under
//! [`CONTENT_NAMESPACE`] by that cheap path + mtime + size key, and a file is
//! read in full only the first time it is seen in each version.
//!
//! **Trust.** A cached record repeats its content hash, algorithm version and
//! params, and [`load`] re-checks them: the key is how a record is found, the
//! envelope is how it is trusted (the `understanding_cache` rule, D-385).
//!
//! **What it does NOT do.** No timeline knowledge, no clip ranges: it always
//! analyses the whole file from its start (up to [`MAX_ANALYSIS_SECS`]), so
//! one cached grid serves every clip cut from it. Mapping file seconds to a
//! clip is the op layer's job.

use std::io::Read;
use std::path::Path;

use apelles_media::media_cache;
use serde::{Deserialize, Serialize};

use crate::spectrum::SAMPLE_RATE;
use crate::{ALGORITHM_VERSION, BeatAnalysis, BeatError, BeatParams, analyze};

/// Where analyses live in `media_cache`.
pub const NAMESPACE: &str = "beats";
/// Where path+mtime+size → content hash memos live.
pub const CONTENT_NAMESPACE: &str = "beats-content";
/// Longest stretch analysed, seconds. Music beds are minutes long; a two-hour
/// podcast's audio would be a gigabyte of PCM for a grid nobody needs, so the
/// answer says `truncated` instead.
pub const MAX_ANALYSIS_SECS: f64 = 20.0 * 60.0;

/// The persisted record (camelCase, crossing the Tauri boundary unchanged).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileBeats {
    /// BLAKE3 of the file's bytes, hex.
    pub content_hash: String,
    pub params: BeatParams,
    /// Whether the file is longer than [`MAX_ANALYSIS_SECS`] and only its
    /// start was analysed.
    pub truncated: bool,
    pub analysis: BeatAnalysis,
}

/// What [`analyze_file`] answers: the record plus whether it came from cache.
#[derive(Debug, Clone, PartialEq)]
pub struct FileBeatsResult {
    pub beats: FileBeats,
    pub cached: bool,
}

/// BLAKE3 of the file's bytes, memoised by path + mtime + size.
pub fn content_hash(path: &Path) -> Result<String, BeatError> {
    let memo_key = media_cache::source_key(path).map_err(BeatError::Io)?;
    if let Some(hash) = media_cache::read_json::<String>(CONTENT_NAMESPACE, &memo_key) {
        return Ok(hash);
    }
    let mut file = std::fs::File::open(path)
        .map_err(|e| BeatError::Io(format!("open {}: {e}", path.display())))?;
    let mut hasher = blake3::Hasher::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| BeatError::Io(format!("read {}: {e}", path.display())))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let hash = hasher.finalize().to_hex().to_string();
    media_cache::write_json(CONTENT_NAMESPACE, &memo_key, &hash);
    Ok(hash)
}

/// The cache key for one (content, params) question.
pub fn cache_key(content_hash: &str, params: &BeatParams) -> String {
    let mut h = blake3::Hasher::new();
    h.update(content_hash.as_bytes());
    h.update(&ALGORITHM_VERSION.to_le_bytes());
    h.update(&params.meter.to_le_bytes());
    match params.tempo_hint_bpm {
        Some(bpm) => {
            h.update(&[1]);
            h.update(&bpm.to_bits().to_le_bytes());
        }
        None => {
            h.update(&[0]);
        }
    }
    h.finalize().to_hex().to_string()
}

/// A cached record that answers exactly this question, or `None`.
pub fn load(content_hash: &str, params: &BeatParams) -> Option<FileBeats> {
    let rec: FileBeats = media_cache::read_json(NAMESPACE, &cache_key(content_hash, params))?;
    let trusted = rec.content_hash == content_hash
        && rec.params == *params
        && rec.analysis.algorithm_version == ALGORITHM_VERSION;
    trusted.then_some(rec)
}

/// The beats of `path`'s audio: from cache unless `force`, else decoded and
/// analysed (and then cached).
pub fn analyze_file(
    path: &Path,
    params: &BeatParams,
    force: bool,
) -> Result<FileBeatsResult, BeatError> {
    params.validate()?;
    let hash = content_hash(path)?;
    if !force && let Some(beats) = load(&hash, params) {
        return Ok(FileBeatsResult {
            beats,
            cached: true,
        });
    }
    let mut samples =
        apelles_media::audio::decode_mono_at_rate(path, 0.0, MAX_ANALYSIS_SECS + 1.0, SAMPLE_RATE)
            .map_err(|e| BeatError::Decode(format!("decoding {}: {e}", path.display())))?;
    let max_samples = (MAX_ANALYSIS_SECS * SAMPLE_RATE as f64) as usize;
    let truncated = samples.len() > max_samples;
    samples.truncate(max_samples);
    let analysis = analyze(&samples, params)?;
    let beats = FileBeats {
        content_hash: hash.clone(),
        params: *params,
        truncated,
        analysis,
    };
    media_cache::write_json(NAMESPACE, &cache_key(&hash, params), &beats);
    Ok(FileBeatsResult {
        beats,
        cached: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_key_names_every_input() {
        let p = BeatParams::default();
        let base = cache_key("abc", &p);
        assert_ne!(base, cache_key("abd", &p));
        assert_ne!(base, cache_key("abc", &BeatParams { meter: 3, ..p }));
        assert_ne!(
            base,
            cache_key(
                "abc",
                &BeatParams {
                    tempo_hint_bpm: Some(120.0),
                    ..p
                }
            )
        );
        assert_eq!(base, cache_key("abc", &p));
    }
}

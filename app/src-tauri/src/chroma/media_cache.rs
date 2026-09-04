//! Chroma's persistent, disk-backed media cache (D-128).
//!
//! What it is: the one place that answers "where do derived, expensive-to-
//!   recompute artefacts of a *source media file* live on disk, and how are
//!   they keyed so a stale one is never served?" Filmstrip tiles, `ffprobe`
//!   results and audio-waveform peaks all go through here.
//! What it does: resolves a cache root once (from `lib.rs`'s `setup`, the same
//!   `app_cache_dir()` Tauri path RapidRAW's own thumbnail/exif caches already
//!   use), derives a [`source_key`] from a source file's identity, and offers
//!   `read_blob`/`write_blob` + `read_json`/`write_json` over `<root>/<ns>/
//!   <aa>/<key>`. Also enforces a size budget by pruning least-recently-read
//!   entries.
//! What it does NOT do: no knowledge of *what* it is caching — no ffmpeg, no
//!   decode, no schema. It is a keyed byte store; the shape of each artefact
//!   belongs to its own module ([`super::filmstrip`], [`super::video`]).
//!   It is not a database — there is no index file, the filesystem is the
//!   index, so a partially-deleted cache directory is always still valid.
//!
//! **Why this exists (D-128).** Every cache Chroma had before this module was
//! a module-level `Lazy<Mutex<HashMap<..>>>` static — `edit::PROBE_CACHE`,
//! `edit::THUMB_CACHE` (D-119/D-121/D-124), `project::MANIFEST_CACHE` (D-114),
//! `state::THUMB_CACHE` (D-033). Every one of them dies with the process. That
//! is invisible during a session and very visible across one: reopening the
//! same project after quitting the app re-ran every `ffprobe`, re-decoded
//! every filmstrip frame and re-decoded every waveform, from scratch, every
//! time. Real NLEs (Premiere's Media Cache / peak files, Resolve's
//! `CacheClip`) all solve this the same way — a persistent, source-keyed
//! directory of derived artefacts — and so does RapidRAW's own still-image
//! thumbnail cache in this very repo (`file_management::
//! resolve_thumbnail_cache_dir`, `app_cache_dir()/thumbnails`, keyed on
//! blake3(path + mtime)). This is that, generalised for video.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::Serialize;
use serde::de::DeserializeOwned;

/// Set from `lib.rs`'s `setup` with Tauri's `app_cache_dir()`. A `OnceLock`
/// rather than an `AppHandle` threaded through every command: exactly the
/// shape `exif_processing::initialize_cache_dir` already established in this
/// codebase, and the alternative would mean adding an `AppHandle` parameter
/// to commands (`chroma_clip_thumbnails`, `chroma_audio_waveform`) that have
/// no other use for one and are called directly from tests.
static CACHE_ROOT: OnceLock<PathBuf> = OnceLock::new();

/// Total bytes the cache may occupy before [`prune_to_budget`] trims it.
/// Filmstrip chunks are the bulk of it and are small (~140 KB for 64 tiles of
/// a 4K source at the 104 px strip height), so this holds thousands of them —
/// far more than a real editing session touches — while staying a rounding
/// error next to the media itself.
const CACHE_BUDGET_BYTES: u64 = 1_024 * 1_024 * 1_024;
/// Prune down to this fraction of the budget when it is exceeded, so pruning
/// is occasional rather than continuous once the cache is full.
const PRUNE_TARGET_FRACTION: f64 = 0.8;

/// Bind the cache root. Called once, from `lib.rs`'s `setup`.
pub fn init(app_cache_dir: PathBuf) {
    let root = app_cache_dir.join("chroma");
    if let Err(e) = std::fs::create_dir_all(&root) {
        log::warn!(
            "[chroma::media_cache] could not create {}: {e} — persistent caching disabled this run",
            root.display()
        );
        return;
    }
    let _ = CACHE_ROOT.set(root);
}

/// The cache root, or `None` when [`init`] never ran (a unit test, or a
/// `app_cache_dir()` that could not be created). Every call site treats
/// `None` as "no persistence" and falls back to recomputing — persistence is
/// an optimisation, never a correctness requirement.
pub fn root() -> Option<&'static Path> {
    CACHE_ROOT.get().map(|p| p.as_path())
}

/// Test/CLI entry point: bind the root explicitly. Separate from [`init`] so
/// the production path stays "Tauri hands us `app_cache_dir()`" and a test
/// can point at a `tempdir` without a running Tauri app. Idempotent — the
/// first caller wins, matching `OnceLock` semantics.
#[cfg(test)]
pub fn init_for_tests(dir: PathBuf) {
    let _ = std::fs::create_dir_all(&dir);
    let _ = CACHE_ROOT.set(dir);
}

/// A source file's cache identity: `blake3(absolute path || mtime_nanos ||
/// len)`, hex.
///
/// **Why mtime + size and not a content hash** (the real call, documented
/// because it is the one thing that decides whether a stale tile can ever be
/// served). A content hash is strictly more correct: it catches an edit that
/// preserves both mtime and length. But it costs a full read of the file on
/// *every lookup* — the owner's own `A001_08302215_C019.MOV` is 2.3 GB, which
/// at blake3's real throughput is ~1-2 s per lookup, the same order as the
/// decode this cache exists to avoid. That would spend the entire win to
/// close a gap that requires someone to rewrite a video file in place to
/// exactly its old byte length without touching its mtime. mtime + size is
/// what RapidRAW's own thumbnail cache in this repo already keys on (mtime
/// alone, in fact — `compute_thumbnail_cache_hash`), and what NLE media
/// caches do in practice. A user who does hit the pathological case has the
/// same recourse every NLE gives them: delete the cache directory.
pub fn source_key(path: &Path) -> Result<String, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("stat {}: {e}", path.display()))?;
    let mtime_nanos = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut hasher = blake3::Hasher::new();
    hasher.update(path.to_string_lossy().as_bytes());
    hasher.update(&mtime_nanos.to_le_bytes());
    hasher.update(&meta.len().to_le_bytes());
    Ok(hasher.finalize().to_hex().to_string())
}

/// `<root>/<namespace>/<first two hex chars>/<key>` — the two-character fan-out
/// keeps any one directory from collecting tens of thousands of entries, which
/// is slow to enumerate on every filesystem this app targets.
fn entry_path(namespace: &str, key: &str) -> Option<PathBuf> {
    let root = root()?;
    let shard = key.get(..2).unwrap_or("__");
    Some(root.join(namespace).join(shard).join(key))
}

/// Cached bytes for `key`, or `None` on any miss — a missing file, an
/// unreadable one, or no cache root at all. Never an error: a cache read that
/// fails is a miss, and the caller recomputes.
pub fn read_blob(namespace: &str, key: &str) -> Option<Vec<u8>> {
    let path = entry_path(namespace, key)?;
    let bytes = std::fs::read(&path).ok()?;
    // Touch, so `prune_to_budget`'s least-recently-*used* ordering is real and
    // not merely least-recently-written. Best-effort: a failure here only
    // makes this entry look older than it is to the pruner.
    let now = filetime::FileTime::now();
    let _ = filetime::set_file_mtime(&path, now);
    Some(bytes)
}

/// Write `bytes` under `key`. Best-effort and non-fatal — a cache that cannot
/// be written is a cache that misses next time, not a failed operation, so
/// this logs and returns rather than propagating.
///
/// Writes to a sibling temp file and renames, so a crash or a concurrent
/// reader never sees a half-written entry (an entry is either absent or
/// complete — the property that lets [`read_blob`] trust what it reads
/// without a checksum).
pub fn write_blob(namespace: &str, key: &str, bytes: &[u8]) {
    let Some(path) = entry_path(namespace, key) else {
        return;
    };
    let Some(parent) = path.parent() else { return };
    if let Err(e) = std::fs::create_dir_all(parent) {
        log::warn!("[chroma::media_cache] create {}: {e}", parent.display());
        return;
    }
    let tmp = path.with_extension(format!("tmp{}", std::process::id()));
    let write = || -> std::io::Result<()> {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        std::fs::rename(&tmp, &path)
    };
    if let Err(e) = write() {
        log::warn!("[chroma::media_cache] write {}: {e}", path.display());
        let _ = std::fs::remove_file(&tmp);
    }
}

/// [`read_blob`] + JSON decode. A malformed entry is a miss, not an error —
/// the shape a cached type serialises to can legitimately change between
/// builds, and the correct response to "I can't read my own old cache entry"
/// is to recompute it, not to fail the operation.
pub fn read_json<T: DeserializeOwned>(namespace: &str, key: &str) -> Option<T> {
    let bytes = read_blob(namespace, key)?;
    serde_json::from_slice(&bytes).ok()
}

/// JSON encode + [`write_blob`].
pub fn write_json<T: Serialize>(namespace: &str, key: &str, value: &T) {
    match serde_json::to_vec(value) {
        Ok(bytes) => write_blob(namespace, key, &bytes),
        Err(e) => log::warn!("[chroma::media_cache] serialise {namespace}/{key}: {e}"),
    }
}

/// Total size of the cache, and every entry with its last-used time. Walks the
/// tree; only called from [`prune_to_budget`], never on a hot path.
fn scan() -> (u64, Vec<(PathBuf, std::time::SystemTime, u64)>) {
    let Some(root) = root() else {
        return (0, Vec::new());
    };
    let mut total = 0u64;
    let mut entries = Vec::new();
    for entry in walkdir::WalkDir::new(root).into_iter().flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let used = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
        total += meta.len();
        entries.push((entry.path().to_path_buf(), used, meta.len()));
    }
    (total, entries)
}

/// Trim the cache to [`PRUNE_TARGET_FRACTION`] of [`CACHE_BUDGET_BYTES`] by
/// deleting least-recently-read entries first, if it is over budget. Cheap
/// no-op when it isn't (one directory walk).
///
/// Called on a background thread at startup rather than after every write:
/// pruning mid-session would compete with the very decodes this cache exists
/// to avoid, and the budget is generous enough that a single session cannot
/// plausibly blow through it.
pub fn prune_to_budget() {
    let (total, mut entries) = scan();
    if total <= CACHE_BUDGET_BYTES {
        return;
    }
    let target = (CACHE_BUDGET_BYTES as f64 * PRUNE_TARGET_FRACTION) as u64;
    entries.sort_by_key(|(_, used, _)| *used);
    let mut freed = 0u64;
    let mut removed = 0usize;
    for (path, _, len) in entries {
        if total - freed <= target {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            freed += len;
            removed += 1;
        }
    }
    log::info!(
        "[chroma::media_cache] pruned {removed} entr(ies), {:.1} MB, cache was {:.1} MB",
        freed as f64 / 1e6,
        total as f64 / 1e6
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The cache root is a process-wide `OnceLock`, so these tests share one
    /// root and must not collide on keys. Each uses its own namespace.
    fn ensure_root() {
        let dir =
            std::env::temp_dir().join(format!("chroma_media_cache_test_{}", std::process::id()));
        init_for_tests(dir);
    }

    #[test]
    fn source_key_changes_when_the_file_changes() {
        let tmp = std::env::temp_dir().join(format!("chroma_key_{}.bin", std::process::id()));
        std::fs::write(&tmp, b"one").expect("write");
        let a = source_key(&tmp).expect("key a");
        // A different length is enough on its own — no need to wait out mtime
        // granularity for the property under test.
        std::fs::write(&tmp, b"one but longer").expect("rewrite");
        let b = source_key(&tmp).expect("key b");
        assert_ne!(a, b, "a changed source file must not reuse its cache key");
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn source_key_is_stable_for_an_unchanged_file() {
        let tmp =
            std::env::temp_dir().join(format!("chroma_key_stable_{}.bin", std::process::id()));
        std::fs::write(&tmp, b"same").expect("write");
        let a = source_key(&tmp).expect("key a");
        let b = source_key(&tmp).expect("key b");
        assert_eq!(a, b, "an unchanged file must hit the same cache entry");
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn source_key_of_a_missing_file_is_an_error_not_a_panic() {
        assert!(source_key(Path::new("/definitely/not/here.mov")).is_err());
    }

    #[test]
    fn blob_round_trips_through_disk() {
        ensure_root();
        write_blob("test_blob", "abcd1234", b"hello");
        assert_eq!(
            read_blob("test_blob", "abcd1234").as_deref(),
            Some(&b"hello"[..])
        );
    }

    #[test]
    fn a_missing_blob_is_a_miss_not_an_error() {
        ensure_root();
        assert!(read_blob("test_blob", "never_written_ffff").is_none());
    }

    #[test]
    fn json_round_trips_and_a_corrupt_entry_is_a_miss() {
        ensure_root();
        write_json("test_json", "k1", &vec![1u32, 2, 3]);
        assert_eq!(
            read_json::<Vec<u32>>("test_json", "k1"),
            Some(vec![1, 2, 3])
        );
        write_blob("test_json", "k2", b"{ not json");
        assert_eq!(read_json::<Vec<u32>>("test_json", "k2"), None);
    }
}

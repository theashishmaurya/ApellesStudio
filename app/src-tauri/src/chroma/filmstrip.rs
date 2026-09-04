//! Edit-tab filmstrip thumbnails: windowed, level-of-detail, disk-cached
//! (D-128). Supersedes the whole-clip strip of D-119/D-121/D-124.
//!
//! What it is: the backend behind `Filmstrip.tsx` — "give me picture tiles
//!   `step_secs` apart covering source seconds `[start, start + duration)` of
//!   this file."
//! What it does: quantises the requested spacing to a fixed power-of-two
//!   **level**, cuts the source's timeline into fixed **chunks** of tiles at
//!   that level, and serves each chunk from (1) a process-local memory cache,
//!   (2) a persistent on-disk cache ([`super::media_cache`]), or (3) a real
//!   `ffmpeg` extraction, in that order. Only (3) costs anything, only (3)
//!   takes a concurrency permit, and only (3) survives being needed twice.
//! What it does NOT do: no knowledge of clips, tracks, timelines or zoom —
//!   it deals in source-file seconds only. Which window to ask for is
//!   `Filmstrip.tsx`'s decision (it is the only thing that knows the scroll
//!   position). It also does not serve Colorist's poster frames, which are a
//!   separate, differently-sized artefact (`state::THUMB_CACHE`,
//!   `chroma_frame_thumbnails`).
//!
//! ## Why chunks instead of one strip per clip (D-128)
//!
//! D-124 fetched a fixed 64-frame summary of the whole clip and re-tiled it
//! at render time. That made zoom free, but it capped the filmstrip at 64
//! real pictures no matter how far in you zoomed: a 517-second clip at 90
//! px/s is 46,530 px wide, wants ~930 tiles, and had 64 — so each tile was
//! drawn 727 px wide from a 185 px picture. D-124 named that honestly as its
//! own deferred gap ("the correct fix is windowed extraction over the visible
//! scroll range, which is what Premiere and Resolve do"), and the owner then
//! hit it: a screenshot of our timeline at high zoom, tiles visibly smeared,
//! next to Palmier Pro's — clean, evenly-spaced, densely repeated real frames.
//!
//! Windowing and persistence want the *same* thing from the data shape, which
//! is why they land together. A whole-clip strip is useless to a disk cache:
//! it is keyed by the clip's trim, so two clips cut from one source share
//! nothing, and any change of visible range regenerates all of it. Chunks are
//! keyed by (source file, level, chunk index) — indexed from the **file's**
//! t=0, not the clip's — so they are shared across clips, across trims,
//! across scroll positions, across zoom levels that resolve to the same
//! level, and, once persisted, across app restarts.
//!
//! ## The cost model, measured
//!
//! Against the owner's own `A001_08302215_C019.MOV` (2.3 GB, 517s, 4K HEVC,
//! real keyframe interval 0.875s), on this machine:
//!
//! | what | cost |
//! |---|---|
//! | D-124's whole-clip 64-frame strip | 9.5s |
//! | one 64-tile chunk at 1s spacing (keyframe-only) | 1.7s |
//! | one 32-tile chunk at 0.25s spacing (every-frame) | 2.6s |
//! | one 64-tile chunk at 0.5s spacing, **no** keyframe gate | 8.1s |
//! | any chunk, second time (disk cache) | ~0s |
//!
//! Two things make a chunk cheap. First, `-ss`/`-t` as *input* options bound
//! how much of the file ffmpeg reads at all. Second — the bigger lever — the
//! keyframe-only decode is gated on the file's **own measured** keyframe
//! interval ([`super::video::probe_keyframe_interval`], 0.23s, packet-level,
//! no decoding) instead of D-124's fixed 4-second guess, which forced the
//! expensive every-frame path for every spacing under 4s even on footage with
//! keyframes nine times denser than that.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use once_cell::sync::Lazy;
use serde::Serialize;

use super::edit::probe_cached;
use super::media_cache;
use super::video::{self, VideoInfo};

// --------------------------------------------------------------------------- //
// the level-of-detail ladder — pure arithmetic, unit-tested below
// --------------------------------------------------------------------------- //

/// Tile spacings, in seconds of source, on a power-of-two ladder.
///
/// The range is derived from the zoom range the UI actually allows, not
/// picked: a tile is drawn ~50 px wide (`Filmstrip.tsx`'s `PX_PER_FRAME`) and
/// zoom runs 1–480 px/s (`ruler.ts`'s `MIN_PX_PER_SEC`/`MAX_PX_PER_SEC`), so a
/// tile spans 50/480 = 0.104s at the tightest zoom and 50s at the widest.
/// `0.0625` and `64` bracket that with a step to spare at each end.
///
/// Powers of two specifically, so that a chunk at one level lines up with
/// chunks at every coarser level — the property that makes a zoom-out reuse
/// work rather than re-decode a differently-phased grid.
const LEVEL_STEPS: [f64; 11] = [
    0.0625, 0.125, 0.25, 0.5, 1.0, 2.0, 4.0, 8.0, 16.0, 32.0, 64.0,
];

/// Tiles in one chunk at `level`. Not a constant, because the two ends of the
/// ladder have opposite cost shapes.
///
/// At **coarse** levels (spacing ≥ 1s) essentially all real footage has
/// keyframes denser than the spacing, so the decode is keyframe-only and
/// cheap per second of source — a big chunk covers a wide view in one
/// `ffmpeg` spawn and is worth it. (Measured on the owner's 4K HEVC, whose
/// keyframes are 0.875s apart: 64 tiles over 64s of source, **1.7s**.) The
/// trade is real and bounded: footage with keyframes *sparser* than 1s —
/// heavily-compressed delivery files, some screen recordings — falls back to
/// an every-frame decode of a 64s window, which is slower. Such footage is
/// almost never 4K, it is a one-time cost per chunk, and the result is then
/// on disk forever; whereas clamping this level small enough for that worst
/// case would make a normal viewport need more chunks than
/// [`MAX_CHUNKS_PER_REQUEST`] allows, which is a correctness problem (part of
/// the visible range would get no tiles at all), not just a slow one.
///
/// At **fine** levels the decode may have to touch every frame, and cost
/// scales with the *seconds of source* the chunk spans, not the tile count.
/// So the chunk is sized to span a bounded number of source seconds
/// ([`MAX_FINE_CHUNK_SECS`]) instead. Measured: at 0.5s spacing, a 64-tile
/// chunk spans 32s and costs 8.1s to decode; a 16-tile chunk spans 8s and
/// costs ~2.5s, which is the difference between a filmstrip that appears and
/// one that doesn't.
///
/// It depends only on the level — never on the file's keyframe interval —
/// because chunk boundaries have to be stable for a given (source, level) or
/// a cached chunk index would mean a different range on a later run.
fn tiles_per_chunk(level: usize) -> u32 {
    let step = LEVEL_STEPS[level.min(LEVEL_STEPS.len() - 1)];
    if step >= COARSE_LEVEL_MIN_STEP_SECS {
        MAX_TILES_PER_CHUNK
    } else {
        ((MAX_FINE_CHUNK_SECS / step).round() as u32)
            .clamp(MIN_TILES_PER_CHUNK, MAX_TILES_PER_CHUNK)
    }
}

/// Spacing at or above which a chunk is assumed keyframe-only-decodable for
/// essentially all real footage, so it may be as wide as
/// [`MAX_TILES_PER_CHUNK`]. See [`tiles_per_chunk`] for the trade this makes.
const COARSE_LEVEL_MIN_STEP_SECS: f64 = 1.0;
/// Seconds of source one *fine* (potentially every-frame) chunk may span.
const MAX_FINE_CHUNK_SECS: f64 = 8.0;
const MIN_TILES_PER_CHUNK: u32 = 8;
const MAX_TILES_PER_CHUNK: u32 = 64;

/// Most chunks one request may extract. A window that needs more than this is
/// asking for more picture than a screen can show; it gets what fits rather
/// than queueing a burst of decodes behind the user's actual viewport.
///
/// This is a backstop, not an operating point: `a_realistic_viewport_never_
/// exceeds_the_chunk_budget` below asserts that no level, at any zoom the UI
/// allows, actually reaches it — because a window that gets truncated here
/// would leave part of the visible clip with no tiles at all.
const MAX_CHUNKS_PER_REQUEST: usize = 8;
/// Hard ceiling on tiles in one response, so a pathological window can't
/// build a multi-megabyte IPC payload.
const MAX_TILES_PER_REQUEST: usize = 512;

/// The coarsest level whose tile spacing is still at least as fine as
/// `desired_step_secs` — i.e. never *coarser* than asked for, so a tile is
/// always a real distinct picture rather than one frame stretched across the
/// gap. Clamps to the ladder at both ends.
fn level_for(desired_step_secs: f64) -> usize {
    // `is_finite()` first, explicitly: a NaN spacing (a zero-width clip mid
    // layout transition divided into a duration) must land on the finest
    // rung, not fall through a comparison that is false either way.
    if !desired_step_secs.is_finite() || desired_step_secs <= 0.0 {
        return 0;
    }
    let mut chosen = 0;
    for (i, step) in LEVEL_STEPS.iter().enumerate() {
        if *step <= desired_step_secs {
            chosen = i;
        }
    }
    chosen
}

/// Source-seconds where chunk `index` of `level` begins. Chunks tile the
/// source from its own t=0 — that is what makes them shareable between two
/// clips trimmed differently out of one file.
fn chunk_start_secs(level: usize, index: u32) -> f64 {
    LEVEL_STEPS[level] * tiles_per_chunk(level) as f64 * index as f64
}

/// The chunk indices covering source seconds `[start, end)` at `level`,
/// capped at [`MAX_CHUNKS_PER_REQUEST`].
fn chunks_covering(level: usize, start_secs: f64, end_secs: f64) -> Vec<u32> {
    let span = LEVEL_STEPS[level] * tiles_per_chunk(level) as f64;
    if !span.is_finite()
        || span <= 0.0
        || !start_secs.is_finite()
        || !end_secs.is_finite()
        || end_secs <= start_secs
    {
        return Vec::new();
    }
    let first = (start_secs.max(0.0) / span).floor() as u32;
    let last = ((end_secs / span).ceil() as u32).max(first + 1);
    (first..last).take(MAX_CHUNKS_PER_REQUEST).collect()
}

// --------------------------------------------------------------------------- //
// caches
// --------------------------------------------------------------------------- //

/// Decoded, base64'd tiles for one chunk. `Arc` so a cache hit is a refcount
/// bump, not a clone of ~140 KB of JPEG-in-base64.
type Chunk = Arc<Vec<String>>;

/// Process-local chunk cache. Still worth having in front of the disk cache:
/// a disk hit is a file read plus a base64 encode of every tile, and a scroll
/// re-render asks for the same chunk many times a second.
static CHUNK_MEM: Lazy<Mutex<HashMap<String, Chunk>>> = Lazy::new(|| Mutex::new(HashMap::new()));
/// Bounds `CHUNK_MEM`. Cleared wholesale rather than LRU-evicted — the disk
/// cache behind it makes a memory miss cheap, so the simplest thing that
/// stops an unbounded leak is the right one.
const MAX_CHUNK_MEM: usize = 400;

/// Per-chunk-key locks, so two clips that share a source file (the owner's
/// own project has exactly this — the same 4K source on two tracks) don't
/// both spawn `ffmpeg` for the same chunk. The second waiter blocks on the
/// lock and then finds the first one's result in `CHUNK_MEM`.
static CHUNK_LOCKS: Lazy<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Bounds how many `ffmpeg` child processes may run at once (D-121). Found
/// live, not theorized: the owner's real machine hit 11 simultaneous `ffmpeg`
/// processes opening a multi-clip project, and system load spiked past 200.
static EXTRACT_SEMAPHORE: Lazy<tokio::sync::Semaphore> =
    Lazy::new(|| tokio::sync::Semaphore::new(3));

/// Measured keyframe interval per source path, in-process.
static KEYFRAME_MEM: Lazy<Mutex<HashMap<PathBuf, f64>>> = Lazy::new(|| Mutex::new(HashMap::new()));

const NS_CHUNK: &str = "filmstrip";
const NS_KEYFRAME: &str = "keyframe-interval";

/// The file's largest keyframe gap, from memory, then disk, then a real
/// packet probe. Falls back to [`video::DEFAULT_KEYFRAME_INTERVAL_SECS`] —
/// the conservative value D-124 hardcoded for everyone — if the probe fails,
/// so a probe failure costs speed, never correctness.
fn keyframe_interval(path: &Path, source_key: Option<&str>) -> f64 {
    if let Some(hit) = KEYFRAME_MEM
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(path)
    {
        return *hit;
    }
    if let Some(key) = source_key
        && let Some(secs) = media_cache::read_json::<f64>(NS_KEYFRAME, key)
        && secs > 0.0
        && secs.is_finite()
    {
        KEYFRAME_MEM
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(path.to_path_buf(), secs);
        return secs;
    }
    let secs = video::probe_keyframe_interval(path).unwrap_or_else(|e| {
        log::warn!(
            "[chroma::filmstrip] keyframe probe failed for {}: {e} — falling back to {}s",
            path.display(),
            video::DEFAULT_KEYFRAME_INTERVAL_SECS
        );
        video::DEFAULT_KEYFRAME_INTERVAL_SECS
    });
    if let Some(key) = source_key {
        media_cache::write_json(NS_KEYFRAME, key, &secs);
    }
    KEYFRAME_MEM
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(path.to_path_buf(), secs);
    secs
}

fn chunk_cache_key(source_key: &str, level: usize, index: u32) -> String {
    // The strip height is part of the key: it is baked into the pixels, and a
    // future change to `THUMB_STRIP_HEIGHT` must not serve the old size.
    format!(
        "{source_key}-h{}-l{level}-c{index}",
        video::THUMB_STRIP_HEIGHT
    )
}

fn mjpeg_to_tiles(bytes: &[u8]) -> Vec<String> {
    let b64 = base64::engine::general_purpose::STANDARD;
    video::split_mjpeg(bytes)
        .into_iter()
        .map(|jpeg| format!("data:image/jpeg;base64,{}", b64.encode(jpeg)))
        .collect()
}

/// One chunk's tiles: memory → disk → real extraction.
async fn load_chunk(
    path: &Path,
    info: &VideoInfo,
    source_key: Option<&str>,
    level: usize,
    index: u32,
) -> Result<Chunk, String> {
    let Some(key) = source_key.map(|k| chunk_cache_key(k, level, index)) else {
        // No cache identity for this file (it vanished between the probe and
        // now, or the cache root never initialised). Extract without caching
        // rather than failing — a filmstrip is best-effort.
        let bytes = extract(path, info, source_key, level, index).await?;
        return Ok(Arc::new(mjpeg_to_tiles(&bytes)));
    };

    if let Some(hit) = CHUNK_MEM
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&key)
    {
        return Ok(Arc::clone(hit));
    }

    // Serialise same-chunk work. Taken *before* the disk read so the loser of
    // a race reads the winner's freshly-written entry rather than starting a
    // duplicate decode.
    let lock = {
        let mut locks = CHUNK_LOCKS.lock().unwrap_or_else(|e| e.into_inner());
        Arc::clone(
            locks
                .entry(key.clone())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))),
        )
    };
    let _held = lock.lock().await;

    if let Some(hit) = CHUNK_MEM
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&key)
    {
        return Ok(Arc::clone(hit));
    }

    let tiles = match media_cache::read_blob(NS_CHUNK, &key) {
        Some(bytes) => mjpeg_to_tiles(&bytes),
        None => {
            let bytes = extract(path, info, source_key, level, index).await?;
            media_cache::write_blob(NS_CHUNK, &key, &bytes);
            mjpeg_to_tiles(&bytes)
        }
    };

    let chunk: Chunk = Arc::new(tiles);
    {
        let mut mem = CHUNK_MEM.lock().unwrap_or_else(|e| e.into_inner());
        if mem.len() > MAX_CHUNK_MEM {
            mem.clear();
        }
        mem.insert(key.clone(), Arc::clone(&chunk));
    }
    CHUNK_LOCKS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&key);
    Ok(chunk)
}

/// The real `ffmpeg` pass for one chunk. Takes a concurrency permit; a cache
/// hit never reaches here, so a burst of requests for already-generated
/// chunks is never queued behind a decode.
async fn extract(
    path: &Path,
    info: &VideoInfo,
    source_key: Option<&str>,
    level: usize,
    index: u32,
) -> Result<Vec<u8>, String> {
    let step = LEVEL_STEPS[level];
    let tiles = tiles_per_chunk(level);
    let start = chunk_start_secs(level, index);
    // `>=`, not `>`: at a spacing exactly equal to the worst observed
    // keyframe gap every sample still lands on its own keyframe.
    let keyframe_only = step >= keyframe_interval(path, source_key);

    let _permit = EXTRACT_SEMAPHORE
        .acquire()
        .await
        .map_err(|e| e.to_string())?;

    let (path, info) = (path.to_path_buf(), info.clone());
    tokio::task::spawn_blocking(move || {
        video::extract_thumb_chunk(&path, &info, start, step, tiles, keyframe_only)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

// --------------------------------------------------------------------------- //
// the command
// --------------------------------------------------------------------------- //

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClipThumbDto {
    /// absolute source frame index this tile was sampled at
    pub frame: u64,
    /// the tile's position in **source seconds** — what `Filmstrip.tsx`
    /// positions it by. Frames alone can't do that job: under a keyframe-only
    /// decode the delivered frames' indices are not evenly spaced, and a VFR
    /// source has no fixed frame↔time ratio at all. Time is the honest unit.
    pub secs: f64,
    /// data:image/jpeg;base64,...
    pub data_url: String,
}

/// Picture tiles roughly `step_secs` apart covering source seconds
/// `[start_secs, start_secs + duration_secs)` of `source_path` (D-128).
///
/// All four parameters are in the **source file's** own time base — the
/// caller converts from timeline frames. `step_secs` is a request, not a
/// promise: it is quantised to the [`LEVEL_STEPS`] ladder (never coarser than
/// asked, so a tile is never a stretched frame), and the returned tiles carry
/// their real `secs` so the caller can place them exactly.
#[tauri::command]
pub async fn chroma_clip_thumbnails(
    source_path: String,
    start_secs: f64,
    duration_secs: f64,
    step_secs: f64,
) -> Result<Vec<ClipThumbDto>, String> {
    if !duration_secs.is_finite()
        || duration_secs <= 0.0
        || !step_secs.is_finite()
        || step_secs <= 0.0
    {
        return Ok(Vec::new());
    }
    let path = PathBuf::from(&source_path);
    let info = probe_cached(&path)?;
    let fps = info.fps().max(0.001);
    let last_frame = info.frame_count.saturating_sub(1);

    let level = level_for(step_secs);
    let step = LEVEL_STEPS[level];
    let tiles = tiles_per_chunk(level);
    let window_start = start_secs.max(0.0);
    let window_end = window_start + duration_secs;
    let source_key = media_cache::source_key(&path).ok();

    let mut out: Vec<ClipThumbDto> = Vec::new();
    for index in chunks_covering(level, window_start, window_end) {
        let chunk = load_chunk(&path, &info, source_key.as_deref(), level, index).await?;
        let chunk_start = chunk_start_secs(level, index);
        for (i, data_url) in chunk.iter().enumerate() {
            if i as u32 >= tiles {
                break;
            }
            let secs = chunk_start + i as f64 * step;
            if secs < window_start || secs >= window_end {
                continue;
            }
            if out.len() >= MAX_TILES_PER_REQUEST {
                return Ok(out);
            }
            out.push(ClipThumbDto {
                frame: ((secs * fps).round() as u64).min(last_frame),
                secs,
                data_url: data_url.clone(),
            });
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Drop the process-local caches, leaving only what is on disk — the
    /// state a real app restart produces. The point of the whole decision, so
    /// there has to be a way to actually measure it.
    fn forget_in_memory() {
        CHUNK_MEM.lock().unwrap_or_else(|e| e.into_inner()).clear();
        KEYFRAME_MEM
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
    }

    /// D-128 — the claim this decision is built on, measured rather than
    /// asserted: **the second time a project is opened, the filmstrip costs
    /// nothing**, because the chunks are on disk and not merely in a static
    /// that dies with the process.
    ///
    /// Env-gated on `CHROMA_TEST_VIDEO` (real footage, kept outside the repo)
    /// in the same style as this module's siblings. The "restart" is
    /// `forget_in_memory()`: every cache Chroma had before this decision was
    /// process-local, so clearing them is exactly what a relaunch does.
    #[test]
    fn a_second_open_serves_the_filmstrip_from_disk_not_ffmpeg() {
        let Ok(p) = std::env::var("CHROMA_TEST_VIDEO") else {
            eprintln!("skip: set CHROMA_TEST_VIDEO to run");
            return;
        };
        let root =
            std::env::temp_dir().join(format!("chroma_filmstrip_cachetest_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        media_cache::init_for_tests(root.clone());
        // Another test in this binary may have claimed the `OnceLock` first;
        // the measurement is still valid wherever the root actually points.
        let Some(actual_root) = media_cache::root().map(|r| r.to_path_buf()) else {
            eprintln!("skip: no cache root available");
            return;
        };

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio runtime");

        // A realistic viewport's worth of window at the default zoom: 16s of
        // source at a 0.5s tile spacing.
        let call = || {
            rt.block_on(chroma_clip_thumbnails(p.clone(), 0.0, 16.0, 0.5))
                .expect("chroma_clip_thumbnails")
        };

        forget_in_memory();
        let t0 = std::time::Instant::now();
        let cold = call();
        let cold_secs = t0.elapsed().as_secs_f64();

        forget_in_memory(); // <- the "restart"
        let t1 = std::time::Instant::now();
        let warm = call();
        let warm_secs = t1.elapsed().as_secs_f64();

        eprintln!(
            "filmstrip window: cold {cold_secs:.2}s -> warm-from-disk {warm_secs:.3}s ({} tiles), cache at {}",
            cold.len(),
            actual_root.display()
        );

        assert!(!cold.is_empty(), "a real window must return tiles");
        assert_eq!(
            cold.iter().map(|t| &t.data_url).collect::<Vec<_>>(),
            warm.iter().map(|t| &t.data_url).collect::<Vec<_>>(),
            "the disk cache must serve byte-identical pictures, not merely some pictures"
        );
        assert!(
            cold.windows(2).all(|w| w[0].secs < w[1].secs),
            "tiles must be strictly ascending in source time"
        );
        // The real property. Generous factor: this asserts an order of
        // magnitude, not a benchmark, so it can't flake on a busy machine.
        assert!(
            warm_secs * 5.0 < cold_secs,
            "a warm open must be far cheaper than a cold one, got cold {cold_secs:.2}s vs warm {warm_secs:.2}s"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn level_for_never_picks_a_spacing_coarser_than_asked() {
        // The whole anti-stretch property in one assertion: whatever spacing
        // the UI wants, the level it gets has tiles at least that dense, so a
        // tile is always a real distinct picture.
        for want in [0.104, 0.2, 0.3, 0.7, 1.5, 3.0, 9.0, 40.0, 50.0] {
            let step = LEVEL_STEPS[level_for(want)];
            assert!(
                step <= want,
                "asked for tiles {want}s apart, level gives {step}s — that stretches"
            );
        }
    }

    #[test]
    fn level_for_clamps_at_both_ends_of_the_ladder() {
        // Tighter than the finest level (below what MAX_PX_PER_SEC can ask
        // for) still resolves, rather than indexing off the ladder.
        assert_eq!(level_for(0.001), 0);
        assert_eq!(level_for(0.0), 0);
        assert_eq!(level_for(-1.0), 0);
        // Wider than the coarsest.
        assert_eq!(level_for(10_000.0), LEVEL_STEPS.len() - 1);
    }

    #[test]
    fn level_for_covers_the_real_zoom_range() {
        // `ruler.ts`: 1..480 px/s, `Filmstrip.tsx`: ~50px per tile. So the
        // real span of requested spacings is 50/480 .. 50/1 seconds, and both
        // ends must land strictly inside the ladder, not on a clamp.
        let tightest = 50.0 / 480.0;
        let widest = 50.0 / 1.0;
        assert!(LEVEL_STEPS[level_for(tightest)] <= tightest);
        assert!(
            level_for(widest) < LEVEL_STEPS.len() - 1,
            "widest zoom must not clamp"
        );
    }

    #[test]
    fn fine_chunks_span_a_bounded_number_of_source_seconds() {
        // The property that keeps a fine-level chunk affordable: cost tracks
        // seconds of source read, not tile count.
        for (level, step) in LEVEL_STEPS.iter().enumerate() {
            if *step >= COARSE_LEVEL_MIN_STEP_SECS {
                continue;
            }
            let span = step * tiles_per_chunk(level) as f64;
            assert!(
                span <= MAX_FINE_CHUNK_SECS + 1e-9,
                "level {level} ({step}s) spans {span}s per chunk, over the fine-decode budget"
            );
        }
    }

    #[test]
    fn coarse_chunks_use_the_full_tile_budget() {
        for (level, step) in LEVEL_STEPS.iter().enumerate() {
            if *step < COARSE_LEVEL_MIN_STEP_SECS {
                continue;
            }
            assert_eq!(tiles_per_chunk(level), MAX_TILES_PER_CHUNK);
        }
    }

    #[test]
    fn tiles_per_chunk_stays_inside_its_bounds_at_every_level() {
        for level in 0..LEVEL_STEPS.len() {
            let t = tiles_per_chunk(level);
            assert!(
                (MIN_TILES_PER_CHUNK..=MAX_TILES_PER_CHUNK).contains(&t),
                "level {level}"
            );
        }
    }

    #[test]
    fn chunks_are_aligned_to_the_source_not_the_clip() {
        // The property that makes a chunk shareable: two clips trimmed
        // differently out of one file, whose visible windows overlap, must
        // resolve to the same chunk indices.
        let level = level_for(0.5);
        let a = chunks_covering(level, 100.0, 108.0);
        let b = chunks_covering(level, 103.0, 107.0);
        assert!(!a.is_empty());
        assert!(
            b.iter().all(|i| a.contains(i)),
            "{b:?} must be covered by {a:?}"
        );
    }

    #[test]
    fn chunks_covering_spans_the_whole_window() {
        let level = level_for(0.25);
        let span = LEVEL_STEPS[level] * tiles_per_chunk(level) as f64;
        let idx = chunks_covering(level, 0.0, span * 2.5);
        assert_eq!(idx, vec![0, 1, 2], "a 2.5-chunk window needs 3 chunks");
        assert!((chunk_start_secs(level, 1) - span).abs() < 1e-9);
    }

    #[test]
    fn chunks_covering_is_capped_so_one_request_cannot_storm_ffmpeg() {
        let level = level_for(0.0625);
        let idx = chunks_covering(level, 0.0, 100_000.0);
        assert_eq!(idx.len(), MAX_CHUNKS_PER_REQUEST);
    }

    /// The cap above must never actually bite in real use — a truncated
    /// window leaves part of the visible clip with no tiles, which is a
    /// correctness bug, not a slow path. This walks every zoom a real 1.2x
    /// wheel step reaches, mirroring `Filmstrip.tsx`'s own window arithmetic
    /// (a ~50px tile, a 1400px viewport, half a viewport of overscan each
    /// side), and checks the resulting window fits inside the budget at every
    /// level it can select.
    #[test]
    fn a_realistic_viewport_never_exceeds_the_chunk_budget() {
        const PX_PER_FRAME: f64 = 50.0;
        const VIEWPORT_PX: f64 = 1400.0;
        // `ruler.ts`'s MIN/MAX_PX_PER_SEC and the real wheel step.
        let mut px_per_sec = 1.0f64;
        while px_per_sec <= 480.0 {
            let desired_step = PX_PER_FRAME / px_per_sec;
            let level = level_for(desired_step);
            let visible_secs = VIEWPORT_PX / px_per_sec;
            // viewport + half a viewport of overscan on each side
            let window_secs = visible_secs * 2.0;
            let n = chunks_covering(level, 0.0, window_secs).len();
            assert!(
                n < MAX_CHUNKS_PER_REQUEST,
                "at {px_per_sec:.1}px/s (level {level}, step {}s) a viewport needs {n} chunks, \
                 at or over the {MAX_CHUNKS_PER_REQUEST}-chunk budget — part of the visible \
                 range would get no tiles",
                LEVEL_STEPS[level]
            );
            px_per_sec *= 1.2;
        }
    }

    #[test]
    fn chunks_covering_rejects_a_degenerate_window() {
        let level = level_for(1.0);
        assert!(chunks_covering(level, 5.0, 5.0).is_empty());
        assert!(chunks_covering(level, 5.0, 1.0).is_empty());
    }

    #[test]
    fn chunks_covering_clamps_a_negative_start_rather_than_underflowing() {
        // `(negative / span).floor() as u32` would saturate to 0 in Rust, but
        // relying on that is a trap — assert the intended behaviour directly.
        let level = level_for(1.0);
        assert_eq!(chunks_covering(level, -50.0, 10.0).first(), Some(&0));
    }

    #[test]
    fn chunk_cache_keys_are_distinct_across_every_axis_that_changes_the_pixels() {
        let a = chunk_cache_key("srcA", 3, 7);
        assert_ne!(a, chunk_cache_key("srcB", 3, 7), "different source file");
        assert_ne!(a, chunk_cache_key("srcA", 4, 7), "different level");
        assert_ne!(a, chunk_cache_key("srcA", 3, 8), "different chunk");
        assert_eq!(a, chunk_cache_key("srcA", 3, 7), "same inputs, same key");
    }

    #[test]
    fn mjpeg_to_tiles_produces_one_data_url_per_jpeg() {
        // two minimal JPEG-ish blobs back to back, split on the SOI marker
        let mut bytes = vec![0xFF, 0xD8, 0xFF, 0x01, 0x02];
        bytes.extend_from_slice(&[0xFF, 0xD8, 0xFF, 0x03, 0x04]);
        let tiles = mjpeg_to_tiles(&bytes);
        assert_eq!(tiles.len(), 2);
        assert!(
            tiles
                .iter()
                .all(|t| t.starts_with("data:image/jpeg;base64,"))
        );
        assert_ne!(tiles[0], tiles[1]);
    }

    #[test]
    fn mjpeg_to_tiles_of_nothing_is_empty_not_a_panic() {
        assert!(mjpeg_to_tiles(&[]).is_empty());
    }
}

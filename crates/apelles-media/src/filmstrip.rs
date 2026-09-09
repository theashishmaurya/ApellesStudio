//! Edit-tab filmstrip thumbnails: windowed, level-of-detail, disk-cached
//! (D-128). Supersedes the whole-clip strip of D-119/D-121/D-124.
//!
//! Moved out of `app/src-tauri/src/chroma/filmstrip.rs` in D-146
//! (`docs/notes/crate-extraction-plan.md` §2.2) — whole, apart from the
//! `#[tauri::command] chroma_clip_thumbnails` wrapper, which is now three
//! lines around [`clip_thumbnails`] and stays in `app/src-tauri` (plan §1).
//!
//! What it is: the backend behind `Filmstrip.tsx` — "give me picture tiles
//!   `step_secs` apart covering source seconds `[start, start + duration)` of
//!   this file."
//! What it does: quantises the requested spacing to a fixed power-of-two
//!   **level**, cuts the source's timeline into fixed **chunks** of tiles at
//!   that level, and serves each chunk from (1) a process-local memory cache,
//!   (2) a persistent on-disk cache ([`crate::media_cache`]), or (3) a real
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
//! interval ([`crate::video::probe_keyframe_interval`], 0.23s, packet-level,
//! no decoding) instead of D-124's fixed 4-second guess, which forced the
//! expensive every-frame path for every spacing under 4s even on footage with
//! keyframes nine times denser than that.
//!
//! ## Storage levels: why a zoom step is not a new decode (D-134, B-049)
//!
//! D-128 stored a chunk at the level it was requested at, so a zoom step that
//! moved the level was cache-cold over source seconds that were already fully
//! decoded a rung away. Measured on the same 4K file, that is 5 chunks × ~2.2s
//! **serially** for one zoom click at the default zoom — the "takes like
//! forever" the owner reported once scroll and load were fast.
//!
//! Two facts, both measured, make that avoidable:
//!
//! 1. **In the fine band, a chunk's cost is its span, not its tile count.**
//!    One 8-second chunk of this file costs ~2.15s whether it yields 16 tiles
//!    (0.5s spacing) or 64 (0.125s) — ffmpeg decodes every frame either way;
//!    only the scale+mjpeg encode differs, and that is noise next to a 4K
//!    decode. The real shape is ~0.8s of fixed spawn/seek plus ~0.24s per
//!    second of source read.
//! 2. **The ladder is powers of two, so a coarser level's sample times are a
//!    strict subset of a finer level's.** Decimating a 0.0625s strip by 8
//!    gives exactly the 0.5s strip — the same frames, not approximations.
//!
//! So every *fine* level is decoded and stored **once**, at
//! [`FINE_STORAGE_LEVEL`], and each fine request is a decimation of that
//! ([`storage_level`]). Zooming anywhere inside the fine band over source
//! seconds already on disk now costs no ffmpeg at all. Coarse levels keep
//! their own storage (their spans are far too wide to pay for at 0.0625s), but
//! are still derived for free from a finer level's chunks when those happen to
//! be cached ([`derive_from_finer`]) — which is exactly the zoom-out case.
//!
//! And the chunks of one request are now loaded **concurrently**, bounded by
//! the same [`EXTRACT_SEMAPHORE`]: D-128 awaited them one at a time, so a cold
//! 5-chunk window paid 5 × 2.2s in series while two of the three permits sat
//! idle.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use once_cell::sync::Lazy;
use serde::Serialize;

use crate::media_cache;
use crate::probe::probe_cached;
use crate::video::{self, VideoInfo};

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

/// Spacing at or above which a chunk is assumed keyframe-only-decodable for
/// essentially all real footage. It is the line between the two bands, which
/// have opposite cost shapes and therefore different storage rules.
const COARSE_LEVEL_MIN_STEP_SECS: f64 = 1.0;
/// Seconds of source one *fine* (potentially every-frame) chunk spans.
///
/// Measured on the owner's 4K HEVC: a fine chunk costs ~0.8s of fixed
/// ffmpeg spawn/seek plus ~0.24s per second of source (2s span → 1.03s,
/// 8s → 2.75s, 32s → 8.37s). Halving this doubles the fixed cost per second
/// covered; doubling it halves the parallelism a 3-permit semaphore can apply
/// to one window. 8s is where a realistic viewport needs 3-7 chunks, which is
/// what those 3 permits cover in two rounds.
const FINE_CHUNK_SECS: f64 = 8.0;
/// Tiles in one *coarse* chunk. Coarse decodes are keyframe-only and cheap per
/// second of source, so a chunk covers a wide view in one `ffmpeg` spawn
/// (measured: 64 tiles over 64s of the owner's 4K HEVC, **1.5s**).
///
/// The trade is real and bounded: footage with keyframes *sparser* than
/// [`COARSE_LEVEL_MIN_STEP_SECS`] falls back to an every-frame decode of a 64s
/// window, which is slower. Such footage is almost never 4K, it is a one-time
/// cost per chunk, and the result is then on disk forever; whereas clamping
/// coarse chunks small enough for that worst case would make a normal viewport
/// need more chunks than [`MAX_CHUNKS_PER_REQUEST`] allows, which is a
/// correctness problem (part of the visible range would get no tiles at all),
/// not just a slow one.
const COARSE_TILES_PER_CHUNK: u32 = 64;

/// Is `level` in the fine (potentially every-frame decode) band?
fn is_fine(level: usize) -> bool {
    LEVEL_STEPS[level.min(LEVEL_STEPS.len() - 1)] < COARSE_LEVEL_MIN_STEP_SECS
}

/// The level a request at `level` is actually **decoded and stored** at
/// (D-134). A request at any other level is served by decimating this one's
/// tiles, which is exact because the ladder is powers of two.
///
/// Every fine level collapses onto [`FINE_STORAGE_LEVEL`]. That is the whole
/// B-049 fix: a fine chunk costs the same to decode at 0.0625s spacing as at
/// 0.5s (measured — 8s of this file is ~2.15s either way, because ffmpeg
/// decodes every frame regardless and only the scale+mjpeg encode differs), so
/// storing the finest one and decimating means a zoom step inside the fine
/// band is a cache hit rather than a fresh 5-chunk decode.
///
/// Coarse levels store at themselves: their spans (64s and up) are far too
/// wide to pay for at 0.0625s spacing, and their decode is keyframe-only and
/// already cheap. They still get free reuse where it exists, via
/// [`derive_from_finer`].
fn storage_level(level: usize) -> usize {
    if is_fine(level) {
        FINE_STORAGE_LEVEL
    } else {
        level.min(LEVEL_STEPS.len() - 1)
    }
}

/// The single level every fine request is decoded at — the finest rung, so
/// every other fine rung is a whole-number decimation of it.
const FINE_STORAGE_LEVEL: usize = 0;

/// Tiles in one chunk at `level`.
///
/// Fine levels are sized so a chunk always spans exactly [`FINE_CHUNK_SECS`],
/// which keeps chunk boundaries identical across the whole fine band —
/// necessary for the decimation in [`storage_level`] to line up. Coarse levels
/// take [`COARSE_TILES_PER_CHUNK`].
///
/// It depends only on the level — never on the file's keyframe interval —
/// because chunk boundaries have to be stable for a given (source, level) or
/// a cached chunk index would mean a different range on a later run.
fn tiles_per_chunk(level: usize) -> u32 {
    let level = level.min(LEVEL_STEPS.len() - 1);
    if is_fine(level) {
        (FINE_CHUNK_SECS / LEVEL_STEPS[level]).round() as u32
    } else {
        COARSE_TILES_PER_CHUNK
    }
}

/// Seconds of source one chunk at `level` spans.
fn chunk_span_secs(level: usize) -> f64 {
    LEVEL_STEPS[level.min(LEVEL_STEPS.len() - 1)] * tiles_per_chunk(level) as f64
}

/// How many tiles of a chunk at `from` you skip to get one tile of `to`.
/// `None` when `to` is not a whole-number decimation of `from` — the caller
/// must then decode rather than derive.
fn decimation(from: usize, to: usize) -> Option<usize> {
    let ratio =
        LEVEL_STEPS[to.min(LEVEL_STEPS.len() - 1)] / LEVEL_STEPS[from.min(LEVEL_STEPS.len() - 1)];
    let rounded = ratio.round();
    (rounded >= 1.0 && (ratio - rounded).abs() < 1e-9).then_some(rounded as usize)
}

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
    chunk_span_secs(level) * index as f64
}

/// The chunk indices covering source seconds `[start, end)` at `level`,
/// capped at [`MAX_CHUNKS_PER_REQUEST`].
fn chunks_covering(level: usize, start_secs: f64, end_secs: f64) -> Vec<u32> {
    let span = chunk_span_secs(level);
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
///
/// Halved from D-128's 400 because D-134 made a fine chunk 128 tiles rather
/// than 16-64, so the per-entry cost went up ~4x (~280 KB of base64 for a 4K
/// source at the 104px strip height). 200 keeps the same ~55 MB ceiling.
const MAX_CHUNK_MEM: usize = 200;

/// Per-chunk-key locks, so two clips that share a source file (the owner's
/// own project has exactly this — the same 4K source on two tracks) don't
/// both spawn `ffmpeg` for the same chunk. The second waiter blocks on the
/// lock and then finds the first one's result in `CHUNK_MEM`.
static CHUNK_LOCKS: Lazy<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Removes its [`CHUNK_LOCKS`] entry when dropped — on **every** way out of
/// [`load_chunk`], not just the successful one (B-057, fixed D-146).
///
/// The removal used to be a plain statement after `let bytes = extract(..)?`,
/// so a chunk whose extraction failed (media offline, a codec `ffmpeg`
/// refuses, the class of failure B-055 documents) left its `String` key and
/// its `Arc<tokio::sync::Mutex<()>>` in the map for the process lifetime. A
/// bounded leak — one entry per *distinct* chunk key that has ever failed —
/// but `CHUNK_LOCKS` was the one map in this module with no bound at all
/// (`CHUNK_MEM` has `MAX_CHUNK_MEM`, `KEYFRAME_MEM` is per-path, the disk
/// cache has `CACHE_BUDGET_BYTES`), so it was the one place the module's own
/// discipline was missing.
///
/// Declared **after** the `tokio` mutex guard it belongs to, so drop order
/// (reverse of declaration) removes the entry while that lock is still held —
/// byte-for-byte the ordering the old success path had, which B-057's own
/// entry traced and confirmed is safe against a third caller arriving in that
/// window.
struct ChunkLockGuard {
    key: String,
}

impl Drop for ChunkLockGuard {
    fn drop(&mut self) {
        CHUNK_LOCKS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.key);
    }
}

/// Bounds how many `ffmpeg` child processes may run at once (D-121). Found
/// live, not theorized: the owner's real machine hit 11 simultaneous `ffmpeg`
/// processes opening a multi-clip project, and system load spiked past 200.
static EXTRACT_SEMAPHORE: Lazy<tokio::sync::Semaphore> =
    Lazy::new(|| tokio::sync::Semaphore::new(3));

/// Measured keyframe interval per source path, in-process — paired with the
/// source's identity ([`media_cache::source_key`]) at the moment it was
/// measured, and revalidated on every hit.
///
/// **B-127 (D-260): that pairing is the fix, not decoration.** This map used to
/// be `HashMap<PathBuf, f64>` — keyed on the path alone, insert-only — sitting
/// directly in front of a disk layer keyed on `blake3(path ‖ mtime ‖ len)`
/// precisely so a replaced file could never serve a stale answer. Two different
/// keys for one question with the weaker one in front: byte-for-byte the defect
/// [`crate::probe`]'s own module doc records as B-056, in the one cache in this
/// module that D-146's sweep did not reach. Replace a source in place (a
/// re-export over the same name, D-260's Motion re-render) and every filmstrip
/// request kept using the OLD file's keyframe interval for the rest of the
/// session — which decides `keyframe_only` extraction, i.e. whether tiles are
/// taken from real frames or from the nearest keyframe. Costs one `HashMap`
/// probe more than before; the `source_key` itself is already computed by the
/// caller, so there is no extra `stat`.
/// The source's identity when the interval was measured (`None` = it could not
/// be `stat`ed), and the interval in seconds.
type KeyframeMemo = (Option<String>, f64);

static KEYFRAME_MEM: Lazy<Mutex<HashMap<PathBuf, KeyframeMemo>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

const NS_CHUNK: &str = "filmstrip";
const NS_KEYFRAME: &str = "keyframe-interval";

/// The file's largest keyframe gap, from memory, then disk, then a real
/// packet probe. Falls back to [`video::DEFAULT_KEYFRAME_INTERVAL_SECS`] —
/// the conservative value D-124 hardcoded for everyone — if the probe fails,
/// so a probe failure costs speed, never correctness.
fn keyframe_interval(path: &Path, source_key: Option<&str>) -> f64 {
    // B-127 — a memory hit counts only while the file still has the identity it
    // had when the measurement was taken. `source_key: None` means the file
    // cannot be `stat`ed at all (offline media, a state this module treats as
    // supported): serve the remembered value unvalidated rather than re-probing
    // a file that cannot be read, exactly `probe::probe_cached`'s own call.
    if let Some((cached_key, secs)) = KEYFRAME_MEM
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(path)
        && (source_key.is_none() || source_key == cached_key.as_deref())
    {
        return *secs;
    }
    if let Some(key) = source_key
        && let Some(secs) = media_cache::read_json::<f64>(NS_KEYFRAME, key)
        && secs > 0.0
        && secs.is_finite()
    {
        KEYFRAME_MEM
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(path.to_path_buf(), (source_key.map(str::to_string), secs));
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
        .insert(path.to_path_buf(), (source_key.map(str::to_string), secs));
    secs
}

fn chunk_cache_key(source_key: &str, level: usize, index: u32) -> String {
    // The strip height is part of the key: it is baked into the pixels, and a
    // future change to `THUMB_STRIP_HEIGHT` must not serve the old size.
    //
    // So is the tile count, for the same reason and a sharper one: D-134
    // changed what "level 0" means (64 tiles over 4s → 128 over 8s), and an
    // entry written by a D-128 build sits in the same `app_cache_dir()` a
    // D-134 build reads. Without the count in the key a stale, half-length
    // chunk would be served as if it were current. With it, an outdated entry
    // simply never matches and is pruned by the cache's own budget.
    format!(
        "{source_key}-h{}-l{level}-t{}-c{index}",
        video::THUMB_STRIP_HEIGHT,
        tiles_per_chunk(level),
    )
}

fn mjpeg_to_tiles(bytes: &[u8]) -> Vec<String> {
    let b64 = base64::engine::general_purpose::STANDARD;
    video::split_mjpeg(bytes)
        .into_iter()
        .map(|jpeg| format!("data:image/jpeg;base64,{}", b64.encode(jpeg)))
        .collect()
}

/// One chunk from memory, else disk, else nothing. Never decodes — that is
/// the point: [`derive_from_finer`] uses it to decide whether a coarser chunk
/// can be assembled for free, and must not start an `ffmpeg` pass to find out.
fn peek_chunk(source_key: &str, level: usize, index: u32) -> Option<Chunk> {
    let key = chunk_cache_key(source_key, level, index);
    if let Some(hit) = CHUNK_MEM
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&key)
    {
        return Some(Arc::clone(hit));
    }
    let chunk: Chunk = Arc::new(mjpeg_to_tiles(&media_cache::read_blob(NS_CHUNK, &key)?));
    remember(key, &chunk);
    Some(chunk)
}

fn remember(key: String, chunk: &Chunk) {
    let mut mem = CHUNK_MEM.lock().unwrap_or_else(|e| e.into_inner());
    if mem.len() > MAX_CHUNK_MEM {
        mem.clear();
    }
    mem.insert(key, Arc::clone(chunk));
}

/// Build chunk `index` of `level` out of already-cached chunks one rung finer,
/// **without decoding anything** (D-134, B-049).
///
/// This is the zoom-out case. The LOD ladder is powers of two, so a coarser
/// level's sample times are a strict subset of a finer level's: tile *k* of
/// the coarse chunk is tile *k × stride* of the concatenated finer chunks
/// covering the same span. The pictures are therefore identical, not
/// approximated — this returns exactly what an `ffmpeg` pass at `level` would
/// have produced, for the cost of a few `Vec` reads.
///
/// Returns `None` unless **every** finer chunk covering the span is already in
/// memory or on disk. A partial cover would leave holes in the strip, and
/// filling them by decoding would cost more than the one coarse decode this
/// replaces (a coarse decode is keyframe-only, ~1.5s; the finer chunks under
/// it are every-frame).
///
/// Derived chunks are cached in memory but deliberately **not written to
/// disk**: the bytes they are made of are already there, so persisting them
/// would spend the cache budget storing the same pictures twice, and
/// re-deriving after a restart costs a file read, not a decode.
fn derive_from_finer(source_key: &str, level: usize, index: u32) -> Option<Chunk> {
    let finer = storage_level(level.checked_sub(1)?);
    if finer >= level {
        return None;
    }
    let stride = decimation(finer, level)?;
    let start = chunk_start_secs(level, index);
    let span = chunk_span_secs(level);
    let finer_span = chunk_span_secs(finer);
    // The finer chunks must tile this one exactly — they do, because every
    // span on the ladder is a power-of-two multiple of every finer one, but
    // assert it rather than assume it.
    let per_chunk = span / finer_span;
    // `is_finite` first and explicitly: a NaN ratio must be refused, not fall
    // through a comparison that is false either way.
    if !per_chunk.is_finite()
        || per_chunk < 1.0
        || (per_chunk - per_chunk.round()).abs() > 1e-9
        || per_chunk.round() as usize > MAX_CHUNKS_PER_REQUEST
    {
        return None;
    }
    let first = (start / finer_span).round() as u32;
    let mut tiles: Vec<String> = Vec::new();
    for i in 0..per_chunk.round() as u32 {
        let part = peek_chunk(source_key, finer, first + i)?;
        if part.len() < tiles_per_chunk(finer) as usize {
            // A short chunk (the file ended inside it) can't be decimated
            // without shifting every later tile's timestamp. Decode instead.
            return None;
        }
        tiles.extend(part.iter().take(tiles_per_chunk(finer) as usize).cloned());
    }
    let out: Vec<String> = tiles.into_iter().step_by(stride).collect();
    if out.len() < tiles_per_chunk(level) as usize {
        return None;
    }
    log::debug!(
        "[chroma::filmstrip] derived l{level}-c{index} from {} l{finer} chunks (stride {stride}) — no decode",
        per_chunk.round() as u32,
    );
    let chunk: Chunk = Arc::new(out);
    remember(chunk_cache_key(source_key, level, index), &chunk);
    Some(chunk)
}

/// One chunk's tiles: memory → disk → derived from a finer cached level →
/// real extraction.
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
    // B-057 — tie the entry's removal to a guard's lifetime rather than to a
    // statement placed after a `?`. Declared after `_held` so it drops first,
    // i.e. removes while the lock is still held (the old success ordering).
    let _lock_entry = ChunkLockGuard { key: key.clone() };

    if let Some(hit) = CHUNK_MEM
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&key)
    {
        return Ok(Arc::clone(hit));
    }

    let chunk: Chunk = match media_cache::read_blob(NS_CHUNK, &key) {
        Some(bytes) => Arc::new(mjpeg_to_tiles(&bytes)),
        // Nothing stored at this level. Before paying for a decode, see
        // whether a finer level already covers these seconds — the zoom-out
        // case, and free when it hits (D-134).
        None => match source_key.and_then(|k| derive_from_finer(k, level, index)) {
            Some(derived) => derived,
            None => {
                let bytes = extract(path, info, source_key, level, index).await?;
                media_cache::write_blob(NS_CHUNK, &key, &bytes);
                Arc::new(mjpeg_to_tiles(&bytes))
            }
        },
    };

    remember(key.clone(), &chunk);
    Ok(chunk)
}

/// How many entries [`CHUNK_LOCKS`] is holding — the observable B-057 is
/// asserted against. Test-only; nothing in the running app asks.
#[cfg(test)]
fn chunk_lock_count() -> usize {
    CHUNK_LOCKS.lock().unwrap_or_else(|e| e.into_inner()).len()
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
// the entry point (wrapped by `#[tauri::command] chroma_clip_thumbnails` in
// `app/src-tauri/src/chroma/filmstrip.rs` — commands do not move, plan §1)
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
pub async fn clip_thumbnails(
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
    // D-134 — decode and cache at the *storage* level, then decimate down to
    // the level asked for. In the fine band that is one shared set of chunks
    // for every zoom, which is what makes a zoom step a cache hit (B-049).
    let store = storage_level(level);
    let stride = decimation(store, level).unwrap_or(1);
    let store_step = LEVEL_STEPS[store];
    let stored_tiles = tiles_per_chunk(store) as usize;
    let window_start = start_secs.max(0.0);
    let window_end = window_start + duration_secs;
    let source_key = media_cache::source_key(&path).ok();

    // Concurrently, not one at a time: D-128 awaited each chunk in turn, so a
    // cold 5-chunk window cost 5 x ~2.2s in series while two of
    // `EXTRACT_SEMAPHORE`'s three permits sat idle. The semaphore is still
    // what bounds real `ffmpeg` processes; this only stops the request itself
    // from being the bottleneck. Cache hits resolve immediately either way.
    // B-055 — drop chunks with no real frame in them. `ffmpeg -ss` at or past
    // the last frame reads no packets, never opens its encoder and exits
    // non-zero; the owner's own 8.023s screen recording has exactly this shape
    // (a chunk boundary lands at 8.000s, 0.023s of empty tail). That `Err`
    // used to fail the **whole** request, so a window overrunning the source
    // lost its entire filmstrip rather than its out-of-range tail. The cost of
    // the guard is at most the file's final frame, at 104px tall.
    let indices: Vec<u32> = chunks_covering(store, window_start, window_end)
        .into_iter()
        .filter(|i| chunk_start_secs(store, *i) + 1.0 / fps < info.duration_secs)
        .collect();
    let loaded = futures::future::join_all(
        indices
            .iter()
            .map(|index| load_chunk(&path, &info, source_key.as_deref(), store, *index)),
    )
    .await;

    // A chunk that genuinely fails to decode costs its own tiles, not every
    // other chunk's — a partial strip beats none. It is still loud (D-124:
    // the reason the filmstrip took three rounds to diagnose was that a slow
    // path and a broken one looked identical from outside), and a request in
    // which *nothing* worked still returns the real error to the frontend.
    let mut chunks: Vec<Chunk> = Vec::with_capacity(loaded.len());
    let mut kept: Vec<u32> = Vec::with_capacity(loaded.len());
    let mut first_err: Option<String> = None;
    for (index, result) in indices.iter().zip(loaded) {
        match result {
            Ok(chunk) => {
                chunks.push(chunk);
                kept.push(*index);
            }
            Err(e) => {
                log::warn!(
                    "[chroma::filmstrip] chunk l{store}-c{index} of {} failed, skipping it: {e}",
                    path.display()
                );
                first_err.get_or_insert(e);
            }
        }
    }
    if chunks.is_empty()
        && let Some(e) = first_err
    {
        return Err(e);
    }

    let mut out: Vec<ClipThumbDto> = Vec::new();
    for (index, chunk) in kept.iter().zip(chunks) {
        let chunk_start = chunk_start_secs(store, *index);
        for (i, data_url) in chunk.iter().enumerate().take(stored_tiles).step_by(stride) {
            let secs = chunk_start + i as f64 * store_step;
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

    /// B-127 (D-260) — the keyframe-interval memory cache honours the same
    /// `(mtime, len)` staleness contract as the disk layer beneath it.
    ///
    /// Poked directly rather than driven through a real file: the property
    /// under test is purely which key a hit is accepted under, and going
    /// through `probe_keyframe_interval` would need two genuinely different
    /// real encodings just to observe it. Needs no media, so it runs
    /// everywhere, unlike this module's env-gated siblings.
    #[test]
    fn keyframe_interval_rejects_a_memory_hit_from_a_replaced_file() {
        let path = std::path::Path::new("/nonexistent/b126-fixture.mp4");
        KEYFRAME_MEM
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(path.to_path_buf(), (Some("key-before".to_string()), 9.0));

        // Same identity: a hit.
        assert_eq!(keyframe_interval(path, Some("key-before")), 9.0);

        // The file was replaced in place — the remembered answer describes the
        // old bytes and must NOT be served. (The path does not exist, so the
        // fall-through probe fails and returns the documented conservative
        // default; what matters is that it is not the stale 9.0.)
        let after = keyframe_interval(path, Some("key-after"));
        assert_ne!(
            after, 9.0,
            "a replaced file must not serve the old interval"
        );
        assert_eq!(after, video::DEFAULT_KEYFRAME_INTERVAL_SECS);

        // Offline (unstattable, so no key at all): serve what we have rather
        // than re-probing a file that cannot be read — `probe_cached`'s own
        // call, for the same reason.
        KEYFRAME_MEM
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(path.to_path_buf(), (Some("key-before".to_string()), 9.0));
        assert_eq!(keyframe_interval(path, None), 9.0);

        KEYFRAME_MEM
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(path);
    }

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
    /// `forget_in_memory()`: every cache Apelles had before this decision was
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
            rt.block_on(clip_thumbnails(p.clone(), 0.0, 16.0, 0.5))
                .expect("clip_thumbnails")
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

    /// B-049 — **the zoom step itself.** Owner, live, after D-124/D-128
    /// landed: *"i do zoom in and zoom out its takes like forever to calculate
    /// the thumbnail also thumblain rest looks amazing... very fast now"* —
    /// scroll and load fixed, the zoom action alone still stalling.
    ///
    /// Warms one source range at one zoom, then re-requests **the same source
    /// seconds at every other fine spacing**, which is exactly what clicking
    /// the zoom buttons does. Every one of those must be served from what the
    /// first request already decoded, because the LOD ladder is powers of two:
    /// a coarser level's sample times are a strict subset of a finer level's.
    ///
    /// Env-gated on `CHROMA_TEST_VIDEO`, like this module's siblings.
    #[test]
    fn a_zoom_step_over_an_already_decoded_range_costs_no_decode() {
        let Ok(p) = std::env::var("CHROMA_TEST_VIDEO") else {
            eprintln!("skip: set CHROMA_TEST_VIDEO to run");
            return;
        };
        let root =
            std::env::temp_dir().join(format!("chroma_filmstrip_zoomtest_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        media_cache::init_for_tests(root.clone());

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio runtime");

        // A realistic viewport at the default zoom: 517s clip at 90 px/s in a
        // 1400px viewport wants ~0.5s tiles over ~31s of source, snapped out.
        // Clamped to the file, so this runs against a short clip too — the
        // owner's own project has one of each.
        let dur = video::probe(Path::new(&p)).expect("probe").duration_secs;
        let window_secs = 32.0f64.min((dur / 2.0).max(FINE_CHUNK_SECS));
        let window_start = (96.0f64).min(((dur - window_secs) / 2.0).max(0.0));
        let (window_start, window_secs) = (
            (window_start / FINE_CHUNK_SECS).floor() * FINE_CHUNK_SECS,
            window_secs,
        );
        eprintln!("zoom: window [{window_start:.1}s +{window_secs:.1}s] of a {dur:.1}s file");
        let call = |step: f64| {
            let t = std::time::Instant::now();
            let out = rt
                .block_on(clip_thumbnails(p.clone(), window_start, window_secs, step))
                .expect("clip_thumbnails");
            (out, t.elapsed().as_secs_f64())
        };

        forget_in_memory();
        let (base, cold_secs) = call(0.5);
        assert!(!base.is_empty(), "the warming request must return tiles");
        eprintln!(
            "zoom: cold window at 0.5s spacing {cold_secs:.2}s ({} tiles)",
            base.len()
        );

        // Every other fine rung over the same seconds — the zoom sweep.
        for step in [0.25, 0.125, 0.0625, 1.0, 0.5] {
            let (out, secs) = call(step);
            eprintln!("zoom: step {step}s -> {secs:.3}s ({} tiles)", out.len());
            assert!(!out.is_empty(), "step {step}s returned no tiles");
            assert!(
                out.windows(2).all(|w| w[0].secs < w[1].secs),
                "step {step}s: tiles must be strictly ascending in source time"
            );
            if step >= COARSE_LEVEL_MIN_STEP_SECS {
                // A coarse rung is derived from the fine chunks only when they
                // happen to cover its whole (much wider) span, which a 32s
                // window does not — so it is allowed to decode. Not asserted.
                continue;
            }
            assert!(
                secs * 5.0 < cold_secs,
                "a zoom to {step}s spacing over an already-decoded range must not re-decode, \
                 got {secs:.2}s against a cold {cold_secs:.2}s"
            );
        }

        // And the pictures must genuinely be the same frames, not merely fast:
        // every tile of the coarser request must appear verbatim in the finer
        // one at the same source second.
        let (fine, _) = call(0.0625);
        for t in &base {
            let hit = fine
                .iter()
                .find(|f| (f.secs - t.secs).abs() < 1e-6)
                .unwrap_or_else(|| panic!("no tile at {:.4}s in the fine request", t.secs));
            assert_eq!(
                hit.data_url, t.data_url,
                "the same source second must be the same picture at every zoom"
            );
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    /// B-055 — a window that overruns the end of the source must return the
    /// tiles that do exist, not fail outright. `ffmpeg -ss` past a file's
    /// duration reads no packets and exits non-zero; before D-134 that `Err`
    /// propagated and the clip lost its whole filmstrip.
    #[test]
    fn a_window_running_past_the_end_of_the_source_still_returns_its_real_tiles() {
        let Ok(p) = std::env::var("CHROMA_TEST_VIDEO") else {
            eprintln!("skip: set CHROMA_TEST_VIDEO to run");
            return;
        };
        let dur = video::probe(Path::new(&p)).expect("probe").duration_secs;
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio runtime");
        // Deliberately ask for three chunks' worth beyond the file's end.
        let out = rt
            .block_on(clip_thumbnails(
                p,
                (dur - 2.0).max(0.0),
                FINE_CHUNK_SECS * 3.0,
                0.5,
            ))
            .expect("an overrunning window must not fail the whole request");
        assert!(
            !out.is_empty(),
            "the in-range part must still produce tiles"
        );
        assert!(
            out.iter().all(|t| t.secs < dur),
            "no tile may claim a source second the file does not have"
        );
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
    fn every_fine_level_spans_exactly_one_fine_chunk_of_source() {
        // Two properties in one. (1) The cost bound: a fine chunk's cost
        // tracks seconds of source read, so its span is what must be capped,
        // not its tile count. (2) D-134's precondition: every fine level's
        // chunk boundaries must be *identical*, or decimating the fine
        // storage level into a coarser fine level would not line up.
        for (level, step) in LEVEL_STEPS.iter().enumerate() {
            if *step >= COARSE_LEVEL_MIN_STEP_SECS {
                continue;
            }
            assert!(
                (chunk_span_secs(level) - FINE_CHUNK_SECS).abs() < 1e-9,
                "level {level} ({step}s) spans {}s per chunk, not {FINE_CHUNK_SECS}s",
                chunk_span_secs(level)
            );
        }
    }

    #[test]
    fn coarse_chunks_use_the_full_tile_budget() {
        for (level, step) in LEVEL_STEPS.iter().enumerate() {
            if *step < COARSE_LEVEL_MIN_STEP_SECS {
                continue;
            }
            assert_eq!(tiles_per_chunk(level), COARSE_TILES_PER_CHUNK);
        }
    }

    /// D-134 — the arithmetic the whole zoom fix rests on: every fine level is
    /// a whole-number decimation of the one level that is actually decoded,
    /// and the tiles line up at the same source seconds.
    #[test]
    fn every_fine_level_is_an_exact_decimation_of_the_fine_storage_level() {
        for (level, step) in LEVEL_STEPS.iter().enumerate() {
            if *step >= COARSE_LEVEL_MIN_STEP_SECS {
                continue;
            }
            assert_eq!(
                storage_level(level),
                FINE_STORAGE_LEVEL,
                "fine level {level} must be served from the one stored fine level"
            );
            let stride = decimation(FINE_STORAGE_LEVEL, level)
                .unwrap_or_else(|| panic!("level {level} is not a whole decimation"));
            assert!(stride.is_power_of_two(), "level {level} stride {stride}");
            // The decimated tile times must be the times this level means.
            for k in 0..tiles_per_chunk(level) as usize {
                let from_storage = (k * stride) as f64 * LEVEL_STEPS[FINE_STORAGE_LEVEL];
                let native = k as f64 * step;
                assert!(
                    (from_storage - native).abs() < 1e-9,
                    "level {level} tile {k}: decimated {from_storage}s vs native {native}s"
                );
            }
            // And the storage chunk must actually hold enough tiles for it.
            assert!(
                tiles_per_chunk(FINE_STORAGE_LEVEL) as usize
                    >= tiles_per_chunk(level) as usize * stride
            );
        }
    }

    /// A coarse level stores at itself — its 64s-and-up spans are far too wide
    /// to decode at the fine storage level's 0.0625s spacing.
    #[test]
    fn coarse_levels_store_at_themselves() {
        for (level, step) in LEVEL_STEPS.iter().enumerate() {
            if *step < COARSE_LEVEL_MIN_STEP_SECS {
                continue;
            }
            assert_eq!(storage_level(level), level);
            assert_eq!(decimation(level, level), Some(1));
        }
    }

    #[test]
    fn decimation_is_none_when_a_level_is_finer_than_its_source() {
        // Deriving a *finer* level from a coarser one would be inventing
        // frames. It must be refused, not rounded.
        assert_eq!(decimation(4, 2), None);
        assert_eq!(decimation(0, 0), Some(1));
        assert_eq!(decimation(0, 3), Some(8));
    }

    #[test]
    fn derive_from_finer_covers_a_whole_coarse_chunk() {
        // Every coarse level must be assemblable from the rung below it —
        // that is what makes a zoom-out free when those chunks are cached.
        // (Level 4 derives from the fine storage level, 8 chunks of it.)
        for (level, step) in LEVEL_STEPS.iter().enumerate() {
            if *step < COARSE_LEVEL_MIN_STEP_SECS {
                continue;
            }
            let finer = storage_level(level - 1);
            let per_chunk = chunk_span_secs(level) / chunk_span_secs(finer);
            assert!(
                (per_chunk - per_chunk.round()).abs() < 1e-9,
                "coarse level {level} does not tile evenly out of level {finer}"
            );
            assert!(
                per_chunk.round() as usize <= MAX_CHUNKS_PER_REQUEST,
                "coarse level {level} needs {per_chunk} level-{finer} chunks, over the budget"
            );
            let stride = decimation(finer, level).expect("whole decimation");
            assert_eq!(
                tiles_per_chunk(finer) as usize * per_chunk.round() as usize / stride,
                tiles_per_chunk(level) as usize,
                "level {level} derived from level {finer} yields the wrong tile count"
            );
        }
    }

    /// D-134 — `derive_from_finer` against seeded caches, so the decimation
    /// is pinned without needing a real file. Each synthetic "tile" is the
    /// source second it stands for, so a wrong stride or a wrong chunk offset
    /// shows up as the wrong seconds, not merely the wrong count.
    #[test]
    fn derive_from_finer_returns_exactly_the_frames_at_the_coarse_levels_own_times() {
        let source = format!("derivetest-{}", std::process::id());
        let fine_tiles = tiles_per_chunk(FINE_STORAGE_LEVEL) as usize;
        let per_chunk = (chunk_span_secs(4) / chunk_span_secs(FINE_STORAGE_LEVEL)).round() as u32;
        for c in 0..per_chunk {
            let start = chunk_start_secs(FINE_STORAGE_LEVEL, c);
            let chunk: Chunk = Arc::new(
                (0..fine_tiles)
                    .map(|i| format!("{:.4}", start + i as f64 * LEVEL_STEPS[FINE_STORAGE_LEVEL]))
                    .collect(),
            );
            remember(chunk_cache_key(&source, FINE_STORAGE_LEVEL, c), &chunk);
        }

        let derived = derive_from_finer(&source, 4, 0).expect("all finer chunks are cached");
        assert_eq!(derived.len(), tiles_per_chunk(4) as usize);
        for (k, tile) in derived.iter().enumerate() {
            assert_eq!(*tile, format!("{:.4}", k as f64 * LEVEL_STEPS[4]));
        }

        // One chunk short of full cover ⇒ no derivation, so a decode happens
        // rather than a strip with a hole in it.
        CHUNK_MEM
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&chunk_cache_key(&source, FINE_STORAGE_LEVEL, per_chunk - 1));
        // (`remember` above also cached the derived chunk under its own key;
        // clear it so this really re-runs the derivation.)
        CHUNK_MEM
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&chunk_cache_key(&source, 4, 0));
        assert!(
            derive_from_finer(&source, 4, 0).is_none(),
            "a partial cover must be refused, not silently short"
        );

        // The finest level has nothing beneath it to derive from.
        assert!(derive_from_finer(&source, FINE_STORAGE_LEVEL, 0).is_none());
    }

    #[test]
    fn tiles_per_chunk_stays_inside_its_bounds_at_every_level() {
        for level in 0..LEVEL_STEPS.len() {
            let t = tiles_per_chunk(level);
            assert!(
                (COARSE_TILES_PER_CHUNK / 4..=COARSE_TILES_PER_CHUNK * 2).contains(&t),
                "level {level} has {t} tiles per chunk"
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
            // The *storage* level is what is actually chunked and decoded
            // (D-134), so that is what the budget has to hold for.
            let level = storage_level(level_for(desired_step));
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

    /// **B-057, the regression test.** A chunk whose extraction fails must not
    /// leave its entry behind in [`CHUNK_LOCKS`].
    ///
    /// The failure is forced the way the bug entry describes one: a real file
    /// at a real path (so it has a `source_key` and therefore takes the lock
    /// path at all) whose contents `ffmpeg` refuses to decode. Before the fix
    /// the `remove` sat after `let bytes = extract(..)?`, so this exact call
    /// returned `Err` past it and the entry stayed for the process lifetime.
    ///
    /// Asserted as a delta rather than an absolute count: `CHUNK_LOCKS` is a
    /// process-global and `cargo test` runs this binary's tests in parallel
    /// threads, so another test may legitimately hold entries meanwhile.
    #[test]
    fn a_failed_chunk_extraction_does_not_leak_its_chunk_lock() {
        let path = std::env::temp_dir().join(format!(
            "chroma_filmstrip_b057_{}_{:?}.mov",
            std::process::id(),
            std::thread::current().id()
        ));
        // Real file, real `source_key`, contents no decoder will accept.
        std::fs::write(&path, b"this is not a video container").expect("write");

        let source_key = media_cache::source_key(&path).expect("a real file has a key");
        let info = VideoInfo {
            resolution: apelles_types::Resolution::new(320, 240),
            fps_num: 24,
            fps_den: 1,
            duration_secs: 10.0,
            frame_count: 240,
            codec: String::new(),
            pix_fmt: String::new(),
            color_primaries: String::new(),
            color_transfer: String::new(),
            color_space: String::new(),
            has_audio: false,
            audio_sample_rate: 0,
            audio_channels: 0,
        };

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio runtime");

        let before = chunk_lock_count();
        let result = rt.block_on(load_chunk(
            &path,
            &info,
            Some(source_key.as_str()),
            FINE_STORAGE_LEVEL,
            0,
        ));
        assert!(
            result.is_err(),
            "the point of this test is a genuinely failing extraction; it succeeded"
        );
        assert_eq!(
            chunk_lock_count(),
            before,
            "a failed extraction must not leave its CHUNK_LOCKS entry behind (B-057)"
        );
        assert!(
            !CHUNK_LOCKS
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .contains_key(&chunk_cache_key(&source_key, FINE_STORAGE_LEVEL, 0)),
            "this chunk's own key specifically must be gone"
        );

        let _ = std::fs::remove_file(&path);
    }

    /// The other half: the entry is released on the **success** path too — the
    /// behaviour that already worked and that the guard must not regress.
    #[test]
    fn a_successful_chunk_load_also_releases_its_chunk_lock() {
        let Ok(p) = std::env::var("CHROMA_TEST_VIDEO") else {
            eprintln!("skip: set CHROMA_TEST_VIDEO to run");
            return;
        };
        let path = PathBuf::from(&p);
        let info = match probe_cached(&path) {
            Ok(i) => i,
            Err(e) => {
                eprintln!("skip: {p} did not probe: {e}");
                return;
            }
        };
        let source_key = media_cache::source_key(&path).expect("key");
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio runtime");

        let before = chunk_lock_count();
        rt.block_on(load_chunk(
            &path,
            &info,
            Some(source_key.as_str()),
            FINE_STORAGE_LEVEL,
            0,
        ))
        .expect("a real chunk of a real file");
        assert_eq!(chunk_lock_count(), before);
    }
}

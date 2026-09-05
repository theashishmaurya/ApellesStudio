# Media cache & the project-open critical path

**D-128, 2026-09-04**, extended by **D-134** (section 6, and a banner in section 3).
What actually happens between clicking a project card and having a scrubbable
timeline with visible thumbnails and waveforms, what each step costs, and which of
it was being recomputed from scratch every single time.

Owner, live, twice in a row:

> "map out all the action happens — we are doing actions which can be cached again
> and again, i'm sure that's why it takes so long, most editors do it already"

and, watching *Loading timeline…* sit on screen:

> "we should not be getting this at all — if you are loading 4k that might be wrong"

Both instincts were right, and they turned out to be two separate real defects.

---

## 1. The critical path, catalogued

Every step from `ProjectLauncher.tsx`'s card click to a drawn timeline. Timings are
real, measured on this machine against the owner's own project
(`~/Movies/Chroma/New.chroma`: three clips, two of them the same 2.3 GB / 517s / 4K
HEVC `A001_08302215_C019.MOV` on separate tracks, one dangling).

### Before D-128

| # | Operation | Where | Cost (owner's project) | Cached? |
|---|---|---|---|---|
| 1 | `chroma_project_list` → `scan_projects` + read each `thumb.jpg` | `project.rs` | ~ms | **disk** (`<proj>.chroma/thumb.jpg`) |
| 2 | `chroma_project_open` → `load_manifest` (read + parse + migrate) | `project.rs` | ~ms | no (deliberate — the write path) |
| 3 | `ensure_timeline` → `build_from_shots` → `probe_cached` per shot | `edit.rs` | 0.75s / clip, first ever build only | memory only |
| 4 | `migrate_shot_grades_to_clips` | `project.rs` | ~ms | n/a (idempotent) |
| 5 | **`load_video_frame` per clip: `video::probe` + full-resolution `decode_frame`** | `load.rs` | **~2.6s per clip** (0.75s probe + 1.9s 4K→PNG) | **none — and re-probed even though `edit.rs` has a probe cache** |
| 6 | `session_set_active` + `seek_and_install` for the active clip | `project.rs` | 1 real decode | `decode_pipe` (memory) |
| 7 | `save_manifest` | `project.rs` | ~ms | n/a |
| 8 | Edit tab mounts → `chroma_timeline_get` → `resolve_timeline(false)` | `edit.rs` | ~ms | `MANIFEST_CACHE`, **memory only** (D-114) |
| 9 | `PreviewPane` → `chroma_timeline_frame(playhead, maxLongEdge)` | `edit.rs` | ~0.3s | `decode_pipe` (memory); **already downscales** |
| 10 | **`chroma_clip_thumbnails` per visible video clip** | `edit.rs`→`video.rs` | **9.5s** per distinct (clip, count) | `THUMB_CACHE`, **memory only** (D-119/121/124) |
| 11 | **`chroma_audio_waveform` per visible clip with audio** | `audio.rs` | full `symphonia` decode of the clip's whole range, **on the main thread** | **no cache at all, at either end of the IPC that mattered** |
| 12 | Colorist shot strip: `chroma_frame_thumbnails` / `chroma_session_thumbnail` | `commands.rs`/`session.rs` | one `ffmpeg` pass | `state::THUMB_CACHE`, memory only, **wiped on every shot switch** (D-033) |

**The headline.** Every cache in that table was a module-level
`Lazy<Mutex<HashMap<..>>>` static. Not one of them survived a process restart. So
steps 3, 5, 10, 11 and 12 — the entire expensive part — were paid in full on every
single app launch, forever. This session alone restarted the dev process 15+ times;
the owner's ordinary "quit and come back tomorrow" hits exactly the same cost.

Two more things fell out of writing this table:

- **Step 5 was pure waste.** `load_video_frame` decodes a *full-resolution* frame and
  encodes it to PNG, then installs it into `AppState.original_image`. The loop runs it
  once per clip, and each iteration **overwrites the previous one's pixels** — and then
  step 6 immediately overwrites it again for the clip that is genuinely active. So
  every decode but the last was discarded, and the last was discarded too. Only the
  session bookkeeping (path + probe info + playhead) was ever needed. This is the
  direct answer to "if you are loading 4k that might be wrong": yes, and not even for
  a picture anyone saw.
- **`edit.rs`'s own comment claimed `chroma_audio_waveform` had "its own module-level
  cache."** It did not. It had none, and `Waveform.tsx`'s frontend cache keyed on the
  bucket count — which is derived from the clip's on-screen pixel width — so every
  zoom step, panel resize and window resize was a brand-new full audio decode. That is
  precisely the defect D-124 diagnosed and fixed on the filmstrip side, still live in
  the waveform path, undetected because nothing on that path logged anything.

### After D-128

| # | Operation | Cost, cold (first ever) | Cost, warm (2nd app launch) |
|---|---|---|---|
| 3 | probe per clip | 0.75s | **~0** (disk) |
| 5 | per-clip registration | **~0** (probe only, itself disk-cached) | ~0 |
| 10 | filmstrip, per visible chunk | 1.7–2.6s | **~0** (disk) |
| 11 | waveform, per clip range | one decode, off the main thread | **~0** (disk) |

---

## 2. What is persisted, where, and how it is keyed

`crates/chroma-media/src/media_cache.rs` (moved verbatim out of
`app/src-tauri/src/chroma/media_cache.rs` by D-146's `chroma-media` extraction —
a thin re-export shim remains at the old path).

**Location.** `app_cache_dir()/chroma/<namespace>/<first 2 hex chars>/<key>`. Not a new
convention — `app_cache_dir()` is where RapidRAW's own still-image thumbnail cache
(`file_management::resolve_thumbnail_cache_dir` → `app_cache_dir()/thumbnails`) and its
exif cache (`app_cache_dir()/exif`) already live. Bound once from `lib.rs`'s `setup`
into a `OnceLock`, the same shape `exif_processing::initialize_cache_dir` already uses,
so commands don't need an `AppHandle` they have no other use for. The two-character
shard keeps any one directory from collecting tens of thousands of entries.

Namespaces: `filmstrip` (chunk MJPEG), `probe` (`VideoInfo` JSON), `waveform` (peak
envelope JSON), `keyframe-interval` (one float per source file).

**Key: `blake3(absolute path ‖ mtime_nanos ‖ length)`.** This is the one decision that
determines whether a stale tile can ever be served, so the reasoning is explicit:

- A **content hash** is strictly more correct — it catches an in-place edit that
  preserves both mtime and length. But it costs a full read of the file *on every
  lookup*. The owner's own source is 2.3 GB; at blake3's real throughput that is 1–2s
  per lookup, the same order as the decode this cache exists to avoid. It would spend
  the entire win closing a gap that requires someone to rewrite a video file in place
  to exactly its old byte length without touching its mtime.
- **mtime + size** is what RapidRAW's own thumbnail cache in this repo already keys on
  (mtime alone, in fact), and what NLE media caches do in practice — Premiere keys its
  `.cfa`/`.pek` accelerator files off the source media rather than content-hashing
  gigabytes of footage, and Resolve's `CacheClip` behaves the same way.
- Recourse in the pathological case is the same one every NLE gives: delete the cache
  directory.

**Precedent checked** (WebSearch, not assumed): Premiere's Media Cache Database keeps
conformed audio (`.cfa`) and peak files (`.pek`) in a user-relocatable cache directory
with age- and size-based automatic cleanup; Resolve keeps render cache, optimized media
and proxies in a `CacheClip` directory whose location is a per-project working-folder
setting. Both confirm the shape adopted here (a source-keyed directory of derived
artefacts, budget-pruned) and both put the location under user control — which Chroma
does not yet do, and which is the honest follow-up (see the roadmap note below).

**Budget.** 1 GB, pruned to 80% on startup, least-recently-*read* first (`read_blob`
touches an entry's mtime). Pruning is a directory walk, so it runs on a background
thread at startup rather than after every write — mid-session pruning would compete
with the very decodes the cache exists to avoid.

**Writes are atomic** (temp file + rename), so an entry is either absent or complete;
that is what lets reads trust what they get without a checksum. Every cache failure —
unreadable, malformed, no root at all — is a **miss**, never an error. Persistence is an
optimisation; the recompute path is always still there.

---

## 3. The filmstrip's data shape: LOD chunks, not per-clip strips

`crates/chroma-media/src/filmstrip.rs` (moved whole by D-146; shim remains at
`app/src-tauri/src/chroma/filmstrip.rs`) + `packages/editor/src/Filmstrip.tsx`.

D-124 fetched a fixed 64-frame summary of the whole clip and re-tiled it at render
time. Zoom became free — but only because there was nothing left to fetch: a
517-second clip at 90 px/s is 46,530 px wide, wants ~930 tiles, and had 64, so each
tile was drawn 727 px wide from a 185 px picture. D-124 named that as its own deferred
gap; the owner then screenshotted it next to Palmier Pro's timeline, which shows clean,
evenly spaced, densely repeated real frames.

**Windowing and persistence want the same thing from the data shape,** which is why they
landed together. A whole-clip strip is useless to a disk cache: it is keyed by the
clip's trim, so two clips cut from one source share nothing, and any change of visible
range regenerates all of it.

The shape:

- **Levels.** Tile spacing on a power-of-two ladder,
  `[0.0625 … 64]` seconds. Derived, not picked: a tile is drawn ~50 px wide
  (`PX_PER_FRAME`) and zoom runs 1–480 px/s (`ruler.ts`), so the real span of requested
  spacings is 0.104s … 50s, which that ladder brackets with a rung to spare at each end.
  A request is snapped **down** to a rung, never up — rounding up is exactly what
  stretches a tile.
- **Chunks.** A level's timeline is cut into fixed runs of tiles, indexed from the
  **source file's** t=0 — never the clip's trim point. That is what makes a chunk
  shareable between two clips cut from one file, between scroll positions, and between
  every zoom that lands on the same rung.
> **Updated by D-134 (B-049).** The bullet below describes D-128's chunk sizing,
> which is still how the *coarse* band works. In the **fine** band it is
> superseded: every fine level (<1s spacing) is now decoded and stored **once**,
> at the finest rung, in chunks spanning a fixed 8s, and every other fine level
> is served by decimating that — exact, because the ladder is powers of two. The
> reason is a measurement D-128 did not take: a fine chunk's cost is its *span*,
> not its tile count (8s of the owner's 4K HEVC is ~2.15s whether it yields 16
> tiles or 64), so storing four separate fine levels paid the same price four
> times for the same seconds. That is what made a zoom step cost a full
> re-decode. See D-134 and section 6 below.

- **Chunk width is level-dependent** (`tiles_per_chunk`). Coarse levels (≥1s spacing)
  get the full 64 tiles: essentially all real footage has keyframes denser than that, so
  the decode is keyframe-only and cheap per second of source (measured: 64 tiles over
  64s of the owner's 4K HEVC, **1.7s**). Fine levels are sized to span a bounded ~8
  seconds of source instead, because there the cost tracks *seconds read*, not tile
  count — at 0.5s spacing a 64-tile chunk spans 32s and costs 8.1s, while a 16-tile
  chunk spans 8s and costs ~2.5s. It depends only on the level — never on the file's
  keyframe interval — because chunk boundaries must be stable for a given (source,
  level) or a cached chunk index would mean a different range on a later run.

  The 1s boundary is a real trade, set by a **correctness** constraint rather than a
  speed one. Clamping levels 1s and 2s to small chunks (as an 8-second budget would)
  makes a normal viewport at those zooms need more chunks than the per-request budget
  allows — and a truncated window leaves part of the visible clip with no tiles at all.
  A property test (`a_realistic_viewport_never_exceeds_the_chunk_budget`) walks every
  zoom a real 1.2x wheel step reaches and asserts the budget is never approached. The
  cost of the trade is that footage with keyframes *sparser* than 1s falls back to an
  every-frame decode of a 64s window; such footage is almost never 4K, and the result is
  on disk permanently afterwards.
- **The frontend snaps its window outward** to a multiple of 16 tiles and overscans by
  half a viewport, so ordinary scrolling reuses the previous request; and
  `TimelinePane.tsx` buckets `scrollLeft` to 200 px before it reaches the filmstrip, so
  the (expensive) per-clip render doesn't rerun on every scrolled pixel.

### The keyframe gate, which is the real cost lever

D-124 gated `-skip_frame nokey` on a fixed 4-second threshold — safe, but far too
conservative. The owner's own 4K HEVC footage has keyframes every **0.875s**, so every
spacing under 4s was forced onto the every-frame path for no reason.

`video::probe_keyframe_interval` now measures the file's real worst-case keyframe gap
by reading **packets**, not frames (`ffprobe -show_entries packet=pts_time,flags`).
Nothing is decoded, so it is a metadata scan: **0.23s** on the 2.3 GB file, versus 7.5s
for the equivalent frame-level probe. The result is cached to disk like everything else.
Max gap rather than mean, so a file with irregular keyframes (the owner's VFR screen
recording had **three keyframes in eight seconds**) is judged on its worst case.

Effect on the same file, same 64 tiles at 1s spacing: **1.7s with the gate open,
~16s with it shut.**

---

## 4. Verification

Real numbers, this machine, the owner's own `A001_08302215_C019.MOV`:

| Operation | Before | After |
|---|---|---|
| project open, per clip (probe + full-res decode) | 2.6s | ~0 cold / ~0 warm |
| whole-clip 64-frame filmstrip | 9.5s | — (shape retired) |
| one filmstrip chunk, 1s spacing, 64 tiles | (n/a: 8.1s for the 0.5s-spacing equivalent) | 1.7s |
| one filmstrip chunk, 0.25s spacing, 32 tiles | — | 2.6s |
| a 16s filmstrip window (32 tiles), cold → **warm-from-disk** | n/a — no disk cache existed | **5.41s → 0.007s** |
| tile width at 90 px/s on the 517s clip | **727 px** (one frame smeared) | ≤50 px, real distinct frames |
| tile width at 480 px/s on the 517s clip | **3,879 px** | ≤50 px |
| `ffprobe` per clip on a reopen | 0.75s | ~0 (disk) |
| keyframe-interval probe | n/a (fixed 4s guess) | 0.23s, once, then disk |

---

## 5. Honest gaps

- **The cache directory is not user-configurable.** Both Premiere and Resolve let you
  point the media cache at a scratch volume, and on a machine whose system drive is
  nearly full (this one, tonight) that matters. Named, not built.
- **No cache-clear UI.** Deleting `app_cache_dir()/chroma` by hand is the only recourse
  today, and it is the documented one for the mtime+size keying's pathological case.
- **`state::THUMB_CACHE` (Colorist's poster frames, D-033) is still memory-only.** It is
  a genuinely different artefact — a much larger poster image, scoped to "whichever one
  shot is loaded" and busted wholesale on every shot switch — and it was not on the
  reported slow path. It is the obvious next namespace.
- **`MANIFEST_CACHE` (D-114) stays memory-only, deliberately.** It caches a file the app
  itself writes constantly; the read it avoids is a few ms of JSON parse, and persisting
  a mutable document across restarts buys nothing and risks staleness.

---

## 6. Storage levels, and what a zoom step really cost (D-134, B-049)

The owner tested D-128 live and reported everything fast **except clicking the
zoom buttons**. The catalogue in section 1 is what made that diagnosable: load
and scroll were confirmed fixed, so the remaining stall had to be something the
zoom action does that scrolling does not — change the LOD level.

### The measurement D-128 never took

`chroma::video::extract_thumb_chunk`'s exact `ffmpeg` invocation, replayed by
hand against `A001_08302215_C019.MOV`:

| what | cost |
|---|---|
| 8s of source at 0.125s spacing (64 tiles) | 2.15s |
| 8s of source at 0.25s spacing (32 tiles) | 2.11s |
| 8s of source at 0.5s spacing (16 tiles) | 2.18s |
| 2s / 4s / 8s / 16s / 32s span, 0.0625s spacing | 1.03 / 1.45 / 2.75 / 4.90 / 8.37s |
| one single tile | 0.82s |
| 64s at 1s spacing, keyframe-only | 1.50s |

Two readings. **A fine chunk's cost is its span, not its tile count** — below
the keyframe gate ffmpeg decodes every frame regardless of how many it emits.
And the shape is **~0.8s of fixed spawn/seek plus ~0.24s per second of source**;
seek position barely matters (1.64s at t=400s vs 2.05s at t=5s), so the fixed
part is process spawn and decoder init.

So D-128's four fine levels were four separate full-price decodes of the same
seconds. And a viewport at the default zoom is ~5 chunks, which D-128's request
loop `await`ed one at a time while two of `EXTRACT_SEMAPHORE`'s three permits
sat idle.

### What changed

- **Storage level ≠ requested level.** Every fine level maps to
  `FINE_STORAGE_LEVEL` (0.0625s), chunks spanning a fixed 8s at every fine
  level so the boundaries coincide. A request at a coarser fine rung is
  `.step_by(stride)` over that. Exact, not approximate: the ladder is powers of
  two, so a coarser level's sample times are a strict subset of a finer one's.
- **Coarse levels still store at themselves** — 64s and up is far too much
  source to read at 0.0625s spacing — but a coarse chunk is assembled free from
  the rung below when those chunks are already cached (`derive_from_finer`,
  cache-only, never decodes to find out). Derived chunks are memoised but not
  written to disk: the bytes are already there under another key.
- **A request's chunks load concurrently.** The semaphore still bounds real
  `ffmpeg` processes; it is no longer the request loop's job to serialise them.
- **The cache key carries the tile count**, because "level 0" now means
  something different (128 tiles over 8s, not 64 over 4s) and a D-128 build's
  entries live in the same `app_cache_dir()`.

### Real numbers, one fixed 32s window of source, rung by rung

| request | D-128 | D-134 |
|---|---|---|
| cold window, 0.5s spacing | 9.45s | **7.15s** |
| zoom in → 0.25s | 9.18s | **0.001s** |
| zoom in → 0.125s | 9.63s | **0.000s** |
| zoom in → 0.0625s | 12.51s | **0.000s** |
| zoom out → 1.0s (coarse, span not covered) | 1.52s | 1.62s |
| zoom back → 0.5s | 0.000s | 0.000s |
| **the fine sweep, total** | **31.3s** | **0.001s** |

The cold window got faster despite each chunk now yielding 128 tiles instead of
16, because the concurrency more than pays for the extra mjpeg encodes.

Side effect worth knowing: four zoom clicks in a row used to resolve to four
disjoint chunk sets queued behind one semaphore. They now resolve to the *same*
storage chunks, which `CHUNK_LOCKS` already de-duplicates — so the fourth click
waits on the first click's decode rather than on a queue of four. No request
cancellation was needed; it stays a named, unbuilt improvement.

### Still true

The first zoom into a range never viewed before still decodes it — ~7s for a
full viewport at the default zoom on a 517s 4K source. Those frames have never
been read; the remaining lever is proxies/optimized media, still a roadmap item
(section 5) rather than a subsystem smuggled in here.

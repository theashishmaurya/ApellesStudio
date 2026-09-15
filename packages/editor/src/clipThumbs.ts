/**
 * @apelles/editor — the shared `chroma_clip_thumbnails` fetch and its cache
 * (extracted by D-328 from `Filmstrip.tsx`, where it had been private).
 *
 * **What it is.** One promise-cached accessor for decoded poster frames out of
 * a source file, keyed by `(sourcePath, window)`. `Filmstrip` asks for a whole
 * scrolled window of tiles; the Index panel's marker rows ask for a single
 * frame. Both go through this one function and therefore share one cache — a
 * marker sitting on a frame the filmstrip already drew costs no second decode.
 *
 * **Why it moved.** It did not change behaviour at all; it moved because a
 * second consumer appeared, and CLAUDE.md's rule for that is explicit ("Shared
 * logic → a package/crate, never copy-pasted; if two places need it, extract
 * it"). The alternative — a second `Map` in the new panel — would have been a
 * second uncoordinated cache over the same Tauri command, with its own
 * eviction and its own duplicate in-flight requests for frames the filmstrip
 * was already fetching.
 *
 * **What it does NOT do.** No React, no layout, no LOD policy: which window to
 * ask for is the caller's decision (`Filmstrip`'s `requestWindow` computes a
 * scroll-and-zoom-aware one; `thumbAtSourceSecs` below takes the trivial
 * one-frame case). It does not convert timeline frames to source seconds
 * either — that needs a `Clip`, which is the caller's to resolve.
 */
import { invoke } from '@tauri-apps/api/core';

/** One decoded poster frame, as `chroma_clip_thumbnails` returns it. `secs` is
 *  in the SOURCE file's own time base, not the timeline's. */
export interface ClipThumb {
  frame: number;
  secs: number;
  dataUrl: string;
}

/** The source range to fetch, in the source file's own time base. */
export interface ThumbWindow {
  startSecs: number;
  durationSecs: number;
  stepSecs: number;
}

/** Entries, not bytes — each holds a promise of a tile array. Cleared wholesale
 *  rather than LRU-evicted: the working set is "what is on screen", which
 *  changes en masse on a scroll or zoom, so per-entry bookkeeping would buy
 *  nothing over a periodic reset. */
const MAX_CACHE = 200;
const thumbCache = new Map<string, Promise<ClipThumb[]>>();

/** The cache key for a `(sourcePath, window)` pair — exported because
 *  `Filmstrip` also uses it as a React effect dependency: `requestWindow`
 *  returns a fresh object every render, and the whole point of snapping the
 *  window is that an unchanged one must not re-fire the fetch. Sharing the key
 *  function is what guarantees "the effect re-fires" and "the cache misses"
 *  mean the same thing rather than two nearly-identical serialisations. */
export function thumbWindowKey(sourcePath: string, w: ThumbWindow): string {
  return `${sourcePath}|${w.stepSecs}|${w.startSecs.toFixed(3)}|${w.durationSecs.toFixed(3)}`;
}

/** Fetch (or return the in-flight/cached promise for) one window of tiles.
 *  Never rejects — a failure logs and resolves to `[]`, because a missing
 *  filmstrip is a soft failure for the UI, and evicts its own key so a
 *  transient error is not cached for the life of the page (D-124). */
export function getThumbs(sourcePath: string, w: ThumbWindow): Promise<ClipThumb[]> {
  const key = thumbWindowKey(sourcePath, w);
  let p = thumbCache.get(key);
  if (!p) {
    if (thumbCache.size > MAX_CACHE) thumbCache.clear();
    p = invoke<{ frame: number; secs: number; dataUrl: string }[]>('chroma_clip_thumbnails', {
      sourcePath,
      startSecs: w.startSecs,
      durationSecs: w.durationSecs,
      stepSecs: w.stepSecs,
    })
      .then((rows) => rows.map((r) => ({ frame: r.frame, secs: r.secs, dataUrl: r.dataUrl })))
      .catch((err) => {
        // Real failure, not silently dropped — a clip with genuinely no
        // filmstrip and zero trace of why is undiagnosable (D-124 found
        // exactly that live). A missing filmstrip stays a soft failure for
        // the UI; this only makes it a loud one in devtools.
        console.error('[clipThumbs] chroma_clip_thumbnails failed for', sourcePath, err);
        // Evict, so a transient failure is not cached for the life of the page.
        thumbCache.delete(key);
        return [];
      });
    thumbCache.set(key, p);
  }
  return p;
}

/** How long a one-frame request asks for, in source seconds (D-328).
 *
 *  Not a single instant: `chroma_clip_thumbnails` steps through a RANGE, and a
 *  zero-length one returns nothing. A quarter second is long enough to always
 *  contain at least one step at any real frame rate, and short enough that the
 *  first tile back is the frame the caller asked about rather than a visibly
 *  later one. */
const SINGLE_THUMB_WINDOW_SECS = 0.25;

/**
 * The one poster frame at (or immediately after) `secs` in a source file —
 * the row-thumbnail case, as opposed to `Filmstrip`'s scrolled window (D-328).
 *
 * Resolves to `null` rather than throwing when the decode produced nothing, so
 * a caller renders a placeholder instead of handling an error: a row whose
 * thumbnail is missing is still a perfectly usable row.
 *
 * Requests are quantised onto a `SINGLE_THUMB_WINDOW_SECS` grid so that many
 * rows pointing near the same moment share one cache entry and one decode,
 * rather than each producing a near-identical request that misses the cache by
 * a few milliseconds.
 */
export async function thumbAtSourceSecs(sourcePath: string, secs: number): Promise<string | null> {
  if (!sourcePath || !Number.isFinite(secs)) return null;
  const start = Math.max(0, Math.floor(secs / SINGLE_THUMB_WINDOW_SECS) * SINGLE_THUMB_WINDOW_SECS);
  const rows = await getThumbs(sourcePath, {
    startSecs: start,
    durationSecs: SINGLE_THUMB_WINDOW_SECS,
    stepSecs: SINGLE_THUMB_WINDOW_SECS,
  });
  return rows[0]?.dataUrl ?? null;
}

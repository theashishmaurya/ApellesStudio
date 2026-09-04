/**
 * @chroma/editor — real video filmstrip thumbnails for a timeline clip
 * (D-119), the picture-content sibling to `Waveform.tsx`'s amplitude one.
 *
 * Owner, live, with a screenshot of Palmier Pro's real timeline as the
 * reference: "add the proper thumbnail to the clips timeline also when
 * dragging" + "when we drag use the proper preview instead of dotted line
 * how other editors do it." Same architectural shape as `Waveform.tsx`
 * (D-051): frames are extracted once in Rust (`chroma_clip_thumbnails` →
 * `video::extract_thumb_strip_range`, one `ffmpeg` decode pass over exactly
 * the clip's real `[source_start, source_start + duration)` range, not the
 * whole source file), cached (both Rust-side, `edit.rs::THUMB_CACHE`, and
 * here in a module-level `Map` mirroring `Waveform.tsx`'s own — the same
 * "re-renders and other clips redrawing shouldn't refetch" reasoning), and
 * tiled here as plain `<img>` elements (no canvas needed — these are already
 * small JPEGs, not a signal to synthesize).
 *
 * **What is fetched no longer depends on how wide the clip is drawn (D-124).**
 * D-119 derived the requested frame `count` from the clip's on-screen pixel
 * width, bucketed to 50px so that *jitter* wouldn't refetch. That handled
 * jitter but not zoom: a real zoom step changes the width by 20% at a time,
 * which crosses bucket after bucket, and every crossing was a brand-new cache
 * key and therefore a brand-new `ffmpeg` decode. Measured live on the owner's
 * own project, one clip, one zoom sweep: `count` went 64 -> 41 -> 20 -> 10,
 * i.e. four separate full decodes of the same 517-second 4K source, each of
 * which took 105 seconds before this pass's backend fix. Worse, every one of
 * them blanked the strip first (`setThumbs(null)`) and left it blank until it
 * returned — which is exactly the "when we zoom and change that its also not
 * good" the owner reported, and, when several of those decodes saturated the
 * backend's 3-permit semaphore, why an unrelated short clip's strip could sit
 * pending forever with no error and no log line to show for it.
 *
 * So the fetch is now keyed on the clip's own identity and source range only
 * — `count` is derived from its *duration* — and zoom is handled purely at
 * render time by sampling that fixed set down to however many tiles fit the
 * current width. This is what `Waveform.tsx` (D-051) has always actually
 * done, and what D-119 described itself as copying but did not: extract a
 * fixed-size summary once, then render it scaled. Zoom now costs zero
 * backend calls and never blanks.
 */

import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

import { MAX_PX_PER_SEC } from './ruler';

interface ClipThumb {
  frame: number;
  dataUrl: string;
}

const MAX_CACHE = 200;
const thumbCache = new Map<string, Promise<ClipThumb[]>>();

/** ~1 tile per this many px of on-screen clip width — matches the reference
 *  screenshot's real tiling density (Palmier: roughly every 40-60px). This is
 *  now purely a *render* density: it decides how many of the already-fetched
 *  frames to show, never how many to ask the backend for. */
const PX_PER_FRAME = 50;

/** Frames fetched per second of source duration, bounded below. Derived from
 *  the zoom ceiling rather than picked: at `MAX_PX_PER_SEC` one second of
 *  source is drawn `MAX_PX_PER_SEC` px wide, which at `PX_PER_FRAME` px per
 *  tile is this many tiles. Fetching at exactly that density means a clip
 *  short enough to stay under `MAX_FETCH_FRAMES` has a real distinct frame
 *  for every tile even at full zoom-in — never a handful of frames smeared
 *  across the clip, which is the other half of the owner's "when we zoom and
 *  change that its also not good." */
const FRAMES_PER_SOURCE_SEC = MAX_PX_PER_SEC / PX_PER_FRAME;
const MIN_FETCH_FRAMES = 8;
/** Matches the backend's own `count.clamp(1, 64)` in `chroma_clip_thumbnails`. */
const MAX_FETCH_FRAMES = 64;

/** How many frames to extract for a clip of this length — duration-derived,
 *  never width-derived, so zoom never changes it and so never refetches.
 *  Exported for the unit tests that pin exactly that property.
 *
 *  Past `MAX_FETCH_FRAMES / FRAMES_PER_SOURCE_SEC` (~6.7s) of source this
 *  saturates and a long clip does get fewer frames than tiles at extreme
 *  zoom-in, re-tiling what it has. That is the deliberate trade and the same
 *  one `Waveform.tsx` makes: a bounded, cached summary beats a decode per
 *  zoom step, and 64 frames of a 517s clip is already one every 8 seconds —
 *  the frames genuinely differ far more than the tiles can show. */
export function fetchFrameCount(durationSecs: number): number {
  if (!(durationSecs > 0)) return MIN_FETCH_FRAMES;
  const wanted = Math.ceil(durationSecs * FRAMES_PER_SOURCE_SEC);
  return Math.max(MIN_FETCH_FRAMES, Math.min(MAX_FETCH_FRAMES, wanted));
}

/** Pick `tileCount` evenly-spaced entries out of `thumbs` (the render-time
 *  half of the split above). Kept pure and exported so the sampling has a real
 *  correct/incorrect answer in a unit test, independently of React. */
export function sampleThumbs<T>(thumbs: T[], tileCount: number): T[] {
  if (thumbs.length === 0) return thumbs;
  const n = Math.max(1, Math.min(thumbs.length, tileCount));
  if (n >= thumbs.length) return thumbs;
  if (n === 1) return [thumbs[0]];
  const last = thumbs.length - 1;
  return Array.from({ length: n }, (_, i) => thumbs[Math.round((i * last) / (n - 1))]);
}

function cacheKey(sourcePath: string, startSecs: number, durationSecs: number, count: number): string {
  return `${sourcePath}|${startSecs.toFixed(3)}|${durationSecs.toFixed(3)}|${count}`;
}

function getThumbs(sourcePath: string, startSecs: number, durationSecs: number, count: number): Promise<ClipThumb[]> {
  const key = cacheKey(sourcePath, startSecs, durationSecs, count);
  let p = thumbCache.get(key);
  if (!p) {
    if (thumbCache.size > MAX_CACHE) thumbCache.clear();
    p = invoke<{ frame: number; dataUrl: string }[]>('chroma_clip_thumbnails', {
      sourcePath,
      startSecs,
      durationSecs,
      count,
    })
      .then((rows) => rows.map((r) => ({ frame: r.frame, dataUrl: r.dataUrl })))
      .catch((err) => {
        // Real failure, not silently dropped — a clip with genuinely no
        // filmstrip and zero trace of why (this exact silent-catch, found
        // live: the owner's 4K HEVC clip showed no thumbnail with nothing
        // in any log to explain it) is undiagnosable. A missing filmstrip
        // stays a soft failure for the *UI* (the clip still renders, just
        // without a strip) — this only makes it a loud one in devtools.
        console.error('[Filmstrip] chroma_clip_thumbnails failed for', sourcePath, err);
        // D-124 — evict, so a failure is not cached for the life of the page.
        // The old code left the resolved-to-`[]` promise in the map forever:
        // one transient failure (a busy machine, a file briefly unreadable)
        // and that clip could never get a strip again short of a reload, with
        // nothing after the first attempt to show for it.
        thumbCache.delete(key);
        return [];
      });
    thumbCache.set(key, p);
  }
  return p;
}

export interface FilmstripProps {
  sourcePath: string;
  /** clip's `source_start` in seconds (frames / fps) */
  startSecs: number;
  /** clip's `duration` in seconds (frames / fps) */
  durationSecs: number;
  /** on-screen pixel width to render at — drives only how many of the fetched
   *  frames are tiled, never how many are requested (D-124) */
  width: number;
  height: number;
}

export function Filmstrip({ sourcePath, startSecs, durationSecs, width, height }: FilmstripProps) {
  const [thumbs, setThumbs] = useState<ClipThumb[] | null>(null);

  const count = fetchFrameCount(durationSecs);

  useEffect(() => {
    let cancelled = false;
    // NOT gated on `width` (D-124). It used to be — an early `return` on
    // `width <= 0` while `width` was absent from the dependency array below,
    // so a clip that first rendered at zero width never fetched at all once
    // its real width arrived, unless the bucketed count happened to change
    // too. Width now only affects the render, so it has no business here.
    if (!sourcePath || durationSecs <= 0) {
      setThumbs(null);
      return;
    }
    setThumbs(null);
    getThumbs(sourcePath, startSecs, durationSecs, count).then((t) => {
      if (!cancelled) setThumbs(t);
    });
    return () => {
      cancelled = true;
    };
  }, [sourcePath, startSecs, durationSecs, count]);

  // Render-time only: how many of the fetched frames to actually tile at the
  // current zoom. Changing this re-tiles cached images — no backend call, no
  // blank frame in between. Keeping each tile at ~`PX_PER_FRAME` wide is also
  // what stops the tiles stretching: with a fixed tile count, `flex-1` gave
  // every tile `width / n` px, so zooming in smeared each frame wider and
  // wider across the clip.
  const tiles = useMemo(
    () => (thumbs ? sampleThumbs(thumbs, Math.round(width / PX_PER_FRAME)) : []),
    [thumbs, width],
  );

  if (tiles.length === 0 || width <= 0 || height <= 0) return null;

  return (
    <div
      className="absolute inset-0 flex overflow-hidden"
      style={{ width, height, pointerEvents: 'none' }}
    >
      {tiles.map((t, i) => (
        <img
          key={`${t.frame}-${i}`}
          src={t.dataUrl}
          alt=""
          draggable={false}
          className="h-full flex-1 min-w-0 object-cover"
          style={{ opacity: 0.85 }}
        />
      ))}
    </div>
  );
}

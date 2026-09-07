/**
 * @chroma/editor — real video filmstrip thumbnails for a timeline clip:
 * **windowed over the visible scroll range**, at a level of detail that
 * matches the current zoom (D-128). Supersedes D-119/D-121/D-124's
 * fixed-64-frame whole-clip strip.
 *
 * Owner, live, with two screenshots side by side: our own timeline at high
 * zoom, every tile visibly stretched and smeared, next to Palmier Pro's —
 * clean, evenly spaced, correctly proportioned frames, more of them as you
 * zoom in, never stretched. That is exactly the gap D-124 named as its own
 * deferred limitation: it fetched a fixed 64-frame summary of the whole clip
 * and re-tiled it, so a 517-second clip at 90 px/s (46,530 px wide, wanting
 * ~930 tiles) had 64 pictures to fill them with and drew each one 727 px
 * wide from a 185 px source. Zoom was free, but only because there was
 * nothing left to fetch.
 *
 * **What changed.** The fetch is now a *window*: "tiles roughly `step` apart
 * covering the source range this clip is actually showing on screen right
 * now." Zooming in shrinks `step`, so you get more, finer tiles over a
 * narrower range — never the same frames stretched. The backend
 * (`chroma_clip_thumbnails` → `chroma::filmstrip`) quantises `step` to a
 * power-of-two ladder and cuts the source into fixed chunks at that level,
 * so:
 *
 * - a small scroll or a sub-step zoom nudge resolves to the same request and
 *   costs nothing;
 * - a chunk is shared between two clips cut from the same source file, and
 *   between every zoom level that lands on the same rung;
 * - and every chunk is written to a **persistent on-disk cache**, so the
 *   second time you open the project — tomorrow, in a new process — it is
 *   already there.
 *
 * Two properties D-124 got right are kept deliberately. Tiles already fetched
 * stay on screen while a new window loads (the strip never blanks, which is
 * half of what "when we zoom and change that its also not good" was about),
 * and a failed fetch is evicted rather than cached, so one transient failure
 * doesn't cost a clip its filmstrip until a page reload.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface ClipThumb {
  frame: number;
  secs: number;
  dataUrl: string;
}

const MAX_CACHE = 200;
const thumbCache = new Map<string, Promise<ClipThumb[]>>();

/** ~1 tile per this many px of on-screen clip width — matches the reference
 *  screenshot's real tiling density (Palmier: roughly every 40-60px). Unlike
 *  D-124, where this was purely a render-time density, it is now also what
 *  sets the *requested* tile spacing: that is the whole point of windowing. */
const PX_PER_FRAME = 50;

/** Mirrors `chroma::filmstrip::LEVEL_STEPS` exactly. Quantising client-side
 *  as well as server-side is not redundant: it is what keeps the *cache key*
 *  stable across a zoom nudge, so a 1.2x wheel step that lands on the same
 *  rung produces no request at all rather than an IPC round trip the backend
 *  would then answer from cache. */
export const LEVEL_STEPS_SECONDS: readonly number[] = [
  0.0625, 0.125, 0.25, 0.5, 1, 2, 4, 8, 16, 32, 64,
];

/** The window is snapped outward to a multiple of this many tiles, so
 *  scrolling by a few pixels reuses the previous request. Small enough that
 *  the snap never asks for much more than the viewport, large enough that
 *  ordinary scrolling is mostly free. */
const WINDOW_QUANTUM_TILES = 16;

/** Hard ceiling on tiles rendered for one clip, mirroring the backend's own
 *  per-request cap. A window is viewport-sized, so this is never reached in
 *  normal use — it exists so a degenerate layout (a clip measured at an
 *  absurd width mid-transition) can't build a huge DOM. */
const MAX_TILES = 512;

/** Tile spacing, in source seconds, that a clip drawn `width` px wide wants
 *  in order to put a real distinct picture roughly every `PX_PER_FRAME` px.
 *  Pure and exported: this is the arithmetic the whole anti-stretch property
 *  rests on, so it has a real correct/incorrect answer in a unit test. */
export function desiredStepSecs(durationSecs: number, width: number): number {
  if (!(durationSecs > 0) || !(width > 0)) return LEVEL_STEPS_SECONDS[0];
  const pxPerSec = width / durationSecs;
  return PX_PER_FRAME / pxPerSec;
}

/** Snap `stepSecs` down to the nearest rung of [`LEVEL_STEPS_SECONDS`] —
 *  never *up*, because a coarser spacing than asked for is precisely what
 *  stretches a tile. Clamped to the ladder at both ends. */
export function quantizeStepSecs(stepSecs: number): number {
  if (!(stepSecs > 0)) return LEVEL_STEPS_SECONDS[0];
  let chosen = LEVEL_STEPS_SECONDS[0];
  for (const step of LEVEL_STEPS_SECONDS) {
    if (step <= stepSecs) chosen = step;
  }
  return chosen;
}

export interface RequestWindow {
  startSecs: number;
  durationSecs: number;
  stepSecs: number;
}

/**
 * The source range to fetch for a clip whose `[visibleStartPx, visibleEndPx)`
 * is on screen, snapped outward so nearby scroll positions share a request.
 *
 * All times are in the **source file's** own base (the same base
 * `chroma_clip_thumbnails` takes), because that is what makes a window
 * shareable between two clips trimmed differently out of one file.
 *
 * Returns `null` when there is nothing to draw — no width, no duration, or a
 * clip scrolled entirely off screen. That last case matters: it is what stops
 * a 40-clip timeline from requesting 40 windows when two are visible.
 */
export function requestWindow(
  sourceStartSecs: number,
  durationSecs: number,
  width: number,
  visibleStartPx: number,
  visibleEndPx: number,
): RequestWindow | null {
  if (!(durationSecs > 0) || !(width > 0)) return null;
  const visLeft = Math.max(0, Math.min(width, visibleStartPx));
  const visRight = Math.max(0, Math.min(width, visibleEndPx));
  if (!(visRight > visLeft)) return null;

  const stepSecs = quantizeStepSecs(desiredStepSecs(durationSecs, width));
  const secsPerPx = durationSecs / width;
  // Half a viewport of overscan on each side, so a scroll in either direction
  // has tiles ready before it needs them.
  const overscan = ((visRight - visLeft) * secsPerPx) / 2;
  const rawStart = sourceStartSecs + visLeft * secsPerPx - overscan;
  const rawEnd = sourceStartSecs + visRight * secsPerPx + overscan;

  const quantum = stepSecs * WINDOW_QUANTUM_TILES;
  const clipEnd = sourceStartSecs + durationSecs;
  const start = Math.max(sourceStartSecs, Math.floor(rawStart / quantum) * quantum);
  const end = Math.min(clipEnd, Math.ceil(rawEnd / quantum) * quantum);
  if (!(end > start)) return null;
  return { startSecs: start, durationSecs: end - start, stepSecs };
}

function cacheKey(sourcePath: string, w: RequestWindow): string {
  return `${sourcePath}|${w.stepSecs}|${w.startSecs.toFixed(3)}|${w.durationSecs.toFixed(3)}`;
}

function getThumbs(sourcePath: string, w: RequestWindow): Promise<ClipThumb[]> {
  const key = cacheKey(sourcePath, w);
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
        console.error('[Filmstrip] chroma_clip_thumbnails failed for', sourcePath, err);
        // Evict, so a transient failure is not cached for the life of the page.
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
  /** the clip's full on-screen width in px at the current zoom */
  width: number;
  height: number;
  /** Visible sub-range of the clip, in px from its own left edge. Omitted
   *  (the drag overlay, which has no scroll container of its own) means the
   *  whole clip is treated as visible. */
  visibleStartPx?: number;
  visibleEndPx?: number;
}

export function Filmstrip({
  sourcePath,
  startSecs,
  durationSecs,
  width,
  height,
  visibleStartPx,
  visibleEndPx,
}: FilmstripProps) {
  // Keeps the last good tiles on screen while a new window is in flight, so
  // a zoom or scroll never blanks the strip (D-124's own hard-won property).
  //
  // D-197 — that used to be a separate `lastGood` ref that the render body
  // read (`thumbs?.length ? thumbs : lastGood.current`). Reading a ref during
  // render is a real Rules-of-React violation — render output must not depend
  // on a value React does not track — and it is what the React Compiler's
  // "Cannot access refs during render" bailout on this file was pointing at.
  // Simply never overwriting good tiles with an empty result gets the exact
  // same on-screen behaviour with one piece of state and no ref: an empty
  // response leaves the previous tiles in place instead of being written and
  // then filtered back out one line later.
  const [thumbs, setThumbs] = useState<ClipThumb[] | null>(null);

  const window_ = useMemo(
    () =>
      requestWindow(
        startSecs,
        durationSecs,
        width,
        visibleStartPx ?? 0,
        visibleEndPx ?? width,
      ),
    [startSecs, durationSecs, width, visibleStartPx, visibleEndPx],
  );

  // Depend on the *serialised* window, not the object — `requestWindow`
  // returns a fresh object every render, and the whole point of snapping it
  // is that an unchanged window must not re-fire this effect.
  const windowKey = window_ ? cacheKey(sourcePath, window_) : '';

  // D-197 — the effect below must fire on the SNAPPED window (`windowKey`),
  // never on `window_`'s object identity, for the reason stated just above.
  // That used to need a line-scoped suppression of the `exhaustive-deps`
  // react-hooks lint rule — and a suppression of ANY react-hooks rule also
  // switches the React Compiler off for the whole file, so
  // `Filmstrip` (rendered once per clip, re-rendered on every timeline
  // drag/zoom/scroll) was getting no auto-memoization at all. The standard
  // "latest ref" shape gets the same behaviour with an honest dependency
  // array and no suppression: this effect writes the ref (never during
  // render, which would be its own Rules-of-React violation), and because
  // effects run in declaration order within a commit, the fetch effect below
  // always reads the value from the same commit.
  const windowRef = useRef(window_);
  useEffect(() => {
    windowRef.current = window_;
  }, [window_]);

  useEffect(() => {
    let cancelled = false;
    const w = windowRef.current;
    if (!sourcePath || !w) return;
    getThumbs(sourcePath, w).then((t) => {
      if (cancelled) return;
      if (t.length > 0) setThumbs(t);
    });
    return () => {
      cancelled = true;
    };
  }, [sourcePath, windowKey]);

  const pxPerSec = durationSecs > 0 ? width / durationSecs : 0;
  const shown = thumbs;

  const tiles = useMemo(() => {
    if (!shown || pxPerSec <= 0) return [];
    // Tile width from the real spacing of what came back, not from what was
    // asked for: the backend may serve a finer level than requested, and a
    // tile drawn wider than its own slice is exactly the smear this fixes.
    const spacing = shown.length > 1 ? shown[1].secs - shown[0].secs : window_?.stepSecs ?? 0;
    const tileWidth = Math.max(1, (spacing > 0 ? spacing : 1 / pxPerSec) * pxPerSec);
    const out: { key: string; left: number; w: number; src: string }[] = [];
    for (const t of shown) {
      const left = (t.secs - startSecs) * pxPerSec;
      if (left >= width || left + tileWidth <= 0) continue;
      out.push({ key: `${t.frame}-${t.secs}`, left, w: tileWidth, src: t.dataUrl });
      if (out.length >= MAX_TILES) break;
    }
    return out;
  }, [shown, pxPerSec, startSecs, width, window_?.stepSecs]);

  if (tiles.length === 0 || width <= 0 || height <= 0) return null;

  return (
    <div
      className="absolute inset-0 overflow-hidden"
      style={{ width, height, pointerEvents: 'none' }}
    >
      {tiles.map((t) => (
        <img
          key={t.key}
          src={t.src}
          alt=""
          draggable={false}
          className="absolute top-0 h-full object-cover"
          style={{ left: t.left, width: t.w, opacity: 0.85 }}
        />
      ))}
    </div>
  );
}

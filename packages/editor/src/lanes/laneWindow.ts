/**
 * @apelles/editor — which clips a lane renders (D-437 S1).
 *
 * What it is: horizontal culling for the timeline lane renderer. A per-track
 * index (built once per `Track` OBJECT — `shareUnchanged` keeps an untouched
 * track `===` across a commit, so the cache hit is free) answers "which clips
 * can intersect this frame window" in O(log n + k), and `laneWindow` turns a
 * scroll position into that window with one viewport of overscan on each side,
 * quantised so a lane re-renders once per half viewport of scroll rather than
 * per pixel.
 *
 * Overlap is safe: clips are sorted by `start_frame` and a running maximum of
 * end frames is kept, so a long clip that starts before the window and reaches
 * into it is found (track `clips` order is bookkeeping, not time — D-054 — and
 * overlap is not assumed impossible).
 *
 * Pinned ids (the selection, the dnd-kit drag source, the edit gesture's
 * target, the focused clip) are always returned wherever they are: unmounting
 * a drag source mid-drag breaks the drag, and unmounting the focused clip drops
 * keyboard focus.
 *
 * What it does NOT do: touch the DOM or React, or know about pixels beyond
 * `laneWindow`'s input. A viewport width of 0 (hidden tab, jsdom) means no
 * culling.
 */
import { endFrame, type Clip, type Track } from '../timeline';
import { frameAtContentX } from './laneLayout';

/** Per-track index: clip positions sorted by start, plus a running max of ends. */
export interface LaneIndex {
  /** Indices into `track.clips`, by `start_frame` ascending (ties keep array order). */
  order: Int32Array;
  /** Start frame per sorted entry. */
  starts: Float64Array;
  /** End frame per sorted entry (`endFrame(clip, fps)`). */
  ends: Float64Array;
  /** `maxEndPrefix[i] = max(ends[0..i])`, non-decreasing. */
  maxEndPrefix: Float64Array;
  /** Clip id → index into `track.clips` (the pinned-id lookup). */
  byId: Map<string, number>;
  fps: number;
}

/** O(n log n). Prefer `laneIndexOf`, which caches per track object. */
export function buildLaneIndex(track: Track, fps: number): LaneIndex {
  const clips: readonly Clip[] = track.clips;
  const n = clips.length;
  const order = Int32Array.from({ length: n }, (_, i) => i);
  // Typed-array sort is not guaranteed stable, so the tiebreak is explicit.
  order.sort((a, b) => clips[a].start_frame - clips[b].start_frame || a - b);
  const starts = new Float64Array(n);
  const ends = new Float64Array(n);
  const maxEndPrefix = new Float64Array(n);
  const byId = new Map<string, number>();
  let runningMax = -Infinity;
  for (let i = 0; i < n; i++) {
    const clip = clips[order[i]];
    starts[i] = clip.start_frame;
    ends[i] = endFrame(clip, fps);
    runningMax = Math.max(runningMax, ends[i]);
    maxEndPrefix[i] = runningMax;
  }
  for (let i = 0; i < n; i++) byId.set(clips[i].id, i);
  return { order, starts, ends, maxEndPrefix, byId, fps };
}

const INDEX_CACHE = new WeakMap<Track, LaneIndex>();

/** The track's index, built once per `Track` object (and rebuilt if `fps` changed). */
export function laneIndexOf(track: Track, fps: number): LaneIndex {
  const hit = INDEX_CACHE.get(track);
  if (hit && hit.fps === fps && hit.order.length === track.clips.length) return hit;
  const built = buildLaneIndex(track, fps);
  INDEX_CACHE.set(track, built);
  return built;
}

/**
 * The half-open range `[lo, hi)` of sorted entries that can intersect the frame
 * window `[from, to)`: `lo` is the first entry whose running-max end exceeds
 * `from`, `hi` the first whose start is `>= to`. Entries inside may still end at
 * or before `from` when clips overlap, so a caller that needs exactness filters
 * `ends[i] > from`.
 */
export function visibleRange(ix: LaneIndex, from: number, to: number): { lo: number; hi: number } {
  const n = ix.starts.length;
  let lo = 0;
  let h = n;
  while (lo < h) {
    const mid = (lo + h) >>> 1;
    if (ix.maxEndPrefix[mid] > from) h = mid;
    else lo = mid + 1;
  }
  let hi = lo;
  h = n;
  while (hi < h) {
    const mid = (hi + h) >>> 1;
    if (ix.starts[mid] >= to) h = mid;
    else hi = mid + 1;
  }
  return { lo, hi };
}

/** The window the lanes render, in timeline frames. */
export interface LaneFrameWindow {
  from: number;
  to: number;
}

export interface LaneWindowInput {
  scrollLeft: number;
  viewportWidth: number;
  pxPerSec: number;
  fps: number;
  startLeftPx: number;
  /** Extra px rendered beyond the viewport on each side. */
  overscanPx: number;
  /** Scroll is floored to this many px, so the window only moves in steps. */
  bucketPx: number;
}

/** Minimum overscan, px — a narrow viewport still gets a useful margin. */
export const MIN_OVERSCAN_PX = 600;

/** Overscan and bucket for a viewport: one viewport each side (min 600 px),
 *  re-render threshold half a viewport. */
export function laneWindowParams(viewportWidth: number): { overscanPx: number; bucketPx: number } {
  return {
    overscanPx: Math.max(viewportWidth, MIN_OVERSCAN_PX),
    bucketPx: Math.max(1, viewportWidth / 2),
  };
}

/** `scrollLeft` floored to the window bucket — what a caller passes down so that
 *  a scroll inside a bucket is not a prop change at all. */
export function windowScrollLeft(scrollLeft: number, viewportWidth: number): number {
  if (!(viewportWidth > 0)) return 0;
  const { bucketPx } = laneWindowParams(viewportWidth);
  return Math.floor(Math.max(0, scrollLeft) / bucketPx) * bucketPx;
}

/**
 * The frame window for a scroll position. The scroll is floored to `bucketPx`;
 * the window then spans from `overscanPx` before the bucketed left edge to
 * `overscanPx` after the right edge of the furthest viewport that bucket can
 * show, so every viewport in the bucket (plus the overscan) is inside it.
 * `null` when the viewport width is 0 (nothing measured yet): no culling.
 */
export function laneWindow(v: LaneWindowInput): LaneFrameWindow | null {
  if (!(v.viewportWidth > 0) || !(v.pxPerSec > 0)) return null;
  const left = Math.floor(Math.max(0, v.scrollLeft) / v.bucketPx) * v.bucketPx;
  const startPx = left - v.overscanPx;
  const endPx = left + v.bucketPx + v.viewportWidth + v.overscanPx;
  return {
    from: Math.floor(frameAtContentX(startPx, v.fps, v.pxPerSec, v.startLeftPx)),
    to: Math.ceil(frameAtContentX(endPx, v.fps, v.pxPerSec, v.startLeftPx)),
  };
}

/**
 * Indices into `track.clips` to render for a window, ascending (array order, so a
 * lane's stacking order and React keys do not depend on the window), plus every
 * pinned clip wherever it is. `window === null` returns every clip.
 */
export function windowClipIndices(
  track: Track,
  window: LaneFrameWindow | null,
  fps: number,
  pinnedIds?: ReadonlySet<string>,
): number[] {
  const n = track.clips.length;
  if (window === null) return Array.from({ length: n }, (_, i) => i);
  const ix = laneIndexOf(track, fps);
  const { lo, hi } = visibleRange(ix, window.from, window.to);
  const out: number[] = [];
  const seen = new Set<number>();
  for (let i = lo; i < hi; i++) {
    if (ix.ends[i] > window.from) {
      out.push(ix.order[i]);
      seen.add(ix.order[i]);
    }
  }
  if (pinnedIds && pinnedIds.size > 0) {
    for (const id of pinnedIds) {
      const at = ix.byId.get(id);
      if (at !== undefined && !seen.has(at)) {
        out.push(at);
        seen.add(at);
      }
    }
  }
  out.sort((a, b) => a - b);
  return out;
}

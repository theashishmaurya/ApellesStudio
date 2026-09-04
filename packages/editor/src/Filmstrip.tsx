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
 * **Width bucketing, deliberately coarser than `Waveform.tsx`'s**: a
 * waveform re-bucket is a cheap in-memory peak recompute; a filmstrip
 * re-bucket is a real `ffmpeg` subprocess spawn + JPEG encode per frame —
 * meaningfully more expensive (see D-119's own measured numbers). Rounding
 * the requested frame `count` to the nearest 50px-of-width bucket means a
 * 1-2px zoom/resize jitter (which `Waveform.tsx` would happily re-bucket on)
 * doesn't trigger a new backend call here — the visual difference between
 * "48 vs 49 frames tiled across this clip" is imperceptible, so there is no
 * real cost to being coarser, only savings.
 */

import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface ClipThumb {
  frame: number;
  dataUrl: string;
}

const MAX_CACHE = 200;
const thumbCache = new Map<string, Promise<ClipThumb[]>>();

/** ~1 frame per this many px of on-screen clip width — matches the reference
 *  screenshot's real tiling density (Palmier: roughly every 40-60px). */
const PX_PER_FRAME = 50;
/** Round `width` down to the nearest bucket before computing a frame count,
 *  so minor resize/zoom jitter reuses the same cache entry instead of
 *  spawning a new `ffmpeg` decode for a visually-identical result. */
const WIDTH_BUCKET_PX = 50;

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
      .catch(() => []);
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
  /** on-screen pixel width to render at — also drives how many frames are requested */
  width: number;
  height: number;
}

export function Filmstrip({ sourcePath, startSecs, durationSecs, width, height }: FilmstripProps) {
  const [thumbs, setThumbs] = useState<ClipThumb[] | null>(null);
  // Ref, not state — the *bucketed* width only needs to gate the fetch
  // effect's dependency array, it never drives a render on its own.
  const bucketedWidthRef = useRef(0);

  const bucketedWidth = Math.max(WIDTH_BUCKET_PX, Math.floor(width / WIDTH_BUCKET_PX) * WIDTH_BUCKET_PX);
  const count = Math.max(1, Math.min(64, Math.round(bucketedWidth / PX_PER_FRAME)));

  useEffect(() => {
    let cancelled = false;
    setThumbs(null);
    if (!sourcePath || durationSecs <= 0 || width <= 0) return;
    getThumbs(sourcePath, startSecs, durationSecs, count).then((t) => {
      if (!cancelled) setThumbs(t);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourcePath, startSecs, durationSecs, count]);

  if (!thumbs || thumbs.length === 0 || width <= 0 || height <= 0) return null;

  return (
    <div
      className="absolute inset-0 flex overflow-hidden"
      style={{ width, height, pointerEvents: 'none' }}
    >
      {thumbs.map((t, i) => (
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

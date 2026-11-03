/**
 * @apelles/editor — canvas-drawn amplitude waveform for a timeline clip
 * (D-051, the mature timeline UI pass).
 *
 * `react-timeline-editor` has no built-in waveform rendering, and nothing
 * else in this workspace does either (checked before writing this — see
 * D-051's decision entry), so this is the "well-trodden, small amount of
 * code" case the roadmap item called for: peaks are computed once in Rust
 * (`chroma_audio_waveform` — `symphonia` decode → mono mixdown → min/max
 * bucket reduction, `chroma::audio`) and drawn here as a min/max bar per
 * bucket on an HTML canvas sized to the clip's on-screen pixel width. A clip
 * whose source has no audio stream gets back an empty peaks array and this
 * renders nothing — no separate "has audio" check needed on the frontend,
 * the backend already knows via `VideoInfo::has_audio` (D-050).
 *
 * One `invoke` per (source path, source range, bucket count) tuple, cached
 * in a module-level `Map` so re-renders and other clips redrawing don't
 * refetch; capped and cleared wholesale past `MAX_CACHE` entries rather than
 * LRU-evicted — simplest thing that stops an unbounded leak over a long
 * editing session, not a performance-critical path.
 *
 * **D-437 S7 (plan §2.9 item 5) — drawn once per zoom bucket, then scaled.**
 * The bucket count is quantised to a power of two (`waveformBuckets`), so a
 * width change inside a bucket (a trim, a fraction of a zoom step) neither
 * re-requests peaks nor redraws: the canvas holds a bitmap at the bucket's
 * natural width and CSS scales it to the clip's width. It redraws only when the
 * bucket, the height, the variant or the peaks change; the previous peaks stay
 * on screen until new ones land, so a trim never blanks the band. A clip wider
 * than `MAX_WAVEFORM_CANVAS_PX` is the one exception: its canvas backs only the
 * visible span (`waveformSpan`, B-274) and redraws as that span moves.
 */

import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

import { isClipVisible } from './clipVisibility';
import { trackLoadRequest } from './loadPerf';
import { MAX_WAVEFORM_CANVAS_PX, waveformSpan } from './waveformWindow';

/** One amplitude bucket: `[min, max]`, both in `-1..1`. Mirrors the `(f32, f32)`
 *  pairs `chroma_audio_waveform` returns. */
export type Peak = [number, number];

const MAX_CACHE = 200;
const peakCache = new Map<string, Promise<Peak[]>>();

function cacheKey(sourcePath: string, startSecs: number, durationSecs: number, buckets: number): string {
  return `${sourcePath}|${startSecs.toFixed(3)}|${durationSecs.toFixed(3)}|${buckets}`;
}

/**
 * The peaks fetch, with its in-page cache — `export`ed since D-232 because the
 * viewer's own scrub waveform strip (`ScrubWaveform.tsx`) asks the same backend
 * the same way and must share this cache rather than open a second one. The
 * Rust side caches too (D-128), so a duplicate frontend cache would not be
 * wrong, just wasteful IPC; one path is also one place to change.
 *
 * A failed request resolves to `[]` — a source with no audio, a file that
 * vanished and a real decode error are all "nothing to draw" to every caller
 * here (the same contract `chroma_audio_waveform` itself has for a silent
 * source).
 */
export function getPeaks(
  sourcePath: string,
  startSecs: number,
  durationSecs: number,
  buckets: number,
): Promise<Peak[]> {
  const key = cacheKey(sourcePath, startSecs, durationSecs, buckets);
  let p = peakCache.get(key);
  if (!p) {
    if (peakCache.size > MAX_CACHE) peakCache.clear();
    p = trackLoadRequest(
      'peaks',
      invoke<Peak[]>('chroma_audio_waveform', {
        sourcePath,
        startSecs,
        durationSecs,
        buckets,
      }),
    ).catch(() => []);
    peakCache.set(key, p);
  }
  return p;
}

export interface WaveformProps {
  sourcePath: string;
  /** clip's `source_start` in seconds (frames / fps) */
  startSecs: number;
  /** clip's `duration` in seconds (frames / fps) */
  durationSecs: number;
  /** on-screen pixel width to render at — also how many buckets are requested */
  width: number;
  height: number;
  /** D-334 — the visible slice of this clip, in px from its own left edge, in
   *  exactly the base `Filmstrip` takes them in. Omitted means "assume
   *  visible", which is what the non-timeline caller (`ScrubWaveform`, whose
   *  strip is always fully on screen) wants and what keeps this prop from
   *  being load-bearing for anyone who does not have a viewport to report. */
  visibleStartPx?: number;
  visibleEndPx?: number;
  /** D-432 P2 — `'band'` is the timeline clip's waveform band (FCP): rectified,
   *  drawn bottom-up, nearly opaque, in the colour the PARENT sets (the clip's
   *  `--color-clip-*-wave-ink`). `'overlay'` (default) is the original centred,
   *  translucent `text-primary` trace the other callers use. */
  variant?: 'overlay' | 'band';
}

/** css px one peak bucket occupies in the cached bitmap (and, unscaled, on screen). */
export const BUCKET_PX = 2;
/** The most buckets one request asks for. */
const MAX_BUCKETS = 512;

/**
 * The bucket count for a clip `width` px wide: one per `BUCKET_PX`, rounded to the
 * nearest power of two (1..512), so every width in a zoom bucket asks for the same
 * peaks and draws the same bitmap (D-437 S7). Pure and exported for its unit test.
 */
export function waveformBuckets(width: number): number {
  if (!(width > 0)) return 1;
  const wanted = Math.min(MAX_BUCKETS, Math.max(1, width / BUCKET_PX));
  return Math.min(MAX_BUCKETS, 2 ** Math.round(Math.log2(wanted)));
}

/** How opaque each variant draws. */
const OVERLAY_ALPHA = 0.32;
const BAND_ALPHA = 0.9;

export function Waveform({
  sourcePath,
  startSecs,
  durationSecs,
  width,
  height,
  visibleStartPx,
  visibleEndPx,
  variant = 'overlay',
}: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // The peaks keep their source: a new window of the SAME source leaves the old
  // peaks (and the bitmap drawn from them) on screen until the new ones land, a
  // different source shows nothing rather than the wrong sound (D-437 S7).
  const [loaded, setLoaded] = useState<{ source: string; peaks: Peak[] } | null>(null);
  const peaks = loaded && loaded.source === sourcePath ? loaded.peaks : null;

  const buckets = waveformBuckets(width);

  // D-334/B-204 — is any of this clip actually on screen? The timeline library
  // mounts every clip on a track regardless of horizontal scroll, so without
  // this a 150-clip recut fired ~150 `chroma_audio_waveform` decodes to fill a
  // viewport showing about ten of them, and every one of those was a real
  // `symphonia` decode on a cold cache. `Filmstrip` has defended itself this
  // way since D-128; this is the same test, shared (`clipVisibility.ts`).
  //
  // Deliberately gates the FETCH only, and deliberately does not narrow WHAT
  // is fetched: the backend's envelope cache is keyed on the whole clip range,
  // so asking for a visible sub-range instead would fragment that cache and
  // turn one reusable entry per clip into one per scroll position.
  const onScreen =
    visibleStartPx === undefined || visibleEndPx === undefined
      ? width > 0
      : isClipVisible(width, visibleStartPx, visibleEndPx);

  // `width` is deliberately not a dependency: `buckets` is its quantised form.
  useEffect(() => {
    let cancelled = false;
    if (!sourcePath || durationSecs <= 0 || buckets <= 0 || !onScreen) return;
    getPeaks(sourcePath, startSecs, durationSecs, buckets).then((p) => {
      if (!cancelled) setLoaded({ source: sourcePath, peaks: p });
    });
    return () => {
      cancelled = true;
    };
  }, [sourcePath, startSecs, durationSecs, buckets, onScreen]);

  // The bitmap's natural width: the bucket's, so a width change inside the bucket
  // is a CSS scale. A clip wider than the canvas ceiling backs only its visible
  // span at its real width (B-274) and redraws as that span moves.
  const wide = width > MAX_WAVEFORM_CANVAS_PX;
  // (From the peaks that are on screen, not the requested bucket: old peaks kept while new ones load draw once.)
  const renderWidth = wide ? width : (peaks?.length ?? buckets) * BUCKET_PX;
  const span = wide ? waveformSpan(width, visibleStartPx, visibleEndPx) : width > 0 ? { start: 0, end: renderWidth } : null;
  const spanStart = span?.start ?? 0;
  const spanWidth = span ? span.end - span.start : 0;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !peaks || peaks.length === 0 || spanWidth <= 0 || height <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const pxW = Math.max(1, Math.round(spanWidth * dpr));
    const pxH = Math.max(1, Math.round(height * dpr));
    // Assigning either size clears the bitmap even when the value is unchanged.
    if (canvas.width !== pxW) canvas.width = pxW;
    if (canvas.height !== pxH) canvas.height = pxH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, spanWidth, height);

    // Theme-consistent colour without a magic literal: resolve the existing
    // `--color-text-primary` token through the canvas element's own computed
    // style (it inherits `color` from the DOM), then draw it translucent.
    ctx.fillStyle = getComputedStyle(canvas).color || '#fff';
    ctx.globalAlpha = variant === 'band' ? BAND_ALPHA : OVERLAY_ALPHA;

    const mid = height / 2;
    const barW = renderWidth / peaks.length;
    // Only the buckets that fall inside the canvas's span are drawn.
    const first = Math.max(0, Math.floor(spanStart / barW));
    const last = Math.min(peaks.length - 1, Math.ceil((spanStart + spanWidth) / barW));
    for (let i = first; i <= last; i++) {
      const [lo, hi] = peaks[i];
      const x = i * barW - spanStart;
      const w = Math.max(barW - 0.5, 0.5);
      if (variant === 'band') {
        // Rectified, bottom-up (FCP): the larger excursion of the bucket.
        const h = Math.max(Math.max(Math.abs(lo), Math.abs(hi)) * height, 1);
        ctx.fillRect(x, height - h, w, h);
        continue;
      }
      const y1 = mid - hi * mid;
      const y2 = mid - lo * mid;
      const h = Math.max(Math.abs(y2 - y1), 1);
      ctx.fillRect(x, Math.min(y1, y2), w, h);
    }
  }, [peaks, renderWidth, height, spanStart, spanWidth, variant]);

  if (!peaks || peaks.length === 0 || spanWidth <= 0 || width <= 0) return null;

  return (
    <canvas
      ref={canvasRef}
      // `band` inherits its ink from the clip block that holds it.
      className={variant === 'band' ? undefined : 'text-text-primary'}
      style={{
        // Whole-clip bitmap: scaled to the clip's width. Wide clip: the span, 1:1.
        width: wide ? spanWidth : width,
        height,
        position: 'absolute',
        top: 0,
        left: spanStart,
        pointerEvents: 'none',
      }}
    />
  );
}

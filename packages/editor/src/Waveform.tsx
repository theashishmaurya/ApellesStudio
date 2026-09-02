/**
 * @chroma/editor — canvas-drawn amplitude waveform for a timeline clip
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
 */

import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

type Peak = [number, number];

const MAX_CACHE = 200;
const peakCache = new Map<string, Promise<Peak[]>>();

function cacheKey(sourcePath: string, startSecs: number, durationSecs: number, buckets: number): string {
  return `${sourcePath}|${startSecs.toFixed(3)}|${durationSecs.toFixed(3)}|${buckets}`;
}

function getPeaks(sourcePath: string, startSecs: number, durationSecs: number, buckets: number): Promise<Peak[]> {
  const key = cacheKey(sourcePath, startSecs, durationSecs, buckets);
  let p = peakCache.get(key);
  if (!p) {
    if (peakCache.size > MAX_CACHE) peakCache.clear();
    p = invoke<Peak[]>('chroma_audio_waveform', {
      sourcePath,
      startSecs,
      durationSecs,
      buckets,
    }).catch(() => []);
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
}

export function Waveform({ sourcePath, startSecs, durationSecs, width, height }: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [peaks, setPeaks] = useState<Peak[] | null>(null);

  // one bucket per ~2px of width is plenty of visual resolution and keeps
  // the request small even for a long, zoomed-out clip.
  const buckets = Math.max(1, Math.min(600, Math.round(width / 2)));

  useEffect(() => {
    let cancelled = false;
    setPeaks(null);
    if (!sourcePath || durationSecs <= 0 || width <= 0) return;
    getPeaks(sourcePath, startSecs, durationSecs, buckets).then((p) => {
      if (!cancelled) setPeaks(p);
    });
    return () => {
      cancelled = true;
    };
  }, [sourcePath, startSecs, durationSecs, buckets, width]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !peaks || peaks.length === 0 || width <= 0 || height <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    // Theme-consistent colour without a magic literal: resolve the existing
    // `--color-text-primary` token through the canvas element's own computed
    // style (it inherits `color` from the DOM), then draw it translucent.
    ctx.fillStyle = getComputedStyle(canvas).color || '#fff';
    ctx.globalAlpha = 0.32;

    const mid = height / 2;
    const barW = width / peaks.length;
    peaks.forEach(([lo, hi], i) => {
      const x = i * barW;
      const y1 = mid - hi * mid;
      const y2 = mid - lo * mid;
      const h = Math.max(Math.abs(y2 - y1), 1);
      ctx.fillRect(x, Math.min(y1, y2), Math.max(barW - 0.5, 0.5), h);
    });
  }, [peaks, width, height]);

  if (!peaks || peaks.length === 0) return null;

  return (
    <canvas
      ref={canvasRef}
      className="text-text-primary"
      style={{ width, height, position: 'absolute', inset: 0, pointerEvents: 'none' }}
    />
  );
}

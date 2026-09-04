/**
 * @chroma/editor — `Filmstrip.tsx`'s two pure halves (D-124).
 *
 * These pin the one property the whole zoom fix rests on: what gets FETCHED
 * depends only on the clip, and what gets DRAWN depends only on the width. Get
 * those two mixed up again and the refetch-per-zoom-step storm comes straight
 * back, which is exactly what happened between D-119 and here.
 *
 * Both clips used below are the owner's own, verbatim from the real project at
 * `~/Movies/Chroma/New.chroma/project.json` (24fps timeline: 166 frames =
 * 6.9167s, 12414 frames = 517.25s).
 */

import { describe, it, expect } from 'vitest';

import { fetchFrameCount, sampleThumbs } from './Filmstrip';
import { MIN_PX_PER_SEC, MAX_PX_PER_SEC, DEFAULT_PX_PER_SEC } from './ruler';

const SR_SECS = 166 / 24; // "Screen Recording 2026-08-10 at 9.21.13 PM.mov"
const A001_SECS = 12414 / 24; // "A001_08302215_C019.MOV"
const PX_PER_FRAME = 50; // mirrors Filmstrip.tsx's render density

/** Every zoom the UI can actually reach, on its real 1.2x wheel step. */
function everyRealZoom(): number[] {
  const zooms: number[] = [];
  for (let z = MIN_PX_PER_SEC; z <= MAX_PX_PER_SEC; z *= 1.2) zooms.push(z);
  zooms.push(MAX_PX_PER_SEC);
  return zooms;
}

describe('fetchFrameCount', () => {
  it('is completely independent of zoom — the property the whole fix rests on', () => {
    // The real regression: D-119 derived the count from on-screen width, so a
    // zoom sweep produced 64 -> 41 -> 20 -> 10, four distinct cache keys and
    // therefore four separate ffmpeg decodes of the same source range.
    for (const secs of [SR_SECS, A001_SECS, 0.5, 42, 3600]) {
      const counts = new Set(everyRealZoom().map(() => fetchFrameCount(secs)));
      expect(counts.size).toBe(1);
    }
  });

  it('gives a short clip a real frame per tile even at maximum zoom', () => {
    // A 6.92s clip drawn at MAX_PX_PER_SEC is ~3320px wide, i.e. ~66 tiles of
    // 50px. Capped at 64, that is still one distinct frame per tile — no
    // smearing a handful of frames across the clip.
    const tilesAtMaxZoom = Math.round((SR_SECS * MAX_PX_PER_SEC) / PX_PER_FRAME);
    expect(fetchFrameCount(SR_SECS)).toBeGreaterThanOrEqual(Math.min(64, tilesAtMaxZoom) - 2);
  });

  it('stays within the backend clamp for any clip length', () => {
    for (const secs of [0, -1, 0.001, 1, 60, 517.25, 36000]) {
      const n = fetchFrameCount(secs);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(64); // chroma_clip_thumbnails' own count.clamp(1, 64)
      expect(Number.isInteger(n)).toBe(true);
    }
  });

  it('never returns NaN for a degenerate duration', () => {
    for (const bad of [0, -5, NaN, Infinity]) {
      expect(Number.isFinite(fetchFrameCount(bad))).toBe(true);
    }
  });
});

describe('sampleThumbs', () => {
  const sixtyFour = Array.from({ length: 64 }, (_, i) => i);

  it('returns exactly the requested tile count when it has enough frames', () => {
    for (const n of [1, 2, 10, 20, 41, 63, 64]) {
      expect(sampleThumbs(sixtyFour, n)).toHaveLength(n);
    }
  });

  it('spans the whole clip — first and last frame always survive', () => {
    for (const n of [2, 10, 41, 63]) {
      const got = sampleThumbs(sixtyFour, n);
      expect(got[0]).toBe(0);
      expect(got[got.length - 1]).toBe(63);
    }
  });

  it('samples monotonically, never repeating or reordering', () => {
    const got = sampleThumbs(sixtyFour, 20);
    for (let i = 1; i < got.length; i++) expect(got[i]).toBeGreaterThan(got[i - 1]);
  });

  it('degrades to what it has rather than inventing frames', () => {
    expect(sampleThumbs([1, 2, 3], 50)).toEqual([1, 2, 3]);
    expect(sampleThumbs([], 5)).toEqual([]);
  });

  it('never divides by zero at one tile, or below it', () => {
    expect(sampleThumbs([9, 8, 7], 1)).toEqual([9]);
    expect(sampleThumbs([9, 8, 7], 0)).toEqual([9]);
    expect(sampleThumbs([9, 8, 7], -3)).toEqual([9]);
  });
});

describe('the two together, over the real zoom range', () => {
  it('holds tiles near the target density wherever there are frames to do it', () => {
    // The owner works on a 517s clip zoomed out (it is 46,553px wide at the
    // default 90px/s). Across that real range the tiles must stay ~50px, which
    // is what stops them stretching as zoom changes.
    const fetched = fetchFrameCount(A001_SECS);
    for (const z of [MIN_PX_PER_SEC, 2, 4, 6]) {
      const width = A001_SECS * z;
      const tiles = Math.max(1, Math.min(fetched, Math.round(width / PX_PER_FRAME)));
      expect(width / tiles).toBeGreaterThan(PX_PER_FRAME * 0.8);
      expect(width / tiles).toBeLessThan(PX_PER_FRAME * 1.25);
    }
  });

  it('a short clip holds the density across the entire zoom range', () => {
    const fetched = fetchFrameCount(SR_SECS);
    for (const z of everyRealZoom()) {
      const width = SR_SECS * z;
      const want = Math.round(width / PX_PER_FRAME);
      // Below two tiles the clip is barely wider than a single thumbnail
      // (a 6.9s clip is 69px across at 10px/s) — one tile filling it is the
      // right answer there, not a stretch, so there is no density to hold.
      if (want < 2) continue;
      const tiles = Math.max(1, Math.min(fetched, want));
      expect(width / tiles).toBeLessThan(PX_PER_FRAME * 1.4);
    }
  });

  it('the default zoom draws a sane strip for both of the owner’s clips', () => {
    for (const secs of [SR_SECS, A001_SECS]) {
      const width = secs * DEFAULT_PX_PER_SEC;
      const tiles = sampleThumbs(
        Array.from({ length: fetchFrameCount(secs) }, (_, i) => i),
        Math.round(width / PX_PER_FRAME),
      );
      expect(tiles.length).toBeGreaterThan(0);
      expect(tiles.length).toBeLessThanOrEqual(64);
    }
  });
});

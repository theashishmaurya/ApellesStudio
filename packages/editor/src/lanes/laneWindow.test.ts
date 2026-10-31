/**
 * D-437 S1 — `laneWindow.ts` / `laneLayout.ts`: culling and geometry, against a
 * brute-force filter, with overlaps, empty tracks, zoom extremes, pinned ids and
 * a 300-clip timing guard.
 */
import { describe, expect, it } from 'vitest';
import type { Clip, Track } from '../timeline';
import { endFrame } from '../timeline';
import { niceTickIntervalSeconds } from '../ruler';
import {
  clipLeftPx,
  clipWidthPx,
  contentWidth,
  frameAtContentX,
  visibleSlice,
} from './laneLayout';
import {
  buildLaneIndex,
  laneIndexOf,
  laneWindow,
  laneWindowParams,
  visibleRange,
  windowClipIndices,
  windowScrollLeft,
} from './laneWindow';

const FPS = 24;
const START_LEFT = 32;

function clip(id: string, start: number, duration: number): Clip {
  return {
    id,
    name: id,
    source_path: '/x.mov',
    source_start: 0,
    duration,
    source_len: 100000,
    start_frame: start,
  } as Clip;
}
function track(clips: Clip[]): Track {
  return { kind: 'video', clips } as Track;
}
function ids(t: Track, idx: number[]): string[] {
  return idx.map((i) => t.clips[i].id);
}
/** The reference: every clip whose span intersects [from, to). */
function brute(t: Track, from: number, to: number): number[] {
  const out: number[] = [];
  t.clips.forEach((c, i) => {
    if (endFrame(c, FPS) > from && c.start_frame < to) out.push(i);
  });
  return out;
}

describe('buildLaneIndex / visibleRange', () => {
  it('handles an empty track', () => {
    const ix = buildLaneIndex(track([]), FPS);
    expect(visibleRange(ix, 0, 100)).toEqual({ lo: 0, hi: 0 });
    expect(windowClipIndices(track([]), { from: 0, to: 100 }, FPS)).toEqual([]);
  });

  it('handles one clip: before, inside, straddling each edge, after', () => {
    const t = track([clip('a', 100, 50)]); // [100,150)
    const w = (from: number, to: number) => ids(t, windowClipIndices(t, { from, to }, FPS));
    expect(w(0, 100)).toEqual([]); // ends exactly where the clip starts: half-open
    expect(w(0, 101)).toEqual(['a']); // straddles the left edge
    expect(w(110, 120)).toEqual(['a']); // inside
    expect(w(149, 300)).toEqual(['a']); // straddles the right edge
    expect(w(150, 300)).toEqual([]);
  });

  it('sorts unsorted clips arrays and returns indices in array order', () => {
    const t = track([clip('c', 200, 10), clip('a', 0, 10), clip('b', 100, 10)]);
    const ix = buildLaneIndex(t, FPS);
    expect(Array.from(ix.order)).toEqual([1, 2, 0]);
    expect(ids(t, windowClipIndices(t, { from: 0, to: 1000 }, FPS))).toEqual(['c', 'a', 'b']);
    expect(ids(t, windowClipIndices(t, { from: 95, to: 205 }, FPS))).toEqual(['c', 'b']);
  });

  it('finds a long clip that starts before the window and overlaps shorter ones', () => {
    // 'long' [0,1000) hides under many short clips; the running max of ends keeps it.
    const t = track([clip('long', 0, 1000), clip('s1', 10, 5), clip('s2', 20, 5), clip('s3', 30, 5)]);
    expect(ids(t, windowClipIndices(t, { from: 500, to: 600 }, FPS))).toEqual(['long']);
    expect(ids(t, windowClipIndices(t, { from: 12, to: 22 }, FPS))).toEqual(['long', 's1', 's2']);
  });

  it('filters entries inside the range that end before the window (overlap)', () => {
    const t = track([clip('long', 0, 1000), clip('short', 10, 5)]);
    // 'short' is inside [lo, hi) only because 'long' lifted the running max; it ends at 15.
    expect(ids(t, windowClipIndices(t, { from: 100, to: 200 }, FPS))).toEqual(['long']);
  });

  it('breaks start ties by array order', () => {
    const t = track([clip('x', 10, 5), clip('y', 10, 5), clip('z', 10, 5)]);
    expect(Array.from(buildLaneIndex(t, FPS).order)).toEqual([0, 1, 2]);
  });

  it('caches per Track object and rebuilds when fps or length changes', () => {
    const t = track([clip('a', 0, 10)]);
    const first = laneIndexOf(t, FPS);
    expect(laneIndexOf(t, FPS)).toBe(first);
    expect(laneIndexOf(t, 30)).not.toBe(first);
    const other = track([clip('a', 0, 10)]);
    expect(laneIndexOf(other, FPS)).not.toBe(first);
  });

  it('matches a brute-force filter on a 10k-clip random track (with overlaps)', () => {
    let seed = 1234567;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const clips: Clip[] = [];
    for (let i = 0; i < 10_000; i++) {
      clips.push(clip(`c${i}`, Math.floor(rnd() * 400_000), 1 + Math.floor(rnd() * (i % 50 === 0 ? 5000 : 200))));
    }
    const t = track(clips);
    for (let k = 0; k < 200; k++) {
      const from = Math.floor(rnd() * 400_000) - 1000;
      const to = from + 1 + Math.floor(rnd() * 20_000);
      expect(windowClipIndices(t, { from, to }, FPS)).toEqual(brute(t, from, to));
    }
  });
});

describe('pinned ids', () => {
  const t = track([clip('a', 0, 10), clip('b', 5000, 10), clip('c', 90_000, 10)]);
  it('are returned wherever they are, once, in array order', () => {
    const got = windowClipIndices(t, { from: 4990, to: 5010 }, FPS, new Set(['c', 'a', 'b']));
    expect(ids(t, got)).toEqual(['a', 'b', 'c']);
  });
  it('are ignored when the id is not on this track', () => {
    expect(ids(t, windowClipIndices(t, { from: 0, to: 20 }, FPS, new Set(['nope'])))).toEqual(['a']);
  });
  it('do not duplicate a clip that is already in the window', () => {
    expect(windowClipIndices(t, { from: 0, to: 20 }, FPS, new Set(['a']))).toEqual([0]);
  });
  it('are not needed when there is no culling', () => {
    expect(windowClipIndices(t, null, FPS, new Set(['c']))).toEqual([0, 1, 2]);
  });
});

describe('laneWindow', () => {
  const base = { fps: FPS, startLeftPx: START_LEFT, pxPerSec: 100 };
  const vw = 1000;
  const params = laneWindowParams(vw);

  it('returns null (no culling) for an unmeasured viewport', () => {
    expect(laneWindow({ ...base, scrollLeft: 0, viewportWidth: 0, overscanPx: 600, bucketPx: 1 })).toBeNull();
  });

  it('puts the overscan at one viewport each side (min 600 px)', () => {
    expect(params).toEqual({ overscanPx: 1000, bucketPx: 500 });
    expect(laneWindowParams(200).overscanPx).toBe(600);
    expect(laneWindowParams(0).bucketPx).toBe(1);
  });

  it('always contains the visible area plus the overscan, wherever in the bucket we are', () => {
    for (const scrollLeft of [0, 1, 499, 500, 777, 12_345]) {
      const w = laneWindow({ ...base, ...params, scrollLeft, viewportWidth: vw })!;
      const wantFrom = frameAtContentX(scrollLeft - params.overscanPx, FPS, 100, START_LEFT);
      const wantTo = frameAtContentX(scrollLeft + vw + params.overscanPx, FPS, 100, START_LEFT);
      expect(w.from).toBeLessThanOrEqual(wantFrom);
      expect(w.to).toBeGreaterThanOrEqual(wantTo);
    }
  });

  it('does not move while the scroll stays inside one bucket, and moves when it leaves', () => {
    const at = (s: number) => laneWindow({ ...base, ...params, scrollLeft: s, viewportWidth: vw });
    expect(at(500)).toEqual(at(999));
    expect(at(500)).not.toEqual(at(1000));
    expect(at(0)).toEqual(at(499));
  });

  it('windowScrollLeft floors to the bucket and is idempotent', () => {
    expect(windowScrollLeft(777, vw)).toBe(500);
    expect(windowScrollLeft(windowScrollLeft(777, vw), vw)).toBe(500);
    expect(windowScrollLeft(-40, vw)).toBe(0);
    expect(windowScrollLeft(777, 0)).toBe(0);
  });

  it('works at the zoom extremes', () => {
    for (const pxPerSec of [1, 5, 2000, 20_000]) {
      const p = laneWindowParams(800);
      const w = laneWindow({ ...base, ...p, pxPerSec, scrollLeft: 4000, viewportWidth: 800 })!;
      expect(Number.isFinite(w.from) && Number.isFinite(w.to)).toBe(true);
      expect(w.to).toBeGreaterThan(w.from);
      // the viewport's frame range is inside it
      expect(w.from).toBeLessThanOrEqual(frameAtContentX(4000, FPS, pxPerSec, START_LEFT));
      expect(w.to).toBeGreaterThanOrEqual(frameAtContentX(4800, FPS, pxPerSec, START_LEFT));
    }
  });

  it('selects exactly the clips in view plus overscan on a real track', () => {
    // 100 clips of 1 s back to back: [0,24) [24,48) ... ; 100 px/s.
    const t = track(Array.from({ length: 100 }, (_, i) => clip(`c${i}`, i * 24, 24)));
    const w = laneWindow({ ...base, ...params, scrollLeft: 5000, viewportWidth: vw })!;
    const got = windowClipIndices(t, w, FPS);
    expect(got).toEqual(brute(t, w.from, w.to));
    expect(got.length).toBeLessThan(100);
    // the visible 1000 px (10 s) are all there
    for (let s = 50; s < 60; s++) expect(got).toContain(s);
  });
});

describe('laneLayout', () => {
  it('contentWidth matches the library formula for six cases', () => {
    const lib = (maxEnd: number, tick: number, pps: number) =>
      START_LEFT + Math.max(20, Math.ceil(maxEnd / tick) + 5) * tick * pps;
    const cases: Array<[number, number]> = [
      [0, 90], // no clips
      [3, 90], // under 20 ticks
      [3600, 90], // long timeline
      [120, 1], // zoom minimum-ish
      [120, 8000], // zoom maximum-ish
      [47.9583, 36], // fractional end
    ];
    for (const [endSec, pps] of cases) {
      const tick = niceTickIntervalSeconds(pps);
      expect(contentWidth(endSec, tick, pps, START_LEFT)).toBe(lib(endSec, tick, pps));
    }
  });

  it('clip box and frame inverse agree', () => {
    const c = clip('a', 48, 96);
    expect(clipLeftPx(48, FPS, 90, START_LEFT)).toBe(START_LEFT + 2 * 90);
    expect(clipWidthPx(c, FPS, 90)).toBe(4 * 90);
    expect(frameAtContentX(clipLeftPx(48, FPS, 90, START_LEFT), FPS, 90, START_LEFT)).toBe(48);
  });

  describe('visibleSlice', () => {
    it('gives a fully visible clip {0, width} regardless of the viewport position', () => {
      expect(visibleSlice(1000, 300, 900, 1500, 200)).toEqual({ start: 0, end: 300 });
      expect(visibleSlice(1000, 300, 950, 1400, 200)).toEqual({ start: 0, end: 300 });
    });
    it('clamps and buckets a clip straddling an edge', () => {
      expect(visibleSlice(0, 1000, 450, 1200, 200)).toEqual({ start: 400, end: 1000 });
      expect(visibleSlice(800, 1000, 0, 1000, 200)).toEqual({ start: 0, end: 200 });
    });
    it('parks an off-screen clip at the nearest edge (stable while scrolling)', () => {
      expect(visibleSlice(5000, 300, 0, 1000, 200)).toEqual({ start: 0, end: 0 });
      expect(visibleSlice(0, 300, 5000, 6000, 200)).toEqual({ start: 300, end: 300 });
      expect(visibleSlice(5000, 300, 100, 1100, 200)).toEqual(visibleSlice(5000, 300, 0, 900, 200));
    });
    it('treats a bucket of 0 as 1 px', () => {
      expect(visibleSlice(0, 100, 10.4, 20.2, 0)).toEqual({ start: 10, end: 21 });
    });
  });
});

describe('performance at 300+ clips', () => {
  it('windowing a cached 300-clip track is sub-millisecond', () => {
    const t = track(Array.from({ length: 400 }, (_, i) => clip(`c${i}`, i * 30, 24 + (i % 7))));
    laneIndexOf(t, FPS); // build once (the cache hit is the steady state)
    const w = { from: 5000, to: 6200 };
    for (let i = 0; i < 200; i++) windowClipIndices(t, w, FPS); // warm the JIT
    const runs = 2000;
    const t0 = performance.now();
    for (let i = 0; i < runs; i++) windowClipIndices(t, w, FPS);
    const perCall = (performance.now() - t0) / runs;
    expect(perCall).toBeLessThan(1);
  });
});

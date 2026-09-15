/**
 * previewTiming.test.ts (D-219) — the preview frame-timing readout's maths.
 *
 * Every timestamp is injected, so these are exact rather than flaky: the
 * whole point of the readout is that a number it reports can be trusted as
 * evidence about playback smoothness, which it cannot be if the statistics
 * themselves are approximate.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_REPORT_LIMIT,
  DEFAULT_TIMING_WINDOW_MS,
  TIMING_CAPACITY,
  previewLiveFps,
  previewTimingReport,
  recordPreviewSpan,
  recordPreviewTiming,
  resetPreviewTiming,
} from './previewTiming';

beforeEach(() => {
  resetPreviewTiming();
});

/** Record `count` events spaced `stepMs` apart on `channel`. */
function record(channel: 'raf' | 'paint', count: number, stepMs: number, from = 0): void {
  for (let i = 0; i < count; i += 1) recordPreviewTiming(channel, from + i * stepMs);
}

describe('previewTimingReport', () => {
  it('reports nothing measurable before there are two samples', () => {
    const empty = previewTimingReport();
    expect(empty.paint.samples).toBe(0);
    expect(empty.paint.fps).toBeNull();
    expect(empty.paint.medianMs).toBeNull();

    recordPreviewTiming('paint', 100);
    expect(previewTimingReport().paint.fps).toBeNull();
  });

  it('turns evenly spaced paints into the right interval and fps', () => {
    record('paint', 11, 16.666);
    const { paint } = previewTimingReport();

    expect(paint.samples).toBe(11);
    expect(paint.intervalsMs).toHaveLength(10);
    expect(paint.medianMs).toBeCloseTo(16.67, 1);
    expect(paint.fps).toBeCloseTo(60, 0);
    expect(paint.hitches).toBe(0);
  });

  it('keeps the two channels independent — a throttled window is visible as one, not both', () => {
    record('paint', 5, 20);
    record('raf', 3, 500);
    const report = previewTimingReport();

    expect(report.paint.fps).toBeCloseTo(50, 0);
    expect(report.raf.fps).toBeCloseTo(2, 0);
    expect(report.paint.samples).toBe(5);
    expect(report.raf.samples).toBe(3);
  });

  it('counts an interval over twice the median as a hitch', () => {
    for (const at of [0, 16, 32, 48, 300, 316]) recordPreviewTiming('paint', at);
    const { paint } = previewTimingReport();

    expect(paint.medianMs).toBe(16);
    expect(paint.maxMs).toBe(252);
    expect(paint.hitches).toBe(1);
  });

  it('reports min/median/p95/max over the whole buffer, not just the returned tail', () => {
    record('paint', 100, 10); // 0, 10, … 990
    recordPreviewTiming('paint', 990 + 400); // one long stall at the end
    const { paint } = previewTimingReport(5);

    expect(paint.intervalsMs).toHaveLength(5);
    expect(paint.minMs).toBe(10);
    expect(paint.maxMs).toBe(400);
    expect(paint.samples).toBe(101);
  });

  it('drops the oldest samples past the ring buffer capacity', () => {
    record('paint', TIMING_CAPACITY + 50, 10);
    const { paint } = previewTimingReport();

    expect(paint.samples).toBe(TIMING_CAPACITY);
  });

  it('defaults the returned interval list to DEFAULT_REPORT_LIMIT and clamps a silly one', () => {
    record('paint', TIMING_CAPACITY, 10);
    expect(previewTimingReport().paint.intervalsMs).toHaveLength(DEFAULT_REPORT_LIMIT);
    expect(previewTimingReport(10_000).paint.intervalsMs).toHaveLength(TIMING_CAPACITY - 1);
    expect(previewTimingReport(0).paint.intervalsMs).toHaveLength(1);
  });

  it('resets every channel', () => {
    record('paint', 5, 10);
    record('raf', 5, 10);
    recordPreviewSpan('fetch', 3);
    recordPreviewSpan('tick', 9);
    resetPreviewTiming();
    const report = previewTimingReport();

    expect(report.paint.samples).toBe(0);
    expect(report.raf.samples).toBe(0);
    expect(report.fetch.samples).toBe(0);
    expect(report.tick.samples).toBe(0);
  });
});

/**
 * The D-290 duration channels. These exist to answer one question the two
 * timestamp channels above structurally cannot — "the loop is running at
 * 40 fps, but where did the 25 ms GO?" — and the answer is got by subtracting
 * one median from another, so the medians have to be right for the conclusion
 * drawn from them to be worth anything.
 */
describe('previewTimingReport — the duration channels', () => {
  it('reports the spread of a duration channel, and no cadence', () => {
    for (const ms of [4, 6, 5, 5, 20, 5, 5, 5, 5, 5]) recordPreviewSpan('fetch', ms);
    const { fetch } = previewTimingReport();

    expect(fetch.samples).toBe(10);
    expect(fetch.minMs).toBe(4);
    expect(fetch.medianMs).toBe(5);
    expect(fetch.maxMs).toBe(20);
    expect(fetch.meanMs).toBeCloseTo(6.5, 5);
    // A cost has no frame rate and no hitch count — those belong to a cadence.
    expect(fetch).not.toHaveProperty('fps');
    expect(fetch).not.toHaveProperty('hitches');
  });

  it('keeps fetch and tick independent, so their difference means something', () => {
    for (let i = 0; i < 10; i += 1) recordPreviewSpan('fetch', 4);
    for (let i = 0; i < 10; i += 1) recordPreviewSpan('tick', 7);
    const report = previewTimingReport();

    // The subtraction the module doc prescribes: `tick − fetch` is the loop's
    // own JavaScript, here 3 ms.
    expect(report.tick.medianMs! - report.fetch.medianMs!).toBeCloseTo(3, 5);
    expect(report.fetch.samples).toBe(10);
    expect(report.tick.samples).toBe(10);
  });

  it('reports nothing rather than a guess before anything has been measured', () => {
    const { fetch, tick } = previewTimingReport();
    expect(fetch.samples).toBe(0);
    expect(fetch.medianMs).toBeNull();
    expect(fetch.meanMs).toBeNull();
    expect(tick.msLatest).toEqual([]);
  });

  it('refuses a negative or non-finite span rather than poisoning the median', () => {
    recordPreviewSpan('tick', 10);
    recordPreviewSpan('tick', -1);
    recordPreviewSpan('tick', Number.NaN);
    recordPreviewSpan('tick', Number.POSITIVE_INFINITY);
    const { tick } = previewTimingReport();

    // A span is always `now - start`, so anything else is a caller bug. The
    // readout's whole value is that a number it reports can be trusted as
    // evidence, which it cannot be if a bug silently skews the statistics.
    expect(tick.samples).toBe(1);
    expect(tick.medianMs).toBe(10);
  });

  it('drops the oldest durations past the ring buffer capacity', () => {
    for (let i = 0; i < TIMING_CAPACITY + 50; i += 1) recordPreviewSpan('fetch', 5);
    expect(previewTimingReport().fetch.samples).toBe(TIMING_CAPACITY);
  });

  it('trims the returned duration list to the limit but derives stats over the whole buffer', () => {
    for (let i = 0; i < 100; i += 1) recordPreviewSpan('tick', 5);
    recordPreviewSpan('tick', 400);
    const { tick } = previewTimingReport(5);

    expect(tick.msLatest).toHaveLength(5);
    expect(tick.maxMs).toBe(400);
    expect(tick.samples).toBe(101);
  });
});

/**
 * D-330 — the time window. These exist because a windowed number is the one
 * the on-screen overlay burns into a recording, so "what span does this fps
 * actually cover" has to be exact rather than roughly right.
 */
describe('previewTimingReport — the D-330 time window', () => {
  it('defaults to the whole ring buffer, exactly as it did before D-330', () => {
    record('paint', 5, 100);
    const report = previewTimingReport();
    expect(report.windowMs).toBeNull();
    expect(report.paint.samples).toBe(5);
    expect(report.paint.fps).toBe(10);
  });

  it('derives only from samples inside the window', () => {
    // Ten slow frames (100ms) then ten fast ones (20ms). Whole-buffer fps
    // averages the two; a 200ms window must see only the fast ones.
    record('paint', 10, 100, 0);
    record('paint', 10, 20, 1000);

    expect(previewTimingReport(60).paint.fps).toBeLessThan(25);

    const windowed = previewTimingReport(60, 200);
    expect(windowed.windowMs).toBe(200);
    expect(windowed.paint.fps).toBe(50);
  });

  it('anchors the window on the NEWEST sample, not on wall-clock now', () => {
    // The normal way this readout is used is play, stop, then read — by
    // which time every sample is "old" relative to `performance.now()`.
    // Anchoring on now would report an empty window for every such call.
    record('paint', 6, 50, 0);
    const report = previewTimingReport(60, 200);
    expect(report.paint.samples).toBeGreaterThan(1);
    expect(report.paint.fps).toBe(20);
  });

  it('windows the COST channels over the same real span as the cadence ones', () => {
    // Cheap fetches long ago, expensive ones just now. A window that only
    // narrowed the cadence channels would report current fps beside stale
    // costs — two halves of one report silently covering different spans.
    for (let i = 0; i < 10; i += 1) recordPreviewSpan('fetch', 2, i * 10);
    for (let i = 0; i < 10; i += 1) recordPreviewSpan('fetch', 40, 1000 + i * 10);

    // Nearest-rank median over all twenty samples lands on the cheap half;
    // the windowed one sees only the expensive ten.
    expect(previewTimingReport(60).fetch.medianMs).toBe(2);
    expect(previewTimingReport(60).fetch.samples).toBe(20);
    expect(previewTimingReport(60, 100).fetch.medianMs).toBe(40);
    expect(previewTimingReport(60, 100).fetch.samples).toBe(10);
  });

  it('treats a zero, negative or non-finite window as no window at all', () => {
    record('paint', 4, 100);
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const report = previewTimingReport(60, bad);
      expect(report.windowMs).toBeNull();
      expect(report.paint.samples).toBe(4);
    }
  });
});

describe('previewLiveFps', () => {
  it('reports the same fps the windowed report does, over the window it names', () => {
    // Both channels end at the same instant, so one `now` anchor is current
    // for both and the live readout and the tool are directly comparable.
    record('paint', 10, 100, 0);
    record('paint', 11, 20, 1000); // last paint at t = 1200
    record('raf', 21, 20, 1000); // last raf   at t = 1200

    const live = previewLiveFps(200, 1200);
    expect(live.windowMs).toBe(200);
    // The load-bearing property of the whole feature: the number the overlay
    // burns into a recording IS the number the tool answers, not a parallel
    // measurement that could drift from it.
    expect(live.paintFps).toBe(previewTimingReport(1, 200).paint.fps);
    expect(live.rafFps).toBe(previewTimingReport(1, 200).raf.fps);
    expect(live.paintFps).toBe(50);
  });

  it('reports null rather than zero when nothing has painted', () => {
    // A recording must show "nothing is being drawn" distinctly from
    // "drawing at 0 fps" — only one of those is a bug.
    const live = previewLiveFps();
    expect(live.paintFps).toBeNull();
    expect(live.paintSamples).toBe(0);
  });

  it('falls back to the default window for a nonsense one', () => {
    expect(previewLiveFps(0).windowMs).toBe(DEFAULT_TIMING_WINDOW_MS);
    expect(previewLiveFps(Number.NaN).windowMs).toBe(DEFAULT_TIMING_WINDOW_MS);
  });

  it('goes BLANK once nothing has painted for a whole window', () => {
    // The wart this fixes was caught in D-330's own live verification: a
    // newest-anchored readout freezes on its last value, so a recording kept
    // displaying "17.1 fps" over an app that had stopped painting entirely.
    // An overlay in footage has to describe the present or it is not
    // evidence.
    record('paint', 10, 50, 1000); // last sample at t=1450

    expect(previewLiveFps(2000, 1500).paintFps).toBe(20);
    expect(previewLiveFps(2000, 3000).paintFps).toBe(20); // still in window
    expect(previewLiveFps(2000, 9000).paintFps).toBeNull(); // long stale
    expect(previewLiveFps(2000, 9000).paintSamples).toBe(0);
  });

  it('agrees with the tool exactly while frames are flowing', () => {
    // The two anchors differ ONLY in staleness. While samples are arriving,
    // `now` and `newest` select the same ones and the numbers must be equal —
    // this is the property the whole overlay rests on.
    record('paint', 20, 40, 0); // last sample at t=760
    const live = previewLiveFps(2000, 760);
    expect(live.paintFps).toBe(previewTimingReport(1, 2000).paint.fps);
    expect(live.hitches).toBe(previewTimingReport(1, 2000).paint.hitches);
  });
});

/**
 * previewTiming.test.ts (D-218) — the preview frame-timing readout's maths.
 *
 * Every timestamp is injected, so these are exact rather than flaky: the
 * whole point of the readout is that a number it reports can be trusted as
 * evidence about playback smoothness, which it cannot be if the statistics
 * themselves are approximate.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_REPORT_LIMIT,
  TIMING_CAPACITY,
  previewTimingReport,
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

  it('resets both channels', () => {
    record('paint', 5, 10);
    record('raf', 5, 10);
    resetPreviewTiming();
    const report = previewTimingReport();

    expect(report.paint.samples).toBe(0);
    expect(report.raf.samples).toBe(0);
  });
});

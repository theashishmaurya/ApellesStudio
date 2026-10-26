// B-274 — the waveform canvas is bounded by the viewport, not by the clip.
import { describe, expect, it } from 'vitest';
import { MAX_WAVEFORM_CANVAS_PX, waveformSpan } from './waveformWindow';

describe('waveformSpan (B-274)', () => {
  it('backs an 803 s clip at 500 px/s with a viewport-sized canvas, not 400,000 px', () => {
    const width = 803 * 500;
    const span = waveformSpan(width, 120_000, 121_400);
    expect(span).not.toBeNull();
    const size = (span?.end ?? 0) - (span?.start ?? 0);
    expect(size).toBeLessThanOrEqual(MAX_WAVEFORM_CANVAS_PX);
    expect(span?.start).toBeLessThanOrEqual(120_000);
    expect(span?.end).toBeGreaterThanOrEqual(121_400);
  });

  it('never exceeds the ceiling, even when the viewport is wider than it', () => {
    const span = waveformSpan(100_000, 0, 100_000);
    expect((span?.end ?? 0) - (span?.start ?? 0)).toBe(MAX_WAVEFORM_CANVAS_PX);
  });

  it('is the whole clip when the clip is small and fully visible', () => {
    expect(waveformSpan(300, 0, 1000)).toEqual({ start: 0, end: 300 });
  });

  it('is quantised, so a small scroll keeps the same canvas', () => {
    const a = waveformSpan(50_000, 10_000, 11_000);
    const b = waveformSpan(50_000, 10_040, 11_040);
    expect(a?.start).toBe(b?.start);
  });

  it('draws nothing for a clip with no width or none of it in view', () => {
    expect(waveformSpan(0, 0, 100)).toBeNull();
    expect(waveformSpan(500, 600, 900)).toBeNull();
    expect(waveformSpan(500, -400, -10)).toBeNull();
  });

  it('keeps the visible slice inside the span at every scroll position', () => {
    const width = 80_300;
    for (let scroll = 0; scroll < width; scroll += 977) {
      const span = waveformSpan(width, scroll, scroll + 1400);
      if (!span) continue;
      expect(span.start).toBeLessThanOrEqual(scroll);
      expect(span.end).toBeGreaterThanOrEqual(Math.min(width, scroll + 1400));
      expect(span.end - span.start).toBeLessThanOrEqual(MAX_WAVEFORM_CANVAS_PX);
    }
  });
});

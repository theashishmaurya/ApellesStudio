// @apelles/editor — the D-318 seconds↔frames edge.
//
// The detector measures in source seconds and the timeline cuts in frames, so
// every candidate crosses this boundary exactly once. These tests pin the two
// properties a cut depends on: each endpoint rounds independently (never a
// rounded duration), and no span can escape the clip it was found in.
import { describe, expect, it } from 'vitest';

import { clipSourceRangeSecs, cuttableSpans, spanToFrames } from './recut';
import type { Clip } from './timeline';

const FPS = 24;

/** A clip trimmed to start 10s into its source and run for 20s. */
function trimmed(): Clip {
  return {
    id: 'c',
    name: 'c',
    source_path: '/fixtures/talk.mov',
    source_start: 240, // 10s @24
    duration: 480, // 20s
    source_len: 2400,
    source_fps: 24,
    start_frame: 100,
  } as Clip;
}

describe('clipSourceRangeSecs', () => {
  it('describes only the material the clip actually shows', () => {
    expect(clipSourceRangeSecs(trimmed(), FPS)).toEqual({ startSecs: 10, durationSecs: 20 });
  });

  it('falls back to the timeline fps when the clip carries none', () => {
    const c = { ...trimmed(), source_fps: undefined } as Clip;
    expect(clipSourceRangeSecs(c, FPS)).toEqual({ startSecs: 10, durationSecs: 20 });
  });
});

describe('spanToFrames', () => {
  it('maps a span in source seconds onto the right timeline frames', () => {
    // 12s–14s of source. The clip starts at source 10s and sits at timeline
    // frame 100, so that is 2s–4s into the clip → timeline 148–196.
    const s = spanToFrames(trimmed(), 12, 14, FPS);
    expect(s.sourceStartFrame).toBe(288);
    expect(s.sourceEndFrame).toBe(336);
    expect(s.startFrame).toBe(148);
    expect(s.endFrame).toBe(196);
  });

  it('rounds each endpoint independently, not via a rounded duration', () => {
    // 0.02s is under half a frame; both endpoints round to the nearest frame on
    // their own, so the span keeps its true length rather than inheriting a
    // duration rounded once.
    const s = spanToFrames(trimmed(), 12.02, 13.98, FPS);
    expect(s.sourceStartFrame).toBe(Math.round(12.02 * FPS));
    expect(s.sourceEndFrame).toBe(Math.round(13.98 * FPS));
  });

  it('clamps a span that starts before the clip does', () => {
    const s = spanToFrames(trimmed(), 0, 11, FPS);
    expect(s.sourceStartFrame, 'cannot reach back past source_start').toBe(240);
    expect(s.startFrame, 'cannot reach back past the clip on the timeline').toBe(100);
  });

  it('clamps a span that runs past the end of the clip', () => {
    const s = spanToFrames(trimmed(), 29, 999, FPS);
    expect(s.sourceEndFrame, 'source_start + duration').toBe(720);
    expect(s.endFrame, 'start_frame + duration').toBe(580);
  });

  it('never produces an inverted span, even from inverted input', () => {
    const s = spanToFrames(trimmed(), 14, 12, FPS);
    expect(s.sourceEndFrame).toBeGreaterThanOrEqual(s.sourceStartFrame);
    expect(s.endFrame).toBeGreaterThanOrEqual(s.startFrame);
  });
});

describe('cuttableSpans', () => {
  it('drops spans that collapsed to nothing after rounding', () => {
    const c = trimmed();
    const real = spanToFrames(c, 12, 14, FPS);
    // Both endpoints land on the same frame — nothing to remove.
    const empty = spanToFrames(c, 12, 12.001, FPS);
    expect(cuttableSpans([real, empty])).toEqual([real]);
  });

  it('is empty for empty input', () => {
    expect(cuttableSpans([])).toEqual([]);
  });
});

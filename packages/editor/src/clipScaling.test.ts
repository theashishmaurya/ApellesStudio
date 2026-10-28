import { describe, expect, it } from 'vitest';

import {
  effectiveClipScaling,
  fittedFootprint,
  LEGACY_CLIP_SCALING,
  parseClipScaling,
  TIMELINE_DEFAULT_SCALING,
} from './clipScaling';

const FRAME = { width: 1080, height: 1920 };

// The same vectors as `apelles_timeline::scaling::tests` — keep them in step.
describe('fittedFootprint (D-425, B-325)', () => {
  it('a matching aspect fills the frame exactly — the 2x Motion render on a same-size timeline', () => {
    expect(fittedFootprint('fit', { width: 2160, height: 3840 }, FRAME)).toEqual(FRAME);
    expect(fittedFootprint('fill', { width: 2160, height: 3840 }, FRAME)).toEqual(FRAME);
  });

  it('fit letterboxes a wider source', () => {
    expect(fittedFootprint('fit', { width: 1920, height: 1080 }, FRAME)).toEqual({ width: 1080, height: 607.5 });
  });

  it('fit pillarboxes a taller source', () => {
    expect(fittedFootprint('fit', { width: 1080, height: 1920 }, { width: 1920, height: 1080 })).toEqual({
      width: 607.5,
      height: 1080,
    });
  });

  it('fit scales a smaller source up', () => {
    expect(fittedFootprint('fit', { width: 540, height: 960 }, FRAME)).toEqual(FRAME);
  });

  it('fill covers the frame and overflows the other axis', () => {
    const f = fittedFootprint('fill', { width: 1920, height: 1080 }, FRAME);
    expect(f.height).toBe(1920);
    expect(f.width).toBeCloseTo(3413.3333, 3);
  });

  it('native is the source unchanged, and a degenerate size is left alone', () => {
    expect(fittedFootprint('native', { width: 2160, height: 3840 }, FRAME)).toEqual({ width: 2160, height: 3840 });
    expect(fittedFootprint('fit', { width: 0, height: 100 }, FRAME)).toEqual({ width: 0, height: 100 });
    expect(fittedFootprint('fit', { width: 100, height: 100 }, { width: 0, height: 0 })).toEqual({
      width: 100,
      height: 100,
    });
  });
});

describe('scaling modes', () => {
  it('a clip with no scaling is native; a timeline with none uses fit', () => {
    expect(effectiveClipScaling({})).toBe(LEGACY_CLIP_SCALING);
    expect(LEGACY_CLIP_SCALING).toBe('native');
    expect(TIMELINE_DEFAULT_SCALING).toBe('fit');
  });

  it('parses only the three names', () => {
    expect(parseClipScaling('fill')).toBe('fill');
    expect(parseClipScaling('stretch')).toBeNull();
    expect(parseClipScaling(3)).toBeNull();
  });
});

// D-396 — clip highlights: the model helpers and the `set_clip_highlights`
// reducer. The compositor draws them (`chroma::highlight_draw`); D-448 deleted
// the filter-graph twin this file used to compile.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HIGHLIGHT_COLOR,
  DEFAULT_HIGHLIGHT_OPACITY,
  HIGHLIGHT_SWEEP_EASE,
  HIGHLIGHT_TIP_ROUNDING,
  highlightProgressAt,
  highlightRgb,
  normalisedHighlightBox,
  sanitizeHighlight,
  validateHighlights,
  type ClipHighlight,
} from './clipHighlights';
import { applyOp, labelForOp, type Clip, type Timeline } from './timeline';

const hl = (over: Partial<ClipHighlight> = {}): ClipHighlight => ({
  box: [0.1, 0.2, 0.6, 0.3],
  at: 0,
  dur: 10,
  ...over,
});

function clip(id: string, over: Partial<Clip> = {}): Clip {
  return {
    id,
    name: id,
    source_path: `/media/${id}.png`,
    source_start: 0,
    duration: 100,
    source_len: 100,
    start_frame: 0,
    ...over,
  };
}

const tl = (clips: Clip[], kind: 'video' | 'audio' = 'video'): Timeline => ({
  id: 't',
  name: 't',
  tracks: [{ kind, clips }],
});

describe('constants mirror the Rust module (apelles_timeline::highlight)', () => {
  it('pins the colour, opacity, sweep ease and tip rounding', () => {
    expect(DEFAULT_HIGHLIGHT_COLOR).toBe('#F2B63A');
    expect(DEFAULT_HIGHLIGHT_OPACITY).toBe(0.45);
    expect(HIGHLIGHT_SWEEP_EASE).toEqual({ x1: 0.215, y1: 0.61, x2: 0.355, y2: 1 });
    expect(HIGHLIGHT_TIP_ROUNDING).toBe(0.25);
  });

  it('progress matches the Rust semantics: 0 before, eased between, 1 from the end on', () => {
    const h = hl({ at: 10, dur: 20 });
    expect(highlightProgressAt(h, 9)).toBe(0);
    expect(highlightProgressAt(h, 10)).toBe(0);
    const mid = highlightProgressAt(h, 20);
    expect(mid).toBeGreaterThan(0.5);
    expect(mid).toBeLessThan(1);
    expect(highlightProgressAt(h, 30)).toBe(1);
    expect(highlightProgressAt(hl({ at: 10, dur: 0 }), 9)).toBe(0);
    expect(highlightProgressAt(hl({ at: 10, dur: 0 }), 10)).toBe(1);
  });

  it('colours parse like Rust: long, short, fallback', () => {
    expect(highlightRgb(undefined)).toEqual([0xf2, 0xb6, 0x3a]);
    expect(highlightRgb('#00ff80')).toEqual([0, 255, 128]);
    expect(highlightRgb('#f08')).toEqual([255, 0, 136]);
    expect(highlightRgb('nope')).toEqual([0xf2, 0xb6, 0x3a]);
  });
});

describe('box, sanitiser and validator', () => {
  it('orders and clamps corners; rejects an empty or non-finite box', () => {
    expect(normalisedHighlightBox([1.5, 0.5, -0.5, 0.25])).toEqual([0, 0.25, 1, 0.5]);
    expect(normalisedHighlightBox([0.5, 0.1, 0.5, 0.2])).toBeNull();
    expect(normalisedHighlightBox([Number.NaN, 0, 1, 1])).toBeNull();
    expect(normalisedHighlightBox([0, 0, 1])).toBeNull();
  });

  it('stores whole non-negative frames and drops a bad colour and out-of-range opacity', () => {
    expect(sanitizeHighlight(hl({ at: -3.2, dur: 4.6, color: 'red', opacity: 7 }))).toEqual({
      box: [0.1, 0.2, 0.6, 0.3],
      at: 0,
      dur: 5,
      opacity: 1,
    });
    expect(sanitizeHighlight(hl({ box: [0, 0, 0, 0] }))).toBeNull();
  });

  it('names the first problem instead of silently dropping an entry', () => {
    expect(validateHighlights('x')).toEqual({ error: 'highlights must be an array' });
    expect(validateHighlights([{ box: [0, 0, 1], at: 0, dur: 1 }])).toMatchObject({
      error: expect.stringContaining('highlights[0].box'),
    });
    expect(validateHighlights([{ box: [0, 0, 0, 1], at: 0, dur: 1 }])).toMatchObject({
      error: expect.stringContaining('no area'),
    });
    expect(validateHighlights([hl(), { ...hl(), color: 'blue' }])).toMatchObject({
      error: expect.stringContaining('highlights[1].color'),
    });
    expect(validateHighlights([{ ...hl(), at: -1 }])).toMatchObject({ error: expect.stringContaining('.at') });
    expect(validateHighlights([{ ...hl(), opacity: 2 }])).toMatchObject({
      error: expect.stringContaining('.opacity'),
    });
    expect(validateHighlights([hl()])).toEqual({ highlights: [hl()] });
  });
});

describe('set_clip_highlights reducer', () => {
  const op = (highlights: ClipHighlight[], track = 0, clipIdx = 0) =>
    ({ kind: 'set_clip_highlights', track, clip: clipIdx, highlights }) as const;

  it('replaces the list, sanitised, and an empty list deletes the key', () => {
    const t = applyOp(tl([clip('a')]), op([hl(), hl({ box: [0, 0, 0, 0] })]));
    expect(t.tracks[0].clips[0].highlights).toEqual([hl()]);
    const cleared = applyOp(t, op([]));
    expect('highlights' in cleared.tracks[0].clips[0]).toBe(false);
  });

  it('returns the SAME timeline for a no-op (no undo entry)', () => {
    const plain = tl([clip('a')]);
    expect(applyOp(plain, op([]))).toBe(plain);
    const withOne = applyOp(plain, op([hl()]));
    expect(applyOp(withOne, op([hl()]))).toBe(withOne);
  });

  it('refuses a locked track, an audio track, a bad index and a generated clip', () => {
    const locked = tl([clip('a')]);
    locked.tracks[0].locked = true;
    expect(applyOp(locked, op([hl()]))).toBe(locked);
    const audio = tl([clip('a')], 'audio');
    expect(applyOp(audio, op([hl()]))).toBe(audio);
    const plain = tl([clip('a')]);
    expect(applyOp(plain, op([hl()], 0, 5))).toBe(plain);
    expect(applyOp(plain, op([hl()], 3, 0))).toBe(plain);
    const title = tl([clip('t', { source_path: '', text: { content: 'x', size: 0.1, color: '#ffffff', font: 'Inter' } })]);
    expect(applyOp(title, op([hl()]))).toBe(title);
  });

  it('is labelled for the undo list', () => {
    const t = tl([clip('a', { name: 'Headline' })]);
    expect(labelForOp(op([hl()]), t)).toContain('Headline');
    expect(labelForOp(op([]), t)).toMatch(/Clear .*highlights/);
  });
});

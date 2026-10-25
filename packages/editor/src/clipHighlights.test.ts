// D-396 — clip highlights: the model helpers, the `set_clip_highlights`
// reducer and the filter compile. The pixel parity between this exporter and
// the Rust compositor is `timelineExportHighlight.ffmpeg.test.ts`.
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
import { buildExportFfmpegArgs } from './timelineExport';
import { highlightGeqSteps, highlightProgressExpr, HIGHLIGHT_SWEEP_SAMPLES } from './timelineExportHighlight';

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

describe('export compile', () => {
  const compile = (h: ClipHighlight[], extra: Partial<Clip> = {}) => {
    const t = tl([clip('a', { source_fps: 25, highlights: h, ...extra })]);
    return buildExportFfmpegArgs(t, '/tmp/out.mp4', { fps: 25, width: 1920, height: 1080 });
  };
  const graphOf = (args: string[]) => args[args.indexOf('-filter_complex') + 1];

  it('a clip without highlights compiles with no geq node at all (byte-identical argv)', () => {
    expect(graphOf(compile([]))).not.toContain('format=rgba,geq');
    expect(compile([])).toEqual(compile([], { highlights: undefined }));
  });

  it('one geq node per highlight, after the clip input and before the scale', () => {
    const graph = graphOf(compile([hl(), hl({ at: 20, color: '#00ff00', opacity: 0.3 })]));
    const nodes = graph.match(/format=rgba,geq=/g) ?? [];
    expect(nodes).toHaveLength(2);
    expect(graph.indexOf('geq=')).toBeLessThan(graph.indexOf('scale='));
    expect(graph).toContain('[hlv0_0]');
    expect(graph).toContain('[hlv0_1]');
  });

  it('a degenerate box or zero opacity compiles to nothing', () => {
    const { steps } = highlightGeqSteps({
      highlights: [hl({ box: [0.5, 0, 0.5, 1] }), hl({ opacity: 0 })],
      src: '[0:v]',
      label: 'x',
      sourceStart: 0,
      fps: 25,
      bigTVar: 'T',
    });
    expect(steps).toEqual([]);
  });

  it('the progress expression is a clamped ramp over the sweep, in clip-input seconds', () => {
    const expr = highlightProgressExpr({ at: 50, dur: 25 }, 25, 25, 'T');
    // at-25 = 25 frames = 1s .. 2s; holds 0 before, 1 after.
    expect(expr).toMatch(/^if\(lt\(T,1\),0,/);
    expect((expr.match(/between\(/g) ?? []).length).toBe(HIGHLIGHT_SWEEP_SAMPLES);
    expect(highlightProgressExpr({ at: 25, dur: 0 }, 0, 25, 'T')).toBe('gte(T,0.98)');
  });
});

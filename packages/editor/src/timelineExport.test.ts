// @chroma/editor — unit tests for `timelineExport.ts`: `keyframeExprAt`'s
// piecewise-linear ffmpeg expression generator, and `buildExportFfmpegArgs`'s
// real timeline -> ffmpeg-argv compiler.
import { describe, expect, it } from 'vitest';
import { buildExportFfmpegArgs, keyframeExprAt, type ExportKeyframe, type TimelineExportOptions } from './timelineExport';
import type { Clip, Timeline, Track } from './timeline';

/** Evaluates a `keyframeExprAt` expression at a given `t` — a tiny
 *  interpreter for the ffmpeg-expression subset this module emits
 *  (`if`, `between`, `lt`), so tests assert real behaviour at sample `t`
 *  values rather than brittle string-layout matching. `if` is rewritten to
 *  `iff` since `if` is a reserved word and can't be called as a function. */
function evalExpr(expr: string, t: number): number {
  const rewritten = expr.replace(/\bif\(/g, 'iff(');
  const iff = (cond: boolean, a: number, b: number) => (cond ? a : b);
  const between = (x: number, a: number, b: number) => x >= a && x <= b;
  const lt = (a: number, b: number) => a < b;
  // eslint-disable-next-line no-new-func
  const fn = new Function('t', 'iff', 'between', 'lt', `return ${rewritten};`);
  return fn(t, iff, between, lt) as number;
}

function clip(id: string, overrides: Partial<Clip> = {}): Clip {
  return {
    id,
    name: id,
    source_path: `/media/${id}.mov`,
    source_start: 0,
    duration: 240,
    source_len: 240,
    start_frame: 0,
    ...overrides,
  };
}

function track(kind: Track['kind'], clips: Clip[], overrides: Partial<Track> = {}): Track {
  return { kind, clips, ...overrides };
}

function timeline(tracks: Track[]): Timeline {
  return { id: 'tl', name: 'tl', tracks };
}

const opts30: TimelineExportOptions = { fps: 30, width: 1080, height: 1920 };

describe('keyframeExprAt', () => {
  it('returns the static value when there are no keyframes at all', () => {
    expect(keyframeExprAt([], 'position_x', 0.25, 30)).toBe('0.25');
  });

  it('returns the static value when no keyframe sets this param', () => {
    const kfs: ExportKeyframe[] = [{ frame: 0, params: { opacity: 0.5 } }];
    expect(keyframeExprAt(kfs, 'position_x', 0.25, 30)).toBe('0.25');
  });

  it('returns a constant when only one keyframe sets this param', () => {
    const kfs: ExportKeyframe[] = [{ frame: 10, params: { position_x: 0.7 } }];
    const expr = keyframeExprAt(kfs, 'position_x', 0, 30);
    expect(expr).toBe('0.7');
    // constant regardless of t
    expect(evalExpr(expr, 0)).toBe(0.7);
    expect(evalExpr(expr, 999)).toBe(0.7);
  });

  it('holds at the first value before the first keyframe (no backward extrapolation)', () => {
    const kfs: ExportKeyframe[] = [
      { frame: 30, params: { position_x: 0.2 } },
      { frame: 60, params: { position_x: 0.8 } },
    ];
    const expr = keyframeExprAt(kfs, 'position_x', 0, 30);
    expect(evalExpr(expr, -5)).toBe(0.2);
    expect(evalExpr(expr, 0)).toBe(0.2);
  });

  it('holds at the last value after the last keyframe (no forward extrapolation)', () => {
    const kfs: ExportKeyframe[] = [
      { frame: 0, params: { position_x: 0.2 } },
      { frame: 30, params: { position_x: 0.8 } },
    ];
    const expr = keyframeExprAt(kfs, 'position_x', 0, 30);
    expect(evalExpr(expr, 5)).toBe(0.8);
    expect(evalExpr(expr, 1000)).toBe(0.8);
  });

  it('linearly interpolates between two consecutive param-setting keyframes', () => {
    const kfs: ExportKeyframe[] = [
      { frame: 0, params: { position_x: 0 } },
      { frame: 30, params: { position_x: 1 } },
    ];
    const expr = keyframeExprAt(kfs, 'position_x', 0, 30);
    expect(evalExpr(expr, 0)).toBeCloseTo(0);
    expect(evalExpr(expr, 0.5)).toBeCloseTo(0.5);
    expect(evalExpr(expr, 1)).toBeCloseTo(1);
  });

  it('selects the correct segment among 3+ keyframes, including a middle value', () => {
    const kfs: ExportKeyframe[] = [
      { frame: 0, params: { position_x: 0 } },
      { frame: 30, params: { position_x: 100 } },
      { frame: 60, params: { position_x: 0 } },
    ];
    const expr = keyframeExprAt(kfs, 'position_x', 0, 30);
    expect(evalExpr(expr, 0)).toBeCloseTo(0);
    expect(evalExpr(expr, 0.5)).toBeCloseTo(50); // first segment midpoint
    expect(evalExpr(expr, 1)).toBeCloseTo(100); // exact middle keyframe
    expect(evalExpr(expr, 1.5)).toBeCloseTo(50); // second segment midpoint
    expect(evalExpr(expr, 2)).toBeCloseTo(0);
  });

  it('skips keyframes that do not set this param, independently per param', () => {
    const kfs: ExportKeyframe[] = [
      { frame: 0, params: { position_x: 0, opacity: 1 } },
      { frame: 10, params: { opacity: 0.5 } }, // does not set position_x
      { frame: 20, params: { position_x: 1 } },
    ];
    const fps = 10; // frame 0 -> t=0, frame 10 -> t=1, frame 20 -> t=2
    const expr = keyframeExprAt(kfs, 'position_x', 0, fps);
    // t=1 (frame 10's own time) must land on the two-point position_x
    // segment [t=0..2], not treat frame 10 as a breakpoint of its own.
    expect(evalExpr(expr, 1)).toBeCloseTo(0.5);
    expect(evalExpr(expr, 0)).toBeCloseTo(0);
    expect(evalExpr(expr, 2)).toBeCloseTo(1);
  });

  it('does not assume pre-sorted input, and never mutates the input array', () => {
    const kfs: ExportKeyframe[] = [
      { frame: 20, params: { position_x: 1 } },
      { frame: 0, params: { position_x: 0 } },
    ];
    const snapshot = kfs.map((k) => ({ ...k }));
    const expr = keyframeExprAt(kfs, 'position_x', 0, 20);
    expect(evalExpr(expr, 0.5)).toBeCloseTo(0.5);
    expect(kfs).toEqual(snapshot); // unchanged order/contents
  });
});

describe('buildExportFfmpegArgs', () => {
  it('compiles a single clip with no crop/keyframes/speed to the exact expected argv', () => {
    const tl = timeline([track('video', [clip('c1')])]);
    const args = buildExportFfmpegArgs(tl, '/out.mp4', opts30);

    expect(args).toEqual([
      '-ss',
      '0',
      '-t',
      '8',
      '-i',
      '/media/c1.mov',
      '-filter_complex',
      "[0:v]scale=1080*1:-2[v0];color=black:size=1080x1920:rate=30[base];[base][v0]overlay=x=0*W:y=0*H:enable='between(t,0,8)'[outv]",
      '-map',
      '[outv]',
      '-r',
      '30',
      '/out.mp4',
    ]);
  });

  it('chains crop then scale, in order, when the clip has a non-zero crop', () => {
    const c = clip('c1', { crop_left: 0.1, crop_top: 0, crop_right: 0.05, crop_bottom: 0, scale: 0.5 });
    const tl = timeline([track('video', [c])]);
    const args = buildExportFfmpegArgs(tl, '/out.mp4', opts30);
    const filterComplex = args[args.indexOf('-filter_complex') + 1];

    expect(filterComplex).toContain(
      '[0:v]crop=iw*(1-0.1-0.05):ih*(1-0-0):iw*0.1:ih*0[cv0];[cv0]scale=1080*0.5:-2[v0]',
    );
  });

  it('B-074: scale sets overlay WIDTH from the canvas, but never forces a height — ffmpeg auto-computes height from the real (post-crop) aspect ratio instead of distorting to a canvas-shaped box', () => {
    const c = clip('c1', { scale: 0.5 });
    const tl = timeline([track('video', [c])]);
    // A DIFFERENT canvas aspect ratio than 9:16 (opts30) — if height were
    // ever computed as `opts.height * scale` again, this assertion's exact
    // number would change with the canvas shape, which is exactly the bug:
    // every overlay box was forced to share the canvas's own aspect ratio.
    const wideOpts: TimelineExportOptions = { fps: 30, width: 1000, height: 400 };
    const args = buildExportFfmpegArgs(tl, '/out.mp4', wideOpts);
    const filterComplex = args[args.indexOf('-filter_complex') + 1];

    expect(filterComplex).toContain('scale=1000*0.5:-2[v0]');
    // the old formula (`400*0.5` = 200) must never appear as this clip's height
    expect(filterComplex).not.toContain('scale=1000*0.5:200[v0]');
  });

  it('B-074: fitOverrides lets a caller opt back into the old force-to-canvas-box (stretch) behavior per clip', () => {
    const c = clip('c1', { scale: 0.5 });
    const tl = timeline([track('video', [c])]);
    const opts: TimelineExportOptions = { ...opts30, fitOverrides: { c1: 'stretch' } };
    const args = buildExportFfmpegArgs(tl, '/out.mp4', opts);
    const filterComplex = args[args.indexOf('-filter_complex') + 1];

    expect(filterComplex).toContain('scale=1080*0.5:1920*0.5[v0]');
  });

  it('B-074: a clip with no fitOverrides entry defaults to fit (aspect-preserving), even when other clips are overridden', () => {
    const a = clip('a', { scale: 1 });
    const b = clip('b', { scale: 1 });
    const tl = timeline([track('video', [a]), track('video', [b])]);
    const opts: TimelineExportOptions = { ...opts30, fitOverrides: { b: 'stretch' } };
    const args = buildExportFfmpegArgs(tl, '/out.mp4', opts);
    const filterComplex = args[args.indexOf('-filter_complex') + 1];

    expect(filterComplex).toContain('scale=1080*1:-2'); // a: no override, fits
    expect(filterComplex).toContain('scale=1080*1:1920*1'); // b: stretch override
  });

  it('omits the crop filter node entirely when all four crop fractions are zero', () => {
    const tl = timeline([track('video', [clip('c1')])]);
    const args = buildExportFfmpegArgs(tl, '/out.mp4', opts30);
    const filterComplex = args[args.indexOf('-filter_complex') + 1];

    expect(filterComplex).not.toContain('crop=');
  });

  it('adds a setpts filter and shrinks the on-timeline enable() window when sped up', () => {
    const c = clip('c1', { duration: 240, start_frame: 0 });
    const tl = timeline([track('video', [c])]);
    const opts: TimelineExportOptions = { ...opts30, speedOverrides: { c1: 1.2 } };
    const args = buildExportFfmpegArgs(tl, '/out.mp4', opts);
    const filterComplex = args[args.indexOf('-filter_complex') + 1];

    expect(filterComplex).toContain('setpts=PTS/1.2');
    const expectedEnd = 0 + 240 / 1.2 / opts.fps;
    expect(filterComplex).toContain(`enable='between(t,0,${expectedEnd})'`);
  });

  it('omits the setpts filter entirely when no speed override applies to the clip', () => {
    const tl = timeline([track('video', [clip('c1')])]);
    const args = buildExportFfmpegArgs(tl, '/out.mp4', { ...opts30, speedOverrides: { other: 1.5 } });
    const filterComplex = args[args.indexOf('-filter_complex') + 1];

    expect(filterComplex).not.toContain('setpts=');
  });

  it("uses keyframeExprAt's own output as the overlay x= expression when the clip has position_x keyframes", () => {
    const kfs: ExportKeyframe[] = [
      { frame: 0, params: { position_x: 0.1 } },
      { frame: 30, params: { position_x: 0.5 } },
    ];
    const c = clip('c1', { source_start: 0, chroma_keyframes: kfs });
    const tl = timeline([track('video', [c])]);
    const args = buildExportFfmpegArgs(tl, '/out.mp4', opts30);
    const filterComplex = args[args.indexOf('-filter_complex') + 1];

    const expectedX = keyframeExprAt(kfs, 'position_x', 0, opts30.fps);
    expect(filterComplex).toContain(`x=${expectedX}*W`);
  });

  it('re-bases chroma_keyframes (source-frame-absolute) to the clip input stream before interpolating', () => {
    // source_start=60: a keyframe at source frame 60 is this clip's own t=0.
    const kfs: ExportKeyframe[] = [
      { frame: 60, params: { position_x: 0 } },
      { frame: 90, params: { position_x: 1 } },
    ];
    const c = clip('c1', { source_start: 60, duration: 30, chroma_keyframes: kfs });
    const tl = timeline([track('video', [c])]);
    const args = buildExportFfmpegArgs(tl, '/out.mp4', opts30);
    const filterComplex = args[args.indexOf('-filter_complex') + 1];

    const rebased: ExportKeyframe[] = [
      { frame: 0, params: { position_x: 0 } },
      { frame: 30, params: { position_x: 1 } },
    ];
    const expectedX = keyframeExprAt(rebased, 'position_x', 0, opts30.fps);
    expect(filterComplex).toContain(`x=${expectedX}*W`);
  });

  it('excludes every clip on a hidden video track', () => {
    const hiddenClip = clip('hidden1');
    const visibleClip = clip('visible1');
    const tl = timeline([
      track('video', [hiddenClip], { hidden: true }),
      track('video', [visibleClip]),
    ]);
    const args = buildExportFfmpegArgs(tl, '/out.mp4', opts30);

    expect(args).not.toContain('/media/hidden1.mov');
    expect(args).toContain('/media/visible1.mov');
    expect(args.filter((a) => a === '-i')).toHaveLength(1);
  });

  it('composites two clips on two video tracks in track-index z-order (index 0 on top)', () => {
    // Track 0 = "top" clip, Track 1 = "bottom" clip — per `composite_video_
    // frame`'s own doc (`edit.rs`): track index 0 is highest z-priority,
    // painted LAST (on top); higher indices paint first, at the back.
    const top = clip('top', { source_path: '/media/top.mov' });
    const bottom = clip('bottom', { source_path: '/media/bottom.mov' });
    const tl = timeline([track('video', [top]), track('video', [bottom])]);
    const args = buildExportFfmpegArgs(tl, '/out.mp4', opts30);
    const filterComplex = args[args.indexOf('-filter_complex') + 1];

    // Bottom (higher track index, lower priority) is decoded/input first —
    // it becomes the first overlay layer, painted onto the base first.
    const inputPaths = args.filter((a) => a.endsWith('.mov'));
    expect(inputPaths).toEqual(['/media/bottom.mov', '/media/top.mov']);

    // The FINAL overlay in the chain (the one mapped to output) must be the
    // one compositing the top clip's own label (v1, its input index) onto
    // the accumulated result — i.e. top is painted last, on top.
    expect(filterComplex).toMatch(/\[ov0\]\[v1\]overlay=.*\[outv\]$/);
    expect(args[args.indexOf('-map') + 1]).toBe('[outv]');
  });
});

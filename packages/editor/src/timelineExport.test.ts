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
      "[0:v]scale=w='1080*(1)':h=-2[v0];color=black:size=1080x1920:rate=30[base];[base][v0]overlay=x='0*W':y='0*H':enable='between(t,0,8)'[outv]",
      '-map',
      '[outv]',
      '-r',
      '30',
      '-t',
      '8',
      '/out.mp4',
    ]);
  });

  it('chains crop then scale, in order, when the clip has a non-zero crop', () => {
    const c = clip('c1', { crop_left: 0.1, crop_top: 0, crop_right: 0.05, crop_bottom: 0, scale: 0.5 });
    const tl = timeline([track('video', [c])]);
    const args = buildExportFfmpegArgs(tl, '/out.mp4', opts30);
    const filterComplex = args[args.indexOf('-filter_complex') + 1];

    // B-098 — quoted, named w=/h=/x=/y= params (was a positional, unquoted
    // string) so a keyframed inset's expression survives the filtergraph
    // parser, the same fix B-075/B-090 already made for position/scale.
    // Byte-identical MEANING for this static-only case, different syntax.
    expect(filterComplex).toContain(
      "[0:v]crop=w='iw*(1-(0.1)-(0.05))':h='ih*(1-(0)-(0))':x='iw*(0.1)':y='ih*(0)'[cv0];[cv0]scale=w='1080*(0.5)':h=-2[v0]",
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

    expect(filterComplex).toContain("scale=w='1000*(0.5)':h=-2[v0]");
    // the old formula (`400*0.5` = 200) must never appear as this clip's height
    expect(filterComplex).not.toContain("scale=w='1000*(0.5)':h='200'[v0]");
  });

  it('B-074: fitOverrides lets a caller opt back into the old force-to-canvas-box (stretch) behavior per clip', () => {
    const c = clip('c1', { scale: 0.5 });
    const tl = timeline([track('video', [c])]);
    const opts: TimelineExportOptions = { ...opts30, fitOverrides: { c1: 'stretch' } };
    const args = buildExportFfmpegArgs(tl, '/out.mp4', opts);
    const filterComplex = args[args.indexOf('-filter_complex') + 1];

    expect(filterComplex).toContain("scale=w='1080*(0.5)':h='1920*(0.5)'[v0]");
  });

  it('B-074: a clip with no fitOverrides entry defaults to fit (aspect-preserving), even when other clips are overridden', () => {
    const a = clip('a', { scale: 1 });
    const b = clip('b', { scale: 1 });
    const tl = timeline([track('video', [a]), track('video', [b])]);
    const opts: TimelineExportOptions = { ...opts30, fitOverrides: { b: 'stretch' } };
    const args = buildExportFfmpegArgs(tl, '/out.mp4', opts);
    const filterComplex = args[args.indexOf('-filter_complex') + 1];

    expect(filterComplex).toContain("scale=w='1080*(1)':h=-2"); // a: no override, fits
    expect(filterComplex).toContain("scale=w='1080*(1)':h='1920*(1)'"); // b: stretch override
  });

  it('B-075: uses a clip\'s own source_fps (not opts.fps) to convert source_start/duration to real seconds for -ss/-t', () => {
    // A clip whose native rate (24fps) differs from the export rate (opts30 = 30fps).
    const c = clip('c1', { source_fps: 24, source_start: 48, duration: 240 });
    const tl = timeline([track('video', [c])]);
    const args = buildExportFfmpegArgs(tl, '/out.mp4', opts30);

    expect(args[args.indexOf('-ss') + 1]).toBe(String(48 / 24)); // 2s, not 48/30
    expect(args[args.indexOf('-t') + 1]).toBe(String(240 / 24)); // 10s, not 240/30
  });

  it('B-075: falls back to opts.fps when a clip has no known source_fps (pre-B-075 clip, or unprobed source)', () => {
    const c = clip('c1', { source_start: 60, duration: 300 }); // no source_fps set
    const tl = timeline([track('video', [c])]);
    const args = buildExportFfmpegArgs(tl, '/out.mp4', opts30);

    expect(args[args.indexOf('-ss') + 1]).toBe(String(60 / opts30.fps));
    expect(args[args.indexOf('-t') + 1]).toBe(String(300 / opts30.fps));
  });

  it('B-075: a keyframe\'s frame number is interpreted at the clip\'s own source_fps, not opts.fps', () => {
    const kfs: ExportKeyframe[] = [
      { frame: 0, params: { position_x: 0 } },
      { frame: 24, params: { position_x: 1 } }, // 1 real second at 24fps
    ];
    const c = clip('c1', { source_fps: 24, chroma_keyframes: kfs });
    const tl = timeline([track('video', [c])]);
    const args = buildExportFfmpegArgs(tl, '/out.mp4', opts30); // export at 30fps
    const filterComplex = args[args.indexOf('-filter_complex') + 1];

    // At the clip's real 24fps, frame 24 is t=1 — NOT t=24/30=0.8 (what the
    // pre-B-075 code would have produced by dividing by opts.fps instead).
    expect(filterComplex).toContain('between(t,0,1)');
    expect(filterComplex).not.toContain('between(t,0,0.8)');
  });

  it('B-075: an on-timeline enable() window uses the clip\'s own source_fps for duration, but opts.fps for start_frame (a TIMELINE frame, a different unit)', () => {
    const c = clip('c1', { source_fps: 24, start_frame: 30, duration: 48 }); // start_frame is a TIMELINE frame (opts30=30fps -> 1s); duration is 48 SOURCE frames at 24fps -> 2s
    const tl = timeline([track('video', [c])]);
    const args = buildExportFfmpegArgs(tl, '/out.mp4', opts30);
    const filterComplex = args[args.indexOf('-filter_complex') + 1];

    expect(filterComplex).toContain("enable='between(t,1,3)'"); // starts at 1s (timeline), runs 2s (source) -> ends at 3s
  });

  it('B-076: caps the output with -t at the furthest clip end — the color=[base] backdrop has no duration of its own and would otherwise never reach EOF', () => {
    const a = clip('a', { duration: 240 }); // 8s at opts30 (30fps)
    const b = clip('b', { duration: 150, start_frame: 60 }); // starts at 2s, runs 5s -> ends at 7s
    const tl = timeline([track('video', [a]), track('video', [b])]);
    const args = buildExportFfmpegArgs(tl, '/out.mp4', opts30);

    expect(args[args.length - 1]).toBe('/out.mp4');
    expect(args[args.length - 2]).toBe('8'); // the LONGER of the two clips' real ends, not either alone
    expect(args[args.length - 3]).toBe('-t');
  });

  it('B-076: an empty timeline (no clips at all) gets -t 0, not an unbounded run', () => {
    const tl = timeline([track('video', [])]);
    const args = buildExportFfmpegArgs(tl, '/out.mp4', opts30);

    expect(args[args.indexOf('-t', args.indexOf('-filter_complex')) + 1]).toBe('0');
  });

  it('D-188: freezeOverrides holds a clip\'s last frame (tpad) and extends its enable() window to the timeline\'s real total duration', () => {
    const shortSped = clip('short', { duration: 96, source_fps: 24 }); // 4s real, sped later isn't the point here
    const long = clip('long', { duration: 240, source_fps: 30, start_frame: 0 }); // 8s real — the longest clip
    const tl = timeline([track('video', [shortSped]), track('video', [long])]);
    const opts: TimelineExportOptions = { ...opts30, freezeOverrides: { short: true } };
    const args = buildExportFfmpegArgs(tl, '/out.mp4', opts);
    const filterComplex = args[args.indexOf('-filter_complex') + 1];

    // tpad pads the short clip's own filter chain by (8 - 4) = 4s.
    expect(filterComplex).toContain('tpad=stop_mode=clone:stop_duration=4');
    // its enable() window now runs all the way to the real total (8s), not
    // its own natural 4s end.
    expect(filterComplex).toContain("enable='between(t,0,8)'");
    // the overall export is still capped at the real total duration.
    expect(args[args.length - 2]).toBe('8');
  });

  it('D-188: a clip with no freezeOverrides entry is completely unaffected — no tpad, its own natural enable() window', () => {
    const a = clip('a', { duration: 96, source_fps: 24 }); // 4s
    const b = clip('b', { duration: 240, source_fps: 30 }); // 8s — the longest
    const tl = timeline([track('video', [a]), track('video', [b])]);
    const args = buildExportFfmpegArgs(tl, '/out.mp4', opts30); // no freezeOverrides at all
    const filterComplex = args[args.indexOf('-filter_complex') + 1];

    expect(filterComplex).not.toContain('tpad');
    expect(filterComplex).toContain("enable='between(t,0,4)'"); // a's own natural end
    expect(filterComplex).toContain("enable='between(t,0,8)'"); // b's own natural end
  });

  it('D-188: freezing the LONGEST clip on the timeline is a no-op — zero padding, no negative-duration tpad', () => {
    const shortOne = clip('short', { duration: 96, source_fps: 24 }); // 4s
    const longest = clip('longest', { duration: 240, source_fps: 30 }); // 8s — already the max
    const tl = timeline([track('video', [shortOne]), track('video', [longest])]);
    const opts: TimelineExportOptions = { ...opts30, freezeOverrides: { longest: true } };
    const args = buildExportFfmpegArgs(tl, '/out.mp4', opts);
    const filterComplex = args[args.indexOf('-filter_complex') + 1];

    expect(filterComplex).not.toContain('tpad');
  });

  it('D-193: box_width/box_height size the overlay as independent canvas fractions, the "full width, half height" layout B-074 could never express via scale alone', () => {
    const c = clip('c1', { box_width: 1, box_height: 0.5 });
    const tl = timeline([track('video', [c])]);
    const args = buildExportFfmpegArgs(tl, '/out.mp4', opts30);
    const filterComplex = args[args.indexOf('-filter_complex') + 1];

    expect(filterComplex).toContain("scale=w='1080*1':h='1920*0.5'[v0]");
  });

  it('D-193: box_width alone overrides only the width — height falls back to scale/fitOverrides exactly as before', () => {
    const c = clip('c1', { box_width: 0.75, scale: 0.5 });
    const tl = timeline([track('video', [c])]);
    const args = buildExportFfmpegArgs(tl, '/out.mp4', opts30);
    const filterComplex = args[args.indexOf('-filter_complex') + 1];

    expect(filterComplex).toContain("scale=w='1080*0.75':h=-2[v0]");
  });

  it('D-193: box_height takes priority over fitOverrides — an explicit persisted height wins over the export-time-only stretch default', () => {
    const c = clip('c1', { scale: 0.5, box_height: 0.9 });
    const tl = timeline([track('video', [c])]);
    const opts: TimelineExportOptions = { ...opts30, fitOverrides: { c1: 'stretch' } };
    const args = buildExportFfmpegArgs(tl, '/out.mp4', opts);
    const filterComplex = args[args.indexOf('-filter_complex') + 1];

    expect(filterComplex).toContain("scale=w='1080*(0.5)':h='1920*0.9'[v0]");
  });

  it('D-193: a clip with no box_width/box_height behaves the same as the plain scale-only path (pre-D-193 shape, now safely quoted per B-090)', () => {
    const c = clip('c1', { scale: 0.5 });
    const tl = timeline([track('video', [c])]);
    const args = buildExportFfmpegArgs(tl, '/out.mp4', opts30);
    const filterComplex = args[args.indexOf('-filter_complex') + 1];

    expect(filterComplex).toContain("scale=w='1080*(0.5)':h=-2[v0]");
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
    expect(filterComplex).toContain(`x='${expectedX}*W'`);
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
    expect(filterComplex).toContain(`x='${expectedX}*W'`);
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

// D-197 — real audio mixing. These are the string-matching layer
// (`timelineExport.ffmpeg.test.ts` is the real-ffmpeg-execution layer that
// actually confirms the mixed audio is correct at the sample/level, not just
// that these strings look plausible).
describe('buildExportFfmpegArgs — audio (D-197)', () => {
  it('a video-only timeline with no audio tracks and no hasAudioOverrides produces NO audio map at all — byte-identical to pre-D-197', () => {
    const tl = timeline([track('video', [clip('c1')])]);
    const args = buildExportFfmpegArgs(tl, '/out.mp4', opts30);

    expect(args.filter((a) => a === '-map')).toHaveLength(1); // video only
    const filterComplex = args[args.indexOf('-filter_complex') + 1];
    expect(filterComplex).not.toContain('amix');
    expect(filterComplex).not.toContain('asoftclip');
    expect(filterComplex).not.toContain(':a]');
  });

  it('a single audio-track clip is mapped directly off its own input — no amix/asoftclip needed for exactly one source', () => {
    const a = clip('a1', { duration: 240 });
    const tl = timeline([track('audio', [a])]);
    const args = buildExportFfmpegArgs(tl, '/out.mp4', opts30);
    const filterComplex = args[args.indexOf('-filter_complex') + 1];

    expect(filterComplex).not.toContain('amix');
    expect(filterComplex).not.toContain('asoftclip');
    // exactly one clip, no video at all -> input 0 is the audio clip itself
    const maps = args.filter((a2, i) => args[i - 1] === '-map');
    expect(maps).toContain('0:a');
  });

  it('a plain audio-track clip with default gain/no fade/no duck at frame 0 needs no filter chain at all — direct raw mapping', () => {
    const a = clip('a1', { duration: 240, start_frame: 0 });
    const tl = timeline([track('audio', [a])]);
    const args = buildExportFfmpegArgs(tl, '/out.mp4', opts30);
    const filterComplex = args[args.indexOf('-filter_complex') + 1];

    expect(filterComplex).not.toContain('volume=');
    expect(filterComplex).not.toContain('adelay');
  });

  it("an audio-track clip's non-zero start_frame gets an adelay matching its real timeline position in ms", () => {
    const a = clip('a1', { duration: 240, start_frame: 60 }); // 60/30fps = 2s -> 2000ms
    const tl = timeline([track('audio', [a])]);
    const args = buildExportFfmpegArgs(tl, '/out.mp4', opts30);
    const filterComplex = args[args.indexOf('-filter_complex') + 1];

    expect(filterComplex).toContain('adelay=2000:all=1');
  });

  it("track gain != 1 becomes a plain volume=<gain> filter when there's no fade/duck", () => {
    const a = clip('a1', { duration: 240 });
    const tl = timeline([track('audio', [a], { gain: 0.5 })]);
    const args = buildExportFfmpegArgs(tl, '/out.mp4', opts30);
    const filterComplex = args[args.indexOf('-filter_complex') + 1];

    expect(filterComplex).toContain('volume=0.5');
    expect(filterComplex).not.toContain('eval=frame');
  });

  it('a clip with a fade configured gets a volume=eval=frame:volume=\'...\' expression, not a plain constant', () => {
    const a = clip('a1', { duration: 240, fade_in_frames: 30 });
    const tl = timeline([track('audio', [a])]);
    const args = buildExportFfmpegArgs(tl, '/out.mp4', opts30);
    const filterComplex = args[args.indexOf('-filter_complex') + 1];

    expect(filterComplex).toMatch(/volume=eval=frame:volume='[^']+'/);
  });

  it('two audio-track clips mix via amix with normalize=0, then asoftclip=type=tanh, mapped as [outa]', () => {
    const a = clip('a1', { duration: 240 });
    const b = clip('a2', { duration: 240 });
    const tl = timeline([track('audio', [a]), track('audio', [b])]);
    const args = buildExportFfmpegArgs(tl, '/out.mp4', opts30);
    const filterComplex = args[args.indexOf('-filter_complex') + 1];

    expect(filterComplex).toContain('amix=inputs=2:duration=longest:normalize=0[mixa]');
    expect(filterComplex).toContain('[mixa]asoftclip=type=tanh[outa]');
    const maps = args.filter((a2, i) => args[i - 1] === '-map');
    expect(maps).toContain('[outa]');
  });

  it("a video clip's embedded audio is INCLUDED only when hasAudioOverrides positively says so — the conservative default", () => {
    const v = clip('v1', { duration: 240 });
    const tl = timeline([track('video', [v])]);
    const withoutOverride = buildExportFfmpegArgs(tl, '/out.mp4', opts30);
    expect(withoutOverride.filter((a) => a === '-map')).toHaveLength(1);

    const withOverride = buildExportFfmpegArgs(tl, '/out.mp4', { ...opts30, hasAudioOverrides: { v1: true } });
    const maps = withOverride.filter((a, i) => withOverride[i - 1] === '-map');
    expect(maps).toContain('0:a'); // reuses the SAME input as the video, no second -i
    expect(withOverride.filter((a) => a === '-i')).toHaveLength(1);
  });

  it('a video clip with an A/V link_group is EXCLUDED from embedded audio even when hasAudioOverrides says true — D-129: its audio comes from the linked clip instead', () => {
    const v = clip('v1', { duration: 240, link_group: 'lg-1' });
    const a = clip('a1', { duration: 240, link_group: 'lg-1' });
    const tl = timeline([track('video', [v]), track('audio', [a])]);
    const args = buildExportFfmpegArgs(tl, '/out.mp4', { ...opts30, hasAudioOverrides: { v1: true, a1: true } });
    const filterComplex = args[args.indexOf('-filter_complex') + 1];

    // Only ONE audio source total (the real audio-track clip) -> no amix.
    expect(filterComplex).not.toContain('amix');
    const maps = args.filter((a2, i) => args[i - 1] === '-map');
    expect(maps).toContain('1:a'); // input 1 is the audio-track clip (input 0 is the video)
  });

  it("an audio-track clip explicitly marked hasAudioOverrides: false is excluded, even though audio-track clips default to included", () => {
    const a = clip('a1', { duration: 240 });
    const tl = timeline([track('audio', [a])]);
    const args = buildExportFfmpegArgs(tl, '/out.mp4', { ...opts30, hasAudioOverrides: { a1: false } });
    // The black-background `[base]` layer is always mapped regardless of
    // whether any real video track exists — with the sole audio clip
    // excluded, that's the ONLY `-map` in the whole command.
    expect(args.filter((a2) => a2 === '-map')).toHaveLength(1);
  });

  it('a sped-up clip gets an atempo chain on its audio, keeping it in sync with the setpts-sped picture', () => {
    const v = clip('v1', { duration: 240 });
    const tl = timeline([track('video', [v])]);
    const args = buildExportFfmpegArgs(tl, '/out.mp4', {
      ...opts30,
      hasAudioOverrides: { v1: true },
      speedOverrides: { v1: 1.5 },
    });
    const filterComplex = args[args.indexOf('-filter_complex') + 1];

    expect(filterComplex).toContain('atempo=1.5');
  });

  it("duck ties to the trigger track's OWN configured clips, not any arbitrary track", () => {
    const bed = clip('bed', { duration: 300 });
    const dialogue = clip('dia', { duration: 60, start_frame: 30 });
    const tl = timeline([
      track('audio', [bed], { duck_from: 1, duck_db: -12, duck_attack_ms: 10, duck_release_ms: 300 }),
      track('audio', [dialogue]),
    ]);
    const args = buildExportFfmpegArgs(tl, '/out.mp4', opts30);
    const filterComplex = args[args.indexOf('-filter_complex') + 1];

    expect(filterComplex).toContain('exp(');
    expect(filterComplex).toContain('amix'); // two real sources (bed + dialogue)
  });

  it('a video track can also be ducked (D-149: "a video track\'s embedded audio ... ducks like any other")', () => {
    const v = clip('v1', { duration: 240 });
    const trigger = clip('trig', { duration: 60, start_frame: 30 });
    const tl = timeline([
      track('video', [v], { duck_from: 1, duck_db: -12, duck_attack_ms: 10, duck_release_ms: 300 }),
      track('audio', [trigger]),
    ]);
    const args = buildExportFfmpegArgs(tl, '/out.mp4', { ...opts30, hasAudioOverrides: { v1: true } });
    const filterComplex = args[args.indexOf('-filter_complex') + 1];

    expect(filterComplex).toContain('exp(');
  });
});

// @chroma/editor — REAL ffmpeg-execution regression tests for
// `timelineExport.ts` (B-075, same session as B-074).
//
// `timelineExport.test.ts` only ever asserts on the generated argv STRINGS —
// it never actually runs ffmpeg. That's exactly how two real, live-blocking
// bugs shipped invisibly: an unquoted keyframe expression that ffmpeg's own
// filtergraph parser rejects outright ("No option name near 'if(lt(t'"), and
// a source-fps/timeline-fps unit mix-up that silently produced the wrong
// clip duration whenever a source's native frame rate differed from the
// export's. Both were only found by a real human building a real video and
// reading real ffmpeg stderr — this file is what should have caught them
// first. Slower than the pure unit tests (spawns a real ffmpeg process a
// handful of times, generates tiny real fixture clips) but a real
// determinism/correctness net, same spirit as the app's own render-fixture
// hash tests (CLAUDE.md's "Determinism" testing rule).
//
// Skipped automatically (not failed) if `ffmpeg`/`ffprobe` aren't on PATH —
// this module has no other dependency on them, so a missing binary shouldn't
// break an otherwise-green CI run; the pure `timelineExport.test.ts` suite
// still exercises the compiler's own logic either way.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildExportFfmpegArgs } from './timelineExport';
import { DEFAULT_FADE_CURVE, applyOp, eqResponseDb } from './timeline';
import type { Clip, EqBand, Timeline, Track } from './timeline';
import { eqFilterChain } from './timelineExportAudio';
import { pxToFadeFrames } from './clipFade';

function hasBinary(name: string): boolean {
  try {
    execFileSync(name, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const FFMPEG_AVAILABLE = hasBinary('ffmpeg') && hasBinary('ffprobe');

function clip(id: string, overrides: Partial<Clip> = {}): Clip {
  return {
    id,
    name: id,
    source_path: `/media/${id}.mov`,
    source_start: 0,
    duration: 48,
    source_len: 48,
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

function ffprobeDurationSecs(path: string): number {
  const out = execFileSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    path,
  ]).toString().trim();
  return Number(out);
}

/** Whether `path` has a real decodeable audio stream at all — `ffprobe`'s
 *  own, real answer, not an assumption. */
function hasAudioStream(path: string): boolean {
  const out = execFileSync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'a',
    '-show_entries', 'stream=codec_type',
    '-of', 'csv=p=0',
    path,
  ]).toString().trim();
  return out.includes('audio');
}

/** `ffmpeg -af volumedetect`'s own real `mean_volume`/`max_volume`, in dB —
 *  parsed from stderr (volumedetect writes to stderr, has no other output
 *  mode). `startSecs`/`durSecs` sub-segment the INPUT via `-ss`/`-t` first,
 *  so a caller can compare "the first second" against "the middle second"
 *  of one exported file without a second export. B-075/B-076 taught this
 *  session the hard way that a string match on the compiled argv proves
 *  nothing about whether the audio that landed in the file is actually
 *  right — this is the real, sample-level check those bugs needed. */
function volumeStats(path: string, startSecs?: number, durSecs?: number): { mean: number; max: number } {
  // NOT `-v error` — `volumedetect` logs its `mean_volume`/`max_volume`
  // lines at ffmpeg's INFO level, which `-v error` (used everywhere else in
  // this file, where only success/failure matters) silently swallows along
  // with everything this function actually needs to parse.
  const args: string[] = [];
  if (startSecs !== undefined) args.push('-ss', String(startSecs));
  if (durSecs !== undefined) args.push('-t', String(durSecs));
  args.push('-i', path, '-af', 'volumedetect', '-f', 'null', '-');
  // `volumedetect` writes exclusively to stderr — `spawnSync` (not
  // `execFileSync`) is what actually exposes it, since `execFileSync`'s
  // return value on success is stdout only.
  const res = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  const out = `${res.stderr ?? ''}${res.stdout ?? ''}`;
  const mean = /mean_volume:\s*(-?[\d.]+)\s*dB/.exec(out);
  const max = /max_volume:\s*(-?[\d.]+)\s*dB/.exec(out);
  if (!mean || !max) throw new Error(`volumedetect produced no readable output for ${path}:\n${out}`);
  return { mean: Number(mean[1]), max: Number(max[1]) };
}

/** [`volumeStats`] for ONE channel of a stereo file (D-223) — `pan=mono|c0=cN`
 *  extracts that channel alone, then the same `volumedetect` reads its real
 *  level. A pan's whole point is that the two channels differ, which a
 *  whole-file measurement literally cannot see: hard-left and "3dB quieter"
 *  produce the same `mean_volume`. Same `-ss`/`-t` sub-segmenting as
 *  `volumeStats`, so a keyframed pan's own SWEEP can be measured second by
 *  second in one exported file. */
function channelVolumeStats(
  path: string,
  channel: 0 | 1,
  startSecs?: number,
  durSecs?: number,
): { mean: number; max: number } {
  const args: string[] = [];
  if (startSecs !== undefined) args.push('-ss', String(startSecs));
  if (durSecs !== undefined) args.push('-t', String(durSecs));
  args.push('-i', path, '-af', `pan=mono|c0=c${channel},volumedetect`, '-f', 'null', '-');
  const res = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  const out = `${res.stderr ?? ''}${res.stdout ?? ''}`;
  const mean = /mean_volume:\s*(-?[\d.]+)\s*dB/.exec(out);
  const max = /max_volume:\s*(-?[\d.]+)\s*dB/.exec(out);
  if (!mean || !max) {
    throw new Error(`volumedetect produced no readable output for ${path} channel ${channel}:\n${out}`);
  }
  return { mean: Number(mean[1]), max: Number(max[1]) };
}

/** The real decoded RGB pixel at `(x, y)` at `timeSecs` into `path` — a
 *  1x1 `crop` to raw `rgb24`, read directly off stdout. B-090's own real
 *  proof: a string-matched filtergraph proves nothing about whether an
 *  overlay's PIXEL SIZE actually changed over time, only that the argv
 *  looked plausible — exactly how B-090 (a keyframed `scale` silently
 *  compiling to a static, unanimated resize) shipped invisibly under the
 *  existing keyframe test below, which only checked "ffmpeg didn't error". */
function pixelAt(path: string, timeSecs: number, x: number, y: number): [number, number, number] {
  // `crop=1:1:...` (a genuine 1x1 output) fails outright on this ffmpeg
  // build ("Invalid too big or non positive size for width '0' or height
  // '0'") — reproduced directly on the CLI, unrelated to this test's own
  // filtergraph; a 2x2 crop works, so this reads its own top-left pixel.
  const res = spawnSync(
    'ffmpeg',
    [
      '-ss', String(timeSecs), '-i', path,
      '-vf', `crop=2:2:${x}:${y}`,
      '-vframes', '1',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24',
      '-',
    ],
    { encoding: 'buffer', maxBuffer: 1024 * 1024 },
  );
  if (res.status !== 0 || res.stdout.length < 3) {
    throw new Error(`pixelAt(${path}, ${timeSecs}, ${x}, ${y}) produced no pixel: ${res.stderr?.toString()}`);
  }
  return [res.stdout[0], res.stdout[1], res.stdout[2]];
}

describe.skipIf(!FFMPEG_AVAILABLE)('buildExportFfmpegArgs — real ffmpeg execution', () => {
  let dir: string;
  // Two synthetic source clips at two DIFFERENT native frame rates — the
  // exact shape that exposed B-075 (24fps and 25fps, both different from
  // the 30fps export rate used below).
  let clip24: string;
  let clip25: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroma-export-test-'));
    clip24 = join(dir, 'src24.mp4');
    clip25 = join(dir, 'src25.mp4');
    execFileSync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'testsrc=duration=4:size=320x240:rate=24',
      '-pix_fmt', 'yuv420p', clip24,
    ]);
    execFileSync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'testsrc=duration=4:size=320x240:rate=25',
      '-pix_fmt', 'yuv420p', clip25,
    ]);
  }, 30000);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('B-075: a clip whose native fps differs from the export fps renders its REAL source duration, not a duration computed at the wrong rate', () => {
    // 96 source frames at 24fps = exactly 4s of real content. Exported at
    // 30fps, the pre-B-075 code would have computed -t = 96/30 = 3.2s
    // instead — a real, audible/visible truncation, not just a rounding
    // difference.
    const c = clip('c1', { source_path: clip24, source_fps: 24, duration: 96 });
    const tl = timeline([track('video', [c])]);
    const out = join(dir, 'out1.mp4');
    const args = buildExportFfmpegArgs(tl, out, { fps: 30, width: 320, height: 240 });

    execFileSync('ffmpeg', ['-y', ...args]);
    const durationSecs = ffprobeDurationSecs(out);

    expect(durationSecs).toBeGreaterThan(3.8); // ~4s real content
    expect(durationSecs).toBeLessThan(4.2);
  });

  it('B-075: two clips at two different native frame rates, stacked, both render for their own real duration in one export', () => {
    const after = clip('after', { source_path: clip24, source_fps: 24, duration: 96, position_y: 0 });
    const before = clip('before', { source_path: clip25, source_fps: 25, duration: 100, position_y: 0.5 }); // 100 frames @ 25fps = 4s
    const tl = timeline([track('video', [after]), track('video', [before])]);
    const out = join(dir, 'out2.mp4');
    const args = buildExportFfmpegArgs(tl, out, { fps: 30, width: 320, height: 480 });

    execFileSync('ffmpeg', ['-y', ...args]);
    const durationSecs = ffprobeDurationSecs(out);

    // The overall export should run for roughly the longer of the two real
    // clip durations (~4s each here), not something derived from dividing
    // either clip's frame count by the unrelated 30fps export rate.
    expect(durationSecs).toBeGreaterThan(3.8);
    expect(durationSecs).toBeLessThan(4.5);
  });

  it('B-075: a real ffmpeg run succeeds for a keyframed clip (the exact case the old unquoted x=/y= expression syntax error broke)', () => {
    const c = clip('c1', {
      source_path: clip24,
      source_fps: 24,
      duration: 96,
      scale: 1,
      chroma_keyframes: [
        { frame: 0, params: { scale: 1, position_x: 0, position_y: 0 } },
        { frame: 12, params: { scale: 1.2, position_x: -0.1, position_y: -0.1 } },
        { frame: 24, params: { scale: 1.2, position_x: -0.1, position_y: -0.1 } },
        { frame: 36, params: { scale: 1, position_x: 0, position_y: 0 } },
      ],
    });
    const tl = timeline([track('video', [c])]);
    const out = join(dir, 'out3.mp4');
    const args = buildExportFfmpegArgs(tl, out, { fps: 30, width: 320, height: 240 });

    // Must not throw — the pre-fix unquoted expression made ffmpeg reject
    // the whole filtergraph with a parse error and produce no output file
    // at all, regardless of any of the timing/duration math being right.
    expect(() => execFileSync('ffmpeg', ['-y', ...args], { stdio: 'pipe' })).not.toThrow();
    expect(ffprobeDurationSecs(out)).toBeGreaterThan(0);
  });

  it('D-188: a real ffmpeg run of a frozen (freezeOverrides) clip completes and produces the correct total duration — tpad\'s own syntax, for real', () => {
    // clip24 is 4s of real content; clip25 is also 4s. Freeze clip24 and
    // artificially treat clip25 as if it were longer by placing it starting
    // at t=2 — its own natural end (2 + 4 = 6s) becomes the real total, so
    // clip24 (frozen) must hold its last frame for 2 extra seconds.
    const shortFrozen = clip('short', { source_path: clip24, source_fps: 24, duration: 96, start_frame: 0 });
    const longer = clip('longer', {
      source_path: clip25, source_fps: 25, duration: 100, start_frame: 60, position_y: 0.5,
    }); // start_frame is a TIMELINE frame at opts.fps=30 -> starts at 2s, runs 4s -> ends at 6s
    const tl = timeline([track('video', [shortFrozen]), track('video', [longer])]);
    const out = join(dir, 'out4.mp4');
    const args = buildExportFfmpegArgs(tl, out, {
      fps: 30, width: 320, height: 480,
      freezeOverrides: { short: true },
    });

    expect(() => execFileSync('ffmpeg', ['-y', ...args], { stdio: 'pipe' })).not.toThrow();
    const durationSecs = ffprobeDurationSecs(out);
    expect(durationSecs).toBeGreaterThan(5.7); // ~6s total, not clip24's own natural 4s
    expect(durationSecs).toBeLessThan(6.3);
  });

  it("B-090: a keyframed `scale` actually resizes the overlay's real pixels over time, not just the (fixed-size) `x`/`y` position", () => {
    // A solid green 200x200 source, `fitOverrides: 'stretch'` so BOTH width
    // and height track the same animated scale expression (sidesteps the
    // default 'fit' mode's own aspect-ratio-preserving '-2', which this
    // test isn't about). Anchored at position (0,0) — no pan at all — so
    // the ONLY thing that can reveal or hide the far corner is `scale`
    // itself actually resizing the overlay, isolating this fix from any
    // position-interpolation logic (already covered by the keyframe test
    // above).
    const green = join(dir, 'green.mp4');
    execFileSync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'color=c=green:size=200x200:duration=2:rate=24',
      '-pix_fmt', 'yuv420p', green,
    ]);
    const c = clip('g1', {
      source_path: green,
      source_fps: 24,
      duration: 48,
      scale: 0.5,
      position_x: 0,
      position_y: 0,
      chroma_keyframes: [
        { frame: 0, params: { scale: 0.5 } },
        { frame: 12, params: { scale: 0.5 } },
        { frame: 24, params: { scale: 1 } },
        { frame: 47, params: { scale: 1 } },
      ],
    });
    const tl = timeline([track('video', [c])]);
    const out = join(dir, 'out-scale-kf.mp4');
    const args = buildExportFfmpegArgs(tl, out, {
      fps: 24, width: 200, height: 200,
      fitOverrides: { g1: 'stretch' },
    });

    execFileSync('ffmpeg', ['-y', ...args], { stdio: 'pipe' });

    // (180, 180) is inside the 200x200 canvas but OUTSIDE a 0.5-scaled
    // (100x100) overlay anchored at (0,0) — real background black, if
    // `scale` never actually resized anything (B-090's own bug: the overlay
    // was always sized from the clip's static base `scale`, here 0.5,
    // regardless of any keyframe). It IS inside the fully-zoomed (200x200)
    // overlay once `scale` reaches 1 and actually grows the box.
    const [rBefore, gBefore, bBefore] = pixelAt(out, 0.2, 180, 180);
    expect(rBefore + gBefore + bBefore).toBeLessThan(30); // real background black

    const [rAfter, gAfter, bAfter] = pixelAt(out, 1.2, 180, 180);
    expect(gAfter).toBeGreaterThan(100); // real green, not background black
    expect(rAfter).toBeLessThan(80);
    expect(bAfter).toBeLessThan(80);
  });

  it('B-095: a keyframed `opacity` actually fades the exported picture, not just the live preview', () => {
    // Full-canvas green, no crop/scale/position in play — isolates opacity
    // from every other transform. Ramped 1 -> 0 across the clip's own
    // 2-second span; sampled well inside each half so encoder blur near the
    // ramp's midpoint can't affect either reading.
    const green = join(dir, 'green.mp4');
    execFileSync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'color=c=green:size=200x200:duration=2:rate=24',
      '-pix_fmt', 'yuv420p', green,
    ]);
    const c = clip('op1', {
      source_path: green,
      source_fps: 24,
      duration: 48,
      chroma_keyframes: [
        { frame: 0, params: { opacity: 1 } },
        { frame: 47, params: { opacity: 0 } },
      ],
    });
    const tl = timeline([track('video', [c])]);
    const out = join(dir, 'out-opacity-kf.mp4');
    const args = buildExportFfmpegArgs(tl, out, { fps: 24, width: 200, height: 200 });

    execFileSync('ffmpeg', ['-y', ...args], { stdio: 'pipe' });

    // Against the exporter's own black base (`buildExportFfmpegArgs`'s
    // `color=black[base]`), near-full opacity should read as real green;
    // near-zero opacity should have faded almost entirely to that same
    // background black — the exact distinction B-095 found completely
    // absent (every clip exported fully, permanently opaque regardless of
    // this field, static or animated).
    const [, gEarly] = pixelAt(out, 0.05, 100, 100);
    expect(gEarly).toBeGreaterThan(100);

    const [rLate, gLate, bLate] = pixelAt(out, 1.9, 100, 100);
    expect(rLate + gLate + bLate).toBeLessThan(30);
  });

  it("B-095: a static `rotation` actually rotates the exported picture, not just the live preview", () => {
    // A blue marker in the TOP-LEFT quadrant of an otherwise green square —
    // asymmetric on both axes, so a rotation (as opposed to e.g. a mirror)
    // is the only transform that could move it. Empirically confirmed
    // (real ffmpeg, this exact `rotate=angle=...:fillcolor=black@0.0` shape)
    // that a +90 degree rotation moves a top-left marker to top-right —
    // asserted here, not assumed, matching this file's own founding
    // discipline of proving real pixels rather than trusting a plausible
    // argv string.
    const marked = join(dir, 'marked.mp4');
    execFileSync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'color=c=green:size=200x200:duration=1:rate=24',
      '-vf', 'drawbox=x=0:y=0:w=100:h=100:color=blue@1:t=fill',
      '-pix_fmt', 'yuv420p', marked,
    ]);
    const c = clip('rot1', {
      source_path: marked,
      source_fps: 24,
      duration: 24,
      rotation: 90,
    });
    const tl = timeline([track('video', [c])]);
    const out = join(dir, 'out-rotation.mp4');
    const args = buildExportFfmpegArgs(tl, out, { fps: 24, width: 200, height: 200 });

    execFileSync('ffmpeg', ['-y', ...args], { stdio: 'pipe' });

    const [, , bTopRight] = pixelAt(out, 0.2, 190, 10);
    expect(bTopRight).toBeGreaterThan(150); // the marker really moved here

    const [, gTopLeft] = pixelAt(out, 0.2, 10, 10);
    expect(gTopLeft).toBeGreaterThan(80); // and really left its original corner
  });

  it("B-095 (adjacent, picked up by the same fix): a VIDEO clip's own fade-in handle (D-207) now actually fades the PICTURE on export, not just its embedded audio", () => {
    // `resolve_clip_transform` (the live preview) already folds
    // `fade_multiplier_at` into `opacity` (D-147) — this repo's own "same
    // doc, same picture" bar means the export owes the identical
    // composition, not just the narrower opacity/rotation cases named in
    // B-095's own title. Before this fix there was no picture-opacity
    // filter step of any kind in this compiler, so a video clip's fade
    // handle (D-207 — real in the GUI, on every clip, video or audio) only
    // ever affected the exported clip's EMBEDDED AUDIO (D-147's own test
    // above), never what the frame actually looked like.
    const green = join(dir, 'green-fade.mp4');
    execFileSync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'color=c=green:size=200x200:duration=2:rate=24',
      '-pix_fmt', 'yuv420p', green,
    ]);
    const c = clip('fade1', {
      source_path: green,
      source_fps: 24,
      duration: 48,
      fade_in_frames: 24, // one full second of a two-second clip
    });
    const tl = timeline([track('video', [c])]);
    const out = join(dir, 'out-video-fade.mp4');
    const args = buildExportFfmpegArgs(tl, out, { fps: 24, width: 200, height: 200 });

    execFileSync('ffmpeg', ['-y', ...args], { stdio: 'pipe' });

    const [, gEarly] = pixelAt(out, 0.05, 100, 100);
    expect(gEarly).toBeLessThan(40); // still near-black, right at the fade's start

    const [, gLate] = pixelAt(out, 1.9, 100, 100);
    expect(gLate).toBeGreaterThan(100); // fully faded in, well past the 1s ramp
  });

  it('B-098: a keyframed `crop_left` actually animates the crop on export, not just the live preview', () => {
    // A blue marker in the leftmost quarter of an otherwise green frame.
    // `crop_left` 0 -> 0.3 across the clip: at 0 the marker is fully inside
    // the kept region and visible (scale: 1, no other transform, so the
    // whole box is exactly the source, unscaled); once `crop_left` passes
    // 0.25 the marker is entirely outside the kept region and the crop's own
    // remaining-region math takes over — asserted here as "the marker is
    // gone", not as a specific replacement colour, since exactly what
    // stretches into view depends only on the crop geometry, not this fix.
    const marked = join(dir, 'crop-marked.mp4');
    execFileSync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'color=c=green:size=200x200:duration=1:rate=24',
      '-vf', 'drawbox=x=0:y=0:w=50:h=200:color=blue@1:t=fill',
      '-pix_fmt', 'yuv420p', marked,
    ]);
    const c = clip('crop1', {
      source_path: marked,
      source_fps: 24,
      duration: 24,
      chroma_keyframes: [
        { frame: 0, params: { crop_left: 0 } },
        { frame: 23, params: { crop_left: 0.3 } },
      ],
    });
    const tl = timeline([track('video', [c])]);
    const out = join(dir, 'out-crop-kf.mp4');
    const args = buildExportFfmpegArgs(tl, out, { fps: 24, width: 200, height: 200 });

    execFileSync('ffmpeg', ['-y', ...args], { stdio: 'pipe' });

    const [, , bEarly] = pixelAt(out, 0.05, 10, 100);
    expect(bEarly).toBeGreaterThan(150); // marker visible, no crop yet

    const [, , bLate] = pixelAt(out, 0.9, 10, 100);
    expect(bLate).toBeLessThan(80); // cropped away by the keyframe's end
  });
});

// D-197 — real audio mixing: gain, fade, duck, and multi-source mix, each
// verified against ffprobe/`volumedetect`'s own real numbers, not just a
// plausible-looking argv string. Exactly the rigor B-075/B-076 taught this
// session string-only tests miss (this file's own header doc).
describe.skipIf(!FFMPEG_AVAILABLE)('buildExportFfmpegArgs — real audio mixing (D-197)', () => {
  let dir: string;
  let toneA: string; // 440Hz sine, 4s — a plain audio-track fixture
  let toneB: string; // 880Hz sine, 4s — a second, distinguishable source for mixing/duck tests
  let videoWithAudio: string; // testsrc + an embedded 440Hz tone, 4s

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroma-audio-export-test-'));
    toneA = join(dir, 'toneA.wav');
    toneB = join(dir, 'toneB.wav');
    videoWithAudio = join(dir, 'video_with_audio.mp4');
    execFileSync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4:sample_rate=48000',
      '-ac', '2', toneA,
    ]);
    execFileSync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=4:sample_rate=48000',
      '-ac', '2', toneB,
    ]);
    execFileSync('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=4:size=320x240:rate=24',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4:sample_rate=48000',
      '-pix_fmt', 'yuv420p', '-shortest', videoWithAudio,
    ]);
  }, 30000);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a plain audio-track clip really lands in the output file, at roughly its own real level and duration', () => {
    const a = clip('a1', { source_path: toneA, duration: 96, source_fps: 24 }); // 96/24 = 4s
    const tl = timeline([track('audio', [a])]);
    const out = join(dir, 'gain1.mp4');
    const args = buildExportFfmpegArgs(tl, out, { fps: 30, width: 320, height: 240 });

    execFileSync('ffmpeg', ['-y', ...args], { stdio: 'pipe' });
    expect(hasAudioStream(out)).toBe(true);
    expect(ffprobeDurationSecs(out)).toBeGreaterThan(3.8);

    const inputStats = volumeStats(toneA);
    const outStats = volumeStats(out);
    // Real, non-silent audio, at roughly the source's own level (allow a
    // couple dB of encoder/container slack — this is NOT a bit-exact codec
    // round-trip test).
    expect(outStats.mean).toBeGreaterThan(-90);
    expect(Math.abs(outStats.mean - inputStats.mean)).toBeLessThan(3);
  });

  it("D-057: track gain=0.5 measurably lowers the exported level by ~6.02dB (20*log10(0.5)) relative to gain=1", () => {
    const unity = clip('u', { source_path: toneA, duration: 96, source_fps: 24 });
    const halved = clip('h', { source_path: toneA, duration: 96, source_fps: 24 });
    const outUnity = join(dir, 'gain_unity.mp4');
    const outHalved = join(dir, 'gain_half.mp4');

    execFileSync('ffmpeg', [
      '-y',
      ...buildExportFfmpegArgs(timeline([track('audio', [unity], { gain: 1 })]), outUnity, { fps: 30, width: 320, height: 240 }),
    ], { stdio: 'pipe' });
    execFileSync('ffmpeg', [
      '-y',
      ...buildExportFfmpegArgs(timeline([track('audio', [halved], { gain: 0.5 })]), outHalved, { fps: 30, width: 320, height: 240 }),
    ], { stdio: 'pipe' });

    const unityDb = volumeStats(outUnity).mean;
    const halvedDb = volumeStats(outHalved).mean;
    const dropDb = unityDb - halvedDb;
    expect(dropDb).toBeGreaterThan(4.5);
    expect(dropDb).toBeLessThan(7.5); // ~6.02dB, real encoder/measurement slack allowed
  });

  it('D-147: a fade-in makes the first second of the export measurably quieter than the middle second', () => {
    const a = clip('a1', {
      source_path: toneA,
      duration: 96, // 4s @ 24fps
      source_fps: 24,
      fade_in_frames: 48, // 2s fade-in @ 24fps
    });
    const tl = timeline([track('audio', [a])]);
    const out = join(dir, 'fade.mp4');
    execFileSync('ffmpeg', ['-y', ...buildExportFfmpegArgs(tl, out, { fps: 30, width: 320, height: 240 })], { stdio: 'pipe' });

    const firstHalfSecond = volumeStats(out, 0, 0.5).mean; // deep in the ramp-up
    const middleSecond = volumeStats(out, 2.5, 0.5).mean; // well past the 2s fade window
    expect(middleSecond).toBeGreaterThan(firstHalfSecond + 4); // measurably louder once faded in
  });

  it('D-207: a fade set the way the TIMELINE HANDLE sets one really exports faded, both ends', () => {
    // Closes the last link in the on-clip fade handle's chain. The test above
    // hand-writes `fade_in_frames` onto a fixture; this one starts from a
    // pixel drag distance, converts it with `clipFade.ts`'s OWN
    // `pxToFadeFrames` (the exact function `ClipFadeOverlay` calls on
    // pointermove), and commits it through the SAME `set_clip_fade` op the
    // handle's pointer-up commits — then measures the real exported audio.
    // `TimelinePane.fade.dom.test.tsx` proves the drag produces this op; this
    // proves this op produces an audibly faded file. Neither half alone would
    // have caught a handle that only moved a picture around in local state.
    const PX_PER_SEC = 90; // DEFAULT_PX_PER_SEC
    const EXPORT_FPS = 24;
    const a = clip('a1', { source_path: toneA, duration: 96, source_fps: 24 }); // 4s @ 24fps
    const dragged = pxToFadeFrames({ source_fps: 24 }, 2 * PX_PER_SEC, EXPORT_FPS, PX_PER_SEC);
    expect(dragged).toBe(48); // a 180px drag == 2s == 48 source frames

    const faded = applyOp(timeline([track('audio', [a])]), {
      kind: 'set_clip_fade',
      track: 0,
      clip: 0,
      fade_in_frames: dragged,
      fade_out_frames: dragged,
      fade_in_curve: DEFAULT_FADE_CURVE,
      fade_out_curve: DEFAULT_FADE_CURVE,
    });
    // The op really stored what the drag computed — not silently clamped or
    // dropped on the way through.
    expect(faded.tracks[0].clips[0].fade_in_frames).toBe(48);
    expect(faded.tracks[0].clips[0].fade_out_frames).toBe(48);

    const out = join(dir, 'fade-handle.mp4');
    execFileSync('ffmpeg', ['-y', ...buildExportFfmpegArgs(faded, out, { fps: EXPORT_FPS, width: 320, height: 240 })], {
      stdio: 'pipe',
    });

    // With both windows at 2s on a 4s clip they meet exactly in the middle,
    // so the loudest point is the centre and both ends ramp away from it —
    // the real, measurable signature of a symmetric fade pair.
    const head = volumeStats(out, 0, 0.4).mean;
    const middle = volumeStats(out, 1.8, 0.4).mean;
    const tail = volumeStats(out, 3.6, 0.4).mean;
    expect(middle).toBeGreaterThan(head + 4);
    expect(middle).toBeGreaterThan(tail + 4);
  });

  it("D-149: a music bed measurably ducks under a dialogue track's own trigger clip, and recovers after it ends", () => {
    // Bed: a continuous 4s tone on track 0, ducked by track 1 (the trigger).
    const bed = clip('bed', { source_path: toneA, duration: 96, source_fps: 24 }); // 4s
    // Trigger: a real clip covering roughly the middle 1.5s of the bed.
    const trigger = clip('trig', {
      source_path: toneB,
      duration: 36, // 1.5s @ 24fps
      source_fps: 24,
      start_frame: Math.round(1.25 * 30), // ~1.25s in, at the 30fps export rate
    });
    const tl = timeline([
      track('audio', [bed], { duck_from: 1, duck_db: -18, duck_attack_ms: 10, duck_release_ms: 100 }),
      track('audio', [trigger], { gain: 0 }), // muted itself — isolates the BED's own ducked level in the mix
    ]);
    const out = join(dir, 'duck.mp4');
    execFileSync('ffmpeg', ['-y', ...buildExportFfmpegArgs(tl, out, { fps: 30, width: 320, height: 240 })], { stdio: 'pipe' });

    const beforeDuck = volumeStats(out, 0.2, 0.4).mean; // well before the trigger
    const duringDuck = volumeStats(out, 1.8, 0.4).mean; // solidly inside the trigger + past attack
    const afterRelease = volumeStats(out, 3.2, 0.4).mean; // well after the trigger ends + past release

    expect(beforeDuck - duringDuck).toBeGreaterThan(8); // measurably quieter while ducked
    expect(afterRelease).toBeGreaterThan(duringDuck + 8); // and recovers afterward
  });

  it('two audio-track clips both really land in the mixed output (amix + asoftclip), not just one surviving', () => {
    const a = clip('a1', { source_path: toneA, duration: 96, source_fps: 24 });
    const b = clip('a2', { source_path: toneB, duration: 96, source_fps: 24 });
    const tl = timeline([track('audio', [a]), track('audio', [b])]);
    const out = join(dir, 'mix.mp4');
    execFileSync('ffmpeg', ['-y', ...buildExportFfmpegArgs(tl, out, { fps: 30, width: 320, height: 240 })], { stdio: 'pipe' });

    expect(hasAudioStream(out)).toBe(true);
    const mixed = volumeStats(out).mean;
    const soloA = volumeStats(toneA).mean;
    // The mix must be real audio (not silence) and, with two real sources
    // summed, at least as loud as either alone (never quieter than a single
    // source, which is what ffmpeg's OWN default `amix` normalize=1 would
    // produce by dividing by the input count — exactly what `normalize=0`
    // in the compiled argv is there to avoid).
    expect(mixed).toBeGreaterThan(-90);
    expect(mixed).toBeGreaterThan(soloA - 3);
  });

  it("a video clip's embedded audio (hasAudioOverrides) really lands in the output, reusing the SAME input as the picture", () => {
    const v = clip('v1', { source_path: videoWithAudio, duration: 96, source_fps: 24 });
    const tl = timeline([track('video', [v])]);
    const out = join(dir, 'embedded.mp4');
    const args = buildExportFfmpegArgs(tl, out, { fps: 30, width: 320, height: 240, hasAudioOverrides: { v1: true } });

    expect(args.filter((a) => a === '-i')).toHaveLength(1); // no second input for the same file's audio
    execFileSync('ffmpeg', ['-y', ...args], { stdio: 'pipe' });

    expect(hasAudioStream(out)).toBe(true);
    expect(volumeStats(out).mean).toBeGreaterThan(-90);
  });

  it('without hasAudioOverrides, a video clip export stays silent (no audio stream at all) — the conservative default holds for real ffmpeg output too', () => {
    const v = clip('v1', { source_path: videoWithAudio, duration: 96, source_fps: 24 });
    const tl = timeline([track('video', [v])]);
    const out = join(dir, 'no_audio.mp4');
    execFileSync('ffmpeg', ['-y', ...buildExportFfmpegArgs(tl, out, { fps: 30, width: 320, height: 240 })], { stdio: 'pipe' });

    expect(hasAudioStream(out)).toBe(false);
  });

  // ---- D-223: per-clip volume + pan, measured per CHANNEL ---------------- //
  //
  // A pan is the first thing in this pipeline whose whole point is that the
  // two channels get DIFFERENT numbers, so a whole-file `volumedetect` (every
  // other audio test above) cannot see whether it worked at all: hard left and
  // "3dB quieter" look identical to it. These read each channel on its own.

  it('D-223: a static clip volume of 0.5 lowers the exported level by ~6.02dB, independently of the track gain', () => {
    const unity = clip('u', { source_path: toneA, duration: 96, source_fps: 24 });
    const halved = clip('h', { source_path: toneA, duration: 96, source_fps: 24, volume: 0.5 });
    const outUnity = join(dir, 'clipvol_unity.mp4');
    const outHalved = join(dir, 'clipvol_half.mp4');
    const opts = { fps: 30, width: 320, height: 240 };

    execFileSync('ffmpeg', ['-y', ...buildExportFfmpegArgs(timeline([track('audio', [unity])]), outUnity, opts)], { stdio: 'pipe' });
    execFileSync('ffmpeg', ['-y', ...buildExportFfmpegArgs(timeline([track('audio', [halved])]), outHalved, opts)], { stdio: 'pipe' });

    const dropDb = volumeStats(outUnity).mean - volumeStats(outHalved).mean;
    expect(dropDb).toBeGreaterThan(4.5);
    expect(dropDb).toBeLessThan(7.5); // ~6.02dB, real encoder/measurement slack
  });

  it('D-223: clip volume MULTIPLIES with track gain rather than replacing it (0.5 x 0.5 = ~12dB down)', () => {
    const unity = clip('u', { source_path: toneA, duration: 96, source_fps: 24 });
    const both = clip('b', { source_path: toneA, duration: 96, source_fps: 24, volume: 0.5 });
    const outUnity = join(dir, 'compose_unity.mp4');
    const outBoth = join(dir, 'compose_both.mp4');
    const opts = { fps: 30, width: 320, height: 240 };

    execFileSync('ffmpeg', ['-y', ...buildExportFfmpegArgs(timeline([track('audio', [unity], { gain: 1 })]), outUnity, opts)], { stdio: 'pipe' });
    execFileSync('ffmpeg', ['-y', ...buildExportFfmpegArgs(timeline([track('audio', [both], { gain: 0.5 })]), outBoth, opts)], { stdio: 'pipe' });

    const dropDb = volumeStats(outUnity).mean - volumeStats(outBoth).mean;
    // 20*log10(0.25) = -12.04dB. A path that let one override the other would
    // land at ~6dB, which this window excludes.
    expect(dropDb).toBeGreaterThan(10.5);
    expect(dropDb).toBeLessThan(13.5);
  });

  it('D-223: a hard-LEFT pan really silences the RIGHT channel and boosts the left — per-channel, not overall', () => {
    const panned = clip('p', { source_path: toneA, duration: 96, source_fps: 24, pan: -1 });
    const out = join(dir, 'pan_left.mp4');
    execFileSync('ffmpeg', ['-y', ...buildExportFfmpegArgs(timeline([track('audio', [panned])]), out, { fps: 30, width: 320, height: 240 })], { stdio: 'pipe' });

    const left = channelVolumeStats(out, 0).mean;
    const right = channelVolumeStats(out, 1).mean;
    const source = channelVolumeStats(toneA, 0).mean;

    // The right channel is gone — not "quieter", gone (a codec's own noise
    // floor is far below -60dB).
    expect(right).toBeLessThan(-60);
    // …and the left is BOOSTED by ~3.01dB (20*log10(sqrt(2))), which is the
    // measured, deliberate cost of this app's 0dB-centre constant-power law
    // (see `chroma_types::pan`). A law that merely turned the right channel
    // down would leave the left unchanged, which this window excludes.
    expect(left - source).toBeGreaterThan(2);
    expect(left - source).toBeLessThan(4);
  });

  it('D-223: a hard-RIGHT pan is the exact mirror image', () => {
    const panned = clip('p', { source_path: toneA, duration: 96, source_fps: 24, pan: 1 });
    const out = join(dir, 'pan_right.mp4');
    execFileSync('ffmpeg', ['-y', ...buildExportFfmpegArgs(timeline([track('audio', [panned])]), out, { fps: 30, width: 320, height: 240 })], { stdio: 'pipe' });

    expect(channelVolumeStats(out, 0).mean).toBeLessThan(-60);
    expect(channelVolumeStats(out, 1).mean).toBeGreaterThan(-30);
  });

  it('D-223: a centred clip really is untouched — both channels at the source level, no channel imbalance', () => {
    // The migration property, measured rather than argued: pan 0 must be the
    // exact identity, since every pre-D-223 clip carries it.
    const centred = clip('c', { source_path: toneA, duration: 96, source_fps: 24, pan: 0 });
    const out = join(dir, 'pan_centre.mp4');
    execFileSync('ffmpeg', ['-y', ...buildExportFfmpegArgs(timeline([track('audio', [centred])]), out, { fps: 30, width: 320, height: 240 })], { stdio: 'pipe' });

    const left = channelVolumeStats(out, 0).mean;
    const right = channelVolumeStats(out, 1).mean;
    expect(Math.abs(left - right)).toBeLessThan(0.5);
    expect(Math.abs(left - channelVolumeStats(toneA, 0).mean)).toBeLessThan(3);
  });

  it('D-223: a KEYFRAMED pan really sweeps left-to-right across the clip, measured second by second', () => {
    // The one that a string-matched argv could never prove: that the pan
    // MOVES. Hard left at the head, hard right at the tail, so the first
    // second is loud-left/silent-right and the last second is the reverse.
    const swept = clip('s', {
      source_path: toneA,
      duration: 96, // 4s @ 24fps
      source_fps: 24,
      chroma_keyframes: [
        { frame: 0, params: { pan: -1 } },
        { frame: 96, params: { pan: 1 } },
      ],
    });
    const out = join(dir, 'pan_sweep.mp4');
    execFileSync('ffmpeg', ['-y', ...buildExportFfmpegArgs(timeline([track('audio', [swept])]), out, { fps: 30, width: 320, height: 240 })], { stdio: 'pipe' });

    const headLeft = channelVolumeStats(out, 0, 0, 0.5).mean;
    const headRight = channelVolumeStats(out, 1, 0, 0.5).mean;
    const tailLeft = channelVolumeStats(out, 0, 3.4, 0.5).mean;
    const tailRight = channelVolumeStats(out, 1, 3.4, 0.5).mean;

    expect(headLeft - headRight).toBeGreaterThan(15); // starts hard left
    expect(tailRight - tailLeft).toBeGreaterThan(15); // ends hard right
  });

  it('D-223: a keyframed VOLUME really ramps the exported level over time', () => {
    const ramped = clip('r', {
      source_path: toneA,
      duration: 96,
      source_fps: 24,
      chroma_keyframes: [
        { frame: 0, params: { volume: 0 } },
        { frame: 96, params: { volume: 1 } },
      ],
    });
    const out = join(dir, 'vol_ramp.mp4');
    execFileSync('ffmpeg', ['-y', ...buildExportFfmpegArgs(timeline([track('audio', [ramped])]), out, { fps: 30, width: 320, height: 240 })], { stdio: 'pipe' });

    const head = volumeStats(out, 0, 0.5).mean;
    const tail = volumeStats(out, 3.4, 0.5).mean;
    expect(tail - head).toBeGreaterThan(10);
  });
});

// D-224 — per-clip parametric EQ. The proof this suite owes the feature is a
// real FREQUENCY RESPONSE, not "ffmpeg didn't error": an EQ compiled with a
// swapped coefficient, a wrong sign, or ffmpeg's own (measurably different)
// shelf parameterisation would still produce a perfectly valid file at a
// perfectly plausible overall level. So the numbers below are the SAME table
// `chroma_types::eq`'s own tests assert against the live mixer's cascade —
// measured here through real ffmpeg instead. If either engine drifts, one of
// the two fails.
describe.skipIf(!FFMPEG_AVAILABLE)('per-clip parametric EQ — real frequency response (D-224)', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroma-eq-export-test-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** The band set both engines measure — mirrors `chroma_types::eq::tests::
   *  reference_band_set` and `chroma_media::audio::tests::reference_eq_bands`
   *  exactly. One of each interesting kind, at deliberately awkward numbers
   *  (nothing at a default, nothing round) so an accidental identity or a
   *  swapped argument cannot pass, plus a DISABLED band loud enough (+18 dB)
   *  that an engine ignoring `enabled` would miss the table by a mile. */
  const REFERENCE_EQ_BANDS: EqBand[] = [
    { kind: 'high_pass', freq_hz: 90, gain_db: 0, q: 0.71, enabled: true },
    { kind: 'peak', freq_hz: 950, gain_db: -6.5, q: 1.8, enabled: true },
    { kind: 'high_shelf', freq_hz: 6200, gain_db: 5.5, q: 0.62, enabled: true },
    { kind: 'low_shelf', freq_hz: 400, gain_db: 18, q: 0.9, enabled: false },
  ];

  /** The exact same table `chroma_types::eq::tests::REFERENCE_RESPONSE_DB` and
   *  `chroma_media::audio::tests` carry. Three engines, one set of numbers. */
  const REFERENCE_RESPONSE_DB: Array<[number, number]> = [
    [50, -10.5923],
    [120, -1.1989],
    [300, -0.2824],
    [1000, -6.2239],
    [3000, 0.2774],
    [8000, 3.8671],
    [15000, 5.3278],
  ];

  /** The measured gain, in dB, that `chain` applies to a pure sine at `freqHz`
   *  — real ffmpeg, real samples.
   *
   *  Deliberately measured on the FILTER CHAIN rather than on a fully exported
   *  .mp4: the export's AAC encoder is psychoacoustic and rolls off near
   *  Nyquist, so a lossless measurement is the only way to assert a response
   *  to hundredths of a dB. That the chain really reaches a real export is the
   *  separate end-to-end test below; the two together are the whole proof. */
  function measuredResponseDb(chain: string, freqHz: number): number {
    const tone = `sine=frequency=${freqHz}:sample_rate=48000:duration=3`;
    const meanOf = (af: string): number => {
      const res = spawnSync('ffmpeg', ['-f', 'lavfi', '-i', tone, '-af', af, '-f', 'null', '-'], {
        encoding: 'utf8',
      });
      const out = `${res.stderr ?? ''}${res.stdout ?? ''}`;
      const mean = /mean_volume:\s*(-?[\d.]+)\s*dB/.exec(out);
      if (!mean) throw new Error(`volumedetect produced no readable output:\n${out}`);
      return Number(mean[1]);
    };
    // `atrim=start=1` on BOTH sides, so the filter's own start-up transient is
    // excluded and the two measurements cover the identical window.
    return meanOf(`${chain},atrim=start=1,volumedetect`) - meanOf('atrim=start=1,volumedetect');
  }

  it('the compiled chain measures the SAME response the live mixer does — the cross-engine bridge', () => {
    const chain = eqFilterChain(REFERENCE_EQ_BANDS);
    expect(chain).not.toBeNull();
    for (const [freq, expected] of REFERENCE_RESPONSE_DB) {
      const measured = measuredResponseDb(chain as string, freq);
      // 0.05 dB. Wide enough for `volumedetect`'s own quantisation, far too
      // narrow for the 0.25-0.37 dB ffmpeg's own `bass`/`treble` shelves would
      // land at — which is exactly the drift this window exists to catch.
      expect(Math.abs(measured - expected), `${freq} Hz measured ${measured}`).toBeLessThan(0.05);
      // …and the TS-side analytic prediction agrees with the measurement too,
      // so `eqResponseDb` (what a response-curve readout would draw) is pinned
      // to the real filter rather than only to the table.
      expect(Math.abs(eqResponseDb(REFERENCE_EQ_BANDS, freq) - measured)).toBeLessThan(0.05);
    }
  }, 60000);

  it('every band KIND measures its own textbook response through real ffmpeg', () => {
    // One probe per kind, at the frequency where that kind's answer is exactly
    // known: a bell IS its gain at centre, a shelf is HALF its gain at its
    // corner, a Butterworth pass filter is -3.01 dB at its corner.
    const cases: Array<{ band: EqBand; probe: number; expected: number }> = [
      { band: { kind: 'peak', freq_hz: 1000, gain_db: 6, q: 1, enabled: true }, probe: 1000, expected: 6 },
      { band: { kind: 'peak', freq_hz: 400, gain_db: -12, q: 3, enabled: true }, probe: 400, expected: -12 },
      {
        band: { kind: 'low_shelf', freq_hz: 200, gain_db: 8, q: Math.SQRT1_2, enabled: true },
        probe: 200,
        expected: 4,
      },
      {
        band: { kind: 'high_shelf', freq_hz: 4000, gain_db: -6, q: Math.SQRT1_2, enabled: true },
        probe: 4000,
        expected: -3,
      },
      {
        band: { kind: 'high_pass', freq_hz: 500, gain_db: 0, q: Math.SQRT1_2, enabled: true },
        probe: 500,
        expected: -3.0103,
      },
      {
        band: { kind: 'low_pass', freq_hz: 2000, gain_db: 0, q: Math.SQRT1_2, enabled: true },
        probe: 2000,
        expected: -3.0103,
      },
    ];
    for (const { band, probe, expected } of cases) {
      const chain = eqFilterChain([band]);
      expect(chain, `${band.kind} must compile a chain`).not.toBeNull();
      const measured = measuredResponseDb(chain as string, probe);
      expect(
        Math.abs(measured - expected),
        `${band.kind} at ${probe} Hz measured ${measured}`,
      ).toBeLessThan(0.05);
    }
  }, 60000);

  it('a clip with no EQ — and one carrying an untouched default strip — compiles NO filter at all', () => {
    // The byte-identical-when-unused contract, at the compiler rather than at
    // the mixer: materialising the Inspector's four-band strip must not change
    // a single argument of the export.
    expect(eqFilterChain(undefined)).toBeNull();
    expect(eqFilterChain([])).toBeNull();
    const untouchedStrip: EqBand[] = [
      { kind: 'low_shelf', freq_hz: 120, gain_db: 0, q: Math.SQRT1_2, enabled: true },
      { kind: 'peak', freq_hz: 500, gain_db: 0, q: 1, enabled: true },
      { kind: 'peak', freq_hz: 2500, gain_db: 0, q: 1, enabled: true },
      { kind: 'high_shelf', freq_hz: 8000, gain_db: 0, q: Math.SQRT1_2, enabled: true },
    ];
    expect(eqFilterChain(untouchedStrip)).toBeNull();
    // …and a disabled band contributes nothing even with a real gain on it.
    expect(eqFilterChain([{ kind: 'peak', freq_hz: 1000, gain_db: 12, q: 1, enabled: false }])).toBeNull();

    const plain = clip('p', { source_path: '/x.wav', duration: 96, source_fps: 24 });
    const stripped = clip('p', {
      source_path: '/x.wav',
      duration: 96,
      source_fps: 24,
      eq_bands: untouchedStrip,
    });
    const opts = { fps: 30, width: 320, height: 240 };
    expect(buildExportFfmpegArgs(timeline([track('audio', [stripped])]), '/out.mp4', opts)).toEqual(
      buildExportFfmpegArgs(timeline([track('audio', [plain])]), '/out.mp4', opts),
    );
  });

  it('the EQ really reaches a REAL exported file — a deep notch on the tone’s own frequency drops its level', () => {
    // End to end through `buildExportFfmpegArgs`, the encoder included. Not a
    // hundredths-of-a-dB assertion (AAC is not that kind of measurement) — it
    // is the half the lossless chain test above cannot make: that the chain is
    // wired into the real export at all, and onto the right stream.
    const tone = join(dir, 'tone1k.wav');
    execFileSync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=4:sample_rate=48000', '-ac', '2', tone,
    ]);
    const opts = { fps: 30, width: 320, height: 240 };

    const plain = clip('a', { source_path: tone, duration: 96, source_fps: 24 });
    const notched = clip('a', {
      source_path: tone,
      duration: 96,
      source_fps: 24,
      // A deep, narrow cut sitting exactly on the tone.
      eq_bands: [{ kind: 'peak', freq_hz: 1000, gain_db: -24, q: 2, enabled: true }],
    });
    const outPlain = join(dir, 'eq_plain.mp4');
    const outNotched = join(dir, 'eq_notched.mp4');
    execFileSync('ffmpeg', ['-y', ...buildExportFfmpegArgs(timeline([track('audio', [plain])]), outPlain, opts)], { stdio: 'pipe' });
    execFileSync('ffmpeg', ['-y', ...buildExportFfmpegArgs(timeline([track('audio', [notched])]), outNotched, opts)], { stdio: 'pipe' });

    const dropDb = volumeStats(outPlain).mean - volumeStats(outNotched).mean;
    // -24 dB requested; the encoder and the filter's own settling at the head
    // of the file cost a few, so this asserts the cut is real and deep rather
    // than its exact depth (the exact depth is the lossless test above).
    expect(dropDb).toBeGreaterThan(15);
  }, 60000);

  it('a high-pass really removes the LOW tone from a real export and leaves a high one alone', () => {
    // The single most common real move on a dialogue clip, checked as the
    // thing it actually is: rumble gone, voice untouched. Two tones, one band,
    // one exported file each — which a whole-file level check on ONE tone
    // could not tell apart from "everything got quieter".
    const low = join(dir, 'tone60.wav');
    const high = join(dir, 'tone2k.wav');
    execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=60:duration=4:sample_rate=48000', '-ac', '2', low]);
    execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=2000:duration=4:sample_rate=48000', '-ac', '2', high]);
    const hp: EqBand[] = [{ kind: 'high_pass', freq_hz: 250, gain_db: 0, q: Math.SQRT1_2, enabled: true }];
    const opts = { fps: 30, width: 320, height: 240 };

    const measure = (src: string, bands: EqBand[] | undefined, name: string): number => {
      const c = clip('c', {
        source_path: src,
        duration: 96,
        source_fps: 24,
        ...(bands ? { eq_bands: bands } : {}),
      });
      const out = join(dir, name);
      execFileSync('ffmpeg', ['-y', ...buildExportFfmpegArgs(timeline([track('audio', [c])]), out, opts)], { stdio: 'pipe' });
      return volumeStats(out).mean;
    };

    const lowDrop = measure(low, undefined, 'hp_low_off.mp4') - measure(low, hp, 'hp_low_on.mp4');
    const highDrop = measure(high, undefined, 'hp_high_off.mp4') - measure(high, hp, 'hp_high_on.mp4');
    // 60 Hz is more than two octaves under a 250 Hz 2-pole corner: ~-25 dB.
    expect(lowDrop).toBeGreaterThan(15);
    // 2 kHz is three octaves ABOVE it, and must be essentially untouched.
    expect(Math.abs(highDrop)).toBeLessThan(1.5);
  }, 90000);
});

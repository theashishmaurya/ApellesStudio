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
import type { Clip, Timeline, Track } from './timeline';

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
});

// @chroma/editor — REAL ffmpeg-execution proof that a SPEED RAMP (D-235)
// exports the exact source frames the live preview resolves.
//
// **Why this test is the point of the feature, not an afterthought.** This
// repo has shipped six separate preview/export divergences on animation data
// (B-090, B-094, B-095, B-098, B-103, B-108), and every one of them was
// invisible to a test that only read the generated filtergraph string. A speed
// ramp is that risk squared: it does not animate a visual property, it
// animates TIME ITSELF, so a wrong ramp still produces a perfectly valid,
// perfectly smooth, perfectly wrong video that no argv assertion and no
// eyeball would catch. The only honest check is to decode the real exported
// pixels and ask which SOURCE frame is on screen.
//
// **How the source frame is recovered from a pixel.** The fixture is a
// synthetic clip whose every frame is a distinct flat grey, `lum = 20 + 2*N`
// for source frame `N` — so brightness IS the frame number, read straight off
// one pixel, with no geometry or interpolation in between. Rather than
// assuming a colourspace or a level range, the test first measures the SOURCE
// file's own frames the same way and builds a real brightness->frame table
// from it, then looks the exported frame's brightness up in that table. Every
// YUV/RGB conversion, range and rounding artefact is therefore present
// identically on both sides and cancels.
//
// The `20 +` offset is load-bearing, and its absence was caught by this test's
// own first run: a plain `2*N` puts frames 0-8 at luma 0-16, i.e. at or below
// the limited-range black floor, where they all decode to RGB 0 and become
// INDISTINGUISHABLE. That produced a confident-looking "the export holds
// source frame 0 for 18 frames" failure that was entirely the fixture's fault
// — which is why `every source frame is distinguishable` below now checks all
// 96 frames rather than a hand-picked handful.
//
// **What is compared.** For a handful of output frames spread across a
// three-segment ramp (0.5x -> 2x -> 1.25x), the source frame actually decoded
// out of the export, against `clipSourceFrameAt` — the very function the Rust
// preview's `Clip::source_frame_at` mirrors and the compositor decodes with.
// Agreement here is agreement between the two renderers.
//
// The ramp is deliberately NOT symmetric and its segment boundaries are NOT
// at round output seconds, so an implementation that quietly fell back to a
// flat average speed, or that used the forward map where it needed the
// inverse, would disagree by many frames rather than one.
//
// Skipped automatically (not failed) when ffmpeg/ffprobe are absent, exactly
// as `timelineExport.ffmpeg.test.ts` does.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';

import { buildExportFfmpegArgs } from './timelineExport';
import { clipSourceFrameAt, endFrame, type Clip, type Timeline, type Track } from './timeline';
import type { SpeedPoint } from './speedRamp';

function hasBinary(name: string): boolean {
  try {
    execFileSync(name, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const FFMPEG_AVAILABLE = hasBinary('ffmpeg') && hasBinary('ffprobe');

const FPS = 24;
const FRAMES = 96; // 4s of source
const WIDTH = 160;
const HEIGHT = 120;

/** The ramp under test, in the clip's own SOURCE frames.
 *
 *  - source [0, 18)  at 0.5x  -> 36 output frames
 *  - source [18, 66) at 2.0x  -> 24 output frames
 *  - source [66, 96) at 1.25x -> 24 output frames
 *  -> 84 output frames (3.5s), from 96 source frames (4s). */
const POINTS: SpeedPoint[] = [
  { source_frame: 0, speed: 0.5 },
  { source_frame: 18, speed: 2 },
  { source_frame: 66, speed: 1.25 },
];

function rampedTimeline(sourcePath: string): Timeline {
  const c: Clip = {
    id: 'c1',
    name: 'c1',
    source_path: sourcePath,
    source_start: 0,
    duration: FRAMES,
    source_len: FRAMES,
    source_fps: FPS,
    start_frame: 0,
    opacity: 1,
    speed_points: POINTS,
  };
  const track: Track = { kind: 'video', clips: [c] };
  return { id: 'tl', name: 'tl', tracks: [track] };
}

/** Mean centre-pixel brightness of EVERY frame of `path`, in order — one
 *  sequential decode, no seeking.
 *
 *  Deliberately not a per-frame `-ss` seek: a seek lands on a timestamp and
 *  then decodes forward, which is both slow (one ffmpeg process per sample)
 *  and genuinely ambiguous at the very last frame of a file. Decoding the
 *  whole stream once and indexing the result BY FRAME NUMBER is what this test
 *  actually wants to talk about anyway — "the Nth frame of the export", not
 *  "whatever is on screen at 3.979 seconds".
 *
 *  A 2x2 `crop` rather than 1x1 — a genuine 1x1 crop fails on this ffmpeg
 *  build, exactly as `timelineExport.ffmpeg.test.ts` already documents — so
 *  each frame is 2*2*3 = 12 bytes of rgb24. */
const BYTES_PER_FRAME = 2 * 2 * 3;

function frameBrightnesses(path: string): number[] {
  const res = spawnSync(
    'ffmpeg',
    [
      '-i', path,
      '-vf', `crop=2:2:${WIDTH / 2}:${HEIGHT / 2}`,
      '-f', 'rawvideo', '-pix_fmt', 'rgb24',
      '-',
    ],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
  );
  if (res.status !== 0 || res.stdout.length < BYTES_PER_FRAME) {
    throw new Error(`no frames decoded from ${path}: ${res.stderr?.toString().slice(-600)}`);
  }
  const out: number[] = [];
  for (let off = 0; off + BYTES_PER_FRAME <= res.stdout.length; off += BYTES_PER_FRAME) {
    let sum = 0;
    for (let i = 0; i < BYTES_PER_FRAME; i++) sum += res.stdout[off + i];
    out.push(sum / BYTES_PER_FRAME);
  }
  return out;
}

describe.skipIf(!FFMPEG_AVAILABLE)('D-235 — a speed ramp exports the frames the preview resolves', () => {
  let dir: string;
  let srcPath: string;
  let outPath: string;
  /** Measured brightness of every SOURCE frame, index = frame number. Built
   *  from the source file itself so the lookup below cancels every colour
   *  conversion artefact rather than modelling it. */
  let sourceBrightness: number[] = [];
  /** Measured brightness of every EXPORTED frame, index = output frame. */
  let outputBrightness: number[] = [];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroma-speedramp-'));
    srcPath = join(dir, 'ramp-src.mkv');
    outPath = join(dir, 'ramp-out.mp4');

    // `geq`'s `N` is the frame index — each frame a distinct flat grey.
    // FFV1 (lossless, intra-only) so the grey that comes back out is the
    // grey that went in, and every frame is independently seekable.
    // `20 + 2*N` spans luma 20..210, entirely inside the limited range's
    // 16..235 — see the header note on why the offset is not cosmetic.
    execFileSync(
      'ffmpeg',
      [
        '-f', 'lavfi',
        '-i', `color=c=black:s=${WIDTH}x${HEIGHT}:r=${FPS}:d=${FRAMES / FPS}`,
        '-vf', `geq=lum='20+2*N':cb=128:cr=128`,
        '-c:v', 'ffv1', '-pix_fmt', 'yuv420p',
        '-y', srcPath,
      ],
      { stdio: 'ignore' },
    );

    sourceBrightness = frameBrightnesses(srcPath);

    const tl = rampedTimeline(srcPath);
    const args = buildExportFfmpegArgs(tl, outPath, { fps: FPS, width: WIDTH, height: HEIGHT });
    const res = spawnSync('ffmpeg', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (res.status !== 0) {
      throw new Error(`export failed: ${res.stderr?.slice(-3000)}`);
    }
    outputBrightness = frameBrightnesses(outPath);
  }, 180_000);

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** The source frame whose measured brightness is closest to `b`. */
  function nearestSourceFrame(b: number): number {
    let best = 0;
    let bestDist = Infinity;
    for (let n = 0; n < sourceBrightness.length; n++) {
      const d = Math.abs(sourceBrightness[n] - b);
      if (d < bestDist) {
        bestDist = d;
        best = n;
      }
    }
    return best;
  }

  it('every source frame is distinguishable — the whole method rests on it', () => {
    // Guards everything below: if two source frames decoded to the same
    // brightness, `nearestSourceFrame` would silently return the lower of them
    // and the parity assertions would report a divergence that is purely this
    // fixture's own. An earlier revision checked seven hand-picked frames and
    // missed exactly that (frames 0-8 crushed to black), so this checks ALL of
    // them, and separately that consecutive frames are really separated.
    expect(sourceBrightness.length).toBe(FRAMES);
    for (let n = 0; n < FRAMES; n++) {
      expect(nearestSourceFrame(sourceBrightness[n])).toBe(n);
    }
    for (let n = 1; n < FRAMES; n++) {
      expect(sourceBrightness[n] - sourceBrightness[n - 1]).toBeGreaterThan(0.5);
    }
  });

  it('the ramped clip occupies the retimed length in the file, not its source length', () => {
    const tl = rampedTimeline(srcPath);
    // 36 + 24 + 24 = 84 output frames = 3.5s, NOT the source's own 4s.
    expect(endFrame(tl.tracks[0].clips[0], FPS)).toBe(84);
    const probed = execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', outPath],
      { encoding: 'utf8' },
    ).trim();
    expect(Number(probed)).toBeGreaterThan(3.3);
    expect(Number(probed)).toBeLessThan(3.7);
  });

  it('every sampled output frame decodes the SOURCE frame the preview resolves', () => {
    const clip = rampedTimeline(srcPath).tracks[0].clips[0];
    // Spread across all three segments, including both boundaries and the
    // frames either side of them — a ramp that got its knots wrong is
    // wrongest exactly there.
    const outputFrames = [0, 8, 20, 35, 36, 37, 48, 59, 60, 61, 72, 83];

    const mismatches: string[] = [];
    for (const f of outputFrames) {
      const expected = clipSourceFrameAt(clip, f, FPS);
      const measured = nearestSourceFrame(outputBrightness[f]);
      // ±1 source frame of tolerance, and no more: the export re-encodes with
      // x264 and both sides seek by timestamp, so a single frame of boundary
      // rounding is legitimate — while ANY of the ways this could actually be
      // wrong (a flat average speed, the forward map used as the inverse, a
      // dropped segment, `round` instead of `floor`) is off by many frames at
      // one or more of these positions. The slow head alone spans 18 source
      // frames over 36 output ones; a flat 96/84 fallback would already be 10
      // frames out by output frame 20.
      if (Math.abs(measured - expected) > 1) {
        mismatches.push(`output ${f}: preview says source ${expected}, file shows ${measured}`);
      }
    }
    expect(mismatches).toEqual([]);
  }, 120_000);

  it('the retime is monotone — a ramp never plays a source frame twice out of order', () => {
    // A cheap but genuinely load-bearing invariant: a non-monotone remap is
    // what a sign error or a mis-sorted segment list produces, and it looks
    // like a stutter rather than an obvious failure.
    let prev = -1;
    for (let f = 0; f < 84; f += 4) {
      const measured = nearestSourceFrame(outputBrightness[f]);
      expect(measured).toBeGreaterThanOrEqual(prev - 1);
      prev = measured;
    }
  }, 120_000);
});

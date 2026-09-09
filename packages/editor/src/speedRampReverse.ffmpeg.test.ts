// @apelles/editor — REAL ffmpeg-execution proof that REVERSE speed (D-241)
// exports the exact source frames, in the exact order, the live preview
// resolves.
//
// **Why this test and not an argv assertion.** Same argument as
// `speedRamp.ffmpeg.test.ts`, which this deliberately mirrors: a wrong retime
// produces a perfectly valid, perfectly smooth, perfectly wrong video. Reverse
// adds a failure mode that is *specifically* invisible to a filtergraph
// string — `setpts` with a negative slope emits a filtergraph that ffmpeg
// accepts and runs, and simply does not reverse anything, because `setpts`
// relabels timestamps on frames the decoder already handed over in forward
// order. The ONLY way to know reverse works is to decode the file and read
// which frame is on screen. That is what this does.
//
// **Method** (identical to the D-236 test, deliberately — same fixture, same
// brightness->frame table, so the two are directly comparable): the source is
// a synthetic clip whose frame `N` is a flat grey at `lum = 20 + 2*N`, the
// test measures the SOURCE file's own frames to build a real brightness table,
// then looks each exported frame's brightness up in it. Every colour
// conversion artefact is present on both sides and cancels.
//
// **What is asserted.**
//  1. A wholly reversed clip decodes source frame `FRAMES-1-f` at output frame
//     `f` — i.e. it really does run backwards, first frame last.
//  2. A MIXED ramp (forward -> reversed -> forward) agrees frame for frame
//     with `clipSourceFrameAt`, the function the Rust preview mirrors. This is
//     what proves the sign-aware `anchor`, the `ceil-1` quantisation and the
//     per-run `trim`/`reverse`/`concat` block all agree.
//  3. Reversing does not change the clip's LENGTH — `-1` and `1` occupy the
//     same output, which is the invariant that lets a sign flip never move a
//     neighbour.
//  4. A negative control: the same output compared against the UN-reversed
//     expectation diverges by many frames, so the test discriminates rather
//     than passing on tolerance.
//
// Skipped automatically (not failed) when ffmpeg/ffprobe are absent.
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
const BYTES_PER_FRAME = 2 * 2 * 3;

/** A MIXED ramp, in the clip's own SOURCE frames — the case that exercises
 *  every part of the new code at once:
 *
 *  - source [0, 24)  at  1.0x -> 24 output frames, forwards
 *  - source [24, 72) at -2.0x -> 24 output frames, BACKWARDS at double speed
 *  - source [72, 96) at  1.0x -> 24 output frames, forwards
 *  -> 72 output frames (3s) from 96 source frames (4s).
 *
 *  Deliberately not symmetric about the reversed run and deliberately mixing
 *  a reversed run with forward ones: a compiler that reversed the WHOLE clip,
 *  or that got the `concat` order wrong, or that used the run's start rather
 *  than its end as the reversed anchor, disagrees by tens of frames here while
 *  still producing a plausible-looking video. */
const MIXED: SpeedPoint[] = [
  { source_frame: 0, speed: 1 },
  { source_frame: 24, speed: -2 },
  { source_frame: 72, speed: 1 },
];

/** The simple case: play the whole clip backwards at its recorded rate. */
const WHOLLY_REVERSED: SpeedPoint[] = [{ source_frame: 0, speed: -1 }];

function timelineWith(sourcePath: string, points: SpeedPoint[]): Timeline {
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
    speed_points: points,
  };
  const track: Track = { kind: 'video', clips: [c] };
  return { id: 'tl', name: 'tl', tracks: [track] };
}

/** Mean centre-pixel brightness of EVERY frame of `path`, in order — one
 *  sequential decode, no seeking. See `speedRamp.ffmpeg.test.ts` for why this
 *  is a whole-stream decode indexed by frame number rather than per-frame
 *  seeks, and why the crop is 2x2 rather than 1x1. */
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

function exportTimeline(tl: Timeline, outPath: string): void {
  const args = buildExportFfmpegArgs(tl, outPath, { fps: FPS, width: WIDTH, height: HEIGHT });
  const res = spawnSync('ffmpeg', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (res.status !== 0) {
    throw new Error(`export failed: ${res.stderr?.slice(-3000)}`);
  }
}

describe.skipIf(!FFMPEG_AVAILABLE)('D-241 — reverse speed exports the frames the preview resolves', () => {
  let dir: string;
  let srcPath: string;
  let sourceBrightness: number[] = [];
  let reversedOut: number[] = [];
  let mixedOut: number[] = [];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroma-speedreverse-'));
    srcPath = join(dir, 'rev-src.mkv');

    // Same fixture as the D-236 test: `geq`'s `N` is the frame index, FFV1 so
    // the grey that goes in comes back out, `20 +` so no frame lands on or
    // below the limited-range black floor where they become indistinguishable.
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

    const revPath = join(dir, 'rev-out.mp4');
    exportTimeline(timelineWith(srcPath, WHOLLY_REVERSED), revPath);
    reversedOut = frameBrightnesses(revPath);

    const mixedPath = join(dir, 'mixed-out.mp4');
    exportTimeline(timelineWith(srcPath, MIXED), mixedPath);
    mixedOut = frameBrightnesses(mixedPath);
  }, 300_000);

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
    expect(sourceBrightness.length).toBe(FRAMES);
    for (let n = 0; n < FRAMES; n++) {
      expect(nearestSourceFrame(sourceBrightness[n])).toBe(n);
    }
  });

  it('a wholly reversed clip really runs backwards: output f shows source FRAMES-1-f', () => {
    // The headline claim, checked against arithmetic simple enough to state in
    // the assertion itself rather than against our own model — so this cannot
    // pass by the model and the export being wrong in the same way.
    expect(reversedOut.length).toBeGreaterThanOrEqual(FRAMES - 1);
    const mismatches: string[] = [];
    for (const f of [0, 1, 12, 24, 47, 48, 60, 84, 94, 95]) {
      const measured = nearestSourceFrame(reversedOut[f]);
      const expected = FRAMES - 1 - f;
      if (Math.abs(measured - expected) > 1) {
        mismatches.push(`output ${f}: expected source ${expected}, file shows ${measured}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('...and the preview resolves exactly that too — the two renderers agree', () => {
    const clip = timelineWith(srcPath, WHOLLY_REVERSED).tracks[0].clips[0];
    const mismatches: string[] = [];
    for (const f of [0, 1, 12, 24, 47, 48, 60, 84, 94, 95]) {
      const expected = clipSourceFrameAt(clip, f, FPS);
      const measured = nearestSourceFrame(reversedOut[f]);
      if (Math.abs(measured - expected) > 1) {
        mismatches.push(`output ${f}: preview says source ${expected}, file shows ${measured}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('the NEGATIVE CONTROL: reading the export as if it were forward diverges hugely', () => {
    // Without this, "within ±1" proves nothing — a test that tolerates one
    // frame has to show it would notice a real error. Comparing the reversed
    // export against the FORWARD expectation must be wrong by tens of frames.
    let worst = 0;
    for (const f of [0, 12, 24, 48, 84, 95]) {
      worst = Math.max(worst, Math.abs(nearestSourceFrame(reversedOut[f]) - f));
    }
    expect(worst).toBeGreaterThan(40);
  });

  it('a MIXED forward/reverse/forward ramp agrees with the preview frame for frame', () => {
    const clip = timelineWith(srcPath, MIXED).tracks[0].clips[0];
    // Spread across all three runs, including both boundaries and the frames
    // either side of them — a sign or anchor error is wrongest exactly there.
    const outputFrames = [0, 5, 12, 23, 24, 25, 30, 36, 42, 47, 48, 49, 55, 64, 71];
    const mismatches: string[] = [];
    for (const f of outputFrames) {
      const expected = clipSourceFrameAt(clip, f, FPS);
      const measured = nearestSourceFrame(mixedOut[f]);
      if (Math.abs(measured - expected) > 1) {
        mismatches.push(`output ${f}: preview says source ${expected}, file shows ${measured}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('the reversed middle run really descends — it is not the forward run relabelled', () => {
    // The specific failure `setpts` with a negative slope produces: a file
    // that is the right LENGTH and has the right frames at the seams, but
    // whose middle run still counts upward. Read the run's own frames in
    // order and require them to strictly descend.
    const seen = [26, 30, 34, 38, 42, 46].map((f) => nearestSourceFrame(mixedOut[f]));
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).toBeLessThan(seen[i - 1]);
    }
  });

  it('emits the intended filtergraph shape, not an accidentally-working one', () => {
    // A shape assertion ON TOP of the pixel proof above, not instead of it:
    // the pixels say the file is right, this says it is right for the reason
    // intended — one `trim`+`reverse` branch per reversed run, forward runs
    // with no `reverse` node at all, and the whole thing rejoined by `concat`.
    // It is also what would catch a future refactor quietly reintroducing a
    // negative `setpts` slope, which the pixel test would catch only by
    // running ffmpeg.
    const whole = buildExportFfmpegArgs(timelineWith(srcPath, WHOLLY_REVERSED), 'o.mp4', {
      fps: FPS, width: WIDTH, height: HEIGHT,
    });
    const wholeGraph = whole[whole.indexOf('-filter_complex') + 1];
    // One run: no `split`, no `concat` — there is nothing to rejoin.
    expect(wholeGraph).toContain('trim=start=0:end=4,reverse,setpts=PTS-STARTPTS');
    expect(wholeGraph).not.toContain('concat=n=1');
    // ...and emphatically NOT a negative slope, the thing that silently does
    // nothing.
    expect(wholeGraph).not.toMatch(/setpts=PTS\/-/);

    const mixed = buildExportFfmpegArgs(timelineWith(srcPath, MIXED), 'o.mp4', {
      fps: FPS, width: WIDTH, height: HEIGHT,
    });
    const mixedGraph = mixed[mixed.indexOf('-filter_complex') + 1];
    expect(mixedGraph).toContain('split=3');
    expect(mixedGraph).toContain('trim=start=1:end=3,reverse,setpts=(PTS-STARTPTS)/2');
    expect(mixedGraph).toContain('concat=n=3:v=1:a=0');
    // The two FORWARD runs carry no `reverse` node — the buffering cost is
    // paid only where it is actually needed.
    expect(mixedGraph).toContain('trim=start=0:end=1,setpts=PTS-STARTPTS');
    expect(mixedGraph).toContain('trim=start=3:end=4,setpts=PTS-STARTPTS');
    expect((mixedGraph.match(/,reverse,/g) ?? []).length).toBe(1);
  });

  it('reversing changes DIRECTION, not LENGTH — -1x and 1x occupy the same output', () => {
    const reversed = timelineWith(srcPath, WHOLLY_REVERSED).tracks[0].clips[0];
    const forward = timelineWith(srcPath, [{ source_frame: 0, speed: 1 }]).tracks[0].clips[0];
    expect(endFrame(reversed, FPS)).toBe(endFrame(forward, FPS));
    // ...and the mixed ramp's own arithmetic: 24 + 48/2 + 24 = 72.
    expect(endFrame(timelineWith(srcPath, MIXED).tracks[0].clips[0], FPS)).toBe(72);
  });
});

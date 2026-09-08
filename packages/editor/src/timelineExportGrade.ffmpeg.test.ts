// @chroma/editor — REAL ffmpeg-execution pixel tests for D-256's Colorist
// grade in the Edit-tab export.
//
// Its own file, mirroring `timelineExportAdjustment.ffmpeg.test.ts`'s
// precedent, and with the same fixture reasoning: a SOLID-COLOUR source,
// because "what colour is actually on the screen" is unanswerable against a
// moving pattern.
//
// **Why pixels and not argv.** A grade that silently fails to apply produces a
// completely valid video file of exactly the right length showing exactly the
// right clips — simply ungraded. That is invisible to any string match, and it
// is the precise failure D-256 exists to prevent (the Edit preview showing a
// grade the exported file does not have). Two traps here that argv-matching
// would miss outright:
//   - `lut3d` spliced at the wrong point in the chain grades a resampled or
//     cropped picture rather than the clip's own pixels;
//   - a `.cube` whose path is not escaped for the filtergraph makes ffmpeg fail
//     or, worse, parse a truncated path and skip the filter.
//
// **The lattice here is written by hand, deliberately.** The real one is baked
// by the Colorist's wgpu shader (`chroma::grade_lut`), which no frontend test
// can or should run; what THIS file has to prove is the other half — that a
// lattice handed to the compiler reaches the exported pixels intact and in the
// right place. A perfectly LINEAR transform is used so the expected output is
// exact arithmetic rather than an interpolation approximation, which keeps the
// assertion about plumbing rather than about `lut3d`'s numerics.
//
// **This file is one half of a matched pair**, exactly as the adjustment-clip
// suite is: the other half is `grade_bridge_tests` in
// `app/src-tauri/src/chroma/edit.rs`, which asserts the same lattice against
// the live CPU compositor. Together they are what make "the Edit preview
// matches the Edit export" a checked claim rather than an assertion.
//
// Skipped automatically (not failed) if `ffmpeg`/`ffprobe` aren't on PATH, same
// as the sibling ffmpeg suites.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildExportFfmpegArgs } from './timelineExport';
import type { Clip, Timeline } from './timeline';

function hasBinary(name: string): boolean {
  try {
    execFileSync(name, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const FFMPEG_AVAILABLE = hasBinary('ffmpeg') && hasBinary('ffprobe');

const W = 320;
const H = 240;
const FPS = 24;

/** Three DIFFERENT channel values on purpose, so a transform that rebalances
 *  channels shows up as a change in their relationship, not only in
 *  brightness. */
const SRC_RGB: [number, number, number] = [0xc0, 0x80, 0x40];

/**
 * A `size³` `.cube` applying `fn` per channel, written red-fastest — byte-for-
 * byte the layout `chroma_types::Lut3d::to_cube_text` produces, so this fixture
 * exercises the same file shape the real baker emits.
 */
function writeCube(path: string, size: number, fn: (rgb: [number, number, number]) => [number, number, number]) {
  const lines = [`TITLE "test"`, `LUT_3D_SIZE ${size}`, 'DOMAIN_MIN 0.0 0.0 0.0', 'DOMAIN_MAX 1.0 1.0 1.0'];
  const d = size - 1;
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const out = fn([r / d, g / d, b / d]);
        lines.push(out.map((v) => Math.min(1, Math.max(0, v)).toFixed(6)).join(' '));
      }
    }
  }
  writeFileSync(path, `${lines.join('\n')}\n`);
}

/** The real decoded RGB pixel at `(x, y)` at `timeSecs` into `path` — the same
 *  helper (and the same 2x2 crop, since a genuine 1x1 `crop` fails outright on
 *  this ffmpeg build) the sibling ffmpeg suites use. */
function pixelAt(path: string, timeSecs: number, x = W / 2, y = H / 2): [number, number, number] {
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
    throw new Error(`pixelAt(${path}, ${timeSecs}) produced no pixel: ${res.stderr?.toString()}`);
  }
  return [res.stdout[0], res.stdout[1], res.stdout[2]];
}

/** A real h264/yuv420p round trip moves a flat colour by a few codes, and the
 *  RGB→YUV→RGB conversions `lut3d` forces add a few more. ±14 — the sibling
 *  adjustment suite's own tolerance, far tighter than the 60–100 code moves
 *  every assertion here distinguishes. */
const TOL = 14;

function expectNear(actual: number, expected: number, what: string) {
  expect(Math.abs(actual - expected), `${what}: got ${actual}, expected ~${expected}`).toBeLessThanOrEqual(TOL);
}

describe.skipIf(!FFMPEG_AVAILABLE)('D-256 Colorist grade in the Edit export — real ffmpeg pixels', () => {
  let dir: string;
  let src: string;
  let halveRed: string;
  let swapRB: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroma-grade-test-'));
    src = join(dir, 'src.mp4');
    const hex = SRC_RGB.map((c) => c.toString(16).padStart(2, '0')).join('');
    execFileSync('ffmpeg', [
      '-y', '-f', 'lavfi',
      '-i', `color=c=0x${hex}:size=${W}x${H}:rate=${FPS}:d=4`,
      '-pix_fmt', 'yuv420p', src,
    ]);
    // Both transforms are exactly linear, so trilinear interpolation reproduces
    // them with zero error and the expected pixel is plain arithmetic.
    halveRed = join(dir, 'halve-red.cube');
    writeCube(halveRed, 33, ([r, g, b]) => [r * 0.5, g, b]);
    swapRB = join(dir, 'swap-rb.cube');
    writeCube(swapRB, 33, ([r, g, b]) => [b, g, r]);
  }, 120000);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function mediaClip(id = 'PIC'): Clip {
    return {
      id,
      name: id,
      source_path: src,
      source_fps: FPS,
      source_start: 0,
      duration: 96,
      source_len: 96,
      start_frame: 0,
    } as unknown as Clip;
  }

  function timelineOf(clips: Clip[]): Timeline {
    return {
      id: 'tl',
      name: 'tl',
      tracks: [{ kind: 'video' as const, clips }],
    } as unknown as Timeline;
  }

  function render(tl: Timeline, name: string, gradeLutPaths?: Record<string, string>): string {
    const out = join(dir, `${name}.mp4`);
    const args = buildExportFfmpegArgs(tl, out, { fps: FPS, width: W, height: H, gradeLutPaths });
    const res = spawnSync('ffmpeg', ['-y', ...args], { encoding: 'utf8' });
    if (res.status !== 0) {
      throw new Error(`ffmpeg failed for ${name}:\n${res.stderr}\nargs: ${args.join(' ')}`);
    }
    return out;
  }

  // The control. Without it every assertion below would also pass on a build
  // that never grades anything — "the source colour" is what an export with no
  // grade produces too.
  it('control: with no grade the source colour comes through unchanged', () => {
    const out = render(timelineOf([mediaClip()]), 'control');
    const px = pixelAt(out, 12 / FPS);
    expectNear(px[0], SRC_RGB[0], 'R');
    expectNear(px[1], SRC_RGB[1], 'G');
    expectNear(px[2], SRC_RGB[2], 'B');
  });

  it("a clip's baked grade really reaches the exported pixels", () => {
    const out = render(timelineOf([mediaClip()]), 'graded', { PIC: halveRed });
    const px = pixelAt(out, 12 / FPS);
    expectNear(px[0], SRC_RGB[0] / 2, 'R must be halved by the LUT');
    expectNear(px[1], SRC_RGB[1], 'G must be untouched');
    expectNear(px[2], SRC_RGB[2], 'B must be untouched');
  });

  it('a channel swap survives the whole chain, proving the LUT is not partially applied', () => {
    const out = render(timelineOf([mediaClip()]), 'swapped', { PIC: swapRB });
    const px = pixelAt(out, 12 / FPS);
    expectNear(px[0], SRC_RGB[2], 'R must now be the source B');
    expectNear(px[1], SRC_RGB[1], 'G unchanged');
    expectNear(px[2], SRC_RGB[0], 'B must now be the source R');
  });

  // The per-clip claim, which is the whole point of keying by `Clip.id`: two
  // clips of the SAME source file, one graded and one not, must differ.
  it('a grade applies per clip, not per source file', () => {
    const a = mediaClip('A');
    const b = { ...mediaClip('B'), duration: 48, start_frame: 48 } as Clip;
    const first = { ...a, duration: 48, start_frame: 0 } as Clip;
    const out = render(timelineOf([first, b]), 'per-clip', { A: halveRed });

    const graded = pixelAt(out, 12 / FPS);
    expectNear(graded[0], SRC_RGB[0] / 2, 'clip A is graded');
    const ungraded = pixelAt(out, 60 / FPS);
    expectNear(ungraded[0], SRC_RGB[0], 'clip B, same source file, is NOT graded');
  });

  // A path with a space and a colon is exactly what breaks an unescaped
  // filtergraph value — and a `.chroma` project can easily live under one.
  it('a .cube path needing filtergraph escaping still applies', () => {
    const awkward = join(dir, 'my grade: v2.cube');
    writeCube(awkward, 33, ([r, g, b]) => [r * 0.5, g, b]);
    const out = render(timelineOf([mediaClip()]), 'awkward-path', { PIC: awkward });
    const px = pixelAt(out, 12 / FPS);
    expectNear(px[0], SRC_RGB[0] / 2, 'R must be halved despite the awkward path');
  });
});

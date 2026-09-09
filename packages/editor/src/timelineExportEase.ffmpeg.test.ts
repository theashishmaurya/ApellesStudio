// @apelles/editor — REAL ffmpeg-execution proof that an EASED keyframe segment
// (D-233) exports the shape the live preview resolves.
//
// Why this exists as a real-pixel test rather than another argv assertion:
// this repo has shipped four separate preview/export divergences on animation
// data (B-090, B-094, B-095, B-098), and every one of them was invisible to a
// test that only read the generated filtergraph string. B-090 in particular
// was a keyframed `scale` that compiled to a plausible-looking argv and then
// silently did not animate at all. Easing is exactly the same shape of risk,
// one level deeper: the `ease` map has to survive the model, the re-base, the
// expression compiler and ffmpeg itself, and if it is dropped anywhere along
// that path the export is still a perfectly valid, perfectly wrong LINEAR
// animation that no string match would notice.
//
// So this measures real decoded PIXELS out of a real exported file and
// compares them against `easeCurveEval` — the exact TS mirror of
// `apelles_types::EaseCurve::eval` that the Rust preview evaluates per frame.
// Agreement here is agreement between the two renderers.
//
// The subject is a keyframed OPACITY on a white clip over the export canvas:
// opacity is the one animated property whose value a single pixel reads
// directly (brightness IS the multiplier), so no geometry inference stands
// between the measurement and the number under test. Values are normalised
// against the clip's own fully-opaque frame, which cancels the codec's
// range/rounding rather than assuming a particular white level.
//
// Skipped automatically (not failed) when ffmpeg/ffprobe are absent, exactly
// as `timelineExport.ffmpeg.test.ts` does.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildExportFfmpegArgs } from './timelineExport';
import { easeCurveEval } from './easeCurve';
import { EASE_PRESETS, type Clip, type EaseCurve, type Timeline, type Track } from './timeline';

function hasBinary(name: string): boolean {
  try {
    execFileSync(name, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const FFMPEG_AVAILABLE = hasBinary('ffmpeg') && hasBinary('ffprobe');

const EASE_IN = EASE_PRESETS[1].curve;
const EASE_IN_OUT = EASE_PRESETS[3].curve;

/** The source clip's native rate, its length in frames, and the export rate.
 *  Deliberately all the same here — this test is about the CURVE, and B-075's
 *  own mixed-rate cases are already covered next door; a rate mismatch would
 *  only add a second thing that could explain a failure. */
const FPS = 24;
const FRAMES = 96; // 4s

/** The two keys the animation runs between, in clip source frames. */
const KEY_A = 0;
const KEY_B = 72; // 3s in, leaving a second of held-at-1 tail

const WIDTH = 160;
const HEIGHT = 120;

function timelineWith(ease: EaseCurve | null, sourcePath: string): Timeline {
  const c: Clip = {
    id: 'c1',
    name: 'c1',
    source_path: sourcePath,
    source_start: 0,
    duration: FRAMES,
    source_len: FRAMES,
    start_frame: 0,
    opacity: 1,
    chroma_keyframes: [
      ease
        ? { frame: KEY_A, params: { opacity: 0 }, ease: { opacity: ease } }
        : { frame: KEY_A, params: { opacity: 0 } },
      { frame: KEY_B, params: { opacity: 1 } },
    ],
  };
  const track: Track = { kind: 'video', clips: [c] };
  return { id: 'tl', name: 'tl', tracks: [track] };
}

/** The real decoded RGB pixel at `(x, y)` at `timeSecs` — a 2x2 `crop` to raw
 *  `rgb24`, read straight off stdout. Copied in shape from
 *  `timelineExport.ffmpeg.test.ts`'s own `pixelAt`, including its note that a
 *  genuine 1x1 crop fails on this ffmpeg build. */
function pixelAt(path: string, timeSecs: number, x: number, y: number): [number, number, number] {
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

/** Mean channel brightness at the frame's centre — the composited result of a
 *  white clip at some opacity over the canvas. */
function brightnessAt(path: string, timeSecs: number): number {
  const [r, g, b] = pixelAt(path, timeSecs, WIDTH / 2, HEIGHT / 2);
  return (r + g + b) / 3;
}

describe.skipIf(!FFMPEG_AVAILABLE)('D-233 — an eased keyframe segment exports the curve the preview resolves', () => {
  let dir: string;
  let whiteClip: string;
  /** One export per curve under test, rendered once in `beforeAll` — each is a
   *  real ffmpeg run, so they are shared across the assertions below rather
   *  than re-rendered per `it`. */
  const outputs = new Map<string, string>();
  /** Each export's own fully-opaque brightness, measured rather than assumed:
   *  normalising by it cancels the codec's range handling, so the numbers this
   *  test compares are opacities and not white levels. */
  const fullScale = new Map<string, number>();

  function render(name: string, ease: EaseCurve | null): void {
    const out = join(dir, `${name}.mp4`);
    const args = buildExportFfmpegArgs(timelineWith(ease, whiteClip), out, {
      fps: FPS,
      width: WIDTH,
      height: HEIGHT,
    });
    execFileSync('ffmpeg', ['-y', ...args], { stdio: 'pipe' });
    outputs.set(name, out);
    // 3.5s: past KEY_B, where every curve is held at exactly 1.
    fullScale.set(name, brightnessAt(out, 3.5));
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroma-ease-export-test-'));
    whiteClip = join(dir, 'white.mp4');
    execFileSync('ffmpeg', [
      '-y', '-f', 'lavfi',
      '-i', `color=c=white:s=${WIDTH}x${HEIGHT}:d=4:r=${FPS}`,
      '-pix_fmt', 'yuv420p', whiteClip,
    ]);
    render('linear', null);
    render('easeIn', EASE_IN);
    render('easeInOut', EASE_IN_OUT);
  }, 120000);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** The exported file's measured opacity at `timeSecs`, 0..1. */
  function measuredOpacity(name: string, timeSecs: number): number {
    const full = fullScale.get(name);
    const path = outputs.get(name);
    if (!full || !path) throw new Error(`no export for ${name}`);
    return brightnessAt(path, timeSecs) / full;
  }

  it('renders a real file for every curve, eased or not', () => {
    for (const name of ['linear', 'easeIn', 'easeInOut']) {
      // Every one of these is a real ffmpeg run that must not have been
      // rejected — the failure mode B-075's own unquoted-expression bug had,
      // now with 19 extra sampled points per segment in the expression.
      expect(fullScale.get(name)).toBeGreaterThan(200);
    }
  });

  it('reaches both authored keyframes exactly, whatever the curve', () => {
    // The guarantee that makes easing safe: a curve warps the RATE and can
    // never move a keyframe. Proven in real pixels at both ends.
    for (const name of ['linear', 'easeIn', 'easeInOut']) {
      expect(measuredOpacity(name, 0.05)).toBeLessThan(0.06);
      expect(measuredOpacity(name, 3.5)).toBeCloseTo(1, 2);
    }
  });

  it('an EASED export is measurably different from the linear one — the drop-the-curve failure mode', () => {
    // If `ease` were dropped anywhere between the model and ffmpeg (it was, in
    // `rebaseKeyframesToClipInput`, until that was fixed), this is the
    // assertion that fails: the export would be a perfectly valid, perfectly
    // LINEAR animation while the preview eased it. Half way through the
    // segment, linear is at 0.5 and ease-in is at ~0.28 — a gap of ~0.22,
    // roughly 56 levels out of 255, far outside any codec noise.
    const mid = (KEY_B / FPS) * 0.5;
    const lin = measuredOpacity('linear', mid);
    const eased = measuredOpacity('easeIn', mid);
    expect(lin).toBeCloseTo(0.5, 1);
    expect(eased).toBeLessThan(lin - 0.15);
  });

  it('tracks the PREVIEW\'s own resolved curve, in real pixels, across the whole segment', () => {
    // The actual point of the file. `easeCurveEval` is what the Rust compositor
    // evaluates per frame for the live preview; these are pixels ffmpeg wrote.
    // Agreement across the segment is agreement between the two renderers.
    //
    // Tolerance is 8-bit quantisation plus h264 on a flat region, NOT the
    // curve approximation — the compiler's own sampling error is 1.4e-3 at
    // worst (measured in `timelineExport.ease.test.ts`), two orders of
    // magnitude below what a decoded pixel can resolve here.
    for (const [name, curve] of [
      ['easeIn', EASE_IN],
      ['easeInOut', EASE_IN_OUT],
    ] as const) {
      for (const u of [0.2, 0.35, 0.5, 0.65, 0.8]) {
        const timeSecs = (KEY_B / FPS) * u;
        const expected = easeCurveEval(curve, u);
        expect(measuredOpacity(name, timeSecs)).toBeCloseTo(expected, 1);
      }
    }
  });

  it('ease-in really is slower at the start and ease-in-out is symmetric — in the exported pixels', () => {
    // Shape properties, not just point values: an implementation that eased by
    // the WRONG curve could still land near the right numbers at one sample.
    const at = (name: string, u: number) => measuredOpacity(name, (KEY_B / FPS) * u);
    // ease-in stays below the linear diagonal all the way across.
    for (const u of [0.25, 0.5, 0.75]) {
      expect(at('easeIn', u)).toBeLessThan(u);
    }
    // ease-in-out is symmetric about its midpoint: y(u) == 1 - y(1-u).
    expect(at('easeInOut', 0.5)).toBeCloseTo(0.5, 1);
    expect(at('easeInOut', 0.25) + at('easeInOut', 0.75)).toBeCloseTo(1, 1);
  });
});

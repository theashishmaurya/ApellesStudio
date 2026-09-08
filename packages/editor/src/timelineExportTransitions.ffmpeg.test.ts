// @chroma/editor — REAL ffmpeg-execution pixel tests for D-224's transitions.
//
// Its own file, mirroring `timelineExportText.ffmpeg.test.ts`'s precedent: the
// fixtures here are two SOLID-COLOUR sources (not `testsrc`), because the whole
// question a transition test has to answer is "what colour is actually on the
// screen half way through the blend", and that is unanswerable against a moving
// test pattern.
//
// **Why pixels and not argv.** `timelineExport.test.ts` string-matches the
// generated argv, which is exactly how B-090 shipped (a keyframed `scale` that
// compiled to a static resize — the argv looked plausible and the picture never
// moved). A transition has the same failure mode and worse: an `overlay` whose
// alpha silently stayed at 1 produces a HARD CUT, which is a perfectly valid
// video file of exactly the right length that simply is not a dissolve. Only a
// real decoded pixel mid-transition can tell the two apart, so that is what
// every test below measures — the same B-090/D-223 real-measurement discipline.
//
// Skipped automatically (not failed) if `ffmpeg`/`ffprobe` aren't on PATH, same
// as the sibling ffmpeg suites.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildExportFfmpegArgs } from './timelineExport';
import type { Clip, Timeline, Transition } from './timeline';

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

/** The real decoded RGB pixel at `(x, y)` at `timeSecs` into `path` — copied
 *  verbatim from `timelineExport.ffmpeg.test.ts`, including its 2x2 crop (a
 *  genuine 1x1 `crop` fails outright on this ffmpeg build). */
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

/** A real h264/yuv420p round trip moves a pure primary by a few codes, and a
 *  chroma-subsampled 50% blend of two primaries by a few more. ±24 is far
 *  tighter than the thing every test here is actually distinguishing (a real
 *  blend, ~128, from a hard cut, 0 or 255) while still surviving the codec. */
const TOL = 24;

function expectNear(actual: number, expected: number, what: string) {
  expect(Math.abs(actual - expected), `${what}: got ${actual}, expected ~${expected}`).toBeLessThanOrEqual(TOL);
}

describe.skipIf(!FFMPEG_AVAILABLE)('D-224 transitions — real ffmpeg pixels', () => {
  let dir: string;
  let redSrc: string;
  let blueSrc: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroma-transition-test-'));
    redSrc = join(dir, 'red.mp4');
    blueSrc = join(dir, 'blue.mp4');
    // 96 frames each (4s at 24fps) of one flat colour — so a decoded pixel at
    // any time IS the layer's own identity, and a blend of the two is
    // arithmetic anyone can check by hand.
    for (const [color, path] of [
      ['red', redSrc],
      ['blue', blueSrc],
    ] as const) {
      execFileSync('ffmpeg', [
        '-y', '-f', 'lavfi',
        '-i', `color=c=${color}:size=${W}x${H}:rate=${FPS}:d=4`,
        '-pix_fmt', 'yuv420p', path,
      ]);
    }
  }, 60000);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Two abutting 48-frame clips cut at frame 48, each trimmed INSIDE its own
   *  96-frame source so real handle media exists on both sides — the shape a
   *  razor split produces, and the one a cross dissolve needs. */
  function cutTimeline(transitions: Transition[] = []): Timeline {
    const a: Clip = {
      id: 'A',
      name: 'A',
      source_path: redSrc,
      source_fps: FPS,
      source_start: 0,
      duration: 48,
      source_len: 96,
      start_frame: 0,
    };
    const b: Clip = {
      id: 'B',
      name: 'B',
      source_path: blueSrc,
      source_fps: FPS,
      source_start: 24,
      duration: 48,
      source_len: 96,
      start_frame: 48,
    };
    return { id: 'tl', name: 'tl', tracks: [{ kind: 'video', clips: [a, b], transitions }] };
  }

  function render(tl: Timeline, name: string): string {
    const out = join(dir, `${name}.mp4`);
    const args = buildExportFfmpegArgs(tl, out, { fps: FPS, width: W, height: H });
    const res = spawnSync('ffmpeg', ['-y', ...args], { encoding: 'utf8' });
    if (res.status !== 0) {
      throw new Error(`ffmpeg failed for ${name}:\n${res.stderr}\nargs: ${args.join(' ')}`);
    }
    return out;
  }

  // The control. Without this, every assertion below would also pass on a
  // build that simply never dissolves — "red before, blue after" is true of a
  // hard cut too.
  it('control: with NO transition the same two clips are a hard cut — red, then blue, no blend anywhere', () => {
    const out = render(cutTimeline(), 'control');
    const before = pixelAt(out, 46 / FPS);
    const at = pixelAt(out, 50 / FPS);
    expectNear(before[0], 255, 'R two frames before the cut');
    expectNear(before[2], 0, 'B two frames before the cut');
    expectNear(at[0], 0, 'R two frames after the cut');
    expectNear(at[2], 255, 'B two frames after the cut');
  });

  it('a centred cross dissolve is a REAL blend at the cut: half red, half blue in one frame', () => {
    // window [36, 60), so frame 48 (the cut) is progress 0.5 exactly.
    const out = render(
      cutTimeline([
        { id: 'x', kind: 'cross_dissolve', at_frame: 48, duration: 24, alignment: 'center_at_cut' },
      ]),
      'dissolve',
    );
    const mid = pixelAt(out, 48 / FPS);
    expectNear(mid[0], 128, 'R at the midpoint of the dissolve');
    expectNear(mid[2], 128, 'B at the midpoint of the dissolve');
    // The load-bearing assertion: this is NOT either source clip. A hard cut
    // would put one of these at 0 and the other at 255.
    expect(mid[0]).toBeGreaterThan(60);
    expect(mid[2]).toBeGreaterThan(60);
  });

  it('the dissolve ramps monotonically across its whole window, from pure outgoing to pure incoming', () => {
    const out = render(
      cutTimeline([
        { id: 'x', kind: 'cross_dissolve', at_frame: 48, duration: 24, alignment: 'center_at_cut' },
      ]),
      'ramp',
    );
    // Sampled at the window's own frames: 36 (p=0), 42 (0.25), 48 (0.5),
    // 54 (0.75), 59 (≈1). `progress_at` is `(pos - start)/duration`, and
    // ffmpeg's `fade` is frame-index linear over the same span, which is why
    // these land on the arithmetic values rather than near them.
    const samples = [36, 42, 48, 54, 59].map((f) => pixelAt(out, f / FPS));
    const blues = samples.map((p) => p[2]);
    const reds = samples.map((p) => p[0]);
    expectNear(blues[0], 0, 'B at the window start (pure outgoing)');
    expectNear(reds[0], 255, 'R at the window start (pure outgoing)');
    expectNear(blues[1], 64, 'B at 25% through');
    expectNear(blues[2], 128, 'B at 50% through');
    expectNear(blues[3], 191, 'B at 75% through');
    expectNear(blues[4], 245, 'B at the last window frame (nearly pure incoming)');
    for (let i = 1; i < blues.length; i++) {
      expect(blues[i], `blue must rise across the dissolve (sample ${i})`).toBeGreaterThan(blues[i - 1]);
      expect(reds[i], `red must fall across the dissolve (sample ${i})`).toBeLessThan(reds[i - 1]);
    }
  });

  it('the incoming clip really is reading HANDLE media before its own in-point — the picture is continuous, not a jump', () => {
    // B's in-point is source frame 24. A centred dissolve makes it show source
    // frames 12..23 as well. If the compiler had failed to widen B's `-ss`/`-t`
    // (or had shifted its content instead of its window), B's own first REAL
    // frame would land somewhere other than the cut and the second half of the
    // export would be the wrong length. Both are checked here at once: full
    // blue from just after the window to the very end.
    const out = render(
      cutTimeline([
        { id: 'x', kind: 'cross_dissolve', at_frame: 48, duration: 24, alignment: 'center_at_cut' },
      ]),
      'handles',
    );
    for (const f of [61, 80, 94]) {
      const px = pixelAt(out, f / FPS);
      expectNear(px[2], 255, `B at frame ${f} (past the dissolve, pure incoming)`);
      expectNear(px[0], 0, `R at frame ${f}`);
    }
  });

  it('"End at Cut" puts the whole dissolve BEFORE the cut — blended at frame 40, pure incoming at the cut itself', () => {
    // window [24, 48): every frame of the blend is inside the outgoing clip,
    // and the incoming clip supplies the entire handle. The alignment is not
    // cosmetic — this is the placement that works when only one side has media.
    const out = render(
      cutTimeline([
        { id: 'x', kind: 'cross_dissolve', at_frame: 48, duration: 24, alignment: 'end_at_cut' },
      ]),
      'endatcut',
    );
    const mid = pixelAt(out, 36 / FPS); // progress 0.5 of [24,48)
    expectNear(mid[0], 128, 'R at the midpoint of an end-at-cut dissolve');
    expectNear(mid[2], 128, 'B at the midpoint of an end-at-cut dissolve');
    const afterCut = pixelAt(out, 50 / FPS);
    expectNear(afterCut[2], 255, 'B just after the cut — the blend is already over');
    const beforeWindow = pixelAt(out, 20 / FPS);
    expectNear(beforeWindow[0], 255, 'R before the window — untouched');
    expectNear(beforeWindow[2], 0, 'B before the window — nothing yet');
  });

  it('a dip to black is fully black at the cut and untouched at the window edges', () => {
    const out = render(
      cutTimeline([
        { id: 'd', kind: 'dip_to_color', at_frame: 48, duration: 24, alignment: 'center_at_cut' },
      ]),
      'dipblack',
    );
    const at = pixelAt(out, 48 / FPS);
    expectNear(at[0], 0, 'R at the peak of the dip');
    expectNear(at[1], 0, 'G at the peak of the dip');
    expectNear(at[2], 0, 'B at the peak of the dip');

    const start = pixelAt(out, 36 / FPS);
    expectNear(start[0], 255, 'R at the window start — the dip has not begun');
    const end = pixelAt(out, 61 / FPS);
    expectNear(end[2], 255, 'B just past the window end — the dip is over');

    // Half way INTO the dip the picture is the outgoing clip at half
    // brightness — which is the whole difference between a dip and a cut to
    // black followed by a cut back.
    const halfIn = pixelAt(out, 42 / FPS);
    expectNear(halfIn[0], 128, 'R half way into the dip');
    expect(halfIn[2]).toBeLessThan(60);
  });

  it('a dip to a NON-black colour really dips to that colour', () => {
    const out = render(
      cutTimeline([
        {
          id: 'd',
          kind: 'dip_to_color',
          at_frame: 48,
          duration: 24,
          alignment: 'center_at_cut',
          color: '#00FF00',
        },
      ]),
      'dipgreen',
    );
    const at = pixelAt(out, 48 / FPS);
    expectNear(at[1], 255, 'G at the peak of a dip-to-green');
    expectNear(at[0], 0, 'R at the peak of a dip-to-green');
    expectNear(at[2], 0, 'B at the peak of a dip-to-green');
  });

  it('a dangling transition (its incoming clip moved away) renders the plain cut rather than failing the export', () => {
    // Mirrors `Track::push_layers_at`'s own degrade on the preview side, so a
    // document in this state looks the same in both engines.
    const tl = cutTimeline([
      { id: 'x', kind: 'cross_dissolve', at_frame: 48, duration: 24, alignment: 'center_at_cut' },
    ]);
    tl.tracks[0].clips[1].start_frame = 60; // no longer abutting — no cut at 48
    const out = render(tl, 'dangling');
    expectNear(pixelAt(out, 44 / FPS)[0], 255, 'R before the (now plain) cut');
    expectNear(pixelAt(out, 70 / FPS)[2], 255, 'B after it');
  });
});

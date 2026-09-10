// @apelles/editor — REAL ffmpeg-execution tests for a STILL IMAGE clip on the
// Edit timeline (D-292).
//
// **Why a real render and not an argv match.** An argv test that checks for
// `-loop 1` is checking that the code says what the code says. The claim worth
// testing is the specification: **the still's picture is present at every
// output frame of its duration, at the right strength, and gone the frame
// after** — which needs pixels out of a real file. Same posture
// `timelineExportText.ffmpeg.test.ts` takes, for the same reason.
//
// **Which of these tests is the discriminating one, measured not assumed.**
// The first three below pass even against the pre-D-292 generic `-ss`/`-t`
// input — not because that path is right, but because `overlay`'s default
// `eof_action=repeat` happens to hold a one-frame input's last frame for the
// whole composite. They are still worth pinning (they are the specification),
// but the test that actually fails without the looped input is the FADE one:
// a clip fade compiles to a `geq` over the frame's own timestamp `T`, and a
// one-frame input gives it only `T = 0`, where a fade-in's alpha is zero — so
// `overlay` then repeats a fully transparent frame and the still never appears
// at all. Verified by mutation (deleting the still branch turns that test red
// and leaves the other four green) rather than assumed.
//
// Skipped automatically (not failed) if `ffmpeg`/`ffprobe` are not on PATH.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildExportFfmpegArgs } from './timelineExport';
import { clipFromDraggedMedia, type Clip, type Timeline, type Track } from './timeline';

function hasBinary(name: string): boolean {
  try {
    execFileSync(name, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const AVAILABLE = hasBinary('ffmpeg') && hasBinary('ffprobe');

const WIDTH = 320;
const HEIGHT = 180;
const FPS = 24;
/** Three seconds at `FPS` — the still's own placed default, kept as a number
 *  here so the frame arithmetic below reads as frames. */
const STILL_FRAMES = 3 * FPS;

/** The mean RGB of one decoded frame of `path` at `timeSecs`.
 *
 *  A mean, not a single pixel: the fixture still is a flat colour plate, so the
 *  mean IS its colour when the still is on screen and the backdrop's when it is
 *  not — and unlike a point sample it cannot be fooled by an off-by-one in
 *  where the picture landed. */
function meanRgb(path: string, timeSecs: number): [number, number, number] {
  const res = spawnSync(
    'ffmpeg',
    ['-ss', String(timeSecs), '-i', path, '-vframes', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 },
  );
  const need = WIDTH * HEIGHT * 3;
  if (res.status !== 0 || res.stdout.length < need) {
    throw new Error(`meanRgb(${path}, ${timeSecs}) produced no frame: ${res.stderr?.toString()}`);
  }
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < need; i += 3) {
    r += res.stdout[i];
    g += res.stdout[i + 1];
    b += res.stdout[i + 2];
  }
  const n = need / 3;
  return [r / n, g / n, b / n];
}

/** Total number of frames really written to `path` — the second half of "the
 *  still is present for its whole duration": a source ffmpeg treated as one
 *  frame can also make the whole OUTPUT one frame long. */
function frameCount(path: string): number {
  const out = execFileSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', path],
    { encoding: 'utf8' },
  );
  return Number(out.trim());
}

describe.skipIf(!AVAILABLE)('a still image clip — real ffmpeg render (D-292)', () => {
  let dir: string;
  let out: string;
  let stillPath: string;
  let footagePath: string;

  const opts = () => ({ fps: FPS, width: WIDTH, height: HEIGHT });

  /** Compile + actually run, failing with ffmpeg's own stderr — a still opened
   *  the wrong way is a filtergraph/timing failure this file exists to catch. */
  function render(tl: Timeline): string {
    const args = buildExportFfmpegArgs(tl, out, opts());
    const res = spawnSync('ffmpeg', ['-y', ...args], { encoding: 'utf8' });
    if (res.status !== 0) {
      throw new Error(`ffmpeg failed:\n${res.stderr}\n\nargs: ${JSON.stringify(args)}`);
    }
    return out;
  }

  function stillClip(over: Partial<Clip> = {}): Clip {
    const built = clipFromDraggedMedia(
      { id: 'img', sourcePath: stillPath, name: 'plate.png' },
      FPS,
    );
    if (!built) throw new Error('the still fixture must be placeable');
    return { ...built, start_frame: 0, ...over };
  }

  function timeline(tracks: Track[]): Timeline {
    return { id: 'tl', name: 'tl', tracks };
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroma-still-export-'));
    out = join(dir, 'out.mp4');
    stillPath = join(dir, 'plate.png');
    footagePath = join(dir, 'src.mp4');
    // A flat, saturated RED plate at the composition's own size, so "is the
    // still on screen" is a single unambiguous measurement.
    execFileSync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', `color=red:size=${WIDTH}x${HEIGHT}`, '-frames:v', '1', stillPath,
    ]);
    // …and pure-black footage to cut it against.
    execFileSync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', `color=black:size=${WIDTH}x${HEIGHT}:rate=${FPS}:duration=6`,
      '-pix_fmt', 'yuv420p', footagePath,
    ]);
  }, 60000);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** **The bug this whole test exists for.** Before D-292 there was no way to
   *  get here at all; the way to get here and still be wrong is a still opened
   *  as a plain one-frame input, which renders frame 0 and nothing after. */
  it('renders the still at EVERY frame of its duration, not just the first', () => {
    render(timeline([track('video', [stillClip()])]));

    expect(frameCount(out)).toBe(STILL_FRAMES);
    // Start, middle and last frame of the still's own span.
    for (const f of [0, Math.floor(STILL_FRAMES / 2), STILL_FRAMES - 1]) {
      const [r, g, b] = meanRgb(out, f / FPS);
      expect(r, `frame ${f} should be the red plate`).toBeGreaterThan(150);
      expect(g, `frame ${f} should be the red plate`).toBeLessThan(80);
      expect(b, `frame ${f} should be the red plate`).toBeLessThan(80);
    }
  }, 60000);

  /** A still is an ordinary clip: it cuts, and it ENDS. If `-t` were missing
   *  the looped input would run to the end of the output instead. */
  it('ends when its clip ends, cutting to the footage after it', () => {
    render(
      timeline([
        track('video', [
          stillClip(),
          {
            id: 'v',
            shot_id: null,
            media_id: null,
            link_group: null,
            name: 'black',
            source_path: footagePath,
            source_start: 0,
            duration: 2 * FPS,
            source_len: 6 * FPS,
            source_fps: FPS,
            start_frame: STILL_FRAMES,
          },
        ]),
      ]),
    );

    expect(frameCount(out)).toBe(STILL_FRAMES + 2 * FPS);
    // The last frame of the still is still red…
    expect(meanRgb(out, (STILL_FRAMES - 1) / FPS)[0]).toBeGreaterThan(150);
    // …and the first frame after it is the black footage, not a held plate.
    expect(meanRgb(out, (STILL_FRAMES + 2) / FPS)[0]).toBeLessThan(40);
  }, 60000);

  /** A still trimmed longer than its placed default must fill the longer span
   *  too — the synthesized `source_len` is a ceiling, and the export must honour
   *  whatever length inside it the document actually says. */
  it('fills a span longer than its default when the clip has been extended', () => {
    render(timeline([track('video', [stillClip({ duration: 5 * FPS })])]));

    expect(frameCount(out)).toBe(5 * FPS);
    expect(meanRgb(out, (5 * FPS - 1) / FPS)[0]).toBeGreaterThan(150);
  }, 60000);

  /** **The case that actually distinguishes a looped still from a one-frame
   *  input**, and the reason `-loop 1 -framerate` is written explicitly rather
   *  than left to `overlay`'s default `eof_action=repeat`.
   *
   *  A clip fade (D-147) compiles to a `geq` whose alpha is a function of the
   *  frame's own timestamp `T`. Given a ONE-FRAME input, `geq` sees only
   *  `T = 0` — where a fade-in's alpha is zero — and `overlay` then repeats
   *  *that fully transparent frame* for the clip's whole span: the still never
   *  appears at all. A looped input gives `geq` a real frame at every real
   *  timestamp, so the ramp is a ramp.
   *
   *  Fading a still up from black is an entirely ordinary thing to do with one,
   *  which is what makes this the right specification to pin rather than an
   *  edge case. */
  it('fades in over real time — the still is dark at its head and full by the end of the fade', () => {
    render(timeline([track('video', [stillClip({ fade_in_frames: FPS })])]));

    const head = meanRgb(out, 1 / FPS)[0];
    const mid = meanRgb(out, 0.5)[0];
    const after = meanRgb(out, 1.5)[0];
    expect(head, 'the first frames are still faded down').toBeLessThan(60);
    expect(mid, 'halfway through the fade the plate is partly up').toBeGreaterThan(head + 20);
    expect(after, 'past the fade the plate is at full strength').toBeGreaterThan(150);
    expect(after, 'and brighter than the middle of the ramp').toBeGreaterThan(mid + 20);
  }, 60000);

  /** Determinism (a project invariant): the same document renders the same
   *  pixels. A still's picture comes from a decoder, not a generator, so this
   *  is really asserting that nothing in the looped-input path is time- or
   *  order-dependent. */
  it('is deterministic — the same timeline renders the same frames twice', () => {
    const tl = timeline([track('video', [stillClip()])]);
    render(tl);
    const first = [0, 12, STILL_FRAMES - 1].map((f) => meanRgb(out, f / FPS));
    render(tl);
    const second = [0, 12, STILL_FRAMES - 1].map((f) => meanRgb(out, f / FPS));
    expect(second).toEqual(first);
  }, 90000);
});

function track(kind: Track['kind'], clips: Clip[]): Track {
  return { kind, clips };
}

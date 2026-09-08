// @chroma/editor — REAL ffmpeg-execution pixel tests for D-229's adjustment
// clips.
//
// Its own file, mirroring `timelineExportTransitions.ffmpeg.test.ts`'s
// precedent, and with the same fixture reasoning: a SOLID-COLOUR source, not
// `testsrc`, because the only question worth asking here is "what colour is
// actually on the screen", and that is unanswerable against a moving pattern.
//
// **Why pixels and not argv.** `timelineExport.test.ts` string-matches the
// generated argv, which is exactly how B-090 shipped (a keyframed `scale` that
// compiled to a static resize — the argv looked plausible and the picture never
// moved). An adjustment clip has a worse version of that failure mode: a
// correction that silently does nothing produces a completely valid video file
// of exactly the right length showing exactly the right clips, and is simply
// ungraded. Two specific traps found while building this (D-229) are invisible
// to any string match:
//   - `colorchannelmixer` given an alpha-channel offset on a stream with no
//     alpha plane runs, succeeds, and drops the offset entirely;
//   - a filter spliced at the wrong point in the overlay chain grades the wrong
//     set of layers, or none.
// So every test below measures a real decoded pixel.
//
// **This file is one half of a matched pair.** The other is
// `preview_adjustment_tests` in `app/src-tauri/src/chroma/edit.rs`, which
// asserts the same corrections against the live CPU compositor using the same
// shared `AdjustmentOps` operator. Together they are what make "the preview
// matches the export" a checked claim rather than an assertion — the thing
// B-090/B-095/B-098 were each filed for the absence of.
//
// Skipped automatically (not failed) if `ffmpeg`/`ffprobe` aren't on PATH, same
// as the sibling ffmpeg suites.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildExportFfmpegArgs } from './timelineExport';
import { buildAdjustmentOps } from './adjustment';
import { IDENTITY_ADJUSTMENT, type AdjustmentLayer, type Clip, type Timeline } from './timeline';

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

/** The source colour every test grades. Three DIFFERENT channel values on
 *  purpose, so a correction that rebalances channels shows up as a change in
 *  their relationship rather than only in overall brightness. */
const SRC_RGB: [number, number, number] = [0x30, 0x80, 0xb0];

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
 *  RGB→YUV→RGB conversions a colour filter forces add a few more. ±14 is far
 *  tighter than what every test here distinguishes (corrections that move a
 *  channel by 30–90 codes) while still surviving the codec. */
const TOL = 14;

function expectNear(actual: number, expected: number, what: string) {
  expect(Math.abs(actual - expected), `${what}: got ${actual}, expected ~${expected}`).toBeLessThanOrEqual(TOL);
}

describe.skipIf(!FFMPEG_AVAILABLE)('D-229 adjustment clips — real ffmpeg pixels', () => {
  let dir: string;
  let src: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroma-adjustment-test-'));
    src = join(dir, 'src.mp4');
    // 96 frames (4s at 24fps) of one flat colour — a decoded pixel at any time
    // IS the layer's own identity, so any difference is the correction.
    const hex = SRC_RGB.map((c) => c.toString(16).padStart(2, '0')).join('');
    execFileSync('ffmpeg', [
      '-y', '-f', 'lavfi',
      '-i', `color=c=0x${hex}:size=${W}x${H}:rate=${FPS}:d=4`,
      '-pix_fmt', 'yuv420p', src,
    ]);
  }, 60000);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function mediaClip(): Clip {
    return {
      id: 'PIC',
      name: 'PIC',
      source_path: src,
      source_fps: FPS,
      source_start: 0,
      duration: 96,
      source_len: 96,
      start_frame: 0,
    };
  }

  /** An adjustment clip covering `[start, start + len)`, with no media of its
   *  own — exactly what `newAdjustmentClipFields` builds. */
  function adjustmentClip(adjustment: AdjustmentLayer, start = 48, len = 24, opacity?: number): Clip {
    return {
      id: 'ADJ',
      name: 'Adjustment Clip',
      source_path: '',
      source_start: 0,
      duration: len,
      source_len: len,
      start_frame: start,
      adjustment,
      ...(opacity === undefined ? {} : { opacity }),
    };
  }

  /** `tracks` in index order — index 0 is topmost / highest priority, matching
   *  the compositor's own convention. */
  function timelineOf(tracks: Clip[][]): Timeline {
    return {
      id: 'tl',
      name: 'tl',
      tracks: tracks.map((clips) => ({ kind: 'video' as const, clips })),
    };
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

  const LAYER: AdjustmentLayer = {
    exposure: 0.4,
    contrast: 0,
    saturation: -0.6,
    temperature: 0.5,
    tint: 0,
  };

  // The control. Without this, every assertion below would also pass on a build
  // that simply never grades anything — "the source colour, everywhere" is true
  // of an export with no adjustment clip in it at all.
  it('control: with NO adjustment clip the source colour comes through unchanged, everywhere', () => {
    const out = render(timelineOf([[mediaClip()]]), 'control');
    for (const t of [12, 60]) {
      const px = pixelAt(out, t / FPS);
      expectNear(px[0], SRC_RGB[0], `R at frame ${t}`);
      expectNear(px[1], SRC_RGB[1], `G at frame ${t}`);
      expectNear(px[2], SRC_RGB[2], `B at frame ${t}`);
    }
  });

  // The feature, end to end — and the parity claim, because `expected` is
  // computed by the SAME `buildAdjustmentOps` the Rust preview's own operator
  // mirrors, not by numbers typed in by hand.
  it('an adjustment clip on the track ABOVE really corrects the clip beneath it, only inside its own span', () => {
    const out = render(
      timelineOf([[adjustmentClip(LAYER)], [mediaClip()]]),
      'above',
    );

    const outside = pixelAt(out, 12 / FPS);
    const inside = pixelAt(out, 60 / FPS);

    // Outside the span: untouched.
    expectNear(outside[0], SRC_RGB[0], 'R outside the adjustment span');
    expectNear(outside[1], SRC_RGB[1], 'G outside the adjustment span');
    expectNear(outside[2], SRC_RGB[2], 'B outside the adjustment span');

    // Inside it: exactly what the shared operator says.
    const ops = buildAdjustmentOps(LAYER, 1);
    const expected = applyOps(ops, SRC_RGB);
    expectNear(inside[0], expected[0], 'R inside the adjustment span');
    expectNear(inside[1], expected[1], 'G inside the adjustment span');
    expectNear(inside[2], expected[2], 'B inside the adjustment span');

    // …and that it is genuinely a different picture, so the above cannot be
    // satisfied by the correction doing nothing.
    const moved =
      Math.abs(inside[0] - outside[0]) +
      Math.abs(inside[1] - outside[1]) +
      Math.abs(inside[2] - outside[2]);
    expect(moved, `the correction must visibly change the picture: ${outside} -> ${inside}`).toBeGreaterThan(40);
    // Direction, not just magnitude — a sign error in the white balance would
    // keep `moved` large and still be wrong.
    expect(inside[0], 'a +temperature correction must raise red').toBeGreaterThan(outside[0]);
  });

  // The z-order claim, which IS the compositing model. Without this, a build
  // that graded the whole finished frame regardless of where the clip sat would
  // pass the test above.
  it('an adjustment clip does NOT reach a track above it', () => {
    const out = render(
      timelineOf([[mediaClip()], [adjustmentClip(LAYER)]]),
      'below',
    );
    const outside = pixelAt(out, 12 / FPS);
    const inside = pixelAt(out, 60 / FPS);
    expectNear(inside[0], outside[0], 'R: an adjustment below the picture must not change it');
    expectNear(inside[1], outside[1], 'G: an adjustment below the picture must not change it');
    expectNear(inside[2], outside[2], 'B: an adjustment below the picture must not change it');
  });

  it('an identity adjustment clip changes nothing, and emits no filter node at all', () => {
    const tl = timelineOf([[adjustmentClip(IDENTITY_ADJUSTMENT)], [mediaClip()]]);
    const args = buildExportFfmpegArgs(tl, join(dir, 'noop.mp4'), { fps: FPS, width: W, height: H });
    const graph = args[args.indexOf('-filter_complex') + 1];
    expect(graph, 'a neutral adjustment must not compile to any colour filter').not.toContain('colorchannelmixer');
    expect(graph).not.toContain('lutrgb');

    const out = render(tl, 'noop');
    const outside = pixelAt(out, 12 / FPS);
    const inside = pixelAt(out, 60 / FPS);
    expectNear(inside[0], outside[0], 'R with an identity adjustment');
    expectNear(inside[1], outside[1], 'G with an identity adjustment');
    expectNear(inside[2], outside[2], 'B with an identity adjustment');
  });

  // `opacity` as the correction's mix amount — the one other `Clip` field an
  // adjustment clip honours. A half mix must land between the source and the
  // full correction, and be distinguishable from BOTH.
  it("an adjustment clip's opacity really mixes the correction in part-way", () => {
    const full = pixelAt(render(timelineOf([[adjustmentClip(LAYER)], [mediaClip()]]), 'mixfull'), 60 / FPS);
    const half = pixelAt(
      render(timelineOf([[adjustmentClip(LAYER, 48, 24, 0.5)], [mediaClip()]]), 'mixhalf'),
      60 / FPS,
    );

    const expected = applyOps(buildAdjustmentOps(LAYER, 0.5), SRC_RGB);
    expectNear(half[0], expected[0], 'R at a half mix');
    expectNear(half[1], expected[1], 'G at a half mix');
    expectNear(half[2], expected[2], 'B at a half mix');

    // Strictly between the two — the load-bearing part, since matching the
    // operator alone would also hold if `mix` were being ignored and the
    // operator were wrong in the same way.
    expect(half[0], 'half mix must be below the full correction').toBeLessThan(full[0]);
    expect(half[0], 'half mix must be above the ungraded source').toBeGreaterThan(SRC_RGB[0]);
  });

  // Stacking: two adjustment clips on two tracks compose, the lower one first.
  // This is the property that falls out of the paint order for free, and the
  // one that would break first if the splice point were ever wrong.
  it('two stacked adjustment clips compose, lower track applied first', () => {
    const desat: AdjustmentLayer = { ...IDENTITY_ADJUSTMENT, saturation: -1 };
    const warm: AdjustmentLayer = { ...IDENTITY_ADJUSTMENT, temperature: 0.8 };
    const out = render(
      timelineOf([
        [{ ...adjustmentClip(warm), id: 'ADJ_TOP' }],
        [{ ...adjustmentClip(desat), id: 'ADJ_MID' }],
        [mediaClip()],
      ]),
      'stacked',
    );
    const inside = pixelAt(out, 60 / FPS);

    // Compose the two operators in the documented order, through the same
    // shared maths, including the 8-bit round trip between them that the two
    // separate filter pairs really perform.
    const afterDesat = applyOps(buildAdjustmentOps(desat, 1), SRC_RGB);
    const expected = applyOps(buildAdjustmentOps(warm, 1), afterDesat);

    expectNear(inside[0], expected[0], 'R after two stacked adjustments');
    expectNear(inside[1], expected[1], 'G after two stacked adjustments');
    expectNear(inside[2], expected[2], 'B after two stacked adjustments');

    // The desaturate really ran: a fully desaturated source has all three
    // channels equal before the (channel-rebalancing) warm pass, so R and B
    // must end up on opposite sides of G rather than keeping the source's own
    // very wide R<G<B spread.
    expect(inside[2] - inside[0], 'the desaturation must have collapsed the source spread').toBeLessThan(
      SRC_RGB[2] - SRC_RGB[0],
    );
  });
});

/** Apply a resolved operator to an 8-bit RGB triple, mirroring
 *  `AdjustmentOps::apply_rgb8` in Rust exactly — including the intermediate
 *  8-bit quantisation between the two stages, and `lutrgb`'s measured
 *  truncation vs `colorchannelmixer`'s rounding (D-229). Local to the test:
 *  production code never needs to apply the operator in TypeScript, it only
 *  compiles it to filter arguments. */
function applyOps(
  ops: ReturnType<typeof buildAdjustmentOps>,
  rgb: [number, number, number],
): [number, number, number] {
  const stage1 = [0, 1, 2].map((i) => {
    const x = Math.min(1, Math.max(0, (rgb[i] / 255) * ops.gain[i] + ops.offset));
    return Math.floor(x * 255);
  });
  const out = [0, 1, 2].map((i) => {
    const row = ops.sat[i];
    const y = (row[0] * stage1[0] + row[1] * stage1[1] + row[2] * stage1[2]) / 255;
    return Math.round(Math.min(1, Math.max(0, y)) * 255);
  });
  return [out[0], out[1], out[2]];
}

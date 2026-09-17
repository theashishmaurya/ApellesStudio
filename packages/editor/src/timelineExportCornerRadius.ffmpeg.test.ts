// @apelles/editor — REAL ffmpeg-execution parity tests for D-344's rounded
// corners (`Clip.corner_radius`).
//
// **Why this file exists at all, and why it landed WITH the feature rather
// than after it.** `corner_radius` is rendered twice, by two engines that
// share no code: the Rust live-preview compositor (`chroma::edit::
// corner_coverage` / `composite_layer_onto`) and this package's ffmpeg-argv
// compiler (`timelineExport.ts`'s `cornerRadiusMaskExpr`). That is exactly the
// shape of defect B-090 (a keyframed `scale` silently compiling to a static
// resize), B-094, B-095 and B-201 all were — a field that means one thing in
// the preview and another, or nothing, in the export. Every one of those was
// found by a human building a real video, and every one of their postmortems
// says the same thing: the missing test was a REAL, both-engines, real-pixel
// comparison, not a string match on the generated filtergraph. So this feature
// got one on day one.
//
// **How the two engines are actually compared, given they are two languages in
// two processes.** Through one canonical, checked-in table of alpha bytes —
// `CORNER_PROFILE_100x100_R20` below, recorded from real ffmpeg output and
// written up in `docs/notes/rounded-corners.md`. BOTH engines' real test
// suites assert against that same table:
//
//   * this file renders a real clip through the real exporter and real ffmpeg
//     and measures the pixels that come back;
//   * `chroma::edit`'s `corner_coverage_matches_real_ffmpegs_own_measured_alpha`
//     asserts the Rust compositor reproduces the identical numbers.
//
// So a change to either engine's formula that the other does not get fails one
// of the two suites, which is the property a two-engine field needs and the one
// B-201 did not have. The agreement is exact to within ffmpeg's own 1/255 alpha
// quantisation — see that Rust test's own tolerance note.
//
// Skipped automatically (not failed) if `ffmpeg`/`ffprobe` aren't on PATH,
// matching every other `*.ffmpeg.test.ts` in this package.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildExportFfmpegArgs } from './timelineExport';
import type { TimelineExportOptions } from './timelineExport';
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

/** The canvas this file renders into, and the radius it rounds to. A square
 *  canvas with a `box_width`/`box_height` of exactly `1` makes the exporter's
 *  `scale` node produce a layer of exactly `SIZE`×`SIZE`, so `geq`'s own `W`/`H`
 *  — and therefore the mask — are in known, round numbers rather than in
 *  whatever `-2` auto-height happened to compute. */
const SIZE = 100;
const RADIUS = 20;

/**
 * **The canonical cross-engine profile.** `[x, y, alpha]` triples measured from
 * real ffmpeg running the real exporter's own `geq` mask on a fully opaque
 * layer at `SIZE`×`SIZE`, radius `RADIUS`. The Rust compositor's own test pins
 * these identical numbers — see this file's header. Written up with the full
 * 8×8 corner block in `docs/notes/rounded-corners.md`.
 *
 * The points are chosen to pin the three things that can independently break:
 * the corner is fully GONE, the arc's own gradient is at the right radius (the
 * four mid-ramp samples), and the straight edges and centre are fully KEPT —
 * that last group being what catches a formula that rounds the whole layer
 * rather than its corners, which is the specific way the naive
 * distance-from-corner expression fails (see `cornerRadiusMaskExpr`).
 */
const CORNER_PROFILE_100x100_R20: readonly (readonly [number, number, number])[] = [
  [0, 0, 0],
  [3, 0, 0],
  [7, 4, 149],
  [6, 5, 175],
  [7, 5, 255],
  [5, 6, 175],
  [4, 7, 149],
  [50, 0, 255],
  [0, 50, 255],
  [50, 50, 255],
];

function clip(id: string, overrides: Partial<Clip> = {}): Clip {
  return {
    id,
    name: id,
    source_path: `/media/${id}.mov`,
    source_start: 0,
    duration: 25,
    source_len: 25,
    start_frame: 0,
    ...overrides,
  };
}

function timelineOf(c: Clip): Timeline {
  return { id: 'tl', name: 'tl', tracks: [{ kind: 'video', clips: [c] }] };
}

/**
 * The whole decoded RGB frame at `timeSecs`, as a `(x, y) => [r, g, b]` reader.
 *
 * A whole-frame raw read rather than the per-pixel `crop=2:2` helper the older
 * ffmpeg tests use: this file samples dozens of points along a corner arc, and
 * one ffmpeg spawn per point would make the suite minutes long for no extra
 * signal. Raw `rgb24` straight off stdout, so nothing re-encodes between the
 * exported file and the numbers asserted on.
 */
function framePixels(path: string, timeSecs: number, w: number, h: number) {
  const res = spawnSync(
    'ffmpeg',
    [
      '-ss', String(timeSecs), '-i', path,
      '-frames:v', '1',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24',
      '-',
    ],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
  );
  if (res.status !== 0 || res.stdout.length < w * h * 3) {
    throw new Error(`framePixels(${path}) produced no frame: ${res.stderr?.toString()}`);
  }
  return (x: number, y: number): [number, number, number] => {
    const i = (y * w + x) * 3;
    return [res.stdout[i], res.stdout[i + 1], res.stdout[i + 2]];
  };
}

/** The exporter's own reference implementation of the rounded-box coverage,
 *  as the ASSERTION side — deliberately written out here from
 *  `docs/notes/rounded-corners.md`'s stated formula rather than imported from
 *  `timelineExport.ts`, so this test checks the shipped ffmpeg expression
 *  against the specification rather than against itself. */
function expectedCoverage(x: number, y: number, w: number, h: number, r: number): number {
  const rr = Math.min(Math.max(r, 0), Math.min(w, h) / 2);
  const qx = Math.abs(x + 0.5 - w / 2) - (w / 2 - rr);
  const qy = Math.abs(y + 0.5 - h / 2) - (h / 2 - rr);
  const sd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rr;
  return Math.min(Math.max(0.5 - sd, 0), 1);
}

describe.skipIf(!FFMPEG_AVAILABLE)('D-344 corner_radius — real ffmpeg execution', () => {
  let dir: string;
  let white: string;
  let opts: TimelineExportOptions;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroma-corner-test-'));
    white = join(dir, 'white.mp4');
    // A flat WHITE source on a black canvas is what turns this into a direct
    // alpha measurement: `overlay` is source-over, so the composited pixel is
    // exactly `255 * coverage` and the decoded grey level IS the mask's own
    // alpha byte. Nothing has to infer coverage from a blend of two colours.
    execFileSync('ffmpeg', [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', `color=c=white:s=${SIZE}x${SIZE}:d=1:r=25`,
      '-pix_fmt', 'yuv420p', white,
    ]);
    opts = { fps: 25, width: SIZE, height: SIZE };
  }, 30000);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function render(name: string, c: Clip): string {
    const out = join(dir, name);
    execFileSync('ffmpeg', ['-y', '-v', 'error', ...buildExportFfmpegArgs(timelineOf(c), out, opts)]);
    return out;
  }

  /** `box_width`/`box_height` of exactly 1 make the layer exactly canvas-sized,
   *  so `geq`'s `W`/`H` are `SIZE` and the mask's coordinates are the canvas's
   *  own — the geometry `CORNER_PROFILE_100x100_R20` was recorded at. */
  const squareClip = (overrides: Partial<Clip> = {}) =>
    clip('c1', { source_path: white, source_fps: 25, duration: 25, box_width: 1, box_height: 1, ...overrides });

  it('reproduces the canonical cross-engine corner profile the Rust compositor also pins', () => {
    const out = render('rounded.mp4', squareClip({ corner_radius: RADIUS }));
    const px = framePixels(out, 0.2, SIZE, SIZE);

    const diffs: string[] = [];
    for (const [x, y, expected] of CORNER_PROFILE_100x100_R20) {
      const [r] = px(x, y);
      // Tolerance is the yuv420p ENCODE round trip, not the mask: this is a
      // real .mp4, so a grey level survives the 8-bit RGB->YUV->RGB trip to a
      // few counts. The mask itself agrees to 1/255 — that exactness is pinned
      // on the Rust side, against the same table, where there is no codec in
      // the way.
      if (Math.abs(r - expected) > 6) diffs.push(`(${x},${y}): got ${r}, canonical ${expected}`);
    }
    expect(diffs, `real ffmpeg diverged from the canonical corner profile:\n${diffs.join('\n')}`).toEqual([]);
  });

  /** The arc's own GEOMETRY, measured rather than sampled: for each row through
   *  the corner, where does the picture actually start? That boundary is what a
   *  viewer sees as "the round", and it is the measurement that would catch a
   *  radius applied in the wrong units, against the wrong dimension, or after
   *  the wrong pipeline step — none of which the ten sampled points above can
   *  fully pin on their own. */
  it('rounds at the radius it was asked for, measured row by row along the arc', () => {
    const out = render('rounded-arc.mp4', squareClip({ corner_radius: RADIUS }));
    const px = framePixels(out, 0.2, SIZE, SIZE);

    let worst = 0;
    let worstRow = -1;
    for (let y = 0; y < RADIUS; y++) {
      // First x whose coverage is at least half — the arc crossing on this row.
      let measured = -1;
      for (let x = 0; x < SIZE; x++) {
        if (px(x, y)[0] >= 128) {
          measured = x;
          break;
        }
      }
      let predicted = -1;
      for (let x = 0; x < SIZE; x++) {
        if (expectedCoverage(x, y, SIZE, SIZE, RADIUS) >= 0.5) {
          predicted = x;
          break;
        }
      }
      expect(measured, `row ${y} has no picture at all`).toBeGreaterThanOrEqual(0);
      const d = Math.abs(measured - predicted);
      if (d > worst) {
        worst = d;
        worstRow = y;
      }
    }
    // Sub-pixel: the arc lands on the predicted pixel, or at most one either
    // side of it, on every one of the RADIUS rows it passes through.
    expect(worst, `worst arc deviation was ${worst}px on row ${worstRow}`).toBeLessThanOrEqual(1);
  });

  /** **The strict regression requirement.** `corner_radius: 0` must be the same
   *  pixels as no `corner_radius` at all — not "close", the same file. Both are
   *  rendered here by the SAME build, so this is not by itself proof against
   *  the pre-D-344 baseline; what proves that is `timelineExport.test.ts`'s
   *  own D-344 case, which asserts the generated filtergraph for an un-rounded
   *  clip contains no `geq` and no `format=rgba` at all, plus the fact that
   *  every pre-existing argv golden in that suite still passes unchanged. This
   *  test closes the remaining gap: that an explicit zero does not take some
   *  other path to the same-looking-but-different picture. */
  it('corner_radius 0 renders byte-identically to a clip with no corner_radius at all', () => {
    const absent = render('square-absent.mp4', squareClip());
    const zero = render('square-zero.mp4', squareClip({ corner_radius: 0 }));

    const a = execFileSync('ffmpeg', [
      '-v', 'error', '-i', absent, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
    ], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
    const z = execFileSync('ffmpeg', [
      '-v', 'error', '-i', zero, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
    ], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });

    expect(z.length).toBe(a.length);
    expect(Buffer.compare(z, a)).toBe(0);
    // …and it really is a SQUARE: the corner is picture, not background.
    const px = framePixels(zero, 0.2, SIZE, SIZE);
    expect(px(0, 0)[0]).toBeGreaterThan(200);
  });

  /** An over-large radius clamps to `min(W,H)/2` — a circle on a square box —
   *  rather than degenerating. Both engines apply that clamp at the point of
   *  use; this is the export half of the Rust suite's
   *  `corner_coverage_clamps_an_over_large_radius_to_a_circle`. */
  it('clamps an over-large radius to a circle instead of erasing the layer', () => {
    const out = render('circle.mp4', squareClip({ corner_radius: 10_000 }));
    const px = framePixels(out, 0.2, SIZE, SIZE);

    expect(px(SIZE / 2, SIZE / 2)[0]).toBeGreaterThan(200); // centre solid
    expect(px(0, 0)[0]).toBeLessThan(40); // corner gone
    expect(px(SIZE / 2, 1)[0]).toBeGreaterThan(200); // edge midpoint survives
  });

  /** A keyframed radius really animates — the B-090 trap in a new field. The
   *  clip is square at its first frame and rounded at its last, so the same
   *  corner pixel must change between the two. */
  it('animates a keyframed corner_radius rather than freezing it at frame 0', () => {
    const out = render(
      'animated.mp4',
      squareClip({
        corner_radius: 0,
        chroma_keyframes: [
          { frame: 0, params: { corner_radius: 0 } },
          { frame: 24, params: { corner_radius: 40 } },
        ],
      }),
    );
    const early = framePixels(out, 0.04, SIZE, SIZE);
    const late = framePixels(out, 0.92, SIZE, SIZE);

    expect(early(1, 1)[0]).toBeGreaterThan(200); // square at the head
    expect(late(1, 1)[0]).toBeLessThan(40); // rounded away by the tail
  });
});

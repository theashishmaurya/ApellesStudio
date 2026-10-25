// @apelles/editor — REAL ffmpeg-execution parity tests for D-396's clip
// highlights (`Clip.highlights`).
//
// **Why this exists, and how the two engines are compared.** A highlight is
// drawn twice by two engines that share no code: the Rust live compositor
// (`chroma::edit::apply_highlights_to_rgba`, over `apelles_timeline::highlight`)
// and this package's `geq` node (`timelineExportHighlight.ts`). The B-090/B-094/
// B-095/B-201 postmortems all say the missing test was a real both-engines
// pixel comparison, so this one landed with the feature, in the shape
// `timelineExportCornerRadius.ffmpeg.test.ts` established: ONE canonical table
// of RGB values measured from real ffmpeg (`HIGHLIGHT_PROFILE` below), which
// `chroma::edit`'s `highlight_matches_real_ffmpegs_own_measured_pixels` pins to
// within one 8-bit level on the Rust side.
//
// The ffmpeg half is measured through the filter chain `buildClipFilterChain`
// splices in, on a lossless raw read — no codec in the way. A second test goes
// through the whole `buildExportFfmpegArgs` to prove the node is really
// spliced in and the finished file shows the stroke.
//
// Skipped automatically (not failed) if `ffmpeg` is not on PATH.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { highlightGeqSteps } from './timelineExportHighlight';
import { buildExportFfmpegArgs } from './timelineExport';
import type { ClipHighlight } from './clipHighlights';
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

const W = 100;
const H = 60;
const FPS = 25;
/** The canonical highlight: box (20,15)-(80,45) px on a 100x60 picture, a 10
 *  frame sweep from frame 0, default colour and opacity. */
const CANONICAL: ClipHighlight = { box: [0.2, 0.25, 0.8, 0.75], at: 0, dur: 10 };

/** `[frame, x, y, r, g, b]` measured from real ffmpeg (7.1) running the real
 *  `geq` node on a flat WHITE picture. The Rust compositor's own test pins
 *  these identical numbers (to one 8-bit level). The points pin: the hard left
 *  edge and its pixel just outside, the square trailing corners, the rounded
 *  leading end (a block of antialiased corner pixels), and the leading edge
 *  mid-sweep at three frames of the eased ramp. */
export const HIGHLIGHT_PROFILE: readonly (readonly [number, number, number, number, number, number])[] = [
  // Finished stroke: hard left edge, square trailing corners.
  [10, 19, 30, 255, 255, 255],
  [10, 20, 30, 249, 222, 166],
  [10, 20, 15, 249, 222, 166],
  [10, 20, 44, 249, 222, 166],
  [10, 50, 30, 249, 222, 166],
  // Rows just above and below the box.
  [10, 50, 14, 255, 255, 255],
  [10, 50, 15, 249, 222, 166],
  [10, 50, 44, 249, 222, 166],
  [10, 50, 45, 255, 255, 255],
  // Right edge and the rounded leading corners (radius 7.5 px).
  [10, 79, 30, 249, 222, 166],
  [10, 80, 30, 255, 255, 255],
  [10, 79, 15, 255, 255, 255],
  [10, 73, 15, 249, 224, 172],
  [10, 74, 15, 250, 231, 191],
  [10, 75, 15, 252, 242, 220],
  [10, 76, 16, 250, 229, 185],
  [10, 77, 17, 249, 224, 172],
  [10, 78, 18, 250, 229, 185],
  [10, 79, 19, 252, 242, 220],
  [10, 79, 21, 249, 224, 172],
  // The pen mid-sweep (ease-out: well ahead of linear).
  [2, 50, 30, 252, 241, 218],
  [2, 51, 30, 255, 255, 255],
  [4, 67, 30, 250, 231, 192],
  [4, 68, 30, 255, 255, 255],
  [7, 77, 30, 250, 228, 182],
  [7, 78, 30, 255, 255, 255],
];

function frameOf(
  color: string,
  highlights: ClipHighlight[],
  frame: number,
  sourceStart = 0,
): (x: number, y: number) => [number, number, number] {
  const { steps, src } = highlightGeqSteps({
    highlights,
    src: '[0:v]',
    label: 'x',
    sourceStart,
    fps: FPS,
    bigTVar: 'T',
  });
  const graph = `${steps.join(';')};${src}select='eq(n,${frame})'[out]`;
  const res = spawnSync(
    'ffmpeg',
    [
      '-v', 'error',
      // `format=rgb24` so the source is RGB end to end: a yuv420p source would
      // add its own limited-range round trip (white decodes as 253) to every
      // number below, and that is not what is being measured.
      '-f', 'lavfi', '-i', `color=c=${color}:s=${W}x${H}:d=2:r=${FPS},format=rgb24`,
      '-filter_complex', graph,
      '-map', '[out]',
      '-frames:v', '1',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24',
      '-',
    ],
    { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 },
  );
  if (res.status !== 0 || res.stdout.length < W * H * 3) {
    throw new Error(`ffmpeg produced no frame: ${res.stderr?.toString()}\n${graph}`);
  }
  return (x, y) => {
    const i = (y * W + x) * 3;
    return [res.stdout[i], res.stdout[i + 1], res.stdout[i + 2]];
  };
}

describe.skipIf(!FFMPEG_AVAILABLE)('D-396 clip highlights — real ffmpeg execution', () => {
  it('reproduces the canonical cross-engine profile the Rust compositor also pins', () => {
    const frames = new Map<number, ReturnType<typeof frameOf>>();
    const diffs: string[] = [];
    for (const [frame, x, y, r, g, b] of HIGHLIGHT_PROFILE) {
      if (!frames.has(frame)) frames.set(frame, frameOf('white', [CANONICAL], frame));
      const got = frames.get(frame)?.(x, y) ?? [-1, -1, -1];
      if (got[0] !== r || got[1] !== g || got[2] !== b) {
        diffs.push(`frame ${frame} (${x},${y}): got ${got.join(',')}, canonical ${r},${g},${b}`);
      }
    }
    expect(diffs, `ffmpeg diverged from the canonical profile:\n${diffs.join('\n')}`).toEqual([]);
  });

  it('blends over a dark page with the same operator (c + k*(highlight - c))', () => {
    const px = frameOf('0x18181b', [CANONICAL], 10);
    // 24 + 0.45*(242-24) = 122.1, 24 + 0.45*(182-24) = 95.1, 27 + 0.45*(58-27)
    // = 40.95. `geq` TRUNCATES to the 8-bit level (40, not 41), and the Rust
    // compositor truncates the same way so the two agree by construction.
    expect(px(50, 30)).toEqual([122, 95, 40]);
    expect(px(5, 5)).toEqual([24, 24, 27]);
  });

  it('draws nothing before the sweep starts and holds the finished stroke afterwards', () => {
    const late: ClipHighlight = { ...CANONICAL, at: 20, dur: 10 };
    expect(frameOf('white', [late], 19)(50, 30)).toEqual([255, 255, 255]);
    expect(frameOf('white', [late], 45)(50, 30)).toEqual([249, 222, 166]);
  });

  it('re-bases the start to the clip input: a trimmed clip sweeps at the same source frame', () => {
    // source_start 15: the clip's own first frame is source frame 15, so a
    // highlight at source frame 25 starts 10 clip frames in.
    const h: ClipHighlight = { ...CANONICAL, at: 25, dur: 10 };
    expect(frameOf('white', [h], 9, 15)(50, 30)).toEqual([255, 255, 255]);
    expect(frameOf('white', [h], 25, 15)(50, 30)).toEqual([249, 222, 166]);
  });

  describe('through the whole exporter', () => {
    let dir: string;
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'apelles-highlight-test-'));
    });
    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('a still with a highlight exports with the stroke on it', () => {
      const still = join(dir, 'page.png');
      execFileSync('ffmpeg', [
        '-y', '-v', 'error',
        '-f', 'lavfi', '-i', `color=c=white:s=${W}x${H}:d=1`,
        '-frames:v', '1', still,
      ]);
      const c: Clip = {
        id: 'c1',
        name: 'page',
        source_path: still,
        source_start: 0,
        duration: 50,
        source_len: 50,
        source_fps: FPS,
        start_frame: 0,
        highlights: [CANONICAL],
      };
      const t: Timeline = { id: 'tl', name: 'tl', tracks: [{ kind: 'video', clips: [c] }] };
      const out = join(dir, 'out.mp4');
      execFileSync('ffmpeg', ['-y', '-v', 'error', ...buildExportFfmpegArgs(t, out, { fps: FPS, width: W, height: H })]);
      const res = spawnSync(
        'ffmpeg',
        ['-ss', '1', '-i', out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
        { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 },
      );
      expect(res.status).toBe(0);
      const at = (x: number, y: number) => {
        const i = (y * W + x) * 3;
        return [res.stdout[i], res.stdout[i + 1], res.stdout[i + 2]];
      };
      // yuv420p encode: a few counts of drift, but the stroke is unmistakable.
      const inside = at(50, 30);
      const outside = at(5, 5);
      expect(inside[2]).toBeLessThan(190);
      expect(inside[0]).toBeGreaterThan(235);
      expect(outside[2]).toBeGreaterThan(245);
    });
  });
});

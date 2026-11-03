// @apelles/editor — **the TypeScript half of the export benchmark (B-380).**
//
// What it is: the compiled ffmpeg argvs for one realistic timeline, at 1080p
// and at 4K, on both export paths (the filter graph and the compositor pipe)
// and both encoders (D-446: VideoToolbox `hardware`, libx264 `software`),
// frozen into `app/src-tauri/tests/fixtures/export-bench.json`. The Rust half,
// `chroma::export_bench::measure_export_benchmark`, generates the media, runs
// every configuration and reports the time per stage. Same "two languages, one
// committed file" shape as `exportParityFixture.test.ts` (D-350 §5): the argv
// is the real compiler's real output, and this test fails the moment the
// committed file stops matching what the compilers emit today.
//
// What it does NOT do: time anything (vitest has no business measuring ffmpeg),
// or carry a text clip. A title clip's font must be resolved from the app's
// font cache, which a fixture cannot provide on both paths; the overlay layer
// here is a still graphic plus a moving picture-in-picture "motion" clip, which
// exercises the same compositing branches (alpha still, keyframed transform).
//
// Regenerate:
//   WRITE_EXPORT_BENCH_FIXTURE=1 npx vitest run packages/editor/src/exportBenchFixture.test.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ExportEncoder } from './exportFormat';
import { buildExportFfmpegArgs, exportTotalDurationSec, type TimelineExportOptions } from './timelineExport';
import { buildPipeExportPlan } from './timelinePipeExport';
import type { Clip, ClipKeyframe, Timeline, Track } from './timeline';

const FIXTURE_PATH = resolve(__dirname, '../../../app/src-tauri/tests/fixtures/export-bench.json');

const FPS = 30;
/** The timeline's length. 60 s keeps one 4K run of the slowest configuration
 *  (software x264) to minutes, and each output under a GB, while being long
 *  enough that per-segment start-up is a realistic share of the work. */
const SECONDS = 60;
const FRAMES = SECONDS * FPS;

/** The media the Rust half generates, by role. Relative names, joined onto its
 *  own temp dir. `aroll` carries the voice as its embedded audio; `broll` and
 *  `motion` are silent; `music` is audio only; `lower-third` is a PNG with
 *  alpha. */
const MEDIA = {
  aroll: 'aroll.mp4',
  broll: 'broll.mp4',
  motion: 'motion.mp4',
  still: 'lower-third.png',
  music: 'music.m4a',
} as const;

/** Source lengths in frames — what the Rust half generates. The A-roll is
 *  longer than the timeline so its jump cuts can skip forward through it. */
const SOURCE_FRAMES = { aroll: FRAMES + 6 * FPS, broll: 24 * FPS, motion: 6 * FPS, music: FRAMES } as const;

function clip(id: string, source: string, sourceLen: number, over: Partial<Clip>): Clip {
  return {
    id,
    name: id,
    source_path: source,
    source_start: 0,
    duration: FPS,
    source_len: sourceLen,
    source_fps: FPS,
    start_frame: 0,
    ...over,
  };
}

function kf(frame: number, params: Record<string, number>): ClipKeyframe {
  return { frame, params };
}

/**
 * The benchmark timeline — the shape of the owner's real edits (an explainer
 * over a talking head), not a stress case:
 *
 * - **A-roll** (bottom video track): one camera source in six jump cuts, each
 *   skipping a second forward in the source; its embedded audio is the voice.
 * - **B-roll** (middle): four cutaways covering 16 s — one full frame, one
 *   rounded picture-in-picture, one cropped into a box, one sliding in on
 *   keyframes.
 * - **Overlays** (top): a lower-third PNG twice, and a moving "motion graphic"
 *   clip twice.
 * - **Music** (audio track) under everything, at -10 dB.
 */
export function benchTimeline(): Timeline {
  const cut = FRAMES / 6;
  const aroll: Track = {
    kind: 'video',
    clips: Array.from({ length: 6 }, (_, i) =>
      clip(`a${i}`, MEDIA.aroll, SOURCE_FRAMES.aroll, {
        start_frame: i * cut,
        duration: cut,
        source_start: i * (cut + FPS),
      }),
    ),
  };
  const b = (id: string, start: number, over: Partial<Clip>) =>
    clip(id, MEDIA.broll, SOURCE_FRAMES.broll, { start_frame: start, duration: 4 * FPS, ...over });
  const broll: Track = {
    kind: 'video',
    clips: [
      b('b-full', 6 * FPS, { source_start: 0 }),
      b('b-pip', 18 * FPS, {
        source_start: 4 * FPS,
        box_width: 0.4,
        box_height: 0.4,
        position_x: 0.55,
        position_y: 0.08,
        corner_radius: 24,
      }),
      b('b-crop', 32 * FPS, {
        source_start: 8 * FPS,
        crop_left: 0.2,
        crop_right: 0.2,
        box_width: 0.5,
        box_height: 0.6,
        position_x: 0.25,
        position_y: 0.2,
      }),
      b('b-slide', 46 * FPS, {
        source_start: 12 * FPS,
        box_width: 0.45,
        box_height: 0.45,
        position_y: 0.5,
        // Keyframe frames are SOURCE frames (the clip starts 12 s into broll).
        chroma_keyframes: [kf(12 * FPS, { position_x: -0.45 }), kf(13 * FPS, { position_x: 0.05 })],
      }),
    ],
  };
  const overlays: Track = {
    kind: 'video',
    clips: [
      clip('lt-1', MEDIA.still, 1, {
        start_frame: 1 * FPS,
        duration: 5 * FPS,
        box_width: 0.5,
        box_height: 0.125,
        position_x: 0.05,
        position_y: 0.8,
      }),
      clip('lt-2', MEDIA.still, 1, {
        start_frame: 40 * FPS,
        duration: 5 * FPS,
        box_width: 0.5,
        box_height: 0.125,
        position_x: 0.05,
        position_y: 0.8,
      }),
      clip('m-1', MEDIA.motion, SOURCE_FRAMES.motion, {
        start_frame: 12 * FPS,
        duration: 3 * FPS,
        box_width: 0.3,
        box_height: 0.3,
        position_y: 0.1,
        chroma_keyframes: [kf(0, { position_x: 0.65 }), kf(3 * FPS, { position_x: 0.05 })],
      }),
      clip('m-2', MEDIA.motion, SOURCE_FRAMES.motion, {
        start_frame: 52 * FPS,
        duration: 3 * FPS,
        source_start: 3 * FPS,
        box_width: 0.3,
        box_height: 0.3,
        position_y: 0.1,
        chroma_keyframes: [kf(3 * FPS, { position_x: 0.05 }), kf(6 * FPS, { position_x: 0.65 })],
      }),
    ],
  };
  const music: Track = {
    kind: 'audio',
    gain: 0.316,
    clips: [clip('music', MEDIA.music, SOURCE_FRAMES.music, { start_frame: 0, duration: FRAMES })],
  };
  // Track 0 is on top.
  return { id: 'bench', name: 'export benchmark', rate: { num: FPS, den: 1 }, tracks: [overlays, broll, aroll, music] };
}

/** The two sizes the benchmark runs at. Every video source is generated at the
 *  composition's own size, as camera footage edited at its native resolution. */
const SIZES = { '1080p': [1920, 1080], '4k': [3840, 2160] } as const;
type SizeKey = keyof typeof SIZES;

/** Each source's pixel size relative to the composition (`sourceFootprints`,
 *  what `editorExport.ts` resolves from the media pool). The lower-third PNG is
 *  generated at half the composition's width and an eighth of its height. */
function benchOpts(size: SizeKey, encoder: ExportEncoder): TimelineExportOptions {
  const [width, height] = SIZES[size];
  const tl = benchTimeline();
  const footprint = (c: Clip) =>
    c.source_path === MEDIA.still ? { width: 0.5, height: 0.125 } : { width: 1, height: 1 };
  const videoClips = tl.tracks.filter((t) => t.kind === 'video').flatMap((t) => t.clips);
  return {
    fps: FPS,
    width,
    height,
    encoder,
    sourceFootprints: Object.fromEntries(videoClips.map((c) => [c.id, footprint(c)])),
    // Only the A-roll carries sound; the other picture sources are silent.
    hasAudioOverrides: Object.fromEntries(videoClips.map((c) => [c.id, c.source_path === MEDIA.aroll])),
  };
}

interface BenchCase {
  width: number;
  height: number;
  encoder: ExportEncoder;
  filterArgs: string[];
  pipeArgs: string[];
  pipeFrames: number;
  segmentArgs: string[];
  concatArgs: string[];
}

interface BenchFixture {
  note: string;
  fps: number;
  durationSec: number;
  media: typeof MEDIA;
  sourceFrames: typeof SOURCE_FRAMES;
  timeline: Timeline;
  /** Keyed `<size>-<encoder>`, e.g. `4k-hardware`. */
  cases: Record<string, BenchCase>;
}

function buildFixture(): BenchFixture {
  const timeline = benchTimeline();
  const cases: Record<string, BenchCase> = {};
  for (const size of Object.keys(SIZES) as SizeKey[]) {
    for (const encoder of ['software', 'hardware'] as const) {
      const opts = benchOpts(size, encoder);
      const durationSec = exportTotalDurationSec(timeline, opts);
      const plan = buildPipeExportPlan(timeline, 'OUT', opts, durationSec);
      cases[`${size}-${encoder}`] = {
        width: opts.width,
        height: opts.height,
        encoder,
        filterArgs: buildExportFfmpegArgs(timeline, 'OUT', opts),
        pipeArgs: plan.args,
        pipeFrames: plan.frames,
        segmentArgs: plan.segments.segmentArgs,
        concatArgs: plan.segments.concatArgs,
      };
    }
  }
  return {
    note:
      'Generated by packages/editor/src/exportBenchFixture.test.ts. Regenerate with ' +
      'WRITE_EXPORT_BENCH_FIXTURE=1 npx vitest run packages/editor/src/exportBenchFixture.test.ts',
    fps: FPS,
    durationSec: SECONDS,
    media: MEDIA,
    sourceFrames: SOURCE_FRAMES,
    timeline,
    cases,
  };
}

describe('B-380 — the export benchmark fixture the Rust harness runs', () => {
  it('matches the committed fixture', () => {
    const built = buildFixture();
    if (process.env.WRITE_EXPORT_BENCH_FIXTURE === '1') {
      mkdirSync(dirname(FIXTURE_PATH), { recursive: true });
      writeFileSync(FIXTURE_PATH, `${JSON.stringify(built, null, 2)}\n`);
    }
    expect(existsSync(FIXTURE_PATH), `${FIXTURE_PATH} is missing — regenerate it with ${built.note}`).toBe(true);
    expect(JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'))).toEqual(built);
  });

  it('every case is the whole timeline, and the encoders differ only in the codec tail', () => {
    const { cases } = buildFixture();
    for (const c of Object.values(cases)) expect(c.pipeFrames).toBe(FRAMES);
    const strip = (args: string[]) => {
      const i = args.indexOf('-c:v');
      // The software filter path names no codec (ffmpeg's `.mp4` default).
      if (i < 0) return args.filter((a) => a !== '-c:v');
      const end = args.indexOf('yuv420p', i) + 1;
      return [...args.slice(0, i), ...args.slice(end)];
    };
    for (const size of Object.keys(SIZES)) {
      const sw = cases[`${size}-software`];
      const hw = cases[`${size}-hardware`];
      expect(strip(hw.pipeArgs)).toEqual(strip(sw.pipeArgs));
      expect(strip(hw.segmentArgs)).toEqual(strip(sw.segmentArgs));
      expect(strip(hw.filterArgs)).toEqual(strip(sw.filterArgs));
      expect(hw.pipeArgs).toContain('h264_videotoolbox');
      expect(sw.pipeArgs).toContain('libx264');
    }
  });
});

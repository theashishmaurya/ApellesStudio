// @apelles/editor — **the TypeScript half of D-350's old-vs-new pixel-parity
// harness.**
//
// The two export paths live in two languages: the OLD one is an ffmpeg argv
// this package compiles (`buildExportFfmpegArgs`), the NEW one is a Rust
// compositor loop (`app/src-tauri/src/chroma/edit_render.rs`). A single test
// spanning both would have to run `cargo` from vitest or a TypeScript compiler
// from `cargo` — so instead this file FREEZES the comparison's inputs into one
// committed JSON file, and `edit_render.rs`'s `render_path_matches_the_filter_
// graph_path_pixel_for_pixel` consumes it. Same "two tests, one written-down
// shared fact" shape D-338/B-201's placement-parity pair already uses, with a
// whole compiled argv and a whole timeline as the shared fact instead of a
// rectangle.
//
// **The fixture cannot go stale silently**, which is the only thing that makes
// this sound: this file recompiles the parity timeline with the CURRENT
// compilers on every run and asserts the committed JSON still matches. Change
// `buildExportFfmpegArgs` and this test fails with the one command that
// regenerates it. (`docs/notes/export-gpu-compositor.md` §5.)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildExportFfmpegArgs, exportTotalDurationSec, type TimelineExportOptions } from './timelineExport';
import { buildPipeExportPlan } from './timelinePipeExport';
import type { Clip, ClipKeyframe, Timeline, Track } from './timeline';

/** Where the Rust half reads it from. Relative to this file so it resolves the
 *  same from any cwd vitest is run in. */
const FIXTURE_PATH = resolve(__dirname, '../../../app/src-tauri/tests/fixtures/export-parity.json');

/** The media the fixture names. The Rust half GENERATES these files with real
 *  ffmpeg at exactly these paths under its own temp dir, so the paths here are
 *  relative names it joins, not absolute ones — an absolute path baked into a
 *  committed fixture would only ever be right on one machine. */
const MEDIA = {
  base: 'base.mp4',
  pip: 'pip.mp4',
  rounded: 'rounded.mp4',
  cropped: 'cropped.mp4',
} as const;

/** Solid RGB for each fixture source. Flat colours on purpose: any geometry
 *  disagreement between the two engines shows up as a MOVED EDGE, which a
 *  per-pixel diff sees immediately, where a textured source would smear the
 *  same disagreement into resampling noise. */
export const FIXTURE_COLORS: Record<string, [number, number, number]> = {
  [MEDIA.base]: [20, 30, 120],
  [MEDIA.pip]: [230, 140, 30],
  [MEDIA.rounded]: [40, 200, 90],
  [MEDIA.cropped]: [220, 40, 200],
};

const COMP_W = 640;
const COMP_H = 360;
const FPS = 30;
/** Every fixture source is this long, and at the composition's own size —
 *  see `parityTimeline`'s note on why the size matters. */
const SOURCE_FRAMES = 90;

function clip(id: string, source: string, over: Partial<Clip>): Clip {
  return {
    id,
    name: id,
    source_path: source,
    source_start: 0,
    duration: 30,
    source_len: SOURCE_FRAMES,
    source_fps: FPS,
    start_frame: 0,
    ...over,
  };
}

function kf(frame: number, params: Record<string, number>): ClipKeyframe {
  return { frame, params };
}

/**
 * The parity timeline: two tracks, four clips, and one of each geometry
 * feature the old path spells as a separate ffmpeg filter node — a keyframed
 * position (`overlay=x='<expr>'`), a rounded box (`geq`), and a crop
 * (`crop=`) — over a full-frame base layer (`overlay` onto `[base]`).
 *
 * **Every source is 640x360, the composition's own size, deliberately.** The
 * two engines are documented (see `capabilities.json`'s `scale` note) to
 * disagree about what `scale` is a fraction OF when a clip's source resolution
 * differs from the composition: the export reads it as a fraction of the canvas,
 * the live preview as a multiple of the clip's own footprint. That is a real,
 * known, pre-existing divergence and it is NOT what this fixture is measuring —
 * mixing it in would make a genuine geometry regression indistinguishable from
 * it. Matching the sizes makes the two readings the same number, so any pixel
 * difference this harness reports is about the compositing itself. (Every box
 * here is spelled with `box_width`/`box_height` besides, which both engines read
 * identically as canvas fractions.)
 */
export function parityTimeline(): Timeline {
  const top: Track = {
    kind: 'video',
    clips: [
      // A keyframed slide: the box's top-left corner travels from x=0 to
      // x=0.5 of the canvas over the clip's 30 frames. The old path compiles
      // this to a piecewise-linear `overlay=x='...'` expression; the new one
      // resolves the same keyframes in `resolve_clip_transform`.
      clip('c-pip', MEDIA.pip, {
        start_frame: 0,
        duration: 30,
        box_width: 0.5,
        box_height: 0.5,
        position_y: 0.25,
        chroma_keyframes: [kf(0, { position_x: 0 }), kf(30, { position_x: 0.5 })],
      }),
      // D-344 — a rounded placement box. `geq` in the old path, `corner_
      // coverage` in the compositor. 32 px of a 320x180 box is a large,
      // unmistakable arc rather than a subtle one.
      clip('c-round', MEDIA.rounded, {
        start_frame: 30,
        duration: 15,
        box_width: 0.5,
        box_height: 0.5,
        position_x: 0.25,
        position_y: 0.25,
        corner_radius: 32,
      }),
      // B-218 — a crop, scaled INTO the box (crop-then-scale). Halving the
      // width means the kept middle is stretched back out to the full box, so
      // getting the order wrong is a visibly different picture, not a subtle
      // one.
      clip('c-crop', MEDIA.cropped, {
        start_frame: 45,
        duration: 15,
        crop_left: 0.25,
        crop_right: 0.25,
        box_width: 0.5,
        box_height: 0.5,
        position_x: 0.25,
        position_y: 0.25,
      }),
    ],
  };
  const bottom: Track = {
    kind: 'video',
    clips: [clip('c-base', MEDIA.base, { start_frame: 0, duration: 60 })],
  };
  return {
    id: 'parity',
    name: 'export parity',
    rate: { num: FPS, den: 1 },
    tracks: [top, bottom],
  };
}

export function parityOpts(): TimelineExportOptions {
  return { fps: FPS, width: COMP_W, height: COMP_H };
}

/** Timeline frames the Rust half renders through BOTH paths and compares.
 *  One inside the keyframe slide's start, middle and end; one on the rounded
 *  clip; one on the cropped clip. */
const SAMPLE_FRAMES = [5, 15, 25, 35, 50];

// --------------------------------------------------------------------------- #
// The STRESS case — the shape B-228/B-229/B-230 were measured on.
// --------------------------------------------------------------------------- #

/** How many clips the stress timeline cuts up. The real project those three
 *  bugs were found on (`2026-09-12-c040-mgfx-recut`) has ~79 after cuts; 20 is
 *  enough for the per-`-i`/per-filter-instance multiplication to be plainly
 *  visible while keeping a committed measurement harness runnable in under a
 *  minute. The point is the SLOPE, not the absolute number. */
const STRESS_CLIPS = 20;
const STRESS_W = 1920;
const STRESS_H = 1080;
/** Timeline frames each stress clip occupies — short cuts, which is exactly
 *  what makes a heavily-cut project heavy: the clip count, not the runtime. */
const STRESS_CLIP_FRAMES = 12;

/** The stress case has its OWN media, at ITS own (1920x1080) composition size.
 *  Reusing the parity fixture's 640x360 files would understate both paths'
 *  decode cost by a factor of nine, which is the very thing being measured. */
const STRESS_MEDIA = { base: 's-base.mp4', a: 's-a.mp4', b: 's-b.mp4' } as const;
const STRESS_COLORS: Record<string, [number, number, number]> = {
  [STRESS_MEDIA.base]: [20, 30, 120],
  [STRESS_MEDIA.a]: [230, 140, 30],
  [STRESS_MEDIA.b]: [40, 200, 90],
};

/** Two video tracks of short, transformed cuts — the shape that made the old
 *  path open one decoder and one overlay/crop/scale chain per clip. Every clip
 *  carries a real transform so no clip compiles away to a pass-through. */
export function stressTimeline(): Timeline {
  const mk = (i: number): Clip =>
    clip(`s${i}`, i % 2 === 0 ? STRESS_MEDIA.a : STRESS_MEDIA.b, {
      start_frame: i * STRESS_CLIP_FRAMES,
      duration: STRESS_CLIP_FRAMES,
      source_start: 0,
      box_width: 0.5,
      box_height: 0.5,
      position_x: (i % 4) * 0.125,
      position_y: 0.25,
      corner_radius: i % 3 === 0 ? 24 : 0,
      crop_left: i % 5 === 0 ? 0.1 : 0,
    });
  const top: Track = {
    kind: 'video',
    clips: Array.from({ length: STRESS_CLIPS }, (_, i) => mk(i)),
  };
  const bottom: Track = {
    kind: 'video',
    clips: [
      clip('s-base', STRESS_MEDIA.base, {
        start_frame: 0,
        duration: STRESS_CLIPS * STRESS_CLIP_FRAMES,
      }),
    ],
  };
  return { id: 'stress', name: 'export stress', rate: { num: FPS, den: 1 }, tracks: [top, bottom] };
}

export function stressOpts(): TimelineExportOptions {
  return { fps: FPS, width: STRESS_W, height: STRESS_H };
}

interface ParityFixture {
  note: string;
  compWidth: number;
  compHeight: number;
  fps: number;
  sourceFrames: number;
  colors: Record<string, [number, number, number]>;
  sampleFrames: number[];
  durationSec: number;
  timeline: Timeline;
  /** The OLD path's complete argv, with `OUT` standing in for the output path
   *  and each media name standing in for the generated file — the Rust half
   *  substitutes its own temp paths. */
  filterArgs: string[];
  /** The NEW path's complete argv, same substitution rules. */
  pipeArgs: string[];
  pipeFrames: number;
  /** The many-clip resource case — same substitution rules, its own comp size.
   *  Consumed by `measure_resource_use_against_the_filter_graph_path`, which is
   *  `#[ignore]`d: it measures a live process and so reports rather than
   *  asserts (B-230's own write-up names the absence of such a harness as why
   *  both halves of that blowup were found by a human watching Activity
   *  Monitor). */
  stress: {
    clips: number;
    width: number;
    height: number;
    colors: Record<string, [number, number, number]>;
    sourceFrames: number;
    durationSec: number;
    timeline: Timeline;
    filterArgs: string[];
    pipeArgs: string[];
    pipeFrames: number;
  };
}

function buildFixture(): ParityFixture {
  const timeline = parityTimeline();
  const opts = parityOpts();
  const durationSec = exportTotalDurationSec(timeline, opts);
  const plan = buildPipeExportPlan(timeline, 'OUT', opts, durationSec);
  return {
    note:
      'Generated by packages/editor/src/exportParityFixture.test.ts. Regenerate with ' +
      'WRITE_EXPORT_PARITY_FIXTURE=1 npx vitest run packages/editor/src/exportParityFixture.test.ts',
    compWidth: COMP_W,
    compHeight: COMP_H,
    fps: FPS,
    sourceFrames: SOURCE_FRAMES,
    colors: FIXTURE_COLORS,
    sampleFrames: SAMPLE_FRAMES,
    durationSec,
    timeline,
    filterArgs: buildExportFfmpegArgs(timeline, 'OUT', opts),
    pipeArgs: plan.args,
    pipeFrames: plan.frames,
    stress: buildStress(),
  };
}

function buildStress(): ParityFixture['stress'] {
  const timeline = stressTimeline();
  const opts = stressOpts();
  const durationSec = exportTotalDurationSec(timeline, opts);
  const plan = buildPipeExportPlan(timeline, 'OUT', opts, durationSec);
  return {
    clips: STRESS_CLIPS,
    width: STRESS_W,
    height: STRESS_H,
    colors: STRESS_COLORS,
    sourceFrames: STRESS_CLIPS * STRESS_CLIP_FRAMES,
    durationSec,
    timeline,
    filterArgs: buildExportFfmpegArgs(timeline, 'OUT', opts),
    pipeArgs: plan.args,
    pipeFrames: plan.frames,
  };
}

describe('D-350 — the export-parity fixture the Rust render path is measured against', () => {
  it('matches the committed fixture the Rust half reads', () => {
    const built = buildFixture();
    if (process.env.WRITE_EXPORT_PARITY_FIXTURE === '1') {
      mkdirSync(dirname(FIXTURE_PATH), { recursive: true });
      writeFileSync(FIXTURE_PATH, `${JSON.stringify(built, null, 2)}\n`);
    }
    expect(
      existsSync(FIXTURE_PATH),
      `${FIXTURE_PATH} is missing — regenerate it with ${built.note}`,
    ).toBe(true);
    const committed = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as ParityFixture;
    // Deep-equal, not a spot check: the whole point is that the Rust half is
    // comparing against what THIS compiler emits today, not what it emitted
    // when the fixture was written.
    expect(committed).toEqual(built);
  });

  it('the render path emits no video filter graph at all', () => {
    // The load-bearing property, asserted directly rather than inferred from
    // the pixel comparison: D-350 is only closed if the picture stops going
    // through ffmpeg's compositor. A `-filter_complex` may still be present
    // for the audio mix, but it must contain no video node.
    const { pipeArgs } = buildFixture();
    const fc = pipeArgs[pipeArgs.indexOf('-filter_complex') + 1] ?? '';
    for (const videoNode of ['overlay', 'geq', 'crop=', 'scale=', 'drawtext', 'lut3d', 'setpts']) {
      expect(fc, `the render path must not compile a ${videoNode} node`).not.toContain(videoNode);
    }
    expect(pipeArgs).toContain('rawvideo');
    // Exactly one `-i`, always: the pipe. This is the whole resource argument
    // of D-350 (B-228/B-229/B-230 were both per-`-i` multiplications), and this
    // fixture has four clips, so a per-clip input would show up here.
    expect(pipeArgs.filter((a) => a === '-i')).toHaveLength(1);
  });

  it('the render path opens one input for a 20-clip timeline too, where the old path opens 21', () => {
    // The multiplication B-228/B-229/B-230 all were, stated as an argv fact:
    // the old path's input count (and therefore its decoder frame-thread pools)
    // grows with the clip count; the render path's does not.
    const { stress } = buildFixture();
    const inputs = (args: string[]) => args.filter((a) => a === '-i').length;
    expect(inputs(stress.filterArgs)).toBe(STRESS_CLIPS + 1);
    expect(inputs(stress.pipeArgs)).toBe(1);
  });

  it('both paths agree on how long the export is', () => {
    const { filterArgs, pipeArgs, durationSec, pipeFrames } = buildFixture();
    const tOf = (args: string[]) => args[args.lastIndexOf('-t') + 1];
    expect(tOf(filterArgs)).toBe(String(durationSec));
    expect(tOf(pipeArgs)).toBe(String(durationSec));
    expect(pipeFrames).toBe(Math.round(durationSec * FPS));
  });
});

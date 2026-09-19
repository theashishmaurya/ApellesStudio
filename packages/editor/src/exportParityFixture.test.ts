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
  /** B-208/D-353 — the one source deliberately NOT at the composition's size.
   *  See `SOURCE_SIZES` and `parityTimeline`'s `c-scaled` clip. */
  scaled: 'scaled.mp4',
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
  [MEDIA.scaled]: [250, 220, 40],
};

const COMP_W = 640;
const COMP_H = 360;
const FPS = 30;

/**
 * **B-208/D-353 — each source's own pixel size, which is NOT uniformly the
 * composition's any more.**
 *
 * Every source used to be generated at `COMP_W x COMP_H`, and `parityTimeline`
 * said so in as many words: the two engines were known to disagree about what
 * `scale` is a fraction OF whenever a clip's source resolution differed from
 * the composition, so the fixture matched the sizes to keep that divergence out
 * of a harness measuring compositing. D-353 closed the divergence — the export
 * now reads `scale` the preview's way — so the fixture can (and must) finally
 * carry the case that proves it: `scaled.mp4` is TWICE the composition on each
 * axis, and the `c-scaled` clip sizes itself with a plain `scale`.
 *
 * **Twice, not half, and that is a measured choice rather than an arbitrary
 * one.** A source SMALLER than the composition was tried first (320x180) and
 * the parity comparison failed on it — but not on geometry: a pixel dump showed
 * both engines putting the box's bottom edge on exactly the same row, with the
 * difference confined to a 4-row soft-edge/chroma band straddling it (per-channel
 * deltas of 25-27 against the harness's own 24 threshold). The render path
 * decodes a source smaller than the composition UP to the composition's size
 * first and then composites it back DOWN into the box, so that one clip paid two
 * resamples and came out with a softer edge than ffmpeg's single `scale`. That is
 * a real (small, pre-existing, unrelated-to-B-208) property of the render path
 * for undersized sources, not a divergence this fix introduced or should hide
 * behind a loosened tolerance. An OVERSIZED source goes down the same
 * single-resample path every other clip here already uses, so it isolates the
 * unit question this case exists to ask — and 4K footage in a 1080p composition
 * is the commoner real shape anyway.
 *
 * The Rust half (`edit_render.rs`'s `generate_media`) reads this map instead of
 * generating everything at the composition size.
 */
export const SOURCE_SIZES: Record<string, [number, number]> = {
  [MEDIA.base]: [COMP_W, COMP_H],
  [MEDIA.pip]: [COMP_W, COMP_H],
  [MEDIA.rounded]: [COMP_W, COMP_H],
  [MEDIA.cropped]: [COMP_W, COMP_H],
  [MEDIA.scaled]: [COMP_W * 2, COMP_H * 2],
};

/** Every fixture source is this long. */
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
 * **B-208/D-353 — and one clip sized by a plain `scale` from a source that is
 * NOT the composition's size.** Every source here used to be 640x360 on
 * purpose, because the two engines disagreed about what `scale` was a fraction
 * OF (the export: the output canvas; the live preview: the clip's own native
 * footprint) and matching the sizes kept that known divergence from
 * contaminating a harness measuring compositing. D-353 settled it in the
 * preview's favour and taught this compiler the same reading, so the case the
 * fixture used to dodge is now the case it has to prove: `c-scaled` is a
 * 320x180 source at `scale: 0.5`, which is a 160x90 box under the correct
 * reading and a 320x180 one under the old. Nothing else about the harness
 * changes — the other three overlays are still spelled with
 * `box_width`/`box_height`, which both engines have always read identically as
 * canvas fractions.
 *
 * `c-scaled` is a 1280x720 source (twice the composition on each axis, so a
 * footprint of 2.0) at `scale: 0.25`, which is a 320x180 box under the correct
 * reading and a 160x90 one — a quarter of the area — under the old.
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
      // B-208/D-353 — the non-degenerate `scale` case, and the only clip here
      // sized without a `box_*` override. A 1280x720 source (twice the
      // composition on each axis, footprint 2.0) at `scale: 0.25` is a 320x180
      // box: the compositor computes `natural.0 * scale` = 320 and derives 180
      // from the source's own aspect, and this compiler now emits
      // `scale=w='640*2*(0.25)':h=-2`. Before D-353 it emitted `640*(0.25)` =
      // 160 and ffmpeg derived 90 — a box a QUARTER of the area, in the one
      // place the old fixture had deliberately arranged never to look.
      clip('c-scaled', MEDIA.scaled, {
        start_frame: 60,
        duration: 15,
        scale: 0.25,
        position_x: 0.25,
        position_y: 0.25,
      }),
    ],
  };
  const bottom: Track = {
    kind: 'video',
    clips: [clip('c-base', MEDIA.base, { start_frame: 0, duration: 75 })],
  };
  return {
    id: 'parity',
    name: 'export parity',
    rate: { num: FPS, den: 1 },
    tracks: [top, bottom],
  };
}

export function parityOpts(): TimelineExportOptions {
  return {
    fps: FPS,
    width: COMP_W,
    height: COMP_H,
    // B-208/D-353 — what `editorExport.ts`'s `resolveSourceFootprints` would
    // compute for this timeline from the media pool's probed dimensions: each
    // source's size over the composition's. Written out for every clip rather
    // than only the one that is not 1:1, because that is what a real export of
    // this timeline actually passes, and the whole value of this fixture is
    // that it is the real compiler's real input.
    sourceFootprints: Object.fromEntries(
      [
        ['c-pip', MEDIA.pip],
        ['c-round', MEDIA.rounded],
        ['c-crop', MEDIA.cropped],
        ['c-scaled', MEDIA.scaled],
        ['c-base', MEDIA.base],
      ].map(([clipId, media]) => [
        clipId,
        { width: SOURCE_SIZES[media][0] / COMP_W, height: SOURCE_SIZES[media][1] / COMP_H },
      ]),
    ),
  };
}

/** Timeline frames the Rust half renders through BOTH paths and compares.
 *  One inside the keyframe slide's start, middle and end; one on the rounded
 *  clip; one on the cropped clip; one on the B-208 `scale` clip. */
const SAMPLE_FRAMES = [5, 15, 25, 35, 50, 65];

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
  /** B-208/D-353 — each named source's own pixel size. No longer uniformly
   *  `compWidth x compHeight`; see `SOURCE_SIZES`. */
  sizes: Record<string, [number, number]>;
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
    sizes: SOURCE_SIZES,
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

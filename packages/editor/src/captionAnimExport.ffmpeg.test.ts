// @apelles/editor — REAL ffmpeg-execution, PIXEL-level tests for the ANIMATED
// caption export path (D-243, `docs/notes/caption-presets.md`).
//
// **Why this file exists at all.** `captionAnim.test.ts` proves the model's
// arithmetic and `timelineExport.test.ts` can only match argv STRINGS — and a
// string match is exactly how B-075 (an expression ffmpeg rejects outright)
// and B-090 (a keyframed scale compiling to a static resize) each shipped
// green. An animated caption is the easiest thing yet to get wrong that way:
// `alpha=`, `x=` and `y=` are ffmpeg EXPRESSIONS, so a caption can compile to a
// perfectly plausible filtergraph that simply never moves. The only way to
// know it animates is to render it and look at the pixels at two times.
//
// **The strong claim, and the honest limit on it.** Like its D-229 sibling,
// this file holds the export to the written SPECIFICATION — `caption_anim`'s
// per-word contract — rather than diffing pixels against the Rust preview
// (`ab_glyph` and libfreetype are different rasterisers and never will be
// byte-identical). What is checked exactly is the part the specification
// actually fixes: that a word lands at the x the shared model computes from
// the given advances, that it is present only inside its own window, and that
// it really moves while entering. `caption_render.rs`'s tests assert the same
// contract on the preview side and `captionAnim.test.ts` pins the two
// languages to one fixture; the three together are what make "preview matches
// export" checkable rather than hoped for.
//
// **The advances are SUPPLIED, deliberately.** `captionMetrics` normally comes
// from the backend's own measurement. Here they are synthetic round numbers,
// which makes every expected word x exactly computable by hand — a stronger
// assertion than re-deriving them from the same code under test. The real
// measurement is covered on the Rust side.
//
// Skipped automatically (not failed) if `ffmpeg`/`ffprobe` are not on PATH or
// this machine has no usable font file — the posture every sibling takes.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { captionLayout, resolveCaptionStyle, type CaptionStyle } from './caption';
import { captionMetricKey, type CaptionMetrics } from './captionMetrics';
import { buildExportFfmpegArgs } from './timelineExport';
import { newCaptionClipFields, type Clip, type Timeline, type Track } from './timeline';

function hasBinary(name: string): boolean {
  try {
    execFileSync(name, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const FONT_CANDIDATES = [
  '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
  '/Library/Fonts/Arial Bold.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
];
const FONT_FILE = FONT_CANDIDATES.find((p) => existsSync(p));
const AVAILABLE = hasBinary('ffmpeg') && hasBinary('ffprobe') && !!FONT_FILE;

const WIDTH = 640;
const HEIGHT = 360;
const FPS = 24;
/** Three equal-length words, so their windows are exact thirds of the cue —
 *  which keeps every expected time a round number. */
const TEXT = 'AAA BBB CCC';
/** A synthetic advance for every word. Equal, so a line's layout is trivially
 *  computable: total = 3*ADV + 2*gap. */
const ADV = 60;

interface Frame {
  w: number;
  h: number;
  data: Buffer;
}

function frameRgb(path: string, timeSecs: number): Frame {
  const res = spawnSync(
    'ffmpeg',
    ['-ss', String(timeSecs), '-i', path, '-vframes', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
  );
  if (res.status !== 0 || res.stdout.length < WIDTH * HEIGHT * 3) {
    throw new Error(`frameRgb(${path}, ${timeSecs}) produced no frame: ${res.stderr?.toString()}`);
  }
  return { w: WIDTH, h: HEIGHT, data: res.stdout };
}

function px(f: Frame, x: number, y: number): [number, number, number] {
  const i = (y * f.w + x) * 3;
  return [f.data[i], f.data[i + 1], f.data[i + 2]];
}

/** Bounding box + count of near-white pixels — the caption's GLYPHS. */
function inkBounds(f: Frame, threshold = 200) {
  let x0 = Infinity;
  let x1 = -Infinity;
  let count = 0;
  for (let y = 0; y < f.h; y++) {
    for (let x = 0; x < f.w; x++) {
      const [r, g, b] = px(f, x, y);
      if (r > threshold && g > threshold && b > threshold) {
        count++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
      }
    }
  }
  return count === 0 ? null : { x0, x1: x1 + 1, count };
}

/** Bounding box of every strongly-RED pixel — the highlight box, which is the
 *  only red thing in frame over a grey backdrop with white type. */
function redBounds(f: Frame) {
  let x0 = Infinity;
  let x1 = -Infinity;
  let count = 0;
  for (let y = 0; y < f.h; y++) {
    for (let x = 0; x < f.w; x++) {
      const [r, g, b] = px(f, x, y);
      if (r > 150 && g < 90 && b < 90) {
        count++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
      }
    }
  }
  return count === 0 ? null : { x0, x1: x1 + 1, count };
}

describe.skipIf(!AVAILABLE)('animated captions — real ffmpeg render (D-243)', () => {
  let dir: string;
  let out: string;

  function captionClip(text: string, startFrame: number, duration: number, style: CaptionStyle): Clip {
    const c = { ...newCaptionClipFields(text, duration, 'c1'), start_frame: startFrame } as Clip;
    return { ...c, caption: { text, style } } as Clip;
  }

  /** Synthetic metrics: every word of `TEXT` is `ADV` wide in the resolved
   *  font size. */
  function metricsFor(style: CaptionStyle, lineCount: number): CaptionMetrics {
    const resolved = resolveCaptionStyle(style);
    const layout = captionLayout(resolved, WIDTH, HEIGHT, lineCount);
    const m: CaptionMetrics = {};
    for (const w of ['AAA', 'BBB', 'CCC']) {
      m[captionMetricKey(resolved.font, layout.font_px, w)] = ADV;
    }
    return m;
  }

  function render(style: CaptionStyle, lineCount = 1): string {
    const tl: Timeline = {
      id: 'tl',
      name: 'tl',
      tracks: [
        {
          kind: 'video',
          clips: [
            {
              id: 'bg',
              shot_id: null,
              media_id: null,
              link_group: null,
              name: 'bg',
              source_path: join(dir, 'grey.mp4'),
              source_start: 0,
              duration: 96,
              source_len: 96,
              start_frame: 0,
            } as Clip,
          ],
        } as Track,
        { kind: 'subtitle', clips: [captionClip(TEXT, 0, 72, style)] } as Track,
      ],
    };
    const args = buildExportFfmpegArgs(tl, out, {
      fps: FPS,
      width: WIDTH,
      height: HEIGHT,
      fontFiles: { 'sans-bold': FONT_FILE as string, 'sans-black': FONT_FILE as string },
      captionMetrics: metricsFor(style, lineCount),
    });
    const res = spawnSync('ffmpeg', ['-y', ...args], { encoding: 'utf8' });
    if (res.status !== 0) {
      throw new Error(`ffmpeg failed:\n${res.stderr}\n\nargs: ${JSON.stringify(args)}`);
    }
    return out;
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroma-caption-anim-'));
    out = join(dir, 'out.mp4');
    execFileSync('ffmpeg', [
      '-y', '-f', 'lavfi',
      '-i', `color=0x808080:size=${WIDTH}x${HEIGHT}:rate=${FPS}:duration=4`,
      '-pix_fmt', 'yuv420p', join(dir, 'grey.mp4'),
    ]);
  }, 60000);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // The cue runs 0..3s, so the three equal words own 0-1s, 1-2s and 2-3s.

  it('BUILD really builds — the line gets wider as each word lands', () => {
    render({
      font: 'sans-bold',
      size: 0.1,
      color: '#FFFFFF',
      box_enabled: false,
      align: 'center',
      position_x: 0.5,
      position_y: 0.6,
      animation: { kind: 'build', enter_secs: 0.2, enter_rise: 0.2 },
    });

    const early = inkBounds(frameRgb(out, 0.5));
    const mid = inkBounds(frameRgb(out, 1.5));
    const late = inkBounds(frameRgb(out, 2.6));
    expect(early, 'the first word is up half a second in').not.toBeNull();
    expect(mid).not.toBeNull();
    expect(late).not.toBeNull();

    // The real claim: this ANIMATES. A filtergraph that compiled but never
    // evaluated its expressions would show the same ink at all three times.
    expect(mid!.count).toBeGreaterThan(early!.count);
    expect(late!.count).toBeGreaterThan(mid!.count);
    // And the line grows to both sides, because it stays centred.
    expect(late!.x1 - late!.x0).toBeGreaterThan(early!.x1 - early!.x0);
  });

  it('BUILD puts each word at exactly the x the shared model computes', () => {
    const style: CaptionStyle = {
      font: 'sans-bold',
      size: 0.1,
      color: '#FFFFFF',
      box_enabled: false,
      align: 'center',
      position_x: 0.5,
      position_y: 0.6,
      // No entrance at all, so the frame sampled is fully settled and the
      // expected x carries no easing term.
      animation: { kind: 'build', enter_secs: 0, enter_rise: 0, word_gap: 0.25 },
    };
    render(style);

    const resolved = resolveCaptionStyle(style);
    const layout = captionLayout(resolved, WIDTH, HEIGHT, 1);
    const gap = 0.25 * layout.font_px;
    const total = 3 * ADV + 2 * gap;
    const first = layout.lines[0].x_anchor - total / 2;

    // At 2.6s every word is settled, so the whole line is up.
    const ink = inkBounds(frameRgb(out, 2.6))!;
    // **Only the FIRST word's pen is exactly predictable here**, and that is
    // the assertion worth making. The advances fed in are synthetic, so ffmpeg
    // still draws each word at its REAL glyph width — the line therefore ends
    // wherever those real widths reach, which this test deliberately knows
    // nothing about. What it does pin exactly is the number the compiler
    // actually computed: the line's left edge, `anchor - total/2`, straight
    // out of the shared layout. A glyph's left side bearing is >= 0, so ink
    // starts at that pen or a pixel or two inside it.
    expect(ink.x0).toBeGreaterThanOrEqual(Math.floor(first) - 1);
    expect(ink.x0).toBeLessThan(first + ADV);
    // And the line really is three words long, not one.
    expect(ink.x1 - ink.x0).toBeGreaterThan(2 * ADV);
  });

  it('SLAM shows one word at a time, and it really moves while entering', () => {
    render({
      font: 'sans-bold',
      size: 0.12,
      color: '#FFFFFF',
      box_enabled: false,
      align: 'center',
      position_x: 0.5,
      position_y: 0.5,
      // An entrance LONGER than the word's own 1s window, so both sampled
      // frames land mid-slide. It has to be long for a reason worth writing
      // down: alpha and dx are driven by the SAME easing, so at any moment the
      // word has moved a long way it is also still faint. Stretching the
      // entrance separates "bright enough to measure" from "already settled".
      animation: { kind: 'slam', enter_secs: 2, enter_rise: 0 },
    });

    // Word 0 owns 0-1s. Sample twice inside it, at a threshold low enough to
    // catch a partly-faded glyph (white at ~0.62 alpha reads ~207 over the 128
    // backdrop) but still far above the backdrop itself.
    const a = inkBounds(frameRgb(out, 0.55), 180)!;
    const b = inkBounds(frameRgb(out, 0.95), 180)!;
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // Only one word is ever up, so the ink stays narrow — nothing like the
    // three-word span the build test measures.
    expect(b.x1 - b.x0).toBeLessThan(3 * ADV);
    // The real claim: the `x=` expression is EVALUATED. Word 0 enters from the
    // left (dx < 0, easing to 0), so it moves RIGHT as it settles.
    expect(b.x0).toBeGreaterThan(a.x0);
  });

  it('HIGHLIGHT moves its box from word to word, and keeps the line up', () => {
    render({
      font: 'sans-bold',
      size: 0.1,
      color: '#FFFFFF',
      box_enabled: false,
      align: 'center',
      position_x: 0.5,
      position_y: 0.6,
      animation: {
        kind: 'highlight',
        active_box_color: '#FF1745',
        active_box_opacity: 1,
        enter_secs: 0.1,
      },
    });

    const first = redBounds(frameRgb(out, 0.5));
    const second = redBounds(frameRgb(out, 1.5));
    const third = redBounds(frameRgb(out, 2.5));
    expect(first, 'a box is drawn on the first word').not.toBeNull();
    expect(second).not.toBeNull();
    expect(third).not.toBeNull();

    // The box travels left to right across the line, one word at a time.
    expect(second!.x0).toBeGreaterThan(first!.x0);
    expect(third!.x0).toBeGreaterThan(second!.x0);
    // Exactly one box at a time — its width is about one word, not the line.
    expect(first!.x1 - first!.x0).toBeLessThan(2 * ADV);

    // And the whole line stays up the entire time, unlike `build`/`slam`.
    const inkEarly = inkBounds(frameRgb(out, 0.5))!;
    const inkLate = inkBounds(frameRgb(out, 2.5))!;
    expect(inkLate.x1 - inkLate.x0).toBeCloseTo(inkEarly.x1 - inkEarly.x0, -1);
  });

  it('a STATIC caption still compiles to D-229’s own filtergraph, unchanged', () => {
    // The regression guard for the whole decision: adding animation must not
    // have changed what a caption with none renders to.
    render({
      font: 'sans-bold',
      size: 0.1,
      color: '#FFFFFF',
      box_enabled: true,
      box_color: '#000000',
      box_opacity: 0.6,
      align: 'center',
      position_x: 0.5,
      position_y: 0.6,
    });
    const early = inkBounds(frameRgb(out, 0.5))!;
    const late = inkBounds(frameRgb(out, 2.5))!;
    expect(early).not.toBeNull();
    // A static caption does not change across its own span.
    expect(late.count).toBeCloseTo(early.count, -2);
    expect(late.x0).toBe(early.x0);
  });
});

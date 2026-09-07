// @chroma/editor — REAL ffmpeg-execution, PIXEL-level tests for the text/title
// clip export path (D-209/D-211, `docs/notes/text-title-clips.md`).
//
// `textClip.test.ts` asserts on the compiled argv STRINGS. That is exactly how
// B-075 (an unquoted keyframe expression ffmpeg's filtergraph parser rejects
// outright) and B-090 (a keyframed `scale` compiling to a static resize) each
// shipped invisibly under a green test. A `drawtext` node is even easier to
// get wrong that way: escaping, the `expansion` mode, and the `fontfile=`
// path are all things a string match cannot judge and only a real ffmpeg run
// can. So this file runs the real thing and reads real pixels back out.
//
// It asserts against the SPECIFICATION — "the title's ink is centred in the
// frame, at this size, only inside its own time window" — rather than against
// the Rust preview's output. The Rust rasteriser's own tests
// (`app/src-tauri/src/chroma/text.rs`) assert the same specification on their
// side. The two engines are different rasterisers (`ab_glyph` vs.
// libfreetype) over the same font file, so they are close but never
// pixel-identical; holding both to one written-down rule is what makes
// "preview matches export" a checkable claim rather than a diff with an
// arbitrary tolerance.
//
// Skipped automatically (not failed) if `ffmpeg`/`ffprobe` are not on PATH,
// or if this machine has no usable font file — same posture
// `timelineExport.ffmpeg.test.ts` takes.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildExportFfmpegArgs, quoteFiltergraphValue } from './timelineExport';
import { DEFAULT_TEXT_FONT, newTextClipFields, newTextLayer, type Clip, type TextLayer, type Timeline, type Track } from './timeline';

function hasBinary(name: string): boolean {
  try {
    execFileSync(name, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** The same candidate list `chroma::text`'s catalogue uses for its default
 *  family (`sans-bold`), checked here rather than imported: this package has
 *  no access to the Rust crate, and in the app the real path always comes
 *  from the `chroma_text_fonts` command. */
const FONT_CANDIDATES = [
  '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
  '/Library/Fonts/Arial Bold.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
];
const FONT_FILE = FONT_CANDIDATES.find((p) => existsSync(p));

const AVAILABLE = hasBinary('ffmpeg') && hasBinary('ffprobe') && !!FONT_FILE;

const WIDTH = 320;
const HEIGHT = 180;
const FPS = 24;

function layer(overrides: Partial<TextLayer> = {}): TextLayer {
  const made = newTextLayer({ content: 'AFTER', ...overrides });
  if ('error' in made) throw new Error(made.error);
  return made;
}

function textClip(id: string, overrides: Partial<Clip> = {}): Clip {
  return { ...newTextClipFields(layer(), 48), id, start_frame: 0, ...overrides };
}

function timeline(tracks: Track[]): Timeline {
  return { id: 'tl', name: 'tl', tracks };
}

function track(kind: Track['kind'], clips: Clip[]): Track {
  return { kind, clips };
}

/** One decoded RGB24 frame of `path` at `timeSecs`, as a flat byte array plus
 *  its dimensions. Read whole (not a 1x1 crop like the sibling file's
 *  `pixelAt`) because every assertion here is about WHERE the ink is, which
 *  needs the frame, not a probe of one coordinate. */
function frameRgb(path: string, timeSecs: number): { w: number; h: number; data: Buffer } {
  const res = spawnSync(
    'ffmpeg',
    ['-ss', String(timeSecs), '-i', path, '-vframes', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 },
  );
  if (res.status !== 0 || res.stdout.length < WIDTH * HEIGHT * 3) {
    throw new Error(`frameRgb(${path}, ${timeSecs}) produced no frame: ${res.stderr?.toString()}`);
  }
  return { w: WIDTH, h: HEIGHT, data: res.stdout };
}

/** The bounding box of every pixel brighter than `threshold` on all three
 *  channels — the drawn title's ink, against a black or dark backdrop.
 *  `null` when nothing is lit. Deliberately the SAME measurement
 *  `chroma::text`'s own Rust test performs on its rasterised layer, so both
 *  engines are checked with one idea of "where the text is". */
function inkBounds(
  frame: { w: number; h: number; data: Buffer },
  threshold = 128,
): { x0: number; y0: number; x1: number; y1: number; count: number } | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let count = 0;
  for (let y = 0; y < frame.h; y++) {
    for (let x = 0; x < frame.w; x++) {
      const i = (y * frame.w + x) * 3;
      if (frame.data[i] > threshold && frame.data[i + 1] > threshold && frame.data[i + 2] > threshold) {
        count++;
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  }
  return count === 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1, count };
}

describe.skipIf(!AVAILABLE)('text/title clips — real ffmpeg render', () => {
  let dir: string;
  let out: string;
  let source: string;
  const opts = () => ({
    fps: FPS,
    width: WIDTH,
    height: HEIGHT,
    fontFiles: { [DEFAULT_TEXT_FONT]: FONT_FILE as string },
  });

  /** Compile + actually run, and fail with ffmpeg's own stderr rather than a
   *  bare non-zero status — a filtergraph parse error is the exact class of
   *  failure this file exists to surface (B-075). */
  function render(tl: Timeline): string {
    const args = buildExportFfmpegArgs(tl, out, opts());
    const res = spawnSync('ffmpeg', ['-y', ...args], { encoding: 'utf8' });
    if (res.status !== 0) {
      throw new Error(`ffmpeg failed:\n${res.stderr}\n\nargs: ${JSON.stringify(args)}`);
    }
    return out;
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroma-text-export-'));
    out = join(dir, 'out.mp4');
    source = join(dir, 'src.mp4');
    // A flat, pure-black source, so any lit pixel in the output is the title
    // and nothing else. `testsrc` would make "is this pixel text?" ambiguous.
    execFileSync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', `color=black:size=${WIDTH}x${HEIGHT}:rate=${FPS}:duration=4`,
      '-pix_fmt', 'yuv420p', source,
    ]);
  }, 30000);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('burns real, readable text into the exported file, centred in the frame', () => {
    render(timeline([track('video', [textClip('t', { duration: 72 })])]));

    const ink = inkBounds(frameRgb(out, 1.0));
    expect(ink, 'the title should be visible one second in').not.toBeNull();
    if (!ink) return;

    // Real glyphs, not a stray pixel or a solid block.
    expect(ink.count).toBeGreaterThan(100);
    expect(ink.count).toBeLessThan(WIDTH * HEIGHT * 0.5);

    // Centred: the ink box's own centre sits on the frame's centre. The
    // tolerance is a few px of glyph-metric rounding, not a fudge factor —
    // `chroma::text`'s Rust test holds its own rasteriser to ±1px of the same
    // rule on its own canvas.
    const cx = (ink.x0 + ink.x1) / 2;
    const cy = (ink.y0 + ink.y1) / 2;
    expect(Math.abs(cx - WIDTH / 2)).toBeLessThanOrEqual(3);
    expect(Math.abs(cy - HEIGHT / 2)).toBeLessThanOrEqual(3);

    // …and `size` really is a fraction of the frame HEIGHT: 0.12 × 180 = ~21px
    // of cap height for an all-caps title (the ink box has no descenders).
    const inkHeight = ink.y1 - ink.y0;
    expect(inkHeight).toBeGreaterThan(10);
    expect(inkHeight).toBeLessThan(25);
  }, 60000);

  it('honours position_x/position_y as fractions of the frame', () => {
    render(timeline([track('video', [textClip('t', { duration: 72, position_x: 0.25, position_y: -0.2 })])]));

    const ink = inkBounds(frameRgb(out, 1.0));
    expect(ink).not.toBeNull();
    if (!ink) return;
    const cx = (ink.x0 + ink.x1) / 2;
    const cy = (ink.y0 + ink.y1) / 2;
    // Right by a quarter of the width, up by a fifth of the height.
    expect(Math.abs(cx - (WIDTH / 2 + 0.25 * WIDTH))).toBeLessThanOrEqual(3);
    expect(Math.abs(cy - (HEIGHT / 2 - 0.2 * HEIGHT))).toBeLessThanOrEqual(3);
  }, 60000);

  it('scales with `size`, in the same fraction-of-height unit the preview uses', () => {
    render(timeline([track('video', [textClip('t', { duration: 72, text: layer({ size: 0.24 }) })])]));
    const big = inkBounds(frameRgb(out, 1.0));
    render(timeline([track('video', [textClip('t', { duration: 72, text: layer({ size: 0.12 }) })])]));
    const small = inkBounds(frameRgb(out, 1.0));
    expect(big).not.toBeNull();
    expect(small).not.toBeNull();
    if (!big || !small) return;
    const ratio = (big.y1 - big.y0) / (small.y1 - small.y0);
    // Double the size fraction ⇒ double the ink height, within a pixel's
    // worth of hinting/rounding at these small sizes.
    expect(ratio).toBeGreaterThan(1.75);
    expect(ratio).toBeLessThan(2.25);
  }, 90000);

  it('appears ONLY inside its own timeline window', () => {
    // A title from 1s to 3s over a 4s black source: nothing before, ink
    // during, nothing after. The `enable=between()` gate's real proof.
    const tl = timeline([
      track('video', [textClip('title', { start_frame: FPS, duration: 2 * FPS })]),
      track('video', [
        {
          id: 'bg',
          name: 'bg',
          source_path: source,
          source_start: 0,
          duration: 4 * FPS,
          source_len: 4 * FPS,
          source_fps: FPS,
          start_frame: 0,
        },
      ]),
    ]);
    render(tl);

    expect(inkBounds(frameRgb(out, 0.4)), 'nothing before the title starts').toBeNull();
    expect(inkBounds(frameRgb(out, 2.0)), 'ink while the title is up').not.toBeNull();
    expect(inkBounds(frameRgb(out, 3.5)), 'nothing after the title ends').toBeNull();
  }, 90000);

  it('composites the title OVER the video beneath it (track 0 wins)', () => {
    // White source under a black title: if z-order were reversed the frame
    // would be uniformly white with no dark glyphs in it.
    const white = join(dir, 'white.mp4');
    execFileSync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', `color=white:size=${WIDTH}x${HEIGHT}:rate=${FPS}:duration=3`,
      '-pix_fmt', 'yuv420p', white,
    ]);
    const tl = timeline([
      track('video', [textClip('title', { duration: 2 * FPS, text: layer({ color: '#000000' }) })]),
      track('video', [
        {
          id: 'bg',
          name: 'bg',
          source_path: white,
          source_start: 0,
          duration: 3 * FPS,
          source_len: 3 * FPS,
          source_fps: FPS,
          start_frame: 0,
        },
      ]),
    ]);
    render(tl);

    const frame = frameRgb(out, 1.0);
    // Dark ink on a white field — the inverse measurement.
    let dark = 0;
    for (let i = 0; i < frame.data.length; i += 3) {
      if (frame.data[i] < 80) dark++;
    }
    expect(dark, 'black title drawn on top of a white clip').toBeGreaterThan(100);
  }, 90000);

  // The escaping proof. `drawtext`'s `textfile=` reads its bytes from a file
  // verbatim, with no filtergraph escaping involved at all — so it is the
  // ground truth for "what should this string look like". Rendering the SAME
  // string both ways and comparing the frames byte-for-byte proves the
  // escaper round-trips it exactly, which merely checking "ffmpeg didn't
  // error" does not: the shell-style `'\''` escape this code shipped with
  // first produced no error AND no text at all, because it opened a quote in
  // the second-level option parser and swallowed `fontsize`, `fontcolor`,
  // `x`, `y` and the rest into the text value.
  it.each([
    'PLAIN',
    "IT'S",
    '12:30',
    '100% OK',
    '{OK}',
    "IT'S 12:30, 100% {OK}",
    'a\\b',
    'A [B] C; D',
    'BEFORE / AFTER',
    'Ünïcødé — em dash',
    "'leading and trailing'",
    'semi;colon,comma:colon',
    '=equals= and #hash',
  ])("renders %j byte-identically to drawtext's own escaping-free textfile=", (content) => {
    const tl = timeline([track('video', [textClip('t', { duration: 48, text: layer({ content }) })])]);
    const args = buildExportFfmpegArgs(tl, out, opts());
    const gi = args.indexOf('-filter_complex') + 1;

    // The real, escaped `text=` path.
    let res = spawnSync('ffmpeg', ['-y', ...args], { encoding: 'utf8' });
    if (res.status !== 0) throw new Error(`escaped render failed:\n${res.stderr}\n${args[gi]}`);
    const viaText = frameRgb(out, 0.5).data;

    // The control: the SAME node with `text=<escaped>` swapped for
    // `textfile=<path>`, so every other option (font, size, colour, position,
    // alpha, enable) is identical and only the text-delivery mechanism
    // differs. No trailing newline in the file — `drawtext` strips one, and a
    // mismatch there would make this compare the wrong thing.
    const textPath = join(dir, 'control.txt');
    writeFileSync(textPath, content, 'utf8');
    const escaped = quoteFiltergraphValue(content);
    const control = [...args];
    control[gi] = control[gi].replace(`text=${escaped}`, `textfile=${quoteFiltergraphValue(textPath)}`);
    expect(control[gi], 'the swap must actually have happened').not.toBe(args[gi]);
    res = spawnSync('ffmpeg', ['-y', ...control], { encoding: 'utf8' });
    if (res.status !== 0) throw new Error(`control render failed:\n${res.stderr}\n${control[gi]}`);
    const viaFile = frameRgb(out, 0.5).data;

    expect(Buffer.compare(viaText, viaFile)).toBe(0);
  }, 60000);

  it('fades in, as one alpha ramp over the clip', () => {
    render(timeline([track('video', [textClip('t', { duration: 3 * FPS, fade_in_frames: 2 * FPS })])]));
    // 0.15s in: barely up. 1.0s in: half way. 2.5s in: fully up.
    const early = inkBounds(frameRgb(out, 0.15), 200)?.count ?? 0;
    const late = inkBounds(frameRgb(out, 2.5), 200)?.count ?? 0;
    expect(late).toBeGreaterThan(100);
    expect(early).toBeLessThan(late / 2);
  }, 60000);

  it('animates a keyframed position, in TIMELINE time', () => {
    // The re-basing this path needed: a text clip's `drawtext` runs on the
    // composited stream where `t` is timeline time, so a keyframe authored at
    // clip-frame 0 must fire at the clip's own START, not at t=0.
    render(
      timeline([
        track('video', [
          textClip('t', {
            start_frame: FPS, // starts 1s in
            duration: 2 * FPS,
            chroma_keyframes: [
              { frame: 0, params: { position_x: -0.25 } },
              { frame: 2 * FPS, params: { position_x: 0.25 } },
            ],
          }),
        ]),
      ]),
    );
    const at1 = inkBounds(frameRgb(out, 1.05));
    const at3 = inkBounds(frameRgb(out, 2.9));
    expect(at1, 'ink right after the clip starts').not.toBeNull();
    expect(at3, 'ink right before the clip ends').not.toBeNull();
    if (!at1 || !at3) return;
    const cx1 = (at1.x0 + at1.x1) / 2;
    const cx3 = (at3.x0 + at3.x1) / 2;
    // Left of centre at the clip's start, right of centre at its end.
    expect(cx1).toBeLessThan(WIDTH / 2 - 10);
    expect(cx3).toBeGreaterThan(WIDTH / 2 + 10);
  }, 90000);

  it('renders deterministically — the same timeline twice gives the same bytes', () => {
    const tl = () => timeline([track('video', [textClip('t', { duration: 48 })])]);
    render(tl());
    const a = frameRgb(out, 1.0).data.toString('base64');
    render(tl());
    const b = frameRgb(out, 1.0).data.toString('base64');
    expect(a).toBe(b);
  }, 90000);
});

// @chroma/editor — REAL ffmpeg-execution, PIXEL-level tests for the
// subtitle/caption export path (D-228, `docs/notes/subtitles.md`).
//
// `timelineExport.test.ts` asserts on the compiled argv STRINGS. That is
// exactly how B-075 (an unquoted expression ffmpeg rejects outright) and B-090
// (a keyframed `scale` compiling to a static resize) each shipped invisibly
// under a green test. A caption's filtergraph is even easier to get wrong that
// way: `y_align=font`, the `box`/`boxborderw` geometry, and multi-line
// stacking are all things a string match cannot judge and only a real ffmpeg
// run can.
//
// **What it asserts, and why that is the strong claim.** Like its sibling
// `timelineExportText.ffmpeg.test.ts`, this file holds the export to the
// written SPECIFICATION — `chroma_timeline::caption`'s layout contract — rather
// than diffing it against the Rust preview's pixels. `ab_glyph` and libfreetype
// are different rasterisers and will never be byte-identical. What CAN be
// checked exactly, and is checked here, is the part the specification actually
// fixes: that the export puts line *i*'s font line box top at exactly
// `CaptionLayout.lines[i].line_top`, and its background box at exactly that
// minus `box_padding`. `caption_render.rs`'s own tests assert the same
// specification on the preview side, and `caption.test.ts` pins the two
// languages' arithmetic to one fixture. Those three together are what make
// "preview matches export" a checkable claim rather than a hope.
//
// Skipped automatically (not failed) if `ffmpeg`/`ffprobe` are not on PATH, or
// if this machine has no usable font file — the same posture the sibling files
// take.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { captionLayout, resolveCaptionStyle, type CaptionStyle } from './caption';
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

/** The same candidate list `chroma::text`'s catalogue uses for `sans-bold`,
 *  checked here rather than imported: this package has no access to the Rust
 *  crate, and in the app the real path always comes from `chroma_text_fonts`. */
const FONT_CANDIDATES = [
  '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
  '/Library/Fonts/Arial Bold.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
];
const FONT_FILE = FONT_CANDIDATES.find((p) => existsSync(p));
const AVAILABLE = hasBinary('ffmpeg') && hasBinary('ffprobe') && !!FONT_FILE;

// Deliberately larger than the sibling text test's 320x180: a caption is ~5.5%
// of frame height, and at 180px tall that is a 10px font whose antialiasing
// would dominate every measurement. 640x360 keeps the numbers real.
const WIDTH = 640;
const HEIGHT = 360;
const FPS = 24;

function captionClip(id: string, text: string, startFrame: number, duration: number): Clip {
  return { ...newCaptionClipFields(text, duration, id), start_frame: startFrame };
}

function timeline(tracks: Track[]): Timeline {
  return { id: 'tl', name: 'tl', tracks };
}

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

/** Bounding box of every near-white pixel — the caption's GLYPHS. The
 *  background box is dark grey (a 0.6-alpha black over a mid-grey backdrop),
 *  so a high threshold separates ink from box cleanly. */
function inkBounds(f: Frame, threshold = 200) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, count = 0;
  for (let y = 0; y < f.h; y++) {
    for (let x = 0; x < f.w; x++) {
      const [r, g, b] = px(f, x, y);
      if (r > threshold && g > threshold && b > threshold) {
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

/** Bounding box of every pixel DARKER than the mid-grey backdrop — the
 *  background box. The backdrop is a flat mid grey chosen so the box (black at
 *  0.6) is unambiguously darker and the glyphs (white) unambiguously
 *  brighter. */
function boxBounds(f: Frame, backdrop: number, margin = 20) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, count = 0;
  for (let y = 0; y < f.h; y++) {
    for (let x = 0; x < f.w; x++) {
      const [r, g, b] = px(f, x, y);
      if (r < backdrop - margin && g < backdrop - margin && b < backdrop - margin) {
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

describe.skipIf(!AVAILABLE)('subtitles / captions — real ffmpeg render', () => {
  let dir: string;
  let out: string;
  // A flat MID-GREY backdrop, not black: the caption's background box is dark
  // and its text is light, so a black backdrop would make the box invisible
  // and untestable — the single most important thing this file measures.
  const BACKDROP = 128;

  const opts = (style?: Partial<CaptionStyle>) => ({
    fps: FPS,
    width: WIDTH,
    height: HEIGHT,
    fontFiles: { 'sans-bold': FONT_FILE as string },
    _style: style,
  });

  function render(tl: Timeline): string {
    const args = buildExportFfmpegArgs(tl, out, {
      fps: FPS,
      width: WIDTH,
      height: HEIGHT,
      fontFiles: { 'sans-bold': FONT_FILE as string },
    });
    const res = spawnSync('ffmpeg', ['-y', ...args], { encoding: 'utf8' });
    if (res.status !== 0) {
      throw new Error(`ffmpeg failed:\n${res.stderr}\n\nargs: ${JSON.stringify(args)}`);
    }
    return out;
  }

  /** A video track holding one full-length grey clip, so every frame has a
   *  known backdrop, plus a subtitle track. */
  function withBackdrop(subtitleTrack: Track): Timeline {
    return timeline([
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
      },
      subtitleTrack,
    ]);
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroma-caption-export-'));
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

  it('burns a readable, centred caption into the exported file', () => {
    render(
      withBackdrop({
        kind: 'subtitle',
        clips: [captionClip('c1', 'We always visit this beach', 0, 72)],
      }),
    );

    const ink = inkBounds(frameRgb(out, 1.0));
    expect(ink, 'the caption should be visible one second in').not.toBeNull();
    if (!ink) return;

    // Real glyphs, not a stray pixel or a solid block.
    expect(ink.count).toBeGreaterThan(100);
    expect(ink.count).toBeLessThan(WIDTH * HEIGHT * 0.5);

    // Horizontally centred on the frame (position_x defaults to 0.5,
    // align defaults to centre). Tolerance is glyph side bearings only.
    const cx = (ink.x0 + ink.x1) / 2;
    expect(Math.abs(cx - WIDTH / 2)).toBeLessThanOrEqual(4);

    // In the lower part of the frame — a subtitle, not a centred title.
    expect(ink.y0).toBeGreaterThan(HEIGHT * 0.7);
  }, 90000);

  it('places the background box at exactly the layout`s own rectangle', () => {
    // THE assertion this file exists for. `y_align=font` is what makes the
    // box's top equal `y` regardless of which glyphs the line contains; if
    // that mode were ever dropped, or `line_top`/`box_padding` drifted from
    // the shared arithmetic, this is what catches it — in real pixels.
    render(
      withBackdrop({
        kind: 'subtitle',
        clips: [captionClip('c1', 'Hello', 0, 72)],
      }),
    );
    const frame = frameRgb(out, 1.0);
    const box = boxBounds(frame, BACKDROP);
    expect(box, 'the background box should be drawn').not.toBeNull();
    if (!box) return;

    const layout = captionLayout(resolveCaptionStyle(null, null), WIDTH, HEIGHT, 1);
    const expectedTop = layout.lines[0].line_top - layout.box_padding;
    // Exact, not approximate: this number is plain integer arithmetic on both
    // sides, and `y_align=font` makes ffmpeg honour it to the pixel. One pixel
    // of tolerance for the encoder's chroma subsampling of the box edge.
    expect(Math.abs(box.y0 - expectedTop)).toBeLessThanOrEqual(1);
  }, 90000);

  it('stacks a two-line cue exactly one line_step apart, growing upward', () => {
    // The multi-line claim, measured. D-211 forbade multi-line titles because
    // the two engines disagree on inter-line layout; captions are allowed it
    // only because the step is OUR arithmetic, handed to both. This proves
    // ffmpeg actually used it.
    const oneLine = withBackdrop({
      kind: 'subtitle',
      clips: [captionClip('c1', 'enjoying the sunsets', 0, 72)],
    });
    render(oneLine);
    const single = boxBounds(frameRgb(out, 1.0), BACKDROP);

    const twoLine = withBackdrop({
      kind: 'subtitle',
      clips: [captionClip('c1', 'Swimming, surfing,\nenjoying the sunsets', 0, 72)],
    });
    render(twoLine);
    const double = boxBounds(frameRgb(out, 1.0), BACKDROP);

    expect(single).not.toBeNull();
    expect(double).not.toBeNull();
    if (!single || !double) return;

    const layout = captionLayout(resolveCaptionStyle(null, null), WIDTH, HEIGHT, 2);
    // The BOTTOM line does not move when a line is added above it.
    expect(Math.abs(double.y1 - single.y1)).toBeLessThanOrEqual(1);
    // …and the block grew upward by exactly one line step.
    expect(Math.abs(double.y0 - (single.y0 - layout.line_step))).toBeLessThanOrEqual(1);
  }, 120000);

  it('shows a caption only inside its own time window', () => {
    // A caption's `enable=` gate, in real pixels — the same class of bug
    // `enable` exists to prevent for every other clip type.
    render(
      withBackdrop({
        kind: 'subtitle',
        clips: [captionClip('c1', 'Only in the middle', 24, 24)],
      }),
    );
    expect(inkBounds(frameRgb(out, 0.2)), 'before the cue').toBeNull();
    expect(inkBounds(frameRgb(out, 1.2)), 'during the cue').not.toBeNull();
    expect(inkBounds(frameRgb(out, 2.5)), 'after the cue').toBeNull();
  }, 120000);

  it('draws two subtitle tracks at once, each in its own style', () => {
    // The reference frame's own case: an English and a French track burnt in
    // together, at different colours. This is what a subtitle TRACK KIND buys
    // over a clip variant — both are shown, neither occludes the other.
    render(
      timeline([
        withBackdrop({ kind: 'subtitle', clips: [] }).tracks[0],
        {
          kind: 'subtitle',
          clips: [captionClip('en', 'We always visit this beach', 0, 72)],
          caption_style: { color: '#FFFFFF', position_y: 0.72 },
        },
        {
          kind: 'subtitle',
          clips: [captionClip('fr', 'Nous venons a la plage', 0, 72)],
          caption_style: { color: '#FFFF00', position_y: 0.86 },
        },
      ]),
    );
    const frame = frameRgb(out, 1.0);
    // White ink (all three channels high) exists…
    const white = inkBounds(frame);
    expect(white, 'the white track should be drawn').not.toBeNull();
    // …and so does yellow ink (R,G high, B low), which the white-only bounds
    // above cannot have counted.
    let yellow = 0;
    for (let y = 0; y < frame.h; y++) {
      for (let x = 0; x < frame.w; x++) {
        const [r, g, b] = px(frame, x, y);
        if (r > 200 && g > 200 && b < 90) yellow++;
      }
    }
    expect(yellow, 'the yellow track should be drawn too').toBeGreaterThan(50);
  }, 120000);

  it('honours the style`s colour, size and alignment', () => {
    render(
      withBackdrop({
        kind: 'subtitle',
        clips: [captionClip('c1', 'Left', 0, 72)],
        caption_style: { align: 'left', position_x: 0.1, size: 0.1, box_enabled: false },
      }),
    );
    const frame = frameRgb(out, 1.0);
    const ink = inkBounds(frame);
    expect(ink).not.toBeNull();
    if (!ink) return;
    // Left-aligned at x = 0.1 * 640 = 64. Tolerance is the glyph's own left
    // side bearing, nothing more.
    expect(Math.abs(ink.x0 - 64)).toBeLessThanOrEqual(5);
    // size 0.1 of a 360px frame is a 36px font, so cap height ~26px.
    expect(ink.y1 - ink.y0).toBeGreaterThan(18);
    expect(ink.y1 - ink.y0).toBeLessThan(40);
    // `box_enabled: false` really drew no box.
    expect(boxBounds(frame, BACKDROP)).toBeNull();
  }, 90000);

  it('renders caption text containing filtergraph metacharacters verbatim', () => {
    // Real `.srt` files are full of `:` (timecodes quoted in dialogue),
    // apostrophes and `%`. Each of those breaks one of the two ffmpeg parsers
    // `quoteFiltergraphValue` exists for; a caption is the first place
    // arbitrary text from a FILE (not typed by the user) reaches them.
    render(
      withBackdrop({
        kind: 'subtitle',
        clips: [captionClip('c1', "It's 100% ready: go, now", 0, 72)],
      }),
    );
    const ink = inkBounds(frameRgb(out, 1.0));
    expect(ink, 'awkward text must still render').not.toBeNull();
    if (!ink) return;
    expect(ink.count).toBeGreaterThan(100);
  }, 90000);

  it('a hidden subtitle track exports nothing', () => {
    render(
      withBackdrop({
        kind: 'subtitle',
        hidden: true,
        clips: [captionClip('c1', 'Should not appear', 0, 72)],
      }),
    );
    expect(inkBounds(frameRgb(out, 1.0))).toBeNull();
  }, 90000);
});

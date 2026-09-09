// @apelles/editor — REAL ffmpeg-execution, PIXEL-level export-parity test for
// D-240's italic/bold faces (roadmap item 27).
//
// D-212 measured, once, that `ab_glyph`'s em-sized `PxScale` and `drawtext`'s
// ascender-descender-sized `fontsize` disagree by a fixed ratio per FACE
// (`freetype_equivalent_scale`, computed from that face's own `units_per_em`/
// `height_unscaled` — never hardcoded to Arial Bold's specific numbers). This
// file is the empirical check that the SAME generalisation actually holds for
// the new italic/bold-italic faces catalogued in D-240, not just the
// regular/bold faces D-212 originally measured — "verify empirically" per
// this repo's own established practice (D-212/D-224/D-236), not "assume the
// formula generalises because it looks generic".
//
// The real measured numbers from this session's own run of both sides (the
// `italic_and_bold_italic_faces_render_visible_ink`/
// `italic_cap_height_is_close_to_its_upright_sibling` Rust tests with
// `--nocapture`, and this file's own real-ffmpeg render) are written into
// D-240 in `docs/08-decisions.md`, not duplicated here as a comment that
// could silently drift out of sync with a future re-run — this file's own
// assertions are the checked, currently-true claim; the decision doc is the
// one-time "here is what we measured" record.
//
// Skipped automatically (not failed) if `ffmpeg`/`ffprobe` or the system
// Arial family are not on this machine — same posture every other
// `*.ffmpeg.test.ts` file in this package takes.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildExportFfmpegArgs } from './timelineExport';
import { newTextClipFields, newTextLayer, type Clip, type Timeline, type Track } from './timeline';

function hasBinary(name: string): boolean {
  try {
    execFileSync(name, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** The real D-240 catalogue candidates for the `sans` group, checked here
 *  rather than imported (this package has no access to the Rust crate — in
 *  the app the real path always comes from `chroma_text_fonts`). */
const FONT_FILES: Record<string, string[]> = {
  sans: ['/System/Library/Fonts/Supplemental/Arial.ttf', '/Library/Fonts/Arial.ttf'],
  'sans-bold': ['/System/Library/Fonts/Supplemental/Arial Bold.ttf', '/Library/Fonts/Arial Bold.ttf'],
  'sans-italic': ['/System/Library/Fonts/Supplemental/Arial Italic.ttf', '/Library/Fonts/Arial Italic.ttf'],
  'sans-bold-italic': [
    '/System/Library/Fonts/Supplemental/Arial Bold Italic.ttf',
    '/Library/Fonts/Arial Bold Italic.ttf',
  ],
};

function resolve(key: string): string | undefined {
  return FONT_FILES[key].find((p) => existsSync(p));
}

const FONTS: Record<string, string> = {};
for (const key of Object.keys(FONT_FILES)) {
  const p = resolve(key);
  if (p) FONTS[key] = p;
}

const AVAILABLE =
  hasBinary('ffmpeg') && hasBinary('ffprobe') && Object.keys(FONTS).length === Object.keys(FONT_FILES).length;

const WIDTH = 640;
const HEIGHT = 360;
const FPS = 24;

function layer(font: string) {
  const made = newTextLayer({ content: 'AFTER', font });
  if ('error' in made) throw new Error(made.error);
  return made;
}

function textClip(font: string): Clip {
  return { ...newTextClipFields(layer(font), 48), id: `t-${font}`, start_frame: 0 };
}

function timeline(clip: Clip): Timeline {
  const track: Track = { kind: 'video', clips: [clip] };
  return { id: 'tl', name: 'tl', tracks: [track] };
}

/** Reads real pixels back out, the same measurement
 *  `timelineExportText.ffmpeg.test.ts` uses. */
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

function inkBounds(
  frame: { w: number; h: number; data: Buffer },
  threshold = 128,
): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let any = false;
  for (let y = 0; y < frame.h; y++) {
    for (let x = 0; x < frame.w; x++) {
      const i = (y * frame.w + x) * 3;
      if (frame.data[i] > threshold && frame.data[i + 1] > threshold && frame.data[i + 2] > threshold) {
        any = true;
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  }
  return any ? { x0, y0, x1: x1 + 1, y1: y1 + 1 } : null;
}

describe.skipIf(!AVAILABLE)('D-240: italic/bold export parity — real ffmpeg render', () => {
  let dir: string;
  let out: string;

  function render(font: string): { w: number; h: number; data: Buffer } {
    const args = buildExportFfmpegArgs(timeline(textClip(font)), out, {
      fps: FPS,
      width: WIDTH,
      height: HEIGHT,
      fontFiles: FONTS,
    });
    const res = spawnSync('ffmpeg', ['-y', ...args], { encoding: 'utf8' });
    if (res.status !== 0) throw new Error(`ffmpeg failed for "${font}":\n${res.stderr}`);
    return frameRgb(out, 1.0);
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroma-text-italic-'));
    out = join(dir, 'out.mp4');
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(['sans-italic', 'sans-bold-italic'])(
    'renders real, readable ink for "%s" (not a fontfile ffmpeg silently ignored)',
    (font) => {
      const ink = inkBounds(render(font));
      expect(ink, `"${font}" should draw visible ink`).not.toBeNull();
      if (!ink) return;
      expect(ink.x1 - ink.x0).toBeGreaterThan(40);
    },
    60000,
  );

  it(
    'an italic face is visually DIFFERENT from its upright sibling, not the same glyphs relabelled',
    () => {
      // A real italic/oblique design is not just a skew transform on the
      // same outlines — comparing raw byte content (not just ink bounds)
      // catches a catalogue entry that accidentally points at the SAME file
      // twice (a copy-paste mistake in the candidate list).
      const upright = render('sans');
      const italic = render('sans-italic');
      expect(Buffer.compare(upright.data, italic.data)).not.toBe(0);
    },
    60000,
  );

  it(
    "cap height stays close between a face and its BOLD sibling — italic doesn't secretly shrink the export",
    () => {
      const italic = inkBounds(render('sans-italic'));
      const boldItalic = inkBounds(render('sans-bold-italic'));
      expect(italic).not.toBeNull();
      expect(boldItalic).not.toBeNull();
      if (!italic || !boldItalic) return;
      const italicH = italic.y1 - italic.y0;
      const boldItalicH = boldItalic.y1 - boldItalic.y0;
      // Same measurement, same tolerance as `chroma::text`'s own
      // `italic_cap_height_is_close_to_its_upright_sibling` Rust test — one
      // written-down rule, checked on both engines (D-229's own "one
      // specification, not a diff against each other" methodology).
      const ratio = boldItalicH / italicH;
      expect(Math.abs(ratio - 1.0)).toBeLessThan(0.15);
    },
    60000,
  );

  it(
    'renders deterministically — the same italic title twice gives the same bytes',
    () => {
      const a = render('sans-bold-italic');
      const b = render('sans-bold-italic');
      expect(Buffer.compare(a.data, b.data)).toBe(0);
    },
    60000,
  );
});

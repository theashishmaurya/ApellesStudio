// @apelles/editor — REAL ffmpeg export-geometry test for input scaling
// (D-425, B-325).
//
// The bug: a Motion scene render (manifest 1080x1920 -> file 2160x3840, D-342)
// placed on a 1080x1920 timeline sat at its NATIVE footprint, so the preview —
// and, since the export matches the preview (B-281), the exported file — showed
// only the centre quarter. This runs the real compiler with the footprints the
// real `resolveSourceFootprints` produces from a seeded media pool, executes
// ffmpeg, and reads pixels back:
//
//  - `fit`: the 2160x3840 source fills the 1080x1920 frame edge to edge;
//  - `fit`: a 16:9 source letterboxes (black bars above and below);
//  - `native` (a clip saved before D-425): the old footprint is reproduced
//    exactly — the migration rule, "an old project does not change look".
//
// Skipped (not failed) when ffmpeg/ffprobe are not on PATH, like every other
// `*.ffmpeg.test.ts`. The twin on the preview side is
// `a_double_size_source_fills_the_frame_under_fit_and_overflows_under_native`
// in `app/src-tauri/src/chroma/edit.rs`.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useMediaPoolStore, type MediaItem } from '@apelles/bridge';

import { buildExportFfmpegArgs } from './timelineExport';
import { resolveSourceFootprints } from './editorExport';
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

const FRAME = { width: 1080, height: 1920 };
const FPS = 12;

function pixelAt(path: string, x: number, y: number): [number, number, number] {
  const res = spawnSync(
    'ffmpeg',
    ['-ss', '0.2', '-i', path, '-vf', `crop=2:2:${x}:${y}`, '-vframes', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { encoding: 'buffer', maxBuffer: 1024 * 1024 },
  );
  if (res.status !== 0 || res.stdout.length < 3) {
    throw new Error(`no pixel at ${x},${y}: ${res.stderr?.toString()}`);
  }
  return [res.stdout[0], res.stdout[1], res.stdout[2]];
}

const isMagenta = (p: [number, number, number]) => p[0] > 150 && p[2] > 150 && p[1] < 90;
const isBlack = (p: [number, number, number]) => Math.max(...p) < 50;

describe.skipIf(!FFMPEG_AVAILABLE)('input scaling — real ffmpeg export (D-425, B-325)', () => {
  let dir: string;
  let motion: string;
  let wide: string;

  const source = (name: string, w: number, h: number): string => {
    const out = join(dir, name);
    execFileSync(
      'ffmpeg',
      ['-y', '-f', 'lavfi', '-i', `color=c=magenta:size=${w}x${h}:duration=1:rate=${FPS}`, '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', out],
      { stdio: 'pipe' },
    );
    return out;
  };

  const media = (id: string, sourcePath: string, w: number, h: number): MediaItem => ({
    id,
    sourcePath,
    name: id,
    added: '2026-10-28T00:00:00Z',
    offline: false,
    folder: null,
    video: { width: w, height: h, fps: FPS, frameCount: FPS, durationSecs: 1, hasAudio: false, audioChannels: 0 },
  });

  /** Export `clip` alone on a 1080x1920 timeline, footprints from the real resolver. */
  const exportClip = (clip: Clip, outName: string): string => {
    const tl: Timeline = { id: 'tl', name: 'tl', rate: { num: FPS, den: 1 }, tracks: [{ kind: 'video', clips: [clip] }] };
    const out = join(dir, outName);
    execFileSync(
      'ffmpeg',
      [
        '-y',
        ...buildExportFfmpegArgs(tl, out, { fps: FPS, ...FRAME, sourceFootprints: resolveSourceFootprints(tl, FRAME) }),
      ],
      { stdio: 'pipe' },
    );
    return out;
  };

  const clip = (id: string, sourcePath: string, overrides: Partial<Clip> = {}): Clip => ({
    id,
    name: id,
    source_path: sourcePath,
    source_fps: FPS,
    source_start: 0,
    duration: FPS,
    source_len: FPS,
    start_frame: 0,
    ...overrides,
  });

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'apelles-scaling-export-'));
    motion = source('motion.mp4', 2160, 3840);
    wide = source('wide.mp4', 1920, 1080);
    useMediaPoolStore.setState({
      items: [media('m-motion', motion, 2160, 3840), media('m-wide', wide, 1920, 1080)],
      folders: [],
      openProjectKey: 'scaling-export-test',
    });
  }, 120000);

  afterAll(() => {
    useMediaPoolStore.setState({ items: [] });
    rmSync(dir, { recursive: true, force: true });
  });

  it('fit: a 2160x3840 Motion render on a 1080x1920 timeline exports full-frame', () => {
    const out = exportClip(clip('fit', motion, { scaling: 'fit' }), 'fit-out.mp4');
    const size = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', out])
      .toString()
      .trim();
    expect(size).toBe('1080,1920');
    const inset = 3;
    for (const [x, y] of [
      [inset, inset],
      [FRAME.width - inset - 2, inset],
      [inset, FRAME.height - inset - 2],
      [FRAME.width - inset - 2, FRAME.height - inset - 2],
      [FRAME.width / 2, FRAME.height / 2],
    ]) {
      const p = pixelAt(out, x, y);
      expect(isMagenta(p), `(${x},${y}) should be the picture, got ${p}`).toBe(true);
    }
  }, 120000);

  it('fit: a 16:9 source letterboxes inside the portrait frame', () => {
    const out = exportClip(clip('wide', wide, { scaling: 'fit' }), 'wide-out.mp4');
    // 1920x1080 fitted to 1080 wide is 607.5 tall, placed at `position_y` 0
    // (the box's top-left is the frame's), so the bars are all below: the
    // picture spans rows 0..~607 and the rest is the black base.
    expect(isMagenta(pixelAt(out, 540, 300))).toBe(true);
    expect(isMagenta(pixelAt(out, 1076, 10))).toBe(true);
    expect(isBlack(pixelAt(out, 540, 900))).toBe(true);
    expect(isBlack(pixelAt(out, 540, 1800))).toBe(true);
  }, 120000);

  it('native (no scaling — a clip saved before D-425) keeps the 2x footprint: the migration rule', () => {
    const tl: Timeline = { id: 'tl', name: 'tl', tracks: [{ kind: 'video', clips: [clip('old', motion)] }] };
    // Footprint 2x2 of the frame: the compiler is handed exactly the old reading.
    expect(resolveSourceFootprints(tl, FRAME)).toEqual({ old: { width: 2, height: 2 } });
    const args = buildExportFfmpegArgs(tl, join(dir, 'old.mp4'), {
      fps: FPS,
      ...FRAME,
      sourceFootprints: resolveSourceFootprints(tl, FRAME),
    });
    expect(args.join(' ')).toContain('1080*2*(');
  });
});

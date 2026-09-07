// @chroma/editor — REAL ffmpeg-execution regression tests for
// `timelineExport.ts` (B-075, same session as B-074).
//
// `timelineExport.test.ts` only ever asserts on the generated argv STRINGS —
// it never actually runs ffmpeg. That's exactly how two real, live-blocking
// bugs shipped invisibly: an unquoted keyframe expression that ffmpeg's own
// filtergraph parser rejects outright ("No option name near 'if(lt(t'"), and
// a source-fps/timeline-fps unit mix-up that silently produced the wrong
// clip duration whenever a source's native frame rate differed from the
// export's. Both were only found by a real human building a real video and
// reading real ffmpeg stderr — this file is what should have caught them
// first. Slower than the pure unit tests (spawns a real ffmpeg process a
// handful of times, generates tiny real fixture clips) but a real
// determinism/correctness net, same spirit as the app's own render-fixture
// hash tests (CLAUDE.md's "Determinism" testing rule).
//
// Skipped automatically (not failed) if `ffmpeg`/`ffprobe` aren't on PATH —
// this module has no other dependency on them, so a missing binary shouldn't
// break an otherwise-green CI run; the pure `timelineExport.test.ts` suite
// still exercises the compiler's own logic either way.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildExportFfmpegArgs } from './timelineExport';
import type { Clip, Timeline, Track } from './timeline';

function hasBinary(name: string): boolean {
  try {
    execFileSync(name, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const FFMPEG_AVAILABLE = hasBinary('ffmpeg') && hasBinary('ffprobe');

function clip(id: string, overrides: Partial<Clip> = {}): Clip {
  return {
    id,
    name: id,
    source_path: `/media/${id}.mov`,
    source_start: 0,
    duration: 48,
    source_len: 48,
    start_frame: 0,
    ...overrides,
  };
}

function track(kind: Track['kind'], clips: Clip[], overrides: Partial<Track> = {}): Track {
  return { kind, clips, ...overrides };
}

function timeline(tracks: Track[]): Timeline {
  return { id: 'tl', name: 'tl', tracks };
}

function ffprobeDurationSecs(path: string): number {
  const out = execFileSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    path,
  ]).toString().trim();
  return Number(out);
}

describe.skipIf(!FFMPEG_AVAILABLE)('buildExportFfmpegArgs — real ffmpeg execution', () => {
  let dir: string;
  // Two synthetic source clips at two DIFFERENT native frame rates — the
  // exact shape that exposed B-075 (24fps and 25fps, both different from
  // the 30fps export rate used below).
  let clip24: string;
  let clip25: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroma-export-test-'));
    clip24 = join(dir, 'src24.mp4');
    clip25 = join(dir, 'src25.mp4');
    execFileSync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'testsrc=duration=4:size=320x240:rate=24',
      '-pix_fmt', 'yuv420p', clip24,
    ]);
    execFileSync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'testsrc=duration=4:size=320x240:rate=25',
      '-pix_fmt', 'yuv420p', clip25,
    ]);
  }, 30000);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('B-075: a clip whose native fps differs from the export fps renders its REAL source duration, not a duration computed at the wrong rate', () => {
    // 96 source frames at 24fps = exactly 4s of real content. Exported at
    // 30fps, the pre-B-075 code would have computed -t = 96/30 = 3.2s
    // instead — a real, audible/visible truncation, not just a rounding
    // difference.
    const c = clip('c1', { source_path: clip24, source_fps: 24, duration: 96 });
    const tl = timeline([track('video', [c])]);
    const out = join(dir, 'out1.mp4');
    const args = buildExportFfmpegArgs(tl, out, { fps: 30, width: 320, height: 240 });

    execFileSync('ffmpeg', ['-y', ...args]);
    const durationSecs = ffprobeDurationSecs(out);

    expect(durationSecs).toBeGreaterThan(3.8); // ~4s real content
    expect(durationSecs).toBeLessThan(4.2);
  });

  it('B-075: two clips at two different native frame rates, stacked, both render for their own real duration in one export', () => {
    const after = clip('after', { source_path: clip24, source_fps: 24, duration: 96, position_y: 0 });
    const before = clip('before', { source_path: clip25, source_fps: 25, duration: 100, position_y: 0.5 }); // 100 frames @ 25fps = 4s
    const tl = timeline([track('video', [after]), track('video', [before])]);
    const out = join(dir, 'out2.mp4');
    const args = buildExportFfmpegArgs(tl, out, { fps: 30, width: 320, height: 480 });

    execFileSync('ffmpeg', ['-y', ...args]);
    const durationSecs = ffprobeDurationSecs(out);

    // The overall export should run for roughly the longer of the two real
    // clip durations (~4s each here), not something derived from dividing
    // either clip's frame count by the unrelated 30fps export rate.
    expect(durationSecs).toBeGreaterThan(3.8);
    expect(durationSecs).toBeLessThan(4.5);
  });

  it('B-075: a real ffmpeg run succeeds for a keyframed clip (the exact case the old unquoted x=/y= expression syntax error broke)', () => {
    const c = clip('c1', {
      source_path: clip24,
      source_fps: 24,
      duration: 96,
      scale: 1,
      chroma_keyframes: [
        { frame: 0, params: { scale: 1, position_x: 0, position_y: 0 } },
        { frame: 12, params: { scale: 1.2, position_x: -0.1, position_y: -0.1 } },
        { frame: 24, params: { scale: 1.2, position_x: -0.1, position_y: -0.1 } },
        { frame: 36, params: { scale: 1, position_x: 0, position_y: 0 } },
      ],
    });
    const tl = timeline([track('video', [c])]);
    const out = join(dir, 'out3.mp4');
    const args = buildExportFfmpegArgs(tl, out, { fps: 30, width: 320, height: 240 });

    // Must not throw — the pre-fix unquoted expression made ffmpeg reject
    // the whole filtergraph with a parse error and produce no output file
    // at all, regardless of any of the timing/duration math being right.
    expect(() => execFileSync('ffmpeg', ['-y', ...args], { stdio: 'pipe' })).not.toThrow();
    expect(ffprobeDurationSecs(out)).toBeGreaterThan(0);
  });

  it('D-188: a real ffmpeg run of a frozen (freezeOverrides) clip completes and produces the correct total duration — tpad\'s own syntax, for real', () => {
    // clip24 is 4s of real content; clip25 is also 4s. Freeze clip24 and
    // artificially treat clip25 as if it were longer by placing it starting
    // at t=2 — its own natural end (2 + 4 = 6s) becomes the real total, so
    // clip24 (frozen) must hold its last frame for 2 extra seconds.
    const shortFrozen = clip('short', { source_path: clip24, source_fps: 24, duration: 96, start_frame: 0 });
    const longer = clip('longer', {
      source_path: clip25, source_fps: 25, duration: 100, start_frame: 60, position_y: 0.5,
    }); // start_frame is a TIMELINE frame at opts.fps=30 -> starts at 2s, runs 4s -> ends at 6s
    const tl = timeline([track('video', [shortFrozen]), track('video', [longer])]);
    const out = join(dir, 'out4.mp4');
    const args = buildExportFfmpegArgs(tl, out, {
      fps: 30, width: 320, height: 480,
      freezeOverrides: { short: true },
    });

    expect(() => execFileSync('ffmpeg', ['-y', ...args], { stdio: 'pipe' })).not.toThrow();
    const durationSecs = ffprobeDurationSecs(out);
    expect(durationSecs).toBeGreaterThan(5.7); // ~6s total, not clip24's own natural 4s
    expect(durationSecs).toBeLessThan(6.3);
  });
});

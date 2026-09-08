// @chroma/editor — unit tests for `speedRamp.ts` (D-236).
//
// Three things are pinned here, in order of how much they matter:
//
//  1. **The flat case is untouched.** A clip with no ramp, and a clip carrying
//     only an export-time `speedOverrides` entry, must resolve to exactly one
//     segment and to exactly the numbers every pre-D-236 call site computed
//     inline (`duration`, `duration / speed`). This is what lets the whole
//     feature land without moving a single existing export by a frame.
//  2. **The two directions are exact inverses.** `outputAtSourceFrame` is what
//     the exporter's `setpts` expression is built from; `sourceFrameAtOutput`
//     is what the preview decodes with. If they ever disagree, the preview and
//     the file disagree — the B-090/B-094/B-095/B-098/B-103/B-108 failure mode.
//  3. **The generated ffmpeg expression really evaluates to the forward map.**
//     Checked by interpreting the emitted string, so a malformed or subtly
//     wrong expression fails here rather than silently rendering wrong pixels.
//     (`speedRamp.ffmpeg.test.ts` then proves the same thing against real
//     decoded pixels out of real ffmpeg — this is the fast inner loop.)
import { describe, expect, it } from 'vitest';

import {
  clampSpeed,
  flatSpeedOf,
  hasSpeedRamp,
  isFlatSegments,
  MAX_SPEED,
  MIN_SPEED,
  normalizeSpeedPoints,
  outputAtSourceFrame,
  rampAudioSegments,
  rampOutputSourceFrames,
  rampSetptsSecondsExpr,
  resolveSpeedSegments,
  sourceFrameAtOutput,
  type SpeedPoint,
} from './speedRamp';
import { clipOutputSourceFrames, clipSourceFrameAt, clipTimelineFrameAtSource, endFrame, type Clip } from './timeline';
import { buildAudioSourceChain } from './timelineExportAudio';

const FPS = 24;

function clip(over: Partial<Clip> = {}): Clip {
  return {
    id: 'c',
    name: 'c',
    source_path: '/c.mov',
    source_start: 0,
    duration: 96,
    source_len: 96,
    source_fps: FPS,
    start_frame: 0,
    ...over,
  };
}

/** The ramp used throughout: 0.5x for 18 frames, 2x for 48, 1.25x for 30.
 *  36 + 24 + 24 = 84 output frames from 96 source frames. */
const RAMP: SpeedPoint[] = [
  { source_frame: 0, speed: 0.5 },
  { source_frame: 18, speed: 2 },
  { source_frame: 66, speed: 1.25 },
];

/** A tiny interpreter for the `if(lt(a,b),x,y)` subset `rampSetptsSecondsExpr`
 *  emits, with `T` bound to `t`. Mirrors `timelineExport.test.ts`'s own
 *  `evalExpr` in spirit: every name here is a real ffmpeg expression-language
 *  function with these exact semantics, which is what makes evaluating a
 *  generated expression in JS a meaningful check on it rather than a
 *  restatement. */
function evalExpr(expr: string, t: number): number {
  const lt = (a: number, b: number) => (a < b ? 1 : 0);
  const iff = (c: number, a: number, b: number) => (c ? a : b);
  // eslint-disable-next-line no-new-func -- test-only interpreter over a
  // closed, generated expression set; see the comment above.
  const fn = new Function('T', 'lt', 'if_', `return (${expr.replace(/\bif\(/g, 'if_(')});`) as (
    T: number,
    ltFn: typeof lt,
    ifFn: typeof iff,
  ) => number;
  return fn(t, lt, iff);
}

describe('clampSpeed', () => {
  it('keeps a real speed and refuses everything that would break the remap', () => {
    expect(clampSpeed(2)).toBe(2);
    expect(clampSpeed(0.5)).toBe(0.5);
    // Zero, negative (reverse — deliberately out of scope) and non-finite all
    // resolve to the identity rather than to an infinite or backwards remap.
    for (const bad of [0, -2, NaN, Infinity]) expect(clampSpeed(bad)).toBe(1);
    expect(clampSpeed(1e6)).toBe(MAX_SPEED);
    expect(clampSpeed(1e-6)).toBe(MIN_SPEED);
  });
});

describe('normalizeSpeedPoints', () => {
  it('sorts and dedupes by frame, last write wins', () => {
    expect(normalizeSpeedPoints(undefined)).toEqual([]);
    expect(normalizeSpeedPoints([])).toEqual([]);
    expect(
      normalizeSpeedPoints([
        { source_frame: 40, speed: 2 },
        { source_frame: 10, speed: 0.5 },
      ]),
    ).toEqual([
      { source_frame: 10, speed: 0.5 },
      { source_frame: 40, speed: 2 },
    ]);
    expect(
      normalizeSpeedPoints([
        { source_frame: 10, speed: 0.5 },
        { source_frame: 10, speed: 3 },
      ]),
    ).toEqual([{ source_frame: 10, speed: 3 }]);
  });

  it('KEEPS a redundant point — a split you have not chosen a speed for yet is real', () => {
    // Dropping these looked like tidying and was destructive: it deleted the
    // split the editor had just made, before a speed could be typed into it.
    // See `normalizeSpeedPoints`' own doc, and the DOM test that caught it.
    expect(normalizeSpeedPoints([{ source_frame: 0, speed: 1 }])).toEqual([{ source_frame: 0, speed: 1 }]);
    expect(
      normalizeSpeedPoints([
        { source_frame: 10, speed: 2 },
        { source_frame: 40, speed: 2 },
      ]),
    ).toHaveLength(2);
  });

  it('a clip split at 1x still reads as FLAT, so it compiles the pre-D-236 path', () => {
    // The point survives, but nothing about how the clip plays has changed —
    // so no ramp expression is emitted and its length is untouched.
    const c = clip({ speed_points: [{ source_frame: 40, speed: 1 }] });
    const segs = resolveSpeedSegments(c);
    expect(segs).toHaveLength(2);
    expect(isFlatSegments(segs)).toBe(true);
    expect(rampSetptsSecondsExpr(segs, FPS)).toBeNull();
    expect(rampOutputSourceFrames(segs)).toBe(96);
    expect(endFrame(c, FPS)).toBe(96);
    // ...and it must not trip any "a speed change is incompatible" refusal.
    expect(hasSpeedRamp(c)).toBe(false);
  });
});

describe('resolveSpeedSegments — the flat case is exactly the pre-D-236 behaviour', () => {
  it('no ramp and no override is one identity segment of the clip\'s own window', () => {
    const segs = resolveSpeedSegments(clip());
    expect(segs).toEqual([{ startSourceFrame: 0, endSourceFrame: 96, speed: 1 }]);
    expect(isFlatSegments(segs)).toBe(true);
    expect(rampOutputSourceFrames(segs)).toBe(96); // === clip.duration
    // ...and it compiles to NO ramp expression at all, so `buildClipFilterChain`
    // keeps its byte-identical `PTS` / `PTS/<speed>` form.
    expect(rampSetptsSecondsExpr(segs, FPS)).toBeNull();
  });

  it('an export-time flat override is a one-segment ramp at that speed', () => {
    const segs = resolveSpeedSegments(clip(), 1.5);
    expect(segs).toEqual([{ startSourceFrame: 0, endSourceFrame: 96, speed: 1.5 }]);
    expect(flatSpeedOf(segs)).toBe(1.5);
    expect(rampOutputSourceFrames(segs)).toBe(96 / 1.5); // === duration / speed
    expect(rampSetptsSecondsExpr(segs, FPS)).toBeNull();
  });

  it('a clip\'s own ramp beats an export-time override rather than multiplying with it', () => {
    // Precedence, not composition: the ramp is what the preview shows, so
    // silently multiplying would make the file match neither the preview nor
    // the export dialog's own number.
    const segs = resolveSpeedSegments(clip({ speed_points: [{ source_frame: 0, speed: 4 }] }), 1.5);
    expect(segs).toEqual([{ startSourceFrame: 0, endSourceFrame: 96, speed: 4 }]);
  });
});

describe('resolveSpeedSegments — a real ramp', () => {
  it('splits the trim window at its points', () => {
    expect(resolveSpeedSegments(clip({ speed_points: RAMP }))).toEqual([
      { startSourceFrame: 0, endSourceFrame: 18, speed: 0.5 },
      { startSourceFrame: 18, endSourceFrame: 66, speed: 2 },
      { startSourceFrame: 66, endSourceFrame: 96, speed: 1.25 },
    ]);
  });

  it('survives a trim: a point before the in-point still governs the head', () => {
    // Trimmed to source [30, 90) — the 2x point at 18 is now outside the
    // window, but it is still the speed in force at frame 30. Anchoring points
    // to ABSOLUTE source frames is what makes this true; clip-relative points
    // would have slid the whole ramp when the head moved.
    const segs = resolveSpeedSegments(clip({ source_start: 30, duration: 60, speed_points: RAMP }));
    expect(segs).toEqual([
      { startSourceFrame: 30, endSourceFrame: 66, speed: 2 },
      { startSourceFrame: 66, endSourceFrame: 90, speed: 1.25 },
    ]);
  });

  it('a zero-length clip still yields one indexable segment', () => {
    const segs = resolveSpeedSegments(clip({ duration: 0, speed_points: RAMP }));
    expect(segs).toHaveLength(1);
    expect(rampOutputSourceFrames(segs)).toBe(0);
  });
});

describe('the forward and inverse maps', () => {
  const segs = resolveSpeedSegments(clip({ speed_points: RAMP }));

  it('sums to the retimed output length', () => {
    // 18/0.5 + 48/2 + 30/1.25 = 36 + 24 + 24
    expect(rampOutputSourceFrames(segs)).toBe(84);
    expect(outputAtSourceFrame(segs, 96)).toBe(84);
    expect(outputAtSourceFrame(segs, 18)).toBe(36);
    expect(outputAtSourceFrame(segs, 66)).toBe(60);
  });

  it('are exact inverses, inside the clip and extrapolating outside it', () => {
    for (let i = -40; i <= 260; i++) {
      const x = i * 0.5;
      expect(outputAtSourceFrame(segs, sourceFrameAtOutput(segs, x))).toBeCloseTo(x, 9);
    }
  });

  it('is strictly monotone — a retime never plays a frame backwards', () => {
    let prev = -Infinity;
    for (let x = 0; x <= 84; x += 0.25) {
      const s = sourceFrameAtOutput(segs, x);
      expect(s).toBeGreaterThan(prev);
      prev = s;
    }
  });
});

describe('rampSetptsSecondsExpr — the exporter\'s own expression', () => {
  const segs = resolveSpeedSegments(clip({ speed_points: RAMP }));

  it('evaluates to exactly the forward map, at and around every knot', () => {
    const expr = rampSetptsSecondsExpr(segs, FPS);
    expect(expr).not.toBeNull();
    if (expr === null) return;
    // Sampled densely across the whole clip, in SECONDS on both axes — the
    // units ffmpeg's own `T` is in.
    for (let f = 0; f <= 96; f += 0.5) {
      const expected = outputAtSourceFrame(segs, f) / FPS;
      expect(evalExpr(expr, f / FPS)).toBeCloseTo(expected, 5);
    }
  });

  it('carries no bare comma outside a function call — a filtergraph would split on it', () => {
    // The quoting that makes this safe lives in `buildClipFilterChain`; this
    // pins that the expression itself is a single term, which is what that
    // quoting assumes. An unquoted comma is precisely how the first real-ffmpeg
    // run of this feature failed ("No such filter: '0.75)'").
    const expr = rampSetptsSecondsExpr(segs, FPS) ?? '';
    let depth = 0;
    for (const ch of expr) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === ',') expect(depth).toBeGreaterThan(0);
    }
    expect(depth).toBe(0);
  });
});

describe('rampAudioSegments', () => {
  it('gives each segment its source window in seconds from the clip\'s in-point', () => {
    // `atempo` takes a constant, so this list IS the audio implementation of a
    // ramp — see `buildRampedAtempoSteps`.
    expect(rampAudioSegments(resolveSpeedSegments(clip({ speed_points: RAMP })), FPS)).toEqual([
      { startSec: 0, endSec: 0.75, speed: 0.5 },
      { startSec: 0.75, endSec: 2.75, speed: 2 },
      { startSec: 2.75, endSec: 4, speed: 1.25 },
    ]);
  });

  it('a flat clip emits no retime node at all, on EITHER half of the chain', () => {
    // The picture and the sound must make the same flat/ramped call, or one
    // half of a clip gets retimed and the other does not. Both ask
    // `isFlatSegments`, so this pins them together: a clip split at 1x emits
    // neither a `setpts` ramp expression nor an `asplit`/`atempo`/`concat`.
    const split = resolveSpeedSegments(clip({ speed_points: [{ source_frame: 40, speed: 1 }] }));
    expect(split).toHaveLength(2);
    expect(isFlatSegments(split)).toBe(true);
    expect(rampSetptsSecondsExpr(split, FPS)).toBeNull();
    const chain = buildAudioSourceChain({
      srcRef: '[0:a]',
      clip: clip({ speed_points: [{ source_frame: 40, speed: 1 }] }),
      clipFps: FPS,
      gain: 1,
      speedSegments: split,
      startSec: 0,
      duck: null,
      idLabel: 'au0',
    });
    expect(chain.steps.join(' ')).not.toContain('atempo');
    expect(chain.steps.join(' ')).not.toContain('concat');
  });

  it('a real ramp DOES emit the per-segment atempo/concat chain', () => {
    const segs = resolveSpeedSegments(clip({ speed_points: RAMP }));
    const chain = buildAudioSourceChain({
      srcRef: '[0:a]',
      clip: clip({ speed_points: RAMP }),
      clipFps: FPS,
      gain: 1,
      speedSegments: segs,
      startSec: 0,
      duck: null,
      idLabel: 'au0',
    });
    const graph = chain.steps.join(' ');
    // One `atrim` window per segment, and one `concat` joining all three —
    // this IS the audio implementation of a ramp (see `speedRamp.ts`'s module
    // doc on why `atempo` forces the model to be piecewise constant).
    expect(graph).toContain('asplit=3');
    expect(graph).toContain('concat=n=3:v=0:a=1');
    expect(graph).toContain('atempo=0.5');
    expect(graph).toContain('atempo=2');
    expect(graph).toContain('atempo=1.25');
  });

  it('is rebased on the clip\'s own in-point, not the file\'s start', () => {
    const segs = resolveSpeedSegments(clip({ source_start: 24, duration: 48, speed_points: RAMP }));
    expect(rampAudioSegments(segs, FPS)[0].startSec).toBe(0);
  });
});

describe('the timeline model reads the ramp through one definition', () => {
  it('endFrame reflects the retimed length; an un-ramped clip is untouched', () => {
    expect(endFrame(clip(), FPS)).toBe(96);
    expect(clipOutputSourceFrames(clip())).toBe(96);
    const ramped = clip({ speed_points: RAMP });
    expect(clipOutputSourceFrames(ramped)).toBe(84);
    expect(endFrame(ramped, FPS)).toBe(84);
    // A clip that does not start at 0 keeps its placement — a ramp changes a
    // clip's LENGTH, never where it sits.
    expect(endFrame(clip({ start_frame: 50, speed_points: RAMP }), FPS)).toBe(134);
  });

  it('rounds the retimed length BEFORE the fps conversion, exactly as Rust does', () => {
    // `chroma_timeline::Clip::end_frame_at` hands an `i64` to
    // `source_frames_to_timeline`, so it necessarily rounds first. Rounding in
    // the other order is more accurate and WRONG, because it makes the preview
    // and the model disagree by a frame on a mixed-native-fps ramped clip —
    // the exact class of quiet divergence D-236 exists to prevent.
    //
    // A case where the two orders genuinely give different answers, so this
    // discriminates rather than restating the implementation.
    //
    // 25 fps source in a 24 fps project: 43 source frames at 2x (21.5 output)
    // + 62 at 1x (62) = 83.5 source frames of output.
    //   round-first: round(83.5) = 84, then 84 * 24/25 = 80.64 -> 81
    //   round-last:  83.5 * 24/25 = 80.16            -> 80
    const c = clip({
      source_fps: 25,
      duration: 105,
      source_len: 105,
      speed_points: [
        { source_frame: 0, speed: 2 },
        { source_frame: 43, speed: 1 },
      ],
    });
    expect(clipOutputSourceFrames(c)).toBe(83.5);
    expect(endFrame(c, 24)).toBe(81);
  });

  it('clipSourceFrameAt agrees with the export, and floors rather than rounds', () => {
    const c = clip({ speed_points: RAMP });
    // The 0.5x head: two output frames per source frame.
    expect(clipSourceFrameAt(c, 0, FPS)).toBe(0);
    expect(clipSourceFrameAt(c, 1, FPS)).toBe(0); // floor(0.5), NOT round -> 1
    expect(clipSourceFrameAt(c, 2, FPS)).toBe(1);
    expect(clipSourceFrameAt(c, 35, FPS)).toBe(17);
    // The 2x run starts exactly where the slow one ended.
    expect(clipSourceFrameAt(c, 36, FPS)).toBe(18);
    expect(clipSourceFrameAt(c, 37, FPS)).toBe(20);
    // The 1.25x tail.
    expect(clipSourceFrameAt(c, 60, FPS)).toBe(66);
    expect(clipSourceFrameAt(c, 83, FPS)).toBe(94);
    // An un-ramped clip takes the original linear path unchanged.
    expect(clipSourceFrameAt(clip(), 37, FPS)).toBe(37);
  });

  it('clipTimelineFrameAtSource is the inverse the GUI draws points with', () => {
    const c = clip({ speed_points: RAMP });
    for (const sourceFrame of [0, 18, 40, 66, 95]) {
      const tl = clipTimelineFrameAtSource(c, sourceFrame, FPS);
      // Round-trips back to the same source frame (within the one frame of
      // quantisation `floor` deliberately introduces).
      expect(Math.abs(clipSourceFrameAt(c, tl, FPS) - sourceFrame)).toBeLessThanOrEqual(1);
    }
    expect(clipTimelineFrameAtSource(c, 18, FPS)).toBe(36);
    expect(clipTimelineFrameAtSource(c, 66, FPS)).toBe(60);
  });

  it('hasSpeedRamp is false for every shape that means "no ramp"', () => {
    expect(hasSpeedRamp(clip())).toBe(false);
    expect(hasSpeedRamp(clip({ speed_points: [] }))).toBe(false);
    expect(hasSpeedRamp(clip({ speed_points: [{ source_frame: 0, speed: 1 }] }))).toBe(false);
    expect(hasSpeedRamp(clip({ speed_points: [{ source_frame: 40, speed: 1 }] }))).toBe(false);
    expect(hasSpeedRamp(clip({ speed_points: RAMP }))).toBe(true);
  });
});

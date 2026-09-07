// @chroma/editor — unit tests for `timelineExportAudio.ts`'s pure math:
// the fade-curve solver/sampler, the duck one-pole envelope, and the atempo
// speed-factor decomposition. These pin the math against known-correct
// reference values (the Rust engine's own presets/test numbers where
// available) rather than only checking "it produced a string" — the exact
// rigor gap `timelineExport.ffmpeg.test.ts`'s own header calls out for
// string-only tests.
import { describe, expect, it } from 'vitest';
import {
  atempoFactors,
  buildDuckSegments,
  dbToLinear,
  duckGainExpr,
  fadeCurveEval,
  fadeGainAt,
  fadeGainExpr,
  resolveDuckForTrack,
  type DuckSegment,
} from './timelineExportAudio';
import { FADE_PRESETS } from './timeline';
import type { Clip, Timeline, Track } from './timeline';

/** A tiny ffmpeg-expression interpreter for the subset this module emits
 *  (`if`, `between`, `lt`, `exp`) — mirrors `timelineExport.test.ts`'s own
 *  `evalExpr` helper, extended with `exp` for the duck expressions. */
function evalExpr(expr: string, t: number): number {
  const rewritten = expr.replace(/\bif\(/g, 'iff(');
  const iff = (cond: boolean, a: number, b: number) => (cond ? a : b);
  const between = (x: number, a: number, b: number) => x >= a && x <= b;
  const lt = (a: number, b: number) => a < b;
  const exp = Math.exp;
  // eslint-disable-next-line no-new-func
  const fn = new Function('t', 'iff', 'between', 'lt', 'exp', `return ${rewritten};`);
  return fn(t, iff, between, lt, exp) as number;
}

const LINEAR = FADE_PRESETS.find((p) => p.name === 'linear')!.curve;
const EASE_IN = FADE_PRESETS.find((p) => p.name === 'ease-in')!.curve;

function clip(id: string, overrides: Partial<Clip> = {}): Clip {
  return {
    id,
    name: id,
    source_path: `/media/${id}.mov`,
    source_start: 0,
    duration: 240,
    source_len: 240,
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

describe('fadeCurveEval', () => {
  it('linear is the exact identity, y = x, at every x', () => {
    for (const x of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      expect(fadeCurveEval(LINEAR, x)).toBeCloseTo(x, 9);
    }
  });

  it('is exact at both endpoints regardless of the curve', () => {
    expect(fadeCurveEval(EASE_IN, 0)).toBe(0);
    expect(fadeCurveEval(EASE_IN, 1)).toBe(1);
  });

  it('ease-in is slow-start (below the diagonal early on)', () => {
    expect(fadeCurveEval(EASE_IN, 0.25)).toBeLessThan(0.25);
  });
});

describe('fadeGainAt', () => {
  it('returns exactly 1.0 when neither window is configured — the backward-compatibility short-circuit', () => {
    expect(fadeGainAt(5, 10, 0, 0, LINEAR, LINEAR)).toBe(1);
  });

  it('is exactly silent at both fade boundaries and unity well clear of both windows (mirrors the Rust audio.rs test of the same name)', () => {
    // 10s clip, 1s fade in, 1s fade out (250 frames @ 25fps in the Rust test).
    expect(fadeGainAt(0, 10, 1, 1, LINEAR, LINEAR)).toBe(0);
    expect(fadeGainAt(10, 10, 1, 1, LINEAR, LINEAR)).toBe(0); // the out-point
    expect(fadeGainAt(5, 10, 1, 1, LINEAR, LINEAR)).toBeCloseTo(1, 6);
  });

  it('overlapping fade-in/fade-out windows multiply rather than clamp', () => {
    // A 10-frame clip with a 10-frame fade in AND out is 0.5*0.5=0.25 in the middle.
    expect(fadeGainAt(5, 10, 10, 10, LINEAR, LINEAR)).toBeCloseTo(0.25, 6);
  });

  it('clamps the result to 0..1', () => {
    const g = fadeGainAt(2, 10, 4, 0, LINEAR, LINEAR);
    expect(g).toBeGreaterThanOrEqual(0);
    expect(g).toBeLessThanOrEqual(1);
  });
});

describe('fadeGainExpr', () => {
  it('returns null when neither window is configured — no volume filter needed at all', () => {
    expect(fadeGainExpr(10, 0, 0, LINEAR, LINEAR, 't')).toBeNull();
  });

  it('the sampled piecewise-linear expression closely approximates the real fadeGainAt at unsampled points', () => {
    const expr = fadeGainExpr(10, 2, 2, EASE_IN, EASE_IN, 't');
    expect(expr).not.toBeNull();
    for (const t of [0, 0.3, 0.7, 1.3, 1.9, 5, 8.1, 8.7, 9.4, 10]) {
      const approx = evalExpr(expr!, t);
      const real = fadeGainAt(t, 10, 2, 2, EASE_IN, EASE_IN);
      expect(Math.abs(approx - real)).toBeLessThan(0.01);
    }
  });

  it('holds at unity before/after the fade windows, and at the endpoints', () => {
    const expr = fadeGainExpr(10, 1, 1, LINEAR, LINEAR, 't')!;
    expect(evalExpr(expr, 5)).toBeCloseTo(1, 6);
    expect(evalExpr(expr, 0)).toBeCloseTo(0, 6);
    expect(evalExpr(expr, 10)).toBeCloseTo(0, 6);
  });
});

describe('dbToLinear', () => {
  it('matches the standard amplitude ratios', () => {
    expect(dbToLinear(0)).toBeCloseTo(1, 9);
    expect(dbToLinear(-6.0206)).toBeCloseTo(0.5, 4);
    expect(dbToLinear(20)).toBeCloseTo(10, 6);
  });

  it('degrades non-finite input to unity rather than NaN', () => {
    expect(dbToLinear(NaN)).toBe(1);
    expect(dbToLinear(Infinity)).toBe(1);
  });
});

describe('buildDuckSegments', () => {
  it('a 0 dB duck is None — nothing to apply, byte-identical to unducked', () => {
    expect(buildDuckSegments([[1, 2]], 0, 10, 300)).toBeNull();
  });

  it('empty trigger spans is None — the trigger track never sounds in this session', () => {
    expect(buildDuckSegments([], -12, 10, 300)).toBeNull();
  });

  it('a session starting outside a trigger clip opens un-ducked (presence 0 at t=0)', () => {
    const built = buildDuckSegments([[2, 3]], -12, 10, 300)!;
    expect(built).not.toBeNull();
    expect(built.segments[0].t0).toBe(0);
    expect(built.segments[0].entry).toBe(0);
    expect(built.segments[0].target).toBe(0);
  });

  it('a session starting INSIDE a trigger clip opens already fully ducked (D-149\'s own "mid-VO" case)', () => {
    const built = buildDuckSegments([[0, 5]], -12, 10, 300)!;
    // First segment must already be in its own steady state — entry === target.
    expect(built.segments[0].t0).toBe(0);
    expect(built.segments[0].target).toBe(1);
    expect(built.segments[0].entry).toBe(1);
  });
});

describe('duckGainExpr', () => {
  it('evaluates to the exact one-pole closed form at real gain_at values (mirrors chroma_media::audio::DuckEnvelope tests)', () => {
    const built = buildDuckSegments([[2, 3]], -12, 10, 300)!;
    const expr = duckGainExpr(built.segments, built.duckedGain, 't');
    // Before the trigger: unity.
    expect(evalExpr(expr, 0)).toBeCloseTo(1, 6);
    // Long after the trigger ends (release settled): back near unity.
    expect(evalExpr(expr, 3 + 5)).toBeGreaterThan(0.95);
    // Deep inside the trigger, well past the attack: near the fully-ducked level.
    const duckedLinear = dbToLinear(-12);
    expect(evalExpr(expr, 2 + 0.5)).toBeCloseTo(duckedLinear, 1);
  });

  it('the timeVar can be an arbitrary sub-expression (session-shift for a clip-local filter chain)', () => {
    const built = buildDuckSegments([[2, 3]], -12, 10, 300)!;
    const exprShifted = duckGainExpr(built.segments, built.duckedGain, '(t+2)');
    const exprPlain = duckGainExpr(built.segments, built.duckedGain, 't');
    // Evaluating the shifted expression at clip-local t=0 should match the
    // plain expression at session t=2 (the clip starts 2s into the session).
    expect(evalExpr(exprShifted, 0)).toBeCloseTo(evalExpr(exprPlain, 2), 6);
  });
});

describe('resolveDuckForTrack', () => {
  function ducked(duckFrom: number | null, duckDb = -12): Track {
    return track('audio', [], { duck_from: duckFrom, duck_db: duckDb, duck_attack_ms: 10, duck_release_ms: 300 });
  }

  it('no duck_from set resolves to null', () => {
    const tl = timeline([ducked(null), track('video', [])]);
    expect(resolveDuckForTrack(tl, 0, 30)).toBeNull();
  });

  it('a track cannot duck from itself', () => {
    const tl = timeline([ducked(0)]);
    expect(resolveDuckForTrack(tl, 0, 30)).toBeNull();
  });

  it('a duck_from naming no real track resolves to null', () => {
    const tl = timeline([ducked(5)]);
    expect(resolveDuckForTrack(tl, 0, 30)).toBeNull();
  });

  it('a real duck resolves using the TRIGGER track\'s own clip spans, converted timeline-frames -> seconds at the export fps', () => {
    const trigger = track('video', [clip('dialogue', { start_frame: 30, duration: 60, source_fps: 30 })]);
    const tl = timeline([ducked(1), trigger]);
    const built = resolveDuckForTrack(tl, 0, 30)!;
    expect(built).not.toBeNull();
    // start_frame=30 @ 30fps timeline -> 1s; duration=60 source frames @
    // 30fps source (== timeline fps here) -> 2s -> spans [1,3).
    const expr = duckGainExpr(built.segments, built.duckedGain, 't');
    expect(evalExpr(expr, 0)).toBeCloseTo(1, 6); // before the trigger
    expect(evalExpr(expr, 1.5)).toBeLessThan(0.9); // inside it, well past attack
  });

  it('uses the CORRECTED fps-aware span math (endFrame), not B-079\'s still-buggy raw start_frame+duration', () => {
    // A trigger clip at a DIFFERENT native fps than the timeline: 48 source
    // frames @ 48fps = 1s of real content, but at the 24fps timeline rate
    // that is 24 TIMELINE frames — not 48. A B-079-style conflation would
    // treat it as if it covered frames [0,48) i.e. 2 real timeline seconds.
    const trigger = track('video', [clip('d', { start_frame: 0, duration: 48, source_fps: 48 })]);
    const tl = timeline([ducked(1), trigger]);
    const built = resolveDuckForTrack(tl, 0, 24)!;
    const expr = duckGainExpr(built.segments, built.duckedGain, 't');
    // The trigger's real span is [0,1) seconds at a 24fps timeline, so
    // release begins at t=1 (300ms release tau): at t=1.5 (0.5s into
    // release) the gain has climbed most of the way back toward unity
    // (~0.86, the exact one-pole value). A B-079-style conflation would
    // mis-read the span as [0,2) (never converted source frames -> timeline
    // frames) and still be FULLY engaged at t=1.5 — the fully-ducked linear
    // level, ~0.25 — a huge, easily distinguished gap from the correct value.
    expect(evalExpr(expr, 1.5)).toBeGreaterThan(0.7);
  });
});

describe('atempoFactors', () => {
  it('a single factor within [0.5, 2.0] is unchanged', () => {
    expect(atempoFactors(1.5)).toEqual([1.5]);
    expect(atempoFactors(0.5)).toEqual([0.5]);
    expect(atempoFactors(2.0)).toEqual([2.0]);
  });

  it('decomposes an out-of-range speed into a chain whose product equals the requested speed', () => {
    for (const speed of [0.1, 0.25, 3, 4, 8]) {
      const factors = atempoFactors(speed);
      for (const f of factors) {
        expect(f).toBeGreaterThanOrEqual(0.5);
        expect(f).toBeLessThanOrEqual(2.0);
      }
      const product = factors.reduce((a, b) => a * b, 1);
      expect(product).toBeCloseTo(speed, 6);
    }
  });
});

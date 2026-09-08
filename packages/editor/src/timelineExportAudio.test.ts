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
  buildAudioSourceChain,
  buildDuckSegments,
  clipAudioParam,
  dbToLinear,
  duckGainExpr,
  fadeGainAt,
  fadeGainExpr,
  panGainExprs,
  resolveDuckForTrack,
  type DuckSegment,
} from './timelineExportAudio';
import { EASE_PRESETS, panGains } from './timeline';
import { easeCurveEval } from './easeCurve';
import { resolveSpeedSegments } from './speedRamp';
import type { Clip, Timeline, Track } from './timeline';

/** D-235 — the one-segment speed ramp that IS "this clip plays at `speed`",
 *  which is what these tests used to pass as a bare number. `speedRamp.test.ts`
 *  pins separately that a flat ramp resolves to exactly one segment. */
const flat = (c: Clip, speed = 1) => resolveSpeedSegments(c, speed);

/** A tiny ffmpeg-expression interpreter for the subset this module emits
 *  (`if`, `between`, `lt`, `exp`, and D-223's `clip`/`cos`/`sin`/`max`/`PI`)
 *  — mirrors `timelineExport.test.ts`'s own `evalExpr` helper. Every name
 *  here is a real ffmpeg expression-language function with these exact
 *  semantics, which is what makes evaluating a generated expression in JS a
 *  meaningful check of what ffmpeg will do with it. */
function evalExpr(expr: string, t: number): number {
  const rewritten = expr
    .replace(/\bif\(/g, 'iff(')
    // `piecewiseLinearExpr` legitimately emits `(1--1)` when a key's value is
    // negative (a pan sweeping from -1, for instance). ffmpeg's own expression
    // parser evaluates that correctly — verified directly on the CLI, not
    // assumed — but JavaScript's tokenizer reads `--` as the decrement
    // operator and throws before the expression is ever evaluated. Spacing it
    // out is a fix to THIS TEST HELPER, not a change to what ffmpeg is given.
    .replace(/--/g, '- -');
  const iff = (cond: boolean, a: number, b: number) => (cond ? a : b);
  const between = (x: number, a: number, b: number) => x >= a && x <= b;
  const lt = (a: number, b: number) => a < b;
  const exp = Math.exp;
  const clipFn = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);
  const { cos, sin, max } = Math;
  const PI = Math.PI;
  // eslint-disable-next-line no-new-func
  const fn = new Function(
    't', 'iff', 'between', 'lt', 'exp', 'clip', 'cos', 'sin', 'max', 'PI',
    `return ${rewritten};`,
  );
  return fn(t, iff, between, lt, exp, clipFn, cos, sin, max, PI) as number;
}

const LINEAR = EASE_PRESETS.find((p) => p.name === 'linear')!.curve;
const EASE_IN = EASE_PRESETS.find((p) => p.name === 'ease-in')!.curve;

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

describe('easeCurveEval', () => {
  it('linear is the exact identity, y = x, at every x', () => {
    for (const x of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      expect(easeCurveEval(LINEAR, x)).toBeCloseTo(x, 9);
    }
  });

  it('is exact at both endpoints regardless of the curve', () => {
    expect(easeCurveEval(EASE_IN, 0)).toBe(0);
    expect(easeCurveEval(EASE_IN, 1)).toBe(1);
  });

  it('ease-in is slow-start (below the diagonal early on)', () => {
    expect(easeCurveEval(EASE_IN, 0.25)).toBeLessThan(0.25);
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

// --------------------------------------------------------------------------- //
// D-223 — per-clip volume + pan
// --------------------------------------------------------------------------- //

describe('panGains — the pan law itself', () => {
  it('is bit-exactly the identity at centre, and exactly silent in the far channel at the extremes', () => {
    // The migration property: every pre-D-223 clip is pan 0 and must be
    // untouched, not "multiplied by something that rounds to 1".
    expect(panGains(0)).toEqual([1, 1]);
    expect(panGains(-1)).toEqual([Math.SQRT2, 0]);
    expect(panGains(1)).toEqual([0, Math.SQRT2]);
  });

  it('holds constant power across the whole sweep (gl^2 + gr^2 === 2)', () => {
    // The defining property of a constant-power law, checked as arithmetic —
    // the same assertion `chroma_types::pan::tests` makes about the Rust
    // implementation, so the two are pinned to one law rather than to each
    // other's current output.
    for (let i = -100; i <= 100; i++) {
      const [l, r] = panGains(i / 100);
      expect(l * l + r * r).toBeCloseTo(2, 9);
    }
  });

  it('clamps out of range and reads nonsense as centre', () => {
    expect(panGains(-4)).toEqual(panGains(-1));
    expect(panGains(4)).toEqual(panGains(1));
    expect(panGains(NaN)).toEqual([1, 1]);
  });
});

describe('panGainExprs', () => {
  it('the generated ffmpeg expression evaluates to the SAME gains panGains computes', () => {
    // This is the real cross-check: the export writes the law as an ffmpeg
    // expression rather than as sampled points, so what must be proven is that
    // the expression IS the law — at every pan, not just at the endpoints.
    for (const pan of [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1]) {
      const [lExpr, rExpr] = panGainExprs(String(pan));
      const [l, r] = panGains(pan);
      expect(evalExpr(lExpr, 0)).toBeCloseTo(l, 12);
      expect(evalExpr(rExpr, 0)).toBeCloseTo(r, 12);
    }
  });

  it('clamps an out-of-range pan expression rather than letting the cosine come back up', () => {
    // Past hard left the un-clamped cosine would start RISING again on the
    // far channel — a pan of -3 quietly sounding like -0 — which is why
    // `clip()` is in the expression at all.
    const [lExpr, rExpr] = panGainExprs('-3');
    expect(evalExpr(lExpr, 0)).toBeCloseTo(Math.SQRT2, 12);
    expect(evalExpr(rExpr, 0)).toBeCloseTo(0, 12);
  });
});

describe('clipAudioParam', () => {
  it('an unkeyed clip is static at its own stored value, defaulting to the identity', () => {
    expect(clipAudioParam(clip('a'), 'volume', 1, 24, flat(clip('a')))).toEqual({ kind: 'static', value: 1 });
    expect(clipAudioParam(clip('a', { volume: 0.5 }), 'volume', 1, 24, flat(clip('a')))).toEqual({
      kind: 'static',
      value: 0.5,
    });
    expect(clipAudioParam(clip('a', { pan: -0.5 }), 'pan', 0, 24, flat(clip('a')))).toEqual({
      kind: 'static',
      value: -0.5,
    });
  });

  it('keys become a piecewise-linear expression in CLIP-LOCAL seconds, rebased on source_start', () => {
    // Keyframe frames are SOURCE frames; the clip's input is `-ss`-trimmed to
    // its in-point, so its own `t` is 0 there. A clip trimmed 24 frames in
    // (1s at 24fps) must not have its automation slide by that second.
    const c = clip('a', {
      source_start: 24,
      chroma_keyframes: [
        { frame: 24, params: { volume: 0 } },
        { frame: 72, params: { volume: 1 } },
      ],
    });
    const v = clipAudioParam(c, 'volume', 1, 24, flat(c));
    expect(v.kind).toBe('keys');
    if (v.kind !== 'keys') return;
    expect(evalExpr(v.expr, 0)).toBeCloseTo(0, 9); // the clip's own in-point
    expect(evalExpr(v.expr, 1)).toBeCloseTo(0.5, 9); // halfway up the 2s ramp
    expect(evalExpr(v.expr, 2)).toBeCloseTo(1, 9);
    expect(evalExpr(v.expr, 9)).toBeCloseTo(1, 9); // held past the last key
  });

  it('key times are divided by the clip speed, because volume runs AFTER atempo', () => {
    const c = clip('a', {
      chroma_keyframes: [
        { frame: 0, params: { volume: 0 } },
        { frame: 48, params: { volume: 1 } },
      ],
    });
    const v = clipAudioParam(c, 'volume', 1, 24, flat(c, 2)); // 2x speed
    expect(v.kind).toBe('keys');
    if (v.kind !== 'keys') return;
    // The 2s ramp is 1s of OUTPUT time once the clip plays twice as fast.
    expect(evalExpr(v.expr, 0.5)).toBeCloseTo(0.5, 9);
    expect(evalExpr(v.expr, 1)).toBeCloseTo(1, 9);
  });

  it('keys that all hold the identity collapse back to static — an animation that animates nothing', () => {
    const c = clip('a', {
      chroma_keyframes: [
        { frame: 0, params: { volume: 1 } },
        { frame: 48, params: { volume: 1 } },
      ],
    });
    expect(clipAudioParam(c, 'volume', 1, 24, flat(c))).toEqual({ kind: 'static', value: 1 });
  });
});

describe('buildAudioSourceChain — per-clip level (D-223)', () => {
  const base = {
    srcRef: '[3:a]',
    clipFps: 24,
    gain: 1,
    speedSegments: flat(clip('a')),
    startSec: 0,
    duck: null,
    idLabel: 'au0',
  };

  it('a clip at unity and centre still needs no filter node at all', () => {
    const { steps, ref } = buildAudioSourceChain({ ...base, clip: clip('a') });
    expect(steps).toEqual([]);
    expect(ref).toEqual({ kind: 'raw', inputIdx: 3 });
  });

  it('a static clip volume folds into the SAME single volume node the track gain uses', () => {
    // One node, one number — the live mixer composes `track.gain ×
    // clip.volume` into one scalar too, and keeping it that way is what stops
    // this feature from costing an unused export anything.
    const { steps } = buildAudioSourceChain({
      ...base,
      gain: 0.5,
      clip: clip('a', { volume: 0.5 }),
    });
    expect(steps).toEqual(['[3:a]volume=0.25[vau0]']);
  });

  it('a static pan splits, applies the two real pan-law constants, and joins back to stereo', () => {
    const { steps, ref } = buildAudioSourceChain({ ...base, clip: clip('a', { pan: -1 }) });
    const [l, r] = panGains(-1);
    expect(steps).toEqual([
      '[3:a]aformat=channel_layouts=stereo[sau0]',
      '[sau0]channelsplit=channel_layout=stereo[lau0][rau0]',
      `[lau0]volume=volume='(${l})'[lvau0]`,
      `[rau0]volume=volume='(${r})'[rvau0]`,
      '[lvau0][rvau0]join=inputs=2:channel_layout=stereo:map=0.0-FL|1.0-FR[pau0]',
    ]);
    expect(ref).toEqual({ kind: 'label', label: 'pau0' });
    // …and the constants really are "silence the right, boost the left".
    expect(l).toBeCloseTo(Math.SQRT2, 12);
    expect(r).toBe(0);
  });

  it('the track gain and clip volume multiply into BOTH channels of a panned clip', () => {
    const { steps } = buildAudioSourceChain({
      ...base,
      gain: 0.5,
      clip: clip('a', { volume: 0.5, pan: 0.5 }),
    });
    const left = steps.find((s) => s.startsWith('[lau0]'))!;
    const right = steps.find((s) => s.startsWith('[rau0]'))!;
    const [l, r] = panGains(0.5);
    expect(evalExpr(/volume='(.*)'\[/.exec(left)![1], 0)).toBeCloseTo(0.25 * l, 12);
    expect(evalExpr(/volume='(.*)'\[/.exec(right)![1], 0)).toBeCloseTo(0.25 * r, 12);
  });

  it('a KEYFRAMED pan is a real per-frame expression that sweeps between the channels', () => {
    const c = clip('a', {
      duration: 48, // 2s at 24fps
      chroma_keyframes: [
        { frame: 0, params: { pan: -1 } },
        { frame: 48, params: { pan: 1 } },
      ],
    });
    const { steps } = buildAudioSourceChain({ ...base, clip: c });
    const left = steps.find((s) => s.startsWith('[lau0]'))!;
    const right = steps.find((s) => s.startsWith('[rau0]'))!;
    // `eval=frame` — without it ffmpeg parses the expression ONCE and the pan
    // never moves, which is exactly the class of bug B-090 was.
    expect(left).toContain('volume=eval=frame:');
    const lExpr = /volume='(.*)'\[/.exec(left)![1];
    const rExpr = /volume='(.*)'\[/.exec(right)![1];
    expect(evalExpr(lExpr, 0)).toBeCloseTo(Math.SQRT2, 9);
    expect(evalExpr(rExpr, 0)).toBeCloseTo(0, 9);
    expect(evalExpr(lExpr, 1)).toBeCloseTo(1, 9); // centre, halfway through
    expect(evalExpr(rExpr, 1)).toBeCloseTo(1, 9);
    expect(evalExpr(lExpr, 2)).toBeCloseTo(0, 9);
    expect(evalExpr(rExpr, 2)).toBeCloseTo(Math.SQRT2, 9);
  });

  it('a keyframed volume becomes a per-frame expression, floored at silence', () => {
    const c = clip('a', {
      chroma_keyframes: [
        { frame: 0, params: { volume: 0 } },
        { frame: 48, params: { volume: 2 } },
      ],
    });
    const { steps } = buildAudioSourceChain({ ...base, clip: c });
    expect(steps).toHaveLength(1);
    expect(steps[0]).toContain('volume=eval=frame:');
    const expr = /volume='(.*)'\[/.exec(steps[0])![1];
    expect(evalExpr(expr, 0)).toBeCloseTo(0, 9);
    expect(evalExpr(expr, 1)).toBeCloseTo(1, 9);
    expect(evalExpr(expr, 2)).toBeCloseTo(2, 9); // no ceiling — a fader boosts
  });

  it('a clip volume multiplies with a fade rather than replacing it', () => {
    // The composition contract: `track.gain × clip.volume × fade × duck`, the
    // same product `SourceEnvelopes::apply` computes per sample-frame.
    const c = clip('a', { duration: 48, volume: 0.5, fade_in_frames: 24 });
    const { steps } = buildAudioSourceChain({ ...base, clip: c });
    expect(steps).toHaveLength(1);
    const expr = /volume='(.*)'\[/.exec(steps[0])![1];
    expect(evalExpr(expr, 0)).toBeCloseTo(0, 6); // silent at the fade's start
    expect(evalExpr(expr, 0.5)).toBeCloseTo(0.25, 3); // half the fade x half the volume
    expect(evalExpr(expr, 1.5)).toBeCloseTo(0.5, 6); // past the fade: volume alone
  });
});

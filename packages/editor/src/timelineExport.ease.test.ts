/**
 * D-233 — how an eased keyframe segment compiles to an ffmpeg expression, and
 * (the part that actually matters) how closely the compiled expression tracks
 * the curve the LIVE PREVIEW resolves.
 *
 * This repo has a whole family of bugs about preview/export divergence on
 * animation data — B-090, B-094, B-095, B-098 — so the two assertions this
 * file exists for are:
 *
 *   1. **An un-eased timeline compiles byte-identically to before D-233.**
 *      No existing project's export can change.
 *   2. **An eased one agrees with the preview at every authored keyframe
 *      exactly, and in between by a MEASURED bound** — not "should be close",
 *      an actual number, evaluated by an ffmpeg-expression interpreter written
 *      here from ffmpeg's own semantics rather than by trusting the string.
 */
import { describe, expect, it } from 'vitest';

import { keyframeExprAt, type ExportKeyframe } from './timelineExport';
import { easeCurveEval } from './easeCurve';
import { EASE_PRESETS } from './timeline';

const LINEAR = EASE_PRESETS[0].curve;
const EASE_IN = EASE_PRESETS[1].curve;
const EASE_IN_OUT = EASE_PRESETS[3].curve;

const FPS = 25;

/**
 * Evaluate the subset of ffmpeg's expression language `piecewiseLinearExpr`
 * emits — `if(cond, a, b)`, `between(x, lo, hi)`, `lt(a, b)`, and arithmetic —
 * at a given `t`.
 *
 * Written here, from ffmpeg's documented semantics, rather than asserting on
 * the string: a test that compares expression text proves the compiler emits
 * the text it emits, while this proves the expression MEANS the right thing.
 * The real ffmpeg-in-the-loop check is `timelineExport.ffmpeg.test.ts`'s pixel
 * test; this is the cheap, exhaustive tier under it.
 */
function evalFfmpegExpr(expr: string, t: number): number {
  const js = expr
    .replace(/\bbetween\(/g, '__between(')
    .replace(/\blt\(/g, '__lt(')
    .replace(/\bif\(/g, '__if(')
    .replace(/\bt\b/g, '__t')
    // A negative keyframe value (a leftward `position_x`, or an overshooting
    // ease dipping below its start) makes the compiler emit `a--b` — ffmpeg
    // parses that as "subtract negative b" and evaluates it correctly
    // (verified directly against ffmpeg 7.1: `geq=r='(0.2--0.1)*255'` renders
    // 76/255 = 0.298). JavaScript instead reads `--` as a postfix decrement and
    // throws, so this interpreter — and ONLY this interpreter — respaces it.
    // The compiler's output is deliberately left as ffmpeg accepts it.
    .replace(/--/g, '- -');
  // eslint-disable-next-line no-new-func -- a test-local interpreter for a
  // closed, generated expression language; nothing user-supplied reaches it.
  const fn = new Function(
    '__t',
    '__between',
    '__lt',
    '__if',
    `return (${js});`,
  ) as (t: number, b: (x: number, lo: number, hi: number) => number, l: (a: number, b: number) => number, i: (c: number, a: number, b: number) => number) => number;
  return fn(
    t,
    (x, lo, hi) => (x >= lo && x <= hi ? 1 : 0),
    (a, b) => (a < b ? 1 : 0),
    (c, a, b) => (c ? a : b),
  );
}

function keys(ease?: typeof EASE_IN): ExportKeyframe[] {
  return [
    ease ? { frame: 0, params: { opacity: 0 }, ease: { opacity: ease } } : { frame: 0, params: { opacity: 0 } },
    { frame: 100, params: { opacity: 1 } },
  ];
}

describe('keyframeExprAt — no easing', () => {
  it('is byte-identical to the pre-D-233 two-point expression', () => {
    // The backward-compatibility guarantee, asserted on the exact string
    // because the string IS the ffmpeg argv: no existing project's export
    // command can change as a result of this feature.
    expect(keyframeExprAt(keys(), 'opacity', 0, FPS)).toBe(
      'if(lt(t,0),0,if(between(t,0,4),0+(1-0)*(t-0)/(4-0),1))',
    );
  });

  it('emits the same string for an explicitly LINEAR curve', () => {
    // "stored linear" and "no curve" must be one case on both sides of the
    // wire, or an explicitly-linear segment would export as 20 sampled points.
    expect(keyframeExprAt(keys(LINEAR), 'opacity', 0, FPS)).toBe(keyframeExprAt(keys(), 'opacity', 0, FPS));
  });

  it('leaves a single keyframe a bare constant', () => {
    expect(keyframeExprAt([{ frame: 10, params: { opacity: 0.5 } }], 'opacity', 0, FPS)).toBe('0.5');
  });

  it('falls back to the static value when nothing names the param', () => {
    expect(keyframeExprAt(keys(EASE_IN), 'scale', 1.25, FPS)).toBe('1.25');
  });
});

describe('keyframeExprAt — easing', () => {
  it('samples only the eased segment, leaving linear ones two-point', () => {
    // Sampling is confined to where a curve actually is: a mixed timeline pays
    // for the eased segment and nothing else.
    const mixed: ExportKeyframe[] = [
      { frame: 0, params: { opacity: 0 }, ease: { opacity: EASE_IN } },
      { frame: 100, params: { opacity: 1 } },
      { frame: 200, params: { opacity: 0 } },
    ];
    const eased = keyframeExprAt(mixed, 'opacity', 0, FPS);
    const plain = keyframeExprAt(
      [
        { frame: 0, params: { opacity: 0 } },
        { frame: 100, params: { opacity: 1 } },
        { frame: 200, params: { opacity: 0 } },
      ],
      'opacity',
      0,
      FPS,
    );
    // 19 interior samples in the first segment, none in the second.
    const count = (s: string) => (s.match(/between\(/g) ?? []).length;
    expect(count(plain)).toBe(2);
    expect(count(eased)).toBe(2 + 19);
  });

  it('hits every AUTHORED keyframe exactly — the two renderers cannot disagree there', () => {
    for (const preset of EASE_PRESETS) {
      const expr = keyframeExprAt(keys(preset.curve), 'opacity', 0, FPS);
      expect(evalFfmpegExpr(expr, 0)).toBeCloseTo(0, 9);
      expect(evalFfmpegExpr(expr, 100 / FPS)).toBeCloseTo(1, 9);
    }
  });

  it('tracks the preview\'s own resolved curve within a MEASURED bound', () => {
    // This is the assertion the feature lives or dies on. `easeCurveEval` is
    // what Rust evaluates per frame for the live preview (an exact mirror of
    // `chroma_types::EaseCurve::eval`); the expression is what ffmpeg
    // evaluates for the export. Their worst-case disagreement across every
    // preset, sampled far finer than the 20-step grid, must stay under the
    // documented bound.
    let worst = 0;
    for (const preset of EASE_PRESETS) {
      const expr = keyframeExprAt(keys(preset.curve), 'opacity', 0, FPS);
      for (let i = 0; i <= 1000; i++) {
        const u = i / 1000;
        const exported = evalFfmpegExpr(expr, (u * 100) / FPS);
        const previewed = easeCurveEval(preset.curve, u);
        worst = Math.max(worst, Math.abs(exported - previewed));
      }
    }
    // MEASURED, at `EASE_SAMPLE_STEPS = 20`: linear 2.2e-16 (i.e. exact —
    // linear segments are not sampled at all), ease-in and ease-out 1.089e-3,
    // ease-in-out 1.384e-3. So the worst case is 0.14% of full scale, about a
    // third of the 1/255 = 3.9e-3 an 8-bit output can even represent. The
    // bound is asserted just above that measurement, not at a comfortable
    // round number, so lowering `EASE_SAMPLE_STEPS` has to face this test.
    expect(worst).toBeLessThan(0.002);
    expect(worst).toBeGreaterThan(0); // it IS an approximation — say so honestly
  });

  it('an eased export is measurably NOT the linear one', () => {
    // Guards the failure that would otherwise be silent and total: dropping
    // `ease` somewhere in the compile path (`rebaseKeyframesToClipInput` did
    // exactly that before it was fixed) would export every eased animation as
    // linear while the preview eased it.
    const easedExpr = keyframeExprAt(keys(EASE_IN), 'opacity', 0, FPS);
    const linearExpr = keyframeExprAt(keys(), 'opacity', 0, FPS);
    const at = 50 / FPS;
    expect(evalFfmpegExpr(linearExpr, at)).toBeCloseTo(0.5, 6);
    expect(evalFfmpegExpr(easedExpr, at)).toBeLessThan(0.4);
  });

  it('carries overshoot into the exported expression', () => {
    const anticipate = { x1: 0.4, y1: -0.6, x2: 0.6, y2: 1 };
    const expr = keyframeExprAt(keys(anticipate), 'opacity', 0, FPS);
    expect(evalFfmpegExpr(expr, 25 / FPS)).toBeLessThan(0);
  });

  it('holds flat outside the keyed range, eased or not', () => {
    const expr = keyframeExprAt(keys(EASE_IN_OUT), 'opacity', 0, FPS);
    expect(evalFfmpegExpr(expr, -10)).toBeCloseTo(0, 9);
    expect(evalFfmpegExpr(expr, 999)).toBeCloseTo(1, 9);
  });

  it('eases each property independently', () => {
    const kfs: ExportKeyframe[] = [
      { frame: 0, params: { opacity: 0, scale: 0 }, ease: { opacity: EASE_IN } },
      { frame: 100, params: { opacity: 1, scale: 1 } },
    ];
    const at = 50 / FPS;
    expect(evalFfmpegExpr(keyframeExprAt(kfs, 'scale', 0, FPS), at)).toBeCloseTo(0.5, 6);
    expect(evalFfmpegExpr(keyframeExprAt(kfs, 'opacity', 0, FPS), at)).toBeLessThan(0.4);
  });

  it('honours a re-based time variable, as a text clip needs', () => {
    // D-211's `timeVar` path must ease too — a title's animation runs on the
    // composited base stream, where `t` is timeline time.
    const expr = keyframeExprAt(keys(EASE_IN), 'opacity', 0, FPS, '(t-2)');
    expect(evalFfmpegExpr(expr, 2)).toBeCloseTo(0, 9);
    expect(evalFfmpegExpr(expr, 2 + 100 / FPS)).toBeCloseTo(1, 9);
    expect(evalFfmpegExpr(expr, 2 + 50 / FPS)).toBeLessThan(0.4);
  });
});

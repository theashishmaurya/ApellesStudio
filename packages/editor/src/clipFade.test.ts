/**
 * @chroma/editor — unit coverage for `clipFade.ts` (D-207), the pure geometry
 * behind the timeline's on-clip fade handles.
 *
 * Everything here has a correct answer: the frames↔px conversion (including
 * the mixed-native-fps case B-077 exists for), the drag clamp's deliberate
 * asymmetry with the MODEL's own no-clamp rule, and the exact control points
 * an SVG cubic needs to trace a `EaseCurve`'s real shape. The gesture wiring
 * around it is covered by `TimelinePane.fade.dom.test.tsx`.
 */

import { describe, expect, it } from 'vitest';

import {
  FADE_TOP_INSET_PX,
  clampFadeDragPx,
  fadeFramesToPx,
  fadeHandleX,
  fadeRampPaths,
  fadeUnityLinePath,
  pxToFadeFrames,
} from './clipFade';
import { EASE_PRESETS, type Clip, type EaseCurve } from './timeline';

const LINEAR = EASE_PRESETS[0].curve;
const EASE_IN = EASE_PRESETS[1].curve;

/** 24 fps project; the clip is native-24 unless a test says otherwise. */
const FPS = 24;
/** `DEFAULT_PX_PER_SEC` — stated explicitly here for the same reason
 *  `marquee.test.ts` states its own geometry rather than importing it. */
const PX_PER_SEC = 90;

const sameRate: Pick<Clip, 'source_fps'> = { source_fps: 24 };
/** A 48 fps source in a 24 fps timeline — 2 source frames per timeline frame,
 *  the exact ratio B-077's own bug report turns on. */
const doubleRate: Pick<Clip, 'source_fps'> = { source_fps: 48 };

describe('fadeFramesToPx / pxToFadeFrames (D-207)', () => {
  it('converts a same-rate fade to its on-screen width', () => {
    // 24 source frames == 1 timeline second == PX_PER_SEC px.
    expect(fadeFramesToPx(sameRate, 24, FPS, PX_PER_SEC)).toBeCloseTo(90, 6);
    expect(fadeFramesToPx(sameRate, 12, FPS, PX_PER_SEC)).toBeCloseTo(45, 6);
  });

  it('routes a mixed-native-fps clip through the real source→timeline ratio (B-077)', () => {
    // 48 SOURCE frames of a 48fps clip is 1 real second — 24 timeline frames
    // at 24fps, so still PX_PER_SEC px. Dividing by `fps` directly would have
    // drawn it twice as wide.
    expect(fadeFramesToPx(doubleRate, 48, FPS, PX_PER_SEC)).toBeCloseTo(90, 6);
    expect(fadeFramesToPx(sameRate, 48, FPS, PX_PER_SEC)).toBeCloseTo(180, 6);
  });

  it('treats absent / negative / non-finite durations as no fade', () => {
    expect(fadeFramesToPx(sameRate, undefined, FPS, PX_PER_SEC)).toBe(0);
    expect(fadeFramesToPx(sameRate, -30, FPS, PX_PER_SEC)).toBe(0);
    expect(fadeFramesToPx(sameRate, Number.NaN, FPS, PX_PER_SEC)).toBe(0);
  });

  it('round-trips px→frames→px at the same rate', () => {
    for (const frames of [0, 1, 7, 24, 100]) {
      const px = fadeFramesToPx(sameRate, frames, FPS, PX_PER_SEC);
      expect(pxToFadeFrames(sameRate, px, FPS, PX_PER_SEC)).toBe(frames);
    }
  });

  it('round-trips at a doubled native rate too', () => {
    for (const frames of [0, 2, 24, 48, 96]) {
      const px = fadeFramesToPx(doubleRate, frames, FPS, PX_PER_SEC);
      expect(pxToFadeFrames(doubleRate, px, FPS, PX_PER_SEC)).toBe(frames);
    }
  });

  it('never returns a negative or fractional frame count', () => {
    expect(pxToFadeFrames(sameRate, -50, FPS, PX_PER_SEC)).toBe(0);
    expect(pxToFadeFrames(sameRate, 3.7, FPS, PX_PER_SEC)).toBe(1); // 3.7px ≈ 0.99 frames
    expect(Number.isInteger(pxToFadeFrames(sameRate, 137.4, FPS, PX_PER_SEC))).toBe(true);
  });

  it('is zoom-relative: the same fade is wider zoomed in', () => {
    expect(fadeFramesToPx(sameRate, 24, FPS, PX_PER_SEC * 4)).toBeCloseTo(360, 6);
    // …and the inverse follows the same zoom, so a handle dragged to the same
    // screen offset means a different duration at a different zoom.
    expect(pxToFadeFrames(sameRate, 360, FPS, PX_PER_SEC * 4)).toBe(24);
    expect(pxToFadeFrames(sameRate, 360, FPS, PX_PER_SEC)).toBe(96);
  });
});

describe('clampFadeDragPx — a DRAG clamp, not a model clamp (D-207)', () => {
  it('bounds a handle to the clip it lives on', () => {
    expect(clampFadeDragPx(-40, 200)).toBe(0);
    expect(clampFadeDragPx(0, 200)).toBe(0);
    expect(clampFadeDragPx(130, 200)).toBe(130);
    expect(clampFadeDragPx(900, 200)).toBe(200);
  });

  it('survives a degenerate clip width and a non-finite pointer position', () => {
    expect(clampFadeDragPx(50, 0)).toBe(0);
    expect(clampFadeDragPx(50, -10)).toBe(0);
    expect(clampFadeDragPx(Number.NaN, 200)).toBe(0);
  });
});

describe('fadeHandleX (D-207)', () => {
  it('sits where the ramp meets unity', () => {
    expect(fadeHandleX('in', 200, 60)).toBe(60);
    expect(fadeHandleX('out', 200, 60)).toBe(140);
  });

  it('parks a longer-than-the-clip fade at the far edge so it stays grabbable', () => {
    expect(fadeHandleX('in', 200, 500)).toBe(200);
    expect(fadeHandleX('out', 200, 500)).toBe(0);
  });

  it('sits at the clip corner for a zero fade', () => {
    expect(fadeHandleX('in', 200, 0)).toBe(0);
    expect(fadeHandleX('out', 200, 0)).toBe(200);
  });
});

/** Pull the numbers out of a path string, in order, for endpoint assertions
 *  that don't depend on exact formatting. */
function nums(d: string): number[] {
  return (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
}

describe('fadeRampPaths — the REAL curve, not a straight-line approximation (D-207)', () => {
  const W = 200;
  const H = 52;
  const TOP = FADE_TOP_INSET_PX;

  it('returns null when there is no ramp to draw', () => {
    expect(fadeRampPaths('in', W, H, 0, LINEAR)).toBeNull();
    expect(fadeRampPaths('in', W, H, -5, LINEAR)).toBeNull();
    expect(fadeRampPaths('in', W, 0, 40, LINEAR)).toBeNull();
  });

  it('a fade-in runs from silence at the clip’s left edge up to unity at the ramp end', () => {
    const p = fadeRampPaths('in', W, H, 60, LINEAR);
    expect(p).not.toBeNull();
    const n = nums(p!.line);
    expect(n[0]).toBe(0); // start x — the clip's own in-point
    expect(n[1]).toBe(H); // start y — the bottom, i.e. gain 0
    expect(n[6]).toBe(60); // end x — the ramp length
    expect(n[7]).toBe(TOP); // end y — unity
  });

  it('a fade-out runs right-to-left from the clip’s OUT-point, not mirrored', () => {
    // `fade_out_curve`'s own doc: its `x = 0` is the very end of the clip, so
    // an ease-in fade-out is slow near silence exactly as an ease-in fade-in
    // is. Building it right-to-left is what makes that true.
    const p = fadeRampPaths('out', W, H, 60, EASE_IN);
    const n = nums(p!.line);
    expect(n[0]).toBe(W); // start x — the out-point
    expect(n[1]).toBe(H); // start y — silence
    expect(n[6]).toBe(W - 60); // end x
    expect(n[7]).toBe(TOP); // end y — unity

    // EASE_IN is (0.42, 0, 1, 1): the first control point sits at x=0.42 of
    // the window measured INWARD from the out-point, at gain 0.
    expect(n[2]).toBeCloseTo(W - 0.42 * 60, 3);
    expect(n[3]).toBe(H);
  });

  it('places both control points at the curve’s own coordinates, scaled to the ramp box', () => {
    const curve: EaseCurve = { x1: 0.25, y1: 0.1, x2: 0.75, y2: 0.9 };
    const n = nums(fadeRampPaths('in', W, H, 80, curve)!.line);
    expect(n[2]).toBeCloseTo(0.25 * 80, 3);
    expect(n[3]).toBeCloseTo(H - 0.1 * (H - TOP), 3);
    expect(n[4]).toBeCloseTo(0.75 * 80, 3);
    expect(n[5]).toBeCloseTo(H - 0.9 * (H - TOP), 3);
  });

  it('linear and ease-in genuinely differ — the shape is drawn, not flattened', () => {
    const lin = fadeRampPaths('in', W, H, 80, LINEAR)!.line;
    const ease = fadeRampPaths('in', W, H, 80, EASE_IN)!.line;
    expect(ease).not.toEqual(lin);
    // …while sharing both endpoints, which is what makes them the same fade
    // of the same length with a different shape.
    expect(nums(lin).slice(0, 2)).toEqual(nums(ease).slice(0, 2));
    expect(nums(lin).slice(6, 8)).toEqual(nums(ease).slice(6, 8));
  });

  it('closes the fill area back along the clip’s top edge', () => {
    const p = fadeRampPaths('in', W, H, 60, LINEAR)!;
    expect(p.area.startsWith(p.line)).toBe(true);
    expect(p.area).toMatch(/L 0 1 Z$/);
  });

  it('draws a longer-than-the-clip fade honestly — the ramp simply runs past the edge', () => {
    // Nothing here clamps: the ramp is emitted at its real width and the
    // clip's own SVG viewport crops it, so a fade of twice the clip's length
    // shows a ramp that has only reached half gain when the clip ends. Any
    // clamp here would have drawn a LIE (a fade that visually completes when
    // the render does not).
    const n = nums(fadeRampPaths('in', W, H, 2 * W, LINEAR)!.line);
    expect(n[6]).toBe(2 * W);
  });
});

describe('fadeUnityLinePath (D-207)', () => {
  it('spans the un-faded middle of the clip', () => {
    expect(fadeUnityLinePath(200, 52, 40, 60)).toBe(`M 40 ${FADE_TOP_INSET_PX} L 140 ${FADE_TOP_INSET_PX}`);
  });

  it('is absent when the two ramps meet or overlap (a clip that is one whole dip)', () => {
    expect(fadeUnityLinePath(200, 52, 100, 100)).toBeNull();
    expect(fadeUnityLinePath(200, 52, 160, 160)).toBeNull();
  });

  it('spans the whole clip when neither end is faded', () => {
    expect(fadeUnityLinePath(200, 52, 0, 0)).toBe(`M 0 ${FADE_TOP_INSET_PX} L 200 ${FADE_TOP_INSET_PX}`);
  });
});

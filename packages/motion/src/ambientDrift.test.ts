/**
 * B-060 regression test (`docs/BUGS.md`) — both ambient-drift
 * implementations (`motion-engine/src/lib/draw.ts`'s `ambientDrift`, for the
 * 2D primitives; `motion-engine/src/primitives/Camera.tsx`'s `cameraDrift`,
 * for the 2D camera) divided the frame number by `design.fps` — a fixed
 * authoring-default TOKEN (`30`), not the composition's REAL fps — so the
 * same manifest's drift ran at a different perceived wall-clock rate at a
 * non-30fps render: twice as fast at 60fps, 20% slower at 24fps.
 *
 * Lives in `@apelles/motion`'s test suite for the same reason
 * `interpolateKeys.test.ts`/`schema.test.ts` do — `@apelles/motion-engine`
 * has no `test` script (D-155's own finding) — importing the two pure
 * functions across the package boundary the same established way.
 *
 * The load-bearing assertion in each case: computed at frame `f` and its own
 * fps `r`, the drift is a function of WALL-CLOCK TIME `f / r`, not of `f`
 * alone — the same time instant across different fps must produce the same
 * drift value. Before this fix, that was false: only the case where the
 * render's real fps happened to equal `design.fps` (30) agreed with itself.
 */
import { describe, it, expect } from 'vitest';
import { design } from '@apelles/motion-engine/src/design';
import { ambientDrift } from '@apelles/motion-engine/src/lib/draw';
import { cameraDrift } from '@apelles/motion-engine/src/primitives/Camera';

/** the OLD (pre-B-060) formula, both implementations, reconstructed here
 *  byte-for-byte from the bug entry's own quoted expressions so the
 *  before/after comparison below is against the ACTUAL prior behaviour, not
 *  a hand-waved approximation of it. */
const oldAmbientDrift = (frame: number, seed = 0) => ({
  x: design.ambientDriftPx * Math.sin((frame / design.fps) * 0.7 + seed * 1.3),
  y: design.ambientDriftPx * Math.sin((frame / design.fps) * 0.5 + seed * 2.1),
});
const oldCameraDrift = (frame: number) => ({
  dx: design.ambientDriftPx * 2 * Math.sin((frame / design.fps) * 0.6),
  dy: design.ambientDriftPx * 2 * Math.sin((frame / design.fps) * 0.43 + 1.7),
});

describe('B-060 — ambientDrift (2D primitives) depends on the real composition fps, not the fixed design token', () => {
  it('the SAME wall-clock instant produces the SAME drift at 24fps, 30fps, and 60fps', () => {
    const seconds = 2;
    const at30 = ambientDrift(30 * seconds, 30, 1);
    const at24 = ambientDrift(24 * seconds, 24, 1);
    const at60 = ambientDrift(60 * seconds, 60, 1);
    expect(at24.x).toBeCloseTo(at30.x, 10);
    expect(at24.y).toBeCloseTo(at30.y, 10);
    expect(at60.x).toBeCloseTo(at30.x, 10);
    expect(at60.y).toBeCloseTo(at30.y, 10);
  });

  it('matches the OLD (pre-fix) formula exactly when fps happens to be 30 (design.fps) — no change at the default', () => {
    expect(ambientDrift(45, 30, 2)).toEqual(oldAmbientDrift(45, 2));
  });

  it('BEFORE-FIX BEHAVIOUR reproduced directly: the old formula desyncs 24fps/60fps renders from 30fps at the same wall-clock instant', () => {
    const seconds = 2;
    const before30 = oldAmbientDrift(30 * seconds, 1); // "rendered at 30fps" — old formula, unaffected by the real fps anyway
    const before60AtSameInstant = oldAmbientDrift(60 * seconds, 1); // same 2s instant, rendered at 60fps
    // the bug: the old formula does NOT agree across fps at the same wall-clock instant
    expect(before60AtSameInstant.x).not.toBeCloseTo(before30.x, 3);
    // the fix: the new function DOES
    const after30 = ambientDrift(30 * seconds, 30, 1);
    const after60 = ambientDrift(60 * seconds, 60, 1);
    expect(after60.x).toBeCloseTo(after30.x, 10);
  });

  it('is still deterministic per (frame, fps, seed) — no wall-clock/random dependency introduced', () => {
    expect(ambientDrift(45, 24, 3)).toEqual(ambientDrift(45, 24, 3));
  });
});

describe('B-060 — Camera.tsx\'s cameraDrift depends on the real composition fps, not the fixed design token', () => {
  it('the SAME wall-clock instant produces the SAME drift at 24fps, 30fps, and 60fps', () => {
    const seconds = 1.5;
    const at30 = cameraDrift(30 * seconds, 30);
    const at24 = cameraDrift(24 * seconds, 24);
    const at60 = cameraDrift(60 * seconds, 60);
    expect(at24.dx).toBeCloseTo(at30.dx, 10);
    expect(at24.dy).toBeCloseTo(at30.dy, 10);
    expect(at60.dx).toBeCloseTo(at30.dx, 10);
    expect(at60.dy).toBeCloseTo(at30.dy, 10);
  });

  it('matches the OLD (pre-fix) formula exactly when fps happens to be 30 (design.fps) — no change at the default', () => {
    expect(cameraDrift(24, 30)).toEqual(oldCameraDrift(24));
  });

  /** the concrete before/after numbers this fix's commit quotes, at frame 24
   *  (1 second in at 24fps, 0.8s in at 30fps, 0.4s in at 60fps). */
  it('BEFORE/AFTER at frame 24 — the exact values quoted in this fix\'s commit message', () => {
    const frame = 24;
    const before = oldCameraDrift(frame); // pre-fix: same number regardless of the render's real fps
    const after24 = cameraDrift(frame, 24);
    const after30 = cameraDrift(frame, 30);
    const after60 = cameraDrift(frame, 60);

    // pre-fix: a 24fps and a 60fps render produced the IDENTICAL number at
    // frame 24, despite frame 24 being a different wall-clock instant at
    // each (1s vs 0.4s) — that identity was itself the bug.
    expect(before).toEqual(oldCameraDrift(frame));

    // post-fix: a 30fps render is numerically unchanged (matches `before`
    // exactly, since design.fps === 30)...
    expect(after30).toEqual(before);
    // ...while 24fps and 60fps now correctly diverge from each other AND
    // from the fixed 30fps-token-based `before` value, because frame 24 is
    // now read as ITS OWN fps's wall-clock instant rather than always
    // divided by 30.
    expect(after24.dx).not.toBeCloseTo(after60.dx, 5);
    expect(after24.dx).not.toBeCloseTo(before.dx, 5);
    expect(after60.dx).not.toBeCloseTo(before.dx, 5);
  });
});

/**
 * `dragGhost.ts` — the window a clip-drag ghost shows (B-137 / D-279).
 *
 * The arithmetic half of the fix. Where the ghost actually ends up on screen is
 * `TimelinePane.dragGhost.dom.test.tsx`'s job (it is dnd-kit's positioning, and
 * only a real DOM can answer it); this file pins the rule that decides which
 * slice of the clip that ghost is, to the pixel — including the two cases the
 * DOM tier can only sample rather than enumerate: every clamp, and the
 * degenerate inputs a pane laid out to nothing produces.
 */

import { describe, expect, it } from 'vitest';

import { dragGhostWindow, MAX_DRAG_GHOST_PX, MIN_DRAG_GHOST_PX } from './dragGhost';

describe('dragGhostWindow', () => {
  it('leaves a clip that fits inside the cap exactly as it was — full width, no offset', () => {
    // The pre-B-137 behaviour, which was never wrong and must not change:
    // the ghost IS the clip, anchored on it.
    const w = dragGhostWindow(180, 90);
    expect(w).toEqual({ widthPx: 180, startPx: 0 });
    // …and the grab point makes no difference at all, at either end.
    expect(dragGhostWindow(180, 0).startPx).toBe(0);
    expect(dragGhostWindow(180, 180).startPx).toBe(0);
  });

  it('never draws a ghost too small to read', () => {
    // D-119's floor. A 10px clip still gets a legible chip — deliberately
    // WIDER than the clip, which is why `startPx` must stay 0 here (a window
    // offset into a clip narrower than the window is meaningless).
    const w = dragGhostWindow(10, 5);
    expect(w).toEqual({ widthPx: MIN_DRAG_GHOST_PX, startPx: 0 });
  });

  it('caps a long clip and centres the window on the grab point', () => {
    // The B-137 case. 1800px clip, pressed 1100px in: the ghost is the cap
    // wide and starts half a ghost before the press, so the press lands dead
    // centre of it.
    const w = dragGhostWindow(1800, 1100);
    expect(w.widthPx).toBe(MAX_DRAG_GHOST_PX);
    expect(w.startPx).toBe(1100 - MAX_DRAG_GHOST_PX / 2);
    // Stated as the property that actually matters, so a future change to the
    // centring rule has to keep it: the grab point is inside the window.
    expect(1100).toBeGreaterThanOrEqual(w.startPx);
    expect(1100).toBeLessThanOrEqual(w.startPx + w.widthPx);
  });

  it('clamps at the clip’s head — a grab near the start cannot run off the front', () => {
    const w = dragGhostWindow(1800, 40);
    expect(w).toEqual({ widthPx: MAX_DRAG_GHOST_PX, startPx: 0 });
    expect(40).toBeLessThanOrEqual(w.startPx + w.widthPx);
  });

  it('clamps at the clip’s tail — a grab near the end cannot run off the back', () => {
    const w = dragGhostWindow(1800, 1790);
    expect(w).toEqual({ widthPx: MAX_DRAG_GHOST_PX, startPx: 1800 - MAX_DRAG_GHOST_PX });
    expect(1790).toBeGreaterThanOrEqual(w.startPx);
    expect(w.startPx + w.widthPx).toBeLessThanOrEqual(1800);
  });

  it('keeps the window inside the clip for every grab point along a long clip', () => {
    // The invariant, swept rather than sampled: whatever the press, the window
    // is inside the clip AND contains the press. Those two together are the
    // whole contract the ghost's position depends on.
    for (let grab = 0; grab <= 1800; grab += 25) {
      const w = dragGhostWindow(1800, grab);
      expect(w.startPx, `grab=${grab}`).toBeGreaterThanOrEqual(0);
      expect(w.startPx + w.widthPx, `grab=${grab}`).toBeLessThanOrEqual(1800);
      expect(grab, `grab=${grab}`).toBeGreaterThanOrEqual(w.startPx);
      expect(grab, `grab=${grab}`).toBeLessThanOrEqual(w.startPx + w.widthPx);
    }
  });

  it('answers with the floor, not a NaN, for a clip that cannot be measured', () => {
    // jsdom, a collapsed pane, a clip whose row has not laid out yet — all
    // produce a zero-width rect, and a NaN here would propagate straight into
    // an inline `width` style and a `Filmstrip` request.
    for (const bad of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(dragGhostWindow(bad, 100), `clipWidthPx=${bad}`).toEqual({ widthPx: MIN_DRAG_GHOST_PX, startPx: 0 });
    }
    // A non-finite GRAB point is survivable on its own — the window just
    // treats it as the clip's head rather than producing a NaN offset.
    expect(dragGhostWindow(1800, Number.NaN)).toEqual({ widthPx: MAX_DRAG_GHOST_PX, startPx: 0 });
  });

  it('takes a caller-supplied cap, so the constant is not baked into the rule', () => {
    const w = dragGhostWindow(1000, 500, 100);
    expect(w).toEqual({ widthPx: 100, startPx: 450 });
  });
});

/**
 * fpsOverlay.test.ts (D-330) — the on-screen fps readout.
 *
 * Two tiers in one file, because the module has two kinds of thing to prove:
 * the pure formatting/validation decisions (no DOM needed), and the real
 * mount/update/unmount lifecycle (jsdom, which this package's vitest config
 * already provides for `domTree.ts`).
 *
 * What these are FOR: the overlay's whole job is to put a number in front of
 * a camera and have it be the truth. So the things tested here are the ways
 * it could quietly lie — showing `0.0` when it means "no data", drifting out
 * of step with `debug_frame_timing`, mounting twice, or leaving a stale
 * element behind that keeps displaying a frozen number after it was turned
 * off.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_OVERLAY_CORNER,
  DEFAULT_OVERLAY_UPDATE_MS,
  FPS_OVERLAY_ID,
  MAX_OVERLAY_UPDATE_MS,
  MIN_OVERLAY_UPDATE_MS,
  clampUpdateMs,
  formatFps,
  fpsOverlayState,
  overlayText,
  parseOverlayCorner,
  setFpsOverlay,
} from './fpsOverlay';
import { recordPreviewTiming, resetPreviewTiming } from '@apelles/editor';

afterEach(() => {
  setFpsOverlay(false);
  resetPreviewTiming();
  vi.useRealTimers();
});

/** Record `count` paint frames `stepMs` apart, ending at "now".
 *
 *  The overlay windows against the clock rather than the newest sample, so a
 *  fixture recorded at t=0 is correctly treated as ancient history. Anchoring
 *  the fixture to `performance.now()` is what makes it a fixture about a
 *  currently-painting app. */
function recentPaints(count: number, stepMs: number): void {
  const last = performance.now();
  for (let i = count - 1; i >= 0; i -= 1) recordPreviewTiming('paint', last - i * stepMs);
}

describe('formatFps', () => {
  it('shows a dash, never a zero, when there is no measurement', () => {
    // The distinction that matters on camera: "nothing painted" and
    // "painting at zero fps" look identical if both render as 0.0, and only
    // one of them is a bug worth recording.
    expect(formatFps(null).trim()).toBe('--');
    expect(formatFps(0)).not.toContain('--');
  });

  it('pads to a fixed width so the digits do not jitter between updates', () => {
    // Four updates a second with a shifting column width reads as flicker in
    // a recording, which is exactly what this overlay must not add.
    expect(formatFps(9.1)).toHaveLength(4);
    expect(formatFps(60)).toHaveLength(4);
    expect(formatFps(123.4)).toHaveLength(5);
    expect(formatFps(null)).toHaveLength(4);
  });

  it('keeps one decimal place — enough to see a change, not enough to blur', () => {
    expect(formatFps(23.456).trim()).toBe('23.5');
  });
});

describe('overlayText', () => {
  it('names the window it measured over, so the number is self-describing', () => {
    const text = overlayText({
      paintFps: 12.4,
      rafFps: 24.1,
      paintSamples: 20,
      rafSamples: 40,
      hitches: 3,
      windowMs: 2000,
    });
    expect(text).toContain('PAINT 12.4 fps');
    expect(text).toContain('RAF   24.1 fps');
    expect(text).toContain('2.0s window');
    expect(text).toContain('3 hitches');
  });

  it('gets the singular right for exactly one hitch', () => {
    const text = overlayText({
      paintFps: 10,
      rafFps: 10,
      paintSamples: 5,
      rafSamples: 5,
      hitches: 1,
      windowMs: 1000,
    });
    expect(text).toContain('1 hitch');
    expect(text).not.toContain('1 hitches');
  });

  it('is three lines, so the box stays a predictable size on camera', () => {
    const text = overlayText({
      paintFps: null,
      rafFps: null,
      paintSamples: 0,
      rafSamples: 0,
      hitches: 0,
      windowMs: 2000,
    });
    expect(text.split('\n')).toHaveLength(3);
  });
});

describe('argument handling', () => {
  it('clamps an update interval rather than refusing it, and reports what it used', () => {
    expect(clampUpdateMs(undefined)).toBe(DEFAULT_OVERLAY_UPDATE_MS);
    expect(clampUpdateMs('nonsense')).toBe(DEFAULT_OVERLAY_UPDATE_MS);
    expect(clampUpdateMs(1)).toBe(MIN_OVERLAY_UPDATE_MS);
    expect(clampUpdateMs(999_999)).toBe(MAX_OVERLAY_UPDATE_MS);
    expect(clampUpdateMs(500)).toBe(500);
  });

  it('refuses an unknown corner by name instead of silently picking one', () => {
    // D-216's rule. A typo'd corner that quietly defaulted would put the
    // readout somewhere else in a recording with no indication why.
    expect(parseOverlayCorner('bottom-left')).toBe('bottom-left');
    expect(parseOverlayCorner('bottom-centre')).toBeNull();
    expect(parseOverlayCorner(3)).toBeNull();
    expect(parseOverlayCorner(undefined)).toBeNull();
  });
});

describe('the overlay element', () => {
  it('mounts an element that cannot affect layout or swallow a click', () => {
    setFpsOverlay(true);
    const el = document.getElementById(FPS_OVERLAY_ID);
    expect(el).not.toBeNull();
    // The three properties that make this an observer rather than a
    // participant — see the module doc.
    expect(el?.style.position).toBe('fixed');
    expect(el?.style.pointerEvents).toBe('none');
    expect(el?.getAttribute('aria-hidden')).toBe('true');
  });

  it('paints immediately rather than leaving a blank box until the first tick', () => {
    // A screenshot taken right after switching the overlay on is exactly
    // when one gets taken, and at a 250ms interval that is before tick one.
    setFpsOverlay(true);
    expect(document.getElementById(FPS_OVERLAY_ID)?.textContent).toContain('PAINT');
  });

  it('shows the real measured numbers, not placeholders', () => {
    // Recorded ENDING at "now": the overlay anchors its window on the clock,
    // so samples must be recent to be in it — which is the whole point (see
    // the staleness test below).
    recentPaints(10, 50);
    setFpsOverlay(true);
    // 50ms intervals => 20fps, and that must be what is on screen.
    expect(document.getElementById(FPS_OVERLAY_ID)?.textContent).toContain('20.0 fps');
  });

  it('blanks to `--` rather than freezing on a stale number', () => {
    // Caught in D-330's live verification: a readout anchored on the newest
    // sample keeps displaying its last value forever after frames stop, so
    // footage shows a healthy fps over an app that is drawing nothing.
    //
    // The whole test runs on the fake clock — the samples, the overlay's
    // window and the advance all have to share one timebase, or "stale" is
    // measured against a clock the fixtures never used.
    vi.useFakeTimers();
    recentPaints(10, 50);
    setFpsOverlay(true, { updateMs: 250 });
    expect(document.getElementById(FPS_OVERLAY_ID)?.textContent).toContain('20.0 fps');

    // Well past the 2s window, with nothing new painted in it.
    vi.advanceTimersByTime(5000);
    const text = document.getElementById(FPS_OVERLAY_ID)?.textContent ?? '';
    expect(text).toContain('-- fps');
    expect(text).not.toContain('20.0');
  });

  it('re-enabling does not mount a second overlay', () => {
    setFpsOverlay(true);
    setFpsOverlay(true, { corner: 'bottom-left' });
    expect(document.querySelectorAll(`#${FPS_OVERLAY_ID}`)).toHaveLength(1);
  });

  it('moves cleanly between corners without leaving the old inset behind', () => {
    // Setting `bottom` without clearing `top` would stretch the box down the
    // whole window instead of moving it.
    setFpsOverlay(true, { corner: 'top-right' });
    const el = document.getElementById(FPS_OVERLAY_ID);
    expect(el?.style.top).not.toBe('auto');
    expect(el?.style.bottom).toBe('auto');

    setFpsOverlay(true, { corner: 'bottom-left' });
    expect(el?.style.top).toBe('auto');
    expect(el?.style.right).toBe('auto');
    expect(el?.style.bottom).not.toBe('auto');
    expect(el?.style.left).not.toBe('auto');
  });

  it('removes the element and stops updating when disabled', () => {
    vi.useFakeTimers();
    setFpsOverlay(true);
    expect(document.getElementById(FPS_OVERLAY_ID)).not.toBeNull();

    setFpsOverlay(false);
    expect(document.getElementById(FPS_OVERLAY_ID)).toBeNull();

    // A leaked interval would keep ticking against a detached node — and, in
    // the app, keep costing a timer for the rest of the session.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('updates on its interval, and only on its interval', () => {
    vi.useFakeTimers();
    setFpsOverlay(true, { updateMs: 250 });
    const el = document.getElementById(FPS_OVERLAY_ID);

    recentPaints(10, 50);
    // Not yet: the samples exist but the tick has not come round.
    expect(el?.textContent).toContain('  -- fps');

    vi.advanceTimersByTime(250);
    expect(el?.textContent).toContain('20.0 fps');
  });

  it('reports its true state, read off the document rather than a flag', () => {
    expect(fpsOverlayState()).toMatchObject({ enabled: false, mounted: false });

    setFpsOverlay(true, { updateMs: 400, corner: 'bottom-right' });
    expect(fpsOverlayState()).toMatchObject({
      enabled: true,
      mounted: true,
      updateMs: 400,
      corner: 'bottom-right',
    });

    // Someone (or an HMR reload) removed the node behind the module's back.
    // Reporting `enabled: true` here would tell an agent a recording will
    // carry the readout when it will not.
    document.getElementById(FPS_OVERLAY_ID)?.remove();
    expect(fpsOverlayState()).toMatchObject({ enabled: false, mounted: false });
  });

  it('is driven by the `debug_set_fps_overlay` op, which refuses or echoes', async () => {
    const { DEBUG_OPS } = await import('./debugOps');
    const op = DEBUG_OPS.debug_set_fps_overlay;

    // Refusals, by name — the D-216 convention every other debug op follows.
    expect(await op({})).toMatchObject({ error: expect.stringContaining("'enabled'") });
    expect(await op({ enabled: true, corner: 'middle' })).toMatchObject({
      error: expect.stringContaining('unknown corner'),
    });
    // Nothing was mounted by either refusal.
    expect(document.getElementById(FPS_OVERLAY_ID)).toBeNull();

    // A success echoes back what was ACTUALLY applied, including the clamp,
    // so a caller can see it asked for 1ms and got the floor.
    expect(await op({ enabled: true, updateMs: 1, corner: 'top-left' })).toMatchObject({
      ok: true,
      enabled: true,
      mounted: true,
      corner: 'top-left',
      updateMs: MIN_OVERLAY_UPDATE_MS,
    });
    expect(document.getElementById(FPS_OVERLAY_ID)).not.toBeNull();

    expect(await op({ enabled: false })).toMatchObject({ ok: true, enabled: false });
    expect(document.getElementById(FPS_OVERLAY_ID)).toBeNull();
  });

  it('is reported by `debug_get_ui_state`, so a recording can be checked before it is made', async () => {
    const { DEBUG_OPS } = await import('./debugOps');
    setFpsOverlay(true, { corner: 'top-left' });
    expect(await DEBUG_OPS.debug_get_ui_state({})).toMatchObject({
      fpsOverlay: { enabled: true, mounted: true, corner: 'top-left' },
    });
  });

  it('keeps the last corner and interval when a later call omits them', () => {
    // Deliberately sticky, and worth pinning down: an agent that switched
    // the overlay off to take a clean screenshot and back on again should
    // get its recording set-up back, not silently get the default corner.
    // `DEFAULT_OVERLAY_CORNER` is what a fresh session starts from.
    expect(DEFAULT_OVERLAY_CORNER).toBe('top-right');

    setFpsOverlay(true, { corner: 'bottom-left', updateMs: 400 });
    setFpsOverlay(false);
    setFpsOverlay(true);

    expect(fpsOverlayState()).toMatchObject({ corner: 'bottom-left', updateMs: 400 });
  });
});

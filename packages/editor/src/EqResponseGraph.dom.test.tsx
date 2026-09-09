// @vitest-environment jsdom
/**
 * @apelles/editor — real-DOM coverage for D-237's EQ response graph
 * (`EqResponseGraph.tsx`, roadmap item 27's "EQ response curve UI").
 *
 * **Why a DOM test.** `eqCurve.test.ts` already proves the geometry (screen
 * mapping, curve sampling against `eqResponseDb`, drag-to-patch, the wheel-Q
 * mapping) as pure numbers; it proves nothing about the half a human actually
 * touches — that a real pointer press-drag-release on a band's point commits
 * exactly one patch through `onBandChange`, that a drag ending where it began
 * commits nothing, that Escape cancels a drag in flight, and that a real
 * wheel gesture over a point commits Q exactly once after it settles rather
 * than once per tick. That can only be asserted by driving the real component
 * with real `PointerEvent`/`WheelEvent`s, per this package's own
 * `pointerHarness.ts` (D-142) — the same tier and the same honest limits
 * `ClipCurveEditor`'s own sibling components are held to: jsdom, a real
 * mounted component, real events; no claim about pixel-perfect Chromium
 * rendering.
 *
 * Mounted directly (not through `ClipInspectorPanel`/the store) — this
 * component takes plain props and calls back with plain patches, so there is
 * nothing the full Inspector wiring would add to this file's own contract;
 * `ClipInspectorPanel.eq.dom.test.tsx` is where the end-to-end
 * store-through-`applyOp` wiring is proven instead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

import {
  actSync,
  dragPointer,
  firePointerEvent,
  installPointerCaptureStub,
  installResizeObserverStub,
  linearPath,
  mount,
  stubOffsetMetrics,
  waitFrames,
  waitMs,
  type MountedComponent,
} from './testUtils/pointerHarness';
import { EqResponseGraph } from './EqResponseGraph';
import { EQ_MAX_FREQ_HZ, EQ_MIN_FREQ_HZ, type EqBand } from './eq';
import { dbToY, eqQAfterWheel, freqToX } from './eqCurve';

const PLOT_WIDTH = 280;
const PLOT_HEIGHT = 92;

function fourBands(): EqBand[] {
  return [
    { kind: 'low_shelf', freq_hz: 120, gain_db: 0, q: Math.SQRT1_2, enabled: true },
    { kind: 'peak', freq_hz: 500, gain_db: 3, q: 1, enabled: true },
    { kind: 'high_pass', freq_hz: 90, gain_db: 0, q: 0.71, enabled: true },
    { kind: 'high_shelf', freq_hz: 8_000, gain_db: 0, q: Math.SQRT1_2, enabled: false },
  ];
}

let mounted: MountedComponent | null = null;
let restoreResizeObserver: (() => void) | null = null;
let restoreOffsetMetrics: (() => void) | null = null;
let restorePointerCapture: (() => void) | null = null;
let onBandChange: ReturnType<typeof vi.fn>;

function point(el: Element): { x: number; y: number } {
  // jsdom's own `getBoundingClientRect` on an SVG circle is not derived from
  // its `cx`/`cy` attributes (there is no real layout engine), so the graph's
  // container box — stubbed to the plot's real pixel size — plus the
  // attribute values it was RENDERED with is what a real browser's own
  // `getBoundingClientRect`-based hit box would resolve to for a point at
  // that position.
  const cx = Number(el.getAttribute('cx'));
  const cy = Number(el.getAttribute('cy'));
  return { x: cx, y: cy };
}

function pointEl(index: number): SVGCircleElement {
  const el = mounted?.container.querySelector(`[data-chroma-eq-point="${index}"]`);
  if (!el) throw new Error(`no eq point ${index}`);
  return el as unknown as SVGCircleElement;
}

async function render(bands: EqBand[], disabled = false) {
  onBandChange = vi.fn();
  mounted = mount(
    React.createElement(EqResponseGraph, { bands, disabled, onBandChange }),
    { strictMode: true },
  );
  await waitFrames(2);
}

beforeEach(() => {
  restoreResizeObserver = installResizeObserverStub();
  restoreOffsetMetrics = stubOffsetMetrics(PLOT_WIDTH, PLOT_HEIGHT);
  restorePointerCapture = installPointerCaptureStub();
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  restoreResizeObserver?.();
  restoreOffsetMetrics?.();
  restorePointerCapture?.();
  restoreResizeObserver = null;
  restoreOffsetMetrics = null;
  restorePointerCapture = null;
});

describe('EqResponseGraph (D-237)', () => {
  it('renders one point per band, and the curve/fill paths', async () => {
    await render(fourBands());
    expect(mounted?.container.querySelectorAll('[data-chroma-eq-point]')).toHaveLength(4);
    expect(mounted?.container.querySelector('[data-chroma-eq-curve]')).not.toBeNull();
    expect(mounted?.container.querySelector('[data-chroma-eq-fill]')).not.toBeNull();
  });

  it('a bypassed band’s point is dimmer than an enabled one, not identical', async () => {
    await render(fourBands());
    const dots = [...(mounted?.container.querySelectorAll('[data-chroma-eq-point]') ?? [])];
    // The visible dot is the FIRST `<circle>` in the point's own `<g>` — the
    // hit target's own two previous siblings are the number `<text>` then the
    // dot, in the component's own paint order.
    const dotFor = (i: number) => dots[i].previousElementSibling?.previousElementSibling as SVGCircleElement;
    expect(dotFor(0).getAttribute('stroke-opacity')).toBe('1'); // band 1 enabled
    expect(dotFor(3).getAttribute('stroke-opacity')).toBe('0.4'); // band 4 bypassed
  });

  it('dragging a gain-using band’s point horizontally and vertically commits BOTH freq_hz and gain_db once', async () => {
    const bands = fourBands();
    await render(bands);
    const el = pointEl(1); // band 2: peak, 500 Hz / +3 dB
    const start = point(el);
    const targetFreq = 2_000;
    const targetX = freqToX(targetFreq, PLOT_WIDTH);
    const targetY = dbToY(-9, PLOT_HEIGHT);

    await dragPointer(el, linearPath(start, { x: targetX, y: targetY }, 4), { moveTarget: window });

    expect(onBandChange).toHaveBeenCalledTimes(1);
    const [index, patch] = onBandChange.mock.calls[0];
    expect(index).toBe(1);
    expect(patch.freq_hz).toBe(targetFreq);
    expect(patch.gain_db).toBe(-9);
  });

  it('dragging a pass filter’s point writes ONLY freq_hz, never a gain_db', async () => {
    const bands = fourBands();
    await render(bands);
    const el = pointEl(2); // band 3: high_pass, 90 Hz
    const start = point(el);
    const targetFreq = 250;
    const target = { x: freqToX(targetFreq, PLOT_WIDTH), y: dbToY(20, PLOT_HEIGHT) };

    await dragPointer(el, linearPath(start, target, 3), { moveTarget: window });

    expect(onBandChange).toHaveBeenCalledTimes(1);
    const [index, patch] = onBandChange.mock.calls[0];
    expect(index).toBe(2);
    expect(patch.freq_hz).toBe(targetFreq);
    expect('gain_db' in patch).toBe(false);
  });

  it('a drag that ends where it began commits nothing', async () => {
    const bands = fourBands();
    await render(bands);
    const el = pointEl(0);
    const start = point(el);
    // Move away and back to the exact start before releasing.
    await dragPointer(el, [start, { x: start.x + 40, y: start.y - 10 }, start], { moveTarget: window });
    expect(onBandChange).not.toHaveBeenCalled();
  });

  it('Escape cancels an in-flight drag and commits nothing', async () => {
    const bands = fourBands();
    await render(bands);
    const el = pointEl(0);
    const start = point(el);
    firePointerEvent(el, 'pointerdown', start);
    await waitFrames(1);
    firePointerEvent(window, 'pointermove', { x: start.x + 60, y: start.y + 20 });
    await waitFrames(1);
    actSync(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await waitFrames(1);
    // Release after cancelling — must be a no-op; the gesture already ended.
    firePointerEvent(window, 'pointerup', { x: start.x + 60, y: start.y + 20 });
    await waitFrames(1);
    expect(onBandChange).not.toHaveBeenCalled();
  });

  it('a disabled (locked-track) graph ignores a press entirely', async () => {
    const bands = fourBands();
    await render(bands, true);
    const el = pointEl(0);
    const start = point(el);
    await dragPointer(el, linearPath(start, { x: start.x + 60, y: start.y + 20 }, 3), { moveTarget: window });
    expect(onBandChange).not.toHaveBeenCalled();
  });

  it('scrolling over a point adjusts Q, committing once after the gesture settles (not once per tick)', async () => {
    const bands = fourBands();
    await render(bands);
    const el = pointEl(1);
    const startQ = bands[1].q;

    // A real trackpad fires many wheel events per gesture — three here.
    actSync(() => {
      el.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }));
    });
    actSync(() => {
      el.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }));
    });
    actSync(() => {
      el.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }));
    });
    // Not committed yet — still inside the idle debounce window.
    expect(onBandChange).not.toHaveBeenCalled();

    await waitMs(400);

    expect(onBandChange).toHaveBeenCalledTimes(1);
    const [index, patch] = onBandChange.mock.calls[0];
    expect(index).toBe(1);
    // The exact three-notch compounded result the pure `eqQAfterWheel` gives —
    // pinning the component's own accumulation to the same math the unit
    // tests already cover, not a second, looser implementation of it.
    let expectedQ = startQ;
    expectedQ = eqQAfterWheel(expectedQ, -100);
    expectedQ = eqQAfterWheel(expectedQ, -100);
    expectedQ = eqQAfterWheel(expectedQ, -100);
    expect(patch.q).toBe(expectedQ);
  });

  it('a disabled graph ignores wheel input too', async () => {
    const bands = fourBands();
    await render(bands, true);
    const el = pointEl(1);
    actSync(() => {
      el.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }));
    });
    await waitMs(400);
    expect(onBandChange).not.toHaveBeenCalled();
  });

  it('never places a point outside the plotted frequency range', async () => {
    const bands: EqBand[] = [
      { kind: 'peak', freq_hz: EQ_MIN_FREQ_HZ, gain_db: 0, q: 1, enabled: true },
      { kind: 'peak', freq_hz: EQ_MAX_FREQ_HZ, gain_db: 0, q: 1, enabled: true },
    ];
    await render(bands);
    const p0 = point(pointEl(0));
    const p1 = point(pointEl(1));
    expect(p0.x).toBeCloseTo(0, 3);
    expect(p1.x).toBeCloseTo(PLOT_WIDTH, 3);
  });
});

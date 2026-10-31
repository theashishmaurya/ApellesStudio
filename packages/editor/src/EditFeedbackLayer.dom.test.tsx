// @vitest-environment jsdom
/**
 * EditFeedbackLayer on real DOM (B-347 F1) — the readout is positioned from the
 * text length and a glyph advance measured ONCE by `measure()`, so `readout()`
 * (called on every snapped preview, right after the gesture's style writes)
 * never reads a layout property.
 */
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

import { EditFeedbackLayer, type EditFeedbackHandle } from './EditFeedbackLayer';
import { TIMELINE_TEST_IDS } from './timelineTestIds';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const GLYPH_PX = 6;

function mount() {
  const ref = createRef<EditFeedbackHandle>();
  const view = render(<EditFeedbackLayer ref={ref} />);
  const readout = view.getByTestId(TIMELINE_TEST_IDS.editReadout);
  const handle = ref.current;
  if (!handle) throw new Error('EditFeedbackLayer did not expose its handle');
  return { handle, readout };
}

/** Counts every `offsetWidth` read and answers the probe's width (10 glyphs). */
function spyLayoutReads() {
  const reads = vi.fn();
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
    reads();
    return this.hasAttribute('aria-hidden') ? GLYPH_PX * 10 : 0;
  });
  return reads;
}

describe('EditFeedbackLayer readout', () => {
  it('reads layout only in measure(), never in readout()', () => {
    const reads = spyLayoutReads();
    const { handle, readout } = mount();
    handle.measure();
    expect(reads).toHaveBeenCalledTimes(1);
    handle.measure(); // already measured: a no-op
    expect(reads).toHaveBeenCalledTimes(1);

    for (const text of ['+00:00:01 → 00:02:16', '+00:00:02 → 00:02:17', '+12f']) {
      handle.readout({ x: 300, top: 100, text, limit: false, viewportWidth: 1000 });
    }
    expect(reads).toHaveBeenCalledTimes(1);
    expect(readout.textContent).toBe('+12f');
  });

  it('centres on the edge from the measured glyph width and clamps inside the viewport', () => {
    spyLayoutReads();
    const { handle, readout } = mount();
    handle.measure();
    const text = '+12f'; // 4 glyphs -> 4 * 6 + 12 padding = 36 px wide
    handle.readout({ x: 500, top: 100, text, limit: false, viewportWidth: 1000 });
    expect(readout.style.transform).toBe('translate3d(482px, 72px, 0)');
    handle.readout({ x: 2, top: 100, text, limit: false, viewportWidth: 1000 });
    expect(readout.style.transform).toBe('translate3d(0px, 72px, 0)');
    handle.readout({ x: 999, top: 100, text, limit: false, viewportWidth: 1000 });
    expect(readout.style.transform).toBe('translate3d(964px, 72px, 0)');
  });

  it('does not clamp when the glyph advance is unmeasurable (jsdom)', () => {
    const { handle, readout } = mount();
    handle.measure();
    handle.readout({ x: 500, top: 100, text: '+12f', limit: false, viewportWidth: 1000 });
    expect(readout.style.transform).toBe('translate3d(500px, 72px, 0)');
  });
});

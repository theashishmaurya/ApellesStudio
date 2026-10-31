// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { startObserver } from './observe';

describe('startObserver (H8)', () => {
  it('records where the last wheel event landed, separately from the pointer', () => {
    const observer = startObserver(window);
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 10, clientY: 20 }));
    window.dispatchEvent(new WheelEvent('wheel', { clientX: 300, clientY: 140, deltaY: 40 }));
    window.dispatchEvent(new WheelEvent('wheel', { clientX: 310, clientY: 150, deltaY: 40 }));
    const summary = observer.stop();
    expect(summary.lastWheel).toEqual({ x: 310, y: 150 });
    expect(summary.lastPointer).toEqual({ x: 10, y: 20 });
    expect(summary.counts.wheel).toBe(2);
  });

  it('reports no wheel position when there was no wheel', () => {
    const observer = startObserver(window);
    window.dispatchEvent(new MouseEvent('pointerdown', { clientX: 1, clientY: 2 }));
    expect(observer.stop().lastWheel).toBeNull();
  });

  it('records when the last pointerup arrived, on the same clock as the input times (B-347 F6)', () => {
    const observer = startObserver(window);
    window.dispatchEvent(new MouseEvent('pointerdown', { clientX: 1, clientY: 2 }));
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 5, clientY: 2 }));
    window.dispatchEvent(new MouseEvent('pointerup', { clientX: 9, clientY: 2 }));
    const summary = observer.stop();
    expect(summary.releaseAt).not.toBeNull();
    expect(summary.releaseAt).toBe(summary.inputTimes[summary.inputTimes.length - 1]);
  });

  it('has no release time when no pointerup came', () => {
    const observer = startObserver(window);
    window.dispatchEvent(new MouseEvent('pointerdown', { clientX: 1, clientY: 2 }));
    expect(observer.stop().releaseAt).toBeNull();
  });
});

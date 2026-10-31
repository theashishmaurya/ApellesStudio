// @vitest-environment jsdom
/**
 * D-437 S7 (plan §2.9 item 5) — the clip waveform is requested once and drawn
 * once per zoom bucket, not once per width change.
 *
 * Before S7 `Waveform` asked for `round(width / 2)` buckets and redrew its canvas
 * (assigning `canvas.width`, which clears it) on every width change, so one trim
 * of a few pixels re-requested the peaks over IPC and blanked the band until they
 * landed. The counts below are what a 20-step trim sweep inside one bucket costs.
 *
 * jsdom has no rasteriser: the 2D context is a counter (draws = `clearRect`s,
 * one per drawing pass), `invoke` a counter (peaks requests). What this proves
 * is the number of passes the component asks for, not pixels.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import { actSync, mount, waitFrames, type MountedComponent } from './testUtils/pointerHarness';
import { BUCKET_PX, Waveform, waveformBuckets } from './Waveform';

let draws = 0;
let widthAssignments = 0;
let mounted: MountedComponent | null = null;
let originalGetContext: typeof HTMLCanvasElement.prototype.getContext;
let sourceCounter = 0;
const originalWidth = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width')!;

beforeEach(() => {
  draws = 0;
  widthAssignments = 0;
  invoke.mockReset();
  invoke.mockImplementation(async (_cmd: string, args: { buckets: number }) =>
    Array.from({ length: args.buckets }, (_, i) => [-((i % 7) + 1) / 8, ((i % 5) + 1) / 6]),
  );
  originalGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string) {
    if (kind !== '2d') return null;
    return {
      setTransform: () => {},
      clearRect: () => {
        draws += 1;
      },
      fillRect: () => {},
      fillStyle: '',
      globalAlpha: 1,
    } as unknown as CanvasRenderingContext2D;
  } as typeof HTMLCanvasElement.prototype.getContext;
  // Count the bitmap-clearing size assignments.
  Object.defineProperty(HTMLCanvasElement.prototype, 'width', {
    configurable: true,
    get: originalWidth.get,
    set(this: HTMLCanvasElement, v: number) {
      widthAssignments += 1;
      originalWidth.set!.call(this, v);
    },
  });
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  HTMLCanvasElement.prototype.getContext = originalGetContext;
  Object.defineProperty(HTMLCanvasElement.prototype, 'width', originalWidth);
});

/** A fresh source per test: the peak cache is module-level. */
function props(width: number) {
  return { sourcePath: `/clip-${sourceCounter}.wav`, startSecs: 0, durationSecs: 10, width, height: 20, variant: 'band' as const };
}

function mountWith(initialWidth: number) {
  sourceCounter += 1;
  const host: { set: (w: number) => void } = { set: () => {} };
  function Host() {
    const [w, setW] = React.useState(initialWidth);
    host.set = setW;
    return <Waveform {...props(w)} />;
  }
  mounted = mount(<Host />, { strictMode: false });
  return { setWidth: (w: number) => actSync(() => host.set(w)) };
}

describe('waveformBuckets', () => {
  it('quantises to a power of two, one bucket per BUCKET_PX at the bucket centre', () => {
    expect(BUCKET_PX).toBe(2);
    expect(waveformBuckets(0)).toBe(1);
    expect(waveformBuckets(400)).toBe(256); // 200 wanted -> 256
    expect(waveformBuckets(440)).toBe(256);
    expect(waveformBuckets(300)).toBe(128); // 150 -> 128
    expect(waveformBuckets(1_000_000)).toBe(512);
  });

  it('is constant across a trim-sized width change inside a bucket', () => {
    const seen = new Set<number>();
    for (let w = 380; w <= 460; w += 4) seen.add(waveformBuckets(w));
    expect(seen.size).toBe(1);
  });
});

describe('Waveform draws once per zoom bucket (D-437 S7)', () => {
  it('requests peaks once and draws once for a 20-step width sweep inside a bucket', async () => {
    const ui = mountWith(400);
    await waitFrames(3);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(draws).toBe(1);
    const baseWidthAssignments = widthAssignments;
    for (let i = 1; i <= 20; i++) ui.setWidth(400 + i * 2);
    await waitFrames(3);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(draws).toBe(1);
    expect(widthAssignments).toBe(baseWidthAssignments);
    // The bitmap is scaled by CSS to the clip's width, not redrawn.
    expect(mounted!.container.querySelector('canvas')!.style.width).toBe('440px');
  });

  it('redraws and re-requests when the zoom crosses a bucket', async () => {
    const ui = mountWith(400);
    await waitFrames(3);
    ui.setWidth(900);
    await waitFrames(3);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(draws).toBe(2);
  });

  it('keeps the old picture while the new peaks are in flight', async () => {
    const ui = mountWith(400);
    await waitFrames(3);
    expect(mounted!.container.querySelector('canvas')).not.toBeNull();
    let release: (p: number[][]) => void = () => {};
    invoke.mockImplementationOnce(() => new Promise((r) => (release = r)));
    ui.setWidth(900);
    await waitFrames(2);
    expect(mounted!.container.querySelector('canvas')).not.toBeNull(); // not blanked
    release([[-0.5, 0.5]]);
    await waitFrames(3);
    expect(mounted!.container.querySelector('canvas')).not.toBeNull();
  });
});

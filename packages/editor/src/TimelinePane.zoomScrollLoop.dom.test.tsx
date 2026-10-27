// @vitest-environment jsdom
/**
 * @apelles/editor — B-291: zooming the timeline must never lock the library's
 * scroll state into an update loop ("Maximum update depth exceeded", which
 * blanked the whole window live on 2026-10-28 while the owner pinch-zoomed a
 * 64-clip timeline).
 *
 * **The defect.** `@xzdarcy/react-timeline-editor` keeps the horizontal
 * scroll in two places that echo each other inside React's commit phase: its
 * `ScrollSync` state, and the edit-area `Grid`. The grid reports its position
 * up from `componentDidUpdate`; the edit area pushes `ScrollSync`'s value down
 * into the grid from a `useLayoutEffect`. If one render changes the two to
 * different values, each commit swaps them and the loop never ends.
 * `TimelinePane`'s zoom anchor wrote the library scroll from a PASSIVE
 * effect, and that leaves a gap a second zoom can land in: the write is issued
 * but not yet rendered, so the next zoom anchors on a `scrollLeft` that has not
 * caught up and issues a second, different write — which React flushes after
 * the edit area has pushed the first value down and before the grid has
 * reported it. Captured live in WebKit (Playwright, the D-142 harness, the
 * owner's real timeline): 9 of 15 pinch runs hit it before the fix, 0 of 15
 * after.
 *
 * **How this test reproduces it without a browser's frame scheduling.** jsdom
 * has no frames, so React never separates a passive effect from the render
 * that applies it the way a busy WebKit frame does. The test therefore places
 * the second zoom input exactly where a real one can arrive: if the pane's
 * write to the library is issued from a passive effect, a real input can land
 * between it and its render, so the second zoom is dispatched right there; if
 * the write is issued inside the commit (where no input can interleave), the
 * second zoom is dispatched at the next task. The second zoom is the toolbar's
 * zoom-in button: its handler uses the closure of the render on screen — the
 * same stale `scrollLeft` the live trace showed.
 *
 * Compiled with the app's React Compiler preset (`vitest.config.ts`), like
 * every `.tsx` in this package's tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';

import {
  createInvokeStub,
  installPointerCaptureStub,
  installResizeObserverStub,
  stubOffsetMetrics,
} from './testUtils/pointerHarness';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: createInvokeStub({
    chroma_clip_thumbnails: () => [],
    chroma_audio_waveform: () => [],
    chroma_timeline_set: () => undefined,
  }),
}));

import { useEditorTimelineStore } from './timelineStore';
import { TimelinePane } from './TimelinePane';
import type { Clip, Timeline } from './timeline';

const FPS = 24;
const PAIRS = 64;
const CLIP_FRAMES = 140;
const AREA = { left: 0, top: 0, width: 1200, height: 600 };
/** Long enough for React's scheduler tasks and the library's follow-up
 *  renders to drain between steps. */
const SETTLE_MS = 150;

/** The owner's shape: a recut of one long source into linked V/A pairs. */
function fixture(): Timeline {
  const clips = (kind: 'video' | 'audio'): Clip[] =>
    Array.from({ length: PAIRS }, (_, i) => ({
      id: `${kind}-${i}`,
      name: 'Zain001.MOV',
      source_path: '/Users/someone/Zain001.MOV',
      source_start: i * 200,
      duration: CLIP_FRAMES,
      source_len: PAIRS * 200,
      source_fps: FPS,
      start_frame: i * CLIP_FRAMES,
    }) as Clip);
  return {
    id: 'b291',
    name: 'b291',
    rate: { num: FPS, den: 1 },
    tracks: [
      { kind: 'video', clips: clips('video') },
      { kind: 'audio', clips: clips('audio') },
    ],
    markers: [],
  } as unknown as Timeline;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function ctrlWheel(area: HTMLElement, clientX: number): void {
  // Negative `deltaY` with ctrl held is a zoom-in step (the pinch gesture).
  const e = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -4, clientX, clientY: 100 });
  Object.defineProperty(e, 'ctrlKey', { value: true });
  area.dispatchEvent(e);
}

/** True when the current call stack is inside React's passive-effect flush
 *  (react-dom's development build names these frames). */
function inPassiveFlush(): boolean {
  const stack = new Error().stack ?? '';
  return /commitPassiveMountOnFiber|flushPassiveEffects/.test(stack);
}

let root: Root | null = null;
let restores: Array<() => void> = [];
const originalSetState = React.PureComponent.prototype.setState;

beforeEach(() => {
  // A real scheduler, not `act`: the defect is about WHEN React runs work.
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  restores = [stubOffsetMetrics(AREA.width, AREA.height), installResizeObserverStub(), installPointerCaptureStub()];
});

afterEach(() => {
  React.PureComponent.prototype.setState = originalSetState;
  root?.unmount();
  root = null;
  restores.forEach((restore) => restore());
  useEditorTimelineStore.setState({ timeline: null, openProjectKey: null, status: 'idle', selection: [], selectedGap: null });
});

describe('B-291 — a zoom that lands while the previous zoom is still scrolling the library does not loop', () => {
  it('keeps the library scroll state convergent across back-to-back zooms', async () => {
    useEditorTimelineStore.setState({
      timeline: fixture(),
      openProjectKey: '/projects/b291.chroma',
      status: 'ready',
      error: null,
      playhead: 0,
      playing: false,
      selection: [],
      selectedGap: null,
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const uncaught: string[] = [];
    root = createRoot(container, { onUncaughtError: (error) => uncaught.push(String(error)) });
    root.render(<TimelinePane />);
    await wait(SETTLE_MS * 2);

    const area = document.querySelector<HTMLElement>('[data-bench-id="timeline-edit-area"]');
    const zoomIn = document.querySelector<HTMLElement>('[aria-label="Zoom in"]');
    expect(area, 'the edit area mounted').not.toBeNull();
    expect(zoomIn, 'the toolbar has a zoom-in button').not.toBeNull();
    area!.getBoundingClientRect = () =>
      ({ ...AREA, x: 0, y: 0, right: AREA.width, bottom: AREA.height, toJSON: () => ({}) }) as DOMRect;

    // Watch the pane's imperative scroll writes into the library: the
    // library's `TimelineState.setScrollLeft` is the only caller of a
    // `ScrollSync` `setState` whose update carries `scrollLeft` alone.
    let armed = false;
    let secondZooms = 0;
    const clickZoomIn = () => {
      secondZooms += 1;
      zoomIn!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    };
    React.PureComponent.prototype.setState = function patched(
      this: React.PureComponent,
      update: Parameters<typeof originalSetState>[0],
      callback?: () => void,
    ) {
      const isImperativeScroll =
        update !== null && typeof update === 'object' && Object.keys(update).join() === 'scrollLeft';
      if (armed && isImperativeScroll) {
        armed = false;
        if (inPassiveFlush()) clickZoomIn();
        else setTimeout(clickZoomIn, 0);
      }
      return originalSetState.call(this, update, callback);
    };

    // Two plain zoom steps first, so there is room to scroll.
    for (let i = 0; i < 2; i++) {
      ctrlWheel(area!, 900);
      await wait(SETTLE_MS);
    }
    for (let round = 0; round < 4 && uncaught.length === 0; round++) {
      armed = true;
      ctrlWheel(area!, 900);
      await wait(SETTLE_MS);
    }

    expect(uncaught, 'no "Maximum update depth exceeded"').toEqual([]);
    expect(secondZooms, 'every round really issued a second zoom').toBe(4);
  }, 30_000);
});

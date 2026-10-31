// @vitest-environment jsdom
/**
 * @apelles/editor — a zoom writes the lanes' scroll position ONCE, inside the
 * zoom's own commit (B-116 anchor, B-291, D-437 S4).
 *
 * **History.** B-291: `@xzdarcy/react-timeline-editor` kept the horizontal
 * scroll in two places that echoed each other inside React's commit phase (its
 * `ScrollSync` state and its edit-area `Grid`); a zoom-anchor write issued from
 * a PASSIVE effect let a second pinch land between the write and its render,
 * and the two copies swapped forever ("Maximum update depth exceeded", the
 * whole window blank, live on 2026-10-28). The fix moved the write into a
 * layout effect, and this suite reproduced the loop by dispatching the second
 * zoom exactly where a real one could arrive.
 *
 * **Now (D-437 S4).** The pane renders its own lanes: one native scroller, the
 * single source of the scroll position, so there is no second copy and the
 * loop cannot exist. What still matters is the B-116 half: the anchor write
 * must land in the zoom's commit (a layout effect, before paint and before any
 * input can interleave), exactly once per zoom step, after the lanes have laid
 * their content out at the NEW width (or the browser would clamp the write
 * against the old one and lose the anchor on a zoom-in). This suite pins that,
 * and keeps the owner's back-to-back pinch shape (64 linked pairs, a wheel
 * zoom followed at once by a toolbar zoom) to show it stays convergent.
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
import { useTimelineViewStore } from './timelineView';
import type { Clip, Timeline } from './timeline';
import { TIMELINE_TEST_IDS } from './timelineTestIds';

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

beforeEach(() => {
  // D-434 — the zoom is a store now, so it outlives a mounted pane: start each test at the default.
  useTimelineViewStore.setState(useTimelineViewStore.getInitialState());
  // A real scheduler, not `act`: the defect is about WHEN React runs work.
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  restores = [stubOffsetMetrics(AREA.width, AREA.height), installResizeObserverStub(), installPointerCaptureStub()];
});

afterEach(() => {
  root?.unmount();
  root = null;
  restores.forEach((restore) => restore());
  useEditorTimelineStore.setState({ timeline: null, openProjectKey: null, status: 'idle', selection: [], selectedGap: null });
});

describe('B-116 / B-291 / D-437 S4 — a zoom writes scrollLeft once, in its own commit', () => {
  it('one write per zoom step, never from a passive effect, against the new content width', async () => {
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

    const area = document.querySelector<HTMLElement>(`[data-testid="${TIMELINE_TEST_IDS.editArea}"]`);
    const scroller = document.querySelector<HTMLElement>(`[data-testid="${TIMELINE_TEST_IDS.scroller}"]`);
    const zoomIn = document.querySelector<HTMLElement>('[aria-label="Zoom in"]');
    expect(area, 'the edit area mounted').not.toBeNull();
    expect(scroller, 'the lanes\' scroller mounted').not.toBeNull();
    expect(zoomIn, 'the toolbar has a zoom-in button').not.toBeNull();
    area!.getBoundingClientRect = () =>
      ({ ...AREA, x: 0, y: 0, right: AREA.width, bottom: AREA.height, toJSON: () => ({}) }) as DOMRect;
    const content = scroller!.firstElementChild as HTMLElement;

    // Record every write to the scroller's `scrollLeft`: from where, and how wide
    // the content was at that moment.
    let value = 0;
    const writes: { passive: boolean; contentWidth: string; pxPerSec: number }[] = [];
    Object.defineProperty(scroller!, 'scrollLeft', {
      configurable: true,
      get: () => value,
      set: (v: number) => {
        value = v;
        writes.push({ passive: inPassiveFlush(), contentWidth: content.style.width, pxPerSec: useTimelineViewStore.getState().pxPerSec });
      },
    });

    // Every real zoom change (two inputs in one task can collapse into one: the
    // second handler still sees the render on screen, the stale closure B-291's
    // live trace showed, and asks for the same zoom).
    let zoomChanges = 0;
    const unsubscribe = useTimelineViewStore.subscribe((st, prev) => {
      if (st.pxPerSec !== prev.pxPerSec) zoomChanges += 1;
    });
    const steps: { before: string; pxPerSec: number }[] = [];
    const zoomStep = async (how: 'wheel' | 'button') => {
      const before = content.style.width;
      if (how === 'wheel') ctrlWheel(area!, 900);
      else zoomIn!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await wait(SETTLE_MS);
      steps.push({ before, pxPerSec: useTimelineViewStore.getState().pxPerSec });
    };
    for (let i = 0; i < 2; i++) await zoomStep('wheel');
    // The owner's pinch: back-to-back steps, a wheel then a button at once.
    for (let round = 0; round < 4; round++) {
      ctrlWheel(area!, 900);
      await zoomStep('button');
    }

    unsubscribe();
    expect(uncaught, 'no "Maximum update depth exceeded"').toEqual([]);
    expect(zoomChanges, 'the zoom really changed every step').toBeGreaterThanOrEqual(6);
    expect(writes.length, 'exactly one scroll write per zoom change').toBe(zoomChanges);
    for (const w of writes) {
      expect(w.passive, 'the anchor write is never issued from a passive effect').toBe(false);
    }
    // Each write saw a content width that had already changed for its own zoom
    // (zooming in only ever widens the content).
    const widths = writes.map((w) => Number.parseFloat(w.contentWidth));
    for (let i = 1; i < widths.length; i++) expect(widths[i]).toBeGreaterThan(widths[i - 1]);
    expect(widths[0]).toBeGreaterThan(Number.parseFloat(steps[0].before));
    expect(value, 'the anchor kept the view scrolled into the content').toBeGreaterThan(0);
  }, 30_000);
});

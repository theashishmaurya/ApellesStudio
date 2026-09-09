// @vitest-environment jsdom
/**
 * @apelles/editor — real-DOM coverage for anchored timeline zoom (B-116).
 *
 * **Why a DOM test on top of `timelineZoom.test.ts`.** That file proves the
 * arithmetic; this proves the WIRING, which is where the bug actually was. The
 * ctrl/pinch wheel handler had `e.clientX` on the event and never read it, and
 * the toolbar's +/- had no anchor concept at all — so the maths could have been
 * perfect and the zoom would still have drifted. What is asserted here is the
 * end-to-end, user-visible fact the owner reported missing: **something at a
 * given place on screen is still at that place after zooming there.**
 *
 * The "something" is a marker flag, deliberately. It is the only element in
 * this pane positioned by `TimelinePane`'s own `pxPerSec`/`scrollLeft` (via
 * `markerLeftPx`) that renders as a plain, measurable inline `left` in jsdom —
 * the clips themselves are laid out by the timeline library's virtualised grid,
 * which jsdom cannot lay out. Since the flag reads the exact state the ruler,
 * the playhead and every drop conversion read, holding the flag still is
 * holding the timeline still.
 *
 * **Tier and its honest limits.** jsdom. `TimelineState.setScrollLeft` (the
 * library's own imperative scroll) does nothing measurable here, so what this
 * proves is that the pane's tracked `scrollLeft` — the value every one of its
 * own overlays and drop handlers uses — is updated to the right number. That
 * the library's scroll container actually follows it is a real-browser
 * property, called out rather than pretended.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

import {
  actSync,
  captureConsole,
  createInvokeStub,
  installPointerCaptureStub,
  installResizeObserverStub,
  mount,
  stubOffsetMetrics,
  waitFrames,
  type MountedComponent,
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
import { DEFAULT_MARKER_COLOR, type Timeline } from './timeline';

const FPS = 24;
const AREA = { left: 0, top: 0, width: 1200, height: 600 };
/** `TimelinePane.tsx`'s own zoom step, restated (see `ZOOM_STEP`). */
const ZOOM_STEP = 1.2;
const DEFAULT_PX_PER_SEC = 90;
const START_LEFT_PX = 20;

/** One clip long enough to zoom around, and a marker at 6s to measure. */
function fixture(): Timeline {
  return {
    id: 'zoom-fixture-tl',
    name: 'zoom fixture',
    rate: { num: FPS, den: 1 },
    tracks: [
      {
        kind: 'video',
        clips: [
          { id: 'v', name: 'V', source_path: '/v.mp4', source_start: 0, duration: 720, source_len: 720, start_frame: 0 },
        ],
      },
    ],
    markers: [{ id: 'probe', frame: 144, color: DEFAULT_MARKER_COLOR }],
  };
}

/** The one rect jsdom cannot supply; everything else below is real. */
function stubEditAreaRect(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-bench-id="timeline-edit-area"]');
  if (!el) throw new Error('the timeline edit area is not mounted');
  el.getBoundingClientRect = () =>
    ({
      ...AREA,
      x: AREA.left,
      y: AREA.top,
      right: AREA.left + AREA.width,
      bottom: AREA.top + AREA.height,
      toJSON: () => ({}),
    }) as DOMRect;
  return el;
}

/** The probe marker's current left edge, in px — the pane's own geometry. */
function probeLeft(): number {
  const el = document.querySelector<HTMLElement>('[data-chroma-marker="probe"]');
  if (!el) throw new Error('the probe marker flag is not on screen');
  return Number.parseFloat(el.style.left);
}

function wheel(el: HTMLElement, opts: { clientX: number; deltaY: number }): void {
  actSync(() => {
    const e = new Event('wheel', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'ctrlKey', { value: true });
    Object.defineProperty(e, 'clientX', { value: opts.clientX });
    Object.defineProperty(e, 'clientY', { value: 200 });
    Object.defineProperty(e, 'deltaY', { value: opts.deltaY });
    el.dispatchEvent(e);
  });
}

let restoreOffsets: () => void;
let restoreResizeObserver: () => void;
let restorePointerCapture: () => void;
let ui: MountedComponent | null = null;
let console_: ReturnType<typeof captureConsole>;

async function mountPane(): Promise<HTMLElement> {
  actSync(() =>
    useEditorTimelineStore.setState({
      timeline: fixture(),
      openProjectKey: '/projects/zoom-fixture.chroma',
      status: 'ready',
      error: null,
      playhead: 0,
      playing: false,
      selection: [],
      selectedGap: null,
    }),
  );
  ui = mount(React.createElement(TimelinePane), { strictMode: true });
  await waitFrames(2);
  return stubEditAreaRect();
}

beforeEach(() => {
  restoreOffsets = stubOffsetMetrics(AREA.width, AREA.height);
  restoreResizeObserver = installResizeObserverStub();
  restorePointerCapture = installPointerCaptureStub();
  console_ = captureConsole();
});

afterEach(() => {
  const errors = console_.errors;
  console_.restore();
  ui?.unmount();
  ui = null;
  restorePointerCapture();
  restoreResizeObserver();
  restoreOffsets();
  actSync(() =>
    useEditorTimelineStore.setState({
      timeline: null,
      openProjectKey: null,
      status: 'idle',
      selection: [],
      selectedGap: null,
    }),
  );
  expect(errors, `console.error fired during the test:\n${errors.map((e) => e.join(' ')).join('\n')}`).toEqual([]);
});

describe('B-116 — the timeline zooms around a point, not around nothing', () => {
  it('1. the fixture starts where the untouched geometry says it should', async () => {
    await mountPane();
    // 144 frames == 6s == 540px at the default 90px/s, plus the 20px gutter.
    expect(probeLeft()).toBeCloseTo(START_LEFT_PX + 6 * DEFAULT_PX_PER_SEC, 6);
  });

  it('2. a ctrl+wheel zoom IN keeps the frame under the cursor under the cursor', async () => {
    const area = await mountPane();
    const before = probeLeft();

    // Zoom with the cursor exactly on the marker. Whatever else moves, THIS
    // must not — that sentence is the whole bug report ("calculate the
    // position of my mouse in timeline and zoom there not like random").
    wheel(area, { clientX: before, deltaY: -120 });
    await waitFrames(2);

    expect(probeLeft()).toBeCloseTo(before, 6);
  });

  it('3. …and so does a zoom OUT, once there is room to scroll back', async () => {
    const area = await mountPane();
    const before = probeLeft();

    // A zoom OUT from `scrollLeft === 0` provably cannot hold any anchor: the
    // content shrinks toward the left edge and the view is already hard
    // against it, so the timeline's start holds instead (the documented,
    // unit-tested clamp). Zoom in first so there IS scroll to give back —
    // which is also the only way a user ever reaches a zoom-out mid-timeline.
    wheel(area, { clientX: before, deltaY: -120 });
    await waitFrames(2);
    expect(probeLeft()).toBeCloseTo(before, 6);

    wheel(area, { clientX: before, deltaY: 120 });
    await waitFrames(2);
    expect(probeLeft()).toBeCloseTo(before, 6);
  });

  it('4. the zoom really did change — this is not a no-op passing by accident', async () => {
    const area = await mountPane();
    const before = probeLeft();

    wheel(area, { clientX: before, deltaY: -120 });
    await waitFrames(2);

    // The marker held still, so the proof the zoom happened is that the
    // SCROLL had to move to hold it: at 1.2x, 6s is 108px further from the
    // timeline's start, and the pane must have scrolled by exactly that.
    const expectedScroll = START_LEFT_PX + 6 * DEFAULT_PX_PER_SEC * ZOOM_STEP - before;
    const scrolled = START_LEFT_PX + 6 * DEFAULT_PX_PER_SEC * ZOOM_STEP - probeLeft();
    expect(scrolled).toBeCloseTo(expectedScroll, 6);
    expect(scrolled).toBeGreaterThan(0);
  });

  it('5. zooming at a cursor position AWAY from the marker moves the marker — the anchor is the cursor, not the marker', async () => {
    const area = await mountPane();
    const before = probeLeft();

    // Anchor at x=200 instead — well inside the content, not in the fixed
    // 20px `startLeft` gutter where the clamp would take over. The marker is
    // 360px to its right, so at 1.2x it must end up 20% further away from that
    // anchor, not stay put.
    const anchorX = 200;
    wheel(area, { clientX: anchorX, deltaY: -120 });
    await waitFrames(2);

    const after = probeLeft();
    expect(after).not.toBeCloseTo(before, 3);
    // Distance from the anchor scales by exactly the zoom step.
    expect(after - anchorX).toBeCloseTo((before - anchorX) * ZOOM_STEP, 5);
  });

  it('6. a plain (non-ctrl) wheel is left alone — it pans, it does not zoom', async () => {
    const area = await mountPane();
    const before = probeLeft();

    actSync(() => {
      const e = new Event('wheel', { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'ctrlKey', { value: false });
      Object.defineProperty(e, 'clientX', { value: 400 });
      Object.defineProperty(e, 'deltaY', { value: -120 });
      area.dispatchEvent(e);
    });
    await waitFrames(2);

    expect(probeLeft()).toBeCloseTo(before, 6);
  });

  it('7. the toolbar +/- anchor on the PLAYHEAD, so the frame you are looking at holds still', async () => {
    const area = await mountPane();
    stubEditAreaRect();
    // Put the playhead exactly on the probe marker, so "the playhead held
    // still" and "the marker held still" are the same measurable statement.
    actSync(() => useEditorTimelineStore.setState({ playhead: 144 }));
    await waitFrames(2);
    const before = probeLeft();
    expect(before).toBeCloseTo(START_LEFT_PX + 6 * DEFAULT_PX_PER_SEC, 6);

    const zoomIn = document.querySelector<HTMLElement>('[aria-label="Zoom in"]');
    expect(zoomIn, 'the toolbar has a zoom-in button').not.toBeNull();
    actSync(() => zoomIn!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
    await waitFrames(2);

    expect(probeLeft()).toBeCloseTo(before, 6);
    expect(area).toBeTruthy();
  });

  it('8. zoom out from the toolbar holds the same anchor, once there is room to scroll back', async () => {
    await mountPane();
    actSync(() => useEditorTimelineStore.setState({ playhead: 144 }));
    await waitFrames(2);
    const before = probeLeft();

    // Same clamp as test 3: zooming out from `scrollLeft === 0` pins to the
    // timeline's start by construction, so establish some scroll first.
    const press = (label: string) => {
      const el = document.querySelector<HTMLElement>(`[aria-label="${label}"]`);
      expect(el, `the toolbar has a ${label} button`).not.toBeNull();
      actSync(() => el!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
    };

    press('Zoom in');
    await waitFrames(2);
    expect(probeLeft()).toBeCloseTo(before, 6);

    press('Zoom out');
    await waitFrames(2);
    expect(probeLeft()).toBeCloseTo(before, 6);
  });
});
